# Multi-Chain Deep Validation — wasiai-a2a PROD

**Fecha**: 2026-05-27
**Validador**: nexus-qa (F4 runtime-first sweep)
**Scope**: Salud/integración multi-chain de TODAS las chains en prod (énfasis Kite, Avalanche, Base).
**Gateway prod**: https://wasiai-a2a-production.up.railway.app
**Facilitator prod**: https://wasiai-facilitator-production.up.railway.app

**Veredicto global**: ✅ **APROBADO — las 3 chains testnet operativas inbound, evidencia onchain de settle verificada en las 3.** 0 BLOQUEANTES. 1 gap conocido outbound (downstream Avalanche-only, candidata BASE-07).

---

## Capa A — Código / unit (baseline)

| Check | Status | Evidencia |
|-------|--------|-----------|
| `npm test` | ✅ PASS | `Test Files 72 passed (72)` / `Tests 1048 passed (1048)` / exit 0 / Duration 2.14s |
| `npm run build` | ✅ PASS | exit code 0 (tsc/build limpio) |
| Matriz chains soportadas | ✅ | `src/adapters/registry.ts:25-32` SUPPORTED_CHAINS = kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet |
| Aliases (SLUG_ALIASES) | ✅ | `src/adapters/chain-resolver.ts:20-53` |

**Matriz chain → chainId → aliases** (`chain-resolver.ts`):

| ChainKey | chainId | Aliases aceptados |
|----------|---------|-------------------|
| kite-ozone-testnet | 2368 | `2368`, `kite-ozone-testnet`, `kite-testnet` |
| kite-mainnet | 2366 | `2366`, `kite-mainnet` |
| avalanche-fuji | 43113 | `43113`, `avalanche-fuji`, `avalanche-testnet`, `avalanche`, `fuji` |
| avalanche-mainnet | 43114 | `43114`, `avalanche-mainnet` |
| base-sepolia | 84532 | `84532`, `base-sepolia`, `base-testnet` |
| base-mainnet | 8453 | `8453`, `base-mainnet`, `base` (DT-7: `base` solo → mainnet) |

---

## Capa B — Integridad domain EIP-712 adapter ↔ contrato onchain

eth_call al token contract de cada chain (`name()` 0x06fdde03, `version()` 0x54fd4d50, `eth_chainId`) contra el RPC del adapter, comparado contra los valores que el adapter usa para firmar.

