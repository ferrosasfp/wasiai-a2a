/**
 * ERC-8004 Reputation WRITER (WKH-133) — OPCIONAL, flag-guarded, Base-only.
 *
 * Single responsibility: firmar + enviar UNA `giveFeedback(...)` al
 * `ReputationRegistry` ERC-8004 en Base con el operator key, esperar el receipt
 * y devolver un resultado tipado `{ ok, txHash } | { ok:false, reason }` SIN
 * throw. NO lee DB, NO decide idempotencia, NO conoce `a2a_events` — eso vive en
 * `src/services/reputation-writeback.ts` (secuencia DT-5). Este módulo es el
 * ÚNICO autorizado a `createWalletClient`/`writeContract` para reputación
 * (CD-7): `erc8004-reputation.ts` y `erc8004-identity.ts` permanecen read-only.
 *
 * viem v2, NEVER ethers. Registry address / RPC URL / chain params vienen
 * exclusivamente de env (CD-4: no hardcodes). El operator key se lee de
 * `OPERATOR_PRIVATE_KEY` (reusado, DT del work-item) y NUNCA se loguea ni se
 * expone en el resultado (CD-6): `Erc8004WriteResult` jamás incluye `account`/pk.
 *
 * Fail-open (CD-3): ante CUALQUIER error (RPC, revert, gas, chain mismatch,
 * timeout) devuelve `{ ok:false, reason }` — nunca throw. Gated OFF por default
 * detrás de `ERC8004_REPUTATION_WRITEBACK_ENABLED` (CD-5): sin `=true` exacto el
 * writer nunca se invoca (doble barrera: gate en el service + en `event.ts`).
 */
import {
  type Chain,
  ContractFunctionExecutionError,
  createPublicClient,
  createWalletClient,
  http,
  WaitForTransactionReceiptTimeoutError,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getBaseChain, getBaseNetwork } from './base/chain.js';
import { resolveReputationRegistryAddress } from './erc8004-reputation.js';

// ── ABI [VERIFY-AT-IMPL resuelto] — giveFeedback verificado contra
// abis/ReputationRegistry.json del repo oficial erc-8004/erc-8004-contracts@main
// (leído 2026-07-03, misma fuente que getSummary en erc8004-reputation.ts:22-29).
// Solo la escritura `nonpayable` necesaria (emite event NewFeedback).
const GIVE_FEEDBACK_ABI = [
  {
    name: 'giveFeedback',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

// ── Result types (patrón Erc8004ReputationReadReason, erc8004-reputation.ts) ──

export type Erc8004WriteReason =
  | 'RPC_UNAVAILABLE'
  | 'REGISTRY_NOT_CONFIGURED'
  | 'SIGNER_NOT_CONFIGURED' // OPERATOR_PRIVATE_KEY ausente
  | 'CHAIN_MISMATCH'
  | 'REVERTED'
  | 'RECEIPT_TIMEOUT';

// CD-6: Erc8004WriteResult NUNCA incluye `account`/pk. Solo txHash + chainId.
export type Erc8004WriteResult =
  | { ok: true; txHash: string; chainId: number }
  | { ok: false; reason: Erc8004WriteReason };

// ── Feature flag + env-driven config (sin hardcodes — CD-4/CD-5) ──────────────

/** ON solo con el valor exacto 'true'. Cualquier otra cosa → OFF (default). */
export function isWritebackEnabled(): boolean {
  return process.env.ERC8004_REPUTATION_WRITEBACK_ENABLED === 'true';
}

function resolveWriteReceiptTimeoutMs(): number {
  const raw = process.env.ERC8004_REPUTATION_WRITE_RECEIPT_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 90000; // receipt más lento que un read
}

type BaseNet = 'mainnet' | 'testnet';

// Replicados (privados en erc8004-reputation.ts:99-103,136-138) — CD-7 mantiene
// los módulos separados: NO importar los helpers, copiarlos.
function resolveRpcUrl(network: BaseNet): string | undefined {
  return network === 'mainnet'
    ? process.env.BASE_MAINNET_RPC_URL
    : process.env.BASE_TESTNET_RPC_URL;
}

function expectedChainIdFor(network: BaseNet): number {
  return network === 'mainnet' ? 8453 : 84532;
}

// ── Lazy client caches PROPIOS module-level (CD-13) ──────────────────────────

type WalletClientT = ReturnType<typeof createWalletClient>;
type PublicClientT = ReturnType<typeof createPublicClient>;

const _walletClients = new Map<
  'base-mainnet' | 'base-sepolia',
  WalletClientT
>();
const _publicClients = new Map<
  'base-mainnet' | 'base-sepolia',
  PublicClientT
>();

/** TEST-ONLY — limpia AMBOS caches (CD-13). */
export function _resetErc8004ReputationWriter(): void {
  _walletClients.clear();
  _publicClients.clear();
}

function cacheKey(network: BaseNet): 'base-mainnet' | 'base-sepolia' {
  return network === 'mainnet' ? 'base-mainnet' : 'base-sepolia';
}

/**
 * Wallet client firmante. `null` si `OPERATOR_PRIVATE_KEY` ausente (el caller lo
 * mapea a SIGNER_NOT_CONFIGURED — NO throw acá). La pk NUNCA se loguea (CD-6).
 */
function getWriterWalletClient(
  network: BaseNet,
  rpcUrl: string,
): WalletClientT | null {
  const key = cacheKey(network);
  const cached = _walletClients.get(key);
  if (cached) return cached;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) return null;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: getBaseChain(network) as Chain,
    transport: http(rpcUrl),
  });
  _walletClients.set(key, client);
  return client;
}

