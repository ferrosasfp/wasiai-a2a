[Español](README.es.md)

# WasiAI A2A

[![ci](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/ci.yml/badge.svg)](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/ci.yml)
[![smoke-downstream](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/smoke-downstream.yml/badge.svg)](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/smoke-downstream.yml)
[![protocol](https://img.shields.io/badge/protocol-Google%20A2A-blue)](https://google.github.io/A2A/)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**This is the coordinator.** One name, used everywhere: the pitch deck calls it that, the agent card at
`/.well-known/agent.json` publishes `WasiAI A2A Coordinator`, and so does its entry in the Solana Agent
Registry. The word *gateway* appears throughout this README describing what it **is** technically, an HTTP
entry point, not as a second name for the same thing.

Protocol and HTTP gateway that lets a client find agents **by capability instead of by address**, **compose** them into a flow, and **pay per use**.

**Solana is the primary network of this gateway, and its settlement leg is verified on-chain**: the payout below moves real USDC-SPL on devnet, and anyone can check it against the public RPC. What that transfer proves is the mechanism, not a charge at list price: the amount moved is 0.000001 USDC against a declared price of 0.03.

A client does not need to know that `remit-corridor-fx-solana` exists. It asks for "I need an FX quote" and the gateway returns who can do it, on which network that agent charges, and how much it costs. Then it runs the flow with a single HTTP call and the gateway handles payment to each agent.

The gateway federates the catalogs of the registered marketplaces: an agent published in any of them is discoverable from any connected app. That is the thesis of this repo: **the marketplace is an application on top of the protocol, not the protocol**.

- Live gateway: `https://wasiai-a2a-production.up.railway.app`
- Primary network: **Solana** (devnet today; no mainnet is initialized in this deployment)
- Base protocols: [Google A2A](https://google.github.io/A2A/) + [x402](https://github.com/x402-foundation/x402) for payment

## Solana first

**Solana is the primary network of this gateway.** It is the only non-EVM rail in the codebase and the chain where the remittance line of the catalog charges today: its three agents (`remit-corridor-fx-solana`, `remit-cashout-payout-solana` and `remit-kyc-validator`) all declare `solana-devnet` (measured against `GET /discover?limit=50` on the production deployment on 2026-08-15: 25 agents, `catalogStatus: complete`, 3 of them on `solana-devnet`). It was two of them on 2026-07-31; `remit-kyc-validator` came after, and this line was one measurement behind until it was re-read.

The Solana payment leg is not roadmap: it moves real USDC-SPL. Transfer [`3pNqu9jH…`](https://explorer.solana.com/tx/3pNqu9jHduGaXioB8Mf7WNvBgZQgJV4MnE6NDGWZdz6aY5gr2ivxfbwzrnweutSVtyKnvv7y7kXnARroktjyWsZx?cluster=devnet) is confirmed on devnet (`err: None`), it is Circle's USDC (`4zMMC9sr…`), and the recipient is the payout wallet of the `remit-corridor-fx-solana` agent. You verify it with a `getTransaction` against the public devnet RPC, without asking anyone for permission.

The other networks are still here and are still true: Avalanche, Base, Kite and Tempo each have their own adapter, and that neutrality is the product. What exists is an **ordering, not an exclusivity**: when a network has to be picked, it is Solana.

One asymmetry is better read early than discovered against a `400`: Solana is today the **outbound** rail (the gateway pays the agent) and the chain where it can debit a prepaid key. **Inbound** charging over x402 is still EVM, because that leg needs an EIP-3009 style signed authorization that the Solana adapter does not implement. Details in [Solana rail](#solana-rail).

---

## Discovery by capability

The whole catalog is public and costs nothing to query. **Unrecognized parameters are rejected with `400 UNKNOWN_DISCOVER_PARAM`** — this prevents misspelled filters (e.g. `capability` instead of `capabilities`) from silently matching everything.

```bash
GW=https://wasiai-a2a-production.up.railway.app

curl -s "$GW/discover?capabilities=remittance-fx-quote" | jq '.agents[] | {slug, priceUsdc, chain: .payment.chain, rail: .payment.resolvedChain, network: .payment.network}'
# {"slug":"remit-corridor-fx-solana","priceUsdc":0.03,"chain":"solana-devnet","rail":"solana-devnet","network":"testnet"}

curl -s "$GW/discover?capabilities=price-feed" | jq '.agents[] | {slug, priceUsdc, chain: .payment.chain, rail: .payment.resolvedChain, network: .payment.network}'
# {"slug":"wasi-chainlink-price","priceUsdc":0.001,"chain":"avalanche","rail":"avalanche-fuji","network":"testnet"}
```

`payment.chain` is the string **the agent declared**, and several accepted aliases do
not state their environment: `avalanche` is the most common one in the live catalog
(16 of 25 agents on 2026-08-05) and it resolves to Fuji, a testnet. So the catalog
also reports what the gateway **resolved** it to: `payment.resolvedChain` is the
canonical rail and `payment.network` is `testnet` or `mainnet`. These two are derived
by the gateway — agents keep declaring exactly what they declared before. The
guarantee behind `network` is narrow on purpose: either the payment lands on that
environment or there is no payment, because the outbound leg refuses to sign when the
rail's declared environment and the real destination disagree.

The first one was published straight against the gateway (`registry: "self-published"`) and charges on Solana; the second lives in a registered external marketplace (`registry: "WasiAI"`) and charges on Avalanche. The client doing the query cannot tell one from the other and does not have to know which network each one charges on, and that indistinguishability is the point: federation, and the chain, are transparent to the consumer.

**Catalog completeness and `limit`.** Without a `limit` parameter, the gateway does not tell each registry how many rows to return, so each registry serves its own default page. With `limit=50` the gateway enforces the ceiling each registry publishes (`schema.discovery.maxLimit`). Measured on 2026-08-15, three calls in a row: the bare `/discover` and `/discover?limit=50` both return 25 agents and `catalogStatus: complete`, with the federated source giving its 22 rows unasked. On 2026-08-04 that same bare call returned 23 and `truncated`. Which is exactly the reason to pass a `limit` when you query for filtering or capability selection, and especially for `/orchestrate/plan`: without it, what you get depends on a default that belongs to someone else and can change without notice — as it just did.

Every agent returned by `/discover` carries an `invokeUrl`, but it is an internal reference. **The caller does not call the agent directly.** It invokes through `/compose` (explicit pipeline) or `/orchestrate` (by goal, with the plan built by an LLM). That is what lets the gateway resolve price, budget, scoping and settlement in a single place instead of leaving it to each client.

## Composition and charging

A pipeline has two legs and they do not have to be on the same network: the **outbound payment** to each agent (which for a Solana agent settles in USDC-SPL on Solana) and the **inbound charge** to the caller, which today is x402 over EVM. The example below is exactly that: the agent charges on `solana-devnet` and the caller pays on an EVM network.

`/compose` takes already resolved steps and returns an x402 challenge when no payment is attached:

```bash
curl -s -X POST "$GW/compose" -H 'content-type: application/json' \
  -d '{"steps":[{"agent":"remit-corridor-fx-solana","input":{"amountUsdc":100,"corridor":"USDC-PEN"}}]}'
```

```json
{
  "error": "payment-signature header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:2368",
    "maxAmountRequired": "30300000000000000",
    "payTo": "0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba",
    "asset": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
    "maxTimeoutSeconds": 300
  }],
  "x402Version": 2
}
```

The amount is the real pipeline price plus the protocol fee: `0.03 + 1% = 0.0303`. The same call with the header `x-payment-chain: avalanche-fuji` returns `network: "eip155:43113"`, the Fuji USDC and `maxAmountRequired: "30300"` (6 decimals instead of 18). Same pipeline, quoted on another network, without touching the body.

What it does **not** do, stated with the real error: `x-payment-chain: solana-devnet` stops with `400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED`, and the response spells out the asymmetry and the two ways out (another chain for the x402, or a prepaid key, which does debit budget on `solana-devnet`). Solana settles outbound; it does not charge inbound.

There are two ways to pay and the caller picks one per request:

| Method | Who it is for | How |
|---|---|---|
| x402 | occasional consumer, no account | answer the `402` with a signed `X-Payment` header |
| prepaid key | integrator with volume | `POST /auth/agent-signup` returns a `wasi_a2a_*`, sent in `x-a2a-key` or `Authorization: Bearer` |

Precedence when several arrive: `x-a2a-key` > `Bearer wasi_a2a_*` > x402. A Bearer that does not start with `wasi_a2a_` is ignored instead of rejected, so nothing breaks for anyone already using that header for something else.

The protocol fee is 1% by default (`PROTOCOL_FEE_RATE`, hard-clamped to `[0, 0.10]`: a value out of range logs an error and falls back to the default). It is computed on the **actual executed cost**, not on the declared `budget`, so asking for a large budget does not inflate the fee. `POST /orchestrate/plan` returns `feeRatePercent` and `protocolFeeUsdc` so the caller reads the effective rate from the runtime instead of trusting this document.

That 1% is split into platform / creator / referrer via `SPLIT_BPS_*` in basis points, with fail-closed validation (the three must add up to exactly `10000` or the process rejects the config). The default is `10000/0/0`, everything to the platform. Details and a worked example in [`doc/architecture/FEE-MODEL.md`](doc/architecture/FEE-MODEL.md).

---

## Network neutrality

Solana being the primary network is a **product** decision, not a design privilege: which chain a request runs on is resolved from configuration and from the agent card, not from a branch that hands one network capabilities the others do not have. There is one adapter per network and a per-request selector, which is why adding the next chain a corridor asks for is one more folder, not a rewrite.

One chain name is hardwired in the code, as a default: with neither `WASIAI_A2A_CHAINS` nor `WASIAI_A2A_CHAIN` set, `src/adapters/registry.ts` falls back to `kite-ozone-testnet`, which is what the table below calls the charging default. Any deployment that sets the variable never reaches that literal.

The concrete case that drove the design is a remittance. The remittance principal travels over Solana, the agent marketplace runs on Avalanche, and settlement is coordinated by a separate service (`wasiai-facilitator`) with one adapter per network. None of the three pieces needs the other two to be on its chain.

How it is implemented:

- `PaymentAdapter` is a discriminated union (`src/adapters/types.ts`): `SolanaPaymentAdapter` is a first-class member of the type, not a special case bolted onto the EVM path. The VM family is data on the type (`vmFamily`), not an `if` scattered around.
- The adapter bundle (payment, attestation, gasless, identity) is built per chain in `src/adapters/registry.ts`. Adding a network is a new folder under `src/adapters/<network>/` plus a branch in the factory. Services (L3) and routes (L4) stay untouched.
- Per-request selection comes from the `x-payment-chain` header (accepts either the slug or the numeric chainId), falling back to the first entry of `WASIAI_A2A_CHAINS`.

Networks supported in code (`SUPPORTED_CHAINS` plus the two flagged rails), with the primary one on top:

| Slug | chainId | Status in code |
|---|---|---|
| `solana-devnet` | sentinel 900001 | **primary network** · non-EVM rail behind `SOLANA_ADAPTER_ENABLED`, on in the production deployment |
| `kite-ozone-testnet` | 2368 | supported (charging default when nothing is configured) |
| `kite-mainnet` | 2366 | supported, requires a matching `KITE_NETWORK=mainnet` |
| `avalanche-fuji` | 43113 | supported |
| `avalanche-mainnet` | 43114 | supported, with an extra opt-in for the outbound leg |
| `base-sepolia` | 84532 | supported |
| `base-mainnet` | 8453 | supported |
| `tempo-testnet` | testnet | implemented, off by flag (`TEMPO_ADAPTER_ENABLED`) |

In `src/adapters/registry.ts` the two flagged rails are appended at the end of the set and start off in the repo (`SOLANA_ADAPTER_ENABLED=false` in `.env.example`, turned on by deployment config). With the flag at `false` the slug does not even enter the supported set, so the bundle is never built and the leg stops with `CHAIN_NOT_SUPPORTED`. It is not an `if` inside the adapter, it is that the adapter does not exist in the process.

## What runs today

This is the real state, not the roadmap. It is read from `GET /capabilities` on the production deployment.

```bash
curl -s "$GW/capabilities" | jq '.chains'
```

Rows below are in product order; the endpoint itself returns Kite first, because it is the default.

| Chain initialized today | chainId | Rail |
|---|---|---|
| **Solana devnet** | sentinel 900001 | outbound only, USDC-SPL (`acceptsInboundPayment: false`) |
| Kite Ozone testnet | 2368 | inbound in PYUSD, it is the charging default |
| Avalanche Fuji | 43113 | inbound and outbound, testnet USDC |
| Base Sepolia | 84532 | inbound and outbound, testnet USDC |

The three EVM rows are checked by sending `x-payment-chain` to `POST /compose` with no payment: the `402` comes back with `eip155:2368`, `eip155:43113` or `eip155:84532` and the amount in that network token's decimals. The Solana row is checked the other way around, and that is its nature: the same request with `x-payment-chain: solana-devnet` returns `400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED`, because it pays outbound and does not charge inbound.

Catalog discovery parameters (WKH-322): `/discover` now rejects unrecognized keys with `400 UNKNOWN_DISCOVER_PARAM`, listing the accepted ones. This prevents misspelled filters from silently matching the entire catalog. The accepted parameters are `allowTrial`, `capabilities`, `includeInactive`, `limit`, `maxPrice`, `minReputation`, `min_reputation`, `q`, `registry`, `verified`. The `min_reputation` alias was added so a single spelling works on both `/discover` and the `constraints` of `/compose`.

**No mainnet is initialized in today's deployment.** The mainnet adapters exist and there were real settlements on Avalanche C-Chain in April 2026 (see [On-chain evidence](#on-chain-evidence)), but the gateway that is up right now runs testnet and devnet, with no real money.

Catalog state on that same deployment: discoverable agents come from one federated marketplace plus the ones published directly against the gateway. Three of them charge on Solana devnet, and they are the whole remittance line (same measurement as above, 2026-08-15). The agents themselves do not live in this repo: this repo is the protocol and the gateway, and the catalog belongs to third parties.

**The catalog size can depend on whether you ask for a limit.** Measured 2026-08-15, three calls in a row, both forms agree: 25 agents and `catalogStatus: complete`, with a per-source breakdown of 22 rows from the federated `WasiAI` registry and 3 self-published. On 2026-08-04 the bare call returned 23 and `truncated` and only the `limit=50` form returned 25, and that was not a data inconsistency either: when no limit is passed the gateway does not send one downstream, so each registry serves its own default page, and an explicit `limit` says "I want N rows, up to your published maximum". The difference disappeared because the federated source now returns its whole set unasked, not because the mechanism went away. The response always carries a `catalogStatus` and a per-source breakdown:

```bash
curl -s "$GW/discover" | jq '{catalogStatus, total: .total}'
# "catalogStatus": "complete", "total": 25     (on 2026-08-04 it was "truncated", 23)

curl -s "$GW/discover?limit=50" | jq '{catalogStatus, total: .total}'
# "catalogStatus": "complete", "total": 25
```

A source is only `ok` with evidence (an exhausted cursor or fewer rows than the limit it was sent); one that answers without either is `unverified`, and one that could not be reached is `failed` with `rows: null` instead of `rows: 0`, because "I could not ask" is not "it has none". Same for the roll-up: `complete` means every source proved it gave everything, not that nobody complained. The catalog would rather declare that it may be incomplete than publish a total it cannot back, which is also why that number can move without anything being broken.

**Known limitations in discovery:** The pagination API accepts `limit` but does not yet support cursor-based continuation; `/discover?limit=50` returns the first 50 matches with no way to ask for the rest. Without a `limit` parameter, the gateway does not send one to the registry, so the registry returns whatever its default page is, which can leave the catalog more truncated than a user who specifies a limit would see (it did on 2026-08-04; on 2026-08-15 both forms return the same 25). A registry outage and a client validation error (e.g. malformed `minReputation`) are both reported as `http_error` in telemetry, with no distinction. Self-published agents have `status: 'active'` hardcoded in discovery and cannot be marked inactive by their publisher.

About the apps that consume it, in the correct tense:

- **Chaski** (the remittance app) resolves **two** legs through this gateway as of 2026-08-11: the FX
  quote and the payout, asked for **by capability** (`remittance-fx-quote` and `remittance-payout`)
  rather than by agent name. ⚠️ **This bullet used to say "only for the FX quote agent, and behind a
  flag that starts off", and that it integrates the disbursement "point to point, without going
  through the protocol". Both halves are now false**, and they were false in the direction that
  *understates* the product: the point-to-point rail was not gated, it was **deleted** from
  `chaski-v3` (its own code says so in `src/infrastructure/a2a/gateways.ts:126` and
  `src/presentation/flow.tsx:2693`), and the flag that used to start off is set. What is still true,
  and is the part worth keeping: **user identity does not go through the protocol**, and the final
  fiat disbursement runs against a mock adapter by default, so "the whole remittance is orchestrated
  here" remains false for a different reason than this bullet used to give.
- The agent marketplace delegates `compose`, `orchestrate` and `capabilities` to this gateway.

---

## Solana rail

It is the primary network, so it deserves the most fine print. `solana-devnet` is the only non-EVM adapter in the repo (`src/adapters/solana/`).

**Money out, that is, paying the agent** (`payment.ts`):

- **SPL transfer signed by the operator.** It builds a `createTransferInstruction`, signs with the `Keypair` from `SOLANA_OPERATOR_PRIVATE_KEY` and broadcasts with `sendAndConfirmTransaction`. No EIP-3009: the operator is the sender and pays gas in SOL. With `SOLANA_SETTLE_VIA_FACILITATOR=true` the signing and broadcast are done by the facilitator and the gateway stops holding a settlement key; the flag starts off.
- **Idempotent by `intentId`, in Postgres.** The record of "which `intentId` was already paid and with which signature" lives in the `a2a_solana_settle_intents` table (`settle-ledger.ts`, migration `20260730000000_wkh307_solana_settle_intents.sql`), with atomic conditional writes in `plpgsql` and the lease clock on the Postgres side. This is deliberate: Solana has no equivalent of the backstop that the deterministic EIP-3009 nonce gives you (a re-broadcast SPL transfer pays again), so this application-level seam is the only defense against double payment, and a process restart does not wipe it.
- **Fail-closed, and "I do not know" is not "it did not happen".** A dead RPC, a timeout or an unreadable response neither authorizes a transfer nor gets reported as an unpaid leg: it stays as an unknown disposition so a retry or reconciliation can resolve it. Reporting "not paid" about something you could not verify is paying twice by design.
- **Verify before trusting.** `verify()` requires an on-chain balance delta `>= amountAtomic` for the expected mint and `payTo`; a retry revalidates the previous signature on-chain (`getParsedTransaction`) instead of broadcasting again.

**Money in, what works and what does not:**

- **Prepaid deposit on Solana: implemented, tested, and on in the production deployment.** Being in the code and being on in the deployment are two different claims, so here they are separately. *In code* (`deposit-account.ts` + `deposit-verifier.ts`, with the flag on and off both covered in `src/routes/auth.solana-deposit.test.ts`): `POST /auth/deposit` accepts a Solana signature, verifies it on-chain against the deposit account and credits budget, and the destination published by `GET /auth/deposit-info` is the **ATA** derived from the (mint, owner) pair, not a wallet, because on Solana tokens do not live in the account. It sits behind its own flag (`A2A_DEPOSIT_ENABLED_SOLANA`, deliberately separate from the rail flag) and requires the depositor to match the key's declared funding wallet. *In the deployment that is up*, that flag is now on: `curl -s "$GW/auth/deposit-info"` returns four networks, and the `solana-devnet` one carries `deposit_account: "9BBtuaoFpV3BNUrv4GnNu68RXBVeNwVaJiggyxuK4Qfx"`, its `deposit_account_owner` published separately so the derivation can be audited, `required_commitment: "finalized"` and the devnet USDC mint (measured 2026-07-31). That entry deliberately carries no `treasury` and no `escrow_*`: both are EVM resolutions, and an EVM address inside the Solana entry would send devnet USDC to a string that is nothing on Solana. `src/routes/auth/deposit.ts` publishes the entry only when the flag is on: advertising a deposit account with no verifier wired behind it invites money that nobody can credit.
- **The minimum, and that it can be checked from outside.** Every entry also carries `deposit_minimum_usdc` and `deposits_enabled`, both computed from `resolveDepositMinimumMicroUsd()`, the same choke-point `checkDepositMinimum()` reads inside `budgetService.registerDeposit`. It is one source, not a published copy that can drift, and `src/routes/auth.deposit-info-minimum.test.ts` pins it from both edges: the published amount credits, one micro-dollar under it does not. The practical consequence is that the money path's configuration is verifiable from outside with a plain `curl` and no credentials. Measured today, the four networks publish the same `deposit_minimum_usdc: "1"` and `deposits_enabled: true`, which is the contract rather than a coincidence: the minimum belongs to the deposit path, not to a chain. With no minimum configured the field is `null` and `deposits_enabled` is `false`, never `"0"`, because a zero would read as "send whatever you like" while the guard in that state rejects every deposit.
- **No: inbound x402.** The inbound challenge is still EVM. `x-payment-chain: solana-devnet` stops with `400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED` (`src/middleware/x402.ts`), a typed error that also names the two ways out: another chain for the x402, or a prepaid key to keep operating on `solana-devnet`.

Turning the rail on: `SOLANA_ADAPTER_ENABLED=true`, `solana-devnet` inside `WASIAI_A2A_CHAINS`, `SOLANA_OPERATOR_PRIVATE_KEY` (base58, with devnet SOL for gas) and `WASIAI_DOWNSTREAM_X402=true`. Inbound deposits are a second switch on top of that one, in this order: apply the `20260731000000_wkh315_solana_deposit.sql` migration, set `A2A_DEPOSIT_OWNER_SOLANA` (the owner pubkey, not the destination) and `A2A_DEPOSIT_MIN_USDC`, and only then `A2A_DEPOSIT_ENABLED_SOLANA=true`. Without the minimum the path stays closed and answers `503 DEPOSIT_MINIMUM_NOT_CONFIGURED` instead of crediting on trust. The RPC default (`https://api.devnet.solana.com`), devnet USDC mint (Circle's, `4zMMC9sr…`), decimals, commitment and CAIP-2 are all in `.env.example` and do not need touching.

**There is no Solana mainnet support.** Devnet only, zero production money. The non-custodial escrow lives in the `wasiai-facilitator` service, not here: `SOLANA_ESCROW_PROGRAM_ID` belongs to that repo and this gateway never reads it.

---

## Architecture

Three services, one shared Postgres database (Supabase):

```
app.wasiai.io (Vercel)            thin proxy + marketplace UI
        |  x-wasiai-forward-key (HMAC)
        v
wasiai-a2a (Railway, this repo)   /discover /compose /orchestrate /tasks /mcp
        |  x402 /verify and /settle (EVM legs only)
        v
wasiai-facilitator (Railway)      signs and settles per network
        v
                                  Solana / Avalanche / Base / Kite
```

The Solana leg is the exception to that diagram. By default it does not go through the facilitator: the gateway operator signs the SPL transfer and broadcasts it against the devnet RPC, because there is no EIP-3009 equivalent on the other side. With `SOLANA_SETTLE_VIA_FACILITATOR=true` that signing is delegated to the facilitator (`POST /solana/payout`) and the gateway signs nothing, not even as a fallback: a facilitator that is down means an unsettled leg, not an excuse to become a money path again. The flag starts off, and with it off the behavior is the previous one.

Inside the gateway there are four layers:

| Layer | What it holds |
|---|---|
| L4 public API | `/discover`, `/compose`, `/orchestrate`, agent cards, `/tasks`, `/auth`, `/dashboard` |
| L3 building blocks | identity (`wasi_a2a_*`), budget per key and per chain with atomic debit, scoping, rate limits |
| L2 adapters | `PaymentAdapter`, `AttestationAdapter`, `GaslessAdapter`, `IdentityBindingAdapter` |
| L1 infra | RPCs and contracts for each network |

The non-obvious decision here is that **identity, budget and authorization live off-chain (L3) and are our own**, not delegated to the chain. The reason is cost: the A2A cycle is polling plus micropayments of fractions of a cent, and resolving every authorization on-chain costs more than the service being bought. The chain only comes in when real money has to move.

Full detail in [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md) and [`doc/architecture/MULTI-CHAIN.md`](doc/architecture/MULTI-CHAIN.md).

---

## Endpoints

Every row below was read off `src/routes/` with the prefixes registered in `src/index.ts:270-313`. That is a claim about each row, not a claim that the table is generated or exhaustive — nobody here checks it mechanically, so re-derive it yourself if you are going to rely on it: `grep -rnE 'fastify\.(get|post|put|patch|delete)' src/routes/`. `/mock-registry/agents` shows up in that grep and is deliberately absent from the tables: it is mounted only outside production (`src/index.ts:292-297`).

**Public, free**

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | service info |
| `GET` | `/health` | health probe |
| `GET` | `/.well-known/agent.json` | the gateway's own agent card. The same identity is anchored on-chain in the [Solana Agent Registry](https://explorer.solana.com/address/8EQfLhMG9aKTgxS5YarUmg9SsUWqCFa4ZQ8NMR2HzFde?cluster=devnet) |
| `GET \| POST` | `/discover` | search agents across all registries |
| `GET` | `/discover/:slug` | a single agent |
| `GET` | `/capabilities` | methods, initialized chains and catalog |
| `GET` | `/agents/:slug/agent-card` | A2A agent card of an agent |
| `GET` | `/registries`, `/registries/:id` | registered marketplaces (outbound credentials are never serialized) |
| `GET` | `/gasless/status` | gasless module status |
| `GET` | `/dashboard`, `/dashboard/trace` | analytics and trace UI |

`GET /metrics` exposes the Prometheus format, but it is protected by `METRICS_TOKEN` and is fail-closed: in production, if the variable is not set, it answers `503` instead of exposing metrics. Everything under `/dashboard/api/*` returns cross-tenant data and sits behind an operator token (`DASHBOARD_ADMIN_TOKEN`); the dashboard HTML is public because it carries no data inside, the browser fetches it from that gated API.

A single operation asks for **two** credentials: `POST /dashboard/api/reconciliation/:intentId/release-lease` additionally requires `RECONCILIATION_RELEASE_TOKEN` (header `X-Reconciliation-Release-Token`), which must be a secret distinct from the panel token. It is the only operation that makes a row payable **without proof** (it attests a negative that cannot be verified, and the reconciler resends the payment), so it does not share a credential with the reads nor with its sibling `hop2-evidence`, whose hash is verified on-chain. If `RECONCILIATION_RELEASE_TOKEN` is not configured, the operation answers `503` in production **and** in development.

**Credentialed**

| Method | Path | Charges | Description |
|---|---|---|---|
| `POST` | `/compose` | yes | runs an explicit pipeline |
| `POST` | `/orchestrate` | yes | runs from a goal |
| `POST` | `/orchestrate/plan` | no debit | plans and quotes without executing or settling |
| `POST` | `/orchestrate/execute` | yes | runs an already approved plan, with a cost ceiling |
| `POST` | `/registries` · `PATCH \| DELETE /registries/:id` | yes | marketplace registration and management |
| `POST` | `/agents` · `PATCH \| DELETE /agents/:slug` | no | self-serve agent publishing. The optional `payment` block, which declares the chain and wallet the agent charges on, is documented in [INTEGRATION.md](doc/INTEGRATION.md#declaring-where-your-agent-gets-paid-payment) |
| `GET` | `/agents` | no | lists your own agents, filtered by the caller's owner |
| `POST` | `/agents/:slug/link` · `/agents/links/:token/redeem` | depends on the link | scoped invocation links |
| `POST` | `/mcp` | depends on the method | MCP server (JSON-RPC) |
| `POST` | `/inbound/:source/tasks` | yes | external task intake by webhook, authenticated with HMAC |
| `POST` | `/gasless/transfer` | yes | on-chain transfer signed by the operator wallet. The debit is refunded on the three paths where nothing leaves — RPC down, module not operational, transfer failed — each one calling `refundGaslessDebit` in `src/routes/gasless.ts` |
| `GET` | `/receipts`, `/receipts/:id`, `/receipts/:id/verify` | no | HMAC-chained receipts of the caller's own operations; `/verify` recomputes the hash and reports tampering |

Publishing an agent is free on purpose: charging for listing discourages exactly what the catalog needs. Charging goes where execution happens.

**Tasks (A2A)**, tenant mandatory: they only return the caller's own, and the anonymous x402 rail does not apply.

| Method | Path | Cost |
|---|---|---|
| `POST` | `/tasks` | $1 |
| `GET` | `/tasks`, `/tasks/:id` | free |
| `PATCH` | `/tasks/:id/status`, `/tasks/:id` | $1 |

Reading a task is free on purpose. The A2A lifecycle is driven by polling `GET /tasks/:id`, so charging for reads meant a poll every 5 seconds cost 720 USD per hour: the price was fighting the protocol. Free reads do not emit a `402` challenge because there is nothing to pay.

**Identity and budget**: `POST /auth/agent-signup`, `GET /auth/me`, `GET /auth/deposit-info`, `POST /auth/deposit` (verifies the deposit on-chain before crediting; accepts either a Solana signature or an EVM hash, and rejects before hitting the network if the reference does not match the requested chain; the Solana leg is behind `A2A_DEPOSIT_ENABLED_SOLANA` and is on in the live deployment, see [Solana rail](#solana-rail)), `POST|GET|DELETE /auth/key-session`, `POST|GET|DELETE /auth/delegation`, `PUT|GET|DELETE /auth/keys/me/spend-policies`, `POST /auth/erc8004/bind`, `GET /auth/erc8004/resolve/:token_id`. `POST /auth/bind/:chain` still returns `501`: it is a declared placeholder, not a function.

Four more under the same prefix, all writing on the caller's own key and all with the key id taken from the authenticated caller and never from the body: `POST /auth/funding-wallet` binds a funding wallet with proof of control (the caller signs `WASIAI_BIND_FUNDING_WALLET:<key_id>` on EVM or `WASIAI_BIND_FUNDING_WALLET_SOLANA:<key_id>` on Solana — two different texts on purpose: the preimages already differ today anyway (EIP-191 prefixes its message, a Solana wallet signs raw bytes), and the namespace is there so that non-collision does not rest on a wallet convention this repo does not control — and from then on `/auth/deposit` requires the transfer to come from that wallet), and `PATCH /auth/agent-key/:id/require-signature` plus `PATCH /auth/key-session/:id/require-signature` toggle the EIP-712 per-request signature on the master key and on a sub-session. `POST /auth/bind-passport` binds a Kite Agent Passport, and it only exists when `PASSPORT_BINDING_ENABLED=true`: with the flag off the route is not mounted at all and the answer is a plain `404`, not a `403`.

**Scheduled payments**: `POST /payments/session` (metered, with vouchers and closing) and `POST /payments/upto` (ceiling signed by both parties), plus their `/settle`, `/close` and `/dispute`.

---

## Running it locally

Node 22 or higher (`engines` in `package.json`; CI runs 22).

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a
npm install

cp .env.example .env
# minimum to boot: SUPABASE_URL, SUPABASE_SERVICE_KEY,
# KITE_WALLET_ADDRESS (or PAYMENT_WALLET_ADDRESS) and ANTHROPIC_API_KEY

npm run dev          # tsx watch, listens on 3001
```

The default port is 3001 and not 3000, so it does not collide with a Next.js running next to it.

That minimum brings up the gateway with the default EVM rail: the Solana rail needs its own flag and its operator key ([Solana rail](#solana-rail)). And if `WASIAI_A2A_CHAINS` held **only** `solana-devnet`, the process still boots but no chain is left that accepts inbound x402 charging: in that config the only way to charge is the prepaid key.

Real scripts from `package.json`:

| Script | What it does |
|---|---|
| `npm run dev` | server with reload (`tsx watch`) |
| `npm run build` | `tsc` into `dist/` plus static copy |
| `npm start` | runs `dist/index.js` |
| `npm test` | full suite (Vitest) |
| `npm run test:coverage` | suite with coverage and thresholds |
| `npm run lint` | Biome over `src/` |
| `npm run format` | Biome with writes |
| `npm run smoke:downstream` | network smoke of the outbound payment leg |
| `npm run migrate:preflight` | migration preflight check |

Without a real `SUPABASE_URL` the server still boots and answers `/health`, but anything touching catalog or budget fails: persistence is not optional.

`.env.example` documents **183 variables** with their defaults (counted with `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example`, and that same count is re-derived by `test/readme-numbers.test.ts` on every `npm test`), and the few that change money behavior are grouped together there.

Two boot guards worth knowing before touching mainnet config:

- The process **refuses to boot** if the chain slug and the adapter's network variable contradict each other (for example the Kite testnet slug with `KITE_NETWORK=mainnet`, which would point the "testnet" bundle at chain 2366 with real money).
- The outbound leg toward any mainnet requires an explicit opt-in in `WASIAI_DOWNSTREAM_MAINNET_ALLOW`. Empty or absent means no mainnet leg settles: it stops with `MAINNET_NOT_ALLOWED`. Fail-closed on purpose.

**Two independent gates for real money**: There are two separate checks before a payment to a mainnet chain reaches production. Neither one alone is enough; both must pass:

1. **First gate: the facilitator**. The settlement service (`wasiai-facilitator`) registers chains only when their adapter is enabled (flag like `*_ENABLED`) and the RPC endpoint is configured. If a network is not registered there, the adapter does not exist, and settlement cannot proceed.

2. **Second gate: this repo**. Even if a mainnet chain is registered in the facilitator, this gateway will not invoke it unless the chain slug is listed in `WASIAI_DOWNSTREAM_MAINNET_ALLOW`. The check happens at runtime (`src/lib/downstream-payment.ts:186-194`); if the chain is mainnet and not in the opt-in, the settle is skipped with `code: 'MAINNET_NOT_ALLOWED'` (line 740) and mapped to the action `OPERATOR_DECIDE_MAINNET_OPT_IN` (src/lib/downstream-skip-code.ts:306). This behavior is fail-closed: an empty or missing variable blocks all mainnet legs.

An example: on August 14, 2026, the production facilitator's `/supported` endpoint returned four chains (Kite Testnet, Avalanche Fuji, Base Sepolia, Solana Devnet), none of them mainnet. That means the first gate was already closed. However, even if it returned Avalanche C-Chain mainnet (43114) in the future, it would still be blocked unless that chain is listed in `WASIAI_DOWNSTREAM_MAINNET_ALLOW` and redeploys. That double-lock is by design: testing one variable in a configuration is not enough proof that a real money path is safe.

---

## Tests

```bash
npm test
```

State measured in this repo, not quoted from another document. Each number below is either re-derived on every `npm test` by `test/readme-numbers.test.ts`, or written with the date it was measured on so that it does not silently rot:

| Metric | Value |
|---|---|
| Test files | **295 test files** in the root suite. Derived from the `include` of `vitest.config.ts` over the git index, and checked in both READMEs, by `test/readme-numbers.test.ts` |
| Test cases | printed by `npm test`. Deliberately not written down here: it changes with every test added, and a test that pinned it would have to run the suite it is counting |
| Coverage floor enforced by CI | statements **80%**, branches **70%**, functions **80%**, lines **80%** (`vitest.config.ts:26-31`). Below any of the four, `npm run test:coverage` exits non-zero and the `coverage` job fails |
| Coverage measured | `npm run test:coverage` printed 87.49% statements, 79.64% branches, 92.48% functions and 89.02% lines on 2026-08-15 |
| Typecheck | `tsc --noEmit` clean |
| Lint | `npm run lint` (Biome) over **489 files**, which is the `src/**/*.ts` of `biome.json` |
| CI | the `ci` badge at the top is the live result of `.github/workflows/ci.yml`, and nothing in this table overrides it |

Read the badge, not this table: if `ci` is red the workflow stopped at its first failing step, and every later step — the suite included — is reported as `skipped`, which is not the same as passed. The steps run in order (typecheck, lint, suite) with no `if: always()`, so a lint error alone is enough to leave the suite unrun on that commit.

A handful of files skip rather than run: the `*.real.test.ts` need a real Postgres and are gated on `INTEGRATION_TEST_DB_URL`, plus one manual e2e against devnet. They skip, they do not fail, so CI does not depend on a live database. `npm test` prints how many.

The 286 above is the root suite only. CI runs two more suites from sub-packages with their own runners, `mcp-servers/wasiai-x402` and `packages/agent-sdk`; they are not in that number, and `test/test-files-are-run-in-ci.test.ts` is what stops a third sub-package from being born with nobody running it.

Against the 2026-08-15 measurement, the enforced floor sits between 7.5 and 12.5 points lower. It is a ratchet for a collapse, not for a one-point regression: a floor pinned right under the measurement turns every refactor red and gets raised by whoever is in a hurry.

---

## On-chain evidence

Verifiable settlements. The Solana one is devnet (no real money) and was confirmed by RPC while writing this (`err: None`); the three Avalanche C-Chain ones are mainnet, with real money, and were also confirmed by RPC (`status: 0x1`).

| Tx | Network | What it was |
|---|---|---|
| [`3pNqu9jH…`](https://explorer.solana.com/tx/3pNqu9jHduGaXioB8Mf7WNvBgZQgJV4MnE6NDGWZdz6aY5gr2ivxfbwzrnweutSVtyKnvv7y7kXnARroktjyWsZx?cluster=devnet) | Solana devnet | Circle USDC-SPL outbound to the payout wallet of `remit-corridor-fx-solana`, 0.000001 |
| [`3jHFjCeY…`](https://explorer.solana.com/tx/3jHFjCeYpXUdcGSPM7NkUzzUgNyQ3Z7htdtg39t8rUaemJuWV5JkSCPRiv6NadYkKj9PWMQpnPfZqg23mFZFq2ER?cluster=devnet) | Solana devnet | The gateway registering **itself** as an agent in the [Solana Agent Registry](https://explorer.solana.com/address/8EQfLhMG9aKTgxS5YarUmg9SsUWqCFa4ZQ8NMR2HzFde?cluster=devnet), 0.0034 rent |
| [`0x9fa6ff83…`](https://snowtrace.io/tx/0x9fa6ff83eb10e51685ce078e69f9c42fcbe3b138b5b8c3f32909c9fee279c6f1) | Avalanche C-Chain (43114) | USDC outbound to `wasi-chainlink-price`, $0.001 |
| [`0xa22086d0…`](https://snowtrace.io/tx/0xa22086d048b0222a8e08a5ca08997ae6c359e5ba674e63133a0ffbc463af16f9) | Avalanche C-Chain (43114) | USDC outbound to `wasi-defi-sentiment`, $0.010 |
| [`0xca10320c…`](https://snowtrace.io/tx/0xca10320c24ff513d773ce65e0bd306d4acce3e4883180c9dca5573da6cf1dfdb) | Avalanche C-Chain (43114) | USDC outbound to `wasi-wallet-profiler`, $0.050 |
| [`0x6f406c08…`](https://testnet.kitescan.ai/tx/0x6f406c08f6e59e3c5029f57ec3a84bb4596b94bb02568055ec4f9572981a1bf9) | Kite testnet (2368) | PYUSD inbound, 1.0 |

The registry row is a different kind of evidence from the others: it is not a payment, it is the coordinator's own identity. The gateway publishes an agent card at `/.well-known/agent.json`, and that card is served by a domain we control. The registry entry is not: it is an MPL Core asset on Solana whose account data points at an IPFS document listing the three orchestration skills and `x402Support: true`, a field the registry itself defines. Anyone can read it without asking us anything.

Being registered is not the same as being discovered. Nobody has found this gateway through the registry yet, and that sentence stays here until someone does.

On Base Sepolia there are five documented runs (three standalone settlements, one end-to-end `/compose` and one of the outbound leg), with hashes and verification method in [`doc/BASE-EVIDENCE.md`](doc/BASE-EVIDENCE.md).

None of those numbers come from an internal document: anyone can paste the hash into an `eth_getTransactionReceipt` against the network's public RPC and compare. For the Solana signature the equivalent is a `getTransaction` against `https://api.devnet.solana.com`: it returns `meta.err: null` and the pre/post balance pair for the Circle mint that proves the transfer.

---

## Documentation

| Document | Contents |
|---|---|
| [`doc/solana-labs/`](doc/solana-labs) | Solana LATAM Labs program deliverables: roadmap (M1), business (M2) and MVP architecture (M3) |
| [`doc/INTEGRATION.md`](doc/INTEGRATION.md) | integration guide: auth, onboarding, x402, error codes, examples |
| [`doc/integration-base.md`](doc/integration-base.md) | Base-specific integration and facilitator choice |
| [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md) | L1 to L4 architecture and adapter interfaces |
| [`doc/architecture/MULTI-CHAIN.md`](doc/architecture/MULTI-CHAIN.md) | chain selection, alias table, mainnet activation |
| [`doc/architecture/FEE-MODEL.md`](doc/architecture/FEE-MODEL.md) | fee and split model, with a worked example |
| [`doc/BASE-EVIDENCE.md`](doc/BASE-EVIDENCE.md) | on-chain proofs of the Base adapter |
| [`doc/kite-contracts.md`](doc/kite-contracts.md) | Kite contracts and tokens |
| [`doc/sdd/_INDEX.md`](doc/sdd/_INDEX.md) | index of specs, reviews and QA reports for every change |
| [`HACKATHON-FINAL.md`](HACKATHON-FINAL.md) | historical record of the Kite hackathon submission |

---

## Contributing

Every change goes through a pipeline with human gates between roles (analysis, architecture, development, adversarial review, QA, closing). Each role's artifacts land in `doc/sdd/NNN-title/` and the method is detailed in [`CLAUDE.md`](CLAUDE.md).

When opening a PR: branch from `main` with a `feat/` or `fix/` prefix, and neither the adversarial review nor the code review is skipped in a PR that touches code.

## License

[MIT](LICENSE)
