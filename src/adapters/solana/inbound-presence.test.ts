/**
 * WKH-314 — unit de presencia + finalidad + términos (`inbound-presence.ts`).
 * T-FINAL-*, T-SUM-*, T-TERMS-*.
 *
 * ── LO QUE ESTA SUITE EXISTE PARA IMPEDIR ──────────────────────────────────
 *
 * Tres colapsos, cada uno con su mutante:
 *   · aceptar `confirmed` como grant (M35)            → T-FINAL-01
 *   · leer un `confirmationStatus` ausente como
 *     "todavía no" en vez de "no sé" (M36)            → T-FINAL-02
 *   · medir el crédito con `.find()` en vez de
 *     sumando (M37)                                   → T-SUM-01
 *
 * ── LA CONNECTION ES UN DOBLE QUE CUENTA LLAMADAS ──────────────────────────
 *
 * No alcanza con afirmar el veredicto: varios de estos tests afirman **cuántas veces
 * se tocó la red**, porque parte del diseño es no gastarla (una firma sin finalidad
 * probada no se parsea).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  balanceEntry,
  freshPubkey,
  freshSignature,
  parsedTx,
} from './__tests__/inbound-fixtures.js';
import {
  creditedAtomicSum,
  probeInboundProof,
  readInboundTerms,
} from './inbound-presence.js';
// El combinador es puro: se importa para poder afirmar la CONSECUENCIA de un veredicto
// de presencia (quién le gana a quién), no sólo el veredicto suelto.
import { combineInboundPresence } from './inbound-verify.js';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = freshPubkey();
const REFERENCE = freshPubkey();
const SIGNATURE = freshSignature(1);
const WINDOW = { issuedAt: 1_700_000_000, expiresAt: 1_700_000_900 };

/**
 * Doble de `Connection`. Cuenta llamadas por método: varios tests afirman sobre el
 * conteo, no sólo sobre el veredicto.
 */
function fakeConnection(opts: {
  status?: unknown;
  statusThrows?: boolean;
  parsed?: unknown;
  parsedThrows?: boolean;
}) {
  const calls = { getSignatureStatuses: 0, getParsedTransaction: 0 };
  const connection = {
    getSignatureStatuses: vi.fn(async () => {
      calls.getSignatureStatuses++;
      if (opts.statusThrows) throw new Error('rpc down');
      return opts.status ?? { value: [null] };
    }),
    getParsedTransaction: vi.fn(async () => {
      calls.getParsedTransaction++;
      if (opts.parsedThrows) throw new Error('rpc down');
      return opts.parsed ?? null;
    }),
  };
  return { connection, calls };
}

function statusValue(v: Record<string, unknown> | null) {
  return { value: [v] };
}

const ARGS = {
  signature: SIGNATURE,
  payTo: PAY_TO,
  mint: MINT,
  requiredAtomic: '1000000',
  reference: REFERENCE,
  ...WINDOW,
};

/**
 * ⚠️ EL TECHO DE LAS DOS LLAMADAS AL RPC (AR de WKH-314, BLQ-MED-2).
 *
 * Los dos tests de acá usan RELOJ FALSO porque el techo son 8 s reales: esperarlos
 * dos veces sumaría 16 s a cada `npm test`. Lo que se mide NO es el número —eso lo
 * fija una constante de módulo— sino la propiedad: **una llamada que no vuelve NUNCA
 * se resuelve como `unknown`, jamás como `absent` ni como un grant**, y en las dos
 * llamadas, no sólo en la primera.
 */
