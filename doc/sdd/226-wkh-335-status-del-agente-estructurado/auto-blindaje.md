# Auto-Blindaje — WKH-335 (#226)

Errores cometidos durante F3 y cómo se corrigieron. Se escribe cuando el error
ocurre, no al final.

---

### [2026-08-25 06:02] Wave 1 — El `lint` cazó dos archivos sin formatear que `tsc` y `vitest` dejaron pasar

- **Error**: `npm run lint` (`biome check src/`) salió con exit 1 y `Found 2 errors`
  sobre `src/lib/agent-http-error.ts` y `src/lib/agent-http-error.test.ts`. Los dos
  eran `× Formatter would have printed the following content:` — llamadas que biome
  quiere partir en varias líneas (`super(...)`, `expect(...)`).
- **Causa raíz**: escribí los archivos nuevos a mano respetando el ancho de línea
  "a ojo". `npx tsc --noEmit` salió 0 y `npx vitest run src/lib/agent-http-error.test.ts`
  dio `29 passed (29)` **antes** de correr lint: los dos sub-gates que corrí primero
  son ciegos al formato.
- **Fix**: `npx biome check --write` sobre esos dos archivos, y re-correr el gate
  **desde el paso 1**, no desde donde falló. Verificado que el `super()` reformateado
  deja el template literal intacto — el `message` sigue byte-idéntico (CD-9), que lo
  mide `T-335-CD9`.
- **Aplicar en**: TODO archivo nuevo de `wasiai-a2a`. `lint` va **segundo** en el gate
  de este repo y es el único de los tres que mira el formato. Correr `tsc` + `vitest`
  y cantar verde es exactamente la falla que la regla 9 del CLAUDE.md documenta.
  En `chaski-v3` el `lint` va **primero** dentro de `npm run qa`, así que ahí falla
  antes; acá no.

---

### [2026-08-25 06:03] Wave 1 — 🔴 El Story File afirmaba "exposición cero" al guardián de citas, y era FALSO

- **Error**: `npm test` completo salió rojo con
  `G-C5: el ancla citada sigue ahí, es única, y el archivo citado es el correcto`
  → `Hay 2 cita(s) declarada(s) que ya no describen lo que hay en el archivo citado`:

  ```
  src/types/index.ts :: src/services/compose.ts:571
      E-LINE_MOVED · tu ancla está ahora en `src/services/compose.ts:589`
  src/services/compose.ts :: :571
      E-LINE_MOVED · tu ancla está ahora en `src/services/compose.ts:589`
  ```

- **Causa raíz**: el Story File (§Anti-Hallucination Checklist, último bullet) declara:

  > *"las únicas citas declaradas hacia los archivos que tocás son
  > `src/services/compose.ts:571` y `src/types/index.ts:217-218`, **las dos ANTES de
  > todo punto de inserción de esta HU** ⇒ exposición cero"*

  La segunda mitad es falsa. El Architect enumeró como "puntos de inserción" los tres
  sitios de LÓGICA (`:1755` el throw, `:1146-1159` y `:1178-1190` los dos `return`),
  que efectivamente están después de `:571`. **Se olvidó de los otros dos sitios que el
  propio Story File manda tocar y que están ARRIBA de `:571`:**
  - W1.2.1, el `import` de `AgentHttpError` (línea ~11): +3 líneas
  - W1.2.3, el helper `agentFailureResult` junto a `withheldResult` (línea ~160): +15 líneas

  Total +18 ⇒ `571` → `589`. El ancla (`if (i > 0 && scopingKeyRow && ...`) no cambió;
  se corrió sola. Es literalmente el fenómeno que el guardián existe para cazar:
  **la cita que rompés vos al editar otra cosa**, y el barrido del diff no la ve porque
  esas líneas no están en el diff.
- **Fix**: re-anclar las 2 citas + la prosa que repetía el número, en el mismo commit
  que las desplazó (CD-12):
  - `src/types/index.ts:1507` — `src/services/compose.ts:571` → `:589` *(in-scope)*
  - `src/services/compose.ts:706` — `` guard `i > 0` de :571 `` → `:589` *(in-scope)*
  - `test/cited-lines-guard.citations.ts:263-265` y `:313-315` — `cite`/`line`
    `571` → `589` **⚠️ archivo FUERA del Scope IN** (ver abajo)
  - `test/cited-lines-guard.citations.ts:260` — la prosa que decía *"El guard
    anti-doble-débito vive en `src/services/compose.ts:571`"*, que quedó falsa
  Verificado abriendo `src/services/compose.ts:589` antes de copiar el número: dice
  `if (i > 0 && scopingKeyRow && chainId !== undefined) {`, que es el ancla declarada.
  Después: `npx vitest run test/cited-lines-guard.test.ts` → `12 passed`.
- **Desviación de scope declarada**: `test/cited-lines-guard.citations.ts` **no está en
  la tabla "Files to Modify/Create"**. Se tocó igual porque (a) es la DECLARACIÓN de la
  cita que mi propia edición rompió, (b) sin eso `npm test` queda rojo y el gate de
  Wave 1 no cierra, y (c) el cambio es mecánico: dos números y una línea de prosa, cero
  lógica. Queda para que el CR lo contraste explícitamente.
- **Aplicar en**: **cualquier HU que agregue un `import` o un helper cerca del techo de
  un archivo citado.** La pregunta correcta no es *"¿toco líneas después de la cita?"*
  sino *"¿inserto o borro CUALQUIER línea antes de la cita?"* — y un import siempre está
  antes de todo. En `chaski-v3` (Wave 2) esto es peor: **no hay guardián**, y ahí el
  Story File ya lista 4 citas que se desplazan. Ninguna de las dos de acá estaba en esa
  lista, así que la lista del Architect es un piso, no un techo: hay que barrer.

---

### [2026-08-25 06:03] Wave 1 — La carpeta de la HU existía en disco y no en git, y 3 guards lo cazaron

- **Error**: `npm test` completo, además de lo anterior, en rojo con 3 fallos de
  `test/sdd-index-matches-folders.test.ts` (`G-B1`, `G-E1`, `G-T`):
  *"`doc/sdd/226-wkh-335-status-del-agente-estructurado/` existe en el disco y NO en
  git: para cualquiera que clone el repo esa HU no existe, y su fila del índice linkea
  a la nada."*
- **Causa raíz**: la carpeta (con `work-item.md`, `sdd.md`, `story-file.md`) venía
  **untracked de fases anteriores** — `git status` al empezar ya mostraba
  `?? doc/sdd/226-.../` y `M doc/sdd/_INDEX.md`. La fila del índice ya estaba escrita y
  apuntaba a archivos que git no conocía. No lo introdujo F3, pero **F3 lo agravó**
  agregando `evidencia-rojo-antes.md` a esa misma carpeta.
- **Fix**: `git add doc/sdd/226-wkh-335-status-del-agente-estructurado/`. El guard
  deriva de `git ls-files -- doc/sdd`, que **sí** ve lo staged, así que no hace falta
  commitear para verlo verde. Después: `24 passed (24)` en los dos archivos de guard.
