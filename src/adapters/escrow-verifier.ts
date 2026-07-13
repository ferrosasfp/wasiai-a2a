/**
 * Escrow deposit verifier (WKH-126b — non-custodial coexistente).
 *
 * Espejo de `deposit-verifier.ts` para el camino NO-custodial: en lugar de un
 * `Transfer` ERC-20 a una EOA treasury, verifica el evento `Deposited(depositor,
 * keyId, amount)` que emite el contrato escrow (WKH-126a) ANTES de acreditar
 * budget (CD-1: verify-before-credit). No muta estado.
 *
 * Diferencias clave con `deposit-verifier.ts`:
 *   - Filtra logs por la DIRECCIÓN DEL CONTRATO ESCROW (no por el token).
 *   - `resolveEscrowContract` NO tiene fallback a `OPERATOR_PRIVATE_KEY`: el
 *     escrow es un contrato deployado, no una EOA derivable (CD-3).
 *   - Matchea por `keyId` decodificado del evento contra
 *     `keccak256(stringToBytes(callerKey.id))` (CD-8); el monto acreditado
 *     SIEMPRE es el on-chain `Deposited.amount`, nunca `body.amount`.
 *
 * Reusa helpers chain-genéricos de `deposit-verifier.ts` (DT-6, single source of
 * truth): `resolveChainFamilyEnvSuffix`, `resolveMinConfirmations`,
 * `resolveRpcUrl`, `resolveChainObject` (importados; estos dos últimos se
 * exportaron de forma aditiva en `deposit-verifier.ts` — ver Story File §4.1.1
 * opción (a)).
 *
 * El ABI/keyId son PROVISIONALES — VERIFY-AT-IMPL con WKH-126a.
 */

import type { PublicClient } from 'viem';
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  parseAbiItem,
  parseUnits,
} from 'viem';
import {
  resolveChainFamilyEnvSuffix,
  resolveChainObject,
  resolveMinConfirmations,
  resolveRpcUrl,
} from './deposit-verifier.js';
import { ESCROW_ABI } from './escrow/abi.js';
import type { AdaptersBundle, ChainKey } from './types.js';

// ── Tipos (W0) ──────────────────────────────────────────────

export type EscrowVerificationReason =
  | 'TX_NOT_FOUND'
  | 'TX_REVERTED'
  | 'INSUFFICIENT_CONFIRMATIONS'
  | 'CHAIN_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'RPC_UNAVAILABLE'
  | 'ESCROW_CONTRACT_NOT_CONFIGURED' // DT-7: env A2A_ESCROW_CONTRACT_<FAMILY> ausente/inválida
  | 'DEPOSIT_EVENT_NOT_FOUND' // ningún Deposited del escrow
  | 'KEY_ID_MISMATCH'; // Deposited.keyId != keccak256(callerKey.id)

export interface EscrowDepositVerification {
  ok: boolean;
  reason?: EscrowVerificationReason; // solo si ok=false
  amountAtomic?: bigint;
  amountUsd?: string; // formatUnits(amount, token.decimals)
  tokenSymbol?: string; // bundle.payment.supportedTokens[0].symbol
  from?: `0x${string}`; // == Deposited.depositor (gate funding-wallet del handler)
  confirmations?: number;
}

export interface VerifyEscrowDepositArgs {
  chainKey: ChainKey;
  bundle: AdaptersBundle;
  txHash: `0x${string}`;
  keyIdHash: `0x${string}`; // keccak256(stringToBytes(callerKey.id)) — §3, VERIFY-AT-IMPL
  expectedAmountUsd?: string | undefined; // body.amount declarado (opcional; → AMOUNT_MISMATCH)
}

// ── Constants / helpers (no hardcodes — CD-3) ───────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * viem deriva el topic0 del ABI — NO hardcodear el hash del evento Deposited
 * (CD-3). PROVISIONAL — VERIFY-AT-IMPL con WKH-126a.
 */
const DEPOSITED_EVENT = parseAbiItem(
  'event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)',
);

/**
 * Dirección del contrato escrow para la chain (DT-7/CD-3). Lee
 * `A2A_ESCROW_CONTRACT_<FAMILY>`; ausente/inválida → `null` (fail-loud →
 * ESCROW_CONTRACT_NOT_CONFIGURED, cero crédito).
 *
 * A DIFERENCIA de `resolveTreasury`: NO hay fallback a `OPERATOR_PRIVATE_KEY` —
 * el escrow es un contrato deployado, no una EOA derivable.
 */
export function resolveEscrowContract(
  chainKey: ChainKey,
): `0x${string}` | null {
  const family = resolveChainFamilyEnvSuffix(chainKey);
  const addr = process.env[`A2A_ESCROW_CONTRACT_${family}`];
  if (addr && ADDRESS_RE.test(addr)) return addr as `0x${string}`;
  return null;
}

// ── Lazy publicClient cache per ChainKey (propio, DT-6) ─────

const _clients = new Map<ChainKey, PublicClient>();

function getEscrowClient(chainKey: ChainKey): PublicClient | null {
  const cached = _clients.get(chainKey);
  if (cached) return cached;
  const rpcUrl = resolveRpcUrl(chainKey);
  if (!rpcUrl) return null;
  const client = createPublicClient({
    chain: resolveChainObject(chainKey),
    transport: http(rpcUrl),
  }) as PublicClient;
  _clients.set(chainKey, client);
  return client;
}

/** TEST-ONLY — clears the escrow publicClient cache (patrón _resetVerifier). */
export function _resetEscrowVerifier(): void {
  _clients.clear();
}

