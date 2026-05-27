# SDD #093: [WKH-111] [BASE-06] x402 payment path chain-aware

> SPEC_APPROVED: no
> Fecha: 2026-05-27
> Tipo: feature (evolutivo sobre superficie crítica de pagos)
> SDD_MODE: full
> Branch: feat/093-wkh-111-x402-chain-aware
> Artefactos: doc/sdd/093-wkh-111-x402-chain-aware/
> Work item: doc/sdd/093-wkh-111-x402-chain-aware/work-item.md

---

## 1. Resumen

El path x402 **inbound** del gateway (`src/middleware/x402.ts`) hoy es chain-blind:
`buildX402Response` (challenge 402), `verify` y `settle` llaman `getPaymentAdapter()`
**sin `chainKey`**, por lo que siempre resuelven el bundle DEFAULT (Kite,
`eip155:2368`, token de 18 decimales, amount fallback `1e18`). El header
`x-payment-chain: base-sepolia` se ignora en la rama sin a2a-key (que delega a
`requirePayment`). Resultado: ningún settle onchain rutea a Base y el smoke
`scripts/smoke-base-sepolia.mjs` falla porque el challenge anuncia Kite.

Esta HU hace **wiring** (no rewrite): `requirePayment` resuelve `x-payment-chain`
vía la función pura `resolveChainKey` (idéntico patrón a `a2a-key.ts`), valida que
la chain esté inicializada (400 `CHAIN_NOT_SUPPORTED` fail-loud), y propaga un
único `chainKey: ChainKey` a `buildX402Response`/`verify`/`settle`. El challenge
402 refleja `network`/`asset`/`maxAmountRequired` (decimales) de la chain resuelta.
**Cero regresión** para el path Kite default: sin header, el comportamiento es
byte-idéntico al actual.

Resultado esperado: el smoke Base Sepolia pasa a verde (tx hash real en Basescan,
AC-1/AC-2) y los 1039 tests existentes siguen verdes (AC-3).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 093 (WKH-111) |
| **Tipo** | feature / evolutivo |
| **SDD_MODE** | full (QUALITY) |
| **Objetivo** | Hacer chain-aware challenge/verify/settle del path x402 inbound, ruteando al adapter de `x-payment-chain` con cero regresión Kite. |
| **Reglas de negocio** | Golden Path payments: sin hardcodes de chain, solo viem, TS strict, fail-loud en chain no soportada, coherencia de chain en todo el flujo. |
| **Scope IN** | `src/middleware/x402.ts` (núcleo), `src/middleware/a2a-key.ts` (solo si el wiring lo requiere — se confirma que NO, ver §4.3), tests unitarios (`src/middleware/x402.chain-aware.test.ts`). |
| **Scope OUT** | Outbound downstream (`downstream-payment.ts`), Base Mainnet, modelo a2a-key/budget, multi-`accepts`. |
| **Missing Inputs** | Cerrados en este SDD (DT-3, DT-5, ownership de resolución). Requisito operacional de env documentado en §8/§9. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** (Event-driven — challenge chain-aware): WHEN un request a `/compose`
  trae `x-payment-chain: base-sepolia` sin `x-a2a-key` ni `payment-signature`,
  THEN the system SHALL responder 402 con `accepts[0].network = eip155:84532`,
  `accepts[0].asset =` la dirección USDC de Base Sepolia, y
  `accepts[0].maxAmountRequired` expresado en 6 decimales (NO el default 1e18 de Kite).

- **AC-2** (Event-driven — verify+settle ruteado a Base): WHEN se reenvía un
  `payment-signature` EIP-3009 válido con `x-payment-chain: base-sepolia`, THEN
  the system SHALL ejecutar `verify` y `settle` contra el adapter de Base
  (`network = eip155:84532`) y, ante settle exitoso, retornar HTTP 200 con
  header `payment-response` conteniendo el tx hash.

- **AC-3** (Ubiquitous — CERO regresión Kite default): WHEN un request NO envía
  `x-payment-chain`, THEN the system SHALL comportarse byte-idéntico al path
  actual (bundle default = Kite, challenge `eip155:2368`, fallback amount `1e18`)
  y los 1039 tests existentes SHALL permanecer verdes.

- **AC-4** (Unwanted — chain no inicializada): IF `x-payment-chain` trae un
  slug/chainId que NO está inicializado en el registry (o no reconocido), THEN
  the system SHALL retornar HTTP 400 con `error_code: CHAIN_NOT_SUPPORTED` y un
  mensaje que incluya la lista de chains inicializadas (`getInitializedChainKeys()`),
  sin caer silenciosamente al default.

- **AC-5** (State-driven — coherencia del settle con el challenge): WHILE el
  request declara una chain via header, the system SHALL usar el MISMO `chainKey`
  resuelto para el challenge, el `verify` y el `settle` (no mezclar el `network`
  del payload del cliente con un bundle distinto al anunciado).

## 3. Context Map (Codebase Grounding)

