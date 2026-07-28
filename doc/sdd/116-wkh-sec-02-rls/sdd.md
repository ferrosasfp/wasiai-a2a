# SDD #116: [WKH-SEC-02] RLS Postgres-level (defensa en profundidad, 7 tablas con owner_ref)

> SPEC_APPROVED: no
> Fecha: 2026-06-20
> Tipo: security (improvement / DDL hardening)
> SDD_MODE: full
> Branch: feat/116-wkh-sec-02-rls
> Artefactos: doc/sdd/116-wkh-sec-02-rls/

---

## 1. Resumen

Habilitar `ROW LEVEL SECURITY` (RLS) en las **7 tablas de usuario con `owner_ref`**
para agregar una capa de defensa Postgres-level. Hoy la única protección contra
cross-tenant leaks es app-layer (WKH-53, `owner_ref` en services). RLS es un
**backstop / defensa en profundidad**: con RLS habilitada y sin policy permisiva,
Postgres deniega por defecto TODO acceso de los roles `anon`/`authenticated`,
mientras que el `service_role` —único role que usa el servicio (`src/lib/supabase.ts`)—
bypassa RLS por su atributo `BYPASSRLS` (Supabase lo asigna por diseño). El
resultado es **zero cambio de comportamiento del servicio en prod** y una barrera
DB-level nueva para accesos directos no autorizados.

