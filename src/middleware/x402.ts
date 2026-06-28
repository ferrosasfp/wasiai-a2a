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
import { checkAndRecordX402Nonce } from '../services/x402-nonce.js';
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
    /**
     * WKH money-path fix: per-request challenge amount in USD, injected by a
     * route preHandler (e.g. /compose) so the x402 402-challenge advertises the
     * REAL pipeline cost instead of the flat 1 USD default. Overrides
     * `PaymentMiddlewareOptions.amountUsd` for THIS request only. The
     * higher-precedence atomic `opts.amount` (if any) still wins.
     */
    x402ChallengeAmountUsd?: number;
  }
}

export interface PaymentMiddlewareOptions {
  description: string;
  /**
   * Pre-computed challenge amount in the chain's ATOMIC units (e.g. '7777777').
   * Highest precedence — when set, used verbatim. Cannot be chain-decimal-aware
   * from a route (the chain is resolved inside the middleware), so prefer
   * `amountUsd` for per-request, chain-agnostic pricing.
   */
  amount?: string;
  /**
   * Per-request challenge amount in USD. The resolved chain's adapter converts
   * it to atomic units via `quote(amountUsd)` (honoring per-chain decimals).
   * Lets a route advertise the REAL pipeline cost instead of the flat 1 USD
   * default. Ignored when `amount` (atomic) is also set.
   */
  amountUsd?: number;
}

/**
 * Argument passed to `adapter.quote()` to derive the default challenge amount.
 * NOT a wei value — the adapter returns the dimensional `amountWei` for its
 * chain (6-dec Base vs 18-dec Kite). CD-4 / CD-9.
 */
const DEFAULT_AMOUNT_USD = 1;

/**
 * WKH-SEC-03: single source of truth for the server-side payment requirements
 * (recipient wallet + required atomic amount). Reused by both the 402 challenge
 * (`buildX402Response`) and the inbound binding check so they never drift
 * (CD-7) and `quote()` is not called twice (DT-5). CD-5: the wallet resolution
 * (`PAYMENT_WALLET_ADDRESS || KITE_WALLET_ADDRESS`) is reused, not changed.
 */
async function resolvePaymentRequirements(
  opts: PaymentMiddlewareOptions,
  chainKey: ChainKey,
): Promise<{ payTo: string; requiredAmount: string }> {
  const adapter = getPaymentAdapter(chainKey);
  const payTo =
    process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS || '';
  // Precedence: explicit atomic `amount` (back-compat) > per-request `amountUsd`
  // converted by the resolved chain's adapter (honors per-chain decimals) >
  // the flat 1 USD default. WKH money-path fix: passing `amountUsd` makes the
  // 402 challenge reflect the REAL pipeline cost instead of a hardcoded 1 USDC.
  const requiredAmount =
    opts.amount ??
    (await adapter.quote(opts.amountUsd ?? DEFAULT_AMOUNT_USD)).amountWei;
  return { payTo, requiredAmount };
}

