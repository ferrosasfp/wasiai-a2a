/**
 * Tests for `src/lib/ssrf-dispatcher.ts` — connect-time SSRF guard
 * (M2, audit 2026-06-24).
 *
 * The dispatcher closes the TOCTOU / DNS-rebinding gap: it revalidates the IP
 * at the REAL moment of connection (the same resolution the socket uses) using
 * the SAME `isBlockedAddress` predicate as the write-time validator.
 *
 * Two layers of coverage:
 *  A. Unit — `ssrfLookup` (the connector lookup): a DNS result that contains a
 *     private/metadata IP is REJECTED; an all-public result is passed through
 *     unchanged; a DNS error propagates.
 *  B. Integration — a real undici `Agent` (built by `getSsrfDispatcher`) driving
 *     `ssrfFetch`. We mock `node:dns.lookup` (callback form) so a rebinding
 *     hostname resolves to 169.254.169.254 / 127.0.0.1 and assert the
 *     connection is BLOCKED at connect-time (before reaching a real local
 *     server), plus that the wrapper threads the dispatcher + returns the
 *     fetch Response on the allowed path.
 */

import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { Agent, fetch as undiciRealFetch } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Mock node:dns (callback `lookup`) BEFORE importing the module ─────
const mockLookup = vi.fn();
// H-1 (audit 2026-06-29): `ssrfFetch` now also re-validates each URL/redirect
// hop via `validateOutboundUrl`, which uses the PROMISE form (`dns.promises.
// lookup`). We back it by the SAME `mockLookup` (adapting the callback contract
// to a promise) so a single mock governs BOTH the connector lookup and the
// pre-fetch validator — tests stay one source of truth for what a host resolves
// to.
function promiseLookup(
  hostname: string,
  options?: unknown,
): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    mockLookup(
      hostname,
      options ?? { all: true },
      (err: unknown, addresses: unknown) => {
        if (err) reject(err);
        else resolve(addresses as Array<{ address: string; family: number }>);
      },
    );
  });
}
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const promises = { ...actual.promises, lookup: promiseLookup };
  return {
    ...actual,
    lookup: (...args: unknown[]) => mockLookup(...args),
    promises,
    default: {
      ...actual,
      lookup: (...args: unknown[]) => mockLookup(...args),
      promises,
    },
  };
});

