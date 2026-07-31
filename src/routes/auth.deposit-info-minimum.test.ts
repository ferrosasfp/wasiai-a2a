/**
 * GET /auth/deposit-info — el minimo de deposito, PUBLICADO (fix-pack AR 2026-07-31).
 *
 * QUE ROMPIO EL MERGE DEL MINIMO: el unico contrato legible por maquina que dice a
 * donde mandar plata (`treasury` / `deposit_account`) NO decia cuanto hay que mandar.
 * Un deposito por debajo del minimo se rechaza con 400 DESPUES de la transferencia
 * on-chain, y con la treasury custodial esos fondos no se acreditan nunca: no hay
 * agregacion, no hay devolucion, y volver a presentar la prueba no ayuda porque el
 * monto sigue siendo el mismo.
 *
 * QUE CLAVAN ESTOS TESTS:
 *  1. Que el numero publicado sea EXACTAMENTE el que el guard aplica. No se declaran
 *     por separado: se atan contra `checkDepositMinimum()` por los dos lados del
 *     borde, asi que publicar otro numero (o dejar de seguir a la env) pone rojo.
 *  2. Que cuando el minimo no esta configurado la respuesta NO invite a depositar, y
 *     que ese estado sea distinguible de "el minimo es cero".
 */

import Fastify from 'fastify';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import authRoutes from './auth.js';

// Mismos mocks que `auth.test.ts`: el plugin importa estos servicios al registrarse.
vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
    bindFundingWallet: vi.fn(),
    bindErc8004Identity: vi.fn(),
    bindPassport: vi.fn(),
    resolveIdentityForAgent: vi.fn(),
  },
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));

vi.mock('../services/delegation.js', () => ({
  delegationService: {
    verifyTypedData: vi.fn(),
    create: vi.fn(),
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
    debitDelegationAndParent: vi.fn(),
  },
  exceedsPerTxLimit: vi.fn(),
}));

vi.mock('../adapters/deposit-verifier.js', async () => {
  const actual = await vi.importActual<
    typeof import('../adapters/deposit-verifier.js')
  >('../adapters/deposit-verifier.js');
  return { ...actual, verifyDeposit: vi.fn() };
});

vi.mock('../adapters/registry.js', () => ({
  getAdaptersBundle: vi.fn(),
  getInitializedChainKeys: vi.fn(() => []),
}));

