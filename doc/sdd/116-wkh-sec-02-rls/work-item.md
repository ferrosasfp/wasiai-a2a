# Work Item — [WKH-SEC-02] RLS Postgres-level + Hardening de RPCs

## Resumen

Habilitar Row Level Security (RLS) en todas las tablas de usuario con
`owner_ref` para agregar una capa de defensa Postgres-level que proteja contra
accesos directos con roles `anon`/`authenticated`. La defensa app-layer actual
(WKH-53, patrón `owner_ref` en services) se mantiene intacta; RLS es un
backstop, no un reemplazo. La parte (B) — agregar `p_owner_ref` dentro de
`increment_a2a_key_spend` — se DIFIERE a WKH-SEC-02b por riesgo de ruptura de
callers (ver F0 / DT-3).

---

## F0 — Grounding (hallazgos clave)

### Riesgo 1: ¿El cliente es 100% service_role?

CONFIRMADO: 100% service_role.

`src/lib/supabase.ts` (líneas 12–35) crea el cliente singleton usando
exclusivamente `process.env.SUPABASE_SERVICE_KEY`. No existe un segundo cliente
con anon key en todo el codebase. Búsqueda confirmada:

- `src/lib/*.ts` — solo `supabase.ts`, que usa `SUPABASE_SERVICE_KEY`.
- `src/services/*.ts` — todos importan `{ supabase }` desde `../lib/supabase.js`.
- `scripts/*.mjs` — no crean cliente Supabase; usan PAT (Management API) o
  llaman al servicio HTTP.
- No existe ningún archivo `src/lib/supabase-anon.ts` ni similar.

**Conclusión**: habilitar RLS + policy deny-by-default para `anon`/`authenticated`
es SEGURO. `service_role` bypassa RLS por diseño de Postgres y Supabase; el
servicio en vivo no se interrumpe.

### Riesgo 2: ¿Vale la pena (B) o se difiere?

(B) se DIFIERE a WKH-SEC-02b. Razonamiento:

`increment_a2a_key_spend` (firma: `uuid, integer, numeric`) es llamada desde
tres lugares:

1. `src/services/budget.ts` línea 293 — `supabase.rpc('increment_a2a_key_spend', {p_key_id, p_chain_id, p_amount_usd})`
2. `supabase/migrations/20260603000000_a2a_key_sessions.sql` línea 81 — `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` dentro de `debit_session_and_parent`
3. `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` líneas 123 y 216 — `PERFORM increment_a2a_key_spend(...)` dentro de `debit_with_dest_policy` y del `debit_session_and_parent` extendido (6 params)

Agregar `p_owner_ref` produce una sobrecarga Postgres y la firma vieja persiste
(lección documentada en WKH-125 / BLQ-MED-1). El fix requiere DROP de la firma
vieja + actualizar 3 callers en la misma migración + actualizar el TS. El riesgo
de regresión en prod es alto y el beneficio marginal: `increment_a2a_key_spend`
ya está REVOCADA de `anon`/`authenticated` (PR #36 / migración
`20260427160000_secure_rpc_search_path.sql`) y solo ejecuta bajo `service_role`.
Con RLS activo de esta HU, la capa DB-level queda cubierta. (B) agrega
ownership check DENTRO de la RPC — valor real, pero riesgo de ruptura justifica
diferirlo.

### Riesgo 3: Reversibilidad y seguridad en PROD

La migración DEBE incluir un down script que haga `DISABLE ROW LEVEL SECURITY`
+ `DROP POLICY IF EXISTS` en cada tabla. La BD es testnet pero real (agent keys
con saldo real). El down script permite rollback en < 30s.

### Tablas con owner_ref confirmadas (candidatas a RLS)

Verificado en todas las migrations:

