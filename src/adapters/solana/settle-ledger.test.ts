/**
 * WKH-307 — unit del seam del ledger (`settle-ledger.ts`). T-LDG-01..13.
 *
 * ── QUE MIDE ESTA SUITE ────────────────────────────────────────────────────
 *
 * El seam traduce respuestas de Postgres a DECISIONES DE DINERO. Lo unico que
 * importa de cada traduccion es: **¿este resultado puede autorizar una
 * transferencia?** Solo hay UN valor que puede (`outcome: 'claimed'`), y solo si la
 * escritura atomica devolvio fila con `applied === true`.
 *
 * Por eso casi todos los tests de abajo terminan afirmando que un resultado NO es
 * `claimed` / NO es `ok`. Un `boolean` colapsaria todos esos casos en el mismo
 * `false`; la union discriminada es lo que permite exigir el motivo correcto.
 *
 * ── CD-9: EL DOBLE CAPTURA SUS ARGUMENTOS ──────────────────────────────────
 *
 * `rpcMock` guarda `(fn, args)` de cada llamada y `T-LDG-12` afirma sobre ellos.
 * HU-202 pago este error tres veces: dos mutaciones sobrevivieron porque el doble
 * aceptaba cualquier argumento y ningun test miraba lo que se le habia mandado.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({ getLogger: () => logSpy }));

/**
 * CD-9: el doble CAPTURA sus argumentos, no solo cuenta llamadas.
 *
 * ⚠️ Las respuestas se encolan en `rpcQueue` en vez de con `mockResolvedValueOnce`
 * A PROPOSITO: un `...Once` REEMPLAZA la implementacion, asi que la captura de args
 * se perderia justo en las llamadas que el test configura — que son las unicas que
 * importan. Con la cola, toda llamada pasa por la misma implementacion y siempre
 * queda registrada.
 */
const rpcCalls = vi.hoisted(() => [] as { fn: string; args: unknown }[]);
const rpcQueue = vi.hoisted(() => [] as unknown[]);
const rpcMock = vi.hoisted(() =>
  vi.fn(async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    const next = rpcQueue.shift();
    if (next instanceof Error) throw next;
    return (next ?? { data: null, error: null }) as unknown;
  }),
);
const maybeSingleMock = vi.hoisted(() =>
  vi.fn(async () => ({ data: null, error: null }) as unknown),
);
const limitMock = vi.hoisted(() =>
  vi.fn(async () => ({ data: [], error: null }) as unknown),
);
vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    rpc: rpcMock,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: maybeSingleMock }),
        limit: limitMock,
      }),
    }),
  },
}));

import {
  claimSettleIntent,
  probeSettleLedger,
  readSettleIntent,
  reclaimExpiredIntent,
  recordConfirmedIntent,
  recordSignedIntent,
  resolveSettleLeaseMs,
} from './settle-ledger.js';

/** Fila que devuelven las 4 funciones (misma forma para todas). */
function row(over: Record<string, unknown> = {}) {
  return [
    {
      applied: true,
      outcome: 'claimed',
      status: 'claimed',
      settle_signature: null,
      last_valid_block_height: null,
      attempts: 1,
      ...over,
    },
  ];
}

const CLAIM = {
  intentId: 'run-1:0',
  caip2: 'solana:devnet',
  payTo: 'AgentPayToBase58Address1111111111111111111',
  amountAtomic: '3000000',
  mint: 'MintBase58Address111111111111111111111111',
};

beforeEach(() => {
  vi.clearAllMocks();
  rpcCalls.length = 0;
  rpcQueue.length = 0;
  maybeSingleMock.mockReset();
  limitMock.mockReset();
  delete process.env.SOLANA_SETTLE_LEDGER_LEASE_MS;
});

