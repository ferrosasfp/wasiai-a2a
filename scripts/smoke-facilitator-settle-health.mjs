#!/usr/bin/env node
/**
 * Smoke: FACILITATOR SETTLEMENT HEALTH — regression detector for the
 * "cap-check fail-closed" outage class.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * A facilitator cap-check failure (fail-closed) once silently broke ALL x402
 * settlement: every existing smoke saw a correct "402 challenge", signed a
 * payment, then settlement was REJECTED with
 *     "Settlement cap check failed — service unavailable"
 * but NO existing script treated "settle rejected" as a hard FAIL with a
 * distinct alarm. Smokes that only assert "got a 402" or "HTTP 200 envelope"
 * miss it entirely.
 *
 * This smoke does ONE minimal real settlement through the LIVE gateway per
 * chain and PASSES ONLY if a real on-chain TX HASH (0x{64}) is produced.
 * It FAILS LOUD with a labeled banner when it sees the cap-check regression
 * class or a signature-reject / persistent-402-after-payment regression.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IT EXERCISES
 * ───────────────────────────────────────────────────────────────────────────
 * Chain "kite-fuji" (default, KNOWN-WORKING today):
 *   POST /orchestrate — caller signs EIP-3009 PYUSD inbound on Kite testnet,
 *   gateway settles inbound via wasiai-facilitator (Kite) AND signs+settles
 *   downstream USDC on Fuji. PASS requires the inbound Kite tx hash (a real
 *   facilitator settlement). This is the exact path the orchestrate smoke
 *   covers, so it is reliable today.
 *
 * Each chain PASSES only if: HTTP 200 AND at least one real tx hash 0x{64}.
 * Each chain FAILS LOUD (distinct banner) if the response/error matches a
 * known settlement-regression signature (see SETTLE_REGRESSION_PATTERNS).
 *
 * Exit code 0 ONLY if every ATTEMPTED chain produced a tx hash. A chain that
 * cannot reach a payment path (e.g. missing balance/config) is SKIPPED with a
 * clear note rather than counted as a false alarm — but kite-fuji must PASS.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * REQUIRED ENV (read from wasiai-a2a/.env or process env; secrets never printed)
 * ───────────────────────────────────────────────────────────────────────────
 *   OPERATOR_PRIVATE_KEY        — caller signer wallet PK (inbound payer)
 *
 * OPTIONAL ENV (defaults shown):
 *   SETTLE_HEALTH_GATEWAY_URL   — gateway base URL
 *                                 (default https://wasiai-a2a-production.up.railway.app)
 *   SETTLE_HEALTH_CHAINS        — comma list of chains to attempt
 *                                 (default "kite-fuji"; also supports "base-sepolia")
 *   SETTLE_HEALTH_BUDGET_USDC   — orchestrate budget in USDC (default 0.5)
 *   X402_EIP712_DOMAIN_NAME     — Kite inbound EIP-712 domain name (default PYUSD)
 *   X402_EIP712_DOMAIN_VERSION  — Kite inbound EIP-712 domain version (default 1)
 *   BASE_SMOKE_GATEWAY_URL      — overrides gateway for base-sepolia leg if set
 *   BASE_SMOKE_AMOUNT_USDC      — base-sepolia settle amount (default 0.001)
 *   BASE_SMOKE_AGENT_SLUG       — base-sepolia pipeline agent (default wasi-chainlink-price)
 *   BASE_SMOKE_AGENT_REGISTRY   — base-sepolia registry (default wasiai)
 *   BASE_SEPOLIA_RPC_URL        — Base Sepolia RPC (default https://sepolia.base.org)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CONSTRAINTS: testnet only, never mainnet. One settle per chain, no loops.
 *   Does NOT modify production source or other scripts.
 */

