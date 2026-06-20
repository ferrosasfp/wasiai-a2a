# Adversarial Review (AR) — WKH-125 KEY-CONSTRAINTS

> Branch: `feat/114-wkh-125-constraints` (working tree; aún SIN commit — HEAD == origin/main)
> Reviewer: nexus-adversary | Fecha: 2026-06-19
> Input: story-file.md + auto-blindaje.md + working-tree diff + checklist AR
> Build: `npx tsc --noEmit` → 0 errores. `npm test` → **1548 passed | 3 skipped** (esperado ✓).

## VEREDICTO: RECHAZADO (2 BLOQUEANTEs activos)

Dos hallazgos bloqueantes en la **ruta de dinero**:
- **BLQ-ALTO-1** — bypass del cap por mismatch de derivación de destino (step-0 usa el body; per-step usa el agente resuelto).
- **BLQ-MED-1** — el `CREATE OR REPLACE` de `debit_session_and_parent` con +1 param crea un OVERLOAD (no reemplaza); el 5-arg viejo persiste → ambigüedad "function is not unique" para cualquier caller de 5 args (incluye el e2e de atomicidad WKH-121).

La atomicidad del RPC nuevo (CD-1/AC-4), el ownership (CD-3), la back-compat del path sin destino (CD-5), `increment_a2a_key_spend` intacto (CD-2) y los endpoints están **correctos**.

---

## Findings ordenados por prioridad de fix-pack

### BLQ-ALTO-1 — Cap bypass: el destino del step-0 se deriva del BODY, no del agente resuelto
- **Categoría**: Data Integrity / Security (cap evasión en ruta de dinero)
- **Evidencia**:
  - `src/routes/compose.ts:96` y `:106` — `request.composeDestination = deriveComposeDestination(firstStep.agent, firstStep.registry)` usa los valores **crudos del body** del caller (`firstStep.agent` = slug tipeado por el caller; `firstStep.registry` **opcional**, ver `src/types/index.ts:233-234`).
  - `src/services/compose.ts:166` — el per-step usa `normalizeDestination(\`${agent.registry}/${agent.slug}\`)` donde `agent` viene de `resolveAgent` (`compose.ts:343-370` → discovery canónico).
  - `src/services/compose.ts:132` — el step-0 NO se debita per-step (guard `i > 0`): en un compose de **1 step** el ÚNICO débito es el del middleware (`a2a-key.ts:795`), keyeado por el destino del body.
- **Reproducción**:
  1. Owner setea policy: `PUT /auth/keys/me/spend-policies { destination:"wasiai/myagent", max_usd:"1", window_type:"total" }`. El service normaliza/persiste `destination="wasiai/myagent"`.
  2. Caller (key holder) compone 1 step OMITIENDO registry: `POST /compose { steps:[{ agent:"myagent", input:{} }] }`.
  3. `resolveComposePriceHandler` deriva `composeDestination = "myagent"` (slug solo, sin registry).
  4. Middleware step-0 llama `debit_with_dest_policy(..., p_destination="myagent")`.
  5. En el RPC, `SELECT ... WHERE destination = "myagent"` NO matchea la policy (`"wasiai/myagent"`) → `v_has_policy=false` → degrada a `increment_a2a_key_spend` → **0 ledger inserts, cap NUNCA evaluado**.
  - Output esperado: 402 `DEST_CAP_EXCEEDED` al exceder $1. Output real: débito ilimitado al destino.
- **Impacto**: el cap por destino — el value-prop central de la HU ("no gastar más de $X con vendor Y", cierre del gap Kite Passport, AC-2/AC-3) — se evade trivialmente omitiendo `registry` en el body, o si el slug/registry del body difiere de la forma canónica del registry. Afecta el caso single-step (el más común) de forma total. Es una integridad-de-gasto rota en la ruta de dinero.
- **Sugerencia (NO implementar acá)**: derivar el destino del step-0 de forma CONSISTENTE con el per-step — resolver el agente (mismo `resolveAgent`/discovery) en `resolveComposePriceHandler` y augmentar `composeDestination` con `\`${resolved.registry}/${resolved.slug}\`` normalizado, NO con los crudos del body. `resolveComposePriceHandler` ya hace `resolveAgentPriceUsdc(firstStep.agent, firstStep.registry)` (`compose.ts:68`) que internamente llama `discoveryService.getAgent` — exponer registry/slug canónicos desde esa resolución y usarlos para el destino. Alternativa: rechazar compose si el destino del body no resuelve a una forma canónica conocida.

