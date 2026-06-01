import {
  type Account,
  type Chain,
  decodeEventLog,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { IdentityMintError } from './errors.js';
import type { AgentCard } from './types.js';

/**
 * ABI del IdentityRegistry ERC-8004 (CONFIRMADO, SDD §3 — NO inventar).
 * Mint = `register(string agentURI) → uint256 agentId` a `msg.sender` (la
 * wallet del agente). El `agentId` se extrae del evento `Registered` del
 * receipt (CD-13), NUNCA re-leyendo un contador.
 */
export const IDENTITY_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const;

/**
 * AgentCard → `data:` URI base64 (DT-5). El URI completo es público (se mintea
 * on-chain). Card mínimo `{ name, description, url }`.
 */
export function buildAgentCardUri(card: AgentCard): string {
  const json = JSON.stringify(card);
  const b64 = Buffer.from(json).toString('base64');
  return `data:application/json;base64,${b64}`;
}

export interface MintIdentityInput {
  registryAddress: `0x${string}`;
  agentURI: string;
}

/**
 * Mint ERC-8004 REAL: `register(string)` a `msg.sender`, espera el receipt y
 * parsea el log `Registered` para obtener el `agentId` (CD-13). Si el log no
 * aparece → `IdentityMintError('mint', ...)`.
 */
export async function mintIdentityOnChain(
  wallet: WalletClient,
  publicClient: PublicClient,
  input: MintIdentityInput,
): Promise<{ tokenId: string; txHash: `0x${string}` }> {
  const txHash = await wallet.writeContract({
    address: input.registryAddress,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [input.agentURI],
    account: wallet.account as Account,
    chain: wallet.chain as Chain | undefined,
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  // CD-13: parsear el log `Registered` del receipt → args.agentId (bigint).
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: IDENTITY_REGISTRY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'Registered') {
        const agentId = decoded.args.agentId;
        return { tokenId: agentId.toString(), txHash };
      }
    } catch {
      // log de otro contrato/evento — ignorar y seguir.
    }
  }

  throw new IdentityMintError('mint', 'Registered event not found in receipt');
}
