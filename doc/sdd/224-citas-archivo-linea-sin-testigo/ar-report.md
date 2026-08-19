# AR — Adversarial Review · HU 224 · WKH-362 · el guardián de las citas `archivo:línea`

| | |
|---|---|
| **Rama auditada** | `feat/224-citas-archivo-linea-sin-testigo` |
| **Commit** | `5af987ee20e635fc0f826fc322b5c4e9a14333d0` |
| **Base** | `main` = `b31ddba6206de28f063eb867d78d7f53e4de450e` (intacto, verificado con `/usr/bin/git rev-parse`) |
| **Fecha** | 2026-08-19 |
| **Rol** | nexus-adversary (AR) — **no modifiqué código**; toda mutación se hizo con arnés y restauración verificada por md5 |

## VEREDICTO: 🔴 **RECHAZADO — 4 BLOQUEANTES activos**

El guardián **funciona**: reproduje los 57 tokens, el desglose `P1=15 P2=19 P3=16 P4=7`, el invariante
`53 = 50 + 3`, y **maté 12 mutantes** contra los 6 códigos de error del algoritmo. Las 8 citas al dotfile
están **bien corregidas** y las verifiqué una por una contra `.gitignore` con `git status --porcelain`
vacío. Las dos abstenciones: una es **correcta y disciplinada**, la otra tiene una inconsistencia menor.

Lo que lo rechaza es esto: **CD-14 se cumplió para la lista equivocada.** El candado se construyó sobre
`UNICITY_EXCEPTIONS` —que es la lista *más débil* de las tres— y las **otras dos listas SÍ son el
interruptor de apagado**. Lo medí: moví una cita real y verificable a `SCANNER_FALSE_POSITIVES` y el
guardián dio **10/10 verde**; escribí una entrada de `DELEGATED_TARGETS` con un `ownedBy` completamente
falso y sacó 3 citas del universo con **10/10 verde**. Ninguno de los 10 controles lo notó.

Y los otros dos bloqueantes son el fenómeno de la HU aplicándose a la HU **una vez más**: hay tres
docblocks del propio entregable que afirman «vacío» / «0» / «no hay duplicados» con el arreglo que los
desmiente escrito 2 líneas más abajo. Uno de ellos declara además un **modo de falla que no existe**
(«si mañana aparece un duplicado, `G-C4` se pone rojo») — medido: hay 3 duplicados **hoy** y G-C4 está
verde.

---

# 1. Hallazgos, ordenados por prioridad de fix-pack

## 🔴 `BLQ-ALTO-1` — `SCANNER_FALSE_POSITIVES` ES el interruptor de apagado que CD-14 prohíbe

- **Categoría**: Data Integrity (integridad del guardián) · violación directa de **CD-14**
- **Archivo:línea**:
  - `test/cited-lines-guard.exceptions.ts:136-167` (la lista, sin ninguna restricción de forma)
  - `test/cited-lines-guard.test.ts:256-258` (`FALSE_POSITIVE_KEYS`)
  - `test/cited-lines-guard.test.ts:724-726` (el filtro que las saca del universo en `G-C4`)
  - `test/cited-lines-guard.test.ts:840-912` (`G-C8` valida el motivo, **no la forma del token**)
- **Qué está mal**: CD-14 (`sdd.md:439-441`) dice, textual: *«PROHIBIDO que `exceptions.ts` exceptúe algo
  distinto de la **unicidad** (AC-3) o del **anclaje** de una cita en prosa suelta (AC-9). Existencia del
  archivo, existencia de la línea y match de la conjunción **no son exceptuables**»*.
  `SCANNER_FALSE_POSITIVES` vive en `exceptions.ts` y excepta **todo**: la clave desaparece del conjunto de
  huérfanas de `G-C4` y del invariante `OCCURRENCES.size === DECLARED.size + FALSE_POSITIVE_KEYS.size`.
  Lo único que `G-C8` exige es un `reason` de ≥ 40 caracteres no repetido palabra por palabra.
- **Reproducción** (medida, arnés `a5`, restaurado y md5-verificado):
  1. Borrar de `CITED_LINES` la entrada `CLAUDE.md :: src/types/database.types.ts:2567`
     (`citations.ts:658-668`) — una cita **P1, con path, normativa, del criterio de seguridad del repo**.
  2. Agregar a `SCANNER_FALSE_POSITIVES` `{ from: 'CLAUDE.md', cite: 'src/types/database.types.ts:2567',
     reason: '<cualquier texto plausible de 40+ chars> ' }`.
  3. `./node_modules/.bin/vitest run test/cited-lines-guard.test.ts`
  - **Esperado**: rojo (una cita con path que nombra un archivo trackeado no es «ruido del escáner»).
  - **Real**: `exit 0`, **10/10 passed**. Raíz validada dentro del JSON
    (`testResults[0].name = /home/ferdev/.openclaw/workspace/wasiai-a2a/test/cited-lines-guard.test.ts`).
- **Impacto**: cualquiera que vea un rojo de `G-C5` puede apagarlo cita por cita escribiendo una excusa, y
  el resultado es **indistinguible de un guardián sano**. Es exactamente el modo de falla que el docblock
  de `exceptions.ts:20-24` promete impedir. La cobertura del 6 % se puede erosionar a 0 % sin que ningún
  control cambie de color, y sin que el conteo de `G-C1` (`FOUND.length >= 40`) se mueva un milímetro
  —porque el token se sigue encontrando, sólo se deja de verificar—.