import {
  createPublicClient,
  http,
  defineChain,
  parseUnits,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ENV_FILE = '/home/ferdev/.openclaw/workspace/wasiai-a2a/.env';
const DEFAULT_GATEWAY = 'https://wasiai-a2a-production.up.railway.app';

// Canonical testnet identifiers (NOT hardcodes — verified onchain, pinned in adapters).
const KITE_CHAIN_ID = 2368;
const KITE_PYUSD = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const KITE_EXPLORER = 'https://testnet.kitescan.ai/tx';
const FUJI_EXPLORER = 'https://testnet.snowtrace.io/tx';

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_SEPOLIA_NETWORK_TAG = `eip155:${BASE_SEPOLIA_CHAIN_ID}`;
const BASE_SEPOLIA_CHAIN_SLUG = 'base-sepolia';
const BASE_USDC_EIP712_NAME = 'USDC';
const BASE_USDC_EIP712_VERSION = '2';
const USDC_DECIMALS = 6;
const BASESCAN_TX_BASE = 'https://sepolia.basescan.org/tx';

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// ──────────────────────────────────────────────────────────────────────────────
// Regression signatures. Matched case-insensitively against the raw response
// text AND any error string. These are the OUTAGE classes this smoke exists to
// catch loud. Order matters: cap-check first (the silent fail-closed outage).
// ──────────────────────────────────────────────────────────────────────────────
const CAP_CHECK_PATTERNS = [
  'settlement cap check failed',
  'cap check failed',
  'cap check',
  'cap-check',
];
const SERVICE_UNAVAILABLE_PATTERNS = [
  'service unavailable',
  'serviceunavailable',
];
const SIGNATURE_REJECT_PATTERNS = [
  'signature rejected',
  'invalid signature',
  'signature verification failed',
  'invalid_signature',
];

function matchAny(haystack, patterns) {
  const h = (haystack ?? '').toLowerCase();
  return patterns.find((p) => h.includes(p));
}

// ──────────────────────────────────────────────────────────────────────────────
// Env loading (mirror of the other smokes — never prints values).
// ──────────────────────────────────────────────────────────────────────────────
function readEnvFile(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}
function normPk(s) {
  if (!s || typeof s !== 'string') return null;
  const hex = s.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 64) return null;
  return '0x' + hex.slice(-64);
}

const fileEnv = readEnvFile(ENV_FILE);
function envVar(name) {
  return process.env[name] ?? fileEnv[name];
}

const OPERATOR_PK = normPk(envVar('OPERATOR_PRIVATE_KEY'));
if (!OPERATOR_PK) {
  console.error(
    '✗ ERROR: OPERATOR_PRIVATE_KEY must be set (checked process.env and ' +
      `${ENV_FILE}).`,
  );
  process.exit(1);
}
const operator = privateKeyToAccount(OPERATOR_PK);

const GATEWAY_URL = (envVar('SETTLE_HEALTH_GATEWAY_URL') ?? DEFAULT_GATEWAY).replace(
  /\/+$/,
  '',
);
const BUDGET_USDC = Number(envVar('SETTLE_HEALTH_BUDGET_USDC') ?? '0.5');
const CHAINS = (envVar('SETTLE_HEALTH_CHAINS') ?? 'kite-fuji')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ──────────────────────────────────────────────────────────────────────────────
// Result helpers — a per-chain outcome the summary uses for exit code + banner.
// ──────────────────────────────────────────────────────────────────────────────
function pass(chain, txHashes, extra = {}) {
  return { chain, status: 'PASS', txHashes, ...extra };
}
function fail(chain, reason, kind, extra = {}) {
  // kind ∈ 'CAP_REGRESSION' | 'SIGNATURE_REJECT' | 'PERSISTENT_402' | 'GENERIC'
  return { chain, status: 'FAIL', reason, kind, ...extra };
}
function skip(chain, reason) {
  return { chain, status: 'SKIP', reason };
}

/**
 * Classify a settlement response/error into a regression kind. `source` is
 * 'facilitator' or 'gateway' for the operator to know where to look — the
 * cap-check error originates from the facilitator (it owns the cap), surfaced
 * to the caller through the gateway.
 */
function classifySettleFailure(chain, httpStatus, rawText, extra = {}) {
  const cap = matchAny(rawText, CAP_CHECK_PATTERNS);
  const unavail = matchAny(rawText, SERVICE_UNAVAILABLE_PATTERNS);
  if (cap || (unavail && /settle|payment|facilitator/i.test(rawText))) {
    return fail(
      chain,
      `Settlement REJECTED by facilitator cap-check (matched: "${cap ?? unavail}"). ` +
        `HTTP ${httpStatus}. This is the fail-closed outage class.`,
      'CAP_REGRESSION',
      { source: 'facilitator', ...extra },
    );
  }
  const sig = matchAny(rawText, SIGNATURE_REJECT_PATTERNS);
  if (sig) {
    return fail(
      chain,
      `Settlement REJECTED — signature rejected (matched: "${sig}"). HTTP ${httpStatus}.`,
      'SIGNATURE_REJECT',
      { source: 'facilitator', ...extra },
    );
  }
  if (httpStatus === 402) {
    return fail(
      chain,
      `Persistent 402 AFTER payment — gateway/facilitator refused the signed ` +
        `payment without a cap/signature reason. HTTP 402.`,
      'PERSISTENT_402',
      { source: 'gateway', ...extra },
    );
  }
  // Generic non-200: still a real failure, but not a known regression signature.
  return fail(
    chain,
    `Settlement did not complete: HTTP ${httpStatus}. ${rawText.slice(0, 300)}`,
    'GENERIC',
    { source: 'gateway', ...extra },
  );
}

