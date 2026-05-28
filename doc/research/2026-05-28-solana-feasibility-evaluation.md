# Feasibility Evaluation — Running wasiai-a2a on Solana

> **Status**: evaluation only (no implementation). For later review.
> **Date**: 2026-05-28
> **Author**: NexusAgil orchestrator (grounded against the codebase, file:line).
> **Context**: wasiai-a2a today supports 3 EVM chains in prod (Kite, Avalanche, Base),
> inbound + outbound, proven onchain. Question: complexity of adding **Solana**.

---

## TL;DR — verdict

Solana is **NOT "just another chain"** like the Base port was. The Base port was **~M**
effort because it mirrored the Avalanche adapter and reused viem + EIP-3009. **Solana is a
second payment rail entirely** → complexity **HIGH (L–XL)**, weeks not days, and warrants a
de-risking **spike first**.

**The good news (architectural leverage):** the core value layer of wasiai-a2a —
**discovery + composition + orchestration over Google A2A** — is **chain-agnostic and does
not change**. 100% of the complexity is in the **payment / settlement rail**. And because of
WKH-111/112/113 (the gateway is now fully chain-aware, routing via
`getPaymentAdapter(chainKey)` / `normalizeChainSlug`), the orchestration plumbing is already
ready to plug in a Solana adapter — we just need to build the adapter + facilitator chain +
generalize the EVM-typed interface.

---

## Why it's hard — EVM assumptions are baked into the type system

Verified in code:

| EVM assumption | Evidence (file:line) | Solana reality |
|----------------|----------------------|----------------|
| `0x${string}` addresses (20-byte) | `src/adapters/types.ts:8,36,52,88`; `src/types/index.ts:92`; `src/lib/downstream-payment.ts:85,93,167` | base58 32-byte pubkeys |
| `chainId: number` (eip155) | `src/adapters/types.ts:80,94,100`; chain-resolver eip155 model | No chainId → CAIP-2 (`solana:<genesis-hash>`) |
| EIP-3009 `transferWithAuthorization` (gasless primitive) | `src/adapters/{kite-ozone,avalanche,base}/payment.ts` | Does not exist — gasless = fee-payer / durable nonce / SPL delegation / Token-2022 |
| EIP-712 typed-data sign, secp256k1 | `privateKeyToAccount(pk as 0x...)` (downstream-payment.ts:228) | **Ed25519** signature scheme |
| ERC-20 tokens (USDC/PYUSD) | `getToken(): 0x${string}` (types.ts:88) | **SPL Token** (different program, ATAs, rent) |
| viem everywhere | 7 files import `viem` | `@solana/web3.js` + `@solana/spl-token` |

Solana is currently an **explicitly rejected chain**: `src/services/discovery.test.ts:406`
asserts `solana → payment undefined` (the SEC-AR defense treats it as an exotic/unknown chain).

---

## What does NOT change (chain-agnostic core)

- **Discovery, `/compose`, `/orchestrate`, `/registries`, agent-cards, JSON-RPC A2A, LLM
  orchestration** — all HTTP/JSON, chain-independent.
- **Chain-aware routing is already in place**: post WKH-111/112/113 the gateway resolves and
  routes payments via `getPaymentAdapter(chainKey)` + `normalizeChainSlug` with **no hardcoded
  chain logic**. A conforming Solana adapter slots in without changing the orchestration.

---

## What DOES change (the hard work) — per layer

