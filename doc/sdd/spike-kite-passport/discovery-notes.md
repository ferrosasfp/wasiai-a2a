# WKH-68 Spike — Discovery Notes (Phase 1)

**Spike**: Kite Passport integration evaluation
**Status**: ⚠️ Phase 1 partial · Phase 2 UNBLOCKED (CLI public)
**Date opened**: 2026-05-01
**Owner**: Fernando Rosas
**Source ticket**: https://ferrosasfp.atlassian.net/browse/WKH-68

---

## Discovery 1 — 2026-05-01 (initial)

The CTA `Open Passport` at https://agentpassport.ai/ resolves to a **waitlist/survey gate**. Initial assumption: Passport is not publicly accessible. Status was BLOCKED.

## Discovery 2 — 2026-05-01 (corrected, gold)

`https://agentpassport.ai/quickstart/` is **fully self-serve and public**. The waitlist gate appears to be for the **hosted dashboard onboarding**, not the CLI/SDK. **Phase 2 (POC) is UNBLOCKED.**

### Public surface area available today

| Resource | Path / command | Notes |
|----------|----------------|-------|
| CLI installer | `curl -fsSL https://agentpassport.ai/install.sh \| bash` | bash, redirects to `cli.gokite.ai/install.sh` |
| Binary | `kpass` | no version pinned in docs |
| Skills catalog | `https://skills.sh` | `npx skills add kite/passport-skills/<name>` |
| Approval flow | `https://app.gokite.ai/approve/<request_id>` | human-in-the-loop session approval |
| Faucet (testnet) | `kpass faucet drop --recipient ... --token USDC` | confirms testnet exists |
| Feedback form | `https://kiteai.typeform.com/kpass-feedback` | — |
| Dashboard | `https://agentpassport.ai/dashboard` | likely waitlist-gated |

### Skills available (verbatim from docs)

```
kite/passport-skills/authenticate-user
kite/passport-skills/request-session
kite/passport-skills/x402-execute
kite/passport-skills/wallet-send
kite/passport-skills/manage-agents
kite/passport-skills/activity
kite/passport-skills/shopping
```

### Auth flow

1. `kpass signup init --email <email>` → email verification link
2. Poll `kpass signup poll --signup-id <id> --wait`
3. Exchange `kpass signup exchange --signup-id <id> --exchange-token <token>` → JWT stored at `~/.kite-passport/config.json`
4. Re-auth: `kpass login init` + `kpass login verify --login-id <id> --code <8-char-code>`

**Passwordless email-based, no passkey biometric required at CLI level** (passkey may apply at hosted dashboard).

### Agent registration

```
kpass agent:register --type <type> --output json
```
Stores agent credentials at `~/.kite-passport/agent.json`. After session approval, `current_session_id` is also persisted there.

### Session creation API

```
kpass agent:session create \
  --task-summary 'General spending session' \
  --max-amount-per-tx 2 \
  --max-total-amount 10 \
  --ttl 2h \
  --assets USDC \
  --output json
```

Response shape:
```json
{
  "request_id":   "agent_session_req_<uuid>",
  "approval_url": "https://app.gokite.ai/approve/<request_id>",
  "expires_at":   "<ISO8601>",
  "next_command": "kpass agent:session status --request-id <id> --wait --output json",
  "status":       "human_action_required"
}
```

| Param | Type | Note |
|-------|------|------|
| `--task-summary` | string | Plain-English description on approval page |
| `--max-amount-per-tx` | decimal | Hard ceiling per single tx |
| `--max-total-amount` | decimal | Total session budget (optional) |
| `--ttl` | duration | `90s`, `30m`, `24h`, `7d` |
| `--assets` | CSV | e.g. `USDC,KITE` (optional) |

### x402 execution

```
kpass agent:session execute \
  --url <merchant_url> \
  --method POST \
  --body '<json>' \
  --output json
```

Behavior (verbatim):
> "Paid APIs return `HTTP 402`. Passport negotiates payment, posts it on the Kite chain, and relays the 200 response back to your agent."

This is **native x402** — no manual signing.

### Network / chain

- **Mainnet only in examples**: chain ID 2366
- Wallet balance returns `chain_id: 2366` and `KITE` as native + `USDC`
- **Hard warning**: *"Send only on Kite chain (ID 2366). Funds sent on Ethereum, Base, Arbitrum, Solana, or any other network … will be lost."*

### Stablecoin

- **USDC** (primary in all examples)
- **KITE** (native asset, secondary)
- **No mention of PYUSD** in mainnet quickstart. PYUSD remains canonical for **testnet 2368** in our stack but not in Passport docs.

### What is NOT mentioned

- ❌ Cross-chain settlement (Avalanche, etc.)
- ❌ EIP-3009 / EIP-712 explicitly (likely used internally, not exposed)
- ❌ MCP integration
- ❌ Public GitHub repo for Passport
- ❌ Node/TypeScript SDK (CLI is the only programmatic surface)
- ❌ Bearer token / JWT format for agent → session auth (only documents that creds are stored in agent.json)

