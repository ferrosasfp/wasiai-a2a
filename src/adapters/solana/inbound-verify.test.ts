/**
 * WKH-314 — unit del combinador y del binding (`inbound-verify.ts`). T-UNK-*, T-BIND-*.
 *
 * ── POR QUE ESTA SUITE NO TIENE UN SOLO MOCK DE RED ────────────────────────
 *
 * El combinador es PURO. Eso no es una preferencia de estilo: es lo que permite
 * recorrer la tabla de precedencia ENTERA —las 36 combinaciones de dos veredictos—
 * sin fabricar una respuesta de RPC por caso. Un combinador escondido dentro del
 * cliente HTTP se testea con seis mocks y se cubre la mitad.
 *
 * ── LAS CUATRO REGLAS BAJO PRUEBA ──────────────────────────────────────────
 *
 * 1. `terms_mismatch` es pegajoso y le gana a `finalized_ok`  → T-UNK-06 (mata M39)
 * 2. un `absent` contradicho por un `unknown` NO es negativa  → T-UNK-05
 * 3. sin fallback, el veredicto del primario se usa tal cual  → T-UNK-07
 * 4. una lista de cuentas INCOMPLETA nunca prueba ausencia    → T-BIND-04/05
 */

import { describe, expect, it } from 'vitest';
import type { SolanaInboundBinding, SolanaInboundPresence } from '../types.js';
import { freshPubkey, parsedTx } from './__tests__/inbound-fixtures.js';
import {
  combineInboundBinding,
  combineInboundPresence,
  readInboundBinding,
} from './inbound-verify.js';

const OK: SolanaInboundPresence = {
  state: 'finalized_ok',
  creditedAtomic: '1000000',
};
const MISMATCH: SolanaInboundPresence = {
  state: 'terms_mismatch',
  detail: 'AMOUNT_SHORT: …',
};
const FAILED: SolanaInboundPresence = {
  state: 'landed_failed',
  detail: '{"InstructionError":[0,1]}',
};
const PENDING: SolanaInboundPresence = {
  state: 'not_finalized',
  confirmationStatus: 'confirmed',
};
const ABSENT: SolanaInboundPresence = { state: 'absent' };
const UNKNOWN: SolanaInboundPresence = {
  state: 'unknown',
  detail: 'ECONNRESET',
};

describe('WKH-314 · combinador de dos proveedores', () => {
  it('T-UNK-04 · GEMELO POSITIVO: primario `absent` + fallback `finalized_ok` ⇒ GRANT', () => {
    // Un nodo atrasado no puede negarle el servicio a un pago que el otro ya vio.
    expect(combineInboundPresence(ABSENT, OK)).toEqual(OK);
  });

  it('T-UNK-05 💰 · primario `absent` + fallback `unknown` ⇒ `unknown`, NO `absent`', () => {
    // La ausencia exige DOS testigos que hayan buscado. Uno que no contesta no vota.
    const res = combineInboundPresence(ABSENT, UNKNOWN);
    expect(res.state).toBe('unknown');
  });

  it('T-UNK-05b · GEMELO POSITIVO: los DOS `absent` ⇒ `absent` (prueba de ausencia)', () => {
    expect(combineInboundPresence(ABSENT, ABSENT).state).toBe('absent');
  });

  it('T-UNK-06 💰 · `terms_mismatch` LE GANA a `finalized_ok`, en los dos órdenes (M39)', () => {
    // Dos parseos de la misma firma no pueden discrepar legítimamente sobre los
    // números: la transacción es inmutable. Si discrepan, es una anomalía y se deniega.
    expect(combineInboundPresence(OK, MISMATCH).state).toBe('terms_mismatch');
    expect(combineInboundPresence(MISMATCH, OK).state).toBe('terms_mismatch');
  });

  it('T-UNK-07 💰 · SIN fallback configurado, un `unknown` sigue siendo `unknown`', () => {
    // `null` = no preguntamos. Nunca puede mejorar un veredicto.
    expect(combineInboundPresence(UNKNOWN, null).state).toBe('unknown');
    expect(combineInboundPresence(ABSENT, null).state).toBe('absent');
    expect(combineInboundPresence(OK, null)).toEqual(OK);
  });

  it('T-UNK-08 · la precedencia completa, en los DOS órdenes', () => {
    const cases: [SolanaInboundPresence, SolanaInboundPresence, string][] = [
      [OK, FAILED, 'finalized_ok'],
      [OK, PENDING, 'finalized_ok'],
      [OK, UNKNOWN, 'finalized_ok'],
      [OK, ABSENT, 'finalized_ok'],
      [MISMATCH, FAILED, 'terms_mismatch'],
      [MISMATCH, UNKNOWN, 'terms_mismatch'],
      [FAILED, PENDING, 'landed_failed'],
      [FAILED, UNKNOWN, 'landed_failed'],
      [PENDING, UNKNOWN, 'not_finalized'],
      [PENDING, ABSENT, 'not_finalized'],
      [UNKNOWN, UNKNOWN, 'unknown'],
    ];
    for (const [a, b, expected] of cases) {
      expect(combineInboundPresence(a, b).state, `${a.state}+${b.state}`).toBe(
        expected,
      );
      expect(combineInboundPresence(b, a).state, `${b.state}+${a.state}`).toBe(
        expected,
      );
    }
  });

  it('T-UNK-09 · el combinador NUNCA inventa un `finalized_ok` que nadie reportó', () => {
    const noGrant = [MISMATCH, FAILED, PENDING, ABSENT, UNKNOWN];
    for (const a of noGrant) {
      for (const b of [...noGrant, null]) {
        expect(combineInboundPresence(a, b).state).not.toBe('finalized_ok');
      }
    }
  });
});

