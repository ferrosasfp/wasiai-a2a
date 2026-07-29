# Auto-Blindaje — WKH-305 · mapeo de un campo entre steps de `/compose`

Errores REALES cometidos durante la implementación (F3), wave por wave, con el
patrón que los previene. Nada de esto es hipotético.

---

### [2026-07-29 00:55] TODAS — Un MUTANTE quedó commiteado como si fuera el fix

- **Error**: el commit `659a39e` ("wip: trabajo en curso") incorporó al branch el
  **mutante M2**: el guard de `SOURCE_FIELD_MISSING` en
  `lib/compose-input-mapping.ts` devolvía `{ ok: true, input: base }` en vez de
  fallar. O sea que un mapeo irresoluble **se colaba en silencio** y el step se
  invocaba —y se cobraba— con la entrada incompleta. Nueve tests estaban en rojo
  en HEAD.
- **Causa raíz**: se commiteó el árbol de trabajo **mientras una verificación por
  mutación estaba en vuelo**, sin correr la suite antes de commitear. Durante la
  mutación el árbol está intencionalmente roto: ese es su estado normal. Un
  commit "por las dudas, para no perder trabajo" tomado en esa ventana congela el
  daño.
- **Fix**: restaurado byte a byte desde el respaldo verificado por hash
  (`cff60aea…`), confirmado con `git diff 837b047 -- <archivo>` vacío, suite
  completa verde de nuevo, y commit propio de la reversión (`50b6ddf`).
- **Aplicar en**: cualquier HU que use verificación por mutación.
  1. **Nunca commitear sin correr la suite completa antes.** El diff "se ve
     bien" no distingue un fix de un mutante: los dos son cambios chicos y
     plausibles en el mismo lugar.
  2. La ventana de mutación tiene que ser **corta y atómica**: aplicar, medir,
     restaurar, verificar el hash. No dejar un mutante vivo entre llamadas.
  3. Si hay que salvar trabajo a mitad de una mutación, **restaurar primero**
     (`cp` desde el respaldo + `sha256sum -c`) y recién entonces commitear.

---

### [2026-07-29 00:47] W-verificación — Un mutante que NO se aplicó y casi cuenta como KILLED

- **Error**: el primer intento de aplicar M2 falló porque el texto ancla no
  coincidía (biome había reformateado el `return` a varias líneas). El script
  siguió adelante sin haber tocado el archivo.
- **Causa raíz**: escribir el ancla de memoria en vez de releer el archivo
  **después** de que el formateador lo tocara (exactamente CD-14).
- **Fix**: el helper `check_landed()` compara `git diff --quiet` sobre el archivo
  mutado y **aborta** si el diff está vacío. Cazó el caso en el acto. Después se
  releyó el bloque real con `grep -B/-A` y se reescribió el ancla.
- **Aplicar en**: toda verificación por mutación. **Probar que el mutante
  aterrizó es un paso obligatorio, no una formalidad.** Un mutante que no se
  aplica produce una suite verde que se lee como "SURVIVED" y es un falso
  negativo; uno que rompe el parseo produce todo rojo y es un falso KILLED
  (CD-15). Los dos se detectan con las mismas dos líneas: `git diff` no vacío +
  `tsc --noEmit` limpio.

---

### [2026-07-29 01:01] W-verificación — Tests que dependían del orden de ejecución

- **Error**: el test nuevo T-MAP-C4 fallaba con
  `Cannot read properties of undefined (reading 'find')` al correrlo solo con
  `-t`, pero pasaba dentro de la corrida completa del archivo.
- **Causa raíz**: `registryService.getEnabled` nunca se setea en el `beforeEach`
  global de `compose.test.ts`. `vi.clearAllMocks()` limpia las **llamadas**, no
  las **implementaciones**, así que los tests heredaban en silencio el
  `mockResolvedValue` que había dejado algún test ANTERIOR. Los tres tests de
  caracterización T-MAP-C1..C3 tenían la misma dependencia oculta y pasaban por
  suerte posicional.
- **Fix**: `vi.mocked(registryService.getEnabled).mockResolvedValue([])` explícito
  en el `beforeEach` del bloque nuevo. Ningún test preexistente se tocó.
- **Aplicar en**: cualquier suite que use `clearAllMocks` + factories `vi.mock`.
  Un test que sólo pasa dentro de su archivo completo **no está probando lo que
  dice**: correr el `it` aislado (`-t`) es la forma barata de detectarlo, y vale
  la pena hacerlo con todo test nuevo antes de darlo por bueno.

---

### [2026-07-28 22:36] W2 — El orden de encolado de `mockResolvedValueOnce` invertido

- **Error**: los tests de retry (T-MAP-19/19b/20) daban `success:false` porque la
  respuesta del RE-INVOKE se encolaba **antes** de llamar al helper que encolaba
  el step 0 y el primer intento. La cola quedaba `[paid, step0, error400]`.
- **Causa raíz**: un helper que hacía dos cosas —encolar respuestas y correr el
  pipeline— escondía el punto de inserción. Se leía como "preparo el retry y
  después corro", pero el helper encolaba en el medio.
- **Fix**: partir el helper en `queueStep0AndFailedAttempt()` (sólo encola) y
  `runRetryPipeline()` (sólo corre), con un comentario que dice explícitamente que
  `mockResolvedValueOnce` es FIFO y que el orden de encolado ES el orden de las
  respuestas.
- **Aplicar en**: todo test con más de dos respuestas encoladas. Un helper de
  fixtures **no** debe correr el sujeto bajo prueba: en cuanto lo hace, el orden
  de encolado deja de ser visible en el cuerpo del test.

---