- **Sugerencia (la propiedad, no el código)**: la entrada de `SCANNER_FALSE_POSITIVES` tiene que ser
  **mecánicamente distinguible de una afirmación**. `citeNamesFile()` ya existe en el escáner y **ya está
  importada** en `test/cited-lines-guard.test.ts:189`: hoy las 3 entradas legítimas son `:100`, `:1` y
  `:00`, o sea `citeNamesFile === false` para las tres, así que la restricción cuesta cero. Ojo con
  prohibirlo *a secas*: medí que una URL con puerto (`https://x.io:8443/y`) produce un token **P2 con
  path** (`x.io:8443`) que sí es ruido legítimo — así que la regla no puede ser «ningún token con path»,
  tiene que ser «un token que nombra un archivo **trackeado por git** no puede ser un falso positivo del
  escáner». Esa versión mata mi mutante y deja pasar el caso de la URL.

---

## 🔴 `BLQ-MED-1` — `DELEGATED_TARGETS` es un SEGUNDO interruptor, y `G-C9` sólo vigila la única entrada que ya existía

- **Categoría**: Data Integrity (integridad del guardián) · Test Coverage
- **Archivo:línea**:
  - `test/cited-lines-guard.citations.ts:102-115` (la lista)
  - `test/cited-lines-guard.test.ts:242-253` (`isDelegated`, que las saca de `OCCURRENCES` **antes** de todo)
  - `test/cited-lines-guard.test.ts:914-949` (`G-C9`)
- **Qué está mal**: `G-C9` recorre `DELEGATED_TARGETS` y sólo pide (a) que el `target` esté trackeado y
  (b) que el `reason` tenga ≥ 40 caracteres. **El `ownedBy` no se verifica nunca.** Los chequeos que sí
  verifican un dueño real (`CITED_INDEX_LINES`, `it('G-F1`, `it('G-F2`, en `test.ts:932-939`) están
  **hardcodeados para la única entrada que existe hoy** y **no se generalizan a ninguna entrada nueva**.
  El propio docblock de `G-C9` (`test.ts:918-922`) dice que existe para que *«la delegación no se
  convierta en un agujero con cara de decisión»*: lo impide para `_INDEX.md` y para nada más.
  Además `isDelegated` matchea **por basename** cuando el token no tiene `/` (`test.ts:252`), así que una
  sola entrada barre todas las variantes del path.
- **Reproducción** (medida, arnés `a6e`):
  1. Agregar a `DELEGATED_TARGETS` `{ target: 'src/services/discovery.ts', ownedBy: 'NADIE. No existe
     ningún guardián que verifique estas citas.', reason: '<texto plausible de 40+ chars>' }`.
  2. Borrar las 3 entradas de `CITED_LINES` cuyo `target` es `src/services/discovery.ts`
     (`citations.ts:293-300`, `:573-585`, `:648-655`).
  3. `./node_modules/.bin/vitest run test/cited-lines-guard.test.ts`
  - **Esperado**: rojo (el dueño declarado no existe).
  - **Real**: `exit 0`, **10/10 passed**.
  - Radio de explosión medido por target: `src/lib/downstream-payment.ts` → **4 claves**;
    `src/services/discovery.ts` → **3**; `src/services/reputation.ts` → **1**.
- **Impacto**: una entrada mata N citas de una vez, con menos escritura que `BLQ-ALTO-1` y con **mejor
  cara** (parece una decisión de arquitectura). Y como `OCCURRENCES` y `DECLARED` bajan a la par, el
  invariante estricto de `G-C4` (`test.ts:745-750`) **queda balanceado y no avisa nada**.
- **Sugerencia**: `G-C9` tiene que verificar el dueño **por entrada**, no por literal hardcodeado — el
  `DelegatedTarget` necesita un campo que apunte al archivo y al nombre del control dueño, y `G-C9` tiene
  que abrirlo y comprobar que ese control existe **y que declara ese target**. Sin eso, `ownedBy` es prosa
  que nadie confronta, que es la misma clase de defecto que esta HU persigue.

---

## 🟠 `BLQ-BAJO-1` — `citations.ts:27-29` declara una precondición FALSA y un modo de falla que NO existe

- **Categoría**: Test Coverage / Integration (documentación normativa del registro)
- **Archivo:línea**: `test/cited-lines-guard.citations.ts:27-29`
- **Texto**: *«Precondición medida: hoy **no hay dos tokens `cite` IGUALES dentro de un mismo citador** del
  Corte A, así que `{from, cite}` es único. Si mañana aparece un duplicado, `G-C4` se pone rojo y pide un
  campo `nth` — no falla en silencio.»*