- **Aplicar en**: al empezar CUALQUIER fase en un worktree, correr `git status` y mirar
  si los artefactos de las fases anteriores están en git. Un `?? doc/sdd/...` no es
  ruido: en este repo pone el gate en rojo, y el rojo aparece recién en `npm test`, o
  sea en el ÚLTIMO de los tres pasos del gate.

---

### [2026-08-25 06:08] Wave 1 — 🔴 Un archivo NUEVO sin `git add` da un gate VERDE FALSO en este repo

- **Error**: corrí el gate completo a las 06:05 y salió **verde** (`298 passed | 6 skipped`,
  `5962 passed`). Después stageé los dos archivos nuevos y el MISMO gate salió **rojo**:

  ```
   ❯ test/readme-numbers.test.ts (13 tests | 4 failed)
   FAIL  README.md (inglés) > declara el número real de archivos de test
   AssertionError: expected 303 to be 304
   FAIL  README.md (inglés) > declara el número real de archivos que linta Biome
   AssertionError: expected 501 to be 503
   (+ los dos gemelos de README.es.md)
  ```

- **Causa raíz**: `test/readme-numbers.test.ts` deriva sus dos números **del índice de
  git** (`vitest.config.ts` include ∩ `git ls-files`, y `src/**/*.ts` de `biome.json` ∩
  `git ls-files`), no del filesystem. Mientras `src/lib/agent-http-error.ts` y
  `src/lib/agent-http-error.test.ts` estaban **untracked**, los guards **no los veían**:
  el gate medía un árbol en el que mis dos archivos nuevos no existían. El verde de las
  06:05 era falso, y lo era **exactamente sobre lo que esta HU agrega**.
  Es el mismo mecanismo que el fallo de `sdd-index-matches-folders` de la entrada
  anterior, pero desde el otro lado: allá el rojo avisaba, acá el silencio mentía.
- **Fix**: `git add` de los archivos nuevos **antes** de correr el gate, y actualizar los
  4 números publicados que la HU volvió falsos:
  - `README.md:378` — `**303 test files**` → `**304 test files**`
  - `README.md:383` — `over **501 files**` → `over **503 files**`
  - `README.es.md:412` — `**303 archivos de test**` → `**304 archivos de test**`
  - `README.es.md:417` — `sobre **501 archivos**` → `sobre **503 archivos**`
  La aritmética se verificó contra lo que el guard deriva, no a ojo: +1 archivo de test
  (`agent-http-error.test.ts`) y +2 archivos que linta biome (ese más
  `agent-http-error.ts`), que es exactamente `303→304` y `501→503`.
- **Desviación de scope declarada**: `README.md` y `README.es.md` **no están en la tabla
  "Files to Modify/Create"**. Se tocaron porque son números DERIVADOS que el propio
  guardián del repo exige sincronizar en el mismo commit; sin eso `npm test` queda rojo.
  Cambio mecánico: 4 números, cero prosa nueva, cero lógica.
- **Aplicar en**: **`git add` de todo archivo nuevo ANTES de correr el gate, siempre.**
  En este repo hay al menos dos familias de guards que derivan del índice de git
  (`readme-numbers`, `sdd-index-matches-folders`), así que "correr el gate" sobre un
  árbol con archivos untracked **no es correr el gate**: es correrlo sobre otro árbol.
  Y la regla general que deja: *un archivo nuevo en `src/` mueve contadores publicados*
  — el Story File no lo previó en el presupuesto ni en la tabla de archivos.

---

### [2026-08-25 06:19] Wave 2 — 🔴🔴 El Story File decía que `chaski-v3` NO tiene guardián de citas. SÍ TIENE. Y rompí 53.

- **Error**: el Story File afirma, dos veces y en mayúsculas:

  > *"`chaski-v3` **NO tiene guardián de citas** (sus `*guard*.test.ts` son de otras cosas). Nada va
  > a cazar una cita rota: **el instrumento sos vos**."*

  y lista **4** citas que se desplazan. Las dos mitades son falsas:
  1. **El guardián existe**: `src/composition/citas-ancladas.test.ts` (WKH-327 / CR-MNR-2), y corre
     en cada `npm test`. No se llama `*guard*`, se llama *"candado anti-drift de las citas
     `archivo:línea`"* — buscarlo por el patrón del nombre es lo que lo hizo invisible.
     Hay un SEGUNDO candado además: `scripts/smoke-helpers.test.ts` verifica las citas
     `flow-vm.ts:NN` que viven en `scripts/`.
  2. **No eran 4, eran 53.** Medido: con Wave 2 escrita, `citas-ancladas.test.ts` reportó
     `expect(rotas).toEqual([])` con **53 entradas**.

- **Causa raíz**: Wave 2 toca 8 archivos muy citados y **toda inserción desplaza lo que está
  debajo**. `src/presentation/flow-vm.ts` se llevó la peor parte: +7 líneas netas en un comentario
  de `:575-594` corrieron TODAS las citas a ese archivo con línea > 594 — y hay decenas, desde
  `flow.tsx`, `confirm-and-send.ts`, `ports.ts`, `bienvenida.tsx`, `recuperar.tsx`, los `.test.tsx`
  de presentación, etc. El Architect contó las citas que apuntan a los archivos **nombrados en la
  tabla de scope**, no las que apuntan a **cualquier línea que la edición desplaza**. Son conjuntos
  muy distintos: el segundo es ~13x más grande.

- **Cómo se estableció que las 53 eran MÍAS y no deuda vieja** (el paso que evita corregir de más):
  ```bash
  git stash push -u        # el árbol vuelve a HEAD limpio
  npx vitest run src/composition/citas-ancladas.test.ts
  #   → Tests  9 passed (9)      ← VERDE en HEAD ⇒ las 53 las introduje yo
  git stash pop
  ```
  Sin ese baseline habría sido imposible saber si estaba arreglando algo mío o adoptando deuda
  ajena. **Medir la precondición, no la consecuencia.**

- **Fix**: re-anclar **derivando**, nunca a ojo ni con una resta a mano:
  1. Construir el mapa `línea_vieja → línea_nueva` por archivo desde
     `git diff -U1000000` (contexto infinito ⇒ el mapa es exacto y cubre el archivo entero).
  2. Reescribir cada cita cuyo destino resuelto sea uno de los archivos que la HU modificó.
     Una línea BORRADA mapea a `None` y **no se reescribe** — inventar un número ahí sería peor
     que dejarlo roto.
  3. Segunda pasada para el formato de auto-cita `(`símbolo`, `:NN`)`, que la primera no matchea
     porque su regex exige un nombre de archivo.
  4. **Re-correr el guardián**, que es el verificador independiente. Verde ⇒ `9 passed (9)`, el
     mismo número que el baseline.
  Total: **104 citas re-ancladas** en 21 archivos.

