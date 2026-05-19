# Base Integration Guide — wasiai-a2a

> Five-minute integration of WasiAI A2A on **Base Sepolia** (chainId 84532) and **Base Mainnet** (chainId 8453). Target audience: backend engineers building x402-paid agents on the Coinbase Base ecosystem.

**Production gateway:** `https://wasiai-a2a-production.up.railway.app`
**Self-hosted facilitator:** `https://wasiai-facilitator-production.up.railway.app`
**Onchain proof:** see [`BASE-EVIDENCE.md`](BASE-EVIDENCE.md) — three verifiable Base Sepolia `transferWithAuthorization` transactions, total 0.016 USDC, all SUCCESS on 2026-05-19.

> **Dependency note**: This guide assumes BASE-01..04 (`WKH-104`..`WKH-107`) have been deployed on the target environment. Check the **Production Status** table in the root `README.md` before running the quick start. The Base Sepolia adapter ships **active (env-gated)**; Base Mainnet ships **staged (env-gated)** — no mainnet money is moved until the operator opts in.

---

## 1. Quick Start (5 min)

You will end with an HTTP 200 (key) or HTTP 402 (x402 challenge) from the gateway with `network: eip155:84532` in the body — the on-the-wire proof that your call landed on Base Sepolia.

### Step 1 — Clone `.env`

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a
cp .env.example .env
```

### Step 2 — Set three Base env vars

```bash
# .env
WASIAI_A2A_CHAINS=kite-ozone-testnet,base-sepolia   # add base-sepolia to the CSV
BASE_NETWORK=testnet                                # 'testnet' = chain 84532, 'mainnet' = 8453
BASE_TESTNET_RPC_URL=https://sepolia.base.org       # public RPC; swap for Alchemy/Infura if needed
```

The defaults for `BASE_SEPOLIA_USDC_ADDRESS` (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) and `BASE_SEPOLIA_USDC_EIP712_VERSION` (`"2"`) are already canonical — leave them blank unless you have a reason. See `.env.example` for the full Base block.

### Step 3 — Register a wasi_a2a key (one-time)

```bash
A2A=https://wasiai-a2a-production.up.railway.app
curl -X POST "$A2A/auth/agent-signup" \
  -H "Content-Type: application/json" \
  -d '{"owner_ref":"base-demo","display_name":"Base Demo"}'
# 201 → { "key": "wasi_a2a_...", "key_id": "uuid..." }
export A2A_KEY="wasi_a2a_..."
```

### Step 4 — Call `/compose` with `x-payment-chain: base-sepolia`

```bash
curl -X POST "$A2A/compose" \
  -H "Content-Type: application/json" \
  -H "x-a2a-key: $A2A_KEY" \
  -H "x-payment-chain: base-sepolia" \
  -d '{"pipeline":[{"agentSlug":"example-agent","input":{"q":"hello"}}]}'
```

Expected response: HTTP 200 (key-funded) or HTTP 402 (`accepts[].network == "eip155:84532"`).

### Step 5 — Verify chain selection (logs)

The gateway logs a single line per Base request — grep it in production:

```
[Compose] Base settle facilitator selector — chainKey=base-sepolia selected=<URL> cdpEnvSet=<bool>
```

That's your confirmation the call hit the Base adapter, not Kite/Avalanche.

---

## 2. Network Config

### Chain identifiers

| Network | chainId (numeric) | A2A slug | CAIP-2 `network` |
|---|---|---|---|
| Base Sepolia | `84532` | `base-sepolia` | `eip155:84532` |
| Base Mainnet | `8453` | `base-mainnet` | `eip155:8453` |

### USDC contracts

| Network | USDC address | Source |
|---|---|---|
| Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | [Circle USDC test deployments](https://developers.circle.com/stablecoins/usdc-on-test-networks) |
| Base Mainnet | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | [Circle USDC production](https://www.circle.com/multi-chain-usdc) |

Both contracts implement EIP-3009 `transferWithAuthorization` with EIP-712 domain `name="USDC"`, `version="2"` — verified onchain by WKH-105.

### RPCs (env vars)

| Env var | Default (public) | Mainnet equivalent |
|---|---|---|
| `BASE_TESTNET_RPC_URL` | `https://sepolia.base.org` | — |
| `BASE_MAINNET_RPC_URL` | `https://mainnet.base.org` | required when `BASE_NETWORK=mainnet` |

Use a paid RPC (Alchemy, Infura, QuickNode) in production. Public endpoints throttle aggressively under load.

### Explorers

- Base Sepolia: https://sepolia.basescan.org
- Base Mainnet: https://basescan.org

---

## 3. Integration Patterns

### Pattern A — Base-only

A marketplace or single-purpose agent that settles exclusively on Base. Set `WASIAI_A2A_CHAINS=base-sepolia` (or `base-mainnet`) — single entry. Every `/compose` and `/orchestrate` call resolves to Base; no per-request header needed.

```bash
WASIAI_A2A_CHAINS=base-sepolia
BASE_NETWORK=testnet
```

### Pattern B — Multi-chain (Base + Avalanche + Kite)

The default production posture today. The gateway runs all enabled bundles simultaneously; the caller picks the chain per request via the `x-payment-chain` header.

```bash
WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji,base-sepolia
# (mainnet equivalent: kite-mainnet,avalanche-mainnet,base-mainnet)
```

Per-request selection:

```bash
curl ... -H "x-payment-chain: base-sepolia"      # routes to Base
curl ... -H "x-payment-chain: 84532"             # same, numeric chainId form
curl ... -H "x-payment-chain: avalanche-fuji"    # routes to Avalanche
# No header → first entry in WASIAI_A2A_CHAINS wins
```

See [`architecture/MULTI-CHAIN.md`](architecture/MULTI-CHAIN.md) for the alias table and resolution priority.

### Pattern C — Pre-funded keys vs x402-per-call on Base

Both auth paths from the root README work unchanged on Base:

- **`wasi_a2a_*` key**: pre-fund the key's Base budget; gateway debits per call.
- **x402 EIP-3009**: sign a `TransferWithAuthorization` envelope per call; facilitator verifies + settles. Domain is `{ name:"USDC", version:"2", chainId:84532, verifyingContract:<USDC> }` — identical shape for mainnet (chainId 8453).

The signature you build for Base is **the same shape** the production Base Sepolia evidence runs used. See [`BASE-EVIDENCE.md`](BASE-EVIDENCE.md) tx hashes for a verifiable example.

---

## 4. Facilitator Selection Guide

Two facilitators can verify+settle the same EIP-3009 envelope on Base. They are interchangeable from the protocol's perspective — pick by operational fit.

| Criterio | CDP Facilitator (Coinbase) | wasiai-facilitator (self-hosted) |
|---|---|---|
| **Self-custody of settlement** | No — Coinbase signs the settle tx | Yes — your `OPERATOR_PRIVATE_KEY` signs |
| **Dependency on Coinbase API** | Hard dependency on `https://x402.org/facilitator` | None — runs in your Railway/Fly/AWS |
| **Mainnet readiness today** | Production-ready (Coinbase-hosted) | Production-ready, env-gated, requires you to fund the operator wallet |
| **Cost per tx (USDC gas)** | Coinbase pays gas (consumer-facing) | Operator pays gas in ETH on Base |
| **Latency (mainnet typical)** | Higher tail (shared infra) | Lower median (single-tenant), tail depends on your RPC |
| **Bazaar discovery** | Yes — auto-indexes `discoverable: true` agents in Agentic.Market | No — requires CDP for Bazaar indexing (see [Section 5](#5-appear-on-agenticmarket)) |
| **When to use** | You want Agentic.Market discovery + don't need self-custody of the settle path | You need self-custody, predictable cost, or are running other chains (Kite/Avalanche) through the same facilitator |

### Selector wiring

The Base adapter resolves the facilitator URL in this exact order (`src/adapters/base/payment.ts`):

1. `BASE_FACILITATOR_URL` — absolute override, used for testing.
2. `CDP_FACILITATOR_URL` — set this to `https://x402.org/facilitator` to route Base settles through CDP and enable Bazaar discovery.
3. `WASIAI_FACILITATOR_URL` — shared with Avalanche.
4. Hardcoded fallback `https://wasiai-facilitator-production.up.railway.app`.

The selector is **Base-only** — Kite and Avalanche settles never go through `CDP_FACILITATOR_URL`. See WKH-106 for the implementation.

---

## 5. Appear on Agentic.Market

Three steps. Same flow as the root README's "Publishing your agent to Agentic.Market" section, scoped to Base.

### Step 1 — Opt in via your agent manifest

In the registry that hosts your agent, set `metadata.discoverable = true` (literal boolean — strings like `"true"` do NOT trigger opt-in by design), declare `inputSchema` and `outputSchema` as JSON Schema objects, and declare a Base payment chain:

```json
{
  "slug": "weather-oracle",
  "name": "Weather Oracle",
  "priceUsdc": 0.01,
  "payment": {
    "method": "x402",
    "chain": "base-mainnet",
    "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },
  "metadata": {
    "discoverable": true,
    "inputSchema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] },
    "outputSchema": { "type": "object", "properties": { "temperature": { "type": "number" } } }
  }
}
```

### Step 2 — Verify the agent card

```bash
curl "$A2A/agents/weather-oracle/agent-card" | jq '.skills[0] | {inputSchema, outputSchema}'
```

Schemas must appear in the response. If they don't, either `discoverable` is missing/non-literal or the schemas failed AJV validation — in the latter case you'll get HTTP 422 with `error_code: "BAZAAR_SCHEMA_INVALID"` and the offending field.

### Step 3 — Route Base settles through the CDP Facilitator

Set on the gateway deployment that handles your Base traffic:

```bash
CDP_FACILITATOR_URL=https://x402.org/facilitator
```

On the next `/compose` or `/orchestrate` settle that targets a Base chain, the gateway routes the settle through CDP. CDP extracts the discovery extension and indexes your agent in the Bazaar catalog. The selector is Base-only — Kite + Avalanche traffic is unaffected (CD-5 of WKH-106).

---

## Related documentation

- Root README → [`../README.md`](../README.md) (entry point, hackathon submission, full env var reference)
- General marketplace integration guide → [`INTEGRATION.md`](INTEGRATION.md) (chain-agnostic)
- Architecture (L1..L4 + adapter pattern) → [`architecture/CHAIN-ADAPTIVE.md`](architecture/CHAIN-ADAPTIVE.md)
- Multi-chain registry → [`architecture/MULTI-CHAIN.md`](architecture/MULTI-CHAIN.md)
- Onchain proof (Base Sepolia) → [`BASE-EVIDENCE.md`](BASE-EVIDENCE.md)