- **Las dos mitades son falsas, medidas sobre el commit entregado**:
  1. **Hay 3 claves duplicadas hoy** (son las 4 ocurrencias que explican `57 − 53`):
     - `src/services/agent.payment.test.ts :: :00` → **×2**
     - `test/sdd-index-matches-folders.exceptions.ts :: .gitignore:185` → **×3**
     - `test/sdd-index-matches-folders.exceptions.ts :: .gitignore:190-193` → **×2**
     Derivado corriendo `scanSource` sobre `CORTE_A_PATHS` y agrupando por `{file, cite}`.
  2. **`G-C4` NO se pone rojo ante un duplicado.** Repro (arnés `a9`): duplicar el token `:336` dentro de
     `src/services/fee-split.ts` agregando `// AR-224 A9: repito el MISMO token en el mismo citador -> :336`
     → **exit 0, 10/10 passed**. `OCCURRENCES` agrupa por clave (`test.ts:268-275`), así que el `size` no
     se mueve.
- **Y el propio guardián documenta lo contrario**, en el mismo commit: `test/cited-lines-guard.test.ts:159-165`
  (ítem 13 de la no-cobertura) dice que *«UNA declaración cubre todas las ocurrencias»* y que el `nth`
  **NO se implementa a propósito**. O sea: dos docblocks del mismo commit se contradicen, y el que está
  mal es el que un mantenedor va a leer para decidir si `{from, cite}` sigue siendo una clave segura.
- **Impacto**: el próximo que agregue una cita duplicada va a creer que el guardián lo avisa. No lo avisa.
  Es la frase que promete un rojo que no ocurre — la misma clase de defecto que la HU existe para sacar.
- **Sugerencia**: reemplazar el párrafo por lo que se mide hoy (3 claves con duplicado, y el número
  derivado, no escrito) y por el comportamiento real, remitiendo al ítem 13.

---

## 🟠 `BLQ-BAJO-2` — dos docblocks de `exceptions.ts` afirman «nace VACÍO» / «población 0» con 3 entradas escritas debajo

- **Categoría**: Test Coverage (documentación del archivo de excusas)
- **Archivo:línea** — **dos sitios**:
  1. `test/cited-lines-guard.exceptions.ts:58-60`: *«Nace VACÍO, y eso es el resultado de la escalera, no
     un descuido: **las 45 citas del Corte A se pudieron anclar con conjunción única**»* →
     `UNICITY_EXCEPTIONS` en `:62-95` tiene **3 entradas**. Y el «45» ya se sabe que es **57** (lo dice el
     propio guardián en `test.ts:74-77`).
  2. `test/cited-lines-guard.exceptions.ts:132-135`: *«**Población hoy en el Corte A: 0.** Y este archivo
     NO afirma que sea > 0»* → `SCANNER_FALSE_POSITIVES` en `:136-167` tiene **3 entradas**.
- **Reproducción**: leer `exceptions.ts:58` y `exceptions.ts:62`; leer `exceptions.ts:132` y
  `exceptions.ts:136`. Contraste directo, sin instrumento. Corroborado con
  `UNICITY_EXCEPTIONS.length === 3` y `SCANNER_FALSE_POSITIVES.length === 3` importando el módulo.
- **Impacto**: el archivo cuya regla número uno es *«cada entrada está escrita a mano después de leer el
  sitio»* (`exceptions.ts:4-6`) tiene su propia cabecera describiendo un estado anterior al de su
  contenido. Nada mecánico lo caza: `G-C8` valida el largo y la unicidad de los `reason`, no la
  cabecera. Es el mismo fenómeno que W5 documentó en el auto-blindaje (*«un desglose que ya estaba viejo
  por mi propia edición»*), en otros dos sitios y **sin declarar**.
- **Sugerencia**: no escribir la población en el docblock, o derivarla. Si se escribe, tiene que decir
  «al 2026-08-19 eran 3, y el número es una foto» — el mismo tratamiento que el propio guardián le da a
  sus números en `test.ts:66-72`.

---

## `MNR-1` — la SEXTA forma ciega: el archivo SIN extensión se decapita igual que el dotfile

- **Categoría**: Test Coverage / Integration
- **Archivo:línea**: `test/cited-lines-guard.scanner.ts:101-102` (`FILE_CITE_RE`), y la lista de
  no-cobertura (a)–(g) en `:15-48`, que **no lo nombra**.
- **Qué encontré**: el arreglo del dotfile cambió el `+` por `*` en el **nombre** del último segmento
  (`scanner.ts:91-99`), pero el grupo de extensión sigue siendo obligatorio `(?:\.[…]+)+`. Consecuencia
  medida, pasando fixtures a `scanSource`:

  | Fixture | Resultado |
  |---|---|
  | `// ver Dockerfile:12` | `P4 :12` — **pierde el nombre del archivo** |
  | `// ver Makefile:3` | `P4 :3` — idem |
  | `// ver docker/Dockerfile:12` | `P4 :12` — idem, con directorio y todo |
  | `// ver ~/.claude/hooks/x.sh:4` | `P1` con path `.claude/hooks/x.sh` — se come el `~` |
  | `// ver doc/mi archivo.md:9` | `P2` con path `archivo.md` — se come `doc/mi ` |
  | `// ver https://x.io:8443/y` | `P2` con path **`x.io`** — token de archivo inventado |

  Es **exactamente la misma pérdida** que el docblock describe para `.gitignore` en `scanner.ts:93-95`
  (*«se pierde el nombre del archivo, o sea justo lo que permite cruzar el token contra el `target`»*).