| # | Component | Complexity | Work |
|---|-----------|:----------:|------|
| 1 | **x402-Solana scheme** | 🔴 HIGH | challenge/verify/settle assumes an EIP-3009 envelope. Solana needs a different scheme (SPL transfer + Ed25519 auth + gasless via fee-payer). **Does a standard x402-Solana scheme exist?** → key unknown (below). |
| 2 | **Facilitator: Solana chain** | 🔴 HIGH | Heaviest piece — the facilitator signs+submits the settle tx onchain. Today viem + EIP-3009. For Solana: `@solana/web3.js`, SPL transfer, operator as fee-payer, recent-blockhash/durable-nonce. Net-new `wasiai-facilitator/src/chains/solana.ts`. |
| 3 | **Interface generalization** | 🟠 MED (cross-cutting) | `PaymentAdapter`, `SignRequest`, `SettleResult`, `AgentPaymentSpec.contract` are typed `0x${string}` + `chainId: number`. Generalize (address union, CAIP-2 network tag, signature scheme). Touches **shared types in both repos** → zero-regression on the EVM path is a hard requirement. |
| 4 | **Solana adapter (a2a)** | 🟠 MED-HIGH | New `src/adapters/solana/` with Ed25519 + SPL conforming to the interface. Not a mirror — net-new. |
| 5 | **chain-resolver / ChainKey / address validation** | 🟡 MED | Add `solana-mainnet`/`solana-devnet`; break the eip155 assumption; `validatePayTo` / `AddressHexSchema` / `readPayment` must accept base58 (not `0x`). |
| 6 | **Ops** | 🟡 MED | Solana operator keypair (Ed25519), fund SOL (gas) + USDC SPL, gas monitor, explorer (Solscan). |
| 7 | **Identity (ERC-8004 / Kite Passport)** | 🟢 LOW | EVM-specific; Solana has its own. Not blocking unless used. |
| 8 | **Discovery/compose/orchestrate** | 🟢 LOW | Add the slug + accept Solana addresses in validation. |

---

## Risks / unknowns (resolve in a spike before committing)

1. **Is there a standardized x402-Solana scheme?** (unknown #1 — defines everything). x402 is
   scheme-extensible and there has been ecosystem movement to bring it to Solana, but this must
   be **verified**. If a standard exists (Coinbase / Solana Foundation) → we follow it (we keep
   the interop benefit). If not → we'd be **defining** one (more work, and it erodes the
   interoperability that is our moat).
2. **Gasless model on Solana**: fee-payer + partial-sign vs SPL delegation vs Token-2022
   transfer hooks. A non-trivial design decision (the EIP-3009 equivalent).
3. **Type generalization = regression risk** on the 3 working EVM chains. Zero-regression must
   be a mandatory Constraint Directive.
4. **SPL/ATA/rent friction**: creating associated token accounts, handling rent — operational
   surface EVM doesn't have.

---

## Effort + recommendation

Not a fast-follow of the Base port. It is a **SPIKE + EPIC**.

- **Phase 0 — SPIKE (1–3 days, de-risking)**:
  1. Verify whether a standard x402-Solana scheme exists.
  2. Prototype a real gasless SPL settle via the facilitator (operator as fee-payer) on devnet
     → 1 onchain proof tx.
  3. Decide the interface generalization shape.
  This clears the two big unknowns before committing the epic.
- **Phase 1 — QUALITY EPIC** (same NexusAgil pipeline): generalize interface → facilitator
  Solana chain → Solana adapter (a2a) → resolver/discovery Solana → ops/funding → E2E onchain
  proof (inbound + outbound, like the Base port). Estimate **L–XL** (multiple HUs).

**Strategic note**: worth it **if the target is the Solana ecosystem** (large DeFi/agentic
base + Solana's own agent-payments momentum). It is a genuine second-rail investment, not a
quick win — but the orchestration core is already chain-ready, so the architectural ROI is
good. Also usable as an investor narrative: "multi-rail roadmap — EVM (Kite/Avalanche/Base)
today, Solana next".

---

## Reference: how the 3 EVM chains work today (baseline to generalize from)

- Adapter interface: `src/adapters/types.ts` (`PaymentAdapter.sign/verify/settle`).
- Per-chain adapters: `src/adapters/{kite-ozone,avalanche,base}/payment.ts`.
- Chain resolution: `src/adapters/chain-resolver.ts` (`normalizeChainSlug`, eip155 aliases).
- Registry/routing: `src/adapters/registry.ts` (`getPaymentAdapter(chainKey)`).
- Inbound x402: `src/middleware/x402.ts` (chain-aware, WKH-111).
- Outbound downstream: `src/lib/downstream-payment.ts` (chain-aware, WKH-112).
- Discovery dynamic chain validation: `src/services/discovery.ts` (WKH-113).
- Facilitator chains: `wasiai-facilitator/src/chains/{kite,avalanche,base}.ts`.
- Onchain proof (the bar to match for Solana): `doc/sdd/_validation/2026-05-28-full-prod-validation.md`.
