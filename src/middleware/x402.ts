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
import { parseUnits } from 'viem';
import { resolveChainKey } from '../adapters/chain-resolver.js';
import {
  hasBroadcastEvidence,
  readSettleValueDisposition,
} from '../adapters/errors.js';
import {
  acceptsInboundPayment,
  getAdaptersBundle,
  getDefaultChainKey,
  getInboundPaymentChainKeys,
  getInitializedChainKeys,
  getPaymentAdapter,
} from '../adapters/registry.js';
import {
  rpcUnavailableResult,
  verifySettledTx,
} from '../adapters/settle-verifier.js';
import { base58DecodeToBytes } from '../adapters/solana/base58.js';
import {
  getSolanaCaip2,
  getSolanaConnection,
  getSolanaFallbackConnection,
  getSolanaInboundPayTo,
  getSolanaUsdcDecimals,
  getSolanaUsdcMint,
} from '../adapters/solana/chain.js';
import { ensureSolanaInboundReady } from '../adapters/solana/inbound-preflight.js';
import { probeInboundProof } from '../adapters/solana/inbound-presence.js';
import {
  combineInboundBinding,
  combineInboundPresence,
} from '../adapters/solana/inbound-verify.js';
import type { ChainKey, SolanaInboundChallenge } from '../adapters/types.js';
import {
  buildSolanaChallenge,
  SOLANA_CHALLENGE_TTL_SECONDS,
  verifySolanaChallengeReference,
} from '../lib/solana-x402-challenge.js';
import { eventService } from '../services/event.js';
import {
  consumeInboundProof,
  peekInboundProof,
  recordInboundObserved,
} from '../services/solana-inbound-proof.js';
import { checkAndRecordX402Nonce } from '../services/x402-nonce.js';
import type {
  X402PaymentPayload,
  X402PaymentRequest,
  X402Response,
} from '../types/index.js';
import { markChargesCaller } from './charge-brand.js';

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

// ── WKH-175: default-chain UX (aditivo, DX/observabilidad) ─────────────
// Header de RESPUESTA con el slug de la chain efectivamente resuelta para
// cobrar. Mismo patrón que `x-a2a-remaining-budget` (reply.header en el punto
// donde el dato queda resuelto). Los cambios de WKH-175 son aditivos: NO
// cambian el default, NO lo hacen obligatorio, NO cambian ningún status/code.
export const X_A2A_PAYMENT_CHAIN_HEADER = 'x-a2a-payment-chain';

/**
 * HU-204 — código estable para "esta chain existe y está inicializada, pero NO
 * acepta cobro de ENTRADA". Distinto de `CHAIN_NOT_SUPPORTED` a propósito: ahí
 * el slug es desconocido o el rail no está prendido (el caller no puede hacer
 * nada más que cambiar de chain); acá el rail SÍ está vivo, sólo que en la
 * dirección contraria — y el caller tiene DOS salidas (otra chain para el x402,
 * o una agent key prepaga, que sí cobra en esta chain).
 */
export const X402_INBOUND_UNSUPPORTED_CODE =
  'CHAIN_INBOUND_PAYMENT_UNSUPPORTED';

/**
 * Mensaje del 400 de arriba. Explica la ASIMETRÍA (no sólo la negación) y las
 * dos salidas, porque un integrador tiene que poder resolverlo leyendo la
 * respuesta: negar sin decir por qué ni qué hacer es la razón por la que este
 * caso se vivía como "el gateway está roto".
 */
export function inboundPaymentUnsupportedMessage(
  chainKey: ChainKey,
  inboundChains: readonly ChainKey[],
): string {
  const alternatives =
    inboundChains.length > 0
      ? inboundChains.join(', ')
      : '(none initialized on this deployment)';
  return (
    `Chain '${chainKey}' does not accept INBOUND x402 payment (caller → gateway). ` +
    `It is an OUTBOUND settlement rail: the gateway pays agents on '${chainKey}' ` +
    `from its own operator wallet, but callers cannot pay the gateway there — ` +
    `the inbound leg needs an EVM signed authorization (EIP-3009), which this ` +
    `chain's payment adapter does not implement. ` +
    `To pay with x402, set 'x-payment-chain' to one of: ${alternatives}. ` +
    `To keep using '${chainKey}', use a prepaid agent key ('x-a2a-key'): that ` +
    `path debits your budget on '${chainKey}' and is unaffected by this limit.`
  );
}

// Dedup module-scoped del warn "se aplicó el default". El default se resuelve
// en CADA request sin `x-payment-chain` (hot-path: hoy la mayoría de los
// callers legítimos no lo mandan — el SDK sólo lo envía si `network` está
// seteado), así que un warn por request inundaría los logs.
//
// WKH-175 fix-pack (MNR-1 del AR): la clave del dedup es la IDENTIDAD DEL
// CALLER (`keyId` de la agent key, o el sentinel `DEFAULT_CHAIN_WARN_NO_KEY`
// para el path x402 puro), NO el slug de la chain. Con la clave anterior
// (`chainKey`) el único valor posible era el default — `warnDefaultChainApplied`
// se invoca SOLO en el branch del default — así que el warn se emitía una vez
// al primer request sin header tras el deploy y nunca más: inútil para el caso
// de uso que motivó el ticket ("avisame que un caller importante dejó de mandar
// el header"). Ahora: un warn por caller por VENTANA temporal (si el problema
// persiste, vuelve a avisar) + cap de tamaño para que el Map no crezca sin
// límite (una entrada por caller crecería indefinidamente).
// Contraste: en services/discovery.ts el dedup se clavea por registry slug (un
// dominio de muchos valores), por eso ahí sí da señal por entidad.

/**
 * Ventana de re-warn por caller: el mismo caller no vuelve a warnear antes de
 * que pase esto (pero SÍ después, para que un problema persistente re-avise).
 */
export const DEFAULT_CHAIN_WARN_WINDOW_MS = 15 * 60 * 1000; // 15 min

/**
 * Cap de entradas del dedup (1 por caller). Política de desalojo al llenarse:
 * (1) purgar las entradas ya expiradas (son inservibles: su ventana venció) y
 * (2) si sigue llena, descartar la entrada del caller warneado hace MÁS tiempo
 * (FIFO por recencia de warn: `shouldWarnDefaultChain` hace delete+set, así que
 * el orden de inserción del Map ES el orden de recencia).
 *
 * Consecuencia aceptada (MNR-2 del CR, medida): con >2×CAP callers distintos
 * activos el dedup degrada hacia 1 warn POR REQUEST — no "algún caller
 * re-warnea": en round-robin sobre 2×CAP callers cada entrada ya fue desalojada
 * cuando su caller vuelve, así que la ventana nunca aplica. La MEMORIA sigue
 * acotada al cap (no hay leak); lo que queda acotado sólo por el rate del
 * tráfico es el VOLUMEN DE LOGS, que es justo lo que el dedup existe para
 * evitar. Preferible a crecer sin límite; el `debug` per-request no cambia.
 */
export const DEFAULT_CHAIN_WARN_DEDUP_MAX_ENTRIES = 1000;

