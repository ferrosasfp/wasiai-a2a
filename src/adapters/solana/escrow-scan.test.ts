/**
 * WKH-365 — la tarjeta 3 del tablero (escrows de Solana devnet).
 *
 * Todo lo que se afirma acá se ejecuta contra `scanEscrows` con un `fetch`
 * doblado: no hay red, y las cuentas se CONSTRUYEN byte a byte con el layout
 * declarado, así que los conteos y la suma esperados se DERIVAN de esas mismas
 * cuentas. Un número escrito a mano acá haría pasar una implementación que
 * devuelve constantes.
 */

import { createHash } from 'node:crypto';
import { formatUnits, parseUnits } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base58Encode } from './base58.js';
import {
  ESCROW_STATE_DISCRIMINATOR,
  ESCROW_STATE_SIZE,
  scanEscrows,
} from './escrow-scan.js';

// ── Constructor de cuentas, del layout declarado ─────────────────────────────

const OFFSET_MINT = 104;
const OFFSET_AMOUNT = 136;
const OFFSET_DEADLINE = 144;
const OFFSET_STATUS = 152;

type EscrowStatus = 0 | 1 | 2; // Deposited · Released · Refunded

interface EscrowFixture {
  mint: Uint8Array;
  amount: bigint;
  deadline: bigint;
  status: EscrowStatus;
}

function pubkey(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = (seed + i * 7) % 251 || 1;
  return out;
}

const USDC_MINT_BYTES = pubkey(3);
const OTHER_MINT_BYTES = pubkey(101);
const USDC_MINT = base58Encode(USDC_MINT_BYTES);
const USDC_DECIMALS = 6;

function encodeEscrow(f: EscrowFixture): string {
  const bytes = new Uint8Array(ESCROW_STATE_SIZE);
  bytes.set(ESCROW_STATE_DISCRIMINATOR, 0);
  bytes.set(f.mint, OFFSET_MINT);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(OFFSET_AMOUNT, f.amount, true);
  view.setBigInt64(OFFSET_DEADLINE, f.deadline, true);
  bytes[OFFSET_STATUS] = f.status;
  bytes[ESCROW_STATE_SIZE - 1] = 254; // bump
  return Buffer.from(bytes).toString('base64');
}

function accountEntry(f: EscrowFixture, seed: number): unknown {
  return {
    pubkey: base58Encode(pubkey(seed)),
    account: {
      data: [encodeEscrow(f), 'base64'],
      executable: false,
      lamports: 2_039_280,
      owner: 'DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x',
      rentEpoch: 0,
    },
  };
}

function clockAccount(unixTimestamp: bigint): unknown {
  const bytes = new Uint8Array(40);
  new DataView(bytes.buffer).setBigInt64(32, unixTimestamp, true);
  return {
    context: { slot: 1 },
    value: { data: [Buffer.from(bytes).toString('base64'), 'base64'] },
  };
}

// ── El escenario de tres cuentas ─────────────────────────────────────────────

const CLOCK_NOW = 1_800_000_000n;

/**
 * Una viva en USDC (vencida contra `CLOCK_NOW`), una liberada (NO cuenta ni su
 * plata ni su deadline) y una viva de OTRO mint (cuenta como viva, su plata NO
 * se suma). Los tres desenlaces del clasificador, en el mismo barrido.
 */
const ESCENARIO: EscrowFixture[] = [
  {
    mint: USDC_MINT_BYTES,
    amount: 12_000_000n,
    deadline: CLOCK_NOW - 3_600n,
    status: 0,
  },
  {
    mint: USDC_MINT_BYTES,
    amount: 999_000_000n,
    deadline: CLOCK_NOW - 86_400n,
    status: 1,
  },
  {
    mint: OTHER_MINT_BYTES,
    amount: 5_000_000n,
    deadline: CLOCK_NOW + 3_600n,
    status: 0,
  },
];

