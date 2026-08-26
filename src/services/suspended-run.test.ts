/**
 * `suspendedRunService` — el estado durable del pipeline suspendido.
 *
 * ── EL DOBLE DE LAS RPC APLICA LA MÁQUINA DE ESTADOS ──────────────────────
 *
 * `claimFake` no dice «OK» siempre: implementa el MISMO orden de guards que el
 * `.sql` (no existe → dueño ajeno → vencido → ya usado → claim) sobre una fila
 * en memoria. Un doble que devolviera siempre la fila dejaría `T-RUN-1` verde
 * con el status-gate borrado de la migración, que es justo lo que hay que medir.
 *
 * ⚠️ Y ESO NO LO CONVIERTE EN PRUEBA DE QUE POSTGRES LO HAGA. Es un doble: mide
 * que el SERVICE traduzca bien cada desenlace y que emita el residuo exactamente
 * una vez. Que la BASE levante esos errores en ese orden lo mide
 * `test/wkh225-suspended-runs.migration.test.ts` sobre el `.sql`. Ninguno de los
 * dos solo alcanza.
 *
 * Naming: T-RUN-1..T-RUN-9.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('./event.js', () => ({
  eventService: { track: vi.fn(async () => ({})) },
}));

import {
  RESUME_ENV_VAR,
  type ResumeTokenCaller,
  SUSPEND_MIN_TTL_SECONDS,
} from '../lib/resume-token.js';
import { supabase } from '../lib/supabase.js';
import type { StepResult } from '../types/index.js';
import { eventService } from './event.js';
import {
  type OpenSuspendedRunInput,
  suspendedRunService,
} from './suspended-run.js';

const OWNER = 'owner-0xaaaa';
const OTRO_OWNER = 'owner-0xbbbb';
const TOKEN_HASH = 'a'.repeat(64);
const CALLER: ResumeTokenCaller = { kind: 'key', id: 'key-1' };
const COMPOSE_RUN = '33333333-3333-3333-3333-333333333333';

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);
const mockTrack = vi.mocked(eventService.track);

let savedSecret: string | undefined;
/** El row que el service le pasó al `insert`, capturado por el doble. */
let capturado: Record<string, unknown> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  capturado = null;
  savedSecret = process.env[RESUME_ENV_VAR];
  process.env[RESUME_ENV_VAR] = 'secreto-de-test';
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env[RESUME_ENV_VAR];
  else process.env[RESUME_ENV_VAR] = savedSecret;
});

function openInput(
  over: Partial<OpenSuspendedRunInput> = {},
): OpenSuspendedRunInput {
  return {
    caller: CALLER,
    ownerRef: OWNER,
    keyId: 'key-1',
    composeRunId: COMPOSE_RUN,
    stepIndex: 1,
    steps: [],
    lastOutput: null,
    remainingSteps: [],
    frozenStepPrices: null,
    totalCostUsdc: 2.5,
    maxBudgetUsdc: null,
    totalLatencyMs: 120,
    contractingChain: [],
    contractingDepth: 0,
    selfHostHint: null,
    chainId: 1,
    ttlSeconds: 3600,
    frozenPricesExpireAtMs: undefined,
    ...over,
  } as OpenSuspendedRunInput;
}

/** Un `insert(...).select(...).single()` que devuelve lo que le digan. */
function insertFake(result: { data: unknown; error: unknown }): void {
  const single = vi.fn(async () => result);
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  mockFrom.mockReturnValue({ insert } as unknown as ReturnType<
    typeof mockFrom
  >);
}

// ── La fila, el doble de las 2 RPC y el del UPDATE condicional ────────────

interface FilaFalsa {
  id: string;
  owner_ref: string;
  status: string;
  expires_at: string;
  compose_run_id: string;
  steps_json: unknown;
}

/** Lo que la base devolvió, o `null` si el error se inyectó. */
interface OpcionesDelDoble {
  /** Fuerza un error de PostgREST en el UPDATE de `expire()`. */
  updateError?: string;
}

