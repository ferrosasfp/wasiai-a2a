# Work Item — [WKH-111] [BASE-06] x402 payment path chain-aware

> Hija del epic WKH-103 "BASE port". Cierra el gap de ejecución de pago que
> dejó abierto el port WKH-104..108: el ADAPTER Base + el chain-resolver existen
> y están inicializados en prod, pero los **paths de ejecución x402** (challenge,
> verify, settle) nunca se hicieron chain-aware, así que **ningún settle onchain
> rutea a Base**.

## Resumen

Hacer chain-aware el path x402 inbound del gateway. Hoy `buildX402Response`,
`verify` y `settle` (`src/middleware/x402.ts`) llaman `getPaymentAdapter()` SIN
`chainKey`, por lo que siempre resuelven el bundle DEFAULT (Kite, eip155:2368,
18 decimales). El header `x-payment-chain: base-sepolia` se ignora en la rama
sin a2a-key. Resultado: el smoke `scripts/smoke-base-sepolia.mjs` falla porque
el challenge 402 anuncia Kite en vez de Base. Esta HU rutea challenge/verify/settle
al adapter de la chain pedida, manteniendo CERO regresión para el path Kite default.

**Para quién**: clientes x402 puros (sin a2a-key) que pagan con USDC en Base
Sepolia vía `/compose`/`/orchestrate`. **Por qué**: desbloquear el settle onchain
en Base, que es el entregable visible del epic BASE port.

## Sizing

- **SDD_MODE**: full (QUALITY)
- **Estimación**: M
- **Branch sugerido**: `feat/093-wkh-111-x402-chain-aware`
- **Metodología**: QUALITY — NO bajar a FAST.

### Justificación del sizing (Smart Sizing → QUALITY)

Señales de complejidad que fuerzan QUALITY:

1. **Superficie crítica de pagos onchain**: toca el path de verify/settle de
   dinero real (USDC). Un bug acá = pérdida de fondos o cross-chain confusion.
2. **Riesgo de regresión multi-tenant/multi-chain**: 1039 tests verdes hoy; el
   path Kite default NO puede cambiar de comportamiento (byte-identical).
3. **Decisión de diseño no trivial**: single-`accepts` con la chain pedida vs.
   múltiples `accepts` (multi-chain advertise). Requiere SDD + adversarial.
4. **Toca convención de seguridad** (Golden Path payments): EARS + Constraint
   Directives obligatorios; AR/CR deben atacar el path de selección de chain.

No es FAST (no es un patch aislado) ni LAUNCH (no es feature greenfield): es un
**evolutivo sobre superficie crítica**, que es exactamente el caso QUALITY.

## F0 — Hallazgos de grounding (verificados archivo:línea, 2026-05-27)

