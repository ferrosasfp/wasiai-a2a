/**
 * `debit-capture` — los filtros por dueño del ancla del firmante y del lector de
 * firmas (WKH-SEC-04, sitio 12 de los 12, más el 13.º de H-7).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/adapters/escrow/debit-capture.ts:212` es `.eq('owner_ref', ownerRef)` y
 * SOBREVIVÍA a la suite. Medido en `b7fa4e7`: quitándolo, el único rojo es el
 * del guardián estructural (`test/ownership-filter-guard.test.ts`, G-08 y
 * G-09). Ningún test de comportamiento se enteraba.
 *
 * Lo que ese filtro acota es la lectura del `buyer_wallet` que ANCLA al firmante
 * (`:205-216`). Sin él, la firma se compara contra el `buyer_wallet` del intent
 * de OTRO dueño: si la firma recupera esa wallet, el VEREDICTO EN MEMORIA pasa
 * de `SIGNER_MISMATCH` (`:236-242`) a `valid` (`:247`). Eso es exactamente lo
 * medido y lo único que se afirma: quitando el filtro, DC-01 se pone rojo, y lo
 * que DC-01 lee es el veredicto que viajó a `persist()` (`p_status`/`p_reason`,
 * `debit-capture.ts:275-287`).
 *
 * ⚠️ HASTA AHÍ LLEGA: NO se persiste una autorización `valid` contra un intent
 * ajeno. `persist()` llama al RPC `capture_debit_signature`, que re-verifica el
 * dueño en la base —`supabase/migrations/20260713000000_wkh191a_debit_signatures.sql:83-85`,
 * `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION
 * 'OWNERSHIP_MISMATCH'`— y `debit-capture.ts:288` relanza ese error. El
 * comentario de producción DOS LÍNEAS ARRIBA del filtro ya lo dice (`:205-206`).
 * O sea que lo que este filtro aporta es DEFENSA EN PROFUNDIDAD sobre el
 * veredicto: sin él, un veredicto `valid` calculado contra la wallet de otro
 * dueño llega hasta la puerta de la base y lo único que queda entre ese veredicto
 * y una firma consumible es el `RAISE` del RPC. Decir «se persiste» o «es una
 * firma consumible» sería afirmar de más (BLQ-BAJO-1 del AR).
 *
 * Y ESTE ARCHIVO NO PUEDE MEDIR ESA GUARDA: DC-01..DC-04 stubean el RPC
 * (`mockRpc.mockResolvedValue(...)`, `:173-176`), así que toda frase sobre lo
 * que la base persiste es infalsificable acá adentro. Se refuta o se confirma
 * leyendo la migración, no corriendo este archivo.
 *
 * ── EL SITIO 13.º: POR QUÉ TAMBIÉN ESTÁ ACÁ, Y POR QUÉ NO SUMA ────────────
 *
 * `debit-capture.ts:120` (`readValidDebitSignature`) NO está entre los 12
 * porque ya moría: `debit-capture.test.ts:539` lo mata. Pero lo que lo mata es
 * `expect(calls.eq).toContainEqual(['owner_ref', OWNER])`, un ESPÍA DE ARGUMENTO
 * sobre dos dobles que son `eq: () => builder` (`:85`, `:469`) — o sea que
 * registran el filtro y no lo aplican. Un espía prueba QUE LA LLAMADA SE HIZO,
 * no QUÉ FILAS VOLVIERON: pasa igual con el filtro correcto acompañado de una
 * consulta ensanchada, porque nadie mira el resultado.
 *
 * Lo que ese espía SÍ caza es la columna mal escrita, y está medido: mutando
 * `debit-capture.ts:120` a `.eq('ownerRef', ownerRef)` y corriendo
 * `node ./node_modules/vitest/vitest.mjs run src/adapters/escrow/debit-capture.test.ts`
 * da `Tests 1 failed | 19 passed (20)`, rojo en `:539`, porque
 * `toContainEqual` compara el PAR exacto `['owner_ref', OWNER]`. Es el mismo
 * comando que refuta esta frase si algún día deja de ser cierta.
 * DC-03/DC-04 lo cubren por comportamiento. Es un extra declarado: NO forma
 * parte de los 12 ni de la aritmética `11 + 12 = 23`.
 *
 * ── POR QUÉ NO SIRVE `debit-capture.test.ts` PARA ESTO ────────────────────
 *
 * Por lo mismo: sus dos dobles no aplican `eq`. No se lo toca (su contrato
 * `calls.eq` lo consumen sus otros tests): este archivo usa el falso de
 * `src/services/__tests__/owner-scoped-fake.ts`, que aplica EXACTAMENTE los
 * filtros pedidos sobre una tabla con dos dueños.
 *
 * ── QUÉ PROPIEDAD SE PRUEBA, Y CUÁL NO ────────────────────────────────────
 *
 * La propiedad de las dos funciones: dado un par `(intentId, ownerRef)` que no
 * se corresponde, ni el `buyer_wallet` ajeno ancla la firma ni la firma ajena se
 * entrega. NO se prueba que esto detenga un IDOR: el `ownerRef` llega desde la
 * fila del close RPC, no elegido por el caller.
 *
 * Naming: DC-01..DC-04, DC-BS.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({ getLogger: () => logSpy }));

const mockGetDefaultChainKey = vi.hoisted(() => vi.fn(() => 'base-sepolia'));
const mockGetAdaptersBundle = vi.hoisted(() =>
  vi.fn(() => ({ payment: { supportedTokens: [{ decimals: 6 }] } })),
);
vi.mock('../registry.js', () => ({
  getDefaultChainKey: () => mockGetDefaultChainKey(),
  getAdaptersBundle: () => mockGetAdaptersBundle(),
}));

vi.mock('../escrow-verifier.js', () => ({
  resolveEscrowContract: () =>
    '0x7777777777777777777777777777777777777777' as const,
}));

// El sujeto es de dónde sale el `buyer_wallet` contra el que se compara, no la
// criptografía: `recoverDebitAuthorization` se dobla para devolver siempre la
// MISMA wallet, así el único grado de libertad que queda es qué fila leyó el
// código.
const mockRecover = vi.hoisted(() => vi.fn());
vi.mock('./eip712.js', () => ({
  buildDebitDomain: () => ({
    name: 'WasiAIEscrow',
    version: '1',
    chainId: 84532,
    verifyingContract: '0x7777777777777777777777777777777777777777',
  }),
  recoverDebitAuthorization: (...a: unknown[]) => mockRecover(...a),
}));

vi.mock('../../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from '../../lib/supabase.js';
import { createOwnerScopedFake } from '../../services/__tests__/owner-scoped-fake.js';
import type { ChainKey } from '../types.js';
import {
  captureDebitSignature,
  readValidDebitSignature,
} from './debit-capture.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const INTENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHAIN_KEY = 'base-sepolia' as ChainKey;
/** La wallet que la firma recupera SIEMPRE en este archivo. */
const WALLET = '0x1111111111111111111111111111111111111111';
const FINAL_AMOUNT_USD = 1;
/** `parseUnits('1', 6)` — el atómico server-computado con decimals 6. */
const ATOMIC = '1000000';