/**
 * El MISMO orden de guards que la migración, sobre una fila en memoria, MÁS la
 * semántica transaccional que hace falta para poder distinguir el bug del
 * arreglo.
 *
 * ── 🔴 POR QUÉ EL DOBLE APLICA LAS ESCRITURAS SOBRE UN BORRADOR
 *
 * La versión anterior de este doble hacía `fila.status = 'expired'` y DESPUÉS
 * devolvía el error, o sea que modelaba lo que el Dev quiso que pasara y no lo
 * que Postgres hace. Con eso, `T-RUN-9` ("dos intentos siguen siendo uno") era
 * VACUO: pasaba en verde sobre un `.sql` cuyo UPDATE la base descartaba.
 *
 * Acá cada RPC escribe sobre una COPIA y sólo commitea si vuelve sin levantar.
 * Un `RAISE EXCEPTION` sin bloque `EXCEPTION` aborta la transacción, y PostgREST
 * corre cada `rpc()` en una transacción propia — verificado ejecutando la
 * migración contra un Postgres 16 real. Con este doble, el `.sql` viejo (el que
 * escribía `expired` justo antes del `RAISE`) deja `T-RUN-9` en ROJO, que es
 * exactamente lo que un testigo tiene que poder hacer.
 *
 * ── Y EL `from()` SIRVE EL UPDATE CONDICIONAL DE `expire()`
 *
 * Aplica los filtros pedidos con `===`, uno por uno, y devuelve las filas
 * afectadas. Un `.eq('status','suspended')` borrado del servicio haría que la
 * segunda pasada afectara fila y emitiera un segundo residuo.
 */
