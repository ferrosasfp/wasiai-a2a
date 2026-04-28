# Story File — WKH-59 / SEC-DRAIN-1

> **Para el Dev**: este archivo es **autocontenido**. NO necesitás leer el
> work-item ni el SDD para implementar; toda la información operativa está
> acá. Si necesitás más contexto: `doc/sdd/061-wkh-59-sec-drain-1/sdd.md`
> (decisiones técnicas) y `work-item.md` (ACs originales).
>
> **Branch**: `feat/061-wkh-59-sec-drain-1`
> **Baseline target**: 532 tests verde → ~552 post-implementación
> **Flow**: QUALITY (todas las gates obligatorias)

---

## §1 — Contexto compacto (qué construir y por qué)

### El bug

`POST /gasless/transfer` (`src/routes/gasless.ts:30-67`) está protegido
por `requirePaymentOrA2AKey` pero el middleware
(`src/middleware/a2a-key.ts:115`) debita un placeholder fijo de $1 USD
ignorando el monto real on-chain del transfer.

Resultado: cualquier holder de un A2A key con $1 de budget puede vaciar
el operator wallet ejecutando un único `POST /gasless/transfer` con
`value` arbitrario. El budget protege la API; **NO** los fondos
on-chain que la API moviliza.

**Severidad**: BLQ-HIGH del security audit 2026-04-27.

### El fix (resumen)

1. **Helper puro de pricing** (W1): nuevo `src/lib/price.ts` con
   `pyusdWeiToUsd(valueWei: bigint): number` y env-backed
   `getPyusdUsdRate()` + `getGaslessDefaultCapUsd()`.
2. **Stage A del preHandler** (W2): la ruta `/gasless/transfer` agrega
   un preHandler propio que parsea body, computa
   `estimatedCostUsd = pyusdWeiToUsd(BigInt(body.value))`, valida cap,
   inyecta `request.gaslessEstimatedCostUsd: number`.
3. **Stage B del preHandler** (W0): el middleware
   `requirePaymentOrA2AKey` lee `request.gaslessEstimatedCostUsd` si
   está presente; sino usa el placeholder $1 (backward-compat con el
   resto del codebase).
4. **Backward-compat total**: rutas distintas a `/gasless/transfer` no
   inyectan el campo → middleware sigue debitando $1 → 532 tests
   existentes siguen verde.
5. **Cap global** `GASLESS_DEFAULT_CAP_USD=10` (env) bloquea transfers
   de monto excesivo antes incluso del debit.

---

## §2 — Scope IN (lista exhaustiva de archivos a tocar)

### Archivos NUEVOS

| # | Archivo | Propósito | Wave |
|---|---|---|---|
| 1 | `src/lib/price.ts` | Helper puro: `getPyusdUsdRate()`, `pyusdWeiToUsd(bigint)`, `getGaslessDefaultCapUsd()` | W1 |
| 2 | `src/lib/price.test.ts` | 10 unit tests T-PRICE-1..T-PRICE-10 | W1 |
| 3 | `src/routes/gasless.test.ts` | 8 integration tests T-DRAIN-1..T-DRAIN-8 | W3 |

### Archivos MODIFICADOS

| # | Archivo | Cambio | Wave |
|---|---|---|---|
| 4 | `src/middleware/a2a-key.ts` | (a) Augmentation: agregar `gaslessEstimatedCostUsd?: number` al `declare module 'fastify'` (líneas 22-26). (b) Línea 115: cambiar `const estimatedCostUsd = 1.0;` por lectura condicional desde request. | W0 |
| 5 | `src/middleware/a2a-key.test.ts` | Agregar `describe('WKH-59 cost estimation injection')` con T-MW-GASLESS-1 + T-MW-GASLESS-2 | W4 |
| 6 | `src/routes/gasless.ts` | (a) Importar helpers de `src/lib/price.js`. (b) Definir función `gaslessCostEstimatorPreHandler(request, reply)` arriba del export. (c) Cambiar `preHandler: requirePaymentOrA2AKey({...})` por `preHandler: [gaslessCostEstimatorPreHandler, ...requirePaymentOrA2AKey({...})]`. (d) Agregar el `request.log.info({...}, 'gasless transfer executed')` en el path de éxito. | W2 |
| 7 | `.env.example` | Nueva sección `# ─── Gasless Pricing (WKH-59) ─────` con `PYUSD_USD_RATE=1.0` y `GASLESS_DEFAULT_CAP_USD=10` + docstrings | W5 |

