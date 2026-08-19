# Work Item — [TD-316-CITAS-SIN-TESTIGO] Las citas `archivo:línea` que documentan invariantes de seguridad no tienen testigo

> **Número de HU (`WKH-NNN`): [NEEDS CLARIFICATION].** El encargo no lo dio y no lo invento.
> La deuda tiene identidad propia (`TD-316-CITAS-SIN-TESTIGO`, declarada en
> `doc/sdd/214-wkh-316-escritor-payment-block/auto-blindaje.md:624-698`) y este work-item se
> nombra con ella hasta que el founder asigne el `WKH-`.

> **CÓMO LEER ESTE DOCUMENTO.** Cada cita de acá abajo la abrí y la leí en esta sesión, salvo
> las que dicen **`[HEREDADO]`** (vienen de `auto-blindaje.md` y NO las re-derivé) y las que
> dicen **`[NO MEDIDO]`** (no tuve herramienta para medirlas). La distinción no es ceremonia:
> este work-item es sobre prosa que afirma de más, y sería absurdo abrirlo afirmando de más.

> ⚠️ **Límite de instrumento de este F1, declarado antes de cualquier número.** Esta sesión
> corrió **sin shell**: sólo `Read`, `Write` y `Glob`. No pude correr `git`, `grep`, `vitest`
> ni `npx`. Consecuencias concretas, todas verificables por quien siga:
> - **No pude derivar el universo de citas del repo.** Todo conteo global de acá lleva
>   `[HEREDADO]` o `[NO MEDIDO]`. El F2 tiene que derivarlo, y **CD-3** le dice con qué.
> - **No pude verificar el nombre de la rama con `git rev-parse --abbrev-ref HEAD`**, que es lo
>   que el encargo pide. La rama de abajo es una **propuesta**, no una medición: ver
>   «Branch sugerido».
> - Lo que **sí** pude hacer es abrir cada `archivo:línea` que cito y comparar con lo que la
>   prosa dice que hay ahí. Es exactamente la operación que esta HU quiere mecanizar.

---

## Resumen

El repo documenta sus invariantes de seguridad con punteros `archivo:línea` en comentarios,
docblocks, nombres de test y documentos de `doc/`. **Ningún mecanismo verifica que esos punteros
apunten a donde dicen.** Un puntero que se desplaza no rompe nada: manda al lector a otra función
del mismo archivo y, como el número equivocado suele contener el mismo texto que el correcto, el
que verifica **confirma la mentira**. Esta HU construye el testigo: extiende a las citas
`*.ts:N` el diseño que el repo ya tiene funcionando para un solo destino
(`CITED_INDEX_LINES` + el control `G-F2`), con la anti-vacuidad que ese exemplar todavía no
tiene y que el defecto medido exige: **la cita se ancla a su función contenedora, no a su texto**.

**Lo que NO es**: no es arreglar las 18 citas defectuosas. Arreglarlas hoy, a mano, sin el
guard, es fabricar más prosa no verificable (ver **Scope OUT**).

---

## Sizing

- **SDD_MODE**: `full`
- **Metodología**: **QUALITY**, y no por herencia. Lo evalué: (a) el objeto de la HU son las
  anotaciones de invariantes de **seguridad** (ownership/IDOR, guards del camino del dinero) de
  un repo **público** que **cobra x402** en Railway; (b) dos de las citas defectuosas medidas
  son **nombres de test**, que se imprimen en CI, así que el defecto tiene un lector humano en
  el peor momento posible; (c) el repo lo va a leer David, el mentor de la incubadora Solana.
  Un guard mal hecho acá es peor que no tenerlo: da verde sobre un invariante que no vigila.
- **Estimación**: **L**, y **hay que partirla**. Justificación abajo.
- **Corte de esta HU**: **Corte A — el mecanismo + un universo acotado por PATH.**
- **Branch sugerido**: `feat/224-citas-archivo-linea-sin-testigo`
  ⚠️ **`[NO MEDIDO]` — es una propuesta, no un hecho.** No pude correr
  `git rev-parse --abbrev-ref HEAD` ni `git branch --list`, así que **no afirmo que esta rama no
  exista ni que sea la rama activa**. Quien arranque F2/F3 **tiene que crearla y verificarla**.
  Esto es deliberado: el `_INDEX.md` ya tuvo una fila que nombraba una rama con un sufijo de más
  que existía, estaba en `main` y no tenía commits propios, así que quien verificaba confirmaba
  la mentira. **Una rama sin medir se declara sin medir.**

### Por qué L y por qué partida (el costo, con lo que se puede y no se puede medir hoy)

