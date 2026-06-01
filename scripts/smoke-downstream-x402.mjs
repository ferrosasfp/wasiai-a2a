#!/usr/bin/env node
/**
 * @file smoke-downstream-x402.mjs
 * @description Committeable, secret-free regression smoke for the OUTBOUND x402
 *              downstream payout path (operator-float pays downstream agents via
 *              our facilitator). Live + on-chain proven on Base Sepolia (WKH-106)
 *              and Avalanche Fuji (WKH-107). WKH-108.
 *
 * Two layers:
 *   1. LIGHT layer (always, network-only, NO secrets): asserts the facilitator
 *      is up (GET /health == 200) and that /supported lists Base Sepolia
 *      (eip155:84532) and Avalanche Fuji (eip155:43113), each with method
 *      'eip3009' and breakerState 'CLOSED'. Fails (exit != 0) if any is missing.
 *   2. E2E layer (opt-in): ONLY when RUN_DOWNSTREAM_E2E=1 AND FUNDER_PK present.
 *      Runs the real provision -> discover -> compose -> downstream-settle flow
 *      (mirror of scripts/smoke-base-downstream.mjs) and asserts a
 *      downstreamTxHash. Without the gate or FUNDER_PK -> prints SKIP, exit 0.
 *
 * Usage:
 *   node scripts/smoke-downstream-x402.mjs                      # light layer only
 *   RUN_DOWNSTREAM_E2E=1 FUNDER_PK=0x... node scripts/...mjs    # + E2E (testnet)
 *
 * Env vars (all optional, public defaults):
 *   FACILITATOR_URL   Default: https://wasiai-facilitator-production.up.railway.app
 *   EXPECTED_CHAINS   Default: eip155:84532,eip155:43113   (CSV of CAIP-2 ids)
 *   A2A_BASE          Default: https://wasiai-a2a-production.up.railway.app  (E2E)
 *   NETWORK           Default: base-sepolia | avalanche-fuji                 (E2E)
 *   RPC_URL, AMOUNT, GAS_ETH, OWNER_REF, GOAL                                (E2E)
 *   RUN_DOWNSTREAM_E2E  '1' to enable the E2E layer
 *   FUNDER_PK           sponsor private key (E2E only; NEVER committed)
 *
 * Exit codes:
 *   0 = PASS (incl. E2E skipped cleanly)
 *   != 0 = real failure (facilitator down, chain dropped, breaker open, E2E fail)
 *
 * Constraint Directives (WKH-108):
 *   CD-1  No secrets/abs-paths committed: all creds/URLs via env w/ public defaults.
 *   CD-2  Clean skip: no RUN_DOWNSTREAM_E2E=1 or no FUNDER_PK -> exit 0 + SKIP.
 *   CD-3  Light network layer inside vitest is gated by RUN_NETWORK_SMOKE.
 */

const FACILITATOR_URL =
  process.env.FACILITATOR_URL ??
  'https://wasiai-facilitator-production.up.railway.app';
const DEFAULT_EXPECTED_CHAINS = 'eip155:84532,eip155:43113'; // Base Sepolia, Avalanche Fuji
const EXPECTED_CHAINS = (process.env.EXPECTED_CHAINS ?? DEFAULT_EXPECTED_CHAINS)
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
const REQUIRED_METHOD = 'eip3009';
const REQUIRED_BREAKER = 'CLOSED';
const FETCH_TIMEOUT_MS = Number(process.env.SMOKE_FETCH_TIMEOUT_MS ?? 10000);

function progress(msg) {
  process.stderr.write(`[smoke] ${msg}\n`);
}

/**
 * fetch wrapper with an AbortSignal timeout. A hung facilitator (accepts the
 * connection but never responds) must fail fast with a legible error instead
 * of hanging until the CI runner's global timeout (MNR-2).
 * @param {string} url
 * @param {string} label  human-readable endpoint label for the error message
 * @param {RequestInit} [init]
 */
async function fetchWithTimeout(url, label, init = {}) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

/**
 * Light layer: network-only facilitator health + supported chains/breaker.
 * Throws on any assertion failure. No secrets.
 */
