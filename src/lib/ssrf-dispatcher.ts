/**
 * Connect-time SSRF dispatcher — closes the TOCTOU / DNS-rebinding gap (M2,
 * audit 2026-06-24).
 *
 * THE PROBLEM
 * -----------
 * `validateOutboundUrl` (url-validator.ts) resolves the hostname via
 * `dns.lookup` and rejects private/metadata IPs. But the subsequent
 * `fetch(url)` re-resolves DNS independently. An attacker controlling DNS with
 * TTL=0 can return a public IP during validation and `169.254.169.254` (cloud
 * metadata) at the moment `fetch` opens the socket. The registry endpoints are
 * attacker-influenceable via `POST /registries`, so this is exploitable.
 *
 * THE FIX
 * -------
 * We attach a custom undici `Agent` whose connector receives a custom `lookup`.
 * undici calls this `lookup` at the REAL moment of connection, and the socket
 * connects to EXACTLY the address the lookup returns. We resolve once, classify
 * every returned address with the SAME predicate the write-time validator uses
 * (`isBlockedAddress`), and reject the connection if ANY address is private/
 * loopback/link-local/metadata. Because we validate the same resolution the
 * socket uses, there is no second, unchecked DNS resolution → the TOCTOU window
 * is closed.
 *
 * WHY THIS DOES NOT BREAK TLS (vs naive Host-header / IP pinning)
 * --------------------------------------------------------------
 * We do NOT rewrite the URL to an IP and we do NOT pin the Host header. undici
 * still performs the TLS handshake against the ORIGINAL hostname, so SNI and
 * certificate validation keep working for HTTPS. We only constrain WHICH IP the
 * socket is allowed to connect to. The hostname → cert binding is untouched.
 *
 * RESIDUAL RISK
 * -------------
 * A single connection performs exactly one DNS resolution (the one in our
 * `lookup`), and undici connects to the address we hand back. There is no
 * additional re-resolution between our check and the socket connect within the
 * same connection, so the classic rebinding window is closed. Connection reuse
 * across requests is bounded by undici keep-alive; a fresh DNS resolution (and
 * thus a fresh check) runs whenever a new connection is opened.
 */

import {
  lookup as dnsLookup,
  type LookupAddress,
  type LookupOptions,
} from 'node:dns';
import { isIP } from 'node:net';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';
import { isBlockedAddress, validateOutboundUrl } from './url-validator.js';

/**
 * Error surfaced when the connect-time SSRF check rejects a resolved address.
 * Bubbles up through `fetch` as the cause of a `TypeError: fetch failed`.
 */
export class SSRFConnectBlockedError extends Error {
  public readonly address: string;
  public readonly family: number;

  constructor(address: string, family: number) {
    super(
      `SSRF guard blocked connection to non-public IP at connect-time: ${address}`,
    );
    this.name = 'SSRFConnectBlockedError';
    this.address = address;
    this.family = family;
  }
}

/**
 * Custom `lookup` for undici's connector. Resolves `hostname` ONCE (the same
 * resolution the socket will use) and rejects if ANY returned address is in a
 * blocked range. On success, returns the resolved addresses unchanged so undici
 * connects to the validated set.
 *
 * Signature matches `net.LookupFunction` with `{ all: true }`, which is what
 * undici's connector passes. We force `all: true` ourselves so we can inspect
 * every candidate address (an attacker could otherwise hide a private IP behind
 * a public one in a multi-A record set).
 */
export function ssrfLookup(
  hostname: string,
  _options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', undefined);
      return;
    }
    for (const { address, family } of addresses) {
      if (isBlockedAddress(address, family)) {
        callback(new SSRFConnectBlockedError(address, family), '', undefined);
        return;
      }
    }
    // All addresses passed — hand the validated set back to undici. undici will
    // connect to the SAME addresses we just validated (no re-resolution).
    callback(null, addresses);
  });
}

