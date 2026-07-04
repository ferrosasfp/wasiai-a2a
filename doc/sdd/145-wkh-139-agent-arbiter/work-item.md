# Work Item — [WKH-139 v2] Agente-Árbitro Autónomo de Disputas

> **Nota de redefinición (2026-07-04)**: esta HU **reemplaza el enfoque** de la
> WKH-139 original (fila 141 de `_INDEX.md`, `DEFERRED`, branch
> `feat/141-wkh-139-dispute-window`). La v1 proponía un resolver **humano**
> único y quedó bloqueada por 4 `[NEEDS CLARIFICATION]` sin ratificar. La v2
> (esta HU) redefine el problema por directiva explícita del orquestador:
> **la resolución de disputas NO puede depender de un humano** (cuello de
> botella) — debe ser un **agente-árbitro autónomo**, **rules-first**
> (determinístico, anclado en evidencia verificable), con el LLM reservado
> **solo** para casos genuinamente ambiguos (nunca como juez ciego de plata).

## Resumen

Hoy, cuando un pago entre un Buyer y un Seller queda en disputa (el Seller
dice haber entregado, el Buyer dice que no, o el uso reportado no coincide
con lo esperado), no existe ningún mecanismo de resolución — el fondeo queda
retenido indefinidamente o se resuelve fuera de banda. Esta HU construye un
**agente-árbitro autónomo** que decide el desenlace de una disputa
(`release` al Seller, `refund` al Buyer, o `split` parcial) usando **reglas
determinísticas ancladas en la proof-chain de recibos inmutables** (WKH-124)
y el estado del intent de pago en disputa, escalando a un LLM **solo** cuando
la evidencia es genuinamente ambigua — nunca dejando que el LLM mueva fondos
directamente. Alcance: **testnet únicamente**.

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: L (money-path + lógica de decisión + superficie de seguridad crítica — movimiento de fondos autónomo sin humano en el loop)
- **Pipeline**: QUALITY (obligatorio — dinero real en juego, aunque en testnet)
- **Branch sugerido**: `feat/145-wkh-139-agent-arbiter`

---

## F0 — Hallazgos de Grounding (críticos para F2)

1. **El escrow on-chain (WKH-126a/b/c) NO es el primitivo correcto para esta HU.**
   `WasiAIEscrow.sol` (WKH-126a, deployado en Base Sepolia testnet) + su
   integración TS (`src/adapters/escrow-verifier.ts`) implementan un **fondo
   agregado por Agent Key**: el agente deposita en su propia key
   (`Deposited(depositor, keyId, amount)`), y el operador debita con firma
   EIP-712 (`debit(keyId, amount, deadline, signature)`) — el destinatario del
   débito es **el operador**, no un "Seller" contraparte. No hay concepto de
   **hold por-tarea** ni de **dos partes en disputa**. Esto confirma
   exactamente el hallazgo que ya había bloqueado la v1 de esta HU (ver
   `doc/sdd/117-wkh-126-escrow-noncustodial/work-item.md`).

2. **El primitivo correcto es el intent de pago `session` (WKH-135, ya
   mergeado a `main`: `src/services/payment-intent.ts`, `src/routes/payments.ts`).**
   `session` ya tiene la forma de un hold por-tarea de dos partes: el Buyer
   abre con un `deposit` (reserva contra su budget), el Seller acumula
   `vouchers` de uso, y el cierre (`closeSession`) settlea el consumido al
   Seller **y** refundea el residual al Buyer en la misma operación. Esto es
   estructuralmente lo que un árbitro necesita ejecutar como resultado de su
   decisión (release = settle total al Seller, refund = settle cero + refund
   completo, split = settle parcial forzado en lugar de confiar en los
   vouchers reportados por el Seller). **Importante**: el `sdd.md` de WKH-135
   declara explícitamente `intent "escrow"/disputas (WKH-139)` como **Scope
   OUT** de esa HU — confirma que esta funcionalidad es nueva, no reciclada.