- **Por qué es MENOR y no bloqueante**: **degrada ruidoso, no silencioso.** Medido (arnés `a8`): agregar
  `// AR-224 A8: ... ver Dockerfile:12 y Makefile:3` a `src/services/fee-split.ts` pone **`G-C4` en rojo**
  (exit 1, 9/10). Y la población hoy es **0**: barrí los 14 paths del Corte A buscando
  `Dockerfile|Makefile|Procfile|LICENSE|CHANGELOG` seguidos de `:N` y no hay ninguno. Lo que se pierde no
  es la detección, es el cruce mecánico `citeMatchesTarget` — que queda vacuo (`scanner.ts:248`) y pasa a
  depender del `targetReason` escrito a mano.
- **Sugerencia**: agregar el caso a la lista (a)–(g) del escáner con el fixture medido. Arreglar el regex
  es opcional y tiene contraindicación: aceptar segmentos sin punto convierte `foo:12` de cualquier prosa
  en una cita con archivo.

## `MNR-2` — la abstención sobre `fee-split.ts:316` aplica un criterio distinto al de la corrección `:335 → :336` del mismo commit

- **Categoría**: Integration (consistencia del criterio)
- **Archivo:línea**: `src/services/fee-split.ts:494` (el citador) · `src/services/fee-split.ts:316` y
  `:320` (lo citado) · `test/cited-lines-guard.citations.ts:597-604` (la entrada) ·
  `auto-blindaje.md:143-147` (la abstención)
- **Medido**: la prosa dice *«un leg `failed` corta en el **return temprano** de `settleFeeSplits`
  (`:316`)»*. `:316` es `const failed = chargeable.find((l) => l.status === 'failed');` — la línea que
  **decide**. El `return settlement;` está en **`:320`**. El propio F3 lo escribió así en
  `citations.ts:610` (*«el return temprano está en `:320`»*).
- **La inconsistencia**: en el mismo commit y en la **misma línea del mismo comentario**, `:335 → :336` se
  corrigió con el argumento *«`:335` ... no menciona `priorTx`»* (`auto-blindaje.md:131-133`). Por ese
  mismo criterio, `:316` no menciona ningún `return`. Se aplicaron dos varas a dos citas de la misma
  oración.
- **Por qué es MENOR**: el número apunta a una línea real, adyacente y semánticamente ligada, la
  conclusión de la prosa es cierta, la abstención está **escrita y razonada**, y «corregir de más queda
  con cara de verificado» es un argumento legítimo. No hay defecto ejecutable. Lo reporto porque el
  criterio quedó sin fijar y la próxima cita de borde no va a saber cuál de las dos varas usar.
- **Sugerencia**: dejar escrito cuál es la regla (¿la línea citada debe contener el sujeto que la prosa
  nombra, o alcanza con que lo determine?) donde vive la escalera de 3 pasos, `exceptions.ts:26-38`.

## `MNR-3` — `G-C10` clava dos números que el mismo archivo declara no confiables

- **Categoría**: Test Coverage (candado que se pudre solo)
- **Archivo:línea**: `test/cited-lines-guard.test.ts:987-988` (`expect(self.includes('6,0 %'))`,
  `expect(self.includes('0,21 %'))`) contra `test/cited-lines-guard.test.ts:50-55` (*«EL NUMERADOR Y EL
  DENOMINADOR SON LOS DOS PISOS, así que el porcentaje **no es confiable en NINGUNA de las dos
  direcciones**»*) y `auto-blindaje.md:234-238` (`TD-316-CITAS-DOTFILE-EN-OTROS-CORTES`, que **se
  compromete a re-derivar el denominador**).
- **Escenario**: el día que alguien cumpla la deuda y re-derive el 749, el porcentaje correcto entra en
  conflicto con un `expect` literal. El rojo no señala nada falso — señala que el candado apunta a un
  número que su propio autor declaró equivocado.
- **Sugerencia**: clavar la **presencia del bloque de cobertura honesta y de la frase prohibida** (que es
  lo normativo de AC-10) sin clavar los dígitos, o marcar los dígitos como derivables.

## `MNR-4` — los 4 archivos del guardián concentran 187 tokens de cita y NINGUNO tiene testigo

- **Categoría**: Test Coverage
- **Archivo:línea**: `test/cited-lines-guard.citations.ts:68-83` (`CORTE_A_PATHS`, 14 paths, ninguno de
  los 4 nuevos) · el ítem 12 de la no-cobertura (`test.ts:155-158`) nombra `doc/sdd/224-…/sdd.md` y su
  `story-file.md`, **no estos cuatro**.
- **Medido** (corriendo `scanSource` sobre los 4): `cited-lines-guard.test.ts` **33** tokens ·
  `.citations.ts` **100** · `.exceptions.ts` **30** · `.scanner.ts` **24** = **187**. Contra 57 en todo el
  Corte A. O sea: **el commit más que cuadruplicó la población de citas del repo en archivos que su propio
  guardián no mira.**