/** Lo que `debit-capture.ts:208-213` selecciona y filtra. */
const INTENT_COLUMNS = ['id', 'owner_ref', 'buyer_wallet'];

/** Lo que `debit-capture.ts:114-124` selecciona, filtra y ordena. */
const SIGNATURE_COLUMNS = [
  'intent_id',
  'owner_ref',
  'debit_validation_status',
  'captured_at',
  'debit_signature',
  'debit_amount_atomic',
  'debit_deadline',
  'debit_nonce',
  'debit_key_id_hash',
  'debit_hop1_tx_hash',
  'debit_settle_status',
];

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);

/** Un deadline dentro de la ventana `[now, now + 3600]` de `:139` y `:230-235`. */
function okDeadline(): number {
  return Math.floor(Date.now() / 1000) + 600;
}

function signatureRow(
  intentId: string,
  ownerRef: string,
  deadline: number,
): Record<string, unknown> {
  return {
    intent_id: intentId,
    owner_ref: ownerRef,
    debit_validation_status: 'valid',
    captured_at: '2026-08-06T00:00:00.000Z',
    debit_signature: `0xfirma-de-${ownerRef}`,
    debit_amount_atomic: ATOMIC,
    debit_deadline: deadline,
    debit_nonce: '1',
    debit_key_id_hash: '0xhash',
    debit_hop1_tx_hash: null,
    debit_settle_status: null,
  };
}

/** Los argumentos con los que el código llamó al RPC `capture_debit_signature`. */
function rpcArgs(): Record<string, unknown> {
  const call = mockRpc.mock.calls[0];
  expect(call?.[0]).toBe('capture_debit_signature');
  return call?.[1] as Record<string, unknown>;
}

