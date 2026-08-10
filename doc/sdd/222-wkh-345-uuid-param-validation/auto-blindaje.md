# Auto-Blindaje — WKH-345 (F3)

> Mis propios errores durante la implementación, no hallazgos sobre el código.
> Todo número de acá lo medí yo, con el commit al lado.

---

### [2026-08-10] Wave 0 — Copié a un docblock una afirmación del Story File que no medí, y era falsa

- **Error**: escribí en `src/lib/uuid.ts` que endurecer el regex a v4 dejaba a
  "la suite completa CIEGA", y en `src/lib/uuid.test.ts` que T-U2 era "el ÚNICO
  testigo de ese mutante en todo el repo". Las dos frases venían del Story File
  (§8, M-2) y las puse como si las hubiera verificado.
- **Cómo se cayó**: al correr M-2 de verdad (`062d6ff2…`, contra mi línea base
  `2d8168c`), el resultado fue **13 rojos**, de los cuales **11 están fuera de
  `uuid.test.ts`**. La premisa del Story File era "todos los ids del repo salen
  de `gen_random_uuid()`, que ya es v4" — cierto para los ids que genera la
  **base**, falso para los **fixtures escritos a mano**:
  `src/routes/tasks.test.ts:95` es `'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'`, que
  no tiene forma de v4. Bonus del mismo error: T-U4 también muere con M-2
  (`'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'` tampoco es v4), y eso tampoco estaba
  previsto.
- **Causa raíz**: traté una afirmación *falsable* de un documento de entrada como
  si fuera parte del contrato. El contrato del Story File son las decisiones
  (D-1..D-4) y las prohibiciones; sus **mediciones** son de otro commit y de otro
  autor, y P-14 lo dice explícitamente. Un docblock es código: cuando afirma un
  número, quien lo lee no tiene forma de saber que fue copiado.
- **Fix**: medí M-2 sobre la suite completa y reescribí las dos prosas con el
  número real, el commit, y la consecuencia que de verdad importa — que los 11
  rojos señalan "el fixture no es v4" y **no** "el contrato no debe pedir v4", así
  que la lectura natural del rojo es arreglar los fixtures y estrechar el
  contrato con la suite en verde. Ése sí es el valor de T-U2.
- **Aplicar en**: cualquier comentario que describa **qué hace un mutante**. Si
  la frase es falsable con un comando, o la corro, o no la escribo. Vale igual
  para "el resto de la suite no ve X": es una afirmación sobre 5400 tests y no se
  deduce leyendo uno.

---

### [2026-08-10] Wave 2 — Corrí sólo los archivos que toqué y canté "verde" con 2 rojos en el árbol

- **Error**: al cerrar W2 corrí `vitest run` sobre los 8 archivos de test del
  Scope IN, vi `PASS (90) FAIL (0)` y lo leí como "W2 verde". Commiteé
  (`2d8168c`) sobre esa lectura. El árbol tenía **2 tests rojos** que ese comando
  no podía ver: `src/services/arbiter.test.ts:991` y `:1010` inyectan
  `POST /payments/session/i1/dispute` y esperan 200 y 409; con el guard nuevo,
  `i1` no tiene forma de UUID → 422.
- **Cómo lo encontré**: por casualidad, y por el lado equivocado. Aparecieron en
  la lista de rojos de **M-2**, mezclados con los colaterales del mutante. Recién
  ahí corrí la suite completa sin mutar y confirmé que eran preexistentes a
  cualquier mutante. Si M-2 hubiera sido opcional y lo hubiera salteado, esto se
  iba a AR.
- **Causa raíz**: dos capas del mismo error. (a) Sustituí la suite completa por
  una corrida dirigida porque **supuse** que el radio de impacto de los guards
  era local a `src/routes/`. (b) Ese supuesto lo heredé del censo del Story File
  (§5), que enumera 20 fixtures en 5 archivos y **todos** están bajo
  `src/routes/`. Confié en el alcance de un documento en lugar de medir el radio
  yo: el archivo que **inyecta** en una ruta no tiene por qué vivir al lado de la
  ruta, y acá vive en `src/services/`.
- **Fix**: (1) suite completa como única fuente del veredicto de wave — la
  corrida dirigida sirve para iterar rápido, nunca para cerrar; (2) me escribí un
  censo propio que busca, en **`src/` y `test/` enteros** (495 archivos), todo
  string que arme una URL hacia una superficie con guard con un `:id` sin forma de
  UUID. Escalado y arreglado con autorización; censo final: **11 sitios, los 11
  deliberados, cero accidentales, ningún 7º archivo**.