- **Tres errores que cometí DENTRO del arreglo, y que sólo aparecieron re-corriendo el guard:**
  1. **Doble aplicación.** 4 citas ya las había corregido a mano ANTES de correr el script; el
     script leyó mi valor nuevo como si fuera el viejo y lo volvió a mapear
     (`gateway-client.ts:225 → 239` → y otra vez → `260`). Se detectó porque el guard señaló
     `:260` apuntando a `? body.error_code`. Regla: **o a mano o con el mapa, nunca las dos.**
  2. **Auto-citas que no eran auto-citas.** La segunda pasada asume que un `:NN` suelto cita al
     PROPIO archivo (es la convención que declara `citas-ancladas.test.ts`). En
     `gateways.ts` había cinco `:NN` sueltos que en realidad citaban a
     `app/api/a2a/quote/route.ts`, y el script los remapeó contra el archivo equivocado.
     **El guard NO lo cazó** —una cita suelta es su agujero declarado #1— así que la única defensa
     fue releer el bloque. Se arreglaron reescribiéndolas en formato ANCLADO con la ruta explícita,
     que además las pone bajo el candado por primera vez.
  3. **El mapa envejece con la edición siguiente.** Después de re-anclar volví a editar
     `gateways.ts` (la prosa #4), y eso movió 3 citas más que el mapa ya no cubría. Las cazó
     re-correr el guard. Regla: **el mapa vale para el diff con el que se construyó.**

- **Hallazgo lateral, y es un hallazgo de verdad**: los 4 números del comentario de
  `gateways.ts` (`:116`, `:124`, `:125`, `:128`) **ya estaban rotos en HEAD** — apuntaban a prosa,
  y los `return` reales estaban en `:161/:169/:170/:173`. Se pudrieron solos sin que nadie editara
  nada cerca, y ningún candado los vio porque estaban en formato SUELTO. Se re-midieron con `grep`
  y se reescribieron ANCLADOS.

- **Aplicar en**: 
  1. ⛔ **Nunca creerle a un Story File cuando dice "este repo no tiene guardián X".** Cuesta 30
     segundos comprobarlo (`ls src/composition/*.test.ts`, `npm test` en HEAD) y el costo de
     creerle es descubrirlo con el gate en rojo al final.
  2. **Buscar los candados por lo que HACEN, no por cómo se llaman.** `citas-ancladas.test.ts` no
     matchea `*guard*`.
  3. **Antes de arreglar citas, medí el baseline en HEAD limpio con `git stash`.**
  4. La lista de citas de un Story File es un **piso, no un techo**: la pregunta correcta no es
     "¿qué archivos toco?" sino "¿qué líneas DESPLAZO, y quién las cita?".

---

## FIX-PACK post AR + CR (2026-08-25)

### [2026-08-25 · fix-pack] BLQ-1 (CR) — `doc/INTEGRATION.md:1043` publicaba DOS cosas falsas sobre `/orchestrate`

- **Error**: la fila nueva de la tabla de errores nombraba `/orchestrate` por su nombre y afirmaba
  (a) que un fallo de pipeline sigue saliendo `400` y (b) que `agentFailure` va en la raíz del sobre.
  Las dos son falsas para esa superficie.
- **Causa raíz**: escribí la fila razonando sobre `/compose` —donde las dos SÍ son ciertas— y
  agregué "(or `/orchestrate`)" entre paréntesis sin abrir el handler. La herencia del campo es
  real (`services/orchestrate.ts:1685` mete el `ComposeResult` entero bajo `pipeline`), y verifiqué
  ESA, que es la parte que no fallaba. **Verificar la herencia no es verificar la frase.**
- **Lo medido** (`src/routes/orchestrate.ts:245-249`, y su gemelo del handler `/execute` en
  `:877-882`):
  `status = errorCode === 'SCOPE_DENIED' ? 403 : errorCode === CONTRACTING_LOOP_DETECTED ? 400 : 200`.
  Un fallo de agente 400/422 **no setea ninguno de esos dos `errorCode`** ⇒ cae en el `: 200`. Y el
  campo llega como `pipeline.agentFailure`, nunca top-level.
- **Fix**: la fila separa las dos superficies. `/compose`: `400` + campo top-level (sin cambios).
  `/orchestrate`: `200` + `pipeline.agentFailure`, con la aclaración de que ese `200` es el contrato
  PRE-EXISTENTE de la ruta y no algo que esta HU introdujo. Cero código.
- **Aplicar en**: toda fila de `doc/INTEGRATION.md` que nombre DOS endpoints. Una fila que dice
  "A (o B)" tiene que verificarse contra **los dos handlers**, y lo que se verifica no es que el
  dato llegue: es **cada afirmación falsable de la frase**, una por una. Acá eran tres (herencia,
  status, ubicación), verifiqué una y las otras dos salieron falsas.

### [2026-08-25 · fix-pack] BLQ-2 (AR) — una cita que rompí YO, en el agujero exacto que el Story File decía que no existía

- **Error**: `chaski-v3/src/composition/container.test.ts:441` citaba
  `../application/agent-rejections.test.ts:115`. `T-335-AR-1` metió **+21 líneas** en `:71` de ese
  archivo, o sea ARRIBA de la cita: `115 → 136` (el bloque) y `119 → 140` (la cita recíproca).
- **Causa raíz — DOS, y la segunda es la que importa**:
  1. La cita estaba en formato **SUELTO**, que es el agujero declarado #1 de
     `citas-ancladas.test.ts`. Su verde (`9 passed`) no dice nada de ella.
  2. **El barrido que prescribe W2.2.7 es estructuralmente ciego a los `.test.ts`.** Su regex es
     `[a-z0-9./-]*(gateway-client|agent-rejections)\.ts:[0-9]{1,4}`, y en `agent-rejections.test.ts`
     después del nombre viene `.test.ts` ⇒ `\.ts:` **no matchea**. Corrí la receta bien y no podía
     encontrarla. La forma correcta es `(\.test)?\.tsx?:`.
- **Fix**: re-anclada a `:140` **y pasada a formato ANCLADO** —
  ``(`CABLEADO`, `../application/agent-rejections.test.ts:140`)`` — para que el candado la cubra
  por primera vez, más el registro del desplazamiento en el propio comentario.
- **Aplicar en**: cualquier receta de barrido de citas que use un regex con `\.ts:`. **Un regex de
  barrido es una afirmación de instrumento y hay que calibrarlo en las dos direcciones**: correrlo
  contra una cita que sabés rota y comprobar que la encuentra. Sin esa calibración, un barrido que
  da cero significa "no encontré" y se lee como "no hay".

### [2026-08-25 · fix-pack] MNR-2 (AR) — el guard del leg de COTIZACIÓN no tenía testigo, y ahora sí (mutante M9 medido)

- **Error**: `chaski-v3/app/api/a2a/quote/route.ts:173` gatea el 422 nuevo con
  `code === "step_failed" && agentFailure === "INPUT_REJECTED"`, y sólo el gemelo del **payout**
  tenía testigo (`T-335-P-4`). §9.4 del Story File pidió uno de los dos legs; copié la asimetría.
- **Lo medido, con el mutante M9** = borrarle `r.code === "step_failed" && ` a ese `if`:
  | Momento | Suite COMPLETA de `chaski-v3` |
  |---|---|
  | M9 **antes** del fix-pack (medición del AR) | `154 passed (154)` / `3059 passed (3059)` — **SOBREVIVE** |
  | Baseline con `T-335-Q-4` puesto, sin mutante | `PASS (29) FAIL (0)` en `quote/route.test.ts` |
  | M9 **después**, suite COMPLETA | `PASS (3059) FAIL (1)` — **KILLED**, y por UN solo test: `T-335-Q-4/CD-5`, `AssertionError: expected 422 to be 502` en `route.test.ts:424` |
- **Fix**: `T-335-Q-4/CD-5` en `app/api/a2a/quote/route.test.ts:396-427` — un 402 (`payment_required`,
  la Agent Key NUESTRA sin saldo) que ADEMÁS trae `agentFailure: "INPUT_REJECTED"` en el body ⇒ debe
  seguir dando `502 a2a_unavailable`. Sin el guard por `code`, ese 402 le diría a quien llama
  "rechazamos tu monto": el defecto que la HU vino a cerrar, invertido.
- **Arnés de mutación**: copia previa a un scratchpad propio del repo, restauración por `cp` y
  verificación de `md5sum` (`2fe6c593d8e24131d148d342fc73181b` antes y después). ⛔ Nunca
  `git checkout --`: en un árbol sin commits eso BORRA lo que se está midiendo.
- **Daño colateral del fix, cazado midiendo y no leyendo**: el `it` nuevo metió **+33 líneas** en
  `quote/route.test.ts:395`, lo que corrió el `it.each` de `:514` a `:547` — y ese número lo cita
  ``(`it.each`, `route.test.ts:514`)`` desde `quote/route.ts:131`. Re-anclado a `:547`. **Es
  exactamente el mismo modo de falla que BLQ-2, cometido mientras arreglaba BLQ-2**: antes de
  insertar líneas, preguntar *"¿quién cita algo por debajo de este punto?"*.
- **Aplicar en**: cuando un Story File pide un testigo para UNO de dos sitios simétricos, escribir
  los dos o **declarar por qué no**. Y todo testigo nuevo de un guard se acompaña de la medición
  rojo/verde del mutante que dice que estaba apagado.

### [2026-08-25 · fix-pack] MNR-3 (AR) — una cita cross-repo que NINGÚN guard de NINGUNO de los dos repos puede verificar

- **Error**: la fila `400` del docblock de `src/lib/agent-http-error.ts` citaba
  `chaski-v3/src/application/agent-rejections.ts:24-30`, que es el bloque *"DOS LISTAS, Y NO ES
  BUROCRACIA"* y no menciona ni `400` ni `fx_amount_*`. La evidencia real está en `:10-15`.
- **Causa raíz**: el número salió del Story File y lo copié sin abrir el archivo destino, que
  además vive en OTRO repo y en OTRO worktree.
- **Fix**: **no** se corrigió el número — se **transcribió la medición**:
  `POST {"amountUsd":2} -> 400 fx_amount_below_minimum` / `POST {"amountUsd":50000} -> 400
  fx_amount_above_maximum`, con el archivo destino nombrado **sin línea**, y con la razón escrita
  al lado.
- **Aplicar en**: ⛔ **Una cita `archivo:línea` que cruza de repo no la puede verificar ningún
  candado de ninguno de los dos**, y se pudre sola con el primer commit del otro lado. Cuando la
  evidencia vive en otro repo: **transcribir el par de líneas medido**, no apuntarle con un número.

### [2026-08-25 · fix-pack] MNR-1 (CR) — la justificación del exceso de diff no existía por escrito, y la que di al orquestador estaba MAL ATRIBUIDA

`story-file.md:1203` exige *"Diff dentro del techo (≤ 320 líneas / 6 archivos de código) **o exceso
justificado por escrito**"*. No la escribí en ningún artefacto: vivía sólo en mi mensaje al
orquestador, o sea que se perdía al cerrar la sesión. Y encima era inexacta. **Los números de acá
son los que MIDIÓ el CR clasificando línea por línea, no los que declaré yo.**

**Wave 1 (`wasiai-a2a`) — reparto medido contra el presupuesto del SDD (`sdd.md:719`)**

| Columna | Presupuesto SDD | Medido | Ratio |
|---|---|---|---|
| Código ejecutable (no-test) | ~60 | **25** | **0,42x — por DEBAJO** |
| Prosa / docblock (no-test) | ~95 | **165** | 1,74x |
| Archivos de test (todo) | ~145 | **330** | **2,28x** |
| **Total** | ~320 | **525** (+4 en `README*`/`INTEGRATION`/`_INDEX`) | 1,64x |

**Lo que yo había dicho y es falso**: *"el exceso es prosa que el Story File volvió normativa"* y
*"el código ejecutable son ~10 líneas"*. De las ~205 líneas de exceso, **185 (el 90 %) son archivos
de test**; la prosa aporta 70; y el código ejecutable mide **25**, o sea 2,5x lo que declaré y aun
así *por debajo* del presupuesto. La atribución estaba invertida.

**Por qué no hay nada que recortar** — cada exceso está atado a una directiva escrita:
- **Los 330 de test**: **CD-17** (`sdd.md:460-463`) obliga a los pares que discriminan (399/400,
  422/423, 429/500 ⇒ la tabla de 16 statuses de `agent-http-error.test.ts:18-41`), y la regla *"los
  dos desenlaces en el MISMO `it`"* duplica el setup de cada caso de `compose.test.ts`. Los dos son
  mandatos del F2, no elección mía.
- **Los 165 de prosa**: `sdd.md:484-487` enumera los 6 contenidos obligatorios del docblock del
  campo *incluida la tabla de §6.2*, CD-13 exige la misma tabla en el clasificador, y
  `story-file.md:560-562` pide la razón de la divergencia **en los dos módulos**.
- **Los 25 de código**: por debajo del techo. No hay nada que recortar de una columna que sobra.

**Lo que esto deja para el próximo F2, que es información y no un reproche**: el presupuesto del SDD
**subestimó la columna de tests en 2,3x**. Un SDD que manda CD-17 (pares que discriminan) y "los dos
desenlaces en el mismo `it`" está comprando ~2x de líneas de test sobre la estimación ingenua, y
conviene presupuestarlo en la misma tabla que lo pide.

**Wave 2 (`chaski-v3`)**: 563 añadidas / 146 borradas sobre 25 archivos contra un techo de ≤350 / 9.
El exceso de **archivos** ya estaba justificado por escrito arriba en este mismo documento
(`:151-227`): el Story File afirmaba dos cosas falsas y la medición dio 53 citas rotas / 104
re-ancladas en 21 archivos. De los 25, **12 son sólo-citas (20 líneas en total)**.

**Aplicar en**: la justificación de un exceso de diff **se escribe en el artefacto, con los números
medidos, en el momento en que se mide** — no en el mensaje al orquestador. Y se mide **por columna**:
"es todo prosa" es exactamente el tipo de resumen que apaga la revisión siguiente, porque nadie
vuelve a mirar los 330 de test.

### [2026-08-25 · fix-pack] Lo que NO se arregló, y por qué — para QA y para el Architect

**1. `T-335-NOLEAK` es tautológico y se deja como está.** 5 de sus 6 asserts no pueden fallar: el
sujeto es `JSON.stringify(result.agentFailure)`, que la línea anterior ya fijó al literal
`'INPUT_REJECTED'`, y un string de 15 caracteres no puede contener una URL ni un secreto. **La forma
la dictó el Story File §9.1**, así que es deuda del F2.5 y no del Dev; tocarlo acá sería reabrir el
F2.5 en un fix-pack.
- ⛔ **QA no debe citar `T-335-NOLEAK` como evidencia independiente de AC-3.** Lo que garantiza AC-3
  es el **TIPO** del campo (`AgentFailureKind` = unión cerrada de dos literales), que es un argumento
  más fuerte que cualquier `not.toContain`: no hay valor construible que filtre.
- **La sugerencia del CR (correr los `not.toContain` sobre `JSON.stringify(result)` completo) NO es
  un cambio de una línea, y está MEDIDO**: aplicada, el test se pone **ROJO** —
  `AssertionError: expected '{"success":false,"output":null,"steps…' not to contain
  'https://example.com/invoke'` en `compose.test.ts:3223`. Es correcto que lo esté: **CD-9 exige que
  `result.error` conserve byte-idéntico hasta 300 caracteres del body crudo del agente**, así que el
  sobre COMPLETO contiene por contrato lo que esos asserts prohíben. Convertirlo en un test con
  poder discriminante exige decidir qué claves del sobre entran al barrido, que es trabajo de SDD.
  (Medido con copia previa + restauración por `cp` + `md5sum` idéntico: `b6602bd42125c61249c027a463bd1ce1`.)

**2. Hallazgo que EXCEDE esta HU: no son dos familias de guards que derivan del índice de git, son
SIETE — y una es `ownership-filter-guard`.** El auto-blindaje decía *"al menos dos familias derivan
del índice"*; medido con `grep -o "ls-files"` son ocho archivos:
`readme-numbers` · `sdd-index-matches-folders` · `test-files-are-run-in-ci` ·
`scripts-imported-by-tests-are-tracked` · `docs-referenced-by-code-exist` · `ownership-filter-guard` ·
`cited-lines-guard` · `discover-callsites`.
- ⛔ **La consecuencia, que es de seguridad y no de proceso**: `ownership-filter-guard` deriva su
  universo de `git ls-files` ⇒ **un `src/services/*.ts` NUEVO y UNTRACKED con una query sin
  `.eq('owner_ref', …)` pasa el guard de ownership en silencio.** No es un defecto de esta HU (acá
  todo está staged y el gate se corrió sobre el árbol completo), pero es la generalización correcta
  de la lección *"un archivo nuevo sin `git add` da verde falso"*: no es un número de README que
  queda viejo, es un IDOR que ningún candado ve.
- **Amerita su propia HU**: que el escáner de ownership recorra el árbol de trabajo (o que el gate
  falle ante cualquier `??` bajo `src/services/`) en vez de confiar en el índice.

**3. MNR-5 (AR) — la fila 226 de `doc/sdd/_INDEX.md` nació con citas que esta HU volvió falsas.** Es
trabajo de `nexus-docs` en el cierre, no del fix-pack.

**4. MNR-6 (AR) — las 17 citas desplazadas de `wasiai-a2a`.** El AR inspeccionó 8 a mano contra
`HEAD` y **las 8 YA ESTABAN ROTAS ANTES** de esta HU (*"candados que se pudren solos"*). No es deuda
de la HU y **no se barre acá**: barrerla mezclaría en el mismo commit un arreglo de deuda ajena con
el fix-pack, y haría irrevisable a los dos.

🔴 **CORRECCIÓN (fix-pack 2 · re-AR `BLQ-BAJO-3`): la conclusión no se sostuvo, y el defecto es de
método.** Lo medido fue *"las 8 inspeccionadas ya estaban rotas"*; lo escrito fue *"las 17 ya estaban
rotas"*. Eso es una generalización desde una muestra, y la muestra no la autorizaba. El re-AR midió
las que faltaban y encontró contraejemplos: `test/cited-lines-guard.test.ts:127` y `:711` citaban
`src/services/compose.ts:688`, que en `4000a8f` era la línea que las dos describen y en este árbol ya
no lo es (vive en `:706`). Eran deuda de esta HU, y el fix-pack 2 las re-ancla.
**La regla que queda**: una muestra sostiene una afirmación sobre la muestra. Para afirmar sobre el
conjunto hay que medir el conjunto — o escribir en la frase el alcance de lo que se midió.

---

## FIX-PACK 3 (2026-08-25) — la POBLACIÓN de citas, clasificada; no otra muestra

### [2026-08-25 · fix-pack 3] Por qué existe: dos rondas generalizaron desde una muestra y las dos se equivocaron

- **AR it1 / MNR-6** inspeccionó **8** citas y escribió que las **17** desplazadas *"ya estaban rotas
  antes"*. El re-AR encontró contraejemplos.
- **AR it2 / BLQ-BAJO-3** entregó una tabla de **8**; el fix-pack 2 encontró **3 más** de la misma clase.
- ⇒ esta ronda **no** entrega otra muestra. Barre la población, la clasifica entera, y declara con
  número lo que el barrido **no** ve.

### El instrumento, y su calibración

Regex: `([A-Za-z0-9_@./-]*[A-Za-z0-9_-](?:\.test|\.spec)?\.(tsx?|jsx?|mjs|cjs|sql|json|md|example|yml|yaml|sh|py))[: ](\d{1,5})(-(\d{1,5}))?`
sobre **todo `git ls-files`** (no un subconjunto elegido a mano). El `(\.test)?` es lo que le faltaba a
la receta de W2.2.7 y es por lo que BLQ-2 sobrevivió a un barrido bien corrido.

**Filtro de candidatura** (mecánico, sin juicio): una cita entra a la población si (a) su destino
resuelve a un archivo que la HU **modificó** y que **ya existía** en la base, y (b) la línea/rango
citado **se movió** (`mapa línea_vieja→línea_nueva` derivado de `git diff -U1000000`) **o** su
contenido cambió en el lugar. Medido: el chequeo de contenido no agregó **ni un solo** candidato que
el mapa no trajera ya (0 en los dos repos) — o sea que en este diff no hay ediciones in-place que el
mapa no vea; en otro diff podría haberlas, y por eso el chequeo queda.

**Criterio de clasificación** (el que decide, y se contesta comparando CONTENIDO):

> ¿La cita era CORRECTA en `main` y es FALSA hoy?

- **SÍ ⇒ Clase 3.** La rompimos nosotros; se arregla acá (CD-12). El destino se **deriva** del mapa,
  nunca a ojo, y se abre la línea destino para confirmar que dice lo mismo que decía `main@vieja`.
- **NO, ya estaba rota en `main` ⇒ Clase 2.** ⛔ No se toca (es *"candados que se pudren solos"*, y
  barrerla mezclaría deuda ajena con el fix-pack).
- **NO, sigue siendo correcta hoy ⇒ falso positivo del filtro.** Se cuenta y se sigue.

⚠️ **El modo de falla de este barrido es que el número equivocado CONTENGA el texto buscado.** Por
eso la pregunta se contesta contra `main@N` **y** `HEAD@N`, las dos abiertas, y no contra un parecido.
Hay **dos casos medidos en esta ronda donde el parecido habría mentido en las dos direcciones**:
`compose.test.ts:106` y `compose.test.ts:17-23` estaban **rotas en `main`** y esta HU las volvió
**correctas por accidente** (insertó exactamente las líneas que faltaban); y
`prepare/route.test.ts:809 → route.ts:482-486` idem (+13 líneas la realinearon con el guard del
`payoutId`, que en `main` vivía en `:469-473`). Las tres son falsos positivos, y las tres se ven como
Clase 3 si uno mira sólo el mapa.

### `wasiai-a2a` — la población, y su suma

```
tokens `archivo:línea` en todo `git ls-files`      : 15678
  └─ resuelven a un archivo que la HU modificó
     y que ya existía en la base                   :  1774
     └─ línea citada MOVIDA o con contenido nuevo  :  1221   ← población de candidatas
        ├─ estrato CONGELADO (excluido POR REGLA)  :  1167
        └─ estrato VIVO (clasificado una por una)  :    54

candidatas barridas (estrato VIVO): 54
  ├─ Clase 3 (rotas POR esta HU)      → arregladas acá: 12
  ├─ Clase 2 (ya rotas en main)       → NO tocadas:     28
  └─ falsos positivos del filtro      →                 14
                                          suma:         54  ✅
```

**Las 12 de Clase 3, con su destino derivado y verificado abriendo la línea:**

| Citador | Cita | → hoy | Ancla confirmada en el destino |
|---|---|---|---|
| `doc/sdd/_INDEX.md:176` (fila 190) | `compose.ts:226-241` | `:244-259` | `// envoltura conserva los steps completados…` / `throw err;` |
| `doc/sdd/_INDEX.md:215` (fila 223) | `services/compose.ts:443` | `:461` | `if (isSelfDestination(agent.invokeUrl, selfIdentity.hosts)) {` |
| ↑ mismo renglón, token SUELTO | `:627` | `:645` | `const debitResult = await budgetService.debit(` |
| ↑ mismo renglón, token SUELTO | `:1785` | `:1819` | `const downstream = await signAndSettleDownstream(` |
| `doc/sdd/_INDEX.md:217` (fila 225) | `types/index.ts:1610-1627` | `:1671-1688` | `export interface AgentLinkRow {` |
| ↑ token SUELTO | `:1671-1679` | `:1732-1740` | `export interface AgentLinkClaim {` |
| ↑ | `compose.ts:216` | `:234` | `const composeRunId = randomUUID();` |
| ↑ tokens SUELTOS | `:227` `:368-369` `:370` `:372` | `:245` `:386-387` `:388` `:390` | `results` / `totalCost` / `totalLatency` / `lastOutput` / `discoverCache` |
| ↑ | `compose.ts:230` | `:248` | `if (!result.success) this.recordStrandedRunIfAny(…)` |
| `doc/sdd/_INDEX.md:218` (fila 226) | 6 tokens | **marco declarado**, ver abajo | — |
| `src/lib/discovery-fetch-limit.ts:293` | `compose.ts:125-126` | `:128-129` | `* top-50 cambió…` / `* payment.chain → … rail equivocado,` |

**La fila 226 (`_INDEX.md:218`) NO se re-ancló, y la razón es que re-anclarla la volvería FALSA.** Sus
6 citas describen el **defecto que la HU cierra**, no el código de hoy; y una de ellas —el `throw` de
`compose.ts:1757`— **no tiene destino**: la línea se borró (`mapa → None`), e inventarle un número
sería peor que dejarla rota (regla ya escrita en este documento). Lo que se hizo es **declarar el
marco**: la fila ahora dice, en su primera oración, que todos sus `archivo:línea` numeran `main` @
`4000a8f`, con la traducción medida al árbol de la rama (`:1743`→`:1774`, `:1178-1190`→`:1204-1221`,
`:1146-1159`→`:1164-1185`, `:920`→`:938`, `field-error-parser.ts:24-31`→`:31-38`) y con el `:1757`
declarado sin destino. Eso cierra **MNR-5** en su parte de citas; el resto de la fila sigue siendo
trabajo de `nexus-docs`.

**Cómo se reconocen las 28 de Clase 2** (para que nadie las vuelva a contar como nuestras): son citas
a `src/services/compose.ts` cuyo `main@N` **no** contiene el referente que la prosa nombra. Ejemplos
medidos: `compose.ts:539` ("el COSTO REAL del pipeline") es `error: ceilingBinds` en `main`;
`compose.ts:130` ("debita los steps 1..N") es prosa del over-fetch; `compose.ts:278` (`agent_id =
agent.slug`) es `if (strandedSteps.length === 0) return;`; `compose.ts:792` ("18-dec scaling") es
`return true;`; `_INDEX.md:215` `compose.ts:1424-1431` y `:1445-1448` apuntan al docblock de
`resolveAgent`. Todas se pudrieron solas antes de esta rama.

⚠️ **Dos renglones quedan MIXTOS a propósito, y decirlo es parte del entregable**: `_INDEX.md:215`
lleva una Clase 3 arreglada (`:443/:627/:1785`) al lado de dos Clase 2 que **no** se tocaron
(`:1424-1431`, `:1445-1448`). Igual en `chaski-v3` con los dos README. Arreglar la Clase 2 de al lado
habría metido deuda ajena en este commit; callarla la habría vuelto invisible.

### `chaski-v3` — la población, y su suma

```
tokens `archivo:línea` en todo `git ls-files`      :  1403
  └─ resuelven a un archivo que la HU modificó      :   449
     └─ línea citada MOVIDA o con contenido nuevo  :   115   ← población de candidatas
        (estrato CONGELADO: 0 — el `doc/` de este repo está gitignoreado)

candidatas barridas: 115
  ├─ Clase 3 (rotas POR esta HU)      → arregladas acá: 10
  ├─ Clase 2 (ya rotas en main)       → NO tocadas:      4
  └─ falsos positivos del filtro      →                101
                                          suma:        115  ✅
```

Las **10** de Clase 3 son **una sola causa**: el `import { PREPARE_REJECTED }` que la Wave 2 metió en
`app/api/payout/prepare/route.ts:37` corrió **+1** todo lo que hay debajo, y los fix-packs anteriores
actualizaron unas citas de esa familia (`:311`, `:334`, `:348`, `:216`, `:332`, `:75`) y **no** otras.
Las que faltaban:

| Citador | Cita | → hoy | Forma |
|---|---|---|---|
| `app/api/solana/escrow/remittance-ids/route.ts:48` | `prepare/route.ts:213-217` | `:214-218` | **ANCLADA** `` (`POP_SECRET`, …) `` |
| `app/api/solana/escrow/remittance-ids/route.ts:80` | `prepare/route.ts:220-256` | `:221-257` | suelta (ver abajo) |
| `src/application/ports.ts:310` | `prepare/route.ts:214` | `:214` | **ANCLADA** `` (`POP_SECRET`, …) `` |
| `src/presentation/flow-vm.test.ts:2561` | `prepare/route.ts:214` | `:214` | **ANCLADA** |
| `src/presentation/flow-vm.ts:750` | `prepare/route.ts:214` | `:214` | **ANCLADA** |
| `src/presentation/flow-vm.ts:1533` | `prepare/route.ts:215` | `:216` | **ANCLADA** `` (`POP_SECRET`, …) `` |
| `src/infrastructure/solana/deeplink/pop-por-enlace.ts:92` | `prepare/route.ts:219` | `:220` | **ANCLADA** `` (`popSignature`, …) `` |
| `src/infrastructure/solana/deeplink/pop-por-enlace.ts:116` | `prepare/route.ts:231` | `:231` | **ANCLADA** `` (`verifySolanaPopChallenge`, …) `` |
| `README.md:112` | `prepare/route.ts:391-395` | `:392-396` | suelta (`.md` fuera del candado) |
| `README.es.md:117` | `prepare/route.ts:391-395` | `:392-396` | suelta (ídem) |

**Por qué tres de esas conservan el número y cambian de forma.** `:214`, `:214`, `:231` son las citas
**blandas** del grupo: su prosa nombra un *bloque* ("el PoP ya se verificó, `:214` **en adelante**";
"quien autoriza es P2"), y el ocupante nuevo de esa línea también lo satisface, así que un revisor
puede razonablemente llamarlas falso positivo. **Anclarlas resuelve la discusión en vez de
adjudicarla**: `` (`POP_SECRET`, `…:214`) `` y `` (`verifySolanaPopChallenge`, `…:231`) `` son
verdaderas hoy **y** las pone bajo `src/composition/citas-ancladas.test.ts`, que se pondrá rojo solo la
próxima vez que se muevan. Si alguien las cuenta como falsos positivos, el reparto pasa a 7/4/104 y
**la suma no cambia**.

**Las 2 que NO se pudieron anclar, con el motivo**: `prepare/route.ts:221` es un comentario
(`// P1 — presencia + tipo → 403 opaco.`) y no tiene ningún símbolo que sirva de ancla; y los dos
README son `.md`, y el candado sólo escanea `.ts/.tsx` bajo `src|app|scripts|contracts`. Ahí se
corrigió el número y queda declarado que nada las vigila.

**Las 4 de Clase 2 de `chaski-v3`, medidas**: `docs/architecture.md:31` cita `prepare/route.ts:297`
para `vm: "solana"`, que en `main` estaba en `:512` (hoy `:525`); `prepare/route.test.ts:497` afirma
que `route.ts:63` *"es el cuerpo de `isRecord`"* y en `main` esa línea ya era un `import`; y los dos
README citan `quote/route.ts:91-96` como el sitio que *"manda una `capability`"*, que en `main` era el
`return` del 429 (el `capability` vive hoy en `:141`).

### Verificación de que lo ANCLADO entra de verdad al candado (medido, no declarado)

Las 7 citas nuevas en formato anclado se apuntaron a `:1`/`:2`, se corrió
`npx vitest run src/composition/citas-ancladas.test.ts` y el candado las listó **a las 7, por nombre**:

```
Tests  1 failed | 8 passed (9)
  src/application/ports.ts:310 → `POP_SECRET`, `…/route.ts:1`: la línea dice «// Server-side: PREPARE del payout…»
  src/infrastructure/solana/deeplink/pop-por-enlace.ts:92  → `popSignature`, …
  src/infrastructure/solana/deeplink/pop-por-enlace.ts:116 → `verifySolanaPopChallenge`, …
  src/presentation/flow-vm.test.ts:2561 → `POP_SECRET`, …
  src/presentation/flow-vm.ts:750       → `POP_SECRET`, …
  src/presentation/flow-vm.ts:1533      → `POP_SECRET`, …
  app/api/solana/escrow/remittance-ids/route.ts:48 → `POP_SECRET`, …
```

Restauración por `cp` desde un scratchpad propio del repo y `md5sum` verificado idéntico antes y
después (⛔ nunca `git checkout --`). Después: `9 passed (9)`.

### La cita HISTÓRICA de `cited-lines-guard.test.ts:81`: se DEJA como está, con la medición al lado

`test/cited-lines-guard.test.ts:81` dice *"una de las correcciones de esta misma HU (`compose.ts:130`
→ `src/services/compose.ts:571`)"*. `HEAD@571` ya no es el guard anti-doble-débito (vive en `:589`),
así que el filtro la trae como candidata. **No es una cita viva: es la TRANSCRIPCIÓN de un token que
la HU 224 produjo.** Cambiarla a `:589` volvería falsa una afirmación sobre el pasado, que es
exactamente la categoría que el **ítem 14 de ese mismo docblock ya declara** para el token histórico
`.gitignore:172` (*"9 … que por construcción ya no describe esa línea"*). Se deja, y se clasifica como
falso positivo del filtro, no como deuda.