El costo de esta HU **no** es escribir el guard: es **declarar a mano el `mustContain` de cada
cita del universo que el guard barra**, porque un `G-F2` («cita nueva sin declarar = rojo»)
deja el guardián **rojo por definición** hasta que estén todas declaradas. O sea: el tamaño de
la HU lo fija el tamaño del universo barrido, y por eso el universo es una **decisión de
diseño** (DT-2) y no un descubrimiento.

Lo que se sabe del tamaño:

| Medición | Valor | Estado |
|---|---|---|
| Anclas en los 12 archivos del Scope IN de WKH-316 | **46 anclas en 40 líneas** | `[HEREDADO]` de `auto-blindaje.md:663-679`, declarado ahí mismo como **piso** |
| Citas defectuosas encontradas en ese solo radio | **18**, **0 cazables** | `[HEREDADO]` de `auto-blindaje.md:641-645` |
| Archivos `.ts` no-test de `src/` que barre el guard de ownership | **más de 150** | **Medido**: `test/ownership-filter-guard.test.ts:366` es `expect(SOURCE_FILES.length).toBeGreaterThan(150);`. Es un **piso que ese guardián se autoimpone**, no un censo del repo |
| Universo de citas de **todo** el repo | — | **`[NO MEDIDO]`**. Sin `grep` no lo puedo derivar |

La aritmética que decide el corte, dicha como estimación y no como medición: **46 anclas en 12
archivos** extrapolado a **más de 150** archivos de `src/` más `test/` más `doc/` da del orden de
**centenares**, y cada una hay que **leerla y declararla a mano**. Eso no entra en una HU, y una
HU que lo intente termina con un `mustContain` genérico copiado —que es el fracaso del archivo
aunque esté verde, exactamente lo que `G-10` castiga hoy en el guard de ownership
(`test/ownership-filter-guard.test.ts:651-655`: dos motivos iguales palabra por palabra = rojo)—.

⚠️ **Y el 46 no se puede reusar como base de la extrapolación sin antes reconciliarlo, por una
razón aritmética que encontré leyendo el propio párrafo que lo publica.** `auto-blindaje.md:663-666`
dice que `test/ownership-filter-guard.exceptions.ts` tiene **41 pares estructurados `{file,line}`
+ 14 anclas de prosa = 55**, y tres renglones después (`:666-667`) dice que el universo
re-derivado de los **12 archivos juntos** es **46 anclas en 40 líneas**. **46 < 55**, así que el
46 **no puede** incluir los 41 pares estructurados: son dos poblaciones distintas contadas con
instrumentos distintos, y el documento no lo dice. Sumado a que el 46 es explícitamente un
**piso** (el patrón de la forma corta busca entre backticks, y una cita en prosa suelta —«la
línea 95»— no la devuelve ningún patrón), queda: **el F2 no puede copiar el 46 ni el 55. Tiene
que derivar el universo del corte que elija, y declarar qué población está contando.**

---

## 🔴 Hallazgo de este F1 que CONTRADICE el encargo, y cambia por dónde se empieza

El encargo dice: *«`test/ownership-filter-guard.exceptions.ts` solo: **41 pares `{file,line}`**
+ 14 anclas de prosa — más que cualquier otro archivo»*, y de ahí se sigue que sería el lugar
natural por donde arrancar. **Lo medí abriendo el guardián que consume ese archivo, y los 41
pares estructurados YA TIENEN TESTIGO, con precisión de línea, en las dos direcciones.**

Medido en `test/ownership-filter-guard.test.ts`:

1. **La clave del match ES `archivo:línea`** — `:317-320`:
   ```ts
   const key = (file: string, line: number): string => `${file}:${line}`;
   const EXCEPTED = new Set(OWNERSHIP_FILTER_EXCEPTIONS.map((e) => key(e.file, e.line)));
   ```
2. **`G-08`** (`:594-611`) — una cadena sin filtro cuyo `archivo:línea` no está exceptuado =
   **rojo**. El cruce vive en `:597`
   (`const orphans = UNFILTERED.filter((c) => !EXCEPTED.has(key(c.file, c.line)));`) y el assert
   que lo publica en `:598-610`.
3. **`G-09`** (`:613-631`, «ninguna excepción sobrevive a su sitio») — una excepción cuyo
   `archivo:línea` ya no es una cadena sin filtro = **rojo**, y su propio mensaje de error nombra
   el caso de esta HU con esas palabras: *«Hay excepciones cuyo sitio ya no es una cadena sin
   filtro de dueño: o la consulta **se movió de línea**, o desapareció, o alguien le puso el
   filtro»* (`:623-624`). Además tiene su control anti-vacuidad y un invariante estricto:
   `expect(UNFILTERED.length).toBe(OWNERSHIP_FILTER_EXCEPTIONS.length)` (`:630`).
