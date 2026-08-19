/**
 * WKH-314 — el cobro x402 de ENTRADA sobre el rail Solana, end-to-end del middleware.
 *
 * ─── POR QUE ESTE ARCHIVO Y NO UN CASO MAS EN `x402.non-evm-inbound.test.ts` ──
 *
 * Aquella suite fija el comportamiento de HU-204: con Solana como rail
 * outbound-only, un cobro entrante da **400 `CHAIN_INBOUND_PAYMENT_UNSUPPORTED`**.
 * Esta HU invierte esa expectativa **sólo cuando el camino está configurado**, y la
 * regla de la casa es no reescribir la suite que uno vuelve obsoleta: aquélla queda
 * **verde e intacta** (con el flag apagado sigue siendo la verdad), y las expectativas
 * nuevas viven acá.
 *
 * El registry es **REAL** (mismo patrón que la suite hermana): sólo se moquean las
 * factories de cada chain, así que `getAdaptersBundle('solana-devnet')` devuelve un
 * bundle con `vmFamily: 'solana'` y `getPaymentAdapter('solana-devnet')` seguiría
 * lanzando — exactamente la condición de producción. Si la bifurcación de esta HU no
 * cortara ANTES, estos tests darían 500.
 *
 * ── QUE SE MOQUEA Y POR QUE ────────────────────────────────────────────────
 *
 * La cadena y el store, porque son los dos sistemas externos. **No** se moquea el
 * challenge: el HMAC es real, así que una referencia forjada se rechaza acá por el
 * mismo motivo por el que se rechazaría en producción.
 *
 * Naming: T-CAP-*, T-CHALX-*, T-GRANT-*, T-REPLAY-*, T-SHORT-*, T-TERMS-*, T-UNK-*,
 * T-RETRY-*, T-NOCONS-*, T-CACHE-*, T-KEY-*.
 */

import { Keypair } from '@solana/web3.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Factories moqueadas (el REGISTRY queda REAL) ───────────────────────────

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

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

/** Los dobles devuelven una forma LAXA a propósito: cada test arma la respuesta del
 * sistema externo que ejercita, y tiparla al tipo real acá obligaría a construir
 * uniones completas para fijar UN campo. */
type Loose = Record<string, unknown>;
const trackMock = vi.hoisted(() =>
  vi.fn(async (_ev: Loose): Promise<void> => undefined),
);
vi.mock('../services/event.js', () => ({
  eventService: { track: trackMock },
}));

// ── La cadena y el store: los dos sistemas externos ────────────────────────

const preflightMock = vi.hoisted(() =>
  vi.fn(async (): Promise<Loose> => ({ ok: true })),
);
vi.mock('../adapters/solana/inbound-preflight.js', () => ({
  ensureSolanaInboundReady: preflightMock,
  warmSolanaInboundPreflight: vi.fn(),
}));

/** El doble del RPC declara sus DOS parámetros a propósito: T-STEAL-02 modela una
 * cadena que sólo conoce la referencia que de verdad viaja en la transacción, y sin el
 * `args` declarado `mockImplementation` no compila. */
const probeMock = vi.hoisted(() =>
  vi.fn(async (_connection?: unknown, _args?: Loose): Promise<Loose> => ({})),
);
vi.mock('../adapters/solana/inbound-presence.js', () => ({
  probeInboundProof: probeMock,
}));

const peekMock = vi.hoisted(() =>
  vi.fn(async (): Promise<Loose> => ({ state: 'none' })),
);
const observeMock = vi.hoisted(() =>
  vi.fn(async (): Promise<Loose> => ({ outcome: 'observed', attempts: 1 })),
);
const consumeMock = vi.hoisted(() =>
  // Tipa el ARGUMENTO además del retorno: T-GRANT-01 afirma sobre los términos que
  // se le mandan al store (CD-9, el doble captura sus argumentos), y sin el parámetro
  // declarado `mock.calls[0]` es una tupla vacía para el compilador.
  vi.fn(async (_args: Loose): Promise<Loose> => ({ outcome: 'consumed' })),
);
vi.mock('../services/solana-inbound-proof.js', () => ({
  peekInboundProof: peekMock,
  recordInboundObserved: observeMock,
  consumeInboundProof: consumeMock,
  probeInboundProofStore: vi.fn(async () => ({ probe: 'ok' })),
}));

// AC-9: los DOS espías que prueban que este camino no toca ninguna clave privada
// ni transmite nada. Se instalan sobre el módulo REAL de `chain.js`.
const operatorKeypairSpy = vi.hoisted(() => vi.fn());
const sendRawTransactionSpy = vi.hoisted(() => vi.fn());
vi.mock('../adapters/solana/chain.js', async () => {
  const actual = await vi.importActual<
    typeof import('../adapters/solana/chain.js')
  >('../adapters/solana/chain.js');
  return {
    ...actual,
    getSolanaOperatorKeypair: (...a: unknown[]) => {
      operatorKeypairSpy(...a);
      return actual.getSolanaOperatorKeypair();
    },
    getSolanaConnection: () => ({
      sendRawTransaction: sendRawTransactionSpy,
      sendTransaction: sendRawTransactionSpy,
    }),
  };
});

