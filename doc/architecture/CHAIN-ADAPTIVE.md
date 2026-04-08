# WasiAI A2A — Chain-Adaptive Architecture

> **Status**: Target architecture (approved 2026-04-08)
> **Owner**: Fernando Rosas
> **Supersedes**: implicit "Kite-only" assumptions in early WKH-5/6/9/13/29

## 1. Thesis

**wasiai-a2a is THE agentic economy layer.** It owns identity, budget, and authorization as its own off-chain primitives. It delegates on-chain settlement (payment, attestation, gasless) to pluggable adapters selected at runtime according to the L1 the gateway is deployed on.

Two reinforcing ideas:

1. **Off-chain + chain-agnostic**: identity, budget, authorization. Cheap, atomic, portable across chains.
2. **On-chain + chain-specific**: payment, attestation, gasless execution, identity binding. One adapter per L1.

**Decoupling rule**: wasiai-a2a has ZERO dependency on wasiai-v2. wasiai-v2 is a CLIENT like any other marketplace. No shared tables, no imports, no borrowed primitives.

**Standards posture**: wasiai-a2a implements open standards (Google A2A, x402, ERC-8004, EIP-3009, EAS). Chain-specific vendors (Kite Passport, Coinbase AgentKit, Biconomy, Gelato) are consumed via adapters, never as core dependencies.

## 2. Context — why this exists

### Current state (2026-04-08)

Audit result:
- **wasiai-v2 coupling**: ≈ 0 (1 test mentions the name). Already decoupled as a product.
- **Kite coupling**: 187 references across 17 files. `Kite` is hardcoded in x402 middleware, chain-client, gasless signer, payment amounts, PYUSD address, Ozone RPC. **The gateway is currently Kite-only.**

This architecture is NOT about decoupling from wasiai-v2 (already done). It is about decoupling from Kite, so the same gateway can be deployed on any EVM L1.

### Clarification on Kite Passport (per Kite team, 2026-04-08)

> "For third-party skills that require integration with Kite Passport, we are still determining the best integration approach."
> "We do not yet support using Kite Passport to let third parties directly publish their own Agents with one click."
> "The only Agents we officially support today are Claude Code / Codex."

**Consequence**: we cannot claim Kite Passport integration. We must provide our own identity primitive and bind to Passport (or any other on-chain identity) via an optional adapter when Kite publishes the path.

## 3. Architecture — 4 layers

```
┌─────────────────────────────────────────────────────────────┐
│  L4 — Public API (chain-agnostic, stable interface)         │
│  • Core A2A: /discover /compose /orchestrate                │
│  • Agent Cards: /agents/:id/agent-card /.well-known/*       │
│  • Ops: /dashboard /tasks                                   │
│  • Identity: /auth/agent-signup /auth/deposit /auth/me      │
│  • Binding: /auth/bind/:chain                               │
└────────────────────────────┬────────────────────────────────┘
                             ↓ uses
┌─────────────────────────────────────────────────────────────┐
│  L3 — Agentic Economy Primitives (owned, chain-agnostic)    │
│  • IdentityService     — wasi_a2a_xxx keys + bindings       │
│  • BudgetService       — per-key, per-chain, atomic debit   │
│  • AuthzService        — scoping: registries/agents/cats    │
│  • RateLimitService    — daily / hourly / per-call caps     │
│  • PricingService      — USD ↔ token conversion             │
└────────────────────────────┬────────────────────────────────┘
                             ↓ uses
┌─────────────────────────────────────────────────────────────┐
│  L2 — Chain Adapters (pluggable, runtime-selected)          │
│  ┌────────────┬────────────┬──────────┬──────────────────┐  │
│  │ Payment    │ Attestation│ Gasless  │ IdentityBinding  │  │
│  ├────────────┼────────────┼──────────┼──────────────────┤  │
│  │ kite-ozone │ kite-ozone │ kite-aa  │ kite-passport*   │  │
│  │ evm-generic│ eas        │ biconomy │ erc-8004         │  │
│  │ base       │ eas-base   │ coinbase │ erc-8004+agentkit│  │
│  │ mock       │ in-mem log │ none     │ none             │  │
│  └────────────┴────────────┴──────────┴──────────────────┘  │
│  * when Kite publishes the official integration path       │
└────────────────────────────┬────────────────────────────────┘
                             ↓ talks to
┌─────────────────────────────────────────────────────────────┐
│  L1 — Blockchain / Infra                                    │
│  Kite Ozone testnet (2368) · Kite mainnet (2366)            │
│  Avalanche (43114) · Ethereum · Base · Arbitrum · ...       │
└─────────────────────────────────────────────────────────────┘
```

### L3 — data model

