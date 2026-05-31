/**
 * ERC-8004 Identity reader (WKH-100, Fase 1).
 *
 * Reads the ERC-8004 `IdentityRegistry` (an ERC-721 contract) on Base with a
 * lazy-cached, read-only viem `publicClient`. It exposes two queries:
 *   - `verifyOwnership` → `ownerOf(tokenId)` and whether it matches an expected
 *     owner (the caller's bound funding wallet).
 *   - `resolve` → `tokenURI(tokenId)` (raw, never fetched — anti-SSRF, CD-13).
 *
 * The server NEVER mints or signs (CD-8): no WalletClient, no writeContract, no
 * privateKeyToAccount. Registry address / RPC URL / timeout come exclusively
 * from env (CD-1/CD-4: no hardcodes). All on-chain values are handled as
 * `bigint`/string + lowercase comparison (CD-11): never `Number()`.
 *
 * Expected vs transport failures are distinguished (CD-14): a contract revert
 * (token inexistente) maps to `TOKEN_NOT_FOUND`; a transport error / timeout
 * maps to `RPC_UNAVAILABLE`. This module never throws to the handler for
 * expected failures — it always returns a typed result.
 */
import type { Chain, PublicClient } from 'viem';
import { ContractFunctionExecutionError, createPublicClient, http } from 'viem';
import { getBaseChain, getBaseNetwork } from './base/chain.js';

// ── Result types ─────────────────────────────────────────────

export type Erc8004ReadReason =
  | 'RPC_UNAVAILABLE' // transporte caído / timeout
  | 'REGISTRY_NOT_CONFIGURED' // address de registry ausente o inválida
  | 'TOKEN_NOT_FOUND' // ownerOf/tokenURI revierte (token inexistente)
  | 'CHAIN_MISMATCH'; // getChainId() != chainId esperado de la red

export interface Erc8004VerifyResult {
  ok: boolean;
  reason?: Erc8004ReadReason;
  owner?: `0x${string}`; // ownerOf(tokenId)
  matches?: boolean; // owner.toLowerCase() === expectedOwner.toLowerCase()
  chainId?: number;
}

export interface Erc8004ResolveResult {
  ok: boolean;
  reason?: Erc8004ReadReason;
  tokenUri?: string; // tokenURI crudo (ipfs:// | https:// | data:)
  chainId?: number;
}

// ── ABI mínimo ERC-721 (inline `as const` — patrón gasless.ts:219-227) ───────
// [VERIFY-AT-IMPL] ABI ERC-721 (checklist §0): `ownerOf(uint256) → address` y
// `tokenURI(uint256) → string` son funciones ESTÁNDAR ERC-721 (EIP-721). El
// IdentityRegistry ERC-8004 es un ERC-721; estas firmas son canónicas.
const ERC8004_REGISTRY_ABI = [
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

// ── Env-driven helpers (sin hardcodes — CD-1/CD-4) ───────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
type BaseNet = 'mainnet' | 'testnet';

function resolveRegistryAddress(network: BaseNet): `0x${string}` | null {
  const perNet =
    network === 'mainnet'
      ? process.env.ERC8004_REGISTRY_ADDRESS_BASE_MAINNET
      : process.env.ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA;
  const raw = perNet ?? process.env.ERC8004_REGISTRY_ADDRESS;
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

// ── Lazy client cache propio (NO compartir con deposit-verifier — DT-7) ──────

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

/** TEST-ONLY — limpia el cache (patrón _resetVerifier). */
export function _resetErc8004Reader(): void {
  _clients.clear();
}

// ── Internal helpers ─────────────────────────────────────────

function expectedChainIdFor(network: BaseNet): number {
  return network === 'mainnet' ? 8453 : 84532;
}

/**
 * Distingue revert (token inexistente) de fallo de transporte (CD-14).
 * Un `ContractFunctionExecutionError` indica que la llamada al contrato
 * revirtió (p.ej. `ownerOf` sobre un tokenId no minteado) → TOKEN_NOT_FOUND.
 * Cualquier otro error (RPC caído, timeout) → RPC_UNAVAILABLE.
 */
function classifyReadError(err: unknown): Erc8004ReadReason {
  if (err instanceof ContractFunctionExecutionError) return 'TOKEN_NOT_FOUND';
  return 'RPC_UNAVAILABLE';
}

/**
 * Resolución compartida de network/registry/client + chainId defensivo.
 * Devuelve `{ client, chainId }` en éxito, o un `reason` tipado en fallo.
 */
async function resolveContext(
  network: BaseNet,
): Promise<
  | { ok: true; client: PublicClient; chainId: number }
  | { ok: false; reason: Erc8004ReadReason }
> {
  if (!resolveRegistryAddress(network)) {
    return { ok: false, reason: 'REGISTRY_NOT_CONFIGURED' };
  }
  const client = getReaderClient(network);
  if (!client) return { ok: false, reason: 'RPC_UNAVAILABLE' };

  const expectedChainId = expectedChainIdFor(network);
  // Defensivo (CD-14): si el RPC apunta a otra red, fail-loud antes de leer.
  let onchainChainId: number;
  try {
    onchainChainId = await client.getChainId();
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE' };
  }
  if (onchainChainId !== expectedChainId) {
    return { ok: false, reason: 'CHAIN_MISMATCH' };
  }
  return { ok: true, client, chainId: expectedChainId };
}

// ── Public API (DT-11) ───────────────────────────────────────

export interface Erc8004IdentityReader {
  verifyOwnership(args: {
    tokenId: bigint;
    expectedOwner: string;
  }): Promise<Erc8004VerifyResult>;
  resolve(args: { tokenId: bigint }): Promise<Erc8004ResolveResult>;
}

const reader: Erc8004IdentityReader = {
  async verifyOwnership({
    tokenId,
    expectedOwner,
  }): Promise<Erc8004VerifyResult> {
    const network = getBaseNetwork();
    const ctx = await resolveContext(network);
    if (!ctx.ok) return { ok: false, reason: ctx.reason };

    const address = resolveRegistryAddress(network);
    if (!address) return { ok: false, reason: 'REGISTRY_NOT_CONFIGURED' };

    let owner: `0x${string}`;
    try {
      owner = await ctx.client.readContract({
        address,
        abi: ERC8004_REGISTRY_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      });
    } catch (err) {
      return { ok: false, reason: classifyReadError(err) };
    }

    const matches = owner.toLowerCase() === expectedOwner.toLowerCase(); // CD-11 (DT-5)
    return { ok: true, owner, matches, chainId: ctx.chainId };
  },

  async resolve({ tokenId }): Promise<Erc8004ResolveResult> {
    const network = getBaseNetwork();
    const ctx = await resolveContext(network);
    if (!ctx.ok) return { ok: false, reason: ctx.reason };

    const address = resolveRegistryAddress(network);
    if (!address) return { ok: false, reason: 'REGISTRY_NOT_CONFIGURED' };

    let tokenUri: string;
    try {
      tokenUri = await ctx.client.readContract({
        address,
        abi: ERC8004_REGISTRY_ABI,
        functionName: 'tokenURI',
        args: [tokenId],
      });
    } catch (err) {
      return { ok: false, reason: classifyReadError(err) };
    }

    // CD-13: NUNCA hacer fetch del URI server-side (anti-SSRF). Devolver crudo.
    return { ok: true, tokenUri, chainId: ctx.chainId };
  },
};

export function getErc8004Reader(): Erc8004IdentityReader {
  return reader;
}