### Total esperado

- Archivos NUEVOS: 3 (1 producción, 2 tests)
- Archivos MODIFICADOS: 4 (3 producción, 1 test, 1 docs)
- Tests agregados: ~20 (10 helper + 8 route + 2 middleware)
- Baseline: 532 → ~552

---

## §3 — Acceptance Criteria + Plan de tests (mapping inline)

| AC | EARS resumido | Test ID | Archivo |
|----|---|---|---|
| AC-1 | Body válido `value=$5`, key budget $100 → HTTP 200, debit=$5 | T-DRAIN-1 + T-MW-GASLESS-2 | `routes/gasless.test.ts` + `middleware/a2a-key.test.ts` |
| AC-2 | `value=$50` > cap $10 → HTTP 403 PER_CALL_LIMIT, NO transfer | T-DRAIN-2 + T-DRAIN-8 (boundary) | `routes/gasless.test.ts` |
| AC-3 | `value=$5`, key budget $1 → HTTP 403 INSUFFICIENT_BUDGET | T-DRAIN-3 | `routes/gasless.test.ts` |
| AC-4 | `value=$5`, daily_limit=$2 → HTTP 403 DAILY_LIMIT (PG function) | T-DRAIN-4 | `routes/gasless.test.ts` |
| AC-5 | Middleware sin campo (rutas normales) → debit $1 (regresión) | T-MW-GASLESS-1 | `middleware/a2a-key.test.ts` |
| AC-6 | `value` no-bigint → HTTP 400 antes del middleware | T-DRAIN-5 + T-DRAIN-6 | `routes/gasless.test.ts` |
| AC-7 | Éxito → log estructurado con `{keyId, estimatedCostUsd, actualValueWei, to, txHash}` | T-DRAIN-7 | `routes/gasless.test.ts` |
| AC-8 | `PYUSD_USD_RATE` inválido → fallback 1.0 + warn | T-PRICE-1..T-PRICE-5 | `lib/price.test.ts` |
| AC-9 | `GASLESS_DEFAULT_CAP_USD` inválido → fallback 10 + warn | T-PRICE-9 + T-PRICE-10 | `lib/price.test.ts` |

---

## §4 — Waves (orden de implementación)

### W-1 — Pre-flight checks (serial)

```bash
git checkout -b feat/061-wkh-59-sec-drain-1
npm test  # baseline: 532 tests verde
```

### W0 — Middleware augmentation + lectura condicional (serial, bloqueante)

**Archivo**: `src/middleware/a2a-key.ts`

**Cambios**:

1. Extender el `declare module 'fastify'` (líneas 22-26):
   ```text
   declare module 'fastify' {
     interface FastifyRequest {
       a2aKeyRow?: A2AAgentKeyRow;
       gaslessEstimatedCostUsd?: number;  // WKH-59
     }
   }
   ```

2. Línea 115 (dentro del handler async): reemplazar
   ```text
   // DT-2 placeholder cost estimation (MNR-2: single const)
   const estimatedCostUsd = 1.0;
   ```
   por
   ```text
   // WKH-59: rutas que mueven valor on-chain inyectan el costo real
   // vía request.gaslessEstimatedCostUsd. El resto sigue con $1 placeholder.
   const estimatedCostUsd =
     typeof request.gaslessEstimatedCostUsd === 'number'
       ? request.gaslessEstimatedCostUsd
       : 1.0;
   ```

**Tests post-W0**: `npm test` → 532 verde (ningún caller setea el campo
todavía → comportamiento idéntico).

