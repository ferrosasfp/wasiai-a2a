/**
 * `arbiter.ts` — los filtros por dueño de las dos transiciones de disputa y del
 * read-first del nonce (WKH-SEC-04, sitios 5, 6 y 7 de los 12).
 *
 * El sitio 5 (`arbiter.ts:110`) tiene su propio `describe` al final del archivo,
 * con su declaración: necesita un montaje de gates que los otros dos no.
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/services/arbiter.ts:1070` (`revertDisputeToOpen`) y `:1100`
 * (`holdArbitration`) llevan `.eq('owner_ref', ownerRef)` y SOBREVIVÍAN a la
 * suite. Medido en `b7fa4e7`: quitando cualquiera de los dos, el único rojo es
 * el del guardián estructural (`test/ownership-filter-guard.test.ts`, G-08 y
 * G-09). Ningún test de comportamiento se enteraba.
 *
 * ── POR QUÉ NO SIRVE `arbiter.test.ts` PARA ESTO ──────────────────────────
 *
 * Su doble de supabase (`arbiter.test.ts:340-430`) vive bajo un comentario que
 * dice «from() fiel» y aplica `id` (`:385`) y `status` (`:420`) — pero NUNCA
 * `owner_ref`. Un UPDATE con el filtro por dueño borrado toca exactamente las
 * mismas filas en ese doble. No se lo toca (decenas de tests dependen de su
 * contrato `db.fromImpl`): este archivo usa el falso de
 * `__tests__/owner-scoped-fake.ts`, que aplica EXACTAMENTE los filtros pedidos.
 *
 * ── NO SON DOS TESTS DE UN ENTRELAZADO ────────────────────────────────────
 *
 * El AC-3 del work-item de WKH-SEC-03 daba estos dos sitios por «sólo matables
 * con un test de entrelazado». Medido: no. Los dos son métodos del objeto
 * exportado `arbiterService` (`arbiter.ts:576`, `:1064`, `:1090`) que reciben
 * `(intentId, ownerRef)` como argumentos INDEPENDIENTES. Se los mata cruzando el
 * par de argumentos sobre una base perfectamente consistente, sin ningún hook.
 *
 * ── QUÉ PROPIEDAD SE PRUEBA, Y CUÁL NO ────────────────────────────────────
 *
 * La propiedad de la función: dado un par `(intentId, ownerRef)` que no se
 * corresponde, la transición no se aplica sobre el intent ajeno.
 *
 * Lo que NO se prueba, porque no es cierto: que esto detenga un IDOR vivo. El
 * camino de producción es `POST /session/:id/dispute` (`src/routes/payments.ts:339`),
 * que llama `openDispute(req.params.id, callerKey.owner_ref)`, y `openDispute`
 * compara los dos dueños en JavaScript (`arbiter.ts:606-608`) antes de llegar
 * hasta acá: un `intentId` ajeno se rechaza con `OWNERSHIP_MISMATCH` primero.
 * Decir que estos filtros «impiden» un IDOR sería afirmar de más.
 *
 * Naming: AR-01..AR-06, AR-BS.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

// `holdArbitration` emite un recibo (`arbiter.ts:1106-1117`) que no es el sujeto
// de este archivo. Se dobla para que el test afirme sobre el estado de la tabla
// de intents, no sobre la proof-chain.
const mockEmit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./receipt.js', () => ({
  receiptService: { emit: (...a: unknown[]) => mockEmit(...a) },
}));

// ── Los gates en cascada que hay que armar para llegar al nonce (AR-05).
//    Montaje copiado de `arbiter.test.ts:1664-1740` (`armEscrow`). El doble de
//    supabase de ese archivo NO se copia: es el que nunca aplica `owner_ref`.
const mockGetDefaultChainKey = vi.hoisted(() => vi.fn(() => 'kite'));
const mockGetAdaptersBundle = vi.hoisted(() =>
  vi.fn(() => ({ payment: { supportedTokens: [{ decimals: 6 }] } })),
);
vi.mock('../adapters/registry.js', () => ({
  getDefaultChainKey: () => mockGetDefaultChainKey(),
  getAdaptersBundle: () => mockGetAdaptersBundle(),
  getPaymentAdapter: () => ({ sign: vi.fn(), settle: vi.fn() }),
  getChainConfig: () => ({ name: 'kite', chainId: 2368, explorerUrl: '' }),
}));

const mockResolveEscrow = vi.hoisted(() =>
  vi.fn(() => '0x7777777777777777777777777777777777777777'),
);
const mockReadConsent = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../adapters/escrow-verifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/escrow-verifier.js')>()),
  resolveEscrowContract: () => mockResolveEscrow(),
  readArbitrationConsent: () => mockReadConsent(),
}));

// `deriveArbiterNonce` y `getArbiterNonceSecret` se preservan REALES: son lo que
// produce el nonce propio de A cuando el read-first NO encuentra el de B.
const mockExecResolve = vi.hoisted(() =>
  vi.fn(async (_args: { nonce: bigint }) => ({
    kind: 'confirmed' as const,
    txHash: '0xtx',
  })),
);
vi.mock('../adapters/escrow/arbiter-executor.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../adapters/escrow/arbiter-executor.js')
  >()),
  executeResolveDispute: (a: { nonce: bigint }) => mockExecResolve(a),
}));

// El seam operator-custodial. Se dobla para poder afirmar que NO se cayó a él:
// si algún gate fallara, el test pasaría por la rama equivocada sin avisar.
const mockSettleSeam = vi.hoisted(() =>
  vi.fn(async (_base: unknown) => ({
    status: 'settled' as const,
    txHash: '0xseam',
  })),
);
vi.mock('./payment-intent.js', () => ({
  settlePaymentIntentOnChain: (base: unknown) => mockSettleSeam(base),
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { arbiterService, settleArbitrationOnChain } from './arbiter.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const INTENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Las columnas que las dos cadenas filtran o escriben. */
const INTENT_COLUMNS = ['id', 'owner_ref', 'status'];