describe('debit-capture — filtros por dueño (WKH-SEC-04)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;
  let deadline: number;

  beforeEach(() => {
    vi.clearAllMocks();
    deadline = okDeadline();
    mockGetDefaultChainKey.mockReturnValue('base-sepolia');
    mockGetAdaptersBundle.mockReturnValue({
      payment: { supportedTokens: [{ decimals: 6 }] },
    });
    mockRecover.mockResolvedValue(WALLET);
    mockRpc.mockResolvedValue({
      data: [{ persisted_status: 'invalid', persisted_reason: null }],
      error: null,
    } as never);

    fake = createOwnerScopedFake({
      a2a_payment_intents: {
        columns: INTENT_COLUMNS,
        rows: [
          // Las DOS filas tienen la MISMA `buyer_wallet`: así el veredicto no
          // puede salir de que las wallets difieran, sino sólo de QUÉ FILA se
          // leyó. Si el filtro no está, A ancla su firma en la fila de B.
          { id: INTENT_A, owner_ref: OWNER_A, buyer_wallet: WALLET },
          { id: INTENT_B, owner_ref: OWNER_B, buyer_wallet: WALLET },
        ],
      },
      a2a_payment_intent_debit_signatures: {
        columns: SIGNATURE_COLUMNS,
        rows: [
          signatureRow(INTENT_A, OWNER_A, deadline),
          signatureRow(INTENT_B, OWNER_B, deadline),
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  function captureArgs(intentId: string, ownerRef: string) {
    return {
      intentId,
      ownerRef,
      keyId: 'key-1',
      chainId: 84532,
      finalAmountUsd: FINAL_AMOUNT_USD,
      capture: {
        signature: '0xfirma',
        nonce: '1',
        deadline,
        amount: ATOMIC,
      },
    };
  }

  it('DC-01 [debit-capture.ts:212]: A firma contra el intent de B → SIGNER_MISMATCH, y el intent de B EXISTE con esa wallet', async () => {
    // Sin afirmar que la fila existe y tiene la wallet, el `SIGNER_MISMATCH`
    // podría venir de una tabla vacía y el test pasaría sin ejercitar el filtro.
    const rowB = fake
      .rows('a2a_payment_intents')
      .find((r) => r.id === INTENT_B);
    expect(rowB?.buyer_wallet).toBe(WALLET);

    await captureDebitSignature(captureArgs(INTENT_B, OWNER_A));

    // La decisión es del código (`:236-249`), no del doble: se lee en los
    // argumentos con los que llamó al RPC (`:275-287`).
    const args = rpcArgs();
    expect(args.p_status).toBe('invalid');
    expect(args.p_reason).toBe('SIGNER_MISMATCH');
  });

  it('DC-02 (anti-vacuidad): A firma contra el SUYO y el veredicto es `valid`', async () => {
    // La otra dirección (CD-6). Sin esto, un filtro con la columna mal escrita
    // —`.eq('ownerRef', …)`— pasaría DC-01 perfectamente y marcaría INVÁLIDA
    // toda firma legítima, con el mismo `SIGNER_MISMATCH`. Con el falso, además,
    // una columna inexistente devuelve 42703 en vez de «no encontré nada».
    await captureDebitSignature(captureArgs(INTENT_A, OWNER_A));

    const args = rpcArgs();
    expect(args.p_status).toBe('valid');
    expect(args.p_reason).toBeNull();
  });

  it('DC-03 [debit-capture.ts:120, EXTRA fuera de los 12]: A lee la firma de B → null, y la firma de B EXISTE', async () => {
    expect(
      fake
        .rows('a2a_payment_intent_debit_signatures')
        .some((r) => r.intent_id === INTENT_B),
    ).toBe(true);

    const row = await readValidDebitSignature({
      intentId: INTENT_B,
      ownerRef: OWNER_A,
      chainKey: CHAIN_KEY,
      finalAmountUsd: FINAL_AMOUNT_USD,
    });

    expect(row).toBeNull();
  });

  it('DC-04 (anti-vacuidad del extra): A lee la SUYA y la obtiene', async () => {
    const row = await readValidDebitSignature({
      intentId: INTENT_A,
      ownerRef: OWNER_A,
      chainKey: CHAIN_KEY,
      finalAmountUsd: FINAL_AMOUNT_USD,
    });

    expect(row).not.toBeNull();
    expect(row?.debit_signature).toBe(`0xfirma-de-${OWNER_A}`);
    // Y no se trajo la de B.
    expect(row?.debit_signature).not.toBe(`0xfirma-de-${OWNER_B}`);
  });

  it('DC-BS (backstop estructural): las dos lecturas llevan el filtro por dueño, y nombra la que falte', async () => {
    // Complemento de los tests de propiedad: si alguien borra UN filtro, este
    // test dice CUÁL de los dos sitios quedó abierto. No los reemplaza —una
    // llamada existente no prueba qué filas salieron—, los ubica.
    await captureDebitSignature(captureArgs(INTENT_A, OWNER_A));
    await readValidDebitSignature({
      intentId: INTENT_A,
      ownerRef: OWNER_A,
      chainKey: CHAIN_KEY,
      finalAmountUsd: FINAL_AMOUNT_USD,
    });

    const scoped = fake
      .resolved()
      .map(
        (q) =>
          `${q.table}:${q.filters.some(([c, v]) => c === 'owner_ref' && v === OWNER_A) ? 'scoped' : 'UNSCOPED'}`,
      );
    expect(scoped).toEqual([
      'a2a_payment_intents:scoped', // debit-capture.ts:212
      'a2a_payment_intent_debit_signatures:scoped', // debit-capture.ts:120
    ]);
  });
});