### [2026-07-28 22:37] W2 — Asumir por qué camino llega un `null` a la salida anterior

- **Error**: T-MAP-04 (salida previa `null`) se escribió haciendo que el agente
  devolviera `null` en el body. El pipeline moría en el step 0 con
  `Cannot read properties of null (reading 'result')`, no en el mapeo.
- **Causa raíz**: asumir la ruta del dato en vez de leer el código.
  `invokeAgent` hace `data.result ?? data` (`compose.ts:1363`), así que un body
  `null` nunca sobrevive al step 0. Un `lastOutput` nulo sólo puede llegar por el
  **bridge** (`lastOutput = tr.transformedOutput`, `compose.ts:1027`).
- **Fix**: el test arma el escenario real — el agente siguiente declara
  `inputSchema`, y `maybeTransform` devuelve `transformedOutput: null`. Mismo AC,
  ahora por el camino que existe de verdad.
- **Aplicar en**: todo test que fabrique un valor "raro" aguas arriba. Antes de
  construir el fixture, **leer cómo viaja ese valor**; si no se puede producir por
  el camino real, el test estaría probando una rama inalcanzable.

---

### [2026-07-28 22:38] W2 — Sobre-especificar un `reason` que el bridge decide

- **Error**: T-MAP-06 afirmaba `SOURCE_FIELD_MISSING` para una salida
  `A2AMessage`. Lo observado fue `PREVIOUS_OUTPUT_NOT_OBJECT`.
- **Causa raíz**: el mapeo lee `lastOutput` DESPUÉS del bridge. Con un target no
  `a2aCompliant`, el bridge **desenvuelve** el mensaje a su parte de texto (un
  primitivo) ⇒ no es objeto. Con un target `a2aCompliant`, hace passthrough y el
  mensaje entero sobrevive ⇒ falta la clave. Los dos son códigos estables de
  AC-2, y el Story File contempla explícitamente ambos (§5.4).
- **Fix**: se partió en dos tests, uno por rama del bridge, cada uno asertando el
  código que corresponde a ESA rama y por qué. No se relajó la aserción a "alguno
  de los dos": eso habría escondido cuál ocurre cuándo.
- **Aplicar en**: cuando el valor observado no coincide con el esperado,
  **entender la rama antes de tocar la aserción**. Aflojar el assert a un `oneOf`
  es la forma más común de convertir un hallazgo en ruido.

---

### [2026-07-28 22:31] W1 — El comentario que rompía su propio checklist

- **Error**: el comentario del movimiento de W1 nombraba `startTime` y `i > 0`
  para documentar que NO se tocaban. Pero el checklist de salida de W1 es un grep:
  "el diff de `compose.ts` NO contiene la cadena `startTime` / `i > 0`". El
  comentario hacía fallar la verificación que pretendía respaldar.
- **Causa raíz**: documentar una prohibición **citándola literalmente** dentro del
  artefacto que la verificación inspecciona.
- **Fix**: reescrito en prosa ("el cronómetro de latencia del step y el guard de
  doble-débito del step 0 se quedan donde estaban"), sin las cadenas literales.
  Verificado con `git diff -U0 | grep "^[+-].*startTime"` ⇒ sin coincidencias
  (la única ocurrencia restante es una línea de CONTEXTO, no del cambio).
- **Aplicar en**: cuando un gate se expresa como una búsqueda de texto, el código
  y los comentarios nuevos son parte del espacio de búsqueda. Verificar el gate
  sobre las líneas `+`/`-` (`-U0`), no sobre el diff con contexto.

---

### [2026-07-28 22:43] W3 — Un fallo de suite completa que NO se pudo reproducir

- **Observación honesta, sin fix**: una corrida de `npm test` encadenada después
  de `npm run lint` en la misma invocación reportó **1 test fallado** de 4064. Las
  **11 corridas siguientes** de la suite completa dieron verde
  (`4064 passed | 19 skipped`, 0 failed).
- **Qué NO se pudo hacer**: identificar el test. La salida quedó truncada por el
  filtro de la CLI y el nombre no se recuperó.
- **Hipótesis (no confirmada)**: contención de CPU con el proceso de lint,
  afectando a algún test sensible a tiempos. **No está probada.**
- **Por qué se documenta igual**: un fallo intermitente en una suite que cubre el
  money-path no es ruido aceptable, y no reportarlo lo convierte en deuda
  invisible. Queda como residuo declarado para AR/QA.
- **Aplicar en**: capturar SIEMPRE la salida completa de la suite a un archivo
  (`> run.txt 2>&1`) en vez de leerla por pipe truncado. Un fallo que no se puede
  nombrar no se puede investigar.

---

### Nota sobre los mutantes M1 y M10 vs. `T-MAP-18`

No es un error cometido, es un **hallazgo sobre el plan de tests** del Story File.

El Story File nombra a `T-MAP-18` como test asesino de **M1** (devolver la
construcción del `input` a después del débito) y de **M10** (dejar de propagar
`steps`/`totalCostUsdc` en el early-return). **`T-MAP-18` no puede matar a
ninguno de los dos**: es un test de RUTA y la suite de ruta moquea
`composeService.compose` por completo, así que no observa nada de lo que pasa
adentro del service.

Los dos mutantes **sí mueren**, en el nivel donde la propiedad es observable:

- **M1** → `T-MAP-07` (balance 9.93 en vez de 9.95: se cobró un step que no corrió).
- **M10** → `T-MAP-08` (`steps.length` y `totalCostUsdc` del resultado).

No se agregó ningún test: la propiedad está cubierta. Lo que estaba mal era el
puntero del plan, y queda corregido acá para que AR no lo lea como un hueco.
