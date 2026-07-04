/**
 * Agent Link Service — WKH-137 (invocation links: mint + redeem).
 *
 * Una primitiva nueva: un token opaco single-use, price-capped, atado a un
 * agente-target + al owner_ref/key del minter. El caller master lo mintea
 * (`mint`); cualquier canal externo lo redime (`redeem`) por posesión del token.
 * El redeem REUSA el money-path existente (`executeApprovedPlan` +
 * `resolveAgentPriceUsdc`) — NO reinventa settle/fee/receipt/refund. La única
 * pieza nueva de dinero es el status-gate atómico del single-use (RPC
 * `claim_agent_link` / `settle_agent_link`, FOR UPDATE + status-gate).
 *
 * Atomicidad (CD-4): el claim open→redeeming ocurre DENTRO del RPC bajo FOR
 * UPDATE. N redeems concurrentes → exactamente 1 invoca+cobra; el resto pierde
 * el lock-race → LINK_ALREADY_USED. El settle es exactly-once (status-gated).
 */

import crypto from 'node:crypto';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { asAgentKeyRow } from '../types/a2a-key.js';
import type { Database } from '../types/database.types.js';
import type {
  A2AAgentKeyRow,
  AgentLinkClaim,
  AgentLinkRow,
  CreateAgentLinkInput,
  MintAgentLinkResponse,
  OrchestratePlanResult,
  OrchestrateResult,
  RedeemResult,
} from '../types/index.js';
import { resolveAgentPriceUsdc } from './agent-price.js';
import { getProtocolFeeRate } from './fee-charge.js';
import { orchestrateService } from './orchestrate.js';
import { OwnershipMismatchError } from './security/errors.js';

const log = getLogger('agent-link');

/** Prefijo del token opaco de invocation link (CD-OBL-1). */
export const AGENT_LINK_TOKEN_PREFIX = 'wasi_a2a_link_';

const POSITIVE_DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Slug reservado por el router (DT-7): `POST /links/:token/redeem` tiene
 *  precedencia estática sobre `POST /:slug/link`. */
const RESERVED_SLUG = 'links';

// ── Error classes (mapean a HTTP en el route) ───────────────────

/** Input semánticamente inválido (maxPriceUsdc/ttl); 400 INVALID_INPUT. */
export class InvalidAgentLinkInputError extends Error {
  readonly code = 'INVALID_INPUT' as const;
  constructor() {
    super('Invalid agent-link input');
    this.name = 'InvalidAgentLinkInputError';
  }
}

/** slug === 'links' (reserva del router, DT-7); 400 SLUG_RESERVED. */
export class SlugReservedError extends Error {
  readonly code = 'SLUG_RESERVED' as const;
  constructor() {
    super('Slug is reserved');
    this.name = 'SlugReservedError';
  }
}

/** Token inexistente; 404 LINK_NOT_FOUND. */
export class AgentLinkNotFoundError extends Error {
  readonly code = 'LINK_NOT_FOUND' as const;
  constructor() {
    super('Link not found');
    this.name = 'AgentLinkNotFoundError';
  }
}

/** Token expirado; 410 LINK_EXPIRED. */
export class AgentLinkExpiredError extends Error {
  readonly code = 'LINK_EXPIRED' as const;
  constructor() {
    super('Link expired');
    this.name = 'AgentLinkExpiredError';
  }
}

/** Token ya usado / en uso (race concurrente); 409 LINK_ALREADY_USED. */
export class AgentLinkAlreadyUsedError extends Error {
  readonly code = 'LINK_ALREADY_USED' as const;
  constructor() {
    super('Link already used');
    this.name = 'AgentLinkAlreadyUsedError';
  }
}

/** Precio server-side > cap del link; 409 PRICE_EXCEEDS_LINK_CAP. */
export class PriceExceedsLinkCapError extends Error {
  readonly code = 'PRICE_EXCEEDS_LINK_CAP' as const;
  constructor() {
    super('Price exceeds link cap');
    this.name = 'PriceExceedsLinkCapError';
  }
}

/** Agente-target inexistente (resolveAgentPriceUsdc → null); 404 AGENT_NOT_FOUND. */
export class AgentNotFoundError extends Error {
  readonly code = 'AGENT_NOT_FOUND' as const;
  constructor() {
    super('Agent not found');
    this.name = 'AgentNotFoundError';
  }
}

/**
 * MNR-a: el execute retornó gracefully con `pipeline.success===false` y CERO
 * débito (fondos insuficientes del owner / net-zero). El link NO se consume: se
 * hace `reopen` (vuelve a 'open', como __quoteStale) y se devuelve un error claro
 * en vez de un 200 ambiguo con `answer:null`. Retryable → 503. */