function montarRpc(
  fila: FilaFalsa | null,
  nowMs = Date.now(),
  opciones: OpcionesDelDoble = {},
): void {
  /** Commit/rollback: la copia sólo se vuelca si la "función" no levantó. */
  function enTransaccion<T>(
    cuerpo: (borrador: FilaFalsa) => { levanta: string } | T,
  ): { levanta: string } | T | { sinFila: true } {
    if (fila === null) return { sinFila: true };
    const borrador: FilaFalsa = { ...fila };
    const salida = cuerpo(borrador);
    if (typeof salida === 'object' && salida !== null && 'levanta' in salida) {
      // ⛔ ROLLBACK. Todo lo que el cuerpo escribió en el borrador se descarta.
      return salida;
    }
    Object.assign(fila, borrador);
    return salida;
  }

  mockRpc.mockImplementation((async (
    fn: string,
    args: Record<string, unknown>,
  ) => {
    if (fn === 'claim_suspended_run') {
      if (fila === null)
        return { data: null, error: { message: 'RUN_NOT_FOUND' } };
      const r = enTransaccion<{ data: unknown; error: null }>((borrador) => {
        if (borrador.owner_ref !== args.p_owner_ref) {
          // MISMO literal que "no existe". Es lo que hace disclosure-safe al 404.
          return { levanta: 'RUN_NOT_FOUND' };
        }
        if (
          borrador.status === 'suspended' &&
          nowMs >= new Date(borrador.expires_at).getTime()
        ) {
          return { levanta: 'RUN_EXPIRED' };
        }
        // Ya REGISTRADO como vencido: mismo desenlace que el primer intento.
        if (borrador.status === 'expired') return { levanta: 'RUN_EXPIRED' };
        if (borrador.status !== 'suspended') {
          return { levanta: 'RUN_ALREADY_USED' };
        }
        borrador.status = 'resuming';
        return {
          data: [{ id: borrador.id, owner_ref: borrador.owner_ref }],
          error: null,
        };
      });
      if ('levanta' in r) return { data: null, error: { message: r.levanta } };
      if ('sinFila' in r)
        return { data: null, error: { message: 'RUN_NOT_FOUND' } };
      return r;
    }
    if (fn === 'settle_suspended_run') {
      if (fila === null) return { error: { message: 'RUN_NOT_FOUND' } };
      const r = enTransaccion<{ error: null }>((borrador) => {
        if (borrador.owner_ref !== args.p_owner_ref) {
          return { levanta: 'OWNERSHIP_MISMATCH' };
        }
        if (borrador.status !== 'resuming') return { error: null };
        borrador.status =
          args.p_outcome === 'resumed'
            ? 'resumed'
            : args.p_outcome === 'reopen'
              ? 'suspended'
              : 'failed';
        return { error: null };
      });
      if ('levanta' in r) return { error: { message: r.levanta } };
      if ('sinFila' in r) return { error: { message: 'RUN_NOT_FOUND' } };
      return r;
    }
    return { data: null, error: null };
  }) as unknown as typeof mockRpc);

  // El UPDATE condicional de `expire()`: `.update().eq().eq().eq().select()`.
  mockFrom.mockImplementation((() => {
    const filtros: Array<[string, unknown]> = [];
    let parche: Record<string, unknown> = {};
    const builder = {
      update: (next: Record<string, unknown>) => {
        parche = next;
        return builder;
      },
      eq: (columna: string, valor: unknown) => {
        filtros.push([columna, valor]);
        return builder;
      },
      select: () => builder,
      // biome-ignore lint/suspicious/noThenProperty: doble del builder awaitable de supabase
      then: <R>(onFulfilled: (v: unknown) => R): Promise<R> => {
        if (opciones.updateError !== undefined) {
          return Promise.resolve(
            onFulfilled({
              data: null,
              error: { message: opciones.updateError },
            }),
          );
        }
        if (fila === null) {
          return Promise.resolve(onFulfilled({ data: [], error: null }));
        }
        // La clave del gate: `token_hash` no está en la fila en memoria, así que
        // sólo se comparan las columnas que la fila declara. `owner_ref` y
        // `status` SÍ están, y son las dos que aíslan.
        const matchea = filtros.every(
          ([columna, valor]) =>
            !(columna in fila) ||
            (fila as unknown as Record<string, unknown>)[columna] === valor,
        );
        if (!matchea) {
          return Promise.resolve(onFulfilled({ data: [], error: null }));
        }
        Object.assign(fila, parche);
        return Promise.resolve(
          onFulfilled({
            data: [
              {
                id: fila.id,
                compose_run_id: fila.compose_run_id,
                steps_json: fila.steps_json,
              },
            ],
            error: null,
          }),
        );
      },
    };
    return builder;
  }) as unknown as typeof mockFrom);
}

function stepPagado(txHash: string): StepResult {
  return {
    agent: {
      slug: 'remit-kyc-validator',
      registry: 'wasiai',
      payment: { chain: 'base-sepolia' },
    },
    output: {},
    costUsdc: 1.25,
    latencyMs: 30,
    downstreamTxHash: txHash,
  } as unknown as StepResult;
}

// ── open() ────────────────────────────────────────────────────────────────