4. **`G-10`** (`:660-684`) — cruza `table`/`verb` de la entrada contra la cadena **real** que hay
   en ese `archivo:línea`. Eso es, funcionalmente, un `mustContain` **semántico** ya
   implementado, y su docblock explica por qué hizo falta: antes la clave era sólo
   `archivo:línea` y *«una entrada podía decir `table:'registries', verb:'delete'` sobre un
   `select` a `a2a_receipts` y todo seguía verde»* (`:661-665`).

**Consecuencias, que son de diseño y no cosméticas:**

- **`ownership-filter-guard.exceptions.ts` es el archivo MEJOR protegido del repo en esta
  clase, no el peor.** Los 41 pares no van al universo de esta HU.
- **Lo que en ese archivo sigue sin testigo son sus anclas de PROSA**, y verifiqué una a mano
  como muestra: su docblock `:23-26` afirma que CI no lo typechequea ni lo lintea citando
  `tsconfig.json:19` y `package.json:11`. **Abrí `package.json:11` y dice exactamente
  `"lint": "biome check src/"`** — la cita es **exacta**, y la conclusión también: `test/` no
  se lintea. (`tsconfig.json:19` no lo abrí: `[NO MEDIDO]`.)
- **`CD-1` sale de acá**: el guard nuevo **no debe re-cubrir** lo que `G-08`/`G-09`/`G-10` ya
  cubren. Dos guardianes que verifican lo mismo por caminos distintos es la falla que
  `test/payment-guards-live-in-one-place.test.ts:9-14` existe para prevenir, escrita ahí con
  todas las letras: los dos criterios coinciden el día que se escriben y **divergen después**.

---

## Acceptance Criteria (EARS)

> Nomenclatura de controles: `G-C1..G-C9` (C de *cita*), para no colisionar con los `G-01..G-13`
> de `ownership-filter-guard` ni con los `G-A..G-G`/`G-F1`/`G-F2` de `sdd-index-matches-folders`.

- **AC-1** — *Event-driven.* **WHEN** un archivo dentro del universo declarado (DT-2) contiene una
  cita `archivo:N` y esa cita **no** está declarada en el registro de citas, **the system SHALL**
  poner `npm test` en rojo nombrando el archivo citador, su línea y la cita sin declarar.
  *(Es el `G-F2` de esta HU: el control que cierra la CLASE. Sin él esto es una foto.)*

- **AC-2** — *Event-driven.* **WHEN** la línea citada deja de contener alguno de los textos que su
  declaración exige (`mustContain`), **the system SHALL** poner `npm test` en rojo nombrando la
  cita, el texto esperado y la razón probable (se corrió el archivo).

- **AC-3** — *Unwanted.* **IF** el `mustContain` declarado de una cita matchea **más de una línea**
  del archivo citado, **THEN the system SHALL** poner `npm test` en rojo, porque esa declaración
  no puede distinguir la línea correcta de la equivocada.
  *(Éste es el AC central y el que no existe en el exemplar. Razón medida, `[HEREDADO]` de
  `auto-blindaje.md:682-684`: las dos veces que una cita rota mandó a otra función del mismo
  archivo, **el número equivocado contenía el texto buscado**, así que abrir la línea y comparar
  daba OK. Un `mustContain` que aparece 6 o 9 veces en el archivo es una declaración vacua que
  pasa en verde. La anti-vacuidad es la unicidad, y es mecánicamente verificable.)*

- **AC-4** — *Ubiquitous.* La declaración de cada cita **SHALL** identificar la **función o símbolo
  contenedor** de la línea citada, y el guardián **SHALL** ponerse rojo si la línea citada dejó de
  caer dentro de ese contenedor, incluso cuando el `mustContain` siga matcheando.
  *(Lo que se compara es la FUNCIÓN CONTENEDORA, no el texto. El caso que lo obliga, `[HEREDADO]`
  de `auto-blindaje.md:609-612`: un docblock citaba `compose.ts:130` y el guard vivía en
  `src/services/compose.ts:571`.)*

