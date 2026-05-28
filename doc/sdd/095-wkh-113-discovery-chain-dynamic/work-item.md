# Work Item — [WKH-113] [BASE-08] discovery chain validation dinámica + compose chain-flow (outbound settle real en las 3 chains)

> Hija del epic WKH-103 "BASE port". Hermana de WKH-111 (BASE-06, inbound chain-aware, DONE) y WKH-112 (BASE-07, outbound `downstream-payment.ts` chain-aware, DONE).
>
> WKH-111 hizo chain-aware el **cobro inbound** (3 chains, probado onchain). WKH-112
> hizo chain-aware el **settle outbound** dentro de `downstream-payment.ts`. Pero el
> outbound real a sub-agentes en Base/Kite **sigue roto** porque el `agent.payment`
> que llega a ese módulo nunca trae una chain ≠ avalanche: dos gates upstream
> (allowlist hardcodeada en discovery + chain hardcodeada en el endpoint
> `getAgent` de wasiai-v2) la borran o la sobrescriben antes de llegar al settle.
> WKH-112 NO lo detectó porque sus unit tests mockeaban `agent.payment` directo
> (gap de scoping confirmado en F0). Esta HU cierra el camino completo
> discovery → compose → downstream para que el `ChainKey` real del agente llegue
> intacto al settle de WKH-112.

## Resumen

Hacer que la chain real de cada sub-agente fluya, **sin hardcode**, desde discovery
hasta el settle outbound, habilitando pago downstream verificable onchain en las 3
chains (`avalanche-fuji`, `base-sepolia`, `kite-ozone-testnet`).

Dos cambios:

1. **Discovery — validación dinámica de chain** (`src/services/discovery.ts`):
   reemplazar el `Set` hardcodeado `ALLOWED_CHAIN_VALUES` (`:56-63`) por una
   validación derivada del chain-resolver (`normalizeChainSlug`) y/o de las chains
   inicializadas en el registry de adapters (`getInitializedChainKeys()`), de modo
   que `readPayment` acepte cualquier chain que el gateway sepa pagar — incluyendo
   `base-sepolia`/`base-mainnet`/`avalanche-fuji` — y siga rechazando chains
   desconocidas (defensa SEC-AR BLQ-MED-1).

2. **Compose — resolución de agente que preserva la chain real**
   (`src/services/compose.ts` `resolveAgent`): hoy resuelve vía
   `discoveryService.getAgent(slug)` que pega al endpoint `GET /api/v1/agents/{slug}`
   de wasiai-v2, el cual **hardcodea `chain: CHAIN_NAME` (=avalanche) e ignora la
   columna `chain` de la fila** (`wasiai-v2 agents/[slug]/route.ts:95`). El endpoint
   `GET /api/v1/capabilities` (usado por `discover`) **sí** emite la chain real
   per-row (`capabilities/route.ts:185`). La HU hace que la chain de pago resuelta
   por compose provenga del path que tiene la chain real (capabilities/discover),
   no del path que la sobrescribe (getAgent) — **sin modificar wasiai-v2**.

**Para quién**: el gateway WasiAI A2A actuando como pagador (operator wallet) a
sub-agentes que cobran en distintas chains durante `/compose` y `/orchestrate`.
**Por qué**: completar el epic BASE port end-to-end. Hoy el gateway COBRA en 3
chains pero solo PAGA outbound a Avalanche, porque la chain real nunca llega al
módulo de settle (ya chain-aware desde WKH-112). Objetivo del humano (textual):
"100%, código de producción, que funcione SIN HARDCODE y que funcione en las 3
chains" (outbound).

## Sizing

- **SDD_MODE**: full (QUALITY)
- **Estimación**: M
- **Branch sugerido**: `feat/095-wkh-113-discovery-chain-dynamic`
- **Metodología**: QUALITY — NO bajar a FAST.
- **Skills de dominio (máx 2)**: `multi-chain-adapter-routing`, `x402-eip3009-payments`.

