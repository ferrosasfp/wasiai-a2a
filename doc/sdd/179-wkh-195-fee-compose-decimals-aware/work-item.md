# Work Item — [WKH-195] Fee-charge + compose decimals-aware (cierre del hardcode ×1e12 gemelo de WKH-192)

## Resumen

WKH-192 (DONE) hizo `settlePaymentIntentOnChain` (`src/services/payment-intent.ts`)
decimals-aware, generalizando `usdToWei` (hardcode 18d) a `usdToAtomic(usd, decimals)`
derivado de `adapter.supportedTokens[0].decimals`. El MISMO hardcode `× 1e12`
(asume 18 decimales) sigue vivo en dos seams **gemelos** que WKH-192 marcó
explícitamente como Scope OUT / "candidatos a follow-up": `feeUsdcToWei()` en
`src/services/fee-charge.ts` y el inbound-payment inline en
`src/services/compose.ts` (~:819-821). Contra un token 6d (USDC en Base) el
monto firmado/settleado sería 10¹²× mayor → el settle revierte o cobra de más.
Latente hoy (default chain `kite-ozone-testnet` = PYUSD 18d, correcto), se
activa el día que el operador cambie `WASIAI_A2A_CHAIN`/`WASIAI_A2A_CHAINS` a
Base. Esta HU aplica el patrón ya auditado de WKH-192 a ambos seams, reusando
`usdToAtomic` (DRY), sin tocar el seam de WKH-192 ni el money-path que ya
funciona.

## Sizing

- SDD_MODE: full (QUALITY — money-path, mismo criterio que WKH-192)
- Estimación: S
- Branch sugerido: fix/179-wkh-195-fee-compose-decimals-aware

## Grounding (F0 — archivo:línea)

- `src/services/fee-charge.ts:164-166` — `feeUsdcToWei(feeUsdc)`:
  `String(BigInt(Math.round(feeUsdc * 1e6)) * BigInt(1e12))`. Doc-comment
  (`:156-162`) ya cita el patrón gemelo de `compose.ts:188-190` (línea vieja,
  hoy ~:819-821 tras refactors intermedios).
  - Call-sites de `feeUsdcToWei`: `fee-charge.ts:393` (`chargeProtocolFee`,
    leg de plataforma) y `fee-split.ts:32` (`import { feeUsdcToWei } from
    './fee-charge.js'`, reusado por `settleFeeSplits()` para los legs
    creator/referral — **hereda el fix transitivamente, cero cambio de código
    en `fee-split.ts`**).
  - Chain/adapter: `chargeProtocolFee` llama `getPaymentAdapter()` SIN
    `chainKey` (`fee-charge.ts:448` sign, `:471` settle) → siempre el
    **default chain adapter** (mismo patrón que `settlePaymentIntentOnChain`
    de WKH-192).
- `src/services/compose.ts:816-825` — el hardcode: comentario explícito
  "MONEY-PATH: scale priceUsdc ... Matches fee-charge.ts:feeUsdcToWei (same
  Math.round convention)" seguido de
  `BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12)`. Firma en
  `:822` (`getPaymentAdapter().sign(...)`, sin `chainKey`) y settlea en
  `:928` (`getPaymentAdapter().settle(...)`, también sin `chainKey`) — el
  `chainKey` que SÍ se resuelve en `:906-909` (`agent.payment?.chain`) es
  usado SOLO para telemetría del selector de facilitator Base (`:910-926`),
  NUNCA para elegir el adapter que firma/settlea. Confirmado: ambos seams
  (fee-charge y compose) operan sobre el **default chain adapter** exclusivamente
  — consistente con el alcance de WKH-192.
- `src/services/payment-intent.ts:158-165` — `usdToAtomic(usd, decimals)`:
  **YA EXPORTADO** (`export function usdToAtomic`), BigInt puro, byte-idéntico
  en 18d por construcción (`micro * 10n**BigInt(decimals-6)`), fallback floor
  para `<6` decimales (rama hoy inalcanzable). JSDoc dice "exported ONLY for
  byte-identical convergence tests" pero es una función pura sin
  side-effects — reusable en runtime sin restricción real; el comentario es
  aspiracional, no un guard de código.
  - Wiring de referencia (`:372-374`): `const adapter = getPaymentAdapter();
    const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; const wei =
    usdToAtomic(finalAmountUsd, decimals);` — patrón EXACTO a replicar en
    ambos seams.
  - Sin ciclo de imports: `payment-intent.ts` no importa `fee-charge.ts` ni
    `compose.ts` → ambos pueden importar `usdToAtomic` de `payment-intent.ts`
    sin riesgo de ciclo.
