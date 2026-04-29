# Mainnet Activation Runbook

**Status**: 📋 Staged — config in code, not yet activated
**Decision required**: Fernando + ops decision on RPC providers, monitoring, on-call rotation
**Estimated cost (first month)**: ~$30-50 USDC (operator wallet + a2a operations)

---

## Pre-flight checklist

Before activating mainnet, ALL of these must be true:

- [ ] **Operator wallet funded**:
  - [ ] Avalanche C-Chain mainnet: ≥10 USDC (Circle native, contract `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`)
  - [ ] Avalanche C-Chain mainnet: ≥0.1 AVAX (gas)
  - [ ] Kite mainnet: ≥10 USDC.e (`0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`)
  - [ ] Kite mainnet: ≥0.1 KITE (gas)
- [ ] **RPC provider chosen**:
  - [ ] Avalanche: official `https://api.avax.network/ext/bc/C/rpc` OR Infura/Alchemy/Quicknode endpoint with API key
  - [ ] Kite mainnet: `https://rpc.gokite.ai/` (single official RPC at time of writing)
- [ ] **Monitoring**:
  - [ ] Operator wallet balance alerts (low balance ≤ 5 USDC threshold)
  - [ ] Facilitator circuit breaker alerts (any state != CLOSED)
  - [ ] Latency p95 alerts (>40s for compose, >35s for orchestrate)
- [ ] **Code review**:
  - [ ] PR `feat/068-mainnet-support-kite-avalanche` (a2a) — merged
  - [ ] PR `feat/mainnet-support-kite-avalanche` (facilitator) — merged
- [ ] **Backup operator wallet**:
  - [ ] Secondary wallet with same funding (in case primary key rotation needed mid-incident)
- [ ] **Hackathon judges informed** (if applicable):
  - [ ] Mainnet activation date
  - [ ] How to verify on KiteScan + Snowtrace mainnet explorers

---

## Activation sequence

### Step 1 — Activate Avalanche mainnet (downstream USDC outbound)

```bash
RAILWAY_TOKEN=<a2a-railway-token>

# Set on wasiai-a2a-production service
curl -X POST "https://backboard.railway.app/graphql/v2" \
  -H "Project-Access-Token: $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation($i: VariableUpsertInput!) { variableUpsert(input: $i) }",
    "variables": {
      "i": {
        "projectId": "cc694c84-059f-4116-9c31-cb6085e5e79e",
        "environmentId": "a867039e-abc1-4317-aaa9-7409976ad250",
        "serviceId": "27af4db1-9a73-41da-8e12-c2aa6838e52e",
        "name": "WASIAI_DOWNSTREAM_NETWORK",
        "value": "avalanche-mainnet"
      }
    }
  }'
```

Wait Railway redeploy (~2-3min). Verify:

```bash
curl https://wasiai-a2a-production.up.railway.app/health
# { "status": "ok", "version": "0.1.0", ... }
```

### Step 2 — Activate Kite mainnet inbound

```bash
# Same pattern, set:
KITE_NETWORK=mainnet
```

Verify the 402 challenge now references USDC.e on Kite mainnet:

```bash
curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
  -H "Content-Type: application/json" -d '{"steps":[]}'

# Expected response shape:
# {
#   "accepts": [{
#     "network": "eip155:2366",          ← mainnet chain
#     "asset": "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",  ← USDC.e
#     ...
#   }]
# }
```

### Step 3 — Activate facilitator mainnet chains

```bash
FAC_TOKEN=<facilitator-railway-token>

# Set 4 vars on wasiai-facilitator service
for var in \
  "KITE_MAINNET_ENABLED:true" \
  "AVALANCHE_MAINNET_ENABLED:true" \
  "KITE_MAINNET_RPC_URL:https://rpc.gokite.ai/" \
  "AVALANCHE_MAINNET_RPC_URL:https://api.avax.network/ext/bc/C/rpc"; do
  KEY=$(echo $var | cut -d: -f1)
  VAL=$(echo $var | cut -d: -f2-)
  # variableUpsert API call — same pattern as Step 1
done
```

Verify `/supported` now lists 4 chains:

```bash
curl https://wasiai-facilitator-production.up.railway.app/supported

# Expected:
# {
#   "chains": [
#     {"network": "eip155:2368",  "name": "Kite Testnet",   "breakerState": "CLOSED"},
#     {"network": "eip155:43113", "name": "Avalanche Fuji", "breakerState": "CLOSED"},
#     {"network": "eip155:2366",  "name": "Kite Mainnet",   "breakerState": "CLOSED"},   ← NEW
#     {"network": "eip155:43114", "name": "Avalanche",      "breakerState": "CLOSED"}    ← NEW
#   ]
# }
```