let cachedDispatcher: Agent | undefined;

/**
 * Returns a process-wide undici `Agent` that enforces the connect-time SSRF
 * check. Lazily constructed and reused (keep-alive friendly). Pass it as the
 * `dispatcher` option of every outbound `fetch` whose URL is attacker-
 * influenceable (registry discovery endpoints, agent invoke URLs).
 */
export function getSsrfDispatcher(): Dispatcher {
  if (!cachedDispatcher) {
    cachedDispatcher = new Agent({
      connect: {
        // M2: the connector resolves via OUR lookup at socket-open time. SNI /
        // TLS still target the hostname → HTTPS keeps working.
        lookup: ssrfLookup,
      },
    });
  }
  return cachedDispatcher;
}

/**
 * H-1 (audit 2026-06-29): error surfaced when a redirect `Location` (or the
 * initial URL) is rejected by the per-hop SSRF re-validation in `ssrfFetch`.
 * Distinct from `SSRFConnectBlockedError` (connect-time) — this fires at the
 * fetch layer BEFORE the next hop's socket is opened.
 */
export class SSRFRedirectBlockedError extends Error {
  public readonly url: string;
  public readonly category: string;

  constructor(url: string, category: string) {
    super(`SSRF guard blocked redirect/URL: ${url} (${category})`);
    this.name = 'SSRFRedirectBlockedError';
    this.url = url;
    this.category = category;
  }
}

/**
 * Max redirect hops `ssrfFetch` will follow before aborting. Bounds the loop so
 * a redirect chain cannot be used to spin the process.
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * H-1: validates a single URL (initial or redirect target) before its socket is
 * opened. Two layers, both fail-closed:
 *
 *  1. LITERAL-IP guard — `validateOutboundUrl`'s DNS path is the primary defense
 *     for hostnames, but the connect-time `lookup` hook can be skipped by undici
 *     for literal-IP hosts (`http://169.254.169.254/`). So when the host is an
 *     IP literal we classify it directly with `isBlockedAddress` (the SAME
 *     predicate the connector uses) and reject blocked ranges.
 *  2. FULL validator — `validateOutboundUrl` re-runs the protocol / blocked-
 *     literal / private-IP (DNS-resolved) checks for EVERY hop, so a 3xx to an
 *     internal host is rejected before the credential headers are re-sent.
 *
 * Throws `SSRFRedirectBlockedError` on any violation. Uses the registry
 * allowlist env var so allowlisted internal hosts keep working (parity with
 * `validateRegistryUrl`).
 */
async function assertUrlAllowed(rawUrl: string): Promise<void> {
  // Layer 1: literal-IP guard (the connector lookup can't see literals).
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SSRFRedirectBlockedError(rawUrl, 'invalid-url');
  }
  // NOTE: on Node 22 `URL.hostname` RETAINS the square brackets around an IPv6
  // literal (e.g. `[::1]`), so `isIP('[::1]')` returns 0 and this Layer-1
  // literal-IP guard does NOT fire for bracketed IPv6. The real defense for
  // such literals is Layer-2 below: `validateOutboundUrl` performs a DNS lookup
  // that fails closed for an unroutable/blocked literal. `isIP` returns 4|6|0.
  const family = isIP(parsed.hostname);
  if (family !== 0 && isBlockedAddress(parsed.hostname, family)) {
    throw new SSRFRedirectBlockedError(rawUrl, 'private-ip-literal');
  }

  // Layer 2: full validator (protocol / blocked-literal / DNS-resolved private).
  const result = await validateOutboundUrl(rawUrl, {
    allowlistEnvVar: 'DISCOVERY_SSRF_ALLOWLIST',
  });
  if (!result.ok) {
    throw new SSRFRedirectBlockedError(rawUrl, result.error.category);
  }
}

/**
 * Headers whose value is a credential and MUST NOT be re-sent to a different
 * origin after a redirect (defense-in-depth — even though `assertUrlAllowed`
 * already blocks internal targets, a cross-origin PUBLIC redirect should not
 * silently forward the caller's payment/auth secrets).
 */
