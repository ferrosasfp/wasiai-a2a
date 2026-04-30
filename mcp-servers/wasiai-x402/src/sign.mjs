// sign.mjs — pure EIP-3009 / x402 envelope signing.
//
// Match EXACTO scripts/smoke-prod-via-app-wasiai.mjs:47-68:
//   - domain.name = X402_EIP712_DOMAIN_NAME (default 'PYUSD')
//   - domain.version = X402_EIP712_DOMAIN_VERSION (default '1')
//   - domain.chainId = KITE_CHAIN_ID
//   - domain.verifyingContract = KITE_PYUSD address
//   - types.TransferWithAuthorization order: from,to,value,validAfter,validBefore,nonce
//   - message.validAfter = 0n (BigInt)
//   - envelope = base64(JSON({ signature, authorization{ value/validBefore as string,
//     validAfter:'0', nonce hex 0x... }, network: `eip155:<chainId>` }))
//
// CD-14: PK is read on-demand from process.env. NEVER cached, NEVER exposed.

import { privateKeyToAccount } from 'viem/accounts';

function getAccount() {
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error('OPERATOR_PRIVATE_KEY missing at sign-time');
  return privateKeyToAccount(pk);
}

export function getOperatorAddress() {
  return getAccount().address;
}

export async function signX402Envelope({
  to,
  value,
  validBefore,
  nonce,
  chainId,
  contract,
  domainName,
  domainVersion,
}) {
  const account = getAccount();
  const validAfter = 0n;
  const message = {
    from: account.address,
    to,
    value,        // BigInt — viem serializes
    validAfter,   // 0n
    validBefore,  // BigInt
    nonce,        // 0x... 32-byte hex
  };
  const signature = await account.signTypedData({
    domain: {
      name: domainName,
      version: domainVersion,
      chainId,
      verifyingContract: contract,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message,
  });

  // Envelope — match smoke script :64-68 exactly.
  // BigInts serialize as strings; nonce stays as 0x hex.
  const authorization = {
    from: account.address,
    to,
    value: value.toString(),
    validAfter: '0',
    validBefore: validBefore.toString(),
    nonce,
  };
  const envelopeBase64 = Buffer.from(JSON.stringify({
    signature,
    authorization,
    network: `eip155:${chainId}`,
  })).toString('base64');

  return { signature, envelopeBase64, authorization };
}
