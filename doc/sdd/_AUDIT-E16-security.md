# AUDITORÍA DE SEGURIDAD HOLÍSTICA CROSS-HU — Épica E16 + minors

**Fecha**: 2026-06-20
**Auditor**: nexus-adversary (modo auditoría cross-HU)
**Alcance**: WKH-121/122/123/124/125/118/SEC-02 ya en `main` (branch `feat/116-wkh-sec-02-rls` mergeado).
**Tests**: `npm test` → **1579 passed | 3 skipped** (98 files pass | 2 skip). Baseline esperado OK.
**Objetivo**: vulnerabilidades de INTERACCIÓN entre HUs que los AR individuales no vieron.

---

## Resumen ejecutivo

Cada HU pasó su AR individual. Esta auditoría buscó huecos que SOLO emergen al combinar features.
Se encontró **1 BLOQUEANTE-MEDIO real y explotable**: una interacción WKH-121 (session keys) × WKH-125
(dest spend cap) donde el cap por destino **NO se aplica en el step-0 de `/compose` cuando el caller
autentica con una session key** — exactamente el mismo bypass que WKH-125 BLQ-ALTO-1 corrigió para
master keys, pero que quedó vivo para el branch de sesión (y el de delegación). El resto de los
vectores investigados resultaron **defensa-en-profundidad faltante (no explotable)** o **scope
documentado**, no findings.

**Falsos positivos descartados con PoC** (no inflo el reporte):
- Fee-evasion vía `request-id` header (item 7): **NO explotable**. Fastify 5.8.5 con
  `Fastify({ logger, genReqId })` IGNORA el header inbound `request-id`/`x-request-id` (el default
  `requestIdHeader` es `false` en v5). PoC ejecutado: `req.id` siempre es el UUID server-generado.
  El key de idempotencia del fee NO es controlable por el cliente. Descartado.
- Deadlock cross-RPC (item 5): **NO existe**. El orden de locks es consistente hacia
  `a2a_agent_keys` (ver mapa abajo). Descartado.

---

## Mapa de orden de locks (item 4/5 — deadlock analysis)

| RPC | Orden de adquisición de locks (dentro de 1 tx) |
|-----|-----------------------------------------------|
| `increment_a2a_key_spend` | `a2a_agent_keys`(row) |
| `debit_delegation_and_parent` | `a2a_delegations` → `a2a_agent_keys` |
| `debit_session_and_parent` (6-arg) | `a2a_key_sessions` → [`a2a_agent_keys` → `a2a_key_spend_policies`] |
| `debit_with_dest_policy` | `a2a_agent_keys` → `a2a_key_spend_policies` → INSERT `a2a_key_dest_spend_ledger` |
| `insert_receipt` | `pg_advisory_xact_lock(owner)` → INSERT `a2a_receipts` |

**Veredicto deadlock**: NO hay ciclo de espera.
- Todos los paths de débito convergen hacia `agent_keys` → `spend_policies` → `ledger` en el MISMO orden.
- Los "primer-lock" disjuntos (`a2a_delegations` vs `a2a_key_sessions`) nunca coexisten en un mismo
  request (un request es master XOR delegation XOR session). Dos requests distintos sobre la misma
  `agent_key` lockean recursos-raíz distintos (D vs S) y luego ambos esperan K → sin ciclo.
- `insert_receipt` corre en una **transacción separada** (es fire-and-forget DESPUÉS de que el RPC de
  débito retornó), así que su advisory lock NO se solapa con los `FOR UPDATE` del débito. Sin deadlock
  receipts↔débito.

---

## Tabla de hallazgos