### Archivos leídos (todos verificados con Read, líneas reales)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/middleware/x402.ts` | Núcleo del cambio | `buildX402Response` (`:44-69`) llama `getPaymentAdapter()` sin arg (`:49`) y usa `opts.amount ?? '1000000000000000000'` (`:52`). `verify` (`:142`) y `settle` (`:175`) llaman `getPaymentAdapter().verify/settle` sin arg, pasando `network: paymentPayload.network ?? ''`. `requirePayment` (`:96-209`) no lee `x-payment-chain`. `decodeXPayment` (`:71-94`) ya parsea el envelope (incluye `.network`). |
| `src/middleware/a2a-key.ts` | Exemplar de resolución + 400 ya implementado | Steps de resolución (`:188-224`): lee `request.headers['x-payment-chain']` (`:193-195`), `resolveChainKey({ headerOverride })` (`:198`), si `!chainKey && headerOverride !== undefined` → 400 `CHAIN_NOT_SUPPORTED` (`:200-206`), si header ausente → `getDefaultChainKey()` (`:208`), luego `getAdaptersBundle(chainKey)` → si `!bundle` 400 con `getInitializedChainKeys().join(', ')` (`:217-224`). **Este es el patrón a replicar en x402.ts.** |
| `src/adapters/registry.ts` | Accessor + helpers ya existen | `getPaymentAdapter(chainKey?: ChainKey)` (`:172-174`) ya acepta el arg y resuelve el bundle correcto vía `resolveBundleOrThrow`. `getAdaptersBundle(chainKey?)` (`:213-220`) no-throw. `getInitializedChainKeys()` (`:226-228`), `getDefaultChainKey()` (`:234-236`). |
| `src/adapters/chain-resolver.ts` | Función pura reutilizable | `resolveChainKey({ headerOverride })` (`:77-88`) mapea slug/chainId → `ChainKey`; devuelve `undefined` para input desconocido. `'base-sepolia'`/`'84532'`/`'base-testnet'` → `'base-sepolia'` (`:49-51`). Total — nunca throw. |
| `src/adapters/base/payment.ts` | Shape de la chain Base | `getNetwork()` → `eip155:84532` (`:363-365`), `getToken()` → USDC Base Sepolia (`:367-369`), `supportedTokens[0].decimals = 6` (`USDC_DECIMALS`, `:58`, `:349-357`), `getMaxTimeoutSeconds()` → 60 (`:371-373`), `quote()` → `amountWei: '1000000'` (1 USDC = 6-dec, `:387-399`). |
| `src/adapters/kite-ozone/payment.ts` | Shape de la chain default | `getNetwork()` → `eip155:2368` (`:222-224`), `supportedTokens[0].decimals = 18` (`:214-217`), `getMaxTimeoutSeconds()` → 300 (`:228-230`), `quote()` → `amountWei: '1000000000000000000'` (18-dec, `:330-337`). |
| `src/adapters/types.ts` | Tipo `ChainKey` | `ChainKey` (`:122-128`) union: `'kite-ozone-testnet' | 'kite-mainnet' | 'avalanche-fuji' | 'avalanche-mainnet' | 'base-sepolia' | 'base-mainnet'`. `AdaptersBundle` (`:135-145`) con `payment`, `chainConfig.chainId`. |
| `src/middleware/x402.passport-shape.test.ts` | Exemplar de test del middleware | Patrón: `vi.mock('../adapters/registry.js', () => ({ getPaymentAdapter: () => mockAdapter }))` ANTES del import (`:34-36`); `mockAdapter` con `verify/settle/getToken/getNetwork/getScheme/getMerchantName/getMaxTimeoutSeconds` (`:24-32`); Fastify in-memory + `app.inject` (`:74-101`); guarda/restaura `KITE_WALLET_ADDRESS` (`:42-58`). |
| `scripts/smoke-base-sepolia.mjs` | Oráculo E2E read-only | Envía `x-payment-chain: base-sepolia` en el probe (`:216`) y en el pago (`:360`). Lee `accepts[0].network/payTo/maxAmountRequired` (`:239-257`), honra el `maxAmountRequired` anunciado al firmar (`:261-270`), espera HTTP 200 + tx hash en body/header `x-payment-response` (`:377-426`). |

### Exemplars (verificados — existen en disco)

| Para crear/modificar | Seguir patrón de | Razón |
|----------------------|------------------|-------|
| Resolución de chain + 400 en `requirePayment` (`x402.ts`) | `src/middleware/a2a-key.ts:188-224` | Misma fuente (`x-payment-chain`), mismo resolver (`resolveChainKey`), mismo error code (`CHAIN_NOT_SUPPORTED`), mismo mensaje con `getInitializedChainKeys()`. No duplicar tabla de aliases (DT-4). |
| Test `src/middleware/x402.chain-aware.test.ts` (nuevo) | `src/middleware/x402.passport-shape.test.ts` | Mock registry + Fastify inject. Reusar estructura de `beforeEach`/`afterEach` que guarda/restaura env. |
| Selección del default amount por chain | `BasePaymentAdapter.quote()` (`base/payment.ts:387-399`) y `KiteOzonePaymentAdapter.quote()` (`kite-ozone/payment.ts:330-337`) | `quote(amountUsd).amountWei` ya devuelve el monto en los decimales correctos por chain (Base: `'1000000'`; Kite: `'1000000000000000000'`). Fuente dimensional correcta para DT-5. |

### Estado de BD relevante

N/A — esta HU no toca BD. El path inbound x402 sin a2a-key no hace debit ni
budget; solo challenge/verify/settle onchain vía facilitator.

### Componentes reutilizables encontrados

