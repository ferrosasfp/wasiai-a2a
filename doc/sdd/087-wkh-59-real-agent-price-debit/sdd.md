# SDD — WKH-59 Middleware /compose debit reads real agent price

> Status: F2 (SDD generated, pending SPEC_APPROVED)
> Pipeline: QUALITY · Branch: feat/087-wkh-59-real-agent-price-debit
> Author: nexus-architect · Date: 2026-05-14

---

## 1. Resumen ejecutivo

`requirePaymentOrA2AKey` debita placeholder $1.00 USD por request a `/compose` (`src/middleware/a2a-key.ts:127-130`), ignorando `agent.priceUsdc` real del registry. La solución reusa el patrón ya productivo de `/gasless/transfer` (WKH-59 fase gasless, ver `src/routes/gasless.ts:31-71`): un preHandler upstream resuelve el precio real y lo inyecta como campo augmentado del request, sin tocar la lógica core del middleware. Para steps 2..N en compose, `composeService.compose` debita atómicamente vía `budgetService.debit` usando el `chainId` propagado desde el middleware.

Resultados clave:
- Cache in-process `Map<string, {price; expiresAt}>` TTL 60s en nuevo módulo `src/services/agent-price.ts` (sin Redis — `package.json` no tiene ioredis).
- 6 waves: W0 type augmentation → W1 agent-price service → W2 middleware ternario extension → W3 compose preHandler + 404/503 guards → W4 multi-step debit en compose service → W5 integration + E2E.
- 8 archivos modificados/creados (3 nuevos: agent-price.ts + tests + integration test).
- 13+ tests nuevos cubriendo AC-1 a AC-11.
- Zero breaking changes: `/gasless/transfer`, `/discover`, `/orchestrate` quedan intactos (placeholder $1 sigue activo cuando no se inyecta `composeEstimatedCostUsd`).

Riesgos identificados: (a) double-debit del step 0 si el route handler también debita; (b) race del map sin lock — aceptable, los reads son atomic en V8 single-threaded; (c) chainId desync entre middleware bundle y compose service — mitigado vía `request.resolvedChainId` augmentado. No hay blockers; lista para SPEC_APPROVED.

---

## 2. Codebase grounding (archivos leídos + exemplars)

Archivos leídos para grounding (path:line-range):

| Archivo | Líneas | Patrón extraído |
|---------|-------|-----------------|
| `src/middleware/a2a-key.ts:1-296` | full | Augmentation pattern (línea 27-32: `declare module 'fastify'`), ternario `gaslessEstimatedCostUsd ?? 1.0` (línea 127-130), `bundle.chainConfig.chainId` (línea 220), `keyRow.owner_ref` (línea 250) |
| `src/routes/gasless.ts:1-149` | full | **Exemplar maestro** del patrón preHandler de cost injection (línea 31-71: `gaslessCostEstimatorPreHandler` — body parse, validation, cap check, inyección en línea 70) |
| `src/routes/compose.ts:1-95` | full | preHandler array actual (línea 24-35), spread `...requireForwardKey()` + `...requirePaymentOrA2AKey` |
| `src/services/compose.ts:1-366` | full | Loop de steps (línea 64-254), `resolveAgent` (línea 263-272), uso de `scopingKeyRow.owner_ref` (línea 172), `totalCost += agent.priceUsdc` (línea 137) — el "fantasma" del debit que nunca persiste |
| `src/services/discovery.ts:113-376` | partial | `getAgent(slug, registryId?)` retorna `Agent \| null` (línea 336-375); `mapAgent` mapea `priceUsdc` vía `resolvePriceWithFallback` (línea 316) |
| `src/services/budget.ts:1-85` | full | `debit(keyId, chainId, amountUsd)` vía RPC `increment_a2a_key_spend` (línea 47-63); `getBalance(keyId, chainId, ownerId)` con ownership guard (línea 19-41) — patrón WKH-53 |
| `src/types/index.ts:1-220` | partial | `ComposeStep.agent: string` (línea 162-171), `Agent.priceUsdc: number` (línea 124), `ComposeRequest.scopingKeyRow` (línea 184-185) |
| `src/middleware/a2a-key.test.ts:840-927` | partial | **Exemplar de test pattern** — T-MW-GASLESS-1/2 muestran cómo testear el ternario con un Fastify local que inyecta el campo augmentado |
| `src/routes/compose.test.ts:1-172` | full | Mock pattern de `requirePaymentOrA2AKey` retornando `[handler]` que setea `a2aKeyRow` |
| `src/routes/gasless.test.ts:200-279` | partial | T-DRAIN-1/2/3/4 — exemplar de tests E2E con preHandler + middleware encadenados |
| `src/services/compose.test.ts:1-80` | partial | Mock patterns para discovery/registry/payment-adapter |
| `doc/sdd/087-wkh-59-real-agent-price-debit/work-item.md` | full | Inputs canónicos: ACs, CDs, DT-A..DT-E |

Exemplars verificados con Glob (paths existen en disco):

- `src/middleware/a2a-key.ts` (10.2K) ✓
- `src/routes/gasless.ts` (5.2K) ✓
- `src/routes/compose.ts` (3.0K) ✓
- `src/services/compose.ts` (13.8K) ✓
- `src/services/discovery.ts` (15.8K) ✓
- `src/services/budget.ts` (2.3K) ✓
- `src/types/index.ts` ✓
- `src/middleware/a2a-key.test.ts` (29.6K) ✓
- `src/routes/compose.test.ts` (5.2K) ✓
- `src/routes/gasless.test.ts` (12.3K) ✓
- `src/services/compose.test.ts` (34.3K) ✓