### W1 — Helper `src/lib/price.ts` + tests (paralelizable con W0)

**Archivo NUEVO**: `src/lib/price.ts`

API a implementar (pseudocódigo, NO copy-paste):

```text
// Constantes
const PYUSD_DECIMALS = 6;
const DEFAULT_PYUSD_RATE = 1.0;
const MAX_PYUSD_RATE = 100;
const MIN_PYUSD_RATE = 0;
const DEFAULT_GASLESS_CAP_USD = 10;
const MAX_GASLESS_CAP_USD = 10000;
const MIN_GASLESS_CAP_USD = 0;  // exclusive (cap > 0)

// Lee env por request, sin cache (consistente con getProtocolFeeRate).
export function getPyusdUsdRate(): number {
  const raw = process.env.PYUSD_USD_RATE;
  if (raw === undefined || raw === '') return DEFAULT_PYUSD_RATE;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_PYUSD_RATE || parsed > MAX_PYUSD_RATE) {
    console.warn(`[Price] Invalid PYUSD_USD_RATE="${raw}" — fallback ${DEFAULT_PYUSD_RATE}`);
    return DEFAULT_PYUSD_RATE;
  }
  return parsed;
}

// Convierte wei (PYUSD = 6 decimals) a USD aplicando el rate.
// Si valueWei excede Number.MAX_SAFE_INTEGER, retorna Infinity (NO throws).
export function pyusdWeiToUsd(valueWei: bigint): number {
  if (valueWei < 0n) return 0;  // defensa: bigint negativo no tiene sentido aquí
  // Convertir bigint -> number con guard de safe integer
  const safeMax = BigInt(Number.MAX_SAFE_INTEGER);
  if (valueWei > safeMax) return Number.POSITIVE_INFINITY;
  const valueNum = Number(valueWei);
  return (valueNum / 10 ** PYUSD_DECIMALS) * getPyusdUsdRate();
}

// Cap global env-backed
export function getGaslessDefaultCapUsd(): number {
  const raw = process.env.GASLESS_DEFAULT_CAP_USD;
  if (raw === undefined || raw === '') return DEFAULT_GASLESS_CAP_USD;
  const parsed = Number.parseFloat(raw);
  // Range (0, 10000] — exclusive lower bound, cap > 0 obligatorio
  if (!Number.isFinite(parsed) || parsed <= MIN_GASLESS_CAP_USD || parsed > MAX_GASLESS_CAP_USD) {
    console.warn(`[Price] Invalid GASLESS_DEFAULT_CAP_USD="${raw}" — fallback ${DEFAULT_GASLESS_CAP_USD}`);
    return DEFAULT_GASLESS_CAP_USD;
  }
  return parsed;
}
```

**Archivo NUEVO**: `src/lib/price.test.ts`

Tests T-PRICE-1..T-PRICE-10 (ver tabla en §3). Patrón:

```text
describe('getPyusdUsdRate', () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.PYUSD_USD_RATE;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalEnv;
  });

  it('T-PRICE-1: env unset → returns 1.0', () => { ... });
  it('T-PRICE-2: empty string → returns 1.0 silently', () => { ... });
  // etc.
});
```

**Para T-PRICE-3, T-PRICE-4, T-PRICE-10 (warns)**: usar
`vi.spyOn(console, 'warn')` (NO `vi.mock`) para verificar que se loguea
sin contaminar globalmente — patrón AB-WKH-57.

### W2 — Route preHandler `gaslessCostEstimatorPreHandler`

**Archivo MODIFICADO**: `src/routes/gasless.ts`

**Imports a agregar** (top del archivo):

```text
import { pyusdWeiToUsd, getGaslessDefaultCapUsd } from '../lib/price.js';
```

**Función nueva** (definir antes del export `gaslessRoutes`):