### Justificación del sizing (Smart Sizing → QUALITY)

1. **Superficie de pago real onchain (outbound)**: el resultado directo del cambio
   es que el operator wallet firma+settlea USDC/PYUSD a terceros en chains que hoy
   no pagaba. Un bug en la resolución de chain = fondos a la chain equivocada,
   cross-chain confusion, o regresión que rompe Avalanche/Kite (que hoy SÍ funcionan).
2. **Toca defensa de seguridad explícita**: el `ALLOWED_CHAIN_VALUES` no es un
   hardcode "perezoso" — es una mitigación documentada (`discovery.ts:37-54`,
   SEC-AR-2026-04-28 BLQ-MED-1) contra un registry comprometido que exponga una
   chain exótica para bypassear el guard de pago. Aflojarla mal reabre ese vector.
   Requiere AR/CR que ataquen específicamente la nueva validación.
3. **Riesgo de regresión crítica**: el path Avalanche y Kite son los únicos
   outbound funcionales hoy; deben quedar funcionalmente idénticos (CD-2).
4. **Decisión de diseño no trivial sobre wiring cross-repo**: la factibilidad
   a2a-only depende de cambiar cómo compose resuelve la chain (capabilities vs
   getAgent), una decisión de arquitectura con alternativas reales (ver DT-1/DT-2)
   que requiere SDD + adversarial, no un patch aislado.

No es FAST (no es patch aislado, toca seguridad + dinero) ni LAUNCH (no es
greenfield): es un **evolutivo sobre superficie crítica de pagos + discovery**, caso
QUALITY canónico — mismo criterio que WKH-111/WKH-112.

## F0 — Hallazgos de grounding (verificados archivo:línea, 2026-05-27)

### wasiai-a2a (este repo)