Auto-blindajes leídos:
- `doc/sdd/086-wkh-multichain-a2a/` — sin auto-blindaje (HU sin errores).
- `doc/sdd/084-wkh-69-passport-hybrid-inbound/auto-blindaje.md` — TS6059 rootDir cross-import (aplica si nuevos tests cruzan a `test/`; W1-W5 mantienen tests dentro de `src/`).
- `doc/sdd/082-wkh-86-migration-preflight-refinements/auto-blindaje.md` — dedup order-sensitivity (no aplica aquí).
- `doc/sdd/080-wkh-88-bearer-rotation-refinements/auto-blindaje.md` — **APLICA**: cuando agregás una nueva call a un stub `failNext`-based, todos los tests que cuentan calls se rompen. Mitigación documentada en W2 (no usar `failNext` sino mocks por-call-shape).

---

## 3. Arquitectura de la solución

### Flow diagram (post-WKH-59)

```
POST /compose
   │
   ▼
[preHandler 1] requireForwardKey()           ── env-gated, no-op por default (WKH-65)
   │
   ▼
[preHandler 2] createTimeoutHandler(180000)   ── WKH-18, timeout watcher
   │
   ▼
[preHandler 3] resolveComposePriceHandler  ◄── NUEVO en W3 (this HU)
   │  ├─ Lee request.body.steps[0].agent (+ registry?)
   │  ├─ Llama agent-price.resolveAgentPriceUsdc(slug, registry?)
   │  │     └─ Cache hit (TTL<60s) → retorna precio cacheado
   │  │     └─ Cache miss → discoveryService.getAgent → price → setCache → retorna
   │  ├─ Si price === null/undefined/0 → fallback $1 + warn + header
   │  ├─ Si discovery throws → 503 REGISTRY_UNAVAILABLE (NO debit)
   │  ├─ Si agent no encontrado → 404 AGENT_NOT_FOUND (NO debit)
   │  └─ request.composeEstimatedCostUsd = price  ◄── inyectado
   │
   ▼
[preHandler 4] requirePaymentOrA2AKey(...)
   │  ├─ Detecta x-a2a-key
   │  ├─ const estimatedCostUsd =
   │  │    typeof request.composeEstimatedCostUsd === 'number'
   │  │      ? request.composeEstimatedCostUsd         ◄── NUEVO en W2
   │  │      : typeof request.gaslessEstimatedCostUsd === 'number'
   │  │        ? request.gaslessEstimatedCostUsd
   │  │        : 1.0;
   │  ├─ resolveChainKey → bundle.chainConfig.chainId
   │  ├─ request.resolvedChainId = chainId            ◄── NUEVO en W2 (DT-D)
   │  ├─ budgetService.debit(keyRow.id, chainId, estimatedCostUsd)   ◄── debit del STEP 0
   │  └─ request.a2aKeyRow = keyRow
   │
   ▼
[route handler] async (request, reply) => {
   │
   ▼
composeService.compose({
   │  steps, maxBudget, a2aKey, scopingKeyRow,
   │  chainId: request.resolvedChainId,           ◄── NUEVO en W3 (DT-D)
   │ })
   │
   ▼
   for (let i = 0; i < steps.length; i++) {
     const agent = await resolveAgent(step);
     ...
     if (i > 0 && scopingKeyRow && chainId) {     ◄── NUEVO en W4
       const result = await budgetService.debit(    ◄── debit STEPS 2..N
         scopingKeyRow.id,
         chainId,
         agent.priceUsdc,
       );
       if (!result.success) → abort pipeline con error 'INSUFFICIENT_BUDGET' para step i
     }
     await invokeAgent(...);
   }
```

### Cache strategy

**Módulo**: `src/services/agent-price.ts` (nuevo, ~80 LOC).

```typescript
// CD-1: TypeScript strict, sin `any`.
type CacheEntry = { price: number; expiresAt: number };
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(slug: string, registryName?: string): string {
  // DT-B clave de cache: scoping por registry para evitar colisiones.
  return `${slug}::${registryName ?? '_all_'}`;
}

export async function resolveAgentPriceUsdc(
  agentSlug: string,
  registryName?: string,
): Promise<number | null> {
  const key = cacheKey(agentSlug, registryName);
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.price;   // ◄── cache hit < 5ms (AC-8)
  }
  // Cache miss o expired
  const agent = await discoveryService.getAgent(agentSlug, registryName);
  if (!agent) return null;
  const price = agent.priceUsdc;
  cache.set(key, { price, expiresAt: now + CACHE_TTL_MS });   // ◄── AC-9 re-fetch + new TTL
  return price;
}

/** TEST-ONLY: reset del cache para evitar cross-test contamination. */
export function _resetAgentPriceCache(): void {
  cache.clear();
}
```