3. **La proof-chain de recibos (WKH-124, `src/services/receipt.ts`) es la
   fuente de evidencia verificable.** Cada operación de pago emite un recibo
   HMAC-encadenado (`prev_receipt_hash`) por owner, con `receipt_type`,
   `amount_usd`, `session_id`, `tx_hash`, `counterparty`. El árbitro puede leer
   la cadena de recibos de una `session` (vouchers, settles previos) como
   evidencia tamper-evident sin depender del dicho de ninguna de las partes.

4. **`fee-split.ts` (WKH-136) NO es directamente reusable.** Es un motor de
   splits del **protocol fee** (plataforma/creador/referral) en bps, no del
   monto de settlement entre Buyer y Seller — es una referencia de patrón de
   ingeniería (legs idempotentes, status por-recipient) pero no un componente
   a invocar tal cual para el resultado `split` de una disputa.

5. **No existe hoy ningún estado `disputed` ni tabla/columna relacionada** en
   `a2a_payment_intents` ni en ningún otro lado del código. Es diseño nuevo
   completo a partir de F2.

---

## Acceptance Criteria (EARS)

**AC-1**: WHEN se abre una disputa sobre un `session` payment intent y la
proof-chain de recibos (WKH-124) contiene evidencia inequívoca (p.ej. cero
vouchers registrados sobre un intent vencido, o vouchers verificables que
coinciden exactamente con el reclamo del Seller), THE system SHALL resolver
la disputa de forma autónoma mediante reglas determinísticas, SIN invocar al
LLM.

**AC-2**: IF el motor de reglas determinístico no puede alcanzar una
decisión sin ambigüedad genuina (criterio exacto de ambigüedad — a definir en
F2), THEN THE system SHALL escalar a una decisión asistida por LLM acotada
estrictamente a los tres desenlaces válidos (`release` / `refund` / `split`)
y SHALL NUNCA permitir que el LLM ejecute el movimiento de fondos
directamente — la ejecución siempre pasa por código determinístico.

**AC-3**: WHEN el árbitro alcanza una decisión (rules-based o LLM-escalada),
THE system SHALL ejecutarla a través de los primitivos de settle/refund
existentes de `session` (extendidos según sea necesario para permitir un
monto de settle forzado por el árbitro) y SHALL emitir un recibo inmutable
(patrón WKH-124) documentando el desenlace, la evidencia usada, y si hubo
escalación a LLM (con el razonamiento registrado).

**AC-4**: WHILE un payment intent está en estado `disputed`, THE system
SHALL NOT permitir que el camino normal de cierre/settle (`closeSession`) se
ejecute concurrentemente — previene doble-settlement (misma clase de riesgo
de carrera ya documentada en el auto-blindaje de WKH-135, fix-pack it.4).

**AC-5**: WHERE el árbitro opera en esta HU, THE system SHALL restringir sus
acciones de movimiento de fondos a chain IDs de testnet
(`kite-ozone-testnet`, `avalanche-fuji`, `base-sepolia`) y SHALL NOT operar
sobre chain IDs de mainnet.

**AC-6**: IF el monto en disputa supera un umbral configurable **[NEEDS
CLARIFICATION — ver Missing Inputs (a)]**, THEN THE system SHALL
**[comportamiento exacto bloqueado — depende de la ratificación humana del
modelo de autoridad]**.

---

## Scope IN

- Nuevo estado `disputed` (o equivalente) en la máquina de estados de
  `a2a_payment_intents` (WKH-135) — migración DB reversible.
- Nuevo servicio de árbitro (p.ej. `src/services/arbiter.ts`): motor de
  reglas determinístico que lee `receiptService` (proof-chain) + el registro
  del intent/vouchers.
- Set de reglas deterministas para los casos "obvios" (definidos con
  precisión en F2, no en esta HU).
- Path de escalación a LLM **solo** para casos ambiguos — prompt acotado,
  schema de decisión restringido a los 3 desenlaces, nunca ejecuta fondos.
- Extensión de `payment-intent.ts`/`closeSession` (o función nueva) para
  soportar un monto de settle **forzado por el árbitro** (no derivado
  ciegamente de los vouchers reportados por el Seller).
