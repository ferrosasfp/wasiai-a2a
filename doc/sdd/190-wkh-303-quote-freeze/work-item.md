# Work Item — [WKH-303] Congelar la cotización 10 minutos con quote firmado (orchestrate plan→execute)

## Resumen

Entre `POST /orchestrate/plan` (cotiza) y `POST /orchestrate/execute` (ejecuta y debita), el precio de un
agente puede cambiar. Hoy `/execute` **re-resuelve el precio en vivo** y solo rechaza (409 `QUOTE_STALE`) si
ese precio supera el techo `maxQuotedCostUsdc`; si queda por debajo del techo pero es distinto del cotizado,
**cobra el precio nuevo en silencio** — el caller nunca aprobó ese monto exacto. Esta HU agrega un **quote
firmado, stateless, con TTL de 10 minutos** que `/plan` emite y `/execute` puede redimir para congelar precio
**y** identidad del agente por step, sin introducir storage nuevo (ni tabla Postgres ni Redis — decisión
explícita del founder). Beneficia sobre todo el camino **agent-key prepago** (el que usa Chaski); x402 ya está
protegido porque el pagador firma el monto exacto que abona.

## F0 — Grounding (evidencia de código)

- El patrón "decorar el `request` con precio/steps resueltos antes del middleware de débito" ya existe **dentro
  de un mismo request** en `src/routes/compose.ts` (`request.composeEstimatedCostUsd` /
  `request.composeResolvedSteps`, ver JSDoc `resolveComposePriceHandler` / `resolveComposeCapabilitiesHandler`,
  compose.ts:376-387 y 687-837). **`/compose` es atómico** (una sola request: descubre, cotiza y debita en la
  misma cadena de preHandlers) — no existe ahí una ventana de dos requests que congelar. **Scope OUT** de esta
  HU (ver abajo).
- La ventana de dos requests SÍ existe, hoy, en `src/routes/orchestrate.ts`:
  - `POST /orchestrate/plan` (líneas 170-292): discovery + planning + `resolveAgentPriceUsdc` (cache 60s,
    `src/services/agent-price.ts`), devuelve `steps` + `maxQuotedCostUsdc` **sin firmar**. Cero débito.
  - `POST /orchestrate/execute` (líneas 294-478): el cliente reenvía `steps` (agente+registry+input) tal cual
    los recibió de `/plan`, más `maxQuotedCostUsdc`. El comentario del propio código lo documenta:
    > "Re-derivación del plan server-side (CD-2/CD-NEW-6): los precios del cliente se IGNORAN... rechaza 409
    > QUOTE_STALE si el precio drifteó por encima del cap" (orchestrate.ts:372-376, 444-451).
  - Esto es exactamente el bug descrito: `costPerStep`/`step0Price` se recalculan con `resolveAgentPriceUsdc`
    en `/execute` (orchestrate.ts:379-391) y se debita ese valor — nunca el que `/plan` mostró — mientras siga
    bajo el techo.
  - Ni el precio ni la **identidad** del agente (`step.agent`/`step.registry`) viajan firmados: el cliente
    podría (o un bug en su lado podría) enviar a `/execute` un `steps` distinto del que `/plan` produjo, y
    nada lo detecta.
- Precedente de primitivo criptográfico ya establecido en el repo para "token firmado por el servidor,
  verificado en tiempo constante, sin storage nuevo": `src/services/llm/transform-hmac.ts`
  (`signTransformFn`/`verifyTransformFn`, HMAC-SHA256 + `crypto.timingSafeEqual`) y
  `src/services/signed-auth.ts` (HMAC/EIP-712 por-request con anti-replay). El quote de esta HU sigue el mismo
  idiom (HMAC-SHA256, comparación constant-time), pero es **stateless por diseño** — sin la tabla de nonces de
  `signed-auth.ts` (ese anti-replay exige Postgres, expresamente descartado por el founder para este caso).
- `src/lib/pricing-constants.ts`, `src/services/agent-price.ts` (cache 60s in-process, sin Redis — confirmado
  en su JSDoc y en `reputation.ts:21`, ambos citados por el founder) y `src/middleware/a2a-key.ts` (contextos
  de débito: master `a2aKeyRow`, `delegationContext`, `keySessionContext`) son las piezas que el Architect va a
  tocar en F2.
- Decisión de storage YA estaba documentada como pendiente en el propio código: `compose.ts:212-239`
  (`reportComposePriceDrift`) dice textual: *"la solución acordada es CONGELAR la cotización por 10 minutos...
  El congelamiento requiere storage durable entre requests... está pendiente de una decisión de storage."* Esta
  HU es esa decisión, ya tomada por el founder (quote firmado, no storage).

## Sizing

- SDD_MODE: full
- Estimación: L — toca el money-path (débito prepago), 3 contextos de débito distintos (master/delegación/
  sesión), un primitivo criptográfico nuevo (aunque con precedente en el repo), y exige cubrir varios bordes
  (expiración, binding al caller, agente desactivado) con evidencia línea-por-línea, no solo con la suite verde.