**Justificación del Map vs Redis**: el `package.json` (verificado) no tiene `ioredis`/`redis` dep para uso application-level (Redis cache referenciado en `project-context.md` no está instalado en el codebase actual; solo BullMQ usa la conexión Redis y vive aislado en `src/lib/queue.ts`). Un Map in-process con TTL 60s es suficiente: Railway corre 1 instancia, multi-instance tendría TTL-independence aceptable. Patrón análogo: `src/services/discovery.ts:23` (`_warnedFallbackSlugs: Set` module-scoped).

### Propagación de chainId (DT-D)

El middleware ya resuelve `chainId` en línea 220 (`const chainId = bundle.chainConfig.chainId`). El SDD lo augmenta:

```typescript
// W2: extensión de la augmentation existente
declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;
    gaslessEstimatedCostUsd?: number;
    composeEstimatedCostUsd?: number;  // ◄── NUEVO (CD-9)
    resolvedChainId?: number;          // ◄── NUEVO (DT-D)
  }
}
```

El route handler de compose extrae `request.resolvedChainId` y lo pasa a `composeService.compose({ ...request, chainId: request.resolvedChainId })`. **Tipo de `ComposeRequest`** (W0 también extiende esto):

```typescript
// src/types/index.ts — ComposeRequest extendido
export interface ComposeRequest {
  steps: ComposeStep[];
  maxBudget?: number;
  a2aKey?: string;
  scopingKeyRow?: A2AAgentKeyRow;
  chainId?: number;  // ◄── NUEVO (W0). Optional para no romper callers (x402 path).
}
```

**Por qué optional**: el path x402 no setea `resolvedChainId` (lo setea el branch a2a-key del middleware). Si `chainId` es `undefined` en compose service, el debit per-step se **skipea** (compatible con WKH-61: si no hay `scopingKeyRow`, no hay tenant; análogo aquí: si no hay chainId resuelto, no hay debit).

---

## 4. Waves (orden de implementación)

### W0 — Type augmentation (serial, blocking W1+)

**Archivo modificado**: `src/types/index.ts`

**Cambios**:
- Línea 173-186 (`ComposeRequest`): agregar campo opcional `chainId?: number` con JSDoc explicando DT-D.

**No requiere cambios** en la declaration merging de Fastify (vive en `src/middleware/a2a-key.ts` línea 27-32, se modifica en W2).

**Test**: `npm run typecheck` PASS (CD-1).

**Riesgo**: cero (campo opcional, no rompe consumers existentes).

---

### W1 — agent-price service + tests (paralelizable con W2)

**Archivos nuevos**:
- `src/services/agent-price.ts` (~80 LOC)
- `src/services/agent-price.test.ts` (~150 LOC)

**Función exportada**:
```typescript
export async function resolveAgentPriceUsdc(
  agentSlug: string,
  registryName?: string,
): Promise<number | null>;

export function _resetAgentPriceCache(): void; // TEST-ONLY
```

**Cobertura de tests** (mínimo 5 tests):

| ID | Caso | AC |
|----|------|----|
| T-PRICE-1 | cache miss → llama `discoveryService.getAgent` → guarda entrada | AC-9 |
| T-PRICE-2 | cache hit (TTL no expirado) → NO llama getAgent → < 5ms | AC-8 |
| T-PRICE-3 | TTL expirado (advance timers >60s) → re-fetch + nuevo TTL | AC-9 |
| T-PRICE-4 | `getAgent` retorna null → función retorna null (no cachea negativo) | AC-3 prep |
| T-PRICE-5 | `getAgent` throws → la función PROPAGA (lo captura el preHandler de compose como 503) | AC-5 prep |
| T-PRICE-6 | priceUsdc = 0 → cachea 0 (el preHandler hace fallback, no este servicio) | AC-4 prep |
| T-PRICE-7 | dos slugs distintos → dos entradas separadas en cache (key correctness) | DT-B |
| T-PRICE-8 | mismo slug, dos registries → dos entradas (registry scoping) | DT-B |

**Mocks**: vi.mock de `./discovery.js` con `getAgent: vi.fn()`. Reset entre tests vía `_resetAgentPriceCache()` + `vi.useFakeTimers()` para los casos de TTL.

**Dependencias**: SOLO `discoveryService.getAgent`. Sin DB, sin Supabase directo.

**Cubre**: AC-8, AC-9. Soporte para AC-3, AC-4, AC-5 (que se cubren E2E en W3).

---

### W2 — middleware extension (paralelizable con W1)

**Archivos modificados**:
- `src/middleware/a2a-key.ts`
- `src/middleware/a2a-key.test.ts`

**Cambios en `a2a-key.ts`**:

1. **Línea 27-32** — extender augmentation:
```typescript
declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;
    gaslessEstimatedCostUsd?: number;
    composeEstimatedCostUsd?: number; // WKH-59 (real-price-debit)
    resolvedChainId?: number;         // WKH-59 DT-D
  }
}
```

2. **Línea 127-130** — extender ternario (orden: composeEstimatedCostUsd primero, luego gasless, luego placeholder):
```typescript
// WKH-59 (real-price-debit): /compose inyecta el precio real del primer step
// vía request.composeEstimatedCostUsd. /gasless/transfer ya inyectaba
// request.gaslessEstimatedCostUsd. Otras rutas (/discover, /orchestrate)
// quedan con $1 placeholder.
// CD-7: el middleware NO lee request.body — solo campos augmentados.
const estimatedCostUsd =
  typeof request.composeEstimatedCostUsd === 'number'
    ? request.composeEstimatedCostUsd
    : typeof request.gaslessEstimatedCostUsd === 'number'
      ? request.gaslessEstimatedCostUsd
      : 1.0;
```

