/**
 * HU-204 · WKH-314 — cobro x402 de ENTRADA sobre una chain non-EVM cuyo rail de
 * entrada está APAGADO (hoy `solana-devnet`, sin las envs del inbound).
 *
 * ─── QUÉ AFIRMA ESTE ARCHIVO, Y QUÉ DEJÓ DE AFIRMAR ────────────────────────
 *
 * Nació con HU-204: `POST /compose` con `x-payment-chain: solana-devnet` y sin
 * credencial devolvía 500 INTERNAL_ERROR. El camino:
 *   x402.ts (guard del bundle) acepta `solana-devnet` (existe e inicializado)
 *     → `buildX402Response` → `getPaymentAdapter()` → THROW (non-EVM, registry.ts)
 *       → error-boundary → 500.
 *
 * El corte a 400 no se aflojó y estos tests siguen exigiendo lo mismo. Lo que
 * WKH-314 cambió es POR QUÉ: el gateway YA tiene código para cobrar inbound en
 * Solana, así que el 400 de acá es el estado de la CONFIGURACIÓN de este proceso
 * (las envs del rail sin setear), NO una propiedad de la chain ni "una mitad que
 * nunca existió". Por eso el archivo se reescribió en vez de borrarse: la
 * exigencia se conserva, la afirmación se invierte. El control que lo vuelve
 * falsable es T-204-09 — enciende las cuatro envs en el MISMO proceso y el MISMO
 * registry pasa a listar `solana-devnet` como chain de ENTRADA, sin tocar código.
 *
 * ─── POR QUÉ EL REGISTRY ES REAL ──────────────────────────────────────────
 *
 * La suite no veía el 500 por una razón ESTRUCTURAL: no existía NI UN test en la
 * intersección "registry REAL con Solana inicializado" × "middleware x402"
 * (`x402.chain-aware.test.ts:80` moquea el registry entero, y sus dos tests "de
 * Solana" usan el slug `solana-mainnet`, que ni siquiera es reconocible).
 * Acá el registry es REAL y sólo se moquean las FACTORIES de cada chain, que es
 * lo que evita abrir clientes RPC: `initAdapters()` construye bundles de verdad,
 * `getAdaptersBundle('solana-devnet')` da `vmFamily: 'solana'` y
 * `getPaymentAdapter('solana-devnet')` lanzaría — la condición de producción.
 *
 * Naming: T-204-01..T-204-09.
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

describe('HU-204 · WKH-314 — x402 inbound sobre chain non-EVM con el rail de entrada APAGADO (registry REAL)', () => {
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

  it('T-204-01: el registry REAL tiene el bundle non-EVM, getPaymentAdapter() sobre él LANZA, y con las envs del rail sin setear el inbound no lo lista', () => {
    const bundle = getAdaptersBundle('solana-devnet');
    expect(bundle?.payment.vmFamily).toBe('solana');
    // La bomba que producía el 500: este accessor es EVM-only por diseño.
    expect(() => getPaymentAdapter('solana-devnet')).toThrow(
      /resolved a non-EVM \(solana\) adapter/,
    );
    expect(getPaymentAdapter('base-sepolia').chainId).toBe(84532);
    // Ese `['base-sepolia']` es config, no naturaleza: T-204-09 lo invierte.
    expect(getInboundPaymentChainKeys()).toEqual(['base-sepolia']);
  });

  // ── T-204-09: la INVERSIÓN por diseño (WKH-314) ───────────────────────────
  // El `false` de T-204-01 no es la naturaleza de la chain: es la config de ESTE
  // proceso. Se encienden las cuatro envs del rail —sin re-inicializar adapters,
  // sin tocar una línea de código— y el MISMO registry pasa a listar
  // `solana-devnet` como chain de ENTRADA. Es, medido, la frase que el 400 le
  // promete al integrador: *"ask this deployment's operator to turn the inbound
  // rail on"*. Lo que pasa DESPUÉS de encenderlo (challenge, prueba, consumo)
  // vive en `x402.solana-inbound.test.ts`; acá se mide sólo el interruptor.

  it('T-204-09: con las cuatro envs del rail seteadas, el MISMO proceso pasa a listar solana-devnet como chain de entrada', () => {
    expect(getInboundPaymentChainKeys()).toEqual(['base-sepolia']);

    // `SOLANA_ADAPTER_ENABLED` ya está en 'true' desde el beforeEach; faltan las
    // tres del inbound. La `payTo` es una pubkey base58 real (el mint de wSOL):
    // `getSolanaInboundPayTo()` devuelve `null` si no lo es, y el secreto tiene
    // largo mínimo, así que una config a medias NO enciende nada.
    process.env.SOLANA_X402_INBOUND_ENABLED = 'true';
    process.env.SOLANA_X402_INBOUND_PAY_TO =
      'So11111111111111111111111111111111111111112';
    process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET = 'k'.repeat(48);

    expect(getInboundPaymentChainKeys()).toEqual([
      'base-sepolia',
      'solana-devnet',
    ]);

    // Y el interruptor es REVERSIBLE en el mismo proceso: no hay estado pegado.
    process.env.SOLANA_X402_INBOUND_ENABLED = 'false';
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

  // ── T-204-03: el mensaje tiene que ser RESOLUBLE leyéndolo, y CIERTO ──────
  // Acá estaba clavada la frase que el F4 (§6.2) midió engañosa: el 400 decía
  // *"It is an OUTBOUND settlement rail … the inbound leg needs an EVM signed
  // authorization (EIP-3009), which this chain's payment adapter does not
  // implement"* — presentado como propiedad DEL CÓDIGO, que es exactamente lo
  // que el README dice que NO es. Este test lo fija en las dos direcciones: lo
  // que el mensaje DEBE decir, y lo que ya no puede volver a decir.

  it('T-204-03: el 400 acota la negación a ESTE deployment, la llama CONFIGURACIÓN y nombra las TRES salidas', async () => {
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

      // (a) NIEGA la dirección correcta, y ACOTADA en el tiempo y al deploy.
      expect(body.error).toMatch(/INBOUND/);
      expect(body.error).toMatch(/on this deployment right now/);
      // (b) el condicional va DENTRO de la afirmación, no en una nota al pie.
      expect(body.error).toMatch(
        /CONFIGURATION state, not a limit of the code/,
      );
      // (c) la asimetría, sin inventarle una causa al código.
      expect(body.error).toMatch(/OUTBOUND leg is unaffected/);
      expect(body.error).toMatch(/still pays agents/i);
      // (d) SALIDA 1: la alternativa CONCRETA, derivada del registry vivo.
      expect(body.error).toContain('base-sepolia');
      expect(body.inbound_payment_chains).toEqual(['base-sepolia']);
      // (e) SALIDA 2: la key prepaga SÍ cobra en esta chain.
      expect(body.error).toMatch(/x-a2a-key/);
      // (f) SALIDA 3 (la que WKH-314 hizo existir): pedirle al operador que lo
      //     encienda, con el efecto prometido — el mismo request da 402.
      expect(body.error).toMatch(/turn the inbound rail on/);
      expect(body.error).toMatch(/answers 402 instead of 400/);
      // (g) 🔴 Y LO QUE YA NO PUEDE DECIR. Estas tres frases eran propiedades
      //     DEL CÓDIGO y desde WKH-314 son falsas: el camino inbound existe y
      //     está apagado por configuración. Si alguien las reintroduce, acá se
      //     pone rojo antes de que vuelvan a salir en producción.
      expect(body.error).not.toMatch(/OUTBOUND settlement rail/);
      expect(body.error).not.toMatch(/EIP-3009/);
      expect(body.error).not.toMatch(/does not implement/);
      // (h) y el mensaje NO nombra a Solana: esta función la comen todas las
      //     chains non-EVM, y un texto Solana-only mentiría en la próxima.
      expect(body.error).not.toMatch(/solana(?!-devnet)/i);
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
  // el prepago, que hoy —con el rail de entrada apagado— es el único que cobra.

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
