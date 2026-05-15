# Story File — WKH-59 Middleware /compose debit reads real agent price

> ⚠️ ESTE ARCHIVO ES EL ÚNICO INPUT DEL DEV EN F3
> NO leas work-item.md ni sdd.md desde el dev. TODO lo necesario está aquí.
>
> Pipeline: QUALITY · Branch: `feat/087-wkh-59-real-agent-price-debit` · F2.5 generado 2026-05-14

---

## Contexto compacto

Hoy `requirePaymentOrA2AKey` (middleware) debita un placeholder de $1.00 USD por request a `/compose`, ignorando `agent.priceUsdc` del registry. Para `kyc=$0.001`, `corridor=$0.05`, `cashout=$0.01`, esto es ~50x más alto que el precio real.

**Solución**: reusar el patrón productivo de `/gasless/transfer` — un preHandler upstream resuelve el precio real del agente del primer step y lo inyecta en `request.composeEstimatedCostUsd`. El middleware lo consume sin cambiar su lógica core. Para steps 2..N, `composeService.compose` debita atómicamente via `budgetService.debit(keyRow.id, chainId, agent.priceUsdc)` reusando el `chainId` propagado por el middleware como `request.resolvedChainId`.

Sin Redis (no hay client en el proyecto): cache in-process `Map<string, {price, expiresAt}>` TTL 60s en nuevo `src/services/agent-price.ts`.

---

## Pre-flight (antes de empezar)

```bash
git checkout main
git pull
git checkout -b feat/087-wkh-59-real-agent-price-debit
npm test  # ← baseline obligatorio: debe pasar (644+)
```

Si `npm test` no pasa en main → STOP, reportar al humano. NO avanzar.

---

## Scope IN (exhaustivo — ningún otro archivo se toca)

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/types/index.ts` | modificar (`ComposeRequest` += `chainId?: number`) | W0 |
| `src/services/agent-price.ts` | **NUEVO** | W1 |
| `src/services/agent-price.test.ts` | **NUEVO** | W1 |
| `src/middleware/a2a-key.ts` | modificar (augmentation + ternario + chainId augment) | W2 |
| `src/middleware/a2a-key.test.ts` | modificar (4 tests nuevos) | W2 |
| `src/routes/compose.ts` | modificar (nuevo preHandler + pasar chainId al service) | W3 |
| `src/routes/compose.test.ts` | modificar (5 tests preHandler + 7 tests E2E) | W3, W5 |
| `src/services/compose.ts` | modificar (debit per-step en loop) | W4 |
| `src/services/compose.test.ts` | modificar (6 tests debit multi-step) | W4 |

**Cero archivos** fuera de esta lista.

---

## Constraint Directives (INVIOLABLES)

- **CD-1**: TypeScript strict — sin `any` explícito, sin `as unknown` para escapar tipos.
- **CD-2**: Debit sigue atómico via `increment_a2a_key_spend` PG function. NO debit manual con UPDATE directo.
- **CD-3**: Performance — < 50ms (DB miss), < 5ms (cache hit). No I/O nuevo en el hot path del middleware.
- **CD-4**: Fallback honesto — NO silent fallback. SIEMPRE `log.warn({reason: 'registry-miss', slug})` + header `x-debit-fallback: registry-miss`.
- **CD-5**: NO regresión en 644+ tests baseline.
- **CD-6**: NO leak de `owner_ref` en logs ni errores. Ownership guard ya está en `budgetService.debit` (WKH-53).
- **CD-7**: El middleware NO lee `request.body`. Solo lee campos augmentados (`composeEstimatedCostUsd`, `gaslessEstimatedCostUsd`). El preHandler de compose SÍ puede leer body.
- **CD-8**: `resolveAgentPriceUsdc` vive SOLO en `src/services/agent-price.ts`. NO duplicar en middleware ni route handler.
- **CD-9**: Campo augmentado se llama `composeEstimatedCostUsd` — distinto de `gaslessEstimatedCostUsd`. No colisionan.
- **CD-10**: Si preHandler retorna 404/503, el middleware NO corre (Fastify short-circuit cuando `reply.sent === true`).
- **CD-11**: En `composeService.compose`, el guard `i > 0` para el debit per-step es la ÚNICA defensa contra double-debit del step 0. NO removerlo.
- **CD-12**: El `chainId` propagado del middleware al compose service DEBE venir del MISMO bundle resuelto en `bundle.chainConfig.chainId` (línea 220 de a2a-key.ts). NO hacer una segunda llamada a `resolveChainKey` en el compose service.
- **CD-13**: `_resetAgentPriceCache()` es TEST-ONLY. NO exportar desde `index.ts` ni usar en production code. Patrón análogo: `_resetFallbackWarnDedup` en `discovery.ts:26`.
- **CD-14**: En tests con múltiples calls a `budgetService.debit`, NO usar `failNext`. Usar `mockResolvedValueOnce` chained o mocks por-call-shape (anti-blindaje WKH-88).
- **CD-15**: El preHandler de compose NO valida `steps.length > 5` ni `steps.length === 0` (eso ya lo hace el route handler en `compose.ts:40-58`). Si lo agrega, es duplicación.

---

## Wave W0 — Type augmentation (serial, blocking W1+)

### Objetivo
Extender `ComposeRequest` con `chainId?: number` opcional para que en W4 el service reciba el chainId del request.

### Archivo: `src/types/index.ts`
**Cambio exacto** — modificar la interface `ComposeRequest` (líneas 173-186) añadiendo un campo:

```typescript
export interface ComposeRequest {
  steps: ComposeStep[];
  /** Max budget in USDC */
  maxBudget?: number;
  /** Propagated to agent invocations as header `x-a2a-key` (WKH-MCP-X402) */
  a2aKey?: string;
  /**
   * WKH-61: row de la a2a_agent_keys del caller, para scoping post-resolve.
   * Cuando está presente, composeService chequea allowed_registries /
   * allowed_agent_slugs / allowed_categories contra el Agent real de cada step.
   * Cuando es undefined (path x402), el check no se ejecuta.
   */
  scopingKeyRow?: A2AAgentKeyRow;
  /**
   * WKH-59 (real-price-debit) DT-D: chainId resuelto por el middleware
   * (request.resolvedChainId). composeService lo usa para debit per-step
   * (steps 2..N) via budgetService.debit. Cuando undefined (path x402 o
   * defensive skip), el debit per-step se omite.
   */
  chainId?: number;
}
```

### Validación
```bash
npm run typecheck  # PASS — debe compilar sin errores TS
```

### Tests
N/A — typecheck es la validación.

### Commit
`feat(WKH-59): WAVE W0 — extend ComposeRequest with optional chainId`

---

## Wave W1 — agent-price service + tests (paralelizable con W2)

### Objetivo
Crear servicio `resolveAgentPriceUsdc(slug, registryName?)` con cache in-process Map TTL 60s. Sin Redis. Delegar en `discoveryService.getAgent`.

### Archivo NUEVO: `src/services/agent-price.ts` (~80 LOC)

```typescript
/**
 * Agent Price Resolver — WKH-59 (real-price-debit)
 *
 * Resuelve `agent.priceUsdc` desde el registry con cache in-process TTL 60s.
 * Usado por `src/routes/compose.ts` preHandler antes del middleware de debit.
 *
 * CD-8: única ubicación de esta función. NO duplicar.
 * CD-1: TypeScript strict, sin `any`.
 * DT-B: cache Map (no Redis, no existe client en el proyecto).
 * DT-G: cache negativo NO se persiste (null → no cachear; re-fetch en próximo miss).
 */