```text
async function gaslessCostEstimatorPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { to?: string; value?: string } | undefined;

  // Validación de shape (AC-6)
  if (!body || typeof body.to !== 'string' || typeof body.value !== 'string') {
    reply.status(400).send({ error: 'missing required fields: to, value' });
    return;
  }

  // Parse wei → bigint (AC-6)
  let valueWei: bigint;
  try {
    valueWei = BigInt(body.value);
  } catch {
    reply.status(400).send({ error: 'invalid value: must be a bigint string' });
    return;
  }

  // Compute USD (DT-A) — overflow seguro (CD-10)
  const estimatedCostUsd = pyusdWeiToUsd(valueWei);
  const cap = getGaslessDefaultCapUsd();

  // Validar cap (AC-2)
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd > cap) {
    reply.status(403).send({
      error: 'Transfer exceeds gasless cap',
      error_code: 'PER_CALL_LIMIT',
      cap_usd: cap,
      requested_usd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null,
    });
    return;
  }

  // Inyectar para el siguiente preHandler (DT-C, DT-D)
  request.gaslessEstimatedCostUsd = estimatedCostUsd;
}
```

**Cambio en el route registration** (línea 30-36):

```text
fastify.post(
  '/transfer',
  {
    preHandler: [
      gaslessCostEstimatorPreHandler,
      ...requirePaymentOrA2AKey({
        description: 'WasiAI Gasless Transfer — on-chain transfer from operator wallet',
      }),
    ],
  },
  async (req: FastifyRequest, reply: FastifyReply) => {
    // ... handler existente, con UN cambio:
    // después del `return reply.send(result);` exitoso (línea 57),
    // agregar log estructurado (AC-7):
  },
);
```

**Logging de éxito (AC-7)** — dentro del handler, ANTES del `return reply.send(result)`:

```text
req.log.info(
  {
    keyId: req.a2aKeyRow?.id,
    estimatedCostUsd: req.gaslessEstimatedCostUsd,
    actualValueWei: body.value,
    to: body.to,
    txHash: result.txHash ?? null,
  },
  'gasless transfer executed',
);
```

### W3 — Tests integración `src/routes/gasless.test.ts` (NUEVO)

**Patrón base** (referencia: `src/middleware/a2a-key.test.ts:1-150`):

```text
import Fastify from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adapters/registry.js', () => ({
  getGaslessAdapter: vi.fn(() => ({
    status: vi.fn().mockResolvedValue({ funding_state: 'ready' }),
    transfer: vi.fn().mockResolvedValue({ txHash: '0xabc123' }),
  })),
  getChainConfig: vi.fn(() => ({ chainId: 2368, name: 'eip155:2368', explorerUrl: '' })),
  getPaymentAdapter: vi.fn(() => ({ /* ... */ })),  // ver pattern en a2a-key.test.ts
}));

vi.mock('../services/identity.js', () => ({
  identityService: { lookupByHash: vi.fn() },
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
  },
}));
```

Cada test T-DRAIN-N: setup mocks específicos, `app.inject({ method: 'POST',
url: '/gasless/transfer', headers: { 'x-a2a-key': TEST_KEY }, payload: {...} })`,
verificar `statusCode`, `JSON.parse(response.body)`, y opcionalmente que
`mockTransfer.toHaveBeenCalledWith(...)` o `.not.toHaveBeenCalled()`.

**T-DRAIN-7 (logging)**: spyear `app.log.info` antes del inject:
```text
const logSpy = vi.spyOn(app.log, 'info');
await app.inject(...);
expect(logSpy).toHaveBeenCalledWith(
  expect.objectContaining({
    keyId: expect.any(String),
    estimatedCostUsd: expect.any(Number),
    actualValueWei: expect.any(String),
    to: expect.any(String),
    txHash: expect.any(String),
  }),
  'gasless transfer executed',
);
```

### W4 — Tests middleware `src/middleware/a2a-key.test.ts`

**Agregar al final del describe principal** un nuevo bloque:

