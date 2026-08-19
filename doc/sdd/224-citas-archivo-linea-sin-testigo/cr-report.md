# CR ACOTADO — HU 224 · WKH-362 · el guardián de citas

> **Alcance**: exactamente el delta `06758af..ac4f4c3` (el fix-pack del re-AR, que no había revisado nadie).
> **NO** se re-auditó la HU entera: los 4 BLOQUEANTEs, el 31/19, los bordes de `citeTargetIfTracked` y las
> 3 puertas ya los verificó `ar-report-it2.md`, y lo que re-medí de eso está marcado como re-derivación.
>
> Rama `feat/224-citas-archivo-linea-sin-testigo` · HEAD `ac4f4c3` · `main` `b31ddba` · nada pusheado.
> Delta: **4 archivos, 0 líneas en `src/`** (`test/cited-lines-guard.{test,scanner,exceptions}.ts` +
> `auto-blindaje.md`; `sdd.md`/`story-file.md`/`ar-report*.md` entraron en `cc714a1`, el commit anterior).
> Árbol final: `git status --porcelain` = **un solo untracked**, el esperado.
> `doc/sdd/212-…/story-file.md` md5 `7904ef74a1c46d7880e0ca5d38e3eed4` — **intacto**.

---

## VEREDICTO: **APROBADO**

**Sin hedging, y con esto se puede mergear.** Los tres exploits del re-AR (`T-A`, `T-B`, `M-DEL`) están
**replicados VERDE en `06758af` y MUERTOS en `ac4f4c3`**, medidos en las dos direcciones con el mismo arnés;
las dos calibraciones (`CAL-0`, `CAL-1`) siguen en 12/12, o sea que **no se cambió un rojo por otro**; las 3
puertas dan los números declarados **exactos**; y **los seis números del ítem 14 (247 = 88+97+26+36) y el
«36 igual que antes» se re-derivaron y coinciden byte a byte**.

**Cero BLOQUEANTEs.** **5 MENORes**, todos con repro ejecutable y todos en el mismo territorio: **la prosa
del fix-pack afirma más de lo que su código sostiene**. Ninguno rompe un AC, ninguno expone nada, ninguno
pierde datos, y **los cinco exigen editar el guardián o su registro** — que es la misma calibración con la
que `ar-report-it2.md` clasificó `MNR-it2-3` como MENOR. Es calibración, no tolerancia.

---

# 1 · LOS CINCO MUTANTES — RE-CORRIDOS, EN LAS DOS DIRECCIONES

**Arnés** (declarado, porque el resultado depende de él): worktree detached en `06758af` con `node_modules`
enlazado; copia propia de cada archivo tocado + **md5 pre-registrado**, **cero `git checkout --`**; **aborto
si el ancla no aparece exactamente N veces** (disparó una vez, en `payment-spec-writer.ts`: 28 ocurrencias en
vez de 1 — se re-ancló con las últimas 3 líneas); restauración en `finally` **verificada por md5** en cada
corrida; reporter JSON de vitest a `--outputFile` (**nunca redirigido**), **raíz validada ADENTRO del JSON**
(`testResults[*].name`), **exit code nunca leído**. `cd` al repo siempre (nunca `--root`). Worktree
**eliminado** al cerrar; md5 finales de los 4 archivos **idénticos** al pre-registro.

| # | Mutante | `06758af` | `ac4f4c3` | Mata |
|---|---|---|---|---|
| **CAL-0** | registro real, sin mutar | 12/12 | **12/12 ✅** | — |
| **CAL-1** | `https://x.io:8443/y` escrita en `src/lib/payment-spec-writer.ts` (Corte A, 0 citas) + `x.io:8443` declarado ruido | — | **12/12 ✅** | — |
| **T-A** | `if (e.reason.trim().length > 150) …` adentro del barrido + `downstream-payment.ts:772` movida a `SCANNER_FALSE_POSITIVES` con excusa de 300+ chars | **12/12 VERDE** 🔴 | **11/12 — MUERE** | `G-C8` |
| **T-A-solo** | sólo el filtro, sin mover ninguna cita | — | **11/12 — MUERE** | `G-C8` |
| **T-B** | `citeTargetIfTracked` resuelve **sólo** los basenames de los fixtures de `G-C11` (`database.types.ts`, `splash.tsx`, `fixture.ts`, `.gitignore`, `CLAUDE.md`) + `downstream-payment.ts:772` a ruido | **12/12 VERDE** 🔴 | **11/12 — MUERE** (`G-C11` **sigue verde**) | `G-C8` |
| **M-DEL** | `src/lib/downstream-payment.ts` delegado a `src/lib/money-invariants.fuzz.test.ts` (lo nombra en un comentario de bloque, `:14`) + borradas sus declaraciones | **`G-C9` VERDE** 🔴 | **`G-C9` ROJO — MUERE** | `G-C9` |
| **REV-SC** | quitar `stripComments` de `delegationFindings` (`test.ts:392`) | — | **11/12 — `G-C12` ROJO** | `G-C12` |

