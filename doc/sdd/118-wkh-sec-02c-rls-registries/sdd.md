# SDD #118: [WKH-SEC-02c] RLS Postgres-level en `registries` y `kite_schema_transforms`

> SPEC_APPROVED: no
> Fecha: 2026-06-22
> Tipo: security (improvement / DDL hardening)
> SDD_MODE: mini
> Branch: feat/118-wkh-sec-02c-rls-registries
> Artefactos: doc/sdd/118-wkh-sec-02c-rls-registries/

---

## 1. Resumen

Extender la defensa RLS de **WKH-SEC-02** (7 tablas) a las **2 tablas con
`owner_ref` que quedaron fuera** de ese scope: `registries` y
`kite_schema_transforms`. Se habilita `ENABLE ROW LEVEL SECURITY` (sin `FORCE`,
sin policy) en ambas. Resultado: deny-by-default para `anon`/`authenticated`,
mientras el único role que usa el servicio (`service_role`, vía
`SUPABASE_SERVICE_KEY` en `src/lib/supabase.ts`) bypassa nativamente por su
atributo `BYPASSRLS`. **Cero cambio de comportamiento en producción** y **cero
código de producción**: el patrón es 1:1 con SEC-02, ya auditado y en prod.

Spinoff explícito de `doc/sdd/116-wkh-sec-02-rls/report.md` §6 y §8.

---

## 2. Work Item

`doc/sdd/118-wkh-sec-02c-rls-registries/work-item.md` — 6 ACs (AC-1..6),
4 DT (DT-1..4), 4 CD (CD-1..4), 0 NEEDS CLARIFICATION. HU_APPROVED dado.

Resumen de ACs:
- **AC-1**: tras el up, `relrowsecurity=true` en `pg_class` para `registries` y `kite_schema_transforms`.
- **AC-2**: deny-default (ENABLE sin policy) para `anon`/`authenticated` en ambas tablas.
- **AC-3**: down → `DISABLE ROW LEVEL SECURITY` en ambas, estado idéntico al previo.
- **AC-4**: `service_role` (BYPASSRLS) opera sin error ni cambio observable (cero regresión).
- **AC-5**: `verify-rls-enabled.mjs` reporta `relrowsecurity=true` para las 2 nuevas (total 9).
- **AC-6**: idempotencia — re-aplicar el up no produce error (ENABLE es idempotente).

---

## 3. Context Map (Codebase Grounding)

| Archivo leído | Por qué | Patrón extraído |
|---------------|---------|-----------------|
| `supabase/migrations/20260607000000_wkh_sec02_rls.sql` | Exemplar literal del up | `BEGIN;` + `ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;` (1 por tabla, alineado) + `COMMIT;`. Sin FORCE, sin policy. Comentario de cabecera explica deny-default + BYPASSRLS + idempotencia. |
| `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` | Exemplar literal del down | `BEGIN;` + `ALTER TABLE public.<t> DISABLE ROW LEVEL SECURITY;` + `COMMIT;`. Comentario "NOTA OPS (DT-6)": el down NO pasa por `migrate:preflight`. |
| `scripts/verify-rls-enabled.mjs` | Script a extender (7→9) | `RLS_TABLES` (array canónico, exportado) alimenta `buildRlsQuery()` (SELECT sobre `pg_class.relrowsecurity`) y `evaluateRlsRows()` (función pura: `missing`/`disabled`/`unexpected`). Mensajes de log usan `RLS_TABLES.length`. |
| `test/verify-rls-enabled.test.ts` | Test a actualizar (7→9) | Tests sobre `evaluateRlsRows`, `buildRlsQuery` y estructura del `.sql` (`countDdlStatements` regex no-frágil). Asume `TABLES.toHaveLength(7)` hardcodeado en 2 lugares; un test (línea 54-58) trata `registries` como **unexpected** — debe invertirse. |
| `src/lib/supabase.ts` | Confirmar single client service_role | `createClient(url, process.env.SUPABASE_SERVICE_KEY)` — un solo singleton, sin cliente anon. (AC-4 fundamento) |
| `src/services/registry.ts` | Confirmar acceso 100% service_role a `registries` | 6 `.from('registries')` (L119,133,191,285,343,362), todos sobre el singleton service_role. |
| `src/services/llm/transform.ts` | Confirmar acceso 100% service_role a `kite_schema_transforms` | `import { supabase }` (L19) + `.from('kite_schema_transforms')` (L207,242,273) sobre el mismo singleton. |
| `supabase/migrations/20260427210000_registries_owner_ref.sql` | Confirmar `registries.owner_ref` existe | `ADD COLUMN IF NOT EXISTS owner_ref TEXT NOT NULL DEFAULT 'system'`. |
| `supabase/migrations/20260427230000_kite_schema_transforms_owner.sql` | Confirmar `kite_schema_transforms.owner_ref` existe | `ADD COLUMN IF NOT EXISTS owner_ref TEXT` (nullable, legacy rows = NULL). |
| `doc/sdd/116-wkh-sec-02-rls/sdd.md` | Precedente de formato/decisiones | Estructura SDD, DT-1/DT-4 (sin policy / sin FORCE), DT-6 (down no preflight), Test Plan, Plan de Deploy, Readiness Check. |
| `doc/sdd/116-wkh-sec-02-rls/auto-blindaje.md` | Lección histórica directa | El conteo de sentencias DDL en el test debe usar regex de **sentencia completa** (`countDdlStatements`), no substring crudo (que cuenta menciones en comentarios). Ya implementado en el test actual. |

