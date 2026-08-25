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