**Las cuatro afirmaciones que esto sostiene:**

1. **`T-A` y `T-B` mueren por el testigo nuevo, no por otra cosa.** En `T-B` el único rojo es `G-C8`:
   **`G-C11` queda VERDE**, que es exactamente el agujero que `MNR-it2-3` denunciaba. Confirmado.
2. **`T-A-solo` también muere**: el testigo caza el filtro **aunque el atacante todavía no haya movido
   ninguna cita**. Eso es mejor de lo que el fix-pack promete.
3. **`M-DEL` muere por `stripComments`, medido diferencialmente**: mismo exploit, mismo arnés, `G-C9` verde
   en `06758af` y rojo en `ac4f4c3`. *Límite de esta medición, con esas palabras*: mi variante de `M-DEL`
   deja `G-C4` rojo **en los dos commits** por un residuo propio (el token suelto `` `:922` `` no se puede
   resolver al target delegado una vez borrada su declaración), así que **medí el diferencial sobre `G-C9`**,
   que es el control en discusión, no sobre el total.
4. **`CAL-1` es la que decide, y pasa.** No la hice con una declaración huérfana —ese camino da rojo por
   `G-C4`/`G-C7`, y así lo verifiqué primero—: **escribí la URL en un archivo real del Corte A** y declaré el
   token que **el escáner efectivamente produce**. **12/12.** El ruido legítimo con path no trackeado
   **sigue siendo declarable**.

**`REV-SC`** cierra la pregunta de si la aserción nueva de `G-C12` mide o se ajustó para pasar: quitando
`stripComments` de `test.ts:392`, **`G-C12` se pone rojo**. Mide.

---

# 2 · EL DISEÑO DEL TESTIGO — LAS CUATRO PROPIEDADES SON CIERTAS, Y HAY DOS FAMILIAS VIVAS

Re-derivadas con `tsx` sobre el registro real (`test/cited-lines-guard.test.ts:1132-1224`):

| Propiedad declarada | Medido |
|---|---|
| canarios con **18 basenames distintos** | **18** exactos (`downstream-payment.ts`, `payment-spec-reader.ts`, `agent.ts`, `reputation.ts`, `20260401000000_kite_registries.sql`, `compose.ts`, `registries.ts`, `discovery-query.ts`, `index.ts`, `payment.ts`, `discovery.ts`, `tsconfig.json`, `.gitignore`, `chain.ts`, `deposit-verifier.ts`, `forward-key.test.ts`, `database.types.ts`, `registry.ts`) |
| un canario por cada `reason` **en runtime** | `citasQueNombranArchivo` = **31**, `SCANNER_FALSE_POSITIVES` = **3** ⇒ `CANARIOS.length` = 31 × (1+3) = **124** |
| barrido **en la misma llamada** | `test.ts:1216` — `ruidoQueNombraArchivoTrackeado([...SCANNER_FALSE_POSITIVES, ...CANARIOS])`, una sola invocación. Cierto |
| delta contra un número **derivado** | `test.ts:1224` — `.toBe(CANARIOS.length)`. Cierto, y **es también la puerta de `MNR-cr-3`** |
| vacuidad `>= 10` | `test.ts:1193-1201`. Cierto — y cubre **sólo** los canarios base |

**La quinta familia que el Dev declaró viva —discriminar por el CONTENIDO del token— es cierta.** Pero la
frase que la acompaña (`auto-blindaje.md:610-612` y `test.ts:1183-1186`) dice de más, y eso lo medí:

> *"Lo que dejó de ser posible es apagar el candado ENTERO **o por un campo de la entrada**."*

**Falso para el campo `from`.** Ver `MNR-cr-2`.

---

# 3 · LOS 5 MENORES — ORDENADOS POR VALOR DE ARREGLO

### `MNR-cr-1` · 🎯 la delegación sigue costando CERO, y el costo declarado es falso
**Categoría**: Test Coverage / Integrity del control
**Evidencia**: `test/cited-lines-guard.scanner.ts:344-352` (`stripComments`) · `test/cited-lines-guard.test.ts:352-356`
(el límite declarado) · `doc/sdd/224-citas-archivo-linea-sin-testigo/auto-blindaje.md:613-614`