```text
describe('WKH-59 cost estimation injection', () => {
  it('T-MW-GASLESS-1: sin gaslessEstimatedCostUsd → debita $1 placeholder', async () => {
    // setup: cualquier ruta protegida sin el campo
    // assert: mockDebit.toHaveBeenCalledWith(expect.any(String), 2368, 1.0)
  });

  it('T-MW-GASLESS-2: con gaslessEstimatedCostUsd=5 → debita $5', async () => {
    // setup: ruta de prueba que setea request.gaslessEstimatedCostUsd = 5
    //        antes del middleware (preHandler array)
    // assert: mockDebit.toHaveBeenCalledWith(expect.any(String), 2368, 5)
  });
});
```

Para T-MW-GASLESS-2: en el setup del test, registrar una ruta de test
con un preHandler array que inyecte el campo:

```text
app.post('/test-gasless-mw', {
  preHandler: [
    async (req) => { req.gaslessEstimatedCostUsd = 5; },
    ...requirePaymentOrA2AKey({ description: 'test' }),
  ],
}, async (req, reply) => reply.send({ ok: true }));
```

### W5 — `.env.example`

**Agregar después de la sección "Gasless EIP-3009"** (línea 92-97 actual):

```text
# ─────────────────────────────────────────────────────────────
# Gasless Pricing (WKH-59) — protección contra drain del operator
# ─────────────────────────────────────────────────────────────
# Rate de conversión PYUSD → USD usado por POST /gasless/transfer para
# convertir `body.value` (wei) en USD antes del debit del A2A key.
# PYUSD es stablecoin pegada 1:1 USD por diseño; este override existe
# para escenarios de depeg temporal o tokens test con rate distinto.
# Range válido [0, 100]. Fuera de rango / no parseable → fallback 1.0
# con console.warn. Default: 1.0
PYUSD_USD_RATE=1.0

# Cap GLOBAL para POST /gasless/transfer: el monto máximo en USD que
# una sola request puede mover desde el operator wallet, INDEPENDIENTE
# del budget de la key. Defensa-en-profundidad contra keys con budget
# alto que intenten drains masivos. Range válido (0, 10000]. Default: 10
GASLESS_DEFAULT_CAP_USD=10
```

---

## §5 — Anti-Hallucination Checklist

Antes de codear cada wave:

- [ ] **AB-WKH-57 (vi.spyOn)** — para tests con warns/console, usar
      `vi.spyOn(console, 'warn').mockImplementation(() => {})` y
      `mockRestore()` en `afterEach`. NO usar `vi.mock('console', ...)`.
- [ ] **AB-WKH-44 (mock chain Supabase)** — N/A directo. Esta HU no
      modifica chains de Supabase. Si extendés mocks de
      `budgetService.debit`/`identityService.lookupByHash`, replicar
      shape exacto del mock existente en `a2a-key.test.ts:31-37`.
- [ ] **CD-15 (helpers puros)** — `src/lib/price.ts` NO importa Fastify,
      NO importa Supabase, NO importa adapters. Solo `process.env`.
      Si te encontrás importando algo del backend → STOP.
- [ ] **DT-F: column name `daily_limit_usd`** (NO `max_spend_per_day_usd`).
      Verificado en `supabase/migrations/20260406000000_a2a_agent_keys.sql:16`.
- [ ] **CD-3 backward-compat**: una vez implementado W0, correr `npm test`
      ANTES de avanzar a W1/W2. Si bajan los 532 tests → bug en W0.
- [ ] **DT-D Augmentation**: el campo se declara UNA SOLA VEZ en
      `src/middleware/a2a-key.ts`. NO duplicar en `src/routes/gasless.ts`.
- [ ] **CD-10 overflow seguro**: `pyusdWeiToUsd(2n ** 60n)` retorna
      `Infinity`, NO throws. Verificado por T-PRICE-8.
- [ ] **CD-7 middleware body-agnostic**: el middleware NO lee
      `request.body`. NUNCA. Solo lee `request.gaslessEstimatedCostUsd`.

---

## §6 — Patrones a seguir (con exemplars verificados)

