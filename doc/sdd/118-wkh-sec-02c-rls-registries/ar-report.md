# Adversarial Review (AR) — WKH-SEC-02c

> RLS Postgres-level en `registries` y `kite_schema_transforms`
> Branch: `feat/118-wkh-sec-02c-rls-registries`
> Revisor: nexus-adversary · Fecha: 2026-06-22
> Veredicto: **APROBADO**

---

## Resumen ejecutivo

| Métrica | Valor |
|---------|-------|
| BLOQUEANTE-ALTO | 0 |
| BLOQUEANTE-MEDIO | 0 |
| BLOQUEANTE-BAJO | 0 |
| MENOR | 2 |
| **Veredicto** | **APROBADO con MENORs** |

Cero código de producción. Patrón 1:1 con SEC-02 (auditado, en prod). Las 2 migraciones
son deny-by-default puro (ENABLE sin policy, sin FORCE), reversibles, atómicas. Test suite
verde (15/15). Acceso a ambas tablas es 100% `service_role` (BYPASSRLS) → cero regresión
verificada. Ningún vector de ataque produjo BLOQUEANTE.

---

## Evidencia ejecutada

- `npx vitest run test/verify-rls-enabled.test.ts` → **15 passed (15)**.
- `npm run migrate:preflight <up>` → **[PASS] Pre-flight OK** (único finding MEDIUM = embedded COMMIT, esperado por el BEGIN/COMMIT wrap, idéntico al exemplar SEC-02).
- `countDdlStatements` regex sobre el up/down real → 2 ENABLE / 2 DISABLE (no se deja engañar por menciones en comentarios).
- `grep .from('registries')` + `kite_schema_transforms` en `src/` → todos sobre el singleton `service_role` (`src/lib/supabase.ts`).

---

## Vectores de ataque

### V1 — ¿RLS realmente protege? (deny-default + service_role sigue)  → **OK**

- **ENABLE sin policy = deny-all** para `anon`/`authenticated`: confirmado. El up
  (`20260610000000_wkh_sec02c_rls_registries.sql` L10-11) solo hace `ENABLE ROW LEVEL
  SECURITY`, sin `CREATE POLICY`. En Postgres, RLS habilitado sin policy => ninguna fila
  visible/mutable para roles sin BYPASSRLS. Premisa correcta.
- **service_role sigue accediendo**: el ÚNICO cliente Supabase del servicio es el singleton
  `src/lib/supabase.ts:38` (`createClient(url, SUPABASE_SERVICE_KEY)`). `service_role` tiene
  `BYPASSRLS` nativo → no afectado por ENABLE. (Los `createClient` en
  `src/__tests__/e2e/*.real.test.ts` también usan `SERVICE_KEY`, no anon.)
- **Acceso anon/authenticated a estas 2 tablas en el código que rompería**: NINGUNO.
  Todas las lecturas/escrituras pasan por el singleton service_role:
  - `registries`: `src/services/registry.ts:119,133,191,285,343,362` + `src/services/event.ts:94` (7 usos; ver MNR-1).
  - `kite_schema_transforms`: `src/services/llm/transform.ts:207,242,273` (`import { supabase }` L… mismo singleton).

### V2 — Sin policy permisiva (CD-1) / sin FORCE (CD-2)  → **OK**

- `grep CREATE POLICY` y `FORCE` sobre ambos `.sql` → **0 matches**. El test lo blinda:
  `test/verify-rls-enabled.test.ts:113-119` (`no usa FORCE`, `no crea ninguna policy`).
  Un `CREATE POLICY` mal hecho abriría acceso; ausente. `FORCE` rompería al table owner
  (no a service_role) y divergiría del patrón; ausente.

### V3 — Down reversible (CD-3)  → **OK**

- `_down.sql` L9-10: solo `DISABLE ROW LEVEL SECURITY` x2. **Sin `DROP TABLE`, sin
  `DROP POLICY`, sin `DROP INDEX`**. Estado post-down idéntico al pre-up (RLS off, sin
  columnas/policies creadas que limpiar). Reversible y no destructivo.