- Branch sugerido: `feat/190-wkh-303-quote-freeze`
- Skills de dominio: no hay skills de proyecto registradas en `.claude/skills/` más allá de `nexus-agile`
  (`.claude/skills/nexus-agile/` es la única carpeta presente). Señales de la HU apuntarían a `skill-backend`
  (API/middleware) y `skill-web3`/`skill-auth` (firma, money-path) si existieran — no se cargan por no existir
  en el registro del proyecto (regla "no cargar por precaución").

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `POST /orchestrate/plan` responde con `planStatus:'ready'`, the system SHALL incluir un
  quote firmado (token opaco, HMAC-SHA256) que congela, por cada step, la identidad resuelta del agente
  (`registry` + `slug`) y su `priceUsdc` cotizado, válido por exactamente 10 minutos desde su emisión.
- **AC-2**: WHEN `POST /orchestrate/execute` recibe un quote válido, no expirado y atado al caller que lo
  presenta, the system SHALL debitar y ejecutar cada step congelado usando el precio Y la identidad de agente
  del quote — NUNCA el precio ni la identidad re-resueltos en vivo en ese momento.
- **AC-3**: IF el quote presentado en `/execute` expiró (más de 10 minutos desde su emisión) o su firma no
  verifica, THEN the system SHALL rechazar la request con un código de error explícito y distinguible
  (p. ej. `QUOTE_EXPIRED` / `QUOTE_INVALID`), SHALL NOT debitar monto alguno, y SHALL indicar que se requiere
  una nueva cotización.
- **AC-4**: IF el quote presentado en `/execute` fue emitido para una credencial de caller distinta de la que
  lo presenta (otra key, otra delegación, otra sesión), THEN the system SHALL rechazar la request sin debitar,
  con un código de error distinguible del de expiración.
- **AC-5**: IF un agente congelado en el quote ya no existe o está desactivado al momento de `/execute`, THEN
  the system SHALL rechazar esa redención con un error explícito y SHALL NOT cobrar ni el precio congelado ni
  un precio en vivo por ese agente.
- **AC-6**: WHERE el caller de `POST /orchestrate/execute` NO incluye un quote (clientes de hoy), the system
  SHALL preservar el comportamiento actual sin cambios: re-resolución de precio en vivo contra el techo
  `maxQuotedCostUsdc`, con `409 QUOTE_STALE` si lo supera.
- **AC-7**: the system SHALL implementar el mecanismo de congelamiento sin introducir storage durable nuevo
  para el quote (sin tabla Postgres nueva, sin Redis): el quote SHALL ser autocontenido y verificable solo con
  un secreto del servidor (stateless).

## Scope IN

- `src/routes/orchestrate.ts` — `POST /orchestrate/plan` (emitir el quote) y `POST /orchestrate/execute`
  (redimirlo: verificar firma, TTL, binding al caller, existencia/estado del agente; usar precio+identidad
  congelados en vez de re-resolución en vivo cuando el quote es válido).
- Módulo nuevo (leaf, patrón `transform-hmac.ts`) para firmar/verificar el quote — sign + verify + TTL check,
  sin dependencias de DB.
- Env var nueva y dedicada para el secreto HMAC del quote (nunca reusar `REQUEST_EIP712_*` ni otro secreto
  existente).
- Contrato de error explícito para quote expirado / inválido / caller-mismatch / agente-desactivado (nunca
  fallback silencioso a precio vivo para un step que llegó con quote).
- Tests que cubran los 3 contextos de débito (master key, delegación, key-session) contra el binding del quote.

## Scope OUT

- `POST /compose` — es atómico (una sola request: descubre, cotiza y debita en la misma cadena de
  preHandlers), no existe ahí la ventana de dos requests que esta HU cierra. Ver evidencia F0.
- `POST /orchestrate` (el endpoint atómico, sin plan/execute) — mismo motivo que `/compose`.
- Cualquier tabla Postgres o uso de Redis para persistir el quote — descartado explícitamente por el founder.
- Single-use / anti-replay del quote dentro de su ventana de 10 minutos (redimirlo dos veces en esa ventana
  NO se detecta ni se bloquea) — requeriría storage para trackear "ya usado", lo cual contradice la decisión
  de no-storage. Ver Missing Inputs #1.
- Cambios al rol actual de `maxQuotedCostUsdc` como techo de reserva de budget en x402/orchestrate.
- Cambios en Chaski (frontend) para consumir/reenviar el nuevo campo `quote` — esta HU es solo gateway;
  seguimiento de integración queda para una HU de Chaski aparte.
- Formato exacto del token, dónde viaja en el request (body vs header) y esquema exacto de binding al
  caller — decisiones de diseño de F2 (Architect), no de F1.

## Decisiones técnicas (DT-N)