3. **Línea 220** — augmentar chainId al request (post-bundle resolution, pre-debit):
```typescript
const chainId = bundle.chainConfig.chainId;
const assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN';

// WKH-59 DT-D: propagar al route handler para que composeService haga
// debit per-step (steps 2..N) con el MISMO chainId del bundle (CD-12).
request.resolvedChainId = chainId;
```

**Cambios en `a2a-key.test.ts`**:

| ID | Caso | AC | Notas |
|----|------|----|---|
| T-MW-COMPOSE-1 | con `composeEstimatedCostUsd=0.001` inyectado → `debit(keyId, 2368, 0.001)` | AC-1 | Patrón identico a T-MW-GASLESS-2 línea 909-924, copiar shape |
| T-MW-COMPOSE-2 | con `composeEstimatedCostUsd=0.05` Y `gaslessEstimatedCostUsd=10` → debit usa 0.05 (priority) | DT-D consistency | Asegura precedence del ternario |
| T-MW-COMPOSE-3 | sin ninguno → debit 1.0 (regresión, ya cubierto por T-MW-GASLESS-1 pero re-confirma) | AC-7 | smoke |
| T-MW-COMPOSE-4 | después del debit, `request.resolvedChainId === chainId` (assert via route handler) | DT-D | Verificable con `request.routeOptions` o un handler de test que persista el valor |

**Anti-blindaje aplicado** (de WKH-88): NO usar `failNext` en mocks — usar mocks por-call-shape donde el orden importa.

**Cubre**: AC-1, AC-4 (parcial: el debit con 1.0 cuando fallback), AC-6, AC-7.

---

### W3 — compose preHandler + route + 404/503/fallback (depende de W1, W2)

**Archivos modificados**:
- `src/routes/compose.ts`

**Cambio 1** — agregar preHandler `resolveComposePriceHandler` ANTES de `requirePaymentOrA2AKey`:

```typescript
async function resolveComposePriceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { steps?: ComposeStep[] } | undefined;

  // AC-3 setup: shape validation antes de tocar agent-price.
  // NO 400 acá — dejamos que el route handler haga la validación rica de
  // steps (length 1..5, etc.). Si steps es vacío/inválido, este preHandler
  // se skipea y el route handler responde 400 (linea 41-50 del existing).
  if (!body?.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return; // route handler responde 400
  }

  const firstStep = body.steps[0];
  if (!firstStep || typeof firstStep.agent !== 'string') {
    return; // route handler responde 400
  }

  try {
    const price = await resolveAgentPriceUsdc(firstStep.agent, firstStep.registry);

    if (price === null) {
      // AC-3: agente no existe en ningún registry → 404, no debit.
      reply.status(404).send({
        error: `Agent not found: ${firstStep.agent}`,
        error_code: 'AGENT_NOT_FOUND',
      });
      return;
    }

    // AC-4 fallback: price === 0 (config inválida en registry) → $1 + warn + header.
    if (price === 0) {
      request.log.warn(
        { reason: 'registry-miss', slug: firstStep.agent, registry: firstStep.registry ?? null },
        'compose-price.fallback',
      );
      reply.header('x-debit-fallback', 'registry-miss');
      request.composeEstimatedCostUsd = 1.0;
      return;
    }

    // Happy path AC-1.
    request.composeEstimatedCostUsd = price;
  } catch (err) {
    // AC-5: error de DB/discovery → 503, NO debit.
    request.log.error(
      { err: err instanceof Error ? err.message : 'unknown', slug: firstStep.agent },
      'compose-price.registry-unavailable',
    );
    reply.status(503).send({
      error: 'Registry temporarily unavailable',
      error_code: 'REGISTRY_UNAVAILABLE',
    });
    return;
  }
}
```

**Cambio 2** — ordenar preHandler array (DT-E):

```typescript
preHandler: [
  ...requireForwardKey(),
  createTimeoutHandler(parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '180000', 10)),
  resolveComposePriceHandler,   // ◄── NUEVO, ANTES de requirePaymentOrA2AKey
  ...requirePaymentOrA2AKey({ description: 'WasiAI Compose Service ...' }),
],
```

**Cambio 3** — route handler propaga `chainId` al composeService:

```typescript
const result = await composeService.compose({
  steps: body.steps,
  maxBudget: body.maxBudget,
  a2aKey,
  scopingKeyRow: request.a2aKeyRow,
  chainId: request.resolvedChainId,  // ◄── NUEVO (DT-D)
});
```

**Cubre**: AC-3, AC-4, AC-5. Soporte E2E para AC-1.

**Tests** (en `src/routes/compose.test.ts` extendido):

