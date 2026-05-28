# Work Item — [WKH-112] [BASE-07] outbound downstream payment chain-aware

> Hija del epic WKH-103 "BASE port". Hermana de WKH-111 (BASE-06, DONE).
> WKH-111 hizo chain-aware el path x402 **INBOUND** (el gateway COBRA en
> Kite/Avalanche/Base). Esta HU cierra el gap espejo del path **OUTBOUND**:
> cuando el gateway PAGA a los sub-agentes downstream durante `/compose` y
> `/orchestrate`, hoy está hardcodeado a Avalanche y NO puede liquidar a un
> agente que cobra en Base o Kite.

## Resumen

Hacer chain-aware el settle OUTBOUND en `src/lib/downstream-payment.ts`. Hoy ese
módulo reimplementa inline el flujo sign(EIP-3009)→verify→settle contra una única
chain (fuji / avalanche-mainnet, seleccionada por env `WASIAI_DOWNSTREAM_NETWORK`)
y trae un guard duro `if (agent.payment.chain !== 'avalanche') return null`
(`downstream-payment.ts:457-467`) que saltea el settle downstream para cualquier
chain ≠ avalanche. Resultado: el gateway no liquida a agentes que cobran en
Base (`base-sepolia`) ni en Kite (`kite-ozone-testnet`).

La HU resuelve el `ChainKey` del agente destino desde `agent.payment.chain`
(vía el resolver puro `normalizeChainSlug`/`resolveChainKey`) y rutea
sign+verify+settle al adapter+facilitator de esa chain reutilizando
`getPaymentAdapter(chainKey).sign(...)` / `.verify(...)` / `.settle(...)`
— **NO se reimplementa la firma**. Reemplaza el guard `!== 'avalanche'` por una
resolución multi-chain con fail-loud cuando la chain no está inicializada.

