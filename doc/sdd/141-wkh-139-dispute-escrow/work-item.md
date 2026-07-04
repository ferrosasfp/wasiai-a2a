# Work Item — [WKH-139] Dispute resolution real: escrow + dispute window (release/dispute/timeout)

## Resumen
OKX.AI vende "staked evaluators" para disputas pero deja el mecanismo sin
especificar (marketing, no shipped). Esta HU busca un path de disputa real y
acotado sobre el money-path de wasiai-a2a: un *hold* post-settlement de un
intent/tarea con tres salidas — `release` (inmediato, antes de que expire la
ventana), `dispute` (escalado a un resolver designado) y `timeout` (self-release
automático al vencer la ventana si nadie disputó). Resolver único v1,
descentralizable después.

**Hallazgo crítico de F0 (grounding)**: el "escrow ya staged en WKH-126"
(`WasiAIEscrow.sol`, NNN 121/117/122) **NO es la base correcta para esto** — ver
§Dependencias. El intent `session` de WKH-135 (NNN 137, DONE) sí ofrece
plumbing de *hold* (deposit reservado, settle único al cierre, refund del
residual, idempotencia, expiry determinístico) pero **no tiene ningún concepto
de disputa/resolver hoy** — el CHECK constraint de `a2a_payment_intents.status`
solo admite `open|closing|settled|refunded|expired|failed` (verificado en
`supabase/migrations/20260704000000_wkh135_payment_intents.sql:33-34`); no
existe `disputed`/`held` en ningún lado del codebase (grep sin resultados sobre
"dispute"/"resolver" en `src/`).

**Veredicto**: **NO bloqueada por falta total de infraestructura**, pero **SÍ
bloqueada para pasar a F2** hasta que el humano ratifique 4 decisiones de
producto (ver Missing Inputs BLOQUEANTE). Se propone acá un **v1 acotado**
construido sobre el intent `session` (no sobre el contrato Solidity), y se deja
constancia explícita de qué NO se reutiliza y por qué.

---

## Sizing
- **SDD_MODE**: full (QUALITY) — money-path, nuevo estado de settlement,
  AR/CR obligatorio por regla del proyecto (CLAUDE.md: money-path → QUALITY
  siempre).
- **Estimación**: M/L (confirmado — nuevo estado de máquina, nuevo rol
  "resolver", nuevos endpoints, sin tocar `charge`/`compose`/`orchestrate`
  existentes).
- **Branch sugerido**: `feat/141-wkh-139-dispute-window`

## Sizing — Skills Router
- `money-path-review` — cualquier cambio en hold/release/refund debe pasar por
  el lente de doble-cobro, doble-refund e idempotencia (mismo patrón que
  `payment-intent.ts`).
- `state-machine-design` (o equivalente) — el hold/dispute/timeout es una
  máquina de estados nueva; el riesgo no es solo money, es concurrencia de
  transiciones (release vs dispute vs timeout compitiendo por la misma fila).

---

## Dependencias — estado real verificado (F0)

| Primitivo | Estado real | ¿Sirve de base para esta HU? |
|-----------|-------------|-------------------------------|
| `WasiAIEscrow.sol` (WKH-126a, NNN 121) | DONE en código (22/22 tests, 100% coverage) pero **NO deployado** (`report.md §8`: "el contrato NO está deployado"). Escrow **agregado por Agent Key** (deposit/debitBatch/withdraw batch-settlement), NO por tarea. Sin firma del agente el operador NUNCA mueve fondos (CD-2) — no existe concepto de "resolver" ni de disputa entre buyer/seller. | **NO.** Es un primitivo de *funding* (cómo el agente fondea su budget de forma no-custodial), no un primitivo de *hold de una transacción específica pendiente de arbitraje*. Reutilizarlo requeriría inventar semántica de disputa que el contrato no tiene y que auditar/redeployar el contrato está fuera de esfuerzo M/L. |
| Escrow routing per-chain (WKH-126c, NNN 122) | DONE — fallback a treasury si no hay contrato en esa cadena. | N/A, es infraestructura del punto anterior. |
| Payment Intent `session` (WKH-135, NNN 137) | DONE, en prod (`src/services/payment-intent.ts`). Reserva un deposit contra el budget prepago (`open_payment_intent`), acumula vouchers, cierra con **un solo settle** al Seller + refund del residual al Buyer. Máquina de estados: `open→closing→{settled,refunded,expired,failed}`. **Su propio work-item (NNN 137) excluyó explícitamente esta HU**: *"El intent `escrow` de APP y cualquier mecanismo de disputa (WKH-139) — fuera de scope; el escrow no-custodial ya staged (WKH-126a/b) es un primitivo distinto y no se reutiliza automáticamente acá sin decisión explícita."* | **SÍ, parcialmente.** Da el *hold* (deposit ya debitado del buyer, no transferido aún al seller hasta el close) + idempotencia + expiry determinístico ya construidos. Lo que falta 100%: el estado `disputed`, un rol "resolver", y la lógica de decisión post-disputa. |
| `x402` `charge` / `/compose` / `/orchestrate` fee | Settle inmediato, sin hold. | No aplica — esta HU no los toca (CD explícito abajo). |