describe('WKH-314 · el techo de las llamadas al RPC', () => {
  /** Una `Connection` cuyo método bajo prueba nunca resuelve. */
  function hangingConnection(which: 'status' | 'parsed') {
    return {
      getSignatureStatuses: vi.fn(async () =>
        which === 'status'
          ? await new Promise(() => {})
          : statusValue({ err: null, confirmationStatus: 'finalized' }),
      ),
      getParsedTransaction: vi.fn(async () =>
        which === 'parsed' ? await new Promise(() => {}) : null,
      ),
    };
  }

  it('T-RPCTO-01 💰 · un `getSignatureStatuses` que no vuelve ⇒ `unknown`, NUNCA `absent`', async () => {
    vi.useFakeTimers();
    try {
      const verdict = probeInboundProof(
        hangingConnection('status') as never,
        ARGS,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await verdict;
      expect(res.presence.state).toBe('unknown');
      // La distinción que cuesta plata: un vencimiento no es una prueba de ausencia.
      expect(res.presence.state).not.toBe('absent');
      expect(res.binding.state).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('T-RPCTO-02 💰 · un `getParsedTransaction` que no vuelve ⇒ `unknown` en presencia Y binding', async () => {
    vi.useFakeTimers();
    try {
      const verdict = probeInboundProof(
        hangingConnection('parsed') as never,
        ARGS,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await verdict;
      // La finalidad YA estaba probada acá: aun así no se concede nada, porque los
      // términos no se leyeron.
      expect(res.presence.state).toBe('unknown');
      expect(res.binding.state).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('T-RPCTO-03 · GEMELO POSITIVO: una llamada que responde a tiempo NO se corta', async () => {
    // El control de que el techo no denegó todo: sin él, `unknown` sería el veredicto
    // de siempre y los dos tests de arriba pasarían igual.
    const { connection } = fakeConnection({
      status: statusValue({ err: null, confirmationStatus: 'finalized' }),
      parsed: parsedTx({
        accountKeys: [REFERENCE],
        version: 'legacy',
        blockTime: WINDOW.issuedAt + 10,
        meta: {
          err: null,
          preTokenBalances: [
            balanceEntry({
              accountIndex: 1,
              mint: MINT,
              owner: PAY_TO,
              amount: '0',
            }),
          ],
          postTokenBalances: [
            balanceEntry({
              accountIndex: 1,
              mint: MINT,
              owner: PAY_TO,
              amount: '1000000',
            }),
          ],
        },
      }),
    });
    const res = await probeInboundProof(connection as never, ARGS);
    expect(res.presence.state).toBe('finalized_ok');
    expect(res.binding.state).toBe('bound');
  });

  /**
   * T-RPCTO-04 — el docblock de `INBOUND_RPC_TIMEOUT_MS` afirma que el presupuesto de
   * espera al RPC de este archivo entra dentro del techo de las rutas que lo invocan.
   * Ese docblock ya fue falso una vez (decía "los 60 s de `/compose`" cuando `/compose`
   * son 180 s y ninguna ruta del repo usa 60 s — CR de WKH-314, BLQ-BAJO-3), así que la
   * afirmación se DERIVA de los tres archivos donde viven los números en vez de
   * repetirse a mano. Si alguien baja un techo de ruta por debajo del presupuesto, este
   * test se pone rojo y el comentario no envejece en silencio.
   *
   * No se lee a sí mismo: los tres `readFileSync` apuntan a OTROS archivos.
   */
  it('T-RPCTO-04 · el presupuesto de espera al RPC entra en el techo REAL de las rutas (derivado, no escrito a mano)', () => {
    const read = (rel: string) =>
      readFileSync(new URL(rel, import.meta.url), 'utf8');

    const perCallMs = Number(
      /const INBOUND_RPC_TIMEOUT_MS = ([\d_]+);/
        .exec(read('./inbound-presence.ts'))?.[1]
        ?.replace(/_/g, '') ?? Number.NaN,
    );
    expect(Number.isFinite(perCallMs)).toBe(true);
    // 2 llamadas en serie × 2 proveedores. Es lo que ESTE archivo espera al RPC, no el
    // peor caso del request (P0 y Postgres no están acotados por esta constante).
    const rpcBudgetMs = perCallMs * 2 * 2;

    const ceilings: Record<string, number> = {};
    for (const [rel, envName] of [
      ['../../routes/compose.ts', 'TIMEOUT_COMPOSE_MS'],
      ['../../routes/orchestrate.ts', 'TIMEOUT_ORCHESTRATE_MS'],
    ] as const) {
      const m = new RegExp(`${envName} \\?\\? '(\\d+)'`).exec(read(rel));
      expect(m, `${envName} no encontrado en ${rel}`).not.toBeNull();
      ceilings[envName] = Number(m?.[1]);
    }

    for (const [envName, ceiling] of Object.entries(ceilings)) {
      expect(ceiling, `${envName} default`).toBeGreaterThan(rpcBudgetMs);
    }
    // Y el número que el docblock nombra sigue siendo el que el código usa.
    expect(rpcBudgetMs).toBe(32_000);
  });
});

describe('WKH-314 · presencia y finalidad', () => {
  it('T-FINAL-00 · GEMELO POSITIVO: `finalized` + términos cumplidos ⇒ grant', async () => {
    const { connection } = fakeConnection({
      status: statusValue({ err: null, confirmationStatus: 'finalized' }),
      parsed: parsedTx({
        accountKeys: [REFERENCE],
        version: 'legacy',
        blockTime: 1_700_000_100,
        meta: {
          err: null,
          preTokenBalances: [
            balanceEntry({
              accountIndex: 1,
              mint: MINT,
              owner: PAY_TO,
              amount: '0',
            }),
          ],
          postTokenBalances: [
            balanceEntry({
              accountIndex: 1,
              mint: MINT,
              owner: PAY_TO,
              amount: '1000000',
            }),
          ],
        },
      }),
    });
    const res = await probeInboundProof(connection as never, ARGS);
    expect(res.presence.state).toBe('finalized_ok');
    expect(res.binding.state).toBe('bound');
  });

  it('T-FINAL-01 💰 · `confirmed` NO es grant: es `not_finalized` (M35)', async () => {
    const { connection, calls } = fakeConnection({
      status: statusValue({ err: null, confirmationStatus: 'confirmed' }),
    });
    const res = await probeInboundProof(connection as never, ARGS);
    expect(res.presence.state).toBe('not_finalized');
    if (res.presence.state !== 'not_finalized') return;
    expect(res.presence.confirmationStatus).toBe('confirmed');
    // Y NO se gasta una lectura del contenido para algo que no puede conceder.
    expect(calls.getParsedTransaction).toBe(0);
  });

  it('T-FINAL-02 💰 · `confirmationStatus` ausente o desconocido ⇒ `unknown`, NUNCA `not_finalized` (M36)', async () => {
    for (const st of [
      { err: null },
      { err: null, confirmationStatus: null },
      { err: null, confirmationStatus: 'rooted' },
    ]) {
      const { connection } = fakeConnection({ status: statusValue(st) });
      const res = await probeInboundProof(connection as never, ARGS);
      expect(res.presence.state, JSON.stringify(st)).toBe('unknown');
    }
  });

  it('T-UNK-01 💰 · el RPC que TIRA ⇒ `unknown`, nunca `absent`', async () => {
    const { connection } = fakeConnection({ statusThrows: true });
    const res = await probeInboundProof(connection as never, ARGS);
    expect(res.presence.state).toBe('unknown');
  });

  it('T-ABS-01 · `null` DESPUES de buscar el histórico es prueba de ausencia', async () => {
    const { connection } = fakeConnection({ status: statusValue(null) });
    const res = await probeInboundProof(connection as never, ARGS);
    expect(res.presence.state).toBe('absent');
    // …y se buscó de verdad: sin `searchTransactionHistory` un `null` no prueba nada.
    expect(connection.getSignatureStatuses).toHaveBeenCalledWith([SIGNATURE], {
      searchTransactionHistory: true,
    });
  });

  it('T-FAIL-01 · GEMELO POSITIVO: una tx FINALIZADA que falló on-chain no movió nada', async () => {
    const { connection } = fakeConnection({
      status: statusValue({
        err: { InstructionError: [0, 1] },
        confirmationStatus: 'finalized',
      }),
    });
    const res = await probeInboundProof(connection as never, ARGS);
    expect(res.presence.state).toBe('landed_failed');
    // El veto FINALIZADO sigue siendo pegajoso: le gana a un `finalized_ok` del otro
    // proveedor (tier 0 de `presenceRank`). El fix de BLQ-BAJO-1 acota QUIEN puede
    // emitirlo, no debilita lo que hace una vez emitido.
    expect(
      combineInboundPresence(res.presence, {
        state: 'finalized_ok',
        creditedAtomic: '1000000',
      }).state,
    ).toBe('landed_failed');
  });

  it('T-FAIL-02 💰 · un `err` SIN finalidad ⇒ `unknown`, NUNCA `landed_failed` (CR BLQ-BAJO-1)', async () => {
    for (const conf of ['processed', 'confirmed', undefined, null, 'rooted']) {
      const { connection } = fakeConnection({
        status: statusValue({
          err: { InstructionError: [0, 1] },
          ...(conf === undefined ? {} : { confirmationStatus: conf }),
        }),
      });
      const res = await probeInboundProof(connection as never, ARGS);
      // `landed_failed` es TIER 0 y le gana a `finalized_ok`: emitirlo sin finalidad
      // deja a un veto descartable vetando una transferencia que sí se finalizó.
      expect(res.presence.state, `conf=${String(conf)}`).toBe('unknown');
    }
  });

  it('T-FAIL-03 💰 · el escenario del CR: primario `{err, processed}` contra fallback `{null, finalized}` ⇒ gana el FINALIZADO', async () => {
    // Una tx incluida en una bifurcación que después se descarta: el primario la ve
    // fallada a nivel `processed`, el fallback la ve finalizada y OK. Antes del fix el
    // combinador daba `landed_failed` ⇒ `X402_SOLANA_TX_FAILED`, que no es reintentable.
    const primary = await probeInboundProof(
      fakeConnection({
        status: statusValue({
          err: { InstructionError: [0, 1] },
          confirmationStatus: 'processed',
        }),
      }).connection as never,
      ARGS,
    );
    const fallback = await probeInboundProof(
      fakeConnection({
        status: statusValue({ err: null, confirmationStatus: 'finalized' }),
        parsed: parsedTx({
          accountKeys: [REFERENCE],
          version: 'legacy',
          blockTime: 1_700_000_100,
          meta: {
            err: null,
            preTokenBalances: [
              balanceEntry({
                accountIndex: 1,
                mint: MINT,
                owner: PAY_TO,
                amount: '0',
              }),
            ],
            postTokenBalances: [
              balanceEntry({
                accountIndex: 1,
                mint: MINT,
                owner: PAY_TO,
                amount: '1000000',
              }),
            ],
          },
        }),
      }).connection as never,
      ARGS,
    );
    // Precondición MEDIDA del escenario, antes de asertar sobre el combinador.
    expect(primary.presence.state).toBe('unknown');
    expect(fallback.presence.state).toBe('finalized_ok');
    // Y en los DOS órdenes: el resultado no puede depender de cuál proveedor contestó
    // primero.
    expect(
      combineInboundPresence(primary.presence, fallback.presence).state,
    ).toBe('finalized_ok');
    expect(
      combineInboundPresence(fallback.presence, primary.presence).state,
    ).toBe('finalized_ok');
  });

  it('T-UNK-03 💰 · una respuesta de status sin forma usable ⇒ `unknown`', async () => {
    for (const bad of [{ value: [] }, {}, { value: null }]) {
      const { connection } = fakeConnection({ status: bad });
      const res = await probeInboundProof(connection as never, ARGS);
      expect(res.presence.state).toBe('unknown');
    }
  });

  it('T-TERMS-06 💰 · finalidad probada pero el nodo no tiene el parseo ⇒ `unknown`, NO mismatch', async () => {
    const { connection } = fakeConnection({
      status: statusValue({ err: null, confirmationStatus: 'finalized' }),
      parsed: null,
    });
    const res = await probeInboundProof(connection as never, ARGS);
    expect(res.presence.state).toBe('unknown');
  });
});

describe('WKH-314 · los términos', () => {
  const terms = (meta: Record<string, unknown> | null) =>
    readInboundTerms(meta, {
      payTo: PAY_TO,
      mint: MINT,
      requiredAtomic: '1000000',
    });

  it('T-SUM-01 💰 · DOS cuentas del mismo mint y el crédito en la SEGUNDA ⇒ CONCEDE (M37)', () => {
    // Con `.find()` esto daría un `terms_mismatch` FALSO sobre un pago real: tomaría la
    // primera cuenta, mediría delta 0 y diría que el pagador mandó mal la plata.
    const res = terms({
      err: null,
      preTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
        balanceEntry({
          accountIndex: 2,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
      ],
      postTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
        balanceEntry({
          accountIndex: 2,
          mint: MINT,
          owner: PAY_TO,
          amount: '1000000',
        }),
      ],
    });
    expect(res.state).toBe('finalized_ok');
    if (res.state !== 'finalized_ok') return;
    expect(res.creditedAtomic).toBe('1000000');
  });

  it('T-SUM-02 💰 · el crédito REPARTIDO entre dos cuentas se SUMA', () => {
    const res = terms({
      err: null,
      preTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
        balanceEntry({
          accountIndex: 2,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
      ],
      postTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '600000',
        }),
        balanceEntry({
          accountIndex: 2,
          mint: MINT,
          owner: PAY_TO,
          amount: '400000',
        }),
      ],
    });
    expect(res.state).toBe('finalized_ok');
  });

  it('T-SHORT-01 💰 · acreditar de MENOS es `terms_mismatch` con detalle AMOUNT_SHORT', () => {
    const res = terms({
      err: null,
      preTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
      ],
      postTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '999999',
        }),
      ],
    });
    expect(res.state).toBe('terms_mismatch');
    if (res.state !== 'terms_mismatch') return;
    // El motivo tiene que ser DISTINGUIBLE: "te falta plata" y "mandaste a otro lado"
    // se arreglan distinto.
    expect(res.detail).toContain('AMOUNT_SHORT');
  });

  it('T-GRANT-03 💰 · acreditar de MAS concede (comparación con `>=`, nunca `!==`)', () => {
    const res = terms({
      err: null,
      preTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
      ],
      postTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '1000001',
        }),
      ],
    });
    expect(res.state).toBe('finalized_ok');
  });

  it('T-TERMS-02 💰 · otro mint ⇒ deniega, con MINT_MISMATCH', () => {
    const other = freshPubkey();
    const res = terms({
      err: null,
      preTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: other,
          owner: PAY_TO,
          amount: '0',
        }),
      ],
      postTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: other,
          owner: PAY_TO,
          amount: '9999999',
        }),
      ],
    });
    expect(res.state).toBe('terms_mismatch');
    if (res.state !== 'terms_mismatch') return;
    expect(res.detail).toContain('MINT_MISMATCH');
  });

  it('T-TERMS-01 💰 · el mint correcto a OTRO destino ⇒ deniega, con RECIPIENT_MISMATCH', () => {
    const stranger = freshPubkey();
    const res = terms({
      err: null,
      preTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: stranger,
          amount: '0',
        }),
      ],
      postTokenBalances: [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: stranger,
          amount: '5000000',
        }),
      ],
    });
    expect(res.state).toBe('terms_mismatch');
    if (res.state !== 'terms_mismatch') return;
    expect(res.detail).toContain('RECIPIENT_MISMATCH');
  });

  it('T-TERMS-07 💰 · listas ausentes ⇒ `unknown` (un `?? []` acá acreditaría la tesorería entera)', () => {
    expect(terms({ err: null, postTokenBalances: [] }).state).toBe('unknown');
    expect(terms({ err: null, preTokenBalances: [] }).state).toBe('unknown');
    expect(terms(null).state).toBe('unknown');
  });

  it('T-TERMS-08 💰 · una entrada ilegible ⇒ `unknown`, nunca cero', () => {
    // `BigInt('')` da 0n y `BigInt('0x10')` da 16n: por eso el guard es un regex, no un
    // try/catch.
    for (const amount of ['', '   ', '0x10', '1.5', '-1']) {
      const res = terms({
        err: null,
        preTokenBalances: [
          balanceEntry({
            accountIndex: 1,
            mint: MINT,
            owner: PAY_TO,
            amount: '0',
          }),
        ],
        postTokenBalances: [
          balanceEntry({ accountIndex: 1, mint: MINT, owner: PAY_TO, amount }),
        ],
      });
      expect(res.state, amount).toBe('unknown');
    }
  });

  it('T-TERMS-09 💰 · una fila de NUESTRO mint SIN owner declarado ⇒ `unknown`', () => {
    // No se puede ni contar ni descartar: contarla infla el crédito, ignorarla lo hunde.
    const res = terms({
      err: null,
      preTokenBalances: [
        balanceEntry({ accountIndex: 1, mint: MINT, amount: '0' }),
      ],
      postTokenBalances: [
        balanceEntry({ accountIndex: 1, mint: MINT, amount: '1000000' }),
      ],
    });
    expect(res.state).toBe('unknown');
  });

  it('T-TERMS-10 · una entrada sin `mint`/`accountIndex` usables ⇒ `unknown`', () => {
    expect(
      terms({ err: null, preTokenBalances: [null], postTokenBalances: [] })
        .state,
    ).toBe('unknown');
  });

  it('T-TERMS-11 · `meta.err` presente ⇒ `landed_failed`', () => {
    expect(
      terms({ err: { Custom: 1 }, preTokenBalances: [], postTokenBalances: [] })
        .state,
    ).toBe('landed_failed');
  });

  it('T-TERMS-12 · un `requiredAtomic` ilegible ⇒ `unknown`, nunca un grant', () => {
    const res = readInboundTerms(
      {
        err: null,
        preTokenBalances: [
          balanceEntry({
            accountIndex: 1,
            mint: MINT,
            owner: PAY_TO,
            amount: '0',
          }),
        ],
        postTokenBalances: [
          balanceEntry({
            accountIndex: 1,
            mint: MINT,
            owner: PAY_TO,
            amount: '9',
          }),
        ],
      },
      { payTo: PAY_TO, mint: MINT, requiredAtomic: '1e6' },
    );
    expect(res.state).toBe('unknown');
  });
});

