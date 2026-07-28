# Auto-Blindaje — HU-193 (no cobrar antes de validar)

## Errores cometidos y corregidos en la sesión

### [2026-07-27] W1 — El mock de `a2a-key` de 4 suites rompió al meter el componente
- **Error**: 21 tests de `/registries` y `/tasks` pasaron a 500. Los archivos
  `registries.ownership|ssrf|redaction.test.ts` y `tasks.test.ts` moquean
  `../middleware/a2a-key.js` con sólo `requirePaymentOrA2AKey`. Al pasar las rutas
  a `chargedRoute` (que importa `extractRawKeyFromHeaders` del mismo módulo), el
  helper llegaba `undefined` y el check de presencia explotaba.
- **Causa raíz**: agregar una dependencia nueva a un módulo que MUCHAS suites
  moquean por completo (`vi.mock` sin `async (orig)`) rompe todas a la vez.
- **Fix**: agregar `extractRawKeyFromHeaders` a los 4 mocks. En
  `registries.ownership.test.ts` se ató a `currentOwner` (`null` = caller x402
  anónimo), que es la simulación que ese archivo ya usaba, así que el guard
  pre-cobro cae en el mismo caso que antes cubría el guard del handler.
- **Aplicar en**: cualquier import nuevo dentro de `middleware/a2a-key.ts` o de un
  módulo que lo importe. Antes de agregarlo, correr
  `grep -rn "vi.mock('../middleware/a2a-key" src/` y ver cuáles son mocks totales.

### [2026-07-27] W1 — El mock de `tasks.test.ts` devolvía un handler suelto, no un array
- **Error**: `chargedRoute` hace `...requirePaymentOrA2AKey(...)` y el mock
  devolvía la función suelta → "is not iterable".
- **Causa raíz**: Fastify acepta `preHandler` como función O array, así que el mock
  venía funcionando aunque no respetara la firma real (que devuelve un array).
- **Fix**: el mock devuelve `[handler]`, como el módulo real.
- **Aplicar en**: cualquier mock de un factory de middleware — replicar la FIRMA,
  no lo mínimo que hace pasar el test.

### [2026-07-27] W1 — `SSRFViolationError(reason, category)` invertido en el mock
- **Error**: en el test nuevo se construyó `new SSRFViolationError('private-ip', 'blocked.internal')`.
  El constructor real es `(reason, category, field?)`.
- **Causa raíz**: se asumió el orden por el nombre del tipo en vez de leer
  `lib/url-validator.ts:63`.
- **Fix**: `new SSRFViolationError('blocked.internal', 'private-ip')` + comentario
  con el orden.
- **Aplicar en**: cualquier `new <Error>` de dominio en tests — leer la firma.

### [2026-07-27] W2 — `Partial<FastifyRequest>` no sirve para probar "campo ausente"
- **Error**: `tsc` falló con TS2379 (`exactOptionalPropertyTypes`) al pasar
  `{ a2aKeyRow: undefined }` / `{ resolvedChainId: undefined }` a un
  `Partial<FastifyRequest>`. Justo los dos guards anti-inflación que había que
  probar.
- **Causa raíz**: con `exactOptionalPropertyTypes: true`, `undefined` no es
  asignable a una propiedad opcional; `Partial<T>` no lo habilita.
- **Fix**: el helper del test toma `Record<string, unknown>` y castea una sola vez.
- **Aplicar en**: cualquier test que fabrique un `FastifyRequest` incompleto.

### [2026-07-27] W2 — `mockResolvedValueOnce(null)` donde el service devuelve `undefined`
- **Error**: TS2345 en el test de `/tasks`; `taskService.get` devuelve
  `Task | undefined`, no `null`.
- **Fix**: `undefined`.
- **Aplicar en**: mockear el tipo de retorno REAL; `!task` acepta ambos, el
  compilador no.

### [2026-07-27] W2 — El meta-test asumió URLs con barra final y olvidó los `HEAD`
- **Error**: `T-META-03/04` fallaron: las URLs registradas son `POST /registries`
  (sin `/`) y Fastify agrega automáticamente `HEAD /tasks`, `HEAD /tasks/` y
  `HEAD /tasks/:id` como hermanos de cada `GET` (`exposeHeadRoutes`).
