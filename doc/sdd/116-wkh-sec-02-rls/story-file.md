# Story File — #116: [WKH-SEC-02] RLS Postgres-level (defensa en profundidad, 7 tablas con owner_ref)

> SDD: doc/sdd/116-wkh-sec-02-rls/sdd.md (SPEC_APPROVED)
> Fecha: 2026-06-20
> Branch: feat/116-wkh-sec-02-rls

---

## Goal

Habilitar `ROW LEVEL SECURITY` (RLS) en las **7 tablas de usuario con `owner_ref`** para
agregar una barrera de defensa en profundidad a nivel Postgres. Hoy la única protección
contra cross-tenant leaks es app-layer (WKH-53, `owner_ref` en services). Con RLS
habilitada y **sin policy permisiva**, Postgres deniega por defecto TODO acceso de los
roles `anon`/`authenticated`. El **único** role que usa el servicio
(`src/lib/supabase.ts` → `SUPABASE_SERVICE_KEY` → `service_role`) **bypassa RLS** por su
atributo `BYPASSRLS` (Supabase lo asigna por diseño). Resultado: **cero cambio de
comportamiento del servicio en prod**, una barrera DB-level nueva.

Esta HU es **SOLO RLS (DDL `ALTER TABLE ... ENABLE`)**. La parte (B) —ownership check
dentro de `increment_a2a_key_spend`— está **DIFERIDA a WKH-SEC-02b** y NO se toca aquí.

---

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado. Estos son los criterios que QA verificará en F4.

1. **AC-1**: WHEN la migración `20260607000000_wkh_sec02_rls.sql` se aplica, THE system SHALL habilitar `ROW LEVEL SECURITY` en las 7 tablas: `a2a_agent_keys`, `a2a_key_sessions`, `a2a_delegations`, `a2a_key_deposits`, `a2a_receipts`, `a2a_key_spend_policies`, `a2a_key_dest_spend_ledger`.
2. **AC-2**: WHILE RLS está habilitada, THE system SHALL denegar por defecto cualquier SELECT/INSERT/UPDATE/DELETE bajo `anon` o `authenticated` en las 7 tablas, sin policy explícita (deny-by-default de Postgres).
3. **AC-3**: WHILE RLS está habilitada, THE system SHALL permitir a `service_role` leer y escribir todas las filas sin restricción (bypass nativo — comportamiento intacto).
4. **AC-4**: WHEN se ejecuta `20260607000000_wkh_sec02_rls_down.sql`, THE system SHALL deshabilitar RLS (`DISABLE ROW LEVEL SECURITY`) en las 7 tablas y volver al estado previo.
5. **AC-5**: WHEN un request con `SUPABASE_SERVICE_KEY` opera sobre cualquiera de las 7 tablas, THE system SHALL procesar idéntico a antes de RLS (zero regresión funcional).
6. **AC-6**: IF alguna de las 7 tablas ya tenía RLS habilitada, THEN THE system SHALL completar la migración sin error (idempotencia: `ENABLE ROW LEVEL SECURITY` es idempotente en Postgres).
7. **AC-7**: WHEN se valida preflight, THE system SHALL confirmar `relrowsecurity = true` en `pg_class` para las 7 tablas antes de deployar a prod, vía `scripts/verify-rls-enabled.mjs`.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `supabase/migrations/20260607000000_wkh_sec02_rls.sql` | Crear | `BEGIN;` + `ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;` para las 7 tablas exactas + `COMMIT;`. SIN FORCE, SIN policy. Texto en §SQL Exacto. | `supabase/migrations/20260427160000_secure_rpc_search_path.sql` |
| 2 | `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` | Crear | `BEGIN;` + `ALTER TABLE public.<t> DISABLE ROW LEVEL SECURITY;` x7 + `COMMIT;`. Texto en §SQL Exacto. | `supabase/migrations/20260605000000_a2a_receipts_down.sql` |
| 3 | `scripts/verify-rls-enabled.mjs` | Crear | Lee PAT+ref de `.env`, POST `pg_class.relrowsecurity` de las 7 tablas via Management API; exit 0 si las 7 son `true`, exit 1 si alguna `false`/falta. Pure-fn `evaluateRlsRows` + `main(deps)` + CLI-guard exportables. | `scripts/apply-security-rpc-migration.mjs` + patrón export/`main(deps)` de `scripts/migrate-preflight.mjs` |
| 4 | `test/verify-rls-enabled.test.ts` | Crear | Tests 100% mock (sin BD real) de `evaluateRlsRows` + estructura del SQL up/down (7 líneas ENABLE / 7 DISABLE). | `test/migrate-preflight.test.ts` |

