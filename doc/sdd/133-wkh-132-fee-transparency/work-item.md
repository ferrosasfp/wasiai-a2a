# Work Item — [WKH-132] [P0] Transparencia de fee del gateway

## ⚠️ Nota de numeración (leer antes de aprobar)

`doc/sdd/_INDEX.md` fila 129 ya tiene un **WKH-132 DIFERENTE y DONE**:
*"Protocol fee de /orchestrate proporcional al costo REAL del pipeline (no al
budget declarado) + consistencia del quote"* (`fix/129-wkh-132-orchestrate-fee-on-cost`,
2026-07-01). Esta HU nueva (**"Transparencia de fee: publicar el fee del
gateway"**, del roadmap `doc/competitive/attack-plan-2026-07.md`, fechado
2026-07-03) reusa el mismo ID de ticket `WKH-132`.

`[NEEDS CLARIFICATION]` — **bloqueante para el humano, no para el analyst**:
confirmar si el ID correcto para esta HU es otro (p.ej. `WKH-142` o el
siguiente libre en el tracker externo) antes de que Architect abra el SDD,
para evitar que dos features distintas compartan referencia en commits/PRs.
Mientras tanto este work-item usa el NNN de carpeta **133** (siguiente libre
en `doc/sdd/`) para no colisionar en el índice interno; el título del PR
debería aclarar "(fee transparency, no confundir con el WKH-132 de
orchestrate-fee-on-cost ya DONE)".

La HU en sí (contenido, ACs, scope) es independiente de esta ambigüedad de ID
y no requiere más aclaración para avanzar a F2.

