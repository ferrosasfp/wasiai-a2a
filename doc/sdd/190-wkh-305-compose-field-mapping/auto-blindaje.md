# Auto-Blindaje — WKH-305 · mapeo de un campo entre steps de `/compose`

Errores REALES cometidos durante la implementación (F3), wave por wave, con el
patrón que los previene. Nada de esto es hipotético.

---

## Verificación por mutación — los 12 mutantes (G5 · Done Definition 7)

Procedimiento por mutante: árbol limpio → aplicar → **probar que aterrizó**
(`git diff` no vacío) → **`npx tsc --noEmit` limpio** (CD-15: un mutante que no
compila es un falso KILLED) → correr el/los test(s) → restaurar por `cp` desde el
respaldo → **verificar por hash** (`sha256sum -c`). Nunca `git checkout --`
(CD-16).

| # | Mutación | ¿Compiló? | Resultado | Test(s) asesino(s) — observado, no esperado |
|---|----------|-----------|-----------|---------------------------------------------|
| **M1** | Devolver la construcción del `input` a después del bloque de débito | Sí | **KILLED** | `T-MAP-07` — balance `9.93` en vez de `9.95`: se cobró el step 2, que nunca corrió |
| **M2** | Origen ausente → `{ ok: true, input: base }` en vez de `SOURCE_FIELD_MISSING` | Sí | **KILLED** | 9 tests: `T-MAP-03`, `T-MAP-09`, `T-MAP-10c`, `T-MAP-L18`, `T-MAP-L19`, `T-MAP-L24` + 3 más. Medido en vivo sobre HEAD (ver incidente del mutante congelado) |
| **M3** | `Object.hasOwn(prev, source)` → `source in prev` | Sí | **KILLED** | `T-MAP-10c` (el `in` camina el prototipo y resuelve `toString`) |
| **M4** | Traversal por `.` (`source.split('.').reduce(...)`) | Sí | **KILLED** | `T-MAP-09` (su único trabajo en la vida), + `T-MAP-09b`, `T-MAP-10c` |
| **M5** | Mutar `base` (`base[dest] = …`) en vez de construir objeto nuevo | Sí | **KILLED** | `T-MAP-02` (service), `T-MAP-L22` (leaf) |
| **M6** | Quitar la re-aplicación del mapeo en el retry (pasar `newInput` crudo) | Sí | **KILLED** | `T-MAP-19`, `T-MAP-19b` |
| **M7** | Quitar S7 (destino que colisiona con una clave ya presente en `step.input`) | Sí | **KILLED** | `T-MAP-17` (ruta, pre-cobro), `T-SHAPE-22`, `T-MAP-L04`, `T-MAP-L07`, `T-MAP-L14` |
| **M8** | Quitar S8 (mapeo declarado en el step 0) | Sí | **KILLED** | `T-MAP-16` (ruta), `T-SHAPE-23`, `T-MAP-L06` |
| **M9** | Sacar la revalidación de forma del resolvedor (R3), dejándola sólo en la ruta | Sí | **KILLED** | `T-MAP-21` (el bypass de `/orchestrate/execute`), `T-MAP-L13`, `T-MAP-L14`, `T-MAP-L25` |
| **M10** | El early-return deja de propagar `steps: results` / `totalCostUsdc: totalCost` | Sí | **KILLED** | `T-MAP-08` |
| **M11** | Quitar el guard `i > 0` del bloque de débito (CD-7) | Sí | **KILLED** | **34 tests PREEXISTENTES**; el canónico es `T-COMPOSE-DEBIT-6 should NOT debit step 0 in service (anti-double-debit guard)`. También `T-COMPOSE-DEBIT-1`, `T-COMPOSE-REFUND-2`, `T-SESS-MULTISTEP` |
| **M12** | Mover `const startTime = Date.now()` arriba del bloque de débito (CD-8) | Sí | **SURVIVED → test escrito → KILLED** | Ninguno al principio. Se escribió `T-MAP-C4` **con el mutante aplicado** (orden CD-12) y ahí murió |

**M12 es el hallazgo real de esta batería.** La métrica de latencia por step del
money-path no estaba protegida por nada: cualquiera podía cambiar qué mide
`latencyMs` sin que se enterara un solo test.

### Corrección a los punteros del Story File (M1 y M10)

El Story File nombra `T-MAP-18` como asesino de M1 y de M10. **No puede matarlos**:
es un test de RUTA y esa suite moquea `composeService.compose` por completo, así
que no observa nada de lo que pasa dentro del service. Los dos mueren igual, en el
nivel donde la propiedad es observable (`T-MAP-07` y `T-MAP-08`). No se agregó
ningún test: la propiedad está cubierta, el puntero estaba mal.

### Líneas nuevas sin cobertura — declaradas (G9)

Medido con `vitest --coverage` sobre `src/services/compose.ts` con la suite
completa, no estimado:

- **Statements nuevos sin hits: NINGUNO.** Todo statement agregado por esta HU se
  ejecuta al menos una vez.