**Conclusión de dependencia**: no hay que esperar a que WKH-126 se deploye ni
auditar el contrato Solidity para tener un v1 de disputa. El v1 se construye
**enteramente off-chain/DB**, encima de la máquina de estados de `session`,
igual que `session` se construyó encima de `fee-charge.ts`. La réplica on-chain
(dispute registrada en el contrato Solidity) queda fuera de scope v1.

---

## Acceptance Criteria (EARS) — v1 propuesto

- **AC-1**: WHEN un intent `session` con `dispute_mode` habilitado completa su
  ventana de trabajo (el Seller reporta la tarea como terminada / se llama
  `closeSession`), the system SHALL entrar en estado `held` en lugar de
  settlear inmediatamente al Seller, iniciando una ventana de disputa
  configurable (`dispute_window_seconds`).

- **AC-2**: WHEN el Buyer (u otro actor autorizado — a confirmar en Missing
  Inputs) llama `release` sobre un intent en estado `held` y la ventana de
  disputa NO expiró, the system SHALL settlear el monto retenido al Seller
  inmediatamente (reusando `settlePaymentIntentOnChain`) y cerrar el hold como
  `settled`.

- **AC-3**: WHEN el Buyer llama `dispute` sobre un intent en estado `held` y la
  ventana NO expiró, the system SHALL transicionar el intent a `disputed` y
  SHALL prevenir cualquier auto-release o release manual hasta que el resolver
  designado registre una decisión.

- **AC-4**: WHILE un intent está en estado `disputed`, the system SHALL NOT
  transferir fondos al Seller ni reembolsar al Buyer sin una decisión explícita
  y registrada del resolver designado (v1: un único resolver, no
  descentralizado).

- **AC-5**: IF la ventana de disputa expira SIN que el Buyer haya llamado
  `dispute`, THEN the system SHALL auto-liberar (`timeout self-release`): settlear
  el monto retenido al Seller de forma determinística, siguiendo el mismo
  patrón de `expireStale()` de `payment-intent.ts` (barrido/cron, idempotente).

- **AC-6**: WHEN el resolver designado registra una decisión (`release` o
  `refund`) sobre un intent `disputed`, the system SHALL ejecutar esa decisión
  **exactamente una vez** (idempotencia por transición de estado, mismo patrón
  `prev_status` de `close_payment_intent_for_settle`), sin permitir una segunda
  decisión sobre el mismo intent.

- **AC-7**: WHILE cualquier estado nuevo (`held`, `disputed`) persiste en
  `a2a_payment_intents` (o tabla nueva — a definir en F2), the system SHALL
  aplicar el mismo patrón de Ownership Guard (`owner_ref`) documentado en
  `CLAUDE.md`, sin excepción.

- **AC-8**: IF dos transiciones compiten sobre el mismo intent en estado `held`
  (p.ej. `release` del Buyer y `timeout` del cron corriendo casi simultáneos),
  THEN the system SHALL resolver la carrera de forma atómica (`FOR UPDATE` /
  transición condicionada por estado previo, mismo patrón que
  `close_payment_intent_for_settle`), garantizando que el settle ocurra
  exactamente una vez.

---

