/**
 * ERC-8004 identity reader unit tests — WKH-100 (W1/W6).
 *
 * Covers AC-2 (resolve), AC-4 (ownership match base), AC-10
 * (REGISTRY_NOT_CONFIGURED), AC-11 (RPC_UNAVAILABLE) + CD-14 (revert vs
 * transport) + CHAIN_MISMATCH. Mocks viem `createPublicClient` while
 * preserving the real `ContractFunctionExecutionError` / `http`
 * (exemplar: deposit-verifier.test.ts:18-30). Env is set/cleared per test +
 * `_resetErc8004Reader()` to clear the lazy client cache. CI-deterministic —
 * NO real network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────
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
import { _resetErc8004Reader, getErc8004Reader } from './erc8004-identity.js';

// ─── Fixtures ────────────────────────────────────────────────────────────
const REGISTRY = '0x8004000000000000000000000000000000000001' as const;
const OWNER = '0xaAaA000000000000000000000000000000000001' as `0x${string}`;
const OWNER_LC = OWNER.toLowerCase();
const OTHER = '0xbBbB000000000000000000000000000000000002' as `0x${string}`;

const ORIGINAL_ENV = { ...process.env };

/** Build a viem ContractFunctionExecutionError without hitting a real RPC. */
function makeRevertError(): ContractFunctionExecutionError {
  return new ContractFunctionExecutionError(
    new Error('execution reverted') as never,
    {
      abi: [],
      functionName: 'ownerOf',
      args: [1n],
    } as never,
  );
}

function setTestnetConfigured(): void {
  process.env.BASE_NETWORK = 'testnet';
  process.env.BASE_TESTNET_RPC_URL = 'https://sepolia.base.org';
  process.env.ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA = REGISTRY;
}

beforeEach(() => {
  mockReadContract.mockReset();
  mockGetChainId.mockReset();
  _resetErc8004Reader();
  process.env = { ...ORIGINAL_ENV };
  // Default: clean slate, no registry env.
  process.env.BASE_NETWORK = 'testnet';
  process.env.ERC8004_REGISTRY_ADDRESS_BASE_MAINNET = undefined;
  process.env.ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA = undefined;
  process.env.ERC8004_REGISTRY_ADDRESS = undefined;
});

afterEach(() => {
  _resetErc8004Reader();
  process.env = { ...ORIGINAL_ENV };
});