| # | Hallazgo | Evidencia |
|---|----------|-----------|
| H1 | **GATE 1 — allowlist hardcodeada**: `ALLOWED_CHAIN_VALUES` es un `Set` literal con `{avalanche, avalanche-testnet, avalanche-mainnet, kite-ozone-testnet, kite-mainnet}`. **NO** incluye `base-sepolia`, `base-mainnet`, ni `avalanche-fuji`, ni los chainIds. | `src/services/discovery.ts:56-63` |
| H2 | `readPayment` retorna `undefined` si `chainRaw` no está en el set (`if (!ALLOWED_CHAIN_VALUES.has(chainRaw)) return undefined`). Consecuencia: `agent.payment = undefined` (`mapAgent` `:329`). | `src/services/discovery.ts:88-95`, `:329` |
| H3 | Con `agent.payment` ausente, `signAndSettleDownstream` skip en el step 2 con `NO_PAYMENT_FIELD` → **cero tx outbound** para Base. La maquinaria de settle (WKH-112) nunca se ejerce. | `src/lib/downstream-payment.ts:127-133` |
| H4 | `readPayment` normaliza `avalanche-testnet`/`avalanche-mainnet` → `avalanche` y deja pasar el resto sin tocar. La normalización a `ChainKey` real la hace después `normalizeChainSlug` en downstream. | `src/services/discovery.ts:97-110` |
| H5 | **GATE 2 (síntoma a2a)**: `compose.resolveAgent` resuelve PRIMERO vía `discoveryService.getAgent(slug, registry)` y solo cae a `discover()` si `getAgent` devuelve `null`. Normalmente `getAgent` gana. | `src/services/compose.ts:328-337` |
| H6 | `getAgent` pega al `agentEndpoint` del registry (= v2 `GET /api/v1/agents/{slug}`) y mapea con `mapAgent`. La chain del `payment` sale de lo que ese endpoint devuelva. | `src/services/discovery.ts:336-375` |
| H7 | `discover()` → `queryRegistry` pega al `discoveryEndpoint` (= v2 `GET /api/v1/capabilities`) y mapea con el MISMO `mapAgent`/`readPayment`. La diferencia con getAgent es **solo la fuente de datos** (qué chain trae cada endpoint), no el mapeo. | `src/services/discovery.ts:220-293` |
| H8 | El settle downstream ya es chain-aware (WKH-112): resuelve `chainKey = normalizeChainSlug(agent.payment.chain)` y rutea a `getPaymentAdapter(chainKey)`. Si `agent.payment.chain` llega como `base-sepolia`, funciona; el problema es que NO llega. | `src/lib/downstream-payment.ts:151-164` |
| H9 | `normalizeChainSlug` YA mapea `base-sepolia`/`base-testnet`/`84532`/`base`/`8453`/`avalanche-fuji`/`fuji`/`43113`/kite slugs → `ChainKey`, y devuelve `undefined` para slug desconocido (fail-loud). Es el primitivo natural para la validación dinámica. | `src/adapters/chain-resolver.ts:20-66` |
| H10 | `getInitializedChainKeys()` devuelve las chains realmente inicializadas en el registry de adapters (en prod las 3 testnets — ver WKH-112 Capa D). Candidato para "validar contra lo que el gateway sabe pagar". | `src/adapters/registry.ts:226-228`; `SUPPORTED_CHAINS` `:25-32` incluye base-sepolia/base-mainnet |
| H11 | **payTo del settle outbound**: `downstream-payment.ts` usa `agent.payment.contract` como destinatario (`validatePayTo(agent.payment.contract)` `:167`, luego `to: payToCheck.addr` `:280`). `readPayment` lo llena con `obj.contract` (`discovery.ts:88,108`). | `src/lib/downstream-payment.ts:167,280`; `src/services/discovery.ts:88,108` |
| H12 | **Riesgo payTo**: el path inbound de compose usa `metadata.payTo ?? metadata.payment.contract` (`compose.ts:370-380`), mientras el downstream usa `payment.contract`. Hay que confirmar en F2 qué address es el destinatario correcto del pago al sub-agente (ver H14/H15). | `src/services/compose.ts:370-380` vs `src/lib/downstream-payment.ts:167,280` |
| H13 | `compose.invokeAgent` ya usa `agent.payment?.chain` + `normalizeChainSlug` para el selector de facilitator Base (telemetría, `:416-420`). Confirma que el campo es el canal de chain esperado por compose. | `src/services/compose.ts:416-420` |

### wasiai-v2 (repo consumidor — NO se modifica en esta HU)

| # | Hallazgo | Evidencia |
|---|----------|-----------|
| H14 | **GATE 2 (raíz)**: `GET /api/v1/agents/{slug}` hardcodea `chain: CHAIN_NAME` (=avalanche) e `chain_id: CHAIN_ID`, ignorando la columna `chain` de la fila (que SÍ se lee de Supabase, `:38-40`). También emite `payment.contract = getMarketplaceAddress(CHAIN_ID)` (contrato del marketplace, no payTo per-agente). | `wasiai-v2 src/app/api/v1/agents/[slug]/route.ts:83,95-96,98-104` |
| H15 | `GET /api/v1/capabilities` **SÍ** emite la chain real per-row: `payment.chain = a.chain ?? CHAIN_NAME` y `payment.asset = a.currency ?? 'USDC'`. Pero `payment.contract` también es `getMarketplaceAddress(CHAIN_ID)` (no per-agent payTo). | `wasiai-v2 src/app/api/v1/capabilities/route.ts:179-188` |
| H16 | Data prod (input de investigación, no re-verificada onchain en F0): agentes en `avalanche` y `kite-ozone-testnet`; **0 agentes en `base-sepolia` hoy**. Para probar el outbound Base hay que crear/seed un agente base-sepolia (ver Plan de validación). | input WKH-113 + `capabilities/route.ts:185` |

### Conclusión F0 — VEREDICTO DE FACTIBILIDAD

**Arreglar GATE 1 (allowlist) es NECESARIO pero NO SUFICIENTE.** Aunque
`readPayment` acepte `base-sepolia`, si compose resuelve el agente vía `getAgent`
(H5/H6), el endpoint v2 `GET /api/v1/agents/{slug}` ya sobrescribió la chain a
`avalanche` (H14) — el settle se haría (mal) contra Avalanche, no contra Base.

