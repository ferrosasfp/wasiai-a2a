/**
 * Budget Service — A2A Agent Key budget management
 * WKH-34: Agentic Economy Primitives L3
 */

import { getLogger } from '../lib/logger.js';
import type { RefundIdem } from '../lib/refund-idem.js';
import { supabase } from '../lib/supabase.js';
import type { Database } from '../types/database.types.js';
import type {
  A2AAgentKeyRow,
  DelegationDebitContext,
  KeySessionDebitContext,
} from '../types/index.js';
import { delegationService, exceedsPerTxLimit } from './delegation.js';
import { keySessionService } from './key-session.js';
import { receiptService } from './receipt.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DelegationExpiredError,
  DelegationNotFoundError,
  DelegationRevokedError,
  DelegationTotalLimitExceededError,
  DepositAlreadyCreditedError,
  DestCapExceededError,
  InvalidDebitAmountError,
  logOwnershipMismatch,
  OwnershipMismatchError,
  SessionBudgetExhaustedError,
  SessionExpiredError,
  SessionTokenInvalidError,
} from './security/errors.js';

// ── Service ─────────────────────────────────────────────────

const log = getLogger('budget');

/**
 * WKH-234 (AC-8) — registro ADITIVO del CAIP-2 / firma del leg Solana en el
 * ledger de recibos. Best-effort, fire-and-forget (NUNCA afecta el flujo).
 * REUSA el `ownerRef` del caller autenticado (CD-1/AC-9) — no abre ninguna query
 * sobre `a2a_agent_keys`. Solo se invoca cuando el leg es Solana → sin efecto
 * para legs EVM (byte-idéntico).
 *
 * Fix-pack AR-BLQ-1 (2026-07-24): este emit se dispara POST-settle desde
 * `compose` (vía `budgetService.recordSolanaSettleReceipt`), NO desde `debit`.
 * Razón temporal: el `debit` per-step es fee-on-attempt (precede a
 * `invokeAgent`), pero la firma base58 del SPL-transfer sólo existe DESPUÉS del
 * settle downstream. Threadear la firma al `debit` pre-settle era imposible
 * (era la causa del falso-verde AC-8 detectado por el AR).
 */
function emitSolanaSettleReceipt(args: {
  keyId: string;
  ownerRef: string;
  chainId: number;
  amountUsd: number;
  settleCaip2: string;
  settleSignature: string | undefined;
}): void {
  receiptService
    .emit({
      ownerRef: args.ownerRef,
      agentKeyId: args.keyId,
      sessionId: null,
      delegationId: null,
      receiptType: 'budget_debit',
      amountUsd: args.amountUsd,
      chainId: args.chainId,
      txHash: args.settleSignature ?? null,
      counterparty: null,
      orchestrationId: null,
      settleCaip2: args.settleCaip2,
      settleSignature: args.settleSignature ?? null,
    })
    .catch((e) =>
      log.warn(
        { detail: e instanceof Error ? e.message : e },
        '[receipts] solana settle receipt emit failed',
      ),
    );
}