- **Causa raíz**: se escribió la expectativa de memoria en vez de derivarla del
  `onRoute`.
- **Fix**: expectativa corregida a lo que el hook reporta. Efecto secundario útil:
  quedó documentado que **un `HEAD /tasks` también cobra $1** (dato que fue al
  work-item, §7, para la discusión de precio de los GET).
- **Aplicar en**: cualquier guard basado en `onRoute` — imprimir primero lo que
  reporta el hook y recién entonces congelar la lista.

### [2026-07-27] W2 — Una mutación rompió la sintaxis y el resultado fue "no tests"
- **Error**: la mutación M10 reemplazaba `chainId,` (argumento posicional) por
  `chainId: chainId ?? 0,` y dejó el archivo sin compilar; el corredor informó
  "no tests" y eso podía leerse como "el test no detectó nada".
- **Fix**: mutar la ASIGNACIÓN (`const chainId = request.resolvedChainId ?? 0;`) y
  re-correr. Un mutante que no compila no prueba nada: hay que verificar que el
  mutante compile antes de creerle al resultado.
- **Aplicar en**: toda verificación por mutación.

### [2026-07-27] Fix-pack AR — El inventario del residuo quedó CORTO (BLQ-BAJO-1)
- **Error**: la tabla del residuo (el deliverable principal de la HU) declaraba
  **16 casos / 2 sin reembolso**. Los números reales eran **19 / 5**: los CINCO
  handlers de `/tasks` cobran y no devuelven nada cuando el service lanza, no dos.
  Faltaban `GET /tasks/:id`, `PATCH /:id/status` y `PATCH /:id`. Peor que el
  conteo: `doc/INTEGRATION.md` prometía *"Net cost of a rejected request: 0 … no
  rejection leaves you permanently charged"*, o sea el contrato público afirmaba lo
  CONTRARIO de lo que shipeaba, en el camino del dinero. Un integrador que
  reintentara sobre esos 500 se comía $1 por intento sin saberlo.
- **Causa raíz**: el inventario se armó recorriendo los caminos de rechazo
  **explícitos** (cada `return reply.status(...)` del handler) y NO los `throw` que
  caen al error boundary. Los `throw` no se ven como "rechazos" al leer el handler,
  pero cobran exactamente igual: el débito ya ocurrió en el middleware.
  Y las dos justificaciones del no-reembolso estaban mal aplicadas: el argumento de
  ambigüedad ("el insert pudo commitear") NO aplica a una lectura, que no escribe
  nada; y el de "fuera de alcance" ("habría que envolver el handler en try/catch")
  NO aplica a los dos PATCH, que YA tenían `try/catch` (el refund era una línea
  antes del `throw err`).
- **Fix**: 4 refunds nuevos (los dos GET, con `try/catch` local que re-lanza para
  no cambiar el status, y los dos `throw err` genéricos de los PATCH). `POST /tasks`
  queda SIN reembolso por decisión declarada (el insert pudo commitear y entregar un
  recurso usable), congelada por T-NCT-25. `INTEGRATION.md` §5.1 ya no promete costo
  neto cero: dice cuál es el único camino que se queda con el dólar, con su status
  y con la consecuencia práctica (no reintentar a ciegas un 500 de `POST /tasks`).
- **Aplicar en**: **todo inventario de "qué se cobra y no se devuelve"**. El
  inventario NO son los `return reply.status(4xx)`: hay que recorrer también todos
  los caminos que lanzan (`throw`, `await` sin catch, `throw err` de re-raise) y
  preguntarse por CADA uno si el débito ya ocurrió. Receta concreta:
  `grep -n "throw\|reply.status" <ruta>.ts` y cruzar con el punto de la cadena
  donde cobra el middleware. Y antes de escribir "costo neto 0" en un documento
  público, probarlo con un test por camino que mire el BALANCE.

### [2026-07-27] Fix-pack AR — Casi perdí el fix por mutar sin commitear
- **Error**: al verificar por mutación corrí `git checkout -- src/routes/tasks.ts`
  para restaurar, pero el fix de ese archivo **todavía no estaba commiteado**: el
  checkout lo devolvió al último commit y borró las 6 ediciones del fix-pack. Los
  mutantes M19..M21 siguientes midieron un archivo SIN fix y reportaron 4 tests
  rojos, que se podían leer como "el mutante fue detectado" cuando en realidad no
  quedaba nada que mutar (el `dropline` había abortado por "marker not found" y no
  chequeé el exit code).
