# HU-193 — No cobrar antes de validar (`/registries` + `/tasks`)

Branch: `fix/no-charge-before-validating` · base `main@5762c03`

## 1. El problema

`/registries` (POST/PATCH/DELETE) y `/tasks` (POST `/`, GET `/`, GET `/:id`,
PATCH `/:id/status`, PATCH `/:id`) cobran en el middleware de pago, que corre
ANTES del handler. Todo rechazo del handler (400/403/404/409/422, y un 500 en
`/tasks`) llegaba con el cobro hecho y sin contraprestación.

Los dos rieles no son simétricos:

| | Prepago (Agent Key) | x402 |
|---|---|---|
| Qué se cobra | un número en la DB (`budget` jsonb) | una tx **on-chain** |
| ¿Reversible? | sí (`budgetService.credit*`) | **no**: el caller puede no tener cuenta con nosotros, no hay saldo interno que acreditar |
| Quién paga el gas del cobro | nadie (no hay tx) | **nosotros**: `middleware/x402.ts:567` → `settle()` → el facilitator firma con `OPERATOR_PRIVATE_KEY` (`wasiai-facilitator/src/infra/wallet.ts:48`) |

O sea que ante un pedido malformado, en el riel x402 pagábamos gas para cobrar
una plata que no devolvemos por un servicio que no dimos.

## 2. El principio: NO COBRAR, no reembolsar

**Regla que encarna el componente** (`src/middleware/charged-route.ts`, docstring):

- **Error por la FORMA del pedido** (cuerpo malformado, campo faltante, tipo
  incorrecto, parámetro fuera de rango, credencial ausente): se decide con lo que
  mandó el caller, se valida ANTES y **no se cobra**. Aplica a los dos rieles.
- **Error de EJECUCIÓN** (el agente downstream falló, el RPC dio timeout, la
  transferencia revirtió, el recurso no existe / no es tuyo / está en estado
  terminal): no se puede prever sin I/O ni sin saber quién llama. Ahí el
  reembolso sigue siendo la única herramienta, y por eso **HU-188 (`/compose`) y
  HU-192 (`/gasless`) siguen siendo necesarias y no las reemplaza esta HU**.

### Por qué "no cobrar" le gana a "cobrar y devolver" incluso en el prepago

1. **Contadores de límite inflados — bug REAL ya ocurrido.** `src/services/budget.ts:543-555`:
   refundear vía `credit()`/`creditWithDest()` sólo tocaba el parent, así que
   `a2a_delegations.total_spent` **quedaba inflado con dinero ya reembolsado
   (self-DoS de la delegación)**: un caller con muchos pedidos malformados se
   auto-bloqueaba contra su propio límite total aunque le hubieran devuelto todo.
   Se parcheó con el credit dual-ledger (`refund_delegation_and_parent`), pero
   **ese parche existe sólo porque el cobro ocurrió**. No cobrar elimina la clase
   de bug, no una instancia.
2. **Ventana de saldo incorrecto** entre el débito y el crédito: una llamada
   concurrente del mismo caller puede recibir `INSUFFICIENT_BUDGET` sin que le
   falte saldo. Es una carrera que sólo existe porque se cobró de más temprano.
3. **Ruido en el rastro de dinero**: cada rechazo cobrado deja recibos de débito,
   de crédito y de comisión, que ensucian la cadena de recibos y la pantalla
   `/dashboard/trace`. Un cobro que no ocurrió no deja ninguno.
4. **Gas**: ver arriba. Cada pedido inválido que hoy se cobra nos cuesta gas por
   una tx que después no sirve para nada.

## 3. El componente (y cuán fuerte es la obligación)

`chargedRoute({ validate, payment, hooks? })` (`src/middleware/charged-route.ts`)
devuelve la cadena COMPLETA de preHandlers: `[validación de forma, cobro]`. Las
8 rutas del alcance ya no llaman `requirePaymentOrA2AKey`.