function collectTxHashes(body, headerResp) {
  const out = new Set();
  const push = (v) => {
    if (typeof v === 'string' && TX_HASH_RE.test(v)) out.add(v);
  };
  push(body?.kiteTxHash);
  push(body?.txHash);
  push(body?.transactionHash);
  push(body?.tx_hash);
  push(body?.meta?.txHash);
  const steps = body?.pipeline?.steps ?? body?.steps ?? [];
  for (const s of steps) {
    push(s?.downstreamTxHash);
    push(s?.txHash);
    push(s?.settle?.txHash);
  }
  if (headerResp) {
    try {
      const decoded = JSON.parse(
        Buffer.from(headerResp, 'base64').toString('utf-8'),
      );
      push(decoded.transactionHash);
      push(decoded.txHash);
      push(decoded.transaction);
    } catch {
      try {
        const decoded = JSON.parse(headerResp);
        push(decoded.transactionHash);
        push(decoded.txHash);
        push(decoded.transaction);
      } catch {
        /* best effort */
      }
    }
  }
  return [...out];
}

// ──────────────────────────────────────────────────────────────────────────────
// Chain runner: kite-fuji via /orchestrate (known-working path).
// ──────────────────────────────────────────────────────────────────────────────
async function runKiteFuji() {
  const chain = 'kite-fuji';
  const GOAL = 'Get the current AVAX price and DeFi market sentiment';
  console.log(`\n▶ [${chain}] POST /orchestrate (Kite inbound + Fuji downstream)`);
  console.log(`   goal:   "${GOAL}"`);
  console.log(`   budget: $${BUDGET_USDC} USDC`);

  // Step 1: 402 challenge
  let probe;
  try {
    probe = await fetch(`${GATEWAY_URL}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: GOAL, budget: BUDGET_USDC }),
    });
  } catch (e) {
    return skip(chain, `network error reaching gateway: ${e.message}`);
  }
  if (probe.status !== 402) {
    const t = await probe.text();
    return fail(
      chain,
      `expected 402 challenge, got HTTP ${probe.status}: ${t.slice(0, 200)}`,
      'GENERIC',
      { source: 'gateway' },
    );
  }
  const challenge = await probe.json();
  const accept = challenge.accepts?.[0];
  const treasury = accept?.payTo;
  if (!treasury || !/^0x[0-9a-fA-F]{40}$/.test(treasury)) {
    return fail(chain, `402 missing accepts[0].payTo (got ${treasury})`, 'GENERIC', {
      source: 'gateway',
    });
  }
  const maxAmount = BigInt(accept.maxAmountRequired);
  console.log(`   ← HTTP 402  treasury=${treasury}  maxAmount=${maxAmount} (PYUSD wei)`);

  // Step 2: sign EIP-3009 inbound on Kite
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const nonce = '0x' + randomBytes(32).toString('hex');
  let signature;
  try {
    signature = await operator.signTypedData({
      domain: {
        name: envVar('X402_EIP712_DOMAIN_NAME') ?? 'PYUSD',
        version: envVar('X402_EIP712_DOMAIN_VERSION') ?? '1',
        chainId: KITE_CHAIN_ID,
        verifyingContract: KITE_PYUSD,
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
      message: {
        from: operator.address,
        to: treasury,
        value: maxAmount,
        validAfter: 0n,
        validBefore,
        nonce,
      },
    });
  } catch (e) {
    return fail(chain, `local signing failed: ${e.message}`, 'GENERIC', {
      source: 'gateway',
    });
  }
  const xPayment = Buffer.from(
    JSON.stringify({
      signature,
      authorization: {
        from: operator.address,
        to: treasury,
        value: maxAmount.toString(),
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce,
      },
      network: `eip155:${KITE_CHAIN_ID}`,
    }),
  ).toString('base64');

  // Step 3: settle
  console.log(`   → POST /orchestrate with payment-signature (settling)…`);
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${GATEWAY_URL}/orchestrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'payment-signature': xPayment,
      },
      body: JSON.stringify({ goal: GOAL, budget: BUDGET_USDC }),
    });
  } catch (e) {
    return fail(chain, `network error on paid /orchestrate: ${e.message}`, 'GENERIC', {
      source: 'gateway',
    });
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const rawText = await res.text();
  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = { raw: rawText };
  }
  console.log(`   ← HTTP ${res.status} (${elapsed}s)`);

  // Regression classification on ANY non-200 OR any 200 that still carries a
  // cap-check / signature-reject string (defensive: some gateways return 200
  // with an error envelope).
  const headerResp =
    res.headers.get('x-payment-response') ?? res.headers.get('X-PAYMENT-RESPONSE');

  if (res.status !== 200) {
    return classifySettleFailure(chain, res.status, rawText);
  }

  // 200 envelope — still scan for embedded regression markers before trusting it.
  const capIn200 = matchAny(rawText, CAP_CHECK_PATTERNS);
  const sigIn200 = matchAny(rawText, SIGNATURE_REJECT_PATTERNS);
  if (capIn200) {
    return classifySettleFailure(chain, 200, rawText);
  }
  if (sigIn200) {
    return classifySettleFailure(chain, 200, rawText);
  }

  const txHashes = collectTxHashes(body, headerResp);
  const kiteTx = typeof body?.kiteTxHash === 'string' && TX_HASH_RE.test(body.kiteTxHash)
    ? body.kiteTxHash
    : null;

  // PASS requires a REAL inbound settlement (the facilitator cap-check sits on
  // this path). No kite tx => settlement silently did not happen.
  if (!kiteTx) {
    return fail(
      chain,
      `HTTP 200 but NO inbound Kite tx hash — facilitator did not settle inbound. ` +
        `pipeline.success=${body?.pipeline?.success}. Body keys: ${Object.keys(body).join(',')}`,
      'GENERIC',
      { source: 'facilitator' },
    );
  }
  if (body?.pipeline?.success !== true) {
    return fail(
      chain,
      `inbound settled (kiteTx=${kiteTx}) but pipeline.success !== true ` +
        `(${body?.pipeline?.success}). Downstream execution failed.`,
      'GENERIC',
      { source: 'gateway', kiteTx },
    );
  }

  const downstream = txHashes.filter((h) => h !== kiteTx);
  console.log(`   ✓ inbound Kite tx:  ${kiteTx}`);
  console.log(`     ${KITE_EXPLORER}/${kiteTx}`);
  for (const d of downstream) {
    console.log(`   ✓ downstream Fuji tx: ${d}`);
    console.log(`     ${FUJI_EXPLORER}/${d}`);
  }
  return pass(chain, txHashes, { kiteTx, downstream });
}

// ──────────────────────────────────────────────────────────────────────────────
// Chain runner: base-sepolia via /compose (optional).
// ──────────────────────────────────────────────────────────────────────────────
async function runBaseSepolia() {
  const chain = 'base-sepolia';
  const gw = (envVar('BASE_SMOKE_GATEWAY_URL') ?? GATEWAY_URL).replace(/\/+$/, '');
  const amountStr = envVar('BASE_SMOKE_AMOUNT_USDC') ?? '0.001';
  const agentSlug = envVar('BASE_SMOKE_AGENT_SLUG') ?? 'wasi-chainlink-price';
  const registry = envVar('BASE_SMOKE_AGENT_REGISTRY') ?? 'wasiai';
  const rpcUrl = envVar('BASE_SEPOLIA_RPC_URL') ?? 'https://sepolia.base.org';
  let amount;
  try {
    amount = parseUnits(amountStr, USDC_DECIMALS);
  } catch (e) {
    return skip(chain, `invalid BASE_SMOKE_AMOUNT_USDC="${amountStr}"`);
  }

  console.log(`\n▶ [${chain}] POST /compose (Base Sepolia settle)`);
  console.log(`   gateway: ${gw}  agent: ${registry}/${agentSlug}  amount: ${amountStr} USDC`);

  // Pre-flight balance — skip (not fail) if underfunded, to avoid a false alarm.
  const baseSepolia = defineChain({
    id: BASE_SEPOLIA_CHAIN_ID,
    name: 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const rpc = createPublicClient({ chain: baseSepolia, transport: http() });
  try {
    const bal = await rpc.readContract({
      address: BASE_SEPOLIA_USDC,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ type: 'address' }],
          outputs: [{ type: 'uint256' }],
        },
      ],
      functionName: 'balanceOf',
      args: [operator.address],
    });
    if (bal < amount) {
      return skip(
        chain,
        `underfunded: ${formatUnits(bal, USDC_DECIMALS)} USDC < ${amountStr} ` +
          `(fund via faucet.circle.com / Base Sepolia)`,
      );
    }
    console.log(`   balance ok: ${formatUnits(bal, USDC_DECIMALS)} USDC`);
  } catch (e) {
    return skip(chain, `RPC balanceOf failed (${rpcUrl}): ${e.message}`);
  }

  const composeBody = {
    steps: [{ agent: agentSlug, registry, input: { token: 'ETH' } }],
    maxBudget: Math.max(0.5, Number(amountStr) * 10),
  };

  // Step 1: 402
  let probe;
  try {
    probe = await fetch(`${gw}/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment-chain': BASE_SEPOLIA_CHAIN_SLUG },
      body: JSON.stringify(composeBody),
    });
  } catch (e) {
    return skip(chain, `network error reaching gateway: ${e.message}`);
  }
  const probeText = await probe.text();
  if (probe.status !== 402) {
    return fail(chain, `expected 402, got HTTP ${probe.status}: ${probeText.slice(0, 200)}`, 'GENERIC', {
      source: 'gateway',
    });
  }
  let probeBody;
  try {
    probeBody = JSON.parse(probeText);
  } catch {
    probeBody = {};
  }
  const accept = Array.isArray(probeBody.accepts) ? probeBody.accepts[0] : undefined;
  const payTo = accept?.payTo;
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    return fail(chain, `402 missing accepts[0].payTo (got ${payTo})`, 'GENERIC', { source: 'gateway' });
  }
  const valueToSign = accept?.maxAmountRequired ? BigInt(accept.maxAmountRequired) : amount;
  console.log(`   ← HTTP 402  payTo=${payTo}  value=${valueToSign}`);

  // Step 2: sign
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const nonceHex = '0x' + randomBytes(32).toString('hex');
  let signature;
  try {
    signature = await operator.signTypedData({
      domain: {
        name: BASE_USDC_EIP712_NAME,
        version: BASE_USDC_EIP712_VERSION,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        verifyingContract: BASE_SEPOLIA_USDC,
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
      message: {
        from: operator.address,
        to: payTo,
        value: valueToSign,
        validAfter: 0n,
        validBefore,
        nonce: nonceHex,
      },
    });
  } catch (e) {
    return fail(chain, `local signing failed: ${e.message}`, 'GENERIC', { source: 'gateway' });
  }
  const xPayment = Buffer.from(
    JSON.stringify({
      signature,
      authorization: {
        from: operator.address,
        to: payTo,
        value: valueToSign.toString(),
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce: nonceHex,
      },
      network: BASE_SEPOLIA_NETWORK_TAG,
    }),
  ).toString('base64');

  // Step 3: settle
  console.log(`   → POST /compose with payment-signature (settling)…`);
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${gw}/compose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'payment-signature': xPayment,
        'x-payment-chain': BASE_SEPOLIA_CHAIN_SLUG,
      },
      body: JSON.stringify(composeBody),
    });
  } catch (e) {
    return fail(chain, `network error on paid /compose: ${e.message}`, 'GENERIC', { source: 'gateway' });
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const rawText = await res.text();
  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = { raw: rawText };
  }
  console.log(`   ← HTTP ${res.status} (${elapsed}s)`);
  const headerResp =
    res.headers.get('x-payment-response') ?? res.headers.get('X-PAYMENT-RESPONSE');

  if (res.status !== 200) {
    return classifySettleFailure(chain, res.status, rawText);
  }
  if (matchAny(rawText, CAP_CHECK_PATTERNS) || matchAny(rawText, SIGNATURE_REJECT_PATTERNS)) {
    return classifySettleFailure(chain, 200, rawText);
  }

  const txHashes = collectTxHashes(body, headerResp);
  if (txHashes.length === 0) {
    return fail(
      chain,
      `HTTP 200 but no tx hash produced — settlement did not occur. ` +
        `Body keys: ${Object.keys(body).join(',')}`,
      'GENERIC',
      { source: 'facilitator' },
    );
  }
  for (const h of txHashes) {
    console.log(`   ✓ Base tx: ${h}`);
    console.log(`     ${BASESCAN_TX_BASE}/${h}`);
  }
  return pass(chain, txHashes);
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  FACILITATOR SETTLEMENT HEALTH — cap-check regression detector');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Gateway: ${GATEWAY_URL}`);
console.log(`  Caller:  ${operator.address}`);
console.log(`  Chains:  ${CHAINS.join(', ')}`);