| ID | Caso | AC | Notas |
|----|------|----|---|
| T-ROUTE-PRICE-1 | step[0].agent existe, priceUsdc=0.001 → preHandler setea `composeEstimatedCostUsd=0.001`, downstream OK | AC-1 | Mock de `resolveAgentPriceUsdc` |
| T-ROUTE-PRICE-2 | step[0].agent NO existe (mock retorna null) → 404 AGENT_NOT_FOUND, no debit, no middleware | AC-3 | assert `mockDebit.not.toHaveBeenCalled()` |
| T-ROUTE-PRICE-3 | priceUsdc=0 → log.warn, header `x-debit-fallback: registry-miss`, debit con $1 | AC-4 | assert `res.headers['x-debit-fallback'] === 'registry-miss'` |
| T-ROUTE-PRICE-4 | `resolveAgentPriceUsdc` throws → 503 REGISTRY_UNAVAILABLE, no debit | AC-5 | mock rejecting promise |
| T-ROUTE-PRICE-5 | preHandler short-circuita (reply.sent=true) → middleware no corre | CD-10 | Implícito en T-ROUTE-PRICE-2/4 |

**Anti-hallucination check**:
- ✓ `resolveAgentPriceUsdc` viene de `'../services/agent-price.js'` (W1) — verificado por compilación.
- ✓ `FastifyRequest['composeEstimatedCostUsd']` está declarado en `a2a-key.ts` (W2) — verificado por TS strict.

---

### W4 — compose service multi-step debit (depende de W0, W3)

**Archivos modificados**:
- `src/services/compose.ts`
- `src/services/compose.test.ts`

**Cambios en `compose.ts`**:

1. **Línea 59** — destructurar `chainId` de request:
```typescript
async compose(request: ComposeRequest): Promise<ComposeResult> {
  const { steps, maxBudget, a2aKey, scopingKeyRow, chainId } = request;
  ...
}
```

2. **Dentro del loop, ANTES de `invokeAgent` (post-scoping, post-maxBudget check)** — para `i > 0`:
```typescript
// WKH-59 (real-price-debit): steps 2..N debit atómico via budgetService.debit.
// Step 0 ya fue debitado en el middleware (request.composeEstimatedCostUsd).
// Skip si no hay scopingKeyRow (path x402) o no hay chainId (defensive).
// CD-2: atómico via increment_a2a_key_spend PG function (NO update manual).
if (i > 0 && scopingKeyRow && chainId !== undefined) {
  const debitResult = await budgetService.debit(
    scopingKeyRow.id,
    chainId,
    agent.priceUsdc,
  );
  if (!debitResult.success) {
    return {
      success: false,
      output: null,
      steps: results,
      totalCostUsdc: totalCost,
      totalLatencyMs: totalLatency,
      error: `Step ${i} debit failed: ${debitResult.error ?? 'insufficient budget'}`,
      // No errorCode discriminator — el route mapea a 400 (default), no 403,
      // porque a estas alturas el caller YA pagó step 0 y pasó middleware.
      // Documentado en DT-A: debit per-step puede fallar mid-pipeline.
    };
  }
}
```

**Justificación del orden** (debit antes de invokeAgent):
- Patrón Stripe-style "charge first, deliver after" (consistente con middleware línea 226-243).
- Si invokeAgent falla post-debit, el budget queda debitado — comportamiento "fee-on-attempt" deliberado, igual que gasless DT-F (`src/routes/gasless.ts:11-14`).
- AR debe verificar que NO hay double-debit del step 0: el guard `i > 0` es la única defensa. Si alguien quita el guard, double-debit.

**Tests** en `src/services/compose.test.ts`:

| ID | Caso | AC | Notas |
|----|------|----|---|
| T-COMPOSE-DEBIT-1 | 2 steps, ambos OK → 1 debit en service (step 1), step 0 implícito del middleware | AC-2 | mock `budgetService.debit` → success, assert called once con `(keyId, chainId, agent.priceUsdc)` |
| T-COMPOSE-DEBIT-2 | 3 steps, todos OK → 2 debits en service (steps 1, 2) | AC-2 | assert calledTimes(2) |
| T-COMPOSE-DEBIT-3 | step 1 debit falla (insufficient) → pipeline aborta con `success: false`, step 2 NO se ejecuta | AC-2 fail path | assert `mockInvoke.not.toHaveBeenCalledWith(step2)` |
| T-COMPOSE-DEBIT-4 | path x402 (sin `scopingKeyRow`) → cero debits en service (backward-compat) | AC-2 backward | `scopingKeyRow: undefined` |
| T-COMPOSE-DEBIT-5 | `chainId` undefined → cero debits en service (defensive skip) | DT-D defensive | edge case |
| T-COMPOSE-DEBIT-6 | step 0 NO se debita en el service (guard `i > 0`) | anti-double-debit | assert primer call de debit es para step 1, no step 0 |

**Anti-hallucination check**:
- ✓ `budgetService.debit` ya existe (`src/services/budget.ts:47-63`) y acepta `(keyId, chainId, amountUsd)` — verificado.
- ✓ `scopingKeyRow.id` es `A2AAgentKeyRow.id` (UUID string) — verificado en `src/types/a2a-key.ts`.

**Cubre**: AC-2.

---

### W5 — integration tests + E2E (depende de W1, W2, W3, W4)

**Archivos modificados**:
- `src/routes/compose.test.ts` (agregar suite end-to-end)
- (opcional) `src/middleware/a2a-key.test.ts` (agregar 1 test integración)

**Tests E2E** (integración middleware + preHandler + service):

