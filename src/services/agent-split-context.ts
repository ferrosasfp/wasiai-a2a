/**
 * Agent Split Context — WKH-143 (DT-3/CD-10)
 *
 * Resuelve, SERVER-SIDE y best-effort, el contexto de creator/referral del
 * agente primario de un pipeline para alimentar los splits del protocol fee.
 *
 * Reglas críticas:
 *   - CD-10: best-effort. Cualquier error (query, narrowing) → log + `{null,null}`.
 *     NUNCA propaga: un fallo de resolución degrada a "sin creator" (AC-4), no
 *     rompe el charge ni el 200 (no reintroduce BLQ-MED-1 desde el call-site).
 *   - CD-2: NO revalida wallets. Pasa `payTo`/`payout_wallet` crudos; el único
 *     juez es `isValidWallet` dentro de `resolveRecipients` (SG-6).
 *   - CD-5: self-published lee `payout_wallet`/`owner_ref` SOLO vía
 *     `getSplitContextRow` (nunca por un shape público).
 *   - DT-6: `referral` es SIEMPRE `null` en v1 (el mecanismo `referrer_ref →
 *     wallet` es Scope OUT).
 */

import { getLogger } from '../lib/logger.js';
import type { Agent } from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_ID } from '../types/index.js';
import { publishedAgentService } from './agent.js';
import type { SplitPartyRef } from './fee-split.js';

const log = getLogger('agent-split-context');

/**
 * Devuelve `{ creator, referral }` para el agente primario (`steps[0].agent`).
 *
 * - `!agent` (pipeline vacío, AC-7) → `{ creator: null, referral: null }`.
 * - self-published → `getSplitContextRow(slug)`; `creator` = `payout_wallet`
 *   con `ownerRef = row.owner_ref` (AC-3), o `null` si no hay payout wallet.
 * - registry externo → `metadata.payTo` (fallback `metadata.payment.contract`,
 *   mismo criterio que `compose.ts:791-801`); `ownerRef = agent.slug` (AC-2/DT-8).
 * - `referral` SIEMPRE `null` en v1 (DT-6).
 */
export async function resolveAgentSplitContext(
  agent: Agent | undefined,
): Promise<{ creator: SplitPartyRef | null; referral: SplitPartyRef | null }> {
  if (!agent) return { creator: null, referral: null };

  try {
    if (agent.registry_id === SELF_PUBLISHED_REGISTRY_ID) {
      const row = await publishedAgentService.getSplitContextRow(agent.slug);
      const creator: SplitPartyRef | null = row?.payoutWallet
        ? { wallet: row.payoutWallet, ownerRef: row.ownerRef }
        : null;
      return { creator, referral: null };
    }

    // Registry externo: mismo criterio de resolución de wallet que
    // `compose.ts:791-801` (CD-2). NO revalida — `isValidWallet` en
    // `resolveRecipients` es el único juez.
    const meta = agent.metadata as Record<string, unknown> | undefined;
    const canonicalPayTo =
      typeof meta?.payTo === 'string' ? meta.payTo : undefined;
    const fallbackPayment = meta?.payment as
      | Record<string, unknown>
      | undefined;
    const fallbackPayTo =
      typeof fallbackPayment?.contract === 'string'
        ? fallbackPayment.contract
        : undefined;
    const payTo = canonicalPayTo ?? fallbackPayTo;

    const creator: SplitPartyRef | null = payTo
      ? { wallet: payTo, ownerRef: agent.slug }
      : null;
    return { creator, referral: null };
  } catch (err) {
    // CD-10: best-effort — cualquier fallo degrada a "sin creator".
    const detail = err instanceof Error ? err.message : String(err);
    log.error(
      { slug: agent.slug, detail },
      'resolveAgentSplitContext failed; falling back to no creator/referral',
    );
    return { creator: null, referral: null };
  }
}
