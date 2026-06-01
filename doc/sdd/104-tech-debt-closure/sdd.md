# SDD #104: Tech Debt Closure — TDs WKH-101/102/103 (comment / drift / race-test / sybil)

> SPEC_APPROVED: no
> Fecha: 2026-05-31
> Tipo: tech-debt (refactor + test-infra + feature de privacidad/scoring)
> SDD_MODE: full
> Branch: feat/104-tech-debt-closure
> Artefactos: doc/sdd/104-tech-debt-closure/

---

## 1. Resumen

Cierre de los 4 TDs diferidos en las HUs 101-103, sin diferimiento adicional:

1. **TD-COMMENT** (trivial): actualizar un comentario stale en `orchestrate.ts`.
2. **TD-DRIFT** (refactor backward-compat-crítico): el path master de
   `requirePaymentOrA2AKey` deja de duplicar el bloque de resolución de chain y
   pasa a invocar el helper `resolveTargetChain` (mismo helper que ya usa el path
   delegación). Comportamiento observable idéntico (CD-1).
3. **TD-RACE-TEST** (test-infra honesto): test de **atomicidad real** del RPC
   `debit_delegation_and_parent` contra **Postgres real**, gateado por
   `INTEGRATION_TEST_DB_URL`. Si la env está ausente → `describe.skipIf` con log.
   No mock-teatro (CD-3/CD-4).
4. **TD-SYBIL** (privacidad + anti-sybil): `compose.ts` emite `caller_ref_hash`
   (HMAC-SHA256 del `owner_ref`, nunca el raw) en el `metadata` de `compose_step`
   (success Y failed). `reputation.ts` **capea por caller**: cada
   `(agent_id, caller_ref_hash)` aporta como máximo **K** tasks liquidadas al
   conteo (K env-driven), luego se suma por agente. Eventos viejos sin hash → un
   solo bucket `NULL` (capeado a K).

**Decisión del humano (NC-1):** anti-sybil = **CAP POR CALLER** (variante de
Opción C del work-item), **NO** Opción A. Se preserva la métrica de WKH-103
(score 0-100 derivado de tasks liquidadas), pero cada caller distinto contribuye
como máximo K tasks. Esto eleva el bar Sybil de O(N tasks por 1 caller) a
O(N callers distintos × K) sin descartar el volumen como señal y sin romper el
shape de `AgentReputation` (`tasks_settled` se mantiene como campo, ahora capeado).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 104 |
| **Tipo** | tech-debt |
| **SDD_MODE** | full |
| **Objetivo** | Cerrar los 4 TDs (comment, drift, race-test, sybil) sin regresión en los 1324 tests. |
| **Reglas de negocio** | Anti-sybil = cap por caller (K). HMAC para identidad del caller (nunca raw). Backward-compat absoluta del master path. Test de atomicidad real (no mock). |
| **Scope IN** | Ver §6. |
| **Scope OUT** | Ver §6. |
| **Missing Inputs** | Ninguno — NC-1 resuelto por el humano (cap por caller). |

### Acceptance Criteria (EARS)

Heredados del work-item (12 ACs). **AC-11 y AC-12 se reinterpretan según NC-1
(cap por caller), no Opción A.**

1. **AC-1** (Ubiquitous): El comentario en `orchestrate.ts:81-82` SHALL reflejar
   que `chainId` se propaga para todos los callers (master y delegación), sin
   mencionar "SOLO para delegación".
2. **AC-2** (Ubiquitous): El bloque de resolución de chain del path master en
   `a2a-key.ts` SHALL delegar en `resolveTargetChain`, eliminando el duplicado
   inline 482-529.
3. **AC-3** (Ubiquitous): WHEN un request master con `x-payment-chain`
   desconocido, el sistema SHALL retornar HTTP 400 `CHAIN_NOT_SUPPORTED` —
   idéntico a hoy.
4. **AC-4** (Ubiquitous): WHEN un request master sin `x-payment-chain` y sin
   chain inicializada, el sistema SHALL retornar HTTP 500
   `REGISTRY_NOT_INITIALIZED` — idéntico a hoy.
5. **AC-5** (Ubiquitous): El sistema SHALL pasar los 1324 tests sin regresiones.
6. **AC-6** (Event-driven): WHEN dos requests concurrentes debitan la misma
   delegación con montos que individualmente caben en `max_total_amount` pero
   juntos lo exceden, el sistema SHALL permitir exactamente uno y rechazar el
   otro con `DELEGATION_TOTAL_LIMIT_EXCEEDED`.
7. **AC-7** (Ubiquitous): El test de atomicidad SHALL ejercitar Postgres real,
   gateado por `INTEGRATION_TEST_DB_URL` y documentado como paso manual/CI — no
   un unit test con RPC mockeado.
8. **AC-8** (IF unwanted): IF `INTEGRATION_TEST_DB_URL` ausente, el test SHALL
   skippearse (`describe.skipIf`) con mensaje claro — NO pasar verde via mocks.
9. **AC-9** (Event-driven): WHEN `composeService` emite `compose_step` y el
   request tiene `scopingKeyRow.owner_ref`, el sistema SHALL incluir
   `caller_ref_hash` (HMAC-SHA256 salteado del `owner_ref`) en el metadata.
10. **AC-10** (Ubiquitous): El sistema SHALL NO almacenar el `owner_ref` crudo en
    `a2a_events.metadata`. Solo el hash.
11. **AC-11** (Ubiquitous) **[REINTERPRETADO — NC-1]**:
    `reputationService` SHALL computar `tasks_settled` como la suma, por agente,
    de `min(count_de_tasks_liquidadas_por_caller, K)` agrupando por
    `caller_ref_hash`, donde K = `REPUTATION_MAX_TASKS_PER_CALLER`. N tasks de un
    mismo caller cuentan como `min(N, K)`, no N — elevando el bar Sybil.