describe('getErc8004Reader', () => {
  describe('verifyOwnership', () => {
    it('AC-1/AC-4: ownerOf == expectedOwner → { ok:true, matches:true }', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockResolvedValue(OWNER);

      const r = await getErc8004Reader().verifyOwnership({
        tokenId: 1n,
        expectedOwner: OWNER_LC,
      });

      expect(r.ok).toBe(true);
      expect(r.matches).toBe(true);
      expect(r.chainId).toBe(84532);
    });

    it('DT-5/CD-11: checksummed ownerOf vs lowercase expectedOwner → match (case-insensitive)', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockResolvedValue(OWNER); // checksummed mixed-case

      const r = await getErc8004Reader().verifyOwnership({
        tokenId: 1n,
        expectedOwner: OWNER_LC, // lowercase (== funding_wallet stored)
      });

      expect(r.ok).toBe(true);
      expect(r.matches).toBe(true);
    });

    it('AC-4 base: ownerOf != expectedOwner → { ok:true, matches:false }', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockResolvedValue(OTHER);

      const r = await getErc8004Reader().verifyOwnership({
        tokenId: 1n,
        expectedOwner: OWNER_LC,
      });

      expect(r.ok).toBe(true);
      expect(r.matches).toBe(false);
    });

    it('AC-10: registry env absent → { ok:false, reason:REGISTRY_NOT_CONFIGURED }, no RPC', async () => {
      process.env.BASE_NETWORK = 'testnet';
      process.env.BASE_TESTNET_RPC_URL = 'https://sepolia.base.org';
      // no ERC8004_REGISTRY_ADDRESS* set

      const r = await getErc8004Reader().verifyOwnership({
        tokenId: 1n,
        expectedOwner: OWNER_LC,
      });

      expect(r.ok).toBe(false);
      expect(r.reason).toBe('REGISTRY_NOT_CONFIGURED');
      expect(mockReadContract).not.toHaveBeenCalled();
      expect(mockGetChainId).not.toHaveBeenCalled();
    });

    it('AC-11: readContract rejects (transport) → { ok:false, reason:RPC_UNAVAILABLE }, no throw', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockRejectedValue(new Error('fetch failed'));

      const r = await getErc8004Reader().verifyOwnership({
        tokenId: 1n,
        expectedOwner: OWNER_LC,
      });

      expect(r.ok).toBe(false);
      expect(r.reason).toBe('RPC_UNAVAILABLE');
    });

    it('CD-14: readContract reverts → TOKEN_NOT_FOUND (distinct from transport)', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockRejectedValue(makeRevertError());

      const r = await getErc8004Reader().verifyOwnership({
        tokenId: 999n,
        expectedOwner: OWNER_LC,
      });

      expect(r.ok).toBe(false);
      expect(r.reason).toBe('TOKEN_NOT_FOUND');
    });

    it('CD-14: getChainId() != expected → CHAIN_MISMATCH', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(8453); // mainnet id while on testnet

      const r = await getErc8004Reader().verifyOwnership({
        tokenId: 1n,
        expectedOwner: OWNER_LC,
      });

      expect(r.ok).toBe(false);
      expect(r.reason).toBe('CHAIN_MISMATCH');
      expect(mockReadContract).not.toHaveBeenCalled();
    });

    it('AC-11: RPC URL absent → RPC_UNAVAILABLE (no client)', async () => {
      process.env.BASE_NETWORK = 'testnet';
      process.env.ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA = REGISTRY;
      process.env.BASE_TESTNET_RPC_URL = undefined;

      const r = await getErc8004Reader().verifyOwnership({
        tokenId: 1n,
        expectedOwner: OWNER_LC,
      });

      expect(r.ok).toBe(false);
      expect(r.reason).toBe('RPC_UNAVAILABLE');
    });
  });

  describe('resolve', () => {
    it('AC-2: tokenURI https → { ok:true, tokenUri:https://… }', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockResolvedValue('https://cards.example/agent.json');

      const r = await getErc8004Reader().resolve({ tokenId: 1n });

      expect(r.ok).toBe(true);
      expect(r.tokenUri).toBe('https://cards.example/agent.json');
      expect(r.chainId).toBe(84532);
    });

    it('AC-2: tokenURI ipfs → { ok:true, tokenUri:ipfs://… }', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockResolvedValue('ipfs://QmHashOfAgentCard');

      const r = await getErc8004Reader().resolve({ tokenId: 2n });

      expect(r.ok).toBe(true);
      expect(r.tokenUri).toBe('ipfs://QmHashOfAgentCard');
    });

    it('CD-14: resolve revert → TOKEN_NOT_FOUND', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockRejectedValue(makeRevertError());

      const r = await getErc8004Reader().resolve({ tokenId: 999n });

      expect(r.ok).toBe(false);
      expect(r.reason).toBe('TOKEN_NOT_FOUND');
    });

    it('AC-11: resolve transport error → RPC_UNAVAILABLE', async () => {
      setTestnetConfigured();
      mockGetChainId.mockResolvedValue(84532);
      mockReadContract.mockRejectedValue(new Error('socket hang up'));

      const r = await getErc8004Reader().resolve({ tokenId: 1n });

      expect(r.ok).toBe(false);
      expect(r.reason).toBe('RPC_UNAVAILABLE');
    });

    it('AC-10: resolve with registry absent → REGISTRY_NOT_CONFIGURED', async () => {
      process.env.BASE_NETWORK = 'testnet';
      process.env.BASE_TESTNET_RPC_URL = 'https://sepolia.base.org';

      const r = await getErc8004Reader().resolve({ tokenId: 1n });

      expect(r.ok).toBe(false);
      expect(r.reason).toBe('REGISTRY_NOT_CONFIGURED');
      expect(mockReadContract).not.toHaveBeenCalled();
    });
  });
});