### BLQ-MED-1 — `CREATE OR REPLACE debit_session_and_parent` con +1 param crea OVERLOAD, no reemplaza → ambigüedad de función
- **Categoría**: Destructive/Schema Migrations + Integration (back-compat WKH-121)
- **Evidencia**:
  - Migración nueva `supabase/migrations/20260606000000_a2a_key_spend_policies.sql:149-155` — `CREATE OR REPLACE FUNCTION debit_session_and_parent(... 6 params, p_destination TEXT DEFAULT NULL)`.
  - La función ORIGINAL de 5 params vive en `supabase/migrations/20260603000000_a2a_key_sessions.sql:28` con firma `(uuid, text, uuid, integer, numeric)`.
  - La UP migration **NO** dropea la versión de 5 params. En Postgres `CREATE OR REPLACE FUNCTION` reemplaza SOLO cuando los tipos de argumento de entrada coinciden exactamente; agregar un parámetro produce una **nueva sobrecarga** y la de 5 params **persiste**.
  - Tras la migración coexisten DOS overloads: `(uuid,text,uuid,integer,numeric)` y `(uuid,text,uuid,integer,numeric,text DEFAULT NULL)`.
- **Reproducción**:
  - Caller que invoca el RPC con **5 args nombrados** (sin `p_destination`): Postgres encuentra dos candidatos (el 5-arg exacto y el 6-arg vía DEFAULT) y no puede elegir → `ERROR: function debit_session_and_parent(uuid, text, uuid, integer, numeric) is not unique` (cannot choose best candidate function).
  - Hoy en `src/`: `src/services/key-session.ts:448-455` **siempre** pasa `p_destination: destination ?? null` (6 args) → resuelve a la sobrecarga de 6 → producción de la app NO rompe.
  - PERO el e2e de atomicidad WKH-121 `src/__tests__/e2e/key-session-atomicity.real.test.ts:93-99` llama con **5 args** (sin `p_destination`). Cuando corre contra Postgres real (`INTEGRATION_TEST_DB_URL` seteado, CI de integración) tras esta migración → falla con "function is not unique" en vez de validar el no-double-spend. Regresión de la verificación de atomicidad de WKH-121 + ambigüedad latente para cualquier caller externo de 5 args.
- **Impacto**: schema con sobrecarga duplicada en prod; cualquier llamada de 5 args (futuros callers, scripts ops, el e2e de atomicidad) rompe con ambigüedad. La firma TS "intacta por DEFAULT" (CD-4) NO se cumple a nivel SQL: la firma vieja sigue existiendo y colisiona.
- **Sugerencia (NO implementar acá)**: en la UP migration, antes del `CREATE OR REPLACE` de 6 params, agregar `DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric);` para eliminar la sobrecarga vieja, dejando UNA sola función de 6 params. (El down ya dropea la de 6 y restaura la de 5 — correcto; solo falta el DROP simétrico en el UP.)

---

## 8 Categorías AR

### 1. Security — OK
- Endpoints `PUT/GET/DELETE /auth/keys/me/spend-policies` (`auth.ts:1301-1414`): gate sub-session prohibida como authenticator (`KEY_SESSION_TOKEN_PREFIX` → 403), gate `!is_active` → 403, ownership en el service vía `callerKey.owner_ref`/`callerKey.id` (no del input). DELETE cross-owner → 404 disclosure-safe.
- Sin secrets en código; sin SQL dinámico (`EXECUTE format`) → sin SQLi. Input validado en `parseSpendPolicyInput` (`auth.ts:353-399`) + `MAX_USD_RE` en el service.
- (El cap-bypass está clasificado como Data Integrity en BLQ-ALTO-1, no como inyección.)

### 2. Error Handling — OK
- Mapeo por prefijo en `budget.ts:260-287`, `key-session.ts:457-500`, endpoints `auth.ts:1323-1339/1398-1416`. **NUNCA** se propaga `error.message` crudo de PG al cliente (CD-B): fallbacks a codes estables `DEST_POLICY_DEBIT_FAILED`/`SESSION_DEBIT_FAILED`/`SPEND_POLICY_SET_FAILED`, detalle solo a log server. RPC fail → ROLLBACK total (ledger no se inserta).