Capas de obligación:

1. **Tipos.** `validate` es un campo **requerido** y sin default. El opt-out no es
   `[]` silencioso: es `{ skip: '<motivo escrito>' }`, que queda firmado en el
   código y visible en la marca del handler. Además `PreChargeCheck` es
   **síncrona** y recibe `PreChargeInput` (`body`/`params`/`query`/`headers`), no
   el `FastifyRequest`: por construcción no puede hacer I/O ni leer
   `a2aKeyRow`/`resolvedChainId`, así que no se puede colar una validación de
   ejecución disfrazada de forma.
2. **Test de estructura.** `src/routes/charged-routes.meta.test.ts` recorre las
   rutas REALMENTE registradas (hook `onRoute`, mismo patrón que
   `registries.redaction.test.ts:T-RRED-05`) y falla si alguna tiene un handler
   marcado `CHARGES_CALLER` (marca puesta en `requirePaymentOrA2AKey` y en
   `requirePayment`) sin un `PRE_CHARGE_VALIDATION` **antes** en la cadena. La
   lista de excepciones legacy está **congelada**.

**Límite honesto**: la capa 1 **no** es total hoy. `requirePaymentOrA2AKey` sigue
exportado y `/compose`, `/orchestrate` (×3) y `/gasless/transfer` lo llaman
directo; no se migran en esta HU (pedido explícito: mejor un componente probado en
8 rutas que un refactor grande sin verificar). Mientras ese export exista, el
compilador no puede impedir el bypass; lo impide el test de estructura, que es lo
más fuerte que se puede hacer sin migrar todo. **Qué falta para volverla total**:

- `/compose`: ya valida el shape pre-cobro (`validateComposeBodyHandler`, HU-188),
  pero su cadena tiene además `requireForwardKey()`, `createTimeoutHandler(...)` y
  el preHandler de precio (que hace I/O: discovery del step-0) ENTRE la validación
  y el cobro, y pasa `hooks.onDebitOrphaned`. Migrarla pide un slot
  `beforeCharge?: preHandlerAsyncHookHandler[]` en el spec (el `hooks` ya está).
- `/orchestrate` ×3: mismo caso más el rate-limit; `/plan` y `/execute` setean
  `skipMiddlewareDebit` (no debitan prepago) pero **el riel x402 sí settlea**, así
  que su residuo x402 merece su propia HU.
- `/gasless/transfer`: su preHandler de costo hace I/O (estimación) y su refund ya
  vive en el handler (HU-192).
- Recién cuando esas 5 estén migradas se puede dejar de exportar
  `requirePaymentOrA2AKey` fuera de `charged-route.ts` y la capa 1 pasa a ser total.

## 4. LA TABLA DEL RESIDUO (deliverable principal)

Residuo = rechazos que **siguen ocurriendo después del cobro** porque no se pueden
decidir pre-cobro (necesitan I/O y/o el `owner_ref` del caller autenticado).

Convención de la columna "riel": después del fix, los 8 endpoints rechazan el riel
x402 **pre-cobro** con 403 `A2A_KEY_REQUIRED` (ninguno puede operar sin identidad
de tenant, WKH-63), así que **ningún caso residual le pega al x402**.

### `/registries`