export async function buildX402Response(
  opts: PaymentMiddlewareOptions,
  resource: string,
  chainKey: ChainKey,
  errorMessage: string = 'payment-signature header is required',
): Promise<X402Response> {
  const adapter = getPaymentAdapter(chainKey);
  const { payTo: walletAddress, requiredAmount: amount } =
    await resolvePaymentRequirements(opts, chainKey);
  const merchantName = adapter.getMerchantName();
  const payload: X402PaymentPayload = {
    scheme: adapter.getScheme(),
    network: adapter.getNetwork(),
    maxAmountRequired: amount,
    resource,
    description: opts.description,
    mimeType: 'application/json',
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
  staticOpts: PaymentMiddlewareOptions,
): preHandlerHookHandler[] {
  const handler: preHandlerHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // WKH money-path fix: merge the per-request challenge amount (injected by a
    // route preHandler) over the static registration-time opts. Only the USD
    // figure is overridable; the atomic `amount` (if set) keeps its precedence
    // inside `resolvePaymentRequirements`. When neither is set, falls back to
    // the flat 1 USD default (back-compat).
    const opts: PaymentMiddlewareOptions =
      typeof request.x402ChallengeAmountUsd === 'number'
        ? { ...staticOpts, amountUsd: request.x402ChallengeAmountUsd }
        : staticOpts;
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
    // ── WKH-SEC-03: binding check (to + value) BEFORE any network call. ──
    // CD-1: reject before verify()/settle(). CD-8: reuse the resolved chainKey.
    const { payTo, requiredAmount } = await resolvePaymentRequirements(
      opts,
      chainKey,
    );
    const auth = paymentPayload.authorization as {
      to?: unknown;
      value?: unknown;
    };
    let bindingOk = true;
    // DT-7: defensive — to/value must be strings, BigInt(value) must not throw.
    if (typeof auth.to !== 'string' || typeof auth.value !== 'string') {
      bindingOk = false;
    } else if (auth.to.toLowerCase() !== payTo.toLowerCase()) {
      // DT-4 / CD-3: case-insensitive recipient comparison.
      bindingOk = false;
    } else {
      try {
        // DT-3 / CD-7: same atomic units as the challenge quote. No scaling.
        if (BigInt(auth.value) < BigInt(requiredAmount)) bindingOk = false;
      } catch {
        bindingOk = false; // unparseable value → mismatch, not crash.
      }
    }
    if (!bindingOk) {
      // AC-6 / DT-6 / CD-2: full detail in the internal log, NOT in the body.
      request.log.warn(
        {
          error_code: 'X402_BINDING_MISMATCH',
          received: {
            to: typeof auth.to === 'string' ? auth.to : null,
            value: typeof auth.value === 'string' ? auth.value : null,
          },
          expected: { payTo, requiredAmount },
        },
        'x402 inbound payment rejected: recipient/amount binding mismatch',
      );
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            'Payment binding rejected: recipient or amount mismatch',
          ),
        );
    }
    let verifyResult: { valid: boolean; error?: string | undefined };
    try {
      verifyResult = await getPaymentAdapter(chainKey).verify({
        authorization: paymentPayload.authorization,
        signature: paymentPayload.signature,
        network: paymentPayload.network ?? '',
        paymentRequirements: { payTo, maxAmountRequired: requiredAmount },
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
    // ── M1 (audit 2026-06-24): anti-replay INBOUND local ──
    // Defensa en profundidad SOBRE el nonce on-chain EIP-3009: registramos el
    // (network, authorization.nonce) ANTES de settle(). Si ya lo vimos → replay
    // → rechazar con código estable X402_REPLAY (402). El `network` es el del
    // adapter resuelto (estable, chain-specific), NO el del body. Fail-open
    // CONSERVADOR ante DB-down (ver x402-nonce.ts): el nonce EIP-3009 ya es
    // single-use a nivel token, así que esto nunca es la única defensa.
    const inboundNonce = (paymentPayload.authorization as { nonce?: unknown })
      .nonce;
    if (typeof inboundNonce === 'string' && inboundNonce.length > 0) {
      const nonceNetwork = getPaymentAdapter(chainKey).getNetwork();
      const nonceResult = await checkAndRecordX402Nonce(
        nonceNetwork,
        inboundNonce,
      );
      if (reply.sent) return;
      if (nonceResult.kind === 'replay') {
        request.log.warn(
          { error_code: 'X402_REPLAY', network: nonceNetwork },
          'x402 inbound payment rejected: nonce replay (seen before)',
        );
        return reply
          .status(402)
          .send(
            await buildX402Response(
              opts,
              resource,
              chainKey,
              'Payment rejected: authorization nonce already used (replay)',
            ),
          );
      }
      // 'fresh' → seguimos. 'unavailable' → fail-open (ya logueado en el service).
    }

    let settleResult: {
      txHash: string;
      success: boolean;
      error?: string | undefined;
    };
    try {
      settleResult = await getPaymentAdapter(chainKey).settle({
        authorization: paymentPayload.authorization,
        signature: paymentPayload.signature,
        network: paymentPayload.network ?? '',
        paymentRequirements: { payTo, maxAmountRequired: requiredAmount },
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
