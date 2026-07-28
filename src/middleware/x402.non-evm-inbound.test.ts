/**
 * HU-204 — cobro x402 de ENTRADA sobre una chain OUTBOUND-ONLY (rail Solana).
 *
 * ─── POR QUÉ ESTE ARCHIVO EXISTE (y por qué 3.8k tests verdes no vieron el 500) ──
 *
 * El bug era: `POST /compose` con `x-payment-chain: solana-devnet` y sin
 * credencial devolvía 500 INTERNAL_ERROR. El camino:
 *   x402.ts (guard del bundle) acepta `solana-devnet` (existe e inicializado)
 *     → `buildX402Response` → `getPaymentAdapter()` → THROW (non-EVM, registry.ts)
 *       → error-boundary → 500.
 *
 * La suite no lo veía por una razón ESTRUCTURAL, no por falta de casos: no
 * existía NI UN test en la intersección "registry REAL con Solana inicializado"
 * × "middleware x402".
 *
 *  · `x402.chain-aware.test.ts:80` hace `vi.mock('../adapters/registry.js', …)`:
 *    su `getPaymentAdapter` es un `vi.fn()` que devuelve un stub EVM y NUNCA
 *    lanza, así que el throw real es inalcanzable desde ahí. Sus dos tests
 *    "de Solana" (`:301`, `:712`) usan el slug `solana-mainnet`, que NO está en
 *    `SLUG_ALIASES` (`chain-resolver.ts:61-66`) — o sea que ejercitan el camino
 *    CONTRARIO (slug irreconocible → 400), no el bundle Solana.
 *  · `adapters/__tests__/registry.test.ts:1050` sí alcanza el throw, pero
 *    llamando a `getPaymentAdapter()` directo: nunca pasa por un request HTTP,
 *    así que no puede ver en qué status termina.
 *
 * Este archivo cierra esa intersección con el patrón de `registry.test.ts`:
 * el registry es REAL (no se moquea) y sólo se moquean las FACTORIES de cada
 * chain, que es lo que evita abrir clientes RPC. Por eso acá `initAdapters()`
 * construye bundles de verdad, `getAdaptersBundle('solana-devnet')` devuelve un
 * bundle con `vmFamily: 'solana'` y `getPaymentAdapter('solana-devnet')`
 * lanzaría — exactamente la condición de producción.
 *
 * Naming: T-204-01..T-204-08.
 */

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';

// ── Factories moqueadas (el REGISTRY queda REAL — ver cabecera) ─────────────

vi.mock('../adapters/solana/index.js', () => ({
  createSolanaAdapters: vi.fn(async () => ({
    payment: {
      name: 'solana',
      vmFamily: 'solana',
      caip2ChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      supportedTokens: [{ symbol: 'USDC', mint: 'Es9vMFrz', decimals: 6 }],
      getScheme: () => 'spl-transfer',
      getNetwork: () => 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      getMaxTimeoutSeconds: () => 60,
      getMerchantName: () => 'wasiai-a2a-test',
      quote: async () => ({ amountWei: '1000000' }),
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
      getToken: () => '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      getScheme: () => 'exact',
      getNetwork: () => 'eip155:84532',
      getMaxTimeoutSeconds: () => 60,
      getMerchantName: () => 'wasiai-a2a-test',
      quote: async () => ({ amountWei: '1000000' }),
      verify: async () => ({ valid: true }),
      settle: async () => ({ txHash: '0xbeef', success: true }),
      sign: async () => ({ signature: '0x00' }),
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

// ── Capa de datos: mocks mínimos para que importar rutas/servicios no abra
//    conexiones y para poder ejercitar el path prepago sin DB. ───────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

const mockLookupByHash = vi.fn();
vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: (...a: unknown[]) => mockLookupByHash(...a),
    deactivate: vi.fn(),
  },
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

const mockDebit = vi.fn();
const mockGetBalance = vi.fn();
vi.mock('../services/budget.js', () => ({
  budgetService: {
    debit: (...a: unknown[]) => mockDebit(...a),
    getBalance: (...a: unknown[]) => mockGetBalance(...a),
    registerDeposit: vi.fn(),
  },
}));

vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../middleware/rate-limit.js', async (orig) => ({
  ...(await orig<typeof import('./rate-limit.js')>()),
  orchestrateRateLimit: () => false,
}));

// `/compose` resuelve el precio del step-0 ANTES del middleware de cobro
// (`routes/compose.ts:resolveComposePriceHandler`) y eso pega contra el
// registry de agentes. Se stubea SÓLO ese seam: es lo mínimo para que el
// request LLEGUE al choke-point de cobro, que es lo que este archivo prueba.
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(async () => 0.5),
  resolveAgentDestination: vi.fn(async () => ({
    slug: 'probe-agent',
    registry: 'wasiai',
    payment: { chain: 'base-sepolia', payTo: null },
  })),
}));

