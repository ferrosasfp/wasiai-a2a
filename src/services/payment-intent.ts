/**
 * Payment Intent Service — WKH-135 · `session` (metered) + `upto` (dual-signed cap)
 *
 * Dos intents de pago aditivos al money-path (NO tocan charge/compose/orchestrate):
 *   - session (metered): openSession reserva un deposit contra el budget prepago
 *     (increment_a2a_key_spend dentro del RPC open); addVoucher acumula uso
 *     idempotente; closeSession settlea min(Σvouchers, deposit) al seller + refund
 *     del residual (refund_a2a_key_spend) al buyer.
 *   - upto (cap dual-firmado): createUpto verifica un cap EIP-712 anclado a
 *     funding_wallet (NO reserva); settleUpto cobra exactamente min(cap, uso),
 *     clampando al cap (nunca rechaza, nunca > cap).
 *
 * Reglas money-path (SDD §5):
 *   - CD-1: idempotencia por PK del intent (UUID server-side generado en el route).
 *   - CD-2: Ownership Guard owner_ref (string, NO undefined) en TODO RPC.
 *   - CD-3: vouchers idempotentes por UNIQUE(intent_id, voucher_id); settle por
 *     transición open→closing bajo FOR UPDATE.
 *   - CD-5: verifyDefaultChainSettle ANTES de marcar settled; contradicción → failed.
 *   - CD-6: montos en micro-USD entero (decimalStringToMicroUsd copiado de
 *     delegation.ts — es privado allá); residual = max(0, deposit − consumido).
 *   - CD-7: el settle NUNCA rechaza la promise → { status:'failed' } + finalize best-effort.
 *   - CD-8: viem only (recoverTypedDataAddress).
 *
 * SEAM WKH-136: `settlePaymentIntentOnChain` es interfaz estable (splits bps la
 * van a envolver). NO dupliques la lógica sign/settle/verify en cada método.
 */

import { recoverTypedDataAddress } from 'viem';
import { getPaymentAdapter } from '../adapters/registry.js';
import { verifyDefaultChainSettle } from '../adapters/settle-verifier.js';
import type { SignResult } from '../adapters/types.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import type {
  AddVoucherInput,
  CreateUptoInput,
  OpenSessionInput,
  SettleOutcome,
  UptoCapTypedData,
  UptoEip712Domain,
} from '../types/index.js';

const log = getLogger('payment-intent');

const PG_UNIQUE_VIOLATION = '23505';
const DEFAULT_TTL_SECONDS = 3600;

// ── Error de negocio (self-contained: NO se puede tocar security/errors.js) ──

/**
 * Códigos estables mapeados a HTTP en el route (tabla de errores del Story File).
 * NUNCA propagamos el mensaje crudo de Postgres al cliente (CD-2 disclosure-safe).
 */
export type PaymentIntentErrorCode =
  | 'INVALID_INPUT'
  | 'CAP_SIGNATURE_INVALID'
  | 'OWNERSHIP_MISMATCH'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_NOT_OPEN'
  | 'INSUFFICIENT_BUDGET'
  | 'INTERNAL';

export class PaymentIntentError extends Error {
  readonly code: PaymentIntentErrorCode;
  constructor(code: PaymentIntentErrorCode) {
    super(code);
    this.name = 'PaymentIntentError';
    this.code = code;
  }
}

// ── EIP-712 del cap upto (mirror exacto de delegation.ts:53-81) ──

/** Domain del server. `verifyingContract` se omite a propósito (NC-3). */
function buildUptoDomain(): UptoEip712Domain {
  return {
    name: process.env.UPTO_EIP712_NAME ?? 'WasiAI-a2a Upto',
    version: process.env.UPTO_EIP712_VERSION ?? '1',
    chainId: Number(process.env.KITE_CHAIN_ID),
  };
}