### Step 4 — Verify v2 marketplace agent registrations

The `agents` table in `caldzjhjgctpgodldqav` has agents registered with their `payment.contract` (USDC contract) and `payment.chain`. For mainnet support:

```sql
-- Check current agent payment configs
SELECT slug, payment->>'chain', payment->>'contract'
FROM agents
WHERE status = 'active'
  AND ((payment->>'chain') = 'avalanche-fuji'
       OR (payment->>'chain') = 'avalanche-mainnet');
```

If agents are still pointing to Fuji testnet, decide:
- **Option A**: keep agents on Fuji testnet, only switch operator path to mainnet (mismatched — won't work)
- **Option B**: re-register agents on mainnet (creator action via v2 dashboard)

Likely **Option B**: each agent creator must update their agent's `payment.chain` and contract via v2 marketplace UI.

### Step 5 — Smoke real-money

```bash
# Run smoke with low budget (~$0.10)
A2A_URL=https://app.wasiai.io/api/v1 node scripts/smoke-prod-via-app-wasiai.mjs

# Verify on snowtrace (mainnet, NOT testnet):
# https://snowtrace.io/tx/<hash>
# https://kitescan.ai/tx/<hash>   (Kite mainnet — confirm correct explorer URL)
```

Expected: 4 onchain txs (1 Kite mainnet inbound + 3 Avalanche mainnet outbound). Latency similar to testnet (mainnet RPC may be faster due to higher TPS).

### Step 6 — Documentation update

Update `HACKATHON-FINAL.md`:
- Section "Live Demo URLs" — note mainnet explorers
- Section "Verifiable On-Chain Proofs" — add mainnet section with new txs
- Section "Mainnet readiness" — change status to "ACTIVATED 2026-MM-DD"

---

## Rollback (if mainnet activation fails)

```bash
# Single command — flip env vars back to testnet defaults
# wasiai-a2a service
WASIAI_DOWNSTREAM_NETWORK=fuji
KITE_NETWORK=testnet

# wasiai-facilitator service
KITE_MAINNET_ENABLED=false
AVALANCHE_MAINNET_ENABLED=false
```

Both services auto-redeploy in ~2-3min. System reverts to testnet-only behavior.

If problem is more severe (e.g., bug in mainnet path), the PRs are revertible:
```bash
gh pr revert <a2a-mainnet-PR>
gh pr revert <facilitator-mainnet-PR>
```

---

## Hybrid mode — testnet + mainnet simultaneously

The architecture supports running BOTH testnet and mainnet at the same time (chain allowlist permits it). Use case: test mainnet flow without disabling testnet for ongoing demo activity.

```bash
# Enable mainnet WITHOUT disabling testnet
KITE_MAINNET_ENABLED=true        # facilitator
AVALANCHE_MAINNET_ENABLED=true   # facilitator

# But on a2a, only ONE network active at a time per request
# Solution: per-request override via header (TD: future enhancement)
# For now: 2 separate Railway services if needed (a2a-testnet + a2a-mainnet)
```

**Recommendation**: do NOT run hybrid mode initially. Activate mainnet, validate, then plan multi-network architecture if business value justifies it.

---

## Monitoring post-activation

| Metric | Threshold | Source |
|--------|-----------|--------|
| Operator wallet balance USDC mainnet | > 2 USDC | Snowtrace API + cron |
| Operator wallet balance USDC.e Kite mainnet | > 2 USDC.e | KiteScan API + cron |
| Facilitator breaker state | == CLOSED for all 4 chains | `GET /supported` |
| Compose p95 latency | < 40s | Vercel logs |
| Error rate `/api/v1/compose` | < 0.5% | Vercel logs |
| 5xx from a2a → v2 | == 0 | Vercel logs |

---

## Decisions outstanding (Fernando)

1. **RPC provider for Avalanche mainnet** — official endpoint (free, rate-limited) vs paid (Infura/Alchemy/Quicknode). For demo: official is fine. For production traffic: paid recommended.
2. **Smart contract for protocol fees on mainnet** — currently fees go to operator wallet. Consider deploying a multi-sig + fee splitter for transparency.
3. **MCP mainnet** — current `mcp` flag is OFF in `V2_DELEGATE_TO_A2A`. Decide whether to delegate MCP via proxy (breaks Claude Desktop) or keep legacy.
4. **Agent re-registration** — coordinate with creators to update agent `payment.chain` from `avalanche-fuji` to `avalanche-mainnet`.
5. **Pricing strategy** — agent prices are USDC-denominated. Same nominal price on mainnet works (USDC = $1). Consider if Kite mainnet KITE-denominated pricing makes sense long-term.

---

*Generated 2026-04-28 by Claude Code autonomous prep — for Fernando's review on activation day*
