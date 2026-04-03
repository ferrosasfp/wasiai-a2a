# SDD — WKH-6: Kite Service Provider x402 Payment Middleware

**Estado:** Draft  
**Fecha:** 2026-04-02  
**Autor:** Architect (NexusAgile F2)  
**Work Item:** WKH-6  
**Branch:** `feat/wkh-6-kite-payment`

> ⚠️ **Nota de alineación con codebase real:**  
> El work-item menciona "Hono" como framework, pero el codebase real usa **Fastify** (`fastify@4`, `@fastify/cors`). Este SDD está alineado con el codebase real. Todas las APIs, tipos y patrones son de Fastify.

---

## 1. Context Map

### Estado Actual

```
POST /orchestrate
  → orchestrateRoutes (FastifyPluginAsync)
    → body validation (goal, budget)
    → orchestrateService.orchestrate(...)
    ← 200 { ...result }

POST /compose
  → composeRoutes (FastifyPluginAsync)
    → body validation (steps, maxBudget)
    → composeService.compose(...)
    ← 200 { ...result }
```

**Sin ningún control de acceso ni pago.** Cualquiera puede llamar los endpoints gratuitamente.

### Estado Objetivo

```
POST /orchestrate
  → x402PaymentHook (Fastify preHandler)
    ├── Sin X-Payment header
    │   └── ← 402 { error, accepts: [x402Payload], x402Version: 1 }
    ├── X-Payment inválido (base64/JSON malformado)
    │   └── ← 402 { error: "Invalid X-Payment format: ...", accepts: [...] }
    ├── KITE_WALLET_ADDRESS no configurada
    │   └── ← 503 { error: "Service payment not configured..." }
    └── X-Payment presente y parseable
        → POST https://facilitator.pieverse.io/v2/verify
          ├── valid: false → ← 402 { error: "Payment verification failed: ..." }
          └── valid: true
              → POST https://facilitator.pieverse.io/v2/settle
                ├── fallo → ← 402 { error: "Payment settlement failed: ..." }
                └── éxito → kiteTxHash guardado en request
                    → orchestrateRoutes handler (existente, sin cambios)
                    ← 200 { kiteTxHash, ...result }

POST /compose — flujo idéntico, description distinto
```

### Qué Cambia

| Archivo | Cambio |
|---------|--------|
| `src/middleware/x402.ts` | **NUEVO** — Fastify preHandler hook factory |
| `src/routes/orchestrate.ts` | Añadir `preHandler: [requirePayment(...)]` + incluir `kiteTxHash` en respuesta |
| `src/routes/compose.ts` | Ídem |
| `src/types/index.ts` | Añadir tipos x402 y Pieverse |
| `.env.example` | Añadir variables Kite Service Provider |

### Qué NO Cambia

- `src/index.ts` — sin modificaciones
- `src/services/orchestrate.ts` — sin modificaciones
- `src/services/compose.ts` — sin modificaciones
- `src/services/kite-client.ts` — sin modificaciones
- `src/lib/kite-chain.ts` — sin modificaciones
- `/registries`, `/discover` — sin pago
- Esquema de base de datos — no se persisten transacciones en esta HU
- Dependencias npm — no se añaden nuevas

---

## 2. Decisiones de Diseño (ADRs)

### ADR-1: Fastify preHandler hook (no plugin separado)

**Decisión:** El middleware x402 se implementa como una función factory `requirePayment(opts)` que retorna un arreglo de preHandler hooks de Fastify, registrado directamente en la definición de cada route con `{ preHandler: [requirePayment(opts)] }`.

**Alternativas consideradas:**
- Plugin Fastify (`fastify.register`): más overhead, no necesario para algo route-específico
- Decorador de Fastify: no aporta ventaja aquí, más complejo

**Razón:** Los preHandlers son el mecanismo idiomático de Fastify para middleware route-scoped. Mantiene la lógica de pago colocada junto a la route que la usa, y no "contamina" routes que no requieren pago (`/registries`, `/discover`).

### ADR-2: Estructura de `src/middleware/x402.ts`