- `src/adapters/registry.ts:198-200` — `getPaymentAdapter(chainKey?)`
  resuelve `chainKey ?? _defaultChainKey`; llamado sin args en los 3 seams
  (payment-intent/fee-charge/compose) → mismo comportamiento (default chain).
- `src/adapters/types.ts:83` — `PaymentAdapter.supportedTokens: TokenSpec[]`
  (`{symbol, address, decimals}`), fuente única de decimals reales por chain.
- `src/adapters/escrow-verifier.ts:61-65` — patrón hermano confirmado:
  `tokenSymbol?: bundle.payment.supportedTokens[0].symbol` — el codebase ya
  deriva decimals/symbol SIEMPRE de `supportedTokens[0]` del bundle, nunca
  hardcodeado.
- `doc/sdd/176-wkh-192-settle-decimals-aware/done-report.md:63-67` — WKH-192
  documentó EXPLÍCITAMENTE `fee-charge.ts:164-166` y `compose.ts:188-190`
  (línea vieja) como "candidatos a follow-up... no tocado en esta HU (Scope
  OUT explícito WKH-192)". Esta HU es ese follow-up.

## Acceptance Criteria (EARS)

- AC-1: WHEN `chargeProtocolFee` settlea el leg de plataforma del protocol fee
  (`feeUsdcToWei`), the system SHALL derivar el atómico usando los decimales
  reales de `getPaymentAdapter().supportedTokens?.[0]?.decimals` del default
  chain adapter (vía `usdToAtomic`), nunca un exponente `1e12` fijo.
- AC-2: WHEN `compose.callAgent` firma y settlea el pago inbound x402 a un
  agente (`agent.priceUsdc > 0` sin `a2aKey`), the system SHALL derivar el
  atómico usando los decimales reales del default chain adapter (vía
  `usdToAtomic`), nunca un exponente `1e12` fijo.
- AC-3: WHILE la default chain configurada es `kite-ozone-testnet` (PYUSD,
  18 decimales), the system SHALL producir un atómico BYTE-IDÉNTICO (string
  exacta) al que produce hoy el código legado `× 1e12` tanto en
  `fee-charge.ts` como en `compose.ts`, verificado por tests de convergencia
  con ≥3 valores por seam.
- AC-4: IF `supportedTokens` está vacío/undefined en el adapter resuelto,
  THEN the system SHALL usar el fallback de 18 decimales (`?? 18`) sin lanzar
  excepción — preservando CD-B de `chargeProtocolFee` (jamás rechaza la
  promise) y sin introducir un nuevo modo de fallo en `compose.callAgent`
  (el step sigue fallando solo por las causas que ya fallaba hoy, no por este
  cambio).
- AC-5: WHEN se implementa el fix, the system SHALL reusar `usdToAtomic`
  EXPORTADO de `src/services/payment-intent.ts` (import cruzado, sin ciclo)
  en ambos seams — PROHIBIDO duplicar la fórmula BigInt en `fee-charge.ts`
  y/o `compose.ts`.
- AC-6: WHILE `fee-split.ts` sigue importando `feeUsdcToWei` de
  `fee-charge.ts` (`fee-split.ts:32`) SIN cambios de código, the system SHALL
  garantizar que los legs creator/referral (`settleFeeSplits`) heredan el
  mismo fix de forma transparente — verificado con al menos 1 test de
  regresión que ejercite `settleFeeSplits` con la config default (10000/0/0
  byte-idéntica) y confirme que el monto firmado no cambia en Kite.

## Scope IN

- `src/services/fee-charge.ts` — refactor de `feeUsdcToWei()` (o su
  reemplazo) para derivar decimals del adapter y delegar en `usdToAtomic`
  importado de `payment-intent.ts`. Firma pública puede mantenerse
  (`feeUsdcToWei(feeUsdc: number): string`) o resolverse inline en el
  call-site — decisión de F2 (Architect), documentar en DT.