12. **AC-12** (IF unwanted): IF `scopingKeyRow` ausente (x402 anónimo), el evento
    SHALL emitirse con `caller_ref_hash: null` — y la fórmula SHALL tratar los
    eventos null-hash como un **único bucket "anónimo"** (también capeado a K),
    no atribuible a ningún operador individual.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo |
|---------|---------|-------------------|
| `src/routes/orchestrate.ts:81-82` | TD-COMMENT | Comentario stale verificado: dice "propagado SOLO para que el débito per-step funcione bajo delegación". Falso desde WKH-102. |
| `src/middleware/a2a-key.ts:136-179` | TD-DRIFT (helper) | `resolveTargetChain(request, reply)` retorna `{ chainId, chainKey, assetSymbol } | null` (null = ya envió error). Docstring 137-138 admite la duplicación intencional. |
| `src/middleware/a2a-key.ts:482-529` | TD-DRIFT (duplicado master) | Bloque inline verbatim: lee `x-payment-chain`, `resolveChainKey`, `getDefaultChainKey`, `getAdaptersBundle`, errores 400 `CHAIN_NOT_SUPPORTED` / 500 `REGISTRY_NOT_INITIALIZED`. Produce `chainId`, `chainKey`, `assetSymbol`, asigna `request.resolvedChainId = chainId` (529). |
| `src/middleware/a2a-key.ts:537-575` | TD-DRIFT (consumidores) | Tras 529 el master usa `chainKey` (540, 563), `chainId` (541, 549, 558, 564) y `assetSymbol` (542, 565). El refactor DEBE preservar las 3 vars en scope. |
| `src/middleware/a2a-key.ts:275-309` | TD-DRIFT (exemplar de la llamada) | Path delegación YA hace: `const chain = resolveTargetChain(request, reply); if (!chain) return; const { chainId, chainKey, assetSymbol } = chain; request.resolvedChainId = chainId;`. **Patrón exacto a replicar en master.** |
| `src/services/compose.ts:225-296` | TD-SYBIL (emisión success) | `ownerRef = scopingKeyRow?.owner_ref` ya disponible (238). `eventService.track({... metadata: { bridge_type, bridge_latency_ms, bridge_cost_usd, llm_model, llm_tokens_in, llm_tokens_out } })` (285-292). Constructor explícito, `?? null` por campo. |
| `src/services/compose.ts:297-310` | TD-SYBIL (emisión failed) | El catch emite `compose_step` `status: 'failed'` SIN metadata. Debe agregar `metadata: { caller_ref_hash }` también acá (AC-9 cubre success Y failed). |
| `src/services/compose.ts:62` | TD-SYBIL (scope) | `scopingKeyRow` se desestructura del input de `compose()`. Disponible en todo el cuerpo del loop. |
| `src/services/event.ts:52-85` | TD-SYBIL (sink) | `track(input)` acepta `metadata?: Record<string, unknown>` → se inserta en `a2a_events.metadata` (JSONB). No requiere cambio de schema. |
| `src/services/reputation.ts` (completo) | TD-SYBIL (scoring) | `RepRow` = `{ agent_id, status, cost_usdc, latency_ms }`. SELECT línea 160/194. `RepAccumulator` con `settledCount`. `accumulateRow` incrementa `settledCount` por fila `success AND cost>0`. `computeFromAccumulator`: `tasksSettled = settledCount`, `raw = min(tasksSettled/scale, 1)`, `score = round(raw*100*successRate)`. Batch usa `.in('agent_id', slugs)` — 1 query (CD-12 anti-N+1). |
| `src/services/delegation.ts:377-420` | TD-RACE-TEST | `debitDelegationAndParent(delegationId, ownerRef, keyId, chainId, amountUsd)` → `supabase.rpc('debit_delegation_and_parent', {p_delegation_id, p_owner_ref, p_key_id, p_chain_id, p_amount_usd})`. Mapea `DELEGATION_TOTAL_LIMIT_EXCEEDED` → `DelegationTotalLimitExceededError`. |
| `src/services/delegation.test.ts:282-380` | TD-RACE-TEST (mock-only) | `describe('debitDelegationAndParent')` 100% `mockRpc.mockResolvedValue(...)`. Verifica el **mapeo de errores RPC → error classes**, NO la atomicidad FOR UPDATE. |
| `supabase/migrations/20260601000000_a2a_delegations.sql:41-109` | TD-RACE-TEST (RPC real) | `debit_delegation_and_parent`: `SELECT ... FOR UPDATE` sobre `a2a_delegations` (57-63); `RAISE 'DELEGATION_TOTAL_LIMIT_EXCEEDED'` si `v_total + amount > v_max_total` (86-90); `PERFORM increment_a2a_key_spend` (95); `UPDATE total_spent` (98). `SECURITY DEFINER`; `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` (108-109) → **solo service_role puede ejecutarlo**. |
| `src/__tests__/erc8004-identity-bridge.e2e.test.ts:1-90` | TD-RACE-TEST (exemplar e2e) | Exemplar de e2e gateado — pero es **mock-based** (no real DB). Sirve como patrón de estructura (`describe`/`beforeAll`/`afterAll`/`vi`), NO como patrón de conexión real. |
| `src/lib/supabase.ts` | TD-RACE-TEST (cliente real) | `createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {...})`. El test de integración debe construir un cliente equivalente desde `INTEGRATION_TEST_DB_URL` + service key (service_role, por el REVOKE). |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_events` | Sí | `agent_id`, `status`, `cost_usdc`, `latency_ms`, `metadata` (JSONB) — `caller_ref_hash` vive DENTRO de `metadata`, sin nueva columna (Scope OUT del work-item). |
| `a2a_delegations` | Sí | `id`, `owner_ref`, `key_id`, `revoked_at`, `expires_at`, `total_spent`, `policy` (JSONB con `max_total_amount`). |
| `a2a_agent_keys` | Sí | `id`, `owner_ref`, `budget` (JSONB per-chain). El RPC debita acá vía `increment_a2a_key_spend`. |
| RPC `debit_delegation_and_parent` | Sí (migración aplicada) | Args `(uuid, text, uuid, int, numeric)`. Solo `service_role`. |

### Componentes reutilizables encontrados

- `resolveTargetChain` (`a2a-key.ts:140-179`) — **reutilizar** en el path master
  (NO crear helper nuevo, NO cambiar su firma — CD-2).
- `eventService.track` (`event.ts:52`) — ya acepta `metadata` arbitrario; NO se
  toca su firma.
- `node:crypto` `createHmac` — disponible en Node 20 (ver `erc8004-identity-bridge.e2e.test.ts:13` usa `crypto`). NO agregar dependencia.
- Patrón env-resolver `resolveScaleFactor` / `resolveCacheTtlMs`
  (`reputation.ts:23-33`) — **copiar** para `resolveMaxTasksPerCaller`.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/routes/orchestrate.ts` | Modificar | TD-COMMENT: reescribir comentario 81-82 (AC-1). | — (copy-only) |
