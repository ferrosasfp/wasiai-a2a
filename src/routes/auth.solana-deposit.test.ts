/**
 * WKH-315 — tests de ruta del depósito Solana (`POST /auth/deposit`,
 * `GET /auth/deposit-info`, `POST /auth/funding-wallet` con `namespace:'solana'`).
 *
 * Archivo NUEVO y aditivo: `src/routes/auth.test.ts` **no se toca** (CD-1/AC-10).
 *
 * ── LO QUE ESTE ARCHIVO PROTEGE, Y QUE NINGUN OTRO PUEDE ────────────────────
 *
 * El verificador ya está candado por su propia suite. Acá se prueban las cosas que
 * sólo existen en la ROUTE:
 *
 *  · **el gate de funding wallet** (T-315-08 / 08b) — sin él, un atacante que hace
 *    polling de las firmas PUBLICAS de la ATA de depósito reclama el depósito ajeno,
 *    y el UNIQUE del anti-replay garantiza que el legítimo pierda;
 *  · **el ORDEN verify → credit** (T-315-07d, M15) — que ningún fallo llegue a
 *    `registerDeposit`, o sea que la prueba NO se consuma;
 *  · **el mapeo 400 vs 503** — un `unknown` como 400 le dice al depositante que su
 *    depósito no existe cuando lo único cierto es que no pudimos preguntar;
 *  · **la coherencia familia↔formato con CERO RED** (T-315-17, M20);
 *  · **que `deposit-info` nunca publique una address EVM ni un secreto** (T-315-12c).
 */

import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import Fastify from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';
import authRoutes from './auth.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
    bindFundingWallet: vi.fn(),
    bindSolanaFundingWallet: vi.fn(),
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

vi.mock('../adapters/registry.js', () => ({
  getAdaptersBundle: vi.fn(),
  getInitializedChainKeys: vi.fn(() => []),
}));

// El verificador Solana se mockea: su conducta ya está candada por
// `adapters/solana/deposit-verifier.test.ts`. Acá interesa cómo la RUTA lo consume.
vi.mock('../adapters/solana/deposit-verifier.js', () => ({
  verifySolanaDeposit: vi.fn(),
}));

vi.mock('../services/event.js', () => ({
  eventService: { track: vi.fn(() => Promise.resolve({})) },
}));

vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn(() => Promise.resolve()) },
}));

// `deposit-account.js` se usa REAL (es config pura, env-driven): así el flag y la
// derivación de la ATA se ejercitan de verdad en `deposit-info`.

import {
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import { verifySolanaDeposit } from '../adapters/solana/deposit-verifier.js';
import type { AdaptersBundle } from '../adapters/types.js';
import { budgetService } from '../services/budget.js';
import { eventService } from '../services/event.js';
import { identityService } from '../services/identity.js';
import { receiptService } from '../services/receipt.js';
import {
  DepositAlreadyCreditedError,
  FundingWalletAlreadyBoundError,
  OwnershipMismatchError,
} from '../services/security/errors.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockBindSolana = vi.mocked(identityService.bindSolanaFundingWallet);
const mockRegisterDeposit = vi.mocked(budgetService.registerDeposit);
const mockGetAdaptersBundle = vi.mocked(getAdaptersBundle);
const mockGetInitializedChainKeys = vi.mocked(getInitializedChainKeys);
const mockVerifySolana = vi.mocked(verifySolanaDeposit);
const mockTrack = vi.mocked(eventService.track);
const mockEmitReceipt = vi.mocked(receiptService.emit);

// ── Fixtures (CD-16: derivados de la librería que los consume) ───────────────

const SOLANA_CHAIN_ID = 900001;
const EVM_CHAIN_ID = 43113;
const MINT = 'So11111111111111111111111111111111111111112';

const DEPOSIT_OWNER = Keypair.generate().publicKey.toBase58();
const DEPOSITOR = Keypair.generate().publicKey.toBase58();
const OTHER_WALLET = Keypair.generate().publicKey.toBase58();

/** Una firma Solana REAL: 64 bytes ed25519 en base58. */
function realSignature(seed = 'wkh315'): string {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const sig = crypto.sign(null, Buffer.from(seed), privateKey);
  expect(sig.length).toBe(64); // andamiaje
  return base58(new Uint8Array(sig));
}

/** base58 encode local (evita depender del adapter en un test de ruta). */
function base58(bytes: Uint8Array): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits: number[] = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] as number) << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const b of bytes) {
    if (b !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += A[digits[i] as number];
  return out;
}

const SIGNATURE = realSignature();
const VALID_EVM_TX = `0x${'a'.repeat(64)}`;

const TEST_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const TEST_KEY_HASH = crypto
  .createHash('sha256')
  .update(TEST_KEY)
  .digest('hex');
const TEST_KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: TEST_KEY_ID,
    owner_ref: 'user-1',
    key_hash: TEST_KEY_HASH,
    display_name: 'Test Key',
    budget: { [String(SOLANA_CHAIN_ID)]: '0.000000' },
    daily_limit_usd: '100.000000',
    daily_spent_usd: '0.000000',
    daily_reset_at: '2026-07-30T00:00:00.000Z',
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: '10.000000',
    is_active: true,
    last_used_at: null,
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    funding_wallet_solana: DEPOSITOR,
    metadata: {},
    require_signature: false,
    ...overrides,
  };
}