// types EIP-712 del cap. `as const`; NO se incluye EIP712Domain (viem lo infiere).
const UPTO_TYPES = {
  UptoCap: [
    { name: 'seller_ref', type: 'string' },
    { name: 'cap', type: 'string' }, // decimal USD como string (sin float64)
    { name: 'chain_id', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expires_at', type: 'uint64' },
  ],
} as const;

// ── Helpers puros (micro-USD entero, CD-6) ──────────────────────

/**
 * Convierte un string decimal USD (p.ej. "0.50", "100", "1.234567") a un entero
 * de micro-USD (×1e6) SIN pasar por float64. Devuelve null si el formato es
 * inválido. Trunca a 6 decimales. COPIA del helper privado de delegation.ts:112-120
 * (no está exportado allá — CD-6 pide replicarlo, no importarlo).
 */
function decimalStringToMicroUsd(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, fracPartRaw = ''] = s.split('.');
  const fracPart = `${fracPartRaw}000000`.slice(0, 6); // pad/truncate a 6 dec
  const micro = Number(intPart) * 1_000_000 + Number(fracPart);
  return Number.isFinite(micro) ? micro : null;
}

/**
 * Normaliza un NUMERIC del RPC (llega como number en el tipo generado, pero
 * defensivamente aceptamos string) a micro-USD entero. Nunca lanza.
 */
function numericToMicro(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') {
    const m = decimalStringToMicroUsd(v);
    if (m !== null) return m;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
  }
  return Number.isFinite(v) ? Math.round(v * 1_000_000) : 0;
}

function numericToUsd(v: number | string | null | undefined): number {
  return numericToMicro(v) / 1_000_000;
}

/**
 * USD → wei (18 decimals). Patrón idéntico a fee-charge.ts:133-135 y
 * compose.ts:188 (R-3): `BigInt(Math.round(usd*1e6)) * BigInt(1e12)`. El token
 * del default chain (kite/PYUSD) es 18 decimals; la verificación on-chain compara
 * el mismo atomic.
 */
function usdToWei(usd: number): string {
  return String(
    BigInt(Math.round(usd * 1_000_000)) * BigInt(1_000_000_000_000),
  );
}

function resolveTtlSeconds(): number {
  const raw = process.env.PAYMENT_INTENT_TTL_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_SECONDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

interface PgError {
  code?: string;
  message?: string;
}

/**
 * Mapea el error crudo de un RPC/insert a un PaymentIntentError estable (CD-2).
 * `nonceContext=true` interpreta el 23505 como replay del cap upto.
 */
function mapPgError(error: PgError, ctx: string, nonceContext: boolean): never {
  const msg = error.message ?? '';
  if (
    nonceContext &&
    (error.code === PG_UNIQUE_VIOLATION ||
      msg.includes('uq_a2a_payment_intents_cap_nonce') ||
      msg.includes('duplicate key'))
  ) {
    // cap_nonce reusado → anti-replay (CD-2).
    throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
  }
  if (msg.includes('OWNERSHIP_MISMATCH') || msg.includes('KEY_NOT_FOUND')) {
    // key_id de otro owner o inexistente → disclosure-safe 403.
    throw new PaymentIntentError('OWNERSHIP_MISMATCH');
  }
  if (msg.includes('INTENT_NOT_FOUND')) {
    throw new PaymentIntentError('INTENT_NOT_FOUND');
  }
  if (msg.includes('INTENT_NOT_OPEN')) {
    throw new PaymentIntentError('INTENT_NOT_OPEN');
  }
  if (
    msg.includes('INSUFFICIENT_BUDGET') ||
    msg.includes('DAILY_LIMIT') ||
    msg.includes('KEY_INACTIVE')
  ) {
    // no se pudo reservar el deposit (session) → 400.
    throw new PaymentIntentError('INSUFFICIENT_BUDGET');
  }
  log.error({ ctx, detail: msg }, 'payment intent RPC error');
  throw new PaymentIntentError('INTERNAL');
}

/**
 * finalize best-effort (CD-7): tras un settle on-chain exitoso NUNCA re-lanzamos
 * — el dinero ya se movió; un fallo del UPDATE/refund se loguea y se resuelve por
 * expiry/retry. Idempotente (el RPC solo actúa mientras status='closing').
 */
async function finalizePaymentIntent(
  intentId: string,
  ownerRef: string,
  txHash: string | null,
  finalAmount: number,
  residual: number | null,
  success: boolean,
  errorMessage: string | null,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('finalize_payment_intent', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_tx_hash: txHash,
      p_final_amount: finalAmount,
      p_residual: residual,
      p_success: success,
      p_error: errorMessage,
    });
    if (error) {
      log.error(
        { intentId, detail: error.message },
        'finalize_payment_intent failed',
      );
    }
  } catch (err) {
    log.error(
      { intentId, detail: err instanceof Error ? err.message : String(err) },
      'finalize_payment_intent threw',
    );
  }
}