**Es FACTIBLE arreglarlo a2a-only (sin tocar wasiai-v2)**: el endpoint
`capabilities` que alimenta `discover()` **sí** trae la chain real per-agente (H15).
Si compose deriva la chain de pago del agente desde el path capabilities/discover
(que tiene la chain real) en lugar de getAgent (que la hardcodea), el `ChainKey`
real llega al settle ya chain-aware de WKH-112. `resolveAgent` ya tiene un fallback
a `discover()` (H5) — el diseño de F2 decide si se invierte la prioridad de
resolución, se hace un merge selectivo del campo `payment`/`chain` desde discover, o
se introduce un getAgent chain-aware. **Esto es scope wasiai-a2a puro.**

**Dependencia wasiai-v2 — Scope OUT de esta HU, sub-tarea separada**: dos campos
quedan mal en el endpoint v2 y NO se arreglan acá (ver Scope OUT y DT-3):
1. `GET /api/v1/agents/{slug}` debería emitir `a.chain ?? CHAIN_NAME` (igual que
   capabilities) en vez de hardcodear avalanche — fix correcto a futuro pero **no
   requerido** para esta HU si compose deja de depender de ese endpoint para la chain.
2. El `payTo` del settle outbound: hoy ambos endpoints v2 emiten el contrato del
   marketplace (`getMarketplaceAddress`) como `payment.contract`, no el wallet
   per-agente. **Esto afecta a las 3 chains por igual y NO es un bug nuevo de Base**
   — el outbound Avalanche/Kite que "funciona" hoy también settlea contra esa
   address. F2 debe confirmar si el destinatario actual es el correcto (H11/H12) o
   si requiere fix en v2 (sub-tarea separada). **Marcado `[NEEDS CLARIFICATION]`.**

## Acceptance Criteria (EARS)

- **AC-1** (Ubiquitous — validación dinámica, PROHIBIDO allowlist hardcodeado): the
  system SHALL validar la chain de `agent.payment` derivando el conjunto de chains
  aceptadas dinámicamente del chain-resolver (`normalizeChainSlug`) y/o de
  `getInitializedChainKeys()` — PROHIBIDO mantener el `Set` literal
  `ALLOWED_CHAIN_VALUES` (`discovery.ts:56-63`) ni ningún listado hardcodeado de
  slugs de chain como fuente de verdad de qué chains se aceptan.

- **AC-2** (Ubiquitous — CERO regresión Avalanche/Kite): WHEN un sub-agente cobra en
  `avalanche`/`avalanche-testnet`/`avalanche-mainnet` o `kite-ozone-testnet`/
  `kite-mainnet`, THEN the system SHALL producir un `agent.payment` con la MISMA
  `chain` normalizada que produce hoy (avalanche → `avalanche`; kite pass-through) y
  el settle outbound SHALL comportarse funcionalmente idéntico. La suite de tests
  existente SHALL permanecer verde. Cualquier diff observable en el path
  Avalanche/Kite es **BLOQUEANTE**.

- **AC-3** (Event-driven — la chain real de Base llega a compose): WHEN `/compose`
  (o `/orchestrate` vía compose) resuelve un sub-agente cuya fila en el registry
  declara `chain = base-sepolia`, THEN el `agent.payment.chain` que compose pasa a
  `signAndSettleDownstream` SHALL resolver a `base-sepolia` (no `avalanche`),
  derivado del path de discovery que expone la chain real (capabilities/discover),
  PROHIBIDO que el endpoint que hardcodea avalanche (getAgent) determine la chain
  de pago.

- **AC-4** (Event-driven — settle outbound real en Base): WHEN compose paga a un
  sub-agente `base-sepolia` con flag downstream activo y operator funded, THEN the
  system SHALL firmar+settlear vía el adapter de Base (`network = eip155:84532`),
  retornando un `DownstreamResult` con `txHash` verificable en
  `sepolia.basescan.org` y `settledAmount` en los decimales del token del adapter.