```sql
CREATE TABLE a2a_agent_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref TEXT NOT NULL,                -- free-form owner reference (no auth.users coupling)
  key_hash TEXT UNIQUE NOT NULL,          -- SHA-256 of wasi_a2a_xxx
  display_name TEXT,

  -- budget: balance per chain, expressed in that chain's default stablecoin
  budget JSONB DEFAULT '{}',              -- {"2368": "10.00", "43114": "25.00"}
  daily_limit_usd NUMERIC(18,6),
  daily_spent_usd NUMERIC(18,6) DEFAULT 0,
  daily_reset_at TIMESTAMPTZ DEFAULT NOW(),

  -- scoping
  allowed_registries TEXT[],
  allowed_agent_slugs TEXT[],
  allowed_categories TEXT[],
  max_spend_per_call_usd NUMERIC(18,6),

  -- lifecycle
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- optional on-chain bindings (JSONB to stay chain-agnostic)
  erc8004_identity JSONB,                 -- {chain_id, address, verified_at, tx_hash}
  kite_passport JSONB,                    -- future: {account, verified_at}
  agentkit_wallet JSONB,                  -- {address, network}

  metadata JSONB DEFAULT '{}'
);

-- Atomic debit function (per-chain, per-key)
CREATE FUNCTION increment_a2a_key_spend(
  p_key_id UUID,
  p_chain_id INT,
  p_amount_usd NUMERIC
) RETURNS void AS $$ ... $$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Key decisions**:

- `owner_ref` is a free-form string (no FK to `auth.users` — that would couple us to a specific auth system). Consumers (marketplaces, developers) pass whatever reference they need.
- `budget` is a JSONB map `chain_id → amount`. A single key can hold balance in multiple chains simultaneously.
- Bindings are JSONB and optional. A key can exist without any on-chain binding.
- `increment_a2a_key_spend` is atomic and chain-scoped.

### L2 — adapter interfaces

```typescript
// src/adapters/types.ts

export interface PaymentAdapter {
  readonly name: string
  readonly chainId: number
  readonly supportedTokens: TokenSpec[]

  settle(req: SettleRequest): Promise<SettleResult>
  verify(proof: X402Proof): Promise<VerifyResult>
  quote(amountUsd: number): Promise<QuoteResult>
}

export interface AttestationAdapter {
  readonly name: string
  readonly chainId: number

  attest(event: AttestEvent): Promise<{ txHash: string; proofUrl: string }>
  verify(ref: AttestRef): Promise<boolean>
}

export interface GaslessAdapter {
  readonly name: string
  readonly chainId: number

  transfer(req: GaslessTransferRequest): Promise<GaslessResult>
  status(): Promise<GaslessStatus>
}

export interface IdentityBindingAdapter {
  readonly name: string
  readonly chainId: number

  bind(keyId: string, chainAddress: string, sig: Signature): Promise<BindResult>
  verify(keyId: string): Promise<BindVerification>
}
```

### L2 — file layout

```
src/adapters/
├── types.ts                    # shared interfaces + DTOs
├── registry.ts                 # factory + runtime selection from env
├── kite-ozone/
│   ├── payment.ts              # x402 + Pieverse + Test USDT / PYUSD
│   ├── attestation.ts          # Kite Ozone attestation contracts
│   ├── gasless.ts              # extracted from src/lib/gasless-signer.ts (WKH-29)
│   └── index.ts
├── evm-generic/
│   ├── payment.ts              # x402 over any EVM + generic facilitator
│   ├── attestation.ts          # Ethereum Attestation Service (EAS)
│   ├── gasless.ts              # Biconomy paymaster
│   └── index.ts
├── base/
│   ├── payment.ts              # USDC on Base
│   ├── attestation.ts          # EAS on Base
│   ├── gasless.ts              # Coinbase paymaster
│   └── index.ts
└── mock/                       # dev / test
    └── ...
```

### L4 — new public endpoints

```
POST /auth/agent-signup   → create wasi_a2a_xxx key, return { key, key_id }
POST /auth/deposit        → register a deposit (chain, token, amount, txHash)
                             gateway verifies on-chain via the active PaymentAdapter
