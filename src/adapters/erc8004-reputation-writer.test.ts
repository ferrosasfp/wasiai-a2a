/**
 * ERC-8004 Reputation WRITER unit tests — WKH-133 (W1).
 *
 * Cubre AC-6/CD-6 (firma desde OPERATOR_PRIVATE_KEY; pk ausente → skip; pk NUNCA
 * en el result), CD-8 (chain mismatch → sin tx), DT-7 (args exactos de
 * giveFeedback), CD-4/CD-6 (source-scan: sin hardcodes, sin pk en el código).
 * Mockea viem `createWalletClient`/`createPublicClient` preservando `zeroHash`,
 * `ContractFunctionExecutionError`, `http`, `WaitForTransactionReceiptTimeoutError`
 * reales. `privateKeyToAccount` (viem/accounts) NO se mockea → corre real. Env
 * set/clear + `_resetErc8004ReputationWriter()` por test. CI-determinista.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────
const mockWriteContract = vi.fn();
const mockGetChainId = vi.fn();
const mockWaitForReceipt = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual, // preserva zeroHash, ContractFunctionExecutionError, http reales
    createWalletClient: vi.fn(() => ({ writeContract: mockWriteContract })),
    createPublicClient: vi.fn(() => ({
      getChainId: mockGetChainId,
      waitForTransactionReceipt: mockWaitForReceipt,
    })),
  };
});

import { zeroHash } from 'viem';
import {
  _resetErc8004ReputationWriter,
  erc8004ReputationWriter,
  isWritebackEnabled,
} from './erc8004-reputation-writer.js';

// ── Fixtures ────────────────────────────────────────────────
const REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;
// Test-only private key (hardhat account #0 — pública, NUNCA un secreto real).
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ORIGINAL_ENV = { ...process.env };

function setTestnetConfigured(): void {
  process.env.BASE_NETWORK = 'testnet';
  process.env.BASE_TESTNET_RPC_URL = 'https://sepolia.base.org';
  process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA = REGISTRY;
  process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
}

beforeEach(() => {
  mockWriteContract.mockReset();
  mockGetChainId.mockReset();
  mockWaitForReceipt.mockReset();
  _resetErc8004ReputationWriter();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.BASE_NETWORK;
  delete process.env.BASE_TESTNET_RPC_URL;
  delete process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA;
  delete process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET;
  delete process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS;
  delete process.env.OPERATOR_PRIVATE_KEY;
  delete process.env.ERC8004_REPUTATION_WRITEBACK_ENABLED;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isWritebackEnabled (CD-5)', () => {
  it('is OFF by default and ON only for the exact string "true"', () => {
    expect(isWritebackEnabled()).toBe(false);
    process.env.ERC8004_REPUTATION_WRITEBACK_ENABLED = 'TRUE';
    expect(isWritebackEnabled()).toBe(false);
    process.env.ERC8004_REPUTATION_WRITEBACK_ENABLED = '1';
    expect(isWritebackEnabled()).toBe(false);
    process.env.ERC8004_REPUTATION_WRITEBACK_ENABLED = 'true';
    expect(isWritebackEnabled()).toBe(true);
  });
});

describe('erc8004ReputationWriter.giveFeedback', () => {
  // T-AC6-sign: firma OK desde OPERATOR_PRIVATE_KEY + receipt success → ok:true;
  // el result serializado NUNCA contiene la pk (CD-6).
  it('T-AC6-sign: signs from OPERATOR_PRIVATE_KEY and never leaks the pk', async () => {
    setTestnetConfigured();
    mockGetChainId.mockResolvedValue(84532);
    mockWriteContract.mockResolvedValue('0xabc123');
    mockWaitForReceipt.mockResolvedValue({ status: 'success' });

    const res = await erc8004ReputationWriter.giveFeedback({
      agentId: 7n,
      value: 100n,
      valueDecimals: 0,
      tag1: 'wasiai',
      tag2: 'compose_step',
    });

    expect(res).toEqual({ ok: true, txHash: '0xabc123', chainId: 84532 });
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    // CD-6: la pk jamás aparece en el resultado serializado.
    expect(JSON.stringify(res)).not.toContain(TEST_PK);
    expect(JSON.stringify(res)).not.toContain(TEST_PK.slice(2));
  });

  // T-AC6: pk ausente → SIGNER_NOT_CONFIGURED sin throw, writeContract NUNCA.
  it('T-AC6: missing OPERATOR_PRIVATE_KEY → SIGNER_NOT_CONFIGURED, no tx', async () => {
    setTestnetConfigured();
    delete process.env.OPERATOR_PRIVATE_KEY;
    mockGetChainId.mockResolvedValue(84532);

    const res = await erc8004ReputationWriter.giveFeedback({
      agentId: 7n,
      value: 100n,
      valueDecimals: 0,
      tag1: 'wasiai',
      tag2: 'compose_step',
    });

    expect(res).toEqual({ ok: false, reason: 'SIGNER_NOT_CONFIGURED' });
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  // T-DT7: writeContract recibe los args deterministas exactos.
  it('T-DT7: writeContract receives [agentId, 100n, 0, "wasiai", tag2, "", "", zeroHash]', async () => {
    setTestnetConfigured();
    mockGetChainId.mockResolvedValue(84532);
    mockWriteContract.mockResolvedValue('0xdeadbeef');
    mockWaitForReceipt.mockResolvedValue({ status: 'success' });

    await erc8004ReputationWriter.giveFeedback({
      agentId: 42n,
      value: 100n,
      valueDecimals: 0,
      tag1: 'wasiai',
      tag2: 'orchestrate_goal',
    });

    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    const callArg = mockWriteContract.mock.calls[0]?.[0];
    expect(callArg.functionName).toBe('giveFeedback');
    expect(callArg.args).toEqual([
      42n,
      100n,
      0,
      'wasiai',
      'orchestrate_goal',
      '',
      '',
      zeroHash,
    ]);
    expect(callArg.address).toBe(REGISTRY);
  });

  // T-CD8: getChainId != esperado → CHAIN_MISMATCH y writeContract NUNCA llamado.
  it('T-CD8: chain mismatch → CHAIN_MISMATCH, writeContract never called', async () => {
    setTestnetConfigured();
    mockGetChainId.mockResolvedValue(1); // no es 84532

    const res = await erc8004ReputationWriter.giveFeedback({
      agentId: 7n,
      value: 100n,
      valueDecimals: 0,
      tag1: 'wasiai',
      tag2: 'compose_step',
    });

    expect(res).toEqual({ ok: false, reason: 'CHAIN_MISMATCH' });
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it('registry not configured → REGISTRY_NOT_CONFIGURED, no RPC', async () => {
    process.env.BASE_NETWORK = 'testnet';
    process.env.BASE_TESTNET_RPC_URL = 'https://sepolia.base.org';
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK;

    const res = await erc8004ReputationWriter.giveFeedback({
      agentId: 7n,
      value: 100n,
      valueDecimals: 0,
      tag1: 'wasiai',
      tag2: 'compose_step',
    });

    expect(res).toEqual({ ok: false, reason: 'REGISTRY_NOT_CONFIGURED' });
    expect(mockGetChainId).not.toHaveBeenCalled();
    expect(mockWriteContract).not.toHaveBeenCalled();
  });
});

// T-SCAN: source-scan (patrón erc8004-reputation.test.ts:152-179).
describe('T-SCAN: source has no hardcodes / no pk / cites official ABI (CD-4/CD-6)', () => {
  it('reads config from env, cites erc-8004/erc-8004-contracts, no hardcoded secrets', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const src = fs.readFileSync(
      url.fileURLToPath(
        new URL('./erc8004-reputation-writer.ts', import.meta.url),
      ),
      'utf8',
    );
    const codeOnly = src
      .split('\n')
      .filter(
        (l) =>
          !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'),
      )
      .join('\n');

    // Config desde env (flag), no hardcodeada.
    expect(src).toContain('process.env.ERC8004_REPUTATION_');
    // Sin address hex-40 asignada a una variable en el código.
    expect(/=\s*'0x[0-9a-fA-F]{40}'/.test(codeOnly)).toBe(false);
    // Sin literal 0x64-hex (pk / secreto) en el código.
    expect(/0x[0-9a-fA-F]{64}/.test(codeOnly)).toBe(false);
    // [VERIFY-AT-IMPL] resuelto y citado al repo oficial.
    expect(src).toContain('erc-8004/erc-8004-contracts');
    expect(src).toContain('giveFeedback');
  });
});
