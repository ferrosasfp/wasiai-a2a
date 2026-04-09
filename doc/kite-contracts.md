# Kite AI — Contract Source of Truth

> **Status**: LIVE source of truth (maintained)
> **Last updated**: 2026-04-09
> **Authoritative upstream**: https://docs.gokite.ai/kite-chain/3-developing/smart-contracts-list
> **Related**: `doc/architecture/CHAIN-ADAPTIVE.md` · `doc/spikes/kite-ozone.md` (historical, partially deprecated)

This document is the **single source of truth** within the `wasiai-a2a` codebase for official Kite AI contract addresses, token specs, and infrastructure endpoints. Any adapter in `src/adapters/kite-*/` should reference these values.

When the Kite team updates their official contract list, this file is the first thing to update, and then all adapters should be reviewed for alignment.

---

## 1. Kite Ozone Testnet (chain ID 2368)

Also referred to as **KiteAI Testnet** or **Kite L1 Testnet** in official docs. "Ozone" is a community/campaign name for the same chain.

### Network

| Parameter | Value |
|---|---|
| Chain name | KiteAI Testnet |
| Chain ID | `2368` |
| RPC URL | `https://rpc-testnet.gokite.ai/` |
| Explorer | `https://testnet.kitescan.ai` |
| Native faucet | `https://faucet.gokite.ai` (KITE native token only — **does NOT dispense PYUSD testnet**) |

### Tokens

| Symbol | Address | Decimals | Notes |
|---|---|---|---|
| **PYUSD** (gasless) | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` | 18 | **Only token supported by gasless relayer on testnet**. EIP-712 domain name: `"PYUSD"`. Minimum transfer: `10000000000000000` (0.01 PYUSD). No official faucet documented as of 2026-04-09. |
| **Test USDT** | `0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63` | 6 | Used for x402 payments (non-gasless flow). Obtained via StakeToken contract per Kite docs. |

### Core contracts

| Contract | Address | Notes |
|---|---|---|
| `GokiteAccount` (AA wallet, ERC-4337) | `0x93F5310eFd0f09db0666CA5146E63CA6Cdc6FC21` | Smart account implementation |
| `ServiceRegistry` | `0xc67a4AbcD8853221F241a041ACb1117b38DA587F` | Used for service discovery in Kite's native flow |

### Infrastructure endpoints

| Service | URL | Purpose |
|---|---|---|
| x402 facilitator | `https://facilitator.pieverse.io` | **Pieverse — blessed Kite path for x402 verification + settlement** (confirmed by Kite team 2026-04-09) |
| Gasless relayer | `https://gasless.gokite.ai/` | Receives EIP-3009 signed transfers and submits on-chain without requiring user to hold gas |

---

## 2. Kite Mainnet (chain ID 2366)

**Important**: The mainnet bridge was migrated from ViaLabs to **Lucid + LayerZero** as of 2026-04-09 (confirmed by Laughing from Kite team in Discord). Older ViaLabs `MessageClient.sol` references in our spike doc are historical and should not be used.

### Network

| Parameter | Value |
|---|---|
| Chain name | Kite Mainnet |
| Chain ID | `2366` |
| Explorer | `https://kitescan.ai` |
| Bridge UI | `https://app.lucidlabs.fi/bridge` (Lucid) |

### Tokens (bridged via Lucid)

| Symbol | Address | Decimals | Notes |
|---|---|---|---|
| **USDC.e** (bridged USDC for Kite) | `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` | 6 | **Only token supported by gasless relayer on mainnet**. EIP-712 domain name: `"Bridged USDC (Kite AI)"`, version `"2"`. |
| USDT (bridged) | `0x3Fdd283C4c43A60398bf93CA01a8a8BD773a755b` | 6 | Bridged via Lucid. |

### Lucid / LayerZero bridging

| Contract | Address | Notes |
|---|---|---|
| Lucid USDC controller | `0x92E2391d0836e10b9e5EAB5d56BfC286Fadec25b` | Mainnet controller for Lucid USDC.e |
| LayerZero executor (Kite side) | `0xe93685f3bBA03016F02bD1828BaDD6195988D950` | LayerZero executor contract for cross-chain messaging |

**Example bridge transaction**: https://kitescan.ai/tx/0x80c01af7d0be599932804ee1cf1dee8171dd9e34b699d735d404422d9a2852b3

### Infrastructure endpoints

| Service | URL | Purpose |
|---|---|---|
| Gasless relayer | `https://gasless.gokite.ai/` | Same endpoint as testnet — the relayer detects the chain by token address |

---

## 3. Deprecated — do not use

These contracts and flows have been **deprecated by the Kite team** (confirmed 2026-04-09). Any code referencing them should be updated or removed.

| Deprecated item | What it was | Replacement |
|---|---|---|
| `GokiteAccountFactory` at `0xF0Fc19F0dc393867F19351d25EDfc5E099561cb7` | Previously the official factory for Gokite Smart Wallets | **No longer the official factory.** Kite team confirmed this. New AA flow TBD. |
| `ViaLabs` / `MessageClient.sol` | Previous mainnet bridging implementation with signature `bridgeTokens(address asset, uint256 amount, string destination)` | **Replaced by Lucid + LayerZero.** See §2 Lucid / LayerZero bridging. |

See `doc/spikes/kite-ozone.md` for historical context (the spike was written before these deprecations).

---

## 4. Our operator wallet

The wasiai-a2a gateway uses a single operator wallet for x402 settlements and (when fully configured) EIP-3009 gasless signing.

| Field | Value |
|---|---|
| Address | `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` |
| Role as `KITE_WALLET_ADDRESS` | ✅ configured in Railway env — receives x402 payments (WKH-6) |
| Role as `OPERATOR_PRIVATE_KEY` (gasless signer) | ❌ not configured at 2026-04-09 — see WKH-38 graceful degradation |
| Funding state | See `GET /gasless/status` in production |

**Sourcing PYUSD testnet**: no official faucet documented. Multiple teams asked in Kite Discord (BuzzBD, Vitaly, WasiAI) — no response as of 2026-04-09. Our path forward is graceful degradation until PYUSD testnet liquidity is available.

---

## 5. Official documentation references

| Doc | URL |
|---|---|
| General Kite docs | https://docs.gokite.ai/ |
| Smart contracts list (upstream source of truth) | https://docs.gokite.ai/kite-chain/3-developing/smart-contracts-list |
| Gasless integration guide | https://docs.gokite.ai/kite-chain/9-gasless-integration |

---

## 6. Usage in wasiai-a2a adapters

The values in this doc are consumed by:

- `src/adapters/kite-ozone/*` (post-WKH-35 refactor) — single source of truth for Kite adapter configuration
- `src/lib/gasless-signer.ts` (pre-WKH-35) — currently hardcoded, will be extracted
- `src/lib/kite-chain.ts` (pre-WKH-35) — currently hardcoded chain config
- `.env.example` — documents env vars that reference these addresses

When adding a new chain (e.g., Avalanche adapter in post-v1 release), create a sibling doc `doc/avalanche-contracts.md` following this same structure.

---

## 7. Changelog

| Date | Change | Source |
|---|---|---|
| 2026-04-09 | Initial version created. Source of truth derived from Kite team clarification in Discord by Laughing, plus upstream https://docs.gokite.ai/kite-chain/3-developing/smart-contracts-list. Flagged `GokiteAccountFactory 0xF0Fc19...` and ViaLabs `MessageClient.sol` as deprecated. | Discord 2026-04-09, Laughing |