**Y se midió el efecto sobre el conteo del ítem 14 ANTES de decidir, que es lo que el encargo pedía**:
- Tocarla o no **no mueve el conteo**: `cited-lines-guard.test.ts` no está en `CORTE_A_PATHS`, y
  `571`→`589` seguiría siendo un token P1 en el mismo archivo. Efecto medido: **cero**.
- Pero la medición encontró otra cosa: **el ítem 14 YA estaba viejo por esta HU, y nadie lo había
  visto.** Corriendo `scanSource` sobre los 4 archivos del guardián da **261**, no 260 —
  `citations` **101**, no 100— porque la Wave 1 agregó un token (el `` `:571` `` de la prosa
  *"era `:571` hasta WKH-335"*), que es un `:N` suelto ⇒ el bucket de los sueltos pasa de 101 a 102 y
  `89+102+29+41 = 261`. Corregido en el mismo commit, **línea-neutral** (1685 líneas antes y después)
  y **re-medido después de escribirlo**: sigue dando `261`, o sea que la corrección no se movió a sí
  misma — que es el paso que el propio ítem 14 dice que hizo falta dos veces.
- ⛔ **Lo que NO se tocó, y por qué**: el desglose `89 · 101 · 29 · 41`. Mi instrumento reproduce el
  TOTAL y los cuatro por-archivo exactamente, pero **no** reproduce esos cuatro buckets (me da
  `57 · 133 · 29 · 42`), así que no puedo corregirlos sin adivinar la definición de quien los escribió.
  Se movió sólo el que se puede derivar sin ambigüedad (`101 → 102`, el token nuevo es un `:N` suelto)
  y se declara acá que el resto no se re-derivó.