**Hallazgos verificados (F2):**
- Última migración del repo: `20260609000000_wkh_sec02b_owner_ref_rpc.sql`. **Timestamp `20260610000000` libre** (sin colisión) → cumple DT-2.
- `registries.owner_ref`: `TEXT NOT NULL DEFAULT 'system'`. `kite_schema_transforms.owner_ref`: `TEXT` nullable. Ambas existen → no se agrega columna (Scope OUT).
- Único cliente Supabase = `service_role` → AC-4 se cumple por construcción.
- `test/verify-rls-enabled.test.ts` línea 54-58 hoy afirma `registries` como `unexpected`; al entrar `registries` al set canónico, esa aserción debe reescribirse (usar una tabla que SIGA fuera del set, p.ej. `a2a_tasks`).

---

## 4. Diseño Técnico

### 4.1 Archivos a tocar (Scope IN)

| # | Archivo | Acción | Exemplar verificado |
|---|---------|--------|---------------------|
| 1 | `supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql` | CREATE — up: `ENABLE ROW LEVEL SECURITY` x2 (`registries`, `kite_schema_transforms`), `BEGIN/COMMIT`, sin FORCE, sin policy | `supabase/migrations/20260607000000_wkh_sec02_rls.sql` |
| 2 | `supabase/migrations/20260610000000_wkh_sec02c_rls_registries_down.sql` | CREATE — down: `DISABLE ROW LEVEL SECURITY` x2 | `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` |
| 3 | `scripts/verify-rls-enabled.mjs` | EDIT — agregar `registries` y `kite_schema_transforms` a `RLS_TABLES` (7→9). Sin otro cambio: query y evaluación se derivan del array | (el propio archivo, patrón existente) |
| 4 | `test/verify-rls-enabled.test.ts` | EDIT — actualizar a 9 tablas: `UP_PATH`/`DOWN_PATH` apuntan al nuevo `.sql`; conteos 7→9; reescribir el test "unexpected" para usar una tabla aún fuera del set | (el propio archivo) |