- **AC-5** (Unwanted — chain desconocida → rechazo, sin cross-chain): IF
  `agent.payment.chain` NO resuelve a un `ChainKey` reconocido por el chain-resolver
  (registry comprometido / slug exótico), THEN the system SHALL rechazar el
  `payment` (devolver `undefined` en `readPayment`, preservando la defensa
  SEC-AR BLQ-MED-1) — PROHIBIDO aceptar una chain desconocida ni normalizarla a un
  default. La defensa-en-profundidad contra registry comprometido SHALL conservarse.

- **AC-6** (State-driven — coherencia de chain extremo a extremo): WHILE se procesa
  el pago a un agente cuya chain real es `K`, the system SHALL usar `K` de forma
  coherente desde `readPayment` (chain validada) → `agent.payment.chain` →
  `normalizeChainSlug` (downstream) → `getPaymentAdapter(K)`. PROHIBIDO que un
  endpoint intermedio reemplace `K` por otra chain.

- **AC-7** (Optional/Unwanted — efecto colateral seguro sobre `avalanche-fuji`):
  WHERE existan agentes que declaran `chain = avalanche-fuji` (hoy con
  `payment = null` por estar fuera del allowlist, H1), WHEN la validación dinámica
  los acepte, THEN the system SHALL producir `agent.payment` con chain resoluble a
  `avalanche-fuji` y el settle SHALL rutear al adapter Fuji (el mismo USDC/network
  que `avalanche`) — sin enviar fondos a una chain distinta de la declarada.
  [TBD F2: confirmar que habilitar `avalanche-fuji` es deseado/seguro — es la MISMA
  red de pago que el path avalanche actual (USDC Fuji `eip155:43113`), por lo que el
  riesgo es "más agentes ahora cobrables" en una chain ya soportada, no una chain
  nueva no probada. Architect/Adversary confirman que no abre un vector de pago no
  intencional.]

## Scope IN

- `src/services/discovery.ts` — **núcleo (1)**:
  - Reemplazar `ALLOWED_CHAIN_VALUES` (`:56-63`) y el check `:92-95` por validación
    dinámica vía `normalizeChainSlug` (resolver puro, sin importar el registry de
    adapters para no acoplar discovery a la init de adapters) y/o
    `getInitializedChainKeys()`. [TBD F2: cuál de las dos fuentes — resolver puro vs
    chains inicializadas — es la correcta; ver DT-4.]
  - Conservar la semántica de `readPayment`: campos críticos ausentes → `undefined`;
    chain desconocida → `undefined` (AC-5). Conservar la normalización avalanche → `avalanche`.
- `src/services/compose.ts` — **núcleo (2)**: `resolveAgent` (`:328-337`) y/o el
  punto donde se determina `agent.payment.chain` para el settle. Hacer que la chain
  de pago provenga del path que tiene la chain real (capabilities/discover), no de
  getAgent. [TBD F2: estrategia exacta — invertir prioridad de resolución, merge
  selectivo del `payment` desde discover, o getAgent chain-aware vía discover
  fallback — ver DT-1/DT-2.]
- Tests asociados (los que cubran discovery `readPayment` y compose `resolveAgent`).
  **CRÍTICO**: los nuevos tests NO deben mockear `agent.payment` directo (ese fue el
  gap de scoping de WKH-112, H del input). Deben ejercer el path real
  discovery → compose para una fixture con `chain = base-sepolia` en la respuesta del
  registry, verificando que la chain sobrevive hasta el borde del settle.

## Scope OUT