### El barrido de MI PROPIO daño (el fix-pack 1 rompió una cita arreglando una cita rota)

Las **27 correcciones de token** de esta ronda (en **24 líneas**) son **sustituciones de texto dentro de líneas que ya existían**: cero
líneas agregadas o borradas en los dos repos (`git diff --numstat` da `N N` en cada archivo; conteo de
líneas verificado archivo por archivo antes y después). ⇒ **cero desplazamiento**, o sea que la clase
de daño del fix-pack 1 no puede ocurrir acá.

Queda el daño por **contenido**: alguien que cite una de las 24 líneas que edité. Barrido: se buscó
en todo `git ls-files` de los dos repos cualquier cita a esos `(archivo, línea)`. Resultado — 7
citas, **todas siguen ciertas**:
- `doc/sdd/_INDEX.md:215` y `:218` los citan 5 documentos, y lo que citan es **qué fila de la tabla
  vive en esa línea** (`223` y `226`). Mis ediciones son intra-línea ⇒ las filas siguen en 215 y 218.
- `ports.ts:310` y `flow-vm.ts:750` reciben citas **ANCLADAS** (`idempotencyKey`, `prepare`,
  `payout_authority_unavailable`): edité el comentario de esas líneas, no el código, así que las
  anclas siguen ahí — y lo confirma el candado, no mi lectura: `9 passed (9)` después de las ediciones.