### V4 — BEGIN/COMMIT (CD-4)  → **OK**

- Up L8/L13 y down L7/L12: ambos envueltos en `BEGIN;`/`COMMIT;`. Atomicidad garantizada;
  fallo parcial no deja schema corrupto. Test: L126-129 / L146-149.

### V5 — Idempotencia (AC-6)  → **OK**

- `ENABLE ROW LEVEL SECURITY` sobre tabla ya con RLS habilitado es no-op en Postgres (no
  error). Re-aplicar el up no rompe. Cubierto por construcción + W2.4 (re-apply manual dev).

### V6 — El test (conteo DDL CD-7 + "unexpected" CD-8)  → **OK**

- **Conteo por sentencia completa (CD-7)**: `countDdlStatements`
  (`test/verify-rls-enabled.test.ts:97-100`) usa regex
  `ALTER TABLE\s+public\.\w+\s+<action> ROW LEVEL SECURITY;` — cuenta sentencias reales,
  no substrings de comentario. Verificado ejecutando: up→2 ENABLE, down→2 DISABLE.
- **El `.sql` nuevo tiene 2 tablas, no 9**: el riesgo real (loop `for (const t of TABLES)`
  con 9 tablas contra un archivo de 2) fue correctamente acotado: los tests estructurales
  L105-111 y L135-140 iteran sobre `['registries','kite_schema_transforms']` (literal de 2),
  NO sobre `TABLES`. Bien resuelto.
- **"unexpected" reescrito (CD-8)**: L54-61 usa ahora `a2a_tasks` como tabla fuera-del-set.
  Verificado: `a2a_tasks` (migración `20260403180000_tasks.sql`) **NO tiene `owner_ref`**
  (grep sobre todas las migraciones de tasks → 0 matches) → correctamente fuera del set
  canónico. `registries` ya es esperada, por eso no podía seguir como "unexpected".
- **Verifica las 9 + 2 ENABLE en el nuevo .sql**: `buildRlsQuery` test L75-81 espera
  `TABLES.toHaveLength(9)` con ambas nuevas presentes; `evaluateRlsRows([])` L63-67 espera
  9 missing. `UP_PATH`/`DOWN_PATH` (L17-18) apuntan al nuevo `.sql`. Correcto.

### V7 — owner_ref existe en ambas tablas  → **OK**

- `registries.owner_ref`: `20260427210000_registries_owner_ref.sql:34` → `TEXT NOT NULL
  DEFAULT 'system'`.
- `kite_schema_transforms.owner_ref`: `20260427230000_kite_schema_transforms_owner.sql:36`
  → `TEXT` (nullable, legacy rows = NULL).
- Nota: nullable es irrelevante para el deny-default (ENABLE sin policy bloquea TODOS los
  rows, owner_ref NULL incluido). DT-5 correcto.
- **Completitud del set de 9**: enumeré todas las migraciones que agregan `owner_ref`. Las
  únicas tablas con `owner_ref` hoy son las 7 de SEC-02 + estas 2. `wkh_sec02b_owner_ref_rpc`
  solo modifica RPCs (pasa `p_owner_ref`), NO agrega columna a `a2a_tasks`. El set de 9 es
  completo y correcto al día de hoy.

### V8 — Scope drift  → **OK (con MNR-2 informativo)**

- Migraciones nuevas: exactamente las 2 `.sql` (up + down), untracked, timestamp
  `20260610000000` libre (última previa = `20260609000000`). Sin colisión.
- `git diff origin/main --name-only` sobre código: solo `scripts/verify-rls-enabled.mjs` +
  `test/verify-rls-enabled.test.ts`. **CERO cambio en `src/`** (CD-5 OK).
- Total HU = 4 archivos del Scope IN. ✔
- `BACKLOG.md` / `HACKATHON-FINAL.md` también aparecen modificados en el working tree, pero
  su contenido NO menciona SEC-02c (es grooming de backlog E15/E16 + nota de resultado del
  hackathon, drift pre-existente del branch, no producido por esta HU). Ver MNR-2.

