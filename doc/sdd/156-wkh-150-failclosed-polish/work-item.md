# Work Item — [WKH-150] [WKH-144b] Polish del fail-closed mainnet (log engañoso + guard del invariante `-mainnet`)

## Resumen
Follow-up chico (no-bloqueante) de WKH-144 (merge `52fff09`, DONE), que hizo
fail-**CLOSED** en mainnet el re-verify on-chain del settle ante
`RPC_UNAVAILABLE`. AR/CR de WKH-144 dejaron 2 refinamientos: (1) el log
`"trusting facilitator"` en `fee-split.ts`/`compose.ts` se emite también en el
path fail-closed (contradictorio: dice "confiando" justo antes de bloquear),
y (2) el invariante de naming `ChainKey` que termina en `-mainnet` (del cual
depende `isMainnetChainKey()`) no tiene ningún guard automático — una chain
mainnet futura con slug distinto reabriría WKH-144 en silencio.

## Sizing
- SDD_MODE: mini
- Estimación: S
- Sizing pipeline: FAST+AR (AC-1 toca el path de decisión de `fee-split.ts`/
  `compose.ts` — money-path adjacent; Adversarial Review obligatorio antes de
  merge, igual que WKH-144)
- Branch sugerido: `fix/156-wkh-150-failclosed-polish`

## F0 — Hallazgos de codebase grounding

1. **Líneas exactas del log "trusting facilitator" — DOS call-sites
   independientes, NO un helper compartido:**
   - `src/services/fee-split.ts:455-459` — estructurado (pino):
     ```ts
     if (reVerified.warn) {
       log.warn(
         { orchestrationId, role, reason: reVerified.reason },
         'split leg settle re-verify unavailable, trusting facilitator',
       );
     }
     ```
     seguido, líneas 461-469, del check `if (!reVerified.ok) { ... markLegFailed ... }`.
   - `src/services/compose.ts:966-969` — template string:
     ```ts
     if (reVerified.warn) {
       log.warn(
         `[Compose] settle on-chain re-verify unavailable for ${agent.slug} (${reVerified.reason ?? 'unknown'}), trusting facilitator confirmation`,
       );
     }
     ```
     seguido, líneas 972-976, del check `if (!reVerified.ok) { throw ... }`.
   - Confirmado: **ambos** call-sites disparan el log de "trusting" únicamente
     en base a `reVerified.warn === true` (sin mirar `ok`), y el warn de
     WKH-144 fail-closed en mainnet retorna `{ ok:false, warn:true }`
     (`rpcUnavailableResult`, `settle-verifier.ts:209-218`) — por eso hoy SIEMPRE
     se loguea "trusting facilitator" incluso en el path que a continuación
     bloquea el leg / tira la excepción. Son 2 strings literales distintos que
     hay que editar en 2 archivos, no un solo choke-point de texto.

