# Multi-chain `/compose` — on-chain evidence (2026-05-29)

**Claim proven:** a single `POST /compose` can charge the caller inbound on one
chain and settle outbound to multiple sub-agents **each on its own native chain**,
in one autonomous flow.

## Scenario (the investor question)
Client pays in a **Kite** marketplace → gateway orchestrates → pays one agent on
**Avalanche** and another on **Base**, each settled on its native chain → result
returned. One `/compose`, 3 chains, 2 tokens.

## Run
- Gateway: `https://wasiai-a2a-production.up.railway.app` (prod)
- Demo registry: `base-demo-agent` → `https://wasiai-base-demo-agent.vercel.app`
  (standalone, self-pay agents; `payment.contract` = gateway operator wallet, so
  each settle is a net-zero self-transfer — only gas, real on-chain proof).
- Steps: `[ { agent: avax-demo, registry: base-demo-agent }, { agent: base-demo, registry: base-demo-agent } ]`
- Inbound: EIP-3009 PYUSD on Kite testnet. `HTTP 200`, `success=true`, ~10s.

## On-chain transactions (all `status=success`)

| Leg | Chain | Token | Tx hash | Block | Explorer |
|-----|-------|-------|---------|-------|----------|
| Inbound | Kite testnet | PYUSD | `0xbbc6dbf3d85d4d96ce910f8ce792fcf60abdc84ba83236411d01693e5521aef7` | 21551832 | testnet.kitescan.ai |
| Outbound | Avalanche Fuji | USDC | `0x5532f80195dd13cbe71e0cfaf71c536cde66b6b1ac9691a7370618ee4e260868` | 55886048 | testnet.snowtrace.io |
| Outbound | Base Sepolia | USDC | `0x743ff36320b72083c3f7610415baa667a091f760689f6b5dbf3d21c809ff1b9f` | 42151460 | sepolia.basescan.org |

## What this validates
- Inbound chain is independent of outbound chain (`src/middleware/x402.ts` chain resolution).
- Outbound chain is resolved **per agent** from `agent.payment.chain`
  (`src/lib/downstream-payment.ts`) — two sub-agents in the same compose settled on
  two different chains.
- Registry-driven: the demo agents came from a third-party registry, discovered and
  invoked dynamically (`/discover` → `/compose`).

## Teardown
Temporary prod artifacts created for this proof (remove after use):
- Registry row `base-demo-agent` in prod `registries` table.
- a2a key `key_id=fd323fee-9339-442f-8f07-8f6dd6548594` (owner_ref `base-multichain-proof-2026-05-29`).
- Vercel deploy `wasiai-base-demo-agent.vercel.app`.