- `resolveChainKey` (`chain-resolver.ts`) — pura, ya usada en `a2a-key.ts`. **Reutilizar, no duplicar.**
- `getPaymentAdapter(chainKey?)` (`registry.ts:172`) — ya acepta el arg. **No modificar el registry.**
- `getAdaptersBundle` / `getInitializedChainKeys` / `getDefaultChainKey` — ya existen para el 400.
- `adapter.quote()` por chain — fuente del default amount dimensional (DT-5).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué cambia | Exemplar |
|---------|--------|-----------|----------|
| `src/middleware/x402.ts` | Modificar | (a) `buildX402Response` acepta `chainKey: ChainKey` y lo pasa a `getPaymentAdapter(chainKey)`; el amount fallback deja de ser literal `1e18` y deriva del adapter (DT-5). (b) `verify`/`settle` usan `getPaymentAdapter(chainKey)`. (c) `requirePayment` resuelve `x-payment-chain` una sola vez (DT-4/CD-6), valida (400 `CHAIN_NOT_SUPPORTED`, DT-3/CD-5) y propaga el `chainKey` a las 3 llamadas. | `a2a-key.ts:188-224` |
| `src/middleware/a2a-key.ts` | **NO se modifica** | El wiring del fallback NO requiere pasar el chainKey: `runX402Fallback` (`:59-89`) invoca los handlers de `requirePayment` tal cual; `requirePayment` resuelve la chain internamente desde `request.headers` (DT confirmado §4.3). Cero cambios en a2a-key.ts. | — |
| `src/middleware/x402.chain-aware.test.ts` | Crear | Tests unitarios: challenge Base 6-dec (AC-1), verify+settle ruteados a Base (AC-2), cero regresión default Kite (AC-3), 400 `CHAIN_NOT_SUPPORTED` (AC-4), coherencia mismo chainKey en challenge/verify/settle (AC-5). | `x402.passport-shape.test.ts` |
| `scripts/smoke-base-sepolia.mjs` | **NO se modifica** (read-only) | Es el oráculo E2E. Pasa a verde como evidencia de AC-1/AC-2. | — |

### 4.2 Modelo de datos

N/A — sin cambios de BD.

### 4.3 Diseño de la resolución de chain (cierre de Missing Inputs)

#### Decisión: `requirePayment` resuelve la chain solo (NO se modifica `a2a-key.ts`)

**Confirmado**: la rama SIN a2a-key entra a `runX402Fallback` (`a2a-key.ts:121`),
que ejecuta los handlers que `requirePayment` produjo. Esos handlers reciben el
`request` Fastify completo, por lo tanto **`requirePayment` puede leer
`request.headers['x-payment-chain']` por sí mismo**. No hace falta que `a2a-key.ts`
le pase el chainKey.

Justificación (preferido por el work-item, alineado con CD-6 y la regla anti-duplicación):
- Evita duplicar la lógica de resolución y la decisión 400 en dos sitios.
- Mantiene `a2a-key.ts` intacto → cero riesgo de regresión sobre el path a2a-key/budget
  (que ya es chain-aware para el debit, fuera de scope).
- La resolución ocurre UNA sola vez por flujo (CD-6): `requirePayment` resuelve al
  inicio del handler y reusa el mismo `chainKey` para challenge/verify/settle.

**Nota de no-colisión**: cuando hay a2a-key, `requirePayment` NO se ejecuta
(la rama a2a-key debita y ejecuta sin pasar por x402). Cuando NO hay a2a-key,
`a2a-key.ts` no toca la chain. Por tanto no hay doble resolución cross-middleware.

#### Helper interno de resolución en `requirePayment`

`requirePayment` debe resolver el `chainKey` **una vez al inicio del handler**,
ANTES del branch `if (!xPaymentHeader)` (porque el challenge 402 también lo necesita).
La lógica replica `a2a-key.ts:188-224` (sin el bloque de budget/debit):

1. `headerRaw = request.headers['x-payment-chain']`; `headerOverride = typeof headerRaw === 'string' ? headerRaw : undefined`.
2. `let chainKey = resolveChainKey({ headerOverride })`.
3. Si `!chainKey`:
   - Si `headerOverride !== undefined` → **400** `{ error_code: 'CHAIN_NOT_SUPPORTED', error: "Chain '<headerOverride>' is not a recognized slug or chainId" }` (CD-5, DT-3).
   - Si header ausente → `chainKey = getDefaultChainKey() ?? undefined`; si sigue undefined → **500** `REGISTRY_NOT_INITIALIZED` (mismo shape que a2a-key.ts:209-214).
4. Si `getAdaptersBundle(chainKey)` es `undefined` (slug reconocido pero NO inicializado) → **400** `{ error_code: 'CHAIN_NOT_SUPPORTED', error: "Chain '<chainKey>' is not initialized. Initialized: <getInitializedChainKeys().join(', ')>" }` (AC-4, CD-5).
5. El `chainKey: ChainKey` resuelto se propaga a `buildX402Response(opts, resource, chainKey, ...)`, `getPaymentAdapter(chainKey).verify(...)` y `getPaymentAdapter(chainKey).settle(...)`.

> **CRÍTICO orden de ejecución**: la resolución/validación de chain va DESPUÉS del
> guard de wallet (`x402.ts:103-113`) y DESPUÉS del set de `paymentOrigin`
> (`:116-120`), pero ANTES de leer `payment-signature` (`:122`). Así el 400
> `CHAIN_NOT_SUPPORTED` se dispara tanto en el challenge (sin payment-signature)
> como en verify/settle (con payment-signature). Esto satisface AC-4 en ambos
> sub-casos y AC-5 (mismo chainKey para todo el flujo).

#### DT-3 — Conciliación `x-payment-chain` vs `paymentPayload.network` (CERRADO)

