# Auto-Blindaje — HU 224 · WKH-362 · `TD-316-CITAS-SIN-TESTIGO`

> Se escribe A MEDIDA QUE PASA. En esta HU el Auto-Blindaje no es paperwork: es
> el mismo dato que la HU produce.

---

### [2026-08-19] W0 — un `*/` literal dentro de un docblock cerró el comentario a mitad

- **Error**: escribí `` (`});`, `}`, `*/`) `` como ejemplo de línea no identificable en el
  docblock de `test/cited-lines-guard.exceptions.ts:31`. El `*/` de adentro de los backticks
  **cierra el bloque de comentario**: a partir de ahí el resto de la prosa quedó como código.
  Lo que había realmente: `esbuild` cortando en `cited-lines-guard.exceptions.ts:34:8` con
  `Expected ";" but found "src"` — una línea de prosa leída como sentencia.
- **Cómo apareció**: lo cazó el **control verde de W0** (`npx tsx -e "import(...)"`, exit 1).
  NO lo cazó leer el archivo: leyéndolo se ve bien, porque el editor colorea los backticks.
  Es exactamente el caso donde "leer el resultado" no alcanza.
- **Instrumento que lo habría cazado antes**: ninguno corría todavía — es el primer archivo
  de la HU. Por eso W0 tiene su propia puerta de importación en vez de esperar a W1.
  ⚠️ Nota: `tsc --noEmit` **no** lo habría cazado, porque `tsconfig.json:19` es
  `"include": ["src/**/*"]` y no incluye `test/` (✔ medido por mí, ver CD-15).
- **Fix**: reemplacé el ejemplo por *"un cierre de bloque de comentario"* en prosa.
  El otro sitio con el mismo riesgo (`include: ["src/**\/*"]`) ya iba escapado en los tres
  archivos. Edición **no** línea-neutra (+1 línea), pero es un archivo NUEVO de esta HU
  que nadie cita todavía: CD-10 aplica a las correcciones de citas en `src/`, no acá.
- **Clase**: **NUEVO**. No es "desplacé una cita sin re-abrirla": es *"escribí un ejemplo
  dentro del mismo lenguaje que documenta"*. Riesgo permanente en esta HU, porque **todo el
  docblock habla de sintaxis de comentarios y de citas**.

---

### [2026-08-19] W1 — el docblock afirmaba que un trozo del regex cargaba un comportamiento que NO cargaba

- **Error**: escribí en `test/cited-lines-guard.scanner.ts` que el prefijo `(?:\.{1,2}\/)?`
  «es lo que hace que `./splash.tsx:245` y `../adapters/solana/chain.ts:84` entren».
  Lo que había realmente: ese prefijo es **redundante**. El punto que está dentro de la clase
  de caracteres del segmento (`[A-Za-z0-9_.@-]`) ya matchea `./` y `../` por su cuenta.
- **Cómo apareció**: lo cazó el **mutante M2** (reemplazar el prefijo por `(?:)?`), que dio
  `4 passed (4)` — o sea **SOBREVIVE**. Y sobrevivir CONTRADECÍA lo que yo esperaba, así que
  no cae en la trampa de la regla 5 de §13 (el sobreviviente sospechoso es el que confirma).
  ⚠️ Leer el archivo NO lo habría cazado: la prosa es plausible y el regex «se ve» correcto.
- **Instrumento que lo habría cazado antes**: ninguno. Es precisamente por esto que W1 va
  antes de W2: si el escáner se hubiera usado para declarar 57 entradas antes de mutarlo, el
  verde final no habría dicho nada sobre esta afirmación.
- **Fix**: (a) saqué el prefijo redundante — no perdía nada, medido con los tres casos
  `./`, `../` y `.nexus/`; (b) reescribí el comentario con lo MEDIDO, incluyendo el mutante y
  su resultado; (c) agregué el fixture `.nexus/project-context.md:6-12` a `G-C2`, que es lo
  que el punto de la clase sí carga en exclusiva; (d) el mutante correcto (**M2b**, sacarle
  el punto a la clase del segmento) **mata `G-C2`**. Archivo nuevo de la HU: CD-10 no aplica.
- **Clase**: **NUEVO para esta HU y central a ella**: *"prosa que afirma de más sobre su
  propio código"*. No es un número mal: es una afirmación causal falsa. Un guardián mecánico
  de citas `archivo:línea` **no la habría cazado tampoco** — sólo la caza un mutante.

---

### [2026-08-19] W1/W2 — 🔴 el universo NO es 45: las dos derivaciones previas compartían un punto ciego

- **Error**: no es mío, y es el hallazgo principal de la HU. El Story File §5.2 declaraba
  `P1=14 P2=12 P3=16 P4=3 => 45`, derivado dos veces (SDD + F2.5) con escáneres
  independientes que coincidían **archivo por archivo**. Mi barrido da **57**.
  - **P1=14 ✔ · P2 medido 20 · P3=16 ✔ · P4 medido 7.** Las tres formas que coinciden,
    coinciden EXACTAS y archivo por archivo. Toda la diferencia está localizada.
  - **+8**: citas a un **DOTFILE** (`.gitignore:172`, `:173`, `:177-180` ×2, `:178`, `:184`,
    `:172` ×3 en total) en `test/sdd-index-matches-folders.exceptions.ts`. Los dos escáneres
    previos exigían un nombre ANTES del punto de la extensión; `.gitignore` no lo tiene.
  - **+4**: ruido de la forma P4 (`{reputation:100}` en `src/types/index.ts:614`,
    `minLength:1` en `:1592`, y dos `:00` de un timestamp ISO en
    `src/services/agent.payment.test.ts:718`). El diseño de §5.4 manda REPORTARLOS y
    exceptuarlos a mano; las derivaciones previas los descartaban en silencio.
- **Cómo apareció**: lo cazó **comparar archivo por archivo**, no el total. El total (57 vs 45)
  sólo decía «hay diferencia»; el desglose por archivo dijo **dónde** y **de qué clase**.
- **Instrumento que lo habría cazado antes**: ninguno — y el Story File lo había anticipado
  textualmente: declaró la coincidencia entre los dos escáneres previos como
  **CONCORDANCIA y no como prueba**, con la razón exacta: *"los dos salen de la misma spec,
  pueden compartir defecto"*. **Compartían éste.** Y por eso 45 estaba declarado como PISO.
- **Fix**: el escáner ve dotfiles (`*` en vez de `+` en el nombre del último segmento);
  las 8 citas se corrigen (W3) y se declaran; los 4 ruidos van a `SCANNER_FALSE_POSITIVES`
  con motivo escrito. **NO ajusté ningún número esperado**: los pisos de `G-C1` quedan como
  el contrato los declara (`>= 40`, cada forma `>= 1`).