| Chain | Token (adapter) | onchain name() | onchain version() | onchain chainId | adapter name/ver/chainId | Veredicto |
|-------|-----------------|----------------|-------------------|-----------------|--------------------------|-----------|
| Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `USDC` | `2` | 84532 (0x14a34) | `USDC` / `2` / 84532 (`base/payment.ts:59,61,38`) | ✅ **MATCH EXACTO** |
| Avalanche Fuji | `0x5425890298aed601595a70AB815c96711a31Bc65` | `USD Coin` | `2` | 43113 (0xa869) | `USD Coin` / `2` / 43113 (`avalanche/payment.ts:50,51,32`) | ✅ **MATCH EXACTO** |
| Kite Testnet | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` (PYUSD) | `PYUSD` | **execution reverted** (no version()) | 2368 (0x940) | `PYUSD` / `1` (fallback) / 2368 (`kite-ozone/payment.ts:92,94,154`) | ✅ **MATCH (settle-proven)** — ver nota |

**Comandos (literal)**: `curl -s -X POST <RPC> --data '{...eth_call name()/version()...}'` decodificado con `python3` (ABI dynamic string).
- Base Sepolia name() → `0x...0455534443` → `"USDC"`; version() → `0x...0131` → `"2"`.
- Avalanche Fuji name() → `0x...0855534420436f696e` → `"USD Coin"`; version() → `"2"`.
- Kite Testnet name() → `0x...055059555344` → `"PYUSD"`; version() → `{"error":{"code":-32000,"message":"execution reverted"}}`.

**NOTA Kite (no es BLOQUEANTE)**: el contrato PYUSD testnet **no expone `version()`** (revierte). El adapter cae a un `version='1'` hardcodeado (`DEFAULT_EIP712_DOMAIN_VERSION`, `kite-ozone/payment.ts:94`). Esto NO se puede confirmar vía `version()`, PERO el settle onchain real `0xb861b69b…` (Capa F) tiene status `0x1` y fue un EIP-3009 contra el contrato PYUSD — lo que prueba **empíricamente** que la combinación domain `{name:"PYUSD", version:"1", chainId:2368, verifyingContract:PYUSD}` produce una firma que el contrato ACEPTA. Domain validado por settle, no por mismatch. `name="PYUSD"` documentado en `doc/kite-contracts.md:32`.
> Detalle de modos Kite: el adapter tiene `pieverse` (firma contra el contrato facilitator Pieverse, domain name PYUSD v1) y `x402` (firma contra el token directo). El path live verificado en prod es el canonical x402 contra el WasiAI facilitator (settle 0xb861b69b lo confirma).

**Veredicto Capa B**: ✅ **0 domain mismatches. Las 3 chains tienen domain íntegro adapter↔onchain.**

---

## Capa C — Gateway runtime: challenge 402 chain-aware

POST `/compose` sin payment-signature, body `{"goal":"probe","steps":[]}`, header `x-payment-chain`.

| Header | HTTP | accepts[0].network | accepts[0].asset | maxAmountRequired | decimales | Aislamiento | Status |
|--------|------|--------------------|------------------|-------------------|-----------|-------------|--------|
| `base-sepolia` | 402 | `eip155:84532` | `0x036CbD53...DCF7e` | `1000000` | 6-dec USDC ✓ | sin leak | ✅ |
| `avalanche-fuji` | 402 | `eip155:43113` | `0x5425890298...Bc65` | `1000000` | 6-dec USDC ✓ | sin leak | ✅ |
| `kite-ozone-testnet` | 402 | `eip155:2368` | `0x8E04D099...2ec9` | `1000000000000000000` | 18-dec PYUSD ✓ | sin leak | ✅ |
| (sin header) | 402 | `eip155:2368` | `0x8E04D099...2ec9` | `1000000000000000000` | 18-dec | default Kite (byte-compat) | ✅ |

`payTo` consistente `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` en las 4. `maxTimeoutSeconds`: 60 (Base/Avax), 300 (Kite) — coherente con los adapters.

**Cross-chain isolation**: ✅ ninguna chain anuncia el asset/decimales de otra. Kite (18-dec) nunca emite `1000000`; Base/Avax (6-dec) nunca emiten 18-dec.

**Veredicto Capa C**: ✅ **PASS — challenge 402 correcto y aislado en las 4 variantes.**

---

## Capa D — Fail-loud / CHAIN_NOT_SUPPORTED

| Header | HTTP | Body | Status |
|--------|------|------|--------|
| `solana` (slug desconocido) | 400 | `{"error_code":"CHAIN_NOT_SUPPORTED","error":"Chain 'solana' is not a recognized slug or chainId"}` | ✅ |
| `avalanche-mainnet` (no init) | 400 | `...is not initialized. Initialized: kite-ozone-testnet, avalanche-fuji, base-sepolia` | ✅ |
| `base-mainnet` (no init) | 400 | `...is not initialized. Initialized: kite-ozone-testnet, avalanche-fuji, base-sepolia` | ✅ |
| `kite-mainnet` (no init) | 400 | `...is not initialized. Initialized: kite-ozone-testnet, avalanche-fuji, base-sepolia` | ✅ |
| `/health` | 200 | `{"status":"ok","version":"0.1.0","uptime":955...}` | ✅ |

**Chains INITIALIZED en gateway prod**: `kite-ozone-testnet`, `avalanche-fuji`, `base-sepolia` (3 testnets). Los 3 mainnets están **code-ready pero NO inicializados** — el gateway falla-loud sin fallback silencioso. Correcto.

**Veredicto Capa D**: ✅ **PASS — fail-loud robusto, sin silent fallthrough.**

---

## Capa E — Facilitator runtime

`GET /supported` → HTTP 200:

| network | name | methods | breakerState |
|---------|------|---------|--------------|
| `eip155:2368` | Kite Testnet | eip3009 | **CLOSED** ✅ |
| `eip155:43113` | Avalanche Fuji | eip3009 | **CLOSED** ✅ |
| `eip155:43114` | Avalanche | eip3009 | **CLOSED** ✅ |
| `eip155:84532` | Base Sepolia | eip3009 | **CLOSED** ✅ |

`/health` → HTTP 200.

**Coherencia gateway ↔ facilitator (path inbound)**: las 3 chains inbound del gateway (2368, 43113, 84532) están TODAS en el facilitator con breaker CLOSED → path inbound completo. El facilitator además soporta `eip155:43114` (Avalanche mainnet) que el gateway NO inicializa — esto es **correcto**: el facilitator puede settlear más chains de las que el gateway anuncia; el gateway solo advertiza lo que puede firmar. No hay incoherencia bloqueante.

**Veredicto Capa E**: ✅ **PASS — 4 chains CLOSED, coherente con inbound.**

---

## Capa F — Inventario de evidencia onchain de settle (verificada)

Receipts verificados vía `eth_getTransactionReceipt` (status `0x1`):

| Chain | Tx hash | status | block | from | to (= token) | Explorer |
|-------|---------|--------|-------|------|--------------|----------|
| Base Sepolia (Run 4 E2E /compose) | `0x89329e5a23f7470bdd470d7dd747f77414c6132cdb89b2fcb0f713e9292fec7e` | **0x1** ✅ | 42073246 | 0xf432baf1… | 0x036cbd53… (USDC) | sepolia.basescan.org |
| Avalanche Fuji | `0x93149974cf06249109e3994c0e4fb835509c8116dd436aefc43883860329ee2e` | **0x1** ✅ | 55257835 | 0xf432baf1… | 0x54258902… (USDC) | testnet.snowtrace.io |
| Kite Testnet | `0xb861b69b07def99e7b6e7f613fc3017ec42149f08fef4b15b24bc75d4acfe66c` | **0x1** ✅ | 21313184 | 0xf432baf1… | 0x8e04d099… (PYUSD) | testnet.kitescan.ai |

Cada `to` coincide EXACTAMENTE con el token contract que el adapter de esa chain usa → la firma EIP-712 que el adapter construye fue aceptada onchain. `from` = operator wallet 0xf432baf1 en las 3.

**Evidencia documental adicional** (no re-verificada onchain, listada para trazabilidad):
- Base Sepolia: `doc/BASE-EVIDENCE.md` Runs 1-4 (4 tx SUCCESS, 0 FAILED). Run 4 = full `/compose` gateway E2E (WKH-111/BASE-06).
- Avalanche **mainnet** (43114): `0x5fbf570b…` (pre-flip) y `0xf94d4005…` (post-flip wasiai-facilitator) — `doc/demo/onchain-evidence-kit.md:51-52`. Settle mainnet REAL ya ocurrido.
- Avalanche Fuji extra: `0xc7fb70…`, `0x9b32b5…`, `0xc7676a…` (`doc/sdd/063-cross-chain-e2e-retro/done-report.md:67-69`).
- Kite: bridge tx `0x80c01af7…` (`doc/kite-contracts.md:78`).

**Veredicto Capa F**: ✅ **PASS — settle onchain real verificado en las 3 chains testnet objetivo (status 0x1). Avalanche mainnet también tiene settle real documentado.**

---

## Capa G — Gaps + lo que falta funded

**Smoke scripts disponibles** (`scripts/`):
- `smoke-base-sepolia-raw.mjs`, `smoke-base-sepolia.mjs` → Base Sepolia (chain layer + E2E).
- `smoke-e2e-cross-chain.mjs`, `smoke-cross-chain-5-agents.mjs`, `smoke-orchestrate-cross-chain.mjs` → cross-chain.
- `smoke-prod-5-agents.mjs`, `smoke-prod-orchestrate.mjs`, `smoke-prod-via-app-wasiai.mjs` → prod.
- `check-fuji-balances.mjs` → balances Fuji. `activate-mainnet-downstream.sh` → activar downstream mainnet.

**GAP CONOCIDO confirmado — outbound downstream Avalanche-only (candidata BASE-07)**:
- `src/lib/downstream-payment.ts:19` → `import { avalanche, avalancheFuji } from 'viem/chains'`
- `src/lib/downstream-payment.ts:38` → `type DownstreamNetwork = 'fuji' | 'avalanche-mainnet'` (NO hay rama Base/Kite)
- `src/lib/downstream-payment.ts:49-58` → solo USDC Fuji/Avalanche-C, network tags `eip155:43113`/`eip155:43114`.
- **Impacto**: el gateway NO paga agentes downstream en Base ni Kite (outbound). Inbound (cobrar) sí funciona en las 3; outbound (pagar a sub-agentes) está hardcodeado a Avalanche. Esto es **MENOR / TD conocida** (no bloquea inbound multi-chain).

**Settle onchain fresh que falta probar (lo corre el humano, no QA)**:
- No hay gap crítico: las 3 testnet ya tienen settle onchain real verificado.
- Si se quiere settle **fresh** post-validación: correr `scripts/smoke-base-sepolia.mjs` (Base) requiere OPERATOR_PRIVATE_KEY + USDC sepolia + ETH sepolia gas en facilitator wallet 0x9c063850…
- Avalanche/Kite fresh: requieren operator key + USDC fuji / PYUSD testnet (PYUSD testnet sin faucet oficial — `doc/kite-contracts.md:112`) + gas.
- Mainnet (43114, 8453, 2366): code-ready, NO inicializados; activación requiere env (`WASIAI_A2A_CHAINS`) + funding. Fuera de scope inbound testnet.

**Veredicto Capa G**: ✅ documentado. 1 gap MENOR (outbound Base/Kite).

---

## Matriz chain × dimensión

| Chain | Domain integrity | Challenge 402 | En /supported (facilitator) | Settle onchain evidence | Gaps |
|-------|------------------|---------------|------------------------------|--------------------------|------|
| **Kite** (2368) | ✅ name PYUSD match; version() reverte→fallback '1' settle-proven | ✅ eip155:2368, PYUSD, 18-dec | ✅ Kite Testnet CLOSED | ✅ 0xb861b69b status 0x1 | outbound no soportado (BASE-07) |
| **Avalanche** (43113) | ✅ name "USD Coin" v2 match exacto | ✅ eip155:43113, USDC, 6-dec | ✅ Fuji + Mainnet CLOSED | ✅ 0x93149974 status 0x1 (+ mainnet 0xf94d4005) | outbound OK (es el default) |
| **Base** (84532) | ✅ name "USDC" v2 match exacto | ✅ eip155:84532, USDC, 6-dec | ✅ Base Sepolia CLOSED | ✅ 0x89329e5a status 0x1 (Run4 E2E) | outbound no soportado (BASE-07) |

## Veredicto global por chain

- **Kite** (kite-ozone-testnet, 2368): ✅ **OPERATIVA INBOUND**. Domain íntegro (settle-proven), 402 correcto, facilitator CLOSED, settle onchain 0x1. Caveat menor: version() no expuesto onchain — mitigado por settle real.
- **Avalanche** (avalanche-fuji, 43113): ✅ **OPERATIVA INBOUND + OUTBOUND**. Match exacto en todo. Único chain con outbound funcional. Mainnet también con settle real documentado.
- **Base** (base-sepolia, 84532): ✅ **OPERATIVA INBOUND**. Match exacto, full /compose E2E verificado (Run 4). Outbound pendiente (BASE-07).

## Hallazgos priorizados

| # | Severidad | Hallazgo | Evidencia |
|---|-----------|----------|-----------|
| 1 | **MENOR / TD** | Outbound downstream hardcodeado a Avalanche — gateway no paga sub-agentes en Base/Kite | `src/lib/downstream-payment.ts:19,38,49-58`. Candidata BASE-07. |
| 2 | INFO | PYUSD testnet (Kite) no expone `version()` — adapter usa fallback `version='1'` | `kite-ozone/payment.ts:94`; onchain revert; settle 0xb861b69b lo valida empíricamente |
| 3 | INFO | Facilitator soporta avalanche-mainnet (43114) que el gateway no inicializa | coherente (facilitator ⊇ gateway); no bloquea |

**0 BLOQUEANTES.** Ningún domain mismatch.

## Settle funded pendientes (para el humano)

- Ninguno crítico — las 3 testnet ya tienen evidencia onchain status 0x1.
- Opcional fresh-run: `scripts/smoke-base-sepolia.mjs` (Base, requiere OPERATOR key + USDC/ETH sepolia).
- Kite fresh: bloqueado por falta de faucet PYUSD testnet (`doc/kite-contracts.md:112`).
- Mainnets: code-ready, requieren init env + funding (fuera de scope inbound testnet).