import { discoveryService } from './discovery.js';

type CacheEntry = { price: number; expiresAt: number };

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(slug: string, registryName?: string): string {
  // DT-B: scoping por registry para evitar colisiones entre registries
  // con el mismo slug.
  return `${slug}::${registryName ?? '_all_'}`;
}

/**
 * Resuelve el precio USDC del agente.
 *
 * - Cache hit (TTL no expirado): retorna el precio cacheado.
 * - Cache miss / TTL expirado: llama `discoveryService.getAgent`,
 *   cachea con nuevo TTL si el agente existe, retorna el precio.
 * - Agente no existe (getAgent retorna null): retorna null SIN cachear
 *   (DT-G: no negative caching).
 * - DB error / discovery throws: propaga el error. El caller (preHandler
 *   de /compose) lo mapea a 503 REGISTRY_UNAVAILABLE.
 *
 * @param agentSlug - el slug del agente (e.g. 'kyc', 'corridor')
 * @param registryName - opcional, si no se da busca en todos los registries
 * @returns el precio en USD o null si el agente no existe
 */
export async function resolveAgentPriceUsdc(
  agentSlug: string,
  registryName?: string,
): Promise<number | null> {
  const key = cacheKey(agentSlug, registryName);
  const now = Date.now();
  const entry = cache.get(key);

  if (entry && entry.expiresAt > now) {
    return entry.price; // cache hit (AC-8: < 5ms)
  }

  // Cache miss o TTL expirado → re-fetch (AC-9)
  const agent = await discoveryService.getAgent(agentSlug, registryName);
  if (!agent) {
    // DT-G: no cachear negativos. Si el agente se registra después,
    // el próximo lookup lo encuentra sin esperar el TTL.
    return null;
  }

  const price = agent.priceUsdc;
  cache.set(key, { price, expiresAt: now + CACHE_TTL_MS });
  return price;
}

/**
 * TEST-ONLY: limpia el cache. NO importar en production code.
 * CD-13: patrón análogo a `_resetFallbackWarnDedup` en `discovery.ts:26`.
 */