| Necesito... | Mirar exemplar | Path verificado |
|---|---|---|
| Helper env-backed con guard | `getProtocolFeeRate` | `src/services/fee-charge.ts:90-110` |
| Augment FastifyRequest | `a2aKeyRow?` | `src/middleware/a2a-key.ts:22-26` |
| `send403` con `error_code` | `send403` helper | `src/middleware/a2a-key.ts:38-45` |
| Mock `budgetService` en test | `vi.mock('../services/budget.js', ...)` | `src/middleware/a2a-key.test.ts:31-37` |
| `vi.spyOn` (no mock) — AB-WKH-57 | Pattern de transform tests | `doc/sdd/056-wkh-57-llm-bridge-pro/auto-blindaje.md` |
| Pino structured log | `request.log.info({...}, 'msg')` | `src/middleware/a2a-key.ts:196-202` |
| preHandler array | Multi-stage hooks | Ver Fastify docs + `src/routes/auth.ts` |

---

## §7 — Comandos clave

```bash
# Pre-flight
git checkout -b feat/061-wkh-59-sec-drain-1
npm test  # baseline 532

# Per-wave
npm test -- src/lib/price.test.ts          # W1
npm test -- src/routes/gasless.test.ts     # W3
npm test -- src/middleware/a2a-key.test.ts # W4
npm test                                   # full suite ~552

# Lint
npm run lint
npm run typecheck
```

---

## §8 — Done Definition (DoD)

- [ ] **Producción**: `src/lib/price.ts`, `src/routes/gasless.ts`,
      `src/middleware/a2a-key.ts` modificados según §4.
- [ ] **Tests nuevos**: 20 tests pasan (T-PRICE-1..10, T-DRAIN-1..8,
      T-MW-GASLESS-1..2).
- [ ] **Baseline**: 532 tests existentes siguen verde (CD-3, CD-4).
- [ ] **Total**: ~552 tests verde.
- [ ] **Lint**: `npm run lint` pasa sin warnings.
- [ ] **Typecheck**: `npm run typecheck` pasa (cero `any`, cero
      `as unknown as X`).
- [ ] **`.env.example`**: nueva sección agregada con docstrings.
- [ ] **Logging AC-7**: el path de éxito loguea con
      `request.log.info({...}, 'gasless transfer executed')`.
- [ ] **Smoke manual** (opcional, si hay credenciales):
      ```bash
      # 1. value=$5, key budget $100 → 200
      curl -X POST localhost:3001/gasless/transfer \
        -H "x-a2a-key: $KEY" \
        -d '{"to":"0x...","value":"5000000"}'
      # 2. value=$50 (excede cap $10) → 403 PER_CALL_LIMIT
      curl -X POST localhost:3001/gasless/transfer \
        -H "x-a2a-key: $KEY" \
        -d '{"to":"0x...","value":"50000000"}'
      ```
- [ ] **CR/AR ready**: el reviewer puede verificar línea por línea
      contra los 12 CDs del SDD.

---

## §9 — Notas finales para el Dev

1. **NO toquen** la migration de Supabase ni la PG function
   `increment_a2a_key_spend`. El daily_limit ya se enforce
   atómicamente; basta con pasar el `estimatedCostUsd` correcto al
   `debit`.
2. **NO toquen** `src/services/budget.ts`. El service ya recibe
   `amountUsd: number` y lo propaga.
3. **NO toquen** el adapter de gasless. El bug es de pricing, no de
   transferencia.
4. Si encuentras un edge case no cubierto por los 20 tests → agregalo
   con ID `T-DRAIN-9+` o `T-PRICE-11+` en el mismo archivo.
5. Si el cap default de $10 te parece bajo durante manual smoke,
   **NO lo cambies en el código** — el operator lo eleva por env
   var. El default conservador es deliberado (CD del work-item).
6. Auto-Blindaje al final: si encontrás un bug en wave N que no
   estaba en este Story File, registralo en
   `doc/sdd/061-wkh-59-sec-drain-1/auto-blindaje.md` para futuras HUs.