- **El criterio corregido**, que es lo único que sobrevive al script:

  > El censo de fixtures de path param se define por **lo que el fixture
  > construye**, no por dónde vive el archivo.

- **Aplicar en**: toda HU que cambie **la respuesta de una ruta compartida**. El
  censo va por *superficie HTTP* (la URL), no por *directorio* — acotarlo a
  `src/routes/` es exactamente lo que dejó pasar este caso. Y si un documento de
  entrada trae una lista de sitios, la lista es una pista, no el perímetro: el
  perímetro se mide.

---

### [2026-08-10] Wave 2 — T-5, tal como está especificado, no puede matar al mutante que dice matar

- **Qué pasó**: §7 especifica T-5 como `DELETE /auth/key-session/<uuid-válido>`
  con un `SESSION_TOKEN`, esperando `403` + `lookupByHash` no llamado, y le
  asigna el mutante "mover el guard antes del gate de prefijo". Con un `:id` de
  forma **válida** ese mutante es invisible: el guard lo deja pasar y el gate de
  prefijo sigue devolviendo `403`. El test queda verde y el mutante sobrevive.
- **Por qué el Story File llegó ahí**: en `2745bb2` el testigo de ese orden era
  T-SUBSESSION (`auth.key-session.test.ts:161`), que usaba `sess-1`
  —**malformado**— y por eso sí moría. W1 refixtureó ese mismo `url:` a un UUID
  válido, y con eso apagó la propiedad que hacía a T-SUBSESSION un testigo. Los
  dos pasos son correctos por separado; juntos se anulan.
- **No lo resolví argumentando: lo medí.** Apliqué un cuarto mutante (M-4:
  mover el bloque del guard arriba del gate de prefijo en `DELETE
  /key-session/:id`; `sha256sum` `29770366…` → `7472834d…`). Resultado:
  **T-5 rojo** (`400` donde espera `403`), **T-SUBSESSION verde**.
- **Fix**: T-5 va con `:id` **malformado**, que es la única forma en que puede
  morir. T-SUBSESSION queda como está (con UUID válido): prueba lo
  complementario, que el guard nuevo no rompió el gate para ids bien formados.
  Los dos hacen falta y el comentario de T-5 dice por qué.
- **Desvío declarado**: es un apartamiento de la letra de §7. No cambia ninguna
  decisión (D-3 se refuerza, no se re-abre) ni sale del Scope IN. Queda acá y en
  el reporte para que AR lo juzgue.
- **Aplicar en**: cuando una wave de fixtures y una wave de tests toquen el mismo
  `url:`, preguntarse **qué propiedad del fixture viejo era la que medía**. Un
  refixture puede desarmar un testigo sin poner nada en rojo. Y el control es el
  de siempre: si un test dice qué mutante lo mata, aplicalo.

---

### [2026-08-10] Wave 3 — Escribí en el log un commit que todavía no existía

- **Error**: al documentar el Paso B puse `` `7f4ad2c` `` como su commit. Ese hash
  **no existía**: lo escribí antes de commitear, con la forma correcta de un hash
  corto de git. El commit real terminó siendo `f69bff8`.
- **Causa raíz**: la misma de la entrada #1, y a una hora de distancia. Rellené un
  campo que **parece** un dato medido con algo que no medí, porque el documento
  pedía "conteo + commit en la misma línea" y yo tenía el conteo pero todavía no el
  commit. El orden correcto era commitear y después escribir.
- **Por qué es peor que un typo**: un hash inventado es **indistinguible de uno
  real** para quien lee. No falla ningún test, no lo caza ningún lint, y `git show`
  sobre él da "unknown revision" recién cuando alguien intenta verificarlo. Es la
  forma más pura de "evidencia que se auto-confirma": una cita con formato
  impecable apuntando a la nada.
- **Fix**: commiteé primero, leí el hash con `git rev-parse --short HEAD`, y
  reemplacé el inventado verificando que hubiera **exactamente una** ocurrencia
  antes de tocar nada. Después re-corrí la suite completa con `src/` limpio en
  `f69bff8` para que el número y el commit sean de la misma cosa.
