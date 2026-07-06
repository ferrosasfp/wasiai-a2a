# Work Item — [WKH-144] [SEC] x402/settle re-verify fail-CLOSED en mainnet

## Resumen
Hoy el re-verify on-chain del settle (`verifySettledTx`/`verifyDefaultChainSettle` en
`src/adapters/settle-verifier.ts`) trata un `RPC_UNAVAILABLE` (el gateway no pudo leer
el nodo) como fail-**OPEN**: confía ciegamente en la respuesta del facilitator y deja
pasar el settle (`ok:true, warn:true`). Ese fail-open es aceptable en **testnet** (RPC
flaky, sin plata real en juego) pero en **mainnet** un blip de RPC anularía la ÚNICA
verificación independiente que existe sobre el facilitator — abriendo la puerta a un
settle forjado/insuficiente no detectado (doble-cobro / leg marcado `charged` sin
respaldo on-chain real). El fix gatea el fail-open a testnet-only: en mainnet,
`RPC_UNAVAILABLE` pasa a fail-**CLOSED**.

## Sizing
- SDD_MODE: mini (cambio quirúrgico, un solo módulo + su test suite)
- Estimación: S
- Sizing pipeline: FAST+AR (money-path → Adversarial Review obligatorio antes de merge)
- Branch sugerido: `fix/154-wkh-144-settle-reverify-fail-closed`

## F0 — Hallazgos de codebase grounding

1. **Un solo choke-point, no dos.** `src/services/fee-split.ts:450-461` y
   `src/services/compose.ts:958-976` NO duplican la lógica de re-verify — ambos
   llaman al MISMO helper `verifyDefaultChainSettle()` (`src/adapters/settle-verifier.ts:312-337`),
   que a su vez delega a `verifySettledTx()` (`settle-verifier.ts:196-300`). El
   patrón `if (reVerified.warn) log.warn(...)` / `if (!reVerified.ok) { markLegFailed / throw }`
   en fee-split.ts y compose.ts es idéntico (ambos ya reaccionan correctamente a
   `ok:false`) — **no requieren cambios de código**, solo heredan el fix.
2. **Los 3 emisores de `RPC_UNAVAILABLE`** están todos dentro de `verifySettledTx`:
   - `settle-verifier.ts:220` — no hay RPC configurado para el chainKey (`getClient()` → `null`).
   - `settle-verifier.ts:244` — `getTransactionReceipt` falla 2 veces (transporte, clasificado por `classifyReceiptError`).
   - `settle-verifier.ts:257` — `getChainId()` falla (transporte).
   Los 3 hoy retornan `{ ok: true, reason: 'RPC_UNAVAILABLE', warn: true }` sin
   importar la chain. El fix debe tocar los 3 (o un guard único que envuelva la
   decisión final antes del `return`).
3. **Fuente de verdad de mainnet/testnet**: NO es `network === 'mainnet'` de
   `src/adapters/base/payment.ts` (eso es un concepto interno del adapter Base,
   `BaseNetwork = 'mainnet' | 'testnet'`, no cross-chain). La fuente canónica es el
   propio `ChainKey` (`src/adapters/types.ts:124-131`) que YA llega como parámetro
   `chainKey` a `verifySettledTx`. Los 3 slugs mainnet son exactamente
   `'kite-mainnet' | 'avalanche-mainnet' | 'base-mainnet'` — todos y solo ellos
   terminan en el sufijo `-mainnet` (`registry.ts:28-35`, `SUPPORTED_CHAINS`).
   `'tempo-testnet'` es testnet-only por diseño (CD-2 de WKH-090, sin variante
   mainnet) — el suffix-check nunca lo confunde. No existe hoy un helper
   `isMainnetChainKey()`; hay que crearlo (o inlinear el check) en este módulo.
