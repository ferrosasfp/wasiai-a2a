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
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mockLookup(...args),
    default: { ...actual, lookup: (...args: unknown[]) => mockLookup(...args) },
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

    await expect(
      ssrfFetch('http://rebind.attacker.example/latest/meta-data/'),
    ).rejects.toThrow();

    // The error chain carries our connect-block cause.
    let caught: unknown;
    try {
      await ssrfFetch('http://rebind.attacker.example/latest/meta-data/');
    } catch (e) {
      caught = e;
    }
    const cause = (caught as { cause?: unknown })?.cause;
    expect(cause).toBeInstanceOf(SSRFConnectBlockedError);
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
      let caught: unknown;
      try {
        await ssrfFetch(`http://loopback.rebind.example:${port}/`);
      } catch (e) {
        caught = e;
      }
      const cause = (caught as { cause?: unknown })?.cause;
      expect(cause).toBeInstanceOf(SSRFConnectBlockedError);
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
  });
});
