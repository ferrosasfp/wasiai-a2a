# Networks Supported

WasiAI A2A is **chain-adaptive**: a single deployment can settle inbound
payments on one chain and outbound (downstream) payments to agents on a
different chain.

## Every chain slug the code knows

This is the full `ChainKey` union from `src/adapters/types.ts`. A test
(`src/adapters/chain-docs.test.ts`) fails the build if a slug is added
there and not named on this page, so this table cannot silently fall
behind the union. The test does not check the columns to its right: those
are maintained by hand and can be stale even while the test is green.

| Slug | chainId | Enters the supported set |
|---|---:|---|
| `kite-ozone-testnet` | 2368 | always; also the fallback when neither `WASIAI_A2A_CHAINS` nor `WASIAI_A2A_CHAIN` is set |
| `kite-mainnet` | 2366 | always, but see the coupling warning below |
| `avalanche-fuji` | 43113 | always |
| `avalanche-mainnet` | 43114 | always; the outbound leg needs a second opt-in |
| `base-sepolia` | 84532 | always |
| `base-mainnet` | 8453 | always |
| `tempo-testnet` | 42429 | only with `TEMPO_ADAPTER_ENABLED=true` |
| `solana-devnet` | non-EVM; synthetic sentinel, `900001` unless `SOLANA_SYNTHETIC_CHAIN_ID` overrides it | only with `SOLANA_ADAPTER_ENABLED=true` |

"Enters the supported set" is about `getSupportedChains()` in
`src/adapters/registry.ts`, not about what a given deployment runs. A slug
is only initialized if it is listed in `WASIAI_A2A_CHAINS`; one that is
not listed answers `CHAIN_NOT_SUPPORTED`. To see what the deployment you
are talking to actually initialized, ask it:
`curl <YOUR_GATEWAY_URL>/capabilities | jq '.chains'`.

The Kite and Avalanche sections below carry the asset, token contract and
explorer detail. Base, Tempo and Solana are wired in code but have no
section on this page yet; for Solana, the README's "Solana rail" section
is the maintained description.

> **Status legend**
> - **Active by default** — works out of the box, no env flags required.
> - **Staged — requires operator funding** — code path implemented and
>   tested, but the operator wallet must be funded with the listed asset on
>   that chain and the relevant env flag flipped (the `kite-mainnet` slug in
>   `WASIAI_A2A_CHAINS`, or `WASIAI_DOWNSTREAM_MAINNET_ALLOW=avalanche-mainnet`
>   for the downstream leg). Until both are true these chains are not active.

---

## Inbound payments — Kite

Inbound = the chain on which **you** (the developer / agent) pay WasiAI to
unlock a `/compose` or `/orchestrate` call. The protocol uses x402 with
EIP-712 signatures over EIP-3009 `TransferWithAuthorization`.

Kite is not the only inbound rail. `acceptsInboundPayment` in
`src/adapters/registry.ts` returns `true` for every EVM bundle, so any
initialized EVM chain can take the inbound leg, including Avalanche Fuji
and Base Sepolia. It returns `false` for Solana, which is outbound only:
sending `x-payment-chain: solana-devnet` to `POST /compose` answers
`400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED`. Only the Kite rows have their
asset and EIP-712 detail written out below.