4. **Evidencia de testeabilidad ya existente**: `settle-verifier.test.ts` YA usa
   `CHAIN_KEY = 'kite-mainnet'` como default en TODOS sus tests (línea 71,
   `baseArgs()`), incluidos los 3 tests de `RPC_UNAVAILABLE` (líneas 134-164) que
   HOY esperan `ok:true` con ese chainKey mainnet. Esto confirma que (a) el gate es
   100% testeable pasando el `chainKey` explícito sin necesitar `initAdapters()`
   real, y (b) esos 3 tests existentes VAN A ROMPER intencionalmente con este fix
   (deben actualizarse a `ok:false`) — son justamente la evidencia de la
   regresión que hay que introducir a propósito.
5. **Nonce anti-replay x402** (`src/services/x402-nonce.ts`) es un subsistema
   DISTINTO: dedup en Postgres (`UNIQUE(network, nonce)`) sobre el
   `authorization.nonce` EIP-3009, que YA es single-use a nivel del TOKEN
   on-chain. El propio código documenta por qué el fail-open ahí es seguro
   ("esta tabla nunca es la única defensa del replay"): a diferencia del settle
   re-verify (que es la ÚNICA verificación independiente sobre el facilitator),
   el nonce DB-check es defensa en profundidad sobre una garantía on-chain que
   existe igual. Riesgo no equivalente → **OUT de este ticket** (ver DT-4).

## Acceptance Criteria (EARS)

- AC-1: WHEN la chain default/objetivo es mainnet (`chainKey` termina en
  `-mainnet`: `kite-mainnet` | `avalanche-mainnet` | `base-mainnet`) AND
  `verifySettledTx` clasifica el re-read on-chain como `RPC_UNAVAILABLE`
  (transporte/timeout/sin RPC configurado), the system SHALL retornar
  `{ ok: false }` (fail-CLOSED) — ningún leg SHALL marcarse `charged` en
  `fee-split.ts` (debe ir a `markLegFailed`) ni ningún settle downstream en
  `compose.ts` SHALL confirmarse (debe abortar/tirar error) basándose
  únicamente en la respuesta del facilitator.

- AC-2: WHILE la chain default/objetivo es testnet (`kite-ozone-testnet`,
  `avalanche-fuji`, `base-sepolia`, `tempo-testnet`), the system SHALL preservar
  EXACTAMENTE el comportamiento actual ante `RPC_UNAVAILABLE`
  (`{ ok: true, reason: 'RPC_UNAVAILABLE', warn: true }`) — cero cambio de
  comportamiento, byte-idéntico a hoy.

- AC-3: IF el re-read on-chain retorna una contradicción DEFINITIVA
  (`TX_NOT_FOUND`, `TX_REVERTED`, `CHAIN_MISMATCH`, `RECIPIENT_MISMATCH`,
  `TOKEN_MISMATCH`, `AMOUNT_MISMATCH`), THEN the system SHALL seguir
  fail-CLOSED (`ok:false`) SIN IMPORTAR mainnet o testnet — este guard ya
  existe hoy y NO debe regresar ni modificarse.

- AC-4: the system SHALL implementar el gate mainnet/testnet en UN SOLO lugar
  (`src/adapters/settle-verifier.ts`, dentro de `verifySettledTx` o un helper
  que envuelva sus 3 puntos de emisión de `RPC_UNAVAILABLE`) de forma que
  `src/services/fee-split.ts` y `src/services/compose.ts` (ambos consumidores
  vía `verifyDefaultChainSettle`) hereden el fix SIN cambios de código en esos
  dos call-sites.

- AC-5: WHEN un settle en mainnet falla-CLOSED por `RPC_UNAVAILABLE`, the
  system SHALL emitir una señal de observabilidad (log estructurado /
  `reason` distinguible) que permita a un operador diferenciar "outage de RPC
  en mainnet" de "contradicción on-chain definitiva (posible forgery)" — el
  shape exacto del `reason`/campo se define en F2 (Architect), no bloqueante
  para F1.

