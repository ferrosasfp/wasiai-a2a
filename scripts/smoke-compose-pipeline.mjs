#!/usr/bin/env node
/**
 * Smoke compose pipeline — simulates wasiai-a2a /compose with 2 chained agents.
 *
 * Pipeline: wasi-chainlink-price → wasi-defi-sentiment
 *
 * Goal: prove or disprove that today's pipeline can chain v2 agents end-to-end,
 * and surface every transformation/payment/protocol step so we know exactly
 * what to design next (Google A2A fast-path + LLM-bridge upgrade).
 *
 * Validates:
 *   1. Step 1 invoke (input shape, x402 settle on Fuji, output shape)
 *   2. Output → input compatibility check (isCompatible heuristic from compose)
 *   3. LLM transform (Claude Sonnet) when incompatible — measure latency, tokens,
 *      success of generated transform fn
 *   4. Step 2 invoke with transformed input — does it really work?
 *   5. Identify Google A2A protocol presence (TaskMessage / parts / role)
 */
import {
  createPublicClient, http, parseUnits, formatUnits, defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

// ─── Config ───────────────────────────────────────────────────────────────────
const STAGING_URL = 'https://wasiai-v2.vercel.app';
const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const MARKETPLACE = '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7';
const CHAIN_ID = 43113;

const PIPELINE = [
  { slug: 'wasi-chainlink-price',  input: { token: 'AVAX' }, price: 0.001 },
  { slug: 'wasi-defi-sentiment',   input: {}, price: 0.01 },
];

// ─── env loaders ──────────────────────────────────────────────────────────────
function readEnv(p) {
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function normPk(s) {
  const hex = s.replace(/[^0-9a-fA-F]/g, '');
  return '0x' + hex.slice(-64);
}
const v2Env = readEnv('/home/ferdev/.openclaw/workspace/wasiai-v2/.env.local');
const a2aEnv = readEnv('/home/ferdev/.openclaw/workspace/wasiai-a2a/.env');
const OPERATOR_PK = normPk(v2Env.OPERATOR_PRIVATE_KEY);
const ANTHROPIC_KEY = a2aEnv.ANTHROPIC_API_KEY;

const fuji = defineChain({
  id: CHAIN_ID, name: 'Avalanche Fuji',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: ['https://api.avax-test.network/ext/bc/C/rpc'] } },
});
const operator = privateKeyToAccount(OPERATOR_PK);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── compose helpers (mirror src/services/llm/transform.ts isCompatible) ──────
function isCompatible(output, inputSchema) {
  if (!inputSchema) return true;
  if (typeof output !== 'object' || output === null) return false;
  const required = inputSchema.required;
  if (!Array.isArray(required) || required.length === 0) return true;
  const outputKeys = new Set(Object.keys(output));
  return required.every(k => typeof k === 'string' && outputKeys.has(k));
}

// Detect Google A2A protocol envelope (per https://a2a.dev — Message has role + parts)
function isA2AMessage(value) {
  if (typeof value !== 'object' || value === null) return false;
  const v = value;
  if (typeof v.role !== 'string') return false;
  if (!Array.isArray(v.parts)) return false;
  return v.parts.every(p => p && typeof p === 'object' && typeof p.kind === 'string');
}