/**
 * Lee `arbitrationConsent(keyId)` del escrow (WKH-191g, CD-7). Consulta pura, no
 * muta estado. CUALQUIER error / contrato-null / RPC-null → `false` silencioso: es
 * el estado ESPERADO hasta la HU de captura de consentimiento; jamás bloquea ni
 * emite warning ruidoso (el gate del árbitro cae al fallback operator-custodial).
 */
export async function readArbitrationConsent(
  chainKey: ChainKey,
  keyIdHash: string,
): Promise<boolean> {
  try {
    const escrowContract = resolveEscrowContract(chainKey);
    if (!escrowContract) return false;
    const client = getEscrowClient(chainKey);
    if (!client) return false;
    const consent = await client.readContract({
      address: escrowContract,
      abi: ESCROW_ABI,
      functionName: 'arbitrationConsent',
      args: [keyIdHash as `0x${string}`],
    });
    return consent === true;
  } catch {
    return false;
  }
}

// ── Public API ──────────────────────────────────────────────

export async function verifyEscrowDeposit(
  args: VerifyEscrowDepositArgs,
): Promise<EscrowDepositVerification> {
  const { chainKey, bundle, txHash, keyIdHash, expectedAmountUsd } = args;

  // 1. Contrato escrow configurado — antes del client, fail-loud (DT-7/CD-3).
  const escrowContract = resolveEscrowContract(chainKey);
  if (!escrowContract) {
    return { ok: false, reason: 'ESCROW_CONTRACT_NOT_CONFIGURED' };
  }
  const escrowContractLc = escrowContract.toLowerCase();

  // 2. publicClient — RPC URL ausente → fail-loud, cero crédito (CD-1).
  const client = getEscrowClient(chainKey);
  if (!client) {
    return { ok: false, reason: 'RPC_UNAVAILABLE' };
  }

  // 3. Receipt — throw / no encontrado → TX_NOT_FOUND.
  let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { ok: false, reason: 'TX_NOT_FOUND' };
  }

  // 4. Status.
  if (receipt.status !== 'success') {
    return { ok: false, reason: 'TX_REVERTED' };
  }

  // 5. chainId match (CD-5).
  let onchainChainId: number;
  try {
    onchainChainId = await client.getChainId();
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE' };
  }
  if (onchainChainId !== bundle.chainConfig.chainId) {
    return { ok: false, reason: 'CHAIN_MISMATCH' };
  }

  // 6. Confirmaciones.
  let latest: bigint;
  try {
    latest = await client.getBlockNumber();
  } catch {
    return { ok: false, reason: 'RPC_UNAVAILABLE' };
  }
  const confirmations = Number(latest - receipt.blockNumber) + 1;
  const min = resolveMinConfirmations(chainKey);
  if (confirmations < min) {
    return { ok: false, reason: 'INSUFFICIENT_CONFIRMATIONS', confirmations };
  }

  // 7-8. Recorrer logs del CONTRATO ESCROW (no del token) y matchear keyId.
  const token = bundle.payment.supportedTokens[0];
  if (!token) {
    // bundle sin token soportado → no se puede derivar decimals/symbol (config inválida).
    return {
      ok: false,
      reason: 'ESCROW_CONTRACT_NOT_CONFIGURED',
      confirmations,
    };
  }
  let escrowEventSeen = false;
  let amountAtomic: bigint | undefined;
  let depositor: `0x${string}` | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowContractLc) continue;
    let decoded: ReturnType<
      typeof decodeEventLog<readonly [typeof DEPOSITED_EVENT], 'Deposited'>
    >;
    try {
      decoded = decodeEventLog({
        abi: [DEPOSITED_EVENT],
        eventName: 'Deposited',
        data: log.data,
        topics: log.topics,
      });
    } catch {
      // log del escrow que no es un Deposited decodificable — ignorar.
      continue;
    }
    escrowEventSeen = true;
    const { depositor: from, keyId, amount } = decoded.args;
    // CD-8: el keyId debe coincidir con keccak256(stringToBytes(callerKey.id)).
    if (keyId.toLowerCase() !== keyIdHash.toLowerCase()) continue;
    amountAtomic = amount;
    depositor = from;
    break;
  }

  if (amountAtomic === undefined || depositor === undefined) {
    // Distinguir: ¿hubo algún Deposited del escrow? → KEY_ID_MISMATCH; si no → DEPOSIT_EVENT_NOT_FOUND.
    return {
      ok: false,
      reason: escrowEventSeen ? 'KEY_ID_MISMATCH' : 'DEPOSIT_EVENT_NOT_FOUND',
      confirmations,
    };
  }

  // 9. amount → USD (CD-8): decimals del token, NUNCA literal.
  const amountUsd = formatUnits(amountAtomic, token.decimals);

  // 10. Chequeo opcional contra body.amount (sin pérdida de precisión, CD-8).
  if (expectedAmountUsd !== undefined) {
    let expectedAtomic: bigint | undefined;
    try {
      expectedAtomic = parseUnits(expectedAmountUsd, token.decimals);
    } catch {
      expectedAtomic = undefined;
    }
    if (expectedAtomic === undefined || expectedAtomic !== amountAtomic) {
      return { ok: false, reason: 'AMOUNT_MISMATCH', confirmations };
    }
  }

  // 11. Éxito (sin recipient — no hay treasury en escrow; el handler usa `from`).
  return {
    ok: true,
    amountAtomic,
    amountUsd,
    tokenSymbol: token.symbol,
    from: depositor,
    confirmations,
  };
}