/** Las columnas que `upsertArbitrationRow` (`arbiter.ts:520-537`) empuja. */
const ARBITRATION_COLUMNS = [
  'intent_id',
  'owner_ref',
  'decision',
  'method',
  'at_stake_usd',
  'settle_usd',
  'ambiguity_reason',
  'llm_reasoning',
  'evidence_digest',
  'resolved_by',
  'resolved_at',
  'resolution_note',
  'status',
];

const META = {
  decision: 'hold' as const,
  method: 'hold' as const,
  atStakeUsd: 10,
  ambiguityReason: 'test',
  llmReasoning: null,
  evidenceDigest: null,
  sellerRef: 'seller-1',
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
};

/** Las columnas que `getOrCreateArbiterNonce` (`arbiter.ts:106-111`) filtra y lee. */
const NONCE_COLUMNS = ['intent_id', 'owner_ref', 'nonce'];

/** El nonce ya persistido de B. > 2^53 a propósito: se compara como bigint. */
const NONCE_DE_B = '4312989337224638380';
/** Lo que el RPC first-writer-wins devuelve cuando el read-first NO encuentra. */
const NONCE_DEL_RPC = '777';

/**
 * Secreto de test (≥32 chars, ≥16 caracteres únicos) para pasar el guard de
 * entropía de `getArbiterNonceSecret` (`arbiter-executor.ts:136-141`). Espeja
 * `openssl rand -hex 32`. Copiado de `arbiter.test.ts:117`.
 */
const TEST_SECRET = '0123456789abcdef'.repeat(4);

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);

function findIntent(
  fake: ReturnType<typeof createOwnerScopedFake>,
  id: string,
): Record<string, unknown> | undefined {
  return fake.rows('a2a_payment_intents').find((r) => r.id === id);
}

