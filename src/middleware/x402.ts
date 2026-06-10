/**
 * x402 Payment Middleware -- Fastify preHandler hook
 *
 * Implements the x402 protocol via the chain-adaptive payment adapter.
 */
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import { resolveChainKey } from '../adapters/chain-resolver.js';
import {
  getAdaptersBundle,
  getDefaultChainKey,
  getInitializedChainKeys,
  getPaymentAdapter,
} from '../adapters/registry.js';
import type { ChainKey } from '../adapters/types.js';
import type {
  X402PaymentPayload,
  X402PaymentRequest,
  X402Response,
} from '../types/index.js';

/**
 * Header used to mark a request as Passport-funded.
 * Telemetry-only — see SECURITY CAVEAT in passport.ts and passport-onboarding.md.
 */
export const X_PASSPORT_SESSION_HEADER = 'x-passport-session';

// Canonical x402 payment header (Kite Agent Passport). Fastify lowercasea los
// nombres de header entrantes → 'x-payment' (no 'X-PAYMENT') es el lookup
// correcto; AC-3 "case-insensitive" se cumple por la plataforma (DT-9).
export const X_PAYMENT_HEADER = 'x-payment';
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature';

declare module 'fastify' {
  interface FastifyRequest {
    paymentTxHash?: string;
    paymentVerified?: boolean;
    /**
     * WKH-69: telemetry-only tag for inbound payment origin.
     * - 'passport' when client sends header `x-passport-session: true`
     * - 'eoa' otherwise (default for raw EOA flows, backward compatible)
     * Set by `requirePayment` handler, consumed by `event-tracking` and
     * (opt-in) by `requirePassport`. NEVER used as the sole auth signal.
     */
    paymentOrigin?: 'passport' | 'eoa';
  }
}

export interface PaymentMiddlewareOptions {
  description: string;
  amount?: string;
}

/**
 * Argument passed to `adapter.quote()` to derive the default challenge amount.
 * NOT a wei value — the adapter returns the dimensional `amountWei` for its
 * chain (6-dec Base vs 18-dec Kite). CD-4 / CD-9.
 */
const DEFAULT_AMOUNT_USD = 1;

export async function buildX402Response(
  opts: PaymentMiddlewareOptions,
  resource: string,
  chainKey: ChainKey,
  errorMessage: string = 'payment-signature header is required',
): Promise<X402Response> {
  const adapter = getPaymentAdapter(chainKey);
  const walletAddress =
    process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS || '';
  const amount =
    opts.amount ?? (await adapter.quote(DEFAULT_AMOUNT_USD)).amountWei;
  const merchantName = adapter.getMerchantName();
  const payload: X402PaymentPayload = {
    scheme: adapter.getScheme(),
    network: adapter.getNetwork(),
    maxAmountRequired: amount,
    resource,
    description: opts.description,
    mimeType: 'application/json',
    outputSchema: undefined,
    payTo: walletAddress,
    maxTimeoutSeconds: adapter.getMaxTimeoutSeconds(),
    asset: adapter.getToken(),
    extra: null,
    merchantName,
  };
  return { error: errorMessage, accepts: [payload], x402Version: 2 };
}

export function decodeXPayment(header: string): X402PaymentRequest {
  let decoded: string;
  try {
    decoded = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    throw new Error('Cannot decode base64: invalid characters');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('Cannot parse JSON from decoded payment-signature header');
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.authorization || typeof obj.authorization !== 'object')
    throw new Error(
      'Missing or invalid "authorization" field in payment-signature',
    );
  if (!obj.signature || typeof obj.signature !== 'string')
    throw new Error(
      'Missing or invalid "signature" field in payment-signature',
    );
  return parsed as X402PaymentRequest;
}