- **Lo verifiqué a mano y NO encontré ninguna falsa.** Abrí las ~20 que afirman algo sobre otro archivo:
  `payment-guards-live-in-one-place.test.ts:45` (`function codeOnly(`) ✔ · `:16-20` ✔ ·
  `tsconfig.json:19` ✔ · `package.json:11` ✔ · `compose.ts:688` ✔ · `CLAUDE.md:212` ✔ ·
  `agents.ts:412/:430/:444/:459/:475` ✔ (idénticas byte a byte a `:220/:237/:252`) ·
  `types/index.ts:204` y `:286` ✔ (las dos dicen `EL NOMBRE MIENTE`) · `agent.ts:633` y `:808` ✔ ·
  `routes/compose.ts:130` = `/**` ✔ · `downstream-payment.ts:777` y `:922` ✔ · `registries.ts:35` y `:94` ✔ ·
  `discovery.ts:23` y `:63` ✔ · `reputation.ts:182` y `:189` ✔ · `fee-split.ts:320` ✔.
  **El hallazgo es la ausencia de testigo, no una cita falsa.** La disciplina de escritura fue buena.
- **Por qué es MENOR y no bloqueante**: hay una razón real para no meterlos (`citations.ts` tiene 100
  tokens que son los propios campos `cite:`, y `scanner.ts`/`test.ts` tienen fixtures que apuntan a
  archivos inexistentes — `a.ts:1`, `foo.ts:42`, `./splash.tsx:245` — que exigirían decenas de entradas de
  falso positivo). El ítem 10 de la no-cobertura lo cubre genéricamente. Lo que falta es **nombrarlo**,
  que es lo que AC-10 pide hacer con cada silencio que alguien leyó y decidió dejar.
- **Sugerencia**: un ítem propio en la lista de no-cobertura con el número derivado y la razón de diseño.

## `MNR-5` — `README.md` / `README.es.md` están en la lista ⛔ Out of Scope y el commit los modifica

- **Categoría**: Scope Drift
- **Archivo:línea**: `story-file.md:1116` (*«⛔ **`README.md`, `doc/INTEGRATION.md`, `doc/**`** — Corte D»*)
  vs. el diff (`README.md:378` y `README.es.md:405`, `295` → `296`).
- **Por qué es MENOR**: está **forzado y documentado**. `test/readme-numbers.test.ts` deriva la cantidad de
  archivos de test del índice de git y ambos README la publican; el archivo nuevo la movió a 296, así que
  sin ese cambio la Done Definition #5 (`npm test` exit 0) era **inalcanzable**. El auto-blindaje lo
  registra (`auto-blindaje.md:173-186`), el cambio es de **un dígito** y **línea-neutro**
  (`wc -l` idéntico a `b31ddba`: 444 y 466). No es ampliación de alcance sobre los README.
- **El defecto real es del contrato, no del Dev**: §15 y la Done Definition #5 del Story File estaban en
  conflicto directo y nadie lo vio en F2.5.
- **Sugerencia**: que la próxima HU que agregue un archivo de test declare la excepción de los README en
  el Scope OUT, en vez de dejar que aparezca en la puerta 3.

---

# 2. Verificación de lo que el F3 declara — punto por punto