// ── SEAM WKH-136: settle on-chain compartido (SP-1/SP-2) ────────

/**
 * Único punto de settle on-chain (closeSession y settleUpto DEBEN delegar acá).
 * Espejo de fee-charge.ts:256-345. NUNCA rechaza (CD-7): todo error → failed.
 * WKH-136 (splits bps) va a envolver esta función — interfaz estable, NO duplicar.
 */
export async function settlePaymentIntentOnChain(params: {
  intentId: string;
  ownerRef: string;
  payTo: string;
  finalAmountUsd: number;
  chainId: number;
}): Promise<SettleOutcome> {
  const { intentId, payTo, finalAmountUsd } = params;
  try {
    const wei = usdToWei(finalAmountUsd);

    // 1. sign (try/catch propio → failed).
    let signResult: SignResult;
    try {
      signResult = await getPaymentAdapter().sign({
        to: payTo as `0x${string}`,
        value: wei,
      });
    } catch (signErr) {
      const detail =
        signErr instanceof Error ? signErr.message : String(signErr);
      log.error({ intentId, detail }, 'settle sign() failed');
      return { status: 'failed', txHash: null, finalAmountUsd, error: detail };
    }

    // 2. settle (try/catch propio → failed).
    const { paymentRequest } = signResult;
    let settleTxHash: string;
    try {
      const settleResult = await getPaymentAdapter().settle({
        authorization: paymentRequest.authorization,
        signature: paymentRequest.signature,
        network: paymentRequest.network ?? '',
      });
      if (!settleResult.success) {
        const detail = `settle failed: ${settleResult.error ?? 'unknown'}`;
        log.error({ intentId, detail }, 'settle reported failure');
        return {
          status: 'failed',
          txHash: null,
          finalAmountUsd,
          error: detail,
        };
      }
      settleTxHash = settleResult.txHash;
    } catch (settleErr) {
      const detail =
        settleErr instanceof Error ? settleErr.message : String(settleErr);
      log.error({ intentId, detail }, 'settle() threw');
      return { status: 'failed', txHash: null, finalAmountUsd, error: detail };
    }

    // 3. re-verify on-chain ANTES de marcar settled (CD-5).
    const verified = await verifyDefaultChainSettle({
      txHash: settleTxHash,
      payTo,
      requiredAmountAtomic: BigInt(wei),
    });
    if (verified.warn) {
      // RPC_UNAVAILABLE → fail-OPEN (confiar en el facilitator) + warn.
      log.warn(
        { intentId, reason: verified.reason },
        'settle on-chain re-verify unavailable, trusting facilitator',
      );
    }
    if (!verified.ok) {
      // contradicción definitiva → fail-CLOSED. NO settled, NO refund.
      const detail = `settle re-verification failed: ${verified.reason ?? 'unknown'}`;
      log.error({ intentId, detail }, 'settle re-verification failed');
      return { status: 'failed', txHash: null, finalAmountUsd, error: detail };
    }

    return { status: 'settled', txHash: settleTxHash, finalAmountUsd };
  } catch (err) {
    // CD-7: jamás rechazar (p.ej. BigInt(wei) o el builder de supabase lanzan).
    const detail = err instanceof Error ? err.message : String(err);
    log.error(
      { intentId, detail },
      'settlePaymentIntentOnChain unexpected error',
    );
    return { status: 'failed', txHash: null, finalAmountUsd, error: detail };
  }
}

// ── Service ─────────────────────────────────────────────────────