- **AC-5** — *Unwanted.* **IF** una cita nombra un archivo que **no existe** o una línea **fuera del
  rango** del archivo, **THEN the system SHALL** poner `npm test` en rojo distinguiendo ese caso
  del de AC-2 en el mensaje.
  *(Un cero no es una ausencia: `[HEREDADO]` de `auto-blindaje.md:612`, `grep 'i > 0'
  src/routes/compose.ts` da **cero** porque **el archivo citado también estaba mal**, y un cero
  sin control positivo se lee como «ya no está».)*

- **AC-6** — *Ubiquitous.* El universo de archivos citadores **SHALL** derivarse del **índice de
  git** en cada corrida, y el guardián **SHALL** ponerse rojo si el universo derivado queda
  vacío o por debajo de un piso declarado.
  *(El exemplar ya deriva así, `test/sdd-index-matches-folders.test.ts:421-428`, y el guard de
  ownership documenta la consecuencia exacta de no tener el piso: `:325-327`, «Sin estos, un
  parser roto deja las listas vacías y G-08 pasa en verde sin verificar nada». Un piso no alcanza
  contra un universo **sesgado** —eso está medido en `:329-337`— y por eso AC-7.)*

- **AC-7** — *Ubiquitous.* El guardián **SHALL** incluir controles de armado que se pongan rojos
  ante un escáner que **no reporte nunca** y ante uno que **reporte siempre**, sobre fixtures en
  memoria con la respuesta conocida de antemano.
  *(El patrón ya existe y se copia sin inventar nada: `G-03`/`G-04` en
  `test/ownership-filter-guard.test.ts:482-511`, con su razón en `:470-475`: «el único test del
  escáner sería lo que el escáner encuentra hoy, que es un instrumento comparándose contra su
  propia salida».)*

- **AC-8** — *Event-driven.* **WHEN** el registro de citas contiene una entrada cuyo sitio citador
  ya no existe (el comentario se borró), **the system SHALL** poner `npm test` en rojo.
  *(Simétrico de `G-09`. Una lista que se pudre va perdiendo alcance sin avisar,
  `test/ownership-filter-guard.test.ts:614-616`.)*

- **AC-9** — *Optional / state-driven.* **WHERE** una cita no se puede anclar mecánicamente (prosa
  suelta del tipo «la línea 95», sin backticks ni nombre de archivo), **the system SHALL** exigir
  una **excepción escrita a mano con su motivo**, y **SHALL** rechazar en runtime toda excepción
  con motivo vacío, demasiado corto, o **idéntico palabra por palabra a otro**.
  *(Los tres criterios están tomados de `G-10`, `test/ownership-filter-guard.test.ts:633-659`;
  el de motivos duplicados es `:651-655`.)*

- **AC-10** — *Ubiquitous.* El corte **SHALL** dejar declarado por escrito, en el propio docblock del
  guardián, **qué NO cubre**, con al menos: las citas en archivos **no trackeados por git**, las
  citas en **prosa suelta**, y el **VALOR** semántico de la afirmación que rodea a la cita.
  *(Es el punto que hace utilizable al guard de ownership: su docblock `:53-131` declara 10
  huecos. Un guardián sin esa lista se lee como cobertura total.)*

- **AC-11** — *Event-driven.* **WHEN** el barrido del universo se ejecute, **the system SHALL** buscar
  las citas con los **tres** patrones —con ruta (`src/services/agent.ts:721`), sin directorio
  (`agent.ts:721`) y sólo línea (`` `:692` ``)— y **SHALL** aceptar el prefijo `./`.
  *(Ésta es la causa raíz medida de que fueran cuatro rondas del mismo defecto, `[HEREDADO]` de
  `auto-blindaje.md:646-649`: la cuarta ronda apareció sólo al enumerar todos los tokens
  `:[0-9]+`, no al grepear `agent\.ts:[0-9]`. Ni el barrido usado ni el declarado «correcto»
  encontraban las citas cortas. El `./` está por un caso de otro repo donde un patrón perdió
  justo `flow.tsx:1839 → ./splash.tsx:245`.)*

- **AC-12** — *Unwanted.* **IF** el guardián nuevo verifica una propiedad que `G-08`, `G-09` o `G-10`
  de `test/ownership-filter-guard.test.ts` ya verifican, **THEN** el diseño **SHALL** rechazarse en
  el SDD antes de escribir código. *(Ver CD-1 y el hallazgo de más arriba.)*

> **`[TBD → F2]`** El piso numérico de AC-6, la nomenclatura final de los controles y el formato
> exacto del registro (un archivo `*.citations.ts` por universo, o uno solo) los fija el SDD.
> No los invento acá.

---

## Scope IN