GET  /auth/me             → self-status (budget per chain, remaining, scoping)
POST /auth/bind/:chain    → bind key to on-chain identity via IdentityBindingAdapter
POST /compose    (optional header: x-a2a-key wasi_a2a_xxx)
POST /orchestrate (optional header: x-a2a-key wasi_a2a_xxx)
```

### Auth middleware behavior

When `x-a2a-key` header is present:
1. Hash with SHA-256, look up in `a2a_agent_keys`
2. Validate `is_active`, check `daily_limit_usd`, `max_spend_per_call_usd`
3. Check scoping: target agent ∈ `allowed_registries` ∪ `allowed_agent_slugs` ∪ `allowed_categories`
4. Execute the request
5. On success, atomically debit budget via `increment_a2a_key_spend`
6. Return response augmented with `{ remainingBudget, keyId }`

When header is absent:
1. Fallback to current x402 flow (supported Kite path — unchanged)

**The two paths coexist forever.** `x-a2a-key` is a convenience for heavy users; x402 is always available for one-off consumers.

## 4. Per-chain deployment matrix

| L1 | chainId | Payment adapter | Token default | Attestation | Gasless | Identity binding |
|---|---|---|---|---|---|---|
| Kite Ozone testnet | 2368 | `kite-ozone` | Test USDT / PYUSD | Kite Ozone native | Kite AA (WKH-29) | Future Kite Passport |
| Kite mainnet | 2366 | `kite-ozone` | USDC.e | Kite Ozone native | Kite AA mainnet | Future Kite Passport |
| Avalanche C-chain | 43114 | `evm-generic` | USDC | EAS on AVAX | Biconomy | ERC-8004 |
| Ethereum L1 | 1 | `evm-generic` | USDC | EAS | Biconomy / Gelato | ERC-8004 |
| Base | 8453 | `base` | USDC | EAS on Base | Coinbase paymaster | ERC-8004 + AgentKit |
| Arbitrum | 42161 | `evm-generic` | USDC | EAS on Arbitrum | Gelato | ERC-8004 |
| Localhost / dev | 31337 | `mock` | fake-USD | in-memory log | none | none |

### Runtime configuration

```bash
# Primary chain selects the default adapter bundle
WASIAI_A2A_CHAIN=kite-ozone-testnet    # or: kite-mainnet | avalanche | ethereum | base | arbitrum | mock
WASIAI_A2A_TOKEN=PYUSD                 # override the default token for this chain

# Individual adapter overrides (optional — normally inferred from WASIAI_A2A_CHAIN)
PAYMENT_ADAPTER=kite-ozone
ATTESTATION_ADAPTER=kite-ozone
GASLESS_ADAPTER=kite-ozone             # or "none" / "biconomy" / ...
IDENTITY_BINDING_ADAPTER=none          # or "erc8004" / "kite-passport"

# Per-adapter secrets (Kite example)
KITE_RPC_URL=...
KITE_FACILITATOR_URL=...
OPERATOR_PRIVATE_KEY=...
```

## 5. Decoupling policy (wasiai-a2a ↔ wasiai-v2)

| Concept | Lives in | Purpose |
|---|---|---|
| `agent_keys` (`wasi_xxx`) | wasiai-v2 DB | **Marketplace auth**: who can publish agents on wasiai.io, who owns which agent |
| `a2a_agent_keys` (`wasi_a2a_xxx`) | **wasiai-a2a DB** | **Gateway auth**: who can call discover/compose/orchestrate, with what budget, under what scoping |

**Rules**:
- No imports of wasiai-v2 in wasiai-a2a source.
- No shared tables. Prefer separate Supabase projects.
- An agent that is registered in wasiai-v2 may *optionally* sign up in wasiai-a2a to get a gateway key. They are separate operations.
- wasiai-v2 is a CLIENT of wasiai-a2a on equal footing with Kite Marketplace, Mock Community Hub, and any future marketplace.

**Forbidden moves**:
- ❌ Wasiai-a2a middleware querying `wasiai-v2.agent_keys` directly
- ❌ Shared `auth.users` table
- ❌ Cross-service session cookies
- ❌ wasiai-v2 being a "special" registry with privileged access in wasiai-a2a

## 6. Identity posture

The final answer to "do we use Kite Passport or our own?":

| Primitive | Approach |
|---|---|
| Identity + budget + authz | **Always our own** (`wasi_a2a_xxx` keys in `a2a_agent_keys`). Never delegated. The raison d'être of the gateway. |
| Payment settlement | **Chain adapter**. x402 is the open standard we implement on every chain. Kite uses Pieverse facilitator; EVM-generic uses whatever facilitator is available; we never invent "our own settlement". |
| Attestation | **Chain adapter**. Kite Ozone native on Kite; EAS on Ethereum-family chains; signed-log fallback on unsupported chains. |
| Gasless execution | **Chain adapter, optional**. Kite AA on Kite; Biconomy/Gelato on mainnet; Coinbase paymaster on Base; none is always a valid mode. |
| On-chain identity binding | **Chain adapter, optional**. ERC-8004 is the chain-agnostic standard. Kite Passport is a vendor-specific wrapper on top of ERC-8004 (to be added when Kite publishes the path). |

**Guiding principle**: never reinvent open standards, never depend on vendor-specific primitives for core functionality.

## 7. Open questions

1. **x402 facilitator beyond Pieverse?** The x402 protocol is standard, but today Pieverse is the only production facilitator I know of and it is Kite-coupled. Need to research: is there a chain-agnostic facilitator, or do we need to build/host one for EVM-generic?
2. **ERC-8004 maturity**: still evolving. Safe to claim "ERC-8004-ready". Unsafe to claim "ERC-8004 implemented" until we have a verified binding flow.
3. **Multi-tenant DB**: one Supabase project per deployment (per chain) OR one project with `chain_context` discriminator column. Leaning toward one-per-deployment for isolation.
4. **Cross-chain budget**: depositing on Base and spending on Kite. Options:
   - **Simple**: budget is per-chain, no cross-chain spending.
   - **Virtual USD balance**: unified off-chain balance in USD, settled on the chain that the current call uses. Cleaner but needs a settlement pattern when balance goes negative on one chain.
   - **Bridging**: L0-level, too complex for now.
   - **Decision**: start with per-chain, revisit after Fase 2.
5. **Header naming**: `x-a2a-key` or `authorization: Bearer wasi_a2a_xxx`? Latter is more standard. Deciding during WKH-34 design.
6. **Pricing oracle**: USD ↔ token conversion. Trivial for stablecoins (≈ 1:1), but we need a defined source for deviations and for non-stablecoin payments.

## 8. Migration roadmap

### Fase 0 — Today (pre-WKH-26)
- ✅ This document created
- ⏳ Pitch update with "chain-adaptive agentic economy gateway" framing
- ⏳ Remove `passportAddress` dangling field from `src/types/index.ts`
- ⏳ Mark Kite-hardcoded files with `// TODO(WKH-35): extract to adapters/kite-ozone/`