Esta HU es **SOLO RLS (DDL de tablas)**. La parte (B) —ownership check dentro de
`increment_a2a_key_spend`— queda **DIFERIDA a WKH-SEC-02b** y NO se toca aquí.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 116 |
| **Tipo** | security / DDL hardening |
| **SDD_MODE** | full |
| **Objetivo** | Habilitar RLS (ENABLE, sin FORCE, sin policy permisiva) en las 7 tablas con `owner_ref`, con down script reversible y verificación `relrowsecurity = true`. |
| **Reglas de negocio** | Zero downtime; el servicio (`service_role`) opera idéntico; reversible en < 30s; idempotente. |
| **Scope IN** | Migración up `20260607000000_wkh_sec02_rls.sql`; down `20260607000000_wkh_sec02_rls_down.sql`; script `scripts/verify-rls-enabled.mjs`. |
| **Scope OUT** | (B) `increment_a2a_key_spend`; RLS en `registries`; policies con `auth.uid()`; cambios en `src/`. |
| **Missing Inputs** | Resueltos en F2 (ver §9). |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN la migración `20260607000000_wkh_sec02_rls.sql` se aplica, THE system SHALL habilitar `ROW LEVEL SECURITY` en las 7 tablas: `a2a_agent_keys`, `a2a_key_sessions`, `a2a_delegations`, `a2a_key_deposits`, `a2a_receipts`, `a2a_key_spend_policies`, `a2a_key_dest_spend_ledger`.
- **AC-2**: WHILE RLS está habilitada, THE system SHALL denegar por defecto cualquier SELECT/INSERT/UPDATE/DELETE ejecutado bajo `anon` o `authenticated` en las 7 tablas, sin policy explícita (deny-by-default de Postgres).
- **AC-3**: WHILE RLS está habilitada, THE system SHALL permitir a `service_role` leer y escribir todas las filas sin restricción (bypass nativo — comportamiento intacto).
- **AC-4**: WHEN se ejecuta `20260607000000_wkh_sec02_rls_down.sql`, THE system SHALL deshabilitar RLS (`DISABLE ROW LEVEL SECURITY`) en las 7 tablas y volver al estado previo.
- **AC-5**: WHEN un request con `SUPABASE_SERVICE_KEY` opera sobre cualquiera de las 7 tablas (balance, debit, sesión, depósito, recibo, policy), THE system SHALL procesar idéntico a antes de RLS (zero regresión funcional).
- **AC-6**: IF alguna de las 7 tablas ya tenía RLS habilitada, THEN THE system SHALL completar la migración sin error (idempotencia: `ENABLE ROW LEVEL SECURITY` es idempotente en Postgres).
- **AC-7**: WHEN se valida preflight, THE system SHALL confirmar `relrowsecurity = true` en `pg_class` para las 7 tablas antes de deployar a prod, vía `scripts/verify-rls-enabled.mjs`.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `doc/sdd/116-wkh-sec-02-rls/work-item.md` | Input aprobado | 7 tablas, exclusiones, (B) diferida, DT-1..5, CD-1..5 |
| `src/lib/supabase.ts:10-38` | Confirmar el role del cliente | Cliente singleton 100% `SUPABASE_SERVICE_KEY` (`service_role`). No existe cliente anon. → RLS no afecta al servicio |
| `supabase/migrations/20260427160000_secure_rpc_search_path.sql:1-25` | Estilo de hardening ya aplicado | `BEGIN; ... COMMIT;`, comentario de cabecera con HU + fecha + propósito, REVOKE/GRANT por role. Estilo a replicar |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql:8-10` | Confirmar tabla + owner_ref | `CREATE TABLE IF NOT EXISTS a2a_agent_keys (...) owner_ref TEXT NOT NULL` ✓ |
| `supabase/migrations/20260529000000_a2a_key_deposits.sql:7-10` | idem | `a2a_key_deposits`, `owner_ref TEXT NOT NULL` ✓ |
| `supabase/migrations/20260601000000_a2a_delegations.sql:11-14` | idem | `a2a_delegations`, `owner_ref TEXT NOT NULL` ✓ |
| `supabase/migrations/20260603000000_a2a_key_sessions.sql:1-4` | idem | `a2a_key_sessions`, `owner_ref TEXT NOT NULL` ✓ |
| `supabase/migrations/20260605000000_a2a_receipts.sql:6-8` | idem | `a2a_receipts`, `owner_ref TEXT NOT NULL` ✓ |
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql:10-13, 36-39` | idem (2 tablas) | `a2a_key_spend_policies` + `a2a_key_dest_spend_ledger`, ambas `owner_ref TEXT NOT NULL` ✓ |
| `supabase/migrations/20260605000000_a2a_receipts_down.sql` | Estilo de down script | `DROP ... IF EXISTS`; comentario `-- WKH-XXX down-migration` |
| `scripts/apply-security-rpc-migration.mjs:1-45` | Patrón de aplicación via Management API | Lee `.env`/`.env.local`, extrae `SUPABASE_ACCESS_TOKEN` (PAT) + `PROJECT_REF` de `SUPABASE_URL`, POST a `/v1/projects/{ref}/database/query`. **Exemplar directo para el verify script** |
| `scripts/migrate-preflight.mjs:870-907` | Patrón de queries read-only via psql + manifest | `EXPECTED_A2A_TABLES`, `POST_APPLY_QUERIES` (SELECT-only sobre `information_schema`/`pg_constraint`). El verify de RLS sigue esta línea (read-only) |
| `scripts/apply-prod-migrations.sh:1-40` | Refs de proyectos Supabase | **dev** `<supabase-dev-ref>`, **prod** `<supabase-prod-ref>`. Migraciones se aplican via Management API (no `supabase db push`) |
| `test/migrate-preflight.test.ts:618-628` | **HALLAZGO CRÍTICO** | El analizador estático ya trata `DISABLE ROW LEVEL SECURITY` como **HIGH risk** y `ENABLE ROW LEVEL SECURITY` como seguro. Impacta el down script (ver DT-6 / Riesgo R-3) |
| `CLAUDE.md` (sección "RLS real") | Contexto del proyecto | "Hoy la defensa es solo app-layer. El plan de `ENABLE ROW LEVEL SECURITY` + policy está trackeado en WKH-SEC-02". Esta HU lo materializa |

### Exemplars verificados (Glob/Read confirmados)

| Para crear | Seguir patrón de | Razón |
|-----------|------------------|-------|
| `supabase/migrations/20260607000000_wkh_sec02_rls.sql` | `20260427160000_secure_rpc_search_path.sql` | `BEGIN/COMMIT`, comentario de cabecera HU+fecha, DDL idempotente por tabla |
| `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` | `20260605000000_a2a_receipts_down.sql` | comentario `-- WKH-SEC-02 down-migration`, idempotente |
| `scripts/verify-rls-enabled.mjs` | `scripts/apply-security-rpc-migration.mjs` | misma forma: lee `.env`, PAT + ref, POST a Management API `/database/query`; aquí query read-only `pg_class.relrowsecurity` |

### Estado de BD relevante (verificado)