| `src/middleware/a2a-key.ts` | Modificar | TD-DRIFT: reemplazar bloque inline 482-529 por llamada a `resolveTargetChain` (AC-2/3/4). | `a2a-key.ts:275-277` (path delegación) |
| `src/lib/caller-hash.ts` | **Crear** | TD-SYBIL: helper `hashCallerRef(ownerRef)` → HMAC-SHA256 con salt env (AC-9/10, DT-1). | `reputation.ts:23-33` (env-resolver) + `node:crypto` |
| `src/services/compose.ts` | Modificar | TD-SYBIL: emitir `caller_ref_hash` en metadata de `compose_step` success (285-292) Y failed (299-307) (AC-9/12). | `compose.ts:238` (`ownerRef`) |
| `src/services/reputation.ts` | Modificar | TD-SYBIL: extender `RepRow` con `metadata`; agrupar por `(slug, caller_ref_hash)`; capear count a K; sumar por agente (AC-11/12, CD-7). | `reputation.ts` (acumulador actual) |
| `src/__tests__/e2e/delegation-atomicity.real.test.ts` | **Crear** | TD-RACE-TEST: test de atomicidad real gateado por `INTEGRATION_TEST_DB_URL` (AC-6/7/8). | `erc8004-identity-bridge.e2e.test.ts` (estructura describe/beforeAll) + `lib/supabase.ts` (createClient) |
| `src/services/delegation.test.ts` | Modificar | TD-RACE-TEST: agregar docstring al describe mock-only aclarando que verifica mapeo de errores, NO atomicidad (CD-4). | — (anotación) |
| `src/lib/caller-hash.test.ts` | **Crear** | TD-SYBIL: tests del helper HMAC (determinismo, no leak raw, null-passthrough). | `reputation.test.ts` (estructura) |
| `src/services/compose.test.ts` | Modificar | TD-SYBIL: assert `caller_ref_hash` emitido en success/failed; null cuando no hay scopingKeyRow. | tests existentes de `compose_step` |
| `src/services/reputation.test.ts` | Modificar | TD-SYBIL: tests de cap por caller (1 caller × N → K), callers distintos suman, bucket null. | tests existentes de reputation |

### 4.2 Modelo de datos

**Sin cambios de schema.** `caller_ref_hash` se persiste dentro de
`a2a_events.metadata` (JSONB ya existente). Eventos históricos (1049 existentes)
NO tienen la clave → se leen como `undefined`/`null` en el reduce JS.

### 4.3 Diseño por TD

#### TD-COMMENT (AC-1)

Reemplazar el texto de `orchestrate.ts:81-82` por uno que diga que `chainId` se
resuelve y propaga para **todos los callers** (master keys y delegación), para
que el débito per-step de steps 1..N use el chainId del bundle. Eliminar la
frase "SOLO para … bajo delegación". Sin cambio de código ejecutable.

#### TD-DRIFT (AC-2/3/4/5) — backward-compat CRÍTICO

**Diseño:** reemplazar las líneas 487-529 del path master por exactamente el
mismo patrón que el path delegación usa en 275-277:

```
const chain = resolveTargetChain(request, reply);
if (!chain) return;                       // resolveTargetChain ya envió el error
const { chainId, chainKey, assetSymbol } = chain;
request.resolvedChainId = chainId;
```

Esto es behavior-idéntico porque `resolveTargetChain` (140-179) es una réplica
verbatim del bloque inline:
- mismo orden de evaluación: header → `resolveChainKey` → default → `getAdaptersBundle`;
- mismos status/códigos: 400 `CHAIN_NOT_SUPPORTED` (header desconocido y slug no
  inicializado), 500 `REGISTRY_NOT_INITIALIZED` (sin chain);
- mismos campos derivados: `chainId = bundle.chainConfig.chainId`,
  `assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN'`.

**Punto de atención (verificación de equivalencia):** las 3 variables
(`chainId`, `chainKey`, `assetSymbol`) deben quedar en el mismo scope donde hoy
las consume el master (líneas 540-565). El bloque inline las declara con `const`;
tras el refactor salen del destructuring. La línea 522-524 (`const chainId = ...`
y `const assetSymbol = ...`) y 529 desaparecen, reemplazadas por el destructuring.