export class AgentLinkExecutionUnavailableError extends Error {
  readonly code = 'LINK_EXECUTION_UNAVAILABLE' as const;
  constructor() {
    super('Link execution unavailable (no funds / net-zero)');
    this.name = 'AgentLinkExecutionUnavailableError';
  }
}

/** Mapea el `OrchestrateResult` interno al shape público acotado del redeem
 *  (BLQ-1). Elimina toda telemetría de billing del owner. */
function toRedeemResult(result: OrchestrateResult): RedeemResult {
  return {
    orchestrationId: result.orchestrationId,
    answer: result.answer,
    protocolFeeUsdc: result.protocolFeeUsdc,
    pipeline: {
      success: result.pipeline.success,
      output: result.pipeline.output,
    },
  };
}

/**
 * TTL máximo aceptado. Lee env con fail-safe: NaN o `<= 0` → default 86400
 * (espejo de `maxTtlSeconds` en key-session.ts).
 */
function maxTtlSeconds(): number {
  const v = Number(process.env.LINK_MAX_TTL_SECONDS ?? 86400);
  return Number.isFinite(v) && v > 0 ? v : 86400;
}

/** `true` si `v` es un decimal `> 0` (string canónico, sin signo ni notación). */
function isPositiveDecimalAmount(v: string): boolean {
  if (!POSITIVE_DECIMAL_RE.test(v)) return false;
  return Number.parseFloat(v) > 0;
}