export async function runLightLayer() {
  progress(
    `facilitator=${FACILITATOR_URL} expectedChains=${EXPECTED_CHAINS.join(',')}`,
  );

  // --- AC-1: GET /health == 200 ------------------------------------------
  progress('GET /health ...');
  const healthRes = await fetchWithTimeout(
    `${FACILITATOR_URL}/health`,
    '/health',
  );
  if (healthRes.status !== 200) {
    throw new Error(`/health returned HTTP ${healthRes.status} (expected 200)`);
  }
  progress('health OK (200)');

  // --- AC-2: GET /supported -> chains + methods + breaker ----------------
  progress('GET /supported ...');
  const supRes = await fetchWithTimeout(
    `${FACILITATOR_URL}/supported`,
    '/supported',
  );
  if (supRes.status !== 200) {
    throw new Error(`/supported returned HTTP ${supRes.status} (expected 200)`);
  }
  const supported = await supRes.json();
  const chains = Array.isArray(supported?.chains) ? supported.chains : [];
  if (chains.length === 0) {
    throw new Error('/supported returned no chains');
  }

  const byNetwork = new Map(chains.map((c) => [c?.network, c]));
  for (const expected of EXPECTED_CHAINS) {
    const chain = byNetwork.get(expected);
    if (!chain) {
      throw new Error(
        `expected chain ${expected} not found in /supported (got: ${[...byNetwork.keys()].join(', ')})`,
      );
    }
    const methods = Array.isArray(chain.methods) ? chain.methods : [];
    if (!methods.includes(REQUIRED_METHOD)) {
      throw new Error(
        `chain ${expected} (${chain.name ?? '?'}) missing method '${REQUIRED_METHOD}' (got: ${methods.join(', ')})`,
      );
    }
    if (chain.breakerState !== REQUIRED_BREAKER) {
      throw new Error(
        `chain ${expected} (${chain.name ?? '?'}) breakerState='${chain.breakerState}' (expected '${REQUIRED_BREAKER}')`,
      );
    }
    progress(
      `chain ${expected} (${chain.name}) OK [methods=${methods.join(',')} breaker=${chain.breakerState}]`,
    );
  }

  return { healthy: true, chains: EXPECTED_CHAINS };
}

/**
 * AC-6 (informative, NON-blocking): probe the A2A /discover endpoint to log
 * whether demo agents (base-demo / avax-demo) are reachable. NEVER throws or
 * changes the exit code — purely a stderr signal. Mirrors the E2E layer's
 * `POST /discover { q }` call shape (MNR-1).
 */
export async function probeA2ADiscover() {
  const A2A_BASE =
    process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
  try {
    const res = await fetchWithTimeout(`${A2A_BASE}/discover`, '/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'base' }),
    });
    if (res.status !== 200) {
      progress(`A2A discover: WARN HTTP ${res.status} (informative, ignored)`);
      return;
    }
    const json = await res.json().catch(() => ({}));
    const agents = json?.agents ?? json?.results ?? [];
    const slugs = Array.isArray(agents)
      ? agents.map((a) => a?.slug).filter(Boolean)
      : [];
    progress(
      `A2A discover: reachable, ${slugs.length} agent(s)${slugs.length ? ` [${slugs.slice(0, 5).join(', ')}]` : ''}`,
    );
  } catch (err) {
    progress(
      `A2A discover: WARN unreachable (${err?.message ?? String(err)}) (informative, ignored)`,
    );
  }
}

/**
 * Gate check for the E2E layer (CD-2 clean skip).
 * @returns {{run: boolean, reason?: string}}
 */
export function e2eGate(env = process.env) {
  if (env.RUN_DOWNSTREAM_E2E !== '1') {
    return { run: false, reason: 'RUN_DOWNSTREAM_E2E != 1' };
  }
  if (!env.FUNDER_PK) {
    return { run: false, reason: 'FUNDER_PK not set' };
  }
  return { run: true };
}

/**
 * E2E layer: real provision -> discover -> compose -> downstream settle.
 * Mirror of scripts/smoke-base-downstream.mjs. Testnet only. Requires FUNDER_PK.
 * Throws if no downstreamTxHash is produced.
 */