> **NOTA**: el único delta textual de error entre el inline y el helper son los
> **comentarios** (el inline tiene comentarios CD-14/DT-C; el helper no). El
> cuerpo de las respuestas `reply.status(...).send({...})` es idéntico
> string-por-string. Verificado en §3 (a2a-key.ts:151-173 vs 496-517). Esto
> garantiza CD-1.

**Estrategia de verificación de equivalencia (para AR/CR + Dev):**
1. Los tests existentes en `a2a-key.test.ts` que cubren el path master con
   header desconocido (→400) y sin chain (→500) deben seguir verdes sin
   modificación. Si algún test cambia, es señal de regresión → BLOQUEANTE.
2. `git diff` debe mostrar SOLO eliminación del bloque inline + inserción del
   patrón de 4 líneas. Ninguna línea de `resolveTargetChain` cambia (CD-2).
3. Los 1324 tests verdes (AC-5/CD-9).

#### TD-RACE-TEST (AC-6/7/8) — atomicidad real, anti-mock-teatro

**Archivo nuevo:** `src/__tests__/e2e/delegation-atomicity.real.test.ts`.

**Estrategia (honesta, sin mock-teatro):**

- El bloque se declara con `describe.skipIf(!process.env.INTEGRATION_TEST_DB_URL)`.
  Si la env está ausente → todo el describe se skippea y se loguea
  (`console.warn`) un mensaje claro: "requiere Postgres real; setear
  `INTEGRATION_TEST_DB_URL` + `INTEGRATION_TEST_SERVICE_KEY` para ejecutarlo"
  (AC-8). **NO** hay fallback a mock.
- Cuando la env está presente, el test construye un cliente Supabase **real**
  vía `createClient(process.env.INTEGRATION_TEST_DB_URL, process.env.INTEGRATION_TEST_SERVICE_KEY, {auth:{persistSession:false}})`.
  Debe ser **service_role** porque el RPC tiene `REVOKE EXECUTE FROM PUBLIC,
  anon, authenticated` (migración:108-109).
- **Setup (`beforeAll` / fixture):** insertar directamente en la DB de test:
  1. una `a2a_agent_keys` con `budget` suficiente en un chainId de prueba (que no
     sea el limitante del test);
  2. una `a2a_delegations` con `total_spent = 0`, `expires_at` futuro,
     `revoked_at = null`, y `policy.max_total_amount` tal que **dos** débitos de
     monto M individualmente pasen pero `2M > max_total_amount`.
     (Ej: `max_total_amount = 1.5`, dos débitos de `1.0` → el segundo viola
     `1.0 + 1.0 > 1.5`).
- **Acto concurrente (AC-6):** disparar las dos llamadas
  `supabase.rpc('debit_delegation_and_parent', {...})` con
  `Promise.allSettled([call1, call2])` (sin await secuencial — concurrencia real
  contra el lock FOR UPDATE).
- **Aserciones:** exactamente uno `fulfilled` (RETURNS el nuevo total) y
  exactamente uno `rejected`/error con mensaje que incluye
  `DELEGATION_TOTAL_LIMIT_EXCEEDED`. Adicional: re-leer la fila de
  `a2a_delegations` y verificar `total_spent` = M (no 2M — el segundo hizo
  ROLLBACK). Esto prueba la atomicidad FOR UPDATE (no-double-spend), que un mock
  jamás podría verificar.
- **Cleanup (`afterAll`):** borrar las filas seed (delegación + key) por sus IDs.
  Usar IDs con prefijo de test reconocible para limpieza segura (patrón
  `owner_ref`-prefix de WKH-35, ver commit d6b99f1).

**Anotación del mock-only existente (CD-4):** agregar al `describe(
'debitDelegationAndParent')` de `delegation.test.ts:284` un comentario que
declare explícitamente: "estos tests verifican el **mapeo de errores RPC →
error classes** (DELEGATION_TOTAL_LIMIT_EXCEEDED, INSUFFICIENT_BUDGET, etc.),
NO la atomicidad FOR UPDATE. La atomicidad real se cubre en
`src/__tests__/e2e/delegation-atomicity.real.test.ts` (gated por
INTEGRATION_TEST_DB_URL)." No se borra ningún test mock — son complementarios.

#### TD-SYBIL — Emisión (AC-9/10/12)

**Helper nuevo `src/lib/caller-hash.ts`:**
- `function resolveCallerHashSecret(): string` — lee
  `process.env.REPUTATION_CALLER_HMAC_SECRET`. Si ausente → usa
  `"wasiai-dev-caller-hmac-v1"` con `console.warn` una sola vez (degradación
  segura para dev/test; patrón DT-1 del work-item + `resolveScaleFactor`).
- `function hashCallerRef(ownerRef: string | null | undefined): string | null`:
  - si `ownerRef` es null/undefined/'' → retorna `null` (AC-12, anónimo).
  - si presente → `createHmac('sha256', secret).update(ownerRef).digest('hex')`.
  - **NUNCA** retorna ni loguea el `ownerRef` crudo (CD-5/CD-6).

**En `compose.ts`:**
- Computar `const callerRefHash = hashCallerRef(scopingKeyRow?.owner_ref);` una
  vez por step (el `ownerRef` ya se lee en 238; reutilizar).
- **Success** (metadata 285-292): agregar `caller_ref_hash: callerRefHash`
  (puede ser `null`). Mantener constructor explícito + estilo `?? null`
  existente (AB-WKH-56-4).
- **Failed** (catch 299-307): el `track` actual NO pasa `metadata`. Agregar
  `metadata: { caller_ref_hash: callerRefHash }` para que también el evento
  failed lleve la identidad (AC-9 cubre success Y failed; sin esto un sybil podría
  inflar `successCount`/denominador via fallos atribuibles).