| ID | Caso | AC | Notas |
|----|------|----|---|
| T-E2E-PRICE-1 | POST /compose, agent.priceUsdc=0.001 → middleware debit 0.001 + composeService skip debit (1 step) | AC-1 | Verificar `request.composeEstimatedCostUsd === 0.001` post-preHandler, `mockDebit` llamado con 0.001 |
| T-E2E-PRICE-2 | POST /compose, 3 steps (priceUsdc 0.001 / 0.05 / 0.01) → debit total $0.061 (NO $3) | AC-2 + AC-11 | 1 debit en middleware (0.001) + 2 debits en service (0.05 + 0.01) |
| T-E2E-PRICE-3 | POST /compose, agente desconocido → 404 sin debit alguno | AC-3 | response 404, mockDebit never called |
| T-E2E-PRICE-4 | POST /compose, agente con priceUsdc=null en registry → fallback $1 + header + warn log | AC-4 | response 200, header `x-debit-fallback` |
| T-E2E-PRICE-5 | POST /compose, discovery throws → 503 REGISTRY_UNAVAILABLE | AC-5 | no debit |
| T-E2E-PRICE-6 | (smoke) POST /gasless/transfer post-WKH-59 → sigue funcionando como antes (regresión) | AC-6 | NO `composeEstimatedCostUsd` seteado, gasless lo inyecta |
| T-E2E-PRICE-7 | (smoke) POST /discover post-WKH-59 → $1 placeholder (backward-compat) | AC-7 | smoke |

**AC-10** (no regression 644+ tests): cubierto por `npm test` en CI; no requiere test nuevo.

**AC-11** (E2E real con WasiAgentShop): cubierto por QA en F4 con la testnet key y agentes reales (kyc/corridor/cashout). El test unitario T-E2E-PRICE-2 simula la misma topología con mocks.

**Anti-blindaje aplicado** (de WKH-88): mocks aislados por test, reset de `_resetAgentPriceCache()` en `beforeEach`, NO `failNext`.

---

## 5. Decisiones técnicas adicionales (surgidas del codebase reading)

### DT-F (nueva): orden de los ternarios en el middleware

**Decisión**: La cadena es `composeEstimatedCostUsd → gaslessEstimatedCostUsd → 1.0` (en ese orden).

**Justificación**: `/compose` y `/gasless/transfer` son rutas mutuamente excluyentes (un request va a una o la otra). En la práctica, sólo un campo se setea por request. El orden compose-first refleja que `/compose` es la ruta primaria (volumen) y `/gasless/transfer` es para movimientos on-chain administrativos. **NO** debería haber colisión en producción.

**Mitigación**: el test T-MW-COMPOSE-2 valida el orden por precaución.

### DT-G (nueva): cache negativo NO se persiste

**Decisión**: si `discoveryService.getAgent` retorna null, `resolveAgentPriceUsdc` retorna null SIN cachear la entrada.

**Justificación**: cachear "agente no existe" puede causar 404s persistentes si el agente se registra después. La penalización de re-fetch en cache miss es aceptable para esta categoría (cold path, ya estamos en error path). Análogo: `src/services/discovery.ts:23` cachea slugs warned, no slugs not-found.

### DT-H (nueva): el debit per-step NO mapea a 403

**Decisión**: si `budgetService.debit` falla mid-pipeline (step 1+), el `ComposeResult.errorCode` queda `undefined` → route handler responde 400 (no 403).

**Justificación**: a esa altura el caller YA pasó el middleware (autenticado + step 0 debited), entonces NO es un error de autorización (403 reservado para `SCOPE_DENIED` en WKH-61). Es un error de mid-execution budget exhaustion. El error en el response body deja claro que el debit falló.

**Alternativa rechazada**: agregar `errorCode: 'INSUFFICIENT_BUDGET'` y mapear a 402 Payment Required. Esto crearía un tercer estado (200/400/403/402), y el work-item no lo pide. Si más adelante se quiere, es backward-compat.

### DT-I — `/orchestrate` queda con placeholder $1 (alineado AC-7)

**Decisión**: NO portar el preHandler `resolveComposePriceHandler` a `/orchestrate`. Mantener placeholder $1 placebo para esa ruta.

**Justificación**:
- AC-7 declara `/orchestrate` explícitamente fuera de scope WKH-59.
- Portar el patrón requiere lógica adicional para "primera step" inferido por el orchestrator (LLM planner), lo cual es scope creep.
- AR (iter-1) levantó esta asimetría como MNR-3 (`src/services/orchestrate.ts:405-410`): /orchestrate no propaga `chainId` → per-step debits SKIPPED. La decisión documentada acá ratifica que es deliberado para esta HU.
- Follow-up: HU futura WKH-XX puede portar el patrón cuando la prioridad lo amerite.

**Implicación operacional**: callers que usan `/orchestrate` siguen pagando $1.00 placeholder (mismo comportamiento que pre-WKH-59). Documentar esta asimetría en API docs si es relevante.

### DT-J — fallback per-step en compose service (BLQ-MED-1 fix)

**Decisión**: replicar la lógica de fallback honesto del preHandler de step 0 (`src/routes/compose.ts:63-77`) dentro de `composeService.compose` para steps 2..N, vía un `logger?: DownstreamLogger` opcional en `ComposeRequest`.

**Justificación**:
- AR (iter-1) levantó BLQ-MED-1: en steps 2..N, `agent.priceUsdc === 0/null` debitaba raw (cero o NaN), violando CD-4 (fallback honesto).
- El service NO se acopla a Fastify: reusa el tipo estructural `DownstreamLogger` (`{ warn, info }`) ya canónico desde WKH-55. Pino logger (Fastify) es estructuralmente compatible.
- Cuando `logger` es `undefined`, se hace fallback a `console.warn` (paridad con `invokeAgent` que también acepta `logger?: DownstreamLogger`).

