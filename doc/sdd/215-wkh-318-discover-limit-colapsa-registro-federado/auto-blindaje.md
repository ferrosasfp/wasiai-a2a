# Auto-Blindaje — WKH-318

Errores propios cometidos (o trampas encontradas) durante F3. Insumo de la
próxima HU.

---

### [2026-07-30 17:05] Wave 0 — El worktree no tenía `node_modules`

- **Error**: corrí `npx tsc --noEmit` como primera verificación del checklist
  anti-alucinación y leí 53 errores `TS2307 Cannot find module 'vitest' / 'viem'`.
  Por un momento eso se parece a "la baseline ya está rota, hay que avisar"
  (que es justo lo que el story file manda hacer en ese caso).
- **Causa raíz**: `wt-318` es un `git worktree` recién creado. Los worktrees NO
  comparten `node_modules` con el repo principal, y nadie había corrido `npm ci`
  ahí. `npx tsc` igual resolvía un `tsc` (de fuera del worktree), así que el
  comando "funcionaba" y devolvía exit 0 — el fallo se presentaba como errores
  de tipo, no como "falta instalar".
- **Fix**: `npm ci` dentro del worktree. Después, `npx tsc --noEmit` limpio, que
  es la baseline que el story file afirmaba.
- **Aplicar en**: cualquier HU que arranque en un worktree nuevo (`wt-313`,
  `wt-315`, `wt-319` tienen el mismo riesgo). **Antes** de leer una baseline
  como evidencia de nada, verificar que `node_modules/` existe. Un `TS2307`
  masivo sobre paquetes de terceros casi nunca es "la rama está rota": es que no
  hay dependencias instaladas. Distinguir *no pude compilar* de *compila mal* es
  el mismo triplete que esta HU implementa para las fuentes de discovery.

---

### [2026-07-30 17:16] Wave 0 — El criterio de terminado de W0 es inalcanzable como está escrito

- **Error**: el story file pide, como criterio de terminado de **W0**,
  `npx tsc --noEmit` con CERO errores. No es alcanzable sin invadir W1.
- **Causa raíz**: W0 hace `sources` y `catalogStatus` **requeridos** en
  `DiscoveryResult` (W0.2a). Eso rompe a TODO constructor del tipo — y dos de
  esos constructores no son fixtures, son **producción**: el early-return de
  `discovery.ts:221` (que W1.4 arregla) y el `return` del pipeline en
  `discovery.ts:486` (que W1.3 arregla). W0.3 sólo presupuestó los fixtures de
  test, no estos dos sitios.
- **Fix**: NO tapar el agujero con un valor plausible. El early-return se
  implementó en W0 con su forma FINAL de W1.4 (`sources: []`,
  `catalogStatus: 'complete'`), que es correcta y no depende de nada de W1. El
  `return` del pipeline se dejó **rojo a propósito**: rellenarlo con
  `sources: [], catalogStatus: 'complete'` habría metido en un commit un
  "el catálogo siempre está completo" — exactamente la mentira que esta HU
  existe para matar, aunque durara un solo commit. W0 se commiteó con **1 error
  de `tsc` declarado en el mensaje del commit**, y W1.3 lo cerró.
- **Aplicar en**: cualquier HU que vuelva **requerido** un campo de un tipo
  compartido. El costo no es sólo "los fixtures": hay que enumerar también los
  constructores de producción, y decidir wave por wave cuáles tienen un valor
  VERDADERO disponible en esa wave. Cuando no lo hay, un `tsc` rojo declarado es
  más barato que un valor inventado que compila.

---

### [2026-07-30 17:14] Wave 0 — El parcheador mecánico no distingue test de producción

- **Error**: el script que insertó `sources: []` / `catalogStatus: 'complete'`
  en los literales de `DiscoveryResult` se manejó por las posiciones que reporta
  `tsc`, y `tsc` también reporta los dos sitios de `src/services/discovery.ts`.
  El script parcheó producción con el mismo valor plano que los fixtures.
- **Causa raíz**: la lista de sitios a parchear se derivó del *síntoma* (el
  error de compilación) y no del *criterio* (es un fixture de test). Los dos
  conjuntos casi coinciden, y ese "casi" es donde entra un dato inventado en
  producción.
