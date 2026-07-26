# Work Item — [192] `/gasless/transfer` cobra y no transfiere

Branch: `fix/gasless-refund-on-failure` (desde `main` @ `b81c2e6`).
Origen: AR de la HU 188 (clase de bug "débito aplicado + camino de error sin
credit-back"), hallazgo apuntando a `src/routes/gasless.ts:181-189` y `:214-223`.

---

## Problema

`POST /gasless/transfer` monta `requirePaymentOrA2AKey` **sin**
`skipMiddlewareDebit` (`src/routes/gasless.ts:174` en `main`), y el débito no es
el placeholder de $1: el preHandler `gaslessCostEstimatorPreHandler` inyecta
`request.gaslessEstimatedCostUsd` = **el valor completo del transfer** (WKH-59),
que es lo que el middleware debita (`src/middleware/a2a-key.ts:1196`).

Después del débito, el handler tenía tres salidas que devolvían error sin
reembolsar nada (`grep -nE "credit|refund" src/routes/gasless.ts` en `main` = 0
resultados):

| Sitio en `main` | Salida | Qué recibía el caller |
|---|---|---|
| `gasless.ts:183` `getGaslessAdapter(chainKey).status()` **fuera de todo try** | 500 del error boundary | nada, y ni un log del cobro |
| `gasless.ts:185-190` `funding_state !== 'ready'` | 503 `gasless_not_operational` | nada — el adapter ni se llamó |
| `gasless.ts:214-223` `transfer()` tiró | 500 `gasless transfer failed` | nada (o una tx cuyo destino se desconoce) |

El 503 es el peor de los tres: con el módulo gasless `disabled` / `unfunded` /
`unconfigured`, **el 100% de las llamadas cobra el valor entero del transfer y no
mueve un token**. Es un drain determinístico del budget del caller, repetible.

El docblock del módulo lo documentaba como decisión ("comportamiento
`fee-on-attempt` deliberado, Stripe-style"). Es falso para este endpoint: en
Stripe el `charge first, deliver after` cobra un **fee** y después entrega; acá se
cobraba el **valor transferido** y no se transfería nada.

---

## La trampa que tenía el mecanismo existente (y por qué NO se usó igual que en `/compose`)

La HU 188 creó el seam `onDebitOrphaned` (`a2a-key.ts:545-594`,
`refundIfDebitOrphaned`, invocado en los 3 branches que debitan: master `:1316`,
delegación `:839`, sesión `:1065`) porque en `/compose` el credit-back puesto en
el route handler era **código inalcanzable**: el 504 de `createTimeoutHandler`
manda la reply desde fuera del lifecycle y Fastify entonces **no invoca el
handler** (`fastify/lib/handle-request.js:132`). El primer fix de la 188 tuvo 0
hits sobre 3197 tests.

**Ese problema no es el de esta HU, y el seam no aplica acá.** Decisión y
justificación:

### Decisión: `/gasless` NO pasa `onDebitOrphaned`

1. `POST /gasless/transfer` **no monta `createTimeoutHandler`**. La cadena de
   preHandlers es exactamente `[gaslessCostEstimatorPreHandler,
   ...requirePaymentOrA2AKey(...)]` (`gasless.ts:353-359`). El único
   `grep -rn createTimeoutHandler src/` que toca gasless es… ninguno:
   los callers son `compose.ts:589`, `orchestrate.ts:79/190/330`,
   `inbound.ts:53`, `agent-links.ts:142`.
2. La instancia de Fastify se construye **sin** `requestTimeout` ni
   `connectionTimeout` (`src/index.ts:59-70`), así que no hay un 504/408 de
   plataforma que pueda adelantarse al handler.
3. Sin esa ventana, `refundIfDebitOrphaned` sólo corre con `reply.sent === true`
   al final del branch de débito — condición que en esta ruta nunca se cumple.
   Pasarlo sería **código con cero hits**: exactamente la falsa protección que el
   AR de la 188 ya cazó una vez (memoria `gotcha-refund-inalcanzable-route-handler`).
4. Como los 503/500 de esta ruta ocurren **dentro** del handler (que sí está
   corriendo), el refund normal ahí **sí** es alcanzable — y se verificó por
   cobertura, línea por línea (abajo).

Queda escrito en el docblock de la ruta (`gasless.ts:25-33`) que si algún día se
le agrega un timeout a este endpoint, hay que pasar
`onDebitOrphaned: (req) => refundGaslessDebit(req, 'debit-orphaned')`.

---

## Lo que NO se puede hacer: reembolsar todo 500

Un refund ciego en el `catch` **habría sido un bug peor** que el original. Los
adapters tiran DESPUÉS de haber mandado la tx a la red:

- `avalanche/gasless.ts` / `base/gasless.ts`: `receipt timeout (tx 0x…)` — la tx
  ya está en el mempool y puede confirmarse minutos después. Reembolsar ahí =
  el destinatario recibe los tokens **y** el caller recupera su budget (drena el
  wallet del operador, que es el que puso el valor).
- `kite-ozone/gasless.ts`: el submit es un `POST` al relayer con
  `AbortSignal.timeout(15000)`; si se corta, el relayer pudo haber mandado la tx
  igual.

Por eso el fix introduce un discriminador explícito en el error tipado.

### Contrato nuevo: `GaslessValueDisposition` (`src/adapters/errors.ts:23-71`)

```
'not-moved' → el valor NO se movió y no puede moverse por este intento
              ⟹ el débito es reembolsable
'unknown'   → la tx se broadcasteó (o pudo haberse) y no sabemos si confirmó
              ⟹ NO se reembolsa inline; queda log loud para reconciliar
```

El parámetro del constructor es **obligatorio a propósito** (tsc obliga a cada
throw site a decidir). Clasificación aplicada:

| Adapter / sitio | Disposition | Por qué |
|---|---|---|
| `avalanche/gasless.ts:364` cap re-validación | `not-moved` | pre-flight |
| `avalanche/gasless.ts:372` bajo el mínimo | `not-moved` | pre-flight |
| `avalanche/gasless.ts:382` `wallet has no account` | `not-moved` | pre-flight |
| `avalanche/gasless.ts:419` `sign failed` | `not-moved` | la firma es local |
| `avalanche/gasless.ts:462` `submit failed` | `fundingLow ? 'not-moved' : 'unknown'` | gas del operador ⟹ el nodo rechazó, nunca entró al mempool; cualquier otro fallo de `writeContract` puede haber sido aceptado con la respuesta perdida |
| `avalanche/gasless.ts:478` revert on-chain | `not-moved` | revert **confirmado**: la tx existe pero no transfirió (el operador sólo perdió gas) |
| `avalanche/gasless.ts:488` receipt timeout | `unknown` | la tx puede confirmarse después |
| `avalanche/gasless.ts:497` receipt failed | `unknown` | broadcasteada, falló el read |
| `base/gasless.ts` (mismos 8 sitios) | idem | espejo exacto |
| `kite-ozone/gasless.ts:279` sign | `not-moved` | local |
| `kite-ozone/gasless.ts:289` submit al relayer | `unknown` | el POST pudo haber llegado |
| error NO clasificado (cualquier otro `Error`) | `unknown` | fail-safe en `classifyGaslessFailure` (`gasless.ts:320-324`): preferimos no reembolsar antes que inflar el budget |

Nota: los stubs `solana`/`tempo` tiran en `transfer()`, pero su `status()`
devuelve `funding_state: 'disabled'`, así que el gate 503 corta antes — y ese
gate ahora **sí** reembolsa.

---

## El fix en la ruta

`refundGaslessDebit(request, reason)` (`src/routes/gasless.ts:215-322`) es el
espejo de `routes/compose.ts:refundComposeStep0` (misma matemática, las mismas 4
variantes de credit, el mismo encolado en `refundOutbox`), con tres diferencias
propias de la ruta:

1. El monto sale de `request.gaslessEstimatedCostUsd` (no de
   `composeEstimatedCostUsd`).
2. No hay `alreadySpentUsd`: el gasless es todo-o-nada (un único transfer), y los
   casos donde el valor pudo moverse se filtran **antes** de llamar al refund.
3. No hay `destination`: el débito del gasless nunca pasa por dest-policy
   (`composeDestination` sólo lo setea `/compose`), así que el refund usa las
   variantes SIN destino — simétrico al débito.

Call-sites:

| Sitio | Salida | Refund |
|---|---|---|
| `gasless.ts:374` `status()` tiró | re-`throw` ⟹ 500 idéntico al de antes | `'status-failed'` |
| `gasless.ts:379` `funding_state !== 'ready'` | 503 (body idéntico) | `'not-operational'` |
| `gasless.ts:424-425` `transfer()` tiró y `disposition === 'not-moved'` | 500 (body idéntico) | `'transfer-failed'` |
| `gasless.ts:427-440` `transfer()` tiró y `disposition === 'unknown'` | 500 (body idéntico) | **ninguno** + log `gasless.refund-skipped.settlement-unknown` con keyId/chainId/monto/errorClass |

Ningún status code ni body de respuesta cambió. El happy path no cambió: mismo
débito, sin credit (T-192-5 lo asierta contra el ledger).

### Invariantes anti-abuso del refund

- **Nunca sin débito confirmado**: llegar al handler con `a2aKeyRow` seteado
  implica que el débito del middleware terminó OK (cualquier fallo de débito
  corta con 402/403 y el handler no corre). El guard extra cubre
  `skipMiddlewareDebit`, caller x402 puro (sin `a2aKeyRow` ⟹ no hubo débito de
  budget), monto ausente/≤0 y `resolvedChainId` ausente (`gasless.ts:221-229`).
- **Nunca dos veces**: cada camino hace `return` inmediato tras llamarla; los
  cuatro son mutuamente excluyentes. T-192-1 asierta `credit` llamado
  exactamente 1 vez y el balance final **no mayor** al inicial.
- **Ownership guard (CLAUDE.md)**: las 4 variantes reciben el `owner_ref` del
  caller autenticado; bajo delegación/sesión se usa el refund DUAL-LEDGER
  (`creditDelegation` / `creditSession`), simétrico a
  `debit_delegation_and_parent` / `debit_session_and_parent`, nunca sólo el
  padre. En los tests el fake de credit **ignora el ledger si el `ownerRef` no
  matchea**, así que "el balance volvió" prueba el ownership.
- **Si el credit no aplica nada, queda señal**: `success:false` ⟹ log
  `[gasless.refund-failed]` + `refundOutbox.enqueueRefund` con reason
  `gasless-route.refund-failed:<motivo>`; si el credit tira ⟹
  `[gasless.refund-threw]` + reason `gasless-route.refund-threw:<motivo>`; si el
  outbox también tira ⟹ `[gasless.refund-outbox-threw]`. Nunca silencio, y nunca
  rompe el response (best-effort, como en compose).

---

## Barrido completo: todas las rutas con `requirePaymentOrA2AKey`

`grep -rn "requirePaymentOrA2AKey" src/routes/*.ts` (5 archivos, 9 call-sites).
"Cobra" = el middleware debita antes del handler.

| Ruta / call-site | ¿Debita el middleware? | Statuses post-débito | ANTES | DESPUÉS |
|---|---|---|---|---|
| `gasless.ts:356` `POST /gasless/transfer` | **SÍ** — valor real del transfer | 500 (`status()` tiró), 503 `gasless_not_operational`, 500 `gasless transfer failed` | cobraba los 3 sin refund | **arreglado acá** (rail budget prepago): refunda 503 + 500-`status` + 500-`not-moved`; el 500-`unknown` se deja cobrado a propósito, con log loud. **Residual (rail x402)**: un caller con `x-payment` y sin `x-a2a-key` settlea `DEFAULT_AMOUNT_USD` = $1 **on-chain** (`middleware/x402.ts:240` + `:262`; la ruta no pasa `amountUsd`) y si el handler corta igual (p. ej. 503 con `GASLESS_ENABLED` off) `refundGaslessDebit` retorna en el guard `!a2aKeyRow` (`routes/gasless.ts:223`): no hay ledger que acreditar y **no hay refund on-chain**. Es el MISMO residual que `registries`/`tasks` y necesita la misma decisión de diseño (§Follow-ups 1) |
| `compose.ts:602` `POST /compose` | SÍ — precio real del step-0 | 400 validación, 400/402/403 `!success`, 504 | arreglado en HU 188 | sin cambios |
| `orchestrate.ts:84` `POST /orchestrate` | **NO** — `markSkipMiddlewareDebitHandler` (`:83`) | 504 (`:124`), 400/500 | nada debitado en el middleware; el service debita post-plan (`services/orchestrate.ts:1138`) y corre su propio credit-back para `!pipeline.success` (`:1304-1355`) | sin cambios (fuera de alcance, ver residual abajo) |
| `orchestrate.ts:195` `POST /orchestrate/plan` | NO — skip (`:194`) | contrato zero-debit | — | sin cambios |
| `orchestrate.ts:336` `POST /orchestrate/execute` | NO — skip (`:335`) | 504 (`:430`), 400/500 | idem `/orchestrate` | sin cambios |
| `registries.ts:108` `POST /registries` | **SÍ** — `PLACEHOLDER_FEE_USD` ($1) | 400 campos faltantes (`:124`), 422 `SSRF_BLOCKED` (`:153`), 403 `A2A_KEY_REQUIRED` (`:167`), 400 `Failed to register` (`:200`), 403/404 de `mapOwnershipError` | **cobra $1 y no refunda en ninguno** | **NO arreglado — HU propia** |
| `registries.ts:216` `PATCH /registries/:id` | **SÍ** — $1 | 400 validación, 403 `A2A_KEY_REQUIRED`, 404, 403 ownership, 400 update failed | idem | **NO arreglado — HU propia** |
| `registries.ts:294` `DELETE /registries/:id` | **SÍ** — $1 | 403 `A2A_KEY_REQUIRED`, 404, 403 ownership, 400 | idem | **NO arreglado — HU propia** |
| `tasks.ts:41` (compartido por `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id/status`, `PATCH /tasks/:id`) | **SÍ** — $1 por llamada, incluidos los GET | 400 body/UUID/status inválido (`:61,:92,:120,:145,:148,:153,:190,:193,:200`), 404 (`:127,:165,:212`), 409 terminal (`:170,:217`), 500 si el service tira | **cobra $1 y no refunda en ninguno** | **NO arreglado — HU propia** |

`agent-links.ts` usa `createTimeoutHandler` pero **no** `requirePaymentOrA2AKey`
(billing dentro del service) — fuera del patrón.

### Por qué `registries` y `tasks` merecen HU propia (y no dos líneas acá)

- Son **8 handlers y ~20 puntos de retorno** distintos, no dos sitios.
- Abren un frente que esta HU no tiene: en ambos el 403 `A2A_KEY_REQUIRED` /
  la rama x402 significa que un caller que pagó **on-chain** (x402, no budget
  prepago) recibe un error; ese cobro **no es reembolsable** con
  `budgetService.credit` (no hay ledger que revertir), así que necesita una
  decisión de diseño propia (¿refund on-chain? ¿mover el guard antes del pago?).
- El monto es el placeholder de $1 por llamada, no el valor de un transfer:
  impacto real pero un orden de magnitud menor que el de gasless.
- Riesgo de mezclar: el refund de `/tasks` toca 5 endpoints CRUD usados por
  clientes; conviene su propio AR/CR.

### Residual conocido de `/orchestrate` (dimensionado por el AR, NO tocado)

`if (reply.sent)` de `orchestrate.ts:98/205/358` es inalcanzable pero de impacto
monetario **cero** (las 3 rutas setean `skipMiddlewareDebit`, a esa altura nada
se debitó). Los alcanzables `:124` / `:430` retornan sin refund, pero el service
ya corre su credit-back para `!pipeline.success`; el residual real es el 504 con
pipeline exitoso ("cobra, ejecuta, y el caller no ve el output"), que no es
cobro-sin-contraprestación. Fuera de alcance.

---

## Verificación

### Gates

```
./node_modules/.bin/tsc --noEmit      → 0 errores
./node_modules/.bin/biome check src/  → 366 archivos, 0 hallazgos
./node_modules/.bin/vitest run        → 3501 passed | 11 skipped (baseline 3480 | 11)
```

+21 tests: 12 nuevos en `src/routes/gasless.refund.test.ts`, 5 en
`avalanche.test.ts`, 2 en `gasless.contract.test.ts` (kite), 2 en `base.test.ts`.
Ningún test existente se relajó; `gasless.test.ts:T-AC3-ROUTE` (503) ahora
además asierta el credit-back.

### Los tests miran el BALANCE, no el status

`src/routes/gasless.refund.test.ts` monta un **ledger stateful** en memoria:
`debit` decrementa, `credit`/`creditDelegation`/`creditSession` incrementan (y
las dos últimas mueven también su pata dual), y todas rechazan si el `ownerRef`
no matchea. Cada test asierta el balance antes y después del request. Un test
que sólo mirara el status no probaría nada: el status ya era correcto antes del
fix.

| Test | Qué prueba |
|---|---|
| T-192-1 | 503 not-operational → balance 100 → 100; credit 1 sola vez, con `owner_ref`; balance no inflado |
| T-192-2 | 500 `not-moved` → balance vuelve |
| T-192-3 | 500 `unknown` → balance QUEDA en 95, cero credit, cero outbox, log `refund-skipped.settlement-unknown` |
| T-192-4 | `status()` tira → sigue 500, balance vuelve |
| T-192-5 | happy path → cobra exactamente lo de siempre (95), sin credit |
| T-192-6 | error no clasificado → NO reembolsa (fail-safe) |
| T-192-7 | delegación → `creditDelegation` con el contexto correcto; padre **y** `total_spent` vuelven; nunca `credit` solo |
| T-192-8 | key-session → `creditSession`; padre **y** `spent_usd` vuelven |
| T-192-9 | credit `success:false` → 503 igual + outbox `gasless-route.refund-failed:not-operational` |
| T-192-10 | credit tira → 503 igual + outbox `gasless-route.refund-threw:not-operational` |
| T-192-11 | credit tira **y** outbox tira → 503 igual, log `[gasless.refund-outbox-threw]` |
| T-192-12 | `skipMiddlewareDebit` (hook de instancia) → 503 sin débito y **sin credit**: no hay refund fantasma |

### Cobertura de las líneas nuevas (v8, sólo estos 2 archivos de test)

Todas las líneas de refund agregadas tienen ≥1 hit:

```
219 (entrada del helper)  10   231 (try)           9    232 (dispatch credit)  9
228 (guard sin débito)     1   254 (!success)      5    267 (outbox failed)    1
275 (log refunded)         6   277/288/292 (catch) 1-6  302 (outbox threw)     1
374 (refund status-failed) 1   379 (refund 503)    8    424/425 (500 not-moved) 3/1
427 (skip unknown)         2
```

Las únicas líneas sin hits del archivo (84, 88, 93, 97, 338, 345) son
**pre-existentes** (replies de chain-resolution y el catch de `GET /status`), no
código de esta HU.

### Mutación — 9 mutaciones, 9 muertas

Harness: copia del archivo, mutación con python, `vitest run` sobre
`gasless.refund.test.ts` + `gasless.test.ts`, restauración y `diff` para
confirmar árbol limpio.

| # | Mutación | Resultado | Tests que la matan |
|---|---|---|---|
| M1 | quitar el refund del 503 | **RED** 6 fallos | T-192-1, 7, 8, 9, 10 + `gasless.test.ts:T-AC3-ROUTE` |
| M2 | quitar el refund del `status()` que tira | **RED** 1 | T-192-4 |
| M3 | quitar el refund del 500 `not-moved` | **RED** 1 | T-192-2 |
| M4 | reembolsar SIEMPRE en el 500 (ignorar `valueDisposition`) | **RED** 2 | T-192-3, T-192-6 (prueban el sobre-refund) |
| M5 | `credit` con `owner_ref` ajeno (IDOR) | **RED** 4 | T-192-1, 2, 4 + `T-AC3-ROUTE` |
| M6 | quitar el ruteo dual-ledger de delegación | **RED** 1 | T-192-7 |
| M6b | quitar el ruteo dual-ledger de sesión | **RED** 1 | T-192-8 |
| M7 | quitar el outbox del credit que no revirtió | **RED** 1 | T-192-9 |
| M8 | quitar el outbox del credit que tiró | **RED** 1 | T-192-10 |

---

## Archivos tocados

| Archivo | Qué |
|---|---|
| `src/adapters/errors.ts` | `GaslessValueDisposition` + campo obligatorio en `GaslessTransferError` |
| `src/adapters/avalanche/gasless.ts` | clasificación de los 8 throw sites |
| `src/adapters/base/gasless.ts` | idem (espejo) |
| `src/adapters/kite-ozone/gasless.ts` | separa sign (`not-moved`) de submit al relayer (`unknown`); mensajes preservados |
| `src/routes/gasless.ts` | `refundGaslessDebit` + `classifyGaslessFailure` + 3 call-sites + `status()` dentro de try; docblock corregido |
| `src/routes/gasless.refund.test.ts` | **nuevo** — 12 tests con ledger stateful |
| `src/routes/gasless.test.ts` | mocks de `credit*`/`refundOutbox`; `T-AC3-ROUTE` asierta el credit-back |
| `src/adapters/__tests__/avalanche.test.ts` | 5 tests de `valueDisposition` |
| `src/adapters/__tests__/base.test.ts` | 2 tests de `valueDisposition` |
| `src/adapters/__tests__/gasless.contract.test.ts` | 2 tests de `valueDisposition` (kite) |

Sin cambios en prod, env, migraciones ni credenciales. Cero requests a hosts
externos en los tests (el outbox está mockeado en los dos archivos de test que
ejercitan el refund).

---

## Follow-ups propuestos (no en esta HU)

1. **HU: refund-on-failure del rail x402 (pago on-chain)** — decidir qué hacer
   con el caller que settlea on-chain y recibe un error: ¿refund on-chain?
   ¿mover el guard ANTES del pago? Alcanza a `/registries` (403
   `A2A_KEY_REQUIRED`), a `/tasks` y **también al `/gasless/transfer` arreglado
   en esta HU**: su rail x402 sigue cobrando $1 on-chain en el 503 (ver la fila
   de `gasless` en el barrido), donde `refundGaslessDebit` es no-op por diseño
   (sin `a2aKeyRow` no hay ledger que revertir).
2. **HU: refund-on-failure en `/registries` (3 rutas)** — el $1 de
   `PLACEHOLDER_FEE_USD` del rail prepago, no reembolsado en ninguno de sus ~10
   puntos de retorno.
3. **HU: refund-on-failure en `/tasks` (5 endpoints)** — $1 por 400/404/409,
   incluidos los GET.
4. **HU: reconciliación del `valueDisposition: 'unknown'`** — hoy queda un log
   loud (`gasless.refund-skipped.settlement-unknown`). Un job que verifique la tx
   on-chain y reembolse si nunca confirmó cerraría el último hueco sin riesgo de
   doble pago.
