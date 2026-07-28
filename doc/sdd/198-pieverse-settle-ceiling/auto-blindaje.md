# Auto-Blindaje — HU-198 (techo de los hops pieverse + estado `unknown`)

### [2026-07-28] Wave 3 — asumí la dirección del fallo del `instanceof` sin verificarla

- **Error**: al reportar el `instanceof` de `GaslessTransferError` como el mismo bug,
  acepté sin verificar que su consecuencia fuera "reembolsar algo que quizás se movió"
  (double-pay). Es al revés: `classifyGaslessFailure` **defaultea a `'unknown'`** y
  sólo reembolsa con `'not-moved'` (`routes/gasless.ts`), así que un `instanceof` roto
  produce un reembolso **OMITIDO**, no uno indebido. Severidad real: under-refund
  (plata que le debemos al caller, en silencio), NO double-pay.
- **Causa raíz**: leí la forma del bug (idéntica) y extrapolé la consecuencia sin leer
  el default del consumidor. La dirección de un fail-safe no se deduce de la forma del
  error: se lee en el call-site que decide.
- **Fix**: verifiqué el default en el código antes de escribir el fix y documenté la
  dirección REAL en el docstring de `readGaslessValueDisposition` (con el "es lo
  contrario de lo que parece" explícito, para que el próximo no repita la inferencia).
  El `?? 'unknown'` conserva el fail-safe de HU-192 byte-idéntico; mutarlo a
  `?? 'not-moved'` pone rojo el T-192-6 preexistente.
- **Aplicar en**: cualquier reporte de severidad de un bug de clasificación. La
  pregunta obligatoria es "¿a qué defaultea el consumidor?", no "¿qué tipo de error
  es?". Dos bugs de la MISMA forma pueden tener consecuencias opuestas.

### [2026-07-28] Wave 3 — `getLogger` devuelve un child nuevo: no se puede espiar la instancia

- **Error**: escribí el test del log nuevo con `vi.spyOn(logger, 'error')` y no había
  ningún `logger` importable; el spy tampoco habría funcionado.
- **Causa raíz**: `lib/logger.ts` → `getLogger(name)` hace `rootLogger.child({module})`,
  o sea devuelve una instancia NUEVA en cada llamada. El módulo bajo prueba capturó su
  child en el import (`const log = getLogger(...)`), así que ni espiar `rootLogger` ni
  espiar un child posterior alcanza a ese objeto.
- **Fix**: `vi.mock('../../lib/logger.js')` con una fábrica cuyo `getLogger` devuelve
  siempre el mismo doble con un spy compartido.
- **Aplicar en**: todo test que quiera afirmar CONTENIDO de un log. Hay logs que son la
  única señal de un modo de fallo silencioso (este mismo: el
  `INVALID_SETTLE_STATUS` cuando falta la migración), así que "no se puede testear el
  log" no es una excusa aceptable ahí.

### [2026-07-28] Wave 3 — un doble que ignora sus argumentos hace vacuo el test

- **Error**: quise afirmar por qué estados filtra `driftCheck` y el doble de supabase en
  `reconciliation.test.ts` tenía `in: () => b` — descarta los argumentos. Un test escrito
  contra ese doble habría pasado con CUALQUIER lista de estados, incluida la vieja.
- **Causa raíz**: el doble se escribió para encadenar el builder, no para observarlo. Es
  la misma clase de vacuidad que el caso de los 3669 tests verdes con un guard borrado.
- **Fix**: capturar `{col, values}` de cada `.in()` y exponer `settleStatusFilter()`.
  Mutación probada: sacar `resolving_settle` de `DRIFT_ACCOUNTED_STATUSES` pone rojo el
  test; antes del cambio al doble, no lo habría puesto.
- **Aplicar en**: antes de afirmar sobre un argumento, verificar que el doble lo GUARDE.
  Si el doble lo tira, el test es decorativo.

### [2026-07-28] Wave 2 — `instanceof` para una decisión de dinero se cae entre registros de módulos

- **Error**: clasifiqué el settle con `e instanceof FacilitatorSettleError` en
  `lib/downstream-payment.ts` y en `middleware/x402.ts`. Los dos tests nuevos del
  consumidor (`T-198-SettleUnknown`, `T-198-SettleNotSent`) salieron ROJOS: el
  `disposition` llegaba `undefined` y el leg se reportaba como `SETTLE_FAILED`, o sea
  el colapso exacto que la HU existe para evitar.
- **Causa raíz**: `instanceof` compara IDENTIDAD DE CLASE, y esa identidad es
  por-registro-de-módulos. `downstream-payment.test.ts` carga el módulo bajo prueba con
  `vi.resetModules()` + `import()` dinámico (`importWithFlag`), así que el consumidor ve
  OTRA copia de `adapters/errors.js` que la que importó el test. No es un artefacto de
  test: cualquier cosa que duplique el grafo de módulos (dos versiones de un paquete,
  un bundle mal deduplicado) rompe igual la decisión de dinero.
- **Fix**: `readSettleValueDisposition(err)` en `adapters/errors.ts` — intenta
  `instanceof` (camino normal en prod) y si no, valida por FORMA (`name ===
  'FacilitatorSettleError'` + `valueDisposition` dentro del dominio). Es el MISMO
  criterio que ya usaba `classifyReceiptError` en `adapters/settle-verifier.ts`, que
  clasifica por `err.name` en strings y no por clase, por esta misma razón.
  Candado: `T-READ-cross-registry` construye a mano un error con la forma correcta y
  otra identidad, y afirma `instanceof === false` Y que la disposición se lee igual.
- **Aplicar en**: cualquier error tipado que cruce un límite de módulo y gobierne una
  decisión de dinero. Hoy: `GaslessTransferError` (`routes/gasless.ts` decide el refund
  con `valueDisposition`) tiene la misma forma y el mismo riesgo — no se tocó en esta HU
  (fuera de scope), pero si alguna vez se consume desde un módulo cargado con
  `resetModules`, va a fallar silenciosamente del lado peligroso (reembolsar algo que
  se movió). Regla: para leer un campo de un error a través de un límite de módulo, un
  guard estructural, nunca `instanceof` solo.

### [2026-07-28] Verificación — corrí `tsc` antes de escribir el último test

- **Error**: reporté "tsc limpio" en la wave 2 y después agregué
  `middleware/x402.settle-unknown.test.ts`. El `tsc --noEmit` final falló:
  `TS2379` por `exactOptionalPropertyTypes` (pushear `{ msg: undefined }` a un
  `msg?: string` no es lo mismo que omitir la propiedad). Biome y `vitest` pasaban
  igual, así que sin el tsc COMPLETO al final el error se iba al commit.
- **Causa raíz**: dos cosas. (1) Verifiqué en el orden equivocado: el typecheck tiene
  que ser lo ÚLTIMO, después del último archivo escrito, no una vez por wave. (2) La
  suite y el linter no cubren este error: vitest transpila sin type-check.
- **Fix**: spread condicional (`...(msg === undefined ? {} : { msg })`) + re-correr los
  3 gates DESPUÉS del último cambio.
- **Aplicar en**: es la misma lección que ya está en memoria de WKH-196 (`npx tsc
  --noEmit` completo, no sólo `npm run build`, que excluye tests). Corolario nuevo: y
  además al FINAL. Un "verde" de wave intermedia no es evidencia del estado del commit.

### [2026-07-28] Wave 2 — el guard exhaustivo de skip-codes hizo su trabajo

- **Error**: agregué `SETTLE_UNKNOWN` a `DownstreamSkipCode` y `T-PUB-1`
  (`lib/downstream-skip-signal.test.ts`) se puso rojo.
- **Causa raíz**: ninguno. `PUBLIC_SKIP_CODE` es `Record<DownstreamSkipCode, ...>`
  exhaustivo por tipo Y hay un test que compara el vocabulario público runtime contra
  una lista escrita a mano. Está diseñado para NO compilar / NO pasar si alguien agrega
  un código sin decidir su visibilidad pública.
- **Fix**: decidir explícitamente la visibilidad (`SETTLE_UNKNOWN` se expone VERBATIM,
  no se genericiza, porque "no se pagó" y "puede haberse pagado" son frases opuestas y
  `SETTLE_FAILED` además afirma que al caller no se le cobra) + su explicación de una
  línea + actualizar las dos listas del test.
- **Aplicar en**: es el patrón a imitar, no un problema. Todo vocabulario que se
  serialice al caller debería tener este par (Record exhaustivo + test de lista).

### [2026-07-28] Fix-pack AR — candé la lista de al lado, no la que sostiene el diseño

- **Error**: candé `DRIFT_ACCOUNTED_STATUSES` (`T-198-Drift`) y NO `PENDING_STATUSES`,
  que está 20 líneas más arriba **del mismo archivo** y es la que sostiene el diseño
  entero. El AR borró `'resolving_settle'` de esa lista y la suite dio **3714 passed, 0
  failed**: la mutación sobrevivió. Sin esa entrada la fila desaparece de
  `listPending()` y `resolveIntent` tira `NOT_PENDING` ⇒ el limbo invisible que el
  estado existía para evitar.
- **Causa raíz**: candé la lista que había TOCADO en vez de la que el diseño NECESITA.
  El argumento entero de la HU era "no se auto-reclama PERO sigue visible", y sólo
  testeé la primera mitad. Un estado nuevo tiene tantas invariantes como superficies lo
  consumen, y hay que enumerarlas: escritura, claim, listado, resolución, drift.
- **Fix**: `T-198-Pending-List` / `-Resolve` / `-Shared` (el último candea la
  ANTI-DIVERGENCIA de las dos superficies, que comparten la constante). Mutación
  re-corrida: 2 rojos.
- **Aplicar en**: cuando una HU introduce un ESTADO, listar sus superficies y candar
  cada una. La pregunta no es "¿testeé mi cambio?" sino "¿qué tiene que seguir siendo
  cierto para que mi cambio signifique lo que digo?".

### [2026-07-28] Fix-pack AR — mi test SQL verificaba que la migración se DESCRIBIERA

- **Error**: `T11` afirmaba `flat(sql).toContain('AND intent_id = p_intent_id')` y
  **pasó con la cláusula borrada del UPDATE** (mutación Q9). El literal aparecía en el
  HEADER de la migración, en prosa: *"(3) MNR-3 — el UPDATE ... agrega `AND intent_id =
  p_intent_id`"*. El test verificaba la documentación, no la conducta.
- **Causa raíz**: escribo headers largos que citan el SQL que explican, así que en un
  test que hace `readFileSync` del .sql **los comentarios son parte del string
  matcheado**. Cuanto mejor documentada la migración, más fácil que su test sea vacuo.
- **Fix**: helper `code()` que quita las líneas `--` antes de matchear, aplicado a TODAS
  las afirmaciones de conducta; el sql crudo queda sólo para las afirmaciones que son
  *sobre* los comentarios (el gate de orden de release). Re-corridas 6 mutaciones SQL
  (Q9-Q14) para confirmar que ninguna otra era vacua por el mismo motivo.
- **Aplicar en**: `test/*.migration.test.ts`. Los dos precedentes del repo
  (`negative-amount-guard`, `agent-links`) matchean el .sql crudo y tienen el mismo
  riesgo latente — no los toqué, pero si alguien agrega assertions ahí, usar `code()`.
  Regla general: un test que lee un archivo y busca un string tiene que excluir las
  regiones donde ese string aparece como PROSA.

### [2026-07-28] Fix-pack AR — la observabilidad que agregué no cubría el fallo que yo mismo introduje

- **Error**: agregué el guard de transición (un UPDATE de 0 filas pasa a ser un
  resultado NORMAL) y en el mismo commit agregué un `log.error` que **sólo** dispara con
  `error` del RPC. O sea: introduje un modo de fallo silencioso y "mejoré la
  observabilidad" sin cubrirlo. Con `RETURNS void` el caller no podía ni enterarse.
- **Causa raíz**: pensé la observabilidad sobre los fallos que YA conocía (el RPC que
  tira) en vez de sobre el que mi cambio ESTABA CREANDO (el rechazo silencioso del
  guard). Un guard nuevo es un camino de fallo nuevo por definición.
- **Fix**: `RETURNS TABLE(applied boolean)` (patrón de `record_reconciliation_resolution`)
  + el caller devuelve boolean y grita con `applied=false` y con `undefined`.
- **Aplicar en**: cada vez que se agrega una PRECONDICIÓN a un write, preguntar "¿cómo
  se entera el caller de que la precondición no se cumplió?". Si la respuesta es "no se
  entera", el guard es peor que no tenerlo: cambia el comportamiento sin señal.

### [2026-07-28] Fix-pack AR — enuncié un no-side-effect como feature sin ver que bloqueaba el bueno

- **Error**: escribí "no auto-paga, no auto-reembolsa" como propiedad deseable de
  `resolving_settle`. La primera mitad era el objetivo; la segunda era una **regresión**
  que no vi: con hop 1 re-verificando `not_confirmed`, el refund del budget del buyer
  (correcto y necesario, los fondos nunca salieron del escrow) quedaba inalcanzable para
  siempre. Pre-branch ese refund procedía.
- **Causa raíz**: describí el comportamiento del claim ("no reclama esta fila") en vez de
  razonar por LADO. El claim tiene dos lados con semánticas opuestas: el settle mueve
  plata nueva (peligroso), el refund revierte un débito y es idempotente (seguro). "No se
  reclama" era correcto para uno y dañino para el otro.
- **Fix**: rama `p_side='refund'` en `claim_reconciliation`; el lado settle sigue
  exigiendo tx previa. La asimetría es el punto.
- **Aplicar en**: cuando un cambio BLOQUEA algo, enumerar todo lo que pasaba por ahí
  antes — no sólo lo que se quería bloquear. "Ya no ocurre X" hay que leerlo como "ya no
  ocurre NADA de lo que usaba ese camino".

### [2026-07-28] Fix-pack AR#2 — el techo fallaba en el ÚNICO caso que la HU existe para acotar

- **Error**: `await response.json()` quedó FUERA del `try` que envuelve el `fetch`. El
  `AbortSignal` acota también el consumo del body, así que cuando el techo se cumple
  DURANTE el body lo que sale es un `DOMException/TimeoutError` pelado — no
  `FacilitatorSettleError`, `readSettleValueDisposition() === undefined`. Consecuencia
  medida: el caller inbound recibía "Payment settlement failed" (le afirmábamos que no se
  le cobró) y NO se escribía la fila de reconciliación. O sea: AC-2, AC-7(b) y AC-7(c)
  incumplidos por el mismo agujero.
- **Causa raíz**: dos, y la segunda es la grave.
  (1) Pensé "el techo acota el fetch" cuando acota **el request entero, body incluido**.
  El `try` lo puse alrededor de la llamada que me parecía riesgosa, no alrededor de todo
  lo que el signal puede interrumpir.
  (2) Los 6 tests usaban SÓLO `createSilentServer()` (peer que nunca manda headers) —
  y mi propio `work-item.md` dice que **ese caso ya estaba acotado por undici a 300 s**,
  y que "lo verdaderamente ilimitado es el peer que trickle-feedea". Escribí el análisis
  correcto y después testeé el caso que el análisis declaraba menos importante. Tres
  documentos (AC-2, el docstring del adapter y `.env.example`) afirmaban la propiedad que
  el código no cumplía.
- **Fix**: el body read va en su propio `try` que clasifica (`unknown`); el `!response.ok`
  queda AFUERA a propósito (es un veredicto del facilitator, no una incógnita de
  transporte) con candado de no-regresión. + `createTrickleBodyServer` y 4 tests nuevos.
  Repro medido antes/después: `ctor=DOMException/TimeoutError, disposition=undefined` →
  `ctor=FacilitatorSettleError, disposition=unknown`.
- **Aplicar en**: (a) si un `AbortSignal` gobierna un request, TODO lo que se haga con esa
  `Response` está bajo el signal — el `try` va alrededor del consumo, no sólo de la
  llamada. (b) **Cuando el análisis dice "el caso importante es X", el primer test es X.**
  Si el análisis distingue dos ejes, hay que tener un servidor por eje.

### [2026-07-28] Fix-pack AR#2 — reverti una mutación con `git checkout` sobre un archivo UNTRACKED

- **Error**: muté la migración #3 (borrarle el guard de transición), corrí `git checkout
  HEAD -- supabase/migrations/`, vi `git diff --stat` vacío y lo leí como "revertido". El
  archivo es NUEVO/untracked, así que `git checkout HEAD --` no tenía nada que restaurar y
  el `git diff` vacío era el síntoma esperado, no la prueba. **La mutación quedó en disco**
  y sólo la encontré al verificar con `grep -c`.
- **Causa raíz**: usé como evidencia de revert la MISMA señal que es ciega para archivos
  untracked. Estaba avisado por escrito y aun así lo hice, porque el flujo
  "mutar → checkout → diff vacío" ya me había funcionado 14 veces con archivos trackeados.
- **Fix**: para archivos nuevos, backup + `cp` para restaurar y **`sha256sum` antes/después
  de mutar Y después de restaurar** (el hash restaurado tiene que ser idéntico al inicial).
  Además: si el archivo mutado ya estaba aplicado a la base, verificar la BASE por separado
  (acá el deployed conservaba el guard, `guard_present:true`).
- **Aplicar en**: toda mutación sobre un archivo que no esté en `HEAD`. Regla: **la prueba
  de que algo se revirtió no puede ser la misma señal que es ciega al archivo**.

### [2026-07-28] Fix-pack AR#2 — tres especies más de test vacuo, todas mías

- **Error**: además de la vacuidad por prosa (ya anotada), el AR encontró tres formas más,
  las tres con la mutación VERDE: (i) un literal satisfecho por **otra función del mismo
  archivo** (`GET DIAGNOSTICS` existía en `claim_reconciliation`, así que mutar el de
  `record_debit_settle_status` a `v_rows := 1` —que hace `applied` SIEMPRE true, o sea
  anula el candado entero de BLQ-MEDIO-2— pasaba); (ii) una assertion NEGATIVA
  string-shaped (`not.toContain("p_side = 'settle' AND …")`) que se esquiva escribiendo la
  condición SIN gate de lado, lo cual REABRE el re-envío ciego; (iii) un guard verificado
  por presencia de string y no por su tabla de verdad. Y una cuarta que encontré yo al
  mutar: **la migración #3 no tenía NINGÚN test**, aunque reescribe la función completa.
- **Causa raíz**: matcheo strings sobre un archivo entero cuando la propiedad es de UNA
  función; y uso negativas sobre la forma exacta que se me ocurrió prohibir, en vez de
  afirmar la forma completa de lo permitido. Una negativa string-shaped sólo prohíbe la
  redacción que anticipé.
- **Fix**: helper `fnBody(sql, nombre)` que corta el `.sql` por función; la negativa de
  (ii) reemplazada por un chequeo que enumera TODAS las menciones de `resolving_settle` en
  el `WHERE` y exige que cada una esté gateada por lado; tabla de verdad evaluada para el
  guard; y un `describe` propio para la #3 que re-verifica todo lo que esa función ya
  prometía.
- **Aplicar en**: (a) scopear el match a la unidad que tiene la propiedad; (b) preferir
  "toda X cumple Y" sobre "no existe la string Z"; (c) **cada migración que reescribe una
  función completa tiene que re-verificar TODO lo que esa función ya prometía**, no sólo lo
  que ella agrega.

### [2026-07-28] Fix-pack AR#2 — dos candados que presenté como evidencia y no candaban nada

- **Error**: (a) el contra-ejemplo "resolving_settle CON tx" usaba una combinación del
  harness donde el claim GANA, así que la rama con el guard nunca se ejecutaba: borrar
  `&& !row.debit_resolution_tx_hash` dejaba la suite entera verde. Y mi comentario decía
  explícitamente "sin este test, devolver el estado nuevo para cualquier `claimed=false`
  pasaría igual" — falso. (b) el test del `.catch()` afirmaba sólo `statusCode===402`, que
  no cambia con ni sin `.catch()`; y la regresión real es que sin él hay un
  `unhandledRejection` que **tumba el proceso** en Node ≥15.
- **Causa raíz**: en (a) construí el escenario por su ESTADO ("una fila resolving_settle
  con tx") sin verificar que el escenario pasara por la RAMA que quería candar — no miré si
  el `if` se ejecutaba. En (b) afirmé lo que era fácil de observar (el status code) en vez
  de la propiedad que me importaba (que el rechazo quedara MANEJADO).
- **Fix**: (a) opción `raceLostClaim` en el harness para forzar `claimed=false` con el
  estado intacto (la race real), y el doble del SELECT ahora expone
  `debit_resolution_tx_hash` como el query real (tampoco lo exponía). (b) el test observa
  `process.on('unhandledRejection')`, exige el log propio de la pérdida de telemetría y
  afirma el body completo.
- **Aplicar en**: antes de creer un test de rama, **verificar que la rama se ejecuta**
  (un log temporal o mutar la rama y ver rojo). Y cuando el objetivo es "el error queda
  manejado", la afirmación tiene que ser sobre el MANEJO (log propio / ausencia de
  unhandled), nunca sobre un valor que es igual en las dos versiones.

### [2026-07-28] Fix-pack AR#2 — ACs verdaderos por construcción (el mejor hallazgo del review)

- **Error**: 6 de mis 18 ACs nombraban el identificador que los implementa
  (`readSettleValueDisposition`, `PENDING_STATUSES`, `RETURNS TABLE(applied boolean)`…).
  Un AC que nombra su implementación es verdadero por construcción: no mide nada, porque
  cualquier código que exista satisface la descripción de sí mismo.
- **Causa raíz**: escribí los ACs DESPUÉS del código (work-item retroactivo), así que
  describí lo que había en vez de la propiedad que el código debía cumplir. Es el sesgo
  estructural de un AC retroactivo.
- **Prueba de que no es cosmético**: el único AC redactado como PROHIBICIÓN FALSABLE
  (AC-2, "nunca `{success:false}` ni un `Error` pelado") **es el único que se rompió**.
  Correlación perfecta entre "AC falsable" y "AC que encuentra un bug".
- **Fix**: los 6 bajaron a CD (que es lo que eran) y los ACs se reescribieron como
  propiedades observables desde afuera del módulo, con la prohibición explícita ("nunca…")
  que permite escribir el caso que las viola.
- **Aplicar en**: test de olfato para un AC — si no puedo escribir el caso que lo viola sin
  mirar la implementación, no es un AC. Y si nombra un símbolo del código, es un CD.