| # | Hallazgo | Evidencia |
|---|----------|-----------|
| H1 | `buildX402Response` (el challenge) llama `getPaymentAdapter()` sin chainKey → bundle DEFAULT (Kite). Además usa fallback `amount = '1000000000000000000'` (1e18, 18-dec Kite). | `src/middleware/x402.ts:49`, `:52` |
| H2 | `verify` llama `getPaymentAdapter()` sin chainKey, ignora `paymentPayload.network`. | `src/middleware/x402.ts:142` |
| H3 | `settle` llama `getPaymentAdapter()` sin chainKey, ignora `paymentPayload.network`. | `src/middleware/x402.ts:175` |
| H4 | `requirePayment(opts)` no lee `x-payment-chain`. `PaymentMiddlewareOptions` solo tiene `description`/`amount`. No hay resolución de chain en esta función. | `src/middleware/x402.ts:39-42`, `:96-209` |
| H5 | Rama SIN a2a-key delega a `runX402Fallback` (path Kite-only). La resolución de chain (step 6) y el bundle viven SOLO en la rama CON a2a-key, y ahí hace **budget debit**, no settle onchain. | `src/middleware/a2a-key.ts:119-123`, `:188-235` |
| H6 | `getPaymentAdapter(chainKey?: ChainKey)` YA acepta el arg opcional y resuelve el bundle correcto vía `resolveBundleOrThrow`. El gap es 100% del lado de x402.ts (no pasa el arg). | `src/adapters/registry.ts:172-174`, `:159-170` |
| H7 | `resolveChainKey({headerOverride})` es una función pura que ya mapea `base-sepolia`/`84532`/`base-testnet` → `'base-sepolia'` y devuelve `undefined` para slug desconocido (semántica 400). | `src/adapters/chain-resolver.ts:61-88` |
| H8 | El adapter Base ya expone `getNetwork()` → `eip155:84532`, `getToken()` → USDC Base, `supportedTokens[0].decimals = 6`, `getMaxTimeoutSeconds()` → 60. Listo para ser seleccionado. | `src/adapters/base/payment.ts:349-377` |
| H9 | `getInitializedChainKeys()` / `getAdaptersBundle(chainKey)` / `getDefaultChainKey()` ya existen para distinguir "no inicializada" de error y armar el mensaje 400. | `src/adapters/registry.ts:213-236` |
| H10 | Outbound downstream (`signAndSettleDownstream`) está hardcodeado a fuji/avalanche-mainnet y hace `if (agent.payment.chain !== 'avalanche') return null` → Base NUNCA settlea outbound. | `src/lib/downstream-payment.ts:38`, `:57-58`, `:113`, `:457-467` |
| H11 | El smoke ya envía `x-payment-chain: base-sepolia` en el probe 402 y en el pago, y lee `accepts[0]` (network/payTo/maxAmountRequired) + tx hash. Es el oráculo E2E de esta HU. | `scripts/smoke-base-sepolia.mjs:216`, `:239-257`, `:360` |
| H12 | `/compose` cablea `requirePaymentOrA2AKey(...)` (que envuelve `requirePayment`). El fix en x402.ts cubre /compose y cualquier ruta que use el mismo middleware. | `src/routes/compose.ts:7`, `:1-13` |

**Conclusión F0**: el gap está confirmado y es exactamente el descrito en el input.
La pieza pura (chain-resolver) y el accessor (`getPaymentAdapter(chainKey)`) ya
existen; falta cablear la resolución del header dentro del flujo `requirePayment`
y pasar el `chainKey` a las 3 llamadas. NO es un rewrite — es wiring + el
challenge debe reflejar la chain (network/asset/decimales) en vez del default Kite.

## Acceptance Criteria (EARS)

- **AC-1** (Event-driven — challenge chain-aware): WHEN un request a `/compose`
  trae `x-payment-chain: base-sepolia` sin `x-a2a-key` ni `payment-signature`,
  THEN the system SHALL responder 402 con `accepts[0].network = eip155:84532`,
  `accepts[0].asset = ` la dirección USDC de Base Sepolia, y
  `accepts[0].maxAmountRequired` expresado en 6 decimales (NO el default 1e18 de Kite).

- **AC-2** (Event-driven — verify+settle ruteado a Base): WHEN se reenvía un
  `payment-signature` EIP-3009 válido con `x-payment-chain: base-sepolia`, THEN
  the system SHALL ejecutar `verify` y `settle` contra el adapter de Base (facilitator
  `/verify`+`/settle` con `network = eip155:84532`) y, ante settle exitoso, retornar
  HTTP 200 con `payment-response` conteniendo el tx hash verificable en Basescan.

- **AC-3** (Ubiquitous — CERO regresión Kite default): WHEN un request NO envía
  `x-payment-chain`, THEN the system SHALL comportarse byte-idéntico al path actual
  (bundle default = Kite, challenge eip155:2368, fallback amount 1e18) y los 1039
  tests existentes SHALL permanecer verdes.

- **AC-4** (Unwanted — chain no inicializada): IF `x-payment-chain` trae un slug/chainId
  que NO está inicializado en el registry (o no reconocido), THEN the system SHALL
  retornar HTTP 400 con `error_code: CHAIN_NOT_SUPPORTED` y un mensaje que incluya
  la lista de chains inicializadas (vía `getInitializedChainKeys()`), sin caer
  silenciosamente al default. (Reusa la semántica ya implementada en a2a-key.ts:200-223.)