**Limitación operacional explícita**: NO se puede setear el header `x-debit-fallback: registry-miss` desde el service (la response ya está en pipeline una vez los steps 0..i-1 corrieron). Esa señal queda exclusiva del preHandler de step 0. En steps 2..N la observabilidad vive solo en el warn log estructurado:

```json
{ "reason": "registry-miss", "slug": "<agent.slug>", "step": <i>, "msg": "compose-price.fallback per-step" }
```

Operators monitoreando registries rotos deben observar BOTH el header (step 0) y el log warn (steps 2..N).

**Validación**: T-COMPOSE-DEBIT-7/8/9 verifican (a) debit con amount=$1, (b) emisión del warn log con shape exacto, (c) cobertura defensiva de `priceUsdc=null` (typeof guard).

---

## 6. Constraint Directives — heredados + nuevos

Heredados del work-item (sin cambios):

- **CD-1**: TypeScript strict — sin `any` explícito, sin `as unknown` para escapar tipos.
- **CD-2**: Debit sigue atómico via `increment_a2a_key_spend` PG function. NO debit manual.
- **CD-3**: Performance: < 50ms (DB miss), < 5ms (cache hit). No I/O en hot path del middleware.
- **CD-4**: Fallback honesto — `log.warn` + header `x-debit-fallback: registry-miss`.
- **CD-5**: NO regresión en 644+ tests baseline.
- **CD-6**: NO leak de `owner_ref` en logs ni errores. Ownership guard en `budgetService.debit` (WKH-53).
- **CD-7**: El middleware NO lee `request.body` — solo augmentaciones.
- **CD-8**: `resolveAgentPriceUsdc` SOLO en `src/services/agent-price.ts`. NO duplicar.
- **CD-9**: Campo augmentado `composeEstimatedCostUsd` ≠ `gaslessEstimatedCostUsd`. Sin colisión.
- **CD-10**: Si preHandler retorna 404/503, el middleware NO corre (Fastify short-circuit).

Nuevos del SDD:

- **CD-11 (nuevo)**: en `composeService.compose`, el guard `i > 0` para el debit per-step es la única defensa contra double-debit del step 0. AR/CR MUST verificar que esta línea no se remueva en futuras HUs.
- **CD-12 (nuevo)**: el `chainId` propagado del middleware al compose service DEBE venir del MISMO bundle resuelto en `bundle.chainConfig.chainId` (línea 220 de a2a-key.ts). NO hacer una segunda llamada a `resolveChainKey` en compose service (race condition latente).
- **CD-13 (nuevo)**: el `_resetAgentPriceCache()` es TEST-ONLY. NO se exporta desde un index.ts ni se importa en production code. Patrón análogo: `_resetFallbackWarnDedup` en `discovery.ts:26`.
- **CD-14 (nuevo / anti-blindaje WKH-88)**: en tests con múltiples calls a `budgetService.debit`, NO usar `failNext`. Usar `mockResolvedValueOnce` chained o mocks por-call-shape para evitar order-sensitivity drift.
- **CD-15 (nuevo)**: el preHandler de compose NO debe validar `steps.length > 5` ni `steps.length === 0` (eso ya lo hace el route handler en `compose.ts:40-58`). Si el preHandler agregara esa validación, sería duplicación de lógica.

---

## 7. Test plan (mínimo 1 test por AC + archivo)

| AC | Test ID | Archivo | Wave |
|----|---------|---------|------|
| AC-1 happy path debit step 0 | T-MW-COMPOSE-1 + T-E2E-PRICE-1 | `src/middleware/a2a-key.test.ts`, `src/routes/compose.test.ts` | W2, W5 |
| AC-2 debit per-step 2..N | T-COMPOSE-DEBIT-1/2/3 + T-E2E-PRICE-2 | `src/services/compose.test.ts`, `src/routes/compose.test.ts` | W4, W5 |
| AC-3 agent not found → 404 | T-ROUTE-PRICE-2 + T-E2E-PRICE-3 | `src/routes/compose.test.ts` | W3, W5 |
| AC-4 priceUsdc null/0 → fallback + warn + header | T-ROUTE-PRICE-3 + T-E2E-PRICE-4 | `src/routes/compose.test.ts` | W3, W5 |
| AC-5 registry error → 503 | T-ROUTE-PRICE-4 + T-E2E-PRICE-5 | `src/routes/compose.test.ts` | W3, W5 |
| AC-6 /gasless/transfer backward-compat | T-E2E-PRICE-6 | `src/routes/compose.test.ts` | W5 |
| AC-7 /discover, /orchestrate placeholder $1 | T-MW-COMPOSE-3 + T-E2E-PRICE-7 | `src/middleware/a2a-key.test.ts`, `src/routes/compose.test.ts` | W2, W5 |
| AC-8 cache hit < 5ms | T-PRICE-2 | `src/services/agent-price.test.ts` | W1 |
| AC-9 TTL expiry → re-fetch | T-PRICE-3 | `src/services/agent-price.test.ts` | W1 |
| AC-10 no regression | `npm test` full suite | N/A (CI) | W5 |
| AC-11 E2E WasiAgentShop $0.061 total | T-E2E-PRICE-2 (simulated) + QA real run | `src/routes/compose.test.ts` + F4 | W5 + F4 |