**Decisión:** Un único archivo exporta:
1. `requirePayment(opts: PaymentMiddlewareOptions): FastifyPreHandlerHookHandler[]` — factory
2. `buildX402Response(opts, resource): X402Response` — construye el 402 body
3. `decodeXPayment(header: string): X402PaymentRequest` — decodifica base64
4. `verifyPayment(payload: X402PaymentRequest): Promise<PieverseVerifyResponse>` — llama /v2/verify
5. `settlePayment(payload: X402PaymentRequest): Promise<PieverseSettleResult>` — llama /v2/settle

**No se crea `src/services/kite/payment.ts`** separado — el work-item lo describe pero el codebase actual no tiene estructura `services/kite/`, y la separación no aporta valor en esta escala. Todo vive en `src/middleware/x402.ts`.

### ADR-3: Integración en orchestrate.ts y compose.ts

**Decisión:** Las routes se modifican mínimamente:
1. Import de `requirePayment` desde `../middleware/x402.js`
2. `preHandler` añadido a la definición del route handler
3. `kiteTxHash` extraído de `request` (via propiedad custom) e incluido en respuesta

El `orchestrateService` y `composeService` **no se tocan**.

### ADR-4: Comunicación de kiteTxHash entre preHandler y handler

**Decisión:** Usar `request.kiteTxHash` como propiedad custom en el objeto `FastifyRequest`. Se declara con module augmentation de TypeScript en el archivo del middleware.

**Alternativa descartada:** `reply.header('X-Kite-TxHash', ...)` — menos expresivo para tipado TS.

### ADR-5: Manejo de errores HTTP 402 vs 500

| Condición | Status | Razón |
|-----------|--------|-------|
| Sin `X-Payment` header | **402** | Protocolo x402: el cliente debe pagar |
| `X-Payment` base64/JSON inválido | **402** | El cliente envió un pago malformado |
| Pieverse `/v2/verify` retorna `valid: false` | **402** | Pago inválido/expirado |
| Pieverse `/v2/verify` HTTP error (5xx, timeout) | **402** | Facilitador no disponible — no continuar sin verificación |
| Pieverse `/v2/settle` falla | **402** | Fondos potencialmente no transferidos — no entregar servicio |
| `KITE_WALLET_ADDRESS` no configurada | **503** | Error de configuración del servidor, no del cliente |
| Error interno inesperado en middleware | **500** | Bug genuino — no ocultar bajo 402 |

**Principio:** Nunca entregar el servicio si la verificación/settle fallan. El 402 con `accepts` permite al cliente reintentar correctamente.

### ADR-5: TypeScript — tipos en `src/types/index.ts`

**Decisión:** Todos los tipos x402 y Pieverse se añaden a `src/types/index.ts` en una sección nueva, extendiendo el bloque `PAYMENT TYPES` existente. Module augmentation de `FastifyRequest` vive en `src/middleware/x402.ts`.

---

## 3. Diseño Técnico

### 3.1 Archivos nuevos/modificados

---

#### `src/middleware/x402.ts` — NUEVO (código completo)