## Scope IN
- Nuevo estado `held`/`disputed` en el ciclo de vida del intent `session` (o
  extensión equivalente — decisión de F2).
- Endpoints nuevos: `release`, `dispute`, y un endpoint de resolución del
  resolver (p.ej. `POST /payments/session/:id/resolve`).
- Job de timeout self-release (extensión de `expireStale()` o cron dedicado).
- Rol "resolver" v1: identidad única (operador designado vía config/env), sin
  staking ni descentralización.
- Tests money-path del ciclo completo: held→release, held→dispute→resolve
  (ambos veredictos), held→timeout.
- Ownership Guard + idempotencia sobre todo estado nuevo.

## Scope OUT
- Deploy/uso del contrato `WasiAIEscrow.sol` (WKH-126) — primitivo distinto, no
  se reutiliza en v1 (ver Dependencias).
- Resolución on-chain de la disputa (voto, staking de evaluadores,
  arbitraje descentralizado) — HU futura explícita ("resolver
  descentralizable después", per el enunciado original).
- Splits parciales en la resolución de disputa (p.ej. 70/30 entre Buyer y
  Seller) — v1 es binario: `release` (100% Seller) o `refund` (100% Buyer).
  Cualquier split fraccionario es HU futura (podría reusar el engine de
  WKH-136/splits bps).
- Intent `upto` — v1 solo cubre `session` (tiene el deposit-hold natural;
  `upto` no reserva nada hasta el settle, así que "hold" no aplica igual).
- UI/dashboard para que el Buyer dispute o el resolver decida — v1 es API-only,
  salvo pedido explícito del humano.
- Aplicar dispute window a `charge` (x402), `/compose`, `/orchestrate` — cero
  regresión en esos paths (mismo criterio que CD-1 de WKH-135).

---

## Decisiones técnicas (DT-N) — propuestas, a confirmar en F2

- **DT-1**: El hold se implementa como una extensión del ciclo de vida de
  `session` (NNN 137) en lugar de un intent nuevo — reduce duplicación de la
  infraestructura de settle/refund/idempotencia ya construida.
- **DT-2**: El resolver v1 es una identidad única (config-driven, p.ej.
  `DISPUTE_RESOLVER_REF` en env o un `owner_ref` designado), autenticado por el
  mismo mecanismo de auth existente (Bearer/A2A-Key) — NO se construye un
  sistema de roles nuevo en v1.
- **DT-3**: La ventana de disputa (`dispute_window_seconds`) es configurable
  por env con un default conservador (a confirmar valor en F2 — el HU original
  no especifica duración).
- **DT-4**: El timeout self-release reutiliza el patrón de `expireStale()`
  (cron/barrido periódico) — NO se agrega un scheduler nuevo.

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO modificar el comportamiento de `charge` (x402),
  `/compose`, `/orchestrate`, o el intent `upto` existente — el dispute window
  es aditivo, exclusivo de `session` en v1.
- **CD-2**: OBLIGATORIO Ownership Guard (`owner_ref`) en cualquier tabla/query/
  RPC nueva de `held`/`disputed` — un AR que encuentre una query sin
  `.eq('owner_ref', ...)` DEBE marcarlo BLOQUEANTE (equivalente a IDOR).
- **CD-3**: OBLIGATORIO que la transición `held→disputed`, `held→settled`
  (release), y `disputed→{settled,refunded}` (resolución) sea atómica y
  status-gated (mismo patrón `prev_status` de `close_payment_intent_for_settle`)
  — PROHIBIDO una segunda transición sobre un intent ya resuelto.
- **CD-4**: PROHIBIDO que el resolver mueva fondos sin que el intent esté en
  estado `disputed` explícito — el resolver NO tiene poder sobre intents
  `held`/`open`/`closing`.
- **CD-5**: OBLIGATORIO re-verificar el settle final on-chain
  (`verifyDefaultChainSettle`, mismo patrón que `session`/`fee-charge.ts`)
  antes de marcar cualquier resolución como `settled`.

---

## Categorías de riesgo (money-path — para AR/CR)

1. **Fondos retenidos indefinidamente**: si el timeout self-release falla
   silenciosamente, el Buyer/Seller quedan sin resolución — igual riesgo que
   AC-6 de WKH-135 pero con una ventana intermedia extra (`disputed`) que puede
   quedar huérfana.
2. **Doble-resolución**: el resolver decide dos veces (retry) sobre el mismo
   intent — requiere el mismo patrón de idempotencia status-gated que
   `finalize_payment_intent`.
3. **Carrera release-vs-dispute-vs-timeout**: tres actores (Buyer, cron,
   resolver) pueden intentar transicionar el mismo intent simultáneamente —
   requiere `FOR UPDATE` estricto (AC-8).
4. **Autoridad del resolver centralizada**: v1 es un único punto de confianza
   (el operador) — riesgo de negocio conocido y aceptado explícitamente por el
   enunciado original ("resolver descentralizable después"), no es un hallazgo
   nuevo, pero el AR debe verificar que el auth del endpoint de resolución esté
   correctamente restringido (no cualquier caller puede resolver disputas
   ajenas).
5. **Confusión con el escrow on-chain (WKH-126)**: riesgo de que un futuro
   desarrollador asuma que "dispute" usa el contrato Solidity — mitigado
   documentando explícitamente en el código/SDD que NO lo usa.

---

## Missing Inputs

- **[BLOQUEANTE]** **Quién puede disputar y bajo qué evidencia**: ¿solo el
  Buyer puede iniciar `dispute`? ¿Se requiere adjuntar evidencia (ej. output
  del agente no cumplió lo esperado) o basta con la llamada sin justificación?
  ¿El Seller puede ver/responder antes de que el resolver decida?

- **[BLOQUEANTE]** **Identidad y proceso del resolver v1**: ¿es un humano del
  equipo operando manualmente vía un endpoint interno? ¿Es un endpoint público
  autenticado con una key especial? ¿Hay SLA de tiempo de resolución, o el
  intent puede quedar `disputed` indefinidamente (violaría el espíritu de "no
  fondos retenidos indefinidamente" de WKH-135 AC-6)?

- **[BLOQUEANTE]** **Duración de la ventana de disputa**: ¿default sugerido
  (24h? 72h?) y es configurable por Agent Key / por Seller / global?

- **[BLOQUEANTE]** **Alcance real vs el HU original ("escrow + dispute
  window")**: el enunciado original asume el escrow de WKH-126 como base
  ("staged"). Este work-item propone explícitamente NO usarlo (ver
  Dependencias) y construir sobre `session` en su lugar. Esto es un cambio de
  enfoque respecto a lo que el roadmap (`okx-ai-analysis-2026-07.md` línea 51)
  asumía ("escrow contract already staged") — requiere ratificación humana
  antes de F2: ¿se acepta el v1 off-chain sobre `session`, o se prefiere
  esperar/forzar el deploy+auditoría de `WasiAIEscrow.sol` primero y construir
  la disputa on-chain? (Esa segunda opción es un esfuerzo bastante mayor —
  auditoría externa + deploy mainnet + nueva función de disputa en el
  contrato ya "cerrado" — y no es lo que este work-item recomienda.)

---

## Análisis de paralelismo

- **No bloquea ni es bloqueada por WKH-126a/b/c** (NNN 121/117/122, todas
  DONE) — son primitivos distintos, sin dependencia de código real.
- **Depende de WKH-135** (NNN 137, DONE, en prod) — el v1 propuesto se
  construye sobre el intent `session`; si `session` cambiara de forma
  incompatible, esta HU quedaría desalineada. Riesgo bajo (WKH-135 ya está en
  prod y estable).
- **Comparte superficie con WKH-136** (splits bps, NNN 138, DONE) si en el
  futuro se quiere resolución parcial (split Buyer/Seller) — fuera de scope v1
  (ver Scope OUT), pero el engine de splits ya existe si se decide agregarlo
  después.
- **Puede correr en paralelo** con cualquier HU que no toque
  `src/services/payment-intent.ts` ni la tabla `a2a_payment_intents`.
- **Bloqueada para avanzar a F2** hasta que el humano resuelva los 4
  `[NEEDS CLARIFICATION]` de arriba — NO se debe generar SDD asumiendo
  respuestas.

---

*Analyst F0+F1 — 2026-07-04 — WKH-139. NNN: 141. Branch:
feat/141-wkh-139-dispute-window.*
