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
   código, visible en la marca del handler y **congelado por T-META-05** (usarlo
   obliga a tocar el test, así que aparece en el diff). Además `PreChargeCheck` es
   **síncrona** y recibe `PreChargeInput` (`body`/`params`/`query`/`headers`) en
   **vista inmutable**, no el `FastifyRequest`. Qué garantiza eso, con precisión:
   - no puede leer `a2aKeyRow`/`resolvedChainId` (no existen en el input);
   - no puede **decidir** con el resultado de una I/O **asíncrona** — todas las
     fuentes que importan acá son promesas (`dns.lookup` del guard SSRF,
     `supabase-js`, los RPC, `fetch`) y un check sin `Promise` en el tipo de
     retorno no puede esperarlas. Esa es la propiedad que sostiene el
     razonamiento del SSRF (§6.2), no "cero I/O": la I/O **síncrona**
     (`fs.readFileSync`, `execSync`) sigue siendo alcanzable desde JS y eso no lo
     puede impedir un tipo. El AR probó el caso (`fs.existsSync` en un check
     devuelve `true`), tenía razón, y el docstring se corrigió para afirmar
     exactamente lo que vale;
   - no puede **mutar** lo que el handler valida después. `readonly` en la
     interfaz protege el binding, no el objeto: el AR hizo
     `(input.body as Record<string, unknown>).injected = 'MUTATED'` y el handler
     vio el cuerpo mutado. Ahora los cuatro campos van envueltos en un Proxy
     recursivo de sólo-lectura (`readonlyView`, `charged-route.ts`) y toda
     escritura lanza ANTES del cobro. Se eligió el Proxy sobre `Object.freeze`
     (que mutaría el objeto real del request y le quitaría al handler la
     capacidad de mutarlo, en silencio) y sobre `structuredClone` (que costaría
     una copia del body en el money-path): no copia, no toca el original y su
     coste es O(1) por propiedad leída.
2. **Test de estructura.** `src/routes/charged-routes.meta.test.ts` recorre las
   rutas REALMENTE registradas (hook `onRoute`, mismo patrón que
   `registries.redaction.test.ts:T-RRED-05`) y falla si alguna tiene un handler
   marcado `CHARGES_CALLER` (marca puesta en `requirePaymentOrA2AKey` y en
   `requirePayment`) sin un `PRE_CHARGE_VALIDATION` **antes** en la cadena. La
   lista de excepciones legacy está **congelada**.
   **Alcance = la app entera.** La primera versión registraba 5 plugins a mano, así
   que una ruta futura que cobrara en cualquiera de los otros ~14 (`payments`,
   `auth`, `agents`×3, `inbound`, `dashboard`, `well-known`, `receipts`, `mcp`, …)
   era invisible: el claim "una ruta nueva que cobre sin validar rompe el test" no
   se sostenía para el futuro, que es justo para lo que existe el guard. Ahora la
   lista de plugins **se deriva de `src/index.ts`** (se parsea el fuente y se lee
   cada `fastify.register(<plugin>, { prefix })`; no se puede importar `index.ts`
   porque es el entrypoint y levanta el server) y **T-META-06** exige que el set
   escaneado sea exactamente el de la app: agregar un plugin sin escanearlo rompe
   el test. Verificado por mutación en las dos direcciones: una ruta que cobra sin
   validar en `/payments` (invisible para el guard viejo, **sobrevivía**) hoy pone
   rojo T-META-01, y sacar un plugin del set pone rojo T-META-06.

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
| T1 | POST `/tasks` | 500 (lanza `taskService.create`) | Fallo de I/O contra la DB | prepago | **NO** — decisión, ver §5 |
| T2 | GET `/tasks` | 500 (lanza `taskService.list`) | idem | prepago | sí (`tasks.list:read-failed`) |
| T3 | GET `/tasks/:id` | 404 `Task not found` | Ownership: **read + `owner_ref`**, indistinguible de "no existe" a propósito | prepago | sí (`tasks.get-one:not-found`) |
| T4 | GET `/tasks/:id` | 500 (lanza `taskService.get`) | Fallo de I/O contra la DB | prepago | sí (`tasks.get-one:read-failed`) |
| T5 | PATCH `/tasks/:id/status` | 404 `Task not found` | idem T3 | prepago | sí |
| T6 | PATCH `/tasks/:id/status` | 409 estado terminal | El estado se lee de la fila (**read**) | prepago | sí |
| T7 | PATCH `/tasks/:id/status` | 500 (cualquier otro throw: el `throw err` genérico del catch) | Fallo de I/O contra la DB, en el read previo o en el UPDATE | prepago | sí (`tasks.patch-status:failed`) |
| T8 | PATCH `/tasks/:id` | 404 `Task not found` | idem T3 | prepago | sí |
| T9 | PATCH `/tasks/:id` | 409 estado terminal | idem T6 | prepago | sí |
| T10 | PATCH `/tasks/:id` | 500 (`throw err` genérico) | idem T7 | prepago | sí (`tasks.patch-append:failed`) |