El fix-pack declara: *"un dueño puede seguir nombrando el target en una línea de **código** que no lo vigile.
El costo subió de «escribir un comentario» a **«escribir código muerto que alguien va a ver en el diff»**; no
bajó a cero."* **Medí las dos mitades, y las dos son más baratas que eso.**

**Repro A — el costo es un comentario, otra vez (12/12 VERDE, medido)**:
`stripComments` **no borra un comentario al final de una línea de código**. Medido llamando la función:

```
BORRADO   // src/lib/downstream-payment.ts            (línea que es sólo comentario)
BORRADO   /** … src/lib/downstream-payment.ts … */    (bloque)
SOBREVIVE it('X-02', () => {}); // src/lib/downstream-payment.ts   <-- ACÁ
SOBREVIVE const x = 1; // vigila src/lib/downstream-payment.ts     <-- ACÁ
```

End-to-end sobre el árbol real: se reemplaza la mención de bloque de `src/lib/money-invariants.fuzz.test.ts:14`
por **una línea al final del archivo**, `const _COBERTURA = 1; // cubre src/lib/downstream-payment.ts`, se
delega `src/lib/downstream-payment.ts` a ese archivo y se borran sus 4 declaraciones con token
⇒ **`npm test` del guardián en 12/12 VERDE**, con las 4 citas del módulo de liquidación del money-path fuera
del universo. **Es el mismo `M-DEL` que el fix-pack mató, revivido con un comentario.**

**Repro B — el costo es CERO, sin escribir una sola línea (12/12 VERDE, medido)**:
`test/readme-parity.test.ts:105` **ya nombra** `'src/lib/downstream-payment.ts'` hoy, en `main`, dentro de un
string de una línea de código (sobrevive `stripComments`), y es un `*.test.ts` que **corre**. Delegar
`src/lib/downstream-payment.ts` a `test/readme-parity.test.ts` con `ownerControls: ["it('★ citan exactamente
los mismos archivos"]` ⇒ **12/12 VERDE**, sin escribir código muerto, sin tocar ningún archivo fuera del
registro. `readme-parity` **no verifica una sola cita**: compara qué archivos nombran los dos README.

**Impacto**: la delegación sigue siendo **el interruptor más barato del guardián** —una entrada saca N claves
de una vez— y la frase que dice cuánto cuesta apagarlo es incorrecta en el sentido peligroso (dice que cuesta
más de lo que cuesta). **La asimetría que `ar-report-it2.md` señaló sigue viva**: `SCANNER_FALSE_POSITIVES`
tiene candado mecánico, `DELEGATED_TARGETS` sigue teniendo uno de presencia.
**Sugerencia**: o borrar también el comentario de final de línea (con el mismo cuidado de no partir un
`'https://…'`), o —más barato y más honesto— **corregir la frase**: el costo NO subió a «código muerto», subió
a «un comentario al final de una línea, o ninguno si el dueño ya nombra el target en un string».

---

### `MNR-cr-2` · 🎯 el candado 2️⃣ sigue apagable **por un campo de la entrada** (el que la frase dice que no)
**Categoría**: Test Coverage
**Evidencia**: `test/cited-lines-guard.test.ts:1132-1146` (el barrido) · `:1183-1186` (la frase) ·
`auto-blindaje.md:610-612`

El testigo emite **un canario por cada `reason`** en runtime, y eso mata el filtro por `reason`. **No emite
nada equivalente para el campo `from`.** Los canarios llevan el `from` de las citas que siguen en
`CITED_LINES` — y una cita que el atacante **saca** de `CITED_LINES` deja de aportar su `from`.

**Repro ejecutada (12/12 VERDE)**:
```
1. mover  src/services/agent.payment.test.ts :: downstream-payment.ts:247
   de CITED_LINES a SCANNER_FALSE_POSITIVES, con una excusa larga
2. una línea en el barrido:
   if (e.from === 'src/services/agent.payment.test.ts') return [];
=> 12/12 VERDE.  src/lib/downstream-payment.ts:247 (la FIRMA de settleSolanaLeg,
   money-path) queda fuera del universo del guardián.
```
Funciona porque `src/services/agent.payment.test.ts` aporta **exactamente 1** canario, y ese canario es
justo la cita que se movió. Derivado hoy: **3 de los 11 citadores están en esa situación** —
`src/services/agent.ts` (1), `src/services/agent.payment.test.ts` (1), `src/routes/agents.publish.test.ts` (1).