const CREDENTIAL_HEADERS = [
  'authorization',
  'x-a2a-key',
  'payment-signature',
  'x-payment',
];

/**
 * Returns a shallow copy of `headers` with credential headers stripped. Handles
 * the Headers instance / record / array tuple shapes `RequestInit.headers` can
 * take.
 */
function stripCredentialHeaders(
  headers: RequestInit['headers'],
): Record<string, string> {
  const out: Record<string, string> = {};
  const blocked = new Set(CREDENTIAL_HEADERS);
  const copy = (k: string, v: string) => {
    if (!blocked.has(k.toLowerCase())) out[k] = v;
  };
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      copy(k, v);
    });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) copy(k, v);
  } else {
    for (const [k, v] of Object.entries(headers)) copy(k, String(v));
  }
  return out;
}

/**
 * True when two URLs are cross-origin for the purpose of credential retention.
 *
 * Strict same-origin (same protocol + host) is obviously same-origin. As a
 * narrow, security-neutral exception we ALSO treat a same-HOST `http: → https:`
 * upgrade as same-origin so credential headers survive a legitimate scheme
 * upgrade (a 301 from `http://host` to `https://host` is extremely common). The
 * exception is intentionally one-directional and host-pinned:
 *   - hostname MUST be identical,
 *   - port MUST be identical (effective port, after default-scheme resolution),
 *   - the only permitted scheme change is `http: → https:` (an UPGRADE).
 * Any host change, port change, or downgrade (`https: → http:`) is STILL
 * cross-origin and strips credentials. The per-hop `assertUrlAllowed` SSRF
 * validation is unaffected — it runs independently on every hop.
 */
function isCrossOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    // Exact same-origin (protocol + host, where `host` includes any explicit
    // port) → never cross-origin.
    if (ua.protocol === ub.protocol && ua.host === ub.host) return false;
    // Same-host http → https UPGRADE: retain credentials. Compare on hostname +
    // NON-DEFAULT port so the scheme's own default-port shift (http :80 →
    // https :443) is NOT seen as a port change, while a real explicit port move
    // (`http://h:8080` → `https://h:8443`) still strips credentials.
    const httpToHttpsUpgrade =
      ua.protocol === 'http:' && ub.protocol === 'https:';
    if (
      httpToHttpsUpgrade &&
      ua.hostname === ub.hostname &&
      nonDefaultPort(ua) === nonDefaultPort(ub)
    ) {
      return false;
    }
    return true;
  } catch {
    // If either URL fails to parse, treat as cross-origin (fail-closed).
    return true;
  }
}

/**
 * The URL's port ONLY when it is non-default for the scheme, else `''`. This
 * normalizes away the http(80)/https(443) default-port difference so a clean
 * `http://h` → `https://h` upgrade compares equal (`'' === ''`), while an
 * explicit non-default port on either side (e.g. `:8080`, `:8443`) is surfaced
 * and forces a cross-origin classification.
 */
function nonDefaultPort(u: URL): string {
  if (!u.port) return '';
  const isDefault =
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443');
  return isDefault ? '' : u.port;
}