### Fase 1 — Post-WKH-26, pre-final-submission (11–25 April)
- **WKH-34** — Agentic Economy Primitives L3 (`a2a_agent_keys` table, IdentityService, BudgetService, AuthzService, L4 auth endpoints, optional `x-a2a-key` middleware). Mode: QUALITY full pipeline.
- **WKH-35** — Adapter refactor L2 (extract Kite hardcoding to `src/adapters/kite-ozone/*`, define interfaces, keep behavior identical). Mode: QUALITY with strong AR for regression. Verify with existing 112 tests + new contract tests.
- **WKH-36** — EVM-generic adapter spike (proof of concept on Avalanche testnet or Base Sepolia, end-to-end one payment). Mode: LAUNCH.

### Fase 2 — Post-hackathon (May+)
- Multi-chain simultaneous deployment (one binary, multiple adapters active)
- Base adapter with Coinbase paymaster + AgentKit binding
- ERC-8004 `IdentityBindingAdapter` with real on-chain binding flow
- x402 facilitator research: adopt an existing one or host our own for EVM-generic

### Fase 3 — Standards integrations
- Kite Passport adapter (when Kite publishes the official path)
- Full EAS attestation schemas published
- Coinbase AgentKit full integration
- Cross-marketplace interop tests with other A2A implementations

## 9. Success criteria

This architecture is successful when:
1. `WASIAI_A2A_CHAIN=kite-ozone-testnet` and `WASIAI_A2A_CHAIN=avalanche` produce functionally equivalent gateways with ONLY config differences.
2. A single `wasi_a2a_xxx` key can hold budget and spend on more than one chain.
3. A new L1 can be added by writing a single `src/adapters/<new-chain>/` folder, without touching any L3 or L4 code.
4. Zero source-level references from wasiai-a2a to wasiai-v2.
5. The L4 public API surface is stable across adapter changes (contract tests enforce this).
6. A judge/reviewer reading the pitch sees "chain-adaptive, standards-based agentic economy layer" and NOT "Kite-specific wrapper".

## 10. References

- **Google A2A Protocol**: https://google.github.io/A2A/
- **x402 Protocol**: `doc/sdd/002-kite-payment/`, `doc/sdd/008-x402-compose/`
- **WKH-29 Gasless (Kite AA + EIP-3009)**: `doc/sdd/018-gasless-aa/`
- **ERC-8004**: agent identity standard (evolving)
- **EAS**: https://attest.sh/ — Ethereum Attestation Service
- **Pieverse facilitator**: x402 verification/settlement for Kite
- **Kite team clarification (2026-04-08)**: stored in Engram under `kite/ecosystem/status`

## 11. Change log

| Date | Change | Author |
|---|---|---|
| 2026-04-08 | Initial draft — chain-adaptive architecture approved | Fernando Rosas |