> **Privacidad (AC-10/CD-5):** el evento persiste SOLO `caller_ref_hash`. El
> `owner_ref` crudo nunca entra al objeto `metadata`. El helper es la única
> frontera donde el raw se transforma.

#### TD-SYBIL — Scoring (AC-11/12, CD-7) — CAP POR CALLER

**Decisión NC-1 (humano):** cap por caller, NO Opción A.

**Cambios en `reputation.ts`:**

1. **Env-resolver** `resolveMaxTasksPerCaller(): number` — lee
   `REPUTATION_MAX_TASKS_PER_CALLER`. Default seguro si ausente/inválido (ej.
   `5`). Patrón calcado de `resolveScaleFactor` (23-27). `Number.isFinite && > 0`.

2. **`RepRow`** se extiende con `metadata: Record<string, unknown> | null` (DT-4).
   El SELECT pasa de `'agent_id, status, cost_usdc, latency_ms'` a
   `'agent_id, status, cost_usdc, latency_ms, metadata'` en **ambos** queries
   (single 160 + batch 194). Sigue siendo **1 query por path** (CD anti-N+1).

3. **Acumulador por caller** (el cambio central). Hoy `RepAccumulator.settledCount`
   es un contador plano. Pasa a contar **por bucket de caller**:
   - Agregar `settledByCaller: Map<string, number>` al acumulador (key =
     `caller_ref_hash` o el sentinel `"__anon__"` cuando es null/undefined →
     AC-12, un único bucket anónimo).
   - En `accumulateRow`, cuando la fila es `success AND cost>0`: extraer
     `const hash = (row.metadata?.['caller_ref_hash'] as string | null | undefined) ?? '__anon__';`
     e incrementar `settledByCaller.get(hash)`. El `settledVolume` y la latencia
     se siguen acumulando crudo (el volumen NO se capea — solo el conteo de tasks
     que alimenta el score; mantiene `total_volume_usdc` honesto).
   - `successCount` / `failedCount` se mantienen crudos para `success_rate`
     (consistente con OBS-1 de WKH-103; el cap aplica al numerador del score, no
     al success_rate).

