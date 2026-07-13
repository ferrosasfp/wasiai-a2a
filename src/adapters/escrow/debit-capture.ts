/**
 * Captura + validación + persistencia de la firma EIP-712 `DebitAuthorization`
 * del buyer — WKH-191a (Wave 0 del epic non-custodial WKH-191).
 *
 * La firma capturada es INERTE: se recibe en el body del close/settle, se recupera
 * el firmante reusando `eip712.ts` (CD-5), se valida contra el monto server-computado
 * y el `buyer_wallet` del intent, y se persiste (valid/invalid + motivo) para que
 * 191b (rewire real) la consuma. NADA on-chain se dispara acá (CD-3/CD-7/AC-4):
 * cero `escrow.debit()` / `writeContract`.
 *
 * Doble gate del flag `ESCROW_DEBIT_CAPTURE_ENABLED` (CD-1): el route no lee los
 * campos `debit*` con el flag OFF (gate primario); `captureDebitSignatureBestEffort`
 * re-chequea `isDebitCaptureEnabled()` (gate secundario). Con OFF → byte-idéntico.
 *
 * `captureDebitSignatureBestEffort` es no-throw garantizado (CD-2/CD-S2): corre en
 * el hilo del settle y NUNCA re-lanza — el settle jamás se altera/bloquea por la
 * captura.
 */