// ── Mock undici's `fetch` (undici-8 migration #124) ───────────────────
// `ssrfFetch` now calls undici's OWN `fetch` (named import) so the undici-8
// Agent and the fetch implementation share a version. ESM named imports can't
// be spied via `vi.spyOn` (namespace is non-configurable), so we replace
// `fetch` with a vi.fn that DELEGATES to the real undici fetch by default —
// the connect-time block tests still exercise the real fetch + real Agent. The
// allow-path test overrides this mock to assert the wrapper plumbing. `Agent`,
// `interceptors`, and everything else stay real.
const { mockUndiciFetch } = vi.hoisted(() => ({ mockUndiciFetch: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  mockUndiciFetch.mockImplementation((...args: unknown[]) =>
    (actual.fetch as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, fetch: mockUndiciFetch };
});

import {
  _resetSsrfDispatcher,
  SSRFConnectBlockedError,
  SSRFRedirectBlockedError,
  ssrfFetch,
  ssrfLookup,
} from './ssrf-dispatcher.js';

afterEach(async () => {
  mockLookup.mockReset();
  // Clear call history but KEEP the real-fetch-delegating implementation set up
  // in the vi.mock factory (mockReset would wipe it and break the block tests).
  mockUndiciFetch.mockClear();
  await _resetSsrfDispatcher();
});

// ─── A. Unit: ssrfLookup connector predicate ───────────────────────────

describe('ssrfLookup — connect-time predicate', () => {
  it('rejects a DNS result containing the cloud-metadata IP (169.254.169.254)', () => {
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: '169.254.169.254', family: 4 }]);
      },
    );
    const cb = vi.fn();
    ssrfLookup('evil.example', { all: true }, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    const err = cb.mock.calls[0]![0];
    expect(err).toBeInstanceOf(SSRFConnectBlockedError);
    expect((err as SSRFConnectBlockedError).address).toBe('169.254.169.254');
  });

  it('rejects a private IPv4 (10.x) result', () => {
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: '10.0.0.5', family: 4 }]);
      },
    );
    const cb = vi.fn();
    ssrfLookup('evil.example', { all: true }, cb);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(SSRFConnectBlockedError);
  });

  it('rejects an IPv6 loopback (::1) result', () => {
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: '::1', family: 6 }]);
      },
    );
    const cb = vi.fn();
    ssrfLookup('evil.example', { all: true }, cb);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(SSRFConnectBlockedError);
  });

  it('rejects when ANY address in a multi-A result is private (hidden behind a public one)', () => {
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [
          { address: '93.184.216.34', family: 4 }, // public
          { address: '169.254.169.254', family: 4 }, // metadata — hidden
        ]);
      },
    );
    const cb = vi.fn();
    ssrfLookup('mixed.example', { all: true }, cb);
    expect(cb.mock.calls[0]![0]).toBeInstanceOf(SSRFConnectBlockedError);
  });

  it('passes an all-public result through unchanged', () => {
    const addrs = [{ address: '93.184.216.34', family: 4 }];
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, addrs);
      },
    );
    const cb = vi.fn();
    ssrfLookup('public.example', { all: true }, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toBeNull();
    expect(cb.mock.calls[0]![1]).toEqual(addrs);
  });

  it('propagates a DNS lookup error', () => {
    const dnsErr = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(dnsErr, []);
      },
    );
    const cb = vi.fn();
    ssrfLookup('nx.example', { all: true }, cb);
    expect(cb.mock.calls[0]![0]).toBe(dnsErr);
  });
});

// ─── B. Integration: real Agent + loopback server via ssrfFetch ─────────