### ⛔ QUÉ NO CUBRE ESTE BARRIDO — para que el próximo no lea el número como lista cerrada

1. **Los tokens SUELTOS `:NNN` sin nombre de archivo.** La regex exige un nombre de archivo, así que
   son invisibles. **No es teórico: 4 Clase 3 REALES salieron de ahí** (`prepare/route.ts` `:344`/`:347`
   citados desde `flow-vm.ts:750` y `flow-vm.test.ts:2514`, los dos → `:345`/`:348`), y aparecieron
   sólo porque estaban **al lado** de una cita que el filtro sí vio. Igual los `:627`/`:1785`/`:227`/
   `:368-369`/`:370`/`:372` de `_INDEX.md`. **Un renglón con una cita rota suele tener otra al lado que
   el instrumento no ve: al arreglar una, leer el renglón entero.**
2. **Las citas en prosa sin sintaxis** ("la línea de más abajo", "el guard de arriba"). Sin forma, sin
   barrido, sin cota superior conocida.
3. **El estrato CONGELADO de `wasiai-a2a`: 1167 candidatas** en `doc/sdd/NNN-*/` y `doc/research/`.
   **Excluido POR REGLA y no clasificado** — son registros fechados de HUs pasadas (SDDs, AR/CR/QA
   reports, done-reports): re-anclarlos los volvería falsos *sobre el pasado*, ningún candado los mira,
   y su tamaño (~22× el estrato vivo) probaría que la enorme mayoría es Clase 2 de otras HUs.
   `doc/sdd/_INDEX.md` **no** entra ahí: es el catálogo VIVO y se clasificó.