---

## Architectural mismatches with WasiAI A2A

### 1. Cross-chain — fundamental delta

| WasiAI A2A | Kite Passport |
|------------|---------------|
| Pay-once-Kite, settle-N-Avalanche cross-chain | Single-chain Kite only |

**Implication**: If a user funds via Passport, funds stay on Kite. To preserve the cross-chain value prop, the architecture must be:

```
User (Passport session, USDC on Kite mainnet)
  ↓ pays once via x402 to wasiai-a2a
WasiAI A2A (orchestrator)
  ↓ uses OPERATOR_PRIVATE_KEY (or migrated wallet) to settle outbound
N downstream agents (Avalanche mainnet USDC)
```

This is **Model B — Hybrid**. Passport authorizes the user-side inbound; operator wallet (or future bridge) does the cross-chain outbound.

### 2. Stablecoin canonical — narrative shift

Our HACKATHON-FINAL says PYUSD is canonical Kite stablecoin. Passport docs use USDC + KITE in mainnet examples. PYUSD probably exists in 2366 too (Kite ↔ PayPal partnership), but it's NOT what Passport surfaces by default.

**Action**: verify with Salvador whether PYUSD is preferred or USDC. The pitch may need update if USDC is the canonical Passport asset.

### 3. SDK shape — CLI vs Node

No Node/TS SDK. Two integration paths:
- **A**: Wrap `kpass` as subprocess from `wasiai-a2a` Node code (clunky but viable)
- **B**: Expose `kpass agent:session execute` as a tool inside `wasiai-x402` MCP server. Cleaner — managed agents call it like any other tool.

Option B aligns with our existing MCP architecture and is the recommended POC path.

---

## Updated phase plan

| Phase | Status | Action |
|-------|--------|--------|
| 1 — Discovery (docs + waitlist) | ✅ done | This file + decision-doc draft |
| 2 — POC code | 🟢 unblocked | Branch `spike/kite-passport-integration` — install `kpass`, signup with test email, register agent, create test session, run `agent:session execute` against a sandbox 402 endpoint |
| 3 — Decision doc | ⏳ pending | Write `decision-doc.md` with Model A/B/C recommendation backed by POC findings |

---

## Open questions still to resolve in POC

1. Is there a sandbox/testnet for Passport CLI? `kpass faucet drop --token USDC` suggests yes, but chain ID not named in docs.
2. Does `kpass agent:session execute` honor any HTTP merchant or only Kite-network 402 endpoints? (cross-merchant compatibility critical for multi-marketplace discovery)
3. Can a single Passport session approve multiple `agent:session execute` calls within budget, or one-shot per session?
4. What happens if the 402 challenge points to an asset other than the session `--assets`?
5. Is JWT exportable for use from a Node service, or is it CLI-bound (file path only)?
6. Are session-budget-spent receipts onchain (verifiable) or off-chain (Passport API-only)?

---

## Decision criteria preview (full doc TBD)

| Model | Description | Pros | Cons | Hackathon impact |
|-------|-------------|------|------|------------------|
| **A — Replace** | Drop OPERATOR_PRIVATE_KEY entirely, all flows go through Passport sessions | Multi-tenant, user-funded, Kite-native | Loses cross-chain value prop, single-chain forced, requires CLI subprocess or skip Node SDK | Deal-breaker for current pitch |
| **B — Hybrid** | Passport handles user → orchestrator inbound; operator wallet handles outbound cross-chain | Preserves cross-chain narrative, multi-tenant for inbound, real Kite mainnet integration | Complexity, two settlement paths to maintain | Strong fit — recommended |
| **C — Decline** | Document why Passport doesn't fit and stay with current model | No work | Misses major mainnet ecosystem alignment | Defensible only if Salvador prioritizes shipping current state over Passport sync |

**Tentative recommendation**: **B — Hybrid**, with POC validating the inbound x402 flow via `kpass`.

---

## Files

- This file: `doc/sdd/spike-kite-passport/discovery-notes.md`
- Pending: `doc/sdd/spike-kite-passport/decision-doc.md`
- Pending: branch `spike/kite-passport-integration` from `main` HEAD

## References

- Passport home: https://agentpassport.ai/
- Quickstart: https://agentpassport.ai/quickstart/
- Hosted approve: https://app.gokite.ai/approve/<request_id>
- Skills catalog: https://skills.sh
- CLI installer: https://agentpassport.ai/install.sh (redirects to cli.gokite.ai)
- Kite mainnet launch context: https://www.avax.network/about/blog/1-9-billion-interactions-later-it-goes-live
- WKH-68 ticket: https://ferrosasfp.atlassian.net/browse/WKH-68
