# BASE-EVIDENCE — wasiai-a2a Base Sepolia Smoke Evidence

> **Verifiable onchain proof** of wasiai-a2a's Base adapter (WKH-104) settling EIP-3009 `transferWithAuthorization` transactions on Base Sepolia (chainId 84532).
>
> Tx hashes son **inmutables** — agregar nuevas corridas al final, nunca editar entradas anteriores (CD-2 WKH-107).
>
> Si una corrida falla, documentar el error verbatim **sin esconder fallos** (CD-3 WKH-107).

## Resumen ejecutivo

| Métrica | Valor |
|---|---|
| Date | 2026-05-19 |
| Chain | Base Sepolia (chainId 84532) |
| USDC contract | [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |
| EIP-712 domain | `name="USDC"` version=`"2"` chainId=`84532` ← *verified onchain by WKH-105* |
| Total runs | 3 SUCCESS, 0 FAILED |
| Total transferred | 0.016 USDC (0.001 + 0.005 + 0.010) |
| Avg gas per tx | 85,733 |

## Method note

These three runs exercise the **chain layer directly** using the same EIP-712 domain construction that the production Base adapter (WKH-104) builds at runtime. Specifically:

- The client wallet signs an EIP-3009 `TransferWithAuthorization` envelope using the canonical domain (`name="USDC"`, version=`"2"`, chainId=`84532`, verifyingContract = USDC sepolia).
- The submitter wallet calls `USDC.transferWithAuthorization` on Base Sepolia, paying gas.
- The 0.00N USDC moves from client to submitter (self-transfer pattern for MVP — produces real onchain proof without requiring a third-party payTo).

This validates the **same EIP-712 signature shape** that flows through:
- `src/adapters/base/payment.ts` (WKH-104) — the gateway's client-side signer
- `wasiai-facilitator/src/chains/base.ts` (WKH-105) — the facilitator's verifier/settler

The full x402 v2 `/compose` flow through a deployed gateway is recommended for Phase 2 staging validation; this evidence proves the chain primitives work correctly.

**Script used**: [`scripts/smoke-base-sepolia-raw.mjs`](../scripts/smoke-base-sepolia-raw.mjs)

## Wallets

| Wallet | Address | Role | Funded with |
|---|---|---|---|
| wasiai-a2a OPERATOR | [`0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`](https://sepolia.basescan.org/address/0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba) | Client (signs EIP-3009) | 20 USDC |
| wasiai-facilitator OPERATOR | [`0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c`](https://sepolia.basescan.org/address/0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c) | Submitter (pays gas) | 0.005+ ETH |

---

## Run 1 — settle 0.001 USDC sepolia

- **Date**: 2026-05-19T21:52:38.902Z
- **Tx hash**: [`0x4719e0e492029c5b9922d85627a710fa0a3d6d781932cec2ed357aceffb9c108`](https://sepolia.basescan.org/tx/0x4719e0e492029c5b9922d85627a710fa0a3d6d781932cec2ed357aceffb9c108)
- **Basescan**: https://sepolia.basescan.org/tx/0x4719e0e492029c5b9922d85627a710fa0a3d6d781932cec2ed357aceffb9c108
- **Amount**: 0.001 USDC (1,000 micro-USDC)
- **Block**: 41,729,635
- **Gas used**: 85,740
- **Nonce (EIP-3009)**: `0xc6587747219ac68f70166aab49c3a91460b8fa198078e3f03a1bc4a7caf89a50`
- **Signature v/r/s**: v=28, r=`0x151d1bd7...`, s=`0x668c256c...`
- **Status**: ✅ SUCCESS

## Run 2 — settle 0.005 USDC sepolia

- **Date**: 2026-05-19T21:52:49.163Z
- **Tx hash**: [`0x6356a85df7d0273483438234a31a8730ebd9be64d956962bfc14c14447a86107`](https://sepolia.basescan.org/tx/0x6356a85df7d0273483438234a31a8730ebd9be64d956962bfc14c14447a86107)
- **Basescan**: https://sepolia.basescan.org/tx/0x6356a85df7d0273483438234a31a8730ebd9be64d956962bfc14c14447a86107
- **Amount**: 0.005 USDC (5,000 micro-USDC)
- **Block**: 41,729,641
- **Gas used**: 85,720
- **Nonce (EIP-3009)**: `0x1c845284095776f2aa993bddf514a2e6b56a909b3ee9e2ead7364589e97b83a5`
- **Signature v/r/s**: v=27, r=`0x04797bd8...`, s=`0x5c69be9a...`
- **Status**: ✅ SUCCESS

## Run 3 — settle 0.010 USDC sepolia

- **Date**: 2026-05-19T21:53:00.062Z
- **Tx hash**: [`0x1d31a67267d4f15a22a20ccd28296931fae0b9d0265c848295f84313b949fad7`](https://sepolia.basescan.org/tx/0x1d31a67267d4f15a22a20ccd28296931fae0b9d0265c848295f84313b949fad7)
- **Basescan**: https://sepolia.basescan.org/tx/0x1d31a67267d4f15a22a20ccd28296931fae0b9d0265c848295f84313b949fad7
- **Amount**: 0.010 USDC (10,000 micro-USDC)
- **Block**: 41,729,646
- **Gas used**: 85,740
- **Nonce (EIP-3009)**: `0x50db521db9bfaea99b119a6b01a2ebd9fce56903f97c58cd7f17f35bdecc7944`
- **Signature v/r/s**: v=28, r=`0xd4a7b221...`, s=`0x2bb327ca...`
- **Status**: ✅ SUCCESS

---

## How to verify

```bash
# Each tx can be inspected onchain:
curl -X POST https://sepolia.base.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getTransactionByHash","params":["0x4719e0e492029c5b9922d85627a710fa0a3d6d781932cec2ed357aceffb9c108"],"id":1}'

# Or in the browser:
# https://sepolia.basescan.org/tx/0x4719e0e492029c5b9922d85627a710fa0a3d6d781932cec2ed357aceffb9c108
```

The tx `input` field decodes to `transferWithAuthorization(...)` with the parameters listed above.

## Next steps for full gateway E2E

A future run with the full gateway flow (`POST /compose` → 402 challenge → signed retry → /settle via facilitator → tx hash) will be performed once:

1. WKH-104 + WKH-105 merged to `main`
2. Railway production deployed with `WASIAI_A2A_CHAINS` including `base-sepolia`
3. An agent registered in production marketplace with `payment.chain: base-sepolia`

That run will be appended below as "Run 4 — full /compose flow" with the same evidence format.
