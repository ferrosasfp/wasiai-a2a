/**
 * x402 Payment Middleware — Fastify preHandler hook
 *
 * Implementa el protocolo x402 para Kite Testnet vía Pieverse facilitador.
 * No añade dependencias npm: usa globalThis.fetch (Node ≥18).
 *
 * Uso:
 *   fastify.post('/', { preHandler: requirePayment({ description: '...' }) }, handler)
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
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
): preHandlerHookHandler[] {
  const handler: preHandlerHookHandler = async (
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
