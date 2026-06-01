# Work Item — [WKH-104] Tech Debt Closure (TDs WKH-101/102/103)

## Resumen

Cierre de los 4 TDs diferidos durante las HUs 101-103: un comentario stale de
bajo riesgo, un refactor de deduplicación de lógica en el payment path, un test
de atomicidad que hoy es mock-only y miente, y una vulnerabilidad de reputación
circular (Sybil) que requiere emitir la identidad del caller en los eventos de
telemetría y ponderar el score por callers distintos. Los 4 se cierran en esta
HU — sin diferimiento.

---

## Sizing

- **SDD_MODE**: full
- **Modo pipeline**: QUALITY
- **Estimación**: L (4 TDs independientes: 1 trivial, 1 refactor de payment path
  con backward-compat crítico, 1 test real contra Postgres, 1 feature de
  privacidad + scoring)
- **Branch sugerido**: `feat/104-tech-debt-closure`
- **Skills router**: `backend-node`, `testing-qa`

---

## Grounding confirmado (archivo:línea)

### TD-WKH-102-COMMENT
- Comentario stale confirmado en `src/routes/orchestrate.ts:81-82`:
  ```
  // WKH-101 (DT-12, opción B): chainId resuelto, propagado SOLO para
  // que el débito per-step de steps 2..N funcione bajo delegación.
  ```
  Desde WKH-102, `chainId` se propaga SIEMPRE (tanto master como delegación).
  El comentario dice "SOLO para delegación", lo cual es incorrecto.

### TD-WKH-101-DRIFT
- Función `resolveTargetChain` declarada en `src/middleware/a2a-key.ts:140-179`.
  El docstring en línea 136-138 ya advierte: "Replica EXACTA del bloque master
  (...) no se refactoriza el master para no arriesgar CD-5 backward-compat".
- Bloque inline del path master: `src/middleware/a2a-key.ts:482-529` — misma
  lógica (`resolveChainKey`, `getAdaptersBundle`, respuestas 400/500) duplicada
  verbatim.
- Ambas ramas convergen en `request.resolvedChainId = chainId` (línea 529 en
  master, línea 176 en `resolveTargetChain` al ser retornado y asignado por el
  caller).

### TD-WKH-101-RACE-TEST
- El RPC `debit_delegation_and_parent` se invoca desde
  `src/services/delegation.ts` (línea ~280+) mediante `supabase.rpc(...)`.
- Todos los tests de atomicidad en `src/services/delegation.test.ts:282-380`
  (describe `debitDelegationAndParent`) son 100% mock-only: `mockRpc.mockResolvedValue({...})`.
  No hay ejecución real del FOR UPDATE de Postgres.
- Infraestructura e2e disponible: `src/__tests__/e2e/setup.ts` (buildTestApp con
  mocks), `src/__tests__/e2e/e2e.test.ts`. El patrón real-DB se ve en
  `src/__tests__/erc8004-identity-bridge.e2e.test.ts` (test gateado por env).

### TD-WKH-103-SYBIL
- Evento `compose_step` emitido en `src/services/compose.ts:275-296`.
- Los campos del `metadata` del evento (líneas 285-292) son únicamente:
  `bridge_type`, `bridge_latency_ms`, `bridge_cost_usd`, `llm_model`,
  `llm_tokens_in`, `llm_tokens_out`. **NO hay campo de caller/owner_ref.**
- El caller `owner_ref` está disponible vía `scopingKeyRow?.owner_ref` en el
  mismo scope (línea 238: `const ownerRef = scopingKeyRow?.owner_ref;`).
- La tabla `a2a_events` recibe estos eventos pero no tiene columna de caller
  (confirmado: schema no incluye caller_ref).
- El `reputationService` computa scores contando SOLO por `agent_id`
  (`src/services/reputation.ts:158-161`), sin distinción de callers.
  Un operador puede self-deal: crear su propia agent key, llamar su propio
  agente N veces, elevar `tasks_settled` a voluntad.

---

## Acceptance Criteria (EARS)

### TD-WKH-102-COMMENT