**Decisión**: el header `x-payment-chain` es la **única fuente de verdad** para
seleccionar el bundle/adapter. El `paymentPayload.network` del cliente **NO** se
usa para seleccionar el adapter; se sigue pasando como argumento `network` a
`adapter.verify/settle` (igual que hoy, `x402.ts:145`/`:178`) porque ese campo lo
consume el adapter para construir el envelope canónico, pero **el adapter ya está
fijado por el `chainKey` resuelto del header**.

Manejo de mismatch (header presente vs `paymentPayload.network` distinto):
- **Política elegida: el header gana, sin 400 por mismatch en esta HU.** El adapter
  seleccionado por `chainKey` construye su propio `network` tag canónico
  (`getNetworkTag` en `base/payment.ts:221-225` / `kite-ozone/payment.ts:30-34`) e
  ignora el `network` declarado por el cliente para fines de ruteo. Por tanto un
  cliente NO puede forzar una chain distinta a la anunciada en el challenge: aunque
  mienta en `paymentPayload.network`, el verify/settle van al adapter del header.
- **Seguridad**: esto previene cross-chain confusion. El challenge anunció chain X
  (header), el cliente firmó para chain X (el smoke firma con el domain de la chain
  del challenge, `smoke:296-326`), y verify/settle se ejecutan en chain X. Si el
  cliente pusiera `paymentPayload.network` de chain Y, el adapter de X lo rechazaría
  en verify (firma inválida para el domain de X) — fail seguro, no cross-chain leak.
- **Por qué NO un 400 explícito por mismatch en esta HU**: el adapter ya provee la
  defensa (la firma EIP-712 está atada al domain/chainId; un network mentido produce
  `verify.valid === false`). Agregar un 400 explícito de reconciliación amplía la
  superficie sin beneficio de seguridad neto y arriesga la byte-compat del path
  default (CD-1: hoy el path Kite pasa `paymentPayload.network ?? ''` sin validar).
  Se documenta como TD candidato (TD-WKH-111-01) si Adversary lo pide en F2.5/AR.
- **Si viene `payment-signature` pero NO header `x-payment-chain`**: se usa el
  default (Kite), byte-idéntico al actual (AC-3). El `paymentPayload.network` se pasa
  como hoy. NO se intenta inferir la chain desde `paymentPayload.network` (eso sería
  un cambio de comportamiento del path default → viola CD-1).

#### DT-5 — Default amount por chain cuando no hay `opts.amount` (CERRADO)

**Problema**: hoy `buildX402Response` usa `opts.amount ?? '1000000000000000000'`
(`x402.ts:52`), un literal 18-dec hardcodeado. Para Base (USDC 6-dec) eso anunciaría
`1e18` micro-USDC = 10^12 USDC, absurdo, y el smoke firmaría una cantidad imposible.

**Decisión**: cuando `opts.amount` NO está presente, el default amount se deriva del
**adapter de la chain resuelta**, NO de un literal. Fuente dimensional correcta:
`adapter.quote(amountUsd).amountWei`.

- `BasePaymentAdapter.quote()` devuelve `amountWei: '1000000'` (1 USDC, 6-dec) — `base/payment.ts:391`.
- `KiteOzonePaymentAdapter.quote()` devuelve `amountWei: '1000000000000000000'` (18-dec) — `kite-ozone/payment.ts:333`.

**Contrato de implementación**:
1. `buildX402Response` resuelve `amount` así:
   `amount = opts.amount ?? (await adapter.quote(DEFAULT_AMOUNT_USD)).amountWei`.
2. **Preservación de byte-compat (CD-1)**: para el path default (Kite), `quote()`
   devuelve exactamente `'1000000000000000000'` = el literal legacy. Por tanto el
   challenge Kite sin `opts.amount` es byte-idéntico al actual. **Verificar en
   W0/W1 con un test que el amount Kite default no cambia.**
3. `DEFAULT_AMOUNT_USD` = `1` (1 USD). Justificación: `quote(1)` en Base devuelve
   `'1000000'` (1 USDC) y en Kite devuelve `'1000000000000000000'` (el literal legacy
   actual, independiente del arg porque el quote actual de Kite es fijo). El valor del
   arg no afecta byte-compat de Kite (su `quote` ignora `_amountUsd`), y para Base da
   el monto correcto de 6-dec.
4. **Cambio de firma**: `buildX402Response` pasa de sync a `async` (porque `quote()`
   es async). Todos los call-sites dentro de `requirePayment` (`:124`, `:133-138`,
   `:155-160`, `:167-172`, `:186-192`, `:198-203`) deben `await buildX402Response(...)`.
   Esto es un cambio mecánico pero **amplio** (≈6 call-sites) — listar exhaustivamente
   en el Story File (F2.5).

> **Alternativa descartada**: un mapa estático `default amount por ChainKey` en
> x402.ts. Rechazada por CD-4 (no hardcodear decimales/montos de Base en x402.ts):
> el adapter es la única fuente dimensional autorizada. `quote()` ya encapsula eso.

> **Lección WKH-67 (auto-blindaje 072) aplicada**: "params shared across guards must
> have same unit/decimals". Acá el `amount` del challenge es dimensional (6-dec Base
> vs 18-dec Kite). PROHIBIDO reusar el literal `1e18` para Base. El amount SIEMPRE
> deriva del adapter de la chain del challenge (CD-DEC-01 heredada → CD-9).

