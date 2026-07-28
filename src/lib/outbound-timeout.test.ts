/**
 * HU-195 — techo de wall-clock por request outbound.
 *
 * LOS DOS EJES SE TESTEAN POR SEPARADO A PROPÓSITO, porque el bug es justamente
 * que la gente los confunde:
 *
 *   T-195-A (INACTIVIDAD) — servidor que manda el primer chunk y se queda MUDO.
 *     Lo corta `bodyTimeout` del Agent. Muta borrando `bodyTimeout` de
 *     `outboundAgentOptions()` → el default de undici (300 s) toma el control y
 *     el test se cuelga hasta su propio timeout → ROJO.
 *
 *   T-195-B (WALL-CLOCK) — servidor que TRICKLE-FEEDEA: un byte cada N ms, con
 *     N < el techo, para siempre. `bodyTimeout` NUNCA lo dispara porque undici lo
 *     REFRESCA en cada chunk (`client-h1.js` `onBody` → `this.timeout.refresh()`).
 *     Sólo lo corta el `AbortSignal` del eje B. Este es EL test de la HU: si
 *     alguien "arregla" el problema poniendo únicamente `bodyTimeout`, T-195-B se
 *     pone rojo.
 *
 * Los servidores son `node:http` sobre 127.0.0.1 en puerto efímero — cero red
 * externa. El connector SSRF real bloquea loopback, así que los tests end-to-end
 * construyen el `Agent` con `outboundAgentOptions()` (LOS MISMOS techos que
 * producción) y reemplazan SÓLO el `lookup`; mismo patrón que el test T-H1 de
 * redirects en `ssrf-dispatcher.test.ts`.
 */

import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTBOUND_HOP_TIMEOUT_MS,
  outboundWallClockSignal,
  resolveOutboundHopTimeoutMs,
} from './outbound-timeout.js';
import { outboundAgentOptions } from './ssrf-dispatcher.js';

// ─── helpers de servidor local ────────────────────────────────────────────

/** Servidor que manda headers + 1 chunk y NUNCA más nada (peer MUDO). */
function createMuteAfterFirstChunkServer(): HttpServer {
  return createHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"a":');
    // Nunca `res.end()`: el body queda abierto para siempre.
  });
}

/**
 * Servidor que TRICKLE-FEEDEA: un byte cada `gapMs`, sin cerrar nunca. Con
 * `gapMs` < bodyTimeout el eje A jamás dispara.
 */
function createTrickleServer(gapMs: number): HttpServer {
  const timers = new Set<NodeJS.Timeout>();
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(' ');
    const t = setInterval(() => {
      if (!res.writableEnded) res.write(' ');
    }, gapMs);
    timers.add(t);
    res.on('close', () => {
      clearInterval(t);
      timers.delete(t);
    });
  });
  server.on('close', () => {
    for (const t of timers) clearInterval(t);
    timers.clear();
  });
  return server;
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * Agent con los techos REALES de producción (`outboundAgentOptions()`) pero con
 * un `lookup` permisivo, para poder alcanzar el servidor local (el `ssrfLookup`
 * real bloquea 127.0.0.1 y eso ya está cubierto por `ssrf-dispatcher.test.ts`).
 */