const VIVOS = ESCENARIO.filter((e) => e.status === 0);

function esperadoVivos(): number {
  return VIVOS.length;
}

function esperadoOtrosMints(): number {
  return VIVOS.filter((e) => e.mint !== USDC_MINT_BYTES).length;
}

function esperadoUsdcTotal(): bigint {
  return VIVOS.filter((e) => e.mint === USDC_MINT_BYTES).reduce(
    (acc, e) => acc + e.amount,
    0n,
  );
}

/**
 * QUÉ se suma se deriva del escenario; CÓMO se imprime sale de `viem`, que es la
 * convención del repo y NO la que el adaptador tenga adentro.
 *
 * ⚠️ Acá vivía una reimplementación del `padStart` del código bajo prueba, o sea
 * la expectativa y la implementación compartían el defecto: cambiar la
 * convención en los dos lados a la vez seguía dando verde. Con `viem` de este
 * lado, cualquier formateo propio del adaptador pone rojo el test.
 */
function esperadoUsdcBloqueado(): string {
  return formatUnits(esperadoUsdcTotal(), USDC_DECIMALS);
}

function esperadoVencidos(): number {
  return VIVOS.filter((e) => e.deadline < CLOCK_NOW).length;
}

// ── Doble de `fetch` ─────────────────────────────────────────────────────────

let fetchStub: ReturnType<typeof vi.fn>;
const ORIGINAL_ENV = {
  rpc: process.env.SOLANA_RPC_URL,
  mint: process.env.SOLANA_USDC_MINT_DEVNET,
  decimals: process.env.SOLANA_USDC_DECIMALS,
  program: process.env.SOLANA_ESCROW_PROGRAM_ID,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function okBatch(accounts: unknown[], clock: unknown): unknown {
  return [
    { jsonrpc: '2.0', id: 1, result: accounts },
    { jsonrpc: '2.0', id: 2, result: clock },
  ];
}

function escenarioBatch(clock: unknown): unknown {
  return okBatch(
    ESCENARIO.map((f, i) => accountEntry(f, i + 10)),
    clock,
  );
}

/** El body JSON que la última llamada mandó al RPC. */
function ultimoBody(): Array<Record<string, unknown>> {
  const call = fetchStub.mock.calls.at(-1);
  const init = call?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? '[]') as Array<Record<string, unknown>>;
}

beforeEach(() => {
  process.env.SOLANA_RPC_URL = 'https://rpc.test.invalid';
  process.env.SOLANA_USDC_MINT_DEVNET = USDC_MINT;
  process.env.SOLANA_USDC_DECIMALS = String(USDC_DECIMALS);
  delete process.env.SOLANA_ESCROW_PROGRAM_ID;
  fetchStub = vi.fn();
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of [
    ['SOLANA_RPC_URL', ORIGINAL_ENV.rpc],
    ['SOLANA_USDC_MINT_DEVNET', ORIGINAL_ENV.mint],
    ['SOLANA_USDC_DECIMALS', ORIGINAL_ENV.decimals],
    ['SOLANA_ESCROW_PROGRAM_ID', ORIGINAL_ENV.program],
  ] as Array<[string, string | undefined]>) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── T-ESC-DISC / T-ESC-LAYOUT ────────────────────────────────────────────────

describe('la constante del discriminador y el layout', () => {
  it('T-ESC-DISC: el discriminador ES sha256("account:EscrowState") truncado a 8 bytes', () => {
    const recomputado = new Uint8Array(
      createHash('sha256')
        .update('account:EscrowState')
        .digest()
        .subarray(0, 8),
    );
    expect([...ESCROW_STATE_DISCRIMINATOR]).toEqual([...recomputado]);
  });

  it('T-ESC-LAYOUT: el filtro pide dataSize 154 y el memcmp del discriminador en el offset 0', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(escenarioBatch(clockAccount(CLOCK_NOW))),
    );
    await scanEscrows();

    const [gpa] = ultimoBody();
    expect(gpa?.method).toBe('getProgramAccounts');
    const params = gpa?.params as [string, Record<string, unknown>];
    const filters = params[1].filters as Array<Record<string, unknown>>;
    expect(filters[0]).toEqual({ dataSize: ESCROW_STATE_SIZE });
    expect(ESCROW_STATE_SIZE).toBe(154);
    expect(filters[1]).toEqual({
      memcmp: { offset: 0, bytes: base58Encode(ESCROW_STATE_DISCRIMINATOR) },
    });
  });

  it('el reloj se pide EN EL MISMO POST, al sysvar Clock (no hay segunda request)', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(escenarioBatch(clockAccount(CLOCK_NOW))),
    );
    await scanEscrows();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const body = ultimoBody();
    expect(body).toHaveLength(2);
    expect(body[1]?.method).toBe('getAccountInfo');
    expect((body[1]?.params as string[])[0]).toBe(
      'SysvarC1ock11111111111111111111111111111111',
    );
  });
});