/**
 * `fetch` wrapper that attaches the connect-time SSRF dispatcher. Use this for
 * EVERY outbound request to an attacker-influenceable URL.
 *
 * undici-8 migration (Dependabot #124): this calls undici's OWN `fetch` (not
 * Node's bundled global `fetch`) so the `dispatcher` (an undici-8 `Agent`) and
 * the `fetch` implementation are the SAME undici version. Handing an undici-8
 * Agent to Node's (different-version) global fetch throws `InvalidArgumentError`
 * because undici stores its global dispatcher under a version-scoped symbol and
 * the handler API differs across majors — that mismatch silently disables the
 * SSRF guard. Pinning both to undici 8 closes that gap.
 *
 * H-1 (audit 2026-06-29): redirects are followed MANUALLY (`redirect:'manual'`)
 * through a bounded loop. For EACH 3xx `Location` we run `assertUrlAllowed`
 * (literal-IP guard + full SSRF validator) BEFORE opening the next socket, so a
 * 302 → http://169.254.169.254/ or http://127.0.0.1/ is BLOCKED and the
 * credential headers (x-a2a-key / payment-signature) are never re-sent to the
 * internal host. Cross-origin redirects additionally have credential headers
 * stripped (defense-in-depth). The connect-time dispatcher still governs every
 * socket as a second layer.
 *
 * The public signature (DOM `string | URL` / `RequestInit` / `Response`) is
 * preserved for callers (compose downstream, discovery).
 */
export async function ssrfFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const dispatcher = getSsrfDispatcher();
  let currentUrl = typeof input === 'string' ? input : input.toString();
  let currentHeaders = init?.headers;
  let currentBody = init?.body;
  let currentMethod = init?.method;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    // Re-validate the URL we are ABOUT to fetch on every hop (the initial URL is
    // hop 0 — defense-in-depth, callers already validate it, but a redirect
    // target reaching this loop has NOT been validated by the caller).
    await assertUrlAllowed(currentUrl);

    const withDispatcher = {
      ...init,
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      // Never let undici auto-follow: each hop must pass assertUrlAllowed first.
      redirect: 'manual' as const,
      dispatcher,
    };
    const response = (await undiciFetch(
      currentUrl as Parameters<typeof undiciFetch>[0],
      withDispatcher as Parameters<typeof undiciFetch>[1],
    )) as unknown as Response;

    // Not a redirect → return as-is (the common case).
    const status = response.status;
    const isRedirect =
      status === 301 ||
      status === 302 ||
      status === 303 ||
      status === 307 ||
      status === 308;
    // Defensive: a real undici Response always exposes `.headers.get`, but be
    // tolerant of response shapes lacking it (only relevant when not a redirect).
    const location =
      isRedirect && typeof response.headers?.get === 'function'
        ? response.headers.get('location')
        : null;
    if (!isRedirect || !location) {
      return response;
    }

    if (hop === MAX_REDIRECT_HOPS) {
      throw new SSRFRedirectBlockedError(currentUrl, 'too-many-redirects');
    }

    // Resolve the (possibly relative) Location against the current URL.
    const nextUrl = new URL(location, currentUrl).toString();

    // Strip credential headers on cross-origin redirects (defense-in-depth).
    if (isCrossOrigin(currentUrl, nextUrl)) {
      currentHeaders = stripCredentialHeaders(currentHeaders);
    }

    // Per HTTP semantics, 303 (and 301/302 in practice) downgrade to GET and
    // drop the body. 307/308 preserve method + body.
    if (status === 303 || status === 301 || status === 302) {
      currentMethod = 'GET';
      currentBody = undefined;
    }

    currentUrl = nextUrl;
  }

  // Loop bound is inclusive of MAX_REDIRECT_HOPS; the in-loop guard returns or
  // throws before falling through, so this is unreachable.
  throw new SSRFRedirectBlockedError(currentUrl, 'too-many-redirects');
}

/**
 * TEST-ONLY: dispose + drop the cached dispatcher so a fresh one (and a fresh
 * mock of `node:dns`) is used by the next test. Mirrors the reset pattern used
 * elsewhere (e.g. `_resetFallbackWarnDedup` in discovery.ts).
 */
export async function _resetSsrfDispatcher(): Promise<void> {
  if (cachedDispatcher) {
    // `destroy` (not `close`) so we don't block on in-flight/pending sockets
    // (e.g. a test pointing at an unroutable address). Errors are swallowed —
    // teardown must never throw.
    await cachedDispatcher.destroy().catch(() => {});
    cachedDispatcher = undefined;
  }
}
