# SDD #094: [WKH-112] [BASE-07] outbound downstream payment chain-aware

> SPEC_APPROVED: no
> Fecha: 2026-05-27
> Tipo: feature (evolutivo sobre superficie crítica de pagos — outbound/operator)
> SDD_MODE: full
> Branch: feat/094-wkh-112-downstream-chain-aware
> Artefactos: doc/sdd/094-wkh-112-downstream-chain-aware/
> Work item: doc/sdd/094-wkh-112-downstream-chain-aware/work-item.md
> Hermana: WKH-111 (BASE-06, DONE) — mismo patrón resuelto para el INBOUND.

---

## 1. Resumen

El settle **OUTBOUND** del gateway (`src/lib/downstream-payment.ts`) — el path por el
que el gateway PAGA con el OPERATOR wallet a los sub-agentes durante `/compose` y
`/orchestrate` — hoy es **chain-blind y mono-chain**. El módulo reimplementa inline
todo el flujo `sign(EIP-3009) → /verify → /settle` contra una única chain
(`fuji` o `avalanche-mainnet`, seleccionada por env `WASIAI_DOWNSTREAM_NETWORK`) y
trae un guard duro `if (agent.payment.chain !== 'avalanche') return null`
(`downstream-payment.ts:457-467`) que saltea el settle para cualquier chain ≠
avalanche. Resultado: el gateway COBRA en 3 chains (WKH-111 inbound, DONE) pero solo
PAGA en 1 (Avalanche), dejando el outbound multi-chain incompleto.

Esta HU hace **wiring** (no rewrite): resuelve el `ChainKey` del agente destino
desde `agent.payment.chain` con la función pura `normalizeChainSlug`, valida que esté
inicializada en el registry (fail-loud `CHAIN_NOT_SUPPORTED`, AC-4) y delega
`sign` + `verify` + `settle` a `getPaymentAdapter(chainKey)` — el MISMO primitivo
chain-aware que usa el inbound (WKH-111) y que está **probado onchain en las 3 chains**
(Base `0x89329e5a`, Avax `0x93149974`, Kite `0xb861b69b`, todos status `0x1` —
`2026-05-27-multichain-deep-validation.md` Capa F). **NO se reimplementa la firma**:
el adapter ya encapsula el domain EIP-712 correcto por chain (lección crítica
WKH-105/089: Base Sepolia firma con `name="USDC"`, Mainnet `name="USD Coin"`, Kite
`name="PYUSD"` v1 — divergencia que el módulo legacy NO conoce).

**Cero regresión Avalanche (CD-1)**: con `agent.payment.chain === 'avalanche'` /
`'avalanche-fuji'`, el comportamiento observable (mismo facilitator, USDC Fuji,
`eip155:43113`, skip-codes, contrato NEVER-throws, shape `DownstreamResult`) queda
funcionalmente idéntico, y los 1048 tests existentes siguen verdes.

Resultado esperado: el gateway settlea outbound a sub-agentes en Base/Kite/Avalanche
con tx hash verificable, y `signAndSettleDownstream` sigue NEVER-throws.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 094 (WKH-112) |
| **Tipo** | feature / evolutivo (path de dinero real, outbound/operator) |
| **SDD_MODE** | full (QUALITY) |
| **Objetivo** | Hacer chain-aware sign+verify+settle del path outbound, ruteando al adapter del `agent.payment.chain` resuelto, con cero regresión Avalanche y contrato NEVER-throws preservado. |
| **Reglas de negocio** | Golden Path payments: sin hardcodes de chain, solo viem, TS strict, fail-loud en chain no soportada, coherencia de chain en todo el flujo. |
| **Scope IN** | `src/lib/downstream-payment.ts` (núcleo), `src/lib/downstream-payment.test.ts` (reescritura de estrategia de mock), `src/lib/downstream-payment.mainnet.test.ts` (ajuste/retiro). `src/services/compose.ts` NO se modifica (DT-2). |
| **Scope OUT** | Inbound (`x402.ts`/`a2a-key.ts`, WKH-111 DONE), mainnet de cualquier chain, modelo a2a-key/budget, schema/agent-card, split payments. |
| **Missing Inputs** | DT-1..DT-5 cerrados en este SDD (§5). Requisito operacional de env documentado (§9). |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** (Event-driven — settle outbound en Base): WHEN `/compose` (o
  `/orchestrate` vía compose) paga a un sub-agente cuyo `agent.payment.chain`
  resuelve a `base-sepolia`, THEN the system SHALL firmar la autorización EIP-3009
  con el OPERATOR wallet vía el adapter de Base y settlear vía el facilitator de Base
  (`network = eip155:84532`), retornando un `DownstreamResult` con `txHash`
  verificable en Basescan y `settledAmount` en 6 decimales.

- **AC-2** (Ubiquitous — CERO regresión Avalanche): WHEN el sub-agente cobra en
  `avalanche-fuji`/`avalanche`, THEN the system SHALL comportarse funcionalmente
  idéntico al path actual (mismo facilitator, USDC Fuji, `eip155:43113`, skip-codes,
  NEVER-throws) y los 1048 tests existentes SHALL permanecer verdes. Cualquier diff
  observable en el path Avalanche es BLOQUEANTE.

- **AC-3** (Event-driven — settle outbound en Kite): WHEN el sub-agente cobra en
  `kite-ozone-testnet`, THEN the system SHALL firmar+settlear vía el adapter de Kite
  (`network = eip155:2368`, PYUSD), retornando un `DownstreamResult` con el `txHash`
  correspondiente — sin enviar a Avalanche. (Modo confirmado: canonical x402 — DT-5.)

- **AC-4** (Unwanted — chain no soportada/no inicializada → fail-loud): IF
  `agent.payment.chain` resuelve a un `ChainKey` que NO está inicializado en el
  registry, o no se reconoce (`normalizeChainSlug` → undefined), THEN the system SHALL
  omitir el settle con skip-code `CHAIN_NOT_SUPPORTED` + log estructurado listando las
  chains inicializadas (`getInitializedChainKeys()`); PROHIBIDO caer al default
  Avalanche o enviar a una chain distinta de la declarada.

- **AC-5** (State-driven — coherencia chain): WHILE se procesa el pago a un agente con
  chain resuelta `K`, the system SHALL usar el MISMO `ChainKey K` para resolver el
  adapter, la firma y el facilitator/network del settle. PROHIBIDO mezclar el adapter
  de una chain con el network de otra.

- **AC-6** (Ubiquitous — sin hardcodes de chain): the system SHALL derivar
  address/network/chainId/decimales/EIP-712 domain del ADAPTER seleccionado
  (`getToken()`/`getNetwork()`/`supportedTokens[].decimals` + la firma interna del
  adapter) — PROHIBIDO mantener `DEFAULT_FUJI_USDC`/`DEFAULT_AVALANCHE_USDC`/
  `FUJI_NETWORK`/`AVALANCHE_NETWORK` como fuente de verdad del settle.

## 3. Context Map (Codebase Grounding)