describe('T-RUN · open()', () => {
  it('T-RUN-3: devuelve el `expiresAt` que escribió la BASE, no uno calculado acá', async () => {
    const DE_LA_BASE = '2030-05-05T05:05:05.000Z';
    insertFake({ data: { id: 'x', expires_at: DE_LA_BASE }, error: null });
    const res = await suspendedRunService.open(openInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.expiresAt).toBe(DE_LA_BASE);
    // Y el token viaja UNA vez, en el resultado, nunca en la fila.
    expect(res.token.startsWith('v1.')).toBe(true);
  });

  it('T-RUN-4: persiste SÓLO el hash, y manda `ttl_seconds` en vez de un instante', async () => {
    const insert = vi.fn((row: unknown) => {
      capturado = row as Record<string, unknown>;
      return {
        select: () => ({
          single: async () => ({
            data: { id: 'x', expires_at: 'z' },
            error: null,
          }),
        }),
      };
    });
    mockFrom.mockReturnValue({ insert } as unknown as ReturnType<
      typeof mockFrom
    >);
    const res = await suspendedRunService.open(openInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = capturado as Record<string, unknown>;
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(res.token);
    expect(JSON.stringify(row)).not.toContain(res.token);
    expect(row.ttl_seconds).toBe(3600);
    // ⛔ CD-19: la app NO escribe el instante de vencimiento.
    expect(row.expires_at).toBeUndefined();
  });

  it('T-RUN-5 (CD-17): los tres campos de la traza anti-bucle se persisten', async () => {
    const insert = vi.fn((row: unknown) => {
      capturado = row as Record<string, unknown>;
      return {
        select: () => ({
          single: async () => ({
            data: { id: 'x', expires_at: 'z' },
            error: null,
          }),
        }),
      };
    });
    mockFrom.mockReturnValue({ insert } as unknown as ReturnType<
      typeof mockFrom
    >);
    await suspendedRunService.open(
      openInput({
        contractingChain: ['gateway-a', 'gateway-b'],
        contractingDepth: 4,
        selfHostHint: 'a2a.wasiai.io',
      }),
    );
    const row = capturado as Record<string, unknown>;
    expect(row.contracting_chain).toEqual(['gateway-a', 'gateway-b']);
    expect(row.contracting_depth).toBe(4);
    expect(row.self_host_hint).toBe('a2a.wasiai.io');
  });

  it('T-RUN-6 (CD-22): las tres formas de NO abrir tienen razones DISTINTAS', async () => {
    // invalid_ttl: cero escrituras, el guard lo rechazó.
    mockFrom.mockClear();
    const porTtl = await suspendedRunService.open(
      openInput({ ttlSeconds: SUSPEND_MIN_TTL_SECONDS - 1 }),
    );
    expect(porTtl).toEqual({ ok: false, reason: 'invalid_ttl' });
    expect(mockFrom).not.toHaveBeenCalled();

    // no_secret: el operador tiene que poner una variable.
    delete process.env[RESUME_ENV_VAR];
    mockFrom.mockClear();
    const sinSecreto = await suspendedRunService.open(openInput());
    expect(sinSecreto).toEqual({ ok: false, reason: 'no_secret' });
    expect(mockFrom).not.toHaveBeenCalled();
    process.env[RESUME_ENV_VAR] = 'secreto-de-test';

    // write_failed: la base no respondió. Otro remedio, otra razón.
    insertFake({ data: null, error: { message: 'boom' } });
    const porEscritura = await suspendedRunService.open(openInput());
    expect(porEscritura.ok).toBe(false);
    if (porEscritura.ok) return;
    expect(porEscritura.reason).toBe('write_failed');
    expect(porEscritura.detail).toBe('boom');
  });
});

// ── claim() ───────────────────────────────────────────────────────────────

describe('T-RUN · claim()', () => {
  const FUTURO = '2099-01-01T00:00:00.000Z';

  function filaViva(expira: string): FilaFalsa {
    return {
      id: 'run-1',
      owner_ref: OWNER,
      status: 'suspended',
      expires_at: expira,
      compose_run_id: COMPOSE_RUN,
      steps_json: [],
    };
  }

  it('T-RUN-1 (AC-5): un segundo claim sobre la misma fila da `already_used`', async () => {
    const fila = filaViva(FUTURO);
    montarRpc(fila);
    const primero = await suspendedRunService.claim(TOKEN_HASH, OWNER);
    expect(primero.ok).toBe(true);
    expect(fila.status).toBe('resuming');
    const segundo = await suspendedRunService.claim(TOKEN_HASH, OWNER);
    expect(segundo).toEqual({ ok: false, reason: 'already_used' });
  });

  it('T-RUN-2 (AC-6): "no existe" y "otro dueño" son INDISTINGUIBLES', async () => {
    const fila = filaViva(FUTURO);
    montarRpc(fila);
    const ajeno = await suspendedRunService.claim(TOKEN_HASH, OTRO_OWNER);
    montarRpc(null);
    const inexistente = await suspendedRunService.claim(TOKEN_HASH, OTRO_OWNER);
    // El objeto ENTERO, no sólo el `reason`: si algún día se agrega un campo
    // que sólo aparece en uno de los dos, el 404 deja de ser disclosure-safe.
    expect(ajeno).toEqual(inexistente);
    expect(ajeno).toEqual({ ok: false, reason: 'not_found' });
    // Y el dueño ajeno NO consumió la fila.
    expect(fila.status).toBe('suspended');
  });

  it('T-RUN-7: un RPC caído es `unavailable`, no `not_found`', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated' },
    } as never);
    expect(await suspendedRunService.claim(TOKEN_HASH, OWNER)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('T-RUN-8: un RPC que no tira pero no devuelve fila es FAIL-CLOSED', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null } as never);
    expect(await suspendedRunService.claim(TOKEN_HASH, OWNER)).toEqual({
      ok: false,
      reason: 'already_used',
    });
  });
});

