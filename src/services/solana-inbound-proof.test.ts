/**
 * WKH-314 — unit del seam de uso único (`solana-inbound-proof.ts`). T-STORE-*.
 *
 * ── QUE MIDE ESTA SUITE ────────────────────────────────────────────────────
 *
 * El seam traduce respuestas de Postgres a UNA decisión: **¿se puede servir?** Sólo
 * hay un valor que puede (`outcome: 'consumed'`), y sólo si la escritura atómica
 * devolvió fila con `applied === true`. Casi todos los tests de abajo terminan
 * afirmando que un resultado **NO** es `consumed`. Un `boolean` colapsaría todos esos
 * casos; la unión discriminada es lo que permite exigir el motivo correcto.
 *
 * ── LA MUTACION DE LA HU (M6) ──────────────────────────────────────────────
 *
 * Hacer que este seam falle **ABIERTO** ante un error de DB —o sea, copiar
 * `x402-nonce.ts:47-50`— es la mutación que define si la HU existe. `T-STORE-01`,
 * `T-STORE-02` y `T-STORE-09` la matan por los tres caminos (error, throw, forma
 * inesperada).
 *
 * ── CD-9: EL DOBLE CAPTURA SUS ARGUMENTOS ──────────────────────────────────
 *
 * `rpcCalls` guarda `(fn, args)` de cada llamada. Sin eso, un seam que le mandara a
 * Postgres los términos equivocados pasaría toda la suite: el doble le contestaría lo
 * mismo a cualquier argumento.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

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
vi.mock('../lib/supabase.js', () => ({ supabase: { rpc: rpcMock } }));

import {
  consumeInboundProof,
  INBOUND_PROBE_OK_MARKER,
  peekInboundProof,
  probeInboundProofStore,
  recordInboundObserved,
} from './solana-inbound-proof.js';

const ARGS = {
  caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  signature: '5xY',
  reference: 'REF',
  resource: 'https://gw.example/compose',
  payTo: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  amountAtomic: '1000000',
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

/** Respuesta de PostgREST con forma de fila de las funciones de escritura. */
function row(r: Record<string, unknown>) {
  return { data: [r], error: null, status: 200 };
}

beforeEach(() => {
  rpcCalls.length = 0;
  rpcQueue.length = 0;
  rpcMock.mockClear();
  logSpy.error.mockClear();
});