export async function runE2ELayer() {
  // Lazy import: viem is only needed for the opt-in E2E path.
  const { privateKeyToAccount, generatePrivateKey } = await import(
    'viem/accounts'
  );
  const {
    createWalletClient,
    createPublicClient,
    http,
    parseUnits,
    parseEther,
  } = await import('viem');
  const { baseSepolia, avalancheFuji } = await import('viem/chains');

  const A2A_BASE =
    process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
  const SPONSOR_PK = process.env.FUNDER_PK;
  const NETWORK = process.env.NETWORK ?? 'base-sepolia';
  const CHAIN_HEADER = NETWORK;
  const AMOUNT = process.env.AMOUNT ?? '0.05';
  const GAS_ETH = process.env.GAS_ETH ?? '0.0015';
  const OWNER_REF = process.env.OWNER_REF ?? `${NETWORK}-downstream-smoke`;
  const GOAL =
    process.env.GOAL ?? (NETWORK === 'avalanche-fuji' ? 'avalanche' : 'base');

  const CHAINS = {
    'base-sepolia': { viem: baseSepolia, rpc: 'https://sepolia.base.org' },
    'avalanche-fuji': {
      viem: avalancheFuji,
      rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
    },
  };
  const CHAIN = CHAINS[NETWORK];
  if (!CHAIN) {
    throw new Error(
      `NETWORK not supported: ${NETWORK} (use base-sepolia | avalanche-fuji)`,
    );
  }
  const RPC = process.env.RPC_URL ?? CHAIN.rpc;

  const ERC20 = [
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
  ];

  async function api(path, { method = 'POST', key, body, chain } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['x-a2a-key'] = key;
    if (chain) headers['x-payment-chain'] = chain;
    const res = await fetchWithTimeout(`${A2A_BASE}${path}`, path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  const DEPOSIT_RETRYABLE = new Set([
    'INSUFFICIENT_CONFIRMATIONS',
    'TX_NOT_FOUND',
    'RPC_UNAVAILABLE',
  ]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function depositWithRetry({ key, key_id, tx_hash, chain_id }) {
    const headers = { 'Content-Type': 'application/json', 'x-a2a-key': key };
    const payload = JSON.stringify({ key_id, tx_hash, chain_id });
    for (let i = 0; i <= 6; i++) {
      const res = await fetchWithTimeout(
        `${A2A_BASE}/auth/deposit`,
        '/auth/deposit',
        {
          method: 'POST',
          headers,
          body: payload,
        },
      );
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      const code = json?.error_code;
      if (code === 'DEPOSIT_ALREADY_CREDITED') return json;
      if (!DEPOSIT_RETRYABLE.has(code) || i === 6) {
        throw new Error(
          `/auth/deposit -> ${res.status} ${JSON.stringify(json)}`,
        );
      }
      progress(`deposit not confirmed (${code}); retry ${i + 1}/6 in 5s ...`);
      await sleep(5000);
    }
  }

  // ── provision ──────────────────────────────────────────────────────────
  const { networks } = await api('/auth/deposit-info', { method: 'GET' });
  const net = networks.find((n) => n.slug === NETWORK);
  if (!net?.treasury) throw new Error(`network ${NETWORK} has no treasury`);
  progress(
    `deposit-info: treasury=${net.treasury} token=${net.token.symbol} chain_id=${net.chain_id}`,
  );

  const normPk = (s) =>
    `0x${(s || '').replace(/[^0-9a-fA-F]/g, '').slice(-64)}`;
  const publicClient = createPublicClient({
    chain: CHAIN.viem,
    transport: http(RPC),
  });

  const sponsor = privateKeyToAccount(normPk(SPONSOR_PK));
  const sponsorWallet = createWalletClient({
    account: sponsor,
    chain: CHAIN.viem,
    transport: http(RPC),
  });
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({
    account,
    chain: CHAIN.viem,
    transport: http(RPC),
  });
  progress(`sponsor=${sponsor.address} ephemeral=${account.address}`);

  let nonce = await publicClient.getTransactionCount({
    address: sponsor.address,
    blockTag: 'pending',
  });
  const gasTx = await sponsorWallet.sendTransaction({
    to: account.address,
    value: parseEther(GAS_ETH),
    nonce: nonce++,
  });
  const usdcTx = await sponsorWallet.writeContract({
    address: net.token.address,
    abi: ERC20,
    functionName: 'transfer',
    args: [account.address, parseUnits(AMOUNT, net.token.decimals)],
    nonce: nonce++,
  });
  await Promise.all([
    publicClient.waitForTransactionReceipt({ hash: gasTx }),
    publicClient.waitForTransactionReceipt({ hash: usdcTx }),
  ]);
  progress(
    `ephemeral funded (gas=${gasTx.slice(0, 12)}... usdc=${usdcTx.slice(0, 12)}...)`,
  );

  const { key, key_id } = await api('/auth/agent-signup', {
    body: { owner_ref: OWNER_REF, display_name: 'downstream x402 smoke' },
  });
  progress(`agent key: key_id=${key_id}`);

  const signature = await account.signMessage({
    message: `WASIAI_BIND_FUNDING_WALLET:${key_id}`,
  });
  await api('/auth/funding-wallet', {
    key,
    body: { wallet: account.address, signature },
  });
  progress('funding wallet bound');

  const amount = parseUnits(AMOUNT, net.token.decimals);
  const txHash = await wallet.writeContract({
    address: net.token.address,
    abi: ERC20,
    functionName: 'transfer',
    args: [net.treasury, amount],
  });
  progress(`${AMOUNT} ${net.token.symbol} -> treasury tx=${txHash}`);
  await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: net.min_confirmations,
  });
  const dep = await depositWithRetry({
    key,
    key_id,
    tx_hash: txHash,
    chain_id: net.chain_id,
  });
  progress(`budget credited: ${JSON.stringify(dep)}`);

  // ── discover + compose ───────────────────────────────────────────────────
  const disc = await api('/discover', {
    key,
    chain: CHAIN_HEADER,
    body: { q: GOAL },
  });
  const agents = disc.agents ?? disc.results ?? [];
  const targetAgent =
    agents.find((a) => a.payment?.chain === NETWORK) ?? agents[0];
  if (!targetAgent) throw new Error(`no agents for q="${GOAL}"`);
  progress(
    `discover q="${GOAL}" -> ${targetAgent.slug} (registry=${targetAgent.registry_id})`,
  );

  progress(
    `compose ${targetAgent.slug} (debits budget + downstream payout via facilitator) ...`,
  );
  const composed = await api('/compose', {
    key,
    chain: CHAIN_HEADER,
    body: {
      steps: [
        {
          agent: targetAgent.slug,
          registry: targetAgent.registry_id,
          input: {},
        },
      ],
    },
  });

  const steps = composed.steps ?? [];
  const dtx = steps.map((s) => s.downstreamTxHash).filter(Boolean);
  if (dtx.length === 0) {
    throw new Error(
      `no downstreamTxHash in /compose response (payout did not fire). step txHashes=${JSON.stringify(steps.map((s) => s.txHash))}`,
    );
  }
  for (const h of dtx) {
    progress(`DOWNSTREAM SETTLED on ${NETWORK} via our facilitator. tx=${h}`);
  }
  return { network: NETWORK, downstreamTxHashes: dtx };
}

async function main() {
  // Layer 1 — always (network-only, no secrets).
  await runLightLayer();
  process.stderr.write('[smoke] light layer PASS\n');

  // AC-6 — informative, NON-blocking A2A /discover probe (never fails smoke).
  await probeA2ADiscover();

  // Layer 2 — opt-in E2E (CD-2 clean skip).
  const gate = e2eGate();
  if (!gate.run) {
    process.stdout.write(
      `SKIP: E2E layer skipped (${gate.reason}). Light layer passed.\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    '[smoke] running E2E layer (RUN_DOWNSTREAM_E2E=1, FUNDER_PK present) ...\n',
  );
  const result = await runE2ELayer();
  process.stdout.write(
    `PASS: E2E downstream settled on ${result.network} (${result.downstreamTxHashes.length} tx).\n`,
  );
  process.exit(0);
}

// Only auto-run when invoked directly (not when imported by the vitest wrapper).
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[smoke] FAIL: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
