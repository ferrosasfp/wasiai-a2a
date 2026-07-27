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

## Mutación — 17 mutantes, todos MATADOS

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

## Cobertura de las líneas nuevas

| Módulo | Resultado |
|---|---|
| `middleware/charged-route.ts` + `middleware/charge-brand.ts` | 100% stmts / 100% branch / 100% funcs / 100% lines (23/23 stmts) |
| `lib/step0-refund.ts` | 100% lines (17/17), 94.4% stmts, 87.5% branch. Sin hits: la rama `amountUsd <= 0` (inalcanzable con `PLACEHOLDER_FEE_USD > 0`) y los ternarios `e instanceof Error` de los logs |
| `lib/step0-debit.ts` | 100% en las 4 métricas corriendo compose+gasless+registries (las 3 ramas del monto) |
| `routes/registries.ts` | 93% lines. Sin hits nuevos: `183, 237, 351, 405` = guards defense-in-depth duplicados (inalcanzables vía HTTP porque el check pre-cobro gana). `138` y los `throw err` de re-raise son preexistentes |
| `routes/tasks.ts` | 90.6% lines. Sin hits nuevos: `169, 232, 265, 269, 274, 320, 324` (mismos duplicados). `57` (`getOwnerRef` throw) pasó a ser inalcanzable: ERA el 500 que recibía el caller x402 después de pagar |

Los duplicados se conservan siguiendo el precedente de HU-188
(`compose.ts:630-636`, documentado en `doc/sdd/188-.../auto-blindaje.md:316`): si
alguien reordena la cadena de preHandlers, el input no validado sigue sin llegar al
service. Se declaran acá para que nadie los lea como cobertura real.