| Tabla | Migration | owner_ref | Notas |
|-------|-----------|-----------|-------|
| `a2a_agent_keys` | 20260406000000 | NOT NULL | tabla raíz |
| `a2a_key_sessions` | 20260603000000 | NOT NULL | child de agent_keys |
| `a2a_delegations` | 20260601000000 | NOT NULL | child de agent_keys |
| `a2a_key_deposits` | 20260529000000 | NOT NULL | audit trail |
| `a2a_receipts` | 20260605000000 | NOT NULL | chain de recibos |
| `a2a_key_spend_policies` | 20260606000000 | NOT NULL | caps por destino |
| `a2a_key_dest_spend_ledger` | 20260606000000 | NOT NULL | débitos por destino |

**Tablas EXCLUIDAS de RLS** (no tienen owner_ref, son datos globales o admin):

| Tabla | Razón |
|-------|-------|
| `registries` | owner_ref existe pero la tabla es semi-global (wasiai canonical row); su ownership ya está en app-layer (WKH-63). RLS en registries requiere análisis adicional — OUT del scope. |
| `a2a_tasks` | sin owner_ref, telemetría global |
| `a2a_events` | sin owner_ref, telemetría global |
| `kite_schema_transforms` | owner_ref nullable (registros legacy sin owner); excluir por seguridad |
| `a2a_signed_auth_nonces` | lookup técnico, sin owner_ref |
| `a2a_protocol_fees` | sin owner_ref, tabla financiera global |

### Estado actual de hardening de RPCs (PR #36)

Migration `20260427160000_secure_rpc_search_path.sql`:
- `increment_a2a_key_spend`: `SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` — APLICADO.
- `register_a2a_key_deposit` v2: mismo hardening aplicado en `20260529000000`.
- `debit_delegation_and_parent`, `debit_session_and_parent`, `debit_with_dest_policy`, `insert_receipt`: hardening aplicado en sus respectivas migrations (20260601, 20260603, 20260605, 20260606).

**Conclusión**: todas las RPCs relevantes ya tienen `SET search_path` + REVOKE anon. (B) no es urgente para esta HU.

---

## Sizing

- SDD_MODE: full
- Estimacion: M
- Branch sugerido: `feat/116-wkh-sec-02-rls`
- Clasificacion: QUALITY (toca BD de prod, requiere SDD completo + reversibilidad)

---

## Skills Router

- `skill/db-security` — RLS, policies Postgres, SECURITY DEFINER patterns
- `skill/supabase-migrations` — convenciones de migración del proyecto, up/down, preflight checks

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN la migración `20260607000000_wkh_sec02_rls.sql` se aplica a la BD, the system SHALL habilitar `ROW LEVEL SECURITY` en las 7 tablas definidas en Scope IN (a2a_agent_keys, a2a_key_sessions, a2a_delegations, a2a_key_deposits, a2a_receipts, a2a_key_spend_policies, a2a_key_dest_spend_ledger).

- **AC-2**: WHILE RLS está habilitado, the system SHALL denegar por defecto cualquier SELECT/INSERT/UPDATE/DELETE ejecutado bajo el role `anon` o `authenticated` en las 7 tablas, sin necesidad de política explícita (deny-by-default de Postgres).

- **AC-3**: WHILE RLS está habilitado, the system SHALL permitir al role `service_role` leer y escribir todas las filas en las 7 tablas sin restricción (service_role bypassa RLS en Postgres — comportamiento intacto, servicio en prod no se interrumpe).

- **AC-4**: WHEN se ejecuta el down script `20260607000000_wkh_sec02_rls_down.sql`, the system SHALL deshabilitar RLS (`DISABLE ROW LEVEL SECURITY`) en las 7 tablas y el comportamiento de la BD SHALL volver al estado anterior a la migración.

- **AC-5**: WHEN un request autenticado con `SUPABASE_SERVICE_KEY` válida hace una operación sobre cualquiera de las 7 tablas (leer balance, debit, crear sesión, registrar depósito, etc.), the system SHALL procesar la operación de forma idéntica a antes de aplicar RLS (zero regresión funcional).

