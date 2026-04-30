// config.mjs — env loading + fail-fast validation.
//
// CD-14: returned config NEVER contains the private key. Only operatorAddress.
// AC-6: PK shape is validated; failure messages NEVER echo the value.
// AC-7/AC-8: gateway URL goes through SSRF guard; default warns once.

import { privateKeyToAccount } from 'viem/accounts';
import { validateGatewayUrl, SSRFViolationError } from './url-validator.mjs';
import { warnOnce } from './log.mjs';

export class ConfigError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConfigError';
  }
}

const PK_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const PK_ERROR_MSG = 'OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex';

export async function loadConfig() {
  // ── PK validation (AC-6, CD-14)
  const pkRaw = process.env.OPERATOR_PRIVATE_KEY;
  if (!pkRaw) {
    throw new ConfigError(PK_ERROR_MSG);
  }
  if (!PK_RE.test(pkRaw)) {
    throw new ConfigError(PK_ERROR_MSG);
  }
  let operatorAddress;
  try {
    operatorAddress = privateKeyToAccount(pkRaw).address;
  } catch {
    // Sanitize: never expose pkRaw or upstream message that may include it.
    throw new ConfigError('OPERATOR_PRIVATE_KEY failed to derive an account');
  }

  // ── Gateway URL (AC-7, AC-8)
  let rawGateway = process.env.WASIAI_GATEWAY_URL;
  if (!rawGateway) {
    rawGateway = 'https://app.wasiai.io';
    warnOnce('gateway-default', 'config.gateway-default', { gatewayUrl: rawGateway });
  }
  const allowDevPrivate = process.env.NODE_ENV === 'development';
  const allowlist = (process.env.MCP_GATEWAY_ALLOWLIST ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  let gatewayUrl;
  try {
    gatewayUrl = await validateGatewayUrl(rawGateway, { allowDevPrivate, allowlist });
  } catch (e) {
    if (e instanceof SSRFViolationError) {
      throw new ConfigError(`WASIAI_GATEWAY_URL invalid: ${e.message} (category=${e.category})`);
    }
    throw e;
  }

  // ── Kite chain + contract
  const chainId = Number.parseInt(process.env.KITE_CHAIN_ID ?? '2368', 10);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ConfigError(`KITE_CHAIN_ID invalid: ${process.env.KITE_CHAIN_ID}`);
  }
  const contract = process.env.KITE_PYUSD ?? '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
  if (!ADDR_RE.test(contract)) {
    throw new ConfigError(`KITE_PYUSD invalid contract: ${contract}`);
  }

  const domainName = process.env.X402_EIP712_DOMAIN_NAME ?? 'PYUSD';
  const domainVersion = process.env.X402_EIP712_DOMAIN_VERSION ?? '1';

  // ── Optional cap guard
  let maxAmountWeiDefault;
  if (process.env.MCP_MAX_AMOUNT_WEI_DEFAULT && process.env.MCP_MAX_AMOUNT_WEI_DEFAULT.trim() !== '') {
    try {
      maxAmountWeiDefault = BigInt(process.env.MCP_MAX_AMOUNT_WEI_DEFAULT);
      if (maxAmountWeiDefault < 0n) throw new Error('negative');
    } catch {
      throw new ConfigError(`MCP_MAX_AMOUNT_WEI_DEFAULT invalid: ${process.env.MCP_MAX_AMOUNT_WEI_DEFAULT}`);
    }
  }

  // ── Timeout
  const payTimeoutMs = Number.parseInt(process.env.MCP_PAY_TIMEOUT_MS ?? '30000', 10);
  if (!Number.isInteger(payTimeoutMs) || payTimeoutMs <= 0) {
    throw new ConfigError(`MCP_PAY_TIMEOUT_MS invalid: ${process.env.MCP_PAY_TIMEOUT_MS}`);
  }

  return {
    operatorAddress,
    gatewayUrl,
    chainId,
    contract,
    domainName,
    domainVersion,
    maxAmountWeiDefault,
    payTimeoutMs,
    nodeEnv: process.env.NODE_ENV ?? 'production',
  };
}
