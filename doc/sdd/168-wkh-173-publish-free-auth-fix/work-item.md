# Work Item — [WKH-173] Self-publish (`POST/PATCH/DELETE /agents`) cobra fee placeholder pese a documentarse "gratis"

## Resumen
`POST /agents` (y `PATCH`/`DELETE /agents/:slug`) usan el mismo preHandler
`requirePaymentOrA2AKey` que las rutas de pago (`/compose`, `/orchestrate`,
`/gasless/transfer`). Como estas rutas de publish NO inyectan
`composeEstimatedCostUsd`/`gaslessEstimatedCostUsd`, el middleware cae al
fallback `PLACEHOLDER_FEE_USD` ($1) y **debita realmente** el budget del
caller — contradiciendo el comentario `agents.ts:19-20` ("Publicar es GRATIS
con a2a-key"). Fix de fondo: desacoplar AUTENTICACIÓN (resolver
`owner_ref`) de PAGO, con un middleware auth-only nuevo
(`requireA2AKey()`) que las rutas de publish usan en lugar de
`requirePaymentOrA2AKey`.

## Sizing
- SDD_MODE: full (QUALITY — toca middleware de auth/money-path compartido)
- Estimación: S/M
- Branch sugerido: `fix/168-wkh-173-publish-free-auth`
- Deploy: Railway (wasiai-a2a) — el fix NO tiene efecto en prod hasta el
  próximo deploy tras merge a `main` (no hay auto-deploy documentado en este
  repo para esta rama; confirmar pipeline de Railway en F2/F3).

## Grounding F0 (verificado, con líneas exactas)

- `src/routes/agents.ts:19-20` — comentario: "Publicar es GRATIS con
  a2a-key (sin fee/budget)".
- `src/routes/agents.ts:102-107`, `:277-281`, `:408-412`, `:453-457` — las
  4 rutas (`POST /`, `PATCH /:slug`, `DELETE /:slug`, `GET /`) usan
  `...requirePaymentOrA2AKey({...})` como único preHandler.
- `src/middleware/a2a-key.ts:284-290` (`resolveEstimatedCostUsd`) — sin
  `composeEstimatedCostUsd`/`gaslessEstimatedCostUsd` seteados, cae a
  `PLACEHOLDER_FEE_USD` (`src/lib/pricing-constants.ts:16` = `1.0`).
- `src/middleware/a2a-key.ts:875-974` (`resolveMasterAuth`, paso 7) — el
  débito real (`budgetService.debit(...)`) es CONDICIONAL a
  `!request.skipMiddlewareDebit`; el `request.a2aKeyRow = keyRow` (paso 8,
  línea 978) se setea DESPUÉS, sin depender del débito. **Auth y débito ya
  son pasos separables en el código actual** — WKH-127 ya estableció este
  patrón (`skipMiddlewareDebit`) para `/orchestrate*`.
- `src/middleware/a2a-key.ts:379-498` (`resolveDelegationAuth`) y
  `:632-734` (`resolveKeySessionAuth`) — mismos 2 branches (delegación y
  key-session) también respetan `skipMiddlewareDebit` alrededor del débito
  (líneas 379 y 632), confirmando el precedente en los 3 paths de auth
  (master/delegación/sesión).
- `src/middleware/x402.ts:165-502` (`requirePayment`) — el fallback x402
  (cuando NO hay a2a-key) es un flujo de **pago real completo**: si el
  caller manda `X-PAYMENT`, verifica + settlea on-chain ANTES de devolver
  el control a la ruta. Como `agents.ts` recién chequea
  `request.a2aKeyRow` DESPUÉS del preHandler (`:143-146`, `:317-320`,
  `:417-420`, `:461-464`), un caller x402-anónimo que efectivamente PAGA
  (`X-PAYMENT` válido) sería debitado on-chain y DESPUÉS rechazado con
  `403 A2A_KEY_REQUIRED` — **hallazgo nuevo de esta HU**, mismo bug de
  fondo (auth/pago no desacoplados), agravado porque acá es dinero real
  on-chain, no budget prepago. Se resuelve GRATIS por el mismo fix (ver
  AC-3): el middleware `requireA2AKey()` nunca invoca `requirePayment`.
