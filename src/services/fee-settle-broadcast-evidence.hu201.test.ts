/**
 * HU-201 extendida a los DOS caminos de fee — `src/services/fee-charge.ts`
 * (`chargeProtocolFee`) y `src/services/fee-split.ts` (`settleFeeSplits`).
 *
 * QUÉ CANDA ESTA SUITE. Un `settle()` que contesta `success:false` puede venir
 * CON un `txHash`. Ese hash es EVIDENCIA DE BROADCAST: algo se transmitió, y
 * "no se ejecutó" deja de ser la única lectura posible. La doctrina completa
 * (y el por qué de que CUALQUIER string no vacío cuente) vive en
 * `src/adapters/errors.ts` → `hasBroadcastEvidence`, y su exemplar aplicado
 * está en `src/services/payment-intent.ts:434-469`.
 *
 * POR QUÉ HIZO FALTA. Los dos caminos de fee descartaban el hash con un
 * `undefined` hardcodeado, y NINGÚN test lo notaba en NINGUNA dirección: los
 * fixtures existentes (`fee-charge.test.ts` FT-13 y `fee-split.test.ts`
 * T-PARTIAL) mandan `txHash: ''`, o sea el caso SIN evidencia, donde guardar el
 * hash y tirarlo son indistinguibles. Es la forma "el escenario está armado de
 * manera que la rama nunca corre" que ya cazó el fix-pack AR de HU-201.
 *
 * ALCANCE DEL CAMBIO: la fila/leg sigue `failed` y el dinero NO se mueve
 * distinto. Lo que cambia es que la evidencia se CONSERVA (columna `tx_hash` +
 * campo estructurado en el log + `error_message`). Un hash es prueba de un
 * INTENTO, nunca de un cobro.
 *
 * Cada `describe` nombra el archivo fuente que candea, para que una mutación
 * ponga rojo un test que dice dónde mutó (auto-blindaje HU-201, Wave 1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

const mockSign = vi.fn();
const mockSettle = vi.fn();
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (..._a: unknown[]) => ({
    sign: mockSign,
    settle: mockSettle,
    supportedTokens: [{ symbol: 'PYUSD', address: '0x0', decimals: 18 }],
  }),
}));

const mockVerifySettle = vi.fn();
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) => mockVerifySettle(...a),
}));

// Supabase mock — captura los patches de UPDATE para poder afirmar qué se
// persiste (mismo patrón que `fee-split.test.ts:55-115`).
const mockState = vi.hoisted(() => ({
  selectQ: [] as Array<{ data?: unknown; error?: unknown }>,
  updates: [] as unknown[],
  inserts: [] as unknown[],
}));

vi.mock('../lib/supabase.js', () => {
  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    chain.maybeSingle = () =>
      Promise.resolve(mockState.selectQ.shift() ?? { data: null, error: null });
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mock an awaitable supabase query builder
    chain.then = (
      res: (v: unknown) => unknown,
      rej?: (e: unknown) => unknown,
    ) => Promise.resolve({ data: [], error: null }).then(res, rej);
    return chain;
  };
  const makeUpdateChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mock an awaitable supabase query builder
    chain.then = (
      res: (v: unknown) => unknown,
      rej?: (e: unknown) => unknown,
    ) => Promise.resolve({ error: null }).then(res, rej);
    return chain;
  };
  return {
    supabase: {
      from: (_table: string) => ({
        select: () => makeSelectChain(),
        insert: (row: unknown) => {
          mockState.inserts.push(row);
          return Promise.resolve({ error: null });
        },
        update: (patch: unknown) => {
          mockState.updates.push(patch);
          return makeUpdateChain();
        },
      }),
    },
  };
});

import { chargeProtocolFee } from './fee-charge.js';
import {
  type RecipientWithAmount,
  type SplitRecipientRole,
  settleFeeSplits,
} from './fee-split.js';

// ─── Fixtures ───────────────────────────────────────────────

const PLATFORM = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';

/** Hash de broadcast REAL (no-default): el fixture tiene que ser distinguible. */
const BROADCAST_TX =
  '0xfeed0000000000000000000000000000000000000000000000000000000201aa';

function primeSign() {
  mockSign.mockResolvedValue({
    xPaymentHeader: 'header',
    paymentRequest: {
      authorization: { value: '0' },
      signature: '0xsig',
      network: 'kite',
    },
  });
}

function recipient(
  role: SplitRecipientRole,
  wallet: string,
  bps: number,
  amountUsdc: number,
): RecipientWithAmount {
  return { role, wallet, ownerRef: `${role}-owner`, bps, amountUsdc };
}