### Los números concretos

| Métrica | Valor |
|---|---|
| Endpoints en alcance | **8** |
| Casos residuales totales (post-fix) | **19** (9 en `/registries` + 10 en `/tasks`) |
| Casos residuales que le pegan al riel **x402** | **0** |
| Casos residuales que le pegan al riel **prepago** | **19** |
| Residuales prepago **reembolsados** | **18** |
| Residuales prepago NO reembolsados (decisión, §5) | **1** (T1: el 500 de `POST /tasks`) |
| Statuses que ANTES cobraban y ahora **no llegan a cobrar** | 403 `A2A_KEY_REQUIRED` (×8 endpoints), 400 de forma (×1 en registries, ×7 combinaciones en tasks), y el **500** de `/tasks` en el riel x402 |

### Corrección del inventario (AR, BLQ-BAJO-1)

La primera versión de esta tabla declaraba **16 residuales / 2 sin reembolso**.
Estaba **corta**: los CINCO handlers de `/tasks` cobran y no devolvían nada cuando
el service lanza, no dos. El AR lo probó handler por handler, con el middleware
real y el service en `mockRejectedValue`:

```
POST   /tasks                -> 500 debit=1 credit=0 bal=9
GET    /tasks                -> 500 debit=1 credit=0 bal=9
GET    /tasks/<uuid>         -> 500 debit=1 credit=0 bal=9   <- faltaba en la tabla
PATCH  /tasks/<uuid>/status  -> 500 debit=1 credit=0 bal=9   <- faltaba
PATCH  /tasks/<uuid>         -> 500 debit=1 credit=0 bal=9   <- faltaba
```

Números reales del inventario: **19 residuales / 5 sin reembolso** antes de este
fix-pack; **19 / 1** después. La conclusión x402 NO cambia (sigue siendo 0/19,
verificada aparte). Por qué el inventario quedó corto: se recorrieron los caminos
de rechazo EXPLÍCITOS (cada `return reply.status(...)`) y no los `throw` que caen
al error boundary, que son igual de cobrados. La lección está en el
`auto-blindaje.md`. Cada uno de los 5 caminos tiene hoy un test que mira el
BALANCE (T-NCT-21..25) y una mutación que lo pone rojo.

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

Aplicado acá, el criterio es **una sola pregunta: ¿el camino pudo haber escrito
algo o entregado algo?**

- **Los 15 residuales que no son 500** (R1..R9, T3, T5, T6, T8, T9) **no mueven
  valor**: `/registries` y `/tasks` no invocan agentes downstream ni firman
  transacciones. El único movimiento posible es el propio débito, y esos rechazos
  ocurren antes de cualquier escritura confirmada (pre-fetch de ownership, o
  UPDATE/DELETE atómico que falló). Se reembolsan.
- **Los dos 500 de LECTURA se reembolsan** (T2 `GET /tasks`, T4 `GET /tasks/:id`).
  Acá no hay ninguna ambigüedad de estado que proteger: son lecturas, no escriben
  nada y no entregaron nada. El caller pagó $1 por un error nuestro. Que el throw
  suba al error boundary no era una razón para no devolver: el `try/catch` que hace
  falta es local al handler, no cambia el status (el 500 lo sigue produciendo el
  error boundary) y cabe en cinco líneas. **Este era el argumento equivocado de la
  primera versión** ("fuera de alcance"), y el AR tuvo razón en desarmarlo.
