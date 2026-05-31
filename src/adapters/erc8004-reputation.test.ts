/**
 * ERC-8004 Reputation reader unit tests — WKH-103 (W3).
 *
 * Cubre AC-7 (env set → read OK), AC-8 (RPC fail → graceful), AC-11 (address
 * solo de env, 0 hardcodes), DT-6 ([VERIFY-AT-IMPL] resuelto + sin RPC real).
 * Mockea viem `createPublicClient` preservando `ContractFunctionExecutionError`
 * / `http` reales (exemplar erc8004-identity.test.ts). Env set/clear por test +
 * `_resetErc8004ReputationReader()`. CI-determinista — NO toca red real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────
const mockReadContract = vi.fn();
const mockGetChainId = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
      getChainId: mockGetChainId,
    })),
  };
});

import { ContractFunctionExecutionError } from 'viem';
import {
  _resetErc8004ReputationReader,
  erc8004ReputationReader,
  resolveReputationRegistryAddress,
} from './erc8004-reputation.js';

// ── Fixtures ────────────────────────────────────────────────
const REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;
const ORIGINAL_ENV = { ...process.env };

function makeRevertError(): ContractFunctionExecutionError {
  return new ContractFunctionExecutionError(
    new Error('execution reverted') as never,
    {
      abi: [],
      functionName: 'getSummary',
      args: [1n, [], '', ''],
    } as never,
  );
}

function setTestnetConfigured(): void {
  process.env.BASE_NETWORK = 'testnet';
  process.env.BASE_TESTNET_RPC_URL = 'https://sepolia.base.org';
  process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA = REGISTRY;
}

beforeEach(() => {
  mockReadContract.mockReset();
  mockGetChainId.mockReset();
  _resetErc8004ReputationReader();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.BASE_NETWORK;
  delete process.env.BASE_TESTNET_RPC_URL;
  delete process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA;
  delete process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET;
  delete process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveReputationRegistryAddress (AC-11 / CD-4)', () => {
  it('returns per-network address from env', () => {
    process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA = REGISTRY;
    expect(resolveReputationRegistryAddress('testnet')).toBe(REGISTRY);
  });

  it('falls back to the global env address', () => {
    process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS = REGISTRY;
    expect(resolveReputationRegistryAddress('mainnet')).toBe(REGISTRY);
  });

  it('returns null when no env is set (REGISTRY_NOT_CONFIGURED)', () => {
    expect(resolveReputationRegistryAddress('testnet')).toBeNull();
  });

  it('returns null for an invalid address shape', () => {
    process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS = 'not-an-address';
    expect(resolveReputationRegistryAddress('testnet')).toBeNull();
  });
});

describe('erc8004ReputationReader.read', () => {
  // T-AC7-on: env set + reader OK → ok:true + raw value present.
  it('T-AC7-on: env set + read OK returns the raw on-chain summary value', async () => {
    setTestnetConfigured();
    mockGetChainId.mockResolvedValue(84532);
    mockReadContract.mockResolvedValue([3n, 420n, 2]);

    const res = await erc8004ReputationReader.read({ agentId: 7n });

    expect(res.ok).toBe(true);
    expect(res.value).toBe('3:420:2'); // count:summaryValue:decimals
    expect(res.chainId).toBe(84532);
  });

  // T-AC7-off: env ausente → skip sin RPC (REGISTRY_NOT_CONFIGURED).
  it('T-AC7-off: no env → REGISTRY_NOT_CONFIGURED, never calls RPC', async () => {
    process.env.BASE_NETWORK = 'testnet';
    process.env.BASE_TESTNET_RPC_URL = 'https://sepolia.base.org';
    // address env intentionally unset

    const res = await erc8004ReputationReader.read({ agentId: 7n });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('REGISTRY_NOT_CONFIGURED');
    expect(mockGetChainId).not.toHaveBeenCalled();
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  // T-AC8: RPC transport failure → ok:false RPC_UNAVAILABLE, no throw.
  it('T-AC8: transport failure yields RPC_UNAVAILABLE without throwing', async () => {
    setTestnetConfigured();
    mockGetChainId.mockResolvedValue(84532);
    mockReadContract.mockRejectedValue(new Error('socket hang up'));

    const res = await erc8004ReputationReader.read({ agentId: 7n });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
  });

  it('contract revert yields NOT_FOUND (agent without feedback)', async () => {
    setTestnetConfigured();
    mockGetChainId.mockResolvedValue(84532);
    mockReadContract.mockRejectedValue(makeRevertError());

    const res = await erc8004ReputationReader.read({ agentId: 7n });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('NOT_FOUND');
  });

  it('chain mismatch (RPC points to another network) yields CHAIN_MISMATCH', async () => {
    setTestnetConfigured();
    mockGetChainId.mockResolvedValue(1); // not 84532
    const res = await erc8004ReputationReader.read({ agentId: 7n });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('CHAIN_MISMATCH');
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  // T-AC11 / DT-6: no hardcoded address in source; only env-driven.
  it('T-AC11/T-VERIFY-IMPL: source has no hardcoded registry address (only env)', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const src = fs.readFileSync(
      url.fileURLToPath(new URL('./erc8004-reputation.ts', import.meta.url)),
      'utf8',
    );
    // The resolver must read addresses from process.env only.
    expect(src).toContain('process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS');
    // No hex-40 address literal assigned to an env-resolver variable.
    const codeOnly = src
      .split('\n')
      .filter(
        (l) =>
          !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'),
      )
      .join('\n');
    expect(/=\s*'0x[0-9a-fA-F]{40}'/.test(codeOnly)).toBe(false);
    // [VERIFY-AT-IMPL] resuelto y citado al repo oficial (DT-6).
    expect(src).toContain('erc-8004/erc-8004-contracts');
    expect(src).toContain('getSummary');
    // CD-8: read-only — sin escritura on-chain. Se assertea sobre el CÓDIGO
    // (codeOnly), no sobre comentarios que documentan la prohibición.
    expect(codeOnly).not.toContain('writeContract');
    expect(codeOnly).not.toContain('WalletClient');
    expect(codeOnly).not.toContain('privateKeyToAccount');
  });
});