| # | Declarado | Mi medición | ✔ |
|---|---|---|---|
| 1 | El universo es **57**, no 45 | `scanSource` sobre `CORTE_A_PATHS` → **57** | ✔ |
| 1 | Desglose `P1=15 P2=19 P3=16 P4=7` | idéntico, derivado | ✔ |
| 1 | 53 claves = 50 declaradas + 3 FP | `OCCURRENCES.size = 53`, `CITED_LINES.length = 50`, FP keys = 3 | ✔ |
| 1 | Las **8** citas al dotfile estaban **+13** | verificadas una por una contra `.gitignore` (ver §3), `git status --porcelain .gitignore` vacío ⇒ disco = `HEAD` | ✔ |
| 1 | Los +4 P4 son ruido **con motivo escrito** | 3 entradas en `SCANNER_FALSE_POSITIVES` (`:100`, `:1`, `:00`×2), motivos de 300+ chars, ninguno filtrado en el escáner | ✔ |
| 2 | Abstención `tsconfig.json:19` | `git show HEAD:tsconfig.json` → `:17` = `"sourceMap": true`, **`:19` = `"include": ["src/**/*"],`**, `:20` = `"exclude"`. **La abstención fue CORRECTA**: aplicar la «corrección» del SDD habría metido una cita falsa | ✔ |
| 2 | Abstención `fee-split.ts:316` | `:316` = `const failed = …`, el `return` está en `:320` → ver **`MNR-2`** | ⚠ |
| 3 | **No hay `fromLine` guardado** | `grep -rn fromLine\|citadorLine\|lineaCitador` sobre los 4 archivos → **sólo prosa**. La interfaz `CitedLine` (`citations.ts:38-57`) no tiene el campo; `FoundCite.line` se deriva en `scanSource` con `lineOf(start)` | ✔ |
| 3 | Cero duplicados en el Corte A | **FALSO — hay 3.** Ver `BLQ-BAJO-1` | ✘ |
| 3 | El detector encuentra 2 en `exceptions.ts` | ✔ — `.gitignore:185`×3 y `.gitignore:190-193`×2, las dos en `test/sdd-index-matches-folders.exceptions.ts`. **Control positivo re-corrido y verde** | ✔ |
| 4 | AC-3 no es la ingenua: el `symbolPath` es lo que la hace satisfacible | Medido: **8 entradas** cuya needle SOLA es ambigua y que el `symbolPath` salva. La peor: `owner_ref: string;` → **66 hits** solo, **1** con `['registries','Row','owner_ref']` | ✔ |
| 4 | `symbolPath: []` **no** es bypass (CD-12) | Medido (`a10`): vaciar el `symbolPath` de `compose.ts:571` → **rojo, `E-SYMBOL_OMITTED`** en `G-C6`. `locate` lo saltea (`scanner.ts:402`) pero `evaluateSymbol` lo compara igual (`test.ts:433-446`). **No hay agujero** | ✔ |
| 5 | CD-14 mata las excepciones que intentan saltear existencia y match | ✔ para `UNICITY_EXCEPTIONS` (4 mutantes, todos muertos con el código correcto) — ✘ para las otras dos listas. Ver `BLQ-ALTO-1` y `BLQ-MED-1` | ⚠ |
| 5 | Los `mustContain` están **escritos a mano**, no volcados | Medido: **39 de 50** needles son un SUBCONJUNTO de la línea, no la línea entera. Las 11 que coinciden con la línea entera son las de `.gitignore` (donde la línea ES el path) y firmas de función. **No hay firma de volcado** | ✔ |
| 6 | `G-F2`: cita nueva sin declarar = rojo | Medido (`a7`): `// ver src/services/reputation.ts:189` en `src/services/fee-split.ts` → **rojo, `G-C4`**, con archivo, línea derivada y token | ✔ |
| 7 | La cobertura honesta no afirma de más | ✔ — la frase prohibida está declarada como prohibida (`test.ts:57-60`), «numerador y denominador son pisos» está escrito (`:50-55`), la única frase admisible es *«estas citas no pueden mentir sin que la suite se caiga»*. **No encontré ninguna frase que sugiera cobertura total** en los 4 archivos | ✔ |
| 8 | M20 fue un **falso KILLED** por `PARSE_ERROR`, re-hecho | Re-corrí con detector explícito. **Mi propio arnés produjo un falso KILLED** (mutante `a6c`: mi borrado dejó un `{` colgado → `0/0 tests` + exit 1) y el detector lo marcó `FALSO KILLED`, no `KILLED`. Los 12 mutantes que reporto como muertos tienen su **código de error leído del JSON**, no el exit code | ✔ |
| 9 | `--numstat` N/N en las 8 filas | ✔ — `1/1 ×6`, `3/3`, `8/8` | ✔ |
| 9 | `wc -l` idéntico (2318 / 1804 / 599) | ✔ y **extendido a los 8**: 444, 466, 215, 599, 1804, 721, 2318, 192 — **todos idénticos a `b31ddba`** | ✔ |
| 9 | El diff de `src/` es **sólo comentario** | ✔ medido: **14 líneas `+`/`-`, 0 que no empiecen con `*` o `//`** | ✔ |
| 9 | `npm test` 296 archivos | ✔ **296 files · 5779 tests · 5760 passed · 19 pending · exit 0**, raíz validada dentro del JSON (0 archivos fuera de `/wasiai-a2a/`) | ✔ |
| 9 | `tsc --noEmit` 0 · `biome check src/` 0 | ✔ `TSC_EXIT=0` · `BIOME_EXIT=0` (489 archivos) | ✔ |
| 9 | El warning de sourcemap es cosmético | ✔ **1 ocurrencia** en la corrida completa, `exit 0`. Es `typescript.js.map` ausente en `node_modules` | ✔ |
| — | md5 de CD-9 (`212-…/story-file.md`) | **`7904ef74a1c46d7880e0ca5d38e3eed4`** — idéntico al pre-registro. **No lo toqué** | ✔ |

## 3. Las 8 citas al dotfile, una por una

`git status --porcelain .gitignore` → **vacío** ⇒ el disco ES `HEAD`.

| Token viejo | Token nuevo | Δ | Contenido real de la línea nueva | Ocurrencias |
|---|---|---|---|---|
| `.gitignore:172` | `.gitignore:185` | +13 | `/doc/sdd/074-wkh-80-operator-identities-runbook/done-report.md` | 3 (`:90`, `:119`, `:142`) |
| `.gitignore:173` | `.gitignore:186` | +13 | `/doc/sdd/084-wkh-69-passport-hybrid-inbound/done-report.md` | 1 (`:146`) |
| `.gitignore:177-180` | `.gitignore:190-193` | +13 | las 4 de `149-wkh-71-operator-wallet-alert/` (`auto-blindaje`, `report`, `validation`, `work-item`) | 2 (`:98`, `:123`) |
| `.gitignore:178` | `.gitignore:191` | +13 | `/doc/sdd/149-wkh-71-operator-wallet-alert/report.md` | 1 (`:150`) |
| `.gitignore:184` | `.gitignore:197` | +13 | `/doc/sdd/spike-kite-passport/poc-results.md` | 1 (`:155`) |

**Total 8 ocurrencias, las 5 claves corridas exactamente +13.** Y la vieja `:172` era en efecto
`/doc/investors/30-60-90-traction-plan.md`, o sea que la prosa afirmaba *«runbook de identidades de
operador»* señalando el plan de tracción para inversores. **Confirmado.** Las 5 correcciones son
correctas y semánticamente exactas.

---

# 4. Las 11 categorías