- AC-6: WHILE el kill-switch `SETTLE_VERIFY_ONCHAIN=false` está OFF, the
  system SHALL seguir retornando `{ ok: true, reason: 'DISABLED' }`
  incondicionalmente, sin importar mainnet/testnet — el nuevo gate NO debe
  alterar la rama DISABLED.

- AC-7: the system SHALL actualizar `src/adapters/settle-verifier.test.ts` de
  forma que (a) los tests existentes de `RPC_UNAVAILABLE` que usan un
  `chainKey` mainnet (`kite-mainnet`, líneas ~134-164) pasen a esperar
  `ok:false` (fail-CLOSED), y (b) se agreguen tests equivalentes con un
  `chainKey` testnet (ej. `kite-ozone-testnet`) que confirmen que el fail-OPEN
  histórico se preserva ahí.

## Scope IN
- `src/adapters/settle-verifier.ts` — `verifySettledTx` (los 3 puntos de
  retorno `RPC_UNAVAILABLE`) + helper de detección mainnet (nuevo,
  `isMainnetChainKey()` o inline, ubicación exacta a decidir en F2).
- `src/adapters/settle-verifier.test.ts` — actualizar tests existentes
  (mainnet → fail-closed) + agregar tests nuevos (testnet → fail-open
  preservado).

## Scope OUT
- `src/services/fee-split.ts` / `src/services/compose.ts` — sin cambios de
  código (ya reaccionan correctamente a `ok:false`; heredan el fix vía
  `verifyDefaultChainSettle`). Sus test suites (`fee-split.test.ts`,
  `compose.test.ts`, `compose.chain-flow.test.ts`) mockean
  `verifyDefaultChainSettle` directamente — no necesitan cambios, aunque el
  Dev puede agregar un test defensivo opcional de integración si lo considera
  de bajo costo.