- **Aplicar en**: **ningún identificador se escribe antes de existir** — commits,
  hashes, líneas de archivos que todavía no guardé, ids de PR. Si el documento
  necesita el dato, el dato va después del comando que lo produce, nunca antes. Y
  el control es barato: `git rev-parse <hash>` sobre cada hash citado.

---

### [2026-08-10] Wave 3 — Mi propio find/replace me rompió la prosa y las citas, en el mismo commit

Dos daños de una sola edición mecánica sobre `src/services/arbiter.test.ts`.

- **Error A — el reemplazo se comió su propia explicación.** Inserté un docblock que
  decía «Con el `'i1'` anterior esas cuatro URLs cruzaban el guard por accidente» y
  **después** corrí `s.replace("'i1'", "INTENT_ID")` sobre todo el archivo. El
  replace no distingue código de comentario: dejó «Con el `INTENT_ID` anterior»,
  o sea una frase que afirma que el id anterior era el nuevo. Se contradice sola.
- **Error B — cité líneas de antes de mi propio desplazamiento.** El bloque de la
  constante agregó 10 líneas arriba de todo, así que el `:385` del falso pasó a
  `:395` y el nonce de `:1394` a `:1404`. Escribí en el log los números **viejos**,
  que ya no existían cuando guardé el documento.
- **Causa raíz común**: traté una edición mecánica como atómica cuando tiene dos
  efectos, y los dos son invisibles para los gates. `npm test` da verde con un
  comentario que miente; `tsc` y `biome` no leen prosa ni verifican que un
  `archivo:línea` de un `.md` apunte a algo. El único instrumento que los ve es
  releer **después** de la última edición, que es justo el paso 5 de §9.
- **Fix**: (1) restauré la frase del docblock; (2) barrí `grep -n "INTENT_ID"`
  filtrando los usos sintácticos, para encontrar todos los lugares donde el replace
  había entrado en prosa — apareció uno más, `:1401`, que en ese caso era correcto;
  (3) re-medí las dos líneas con `python3` y corregí el log, dejando escrito el
  desplazamiento (**+10**) en vez de sólo el número nuevo, así la próxima cita se
  puede recalcular.
- **Aplicar en**: cuando un find/replace toque un archivo donde también escribí
  comentarios, el orden correcto es **replace primero, prosa después**. Y toda cita
  a un archivo que yo mismo desplacé se re-mide después de la última edición: los
  barridos miran lo que escribí, no lo que **moví**.

---

### [2026-08-10] Fix-pack MENORes — PATRÓN: un refixture consume el testigo, y el que se queda solo no lo sabe

Ya no es anécdota: **dos instancias medidas en esta misma HU**, con el mismo
mecanismo y las dos invisibles para los gates.