> **Scope OUT explícito** (del work-item): NO tocar `src/services/registry.ts` ni
> `src/services/llm/transform.ts` (ya 100% service_role); NO `CREATE POLICY`; NO
> `FORCE`; NO agregar `owner_ref` (ya existe); NO WKH-SEC-02b (HU separada, #119);
> NO tablas sin `owner_ref` (`a2a_tasks`, `a2a_events`, cache).

### 4.2 Contenido del up (W0.1)

`BEGIN;` →
`ALTER TABLE public.registries ENABLE ROW LEVEL SECURITY;` →
`ALTER TABLE public.kite_schema_transforms ENABLE ROW LEVEL SECURITY;` →
`COMMIT;`. Comentario de cabecera idéntico en espíritu al de SEC-02 (deny-default
+ BYPASSRLS + idempotencia, referenciando WKH-SEC-02c y DT-1/DT-2/DT-4).

### 4.3 Contenido del down (W0.2)

`BEGIN;` →
`ALTER TABLE public.registries DISABLE ROW LEVEL SECURITY;` →
`ALTER TABLE public.kite_schema_transforms DISABLE ROW LEVEL SECURITY;` →
`COMMIT;`. Comentario "NOTA OPS": el down NO pasa por `migrate:preflight`
(`DISABLE` se marca HIGH por el analizador, es deliberado aquí — heredado de
DT-6 de SEC-02).

### 4.4 Cambio en `verify-rls-enabled.mjs` (W1.1)

Único cambio funcional: extender el array `RLS_TABLES` (líneas 21-29) de 7 a 9
entradas, agregando `'registries'` y `'kite_schema_transforms'`. `buildRlsQuery()`,
`evaluateRlsRows()` y los mensajes de log ya usan `RLS_TABLES`/`.length`, por lo
que se propagan solos. (Opcional: actualizar el comentario de cabecera "7 tablas"
→ "9 tablas".)

### 4.5 Happy path / flujo de error

- **Up aplicado** → `relrowsecurity=true` en ambas tablas (AC-1) → verify reporta 9/9 (AC-5) → service_role opera idéntico (AC-4).
- **Re-aplicar up** → sin error, ENABLE idempotente (AC-6).
- **Rollback** → aplicar down (`DISABLE x2`) → estado previo restaurado (AC-3), verify reporta las 2 en false.

---

## 5. Decisiones Técnicas (DT-N) — heredadas + F2

- **DT-1 (heredada) — Deny-default puro, SIN policy permisiva.** `ENABLE ROW LEVEL SECURITY` sin policy = deny-all para todo role sin `BYPASSRLS`. `service_role` bypassa nativamente. NO se crea ninguna `CREATE POLICY`: menos superficie de error y down trivial (nada que limpiar). Idéntico a DT-1 de SEC-02.
- **DT-2 (heredada) — Timestamp nuevo posterior a la última migración.** Última del repo = `20260609000000`. Se usa **`20260610000000`** (verificado libre en F2) para evitar colisión en el sistema de migraciones.
- **DT-3 (heredada) — `verify-rls-enabled.mjs` se extiende (no se duplica).** `RLS_TABLES` 7→9; el test se actualiza en paralelo. Set canónico único, sin segunda lista.
- **DT-4 (heredada) — Sin `FORCE ROW LEVEL SECURITY`.** `FORCE` afecta al table owner; `service_role` bypassa por `BYPASSRLS`, no por ownership → FORCE es innecesario y diverge del patrón SEC-02. Solo `ENABLE`.
- **DT-5 (F2) — `kite_schema_transforms.owner_ref` nullable no afecta RLS.** ENABLE sin policy = deny-all para anon/authenticated en TODOS los rows (incluidos owner_ref NULL legacy). El valor de owner_ref es irrelevante para el deny-default; service_role bypassa siempre. (Coincide con DT-4 del work-item.)
- **DT-6 (F2, heredada de SEC-02) — El down NO pasa por `migrate:preflight`.** El analizador marca `DISABLE ROW LEVEL SECURITY` como HIGH; aquí es deliberado. Se aplica directo vía Management API, igual que el up. Documentado en el comentario del down.

---

## 6. Constraint Directives (Anti-Alucinación)

Heredadas del work-item (CD-1..4) + endurecidas con la lección de auto-blindaje:

- **CD-1 — PROHIBIDO `CREATE POLICY` (ni permisiva ni `WITH CHECK`).** Deny-default no necesita policy; agregarla puede abrir accesos no previstos. (= CD-1 work-item / DT-1.)
- **CD-2 — PROHIBIDO `FORCE ROW LEVEL SECURITY`.** Diverge de SEC-02 sin justificación; FORCE no afecta a service_role. (= CD-2 work-item / DT-4.)
- **CD-3 — OBLIGATORIO que el down use `DISABLE ROW LEVEL SECURITY`** (NO `DROP TABLE`, NO `DROP POLICY` — no se creó ninguna). Rollback limpio. (= CD-3 work-item.)
- **CD-4 — OBLIGATORIO que ambas migraciones estén envueltas en `BEGIN;`/`COMMIT;`** (atomicidad). (= CD-4 work-item.)
- **CD-5 — PROHIBIDO tocar `src/`** (registry.ts / transform.ts ya son 100% service_role; no hay cambio app-layer). Esta HU es cero código de producción.
- **CD-6 — PROHIBIDO `CREATE [OR REPLACE] FUNCTION`** en estas migraciones (heredado de CD-12 SEC-02; aquí es DDL de tablas, sin RPC).
- **CD-7 — OBLIGATORIO: el test estructural del `.sql` cuenta sentencias DDL completas, NO substrings.** Usar el `countDdlStatements(sql, action)` ya presente (regex `ALTER TABLE public.\w+ <action> ROW LEVEL SECURITY;`), no `includes('ENABLE ROW LEVEL SECURITY')` crudo. **Referencia: WKH-SEC-02 auto-blindaje [2026-06-20 03:19]** — un substring sobre todo el archivo cuenta las menciones del comentario de cabecera y rompe el conteo.
- **CD-8 — OBLIGATORIO: al pasar `registries` al set canónico, reescribir el test "unexpected"** (`verify-rls-enabled.test.ts` L54-58) para usar una tabla que SIGA fuera del set (p.ej. `a2a_tasks`), no `registries`. De lo contrario el test queda contradictorio (registries ahora es esperada).
- **CD-9 — PROHIBIDO modificar archivos fuera de Scope IN (§4.1).** Solo los 2 `.sql` nuevos + `verify-rls-enabled.mjs` + su test.

---

## 7. Riesgos

| ID | Riesgo | Mitigación |
|----|--------|-----------|
| R-1 | El test "unexpected" queda contradictorio al entrar `registries` al set | CD-8: reescribir usando `a2a_tasks` (tabla sin owner_ref, fuera del set). |
| R-2 | Conteo DDL frágil por substring (lección SEC-02) | CD-7: reusar `countDdlStatements`, esperar 2 sentencias por archivo. |
| R-3 | El down marcado HIGH por `migrate:preflight` confunde a ops | DT-6: aplicar down directo vía Management API; documentado en comentario del down. |
| R-4 | Conflicto de merge en `verify-rls-enabled.mjs` con otra HU del batch | Bajo riesgo (script de ops); coordinar si SEC-02b también lo tocara (no lo hace). |
| R-5 | Colisión de timestamp de migración | Verificado en F2: `20260610000000` libre (última = `20260609000000`). |

---

## 8. Dependencias

- **Depende de**: nada bloqueante. SEC-02 ya DONE y en prod (patrón probado). Las 2 columnas `owner_ref` ya existen.
- **No bloquea**: otras HUs (aditiva en DB, sin cambio app-layer). Paralelo con SEC-02b (#119, toca RPCs no tablas directas).

---

## 9. Missing Inputs (resueltos en F2)

| Input | Resolución |
|-------|-----------|
| Timestamp exacto de la migración | `20260610000000` (verificado libre, DT-2). |

---

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno) | — | Todas las decisiones resueltas en F2 | No |

> Sin `[NEEDS CLARIFICATION]` pendientes. SDD listo para SPEC_APPROVED.

---

## 11. Plan de Implementación (Waves)

### Wave 0 (Serial — DDL)
- [ ] **W0.1**: Crear `supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql` — `ENABLE ROW LEVEL SECURITY` en `public.registries` y `public.kite_schema_transforms`, `BEGIN/COMMIT`, sin FORCE, sin policy. → Exemplar: `20260607000000_wkh_sec02_rls.sql`.
- [ ] **W0.2**: Crear `supabase/migrations/20260610000000_wkh_sec02c_rls_registries_down.sql` — `DISABLE ROW LEVEL SECURITY` en ambas, `BEGIN/COMMIT`. → Exemplar: `20260607000000_wkh_sec02_rls_down.sql`.
- [ ] **W0.3**: `npm run migrate:preflight supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql` → PASS (ENABLE no es HIGH).

### Wave 1 (Verificación — tras W0)
- [ ] **W1.1**: Editar `scripts/verify-rls-enabled.mjs` — agregar `'registries'` y `'kite_schema_transforms'` a `RLS_TABLES` (7→9). Actualizar el comentario de cabecera "7 tablas" → "9 tablas".
- [ ] **W1.2**: Editar `test/verify-rls-enabled.test.ts` — (a) `UP_PATH`/`DOWN_PATH` → nuevo `.sql`; (b) conteos `7`→`9` (incl. `evaluateRlsRows([])` espera 9 missing y `buildRlsQuery` espera 9 tablas); (c) `countDdlStatements` espera **2** ENABLE/DISABLE; (d) reescribir el test "unexpected" usando `a2a_tasks` (CD-8); (e) reusar `countDdlStatements`, no substring (CD-7).
- [ ] **W1.3**: `npm run test` verde + `tsc`/lint OK.

### Wave 2 (Deploy — manual, fuera de vitest)
- [ ] **W2.1**: Aplicar UP en dev (`<supabase-dev-ref>`) vía Management API.
- [ ] **W2.2**: `node scripts/verify-rls-enabled.mjs` contra dev → **9/9** true.
- [ ] **W2.3**: Smoke E2E del servicio en dev (registry CRUD + transform cache) → service_role idéntico.
- [ ] **W2.4**: Re-aplicar UP en dev → sin error (AC-6, idempotencia).
- [ ] **W2.5**: Aplicar UP en prod (`<supabase-prod-ref>`) + verify 9/9 + smoke.

---

## 12. Test Plan (≥1 por AC)

| Test | AC | Wave | Framework | Notas |
|------|----|------|-----------|-------|
| up `.sql` — "2 ENABLE ROW LEVEL SECURITY (registries + kite_schema_transforms)" via `countDdlStatements(sql,'ENABLE')===2` + match por tabla | AC-1 | W1 | vitest | confirma relrowsecurity se habilitará en ambas (CD-7). |
| up `.sql` — "no CREATE POLICY, no FORCE" | AC-2 | W1 | vitest | deny-default puro (CD-1, CD-2). |
| down `.sql` — "2 DISABLE ROW LEVEL SECURITY, una por tabla" via `countDdlStatements(sql,'DISABLE')===2` | AC-3 | W1 | vitest | rollback reversible (CD-3). |
| up + down `.sql` — "envuelto en BEGIN; ... COMMIT;" | AC-1, AC-3 | W1 | vitest | atomicidad (CD-4). |
| `buildRlsQuery()` — "consulta exactamente 9 tablas (incl. registries, kite_schema_transforms)" | AC-5 | W1 | vitest | `TABLES.toHaveLength(9)` + ambas presentes. |
| `evaluateRlsRows()` — "9/9 enabled → ok=true" | AC-5 | W1 | vitest | mock 9 filas true → exit 0. |
| `evaluateRlsRows()` — "una de las nuevas en false → ok=false, disabled la contiene" | AC-1, AC-5 | W1 | vitest | mock con `registries.rls_enabled=false`. |
| `evaluateRlsRows()` — "tabla aún-fuera-del-set (a2a_tasks) → unexpected" | AC-2 | W1 | vitest | reescritura del test L54-58 (CD-8). |
| `evaluateRlsRows([])` — "respuesta vacía → 9 missing" | AC-2, AC-5 | W1 | vitest | deny-default verificable / set completo. |
| `migrate:preflight` sobre el up (CLI manual) | AC-1, AC-6 | W0 | node | ENABLE no es HIGH → PASS. |
| Smoke E2E dev (manual) — registry CRUD + transform cache hit/miss | AC-4 | W2 | script existente | service_role opera idéntico (cero regresión). |
| Re-aplicar up en dev (manual) | AC-6 | W2 | Management API | idempotencia, sin error. |
| `verify-rls-enabled.mjs` contra dev/prod (manual) | AC-5 | W2 | node | reporta 9/9 true. |

> **Por qué la propiedad "anon denegado" no se testea en CI**: el CI no tiene una
> BD con roles `anon`/`authenticated` reales ni `BYPASSRLS`; el patrón del proyecto
> es 100% mock (test del verify script + estructura del `.sql`). La propiedad
> "anon denegado / service_role permitido" se valida en el smoke manual sobre dev
> antes de prod (igual que SEC-02). El AC-2 se cubre en CI por la ausencia
> verificada de policy (deny-default por construcción) y por el set canónico.

---

## 13. Plan de DEPLOY explícito

1. **Preflight (up)**: `npm run migrate:preflight supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql` → PASS.
2. **Dev apply**: up vía Management API contra `<supabase-dev-ref>` (patrón `apply-security-rpc-migration.mjs`).
3. **Dev verify**: `node scripts/verify-rls-enabled.mjs` → 9/9 `rls_enabled=true` (exit 0).
4. **Dev smoke**: registry CRUD + transform cache → service_role idéntico (AC-4).
5. **Idempotencia**: re-aplicar el up en dev → sin error (AC-6).
6. **Prod apply**: up vía Management API contra `<supabase-prod-ref>`.
7. **Prod verify**: `node scripts/verify-rls-enabled.mjs` (prod) → 9/9 true.
8. **Prod smoke**: smoke E2E contra prod → service_role idéntico.
9. **Rollback (si hace falta)**: down vía Management API (NO `migrate:preflight` — DT-6) → `DISABLE x2` → re-verify (las 2 en false).

---

## 14. Aprendizaje de Auto-Blindaje histórico (HUs DONE previas)

Revisadas las últimas DONE con `auto-blindaje.md` (WKH-SEC-02 #116, WKH-125b #120, WKH-126 #117):

- **WKH-SEC-02 (#116) [2026-06-20 03:19] — Conteo frágil de DDL por substring** (**recurrente con la tentación de esta HU, mismo tipo de test**): se hereda como **CD-7** — el test estructural del `.sql` DEBE usar `countDdlStatements` (sentencia completa), NO `includes(...)` crudo, porque el comentario de cabecera menciona la misma operación que el DDL. Como el conteo pasa de 7 a 2, el riesgo de off-by-N es real → blindado.
- **WKH-125 BLQ-MED-1 (vía SEC-02 CD-12) — `CREATE OR REPLACE FUNCTION` huérfano**: se hereda como **CD-6** — esta HU NO crea/reemplaza funciones (DDL de tablas), pero se blinda explícitamente.
- No hay otros patrones recurrentes (≥2 HUs) aplicables a una HU de DDL-RLS pura.

---

## 15. Readiness Check (F2)

```
[x] Cada AC (AC-1..6) tiene >= 1 test/archivo asociado (Test Plan §12)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Glob/Read (paths reales)
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-2 timestamp resuelto: 20260610000000)
[x] Constraint Directives incluyen >= 3 PROHIBIDO (CD-1,2,5,6,9) + 3 OBLIGATORIO (CD-3,4,7,8)
[x] Context Map tiene >= 2 archivos leídos (11 leídos y verificados)
[x] Scope IN (§4.1) y OUT (work-item §Scope OUT) explícitos y no ambiguos
[x] BD: las 2 tablas existen + owner_ref confirmado (registries NOT NULL, kite nullable)
[x] Único cliente = service_role confirmado (src/lib/supabase.ts) → AC-4 por construcción
[x] Timestamp de migración verificado libre (20260610000000; última repo = 20260609000000)
[x] Happy Path (§4.5) + Plan de Deploy (§13) + rollback (down) definidos
[x] Lección de auto-blindaje SEC-02 incorporada como CD-7 (conteo DDL no-frágil)
[x] Test "unexpected" reescrito previsto (CD-8) para no contradecirse con registries
```

**SDD listo para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — MINI — Architect F2*
