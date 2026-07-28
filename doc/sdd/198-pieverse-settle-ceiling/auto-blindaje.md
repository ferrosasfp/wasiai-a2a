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
