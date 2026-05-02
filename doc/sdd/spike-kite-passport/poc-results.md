# WKH-68 Spike — POC Results (Phase 2 hands-on)

**Branch**: working in `/tmp/kpass-staging-poc/` (no repo branch needed for CLI experiments)
**Backends used**: prod (`passport.prod.gokite.ai`), staging (`passport.staging.gokite.ai`)
**Date**: 2026-05-01

---

## Account onboarding — both prod & staging

### Prod onboarding (chain 2366 mainnet, no faucet)

```
user_id:     user_019de709-4367-7d4f-b21f-f188b7aff8db
agent_id:    agent_019de70b-dcef-7e5b-86c4-b34c51c71205
agent_type:  orchestrator-router
wallet:      0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3
chain_id:    2366 (Kite mainnet)
balance:     0 KITE / 0 USDC
USDC contract: 0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e
```

JWT/agent token saved to `~/.openclaw/workspace/wasiai-a2a/.kite-passport/` (gitignored).

### Staging onboarding (testnet equivalent, faucet had bug)

```
user_id:     user_019de70e-ed4f-7216-a1f5-fd31b43474ab
agent_id:    agent_019de710-15c5-7154-80ee-19f81499ec05
agent_type:  orchestrator-router
wallet:      0xEB696D493339A759BEaE0d735F5aA313B8e90810
chain_id:    2366 (same, both envs report mainnet ID)
balance:     0 KITE / 0 USDC
```

JWT/agent token saved to `/tmp/kpass-staging-poc/.kite-passport/` (ephemeral).

---

## Onboarding flow (verbatim CLI commands run)

```bash
# 1. install
curl -fsSL https://agentpassport.ai/install.sh | bash      # required: jq apt-installed
# binary lands in ~/.kpass/bin/, symlinked to ~/.local/bin/

# 2. signup (prod or staging)
kpass signup init --email <email> --client agent --output json --no-interactive
# → check email → click verification link → grab 8-char code from second email
KPASS_SIGNUP_CODE=<8CHARS> kpass signup exchange --signup-id <signup_id> --output json
# → JWT saved to ./.kite-passport/config.json

# 3. agent register
kpass agent:register --type orchestrator-router --output json
# → agent token saved to ./.kite-passport/agent.json

# 4. wallet provisioned automatically (zero balance, chain 2366)
kpass wallet balance --output json
```

**Total time**: ~3 minutes per environment (excluding email arrival).

---

## Critical finding — `delegation` structure (the architectural heart)

When we run `kpass agent:session create`, Passport returns a `delegation` object that defines what the agent is allowed to do:

```json
{
  "payment_policy": {
    "allowed_payment_approaches": ["x402"],
    "assets": ["USDC"],
    "max_amount_per_tx": "0.1",
    "max_total_amount": "0.5",
    "ttl_seconds": 3600
  },
  "task": {
    "summary": "WKH-68 spike POC — wasiai-a2a orchestrator router test session"
  }
}
```

Plus session-level metadata:

```json
{
  "request_id":   "agent_session_req_019de711-8bef-7356-92e4-318e7b5a6f32",
  "approval_url": "https://passport-web.staging.gokite.ai/agent-session/approve?token=asr_...",
  "expires_at":   "2026-05-02T05:13:00.077Z",
  "public_key":   "Allhl21PZG1qIvLpjRIs4WnGgPnnQRCQOvApcE84PDh1",
  "status":       "human_action_required"
}
```

### What this delegation tells us

| Observation | Architectural implication for wasiai-a2a |
|-------------|-------------------------------------------|
| `allowed_payment_approaches: ["x402"]` | Passport speaks **only x402**. Our stack already speaks x402. Zero protocol bridging needed for inbound. |
| `assets: ["USDC"]` (no PYUSD) | Canonical Kite mainnet stablecoin via Passport is **USDC** (PYUSD remains for testnet 2368). Salvador's open question #1 effectively resolved. |
| `max_amount_per_tx`, `max_total_amount` | **Server-side enforcement** by Passport — `wasiai-a2a` does NOT need to track or enforce these. Our balance gate (WKH-67) becomes redundant for Passport-funded sessions. |
| `ttl_seconds` | Session expires server-side. No need for our own session lifecycle. |
| `public_key: "Allhl21PZG1q..."` (base58, ~32 bytes) | Each session gets its **own keypair**, distinct from the user wallet key. Likely ed25519 or similar. Stronger isolation: a leaked session key cannot drain the wallet, only spend within the policy. |
| `task.summary` | Free-form, displayed on approval page to the user. Useful for UX context. |
| `approval_url` (passkey-gated) | The **only** way to activate a session. No headless-batch approval. Multi-tenant marketplace UX must include user-facing approval links. |
| `request_id` | Polled via `kpass agent:session status --wait` to detect approval. |

---

## Architectural implications for Modelo B (Hybrid)

### What changes in our stack

**Inbound flow** (user → wasiai-a2a):

Today:
```
Client → POST /orchestrate → wasiai-a2a returns 402
       → Client signs EIP-712 TransferWithAuthorization with their PRIVATE_KEY
       → Client retries with X-PAYMENT header
```

