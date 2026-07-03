/**
 * Reputation write-back service unit tests — WKH-133 (W3).
 *
 * Cubre AC-1 (happy path → 1 tx con agentId correcto), AC-2 (registry no
 * configurado → skip), AC-3/CD-2 (claim 0 filas → sin tx: anti-doble-gasto),
 * AC-4/CD-3 (writer falla → row 'failed' + código corto, sin throw, sin
 * reintento), AC-5 (status='failed' o costo<=0 → sin tx), CD-9 (sin binding →
 * skip). Mockea el writer + el helper de identidad + supabase. CI-determinista.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────
vi.mock('../adapters/erc8004-reputation-writer.js', () => ({
  isWritebackEnabled: vi.fn(),
  erc8004ReputationWriter: { giveFeedback: vi.fn() },
}));
vi.mock('../adapters/erc8004-reputation.js', () => ({
  resolveReputationRegistryAddress: vi.fn(),
}));
vi.mock('../adapters/base/chain.js', () => ({
  getBaseNetwork: vi.fn(),
}));
vi.mock('./identity.js', () => ({
  identityService: { resolveErc8004AgentId: vi.fn() },
}));
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { getBaseNetwork } from '../adapters/base/chain.js';
import { resolveReputationRegistryAddress } from '../adapters/erc8004-reputation.js';
import {
  erc8004ReputationWriter,
  isWritebackEnabled,
} from '../adapters/erc8004-reputation-writer.js';
import { supabase } from '../lib/supabase.js';
import { identityService } from './identity.js';
import {
  reputationWritebackService,
  type WritebackEvent,
} from './reputation-writeback.js';

const mockEnabled = vi.mocked(isWritebackEnabled);
const mockNetwork = vi.mocked(getBaseNetwork);
const mockResolveRegistry = vi.mocked(resolveReputationRegistryAddress);
const mockResolveAgentId = vi.mocked(identityService.resolveErc8004AgentId);
const mockGiveFeedback = vi.mocked(erc8004ReputationWriter.giveFeedback);
const mockFrom = vi.mocked(supabase.from);

const REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;

// Supabase mock: claim (.upsert().select()) + persist (.update().eq()).
function buildSupabase(claim: { data: unknown[] | null; error: unknown }) {
  const upsertSelect = vi
    .fn()
    .mockResolvedValue({ data: claim.data, error: claim.error });
  const upsert = vi.fn().mockReturnValue({ select: upsertSelect });
  const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });
  mockFrom.mockReturnValue({
    upsert,
    update,
  } as unknown as ReturnType<typeof supabase.from>);
  return { upsert, update, updateEq };
}

function baseEvent(overrides: Partial<WritebackEvent> = {}): WritebackEvent {
  return {
    id: 'evt-uuid-1',
    eventType: 'compose_step',
    agentId: 'weather-agent',
    status: 'success',
    costUsdc: 0.05,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: feature ON + testnet + registry configurado + binding único.
  mockEnabled.mockReturnValue(true);
  mockNetwork.mockReturnValue('testnet');
  mockResolveRegistry.mockReturnValue(REGISTRY);
  mockResolveAgentId.mockResolvedValue(7n);
});

describe('reputationWritebackService.onSettledEvent', () => {
  // T-AC1: happy path → 1 tx con el agentId resuelto + row 'confirmed'.
  it('T-AC1: settled success + resolved identity → giveFeedback once + confirmed', async () => {
    const sb = buildSupabase({
      data: [{ event_id: 'evt-uuid-1' }],
      error: null,
    });
    mockGiveFeedback.mockResolvedValue({
      ok: true,
      txHash: '0xabc',
      chainId: 84532,
    });

    await reputationWritebackService.onSettledEvent(baseEvent());

    expect(mockGiveFeedback).toHaveBeenCalledTimes(1);
    expect(mockGiveFeedback).toHaveBeenCalledWith({
      agentId: 7n,
      value: 100n,
      valueDecimals: 0,
      tag1: 'wasiai',
      tag2: 'compose_step',
    });
    // Persist confirmed con tx_hash.
    expect(sb.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed', tx_hash: '0xabc' }),
    );
    expect(sb.updateEq).toHaveBeenCalledWith('event_id', 'evt-uuid-1');
  });

  // T-AC2-cfg: registry/rpc no configurado → skip silencioso, sin tx, sin throw.
  it('T-AC2-cfg: registry not configured → skip, writer never called', async () => {
    buildSupabase({ data: [], error: null });
    mockResolveRegistry.mockReturnValue(null);

    await expect(
      reputationWritebackService.onSettledEvent(baseEvent()),
    ).resolves.toBeUndefined();

    expect(mockResolveAgentId).not.toHaveBeenCalled();
    expect(mockGiveFeedback).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  // T-AC3/CD-2: claim ON CONFLICT devuelve 0 filas (ya attestado) → sin tx.
  it('T-AC3: claim returns 0 rows (already attested) → no tx (idempotent, no double-spend)', async () => {
    buildSupabase({ data: [], error: null });

    await reputationWritebackService.onSettledEvent(baseEvent());

    expect(mockGiveFeedback).not.toHaveBeenCalled();
  });

  // T-AC4/CD-3: writer falla → row 'failed' + error_code corto, sin throw, sin reintento.
  it('T-AC4: writer failure → row failed with short error_code, no throw, no retry', async () => {
    const sb = buildSupabase({
      data: [{ event_id: 'evt-uuid-1' }],
      error: null,
    });
    mockGiveFeedback.mockResolvedValue({ ok: false, reason: 'REVERTED' });

    await expect(
      reputationWritebackService.onSettledEvent(baseEvent()),
    ).resolves.toBeUndefined();

    expect(mockGiveFeedback).toHaveBeenCalledTimes(1); // sin reintento síncrono
    expect(sb.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_code: 'REVERTED' }),
    );
  });

  // T-AC5-failed: evento status='failed' → sin claim ni tx.
  it('T-AC5-failed: event status=failed → no claim, no tx', async () => {
    buildSupabase({ data: [], error: null });

    await reputationWritebackService.onSettledEvent(
      baseEvent({ status: 'failed' }),
    );

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockGiveFeedback).not.toHaveBeenCalled();
  });

  // T-AC5-zerocost: costo<=0 → sin tx (paridad tasks_settled anti-sybil).
  it('T-AC5-zerocost: cost_usdc<=0 → no tx', async () => {
    buildSupabase({ data: [], error: null });

    await reputationWritebackService.onSettledEvent(baseEvent({ costUsdc: 0 }));

    expect(mockGiveFeedback).not.toHaveBeenCalled();
  });

  // T-CD9 (service side): sin binding único → resolveErc8004AgentId null → skip.
  it('T-CD9: no unique binding (resolveErc8004AgentId null) → skip, no claim, no tx', async () => {
    buildSupabase({ data: [], error: null });
    mockResolveAgentId.mockResolvedValue(null);

    await reputationWritebackService.onSettledEvent(baseEvent());

    expect(mockGiveFeedback).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  // Flag OFF → skip inmediato (CD-5, doble barrera con event.ts).
  it('flag OFF → skip, writer never called', async () => {
    mockEnabled.mockReturnValue(false);

    await reputationWritebackService.onSettledEvent(baseEvent());

    expect(mockGiveFeedback).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