describe('arbiterService — filtros por dueño de las transiciones de disputa (WKH-SEC-04)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createOwnerScopedFake({
      a2a_payment_intents: {
        columns: INTENT_COLUMNS,
        rows: [
          { id: INTENT_A, owner_ref: OWNER_A, status: 'disputed' },
          { id: INTENT_B, owner_ref: OWNER_B, status: 'disputed' },
        ],
      },
      a2a_arbitrations: { columns: ARBITRATION_COLUMNS, rows: [] },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  it('AR-01 [arbiter.ts:1070]: A revierte la disputa de B → la fila de B sigue en `disputed`', async () => {
    // Sin afirmar que la fila existe, un "no cambió nada" podría venir de una
    // tabla vacía y el test pasaría sin ejercitar el filtro (CD-25).
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');

    // ⚠️ `revertDisputeToOpen` TRAGA sus errores (`arbiter.ts:1072-1083`): no
    // lanza y no devuelve nada. La única aserción posible —y la que importa— es
    // el estado de la tabla. Sin el filtro, la disputa de B se cancela sola.
    await arbiterService.revertDisputeToOpen(INTENT_B, OWNER_A);

    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');
    expect(findIntent(fake, INTENT_B)?.owner_ref).toBe(OWNER_B);
  });

  it('AR-02 (anti-vacuidad): A revierte la SUYA y sí pasa a `open`', async () => {
    // La otra dirección (CD-6). Sin esto, un filtro con la columna mal escrita
    // —`.eq('ownerRef', …)`— pasaría AR-01 perfectamente y dejaría al dueño con
    // su propio intent bricked en `disputed`, que es exactamente el bug que
    // `revertDisputeToOpen` existe para reparar (`arbiter.ts:1058-1062`).
    await arbiterService.revertDisputeToOpen(INTENT_A, OWNER_A);

    expect(findIntent(fake, INTENT_A)?.status).toBe('open');
    // Y no arrastró la de B.
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');
  });

  it('AR-03 [arbiter.ts:1100]: A congela la disputa de B → la fila de B sigue en `disputed`', async () => {
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');

    await arbiterService.holdArbitration(INTENT_B, OWNER_A, META);

    // `arb_hold` es TERMINAL (`arbiter.ts:1060-1061`): sin el filtro, A dejaría
    // la disputa de B congelada y esperando revisión humana.
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');
    expect(findIntent(fake, INTENT_B)?.owner_ref).toBe(OWNER_B);
  });

  it('AR-04 (anti-vacuidad): A congela la SUYA y sí pasa a `arb_hold`', async () => {
    const out = await arbiterService.holdArbitration(INTENT_A, OWNER_A, META);

    expect(findIntent(fake, INTENT_A)?.status).toBe('arb_hold');
    expect(out.status).toBe('held');
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');
  });

  it('AR-BS (backstop estructural): las dos escrituras llevan el filtro por dueño, y nombra la que falte', async () => {
    // Complemento de los tests de propiedad: si alguien borra UN filtro, este
    // test dice CUÁL de los dos sitios quedó abierto. No los reemplaza —una
    // llamada existente no prueba qué filas se tocaron—, los ubica.
    await arbiterService.revertDisputeToOpen(INTENT_A, OWNER_A);
    await arbiterService.holdArbitration(INTENT_A, OWNER_A, META);

    const writes = fake
      .resolved()
      .filter((q) => q.table === 'a2a_payment_intents' && q.kind === 'update')
      .map(
        (q) =>
          `update:${q.filters.some(([c, v]) => c === 'owner_ref' && v === OWNER_A) ? 'scoped' : 'UNSCOPED'}`,
      );
    expect(writes).toEqual([
      'update:scoped', // revertDisputeToOpen → arbiter.ts:1070
      'update:scoped', // holdArbitration     → arbiter.ts:1100
    ]);
  });
});

/**
 * `arbiter.ts:110` — el read-first del nonce del árbitro (sitio 5 de los 12).
 *
 * ── POR QUÉ ESTE FILTRO NO ES COSMÉTICO ───────────────────────────────────
 *
 * `intent_id` es la PRIMARY KEY de `a2a_arbiter_nonces`
 * (`supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql:6`;
 * `database.types.ts:44-49`, `isOneToOne: true`). O sea que un `intent_id`
 * determina UNA fila, y el `.eq('owner_ref', …)` decide si esa fila se acepta o
 * se ignora. Sin el filtro, el read-first devuelve el nonce persistido de B
 * (`arbiter.ts:121`) y A lo REUSA en el `resolveDispute` on-chain en vez de
 * derivar el suyo: es reuso de nonce en el camino de escrow, justo lo que
 * WKH-194 existe para impedir.
 *
 * ── EL MONTAJE QUE HACE FALTA ─────────────────────────────────────────────
 *
 * `getOrCreateArbiterNonce` es privada (`arbiter.ts:100`). Se llega por
 * `settleArbitrationOnChain` (`:175`, exportada), que la llama en `:208` sólo
 * después de cuatro gates en cascada (`:186-209`): flag `ESCROW_ARBITER_ENABLED`,
 * `getDefaultChainKey`, `resolveEscrowContract`, `readArbitrationConsent` y
 * `decimals` del token. Cualquiera que falte devuelve el seam operator-custodial
 * SIN tocar el nonce — por eso los dos tests afirman también que NO se cayó al
 * seam: si no, pasarían por la rama equivocada sin avisar.
 *
 * Igual que los otros tres de arbiter, el camino de producción pasa antes por el
 * chequeo de dueño en JavaScript de `openDispute` (`arbiter.ts:606-608`). Lo que
 * se prueba es la propiedad de la función, no una defensa de ruta.
 */