### V9 — Destructive Migrations  → **N/A**

`ENABLE/DISABLE ROW LEVEL SECURITY` no toca data, schema de columnas, ni tipos. No hay
DROP, ALTER COLUMN, UPDATE masivo ni TRUNCATE. No aplica.

### V10 — RPC SECURITY DEFINER  → **N/A**

Esta HU no crea ni modifica funciones. Test L121-124 blinda ausencia de
`CREATE [OR REPLACE] FUNCTION`. (Las RPCs SECURITY DEFINER viven en SEC-02b #119, fuera de
scope.)

### V11 — Cache Invalidation  → **N/A**

No se introduce ninguna capa de cache. (`kite_schema_transforms` ES un cache L2 existente,
pero su lógica no se toca — solo se habilita RLS sobre la tabla; service_role la sigue
leyendo/escribiendo idéntico.)

---

## Findings MENORES (no bloquean DONE)

### MNR-1 — Context Map del SDD subcuenta los usos de `registries` (6 vs 7 reales)
- **Categoría**: Integration / Test Coverage (documentación)
- **Archivo**: `doc/sdd/118-wkh-sec-02c-rls-registries/sdd.md:51` ("6 `.from('registries')`
  (L119,133,191,285,343,362)") vs realidad: existe un **7º uso** en
  `src/services/event.ts:94` (`.from('registries').select(... count ...)`).
- **Por qué**: el inventario de call-sites quedó incompleto. NO es un riesgo funcional:
  `event.ts:6` importa el mismo singleton `service_role` (`import { supabase } from
  '../lib/supabase.js'`), por lo que el 7º uso TAMBIÉN bypassa RLS — la premisa de cero
  regresión se mantiene. Solo es una omisión en la evidencia documental.
- **Impacto**: bajo. Si en el futuro alguien audita "todos los call-sites cubiertos" guiándose
  por el SDD, podría pasar por alto `event.ts`. No afecta el comportamiento de esta HU.
- **Fix sugerido**: actualizar el Context Map del SDD a "7 `.from('registries')`
  (registry.ts x6 + event.ts:94)". No requiere cambio de código.

### MNR-2 — `BACKLOG.md` / `HACKATHON-FINAL.md` modificados fuera del Scope IN
- **Categoría**: Scope Drift
- **Archivo**: `BACKLOG.md` (+66 líneas, E15/E16 backlog) y `HACKATHON-FINAL.md` (+1 línea,
  resultado 3er puesto). Working tree, no commiteado en esta HU.
- **Por qué**: el Scope IN declara 4 archivos. Estos 2 docs no están en la lista. Verificado
  que su contenido NO tiene relación con SEC-02c (grep "sec-02c|registries|kite_schema" → 0).
  Es drift pre-existente del branch (grooming/nota de hackathon), no trabajo de esta HU.
- **Impacto**: nulo sobre la corrección de SEC-02c. Riesgo solo de "ruido" si se commitean
  junto al PR de esta HU mezclando concerns.
- **Fix sugerido**: NO incluir estos 2 archivos en el commit/PR de WKH-SEC-02c (commitear
  solo los 4 del Scope IN). Si esas ediciones de docs son intencionales, que vayan en un
  commit/PR aparte. Sin acción de código.

---

## Veredicto final

**APROBADO con MENORs.**

- 0 BLOQUEANTEs (ALTO/MEDIO/BAJO). El gate **PASA**.
- 2 MENORes, ambos documentales/de higiene de commit, sin impacto sobre la corrección ni la
  seguridad de la HU. No bloquean DONE; el Dev puede atenderlos o backloguearlos.

Las 11 categorías fueron revisadas (8 con OK, 3 N/A justificadas). El patrón replica
fielmente SEC-02 ya en prod; los tests blindan las lecciones de auto-blindaje (conteo DDL
no-frágil, "unexpected" coherente); cero regresión confirmada por construcción
(service_role único cliente, BYPASSRLS).

*AR generado por nexus-adversary — NexusAgil F-AR.*