**AC-1** (Ubiquitous):
The system SHALL have the comment at `src/routes/orchestrate.ts:81-82`
accurately reflect that `chainId` is propagated for all callers (master keys
and delegated sessions alike), with no mention of "SOLO para delegación".

### TD-WKH-101-DRIFT

**AC-2** (Ubiquitous):
The system SHALL have the chain-resolution logic in the master-key path of
`src/middleware/a2a-key.ts` delegate to the existing `resolveTargetChain`
helper, eliminating the inline duplicate block at lines 482-529.

**AC-3** (Ubiquitous):
WHEN a master-key request includes an `x-payment-chain` header with an
unrecognized chain slug, the system SHALL return HTTP 400
`CHAIN_NOT_SUPPORTED` — identical behavior to today.

**AC-4** (Ubiquitous):
WHEN a master-key request has no `x-payment-chain` header and there is no
initialized chain, the system SHALL return HTTP 500
`REGISTRY_NOT_INITIALIZED` — identical behavior to today.

**AC-5** (Ubiquitous):
The system SHALL pass the full existing test suite (currently 1324 tests) with
zero regressions after the refactor.

### TD-WKH-101-RACE-TEST

**AC-6** (Event-driven):
WHEN two concurrent requests attempt to debit the same delegation via
`debit_delegation_and_parent` with amounts that individually fit within the
`max_total_amount` but together would exceed it, the system SHALL allow exactly
one to succeed and reject the second with `DELEGATION_TOTAL_LIMIT_EXCEEDED`.

**AC-7** (Ubiquitous):
The atomicity test for `debit_delegation_and_parent` SHALL exercise a real
Postgres instance (not a mock) or be explicitly gated by a
`INTEGRATION_TEST_DB_URL` env var and documented as a manual/CI-integration
step — not as a unit test with a mocked RPC that cannot verify FOR UPDATE
semantics.

**AC-8** (IF unwanted):
IF the `INTEGRATION_TEST_DB_URL` env var is absent at test runtime, the atomic
concurrency test SHALL be skipped (`.skipIf`) and log a clear message explaining
it requires a real Postgres connection — it SHALL NOT silently pass as green
via mocks.

### TD-WKH-103-SYBIL

**AC-9** (Event-driven):
WHEN `composeService` emits a `compose_step` event and the request has a
`scopingKeyRow` with an `owner_ref`, the system SHALL include a
`caller_ref_hash` field in the event metadata — a salted HMAC-SHA256 of the
`owner_ref` — so that distinct callers can be identified without exposing the
raw identity.

**AC-10** (Ubiquitous):
The system SHALL NOT store the raw `owner_ref` value in the `a2a_events`
metadata. Only the hashed value (`caller_ref_hash`) SHALL be persisted.

**AC-11** (Ubiquitous):
`reputationService.computeReputationForAgent` SHALL compute `tasks_settled`
as the count of events with `status='success' AND cost_usdc>0` grouped by
`caller_ref_hash`, such that N tasks from the same caller count as 1 distinct
caller contribution — raising the Sybil bar from O(N tasks) to O(N distinct
funded callers).

**AC-12** (IF unwanted):
IF `scopingKeyRow` is absent (anonymous x402 path), the system SHALL emit the
`compose_step` event with `caller_ref_hash: null` — and the reputation formula
SHALL treat null-hash events as a separate "anonymous" bucket, not attributable
to any single operator.

**[NEEDS CLARIFICATION — NC-1]** Enfoque exacto del anti-sybil en el score:

Las tres opciones son:

- **Opción A (recomendada):** El score base es `distinct_callers` (COUNT DISTINCT
  de `caller_ref_hash` con `cost_usdc>0`) en lugar de `tasks_settled`. Un
  operador con 1000 self-deals tiene score idéntico al de uno con 1 tarea de un
  caller distinto. Simple, auditizable, y el cambio en la fórmula es mínimo
  (reemplazar el contador de tasks por el contador de callers distintos).