describe('ssrfFetch — connect-time enforcement (real undici Agent)', () => {
  it('BLOCKS a fetch whose DNS rebinds to 169.254.169.254 (connect-time, no bytes sent)', async () => {
    // The hostname resolves (in our mock) to the cloud-metadata IP at the
    // moment undici opens the socket → the connector rejects before connecting.
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: '169.254.169.254', family: 4 }]);
      },
    );

    // H-1 (audit 2026-06-29): `ssrfFetch` now re-validates the URL via
    // `validateOutboundUrl` BEFORE opening the socket, so a host resolving to
    // the metadata IP is rejected at the pre-fetch layer (SSRFRedirectBlocked)
    // rather than reaching the connect-time guard. Either way: no socket opens.
    await expect(
      ssrfFetch('http://rebind.attacker.example/latest/meta-data/'),
    ).rejects.toBeInstanceOf(SSRFRedirectBlockedError);
  });

  it('BLOCKS a fetch whose DNS rebinds to loopback (127.0.0.1) before reaching a real local server', async () => {
    // A real loopback server IS listening, but the guard must refuse to connect
    // because 127.0.0.1 is private. This proves the dispatcher governs the REAL
    // socket attempt (the request never reaches the server). The block is
    // synchronous in the connector lookup → fast, no timeout/race.
    const server: Server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      mockLookup.mockImplementation(
        (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
          cb(null, [{ address: '127.0.0.1', family: 4 }]);
        },
      );
      // H-1: the pre-fetch URL re-validation rejects the loopback resolution
      // before any socket is opened (SSRFRedirectBlockedError). The real local
      // server is never reached.
      await expect(
        ssrfFetch(`http://loopback.rebind.example:${port}/`),
      ).rejects.toBeInstanceOf(SSRFRedirectBlockedError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('T-SSRF-REDIRECT: 3xx to internal IP is connect-blocked (redirect target runs through ssrfLookup)', async () => {
    // REGRESSION (MNR-2): a PUBLIC host that 3xx-redirects to an internal /
    // metadata IP must be blocked at connect-time when undici follows the
    // redirect through the SAME SSRF dispatcher. This pins that undici-8's
    // `fetch` re-invokes the connector `lookup` for the REDIRECT TARGET host
    // (not just the initial host) — a future undici bump that changes how the
    // redirect dispatcher threads the connector would fail this loudly.
    //
    // Why not a fully-real two-hop `ssrfFetch`: the connect guard correctly
    // blocks EVERY local IP (127.0.0.1, 10/8, 172.16/12, 192.168/16, 0/8 —
    // see isPrivateIPv4), so a real local server that serves the initial 302
    // is unreachable on hop 1 through the production dispatcher. We therefore
    // use a real local 302 server reached on hop 1 via a permissive lookup,
    // while hop 2 (the security-critical redirect target) is governed by the
    // REAL exported `ssrfLookup` — the exact function `getSsrfDispatcher()`
    // installs as `connect.lookup`. The mock makes the redirect target resolve
    // to the cloud-metadata IP, and we assert it is connect-blocked.
    const REDIRECT_TARGET_HOST = 'redirect-target.internal.example';
    const METADATA_IP = '169.254.169.254';

    // Real local server: responds with 302 → http://<internal host>/meta-data.
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(302, {
        Location: `http://${REDIRECT_TARGET_HOST}/latest/meta-data/`,
      });
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;

    // node:dns.lookup is hostname-aware: the redirect target resolves to the
    // metadata IP. (The initial host never reaches dns.lookup here because the
    // hop-1 lookup below short-circuits to the real loopback server.)
    mockLookup.mockImplementation(
      (hostname: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        if (hostname === REDIRECT_TARGET_HOST) {
          cb(null, [{ address: METADATA_IP, family: 4 }]);
          return;
        }
        cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      },
    );

    // Agent whose connector mirrors production: hop 1 reaches the real loopback
    // 302 server (permissive — stands in for a reachable PUBLIC initial host);
    // every OTHER host (i.e. the redirect target undici follows) is governed by
    // the REAL exported `ssrfLookup`, exactly as getSsrfDispatcher installs it.
    const agent = new Agent({
      connect: {
        lookup: (
          hostname: string,
          options: import('node:dns').LookupOptions,
          cb: (
            err: NodeJS.ErrnoException | null,
            address: string | import('node:dns').LookupAddress[],
            family?: number,
          ) => void,
        ) => {
          if (hostname === 'initial.public.example') {
            // hop 1: reachable public host → real local 302 server.
            cb(null, [{ address: '127.0.0.1', family: 4 }]);
            return;
          }
          // hop 2+: the production SSRF guard decides. For the redirect target
          // this resolves (via mocked node:dns) to the metadata IP and rejects.
          ssrfLookup(hostname, options, cb);
        },
      },
    });

    try {
      let caught: unknown;
      try {
        await undiciRealFetch(`http://initial.public.example:${port}/start`, {
          dispatcher: agent,
          redirect: 'follow',
        });
      } catch (e) {
        caught = e;
      }
      // The redirect was followed THROUGH the SSRF connector and the internal
      // target was blocked — NOT a 200, NOT an ENOTFOUND.
      const cause = (caught as { cause?: unknown })?.cause;
      expect(cause).toBeInstanceOf(SSRFConnectBlockedError);
      expect((cause as SSRFConnectBlockedError).address).toBe(METADATA_IP);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await agent.destroy().catch(() => {});
    }
  });

  it('ssrfFetch returns the fetch Response on the allowed (non-blocked) path', async () => {
    // `ssrfFetch` must transparently return whatever the underlying fetch
    // returns once the guard has not rejected. undici-8 migration (#124):
    // `ssrfFetch` now calls undici's OWN `fetch` (so the undici-8 Agent and the
    // fetch implementation are the same version — Node's global fetch would
    // reject the cross-version dispatcher). We therefore spy undici's `fetch`
    // (not `globalThis.fetch`) to assert the wrapper threads init + yields the
    // Response. The connector-level ALLOW semantics for public IPs are covered
    // by the unit tests above.
    const fakeResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
    });
    // H-1: the pre-fetch validator (`validateOutboundUrl`) must see a PUBLIC IP
    // for this host or it would block before fetching. Resolve to a public IP.
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
      },
    );
    // Override the default (real-fetch-delegating) mock for this test only.
    mockUndiciFetch.mockResolvedValueOnce(fakeResponse);
    const res = await ssrfFetch('http://public.example/path', {
      method: 'GET',
    });
    expect(res).toBe(fakeResponse);
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
    // The wrapper must attach a dispatcher (the SSRF Agent) to the init.
    const init = mockUndiciFetch.mock.calls[0]![1] as Record<string, unknown>;
    expect(init.dispatcher).toBeDefined();
    expect(init.method).toBe('GET');
    // H-1: redirects are handled manually so each hop can be re-validated.
    expect(init.redirect).toBe('manual');
  });

  // ── HU-195: el techo de wall-clock viaja SIEMPRE en el init ───────────
  //
  // Los ejes se prueban end-to-end contra un servidor local en
  // `outbound-timeout.test.ts`. Acá se prueba el PLUMBING: que `ssrfFetch` —el
  // único camino outbound de compose/discovery/MCP— adjunte el `signal` sí o sí,
  // incluso cuando el caller no manda ninguno (el caso de
  // `services/compose.ts` en el hop de invoke, que era el agujero original).
  it('T-195-WIRE-1: ssrfFetch adjunta un AbortSignal de wall-clock aunque el caller no pase ninguno', async () => {
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
      },
    );
    mockUndiciFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    // Init SIN `signal` — exactamente como lo llama services/compose.ts.
    await ssrfFetch('http://public.example/invoke', {
      method: 'POST',
      body: '{}',
    });
    const init = mockUndiciFetch.mock.calls[0]![1] as Record<string, unknown>;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  it('T-195-WIRE-2: el signal del caller sigue gobernando (se combina, no se descarta)', async () => {
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
      },
    );
    mockUndiciFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const caller = new AbortController();
    await ssrfFetch('http://public.example/x', { signal: caller.signal });
    const init = mockUndiciFetch.mock.calls[0]![1] as Record<string, unknown>;
    const passed = init.signal as AbortSignal;
    expect(passed).toBeInstanceOf(AbortSignal);
    // NO es el mismo objeto (es el compuesto) pero el abort del caller lo dispara.
    expect(passed).not.toBe(caller.signal);
    expect(passed.aborted).toBe(false);
    caller.abort(new Error('discovery-5s-budget'));
    await Promise.resolve();
    expect(passed.aborted).toBe(true);
    expect((passed.reason as Error).message).toBe('discovery-5s-budget');
  });
});