**Impacto**: el exploit cuesta **exactamente lo mismo que `T-A`**, que es el que este fix-pack acaba de
cerrar: una línea en el barrido más mover la entrada. Y la prosa dice que esa clase ya no existe.
**Sugerencia**: emitir también los canarios **una vez por cada `from` de la lista real** (mismo patrón que se
usó para `reason`), o corregir la frase para que nombre `reason` y no «un campo de la entrada».

---

### `MNR-cr-3` · el testigo no tiene control sobre su PROPIO conjunto de canarios
**Categoría**: Test Coverage
**Evidencia**: `test/cited-lines-guard.test.ts:1193-1201` (vacuidad) · `:1203-1215` (`CANARIOS`) · `:1216-1224` (el delta)

El valor esperado es `CANARIOS.length` — **derivado del propio conjunto de canarios**. Eso lo hace
inmortal a los cambios del registro (bien) y **ciego a que el conjunto se achique** (mal). El único piso es
`citasQueNombranArchivo.length >= 10`, que mide **sólo la mitad base**.

**Repro ejecutada (12/12 VERDE)**:
```
1. borrar el bloque de test.ts:1210-1214 (los canarios por `reason`)
   — 5 líneas, cuyo propio comentario dice que son lo que mata el filtro por reason
2. re-aplicar T-A (filtro por reason + cita real a la lista de ruido)
=> 12/12 VERDE.  El candado 2️⃣ vuelve a estar apagado.
```
Sin el paso 2, el paso 1 **también da 12/12**: nada se pone rojo cuando el testigo se debilita.

**Impacto**: el mismo defecto que `MNR-it2-3` denunciaba, una capa más arriba — el testigo ahora vigila el
llamador, y nadie vigila al testigo. **Es un residual, no un agujero**: exige editar el guardián.
**Sugerencia**: un assert de armado del propio testigo, del estilo del que ya existe en `G-C11:1459-1464`:
`expect(CANARIOS.length).toBe(citasQueNombranArchivo.length * (1 + SCANNER_FALSE_POSITIVES.length))`.
Es una línea, y es derivada — no se pudre.

---

### `MNR-cr-4` · la duplicación de `stripComments`: la decisión es defendible, la JUSTIFICACIÓN no cierra
**Categoría**: Integration / calidad
**Evidencia**: `test/cited-lines-guard.scanner.ts:317-343` (la justificación) ·
`test/payment-guards-live-in-one-place.test.ts:45-55` (`codeOnly`) ·
`test/scripts-imported-by-tests-are-tracked.test.ts:61-67` (**el tercero**) · `sdd.md:414` (`CD-7`)

**Lo que verifiqué y está bien**: la cadena de `stripComments` es **textualmente idéntica** a la de
`codeOnly` — mismo `.replace(/\/\*[\s\S]*?\*\//g, '')`, mismo `.filter` con el mismo predicado, mismo
`.join('\n')`. **Cero divergencia de comportamiento hoy**: manejan igual los strings con `//` adentro, igual
los template literals (ninguno los entiende) y igual una regex que contenga `/*` (los dos se la comen).
Medido con 7 entradas adversarias. Y **no importar `codeOnly` es una decisión documentada** (`CD-7`,
`sdd.md:414`): **no la marco como finding**, según la regla de respetar decisiones documentadas.

**Lo que sí es finding, en dos partes:**

**(a) La justificación nombra un solo arte previo, y hay un tercero que la contradice.** El docblock dice
que se re-escribió porque `codeOnly` *"lee disco"* y *"es Corte A y está fuera del scope"*. Pero
`test/scripts-imported-by-tests-are-tracked.test.ts:61` ya declara
`function stripComments(source: string): string` — **mismo nombre, misma semántica, función PURA sobre un
string** (o sea: **sin** el problema del disco) y **NO está en `CORTE_A_PATHS`** (`citations.ts:87-102`), o
sea **sin** el problema de scope. Ninguna de las dos razones escritas cubre a ese tercero, y el docblock no
lo menciona. Hoy el repo tiene **tres** limpiadores de comentarios JS/TS, **dos con el mismo nombre**, más
`codeOnly`.