**Archivos nuevos (el mecanismo):**
- `test/cited-lines-guard.test.ts` — el guardián (`G-C1..G-C9`).
- `test/cited-lines-guard.scanner.ts` — el escáner: derivación del universo + los tres patrones
  de AC-11 + resolución del símbolo contenedor (AC-4). Separado del test **a propósito**, por el
  mismo motivo que `ownership-filter-guard.scanner.ts` está separado: el oráculo no puede vivir
  en el módulo que vigila (`test/ownership-filter-guard.test.ts:176-180`).
- `test/cited-lines-guard.citations.ts` — el registro `{from, fromLine, target, line, mustContain,
  inSymbol}` **escrito a mano**.
- `test/cited-lines-guard.exceptions.ts` — las citas no anclables, con motivo (AC-9).

**Universo barrido por el Corte A** — la lista exacta la fija el SDD; el **criterio** es DT-2, y el
punto de partida son los **12 archivos del Scope IN de WKH-316** (`[HEREDADO]`,
`auto-blindaje.md:663-675`), **menos** los pares estructurados que `G-08`/`G-09`/`G-10` ya cubren.

**Las 6 citas pre-existentes falsas ya tabuladas** en `auto-blindaje.md:609-612` — se declaran
y se corrigen **dentro** del registro, no antes de él:
- `src/routes/agents.ts:47` → el ancla real es `src/routes/registries.ts:94`.
- `src/types/index.ts:207` → `downstream-payment.ts:922`.
- `src/types/index.ts:510` → `src/services/reputation.ts:189`.
- `src/types/index.ts:1450` → `src/services/compose.ts:571` (**el archivo citado también está mal**).
- Las otras dos, con su ancla, en `auto-blindaje.md:583-599` y `:609-612`.
  ⚠️ **Los 8 números de esta lista son `[HEREDADO]`: NO los re-derivé.** **CD-4** obliga a
  re-abrir cada uno en F2/F3 antes de escribirlo en el registro. Copiarlos de acá sin abrirlos
  es cometer, dentro de la HU que arregla el defecto, exactamente el defecto.

**Artefactos de proceso:**
- `doc/sdd/224-citas-archivo-linea-sin-testigo/` — SDD, story file, reportes.
- `doc/sdd/_INDEX.md` — la fila de esta HU, **al final de la tabla** (ver CD-5).

---

## Scope OUT

- ⛔ **Tocar `codeOnly`** (`test/payment-guards-live-in-one-place.test.ts:45-55`) para que mire
  comentarios. Verificado en esta sesión: `:45` es `function codeOnly(file: string): string {`,
  `:48` es `.replace(/\/\*[\s\S]*?\*\//g, '')` y `:50-53` el `filter` que saca las líneas que
  arrancan con `//`, `*` o `/*`. **Y tiene que hacerlo**: su docblock `:16-20` explica que sin eso
  el `x402` de `routes/agents.ts:66` y el `getInitializedChainKeys()` de `:124` darían falso
  positivo. Ese guardián **no es el bug: es la razón por la que el agujero existe**, y romperlo
  cambia un agujero de documentación por un agujero en un guard del camino del dinero.
- ⛔ **Arreglar las 18 citas defectuosas sin construir el guard primero.** El guard es lo que
  obliga a enumerarlas; arreglarlas a mano hoy es fabricar más prosa no verificable.
- ⛔ **Los otros dos repos** (`wasiai-remittance-agents`, `chaski-v3`) — ver DT-5.
- ⛔ **`m5-keys/`**.
- ⛔ **Los 41 pares `{file,line}` de `test/ownership-filter-guard.exceptions.ts`** — ya tienen
  testigo (hallazgo de arriba). Sus **anclas de prosa** sí son candidatas, en el corte que las
  incluya.
- ⛔ **Los `supabase.rpc(...)`**, RLS real (WKH-SEC-02) y cualquier cosa del camino del dinero:
  esta HU **no toca una línea de `src/` de producción** salvo **corregir el número de una cita
  dentro de un comentario** (CD-2).
- **Fuera de este corte, explícitamente diferido** (no es «no importa», es «no entra»):
  - `.nexus/project-context.md`, que está **lleno** de citas `archivo:línea` y cuyo encabezado
    (`:6-12`) **le pide al lector abrirlas y verificar** — o sea, el consumidor más expuesto del
    defecto. `[NO MEDIDO]`: no verifiqué si está trackeado por git.
  - `CLAUDE.md` y los `doc/**/*.md` trackeados.
  - `doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md`: **untracked a propósito, de otra HU,
    NO SE TOCA** (y por AC-6 queda fuera del universo por construcción, lo cual es la respuesta
    correcta y hay que declararla).