### Archivos leídos (todos verificados con Read, líneas reales)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/lib/downstream-payment.ts` | Núcleo del cambio | Flujo inline: `buildClients()` (`:255-305`, solo `avalanche`/`avalancheFuji`), `readOperatorBalance` (`:237-249`), `getUsdcAddress` (`:145-172`), `signTypedData` con domain `{name:'USD Coin', version:'2', chainId, verifyingContract}` (`:564-591`), `buildCanonicalBody` (`:311-331`), `postFacilitator` `/verify`+`/settle` (`:356-390`), `TRANSFER_WITH_AUTHORIZATION_TYPES` (`:393-402`). Guard bloqueante `if (agent.payment.chain !== 'avalanche') return null` (`:457-467`). Export `signAndSettleDownstream(agent, logger)` (`:425-428`), NEVER-throws (`:4-5`). `DownstreamResult = {txHash, blockNumber, settledAmount}` (`:76-80`). `DownstreamSkipCode` incluye ya `CHAIN_NOT_SUPPORTED` (`:82-96`). |
| `src/services/compose.ts` | Único consumidor | `invokeAgent` llama `signAndSettleDownstream(agent, effectiveLogger)` (`:459`), retorna `{output, txHash, downstream}` (`:343-347`, `:461`). Mapea `downstream.txHash/blockNumber/settledAmount` → `StepResult.downstreamTxHash/downstreamBlockNumber/downstreamSettledAmount` (`:195-199`). `/orchestrate` rutea por compose (transitivo). |
| `src/adapters/types.ts` | Contrato del primitivo | `PaymentAdapter.sign({to,value,timeoutSeconds?})→SignResult` (`:35-43`,`:85`), `.verify(X402Proof)→VerifyResult{valid,error?}` (`:78-91`), `.settle(SettleRequest{authorization,signature,network})→SettleResult{txHash,success,error?}` (`:11-20`,`:82`). **`SettleResult` NO trae `blockNumber` ni `amount`** (`:16-20`). `quote(amountUsd)→{amountWei,token,facilitatorUrl}` (`:30-34`). `supportedTokens:TokenSpec[]` con `decimals` (`:6-10`,`:81`). `ChainKey` union (`:122-128`). |
| `src/adapters/base/payment.ts` | Shape Base + firma | `getNetwork()`→`eip155:84532` (`:363-365`), `getToken()`→USDC Base Sepolia (`:367-369`), `supportedTokens[0].decimals=6` (`:58`,`:349-357`). `sign()` firma EIP-3009 `from=operator → to=opts.to` contra USDC directo con domain `name='USDC'` (Sepolia) / `'USD Coin'` (mainnet), `version='2'` (`:401-452`,`:64-68`). `settle()` → `settleX402` que devuelve `{txHash, success}` y **descarta blockNumber/amount** (`:328-331`,`:383-385`). |
| `src/adapters/avalanche/payment.ts` | Shape Avalanche (path CD-1) | `getNetwork()`→`eip155:43113` (fuji) (`:331-333`,`:198-200`), `getToken()`→USDC Fuji `0x5425…Bc65` (`:335-337`,`:43-44`), `decimals=6` (`:49`). `sign()` domain `name='USD Coin' v2 chainId=43113 verifyingContract=USDC` (`:369-420`) — **idéntico al inline downstream** (`downstream-payment.ts:564-591`). `settle()`→`settleX402`, `{txHash,success}` (`:351-353`,`:299-302`). |
| `src/adapters/kite-ozone/payment.ts` | Modo Kite (DT-5) | Dos modos: `pieverse` (default) y `x402` (`KITE_FACILITATOR_MODE=x402`, `:60-64`). En modo x402, `sign()` firma `TransferWithAuthorization` contra el token PYUSD directo (`:355-384`); `verify`/`settle` rutean a `verifyX402`/`settleX402` (`:236-238`,`:283-285`). `getNetwork()`→`eip155:2368` (`:222-224`), `decimals=18` (`:216`). `settle()`→`{txHash,success}`. |
| `src/adapters/registry.ts` | Accessor + helpers | `getPaymentAdapter(chainKey?)` (`:172-174`) resuelve el bundle por chain. `getAdaptersBundle(chainKey?)` no-throw → `undefined` si no inicializada (`:213-220`). `getInitializedChainKeys()` (`:226-228`), `getDefaultChainKey()` (`:234-236`). Despacha `createBaseAdapters`/`createAvalancheAdapters`/`createKiteOzoneAdapters` por `ChainKey` (`:42-87`). |
| `src/adapters/chain-resolver.ts` | Resolver puro | `normalizeChainSlug(raw)` (`:61-66`) → `ChainKey \| undefined`, total/never-throw. `resolveChainKey({agentManifestChain})` (`:77-88`). **CRÍTICO**: `'avalanche'`→`'avalanche-fuji'`, `'fuji'`→`'avalanche-fuji'` (`:23-28`); `'base-sepolia'`/`'84532'`→`'base-sepolia'` (`:49-51`); `'kite-ozone-testnet'`/`'2368'`→`'kite-ozone-testnet'` (`:35-37`); slug desconocido → `undefined`. |
| `src/types/index.ts` | Tipos consumidos | `AgentPaymentSpec.chain: string` pass-through raw (`:89-94`). `StepResult.downstreamTxHash/downstreamBlockNumber?/downstreamSettledAmount?` (`:229-234`). `DownstreamLogger` (`:331` doc). |
| `src/lib/downstream-payment.test.ts` | Exemplar de test legacy (a reescribir) | Mockea `viem` (`createPublicClient`/`createWalletClient`) + `viem/accounts` + `fetch` global (`:48-66`,`:80`), e importa el módulo con `vi.resetModules()` (`:69-76`). Asserts sobre `mockSignTypedData` domain (`:337-374`). Happy path asserta `{txHash:'0xTX', blockNumber:12345, settledAmount:'500000'}` (`:310-335`). |
| `src/lib/downstream-payment.mainnet.test.ts` | Exemplar mainnet (a retirar/ajustar) | Mismo patrón viem-mock con `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` (`:64-100`). Asserta chainId=43114, network=`eip155:43114`. |
| `src/services/compose.test.ts` | Mock del consumidor | `vi.mock('../lib/downstream-payment.js', ()=>({signAndSettleDownstream: vi.fn().mockResolvedValue(null)}))` (`:46-48`) — **signature-agnóstico**. `vi.mock('../adapters/registry.js', ()=>({getPaymentAdapter: ()=>({sign, settle})}))` (`:26-28`) — incompleto (sin `getAdaptersBundle`/`getInitializedChainKeys`). |

### Exemplars (verificados — existen en disco)