- **Opción B:** Mantener `tasks_settled` como hoy pero ponderar el score por
  `min(distinct_callers / tasks_settled, 1)` (índice de diversidad). Penaliza la
  concentración sin eliminar el volumen como señal. Más complejo.

- **Opción C:** Cap por-caller: máximo N tasks por `caller_ref_hash` cuentan
  hacia el score (ej. cap=5). Simple, pero introduce el parámetro N a tunear.

**Recomendación Analyst**: Opción A. Es la más honesta — el score mide "cuántos
operadores distintos pagaron por este agente", que es la definición de reputación
real. Retrocompatible: el shape del objeto `AgentReputation` cambia `tasks_settled`
a `distinct_callers` (o se agrega `distinct_callers` y `tasks_settled` queda como
campo informativo). ACs 11-12 deben ser revisados/confirmados por el humano antes
de SPEC_APPROVED.

---

## Scope IN

| Archivo | Cambio |
|---------|--------|
| `src/routes/orchestrate.ts` | TD-COMMENT: actualizar comentario líneas 81-82 |
| `src/middleware/a2a-key.ts` | TD-DRIFT: eliminar bloque inline 482-529, llamar `resolveTargetChain` |
| `src/services/delegation.ts` | Sin cambios de producción (TD-RACE-TEST es solo test) |
| `src/services/compose.ts` | TD-SYBIL: emitir `caller_ref_hash` en `compose_step` metadata (líneas 285-292) |
| `src/services/reputation.ts` | TD-SYBIL: cambiar fórmula para usar distinct callers (Opción A o según NC-1) |
| `src/services/reputation.test.ts` | TD-SYBIL: actualizar tests para la nueva fórmula |
| `src/services/compose.test.ts` | TD-SYBIL: verificar que `caller_ref_hash` se emite correctamente |
| `src/__tests__/e2e/` (nuevo archivo) | TD-RACE-TEST: test de atomicidad real gateado por env |
| `src/services/delegation.test.ts` | TD-RACE-TEST: actualizar/anotar test mock-only para que no mienta |
| `src/middleware/a2a-key.test.ts` | TD-DRIFT: verificar backward-compat master post-refactor |

## Scope OUT

- Cambios en DB schema (no se agrega columna `caller_ref_hash` a `a2a_events` —
  se almacena en `metadata` JSONB existente)
- RLS changes (TD-SEC-02 separado)
- Cambios en el contrato de la API REST (ningún endpoint cambia su shape)
- Activación de lectura on-chain del ReputationRegistry (ya está env-gated, no
  se toca)
- Migración de eventos históricos (solo eventos nuevos tendrán `caller_ref_hash`)
- Cambios en `GET /auth/deposit-info` ni endpoints de fondeo

---

## Decisiones técnicas (DT)

**DT-1**: El `caller_ref_hash` se computa como HMAC-SHA256(owner_ref, salt)
donde el salt proviene de `process.env.CALLER_HASH_SALT`. Si la env no está
seteada, se usa un salt fijo de dev (`"wasiai-dev-salt-v1"`) con warn en log.
Esto permite que el mismo `owner_ref` produzca el mismo hash dentro de un
deployment (para COUNT DISTINCT) sin exponer el valor crudo.

**DT-2**: El refactor TD-DRIFT NO cambia la signatura pública del middleware
`requirePaymentOrA2AKey` ni el shape de `request.resolvedChainId`. Solo remueve
el bloque inline y reemplaza por `resolveTargetChain(request, reply)` —
exactamente como hace el path delegación hoy.

**DT-3**: El test TD-RACE-TEST se agrega como archivo separado
`src/__tests__/e2e/delegation-atomicity.real.test.ts`, gateado por
`process.env.INTEGRATION_TEST_DB_URL`. No se modifica el test mock-only
existente — se complementa. El mock-only tests queda con un comment que aclara
explícitamente "este test verifica el mapeo de errores, no la atomicidad FOR
UPDATE".

**DT-4**: Para Opción A (score = distinct callers), la query de reputación
cambia de `.select('agent_id, status, cost_usdc, latency_ms')` a
`.select('agent_id, status, cost_usdc, latency_ms, metadata')` para extraer
`metadata->>'caller_ref_hash'`. El tipo `RepRow` se extiende. El cache y la API
pública del service se mantienen; solo cambia el acumulador interno.