- DT-1: El quote es un **token stateless firmado** (HMAC-SHA256, verificación constant-time con
  `crypto.timingSafeEqual`), no una fila en Postgres ni una entrada en memoria/Redis — la única forma de
  cumplir simultáneamente "sobrevive entre dos requests" y "sin storage nuevo" que pidió el founder. Sigue el
  idiom ya usado en `transform-hmac.ts`/`signed-auth.ts`.
- DT-2: El quote congela **identidad + precio**, no solo precio. Si un step resolvió a un agente concreto
  (`registry`+`slug`), ese agente queda fijo en el quote; `/execute` con quote válido usa esos valores en vez
  de confiar en el `agent`/`registry` que el cliente reenvía en `body.steps` para esos índices.
- DT-3: El binding al pagador ata el quote a la **credencial exacta que debita** en el momento de `/plan`
  (`a2aKeyRow.id` en el path master, o el `delegationId`/`sessionId` cuando hay delegación/key-session) — no
  solo al `owner_ref`. Es la lectura más literal de "que una cotización no la pueda usar otro": el mismo owner
  con OTRA de sus keys no debería poder redimir el quote de una key distinta. El Architect puede relajar esto
  en F2 si encuentra un caso de uso legítimo que lo justifique (ratificación humana en ese caso).
- DT-4: La verificación de existencia/estado-activo del agente congelado se hace CONTRA DISCOVERY en el
  momento de `/execute`, no se asume del quote — el quote solo garantiza que el precio/identidad no cambiaron
  silenciosamente EN VIVO, no que el agente siga existiendo. Un agente que dejó de existir dentro de la
  ventana de 10 minutos se rechaza explícitamente, nunca se cobra.

## Constraint Directives (CD-N)

- CD-1: **PROHIBIDO** agregar una tabla Postgres nueva o usar Redis para persistir el quote — debe ser un
  token stateless autocontenido y verificable solo con un secreto del servidor.
- CD-2: **OBLIGATORIO** que la ausencia del campo de quote en `/orchestrate/execute` preserve el
  comportamiento actual byte-a-byte (AC-6) — ningún cliente existente puede romperse por esta HU.
- CD-3: **PROHIBIDO** debitar cualquier monto cuando el quote expiró, la firma es inválida, el caller no
  coincide, o el agente congelado ya no existe/está activo — el único resultado permitido en esos casos es
  0 débito + error explícito y distinguible (AC-3/AC-4/AC-5).
- CD-4: **OBLIGATORIO** verificar la firma HMAC con `crypto.timingSafeEqual` (comparación en tiempo
  constante), replicando el patrón ya usado en `src/services/llm/transform-hmac.ts` y
  `src/services/signed-auth.ts`.
- CD-5: **PROHIBIDO** reusar el secreto de otro subsistema (`REQUEST_EIP712_*`, `SIGNED_AUTH_*`, etc.) para
  firmar el quote — debe ser una env var nueva y dedicada, sin fallback a otro secreto ni hardcode.
- CD-6: **OBLIGATORIO** re-verificar existencia y estado activo del agente congelado contra discovery en el
  momento de la redención, antes de facturar (DT-4) — el quote nunca reemplaza ese chequeo.

## Missing Inputs

- [NEEDS CLARIFICATION — no bloqueante, trade-off aceptado por diseño] El quote puede redimirse más de una
  vez dentro de su ventana de 10 minutos (no hay tracking de "ya usado" porque eso exigiría storage, que el
  founder descartó explícitamente). Si más adelante se requiere single-use estricto, eso implica revisar la
  decisión de no-storage — se documenta acá para que quede a la vista, no bloquea F2.
- [resuelto en F2] Formato exacto del token (payload + firma, JWT compacto vs formato propio) y transporte
  (campo en el body `POST /orchestrate/execute` vs header) — decisión de implementación del Architect.
- [resuelto en F2] Mecanismo exacto de binding al caller cuando hay delegación/key-session anidada (DT-3 deja
  la dirección, falta el detalle de qué campos exactos entran al payload firmado).

## Análisis de paralelismo

- No bloquea ni depende de HUs `in progress` actuales (159, 160, 161, 162, 163, 189) — todas tocan
  `orchestrate.ts` en secciones de **relevancia del planner** (`llmFilterApplies`/`fallbackNoRelevance`/
  backstop léxico/semántico), no la sección de `/plan` + `/execute` que esta HU toca. Riesgo de conflicto de
  merge bajo pero no nulo (mismo archivo): recomendado secuenciar el merge de esta HU coordinando con
  cualquiera de esas que esté más avanzada al momento de F3, igual que la fila 163 del `_INDEX.md` ya
  recomendó para el bloque de relevancia semántica.
- No depende de ningún WKH-191 (escrow) — es dinero prepago off-chain (budget en DB), no toca el escrow
  on-chain.
- Puede correr en paralelo con cualquier HU que no toque `orchestrate.ts` (p. ej. WKH-235a/236 Solana, WKH-241
  discovery payment-spec) sin fricción.