import {
  _resetRegistry,
  acceptsInboundPayment,
  getAdaptersBundle,
  initAdapters,
} from '../adapters/registry.js';
import { base58Encode } from '../adapters/solana/base58.js';
import { _resetSolanaChain } from '../adapters/solana/chain.js';
import { registerErrorBoundary } from './error-boundary.js';
import { createTimeoutHandler } from './timeout.js';
import { requirePayment } from './x402.js';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = Keypair.generate().publicKey.toBase58();
const CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** Una firma base58 de 64 bytes exactos (CD-12: derivada, no `'x'.repeat(88)`). */
function signatureFixture(seed = 3): string {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bytes[i] = ((i * 5 + seed * 11) % 254) + 1;
  return base58Encode(bytes);
}

interface Accepts {
  network: string;
  mint?: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  resource: string;
  extra: {
    reference: string;
    issuedAt: number;
    expiresAt: number;
    /** Entropía por EMISION (fix BLQ-ALTO-2). El pagador la eco-repite. */
    nonce?: string;
  };
}
interface Body402 {
  error: string;
  error_code?: string;
  accepts: Accepts[];
}

function buildApp(): ReturnType<typeof Fastify> {
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

/**
 * Un app cuya ruta calcula el precio DESDE EL BODY, que es lo que `/compose` hace en
 * producción: un preHandler setea `request.x402ChallengeAmountUsd` (`x402.ts:1030-1033`)
 * ANTES de `requirePayment`. El `resource` sigue siendo `/charged` a secas, así que dos
 * requests con precios distintos comparten recurso — exactamente la condición de
 * BLQ-ALTO-1.
 */
function buildPricedApp(): ReturnType<typeof Fastify> {
  const app = Fastify();
  registerErrorBoundary(app);
  app.post(
    '/charged',
    {
      preHandler: [
        async (req: FastifyRequest) => {
          const body = req.body as { priceUsd?: number } | undefined;
          if (typeof body?.priceUsd === 'number') {
            req.x402ChallengeAmountUsd = body.priceUsd;
          }
        },
        ...requirePayment({ description: 'test' }),
      ],
    },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.send({ ok: true }),
  );
  return app;
}

/** El 402 inicial: de acá salen la referencia y la ventana REALES. */
async function getChallenge(
  app: ReturnType<typeof Fastify>,
  payload: Record<string, unknown> = {},
): Promise<Accepts> {
  const res = await app.inject({
    method: 'POST',
    url: '/charged',
    headers: { 'x-payment-chain': 'solana-devnet' },
    payload,
  });
  const body = res.json() as Body402;
  const first = body.accepts[0];
  if (!first) throw new Error(`no challenge in 402: ${res.body}`);
  return first;
}

function envelope(
  c: Accepts,
  signature: string,
  over: Record<string, unknown> = {},
) {
  return Buffer.from(
    JSON.stringify({
      authorization: {
        reference: c.extra.reference,
        payTo: c.payTo,
        amountAtomic: c.maxAmountRequired,
        mint: c.asset,
        issuedAt: c.extra.issuedAt,
        expiresAt: c.extra.expiresAt,
        nonce: c.extra.nonce,
        ...over,
      },
      signature,
      network: c.network,
    }),
  ).toString('base64');
}

async function present(
  app: ReturnType<typeof Fastify>,
  header: string,
  payload: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: Body402 & { ok?: boolean };
  retryAfter?: string;
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/charged',
    headers: { 'x-payment-chain': 'solana-devnet', 'x-payment': header },
    payload,
  });
  const out: {
    status: number;
    body: Body402 & { ok?: boolean };
    retryAfter?: string;
  } = { status: res.statusCode, body: res.json() };
  const ra = res.headers['retry-after'];
  if (typeof ra === 'string') out.retryAfter = ra;
  return out;
}

const FINALIZED_OK = {
  presence: { state: 'finalized_ok', creditedAtomic: '1000000' },
  binding: { state: 'bound', blockTime: 1_700_000_100 },
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  _resetRegistry();
  process.env.WASIAI_A2A_CHAINS = 'base-sepolia,solana-devnet';
  process.env.SOLANA_ADAPTER_ENABLED = 'true';
  process.env.SOLANA_X402_INBOUND_ENABLED = 'true';
  process.env.SOLANA_X402_INBOUND_PAY_TO = PAY_TO;
  process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET = 'k'.repeat(48);
  process.env.SOLANA_USDC_MINT_DEVNET = MINT;
  process.env.SOLANA_CAIP2_CHAIN_ID = CAIP2;
  process.env.KITE_WALLET_ADDRESS =
    '0x000000000000000000000000000000000000dEaD';
  delete process.env.PAYMENT_WALLET_ADDRESS;
  delete process.env.SOLANA_RPC_URL_FALLBACK;
  preflightMock.mockResolvedValue({ ok: true });
  peekMock.mockResolvedValue({ state: 'none' });
  observeMock.mockResolvedValue({ outcome: 'observed', attempts: 1 });
  consumeMock.mockResolvedValue({ outcome: 'consumed' });
  probeMock.mockResolvedValue(FINALIZED_OK);
  await initAdapters();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetRegistry();
});