export function _resetAgentPriceCache(): void {
  cache.clear();
}
```

**Imports requeridos**: solo `discoveryService` desde `./discovery.js`.

**Verificación de signatura**: `discoveryService.getAgent(slug, registryId?)` retorna `Promise<Agent | null>` (verificado en `src/services/discovery.ts:336-375`). `Agent.priceUsdc` es `number` (verificado en `src/types/index.ts:124`).

### Archivo NUEVO: `src/services/agent-price.test.ts` (~150 LOC)

**Setup**:
```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentPriceCache, resolveAgentPriceUsdc } from './agent-price.js';

vi.mock('./discovery.js', () => ({
  discoveryService: {
    getAgent: vi.fn(),
  },
}));

import { discoveryService } from './discovery.js';
const mockGetAgent = vi.mocked(discoveryService.getAgent);

beforeEach(() => {
  _resetAgentPriceCache();
  vi.clearAllMocks();
  vi.useRealTimers();
});
```

**Tests (mínimo 8)**:

| ID | Nombre | Caso | AC |
|----|--------|------|----|
| T-PRICE-1 | `should fetch from discoveryService on cache miss` | mockGetAgent retorna `{slug: 'kyc', priceUsdc: 0.001, ...}`. Primera llamada → retorna 0.001, getAgent llamado 1 vez | AC-9 |
| T-PRICE-2 | `should hit cache on second call within TTL` | Primera llamada (población). Segunda llamada → retorna 0.001, getAgent llamado 1 vez (no 2) | AC-8 |
| T-PRICE-3 | `should re-fetch when TTL expires` | `vi.useFakeTimers()`. Primera llamada. Avanzar `vi.advanceTimersByTime(61_000)`. Segunda llamada → getAgent llamado 2 veces | AC-9 |
| T-PRICE-4 | `should return null when agent not found` | mockGetAgent retorna `null` → función retorna null. Llamar de nuevo → getAgent llamado 2 veces (DT-G: no negative caching) | AC-3 prep |
| T-PRICE-5 | `should propagate DB error from discoveryService` | mockGetAgent rejects con `new Error('DB down')` → `expect(...).rejects.toThrow('DB down')`. La función NO captura el error | AC-5 prep |
| T-PRICE-6 | `should return 0 when priceUsdc is 0 (caller decides fallback)` | mockGetAgent retorna `{priceUsdc: 0}` → retorna 0. El fallback $1 NO está en este service, está en el preHandler (DT-C) | AC-4 prep |
| T-PRICE-7 | `should scope cache by slug` | Llamar con 'kyc' luego 'corridor' con priceUsdc distintos. Ambos retornan sus precios. Segunda llamada de cada slug es cache hit | DT-B |
| T-PRICE-8 | `should scope cache by registryName for same slug` | Llamar `('kyc', 'reg-a')` y `('kyc', 'reg-b')` → dos entradas en cache, dos calls a getAgent | DT-B |

**Patrón de mock por test** (anti-blindaje CD-14):
```typescript
mockGetAgent.mockResolvedValueOnce({ slug: 'kyc', priceUsdc: 0.001, /* ... */ });
```
NO `failNext`-style — usar `mockResolvedValueOnce` por call.

### Validación wave
```bash
npm test -- agent-price  # PASS, 8 tests
npm run typecheck         # PASS
```

### ACs cubiertos
AC-8, AC-9 (y soporte de fixtures para AC-3, AC-4, AC-5 que se cubren E2E en W3/W5).

### Commit
`feat(WKH-59): WAVE W1 — agent-price service + cache TTL 60s`

---

## Wave W2 — middleware extension (paralelizable con W1)

### Objetivo
Extender el ternario de `estimatedCostUsd` en `src/middleware/a2a-key.ts` para consumir `request.composeEstimatedCostUsd` antes del fallback $1, y augmentar `request.resolvedChainId` para que el route handler de compose pueda pasarlo al service.

### Archivo: `src/middleware/a2a-key.ts`

**Cambio 1** — extender la augmentation (líneas 27-32):

```typescript
declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;
    gaslessEstimatedCostUsd?: number; // WKH-59
    composeEstimatedCostUsd?: number; // WKH-59 (real-price-debit) — CD-9
    resolvedChainId?: number;         // WKH-59 (real-price-debit) DT-D
  }
}
```

**Cambio 2** — extender el ternario de `estimatedCostUsd` (líneas 127-130 actuales del archivo, identificar por el texto `request.gaslessEstimatedCostUsd`):

```typescript
// WKH-59 (real-price-debit): /compose inyecta el precio real del primer step
// vía request.composeEstimatedCostUsd. /gasless/transfer ya inyectaba
// request.gaslessEstimatedCostUsd. Otras rutas (/discover, /orchestrate)
// quedan con $1 placeholder.
// CD-7: el middleware NO lee request.body — solo campos augmentados.
// DT-F: orden compose-first (rutas mutuamente excluyentes, sin colisión real).
const estimatedCostUsd =
  typeof request.composeEstimatedCostUsd === 'number'
    ? request.composeEstimatedCostUsd
    : typeof request.gaslessEstimatedCostUsd === 'number'
      ? request.gaslessEstimatedCostUsd
      : 1.0;