- **Fix**: revisar el `git diff` del parche ANTES de dar la wave por cerrada; se
  revirtió la inserción en el `return` del pipeline y se reescribió el
  early-return a mano con su docstring. El script quedó como está pero su salida
  se lee, no se confía.
- **Aplicar en**: todo refactor mecánico masivo. Un parche generado se revisa
  por diff, y con más cuidado en `src/` que en `*.test.ts`. Si el parcheador no
  puede distinguir producción de test, el que lee el diff sí tiene que poder.

---

### [2026-07-30 17:32] Wave 1 — Mi mock de DNS desactivaba el guard que el test decía probar

- **Error**: `T-SRC-04/ssrf_blocked` daba `failure: 'unknown'` en vez de
  `'ssrf_blocked'`. Mi primer reflejo fue "el clasificador está mal".
- **Causa raíz**: era el test. Para que un host inventado
  (`healthy.example.org`) resolviera, mockeé `node:dns` con
  `mockResolvedValue([{address:'93.184.216.34'}])` — **para todos los hosts**.
  `validateOutboundUrl` NO rechaza un IPv4 literal por su texto: `127.0.0.1`
  pasa el bloqueo literal (rule 3 sólo cubre `localhost`/`*.local`) y se rechaza
  recién en la rule 5, **por lo que devuelve `dns.lookup`**
  (`url-validator.ts:292-318`). Con mi mock, `127.0.0.1` "resolvía" a una IP
  pública, pasaba el guard, y el fallo terminaba siendo mi propio
  `throw new Error('host no ruteado')` del helper de fetch — un `Error` genérico,
  o sea `'unknown'`. **El test pasaba por el camino equivocado y habría dado
  verde a un `classifyFetchFailure` roto.**
- **Fix**: el mock replica la semántica REAL de `dns.lookup` — un IP literal se
  devuelve tal cual, un nombre resuelve a una IP pública.
- **Aplicar en**: todo mock que se interponga entre el test y el guard que el
  test dice ejercitar. Antes de creerle a un test de seguridad, preguntar por
  dónde entró el fallo: si el motivo es genérico (`unknown`, `Error`), lo más
  probable es que el guard real ni se haya ejecutado. Es la misma familia que
  "guards que se comparan consigo mismos": acá el mock se había comido al guard.

---

### [2026-07-30 17:38] Wave 1 — `tsc` no atrapó todos los call-sites del tipo que cambié

- **Error**: cambiar `queryRegistry` de `Promise<Agent[]>` a
  `Promise<RegistryFetchOutcome>` rompió DOS tests en
  `discovery.ssrf.test.ts`. `tsc` marcó **uno solo** (`agents[0]!.slug`, TS7053).
  El otro (`expect(agents).toEqual([])`) **compila perfecto**: `toEqual` acepta
  `any`, así que un objeto comparado contra un array es un error de runtime, no
  de tipos. Lo cazó la suite, no el compilador.
- **Causa raíz**: haber tomado "`tsc` limpio" como prueba de que ya estaban
  todos los consumidores migrados. Las aserciones de test son un agujero
  sistemático en esa garantía: `toEqual`, `toMatchObject` y `expect(x).toBe(y)`
  no propagan el tipo del sujeto.
- **Fix**: se migró el segundo call-site y, ya que el test estaba ahí, se le
  agregaron los asserts de `state`/`rows` que el nuevo contrato permite.
- **Aplicar en**: cuando cambies el tipo de retorno de una función exportada, la
  lista de call-sites se arma con `grep` del NOMBRE, no con la lista de errores
  de `tsc`. Y la wave no cierra con `tsc` limpio: cierra con `tsc` limpio **y**
  la suite completa verde. Este repo ya tiene el precedente inverso (WKH-196:
  `npm run build` verde con la suite rota).

---

### [2026-07-30 18:40] Fix-pack AR — Maté el colapso de tres valores y dejé vivo el de dos