describe('WKH-314 · la capacidad publicada y el guard concuerdan (AC-8)', () => {
  it('T-CAP-01 · con la config completa, Solana ACEPTA cobro de entrada', () => {
    const bundle = getAdaptersBundle('solana-devnet');
    expect(bundle?.payment.vmFamily).toBe('solana');
    expect(bundle && acceptsInboundPayment(bundle)).toBe(true);
  });

  it('T-CAP-02 💰 · con el flag APAGADO vuelve a ser `false` en el MISMO proceso', () => {
    process.env.SOLANA_X402_INBOUND_ENABLED = 'false';
    const bundle = getAdaptersBundle('solana-devnet');
    expect(bundle && acceptsInboundPayment(bundle)).toBe(false);
  });

  it('T-CAP-03 💰 · falta la `payTo` o el secreto ⇒ `false` (config incompleta no es capacidad)', () => {
    const bundle = getAdaptersBundle('solana-devnet');
    process.env.SOLANA_X402_INBOUND_PAY_TO = '';
    expect(bundle && acceptsInboundPayment(bundle)).toBe(false);
    process.env.SOLANA_X402_INBOUND_PAY_TO = PAY_TO;
    process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET = 'corto';
    expect(bundle && acceptsInboundPayment(bundle)).toBe(false);
  });

  it('T-CAP-04 💰 · el flag apagado deja el 400 de HU-204 EXACTAMENTE como estaba', async () => {
    process.env.SOLANA_X402_INBOUND_ENABLED = 'false';
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/charged',
      headers: { 'x-payment-chain': 'solana-devnet' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error_code: string;
      inbound_payment_chains: string[];
    };
    expect(body.error_code).toBe('CHAIN_INBOUND_PAYMENT_UNSUPPORTED');
    expect(body.inbound_payment_chains).toEqual(['base-sepolia']);
  });

  it('T-CAP-05 💰 · una chain EVM sigue cobrando igual, con el flag Solana encendido', () => {
    const bundle = getAdaptersBundle('base-sepolia');
    expect(bundle && acceptsInboundPayment(bundle)).toBe(true);
    // Y también con el flag apagado: el camino EVM no depende de nada de esta HU.
    process.env.SOLANA_X402_INBOUND_ENABLED = 'false';
    expect(bundle && acceptsInboundPayment(bundle)).toBe(true);
  });
});