### 1 · Security — **OK**
Sin secretos en los 4 archivos nuevos: los dos hits de `OPERATOR_PRIVATE_KEY`
(`citations.ts:290`, `:434`) son **needles que citan el NOMBRE de la env var**, no valores, y esas citas
ya existían en `src/lib/operator-address.ts` antes de esta HU. Sin `exec` con shell: el único subproceso
es `execFileSync('git', ['ls-files','-z'], …)` (`test.ts:202`) — argv array, sin interpolación, sin shell.
Sin path traversal: todo `readTracked` se hace sobre paths ya validados contra `TRACKED_SET`
(`test.ts:298`, `:425`) o provenientes de `BY_BASENAME`, que se llena del índice de git. Repo público:
no se agregó nada que exponga rutas o contenido nuevo; `.nexus/project-context.md` **sigue sin trackear**
(CD-13 respetado, verificado con `git ls-files .nexus/` vacío).

### 2 · Error Handling — **OK**
El algoritmo de `evaluate` (`test.ts:293-420`) tiene el **orden correcto**: existencia del archivo →
consistencia token/target → rango de línea → unicidad → movimiento → **control positivo del cero en los
hermanos** → ancla ausente. El cero nunca se lee como ausencia sin haber buscado antes: `E-WRONG_FILE`
(`test.ts:396-406`) lo mide contra `BY_BASENAME`. Verifiqué los 6 códigos con mutantes y **cada uno murió
por su razón**, leída del JSON: `E-LINE_OUT_OF_RANGE`, `E-TARGET_MISSING`, `E-ANCHOR_GONE`,
`E-LINE_MOVED` (con el número nuevo), `E-CITE_TARGET_MISMATCH`, `E-SYMBOL_OMITTED`, `E-SYMBOL_DRIFT`.
Los mensajes de error son inusualmente buenos: el de `E-LINE_MOVED` **advierte contra copiar su propio
número** (`test.ts:378-379`), que es CD-11 hecho texto.

### 3 · Data Integrity — 🔴 **BLQ-ALTO-1 · BLQ-MED-1**
Ver §1. El invariante central —no guardar la línea del citador— **se sostiene y lo verifiqué**. Lo que no
se sostiene es la promesa de CD-14 sobre `exceptions.ts` como conjunto.

### 4 · Performance — **OK**
El guardián corre en **6,4 ms**. `SF_CACHE` (`scanner.ts:322-330`) cachea el `SourceFile` por path **y
compara el contenido** antes de devolver el hit, así que no puede servir un AST viejo. `SRC_CACHE`
(`test.ts:222-229`) lee cada archivo una vez por corrida. El peor caso —66 descensos del resolver sobre
`database.types.ts`— es invisible en el total. Sin N+1, sin leaks (todo muere con el proceso del test).

### 5 · Integration — **OK**
Cero dependencias nuevas: `typescript` y `vitest` ya estaban en `devDependencies`. Cero cambios de
contrato: el diff de `src/` es **14 líneas, todas de comentario** (medido). `test/readme-numbers.test.ts`,
`test/payment-guards-live-in-one-place.test.ts` y `test/sdd-index-matches-folders.test.ts` siguen verdes
en la corrida completa. CD-7 respetado: no se tocó ni un assert ni el `codeOnly` del guard del camino del
dinero. `npm test` completo en verde ⇒ backwards compatibility real, no declarada.

### 6 · Type Safety — **OK**
Cero `any`, cero `@ts-ignore`. Los 8 `as string` / `as number` son des-anidados de
`noUncheckedIndexedAccess` **posteriores a una comprobación de límites explícita**
(`scanner.ts:121, 150, 170, 174, 400`; `test.ts:369, 532`). El único cast estructural,
`node as ts.Node & { name?: ts.Node }` (`scanner.ts:317`), está protegido por la whitelist `DECL_KINDS` y
por `propertyNameText`, que maneja `undefined`. `tsc --noEmit` exit 0.

### 7 · Test Coverage — 🟠 **BLQ-BAJO-1 · BLQ-BAJO-2 · MNR-3 · MNR-4**
Los controles de armado son genuinos y no vacuos: `G-C2` usa fixtures en memoria con la respuesta conocida
y **cierra la asimetría** del escáner-que-nunca-reporta con un par de aserciones explícito
(`test.ts:599-603`); `G-C3` prueba el resolver contra la variante «nodo más interno» que se descartó
midiendo. Lo que falta son los cuatro puntos de arriba. **No inventé nada más acá**: las 10 pruebas miden.

### 8 · Scope Drift — **MNR-5**
Ver §1. Los otros ⛔ están respetados: los 41 pares y las 40 anclas de prosa de
`ownership-filter-guard.exceptions.ts` intactos; `m5-keys/` sin tocar; `.nexus/project-context.md` sin
trackear; los otros dos repos sin tocar; **nada pusheado, `main` en `b31ddba`**; `doc/sdd/212-…` con md5
intacto.

### 9 · Destructive Migrations — **N/A**
No hay SQL, ni migrations, ni `supabase/migrations/*` en el diff. El único `.sql` que aparece es como
**target citado** (`20260401000000_kite_registries.sql:44-66`, sólo lectura).