**(b) «Quién manda si divergen» es prosa sin testigo.** El docblock resuelve el empate a favor del guard del
money-path. **Nada mecánico detecta la divergencia**: si mañana alguien arregla `codeOnly` para template
literals, `stripComments` se queda con el criterio viejo y todo sigue verde. Y el propio registro de esta HU
declara ese defecto por su nombre: `citations.ts:157-159` justifica la delegación de `_INDEX.md` diciendo que
re-verificar sería *"el duplicado exacto que `test/payment-guards-live-in-one-place.test.ts` existe para
prevenir: **dos criterios que coinciden el día que se escriben y divergen en la próxima corrección de
borde**"*. Es la frase que describe lo que el fix-pack acaba de hacer.

**(c) El «Límite, con esas palabras» de `scanner.ts:339-342` es de una sola dirección.** Dice que el único modo
de fallo es *"BORRAR de más … degradar hacia el rojo, que es el lado seguro"*. **Medido: hay una segunda
dirección, y es la insegura** — el comentario al final de una línea de código **sobrevive** (ver `MNR-cr-1`),
o sea que **borra de menos y degrada hacia el verde**. El docblock de `codeOnly` no comete ese error: dice
sólo *"las líneas que son SÓLO comentario"*, sin prometer la dirección.

**Impacto**: cero funcional hoy. Es deuda con la etiqueta puesta al revés: está declarada como
*"duplicación deliberada, con quién manda"* y en realidad es *"tres copias, una razón que no cubre a la
tercera, y un límite escrito en una sola dirección"*.
**Sugerencia**: nombrar el tercero en el docblock y corregir el párrafo de límite; o abrir la TD que lo
unifique. **No** proponer importar `codeOnly` — `CD-7` lo prohíbe.

---

### `MNR-cr-5` · dos imprecisiones en el desglose del ítem 14 recién re-derivado
**Categoría**: Test Coverage (prosa que es el entregable)
**Evidencia**: `test/cited-lines-guard.test.ts:183-190`

Los **seis números son exactos** (ver §4). Lo que no lo es:

1. *"y **5** son `.nexus/project-context.md:6`"* — derivado: hay **5 tokens que nombran ese archivo**, pero
   son **4 × `.nexus/project-context.md:6` + 1 × `.nexus/project-context.md:6-12`**. El conteo está bien;
   el token que lo nombra, no.
2. *"**21** son los fixtures en memoria de `G-C2`/`G-C3` (`a.ts:1`, `b.ts:2`, `foo.ts:42`, `./splash.tsx:245`),
   **que no existen ni pueden existir**"* — los 4 enumerados suman **12**. De los 9 restantes, **7 son
   `x.io:8443`**, que **no es un archivo**: es el host y el puerto de la URL de calibración, y la propia HU
   lo declara como *"ruido legítimo con path"* (`scanner.ts:240-245`, `G-C11:1439-1447`). Llamarlo «un
   archivo que no existe ni puede existir» es exactamente la clase de generalización que el re-AR ya corrigió
   una vez en este mismo párrafo (`MNR-4` de la it-1: *"de los 23, 2 no son fixtures"*).

**Impacto**: nulo hoy, pero es reincidencia en el mismo renglón, en una HU cuya tesis es que la prosa afirme
sólo lo medido. **Sugerencia**: separar los tres grupos del 26 (12 fixtures de path inexistente · 7 host:puerto
de la URL de calibración · 5 `.nexus/project-context.md` · 2 restantes), o dejar el 26 sin adjetivar.

---

# 4 · LOS NÚMEROS DEL FIX-PACK — RE-DERIVADOS, NO LEÍDOS

Todo con `tsx` llamando a `scanSource` / `citeNamesFile` / `citeTargetIfTracked` / `citeMatchesTarget`
directamente, y a `/usr/bin/git ls-files -z` vía `execFileSync` para el índice.

### El ítem 14 — **247, con los 4 sub-totales y la partición exacta**

| Afirmación (`test.ts:166-190`) | Medido en `ac4f4c3` | ✓ |
|---|---|---|
| **247** tokens | **247** | exacto |
| `test` **64** · `citations` **100** · `exceptions` **46** · `scanner` **37** | 64 · 100 · 46 · 37 | exacto |
| desglose **88 + 97 + 26 + 36** | 88 + 97 + 26 + 36 = **247** (partición exclusiva, sin solapes) | exacto |
| **9** son el token histórico `.gitignore:172` | **9** (`test.ts` ×4 · `citations.ts` ×1 · `scanner.ts` ×4) | exacto |

### El «igual que antes» — **re-derivado en `06758af`, no heredado**

En el commit padre: **243 = 87 + 97 + 23 + 36**. O sea el delta del fix-pack es
**`cite` +1 · sueltos +0 · fuera-del-índice +3 · trackeados +0**, que es literalmente lo que
`test.ts:201-205` declara (*"un `cite` ya declarado y tres del ejemplo que ilustra la segunda salida"*).