4. **`computeFromAccumulator`** — el `tasksSettled` deja de ser `settledCount`
   plano y pasa a ser:
   ```
   const K = resolveMaxTasksPerCaller();
   let tasksSettled = 0;
   for (const n of settledByCaller.values()) tasksSettled += Math.min(n, K);
   if (tasksSettled === 0) return null;   // sin tasks liquidadas → campo omitido
   ```
   El resto de la fórmula NO cambia: `raw = min(tasksSettled/scale, 1)`,
   `score = round(raw*100*successRate)`. El shape `AgentReputation` se mantiene
   (`tasks_settled` ahora es el valor capeado — semánticamente "tasks liquidadas
   anti-sybil", consistente con el JSDoc actual que ya llama a esto "anti-sybil
   CD-1").

5. **Determinismo + sin N+1:** se mantiene 1 query por página. El cap se aplica
   100% en el reduce JS in-memory (igual que hoy). Batch agrupa por slug → por
   ese slug, un `Map<callerHash, count>`. (Nested Map en `accBySlug` o un
   acumulador por slug que ya tiene su `settledByCaller`.)

**Efecto documentado (CD-8):** los 1049 eventos históricos sin `caller_ref_hash`
caen todos en el bucket `"__anon__"` → contribuyen `min(N_históricos, K)` =
**K como máximo** al `tasks_settled` de cada agente. Esto **puede bajar scores
inflados existentes** (un agente con 1000 self-deals históricos pasa de
`tasks_settled=1000` a `min(1000, K)=K`). **Es exactamente el comportamiento
anti-sybil esperado**, no un bug. Documentar en el JSDoc del service y en el
done-report. No es un colapso a null: el agente conserva score (≥1 task = score
> 0), solo se le quita el volumen inflado.

### 4.4 Flujo principal (Happy Path)

**Reputación (post-cambio):**
1. `/discover` o AgentCard pide reputación de slug(s).
2. 1 SELECT a `a2a_events` (con `metadata`).
3. Reduce JS: por slug → por `caller_ref_hash` (o `__anon__`) → count.
4. `tasksSettled = Σ min(count_caller, K)`.
5. `score = round(min(tasksSettled/scale,1) * 100 * successRate)`.
6. Cache en-proceso (TTL env) — sin cambios.

**Atomicidad (test real):**
1. Seed key + delegación con `max_total_amount` que solo permite 1 débito.
2. Dos `rpc` concurrentes via `Promise.allSettled`.
3. Uno gana el lock FOR UPDATE y debita; el otro re-lee bajo lock y RAISE
   `DELEGATION_TOTAL_LIMIT_EXCEEDED`.
4. Assert: 1 fulfilled + 1 rejected; `total_spent = M`.

### 4.5 Flujo de error

- TD-DRIFT: header desconocido → 400 `CHAIN_NOT_SUPPORTED`; sin chain → 500
  `REGISTRY_NOT_INITIALIZED` (idénticos a hoy, vía `resolveTargetChain`).
- TD-RACE-TEST: env ausente → describe skippeado con warn (no mock, no falso
  verde). Setup falla → el test falla ruidosamente (no se enmascara).
- TD-SYBIL emisión: `track` falla → `.catch(console.error)` fire-and-forget
  (igual que hoy; no rompe el flujo de compose).
- TD-SYBIL scoring: query falla → log server-side + `null`/Map vacío (CD-18 de
  WKH-103, sin propagar `error.message`).

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (CD-1..CD-9)

- **CD-1** (DRIFT/backward-compat CRÍTICO): PROHIBIDO cambiar el comportamiento
  observable del path master. Regresión en los 1324 tests = BLOQUEANTE.
- **CD-2** (DRIFT): PROHIBIDO cambiar la firma de `resolveTargetChain`. Solo
  invocarla.
- **CD-3** (RACE/anti-mock): PROHIBIDO que el test de atomicidad pase en CI con
  mocks. Env ausente → skip.
- **CD-4** (RACE/anti-mock): OBLIGATORIO documentar en `delegation.test.ts` que el
  mock-only verifica mapeo de errores, NO atomicidad.
- **CD-5** (SYBIL/privacidad): PROHIBIDO almacenar `owner_ref` crudo en
  `a2a_events.metadata`. Solo `caller_ref_hash`.
- **CD-6** (SYBIL/privacidad): OBLIGATORIO HMAC (no hash sin key). Salt/secret
  desde env.
- **CD-7** (SYBIL/sybil-resistance): la fórmula SHALL elevar el bar Sybil. Cap por
  caller (NC-1): cada caller aporta `min(count, K)`.
- **CD-8** (SYBIL/backward-compat): eventos sin `caller_ref_hash` → bucket
  anónimo (capeado a K), no error, no colapso a null.
- **CD-9** (GENERAL): OBLIGATORIO 1324 tests verdes tras cada TD.

### Específicos del SDD

- **CD-10** (SYBIL/anti-N+1): el cambio de scoring SHALL mantener **1 query por
  path** (single y batch). El cap se aplica 100% en el reduce JS. PROHIBIDO
  agregar un query por caller o por agente.
- **CD-11** (SYBIL/determinismo): el mismo `owner_ref` SHALL producir el mismo
  `caller_ref_hash` dentro de un deployment (mismo secret) → COUNT DISTINCT
  estable. El helper es puro (sin estado salvo el secret de env).
- **CD-12** (DRIFT/scope): el `git diff` de `a2a-key.ts` SHALL contener SOLO la
  eliminación del bloque inline (487-529) + inserción del patrón de 4 líneas.
  PROHIBIDO tocar `resolveTargetChain`, el orden de los pasos 1-8, o cualquier
  otra rama del middleware.
- **CD-13** (RACE/cleanup): el test real SHALL limpiar sus filas seed en
  `afterAll` (patrón owner_ref-prefix WKH-35) — PROHIBIDO dejar basura en la DB
  compartida (Supabase dev compartido con wasiai-v2).
- **CD-14** (RACE/service_role): el cliente del test SHALL usar service key
  (service_role) — el RPC tiene REVOKE para anon/authenticated. Documentar en el
  docstring del test cómo correrlo.
- **CD-15** (SYBIL/types-strict): `RepRow.metadata` tipado como
  `Record<string, unknown> | null` — PROHIBIDO `any`. Extracción del hash con
  cast estrecho `as string | null | undefined` (TS strict, project-context §8).

### PROHIBIDO (general)

- NO agregar dependencias (HMAC vía `node:crypto`; cliente real vía
  `@supabase/supabase-js` ya presente).
- NO cambiar el shape público de `AgentReputation` (`tasks_settled` se mantiene
  como key; cambia su semántica/valor, no el nombre — backward-compat de la API).
- NO agregar columna a `a2a_events` (Scope OUT).
- NO migrar eventos históricos (Scope OUT).
- NO tocar `delegation.ts` producción (TD-RACE-TEST es solo test).
- NO modificar archivos fuera del Scope IN.

---

## 6. Scope

**IN:**
- `src/routes/orchestrate.ts` (comentario).
- `src/middleware/a2a-key.ts` (refactor master → `resolveTargetChain`).
- `src/lib/caller-hash.ts` (NUEVO — helper HMAC).
- `src/services/compose.ts` (emitir `caller_ref_hash` success+failed).
- `src/services/reputation.ts` (cap por caller).
- Tests: `caller-hash.test.ts` (NUEVO), `compose.test.ts`, `reputation.test.ts`,
  `delegation.test.ts` (anotación), `__tests__/e2e/delegation-atomicity.real.test.ts`
  (NUEVO), y `a2a-key.test.ts` (verificación backward-compat — sin cambios
  esperados, pero confirmados verdes).

**OUT:**
- Cambios de schema DB / nueva columna `caller_ref_hash`.
- RLS (TD-SEC-02).
- Cambio del shape de respuesta de cualquier endpoint REST/JSON-RPC.
- Lectura on-chain del ReputationRegistry (ya env-gated).
- Migración de eventos históricos.
- Cambios en `delegation.ts` de producción.
- Cambios en endpoints de fondeo / `/auth/deposit-info`.

---

## 7. Waves de Implementación

### Wave 0 (Serial Gate — trivial + contratos/helpers)
- [ ] **W0.1** TD-COMMENT: reescribir `orchestrate.ts:81-82` (AC-1).
- [ ] **W0.2** Crear `src/lib/caller-hash.ts` (`hashCallerRef` + `resolveCallerHashSecret`) + `caller-hash.test.ts` (DT-1, CD-5/6/11).
- [ ] **Gate W0:** `tsc --noEmit` 0 errores + `biome check --write` (carry WKH-101/102/103: format ANTES de lint).

### Wave 1 — TD-DRIFT (backward-compat crítico, serial por su riesgo)
- [ ] **W1.1** Reemplazar bloque inline `a2a-key.ts:487-529` por patrón
  `resolveTargetChain` (AC-2/3/4, CD-1/2/12). Exemplar: `a2a-key.ts:275-277`.
- [ ] **W1.2** Confirmar `a2a-key.test.ts` master path (400/500) verde **sin
  cambios** (señal de equivalencia).
- [ ] **Gate W1:** suite completa verde (foco: middleware + 400/500 master).

### Wave 2 — TD-SYBIL emisión
- [ ] **W2.1** `compose.ts`: emitir `caller_ref_hash` en success (285-292) y
  failed (299-307) (AC-9/10/12, CD-5). Exemplar: `compose.ts:238`.
- [ ] **W2.2** `compose.test.ts`: assert hash en success/failed + null sin
  scopingKeyRow.
- [ ] **Gate W2:** tsc + suite verde.

### Wave 3 — TD-SYBIL scoring (cap por caller)
- [ ] **W3.1** `reputation.ts`: `resolveMaxTasksPerCaller`, `RepRow.metadata`,
  SELECT con `metadata` (single+batch), acumulador `settledByCaller`, cap en
  `computeFromAccumulator` (AC-11/12, CD-7/8/10/15).
- [ ] **W3.2** `reputation.test.ts`: 1 caller × N → K; callers distintos suman;
  bucket null; histórico sin hash; determinismo del cap.
- [ ] **Gate W3:** tsc + suite verde. Mockear `supabase.js` donde aplique
  (carry WKH-103 W4: el fetch interno de PostgREST infla call-counts).

### Wave 4 — TD-RACE-TEST
- [ ] **W4.1** Crear `__tests__/e2e/delegation-atomicity.real.test.ts`
  (describe.skipIf, cliente service_role real, seed, allSettled, asserts,
  cleanup) (AC-6/7/8, CD-3/13/14).
- [ ] **W4.2** Anotar `delegation.test.ts:284` describe (CD-4).
- [ ] **Gate W4:** sin `INTEGRATION_TEST_DB_URL` → el describe se skippea, suite
  verde (1324 + nuevos unit). Con env (manual): el test real corre y pasa.

> COMMENT (W0.1), DRIFT (W1), SYBIL-emisión (W2), SYBIL-scoring (W3), RACE (W4).
> Orden serial dentro de la HU (sin conflicto de archivos cruzados salvo
> reputation↔compose, que se ordenan W2→W3). W0 primero (carry-forward: campo
> opcional + tsc gate).

---

## 8. Test Plan (≥1 por AC)

| Test | AC | Wave | Framework | Qué verifica |
|------|----|------|-----------|--------------|
| Lint/grep del comentario | AC-1 | W0 | revisión | sin "SOLO para delegación", menciona master+delegación. |
| `a2a-key.test.ts` master 400 (header desconocido) | AC-3 | W1 | vitest | 400 `CHAIN_NOT_SUPPORTED` post-refactor, **sin cambiar el test** (equivalencia). |
| `a2a-key.test.ts` master 500 (sin chain) | AC-4 | W1 | vitest | 500 `REGISTRY_NOT_INITIALIZED` post-refactor, sin cambiar el test. |
| `a2a-key.test.ts` master happy (chain válida) | AC-2 | W1 | vitest | `request.resolvedChainId` correcto + debit con chainId del bundle. |
| Suite completa (1324) | AC-5/CD-9 | W1-W4 | vitest | 0 regresiones tras cada wave. |
| `delegation-atomicity.real.test.ts` concurrencia | AC-6 | W4 | vitest (gated) | 2 rpc concurrentes → 1 ok + 1 `DELEGATION_TOTAL_LIMIT_EXCEEDED`; `total_spent = M` (no-double-spend). |
| `delegation-atomicity.real.test.ts` gating | AC-7/AC-8 | W4 | vitest | `describe.skipIf` skippea sin env + warn claro; con env corre contra PG real (no mock). |
| `delegation.test.ts` docstring + tests mock | CD-4 | W4 | vitest | mapeo de errores RPC intacto + comentario de separación de responsabilidades. |
| `caller-hash.test.ts` determinismo | AC-9/CD-11 | W0 | vitest | mismo ownerRef + mismo secret → mismo hash; secrets distintos → hashes distintos. |
| `caller-hash.test.ts` no-leak | AC-10/CD-5/6 | W0 | vitest | el output es hex HMAC (no contiene el ownerRef raw); es HMAC (cambia con el secret). |
| `caller-hash.test.ts` null passthrough | AC-12 | W0 | vitest | null/undefined/'' → `null`. |
| `compose.test.ts` emit success | AC-9 | W2 | vitest | `compose_step` success → `metadata.caller_ref_hash` = HMAC del owner_ref. |
| `compose.test.ts` emit failed | AC-9 | W2 | vitest | `compose_step` failed → `metadata.caller_ref_hash` presente. |
| `compose.test.ts` anónimo | AC-12 | W2 | vitest | sin `scopingKeyRow` → `caller_ref_hash: null`; raw nunca en metadata (AC-10). |
| `reputation.test.ts` cap mismo caller | AC-11/CD-7 | W3 | vitest | 1 caller × N tasks (N>K) → `tasks_settled = K` (autopago no infla). |
| `reputation.test.ts` callers distintos | AC-11 | W3 | vitest | M callers × 1 task → `tasks_settled = M` (callers distintos suman). |
| `reputation.test.ts` bucket null | AC-12/CD-8 | W3 | vitest | eventos sin hash → bucket `__anon__` capeado a K; score no colapsa a null. |
| `reputation.test.ts` cap mixto | AC-11 | W3 | vitest | caller A (N>K) + caller B (1) → `tasks_settled = K + 1`. |
| `reputation.test.ts` 1 query | CD-10 | W3 | vitest | batch sigue siendo `.in('agent_id', slugs)` 1 SELECT (assert call-count del builder). |

---

## 9. Lecciones Auto-Blindaje aplicadas (HUs 101/102/103)

Patrones recurrentes detectados (≥2 HUs) → bakeados como CD/notas para el Dev:

| Patrón recurrente | Origen | Aplicado en este SDD |
|-------------------|--------|----------------------|
| `biome check --write` ANTES de `npm run lint` (format gate) | WKH-101 W5 + WKH-102 + WKH-103 CD-17 (**3 HUs**) | Gate W0 + nota en cada wave. |
| Agregar arg/campo opcional rompe `toHaveBeenCalledWith` exactos | WKH-101 W4 + WKH-103 carry (**2 HUs**) | Nota W2/W3: revisar TODOS los call-sites de `eventService.track` y del builder de reputación en tests; `caller_ref_hash` y `metadata` son nuevos campos. |
| Mockear el **service consumidor** (no solo el transporte) cuando un test hace `vi.stubGlobal('fetch')` + assert call-count y el path llama a un service que usa Supabase | WKH-103 W4 | Gate W3: `vi.mock('./reputation.js')`/`supabase.js` en callers que cuentan fetch (discovery.ssrf). |
| PROHIBIDO propagar `error.message` crudo de Supabase/PG al caller | WKH-101 AR + WKH-103 CD-18 (**2 HUs**) | Reafirmado: scoring query falla → log + null. RACE test es solo test (no expone al caller). |
| Enumerar TODOS los `RAISE` de la cadena plpgsql al mapear errores | WKH-101 fix-pack | RACE test assertea sobre el mensaje `DELEGATION_TOTAL_LIMIT_EXCEEDED` real del RPC (no inventa). |

---

## 10. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Refactor DRIFT introduce regresión sutil en master | M | A | CD-1/CD-12: diff mínimo (4 líneas), helper verbatim verificado §3, 1324 tests + tests 400/500 sin cambios. |
| Cap por caller baja scores existentes inflados | A | M (esperado) | Es el objetivo anti-sybil (CD-8). Documentar en JSDoc + done-report. No colapsa a null. |
| Test real ensucia DB compartida (dev) | M | M | CD-13: cleanup `afterAll` + IDs con prefijo de test. |
| `caller_ref_hash` rompe `toHaveBeenCalledWith` de tests de compose existentes | M | B | Carry WKH-101: revisar todos los call-sites de `track` en `compose.test.ts`. |
| Secret HMAC ausente en prod → hashes con dev-secret | B | M | DT-1: warn en log; determinismo intra-deployment preservado; documentar env requerida. |
| Test gated nunca corre en CI (queda "verde" por skip) | M | M | CD-3/CD-14: documentar cómo correrlo (env) en el docstring + done-report; QA debe ejecutarlo manualmente al menos 1 vez con DB real. |

## 11. Dependencias

- RPC `debit_delegation_and_parent` aplicado en la DB (migración
  `20260601000000_a2a_delegations.sql`) — confirmado en repo.
- Para ejecutar TD-RACE-TEST: una DB Postgres real accesible vía
  `INTEGRATION_TEST_DB_URL` + service key. Sin ella → skip honesto.
- `node:crypto` (Node 20) + `@supabase/supabase-js` (ya en `package.json`).

## 12. Env nuevas

| Env | Default (degradación) | Uso | Notas |
|-----|----------------------|-----|-------|
| `REPUTATION_MAX_TASKS_PER_CALLER` | `5` (si ausente/inválido) | K del cap por caller (AC-11/CD-7). | `Number.isFinite && >0`; patrón `resolveScaleFactor`. |
| `REPUTATION_CALLER_HMAC_SECRET` | `"wasiai-dev-caller-hmac-v1"` + `console.warn` | Secret del HMAC del `caller_ref_hash` (DT-1/CD-6). | En prod DEBE setearse (secret real). Determinismo intra-deployment. |
| `INTEGRATION_TEST_DB_URL` | (ausente → skip) | URL Supabase de la DB de test para TD-RACE-TEST (AC-7/8). | Solo test. |
| `INTEGRATION_TEST_SERVICE_KEY` | (ausente → skip) | service_role key para ejecutar el RPC (REVOKE anon/authenticated). | Solo test; CD-14. |

> Acción para Docs: actualizar `.env.example` con las 4 (las 2 de test marcadas
> como opcionales / solo-integración).

---

## 13. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno) | — | NC-1 resuelto por el humano (cap por caller). Estrategia RACE resuelta (DT-3 confirmado + service_role aclarado). | No |

> Nombre de la env del secret: el work-item DT-1 sugería `CALLER_HASH_SALT`; el
> prompt del humano especifica `REPUTATION_CALLER_HMAC_SECRET`. **Se usa el del
> humano** (`REPUTATION_CALLER_HMAC_SECRET`) por ser la instrucción más reciente
> y explícita. No es ambigüedad bloqueante.

---

## 14. Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC (1-12) tiene ≥1 archivo asociado en §4.1 y ≥1 test en §8
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read/Glob (rutas reales)
[x] No hay [NEEDS CLARIFICATION] pendientes (NC-1 resuelto: cap por caller)
[x] Constraint Directives: 9 heredados + 6 específicos (≥3 PROHIBIDO) ✓
[x] Context Map: 13 archivos leídos (≥2) ✓
[x] Scope IN / OUT explícitos y no ambiguos ✓
[x] BD: tablas verificadas que existen (a2a_events/delegations/agent_keys + RPC) ✓
[x] Happy Path completo (reputación + atomicidad) ✓
[x] Flujo de error definido (DRIFT 400/500, RACE skip, SYBIL graceful) ✓
[x] Env nuevas con defaults / degradación segura documentadas ✓
[x] Backward-compat: master path (CD-1), AgentReputation shape, sin schema change ✓
[x] Anti-mock-teatro: RACE test gated + cleanup + service_role documentado ✓
[x] Anti-N+1: scoring mantiene 1 query/path (CD-10) ✓
[x] Privacidad: HMAC, nunca raw owner_ref (CD-5/6) ✓
```

**Veredicto: PASS — listo para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL — WKH-104*