### 10 · RPC con `SECURITY DEFINER` — **N/A**
No hay funciones postgres, ni `supabase.rpc(...)`, ni `EXECUTE format(...)` en el diff. CD-2 lo prohibía
explícitamente y se respetó.

### 11 · Cache Invalidation — **OK** (revisada, no N/A: la HU introduce dos caches)
`SF_CACHE` (`scanner.ts:322`) y `SRC_CACHE` (`test.ts:222`) son caches de proceso, vivos **una corrida de
vitest**. No hay multi-tenant, no hay `user_id`, no hay TTL, no hay stale entre dispositivos: no aplica
nada del checklist de LUM-58. La única pregunta real —¿puede `SF_CACHE` devolver un AST de un contenido
viejo?— está resuelta: la clave se valida contra el `src` (`scanner.ts:326`). **Sin hallazgos.**

---

# 5. Instrumentos y límites de lo que pude medir

**Instrumentos que fallaron o dieron resultados falsos, declarados:**
- **Mi propio detector de FALSO KILLED dio un falso positivo** en la primera versión: su regex incluía
  `Failed to load`, que matchea el warning cosmético de sourcemap de vite, así que marcó como
  «PARSE_ERROR» cuatro mutantes que habían muerto legítimamente. Lo corregí y re-leí los cuatro
  resultados desde el JSON. **Es la misma clase de error que M20**, producida por mí, en la misma sesión.
- **Mi arnés abortó dos veces** por conteo de ancla ≠ 1 y **produjo un FALSO KILLED** (mutante `a6c`,
  `0/0 tests`, exit 1, por un `{` que dejé colgado). Las tres veces el arnés se negó a reportar en vez de
  reportar mal. Restauración siempre desde **copia propia** con md5 contra el pre-registro; **nunca usé
  `git checkout --`**.
- Usé `/usr/bin/git` para todo git, `command grep -n`, `./node_modules/.bin/{vitest,tsc,biome,tsx}`, y
  **JSON reporter con validación de la raíz adentro del JSON** (`testResults[*].name` contiene
  `/wasiai-a2a/`) en las **13** corridas de vitest. Nunca leí un exit code tras un pipe.
- `git status --porcelain src/ test/` verificado **vacío después de cada bloque de mutantes**.

**Límites de lo que pude medir — con estas palabras:**
- **No medí la VERDAD de la prosa que rodea a las 50 citas.** Verifiqué que la línea citada contiene lo
  declarado y que la afirmación de las ~20 citas nuevas del guardián es cierta hoy; **no** verifiqué que
  las conclusiones de los ~50 comentarios del Corte A sigan siendo ciertas. Es el ítem 3 de la
  no-cobertura y sigue siendo cierto después de mi AR.
- **No medí la prosa suelta.** Barrí los 14 paths buscando `#L\d+`, `línea N`, `line N` y
  `Dockerfile|Makefile|…:N` y no encontré ninguna, pero eso **no es una cota superior**: «el guard de más
  abajo» no lo caza ningún patrón, y `UNANCHORABLE_PROSE = []` sigue midiendo lo que alguien leyó, no lo
  que hay.
- **No re-derivé el denominador** (749 anclas en `src`+`test`, ~20.550 en `doc/`). El F3 declara que
  ambos salieron del escáner que se comía los dotfiles y que están subestimados por una cantidad no
  medida; **no lo verifiqué ni lo desmentí**, y por eso `MNR-3` es MENOR y no bloqueante.
- **No corrí la suite completa bajo cada mutante**, sólo `test/cited-lines-guard.test.ts`. La corrida
  completa (296 archivos) la hice una vez, sobre el árbol limpio.
- **No probé el guardián en un clone fresco.** Todo lo medí sobre este working tree, con
  `git status --porcelain` limpio salvo los 3 untracked conocidos.
- **No ejecuté nada contra producción.** Ni Railway, ni Supabase, ni x402. Cero llamadas de red.

---

# 6. Fix-pack sugerido, en orden

1. **`BLQ-ALTO-1`** — cerrar `SCANNER_FALSE_POSITIVES`: un token que nombra un archivo **trackeado por
   git** no puede declararse ruido del escáner. Validar en `G-C8`.
2. **`BLQ-MED-1`** — `G-C9` tiene que verificar el dueño **por entrada** de `DELEGATED_TARGETS`, no con
   literales hardcodeados de `_INDEX.md`.
3. **`BLQ-BAJO-1`** — reescribir `citations.ts:27-29`: hay 3 claves duplicadas hoy y `G-C4` **no** se pone
   rojo ante un duplicado (remitir al ítem 13).
4. **`BLQ-BAJO-2`** — corregir las dos cabeceras de `exceptions.ts` (`:58-60` y `:132-135`) que dicen
   «vacío» / «0» con 3 entradas debajo.
5. Los `MNR-1..5` quedan a criterio: `MNR-1` (declarar la sexta forma) y `MNR-4` (declarar los 187 tokens
   sin testigo) son los dos que más barato cierran y más honestidad agregan al bloque de no-cobertura.

> **Nota para el orquestador**: los 4 bloqueantes son de **integridad del guardián y de honestidad de su
> propia prosa**, ninguno toca lógica de producción. El diff sobre `src/` son 14 líneas de comentario y
> `main` sigue en `b31ddba`. El fix-pack no necesita tocar `src/`.