// ── T-ESC-1: el control POSITIVO ─────────────────────────────────────────────

describe('T-ESC-1: tres cuentas, tres desenlaces', () => {
  it('cuenta las vivas, suma SOLO el USDC y aparta los otros mints', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(escenarioBatch(clockAccount(CLOCK_NOW))),
    );

    const card = await scanEscrows();

    expect(card.status).toBe('ok');
    if (card.status !== 'ok') return;
    expect(card.escrows_vivos).toBe(esperadoVivos());
    expect(card.usdc_bloqueado).toBe(esperadoUsdcBloqueado());
    expect(card.otros_mints_count).toBe(esperadoOtrosMints());
    expect(card.vencidos).toBe(esperadoVencidos());
  });

  it('el monto se imprime con la convención de `viem`, la del resto del producto', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(escenarioBatch(clockAccount(CLOCK_NOW))),
    );

    const card = await scanEscrows();

    if (card.status !== 'ok') throw new Error('esperaba ok');
    // ANCLA independiente, a mano: el escenario tiene 12 USDC vivos y se
    // imprimen `12`, NO `12.000000`. La copia privada que vivía en el adaptador
    // rellenaba los decimales y ésta era la única superficie del producto que
    // lo hacía.
    expect(esperadoUsdcTotal()).toBe(12_000_000n);
    expect(card.usdc_bloqueado).toBe('12');
    expect(card.usdc_bloqueado).not.toContain('.000000');
  });

  it('la cuenta LIBERADA no aporta su plata (su monto es el más grande del set)', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(escenarioBatch(clockAccount(CLOCK_NOW))),
    );

    const card = await scanEscrows();

    if (card.status !== 'ok') throw new Error('esperaba ok');
    const liberada = ESCENARIO.find((e) => e.status === 1);
    if (liberada === undefined)
      throw new Error('el escenario perdió la liberada');
    // Si se sumara, el total sería mayor que ella sola. Se vuelve a unidades de
    // base con `parseUnits` (y no sacándole el punto a mano) para que la
    // comparación sea entre dos bigints de la MISMA escala.
    const sumada = parseUnits(card.usdc_bloqueado, USDC_DECIMALS);
    expect(sumada).toBeLessThan(liberada.amount);
  });

  it('cero cuentas es una RESPUESTA, no una ausencia', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(okBatch([], clockAccount(CLOCK_NOW))),
    );

    const card = await scanEscrows();

    expect(card).toEqual({
      status: 'ok',
      escrows_vivos: 0,
      // Literal a mano, y es el segundo ancla de la convención: `viem` imprime
      // el cero como `0`, no como `0.000000`.
      usdc_bloqueado: '0',
      otros_mints_count: 0,
      vencidos: 0,
    });
  });
});

// ── T-ESC-2: los tres modos de falla del RPC ─────────────────────────────────