import {
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import type { AdaptersBundle } from '../adapters/types.js';
// ⚠️ EL GUARD DE VERDAD, sin mock: es la mitad del amarre.
import { checkDepositMinimum } from '../lib/deposit-minimum.js';

const mockGetAdaptersBundle = vi.mocked(getAdaptersBundle);
const mockGetInitializedChainKeys = vi.mocked(getInitializedChainKeys);

const ENV = 'A2A_DEPOSIT_MIN_USDC';
const ORIGINAL = process.env[ENV];

function evmBundle(chainId: number): AdaptersBundle {
  return {
    payment: {
      vmFamily: 'evm',
      supportedTokens: [
        {
          symbol: 'USDC',
          address: '0x5425890298aed601595a70AB815c96711a31Bc65',
          decimals: 6,
        },
      ],
    } as unknown as AdaptersBundle['payment'],
    attestation: {} as unknown as AdaptersBundle['attestation'],
    gasless: {} as unknown as AdaptersBundle['gasless'],
    identity: null,
    chainConfig: { name: 'test', chainId, explorerUrl: 'https://x.test' },
  };
}

/**
 * Un micro-dolar POR DEBAJO del decimal recibido, con enteros (la grilla de USDC es
 * de 6 decimales y `0.1 + 0.2 !== 0.3`).
 *
 * Deliberadamente NO usa `formatMicroUsd` del modulo bajo prueba: si el borde se
 * calculara con la misma funcion que produce el valor publicado, el test se estaria
 * comparando consigo mismo.
 */
function oneMicroBelow(usdc: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(usdc);
  if (m === null) throw new Error(`valor no decimal: ${usdc}`);
  const micro =
    BigInt(m[1] as string) * 1_000_000n +
    BigInt((m[2] ?? '').slice(0, 6).padEnd(6, '0')) -
    1n;
  const int = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${int}.${frac}`;
}

describe('GET /auth/deposit-info — minimo publicado (fix-pack AR 2026-07-31)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(authRoutes, { prefix: '/auth' });
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInitializedChainKeys.mockReturnValue(['avalanche-fuji']);
    mockGetAdaptersBundle.mockReturnValue(evmBundle(43113));
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[ENV];
    else process.env[ENV] = ORIGINAL;
  });

  const getInfo = () =>
    app.inject({ method: 'GET', url: '/auth/deposit-info' });

  // ── 1. El valor publicado ES el que el guard aplica ───────────────────────
  //
  // Amarre por los DOS lados del borde. Si la ruta publicara un numero distinto del
  // que exige `checkDepositMinimum` (una constante nueva, otra lectura de la env, un
  // formateo propio), una de las dos aserciones cae:
  //   · publicado MENOR que el real  → el monto publicado es rechazado por el guard.
  //   · publicado MAYOR que el real  → un micro menos que el publicado igual acredita.
  it.each([
    '1',
    '1.0',
    '2.5',
    '0.5',
    '0.000002',
  ])('con %s: el minimo publicado es exactamente el que el guard aplica', async (configured) => {
    process.env[ENV] = configured;

    const entry = (await getInfo()).json().networks[0];
    const published = entry.deposit_minimum_usdc as string;

    expect(entry.deposits_enabled).toBe(true);
    expect(typeof published).toBe('string');
    // El monto publicado ACREDITA (el borde va para adentro).
    expect(checkDepositMinimum(published)).toEqual({ ok: true });
    // Un micro-dolar menos, NO.
    expect(checkDepositMinimum(oneMicroBelow(published))).toEqual({
      ok: false,
      reason: 'DEPOSIT_BELOW_MINIMUM',
      minimumUsdc: published,
    });
  });

  it('el minimo es del CAMINO: todas las entradas publican el mismo valor', async () => {
    process.env[ENV] = '1';
    mockGetInitializedChainKeys.mockReturnValue([
      'avalanche-fuji',
      'base-sepolia',
    ]);
    mockGetAdaptersBundle.mockImplementation((key) =>
      evmBundle(key === 'base-sepolia' ? 84532 : 43113),
    );

    const networks = (await getInfo()).json().networks as {
      deposit_minimum_usdc: string;
      deposits_enabled: boolean;
    }[];

    expect(networks).toHaveLength(2);
    for (const n of networks) {
      expect(n.deposit_minimum_usdc).toBe('1');
      expect(n.deposits_enabled).toBe(true);
    }
  });

  it('el ejemplo del walkthrough (0.05) NO alcanza el minimo publicado', async () => {
    // El caso concreto que rompio el merge: `examples/steps/4-transfer.mjs` mandaba
    // 0.05 por default. Con el minimo publicado, un cliente lo puede saber ANTES de
    // transferir en vez de enterarse con la plata ya en la treasury custodial.
    process.env[ENV] = '1';

    const entry = (await getInfo()).json().networks[0];

    expect(checkDepositMinimum('0.05')).toEqual({
      ok: false,
      reason: 'DEPOSIT_BELOW_MINIMUM',
      minimumUsdc: entry.deposit_minimum_usdc,
    });
  });

  // ── 2. Sin minimo configurado, la respuesta NO invita a depositar ─────────
  it.each([
    ['ausente', undefined],
    ['vacia', '   '],
    ['con coma decimal', '1,5'],
    ['con unidad pegada', '1 USDC'],
    ['sub-grilla', '1.0000001'],
    ['cero', '0'],
    ['notacion cientifica', '1e6'],
    ['negativa', '-1'],
  ])('con la env %s: deposits_enabled=false y el minimo es null, no cero', async (_label, raw) => {
    if (raw === undefined) delete process.env[ENV];
    else process.env[ENV] = raw;

    const res = await getInfo();
    const entry = res.json().networks[0];

    // El guard, en ese mismo estado, rechaza CUALQUIER monto: la respuesta no
    // puede sugerir lo contrario.
    expect(checkDepositMinimum('1000000')).toEqual({
      ok: false,
      reason: 'DEPOSIT_MINIMUM_NOT_CONFIGURED',
    });
    expect(entry.deposits_enabled).toBe(false);
    expect(entry.deposit_minimum_usdc).toBeNull();
    // Y `null` NO puede leerse como "0" (que seria "mandá lo que quieras").
    expect(entry.deposit_minimum_usdc).not.toBe('0');
    expect(entry.deposit_minimum_usdc).not.toBe(0);
    expect(res.body).not.toContain('"deposit_minimum_usdc":"0"');
    expect(res.body).not.toContain('"deposit_minimum_usdc":0');
    // Andamiaje anti-vacuidad: la entrada existe (no estamos afirmando sobre nada).
    expect(entry.chain_id).toBe(43113);
  });

  it('un minimo diminuto pero valido se publica como numero, no como null', async () => {
    // Separa "no hay minimo" (null, depositos cerrados) de "el minimo es casi cero"
    // (un numero, depositos abiertos). Si el estado no configurado se publicara como
    // '0' o como 0, estos dos casos serian indistinguibles para un cliente.
    process.env[ENV] = '0.000001';

    const entry = (await getInfo()).json().networks[0];

    expect(entry.deposit_minimum_usdc).toBe('0.000001');
    expect(entry.deposits_enabled).toBe(true);
  });
});