/**
 * Cap efectivo del dedup. Es `DEFAULT_CHAIN_WARN_DEDUP_MAX_ENTRIES` en runtime;
 * `_resetDefaultChainWarnDedup(n)` lo baja SÓLO en tests para poder ejercitar la
 * política de desalojo sin insertar 1000 entradas (MNR-1 del CR).
 */
let _dedupMaxEntries: number = DEFAULT_CHAIN_WARN_DEDUP_MAX_ENTRIES;

/**
 * Discriminante estable para "request sin agent-key" (path x402 puro, donde el
 * caller se identifica con una firma de pago, no con una key interna). Todo ese
 * tráfico comparte UNA entrada → conserva el comportamiento "un warn por
 * ventana" para el agregado anónimo, sin romper el path. No colisiona con un id
 * de `a2a_agent_keys` (UUID).
 */
export const DEFAULT_CHAIN_WARN_NO_KEY = 'no-agent-key';

/** callerRef → epoch ms del último warn emitido para ese caller. */
const _defaultChainWarnedAt = new Map<string, number>();

/**
 * TEST-ONLY: limpia el dedup de warns (CD: evitar contaminación cross-test).
 *
 * `maxEntries` (TEST-ONLY, MNR-1): baja el cap de entradas para ejercitar la
 * política de desalojo con 2-3 callers en vez de 1000. Sin argumento restaura el
 * cap de producción (`DEFAULT_CHAIN_WARN_DEDUP_MAX_ENTRIES`), así que las ~7
 * llamadas existentes `_resetDefaultChainWarnDedup()` no cambian de semántica.
 */
export function _resetDefaultChainWarnDedup(maxEntries?: number): void {
  _defaultChainWarnedAt.clear();
  _dedupMaxEntries = maxEntries ?? DEFAULT_CHAIN_WARN_DEDUP_MAX_ENTRIES;
}

/**
 * TEST-ONLY: tamaño actual del dedup. Hace OBSERVABLE el cap (sin esto, "el Map
 * queda acotado" y "las expiradas se purgan" no se pueden afirmar en un test).
 */
export function _defaultChainWarnDedupSize(): number {
  return _defaultChainWarnedAt.size;
}

/**
 * ¿Toca emitir el `warn` para este caller? Aplica la ventana temporal y el cap
 * de tamaño (ver DEFAULT_CHAIN_WARN_DEDUP_MAX_ENTRIES por la política).
 */
function shouldWarnDefaultChain(callerRef: string, now: number): boolean {
  const last = _defaultChainWarnedAt.get(callerRef);
  if (last !== undefined && now - last < DEFAULT_CHAIN_WARN_WINDOW_MS) {
    return false;
  }
  if (
    !_defaultChainWarnedAt.has(callerRef) &&
    _defaultChainWarnedAt.size >= _dedupMaxEntries
  ) {
    for (const [ref, at] of _defaultChainWarnedAt) {
      if (now - at >= DEFAULT_CHAIN_WARN_WINDOW_MS) {
        _defaultChainWarnedAt.delete(ref);
      }
    }
    if (_defaultChainWarnedAt.size >= _dedupMaxEntries) {
      const oldest = _defaultChainWarnedAt.keys().next();
      if (!oldest.done) _defaultChainWarnedAt.delete(oldest.value);
    }
  }
  // delete+set: reinserta al final para que el orden del Map sea por recencia
  // de warn (lo que hace correcto el desalojo FIFO de arriba).
  _defaultChainWarnedAt.delete(callerRef);
  _defaultChainWarnedAt.set(callerRef, now);
  return true;
}

/**
 * WKH-175: choke-point ÚNICO del aviso "la chain de pago se resolvió por
 * default porque faltaba `x-payment-chain`". Compartido por el path x402
 * (abajo) y por `resolveTargetChain` en a2a-key.ts (compose/orchestrate con
 * `x-a2a-key`), que ya importa de este módulo (sin ciclo).
 *
 * `warn` deduplicado POR CALLER y por ventana temporal (MNR-1) + `debug`
 * per-request para trazabilidad completa cuando se baja LOG_LEVEL.
 *
 * `callerKeyId`: id interno de la agent key del caller, o `null` para el path
 * x402 puro (sin agent-key). NUNCA se loguea el rawKey ni ningún secreto —
 * solo el id interno, mismo campo `keyId` que `a2a-key.insufficient-budget`.
 */
export function warnDefaultChainApplied(
  request: FastifyRequest,
  chainKey: ChainKey,
  callerKeyId: string | null,
): void {
  const keyId = callerKeyId ?? DEFAULT_CHAIN_WARN_NO_KEY;
  const fields = {
    chainKey,
    header: 'x-payment-chain',
    keyId,
    method: request.method,
    // Patrón de routes/metrics.ts:112: el PATRÓN de ruta (sin querystring).
    route: request.routeOptions?.url ?? request.url,
  };
  const msg = 'payment chain resolved by default (x-payment-chain absent)';
  if (shouldWarnDefaultChain(keyId, Date.now())) {
    request.log.warn(fields, msg);
  }
  request.log.debug(fields, msg);
}

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

/**
 * AR BLQ-MEDIO-3 (HU-198) + AR BLQ-MEDIO-1 (HU-201): el mensaje del 402 cuando el
 * resultado del settle es DESCONOCIDO.
 *
 * Decirle "settlement failed" al caller es afirmar que NO se le cobró, que es
 * exactamente lo que no sabemos — la misma contradicción que documenta
 * `lib/downstream-skip-code.ts` ("'no se pagó' y 'puede haberse pagado' son frases
 * opuestas"). El aviso de NO reintentar con el mismo header es material: el nonce ya
 * quedó registrado, así que el reintento da X402_REPLAY y el caller no gana nada.
 *
 * Con `txHash` (eje HU-201) el mensaje mejora de verdad: el caller se lleva LA
 * evidencia con la que puede mirar la cadena él mismo, sin depender de nosotros.
 */