describe('WKH-314 · combinador del binding', () => {
  const BOUND: SolanaInboundBinding = {
    state: 'bound',
    blockTime: 1_700_000_100,
  };
  const NOREF: SolanaInboundBinding = {
    state: 'reference_absent',
    detail: 'x',
  };
  const OUT: SolanaInboundBinding = { state: 'outside_window', detail: 'x' };
  const UNK: SolanaInboundBinding = { state: 'unknown', detail: 'x' };

  it('T-BIND-01 · una negativa MEDIDA le gana a un `bound` (la tx es inmutable)', () => {
    expect(combineInboundBinding(BOUND, NOREF).state).toBe('reference_absent');
    expect(combineInboundBinding(NOREF, BOUND).state).toBe('reference_absent');
    expect(combineInboundBinding(BOUND, OUT).state).toBe('outside_window');
  });

  it('T-BIND-02 · GEMELO POSITIVO: `bound` + `unknown` ⇒ `bound`', () => {
    expect(combineInboundBinding(BOUND, UNK).state).toBe('bound');
    expect(combineInboundBinding(UNK, BOUND).state).toBe('bound');
  });

  it('T-BIND-03 · sin fallback, el del primario tal cual', () => {
    expect(combineInboundBinding(UNK, null).state).toBe('unknown');
  });
});

describe('WKH-314 · lectura del binding', () => {
  const REF = freshPubkey();
  const OTHER = freshPubkey();
  const WINDOW = { issuedAt: 1_700_000_000, expiresAt: 1_700_000_900 };

  it('T-BIND-04 · GEMELO POSITIVO: la referencia está entre las cuentas y el tiempo cae dentro', () => {
    const res = readInboundBinding(
      parsedTx({
        accountKeys: [OTHER, REF],
        blockTime: 1_700_000_100,
        version: 'legacy',
      }),
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('bound');
  });

  it('T-BIND-05 💰 · tx v0 SIN direcciones cargadas y sin la referencia ⇒ `unknown`, JAMAS `reference_absent`', () => {
    // Es el caso que decide si un pago legítimo hecho con lookup tables se rechaza
    // como fraudulento. La lista está INCOMPLETA: no encontrar algo en ella no prueba
    // que no esté.
    const res = readInboundBinding(
      parsedTx({ accountKeys: [OTHER], blockTime: 1_700_000_100, version: 0 }),
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('unknown');
  });

  it('T-BIND-06 · legacy, lista COMPLETA y la referencia no está ⇒ `reference_absent`', () => {
    const res = readInboundBinding(
      parsedTx({
        accountKeys: [OTHER],
        blockTime: 1_700_000_100,
        version: 'legacy',
      }),
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('reference_absent');
  });

  it('T-BIND-07 · la referencia puede venir en `meta.loadedAddresses` (v0 resuelta)', () => {
    const res = readInboundBinding(
      parsedTx({
        accountKeys: [OTHER],
        blockTime: 1_700_000_100,
        version: 0,
        loadedAddresses: { writable: [], readonly: [REF] },
      }),
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('bound');
  });

  it('T-BIND-08 · v0 con `loadedAddresses` presente y la referencia ausente ⇒ negativa MEDIDA', () => {
    const res = readInboundBinding(
      parsedTx({
        accountKeys: [OTHER],
        blockTime: 1_700_000_100,
        version: 0,
        loadedAddresses: { writable: [], readonly: [] },
      }),
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('reference_absent');
  });

  it('T-BIND-09 💰 · `blockTime` ANTERIOR a `issuedAt` ⇒ `outside_window` (la firma "robada del explorer")', () => {
    const res = readInboundBinding(
      parsedTx({
        accountKeys: [REF],
        blockTime: WINDOW.issuedAt - 1,
        version: 'legacy',
      }),
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('outside_window');
  });

  it('T-BIND-10 · `blockTime` POSTERIOR a `expiresAt` ⇒ `outside_window`', () => {
    const res = readInboundBinding(
      parsedTx({
        accountKeys: [REF],
        blockTime: WINDOW.expiresAt + 1,
        version: 'legacy',
      }),
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('outside_window');
  });

  it('T-BIND-11 💰 · `blockTime` ausente ⇒ `unknown`, no "fuera de la ventana"', () => {
    const res = readInboundBinding(
      parsedTx({ accountKeys: [REF], blockTime: null, version: 'legacy' }),
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('unknown');
  });

  it('T-BIND-12 💰 · sin lista de cuentas ⇒ `unknown`', () => {
    expect(readInboundBinding(null, { reference: REF, ...WINDOW }).state).toBe(
      'unknown',
    );
    expect(
      readInboundBinding(
        { transaction: { message: {} }, blockTime: 1 },
        {
          reference: REF,
          ...WINDOW,
        },
      ).state,
    ).toBe('unknown');
  });

  it('T-BIND-13 💰 · una entrada de cuenta que no resuelve a dirección ⇒ `unknown`', () => {
    const res = readInboundBinding(
      {
        blockTime: 1_700_000_100,
        version: 'legacy',
        transaction: { message: { accountKeys: [{ nope: true }] } },
        meta: {},
      },
      { reference: REF, ...WINDOW },
    );
    expect(res.state).toBe('unknown');
  });
});