describe('T-ESC-2: el RPC no contesta con datos', () => {
  it('T-ESC-2a: 429 → sin_dato/rpc_error, y `escrows_vivos` NO existe', async () => {
    fetchStub.mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429));

    const card = await scanEscrows();

    expect(card).toEqual({ status: 'sin_dato', reason: 'rpc_error' });
    expect('escrows_vivos' in card).toBe(false);
  });

  it('un 500 también es rpc_error', async () => {
    fetchStub.mockResolvedValue(jsonResponse({}, 500));
    expect(await scanEscrows()).toEqual({
      status: 'sin_dato',
      reason: 'rpc_error',
    });
  });

  it('T-ESC-2b: timeout (AbortError) → sin_dato/rpc_error, y `escrows_vivos` NO existe', async () => {
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'AbortError';
    fetchStub.mockRejectedValue(abort);

    const card = await scanEscrows();

    expect(card).toEqual({ status: 'sin_dato', reason: 'rpc_error' });
    expect('escrows_vivos' in card).toBe(false);
  });

  it('el timeout se pide de verdad (AbortSignal en el init del fetch)', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(escenarioBatch(clockAccount(CLOCK_NOW))),
    );
    await scanEscrows();

    const init = fetchStub.mock.calls[0]?.[1] as { signal?: unknown };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('T-ESC-2c: error JSON-RPC en el getProgramAccounts → sin_dato/rpc_error', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse([
        { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } },
        { jsonrpc: '2.0', id: 2, result: clockAccount(CLOCK_NOW) },
      ]),
    );

    const card = await scanEscrows();

    expect(card).toEqual({ status: 'sin_dato', reason: 'rpc_error' });
    expect('escrows_vivos' in card).toBe(false);
  });

  it('sin SOLANA_RPC_URL → rpc_no_configurado, y NO se llama al RPC público', async () => {
    delete process.env.SOLANA_RPC_URL;

    const card = await scanEscrows();

    expect(card).toEqual({ status: 'sin_dato', reason: 'rpc_no_configurado' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('un shape que no es el esperado → respuesta_invalida (distinto de rpc_error)', async () => {
    fetchStub.mockResolvedValue(jsonResponse({ jsonrpc: '2.0', result: 'ok' }));
    expect(await scanEscrows()).toEqual({
      status: 'sin_dato',
      reason: 'respuesta_invalida',
    });

    fetchStub.mockResolvedValue(
      jsonResponse([
        { jsonrpc: '2.0', id: 1, result: 'no-es-un-array' },
        { id: 2 },
      ]),
    );
    expect(await scanEscrows()).toEqual({
      status: 'sin_dato',
      reason: 'respuesta_invalida',
    });
  });

  it('una cuenta con el tamaño equivocado → respuesta_invalida (no se decodifica a medias)', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(
        okBatch(
          [
            {
              pubkey: base58Encode(pubkey(9)),
              account: {
                data: [Buffer.alloc(100).toString('base64'), 'base64'],
              },
            },
          ],
          clockAccount(CLOCK_NOW),
        ),
      ),
    );

    expect(await scanEscrows()).toEqual({
      status: 'sin_dato',
      reason: 'respuesta_invalida',
    });
  });
});

// ── T-ESC-3: el reloj degrada SOLO ───────────────────────────────────────────