> No se modifica ningún archivo `src/` ni ningún test de producción existente.

---

## SQL Exacto (copiar TEXTUAL — no improvisar)

### Archivo #1 — `supabase/migrations/20260607000000_wkh_sec02_rls.sql`

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

### Archivo #2 — `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql`

```sql
-- WKH-SEC-02 down-migration — revierte RLS en las 7 tablas (AC-4).
-- DISABLE ROW LEVEL SECURITY es idempotente (re-aplicable sin error).
-- NOTA OPS (DT-6): este down NO pasa por `npm run migrate:preflight`. El
-- analizador estático marca DISABLE ROW LEVEL SECURITY como HIGH (correcto para
-- un DISABLE accidental en un up). Aquí es un DISABLE deliberado: se aplica
-- directo via Management API, igual que el up.
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

### Query read-only del verify (corazón de Archivo #3)

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

> `information_schema` NO expone el flag RLS — usar `pg_class.relrowsecurity` (DT-5).

---

## Las 7 tablas EXACTAS (set canónico — ni una más, ni una menos)

1. `a2a_agent_keys`
2. `a2a_key_sessions`
3. `a2a_delegations`
4. `a2a_key_deposits`
5. `a2a_receipts`
6. `a2a_key_spend_policies`
7. `a2a_key_dest_spend_ledger`

**Definí esta lista UNA sola vez en el `.mjs`** (ej. `export const RLS_TABLES = [...]`) y
reusala para construir el query y para validar el resultado. El test (#4) debe assertear
que el script consulta exactamente estas 7.

---

## Anti-Hallucination Checklist (específico WKH-SEC-02)

> Verificá CADA punto antes de dar la HU por terminada. Cualquier desvío = STOP + escalar.

- [ ] **Exactamente las 7 tablas de arriba** — NO incluir `registries`, `a2a_events`, `a2a_protocol_fees`, `a2a_signed_auth_nonces`, `tasks`/`a2a_tasks`, `kite_schema_transforms`. (CD-9)
- [ ] **`ENABLE`, nunca `FORCE`** — el SQL del up dice `ENABLE ROW LEVEL SECURITY`, jamás `FORCE ROW LEVEL SECURITY`. `service_role` bypassa por `BYPASSRLS`, que `FORCE` no afecta. (CD-6 / DT-4)
- [ ] **NO `CREATE POLICY`** — deny-default = ENABLE sin ninguna policy. NO crear `service_role_only` ni ninguna otra policy. Si no hay policy, el down NO necesita `DROP POLICY`. (CD-5 / DT-1)
- [ ] **NO tocar `increment_a2a_key_spend`** ni ninguna RPC (ni firma, ni callers, ni la parte B). DDL de tablas únicamente. (CD-3)
- [ ] **NO `CREATE`/`CREATE OR REPLACE FUNCTION`** — esta HU NO crea ni reemplaza funciones. Si te ves tentado, STOP, está fuera de scope. (CD-12, heredado WKH-125 BLQ-MED-1)
- [ ] **Idempotente** — `ENABLE`/`DISABLE ROW LEVEL SECURITY` son idempotentes en Postgres (re-aplicar sin error). No agregar `IF NOT EXISTS` (no aplica a este DDL). (CD-4 / AC-6)
- [ ] **`BEGIN;` ... `COMMIT;`** envolviendo las 7 sentencias, tanto en el up como en el down.
- [ ] **El down NO pasa por `migrate:preflight`** — `DISABLE` es HIGH para el analizador (correcto). Se aplica directo via Management API. NO "arreglar" el analizador. (DT-6 / R-3)
- [ ] **El servicio (`service_role`) NO se afecta** — NO modificar `src/lib/supabase.ts` ni `src/services/*.ts`. (CD-10)
- [ ] **Timestamp `20260607000000`** — verificado libre. NO reusar `20260606xxxxx` ni anteriores. (CD-11)
- [ ] **Verify usa `pg_class.relrowsecurity`** — NO `information_schema` (no expone el flag). Read-only. (DT-5)
- [ ] **Tests 100% mock** — el test NO se conecta a BD real ni hace fetch real; inyecta `fetch`/deps. `process.env` restaurado en `afterEach`. (CD-7)

---

## Contrato del verify script — `scripts/verify-rls-enabled.mjs`

> Sin componentes que se hablen entre sí en runtime de producción: es una herramienta
> de ops. Igual definimos su contrato de entrada/salida para que sea testeable.

**Entrada (config):**
- Lee `.env` y `.env.local` con el mismo `readEnv(path)` de `apply-security-rpc-migration.mjs`.
- `SUPABASE_ACCESS_TOKEN` (PAT, obligatorio) — Bearer de la Management API.
- **Project ref**: parametrizable. Resolución sugerida, en orden:
  1. arg de CLI: `node scripts/verify-rls-enabled.mjs <project_ref>`
  2. env `PROJECT_REF` si está seteada
  3. fallback: derivar de `SUPABASE_URL` con `/https:\/\/([a-z0-9]+)\.supabase\.co/` (mismo regex del exemplar).
  - Refs conocidas: **dev** `<supabase-dev-ref>`, **prod** `<supabase-prod-ref>` (de `scripts/apply-prod-migrations.sh`). NO hardcodear como default fijo; el operador elige por arg/env.
- Si falta PAT o no se puede resolver el ref → `console.error(...)` + `process.exit(3)` (igual que el exemplar).

**Llamada HTTP:**
- `POST https://api.supabase.com/v1/projects/<ref>/database/query`
- Headers: `Authorization: Bearer <PAT>`, `Content-Type: application/json`
- Body: `JSON.stringify({ query: <el SELECT read-only de arriba> })`

**Salida / criterio de decisión (función pura exportable, ej. `evaluateRlsRows(rows)`):**
- Recibe el array de filas `{ table_name, rls_enabled }` del response.
- exit `0` ⟺ las 7 tablas esperadas están presentes Y todas con `rls_enabled === true`.
- exit `1` si: alguna fila `rls_enabled === false`, O falta alguna de las 7 tablas (R-2), O hay tablas inesperadas en el set.
- exit `3` reservado para errores de config (PAT/ref faltante).
- Imprimir un resumen legible (qué tabla quedó en false / cuál falta) antes de salir.

**Estructura para testabilidad (espejá `migrate-preflight.mjs`):**
- `export const RLS_TABLES = [...]` (las 7).
- `export function buildRlsQuery()` → devuelve el SELECT.
- `export function evaluateRlsRows(rows)` → `{ ok: boolean, missing: string[], disabled: string[] }`.
- `export async function main({ fetch, env, argv } = {...})` → orquesta, devuelve/usa exit code.
- CLI-guard al final: ejecutar `main()` SOLO si `import.meta.url === \`file://${process.argv[1]}\``
  (idéntico al guard de `migrate-preflight.mjs:1137-1140`), para que el test pueda
  `import` sin disparar la ejecución ni la llamada HTTP.

---

## Exemplars

### Exemplar 1 — Aplicación via Management API (PAT)
**Archivo**: `scripts/apply-security-rpc-migration.mjs` (leelo completo, 45 líneas)
**Usar para**: Archivo #3 (`verify-rls-enabled.mjs`)
**Patrón clave**:
- `readEnv(p)`: parsea `KEY=value` con manejo de comillas; ignora errores (`try/catch`).
- Merge `.env` + `.env.local` (`.env.local` pisa `.env`).
- `const PAT = env.SUPABASE_ACCESS_TOKEN;`
- ref derivado de `SUPABASE_URL` con `/https:\/\/([a-z0-9]+)\.supabase\.co/`.
- `if (!PAT || !refMatch) { console.error(...); process.exit(3); }`
- `fetch(\`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query\`, { method:'POST', headers:{ Authorization:\`Bearer ${PAT}\`, 'Content-Type':'application/json' }, body: JSON.stringify({ query }) })`
- `process.exit(res.ok ? 0 : 1)` — adaptá: el exit lo decide `evaluateRlsRows`, no solo `res.ok`.

### Exemplar 2 — Estilo de migración de seguridad (up)
**Archivo**: `supabase/migrations/20260427160000_secure_rpc_search_path.sql` (25 líneas)
**Usar para**: Archivo #1 (up)
**Patrón clave**:
- Comentario de cabecera con HU + fecha + propósito (líneas 1-4).
- `BEGIN;` (línea 6) ... `COMMIT;` (línea 24) envolviendo el DDL.
- DDL por objeto, una sentencia por línea, alineado.

### Exemplar 3 — Estilo de down-migration
**Archivo**: `supabase/migrations/20260605000000_a2a_receipts_down.sql` (3 líneas)
**Usar para**: Archivo #2 (down)
**Patrón clave**:
- Comentario `-- WKH-XXX down-migration` en la primera línea.
- Sentencias idempotentes que revierten el up. (Aquí: `DISABLE` x7 dentro de `BEGIN/COMMIT`.)

### Exemplar 4 — Test 100% mock + funciones puras exportables + CLI-guard
**Archivo**: `test/migrate-preflight.test.ts` + `scripts/migrate-preflight.mjs`
**Usar para**: Archivo #3 (estructura exportable) y Archivo #4 (test)
**Patrón clave**:
- El `.mjs` exporta funciones puras (`analyze`, `decide`, `EXPECTED_A2A_TABLES`, ...) y un `main(deps)` que recibe dependencias inyectadas.
- CLI-guard: `if (import.meta.url === \`file://${process.argv[1]}\` || ...) main({ argv: process.argv })` (líneas 1137-1140) → el `import` desde el test NO ejecuta.
- El test importa con `/// <reference path="./types/...d.ts" />` o equivalente; usa `vitest` (`describe/it/expect/beforeEach/afterEach`); restaura `process.env` en `afterEach`; inyecta spawn/fetch en vez de tocar red/BD.

### Tablas de origen (confirmación de nombres + `owner_ref TEXT NOT NULL`)
Ya verificadas en el SDD §3 — NO necesitás re-leerlas, pero acá están si dudás de un nombre:
`20260406000000_a2a_agent_keys.sql`, `20260603000000_a2a_key_sessions.sql`,
`20260601000000_a2a_delegations.sql`, `20260529000000_a2a_key_deposits.sql`,
`20260605000000_a2a_receipts.sql`, `20260606000000_a2a_key_spend_policies.sql`
(contiene también `a2a_key_dest_spend_ledger`).

---

## Constraint Directives

### OBLIGATORIO
- **CD-1** — La migración NO debe afectar ninguna operación que el servicio ejecuta con `service_role`. Zero downtime, zero regresión (AC-3, AC-5). `service_role` bypassa RLS por `BYPASSRLS`.
- **CD-2** — Down script obligatorio (`DISABLE ROW LEVEL SECURITY` x7). Sin down, el PR no se aprueba.
- **CD-4** — Idempotencia: up y down re-aplicables sin error.
- **CD-6** — Usar SOLO `ENABLE ROW LEVEL SECURITY`. NUNCA `FORCE`.
- **CD-7** — Tests 100% mock, sin BD real en CI. `process.env` restaurado, deps inyectadas.
- **CD-8** — `owner_ref` es la fuente del set de tablas: las 7 están verificadas. Si no podés confirmar una, NO la incluís y escalás.
- Seguir el patrón de `apply-security-rpc-migration.mjs` para el verify y de `secure_rpc_search_path.sql` para el up.
- Imports: solo módulos `node:*` que ya usa el proyecto (`node:fs`, `node:url`).

### PROHIBIDO
- **CD-3** — NO modificar `increment_a2a_key_spend` (ni firma, ni callers, ni la parte B). Diferida a WKH-SEC-02b.
- **CD-5** — NO policies con `auth.uid()` / user claims. NO `CREATE POLICY` de ningún tipo (deny-default puro). Si por orden explícita del humano se creara una `TO service_role USING (true)`, el down DEBE dropearla — pero NO es el camino de esta HU.
- **CD-9** — NO tocar `registries`, `a2a_events`, `a2a_protocol_fees`, `tasks`/`a2a_tasks`, `kite_schema_transforms`, `a2a_signed_auth_nonces`.
- **CD-10** — NO modificar `src/lib/supabase.ts` ni `src/services/*.ts`.
- **CD-11** — NO reutilizar el número de migración `20260606xxxxx` ni anteriores. Usar exactamente `20260607000000`.
- **CD-12** — NO crear ni reemplazar funciones (`CREATE`/`CREATE OR REPLACE FUNCTION`). Fuera de scope.
- NO agregar dependencias nuevas: **ninguna**.
- NO modificar archivos fuera de la tabla "Files to Modify/Create".

---

## Test Expectations

| Test | ACs que cubre | Framework | Tipo |
|------|--------------|-----------|------|
| `test/verify-rls-enabled.test.ts` — "7/7 enabled → ok=true (exit 0)" | AC-7 | vitest | unit (mock) |
| `test/verify-rls-enabled.test.ts` — "una tabla false → ok=false (exit 1)" | AC-7 | vitest | unit (mock) |
| `test/verify-rls-enabled.test.ts` — "tabla faltante → ok=false (exit 1)" | AC-2, AC-7, R-2 | vitest | unit (mock) |
| `test/verify-rls-enabled.test.ts` — "consulta exactamente las 7 tablas esperadas" | AC-1 | vitest | unit (mock) |
| `test/verify-rls-enabled.test.ts` — "el up tiene 7 `ENABLE ROW LEVEL SECURITY` para las 7 tablas, ningún `FORCE`, ningún `CREATE POLICY`" | AC-1, AC-6, CD-6, CD-5 | vitest | unit (estructural, lee el .sql con `readFileSync`) |
| `test/verify-rls-enabled.test.ts` — "el down tiene 7 `DISABLE ROW LEVEL SECURITY` para las 7 tablas" | AC-4 | vitest | unit (estructural) |
| `migrate:preflight` sobre el up (CLI, manual) | AC-1, AC-6 | node | manual (PASS esperado: ENABLE no es HIGH) |
| Smoke E2E dev (runbook manual) | AC-3, AC-5 | script existente | manual |

### Detalle del test estructural del SQL
- Resolvé el path con `node:url`/`node:path` desde `import.meta.url` hacia `supabase/migrations/...`.
- `readFileSync(upPath, 'utf8')`: assertear que para cada una de `RLS_TABLES` existe la línea `ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;`; que el conteo de `ENABLE ROW LEVEL SECURITY` es exactamente 7; que NO aparece `FORCE ROW LEVEL SECURITY`; que NO aparece `CREATE POLICY`.
- Idem para el down con `DISABLE ROW LEVEL SECURITY` x7.
- Usar matchers no-frágiles (`.toContain`, conteos), no aserciones posicionales rígidas (lección WKH-121).

### Criterio Test-First
- Lógica de decisión del verify (`evaluateRlsRows`) → **Sí, test-first**.
- Migraciones SQL → el test estructural se puede escribir junto con el SQL (no bloquea).

> El test de "RLS deniega a anon" NO va en CI: el CI no tiene Postgres con roles
> `anon`/`authenticated` reales ni `BYPASSRLS`. Esa propiedad se valida en el smoke manual
> sobre dev (runbook), no en `vitest`. (CD-7)

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a

# Dependencias
npm install 2>/dev/null || echo "Sin package.json"

# Archivos base / exemplars existen
ls supabase/migrations/20260427160000_secure_rpc_search_path.sql \
   supabase/migrations/20260605000000_a2a_receipts_down.sql \
   scripts/apply-security-rpc-migration.mjs \
   scripts/migrate-preflight.mjs \
   test/migrate-preflight.test.ts 2>/dev/null || echo "FALTA archivo base/exemplar"

# Timestamp libre (no debe imprimir nada salvo el OK)
ls supabase/migrations/20260607* 2>/dev/null && echo "COLISION DE TIMESTAMP — PARAR" || echo "20260607 libre OK"

# Nota: SUPABASE_ACCESS_TOKEN / SUPABASE_URL solo se necesitan en Wave 3 (deploy ops),
# NO para crear archivos ni correr tests (CD-7). No bloquea Wave 0-2.
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.

### Wave 0 (Serial Gate — DDL / contrato)
- [ ] **W0.1**: Crear `supabase/migrations/20260607000000_wkh_sec02_rls.sql` con el SQL exacto del up. → Archivo #1 → Exemplar 2
- [ ] **W0.2**: Crear `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` con el SQL exacto del down. → Archivo #2 → Exemplar 3
- [ ] **W0.3**: `npm run migrate:preflight supabase/migrations/20260607000000_wkh_sec02_rls.sql` → debe dar **PASS** (ENABLE no es HIGH). El down NO se corre por preflight.

### Wave 1 (Verificación — tras W0)
- [ ] **W1.1**: Crear `scripts/verify-rls-enabled.mjs` con `RLS_TABLES`, `buildRlsQuery`, `evaluateRlsRows`, `main(deps)` y CLI-guard. → Archivo #3 → Exemplar 1 + Exemplar 4
- [ ] **W1.2**: Crear `test/verify-rls-enabled.test.ts` (mock): casos de `evaluateRlsRows` + test estructural del up/down. → Archivo #4 → Exemplar 4

### Wave 2 (Verificación local)
- [ ] **W2.1**: `npm run format` (ANTES de lint).
- [ ] **W2.2**: `npm run lint` + `tsc` → 0 errores (el `.mjs` no rompe `tsc`; el `.ts` del test sí typechequea).
- [ ] **W2.3**: `npm run test` → suite verde, sin red ni BD real.

### Wave 3 (Deploy — manual, fuera de `vitest`, NO bloquea la HU como código)
> Estos pasos los corre el operador en el runbook; el Dev los documenta, no los ejecuta como parte del CR salvo que se le pida.
- [ ] **W3.1**: Aplicar UP en dev (`<supabase-dev-ref>`) via Management API.
- [ ] **W3.2**: `node scripts/verify-rls-enabled.mjs <supabase-dev-ref>` → 7/7 true (exit 0).
- [ ] **W3.3**: Smoke E2E del servicio en dev → ops `service_role` idénticas (AC-3/AC-5).
- [ ] **W3.4**: Re-aplicar UP en dev → sin error (idempotencia, AC-6).
- [ ] **W3.5**: Aplicar UP en prod (`<supabase-prod-ref>`) + verify + smoke.
- [ ] **Rollback si hace falta**: aplicar el down via Management API (NO via preflight, DT-6) → `DISABLE x7` → re-verify (7/7 false).

### Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W0 | `migrate:preflight` del up = PASS; SQL del up/down con las 7 líneas correctas |
| W1 | archivos creados; exports presentes |
| W2 | `format` + `lint` + `tsc` 0 + `npm run test` verde |
| W3 | (manual/ops) verify 7/7 true en dev → smoke → idempotencia → prod |

---

## Done Definition

- [ ] Los 3 archivos de código creados: up `.sql`, down `.sql`, `scripts/verify-rls-enabled.mjs`.
- [ ] El up tiene exactamente 7 `ENABLE ROW LEVEL SECURITY` (las 7 tablas), sin `FORCE`, sin `CREATE POLICY`, dentro de `BEGIN/COMMIT`.
- [ ] El down tiene exactamente 7 `DISABLE ROW LEVEL SECURITY` (las 7 tablas), dentro de `BEGIN/COMMIT`.
- [ ] `verify-rls-enabled.mjs` consulta `pg_class.relrowsecurity` de las 7 tablas via Management API, ref parametrizable (arg/env), exit 0 sólo si las 7 son true.
- [ ] `test/verify-rls-enabled.test.ts` cubre los casos del Test Plan, 100% mock.
- [ ] `migrate:preflight` del up = PASS.
- [ ] `npm run format` corrido **antes** de `npm run lint`.
- [ ] `tsc` 0 errores, `lint` limpio, `npm run test` verde.
- [ ] NO se tocó `src/`, ni `increment_a2a_key_spend`, ni ninguna tabla fuera de las 7.

---

## Out of Scope

> Lo que Dev NO debe tocar bajo ninguna circunstancia.

- (B) `increment_a2a_key_spend` y sus callers → WKH-SEC-02b.
- RLS en `registries`, `a2a_events`, `a2a_protocol_fees`, `tasks`/`a2a_tasks`, `kite_schema_transforms`, `a2a_signed_auth_nonces`.
- Cualquier `CREATE POLICY` / lógica de user claims (`auth.uid()`).
- `src/lib/supabase.ts`, `src/services/*.ts`, cualquier archivo `src/`.
- Cambios al analizador `scripts/migrate-preflight.mjs` (su HIGH sobre DISABLE es correcto).
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y pregunta a Architect.**
> No inventar. No asumir. No improvisar.

Situaciones de escalation:
- Una de las 7 tablas NO existe o no tiene `owner_ref` en la BD destino → PARAR (CD-8).
- El timestamp `20260607000000` resulta ocupado → PARAR.
- `migrate:preflight` flaggea el **up** como HIGH (no debería) → PARAR.
- Un exemplar referenciado ya no existe.
- Aparece ambigüedad en un AC o un import necesario no está disponible.

---

*Story File generado por NexusAgil — F2.5 — Architect*