export function unknownSettleMessage(
  detail: string,
  txHash: string | null,
): string {
  return txHash !== null
    ? `Payment settlement result UNKNOWN: the settlement service reported a failure but returned an on-chain transaction hash (${txHash}), so your payment may or may not have executed. Access was NOT granted. Do NOT retry with the same payment header (its nonce is already recorded); check that transaction on-chain. Detail: ${detail}`
    : `Payment settlement result UNKNOWN: the settlement service did not answer in time, so your payment may or may not have executed on-chain. Access was NOT granted. Do NOT retry with the same payment header (its nonce is already recorded); this case is logged for reconciliation. Detail: ${detail}`;
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

/**
 * HU-198 + HU-201 — EL CANAL UNICO del "settle inbound de resultado DESCONOCIDO".
 *
 * Estaba inline dentro del `catch`, y por eso el segundo eje (2xx `success:false`
 * CON txHash, el camino pieverse) no lo usaba: le respondía "Payment settlement
 * failed" y no dejaba ni log ni evento. Extraído para que los DOS ejes emitan lo
 * mismo — un log alertable + un `a2a_events` durable donde reconciliarlo.
 *
 * `txHash` es la evidencia de broadcast cuando existe (eje HU-201) y `null` cuando
 * el hop no contestó y no hay nada que anotar (eje HU-198).
 *
 * ⚠️ WKH-314 — POR QUE PASO DE CLOSURE A FUNCION DE MODULO (DT-14). La rama Solana
 * necesita el MISMO canal, y una segunda copia de este bloque es una copia que puede
 * divergir: dos `error_code`, dos `eventType`, dos formas de `metadata`, y una
 * reconciliación que sólo encuentra la mitad de los casos. Se conservan
 * `error_code: X402_SETTLE_UNKNOWN` y `eventType: x402_settle_unknown`; la rama Solana
 * pasa `extraMetadata` (firma y referencia) y **no manda** `authorizationNonce`,
 * porque en Solana no hay ninguno.
 */
export function emitInboundSettleUnknownEvent(args: {
  request: FastifyRequest;
  chainKey: ChainKey;
  payTo: string;
  requiredAmount: string;
  resource: string;
  authorizationNonce: string | null;
  detail: string;
  txHash: string | null;
  extraMetadata?: Record<string, unknown>;
}): void {
  const {
    request,
    chainKey,
    payTo,
    requiredAmount,
    resource,
    authorizationNonce,
    detail,
    txHash,
  } = args;
  request.log.error(
    {
      error_code: 'X402_SETTLE_UNKNOWN',
      valueDisposition: 'unknown',
      chainKey,
      payTo,
      requiredAmount,
      ...(txHash !== null ? { settleTxHash: txHash } : {}),
      detail,
    },
    txHash !== null
      ? 'x402 inbound settle result UNKNOWN: the facilitator answered `success:false` BUT returned a broadcast tx hash, so the payment may have executed on-chain. Access denied (no confirmation) and the caller may have been charged — check that tx hash on-chain before treating this as unpaid.'
      : 'x402 inbound settle result UNKNOWN: the facilitator hop was cut without an answer, so the payment may have executed on-chain. Access denied (no confirmation) and the caller may have been charged — reconcile against the chain before treating this as unpaid.',
  );
  // AR BLQ-MEDIO-3: un log no es una superficie de reconciliación. El lado
  // OUTBOUND recibió estado DURABLE (`resolving_settle`) + un lugar donde mirarlo
  // (`listPending()` / `listAmbiguous()`); el INBOUND se quedaba sólo con el log,
  // sobre la plata del CALLER, y encima con el nonce ya quemado más arriba (así
  // que el reintento del mismo header da X402_REPLAY). Se persiste un `a2a_events`
  // para que exista DÓNDE reconciliarlo.
  //
  // Fire-and-forget con `.catch()`: `track()` TIRA si el insert falla, y un
  // problema de telemetría NO puede cambiar la respuesta de un money-path.
  void eventService
    .track({
      eventType: 'x402_settle_unknown',
      status: 'failed',
      metadata: {
        error_code: 'X402_SETTLE_UNKNOWN',
        valueDisposition: 'unknown',
        chainKey,
        payTo,
        requiredAmount,
        authorizationNonce,
        // HU-201: y cuando el facilitator NOS DIO el hash, es la clave directa.
        settleTxHash: txHash,
        resource,
        detail,
        ...(args.extraMetadata ?? {}),
      },
    })
    .catch((trackErr: unknown) => {
      request.log.error(
        {
          error_code: 'X402_SETTLE_UNKNOWN_EVENT_FAILED',
          detail: trackErr instanceof Error ? trackErr.message : 'unknown',
        },
        'x402 inbound settle UNKNOWN could not be persisted as an event — the only remaining record is the log line above',
      );
    });
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

// ════════════════════════════════════════════════════════════════════════════
// ── WKH-314 — LA RAMA SOLANA DEL COBRO INBOUND ─────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//
// El gateway es **TESTIGO**, nunca tesorero: no firma, no transmite y no toca
// ninguna clave privada Solana en este camino. El pagador transfiere USDC con su
// propia wallet y su propio fee, presenta la FIRMA, y acá se verifica esa firma
// contra la cadena y se honra **exactamente una vez**.
//
// ⚠️ QUIEN PAGA EL GAS, DICHO EXPLICITAMENTE: **el pagador**. Este camino no
// patrocina nada — no hay `feePayer` del gateway, no hay transacción construida
// por nosotros, no hay tope de facilitator que exceder. Es la diferencia con el
// depósito de `chaski-v3`, donde el facilitator ES el `feePayer` y por eso ahí los
// topes de cómputo son parte del contrato. Acá no hay camino patrocinado que topar.
//
// ⚠️ Y ESTA RAMA NO TOCA EL CAMINO EVM. Entra con `return` inmediato antes de que
// se lea el header de pago, así que ni una línea de `:514` en adelante se ejecuta
// para Solana ni cambia para EVM.

/** Cuánto esperar antes de reintentar, en los rechazos que SI son reintentables. */
const SOLANA_INBOUND_RETRY_AFTER_SECONDS = 15;

/** Firma ed25519: 64 bytes exactos. Un base58 de otro largo NO es una firma. */
const SOLANA_SIGNATURE_BYTES = 64;

/**
 * Los `error_code` de esta rama. **Tabla CERRADA**: un código que no esté acá no
 * existe, y `X402_SETTLE_UNKNOWN` es REUSADO (CD-8), no inventado.
 */
type SolanaInboundErrorCode =
  | 'X402_SOLANA_PROOF_MALFORMED'
  | 'X402_SOLANA_REFERENCE_MISMATCH'
  | 'X402_SOLANA_CHALLENGE_EXPIRED'
  | 'X402_SOLANA_AMOUNT_SHORT'
  | 'X402_SOLANA_TERMS_MISMATCH'
  | 'X402_SOLANA_TX_FAILED'
  | 'X402_SOLANA_NOT_FINALIZED'
  | 'X402_SOLANA_PROOF_ABSENT'
  | 'X402_SOLANA_PROOF_REPLAY'
  | 'X402_SETTLE_UNKNOWN';

/**
 * Los únicos tres rechazos que se arreglan ESPERANDO. Mandar `Retry-After` en un
 * rechazo por monto insuficiente sería mentirle al pagador: por más que espere, esa
 * transferencia nunca va a alcanzar.
 */
const SOLANA_RETRYABLE_CODES: ReadonlySet<SolanaInboundErrorCode> = new Set([
  'X402_SOLANA_NOT_FINALIZED',
  'X402_SOLANA_PROOF_ABSENT',
  'X402_SETTLE_UNKNOWN',
]);

/**
 * WKH-SEC-03 en su versión Solana: **UNA sola resolución** del destinatario y del
 * monto, reusada por el challenge del 402 y por la verificación del binding, para que
 * no puedan divergir (CD-11). El equivalente exacto de `resolvePaymentRequirements`,
 * pero SIN `getPaymentAdapter()` — que lanza a propósito sobre un bundle non-EVM.
 */
function resolveSolanaPaymentRequirements(opts: PaymentMiddlewareOptions): {
  payTo: string | null;
  requiredAmount: string;
} {
  const decimals = getSolanaUsdcDecimals();
  const requiredAmount =
    opts.amount ??
    parseUnits(
      String(opts.amountUsd ?? DEFAULT_AMOUNT_USD),
      decimals,
    ).toString();
  return { payTo: getSolanaInboundPayTo(), requiredAmount };
}

/** El cuerpo del 402 con la tupla que el pagador Solana necesita. */
function buildSolanaX402Response(
  opts: PaymentMiddlewareOptions,
  challenge: SolanaInboundChallenge,
  merchantName: string,
  errorMessage: string,
  errorCode?: SolanaInboundErrorCode,
): X402Response & { error_code?: string } {
  const payload: X402PaymentPayload = {
    scheme: 'exact',
    network: challenge.network,
    maxAmountRequired: challenge.maxAmountRequired,
    resource: challenge.resource,
    description: opts.description,
    mimeType: 'application/json',
    payTo: challenge.payTo,
    maxTimeoutSeconds: SOLANA_CHALLENGE_TTL_SECONDS,
    // El "asset" de Solana es el MINT (base58), análogo VM-agnóstico del address ERC-20.
    asset: challenge.mint,
    extra: {
      // Lo que ata la transferencia a ESTE cobro. El pagador la adjunta como cuenta
      // read-only no-firmante de su transferencia (convención Solana Pay).
      reference: challenge.reference,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      mint: challenge.mint,
      // Entropía por EMISION (AR BLQ-ALTO-2). Se publica para que el pagador la
      // eco-repita en `authorization.nonce`: está dentro del MAC, así que el servidor
      // no guarda nada, y sin ella dos callers simultáneos compartirían referencia.
      nonce: challenge.nonce,
    },
    // Sale del ADAPTER del bundle (`getMerchantName()`), igual que en la rama EVM.
    // No se re-lee la env acá: sería una segunda definición del mismo valor.
    merchantName,
  };
  return {
    error: errorMessage,
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    accepts: [payload],
    x402Version: 2,
  };
}

/**
 * EL HANDLER DEL COBRO INBOUND SOLANA. Implementa la secuencia P0..P9, **en ese
 * orden**, y el orden no es decorativo:
 *
 *   P0 preflight (fail-closed)     · P1 forma del sobre       · P2 la referencia
 *   P3 peek del store              · P4 la cadena             · P5 el binding
 *   P6 persistir el veredicto      · P7 EL COBRO              · P9 conceder
 *
 * · **P2 antes que P4** para que una referencia forjada se rechace SIN gastar una
 *   sola llamada al RPC. Es la defensa barata contra el que copia una firma del
 *   explorer y contra el que quiere que le paguemos el rate-limit del nodo.
 * · **P3 antes que P4** porque un reintento cuya fila ya está `observed` salta la
 *   cadena entera: la incertidumbre se paga UNA vez en la vida del pago.
 * · **P7 lo más tarde posible** porque es irreversible, y **no se intenta siquiera si
 *   `reply.sent`**: el 504 de `middleware/timeout.ts` sale desde fuera del lifecycle y
 *   puede haber salido durante el peek, el RPC o el observe. Quemar la prueba después
 *   de eso dejaba al pagador cobrado, con un 504 en la mano y un `replay` en el
 *   reintento (AR de WKH-314, BLQ-MED-2).
 *   Residuo que QUEDA declarado, porque el guard no lo cierra: si la respuesta HTTP se
 *   pierde en la red DESPUES del consumo, el pagador queda cobrado sin servicio. Eso es
 *   la misma postura que el camino EVM tiene hoy; se mitiga poniendo el consumo pegado
 *   al grant, no se resuelve acá.
 *
 * ⚠️ LA INVARIANTE QUE NINGUN CAMINO DE ACA PUEDE ROMPER:
 * **ningún estado que no sea `finalized_ok` con términos cumplidos concede acceso, y
 * ningún camino que no conceda acceso escribe `consumed`.**
 */
async function handleSolanaInboundPayment(args: {
  request: FastifyRequest;
  reply: FastifyReply;
  opts: PaymentMiddlewareOptions;
  resource: string;
  chainKey: ChainKey;
  merchantName: string;
}): Promise<FastifyReply | undefined> {
  const { request, reply, opts, resource, chainKey, merchantName } = args;
  const { payTo, requiredAmount } = resolveSolanaPaymentRequirements(opts);
  const caip2 = getSolanaCaip2();

  /** Rechaza. **Nunca concede, nunca consume.** Un solo lugar arma la respuesta. */
  const deny = async (
    code: SolanaInboundErrorCode,
    message: string,
    challenge: SolanaInboundChallenge | null,
  ): Promise<FastifyReply> => {
    if (SOLANA_RETRYABLE_CODES.has(code)) {
      reply.header('Retry-After', String(SOLANA_INBOUND_RETRY_AFTER_SECONDS));
    }
    request.log.info(
      { error_code: code, chainKey },
      'x402 solana inbound rejected',
    );
    return reply
      .status(402)
      .send(
        challenge === null
          ? { error: message, error_code: code, x402Version: 2, accepts: [] }
          : buildSolanaX402Response(
              opts,
              challenge,
              merchantName,
              message,
              code,
            ),
      );
  };

  // ── P0. La salud del camino, fail-closed ────────────────────────────────
  //
  // Va ANTES de emitir el challenge a propósito: invitar a pagar cuando no podemos
  // verificar sería tomarle la plata al pagador sin poder honrarla. `/capabilities`
  // publica "configurado", no "sano" — la diferencia se enforcea acá.
  const ready = await ensureSolanaInboundReady();
  if (!ready.ok || payTo === null) {
    return deny(
      'X402_SETTLE_UNKNOWN',
      `Solana inbound payments are configured but not currently serviceable (${ready.ok ? 'payTo unresolved' : ready.failure}). No challenge is issued: paying against a gateway that cannot verify the proof would take your money without granting access. This is retryable.`,
      null,
    );
  }

  const built = buildSolanaChallenge({
    resource,
    amountAtomic: requiredAmount,
  });
  if (!built.ok) {
    return deny(
      'X402_SETTLE_UNKNOWN',
      `Solana inbound payments are not serviceable right now: ${built.detail}`,
      null,
    );
  }
  const challenge = built.challenge;

  // ── Sin sobre: el 402 con la tupla. Es el camino normal del primer request ──
  const canonical = request.headers[X_PAYMENT_HEADER];
  const legacy = request.headers[PAYMENT_SIGNATURE_HEADER];
  const xPaymentHeader =
    typeof canonical === 'string' && canonical.length > 0 ? canonical : legacy;
  if (!xPaymentHeader || typeof xPaymentHeader !== 'string') {
    return reply
      .status(402)
      .send(
        buildSolanaX402Response(
          opts,
          challenge,
          merchantName,
          'payment-signature header is required',
        ),
      );
  }

  // ── P1. La forma del sobre. Sin red, sin DB ─────────────────────────────
  let payload: X402PaymentRequest;
  try {
    // `decodeXPayment` NO se toca (DT-15): ya exige `authorization` objeto y
    // `signature` string, que es exactamente la forma mínima de este sobre.
    payload = decodeXPayment(xPaymentHeader);
  } catch (err) {
    return deny(
      'X402_SOLANA_PROOF_MALFORMED',
      `Invalid payment-signature format: ${err instanceof Error ? err.message : String(err)}`,
      challenge,
    );
  }
  const signature = payload.signature;
  if (typeof signature !== 'string' || !isSolanaSignatureShaped(signature)) {
    return deny(
      'X402_SOLANA_PROOF_MALFORMED',
      'the `signature` field is not a base58-encoded 64-byte Solana transaction signature',
      challenge,
    );
  }
  const auth = payload.authorization as Record<string, unknown>;

  // ── P2. La referencia se RE-DERIVA y se compara en tiempo constante ──────
  const verdict = verifySolanaChallengeReference({
    presented: {
      reference: auth.reference,
      payTo: auth.payTo,
      amountAtomic: auth.amountAtomic,
      mint: auth.mint,
      issuedAt: auth.issuedAt,
      expiresAt: auth.expiresAt,
      nonce: auth.nonce,
    },
    resource,
    network: caip2,
  });
  if (verdict.state === 'malformed') {
    return deny('X402_SOLANA_PROOF_MALFORMED', verdict.detail, challenge);
  }
  if (verdict.state === 'reference_mismatch') {
    return deny('X402_SOLANA_REFERENCE_MISMATCH', verdict.detail, challenge);
  }
  if (verdict.state === 'expired') {
    return deny('X402_SOLANA_CHALLENGE_EXPIRED', verdict.detail, challenge);
  }
  if (verdict.state === 'not_configured') {
    return deny('X402_SETTLE_UNKNOWN', verdict.detail, null);
  }
  // A partir de acá los términos del sobre son NUESTROS: los firmamos con el MAC, así
  // que se pueden usar como los términos del pago sin volver a desconfiar de ellos.
  const presented = {
    reference: String(auth.reference),
    payTo: String(auth.payTo),
    amountAtomic: String(auth.amountAtomic),
    mint: String(auth.mint),
    issuedAt: Number(auth.issuedAt),
    expiresAt: Number(auth.expiresAt),
  };
  // ── P2b. EL BINDING CONTRA EL PRECIO DE **ESTE** REQUEST ────────────────
  //
  // ⚠️ EL MAC PRUEBA "ESTE SOBRE LO EMITIMOS NOSOTROS", **NO** "ESTE ES EL PRECIO DE
  // AHORA". Y son dos cosas distintas porque el precio del MISMO `resource` varía por
  // request: `resource` es `protocol://hostname + request.url` (o sea `/compose` a
  // secas) mientras el total lo calcula el body (`routes/compose.ts`). Sin este guard,
  // un sobre emitido por un pipeline de 0,000001 USDC seguía siendo un sobre VALIDO
  // durante 900 s y pagaba un pipeline de 50 USDC: `presented.amountAtomic` viajaba
  // hasta `requiredAtomic` y la cadena se consultaba contra el monto del ATACANTE.
  // Repetible, y sin reembolso inbound en este camino (AR de WKH-314, BLQ-ALTO-1).
  //
  // Es el mismo guard que la rama EVM tiene desde WKH-SEC-03 (`:1226` en este archivo),
  // con sus mismas tres reglas: comparación en unidades ATOMICAS, `>=` (pagar de más
  // concede — nadie paga de más por error y se queda sin servicio), y un `BigInt` que
  // no lanza puertas afuera.
  //
  // Y `payTo`/`mint` van en el mismo lote porque tienen el mismo agujero: una rotación
  // de wallet o un cambio de mint dejaban 900 s de ventana en los que un sobre viejo
  // seguía mandando el dinero a la dirección anterior.
  // *Esto sería falso si*: alcanzara con el MAC — no alcanza, el MAC firma los términos
  // que el servidor emitió EN SU MOMENTO, y este request tiene los suyos.
  const serverMint = getSolanaUsdcMint();
  if (presented.payTo !== payTo || presented.mint !== serverMint) {
    request.log.warn(
      {
        error_code: 'X402_SOLANA_TERMS_MISMATCH',
        received: { payTo: presented.payTo, mint: presented.mint },
        expected: { payTo, mint: serverMint },
      },
      'x402 solana inbound rejected: stale challenge recipient/mint',
    );
    return deny(
      'X402_SOLANA_TERMS_MISMATCH',
      'that challenge was issued for a different recipient or a different mint than the one this endpoint charges in now. Ask for a fresh 402: your signature has NOT been consumed.',
      challenge,
    );
  }
  let quotedCoversPrice: boolean;
  try {
    quotedCoversPrice =
      BigInt(presented.amountAtomic) >= BigInt(requiredAmount);
  } catch {
    // Un monto no parseable es un mismatch, no un crash (DT-7 de la rama EVM).
    quotedCoversPrice = false;
  }
  if (!quotedCoversPrice) {
    request.log.warn(
      {
        error_code: 'X402_SOLANA_AMOUNT_SHORT',
        received: { amountAtomic: presented.amountAtomic },
        expected: { requiredAmount },
      },
      'x402 solana inbound rejected: challenge amount below the price of this request',
    );
    return deny(
      'X402_SOLANA_AMOUNT_SHORT',
      `that challenge was issued for ${presented.amountAtomic} atomic units and this request costs ${requiredAmount}. A challenge is valid for the price it quoted, not for a later one. Ask for a fresh 402: your signature has NOT been consumed.`,
      challenge,
    );
  }

  const proofArgs = {
    caip2,
    signature,
    reference: presented.reference,
    resource,
    payTo: presented.payTo,
    amountAtomic: presented.amountAtomic,
    mint: presented.mint,
  };

  /** El canal ÚNICO del `unknown`, con la firma y la referencia como claves. */
  const emitUnknown = (detail: string): void => {
    emitInboundSettleUnknownEvent({
      request,
      chainKey,
      payTo: presented.payTo,
      requiredAmount: presented.amountAtomic,
      resource,
      // En Solana no hay `authorization.nonce` de EIP-3009: la clave es la firma.
      authorizationNonce: null,
      detail,
      txHash: null,
      extraMetadata: { signature, reference: presented.reference },
    });
  };

  // ── P3. El peek del store ───────────────────────────────────────────────
  const peek = await peekInboundProof(caip2, signature);
  if (peek.state === 'consumed') {
    return deny(
      'X402_SOLANA_PROOF_REPLAY',
      'this payment signature has already been used to obtain service. A Solana signature can be presented any number of times and the chain will not object — the gateway keeps the single-use ledger, and this one is already spent.',
      challenge,
    );
  }
  if (peek.state === 'unknown') {
    emitUnknown(`inbound proof peek unavailable: ${peek.detail}`);
    return deny(
      'X402_SETTLE_UNKNOWN',
      'the single-use ledger could not be read, so it cannot be established whether this proof was already spent. Access NOT granted and the proof was NOT consumed: retrying later is safe.',
      challenge,
    );
  }
  const cachedTermsMatch =
    peek.state === 'observed' &&
    peek.terms.reference === proofArgs.reference &&
    peek.terms.resource === proofArgs.resource &&
    peek.terms.payTo === proofArgs.payTo &&
    peek.terms.amountAtomic === proofArgs.amountAtomic &&
    peek.terms.mint === proofArgs.mint;
  if (peek.state === 'observed' && !cachedTermsMatch) {
    return deny(
      'X402_SOLANA_TERMS_MISMATCH',
      'this signature is already recorded against a different payment (other recipient, amount, mint, reference or resource). The same transfer cannot pay for two things.',
      challenge,
    );
  }

  // ── P4 + P5. La cadena, UNA sola vez en la vida del pago (DT-12) ────────
  if (!cachedTermsMatch) {
    const probeArgs = {
      signature,
      payTo: presented.payTo,
      mint: presented.mint,
      requiredAtomic: presented.amountAtomic,
      reference: presented.reference,
      issuedAt: presented.issuedAt,
      expiresAt: presented.expiresAt,
    };
    const primary = await probeInboundProof(getSolanaConnection(), probeArgs);
    // DT-10 — el segundo proveedor. `null` = no configurado, que NO es lo mismo que
    // un segundo proveedor que no supo contestar.
    let fallback: Awaited<ReturnType<typeof probeInboundProof>> | null = null;
    try {
      const fallbackConn = getSolanaFallbackConnection();
      if (fallbackConn !== null) {
        fallback = await probeInboundProof(fallbackConn, probeArgs);
      }
    } catch (err) {
      // Una `SOLANA_RPC_URL_FALLBACK` inválida NO se lee como "no hay fallback": eso
      // convertiría un error de config en un veredicto más permisivo.
      fallback = {
        presence: {
          state: 'unknown',
          detail: err instanceof Error ? err.message : String(err),
        },
        binding: {
          state: 'unknown',
          detail: 'fallback provider unavailable',
        },
      };
    }

    const presence = combineInboundPresence(
      primary.presence,
      fallback?.presence ?? null,
    );
    const binding = combineInboundBinding(
      primary.binding,
      fallback?.binding ?? null,
    );

    switch (presence.state) {
      case 'terms_mismatch':
        return deny(
          presence.detail.includes('AMOUNT_SHORT')
            ? 'X402_SOLANA_AMOUNT_SHORT'
            : 'X402_SOLANA_TERMS_MISMATCH',
          `the transaction does not satisfy the challenge terms: ${presence.detail}`,
          challenge,
        );
      case 'landed_failed':
        return deny(
          'X402_SOLANA_TX_FAILED',
          `that transaction landed and FAILED on-chain, so nothing moved: ${presence.detail}`,
          challenge,
        );
      case 'not_finalized':
        return deny(
          'X402_SOLANA_NOT_FINALIZED',
          `the transaction is ${presence.confirmationStatus} but not yet finalized. Finality is a precondition for granting access; present the same signature again in a few seconds — it has NOT been consumed.`,
          challenge,
        );
      case 'absent':
        // ⚠️ EL MENSAJE DICE CUANTOS NODOS BUSCARON DE VERDAD (AR de WKH-314,
        // BLQ-BAJO-1). Acá se afirmaba "two independent nodes searched" SIEMPRE, y sin
        // `SOLANA_RPC_URL_FALLBACK` había buscado UNO: `combineInboundPresence`
        // devuelve el veredicto del primario tal cual cuando no hay segundo proveedor.
        // El conteo se deriva de `fallback`, que es lo único que sabe si se preguntó, y
        // llegar acá con fallback presente implica que los DOS dijeron `absent` (un
        // `absent` contradicho por cualquier otra cosa se degrada a `unknown`).
        return deny(
          'X402_SOLANA_PROOF_ABSENT',
          fallback === null
            ? 'one node searched its transaction history and does not know that signature. This gateway has no second RPC provider configured, so that is ONE opinion, not a corroborated absence — if you are sure the transaction landed, retry: your proof has NOT been consumed.'
            : 'two independent nodes searched their transaction history and do not know that signature.',
          challenge,
        );
      case 'unknown':
        emitUnknown(`chain verdict unavailable: ${presence.detail}`);
        return deny(
          'X402_SETTLE_UNKNOWN',
          'the chain could not be queried about that signature, so it can be neither confirmed nor denied. Access NOT granted and the proof was NOT consumed: retrying later is safe.',
          challenge,
        );
      case 'finalized_ok':
        break;
    }

    // P5 — el binding. Se evalúa DESPUES de la presencia porque un `finalized_ok`
    // sobre otra transacción no es este pago.
    if (binding.state === 'reference_absent') {
      return deny(
        'X402_SOLANA_REFERENCE_MISMATCH',
        `that transaction does not carry this challenge's reference: ${binding.detail}`,
        challenge,
      );
    }
    if (binding.state === 'outside_window') {
      return deny(
        'X402_SOLANA_CHALLENGE_EXPIRED',
        `that transaction landed outside this challenge's window: ${binding.detail}`,
        challenge,
      );
    }
    if (binding.state === 'unknown') {
      emitUnknown(`binding undetermined: ${binding.detail}`);
      return deny(
        'X402_SETTLE_UNKNOWN',
        'it could not be determined whether that transaction carries this challenge reference. Access NOT granted and the proof was NOT consumed: retrying later is safe.',
        challenge,
      );
    }

    // ── P6. Persistir el veredicto de la cadena ───────────────────────────
    const observed = await recordInboundObserved(proofArgs);
    if (observed.outcome === 'replay') {
      return deny(
        'X402_SOLANA_PROOF_REPLAY',
        'this payment signature has already been used to obtain service.',
        challenge,
      );
    }
    if (observed.outcome === 'terms_conflict') {
      return deny(
        'X402_SOLANA_TERMS_MISMATCH',
        'this signature is already recorded against a different payment.',
        challenge,
      );
    }
    if (observed.outcome === 'store_unavailable') {
      emitUnknown(`inbound proof observe failed: ${observed.detail}`);
      return deny(
        'X402_SETTLE_UNKNOWN',
        'the chain verdict could not be persisted, so access cannot be granted against it. The proof was NOT consumed: retrying later is safe.',
        challenge,
      );
    }
  }

  // ── P7. EL COBRO. Escritura condicional atómica, exactamente un ganador ──
  //
  // ⚠️ EL CONSUMO NO SE INTENTA SI LA RESPUESTA YA SALIO (AR de WKH-314, BLQ-MED-2).
  // `createTimeoutHandler` (`middleware/timeout.ts`) manda el 504 desde FUERA del
  // lifecycle: puede haber salido mientras estábamos en el peek, en el RPC o en el
  // observe. Consumir después de eso es quemar la prueba de un pagador que ya recibió
  // un error — transfirió USDC y su reintento le va a contestar `PROOF_REPLAY`.
  // Devolver `undefined` acá NO concede acceso: `paymentVerified` sigue sin setearse y
  // la respuesta que el cliente ve es la que ya se envió.
  //
  // ⚠️ NO ES EL GUARD `FST_ERR_REP_ALREADY_SENT` de la rama EVM (`:1272`). Ese evita
  // una EXCEPCION al mandar dos veces; el AR midió que con Fastify 5 el segundo
  // `.send()` no lanza. Lo que se evita acá es el CONSUMO IRREVERSIBLE, y por eso el
  // chequeo va antes de la escritura y no antes del `.send()`.
  if (reply.sent) return reply;
  const consumed = await consumeInboundProof(proofArgs);
  switch (consumed.outcome) {
    case 'replay':
      return deny(
        'X402_SOLANA_PROOF_REPLAY',
        'this payment signature has already been used to obtain service.',
        challenge,
      );
    case 'terms_conflict':
      return deny(
        'X402_SOLANA_TERMS_MISMATCH',
        'this signature is recorded against a different payment.',
        challenge,
      );
    case 'store_unavailable':
      emitUnknown(`inbound proof consume failed: ${consumed.detail}`);
      // ⚠️ ACA NO SE PUEDE AFIRMAR "la prueba NO se consumió", y antes se afirmaba
      // (MNR-2 del AR). Este es el ÚNICO camino donde el consumo ya se intentó: si la
      // escritura commiteó y se perdió la respuesta del store
      // (`solana-inbound-proof.ts:310`), la fila quedó consumida y este mensaje sería
      // falso. Lo que sí se garantiza —y es lo que se escribe— es que NO se concede
      // acceso a nadie, y que el reintento es la acción correcta.
      return deny(
        'X402_SETTLE_UNKNOWN',
        'the single-use ledger did not confirm the consumption of this proof, so access is NOT granted. Retry: if the consumption never landed you will be served, and if it landed but its acknowledgement was lost you will get X402_SOLANA_PROOF_REPLAY instead of silence.',
        challenge,
      );
    case 'consumed':
      break;
  }

  // ── P9. Recién ahora se concede ─────────────────────────────────────────
  request.paymentTxHash = signature;
  request.paymentVerified = true;
  if (!reply.sent) reply.header('payment-response', signature);
  return undefined;
}

/**
 * ¿Este string tiene la forma de una firma Solana? base58 que decodifica a **64 bytes
 * exactos**.
 *
 * Se mide la longitud DECODIFICADA y no la del string: base58 no tiene largo fijo, y
 * un regex del alfabeto acepta cualquier cosa dentro de él. Una "firma" de 63 bytes
 * llegaría hasta el RPC y volvería como un error de transporte que se leería como
 * `unknown` — o sea, como un problema nuestro en vez de un sobre mal armado.
 */
function isSolanaSignatureShaped(candidate: string): boolean {
  try {
    return base58DecodeToBytes(candidate).length === SOLANA_SIGNATURE_BYTES;
  } catch {
    return false;
  }
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
      // WKH-175: el default dejaba de ser silencioso — se avisa (warn
      // deduplicado + debug per-request). NO cambia la resolución.
      // `null` = path x402 puro: acá NO hay agent-key (el caller se identifica
      // con la firma de pago), así que el dedup usa el sentinel
      // DEFAULT_CHAIN_WARN_NO_KEY. Ver warnDefaultChainApplied.
      warnDefaultChainApplied(request, chainKey, null);
    }

    const bundle = getAdaptersBundle(chainKey);
    if (!bundle) {
      // recognised slug but not present in the initialised registry.
      return reply.status(400).send({
        error_code: 'CHAIN_NOT_SUPPORTED',
        error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
      });
    }

    // ── HU-204: chain inicializada pero OUTBOUND-ONLY → 400, no 500 ──────────
    // Todo lo que sigue en este handler (challenge 402, binding check, verify,
    // settle) pasa por `getPaymentAdapter()`, que LANZA a propósito sobre un
    // bundle non-EVM (`registry.ts:getPaymentAdapter`). Sin este corte, el throw
    // viajaba hasta el error-boundary y salía como 500 INTERNAL_ERROR: el
    // gateway le decía "me rompí" a un caller que en realidad pidió algo que
    // esta chain no ofrece — y encima le escondía QUÉ hacer.
    //
    // Choke-point único: cubre los 5 endpoints cobrables (compose, orchestrate,
    // orchestrate/plan, orchestrate/execute, gasless/transfer) porque los cinco
    // entran por `requirePaymentOrA2AKey` → `requirePayment`.
    //
    // NO toca el path prepago: con `x-a2a-key` presente, `requirePaymentOrA2AKey`
    // NUNCA delega en este handler (a2a-key.ts:1606) y resuelve la chain con su
    // propio `resolveTargetChain`, que sí soporta `solana-devnet`.
    if (!acceptsInboundPayment(bundle)) {
      const inboundChains = getInboundPaymentChainKeys();
      request.log.info(
        {
          error_code: X402_INBOUND_UNSUPPORTED_CODE,
          chainKey,
          vmFamily: bundle.payment.vmFamily,
        },
        'x402 inbound payment rejected: chain is an outbound-settlement-only rail',
      );
      return reply
        .header(X_A2A_PAYMENT_CHAIN_HEADER, chainKey)
        .status(400)
        .send({
          error_code: X402_INBOUND_UNSUPPORTED_CODE,
          error: inboundPaymentUnsupportedMessage(chainKey, inboundChains),
          inbound_payment_chains: inboundChains,
        });
    }

    // WKH-175: eco de la chain efectivamente usada al caller. Se setea acá (una
    // vez resuelto el bundle) para que TODAS las salidas de este handler la
    // lleven — el 402 challenge incluido, que es donde el caller descubre en qué
    // red se le está cobrando.
    //
    // MNR-2 (AR, documentado NO implementado): este header solo es legible por
    // callers SERVER-SIDE (SDK, agentes, rutas server de Chaski — los únicos que
    // pueden sostener el secreto `x-a2a-key`). La config de @fastify/cors en
    // src/index.ts NO declara `exposedHeaders`, así que un caller BROWSER no
    // puede leerlo. Es un gap PREEXISTENTE y compartido con el header que se
    // tomó como patrón (`x-a2a-remaining-budget`). Exponerlo a browsers
    // requeriría agregar AMBOS headers a `exposedHeaders` del CORS: decisión
    // pendiente, depende de si aparecen consumidores browser reales.
    reply.header(X_A2A_PAYMENT_CHAIN_HEADER, chainKey);

    // ── WKH-314 · DT-4 — LA BIFURCACION SOLANA, CON `return` INMEDIATO ──────
    //
    // Va ACA, y no más abajo, por una razón mecánica: todo lo que sigue pasa por
    // `getPaymentAdapter()`, que LANZA a propósito sobre un bundle non-EVM. Esta HU
    // **no generaliza** ese pipeline (sigue siendo EVM-only y sigue lanzando): lo
    // bifurca antes. Consecuencia medible: ni una línea del camino EVM de abajo se
    // modifica ni se ejecuta para Solana.
    if (bundle.payment.vmFamily === 'solana') {
      return await handleSolanaInboundPayment({
        request,
        reply,
        opts,
        resource,
        chainKey,
        // Del adapter del bundle, que es el mismo objeto que la rama EVM consulta.
        // `getPaymentAdapter()` NO se usa acá: lanza a propósito sobre non-EVM.
        merchantName: bundle.payment.getMerchantName(),
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

    /**
     * HU-198 + HU-201 — EL CANAL ÚNICO del "settle inbound de resultado DESCONOCIDO".
     *
     * Estaba inline dentro del `catch`, y por eso el segundo eje (2xx `success:false`
     * CON txHash, el camino pieverse) no lo usaba: le respondía "Payment settlement
     * failed" y no dejaba ni log ni evento. Extraído para que los DOS ejes emitan lo
     * mismo — un log alertable + un `a2a_events` durable donde reconciliarlo.
     *
     * `txHash` es la evidencia de broadcast cuando existe (eje HU-201) y `null` cuando
     * el hop no contestó y no hay nada que anotar (eje HU-198).
     */
    // WKH-314 · DT-14 — el canal del `unknown` es UNO SOLO, y ahora vive en el
    // módulo (`emitInboundSettleUnknownEvent`) para que la rama Solana emita
    // EXACTAMENTE lo mismo en vez de una segunda copia que puede divergir. Esta
    // closure conserva su nombre y su firma: los dos call-sites EVM de abajo no se
    // tocan, y `x402.settle-unknown.test.ts` verde SIN MODIFICARSE es la prueba de
    // que la extracción no cambió nada.
    const emitInboundSettleUnknown = (
      detail: string,
      txHash: string | null,
    ): void => {
      emitInboundSettleUnknownEvent({
        request,
        chainKey,
        payTo,
        requiredAmount,
        resource,
        // El nonce es la clave para cruzar contra la cadena: es el que el
        // facilitator pudo haber consumido al broadcastear.
        authorizationNonce:
          typeof inboundNonce === 'string' ? inboundNonce : null,
        detail,
        txHash,
      });
    };

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
      // HU-198: el 402 se manda igual (sin confirmación NO se puede dar acceso),
      // pero un settle de resultado DESCONOCIDO no es lo mismo que uno rechazado y
      // no puede quedar sólo como un 402 más en el log de accesos: la plata del
      // caller PUDO haber salido. Además el nonce inbound ya quedó registrado más
      // arriba (anti-replay), así que un reintento del MISMO header va a dar
      // X402_REPLAY: si nadie mira este caso, el caller queda pagando sin servicio.
      // Se emite con `error_code` estable y nivel error para que sea alertable.
      const inboundUnknown = readSettleValueDisposition(err) === 'unknown';
      if (inboundUnknown) emitInboundSettleUnknown(detail, null);
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            inboundUnknown
              ? unknownSettleMessage(detail, null)
              : `Payment settlement failed: ${detail}`,
          ),
        );
    }
    if (reply.sent) return;
    if (!settleResult.success) {
      // HU-201 (AR BLQ-MEDIO-1) — EL SEGUNDO EJE, EN EL MISMO ENDPOINT.
      //
      // El `catch` de arriba cubre el eje "el hop no contestó" (incluido, desde
      // HU-201, el HTTP non-2xx). ESTE es el otro: el facilitator SÍ contestó 2xx con
      // `success:false` PERO CON un txHash — el camino pieverse, que devuelve la
      // respuesta verbatim. Antes se le respondía al caller "Payment settlement
      // failed" TENIENDO EL HASH EN LA MANO: se le afirmaba que no se le cobró.
      //
      // Es plata del CALLER, en el endpoint más expuesto, y el nonce inbound ya quedó
      // quemado más arriba, así que el reintento del mismo header da X402_REPLAY: paga
      // y no tiene dónde reclamar. Entra por el MISMO canal que el eje de arriba
      // (`X402_SETTLE_UNKNOWN` + evento durable + mensaje honesto), que es el
      // mecanismo que ya existía. El hash viaja en el evento porque es LA clave para
      // cruzar contra la cadena.
      const evidenceTxHash = hasBroadcastEvidence(settleResult.txHash)
        ? settleResult.txHash
        : null;
      const detail = settleResult.error ?? 'unknown reason';
      if (evidenceTxHash !== null)
        emitInboundSettleUnknown(detail, evidenceTxHash);
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            evidenceTxHash !== null
              ? unknownSettleMessage(detail, evidenceTxHash)
              : `Payment settlement failed: ${detail}`,
          ),
        );
    }
    // ── TB-01 (audit 2026-06-30): independent on-chain re-verification ──
    // The facilitator just reported `{ success, txHash }`. BEFORE we grant
    // access, re-read that tx hash on-chain and confirm it really settled
    // `>= requiredAmount` of the chain token to `payTo`. A forged/buggy/replayed
    // settle JSON (fake hash) is rejected here → 402, no access granted. Gated
    // behind SETTLE_VERIFY_ONCHAIN (default ON): when OFF this is a no-op.
    // WKH-234: narrow the `PaymentAdapter` union via `vmFamily`. The x402
    // settle re-verify is EVM-only (viem); non-EVM → undefined → the existing
    // `settleToken` guard skips re-verify (unreachable for EVM chains).
    const settlePayment = bundle.payment;
    const settleToken =
      settlePayment?.vmFamily === 'evm'
        ? settlePayment.supportedTokens?.[0]
        : undefined;
    if (
      typeof settleResult.txHash === 'string' &&
      settleResult.txHash.startsWith('0x') &&
      settleToken
    ) {
      let reVerified: Awaited<ReturnType<typeof verifySettledTx>>;
      try {
        reVerified = await verifySettledTx({
          chainKey,
          chainId: bundle.chainConfig.chainId,
          txHash: settleResult.txHash as `0x${string}`,
          payTo,
          tokenAddress: settleToken.address,
          requiredAmountAtomic: BigInt(requiredAmount),
        });
      } catch (err) {
        // Verifier never throws by contract; this is pure defense in depth.
        // MNR-1 / WKH-144: a thrown error means "couldn't check". Gate it exactly
        // like the verifier's own RPC_UNAVAILABLE outcomes — testnet fail-OPEN
        // (allow+warn, byte-identical), MAINNET fail-CLOSED (block+warn) so a
        // throw in the try (e.g. malformed BigInt) never blindly grants access
        // with real money on the line. `chainKey` is the same resolved key used
        // by verifySettledTx above (in scope for the whole handler).
        reVerified = rpcUnavailableResult(chainKey);
        request.log.error(
          { detail: err instanceof Error ? err.message : String(err) },
          'x402 settle re-verification threw',
        );
      }
      if (reply.sent) return;
      // MNR-1: RPC_UNAVAILABLE (couldn't independently check) → ALLOW the settle
      // but log a clear warning. The facilitator already broadcast + receipt-
      // checked it; we only degrade to trusted-infra when a2a can't reach a node.
      if (reVerified.warn) {
        request.log.warn(
          {
            error_code: 'X402_SETTLE_ONCHAIN_UNVERIFIED',
            reason: reVerified.reason,
            txHash: settleResult.txHash,
          },
          'settle on-chain re-verify unavailable, trusting facilitator confirmation',
        );
      }
      if (!reVerified.ok) {
        request.log.warn(
          {
            error_code: 'X402_SETTLE_ONCHAIN_MISMATCH',
            reason: reVerified.reason,
            txHash: settleResult.txHash,
          },
          'x402 settle rejected: on-chain re-verification failed',
        );
        return reply
          .status(402)
          .send(
            await buildX402Response(
              opts,
              resource,
              chainKey,
              `Payment settlement could not be verified on-chain (${reVerified.reason ?? 'unknown'})`,
            ),
          );
      }
    }
    request.paymentTxHash = settleResult.txHash;
    request.paymentVerified = true;
    if (!reply.sent) reply.header('payment-response', settleResult.txHash);
  };
  // HU-193: este handler settlea el cobro x402 inbound (y el gas del settle lo
  // paga NUESTRA wallet de operador). Marcarlo hace que el guard estructural
  // de `routes/charged-routes.meta.test.ts` también cubra una ruta futura que
  // llame `requirePayment` directo, sin pasar por `requirePaymentOrA2AKey`.
  markChargesCaller(handler);
  return [handler];
}