### 4.4 Flujo principal (Happy Path Base Sepolia)

1. Cliente x402 puro hace `POST /compose` con `x-payment-chain: base-sepolia`, sin
   `x-a2a-key` ni `payment-signature`.
2. `requirePaymentOrA2AKey` no detecta a2a-key → `runX402Fallback` → handler de `requirePayment`.
3. `requirePayment`: guard wallet OK → `paymentOrigin='eoa'` → resuelve `chainKey='base-sepolia'`
   (header reconocido + bundle inicializado).
4. No hay `payment-signature` → `await buildX402Response(opts, resource, 'base-sepolia')`:
   `getPaymentAdapter('base-sepolia')` → challenge con `network=eip155:84532`,
   `asset=` USDC Base Sepolia, `maxAmountRequired='1000000'` (6-dec), `maxTimeoutSeconds=60`.
   Responde **402** (AC-1).
5. Cliente firma EIP-3009 contra el domain Base Sepolia (smoke `:296-326`) y reenvía
   con `payment-signature` + `x-payment-chain: base-sepolia`.
6. `requirePayment` resuelve `chainKey='base-sepolia'` (igual, CD-6/AC-5) → decodifica →
   `getPaymentAdapter('base-sepolia').verify(...)` → `getPaymentAdapter('base-sepolia').settle(...)`
   (facilitator Base, `network=eip155:84532`).
7. Settle OK → `request.paymentTxHash`, `request.paymentVerified=true`,
   header `payment-response: <txHash>` → **200** (AC-2).

### 4.5 Flujo de error

1. **Chain no reconocida** (`x-payment-chain: solana`): `resolveChainKey` → `undefined`,
   header presente → **400** `CHAIN_NOT_SUPPORTED` "Chain 'solana' is not a recognized
   slug or chainId" (AC-4, CD-5). No silent fallback.
2. **Chain reconocida pero no inicializada** (`x-payment-chain: avalanche-fuji` cuando
   `WASIAI_A2A_CHAINS` no la incluye): `getAdaptersBundle` → `undefined` → **400**
   `CHAIN_NOT_SUPPORTED` "Chain 'avalanche-fuji' is not initialized. Initialized:
   kite-ozone-testnet, base-sepolia" (AC-4, CD-5).
3. **Verify falla** (firma inválida / facilitator rechaza): `verifyResult.valid === false`
   → **402** con `buildX402Response(...)` (mensaje de error), igual al path actual.
4. **Settle falla**: `settleResult.success === false` → **402**, igual al path actual.
5. **Facilitator timeout/down**: catch → **402** "Facilitator unavailable", igual al actual.
6. **Registry no inicializado** (sin header, sin default): **500** `REGISTRY_NOT_INITIALIZED`
   (mismo shape que a2a-key.ts:209-214).

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (OBLIGATORIO)

- **CD-1** (cero regresión multi-chain): el path sin `x-payment-chain` DEBE permanecer
  byte-idéntico al actual (bundle default Kite, challenge `eip155:2368`, amount fallback
  `1e18`). Los 1039 tests existentes DEBEN seguir verdes. Cualquier diff observable en
  el path default es **BLOQUEANTE**.
- **CD-2** (solo viem, PROHIBIDO ethers.js): cualquier interacción onchain/firma usa
  viem v2. No introducir ethers.
- **CD-3** (TypeScript strict): PROHIBIDO `any` explícito y `as unknown`. El `chainKey`
  propagado DEBE tiparse como `ChainKey` (importado de `../adapters/types.js`), no `string`.
- **CD-4** (sin hardcodes de chain): PROHIBIDO hardcodear addresses, chainIds, network
  tags o decimales de Base en `x402.ts`. Todo viene del adapter seleccionado
  (`getNetwork()`/`getToken()`/`getMaxTimeoutSeconds()`/`quote()`) y del chain-resolver.
  El único literal tolerado por backward-compat es `DEFAULT_AMOUNT_USD = 1` (arg de quote,
  no un monto en wei).
- **CD-5** (fail-loud en chain no soportada): PROHIBIDO caer al default cuando el header
  está presente pero es desconocido/no inicializado. DEBE **400** `CHAIN_NOT_SUPPORTED`
  (consistente con `a2a-key.ts:200-223`). No silent fallback.
- **CD-6** (coherencia de chain en el flujo): challenge, verify y settle de un mismo
  request DEBEN usar el mismo `chainKey` resuelto. PROHIBIDO resolver la chain dos veces
  con fuentes distintas dentro del mismo flujo. La resolución ocurre UNA vez al inicio
  del handler de `requirePayment`.

### Nuevos del SDD (OBLIGATORIO)

- **CD-7** (resolución reutiliza el resolver puro): la resolución de `x-payment-chain`
  en `x402.ts` DEBE usar `resolveChainKey` de `chain-resolver.ts` (DT-4). PROHIBIDO
  inline una tabla de aliases o un `if (header === 'base-sepolia')`.
- **CD-8** (NO modificar `a2a-key.ts`): el wiring del fallback NO requiere tocar
  `a2a-key.ts` (§4.3). PROHIBIDO modificar `runX402Fallback` o el handler de
  `requirePaymentOrA2AKey`. Si el Dev cree que lo necesita → STOP y escalar.