- `src/routes/registries.ts:99-104`, `:207-212`, `:285-290` — **MISMO
  patrón exacto** (`requirePaymentOrA2AKey` sin costo real inyectado) en
  `POST/PATCH/DELETE /registries`, o sea también caen al placeholder $1.
  DIFERENCIA CLAVE: el docstring de `registries.ts:1-16` NO afirma en
  ningún lado que registrar un marketplace sea gratis — no hay promesa
  documentada rota. Podría ser by-design (fee mayor por ser una acción más
  pesada — registrar un marketplace entero vs. publicar 1 agente). **NO
  se incluye en el Scope IN de esta HU** (ver Missing Inputs #3).
- `src/middleware/a2a-key.test.ts` y `src/routes/agents.publish.test.ts`
  (`:75-84`) — el test-suite actual de `agents.ts` **mockea por completo**
  `requirePaymentOrA2AKey` (inyecta `a2aKeyRow` a mano), así que NO ejercita
  el bug real ni se rompe si el preHandler se reemplaza — el punto de
  actualización es el mock (`vi.mock('../middleware/a2a-key.js', ...)`,
  agregar `requireA2AKey`).

## Acceptance Criteria (EARS)

- AC-1: WHEN un caller presenta un a2a-key válido (master, key-session o
  delegación) a `POST /agents`, `PATCH /agents/:slug`, `DELETE
  /agents/:slug` o `GET /agents`, the system SHALL autenticar al caller
  (resolver `owner_ref` vía `request.a2aKeyRow`) SIN debitar el budget de
  la key (ni master, ni delegación, ni sesión).
- AC-2: WHILE la key/sesión/delegación es inválida (no encontrada,
  inactiva, expirada, revocada) o requiere firma y la firma falta/es
  inválida, the system SHALL rechazar con LOS MISMOS códigos de error que
  produce hoy `requirePaymentOrA2AKey` en sus pasos de auth
  (`KEY_NOT_FOUND`, `KEY_INACTIVE`, `SESSION_EXPIRED`,
  `DELEGATION_REVOKED`, `DELEGATION_EXPIRED`, `SESSION_TOKEN_INVALID`,
  `SIGNATURE_REQUIRED`, etc.) — semántica de auth sin cambios, solo se
  quita el paso de débito.
- AC-3: IF no hay a2a-key ni `Authorization: Bearer wasi_a2a_*` presente en
  `POST/PATCH/DELETE/GET /agents`, THEN the system SHALL responder `403
  A2A_KEY_REQUIRED` SIN invocar el flujo x402 (sin challenge 402, sin
  verify/settle on-chain) — cierra también el hallazgo de pago-real
  perdido descrito en el Grounding.
- AC-4: WHEN la autenticación tiene éxito, the system SHALL setear
  `request.a2aKeyRow` (con el `effectiveRow`/scoping de delegación o
  sesión cuando aplique, idéntico al que produce hoy
  `resolveMasterAuth`/`resolveDelegationAuth`/`resolveKeySessionAuth`) de
  forma que los checks de ownership (`OwnershipMismatchError` → 404) en
  `publishedAgentService` sigan funcionando sin cambios.
- AC-5: the system SHALL NOT modificar el comportamiento de débito de
  `/compose`, `/orchestrate`, `/orchestrate/plan`, `/orchestrate/execute`,
  `/gasless/transfer` ni `/registries` (`POST/PATCH/DELETE`) —
  `resolveMasterAuth`, `resolveDelegationAuth` y `resolveKeySessionAuth`
  (y sus bloques de débito) quedan byte-idénticos; `requirePaymentOrA2AKey`
  sigue siendo el preHandler de esas rutas.
- AC-6: WHEN corre el test-suite completo existente (`a2a-key.test.ts`,
  `agents.publish.test.ts`, `agents.ownership.test.ts`,
  `registries*.test.ts`, tests de delegación/sesión, tests de
  compose/orchestrate), the system SHALL seguir pasando con 0 fallos
  (regresión cero) — el nuevo path es aditivo, no una modificación in-place
  de los resolvers existentes.
- AC-7: WHEN se publica/actualiza/borra un agente con una key/sesión que
  requiere firma (`require_signature: true`), the system SHALL seguir
  exigiendo la firma (EIP-712 para master, HMAC para sesión) exactamente
  igual que hoy — el fix NO relaja ningún control de seguridad, solo el
  débito.
- AC-8: WHERE la key/sesión/delegación ya alcanzó su `daily_limit_usd` /
  `max_spend_per_call_usd` / límite per-tx, the system SHALL permitir
  igualmente publicar/actualizar/borrar un agente (esos guards protegen
  gasto real; una acción de costo $0 no debe bloquearse por ellos) — **DT-2,
  cambio de comportamiento intencional y documentado, a ratificar por
  Architect en F2**.

## Scope IN
- `src/middleware/a2a-key.ts` — nueva función exportada `requireA2AKey()`
  (auth-only, sin `requirePayment` fallback, sin chain-resolution, sin
  budget checks/debit). Reusa `extractRawKey`, `identityService`,
  `delegationService`, `keySessionService`, `isIdentityVerified`,
  `verifySignedAuth`, `extractSignedHeaders` — NO reescribe
  `resolveMasterAuth`/`resolveDelegationAuth`/`resolveKeySessionAuth`.
- `src/routes/agents.ts` — swap del preHandler en las 4 rutas (`POST /`,
  `PATCH /:slug`, `DELETE /:slug`, `GET /`) de `requirePaymentOrA2AKey` a
  `requireA2AKey`. Actualizar docstring `:16-21` para que el comentario
  "Publicar es GRATIS" sea verificable en código.
- `src/middleware/a2a-key.test.ts` — tests nuevos para `requireA2AKey()`
  (happy path master/sesión/delegación sin débito, error codes AC-2,
  x402 nunca invocado AC-3, firma requerida AC-7).
- `src/routes/agents.publish.test.ts`, `src/routes/agents.ownership.test.ts`
  — actualizar el mock de `../middleware/a2a-key.js` para exponer
  `requireA2AKey` (hoy solo mockea `requirePaymentOrA2AKey`).

## Scope OUT
- `src/middleware/a2a-key.ts` — `resolveMasterAuth`, `resolveDelegationAuth`,
  `resolveKeySessionAuth` y sus bloques de débito (`budgetService.debit`,
  `delegationService.debitDelegationAndParent`,
  `keySessionService.debitSessionAndParent`) — quedan intactos, usados por
  `/compose`, `/orchestrate*`, `/gasless/transfer`.
- `src/routes/registries.ts` (`POST/PATCH/DELETE`) — mismo patrón de bug
  potencial, pero SIN promesa documentada de "gratis"; requiere decisión
  de producto separada (ver Missing Inputs #3). NO se toca en esta HU.
- Fix 2 (default-chain UX en ops pagas: default silencioso a Kite, error
  `INSUFFICIENT_BUDGET chain 2368` poco accionable, sin default-chain
  per-key) — problema DISTINTO que afecta solo ops que SÍ cobran
  (compose/orchestrate), no publish. Recomendado como ticket nuevo (ver
  abajo).
- Deploy a Railway / verificación en prod — Scope OUT de F1-F4 (se agrega
  como paso operativo post-merge en el done-report).

## Decisiones técnicas (DT-N)
- DT-1: `requireA2AKey()` es una función NUEVA (no un flag `free: true`
  sobre `requirePaymentOrA2AKey`) — ratificado por el humano como "la
  solución de fondo, sin atajos". Un flag habría dejado corriendo
  chain-resolution/budget-header/x402-fallback innecesarios para una
  acción gratuita, y no habría resuelto el hallazgo AC-3 (x402-anónimo
  pagando y siendo rechazado igual).
- DT-2: `requireA2AKey()` NO aplica `daily_limit_usd`, `max_spend_per_call_usd`
  ni el per-tx limit de delegación — esos guards protegen gasto real y
  esta acción no gasta. Cambio de comportamiento respecto a hoy (hoy una
  key con daily-limit agotado también queda bloqueada para publicar, como
  efecto colateral del placeholder $1). A ratificar por Architect en F2 /
  confirmar con el humano si aplica.
- DT-3: `require_signature` (EIP-712 master / HMAC sesión) SÍ se mantiene
  enforced en `requireA2AKey()` — es un control de identidad/integridad,
  no de billing (CD-3).
- DT-4: `GET /agents` (listar mis agentes) se incluye en el Scope IN junto
  con POST/PATCH/DELETE — mismo bug, mismo archivo/feature
  ("self-serve single-agent publishing", docstring `agents.ts:1-22` agrupa
  las 4 rutas), y no hay ningún claim de que listar cueste dinero. El
  humano puede vetar esta inclusión en el gate `HU_APPROVED` si prefiere
  dejar `GET` fuera.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar el comportamiento de débito de
  `resolveMasterAuth`/`resolveDelegationAuth`/`resolveKeySessionAuth` — deben
  quedar byte-idénticos salvo por exponer las piezas reusables que
  `requireA2AKey()` necesita (si se refactoriza para extraer un helper
  compartido, DEBE ser un refactor puro sin cambio de comportamiento,
  cubierto 100% por AC-6).
- CD-2: PROHIBIDO que `requireA2AKey()` invoque `requirePayment`/x402 en
  ningún branch (ni siquiera como fallback) — ausencia de credencial =
  403 `A2A_KEY_REQUIRED` directo (AC-3).
- CD-3: OBLIGATORIO mantener `is_active`, `revoked_at`/`expires_at`
  (delegación y sesión) y `require_signature` enforced exactamente igual
  que hoy — cero relajación de seguridad (AC-2, AC-7).
- CD-4: OBLIGATORIO correr la suite completa (no solo los tests nuevos)
  antes de dar por cerrada la HU — `tsc`, `biome`, `vitest run` en 0 (AC-6).
- CD-5: OBLIGATORIO mantener backward-compat del path master documentado
  como CD-5 histórico en `a2a-key.ts` — `resolveMasterAuth` NO se toca in
  place.

## Missing Inputs
1. [resuelto en F2, no bloqueante] ¿`requireA2AKey()` debe ignorar
   `daily_limit_usd`/`max_spend_per_call_usd`/per-tx-limit (DT-2) o
   debe seguir respetándolos aunque la acción sea $0? Recomendación
   Analyst: ignorarlos (no hay gasto que limitar). Architect ratifica en
   SDD.
2. [resuelto en F2, no bloqueante] ¿Incluir `GET /agents` en el fix
   (DT-4)? Recomendación Analyst: sí. El humano puede vetarlo en el gate.
3. [bloqueante para decidir scope de `registries.ts`, NO bloqueante para
   esta HU] `registries.ts` tiene el mismo patrón de código
   (`requirePaymentOrA2AKey` sin costo real → placeholder $1 real) pero
   SIN promesa documentada de "gratis". ¿Es by-design (fee de registrar un
   marketplace) o es el mismo bug sin documentar? Recomiendo abrir un
   ticket de auditoría/decisión de producto separado — NO se resuelve acá
   para no expandir scope sin mandato explícito.
4. [recomendación, no bloqueante] Crear ticket nuevo — Fix 2: UX del
   default-chain en ops PAGAS (`/compose`, `/orchestrate`): hoy defaultea
   silenciosamente a Kite (chainId 2368), el error
   `INSUFFICIENT_BUDGET chain 2368` no es accionable para un caller que
   fondeó otra chain, y no hay default-chain configurable por key. Afecta
   SOLO ops que cobran — Scope OUT explícito de WKH-173 (ver Scope OUT).

## Análisis de paralelismo
- No bloquea trabajo activo en `orchestrate.ts` (filas 159-163 del
  `_INDEX.md`, `in progress`) — cero superficie compartida
  (`a2a-key.ts` se toca de forma ADITIVA con una función nueva; los
  branches master/delegación/sesión existentes no se modifican).
- Relevante para **WKH-171** (fila 167, `_INDEX.md`, DONE en código pero
  `PENDING-DEPLOY` con W4 = "registro `POST /agents`" pendiente de
  ejecutar): si W4 se ejecuta ANTES de que este fix esté en prod, el
  registro de `remit-corridor-fx` pagaría el $1 placeholder sin que nadie
  lo espere. Recomendación: secuenciar el deploy de WKH-173 ANTES (o junto
  con) la ejecución de W4 de WKH-171, o al menos que el humano sepa que
  hoy esa llamada tiene un costo oculto de $1.
- Puede ir en paralelo con cualquier HU que no toque
  `src/middleware/a2a-key.ts` ni `src/routes/agents.ts`.