- **wasiai-v2 (repo consumidor)** — NO se modifica en esta HU. Dos fixes quedan como
  **sub-tarea separada** (no bloqueante de WKH-113 dado el veredicto a2a-only):
  - `GET /api/v1/agents/{slug}` que hardcodea `chain: CHAIN_NAME` (H14) — fix
    correcto a futuro (emitir `a.chain ?? CHAIN_NAME` como capabilities), pero NO
    requerido si compose deja de depender de ese endpoint para la chain.
  - `payment.contract = getMarketplaceAddress` como payTo (H14/H15) — afecta las 3
    chains por igual, no es bug nuevo de Base. **`[NEEDS CLARIFICATION]`** si el
    destinatario actual del settle outbound es correcto (ver DT-3 + Missing Inputs).
- **`src/lib/downstream-payment.ts`** — YA chain-aware (WKH-112, DONE). NO se
  re-arquitecta; esta HU solo garantiza que reciba la chain correcta. Tocarlo solo
  si el wiring lo exige (no esperado).
- **Path inbound** (`x402.ts`, `a2a-key.ts`) — YA resuelto en WKH-111. NO se toca.
- **Mainnet de cualquier chain** — solo testnets (`avalanche-fuji`, `base-sepolia`,
  `kite-ozone-testnet`). `base-mainnet`/`avalanche-mainnet`/`kite-mainnet` fuera de
  alcance (la validación dinámica los aceptará si están inicializados, pero no se
  prueban ni activan acá).
- **Modelo a2a-key / budget / debit** — ortogonal; no se toca.
- **Cómo wasiai-v2 expone `chain` por agente en la DB** — pass-through; se consume
  tal cual venga del endpoint que tenga la chain real.

## Decisiones técnicas (DT-N)

- **DT-1** — *Fuente de la chain de pago en compose* [a cerrar en F2]: opciones
  (a) invertir la prioridad de `resolveAgent` para usar `discover()`/capabilities
  como fuente de la chain de pago; (b) resolver vía getAgent (para metadata completa)
  pero hidratar `payment.chain` desde el path capabilities; (c) un getAgent
  chain-aware que detecte la chain real por otro medio. Preferencia F1: opción que
  NO toque wasiai-v2 y NO regrese Avalanche/Kite. Architect decide y justifica.
- **DT-2** — *Mínima superficie de cambio*: preferir cambios localizados en
  `discovery.ts` + `compose.resolveAgent`, sin cambiar la firma pública de
  `signAndSettleDownstream` (que ya consume `agent.payment.chain`, H8). El downstream
  no debería necesitar cambios.
- **DT-3** — *payTo del settle outbound* `[NEEDS CLARIFICATION]` [a cerrar en F2 con
  el humano]: el destinatario actual del settle downstream es
  `agent.payment.contract` = contrato del marketplace v2 (H11/H14/H15), no un wallet
  per-agente. Esto NO es un bug introducido por esta HU (afecta las 3 chains hoy),
  pero F2 debe confirmar si el pago al sub-agente debe ir al marketplace (modelo
  de revenue centralizado) o a un payTo per-agente. Si requiere payTo per-agente →
  sub-tarea wasiai-v2 separada.
- **DT-4** — *Validación dinámica: resolver puro vs chains inicializadas* [a cerrar
  en F2]: `normalizeChainSlug` (resolver puro, no acopla discovery a la init de
  adapters, acepta cualquier chain que el resolver conozca) vs `getInitializedChainKeys()`
  (estricto: solo chains realmente inicializadas en el proceso). Trade-off: el
  resolver puro es más simple y desacoplado pero podría aceptar una chain conocida
  no inicializada (que luego el downstream skip con `CHAIN_NOT_SUPPORTED` —
  fail-loud aguas abajo, ya cubierto por WKH-112). Preferencia F1: resolver puro en
  discovery + el guard de inicialización vive en downstream (separación de
  responsabilidades). Architect decide.
- **DT-5** — *Preservar defensa SEC-AR BLQ-MED-1*: la validación dinámica DEBE
  seguir rechazando chains desconocidas (slug que `normalizeChainSlug` no reconoce →
  `undefined` → `readPayment` retorna `undefined`). El objetivo es ampliar el
  conjunto aceptado a "todas las chains que el gateway sabe pagar", NO eliminar la
  validación.