const RUNNERS = {
  'kite-fuji': runKiteFuji,
  'base-sepolia': runBaseSepolia,
};

const results = [];
for (const chain of CHAINS) {
  const runner = RUNNERS[chain];
  if (!runner) {
    results.push(skip(chain, `unknown chain "${chain}" — no runner`));
    continue;
  }
  try {
    results.push(await runner());
  } catch (e) {
    results.push(fail(chain, `unexpected error: ${e.message}`, 'GENERIC', { source: 'gateway' }));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary + alarms
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('═══════════════════════════════════════════════════════════════');

const capRegressions = results.filter((r) => r.status === 'FAIL' && r.kind === 'CAP_REGRESSION');
const sigRejects = results.filter((r) => r.status === 'FAIL' && r.kind === 'SIGNATURE_REJECT');
const persistent402 = results.filter((r) => r.status === 'FAIL' && r.kind === 'PERSISTENT_402');
const otherFails = results.filter((r) => r.status === 'FAIL' && !['CAP_REGRESSION', 'SIGNATURE_REJECT', 'PERSISTENT_402'].includes(r.kind));
const passes = results.filter((r) => r.status === 'PASS');
const skips = results.filter((r) => r.status === 'SKIP');

for (const r of results) {
  if (r.status === 'PASS') {
    console.log(`  ✅ ${r.chain}: PASS — ${r.txHashes.length} tx hash(es): ${r.txHashes.join(', ')}`);
  } else if (r.status === 'SKIP') {
    console.log(`  ⏭  ${r.chain}: SKIPPED — ${r.reason}`);
  } else {
    console.log(`  ❌ ${r.chain}: FAIL [${r.kind}, source=${r.source ?? '?'}] — ${r.reason}`);
  }
}

// LOUD banners for the regression classes.
if (capRegressions.length > 0) {
  console.error('\n>>> ═══════════════════════════════════════════════════════════');
  console.error('>>> SETTLEMENT CAP REGRESSION DETECTED');
  console.error('>>> ═══════════════════════════════════════════════════════════');
  console.error('>>> The facilitator cap-check is FAIL-CLOSED. ALL x402 settlement');
  console.error('>>> is silently rejected. This is the outage class this smoke exists');
  console.error('>>> to catch. SOURCE = FACILITATOR (it owns the cap), surfaced via gateway.');
  for (const r of capRegressions) {
    console.error(`>>>   - ${r.chain}: ${r.reason}`);
  }
  console.error('>>> ═══════════════════════════════════════════════════════════');
}
if (sigRejects.length > 0) {
  console.error('\n>>> ═══════════════════════════════════════════════════════════');
  console.error('>>> SIGNATURE REJECTION DETECTED (facilitator refused signed payment)');
  console.error('>>> ═══════════════════════════════════════════════════════════');
  for (const r of sigRejects) {
    console.error(`>>>   - ${r.chain}: ${r.reason}`);
  }
}
if (persistent402.length > 0) {
  console.error('\n>>> ═══════════════════════════════════════════════════════════');
  console.error('>>> PERSISTENT 402 AFTER PAYMENT (settlement refused, no tx)');
  console.error('>>> ═══════════════════════════════════════════════════════════');
  for (const r of persistent402) {
    console.error(`>>>   - ${r.chain}: ${r.reason}`);
  }
}

const attempted = results.filter((r) => r.status !== 'SKIP');
const allAttemptedPassed = attempted.length > 0 && attempted.every((r) => r.status === 'PASS');
// kite-fuji is the known-working path; if it was requested it MUST pass.
const kiteRequested = CHAINS.includes('kite-fuji');
const kiteResult = results.find((r) => r.chain === 'kite-fuji');
const kiteOk = !kiteRequested || (kiteResult && kiteResult.status === 'PASS');

console.log('');
console.log(`  Passed:  ${passes.length}   Failed: ${capRegressions.length + sigRejects.length + persistent402.length + otherFails.length}   Skipped: ${skips.length}`);

if (allAttemptedPassed && kiteOk) {
  console.log('\n✅ SETTLEMENT HEALTHY — every attempted chain produced a real on-chain tx hash.');
  process.exit(0);
}

if (kiteRequested && !kiteOk) {
  console.error('\n✗ kite-fuji is the KNOWN-WORKING path and did NOT pass — settlement is degraded.');
}
console.error('\n✗ SETTLEMENT HEALTH CHECK FAILED — see chain failures above.');
process.exit(1);