describe('T-ESC-3: el reloj del cluster', () => {
  it('Clock ilegible → vencidos null CON motivo, y el conteo y la suma siguen ahí', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse([
        {
          jsonrpc: '2.0',
          id: 1,
          result: ESCENARIO.map((f, i) => accountEntry(f, i)),
        },
        {
          jsonrpc: '2.0',
          id: 2,
          result: { context: { slot: 1 }, value: null },
        },
      ]),
    );

    const card = await scanEscrows();

    if (card.status !== 'ok') throw new Error('la tarjeta entera no se tira');
    expect(card.escrows_vivos).toBe(esperadoVivos());
    expect(card.usdc_bloqueado).toBe(esperadoUsdcBloqueado());
    expect(card.vencidos).toBeNull();
    // ⚠️ El RPC CONTESTÓ: 200, envelope válido, `value: null`. El motivo es de
    // FORMA, y decir `rpc_error` acá hacía que la pantalla afirmara «el RPC no
    // contestó» sobre un RPC que sí contestó.
    expect('vencidos_reason' in card && card.vencidos_reason).toBe(
      'respuesta_invalida',
    );
    expect('vencidos_reason' in card && card.vencidos_reason).not.toBe(
      'rpc_error',
    );
  });

  it('el sobre del Clock que falta del batch también es respuesta_invalida', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse([
        {
          jsonrpc: '2.0',
          id: 1,
          result: ESCENARIO.map((f, i) => accountEntry(f, i)),
        },
        // El RPC devolvió dos sobres, pero ninguno es el id 2.
        { jsonrpc: '2.0', id: 3, result: clockAccount(CLOCK_NOW) },
      ]),
    );

    const card = await scanEscrows();

    if (card.status !== 'ok') throw new Error('la tarjeta entera no se tira');
    expect(card.vencidos).toBeNull();
    expect('vencidos_reason' in card && card.vencidos_reason).toBe(
      'respuesta_invalida',
    );
  });

  it('un error JSON-RPC SOLO en el Clock tampoco tira la tarjeta, y ESE sí es rpc_error', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse([
        {
          jsonrpc: '2.0',
          id: 1,
          result: ESCENARIO.map((f, i) => accountEntry(f, i)),
        },
        { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'nope' } },
      ]),
    );

    const card = await scanEscrows();

    if (card.status !== 'ok') throw new Error('la tarjeta entera no se tira');
    expect(card.vencidos).toBeNull();
    // Control POSITIVO del corte: los dos motivos NO colapsan. Un `error`
    // JSON-RPC sigue siendo `rpc_error`; el de forma es `respuesta_invalida`.
    expect('vencidos_reason' in card && card.vencidos_reason).toBe('rpc_error');
  });

  it('el veredicto sale del reloj del CLUSTER: mover ese reloj cambia el conteo', async () => {
    // Mismo set de cuentas, dos relojes distintos, dos veredictos distintos.
    // Con `Date.now()` los dos casos darían el mismo número.
    const futuro = ESCENARIO.reduce(
      (max, e) => (e.deadline > max ? e.deadline : max),
      0n,
    );

    fetchStub.mockResolvedValue(jsonResponse(escenarioBatch(clockAccount(0n))));
    const antes = await scanEscrows();

    fetchStub.mockResolvedValue(
      jsonResponse(escenarioBatch(clockAccount(futuro + 1n))),
    );
    const despues = await scanEscrows();

    if (antes.status !== 'ok' || despues.status !== 'ok') {
      throw new Error('esperaba ok en los dos');
    }
    expect(antes.vencidos).toBe(0);
    expect(despues.vencidos).toBe(esperadoVivos());
  });
});

// ── El program id ────────────────────────────────────────────────────────────

describe('el program id que se barre', () => {
  it('sin env usa el default documentado', async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(okBatch([], clockAccount(CLOCK_NOW))),
    );
    await scanEscrows();

    const params = ultimoBody()[0]?.params as [string, unknown];
    expect(params[0]).toBe('DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x');
  });

  it('con env manda el de la env', async () => {
    process.env.SOLANA_ESCROW_PROGRAM_ID = base58Encode(pubkey(77));
    fetchStub.mockResolvedValue(
      jsonResponse(okBatch([], clockAccount(CLOCK_NOW))),
    );
    await scanEscrows();

    const params = ultimoBody()[0]?.params as [string, unknown];
    expect(params[0]).toBe(process.env.SOLANA_ESCROW_PROGRAM_ID);
  });
});