- **🔴 Y las 8 citas nuevas están TODAS MAL**, corridas exactamente **+13 líneas**
  (`.gitignore:172` dice ser el runbook de identidades de operador y es
  `/doc/investors/30-60-90-traction-plan.md`; el real es `:185`). Verificado con DOS
  instrumentos (`sed -n` sobre el disco y `/usr/bin/git show HEAD:.gitignore`), con
  `/usr/bin/git status --porcelain .gitignore` **vacío** ⇒ el disco ES `HEAD`.
- **Clase**: el patrón recurrente *"desplacé una cita sin re-abrirla"*, pero a escala de
  bloque: **una inserción de 13 líneas en `.gitignore` invalidó 8 citas de una vez**, y
  ningún instrumento del repo podía verlas.

---

### [2026-08-19] W3 — el punto ciego del dotfile se REPRODUJO adentro del arreglo del punto ciego del dotfile

- **Error**: para decidir si un token nombra archivo (y por lo tanto si hace falta `targetReason`),
  el guardián tenía su PROPIA regex: `/[A-Za-z0-9_@-]\.[A-Za-z0-9_-]+:\d/`. Volvió a exigir un
  nombre ANTES del punto, así que `.gitignore:185` daba «no nombra archivo» y `G-C8` pedía un
  `targetReason` que no correspondía — 5 falsos rojos.
- **Cómo apareció**: lo cazó **`G-C8` en la corrida de W3**, no una re-lectura. Y el mismo día,
  a pocas horas del hallazgo original.
- **Instrumento que lo habría cazado antes**: ninguno. La causa es estructural y tiene nombre en
  este repo: **dos criterios que responden la misma pregunta**. Es exactamente lo que
  `test/payment-guards-live-in-one-place.test.ts` existe para prevenir, y yo lo introduje mientras
  escribía un guardián.
- **Fix**: `citePathOf` / `citeNamesFile` en el escáner, UNA sola definición, consumida por
  `normalizeTarget`, `citeMatchesTarget` y `G-C8`. El porqué quedó escrito en su docblock.
- **Clase**: **NUEVO**: *"repliqué el criterio en vez de importarlo, y la réplica heredó el bug
  que estaba arreglando"*.

---

### [2026-08-19] W3 — declaré un `symbolPath` por PREFIJO y la comparación es por IGUALDAD de segmento

- **Error**: para `src/routes/agents.ownership.test.ts:211` declaré
  `symbolPath: ['T-143B-06: owner PATCH own slug with payoutWallet']`. El segmento real que
  devuelve el resolver es el nombre COMPLETO del `it(`
  (`'T-143B-06: … only payout_wallet touched (AC-2)'`). La subsecuencia ordenada compara segmentos
  por igualdad, así que un prefijo NO matchea: `locate` devolvió 0 hits.
- **Cómo apareció**: lo cazó **el guardián que estoy escribiendo**, con `E-ANCHOR_GONE` +
  `E-SYMBOL_DRIFT` y el camino real impreso en el mensaje. Es el primer caso en que el
  instrumento caza un error mío sobre el instrumento.
- **Instrumento que lo habría cazado antes**: el mismo — corrió apenas lo tuve.
- **Fix**: declarar el bloque `describe` (`'agents routes — ownership / anti-IDOR (WKH-134)'`),
  que además aporta información INDEPENDIENTE de la needle, porque la needle ya ES el nombre del
  test. El porqué quedó escrito al lado de la entrada.
- **Clase**: **NUEVO**: *"asumí que una comparación era laxa sin abrir su definición"*.

---

### [2026-08-19] W4 — 🔴 DOS citas falsas MÁS, fuera de las que el contrato enumeraba

- **Error**: no es mío; son dos hallazgos nuevos, medidos abriendo la línea.
  1. `src/services/fee-split.ts:494` decía *«NUNCA llega al `priorTx` de :335»*. `:335` es
     `if (inProgress) settlement.inProgress = true;` — no menciona `priorTx`. **`priorTx` se
     declara en `:336`.** Corregida a `:336` (4 chars → 4 chars, línea-neutra).
  2. `src/lib/payment-spec-reader.ts:7` decía *«`discovery.ts` ya importa `publishedAgentService`
     de `agent.ts` (`discovery.ts:23`)»*. `discovery.ts:23` es un `import {` que abre el import de
     `../lib/discovery-sources.js`. El import de `publishedAgentService` está en **`:63`**.
     Corregida a `:63` (2 chars → 2 chars, línea-neutra).
  En los dos casos la **conclusión de la prosa sigue siendo cierta** y lo único falso era el
  número: el modo de falla dominante, el que hace que «abrir y comparar» confirme la mentira.
- **Cómo apareció**: lo cazó **abrir la línea para escribir el `mustContain`**, que es
  literalmente lo que CD-4 obliga a hacer. Sin ese paso, las dos entraban al registro con el
  número viejo y el guardián nacía verde sobre dos citas falsas.
- **Y una que NO corregí**: `fee-split.ts:494` también cita `:316` para «el return temprano de
  `settleFeeSplits`». El `return` está en `:320`; `:316` es
  `const failed = chargeable.find(...)`, o sea la línea que DECIDE ese return. **No está
  demostrablemente mal, así que no se toca.** Corregir de más es peor que no corregir, porque
  queda con cara de verificado.
- **Clase**: el patrón recurrente *"desplacé una cita sin re-abrirla"*.

---

### [2026-08-19] W4 — tres citas CORRECTAS que mi mecanismo no puede declarar únicas

- **Error**: `src/routes/agents.publish.test.ts` cita `` `:220` ``, `` `:237` `` y `` `:252` `` de
  `src/routes/agents.ts`. Esas tres líneas (`{ field: 'priceUsdc' },` etc.) son **idénticas byte a
  byte** —indentación incluida— a las de los guards gemelos del PATCH (`:412`, `:430`, `:444`), y
  las seis caen dentro del mismo símbolo `agentsRoutes`. Ni alargar la conjunción (la línea no
  tiene nada más) ni el `symbolPath` pueden separarlas.
- **La tentación, y por qué NO la seguí**: re-apuntar las citas a la línea siguiente
  (`'agent publish rejected: invalid priceUsdc'`, que sí es única) habría dejado el guardián
  verde sin excepciones. **Pero las citas NO están mal**: `:220` ES esa línea y ES el guard del
  POST. Cambiarlas para que la herramienta quede contenta es introducir una cita falsa dentro de
  la HU que existe para sacarlas — el modo de falla de §0.2, aplicado por mí.
- **Fix**: 3 entradas en `UNICITY_EXCEPTIONS`, cada una con su motivo leído de los DOS sitios.
  **CD-14 las mantiene honestas**: siguen obligadas a que el archivo exista, la línea exista y la
  conjunción matchee ESA línea. Medido: si alguien inserta una línea antes de `:220`, los hits
  pasan a `[221, 413]`, `220 ∉ hits` y salta `E-LINE_MOVED`. La excepción pierde casi nada.