4. **Las citas cuyo destino esta HU NO modificó** (13 846 + 954 tokens). No pueden ser Clase 3 por
   construcción, pero **sí** pueden ser Clase 2 y este barrido no dice absolutamente nada de ellas.
5. **Los basenames ambiguos** (`route.ts:156` desde un archivo de otro directorio): 10 en `chaski-v3`.
   El resolver los marca y se leyeron a mano — los 10 apuntan a archivos que la HU no tocó
   (`app/api/settle/solana-sponsor/route.ts`, `app/api/a2a/plan/route.ts`) ⇒ falsos positivos. Un
   resolver que "elija el primero" habría fabricado 10 hallazgos.
6. **Las citas cross-repo** (`wasiai-a2a` ↔ `chaski-v3`): la regex las ve, pero **ningún candado de
   ninguno de los dos repos puede verificarlas** y se pudren con el primer commit del otro lado.
7. **Los archivos fuera de `git ls-files`**: untracked, `.nexus/`, y todo el `doc/` de `chaski-v3`
   (gitignoreado, ~262 documentos que `grep` tampoco ve desde la raíz).
8. **El VALOR semántico de la afirmación alrededor de la cita.** Acá se verificó *qué línea es*, no
   *si la frase es verdad*.

**La frase que corresponde escribir, y que reemplaza a la que las dos rondas anteriores escribieron
de más**: *no* "todas las citas del repo están verificadas", sino **"estas 54 + 115 candidatas están
clasificadas una por una; el filtro es el regex de arriba sobre `git ls-files` cruzado con el mapa del
diff, y no ve los 8 conjuntos de la lista de acá abajo"**.