- **AC-5** (State-driven — coherencia del settle con el challenge): WHILE el request
  declara una chain via header, the system SHALL usar el MISMO `chainKey` resuelto
  para el challenge, el `verify` y el `settle` (no mezclar el `network` del payload
  del cliente con un bundle distinto al anunciado). [Decisión de cómo conciliar
  `paymentPayload.network` vs `x-payment-chain` → DT-3, a refinar en F2.]

## Scope IN

- `src/middleware/x402.ts` — núcleo del cambio:
  - `buildX402Response`: aceptar y usar el `chainKey` resuelto → `getPaymentAdapter(chainKey)`;
    el `amount` fallback y `network`/`asset`/decimales deben reflejar la chain.
  - `verify` (línea ~142): `getPaymentAdapter(chainKey).verify(...)`.
  - `settle` (línea ~175): `getPaymentAdapter(chainKey).settle(...)`.
  - `requirePayment`: resolver `x-payment-chain` vía `resolveChainKey` + validación
    400 `CHAIN_NOT_SUPPORTED`, y propagar el `chainKey` a las 3 llamadas anteriores.
- `src/middleware/a2a-key.ts` — SOLO si el wiring del fallback x402 requiere pasar
  el chainKey ya resuelto (evaluar en F2; idealmente x402.ts resuelve solo para
  no duplicar lógica). [TBD F2: quién resuelve la chain en la rama sin a2a-key.]
- `src/middleware/x402.test.ts` (nuevo o extendido) + `src/middleware/a2a-key.test.ts`
  — tests unitarios de selección de chain (Base vs default Kite) y del 400.
- `scripts/smoke-base-sepolia.mjs` — NO se modifica (es el oráculo E2E read-only);
  pasa a verde como evidencia de AC-1/AC-2.

## Scope OUT

- **Outbound downstream** (`src/lib/downstream-payment.ts`) — NO entra. El settle
  inbound (gateway como service provider) es lo que desbloquea el smoke. El outbound
  Base (gateway→agentes en Base) se **difiere a otra HU** (candidata BASE-07).
  Justificación: H10 muestra que es un cambio independiente (otro hardcode, otro
  test surface) y el smoke actual no lo ejercita. [DT-2]
- **Base Mainnet** — solo Base Sepolia (testnet). `base-mainnet` queda fuera del
  alcance de validación de esta HU (aunque el adapter ya exista).
- **Modelo a2a-key / budget** — NO se toca la lógica de debit ni el budget service.
  La rama CON a2a-key ya es chain-aware para el debit (a2a-key.ts:188-235); esta HU
  NO altera ese comportamiento.
- **Multi-`accepts` (advertise multi-chain en un solo challenge)** — fuera de scope;
  el challenge anuncia UNA chain (la pedida o el default). [ver DT-1]

## Decisiones técnicas (DT-N)

- **DT-1** — *Challenge single-chain, no multi-`accepts`*: el 402 anuncia UN solo
  `accepts[0]` con la chain resuelta (header o default). NO emitimos múltiples
  `accepts` con todas las chains inicializadas. Justificación: minimiza superficie,
  mantiene byte-compat con el shape actual (el smoke lee `accepts[0]`), y multi-chain
  advertise no es requerido por ningún AC. (Reevaluable en F2 si Adversary lo pide.)
- **DT-2** — *Outbound diferido*: el fix se limita al path inbound (verify/settle como
  service provider). Outbound Base = HU separada. Reduce scope y riesgo.
- **DT-3** — *Conciliación `x-payment-chain` vs `paymentPayload.network`* [a cerrar en F2]:
  candidata = `x-payment-chain` es la fuente de verdad para seleccionar el bundle;
  el `network` del payload del cliente se valida (debe coincidir con el bundle) o se
  ignora. Decisión final y manejo de mismatch (¿400? ¿tolerar?) → Architect en F2.
- **DT-4** — *Reutilizar el chain-resolver puro*: la resolución usa `resolveChainKey`
  (chain-resolver.ts), idéntico a la rama a2a-key, para no duplicar la tabla de aliases.
- **DT-5** — *El amount fallback deja de ser hardcode 1e18*: cuando la chain es Base
  (USDC 6-dec), el `maxAmountRequired` debe expresarse en 6 decimales. La fuente del
  default amount por chain se define en F2 (candidata: derivar de `adapter.quote()` o
  de un default por-chain). [TBD F2]