- **Clase**: **NUEVO**: *"la herramienta no puede expresar algo cierto, y la salida fácil es
  cambiar la verdad"*.

---

### [2026-08-19] W4 — el candado del README derivó del ÍNDICE y explotó en la puerta siguiente

- **Error**: `test/readme-numbers.test.ts` deriva la cantidad de archivos de test de
  `git ls-files`, y los dos README publican ese número. Mi archivo nuevo lo llevó de 295 a 296,
  así que `npx vitest run` sobre mi propio archivo daba **10/10 verde** y `npm test` daba
  **2 failed**.
- **Cómo apareció**: lo cazó la puerta 3 (`npm test`), después de que las puertas 1 y 2
  (`tsc --noEmit`, `biome check src/`) dieran exit 0. Es exactamente la secuencia que el contrato
  anticipaba: *"ya hizo pasar una puerta en verde y explotar la siguiente"*.
- **Fix**: `295` → `296` en `README.md:378` y `README.es.md:405`. Línea-neutra en los dos
  (`--numstat` 1/1, `wc -l` idéntico). Es la actualización mínima que un candado existente exige,
  no una ampliación de alcance sobre `README.md`.
- **Clase**: conocido y documentado; lo dejo escrito porque el orden de las puertas es lo que lo
  hace visible.

---

### [2026-08-19] W5 — escribí un desglose en el docblock que YA estaba viejo por mi propia edición

- **Error**: escribí `P1=14 · P2=20 · P3=16 · P4=7` en el docblock del guardián. El desglose real
  al momento de escribirlo era **`P1=15 · P2=19`**: mi propia corrección de W3
  (`compose.ts:130` → `src/services/compose.ts:571`) le agregó el directorio al token y lo movió
  de la forma P2 a la P1.
- **Cómo apareció**: lo cazó **derivar el número con un script** en vez de releer lo que había
  escrito. Releerlo no lo habría cazado: el número era el que yo había medido una hora antes.
- **Instrumento que lo habría cazado antes**: ninguno mecánico — `G-C1` verifica PISOS, no el
  desglose, a propósito (un candado pegado a la medición pone en rojo cada comentario que alguien
  borra). Queda declarado en el docblock que el desglose se DERIVA y que si no coincide, el que
  tiene razón es `FOUND`.
- **Clase**: es **el fenómeno de esta HU aplicándose a esta HU**, y en su forma más pura: un
  número correcto al escribirse que dejó de serlo por una edición del propio autor, en la misma
  sesión. Es el argumento de existencia del guardián, producido por el guardián.

---

### [2026-08-19] Arnés — dos abortos del arnés y un FALSO KILLED, los tres cazados por el arnés

1. **M8/M9 abortaron sin mutar**: mi verificador exigía `sobrantes === 0`, pero en una INSERCIÓN
   el reemplazo CONTIENE al ancla, así que el ancla sobrevive adentro. El arnés **se negó a
   seguir** en vez de reportar un resultado. Abortar de más es molesto; no abortar de menos es el
   bug. Fix: `leftoverEsperado = repl.includes(anchor) ? want : 0`.
2. **M20 dio un FALSO KILLED**: mi reemplazo metía comillas simples crudas dentro de un literal
   `'...'` → error de sintaxis → la suite **no cargaba** y vitest decía `Tests no tests`. Leído
   rápido, eso es «el mutante murió». Es la trampa de la regla 6 de §13 (`PARSE_ERROR` leído como
   KILLED espectacular). Fix: control explícito en el arnés que detecta `no tests` /
   `Transform failed` y lo marca como **FALSO KILLED**, y M20b re-hecho como una inserción limpia
   de dos entradas con motivo idéntico → mata `G-C8` y sólo a `G-C8`.
3. **Los backticks de los motivos se EJECUTABAN** al pasarlos como argumento de bash. Por eso el
   arnés de M20b/M23 está escrito en node y no en bash.

⚠️ Los tres los cazó el **arnés y el md5**, ninguno los cazó «leer el resultado».

---

## Deuda declarada al cerrar

- **`TD-316-CITAS-PROJECT-CONTEXT`** — *antes de trackear `.nexus/project-context.md` hay que
  revisar qué contiene, porque **este repo es PÚBLICO**: meterlo en git **publica su contenido**.
  La deuda no es "trackearlo": es "revisar el contenido y recién después decidir".*
- **`TD-316-CITAS-PORTABILIDAD`** — los otros dos repos (`wasiai-remittance-agents`, `chaski-v3`),
  donde el mismo defecto ya reapareció con otros dos agentes.
- **`TD-316-CITAS-DOTFILE-EN-OTROS-CORTES`** — 🔴 **NUEVA, de esta HU.** El punto ciego del dotfile
  era de la ESPECIFICACIÓN, no de un escáner: los dos barridos previos lo compartían. Todo conteo
  de anclas heredado (749 en `src`+`test`, ~20.550 en `doc/`, y por lo tanto 6,0 % y 0,21 %) fue
  producido con esa suposición y **está subestimado por una cantidad no medida**. Antes de abrir
  el Corte B, C o D hay que RE-DERIVAR el denominador con el escáner de esta HU.
- **Cortes B / C / D** — B = las 40 anclas de prosa de `ownership-filter-guard.exceptions.ts`
  (el corte de mayor valor de seguridad del repo: cada una justifica una lectura cross-tenant
  citando un gate de admin, y eso hoy no lo vigila nada); C = el resto de `src`+`test`;
  D = `doc/**`, que es un programa, no una HU.

---

# FIX-PACK post-AR — [2026-08-19]

> AR **RECHAZADO**: 1 `BLQ-ALTO` + 1 `BLQ-MED` + 2 `BLQ-BAJO` + 5 MENORes.
> Contrato del fix-pack: `doc/sdd/224-citas-archivo-linea-sin-testigo/ar-report.md`.
> Nada de esto toca `src/`: el diff son 4 archivos de `test/`.

### [2026-08-19] FIX — el candado se construyó sobre la lista equivocada (`BLQ-ALTO-1`)

- **Error**: CD-14 dice «PROHIBIDO que `exceptions.ts` exceptúe algo distinto de la unicidad».
  Lo implementé sobre `UNICITY_EXCEPTIONS` —que resiste: el AR le tiró 4 mutantes y los 4
  murieron— y dejé `SCANNER_FALSE_POSITIVES` **exceptuando TODO sin ninguna restricción de
  forma**. La clave desaparece del conjunto de huérfanas de `G-C4` Y del invariante estricto.
- **Causa raíz**: leí CD-14 como una regla sobre *una lista* en vez de como una regla sobre
  *el archivo*. Hay TRES listas en `exceptions.ts` y escribí el candado para la primera. Es la
  misma clase de error que el CLAUDE.md documenta para el guardián de ownership («la regla no
  es sólo sobre `a2a_agent_keys`»): **el criterio se cumplió para el ejemplo, no para el
  conjunto**.
