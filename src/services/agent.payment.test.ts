/**
 * Published Agent Service — `Agent.payment` de agentes self-published (WKH-241).
 *
 * Cierra el gap de LECTURA: `mapRowToAgent` no exponía el payment spec que el
 * agente declara en `metadata.payment`, así que un agente Solana-native
 * (`remit-*-solana`) cobraba su fee por la chain default del gateway en vez de
 * Solana. Se testea vía el service REAL (`listAsAgents`/`getBySlugAsAgent`) con
 * supabase mockeado, y se prueba que el lector es UNO SOLO compartido con el
 * mapper de registries externos (`discovery.ts` `mapAgent`) — AC-4/CD-1.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../types/index.js';

const { state, readerSpy } = vi.hoisted(() => ({
  state: {
    row: null as Record<string, unknown> | null,
    listData: [] as Record<string, unknown>[],
  },
  readerSpy: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    order: () => Promise.resolve({ data: state.listData, error: null }),
    maybeSingle: () => Promise.resolve({ data: state.row, error: null }),
    single: () => Promise.resolve({ data: state.row, error: null }),
  });
  return { supabase: { from: () => builder } };
});

// AC-4: se espía el módulo LEAF compartido delegando en la implementación REAL
// (comportamiento intacto). Si algún mapper tuviera su propio validador
// paralelo, el spy no registraría su llamada y el test falla.
vi.mock('../lib/payment-spec-reader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../lib/payment-spec-reader.js')>();
  readerSpy.mockImplementation(actual.readPaymentSpec);
  return {
    readPaymentSpec: (raw: Record<string, unknown>) => readerSpy(raw),
  };
});

import { publishedAgentService } from './agent.js';
import { discoveryService } from './discovery.js';

// pubkey base58 de 32 bytes — payTo del agente Solana-native (WKH-235/236).
const SOL_PAYTO = 'So11111111111111111111111111111111111111112';
const EVM_PAYTO = '0x000000000000000000000000000000000000aBcD';

function makeRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'remit-corridor-fx-solana',
    name: 'Remit Corridor FX (Solana)',
    description: 'FX quote',
    capabilities: ['fx'],
    agent_url: 'https://remit-agents.example/fx',
    price_usdc: 0.02,
    metadata: null,
    enabled: true,
    owner_ref: 'tenant-A',
    created_at: new Date().toISOString(),
    ...o,
  };
}

function makeRegistry(): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/agents',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: { discovery: {}, invoke: { method: 'POST' } },
    enabled: true,
    createdAt: new Date(),
    ownerRef: 'system',
  };
}

const SOLANA_SPEC = {
  method: 'x402',
  chain: 'solana-devnet',
  contract: SOL_PAYTO,
  asset: 'USDC',
};

describe('mapRowToAgent — payment spec declarado (WKH-241)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readerSpy.mockClear();
    state.row = null;
    state.listData = [];
  });

  // ── AC-1 ─────────────────────────────────────────────────────────
  it('AC-1: self-published con metadata.payment (solana-devnet) → Agent.payment expuesto con payTo base58 y esa chain', async () => {
    state.listData = [makeRow({ metadata: { payment: SOLANA_SPEC } })];

    const [agent] = await publishedAgentService.listAsAgents();

    expect(agent?.payment).toEqual({
      method: 'x402',
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
      asset: 'USDC',
    });
    // El payTo es el base58 declarado — NO una address EVM ni la chain default.
    expect(agent?.payment?.contract).toBe(SOL_PAYTO);
    expect(agent?.payment?.chain).toBe('solana-devnet');
  });

  it('AC-1: getBySlugAsAgent expone el MISMO payment que listAsAgents', async () => {
    state.row = makeRow({ metadata: { payment: SOLANA_SPEC } });

    const agent = await publishedAgentService.getBySlugAsAgent(
      'remit-corridor-fx-solana',
    );

    expect(agent?.payment).toEqual({
      method: 'x402',
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
      asset: 'USDC',
    });
  });

  // ── AC-2 ─────────────────────────────────────────────────────────
  it('AC-2: self-published SIN payment spec → payment ausente y JSON byte-idéntico (sin la key "payment")', async () => {
    state.listData = [
      makeRow({ slug: 'plain-agent', metadata: null }),
      makeRow({
        slug: 'schema-agent',
        metadata: { inputSchema: { type: 'object' }, discoverable: true },
      }),
    ];

    const agents = await publishedAgentService.listAsAgents();

    for (const a of agents) {
      expect(a.payment).toBeUndefined();
      // /discover serializa con JSON.stringify: una prop `undefined` se omite,
      // así que la respuesta es byte-idéntica al comportamiento pre-WKH-241.
      expect(JSON.stringify(a)).not.toContain('payment');
      expect(Object.keys(JSON.parse(JSON.stringify(a)))).not.toContain(
        'payment',
      );
    }
  });

  // ── AC-3 ─────────────────────────────────────────────────────────
  it('AC-3: chain no resoluble (polygon / basura) → payment omitido, SIN fallback a la chain default', async () => {
    state.listData = [
      makeRow({
        slug: 'polygon-agent',
        metadata: {
          payment: { method: 'x402', chain: 'polygon', contract: EVM_PAYTO },
        },
      }),
      makeRow({
        slug: 'garbage-agent',
        metadata: {
          payment: {
            method: 'x402',
            chain: '../../etc/passwd',
            contract: SOL_PAYTO,
          },
        },
      }),
      makeRow({
        slug: 'solana-mainnet-agent',
        metadata: {
          payment: {
            method: 'x402',
            chain: 'solana-mainnet',
            contract: SOL_PAYTO,
          },
        },
      }),
    ];

    const agents = await publishedAgentService.listAsAgents();

    expect(agents).toHaveLength(3);
    for (const a of agents) {
      expect(a.payment, `slug=${a.slug}`).toBeUndefined();
    }
  });

  // ── AC-4 ─────────────────────────────────────────────────────────
  it('AC-4: self-published y registries externos derivan payment con LA MISMA función (sin validador paralelo)', async () => {
    state.listData = [makeRow({ metadata: { payment: SOLANA_SPEC } })];
    const [selfPublished] = await publishedAgentService.listAsAgents();
    const callsAfterSelfPublished = readerSpy.mock.calls.length;

    const external = discoveryService.mapAgent(makeRegistry(), {
      id: 'ext-1',
      slug: 'ext-agent',
      name: 'External',
      description: 'd',
      capabilities: ['fx'],
      price: 0.02,
      status: 'active',
      payment: SOLANA_SPEC,
    });

    // Ambos mappers pasaron por el ÚNICO lector compartido (CD-1).
    expect(callsAfterSelfPublished).toBeGreaterThan(0);
    expect(readerSpy.mock.calls.length).toBeGreaterThan(
      callsAfterSelfPublished,
    );
    // Y el spec resultante es idéntico para el mismo input declarado.
    expect(selfPublished?.payment).toEqual(external.payment);
  });

  // ── AC-5 (DT-3) ──────────────────────────────────────────────────
  it('AC-5/DT-3: contract malformado se expone tal cual (pass-through) — el rechazo vive en settle-time', async () => {
    state.listData = [
      makeRow({
        metadata: {
          payment: { method: 'x402', chain: 'solana-devnet', contract: 'abc' },
        },
      }),
    ];

    const [agent] = await publishedAgentService.listAsAgents();

    // No se agrega un segundo guard de formato en discovery (Scope OUT/CD-1);
    // `settleSolanaLeg` (downstream-payment.ts:132) lo skipea con
    // INVALID_PAY_TO_FORMAT sin mover fondos — ver downstream-payment.test.ts
    // (T-234-AC3c / T-241-AC5).
    expect(agent?.payment?.contract).toBe('abc');
  });

  // ── AC-6 + CD-3 ──────────────────────────────────────────────────
  it('AC-6: agentes EVM existentes (remit-* Fuji sin spec) siguen sin payment → fee por la chain default, sin cambios', async () => {
    state.listData = [
      makeRow({
        slug: 'remit-kyc-validator',
        metadata: { discoverable: true },
        payout_chain: 'avalanche-fuji',
        payout_wallet: EVM_PAYTO,
      }),
    ];

    const [agent] = await publishedAgentService.listAsAgents();

    expect(agent?.payment).toBeUndefined();
    expect(agent?.priceUsdc).toBe(0.02);
    expect(agent?.status).toBe('active');
  });

  it('CD-3/DT-2: payout_wallet/payout_chain NUNCA derivan payment (son del creator-split del 1%)', async () => {
    state.listData = [
      makeRow({
        slug: 'payout-only-agent',
        metadata: null,
        payout_chain: 'solana-devnet',
        payout_wallet: SOL_PAYTO,
      }),
    ];

    const [agent] = await publishedAgentService.listAsAgents();

    expect(agent?.payment).toBeUndefined();
    expect(JSON.stringify(agent)).not.toContain(SOL_PAYTO);
  });
});
