/**
 * Published Agent Service — write-boundary + read-boundary guards (WKH-134).
 *
 * Cubre el fix-pack del AR:
 *   - BLQ-1 (money-path): `publish`/`update` RECHAZAN `priceUsdc` negativo /
 *     NaN / Infinity (write-boundary); `mapRowToAgent` (vía `listAsAgents`)
 *     CLAMPEA con `parsePriceSafe` un `price_usdc` negativo ya persistido en DB
 *     → discovery devuelve 0 (nunca un débito negativo llega a /compose).
 *   - MNR-1: `capabilities` se sanea a string[] no vacío en publish/update.
 *   - MNR-2: guards de whitespace del `name` también en PATCH (update).
 *
 * Usa el service REAL con supabase + node:dns mockeados (defense-in-depth real).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLookup, state } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  state: {
    row: null as Record<string, unknown> | null,
    listData: [] as Record<string, unknown>[],
    insertedRow: null as Record<string, unknown> | null,
    updateCalled: false,
  },
}));

vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    order: () => Promise.resolve({ data: state.listData, error: null }),
    maybeSingle: () => Promise.resolve({ data: state.row, error: null }),
    insert: (row: Record<string, unknown>) => {
      state.insertedRow = row;
      return builder;
    },
    update: () => {
      state.updateCalled = true;
      return builder;
    },
    delete: () => builder,
    single: () =>
      Promise.resolve({
        data: state.insertedRow ?? state.row,
        error: null,
      }),
  });
  return { supabase: { from: () => builder } };
});

import { publishedAgentService } from './agent.js';

const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];

const OWNED_ROW = {
  slug: 'my-agent',
  name: 'My Agent',
  description: '',
  capabilities: ['weather'],
  agent_url: 'https://api.example/agent',
  price_usdc: 0,
  metadata: null,
  enabled: true,
  owner_ref: 'tenant-A',
  created_at: new Date().toISOString(),
};

const BASE_INPUT = {
  name: 'My Agent',
  agentUrl: 'https://api.example/agent',
  capabilities: ['weather'],
};

describe('publishedAgentService — price/capabilities/name guards (WKH-134)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.row = null;
    state.listData = [];
    state.insertedRow = null;
    state.updateCalled = false;
    mockLookup.mockResolvedValue(PUBLIC_IP);
  });

  afterEach(() => {
    mockLookup.mockReset();
  });

  // ── BLQ-1: publish rejects invalid price (write-boundary) ────────
  it('publish rejects priceUsdc negative → throws, no INSERT (BLQ-1)', async () => {
    await expect(
      publishedAgentService.publish(
        { ...BASE_INPUT, priceUsdc: -1000 },
        'tenant-A',
      ),
    ).rejects.toThrow(/Invalid priceUsdc/);
    expect(state.insertedRow).toBeNull();
  });

  it('publish rejects priceUsdc NaN / Infinity → throws (BLQ-1)', async () => {
    await expect(
      publishedAgentService.publish(
        { ...BASE_INPUT, priceUsdc: Number.NaN },
        'tenant-A',
      ),
    ).rejects.toThrow(/Invalid priceUsdc/);

    await expect(
      publishedAgentService.publish(
        { ...BASE_INPUT, priceUsdc: Number.POSITIVE_INFINITY },
        'tenant-A',
      ),
    ).rejects.toThrow(/Invalid priceUsdc/);

    expect(state.insertedRow).toBeNull();
  });

  it('publish accepts priceUsdc 0 and positive → persisted (BLQ-1)', async () => {
    await publishedAgentService.publish(
      { ...BASE_INPUT, priceUsdc: 0.02 },
      'tenant-A',
    );
    expect(state.insertedRow?.price_usdc).toBe(0.02);
  });

  // ── MNR-1: capabilities sanitization in publish ──────────────────
  it('publish filters non-string capabilities; rejects when none remain (MNR-1)', async () => {
    // [123] → filtered empty → rejected.
    await expect(
      publishedAgentService.publish(
        { ...BASE_INPUT, capabilities: [123 as unknown as string] },
        'tenant-A',
      ),
    ).rejects.toThrow(/Invalid capabilities/);
    expect(state.insertedRow).toBeNull();

    // ['weather', 123, 'geo'] → persisted only strings.
    await publishedAgentService.publish(
      {
        ...BASE_INPUT,
        capabilities: ['weather', 123 as unknown as string, 'geo'],
      },
      'tenant-A',
    );
    expect(state.insertedRow?.capabilities).toEqual(['weather', 'geo']);
  });

  // ── BLQ-1: update rejects invalid price ──────────────────────────
  it('update rejects priceUsdc negative → throws, no UPDATE (BLQ-1)', async () => {
    state.row = { ...OWNED_ROW };
    await expect(
      publishedAgentService.update('my-agent', { priceUsdc: -5 }, 'tenant-A'),
    ).rejects.toThrow(/Invalid priceUsdc/);
    expect(state.updateCalled).toBe(false);
  });

  // ── MNR-1: update rejects invalid capabilities ───────────────────
  it('update rejects empty/non-string capabilities → throws (MNR-1)', async () => {
    state.row = { ...OWNED_ROW };
    await expect(
      publishedAgentService.update(
        'my-agent',
        { capabilities: [] },
        'tenant-A',
      ),
    ).rejects.toThrow(/Invalid capabilities/);
    expect(state.updateCalled).toBe(false);
  });

  // ── MNR-2: update name whitespace guards ─────────────────────────
  it('update rejects name with leading/trailing or collapsible whitespace (MNR-2)', async () => {
    state.row = { ...OWNED_ROW };
    await expect(
      publishedAgentService.update(
        'my-agent',
        { name: '  spaced  ' },
        'tenant-A',
      ),
    ).rejects.toThrow(/whitespace/);

    state.row = { ...OWNED_ROW };
    await expect(
      publishedAgentService.update('my-agent', { name: 'a  b' }, 'tenant-A'),
    ).rejects.toThrow(/whitespace/);

    expect(state.updateCalled).toBe(false);
  });

  // ── BLQ-1 read-boundary: mapRowToAgent clamps DB negatives ───────
  it('listAsAgents clamps a negative price_usdc already in DB to 0 (BLQ-1 read-boundary)', async () => {
    state.listData = [
      { ...OWNED_ROW, slug: 'evil', price_usdc: -1000 },
      { ...OWNED_ROW, slug: 'ok', price_usdc: 0.05 },
    ];
    const agents = await publishedAgentService.listAsAgents();
    const evil = agents.find((a) => a.slug === 'evil');
    const ok = agents.find((a) => a.slug === 'ok');
    // Discovery jamás ve un precio negativo (no llega débito negativo a /compose).
    expect(evil?.priceUsdc).toBe(0);
    expect(ok?.priceUsdc).toBe(0.05);
  });
});