| Chain | Chain ID | x402 network tag | Asset | Token contract | Explorer | Status |
|-------|---------:|------------------|-------|----------------|----------|--------|
| KiteAI Testnet | `2368` | `eip155:2368` | PYUSD (6 decimals) | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` | https://testnet.kitescan.ai | Active by default |
| KiteAI Mainnet | `2366` | `eip155:2366` | USDC.e (6 decimals) | `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` | https://kitescan.ai | Staged — requires operator funding |

### Activation flags

- **Default** — `KITE_NETWORK` unset (or any value other than `mainnet`)
  selects testnet. PYUSD on chain `2368` is the asset accepted.
- **Mainnet opt-in** — set BOTH `WASIAI_A2A_CHAINS=kite-mainnet` (with **no**
  Kite *testnet* slug in the CSV) AND `KITE_NETWORK=mainnet`, plus
  `KITE_MAINNET_RPC_URL`, and ensure the operator wallet has USDC.e on KiteAI
  mainnet. PYUSD does not exist on mainnet; do not attempt to pay with it there.
  Canonical source: [`doc/architecture/MULTI-CHAIN.md`](../doc/architecture/MULTI-CHAIN.md) §8.
- ⚠️ **The two envs are coupled** (fix-pack 2026-07-26, probed with the real
  factories). `getKiteChain()` reads `KITE_NETWORK` at **call time**, while the
  `{ network: 'mainnet' }` the registry passes to the factory only pins
  `chainConfig`:
  - `KITE_NETWORK=mainnet` **alongside a Kite testnet slug** silently repoints
    the `kite-ozone-testnet` bundle at chain `2366` (real USDC.e) — the gateway
    now **refuses to start** on that combination (`assertNoSlugDestinationDrift`).
  - the `kite-mainnet` slug **without** `KITE_NETWORK=mainnet` starts, but the
    payment adapter signs on `2368` with **testnet PYUSD**; the registry logs
    `code=ADAPTER_CHAIN_ID_DRIFT`.
  - therefore both Kite rails **cannot run in the same process** until
    `TD-NEW-KITE-PARAMS` lands.

### EIP-712 domain (inbound)

The x402 facilitator validates the signature against the domain returned
by the active payment adapter. For the Kite adapter the domain fields are:

| Network | `name` | `version` | `chainId` | `verifyingContract` |
|---------|--------|-----------|-----------|---------------------|
| Kite testnet | `PYUSD` | `1` | `2368` | PYUSD contract above |
| Kite mainnet | `USDC` | `2` | `2366` | USDC.e contract above |

Use the values from the live `accepts[0]` payload in the 402 response —
do not hardcode them. See [getting-started.md](./getting-started.md) for
the full client-side signing recipe.

### Inline `chain.ts` — copy-pasteable

The TypeScript samples in [getting-started.md](./getting-started.md)
import `kiteTestnet` from `./chain`. If you are not cloning the repo,
drop the following file into your project as `chain.ts` — it mirrors
`src/adapters/kite-ozone/chain.ts` at HEAD (`e448993`). When the source
file is updated in a future HU, this block is updated in the same PR
(see [CD-WKH87-4 in WKH-87](./getting-started.md)).

```ts
// chain.ts — mirror of src/adapters/kite-ozone/chain.ts
import { defineChain } from 'viem';

export const kiteTestnet = defineChain({
  id: 2368,
  name: 'KiteAI Testnet',
  nativeCurrency: { decimals: 18, name: 'KITE', symbol: 'KITE' },
  rpcUrls: {
    default: { http: ['https://rpc-testnet.gokite.ai/'] },
    public: { http: ['https://rpc-testnet.gokite.ai/'] },
  },
  blockExplorers: {
    default: { name: 'KiteScan', url: 'https://testnet.kitescan.ai' },
  },
  testnet: true,
});

/**
 * KiteAI Mainnet — chainId 2366. Stablecoin canonical es USDC.e
 * (`0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`); PYUSD NO existe en mainnet.
 *
 * Activación: setear `KITE_NETWORK=mainnet` en env. Default permanece
 * `testnet` para preservar comportamiento existente (zero breaking change).
 */
export const kiteMainnet = defineChain({
  id: 2366,
  name: 'KiteAI Mainnet',
  nativeCurrency: { decimals: 18, name: 'KITE', symbol: 'KITE' },
  rpcUrls: {
    default: { http: ['https://rpc.gokite.ai/'] },
    public: { http: ['https://rpc.gokite.ai/'] },
  },
  blockExplorers: {
    default: { name: 'KiteScan', url: 'https://kitescan.ai' },
  },
  testnet: false,
});

/**
 * Selecciona Kite chain según `KITE_NETWORK`. Default `testnet`.
 * Ningún otro valor está soportado; si se setea algo distinto a `mainnet`
 * caemos a testnet (fail-safe — preserva el path probado).
 */
export type KiteNetwork = 'testnet' | 'mainnet';

export function getKiteNetwork(): KiteNetwork {
  return process.env.KITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
}