async function invokeAgent(slug, input, price) {
  const amount = parseUnits(String(price), 6);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const nonce = '0x' + randomBytes(32).toString('hex');
  const signature = await operator.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: FUJI_USDC },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: operator.address, to: MARKETPLACE, value: amount,
      validAfter: 0n, validBefore, nonce,
    },
  });
  const payload = {
    x402Version: 2, scheme: 'exact', network: 'eip155:43113',
    payload: {
      signature,
      authorization: {
        from: operator.address, to: MARKETPLACE, value: amount.toString(),
        validAfter: '0', validBefore: validBefore.toString(), nonce,
      },
    },
  };
  const xPayment = Buffer.from(JSON.stringify(payload)).toString('base64');
  const startedAt = Date.now();
  const res = await fetch(`${STAGING_URL}/api/v1/models/${slug}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': xPayment },
    body: JSON.stringify(input),
  });
  const elapsed = Date.now() - startedAt;
  const txHashHeader = res.headers.get('X-PAYMENT-RESPONSE');
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  const txHash = body?.meta?.tx_hash ?? body?.meta?.txHash ?? null;
  return { status: res.status, body, txHash, latency_ms: elapsed };
}

async function fetchSchema(slug) {
  const res = await fetch(`${STAGING_URL}/api/v1/capabilities?limit=50`);
  const data = await res.json();
  const a = data.agents.find(a => a.slug === slug);
  return a?.input_schema ?? null;
}

async function generateTransformFn(output, schema) {
  const prompt = `You generate JS transform functions that adapt an upstream agent's output into the input shape required by a downstream agent.

UPSTREAM OUTPUT (sample, JSON):
${JSON.stringify(output, null, 2)}

DOWNSTREAM REQUIRED SCHEMA (JSON Schema-like):
${JSON.stringify(schema, null, 2)}

Return ONLY a JSON object: { "transform_fn_body": "<JS>", "explanation": "<brief>" }
where transform_fn_body is a function body executed as: new Function('output', body).
It receives 'output' (the upstream output) and returns the downstream input object.
Only reference fields that exist in OUTPUT. Never invent values.`;

  const startedAt = Date.now();
  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const elapsed = Date.now() - startedAt;
  const text = completion.content.find(c => c.type === 'text')?.text ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM did not return JSON');
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    fn_body: parsed.transform_fn_body,
    explanation: parsed.explanation,
    latency_ms: elapsed,
    tokens_in: completion.usage.input_tokens,
    tokens_out: completion.usage.output_tokens,
  };
}

function applyTransform(fnBody, output) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('output', fnBody);
  return fn(output);
}

// ─── Main pipeline ────────────────────────────────────────────────────────────
console.log('=== Smoke compose pipeline ===');
console.log(`  Operator: ${operator.address}`);
console.log(`  Pipeline: ${PIPELINE.map(s => s.slug).join(' → ')}`);

const stepResults = [];
let lastOutput = null;
let lastOutputAgent = null;

for (let i = 0; i < PIPELINE.length; i++) {
  const step = PIPELINE[i];
  const isFirst = i === 0;
  console.log(`\n━━━ Step ${i + 1}/${PIPELINE.length} ${step.slug} ━━━`);

  // 1. Build input for this step
  let input;
  if (isFirst) {
    input = step.input;
    console.log(`  input: ${JSON.stringify(input)}`);
  } else {
    // Bridge: take lastOutput → derive input for this step
    const targetSchema = await fetchSchema(step.slug);
    console.log(`  target schema required: ${JSON.stringify(targetSchema?.required ?? [])}`);

    // Detect Google A2A protocol
    const a2aProtocolDetected = isA2AMessage(lastOutput);
    console.log(`  Google A2A protocol on upstream output: ${a2aProtocolDetected ? 'YES (passthrough possible)' : 'NO'}`);

    if (isCompatible(lastOutput, targetSchema)) {
      input = lastOutput;
      console.log(`  bridge: COMPATIBLE — passthrough (no transform needed)`);
    } else {
      console.log(`  bridge: NOT compatible — calling Claude Sonnet for transform fn`);
      try {
        const t = await generateTransformFn(lastOutput, targetSchema);
        console.log(`  LLM latency: ${t.latency_ms}ms tokens_in=${t.tokens_in} tokens_out=${t.tokens_out}`);
        console.log(`  LLM explanation: ${t.explanation}`);
        console.log(`  LLM fn body (first 200): ${t.fn_body.slice(0, 200)}…`);
        input = applyTransform(t.fn_body, lastOutput);
        console.log(`  transformed input: ${JSON.stringify(input).slice(0, 200)}…`);
      } catch (e) {
        console.log(`  ✗ LLM transform failed: ${e.message}`);
        input = step.input ?? {};
      }
    }
  }

  // 2. Invoke
  const res = await invokeAgent(step.slug, input, step.price);
  console.log(`  HTTP ${res.status} ${res.latency_ms}ms tx=${res.txHash ?? '(no tx)'}`);
  if (res.status !== 200) {
    console.log(`  body: ${JSON.stringify(res.body).slice(0, 280)}`);
  }
  // The marketplace wraps the agent output as { result: ..., meta: {...} }
  const upstreamPayload = res.body?.result ?? res.body;
  console.log(`  upstream output keys: ${Object.keys(upstreamPayload || {}).slice(0, 12).join(', ')}`);
  console.log(`  upstream output sample (first 240): ${JSON.stringify(upstreamPayload).slice(0, 240)}…`);

  stepResults.push({ slug: step.slug, status: res.status, txHash: res.txHash, latency_ms: res.latency_ms });
  lastOutput = upstreamPayload;
  lastOutputAgent = step.slug;
}

console.log('\n\n═══════════════════════════════════════');
console.log('PIPELINE SUMMARY');
console.log('═══════════════════════════════════════');
for (const r of stepResults) {
  const ok = r.status === 200 ? '✓' : '✗';
  console.log(`${ok} ${r.slug.padEnd(28)} HTTP ${r.status} ${r.latency_ms}ms ${r.txHash ?? '(no tx)'}`);
}
console.log(`\nResult: ${stepResults.every(r => r.status === 200) ? '✅ pipeline OK end-to-end' : '⚠ pipeline did not complete'}`);