### 3. Data Integrity — BLOQUEANTE (ver BLQ-ALTO-1)
- **Atomicidad/race (CD-1/AC-4): CORRECTO.** PoC concurrente (cap=1, 2×amount=1): ambas tx hacen `SELECT owner_ref FROM a2a_agent_keys ... FOR UPDATE` (`migration:72-75`) ANTES de leer el ledger → serializan en el lock de la KEY. Tx A: SUM=0, pasa, INSERT ledger, commit. Tx B desbloquea, re-SUM=1, 1+1>1 → `DEST_CAP_EXCEEDED` → rollback. Exactamente 1 pasa. El `FOR UPDATE` de la policy (`:91`) es serialización redundante-pero-segura. Sin ventana TOCTOU (el lock de la key precede al SUM). Orden de locks consistente key→policy (y session→key en el RPC de sesión) → sin deadlock.
- Ventana rolling (AC-3): `debited_at >= now() - (v_pol_wsecs * interval '1 second')` (`:104`) — signo correcto, `COALESCE(SUM,0)` para vacío, débitos fuera de ventana excluidos. Sin off-by-one relevante.
- **BLQ-ALTO-1**: mismatch de derivación step-0(body) vs per-step(resuelto) rompe la integridad del acumulado por destino.
- **Nota (no-finding, out-of-scope documentado)**: la rama delegación de `debit()` (`budget.ts:154-167`) NO propaga `destination` a `debitDelegationAndParent` → bajo delegationContext el cap por destino no se aplica. Está explícitamente fuera de scope ("Extender políticas a delegaciones EIP-712", story Out of Scope) → MENOR/documentado, no bloquea.

### 4. Performance — OK
- Índice hot-path `idx_a2a_key_dest_spend_ledger_key_dest_at (key_id, destination, debited_at)` cubre el SUM por ventana. Sin N+1. El `SELECT owner_ref` cold-path de `budget.ts:242` es 1 query extra SOLO cuando hay destino (aceptable, documentado). Sin loops nuevos en hot-path; back-compat sin destino byte-idéntico.

### 5. Integration — BLOQUEANTE (ver BLQ-MED-1)
- `increment_a2a_key_spend` SIN diff (CD-2 ✓, `git status` limpio sobre `20260406000000_*.sql`); reusado vía `PERFORM`.
- `ComposeResult.errorCode` extendido aditivamente a `'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED'` (`index.ts:295`) — escalación documentada en auto-blindaje, no rompe consumidores. APROBADO.
- **BLQ-MED-1**: overload SQL duplicado rompe back-compat de callers de 5 args.

### 6. Type Safety — OK
- `npx tsc --noEmit` → 0. Sin `any`/`as unknown` en el código nuevo. Casts acotados a `Pick<...>`/`SpendPolicyRow` sobre data de Supabase (patrón del repo). Tipos `SpendPolicy*` completos.

### 7. Test Coverage — OK
- Aridad CD-8 correcta: aserciones de 6 args en `compose.test.ts:1115-1122` etc. (6º arg = `'<registry>/<slug>'` resuelto); 3-arg de a2a-key/gasless intactas. Suite 1548 verde.
- Cubre CRUD+ownership+window+concurrencia estructural (`spend-policy.test.ts`), back-compat/dest-aware (`budget.test.ts`), endpoints (`auth.spend-policies.test.ts`).
- **Gap señalado, no nuevo finding**: los tests unitarios mockean Supabase → NO habrían detectado ni el mismatch de destino (BLQ-ALTO-1, asserta el string que el propio test arma) ni el overload SQL (BLQ-MED-1, solo emerge contra PG real). Son límites de mocks, no debilidad de asserts.

### 8. Scope Drift — OK
- Todos los archivos modificados ∈ Scope IN. `orchestrate.ts` intacto (✓). `src/types/index.ts` es el único agregado fuera de "Files to Modify" y está justificado/documentado en auto-blindaje (extensión aditiva del union). No hay refactors no solicitados.

## Categorías nuevas (9-11)
- **9. Destructive Migrations — BLOQUEANTE (BLQ-MED-1).** Migración aditiva (CREATE TABLE IF NOT EXISTS, índices), reversible (down restaura 5-arg + dropea tablas/RPC). PERO el `CREATE OR REPLACE` con firma cambiada deja una sobrecarga huérfana (no destructivo de data, sí corruptor de la resolución de función). Severidad BLQ-MED (reversible, fix de 1 línea).
- **10. RPC SECURITY DEFINER — OK.** `debit_with_dest_policy` y `debit_session_and_parent` (6-arg): ambos `SET search_path = public, pg_temp` (`:134`, `:217`), `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`, `GRANT ... TO service_role`. Ownership validado internamente (`v_key_owner IS DISTINCT FROM p_owner_ref`). Sin SQL dinámico. Hardening completo.
- **11. Cache Invalidation — N/A.** El cache de `agent-price.ts` es pre-existente (WKH-59), no introducido por esta HU; no cachea políticas ni saldos. Las policies/ledger se leen siempre fresh bajo lock. Sin capa de cache nueva.

