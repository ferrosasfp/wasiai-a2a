#!/usr/bin/env tsx
/**
 * WasiAI-a2a — Agente económico AUTÓNOMO de referencia (WKH-105).
 * ================================================================
 * Dado una funding wallet (private key) + un goal, corre el ciclo de vida
 * completo SIN intervención humana usando `@wasiai/agent-sdk`:
 *
 *   provision → mintIdentity (gated) → operate (paga budget) → getReputation
 *
 * Importa el SDK por SOURCE PATH (DT-9, NodeNext) — NO requiere build previo.
 * Se corre con `tsx`. Todo entra por env (DT-3, defaults degradables).
 *
 *   A2A_BASE=https://wasiai-a2a-production.up.railway.app \
 *   FUNDER_PK=0x<tu-private-key> NETWORK=base-sepolia \
 *   npx tsx examples/autonomous-agent.ts
 *
 * Anti-leak (AC-10/CD-5): la PK, la Agent Key y err.cause NUNCA se imprimen.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { WasiAgent } from '../packages/agent-sdk/src/index.js';

// ── Env (DT-3) ────────────────────────────────────────────────
const A2A_BASE =
  process.env.A2A_BASE ?? 'https://wasiai-a2a-production.up.railway.app';
const NETWORK = process.env.NETWORK ?? 'base-sepolia';

const RPC_DEFAULTS: Record<string, string> = {
  'base-sepolia': 'https://sepolia.base.org',
  'avalanche-fuji': 'https://api.avax-test.network/ext/bc/C/rpc',
};
const CHAIN_ID_DEFAULTS: Record<string, number> = {
  'base-sepolia': 84532,
  'avalanche-fuji': 43113,
};

const RPC_URL = process.env.RPC_URL ?? RPC_DEFAULTS[NETWORK] ?? '';
const CHAIN_ID = process.env.CHAIN_ID
  ? Number(process.env.CHAIN_ID)
  : (CHAIN_ID_DEFAULTS[NETWORK] ?? Number.NaN);

const FUNDER_PK = process.env.FUNDER_PK;
const AMOUNT = process.env.AMOUNT ?? '1.0';
const OWNER_REF = process.env.OWNER_REF ?? 'autonomous-agent-demo';
const GOAL = process.env.GOAL ?? 'summarize text';

const ENABLE_IDENTITY_MINT = process.env.ENABLE_IDENTITY_MINT === 'true';
const ERC8004_REGISTRY_ADDRESS = process.env.ERC8004_REGISTRY_ADDRESS as
  | `0x${string}`
  | undefined;
const MAX_AGENT_BUDGET_USD = process.env.MAX_AGENT_BUDGET_USD
  ? Number(process.env.MAX_AGENT_BUDGET_USD)
  : undefined;

if (!FUNDER_PK) {
  console.error('Falta FUNDER_PK (la private key de tu funding wallet).');
  process.exit(1);
}
if (!RPC_URL || !Number.isFinite(CHAIN_ID)) {
  console.error(
    `Sin RPC_URL/CHAIN_ID para network '${NETWORK}'. Seteá RPC_URL y CHAIN_ID.`,
  );
  process.exit(1);
}

// Acepta la PK con o sin '0x' / espacios; toma los últimos 64 hex.
const normPk = (s: string): `0x${string}` =>
  `0x${(s || '').replace(/[^0-9a-fA-F]/g, '').slice(-64)}`;
const account = privateKeyToAccount(normPk(FUNDER_PK));

const agent = new WasiAgent(account, {
  a2aBase: A2A_BASE,
  network: NETWORK,
  rpcUrl: RPC_URL,
  chainId: CHAIN_ID,
  enableIdentityMint: ENABLE_IDENTITY_MINT,
  identityRegistryAddress: ERC8004_REGISTRY_ADDRESS,
  maxAgentBudgetUsd: MAX_AGENT_BUDGET_USD,
});

async function main(): Promise<void> {
  console.log(`0. agent: ${agent.toString()}`);

  // 1. provision (NUNCA imprimir key/PK)
  const prov = await agent.provision({ ownerRef: OWNER_REF, amount: AMOUNT });
  console.log(
    `1. provisioned keyId=${prov.keyId} balance=${prov.balance} chain=${prov.chainId} tx=${prov.txHash}`,
  );

  // 2. mintIdentity (gated)
  const mint = await agent.mintIdentity();
  if (mint.skipped) {
    console.log(
      'IDENTITY_SKIP: mint disabled (set ENABLE_IDENTITY_MINT=true + ERC8004_REGISTRY_ADDRESS)',
    );
  } else {
    console.log(`2. minted tokenId=${mint.tokenId} mintTx=${mint.mintTxHash}`);
  }

  // 3. operate (paga budget)
  const op = await agent.operate({ goal: GOAL });
  if (!op.operated) {
    console.log(`OPERATE_SKIP: ${op.reason}`);
    process.exit(0);
  }
  console.log(`3. operated agent=${op.agentSlug} tx=${op.kiteTxHash}`);

  // 4. reputation (solo si operó)
  if (op.agentSlug) {
    const rep = await agent.getReputation({ agentSlug: op.agentSlug });
    console.log(`4. reputation=${JSON.stringify(rep)}`);
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  // AC-10: anti-leak — NUNCA imprimir account, key, err.cause ni el agente.
  const e = err as { step?: string; code?: string; message?: string };
  console.error(
    `STEP_FAILED step=${e.step ?? e.code ?? '?'} code=${e.code ?? '?'} message=${e.message ?? '?'}`,
  );
  process.exit(1);
});