🎯 **El invariante que sostiene la decisión de `MNR-4`: el conteo de tokens que nombran archivo TRACKEADO
quedó en 36 — y no sólo el número: el mapa token→ocurrencias es IDÉNTICO entre los dos commits**, los 21
tokens con el mismo conteo cada uno. **Este fix-pack no agregó ni una afirmación nueva sin testigo.**
Confirmado.

### El 31 de 50 — **re-derivado**

`CITED_LINES.length` = **50** · `citeNamesFile` = **31** · sin archivo = **19**. Y las 31 resuelven **todas**
a un archivo del índice. Coincide con `exceptions.ts:64-68` y `test.ts:1127-1130`, que ahora traen **fecha
(2026-08-19) + la palabra FOTO + la receta de derivación** (`MNR-it2-5` cerrado, verificado).

### `MNR-it2-4` — la segunda salida, escrita en los dos lugares donde se lee

`exceptions.ts:29-68` y `test.ts:1107-1130`. Están la repro, la asimetría (`E-TARGET_MISSING` pone roja la
**misma** cita si se declara en `CITED_LINES`), el porqué de no leer el disco, y **el límite honesto**:
*"Población hoy dentro del Corte A: 0"*. **Y sí, nada la mantiene en 0** — el Dev lo declara en
`auto-blindaje.md:608-609` con esas palabras. Queda con nombre: `TD-316-CITAS-PROJECT-CONTEXT`. Verificado
también que `.nexus/project-context.md` **existe en disco y NO está en el índice** (`git ls-files
--error-unmatch` ⇒ *"Did you forget to 'git add'?"*), que es el supuesto del que depende el ejemplo.

---

# 5 · EL INVENTARIO DE `TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS` — CIERTO

| Afirmación (`auto-blindaje.md:543-566`) | Medido | ✓ |
|---|---|---|
| `test/**` con `readFileSync` = **16** | **16**, y los 16 nombres coinciden uno a uno con la tabla del `ar-report-it2.md` | exacto |
| `src/**/*.test.ts` con `readFileSync` = **31** | **31** | exacto |
| el defectuoso es `test/docs-referenced-by-code-exist.test.ts`, **sigue vacuo** | no aparece en `git diff --name-only 06758af..ac4f4c3` **ni en `main..ac4f4c3`**: **no se tocó**, tal como se declara | cierto |

**Las dos formas de arreglo, verificadas abriendo los archivos:**
1. **Recorte de cabecera** — `test/cited-lines-guard.test.ts:1318`:
   `const cabecera = self.slice(0, self.indexOf('\nimport {'));` ✅
2. **Excluirse del corpus por nombre** — `src/__tests__/discover-callsites.test.ts:126`:
   `const SELF = 'src/__tests__/discover-callsites.test.ts';`, aplicado en `:272`:
   `.filter((f) => f !== SELF)` ✅

**Las dos citas son exactas y las dos formas están bien descritas**, incluido el criterio de cuál conviene
(archivo que **es** su propio corpus vs. archivo que es **un elemento** de un corpus mayor).

---

# 6 · LAS 3 PUERTAS + EL DATO DEL `tsc` — RE-MEDIDAS

| Puerta | Declarado | Medido |
|---|---|---|
| `npm test` (`vitest run`) | 296 · 5781 · 5762 passed · 19 pending · 0 failed · `success: true` | **296 archivos · 5781 · 5762 · 19 · 0 failed · `success: true`**, y los **296** `testResults[*].name` **todos** bajo `/home/ferdev/.openclaw/workspace/wasiai-a2a/` — validado **adentro del JSON**, no por exit code |
| `tsc --noEmit` | 0 | **0** (exit 0, sin pipe) |
| `biome check src/` | 0 (489) | **0** — *"Checked 489 files in 168ms. No fixes applied."* |

### 🎯 El dato que el Dev re-verificó en vez de heredar — **CONFIRMADO**
`./node_modules/.bin/tsc --noEmit --listFiles` ⇒ **2505 archivos**, y
`grep -c "cited-lines-guard"` sobre esa salida ⇒ **0**. **La puerta verde de `tsc` no cubre ni un archivo de
esta HU** (`tsconfig.json:19` es `include: ["src/**/*"]`), y `biome` tampoco (`package.json:11` es
`biome check src/`, y el delta tiene **0 líneas en `src/`**).
Typechequeados aparte, los 4: `tsc --noEmit --ignoreConfig --strict --noUncheckedIndexedAccess --target es2022
--module nodenext --moduleResolution nodenext` ⇒ **exit 0, cero errores**.