export const agentLinkService = {
  /**
   * Mintea un invocation link (AC-1). El handler ya autenticó la master key.
   * Valida slug reservado + maxPriceUsdc + ttl ANTES del INSERT; genera token
   * opaco + hash y persiste SOLO el hash (CD-1). `owner_ref`/`key_id` salen de
   * `minterKey` y `slug` del path — NUNCA del request.
   */
  async mint(
    minterKey: A2AAgentKeyRow,
    slug: string,
    input: CreateAgentLinkInput,
    chainId: number,
  ): Promise<MintAgentLinkResponse> {
    // DT-7: el slug `links` colisiona con la ruta estática del redeem.
    if (slug === RESERVED_SLUG) {
      throw new SlugReservedError();
    }

    // maxPriceUsdc: decimal > 0 (CD-3, el cap server-side).
    if (
      typeof input.maxPriceUsdc !== 'string' ||
      !isPositiveDecimalAmount(input.maxPriceUsdc)
    ) {
      throw new InvalidAgentLinkInputError();
    }

    // ttlSeconds: opcional; si presente entero > 0 y <= maxTtlSeconds().
    let ttl = maxTtlSeconds();
    if (input.ttlSeconds !== undefined) {
      if (
        typeof input.ttlSeconds !== 'number' ||
        !Number.isInteger(input.ttlSeconds) ||
        input.ttlSeconds <= 0 ||
        input.ttlSeconds > maxTtlSeconds()
      ) {
        throw new InvalidAgentLinkInputError();
      }
      ttl = input.ttlSeconds;
    }

    const expiresAtIso = new Date(Date.now() + ttl * 1000).toISOString();

    // Token opaco + hash (CD-OBL-1). Solo el hash se persiste (CD-1).
    const token = `${AGENT_LINK_TOKEN_PREFIX}${crypto
      .randomBytes(48)
      .toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // INSERT. owner_ref/key_id desde minterKey; slug del path (NUNCA del request).
    // max_price_usdc es NUMERIC: la columna acepta el string decimal sin pérdida;
    // el tipo generado lo declara `number` → narrowing acotado (key-session.ts:221).
    const row: Database['public']['Tables']['a2a_agent_links']['Insert'] = {
      token_hash: tokenHash,
      owner_ref: minterKey.owner_ref,
      key_id: minterKey.id,
      slug,
      max_price_usdc: input.maxPriceUsdc as unknown as number,
      chain_id: chainId,
      expires_at: expiresAtIso,
    };

    const { data, error } = await supabase
      .from('a2a_agent_links')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to mint agent link: ${error.message}`);
    }

    return {
      link_id: data.id,
      token, // plano, SOLO acá (nunca se vuelve a exponer)
      slug,
      max_price_usdc: input.maxPriceUsdc,
      expires_at: expiresAtIso,
    };
  },

  /**
   * Lookup del hot path por hash del token.
   * NOTA PARA AR-CR: NO lleva .eq('owner_ref', ...) a propósito — el caller se
   * autentica CON el token; el owner se deriva del row. ÚNICA fn del mint/redeem
   * sin owner gate. NO es IDOR. PGRST116 → null.
   */
  async lookupByTokenHash(hash: string): Promise<AgentLinkRow | null> {
    const { data, error } = await supabase
      .from('a2a_agent_links')
      .select('*')
      .eq('token_hash', hash)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to lookup agent link: ${error.message}`);
    }

    // NUMERIC llega como string en runtime aunque el tipo generado lo declare
    // number; el shape de dominio (AgentLinkRow) usa string (M9 narrowing).
    return data as unknown as AgentLinkRow;
  },

  /**
   * Carga la key billable del link (server-side, sin owner gate: el keyId sale
   * del row del link que autenticó con el token, no del request). NO es IDOR.
   * PGRST116 → null (patrón getParentKey key-session.ts:283).
   */
  async getKeyById(keyId: string): Promise<A2AAgentKeyRow | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('*')
      .eq('id', keyId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to load link key: ${error.message}`);
    }

    return asAgentKeyRow(data);
  },

  /**
   * Redime un invocation link (AC-2/AC-6). Autenticado por posesión del `token`.
   * Flujo:
   *   1. lookup pre-claim (fail-fast sin DB write: not-found/used/expired).
   *   2. resolveAgentPriceUsdc (server-side, forceRefresh) → cap-gate pre-claim.
   *   3. claim atómico (open→redeeming, FOR UPDATE) — single-use (CD-4).
   *   4. plan de 1 step → executeApprovedPlan CAPEADO a max_price_usdc (CD-3/CD-4).
   *   5. settle exactly-once: redeemed | reopen(__quoteStale, cero débito) |
   *      failed(throw, terminal, CD-8).
   * El link NUNCA debita/settlea/refunda por su cuenta (CD-5).
   */
  async redeem(
    token: string,
    redeemInput: Record<string, unknown>,
  ): Promise<RedeemResult> {
    const hash = crypto.createHash('sha256').update(token).digest('hex');

    // 1. Pre-claim fast-fail (cero DB write, AC-4).
    const link = await this.lookupByTokenHash(hash);
    if (link === null) {
      throw new AgentLinkNotFoundError();
    }
    if (link.status !== 'open') {
      throw new AgentLinkAlreadyUsedError();
    }
    if (Date.now() >= new Date(link.expires_at).getTime()) {
      throw new AgentLinkExpiredError();
    }

    // 2. Precio server-side (forceRefresh) + cap-gate pre-claim (AC-3/CD-3).
    const price = await resolveAgentPriceUsdc(
      link.slug,
      link.registry ?? undefined,
      true,
    );
    if (price === null) {
      throw new AgentNotFoundError();
    }
    if (price > Number(link.max_price_usdc)) {
      throw new PriceExceedsLinkCapError(); // pre-claim: cero DB write, link sigue 'open'
    }

    // 3. Claim atómico (open→redeeming, CD-4). El row viene del RPC bajo FOR UPDATE.
    const claim = await this.claimAtomic(hash);

    // 4+5. Invocar bajo el owner/key del link, capeado; settle exactly-once.
    let ownerKey: A2AAgentKeyRow | null = null;
    try {
      ownerKey = await this.getKeyById(claim.key_id);
      if (ownerKey === null) {
        // Débito ambiguo NO ocurrió (nunca llegamos a execute), pero la key
        // billable no existe → tratamos como fallo terminal (CD-8).
        throw new Error('AGENT_LINK_REDEEM_FAILED: link key missing');
      }

      const orchestrationId = crypto.randomUUID();
      const step: OrchestratePlanResult['steps'][number] = {
        agent: claim.slug,
        input: redeemInput,
        // CD-9 (exactOptionalPropertyTypes): NO poner `registry: undefined`.
        ...(claim.registry ? { registry: claim.registry } : {}),
      };
      const feeRate = getProtocolFeeRate();
      const protocolFeeUsdc = Number((price * feeRate).toFixed(6));
      const cap = Number(claim.max_price_usdc);

      const plan: OrchestratePlanResult = {
        orchestrationId,
        planStatus: 'ready',
        steps: [step],
        costPerStep: [price],
        totalCostUsdc: price,
        protocolFeeUsdc,
        maxQuotedCostUsdc: cap,
        reasoning: 'redeem: single-step plan',
        consideredAgents: [],
        plannedCostUsd: price,
        feeUsdc: protocolFeeUsdc,
        usedFallback: false,
        debitFallback: false,
        billingKeyRow: ownerKey,
        discoveredAgents: [],
      };

      const result = await orchestrateService.executeApprovedPlan(
        {
          goal: '',
          budget: cap,
          scopingKeyRow: ownerKey,
          delegationContext: undefined,
          keySessionContext: undefined,
          chainId: claim.chain_id,
          maxQuotedCostUsdc: cap,
        },
        plan,
        orchestrationId,
      );

      // Drift > cap post-claim → cero débito garantizado por el cap-gate del
      // execute (CD-NEW-3/CD-8): reopen (link vuelve a 'open') y 409.
      if ('__quoteStale' in result) {
        await this.settle(
          claim.id,
          claim.owner_ref,
          'reopen',
          null,
          null,
          null,
        );
        throw new PriceExceedsLinkCapError();
      }

      // MNR-a: execute retornó gracefully con `pipeline.success===false` y CERO
      // débito (fondos insuficientes del owner / net-zero, orchestrate.ts:986 →
      // debitFailResult con totalCostUsdc:0). NO consumir el link como 'redeemed'
      // con 200 ambiguo: reopen (cero débito garantizado, como __quoteStale) y
      // devolver un error claro. Se distingue de "ejecutó y falló CON cargo"
      // (totalCostUsdc>0 → redeemed) que sí consume el link.
      if (
        result.pipeline.success === false &&
        (result.pipeline.totalCostUsdc ?? 0) === 0
      ) {
        await this.settle(
          claim.id,
          claim.owner_ref,
          'reopen',
          null,
          null,
          null,
        );
        throw new AgentLinkExecutionUnavailableError();
      }

      // OK: settle redeemed exactly-once. tx_hash/cost informativos (VERIFY-AT-IMPL).
      const settleTxHash =
        result.pipeline.steps[0]?.txHash ?? result.feeChargeTxHash ?? null;
      const consumedCost = result.pipeline.totalCostUsdc ?? price;
      // MNR-b: el débito YA ocurrió dentro de execute. Si el bookkeeping del
      // settle('redeemed') falla acá (RPC caído), el dinero ya se movió y el
      // agente ya corrió: NO degradar a 502. Logueamos para reconciliación y
      // devolvemos el result igual. Un retry cae en LINK_ALREADY_USED (el link
      // quedó en 'redeeming'), así que no hay doble-cobro.
      try {
        await this.settle(
          claim.id,
          claim.owner_ref,
          'redeemed',
          settleTxHash,
          consumedCost,
          null,
        );
      } catch (settleErr) {
        log.error(
          {
            linkId: claim.id,
            orchestrationId: result.orchestrationId,
            settleTxHash,
            consumedCost,
            errorClass:
              settleErr instanceof Error
                ? settleErr.constructor.name
                : 'unknown',
          },
          'agent-link settle(redeemed) failed post-debit — RECONCILE (money moved, returning result)',
        );
      }
      return toRedeemResult(result);
    } catch (err) {
      // reopen ya settleó (cero débito) → re-throw sin marcar failed (idempotente
      // igual: el status-gate del RPC ignora un 2º settle sobre 'open').
      if (
        err instanceof PriceExceedsLinkCapError ||
        err instanceof AgentLinkExecutionUnavailableError
      ) {
        throw err;
      }
      // execute throw (débito ambiguo) o key faltante → link 'failed' terminal
      // (CD-8, NO reopen). El route mapea a 502.
      const msg = err instanceof Error ? err.message : 'redeem failed';
      await this.settle(claim.id, claim.owner_ref, 'failed', null, null, msg);
      throw err instanceof Error ? err : new Error('AGENT_LINK_REDEEM_FAILED');
    }
  },

  /**
   * Claim atómico open→redeeming (RPC `claim_agent_link`, FOR UPDATE + status-gate).
   * Mapea los prefijos del RAISE por mensaje (patrón key-session.ts). NUNCA propaga
   * el msg crudo de PG.
   */
  async claimAtomic(tokenHash: string): Promise<AgentLinkClaim> {
    const { data, error } = await supabase.rpc('claim_agent_link', {
      p_token_hash: tokenHash,
    });

    if (error) {
      const m = error.message;
      if (m.includes('LINK_NOT_FOUND')) throw new AgentLinkNotFoundError();
      if (m.includes('LINK_EXPIRED')) throw new AgentLinkExpiredError();
      if (m.includes('LINK_ALREADY_USED'))
        throw new AgentLinkAlreadyUsedError();
      throw new Error('AGENT_LINK_CLAIM_FAILED');
    }

    const rows = (data ?? []) as unknown as AgentLinkClaim[];
    const claim = rows[0];
    if (!claim) {
      throw new AgentLinkAlreadyUsedError();
    }
    return claim;
  },

  /**
   * Settle exactly-once (RPC `settle_agent_link`, FOR UPDATE + status-gate +
   * Ownership Guard DB-level). Mapea OWNERSHIP_MISMATCH; el resto es no-op
   * idempotente si el link ya no está en 'redeeming'.
   */
  async settle(
    id: string,
    ownerRef: string,
    outcome: 'redeemed' | 'reopen' | 'failed',
    txHash: string | null,
    cost: number | null,
    errorMsg: string | null,
  ): Promise<void> {
    const { error } = await supabase.rpc('settle_agent_link', {
      p_id: id,
      p_owner_ref: ownerRef,
      p_outcome: outcome,
      p_tx_hash: txHash,
      p_cost: cost,
      p_error: errorMsg,
    });

    if (error) {
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        throw new OwnershipMismatchError();
      }
      throw new Error('AGENT_LINK_SETTLE_FAILED');
    }
  },
};
