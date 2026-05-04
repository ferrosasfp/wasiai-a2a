# Networks Supported

WasiAI A2A is **chain-adaptive**: a single deployment can settle inbound
payments on one chain and outbound (downstream) payments to agents on a
different chain. This page lists every chain, asset, contract address and
explorer that the service knows about today.

> **Status legend**
> - **Active by default** — works out of the box, no env flags required.
> - **Staged — requires operator funding** — code path implemented and
>   tested, but the operator wallet must be funded with the listed asset on
>   that chain and the relevant env flag flipped (`KITE_NETWORK=mainnet` or
>   `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet`). Until both are true
>   these chains are not active.

---

## Inbound payments — Kite

Inbound = the chain on which **you** (the developer / agent) pay WasiAI to
unlock a `/compose` or `/orchestrate` call. The protocol uses x402 with
EIP-712 signatures over EIP-3009 `TransferWithAuthorization`.

| Chain | Chain ID | x402 network tag | Asset | Token contract | Explorer | Status |
|-------|---------:|------------------|-------|----------------|----------|--------|
| KiteAI Testnet | `2368` | `eip155:2368` | PYUSD (6 decimals) | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` | https://testnet.kitescan.ai | Active by default |
| KiteAI Mainnet | `2366` | `eip155:2366` | USDC.e (6 decimals) | `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` | https://kitescan.ai | Staged — requires operator funding |

### Activation flags

- **Default** — `KITE_NETWORK` unset (or any value other than `mainnet`)
  selects testnet. PYUSD on chain `2368` is the asset accepted.
- **Mainnet opt-in** — set `KITE_NETWORK=mainnet` on the gateway runtime
  AND ensure the operator wallet has USDC.e on KiteAI mainnet. PYUSD does
  not exist on mainnet; do not attempt to pay with it there.

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

| Chain | Chain ID | x402 network tag | Asset | Default token contract | Explorer | Status |
|-------|---------:|------------------|-------|------------------------|----------|--------|
| Avalanche Fuji | `43113` | `eip155:43113` | USDC (6 decimals) | `0x5425890298aed601595a70AB815c96711a31Bc65` | https://testnet.snowtrace.io | Active by default |
| Avalanche C-Chain | `43114` | `eip155:43114` | USDC (6 decimals) | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | https://snowtrace.io | Staged — requires operator funding |

### Activation flags

- **Default** — `WASIAI_DOWNSTREAM_NETWORK` unset (or any value other
  than `avalanche-mainnet`) selects Fuji. The operator wallet pays in
  Fuji USDC.
- **Mainnet opt-in** — set `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet`
  AND fund the operator wallet with USDC on Avalanche C-Chain. The
  pre-flight balance check returns `INSUFFICIENT_BALANCE` if the wallet
  is empty; the request fails before any signing happens.

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

`/discover` does **not** accept a `chain` query parameter at the query
layer — the supported query parameters are `q`, `capabilities`,
`maxPrice`, `minReputation`, `limit`, `registry`, `verified` and
`includeInactive` (see
[api-reference.md](./api-reference.md#discovery)). The agent's
`payment.chain` field on each result is **informational** — it indicates
which chain the agent expects to be paid on, but the discovery service
does not filter results by chain.

If you want chain-restricted results, the supported approaches today are:

- **Filter by registry.** Use `?registry=<name>` to scope results to a
  registry whose listed agents are all priced on the same chain (this is
  registry-curation, not a chain-aware filter).
- **Post-filter client-side.** Read each result's `payment.chain` field
  (or the `payment.network` x402 tag) and drop rows that do not match
  your wallet's funded chain.

The downstream payment chain (Fuji vs C-Chain) is decided per-call by the
gateway based on the operator env flags above and is independent of any
discovery-side filtering.

---

## Roadmap chains

- **Kite Passport identity binding** — `[ROADMAP — WKH-69]`. When
  shipped, A2A keys will optionally bind to a Kite Passport DID for
  on-chain reputation. Today the `bindings.kite_passport` field on
  `GET /auth/me` is always `null`.
- Other EVM chains (Base, Optimism, Arbitrum) are tracked in the backlog
  but not implemented; do not assume they work.

---

## Source of truth

If anything on this page disagrees with the running service, the
running service wins. The canonical sources inside the repo are:

- `src/adapters/kite-ozone/chain.ts` — Kite chain definitions.
- `src/adapters/kite-ozone/payment.ts` — inbound asset selection.
- `src/lib/downstream-payment.ts` — outbound chain selection.

Open a PR against `docs/networks.md` if you spot drift.