import { keccak256, parseUnits, stringToBytes } from 'viem';
import { getLogger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { resolveEscrowContract } from '../escrow-verifier.js';
import { getAdaptersBundle, getDefaultChainKey } from '../registry.js';
import { buildDebitDomain, recoverDebitAuthorization } from './eip712.js';

const log = getLogger('debit-capture');

export type DebitValidationReason =
  | 'AMOUNT_MISMATCH'
  | 'SIGNER_MISMATCH'
  | 'DEADLINE_EXPIRED'
  | 'DEADLINE_TOO_FAR'
  | 'NONCE_ALREADY_USED'
  | 'MALFORMED_INPUT';

/** Campos opcionales que el cliente somete en el body del close/settle. */
export interface DebitCaptureInput {
  signature: string; // 0x-hex
  nonce?: string; // decimal uint256 en string (bigint, sin float)
  deadline?: number; // epoch seconds (entero)
  amount?: string; // decimal uint256 atómico en string (DT-3b)
}

export interface CaptureDebitArgs {
  intentId: string;
  ownerRef: string;
  keyId: string; // intent.key_id (uuid) — == row.key_id del close RPC
  chainId: number; // row.chain_id (domain EIP-712)
  finalAmountUsd: number; // monto server-computado (min(Σvouchers,deposit) / min(cap,uso))
  capture: DebitCaptureInput;
}

// Espejo de WasiAIEscrow.MAX_DEADLINE_TTL = 1 hours (WasiAIEscrow.sol:45).
const MAX_DEADLINE_TTL_SECONDS = 3600n;

export function isDebitCaptureEnabled(): boolean {
  return process.env.ESCROW_DEBIT_CAPTURE_ENABLED === 'true';
}

/**
 * Persiste la firma `DebitAuthorization` (valid/invalid + motivo). NO responde
 * ningún request (CD-S2): solo captura + valida + persiste. NUNCA invoca
 * `escrow.debit()` / `writeContract` (CD-3/CD-7/AC-4).
 */
export async function captureDebitSignature(
  args: CaptureDebitArgs,
): Promise<void> {
  const { intentId, ownerRef, keyId, chainId, finalAmountUsd, capture } = args;

  // 1. Gate escrow: registro no init o chain sin contrato escrow → NO persistir
  //    (AC-3, byte-idéntico al comportamiento actual — not_applicable conceptual).
  const chainKey = getDefaultChainKey();
  if (!chainKey) return;
  const verifyingContract = resolveEscrowContract(chainKey);
  if (!verifyingContract) return;

  // 2. Bundle / decimals del token escrow (NUNCA literal 18 / NUNCA usdToWei).
  const bundle = getAdaptersBundle(chainKey);
  const token = bundle?.payment.supportedTokens[0];
  if (!token) {
    log.warn({ intentId }, 'debit capture: no supported token for chain, skip');
    return;
  }
  const decimals = token.decimals;

  // 3. Derivar server-side (CD-S1): keyId canónico + monto atómico server-computado.
  const keyIdHash = keccak256(stringToBytes(keyId));
  const serverAmountAtomic = parseUnits(finalAmountUsd.toString(), decimals);

  // 4. Parseo defensivo del body (CD-S5): campo faltante o malformado → MALFORMED_INPUT.
  let nonce: bigint;
  let deadline: bigint;
  let clientAmount: bigint;
  try {
    if (
      capture.nonce === undefined ||
      capture.deadline === undefined ||
      capture.amount === undefined
    ) {
      throw new Error('missing debit field');
    }
    nonce = BigInt(capture.nonce);
    deadline = BigInt(capture.deadline);
    clientAmount = BigInt(capture.amount);
  } catch {
    await persist(args, {
      keyIdHash,
      amountAtomic: serverAmountAtomic,
      deadline: 0n,
      nonce: 0n,
      recovered: null,
      status: 'invalid',
      reason: 'MALFORMED_INPUT',
    });
    return;
  }

  // 5. Leer buyer_wallet owner-guarded (CD-6). El RPC re-verifica ownership en la
  //    persistencia; esta lectura es el ancla del firmante.
  let buyerWallet: string | null = null;
  const { data: intentRow, error: readErr } = await supabase
    .from('a2a_payment_intents')
    .select('buyer_wallet')
    .eq('id', intentId)
    .eq('owner_ref', ownerRef)
    .maybeSingle();
  if (!readErr && intentRow) {
    buyerWallet = intentRow.buyer_wallet;
  }

  // 6. Recover: se reconstruye con clientAmount (lo que el cliente dice haber
  //    firmado) para distinguir SIGNER_MISMATCH de AMOUNT_MISMATCH (AC-2).
  const recovered = await recoverDebitAuthorization({
    domain: buildDebitDomain(chainId, verifyingContract),
    message: { keyId: keyIdHash, amount: clientAmount, deadline, nonce },
    signature: capture.signature,
  });

  // 7. Status/reason — prioridad EXACTA (espejo _verifyAndConsume).
  const now = BigInt(Math.floor(Date.now() / 1000));
  let status: 'valid' | 'invalid';
  let reason: DebitValidationReason | null;
  if (now > deadline) {
    status = 'invalid';
    reason = 'DEADLINE_EXPIRED'; // AC-6, espejo sol:125
  } else if (deadline > now + MAX_DEADLINE_TTL_SECONDS) {
    status = 'invalid';
    reason = 'DEADLINE_TOO_FAR'; // R-2, converge sol:127
  } else if (
    recovered === null ||
    buyerWallet === null ||
    recovered.toLowerCase() !== buyerWallet.toLowerCase()
  ) {
    status = 'invalid';
    reason = 'SIGNER_MISMATCH'; // AC-2, espejo sol:134
  } else if (clientAmount !== serverAmountAtomic) {
    status = 'invalid';
    reason = 'AMOUNT_MISMATCH'; // AC-2
  } else {
    status = 'valid';
    reason = null;
  }

  // 8. Persistir vía RPC (puede degradar a NONCE_ALREADY_USED, AC-5).
  await persist(args, {
    keyIdHash,
    amountAtomic: clientAmount,
    deadline,
    nonce,
    recovered,
    status,
    reason,
  });
}

async function persist(
  args: CaptureDebitArgs,
  fields: {
    keyIdHash: `0x${string}`;
    amountAtomic: bigint;
    deadline: bigint;
    nonce: bigint;
    recovered: `0x${string}` | null;
    status: 'valid' | 'invalid';
    reason: DebitValidationReason | null;
  },
): Promise<void> {
  const { data, error } = await supabase.rpc('capture_debit_signature', {
    p_intent_id: args.intentId,
    p_owner_ref: args.ownerRef,
    p_key_id: args.keyId,
    p_key_id_hash: fields.keyIdHash,
    p_amount_atomic: fields.amountAtomic.toString(),
    p_deadline: Number(fields.deadline),
    p_nonce: fields.nonce.toString(),
    p_signature: args.capture.signature,
    p_recovered: fields.recovered,
    p_status: fields.status,
    p_reason: fields.reason,
  });
  if (error) throw error; // lo atrapa captureDebitSignatureBestEffort (CD-2)
  const persisted = data?.[0];
  if (persisted && persisted.persisted_status !== fields.status) {
    // degradación DB (p.ej. NONCE_ALREADY_USED por carrera) — telemetría.
    log.info(
      {
        intentId: args.intentId,
        status: persisted.persisted_status,
        reason: persisted.persisted_reason,
      },
      'debit signature persisted with degraded verdict',
    );
  }
}

/**
 * Wrapper no-throw (CD-2/R-4): corre en el hilo del settle. Gate secundario del
 * flag (CD-1). NUNCA re-lanza — cualquier error se `log.warn` y se descarta, para
 * que la captura jamás altere/bloquee el close/settle.
 */
export async function captureDebitSignatureBestEffort(
  args: CaptureDebitArgs,
): Promise<void> {
  if (!isDebitCaptureEnabled()) return; // gate secundario (CD-1)
  try {
    await captureDebitSignature(args);
  } catch (err) {
    log.warn(
      {
        intentId: args.intentId,
        detail: err instanceof Error ? err.message : 'unknown',
      },
      'debit signature capture failed (best-effort, discarded)',
    );
  }
}
