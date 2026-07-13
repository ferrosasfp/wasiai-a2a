/**
 * EIP-712 `DebitAuthorization` — escrow non-custodial debit (WKH-126b).
 *
 * PROVISIONAL — VERIFY-AT-IMPL con WKH-126a: la forma del struct, el orden de
 * campos y la presencia de `nonce` convergen byte-a-byte con el contrato escrow.
 * El typehash canónico lo deriva viem (`hashTypedData`/`recoverTypedDataAddress`);
 * NUNCA se hardcodea (CD-3).
 *
 * A DIFERENCIA de `signed-auth.ts`/`delegation.ts` (que omiten `verifyingContract`),
 * el domain escrow SÍ lo incluye (CD-12): el verificador es el contrato on-chain
 * (`ECDSA.recover`), no el server.
 *
 * El helper `buildDebitAuthorization` es PURO: no toca DB ni red, NO ejecuta
 * `writeContract debit(...)` (CD-7). La presentación on-chain real es 126a.
 */

import { hashTypedData, recoverTypedDataAddress } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

/** bytes32 hex (`0x` + 64 hex) — `keyId` derivado de `keccak256(stringToBytes(uuid))`. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Tipos EIP-712 del struct `DebitAuthorization` (`as const`, typehash derivado
 * por viem — CD-3).
 *
 * PROVISIONAL — VERIFY-AT-IMPL con WKH-126a: 126a debe usar EXACTAMENTE el mismo
 * string de tipo (mismo orden de campos). Si 126a omite `nonce`, degradar a 3
 * campos y documentar como TD (Story File §9 R-2).
 */
export const DEBIT_AUTHORIZATION_TYPES = {
  DebitAuthorization: [
    { name: 'keyId', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** Mensaje firmado (unidades ATÓMICAS para `amount`, epoch seconds para `deadline`). */
export type DebitAuthorizationMessage = {
  keyId: `0x${string}`;
  amount: bigint;
  deadline: bigint;
  nonce: bigint;
};

/** Domain EIP-712 del escrow (incluye `verifyingContract` — CD-12). */
export interface DebitEip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

/**
 * Construye el domain EIP-712 del escrow. Lee `ESCROW_EIP712_NAME` /
 * `ESCROW_EIP712_VERSION` con defaults `'WasiAIEscrow'` / `'1'` (CD-3).
 *
 * PROVISIONAL — VERIFY-AT-IMPL con WKH-126a: `name`/`version` deben coincidir
 * con el `EIP712Domain` del contrato deployado.
 */
export function buildDebitDomain(
  chainId: number,
  verifyingContract: `0x${string}`,
): DebitEip712Domain {
  return {
    name: process.env.ESCROW_EIP712_NAME ?? 'WasiAIEscrow',
    version: process.env.ESCROW_EIP712_VERSION ?? '1',
    chainId,
    verifyingContract,
  };
}

// ── W3: construcción/validación de la autorización de débito ────────────────

export interface BuildDebitAuthorizationParams {
  keyId: `0x${string}`; // bytes32 (keccak256(stringToBytes(uuid)))
  amount: bigint; // unidades ATÓMICAS
  deadline: bigint; // epoch seconds
  nonce: bigint;
  chainId: number;
  verifyingContract: `0x${string}`;
  signer: PrivateKeyAccount; // privateKeyToAccount(OPERATOR_PRIVATE_KEY) o session key
}

export interface BuildDebitAuthorizationResult {
  signature: `0x${string}`;
  recovered: `0x${string}`;
  presentable: boolean;
}

/**
 * Construye y firma una autorización de débito EIP-712 (server-side), con
 * recover de sanity off-chain.
 *
 * - CD-12: si `verifyingContract` no es una dirección válida (cero/placeholder)
 *   NO firma → `{ presentable: false }`.
 * - Helper PURO (CD-7): no toca DB ni red, NO ejecuta `writeContract`.
 *
 * PROVISIONAL — VERIFY-AT-IMPL con WKH-126a (forma del struct + `nonce`).
 */
export async function buildDebitAuthorization(
  params: BuildDebitAuthorizationParams,
): Promise<BuildDebitAuthorizationResult> {
  const { keyId, amount, deadline, nonce, chainId, verifyingContract, signer } =
    params;

  // CD-12: rechazar firmar sin contrato escrow válido (cero/placeholder).
  if (
    !verifyingContract ||
    !ADDRESS_RE.test(verifyingContract) ||
    /^0x0+$/.test(verifyingContract)
  ) {
    return {
      signature: '0x' as `0x${string}`,
      recovered: '0x' as `0x${string}`,
      presentable: false,
    };
  }

  const domain = buildDebitDomain(chainId, verifyingContract);
  const message: DebitAuthorizationMessage = { keyId, amount, deadline, nonce };

  const signature = await signer.signTypedData({
    domain,
    types: DEBIT_AUTHORIZATION_TYPES,
    primaryType: 'DebitAuthorization',
    message,
  });

  // Recover de sanity off-chain: el firmante recuperado debe ser `signer.address`.
  let recovered: `0x${string}`;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: DEBIT_AUTHORIZATION_TYPES,
      primaryType: 'DebitAuthorization',
      message,
      signature,
    });
  } catch {
    return { signature, recovered: '0x' as `0x${string}`, presentable: false };
  }

  const presentable = recovered.toLowerCase() === signer.address.toLowerCase();
  return { signature, recovered, presentable };
}

export interface RecoverDebitAuthorizationParams {
  message: DebitAuthorizationMessage;
  domain: DebitEip712Domain;
  signature: string;
}

/**
 * Recupera el firmante de una firma `DebitAuthorization` YA recibida del cliente
 * (191a captura). Espejo off-chain de `ECDSA.recover` en
 * `WasiAIEscrow._verifyAndConsume`. Reusa `DEBIT_AUTHORIZATION_TYPES` (CD-5).
 * Helper PURO: no toca DB ni red, NUNCA ejecuta `writeContract` (CD-7).
 * Devuelve `null` si el recover lanza (firma malformada) — el caller lo trata
 * como SIGNER_MISMATCH.
 */
export async function recoverDebitAuthorization(
  params: RecoverDebitAuthorizationParams,
): Promise<`0x${string}` | null> {
  try {
    return await recoverTypedDataAddress({
      domain: params.domain,
      types: DEBIT_AUTHORIZATION_TYPES,
      primaryType: 'DebitAuthorization',
      message: params.message,
      signature: params.signature as `0x${string}`,
    });
  } catch {
    return null;
  }
}

/**
 * Hash EIP-712 de la autorización (para tests/auditoría). Typehash derivado por
 * viem (CD-3). PROVISIONAL — VERIFY-AT-IMPL con WKH-126a.
 */
export function hashDebitAuthorization(params: {
  keyId: `0x${string}`;
  amount: bigint;
  deadline: bigint;
  nonce: bigint;
  chainId: number;
  verifyingContract: `0x${string}`;
}): `0x${string}` {
  const { keyId, amount, deadline, nonce, chainId, verifyingContract } = params;
  const domain = buildDebitDomain(chainId, verifyingContract);
  return hashTypedData({
    domain,
    types: DEBIT_AUTHORIZATION_TYPES,
    primaryType: 'DebitAuthorization',
    message: { keyId, amount, deadline, nonce },
  });
}