**Para quién**: el gateway WasiAI A2A actuando como pagador (operator wallet)
hacia sub-agentes que cobran en distintas chains durante composición/orquestación.
**Por qué**: completar el epic BASE port end-to-end — sin esto, el gateway COBRA
en 3 chains pero solo PAGA en 1, dejando el path outbound multi-chain incompleto
(gap reportado en `doc/sdd/_validation/2026-05-27-multichain-deep-validation.md`
Capa G, hallazgo #1).

## Sizing

- **SDD_MODE**: full (QUALITY)
- **Estimación**: M
- **Branch sugerido**: `feat/094-wkh-112-downstream-chain-aware`
- **Metodología**: QUALITY — NO bajar a FAST.
- **Skills de dominio (máx 2)**: `x402-eip3009-payments`, `multi-chain-adapter-routing`.

### Justificación del sizing (Smart Sizing → QUALITY)

Señales de complejidad que fuerzan QUALITY:

1. **Path de dinero real onchain (outbound)**: el gateway firma con el OPERATOR
   wallet y settlea USDC/PYUSD a terceros. Un bug acá = fondos del operator
   enviados a la chain equivocada, cross-chain confusion, o pago doble.
2. **Riesgo de regresión crítica**: 1048 tests verdes hoy (`Test Files 72
   passed`, validación 2026-05-27 Capa A). El path Avalanche (default productivo,
   único outbound funcional) NO puede cambiar de comportamiento — debe quedar
   byte-idéntico (CD-1).
3. **Decisión de diseño no trivial**: el módulo hoy reimplementa sign/verify/settle
   inline; migrar a `getPaymentAdapter(chainKey)` cambia la fuente de la firma y
   del facilitator. Hay que decidir qué se reusa del adapter vs. qué se conserva
   (pre-flight balance check, NEVER-throws contract, skip-codes). Requiere SDD +
   adversarial.
4. **Toca convención de seguridad** (Golden Path payments + Ownership Guard si
   se cruza con budget): EARS + Constraint Directives obligatorios; AR/CR deben
   atacar la selección de chain y el fail-loud.

No es FAST (no es patch aislado) ni LAUNCH (no es greenfield): es un **evolutivo
sobre superficie crítica de pagos**, caso QUALITY canónico — idéntico criterio
que WKH-111.

## F0 — Hallazgos de grounding (verificados archivo:línea, 2026-05-27)

| # | Hallazgo | Evidencia |
|---|----------|-----------|
| H1 | El módulo importa SOLO chains avalanche: `import { avalanche, avalancheFuji } from 'viem/chains'`. No hay Base ni Kite. | `src/lib/downstream-payment.ts:19` |
| H2 | `type DownstreamNetwork = 'fuji' \| 'avalanche-mainnet'` y `getDownstreamNetwork()` devuelve solo esas dos (seleccionadas por `WASIAI_DOWNSTREAM_NETWORK`). No hay rama Base/Kite. | `src/lib/downstream-payment.ts:38`, `:40-44` |
| H3 | USDC + network tags hardcodeados a Fuji/Avax: `DEFAULT_FUJI_USDC`, `DEFAULT_AVALANCHE_USDC`, `FUJI_NETWORK='eip155:43113'`, `AVALANCHE_NETWORK='eip155:43114'`. El tipo `X402CanonicalBody.accepted.network` solo admite esas dos. | `src/lib/downstream-payment.ts:49-58`, `:113` |
| H4 | **Guard bloqueante**: `if (agent.payment.chain !== 'avalanche') return null` (skip-code `CHAIN_NOT_SUPPORTED`). Base/Kite NUNCA settlean outbound. | `src/lib/downstream-payment.ts:457-467` |
| H5 | `buildClients()` cablea wallet/public clients SOLO con `avalanche`/`avalancheFuji` y `FUJI_RPC_URL`/`AVALANCHE_RPC_URL`. | `src/lib/downstream-payment.ts:255-305` |
| H6 | La firma EIP-3009 se reimplementa inline: `signTypedData` con domain `{name:'USD Coin', version:'2', chainId, verifyingContract: usdcAddress}`. | `src/lib/downstream-payment.ts:564-591` (`USDC_EIP712_NAME='USD Coin'` :62) |
| H7 | `postFacilitator` POSTea a `WASIAI_FACILITATOR_URL` (default railway) `/verify`+`/settle` con el body canónico inline. | `src/lib/downstream-payment.ts:187-192`, `:356-390` |
| H8 | **Único consumidor**: `composeService.invokeAgent` llama `signAndSettleDownstream(agent, effectiveLogger)`. `/orchestrate` rutea a través de `composeService` (no llama el downstream directo). | `src/services/compose.ts:459` (firma export `signAndSettleDownstream` en `downstream-payment.ts:425-428`) |
| H9 | **El primitivo chain-aware YA existe**: `PaymentAdapter.sign({to, value, timeoutSeconds})` firma EIP-3009 `from=operator → to=payTo` contra el token/chain del adapter, y `.settle({authorization, signature, network})` POSTea al facilitator. Base lo implementa idéntico al inline downstream. | `src/adapters/types.ts:35-43`, `:78-91`; `src/adapters/base/payment.ts:401-452`, `:383-385` |
| H10 | `getPaymentAdapter(chainKey?)` resuelve el bundle correcto por chain; `getAdaptersBundle(chainKey)`/`getInitializedChainKeys()`/`getDefaultChainKey()` permiten distinguir "no inicializada" de error (mismo patrón fail-loud de a2a-key/x402). | `src/adapters/registry.ts:172-174`, `:213-236` |
| H11 | `resolveChainKey({agentManifestChain})` / `normalizeChainSlug` mapean `avalanche`/`fuji`/`base-sepolia`/`kite-ozone-testnet`/chainIds → `ChainKey`, devuelven `undefined` para slug desconocido (semántica fail-loud). | `src/adapters/chain-resolver.ts:20-66`, `:77-88` |
| H12 | `agent.payment.chain` es un `string` raw pass-through (NO normalizado): el wasiai-v2/kite registry puede traer `'avalanche'`, `'base-sepolia'`, etc. Hay que normalizarlo con el resolver. | `src/types/index.ts:89-94` (`AgentPaymentSpec`) |
| H13 | `signAndSettleDownstream` **NEVER throws** (CD-NEW-SDD-6 de WKH-55): devuelve `null` en cualquier skip/fallo y el caller (compose) loguea y continúa. Esta semántica afecta el manejo de "chain no soportada". | `src/lib/downstream-payment.ts:4-5`, `:405-424` |
| H14 | `StepResult` ya expone `downstreamTxHash`/`downstreamBlockNumber`/`downstreamSettledAmount` (agnósticos de chain) — el shape de salida NO necesita cambiar para soportar más chains. | `src/types/index.ts:229-234`; `src/services/compose.ts:195-199` |
| H15 | Operator wallet `0xf432baf1…9eD` ya tiene settle onchain real probado en las 3 chains (Base `0x89329e5a` 0x1, Avax `0x93149974` 0x1, Kite `0xb861b69b` 0x1) — infra outbound funded y facilitator multi-chain CLOSED (`/supported` = 4 networks). | `doc/sdd/_validation/2026-05-27-multichain-deep-validation.md` Capa E/F |

**Conclusión F0**: el gap está confirmado exactamente como lo describe el input.
La pieza clave (firma EIP-3009 chain-aware + selección de facilitator por chain)
**ya existe** en `PaymentAdapter.sign/verify/settle` + `getPaymentAdapter(chainKey)`
y es la MISMA maquinaria que usa el inbound (WKH-111). El downstream-payment.ts es
un módulo legacy que reimplementa todo inline para una sola chain. El trabajo es:
(1) resolver el `ChainKey` del agente destino, (2) rutear sign+verify+settle al
adapter de esa chain, (3) reemplazar el guard `!== 'avalanche'` por resolución
multi-chain con fail-loud, (4) preservar el contrato NEVER-throws y los skip-codes,
(5) CERO regresión Avalanche. El único consumidor es `compose.invokeAgent`;
`/orchestrate` queda cubierto transitivamente. **No es greenfield: es refactor +
wiring sobre primitivo existente.**

## Acceptance Criteria (EARS)

- **AC-1** (Event-driven — settle outbound en Base): WHEN `/compose` (o
  `/orchestrate` vía compose) paga a un sub-agente cuyo `agent.payment.chain`
  resuelve a `base-sepolia`, THEN the system SHALL firmar la autorización EIP-3009
  con el OPERATOR wallet vía el adapter de Base y settlear vía el facilitator de
  Base (`network = eip155:84532`), retornando un `DownstreamResult` con `txHash`
  verificable en Basescan (sepolia.basescan.org) y `settledAmount` en 6 decimales.

- **AC-2** (Ubiquitous — CERO regresión Avalanche): WHEN el sub-agente cobra en
  `avalanche-fuji` (o `avalanche`), THEN the system SHALL comportarse
  funcionalmente idéntico al path actual (mismo facilitator, mismo USDC Fuji,
  mismo `eip155:43113`, mismos skip-codes y contrato NEVER-throws) y los 1048
  tests existentes SHALL permanecer verdes. Cualquier diff observable en el path
  Avalanche es BLOQUEANTE.

- **AC-3** (Event-driven — settle outbound en Kite): WHEN el sub-agente cobra en
  `kite-ozone-testnet`, THEN the system SHALL firmar+settlear el pago downstream
  vía el adapter de Kite (`network = eip155:2368`, PYUSD), retornando un
  `DownstreamResult` con el `txHash` correspondiente — sin enviar a Avalanche.
  [TBD F2: confirmar que el modo del adapter Kite usado para el sign downstream
  es el canonical x402 contra el token directo, coherente con el settle inbound
  `0xb861b69b` probado — ver `2026-05-27-multichain-deep-validation.md` Capa B.]

- **AC-4** (Unwanted — chain no soportada/no inicializada → fail-loud, no silent
  cross-chain): IF `agent.payment.chain` resuelve a un `ChainKey` que NO está
  inicializado en el registry, o no se reconoce (`normalizeChainSlug` → undefined),
  THEN the system SHALL omitir el settle downstream con un skip-code claro
  (`CHAIN_NOT_SUPPORTED`) y un log estructurado que liste las chains inicializadas
  (`getInitializedChainKeys()`), **PROHIBIDO** caer al default Avalanche o enviar
  el pago a una chain distinta de la declarada por el agente.
  [TBD F2: dado que `signAndSettleDownstream` es NEVER-throws (H13), "fallar fuerte"
  aquí = retornar `null` + log de error, consistente con el resto de skip-codes;
  Architect decide si además se emite un evento/telemetría de severidad mayor.]

- **AC-5** (State-driven — coherencia chain en todo el flujo downstream): WHILE se
  procesa el pago a un agente con chain resuelta `K`, the system SHALL usar el
  MISMO `ChainKey K` para resolver el adapter (`getPaymentAdapter(K)`), la firma
  (token/domain/chainId de `K`) y el facilitator/network del settle. PROHIBIDO
  mezclar el adapter de una chain con el `network` de otra.

- **AC-6** (Ubiquitous — sin hardcodes de chain): the system SHALL derivar
  address USDC/PYUSD, `network` tag, `chainId`, decimales y EIP-712 domain del
  ADAPTER seleccionado (`getToken()`/`getNetwork()`/`supportedTokens[].decimals`)
  — PROHIBIDO mantener los literales `DEFAULT_FUJI_USDC`/`DEFAULT_AVALANCHE_USDC`/
  `FUJI_NETWORK`/`AVALANCHE_NETWORK` como fuente de verdad del settle.

## Scope IN

- `src/lib/downstream-payment.ts` — **núcleo del cambio**:
  - Reemplazar el guard `if (agent.payment.chain !== 'avalanche') return null`
    (`:457-467`) por: resolver `ChainKey` con `normalizeChainSlug(agent.payment.chain)`
    → si `undefined` o no inicializada, skip `CHAIN_NOT_SUPPORTED` (fail-loud, AC-4).
  - Migrar sign+verify+settle a `getPaymentAdapter(chainKey).sign(...)` /
    `.verify(...)` / `.settle(...)` en vez del flujo inline `buildClients()` +
    `signTypedData` + `postFacilitator` (H6, H7). [TBD F2: cuánto del módulo
    legacy se elimina vs. se conserva — ver DT-1.]
  - Conservar (o reubicar) la pre-flight balance check, el contrato NEVER-throws,
    los skip-codes y la observabilidad estructurada (`DownstreamResult`,
    `DownstreamSkipCode`). [TBD F2: la balance check inline lee el balance del
    operator en la chain — debe hacerse chain-aware o delegarse — DT-3.]
- `src/lib/downstream-payment.test.ts` + `src/lib/downstream-payment.mainnet.test.ts`
  — extender/ajustar: tests de selección de chain (Base / Avalanche / Kite),
  regresión Avalanche byte-idéntica, y el fail-loud de chain no soportada.
- `src/services/compose.ts` — SOLO si el wiring requiere propagar el `ChainKey`
  resuelto (p.ej. si `signAndSettleDownstream` cambia de firma). [TBD F2: idealmente
  el módulo resuelve la chain internamente desde `agent.payment.chain` para no
  cambiar la firma del consumidor — DT-2.]
- `src/services/compose.test.ts` — ajustar mocks/expectativas si cambia el wiring.

## Scope OUT

- **Path inbound** (`src/middleware/x402.ts`, `src/middleware/a2a-key.ts`) — YA
  resuelto en WKH-111 (DONE). NO se toca.
- **Mainnet de cualquier chain** (avalanche-mainnet, base-mainnet, kite-mainnet) —
  solo testnets (`avalanche-fuji`, `base-sepolia`, `kite-ozone-testnet`). Los
  adapters mainnet existen pero NO se inicializan ni se validan en esta HU. La
  activación mainnet del downstream (script `activate-mainnet-downstream.sh`)
  queda fuera de alcance.
- **Modelo a2a-key / budget / debit** — NO se toca la lógica de presupuesto ni el
  `budgetService`. El downstream settle es ortogonal al debit per-step (WKH-59).
- **Schema / Agent Card / discovery** — NO se cambia cómo se expone `payment.chain`;
  se consume tal cual (pass-through, H12).
- **Multi-chain en un solo pago / split payments** — un agente cobra en UNA chain;
  fuera de alcance pagar el mismo agente en varias chains.

## Decisiones técnicas (DT-N)

- **DT-1** — *Reutilizar el adapter, no reimplementar la firma* (núcleo de la HU):
  la firma+settle se delega a `getPaymentAdapter(chainKey).sign/verify/settle`
  (H9), eliminando el flujo inline `buildClients()`+`signTypedData`+`postFacilitator`.
  Justificación: el adapter ya es el primitivo chain-aware probado onchain en las 3
  chains (H15) y es lo que usa el inbound (WKH-111). [A cerrar en F2: cuánto del
  módulo legacy se borra — `getUsdcAddress`/`buildClients`/`buildCanonicalBody`/
  `postFacilitator`/`TRANSFER_WITH_AUTHORIZATION_TYPES` quedan obsoletos si se usa
  el adapter; decidir si el módulo pasa a ser un thin orchestrator alrededor del
  adapter o si se conserva algún path por compat.]
- **DT-2** — *Resolución de chain interna, firma del export estable* (preferido):
  `signAndSettleDownstream(agent, logger)` resuelve el `ChainKey` internamente
  desde `agent.payment.chain` (vía `normalizeChainSlug`), sin cambiar su firma
  pública, para no tocar `compose.invokeAgent`. [Reevaluable en F2 si Architect
  prefiere propagar un `chainKey` explícito desde compose para coherencia con el
  inbound resuelto.]
- **DT-3** — *Pre-flight balance check chain-aware* [a cerrar en F2]: hoy
  `readOperatorBalance` lee el balance del operator en la chain del downstream
  (`downstream-payment.ts:237-249`). Al ir multi-chain, o se hace chain-aware
  (leer balance en la chain resuelta vía el public client del adapter) o se delega
  al facilitator (que ya falla si no hay fondos). Architect decide si se conserva
  la pre-flight check (mejor observabilidad, skip-code `INSUFFICIENT_BALANCE`) o
  se simplifica.
- **DT-4** — *Semántica de "fallar fuerte" bajo contrato NEVER-throws* [a cerrar
  en F2]: el módulo NEVER throws (H13). El input pide "fallar fuerte con error
  claro (no silent skip)". Conciliación candidata: chain no soportada → `null`
  + log de **error** (no info) con skip-code `CHAIN_NOT_SUPPORTED` y la lista de
  chains inicializadas; el caller (compose) sigue su flujo normal (no rompe el
  pipeline). Architect decide si además se emite telemetría/evento.
- **DT-5** — *Modo del adapter Kite para el downstream* [a cerrar en F2]: el
  adapter Kite tiene dos modos (`pieverse` y `x402`); el path probado onchain es
  el canonical x402 contra el token directo (`2026-05-27...validation.md` Capa B,
  settle `0xb861b69b`). El downstream debe usar el MISMO modo que produce settle
  onchain válido. Architect confirma en F2.

## Constraint Directives (CD-N)

- **CD-1** (OBLIGATORIO — cero regresión Avalanche): el path con
  `agent.payment.chain === 'avalanche'`/`'avalanche-fuji'` DEBE permanecer
  funcionalmente idéntico al actual (mismo facilitator, USDC Fuji, `eip155:43113`,
  skip-codes, NEVER-throws). Los 1048 tests existentes DEBEN seguir verdes.
  Cualquier diff observable en el path Avalanche es **BLOQUEANTE**.
- **CD-2** (OBLIGATORIO — solo viem, PROHIBIDO ethers.js): cualquier interacción
  onchain/firma usa viem v2 (vía el adapter). PROHIBIDO introducir ethers.
- **CD-3** (OBLIGATORIO — sin hardcodes de chain): PROHIBIDO usar
  `DEFAULT_FUJI_USDC`/`DEFAULT_AVALANCHE_USDC`/`FUJI_NETWORK`/`AVALANCHE_NETWORK`
  ni ningún literal de address/chainId/network/decimales como fuente de verdad del
  settle. Todo deriva del adapter seleccionado (`getToken()`/`getNetwork()`/
  `supportedTokens[].decimals`) y del chain-resolver. (El único literal tolerado
  sería un default legacy de compat si se conserva un path Avalanche, sujeto a CD-1.)
- **CD-4** (OBLIGATORIO — fail-loud, no silent cross-chain): PROHIBIDO caer al
  default Avalanche o enviar el pago a una chain distinta de la declarada por el
  agente cuando la chain resuelta no está soportada/inicializada. DEBE skip con
  `CHAIN_NOT_SUPPORTED` + log estructurado con `getInitializedChainKeys()`.
- **CD-5** (OBLIGATORIO — TypeScript strict): PROHIBIDO `any` explícito y
  `as unknown`. El `ChainKey` resuelto se tipa como `ChainKey` (no `string`).
- **CD-6** (OBLIGATORIO — coherencia de chain): el sign, el verify y el settle de
  un mismo pago downstream DEBEN usar el mismo `ChainKey`. PROHIBIDO resolver la
  chain más de una vez con fuentes distintas dentro del mismo flujo.
- **CD-7** (OBLIGATORIO — preservar contrato NEVER-throws): `signAndSettleDownstream`
  DEBE seguir sin lanzar excepciones; devuelve `DownstreamResult` o `null`. El
  caller (compose) NO debe romperse por una chain no soportada.

## Análisis de paralelismo / waves

- **¿Bloquea otras HU?** Cierra el último gap funcional conocido del epic BASE
  port (Capa G, hallazgo #1). No bloquea HUs de otras superficies.
- **¿Puede ir en paralelo con otra WKH?** El cambio se concentra en
  `src/lib/downstream-payment.ts` (+ posible toque mínimo en `compose.ts` y tests).
  NO colisiona con `src/middleware/x402.ts` (WKH-111, DONE) ni con el modelo
  a2a-key/budget. Cualquier HU que NO toque `downstream-payment.ts` puede correr
  en paralelo. WKH-111 (inbound) y esta (outbound) son hermanas pero tocan
  archivos disjuntos.
- **Waves sugeridas (orientativo para Architect, no vinculante)**:
  - **W1**: resolución de `ChainKey` desde `agent.payment.chain` + fail-loud
    `CHAIN_NOT_SUPPORTED` reemplazando el guard `!== 'avalanche'` (AC-4, CD-4).
    Tests unitarios del resolver + skip.
  - **W2**: migrar sign+verify+settle a `getPaymentAdapter(chainKey)` (DT-1),
    preservando contrato NEVER-throws + skip-codes; cierre de DT-3 (balance
    check) y DT-5 (modo Kite). Tests de selección Base/Avalanche/Kite.
  - **W3**: regresión Avalanche byte-idéntica (CD-1) + suite completa 1048 verde +
    (opcional, lo corre el humano) evidencia onchain fresh Base/Kite vía smoke.

## Missing Inputs

- **[resuelto en F2]** DT-1: alcance exacto del borrado del flujo inline legacy
  (qué helpers quedan obsoletos al delegar al adapter).
- **[resuelto en F2]** DT-3: si la pre-flight balance check se hace chain-aware o
  se delega al facilitator.
- **[resuelto en F2]** DT-4: forma concreta de "fallar fuerte" bajo el contrato
  NEVER-throws (null + log error vs. evento de telemetría).
- **[resuelto en F2]** DT-5: confirmar el modo del adapter Kite (canonical x402)
  para el sign downstream.
- **[resuelto en F2]** DT-2: firma del export estable (resolución interna) vs.
  propagar `chainKey` desde compose.
- **[NO bloqueante]** Confirmación operacional de que en el entorno de
  test/CI/prod `WASIAI_A2A_CHAINS` incluye `base-sepolia` y `kite-ozone-testnet`
  para que el downstream pueda resolver el bundle (en prod ya están las 3 testnets
  inicializadas — Capa D de la validación). El SDD debe documentar el requisito de env.
- **[NO bloqueante]** Operator wallet ya funded en las 3 chains (input + H15);
  no es bloqueante de F1.