- **Medido ANTES (reproducción del AR, re-corrida por mí en un worktree en `5af987e`)**: mover
  `CLAUDE.md :: src/types/database.types.ts:2567` —cita real, P1, normativa— de `CITED_LINES` a
  `SCANNER_FALSE_POSITIVES` con una excusa de 40+ caracteres ⇒ **exit 0, 10/10 passed**.
- **Fix**: `citeTargetIfTracked()` en `cited-lines-guard.scanner.ts` (función pura, misma
  resolución que `citeMatchesTarget`) + su aplicación en `G-C8` + `G-C11` como testigo.
  La regla es **«ningún token que nombre un archivo TRACKEADO POR GIT»**, no «ningún token con
  path»: la trampa del fix obvio la dejó medida el AR y la re-medí — `https://x.io:8443/y`
  produce un token **P2 con path** (`x.io`) que es ruido legítimo y **tiene que poder seguir
  declarándose** (mutante M2, verde).
- **Medido DESPUÉS**: el mismo mutante ⇒ **rojo en `G-C8`** con el path resuelto en el mensaje.
- **🚧 Acotar no es cerrar, y va escrito en el código**: un `:N` suelto (P3/P4) se puede seguir
  moviendo a esa lista, porque nada mecánico separa un `:336` de un puerto. Medido: **31 de las
  50** citas declaradas tienen archivo en el token y quedan protegidas; **19 no**.
- **Aplicar en**: cualquier archivo de excepciones con más de una lista. La pregunta correcta
  no es «¿la lista que arreglé resiste?» sino «¿cuál de las listas de este archivo es la MÁS
  débil, y qué le pasa a la que exceptúa TODO?».

### [2026-08-19] FIX — el segundo interruptor: el dueño de la delegación era prosa (`BLQ-MED-1`)

- **Error**: `G-C9` pedía dos cosas por entrada (target trackeado + motivo de 40 chars) y
  verificaba el dueño con **tres literales hardcodeados** de la única entrada que existía
  (`it('G-F1`, `it('G-F2`, `CITED_INDEX_LINES`). Ninguna entrada NUEVA se miraba.
- **Causa raíz**: escribí el control mirando el dato que tenía delante en vez de la propiedad.
  Un control que enumera los literales del caso de hoy no es un control: es una copia del caso
  de hoy. (Y `isDelegated` corre ANTES de todo, así que `OCCURRENCES` y `DECLARED` bajan a la
  par y el invariante estricto queda balanceado: el silencio es total.)
- **Medido ANTES**: entrada `{target: 'src/services/discovery.ts', ownedBy: 'NADIE. No existe
  ningún guardián que verifique estas citas.'}` + borrado de las 3 entradas de `discovery.ts`
  ⇒ **exit 0, 10/10 passed**. Radio: `downstream-payment.ts` saca 4 claves, `discovery.ts` 3.
- **Fix**: `DelegatedTarget` gana `ownerFiles` + `ownerControls`, y `delegationFindings()`
  —función pura, con el índice de git y el lector INYECTADOS— verifica por entrada: target
  trackeado · motivo · los `ownerFiles` existen y son legibles · **al menos uno es un
  `*.test.ts`** (un dueño que no corre no es un dueño) · `ownedBy` NOMBRA a alguno de ellos
  (prosa y máquina de acuerdo) · cada `ownerControl` sigue escrito · **alguno de los archivos
  del dueño NOMBRA este target**. `G-C12` la prueba con 1 caso bueno y 6 malos en memoria.
- **Medido DESPUÉS**: el mismo mutante ⇒ **rojo en `G-C9`**, con `no declara este target`.
- **⚠️ Lo que NO cierra, escrito en el docblock**: verifica que el dueño EXISTA, CORRA y NOMBRE
  al target; **no** que efectivamente lo VERIFIQUE. Es «presencia, no valor», la misma frontera
  que el guardián de ownership declara en el CLAUDE.md.

### [2026-08-19] FIX — la prosa prometía un rojo que no ocurre (`BLQ-BAJO-1`)

- **Error**: `citations.ts` afirmaba «hoy no hay dos tokens `cite` IGUALES dentro de un mismo
  citador» y «si mañana aparece un duplicado, `G-C4` se pone rojo y pide un campo `nth`».
  **Las dos mitades falsas**: hay 3 claves con duplicado HOY (`:00`×2, `.gitignore:185`×3,
  `.gitignore:190-193`×2 — las 4 ocurrencias del `57 − 53`, derivadas agrupando `FOUND`), y
  duplicar un token a propósito deja el guardián **verde** (mutante M5, re-corrido: 12/12).
- **Causa raíz**: escribí el modo de falla **por diseño esperado**, sin ejercitarlo. Y el mismo
  commit documentaba lo contrario en el ítem 13 de la no-cobertura.
- **Fix**: se corrige la PROSA (no el comportamiento): una declaración cubre todas las
  ocurrencias a propósito, el `nth` no se implementa a propósito, y el conteo de duplicados se
  marca como FOTO con la receta para derivarlo. Se elige corregir la frase y no hacer cierto el
  rojo porque el `nth` es «volver a guardar un número de posición», que es el defecto que la HU
  existe para no repetir.
- **Aplicar en**: toda frase con forma «si pasa X, el test se pone rojo». **Si no la corriste,
  no la escribas.** Es la tercera vez en esta HU que una promesa de rojo no se ejercitó.

### [2026-08-19] FIX — dos cabeceras decían «vacío»/«0» con 3 entradas debajo (`BLQ-BAJO-2`)

- **Error**: `exceptions.ts` decía «Nace VACÍO… las **45** citas se pudieron anclar con
  conjunción única» con `UNICITY_EXCEPTIONS` de 3 entradas 2 líneas más abajo (y el 45 ya
  desmentido: son 57); y «Población hoy: **0**» con `SCANNER_FALSE_POSITIVES` de 3 entradas
  1 línea más abajo. Un tercer sitio con el mismo defecto: `UNANCHORABLE_PROSE` repetía «45».
- **Causa raíz**: escribí las cabeceras cuando las listas estaban vacías y no las releí después
  de llenarlas. **Es exactamente el fenómeno que la HU vigila, dentro de la HU, por tercera y
  cuarta vez** (W5 ya lo había registrado para el desglose por forma).
- **Fix**: las tres cabeceras dicen ahora la fuente que no envejece (`LISTA.length`), y el
  número va con fecha y la palabra FOTO.
- **Aplicar en**: ninguna cabecera de un archivo-registro escribe su propia población sin
  fecha. La regla operativa que faltaba: **releer la cabecera cada vez que se toca el cuerpo**.

### [2026-08-19] 🪞 HALLAZGO PROPIO, más grave que el `MNR-3` que lo destapó