- **CD-9** (amount dimensional por chain — hereda CD-DEC-01 de WKH-67/072): el
  `maxAmountRequired` del challenge DEBE derivar del adapter de la chain resuelta
  (`adapter.quote()`), NUNCA de un literal 18-dec compartido entre chains. PROHIBIDO
  reusar `'1000000000000000000'` para Base (sería 10^12 USDC). AR/CR DEBE grep que el
  literal `1e18` ya no aparece como fallback directo en `buildX402Response`.
- **CD-10** (orden de resolución antes del challenge): la resolución del `chainKey`
  DEBE ocurrir ANTES de la rama `if (!xPaymentHeader)` para que el challenge 402 también
  sea chain-aware. PROHIBIDO resolver solo en la rama verify/settle.
- **CD-11** (no leer `request.body`): el resolver lee SOLO `request.headers['x-payment-chain']`.
  PROHIBIDO leer `request.body` para inferir chain (consistente con CD-7 de a2a-key.ts).

### PROHIBIDO (resumen)

- NO agregar dependencias nuevas.
- NO modificar `src/adapters/registry.ts`, `chain-resolver.ts`, ni ningún adapter
  (`getPaymentAdapter(chainKey?)` ya soporta el arg).
- NO modificar `src/middleware/a2a-key.ts`.
- NO modificar `scripts/smoke-base-sepolia.mjs` (oráculo read-only).
- NO cambiar el comportamiento del path Kite default (CD-1).
- NO hardcodear chainIds/addresses/decimales/network tags de Base.
- NO usar `any`/`as unknown`.

## 6. Scope

**IN:**
- `src/middleware/x402.ts`: resolución de `x-payment-chain` en `requirePayment`,
  validación 400, propagación de `chainKey` a `buildX402Response`/`verify`/`settle`,
  challenge chain-aware (network/asset/decimales/amount), amount default derivado del adapter.
- `src/middleware/x402.chain-aware.test.ts` (nuevo): tests unitarios AC-1..AC-5.

**OUT:**
- Outbound downstream (`src/lib/downstream-payment.ts`) — HU separada (BASE-07).
- Base Mainnet (solo Base Sepolia validado).
- Modelo a2a-key / budget (`a2a-key.ts` no se toca).
- Multi-`accepts` (challenge anuncia UNA chain — DT-1).

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| `buildX402Response` pasa de sync→async rompe call-sites o tests legacy | M | A | Listar exhaustivamente los ~6 `await` en Story File; W0 corre baseline; W1 typecheck + suite completa. Tests legacy (`x402.passport-shape.test.ts`) ya usan `app.inject` async, deberían tolerar el cambio. Si algún test llama `buildX402Response` directo y sync → adaptarlo en el mismo PR (lección auto-blindaje 072 W4). |
| Regresión byte-compat del path Kite default (CD-1) | M | A | Test dedicado que afirma challenge Kite sin header = `{network:'eip155:2368', maxAmountRequired:'1000000000000000000'}`. `quote()` de Kite devuelve exactamente el literal legacy → byte-idéntico. AR/CR ataca este invariante. |
| `quote(DEFAULT_AMOUNT_USD)` introduce I/O o latencia inesperada | B | M | `quote()` de ambos adapters es síncrono-en-efecto (no hace fetch; devuelve constantes — `base:387-399`, `kite:330-337`). Verificado: no hay network call en `quote()`. |
| Mismatch `paymentPayload.network` vs header explotable | B | A | DT-3: header es fuente de verdad; el adapter ata la firma al domain/chainId de su chain → un network mentido produce `verify.valid=false` (fail seguro). Documentado como TD candidato si AR lo pide. |
| Doble resolución de chain (CD-6) | B | M | §4.3: cuando hay a2a-key, `requirePayment` no corre; cuando no, `a2a-key.ts` no resuelve chain en su rama. Una sola resolución por flujo. |
| Smoke falla por env: `WASIAI_A2A_CHAINS` sin `base-sepolia` en CI/test | M | M | §8/§9: documentar que el smoke requiere `WASIAI_A2A_CHAINS` incluyendo `base-sepolia`. NO bloqueante para unit tests (que mockean el registry). |

## 8. Dependencias

- `getPaymentAdapter(chainKey?)`, `getAdaptersBundle`, `getInitializedChainKeys`,
  `getDefaultChainKey` (registry.ts) — ya existen, no se modifican.
- `resolveChainKey` (chain-resolver.ts) — ya existe.
- `BasePaymentAdapter` con `getNetwork/getToken/getMaxTimeoutSeconds/quote` (base/payment.ts) — ya existe.
- **Runtime/smoke**: el gateway debe arrancar con `WASIAI_A2A_CHAINS` incluyendo
  `base-sepolia` (e.g. `kite-ozone-testnet,base-sepolia`) para que `getAdaptersBundle('base-sepolia')`
  resuelva. En prod ya está (per work-item). El smoke E2E (W3) requiere esto + facilitator
  Base alcanzable + fondos USDC en el operator wallet.

## 9. Missing Inputs (cerrados en este SDD)

- [x] **DT-3** (conciliación header vs payload.network): CERRADO en §4.3 — header es
  fuente de verdad; mismatch NO produce 400 en esta HU (el adapter ata la firma al domain
  → fail seguro). TD candidato si AR lo pide.
- [x] **DT-5** (default amount por chain): CERRADO en §4.3 — deriva de `adapter.quote()`,
  no de literal. `DEFAULT_AMOUNT_USD = 1`.
- [x] **Ownership de resolución** (rama sin a2a-key): CERRADO en §4.3 — `requirePayment`
  resuelve solo; `a2a-key.ts` NO se modifica (CD-8).