With Passport (Modelo B):
```
Client (Passport agent) → kpass agent:session execute --url ...
                          → Passport handles the 402 negotiation
                          → Passport submits payment onchain (Kite, USDC) using session keypair
                          → Returns 200 with our orchestrator response
```

**Wasiai-a2a stays mostly unchanged**: it just receives x402 payments. The `payer` in the EIP-3009 authorization is the Passport session wallet, not an end-user wallet. Our facilitator validates the signature normally.

**Outbound flow** (wasiai-a2a → N downstream agents): **unchanged**. Operator wallet (`OPERATOR_PRIVATE_KEY`) keeps doing cross-chain settlement to Avalanche. This is the "Stripe Connect" half of the analogy — multi-party settlement that Passport doesn't address.

### What we GAIN

1. **Multi-tenant inbound** — every Passport user funds their own agent budget, no shared `OPERATOR_PRIVATE_KEY` for inbound.
2. **No onboarding friction** — users come pre-funded via Passport. No "fund this wallet first" message in our UX.
3. **Native Kite mainnet alignment** — using the canonical user wallet for the L1.
4. **Session limits enforced upstream** — our balance gate becomes belt-and-suspenders.

### What we LOSE (or accept)

1. **Cross-chain awareness on the user side** — user only knows about Kite. The fact that downstream settles on Avalanche is invisible to them. That's actually a feature, not a bug — clean abstraction.
2. **PYUSD canonical narrative** — for Passport-funded flows, the asset is USDC, not PYUSD. Marketing pivot needed: "Kite-native USDC" instead of "PYUSD".
3. **CLI-only SDK** — no Node/TS SDK from Kite. We'd either:
   - Wrap `kpass` as subprocess from `wasiai-a2a` (clunky, fragile)
   - Stay agnostic to *how* the inbound payment was made — just receive x402, don't care if user is Passport or raw EOA. **Recommended.**

---

## Friction points encountered

| # | Friction | Severity | Workaround |
|---|----------|----------|-----------|
| 1 | Installer fails without `jq` (uses convention-based fallback that 403s on S3) | Medium | `sudo apt install jq` first |
| 2 | Faucet on staging returns "missing authorization header" despite docs saying "(no auth)" | Medium (test-only) | Likely Kite-side bug. POC continued without faucet (skip x402-execute hands-on) |
| 3 | Config dir docs say `.kpass/` but actual dir is `.kite-passport/` | Low | Cosmetic docs bug |
| 4 | `--client agent` flag NOT in `next_command` hint output, but skill SKILL.md says it's mandatory — so CLI hints can be misleading | Low | Always pass `--client agent` per skill docs |
| 5 | Project-local config means switching cwd switches identity | Medium (UX) | Use a dedicated cwd per environment for testing |
| 6 | Backend env (prod/staging/dev) controls more than just URL — staging has different policies than prod, undocumented | Medium | Test in same env as production target |

---

## What was NOT validated hands-on

- ❌ `kpass agent:session execute` — needs funded wallet; faucet bug + no real money on staging
- ❌ Real x402 payment to wasiai-a2a-production — same reason
- ❌ Cross-chain outbound from a Passport-funded session — same reason
- ❌ Session approval flow — depends on user clicking the approval URL with passkey

These are **structural** unknowns covered by docs/delegation inspection, not hard blockers for the decision doc.

---

## Pending steps in this POC session

- [ ] User clicks `approval_url` with passkey to test the approval flow UX → observe state change in `agent:session status`
- [ ] If staging faucet gets fixed (or alternative faucet found), retry full x402-execute against a Kite catalog endpoint
- [ ] Optional: try `kite-discovery` skill (`ksearch`) to enumerate paid services on Kite — useful for our own marketplace registry alignment

---

## Files

- `discovery-notes.md` — Phase 1 docs reading + waitlist gate analysis
- This file (`poc-results.md`) — Phase 2 hands-on results
- `decision-doc.md` — Phase 3 final recommendation (next, in progress)

---

## Raw command transcripts

### Prod signup
```
$ kpass signup init --email ferrosasfp@gmail.com --client agent --output json --no-interactive
→ signup_019de706-c250-7f18-84b2-62756a914c3a
→ code: EWAZL55X (consumed)
→ user_019de709-4367-7d4f-b21f-f188b7aff8db ✅
```

### Staging signup
```
$ kpass signup init --email ferrosasfp@gmail.com --client agent --output json --no-interactive
→ signup_019de70e-2422-78dc-ad02-fc24f859dab7
→ code: BJR7FST7 (consumed)
→ user_019de70e-ed4f-7216-a1f5-fd31b43474ab ✅
```

### Session create (staging)
```
$ kpass agent:session create --task-summary "..." --max-amount-per-tx 0.1 --max-total-amount 0.5 --ttl 1h --assets USDC --output json
→ request_id: agent_session_req_019de711-8bef-7356-92e4-318e7b5a6f32
→ approval_url: https://passport-web.staging.gokite.ai/agent-session/approve?token=asr_...
→ public_key: Allhl21PZG1qIvLpjRIs4WnGgPnnQRCQOvApcE84PDh1
→ status: human_action_required (pending user passkey approval)
```
