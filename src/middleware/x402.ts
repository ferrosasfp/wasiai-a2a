/**
 * x402 Payment Middleware -- Fastify preHandler hook
 *
 * Implements the x402 protocol via the chain-adaptive payment adapter.
 */
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import type { X402Response, X402PaymentPayload, X402PaymentRequest } from '../types/index.js'
import { getPaymentAdapter } from '../adapters/registry.js'

declare module 'fastify' {
  interface FastifyRequest {
    paymentTxHash?: string
    paymentVerified?: boolean
  }
}

export interface PaymentMiddlewareOptions {
  description: string
  amount?: string
}

export function buildX402Response(opts: PaymentMiddlewareOptions, resource: string, errorMessage: string = 'payment-signature header is required'): X402Response {
  const adapter = getPaymentAdapter()
  const walletAddress = process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS || ''
  const amount = opts.amount ?? '1000000000000000000'
  const merchantName = adapter.getMerchantName()
  const payload: X402PaymentPayload = { scheme: adapter.getScheme(), network: adapter.getNetwork(), maxAmountRequired: amount, resource, description: opts.description, mimeType: 'application/json', outputSchema: undefined, payTo: walletAddress, maxTimeoutSeconds: adapter.getMaxTimeoutSeconds(), asset: adapter.getToken(), extra: null, merchantName }
  return { error: errorMessage, accepts: [payload], x402Version: 2 }
}

export function decodeXPayment(header: string): X402PaymentRequest {
  let decoded: string
  try { decoded = Buffer.from(header, 'base64').toString('utf8') } catch { throw new Error('Cannot decode base64: invalid characters') }
  let parsed: unknown
  try { parsed = JSON.parse(decoded) } catch { throw new Error('Cannot parse JSON from decoded payment-signature header') }
  const obj = parsed as Record<string, unknown>
  if (!obj.authorization || typeof obj.authorization !== 'object') throw new Error('Missing or invalid "authorization" field in payment-signature')
  if (!obj.signature || typeof obj.signature !== 'string') throw new Error('Missing or invalid "signature" field in payment-signature')
  return parsed as X402PaymentRequest
}

export function requirePayment(opts: PaymentMiddlewareOptions): preHandlerHookHandler[] {
  const handler: preHandlerHookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!process.env.PAYMENT_WALLET_ADDRESS && !process.env.KITE_WALLET_ADDRESS) {
      request.log.error('[FATAL] KITE_WALLET_ADDRESS not set — payment endpoints disabled')
      return reply.status(503).send({ error: 'Service payment not configured. Contact administrator.' })
    }
    const resource = `${request.protocol}://${request.hostname}${request.url}`
    const xPaymentHeader = request.headers['payment-signature']
    if (!xPaymentHeader || typeof xPaymentHeader !== 'string') return reply.status(402).send(buildX402Response(opts, resource))
    let paymentPayload: X402PaymentRequest
    try { paymentPayload = decodeXPayment(xPaymentHeader) } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return reply.status(402).send(buildX402Response(opts, resource, `Invalid payment-signature format: ${detail}`))
    }
    let verifyResult: { valid: boolean; error?: string }
    try { verifyResult = await getPaymentAdapter().verify({ authorization: paymentPayload.authorization, signature: paymentPayload.signature, network: paymentPayload.network ?? '' }) } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return reply.status(402).send(buildX402Response(opts, resource, `Facilitator unavailable: ${detail}`))
    }
    if (!verifyResult.valid) return reply.status(402).send(buildX402Response(opts, resource, `Payment verification failed: ${verifyResult.error ?? 'unknown reason'}`))
    let settleResult: { txHash: string; success: boolean; error?: string }
    try { settleResult = await getPaymentAdapter().settle({ authorization: paymentPayload.authorization, signature: paymentPayload.signature, network: paymentPayload.network ?? '' }) } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return reply.status(402).send(buildX402Response(opts, resource, `Payment settlement failed: ${detail}`))
    }
    if (!settleResult.success) return reply.status(402).send(buildX402Response(opts, resource, `Payment settlement failed: ${settleResult.error ?? 'unknown reason'}`))
    request.paymentTxHash = settleResult.txHash
    request.paymentVerified = true
    reply.header('payment-response', settleResult.txHash)
  }
  return [handler]
}