- `src/services/x402-nonce.ts` (nonce anti-replay x402 inbound) — subsistema y
  riesgo distintos (ver DT-4 y hallazgo F0 #5). Sugerido follow-up ticket
  separado si se quiere simetría total (ej. WKH-144b), NO bloqueante acá.
- Ramas de contradicción definitiva (`TX_NOT_FOUND`/`TX_REVERTED`/etc.) — ya
  fail-closed, intocadas.
- Kill-switch `SETTLE_VERIFY_ONCHAIN` — comportamiento DISABLED intacto.
- Cualquier env var / deploy / activación real de mainnet — el proyecto opera
  testnet-only hoy (ver `.nexus/project-context.md`); este fix es preventivo,
  no habilita ni depende de tráfico mainnet real.

## Decisiones técnicas (DT-N)
- DT-1: Fuente de verdad de mainnet = el `ChainKey` string ya recibido como
  parámetro en `verifySettledTx` (sufijo `-mainnet`). NO se usa el `network`
  interno de `base/payment.ts` (`'mainnet'|'testnet'`), que es un detalle de
  implementación de UN adapter, no la fuente canónica cross-chain. Ventaja:
  funciona para cualquier caller futuro que pase un `chainKey` explícito, no
  solo el default de la registry.
- DT-2: El gate se implementa UNA sola vez dentro de
  `src/adapters/settle-verifier.ts` (no duplicado en fee-split.ts/compose.ts).
  Ambos call-sites heredan automáticamente vía `verifyDefaultChainSettle`. Se
  evalúa extraer un helper reutilizable `isMainnetChainKey(chainKey)` — F2
  decide su ubicación exacta (candidatos: el propio `settle-verifier.ts`,
  `types.ts`, o `chain-resolver.ts`).
- DT-3: v1 NO introduce un kill-switch propio para el fail-closed-en-mainnet
  (reusa `SETTLE_VERIFY_ONCHAIN` general). Si se necesita un override rápido
  sin redeploy (ej. `SETTLE_VERIFY_MAINNET_FAIL_CLOSED`, default ON), es una
  decisión de F2 — ver Missing Inputs #1.
- DT-4: El nonce anti-replay x402 (`x402-nonce.ts`) queda explícitamente FUERA
  de este ticket — subsistema distinto (dedup DB sobre un nonce que ya es
  single-use on-chain), riesgo no equivalente al re-verify de settle (que es
  la única verificación independiente sobre el facilitator). Ver Scope OUT.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO cambiar comportamiento en testnet — cualquier `chainKey`
  que NO termine en `-mainnet` debe producir exactamente
  `{ ok:true, reason:'RPC_UNAVAILABLE', warn:true }` ante RPC_UNAVAILABLE,
  igual que hoy.
- CD-2: PROHIBIDO tocar/debilitar las ramas de contradicción definitiva
  (`TX_NOT_FOUND`/`TX_REVERTED`/`CHAIN_MISMATCH`/`RECIPIENT_MISMATCH`/
  `TOKEN_MISMATCH`/`AMOUNT_MISMATCH`) — deben seguir fail-CLOSED sin cambios.
- CD-3: PROHIBIDO tocar el kill-switch `SETTLE_VERIFY_ONCHAIN` / su rama
  `DISABLED`.
- CD-4: OBLIGATORIO que `verifySettledTx`/`verifyDefaultChainSettle` NUNCA
  tiren una excepción no capturada — el nuevo fail-closed se expresa como
  `{ ok:false, reason, ... }`, jamás un `throw` dentro del propio verifier.
- CD-5: PROHIBIDO loguear secrets (private keys, API keys de facilitator,
  firmas completas) en cualquier log nuevo de observabilidad — solo
  `txHash`/`chainKey`/`reason`/`orchestrationId`/`role` (mismo shape que los
  logs existentes en fee-split.ts/compose.ts).
- CD-6: OBLIGATORIO no romper ningún test verde de la suite (~2640 tests)
  fuera de los que se actualizan explícitamente en `settle-verifier.test.ts`
  por este cambio.
- CD-7: PROHIBIDO duplicar la lógica de detección mainnet en más de un
  archivo (un solo choke-point, DT-2).

## Missing Inputs
- [NEEDS CLARIFICATION, default=NO] ¿Se necesita un kill-switch propio para
  el fail-closed-en-mainnet (independiente de `SETTLE_VERIFY_ONCHAIN`)?
  Default: NO — el proyecto opera testnet-only hoy (sin tráfico mainnet real),
  así que un incidente real de RPO en mainnet no tiene impacto inmediato en
  producción; si aparece, revertir vía redeploy es aceptable. Architect puede
  reabrir en F2 si lo considera necesario.
- [NEEDS CLARIFICATION, default=OUT] ¿El nonce anti-replay x402
  (`x402-nonce.ts`) debe endurecerse en el mismo ticket? Default: OUT (ver
  DT-4/hallazgo F0 #5) — subsistema y riesgo distintos. Sugerido follow-up
  separado si el humano quiere simetría total de "fail-closed en mainnet"
  across todo el money-path.
- [resuelto en F2] Shape exacto del `reason`/campo de observabilidad para
  distinguir "RPC outage en mainnet → fail-closed" de una contradicción
  on-chain genuina (AC-5) — decisión de Architect, no bloqueante para F1.

## Análisis de paralelismo
- No bloquea otras HUs — cambio aislado en `src/adapters/settle-verifier.ts` +
  su test suite. Puede correr en paralelo con cualquier HU que no toque ese
  archivo ni `settle-verifier.test.ts`.
- Es un fix de seguridad/money-path preventivo (el proyecto opera
  testnet-only hoy), pero se recomienda priorizarlo/cerrarlo ANTES de
  cualquier activación real de tráfico mainnet en cualquier chain
  (`kite-mainnet`/`avalanche-mainnet`/`base-mainnet`).