| # | Endpoint | Status residual | Por qué no se pudo adelantar | Riel afectado | Reembolsado |
|---|----------|-----------------|------------------------------|---------------|-------------|
| R1 | POST `/registries` | 422 `SSRF_BLOCKED` | `validateRegistryUrl` hace **DNS** (`dns.lookup`). Un `PreChargeCheck` es síncrono a propósito: adelantarlo convertiría un endpoint impago en amplificador de I/O y en oráculo de resolución de nombres internos | prepago | sí (`registries.post:ssrf-blocked`) |
| R2 | POST `/registries` | 400 `Failed to register registry` | Colisión de PK (**read a la DB**) y reglas de `name` que viven dentro del service, todas mapeadas a un 400 genérico (F-05). Adelantarlas duplicaría la regla fuera de su fuente | prepago | sí (`registries.post:register-failed`) |
| R3 | PATCH `/registries/:id` | 422 `SSRF_BLOCKED` | idem R1 | prepago | sí |
| R4 | PATCH `/registries/:id` | 404 `Registry not found` | Ownership: **read + `owner_ref` del caller** (disclosure-safe, no distingue "no existe" de "no es tuyo") | prepago | sí |
| R5 | PATCH `/registries/:id` | 403 `System registry is immutable` | Depende del `owner_ref` de la fila (**read**) | prepago | sí |
| R6 | PATCH `/registries/:id` | 400 `Failed to update registry` | Fallo del UPDATE (**DB**) | prepago | sí |
| R7 | DELETE `/registries/:id` | 404 `Registry not found` | idem R4 (incluye la race `deleted === false`) | prepago | sí |
| R8 | DELETE `/registries/:id` | 403 `System registry is immutable` | idem R5 | prepago | sí |
| R9 | DELETE `/registries/:id` | 400 `Failed to delete registry` | Fallo del DELETE (**DB**) | prepago | sí |

### `/tasks`

| # | Endpoint | Status residual | Por qué no se pudo adelantar | Riel afectado | Reembolsado |
|---|----------|-----------------|------------------------------|---------------|-------------|
| T1 | POST `/tasks` | 500 (fallo de `taskService.create`) | Fallo de I/O contra la DB | prepago | **NO** — ver §5 |
| T2 | GET `/tasks` | 500 (fallo de `taskService.list`) | idem | prepago | **NO** (idem: no cambia estado, pero tampoco entrega la lectura; se deja explícito abajo) |
| T3 | GET `/tasks/:id` | 404 `Task not found` | Ownership: **read + `owner_ref`**, indistinguible de "no existe" a propósito | prepago | sí (`tasks.get-one:not-found`) |
| T4 | PATCH `/tasks/:id/status` | 404 `Task not found` | idem | prepago | sí |
| T5 | PATCH `/tasks/:id/status` | 409 estado terminal | El estado se lee de la fila (**read**) | prepago | sí |
| T6 | PATCH `/tasks/:id` | 404 `Task not found` | idem T3 | prepago | sí |
| T7 | PATCH `/tasks/:id` | 409 estado terminal | idem T5 | prepago | sí |

### Los números concretos

| Métrica | Valor |
|---|---|
| Endpoints en alcance | **8** |
| Casos residuales totales (post-fix) | **16** (9 en `/registries` + 7 en `/tasks`) |
| Casos residuales que le pegan al riel **x402** | **0** |
| Casos residuales que le pegan al riel **prepago** | **16** |
| Residuales prepago **reembolsados** en esta HU | **14** |
| Residuales prepago NO reembolsados (decisión, §5) | **2** (T1, T2 — los 500 de fallo de DB) |
| Statuses que ANTES cobraban y ahora **no llegan a cobrar** | 403 `A2A_KEY_REQUIRED` (×8 endpoints), 400 de forma (×1 en registries, ×7 combinaciones en tasks), y el **500** de `/tasks` en el riel x402 |

**Para la decisión del founder**: con este fix **no hace falta reembolso on-chain**
para estos 8 endpoints, porque el riel x402 dejó de tener casos residuales (0/16).
El único trabajo x402 pendiente está fuera de este alcance: `/orchestrate/plan` y
`/orchestrate/execute` settlean el challenge x402 aunque documenten "zero-debit",
y `/compose`/`/gasless` tienen residuo de EJECUCIÓN, que es irreembolsable en x402
por definición (el valor ya se movió downstream).

## 5. La trampa de HU-192: antes de reembolsar, ¿pudo moverse el valor?

