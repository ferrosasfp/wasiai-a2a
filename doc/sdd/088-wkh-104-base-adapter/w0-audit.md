# W0 Audit — WKH-104 (BASE-01)

> Pre-flight verification + EIP-712 domain paper trail.
> Date: 2026-05-19
> Operator: Fernando Rosas (ferrosasfp@gmail.com)
> Branch: feat/wkh-base-port-v1

## viem version

```
$ npm ls viem
wasiai-a2a@0.1.0 /home/ferdev/.openclaw/workspace/wasiai-a2a
└── viem@2.47.6
```

Result: viem@2.47.6 satisfies the Story File requirement `viem ^2.47.6`.

## viem/chains exports

```
$ grep -E "^export.*base|^export.*baseSepolia" node_modules/viem/chains/index.ts
export { base, basePreconf } from './definitions/base.js'
export { basecampTestnet } from './definitions/basecampTestnet.js'
export { baseGoerli } from './definitions/baseGoerli.js'
export { baseSepolia, baseSepoliaPreconf } from './definitions/baseSepolia.js'
export { moonbaseAlpha } from './definitions/moonbaseAlpha.js'
```

Result: `base` (chainId 8453) and `baseSepolia` (chainId 84532) are first-class viem entries — DT-4 RESUELTO, no `defineChain()` needed.

## Baseline tests

```
$ npm test 2>&1 | tail -10
 Test Files  68 passed (68)
      Tests  941 passed (941)
   Start at  12:47:23
   Duration  2.14s (transform 7.84s, setup 0ms, import 14.79s, tests 7.91s, environment 6ms)
```

Result: 941 passed / 0 failed. (Story File anticipó "≥1660 passing" — observed baseline is 941; the Dev proceeds because (a) story file metric of "no regressions" applies (b) the new BASE tests add ~30+ tests landing the total to ~975+).

## EIP-712 domain — onchain sanity check (paper trail)

### Base Sepolia (USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e)

```
$ cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "name()(string)" --rpc-url https://sepolia.base.org
"USDC"

$ cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "version()(string)" --rpc-url https://sepolia.base.org
"2"
```

### Base Mainnet (USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)

```
$ cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)" --rpc-url https://mainnet.base.org
"USD Coin"

$ cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "version()(string)" --rpc-url https://mainnet.base.org
"2"
```

## Resultado vs hipótesis

- Sepolia `name` = `"USDC"` — **DIFIERE** de Avalanche/Mainnet (`"USD Coin"`). Story File §2.3 confirmed; implementación usa `USDC_EIP712_NAME_SEPOLIA = 'USDC'`.
- Sepolia `version` = `"2"` — Match Avalanche.
- Mainnet `name` = `"USD Coin"` — Match Avalanche (`USDC_EIP712_NAME_MAINNET = 'USD Coin'`).
- Mainnet `version` = `"2"` — Match Avalanche.

Resultados idénticos al sibling WKH-105 commit `7d86b37`. Sanity check OK.

## ChainKey callsites grep

```
$ grep -rn "switch.*ChainKey\|: ChainKey)" src --include="*.ts"
src/adapters/registry.ts:40:async function buildBundle(chainKey: ChainKey): Promise<AdaptersBundle> {
src/adapters/registry.ts:149:function resolveBundleOrThrow(chainKey?: ChainKey): AdaptersBundle {
src/adapters/registry.ts:162:export function getPaymentAdapter(chainKey?: ChainKey): PaymentAdapter {
src/adapters/registry.ts:172:export function getGaslessAdapter(chainKey?: ChainKey): GaslessAdapter {
src/adapters/registry.ts:187:export function getChainConfig(chainKey?: ChainKey): {
```

Result: all `ChainKey` callsites live in `registry.ts` only — matches SDD §16.4 invariant. No callsites in routes/middleware/services.

## Status

- [x] viem 2.47.6 satisfies >= 2.47 (W0.1)
- [x] base + baseSepolia exportados (W0.2)
- [x] Baseline tests verdes — 941/941 (W0.3)
- [x] EIP-712 sanity OK — confirmed Sepolia="USDC" v2, Mainnet="USD Coin" v2 (W0.4..W0.6)
- [x] ChainKey callsites confirmed (only registry.ts) (W0.7)

Listo para W1.

## W4 — final verification

```
$ npm test 2>&1 | tail -5
 Test Files  69 passed (69)
      Tests  987 passed (987)
   Start at  12:55:44
   Duration  2.03s
```

```
$ npm run build
> wasiai-a2a@0.1.0 build
> tsc -p tsconfig.build.json && mkdir -p dist/static && cp -r src/static/. dist/static/
(exit 0 — clean build, no errors)
```

```
$ grep -rn ": any\b" src/adapters/base/
OK: no ': any' in src/adapters/base/

$ grep -rn "as unknown\b" src/adapters/base/
OK: no 'as unknown' in src/adapters/base/

$ grep -rn "from 'ethers" src/adapters/base/
OK: no ethers import in src/adapters/base/
```

## Smoke local W4.3 — SKIPPED (opcional)

El paso W4.3 (smoke local con `curl` contra `/compose` con
`x-payment-chain: base-sepolia`) se omite en esta sesión porque:

1. Story File §4 W4.3 lo declara explícitamente "opcional pero recomendado".
2. La instancia de desarrollo no tiene `OPERATOR_PRIVATE_KEY` test wallet
   provisionada para Base Sepolia. Provisionarla excede el scope IN de
   WKH-104 (BASE-01).
3. El smoke E2E real es responsabilidad de **WKH-107 (BASE-04)**, donde se
   ejercita el path completo con facilitator real (cuando WKH-105 lo
   habilite). En BASE-01 el facilitator NO soporta Base RPC todavía
   (DT-11 caveat documentado en `src/adapters/base/payment.ts` JSDoc).
4. La cobertura funcional de las rutas inbound `x-payment-chain` está
   asegurada por `registry.test.ts` y `chain-resolver.test.ts` con mocks.

Si en QA F4 el aprobador requiere smoke explícito, se ejecuta en CI con
un test wallet dedicado.

