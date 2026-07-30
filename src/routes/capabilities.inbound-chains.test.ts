/**
 * HU-204 (arreglo B) — `GET /capabilities` deja de prometer de más.
 *
 * El endpoint listaba TODA chain inicializada en `chains`, sin distinguir la que
 * acepta cobro de ENTRADA de la que sólo liquida hacia AFUERA. Un integrador que
 * leía esa lista y mandaba `x-payment-chain: solana-devnet` se comía un rechazo:
 * el gateway anunciaba una red de pago viva donde sólo existe la mitad del rail.
 *
 * Igual que el test del middleware, acá el REGISTRY es REAL (sólo se moquean las
 * factories): si se moqueara el registry, el `vmFamily` del bundle sería el que
 * el test quiera y el campo derivado no probaría nada.
 *
 * Naming: T-204-CAP-01..03.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adapters/solana/index.js', () => ({
  createSolanaAdapters: vi.fn(async () => ({
    payment: {
      name: 'solana',
      vmFamily: 'solana',
      caip2ChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      supportedTokens: [{ symbol: 'USDC', mint: 'Es9vMFrz', decimals: 6 }],
    },
    attestation: { name: 'solana', chainId: 900001 },
    gasless: { name: 'solana', chainId: 900001 },
    identity: null,
    chainConfig: {
      name: 'Solana Devnet',
      chainId: 900001,
      explorerUrl: 'https://explorer.solana.com?cluster=devnet',
    },
  })),
}));

vi.mock('../adapters/base/index.js', () => ({
  createBaseAdapters: vi.fn(async () => ({
    payment: {
      name: 'base',
      vmFamily: 'evm',
      chainId: 84532,
      supportedTokens: [
        {
          symbol: 'USDC',
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          decimals: 6,
        },
      ],
    },
    attestation: { name: 'base', chainId: 84532 },
    gasless: { name: 'base', chainId: 84532 },
    identity: null,
    chainConfig: {
      name: 'Base Sepolia',
      chainId: 84532,
      explorerUrl: 'https://sepolia.basescan.org',
    },
  })),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(async () => ({
      agents: [],
      total: 0,
      registries: [],
      sources: [],
      catalogStatus: 'complete',
    })),
  },
}));

vi.mock('../services/agent-card.js', () => ({
  resolveBaseUrl: () => 'http://localhost:3001',
  agentCardService: {
    buildSelfAgentCard: () => ({
      name: 'wasiai-a2a',
      description: 'test',
      url: 'http://localhost:3001',
      capabilities: {},
      skills: [],
      inputModes: [],
      outputModes: [],
    }),
  },
}));

import { _resetRegistry, initAdapters } from '../adapters/registry.js';
import { discoveryService } from '../services/discovery.js';
import capabilitiesRoutes from './capabilities.js';

interface ChainEntry {
  key: string;
  name: string;
  chainId: number;
  isDefault: boolean;
  acceptsInboundPayment: boolean;
}

/** WKH-318: el cuerpo COMPLETO, para poder asertar el contrato campo por campo. */
async function getBody(): Promise<Record<string, unknown>> {
  const app = Fastify();
  await app.register(capabilitiesRoutes, { prefix: '/capabilities' });
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/capabilities' });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Record<string, unknown>;
  } finally {
    await app.close();
  }
}

async function getChains(): Promise<ChainEntry[]> {
  const app = Fastify();
  await app.register(capabilitiesRoutes, { prefix: '/capabilities' });
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: '/capabilities' });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { chains: ChainEntry[] }).chains;
  } finally {
    await app.close();
  }
}

describe('HU-204 — GET /capabilities distingue entrada de salida', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetRegistry();
    process.env.SOLANA_ADAPTER_ENABLED = 'true';
    process.env.WASIAI_A2A_CHAINS = 'base-sepolia,solana-devnet';
    await initAdapters();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetRegistry();
  });

  it('T-204-CAP-01: la chain outbound-only se publica como acceptsInboundPayment:false', async () => {
    const chains = await getChains();
    const solana = chains.find((c) => c.key === 'solana-devnet');
    expect(solana).toBeDefined();
    expect(solana?.acceptsInboundPayment).toBe(false);
  });

  it('T-204-CAP-02: la chain EVM se publica como acceptsInboundPayment:true', async () => {
    const chains = await getChains();
    const base = chains.find((c) => c.key === 'base-sepolia');
    expect(base?.acceptsInboundPayment).toBe(true);
  });

  it('T-204-CAP-03: cambio ADITIVO — los 4 campos previos siguen intactos', async () => {
    // Es una respuesta PÚBLICA: agregar un campo es seguro, renombrar o sacar
    // uno rompe a los clientes que ya la leen. Este test congela esa promesa.
    const chains = await getChains();
    expect(chains).toHaveLength(2);
    expect(chains[0]).toMatchObject({
      key: 'base-sepolia',
      name: 'Base Sepolia',
      chainId: 84532,
      isDefault: true,
    });
    expect(chains[1]).toMatchObject({
      key: 'solana-devnet',
      name: 'Solana Devnet',
      chainId: 900001,
      isDefault: false,
    });
  });

  /**
   * WKH-318 — T-SRC-06.
   *
   * `/capabilities` replicaba el bug de `/discover`: publicaba `registries` sin
   * decir si esos registros habían contestado. Se agregan `catalogStatus` y
   * `sources`, y se congela que el agregado es ADITIVO: los campos previos
   * conservan nombre Y valor.
   *
   * Nota de medición: el story file dice "los 11 campos previos"; los campos
   * previos REALES son 12 (`name`, `description`, `url`, `protocol`,
   * `capabilities`, `methods`, `inputModes`, `outputModes`, `chains`, `agents`,
   * `agentsTotal`, `registries`). Se asserta el conjunto medido, no el estimado.
   */
  it('T-SRC-06: expone catalogStatus + sources y conserva los 12 campos previos con el mismo nombre y valor', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValueOnce({
      agents: [],
      total: 0,
      // La fuente contestó 400: no aportó filas, así que no está acá...
      registries: [],
      // ...pero su estado SÍ es legible, que es todo el punto de la HU.
      sources: [
        {
          name: 'WasiAI',
          state: 'failed',
          rows: null,
          failure: 'http_error',
        },
      ],
      catalogStatus: 'partial',
    });

    const body = await getBody();

    // (a) lo nuevo llega.
    expect(body.catalogStatus).toBe('partial');
    expect(body.sources).toEqual([
      { name: 'WasiAI', state: 'failed', rows: null, failure: 'http_error' },
    ]);

    // (b) lo viejo no se movió — campo por campo, no un toMatchObject laxo.
    expect(body.name).toBe('wasiai-a2a');
    expect(body.description).toBe('test');
    expect(body.url).toBe('http://localhost:3001');
    expect(body.protocol).toBe('a2a');
    expect(body.capabilities).toEqual({});
    expect(body.methods).toEqual([]);
    expect(body.inputModes).toEqual([]);
    expect(body.outputModes).toEqual([]);
    expect(Array.isArray(body.chains)).toBe(true);
    expect(body.agents).toEqual([]);
    expect(body.agentsTotal).toBe(0);
    expect(body.registries).toEqual([]);

    // (c) y no apareció ni desapareció NINGÚN otro campo.
    expect(Object.keys(body).sort()).toEqual(
      [
        'agents',
        'agentsTotal',
        'capabilities',
        'catalogStatus',
        'chains',
        'description',
        'inputModes',
        'methods',
        'name',
        'outputModes',
        'protocol',
        'registries',
        'sources',
        'url',
      ].sort(),
    );
  });
});