function getWriterPublicClient(
  network: BaseNet,
  rpcUrl: string,
): PublicClientT {
  const key = cacheKey(network);
  const cached = _publicClients.get(key);
  if (cached) return cached;
  const client = createPublicClient({
    chain: getBaseChain(network) as Chain,
    transport: http(rpcUrl),
  });
  _publicClients.set(key, client);
  return client;
}

/**
 * Distingue revert on-chain / simulación (ContractFunctionExecutionError) de un
 * fallo de transporte. Espeja `classifyReadError` (erc8004-reputation.ts:144).
 */
function classifyWriteError(err: unknown): Erc8004WriteReason {
  if (err instanceof ContractFunctionExecutionError) return 'REVERTED';
  return 'RPC_UNAVAILABLE';
}

export interface Erc8004ReputationWriter {
  /**
   * Firma + envía UNA `giveFeedback` y espera el receipt. NUNCA throw — retorna
   * `{ ok:false, reason }` en cualquier fallo. `endpoint`/`feedbackURI` van
   * vacíos y `feedbackHash=zeroHash` (DT-7).
   */
  giveFeedback(args: {
    agentId: bigint;
    value: bigint; // 100n (DT-7)
    valueDecimals: number; // 0
    tag1: string; // "wasiai"
    tag2: string; // event.eventType
  }): Promise<Erc8004WriteResult>;
}

const writer: Erc8004ReputationWriter = {
  async giveFeedback({
    agentId,
    value,
    valueDecimals,
    tag1,
    tag2,
  }): Promise<Erc8004WriteResult> {
    const network = getBaseNetwork();

    const address = resolveReputationRegistryAddress(network);
    if (!address) return { ok: false, reason: 'REGISTRY_NOT_CONFIGURED' };

    const rpcUrl = resolveRpcUrl(network);
    if (!rpcUrl) return { ok: false, reason: 'RPC_UNAVAILABLE' };

    const walletClient = getWriterWalletClient(network, rpcUrl);
    if (!walletClient) return { ok: false, reason: 'SIGNER_NOT_CONFIGURED' };

    const publicClient = getWriterPublicClient(network, rpcUrl);

    // CD-8: guard de red ANTES de firmar/enviar. Si el RPC apunta a otra chain,
    // fail sin tx (evita escribir feedback en la red equivocada).
    const expectedChainId = expectedChainIdFor(network);
    let onchainChainId: number;
    try {
      onchainChainId = await publicClient.getChainId();
    } catch {
      return { ok: false, reason: 'RPC_UNAVAILABLE' };
    }
    if (onchainChainId !== expectedChainId) {
      return { ok: false, reason: 'CHAIN_MISMATCH' };
    }

    // Firma + envío. endpoint='' , feedbackURI='' , feedbackHash=zeroHash (DT-7).
    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
        address,
        abi: GIVE_FEEDBACK_ABI,
        functionName: 'giveFeedback',
        args: [agentId, value, valueDecimals, tag1, tag2, '', '', zeroHash],
        chain: getBaseChain(network) as Chain,
        // El client se construye SIEMPRE con `account` (getWriterWalletClient).
        // `?? null` solo satisface el union `Account | undefined` del tipo del
        // client genérico — en runtime real nunca es undefined.
        account: walletClient.account ?? null,
      });
    } catch (err) {
      // NUNCA loguear la pk (CD-6). El caller persiste solo el reason.
      return { ok: false, reason: classifyWriteError(err) };
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: resolveWriteReceiptTimeoutMs(),
      });
      // Revert on-chain (tx minada pero fallida) → REVERTED.
      if (receipt.status !== 'success') {
        return { ok: false, reason: 'REVERTED' };
      }
      return { ok: true, txHash, chainId: expectedChainId };
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) {
        return { ok: false, reason: 'RECEIPT_TIMEOUT' };
      }
      return { ok: false, reason: classifyWriteError(err) };
    }
  },
};

export const erc8004ReputationWriter: Erc8004ReputationWriter = writer;