---

## Decisiones técnicas (DT-N)

- **DT-1 — Se EXTIENDE el diseño existente; no se inventa uno.**
  Verificado en esta sesión: `test/sdd-index-matches-folders.exceptions.ts:160-167` define
  `CitedIndexLine = { from, line, mustContain }`; `:181-192` es `CITED_INDEX_LINES` con **2**
  entradas; `:172-179` explica las dos propiedades que importan —el `mustContain` va **a mano**
  porque *«es una afirmación sobre el mundo, no una lectura del mundo»*, y el **universo sí se
  deriva**—; `G-F1` es `test/sdd-index-matches-folders.test.ts:398` y **`G-F2` es `:420`**
  (verificado: el `it(` de `:420` es *«toda cita `_INDEX.md:N` que haga src/ está declarada (el
  universo se deriva)»*). Hoy cubre **un** destino (`doc/sdd/_INDEX.md:N`) y **un** origen
  (`src/`, patrón `/doc\/sdd\/_INDEX\.md:(\d+)/g` en `:433`).
  ⇒ La HU generaliza **destino** (`*.ts:N`) y **origen**, y agrega la anti-vacuidad de AC-3/AC-4
  que el exemplar no tiene.

- **DT-2 — El universo se acota por PATH explícito, no por una válvula de escape.**
  El problema de sizing: `G-F2` deja el guardián rojo hasta que **toda** cita del universo esté
  declarada. Hay tres formas de que eso entre en una HU y elijo la primera:
  1. ✅ **Acotar el universo a una lista explícita de paths**, y ampliarla en cortes siguientes.
     Determinista, sin dependencia del estado de git más allá del índice, y cada ampliación se
     pone roja hasta que se declare — la función forzante se conserva, de a bocado.
  2. ❌ **Barrer todo y permitir un «pendiente» con techo decreciente.** Rechazada: un techo
     **acota la tasa, no cierra el camino** —es literalmente el acotamiento que
     `auto-blindaje.md:689-694` declara insuficiente— y además el techo se vuelve el lugar donde
     se esconde la cita nueva.
  3. ❌ **Barrer sólo los archivos que toca el diff.** Rechazada por instrumento: haría depender
     el verde de `git diff`, y en este entorno **`git diff` bajo el hook de `rtk` trunca con
     exit 0** (medido: 3250 líneas → 532, cortando hunks). Un guardián cuyo universo puede
     truncarse en silencio es peor que ninguno.
  ⚠️ **El SDD tiene que declarar la lista de paths del Corte A y el criterio para ampliarla**, y
  esa lista **es** el contrato de tamaño de la HU.

- **DT-3 — La anti-vacuidad es la UNICIDAD del `mustContain`, y es mecánica (AC-3).**
  Un `mustContain` que matchea varias líneas no distingue la correcta de la incorrecta. Esto
  convierte «hay que comparar la función contenedora y no el texto» de una recomendación de
  prosa en un **rojo automático**, y es lo que impide que el registro nazca lleno de
  declaraciones que pasan por casualidad. Corolario que conviene volver convención: **la cita
  ideal apunta a la línea de la FIRMA** de la función —el único ancla que se verifica sin
  ambigüedad y que un lector puede re-derivar grepeando el nombre—, criterio que esta HU no
  inventa: es la conclusión de `auto-blindaje.md:592-595`.

- **DT-4 — El registro y las excepciones se validan en RUNTIME, no por tipo.**
  Medido en esta sesión: **`package.json:11` es `"lint": "biome check src/"`**, así que nada de
  `test/` se lintea; el docblock de `test/ownership-filter-guard.exceptions.ts:23-26` afirma lo
  mismo del typecheck citando `tsconfig.json:19` (`[NO MEDIDO]` por mí). ⇒ Un `mustContain: []`
  o un campo inventado **compila en el editor, no rompe CI y entra al repo**. El patrón correcto
  ya existe: `G-10`, `test/ownership-filter-guard.test.ts:633-659`.