- `src/services/compose.ts` (~:816-825) — reemplazar el cálculo hardcodeado
  de `valueWei` por `usdToAtomic(agent.priceUsdc, decimals)` con `decimals`
  derivado del mismo adapter que ya se usa para `sign()`/`settle()`.
- Import de `usdToAtomic` desde `src/services/payment-intent.ts` en ambos
  archivos (DRY, AC-5).
- `src/services/fee-charge.test.ts` — tests de convergencia: ≥3 valores Kite
  18d byte-idénticos al legado (string-exacta) + ≥1 valor Base 6d divergente
  (falsificable) + fallback `supportedTokens` undefined/`[]` sin throw.
- `src/services/compose.test.ts` — mismos tests de convergencia, adaptados al
  seam de `callAgent`/pago inbound x402.
- Test de regresión sobre `fee-split.ts` (AC-6) — puede vivir en
  `fee-charge.test.ts` o `fee-split.test.ts` existente, decisión de F2.
- `doc/sdd/179-wkh-195-fee-compose-decimals-aware/` (este work-item +
  artefactos del pipeline) + `_INDEX.md` bookkeeping.

## Scope OUT

- `src/services/payment-intent.ts` / `settlePaymentIntentOnChain` /
  `usdToAtomic` (la función en sí) — WKH-192, DONE, byte-idéntico verificado,
  NO se toca (solo se IMPORTA `usdToAtomic`).
- `src/services/fee-split.ts` — CÓDIGO sin cambios (hereda el fix vía el
  import existente de `feeUsdcToWei`); solo agrega cobertura de test (AC-6),
  no lógica nueva.
- `src/services/arbiter.ts`, `contracts/` (WasiAIEscrow), `escrow-verifier.ts`
  — fuera de esta HU, ya decimals-aware donde aplica (WKH-191a/f/g).
- Resolución de chain POR-STEP/POR-AGENTE en `compose.ts` (usar
  `agent.payment.chain` en vez de siempre el default chain adapter para
  sign/settle) — es un comportamiento PREEXISTENTE (confirmado en F0, el
  `chainKey` de `:906-909` hoy solo alimenta telemetría), NO se cambia acá.
  Si se decide activarlo, es una HU separada (cambio de comportamiento de
  routing, no de aritmética).
- `settle-verifier.ts` / `verifyDefaultChainSettle` — sin cambios (ya
  decimals-agnóstico, recibe `requiredAmountAtomic` ya calculado).
- Cualquier cambio de `PROTOCOL_FEE_RATE`, splits bps, o lógica de negocio
  del fee — solo la CONVERSIÓN usd→atomic cambia, el monto en USD no se
  toca.

## Decisiones técnicas (DT-N)

- DT-1: Reusar `usdToAtomic` exportado de `payment-intent.ts` en vez de crear
  un tercer helper duplicado o mover la función a un módulo compartido nuevo
  (ej. `lib/decimals.ts`). Justificación: cero ciclo de imports
  (`payment-intent.ts` no importa `fee-charge.ts` ni `compose.ts`), la
  función ya está exportada y es pura (sin side-effects), y WKH-192 ya la
  diseñó explícitamente para esto (JSDoc: "exported ONLY for... tests" es
  aspiracional, no un guard real). Extraer a un módulo `lib/` compartido
  queda como refactor cosmético opcional a decidir en F2 si el Architect lo
  prefiere por higiene de capas (`services/` importando de `services/` es
  más débil que `lib/` compartido) — no bloqueante para esta HU.
- DT-2: Decimales derivados con el patrón EXACTO de WKH-192:
  `adapter.supportedTokens?.[0]?.decimals ?? 18`, resolviendo `adapter =
  getPaymentAdapter()` UNA sola vez por seam y reusándolo para
  decimals+sign+settle (DT-3 de WKH-192: "una sola resolución" evita drift
  entre qué decimals se usaron y qué adapter realmente firmó).
