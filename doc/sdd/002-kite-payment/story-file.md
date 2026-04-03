# Story File — WKH-6: x402 Payment Middleware

> **Este documento es tu único contrato.** No leas el SDD, no leas el work-item. Todo lo que necesitas para implementar está aquí.

---

## Contexto

WasiAI actúa como **Service Provider** en el ecosistema Kite Agent Passport. Actualmente, `POST /orchestrate` y `POST /compose` no tienen ningún control de acceso: cualquiera los llama gratis. Esta story añade el protocolo x402 — un estándar HTTP que permite a agentes autónomos pagar por servicios directamente, sin intervención humana en el momento del pago.

El flujo: el agente llama el endpoint sin pago → recibe HTTP 402 con instrucciones de pago → firma una autorización EIP-712 → reenvía la request con el header `X-Payment` → el servidor verifica y liquida el pago vía Pieverse (facilitador on-chain en Kite Testnet) → entrega el resultado. El servidor nunca ejecuta el servicio si la verificación o el settle fallan.

---

## Branch

```
feat/wkh-6-kite-payment
```
Base: `main`

---

## Archivos a crear/modificar

| Archivo | Acción |
|---------|--------|
| `src/middleware/x402.ts` | **CREAR** — middleware completo |
| `src/types/index.ts` | **MODIFICAR** — añadir tipos x402 al final |
| `src/routes/orchestrate.ts` | **MODIFICAR** — añadir preHandler + kiteTxHash |
| `src/routes/compose.ts` | **MODIFICAR** — añadir preHandler + kiteTxHash |
| `.env.example` | **MODIFICAR** — añadir variables Kite |

**NO tocar:** `src/index.ts`, `src/services/orchestrate.ts`, `src/services/compose.ts`, `src/services/kite-client.ts`, `src/lib/kite-chain.ts`, `src/routes/registries.ts`, `src/routes/discover.ts`, `package.json`

---

## Implementación Wave por Wave

---

### Wave 0: `src/types/index.ts` (tipos) + `src/middleware/x402.ts` — CÓDIGO COMPLETO

#### Paso 0.1 — Añadir tipos al final de `src/types/index.ts`

Añade este bloque al **final** del archivo (después de todo lo que ya existe):

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
  network?: string      // "kite-testnet" (opcional)
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

#### Paso 0.2 — Crear `src/middleware/x402.ts`

Crea este archivo exactamente como está:

