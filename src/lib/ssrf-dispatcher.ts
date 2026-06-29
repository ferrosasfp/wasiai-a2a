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
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';
import { isBlockedAddress } from './url-validator.js';

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
 * The public signature (DOM `string | URL` / `RequestInit` / `Response`) is
 * preserved for callers (compose downstream, discovery). undici's `fetch` uses
 * structurally-equivalent web types and natively declares `dispatcher` in its
 * init; we centralize the single boundary cast here so call sites stay clean.
 */
export function ssrfFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const withDispatcher = {
    ...init,
    dispatcher: getSsrfDispatcher(),
  };
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    withDispatcher as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
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