---

## Resumen para el orquestador
- **Veredicto: RECHAZADO.** 2 BLOQUEANTEs en ruta de dinero.
- Fix-pack ordenado: (1) **BLQ-ALTO-1** derivar destino step-0 del agente resuelto (consistente con per-step) — sin esto el cap se evade; (2) **BLQ-MED-1** `DROP FUNCTION IF EXISTS debit_session_and_parent(uuid,text,uuid,integer,numeric);` en el UP antes del CREATE de 6-arg.
- Atomicidad, ownership, back-compat, hardening RPC, endpoints y `increment_a2a_key_spend` intacto: correctos.
- Re-lanzar nexus-dev con estos 2 findings. NO avanzar a F4.

---

## RE-AR (fix-pack verification) — 2026-06-19 21:14

> Reviewer: nexus-adversary | Input: ar-report.md (2 BLQ previos) + auto-blindaje.md (fix-pack) + working-tree diff + checklist AR
> Build: `npx tsc --noEmit` → 0 errores. `npm test` → **1554 passed | 3 skipped** (1548 → 1554: +6 tests del fix-pack, sin fallos, sin regresión).

### VEREDICTO RE-AR: APROBADO

Ambos BLOQUEANTEs **CERRADOS** con evidencia. Sin hallazgos nuevos. Sin regresión.

### BLQ-ALTO-1 (cap bypass por derivación de destino) — CERRADO

- **Fix verificado**:
  - Nuevo `resolveAgentDestination(slug, registry)` en `src/services/agent-price.ts:83-93`: resuelve vía `discoveryService.getAgent(slug, registry)` con fallback `getAgent(slug)` (`:89-90`) — **MISMO orden** que `compose.resolveAgent` (`src/services/compose.ts:345-346`). Devuelve `{registry: agent.registry, slug: agent.slug}` canónicos de discovery, NO del body.
  - `src/routes/compose.ts:92-98`: `composeDestination` se deriva de `resolveAgentDestination(...)` (agente resuelto) vía `deriveComposeDestination` (`:29-38` → `normalizeDestination(\`${resolved.registry}/${resolved.slug}\`)`), NO de `firstStep.agent`/`firstStep.registry` crudos. Se setea en `request.composeDestination` en `:114` y `:121`.
  - **Canónico idéntico step-0 vs per-step**: step-0 keyea `normalizeDestination(\`${resolved.registry}/${resolved.slug}\`)` (`compose.ts:34`); per-step keyea `normalizeDestination(\`${agent.registry}/${agent.slug}\`)` (`services/compose.ts:166`). Ambos toman `registry`=`registry.name` (server-controlled, `discovery.ts:493`) y `slug` del MISMO mapping (`discovery.ts:470/478`). Mismo normalizador `trim().toLowerCase()` (`spend-policy.ts:51`) en set-policy (`:111`), step-0 y per-step → coinciden byte a byte.
- **Repro del bypass original — ahora bloqueado**: caller compone `{steps:[{agent:"myagent"}]}` SIN registry, policy en `"wasiai/myagent"`. Discovery resuelve `registry="wasiai"` (canónico, no del body) → step-0 keyea `"wasiai/myagent"` → `v_has_policy=true` → el cap SE evalúa. Reproducido en `src/routes/compose.test.ts:298-321` (T-ROUTE-PRICE-DEST-1): body omite registry, asserta `composeDestination === 'wasiai/myagent'` (canónico), NO `'myagent'` (crudo). PASS.
- **Vectores de bypass adicionales revisados — TODOS cerrados**:
  - *Registry omitido / case / espacios*: colapsan por `normalizeDestination` consistente en los 3 sitios + resolución canónica. Sin divergencia.
  - *Agente no resuelve → silent-degrade*: NO explotable. `resolveAgentPriceUsdc` (`agent-price.ts:53`) usa SOLO `getAgent(slug, registry)` (una vez). Si retorna null → el route hace **404 AGENT_NOT_FOUND** (`compose.ts:79-86`) ANTES de resolver destino → no hay débito. `resolveAgentDestination` corre solo cuando price≠null, y al usar los MISMOS args (+ un fallback adicional) es estrictamente MÁS propenso a resolver. Imposible un débito con policy presente y `composeDestination` undefined. La rama `resolved ? ... : undefined` (`compose.ts:96-98`) es defensiva (dead-code en práctica), inocua.
  - *Divergencia resolveAgent vs resolveAgentDestination*: `resolveAgent` (per-step) tiene un 3er fallback (`discover({limit:50})`, `services/compose.ts:355-356`) que `resolveAgentDestination` no replica. Irrelevante para el bypass: en single-step solo cuenta step-0 (guard `i>0`, `services/compose.ts:132`); y `getAgent` y `discover` mapean `registry`/`slug` por el MISMO `mapAgent` (`discovery.ts:467-503`) → mismo canónico. Si `getAgent` falla, price ya hizo 404.