// ── el vencimiento y su residuo (AC-7) ────────────────────────────────────

describe('T-RUN · el residuo del vencimiento', () => {
  const PASADO = '2020-01-01T00:00:00.000Z';

  function filaVencida(steps: unknown = [stepPagado('0xdeadbeef')]): FilaFalsa {
    return {
      id: 'run-1',
      owner_ref: OWNER,
      status: 'suspended',
      expires_at: PASADO,
      compose_run_id: COMPOSE_RUN,
      steps_json: steps,
    };
  }

  it('T-RUN-9 (AC-7 · fix-pack AR/BLQ-ALTO-1): la fila queda TERMINAL y el residuo es UNO, con N intentos', async () => {
    const fila = filaVencida();
    montarRpc(fila);

    const primero = await suspendedRunService.claim(TOKEN_HASH, OWNER);
    expect(primero).toEqual({ ok: false, reason: 'expired' });
    // 🔴 LA MITAD QUE EL TESTIGO VIEJO NO PODÍA VER. `expired` sólo es
    // alcanzable si la transición vive AFUERA del RPC que levanta: con el `.sql`
    // anterior (UPDATE + RAISE en la misma transacción) esta línea da
    // `'suspended'`, porque el doble descarta lo que la función escribió antes
    // de levantar — que es lo que Postgres hace.
    expect(fila.status).toBe('expired');
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0]?.[0]?.eventType).toBe(
      'compose_stranded_payment',
    );

    // 🔴 Y LA OTRA MITAD: TRES intentos más. El `.sql` anterior emitía UN
    // RESIDUO POR INTENTO (la fila nunca salía de `suspended`), y eso es lo que
    // dejaba a un caller autenticado encender `strandedExposureBreached` en
    // `/health` a voluntad. Acá el UPDATE condicional afecta 0 filas.
    for (let intento = 0; intento < 3; intento++) {
      const otro = await suspendedRunService.claim(TOKEN_HASH, OWNER);
      // Y el caller recibe el MISMO desenlace que la primera vez: un token
      // vencido da 410 la primera vez y la cuarta, no un 409 que diga que el run
      // "se usó" cuando lo que pasó es que se le venció.
      expect(otro).toEqual({ ok: false, reason: 'expired' });
    }
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(fila.status).toBe('expired');
  });

  it('SIN evidencia on-chain no se emite NADA, pero la fila IGUAL queda terminal', async () => {
    // Un step sin `downstreamTxHash` ni `txHash` no entra al residuo.
    const fila = filaVencida([
      { agent: { slug: 'x' }, output: {}, costUsdc: 0, latencyMs: 1 },
    ]);
    montarRpc(fila);
    const res = await suspendedRunService.claim(TOKEN_HASH, OWNER);
    expect(res).toEqual({ ok: false, reason: 'expired' });
    expect(mockTrack).not.toHaveBeenCalled();
    // Que no haya plata varada NO significa que el run no venció: la transición
    // se aplica igual, y por eso el segundo claim no vuelve a pasar por acá.
    expect(fila.status).toBe('expired');
  });

  it('si el UPDATE falla, el vencimiento se reporta IGUAL (expire nunca lanza)', async () => {
    const fila = filaVencida();
    montarRpc(fila, Date.now(), { updateError: 'boom' });
    await expect(suspendedRunService.claim(TOKEN_HASH, OWNER)).resolves.toEqual(
      { ok: false, reason: 'expired' },
    );
    expect(mockTrack).not.toHaveBeenCalled();
    // La fila NO se movió: el error de la base no se inventa una transición.
    expect(fila.status).toBe('suspended');
  });

  it('si `track` rechaza, el vencimiento se reporta igual — fire-and-forget con catch', async () => {
    montarRpc(filaVencida());
    mockTrack.mockRejectedValueOnce(new Error('events down'));
    await expect(suspendedRunService.claim(TOKEN_HASH, OWNER)).resolves.toEqual(
      { ok: false, reason: 'expired' },
    );
  });

  it('T-RUN-10 (AC-6): un dueño ajeno sobre un run vencido NO emite el residuo del otro', async () => {
    const fila = filaVencida();
    montarRpc(fila);
    // El claim ni siquiera llega al guard de vencimiento: el dueño no coincide.
    const res = await suspendedRunService.claim(TOKEN_HASH, OTRO_OWNER);
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(mockTrack).not.toHaveBeenCalled();
    expect(fila.status).toBe('suspended');
  });
});