- Nuevo `receipt_type` para desenlaces de arbitraje (extiende taxonomía de
  WKH-124).
- Endpoint(s) para abrir/consultar disputa bajo `/payments/session/:id/...`
  (rutas exactas a definir en F2).
- Alcance de chains: **testnet únicamente** (`kite-ozone-testnet`,
  `avalanche-fuji`, `base-sepolia`).

## Scope OUT

- **Mainnet** — completamente fuera de esta HU.
- **Disputas sobre `upto`** — v1 acotado a `session` únicamente, salvo que el
  humano ratifique ampliar el alcance (ver Missing Inputs).
- **Modificar `WasiAIEscrow.sol` (WKH-126a) o su ABI** — el contrato on-chain
  no se toca; si en el futuro se requiere un hold on-chain real con
  release/refund/split nativos del contrato, es una HU aparte (requiere
  Foundry/Hardhat, deploy, auditoría).
- **UI/dashboard de revisión o apelación de disputas** — a menos que el
  humano indique lo contrario (ver Missing Inputs (c), path de apelación).
- **Red de árbitros descentralizada / multi-árbitro con votación** — v1 es un
  único servicio de árbitro autónomo (centralizado en el gateway, pero
  rules-first y sin humano en el loop de resolución).
- **Motor de splits de protocol fee (WKH-136, `fee-split.ts`)** — no se
  reutiliza ni se modifica; es un mecanismo distinto (fee, no settlement
  Buyer↔Seller).

---

## Decisiones técnicas (DT-N)

**DT-1**: El primitivo de "hold" sobre el que se construye el árbitro es el
intent `session` de WKH-135 (`src/services/payment-intent.ts`,
`src/routes/payments.ts`), **no** el escrow on-chain de WKH-126a/b/c. Razón:
WKH-126 es un fondo agregado por Agent Key sin concepto de contraparte
Seller ni de hold por-tarea; `session` ya tiene deposit+vouchers+settle con
dos partes. Ver F0 hallazgo #1-#2.

**DT-2**: La única fuente de evidencia para las reglas determinísticas en
esta HU es la proof-chain de `a2a_receipts` (WKH-124) más el estado propio
del intent (vouchers, deposit, `expires_at`). No se inventa ningún canal de
evidencia adicional (p.ej. inputs off-chain declarados libremente por las
partes) hasta que F2 resuelva el Missing Input (b).

**DT-3**: El LLM, cuando se invoca, **nunca** tiene autoridad de ejecución
directa sobre fondos — solo produce una recomendación dentro de un schema
acotado a `{release, refund, split_pct}|`ambiguous_escalate_again``; el
código determinístico es quien aplica el resultado a través de los
primitivos de settle existentes y quien emite el recibo. Espejo del patrón
ya usado en el proyecto (LLM planifica, el código ejecuta — `orchestrate.ts`).

**DT-4**: Alcance de chains restringido a testnet por directiva explícita del
orquestador — ninguna acción de movimiento de fondos del árbitro se habilita
sobre chain IDs de mainnet en esta HU.

---

## Constraint Directives (CD-N)

**CD-1**: PROHIBIDO que el LLM tenga la última palabra sobre movimiento de
fondos. La ejecución de cualquier desenlace (`release`/`refund`/`split`)
SIEMPRE pasa por código determinístico que invoca los primitivos de
settle/refund existentes — nunca una llamada directa a transferencia desde
dentro del prompt/response del LLM.

**CD-2**: OBLIGATORIO Ownership Guard (`owner_ref`) en toda tabla/query/RPC
nueva relacionada con disputas — patrón `CLAUDE.md` / WKH-53, sin excepción.

**CD-3**: PROHIBIDO modificar `WasiAIEscrow.sol` o su ABI/interfaz en esta
HU — el contrato on-chain está fuera de scope (ver Scope OUT).