// ─── HU-195 fix-pack (AR BLQ-BAJO-3): la fase de DNS del PRE-FLIGHT ─────

describe('ssrfFetch — el techo cubre la fase de DNS del pre-flight', () => {
  const SAVED_HOP_ENV = process.env.OUTBOUND_HOP_TIMEOUT_MS;
  afterEach(() => {
    if (SAVED_HOP_ENV === undefined) delete process.env.OUTBOUND_HOP_TIMEOUT_MS;
    else process.env.OUTBOUND_HOP_TIMEOUT_MS = SAVED_HOP_ENV;
  });

  /** `mockLookup` que tarda `delayMs` en contestar (resolver lento / colgado). */
  function slowLookup(delayMs: number): void {
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        setTimeout(() => {
          cb(null, [{ address: '93.184.216.34', family: 4 }]);
        }, delayMs);
      },
    );
  }

  it('T-195-DNS-1: un resolver lento NO puede exceder el techo declarado del hop', async () => {
    // MEDIDO POR EL AR ANTES DE ESTE FIX-PACK: con node:dns a 1500 ms y un techo
    // de 200 ms, `ssrfFetch` tardaba 1505 ms — 7.5× el techo — porque
    // `assertUrlAllowed` corría FUERA del signal (`ssrf-dispatcher.ts:366`) y
    // `url-validator.ts:296` hace `dns.lookup` sin timeout.
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '200';
    slowLookup(1_500);
    const startedAt = Date.now();
    await expect(ssrfFetch('http://slow-dns.example/x')).rejects.toThrow();
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(1_000);
    // Y no se abrió ningún socket: el pre-flight SSRF sigue corriendo ANTES del
    // fetch, o sea que acotarlo no debilitó el guard.
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  }, 15_000);

  it('T-195-DNS-2: el signal del CALLER también corta la fase de DNS (razón no-Error incluida)', async () => {
    // Presupuesto del hop generoso a propósito: el que corta acá es el caller.
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '60000';
    slowLookup(1_500);
    const caller = new AbortController();
    setTimeout(() => caller.abort('caller-budget-string'), 100);
    const startedAt = Date.now();
    await expect(
      ssrfFetch('http://slow-dns.example/y', { signal: caller.signal }),
    ).rejects.toThrow(/caller-budget-string/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  }, 15_000);

  it('T-195-DNS-4: un caller que llega con el presupuesto YA agotado no resuelve DNS ni abre socket', async () => {
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '60000';
    slowLookup(1_500);
    const startedAt = Date.now();
    await expect(
      ssrfFetch('http://slow-dns.example/w', {
        signal: AbortSignal.abort(new Error('presupuesto-agotado')),
      }),
    ).rejects.toThrow(/presupuesto-agotado/);
    // Ni siquiera se llamó al resolver: el chequeo es lo primero del hop.
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('T-195-DNS-3: un DNS rápido no se ve afectado (el listener del abort se limpia)', async () => {
    process.env.OUTBOUND_HOP_TIMEOUT_MS = '60000';
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
      },
    );
    const fake = new Response('{}', { status: 200 });
    mockUndiciFetch.mockResolvedValueOnce(fake);
    const caller = new AbortController();
    const res = await ssrfFetch('http://public.example/z', {
      signal: caller.signal,
    });
    expect(res).toBe(fake);
    // El compuesto que viajó en el init sigue vivo (gobierna el body stream) y
    // NO quedó con listeners del pre-flight colgados.
    const init = mockUndiciFetch.mock.calls[0]![1] as Record<string, unknown>;
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });
});