- [ ] **[NO bloqueante — operacional]** Confirmación de que `WASIAI_A2A_CHAINS` en el
  entorno de smoke/CI incluye `base-sepolia`. Documentado como requisito de env (§8).
  No bloquea los unit tests (mockean el registry). El smoke (W3) lo valida en runtime.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| TD-WKH-111-01 | 4.3 (DT-3) | 400 explícito por mismatch `paymentPayload.network` vs header. Hoy delegado al adapter (fail seguro). Re-evaluable si Adversary lo pide en AR. | No |

> Sin `[NEEDS CLARIFICATION]` pendientes. Todos los DT abiertos del work-item cerrados.

---

## Plan — Waves de Implementación

> Las waves de implementación las ejecuta el Dev en F3 desde el Story File (F2.5).
> Aquí se define el plan que el Story File detallará por archivo exacto.

### TBD Resueltos

| TBD | Sección SDD | Resolución |
|-----|-------------|------------|
| DT-3 conciliación header/payload.network | 4.3 | Header = fuente de verdad; sin 400 por mismatch (adapter fail-seguro). |
| DT-5 default amount por chain | 4.3 | `adapter.quote(1).amountWei` (6-dec Base, 18-dec Kite). |
| Quién resuelve la chain sin a2a-key | 4.3 | `requirePayment` resuelve solo; a2a-key.ts intacto. |

### Wave 0 (Serial Gate — prerequisitos)

- [ ] **W0.1**: `npm test` baseline — confirmar 1039 verdes ANTES de tocar nada
  (línea base de CD-1). Registrar el número exacto.
- [ ] **W0.2**: Confirmar que `base-sepolia` resuelve en el registry: test/REPL que
  con `WASIAI_A2A_CHAINS=kite-ozone-testnet,base-sepolia` + `initAdapters()`,
  `getAdaptersBundle('base-sepolia')` ≠ undefined y `getPaymentAdapter('base-sepolia').getNetwork() === 'eip155:84532'`.
- [ ] **W0.3**: `npx tsc --noEmit` (o `tsconfig.build.json`) baseline limpio.

### Wave 1 (Wiring de resolución + propagación)

- [ ] **W1.1**: En `x402.ts`, importar `ChainKey` (de `../adapters/types.js`),
  `resolveChainKey` (de `../adapters/chain-resolver.js`), `getAdaptersBundle`,
  `getInitializedChainKeys`, `getDefaultChainKey` (de `../adapters/registry.js`).
  → Exemplar: imports de `a2a-key.ts:14-19`.
- [ ] **W1.2**: `buildX402Response` acepta `chainKey: ChainKey` (nuevo 3er param,
  re-ordenar `errorMessage` a 4to) → `getPaymentAdapter(chainKey)`. Convertir a `async`.
  Amount default: `opts.amount ?? (await adapter.quote(1)).amountWei` (DT-5/CD-9).
- [ ] **W1.3**: `verify`/`settle` usan `getPaymentAdapter(chainKey)` (`x402.ts:142`/`:175`).
- [ ] **W1.4**: `requirePayment` resuelve el `chainKey` una vez (ANTES de leer
  `payment-signature`, CD-10), aplica el 400 `CHAIN_NOT_SUPPORTED` (DT-3/CD-5),
  y `await`-ea todos los `buildX402Response(...)` con el `chainKey`. → Exemplar:
  `a2a-key.ts:188-224`.
- [ ] **W1.5**: Tests unitarios `x402.chain-aware.test.ts` (AC-1..AC-5) — ver Test Plan.
- [ ] **W1.6 (verif)**: `npx tsc --noEmit` + `npm test` — suite completa verde (CD-1).

### Wave 2 (Validación E2E)

- [ ] **W2.1**: Correr `scripts/smoke-base-sepolia.mjs` contra un gateway con
  `WASIAI_A2A_CHAINS=...,base-sepolia` + facilitator Base + operator con fondos USDC.
  Evidencia: HTTP 402 con `network=eip155:84532` + HTTP 200 con tx hash en Basescan
  (AC-1/AC-2). NO se modifica el script.
- [ ] **W2.2**: Confirmar 1039 (+ nuevos) tests verdes, cero regresión Kite (AC-3).

### Dependencias

| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.* | W0.1, W0.2, W0.3 | Necesita baseline y confirmación de que `base-sepolia` resuelve. |
| W2.1 | W1.* | El smoke ejercita el código nuevo end-to-end. |

### Archivos involucrados

| Archivo | Existe | Acción | Wave | Exemplar |
|---------|--------|--------|------|----------|
| `src/middleware/x402.ts` | Sí | Modificar | W1.1-W1.4 | `a2a-key.ts:188-224` |
| `src/middleware/x402.chain-aware.test.ts` | No | Crear | W1.5 | `x402.passport-shape.test.ts` |
| `scripts/smoke-base-sepolia.mjs` | Sí | NO modificar (oráculo) | W2.1 | — |

## Test Plan

> Framework: vitest. Estrategia: `vi.mock('../adapters/registry.js')` con un mapa
> de adapters mockeados por chainKey (Base mock 6-dec + Kite mock 18-dec) + Fastify
> in-memory `app.inject`. NO se mockea viem ni el facilitator real en unit tests —
> los adapters mockeados devuelven `verify/settle` deterministas. El smoke E2E (W2.1)
> ejercita el facilitator + viem reales.