- **Tests nuevos**: `agent-price.test.ts` T-DEST-1..4 (`:169-212`: canónico, omisión de registry, fallback sin hint, null si no resuelve) + `compose.test.ts` T-ROUTE-PRICE-DEST-1/2 (`:298-338`). El T-ROUTE-PRICE-DEST-1 reproduce el bypass real (omite registry) y verifica el canónico. Asserts concretos, no vagos.

### BLQ-MED-1 (overload del RPC) — CERRADO

- **Fix verificado**:
  - `supabase/migrations/20260606000000_a2a_key_spend_policies.sql:157`: `DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric);` ANTES del `CREATE OR REPLACE` de 6 params (`:159`).
  - **Firma del DROP matchea EXACTO** la de 5 params de `20260603000000_a2a_key_sessions.sql:28-33` `(UUID, TEXT, UUID, INT, NUMERIC)`: en Postgres `INT`≡`INTEGER` (alias) y los nombres de tipo son case-insensitive → `(uuid, text, uuid, integer, numeric)` ≡ `(UUID, TEXT, UUID, INT, NUMERIC)`.
  - Tras la migración queda **UNA sola** función (6 params). Una llamada de 5 args resuelve sin ambigüedad a la de 6 vía `p_destination TEXT DEFAULT NULL` (`:165`). El e2e `key-session-atomicity.real.test.ts:93` (5 args) ya no rompe con "is not unique".
  - App no afectada: `key-session.ts:448-454` siempre pasa 6 args (`p_destination: destination ?? null`).
- **`_down.sql` sigue reversible y consistente**: dropea la de 6 (`_down.sql:6` `(uuid,text,uuid,integer,numeric,text)`) y restaura la de 5 vía `CREATE OR REPLACE` + hardening (search_path/REVOKE/GRANT, `:9-60`). El nuevo DROP en el UP no introduce inconsistencia: down→up→down deja el schema estable. Símetría correcta.

### Re-confirmación de lo que ya estaba OK (sin regresión)
- **Atomicidad RPC (CD-1/AC-4)**: lock key `FOR UPDATE` → ownership → lock policy → SUM ledger en ventana → check cap → PERFORM increment → INSERT ledger, todo en 1 tx (`migration:70-...`). Sin cambios respecto del AR previo. OK.
- **Ownership (CD-3)**: `debit_with_dest_policy`/`debit_session_and_parent` validan `owner_ref` internamente; endpoints toman owner de `callerKey`. OK.
- **Back-compat sin políticas (CD-5)**: sin policy → solo PERFORM + 0 ledger inserts → byte-idéntico a hoy. OK.
- **`increment_a2a_key_spend` intacto (CD-2)**: NO en el working-tree diff. OK.
- **Scope del fix-pack**: tocó SOLO `agent-price.ts` (+resolver), `routes/compose.ts` (deriva del resuelto), la migración (DROP) y los tests (`agent-price.test.ts`, `compose.test.ts`). `orchestrate.ts` NO modificado. `increment_a2a_key_spend` NO tocado. WKH-121..124 (commits del branch) no alterados por el fix. Sin scope drift.
- **RPC SECURITY DEFINER (cat. 10)**: `SET search_path = public, pg_temp` + REVOKE/GRANT presentes en la firma nueva de 6 params (`:227-231`). OK.

### Resumen para el orquestador
- **Veredicto RE-AR: APROBADO.** Ambos BLOQUEANTEs (BLQ-ALTO-1, BLQ-MED-1) CERRADOS con evidencia archivo:línea + repro. Sin hallazgos nuevos, sin regresión.
- Suite: 1554 passed | 3 skipped (+6 tests del fix-pack). tsc 0 errores.
- Fix mínimo y correcto: derivación canónica del destino step-0 + DROP de la firma vieja de 5 params. Nada fuera de lo necesario.
- **Avanzar a CR / F4.** No re-lanzar al Dev.