| Tabla | Existe | `owner_ref` | Migration de origen | RLS hoy |
|-------|--------|-------------|---------------------|---------|
| `a2a_agent_keys` | Sí | `TEXT NOT NULL` (L10) | `20260406000000` | No |
| `a2a_key_sessions` | Sí | `TEXT NOT NULL` (L4) | `20260603000000` | No |
| `a2a_delegations` | Sí | `TEXT NOT NULL` (L14) | `20260601000000` | No |
| `a2a_key_deposits` | Sí | `TEXT NOT NULL` (L10) | `20260529000000` | No |
| `a2a_receipts` | Sí | `TEXT NOT NULL` (L8) | `20260605000000` | No |
| `a2a_key_spend_policies` | Sí | `TEXT NOT NULL` (L13) | `20260606000000` | No |
| `a2a_key_dest_spend_ledger` | Sí | `TEXT NOT NULL` (L39) | `20260606000000` | No |

**Excluidas** (sin `owner_ref` o globales): `a2a_events`, `a2a_protocol_fees`,
`a2a_signed_auth_nonces`, `tasks`, `kite_schema_transforms` (owner_ref nullable/legacy),
y `registries` (canonical/system — RLS requiere análisis aparte). OUT del scope.

### Colisión de timestamp

Verificado con `ls supabase/migrations/`: **no existe** ningún archivo `20260607*`.
El timestamp `20260607000000` está libre. ✓

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260607000000_wkh_sec02_rls.sql` | Crear | `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` x7, dentro de `BEGIN/COMMIT`, sin FORCE, sin policy | `20260427160000_secure_rpc_search_path.sql` |
| `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` | Crear | `ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;` x7, idempotente | `20260605000000_a2a_receipts_down.sql` |
| `scripts/verify-rls-enabled.mjs` | Crear | Query read-only `pg_class.relrowsecurity` de las 7 tablas via Management API; exit 1 si alguna es false | `scripts/apply-security-rpc-migration.mjs` |

> No se modifica ningún archivo `src/` ni `test/` de producción.
> Los tests nuevos del SDD se listan en §Test Plan.

### 4.2 Modelo de datos

Sin cambios de esquema (sin columnas, sin tablas, sin FKs, sin RPCs). Solo se
flipea el flag `relrowsecurity` de cada tabla. `ENABLE ROW LEVEL SECURITY` no
reescribe filas, no toma locks de fila ni bloquea writes concurrentes — es DDL
online (toma un `ACCESS EXCLUSIVE` momentáneo sobre el catálogo de la tabla,
milisegundos).

### 4.3 SQL de diseño (el Dev lo escribe en F3 — esto es el contrato)

**UP — `20260607000000_wkh_sec02_rls.sql`** (forma esperada, sin policy permisiva):

```sql
-- WKH-SEC-02 (2026-06-20) — RLS defensa en profundidad (DT-1, DT-4).
-- Habilita ROW LEVEL SECURITY en las 7 tablas con owner_ref.
-- Sin FORCE (DT-4): service_role bypassa por BYPASSRLS; FORCE solo afecta al
-- table owner, no a service_role. Sin policy permisiva (DT-1): ENABLE sin
-- policy => deny-all para anon/authenticated (deny-by-default), service_role
-- bypassa nativamente. ENABLE es idempotente (re-aplicable sin error, AC-6).
BEGIN;

ALTER TABLE public.a2a_agent_keys            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_delegations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_deposits          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_receipts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_spend_policies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_dest_spend_ledger ENABLE ROW LEVEL SECURITY;

COMMIT;
```

**DOWN — `20260607000000_wkh_sec02_rls_down.sql`**:

```sql
-- WKH-SEC-02 down-migration — revierte RLS en las 7 tablas (AC-4).
-- DISABLE ROW LEVEL SECURITY es idempotente (re-aplicable sin error).
BEGIN;

ALTER TABLE public.a2a_agent_keys            DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_sessions          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_delegations           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_deposits          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_receipts              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_spend_policies    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.a2a_key_dest_spend_ledger DISABLE ROW LEVEL SECURITY;

COMMIT;
```

> **No se crean policies** (DT-1) → el down **no necesita** `DROP POLICY`. Si el
> Dev, por instrucción explícita del humano, optara por la variante con policy
> `TO service_role`, entonces el down DEBE agregar `DROP POLICY IF EXISTS` por
> tabla. Variante NO recomendada (ver DT-1).

**Verify query (read-only) — corazón de `verify-rls-enabled.mjs`**:

```sql
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'a2a_agent_keys','a2a_key_sessions','a2a_delegations','a2a_key_deposits',
    'a2a_receipts','a2a_key_spend_policies','a2a_key_dest_spend_ledger'
  )
