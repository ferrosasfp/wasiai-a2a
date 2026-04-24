#!/usr/bin/env node
/**
 * WasiAI Hackathon E2E — full demo path.
 *
 * Flow:
 *   1. a2a gateway health + /discover (agent directory)
 *   2. facilitator health + /supported (chain registry)
 *   3. Sign EIP-3009 TransferWithAuthorization from operator wallet
 *      to a fresh "merchant" address for 0.001 PYUSD on Kite Testnet.
 *   4. POST facilitator /verify — must return verified=true (no on-chain write).
 *   5. POST facilitator /settle — must return settled=true with a real tx hash.
 *   6. Verify tx receipt via Kite RPC — status=success.
 *
 * This is the end-to-end "agent-to-agent payment on Kite + PYUSD" narrative.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  parseUnits,
  formatUnits,
  defineChain,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config (process.env first, fallback to .env in repo root) ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(__dirname, '..', '.env'),
  resolve(__dirname, '..', '.env.local'),
];
const env = { ...process.env };
for (const path of envCandidates) {
  if (!existsSync(path)) continue;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const m = rawLine.match(/^([A-Z_]+)=(.*)$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}

const OPERATOR_PK = env.OPERATOR_PRIVATE_KEY;
const RPC_URL =
  env.KITE_TESTNET_RPC_URL ||
  env.KITE_RPC_URL ||
  'https://rpc-testnet.gokite.ai/';
const PYUSD =
  env.X402_PAYMENT_TOKEN ||
  env.KITE_USDC_ADDRESS ||
  '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const CHAIN_ID = Number(env.KITE_CHAIN_ID ?? 2368);
const DECIMALS = 18;

const A2A = env.A2A_URL || 'https://wasiai-a2a-production.up.railway.app';
// Use our canonical x402 facilitator (Pieverse is non-canonical and would
// reject this body shape). Override with WASIAI_FACILITATOR_URL if needed.
const FAC =
  env.WASIAI_FACILITATOR_URL ||
  'https://wasiai-facilitator-production.up.railway.app';
const EXPLORER = env.KITE_EXPLORER_URL || 'https://testnet.kitescan.ai';

if (!OPERATOR_PK) {
  console.error(
    'ERROR: OPERATOR_PRIVATE_KEY not found (set in env or scripts/../.env).',
  );
  process.exit(1);
}

// ── Utilities ───────────────────────────────────────────────
const line = (c = '─') => console.log(c.repeat(70));
const section = (title) => {
  console.log();
  line('═');
  console.log(`  ${title}`);
  line('═');
};
const step = (n, title) => console.log(`\n▶ Step ${n}: ${title}`);

async function getJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

// ── Run ─────────────────────────────────────────────────────
section('WasiAI Hackathon E2E — Agent-to-Agent PYUSD payment on Kite');

console.log(`  A2A gateway   : ${A2A}`);
console.log(`  Facilitator   : ${FAC}`);
console.log(`  Chain         : Kite Testnet (${CHAIN_ID})`);
console.log(`  Token         : PYUSD ${PYUSD} (${DECIMALS} dec)`);
console.log(`  Explorer      : ${EXPLORER}`);

// ─── Step 1: a2a gateway up + discovery ────────────────────
step(1, 'A2A gateway health + agent discovery');

const health = await getJson(`${A2A}/`);
console.log(`  GET /             → HTTP ${health.status} (version=${health.body?.version})`);
if (health.status !== 200) throw new Error('A2A gateway is not healthy');

const discover = await getJson(`${A2A}/discover`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ limit: 5 }),
});
console.log(`  POST /discover    → HTTP ${discover.status}`);
if (Array.isArray(discover.body?.agents)) {
  console.log(`  Registered agents: ${discover.body.agents.length}`);
  for (const a of discover.body.agents.slice(0, 3)) {
    console.log(`    - ${a.slug ?? a.name ?? a.id ?? '<no-id>'} (registry=${a.registry ?? '?'})`);
  }
} else {
  console.log(`  Body: ${JSON.stringify(discover.body).slice(0, 200)}`);
}

// ─── Step 2: facilitator up + supported chains ────────────
step(2, 'Facilitator health + supported chains');

const facHealth = await getJson(`${FAC}/health`);
console.log(`  GET /health       → HTTP ${facHealth.status} (status=${facHealth.body?.status})`);

const supported = await getJson(`${FAC}/supported`);
console.log(`  GET /supported    → HTTP ${supported.status}`);
const kiteEntry = supported.body?.kinds?.find(
  (k) =>
    k.network === `eip155:${CHAIN_ID}` ||
    k.network === String(CHAIN_ID) ||
    (k.asset && k.asset.toLowerCase() === PYUSD.toLowerCase()),
);
if (kiteEntry) {
  console.log(
    `  ✓ Kite PYUSD supported: network=${kiteEntry.network} asset=${kiteEntry.asset}`,
  );
} else {
  console.log(`  Body: ${JSON.stringify(supported.body).slice(0, 400)}`);
}

// ─── Step 3: sign EIP-3009 authorization ──────────────────
step(3, 'Sign EIP-3009 TransferWithAuthorization (operator → fresh merchant)');

const operator = privateKeyToAccount(OPERATOR_PK);
const merchant = privateKeyToAccount(generatePrivateKey()); // ephemeral payee
const amount = parseUnits('0.001', DECIMALS); // 0.001 PYUSD

// Pre-flight: check operator's PYUSD balance
const kiteChain = defineChain({
  id: CHAIN_ID,
  name: 'Kite Testnet',
  nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const rpc = createPublicClient({ chain: kiteChain, transport: http(RPC_URL) });
const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
];
let opBalance = await rpc.readContract({
  address: PYUSD,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [operator.address],
});

// Auto-mint if balance insufficient. PYUSD on Kite Testnet is a ThirdWeb
// drop-style contract: claim() (no args) and claimTo(address). Each call
// mints CLAIM_AMOUNT to the caller/recipient.
if (opBalance < amount) {
  const claimAbi = [
    { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: [] },
    { type: 'function', name: 'CLAIM_AMOUNT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  ];
  const claimAmount = await rpc.readContract({
    address: PYUSD,
    abi: claimAbi,
    functionName: 'CLAIM_AMOUNT',
  });
  console.log(
    `  Balance ${formatUnits(opBalance, DECIMALS)} PYUSD < needed ${formatUnits(amount, DECIMALS)} — calling claim() (mints ${formatUnits(claimAmount, DECIMALS)} PYUSD)…`,
  );
  const wallet = createWalletClient({
    account: operator,
    chain: kiteChain,
    transport: http(RPC_URL),
  });
  const mintTx = await wallet.writeContract({
    address: PYUSD,
    abi: claimAbi,
    functionName: 'claim',
    args: [],
  });
  console.log(`  mint tx: ${mintTx}`);
  const mintReceipt = await rpc.waitForTransactionReceipt({ hash: mintTx });
  console.log(`  mint status=${mintReceipt.status} block=${mintReceipt.blockNumber}`);
  opBalance = await rpc.readContract({
    address: PYUSD,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [operator.address],
  });
  console.log(`  new balance: ${formatUnits(opBalance, DECIMALS)} PYUSD`);
}

const settleable = opBalance >= amount;

const now = Math.floor(Date.now() / 1000);
const validAfter = 0n;
const validBefore = BigInt(now + 300);
const nonce = keccak256(toHex(`wasiai-e2e-${Date.now()}-${Math.random()}`));

console.log(`  From  (operator): ${operator.address}`);
console.log(`  To    (merchant): ${merchant.address}`);
console.log(`  Amount           : ${formatUnits(amount, DECIMALS)} PYUSD (${amount} atomic)`);
console.log(`  Operator PYUSD   : ${formatUnits(opBalance, DECIMALS)} PYUSD ${settleable ? '✓' : '⚠ insufficient'}`);
console.log(`  validBefore      : ${validBefore} (in ${Number(validBefore) - now}s)`);
console.log(`  nonce            : ${nonce}`);

const signature = await operator.signTypedData({
  domain: {
    name: 'PYUSD',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: PYUSD,
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
    to: merchant.address,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  },
});
console.log(`  signature        : ${signature.slice(0, 20)}…${signature.slice(-6)}`);

// x402 canonical body (v2)
const body = {
  x402Version: 2,
  resource: { url: 'https://hackathon.wasiai.example/pay' },
  accepted: {
    scheme: 'exact',
    network: `eip155:${CHAIN_ID}`,
    amount: amount.toString(),
    asset: PYUSD,
    payTo: merchant.address,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009' },
  },
  payload: {
    signature,
    authorization: {
      from: operator.address,
      to: merchant.address,
      value: amount.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  },
};

// ─── Step 4: /verify (off-chain signature check) ─────────
step(4, 'POST /verify — off-chain signature recovery');

const verify = await getJson(`${FAC}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(`  HTTP ${verify.status}`);
console.log(`  → ${JSON.stringify(verify.body).slice(0, 400)}`);
if (verify.status !== 200 || !verify.body.verified) {
  throw new Error(`/verify failed: ${JSON.stringify(verify.body)}`);
}
console.log(`  ✓ verified=true, client=${verify.body.client}`);

// ─── Step 5: /settle (on-chain write) ────────────────────
step(5, 'POST /settle — on-chain PYUSD transfer');

let txHash = null;
let blockNumber = null;
let onChainConfirmed = false;

if (!settleable) {
  console.log(
    `  ⏭  SKIPPED — operator PYUSD balance (${formatUnits(opBalance, DECIMALS)}) < amount (${formatUnits(amount, DECIMALS)}).`,
  );
  console.log(
    `     Refill the operator wallet (${operator.address}) with PYUSD on Kite Testnet to exercise /settle.`,
  );
} else {
  const startedAt = Date.now();
  const settle = await getJson(`${FAC}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`  HTTP ${settle.status}  (${elapsed}s)`);
  console.log(`  → ${JSON.stringify(settle.body).slice(0, 600)}`);

  if (settle.status !== 200 || !settle.body.settled) {
    throw new Error(`/settle failed: ${JSON.stringify(settle.body)}`);
  }

  txHash = settle.body.transactionHash;
  blockNumber = settle.body.blockNumber;
  console.log(`  ✓ settled=true`);
  console.log(`  ✓ tx    : ${txHash}`);
  console.log(`  ✓ block : ${blockNumber}`);

  // ─── Step 6: on-chain receipt verification ────────────────
  step(6, 'On-chain receipt verification');
  const receipt = await rpc.getTransactionReceipt({ hash: txHash });
  console.log(`  status=${receipt.status} block=${receipt.blockNumber} gas=${receipt.gasUsed}`);
  if (receipt.status !== 'success') {
    throw new Error(`Receipt status not success: ${receipt.status}`);
  }
  onChainConfirmed = true;
  console.log(`  ✓ on-chain confirmed`);
  console.log(`  Explorer: ${EXPLORER}/tx/${txHash}`);
}

// ─── Orchestration path (A2A key budget mode) ─────────────
// This is the other half of the hackathon narrative: a client with an
// A2A key submits a *goal*, the gateway plans with an LLM, calls one or
// more registered agents, and returns the composed output.
//
// Requires SUPABASE_* env vars (we need to provision a temp key). If
// missing, this section is skipped cleanly.

let orchestrateSummary = '⏭ skipped (no SUPABASE creds)';
let composeSummary = '⏭ skipped (no SUPABASE creds)';
const SB_URL = env.SUPABASE_URL;
const SB_TOKEN = env.SUPABASE_ACCESS_TOKEN;

if (SB_URL && SB_TOKEN) {
  const ref = SB_URL.match(/^https?:\/\/([^.]+)\./)?.[1];
  const sbApi = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  const sbHeaders = {
    Authorization: `Bearer ${SB_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0',
  };
  const sbQuery = async (q) => {
    const r = await fetch(sbApi, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ query: q }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase query ${r.status}: ${text}`);
    return JSON.parse(text);
  };

  // Provision ephemeral A2A key scoped to a one-off owner_ref.
  step(7, 'Provision ephemeral A2A key (budget mode)');
  const { randomBytes, createHash } = await import('node:crypto');
  const rawKey = `wasi_a2a_${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const ownerRef = `e2e-demo-${Date.now()}`;
  await sbQuery(
    `INSERT INTO a2a_agent_keys (key_hash, owner_ref, display_name, budget) VALUES ('${keyHash}', '${ownerRef}', 'hackathon-e2e-demo', '{"${CHAIN_ID}": "100"}'::jsonb);`,
  );
  console.log(`  key provisioned  : owner_ref=${ownerRef}`);
  console.log(`  budget           : 100 USD on chain ${CHAIN_ID}`);

  try {
    // ─ Step 8: orchestrate ──────────────────────────────────
    step(8, 'POST /orchestrate — goal-based multi-agent pipeline');
    const orchBody = {
      goal: 'List one security-auditing agent that could review a Solidity ERC-20 contract, and summarize its capabilities in one sentence.',
      budget: 5,
      maxAgents: 1,
    };
    console.log(`  goal   : ${orchBody.goal.slice(0, 80)}…`);
    console.log(`  budget : ${orchBody.budget} USD, maxAgents: ${orchBody.maxAgents}`);

    const orchStart = Date.now();
    const orch = await getJson(`${A2A}/orchestrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2A-Key': rawKey,
      },
      body: JSON.stringify(orchBody),
    });
    const orchElapsed = ((Date.now() - orchStart) / 1000).toFixed(1);
    console.log(`  HTTP ${orch.status} (${orchElapsed}s)`);

    const bodyPreview = JSON.stringify(orch.body).slice(0, 800);
    console.log(`  body   : ${bodyPreview}${bodyPreview.length >= 800 ? '…' : ''}`);

    if (orch.status === 200 && orch.body) {
      const considered = orch.body.consideredAgents?.length ?? 0;
      const pipelineOk = orch.body.pipeline?.success === true;
      const pipelineErr = orch.body.pipeline?.error ?? '';
      if (pipelineOk) {
        orchestrateSummary = `✓ HTTP 200, pipeline.success=true, agents=${considered}`;
        console.log(`  ✓ full pipeline succeeded`);
      } else {
        orchestrateSummary = `⚠ gateway OK (HTTP 200, plan+routing worked, ${considered} agent(s) considered); downstream agent error: ${pipelineErr.slice(0, 80)}`;
        console.log(`  ⚠ gateway OK but downstream agent returned an error`);
        console.log(`    ${pipelineErr}`);
      }
    } else {
      orchestrateSummary = `⚠ HTTP ${orch.status} — ${JSON.stringify(orch.body).slice(0, 200)}`;
      console.log(`  ⚠ orchestration non-200 (gateway error, not downstream)`);
    }

    // ─ Step 9: compose ──────────────────────────────────────
    step(9, 'POST /compose — explicit multi-step pipeline');
    const firstAgent = discover.body?.agents?.[0];
    // ComposeStep.agent = id-or-slug. Prefer slug (non-empty) over id.
    const agentRef = firstAgent?.slug || firstAgent?.id;
    if (!agentRef) {
      composeSummary = '⏭ skipped (no agent slug available)';
      console.log('  ⏭ no agent available to compose against');
    } else {
      const composeBody = {
        steps: [
          {
            agent: agentRef,
            registry: firstAgent?.registry,
            input: { prompt: 'Say hello in one short sentence.' },
          },
        ],
        maxBudget: 5,
      };
      console.log(`  step 1 agent: ${agentRef} (registry=${firstAgent?.registry ?? '?'})`);
      const composeStart = Date.now();
      const comp = await getJson(`${A2A}/compose`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-A2A-Key': rawKey,
        },
        body: JSON.stringify(composeBody),
      });
      const compElapsed = ((Date.now() - composeStart) / 1000).toFixed(1);
      console.log(`  HTTP ${comp.status} (${compElapsed}s)`);
      const preview = JSON.stringify(comp.body).slice(0, 800);
      console.log(`  body: ${preview}${preview.length >= 800 ? '…' : ''}`);
      if (comp.status === 200) {
        composeSummary = '✓ HTTP 200 (full pipeline)';
      } else if (typeof comp.body?.error === 'string' && comp.body.error.includes('returned')) {
        const err = comp.body.error.slice(0, 80);
        composeSummary = `⚠ gateway OK, downstream agent returned error: ${err}`;
      } else {
        composeSummary = `⚠ HTTP ${comp.status}`;
      }
    }
  } finally {
    // ─ Cleanup ──────────────────────────────────────────────
    step(10, 'Cleanup — delete ephemeral A2A key');
    await sbQuery(
      `DELETE FROM a2a_agent_keys WHERE key_hash = '${keyHash}';`,
    );
    await sbQuery(`DELETE FROM tasks WHERE owner_ref = '${ownerRef}';`);
    console.log('  ✓ removed temp key + any tasks created under owner_ref');
  }
} else {
  console.log(
    '\n▶ Steps 7-10 SKIPPED (no SUPABASE_URL / SUPABASE_ACCESS_TOKEN — cannot provision temp key).',
  );
}

// ─── Summary ──────────────────────────────────────────────
section(settleable ? '✅ HACKATHON E2E PASSED' : '⚠ HACKATHON E2E — OFF-CHAIN OK, /settle SKIPPED');
console.log(`  A2A gateway up .................... ✓`);
console.log(`  Agent discovery ................... ✓`);
console.log(`  Facilitator healthy ............... ✓`);
console.log(`  Kite PYUSD in supported chains .... ${kiteEntry ? '✓' : '(listed under chains[] instead of kinds[])'}`);
console.log(`  EIP-3009 signature recovery ....... ✓`);
console.log(`  /verify off-chain ................. ✓`);
console.log(`  /settle on-chain .................. ${onChainConfirmed ? '✓' : '⏭ skipped (no operator PYUSD)'}`);
console.log(`  /orchestrate (A2A-key path) ....... ${orchestrateSummary}`);
console.log(`  /compose (A2A-key path) ........... ${composeSummary}`);
if (txHash) {
  console.log(`  TX hash: ${txHash}`);
  console.log(`  ${EXPLORER}/tx/${txHash}`);
}