- **Causa raíz**: la metodología de mutación de esta HU dice "se comitea el fix, se
  aplica el mutante, se restaura con `git checkout --`", y me salté el primer paso.
  Además silencié la salida del script de mutación con `>/dev/null` sin `|| exit`.
- **Fix**: re-apliqué las 6 ediciones, verifiqué verde (tsc + biome + suites),
  **commiteé**, y recién entonces re-corrí los 11 mutantes. Los scripts ahora
  abortan con exit≠0 si el patrón no aparece y la corrida usa `|| exit 1`.
- **Aplicar en**: toda verificación por mutación. **Nunca** `git checkout --` sobre
  un archivo con cambios sin commitear; y todo mutante tiene que fallar ruidoso si
  su patrón no está (un mutante que no se aplicó "pasa" el test y miente).

### [2026-07-27] Fix-pack AR — El guard estructural miraba 5 de 19 plugins
- **Error**: `charged-routes.meta.test.ts` registraba a mano
  `registries/tasks/compose/orchestrate/gasless`, pero `src/index.ts` registra 19
  plugins. Una ruta futura que cobrara en `payments`, `auth`, `agents`, `dashboard`,
  `inbound`, `receipts` o `mcp` era **invisible** para el guard, contra el claim de
  que "una ruta nueva que cobre sin validar rompe el test". Probado: con el guard
  viejo, un `POST /payments/evil-charge` con `requirePaymentOrA2AKey` y sin
  validación **sobrevivía en verde**.
- **Causa raíz**: se escribió la lista de plugins a mano, o sea la misma clase de
  error que el guard existe para prevenir (una convención escrita a mano que nadie
  verifica contra la realidad).
- **Fix**: la lista se DERIVA de `src/index.ts` (se parsea el fuente: no se puede
  importar, es el entrypoint que levanta el server) y T-META-06 exige
  `plugins(index.ts) === Object.keys(SCANNED)`.
- **Aplicar en**: cualquier guard que afirme algo "sobre toda la app". Si la lista
  de lo que escanea se escribe a mano, el guard sólo cubre el pasado. Derivarla de
  la fuente real, o assertar que coincide con ella.

### [2026-07-27] Fix-pack AR — `{ skip }` era visible pero nadie lo miraba
- **Error**: `chargedRoute({ validate: { skip: 'meh' }, payment })` dejaba el guard
  **100% verde con cero validación**. La marca `PRE_CHARGE_VALIDATION` guardaba el
  motivo (grepeable), pero ningún test lo miraba, así que el opt-out no tenía costo.
- **Causa raíz**: se confundió "queda firmado en el código" con "está controlado".
  Una firma que nadie lee es una convención documentada, exactamente lo que ya
  falló antes.
- **Fix**: T-META-05 congela el set de rutas con `skip` (hoy vacío), igual que
  `LEGACY_UNVALIDATED`. Usar el opt-out obliga a tocar el test → aparece en el diff.
- **Aplicar en**: todo opt-out "firmado". Si no hay un test que enumere quién lo
  usa, el opt-out es gratis.

### [2026-07-27] Fix-pack AR — `readonly` no protege el objeto, sólo el binding
- **Error**: `PreChargeInput` entregaba referencias vivas. El AR hizo
  `(input.body as Record<string, unknown>).injected = 'MUTATED'` dentro de un check
  y **el handler vio el cuerpo mutado**: un check "puro" podía reescribir lo que el
  handler valida y le manda al service.
- **Causa raíz**: `readonly` en TypeScript es shallow y sólo sobre la propiedad; no
  hace nada sobre el objeto apuntado. Se asumió que declarar `readonly` alcanzaba.
- **Fix**: `readonlyView` (Proxy recursivo y perezoso) + `Object.freeze` del
  contenedor. Se descartó `Object.freeze(request.body)` (mutaría el objeto real del
  request y le quitaría al handler la capacidad de mutarlo, en silencio, en todas
  las rutas del componente) y `structuredClone` (una copia del body por request en
  el money-path). Toda escritura lanza en el preHandler de validación, o sea ANTES
  del cobro.
