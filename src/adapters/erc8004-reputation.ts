/**
 * ERC-8004 Reputation reader (WKH-103, Fase 3) — OPCIONAL, env-guarded.
 *
 * Reads the ERC-8004 `ReputationRegistry` on Base with a lazy-cached,
 * read-only viem `publicClient`. It exposes a single best-effort query:
 *   - `read({ agentId })` → `getSummary(agentId, [], '', '')` → the aggregate
 *     `(count, summaryValue, summaryValueDecimals)` of all feedback for that
 *     agent. The raw value is surfaced as a string `"count:value:decimals"`
 *     (anti-precision-loss — never Number()).
 *
 * The server NEVER writes (CD-7/CD-8): no WalletClient, no writeContract, no
 * privateKeyToAccount — only `createPublicClient` + `readContract`. viem v2,
 * NEVER ethers. Registry address / RPC URL / timeout come exclusively from env
 * (CD-4: no hardcodes).
 *
 * Defensive (DT-6 / AH-5): ante CUALQUIER error o ausencia de env devuelve un
 * resultado tipado `{ ok:false, reason }` sin throw — la feature off-chain
 * funciona sola. Sin env configurada → `REGISTRY_NOT_CONFIGURED` → skip sin
 * tocar RPC. Esta lectura SOLO se invoca en el path single-agent del AgentCard
 * (NUNCA en el hot-path de /discover — CD-13).
 *
 * [VERIFY-AT-IMPL] RESUELTO: la firma `getSummary(uint256,address[],string,
 * string) → (uint64,int128,uint8)` se verificó contra el ABI oficial
 * `abis/ReputationRegistry.json` del repo `erc-8004/erc-8004-contracts`
 * (branch main, leído 2026-05-31). Es la única lectura agregada `view` del
 * registry. Addresses canónicas (README, mismo repo):
 *   Base Mainnet (8453):  0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *   Base Sepolia (84532): 0x8004B663056A597Dffe9eCcC1965A193B7388713
 * Se cargan SOLO desde env (CD-4) — jamás hardcodeadas en el código.
 */
import {
  type Chain,
  ContractFunctionExecutionError,
  createPublicClient,
  http,
  type PublicClient,
} from 'viem';
import { getBaseChain, getBaseNetwork } from './base/chain.js';

// ── Result types (patrón Erc8004ReadReason, erc8004-identity.ts:26-44) ──

export type Erc8004ReputationReadReason =
  | 'RPC_UNAVAILABLE' // transporte caído / timeout
  | 'REGISTRY_NOT_CONFIGURED' // address de registry ausente o inválida
  | 'NOT_FOUND' // getSummary revierte (agente sin feedback / inexistente)
  | 'CHAIN_MISMATCH'; // getChainId() != chainId esperado de la red

export interface Erc8004ReputationResult {
  ok: boolean;
  reason?: Erc8004ReputationReadReason;
  /**
   * Valor crudo on-chain `"count:summaryValue:summaryValueDecimals"`
   * (string — anti-precision-loss, nunca Number()). [VERIFY-AT-IMPL resuelto:
   * getSummary outputs (uint64,int128,uint8)].
   */
  value?: string;
  chainId?: number;
}