ORDER BY c.relname;
```

El script falla (exit 1) si alguna fila tiene `rls_enabled = false`, o si faltan
filas (alguna tabla no encontrada). Exit 0 solo si las 7 están en `true`.

### 4.4 Flujo principal (Happy Path)

1. Dev crea los 3 archivos en F3.
2. `npm run migrate:preflight supabase/migrations/20260607000000_wkh_sec02_rls.sql`
   → el analizador estático NO flaggea `ENABLE ROW LEVEL SECURITY` (verificado en
   `migrate-preflight.test.ts:625-628`) → PASS.
3. Aplicar UP en **dev** (`<supabase-dev-ref>`) via Management API.
4. Correr `node scripts/verify-rls-enabled.mjs` → 7/7 `rls_enabled=true` → exit 0.
5. Smoke E2E del servicio en dev (script existente) → todas las ops `service_role`
   pasan idénticas (AC-3, AC-5).
6. Aplicar UP en **prod** (`<supabase-prod-ref>`) + verify + smoke.

### 4.5 Flujo de error / rollback

1. Si el verify reporta una tabla en `false`, o el smoke detecta una operación
   `service_role` que falla post-RLS → aplicar el down script (`DISABLE ... x7`),
   que revierte en < 30s.
2. Re-correr el verify post-down: las 7 tablas deben volver a `relrowsecurity=false`.
3. **Caveat de preflight para el down (DT-6 / R-3)**: el analizador estático
   `migrate-preflight.mjs` marca `DISABLE ROW LEVEL SECURITY` como **HIGH risk**
   (`migrate-preflight.test.ts:618-624`). Por diseño correcto del analizador (un
   DISABLE en un up accidental ES peligroso), pero aquí es un **down deliberado**.
   El down se aplica directo via Management API (igual que el up), **sin** pasar
   por `migrate:preflight` (el preflight es para ups). Documentar esto en el
   runbook para que el operador no se sorprenda si lo corre por costumbre.

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-1 — No interrumpir el servicio**: la migración NO debe afectar ninguna operación que el servicio ejecuta con `service_role`. Zero downtime, zero regresión (AC-3, AC-5). `service_role` bypassa RLS por `BYPASSRLS` (Supabase) — propiedad de seguridad central.
- **CD-2 — Down script obligatorio**: toda migración de la HU DEBE tener su `_down.sql` que la revierte (`DISABLE ROW LEVEL SECURITY` x7). Sin down, el PR no se aprueba.
- **CD-4 — Idempotencia**: el up debe ser re-aplicable sin error (`ENABLE ROW LEVEL SECURITY` es idempotente en Postgres). El down también (`DISABLE` idempotente). Verificar aplicando dos veces en dev.
- **CD-6 — Sin FORCE (DT-4)**: usar SOLO `ENABLE ROW LEVEL SECURITY`. NUNCA `FORCE ROW LEVEL SECURITY` — forzaría RLS al table owner y complica migraciones futuras; innecesario porque `service_role` bypassa por `BYPASSRLS`, que FORCE no afecta.
- **CD-7 — Tests 100% mock / sin BD real en CI**: los tests de la HU NO deben conectarse a una BD real (patrón `migrate-preflight.test.ts`: dependency injection sobre spawn/fetch, `process.env` restaurado). Verificación contra BD real = manual en el runbook de deploy, NO en `vitest run`.
- **CD-8 — owner_ref como fuente del set de tablas**: si en F3 el Dev no puede confirmar que una de las 7 tablas existe con `owner_ref`, NO la incluye y escala. (Las 7 ya están verificadas en §3; este CD cubre regresión futura.)

### PROHIBIDO
- **CD-3 — No modificar `increment_a2a_key_spend`** (ni su firma, ni sus callers, ni la parte (B)). Diferido a WKH-SEC-02b. Esta HU es solo DDL de tablas.
- **CD-5 — No policies con `auth.uid()` / user claims**: el cliente usa `service_role` que bypassa; policies basadas en JWT de usuario no aplican y generan falsos positivos confusos. Si (por decisión del humano) se crea una policy, SOLO puede ser `TO service_role USING (true)` — y el down DEBE dropearla.
- **CD-9 — No tocar `registries`, `a2a_events`, `a2a_protocol_fees`, `tasks`, `kite_schema_transforms`, `a2a_signed_auth_nonces`** — fuera de scope (sin owner_ref individual o globales/system).
- **CD-10 — No modificar `src/lib/supabase.ts` ni `src/services/*.ts`** — los guards app-layer del WKH-53 quedan intactos. Esta HU es aditiva DB-level.
- **CD-11 — No reutilizar el número de migración 20260606xxxxx ni anteriores** — usar exactamente `20260607000000` (timestamp libre, verificado).
- **CD-12 — `DROP FUNCTION/POLICY` con cambio de aridad/overload no aplica aquí** (heredado de auto-blindaje WKH-125 BLQ-MED-1): esta HU NO crea ni reemplaza funciones. Si en algún momento el Dev se ve tentado a `CREATE OR REPLACE` algo, STOP — está fuera de scope.

## 6. Scope

**IN:**
- `20260607000000_wkh_sec02_rls.sql` — `ENABLE ROW LEVEL SECURITY` x7.
- `20260607000000_wkh_sec02_rls_down.sql` — `DISABLE ROW LEVEL SECURITY` x7.
- `scripts/verify-rls-enabled.mjs` — verificación `pg_class.relrowsecurity` (read-only).
- Tests del SDD (ver Test Plan).

**OUT:**
- (B) `increment_a2a_key_spend` → WKH-SEC-02b.
- RLS en `registries` y todas las tablas sin owner_ref.
- Policies con lógica de user claims.
- Cambios en `src/`.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| **R-1** — `service_role` NO bypassa RLS y rompe el servicio en prod | Muy baja | Alto | Supabase asigna `BYPASSRLS` a `service_role` por diseño; el código corre meses con service_role. Mitigación operativa: aplicar primero en **dev**, correr verify + smoke E2E ANTES de prod; si algo falla, down en < 30s |
| **R-2** — alguna de las 7 tablas no existe en prod (drift dev↔prod) | Baja | Medio | `verify-rls-enabled.mjs` falla si falta una tabla (las 7 deben aparecer en `pg_class`); `apply-prod-migrations.sh` muestra que `a2a_agent_keys` ya está en prod. Verificar en preflight manual |
| **R-3** — el operador corre `migrate:preflight` sobre el **down** y lo ve BLOQUEADO (HIGH por `DISABLE ROW LEVEL SECURITY`) | Media | Bajo | Documentar en runbook: el preflight es para **ups**; el down se aplica directo via Management API. No es un bug del analizador (DISABLE ES legítimamente HIGH en un up) |
| **R-4** — FORCE aplicado por error rompe migraciones futuras | Baja | Medio | CD-6 prohíbe FORCE explícitamente; AR/CR debe verificar que el SQL solo dice `ENABLE`, nunca `FORCE` |
| **R-5** — colisión de timestamp de migración | Muy baja | Bajo | `20260607000000` verificado libre (`ls supabase/migrations/`) |

## 8. Dependencias

- Las 7 tablas deben existir en la BD destino (verificado en dev; confirmar en prod via verify script antes de aplicar).
- `SUPABASE_ACCESS_TOKEN` (PAT) + `SUPABASE_URL` en `.env`/`.env.local` para aplicar via Management API y correr el verify (mismo requisito que `apply-security-rpc-migration.mjs`).
- DEBE aplicarse ANTES de WKH-SEC-02b (dependencia de orden, no de implementación).

## 9. Missing Inputs (resueltos en F2)

- [resuelto] **Supabase `service_role` bypassa RLS** — confirmado por diseño de Supabase (`service_role` tiene `BYPASSRLS`); validación operativa = smoke E2E en dev antes de prod (no bloqueante para el SDD).
- [resuelto] **Policy explícita vs deny-default** — DT-1: se elige **deny-default puro (sin policy)**. No hay `[NEEDS CLARIFICATION]` residual.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno) | — | Todas las decisiones resueltas en F2 | No |

> Sin `[NEEDS CLARIFICATION]` pendientes. SDD listo para SPEC_APPROVED.

---

## Decisiones Técnicas (DT-N)

- **DT-1 — Deny-default puro, SIN policy permisiva (elegido).** `ENABLE ROW LEVEL SECURITY` sin ninguna policy resulta en deny-all para todo role que NO tenga `BYPASSRLS`. Para `anon`/`authenticated` eso es exactamente el objetivo (no deben acceder a NADA — todo va por `service_role`). `service_role` bypassa por su atributo `BYPASSRLS`, **independiente de que existan o no policies**. Por tanto NO se crea ninguna `CREATE POLICY`: menos superficie de error (una policy mal escrita podría abrir acceso no deseado) y la intención queda clara (deny total a non-service-role). El work-item ofrecía una variante con `CREATE POLICY "service_role_only" ... TO service_role USING (true)`; se descarta porque es redundante con el bypass nativo y agrega una pieza que el down tendría que limpiar. **No queda `[NEEDS CLARIFICATION]`**: la decisión es deny-default puro.

- **DT-4 — Sin `FORCE ROW LEVEL SECURITY`.** `FORCE` hace que RLS aplique también al **table owner** (que normalmente bypassa por ser dueño). Pero `service_role` NO bypassa por ser owner — bypassa por su atributo **`BYPASSRLS`**, que `FORCE` **no** afecta. Conclusión: FORCE es innecesario para el objetivo (deny a anon/authenticated, que no son owners ni bypass), y agrega riesgo de complicar migraciones/mantenimiento futuras corridas como table owner. Se usa **solo `ENABLE`** (más conservador y suficiente). Coherente con DT-4 del work-item.

- **DT-5 — Verificación via `pg_class.relrowsecurity` (read-only).** El verify script consulta `pg_class.relrowsecurity` (no `information_schema`, que no expone el flag RLS). Read-only, sin efectos. Patrón de aplicación tomado de `scripts/apply-security-rpc-migration.mjs` (PAT + Management API `/database/query`).

- **DT-6 — El down NO pasa por `migrate:preflight`.** El analizador estático trata `DISABLE ROW LEVEL SECURITY` como HIGH (correcto para detectar un DISABLE accidental en un up). El down de esta HU es un DISABLE **deliberado**; se aplica directo via Management API. El runbook lo documenta para evitar confusión operativa.

- **DT-7 — Aplicación via Management API, no `supabase db push`.** El proyecto aplica migraciones con el patrón `apply-*.mjs`/`apply-prod-migrations.sh` (Management API con PAT). El verify y la aplicación siguen ese camino, no la CLI de Supabase.

---

## Plan de Implementación (Waves)

### Wave 0 (Serial — contratos / DDL)
- [ ] **W0.1**: Crear `supabase/migrations/20260607000000_wkh_sec02_rls.sql` (`ENABLE ROW LEVEL SECURITY` x7, `BEGIN/COMMIT`, sin FORCE, sin policy). → Exemplar: `20260427160000_secure_rpc_search_path.sql`
- [ ] **W0.2**: Crear `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` (`DISABLE ROW LEVEL SECURITY` x7). → Exemplar: `20260605000000_a2a_receipts_down.sql`
- [ ] **W0.3**: Verificar localmente con `npm run migrate:preflight <up.sql>` → debe dar PASS (ENABLE no es HIGH).

### Wave 1 (Verificación — paralelizable tras W0)
- [ ] **W1.1**: Crear `scripts/verify-rls-enabled.mjs` (query `pg_class.relrowsecurity` de las 7 tablas; exit 1 si alguna false o falta; exit 0 si 7/7 true). → Exemplar: `scripts/apply-security-rpc-migration.mjs`
- [ ] **W1.2**: Crear test del verify script — `test/verify-rls-enabled.test.ts` — 100% mock (DI sobre fetch/spawn, sin BD real, CD-7). Cubre: 7/7 true → exit 0; una false → exit 1; tabla faltante → exit 1; lista de las 7 tablas correcta.
- [ ] **W1.3** (opcional, si se factoriza lógica del verify a una función exportable): test puro de la función de decisión (igual patrón que `decide()` en migrate-preflight).

### Wave 2 (Deploy — manual, fuera de `vitest`)
- [ ] **W2.1**: Aplicar UP en dev (`<supabase-dev-ref>`) via Management API.
- [ ] **W2.2**: `node scripts/verify-rls-enabled.mjs` contra dev → 7/7 true.
- [ ] **W2.3**: Smoke E2E del servicio en dev → todas las ops `service_role` idénticas.
- [ ] **W2.4**: Aplicar UP en prod (`<supabase-prod-ref>`) + verify + smoke.

### Test Plan

| Test | AC que cubre | Wave | Framework | Notas |
|------|-------------|------|-----------|-------|
| `test/verify-rls-enabled.test.ts` — "7/7 enabled → exit 0" | AC-7 | W1 | vitest | mock fetch devuelve 7 filas true |
| `test/verify-rls-enabled.test.ts` — "una tabla false → exit 1" | AC-7 | W1 | vitest | mock devuelve 6 true + 1 false |
| `test/verify-rls-enabled.test.ts` — "tabla faltante → exit 1" | AC-2, AC-7 | W1 | vitest | mock devuelve 6 filas (R-2) |
| `test/verify-rls-enabled.test.ts` — "valida exactamente las 7 tablas esperadas" | AC-1 | W1 | vitest | el set consultado == 7 tablas del scope |
| `migrate:preflight` sobre el up (CLI, manual) | AC-1, AC-6 | W0 | node | confirma que ENABLE no es HIGH (PASS) |
| Smoke E2E dev (manual runbook) | AC-3, AC-5 | W2 | script existente | service_role opera idéntico |

> **Por qué no hay test de "RLS deniega a anon" en CI**: el CI no tiene una BD
> Postgres con roles `anon`/`authenticated` reales ni el atributo `BYPASSRLS`;
> el patrón del proyecto (`migrate-preflight.test.ts`) es 100% mock (CD-7). La
> propiedad "anon denegado / service_role permitido" se valida en el **smoke
> manual sobre dev** antes de prod (runbook), no en `vitest run`. El test
> automatizable y de valor es el del **verify script** (que el flag quedó en true).

### Verificación incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | `tsc`/lint OK (SQL no compila, pero `migrate:preflight` PASS) |
| W1 | `npm run test` (verde, sin red de BD real) + `tsc` |
| W2 | verify 7/7 true en dev → smoke E2E → repetir en prod |

---

## Plan de DEPLOY explícito

1. **Preflight (up)**: `npm run migrate:preflight supabase/migrations/20260607000000_wkh_sec02_rls.sql` → debe ser PASS.
2. **Dev apply**: aplicar el up via Management API contra `<supabase-dev-ref>` (patrón `apply-security-rpc-migration.mjs`).
3. **Dev verify**: `node scripts/verify-rls-enabled.mjs` → exige 7/7 `rls_enabled=true` (exit 0).
4. **Dev smoke**: correr el smoke E2E del servicio (script existente) — confirmar que balance/debit/sesión/depósito/recibo/policy operan idéntico bajo `service_role`.
5. **Idempotencia**: re-aplicar el up en dev → sin error (AC-6).
6. **Prod apply**: aplicar el up via Management API contra `<supabase-prod-ref>`.
7. **Prod verify**: `node scripts/verify-rls-enabled.mjs` (apuntando a prod) → 7/7 true.
8. **Prod smoke**: smoke E2E contra prod → service_role idéntico.
9. **Rollback (si hace falta)**: aplicar el down via Management API (NO via `migrate:preflight` — DT-6) → `DISABLE x7` → re-verify (7/7 false).

---

## Aprendizaje de Auto-Blindaje histórico (HUs DONE previas)

Revisadas las últimas DONE con `auto-blindaje.md` (WKH-125, WKH-124, WKH-123, WKH-121):

- **WKH-125 BLQ-MED-1** (`CREATE OR REPLACE` +1 param crea overload huérfano): se
  hereda como **CD-12** — esta HU NO crea/reemplaza funciones, pero se blinda
  explícitamente contra la tentación. No hay riesgo de overload aquí (DDL de tablas).
- **WKH-121** (agregar arg posicional rompe aserciones `toHaveBeenCalledWith`): no
  aplica (no se modifican firmas TS). Se documenta para que el test del verify use
  matchers no-frágiles.
- **No es recurrente (< 2 HUs con el mismo bug)** ningún patrón que aplique a una
  HU de DDL-RLS pura → no se agregan CDs adicionales por este criterio.

---

## Readiness Check (F2)

```
[x] Cada AC tiene al menos 1 archivo asociado (tabla 4.1 + Test Plan)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Glob/Read (paths reales)
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-1 y service_role resueltos)
[x] Constraint Directives incluyen >= 3 PROHIBIDO (CD-3,5,9,10,11,12)
[x] Context Map tiene >= 2 archivos leídos (15 archivos leídos)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: las 7 tablas verificadas que existen + owner_ref NOT NULL confirmado
[x] Happy Path completo (§4.4) + Plan de Deploy
[x] Flujo de error / rollback definido (§4.5, R-3, down script)
[x] Timestamp de migración verificado libre (20260607000000)
[x] Hallazgo crítico documentado (preflight flaggea DISABLE → DT-6/R-3)
```

**SDD listo para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL — Architect F2*