- **Instancia 1 (auto-blindaje #3)**: W1 cambió el `url:` de T-SUBSESSION
  (`auth.key-session.test.ts`) de `sess-1` a un UUID válido. Con eso T-SUBSESSION
  dejó de ser el testigo del orden "gate de prefijo antes del guard". Medido con
  M-4: T-5 rojo, **T-SUBSESSION verde**.
- **Instancia 2 (ésta)**: el refactor a `INTENT_ID` cambió el `url:` de
  `arbiter.test.ts` (el `POST` dispute con flag OFF) de `'i1'` a un UUID válido.
  Con eso dejó de ser el testigo del orden `isArbiterEnabled()` antes del guard.
  Medido con M-5 (`payments.ts` `b1cfcd21…` → `c0502dd2…`, en `c3b7333`): **1 solo
  rojo en todo el repo, T-4e**, y `arbiter.test.ts` **64 passed (64)**.

- **El patrón, escrito para que sirva sin el contexto de esta HU**:

  > Un test es testigo de un **orden** sólo mientras su input pueda ser rechazado
  > por la primera de las dos guardas. Refixturear ese input a un valor que ambas
  > aceptan **apaga el testigo sin poner nada en rojo** — el test sigue pasando, y
  > pasa por el motivo equivocado. Y el testigo que sobrevive queda **solo**, sin
  > que nada en el repo lo diga.

- **Por qué es peligroso y no sólo prolijo**: no es la cobertura que se pierde hoy,
  es la que se pierde **mañana**. Acá quedó T-4e como único testigo de D-3: si
  alguien lo borra o lo "simplifica" a un `:id` bien formado —razonando que
  `arbiter.test.ts` ya prueba el flag OFF— la propiedad queda sin ningún test y la
  suite sigue verde. Ninguno de los tres gates lo ve: `npm test` da verde,
  `tsc` y `biome` no leen semántica de cobertura.
- **Fix**: tres lugares, porque el que borra un test no lee el `.md`.
  (1) El log lo declara: sección "El arreglo CONSUMIÓ un testigo".
  (2) El aviso vive **en el propio testigo**, no sólo en la doc: el comentario de
  T-4e (`src/routes/payments.uuid-param.test.ts`) dice que es el único, con el
  número medido y con la advertencia de que refixturear su `:id` a uno válido lo
  apaga igual que borrarlo.
  (3) El comentario del código de producción que fija el orden ya nombraba al test
  (`payments.ts:352-356`), así el camino también existe desde el lado del código.
- **Aplicar en**: **cada vez que una wave de fixtures cambie un `url:`/input que
  otra wave usa como testigo de orden**, el control son dos preguntas y un comando:
  ¿qué propiedad del input viejo era la que medía?, ¿queda algún otro test con esa
  propiedad? — y después aplicar el mutante de orden y **contar cuántos rojos da**.
  Si da **uno**, ése es el único testigo y hay que escribirlo. Si da **cero**, la
  propiedad ya no tiene cobertura.

---

### [2026-08-10] Fix-pack MENORes — Le cargué a un mutante 2 fallos que ya estaban rojos, y cité un `sha256sum` sin su commit

Dos formas de inflar evidencia de mutación, las dos mías, las dos en la sección
"Mutación" del log (una en la tabla, la otra en el párrafo que la introduce), y una
de ellas además **en un docblock de producción**.

- **Error A — el mutante no mató 13, mató 11.** Escribí "M-2 → 13 rojos, 11 fuera
  de `uuid.test.ts`" en `src/lib/uuid.ts` y en el log. Medido en `2d8168c`, sí: pero
  en **ese** commit `arbiter.test.ts:991` y `:1010` ya estaban rojos **sin ningún
  mutante** (es la entrada #2 de este mismo archivo, o sea que yo ya lo sabía). Los
  conté como víctimas del mutante. La fila de M-3 sí desglosaba "+ los 2
  preexistentes"; la de M-2 no. Re-medido en `c3b7333` con el árbol limpio:
  **M-2 = 11 rojos, 9 fuera** (los 9 en `tasks.test.ts`), **M-3 = 32 rojos, 29
  fuera en 9 archivos**.
- **Error B — un `sha256sum` de "original" sin commit al lado.** El log daba
  `3595862d…` como el original de `src/lib/uuid.ts`, sin decir dónde. Ese hash vale
  en `af4e126`/`c9bcee0`/`2d8168c`; desde `7862f88` el archivo es `616b7c54…`. Quien
  re-corriera el mutante hoy calcularía un original distinto del citado y **no
  tendría forma de distinguir eso de una manipulación del archivo** — que es justo
  lo que el control R-1 existe para descartar.
- **Causa raíz común**: un número de mutación es un **par** (resultado, estado del
  árbol), y yo escribí sólo el primer miembro. Sin el commit, "13 rojos" y
  `3595862d…` no son verificables ni falsables: son decoración con formato de dato.
  Y en el caso de A hay algo peor — el número **exagera a favor de mi propio test**:
  hace parecer que el mutante tiene 2 víctimas más de las que tiene.
- **Fix**: (1) re-corrí M-2 y M-3 sobre la suite completa en `c3b7333` y reescribí
  los tres lugares (docblock de `uuid.ts`, docblock de `uuid.test.ts`, tabla del
  log) con los números medidos; (2) el log ahora lleva una tabla de "originales,
  cada uno con el commit donde vale", leídos con
  `git show <commit>:<archivo> | sha256sum` (del objeto de git, no del árbol); (3)
  cada fila de mutante tiene columna **"Medido en"**.
- **Aplicar en**: **todo resultado de mutación se escribe con el commit del árbol
  base, y todo `sha256sum` de "original" con el commit donde vale.** Antes de
  atribuirle un rojo a un mutante, correr la suite **sin** el mutante en ese mismo
  commit: la resta es la única forma de separar la víctima del preexistente. Es el
  mismo control que la entrada #4 pide para los hashes de commit, aplicado a los
  hashes de contenido.