| Para crear/modificar | Seguir patrón de | Razón |
|----------------------|------------------|-------|
| Resolución de `ChainKey` + skip fail-loud en `signAndSettleDownstream` | `src/middleware/x402.ts` (WKH-111) §4.3 SDD #093 + `a2a-key.ts:188-224` | Misma fuente (slug del manifest), mismo resolver (`normalizeChainSlug`/`resolveChainKey`), mismo error code (`CHAIN_NOT_SUPPORTED`), mismo log con `getInitializedChainKeys()`. Patrón ya aprobado en este repo. |
| Delegación `sign`+`verify`+`settle` al adapter | `src/services/compose.ts:438-447` (settle inbound via `getPaymentAdapter().settle`) + `BasePaymentAdapter.sign/verify/settle` | El adapter ya es el primitivo; compose ya lo usa para el settle del payment del request. |
| Test `downstream-payment.test.ts` reescrito (mock registry) | `src/services/compose.test.ts:24-28` (mock `getPaymentAdapter` con `sign`/`settle`) + `src/middleware/x402.passport-shape.test.ts` (mock-registry pattern, citado en SDD #093) | La nueva estrategia mockea el registry/adapter, NO viem directo (porque la firma se delega al adapter). |

### Estado de BD relevante

N/A — esta HU no toca BD. El downstream settle es ortogonal al modelo
budget/debit (WKH-59) y a `a2a_agent_keys`. No hay query a Supabase en este path,
por lo que el Ownership Guard (WKH-53) no aplica.

### Componentes reutilizables encontrados

- `normalizeChainSlug` / `resolveChainKey` (`chain-resolver.ts`) — puros, ya usados en
  el inbound. **Reutilizar, no duplicar.**
- `getPaymentAdapter(chainKey)` / `getAdaptersBundle` / `getInitializedChainKeys`
  (`registry.ts`) — ya existen. **No modificar el registry.**
- `PaymentAdapter.sign/verify/settle` — primitivo chain-aware probado onchain. **No
  reimplementar la firma ni el facilitator POST.**

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué cambia | Exemplar |
|---------|--------|-----------|----------|
| `src/lib/downstream-payment.ts` | Modificar | (a) Resolver `ChainKey` desde `agent.payment.chain` vía `normalizeChainSlug` + validar `getAdaptersBundle(chainKey)` ≠ undefined; reemplazar el guard `!== 'avalanche'` (`:457-467`) por skip `CHAIN_NOT_SUPPORTED` fail-loud (DT-4). (b) Delegar sign → `getPaymentAdapter(chainKey).sign(...)`, verify → `.verify(...)`, settle → `.settle(...)`. (c) Conservar: NEVER-throws, skip-codes, `validatePayTo`, `priceUsdc` guard, pre-flight balance check (chain-aware, DT-3). (d) Eliminar helpers legacy obsoletos (DT-1). | §4.3, §4.4 |
| `src/lib/downstream-payment.test.ts` | Reescribir estrategia de mock | Pasa de mock-viem-directo a mock-registry (`getPaymentAdapter`). Tests de selección de chain (Base/Avalanche/Kite), regresión Avalanche, fail-loud `CHAIN_NOT_SUPPORTED`. Conserva skip-codes triviales (flag off, no payment, method, payTo, price). | `compose.test.ts:24-28` |
| `src/lib/downstream-payment.mainnet.test.ts` | Ajustar/retirar | El concepto `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` deja de existir (DT-1: se borra `getDownstreamNetwork`). Los asserts mainnet-by-env ya no aplican. Se retira el archivo (mainnet es Scope OUT) o se reconvierte a un test de selección `avalanche-mainnet` vía manifest (solo si el registry lo tiene inicializado — no en testnet CI). Decisión: **retirar** (ver DT-1). | — |
| `src/services/compose.ts` | **NO se modifica** | DT-2: la firma `signAndSettleDownstream(agent, logger)` se mantiene; la resolución de chain es interna. El mapeo `downstream.{txHash,blockNumber,settledAmount}` (`:195-199`) se preserva porque el shape `DownstreamResult` no cambia (DT-1). | — |

### 4.2 Modelo de datos

N/A — sin cambios de BD.

### 4.3 Arquitectura del cambio: thin orchestrator del adapter

El módulo pasa de **reimplementación inline mono-chain** a **thin orchestrator
multi-chain del adapter**. El nuevo `signAndSettleDownstream` ejecuta esta secuencia
(las validaciones tempranas 1-5 se preservan tal cual):

1. **Flag** `WASIAI_DOWNSTREAM_X402` (sin cambio, `:430`).
2. **`agent.payment` presencia** (sin cambio, `:435`).
3. **`method === 'x402'`** (sin cambio, `:444`).
4. **Resolución de chain (REEMPLAZA el guard `!== 'avalanche'`, AC-4/CD-4)**:
   - `const chainKey = normalizeChainSlug(agent.payment.chain)`.
   - Si `chainKey === undefined` → skip `CHAIN_NOT_SUPPORTED` + `logger.error` con
     `{agentSlug, chain: agent.payment.chain, initialized: getInitializedChainKeys()}`
     → `return null` (DT-4).
   - Si `getAdaptersBundle(chainKey) === undefined` (slug reconocido pero NO
     inicializado en el registry) → skip `CHAIN_NOT_SUPPORTED` + `logger.error` con la
     misma lista → `return null` (DT-4).
5. **`validatePayTo`** + **`priceUsdc` guard** (sin cambio, `:470-507`).
6. **Resolver el adapter UNA vez** (CD-6): `const adapter = getPaymentAdapter(chainKey)`.
7. **Decimales chain-aware (AC-6, DT-3)**: `const decimals = adapter.supportedTokens[0].decimals`
   (Base/Avax=6, Kite=18). `const value = parseUnits(String(agent.priceUsdc), decimals)`.
   PROHIBIDO usar la constante hardcodeada `USDC_DECIMALS=6` (rompería Kite/PYUSD-18 —
   bug recurrente WKH-67/072).
8. **Pre-flight balance check chain-aware (DT-3)**: leer el balance del operator del
   token del adapter (`adapter.getToken()`) en la chain resuelta. Ver DT-3 para la
   forma concreta. Si `balance < value` → skip `INSUFFICIENT_BALANCE`. Si la lectura
   RPC falla → skip `BALANCE_READ_FAILED`.
9. **Sign (delegado, AC-1/AC-3/AC-5/AC-6)**: `const signed = await adapter.sign({ to:
   payToCheck.addr, value: value.toString(), timeoutSeconds: ... })`. El adapter
   encapsula el domain EIP-712 correcto por chain (lección WKH-105/089). Try/catch →
   skip `SIGNING_FAILED`. El resultado expone `signed.paymentRequest` (`{authorization,
   signature, network}`).
10. **Verify (delegado, AC-5)**: `const verifyRes = await adapter.verify({ authorization:
    signed.paymentRequest.authorization, signature: signed.paymentRequest.signature,
    network: signed.paymentRequest.network })`. Try/catch (el adapter PUEDE throw en
    network error) → skip `VERIFY_FAILED`. Si `verifyRes.valid !== true` → skip
    `VERIFY_FAILED` (con `verifyRes.error` en el log).
11. **Settle (delegado, AC-1/AC-3/AC-5)**: `const settleRes = await adapter.settle({...})`.
    Try/catch → skip `SETTLE_FAILED`. Si `settleRes.success !== true` → skip
    `SETTLE_FAILED` (con `settleRes.error`).
12. **Éxito** → construir `DownstreamResult` (ver §4.5 para el shape, DT-1).

**Coherencia de chain (AC-5/CD-6)**: el `chainKey` se resuelve UNA sola vez (paso 4) y
se reusa para resolver el adapter (paso 6), la firma (paso 9), el verify (paso 10) y
el settle (paso 11). El `network` del settle viene del propio adapter
(`signed.paymentRequest.network`), nunca de un literal externo.

**NEVER-throws (CD-7)**: cada paso async que puede lanzar está envuelto en try/catch
que retorna `null` con su skip-code. La resolución (`normalizeChainSlug`,
`getAdaptersBundle`, `getPaymentAdapter`) es total o se guardea: `getPaymentAdapter`
PUEDE lanzar si el registry no está inicializado, pero el paso 4 ya garantizó vía
`getAdaptersBundle(chainKey) !== undefined` que el bundle existe, por lo que
`getPaymentAdapter(chainKey)` no lanza en el camino feliz. Aun así, se envuelve el
bloque sign/verify/settle en un try/catch externo defensivo (CD-7).

### 4.4 Flujo principal (Happy Path Base Sepolia)

1. `/compose` invoca `invokeAgent(agent)` con `agent.payment = {method:'x402',
   chain:'base-sepolia', contract:'0x…'}`, `agent.priceUsdc = 0.5`.
2. `signAndSettleDownstream(agent, logger)`: flag on, payment presente, method x402.
3. `normalizeChainSlug('base-sepolia')` → `'base-sepolia'`; `getAdaptersBundle('base-sepolia')`
   ≠ undefined (inicializada) → continúa.
4. `validatePayTo` OK; `priceUsdc` OK.
5. `adapter = getPaymentAdapter('base-sepolia')`; `decimals = 6`;
   `value = parseUnits('0.5', 6) = 500000n`.
6. Pre-flight balance (DT-3): balance operator en USDC Base Sepolia ≥ 500000n → OK.
7. `adapter.sign({to:'0x…', value:'500000'})` → firma EIP-3009 domain `{name:'USDC',
   version:'2', chainId:84532, verifyingContract: USDC Base}`, `network='eip155:84532'`.
8. `adapter.verify(...)` → `{valid:true}`; `adapter.settle(...)` → `{txHash:'0x…',
   success:true}` (facilitator Base).
9. Retorna `DownstreamResult { txHash:'0x…', blockNumber: <ver DT-1>, settledAmount:'500000' }`.
10. compose mapea a `StepResult.downstream*` (`:195-199`).

### 4.5 Flujo de error

1. **Chain no reconocida** (`agent.payment.chain = 'solana'`): `normalizeChainSlug` →
   `undefined` → skip `CHAIN_NOT_SUPPORTED` + `logger.error({chain:'solana',
   initialized:[…]})` → `null`. No silent fallback (CD-4).
2. **Chain reconocida pero no inicializada** (`chain='base-sepolia'` cuando
   `WASIAI_A2A_CHAINS` no la incluye): `getAdaptersBundle('base-sepolia')` →
   `undefined` → skip `CHAIN_NOT_SUPPORTED` + log con `getInitializedChainKeys()` →
   `null` (CD-4, AC-4).
3. **payTo inválido/zero**: skip `INVALID_PAY_TO_FORMAT` / `ZERO_PAY_TO` (sin cambio).
4. **priceUsdc no finito/no positivo**: skip `INVALID_PRICE` (sin cambio).
5. **Balance insuficiente / read RPC falla** (DT-3): skip `INSUFFICIENT_BALANCE` /
   `BALANCE_READ_FAILED`.
6. **`adapter.sign` lanza**: skip `SIGNING_FAILED`.
7. **`adapter.verify` lanza o `valid=false`**: skip `VERIFY_FAILED`.
8. **`adapter.settle` lanza o `success=false`**: skip `SETTLE_FAILED`.
9. En TODOS los casos: `return null`, el caller (compose) loguea y continúa (CD-7,
   NEVER-throws). El pipeline `/compose` NO se rompe por una chain no soportada.

## 5. Cierre de las Decisiones Técnicas (DT-1..DT-5)

### DT-1 — Alcance del borrado del flujo inline legacy + shape de `DownstreamResult` (CERRADO)

**Decisión**: el módulo pasa a **thin orchestrator del adapter**. Se BORRAN los
helpers que el adapter ya cubre; se CONSERVAN los que son responsabilidad del
orquestador (validación, balance, NEVER-throws, observabilidad).

**Se BORRA** (responsabilidad del adapter ahora):
- `getDownstreamNetwork()` / `type DownstreamNetwork` (`:38-44`) — la chain ya no se
  selecciona por env `WASIAI_DOWNSTREAM_NETWORK` sino por `agent.payment.chain`. El
  concepto mono-chain-by-env desaparece. **Esto retira el archivo `.mainnet.test.ts`.**
- `getUsdcAddress()` (`:145-172`) + `DEFAULT_FUJI_USDC`/`DEFAULT_AVALANCHE_USDC`
  (`:49-52`) — la address viene de `adapter.getToken()`.
- `getUsdcEip712Version()` (`:174-185`) + `USDC_EIP712_NAME`/`USDC_EIP712_VERSION_DEFAULT`
  (`:62-63`) — el domain lo encapsula el adapter (crítico: per-chain divergence).
- `buildClients()` (`:255-305`) + imports `avalanche`/`avalancheFuji`,
  `createWalletClient` — la firma la hace el adapter.
- `buildCanonicalBody()` (`:311-331`) + `X402CanonicalBody`/`X402Authorization`
  wire-types (`:99-121`) — el adapter construye el body canónico.
- `postFacilitator()` + `FacilitatorOk/Err/Response` (`:343-390`) + `getFacilitatorUrl()`
  (`:187-192`) + `X402VerifyResponse`/`X402SettleResponse` (`:123-132`) — verify/settle
  los hace el adapter.
- `TRANSFER_WITH_AUTHORIZATION_TYPES` (`:393-402`) — el adapter tiene su `EIP3009_TYPES`.
- `FUJI_CHAIN_ID`/`AVALANCHE_CHAIN_ID`/`FUJI_NETWORK`/`AVALANCHE_NETWORK`
  (`:55-58`), `USDC_DECIMALS` constante (`:61`), `USDC_EIP712_*`, `VALID_BEFORE_SECONDS`,
  `X402_SCHEME`, `MAX_TIMEOUT_SECONDS`, `warnedDefaultUsdc` — literales de chain
  prohibidos por CD-3/AC-6.

**Se CONSERVA** (responsabilidad del orquestador):
- `signAndSettleDownstream` export + firma `(agent, logger)` (DT-2).
- `DownstreamResult` + `DownstreamSkipCode` types.
- `validatePayTo()` (`:198-210`) — validación de input, antes de tocar el adapter.
- el `priceUsdc` guard (`:497-507`).
- `computeAtomicValue` se ADAPTA: deja de usar la constante `USDC_DECIMALS=6` y lee
  `adapter.supportedTokens[0].decimals` (chain-aware, DT-3/AC-6). Sigue usando
  `parseUnits` (CD-NEW-SDD-5 heredada, NO `Math.round(x*1e6)`).
- contrato NEVER-throws + skip-codes + logging estructurado.
- pre-flight balance check (chain-aware — ver DT-3).
- `DOWNSTREAM_FLAG` (read-once at module load).
- `export type { DownstreamLogger }` re-export (compat con compose).

**Shape de `DownstreamResult` — resolución del mismatch adapter vs legacy (CRÍTICO
para CD-1)**: el contrato actual es `{ txHash, blockNumber: number, settledAmount:
string }`, pero `adapter.settle()` devuelve `SettleResult { txHash, success, error? }`
— **NO trae `blockNumber` ni `amount`** (verificado: `base/payment.ts:328-331`,
`avalanche:299-302`, `kite:530-533`; `types.ts:16-20`). Tres opciones evaluadas:

- **(A) Cambiar `DownstreamResult` a `{txHash, settledAmount}` (drop `blockNumber`)** y
  hacer `StepResult.downstreamBlockNumber` opcional/ausente. **Rechazada**: cambia el
  output observable del path Avalanche (hoy `blockNumber:12345`) → viola CD-1 y AC-2.
- **(B) Mantener `blockNumber` como `0`** cuando el adapter no lo expone. **Rechazada**:
  `0` es un valor onchain falso (datos simulados — viola Golden Path "sin datos
  simulados") y cambia el output Avalanche (de número real a `0`).
- **(C) ELEGIDA — `settledAmount` se computa localmente, `blockNumber` se preserva
  como campo OPCIONAL coherente con lo que el adapter realmente provee**:
  - `settledAmount` = `value.toString()` (el monto atómico que se firmó/settleó; el
    orquestador ya lo conoce, no depende del adapter). Esto es lo que el legacy hacía
    de fallback: `settleRes.data.amount ?? value.toString()` (`:649`). El monto firmado
    es la fuente de verdad del `settledAmount`.
  - `blockNumber`: el `SettleResult` del adapter NO lo expone. Para preservar CD-1
    **sin modificar el adapter** (Scope OUT) ni inventar datos, `DownstreamResult.blockNumber`
    pasa a `number | undefined` (opcional) y se omite cuando el adapter no lo provee.
    `StepResult.downstreamBlockNumber` ya es opcional (`types/index.ts:232`,
    `compose.ts:197` lo mapea con spread condicional), por lo que omitirlo es
    backward-compatible a nivel de tipos y de wire (el campo simplemente no aparece en
    el JSON cuando es undefined).

  **Análisis de impacto CD-1 sobre `blockNumber`**: hoy el path Avalanche produce
  `downstreamBlockNumber` poblado en los TESTS (mock facilitator devuelve `blockNumber:
  12345`), pero en PROD el `blockNumber` viene del facilitator real. Al delegar al
  adapter, ese campo se pierde porque `SettleResult` lo descarta. Esto es un **cambio
  observable acotado y aceptado** (downgrade de telemetría, no de funcionalidad de
  pago): el `txHash` (la prueba onchain canónica) se preserva intacto, y
  `downstreamBlockNumber` es metadata opcional ya marcada como tal en el tipo. **Se
  documenta como TD-WKH-112-01** (recuperar `blockNumber` extendiendo `SettleResult`
  del adapter en una HU futura que toque `adapters/types.ts`). Los tests de regresión
  Avalanche se ajustan para NO exigir `blockNumber` (es opcional). **Esta es la única
  desviación observable del path Avalanche y se declara explícitamente para que AR/CR
  la evalúe contra CD-1.** Si AR considera que el drop de `blockNumber` viola CD-1 de
  forma inaceptable, la alternativa es subir `adapters/types.ts` al Scope IN (extender
  `SettleResult` con `blockNumber?`) — decisión que se escala al humano en SPEC_APPROVED
  si AR lo marca BLOQUEANTE. **Recomendación del Architect: opción C** (mínimo blast
  radius, sin tocar el contrato compartido del adapter).

### DT-2 — Firma del export estable, resolución interna (CERRADO)

**Decisión**: `signAndSettleDownstream(agent, logger)` **conserva su firma pública** y
resuelve el `ChainKey` internamente desde `agent.payment.chain` (vía
`normalizeChainSlug`). **NO se propaga un `chainKey` desde compose.**

Justificación (preferido por el work-item DT-2, alineado con CD-6):
- `compose.ts` NO se modifica (cero riesgo de regresión sobre el consumidor; el mapeo
  `downstream.*` en `:195-199` queda intacto).
- `compose.test.ts` NO se modifica (su mock `vi.fn().mockResolvedValue(null)` es
  signature-agnóstico).
- La resolución ocurre UNA sola vez dentro del módulo (CD-6) — no hay doble fuente.
- Diferencia con el inbound (WKH-111): el inbound resuelve desde un HEADER
  (`x-payment-chain`) que vive en el request; el outbound resuelve desde el MANIFEST
  del agente (`agent.payment.chain`) que ya está en el `Agent` pasado a la función. La
  fuente natural está dentro del scope de la función → resolución interna es lo
  correcto.

### DT-3 — Pre-flight balance check chain-aware (CERRADO)

**Decisión**: se **CONSERVA** la pre-flight balance check, hecha **chain-aware**
leyendo el balance del operator del token del adapter en la chain resuelta. Se
mantiene el skip-code `INSUFFICIENT_BALANCE` (mejor observabilidad que delegar
ciegamente al facilitator) y `BALANCE_READ_FAILED`.

Justificación:
- Preserva el comportamiento Avalanche (CD-1: el path Avalanche hoy hace pre-flight
  check y skip `INSUFFICIENT_BALANCE`; quitarlo cambiaría el comportamiento observable).
- Da observabilidad temprana: distingue "operator sin fondos en chain X" de un fallo
  genérico del facilitator.
- Es chain-aware: la address del token y la chain provienen del adapter
  (`adapter.getToken()`) y de `agent.payment.chain`, NO de literales (AC-6/CD-3).

**Forma concreta** (sin reintroducir `buildClients()` mono-chain): el adapter NO expone
un método de lectura de balance (`PaymentAdapter` no tiene `getBalance`), y extenderlo
es Scope OUT. Por tanto la balance check usa un **public client viem efímero** sobre la
chain resuelta, construido desde el `chainConfig.chainId` del bundle
(`getAdaptersBundle(chainKey).chainConfig.chainId`) + el RPC env de esa chain. Para
mantener CD-3 (sin hardcodes de chain), el `chainId` y el token vienen del registry/adapter,
NO de constantes locales. El RPC se resuelve por chain desde env
(`FUJI_RPC_URL`/`BASE_TESTNET_RPC_URL`/`KITE_RPC_URL`), con un mapa `ChainKey →
envVarName` documentado en el Story File.

> **Alternativa evaluada (delegar al facilitator)**: descartada porque cambia el
> comportamiento Avalanche (pierde el skip-code `INSUFFICIENT_BALANCE`) → CD-1.
>
> **Sub-decisión de implementación**: si construir un public client efímero por chain
> resulta en demasiada superficie de "mini-buildClients", el Dev PUEDE simplificar a
> "best-effort balance check, fail-soft": si no hay RPC env para la chain resuelta, se
> **omite** la pre-flight check (NO skip; se delega al facilitator) y se loguea un
> `info` "balance pre-check skipped (no RPC for <chain>)". El path Avalanche (que SÍ
> tiene `FUJI_RPC_URL`) mantiene su check intacto (CD-1). Esta sub-decisión la cierra
> el Story File con el mapa exacto de RPC env por chain; el invariante es: **el path
> Avalanche conserva su pre-flight check byte-equivalente** (CD-1).

### DT-4 — Semántica "fallar fuerte" bajo NEVER-throws (CERRADO)

**Decisión**: chain no soportada/no inicializada → **`return null` + `logger.error`**
(severidad ERROR, no info) con skip-code `CHAIN_NOT_SUPPORTED` y la lista de chains
inicializadas (`getInitializedChainKeys()`). **NO se emite telemetría/evento adicional**
en esta HU.

Justificación:
- Concilia "fallar fuerte" (input) con NEVER-throws (CD-7/H13): el módulo no puede
  lanzar (rompería el pipeline `/compose`), pero el log de severidad ERROR + la lista
  de chains hacen el fallo **visible y accionable** (no un silent skip).
- `logger.error` vs el `logger.info` que usa el guard legacy `!== 'avalanche'`: se sube
  la severidad porque ahora "chain no soportada" es una **misconfiguration accionable**
  (el agente declara una chain que el gateway debería soportar pero no inicializó), no
  un skip benigno esperado.
- **Requisito sobre el `DownstreamLogger`**: el shape actual (`types/index.ts`) expone
  `warn` + `info`. **NO expone `error`.** Verificar en el Story File: si
  `DownstreamLogger` no tiene `error`, se usa `logger.warn` (la severidad más alta
  disponible) con un campo `severity:'error'` en el objeto estructurado, O se extiende
  `DownstreamLogger` con `error?`. **Decisión: usar `logger.warn` con el objeto
  estructurado** (no extender el tipo — minimiza blast radius; Pino mapea igual y el
  campo `code:'CHAIN_NOT_SUPPORTED'` ya es grep-able). El Story File confirma el shape
  exacto de `DownstreamLogger`.
- Sin telemetría/evento extra: agregar un `eventService.track` acopla el módulo a una
  dependencia nueva (hoy NEVER-throws y dependency-free de eventos). Fuera de alcance;
  se documenta como mejora futura no bloqueante.

### DT-5 — Modo del adapter Kite para el downstream (CERRADO/CONFIRMADO)

**Decisión/Confirmación**: el sign+verify+settle downstream a Kite usa el modo
**canonical x402** del adapter (`KITE_FACILITATOR_MODE=x402`), NO `pieverse`.

Evidencia (verificada en código + validación onchain):
- El adapter Kite enruta `verify`/`settle` a `verifyX402`/`settleX402` cuando
  `getFacilitatorMode() === 'x402'` (`kite-ozone/payment.ts:236-238`, `:283-285`), y
  `sign()` firma `TransferWithAuthorization` contra el token PYUSD directo en ese modo
  (`:355-384`). Es el MISMO path que produjo el settle onchain `0xb861b69b` (status
  `0x1`) en `2026-05-27-multichain-deep-validation.md` Capa F (`:119`, `:161`) y Capa B
  (`:51`: "el path live verificado en prod es el canonical x402 contra el WasiAI
  facilitator").
- El downstream NO controla el modo: lo determina el env `KITE_FACILITATOR_MODE` del
  proceso. **Requisito operacional** (documentado en §9): para que el outbound a Kite
  settlee onchain válido, el gateway DEBE correr con `KITE_FACILITATOR_MODE=x402` (que
  es el modo de prod verificado). En modo `pieverse` (default del adapter sin env), el
  sign firma contra el contrato facilitator Pieverse — el downstream lo delegaría igual
  al adapter (no es responsabilidad del módulo decidir el modo), pero el path probado
  es x402. **El módulo NO fuerza ni lee `KITE_FACILITATOR_MODE`** (sería un hardcode de
  comportamiento de chain — CD-3); confía en el adapter. El SDD documenta el requisito
  de env para que el operador lo configure.

## 6. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (OBLIGATORIO)

- **CD-1** (cero regresión Avalanche): el path con `agent.payment.chain ===
  'avalanche'`/`'avalanche-fuji'` DEBE permanecer funcionalmente idéntico (mismo
  facilitator, USDC Fuji, `eip155:43113`, skip-codes, NEVER-throws). Los 1048 tests
  existentes (ajustados los de shape `blockNumber` opcional — DT-1) DEBEN seguir verdes.
  Cualquier diff observable funcional en el path Avalanche es BLOQUEANTE. (La única
  desviación declarada y acotada: `blockNumber` deja de poblarse — DT-1/TD-WKH-112-01;
  AR/CR la evalúa.)
- **CD-2** (solo viem, PROHIBIDO ethers.js): cualquier interacción onchain/firma usa
  viem v2 (vía el adapter, o el public client efímero de la balance check). No ethers.
- **CD-3** (sin hardcodes de chain): PROHIBIDO usar `DEFAULT_FUJI_USDC`/
  `DEFAULT_AVALANCHE_USDC`/`FUJI_NETWORK`/`AVALANCHE_NETWORK` ni literal de
  address/chainId/network/decimales como fuente de verdad del settle. Todo deriva del
  adapter (`getToken()`/`getNetwork()`/`supportedTokens[].decimals`) + chain-resolver +
  `chainConfig.chainId` del bundle. (RPC URL por chain desde env es tolerado, no es un
  literal de chain.)
- **CD-4** (fail-loud, no silent cross-chain): PROHIBIDO caer al default Avalanche o
  enviar a una chain distinta de la declarada cuando la chain no está
  soportada/inicializada. DEBE skip `CHAIN_NOT_SUPPORTED` + log con
  `getInitializedChainKeys()`.
- **CD-5** (TypeScript strict): PROHIBIDO `any` explícito y `as unknown`. El `ChainKey`
  resuelto se tipa como `ChainKey` (de `../adapters/types.js`), no `string`.
- **CD-6** (coherencia de chain): sign, verify y settle de un mismo pago DEBEN usar el
  mismo `ChainKey` resuelto UNA sola vez. PROHIBIDO resolver la chain más de una vez con
  fuentes distintas.
- **CD-7** (preservar NEVER-throws): `signAndSettleDownstream` DEBE seguir sin lanzar;
  devuelve `DownstreamResult` o `null`. El caller (compose) NO se rompe por una chain
  no soportada ni por un adapter que lance (los `verify`/`settle` del adapter PUEDEN
  throw en network error — DEBEN ir en try/catch).

### Nuevos del SDD (OBLIGATORIO)

- **CD-8** (decimales chain-aware — hereda CD-DEC-01 de WKH-67/072): el `value` atómico
  DEBE computarse con `parseUnits(String(priceUsdc), adapter.supportedTokens[0].decimals)`
  — NUNCA con la constante hardcodeada `6`. PROHIBIDO asumir 6 decimales: Kite/PYUSD es
  18-dec. AR/CR DEBE verificar que no quede ningún `USDC_DECIMALS = 6` usado en el
  cómputo del value. **Lección WKH-67/072: "params shared across chains must have same
  unit/decimals" — el value es dimensional por chain.**
- **CD-9** (delegar la firma, NO reimplementarla — hereda lección WKH-105/089): la
  firma EIP-3009 DEBE delegarse a `adapter.sign(...)`. PROHIBIDO reintroducir
  `signTypedData` inline o un domain EIP-712 construido en el módulo. El domain per-chain
  (Base Sepolia `name="USDC"`, Base Mainnet/Avax `name="USD Coin"`, Kite `name="PYUSD"`
  v1) lo encapsula el adapter y está validado onchain. Un domain inline mono-chain
  produciría `INVALID_SIGNATURE` silencioso en Base Sepolia (bug WKH-105/089).
- **CD-10** (resolución reutiliza el resolver puro): la resolución de `agent.payment.chain`
  DEBE usar `normalizeChainSlug`/`resolveChainKey` de `chain-resolver.ts`. PROHIBIDO
  inline una tabla de aliases o un `if (chain === 'base-sepolia')`.
- **CD-11** (NO modificar adapters/registry/chain-resolver/compose): `getPaymentAdapter`
  ya acepta el `chainKey`; `normalizeChainSlug` ya mapea los slugs; compose ya consume
  el shape. PROHIBIDO modificar `src/adapters/*`, `src/services/compose.ts`. Si el Dev
  cree que necesita extender `SettleResult` (blockNumber) → STOP y escalar (TD-WKH-112-01).

### PROHIBIDO (resumen)

- NO agregar dependencias nuevas.
- NO modificar `src/adapters/registry.ts`, `chain-resolver.ts`, ni ningún adapter.
- NO modificar `src/services/compose.ts` (DT-2) ni `src/services/compose.test.ts`.
- NO reintroducir el flujo inline (`buildClients`/`signTypedData`/`postFacilitator`).
- NO hardcodear chainIds/addresses/decimales/network tags.
- NO usar `any`/`as unknown`.
- NO romper el contrato NEVER-throws.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Drop de `blockNumber` rompe la regresión Avalanche (CD-1) | M | A | DT-1 opción C: `blockNumber` opcional, `txHash` (prueba canónica) intacto. Ajustar los tests de regresión Avalanche para no exigir `blockNumber`. TD-WKH-112-01 documenta la recuperación. AR/CR evalúa explícitamente. Si BLOQUEANTE → escalar subir `adapters/types.ts` al scope. |
| Reescritura de la estrategia de test (viem-mock → registry-mock) introduce flaky o pierde cobertura | M | A | W0 baseline 1048 verde; cada skip-code legacy se re-cubre en la nueva suite. Mock del adapter expone `sign`/`verify`/`settle`/`supportedTokens`/`getToken`. Verificar 1-a-1 que cada test legacy tiene equivalente. |
| Decimales: usar 6 para Kite (18) firma un value 10^12× errado | B | A | CD-8: `value = parseUnits(price, adapter.supportedTokens[0].decimals)`. Test dedicado Kite-18-dec (guard WKH-67/072). |
| Domain EIP-712 inline residual produce INVALID_SIGNATURE en Base Sepolia | B | A | CD-9: la firma se delega 100% al adapter; AR/CR grep que no quede `signTypedData` en el módulo. Lección WKH-105/089. |
| Pre-flight balance check chain-aware reintroduce mono-chain `buildClients` | M | M | DT-3: public client efímero por chain desde `chainConfig.chainId` + RPC env; fail-soft si no hay RPC (path Avalanche conserva su check). Story File define el mapa `ChainKey→RPC env`. |
| Mock incompleto del registry en tests legacy compartidos rompe build | M | M | **Lección WKH-111/093 auto-blindaje**: tras el cambio, `grep -rn "vi.mock('.*adapters/registry"` y verificar que todos exporten `getPaymentAdapter` + `getAdaptersBundle` + `getInitializedChainKeys`. Un mock incompleto devuelve `undefined` silencioso. |
| `DownstreamLogger` no tiene `.error` y el log de fail-loud falla en runtime | B | M | DT-4: usar `logger.warn` con objeto estructurado `code:'CHAIN_NOT_SUPPORTED'`. Story File confirma el shape de `DownstreamLogger`. |
| `KITE_FACILITATOR_MODE` no es x402 en el entorno → sign Kite usa pieverse | M | M | DT-5/§9: requisito operacional documentado. El módulo NO fuerza el modo (CD-3); el operador configura `KITE_FACILITATOR_MODE=x402`. No bloquea unit tests (mockean el adapter). |
| `tsc --noEmit` pelado reporta TS6059 preexistente | B | B | **Lección WKH-111/093**: usar `tsc -p tsconfig.build.json --noEmit` como typecheck autoritativo. |

## 8. Dependencias

- `normalizeChainSlug`/`resolveChainKey` (`chain-resolver.ts`) — ya existen.
- `getPaymentAdapter(chainKey)`/`getAdaptersBundle`/`getInitializedChainKeys`
  (`registry.ts`) — ya existen, no se modifican.
- `BasePaymentAdapter`/`AvalanchePaymentAdapter`/`KiteOzonePaymentAdapter` con
  `sign/verify/settle/getToken/getNetwork/supportedTokens` — ya existen.
- viem `createPublicClient`/`erc20Abi`/`parseUnits` — ya importados (balance check).

## 9. Requisitos operacionales (documentados, no bloquean unit tests)

- **`WASIAI_A2A_CHAINS`** DEBE incluir las chains a las que el gateway settlea outbound
  (e.g. `kite-ozone-testnet,base-sepolia,avalanche-fuji`). Si la chain del agente no
  está en el CSV, `getAdaptersBundle` → undefined → skip `CHAIN_NOT_SUPPORTED` (AC-4).
  En prod las 3 testnets ya están inicializadas (`2026-05-27...validation.md` Capa D).
- **`KITE_FACILITATOR_MODE=x402`** para que el outbound a Kite produzca settle onchain
  válido (DT-5). En prod ya está (path verificado).
- **`OPERATOR_PRIVATE_KEY`** funded en USDC/PYUSD en cada chain destino (ya funded en
  las 3 — H15 / Capa E-F).
- **RPC env por chain** para la pre-flight balance check (DT-3):
  `FUJI_RPC_URL`/`AVALANCHE_RPC_URL`/`BASE_TESTNET_RPC_URL`/`KITE_RPC_URL`. El Story File
  define el mapa exacto `ChainKey → env var`. Si falta el RPC de una chain, la balance
  check se omite fail-soft (el facilitator falla si no hay fondos).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| TD-WKH-112-01 | 5/DT-1 | `SettleResult` del adapter no expone `blockNumber`/`amount`. El downstream pierde `downstreamBlockNumber`. Recuperable extendiendo `adapters/types.ts` en una HU futura. Hoy `blockNumber` opcional. | No (a menos que AR lo marque) |

> Sin `[NEEDS CLARIFICATION]` pendientes. Los 5 DT del work-item cerrados en §5.

---

## Plan — Waves de Implementación

> Las ejecuta el Dev en F3 desde el Story File (F2.5). Aquí el plan que el Story File
> detallará por archivo exacto.

### Wave 0 (Serial Gate — prerequisitos)

- [ ] **W0.1**: `npm test` baseline — confirmar 1048 verdes ANTES de tocar nada
  (línea base de CD-1). Registrar el número exacto.
- [ ] **W0.2**: `tsc -p tsconfig.build.json --noEmit` baseline limpio (typecheck
  autoritativo — NO el `tsc --noEmit` pelado; lección WKH-111/093).
- [ ] **W0.3**: Confirmar que las 3 testnets resuelven y exponen el primitivo: con
  `WASIAI_A2A_CHAINS=kite-ozone-testnet,base-sepolia,avalanche-fuji` + `initAdapters()`,
  para cada `ChainKey`: `getAdaptersBundle(K) !== undefined`,
  `getPaymentAdapter(K).getNetwork()` correcto (`eip155:84532`/`eip155:43113`/
  `eip155:2368`), y `getPaymentAdapter(K).sign` / `.verify` / `.settle` definidos.
  Confirmar `getPaymentAdapter('base-sepolia').supportedTokens[0].decimals === 6` y
  `getPaymentAdapter('kite-ozone-testnet').supportedTokens[0].decimals === 18`.

### Wave 1 (Resolución de chain + fail-loud)

- [ ] **W1.1**: En `downstream-payment.ts`, importar `ChainKey`
  (`../adapters/types.js`), `normalizeChainSlug` (`../adapters/chain-resolver.js`),
  `getPaymentAdapter`/`getAdaptersBundle`/`getInitializedChainKeys`
  (`../adapters/registry.js`).
- [ ] **W1.2**: Reemplazar el guard `if (agent.payment.chain !== 'avalanche')`
  (`:457-467`) por: `chainKey = normalizeChainSlug(agent.payment.chain)` → si undefined
  o `getAdaptersBundle(chainKey)` undefined → skip `CHAIN_NOT_SUPPORTED` + log con
  `getInitializedChainKeys()` (DT-4/CD-4).
- [ ] **W1.3**: Tests de fail-loud: chain no reconocida + chain reconocida no
  inicializada (AC-4).

### Wave 2 (Delegación sign+verify+settle al adapter)

- [ ] **W2.1**: Resolver `adapter = getPaymentAdapter(chainKey)` (CD-6). Computar
  `decimals = adapter.supportedTokens[0].decimals`; `value = parseUnits(String(priceUsdc),
  decimals)` (CD-8).
- [ ] **W2.2**: Pre-flight balance check chain-aware (DT-3) — public client efímero por
  chain desde `chainConfig.chainId` + RPC env; fail-soft si no hay RPC. Conservar
  skip-codes `INSUFFICIENT_BALANCE`/`BALANCE_READ_FAILED`.
- [ ] **W2.3**: `signed = await adapter.sign({to, value, timeoutSeconds})` (try/catch →
  `SIGNING_FAILED`); `verifyRes = await adapter.verify({...signed.paymentRequest})`
  (try/catch + `valid` → `VERIFY_FAILED`); `settleRes = await adapter.settle({...})`
  (try/catch + `success` → `SETTLE_FAILED`). Coherencia chain (CD-6/AC-5).
- [ ] **W2.4**: Construir `DownstreamResult { txHash, settledAmount: value.toString(),
  ...(blockNumber && {blockNumber}) }` (DT-1 opción C).
- [ ] **W2.5**: BORRAR helpers legacy obsoletos (DT-1): `getDownstreamNetwork`,
  `getUsdcAddress`, `getUsdcEip712Version`, `buildClients`, `buildCanonicalBody`,
  `postFacilitator`, `getFacilitatorUrl`, `TRANSFER_WITH_AUTHORIZATION_TYPES`, constantes
  de chain, wire-types. Limpiar imports viem no usados.
- [ ] **W2.6**: Reescribir `downstream-payment.test.ts` a mock-registry (selección
  Base/Avalanche/Kite, regresión Avalanche, decimales Kite-18). Retirar
  `downstream-payment.mainnet.test.ts` (DT-1).
- [ ] **W2.7 (verif)**: `tsc -p tsconfig.build.json --noEmit` + `npm test` suite
  completa verde (CD-1). `grep -rn "vi.mock('.*adapters/registry" src/` y verificar que
  todos los mocks exporten las funciones nuevas (lección WKH-111/093).

### Wave 3 (Validación E2E — la corre el humano)

- [ ] **W3.1**: Smoke outbound real (si existe script) o evidencia onchain fresh
  Base/Kite/Avalanche vía `/compose` contra un gateway con las 3 testnets + facilitator
  + operator funded. Evidencia: tx hash en el explorer de cada chain (AC-1/AC-3).
- [ ] **W3.2**: Confirmar 1048 (+ nuevos) tests verdes, cero regresión Avalanche (AC-2).

### Dependencias

| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.* | W0.1, W0.2, W0.3 | Baseline + confirmación de que las 3 chains resuelven y exponen el primitivo. |
| W2.* | W1.* | La delegación reusa el `chainKey` resuelto. |
| W3.* | W2.* | El smoke ejercita el código nuevo end-to-end. |

### Archivos involucrados

| Archivo | Existe | Acción | Wave | Exemplar |
|---------|--------|--------|------|----------|
| `src/lib/downstream-payment.ts` | Sí | Modificar | W1-W2 | x402.ts (WKH-111) + adapters |
| `src/lib/downstream-payment.test.ts` | Sí | Reescribir mock | W2.6 | `compose.test.ts:24-28` |
| `src/lib/downstream-payment.mainnet.test.ts` | Sí | Retirar | W2.6 | — |
| `src/services/compose.ts` | Sí | NO modificar | — | — |

## Test Plan

> Framework: vitest. **Cambio de estrategia**: el módulo ya NO firma inline, así que los
> tests dejan de mockear `viem` directo y pasan a **mockear el registry/adapter**
> (`vi.mock('../adapters/registry.js', () => ({ getPaymentAdapter, getAdaptersBundle,
> getInitializedChainKeys }))`). El mock del adapter expone `sign`/`verify`/`settle`/
> `supportedTokens`/`getToken`/`getNetwork`. El flag `WASIAI_DOWNSTREAM_X402` se sigue
> leyendo at module-load → reusar `vi.resetModules()` + import dinámico (patrón legacy
> `:69-76`). El smoke E2E (W3) ejercita adapter + facilitator + viem reales.

| Test | AC que cubre | Wave | Qué prueba / qué se mockea |
|------|-------------|------|----------------------------|
| **T-AC1**: settle outbound Base | AC-1 | W2.6 | Agent `chain:'base-sepolia'`. Mock `getPaymentAdapter('base-sepolia')` → `sign→{paymentRequest:{authorization,signature,network:'eip155:84532'}}`, `verify→{valid:true}`, `settle→{txHash:'0xBASE',success:true}`, `supportedTokens:[{decimals:6}]`. Afirma `DownstreamResult.txHash==='0xBASE'`, `settledAmount==='500000'` (6-dec), y que `getPaymentAdapter` se invocó con `'base-sepolia'`. |
| **T-AC2a**: regresión Avalanche (sign delegado) | AC-2/CD-1 | W2.6 | Agent `chain:'avalanche'` → resuelve `'avalanche-fuji'`. Mock adapter Fuji `decimals:6`, network `eip155:43113`. Afirma `value=500000n`, settledAmount `'500000'`, txHash preservado, NO se lanza. |
| **T-AC2b**: regresión Avalanche (alias 'avalanche-fuji') | AC-2/CD-1 | W2.6 | Agent `chain:'avalanche-fuji'`. Mismo adapter Fuji. Afirma comportamiento idéntico a T-AC2a. |
| **T-AC3**: settle outbound Kite (18-dec) | AC-3/CD-8 | W2.6 | Agent `chain:'kite-ozone-testnet'`. Mock adapter Kite `supportedTokens:[{decimals:18}]`, network `eip155:2368`. Afirma `value = parseUnits('0.5',18) = 500000000000000000n` (NO 500000n), txHash `'0xKITE'`. **Guard dimensional (WKH-67/072).** |
| **T-AC4a**: chain no reconocida | AC-4/CD-4 | W1.3 | Agent `chain:'solana'`. `normalizeChainSlug→undefined`. Afirma `null` + `logger.warn`/`error` con `code:'CHAIN_NOT_SUPPORTED'` y NO se llama `sign`. |
| **T-AC4b**: chain reconocida no inicializada | AC-4/CD-4 | W1.3 | Agent `chain:'base-sepolia'` con `getAdaptersBundle` mock → undefined. Afirma `null` + `code:'CHAIN_NOT_SUPPORTED'` + log con `getInitializedChainKeys()`. NO fallback Avalanche. |
| **T-AC5**: coherencia mismo chainKey sign↔verify↔settle | AC-5/CD-6 | W2.6 | Agent `chain:'base-sepolia'`. Afirma que `getPaymentAdapter` se invocó SIEMPRE con `'base-sepolia'` (sign, verify, settle) — nunca con default ni con otra chain. |
| **T-AC6**: sin hardcodes — address/network del adapter | AC-6/CD-3 | W2.6 | Afirma que el `to`/`value` del `sign` y el `network` del settle provienen del adapter mockeado (token/network distintos por chain), no de literales. |
| **T-SkipFlagOff**: flag off → null | CD-7 | W2.6 | (conservado) `WASIAI_DOWNSTREAM_X402` off → null sin tocar adapter. |
| **T-SkipNoPayment / Method / PayTo / Price**: skips tempranos | CD-7 | W2.6 | (conservados) payment ausente, method≠x402, payTo inválido/zero, priceUsdc no finito → null + skip-code correcto, sin tocar adapter. |
| **T-SkipSigningFailed**: `adapter.sign` lanza | CD-7 | W2.6 | Mock `sign→reject`. Afirma null + `SIGNING_FAILED`. |
| **T-SkipVerifyFailed**: `verify` lanza o valid=false | CD-7 | W2.6 | Mock `verify→{valid:false}` y `verify→reject`. Afirma null + `VERIFY_FAILED`. |
| **T-SkipSettleFailed**: `settle` lanza o success=false | CD-7 | W2.6 | Mock `settle→{success:false,error}` y `settle→reject`. Afirma null + `SETTLE_FAILED`. |
| **T-Balance**: insuficiente / read fail (DT-3) | CD-1 | W2.6 | (conservados, chain-aware) balance < value → `INSUFFICIENT_BALANCE`; read RPC throw → `BALANCE_READ_FAILED`; sin RPC env → fail-soft (no skip). |
| **smoke outbound** (E2E) | AC-1/AC-3 | W3.1 | Oráculo real: adapter + facilitator + viem. tx hash en explorer por chain. |

> Cobertura: AC-1 (T-AC1), AC-2 (T-AC2a, T-AC2b), AC-3 (T-AC3), AC-4 (T-AC4a, T-AC4b),
> AC-5 (T-AC5), AC-6 (T-AC6). ≥1 test por AC + guard dimensional Kite + todos los
> skip-codes preservados. El Story File enumera la lista 1-a-1 contra los tests legacy
> para garantizar que NO se pierde cobertura.

## Verificación Incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | baseline `npm test` (1048 verde) + `tsc -p tsconfig.build.json --noEmit` limpio + 3 chains resuelven el primitivo |
| W1 | tests fail-loud verdes + suite sin regresión |
| W2 | `tsc -p tsconfig.build.json --noEmit` + `npm test` suite completa verde (incl. reescritos) + grep mocks registry completos |
| W3 | smoke E2E verde (tx hash por chain) + full suite verde |

## Estimación

- Archivos modificados: 1 prod (`downstream-payment.ts`, neto NEGATIVO en líneas por
  el borrado de helpers legacy).
- Archivos de test: 1 reescrito (`downstream-payment.test.ts`), 1 retirado
  (`downstream-payment.mainnet.test.ts`).
- Tests: ~15 unit (reescritos/nuevos) + 1 smoke E2E.
- Líneas estimadas: prod neto ~-150/+90 (borrado > agregado); test ~+250.

---

## Readiness Check (Architect — ejecutado antes de SPEC_APPROVED)

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado (downstream-payment.ts + .test.ts)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read (x402.ts/WKH-111, compose.ts:438-447, adapters, compose.test.ts:24-28)
[x] No hay [NEEDS CLARIFICATION] pendientes — DT-1..DT-5 cerrados en §5; 1 TD no bloqueante (TD-WKH-112-01)
[x] Constraint Directives ≥3 PROHIBIDO (CD-1..CD-11 + sección PROHIBIDO)
[x] Context Map ≥2 archivos leídos (12 archivos, líneas reales verificadas)
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: N/A (no aplica) — declarado
[x] Happy Path completo (§4.4)
[x] Flujo de error definido — 9 casos (§4.5)
[x] Cada AC tiene ≥1 test en Test Plan
[x] DTs abiertos del work-item cerrados (DT-1 alcance+shape, DT-2 firma, DT-3 balance, DT-4 fail-loud, DT-5 modo Kite)
[x] Auto-Blindaje histórico revisado (3 últimas DONE: WKH-111/093, WKH-106/090, WKH-105/089):
    - CD-8 hereda CD-DEC-01 (WKH-67/072 decimals mismatch) — value dimensional por chain
    - CD-9 aplica lección WKH-105/089 (domain EIP-712 per-chain; delegar al adapter)
    - W0.2/W2.7 aplican lección WKH-111/093 (tsc -p tsconfig.build.json; grep mocks registry completos)
    - Estrategia de test mock-registry aplica patrón WKH-111/093 + WKH-105/089 (fixture per-chain)
```

Todos los checks pasan. SDD listo para presentar al humano en GATE 2 (SPEC_APPROVED).

---

*SDD generado por NexusAgil — FULL — WKH-112 (BASE-07)*
