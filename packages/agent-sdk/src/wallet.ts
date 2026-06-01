import type {
  Account,
  Chain,
  LocalAccount,
  PublicClient,
  TransactionReceipt,
  TypedData,
  TypedDataDomain,
  WalletClient,
} from 'viem';

// ABI ERC-20 mínimo inline `as const` (patrón fund-agent-key.mjs:46-47 /
// erc8004-identity.ts:51-66). Sólo `transfer`, lo único que el SDK escribe.
export const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export interface TransferErc20Input {
  token: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
}

/**
 * ERC-20 transfer (write). `amount` ya viene en unidades base (parseUnits con
 * los decimals del token se hace en agent.ts, NO acá — CD-1).
 */
export async function transferErc20(
  wallet: WalletClient,
  input: TransferErc20Input,
): Promise<`0x${string}`> {
  return wallet.writeContract({
    address: input.token,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [input.to, input.amount],
    // viem requiere account+chain explícitos cuando el WalletClient es genérico.
    account: wallet.account as Account,
    chain: wallet.chain as Chain | undefined,
  });
}

/** Espera `confirmations` confirmaciones de un tx hash. */
export async function waitReceipt(
  publicClient: PublicClient,
  hash: `0x${string}`,
  confirmations: number,
): Promise<TransactionReceipt> {
  return publicClient.waitForTransactionReceipt({ hash, confirmations });
}

/**
 * Firma EIP-191 del mensaje canónico de bind de funding wallet
 * (confirmado src/routes/auth.ts:62-64).
 */
export async function signBindMessage(
  account: LocalAccount,
  keyId: string,
): Promise<`0x${string}`> {
  return account.signMessage({
    message: `WASIAI_BIND_FUNDING_WALLET:${keyId}`,
  });
}

export interface SignDelegationInput {
  domain: TypedDataDomain;
  types: TypedData;
  message: Record<string, unknown>;
}

/**
 * Firma EIP-712 de la policy de delegación. CD-10: el `message` que entra acá
 * YA tiene `expires_at: bigint` y `allowed_chains: bigint[]` (el split se hace
 * en agent.ts). PROHIBIDO pasar el JSON crudo (number) acá.
 */
export async function signDelegation(
  account: LocalAccount,
  input: SignDelegationInput,
): Promise<`0x${string}`> {
  return account.signTypedData({
    domain: input.domain,
    types: input.types,
    primaryType: 'Delegation',
    message: input.message,
  });
}