## Resumen
Publicar el protocol fee del gateway (1% sobre el costo real del pipeline
orquestado, cost-based desde WKH-132-antiguo/fee-on-cost) de forma explícita
y legible: (1) como campo de tasa (%) —no solo el monto en USDC que ya se
devuelve— en la respuesta de `POST /orchestrate/plan`, y (2) documentado en
README y en la guía de integración pública. Para: cualquier caller
(marketplace, agente autónomo, dev evaluando el protocolo) que hoy puede ver
`protocolFeeUsdc` (monto) en el quote pero no un dato de tasa explícito ni
una fuente doc autoritativa. Por qué: diferenciador barato y honesto vs OKX,
que no publica su take rate ("broker fee out of protocol", sin número) —
ver `doc/competitive/okx-ai-analysis-2026-07.md` (P0 #1) y
`doc/competitive/attack-plan-2026-07.md` (Wave 0).

## Sizing
- **SDD_MODE:** mini
- **Smart Sizing:** **FAST+AR** (no QUALITY puro, no FAST solo)
  - Justificación: la mayor parte del esfuerzo es documentación (README +
    guía de integración), que por sí sola sería FAST. Pero hay un cambio de
    código real en el money-path de la respuesta pública de
    `POST /orchestrate/plan` (agregar un campo nuevo al contrato JSON que
    consumen clientes externos — Yarvis PWA, wasiai-v2, terceros). Cualquier
    tocada a la forma de la respuesta de un endpoint de pago, aunque sea
    aditiva, amerita al menos una revisión Adversarial ligera (romper un
    consumer que hace validación estricta de schema, o filtrar un campo
    interno por error) antes de mergear. No amerita el pipeline QUALITY
    completo (AR + CR + F4 con evidencia archivo:línea) porque no hay
    money-path de *cobro* nuevo — el monto ya se cobra igual, solo se hace
    más visible.
  - Estimación: **S**
  - Branch sugerido: `feat/133-wkh-132-fee-transparency`

## Acceptance Criteria (EARS)

- **AC-1:** WHEN un caller recibe una respuesta `planStatus: 'ready'` de
  `POST /orchestrate/plan`, the system SHALL incluir en el body, además del
  `protocolFeeUsdc` (monto) ya existente, un campo explícito de tasa
  (`feeRatePercent`, expresado como número porcentual, p.ej. `1` para 1%)
  derivado de `getProtocolFeeRate()` (`src/services/fee-charge.ts`) —la MISMA
  fuente que ya calcula `protocolFeeUsdc`, sin un segundo lugar de verdad.

- **AC-2:** WHEN un caller recibe una respuesta con `planStatus` distinto de
  `'ready'` (`no_agents`, `budget_exhausted`, `insufficient_funds`,
  `no_relevant_agent`) de `POST /orchestrate/plan`, the system SHALL
  mantener `protocolFeeUsdc: 0` (comportamiento actual, sin cambios) y NO
  incluir `feeRatePercent` con un valor engañoso de fee "cobrado" cuando no
  hubo pipeline — omitirlo o reportar `0`, consistente con AC-1.

- **AC-3:** the system SHALL documentar el protocol fee en `README.md` de
  forma explícita y legible por humanos: tasa por defecto (1%), base de
  cálculo (costo real ejecutado del pipeline, no el budget declarado —
  referenciar el fix `WKH-132`/fee-on-cost DONE), y el hecho de que es
  configurable vía `PROTOCOL_FEE_RATE` (env, clamp `[0, 0.10]`) sin
  hardcodear el valor actual del env en el texto (para que no quede
  desactualizado si el operador lo cambia) — la sección debe dejar claro
  cuál es el *default* documentado vs el *valor efectivo* (siempre leído del
  quote, AC-1).

- **AC-4:** the system SHALL documentar el mismo fee en `doc/INTEGRATION.md`
  (guía pública de integración, sección de Endpoints Reference o una nueva
  subsección de Pricing/Fees), describiendo el campo `protocolFeeUsdc` y el
  nuevo `feeRatePercent` que devuelve `POST /orchestrate/plan` (y su espejo
  ya existente en la respuesta de `/orchestrate` y `/orchestrate/execute`,
  campo `protocolFeeUsdc`), para que un integrador externo pueda leer el fee
  sin tener que inspeccionar el código fuente.

- **AC-5 (Unwanted):** IF `PROTOCOL_FEE_RATE` está mal configurado (fuera de
  `[0, 0.10]`, no numérico), THEN the system SHALL seguir aplicando el
  clamp+fallback ya existente en `getProtocolFeeRate()` (`fee-charge.ts`,
  sin cambios de comportamiento) y `feeRatePercent` en la respuesta del quote
  SHALL reflejar el rate efectivo post-clamp (nunca el valor crudo inválido
  del env) — evita que la transparencia nueva exponga un número engañoso.

## Scope IN
- `src/routes/orchestrate.ts` — agregar `feeRatePercent` al body de
  respuesta de `POST /orchestrate/plan` (handler `/plan`, ~línea 226-236).
- `src/services/fee-charge.ts` — reusar `getProtocolFeeRate()` existente
  (sin nueva lógica de cálculo; solo consumir el valor ya clampeado).
- `src/types/index.ts` — si `OrchestratePlanResult` u otro tipo de respuesta
  pública necesita el campo tipado (evaluar en F2 si conviene en el tipo
  interno o solo en el shape de respuesta del route).
- `README.md` — sección de fee/Business Model (existe una tabla "Business
  Model" — ver `.nexus/project-context.md` líneas 239-246 como referencia
  del contenido hoy en el proyecto raíz; el README del repo debe reflejar lo
  mismo con más detalle).
- `doc/INTEGRATION.md` — nueva subsección o ampliación de una existente
  documentando el fee.
- Tests: al menos 1 test que cubra AC-1/AC-2 (respuesta de `/plan` incluye
  `feeRatePercent` correcto en `ready`, ausente/0 en early-returns).

## Scope OUT
- **NO** cambiar la tasa del fee (sigue 1% default, `PROTOCOL_FEE_RATE`).
- **NO** cambiar la base de cálculo del fee (ya es cost-based desde el
  WKH-132 anterior/DONE — fuera de scope reabrir esa lógica).
- **NO** tocar `POST /orchestrate` (endpoint atómico) ni
  `POST /orchestrate/execute` — ya devuelven `protocolFeeUsdc` (monto); si
  se decide agregarles también `feeRatePercent` por consistencia, es una
  decisión de Architect en F2 a marcar explícitamente (hoy el pedido del
  humano habla de "la respuesta del quote", singularizando `/plan`).
- **NO** tocar `POST /compose` (tiene su propio protocol fee real desde
  WKH-118, fuera de scope de esta HU centrada en orchestrate).
- **NO** cambios en `doc/api reference` fuera de `README.md` + `INTEGRATION.md`
  salvo que Architect detecte otro doc público relevante (p.ej.
  `doc/passport-onboarding.md`) — no se agrega proactivamente.
- **NO** exponer `PROTOCOL_FEE_RATE` crudo del env en ningún endpoint
  público sin pasar por `getProtocolFeeRate()` (evita bypass del clamp).

## Decisiones técnicas (DT-N)
- **DT-1:** El nuevo campo se llama `feeRatePercent` (número, ej. `1` =
  1%), NO `feeRate` (podría confundirse con una fracción `0.01`) ni
  `protocolFeeRate` (redundante con el prefijo `protocolFeeUsdc` ya
  existente en el mismo objeto). Naming a confirmar/ajustar libremente por
  Architect en F2 si hay una convención más consistente con el resto del
  contrato de `/plan`.
- **DT-2:** Única fuente de verdad: `getProtocolFeeRate()` (fracción,
  `fee-charge.ts`). El campo `feeRatePercent` se deriva con
  `getProtocolFeeRate() * 100` en el momento de construir la respuesta —
  NUNCA se recalcula de forma independiente ni se hardcodea, para que no
  pueda driftear de `protocolFeeUsdc` (que también usa
  `getProtocolFeeRate()` indirectamente vía `chargeProtocolFee`/
  `quoteMaxCostUsdc` en `orchestrate.ts`).
- **DT-3:** La documentación (README + INTEGRATION.md) describe el
  *default* (1%) y el mecanismo de override (env var), pero remite al
  campo `feeRatePercent` del quote como la fuente de verdad en runtime —
  evita que la doc quede desactualizada si un operador cambia el env.

## Constraint Directives (CD-N)
- **CD-1:** PROHIBIDO introducir un segundo cálculo o constante del fee
  rate fuera de `getProtocolFeeRate()` (`fee-charge.ts`). Cualquier lugar
  nuevo que necesite el rate lo importa de ahí.
- **CD-2:** PROHIBIDO cambiar el valor por defecto del fee (1%,
  `PROTOCOL_FEE_RATE`) o su rango de clamp `[0, 0.10]` como parte de esta
  HU — es una HU de *transparencia*, no de *pricing*.
- **CD-3:** OBLIGATORIO que `feeRatePercent` en la respuesta de `/plan`
  sea consistente con `protocolFeeUsdc` y `totalCostUsdc` del mismo body
  (es decir, `protocolFeeUsdc ≈ totalCostUsdc * (feeRatePercent / 100)`
  dentro de tolerancia de redondeo) — si Adversary Review encuentra un
  caso donde diverjan, es BLOQUEANTE.
- **CD-4:** PROHIBIDO romper compatibilidad hacia atrás del body de
  `/plan`: `feeRatePercent` es un campo ADITIVO; ningún campo existente
  (`protocolFeeUsdc`, `maxQuotedCostUsdc`, `totalCostUsdc`, etc.) cambia de
  nombre, tipo o semántica.

## Missing Inputs
- `[NEEDS CLARIFICATION]` (no bloqueante para F2, sí para el humano antes
  de mergear PR): el ID de ticket `WKH-132` colisiona con una HU ya DONE
  (ver nota de numeración arriba). Confirmar ID correcto en el tracker
  externo.
- `[TBD en F2]`: si `feeRatePercent` también debe agregarse a
  `POST /orchestrate` y `POST /orchestrate/execute` por consistencia del
  contrato entre los 3 endpoints, o si queda deliberadamente solo en
  `/plan` (el pedido original dice "en la respuesta del quote", que es
  específicamente `/plan`). Decisión de Architect.
- `[TBD en F2]`: naming final de `feeRatePercent` (DT-1) — Architect puede
  ajustarlo si detecta una convención de naming distinta en el resto del
  contrato público.

## Análisis de paralelismo
- **No bloquea** a otras HUs del roadmap. Es Wave 0 del
  `attack-plan-2026-07.md`, junto con WKH-133 (reputation write-back
  ERC-8004) y WKH-134 (SDK + self-serve publish) — las tres son
  independientes entre sí y **corren en paralelo** sin dependencias
  cruzadas (mismo doc: "Wave 0 — Quick wins... independientes, casi en
  paralelo").
- **No depende de** ninguna HU en curso. Toca únicamente
  `src/routes/orchestrate.ts` + docs, que no colisiona con el scope de
  WKH-133 (contratos ERC-8004 / `a2a_events`) ni WKH-134 (SDK nuevo
  paquete). Riesgo de conflicto de merge: bajo (archivos distintos).
