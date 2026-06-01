import type { PublicClient, WalletClient } from 'viem';
import { encodeAbiParameters, pad, toEventSelector, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { WasiAgent } from '../src/agent.js';

const testAccount = privateKeyToAccount(generatePrivateKey());
const REGISTRY = '0x4444444444444444444444444444444444444444' as const;

interface JsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function res(status: number, body: unknown): JsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Construye un log `Registered` real (topics + data) con primitivas viem.
// `from` permite simular un emisor distinto al registry canónico (MNR-2).
function registeredLog(
  agentId: bigint,
  agentURI: string,
  from: `0x${string}` = REGISTRY,
) {
  return {
    address: from,
    topics: [
      toEventSelector('Registered(uint256,string,address)'),
      pad(toHex(agentId)),
      pad(testAccount.address),
    ],
    data: encodeAbiParameters([{ type: 'string' }], [agentURI]),
  };
}

function baseConfig(over: Partial<Parameters<typeof WasiAgent>[1]> = {}) {
  return {
    a2aBase: 'http://x',
    network: 'base-sepolia',
    rpcUrl: 'http://x',
    chainId: 84532,
    ...over,
  };
}

// provision() mínimo para setear #key antes del mint.
function provisionFetch(extra: (path: string) => JsonResponse | undefined) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const e = extra(path);
    if (e) return e;
    if (path === '/auth/deposit-info')
      return res(200, {
        networks: [
          {
            chain_id: 84532,
            slug: 'base-sepolia',
            treasury: '0x2222222222222222222222222222222222222222',
            token: {
              symbol: 'USDC',
              address: '0x3333333333333333333333333333333333333333',
              decimals: 6,
            },
            min_confirmations: 1,
          },
        ],
      });
    if (path === '/auth/agent-signup')
      return res(200, { key: 'wasi_a2a_K', key_id: 'kid-m' });
    if (path === '/auth/funding-wallet') return res(200, {});
    if (path === '/auth/deposit')
      return res(200, { balance: '1.0', chain_id: 84532 });
    return res(404, {});
  }) as unknown as typeof fetch;
}

describe('mintIdentity()', () => {
  it('AC-4: gate ON → register(string) data: URI, tokenId del log Registered, bind 200', async () => {
    const fetchImpl = provisionFetch((path) =>
      path === '/auth/erc8004/bind'
        ? res(200, { tx_hash: '0xbind' })
        : undefined,
    );
    const writeContract = vi.fn(async () => '0xmint' as `0x${string}`);
    const walletClient = {
      writeContract,
      account: testAccount,
      chain: undefined,
    } as unknown as WalletClient;
    const publicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({
        logs: [registeredLog(4242n, 'data:application/json;base64,xxx')],
      })),
    } as unknown as PublicClient;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({
        fetchImpl,
        walletClient,
        publicClient,
        enableIdentityMint: true,
        identityRegistryAddress: REGISTRY,
      }),
    );
    await agent.provision({ ownerRef: 'o', amount: '1.0' });
    const mint = await agent.mintIdentity();

    expect(mint.skipped).toBe(false);
    expect(mint.tokenId).toBe('4242');
    // MNR-1: el bind NO produce tx on-chain → MintResult no expone bindTxHash.
    // El único tx del flujo es el mint (mintTxHash === '0xmint').
    expect(mint.mintTxHash).toBe('0xmint');
    expect('bindTxHash' in mint).toBe(false);
    // register(string) — data: URI base64. (writeContract es compartido con el
    // transfer de provision; aislamos el call al mint por functionName.)
    const calls = writeContract.mock.calls.map(
      (c) => c[0] as { functionName: string; args: string[] },
    );
    const registerCall = calls.find((c) => c.functionName === 'register');
    expect(registerCall).toBeDefined();
    expect(registerCall?.args[0]).toMatch(/^data:application\/json;base64,/);
  });

  it('MNR-2: ignora un log Registered emitido por OTRO address; usa solo el del registry canónico', async () => {
    const fetchImpl = provisionFetch((path) =>
      path === '/auth/erc8004/bind' ? res(200, {}) : undefined,
    );
    const writeContract = vi.fn(async () => '0xmint' as `0x${string}`);
    const walletClient = {
      writeContract,
      account: testAccount,
      chain: undefined,
    } as unknown as WalletClient;
    // El receipt trae PRIMERO un log impostor (otro address, mismo evento) y
    // DESPUÉS el log real del registry. El SDK debe saltar el impostor.
    const IMPOSTOR = '0x9999999999999999999999999999999999999999' as const;
    const publicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({
        logs: [
          registeredLog(666n, 'data:application/json;base64,evil', IMPOSTOR),
          registeredLog(4242n, 'data:application/json;base64,real', REGISTRY),
        ],
      })),
    } as unknown as PublicClient;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({
        fetchImpl,
        walletClient,
        publicClient,
        enableIdentityMint: true,
        identityRegistryAddress: REGISTRY,
      }),
    );
    await agent.provision({ ownerRef: 'o', amount: '1.0' });
    const mint = await agent.mintIdentity();

    // Toma el agentId del log del registry (4242), NO el del impostor (666).
    expect(mint.tokenId).toBe('4242');
  });

  it('AC-5: gate OFF → {skipped:true} sin writeContract', async () => {
    const fetchImpl = provisionFetch(() => undefined);
    const writeContract = vi.fn(async () => '0xmint' as `0x${string}`);
    const walletClient = {
      writeContract,
      account: testAccount,
      chain: undefined,
    } as unknown as WalletClient;
    const publicClient = {
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );
    await agent.provision({ ownerRef: 'o', amount: '1.0' });
    const mint = await agent.mintIdentity();

    expect(mint).toEqual({
      skipped: true,
      reason: 'IDENTITY_MINT_DISABLED',
    });
    // gate OFF → NUNCA se llama `register` (el único writeContract permitido es
    // el transfer ERC-20 de provision).
    const registerCalls = writeContract.mock.calls.filter(
      (c) => (c[0] as { functionName: string }).functionName === 'register',
    );
    expect(registerCalls).toHaveLength(0);
  });
});