- **DT-5 — Alcance: SÓLO `wasiai-a2a`. La portabilidad es otra HU.**
  Coincido con la inclinación del encargo, y el motivo es medible en este repo, no una preferencia:
  el universo de AC-6 se deriva del **índice de git**, y **`doc/` acá viaja sólo en parte**.
  Verificado: `.gitignore:183-193` lista archivos `doc/sdd/**` individuales —entre otros
  `/doc/sdd/003-supabase-registries/sdd.md`, `/doc/sdd/084-.../work-item.md` y cuatro de
  `/doc/sdd/149-.../`— y `:165-182` hace lo mismo con `doc/investor`, `doc/investors`,
  `doc/migration`, `doc/operations` y `doc/runbooks`. O sea que **la afirmación «`doc/` sí viaja
  en este repo» es cierta a medias**, y la mitad que no viaja es invisible para el guardián
  **para siempre** (eso va en AC-10, no se «arregla»). En `wasiai-remittance-agents` **todo
  `doc/` está gitignoreado** ⇒ un guard portable tendría tres universos incompatibles y **no
  cerraría ninguno**. Cerrar `wasiai-a2a` primero produce el exemplar; portarlo después es una HU
  con un diseño ya probado.
  ⇒ **HU de seguimiento**: `TD-316-CITAS-PORTABILIDAD`, con la condición de entrada explícita de
  que en los repos con `doc/` ignorado el universo **no puede** incluir `doc/`.

- **DT-6 — El defecto es sistémico y eso va escrito en el guardián, no en un reporte.**
  Tres repos, `[HEREDADO]` del encargo: `wasiai-a2a` (4 rondas), `wasiai-remittance-agents`
  (7 citas en un reporte, 6 mal, *«cité de memoria, y después les inserté 20-60 líneas de
  comentario a cada uno»*), `chaski-v3` (2 rotas por la propia inserción + 1 prevista). El
  mecanismo común no es descuido: es **la edición que desplaza sin re-abrir**. El docblock del
  guardián tiene que decirlo, porque es lo que explica por qué el control existe.

---

## Constraint Directives (CD-N)

- **CD-1 — PROHIBIDO** que el guardián nuevo re-verifique lo que `G-08`, `G-09` o `G-10` de
  `test/ownership-filter-guard.test.ts` ya verifican (los pares `{file,line}` de
  `ownership-filter-guard.exceptions.ts`). Dos guardianes con el mismo criterio coinciden hoy y
  **divergen después**: el motivo está escrito en
  `test/payment-guards-live-in-one-place.test.ts:9-14`. Si el SDD los solapa, **BLOQUEANTE**.

- **CD-2 — PROHIBIDO** tocar lógica de producción. El único cambio admisible en `src/` es
  **corregir el número o el archivo de una cita dentro de un comentario**. Criterio de
  verificación, no de intención: el diff sobre `src/` sólo puede contener líneas de comentario y
  archivos `*.test.ts` / `test/`. Es el mismo `CD-1` que ya usaron WKH-SEC-03 y WKH-SEC-04.

- **CD-3 — OBLIGATORIO** usar los instrumentos no corruptos, porque acá un cero falso no es un
  detalle: es **el modo de falla central de esta HU**.
  `git` → **`/usr/bin/git`** (bajo el hook de `rtk`, `git diff` **trunca con exit 0**;
  `git ls-files` devuelve **vacío** —usar `rtk proxy git ls-files`—; `git log --oneline` **borra
  los commits de merge**) · `grep` → **`command grep -n`** (bajo el hook devuelve conteos en vez
  de rutas) · **`cat` corrompe** al redirigirse · `npx vitest run > archivo` **trunca a 500 chars
  con exit 0** · **los exit codes no sobreviven un pipe** · biome →
  **`./node_modules/.bin/biome`**.
  **Y la regla que las engloba: ante un CERO, control positivo antes de creerle.** Un cero de un
  instrumento truncado es indistinguible de «no hay nada», y ésta es la HU donde eso se paga
  doble.

- **CD-4 — PROHIBIDO** escribir en el registro un `archivo:línea` que no se haya **abierto y
  leído** en esta HU. Incluye los 8 números heredados del Scope IN y **cualquier número copiado
  de este work-item**. Ni un solo `mustContain` puede salir de un documento; todos salen de leer
  el archivo. Violación = **BLOQUEANTE** en AR.

- **CD-5 — OBLIGATORIO**: la fila de esta HU en `doc/sdd/_INDEX.md` va **al FINAL de la tabla**.
  Motivo medido: `src/lib/capability-risk.ts` y `src/lib/capability-risk.test.ts` citan
  `doc/sdd/_INDEX.md:144`, y esa cita está **verificada por `G-F1`** con
  `mustContain: ['remit.corridor-discovery', 'kyc-check', 'cashout-match']`
  (`test/sdd-index-matches-folders.exceptions.ts:181-192`). Mover cualquier línea por encima de
  la 144 la rompe, y es **código del camino del dinero** (`_INDEX.md:245-253`). Insertar al final
  no desplaza la 144.