- **Error** (AR BLQ-1): puse tanta atención en que `rows` no colapsara
  `0` con `null` que no vi que **`state` colapsaba dos cosas en `ok`**:
  *"respondió y trajo todo"* y *"respondió y no tengo forma de saber si trajo
  todo"*. Y elegía la primera. Era el caso de PRODUCCIÓN, no un borde: el
  registro real se siembra sin `nextCursorPath` y `/capabilities` llama a
  `discover({})` sin `limit`, así que no hay evidencia obtenible por ningún lado.
  El repro del AR: 20 filas **con `next_cursor` seteado** devolvían
  `{"state":"ok","catalogStatus":"complete"}`.
- **Causa raíz**: escribí la detección de truncamiento como *"buscar evidencia de
  que FALTA algo, y si no la encuentro, está completo"*. Ese default es una
  afirmación disfrazada de ausencia. `ok` era el valor por descarte, y por
  descarte no se prueba nada. Es la misma estructura del bug que la HU ataca, un
  nivel más adentro: el original decía "consulté este registro" sin haberlo
  consultado; el mío decía "esta fuente me dio todo" sin poder saberlo.
- **Fix**: invertir la carga de la prueba. `ok` exige **evidencia positiva** de
  completitud (el registro declara que no hay más, o la página no se llenó), y
  sin ninguna de las dos el estado es `unverified`. El roll-up gana el mismo
  escalón: `partial > truncated > unverified > complete`.
- **Falsifiqué una afirmación mía en un commit**: escribí que sin las migraciones
  "el código es inerte y **falla en la dirección segura**". La inercia era cierta
  y estaba probada. La dirección **no**: fallaba sobre-declarando completitud,
  que es la insegura. Dije dos cosas y sólo verifiqué una.
- **Aplicar en**: cuando un tipo tenga un valor que signifique "todo bien",
  preguntarse **qué lo prueba**. Si la respuesta es "que no encontré nada malo",
  hay dos estados escondidos ahí y uno es una afirmación sin respaldo. Y al
  escribir "falla en la dirección segura", verificar **la dirección**, no sólo
  que falle: son dos afirmaciones y la segunda es la que importa.

---

### [2026-07-30 18:55] Fix-pack AR — Apliqué la regla nueva a las fuentes remotas y me olvidé de la local

- **Error** (AR BLQ-2): el `catch` del SELECT de self-published seguía degradando
  a `localAgents = []`, y la fila de esa fuente se empujaba a `sources` sólo si
  `localAgents.length > 0`. O sea: **un SELECT caído era indistinguible de "no hay
  agentes self-published"**, y el catálogo se declaraba `complete` igual. Es
  exactamente el bug que la HU mata, del lado local — y encima sobre la fuente
  que carga los tres agentes del money-path de Chaski.
- **Causa raíz**: traté "el fanout federado" como el lugar donde vivía el
  problema, porque ahí estaba el `.catch(() => [])` que el work-item nombraba. La
  fuente local entra por otro camino (un `try/catch` 250 líneas más arriba) y
  nunca la pasé por la regla nueva. El gate `length > 0` ya estaba ahí de antes y
  lo leí como parte del paisaje.
- **Fix**: la fila entra por **haberse consultado**, no por haber traído filas.
  `null` pasa a significar una sola cosa —no se la consultó, porque el caller
  filtró a otro registry— y el fallo del SELECT viaja como `failed`/`rows: null`
  con su `log.warn` estructurado, igual que una fuente remota.