**CD-4**: OBLIGATORIO emitir un recibo inmutable (`receiptService.emit`,
patrón WKH-124) por cada decisión de arbitraje, incluyendo la evidencia
consultada y, si hubo escalación a LLM, el razonamiento registrado de forma
auditable.

**CD-5**: PROHIBIDO habilitar acciones de arbitraje que muevan fondos sobre
chain IDs de mainnet en esta HU (ver AC-5, DT-4).

**CD-6**: PROHIBIDO duplicar la lógica de sign/settle/verify — toda
ejecución de desenlace reusa el seam ya documentado en `payment-intent.ts`
(`getPaymentAdapter().sign()/.settle()` + `verifyDefaultChainSettle`), no
clona el patrón.

---

## Missing Inputs

Estos tres puntos son decisiones de producto del humano — **NO se infieren**
ni se asumen. Bloquean el paso a F2 hasta ratificación:

- **[NEEDS CLARIFICATION (a) — modelo de autoridad]**: ¿Qué puede decidir el
  árbitro autónomo sin ningún tipo de intervención humana? ¿Existe un tope de
  monto (USD) por encima del cual la disputa debe escalar más allá del
  agente (a un humano, o simplemente bloquearse/congelar el intent hasta
  revisión)? Si no hay tope, ¿es una decisión deliberada de "zero human in
  the loop" incluso para montos grandes?

- **[NEEDS CLARIFICATION (b) — evidencia admisible]**: ¿La evidencia que el
  árbitro puede considerar es EXCLUSIVAMENTE la proof-chain on-chain/DB
  (recibos WKH-124 + estado del intent + vouchers), o también se permiten
  inputs declarados off-chain por las partes (p.ej. un texto libre del Buyer
  explicando por qué disputa, o un adjunto del Seller)? Si se permiten inputs
  de las partes, ¿cómo se pondera su credibilidad frente a la evidencia
  verificable (dado que cualquier parte puede mentir)?

- **[NEEDS CLARIFICATION (c) — path de apelación]**: ¿La decisión del agente
  es final e inmediatamente ejecutada, o existe algún mecanismo de override
  humano para casos grandes/sensibles (p.ej. una ventana de "cooling-off"
  antes de ejecutar, o un canal de apelación post-ejecución con posible
  reversión)? Esto determina si el settle se ejecuta inmediatamente tras la
  decisión o si hay un delay/gate configurable.

- **[TBD — F2, no bloqueante]**: alcance exacto de `upto` — esta HU asume
  v1 acotado a `session` únicamente; si el humano quiere disputas sobre
  `upto` también, es una extensión a evaluar en F2 o una HU separada.

- **[TBD — F2, no bloqueante]**: criterio exacto de "ambigüedad genuina" que
  dispara la escalación a LLM (AC-2) — el Architect lo define como parte del
  diseño del motor de reglas, con ejemplos concretos de casos "obvios" vs
  "ambiguos".

---

## Análisis de paralelismo

- **Depende de (DONE, ya en `main`)**: WKH-124 (recibos, `src/services/receipt.ts`),
  WKH-135 (intents `session`/`upto`, `src/services/payment-intent.ts` +
  `src/routes/payments.ts`), WKH-53 (Ownership Guard). Todas confirmadas
  presentes en el checkout actual de `main` (no son dependencias en HOLD).
- **No depende de**: WKH-126a/b/c (escrow on-chain) — explícitamente
  descartado como primitivo base (ver F0 hallazgo #1). WKH-136 (splits de fee)
  — no se reutiliza.
- **Bloquea**: ninguna HU activa identificada. No es prerequisito de otra HU
  en el roadmap actual.
- **Reemplaza/supera**: la WKH-139 v1 (fila 141 `_INDEX.md`, `DEFERRED`,
  branch `feat/141-wkh-139-dispute-window`) — esa branch queda obsoleta; esta
  HU parte de cero sobre el `session` intent ya mergeado, no sobre esa rama.
- **Puede correr en paralelo con**: cualquier HU que no toque
  `payment-intent.ts` / `receipt.ts` / `a2a_payment_intents`. No hay
  candidatos activos en este momento.