2. **Fuente de verdad canónica del invariante mainnet — confirmado que hoy es
   circular por diseño (DT-1 de WKH-144), pero SÍ existe una fuente
   independiente disponible para un test no-tautológico:**
   - `ChainKey` (`src/adapters/types.ts:124-131`) es un union type de 7 slugs
     literales; `SUPPORTED_CHAINS` (`src/adapters/registry.ts:28-35`) es un
     array plano de los mismos strings — **ningún campo `network`/`family`/
     `isMainnet` acompaña la lista**. El propio work-item de WKH-144 (DT-1) ya
     documenta explícitamente que el `ChainKey` string ES la fuente de verdad
     ("NO se usa el `network` interno de `base/payment.ts`… la fuente canónica
     es el propio `ChainKey`"). Un test que derive "cuál chain es mainnet" del
     mismo sufijo `-mainnet` y luego lo compare contra `isMainnetChainKey()`
     sería tautológico (mismo dato, dos veces).
   - **Fuente independiente real encontrada**: cada adapter de chain define su
     propio objeto viem `Chain` con un campo `testnet: boolean`, en un módulo
     DISTINTO de `types.ts`/`registry.ts`:
     - `src/adapters/avalanche/chain.ts` — re-exporta `avalanche` / `avalancheFuji`
       de `viem/chains` (chainId 43114 / 43113). Estos son objetos **de la
       librería viem**, no autoría propia — `avalanche.testnet` es `undefined`
       (falsy → mainnet), `avalancheFuji.testnet === true`.
     - `src/adapters/base/chain.ts` — re-exporta `base` / `baseSepolia` de
       `viem/chains` (chainId 8453 / 84532). Mismo patrón: `base.testnet` falsy,
       `baseSepolia.testnet === true`.
     - `src/adapters/kite-ozone/chain.ts` — define localmente
       `kiteMainnet = defineChain({ id: 2366, testnet: false, ... })` y
       `kiteTestnet = defineChain({ id: 2368, testnet: true, ... })` (líneas
       3-36). Autoría propia, pero en un archivo distinto del `ChainKey` union.
     - `src/adapters/tempo/index.ts` + su `chain.ts` (no leído en detalle,
       testnet-only por diseño CD-2 de WKH-090) — `getTempoChain('testnet')`.
   - Cruzar `isMainnetChainKey(chainKey)` contra el booleano `.testnet` de estos
     objetos viem (particularmente avalanche/base, que vienen de la librería
     externa) SÍ es un invariante no-circular: detecta si alguien agrega un
     `ChainKey` nuevo cuyo sufijo no coincide con el `testnet` real del chain
     object que la factory le asocia (ej. alguien crea `'avalanche-c-chain'`
     apuntando al objeto `avalanche` (`testnet:false`) sin el sufijo
     `-mainnet` — el test debe fallar el build).
   - **AdaptersBundle no expone el chain object viem directamente** (solo
     `chainConfig.chainId: number`), así que el test necesita importar los
     chain objects directamente desde cada `chain.ts` (`avalanche`,
     `avalancheFuji`, `base`, `baseSepolia`, `kiteMainnet`, `kiteTestnet`, +
     tempo) y armar el mapeo `ChainKey → chain.testnet` dentro del propio
     archivo de test — NO requiere tocar `registry.ts`/`AdaptersBundle`
     (Scope OUT, ver abajo), aunque Architect puede decidir en F2 exponer un
     helper si lo considera más limpio.

3. **Shape de `ChainKey`** (`src/adapters/types.ts:124-131`): union literal de
   7 strings (`kite-ozone-testnet | kite-mainnet | avalanche-fuji |
   avalanche-mainnet | base-sepolia | base-mainnet | tempo-testnet`), ya con
   un docblock (líneas 117-123) sobre inmutabilidad general del tipo — pero
   SIN mención del invariante de seguridad `-mainnet` (AC-2 lo agrega).

## Acceptance Criteria (EARS)

- AC-1a: WHEN `verifyDefaultChainSettle()` retorna `{ warn: true, ok: false }`
  (fail-closed mainnet, WKH-144) en `src/services/fee-split.ts:455-459`, the
  system SHALL loguear un mensaje que refleje el RECHAZO (ej. `'split leg
  settle re-verify unavailable — REJECTING (fail-closed mainnet)'` o
  equivalente, shape exacto a decisión de F2), NO el texto actual "trusting
  facilitator" — CERO cambio de la lógica de `markLegFailed` que sigue en las
  líneas 461-469.

- AC-1b: WHEN `verifyDefaultChainSettle()` retorna `{ warn: true, ok: false }`
  en `src/services/compose.ts:966-969`, the system SHALL loguear un mensaje
  análogo de RECHAZO en vez de "trusting facilitator confirmation" — CERO
  cambio de la lógica `throw` que sigue en las líneas 972-976.

- AC-1c: WHILE `verifyDefaultChainSettle()` retorna `{ warn: true, ok: true }`
  (fail-open testnet, comportamiento histórico preservado por WKH-144), the
  system SHALL preservar EXACTAMENTE el texto de log actual ("trusting
  facilitator" / "trusting facilitator confirmation") en ambos call-sites —
  byte-idéntico a hoy.

- AC-2a: the system SHALL documentar, vía JSDoc en el type `ChainKey`
  (`src/adapters/types.ts:124-131`), el invariante de seguridad del que
  depende `isMainnetChainKey()` (`settle-verifier.ts:197-199`): todo slug
  mainnet DEBE terminar en el sufijo literal `-mainnet`, y cualquier chain
  mainnet nueva que se agregue a este union DEBE respetar esa convención o el
  gate fail-closed de WKH-144 la tratará silenciosamente como testnet
  (fail-open con plata real en juego).

- AC-2b: the system SHALL agregar un test en `settle-verifier.test.ts` (o un
  archivo de test dedicado al invariante, a decisión de F2) que recorra cada
  `ChainKey` soportado (`SUPPORTED_CHAINS`, `registry.ts:28-35`) y verifique,
  contra una fuente INDEPENDIENTE del sufijo del propio `ChainKey` (el
  booleano `testnet` del objeto viem `Chain` asociado — `avalanche` /
  `avalancheFuji` de `viem/chains`, `base` / `baseSepolia` de `viem/chains`,
  `kiteMainnet` / `kiteTestnet` de `kite-ozone/chain.ts`, y el chain de Tempo
  si aplica), que `isMainnetChainKey(chainKey) === !chainObject.testnet` para
  TODOS los slugs — el build SHALL fallar si algún `ChainKey` futuro rompe esa
  correspondencia.

- AC-2c: IF se agrega un `ChainKey` nuevo al union sin actualizar el mapeo del
  test de AC-2b, THEN el test SHALL fallar de forma explícita (ej.
  `Object.keys` mismatch entre `SUPPORTED_CHAINS` y el mapeo local del test),
  NO silenciosamente ignorar el slug nuevo.

## Scope IN
- `src/services/fee-split.ts` (~455-459) — texto del log warn únicamente.
- `src/services/compose.ts` (~966-969) — texto del log warn únicamente.
- `src/adapters/types.ts` (~124-131) — JSDoc del invariante `-mainnet` en `ChainKey`.
- `src/adapters/settle-verifier.test.ts` (o nuevo archivo de test) — test del
  invariante mainnet cruzando `SUPPORTED_CHAINS` contra `.testnet` de los
  chain objects viem.
- Posible import adicional de `src/adapters/registry.ts` (`SUPPORTED_CHAINS`,
  solo lectura, sin modificar su lógica) desde el nuevo test.

## Scope OUT
- Cualquier cambio a la lógica de decisión `ok`/`warn`/fail-open/fail-closed
  en `settle-verifier.ts` (`verifySettledTx`, `rpcUnavailableResult`,
  `isMainnetChainKey`) — WKH-144 está DONE y su comportamiento NO se toca.
  Este ticket es 100% texto de log + JSDoc + test, CERO lógica de negocio.
- Cambiar el `markLegFailed` de `fee-split.ts` o el `throw` de `compose.ts` —
  intactos.
- Testnet — ningún log ni comportamiento testnet cambia (AC-1c).
- `AdaptersBundle` / `registry.ts` — no se le agrega ningún campo `network`/
  `isMainnet`; el test de AC-2b resuelve la fuente independiente importando
  directamente los chain objects de cada `chain.ts`, sin tocar el registry.
- `x402-nonce.ts` (nonce anti-replay, ya marcado OUT en WKH-144, DT-4) — sigue
  fuera de scope.
- Cualquier chain mainnet nueva real (ej. activar `ethereum-mainnet`) — este
  ticket es preventivo/guard, no agrega chains.

## Decisiones técnicas (DT-N)
- DT-1: El invariante de AC-2 se prueba contra el booleano `.testnet` de los
  objetos viem `Chain` (fuente EXTERNA para avalanche/base, autoría propia
  pero archivo distinto para kite/tempo) — NO contra el propio sufijo del
  `ChainKey` (eso sería tautológico, ver F0 #2). Es la única fuente
  verdaderamente independiente disponible hoy en el codebase.
- DT-2: El log de AC-1 se corrige en los DOS call-sites por separado
  (`fee-split.ts` y `compose.ts`) porque NO comparten un helper de logging —
  cada uno tiene su propio string literal. No se introduce un helper
  compartido nuevo en este ticket (mantiene el diff mínimo); Architect puede
  reconsiderar en F2 si lo ve de bajo riesgo.
- DT-3: El shape textual exacto de los nuevos mensajes de log (AC-1a/1b) se
  decide en F2 (Architect) — el requisito funcional es que el texto NO diga
  "trusting"/"confiando" cuando `ok===false`, y sí distinga claramente
  "rejecting"/"fail-closed" del `warn` de testnet.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar cualquier condicional de negocio en
  `settle-verifier.ts`, `fee-split.ts` o `compose.ts` — el diff en esos 2
  archivos de servicio se limita al string pasado a `log.warn`/al mensaje.
- CD-2: PROHIBIDO cambiar el comportamiento testnet (AC-1c es byte-idéntico).
- CD-3: PROHIBIDO que el nuevo test de AC-2b derive "mainnet-ness" del mismo
  sufijo `-mainnet` que está validando (evitar tautología, ver F0 #2 / DT-1).
- CD-4: OBLIGATORIO que el test de AC-2b cubra TODOS los entries de
  `SUPPORTED_CHAINS` (falla si falta un mapeo, no skip silencioso — AC-2c).
- CD-5: PROHIBIDO romper ningún test verde existente de
  `settle-verifier.test.ts` (los tests de WKH-144 que ya cubren fail-open/
  fail-closed) — este ticket solo AGREGA tests y JSDoc, no modifica los
  existentes salvo que un import nuevo lo requiera.
- CD-6: PROHIBIDO loguear secrets en los nuevos mensajes de log (mismo shape
  que hoy: `orchestrationId`/`role`/`reason`/`agent.slug`, CD-5 heredado de
  WKH-144).

## Missing Inputs
- [NEEDS CLARIFICATION, default=ambos call-sites] ¿Es aceptable que el texto
  final del log de AC-1a/1b difiera levemente entre `fee-split.ts` (pino
  estructurado) y `compose.ts` (template string), dado que hoy YA son 2
  strings distintos y no hay helper compartido? Default: SÍ, mantener el
  estilo de logging propio de cada archivo (DT-2) — Architect puede
  unificarlos en F2 si lo prefiere, no es bloqueante.
- [NEEDS CLARIFICATION, default=settle-verifier.test.ts] ¿El test de AC-2b va
  en `settle-verifier.test.ts` (junto a los tests de `isMainnetChainKey`
  existentes) o en un archivo nuevo dedicado (ej.
  `chain-key-invariant.test.ts`)? Default: agregarlo en
  `settle-verifier.test.ts` (co-locado con el gate que protege) — decisión
  final de F2/Dev, no bloqueante.
- [resuelto en F2] Shape textual exacto de los nuevos mensajes de log
  (AC-1a/1b) — Architect decide la wording final en F2, el requisito
  funcional (no decir "trusting" en el path fail-closed) ya está fijado acá.

## Análisis de paralelismo
- No bloquea otras HUs — cambio aislado en 4 archivos (2 líneas de log cada
  uno en fee-split.ts/compose.ts, JSDoc en types.ts, test nuevo en
  settle-verifier.test.ts). Puede correr en paralelo con cualquier HU que no
  toque esos 4 archivos.
- Depende de WKH-144 (DONE, merge `52fff09`) — ya mergeado, sin bloqueo.
- Sugerido cerrarlo antes de cualquier activación real de tráfico mainnet
  (mismo racional que WKH-144: guard preventivo, el proyecto opera
  testnet-only hoy).