- **Aplicar en**: cuando una HU introduce una regla ("toda fuente declara cómo le
  fue"), enumerar **todas** las fuentes por las que entran datos, no sólo la que
  el bug original nombraba. Un `catch` que asigna un valor vacío es siempre
  sospechoso, esté donde esté: `[]` no puede distinguir *no hay* de *no pude*.

---

### [2026-07-30 19:30] Post-fix-pack — La misma regla se me escapó TRES veces, y cada vez en un borde distinto

- **El patrón** (lo nombra el AR en su hallazgo B-5, después de aprobar): la regla
  de esta HU es *"toda fuente declara cómo le fue"*. La escribí tres veces y las
  tres veces la apliqué de menos:
  1. **W1** — la apliqué al fanout federado, que era donde el work-item señalaba
     el `.catch(() => [])`.
  2. **BLQ-2** — no había llegado a la **fuente local**, que entra por otro camino
     (un `try/catch` 250 líneas más arriba) y desaparecía en silencio.
  3. **B-5** — ya arreglada la fuente local, sigue sin llegar a la **completitud**
     de esa fuente local: se declara `ok` incondicionalmente. Repro del AR:
     `listAsAgents()` con 5000 filas ⇒ `{"catalogStatus":"complete","rows":5000}`,
     mientras la misma cantidad de filas por el camino federado da `unverified`.
     **Dos reglas para el mismo hecho.**
- **Causa raíz**: cada vez tomé como frontera el lugar donde el bug se había
  manifestado, en vez de la definición de la regla. Y en el tercer caso hay un
  agravante propio: justifiqué el `ok` con un **argumento de construcción metido
  en un comentario** (*"listAsAgents() es un SELECT sin limit"*) en vez de con
  evidencia en la respuesta. Un comentario no es evidencia: si mañana PostgREST
  aplica `db-max-rows`, el SELECT devuelve el tope con un `Content-Range` que
  nadie lee y el comentario sigue diciendo lo mismo, ahora falso. **Grep en todo
  el árbol de `max_rows|max-rows|Content-Range|.range(`: cero hits** — o sea, ni
  se lee el header ni está pineado el valor.
- **Fix**: NO se aplicó (toca 7 tests y va al corte B). Queda como **B-5, marcada
  precondición del corte B**, con las tres salidas posibles escritas.
- **Aplicar en**: cuando una HU introduzca una regla general, **enumerar las
  instancias antes de implementarla** y tachar de una lista, en vez de arreglar
  los sitios a medida que aparecen. Y desconfiar de todo `state`/`status` que se
  asigne **incondicionalmente**: si el valor no sale de mirar la respuesta, sale
  de una creencia — y las creencias no se testean, se comentan.

---

### [2026-07-30 17:55] Waves 1–2 — Dos nominaciones de mutante del story file no se sostienen

- **Hallazgo** (no es un error propio, es una corrección al story file, verificada
  mutante por mutante con la disciplina de §9):
  - **M2b** (`(s.rows ?? 0) >= 0`) está nominado a `T-SRC-05`. `T-SRC-05` **NO lo
    mata**: es el camino feliz con una sola fuente `ok`/`rows: 3`, y con `>` o con
    `>=` el resultado es el mismo `['test-registry']`. Los que sí lo matan son
    `T-SRC-02` (una fuente `ok` con `rows: 0` pasaría a figurar en `registries`) y
    `T-SRC-01`/`T-SRC-07` (una fuente `failed` con `rows: null` también, porque
    `null ?? 0` es `0`). Medido: 5 tests rojos, ninguno de ellos `T-SRC-05`.
  - **T-SRC-06** pide asertar "los 11 campos previos" de `/capabilities`. Los
    campos previos **medidos son 12** (`name`, `description`, `url`, `protocol`,
    `capabilities`, `methods`, `inputModes`, `outputModes`, `chains`, `agents`,
    `agentsTotal`, `registries`). El test asserta el conjunto medido y congela las
    14 claves exactas.
- **Aplicar en**: una tabla de "mutante → test que lo mata" escrita junto al
  diseño es una **hipótesis**, no una medición. Correr el mutante y anotar QUÉ
  test se puso rojo es lo único que la convierte en evidencia. Un KILLED
  reportado contra el test nominado sin haber mirado la lista real de fallos es
  un falso positivo esperando su turno.

---

### [2026-07-30] Wave 0 — El número de fixtures estimado no era el medido

- **Nota** (no es un error propio, es calibración para el próximo): el story
  file estimaba **~61 sitios en 17 archivos**, con `src/__tests__/e2e/setup.ts:67`
  marcado como "crítico". Lo **medido** con `tsc` fue **51 sitios en 12
  archivos**, y `setup.ts` **no aparece** (su literal no se type-checkea contra
  `DiscoveryResult`). El mayor concentrador sí se confirmó:
  `src/services/orchestrate.test.ts` con **31**.
- **Aplicar en**: las estimaciones por escaneo de texto sobre-cuentan. Medir con
  el compilador antes de presupuestar el trabajo, y reportar el número medido —
  no repetir el estimado como si se hubiera verificado.