| ID | Sev | HUs | Categoría | Evidencia | Explotable |
|----|-----|-----|-----------|-----------|------------|
| BLQ-MED-1 | BLOQUEANTE-MEDIO | 121 × 125 | Data Integrity / Auth bypass | `src/middleware/a2a-key.ts:578` (session branch NO pasa `request.composeDestination`) vs `:795` (master SÍ) | **SÍ** |
| MNR-1 | MENOR | 101 × 125 | Data Integrity | `src/services/budget.ts:154-230` ruta delegación ignora `destination`; `debit_delegation_and_parent` sin dest cap | Sí, pero scope documentado en WKH-125 |
| MNR-2 | MENOR | 124 × SEC-02 | Data Integrity | `20260605000000_a2a_receipts.sql` — "append-only/inmutable" sin trigger DB; service_role puede UPDATE/DELETE | No vía HTTP (tamper-evidente por HMAC) |
| MNR-3 | MENOR | 123 × 101 | Security (defense gap) | `src/middleware/a2a-key.ts:296-494` delegation branch nunca chequea `require_signature` | No (scope documentado WKH-123 AC-8) |
| OK-1 | OK | 122 × 123 × débito | Auth ordering | revoked→expires→signature→debit + re-check bajo lock (`a2a-key.ts:513-564`, RPC `:195-200`) | — |
| OK-2 | OK | 123 | Anti-replay | nonce DESPUÉS de firma válida (`signed-auth.ts:303-311`); UNIQUE(token_hash,nonce) 23505 serializa | — |
| OK-3 | OK | 124 | Receipt forge | `receipt_hash=HMAC(secret server-only)`; cadena `prev_hash` lineal bajo advisory lock | — |
| OK-4 | OK | SEC-02 | RLS vs parte B diferida | service_role bypassa; owner siempre = caller autenticado en todo call-site de `increment_a2a_key_spend` | — |
| OK-5 | OK | 118 | Fee idempotencia | key = server-UUID (PoC: header inbound ignorado); compose y orchestrate no colisionan | — |
| OK-6 | OK | 4-branch mw | Routing | prefijos `wasi_a2a_session_` / `wasi_a2a_sess_` mutuamente no-prefijo (verificado en node) | — |
| OK-7 | OK | 121/122/123/124/125 | IDOR / Ownership Guard | endpoints toman owner de `callerKey`; services filtran `.eq('owner_ref',...)`; lookups por token-hash son self-auth | — |

---

## BLQ-MED-1 — El cap por destino (WKH-125) NO se aplica en el step-0 de /compose con session keys (WKH-121)

**Categoría**: Data Integrity / Spend-cap bypass (interacción 121 × 125).
**HUs involucradas**: WKH-121 (session keys) + WKH-125 (dest spend cap) + WKH-122 (no relevante).

### Qué está mal
WKH-125 BLQ-ALTO-1 (su propio fix-pack) garantizó que el step-0 de `/compose` keyea el cap por
destino con el agente RESUELTO por discovery — **pero SOLO en el branch master** del middleware.

- **Branch master** (`src/middleware/a2a-key.ts:795-804`): lee `request.composeDestination` y lo pasa
  como 6º arg a `budgetService.debit(...)` → `debit_with_dest_policy` → **el cap SE evalúa y el ledger
  SE inserta**.
- **Branch session** (`src/middleware/a2a-key.ts:577-584`): llama
  `keySessionService.debitSessionAndParent(session.id, owner, key, chainId, estimatedCostUsd)` con
  **5 args — NUNCA pasa `request.composeDestination`**. Con `p_destination = NULL`, el RPC
  `debit_session_and_parent` (migración `20260606000000:213-217`) toma la rama `ELSE` →
  `increment_a2a_key_spend` directo → **el cap NO se evalúa y NO se inserta nada en el ledger**.
- El branch session NUNCA referencia `composeDestination` (grep: la var solo aparece en el branch
  master, `a2a-key.ts:61,791,795,802`).