/** Último patch de UPDATE que tocó `status: 'failed'`. */
function lastFailedUpdate(): Record<string, unknown> | undefined {
  const patches = mockState.updates as Array<Record<string, unknown>>;
  return [...patches].reverse().find((p) => p.status === 'failed');
}

const originalWallet = process.env.WASIAI_PROTOCOL_FEE_WALLET;
const SPLIT_KEYS = [
  'SPLIT_BPS_PLATFORM',
  'SPLIT_BPS_CREATOR',
  'SPLIT_BPS_REFERRAL',
] as const;
const originalSplitEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  mockState.selectQ.length = 0;
  mockState.updates.length = 0;
  mockState.inserts.length = 0;
  mockSign.mockReset();
  mockSettle.mockReset();
  mockVerifySettle.mockReset();
  logSpy.error.mockClear();
  mockVerifySettle.mockResolvedValue({ ok: true });
  primeSign();
  process.env.WASIAI_PROTOCOL_FEE_WALLET = PLATFORM;
  for (const k of SPLIT_KEYS) {
    originalSplitEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (originalWallet === undefined) {
    delete process.env.WASIAI_PROTOCOL_FEE_WALLET;
  } else {
    process.env.WASIAI_PROTOCOL_FEE_WALLET = originalWallet;
  }
  for (const k of SPLIT_KEYS) {
    const v = originalSplitEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─── fee-charge.ts ──────────────────────────────────────────

describe('src/services/fee-charge.ts — evidencia de broadcast en success:false', () => {
  // T-FEE-201-A: la dirección PELIGROSA. Mutar el `evidenceHash` de vuelta a un
  // `undefined` hardcodeado (el comportamiento viejo) pone rojo este test.
  it('T-FEE-201-A: settle success:false CON hash → conserva el hash (leg + tx_hash + log)', async () => {
    mockSettle.mockResolvedValueOnce({
      txHash: BROADCAST_TX,
      success: false,
      error: 'insufficient funds',
    });

    const result = await chargeProtocolFee({
      orchestrationId: 'orch-201-a',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    // El veredicto de dinero NO cambia: sigue `failed`.
    expect(result.status).toBe('failed');

    // 1. El hash viaja en el leg.
    const platformLeg = result.splits?.find((l) => l.role === 'platform');
    expect(platformLeg?.status).toBe('failed');
    expect(platformLeg?.txHash).toBe(BROADCAST_TX);

    // 2. El hash se PERSISTE en la columna `tx_hash` de la fila failed
    //    (lugar autoritativo — `error_message` lo trunca a 180 chars).
    const patch = lastFailedUpdate();
    expect(patch).toBeDefined();
    expect(patch?.tx_hash).toBe(BROADCAST_TX);

    // 3. El hash sale como CAMPO ESTRUCTURADO del log, no sólo dentro de la prosa.
    const failureLog = logSpy.error.mock.calls.find(
      (c) => c[1] === 'settle reported failure',
    );
    expect(failureLog).toBeDefined();
    const ctx = failureLog?.[0] as Record<string, unknown>;
    expect(ctx.broadcastEvidence).toBe(true);
    expect(ctx.settleTxHash).toBe(BROADCAST_TX);

    // 4. Y también en el mensaje que ve el operador.
    if (result.status === 'failed') {
      expect(result.error).toContain(BROADCAST_TX);
      expect(result.error).toContain('insufficient funds');
    }
  });

  // T-FEE-201-B: el CONTRA-EJEMPLO obligatorio. Sin hash el veredicto NO se
  // toca: mutar a "guardar siempre" (sobre-corrección) pone rojo este test.
  // Sin él, fabricar evidencia de la nada pasaría desapercibido.
  it('T-FEE-201-B: settle success:false SIN hash → NO inventa evidencia', async () => {
    mockSettle.mockResolvedValueOnce({
      txHash: '',
      success: false,
      error: 'network down',
    });

    const result = await chargeProtocolFee({
      orchestrationId: 'orch-201-b',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('failed');

    const platformLeg = result.splits?.find((l) => l.role === 'platform');
    expect(platformLeg?.status).toBe('failed');
    expect(platformLeg?.txHash).toBeUndefined();

    const patch = lastFailedUpdate();
    expect(patch).toBeDefined();
    expect(patch).not.toHaveProperty('tx_hash');

    const failureLog = logSpy.error.mock.calls.find(
      (c) => c[1] === 'settle reported failure',
    );
    const ctx = failureLog?.[0] as Record<string, unknown>;
    expect(ctx.broadcastEvidence).toBe(false);
    expect(ctx).not.toHaveProperty('settleTxHash');
  });

  // T-FEE-201-C: la dirección de ÉXITO también estaba sin candar. Mutar el
  // `buildSplits('charged', txHash)` a `undefined` pone rojo este test.
  it('T-FEE-201-C: settle success:true → el leg charged lleva su hash', async () => {
    mockSettle.mockResolvedValueOnce({ txHash: BROADCAST_TX, success: true });

    const result = await chargeProtocolFee({
      orchestrationId: 'orch-201-c',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('charged');
    const platformLeg = result.splits?.find((l) => l.role === 'platform');
    expect(platformLeg?.status).toBe('charged');
    expect(platformLeg?.txHash).toBe(BROADCAST_TX);
  });
});

// ─── fee-split.ts ───────────────────────────────────────────

describe('src/services/fee-split.ts — evidencia de broadcast en success:false', () => {
  // T-FEE-201-D: dirección PELIGROSA en el leg de split.
  it('T-FEE-201-D: leg con success:false CON hash → conserva el hash (leg + tx_hash + log)', async () => {
    mockSettle.mockResolvedValueOnce({
      txHash: BROADCAST_TX,
      success: false,
      error: 'insufficient funds',
    });

    const result = await settleFeeSplits({
      orchestrationId: 'orch-201-d',
      recipients: [recipient('creator', CREATOR, 1500, 0.15)],
    });

    expect(result.status).toBe('failed');

    const leg = result.legs.find((l) => l.role === 'creator');
    expect(leg?.status).toBe('failed');
    expect(leg?.txHash).toBe(BROADCAST_TX);
    expect(leg?.error).toContain(BROADCAST_TX);

    const patch = lastFailedUpdate();
    expect(patch).toBeDefined();
    expect(patch?.tx_hash).toBe(BROADCAST_TX);

    const failureLog = logSpy.error.mock.calls.find(
      (c) => c[1] === 'split leg settle failed',
    );
    expect(failureLog).toBeDefined();
    const ctx = failureLog?.[0] as Record<string, unknown>;
    expect(ctx.broadcastEvidence).toBe(true);
    expect(ctx.settleTxHash).toBe(BROADCAST_TX);
  });

  // T-FEE-201-E: CONTRA-EJEMPLO del leg de split.
  it('T-FEE-201-E: leg con success:false SIN hash → NO inventa evidencia', async () => {
    mockSettle.mockResolvedValueOnce({
      txHash: '',
      success: false,
      error: 'down',
    });

    const result = await settleFeeSplits({
      orchestrationId: 'orch-201-e',
      recipients: [recipient('creator', CREATOR, 1500, 0.15)],
    });

    expect(result.status).toBe('failed');
    const leg = result.legs.find((l) => l.role === 'creator');
    expect(leg?.status).toBe('failed');
    expect(leg?.txHash).toBeUndefined();

    const patch = lastFailedUpdate();
    expect(patch).toBeDefined();
    expect(patch).not.toHaveProperty('tx_hash');
  });

  // T-FEE-201-F: dirección de ÉXITO del leg de split.
  it('T-FEE-201-F: leg con success:true → el leg charged lleva su hash', async () => {
    mockSettle.mockResolvedValueOnce({ txHash: BROADCAST_TX, success: true });

    const result = await settleFeeSplits({
      orchestrationId: 'orch-201-f',
      recipients: [recipient('creator', CREATOR, 1500, 0.15)],
    });

    expect(result.status).toBe('charged');
    const leg = result.legs.find((l) => l.role === 'creator');
    expect(leg?.status).toBe('charged');
    expect(leg?.txHash).toBe(BROADCAST_TX);
  });

  // T-FEE-201-G: el hash de un leg FALLADO no puede promoverse al agregado.
  // `settleFeeSplits` corta en el return temprano del `failed` (:316) antes del
  // `priorTx` de :335 — este test canda esa precedencia, para que reordenar los
  // bloques no convierta la evidencia de un intento en el txHash del settlement.
  it('T-FEE-201-G: el hash de un leg failed NO sube a settlement.txHash', async () => {
    // platform OK, creator falla CON hash de broadcast.
    mockSettle
      .mockResolvedValueOnce({ txHash: '0xPLATFORM', success: true })
      .mockResolvedValueOnce({
        txHash: BROADCAST_TX,
        success: false,
        error: 'rejected',
      });

    const result = await settleFeeSplits({
      orchestrationId: 'orch-201-g',
      recipients: [
        recipient('platform', PLATFORM, 8500, 0.85),
        recipient('creator', CREATOR, 1500, 0.15),
      ],
    });

    expect(result.status).toBe('failed');
    // El leg guarda su evidencia...
    expect(result.legs.find((l) => l.role === 'creator')?.txHash).toBe(
      BROADCAST_TX,
    );
    // ...pero el agregado NO adopta ningún txHash cuando hay un leg failed.
    expect(result.txHash).toBeUndefined();
  });
});