**Total tests nuevos esperados**:
- W1: 8 tests
- W2: 4 tests
- W3: 5 tests
- W4: 6 tests
- W5: 7 tests
- **Total**: ~30 tests nuevos.

**Baseline preservado**: 644+ existentes (CD-5).

---

## 8. Riesgos y mitigaciones

| # | Riesgo | Nivel | Mitigación |
|---|--------|-------|-----------|
| R1 | Double-debit del step 0 (middleware + compose service) | ALTO | CD-11 + guard `i > 0` + T-COMPOSE-DEBIT-6 |
| R2 | Discovery flaky / latencia → 503 muy frecuente | MEDIO | Cache TTL 60s reduce hits a discovery por orden de magnitud; AC-5 acepta 503 como degradación honesta |
| R3 | Backward-compat /gasless/transfer roto | ALTO | Ternario preserva fallback gasless; T-MW-GASLESS-1/2 (existentes) + T-E2E-PRICE-6 nuevo |
| R4 | Cross-test contamination del Map cache | MEDIO | `_resetAgentPriceCache()` en `beforeEach` (CD-13) — patrón análogo a `_resetFallbackWarnDedup` |
| R5 | `chainId` desync entre middleware bundle y compose service (race) | MEDIO | CD-12: usar `request.resolvedChainId` único, NO re-resolver |
| R6 | Test `T-MW-COMPOSE-N` con `failNext` se rompe en futuras HUs | BAJO | CD-14 — mocks por-call-shape |
| R7 | Agent con priceUsdc=0 es legítimo (gratis) → fallback $1 cobra de más | BAJO (DT-C explícito) | El work-item DT-C lo acepta: 0 es más probable un config error que un agente gratis real. Header `x-debit-fallback` permite monitoring. |
| R8 | `getAgent` cache hit en discovery podría retornar agente stale post-update | BAJO | TTL 60s acota el window. Si el operator necesita refresh forzado, restart de la instancia limpia el Map. |
| R9 | TS6059 rootDir error si tests cruzan `src/`↔`test/` | BAJO | (anti-blindaje WKH-69) Todos los tests nuevos viven en `src/**/*.test.ts` co-located. Sin imports a `test/`. |

**AR MUST attack en F3/AR (heredado del work-item)**:
1. Double-debit step 0 (R1)
2. Zero-price bypass: ¿se puede registrar agente con priceUsdc=0 para evadir debit? (mitigado por DT-C fallback $1; el "atacante" termina pagando MÁS que el precio real)
3. Fallback honesty: warn + header en TODOS los paths de fallback (T-ROUTE-PRICE-3 lock)
4. owner_ref leak en logs (CD-6)

---

## 9. Readiness Check (self-check final)

- [x] ≥ 6 archivos del codebase leídos con path:line (leídos: 12, listados en §2)
- [x] Exemplars verificados con Glob (paths existen): 11 archivos confirmados en disco
- [x] Todas las waves W0-W5 con archivos exactos y cambios línea-por-línea
- [x] Cada AC (AC-1 a AC-11) mapeado a una wave + test (§7 table)
- [x] DT-A (debit híbrido) → cubierto por W3+W4 (middleware step 0, service steps 2..N)
- [x] DT-B (cache Map 60s) → cubierto por W1
- [x] DT-C (fallback $1 + warn + header) → cubierto por W3 T-ROUTE-PRICE-3
- [x] DT-D (chainId propagation) → cubierto por W2 (augmentation) + W3 (route pass) + W4 (service receive)
- [x] DT-E (404 desde preHandler) → cubierto por W3
- [x] CD-1 a CD-10 del work-item → todos honrados en §6
- [x] CD-11 a CD-15 nuevos del SDD → documentados
- [x] Cero `[NEEDS CLARIFICATION]` bloqueantes (los del work-item están RESUELTOS por DT-D y son no-bloqueantes para SDD; el E2E test E2E AC-11 lo confirma QA en F4)
- [x] Análisis de auto-blindajes históricos (WKH-69, WKH-88) incorporado en CD-13/14 y W2/W4
- [x] Riesgos categorizados con mitigaciones (§8)

**SDD listo para SPEC_APPROVED.**

---

## 10. Resumen para el orquestador

- **# waves**: 6 (W0..W5).
- **# archivos modificados**: 5 existentes (`src/middleware/a2a-key.ts`, `src/middleware/a2a-key.test.ts`, `src/routes/compose.ts`, `src/routes/compose.test.ts`, `src/services/compose.ts`, `src/services/compose.test.ts`, `src/types/index.ts`).
- **# archivos nuevos**: 2 (`src/services/agent-price.ts`, `src/services/agent-price.test.ts`).
- **# tests nuevos esperados**: ~30 (8 W1 + 4 W2 + 5 W3 + 6 W4 + 7 W5).
- **# constraint directives**: 15 (CD-1..CD-10 del work-item + CD-11..CD-15 nuevos del SDD).
- **# riesgos identificados**: 9 (1 ALTO controlado, 4 MEDIO, 4 BAJO). Mitigaciones documentadas.
- **Blockers**: ninguno. Lista para SPEC_APPROVED.
