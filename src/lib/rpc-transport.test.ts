/**
 * RPC transport builder tests — OP-04 (audit 2026-06-30).
 *
 * Asserts the priority order (primary > *_RPC_URL_FALLBACK > public default),
 * de-duplication, and that a single configured primary still gains a fallback.
 * viem's `fallback`/`http` are spied so we can inspect the URL list passed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpCalls: Array<string | undefined> = [];
const fallbackLists: number[] = [];

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    http: vi.fn((url?: string) => {
      httpCalls.push(url);
      return { __url: url } as unknown as ReturnType<
        typeof import('viem').http
      >;
    }),
    fallback: vi.fn((transports: unknown[]) => {
      fallbackLists.push(transports.length);
      return { __fallback: transports } as unknown as ReturnType<
        typeof import('viem').fallback
      >;
    }),
  };
});

import { buildRpcTransport } from './rpc-transport.js';

const ORIGINAL_ENV = { ...process.env };
const AVAX_MAINNET = 43114;

describe('buildRpcTransport (OP-04)', () => {
  beforeEach(() => {
    httpCalls.length = 0;
    fallbackLists.length = 0;
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AVALANCHE_RPC_URL_FALLBACK;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('primary only → fallback [primary, public default] (free redundancy)', () => {
    buildRpcTransport({
      primary: 'https://primary.example',
      fallbackEnv: 'AVALANCHE_RPC_URL_FALLBACK',
      chainId: AVAX_MAINNET,
    });
    // primary first, then the built-in public Avalanche endpoint.
    expect(httpCalls[0]).toBe('https://primary.example');
    expect(httpCalls[1]).toBe('https://api.avax.network/ext/bc/C/rpc');
    expect(fallbackLists[0]).toBe(2);
  });

  it('primary + env fallback → [primary, secondary, public] in order', () => {
    process.env.AVALANCHE_RPC_URL_FALLBACK = 'https://secondary.example';
    buildRpcTransport({
      primary: 'https://primary.example',
      fallbackEnv: 'AVALANCHE_RPC_URL_FALLBACK',
      chainId: AVAX_MAINNET,
    });
    expect(httpCalls).toEqual([
      'https://primary.example',
      'https://secondary.example',
      'https://api.avax.network/ext/bc/C/rpc',
    ]);
    expect(fallbackLists[0]).toBe(3);
  });

  it('de-duplicates identical URLs', () => {
    process.env.AVALANCHE_RPC_URL_FALLBACK = 'https://primary.example';
    buildRpcTransport({
      primary: 'https://primary.example',
      fallbackEnv: 'AVALANCHE_RPC_URL_FALLBACK',
      chainId: AVAX_MAINNET,
    });
    // primary === secondary → collapsed; public still appended.
    expect(httpCalls).toEqual([
      'https://primary.example',
      'https://api.avax.network/ext/bc/C/rpc',
    ]);
  });

  it('unset primary → still usable via env fallback + public', () => {
    process.env.AVALANCHE_RPC_URL_FALLBACK = 'https://secondary.example';
    buildRpcTransport({
      primary: undefined,
      fallbackEnv: 'AVALANCHE_RPC_URL_FALLBACK',
      chainId: AVAX_MAINNET,
    });
    expect(httpCalls).toEqual([
      'https://secondary.example',
      'https://api.avax.network/ext/bc/C/rpc',
    ]);
  });

  it('unknown chainId + only primary → single-url fallback (no public)', () => {
    buildRpcTransport({
      primary: 'https://primary.example',
      fallbackEnv: 'NOPE_RPC_URL_FALLBACK',
      chainId: 999999,
    });
    expect(httpCalls).toEqual(['https://primary.example']);
    expect(fallbackLists[0]).toBe(1);
  });

  it('nothing configured + unknown chain → http() with no URL (viem default)', () => {
    buildRpcTransport({
      primary: undefined,
      fallbackEnv: 'NOPE_RPC_URL_FALLBACK',
      chainId: 999999,
    });
    expect(httpCalls).toEqual([undefined]);
    expect(fallbackLists.length).toBe(0); // fallback() not used
  });
});