// ══════════════════════════════════════════════════════════════
// T-LDG-01..05 — un test por `outcome`, y NINGUNO de los cuatro
// no-`claimed` puede confundirse con autorizacion
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · claimSettleIntent — los 5 outcomes', () => {
  it('T-LDG-01: `claimed` con applied=true es el UNICO que autoriza', async () => {
    rpcQueue.push({
      data: row({ attempts: 2 }),
      error: null,
    });
    const res = await claimSettleIntent(CLAIM);
    expect(res.outcome).toBe('claimed');
    if (res.outcome !== 'claimed') return;
    expect(res.attempts).toBe(2);
  });

  it('T-LDG-02: `in_progress` NO autoriza', async () => {
    rpcQueue.push({
      data: row({ applied: false, outcome: 'in_progress' }),
      error: null,
    });
    const res = await claimSettleIntent(CLAIM);
    expect(res.outcome).toBe('in_progress');
    expect(res.outcome).not.toBe('claimed');
  });

  it('T-LDG-03: `signed` devuelve la firma y la altura, sin autorizar', async () => {
    rpcQueue.push({
      data: row({
        applied: false,
        outcome: 'signed',
        status: 'signed',
        settle_signature: 'SigPrev111',
        last_valid_block_height: '123456789',
      }),
      error: null,
    });
    const res = await claimSettleIntent(CLAIM);
    expect(res.outcome).toBe('signed');
    if (res.outcome !== 'signed') return;
    expect(res.signature).toBe('SigPrev111');
    // STRING, nunca Number(): la altura es un uint64 (CD-8).
    expect(res.lastValidBlockHeight).toBe('123456789');
    expect(typeof res.lastValidBlockHeight).toBe('string');
  });

  it('T-LDG-04: `confirmed` devuelve la firma, sin autorizar', async () => {
    rpcQueue.push({
      data: row({
        applied: false,
        outcome: 'confirmed',
        status: 'confirmed',
        settle_signature: 'SigDone222',
      }),
      error: null,
    });
    const res = await claimSettleIntent(CLAIM);
    expect(res.outcome).toBe('confirmed');
    if (res.outcome !== 'confirmed') return;
    expect(res.signature).toBe('SigDone222');
  });

  it('T-LDG-05: `terms_conflict` NO autoriza y NO filtra la firma previa', async () => {
    // Devolver la firma previa aca seria pagarle a A y decirle a B que cobro.
    rpcQueue.push({
      data: row({
        applied: false,
        outcome: 'terms_conflict',
        status: 'confirmed',
        settle_signature: 'SigOfSomeoneElse333',
      }),
      error: null,
    });
    const res = await claimSettleIntent(CLAIM);
    expect(res.outcome).toBe('terms_conflict');
    expect(JSON.stringify(res)).not.toContain('SigOfSomeoneElse333');
  });

  it('T-LDG-05b: `claimed` SIN applied=true NO autoriza', async () => {
    // El outcome por si solo no alcanza: la escritura tiene que haber aplicado.
    for (const applied of [false, undefined, 'true', 1]) {
      rpcQueue.push({
        data: row({ applied }),
        error: null,
      });
      const res = await claimSettleIntent(CLAIM);
      expect(res.outcome).toBe('store_unavailable');
    }
  });
});

// ══════════════════════════════════════════════════════════════
// T-LDG-06..09 — todo lo que no se sabe es fail-closed
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · fail-closed: "no se" nunca autoriza', () => {
  it('T-LDG-06: el rpc LANZA ⟹ store_unavailable, NUNCA claimed', async () => {
    rpcQueue.push(new Error('ECONNREFUSED'));
    const res = await claimSettleIntent(CLAIM);
    expect(res.outcome).toBe('store_unavailable');
    if (res.outcome !== 'store_unavailable') return;
    expect(res.detail).toContain('ECONNREFUSED');
  });

  it('T-LDG-07: error de Postgres NO-23505 ⟹ store_unavailable, NO "no existe"', async () => {
    // La diferencia importa: "no existe" invitaria a reclamar de nuevo; "no se"
    // obliga a no tocar la red.
    rpcQueue.push({
      data: null,
      error: { code: '42P01', message: 'relation does not exist' },
    });
    const res = await claimSettleIntent(CLAIM);
    expect(res.outcome).toBe('store_unavailable');
  });

  it('T-LDG-08: 23505 en recordSigned ⟹ signature_collision, distinguible de not_claimed', async () => {
    rpcQueue.push({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value ... ux_...signature',
      },
    });
    const collision = await recordSignedIntent({
      intentId: 'run-1:0',
      signature: 'SigDup',
      lastValidBlockHeight: '100',
    });
    expect(collision.ok).toBe(false);
    if (collision.ok) return;
    expect(collision.reason).toBe('signature_collision');

    rpcQueue.push({
      data: row({ applied: false, outcome: 'not_claimed', status: 'signed' }),
      error: null,
    });
    const notClaimed = await recordSignedIntent({
      intentId: 'run-1:0',
      signature: 'SigOther',
      lastValidBlockHeight: '100',
    });
    expect(notClaimed.ok).toBe(false);
    if (notClaimed.ok) return;
    // Remedios OPUESTOS: la colision se re-firma, el not_claimed se abandona.
    expect(notClaimed.reason).toBe('not_claimed');
  });

  it('T-LDG-09: `data` vacio / forma inesperada / applied undefined ⟹ NO confirmado', async () => {
    for (const data of [null, [], undefined, 'nope', [{}]]) {
      rpcQueue.push({ data, error: null });
      const res = await recordSignedIntent({
        intentId: 'run-1:0',
        signature: 'S',
        lastValidBlockHeight: '1',
      });
      expect(res.ok).toBe(false);
    }
    // Y el caso puntual del mutante M5: `applied: undefined` NO es exito.
    rpcQueue.push({
      data: row({ applied: undefined, outcome: 'applied' }),
      error: null,
    });
    const undef = await recordSignedIntent({
      intentId: 'run-1:0',
      signature: 'S',
      lastValidBlockHeight: '1',
    });
    expect(undef.ok).toBe(false);
  });

  it('T-LDG-09b: una fila signed/confirmed SIN firma es incoherente ⟹ no autoriza', async () => {
    for (const outcome of ['signed', 'confirmed']) {
      rpcQueue.push({
        data: row({ applied: false, outcome, settle_signature: null }),
        error: null,
      });
      const res = await claimSettleIntent(CLAIM);
      expect(res.outcome).toBe('store_unavailable');
    }
  });
});