export const paymentIntentService = {
  /**
   * Recupera el firmante del cap EIP-712 (mirror de delegation.verifyTypedData).
   * Domain binding ANTES del recover. Throws PaymentIntentError('CAP_SIGNATURE_INVALID').
   */
  async verifyCapSignature(
    typedData: UptoCapTypedData,
    signature: string,
  ): Promise<`0x${string}`> {
    const serverDomain = buildUptoDomain();
    if (
      typedData.domain.name !== serverDomain.name ||
      typedData.domain.version !== serverDomain.version ||
      typedData.domain.chainId !== serverDomain.chainId
    ) {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
    try {
      const m = typedData.message;
      return await recoverTypedDataAddress({
        domain: {
          name: serverDomain.name,
          version: serverDomain.version,
          chainId: serverDomain.chainId,
        },
        types: UPTO_TYPES,
        primaryType: 'UptoCap',
        message: {
          seller_ref: m.seller_ref,
          cap: m.cap,
          chain_id: BigInt(m.chain_id),
          nonce: m.nonce,
          expires_at: BigInt(m.expires_at),
        },
        signature: signature as `0x${string}`,
      });
    } catch {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
  },

  /**
   * session: crea el intent + reserva el deposit (increment_a2a_key_spend dentro
   * del RPC, atómico). Propaga INSUFFICIENT_BUDGET/ownership. El intentId lo
   * genera el route (crypto.randomUUID, CD-1). expires_at server-side.
   */
  async openSession(
    input: OpenSessionInput,
  ): Promise<{ intentId: string; expiresAt: string }> {
    const ttl =
      input.ttlSeconds !== undefined && input.ttlSeconds > 0
        ? input.ttlSeconds
        : resolveTtlSeconds();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const { error } = await supabase.rpc('open_payment_intent', {
      p_id: input.intentId,
      p_intent_type: 'session',
      p_owner_ref: input.ownerRef,
      p_key_id: input.keyId,
      p_buyer_wallet: input.buyerWallet,
      p_seller_ref: input.sellerRef,
      p_pay_to: input.payTo,
      p_chain_id: input.chainId,
      p_authorized_usd: input.depositUsd,
      p_cap_signature: null,
      p_cap_nonce: null,
      p_expires_at: expiresAt,
    });
    if (error) mapPgError(error, 'open-session', false);
    return { intentId: input.intentId, expiresAt };
  },

  /**
   * session: acumula un voucher idempotente (UNIQUE(intent_id, voucher_id)).
   * Duplicado → consumed NO incrementa (duplicate:true). Clamp al deposit en el RPC.
   */
  async addVoucher(
    input: AddVoucherInput,
  ): Promise<{ accepted: boolean; consumedUsd: number; duplicate: boolean }> {
    const { data, error } = await supabase.rpc('accumulate_payment_voucher', {
      p_intent_id: input.intentId,
      p_owner_ref: input.ownerRef,
      p_voucher_id: input.voucherId,
      p_amount: input.amountUsd,
    });
    if (error) mapPgError(error, 'add-voucher', false);
    const row = data?.[0];
    if (!row) throw new PaymentIntentError('INTERNAL');
    return {
      accepted: true,
      consumedUsd: numericToUsd(row.consumed),
      duplicate: row.is_duplicate,
    };
  },

  /**
   * session: cierra y settlea min(Σvouchers, deposit) al seller + refund del
   * residual al buyer (AC-1/AC-2). Idempotente: el 2º close ve prev_status!=='open'
   * y NO re-settlea. Delega el on-chain a settlePaymentIntentOnChain (seam).
   */
  async closeSession(
    intentId: string,
    ownerRef: string,
  ): Promise<SettleOutcome> {
    const { data, error } = await supabase.rpc(
      'close_payment_intent_for_settle',
      { p_intent_id: intentId, p_owner_ref: ownerRef, p_reported_usage: 0 },
    );
    if (error) mapPgError(error, 'close-session', false);
    const row = data?.[0];
    if (!row) throw new PaymentIntentError('INTENT_NOT_FOUND');

    const depositMicro = numericToMicro(row.authorized_usd);
    const consumedMicro = numericToMicro(row.consumed_usd);
    const consumedUsd = consumedMicro / 1_000_000;

    // Idempotencia (AC-1): ya cerrado/settled/failed → NO re-settlea.
    if (row.prev_status !== 'open') {
      const settledMicro = Math.min(consumedMicro, depositMicro);
      const residualMicro = Math.max(0, depositMicro - settledMicro);
      return {
        status: row.prev_status === 'failed' ? 'failed' : 'settled',
        txHash: row.settle_tx_hash,
        finalAmountUsd: settledMicro / 1_000_000,
        consumedUsd,
        residualUsd: residualMicro / 1_000_000,
      };
    }

    // Transición open→closing efectuada. final = min(consumed, deposit).
    const finalMicro = Math.min(consumedMicro, depositMicro);
    const residualMicro = Math.max(0, depositMicro - finalMicro); // AC-2, nunca negativo
    const finalUsd = finalMicro / 1_000_000;
    const residualUsd = residualMicro / 1_000_000;

    // Σvouchers = 0 → nada que cobrar al seller: full refund, sin tx on-chain.
    if (finalMicro <= 0) {
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        finalUsd,
        residualUsd,
        true,
        null,
      );
      return {
        status: 'settled',
        txHash: null,
        finalAmountUsd: 0,
        consumedUsd,
        residualUsd,
      };
    }

    const outcome = await settlePaymentIntentOnChain({
      intentId,
      ownerRef,
      payTo: row.pay_to,
      finalAmountUsd: finalUsd,
      chainId: row.chain_id,
    });

    if (outcome.status === 'settled') {
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        outcome.txHash,
        finalUsd,
        residualUsd,
        true,
        null,
      );
      return {
        status: 'settled',
        txHash: outcome.txHash,
        finalAmountUsd: finalUsd,
        consumedUsd,
        residualUsd,
      };
    }

    // Fallo del settle → failed, NO refund, NO tx (SG/finalize contract).
    await finalizePaymentIntent(
      intentId,
      ownerRef,
      null,
      finalUsd,
      null,
      false,
      outcome.error ?? 'settle failed',
    );
    return {
      status: 'failed',
      txHash: null,
      finalAmountUsd: finalUsd,
      consumedUsd,
      residualUsd: 0,
      error: outcome.error,
    };
  },

  /**
   * upto: crea el intent tras verificar el cap EIP-712 (anclado a funding_wallet).
   * NO reserva/debita. cap_nonce UNIQUE → anti-replay (23505 → CAP_SIGNATURE_INVALID).
   */
  async createUpto(
    input: CreateUptoInput,
  ): Promise<{ intentId: string; expiresAt: string }> {
    // 1. recuperar firmante (domain binding adentro).
    const recovered = await this.verifyCapSignature(
      input.typedData,
      input.capSignature,
    );
    // 2. firmante == funding_wallet (ancla EXCLUSIVA).
    if (recovered.toLowerCase() !== input.buyerWallet.toLowerCase()) {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
    // 3. el cap firmado DEBE coincidir con los params del request (anti-swap).
    const m = input.typedData.message;
    const capMicroSigned = decimalStringToMicroUsd(m.cap);
    if (
      capMicroSigned === null ||
      capMicroSigned !== Math.round(input.capUsd * 1_000_000) ||
      m.seller_ref !== input.sellerRef ||
      m.chain_id !== input.chainId ||
      m.nonce.toLowerCase() !== input.capNonce.toLowerCase()
    ) {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
    // 4. expires_at del cap firmado, en el futuro.
    const expiresAtMs = m.expires_at * 1000;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
    const expiresAt = new Date(expiresAtMs).toISOString();

    // 5. INSERT (upto NO debita). nonce colisión → replay.
    const { error } = await supabase.rpc('open_payment_intent', {
      p_id: input.intentId,
      p_intent_type: 'upto',
      p_owner_ref: input.ownerRef,
      p_key_id: input.keyId,
      p_buyer_wallet: input.buyerWallet,
      p_seller_ref: input.sellerRef,
      p_pay_to: input.payTo,
      p_chain_id: input.chainId,
      p_authorized_usd: input.capUsd,
      p_cap_signature: input.capSignature,
      p_cap_nonce: input.capNonce,
      p_expires_at: expiresAt,
    });
    if (error) mapPgError(error, 'create-upto', true);
    return { intentId: input.intentId, expiresAt };
  },

  /**
   * upto: settlea min(cap, reportedUsage) al seller (AC-3). Clampa al cap (nunca
   * rechaza, nunca > cap) + telemetría cap_exceeded. Idempotente (prev_status).
   */
  async settleUpto(
    intentId: string,
    ownerRef: string,
    reportedUsageUsd: number,
  ): Promise<SettleOutcome> {
    const { data, error } = await supabase.rpc(
      'close_payment_intent_for_settle',
      {
        p_intent_id: intentId,
        p_owner_ref: ownerRef,
        p_reported_usage: reportedUsageUsd,
      },
    );
    if (error) mapPgError(error, 'settle-upto', false);
    const row = data?.[0];
    if (!row) throw new PaymentIntentError('INTENT_NOT_FOUND');

    const capMicro = numericToMicro(row.authorized_usd);
    const reportedMicro = Math.max(0, Math.round(reportedUsageUsd * 1_000_000));
    const cappedAt = reportedMicro >= capMicro;
    if (reportedMicro > capMicro) {
      // SG-2: uso > cap → telemetría, se cobra exactamente el cap.
      log.warn(
        {
          intentId,
          capUsd: capMicro / 1_000_000,
          reportedUsd: reportedUsageUsd,
        },
        'cap_exceeded',
      );
    }

    // Idempotencia (AC-1): ya settleado → NO re-cobra.
    if (row.prev_status !== 'open') {
      const settledMicro = Math.min(capMicro, reportedMicro);
      return {
        status: row.prev_status === 'failed' ? 'failed' : 'settled',
        txHash: row.settle_tx_hash,
        finalAmountUsd: settledMicro / 1_000_000,
        cappedAt,
      };
    }

    const finalMicro = Math.min(capMicro, reportedMicro); // = row.final_amount (AC-3)
    const finalUsd = finalMicro / 1_000_000;

    // uso 0 → nada que cobrar: mark settled sin tx (upto NO refunda).
    if (finalMicro <= 0) {
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        finalUsd,
        null,
        true,
        null,
      );
      return { status: 'settled', txHash: null, finalAmountUsd: 0, cappedAt };
    }

    const outcome = await settlePaymentIntentOnChain({
      intentId,
      ownerRef,
      payTo: row.pay_to,
      finalAmountUsd: finalUsd,
      chainId: row.chain_id,
    });

    if (outcome.status === 'settled') {
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        outcome.txHash,
        finalUsd,
        null,
        true,
        null,
      );
      return {
        status: 'settled',
        txHash: outcome.txHash,
        finalAmountUsd: finalUsd,
        cappedAt,
      };
    }

    await finalizePaymentIntent(
      intentId,
      ownerRef,
      null,
      finalUsd,
      null,
      false,
      outcome.error ?? 'settle failed',
    );
    return {
      status: 'failed',
      txHash: null,
      finalAmountUsd: finalUsd,
      cappedAt,
      error: outcome.error,
    };
  },

  /**
   * AC-6: resuelve intents vencidos determinísticamente (auto-settle del
   * consumido + refund del residual para session; auto-settle 0 para upto sin
   * reporte). Barrido de sistema (cron): el owner guard usa el owner_ref de la
   * propia fila — NO es IDOR (mismo patrón que delegation.getParentKey).
   */
  async expireStale(): Promise<void> {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('a2a_payment_intents')
      .select('id, owner_ref, intent_type')
      .eq('status', 'open')
      .lt('expires_at', nowIso);
    if (error) {
      log.error({ detail: error.message }, 'expireStale query failed');
      return;
    }
    for (const stale of data ?? []) {
      try {
        if (stale.intent_type === 'session') {
          await this.closeSession(stale.id, stale.owner_ref);
        } else {
          await this.settleUpto(stale.id, stale.owner_ref, 0);
        }
      } catch (err) {
        log.warn(
          {
            intentId: stale.id,
            detail: err instanceof Error ? err.message : String(err),
          },
          'expireStale settle failed for intent',
        );
      }
    }
  },
};