```typescript
/**
 * x402 Payment Middleware — Fastify preHandler hook
 *
 * Implementa el protocolo x402 para Kite Testnet vía Pieverse facilitador.
 * No añade dependencias npm: usa globalThis.fetch (Node ≥18).
 *
 * Uso:
 *   fastify.post('/', { preHandler: requirePayment({ description: '...', amount: '...' }) }, handler)
 */

import type { FastifyRequest, FastifyReply, FastifyPreHandlerHookHandler } from 'fastify'
import type {
  X402Response,
  X402PaymentPayload,
  X402PaymentRequest,
  PieverseVerifyRequest,
  PieverseVerifyResponse,
  PieverseSettleRequest,
  PieverseSettleResult,
} from '../types/index.js'

// ─── Constantes de red ────────────────────────────────────────────────────────

export const KITE_SCHEME = 'gokite-aa' as const
export const KITE_NETWORK = 'kite-testnet' as const
export const KITE_PAYMENT_TOKEN = '0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63' as const
export const KITE_MAX_TIMEOUT_SECONDS = 300 as const
export const KITE_FACILITATOR_DEFAULT_URL = 'https://facilitator.pieverse.io' as const
export const KITE_FACILITATOR_ADDRESS = '0x12343e649e6b2b2b77649DFAb88f103c02F3C78b' as const

// ─── TypeScript augmentation ──────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    kiteTxHash?: string
    kitePaymentVerified?: boolean
  }
}

// ─── Tipos de configuración ───────────────────────────────────────────────────

export interface PaymentMiddlewareOptions {
  /** Descripción del servicio que se muestra al pagador */
  description: string
  /** Monto en wei (default: "1000000000000000000" = 1 Test USDT) */
  amount?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Construye el body de respuesta HTTP 402 con el payload x402 completo.
 */
export function buildX402Response(
  opts: PaymentMiddlewareOptions,
  resource: string,
  errorMessage: string = 'X-PAYMENT header is required',
): X402Response {
  const walletAddress = process.env.KITE_WALLET_ADDRESS ?? ''
  const amount = opts.amount ?? '1000000000000000000'
  const merchantName = process.env.KITE_MERCHANT_NAME ?? 'WasiAI'

  const payload: X402PaymentPayload = {
    scheme: KITE_SCHEME,
    network: KITE_NETWORK,
    maxAmountRequired: amount,
    resource,
    description: opts.description,
    mimeType: 'application/json',
    outputSchema: undefined,
    payTo: walletAddress,
    maxTimeoutSeconds: KITE_MAX_TIMEOUT_SECONDS,
    asset: KITE_PAYMENT_TOKEN,
    extra: null,
    merchantName,
  }

  return {
    error: errorMessage,
    accepts: [payload],
    x402Version: 1,
  }
}

/**
 * Decodifica el header X-Payment (base64 → JSON).
 * Lanza Error con mensaje descriptivo si falla.
 */
export function decodeXPayment(header: string): X402PaymentRequest {
  let decoded: string
  try {
    decoded = Buffer.from(header, 'base64').toString('utf8')
  } catch {
    throw new Error('Cannot decode base64: invalid characters')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    throw new Error('Cannot parse JSON from decoded X-Payment header')
  }

  const obj = parsed as Record<string, unknown>

  if (!obj.authorization || typeof obj.authorization !== 'object') {
    throw new Error('Missing or invalid "authorization" field in X-Payment')
  }
  if (!obj.signature || typeof obj.signature !== 'string') {
    throw new Error('Missing or invalid "signature" field in X-Payment')
  }

  return parsed as X402PaymentRequest
}

/**
 * Llama a POST /v2/verify en el facilitador Pieverse.
 */
export async function verifyPayment(
  payload: X402PaymentRequest,
): Promise<PieverseVerifyResponse> {
  const facilitatorUrl =
    process.env.KITE_FACILITATOR_URL ?? KITE_FACILITATOR_DEFAULT_URL

  const body: PieverseVerifyRequest = {
    authorization: payload.authorization,
    signature: payload.signature,
    network: KITE_NETWORK,
  }

  let response: Response
  try {
    response = await fetch(`${facilitatorUrl}/v2/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(
      `Facilitator network error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!response.ok) {
    throw new Error(`Facilitator returned HTTP ${response.status} on /v2/verify`)
  }

  return (await response.json()) as PieverseVerifyResponse
}

/**
 * Llama a POST /v2/settle en el facilitador Pieverse.
 */
export async function settlePayment(
  payload: X402PaymentRequest,
): Promise<PieverseSettleResult> {
  const facilitatorUrl =
    process.env.KITE_FACILITATOR_URL ?? KITE_FACILITATOR_DEFAULT_URL

  const body: PieverseSettleRequest = {
    authorization: payload.authorization,
    signature: payload.signature,
    network: KITE_NETWORK,
  }

  let response: Response
  try {
    response = await fetch(`${facilitatorUrl}/v2/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(
      `Facilitator network error on settle: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!response.ok) {
    throw new Error(`Facilitator returned HTTP ${response.status} on /v2/settle`)
  }

  return (await response.json()) as PieverseSettleResult
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Retorna un array de Fastify preHandler hooks que implementan x402.
 *
 * Uso:
 *   fastify.post('/', { preHandler: requirePayment({ description: '...' }) }, handler)
 */
export function requirePayment(
  opts: PaymentMiddlewareOptions,
): FastifyPreHandlerHookHandler[] {
  const handler: FastifyPreHandlerHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // AC-7: KITE_WALLET_ADDRESS no configurada → 503
    if (!process.env.KITE_WALLET_ADDRESS) {
      request.log.error('[FATAL] KITE_WALLET_ADDRESS not set — payment endpoints disabled')
      return reply.status(503).send({
        error: 'Service payment not configured. Contact administrator.',
      })
    }

    const resource = `${request.protocol}://${request.hostname}${request.url}`
    const xPaymentHeader = request.headers['x-payment']

    // AC-1: Sin header → 402
    if (!xPaymentHeader || typeof xPaymentHeader !== 'string') {
      return reply.status(402).send(buildX402Response(opts, resource))
    }

    // AC-5: Decodificar base64/JSON
    let paymentPayload: X402PaymentRequest
    try {
      paymentPayload = decodeXPayment(xPaymentHeader)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return reply.status(402).send(
        buildX402Response(opts, resource, `Invalid X-Payment format: ${detail}`),
      )
    }

    // AC-2: Verificar con Pieverse
    let verifyResult: PieverseVerifyResponse
    try {
      verifyResult = await verifyPayment(paymentPayload)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return reply.status(402).send(
        buildX402Response(opts, resource, `Facilitator unavailable: ${detail}`),
      )
    }

    if (!verifyResult.valid) {
      return reply.status(402).send(
        buildX402Response(
          opts,
          resource,
          `Payment verification failed: ${verifyResult.error ?? 'unknown reason'}`,
        ),
      )
    }

    // AC-3: Settle on-chain
    let settleResult: PieverseSettleResult
    try {
      settleResult = await settlePayment(paymentPayload)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return reply.status(402).send(
        buildX402Response(opts, resource, `Payment settlement failed: ${detail}`),
      )
    }

    if (!settleResult.success) {
      return reply.status(402).send(
        buildX402Response(
          opts,
          resource,
          `Payment settlement failed: ${settleResult.error ?? 'unknown reason'}`,
        ),
      )
    }

    // AC-3+4: Pago verificado y liquidado — propagar txHash al handler
    request.kiteTxHash = settleResult.txHash
    request.kitePaymentVerified = true
    // continúa al handler (no llamar reply.send ni return un valor)
  }

  return [handler]
}
```

---

#### `src/routes/orchestrate.ts` — modificaciones exactas

**Archivo completo resultado (diff conceptual: se añaden 2 imports y se modifica el handler):**

```typescript
/**
 * Orchestrate Routes — Goal-based orchestration
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { orchestrateService } from '../services/orchestrate.js'
import { requirePayment } from '../middleware/x402.js'   // ← AÑADIR

const orchestrateRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /orchestrate
   * Execute goal-based orchestration
   *
   * Body:
   * {
   *   "goal": "Analyze token 0xABC and tell me if it's safe to buy",
   *   "budget": 0.50,
   *   "preferCapabilities": ["token-analysis", "risk-assessment"],
   *   "maxAgents": 3
   * }
   */
  fastify.post(
    '/',
    { preHandler: requirePayment({ description: 'WasiAI Orchestration Service — Goal-based AI agent orchestration' }) },  // ← AÑADIR
    async (
      request: FastifyRequest<{
        Body: {
          goal: string
          budget: number
          preferCapabilities?: string[]
          maxAgents?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        if (!body.goal) {
          return reply.status(400).send({ error: 'Missing required field: goal' })
        }

        if (!body.budget || body.budget <= 0) {
          return reply.status(400).send({ error: 'Missing or invalid budget' })
        }

        const result = await orchestrateService.orchestrate({
          goal: body.goal,
          budget: body.budget,
          preferCapabilities: body.preferCapabilities,
          maxAgents: body.maxAgents,
        })

        // ← MODIFICAR: incluir kiteTxHash en respuesta (AC-4)
        const kiteTxHash = request.kiteTxHash
        return reply.send({ kiteTxHash, ...result })
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Orchestration failed',
        })
      }
    },
  )
}