describe('settleArbitrationOnChain — el read-first del nonce (arbiter.ts:110)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;
  const envAntes = {
    flag: process.env.ESCROW_ARBITER_ENABLED,
    secret: process.env.ARBITER_NONCE_SECRET,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ESCROW_ARBITER_ENABLED = 'true';
    process.env.ARBITER_NONCE_SECRET = TEST_SECRET;
    mockGetDefaultChainKey.mockReturnValue('kite');
    mockGetAdaptersBundle.mockReturnValue({
      payment: { supportedTokens: [{ decimals: 6 }] },
    });
    mockResolveEscrow.mockReturnValue(
      '0x7777777777777777777777777777777777777777',
    );
    mockReadConsent.mockResolvedValue(true);
    mockExecResolve.mockResolvedValue({ kind: 'confirmed', txHash: '0xtx' });
    mockRpc.mockResolvedValue({
      data: [{ persisted_nonce: NONCE_DEL_RPC }],
      error: null,
    } as never);

    fake = createOwnerScopedFake({
      a2a_arbiter_nonces: {
        columns: NONCE_COLUMNS,
        rows: [
          { intent_id: INTENT_A, owner_ref: OWNER_A, nonce: '111111' },
          { intent_id: INTENT_B, owner_ref: OWNER_B, nonce: NONCE_DE_B },
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  afterEach(() => {
    // `delete`, no `= undefined`: asignar `undefined` a una env var deja el
    // STRING `"undefined"` de 9 caracteres, o sea que «restaurar» inventaría un
    // `ARBITER_NONCE_SECRET="undefined"` donde antes no había variable. El
    // idioma del repo es `delete` (`arbiter.test.ts:461`, `:463`, `:1398`,
    // `:1730`, `:1747`). Se refuta con
    // `node -e 'process.env.X = undefined; console.log(typeof process.env.X, process.env.X.length)'`
    // → `string 9`.
    if (envAntes.flag === undefined) delete process.env.ESCROW_ARBITER_ENABLED;
    else process.env.ESCROW_ARBITER_ENABLED = envAntes.flag;
    if (envAntes.secret === undefined) delete process.env.ARBITER_NONCE_SECRET;
    else process.env.ARBITER_NONCE_SECRET = envAntes.secret;
  });

  function settleParams(intentId: string, ownerRef: string) {
    return {
      intentId,
      ownerRef,
      payTo: '0x2222222222222222222222222222222222222222',
      finalAmountUsd: 5,
      chainId: 2368,
      keyId: 'key-1',
    };
  }

  /** El `nonce` con el que el código llamó a `executeResolveDispute` (`:212-219`). */
  function nonceUsado(): bigint {
    const arg = mockExecResolve.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    return (arg as { nonce: bigint }).nonce;
  }

  it('AR-05 [arbiter.ts:110]: A settlea el intent de B → NO reusa el nonce persistido de B, y la fila de B SIGUE ahí', async () => {
    // Sin afirmar que la fila existe, un "no lo reusó" podría venir de una tabla
    // vacía y el test pasaría sin ejercitar el filtro (CD-25).
    expect(
      fake.rows('a2a_arbiter_nonces').find((r) => r.intent_id === INTENT_B)
        ?.nonce,
    ).toBe(NONCE_DE_B);

    const out = await settleArbitrationOnChain(settleParams(INTENT_B, OWNER_A));

    // No se cayó al seam: los cuatro gates pasaron y el nonce se resolvió.
    expect(mockSettleSeam).not.toHaveBeenCalled();
    expect(out.status).toBe('settled');
    // LA ASERCIÓN QUE IMPORTA: el nonce que fue a la cadena NO es el de B.
    expect(nonceUsado()).not.toBe(BigInt(NONCE_DE_B));
    expect(nonceUsado()).toBe(BigInt(NONCE_DEL_RPC));
    // Y el read-first fue un MISS, así que hubo que ir al RPC first-writer-wins.
    expect(mockRpc).toHaveBeenCalledWith(
      'get_or_create_arbiter_nonce',
      expect.objectContaining({ p_intent_id: INTENT_B, p_owner_ref: OWNER_A }),
    );
  });

  it('AR-06 (anti-vacuidad): A settlea el SUYO y sí reusa su nonce persistido, sin ir al RPC', async () => {
    // La otra dirección (CD-6). Sin esto, un filtro con la columna mal escrita
    // —`.eq('ownerRef', …)`— pasaría AR-05 perfectamente y rompería el
    // exactly-once de WKH-194: cada pasada derivaría un nonce nuevo para el
    // MISMO intent, que es lo contrario de lo que el read-first garantiza.
    const out = await settleArbitrationOnChain(settleParams(INTENT_A, OWNER_A));

    expect(mockSettleSeam).not.toHaveBeenCalled();
    expect(out.status).toBe('settled');
    expect(nonceUsado()).toBe(111111n);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
