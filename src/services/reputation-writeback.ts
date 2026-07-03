/**
 * Reputation write-back service (WKH-133) — secuencia DT-5, at-most-once.
 *
 * Orquesta el write-back best-effort de reputación on-chain tras un evento
 * settleado con éxito. Se invoca fire-and-forget desde `event.ts::track()` (NO
 * awaited — CD-1: nunca bloquea /compose|/orchestrate|/a2a). NUNCA throw
 * (fail-open CD-3): cualquier error se loguea server-side con un código corto y
 * jamás marca el evento/settlement subyacente como `failed`.
 *
 * Secuencia (DT-5):
 *   gate → resolve agentId (binding verificado) → CLAIM idempotente ANTES de la
 *   tx (barrera anti-doble-gasto, CD-2) → tx (adapter writer) → persist status.
 *
 * La clave de idempotencia es `a2a_events.id` (UUID server-gen Postgres — NUNCA
 * un valor del body, CD-12). El claim usa `upsert(..., { onConflict:'event_id',
 * ignoreDuplicates:true }).select()` = `INSERT ... ON CONFLICT DO NOTHING
 * RETURNING`: si otra corrida ya reclamó el evento → 0 filas → return SIN tx.
 */
import { getBaseNetwork } from '../adapters/base/chain.js';
import { resolveReputationRegistryAddress } from '../adapters/erc8004-reputation.js';
import {
  erc8004ReputationWriter,
  isWritebackEnabled,
} from '../adapters/erc8004-reputation-writer.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import type { Database } from '../types/database.types.js';
import { identityService } from './identity.js';

const log = getLogger('reputation-writeback');

// Replicado (privado en erc8004-reputation.ts:136-138) — módulos separados (CD-7).
function expectedChainIdFor(network: 'mainnet' | 'testnet'): number {
  return network === 'mainnet' ? 8453 : 84532;
}

export interface WritebackEvent {
  id: string; // a2a_events.id (UUID server-gen — clave idempotencia, CD-12)
  eventType: string; // → tag2
  agentId: string | null; // = agent.slug (así lo puebla compose.ts / orchestrate.ts)
  status: 'success' | 'failed';
  costUsdc: number;
}

export const reputationWritebackService = {
  /**
   * Best-effort write-back de UN evento settleado. NUNCA throw (CD-3). Sin tx si:
   * flag OFF, evento no exitoso / costo <= 0, registry no configurado, agente sin
   * binding único, o evento ya reclamado (idempotencia).
   */
  async onSettledEvent(event: WritebackEvent): Promise<void> {
    try {
      // 1. GATE
      if (!isWritebackEnabled()) return; // CD-5 (default OFF)
      if (event.status !== 'success' || event.costUsdc <= 0) return; // AC-5 (paridad tasks_settled anti-sybil)
      const network = getBaseNetwork();
      if (!resolveReputationRegistryAddress(network)) return; // AC-2 skip silencioso
      const slug = event.agentId;
      if (!slug) return;
      const chainId = expectedChainIdFor(network);

      // 2. RESOLVE agentId on-chain (DT-6). 0/>1 match o sin binding → skip (CD-9).
      const onchainAgentId = await identityService.resolveErc8004AgentId(
        slug,
        chainId,
      );
      if (onchainAgentId === null) return;

      // 3. CLAIM idempotencia — ANTES de la tx (CD-2). ON CONFLICT DO NOTHING:
      //    con ignoreDuplicates el .select() devuelve SOLO las filas insertadas.
      //    0 filas → el evento ya fue reclamado → NO tx (anti-doble-gasto de gas).
      const claimRow: Database['public']['Tables']['a2a_reputation_writebacks']['Insert'] =
        {
          event_id: event.id,
          agent_slug: slug,
          onchain_agent_id: onchainAgentId.toString(),
          chain_id: chainId,
          status: 'pending',
        };
      const { data: claimed, error: claimErr } = await supabase
        .from('a2a_reputation_writebacks')
        .upsert(claimRow, { onConflict: 'event_id', ignoreDuplicates: true })
        .select();
      if (claimErr) {
        log.warn(
          { eventId: event.id, code: claimErr.code },
          '[ReputationWriteback] claim insert failed',
        );
        return;
      }
      if (!claimed || claimed.length === 0) return; // ya reclamado → sin tx

      // 4. TX (adapter writer — sin throw, devuelve resultado tipado).
      const result = await erc8004ReputationWriter.giveFeedback({
        agentId: onchainAgentId,
        value: 100n, // DT-7: señal positiva máxima por task pagada completada
        valueDecimals: 0,
        tag1: 'wasiai',
        tag2: event.eventType,
      });

      // 5. PERSIST — SOLO txHash puede persistirse (CD-6). En fallo: código corto
      //    (result.reason), NUNCA error.message crudo. Sin reintento sync (AC-4).
      if (result.ok) {
        await supabase
          .from('a2a_reputation_writebacks')
          .update({
            status: 'confirmed',
            tx_hash: result.txHash,
            updated_at: new Date().toISOString(),
          })
          .eq('event_id', event.id);
      } else {
        await supabase
          .from('a2a_reputation_writebacks')
          .update({
            status: 'failed',
            error_code: result.reason,
            updated_at: new Date().toISOString(),
          })
          .eq('event_id', event.id);
        log.warn(
          { eventId: event.id, reason: result.reason },
          '[ReputationWriteback] giveFeedback failed',
        );
      }
    } catch (err) {
      // Fail-open absoluto (CD-3): NUNCA propagar. Log server-side; sin pk,
      // sin error.message al caller (el logger scrubbea 0x64-hex — OP-11).
      log.error({ err }, '[ReputationWriteback] unexpected error');
    }
  },
};