// ══════════════════════════════════════════════════════════════
// T-LDG-10..13
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · precision, PII, argumentos y la regla del SELECT', () => {
  it('T-LDG-10: los montos y la altura viajan como STRING, cero coercion numerica', async () => {
    // Un uint64 por encima de 2^53 pierde digitos con Number(). WKH-196 pago caro
    // exactamente este bug.
    // `amount_atomic` es TEXT en la tabla: no tiene techo, asi que uint64 max es un
    // fixture legitimo y el que mas duele si alguien mete un Number().
    const huge = '18446744073709551615';
    /**
     * ⚠️ `last_valid_block_height` es `BIGINT` CON SIGNO (techo 9223372036854775807),
     * NO `TEXT`. Este test usaba `huge` tambien para el, y ejercitar el SQL de verdad
     * mostro que la funcion tira `22003 out of range` con ese valor: la garantia
     * "cualquier uint64 hace round-trip" no existia para esta columna.
     *
     * 2^53 + 1 es el fixture correcto: sigue POR ENCIMA del entero seguro de JS —que es
     * lo que WKH-196 vino a proteger— y entra comodo en BIGINT. Un slot de Solana real
     * ronda 3.5e8.
     */
    const hugeHeight = '9007199254740993';
    rpcQueue.push({ data: row(), error: null });
    await claimSettleIntent({ ...CLAIM, amountAtomic: huge });
    const args = rpcCalls[0]?.args as Record<string, unknown>;
    expect(args.p_amount_atomic).toBe(huge);
    expect(typeof args.p_amount_atomic).toBe('string');

    rpcQueue.push({ data: row({ outcome: 'applied' }), error: null });
    await recordSignedIntent({
      intentId: 'i',
      signature: 'S',
      lastValidBlockHeight: hugeHeight,
    });
    const args2 = rpcCalls[1]?.args as Record<string, unknown>;
    expect(args2.p_last_valid_block_height).toBe(hugeHeight);
    expect(typeof args2.p_last_valid_block_height).toBe('string');
  });

  it('T-LDG-11: los logs NO llevan el payTo entero', async () => {
    rpcQueue.push({
      data: row({ applied: false, outcome: 'terms_conflict' }),
      error: null,
    });
    await claimSettleIntent(CLAIM);
    const logged = JSON.stringify(logSpy.error.mock.calls);
    expect(logged).not.toContain(CLAIM.payTo);
    // Pero SI lo suficiente para reconocerlo en una investigacion.
    expect(logged).toContain(CLAIM.payTo.slice(0, 6));
  });

  it('T-LDG-12 (CD-9): el doble CAPTURA los args y el test los afirma', async () => {
    process.env.SOLANA_SETTLE_LEDGER_LEASE_MS = '45000';
    rpcQueue.push({ data: row(), error: null });
    await claimSettleIntent(CLAIM);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe('claim_solana_settle_intent');
    expect(rpcCalls[0]?.args).toEqual({
      p_intent_id: CLAIM.intentId,
      p_caip2: CLAIM.caip2,
      p_pay_to: CLAIM.payTo,
      p_amount_atomic: CLAIM.amountAtomic,
      p_mint: CLAIM.mint,
      // El lease viaja como PARAMETRO; el UMBRAL lo calcula Postgres con now().
      p_lease_ms: 45000,
      // El camino de dinero NUNCA es un probe.
      p_probe: false,
    });
    expect(resolveSettleLeaseMs()).toBe(45000);
  });

  it('T-LDG-13: ningun camino devuelve `claimed` sin fila devuelta por el upsert', async () => {
    // La regla estructural de todo el diseño: el unico `claimed` posible es el que la
    // escritura atomica devolvio CON fila. Ninguna respuesta degradada puede fabricarlo.
    const degraded = [
      { data: null, error: null },
      { data: [], error: null },
      { data: undefined, error: null },
      { data: null, error: { code: 'XX000', message: 'boom' } },
      { data: [{ outcome: 'claimed' }], error: null }, // sin applied
      { data: [{ applied: false, outcome: 'claimed' }], error: null },
      { data: [{ applied: true }], error: null }, // sin outcome
      { data: [{ applied: true, outcome: 'nonsense' }], error: null },
    ];
    for (const r of degraded) {
      rpcMock.mockResolvedValueOnce(r as never);
      const res = await claimSettleIntent(CLAIM);
      expect(res.outcome).not.toBe('claimed');
    }
    // Y el throw tampoco.
    rpcQueue.push(new Error('x'));
    expect((await claimSettleIntent(CLAIM)).outcome).not.toBe('claimed');
  });
});