```

**Cambio 3** — augmentar `request.resolvedChainId` justo después de resolver el bundle (después de `const chainId = bundle.chainConfig.chainId;`, alrededor de la línea 220 actual del archivo):

```typescript
const chainId = bundle.chainConfig.chainId;
const assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN';

// WKH-59 (real-price-debit) DT-D / CD-12: propagar al route handler para
// que composeService haga debit per-step (steps 2..N) con el MISMO chainId
// del bundle. NO re-resolver en el service (race latente).
request.resolvedChainId = chainId;
```

### Archivo: `src/middleware/a2a-key.test.ts`

**4 tests nuevos** — agregar siguiendo el patrón de los existentes T-MW-GASLESS-1/2 (líneas 840-927). NO usar `failNext` (CD-14): mock `budgetService.debit` con `mockResolvedValueOnce` o `mockImplementation`.

| ID | Nombre | Caso | AC |
|----|--------|------|----|
| T-MW-COMPOSE-1 | `should debit composeEstimatedCostUsd when set` | Pre-set `request.composeEstimatedCostUsd = 0.001` via local Fastify preHandler que setea el campo. Header `x-a2a-key` válido. Assert `budgetService.debit` llamado con `(keyId, chainId, 0.001)` (NO 1.0) | AC-1 |
| T-MW-COMPOSE-2 | `should prefer composeEstimatedCostUsd over gaslessEstimatedCostUsd when both set` | Pre-set ambos: compose=0.05, gasless=10. Assert debit llamado con 0.05 | DT-F precedence |
| T-MW-COMPOSE-3 | `should fall back to $1 placeholder when neither field is set` | Ninguno seteado. Assert debit llamado con 1.0 | AC-7 |
| T-MW-COMPOSE-4 | `should augment request.resolvedChainId after bundle resolution` | Configurar el handler downstream para leer `request.resolvedChainId` y enviarlo en el body de la respuesta. Assert `body.resolvedChainId === chainIdDelBundle` | DT-D |

**Patrón de test** (copiar shape de T-MW-GASLESS-2 línea 909-924):
```typescript
it('T-MW-COMPOSE-1 should debit composeEstimatedCostUsd when set', async () => {
  const app = await buildAppWithMocks(); // helper existente
  app.addHook('preHandler', async (request) => {
    request.composeEstimatedCostUsd = 0.001;
  });
  // ... resto del patrón existente
  expect(mockDebit).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 0.001);
});
```

### Validación wave
```bash
npm test -- a2a-key  # PASS — incluye T-MW-COMPOSE-1..4 + regresión T-MW-GASLESS-1/2
npm run typecheck    # PASS
```

### ACs cubiertos
AC-1 (debit con valor inyectado), AC-6 (gasless intacto via regresión), AC-7 (placeholder $1 cuando ningún campo está inyectado).

### Commit
`feat(WKH-59): WAVE W2 — middleware ternary + resolvedChainId augment`

---

## Wave W3 — compose preHandler + 404/503 guards (depende de W1, W2)

### Objetivo
Agregar preHandler `resolveComposePriceHandler` en `src/routes/compose.ts` ANTES de `requirePaymentOrA2AKey`. Maneja: 404 si agente no existe, 503 si discovery throws, fallback $1 + warn + header si priceUsdc es null o 0, happy path inyecta `request.composeEstimatedCostUsd`. Route handler propaga `request.resolvedChainId` al composeService.

### Archivo: `src/routes/compose.ts`

**Cambio 1** — agregar imports al top:

```typescript
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
import { requireForwardKey } from '../middleware/forward-key.js';
import { orchestrateRateLimit } from '../middleware/rate-limit.js';
import { createTimeoutHandler } from '../middleware/timeout.js';
import { resolveAgentPriceUsdc } from '../services/agent-price.js'; // NUEVO W3
import { composeService } from '../services/compose.js';
import type { ComposeStep } from '../types/index.js';
```

**Cambio 2** — definir el preHandler (ANTES del `const composeRoutes...`):

```typescript
/**
 * WKH-59 (real-price-debit) preHandler: resuelve el precio real del primer
 * step ANTES del middleware de debit, e inyecta `request.composeEstimatedCostUsd`.
 *
 * Comportamientos:
 * - Body inválido (sin steps): retorna sin inyectar; el route handler hace 400.
 *   CD-15: NO duplicar validación de shape acá.
 * - Agente no existe: 404 AGENT_NOT_FOUND (CD-10: middleware no corre — reply.sent).
 * - Discovery throws: 503 REGISTRY_UNAVAILABLE (CD-10).
 * - priceUsdc === 0 o null: fallback $1 + warn + header (DT-C, CD-4).
 * - Happy path: inyecta `request.composeEstimatedCostUsd = price`.
 */
