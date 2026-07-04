/**
 * Agent Link Service — money-path unit tests (WKH-137).
 *
 * Cubre: T1 mint feliz (solo token_hash, nunca crudo), T3 mint input inválido,
 * T4 slug reservado, T5 redeem feliz, T6 cap pre-claim, T7 __quoteStale reopen,
 * T9 expirado, T10 usado, T11 doble-redeem concurrente (1 sola invoca+cobra),
 * T12 owner guard settle (OWNERSHIP_MISMATCH), T13 execute throw → failed terminal.
 *
 * supabase.from / supabase.rpc + agent-price + orchestrate + fee-charge mockeados.
 */

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('./agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
}));
vi.mock('./fee-charge.js', () => ({
  getProtocolFeeRate: () => 0.01,
}));
vi.mock('./orchestrate.js', () => ({
  orchestrateService: { executeApprovedPlan: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import type { A2AAgentKeyRow, OrchestrateResult } from '../types/index.js';
import {
  AgentLinkAlreadyUsedError,
  AgentLinkExecutionUnavailableError,
  AgentLinkExpiredError,
  AgentNotFoundError,
  agentLinkService,
  InvalidAgentLinkInputError,
  PriceExceedsLinkCapError,
  SlugReservedError,
} from './agent-link.js';
import { resolveAgentPriceUsdc } from './agent-price.js';
import { orchestrateService } from './orchestrate.js';
import { OwnershipMismatchError } from './security/errors.js';

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);
const mockPrice = vi.mocked(resolveAgentPriceUsdc);
const mockExecute = vi.mocked(orchestrateService.executeApprovedPlan);

type Single = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

// Terminal `.single()` result por tabla (mint/lookup usan a2a_agent_links;
// getKeyById usa a2a_agent_keys).
let linksSingle: Single = { data: null, error: null };
let keysSingle: Single = { data: null, error: null };
let lastInsert: Record<string, unknown> | undefined;

// RPC state.
let claimHandler: () => Single = () => ({ data: [], error: null });
const settleCalls: Array<Record<string, unknown>> = [];
let settleResult: Single = { data: null, error: null };

function makeBuilder(table: string) {
  // biome-ignore lint/suspicious/noExplicitAny: test double for the supabase builder
  const b: any = {
    insert: (row: Record<string, unknown>) => {
      lastInsert = row;
      return b;
    },
    select: () => b,
    eq: () => b,
    single: () =>
      Promise.resolve(table === 'a2a_agent_keys' ? keysSingle : linksSingle),
  };
  return b;
}

const OWNER = 'owner-A';
const KEY_ID = 'key-1';

function minterKey(): A2AAgentKeyRow {
  return {
    id: KEY_ID,
    owner_ref: OWNER,
    is_active: true,
  } as unknown as A2AAgentKeyRow;
}

function okResult(): OrchestrateResult {
  return {
    orchestrationId: 'orch-1',
    answer: 'done',
    reasoning: 'ok',
    pipeline: {
      success: true,
      output: 'done',
      steps: [],
      totalCostUsdc: 0.05,
      totalLatencyMs: 10,
    },
    consideredAgents: [],
    protocolFeeUsdc: 0.0005,
  };
}

function openLinkRow(over: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    token_hash: 'h',
    owner_ref: OWNER,
    key_id: KEY_ID,
    slug: 'kyc',
    registry: null,
    max_price_usdc: '1.00',
    chain_id: 2368,
    status: 'open',
    redeemed_at: null,
    settle_tx_hash: null,
    consumed_cost_usdc: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    error_message: null,
    created_at: 'x',
    updated_at: 'x',
    ...over,
  };
}

function claimRow(over: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    owner_ref: OWNER,
    key_id: KEY_ID,
    slug: 'kyc',
    registry: null,
    max_price_usdc: '1.00',
    chain_id: 2368,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  linksSingle = { data: null, error: null };
  keysSingle = { data: null, error: null };
  lastInsert = undefined;
  settleCalls.length = 0;
  settleResult = { data: null, error: null };
  claimHandler = () => ({ data: [claimRow()], error: null });
  // biome-ignore lint/suspicious/noExplicitAny: test double for the supabase builder
  mockFrom.mockImplementation((t: string) => makeBuilder(t) as any);
  mockRpc.mockImplementation(
    // biome-ignore lint/suspicious/noExplicitAny: test double for the supabase rpc
    (name: string, args?: Record<string, unknown>): any => {
      if (name === 'claim_agent_link') return Promise.resolve(claimHandler());
      if (name === 'settle_agent_link') {
        settleCalls.push(args ?? {});
        return Promise.resolve(settleResult);
      }
      return Promise.resolve({ data: null, error: null });
    },
  );
});

// ── T1 — mint feliz: 201 + token una vez + solo token_hash en DB ──
describe('mint (AC-1, CD-1)', () => {
  it('T1: persiste SOLO token_hash (nunca el crudo) y devuelve el token una vez', async () => {
    linksSingle = { data: { id: 'link-1' }, error: null };
    const res = await agentLinkService.mint(
      minterKey(),
      'kyc',
      { maxPriceUsdc: '0.50' },
      2368,
    );
    expect(res.token.startsWith('wasi_a2a_link_')).toBe(true);
    expect(res.link_id).toBe('link-1');
    expect(res.max_price_usdc).toBe('0.50');
    // El INSERT lleva SOLO el hash — NUNCA el token crudo (CD-1).
    const expectedHash = crypto
      .createHash('sha256')
      .update(res.token)
      .digest('hex');
    expect(lastInsert?.token_hash).toBe(expectedHash);
    expect(JSON.stringify(lastInsert)).not.toContain(res.token);
    expect(lastInsert?.owner_ref).toBe(OWNER);
    expect(lastInsert?.key_id).toBe(KEY_ID);
    expect(lastInsert?.slug).toBe('kyc');
  });

  // ── T3 — mint rechaza maxPriceUsdc<=0 / ttl inválido ──
  it('T3: rechaza maxPriceUsdc<=0 y ttl inválido (INVALID_INPUT)', async () => {
    await expect(
      agentLinkService.mint(minterKey(), 'kyc', { maxPriceUsdc: '0' }, 2368),
    ).rejects.toBeInstanceOf(InvalidAgentLinkInputError);
    await expect(
      agentLinkService.mint(
        minterKey(),
        'kyc',
        { maxPriceUsdc: '1', ttlSeconds: -5 },
        2368,
      ),
    ).rejects.toBeInstanceOf(InvalidAgentLinkInputError);
  });

  // ── T4 — mint rechaza slug 'links' ──
  it('T4: rechaza slug reservado `links` (SLUG_RESERVED)', async () => {
    await expect(
      agentLinkService.mint(minterKey(), 'links', { maxPriceUsdc: '1' }, 2368),
    ).rejects.toBeInstanceOf(SlugReservedError);
  });
});

// ── redeem ──
describe('redeem (AC-2/AC-3/AC-4/CD-4/CD-8)', () => {
  // T5 — redeem feliz.
  it('T5: precio ≤ cap → invoca + settle redeemed + devuelve result', async () => {
    linksSingle = { data: openLinkRow(), error: null };
    keysSingle = { data: { id: KEY_ID, owner_ref: OWNER }, error: null };
    mockPrice.mockResolvedValue(0.05);
    mockExecute.mockResolvedValue(okResult());

    const res = await agentLinkService.redeem('wasi_a2a_link_tok', {
      q: 1,
    });
    expect(res.orchestrationId).toBe('orch-1');
    // El cap autoritativo viaja a execute (server-side).
    const call = mockExecute.mock.calls[0];
    expect(call?.[0].maxQuotedCostUsdc).toBe(1);
    expect(call?.[0].scopingKeyRow).toMatchObject({ id: KEY_ID });
    // settle redeemed exactly-once.
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.p_outcome).toBe('redeemed');
  });

  // T6 — precio > cap pre-claim.
  it('T6: precio > cap (pre-claim) → PRICE_EXCEEDS_LINK_CAP, sin claim/execute/settle', async () => {
    linksSingle = {
      data: openLinkRow({ max_price_usdc: '1.00' }),
      error: null,
    };
    mockPrice.mockResolvedValue(5);
    await expect(
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ).rejects.toBeInstanceOf(PriceExceedsLinkCapError);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(
      mockRpc.mock.calls.filter((c) => c[0] === 'claim_agent_link'),
    ).toHaveLength(0);
    expect(settleCalls).toHaveLength(0);
  });

  // T7 — drift > cap post-claim (__quoteStale) → reopen, cero débito.
  it('T7: __quoteStale post-claim → reopen (cero débito), NO failed', async () => {
    linksSingle = { data: openLinkRow(), error: null };
    keysSingle = { data: { id: KEY_ID, owner_ref: OWNER }, error: null };
    mockPrice.mockResolvedValue(0.5);
    mockExecute.mockResolvedValue({
      __quoteStale: true,
      currentCostUsdc: 2,
      maxQuotedCostUsdc: 1,
    });
    await expect(
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ).rejects.toBeInstanceOf(PriceExceedsLinkCapError);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.p_outcome).toBe('reopen');
  });

  // T9 — token expirado (pre-claim).
  it('T9: token expirado → LINK_EXPIRED (pre-claim)', async () => {
    linksSingle = {
      data: openLinkRow({
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
      error: null,
    };
    mockPrice.mockResolvedValue(0.05);
    await expect(
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ).rejects.toBeInstanceOf(AgentLinkExpiredError);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T10 — token ya usado (pre-claim).
  it('T10: token ya usado → LINK_ALREADY_USED (pre-claim)', async () => {
    linksSingle = { data: openLinkRow({ status: 'redeemed' }), error: null };
    await expect(
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ).rejects.toBeInstanceOf(AgentLinkAlreadyUsedError);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T5b — agente inexistente.
  it('agente inexistente → AGENT_NOT_FOUND', async () => {
    linksSingle = { data: openLinkRow(), error: null };
    mockPrice.mockResolvedValue(null);
    await expect(
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  // T11 — doble-redeem concurrente: exactamente 1 invoca+cobra, el otro 409.
  it('T11: doble-redeem concurrente → 1 invoca+cobra, el otro LINK_ALREADY_USED', async () => {
    linksSingle = { data: openLinkRow(), error: null };
    keysSingle = { data: { id: KEY_ID, owner_ref: OWNER }, error: null };
    mockPrice.mockResolvedValue(0.05);
    mockExecute.mockResolvedValue(okResult());
    // El claim atómico: solo el primero gana; el segundo pierde el lock-race.
    let claimed = false;
    claimHandler = () => {
      if (!claimed) {
        claimed = true;
        return { data: [claimRow()], error: null };
      }
      return { data: null, error: { message: 'LINK_ALREADY_USED' } };
    };

    const settled = await Promise.allSettled([
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const bad = settled.filter((s) => s.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      AgentLinkAlreadyUsedError,
    );
    // Cero doble-cobro: execute + settle redeemed una sola vez.
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(settleCalls.filter((c) => c.p_outcome === 'redeemed')).toHaveLength(
      1,
    );
  });

  // BLQ-1 — el redeem público NO filtra saldo/telemetría de billing del owner.
  it('BLQ-1: redeem NO devuelve remainingBudgetUsd ni telemetría de billing del owner', async () => {
    linksSingle = { data: openLinkRow(), error: null };
    keysSingle = { data: { id: KEY_ID, owner_ref: OWNER }, error: null };
    mockPrice.mockResolvedValue(0.05);
    // El OrchestrateResult interno arrastra el saldo del owner + telemetría.
    const leaky: OrchestrateResult = {
      ...okResult(),
      remainingBudgetUsd: '999.99',
      feeChargeError: 'fee boom',
      feeChargeTxHash: '0xfeetx',
      refundError: true,
      debitFallback: true,
    };
    mockExecute.mockResolvedValue(leaky);

    const res = await agentLinkService.redeem('wasi_a2a_link_tok', {});
    const keys = Object.keys(res);
    expect(keys).not.toContain('remainingBudgetUsd');
    expect(keys).not.toContain('feeChargeError');
    expect(keys).not.toContain('feeChargeTxHash');
    expect(keys).not.toContain('refundError');
    expect(keys).not.toContain('debitFallback');
    // El saldo del owner NO aparece por ningún lado del body.
    expect(JSON.stringify(res)).not.toContain('999.99');
    // Sí devuelve lo público que el canal externo necesita.
    expect(res.orchestrationId).toBe('orch-1');
    expect(res.protocolFeeUsdc).toBe(0.0005);
    expect(res.pipeline.success).toBe(true);
    expect(res.pipeline.output).toBe('done');
  });

  // MNR-a — execute sin cargo (fondos insuficientes / net-zero) → reopen, error claro.
  it('MNR-a: execute success=false + cero débito → reopen + error claro (link NO redeemed)', async () => {
    linksSingle = { data: openLinkRow(), error: null };
    keysSingle = { data: { id: KEY_ID, owner_ref: OWNER }, error: null };
    mockPrice.mockResolvedValue(0.05);
    // Espejo del debitFailResult de orchestrate.ts:986 (fondos insuficientes).
    mockExecute.mockResolvedValue({
      orchestrationId: 'orch-nf',
      answer: null,
      reasoning: 'Insufficient budget for orchestration',
      pipeline: {
        success: false,
        output: null,
        steps: [],
        totalCostUsdc: 0,
        totalLatencyMs: 0,
      },
      consideredAgents: [],
      protocolFeeUsdc: 0,
    });

    await expect(
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ).rejects.toBeInstanceOf(AgentLinkExecutionUnavailableError);
    // El link se REABRE (cero débito), NO se consume como redeemed/failed.
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.p_outcome).toBe('reopen');
  });

  // MNR-b — settle(redeemed) falla DESPUÉS del débito → devolver result, NO 502.
  it('MNR-b: settle(redeemed) falla post-débito → devuelve result (NO throw), log reconciliación', async () => {
    linksSingle = { data: openLinkRow(), error: null };
    keysSingle = { data: { id: KEY_ID, owner_ref: OWNER }, error: null };
    mockPrice.mockResolvedValue(0.05);
    mockExecute.mockResolvedValue(okResult());
    // El RPC settle cae DESPUÉS de que execute ya debitó.
    settleResult = {
      data: null,
      error: { message: 'AGENT_LINK_SETTLE_FAILED transient' },
    };

    const res = await agentLinkService.redeem('wasi_a2a_link_tok', {});
    // El dinero ya se movió → devolvemos el result igual (no degradar a 502).
    expect(res.orchestrationId).toBe('orch-1');
    expect(res.pipeline.success).toBe(true);
    // Se intentó el settle redeemed (falló) — no reopen, no failed.
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.p_outcome).toBe('redeemed');
  });

  // T13 — execute throw → link failed terminal, NO reopen, NO doble-cobro retry.
  it('T13: execute throw → settle failed terminal (NO reopen)', async () => {
    linksSingle = { data: openLinkRow(), error: null };
    keysSingle = { data: { id: KEY_ID, owner_ref: OWNER }, error: null };
    mockPrice.mockResolvedValue(0.05);
    mockExecute.mockRejectedValue(new Error('boom'));

    await expect(
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ).rejects.toThrow('boom');
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.p_outcome).toBe('failed');
    // Retry: el link ya está terminal (status='failed') → pre-claim rechaza,
    // execute NO se vuelve a llamar (cero doble-cobro).
    linksSingle = { data: openLinkRow({ status: 'failed' }), error: null };
    await expect(
      agentLinkService.redeem('wasi_a2a_link_tok', {}),
    ).rejects.toBeInstanceOf(AgentLinkAlreadyUsedError);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

// ── T12 — owner guard del settle RPC (OWNERSHIP_MISMATCH) ──
describe('settle owner guard (AC-6, RIESGO-6)', () => {
  it('T12: settle con owner mismatch → OwnershipMismatchError (cero débito en settle)', async () => {
    settleResult = {
      data: null,
      error: { message: 'OWNERSHIP_MISMATCH: link not owned by caller' },
    };
    await expect(
      agentLinkService.settle('link-1', 'owner-B', 'redeemed', '0xtx', 1, null),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });
});