```typescript
/**
 * x402 Payment Middleware — Fastify preHandler hook
 *
 * Implementa el protocolo x402 para Kite Testnet vía Pieverse facilitador.
 * No añade dependencias npm: usa globalThis.fetch (Node ≥18).
 *
 * Uso:
 *   fastify.post('/', { preHandler: requirePayment({ description: '...' }) }, handler)
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
    // KITE_WALLET_ADDRESS no configurada → 503
    if (!process.env.KITE_WALLET_ADDRESS) {
      request.log.error('[FATAL] KITE_WALLET_ADDRESS not set — payment endpoints disabled')
      return reply.status(503).send({
        error: 'Service payment not configured. Contact administrator.',
      })
    }

    const resource = `${request.protocol}://${request.hostname}${request.url}`
    const xPaymentHeader = request.headers['x-payment']

    // Sin header → 402
    if (!xPaymentHeader || typeof xPaymentHeader !== 'string') {
      return reply.status(402).send(buildX402Response(opts, resource))
    }

    // Decodificar base64/JSON
    let paymentPayload: X402PaymentRequest
    try {
      paymentPayload = decodeXPayment(xPaymentHeader)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return reply.status(402).send(
        buildX402Response(opts, resource, `Invalid X-Payment format: ${detail}`),
      )
    }

    // Verificar con Pieverse
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

    // Settle on-chain
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

    // Pago verificado y liquidado — propagar txHash al handler
    request.kiteTxHash = settleResult.txHash
    request.kitePaymentVerified = true
    // No llamar reply.send ni return un valor — continúa al handler
  }

  return [handler]
}
```

---

### Wave 1: `src/routes/orchestrate.ts` + `src/routes/compose.ts` — cambios exactos

#### `src/routes/orchestrate.ts` — reemplaza el archivo completo

```typescript
/**
 * Orchestrate Routes — Goal-based orchestration
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { orchestrateService } from '../services/orchestrate.js'
import { requirePayment } from '../middleware/x402.js'

const orchestrateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/',
    {
      preHandler: requirePayment({
        description: 'WasiAI Orchestration Service — Goal-based AI agent orchestration',
      }),
    },
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

---

#### `src/routes/compose.ts` — reemplaza el archivo completo

```typescript
/**
 * Compose Routes — Multi-agent pipelines
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { composeService } from '../services/compose.js'
import type { ComposeStep } from '../types/index.js'
import { requirePayment } from '../middleware/x402.js'

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/',
    {
      preHandler: requirePayment({
        description: 'WasiAI Compose Service — Multi-agent pipeline execution',
      }),
    },
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

---

### Wave 2: `.env.example` + verificación build

#### `.env.example`

Añade este bloque al **final** del archivo:

```bash
# ─── Kite Service Provider (x402) ───────────────────────────────────────────
# Wallet address on Kite testnet que recibe los pagos (OBLIGATORIO)
KITE_WALLET_ADDRESS=0xYourServiceWalletAddress

# Pieverse facilitator URL (default si no se define: https://facilitator.pieverse.io)
KITE_FACILITATOR_URL=https://facilitator.pieverse.io

# Payment amount in wei (default en código: 1000000000000000000 = 1 Test USDT)
# Solo necesario si se quiere sobreescribir el default
KITE_PAYMENT_AMOUNT=1000000000000000000

# Merchant name shown to paying agents
KITE_MERCHANT_NAME=WasiAI
```

#### Verificar build

```bash
tsc --noEmit
eslint src/
```

Ambos deben terminar con 0 errores.

---

## Verificación por Wave (comandos exactos)

### Al finalizar Wave 0

```bash
# Verificar que TypeScript compila sin errores en el nuevo middleware
tsc --noEmit
```

Resultado esperado: sin output (0 errores).

### Al finalizar Wave 1

```bash
# Verificar compilación completa
tsc --noEmit

# Test manual: sin X-Payment → debe retornar 402
curl -s -X POST http://localhost:3001/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"goal":"test","budget":1}' | jq .
```

Resultado esperado del curl:
```json
{
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "gokite-aa",
      "network": "kite-testnet",
      "maxAmountRequired": "1000000000000000000",
      "resource": "http://localhost:3001/orchestrate",
      "description": "WasiAI Orchestration Service — Goal-based AI agent orchestration",
      "mimeType": "application/json",
      "payTo": "0x<tu_wallet>",
      "maxTimeoutSeconds": 300,
      "asset": "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
      "extra": null,
      "merchantName": "WasiAI"
    }
  ],
  "x402Version": 1
}
```

```bash
# Test: X-Payment inválido → debe retornar 402 con error descriptivo
curl -s -X POST http://localhost:3001/orchestrate \
  -H "Content-Type: application/json" \
  -H "X-Payment: invalido" \
  -d '{"goal":"test","budget":1}' | jq .
```

Resultado esperado:
```json
{
  "error": "Invalid X-Payment format: Cannot parse JSON from decoded X-Payment header",
  "accepts": [...],
  "x402Version": 1
}
```

```bash
# Test: /compose también protegido
curl -s -X POST http://localhost:3001/compose \
  -H "Content-Type: application/json" \
  -d '{"steps":[{"agent":"test-agent","input":{}}]}' | jq .
```

Debe retornar 402 (no 400 ni 500).

```bash
# Test: /registries NO protegido (debe seguir funcionando)
curl -s http://localhost:3001/registries | jq .
```

Debe retornar 200.

### Al finalizar Wave 2

```bash
tsc --noEmit
eslint src/
```

Ambos sin errores.

---

## Acceptance Criteria (8 ACs EARS)

**AC-1** — WHEN `POST /orchestrate` se recibe sin header `X-Payment` THEN retorna HTTP 402 con body `{ error, accepts: [x402Payload], x402Version: 1 }` donde `accepts[0].scheme === "gokite-aa"` y `accepts[0].network === "kite-testnet"`.

**AC-2** — WHEN `POST /orchestrate` llega con header `X-Payment` (base64 JSON válido) THEN el middleware llama `POST https://facilitator.pieverse.io/v2/verify` con body `{ authorization, signature, network: "kite-testnet" }` antes de ejecutar el servicio.

**AC-3** — WHEN `/v2/verify` retorna `{ valid: true }` THEN el middleware llama `POST https://facilitator.pieverse.io/v2/settle` con el mismo payload AND si settle es exitoso, ejecuta `orchestrateService.orchestrate(...)`.

**AC-4** — WHEN settle completa con `{ success: true, txHash: "0x..." }` THEN la respuesta HTTP 200 de `/orchestrate` incluye el campo `kiteTxHash` con ese valor junto al resultado de orchestración.

**AC-5** — WHEN el header `X-Payment` no puede parsearse (base64 inválido o JSON malformado) OR `/v2/verify` retorna `valid: false` THEN retorna HTTP 402 con `error` descriptivo AND NO se llama `/v2/settle` AND NO se ejecuta el servicio.

**AC-6** — WHEN `POST /compose` se recibe sin `X-Payment` THEN retorna HTTP 402 con payload x402 válido con `description` ajustada para compose AND WHEN llega con `X-Payment` válido THEN aplica flujo verify → settle → execute AND respuesta incluye `kiteTxHash`.

**AC-7** — WHEN `KITE_WALLET_ADDRESS` no está definida en el entorno THEN `/orchestrate` y `/compose` retornan HTTP 503 con `{ error: "Service payment not configured. Contact administrator." }` AND el servidor sigue sirviendo `/registries` y `/discover` sin error.

**AC-8** — GIVEN `src/types/index.ts` THEN existen y están exportados los tipos: `X402PaymentPayload`, `X402Response`, `X402PaymentRequest`, `PieverseVerifyRequest`, `PieverseVerifyResponse`, `PieverseSettleRequest`, `PieverseSettleResult` AND TypeScript compila sin errores (`tsc --noEmit`).

---

## Prohibiciones

1. **NO** modificar `src/index.ts` — el middleware se registra a nivel de route, no de servidor.
2. **NO** modificar `src/services/orchestrate.ts` ni `src/services/compose.ts`.
3. **NO** modificar `src/routes/registries.ts` ni `src/routes/discover.ts` — esos endpoints no tienen pago.
4. **NO** añadir dependencias npm. `package.json` no cambia. Usa `globalThis.fetch` (Node ≥18).
5. **NO** llamar `/v2/settle` sin haber recibido `{ valid: true }` de `/v2/verify`.
6. **NO** usar `process.exit()` si `KITE_WALLET_ADDRESS` falta — el servidor sigue vivo para otros endpoints.
7. **NO** persistir transacciones en Supabase — fuera de scope.
8. **NO** usar `ethers.js` — si necesitas manipulación de wallets en el futuro, usa `viem` (ya en deps).
9. **NO** declarar module augmentation de `FastifyRequest` en `src/types/index.ts` — va en `src/middleware/x402.ts`.
10. **NO** usar `any` explícito — castea con `as PieverseVerifyResponse` / `as PieverseSettleResult`.

---

## Definition of Done (checklist)

- [ ] `src/types/index.ts` tiene los 7 tipos x402 exportados al final del archivo
- [ ] `src/middleware/x402.ts` creado con el código completo
- [ ] Module augmentation de `FastifyRequest` (`kiteTxHash`, `kitePaymentVerified`) está en `src/middleware/x402.ts`
- [ ] Las constantes de red (`KITE_SCHEME`, `KITE_NETWORK`, `KITE_PAYMENT_TOKEN`, `KITE_FACILITATOR_DEFAULT_URL`, `KITE_MAX_TIMEOUT_SECONDS`, `KITE_FACILITATOR_ADDRESS`) son exportadas desde `src/middleware/x402.ts`
- [ ] `src/routes/orchestrate.ts` importa `requirePayment` y lo usa en `preHandler`
- [ ] `src/routes/orchestrate.ts` incluye `kiteTxHash` en la respuesta 200
- [ ] `src/routes/compose.ts` importa `requirePayment` y lo usa en `preHandler`
- [ ] `src/routes/compose.ts` incluye `kiteTxHash` en la respuesta 200
- [ ] `.env.example` tiene `KITE_WALLET_ADDRESS`, `KITE_FACILITATOR_URL`, `KITE_PAYMENT_AMOUNT`, `KITE_MERCHANT_NAME`
- [ ] `curl` sin `X-Payment` → HTTP 402 con estructura x402 correcta
- [ ] `curl` con `X-Payment: invalido` → HTTP 402 con error descriptivo (no 500)
- [ ] `curl` a `/registries` → HTTP 200 (no afectado)
- [ ] `tsc --noEmit` → 0 errores
- [ ] `eslint src/` → 0 errores
- [ ] PR creado en rama `feat/wkh-6-kite-payment` con descripción del flujo x402