export default orchestrateRoutes
```

**Diff exacto (cambios únicamente):**

```diff
+import { requirePayment } from '../middleware/x402.js'

-  fastify.post(
-    '/',
-    async (
+  fastify.post(
+    '/',
+    { preHandler: requirePayment({ description: 'WasiAI Orchestration Service — Goal-based AI agent orchestration' }) },
+    async (

-        return reply.send(result)
+        const kiteTxHash = request.kiteTxHash
+        return reply.send({ kiteTxHash, ...result })
```

---

#### `src/routes/compose.ts` — modificaciones exactas

```typescript
/**
 * Compose Routes — Multi-agent pipelines
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { composeService } from '../services/compose.js'
import type { ComposeStep } from '../types/index.js'
import { requirePayment } from '../middleware/x402.js'   // ← AÑADIR

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /compose
   * Execute a multi-agent pipeline
   *
   * Body:
   * {
   *   "steps": [
   *     { "agent": "agent-slug", "registry": "wasiai", "input": {...}, "passOutput": false },
   *     { "agent": "another-agent", "input": {...}, "passOutput": true }
   *   ],
   *   "maxBudget": 0.50
   * }
   */
  fastify.post(
    '/',
    { preHandler: requirePayment({ description: 'WasiAI Compose Service — Multi-agent pipeline execution' }) },  // ← AÑADIR
    async (
      request: FastifyRequest<{
        Body: {
          steps: ComposeStep[]
          maxBudget?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
          return reply.status(400).send({ error: 'Missing or empty steps array' })
        }

        if (body.steps.length > 5) {
          return reply.status(400).send({ error: 'Maximum 5 steps allowed per pipeline' })
        }

        const result = await composeService.compose({
          steps: body.steps,
          maxBudget: body.maxBudget,
        })

        if (!result.success) {
          return reply.status(400).send(result)
        }

        // ← MODIFICAR: incluir kiteTxHash en respuesta (AC-4)
        const kiteTxHash = request.kiteTxHash
        return reply.send({ kiteTxHash, ...result })
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Compose failed',
        })
      }
    },
  )
}

export default composeRoutes
```

**Diff exacto (cambios únicamente):**

```diff
+import { requirePayment } from '../middleware/x402.js'

-  fastify.post(
-    '/',
-    async (
+  fastify.post(
+    '/',
+    { preHandler: requirePayment({ description: 'WasiAI Compose Service — Multi-agent pipeline execution' }) },
+    async (

-        return reply.send(result)
+        const kiteTxHash = request.kiteTxHash
+        return reply.send({ kiteTxHash, ...result })
```

---

#### `.env.example` — variables a añadir

Añadir al final del archivo (o crear la sección si no existe):

```bash
# ─── Kite Service Provider (x402) ───────────────────────────────────────────
# Wallet address on Kite testnet that receives payments (OBLIGATORIO)
KITE_WALLET_ADDRESS=0xYourServiceWalletAddress

# Pieverse facilitator URL (default usado si no se define: https://facilitator.pieverse.io)
KITE_FACILITATOR_URL=https://facilitator.pieverse.io

# Payment amount in wei (default: 1000000000000000000 = 1 Test USDT)
# Solo necesario si se quiere sobreescribir el default del código
KITE_PAYMENT_AMOUNT=1000000000000000000

# Merchant name shown to paying agents
KITE_MERCHANT_NAME=WasiAI
```

---

### 3.2 Tipos TypeScript para x402

Añadir al final de `src/types/index.ts`, después de `PaymentAuth`:

```typescript
// ============================================================
// x402 PROTOCOL TYPES (Kite Testnet)
// ============================================================

/**
 * Payload dentro del array "accepts" de una respuesta 402.
 * Describe el pago que el cliente debe realizar.
 */
export interface X402PaymentPayload {
  scheme: 'gokite-aa'
  network: 'kite-testnet' | 'kite-mainnet'
  /** Monto máximo requerido en wei */
  maxAmountRequired: string
  /** URL del endpoint que requiere pago */
  resource: string
  description: string
  mimeType: string
  outputSchema?: {
    input?: Record<string, unknown>
    output?: Record<string, unknown>
  }
  /** Wallet address del service provider que recibe el pago */
  payTo: string
  maxTimeoutSeconds: number
  /** Contract address del token de pago */
  asset: string
  extra: null | Record<string, unknown>
  merchantName: string
}

/**
 * Body completo de una respuesta HTTP 402 conforme a x402.
 */
export interface X402Response {
  error: string
  accepts: X402PaymentPayload[]
  x402Version: 1
}

/**
 * Payload decodificado del header X-Payment (base64 JSON).
 * Generado por el cliente (Kite MCP / Agent Passport).
 */
export interface X402PaymentRequest {
  authorization: {
    from: string        // Wallet address del pagador
    to: string          // Wallet address del service provider
    value: string       // Monto en wei
    validAfter: string  // Unix timestamp (string) — "0" si inmediato
    validBefore: string // Unix timestamp (string) — deadline de expiración
    nonce: string       // 0x... nonce único para esta autorización
  }
  signature: string     // Firma EIP-712 del pagador
  network?: string      // "kite-testnet" (opcional, el middleware usa la constante)
}

/**
 * Request body para POST /v2/verify en Pieverse.
 */
export interface PieverseVerifyRequest {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

/**
 * Response de POST /v2/verify en Pieverse.
 */
export interface PieverseVerifyResponse {
  valid: boolean
  error?: string
}

/**
 * Request body para POST /v2/settle en Pieverse.
 */
export interface PieverseSettleRequest {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

/**
 * Response de POST /v2/settle en Pieverse.
 */
export interface PieverseSettleResult {
  txHash: string
  success: boolean
  error?: string
}
```

---

### 3.3 Flujo completo con constantes

```
CONSTANTES FIJAS EN CÓDIGO (src/middleware/x402.ts):
  KITE_SCHEME             = "gokite-aa"
  KITE_NETWORK            = "kite-testnet"
  KITE_PAYMENT_TOKEN      = "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63"
  KITE_MAX_TIMEOUT_SECONDS = 300
  KITE_FACILITATOR_DEFAULT_URL = "https://facilitator.pieverse.io"
  KITE_FACILITATOR_ADDRESS = "0x12343e649e6b2b2b77649DFAb88f103c02F3C78b"

CONSTANTES DESDE ENV:
  process.env.KITE_WALLET_ADDRESS    → payTo en el 402 body (OBLIGATORIA)
  process.env.KITE_FACILITATOR_URL   → URL base Pieverse (default arriba)
  process.env.KITE_MERCHANT_NAME     → merchantName (default "WasiAI")

────────────────────────────────────────────────────────────────
CASO A — Sin X-Payment
────────────────────────────────────────────────────────────────

POST /orchestrate
  headers: { Content-Type: application/json }
  body: { "goal": "...", "budget": 0.5 }

→ preHandler: requirePayment ejecuta
  ✗ request.headers['x-payment'] undefined
  → reply.status(402).send({
      error: "X-PAYMENT header is required",
      accepts: [{
        scheme: "gokite-aa",
        network: "kite-testnet",
        maxAmountRequired: "1000000000000000000",
        resource: "http://localhost:3001/orchestrate",
        description: "WasiAI Orchestration Service — Goal-based AI agent orchestration",
        mimeType: "application/json",
        payTo: "0x<KITE_WALLET_ADDRESS>",
        maxTimeoutSeconds: 300,
        asset: "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
        extra: null,
        merchantName: "WasiAI"
      }],
      x402Version: 1
    })

← HTTP 402

────────────────────────────────────────────────────────────────
CASO B — Con X-Payment válido (happy path)
────────────────────────────────────────────────────────────────

POST /orchestrate
  headers: {
    Content-Type: application/json,
    X-Payment: <base64(JSON.stringify({ authorization: {...}, signature: "0x..." }))>
  }
  body: { "goal": "...", "budget": 0.5 }

→ preHandler: requirePayment ejecuta
  ✓ KITE_WALLET_ADDRESS definida
  ✓ x-payment header presente y string
  ✓ decodeXPayment(header) → { authorization: {...}, signature: "0x..." }

  → POST https://facilitator.pieverse.io/v2/verify
    body: {
      authorization: { from, to, value: "1000000000000000000", validAfter, validBefore, nonce },
      signature: "0x...",
      network: "kite-testnet"
    }
  ← { valid: true }

  → POST https://facilitator.pieverse.io/v2/settle
    body: { authorization: {...}, signature: "0x...", network: "kite-testnet" }
  ← { txHash: "0xabc123...", success: true }

  request.kiteTxHash = "0xabc123..."
  request.kitePaymentVerified = true
  // → continúa al handler

→ handler de orchestrateRoutes ejecuta
  → orchestrateService.orchestrate({ goal, budget, ... })
  ← { answer: "...", reasoning: "...", pipeline: {...}, consideredAgents: [...] }

  → reply.send({
      kiteTxHash: "0xabc123...",
      answer: "...",
      reasoning: "...",
      pipeline: {...},
      consideredAgents: [...]
    })

← HTTP 200

────────────────────────────────────────────────────────────────
CASO C — X-Payment inválido (base64 malformado)
────────────────────────────────────────────────────────────────

POST /orchestrate
  headers: { X-Payment: "invalido!!!" }

→ decodeXPayment("invalido!!!") lanza Error("Cannot parse JSON...")
→ reply.status(402).send({
    error: "Invalid X-Payment format: Cannot parse JSON...",
    accepts: [...payload x402...],
    x402Version: 1
  })
← HTTP 402

────────────────────────────────────────────────────────────────
CASO D — Pieverse verify rechaza pago
────────────────────────────────────────────────────────────────

POST /orchestrate
  headers: { X-Payment: <base64 válido pero pago expirado> }

→ verifyPayment(...) → { valid: false, error: "Payment expired" }
→ reply.status(402).send({
    error: "Payment verification failed: Payment expired",
    accepts: [...payload x402...],
    x402Version: 1
  })
← HTTP 402
```

---

## 4. Waves de implementación

### Wave 0 — `src/middleware/x402.ts` (archivo nuevo)

**Entregable:** El archivo `src/middleware/x402.ts` completo y compilando.  
**Verificación:** `tsc --noEmit` sin errores en el archivo.  
**Dependencias:** Solo `fastify` (ya en deps) y `../types/index.js` (tipos añadidos antes).

**Orden de subtareas en Wave 0:**
1. Añadir tipos x402 a `src/types/index.ts` (los tipos deben existir antes que el middleware los importe)
2. Crear `src/middleware/x402.ts` con el código completo

### Wave 1 — Integración en routes

**Entregable:** `src/routes/orchestrate.ts` y `src/routes/compose.ts` modificados.  
**Verificación:** `tsc --noEmit` sin errores. `curl` sin `X-Payment` retorna 402.  
**Dependencias:** Wave 0 completada.

**Orden de subtareas en Wave 1:**
1. Modificar `src/routes/orchestrate.ts`
2. Modificar `src/routes/compose.ts`
3. Verificar compilación: `tsc --noEmit`

### Wave 2 — Variables de entorno + verificación build

**Entregable:** `.env.example` actualizado, build limpio, lint limpio.  
**Verificación:** `npm run build` (o `tsc`) sin errores. `eslint src/` sin errores.  
**Dependencias:** Wave 1 completada.

**Orden de subtareas en Wave 2:**
1. Actualizar `.env.example` con variables Kite Service Provider
2. `tsc --noEmit` — confirmar 0 errores
3. `eslint src/` — confirmar 0 errores
4. Test manual con curl (sin `X-Payment` → 402, con header inválido → 402 descriptivo)

---

## 5. Constraint Directives

### OBLIGATORIO

1. **OBLIGATORIO:** `src/middleware/x402.ts` usa `globalThis.fetch` (fetch nativo Node ≥18). **Prohibido `node-fetch`, `axios`, `got` u otras librerías HTTP.**
2. **OBLIGATORIO:** Los valores de `KITE_SCHEME`, `KITE_NETWORK`, `KITE_PAYMENT_TOKEN`, `KITE_FACILITATOR_ADDRESS`, `KITE_MAX_TIMEOUT_SECONDS` deben ser constantes exportadas en `src/middleware/x402.ts`, no hardcodeadas inline en funciones.
3. **OBLIGATORIO:** `KITE_WALLET_ADDRESS` no definida → HTTP 503 (no 402, no 500). Log: `[FATAL] KITE_WALLET_ADDRESS not set — payment endpoints disabled`.
4. **OBLIGATORIO:** Nunca llamar `orchestrateService.orchestrate()` ni `composeService.compose()` si `settlePayment()` retorna `success: false` o lanza excepción.
5. **OBLIGATORIO:** `kiteTxHash` debe aparecer en el body de la respuesta 200 de `/orchestrate` y `/compose` (AC-4).
6. **OBLIGATORIO:** Module augmentation de `FastifyRequest` (para `kiteTxHash` y `kitePaymentVerified`) debe declararse en `src/middleware/x402.ts`, no en `src/types/index.ts`.
7. **OBLIGATORIO:** Todos los tipos x402 y Pieverse deben exportarse desde `src/types/index.ts`. El middleware los importa desde ahí.
8. **OBLIGATORIO:** `src/index.ts` no se modifica. El middleware se integra solo a nivel de route, no de servidor.
9. **OBLIGATORIO:** TypeScript strict — cero `any` explícito. Las respuestas de Pieverse se castean con `as PieverseVerifyResponse` / `as PieverseSettleResult` (typecast explícito documentado, no `any`).

### PROHIBIDO

10. **PROHIBIDO:** Modificar `src/services/orchestrate.ts` o `src/services/compose.ts`.
11. **PROHIBIDO:** Modificar `src/routes/registries.ts` o `src/routes/discover.ts` — esos endpoints no tienen pago.
12. **PROHIBIDO:** Añadir dependencias npm nuevas. `package.json` no cambia.
13. **PROHIBIDO:** Llamar `/v2/settle` sin haber recibido `{ valid: true }` de `/v2/verify`.
14. **PROHIBIDO:** Persistir transacciones en Supabase (fuera de scope de esta HU).
15. **PROHIBIDO:** Usar `ethers.js` — si se requiere manipulación de wallets en el futuro, usar `viem` (ya en deps).
16. **PROHIBIDO:** `process.exit()` si `KITE_WALLET_ADDRESS` no está definida — el servidor debe seguir sirviendo `/registries` y `/discover`.

---

## 6. Readiness Check

### ¿El Dev puede implementar sin preguntas?

| Pregunta que el Dev podría tener | Respondida en SDD |
|----------------------------------|-------------------|
| ¿Dónde crea el archivo nuevo? | ✅ `src/middleware/x402.ts` — código completo en §3.1 |
| ¿Qué framework usar (Hono vs Fastify)? | ✅ Fastify. Nota de alineación en encabezado del SDD |
| ¿Cómo se conecta el middleware a las routes? | ✅ `{ preHandler: requirePayment(...) }` — ejemplo en §3.1 |
| ¿Qué constantes usar exactamente? | ✅ Todas en §3.3 y como exportadas en código |
| ¿Cómo decodificar X-Payment? | ✅ `Buffer.from(header, 'base64').toString('utf8')` + JSON.parse — en código |
| ¿Qué hacer si falla el settle? | ✅ HTTP 402 con error descriptivo, NO ejecutar servicio |
| ¿Cómo comunicar txHash al handler? | ✅ `request.kiteTxHash` — module augmentation en §3.1 |
| ¿Qué variables de entorno son obligatorias vs opcionales? | ✅ `KITE_WALLET_ADDRESS` obligatoria, resto opcionales con defaults |
| ¿Qué status code para wallet no configurada? | ✅ 503 con mensaje específico — AC-7 y §2 ADR-5 |
| ¿Modificar `src/index.ts`? | ✅ No — explícito en §1 y §5 |
| ¿Dónde añadir los tipos TypeScript? | ✅ `src/types/index.ts` — código completo en §3.2 |
| ¿Añadir dependencias npm? | ✅ No — explícito en §5 y work-item |
| ¿En qué orden implementar? | ✅ Waves 0→1→2 en §4 |
| ¿Qué URLs exactas de Pieverse? | ✅ `/v2/verify` y `/v2/settle` en §3.1 y §3.3 |
| ¿Qué body enviar a Pieverse? | ✅ Ejemplos exactos en §3.3 flujo completo |

### Veredicto

✅ **SDD es SUFICIENTE para implementación directa.**

El Dev puede copiar el código de §3.1 directamente a los archivos indicados, seguir el orden de Waves en §4, y verificar con los curl del work-item. No hay ambigüedades de diseño ni decisiones técnicas abiertas.

---

SDD_COMPLETE_WKH6 — Listo para revisión