| Test | AC que cubre | Wave | Qué prueba / qué se mockea |
|------|-------------|------|----------------------------|
| **T-AC1**: challenge Base 6-dec | AC-1 | W1.5 | Mock `getPaymentAdapter('base-sepolia')` → `getNetwork='eip155:84532'`, `getToken='0x036C…F7e'`, `quote→'1000000'`. Request con `x-payment-chain: base-sepolia`, sin payment-signature. Afirma 402 + `accepts[0].network==='eip155:84532'` + `asset` USDC Base + `maxAmountRequired==='1000000'` (6-dec). |
| **T-AC2**: verify+settle ruteado a Base | AC-2 | W1.5 | Mock Base adapter `verify→{valid:true}`, `settle→{txHash:'0x…',success:true}`. Request con `payment-signature` válido + `x-payment-chain: base-sepolia`. Afirma 200 + header `payment-response===txHash` + que `mockGetPaymentAdapter` se invocó con `'base-sepolia'` (no default). |
| **T-AC3a**: cero regresión challenge Kite | AC-3 | W1.5 | Sin `x-payment-chain`. Mock default (Kite) `getNetwork='eip155:2368'`, `quote→'1000000000000000000'`. Afirma 402 + `network==='eip155:2368'` + `maxAmountRequired==='1000000000000000000'` (18-dec, byte-idéntico). |
| **T-AC3b**: cero regresión verify+settle Kite | AC-3 | W1.5 | Sin header, payment-signature válido. Afirma 200 + que el adapter resuelto fue el default (`getPaymentAdapter()` sin arg / con default). |
| **T-AC4a**: 400 chain no reconocida | AC-4/CD-5 | W1.5 | `x-payment-chain: solana`. Afirma 400 + `error_code:'CHAIN_NOT_SUPPORTED'` + mensaje "not a recognized slug or chainId". |
| **T-AC4b**: 400 chain reconocida no inicializada | AC-4/CD-5 | W1.5 | `x-payment-chain: avalanche-fuji` con registry mock que solo tiene kite+base. Afirma 400 + `error_code:'CHAIN_NOT_SUPPORTED'` + "Initialized: …". |
| **T-AC5**: coherencia mismo chainKey challenge↔verify↔settle | AC-5/CD-6 | W1.5 | `x-payment-chain: base-sepolia` + payment-signature. Afirma que `getPaymentAdapter` fue invocado SIEMPRE con `'base-sepolia'` en challenge (si aplica), verify y settle — nunca con un chainKey distinto. |
| **T-CD9**: amount default Base ≠ literal 18-dec | CD-9 | W1.5 | Reafirma T-AC1: con Base y sin `opts.amount`, `maxAmountRequired==='1000000'` (NO `'1000000000000000000'`). Guard contra el bug dimensional (auto-blindaje 072). |
| **T-OPTS-AMOUNT**: `opts.amount` override respeta el override | AC-1/CD-1 | W1.5 | Con `opts.amount` provisto, el challenge usa ese valor (no el quote), en ambas chains. |
| **smoke-base-sepolia.mjs** (E2E) | AC-1/AC-2 | W2.1 | Oráculo real: facilitator Base + viem + USDC onchain. tx hash en Basescan. |

> Cobertura: AC-1 (T-AC1, T-CD9), AC-2 (T-AC2), AC-3 (T-AC3a, T-AC3b), AC-4 (T-AC4a,
> T-AC4b), AC-5 (T-AC5). ≥1 test por AC + tests de guarda dimensional y override. Total
> unit: 9 tests + 1 smoke E2E.

## Verificación Incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | baseline `npm test` (1039 verde) + tsc limpio + `base-sepolia` resuelve |
| W1 | tsc `--noEmit` + `npm test` suite completa verde (incl. nuevos) |
| W2 | smoke E2E verde (tx hash Basescan) + full suite verde |

## Estimación

- Archivos modificados: 1 (`x402.ts`)
- Archivos nuevos: 1 (`x402.chain-aware.test.ts`)
- Tests nuevos: 9 unit + 1 smoke E2E (existente, read-only)
- Líneas estimadas: ~40-60 prod (x402.ts) + ~250 test

---

## Readiness Check (Architect — ejecutado antes de SPEC_APPROVED)

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado en tabla 4.1 (x402.ts + x402.chain-aware.test.ts)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read (a2a-key.ts:188-224, x402.passport-shape.test.ts)
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-3, DT-5, ownership cerrados; 1 TD no bloqueante)
[x] Constraint Directives ≥3 PROHIBIDO (CD-1..CD-11 + sección PROHIBIDO)
[x] Context Map ≥2 archivos leídos (9 archivos, líneas reales verificadas)
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: N/A (no aplica) — declarado
[x] Happy Path completo (§4.4)
[x] Flujo de error definido — 6 casos (§4.5)
[x] Cada AC tiene ≥1 test en Test Plan
[x] DTs abiertos del work-item cerrados (DT-3, DT-5, ownership)
[x] Auto-Blindaje histórico revisado: CD-9 hereda CD-DEC-01 (WKH-67/072); §3 exemplar de test
    aplica patrón mock-registry (WKH-69/x402.passport-shape); riesgo async-refactor aplica
    lección ripple WKH-67/072 W4
```

Todos los checks pasan. SDD listo para presentar al humano en GATE 2 (SPEC_APPROVED).

---

*SDD generado por NexusAgil — FULL — WKH-111 (BASE-06)*