describe('WKH-314 · seam de uso único — el consumo', () => {
  it('T-STORE-00 · GEMELO POSITIVO: `consumed` + `applied:true` es lo único que autoriza', async () => {
    rpcQueue.push(
      row({ applied: true, outcome: 'consumed', status: 'consumed' }),
    );
    const res = await consumeInboundProof(ARGS);
    expect(res.outcome).toBe('consumed');
  });

  it('T-STORE-01 💰 · un ERROR de Postgres NUNCA concede (M6)', async () => {
    rpcQueue.push({
      data: null,
      error: { code: '57014', message: 'canceling statement due to timeout' },
      status: 500,
    });
    const res = await consumeInboundProof(ARGS);
    expect(res.outcome).toBe('store_unavailable');
    // Y queda ruidoso: un fail-closed silencioso es indistinguible de un rechazo.
    expect(logSpy.error).toHaveBeenCalled();
  });

  it('T-STORE-02 💰 · un THROW del cliente NUNCA concede (M6)', async () => {
    rpcQueue.push(new Error('fetch failed'));
    const res = await consumeInboundProof(ARGS);
    expect(res.outcome).toBe('store_unavailable');
  });

  it('T-STORE-03 💰 · `outcome:consumed` SIN `applied:true` NO concede', async () => {
    // El caso exacto que un `if (outcome === "consumed")` a secas dejaría pasar.
    rpcQueue.push(row({ outcome: 'consumed', status: 'consumed' }));
    const res = await consumeInboundProof(ARGS);
    expect(res.outcome).toBe('store_unavailable');
  });

  it('T-STORE-04 · `already_consumed` es REPLAY, no un fallo del store', async () => {
    rpcQueue.push(
      row({ applied: false, outcome: 'already_consumed', status: 'consumed' }),
    );
    const res = await consumeInboundProof(ARGS);
    expect(res.outcome).toBe('replay');
  });

  it('T-STORE-05 · `terms_conflict` NO es replay: es otro pago', async () => {
    rpcQueue.push(
      row({ applied: false, outcome: 'terms_conflict', status: 'observed' }),
    );
    const res = await consumeInboundProof(ARGS);
    expect(res.outcome).toBe('terms_conflict');
  });

  it('T-STORE-06 💰 · `not_observed` (estado imposible) es fail-closed, NUNCA grant', async () => {
    rpcQueue.push(
      row({ applied: false, outcome: 'not_observed', status: null }),
    );
    const res = await consumeInboundProof(ARGS);
    expect(res.outcome).toBe('store_unavailable');
  });

  it('T-STORE-07 💰 · un `outcome` que no reconocemos NO concede', async () => {
    rpcQueue.push(row({ applied: true, outcome: 'ok_whatever' }));
    const res = await consumeInboundProof(ARGS);
    expect(res.outcome).toBe('store_unavailable');
  });

  it('T-STORE-08 · CD-9 · le manda a Postgres LOS TERMINOS, no sólo la firma', async () => {
    rpcQueue.push(row({ applied: true, outcome: 'consumed' }));
    await consumeInboundProof(ARGS);
    expect(rpcCalls[0]?.fn).toBe('consume_solana_inbound_proof');
    expect(rpcCalls[0]?.args).toEqual({
      p_caip2: ARGS.caip2,
      p_signature: ARGS.signature,
      p_reference: ARGS.reference,
      p_resource: ARGS.resource,
      p_pay_to: ARGS.payTo,
      p_amount_atomic: ARGS.amountAtomic,
      p_mint: ARGS.mint,
    });
  });

  it('T-STORE-09 💰 · `data` vacío o de forma inesperada NO concede', async () => {
    for (const bad of [
      { data: null, error: null, status: 200 },
      { data: [], error: null, status: 200 },
      { data: [{ applied: true }], error: null, status: 200 },
    ]) {
      rpcQueue.push(bad);
      const res = await consumeInboundProof(ARGS);
      expect(res.outcome).toBe('store_unavailable');
    }
  });
});

describe('WKH-314 · seam de uso único — la observación', () => {
  it('T-STORE-10 · GEMELO POSITIVO: `observed` + `applied:true` registra', async () => {
    rpcQueue.push(row({ applied: true, outcome: 'observed', attempts: 1 }));
    const res = await recordInboundObserved(ARGS);
    expect(res).toEqual({ outcome: 'observed', attempts: 1 });
  });

  it('T-STORE-11 · una fila ya `consumed` se reporta como REPLAY', async () => {
    rpcQueue.push(
      row({ applied: false, outcome: 'consumed', status: 'consumed' }),
    );
    const res = await recordInboundObserved(ARGS);
    expect(res.outcome).toBe('replay');
  });

  it('T-STORE-12 · `not_recorded` NO se llama "observado"', async () => {
    rpcQueue.push(row({ applied: false, outcome: 'not_recorded' }));
    const res = await recordInboundObserved(ARGS);
    expect(res.outcome).toBe('store_unavailable');
  });

  it('T-STORE-13 💰 · un error de Postgres al observar NO se lee como "es nueva"', async () => {
    rpcQueue.push({
      data: null,
      error: { code: '', message: 'TypeError: fetch failed' },
      status: 0,
    });
    const res = await recordInboundObserved(ARGS);
    expect(res.outcome).toBe('store_unavailable');
  });
});