function localAgentWithProdCeilings(): Agent {
  const opts = outboundAgentOptions();
  return new Agent({
    ...opts,
    connect: {
      lookup: (
        _hostname: string,
        _options: unknown,
        cb: (
          err: NodeJS.ErrnoException | null,
          address: Array<{ address: string; family: number }>,
        ) => void,
      ) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    },
  });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ─── resolveOutboundHopTimeoutMs ──────────────────────────────────────────

describe('resolveOutboundHopTimeoutMs — env + invariante del clamp', () => {
  it('T-195-ENV-1: sin env → default seguro (60_000), NO el default de undici (300_000)', () => {
    delete process.env.OUTBOUND_HOP_TIMEOUT_MS;
    delete process.env.TIMEOUT_COMPOSE_MS;
    expect(resolveOutboundHopTimeoutMs()).toBe(DEFAULT_OUTBOUND_HOP_TIMEOUT_MS);
    expect(resolveOutboundHopTimeoutMs()).toBe(60_000);
    expect(resolveOutboundHopTimeoutMs()).toBeLessThan(300_000);
  });

  it('T-195-ENV-2: env válida se respeta', () => {
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '7500';
    expect(resolveOutboundHopTimeoutMs()).toBe(7500);
  });

  it.each([
    ['0'],
    ['-1'],
    ['abc'],
    [''],
  ])('T-195-ENV-3: env inválida (%s) → default seguro', (raw) => {
    process.env.OUTBOUND_HOP_TIMEOUT_MS = raw;
    expect(resolveOutboundHopTimeoutMs()).toBe(DEFAULT_OUTBOUND_HOP_TIMEOUT_MS);
  });

  it('T-195-ENV-4: INVARIANTE — el techo del hop NUNCA excede TIMEOUT_COMPOSE_MS', () => {
    // Un operador pide 10 min por hop contra un 504 de 3 min: el techo efectivo
    // es el 504, si no el "techo" no sirve para nada.
    process.env.TIMEOUT_COMPOSE_MS = '180000';
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '600000';
    expect(resolveOutboundHopTimeoutMs()).toBe(180_000);
  });

  it('T-195-ENV-5: el clamp también aplica al DEFAULT si el 504 es más chico que 60 s', () => {
    process.env.TIMEOUT_COMPOSE_MS = '15000';
    delete process.env.OUTBOUND_HOP_TIMEOUT_MS;
    expect(resolveOutboundHopTimeoutMs()).toBe(15_000);
  });

  it('T-195-ENV-6: TIMEOUT_COMPOSE_MS basura → se clampea contra su propio default (180_000)', () => {
    process.env.TIMEOUT_COMPOSE_MS = 'nope';
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '999999';
    expect(resolveOutboundHopTimeoutMs()).toBe(180_000);
  });
});

// ─── outboundWallClockSignal ──────────────────────────────────────────────

describe('outboundWallClockSignal — composición de presupuestos', () => {
  it('T-195-SIG-1: sin signal del caller → aborta por el techo (razón TimeoutError)', async () => {
    const sig = outboundWallClockSignal(undefined, 30);
    expect(sig.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 90));
    expect(sig.aborted).toBe(true);
    expect((sig.reason as Error).name).toBe('TimeoutError');
  });

  it('T-195-SIG-2: gana el presupuesto MÁS CORTO del caller (el techo no lo relaja)', async () => {
    const caller = new AbortController();
    const sig = outboundWallClockSignal(caller.signal, 60_000);
    caller.abort(new Error('caller-budget'));
    // `AbortSignal.any` propaga en microtask.
    await Promise.resolve();
    expect(sig.aborted).toBe(true);
    expect((sig.reason as Error).message).toBe('caller-budget');
  });

  it('T-195-SIG-3: un caller con presupuesto MÁS LARGO no puede saltear el techo', async () => {
    const caller = new AbortController(); // nunca aborta
    const sig = outboundWallClockSignal(caller.signal, 30);
    await new Promise((r) => setTimeout(r, 90));
    expect(sig.aborted).toBe(true);
    expect((sig.reason as Error).name).toBe('TimeoutError');
  });
});

// ─── EJE A: inactividad (bodyTimeout del Agent) ───────────────────────────