- **AC-6**: IF alguna de las 7 tablas ya tenía RLS habilitada antes de aplicar la migración, THEN the system SHALL completar la migración igualmente sin error (idempotencia via `IF NOT EXISTS` en policies y `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` es idempotente en Postgres).

- **AC-7**: WHEN se valida en staging (preflight manual per WKH-75 runbook), the system SHALL confirmar que las 7 tablas tienen `relrowsecurity = true` en `pg_class` antes de deployar a prod.

---

## Scope IN

- Nueva migration: `supabase/migrations/20260607000000_wkh_sec02_rls.sql`
  - `ALTER TABLE <tabla> ENABLE ROW LEVEL SECURITY` x7
  - Sin policy explícita adicional (deny-by-default es el efecto; service_role bypassa nativamente)
  - Opcional: `CREATE POLICY "service_role_only" ON <tabla> USING (true) WITH CHECK (true)` con `TO service_role` — ver DT-1.
- Nuevo down script: `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql`
  - `ALTER TABLE <tabla> DISABLE ROW LEVEL SECURITY` x7
- Script de validacion: `scripts/verify-rls-enabled.mjs` — consulta `pg_class.relrowsecurity` para las 7 tablas y falla si alguna es false.
- `doc/sdd/116-wkh-sec-02-rls/work-item.md` (este archivo)

---

## Scope OUT

- (B) Agregar `p_owner_ref` dentro de `increment_a2a_key_spend` — DIFERIDO a WKH-SEC-02b. Razones: (1) riesgo de sobrecarga Postgres, (2) todos los callers a actualizar en una sola migración, (3) la RPC ya tiene REVOKE de anon; la defensa faltante es ownership interno de la fn, no acceso externo.
- RLS en `registries` — DIFERIDO: requiere análisis adicional del canonical row `wasiai` (owner_ref='system') y políticas de lectura pública del discovery surface.
- RLS en `kite_schema_transforms`, `a2a_tasks`, `a2a_events`, `a2a_protocol_fees`, `a2a_signed_auth_nonces` — OUT: sin owner_ref individual o son datos globales.
- Cambios en `src/services/*.ts` — no se tocan; app-layer ownership guards del WKH-53 siguen igual.
- Cambios en `src/lib/supabase.ts` — no se toca.
- Policies RLS con lógica de usuario (tipo `USING (owner_ref = auth.uid())`) — OUT: el cliente usa `service_role` que bypassa, estas policies no aplican. No se introduce lógica de user claims.

---

## Decisiones tecnicas (DT-N)

- **DT-1 — Policy explícita vs deny-by-default puro**: En Postgres, habilitar RLS sin ninguna policy resulta en deny-all para todos los roles (incluyendo service_role en teoría, PERO Supabase sobreescribe este comportamiento: `service_role` siempre bypassa RLS). La opción más conservadora es `ENABLE ROW LEVEL SECURITY` sin policy adicional. Se PREFIERE esta opción (sin policy) para simplificar y evitar que una policy mal escrita dé acceso no deseado. Si en Architect se confirma que Supabase service_role no bypassa sin una policy explícita, agregar una `GRANT ALL ... TO service_role` con `USING (true)`. [NEEDS CLARIFICATION si el Architect elige la opción con policy explícita]

- **DT-2 — Orden de tablas en la migración**: Las 7 tablas con FK entre sí (key_sessions → agent_keys, delegations → agent_keys, etc.). El ENABLE RLS no afecta FKs — se puede aplicar en cualquier orden. Se aplica en orden de creación histórica para trazabilidad.

- **DT-3 — (B) diferida como WKH-SEC-02b**: El hardening interno de `increment_a2a_key_spend` (agregar ownership check dentro de la fn) se registra como deuda técnica WKH-SEC-02b. El issue que resuelve (un caller con service_role malicioso que pasa un `p_key_id` arbitrario) es un escenario de compromiso total del servicio — el riesgo residual post-RLS es bajo. WKH-SEC-02b se puede implementar con una fn nueva `increment_a2a_key_spend_owned` que llaman los wrappers existentes, sin romper la firma vieja.