- **Aplicar en**: cualquier tipo que prometa "input inmutable" a un plugin/hook.
  `readonly` documenta la intención; `Object.freeze` o un Proxy la hacen cumplir.

### [2026-07-27] Fix-pack AR — "sin `await` no hay I/O" estaba sobre-afirmado
- **Error**: el docstring de `PreChargeCheck` y el work-item afirmaban que una
  función síncrona no puede hacer I/O. El AR corrió un check con
  `fs.existsSync('/etc/hostname')` y devolvió `true`: la I/O **síncrona** existe.
- **Causa raíz**: se escribió la propiedad que sonaba fuerte en vez de la que el
  diseño realmente garantiza.
- **Fix**: el docstring afirma ahora lo exacto: un check no puede **decidir** con el
  resultado de una I/O **asíncrona** (DNS/DB/RPC/fetch son todas promesas), que es
  la propiedad que sostiene el razonamiento del SSRF; la I/O síncrona no la puede
  impedir un tipo y la frena la review.
- **Aplicar en**: cada vez que un docstring diga "por construcción no puede X",
  intentar hacer X antes de escribirlo. El claim débil y verdadero vale más que el
  fuerte y falso.

## Mutación — 28 mutantes, todos MATADOS

Metodología: se comitea el fix, se aplica el mutante con un script, se corre la
suite objetivo y se restaura con `git checkout -- src/` (nunca `reset --hard`,
nunca sobre archivos untracked).

| # | Mutante | Tests que se pusieron ROJOS |
|---|---------|------------------------------|
| M1 | `/registries`: sin `requireA2AKeyPresence` en las 3 rutas | T-NCR-01, 02, 03, 04 (4 fail / 14 pass) |
| M2 | `POST /registries`: sin `registerBodyCheck` pre-cobro | T-NCR-05 |
| M3 | `/registries`: sin ningún `refundStep0Debit` | T-NCR-06..16 (11 fail) |
| M4 | `/tasks`: sin `requireA2AKeyPresence` | T-NCT-01..05 (5 fail) |
| M5 | `/tasks`: sin los checks de forma pre-cobro | T-NCT-06..11 (6 fail) |
| M6 | `/tasks`: sin ningún `refundStep0Debit` | T-NCT-12..18 (7 fail) |
| M7 | `chargedRoute`: cobro ANTES de la validación | T-CR-01, 02, 04, 05; T-META-02; T-NCR-01..05; T-NCT-01..11 (21 fail) |
| M8 | `DELETE /registries/:id` cableada con `requirePaymentOrA2AKey` directo (bypass del componente) | T-META-01, 03, 04 |
| M9 | Sin la marca `CHARGES_CALLER` en el middleware de pago (guard ciego) | T-META-03, 04 |
| M10 | `refundStep0Debit` sin el guard `resolvedChainId` (refund en ruta que no debitó) | T-SR-03 |
| M11 | `refundStep0Debit` sin el guard anti-doble-refund | T-SR-05 |
| M12 | `refundStep0Debit` acreditando en el riel x402 | T-SR-02 |
| M13 | Refund de delegación degradado a `credit` a secas (dejaría `total_spent` inflado) | T-SR-06; T-NCR-15; T-NCT-17 |
| M14 | Refund por un monto distinto al debitado ($2 vs $1) | 23 fail (T-SR-01,06..09; T-NCR-06..16; T-NCT-12..18) |
| M15 | Refund de key-session degradado | T-SR-07; T-NCR-16; T-NCT-18 |
| M16 | Refund TAMBIÉN en el happy path (cobro neto cero) | T-NCR-17; T-NCT-19 |
| M17 | `?status=` vacío pasa a ser 400 (cambio de contrato encubierto) | T-NCT-20 |

Lectura: los mutantes M1..M6 confirman que cada grupo de tests mira el dinero y no
el status (M3/M6 dejan los mismos status y sólo cambian el balance). M7 confirma
que la propiedad "validar antes de cobrar" está probada a nivel componente Y a
nivel ruta. M8/M9 confirman que el guard estructural no es decorativo. M10..M16
confirman que los invariantes anti-inflación tienen test propio.

### Mutantes del fix-pack del AR (M18..M28)