- **Qué encontré**: yendo a des-clavar los dos porcentajes de `G-C10` (`MNR-3`), medí el
  candado antes de tocarlo — y **`expect(self.includes('<literal>')).toBe(true)` NO PUEDE
  PONERSE ROJO NUNCA**, porque `self` es el archivo entero y el literal buscado está escrito
  en la misma línea que lo busca. **Medido** (mutante M10, en el worktree de `5af987e`):
  reemplacé el literal por `ZZ-LITERAL-QUE-NO-EXISTE-EN-NINGUN-LADO` ⇒ **10/10 verde**.
  O sea: los tres controles del docblock de `G-C10` estaban **vacuos**, no sólo pudriéndose.
- **Causa raíz**: un guardián que se compara CONTRA SÍ MISMO. El AC-10 pedía «que el docblock
  declare», y lo verifiqué sobre el texto que incluye el verificador.
- **Fix**: `G-C10` recorta la CABECERA (`self.slice(0, indexOf('\nimport {'))`) y evalúa los
  `includes` contra la prosa, no contra el assert. Y los dos porcentajes se verifican por
  FORMA (`/\d+,\d+ %/` ≥ 2 dentro del bloque de cobertura + la advertencia «LOS DOS PISOS»),
  no por dígitos: `TD-316-CITAS-DOTFILE-EN-OTROS-CORTES` se compromete a re-derivar el
  denominador, y clavar los dígitos era un candado que se pudría solo.
- **Medido DESPUÉS**: borrar del docblock la declaración de la frase prohibida ⇒ **rojo**
  (antes: verde). Re-derivar los dos porcentajes en el docblock ⇒ **verde** (no rompe nada).
- **Aplicar en**: todo control que lea su propio archivo. `readTracked(self)` + `includes` es
  un patrón que se auto-satisface salvo que se recorte la región. Buscar el resto de este
  patrón en el repo es deuda: **`TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS`**.

---

## Los 5 MENORes: qué entró, qué no, y por qué

| # | Decisión | Razón medida |
|---|---|---|
| `MNR-1` sexta forma ciega (`Dockerfile:12`) | **ENTRA, declarado (ítem `(h)` del escáner), NO arreglado** | Degrada **ruidoso**: lo verifiqué yo, no lo heredé — agregar `Dockerfile:12` a un archivo del Corte A pone **`G-C4` en rojo** (mutante M4). Población hoy en el Corte A: **0**, medida por mí barriendo los 14 paths con `Dockerfile\|Makefile\|Procfile\|LICENSE\|CHANGELOG\|Justfile` seguidos de `:N`. Arreglar el regex tiene contraindicación: aceptar segmentos sin punto convierte cualquier `foo:12` de la prosa en cita con archivo, o sea cambia un fallo ruidoso por ruido de fondo. |
| `MNR-2` criterio inconsistente en `fee-split.ts:316` | **ENTRA**: la vara queda escrita donde vive la escalera (`exceptions.ts`) | Verifiqué las tres líneas contra el disco con `git status --porcelain src/` vacío: `:316` = `const failed = chargeable.find(…'failed')`, `:320` = `return settlement;`, `:335` **no** menciona `priorTx`, `:336` sí. La vara: **la línea citada tiene que contener el SUJETO de la afirmación, o la línea que lo DECIDE**; y el desempate es **no tocar**, porque corregir de más deja una cita con cara de verificada. |
| `MNR-3` `G-C10` clava dos números no confiables | **ENTRA, y creció**: destapó el hallazgo 🪞 de arriba | Ver la entrada anterior: el candado no sólo se pudría, **no podía ponerse rojo**. |
| `MNR-4` 187 tokens sin testigo en los 4 archivos nuevos | **NO entran al Corte A; se DECLARA como ítem 14 de la no-cobertura, con el desglose derivado** | Medido con `scanSource` sobre los propios archivos, ya con el fix-pack adentro: **243** tokens (`test` 61 · `citations` 100 · `exceptions` 45 · `scanner` 37). Desglose: **87** son literalmente el campo `cite` de una entrada declarada (**ya tienen testigo, y mejor**: `G-C5` verifica esa misma cita y `G-C7` se pone rojo si el token desaparece); **97** son `:N` sueltos; **23** nombran archivos que NO EXISTEN NI PUEDEN (los fixtures en memoria de `G-C2`/`G-C3`); **36** nombran un archivo trackeado, y de ésos **9** son el token HISTÓRICO `.gitignore:172` — el bug que esta HU arregló, citado como ejemplo. **Incluirlos convertiría cada mención del bug en una cita rota y llenaría el archivo de excusas de ruido para poder verificar otra cosa.** El costo real no es escribir 243 entradas: es que el corte no distingue un token que AFIRMA de uno que es DATO. Eso es `TD-224-CITAS-DEL-PROPIO-GUARDIAN`. |
| `MNR-5` README fuera de Scope IN | **ENTRA como corrección de CONTRATO** (ver abajo). Esta vez **no hizo falta tocarlos**: el fix-pack no agrega archivos de test, `npm test` sigue contando **296**. | El AR dictaminó que el defecto es del contrato. |

### Corrección del contrato (`MNR-5`), para la próxima HU

`story-file.md:1116` pone `README.md` en ⛔ Out of Scope, y la Done Definition #5 exige
`npm test` exit 0. **Están en conflicto directo**: `test/readme-numbers.test.ts` deriva del
índice de git la cantidad de archivos de test y **los dos README la publican**, así que
cualquier HU que agregue un archivo de test tiene que tocarlos o entregar rojo.

> **Regla para F2.5**: toda HU que agregue o borre un archivo bajo `test/` declara en su Scope
> IN la excepción `README.md` + `README.es.md` **acotada al dígito que deriva
> `readme-numbers.test.ts`**. No declararla no evita el cambio: lo empuja a la puerta 3, donde
> aparece como Scope Drift en el AR.

---

## Tabla de mutantes del fix-pack — ANTES (worktree en `5af987e`) / DESPUÉS

Método: worktree detached en el commit auditado (`git worktree add … 5af987e`) con
`node_modules` enlazado; arnés con copia propia + md5 pre-registrado (**nunca
`git checkout --`**), aborto si el ancla no aparece exactamente N veces, restauración en
`finally` verificada por md5, JSON reporter con la **raíz validada adentro del JSON**
(`testResults[*].name` empieza con la raíz esperada) y **filtrado explícito del warning
cosmético `Failed to load source map`** para no repetir el falso `PARSE_ERROR` del AR.