export function getKiteChain() {
  return getKiteNetwork() === 'mainnet' ? kiteMainnet : kiteTestnet;
}
```

The four exports (`kiteTestnet`, `kiteMainnet`, `getKiteNetwork`,
`getKiteChain`) are the only public symbols of `chain.ts`; the
`viem` peer dep is the only external import.

---

## Outbound payments — Avalanche

Outbound = the chain on which **WasiAI** pays the downstream agent
(merchant) on your behalf when a `/compose` step is settled. The flag
`WASIAI_DOWNSTREAM_X402` must be `true` for the downstream settle to fire.

Avalanche is not the only outbound rail either. The leg chain comes from
the agent's card, so any initialized chain can receive it, and Solana
devnet is the rail the remittance agents in the live catalog declare. The
Avalanche tables below are the only ones on this page with asset and
contract detail; that is a gap in this page, not a limit of the code.

| Chain | Chain ID | x402 network tag | Asset | Default token contract | Explorer | Status |
|-------|---------:|------------------|-------|------------------------|----------|--------|
| Avalanche Fuji | `43113` | `eip155:43113` | USDC (6 decimals) | `0x5425890298aed601595a70AB815c96711a31Bc65` | https://testnet.snowtrace.io | Active by default |
| Avalanche C-Chain | `43114` | `eip155:43114` | USDC (6 decimals) | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | https://snowtrace.io | Staged — requires operator funding |

### Activation flags

- **Default (fail-closed)** — `WASIAI_DOWNSTREAM_MAINNET_ALLOW` unset or
  empty ⇒ NO mainnet chain can settle the downstream leg: the leg is
  skipped with `MAINNET_NOT_ALLOWED` before any signing. The leg chain
  comes from `agent.payment.chain` (WKH-112), never from an env var — the
  old `WASIAI_DOWNSTREAM_NETWORK` is NOT read by any code path.
- **Mainnet opt-in** — set
  `WASIAI_DOWNSTREAM_MAINNET_ALLOW=avalanche-mainnet` (CSV; numeric
  aliases like `43114` also accepted), have `avalanche-mainnet` in
  `WASIAI_A2A_CHAINS`, AND fund the operator wallet with USDC on
  Avalanche C-Chain.
- **What the pre-flight balance check actually does** (corrected
  2026-07-26, fix-pack AR-profundo CR-MNR-10 — this bullet previously
  claimed "the request fails before any signing happens", which is
  false on both counts):
  - If the operator balance is below the leg amount, only **that leg**
    is skipped: `signAndSettleDownstream` logs `INSUFFICIENT_BALANCE`
    and returns `null`. **The request does NOT fail** — the agent is
    still invoked and its output still returned; it simply does not get
    paid on that leg (`src/lib/downstream-payment.ts`, step 9).
  - The check only runs when BOTH the chain's RPC env var and
    `OPERATOR_PRIVATE_KEY` (starting with `0x`) are present. Otherwise it
    is skipped and **the leg signs and settles without any funds
    verification**. On mainnet that is the dangerous case, so
    double-check the env NAME: the gateway's Avalanche rail reads
    `AVALANCHE_RPC_URL` (not `AVALANCHE_MAINNET_RPC_URL`, which is the
    facilitator's) — see `RPC_ENV_BY_CHAIN` in
    `src/lib/downstream-payment.ts`.
  - ⚠️ **Only the missing-RPC case is logged.** The
    `BALANCE_PRECHECK_SKIPPED` code is emitted from the `if (!rpc)` guard
    (and, on Solana, from the `getOperatorSplBalance()` catch). With the
    RPC present but `OPERATOR_PRIVATE_KEY` absent/malformed, the
    `if (pk?.startsWith('0x'))` branch has no `else` and the pre-check is
    skipped **with no log at all** — do not use the absence of
    `BALANCE_PRECHECK_SKIPPED` as evidence that the pre-check ran.
    (Corrected 2026-07-26, re-CR MENOR-4: this bullet promised a signal
    that does not exist.) Practical impact is nil — without the PK the
    subsequent `adapter.sign` fails anyway (`SIGNING_FAILED`) — which is
    exactly why the gap was left as-is instead of touching the
    already-reviewed money-path block.
  - It is an observability/short-circuit optimisation, not a money gate.
    The authoritative failure is the on-chain settle itself.

### Custom token contracts

You can override the default Circle USDC addresses via env:

- `FUJI_USDC_ADDRESS` — overrides the Fuji default.
- `AVALANCHE_USDC_ADDRESS` — overrides the C-Chain default.
- `FUJI_USDC_EIP712_VERSION` / `AVALANCHE_USDC_EIP712_VERSION` — override
  the EIP-712 domain version (default `2`).

These are operator-side flags only. As a developer integrating with the
hosted gateway you do not need to set them; they affect what the gateway
posts to its facilitator.

---

## Discovery and chain filtering

`/discover` does **not** accept a `chain` query parameter, and since
WKH-322 it does not ignore it either: `?chain=avalanche` comes back as
`400 UNKNOWN_DISCOVER_PARAM` with the accepted names in the message. The
accepted list is not repeated here on purpose, because it moved twice in
one week and this page fell behind both times. The canonical table lives
in [api-reference.md](./api-reference.md#discovery), and the error body
itself is the runtime answer.

The discovery service does not filter results by chain. To choose a rail,
read the `payment` block on each result:

| Field | Who writes it | What it means |
|---|---|---|
| `payment.chain` | the agent, in its own card | the slug the publisher typed. Several are ambiguous: as of 2026-08-05, 16 of the 25 agents in the production catalog declare `avalanche`, which reads like the real network and resolves to Fuji. |
| `payment.resolvedChain` | derived by the gateway | the canonical rail that slug resolves to, e.g. `avalanche` becomes `avalanche-fuji`. |
| `payment.network` | derived by the gateway | `testnet` or `mainnet`. This is **not** an x402 CAIP-2 tag; a tag like `eip155:43113` appears in `accepts[0].network` of a `402` challenge, which is a different payload. |

What `payment.network` promises, narrowly: either the payment lands in
that environment or there is no payment. The downstream leg compares the
slug's environment against the bundle's real destination before signing
and returns without paying on a mismatch
(`findChainEnvironmentDrift`, `CHAIN_ENVIRONMENT_DRIFT` in
`src/lib/downstream-payment.ts`). What it does not promise: the chainId
the deployment points at, which config such as `KITE_NETWORK` can move.

If you want chain-restricted results, the supported approaches today are:

- **Filter by registry.** Use `?registry=<name>` to scope results to a
  registry whose listed agents are all priced on the same chain (this is
  registry-curation, not a chain-aware filter).
- **Post-filter client-side** on `payment.resolvedChain` rather than on
  `payment.chain`, and drop rows that do not match your wallet's funded
  rail. Both fields are optional in the type, because the same interface
  also describes the raw card an agent declares; on the `/discover` path
  they are always set, since `readPaymentSpec` is the only producer of
  `Agent.payment`.

The downstream payment chain (Fuji vs C-Chain) is decided per-call by the
gateway based on the operator env flags above and is independent of any
discovery-side filtering.

---

## Roadmap chains

- **Kite Passport identity binding** — `[ROADMAP — WKH-69]`. When
  shipped, A2A keys will optionally bind to a Kite Passport DID for
  on-chain reputation. This bullet used to add that
  `bindings.kite_passport` on `GET /auth/me` is always `null`; that is
  conditional, not universal. See the Kite Passport section of
  [getting-started.md](./getting-started.md) for the flag that decides it.
- **Base is not a roadmap chain.** `base-sepolia` and `base-mainnet` are
  members of the `ChainKey` union and unconditional members of
  `SUPPORTED_CHAINS` in `src/adapters/registry.ts`, with a factory branch
  each (`createBaseAdapters`) and no feature flag. This bullet used to
  group Base with Optimism and Arbitrum and tell the reader not to assume
  it works. What is still true is narrower: a slug is only usable if the
  deployment lists it in `WASIAI_A2A_CHAINS`. The README reports Base
  Sepolia among the chains initialized on the production deployment and no
  mainnet at all, measured against `/capabilities` on 2026-08-04; that
  reading was not repeated for this edit. Check it yourself with
  `curl <YOUR_GATEWAY_URL>/capabilities | jq '.chains'` rather than
  trusting this sentence.
- Optimism and Arbitrum are not in the code: neither string appears
  anywhere under `src/`, so there is no slug to configure and any attempt
  to name one is a startup `Unsupported chain` error.

---

## Source of truth

If anything on this page disagrees with the running service, the
running service wins. The canonical sources inside the repo are:

- `src/adapters/types.ts`: the `ChainKey` union, which is the complete
  list of slugs. `src/adapters/chain-docs.test.ts` fails when a slug there
  is missing from this page.
- `src/adapters/registry.ts`: which slugs enter the supported set, which
  ones sit behind a flag, and `acceptsInboundPayment`.
- `src/adapters/chain-resolver.ts`: `CANONICAL_CHAIN_ID`, the slug to
  chainId map.
- `src/adapters/kite-ozone/chain.ts` — Kite chain definitions.
- `src/adapters/kite-ozone/payment.ts` — inbound asset selection.
- `src/lib/downstream-payment.ts` — outbound chain selection.

Everything on this page except the slug column of the first table is
maintained by hand and can be stale while the test suite is green. Open a
PR against `docs/networks.md` if you spot drift.