describe('WKH-307 · confirmar, reclamar y el peek', () => {
  it('T-LDG-14: recordConfirmed distingue signature_mismatch de store_unavailable', async () => {
    rpcQueue.push({
      data: row({ applied: false, outcome: 'signature_mismatch' }),
      error: null,
    });
    const mismatch = await recordConfirmedIntent({
      intentId: 'i',
      signature: 'S',
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.reason).toBe('signature_mismatch');

    rpcQueue.push(new Error('down'));
    const down = await recordConfirmedIntent({ intentId: 'i', signature: 'S' });
    expect(down.ok).toBe(false);
    if (down.ok) return;
    expect(down.reason).toBe('store_unavailable');
  });

  it('T-LDG-15: reclaimExpired distingue not_signed de store_unavailable', async () => {
    rpcQueue.push({
      data: row({ applied: false, outcome: 'not_signed' }),
      error: null,
    });
    const notSigned = await reclaimExpiredIntent({
      intentId: 'i',
      signature: 'S',
    });
    expect(notSigned.ok).toBe(false);
    if (notSigned.ok) return;
    expect(notSigned.reason).toBe('not_signed');

    rpcQueue.push({ data: row({ outcome: 'applied' }), error: null });
    expect(
      (await reclaimExpiredIntent({ intentId: 'i', signature: 'S' })).ok,
    ).toBe(true);
  });

  it('T-LDG-16: readSettleIntent traduce los 5 estados y NUNCA lanza', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null } as never);
    expect(await readSettleIntent('i')).toEqual({ state: 'none' });

    maybeSingleMock.mockResolvedValueOnce({
      data: { status: 'claimed', settle_signature: null },
      error: null,
    } as never);
    expect(await readSettleIntent('i')).toEqual({ state: 'claimed' });

    maybeSingleMock.mockResolvedValueOnce({
      data: { status: 'signed', settle_signature: 'S1' },
      error: null,
    } as never);
    expect(await readSettleIntent('i')).toEqual({
      state: 'signed',
      signature: 'S1',
    });

    maybeSingleMock.mockResolvedValueOnce({
      data: { status: 'confirmed', settle_signature: 'S2' },
      error: null,
    } as never);
    expect(await readSettleIntent('i')).toEqual({
      state: 'confirmed',
      signature: 'S2',
    });

    // Un error del store NO es "no se pago": es "no se".
    maybeSingleMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    } as never);
    expect((await readSettleIntent('i')).state).toBe('unknown');

    maybeSingleMock.mockRejectedValueOnce(new Error('thrown'));
    expect((await readSettleIntent('i')).state).toBe('unknown');
  });

  it('T-LDG-17: el probe es POSITIVO — solo la marca del RAISE lo aprueba', async () => {
    // Tabla ok + la excepcion esperada ⟹ ok.
    limitMock.mockResolvedValueOnce({ data: [], error: null } as never);
    rpcQueue.push({
      data: null,
      error: { message: 'WKH307_PROBE_OK' },
    });
    expect(await probeSettleLedger()).toEqual({ probe: 'ok' });

    // La tabla no resuelve.
    limitMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'relation does not exist' },
    } as never);
    expect((await probeSettleLedger()).probe).toBe('table_missing');

    // La funcion existe pero NO levanta la marca (version vieja): NO se aprueba.
    limitMock.mockResolvedValueOnce({ data: [], error: null } as never);
    rpcQueue.push({ data: [], error: null });
    expect((await probeSettleLedger()).probe).toBe('rpc_missing');

    limitMock.mockResolvedValueOnce({ data: [], error: null } as never);
    rpcQueue.push({
      data: null,
      error: { message: 'PGRST202 could not find the function' },
    });
    expect((await probeSettleLedger()).probe).toBe('rpc_missing');
  });

  it('T-LDG-18: el probe pide p_probe=true y NO escribe (CD-9 sobre el probe)', async () => {
    limitMock.mockResolvedValueOnce({ data: [], error: null } as never);
    rpcQueue.push({
      data: null,
      error: { message: 'WKH307_PROBE_OK' },
    });
    await probeSettleLedger();
    const args = rpcCalls[0]?.args as Record<string, unknown>;
    expect(args.p_probe).toBe(true);
  });
});