---

## Constraint Directives (CD)

**CD-1** (TD-DRIFT / BACKWARD-COMPAT — CRÍTICO):
PROHIBIDO cambiar el comportamiento observable del path master key en
`requirePaymentOrA2AKey`. Cualquier refactor que introduzca una regresión en los
1324 tests actuales es BLOQUEANTE en AR/CR.

**CD-2** (TD-DRIFT / BACKWARD-COMPAT):
PROHIBIDO cambiar la firma de `resolveTargetChain`. La función ya es correcta;
solo hay que invocarla desde el path master en lugar de duplicarla.

**CD-3** (TD-RACE-TEST / ANTI-MOCK-TEATRO):
PROHIBIDO que el nuevo test de atomicidad pase en CI usando mocks de Supabase.
Si `INTEGRATION_TEST_DB_URL` está ausente → `test.skipIf`. Si está presente →
ejercitar Postgres real. Un test verde con mock que no verifica FOR UPDATE es
peor que no tener el test (da falsa confianza).

**CD-4** (TD-RACE-TEST / ANTI-MOCK-TEATRO):
OBLIGATORIO documentar en el test file (docstring) que la cobertura mock-only
de `delegation.test.ts` verifica el mapeo de errores RPC → error classes, NO
la atomicidad FOR UPDATE. Separación de responsabilidades explícita.

**CD-5** (TD-SYBIL / PRIVACIDAD):
PROHIBIDO almacenar el `owner_ref` crudo en `a2a_events.metadata`. Solo se
almacena `caller_ref_hash` (HMAC). Esto aplica tanto al path `compose_step`
como a cualquier otro evento que en el futuro pueda incluir identidad de caller.

**CD-6** (TD-SYBIL / PRIVACIDAD):
OBLIGATORIO que `caller_ref_hash` sea un HMAC (no un hash sin key). Un SHA256
sin salt puede ser revertido por rainbow table si el espacio de `owner_ref` es
predecible (UUIDs). HMAC con salt impide eso.

**CD-7** (TD-SYBIL / SYBIL-RESISTANCE):
La nueva fórmula de reputación SHALL elevar el bar Sybil de O(N tasks por
1 caller) a O(N callers distintos fondeados). Si se elige Opción A, el campo
de score pasa a ser función de `distinct_callers` en lugar de `tasks_settled`.

**CD-8** (TD-SYBIL / BACKWARD-COMPAT):
Los eventos históricos en `a2a_events` NO tienen `caller_ref_hash`. La nueva
fórmula SHALL tratar `caller_ref_hash IS NULL` como "caller anónimo" (bucket
propio), no como error. El score de agentes con historial pre-WKH-104 no
colapsa a null.

**CD-9** (GENERAL):
OBLIGATORIO que todos los 1324 tests existentes pasen después de cada TD. No
existe TD "trivial" que justifique regresión.

---

## Missing Inputs

- **[NEEDS CLARIFICATION — NC-1]** Opción anti-sybil: A (distinct_callers como
  score base), B (índice de diversidad), o C (cap por-caller). Recomendación:
  Opción A. Resolver antes de SPEC_APPROVED.

- **[resuelto en F2]** Estrategia de test para TD-RACE-TEST: DT-3 define el
  approach (archivo separado gateado por env). Architect confirma o ajusta en SDD.

---

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs en vuelo (WKH-96 deploy pendiente es deployment,
  no desarrollo).
- TD-WKH-102-COMMENT y TD-WKH-101-DRIFT son independientes entre sí y pueden
  implementarse en waves separadas.
- TD-WKH-101-RACE-TEST es independiente de los demás (archivo nuevo).
- TD-WKH-103-SYBIL toca `compose.ts` y `reputation.ts` — no hay conflicto con
  otras HUs activas en main.
- Las 4 waves pueden ser seriales dentro de la misma HU sin riesgo de conflicto.