// ─── H-1: manual redirect re-validation + credential stripping ──────────

describe('ssrfFetch — H-1 manual redirect SSRF re-validation (audit 2026-06-29)', () => {
  // The initial (public) host resolves to a public IP; the redirect target is a
  // literal metadata IP. `assertUrlAllowed` must reject the hop-2 URL BEFORE a
  // second fetch is issued, and the credential headers must never be re-sent.
  const PUBLIC_IP = '93.184.216.34';

  it('T-H1-REDIRECT-LITERAL: 302 → http://169.254.169.254/ is BLOCKED before the next hop', async () => {
    // hop-1 host resolves public; the literal-IP redirect target is caught by
    // the literal-IP guard (the connector lookup never sees literals).
    mockLookup.mockImplementation(
      (h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        if (h === 'public.start.example') {
          cb(null, [{ address: PUBLIC_IP, family: 4 }]);
          return;
        }
        cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      },
    );

    // hop-1 returns a 302 to the cloud-metadata literal IP.
    mockUndiciFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );

    await expect(
      ssrfFetch('http://public.start.example/start', {
        method: 'GET',
        headers: {
          'x-a2a-key': 'SECRET-KEY',
          'payment-signature': 'SECRET-SIG',
        },
      }),
    ).rejects.toBeInstanceOf(SSRFRedirectBlockedError);

    // The internal target was NEVER fetched: only the hop-1 request was issued.
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
    // And the hop-1 request carried the credentials (hop-1 is the legit host),
    // proving the block happens BEFORE re-sending them to the internal host.
    const hop1Init = mockUndiciFetch.mock.calls[0]![1] as {
      headers?: Record<string, string>;
    };
    // Sanity: credentials were present on hop-1 (they just never reach hop-2).
    expect(JSON.stringify(hop1Init.headers)).toContain('SECRET-KEY');
  });

  it('T-H1-REDIRECT-PRIVATE-HOST: 302 → host resolving to 127.0.0.1 is BLOCKED', async () => {
    mockLookup.mockImplementation(
      (h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        if (h === 'public.start.example') {
          cb(null, [{ address: PUBLIC_IP, family: 4 }]);
          return;
        }
        if (h === 'internal.target.example') {
          cb(null, [{ address: '127.0.0.1', family: 4 }]);
          return;
        }
        cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      },
    );
    mockUndiciFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://internal.target.example/admin' },
      }),
    );

    await expect(
      ssrfFetch('http://public.start.example/start', {
        headers: { authorization: 'Bearer SECRET' },
      }),
    ).rejects.toBeInstanceOf(SSRFRedirectBlockedError);
    // hop-2 never issued — the private-IP-resolving target was blocked.
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  it('T-H1-REDIRECT-CROSSORIGIN: credential headers are STRIPPED on a cross-origin redirect', async () => {
    // hop-1 (public.a.example) 302 → another PUBLIC host (public.b.example).
    // The redirect is allowed (both public), but being cross-origin the
    // credential headers must be dropped on hop-2.
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: PUBLIC_IP, family: 4 }]);
      },
    );
    mockUndiciFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://public.b.example/next' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await ssrfFetch('http://public.a.example/start', {
      method: 'GET',
      headers: {
        'x-a2a-key': 'SECRET-KEY',
        'payment-signature': 'SECRET-SIG',
        authorization: 'Bearer SECRET',
        'x-payment': 'SECRET-PAY',
        'x-keep': 'visible',
      },
    });
    expect(res.status).toBe(200);
    expect(mockUndiciFetch).toHaveBeenCalledTimes(2);

    // hop-2 headers: every credential header stripped; non-credential preserved.
    const hop2Init = mockUndiciFetch.mock.calls[1]![1] as {
      headers?: Record<string, string>;
    };
    const hop2HeaderJson = JSON.stringify(hop2Init.headers);
    expect(hop2HeaderJson).not.toContain('SECRET-KEY');
    expect(hop2HeaderJson).not.toContain('SECRET-SIG');
    expect(hop2HeaderJson).not.toContain('SECRET');
    expect(hop2HeaderJson).not.toContain('SECRET-PAY');
    expect(hop2HeaderJson).toContain('visible');
  });

  it('T-H1-REDIRECT-UPGRADE: same-host http→https upgrade RETAINS credentials', async () => {
    // hop-1 http://secure.example 301 → https://secure.example (same host).
    // A scheme UPGRADE to the SAME host is same-origin for credential purposes,
    // so the credential headers must ride along to hop-2.
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: PUBLIC_IP, family: 4 }]);
      },
    );
    mockUndiciFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://secure.example/start' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await ssrfFetch('http://secure.example/start', {
      method: 'GET',
      headers: {
        'x-a2a-key': 'SECRET-KEY',
        'payment-signature': 'SECRET-SIG',
        'x-keep': 'visible',
      },
    });
    expect(res.status).toBe(200);
    expect(mockUndiciFetch).toHaveBeenCalledTimes(2);

    // hop-2 headers: credentials RETAINED on the same-host upgrade.
    const hop2Init = mockUndiciFetch.mock.calls[1]![1] as {
      headers?: Record<string, string>;
    };
    const hop2HeaderJson = JSON.stringify(hop2Init.headers);
    expect(hop2HeaderJson).toContain('SECRET-KEY');
    expect(hop2HeaderJson).toContain('SECRET-SIG');
    expect(hop2HeaderJson).toContain('visible');
  });

  it('T-H1-REDIRECT-DOWNGRADE: same-host https→http downgrade STILL strips credentials', async () => {
    // A scheme DOWNGRADE (https → http) to the same host must NOT retain creds.
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: PUBLIC_IP, family: 4 }]);
      },
    );
    mockUndiciFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'http://secure.example/start' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await ssrfFetch('https://secure.example/start', {
      method: 'GET',
      headers: {
        'x-a2a-key': 'SECRET-KEY',
        'x-keep': 'visible',
      },
    });
    expect(res.status).toBe(200);
    const hop2Init = mockUndiciFetch.mock.calls[1]![1] as {
      headers?: Record<string, string>;
    };
    const hop2HeaderJson = JSON.stringify(hop2Init.headers);
    expect(hop2HeaderJson).not.toContain('SECRET-KEY');
    expect(hop2HeaderJson).toContain('visible');
  });

  it('T-H1-REDIRECT-UPGRADE-HOSTCHANGE: http→https with a HOST change STILL strips credentials', async () => {
    // Even a scheme upgrade is cross-origin when the host differs.
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: PUBLIC_IP, family: 4 }]);
      },
    );
    mockUndiciFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://other.example/start' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await ssrfFetch('http://secure.example/start', {
      method: 'GET',
      headers: {
        'x-a2a-key': 'SECRET-KEY',
        'x-keep': 'visible',
      },
    });
    expect(res.status).toBe(200);
    const hop2Init = mockUndiciFetch.mock.calls[1]![1] as {
      headers?: Record<string, string>;
    };
    const hop2HeaderJson = JSON.stringify(hop2Init.headers);
    expect(hop2HeaderJson).not.toContain('SECRET-KEY');
    expect(hop2HeaderJson).toContain('visible');
  });

  it('T-H1-REDIRECT-UPGRADE-PORTCHANGE: http→https with a PORT change STILL strips credentials', async () => {
    // Same host + scheme upgrade but a non-default port change is cross-origin.
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: PUBLIC_IP, family: 4 }]);
      },
    );
    mockUndiciFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://secure.example:8443/start' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await ssrfFetch('http://secure.example/start', {
      method: 'GET',
      headers: {
        'x-a2a-key': 'SECRET-KEY',
        'x-keep': 'visible',
      },
    });
    expect(res.status).toBe(200);
    const hop2Init = mockUndiciFetch.mock.calls[1]![1] as {
      headers?: Record<string, string>;
    };
    const hop2HeaderJson = JSON.stringify(hop2Init.headers);
    expect(hop2HeaderJson).not.toContain('SECRET-KEY');
    expect(hop2HeaderJson).toContain('visible');
  });

  it('T-H1-REDIRECT-CAP: a redirect loop is bounded (too-many-redirects)', async () => {
    mockLookup.mockImplementation(
      (_h: string, _o: unknown, cb: (e: unknown, a: unknown) => void) => {
        cb(null, [{ address: PUBLIC_IP, family: 4 }]);
      },
    );
    // Always redirect to a fresh public host → forces the hop cap to trip.
    let n = 0;
    mockUndiciFetch.mockImplementation(() => {
      n += 1;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `http://public.hop${n}.example/next` },
        }),
      );
    });

    await expect(
      ssrfFetch('http://public.start.example/start'),
    ).rejects.toBeInstanceOf(SSRFRedirectBlockedError);
    // Bounded: at most MAX_REDIRECT_HOPS (5) + the initial hop = 6 fetches.
    expect(mockUndiciFetch.mock.calls.length).toBeLessThanOrEqual(6);
  });
});