async function resolveComposePriceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { steps?: ComposeStep[] } | undefined;

  // CD-15: shape validation la hace el route handler (línea 40-58 original).
  if (!body?.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return;
  }

  const firstStep = body.steps[0];
  if (!firstStep || typeof firstStep.agent !== 'string') {
    return;
  }

  try {
    const price = await resolveAgentPriceUsdc(firstStep.agent, firstStep.registry);

    if (price === null) {
      // AC-3: agente no existe → 404, NO debit. CD-10: middleware short-circuited.
      reply.status(404).send({
        error: `Agent not found: ${firstStep.agent}`,
        error_code: 'AGENT_NOT_FOUND',
      });
      return;
    }

    if (price === 0) {
      // AC-4 / DT-C: priceUsdc = 0 más probable config error que agente gratis.
      // CD-4: fallback honesto con warn + header.
      request.log.warn(
        {
          reason: 'registry-miss',
          slug: firstStep.agent,
          registry: firstStep.registry ?? null,
        },
        'compose-price.fallback',
      );
      reply.header('x-debit-fallback', 'registry-miss');
      request.composeEstimatedCostUsd = 1.0;
      return;
    }

    // Happy path AC-1
    request.composeEstimatedCostUsd = price;
  } catch (err) {
    // AC-5: error de DB o discovery → 503 REGISTRY_UNAVAILABLE, NO debit.
    // CD-6: NO incluir owner_ref ni nada sensible en el log.
    request.log.error(
      {
        err: err instanceof Error ? err.message : 'unknown',
        slug: firstStep.agent,
      },
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

**Cambio 3** — insertar el preHandler en el array (en `preHandler: [...]`, líneas 24-35 actuales):

```typescript
preHandler: [
  // WKH-65: forward-key (optional, env-gated) runs BEFORE timeout/payment.
  ...requireForwardKey(),
  createTimeoutHandler(
    parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '180000', 10),
  ),
  // WKH-59 (real-price-debit) DT-E: resolver precio ANTES del middleware
  // de debit para inyectar request.composeEstimatedCostUsd y manejar
  // 404 AGENT_NOT_FOUND / 503 REGISTRY_UNAVAILABLE.
  resolveComposePriceHandler,
  ...requirePaymentOrA2AKey({
    description:
      'WasiAI Compose Service — Multi-agent pipeline execution',
  }),
],
```

**Cambio 4** — propagar `chainId` al composeService (líneas 69-75 actuales, en el route handler):

```typescript
const result = await composeService.compose({
  steps: body.steps,
  maxBudget: body.maxBudget,
  a2aKey,
  // WKH-61: propagar el row del caller para scoping per-step
  scopingKeyRow: request.a2aKeyRow,
  // WKH-59 (real-price-debit) DT-D: chainId del MISMO bundle (CD-12) para
  // debit per-step (steps 2..N) atómico en composeService.
  chainId: request.resolvedChainId,
});
```

### Archivo: `src/routes/compose.test.ts`

**5 tests nuevos** para el preHandler. Mock pattern existente (líneas 1-172):
- Mock `../services/agent-price.js` con `resolveAgentPriceUsdc: vi.fn()`
- Mock `../middleware/a2a-key.js` `requirePaymentOrA2AKey` como en tests existentes
- Mock `../services/compose.js` `composeService.compose`

| ID | Nombre | Caso | AC |
|----|--------|------|----|
| T-ROUTE-PRICE-1 | `preHandler injects composeEstimatedCostUsd on happy path` | mock `resolveAgentPriceUsdc` retorna 0.001. POST /compose con `steps[0].agent='kyc'`. Assert mock middleware downstream recibe `request.composeEstimatedCostUsd === 0.001`, status 200 | AC-1 |
| T-ROUTE-PRICE-2 | `should return 404 AGENT_NOT_FOUND when agent missing` | mock retorna `null`. POST /compose. Assert status 404, body.error_code === 'AGENT_NOT_FOUND', mock middleware NO llamado (CD-10) | AC-3 |
| T-ROUTE-PRICE-3 | `should fallback to $1 + warn + header when priceUsdc is 0` | mock retorna `0`. POST /compose. Assert status 200, `res.headers['x-debit-fallback'] === 'registry-miss'`, `request.composeEstimatedCostUsd === 1.0`, log.warn invocado con `reason: 'registry-miss'` | AC-4 |
| T-ROUTE-PRICE-4 | `should return 503 REGISTRY_UNAVAILABLE when discovery throws` | mock rejects con `new Error('PGRST')`. POST /compose. Assert status 503, body.error_code === 'REGISTRY_UNAVAILABLE', mock middleware NO llamado | AC-5 |
| T-ROUTE-PRICE-5 | `preHandler is a no-op for empty steps body (route handler responds 400)` | POST /compose con `steps: []`. Assert status 400 desde el route handler, mock `resolveAgentPriceUsdc` NUNCA llamado | CD-15 |

**Mock pattern** (anti-blindaje CD-14, mockResolvedValueOnce per case):
```typescript
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
}));
import { resolveAgentPriceUsdc } from '../services/agent-price.js';
const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);

beforeEach(() => {
  mockResolvePrice.mockReset();
});

it('T-ROUTE-PRICE-1 ...', async () => {
  mockResolvePrice.mockResolvedValueOnce(0.001);
  // ...
});
```

### Validación wave
```bash
npm test -- compose  # PASS — incluye los 5 nuevos + regresión existentes
npm run typecheck     # PASS
```

### ACs cubiertos
AC-3, AC-4, AC-5 (preHandler-level). Soporte para AC-1 E2E (W5).

### Commit
`feat(WKH-59): WAVE W3 — compose preHandler with 404/503/fallback`

---

## Wave W4 — compose service multi-step debit (depende de W0, W3)

### Objetivo
En `src/services/compose.ts`, dentro del loop de steps (líneas 64-254), debitar steps 2..N (i >= 1) usando `budgetService.debit(scopingKeyRow.id, chainId, agent.priceUsdc)`. Guard `i > 0` para evitar double-debit del step 0 (debitado en middleware). Atómico via PG function (CD-2).

### Archivo: `src/services/compose.ts`

**Cambio 1** — destructurar `chainId` del request (en `async compose(request: ComposeRequest)`, línea 59 aprox):

```typescript
async compose(request: ComposeRequest): Promise<ComposeResult> {
  const { steps, maxBudget, a2aKey, scopingKeyRow, chainId } = request;
  // ... resto sin cambios hasta el loop
}
```

**Cambio 2** — agregar el import del budgetService al top del archivo si no existe:

```typescript
import { budgetService } from './budget.js';
```

(Verificar si ya está importado — `src/services/budget.ts` exporta `budgetService` con método `debit`.)

**Cambio 3** — dentro del `for (let i = 0; i < steps.length; i++)` loop, DESPUÉS de `resolveAgent + scoping + maxBudget check` y ANTES de `invokeAgent`, insertar:

```typescript
// WKH-59 (real-price-debit) AC-2: steps 2..N debit atómico via
// budgetService.debit (PG function increment_a2a_key_spend — CD-2).
//
// CD-11: guard `i > 0` es la ÚNICA defensa contra double-debit del step 0
// (que ya fue debitado por el middleware via request.composeEstimatedCostUsd).
// NO REMOVER. AR/CR debe verificar que esta línea sobrevive en futuras HUs.
//
// Skip defensivo: si no hay scopingKeyRow (path x402) o chainId (defensive),
// el debit per-step no aplica. El comportamiento de "fee-on-attempt" es
// consistente con gasless (debit antes de invokeAgent).
if (i > 0 && scopingKeyRow && chainId !== undefined) {
  const debitResult = await budgetService.debit(
    scopingKeyRow.id,
    chainId,
    agent.priceUsdc,
  );
  if (!debitResult.success) {
    // DT-H: mid-pipeline debit failure → ComposeResult.error con
    // info. NO setear errorCode='SCOPE_DENIED' (eso es 403). Route
    // handler mapea a 400 (default), no a 402/403.
    return {
      success: false,
      output: null,
      steps: results,
      totalCostUsdc: totalCost,
      totalLatencyMs: totalLatency,
      error: `Step ${i} debit failed: ${debitResult.error ?? 'insufficient budget'}`,
    };
  }
}
```

**Posición exacta**: justo después del scoping check (búsqueda por la línea `// WKH-61` o el `if (!allowed)` del scoping) y antes del `await invokeAgent(...)` o el `try { ... }` del invoke. Verificar el lugar EXACTO leyendo `src/services/compose.ts` antes de editar — el orden importa para mantener "charge first, deliver after".

**NO modificar** la lógica de `totalCost += agent.priceUsdc` (línea 137) — sigue siendo informativa para `ComposeResult.totalCostUsdc`.

### Archivo: `src/services/compose.test.ts`

**6 tests nuevos**. Mock `budgetService` con shape:
```typescript
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    getBalance: vi.fn(),
  },
}));
```

CD-14: NO usar `failNext`. Usar `mockResolvedValueOnce` chained.

| ID | Nombre | Caso | AC |
|----|--------|------|----|
| T-COMPOSE-DEBIT-1 | `should debit step 1 (i=1) via budgetService.debit` | 2 steps con priceUsdc 0.001 y 0.05. `scopingKeyRow={id:'k1',...}`, `chainId=2368`. Mock invokeAgent OK. Assert `mockDebit` llamado 1 vez con `('k1', 2368, 0.05)` | AC-2 |
| T-COMPOSE-DEBIT-2 | `should debit steps 1 and 2 in a 3-step pipeline` | 3 steps priceUsdc 0.001/0.05/0.01. Assert `mockDebit` llamado 2 veces: `('k1', 2368, 0.05)` y `('k1', 2368, 0.01)` | AC-2 |
| T-COMPOSE-DEBIT-3 | `should abort pipeline when step 1 debit fails (insufficient)` | mock primer debit retorna `{success: false, error: 'insufficient'}`. Assert `composeService.compose` retorna `{success: false, error: 'Step 1 debit failed: insufficient'}`, step 2 NO se invoca | AC-2 fail |
| T-COMPOSE-DEBIT-4 | `should skip debit when scopingKeyRow is undefined (x402 path)` | 3 steps, `scopingKeyRow: undefined`. Assert `mockDebit` NUNCA llamado, pipeline ejecuta normal | AC-2 backward |
| T-COMPOSE-DEBIT-5 | `should skip debit when chainId is undefined` | 3 steps, `scopingKeyRow` presente pero `chainId: undefined`. Assert `mockDebit` NUNCA llamado | DT-D defensive |
| T-COMPOSE-DEBIT-6 | `should NOT debit step 0 in service (anti-double-debit guard)` | 2 steps. Assert que en ninguna call a `mockDebit` el argumento price sea el `priceUsdc` del primer step (step 0 lo paga el middleware) | CD-11 anti-double-debit |

**Verificación de signatura de `budgetService.debit`** (de `src/services/budget.ts:47-63`): firma es `debit(keyId: string, chainId: number, amountUsd: number): Promise<{success: boolean; error?: string}>`. Confirmar al implementar.

### Validación wave
```bash
npm test -- compose.test  # PASS — service + route (existing + nuevos)
npm run typecheck          # PASS
```

### ACs cubiertos
AC-2.

### Commit
`feat(WKH-59): WAVE W4 — composeService debit steps 2..N atomic`

---

## Wave W5 — integration tests + final validation (depende de W1..W4)

### Objetivo
Tests E2E integración middleware + preHandler + service con mocks (no testnet real — eso lo hace QA en F4).

### Archivo: `src/routes/compose.test.ts`

**7 tests E2E nuevos** (suite separada, `describe('WKH-59 E2E real-price-debit', ...)`).

| ID | Nombre | Caso | AC |
|----|--------|------|----|
| T-E2E-PRICE-1 | `1 step with priceUsdc=0.001 → middleware debits 0.001, service debits 0 times` | mock `resolveAgentPriceUsdc.mockResolvedValueOnce(0.001)`, mock `composeService.compose` OK. Assert `mockMwDebit` con 0.001, `mockSvcDebit` 0 calls | AC-1 |
| T-E2E-PRICE-2 | `3 steps prices 0.001/0.05/0.01 → total $0.061 debited (1 mw + 2 service)` | mocks: getAgent retorna {priceUsdc: 0.001}, composeService runs 3 steps with prices. Assert mw=0.001, svc=0.05+0.01. Suma total = 0.061 (NO $3) | AC-2 + AC-11 |
| T-E2E-PRICE-3 | `unknown agent → 404 with zero debits` | mock retorna null. Assert status 404, `mockMwDebit` 0 calls, `mockSvcDebit` 0 calls | AC-3 |
| T-E2E-PRICE-4 | `priceUsdc=null in registry → fallback $1 + header + warn` | mock retorna `0` (proxy de null/0/undefined per DT-C). Assert status 200, header `x-debit-fallback: registry-miss`, mwDebit con 1.0, warn log invocado | AC-4 |
| T-E2E-PRICE-5 | `discovery throws → 503 with zero debits` | mock rejects. Assert status 503, 0 debits | AC-5 |
| T-E2E-PRICE-6 | `/gasless/transfer regression: gaslessEstimatedCostUsd still works` | NO setear `composeEstimatedCostUsd`. Smoke test del path gasless (puede vivir en `gasless.test.ts` si es cleaner). Assert ternario usa gasless cost | AC-6 |
| T-E2E-PRICE-7 | `/discover or other route: $1 placeholder backward-compat` | Request a un endpoint sin preHandler de price. Assert debit con 1.0 | AC-7 |

**AC-10** (no regression 644+ tests): cubierto por `npm test` full suite, sin test nuevo.

**AC-11** (E2E real con WasiAgentShop $0.061 total): cubierto por T-E2E-PRICE-2 con mocks. QA verifica con testnet real en F4.

### Validación final
```bash
npm test           # FULL suite PASS, 644+ baseline + ~30 nuevos (~674+)
npm run lint       # PASS (cero warnings nuevos)
npm run typecheck  # PASS
```

**Checks adicionales**:
- Cero TODOs nuevos en el código (`git diff main -- 'src/**' | grep -i 'TODO\\|FIXME'` → vacío)
- Cero `console.log` nuevos (`git diff main -- 'src/**' | grep 'console.log'` → vacío)
- Cero `any` explícitos nuevos (`git diff main -- 'src/**' | grep ': any\\b'` → vacío)
- Cero imports a `test/` desde `src/` (anti-blindaje WKH-69)

### ACs cubiertos
AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-10, AC-11 (simulated).

### Commit
`feat(WKH-59): WAVE W5 — E2E integration tests for real-price-debit`

---

## Done Definition (Story File listo)

Story File se considera DONE cuando:

- [ ] `npm test` PASS, baseline 644+ preservado, ~30 tests nuevos verdes
- [ ] `npm run lint` PASS, cero warnings nuevos
- [ ] `npm run typecheck` PASS
- [ ] Cero TODOs nuevos en código
- [ ] Cero `console.log` nuevos
- [ ] Cero `any` explícitos nuevos
- [ ] 6 commits secuenciales (W0..W5) con prefijo `feat(WKH-59): WAVE Wn — ...`
- [ ] Branch `feat/087-wkh-59-real-agent-price-debit` pushed (NO mergear — eso lo hace humano post-QA F4)
- [ ] AR (F3-AR) ejecutado y APROBADO sin BLOQUEANTES
- [ ] CR (F3-CR) ejecutado y APROBADO con citas archivo:línea
- [ ] QA (F4) ejecutado y AC-1..AC-11 verificados con evidencia

---

## Commit strategy

| Wave | Mensaje |
|------|---------|
| W0 | `feat(WKH-59): WAVE W0 — extend ComposeRequest with optional chainId` |
| W1 | `feat(WKH-59): WAVE W1 — agent-price service + cache TTL 60s` |
| W2 | `feat(WKH-59): WAVE W2 — middleware ternary + resolvedChainId augment` |
| W3 | `feat(WKH-59): WAVE W3 — compose preHandler with 404/503/fallback` |
| W4 | `feat(WKH-59): WAVE W4 — composeService debit steps 2..N atomic` |
| W5 | `feat(WKH-59): WAVE W5 — E2E integration tests for real-price-debit` |

Todos los commits firmados con:
```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

NO usar `--no-verify`. NO usar `--amend` después de fallar un hook — fix + new commit.

---

## Anti-Hallucination Checklist (para nexus-dev)

### Archivos NO tocar
- ❌ NO modificar `src/routes/gasless.ts` ni `gaslessCostEstimatorPreHandler` (AC-6)
- ❌ NO modificar `src/routes/discover.ts` ni `src/routes/orchestrate.ts` (AC-7)
- ❌ NO modificar schema de Supabase (`supabase/migrations/`)
- ❌ NO modificar la PG function `increment_a2a_key_spend` (acepta NUMERIC ya)
- ❌ NO modificar `src/services/budget.ts` (la signatura `debit(keyId, chainId, amountUsd)` ya es correcta)
- ❌ NO modificar `src/services/discovery.ts` (`getAgent` ya soporta `(slug, registryId?)`)

### Convenciones de código
- ❌ NO usar `any` explícito ni `as unknown as X` (CD-1)
- ❌ NO escribir tests fuera de los listados acá (~30 totales)
- ❌ NO crear archivos `.md`/`.txt`/`README` extras
- ❌ NO agregar dependencias npm (`package.json` no se modifica)
- ❌ NO usar `console.log` — usar `request.log.warn/error/info` (Fastify pino)
- ❌ NO usar `failNext` en mocks (CD-14, anti-blindaje WKH-88) — usar `mockResolvedValueOnce` chained
- ❌ NO importar desde `test/` en `src/**/*.test.ts` (anti-blindaje WKH-69, TS6059)
- ❌ NO usar `--no-verify` ni `--amend` en commits

### Comportamiento del sistema
- ❌ NO leer `request.body` desde el middleware `a2a-key.ts` (CD-7) — solo campos augmentados
- ❌ NO duplicar `resolveAgentPriceUsdc` fuera de `src/services/agent-price.ts` (CD-8)
- ❌ NO cachear "agente no existe" (`null`) en `agent-price.ts` (DT-G)
- ❌ NO re-resolver chainId en `composeService.compose` — usar `request.chainId` propagado (CD-12)
- ❌ NO remover el guard `i > 0` en el debit del compose service (CD-11)
- ❌ NO validar `steps.length` en el preHandler de price (CD-15) — el route handler lo hace
- ❌ NO mapear `INSUFFICIENT_BUDGET` mid-pipeline a 403 — dejar default 400 (DT-H)

### Verificación pre-commit (cada wave)
- ✅ `npm test -- <archivo afectado>` PASS
- ✅ `npm run typecheck` PASS
- ✅ `npm run lint` PASS (al menos del archivo modificado)
- ✅ `git status` muestra SOLO los archivos del Scope IN
- ✅ Mensaje de commit es `feat(WKH-59): WAVE Wn — ...` con Co-Authored-By trailer

---

## Si encontrás ambigüedad durante F3

1. Releé esta Story File completa.
2. Si la ambigüedad persiste, leé las secciones citadas del SDD (`doc/sdd/087-wkh-59-real-agent-price-debit/sdd.md`) — específicamente DT-A..DT-H (sección 5 del SDD) y los CDs.
3. NO inventes. NO leas `work-item.md` (este Story File ya lo resume).
4. Si la ambigüedad sigue después de releer SDD: STOP, reportá al humano vía el orquestador, NO hagas guess.