- **`src/services/compose.ts:734` — rama `false` de `if (remapped.ok)`: sin hits,
  e INALCANZABLE POR CONSTRUCCIÓN.** Si la primera aplicación del mapeo tuvo
  éxito, la re-aplicación del retry es total: `lastOutput` es el MISMO objeto (el
  step falló, el pipeline no avanzó) y las claves del mapeo son las mismas. Se
  conserva como defensa fail-closed (CD-2): si algún día deja de ser total, el
  camino seguro ya está escrito y no re-debita ni re-invoca. **Se declara acá en
  vez de forzar un test artificial** que tendría que romper el invariante para
  alcanzarla.
- **`src/services/compose.ts:736` — rama `false` de `if (retryInput)`: sin hits,
  pero SÍ alcanzable** (cuando el LLM devuelve `null`). No es un hueco que abra
  esta HU: es exactamente el mismo hueco preexistente de la rama `false` de
  `if (newInput)` (`:728`), que ya estaba sin cubrir antes de WKH-305. Esta HU
  movió la expresión del guard, no cambió su cobertura.
- Fuera de alcance, preexistentes y sin tocar: `:225` (el `??` de `SCOPE_DENIED`)
  y `:749` (rama `false` de `if (retryDebit.success)`).

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

### [2026-07-29 01:21] W4 — Una aserción VACUA dentro del test escrito para cerrar M12

- **Error**: `T-MAP-C4` (el test nuevo que mata a M12) cerraba con
  `expect(result.totalLatencyMs).toBeLessThan(DEBIT_MS)` y un comentario que
  afirmaba: *"sin esta segunda mitad, un mock de `debit` que no durmiera dejaría
  pasar el test por el motivo equivocado"*. **La aserción no puede fallar por
  construcción**: `totalLatencyMs` es la suma de los `latencyMs` por step, todos
  medidos desde el cronómetro POST-débito, así que jamás puede incluir el tiempo
  del débito duerma lo que duerma el doble. El CR lo probó poniendo
  `debitLatencyMs = 0` (desarmando el escenario que el comentario decía proteger)
  y el test siguió verde.
- **Causa raíz**: escribir la aserción "de refuerzo" razonando sobre el NOMBRE del
  campo (`totalLatencyMs` suena a "el tiempo total, que incluye todo") en vez de
  sobre **cómo se calcula**. Es CD-12 otra vez, en su forma más incómoda: afirmar
  una protección que no existe, dentro del test escrito precisamente para cerrar
  un superviviente.
- **Fix**: se reemplazó por el chequeo que el comentario describía de verdad —
  medir el **reloj de pared de la llamada completa** (`Date.now()` alrededor de
  `composeService.compose`) y exigir `>= DEBIT_MS`. Y se verificó en las dos
  direcciones, que es lo que faltaba la primera vez:
  · fixture armado → verde;
  · `debitLatencyMs = 0` → **rojo** (`expected 75 to be greater than or equal to 150`);
  · M12 re-aplicado → rojo por la aserción principal.
  El comentario ahora además nombra la trampa para que nadie la reintroduzca.
- **Aplicar en**: toda aserción "de refuerzo" que exista para probar que el
  FIXTURE está armado. **Se valida desarmando el fixture y viendo el rojo.** Si al
  romper el escenario el test sigue verde, esa aserción no protege nada — sea cual
  sea el nombre del campo que mira. Mismo método que la mutación, aplicado a los
  propios tests.

---

### [2026-07-29 00:55] Proceso — Especificaciones de OTRAS HUs viajando en esta rama

- **Qué pasó**: la rama `feat/305-wkh-305-compose-field-mapping` contiene, por el
  commit `659a39e` del orquestador durante la pausa por créditos, las
  especificaciones completas (`sdd.md`, `story-*.md`, `work-item.md`) de
  **WKH-303, WKH-306 y WKH-307**. No son de esta HU y están fuera de su alcance.
- **Causa raíz**: la misma que la del mutante congelado — commitear a las apuradas
  para no perder trabajo, tomando el árbol entero en vez de archivo por archivo.
  Es el riesgo conocido de un repo donde varios agentes escriben `doc/sdd/` en
  paralelo mientras uno escribe `src/`.
- **Consecuencia asumida**: el historial de esta rama **no responde limpio "qué
  entró con esta HU"**. Un `git log --stat` de la rama mezcla código de WKH-305
  con documentación de otras tres HUs.
- **Por qué NO se corrige**: sacarlas exigiría cirugía sobre commits ya existentes
  (rebase / filter). El riesgo de perder trabajo ajeno supera al beneficio de un
  historial prolijo. Se deja constancia en vez de operar.
- **Aplicar en**: cuando haya que salvar trabajo en curso, **commitear archivo por
  archivo** (`git add <path>`, nunca `-A` ni `.`), revisando `git status` antes.
  Y si hay una verificación por mutación en vuelo, restaurar ANTES de commitear.

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