| # | Mutante | ANTES (`5af987e`) | DESPUÉS | Quién lo mata |
|---|---|---|---|---|
| M1 | Cita real P1 normativa (`CLAUDE.md :: src/types/database.types.ts:2567`) movida a `SCANNER_FALSE_POSITIVES` con excusa de 40+ chars | **PASA — 10/10, exit 0** | **MUERE — 11/12, exit 1** | `G-C8` |
| M2 | ✅ **CALIBRACIÓN**: `https://x.io:8443/y` en un archivo del Corte A + su entrada en `SCANNER_FALSE_POSITIVES` | PASA (12/12) | **PASA (12/12)** — el ruido legítimo sigue declarable | — |
| M3 | `DELEGATED_TARGETS` con `ownedBy: 'NADIE…'` + borrado de las 3 entradas de `discovery.ts` | **PASA — 10/10, exit 0** | **MUERE — 11/12** (`no declara este target`) | `G-C9` |
| M4 | `Dockerfile:12` en un archivo del Corte A (la sexta forma ciega) | n/a | **MUERE — 11/12** (degrada RUIDOSO, no silencioso) | `G-C4` |
| M5 | Duplicar el token `:336` dentro del mismo citador | PASA | **PASA** — y ahora la prosa lo dice | — (ítem 13) |
| M6 | Re-derivar los DOS porcentajes en el docblock (cumplir la deuda) | PASA¹ | **PASA** — sin dígitos clavados | — |
| M9 | Borrar del docblock la declaración de la frase prohibida (AC-10) | **PASA — 10/10** | **MUERE — 11/12** | `G-C10` |
| M10 | 🪞 MECANISMO: literal del assert → `ZZ-LITERAL-QUE-NO-EXISTE-EN-NINGUN-LADO` | **PASA — 10/10** (auto-satisfacción probada) | **MUERE — 11/12** | `G-C10` |
| M7 | ARREGLO TRUCHO del candado 1: `citeTargetIfTracked` devuelve siempre `null` | n/a | **MUERE — 11/12** | `G-C11` |
| M8 | ARREGLO TRUCHO del candado 2: `delegationFindings` devuelve siempre `[]` | n/a | **MUERE — 11/12** | `G-C12` |

¹ **M6 ANTES pasa por la razón equivocada, y ése es el hallazgo 🪞**: el `expect(self.includes('6,0 %'))`
se satisfacía con su propia línea. El primer intento de este mutante (una sola ocurrencia)
dio un **falso PASA** por otro motivo —el párrafo de la foto repetía los dos números—, así que
el mutante se re-hizo dos veces hasta aislar el mecanismo. Está escrito porque un mutante que
sobrevive por la razón equivocada es indistinguible de un candado sano.

**Las tres puertas, sobre el árbol final**: `npm test` ⇒ **296 archivos · 5781 tests · 5762
passed · 19 pending · 0 failed · exit 0**, con **0 archivos fuera de la raíz** validado adentro
del JSON (el conteo de archivos de test **no cambió**: sigue en 296, por eso los README no se
tocaron). `tsc --noEmit` ⇒ **0**. `biome check src/` ⇒ **0** (489 archivos). Y como
`tsconfig.json:19` es `include: ["src/**/*"]`, los 4 archivos del guardián **no** los mira ese
`tsc`: los typechequeé aparte con un `tsconfig` de scratch en `strict` +
`noUncheckedIndexedAccess` ⇒ **0 errores**.

## Lo que NO pude medir — con estas palabras

- **No medí la VERDAD de la prosa que rodea a las citas**, ni las del Corte A ni las de los 4
  archivos del guardián. Verifiqué las 4 líneas que este fix-pack cita por primera vez
  (`fee-split.ts:316/:320/:335/:336`) abriendo el archivo; el resto sigue siendo el ítem 3 de
  la no-cobertura.
- **No re-derivé el denominador** (749 anclas en `src`+`test`, ~20.550 en `doc/`). Sigue siendo
  `TD-316-CITAS-DOTFILE-EN-OTROS-CORTES`. Lo que hice fue sacarle a `G-C10` la dependencia de
  ese número, no medirlo.
- **No corrí la suite completa bajo cada mutante**: cada mutante corrió sólo
  `test/cited-lines-guard.test.ts`. La suite completa (296 archivos) la corrí sobre el árbol
  final, limpio.
- **No busqué en el resto del repo el patrón auto-satisfactorio** que encontré en `G-C10`
  (`readTracked(self)` + `includes` sin recorte). Queda como
  `TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS`, y **hasta que alguien lo busque, no sé si hay
  más**.
- **No probé el guardián en un clone fresco**, ni ejecuté nada contra producción: cero llamadas
  de red, cero Railway, cero Supabase.
- **No amplié el universo del corte**: el silencio sobre los 4 archivos del guardián es real y
  está declarado, no cerrado.

## Deuda NUEVA del fix-pack

- **`TD-224-CITAS-DEL-PROPIO-GUARDIAN`** — los 243 tokens de los 4 archivos del guardián no
  tienen testigo mecánico. El arreglo NO es agregar los paths a `CORTE_A_PATHS` (mediría 23
  fixtures inexistentes y 9 menciones históricas de un bug ya arreglado): es un corte que
  distinga un token que AFIRMA de uno que es DATO.
- **`TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS`** — buscar en el repo el resto de los controles
  que leen su propio archivo y comparan contra un literal escrito en la línea que compara.
  Medido: en `G-C10` había tres, y ninguno podía ponerse rojo.

---

# FIX-PACK it-2 — los 4 MENORes del re-AR (2026-08-19)

> Contrato: `doc/sdd/224-citas-archivo-linea-sin-testigo/ar-report-it2.md` (**APROBADO con MENORes**).
> Entran `MNR-it2-3/4/5/6`. `MNR-it2-1/2` **NO entran** (fuera de Scope IN) y se cierran como deuda,
> más abajo, con inventario en vez de con una pregunta abierta.

### [2026-08-19] 🪞 EL TERCER ARREGLO TRUCHO — mi testigo cubría la REGLA, no su APLICACIÓN (`MNR-it2-3`)

- **Error**: escribí `G-C11` y `G-C12` como «los testigos de los dos candados», y el encabezado que
  los presenta dice, textual, *«un candado sin testigo es una línea de código que nadie midió»*.
  Los dos usan **fixtures en memoria**. Nada verificaba que `G-C8` **llamara** a
  `citeTargetIfTracked` sobre el registro real. **Es el estándar del propio archivo, incumplido por
  el archivo, dentro de la HU que existe para cazar eso.**
- **Cómo apareció**: **NO** lo cazó ningún test — lo cazó el re-AR **ejecutando dos arreglos truchos
  independientes**, los dos con la suite en **12/12 VERDE**. No lo habría encontrado leyendo: mis
  12 controles estaban verdes en las dos direcciones que yo había definido.
- **Instrumento que lo habría cazado antes**: no existía. La pregunta que faltaba no es «¿el testigo
  mata al mutante?» sino **«¿qué mutante mata al testigo sin mover el testigo?»**. Un testigo puro
  sobre fixtures no puede contestarla por construcción.