- **Los dos 500 genéricos de los PATCH se reembolsan** (T7, T10), con su riesgo
  residual DECLARADO. El caso dominante es que nada se escribió: `updateStatus` y
  `append` primero LEEN la fila (un fallo del read no toca nada) y un UPDATE que
  reporta error tampoco aplicó. El caso incómodo existe y no lo escondo: si el
  UPDATE hubiera commiteado y sólo se perdiera la respuesta, el reembolso regala
  una transición ya aplicada. Se acepta porque (a) lo que se regala es una
  mutación sobre la propia task del caller, por $1, (b) la ventana es angosta
  (commit + caída al responder) y (c) los casos sin escritura son mucho más
  frecuentes. Lo que **eliminaría** el riesgo del todo es un error tipado por
  etapa en el service (`read-failed` vs `write-failed`), que es la deuda que queda
  anotada; no se hizo acá porque toca `services/task.ts` (money-path de otras
  suites) por un caso de $1.
- **T1 (`POST /tasks` → 500) NO se reembolsa, y se declara**: un fallo del insert
  es **ambiguo en el sentido caro**. Si la DB commiteó y se cayó la conexión al
  responder, la task EXISTE, es listable con `GET /tasks` y el caller la puede
  usar: reembolsar ahí sería regalar un recurso ENTREGADO, exactamente el error de
  HU-192. Sin una señal fiable de "no se escribió nada" (idempotency key, o un
  `create` que confirme el estado), la dirección segura es no devolver. La
  diferencia con T7/T10 no es de tipo sino de qué se regalaría: un recurso nuevo y
  usable versus una mutación de algo que el caller ya tenía.
  El contrato público lo dice con su status y su consecuencia práctica
  (`doc/INTEGRATION.md` §5.1: no reintentar a ciegas un 500 de `POST /tasks`), y
  **T-NCT-25 congela la decisión**: si alguien agrega el refund, el test falla y
  obliga a actualizar el contrato en el mismo diff.

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
   convención: `dns.lookup` es asíncrona, así que un check **no puede esperar su
   resultado** y por lo tanto no puede decidir con él (la formulación exacta de esa
   garantía está en §3.1, corregida tras el AR: no es "cero I/O", es "sin oráculo
   asíncrono").

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
- `npx biome check src/` → 0 (375 archivos).
- `npx vitest run` → **3583 passed | 11 skipped** (baseline `main`: 3511 | 11; +72
  tests nuevos, 0 regresiones. El fix-pack del AR agregó 10: T-NCT-21..25,
  T-CR-10..12, T-META-05..06).
- Mutación (**28 mutantes, todos matados**): ver `auto-blindaje.md` §Mutación. Los
  11 del fix-pack cubren cada refund nuevo por separado, la decisión de NO
  reembolsar el `create` (mutante en la dirección contraria: agregar el refund pone
  rojo T-NCT-25), el alcance del guard y la vista inmutable.
- Cobertura de las líneas nuevas: `charged-route.ts` (con `readonlyView` y las 4
  trampas del Proxy) + `charge-brand.ts` **100%** stmts/branch/func/line;
  `step0-refund.ts` 100% líneas (17/17); `step0-debit.ts` 100% (con las suites de
  compose+gasless+registries, que ejercitan las 3 ramas del monto). Los 4 refunds
  nuevos de `tasks.ts` y sus `try/catch` tienen hits (T-NCT-21..24). Único código
  nuevo sin hits: los guards **defense-in-depth** duplicados en los handlers
  (`registries.ts:183,237,351,405`; `tasks.ts:176,257,295,299,304,360,364`),
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
  refunds del residuo (en `tasks.ts`, también los 4 refunds de los 500 del
  fix-pack: los dos `try/catch` de las lecturas y los dos `throw err` genéricos).
- `src/middleware/a2a-key.ts` — `extractRawKeyFromHeaders` (aditivo), monto step-0
  desde `lib/step0-debit.ts`, marca `CHARGES_CALLER`.
- `src/middleware/x402.ts` — marca `CHARGES_CALLER`.
- `doc/INTEGRATION.md` — contrato público (auth de `/tasks`, 403 pre-cobro, qué NO
  se reembolsa).
- Mocks de `a2a-key` en 4 suites existentes (`extractRawKeyFromHeaders`).