---

# 7 · LAS CATEGORÍAS, SOBRE EL DELTA

| # | Categoría | Veredicto | Evidencia |
|---|---|---|---|
| 1 | Security | **N/A** | **0 líneas en `src/`**. Cero runtime, cero auth, cero input de red, cero secretos. Repo público: el delta no agrega ningún valor sensible |
| 2 | Error Handling | **OK** | `ruidoQueNombraArchivoTrackeado` (`test.ts:1132-1146`) es total: `hit === null ? [] : [...]`. `stripComments` no lanza sobre ninguna entrada (7 casos adversarios probados, incluido `/*` sin cierre) |
| 3 | Data Integrity | **N/A** | Sin DB, sin escrituras, sin concurrencia |
| 4 | Performance | **OK** | El delta agrega una segunda pasada sobre 127 entradas (3 reales + 124 canarios) en memoria. Suite completa: 296 archivos, sin regresión |
| 5 | Integration | **OK** | `stripComments` es export **nuevo** en `scanner.ts:344`; **único consumidor** `test.ts:241/392`. Ningún export existente cambió de firma. **Homónimo, no colisión**: `test/scripts-imported-by-tests-are-tracked.test.ts:61` es local a su archivo (ver `MNR-cr-4`) |
| 6 | Type Safety | **OK** | `--strict --noUncheckedIndexedAccess` sobre los 4 ⇒ **0**. El tipo del parámetro de `ruidoQueNombraArchivoTrackeado` (`readonly {from, cite}[]`) es el mínimo que el barrido necesita, y por eso los canarios sintéticos tipan sin `as` |
| 7 | Test Coverage | **MENOR** | `MNR-cr-1`, `MNR-cr-2`, `MNR-cr-3`, `MNR-cr-5` |
| 8 | Scope Drift | **OK** | 4 archivos, **0 en `src/`**, 0 configs, 0 README, 0 migraciones. `CD-7` respetado: `payment-guards-live-in-one-place.test.ts` **no se tocó** (no aparece en el diff) |
| 9 | Destructive Migrations | **N/A** | Cero `.sql` en el delta |
| 10 | RPC `SECURITY DEFINER` | **N/A** | Ninguna función Postgres |
| 11 | Cache Invalidation | **N/A** | El delta no introduce ni toca caches; `SRC_CACHE`/`SF_CACHE` son de `06758af` y ya los revisó `ar-report-it2.md` |

---

# 8 · INSTRUMENTOS Y LÍMITES — CON ESAS PALABRAS

**Instrumentos usados**: `/usr/bin/git` para **todo** git · `command grep -n` en todos los barridos ·
`git ls-files -z` vía `execFileSync` · `./node_modules/.bin/tsx` y `./node_modules/.bin/tsc` **por ruta
directa** · reporter JSON de vitest a `--outputFile`, **nunca redirigido** · `cd` al repo en cada corrida,
**nunca `--root`** · scratchpad en **directorio único** por PID.

**Instrumentos que fallaron, y cómo lo detecté**:
- **`npx tsx` se reescribió a `npm run tsx`** bajo el hook y devolvió *"Missing script"* con exit 1. Lo
  detecté porque el error no tenía nada que ver con mi script. Solución: **ruta directa al binario**.
- **`scanSource(file, src)` con los argumentos invertidos me devolvió 0 tokens en los 4 archivos** — un
  resultado que *parecía* un dato. Lo cacé porque **0 es imposible** para un archivo que declara 50 citas.
  Corregido a `scanSource(src, file)` y re-medido: 247. **Es exactamente la trampa de la herramienta que
  fabrica un hallazgo**; repetir la corrida no lo habría revelado.
- **El primer `CAL-1` dio 2 rojos (`G-C4`, `G-C7`) por culpa MÍA**, no del fix-pack: declaré ruido para un
  token que el escáner nunca encuentra en ese citador. Lo rehice escribiendo la URL en un archivo real del
  Corte A. **Reportar ese primer rojo habría sido un falso positivo.**
- **El primer `T-B` me dio `G-C11` en rojo** porque mi allowlist de basenames omitía `CLAUDE.md`, que
  `G-C11:1463` usa. Lo rehice fiel al exploit del re-AR: entonces **sólo `G-C8`** se pone rojo.
