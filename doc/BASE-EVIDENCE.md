# BASE-EVIDENCE — wasiai-a2a Base Sepolia Smoke Evidence

> Verifiable onchain proof of `wasiai-a2a` settling x402 v2 payments on Base Sepolia
> (chainId 84532). Tx hashes are inmutables — agregar nuevas corridas al final,
> nunca editar entradas anteriores (CD-2 WKH-107). Failed runs MUST also be
> recorded with the error message verbatim (CD-3 WKH-107) — no cherry-picking
> only successes.

## Setup

| Field | Value |
|-------|-------|
| Chain | Base Sepolia (chainId 84532) |
| Settled asset | USDC sepolia |
| USDC contract | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| EIP-712 domain | `{ name: 'USDC', version: '2', chainId: 84532, verifyingContract: 0x036CbD…CF7e }` |
| Network tag (x402 v2) | `eip155:84532` |
| Header for chain selection | `x-payment-chain: base-sepolia` |
| Client signer wallet | `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` (wasiai-a2a OPERATOR) |
| Facilitator signer (gas) | `0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c` (wasiai-facilitator OPERATOR) |
| Explorer | https://sepolia.basescan.org/tx/{hash} |
| Script | [`scripts/smoke-base-sepolia.mjs`](../scripts/smoke-base-sepolia.mjs) |

Indexing note: Basescan can take 10–30 seconds to display a fresh tx. If the
link 404s immediately after a run, retry after 30s — the tx hash in the
response is authoritative.

---

## Run 1 — settle 0.001 USDC sepolia

- **Date (ISO 8601)**: [PENDING — fill after run]
- **Tx hash**: [PENDING]
- **Basescan**: [PENDING — https://sepolia.basescan.org/tx/<hash>]
- **Amount**: 0.001 USDC (1000 micro-USDC)
- **Client signer**: `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`
- **Facilitator (gas)**: `0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c`
- **Agent / registry**: [PENDING — e.g. `wasiai/wasi-chainlink-price`]
- **payTo (gateway treasury)**: [PENDING]
- **EIP-3009 nonce**: [PENDING — 32-byte hex]
- **Status**: [PENDING — SUCCESS or FAILED]
- **Notes**: [If FAILED, paste the error verbatim per CD-3. If SUCCESS, leave blank or describe gateway latency / steps invoked.]

---

## Run 2 — settle 0.005 USDC sepolia

- **Date (ISO 8601)**: [PENDING — fill after run]
- **Tx hash**: [PENDING]
- **Basescan**: [PENDING — https://sepolia.basescan.org/tx/<hash>]
- **Amount**: 0.005 USDC (5000 micro-USDC)
- **Client signer**: `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`
- **Facilitator (gas)**: `0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c`
- **Agent / registry**: [PENDING]
- **payTo (gateway treasury)**: [PENDING]
- **EIP-3009 nonce**: [PENDING — 32-byte hex, distinct from Run 1 (AC-3)]
- **Status**: [PENDING — SUCCESS or FAILED]
- **Notes**: [If FAILED, paste the error verbatim per CD-3.]

---

## Run 3 — settle 0.010 USDC sepolia

- **Date (ISO 8601)**: [PENDING — fill after run]
- **Tx hash**: [PENDING]
- **Basescan**: [PENDING — https://sepolia.basescan.org/tx/<hash>]
- **Amount**: 0.010 USDC (10000 micro-USDC)
- **Client signer**: `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`
- **Facilitator (gas)**: `0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c`
- **Agent / registry**: [PENDING]
- **payTo (gateway treasury)**: [PENDING]
- **EIP-3009 nonce**: [PENDING — 32-byte hex, distinct from Runs 1 & 2 (AC-3)]
- **Status**: [PENDING — SUCCESS or FAILED]
- **Notes**: [If FAILED, paste the error verbatim per CD-3.]

---

## How these tx hashes were produced

1. Operator runs the smoke script against a live gateway:

   ```bash
   BASE_SMOKE_GATEWAY_URL=http://localhost:3001 \
   BASE_SMOKE_AMOUNT_USDC=0.001 \
     node scripts/smoke-base-sepolia.mjs
   ```

2. The script signs `transferWithAuthorization` (EIP-3009) with the client
   wallet's private key (`OPERATOR_PRIVATE_KEY` in `.env`) and POSTs the
   base64-encoded x402 v2 envelope to `POST /compose` with
   `payment-signature` + `x-payment-chain: base-sepolia` headers.

3. The gateway forwards the envelope to the wasiai-facilitator
   (`BASE_FACILITATOR_URL`, default
   `https://wasiai-facilitator-production.up.railway.app`), which submits the
   `transferWithAuthorization` onchain from the facilitator wallet (paying
   gas in ETH).

4. The tx hash returned by the facilitator is captured by the script and
   transcribed here.

5. The Basescan link is generated deterministically from the tx hash — no
   external API calls are made (CD-4: PROHIBIDO llamar Basescan API).

## Out of scope

- NO tx on Base mainnet (chainId 8453) — solo Base Sepolia.
- NO video del flow (manual task fuera de la HU).
- NO listado automático en Agentic.Market / Bazaar — flow CDP separado.