Metodología corregida: **el fix se commitea primero** (`4aa18d4`), después se aplica
el mutante y se restaura con `git checkout -- <archivo>`. Nunca `reset --hard`,
nunca sobre untracked. Cada script de mutación aborta con exit≠0 si su patrón no
aparece (un mutante que no se aplicó "pasa" el test y miente).

| # | Mutante | Tests que se pusieron ROJOS |
|---|---------|------------------------------|
| M18 | `GET /tasks`: sin el refund del read fallido | T-NCT-21 (1 fail / 24 pass) |
| M19 | `GET /tasks/:id`: sin el refund del read fallido | T-NCT-22 |
| M20 | `PATCH /:id/status`: sin el refund del `throw err` genérico | T-NCT-23 |
| M21 | `PATCH /:id`: sin el refund del `throw err` genérico | T-NCT-24 |
| M22 | **Dirección contraria**: refund AGREGADO al 500 de `POST /tasks` (la decisión declarada) | T-NCT-25 |
| M23 | El guard deja de escanear un plugin de la app (`authRoutes` fuera de `SCANNED`) | T-META-06 |
| M24 | `POST /payments/evil-charge` cobra sin validar (plugin que el guard viejo NO miraba) | T-META-01, T-META-04 |
| M24b | El MISMO mutante M24 contra el guard VIEJO (5 plugins, `git show 30ecf5d`) | **ninguno — 4 passed**: el agujero de MENOR-1 era real y hoy está cerrado |
| M25 | `POST /registries/evil-skip` con `{ skip: 'meh' }` (el repro del AR) | T-META-05, T-META-03 |
| M26 | Sin vista inmutable: `input` con las referencias vivas de Fastify | T-CR-10, T-CR-11 |
| M27 | Proxy NO recursivo (sólo el primer nivel): `input.body.nested.x = 1` pasa | T-CR-11 |
| M28 | Sin `Object.freeze` del contenedor: `input.body = {}` pasa | T-CR-11 |

Lectura: M18..M21 confirman que cada refund nuevo tiene su propio test de BALANCE
(cada mutante mata exactamente uno, así que ninguno se apoya en otro). M22 es el
más importante del pack: prueba que la decisión de NO reembolsar el `create` está
CONGELADA y no es un olvido — agregar el refund rompe el test y obliga a actualizar
el contrato público en el mismo diff. M24 + M24b son la evidencia de que MENOR-1 era
un agujero real (el mismo mutante sobrevive con el guard viejo y muere con el
nuevo). M26..M28 cubren las tres capas de la inmutabilidad por separado.

## Cobertura de las líneas nuevas

| Módulo | Resultado |
|---|---|
| `middleware/charged-route.ts` + `middleware/charge-brand.ts` | 100% stmts / 100% branch / 100% funcs / 100% lines. Incluye `readonlyView` y las CUATRO trampas del Proxy: la de `setPrototypeOf` no tenía hits y se agregó su caso a T-CR-11 en vez de dejarla sin cubrir (20/20 líneas con statement) |
| `lib/step0-refund.ts` | 100% lines (17/17), 94.4% stmts, 87.5% branch. Sin hits: la rama `amountUsd <= 0` (inalcanzable con `PLACEHOLDER_FEE_USD > 0`) y los ternarios `e instanceof Error` de los logs |
| `lib/step0-debit.ts` | 100% en las 4 métricas corriendo compose+gasless+registries (las 3 ramas del monto) |
| `routes/registries.ts` | 93% lines. Sin hits nuevos: `183, 237, 351, 405` = guards defense-in-depth duplicados (inalcanzables vía HTTP porque el check pre-cobro gana). `138` y los `throw err` de re-raise son preexistentes |
| `routes/tasks.ts` | 93% lines. Los 4 refunds nuevos y sus `try/catch` tienen hits (T-NCT-21..24). Sin hits: `176, 257, 295, 299, 304, 360, 364` (los mismos duplicados defense-in-depth, renumerados por el fix-pack) y `64` (`getOwnerRef` throw), que pasó a ser inalcanzable: ERA el 500 que recibía el caller x402 después de pagar |

Los duplicados se conservan siguiendo el precedente de HU-188
(`compose.ts:630-636`, documentado en `doc/sdd/188-.../auto-blindaje.md:316`): si
alguien reordena la cadena de preHandlers, el input no validado sigue sin llegar al
service. Se declaran acá para que nadie los lea como cobertura real.