- **Fix**: un **testigo NEGATIVO adentro de `G-C8`**, sobre el registro real. El barrido de
  `SCANNER_FALSE_POSITIVES` pasó a ser una función local, y se la llama **dos veces**: una con la
  lista real, y otra con la lista real **más canarios** — citas REALES de `CITED_LINES` que nombran
  un archivo trackeado, appendeadas a la misma lista. Se asserta el **DELTA**, no un número escrito
  a mano. Cuatro propiedades deliberadas, cada una matando una familia de mutante:
  1. los canarios son citas reales y **18 basenames distintos** ⇒ mata al que resuelve sólo unos pocos;
  2. cada canario se emite **una vez por cada `reason` que la lista tenga EN RUNTIME** ⇒ mata al
     filtro por `reason`, incluida la `reason` de la entrada que el atacante agrega;
  3. canarios y entradas reales se barren **en la misma llamada** ⇒ mata al `continue` por índice,
     al `break` y al `slice`;
  4. se compara el delta contra la corrida sin canarios ⇒ **no se pudre** cuando la lista cambie.
  Más un control de **vacuidad** (`>= 10` citas que nombran archivo), porque sin canarios la resta
  daría `0 === 0` y el testigo aplaudiría cualquier implementación.
- **Clase**: patrón NUEVO, y merece nombre propio — **«el testigo prueba la regla, no su uso»**.
  Es primo del que ya está registrado («guards que se comparan consigo mismos»), pero no el mismo:
  acá el testigo es correcto y el que se apaga es el **llamador**.

### [2026-08-19] FIX — la segunda salida de emergencia, no declarada (`MNR-it2-4`)

- **Error**: el párrafo 🚧 «ACOTAR NO ES CERRAR» declaraba **una** salida (un token sin archivo).
  Hay **dos**: un token que **sí** nombra un archivo pero que **existe en disco y NO está en el
  índice de git** también devuelve `null` y también se puede declarar ruido. Repro del re-AR: una
  cita a `.nexus/project-context.md:6` en un archivo del Corte A + su entrada en la lista de ruido
  ⇒ **12/12 VERDE**.
- **Cómo apareció**: el re-AR, ejecutando. Yo tenía el dato al lado —el docblock de
  `citeTargetIfTracked` dice «EXISTE en el índice de git»— y **no derivé la consecuencia**.
- **La asimetría es lo que lo hace defecto y no elección**: la MISMA cita **en `CITED_LINES`** pone
  el guardián ROJO (`E-TARGET_MISSING`); declarada ruido, pasa en verde.
- **Fix**: se **escribe la segunda salida** en los dos lugares donde se lee (`exceptions.ts` y el
  comentario de `G-C8`), con la repro, con la asimetría, y con **por qué NO se cierra leyendo el
  disco**: el índice es lo que un `checkout` trae, y un guardián que dependa de qué archivos sueltos
  tenga cada quien da distinto en CI que en local. **Población hoy dentro del Corte A: 0** ⇒ era una
  frase que faltaba, no un agujero abierto.
- **Clase**: recurrente — *«acotar un agujero NO es cerrarlo»*, ahora con la variante *«y contar
  UNA salida cuando hay DOS es la misma clase de afirmación de más»*.

### [2026-08-19] 🔁 REINCIDENCIA — el número que YO introduje no cumplía MI regla (`MNR-it2-5`)

- **Error**: cerré `BLQ-BAJO-2` con la regla *«todo número va con fecha y la palabra FOTO»*, la
  apliqué bien en dos cabeceras… y el número que **ese mismo fix-pack introdujo** (*«Del registro de
  hoy, 31 de las 50…»*) salió **sin fecha, sin FOTO, sin derivación y sin nada que lo ponga rojo**.
  Hoy es exacto (derivado otra vez acá: **31 de 50**), así que todavía no miente.
- **Causa raíz**: apliqué la regla a lo que estaba **corrigiendo** y no a lo que estaba
  **escribiendo**. Es la asimetría que hace que una regla nueva no se aplique a sí misma.
- **Fix**: fecha + FOTO + la receta (`citeNamesFile` sobre `CITED_LINES`) en los dos sitios.
- **Aplicar en**: **el barrido del auto-blindaje se hace sobre el diff PROPIO, no sobre el archivo
  ajeno**. Cada vez que se escriba una regla del tipo «todo X lleva Y», el paso siguiente es
  `grep` del diff de esa misma sesión buscando X sin Y.

### [2026-08-19] FIX — la delegación: candado de PRESENCIA donde hacía falta uno MECÁNICO (`MNR-it2-6`)

- **Error**: `delegationFindings` verificaba *«el control sigue escrito»* y *«nombra el target»* con
  un `includes()` sobre el fuente **CRUDO** ⇒ **un comentario alcanzaba**. El re-AR lo demostró
  **sin inventar nada**: repurposó `src/lib/money-invariants.fuzz.test.ts` —que existe, corre, sus
  controles siguen escritos y nombra el target en un comentario (`:14`)— y sacó **4 citas del módulo
  de liquidación del money-path** del universo con **12/12 VERDE**.
- **El dato asimétrico que lo hace prioritario**: `SCANNER_FALSE_POSITIVES` recibió un candado
  **mecánico** y `DELEGATED_TARGETS` uno de **presencia** — y la delegación es **la más barata**,
  porque **una entrada saca N claves de una vez** (4 contra 1).
- **Decisión, entre las dos que el re-AR declaró válidas**: se **exige la coincidencia en CÓDIGO**,
  no en prosa. La alternativa (escribir que el comentario cuenta) se descartó porque el defecto que
  este guardián persigue es exactamente *«la prosa dice una cosa y la máquina otra»*, y aceptar la
  prosa acá sería escribir la excepción adentro del control que la prohíbe.
- **Instrumento**: `stripComments` en `scanner.ts`, función **pura sobre un string** — mismo criterio
  que `codeOnly` de `test/payment-guards-live-in-one-place.test.ts`, que es **Corte A y Out of Scope
  (CD-7)**: no se tocó ni se importó de ahí. La duplicación es deliberada y está escrita en el
  docblock, con quién manda si divergen.
- **Efecto colateral MEDIDO, no supuesto**: el fixture `duenoQueNoCorre` de `G-C12` pasó de 1
  hallazgo a 2, porque su `ownerFiles` nombra el target **sólo en un comentario**. Se actualizó la
  aserción y se escribió por qué — es la medición del cambio, no un ajuste para que pase.
- **Lo que esto NO cierra, con esas palabras**: un dueño puede seguir nombrando el target en una
  línea de **código** que no lo vigile. El costo subió de «escribir un comentario» a «escribir código
  muerto que se ve en el diff»; **no bajó a cero**.

## `TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS` — **CERRADA con inventario**

La cerré con *«hasta que alguien lo busque, no sé si hay más»*. **El re-AR lo buscó.** El inventario,
que es lo que la deuda pedía:

| Universo | Enumerado | Se leen a sí mismos | Veredicto |
|---|---|---|---|
| `test/**` con `readFileSync` | **16** (re-verificado acá: `git ls-files 'test/*'` + `grep -q readFileSync` ⇒ 16) | 3 | 1 **ARREGLADO** (`G-C10`), 1 **OK medido** (`scripts-imported-by-tests-are-tracked.test.ts`: su regex exige `../`), 1 🔴 **DEFECTUOSO** |
| `src/**/*.test.ts` con `readFileSync` | **31** (re-verificado acá ⇒ 31) | 5 candidatos | **los 5 clear** |

**El archivo defectuoso, con nombre**: `test/docs-referenced-by-code-exist.test.ts`. Su corpus es
`git ls-files` filtrado a no-`doc/` + extensión de código, y **el archivo es `.ts`, no vive en `doc/`
y está trackeado ⇒ se incluye a sí mismo**. El literal `'CLAUDE.md'` que declara es parte del corpus
contra el que se compara. Repro del re-AR: cambiar el literal por un documento inexistente deja el
control auditado **VERDE** (el rojo lo tira **otra** afirmación del mismo archivo). Mismo mecanismo y
mismo resultado que el `G-C10` de esta HU. **Está en `main`, sin declarar, y es FUERA del Scope IN de
esta HU: no se arregla acá.** Queda como deuda con dueño identificado, no como pregunta abierta.

🎯 **Y el arte previo que el próximo tiene que conocer — son DOS formas de arreglo, no una**:
1. **Recortar la cabecera** antes de comparar. Es lo que hizo `G-C10`
   (`self.slice(0, indexOf('\nimport {'))`).
2. **Excluirse del corpus por nombre**. Ya existe en el repo, y es anterior a esta HU:
   `src/__tests__/discover-callsites.test.ts` declara `const SELF = …` en `:126` y lo aplica con
   `.filter((f) => f !== SELF)` en `:272`. **Verificado acá abriendo el archivo**, no citado del AR.

Cuál conviene depende de si el archivo es **su propio corpus** (forma 1) o **un elemento de un corpus
más grande** (forma 2). El defectuoso de arriba es el caso 2.

## La tabla de mutación de este fix-pack — ANTES (`cc714a1`) / DESPUÉS

Arnés: worktree detached en `cc714a1` con `node_modules` enlazado; copia propia + md5 pre-registrado
de los **5** archivos tocables (los 4 del guardián + `src/types/index.ts`), aborto si el ancla no
aparece exactamente N veces, restauración en `finally` **verificada por md5**, **cero
`git checkout --`**; reporter JSON con la raíz validada **adentro del JSON** (`testResults[*].name`),
**nunca el exit code**; warning `Failed to load source map` filtrado. Worktree **eliminado**.

| # | Mutante | ANTES (`cc714a1`) | DESPUÉS | Mata |
|---|---|---|---|---|
| **CAL-0** | registro real limpio, sin mutar | 12/12 ✅ | **12/12 ✅** | — (calibración) |
| **CAL-1** | `https://x.io:8443/y` escrita en un archivo del Corte A + `x.io:8443` declarado ruido | 12/12 ✅ | **12/12 ✅** | — (el ruido legítimo **sigue declarable**) |
| **T-A** | **TRUCHO A**: filtro por `reason` adentro del barrido + `CLAUDE.md :: src/types/database.types.ts:2567` movida a la lista de ruido con excusa de 300+ chars | **12/12 VERDE** 🔴 (replicado) | **11/12 — MUERE** | `G-C8` |
| **T-B** | **TRUCHO B**: `citeTargetIfTracked` resuelve **sólo** los basenames de los fixtures de `G-C11` + `downstream-payment.ts:772` a la lista de ruido | **12/12 VERDE** 🔴 (replicado) | **11/12 — MUERE** | `G-C8` |
| **M-DEL** | delegación repurposada: `src/lib/downstream-payment.ts` delegado a `src/lib/money-invariants.fuzz.test.ts` (que lo nombra en un comentario) + borradas sus **4** declaraciones | **12/12 VERDE** 🔴 (replicado) | **11/12 — MUERE** | `G-C9` |

Los **3 exploits del re-AR se replicaron en verde ANTES** y **mueren DESPUÉS**. Las **2
calibraciones siguen pasando**: el arreglo no cambió un rojo por otro.

## Re-derivación del ítem 14 (los tokens del propio guardián)

Este fix-pack escribe prosa **en** los archivos del guardián, así que su propio número se movió:
**243 → 247** (`test` 64 · `citations` 100 · `exceptions` 46 · `scanner` 37), desglose
**88 + 97 + 26 + 36**. Se re-derivó con `scanSource` sobre los 4 paths y se actualizó el docblock.
🎯 Dato que vale más que el número: de los **26** que nombran un archivo fuera del índice, **5** son
`.nexus/project-context.md` — o sea que **el ejemplo de la segunda salida de emergencia lo escribí en
el mismo commit que la declara**. El conteo de tokens que nombran archivo **trackeado** quedó en
**36, igual que antes**: este fix-pack no agregó ninguna afirmación nueva sin testigo.
**El 243 de la sección anterior quedó viejo en un día. Eso ES el ítem 14**, no una anécdota.

## Lo que NO pude medir — con esas palabras

- **No arreglé `test/docs-referenced-by-code-exist.test.ts`.** Está en `main` y **fuera del Scope
  IN**. Lo que hice fue inventariarlo y nombrarlo; **sigue vacuo**.
- **No barrí `doc/`, `scripts/`, `mcp-servers/` ni `packages/`** buscando el patrón
  auto-satisfactorio: el inventario cubre `test/**` (16) y `src/**/*.test.ts` (31). **Fuera de eso no
  sé si hay más.**
- **No cerré la segunda salida de emergencia** (`MNR-it2-4`): la **declaré**. Hoy su población dentro
  del Corte A es 0, y nada la mantiene en 0.
- **El testigo negativo de `G-C8` NO mata a un mutante que discrimine por el CONTENIDO del token**
  (ignorar exactamente el token que se quiere apagar). Lo que dejó de ser posible es apagar el
  candado entero o por un campo de la entrada.
- **`stripComments` no cierra el dueño que nombra el target en código muerto.** Subió el costo, no lo
  eliminó.
- **No corrí la suite completa bajo cada mutante**: cada uno corrió sólo
  `test/cited-lines-guard.test.ts`. La suite completa se corrió sobre el árbol final, limpio.
- **No medí la VERDAD de la prosa** que rodea a las citas nuevas de este fix-pack, más allá de que
  ninguna nombra un archivo trackeado que no estuviera ya declarado.
- **`tsc` no cubre ni un archivo de esta HU** (`tsconfig.json` incluye sólo `src/**/*`). Se los
  typechequeó aparte. Es un dato del re-AR **re-verificado acá**, no heredado.
- **No ejecuté nada contra producción**: cero red, cero Railway, cero Supabase, cero `pkill`, cero
  push, `main` intacto.