describe('HU-195 eje A — techo de INACTIVIDAD en el Agent', () => {
  it('T-195-A: un peer que manda 1 chunk y se queda MUDO es cortado por bodyTimeout', async () => {
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '250';
    const server = createMuteAfterFirstChunkServer();
    const port = await listen(server);
    const agent = localAgentWithProdCeilings();
    try {
      // Sin `signal`: el ÚNICO freno posible acá es el eje A.
      const res = await undiciFetch(`http://mute.example:${port}/`, {
        dispatcher: agent,
      });
      let caught: unknown;
      try {
        await res.text();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      // undici envuelve el BodyTimeoutError como `cause` del TypeError del stream.
      const msg = JSON.stringify([
        (caught as Error)?.message,
        ((caught as { cause?: Error })?.cause as Error)?.message,
        ((caught as { cause?: Error })?.cause as { code?: string })?.code,
      ]);
      expect(msg).toMatch(/UND_ERR_BODY_TIMEOUT|Body Timeout|terminated/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.destroy().catch(() => {});
    }
  }, 10_000);

  it('T-195-A2: outboundAgentOptions fija AMBOS timeouts de inactividad al techo resuelto', () => {
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '4321';
    const opts = outboundAgentOptions();
    expect(opts.headersTimeout).toBe(4321);
    expect(opts.bodyTimeout).toBe(4321);
  });
});

// ─── EJE B: wall-clock (el trickle-feed) ──────────────────────────────────

describe('HU-195 eje B — techo de WALL-CLOCK contra trickle-feed', () => {
  it('T-195-B: un peer que emite 1 byte cada 40 ms NO dispara bodyTimeout (500 ms) y ES cortado por el wall-clock', async () => {
    // El techo de INACTIVIDAD (500 ms) es 12x el gap del trickle (40 ms), así que
    // NUNCA se dispara: undici lo refresca en cada chunk. El único freno es el
    // AbortSignal del eje B, con un presupuesto explícito de 300 ms.
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '500';
    const server = createTrickleServer(40);
    const port = await listen(server);
    const agent = localAgentWithProdCeilings();
    try {
      const startedAt = Date.now();
      const res = await undiciFetch(`http://trickle.example:${port}/`, {
        dispatcher: agent,
        signal: outboundWallClockSignal(undefined, 300),
      });
      let caught: unknown;
      try {
        await res.text();
      } catch (e) {
        caught = e;
      }
      const elapsed = Date.now() - startedAt;
      expect(caught).toBeDefined();
      // Cortado por el wall-clock, MUY antes del techo de inactividad de 500 ms
      // (que con un gap de 40 ms no llegaría nunca).
      expect(elapsed).toBeLessThan(3_000);
      const msg = JSON.stringify([
        (caught as Error)?.name,
        (caught as Error)?.message,
        ((caught as { cause?: Error })?.cause as Error)?.name,
      ]);
      expect(msg).toMatch(/AbortError|TimeoutError|aborted|terminated/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.destroy().catch(() => {});
    }
  }, 15_000);

  it('T-195-B2: el trickle SOBREVIVE al eje A cuando el eje B no está — prueba que los ejes NO son el mismo', async () => {
    // Contraprueba explícita del matiz: mismo servidor, mismo techo de
    // inactividad, SIN `signal`. Con un gap de 40 ms y bodyTimeout de 400 ms,
    // el hop sigue vivo pasados 1.2 s (3 bodyTimeouts) — o sea que poner sólo
    // `bodyTimeout` NO cierra el agujero.
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '400';
    const server = createTrickleServer(40);
    const port = await listen(server);
    const agent = localAgentWithProdCeilings();
    try {
      const res = await undiciFetch(`http://trickle2.example:${port}/`, {
        dispatcher: agent,
      });
      const reader = (
        res.body as unknown as ReadableStream<Uint8Array>
      ).getReader();
      const deadline = Date.now() + 1_200;
      let stillFeeding = false;
      while (Date.now() < deadline) {
        const { done } = await reader.read();
        if (done) break;
        stillFeeding = true;
      }
      // Sigue alimentando después de 3x el bodyTimeout → el eje A no lo corta.
      expect(stillFeeding).toBe(true);
      expect(Date.now()).toBeGreaterThanOrEqual(deadline);
      await reader.cancel().catch(() => {});
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.destroy().catch(() => {});
    }
  }, 15_000);
});
