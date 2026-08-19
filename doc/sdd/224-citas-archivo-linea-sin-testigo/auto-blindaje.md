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