- El **aborto por ancla no única** del arnés disparó una vez (28 ocurrencias en `payment-spec-writer.ts`) y
  **restauró correctamente**. Funcionó como se pretendía.

**Lo que NO pude medir:**
- **No re-auditué la HU entera.** Los 4 BLOQUEANTEs de la it-1, los bordes de `citeTargetIfTracked`
  (`./`, `../`, sufijo por segmento, basename ambiguo, mayúsculas) y las 3 puertas del `06758af` los tomé de
  `ar-report-it2.md`. Lo único que re-medí de ese conjunto es lo que este delta toca.
- **No corrí la suite completa bajo cada mutante**: cada uno corrió sólo `test/cited-lines-guard.test.ts`.
  La suite completa (296) la corrí **una vez, sobre el árbol limpio**.
- **En `M-DEL` medí el diferencial sobre `G-C9`, no sobre el total**, porque mi variante deja `G-C4` rojo en
  los dos commits por un residuo propio del exploit (el token suelto `` `:922` ``). El resto de los mutantes
  sí se midió sobre el total.
- **No medí la VERDAD de la prosa nueva** más allá de sus números y sus anclas. Verifiqué los 6 números del
  ítem 14, el 31/50, el 16/31 del inventario y las 2 citas del `SELF`; **no** verifiqué que cada afirmación
  argumentativa del docblock sea correcta.
- **No barrí `doc/`, `scripts/`, `mcp-servers/` ni `packages/`** buscando más limpiadores de comentarios ni
  más controles auto-satisfactorios. Encontré el tercer `stripComments` con un `grep` de un solo símbolo;
  **fuera de `test/` y `src/` no sé si hay más**.
- **No probé el guardián en un clone fresco**, ni en CI.
- **No ejecuté nada contra producción**: cero red, cero Railway, cero Supabase, cero `pkill`, cero push.
  `main` en `b31ddba`, intacto.

**Estado del árbol al cerrar**: md5 de los 4 archivos del guardián **idénticos** al pre-registro ·
worktree creado, usado y **eliminado** (`git worktree list` sin la entrada) ·
`git status --porcelain` = **`?? doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md`** y nada más ·
ese archivo con md5 **`7904ef74a1c46d7880e0ca5d38e3eed4`**, el mismo del pre-registro. **No lo toqué.**

---

# 9 · LA DEUDA DECLARADA QUE QUEDA, CON SU NOMBRE

| Nombre | Estado tras este delta |
|---|---|
| `TD-224-CITAS-DEL-PROPIO-GUARDIAN` | **ABIERTA**. Los 247 tokens de los 4 archivos del guardián siguen sin testigo mecánico. El arreglo declarado (*un corte que distinga un token que AFIRMA de uno que es DATO*) sigue sin hacerse |
| `TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS` | **CERRADA con inventario** (16 + 31, verificados). **Deja atrás un archivo defectuoso con nombre y dueño**: `test/docs-referenced-by-code-exist.test.ts`, que **sigue vacuo en `main`** y quedó fuera del Scope IN |
| `TD-316-CITAS-DOTFILE-EN-OTROS-CORTES` | **ABIERTA** |
| `TD-316-CITAS-PROJECT-CONTEXT` | **ABIERTA**, y ahora es también el ejemplo escrito dentro del guardián (5 de los 26 tokens fuera del índice) |
| `MNR-it2-1` / `MNR-it2-2` | **NO entraron** (fuera de Scope IN, decisión correcta). Necesitan vehículo propio |

---

# 10 · ORDEN SUGERIDO PARA EL DEV — backlog, **no gate**

**Ningún BLOQUEANTE ⇒ nada de esto frena el merge.** Por retorno:

1. **`MNR-cr-1`** — la frase del costo de la delegación es falsa en el sentido peligroso. **Corregirla cuesta
   una línea**; borrar el comentario de final de línea cuesta más y hay que medirlo contra los `'https://…'`.
2. **`MNR-cr-2`** — canarios por `from`, mismo patrón que ya se usó para `reason`. Cierra un exploit del
   mismo costo que el que este fix-pack acaba de cerrar.
3. **`MNR-cr-3`** — un assert de armado del testigo, derivado, una línea.
4. **`MNR-cr-4`** — nombrar el tercer `stripComments` y corregir el párrafo de límite. **No** importar
   `codeOnly` (`CD-7`).
5. **`MNR-cr-5`** — separar los tres grupos del 26.

---

**Reportado por**: `nexus-adversary` (CR acotado al delta `06758af..ac4f4c3`)
**Fecha**: 2026-08-19