describe('WKH-314 · el challenge (AC-1)', () => {
  it('T-CHALX-01 · el 402 trae la tupla Solana completa, y NO es un 500', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/charged',
      headers: { 'x-payment-chain': 'solana-devnet' },
      payload: {},
    });
    // Sin la bifurcación de esta HU, `getPaymentAdapter()` lanzaría y el
    // error-boundary lo convertiría en 500. Que sea 402 ES el corte.
    expect(res.statusCode).toBe(402);
    expect(res.headers['x-a2a-payment-chain']).toBe('solana-devnet');
    const c = (res.json() as Body402).accepts[0] as Accepts;
    expect(c.network).toBe(CAIP2);
    expect(c.asset).toBe(MINT);
    expect(c.payTo).toBe(PAY_TO);
    expect(typeof c.maxAmountRequired).toBe('string');
    expect(c.extra.reference).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(c.extra.expiresAt).toBeGreaterThan(c.extra.issuedAt);
  });

  it('T-CHALX-02 💰 · si el preflight NO está sano, NO se emite challenge pagable', async () => {
    // Invitar a pagar cuando no podemos verificar sería tomarle la plata al pagador.
    preflightMock.mockResolvedValue({
      ok: false,
      failure: 'store_table_missing',
      detail: 'x',
    });
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/charged',
      headers: { 'x-payment-chain': 'solana-devnet' },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    const body = res.json() as Body402;
    expect(body.error_code).toBe('X402_SETTLE_UNKNOWN');
    expect(body.accepts).toEqual([]);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('WKH-314 · el grant y el replay (AC-2, AC-3)', () => {
  it('T-GRANT-01 💰 · firma finalizada + términos + no reclamada ⇒ ACCESO, y consume', async () => {
    const app = buildApp();
    const c = await getChallenge(app);
    const sig = signatureFixture();
    const res = await present(app, envelope(c, sig));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // El consumo ocurrió, y con la firma correcta.
    expect(consumeMock).toHaveBeenCalledTimes(1);
    expect(consumeMock.mock.calls[0]?.[0]).toMatchObject({
      caip2: CAIP2,
      signature: sig,
      payTo: PAY_TO,
      reference: c.extra.reference,
    });
  });

  it('T-GRANT-02 💰 · el consumo ocurre ANTES de responder (se `await`ea)', async () => {
    const order: string[] = [];
    consumeMock.mockImplementation(async () => {
      order.push('consume');
      return { outcome: 'consumed' };
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    order.push('respond');
    expect(res.status).toBe(200);
    expect(order).toEqual(['consume', 'respond']);
  });

  it('T-REPLAY-01 💰 · segunda presentación de una firma ya cobrada ⇒ 402 REPLAY, sin servicio', async () => {
    peekMock.mockResolvedValue({ state: 'consumed' });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.status).toBe(402);
    expect(res.body.error_code).toBe('X402_SOLANA_PROOF_REPLAY');
    // Y no se re-consume ni se vuelve a preguntar a la cadena.
    expect(consumeMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('T-REPLAY-04 💰 · el perdedor de una carrera recibe REPLAY (lo decide el store)', async () => {
    consumeMock.mockResolvedValue({ outcome: 'replay' });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.status).toBe(402);
    expect(res.body.error_code).toBe('X402_SOLANA_PROOF_REPLAY');
  });

  it('T-REPLAY-05 💰 · la misma firma contra OTRO challenge es TERMS_MISMATCH, no replay', async () => {
    peekMock.mockResolvedValue({
      state: 'observed',
      terms: {
        reference: 'otra-referencia',
        resource: 'http://x/y',
        payTo: PAY_TO,
        amountAtomic: '1000000',
        mint: MINT,
      },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.body.error_code).toBe('X402_SOLANA_TERMS_MISMATCH');
    expect(consumeMock).not.toHaveBeenCalled();
  });
});

describe('WKH-314 · los rechazos con su motivo exacto (AC-4, AC-5, AC-6)', () => {
  it('T-SHORT-01 💰 · monto insuficiente ⇒ AMOUNT_SHORT, distinguible de replay y de unknown', async () => {
    probeMock.mockResolvedValue({
      presence: {
        state: 'terms_mismatch',
        detail: 'AMOUNT_SHORT: credited 1 …',
      },
      binding: { state: 'bound', blockTime: 1 },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.status).toBe(402);
    expect(res.body.error_code).toBe('X402_SOLANA_AMOUNT_SHORT');
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('T-TERMS-03 💰 · destino/mint equivocado ⇒ TERMS_MISMATCH, y NO AMOUNT_SHORT', async () => {
    probeMock.mockResolvedValue({
      presence: { state: 'terms_mismatch', detail: 'RECIPIENT_MISMATCH: …' },
      binding: { state: 'bound', blockTime: 1 },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.body.error_code).toBe('X402_SOLANA_TERMS_MISMATCH');
  });

  it('T-TERMS-05 💰 · una referencia FORJADA se rechaza SIN tocar la red (cero llamadas)', async () => {
    const app = buildApp();
    const c = await getChallenge(app);
    const forged = envelope(c, signatureFixture(), {
      reference: Keypair.generate().publicKey.toBase58(),
    });
    const res = await present(app, forged);
    expect(res.body.error_code).toBe('X402_SOLANA_REFERENCE_MISMATCH');
    // LA aserción del test: P2 va antes que P4, así que no se gastó una sola
    // llamada al RPC ni una lectura del store.
    expect(probeMock).not.toHaveBeenCalled();
    expect(peekMock).not.toHaveBeenCalled();
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('T-TERMS-04 💰 · estirar `expiresAt` en el sobre no extiende nada', async () => {
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(
      app,
      envelope(c, signatureFixture(), {
        expiresAt: c.extra.expiresAt + 999_999,
      }),
    );
    expect(res.body.error_code).toBe('X402_SOLANA_REFERENCE_MISMATCH');
  });

  it('T-MAL-01 💰 · una `signature` que no es base58 de 64 bytes ⇒ PROOF_MALFORMED', async () => {
    const app = buildApp();
    const c = await getChallenge(app);
    for (const bad of [
      'x'.repeat(88),
      'abc',
      base58Encode(new Uint8Array(32).fill(7)),
    ]) {
      const res = await present(app, envelope(c, bad));
      expect(res.body.error_code, bad.slice(0, 8)).toBe(
        'X402_SOLANA_PROOF_MALFORMED',
      );
    }
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('T-FAILX-01 💰 · una tx que falló on-chain ⇒ TX_FAILED, sin Retry-After', async () => {
    probeMock.mockResolvedValue({
      presence: { state: 'landed_failed', detail: '{"e":1}' },
      binding: { state: 'unknown', detail: 'x' },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.body.error_code).toBe('X402_SOLANA_TX_FAILED');
    expect(res.retryAfter).toBeUndefined();
  });

  it('T-UNK-02 💰 · el store mudo ⇒ SETTLE_UNKNOWN, y el reintento sigue siendo posible', async () => {
    peekMock.mockResolvedValue({ state: 'unknown', detail: 'fetch failed' });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.body.error_code).toBe('X402_SETTLE_UNKNOWN');
    expect(consumeMock).not.toHaveBeenCalled();
    expect(res.retryAfter).toBeDefined();
  });

  it('T-UNK-03b 💰 · la cadena que no contesta ⇒ SETTLE_UNKNOWN + evento durable', async () => {
    probeMock.mockResolvedValue({
      presence: { state: 'unknown', detail: 'ECONNRESET' },
      binding: { state: 'unknown', detail: 'x' },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const sig = signatureFixture();
    const res = await present(app, envelope(c, sig));
    expect(res.body.error_code).toBe('X402_SETTLE_UNKNOWN');
    // El canal ÚNICO del unknown: mismo `eventType` que el camino EVM, con la firma
    // y la referencia como claves de reconciliación.
    expect(trackMock).toHaveBeenCalled();
    const meta = trackMock.mock.calls[0]?.[0] as unknown as {
      eventType: string;
      metadata: Record<string, unknown>;
    };
    expect(meta.eventType).toBe('x402_settle_unknown');
    expect(meta.metadata.error_code).toBe('X402_SETTLE_UNKNOWN');
    expect(meta.metadata.signature).toBe(sig);
    expect(meta.metadata.reference).toBe(c.extra.reference);
    // Y en Solana no hay nonce EIP-3009: se manda `null`, no un campo inventado.
    expect(meta.metadata.authorizationNonce).toBeNull();
  });

  it('T-UNK-07b 💰 · un `track()` que TIRA no cambia la respuesta HTTP', async () => {
    trackMock.mockRejectedValue(new Error('events table down'));
    probeMock.mockResolvedValue({
      presence: { state: 'unknown', detail: 'x' },
      binding: { state: 'unknown', detail: 'x' },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.status).toBe(402);
    expect(res.body.error_code).toBe('X402_SETTLE_UNKNOWN');
  });

  it('T-ABSX-01 💰 · un nodo que buscó y no la conoce ⇒ PROOF_ABSENT, y el mensaje dice UNO', async () => {
    // ⚠️ ESTE TEST SE LLAMABA "dos nodos" Y MEDIA UNO: `SOLANA_RPC_URL_FALLBACK` está
    // borrada en el `beforeEach`, así que `combineInboundPresence` devuelve el veredicto
    // del primario tal cual. El mensaje afirmaba "two independent nodes searched" igual
    // (AR de WKH-314, BLQ-BAJO-1). El gemelo de dos nodos es T-ABSX-02.
    probeMock.mockResolvedValue({
      presence: { state: 'absent' },
      binding: { state: 'unknown', detail: 'x' },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.body.error_code).toBe('X402_SOLANA_PROOF_ABSENT');
    expect(res.retryAfter).toBeDefined();
    expect(res.body.error).toContain('one node searched');
    expect(res.body.error).not.toContain('two independent nodes');
    expect(probeMock).toHaveBeenCalledTimes(1);
  });

  it('T-ABSX-02 💰 · GEMELO: con segundo proveedor y los DOS `absent`, ahí sí son dos', async () => {
    process.env.SOLANA_RPC_URL_FALLBACK = 'https://devnet.example/rpc';
    _resetSolanaChain();
    try {
      probeMock.mockResolvedValue({
        presence: { state: 'absent' },
        binding: { state: 'unknown', detail: 'x' },
      });
      const app = buildApp();
      const c = await getChallenge(app);
      const res = await present(app, envelope(c, signatureFixture()));
      expect(res.body.error_code).toBe('X402_SOLANA_PROOF_ABSENT');
      expect(res.body.error).toContain('two independent nodes');
      // La prueba de que de verdad se le preguntó a los dos.
      expect(probeMock).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.SOLANA_RPC_URL_FALLBACK;
      _resetSolanaChain();
    }
  });

  it('T-FINAL-03 💰 · `confirmed` pero no `finalized` ⇒ NOT_FINALIZED, con Retry-After y SIN consumir', async () => {
    probeMock.mockResolvedValue({
      presence: { state: 'not_finalized', confirmationStatus: 'confirmed' },
      binding: { state: 'unknown', detail: 'x' },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.status).toBe(402);
    expect(res.body.error_code).toBe('X402_SOLANA_NOT_FINALIZED');
    expect(res.retryAfter).toBeDefined();
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('T-BINDX-01 💰 · la referencia no está en la tx ⇒ REFERENCE_MISMATCH (la "robada del explorer")', async () => {
    probeMock.mockResolvedValue({
      presence: { state: 'finalized_ok', creditedAtomic: '9999999' },
      binding: { state: 'reference_absent', detail: 'x' },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    // Una transferencia REAL a nuestra wallet, por el monto correcto, que no es de
    // este cobro. No se concede y no se consume.
    expect(res.body.error_code).toBe('X402_SOLANA_REFERENCE_MISMATCH');
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('T-BINDX-02 💰 · el binding indeterminado ⇒ SETTLE_UNKNOWN, JAMAS un grant', async () => {
    probeMock.mockResolvedValue({
      presence: { state: 'finalized_ok', creditedAtomic: '1000000' },
      binding: { state: 'unknown', detail: 'v0 sin loadedAddresses' },
    });
    const app = buildApp();
    const c = await getChallenge(app);
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.body.error_code).toBe('X402_SETTLE_UNKNOWN');
    expect(consumeMock).not.toHaveBeenCalled();
  });
});

describe('WKH-314 · las invariantes transversales', () => {
  /** Los 8 motivos de rechazo, cada uno con cómo se provoca. */
  const REJECTIONS: [string, () => void][] = [
    [
      'X402_SOLANA_TERMS_MISMATCH',
      () =>
        probeMock.mockResolvedValue({
          presence: { state: 'terms_mismatch', detail: 'RECIPIENT_MISMATCH' },
          binding: { state: 'bound', blockTime: 1 },
        }),
    ],
    [
      'X402_SOLANA_AMOUNT_SHORT',
      () =>
        probeMock.mockResolvedValue({
          presence: { state: 'terms_mismatch', detail: 'AMOUNT_SHORT' },
          binding: { state: 'bound', blockTime: 1 },
        }),
    ],
    [
      'X402_SOLANA_TX_FAILED',
      () =>
        probeMock.mockResolvedValue({
          presence: { state: 'landed_failed', detail: 'x' },
          binding: { state: 'bound', blockTime: 1 },
        }),
    ],
    [
      'X402_SOLANA_NOT_FINALIZED',
      () =>
        probeMock.mockResolvedValue({
          presence: { state: 'not_finalized', confirmationStatus: 'confirmed' },
          binding: { state: 'bound', blockTime: 1 },
        }),
    ],
    [
      'X402_SOLANA_PROOF_ABSENT',
      () =>
        probeMock.mockResolvedValue({
          presence: { state: 'absent' },
          binding: { state: 'bound', blockTime: 1 },
        }),
    ],
    [
      'X402_SETTLE_UNKNOWN',
      () =>
        probeMock.mockResolvedValue({
          presence: { state: 'unknown', detail: 'x' },
          binding: { state: 'bound', blockTime: 1 },
        }),
    ],
    [
      'X402_SOLANA_REFERENCE_MISMATCH',
      () =>
        probeMock.mockResolvedValue({
          presence: { state: 'finalized_ok', creditedAtomic: '1000000' },
          binding: { state: 'reference_absent', detail: 'x' },
        }),
    ],
    [
      'X402_SOLANA_CHALLENGE_EXPIRED',
      () =>
        probeMock.mockResolvedValue({
          presence: { state: 'finalized_ok', creditedAtomic: '1000000' },
          binding: { state: 'outside_window', detail: 'x' },
        }),
    ],
  ];

  it('T-NOCONS-01 💰 · en los OCHO motivos de rechazo la firma sigue gastable', async () => {
    for (const [code, arrange] of REJECTIONS) {
      vi.clearAllMocks();
      preflightMock.mockResolvedValue({ ok: true });
      peekMock.mockResolvedValue({ state: 'none' });
      observeMock.mockResolvedValue({ outcome: 'observed', attempts: 1 });
      arrange();
      const app = buildApp();
      const c = await getChallenge(app);
      const res = await present(app, envelope(c, signatureFixture()));
      expect(res.status, code).toBe(402);
      expect(res.body.error_code, code).toBe(code);
      // LA invariante: ningún camino que no concede escribe `consumed`.
      expect(consumeMock, code).not.toHaveBeenCalled();
    }
  });

  it('T-RETRY-01 · `Retry-After` SOLO en los tres reintentables', async () => {
    const retryable = new Set([
      'X402_SOLANA_NOT_FINALIZED',
      'X402_SOLANA_PROOF_ABSENT',
      'X402_SETTLE_UNKNOWN',
    ]);
    for (const [code, arrange] of REJECTIONS) {
      vi.clearAllMocks();
      preflightMock.mockResolvedValue({ ok: true });
      peekMock.mockResolvedValue({ state: 'none' });
      observeMock.mockResolvedValue({ outcome: 'observed', attempts: 1 });
      arrange();
      const app = buildApp();
      const c = await getChallenge(app);
      const res = await present(app, envelope(c, signatureFixture()));
      // Mandar `Retry-After` en un rechazo por monto corto sería mentirle al pagador:
      // por más que espere, esa transferencia nunca va a alcanzar.
      expect(res.retryAfter !== undefined, code).toBe(retryable.has(code));
    }
  });

  it('T-CACHE-01 💰 · una fila ya `observed` con los MISMOS términos ⇒ CERO llamadas a la cadena', async () => {
    const app = buildApp();
    const c = await getChallenge(app);
    peekMock.mockImplementation(async () => ({
      state: 'observed',
      terms: {
        reference: c.extra.reference,
        // El `resource` REAL del challenge: adivinarlo hizo fallar este test una vez,
        // y con razón — el `resource` es parte de los términos que el store compara.
        resource: c.resource,
        payTo: c.payTo,
        amountAtomic: c.maxAmountRequired,
        mint: c.asset,
      },
    }));
    const res = await present(app, envelope(c, signatureFixture()));
    expect(res.status).toBe(200);
    // La incertidumbre de la cadena se paga UNA vez en la vida del pago.
    expect(probeMock).not.toHaveBeenCalled();
    expect(observeMock).not.toHaveBeenCalled();
    expect(consumeMock).toHaveBeenCalledTimes(1);
  });

  it('T-KEY-01 💰 · CERO invocaciones de la clave privada del operador, en TODOS los caminos', async () => {
    const app = buildApp();
    const c = await getChallenge(app);
    const paths: (() => void)[] = [
      () => probeMock.mockResolvedValue(FINALIZED_OK),
      ...REJECTIONS.map(([, arrange]) => arrange),
    ];
    for (const arrange of paths) {
      arrange();
      await present(app, envelope(c, signatureFixture()));
    }
    // El gateway es TESTIGO, no tesorero: no firma nada en este camino.
    expect(operatorKeypairSpy).not.toHaveBeenCalled();
    expect(sendRawTransactionSpy).not.toHaveBeenCalled();
  });
});

/**
 * ─── LOS DOS AGUJEROS QUE EL AR ENCONTRO, Y QUE NINGUN MUTANTE PODIA CAZAR ───
 *
 * MNR-3 del AR, textual: *"los 29 `it()` derivan siempre el sobre del challenge del
 * mismo request. No hay un test con sobre emitido a **otro precio**, ni con **dos
 * callers** compartiendo referencia. Los 20 mutantes muertos no lo tocan porque ningún
 * mutante puede introducir un test que no existe."*
 *
 * Los dos de acá son exactamente esos dos, y por eso NO derivan el sobre del challenge
 * del request que atacan:
 *   · T-PRICE-01 emite el sobre en un request BARATO y lo presenta en uno CARO.
 *   · T-STEAL-01/02 emiten DOS challenges con términos idénticos en el MISMO segundo.
 */
describe('WKH-314 · el sobre viejo y el sobre ajeno (fix-pack del AR)', () => {
  it('T-PRICE-01 💰 · un sobre emitido a OTRO precio no paga ESTE request', async () => {
    // BLQ-ALTO-1. El precio del mismo `resource` varía por request (el body manda),
    // pero el MAC sólo prueba "este sobre lo emitimos nosotros", NO "este es el precio
    // de ahora". Sin el guard, 1 unidad atómica (0,000001 USDC) compra un pipeline de
    // 50 USDC, repetible, y sin reembolso inbound posible.
    const app = buildPricedApp();
    const cheap = await getChallenge(app, { priceUsd: 0.000001 });
    expect(cheap.maxAmountRequired).toBe('1');

    // El atacante transfirió DE VERDAD esa unidad atómica: la cadena lo confirma.
    probeMock.mockResolvedValue({
      presence: { state: 'finalized_ok', creditedAtomic: '1' },
      binding: { state: 'bound', blockTime: cheap.extra.issuedAt + 1 },
    });
    const res = await present(app, envelope(cheap, signatureFixture(7)), {
      priceUsd: 50,
    });

    expect(res.status).toBe(402);
    expect(res.body.error_code).toBe('X402_SOLANA_AMOUNT_SHORT');
    // Y el precio de ESTE request es el que manda: el sobre traía '1'.
    expect(res.body.accepts[0]?.maxAmountRequired).toBe('50000000');
    // Ni se gastó la cadena ni se cobró nada: el guard corta ANTES de P3.
    expect(probeMock).not.toHaveBeenCalled();
    expect(peekMock).not.toHaveBeenCalled();
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('T-PRICE-02 · el sobre del MISMO precio sigue cobrando (el guard no deniega todo)', async () => {
    // El control positivo del anterior: un guard que rechaza cualquier sobre también
    // pondría T-PRICE-01 en verde.
    const app = buildPricedApp();
    const c = await getChallenge(app, { priceUsd: 50 });
    expect(c.maxAmountRequired).toBe('50000000');
    const res = await present(app, envelope(c, signatureFixture(7)), {
      priceUsd: 50,
    });
    expect(res.status).toBe(200);
    expect(consumeMock).toHaveBeenCalledTimes(1);
  });

  it('T-PRICE-03 · pagar de MAS sigue concediendo (`>=`, nunca `!==`)', async () => {
    // Nadie paga de más por error y se queda sin servicio. Es la misma postura que el
    // guard EVM de `x402.ts:1217` (`BigInt(auth.value) < BigInt(requiredAmount)`).
    const app = buildPricedApp();
    const expensive = await getChallenge(app, { priceUsd: 50 });
    const res = await present(app, envelope(expensive, signatureFixture(7)), {
      priceUsd: 1,
    });
    expect(res.status).toBe(200);
    expect(consumeMock).toHaveBeenCalledTimes(1);
  });

  it('T-PRICE-04 💰 · un sobre emitido ANTES de rotar la wallet (o el mint) no cobra', async () => {
    // La otra mitad de BLQ-ALTO-1, y la que menos se ve: el MAC firma los términos que
    // el servidor emitió EN SU MOMENTO. Rotar `SOLANA_X402_INBOUND_PAY_TO` (o el mint)
    // dejaba 900 s de ventana en la que un sobre viejo seguía mandando el dinero a la
    // dirección anterior y el gateway lo aceptaba como pago.
    const app = buildApp();
    const beforeRotation = await getChallenge(app);

    const NEW_WALLET = Keypair.generate().publicKey.toBase58();
    process.env.SOLANA_X402_INBOUND_PAY_TO = NEW_WALLET;
    const rotated = await present(
      app,
      envelope(beforeRotation, signatureFixture(11)),
    );
    expect(rotated.status).toBe(402);
    expect(rotated.body.error_code).toBe('X402_SOLANA_TERMS_MISMATCH');
    expect(consumeMock).not.toHaveBeenCalled();

    // Y el mint, por el mismo camino.
    process.env.SOLANA_X402_INBOUND_PAY_TO = PAY_TO;
    const beforeMintChange = await getChallenge(app);
    process.env.SOLANA_USDC_MINT_DEVNET =
      Keypair.generate().publicKey.toBase58();
    const mintChanged = await present(
      app,
      envelope(beforeMintChange, signatureFixture(12)),
    );
    expect(mintChanged.body.error_code).toBe('X402_SOLANA_TERMS_MISMATCH');
    expect(consumeMock).not.toHaveBeenCalled();
    // GEMELO POSITIVO: sin rotación, el mismo sobre cobra.
    process.env.SOLANA_USDC_MINT_DEVNET = MINT;
    const c = await getChallenge(app);
    expect((await present(app, envelope(c, signatureFixture(13)))).status).toBe(
      200,
    );
  });

  it('T-STEAL-01 💰 · dos callers, mismos términos, MISMO segundo ⇒ referencias DISTINTAS', async () => {
    // BLQ-ALTO-2. El reloj se congela para MEDIR la premisa del ataque en vez de
    // esperar que ocurra: sin entropía por emisión, `issuedAt` idéntico ⇒ material del
    // MAC idéntico ⇒ referencia idéntica.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const app = buildApp();
    const victim = await getChallenge(app);
    const attacker = await getChallenge(app);
    // La PRECONDICION del ataque, medida y no supuesta.
    expect(attacker.extra.issuedAt).toBe(victim.extra.issuedAt);
    expect(attacker.maxAmountRequired).toBe(victim.maxAmountRequired);
    expect(attacker.payTo).toBe(victim.payTo);
    expect(attacker.asset).toBe(victim.asset);
    // Y lo que NO puede pasar aun así.
    expect(attacker.extra.reference).not.toBe(victim.extra.reference);
  });

  it('T-STEAL-02 💰 · el sobre del ATACANTE no cobra la transferencia de la VICTIMA', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const app = buildApp();
    const victim = await getChallenge(app);
    const attacker = await getChallenge(app);
    const victimSignature = signatureFixture(21);

    // La cadena modela la transferencia REAL de la víctima: la tx lleva la referencia
    // de la víctima y ninguna otra. Es lo único que el atacante no puede copiar — la
    // firma sí es pública desde que aterriza.
    probeMock.mockImplementation(
      async (_connection?: unknown, args?: Loose): Promise<Loose> =>
        args?.reference === victim.extra.reference
          ? FINALIZED_OK
          : {
              presence: { state: 'finalized_ok', creditedAtomic: '1000000' },
              binding: {
                state: 'reference_absent',
                detail: 'the reference is not among the accounts',
              },
            },
    );

    const stolen = await present(app, envelope(attacker, victimSignature));
    expect(stolen.status).toBe(402);
    expect(stolen.body.error_code).toBe('X402_SOLANA_REFERENCE_MISMATCH');
    expect(consumeMock).not.toHaveBeenCalled();

    // Y la víctima sigue pudiendo cobrar SU pago: la prueba no se consumió.
    const own = await present(app, envelope(victim, victimSignature));
    expect(own.status).toBe(200);
    expect(consumeMock).toHaveBeenCalledTimes(1);
  });

  it('T-504-01 💰 · si el 504 ya salió, la prueba NO se quema', async () => {
    // BLQ-MED-2. `createTimeoutHandler` manda el 504 desde FUERA del lifecycle: puede
    // salir mientras el handler está colgado del peek o del RPC. Sin el guard, el
    // handler seguía caminando hasta P7 y CONSUMIA la prueba — el pagador transfirió
    // USDC, recibió un 504, y su reintento le contesta `PROOF_REPLAY`. Pagó y no tiene
    // nada.
    //
    // La carrera se hace DETERMINISTA con un peek que no resuelve hasta que el test lo
    // suelta: el 504 sale seguro ANTES, no "probablemente antes".
    let releasePeek: () => void = () => {};
    const peekBlocked = new Promise<void>((resolve) => {
      releasePeek = resolve;
    });
    peekMock.mockImplementation(async () => {
      await peekBlocked;
      return { state: 'none' };
    });

    const app = Fastify();
    registerErrorBoundary(app);
    app.post(
      '/charged',
      {
        preHandler: [
          createTimeoutHandler(5),
          ...requirePayment({ description: 'test' }),
        ],
      },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );

    // El challenge se pide con el peek ya liberado (el 402 inicial no lo toca).
    const c = await getChallenge(app);
    const injected = app.inject({
      method: 'POST',
      url: '/charged',
      headers: {
        'x-payment-chain': 'solana-devnet',
        'x-payment': envelope(c, signatureFixture(31)),
      },
      payload: {},
    });
    const res = await injected;
    expect(res.statusCode).toBe(504);

    // Ahora el handler sigue caminando. Se lo deja terminar y se mide qué hizo.
    releasePeek();
    await new Promise((r) => setTimeout(r, 50));
    expect(peekMock).toHaveBeenCalled();
    // LA aserción: la prueba sigue gastable.
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('T-STEAL-03 · el sobre sin `nonce` (o con otro) NO re-deriva, y cada caso con su código', async () => {
    // Los dos son denegaciones sin consumir, pero NO son el mismo error: sin el campo
    // el sobre no se puede ni re-derivar (malformed); con otro valor sí se re-deriva y
    // da otra referencia (mismatch). Colapsarlos mandaría al pagador a arreglar la cosa
    // equivocada.
    const app = buildApp();
    const c = await getChallenge(app);
    const cases: [Record<string, unknown>, string][] = [
      [{ nonce: undefined }, 'X402_SOLANA_PROOF_MALFORMED'],
      [{ nonce: 'otro' }, 'X402_SOLANA_REFERENCE_MISMATCH'],
    ];
    for (const [over, code] of cases) {
      const res = await present(app, envelope(c, signatureFixture(5), over));
      expect(res.status).toBe(402);
      expect(res.body.error_code).toBe(code);
    }
    expect(probeMock).not.toHaveBeenCalled();
    expect(consumeMock).not.toHaveBeenCalled();
  });
});