`GaslessValueDisposition` (`src/adapters/errors.ts:23-71`) enseñó que refundear en
todo error puede ser peor que el bug: los adapters lanzan **después** de
broadcastear y el refund regala la transferencia más el saldo.

Aplicado acá:

- Los 14 residuales reembolsados **no mueven valor**: `/registries` y `/tasks` no
  invocan agentes downstream ni firman transacciones. El único movimiento posible
  es el propio débito, y los rechazos ocurren antes de cualquier escritura
  confirmada (pre-fetch de ownership, o UPDATE/DELETE atómico que falló).
- **T1 (`POST /tasks` → 500) NO se reembolsa a propósito**: un fallo de I/O es
  **ambiguo**. Si la DB commiteó el insert y se cayó la conexión al responder, la
  task EXISTE y el caller la puede leer: reembolsar ahí sería regalar el recurso
  entregado, exactamente el error de HU-192. Sin una señal fiable de "no se
  escribió nada" (idempotency key, o un `create` que devuelva el estado
  confirmado), lo correcto es no devolver.
- **T2 (`GET /tasks` → 500) tampoco**: no hay ambigüedad de estado, pero tampoco
  hay un camino de rechazo explícito en el handler (el throw sube al error handler
  de Fastify). Meter un refund ahí exigía envolver el handler en try/catch y
  cambiar el manejo de errores de la ruta, que está fuera del alcance. Queda
  documentado como residuo conocido, no silenciado.

## 6. Efecto colateral declarado: el 402 que pasa a 403/400

Al validar antes de autenticar, un pedido sin credencial válida recibe **403** (o
**400** si el cuerpo está malformado) en lugar del **402 challenge**. Mismo espíritu
que `TD-188-5` en `/compose`.

Dos sub-casos, con su análisis de riesgo:

1. **403 `A2A_KEY_REQUIRED` antes del 402.** Es lo que evita el cobro por un
   rechazo garantizado. Lo único que revela es "este endpoint necesita una
   a2a-key", que ya está documentado en `doc/INTEGRATION.md`. **Cambio de contrato
   real**: `doc/INTEGRATION.md` anunciaba que `POST /registries` responde 402 con
   `accepts[]` cuando no hay auth; ahora responde 403. Se corrigió el documento.
   En `/tasks` el cambio es a favor del caller de forma más cruda: antes pagaba
   on-chain y recibía **500**.
2. **400 de forma antes del 402.** Acá sí hay un oráculo, y no lo minimizo: un
   caller que mande un `x-a2a-key` **cualquiera** (la presencia se chequea sin
   validar) puede sondear la forma esperada del cuerpo sin pagar. Qué se filtra en
   concreto: los nombres de campos requeridos de `POST /registries` (que ya están
   en el README/INTEGRATION con un `curl` de ejemplo), el formato UUID del `:id` de
   `/tasks` y el conjunto de `status` válidos (que es el enum público del protocolo
   A2A). Nada de eso es tenant-specific ni deriva de la DB: los checks son puros y
   no hacen ningún read, así que **no se puede usar para enumerar recursos, ids ni
   owners**. Mi lectura: el riesgo es real pero acotado a información ya pública, y
   el orden de la cadena lo limita más (el 403 de presencia corre PRIMERO, así que
   un caller sin ningún header no llega ni al oráculo). Lo que **sí** habría sido un
   riesgo nuevo de verdad es adelantar el guard SSRF: `validateRegistryUrl` resuelve
   DNS, y pre-cobro le habría dado a cualquiera un oráculo de "¿este hostname
   interno existe y resuelve a una IP privada?" (DNS split-horizon). Por eso el 422
   quedó como residuo reembolsado y `PreChargeCheck` es síncrona por tipo, no por
   convención.

## 7. Reporte pedido: el cobro de $1 en los GET de `/tasks`

**No lo cambié** (precio = decisión de producto). Mi lectura, para el founder:

- `GET /tasks` y `GET /tasks/:id` cobran `PLACEHOLDER_FEE_USD` = **$1** por una
  lectura de una fila propia. Es el mismo precio que crear una task o que un
  `/compose` de un step. Un cliente que pollee el estado de una task cada 5s paga
  **$720/hora** por leer su propio dato.
- Peor: Fastify registra automáticamente los `HEAD` hermanos de cada `GET`
  (`exposeHeadRoutes`), con la MISMA cadena de preHandlers. O sea que un
  `HEAD /tasks` también cobra $1 (queda a la vista en
  `charged-routes.meta.test.ts:T-META-03`).
- Consecuencia práctica: el ciclo de vida A2A normal (crear → pollear estado →
  appendear) es económicamente hostil, y empuja al integrador a evitar el polling
  o a cachear del lado del cliente, justo lo contrario de lo que pide el protocolo.
- Mi lectura: **es un error de precio, no de flujo**. El flujo (cobrar antes de
  ejecutar) es correcto para una escritura; el problema es que un read idempotente
  cuesta lo mismo que una escritura. Opciones que quedan sobre la mesa (todas de
  producto): precio propio por método (reads a $0 o a un centavo), reads gratis
  bajo Agent Key con rate-limit, o cobro por página en el list.
- **Lo NO decidido**: si los reads pasan a $0, el riel x402 en `/tasks` se vuelve
  discutible por otro motivo (¿tiene sentido un challenge de $0?). Eso es parte de
  la misma decisión de producto.

## 8. Verificación

- `npx tsc --noEmit` → 0 errores.
- `npx biome check src/` → 0.
- `npx vitest run` → **3573 passed | 11 skipped** (baseline `main`: 3511 | 11; +62
  tests nuevos, 0 regresiones).
- Mutación (17 mutantes, todos matados): ver `auto-blindaje.md` §Mutación.
- Cobertura de las líneas nuevas: `charged-route.ts` + `charge-brand.ts` 100%
  stmts/branch/func/line; `step0-refund.ts` 100% líneas (17/17); `step0-debit.ts`
  100% (con las suites de compose+gasless+registries, que ejercitan las 3 ramas del
  monto). Único código nuevo sin hits: los guards **defense-in-depth** duplicados en
  los handlers (`registries.ts:183,237,351,405`; `tasks.ts:169,232,265,269,274,320,324`),
  inalcanzables vía HTTP porque el check pre-cobro gana. Se conservan a propósito
  (precedente HU-188 `compose.ts:630-636`) y se declaran acá para que nadie los lea
  como cobertura real.

## 9. Archivos

Nuevos:
- `src/middleware/charged-route.ts` — el componente + `requireA2AKeyPresence`.
- `src/middleware/charge-brand.ts` — marcas `CHARGES_CALLER` / `PRE_CHARGE_VALIDATION`.
- `src/lib/step0-debit.ts` — fuente única del monto step-0.
- `src/lib/step0-refund.ts` — credit-back del residuo prepago.
- Tests: `src/middleware/charged-route.test.ts`, `src/lib/step0-refund.test.ts`,
  `src/routes/charged-routes.meta.test.ts`,
  `src/routes/registries.no-charge-before-validating.test.ts`,
  `src/routes/tasks.no-charge-before-validating.test.ts`.

Modificados:
- `src/routes/registries.ts`, `src/routes/tasks.ts` — cadena vía `chargedRoute` +
  refunds del residuo.
- `src/middleware/a2a-key.ts` — `extractRawKeyFromHeaders` (aditivo), monto step-0
  desde `lib/step0-debit.ts`, marca `CHARGES_CALLER`.
- `src/middleware/x402.ts` — marca `CHARGES_CALLER`.
- `doc/INTEGRATION.md` — contrato público (auth de `/tasks`, 403 pre-cobro, qué NO
  se reembolsa).
- Mocks de `a2a-key` en 4 suites existentes (`extractRawKeyFromHeaders`).