import {
  _resetRegistry,
  getAdaptersBundle,
  getInboundPaymentChainKeys,
  getPaymentAdapter,
  initAdapters,
} from '../adapters/registry.js';
import composeRoutes from '../routes/compose.js';
import orchestrateRoutes from '../routes/orchestrate.js';
import { requirePaymentOrA2AKey } from './a2a-key.js';
import { registerErrorBoundary } from './error-boundary.js';
import {
  requirePayment,
  X_A2A_PAYMENT_CHAIN_HEADER,
  X402_INBOUND_UNSUPPORTED_CODE,
} from './x402.js';

interface ErrorBody {
  error_code: string;
  error: string;
  inbound_payment_chains?: string[];
  /** Campo del error-boundary (`code: 'INTERNAL_ERROR'`), NO del guard. */
  code?: string;
}

const TEST_KEY = 'wasi_a2a_test_key_204';

function makeKeyRow(): A2AAgentKeyRow {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    owner_ref: 'user-204',
    key_hash: 'deadbeef',
    display_name: 'Test Key',
    budget: { '900001': '10.000000' },
    daily_limit_usd: null,
    daily_spent_usd: '0.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
  };
}

/**
 * App mínima que expone la MISMA cadena de cobro que las 5 rutas cobrables.
 *
 * `registerErrorBoundary` NO es decorado: es EL componente que convertía el
 * throw de `getPaymentAdapter` en el 500 INTERNAL_ERROR de producción
 * (`error-boundary.ts:114-123`, rama 4). Sin él, un Fastify pelado devuelve el
 * error con el `reply.statusCode` que `buildX402Response` ya había dejado en 402
 * — o sea que el test mediría un síntoma que en prod no existe y "no-5xx" no
 * probaría nada. Con el boundary puesto, sacar el guard reproduce el 500 REAL.
 */
function buildX402App(): ReturnType<typeof Fastify> {
  const app = Fastify();
  registerErrorBoundary(app);
  app.post(
    '/charged',
    { preHandler: requirePayment({ description: 'test' }) },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.send({ ok: true }),
  );
  return app;
}