describe('WKH-314 · seam de uso único — el peek', () => {
  it('T-STORE-14 · `found:false` es `none` (la firma nunca se presentó)', async () => {
    rpcQueue.push(row({ found: false, status: null }));
    expect((await peekInboundProof('c', 's')).state).toBe('none');
  });

  it('T-STORE-15 · una fila `consumed` corta el camino ANTES de la red', async () => {
    rpcQueue.push(row({ found: true, status: 'consumed' }));
    expect((await peekInboundProof('c', 's')).state).toBe('consumed');
  });

  it('T-STORE-16 · una fila `observed` devuelve SUS TERMINOS (sin ellos no se puede saltar la cadena)', async () => {
    rpcQueue.push(
      row({
        found: true,
        status: 'observed',
        reference: ARGS.reference,
        resource: ARGS.resource,
        pay_to: ARGS.payTo,
        amount_atomic: ARGS.amountAtomic,
        mint: ARGS.mint,
      }),
    );
    const res = await peekInboundProof('c', 's');
    expect(res.state).toBe('observed');
    if (res.state !== 'observed') return;
    expect(res.terms).toEqual({
      reference: ARGS.reference,
      resource: ARGS.resource,
      payTo: ARGS.payTo,
      amountAtomic: ARGS.amountAtomic,
      mint: ARGS.mint,
    });
  });

  it('T-STORE-17 💰 · una fila `observed` SIN términos es `unknown`, no `observed`', async () => {
    rpcQueue.push(row({ found: true, status: 'observed' }));
    expect((await peekInboundProof('c', 's')).state).toBe('unknown');
  });

  it('T-STORE-18 💰 · el store mudo es `unknown`, NUNCA `none`', async () => {
    // `none` significaría "esta firma es nueva" — y sobre eso el store no dijo nada.
    // Leerlo así mandaría a re-verificar y eventualmente a conceder una firma que
    // quizás ya se cobró.
    rpcQueue.push({
      data: null,
      error: { code: '', message: 'fetch failed' },
      status: 0,
    });
    expect((await peekInboundProof('c', 's')).state).toBe('unknown');
    rpcQueue.push(new Error('boom'));
    expect((await peekInboundProof('c', 's')).state).toBe('unknown');
  });

  it('T-STORE-19 · un `status` desconocido es `unknown`, no "gastable"', async () => {
    rpcQueue.push(row({ found: true, status: 'refunded' }));
    expect((await peekInboundProof('c', 's')).state).toBe('unknown');
  });
});

describe('WKH-314 · seam de uso único — el probe del preflight', () => {
  it('T-STORE-20 · la excepción POSITIVA del probe + el peek centinela ⇒ `ok`', async () => {
    rpcQueue.push({
      data: null,
      error: { code: 'P0001', message: `WKH314_PROBE_OK` },
      status: 400,
    });
    rpcQueue.push(row({ found: false }));
    const res = await probeInboundProofStore();
    expect(res.probe).toBe('ok');
    // Y el probe se ejercitó CON `p_probe: true` — sin eso probaría otra cosa.
    expect((rpcCalls[0]?.args as { p_probe?: boolean }).p_probe).toBe(true);
    expect((rpcCalls[1]?.args as { p_probe?: boolean }).p_probe).toBe(false);
    expect(INBOUND_PROBE_OK_MARKER).toBe('WKH314_PROBE_OK');
  });

  it('T-STORE-21 💰 · una función vieja (sin la excepción) NO se lee como `ok`', async () => {
    rpcQueue.push(row({ found: false }));
    const res = await probeInboundProofStore();
    expect(res.probe).toBe('rpc_missing');
  });

  it('T-STORE-22 · la tabla ausente se distingue de la base caída', async () => {
    rpcQueue.push({
      data: null,
      error: { code: 'P0001', message: 'WKH314_PROBE_OK' },
      status: 400,
    });
    rpcQueue.push({
      data: null,
      error: {
        code: '42P01',
        message: 'relation "a2a_solana_inbound_proofs" does not exist',
      },
      status: 400,
    });
    expect((await probeInboundProofStore()).probe).toBe('table_missing');
  });

  it('T-STORE-23 💰 · un fallo de TRANSPORTE no se llama "falta la migración"', async () => {
    // El error que `postgrest-js` DEVUELVE (no lanza) cuando no hubo respuesta:
    // `status: 0` + `code: ''`. Clasificarlo como `rpc_missing` mandaría al operador a
    // re-aplicar una migración que ya estaba aplicada mientras la base sigue caída.
    rpcQueue.push({
      data: null,
      error: { code: '', message: 'TypeError: fetch failed' },
      status: 0,
    });
    expect((await probeInboundProofStore()).probe).toBe('failed');
  });
});