export function requirePayment(
  opts: PaymentMiddlewareOptions,
): preHandlerHookHandler[] {
  const handler: preHandlerHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (
      !process.env.PAYMENT_WALLET_ADDRESS &&
      !process.env.KITE_WALLET_ADDRESS
    ) {
      request.log.error(
        '[FATAL] KITE_WALLET_ADDRESS not set — payment endpoints disabled',
      );
      return reply.status(503).send({
        error: 'Service payment not configured. Contact administrator.',
      });
    }
    // WKH-69: detect payment origin via header hint (telemetry-only).
    // Truthy values: 'true', '1', 'yes' (case-insensitive). Anything else (or absent) → 'eoa'.
    const sessionHeader = request.headers[X_PASSPORT_SESSION_HEADER];
    const isPassportSession =
      typeof sessionHeader === 'string' &&
      ['true', '1', 'yes'].includes(sessionHeader.toLowerCase().trim());
    request.paymentOrigin = isPassportSession ? 'passport' : 'eoa';
    const resource = `${request.protocol}://${request.hostname}${request.url}`;

    // Resolve target chain per-request (WKH-111 / BASE-06).
    // Priority: explicit `x-payment-chain` header > registry default.
    // CD-10: resolved BEFORE reading `payment-signature` so the 402 challenge
    // is also chain-aware. CD-6: resolution happens exactly once per request.
    // CD-11: resolver reads ONLY the header — never `request.body`.
    const headerRaw = request.headers['x-payment-chain'];
    const headerOverride =
      typeof headerRaw === 'string' ? headerRaw : undefined;
    const defaultChainKey = getDefaultChainKey();

    let chainKey = resolveChainKey({ headerOverride });
    if (!chainKey) {
      if (headerOverride !== undefined) {
        // CD-5: header present but unrecognised → 400, never silent default.
        return reply.status(400).send({
          error_code: 'CHAIN_NOT_SUPPORTED',
          error: `Chain '${headerOverride}' is not a recognized slug or chainId`,
        });
      }
      // Header absent → fall back to registry default.
      chainKey = defaultChainKey ?? undefined;
      if (!chainKey) {
        return reply.status(500).send({
          error_code: 'REGISTRY_NOT_INITIALIZED',
          error: 'No chains initialized in registry',
        });
      }
    }

    const bundle = getAdaptersBundle(chainKey);
    if (!bundle) {
      // recognised slug but not present in the initialised registry.
      return reply.status(400).send({
        error_code: 'CHAIN_NOT_SUPPORTED',
        error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
      });
    }

    // DT-2 / AC-4: canónico x402 (X-PAYMENT) gana sobre legacy (payment-signature).
    // DT-10: .length > 0 evita que un X-PAYMENT vacío gane sobre un payment-signature válido.
    // El typeof === 'string' filtra el caso header duplicado (Fastify → string[]).
    const canonical = request.headers[X_PAYMENT_HEADER];
    const legacy = request.headers[PAYMENT_SIGNATURE_HEADER];
    const xPaymentHeader =
      typeof canonical === 'string' && canonical.length > 0
        ? canonical
        : legacy;
    if (!xPaymentHeader || typeof xPaymentHeader !== 'string')
      return reply
        .status(402)
        .send(await buildX402Response(opts, resource, chainKey));
    let paymentPayload: X402PaymentRequest;
    try {
      paymentPayload = decodeXPayment(xPaymentHeader);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            `Invalid payment-signature format: ${detail}`,
          ),
        );
    }
    let verifyResult: { valid: boolean; error?: string };
    try {
      verifyResult = await getPaymentAdapter(chainKey).verify({
        authorization: paymentPayload.authorization,
        signature: paymentPayload.signature,
        network: paymentPayload.network ?? '',
      });
    } catch (err) {
      // Guard FST_ERR_REP_ALREADY_SENT: si timeout disparó 504 mientras
      // estábamos en el await, NO intentar reply.send (Fastify throws).
      if (reply.sent) return;
      const detail = err instanceof Error ? err.message : String(err);
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            `Facilitator unavailable: ${detail}`,
          ),
        );
    }
    if (reply.sent) return;
    if (!verifyResult.valid)
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            `Payment verification failed: ${verifyResult.error ?? 'unknown reason'}`,
          ),
        );
    let settleResult: { txHash: string; success: boolean; error?: string };
    try {
      settleResult = await getPaymentAdapter(chainKey).settle({
        authorization: paymentPayload.authorization,
        signature: paymentPayload.signature,
        network: paymentPayload.network ?? '',
      });
    } catch (err) {
      if (reply.sent) return;
      const detail = err instanceof Error ? err.message : String(err);
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            `Payment settlement failed: ${detail}`,
          ),
        );
    }
    if (reply.sent) return;
    if (!settleResult.success)
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            `Payment settlement failed: ${settleResult.error ?? 'unknown reason'}`,
          ),
        );
    request.paymentTxHash = settleResult.txHash;
    request.paymentVerified = true;
    if (!reply.sent) reply.header('payment-response', settleResult.txHash);
  };
  return [handler];
}