export const budgetService = {
  /**
   * Get balance for a specific chain. Returns "0" if no entry exists.
   */
  async getBalance(
    keyId: string,
    chainId: number,
    ownerId: string,
  ): Promise<string> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('budget')
      .eq('id', keyId)
      .eq('owner_ref', ownerId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        logOwnershipMismatch('getBalance', keyId, ownerId);
        throw new OwnershipMismatchError();
      }
      throw new Error(`Failed to get balance: ${error.message}`);
    }

    // M9: `budget` es jsonb (`Json` en el cliente tipado); el dominio lo modela
    // como `Record<string,string>`. Narrowing acotado SOLO al campo jsonb.
    const budget = (data.budget ?? {}) as A2AAgentKeyRow['budget'];
    return budget[chainId.toString()] ?? '0';
  },

  /**
   * Debit budget by calling the Postgres function increment_a2a_key_spend.
   * Returns success/failure with error code parsed from the PG exception.
   *
   * WKH-101 (DT-11): delegation-aware. Si `delegationContext` está presente, el
   * débito enruta al RPC atómico `debit_delegation_and_parent` (AC-7 per-step +
   * AC-8/AC-9). Cuando es undefined (master key), el camino actual queda intacto
   * (CD-5). El branch per-step (steps 2..N de compose) usa esta firma extendida.
   */
  async debit(
    keyId: string,
    chainId: number,
    amountUsd: number,
    // N5 (audit 2026-07-02): these three are now REQUIRED-but-nullable
    // (`T | undefined`, no `?`). TS forbids a required param after an optional
    // one (ts1016), and `ownerRef` MUST be required (below) — so callers pass
    // an explicit `undefined` here. Every production call-site already threads
    // all four positional args, so this is byte-compatible with prod.
    delegationContext: DelegationDebitContext | undefined,
    keySessionContext: KeySessionDebitContext | undefined,
    destination: string | undefined,
    // F-04 (audit 2026-06-29) / N5 (audit 2026-07-02): owner_ref of the
    // AUTHENTICATED caller, threaded from the call site
    // (compose/orchestrate/middleware). It is fed to the dest-aware / master
    // RPCs as the ownership guard datum. It is now REQUIRED (`string`, not
    // `string | undefined`): the previous optional signature carried a cold-path
    // SELECT (WHERE id=keyId, no owner_ref filter) that re-derived the target
    // row's OWN owner_ref and fed THAT to the RPC, making the OWNERSHIP_MISMATCH
    // guard tautological (owner compared against itself → never fails). Making
    // it required turns the type-checker into the safety net: any future
    // call-site that forgets to thread a real caller owner_ref FAILS tsc instead
    // of silently disabling the ownership guard.
    ownerRef: string,
  ): Promise<{ success: boolean; error?: string }> {
    // ── RUTA KEY-SESSION (WKH-121) ──
    // Espejo de la ruta delegación, sin per-tx limit (no aplica a sesiones).
    if (keySessionContext) {
      try {
        await keySessionService.debitSessionAndParent(
          keySessionContext.sessionId,
          keySessionContext.ownerRef,
          keySessionContext.keyId,
          chainId,
          amountUsd,
          destination,
        );
        // WKH-124: emit budget_debit receipt (best-effort, fire-and-forget CD-B).
        // A failure here NEVER affects the debit result (CD-1).
        receiptService
          .emit({
            ownerRef: keySessionContext.ownerRef,
            agentKeyId: keySessionContext.keyId,
            sessionId: keySessionContext.sessionId,
            delegationId: null,
            receiptType: 'budget_debit',
            amountUsd,
            chainId,
            txHash: null,
            counterparty: null,
            orchestrationId: null,
          })
          .catch((e) =>
            log.warn(
              { detail: e instanceof Error ? e.message : e },
              '[receipts] emit failed',
            ),
          );
        return { success: true };
      } catch (err) {
        // WKH-125 (AC-6): la sesión hereda el cap por destino de la parent key.
        if (err instanceof DestCapExceededError) {
          return { success: false, error: 'DEST_CAP_EXCEEDED' };
        }
        if (err instanceof SessionBudgetExhaustedError) {
          return { success: false, error: 'SESSION_BUDGET_EXHAUSTED' };
        }
        if (err instanceof SessionExpiredError) {
          return { success: false, error: 'SESSION_EXPIRED' };
        }
        if (err instanceof SessionTokenInvalidError) {
          return { success: false, error: 'SESSION_TOKEN_INVALID' };
        }
        if (err instanceof AgentKeyBudgetExhaustedError) {
          return { success: false, error: 'AGENT_KEY_BUDGET_EXHAUSTED' };
        }
        if (err instanceof DailyLimitExceededError) {
          return { success: false, error: 'DAILY_LIMIT' };
        }
        if (err instanceof AgentKeyInactiveError) {
          return { success: false, error: 'KEY_INACTIVE' };
        }
        if (err instanceof AgentKeyNotFoundError) {
          return { success: false, error: 'KEY_NOT_FOUND' };
        }
        if (err instanceof OwnershipMismatchError) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
        // WKH-142 (CD-8): importe NULL / negativo / NaN → code estable.
        if (err instanceof InvalidDebitAmountError) {
          return { success: false, error: 'DEBIT_INVALID_AMOUNT' };
        }
        // NO propagar `err.message` (mensaje crudo de Postgres) al cliente.
        log.error(
          {
            keyId,
            chainId,
            detail: err instanceof Error ? err.message : 'unknown',
          },
          'key-session debit failed',
        );
        return { success: false, error: 'SESSION_DEBIT_FAILED' };
      }
    }

    // ── RUTA DELEGACIÓN (DT-11) ──
    if (delegationContext) {
      // AC-7 PER-STEP: per-tx ANTES del RPC (no necesita lock).
      if (exceedsPerTxLimit(delegationContext.maxAmountPerTx, amountUsd)) {
        return { success: false, error: 'DELEGATION_TX_LIMIT_EXCEEDED' };
      }
      // AC-8 + AC-9 ATÓMICO: el RPC chequea+debita total_spent y parent budget.
      try {
        await delegationService.debitDelegationAndParent(
          delegationContext.delegationId,
          delegationContext.ownerRef,
          delegationContext.keyId,
          chainId,
          amountUsd,
          destination,
        );
        // WKH-124: emit budget_debit receipt (best-effort, fire-and-forget CD-B).
        // A failure here NEVER affects the debit result (CD-1).
        receiptService
          .emit({
            ownerRef: delegationContext.ownerRef,
            agentKeyId: delegationContext.keyId,
            sessionId: null,
            delegationId: delegationContext.delegationId,
            receiptType: 'budget_debit',
            amountUsd,
            chainId,
            txHash: null,
            counterparty: null,
            orchestrationId: null,
          })
          .catch((e) =>
            log.warn(
              { detail: e instanceof Error ? e.message : e },
              '[receipts] emit failed',
            ),
          );
        return { success: true };
      } catch (err) {
        // Mapear a { success:false, error:<code> } para que compose corte el
        // pipeline (mismo shape que la ruta master). NO re-lanzar.
        // WKH-125b: cap por destino excedido bajo delegación → code estable.
        if (err instanceof DestCapExceededError) {
          return { success: false, error: 'DEST_CAP_EXCEEDED' };
        }
        if (err instanceof DelegationTotalLimitExceededError) {
          return { success: false, error: 'DELEGATION_TOTAL_LIMIT_EXCEEDED' };
        }
        if (err instanceof AgentKeyBudgetExhaustedError) {
          return { success: false, error: 'AGENT_KEY_BUDGET_EXHAUSTED' };
        }
        if (err instanceof DelegationRevokedError) {
          return { success: false, error: 'DELEGATION_REVOKED' };
        }
        if (err instanceof DelegationExpiredError) {
          return { success: false, error: 'DELEGATION_EXPIRED' };
        }
        // AR-MNR-1: límites de la parent key bajo delegación → code estable 403.
        if (err instanceof DailyLimitExceededError) {
          return { success: false, error: 'DAILY_LIMIT' };
        }
        if (err instanceof AgentKeyInactiveError) {
          return { success: false, error: 'KEY_INACTIVE' };
        }
        if (err instanceof AgentKeyNotFoundError) {
          return { success: false, error: 'KEY_NOT_FOUND' };
        }
        if (err instanceof DelegationNotFoundError) {
          return { success: false, error: 'DELEGATION_NOT_FOUND' };
        }
        if (err instanceof OwnershipMismatchError) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
        // WKH-142 (CD-8): importe NULL / negativo / NaN → code estable.
        if (err instanceof InvalidDebitAmountError) {
          return { success: false, error: 'DEBIT_INVALID_AMOUNT' };
        }
        // AR-MNR-2: NO propagar `err.message` (mensaje crudo de Postgres) al
        // cliente. Devolver un error_code estable; el detalle va al log server.
        log.error(
          {
            keyId,
            chainId,
            detail: err instanceof Error ? err.message : 'unknown',
          },
          'delegation debit failed',
        );
        return { success: false, error: 'DELEGATION_DEBIT_FAILED' };
      }
    }

    // ── RUTA MASTER KEY DEST-AWARE (WKH-125) ──
    // Sólo cuando hay `destination` (call-site de compose/step-0). El RPC
    // `debit_with_dest_policy` es self-back-compat: si no hay política para el
    // destino, degrada a `increment_a2a_key_spend` + 0 inserts (CD-5/AC-5). El
    // check del cap + el debit + el INSERT del ledger ocurren en UNA tx con
    // FOR UPDATE (CD-1/AC-4). Nunca propaga el msg crudo de PG al cliente (CD-B).
    if (destination) {
      // F-04 (audit 2026-06-29) / N5 (audit 2026-07-02): the RPC validates
      // ownership DB-layer against `p_owner_ref`. We pass the AUTHENTICATED
      // caller's owner_ref (now a REQUIRED arg) directly so the guard compares
      // against the caller, not the target row. The former cold-path SELECT
      // (WHERE id=keyId, no owner_ref filter) was tautological and has been
      // removed — with `ownerRef` required it was unreachable dead code.
      const { error: destErr } = await supabase.rpc('debit_with_dest_policy', {
        p_key_id: keyId,
        p_chain_id: chainId,
        p_amount_usd: amountUsd,
        p_owner_ref: ownerRef,
        p_destination: destination,
      });

      if (destErr) {
        const msg = destErr.message;
        if (msg.includes('DEST_CAP_EXCEEDED')) {
          return { success: false, error: 'DEST_CAP_EXCEEDED' };
        }
        if (msg.includes('INSUFFICIENT_BUDGET')) {
          return { success: false, error: 'AGENT_KEY_BUDGET_EXHAUSTED' };
        }
        if (msg.includes('DAILY_LIMIT')) {
          return { success: false, error: 'DAILY_LIMIT' };
        }
        if (msg.includes('KEY_INACTIVE')) {
          return { success: false, error: 'KEY_INACTIVE' };
        }
        if (msg.includes('KEY_NOT_FOUND')) {
          return { success: false, error: 'KEY_NOT_FOUND' };
        }
        if (msg.includes('OWNERSHIP_MISMATCH')) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
        // WKH-142 (CD-8): importe NULL / negativo / NaN → code estable.
        if (msg.includes('INVALID_AMOUNT')) {
          return { success: false, error: 'DEBIT_INVALID_AMOUNT' };
        }
        // Fallback: el msg crudo de PG NUNCA llega al cliente (CD-B).
        log.error({ keyId, chainId, detail: msg }, 'dest-policy debit failed');
        return { success: false, error: 'DEST_POLICY_DEBIT_FAILED' };
      }

      return { success: true };
    }

    // ── RUTA MASTER KEY — owner guard DB-level (WKH-SEC-02b) ──
    // El RPC exige p_owner_ref. F-04 (audit 2026-06-29) / N5 (audit 2026-07-02):
    // usamos el owner_ref del caller AUTENTICADO (threaded, ahora REQUERIDO) para
    // que el guard compare contra el caller y no contra la fila objetivo. El
    // SELECT cold-path (tautológico) se eliminó — con `ownerRef` requerido era
    // dead code inalcanzable.
    const { error } = await supabase.rpc('increment_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
      p_owner_ref: ownerRef, // WKH-SEC-02b (AC-2) / F-04 / N5
    });

    if (error) {
      // CD-3/AC-6: no propagar el msg crudo de PG para OWNERSHIP_MISMATCH.
      // M5 (audit 2026-06-24): NUNCA propagar el msg crudo de PG al cliente
      // (info disclosure). Espejo del patrón dest-policy (L266-291): mapear los
      // códigos de negocio conocidos a códigos estables, y para cualquier otro
      // error PG inesperado devolver DEBIT_FAILED + log server-side.
      const msg = error.message;
      if (msg.includes('OWNERSHIP_MISMATCH')) {
        return { success: false, error: 'OWNERSHIP_MISMATCH' };
      }
      if (msg.includes('INSUFFICIENT_BUDGET')) {
        return { success: false, error: 'AGENT_KEY_BUDGET_EXHAUSTED' };
      }
      if (msg.includes('DAILY_LIMIT')) {
        return { success: false, error: 'DAILY_LIMIT' };
      }
      if (msg.includes('KEY_INACTIVE')) {
        return { success: false, error: 'KEY_INACTIVE' };
      }
      if (msg.includes('KEY_NOT_FOUND')) {
        return { success: false, error: 'KEY_NOT_FOUND' };
      }
      // WKH-142 (CD-8): importe NULL / negativo / NaN → code estable.
      if (msg.includes('INVALID_AMOUNT')) {
        return { success: false, error: 'DEBIT_INVALID_AMOUNT' };
      }
      log.error({ keyId, chainId, detail: msg }, 'master debit failed');
      return { success: false, error: 'DEBIT_FAILED' };
    }

    return { success: true };
  },

  /**
   * WKH-234 (AC-8) fix-pack AR-BLQ-1 — registra el CAIP-2 + firma base58 del leg
   * Solana en el ledger de recibos, de forma ADITIVA y best-effort. Lo invoca
   * `compose` DESPUÉS de un settle downstream Solana exitoso (cuando la firma ya
   * existe), reusando el `ownerRef` REQUERIDO del caller autenticado (CD-1/AC-9)
   * — sin abrir ninguna query sobre `a2a_agent_keys`. Para legs EVM `compose`
   * simplemente NO lo llama → columna NULL → byte-idéntico.
   */
  recordSolanaSettleReceipt(args: {
    keyId: string;
    ownerRef: string;
    chainId: number;
    amountUsd: number;
    settleCaip2: string;
    settleSignature: string | undefined;
  }): void {
    emitSolanaSettleReceipt(args);
  },

  /**
   * WKH-127 (AC-5/AC-6): credit-back atómico — refund del débito step-0 de
   * /orchestrate cuando el pipeline falla. Espejo INVERSO de la ruta master de
   * debit(): llama la RPC refund_a2a_key_spend (FOR UPDATE + ownership guard).
   * CD-10: ownerRef explícito (string, NO undefined) — el caller orchestrate ya
   * lo tiene en scopingKeyRow.owner_ref → evita el SELECT cold-path de debit().
   *
   * HU-194: `idem` es REQUERIDO. Con `idemKey` no nulo, la RPC dedupea el refund
   * LÓGICO del lado de Postgres (`a2a_refund_applications`): si el crédito ya se
   * aplicó (p. ej. commiteó y su respuesta se perdió), NO se vuelve a acreditar y
   * la RPC devuelve 1 → `reverted:true` (la plata está de vuelta). Ver
   * `lib/refund-idem.ts`.
   */
  async credit(
    keyId: string,
    chainId: number,
    amountUsd: number,
    ownerRef: string,
    idem: RefundIdem,
  ): Promise<{ success: boolean; error?: string; reverted?: boolean }> {
    const { data, error } = await supabase.rpc('refund_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
      p_owner_ref: ownerRef, // CD-4: ownership guard DB-level
      p_idem_key: idem.idemKey, // HU-194: dedup DB-level del refund lógico
    });

    if (error) {
      // CD-6: no propagar msg crudo de PG al cliente.
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        return { success: false, error: 'OWNERSHIP_MISMATCH' };
      }
      if (error.message.includes('KEY_NOT_FOUND')) {
        return { success: false, error: 'KEY_NOT_FOUND' };
      }
      // HU-194: misma clave con OTRO monto ⟹ reuso indebido de clave (bug), no
      // un reintento. La RPC no aplicó nada; el code estable deja rastro en
      // `last_error` del outbox para revisión manual (nunca acredita un monto
      // ambiguo).
      if (error.message.includes('REFUND_IDEM_AMOUNT_MISMATCH')) {
        return { success: false, error: 'REFUND_IDEM_AMOUNT_MISMATCH' };
      }
      log.error(
        { keyId, chainId, amountUsd, err: error.message },
        'refund failed',
      );
      return { success: false, error: 'REFUND_FAILED' };
    }

    // A2 (audit 2026-06-24): la RPC ahora devuelve el nº de filas revertidas.
    // 0 filas ⟹ el refund NO revirtió nada (no-op defensivo: amount <= 0). El
    // caller (retry adaptativo de compose) NO debe re-debitar si esto es false,
    // para no consumir budget dos veces. `success:true` + `reverted:true` solo
    // cuando la reversión fue real (>=1 fila).
    const reverted = typeof data === 'number' && data >= 1;
    if (!reverted) {
      return { success: false, error: 'REFUND_NOT_REVERTED', reverted: false };
    }

    return { success: true, reverted: true };
  },

  /**
   * WKH-129 (AC-1/AC-2): credit-back atómico CON reversión del dest-cap. Espejo de
   * credit() pero llama refund_with_dest_policy, que ADEMÁS de revertir budget +
   * daily_spent inserta la fila compensatoria negativa en a2a_key_dest_spend_ledger
   * (devuelve el headroom del cap por destino). Para el refund per-step de /compose
   * cuando el débito original pasó por debit_with_dest_policy (tenía destination).
   * CD-8: ownerRef explícito (string, NO undefined). destination YA normalizado por
   * el caller (normalizeDestination(`${registry}/${slug}`)).
   */
  async creditWithDest(
    keyId: string,
    chainId: number,
    amountUsd: number,
    ownerRef: string,
    destination: string,
    idem: RefundIdem,
  ): Promise<{ success: boolean; error?: string; reverted?: boolean }> {
    const { data, error } = await supabase.rpc('refund_with_dest_policy', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
      p_owner_ref: ownerRef, // CD-2/CD-8: ownership guard DB-level
      p_destination: destination, // misma forma normalizada que el débito
      p_idem_key: idem.idemKey, // HU-194: dedup DB-level del refund lógico
    });

    if (error) {
      // CD-7 (budget): no propagar msg crudo de PG al cliente.
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        return { success: false, error: 'OWNERSHIP_MISMATCH' };
      }
      if (error.message.includes('KEY_NOT_FOUND')) {
        return { success: false, error: 'KEY_NOT_FOUND' };
      }
      // HU-194: ver `credit`. Ya aplicada con otro monto ⟹ no aplicar nada.
      if (error.message.includes('REFUND_IDEM_AMOUNT_MISMATCH')) {
        return { success: false, error: 'REFUND_IDEM_AMOUNT_MISMATCH' };
      }
      log.error(
        { keyId, chainId, amountUsd, destination, err: error.message },
        'refund-with-dest failed',
      );
      return { success: false, error: 'REFUND_FAILED' };
    }

    // A2 (audit 2026-06-24): la RPC devuelve el nº de filas que efectivamente
    // revirtieron el dest-cap (ROW_COUNT del INSERT compensatorio en el ledger;
    // o del UPDATE del budget cuando NO hay política para el destino). 0 filas
    // ⟹ NO se revirtió el headroom del cap por destino (p. ej. mismatch de
    // destino → la fila compensatoria no se insertó). El retry adaptativo NO
    // debe re-debitar en ese caso: re-debitar consumiría el dest-cap dos veces.
    const reverted = typeof data === 'number' && data >= 1;
    if (!reverted) {
      log.error(
        { keyId, chainId, amountUsd, destination },
        'refund-with-dest NOT reverted (0 rows)',
      );
      return { success: false, error: 'REFUND_NOT_REVERTED', reverted: false };
    }

    return { success: true, reverted: true };
  },

  /**
   * M1 (audit 2026-07-01): DUAL-LEDGER credit-back bajo DELEGACIÓN. Espejo
   * INVERSO de `debitDelegationAndParent`: llama la RPC
   * `refund_delegation_and_parent`, que en UNA transacción (a) revierte el
   * parent (budget + daily_spent, y el dest-cap ledger si hubo destination con
   * política) y (b) decrementa `a2a_delegations.total_spent` (clamp a 0). Sin
   * esto, refundear vía `credit()`/`creditWithDest()` sólo tocaba el parent →
   * `total_spent` quedaba inflado con dinero reembolsado (self-DoS de la
   * delegación). Mismo contrato de retorno que `credit()`:
   * `reverted = data >= 1` ⟺ el refund del parent afectó filas.
   * `destination` es OPCIONAL — cuando está, debe ser la MISMA forma normalizada
   * que usó el débito (dispatch dest-aware simétrico).
   */
  async creditDelegation(
    delegationId: string,
    ownerRef: string,
    keyId: string,
    chainId: number,
    amountUsd: number,
    idem: RefundIdem,
    destination?: string,
  ): Promise<{ success: boolean; error?: string; reverted?: boolean }> {
    // CR NIT-1: `p_destination?: string` (SQL `DEFAULT NULL`). Under
    // exactOptionalPropertyTypes the key must be OMITTED (not set to undefined)
    // when absent → the SQL default (NULL) applies, equivalent to the old
    // explicit `null` — without the `as unknown as` double cast.
    const args: Database['public']['Functions']['refund_delegation_and_parent']['Args'] =
      {
        p_delegation_id: delegationId,
        p_owner_ref: ownerRef,
        p_key_id: keyId,
        p_chain_id: chainId,
        p_amount_usd: amountUsd,
        // HU-194: el claim vive en la RPC DUAL-LEDGER (la más externa) para que
        // un reintento no vuelva a decrementar `total_spent`.
        p_idem_key: idem.idemKey,
        ...(destination !== undefined && { p_destination: destination }),
      };
    const { data, error } = await supabase.rpc(
      'refund_delegation_and_parent',
      args,
    );
    if (error) {
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        return { success: false, error: 'OWNERSHIP_MISMATCH' };
      }
      if (
        error.message.includes('KEY_NOT_FOUND') ||
        error.message.includes('DELEGATION_NOT_FOUND')
      ) {
        return { success: false, error: 'KEY_NOT_FOUND' };
      }
      // HU-194: ver `credit`. Ya aplicada con otro monto ⟹ no aplicar nada.
      if (error.message.includes('REFUND_IDEM_AMOUNT_MISMATCH')) {
        return { success: false, error: 'REFUND_IDEM_AMOUNT_MISMATCH' };
      }
      log.error(
        { keyId, chainId, amountUsd, delegationId, err: error.message },
        'delegation refund failed',
      );
      return { success: false, error: 'REFUND_FAILED' };
    }
    const reverted = typeof data === 'number' && data >= 1;
    if (!reverted) {
      return { success: false, error: 'REFUND_NOT_REVERTED', reverted: false };
    }
    return { success: true, reverted: true };
  },

  /**
   * M1 (audit 2026-07-01): DUAL-LEDGER credit-back bajo KEY-SESSION. Espejo de
   * `creditDelegation` pero contra `a2a_key_sessions.spent_usd` vía la RPC
   * `refund_session_and_parent`. Mismo contrato de retorno / dispatch dest-aware.
   */
  async creditSession(
    sessionId: string,
    ownerRef: string,
    keyId: string,
    chainId: number,
    amountUsd: number,
    idem: RefundIdem,
    destination?: string,
  ): Promise<{ success: boolean; error?: string; reverted?: boolean }> {
    // CR NIT-1: `p_destination?: string` (SQL `DEFAULT NULL`). Under
    // exactOptionalPropertyTypes the key must be OMITTED (not set to undefined)
    // when absent → the SQL default (NULL) applies, equivalent to the old
    // explicit `null` — without the `as unknown as` double cast.
    const args: Database['public']['Functions']['refund_session_and_parent']['Args'] =
      {
        p_session_id: sessionId,
        p_owner_ref: ownerRef,
        p_key_id: keyId,
        p_chain_id: chainId,
        p_amount_usd: amountUsd,
        // HU-194: idem que creditDelegation — claim en la RPC dual-ledger.
        p_idem_key: idem.idemKey,
        ...(destination !== undefined && { p_destination: destination }),
      };
    const { data, error } = await supabase.rpc(
      'refund_session_and_parent',
      args,
    );
    if (error) {
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        return { success: false, error: 'OWNERSHIP_MISMATCH' };
      }
      if (
        error.message.includes('KEY_NOT_FOUND') ||
        error.message.includes('SESSION_NOT_FOUND')
      ) {
        return { success: false, error: 'KEY_NOT_FOUND' };
      }
      // HU-194: ver `credit`. Ya aplicada con otro monto ⟹ no aplicar nada.
      if (error.message.includes('REFUND_IDEM_AMOUNT_MISMATCH')) {
        return { success: false, error: 'REFUND_IDEM_AMOUNT_MISMATCH' };
      }
      log.error(
        { keyId, chainId, amountUsd, sessionId, err: error.message },
        'session refund failed',
      );
      return { success: false, error: 'REFUND_FAILED' };
    }
    const reverted = typeof data === 'number' && data >= 1;
    if (!reverted) {
      return { success: false, error: 'REFUND_NOT_REVERTED', reverted: false };
    }
    return { success: true, reverted: true };
  },

  /**
   * Register a deposit: atomically increment budget for a chain (WKH-35 v2).
   * Uses Postgres function register_a2a_key_deposit v2 with FOR UPDATE +
   * UNIQUE(chain_id, tx_hash) for atomic anti-replay (CD-2) and a DB-level
   * Ownership Guard (CD-1). The verified `amountUsd` (derived on-chain) is
   * credited, never the caller-declared amount (CD-4 — enforced at call-site).
   * Returns the new balance as a string.
   */
  async registerDeposit(
    keyId: string,
    chainId: number,
    amountUsd: string,
    ownerId: string,
    txHash: string,
    token?: string,
  ): Promise<string> {
    // M9: el tipo generado declara `p_token?: string` (no captura que la SQL fn
    // acepta NULL — `p_token TEXT DEFAULT NULL`). Narrowing acotado al objeto de
    // args para preservar el envío explícito de `null` (contrato AC-10) sin
    // alterar el payload.
    const depositArgs: Database['public']['Functions']['register_a2a_key_deposit']['Args'] =
      {
        p_key_id: keyId,
        p_chain_id: chainId,
        p_amount_usd: parseFloat(amountUsd),
        p_owner_ref: ownerId,
        p_tx_hash: txHash,
        p_token: token ?? null,
      } as unknown as Database['public']['Functions']['register_a2a_key_deposit']['Args'];
    const { data, error } = await supabase.rpc(
      'register_a2a_key_deposit',
      depositArgs,
    );

    if (error) {
      // PG fn v2 mapea condiciones de negocio a RAISE EXCEPTION con prefijos
      // estables; los traducimos a error classes tipadas (CD-2 / CD-1).
      if (error.message.includes('DEPOSIT_ALREADY_CREDITED')) {
        throw new DepositAlreadyCreditedError();
      }
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        logOwnershipMismatch('getBalance', keyId, ownerId);
        throw new OwnershipMismatchError();
      }
      throw new Error(`Failed to register deposit: ${error.message}`);
    }

    return data as string;
  },
};