describe('HU-204 — x402 inbound sobre chain outbound-only (registry REAL)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetRegistry();
    process.env.SOLANA_ADAPTER_ENABLED = 'true';
    process.env.WASIAI_A2A_CHAINS = 'base-sepolia,solana-devnet';
    process.env.KITE_WALLET_ADDRESS =
      '0x000000000000000000000000000000000000dEaD';
    delete process.env.PAYMENT_WALLET_ADDRESS;
    delete process.env.WASIAI_V2_FORWARD_KEY;
    await initAdapters();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetRegistry();
  });

  // ── T-204-01: la PRECONDICIÓN del archivo ─────────────────────────────────
  // Sin esto, todo lo de abajo podría estar verde por no haber alcanzado nunca
  // el bundle Solana (que es exactamente el falso verde de la suite anterior).

  it('T-204-01: el registry REAL tiene el bundle Solana y getPaymentAdapter() sobre él LANZA', () => {
    const bundle = getAdaptersBundle('solana-devnet');
    expect(bundle?.payment.vmFamily).toBe('solana');
    // La bomba que producía el 500: este accessor es EVM-only por diseño.
    expect(() => getPaymentAdapter('solana-devnet')).toThrow(
      /resolved a non-EVM \(solana\) adapter/,
    );
    // Y la chain EVM del mismo proceso sigue viva.
    expect(getPaymentAdapter('base-sepolia').chainId).toBe(84532);
    expect(getInboundPaymentChainKeys()).toEqual(['base-sepolia']);
  });

  // ── T-204-02: el corte — 400, NO 5xx ──────────────────────────────────────

  it('T-204-02: x-payment-chain=solana-devnet sin credencial → 400 estable, nunca 5xx', async () => {
    const app = buildX402App();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/charged',
        headers: { 'x-payment-chain': 'solana-devnet' },
        payload: {},
      });

      // La aserción que define la HU: el gateway NO se rompe.
      expect(res.statusCode).toBeLessThan(500);
      expect(res.statusCode).toBe(400);

      const body = JSON.parse(res.body) as ErrorBody;
      expect(body.error_code).toBe(X402_INBOUND_UNSUPPORTED_CODE);
      // Y NO el genérico del error-boundary (que usa `code`, no `error_code`):
      // el 500 de prod salía con `{ code: 'INTERNAL_ERROR' }`.
      expect(body.code).toBeUndefined();
      // El eco de la chain resuelta se conserva en la salida de error.
      expect(res.headers[X_A2A_PAYMENT_CHAIN_HEADER]).toBe('solana-devnet');
    } finally {
      await app.close();
    }
  });

  // ── T-204-03: el mensaje tiene que ser RESOLUBLE leyéndolo ────────────────

  it('T-204-03: el 400 explica la asimetría, lista las chains de entrada y ofrece la salida prepaga', async () => {
    const app = buildX402App();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/charged',
        headers: { 'x-payment-chain': 'solana-devnet' },
        payload: {},
      });
      const body = JSON.parse(res.body) as ErrorBody;

      // (a) NIEGA la dirección correcta, no la chain entera.
      expect(body.error).toMatch(/INBOUND/);
      expect(body.error).toMatch(/OUTBOUND settlement rail/);
      expect(body.error).toMatch(/the gateway pays agents/i);
      // (b) da la alternativa CONCRETA, derivada del registry vivo.
      expect(body.error).toContain('base-sepolia');
      expect(body.inbound_payment_chains).toEqual(['base-sepolia']);
      // (c) y la segunda salida: la key prepaga SÍ cobra en esta chain.
      expect(body.error).toMatch(/x-a2a-key/);
    } finally {
      await app.close();
    }
  });

  // ── T-204-04: NO se rompió el camino EVM (mismo proceso, registry real) ───

  it('T-204-04: x-payment-chain=base-sepolia sigue devolviendo el challenge 402', async () => {
    const app = buildX402App();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/charged',
        headers: { 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(402);
      const body = JSON.parse(res.body) as {
        accepts: Array<{ network: string; maxAmountRequired: string }>;
      };
      expect(body.accepts[0]?.network).toBe('eip155:84532');
    } finally {
      await app.close();
    }
  });

  // ── T-204-05/06: los endpoints REALES (no una ruta de laboratorio) ────────
  // `/orchestrate` y `/orchestrate/plan` entran por el MISMO choke-point
  // (`requirePaymentOrA2AKey` → `requirePayment`) que `/compose`,
  // `/orchestrate/execute` y `/gasless/transfer`.

  it.each([
    ['T-204-05', '/orchestrate'],
    ['T-204-06', '/orchestrate/plan'],
  ])('%s: POST %s con x-payment-chain=solana-devnet → 400, no 500', async (_id, url) => {
    const app = Fastify();
    // Mismo boundary que `src/index.ts:109` — ver buildX402App.
    registerErrorBoundary(app);
    await app.register(orchestrateRoutes, { prefix: '/orchestrate' });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-payment-chain': 'solana-devnet' },
        payload: { goal: 'do something', budget: 5 },
      });
      expect(res.statusCode).toBeLessThan(500);
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as ErrorBody).error_code).toBe(
        X402_INBOUND_UNSUPPORTED_CODE,
      );
    } finally {
      await app.close();
    }
  });

  // ── T-204-08: `/compose`, el endpoint del reporte original ────────────────
  // Es el que devolvía el 500 en prod. Llega más tarde al choke-point que
  // `/orchestrate` (antes pasa por la validación de body y la resolución de
  // precio del step-0), así que se cubre aparte: un reordenamiento futuro de
  // esos preHandlers que dejara el cobro antes del guard rompe ACÁ.

  it('T-204-08: POST /compose con x-payment-chain=solana-devnet → 400, no el 500 del reporte', async () => {
    const app = Fastify();
    registerErrorBoundary(app);
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        headers: { 'x-payment-chain': 'solana-devnet' },
        payload: { steps: [{ agent: 'probe-agent', input: {} }] },
      });
      expect(res.statusCode).toBeLessThan(500);
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as ErrorBody).error_code).toBe(
        X402_INBOUND_UNSUPPORTED_CODE,
      );
    } finally {
      await app.close();
    }
  });

  // ── T-204-07: NO-REGRESIÓN del camino prepago (lo que usa la demo) ────────
  // El guard vive dentro de `requirePayment`, y `requirePaymentOrA2AKey` sólo
  // delega ahí cuando NO hay `x-a2a-key` (a2a-key.ts:1606). Si el guard se
  // hubiera puesto un nivel más arriba, esta chain quedaría muerta también para
  // el prepago, que es el ÚNICO camino que hoy cobra en Solana.

  it('T-204-07: con x-a2a-key, solana-devnet sigue resolviendo chainId 900001 (sin 400)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    const app = Fastify();
    app.post(
      '/charged',
      { preHandler: requirePaymentOrA2AKey({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/charged',
        headers: { 'x-payment-chain': 'solana-devnet', 'x-a2a-key': TEST_KEY },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers[X_A2A_PAYMENT_CHAIN_HEADER]).toBe('solana-devnet');
      // El débito se aplicó CONTRA la chain Solana: 900001, el chainId del
      // bundle real (sentinel sintético del rail, DT-8).
      expect(mockDebit).toHaveBeenCalledTimes(1);
      expect(mockDebit.mock.calls[0]?.[1]).toBe(900001);
    } finally {
      await app.close();
    }
  });
});