- DT-3: `fee-split.ts` NO se modifica — hereda el fix transitivamente porque
  importa `feeUsdcToWei` de `fee-charge.ts` (`fee-split.ts:32`). Se agrega
  SOLO cobertura de test (AC-6), no lógica. Si `feeUsdcToWei` cambia de
  firma (ej. requiere `chainKey`/`adapter` como parámetro explícito en vez de
  resolverlo internamente), el call-site de `fee-split.ts:452` (dentro de
  `settleFeeSplits`) debe revisarse en F2 para no romper la firma pública.
- DT-4: Byte-idéntico en Kite 18d por CONSTRUCCIÓN (mismo BigInt puro que
  WKH-192, sin `parseUnits`/`Number.toFixed`), no por muestreo — mismo
  estándar de evidencia que AC-2 de WKH-192 (test string-exacta, no
  aproximada).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO duplicar la fórmula de conversión usd→atomic en
  `fee-charge.ts` y/o `compose.ts` — OBLIGATORIO importar `usdToAtomic` de
  `payment-intent.ts` (DRY, un solo choke-point de conversión decimals-aware
  en todo el codebase; DT-1).
- CD-2: OBLIGATORIO que el atómico producido en la default chain
  `kite-ozone-testnet` (18d) sea BYTE-IDÉNTICO al legado `× 1e12` para AMBOS
  seams — cualquier drift detectado en el valor firmado/settleado en Kite es
  BLOQUEANTE (mismo criterio que AC-2 de WKH-192, "piedra angular").
- CD-3: PROHIBIDO tocar `payment-intent.ts` (`settlePaymentIntentOnChain`,
  `usdToAtomic` en sí), `fee-split.ts` (código de negocio), `arbiter.ts`,
  `contracts/`, `escrow-verifier.ts`, `settle-verifier.ts` — Scope OUT
  explícito, ya decimals-aware donde corresponde o fuera de esta HU.
- CD-4: OBLIGATORIO fallback a 18 decimales sin `throw` cuando
  `supportedTokens` está vacío/undefined en el adapter resuelto (mismo
  patrón `?.[0]?.decimals ?? 18`) — preserva CD-B de `fee-charge.ts`
  (`chargeProtocolFee` JAMÁS rechaza la promise) y no introduce un nuevo modo
  de fallo en `compose.callAgent`.
- CD-5: OBLIGATORIO test de convergencia string-exacta (NO aproximada, NO
  `toBeCloseTo`) para AMBOS seams: ≥3 valores Kite 18d idénticos al legado +
  ≥1 valor Base 6d DIVERGENTE del legado (falsificable, `.not.toBe(...)`),
  espejo de T-1/T-2/T-4 de `payment-intent.test.ts` (WKH-192).

## Missing Inputs

- Ninguno bloqueante. `[NEEDS CLARIFICATION]` no aplica — el patrón, el
  seam a reusar y los call-sites exactos ya están confirmados en F0 (ver
  grounding). Cualquier decisión de forma (firma exacta de `feeUsdcToWei`
  tras el refactor, o si `usdToAtomic` migra a un módulo `lib/` compartido)
  queda resuelta en F2 (Architect), sin bloquear F1.

## Análisis de paralelismo

- Esta HU NO bloquea ninguna otra fila del `_INDEX.md` — es un fix de
  correctness aritmética en dos seams existentes, sin cambios de schema DB
  ni de contrato.
- Puede correr en PARALELO con cualquier HU `in progress` que NO toque
  `fee-charge.ts` o `compose.ts` (ej. filas 159/160/161/162/163, todas sobre
  `orchestrate.ts`/`discovery.ts` — sin overlap de archivos).
- Es un PRE-REQUISITO SUAVE (no bloqueante para código, sí para operación
  segura) de cualquier plan futuro de activar `default-chain=base-*` para el
  protocol-fee-wallet o para compose con agentes cobrando en Base — mismo
  rol que WKH-192 jugó para WKH-191d, pero en un seam distinto (fee de
  protocolo + pago inbound a agentes, no el settle de payment-intents).
- Comparte archivo (`fee-charge.ts`) con el histórico de WKH-44/132/136/143
  (splits) — todas DONE, sin trabajo `in progress` detectado en esos
  archivos al momento de este F0 (2026-07-13).