// ── settle() ──────────────────────────────────────────────────────────────

describe('T-RUN · settle()', () => {
  it('cierra exactly-once y distingue los tres desenlaces (CD-22)', async () => {
    const fila: FilaFalsa = {
      id: 'run-1',
      owner_ref: OWNER,
      status: 'resuming',
      expires_at: '2099-01-01T00:00:00.000Z',
      compose_run_id: COMPOSE_RUN,
      steps_json: [],
    };
    montarRpc(fila);
    expect(
      await suspendedRunService.settle('run-1', OWNER, 'resumed', null),
    ).toEqual({ ok: true });
    expect(fila.status).toBe('resumed');
    // Un segundo settle sobre un run terminal es no-op (status-gate), y eso NO
    // es un error: es idempotencia.
    expect(
      await suspendedRunService.settle('run-1', OWNER, 'failed', 'x'),
    ).toEqual({ ok: true });
    expect(fila.status).toBe('resumed');
  });

  it('un dueño ajeno recibe `ownership_mismatch`, y ningún estado se mueve', async () => {
    const fila: FilaFalsa = {
      id: 'run-1',
      owner_ref: OWNER,
      status: 'resuming',
      expires_at: '2099-01-01T00:00:00.000Z',
      compose_run_id: COMPOSE_RUN,
      steps_json: [],
    };
    montarRpc(fila);
    expect(
      await suspendedRunService.settle('run-1', OTRO_OWNER, 'resumed', null),
    ).toEqual({ ok: false, reason: 'ownership_mismatch' });
    expect(fila.status).toBe('resuming');
  });

  it('ninguna función devuelve `boolean` ni `null` colapsante (CD-22)', async () => {
    // El control mecánico del contrato: los cuatro caminos devuelven objetos
    // con `ok` discriminante. Un `false` no distinguiría "el guard lo rechazó"
    // de "la escritura falló", que se operan distinto.
    montarRpc(null);
    const resultados = [
      await suspendedRunService.claim(TOKEN_HASH, OWNER),
      await suspendedRunService.settle('run-1', OWNER, 'resumed', null),
      await suspendedRunService.open(openInput({ ttlSeconds: 1 })),
    ];
    for (const r of resultados) {
      expect(typeof r).toBe('object');
      expect(r).not.toBeNull();
      expect(typeof (r as { ok: unknown }).ok).toBe('boolean');
    }
  });
});