describe('WKH-314 · la suma, aislada', () => {
  it('T-SUM-03 · una cuenta nueva (sólo en `post`) cuenta desde cero', () => {
    const res = creditedAtomicSum(
      [],
      [
        balanceEntry({
          accountIndex: 3,
          mint: MINT,
          owner: PAY_TO,
          amount: '250000',
        }),
      ],
      PAY_TO,
      MINT,
    );
    expect(res.ok && res.credited).toBe(250000n);
  });

  it('T-SUM-04 · las cuentas de terceros no entran a la suma', () => {
    const stranger = freshPubkey();
    const res = creditedAtomicSum(
      [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
      ],
      [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '10',
        }),
        balanceEntry({
          accountIndex: 2,
          mint: MINT,
          owner: stranger,
          amount: '999999999',
        }),
      ],
      PAY_TO,
      MINT,
    );
    expect(res.ok && res.credited).toBe(10n);
  });

  it('T-SUM-05 💰 · montos por encima de 2^53 se suman EXACTO (bigint, no Number)', () => {
    const big = '9007199254740993'; // 2^53 + 1: en `Number` es indistinguible de 2^53
    const res = creditedAtomicSum(
      [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: '0',
        }),
      ],
      [
        balanceEntry({
          accountIndex: 1,
          mint: MINT,
          owner: PAY_TO,
          amount: big,
        }),
      ],
      PAY_TO,
      MINT,
    );
    expect(res.ok && res.credited.toString()).toBe(big);
  });
});