// ── ABI [VERIFY-AT-IMPL resuelto] — verificado contra abis/ReputationRegistry.json
// del repo oficial erc-8004/erc-8004-contracts@main (2026-05-31). Solo la
// lectura agregada `view` necesaria (read-only — CD-7/CD-8).
const ERC8004_REPUTATION_ABI = [
  {
    name: 'getSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
] as const;

// ── Env-driven helpers (sin hardcodes — CD-4) ───────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
type BaseNet = 'mainnet' | 'testnet';

export function resolveReputationRegistryAddress(
  network: BaseNet,
): `0x${string}` | null {
  const perNet =
    network === 'mainnet'
      ? process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET
      : process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA;
  const raw = perNet ?? process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS;
  if (raw && ADDRESS_RE.test(raw)) return raw as `0x${string}`;
  return null; // → REGISTRY_NOT_CONFIGURED
}

function resolveRpcUrl(network: BaseNet): string | undefined {
  return network === 'mainnet'
    ? process.env.BASE_MAINNET_RPC_URL
    : process.env.BASE_TESTNET_RPC_URL;
}

function resolveTimeoutMs(): number {
  const raw = process.env.ERC8004_RPC_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

// ── Lazy client cache PROPIO (NO compartir con erc8004-identity — DT-3) ──

const _clients = new Map<'base-mainnet' | 'base-sepolia', PublicClient>();

function getReaderClient(network: BaseNet): PublicClient | null {
  const key = network === 'mainnet' ? 'base-mainnet' : 'base-sepolia';
  const cached = _clients.get(key);
  if (cached) return cached;
  const rpcUrl = resolveRpcUrl(network);
  if (!rpcUrl) return null;
  const client = createPublicClient({
    chain: getBaseChain(network) as Chain,
    transport: http(rpcUrl, { timeout: resolveTimeoutMs() }),
  }) as PublicClient;
  _clients.set(key, client);
  return client;
}

/** TEST-ONLY — limpia el cache. */
export function _resetErc8004ReputationReader(): void {
  _clients.clear();
}

// ── Internal helpers ─────────────────────────────────────────

function expectedChainIdFor(network: BaseNet): number {
  return network === 'mainnet' ? 8453 : 84532;
}

/**
 * Distingue revert (agente sin feedback / inexistente) de fallo de transporte.
 * Un `ContractFunctionExecutionError` → `NOT_FOUND`; el resto → `RPC_UNAVAILABLE`.
 */
function classifyReadError(err: unknown): Erc8004ReputationReadReason {
  if (err instanceof ContractFunctionExecutionError) return 'NOT_FOUND';
  return 'RPC_UNAVAILABLE';
}

export interface Erc8004ReputationReader {
  /**
   * Lee el resumen de reputación on-chain del agente (por su ERC-8004 token id
   * = `agentId`). NUNCA throw — retorna `{ ok:false, reason }` en cualquier
   * fallo (RPC, revert, env ausente, chain mismatch).
   */
  read(args: { agentId: bigint }): Promise<Erc8004ReputationResult>;
}

const reader: Erc8004ReputationReader = {
  async read({ agentId }): Promise<Erc8004ReputationResult> {
    const network = getBaseNetwork();

    const address = resolveReputationRegistryAddress(network);
    if (!address) return { ok: false, reason: 'REGISTRY_NOT_CONFIGURED' };

    const client = getReaderClient(network);
    if (!client) return { ok: false, reason: 'RPC_UNAVAILABLE' };

    const expectedChainId = expectedChainIdFor(network);
    // Defensivo: si el RPC apunta a otra red, fail antes de leer.
    let onchainChainId: number;
    try {
      onchainChainId = await client.getChainId();
    } catch {
      return { ok: false, reason: 'RPC_UNAVAILABLE' };
    }
    if (onchainChainId !== expectedChainId) {
      return { ok: false, reason: 'CHAIN_MISMATCH' };
    }

    try {
      const result = await client.readContract({
        address,
        abi: ERC8004_REPUTATION_ABI,
        functionName: 'getSummary',
        args: [agentId, [], '', ''],
      });
      // getSummary → [count(uint64), summaryValue(int128), decimals(uint8)].
      const [count, summaryValue, decimals] = result;
      // String crudo, anti-precision-loss (nunca Number() en bigint on-chain).
      const value = `${count.toString()}:${summaryValue.toString()}:${decimals.toString()}`;
      return { ok: true, value, chainId: expectedChainId };
    } catch (err) {
      return { ok: false, reason: classifyReadError(err) };
    }
  },
};

export const erc8004ReputationReader: Erc8004ReputationReader = reader;