## Constraint Directives (CD-N)

- **CD-1** (OBLIGATORIO — sin hardcode de chains): PROHIBIDO mantener
  `ALLOWED_CHAIN_VALUES` ni ningún `Set`/array literal de slugs de chain como fuente
  de verdad de qué chains acepta discovery. La validación DEBE derivarse del
  chain-resolver y/o de las chains inicializadas. (Los aliases dentro de
  `chain-resolver.ts` NO son hardcode de esta HU: son el mapeo canónico
  slug→ChainKey, fuente única de verdad reutilizada.)
- **CD-2** (OBLIGATORIO — cero regresión Avalanche/Kite): el `agent.payment`
  producido para agentes Avalanche/Kite DEBE ser idéntico al actual (misma `chain`
  normalizada, mismo `contract`/`asset`/`method`), y el settle outbound de esas
  chains DEBE permanecer funcionalmente idéntico. La suite de tests existente DEBE
  seguir verde. Cualquier diff observable es **BLOQUEANTE**.
- **CD-3** (OBLIGATORIO — solo viem, PROHIBIDO ethers.js): cualquier interacción
  onchain pasa por el adapter (viem v2). PROHIBIDO introducir ethers. (Esta HU no
  debería tocar firma onchain directamente; aplica por si el wiring lo roza.)
- **CD-4** (OBLIGATORIO — TypeScript strict): PROHIBIDO `any` explícito y
  `as unknown`. La chain validada se tipa con `ChainKey` donde corresponda (no
  `string` suelto cuando ya está normalizada).
- **CD-5** (OBLIGATORIO — no silent cross-chain): PROHIBIDO que la chain de pago
  resuelta por compose difiera de la chain real declarada por el agente. Si la chain
  real no se puede determinar con confianza, DEBE preferirse fail-loud (skip
  `CHAIN_NOT_SUPPORTED` aguas abajo) antes que asumir avalanche.
- **CD-6** (OBLIGATORIO — no modificar wasiai-v2 en esta HU): el cambio es
  wasiai-a2a puro. Cualquier necesidad de tocar wasiai-v2 (DT-3) se documenta como
  sub-tarea separada y se escala al humano, NO se incluye en esta HU.

## Análisis de paralelismo / waves

- **¿Bloquea otras HU?** Cierra el último gap funcional del epic BASE port para el
  outbound (las 3 chains pagables end-to-end). No bloquea HUs de otras superficies.
- **¿Puede ir en paralelo con otra WKH?** El cambio se concentra en
  `src/services/discovery.ts` + `src/services/compose.ts` (`resolveAgent`). Colisiona
  con cualquier HU que toque esos dos archivos; NO colisiona con `downstream-payment.ts`
  (WKH-112, DONE), middleware inbound (WKH-111, DONE), ni budget/a2a-key.
- **Waves sugeridas (orientativo para Architect, no vinculante)**:
  - **W1**: discovery — validación dinámica reemplazando `ALLOWED_CHAIN_VALUES`
    (AC-1, AC-5, CD-1, DT-4/DT-5). Tests unitarios de `readPayment`: acepta
    base-sepolia/avalanche-fuji, rechaza slug desconocido, preserva normalización
    avalanche y pass-through kite. CERO regresión (AC-2).
  - **W2**: compose — `resolveAgent`/resolución de chain desde el path con chain real
    (AC-3, AC-6, CD-5, DT-1/DT-2). Tests de integración del path
    discovery → compose con fixture `chain = base-sepolia` (sin mockear
    `agent.payment` directo — fix del gap WKH-112). Verificar que la chain llega al
    borde del settle.
  - **W3**: regresión completa (suite verde, CD-2) + evidencia onchain real en las 3
    chains vía smoke (la corre el humano / QA con operator funded — ver Plan de
    validación).

## Plan de validación — tx outbound real en las 3 chains