- **DT-4 — Sin FORCE ROW LEVEL SECURITY**: NO se aplica `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. Esto forzaría RLS incluso a `table_owner` (superuser en Postgres), lo que podría romper migraciones futuras. `service_role` de Supabase tiene el bypass integrado.

- **DT-5 — Validacion preflight**: Antes de aplicar en prod, el Architect debe especificar que el script de validación `verify-rls-enabled.mjs` se corra contra la BD via Management API (PAT) para confirmar `relrowsecurity = true`. Patrón existente: `scripts/apply-security-rpc-migration.mjs`.

---

## Constraint Directives (CD-N)

- **CD-1 — PROHIBIDO interrumpir el servicio**: La migración NO debe afectar ninguna operación que el servicio ejecuta con `service_role`. Zero downtime. Si Architect detecta que alguna operación en prod usa un rol distinto, BLOCKEANTE antes de implementar.

- **CD-2 — OBLIGATORIO down script**: Toda migración de esta HU DEBE tener su correspondiente `_down.sql` que la revierte completamente. Sin down script, el PR no se aprueba.

- **CD-3 — PROHIBIDO modificar la firma de increment_a2a_key_spend en esta HU**: Cualquier cambio a esa función queda para WKH-SEC-02b. Esta HU es solo RLS (DDL de tablas, no lógica de RPCs).

- **CD-4 — OBLIGATORIO idempotencia**: La migración up debe ser re-aplicable sin error (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` es idempotente; `CREATE POLICY IF NOT EXISTS` si se usa policy). El down también (`DISABLE ... SECURITY` es idempotente; `DROP POLICY IF EXISTS`).

- **CD-5 — PROHIBIDO policies con auth.uid() o user claims**: El cliente usa `service_role`; las policies basadas en JWT de usuario no aplican y generarían falsos positivos confusos. Si se crea una policy, SOLO puede ser `TO service_role USING (true)` o equivalente.

---

## Missing Inputs

- [resuelto en F2] Confirmar que Supabase cloud (bdwvrwzvsldephfibmuu) aplica el bypass de service_role correctamente (Supabase docs garantizan esto, pero Architect debe validar en staging antes de prod).
- [resuelto en F2] Decidir si se crea una policy explícita `TO service_role` (DT-1) o se confía solo en el bypass nativo — el Architect elige con evidencia del comportamiento Supabase.

---

## Analisis de paralelismo

- Esta HU NO bloquea otras HUs activas (es DDL puro sobre tablas que ya existen).
- Puede correr en paralelo con cualquier HU de features que no toque las migrations.
- Si hay una HU que crea una tabla NUEVA con `owner_ref`, esa tabla queda sin RLS hasta que se agregue en una migration posterior (out of scope aquí).
- Esta HU DEBE aplicarse ANTES de WKH-SEC-02b (que modifica `increment_a2a_key_spend`) — hay dependencia de orden pero no de implementación.
- Riesgo de conflicto de migración: el siguiente número disponible después de `20260606000000` es `20260607000000`. Verificar que no haya migrations con ese timestamp antes de crear.

## Analisis de riesgo de deploy

**Riesgo BAJO** — justificación:
1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` es DDL online en Postgres (no lockea filas, no detiene writes).
2. `service_role` bypassa RLS en Supabase por diseño — confirmado por documentación y por el hecho de que el código lleva meses operando con `SUPABASE_SERVICE_KEY`.
3. No hay cambios en código TypeScript — solo SQL.
4. El down script permite revertir en < 30s si se detecta problema.

**Mitigacion**:
- Aplicar primero en la BD dev (mismo proyecto Supabase `bdwvrwzvsldephfibmuu`, schema dev si existe, o directo dado que ya es testnet).
- Correr el script `verify-rls-enabled.mjs` para confirmar que las 7 tablas tienen RLS activo.
- Correr smoke E2E (script existente) para confirmar que el servicio sigue operando identicamente.
- Luego aplicar en prod (Railway env prod si existe BD separada).