## Constraint Directives (CD-N)

- **CD-1** (OBLIGATORIO — cero regresión multi-chain): el path sin `x-payment-chain`
  DEBE permanecer byte-idéntico al actual (bundle default Kite, challenge eip155:2368,
  amount fallback 1e18). Los 1039 tests existentes DEBEN seguir verdes. Cualquier
  diff observable en el path default es BLOQUEANTE.
- **CD-2** (OBLIGATORIO — solo viem, PROHIBIDO ethers.js): cualquier interacción
  onchain/firma usa viem v2. No introducir ethers.
- **CD-3** (OBLIGATORIO — TypeScript strict): PROHIBIDO `any` explícito y `as unknown`.
  El `chainKey` propagado debe tiparse como `ChainKey` (no `string`).
- **CD-4** (OBLIGATORIO — sin hardcodes de chain): PROHIBIDO hardcodear addresses,
  chainIds, network tags o decimales de Base en x402.ts. Todo viene del adapter
  seleccionado (`getNetwork()`/`getToken()`/`supportedTokens[].decimals`) y del
  chain-resolver. El único literal tolerado es el default amount legacy (CD-1).
- **CD-5** (OBLIGATORIO — fail-loud en chain no soportada): PROHIBIDO caer al default
  cuando el header está presente pero es desconocido/no inicializado. DEBE 400
  `CHAIN_NOT_SUPPORTED` (consistente con a2a-key.ts:200-223). No silent fallback.
- **CD-6** (OBLIGATORIO — coherencia de chain en el flujo): challenge, verify y settle
  de un mismo request DEBEN usar el mismo `chainKey` resuelto. PROHIBIDO resolver la
  chain dos veces con fuentes distintas dentro del mismo flujo.

## Análisis de paralelismo / waves

- **¿Bloquea otras HU?** Sí: desbloquea el smoke Base Sepolia (WKH-107 ya DONE pero
  rojo en runtime) y es prerequisito para declarar el epic BASE port "settle onchain
  probado". La eventual BASE-07 (outbound Base) depende conceptualmente de esta pero
  NO comparte archivos (downstream-payment.ts vs x402.ts) → podrían ir en paralelo.
- **¿Puede ir en paralelo con otra WKH?** El cambio se concentra en `x402.ts`
  (+ posible toque mínimo en `a2a-key.ts` y tests). No colisiona con el modelo
  a2a-key/budget. Cualquier HU que NO toque `src/middleware/x402.ts` puede correr
  en paralelo.
- **Waves sugeridas (orientativo para Architect, no vinculante)**:
  - W1: resolver `x-payment-chain` en `requirePayment` + propagar `chainKey` a
    `buildX402Response`/`verify`/`settle` + 400 CHAIN_NOT_SUPPORTED. Tests unitarios.
  - W2: challenge chain-aware real (network/asset/decimales/amount por chain) +
    cierre de DT-3 (conciliación con `paymentPayload.network`) + DT-5 (default amount).
  - W3: validación E2E con `smoke-base-sepolia.mjs` (evidencia tx hash Basescan) +
    suite completa 1039 tests verde.

## Missing Inputs

- **[resuelto en F2]** DT-3: política exacta de conciliación entre `x-payment-chain`
  y `paymentPayload.network` (¿mismatch = 400 o se ignora el del payload?).
- **[resuelto en F2]** DT-5: de dónde sale el `maxAmountRequired`/amount por chain
  cuando no viene `opts.amount` (¿`adapter.quote()`? ¿default por-chain?).
- **[resuelto en F2]** Quién resuelve la chain en la rama SIN a2a-key: ¿`requirePayment`
  lo hace solo (preferido, no duplica) o `a2a-key.ts` se lo pasa? Decisión de Architect.
- **[NO bloqueante]** Confirmación operacional de que `WASIAI_A2A_CHAINS` en el entorno
  de test/CI incluye `base-sepolia` para que el smoke pueda resolver el bundle
  (en prod ya está, per input). El SDD debe documentar el requisito de env para el smoke.