> El settle onchain real lo ejecuta el humano/QA fuera del pipeline automático
> (requiere operator funded + agente invocable). F2/F3 dejan el código y los tests
> unit/integration; la evidencia onchain es la prueba final de "funciona en las 3".

**Setup requerido**:

1. **Env**: `WASIAI_A2A_CHAINS` (o `WASIAI_A2A_CHAIN`) DEBE incluir `base-sepolia`,
   `avalanche-fuji` y `kite-ozone-testnet` para que los 3 bundles estén
   inicializados (`getInitializedChainKeys()` → 3). En prod las 3 testnets ya están
   inicializadas (WKH-112 Capa D). `WASIAI_DOWNSTREAM_X402=true`. RPCs:
   `BASE_TESTNET_RPC_URL`, `FUJI_RPC_URL`, `KITE_RPC_URL`. `OPERATOR_PRIVATE_KEY`
   funded en las 3 (operator ya funded — WKH-112 H15).
2. **Agente base-sepolia**: hoy hay **0 agentes en `base-sepolia`** en el marketplace
   (H16). Para probar AC-4 hace falta:
   - Un agente con la columna `chain = base-sepolia` (y `currency`/payTo coherentes)
     expuesto por el endpoint capabilities con `payment.chain = base-sepolia` (H15).
   - El agente debe ser **invocable** (endpoint que responde 200 a la invocación de
     compose) para que el step se ejecute y dispare el settle downstream.
   - **[NEEDS CLARIFICATION operacional]**: ¿se seedea un agente base-sepolia de
     prueba en wasiai-v2, o existe uno disponible? Si no hay agente invocable
     base-sepolia, la prueba onchain de Base queda como evidencia diferida (el
     código y los tests integration con fixture sí validan el flujo).
3. **Evidencia esperada por chain** (mismo formato que WKH-107/WKH-112):
   - `avalanche-fuji`: tx hash en snowtrace testnet, status 0x1 (regresión — debe
     seguir funcionando).
   - `kite-ozone-testnet`: tx hash en kitescan testnet, status 0x1 (regresión).
   - `base-sepolia`: tx hash en `sepolia.basescan.org`, status 0x1 (**nuevo** — el
     objetivo de la HU).
4. **Validación de no-regresión automatizable** (pipeline): suite completa verde +
   tests integration discovery → compose con fixtures de las 3 chains demostrando que
   `agent.payment.chain` sobrevive correctamente hasta el borde del settle.

## Missing Inputs

- **`[NEEDS CLARIFICATION]`** (DT-3, escalar al humano en F2): ¿el settle outbound al
  sub-agente debe ir al contrato del marketplace v2 (`getMarketplaceAddress`, modelo
  actual de las 3 chains) o a un wallet payTo per-agente? Si es per-agente → requiere
  fix en wasiai-v2 (sub-tarea separada, fuera de esta HU). Este punto NO bloquea la
  habilitación de Base (el comportamiento es el mismo que Avalanche/Kite hoy).
- **`[NEEDS CLARIFICATION]`** (operacional, Plan de validación paso 2): ¿hay un agente
  invocable en `base-sepolia` para la prueba onchain, o se seedea uno? Sin él, la
  evidencia onchain de Base queda diferida; el flujo se valida igual con tests
  integration + fixture.
- **[resuelto en F2]** DT-1: estrategia exacta de resolución de chain en compose
  (invertir prioridad vs merge selectivo vs getAgent chain-aware).
- **[resuelto en F2]** DT-4: validación dinámica vía resolver puro vs
  `getInitializedChainKeys()`.
- **[resuelto en F2]** AC-7: confirmación de que habilitar `avalanche-fuji` (agentes
  hoy con `payment=null`) es deseado/seguro (misma red de pago que avalanche).
- **[NO bloqueante]** Operator wallet ya funded en las 3 chains (WKH-112 H15).
- **[NO bloqueante]** `WASIAI_A2A_CHAINS` ya incluye las 3 testnets en prod (WKH-112
  Capa D); el SDD documenta el requisito de env.