El step-0 es el ÚNICO débito en un compose de **1 step** (guard `i > 0` en
`src/services/compose.ts:132` salta el per-step). Por eso un single-step compose vía session key
**escapa por completo el cap por destino de la parent key** — rompiendo WKH-125 AC-6 ("la sesión
hereda el cap por destino de la parent key") justo en el path más común.

### Reproducción (PoC mental)
1. Owner crea master key K con budget. Setea policy:
   `PUT /auth/keys/me/spend-policies { destination:"wasiai/agentx", max_usd:"5", window_type:"total" }`.
2. Owner crea session key S sobre K: `POST /auth/key-session { ttl_seconds:3600, max_budget_usd:"100" }`.
   (S hereda el cap por destino de K — AC-6.)
3. Caller envía, con `Authorization: Bearer wasi_a2a_sess_<S>`, un compose de 1 step:
   `POST /compose { steps:[{ agent:"agentx" }] }`, repetido N veces por $1 c/u (>$5 acumulado).
4. **Esperado (AC-6)**: el 6º request a "wasiai/agentx" debe dar **402 DEST_CAP_EXCEEDED** (cap $5).
5. **Real**: el step-0 debita vía `increment_a2a_key_spend` (sin destino) → el cap NUNCA se chequea
   → **todas las llamadas pasan** mientras quede `max_budget_usd` de la sesión. Además el
   `a2a_key_dest_spend_ledger` no registra estos débitos → el acumulado por destino queda
   sub-contado incluso para futuros débitos master/per-step.

### Impacto
- WKH-125 AC-6 roto en el step-0 para session keys: el control de gasto por destino (la feature
  central de WKH-125) es evadible con una session key, que el owner crea para DELEGAR gasto acotado.
- Corrupción del ledger acumulado: los débitos step-0 de sesión no se registran, así que el cap por
  destino de la parent key también se sub-cuenta en cálculos posteriores (rolling/total).
- Es el MISMO bypass que WKH-125 marcó BLQ-ALTO-1 y "arregló" — pero el fix solo cubrió el master.

### Severidad: BLOQUEANTE-MEDIO
Rompe un AC de seguridad (spend cap) por un path común (single-step compose), PERO: requiere una
session key (que crea el propio owner), el `max_budget_usd` de la sesión sigue acotando el gasto
total, y los composes multi-step SÍ aplican el cap en steps 2..N (`services/compose.ts:160-167` pasa
destination con `keySessionContext`). No es ALTO (no es budget-drain ilimitado ni cross-tenant), pero
bloquea: es una vulnerabilidad de bypass de un control de gasto, no un edge case raro.

### Sugerencia (NO implementar — el Dev corrige)
En el branch session del middleware, pasar `request.composeDestination` al débito step-0, igual que el
master: `keySessionService.debitSessionAndParent(session.id, owner, key, chainId, cost,
request.composeDestination)`. La firma del service y del RPC de 6-arg YA aceptan `destination`
(`key-session.ts:446`, `debit_session_and_parent` 6-arg `p_destination`). Idealmente espejar también el
branch delegación (ver MNR-1). Agregar un test e2e: single-step compose vía session key con policy
activa → 402 al exceder el cap.

---

## MNR-1 — Delegación (WKH-101) no propaga el cap por destino (WKH-125)

**Categoría**: Data Integrity. **HUs**: 101 × 125.
`src/services/budget.ts:154-230` (ruta `delegationContext`) llama `debitDelegationAndParent(...)` que
**ignora** el arg `destination`; `debit_delegation_and_parent` (`20260601000000`) no tiene parámetro de
destino ni consulta `a2a_key_spend_policies`. Un compose vía delegación gasta contra el budget de la
parent key **sin** aplicar el cap por destino.

**Por qué MENOR y no BLQ**: WKH-125 documentó explícitamente que delegation NO propaga destino (scope
conocido), y la delegación tiene sus propios caps (`max_total_amount`, `max_amount_per_tx`). Es una
defensa faltante documentada, no un bypass de un AC declarado para delegación. Se recomienda elevarlo a
HU de backlog si el producto espera que el dest cap sea un control transversal a TODOS los paths de
débito (hoy NO lo es: solo master y session-per-step lo aplican; master step-0 sí, session step-0 no
[BLQ-MED-1], delegación nunca).

---

## MNR-2 — Receipts "append-only/inmutable" sin enforcement a nivel DB (WKH-124 × SEC-02)

**Categoría**: Data Integrity. **HUs**: 124 × SEC-02.
La migración `20260605000000_a2a_receipts.sql` declara la tabla "inmutable (append-only)" pero NO crea
trigger ni constraint que bloquee `UPDATE`/`DELETE`. El `UPDATE-once` del `receipt_hash`
(`receipt.ts:174-178`, `.eq('receipt_hash','')`) es una convención app-layer. Con RLS habilitada
(SEC-02) la tabla sigue siendo escribible por `service_role` (que la app usa siempre).

**Por qué MENOR y no BLQ**: NO hay endpoint HTTP que permita a un caller UPDATE/DELETE un recibo. La
integridad real la da la cadena HMAC (`prev_receipt_hash` + `receipt_hash = HMAC(secret server-only)`):
cualquier manipulación es **detectable** vía `receiptService.verify` (`tamper_detected:true`). Es
tamper-evidente, no tamper-proof — consistente con el diseño declarado. Defensa-en-profundidad
opcional: trigger `BEFORE UPDATE/DELETE` que rechace todo salvo el UPDATE-once de `receipt_hash=''`.

---

## MNR-3 — require_signature (WKH-123) no cubre el branch delegación (WKH-101)

**Categoría**: Security (defense gap). **HUs**: 123 × 101.
El branch delegación (`a2a-key.ts:296-494`) nunca chequea `require_signature`. Un owner que active
`require_signature=true` en su master key puede asumir que TODO débito contra esa key exige firma
per-request — pero los requests autenticados con una delegación sobre esa key la omiten.

**Por qué MENOR y no BLQ**: WKH-123 work-item AC-8 scopea EXPLÍCITAMENTE las delegaciones FUERA ("the
system SHALL ignore signature headers and NOT apply WKH-123 logic for the delegation branch"). Las
delegaciones ya se crean con prueba EIP-712 de la `funding_wallet`. Es scope documentado, no un bypass
de un requisito declarado. Nota de UX/seguridad: documentar que `require_signature` master NO cubre
delegaciones, para evitar una falsa sensación de cobertura.

---

## Verificaciones que dieron OK (con evidencia)

- **OK-1 (122×123 revocación vs firma vs débito)**: orden en session branch = revoked_at
  (`a2a-key.ts:513`) → expires (`:520`) → require_signature (`:543`) → debit (`:578`). El RPC re-chequea
  revoked/expired BAJO `FOR UPDATE` (`20260606000000:195-200`, TOCTOU-safe). Una sesión revocada con
  firma válida cacheada NO debita: el pre-check y el lock la cortan. (Edge: si se revoca entre pre-check
  y RPC, el nonce ya se consumió y el RPC hace ROLLBACK → 1 nonce quemado, DoS trivial sin impacto de
  seguridad.)
- **OK-2 (123 anti-replay vs concurrencia)**: `verifySignedAuth` registra el nonce SOLO tras
  firma+timestamp válidos (`signed-auth.ts:308`), evitando quema de nonces con firmas inválidas.
  `UNIQUE(token_hash,nonce)` + 23505 (`signed-auth.ts:218-219`) serializa atómicamente: dos requests
  concurrentes con el mismo nonce → exactamente uno pasa, el otro `NONCE_REPLAY`. Namespaces por
  `token_hash` (master vs session distintos). Sólido.
- **OK-3 (124 forge)**: `receipt_hash = HMAC(RECEIPT_SIGNING_SECRET, canonical)` con secret server-only
  (`receipt.ts:77-81`, nunca a Postgres). Cadena `prev_receipt_hash` lineal por owner bajo
  `pg_advisory_xact_lock(owner)` (`20260605000000:52`). Sin secret no se forja un hash válido. Sin
  endpoint de escritura directa. OK.
- **OK-4 (SEC-02 vs parte B diferida)**: RLS ENABLE sin policy = deny-all anon/authenticated;
  service_role bypassa por BYPASSRLS. El ownership es 100% app-layer. La parte B diferida
  (`p_owner_ref` en `increment_a2a_key_spend`) NO deja hueco explotable HOY: ese RPC solo se invoca con
  `p_key_id` = la key del caller autenticado (master: `keyRow` del lookup por token; delegation/session:
  ownership validado en el RPC wrapper antes del PERFORM). El owner es implícitamente el caller. Defensa
  adicional, no un gap real.
- **OK-5 (118 fee idempotencia)**: el key de idempotencia es `request.id` (compose) /
  `crypto.randomUUID()` (orchestrate), AMBOS server-generados. **PoC ejecutado**: Fastify 5.8.5 con
  `Fastify({logger,genReqId})` IGNORA el header inbound `request-id`/`x-request-id` (default
  `requestIdHeader:false` en v5). El cliente NO controla el key → no hay doble-cobro ni evasión vía
  header. compose y orchestrate no colisionan (UUID random, namespaces no adivinables). OK.
- **OK-6 (4-branch routing)**: verificado en node — `'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_')
  === false` y viceversa (el char tras `sess` en `session` es `i`, no `_`). Orden: delegation
  (`session_`) → session (`sess_`) → master fallback. Inequívoco.
- **OK-7 (IDOR cross-HU)**: todos los endpoints nuevos (key-session, spend-policies, receipts,
  require-signature) toman `owner_ref`/`key_id` de `callerKey` (auth.ts), nunca del body. Services
  filtran `.eq('owner_ref',...)` (`spend-policy.ts:159/186/216`, `receipt.ts:256/273`,
  `key-session.ts:302/359/394`). Los lookups sin owner gate (`lookupByTokenHash`, `getParentKey`) son
  self-auth (el caller probó posesión del token; el owner se deriva del row). Sin IDOR.

---

## Veredicto global

**HAY 1 BLOQUEANTE (MEDIO) que arreglar antes de declarar la épica segura.**

- **Arreglar YA (este ciclo)**: **BLQ-MED-1** — pasar `composeDestination` al débito step-0 en el
  branch session del middleware (1 línea + test e2e). Sin esto, el cap por destino de WKH-125 es
  evadible con una session key en el path más común (single-step compose), y el ledger acumulado se
  corrompe. Es la misma clase de bug que WKH-125 ya marcó BLQ-ALTO-1, sólo que el fix no cubrió el
  branch de sesión.

- **Backlog (no bloquean DONE)**:
  - **MNR-1**: decidir si el dest cap debe ser transversal a delegación (hoy no lo es) → posible HU.
  - **MNR-2**: trigger DB de inmutabilidad en `a2a_receipts` (defensa-en-profundidad).
  - **MNR-3**: documentar que `require_signature` master no cubre delegaciones.

Recomendación al orquestador: crear un fix-pack con **BLQ-MED-1** (idealmente cubriendo también el
branch delegación = MNR-1 en la misma línea) y re-lanzar al Dev. El resto va a backlog.

---

## FIX VERIFICATION (BLQ-MED-1) — 2026-06-20

**Estado: CERRADO ✅** — branch `fix/117-session-dest-cap` (working tree sobre HEAD `3f3556c`).
**Veredicto: APROBADO.**

Alcance del fix-pack (working tree, `git diff HEAD`): SOLO `src/middleware/a2a-key.ts`
(+41/-7) + `src/middleware/a2a-key.test.ts` (+86). `src/services/*`, `supabase/migrations/*`,
`src/routes/compose.ts` y `src/services/budget.ts` NO tocados (la firma 6-arg del service y el
RPC `debit_session_and_parent`/`debit_with_dest_policy` YA existían desde WKH-125; el bug era
puramente que el branch session del middleware nunca alimentaba el destino).

### 1. Bypass CERRADO

- `src/middleware/a2a-key.ts:592-609` — el branch session ahora es CONDICIONAL: si
  `request.composeDestination` está presente, llama `debitSessionAndParent(...)` con el **6º arg
  destino** (línea 599); si no, mantiene la llamada de **5 args** (línea 602-608, back-compat).
- Cadena RPC verificada: `debitSessionAndParent` (`src/services/key-session.ts:440-455`) envía
  `p_destination: destination ?? null` → RPC `debit_session_and_parent`
  (`supabase/migrations/20260606000000_a2a_key_spend_policies.sql:213-216`):
  `IF p_destination IS NOT NULL AND p_destination <> '' THEN PERFORM debit_with_dest_policy(...)`
  → cap evaluado y `RAISE DEST_CAP_EXCEEDED` (migration `:114`) con ROLLBACK; `ELSE PERFORM
  increment_a2a_key_spend(...)` (back-compat).
- Repro del ataque original (session key + spend-policy activa para el destino + compose 1 step):
  `resolveComposePriceHandler` (`src/routes/compose.ts:97-126`) augmenta `request.composeDestination`
  ANTES del middleware → el step-0 entra por la rama de 6-arg → cap SE evalúa. **Bypass cerrado.**

### 2. Paridad con el branch master

- Master: `src/middleware/a2a-key.ts:829-838` (ternario `composeDestination ? debit(6-arg) :
  debit(3-arg)`). Session: `:592-609` (if/else 6-arg/5-arg). Misma semántica condicional (CD-8b).
- Mapeo a 402: master lo hace por `debitResult.error === 'DEST_CAP_EXCEEDED'` (`:842-846`); session lo
  hace por `instanceof DestCapExceededError` (`:614-618`), correcto porque `debitSessionAndParent`
  **throws** (no devuelve `{error}`). Mismo `error_code: 'DEST_CAP_EXCEEDED'` + status 402. Paridad OK.
- Import de `DestCapExceededError` agregado (`:37`).

### 3. Back-compat (CRÍTICO) — INTACTA

- `composeDestination` undefined → rama `else` (`:602-608`) = llamada de 5 args = comportamiento
  pre-fix idéntico → RPC con `p_destination=null` → `increment_a2a_key_spend`.
- Test de regresión NO modificado por el fix: `src/middleware/a2a-key.test.ts:1576-1582` sigue
  asertando la llamada de **exactamente 5 args** (`'sess-1','user-1',TEST_KEY_ID,2368,1.0`) + 
  `mockDebit` no llamado. Pasa → ningún caller 5-arg roto.

### 4. Scope correcto — nada de más tocado

- Branch master y branch delegación funcionalmente intactos. Delegación: `:376-385` SIN propagar
  destino, con TODO(WKH-125b) documentando que es Scope OUT de WKH-125
  (confirmado en `doc/sdd/114-wkh-125-constraints/sdd.md:356` "Extender políticas a delegaciones
  EIP-712" + MNR-1 de esta auditoría). NO es regresión: es la misma decisión documentada.
- `increment_a2a_key_spend` y todos los RPCs sin cambios (0 cambios en `supabase/`).

### 5. Tests nuevos REALES (no triviales)

- `T-MW-SESS-DEST-1` (`a2a-key.test.ts:1746-1766`): preHandler espeja la augmentación de compose
  (`req.composeDestination = DEST`), session token → aserta `debitSessionAndParent` llamado CON el
  6º arg `DEST` **Y** `mockDebit` (master) NO llamado. Reproduce exactamente el bypass + prueba que
  el path es el de sesión (no master). Fuerte.
- `T-MW-SESS-DEST-2` (`:1769-1782`): `debitSessionAndParent` rechaza con `DestCapExceededError` →
  aserta status 402 + `error_code: 'DEST_CAP_EXCEEDED'`. Cubre el mapeo HTTP.

### 6. ¿Otros paths de bypass del cap?

- Call-sites de débito en el middleware (grep exhaustivo): SOLO 3 —
  `delegationService.debitDelegationAndParent` (`:379`, out-of-scope documentado),
  `keySessionService.debitSessionAndParent` (`:593/602`, AHORA propaga),
  `budgetService.debit` (`:830/838`, master, ya propagaba). Los `getBalance` (`:480/708`) son
  read-only. No queda otro path de débito sin destino salvo delegación (scope OUT conocido = MNR-1).

### Suite

`npx vitest run` → **1581 passed | 3 skipped** (98 files pass | 2 skip). Sin regresión
(baseline auditoría era 1579; +2 = los 2 tests nuevos del fix-pack).

**Conclusión: BLQ-MED-1 CERRADO. El gate de seguridad de E16 pasa. APROBADO.**