- **CD-6 — PROHIBIDO** volcar la salida del escáner al registro o a las excepciones. Se escriben
  **a mano, entrada por entrada, leyendo el sitio**. Motivo, ya escrito en el repo y con
  precedente: *«un artefacto derivado de la misma medición que consume deja el control verde por
  construcción y no mide nada. Ya pasó en este repo (WKH-322, `T-U7`: un test iteraba la
  allowlist exportada para afirmar que “todas están permitidas”)»*
  (`test/ownership-filter-guard.exceptions.ts:5-11`). La salida del escáner sirve de
  **checklist de qué mirar**, nada más.

- **CD-7 — PROHIBIDO** tocar `codeOnly` ni ningún assert de
  `test/payment-guards-live-in-one-place.test.ts`. Ver Scope OUT.

- **CD-8 — PROHIBIDO** presentar el verde del guardián como «las citas del repo son correctas».
  El corte cubre el universo de DT-2 y nada más. Todo reporte de esta HU **SHALL** decir qué
  fracción del repo quedó fuera, y **no puede** usar el 46 heredado como si fuera un total (es
  un **piso**, `auto-blindaje.md:678-679`, y además cuenta otra población que el 55 — ver Sizing).

- **CD-9 — OBLIGATORIO** no tocar
  `doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md` (untracked a propósito, otra HU,
  md5 `7904ef74a1c46d7880e0ca5d38e3eed4`).

---

## Missing Inputs

- **`[bloqueante para el `_INDEX.md` definitivo]`** El número `WKH-` de esta HU. No lo invento.
  Mientras no exista, la fila y la carpeta usan `TD-316-CITAS-SIN-TESTIGO`.
- **`[resuelto en F2]`** La lista exacta de paths del universo del Corte A (DT-2) y el piso
  numérico de AC-6.
- **`[resuelto en F2]`** El formato del registro: un archivo por universo o uno solo; y si
  `inSymbol` (AC-4) se resuelve con un escáner propio o exigiendo que el `mustContain` incluya la
  firma (que sería la variante barata de DT-3 y podría hacer innecesario el escáner de símbolos).
- **`[resuelto en F2/F3, obligatorio por CD-4]`** Re-derivar el universo con los tres patrones de
  AC-11 y **re-abrir** las 6 citas falsas heredadas. **Nada de esto lo pude medir en este F1**:
  sin shell, no hay barrido posible.
- **`[NEEDS CLARIFICATION]`** ¿`.nexus/project-context.md` y `CLAUDE.md` entran en el Corte A?
  Argumento a favor medido: `project-context.md:6-12` le **pide** al lector abrir las citas y
  verificar, y `CLAUDE.md` ya tuvo una lista a mano que envejeció mal. Argumento en contra:
  agrandan el universo y con él el tamaño de la HU. **Mi recomendación: fuera del Corte A, y
  primer candidato del Corte B.**
- **`[NEEDS CLARIFICATION]`** ¿El repo acepta que este guardián nazca cubriendo **poco** y
  explícito, en vez de mucho y con techo? DT-2 asume que sí.

---

## Análisis de paralelismo

- **No bloquea ninguna HU y ninguna la bloquea.** Por CD-2 no toca producción: es `test/` más
  números de cita dentro de comentarios.
- **Puede ir en paralelo con cualquier HU de feature**, con un roce conocido y sin misterio:
  cualquier HU que **cambie el largo** de un archivo del universo declarado va a poner **rojo**
  este guardián. **Eso no es un conflicto, es la HU funcionando** — y es exactamente el
  disparador 2 de la deuda (`auto-blindaje.md:685-686`: la próxima HU que cambie el largo de
  `src/services/agent.ts` o `src/routes/agents.ts`, los dos archivos con más citas entrantes).
  Consecuencia operativa que el SDD debe declarar: el mensaje de error tiene que decir **cómo
  re-apuntar** la cita, no sólo que está mal, porque el que lo va a leer es alguien que estaba
  haciendo otra cosa.
- **Conflicto de merge real y acotado**: `doc/sdd/_INDEX.md` (una fila al final) y, si otra HU
  toca los mismos comentarios, los archivos del universo. Bajo, y CD-5 lo minimiza.
- **Serialización obligatoria**: `TD-316-CITAS-PORTABILIDAD` (DT-5) va **después**, y los cortes
  B/C del universo también — cada uno depende del mecanismo de éste.
- **Recomendación**: correrla **sola o casi sola**, no por riesgo técnico sino porque su costo
  real es lectura humana de citas una por una (CD-4/CD-6), y eso compite por la misma atención
  que cualquier revisión que esté abierta en paralelo.