function solanaBundle(): AdaptersBundle {
  return {
    payment: {
      vmFamily: 'solana',
      caip2ChainId: 'solana:devnet',
      supportedTokens: [{ symbol: 'USDC', mint: MINT, decimals: 6 }],
    } as unknown as AdaptersBundle['payment'],
    attestation: {} as unknown as AdaptersBundle['attestation'],
    gasless: {} as unknown as AdaptersBundle['gasless'],
    identity: null,
    chainConfig: {
      name: 'solana-devnet',
      chainId: SOLANA_CHAIN_ID,
      explorerUrl: 'https://explorer.solana.com',
    },
  };
}

function evmBundle(): AdaptersBundle {
  return {
    payment: {
      vmFamily: 'evm',
      chainId: EVM_CHAIN_ID,
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
    chainConfig: {
      name: 'avalanche-fuji',
      chainId: EVM_CHAIN_ID,
      explorerUrl: 'https://testnet.snowtrace.io',
    },
  };
}

const ENV_KEYS = [
  'A2A_DEPOSIT_SOLANA_OWNER',
  'A2A_SOLANA_DEPOSIT_ENABLED',
  'SOLANA_USDC_MINT_DEVNET',
] as const;

const okVerification = (amountUsd = '5', depositor = DEPOSITOR) =>
  ({
    ok: true as const,
    amountAtomic: 5000000n,
    amountUsd,
    depositor,
    ata: 'AtAdEpOsIt',
    mint: MINT,
    signature: SIGNATURE,
  }) as Awaited<ReturnType<typeof verifySolanaDeposit>>;

// ── Setup ───────────────────────────────────────────────────────────────────

describe('WKH-315 · rutas del depósito Solana', () => {
  let app: ReturnType<typeof Fastify>;
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    app = Fastify();
    await app.register(authRoutes, { prefix: '/auth' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env.A2A_DEPOSIT_SOLANA_OWNER = DEPOSIT_OWNER;
    process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
    process.env.SOLANA_USDC_MINT_DEVNET = MINT;
    vi.clearAllMocks();
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetAdaptersBundle.mockReturnValue(solanaBundle());
    mockGetInitializedChainKeys.mockReturnValue([]);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const postDeposit = (
    payload: Record<string, unknown>,
    chain = 'solana-devnet',
  ) =>
    app.inject({
      method: 'POST',
      url: '/auth/deposit',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': chain },
      payload,
    });

  // ── AC-1 / T-315-01: el happy path ────────────────────────────────────────
  describe('T-315-01 (AC-1): el camino feliz', () => {
    it('T-315-01: 200 + balance, y el monto acreditado es EL DE LA CADENA', async () => {
      mockVerifySolana.mockResolvedValue(okVerification('5'));
      mockRegisterDeposit.mockResolvedValue('5.000000');

      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
        amount: '5',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        balance: '5.000000',
        chain_id: SOLANA_CHAIN_ID,
      });

      // ⚠️ El 3er arg de `registerDeposit` es el monto: tiene que venir del
      // VERIFICADOR, no del body. Se assertea el arg CAPTURADO (CD-9).
      expect(mockRegisterDeposit).toHaveBeenCalledTimes(1);
      const args = mockRegisterDeposit.mock.calls[0] as unknown[];
      expect(args[0]).toBe(TEST_KEY_ID);
      expect(args[1]).toBe(SOLANA_CHAIN_ID); // el del BUNDLE (CD-5)
      expect(args[2]).toBe('5');
      expect(args[3]).toBe('user-1');
      expect(args[4]).toBe(SIGNATURE);
      expect(args[5]).toBe('USDC');
      expect(args[6]).toBe('solana'); // el 7º param → p_vm_family
    });

    it('T-315-01 (M16): si la cadena dice 7 y el caller declaró 5, se acredita 7 — el body NUNCA es la fuente', async () => {
      // ⚠️ EL MUTANTE M16. El verificador ya rechazaría el mismatch, pero si alguien
      // pasara `body.amount` a `registerDeposit` el monto acreditado dejaría de ser el
      // de la cadena. Acá el doble devuelve `ok` con 7 y el body dice 5.
      mockVerifySolana.mockResolvedValue(okVerification('7'));
      mockRegisterDeposit.mockResolvedValue('7.000000');

      await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
        amount: '5',
      });

      const args = mockRegisterDeposit.mock.calls[0] as unknown[];
      expect(args[2]).toBe('7');
      expect(args[2]).not.toBe('5');
    });

    it('emite el recibo deposit_verified sin bloquear (misma forma que EVM)', async () => {
      mockVerifySolana.mockResolvedValue(okVerification('5'));
      mockRegisterDeposit.mockResolvedValue('5.000000');
      await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });
      expect(mockEmitReceipt).toHaveBeenCalledTimes(1);
      expect(mockEmitReceipt.mock.calls[0]?.[0]).toMatchObject({
        receiptType: 'deposit_verified',
        chainId: SOLANA_CHAIN_ID,
        txHash: SIGNATURE,
      });
    });

    it('el verificador recibe la firma y el amount declarado', async () => {
      mockVerifySolana.mockResolvedValue(okVerification('5'));
      mockRegisterDeposit.mockResolvedValue('5.000000');
      await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
        amount: '5',
      });
      expect(mockVerifySolana).toHaveBeenCalledWith({
        signature: SIGNATURE,
        expectedAmountUsd: '5',
      });
    });
  });

  // ── AC-7 / AC-8 / M5: el gate de funding wallet ───────────────────────────
  describe('AC-7 / AC-8: el gate de funding wallet (M5, M6)', () => {
    it('T-315-08: sin funding_wallet_solana ⇒ 403 FUNDING_WALLET_NOT_BOUND, sin acreditar', async () => {
      mockLookupByHash.mockResolvedValue(
        makeKeyRow({ funding_wallet_solana: null }),
      );
      mockVerifySolana.mockResolvedValue(okVerification('5'));

      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('FUNDING_WALLET_NOT_BOUND');
      expect(mockRegisterDeposit).not.toHaveBeenCalled();
    });

    it('T-315-08: funding_wallet_solana undefined (columna ausente) también fail-closea', async () => {
      // El campo es opcional en el row-type (ver a2a-key.ts): `undefined` tiene que
      // fail-closear igual que `null`, no colarse como "bindeada".
      const row = makeKeyRow();
      delete (row as { funding_wallet_solana?: unknown }).funding_wallet_solana;
      mockLookupByHash.mockResolvedValue(row);
      mockVerifySolana.mockResolvedValue(okVerification('5'));

      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('FUNDING_WALLET_NOT_BOUND');
      expect(mockRegisterDeposit).not.toHaveBeenCalled();
    });

    it('T-315-08b (M5): el depositante NO es la wallet bindeada ⇒ 403 FUNDING_WALLET_MISMATCH, SIN insertar fila', async () => {
      // ⚠️ EL HIJACK QUE ESTE GATE CIERRA. Las firmas de la ATA de depósito son
      // PUBLICAS: un atacante hace polling, toma la firma del depósito ajeno y la
      // presenta como propia. Sin el gate se acredita a él, y el UNIQUE del
      // anti-replay hace que el LEGITIMO ya no pueda reclamar su propio depósito.
      // Con el gate el ataque termina en 403 **sin insertar fila**, así que el
      // legítimo sigue pudiendo reclamar.
      mockLookupByHash.mockResolvedValue(
        makeKeyRow({ funding_wallet_solana: OTHER_WALLET }),
      );
      mockVerifySolana.mockResolvedValue(okVerification('5', DEPOSITOR));

      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('FUNDING_WALLET_MISMATCH');
      // La aserción decisiva: la prueba NO se consumió.
      expect(mockRegisterDeposit).not.toHaveBeenCalled();
    });

    it('M6: la comparación es BYTE-EXACTA — la misma pubkey en otra caja NO matchea', async () => {
      // ⚠️ EL MUTANTE M6. Con `.toLowerCase()` en los dos lados, dos pubkeys base58
      // DISTINTAS se volverían equivalentes: el gate dejaría pasar a una wallet que
      // no es la bindeada.
      mockLookupByHash.mockResolvedValue(
        makeKeyRow({ funding_wallet_solana: DEPOSITOR.toLowerCase() }),
      );
      mockVerifySolana.mockResolvedValue(okVerification('5', DEPOSITOR));
      // Andamiaje: las dos cadenas SI difieren.
      expect(DEPOSITOR).not.toBe(DEPOSITOR.toLowerCase());

      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('FUNDING_WALLET_MISMATCH');
      expect(mockRegisterDeposit).not.toHaveBeenCalled();
    });

    it('el gate usa la columna Solana, NO `funding_wallet` (que es del camino EVM)', async () => {
      mockLookupByHash.mockResolvedValue(
        makeKeyRow({
          funding_wallet: DEPOSITOR.toLowerCase(),
          funding_wallet_solana: null,
        }),
      );
      mockVerifySolana.mockResolvedValue(okVerification('5', DEPOSITOR));
      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('FUNDING_WALLET_NOT_BOUND');
    });
  });

  // ── AC-6 / M15: el mapeo de errores y el orden verify → credit ────────────
  describe('AC-6: 400 vs 503, y la prueba NUNCA se consume (M15)', () => {
    const negatives = [
      'TX_ABSENT',
      'TX_FAILED',
      'DEPOSIT_NOT_FINALIZED',
      'MINT_MISMATCH',
      'RECIPIENT_MISMATCH',
      'AMOUNT_MISMATCH',
      'DEPOSITOR_AMBIGUOUS',
    ] as const;

    for (const reason of negatives) {
      it(`T-315-07d (M15): ${reason} ⇒ 400 y registerDeposit NO se llama`, async () => {
        mockVerifySolana.mockResolvedValue({ ok: false, reason } as Awaited<
          ReturnType<typeof verifySolanaDeposit>
        >);

        const res = await postDeposit({
          key_id: TEST_KEY_ID,
          chain_id: SOLANA_CHAIN_ID,
          tx_hash: SIGNATURE,
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().error_code).toBe(reason);
        // ⚠️ LA PROPIEDAD DE CD-9: todo fallo retorna ANTES de `registerDeposit`, así
        // que no se inserta fila y la firma sigue reclamable.
        expect(mockRegisterDeposit).not.toHaveBeenCalled();
      });
    }

    for (const reason of [
      'DEPOSIT_ACCOUNT_NOT_CONFIGURED',
      'DEPOSIT_VERIFICATION_UNKNOWN',
    ] as const) {
      it(`${reason} ⇒ 503 (no 400) y registerDeposit NO se llama`, async () => {
        // ⚠️ El 400 diría "tu depósito no existe / no coincide". El 503 dice "no
        // puedo responder por la cadena". Con un `unknown` mapeado a 400, un timeout
        // de RPC se le comunica al depositante como una negativa sobre su plata.
        mockVerifySolana.mockResolvedValue({
          ok: false,
          reason,
          detail: 'ETIMEDOUT',
        } as Awaited<ReturnType<typeof verifySolanaDeposit>>);

        const res = await postDeposit({
          key_id: TEST_KEY_ID,
          chain_id: SOLANA_CHAIN_ID,
          tx_hash: SIGNATURE,
        });

        expect(res.statusCode).toBe(503);
        expect(res.json().error_code).toBe(reason);
        expect(mockRegisterDeposit).not.toHaveBeenCalled();
      });
    }

    it('T-315-07c: el UNKNOWN deja un a2a_events con valueDisposition:unknown y la FIRMA', async () => {
      // Un log no es una superficie de reconciliación: tiene que existir DONDE
      // mirarlo. Y `signature` es la clave para cruzar contra la cadena.
      mockVerifySolana.mockResolvedValue({
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail: 'ETIMEDOUT',
      } as Awaited<ReturnType<typeof verifySolanaDeposit>>);

      await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });

      expect(mockTrack).toHaveBeenCalledTimes(1);
      const ev = mockTrack.mock.calls[0]?.[0] as {
        eventType?: string;
        status?: string;
        metadata?: Record<string, unknown>;
      };
      expect(ev.eventType).toBe('solana_deposit_unknown');
      expect(ev.status).toBe('failed');
      expect(ev.metadata?.valueDisposition).toBe('unknown');
      expect(ev.metadata?.signature).toBe(SIGNATURE);
      expect(ev.metadata?.keyId).toBe(TEST_KEY_ID);
      expect(ev.metadata?.error_code).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      // La diferencia sustantiva con el canal x402: acá la prueba NO se quemó.
      expect(ev.metadata?.proofConsumed).toBe(false);
      // Telemetría GLOBAL: no se registra el owner (mismo criterio que x402).
      expect(ev.metadata).not.toHaveProperty('owner_ref');
      expect(ev.metadata).not.toHaveProperty('ownerRef');
    });

    it('T-315-07c: SOLO el UNKNOWN emite el evento — una negativa medida no lo hace', async () => {
      // Si toda negativa emitiera el canal de "no pude determinar", el canal dejaría
      // de significar algo y el operador no sabría qué mirar.
      mockVerifySolana.mockResolvedValue({
        ok: false,
        reason: 'TX_ABSENT',
      } as Awaited<ReturnType<typeof verifySolanaDeposit>>);
      await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('un fallo de la telemetría NO cambia la respuesta del money-path', async () => {
      mockTrack.mockRejectedValue(new Error('insert failed'));
      mockVerifySolana.mockResolvedValue({
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail: 'x',
      } as Awaited<ReturnType<typeof verifySolanaDeposit>>);

      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error_code).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
    });

    it('T-315-04 (AC-3): la segunda presentación ⇒ 409 DEPOSIT_ALREADY_CREDITED', async () => {
      mockVerifySolana.mockResolvedValue(okVerification('5'));
      mockRegisterDeposit.mockRejectedValue(new DepositAlreadyCreditedError());

      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error_code).toBe('DEPOSIT_ALREADY_CREDITED');
    });

    it('OwnershipMismatchError del service ⇒ 403; cualquier otro ⇒ 500 DEPOSIT_FAILED', async () => {
      mockVerifySolana.mockResolvedValue(okVerification('5'));

      mockRegisterDeposit.mockRejectedValue(new OwnershipMismatchError());
      let res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');

      mockRegisterDeposit.mockRejectedValue(new Error('boom'));
      res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error_code).toBe('DEPOSIT_FAILED');
    });
  });

  // ── T-315-17 / T-315-18 / M20: los cortes SIN RED ────────────────────────
  describe('T-315-17 / T-315-18: los cortes con CERO RED (M20)', () => {
    it('T-315-17 (M20): firma base58 con `x-payment-chain: avalanche-fuji` ⇒ 400 INVALID_INPUT y CERO red', async () => {
      // ⚠️ EL MUTANTE M20. Sin el paso 3b, una firma Solana sobre una chain EVM
      // entraría al camino viem y `getTransactionReceipt` recibiría una cadena
      // base58 como si fuera un hash de 32 bytes.
      mockGetAdaptersBundle.mockReturnValue(evmBundle());

      const res = await postDeposit(
        {
          key_id: TEST_KEY_ID,
          chain_id: EVM_CHAIN_ID,
          tx_hash: SIGNATURE,
        },
        'avalanche-fuji',
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('INVALID_INPUT');
      expect(mockVerifySolana).not.toHaveBeenCalled();
      expect(mockRegisterDeposit).not.toHaveBeenCalled();
    });

    it('M20 (el recíproco): un hash EVM con `x-payment-chain: solana-devnet` ⇒ 400 INVALID_INPUT y cero red', async () => {
      const res = await postDeposit(
        {
          key_id: TEST_KEY_ID,
          chain_id: SOLANA_CHAIN_ID,
          tx_hash: VALID_EVM_TX,
        },
        'solana-devnet',
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('INVALID_INPUT');
      expect(mockVerifySolana).not.toHaveBeenCalled();
    });

    it('T-315-18: con el flag OFF, el verificador contesta DEPOSIT_ACCOUNT_NOT_CONFIGURED ⇒ 503', async () => {
      // El flag lo lee el VERIFICADOR (choke-point único), así que acá se prueba que
      // la ruta traduce ese estado a 503 y no acredita.
      process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'false';
      mockVerifySolana.mockResolvedValue({
        ok: false,
        reason: 'DEPOSIT_ACCOUNT_NOT_CONFIGURED',
      } as Awaited<ReturnType<typeof verifySolanaDeposit>>);

      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error_code).toBe('DEPOSIT_ACCOUNT_NOT_CONFIGURED');
      expect(mockRegisterDeposit).not.toHaveBeenCalled();
    });

    it('una referencia que no es ni hash EVM ni firma Solana ⇒ 400 INVALID_INPUT (CD-1: mismo lugar)', async () => {
      for (const bad of ['0xbad', 'not-a-ref', '', '0OIl']) {
        const res = await postDeposit({
          key_id: TEST_KEY_ID,
          chain_id: SOLANA_CHAIN_ID,
          tx_hash: bad,
        });
        expect(res.statusCode, bad).toBe(400);
        expect(res.json().error_code, bad).toBe('INVALID_INPUT');
      }
      expect(mockVerifySolana).not.toHaveBeenCalled();
    });

    it('el chain_id del body que no matchea el del bundle ⇒ 400 CHAIN_MISMATCH', async () => {
      const res = await postDeposit({
        key_id: TEST_KEY_ID,
        chain_id: 900002, // sentinel distinto
        tx_hash: SIGNATURE,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('CHAIN_MISMATCH');
      expect(mockVerifySolana).not.toHaveBeenCalled();
    });

    it('un key_id del body distinto del caller ⇒ 403 OWNERSHIP_MISMATCH (defense-in-depth)', async () => {
      const res = await postDeposit({
        key_id: 'otra-key',
        chain_id: SOLANA_CHAIN_ID,
        tx_hash: SIGNATURE,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
      expect(mockVerifySolana).not.toHaveBeenCalled();
    });
  });

  // ── AC-11 / T-315-12: GET /auth/deposit-info ──────────────────────────────
  describe('AC-11: GET /auth/deposit-info (T-315-12, 12b, 12c)', () => {
    const getInfo = () =>
      app.inject({ method: 'GET', url: '/auth/deposit-info' });

    it('T-315-12: con el flag OFF, Solana NO se lista', async () => {
      // Publicar una cuenta de depósito sin el camino habilitado invitaría a mandar
      // plata que nadie puede acreditar.
      process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'false';
      mockGetInitializedChainKeys.mockReturnValue(['solana-devnet']);
      mockGetAdaptersBundle.mockReturnValue(solanaBundle());

      const res = await getInfo();

      expect(res.statusCode).toBe(200);
      expect(res.json().networks).toEqual([]);
    });

    it('T-315-12: sin `A2A_DEPOSIT_SOLANA_OWNER`, Solana NO se lista (aunque el flag esté ON)', async () => {
      delete process.env.A2A_DEPOSIT_SOLANA_OWNER;
      mockGetInitializedChainKeys.mockReturnValue(['solana-devnet']);
      mockGetAdaptersBundle.mockReturnValue(solanaBundle());
      const res = await getInfo();
      expect(res.json().networks).toEqual([]);
    });

    it('T-315-12b: con el flag ON y owner configurado, lista los 7 campos y deposit_account ≠ deposit_account_owner', async () => {
      mockGetInitializedChainKeys.mockReturnValue(['solana-devnet']);
      mockGetAdaptersBundle.mockReturnValue(solanaBundle());

      const res = await getInfo();
      const nets = res.json().networks as Record<string, unknown>[];

      expect(nets).toHaveLength(1);
      const n = nets[0] as Record<string, unknown>;
      expect(Object.keys(n).sort()).toEqual([
        'chain_id',
        'cluster',
        'deposit_account',
        'deposit_account_owner',
        'family',
        'required_commitment',
        'slug',
        'token',
        'vm_family',
      ]);
      expect(n.chain_id).toBe(SOLANA_CHAIN_ID);
      expect(n.slug).toBe('solana-devnet');
      expect(n.vm_family).toBe('solana');
      expect(n.cluster).toBe('devnet');
      expect(n.required_commitment).toBe('finalized');
      expect(n.deposit_account_owner).toBe(DEPOSIT_OWNER);
      // ⚠️ EL DESTINO ES LA ATA, NO EL OWNER (CD-5).
      expect(n.deposit_account).not.toBe(DEPOSIT_OWNER);
      expect(typeof n.deposit_account).toBe('string');
      // El token sale del adapter, NO hardcodeado.
      expect(n.token).toEqual({ symbol: 'USDC', mint: MINT, decimals: 6 });
    });

    it('T-315-12c: JAMAS una address EVM, un `treasury`, un `escrow_*` ni una clave privada', async () => {
      // ⚠️ Publicar una address EVM acá es el landmine de `resolveTreasury` con otro
      // nombre: el depositante mandaría USDC de devnet a un string que en Solana no
      // es nada.
      //
      // ══════════════════════════════════════════════════════════════════════════
      // ⚠️ POR QUE ESTE TEST NO PROHIBE UNA TIRADA DE '1' (Y POR QUE LO HIZO UNA VEZ)
      // ══════════════════════════════════════════════════════════════════════════
      //
      // La primera versión afirmaba `expect(raw).not.toContain('1'.repeat(32))`, con
      // la intención de cazar el fixture de `OPERATOR_PRIVATE_KEY` (que era
      // `0x` + '11' × 32). Se puso ROJA, y NO por una fuga: el guard chocaba con un
      // valor que la respuesta publica LEGITIMAMENTE.
      //
      // Medido: el mint fixture `So111…112` tiene una tirada de **40 unos
      // consecutivos**, así que contiene el needle de 32. Y `token.mint` es
      // precisamente el dato que el depositante NECESITA para transferir. O sea: el
      // guard prohibía la carga útil de la respuesta.
      //
      // La lección, que vale más que el fix: **un secreto formado por un carácter
      // repetido es indistinguible de una dirección base58 legítima**, así que un
      // guard por subcadena sobre él no puede separar la fuga del dato bueno. El
      // arreglo NO fue borrar la aserción (eso sí habría debilitado el control):
      // fue (a) darle al fixture un valor DISTINTIVO, y (b) afirmar sobre el valor
      // COMPLETO del secreto y sobre la address DERIVADA de él —que es el valor que
      // el landmine de `resolveTreasury` realmente filtraría— en vez de sobre un
      // pedazo suyo que colisiona con todo.
      //
      // Un guard demasiado amplio que alguien relaja de apuro es cómo se pierde un
      // control de verdad. Este quedó MAS estrecho en su superficie y MAS fuerte en
      // lo que prueba.
      // ══════════════════════════════════════════════════════════════════════════

      // Fixture DISTINTIVO: sin tiradas de un mismo carácter, así que si aparece en
      // la respuesta es porque se filtró, no por una coincidencia de charset.
      const PK_HEX = 'a3f19c7d';
      const OPERATOR_PK = `0x${PK_HEX.repeat(8)}` as `0x${string}`;
      const TREASURY_ENV = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
      process.env.A2A_DEPOSIT_TREASURY_SOLANA = TREASURY_ENV;
      process.env.OPERATOR_PRIVATE_KEY = OPERATOR_PK;
      // La address que `resolveTreasury` DERIVARIA de esa pk por su fallback: es el
      // valor exacto que el landmine publicaría como "destino" de un depósito Solana.
      const derivedOperatorAddress = privateKeyToAccount(OPERATOR_PK).address;

      mockGetInitializedChainKeys.mockReturnValue(['solana-devnet']);
      mockGetAdaptersBundle.mockReturnValue(solanaBundle());

      try {
        const res = await getInfo();
        const raw = res.body;

        // (1) NINGUNA address EVM, en ninguna forma. Este es el guard ancho que sí
        // corresponde: `0x` + 40 hex no puede aparecer en una entrada Solana.
        expect(raw).not.toMatch(/0x[0-9a-fA-F]{40}/);
        // (2) Ni el treasury de la env, ni la address DERIVADA del fallback — el
        // valor concreto del landmine —, en cualquier caja.
        expect(raw.toLowerCase()).not.toContain(TREASURY_ENV.toLowerCase());
        expect(raw.toLowerCase()).not.toContain(
          derivedOperatorAddress.toLowerCase(),
        );
        // (3) La clave privada, completa y también su cuerpo hex sin el `0x`.
        expect(raw).not.toContain(OPERATOR_PK);
        expect(raw.toLowerCase()).not.toContain(PK_HEX.repeat(8));
        // (4) Y ningún nombre de campo del vocabulario EVM/secretos.
        for (const forbidden of [
          'treasury',
          'escrow',
          'PRIVATE',
          'private_key',
          'privateKey',
          'secret',
        ]) {
          expect(raw, forbidden).not.toContain(forbidden);
        }

        // (5) Andamiaje ANTI-VACUIDAD: la respuesta tiene que traer contenido real.
        // Sin esto, un `networks: []` pasaría los cinco guards de arriba y el test
        // afirmaría "no filtra nada" sobre una respuesta vacía.
        const nets = res.json().networks as Record<string, unknown>[];
        expect(nets).toHaveLength(1);
        const n = nets[0] as Record<string, unknown>;
        expect(n.deposit_account_owner).toBe(DEPOSIT_OWNER);
        expect((n.token as { mint: string }).mint).toBe(MINT);

        expect(n).not.toHaveProperty('treasury');
        expect(n).not.toHaveProperty('escrow_mode');
        expect(n).not.toHaveProperty('escrow_contract');
        expect(n).not.toHaveProperty('min_confirmations');
      } finally {
        // `finally`: si una aserción falla, las envs no quedan pisadas para el resto
        // del archivo (un test que ensucia el entorno del vecino es un falso rojo
        // más difícil de leer que el original).
        delete process.env.A2A_DEPOSIT_TREASURY_SOLANA;
        delete process.env.OPERATOR_PRIVATE_KEY;
      }
    });

    it('AC-10: la entrada EVM de deposit-info queda con su forma de siempre', async () => {
      // CD-1: el listado EVM no cambia ni un campo.
      mockGetInitializedChainKeys.mockReturnValue(['avalanche-fuji']);
      mockGetAdaptersBundle.mockReturnValue(evmBundle());

      const res = await getInfo();
      const n = (res.json().networks as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >;

      expect(Object.keys(n).sort()).toEqual([
        'chain_id',
        'escrow_contract',
        'escrow_mode',
        'family',
        'min_confirmations',
        'slug',
        'token',
        'treasury',
      ]);
      expect(n).not.toHaveProperty('vm_family');
      expect(n).not.toHaveProperty('deposit_account');
    });
  });

  // ── AC-7 / AC-8: POST /auth/funding-wallet con namespace 'solana' ─────────
  describe('AC-7: POST /auth/funding-wallet — rama Solana', () => {
    /** Un par ed25519 real + la firma del mensaje canónico de ESTA key. */
    function bindProof(keyId = TEST_KEY_ID) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const der = publicKey.export({ format: 'der', type: 'spki' });
      expect(der.length).toBe(44); // andamiaje
      const pubkey = base58(new Uint8Array(der.subarray(12)));
      const sig = base58(
        new Uint8Array(
          crypto.sign(
            null,
            Buffer.from(`WASIAI_BIND_FUNDING_WALLET_SOLANA:${keyId}`, 'utf8'),
            privateKey,
          ),
        ),
      );
      return { pubkey, sig };
    }

    const postBind = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/auth/funding-wallet',
        headers: { 'x-a2a-key': TEST_KEY },
        payload,
      });

    it('T-315-08c: un bind válido ⇒ 200 { funding_wallet_solana }', async () => {
      const { pubkey, sig } = bindProof();
      mockBindSolana.mockResolvedValue(pubkey);

      const res = await postBind({
        namespace: 'solana',
        wallet: pubkey,
        signature: sig,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ funding_wallet_solana: pubkey });
      // El key_id sale del CALLER, nunca del body.
      expect(mockBindSolana).toHaveBeenCalledWith(
        TEST_KEY_ID,
        'user-1',
        pubkey,
      );
    });

    it('T-315-08d: una firma válida para OTRO key_id ⇒ 403 FUNDING_WALLET_PROOF_INVALID', async () => {
      // Sin el key_id en el mensaje, una firma obtenida una vez serviría para
      // bindear la wallet a CUALQUIER key, incluida la de un atacante.
      const { pubkey, sig } = bindProof('otro-key-id-completamente-distinto');

      const res = await postBind({
        namespace: 'solana',
        wallet: pubkey,
        signature: sig,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('FUNDING_WALLET_PROOF_INVALID');
      expect(mockBindSolana).not.toHaveBeenCalled();
    });

    it('una firma de OTRA llave sobre el mensaje correcto ⇒ 403', async () => {
      const a = bindProof();
      const b = bindProof();
      const res = await postBind({
        namespace: 'solana',
        wallet: a.pubkey,
        signature: b.sig,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('FUNDING_WALLET_PROOF_INVALID');
    });

    it('T-315-09: un `namespace` no reconocido ⇒ 400 INVALID_INPUT — fail-closed, NO default a EVM', async () => {
      // ⚠️ Si un cliente pide una familia que no entendemos, aplicarle el gate de
      // OTRA familia es peor que rechazarlo.
      const { pubkey, sig } = bindProof();
      for (const ns of ['sol', 'SOLANA', 'bitcoin', '', 1, null, {}]) {
        const res = await postBind({
          namespace: ns,
          wallet: pubkey,
          signature: sig,
        });
        expect(res.statusCode, JSON.stringify(ns)).toBe(400);
        expect(res.json().error_code).toBe('INVALID_INPUT');
      }
      expect(mockBindSolana).not.toHaveBeenCalled();
    });

    it('una pubkey mal formada o una firma mal formada ⇒ 400 INVALID_INPUT, sin verificar nada', async () => {
      const { pubkey, sig } = bindProof();
      const bads: [unknown, unknown][] = [
        ['0x1111111111111111111111111111111111111111', sig], // address EVM
        [pubkey, pubkey], // 32 bytes donde van 64
        [sig, sig], // 64 bytes donde van 32
        [pubkey, '0OIl'], // charset inválido
        [undefined, sig],
        [pubkey, undefined],
      ];
      for (const [wallet, signature] of bads) {
        const res = await postBind({ namespace: 'solana', wallet, signature });
        expect(res.statusCode, String(wallet)).toBe(400);
        expect(res.json().error_code).toBe('INVALID_INPUT');
      }
      expect(mockBindSolana).not.toHaveBeenCalled();
    });

    it('23505 ⇒ 409 FUNDING_WALLET_ALREADY_BOUND · ownership ⇒ 403 · otro ⇒ 500', async () => {
      const { pubkey, sig } = bindProof();
      const payload = { namespace: 'solana', wallet: pubkey, signature: sig };

      mockBindSolana.mockRejectedValue(new FundingWalletAlreadyBoundError());
      let res = await postBind(payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().error_code).toBe('FUNDING_WALLET_ALREADY_BOUND');

      mockBindSolana.mockRejectedValue(new OwnershipMismatchError());
      res = await postBind(payload);
      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');

      mockBindSolana.mockRejectedValue(new Error('boom'));
      res = await postBind(payload);
      expect(res.statusCode).toBe(500);
      expect(res.json().error_code).toBe('FUNDING_WALLET_BIND_FAILED');
    });

    it("CD-1: `namespace:'evm'` explícito y la ausencia de `namespace` van los DOS a la rama EVM", async () => {
      // La rama EVM rechaza una pubkey base58 con su `ADDRESS_RE` de siempre, y NO
      // llama al bind Solana.
      const { pubkey, sig } = bindProof();
      for (const payload of [
        { wallet: pubkey, signature: sig },
        { namespace: 'evm', wallet: pubkey, signature: sig },
      ]) {
        const res = await postBind(payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().error_code).toBe('INVALID_INPUT');
      }
      expect(mockBindSolana).not.toHaveBeenCalled();
    });
  });
});