### Aplicar en

1. **Una muestra sostiene una afirmación sobre la muestra.** Para afirmar sobre el conjunto hay que
   medir el conjunto — o escribir en la frase el alcance de lo que se midió. Es la tercera vez que
   este defecto aparece en esta HU y la primera que se cierra con la población entera.
2. **Todo barrido de citas necesita DOS instrumentos, no uno**: el regex (qué citas hay) y el mapa
   `línea_vieja→línea_nueva` de `git diff -U1000000` (qué se movió). Con uno solo se generaliza.
3. **Antes de creerle a un barrido, calibralo en las DOS direcciones**: correrlo contra una cita que
   sabés rota (que la encuentre) y contra una que sabés sana (que no la traiga). Acá el calibrado en
   la segunda dirección es lo que evitó "arreglar" 3 citas que el diff había vuelto correctas solas.
4. **Un renglón con una cita rota casi siempre tiene otra al lado que el instrumento no ve.** 11 de
   las 27 correcciones de esta ronda salieron de leer el renglón entero, no del barrido.

### Gates del fix-pack 3, completos y en orden, con todo en el índice

`wasiai-a2a` (⛔ `npm run qa` NO existe acá — el gate es la secuencia de `.github/workflows/ci.yml`):

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | `TypeScript compilation completed`, exit 0 |
| 2 | `npm run lint` (`biome check src/`) | `Checked 503 files in 177ms. No fixes applied.` |
| 3 | `npm test` (`vitest run`) | `Test Files 298 passed \| 6 skipped (304)` · `Tests 5961 passed \| 19 skipped (5980)` |

`chaski-v3`:

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `npm run qa` (`lint && typecheck && typecheck:scripts && test`) | exit 0 · `Checked 278 files` · `Test Files 154 passed (154)` · `Tests 3060 passed (3060)` |
| 2 | `npm run build` (`next build --webpack`) | exit 0 (los `Critical dependency` de `ox`/`viem` son previos a esta rama) |

⚠️ El `3060` de `chaski-v3` es **+1** contra el `3059` que midió el AR it2: lo aporta `T-335-Q-4/CD-5`,
el testigo que agregó el fix-pack anterior. Ninguno de los dos gates cambió de conteo por esta ronda
—son 27 sustituciones de texto dentro de comentarios y prosa, cero código ejecutable—, y eso es
exactamente lo que se espera de un fix-pack de citas.
