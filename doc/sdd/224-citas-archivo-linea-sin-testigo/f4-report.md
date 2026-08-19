# F4 · Validación QA — HU 224 · WKH-362 · el guardián de citas

**Fecha**: 2026-08-19
**Rama**: `feat/224-citas-archivo-linea-sin-testigo` · **HEAD** `9b6780a` · **base** `main` = `b31ddba`
**Rol**: nexus-qa (F4), independiente de AR/CR/DONE
**Modo**: DENSO — hay un hallazgo de drift documental que nombro abajo (§4.2)

## VEREDICTO: **APROBADO**

Los 12 ACs están en **PASS con evidencia mecánica**: para 8 de ellos ejecuté una **mutación que produjo el
rojo prometido** y restauré el árbol con md5 verificado. El hallazgo de §4.2 es **deuda documental en
artefactos inmutables**, no afecta ningún AC, ninguna línea de `src/`, ni el despliegue. **Mergeable.**

Este reporte existe porque el cierre declaró su propia ausencia: *"NO hay `validation.md` — la fase F4/QA
nunca produjo artefacto"*. Los 12 controles verdes **no eran** evidencia AC por AC; ahora lo son.

---

## 0 · Método, y por qué no repito al AR ni al CR

No re-ejecuté los exploits del AR/CR (los 4 bloqueantes, los 3 exploits replicados, el 31/19, los bordes de
`citeTargetIfTracked`, el inventario 16+31). Lo que hice es lo que **nadie más hizo**: cruzar cada AC con un
control que **se pueda poner rojo**, y **ponerlo rojo**.

**Protocolo de mutación** (`scratchpad/f4-224/mutate.mjs`), aplicado en las 9 mutaciones:
1. md5 pre-registrado + copia propia fuera del repo.
2. **Aborta si el ancla no aparece exactamente N veces** (se activó de verdad una vez: ancla con 2
   ocurrencias ⇒ no se mutó nada).
3. Corre sólo `test/cited-lines-guard.test.ts` con reporter JSON.
4. **Valida la raíz `/wasiai-a2a/` DENTRO del JSON** (`testResults[0].name`), nunca el exit code.
5. **Restaura desde la copia** (nunca `git checkout --`) y **compara md5 contra el pre-registro**.

Estado final del árbol: `git status --porcelain` = **sólo** el untracked de la HU 212, md5
`7904ef74a1c46d7880e0ca5d38e3eed4` — **idéntico al pre-registro**. No lo toqué.

---

## 1 · LOS 12 ACs, uno por uno

`test.ts` = `test/cited-lines-guard.test.ts`. "ROJO medido" = mutación ejecutada, rojo obtenido, árbol restaurado.

| AC | Control | Status | Evidencia `archivo:línea` |
|---|---|---|---|
| **AC-1** cita no declarada ⇒ rojo | `G-C4` | ✅ **PASS** | **ROJO medido**: agregué `src/services/agent.ts:721` a `src/lib/payment-spec-writer.ts` (Corte A, declarado con CERO citas). G-C4 rojo en `test.ts:966`. El mensaje nombra **citador, línea, forma y cita**: `src/lib/payment-spec-writer.ts:3 · P1 · src/services/agent.ts:721` — exactamente los tres datos que el AC exige. De paso valida la promesa de `citations.ts:83-85` ("la primera cita que alguien escriba ahí nace declarada o nace roja") |
| **AC-2** el ancla se movió ⇒ rojo | `G-C5` | ✅ **PASS** | **ROJO medido**: `mustContain` del entry `:922` → texto inexistente. `E-ANCHOR_GONE` en `test.ts:1010`. El mensaje da cita, texto esperado y razón probable, y **avisa de releer la prosa** además del número |
| **AC-3** `mustContain` único | `G-C5` / `E-NEEDLE_VACUOUS` | ✅ **PASS** | **ROJO medido**: `mustContain: ['const ']` → listó las **19 líneas** que matchean en el target y la escalera de arreglo de 3 pasos. Lógica en `test.ts:566-578` |
| **AC-4** símbolo contenedor | `G-C6` (+`G-C3`) | ✅ **PASS** | **ROJO medido**: `symbolPath: ['validatePayTo']` → **G-C6 Y G-C5** rojos. Causa verificada en código: `locate()` es **symbol-scoped** (`test.ts:563`), así que un contenedor equivocado invalida el match aunque el texto siga estando. El AC pide rojo "incluso cuando el `mustContain` siga matcheando" — se cumple con doble red |
| **AC-5** archivo inexistente / línea fuera de rango | `G-C5` | ✅ **PASS** | **ROJO medido ×2**, y los dos mensajes se distinguen del de AC-2 como el AC exige: `line: 999999` → `E-LINE_OUT_OF_RANGE` ("el archivo tiene 1038 líneas", `test.ts:551-562`); `target` inexistente → `E-TARGET_MISSING` ("un cero de grep NO significa «el ancla desapareció»", `test.ts:525-536`) |
| **AC-6** universo del índice de git | `G-C1` | ✅ **PASS** | Derivación en `test.ts:271-278` (`git ls-files -z`, **índice** no disco). **ROJO medido**: borré 5 paths de `CORTE_A_PATHS` → `expected 9 to be 14` en `test.ts:715`. Pisos: `TRACKED.length > 500`, `FOUND.length >= 40` (`test.ts:728`), `faltantes` contra el índice, sin duplicados |
| **AC-7** controles de armado | `G-C1`+`G-C2`+`G-C3` | ✅ **PASS** | Fixtures **en memoria con respuesta conocida** (`test.ts:751-833` G-C2, `:834+` G-C3), más el **piso POR FORMA** de `test.ts:731-738` — que es lo que mata al escáner que "no reporta nunca" sin bajar el total. Razón escrita en `test.ts:695-700` |
| **AC-8** entrada que sobrevive a su sitio | `G-C7` | ✅ **PASS** | **ROJO medido**: borré el token `discovery.ts:63` de `src/lib/payment-spec-reader.ts:7` dejando la declaración viva → `expected 52 to be 53` en `test.ts:977`. Invariante ESTRICTO, no `>=` |
| **AC-9** excepción con motivo, validada en runtime | `G-C8` | ✅ **PASS** | **ROJO medido**: `reason` de 10 caracteres en `UNICITY_EXCEPTIONS` → rojo en `test.ts:1322`. Corre en **runtime** por necesidad, no por gusto: ver §7 (tsc no mira este archivo) |
| **AC-10** declarar qué NO cubre | `G-C10` | ✅ **PASS** | **ROJO medido**: quité el literal `VALOR SEMÁNTICO` del docblock → rojo en `test.ts:1419`. El control **recorta la cabecera antes del primer `import`** (`test.ts:1394`) para no auto-satisfacerse — un mutante previo demostró que sin ese recorte el control **no podía ponerse rojo jamás**. Hoy: **14 ítems**, exige ≥ 8, más los 3 literales y los 2 porcentajes |
| **AC-11** las formas de cita | `G-C2` | ✅ **PASS** | Fixtures P1/P2/P3/P4 con `./` y `../` (`test.ts:757-790`) y dotfile. **Re-derivado hoy**: `P1=15 P2=19 P3=16 P4=7` = **57**, idéntico a lo declarado en `test.ts:79`. El AC pedía 3 patrones; la implementación da 4 (superset) |
| **AC-12** no duplicar `G-08`/`G-09`/`G-10` | `CD-1` (diseño) | ✅ **PASS** | Es un AC **de diseño** ("SHALL rechazarse en el SDD antes de escribir código"), así que **no puede tener un control runtime** — y el cierre lo dijo así, correctamente. Lo verifiqué **mecánicamente igual**: (a) `test/ownership-filter-guard.exceptions.ts` **NO está** en `CORTE_A_PATHS` (`citations.ts:87-102`); (b) tokens del Corte A que apuntan a `_INDEX.md` = **0**; (c) el target `_INDEX.md` está **delegado** y G-C9 se pone rojo si el dueño muere (**ROJO medido**, ver §2.4). Decisión escrita en `sdd.md:195-209` |

**12/12 PASS.** 8 con rojo ejecutado, 4 con derivación mecánica.

### 1.1 · El hueco que F4 existe para buscar: ¿hay ACs sin control?

Sí, **uno**, y está correctamente declarado: **AC-12 no tiene control runtime y no puede tenerlo** (es un AC
sobre el proceso de diseño). El cierre no lo maquilló: escribió "decisión de diseño (`CD-1`)" en vez de
inventarle un `G-C`. **Eso es lo correcto.** Los otros 11 tienen cada uno al menos un control que **se pone
rojo si el AC se viola**, y lo medí.

No encontré ningún AC que se esté dando por bueno "porque la suite está verde".

---

## 2 · Las tres afirmaciones que el CR midió falsas — ¿la corrección dice lo medido?

Las tres correcciones son **de prosa, no de mecanismo**, a propósito. Verifiqué las tres **contra la función real**.

### 2.1 `stripComments` NO borra el comentario de fin de línea — ✅ la frase nueva dice lo medido

Llamé a la función (`scratchpad/f4-224/probe1.mts`):

| Entrada | ¿Sobrevive el target? |
|---|---|
| `// cubre <target>` (línea sólo comentario) | **false** — se borra |
| `/** * cubre <target> */` (bloque) | **false** — se borra |
| `const _C = 1; // cubre <target>` (comentario de fin de línea) | **true** — **SOBREVIVE ENTERO** |
| `const X = '<target>';` (string en código) | **true** |

`test.ts:381-386` dice exactamente eso: *"el costo de esta excusa no es «código muerto»: es **un comentario**,
sólo que pegado al final de una línea de código"*. **Correcto y sin suavizar.** La frase vieja ("el costo subió
a escribir código muerto") era falsa en el sentido peligroso — decía que costaba MÁS. La nueva lo corrige
hacia abajo, que es la dirección incómoda.

**El escalón de CERO líneas también es cierto** (`test.ts:387-392`). Verificado:
- `test/readme-parity.test.ts:105` es el string `'src/lib/downstream-payment.ts:186-194'` **en una línea de código** ⇒ sobrevive `stripComments`. Confirmado abriendo la línea.
- Es un `*.test.ts` que corre, y sus controles están en código.
- **Ese target tiene exactamente 4 claves en el universo** — re-derivado: `src/types/index.ts :: downstream-payment.ts:772`, `:: downstream-payment.ts:711-735`, `src/services/agent.payment.test.ts :: downstream-payment.ts:247`, `src/lib/payment-spec-reader.ts :: downstream-payment.ts:772-777`. **Las 4 son del money-path.** La cifra "4 claves" del docblock es exacta.

⇒ `TD-224-DELEGACION-CUESTA-CERO` es **real, con el costo bien medido**, y está declarado.

### 2.2 Se puede apagar por el campo `from` — ✅ y los números se re-derivan exactos

`test.ts:1231-1248` declara la repro (12/12 verde), nombra el candado que NO cierra, y acota la frase
anterior a *"lo que dejó de ser posible es apagar el candado ENTERO, o filtrarlo por `reason`"* (`test.ts:1228-1229`).

**Re-derivé los números que sostienen la afirmación** (`scratchpad/f4-224/probe4.mts`):

| Dato declarado | Derivado hoy | ✓ |
|---|---|---|
| citadores que aportan **1 solo** canario: **3 de 11** | **3 de 11** | ✅ |
| cuáles: `agent.ts`, `agent.payment.test.ts`, `agents.publish.test.ts` | **los mismos tres** | ✅ |
| `citasQueNombranArchivo` = 31 (el `toBe(31)` que NO se escribió) | **31** | ✅ |
| 18 basenames distintos (`test.ts:1215`) | **18** | ✅ |

Queda abierto y con nombre: `TD-224-CANARIOS-POR-FROM`. **La frase dice lo medido.**

### 2.3 El testigo se desarma borrando 5 líneas — ✅ y son literalmente 5

`test.ts:1287-1300` lo declara y **no lo arregla, a propósito**. Conté el bloque: los canarios por `reason`
son `test.ts:1272-1276` = **exactamente 5 líneas**. La frase es literal, no aproximada. Queda como
`TD-224-QUIEN-VIGILA-AL-TESTIGO`.

### 2.4 · ¿Hay una CUARTA afirmación sin verificar?

Barrí la prosa buscando promesas de rojo: hay **10** marcadas `// Input que lo pone en rojo`
(`test.ts:704, 751, 834, 948, 990, 1018, 1043, 1074, 1326, 1375`). **Probé 8** (las de §1). Quedaban 3 sin
tocar por nadie; **probé la más consecuente**:

> `test.ts:1326` — *"Input que lo pone en rojo: borrar `G-F2` de `test/sdd-index-matches-folders.test.ts`"*

**ROJO medido**: renombré `it('G-F2` → `it('G-XX-BORRADO`. G-C9 rojo, con el mensaje correcto:
*"`DELEGATED_TARGETS · doc/sdd/_INDEX.md` · el control `it('G-F2` ya NO existe en el CÓDIGO de […] (los
comentarios no cuentan)"*. Restaurado, md5 idéntico.

**Esto importa más que el resto**: es la cadena que protege `doc/sdd/_INDEX.md:144` (§5.2). La promesa se cumple.

Las 2 restantes (`:751` G-C2, `:834` G-C3) son fixtures **en memoria autocontenidos** con la respuesta
conocida escrita al lado; las verifiqué **por lectura**, no por mutación. Lo declaro como límite en §9.

**No encontré ninguna afirmación del guardián que prometa un rojo y no lo entregue.**

---

## 3 · El número que se movía al escribirlo — 260 re-derivado

Corrí `scanSource` sobre los 4 archivos del guardián (`scratchpad/f4-224/probe3.mts`), con el propio
`citeTargetIfTracked` del escáner como resolvedor:

```
TOTAL: 260        (declarado: 260)   ✅
por archivo: test=76 · citations=100 · exceptions=46 · scanner=38
             (declarado: 76 · 100 · 46 · 38)                        ✅ los cuatro
```

**El desglose de los 260 cierra exacto, categoría por categoría:**

| Categoría | Declarado | Derivado | ✓ |
|---|---|---|---|
| valor del campo `cite` de `CITED_LINES` (ya tienen testigo) | 89 | **89** | ✅ |
| `:N` sueltos sin archivo (P3/P4) | 101 | **101** | ✅ |
| nombran archivo **NO** en el índice de git | 29 | **29** | ✅ |
| nombran archivo **TRACKEADO** | 41 | **41** | ✅ |
| **SUMA** | 260 | **260** | ✅ |

Y los subgrupos de los 29 también: **16** fixtures (`./splash.tsx`×5, `foo.ts`×3, `a.ts`×2, `b.ts`×2,
`../../lib/fixture.ts`×2, `./no/existe.ts`×2), **8** `x.io` (host:puerto, no archivo), **5** `.nexus/project-context.md`.
Y `.gitignore:172` aparece **9** veces, como dice `test.ts:204-206`.

⚠️ **Nota metodológica que casi me hace reportar un falso hallazgo**: con un resolvedor propio *más crudo*
(sin la resolución por sufijo alineado por segmento) me daba **31/39** en vez de 29/41 — los 2 de diferencia
son `types/index.ts` y `types/database.types.ts`, que **sí** resuelven a `src/types/…`. El instrumento
correcto es `citeTargetIfTracked`, y con él cierra. **El número del documento estaba bien y el mío estaba mal.**

### 3.1 · El invariante de `MNR-4`: ¿quedó en 36?

**No, y está bien.** El "36" es la foto **anterior** al fix-pack de prosa. El propio docblock declara la
transición: `test.ts:226-227` dice *"36 → 41 trackeados, 247 → 260 tokens — y el salto necesitó DOS pasadas,
porque escribir el número lo movió"*. **Hoy son 41, y 41 es lo que derivé.** No hay contradicción: el
documento ya reporta el valor movido.

**¿Cambia de fundamento la decisión de no incluir los 4 archivos?** **No.** El argumento es que de los
tracked, **9 son el token histórico `.gitignore:172`** —el bug que la HU arregló, citado como ejemplo— y
meterlos al corte convertiría cada mención del bug en una cita rota. Ese argumento vale igual a 41 que a 36.
Los **2 tokens nuevos** que causaron el salto están **nombrados y verificados a mano**, y los re-verifiqué:

- `test/readme-parity.test.ts:105` = `'src/lib/downstream-payment.ts:186-194'` ✅ **cierto**
- `test/scripts-imported-by-tests-are-tracked.test.ts:61` = `function stripComments(source: string): string` ✅ **cierto**

Los abrí los dos. Ninguna de las dos citas nuevas es falsa.

---

## 4 · La tabla de mapeo viejo→nuevo (§3.7 del cierre)

### 4.1 · Lo que la tabla dice, es cierto

Verifiqué las filas abriendo las líneas en ambas revisiones:

| Fila | Verificación |
|---|---|
| `test.ts:241` → `:264` | `:264` = `stripComments,` (el import) ✅ |
| `test.ts:392` → `:435` | `:435` = `else sources.set(f, stripComments(src));` ✅ |
| `test.ts:1318` → `:1394` | `:1394` = `const cabecera = self.slice(0, self.indexOf('\nimport {'));` ✅ |
| `test.ts:1193-1201` → `:1255-1263` | bloque de vacuidad `toBeGreaterThanOrEqual(10)` ✅ |
| `test.ts:1203-1215` → `:1265-1277` | `const CANARIOS = [` … `];` ✅ |
| `test.ts:1210-1214` → `:1272-1276` | canarios por `reason`, **5 líneas** ✅ |
| `test.ts:1216-1224` → `:1278-1286` | `conCanarios` … `.toBe(CANARIOS.length)` ✅ |
| `scanner.ts:344-352` → `:368-376` | `export function stripComments` ✅ |
| `test.ts:1127-1130` → `:1170-1173` | contenido viejo reaparece en `:1170` ✅ |

Y el alcance del desplazamiento es **exactamente el declarado**: sólo `test.ts` y `scanner.ts` cambiaron en
`9b6780a`. `citations.ts` (735 líneas) y `exceptions.ts` (278) son **byte-idénticos** a `ac4f4c3`. **No hay
un tercer archivo desplazado.**

### 4.2 · 🔴 HALLAZGO — la tabla es INCOMPLETA, y es el defecto que la HU vigila

Construí el mapa `línea vieja → línea nueva` por LCS entre `ac4f4c3` y `HEAD` para los dos archivos, y barrí
**los 9 artefactos** buscando toda cita a este guardián (`scratchpad/f4-224/displaced2.mjs`). Descartando
anclas triviales (líneas en blanco — una de ellas me dio un falso positivo que verifiqué y tiré):

**61 citas desplazadas con ancla no trivial**, repartidas así:

| Artefacto | Desplazadas | ¿Cubierto por la tabla? |
|---|---|---|
| `cr-report.md` | 22 | **parcialmente** — la mayoría sí |
| `ar-report.md` | 19 | ❌ **NO — fuera del alcance declarado** |
| `ar-report-it2.md` | 8 | ❌ **NO — fuera del alcance declarado** |
| `done-report.md` | 12 | por diseño (son la columna "vieja" de la propia tabla) |

**Dos omisiones concretas:**

1. **`ar-report.md` (19) y `ar-report-it2.md` (8) quedaron enteros afuera.** El encabezado de la tabla dice
   *"para quien lea el `cr-report.md` / `auto-blindaje.md` después"* — los dos AR son **igual de inmutables**
   y tienen **27 citas viejas** entre los dos. Ejemplos verificados: `ar-report.md:39`
   (`test/cited-lines-guard.test.ts:256-258` → hoy `:279-281`), `ar-report.md:41` (`:840-912` → `:883-955`),
   `ar-report-it2.md:122` (`test.ts:321-395` → `:344-438`).
2. **Aun dentro de su alcance declarado, la tabla omite al menos 4 citas del `cr-report.md`**:
   `cr-report.md:192` (`scanner.ts:317-343` → `:317-367`, **el fin del rango se movió y el inicio no**),
   `cr-report.md:265` (`test.ts:166-190`), `cr-report.md:276` (`test.ts:201-205` → `:214-…`),
   `cr-report.md:286` (`test.ts:1127-1130`, contenida en la fila `1107-1130` pero no listada como token propio).

**Verificado con contenido real, no sólo con el mapa** — p.ej. `test.ts:1127` en `ac4f4c3` era
`// Cuánto cubre el candado: CITED_LINES.filter(citeNamesFile) sobre`; hoy esa línea vive en `:1170` y `:1127`
dice otra cosa.

**Severidad: BAJA — no bloquea.** Razones, medidas:
- **No viola ningún AC.** El propio guardián declara esto como no-cobertura explícita: ítem 12,
  *"LAS CITAS DE LOS PROPIOS ARTEFACTOS DE ESTA HU […] viven en `doc/sdd/`, que no está en el universo de
  ningún corte"*. Es un silencio **declarado**, no un descuido.
- No toca `src/`, ni un control, ni el despliegue.
- El cierre **hizo un mapa voluntario que nadie le pidió** y **escribió que el fenómeno era el mecanismo de
  la HU**. El defecto es que el mapa quedó corto, no que se haya ocultado.

⇒ Lo dejo como deuda con nombre: **`TD-224-MAPA-DE-DESPLAZAMIENTO-INCOMPLETO`**. Es, otra vez, *"las citas
que rompés vos al arreglar otra cosa"*: un barrido del diff mira lo que escribís, no lo que desplazás.

---

## 5 · Drift detection

### 5.1 · Scope — ✅ sin drift

`git diff --name-only b31ddba..9b6780a` = **20 archivos**: 8 artefactos nuevos de la HU + `_INDEX.md` +
2 README + 5 de `src/` + 4 del guardián + `sdd-index-matches-folders.exceptions.ts`. Todos dentro de Scope IN.
**Ningún archivo tocado sin declarar, ninguno declarado sin tocar.**

**La afirmación "diff en `src/`: 7 líneas y las 7 son comentario" — VERIFICADA:**

```
lineas '+' en src/            : 7
lineas '+' que NO son comentario: 0
```

Las 7: `payment-spec-reader.ts:7` (`discovery.ts:23`→`:63`), `agents.ts:47` (`registries.ts:35`→`:94`),
`compose.ts:688` (`:208`→`:571`), `fee-split.ts:494` (`:335`→`:336`), `types/index.ts:207` (`:777`→`:922`),
`:510` (`reputation.ts:182-183`→`:189`), `:1450` (`compose.ts:130`→`src/services/compose.ts:571`).
**Cero cambio funcional.**

### 5.2 · `_INDEX.md` — ✅ y la línea 144 está INTACTA (lo más delicado del cierre)

- **Un solo par de líneas cambió** (`--numstat` = `1 1`): la fila `224` (línea **216**), que ahora dice **DONE** ✅
- **Total de líneas: 356 en `main`, 356 en `HEAD`** ⇒ **nada se desplazó** ✅
- **Línea 144: md5 `ef426d3a2fd1c0ecd10b5922e23087a9` en `b31ddba` y `ef426d3a2fd1c0ecd10b5922e23087a9` en `HEAD` ⇒ IDÉNTICAS byte a byte** ✅

⚠️ **Precisión sobre la relación, que se enuncia al revés con facilidad**: la línea 144 **no cita** a
`capability-risk.ts:82`. Es al revés — `src/lib/capability-risk.ts:82` y `src/lib/capability-risk.test.ts:56`
**citan `doc/sdd/_INDEX.md:144`**, que es la fila `157` (WKH-151). Es decir, la línea 144 es el **destino**
de dos citas de código del camino del dinero. Verificado:

- `src/lib/capability-risk.ts:82` = `` *     bdwv (`doc/sdd/_INDEX.md:144`). `` ✅
- `src/lib/capability-risk.test.ts:56` = `` // `cashout-match` está en el catálogo (`doc/sdd/_INDEX.md:144`) y se dejó `` ✅
- Declaradas en `test/sdd-index-matches-folders.exceptions.ts:184-191` con
  `mustContain: ['remit.corridor-discovery', 'kyc-check', 'cashout-match']`
- **Las 3 anclas están presentes en la línea 144 de hoy** (verificado una por una) ✅
- `G-F1` y `G-F2` **PASSED** en la corrida completa ✅

**El cierre tenía razón: la línea 144 quedó intacta.** Lo confirmo por tres vías independientes (md5,
conteo de líneas, y el guard verde).

### 5.3 · ¿Algo declarado HECHO que no esté en el árbol? — ✅ nada

Los **9 artefactos están en git** (`git ls-tree HEAD` = 9). `cr-report.md` estaba untracked y entró en
`9b6780a` (aparece como `+432` líneas, archivo nuevo) ✅. **Y `f4-report.md` —este archivo— es el décimo, y
existe en disco**: es justamente el que el cierre declaró ausente.

### 5.4 · Waves / orden de commits — ✅ coherente

5 commits, en orden: `feat` → `fix` (candado en la lista equivocada) → `docs` (contrato a git) → `fix`
(el testigo medía la regla, no que alguien la siguiera) → `docs` (las tres afirmaciones falsas). Cada
fix-pack posterior a su revisión. Sin saltos.

### 5.5 · Residuo — ✅ limpio

`git status --porcelain` = **una sola línea**, el untracked de la HU 212, md5 `7904ef74a1c46d7880e0ca5d38e3eed4`
**igual al pre-registro**. No lo toqué.

---

## 6 · 🎯 RUNTIME-FIRST — desplegar esto NO requiere ninguna acción de ops

**Lo digo explícitamente porque es un hallazgo positivo y es lo que F4 aporta:**

| Vector | Medido | Resultado |
|---|---|---|
| Migraciones / DDL / SQL | archivos `.sql`, `migrations/`, `supabase/` en el diff | **0** |
| Variables de entorno | `process.env` en el diff de `src/` | **0** |
| `package.json` / lockfile / `tsconfig` / `vitest.config` / biome | en el diff | **0** |
| Cambio funcional en `src/` | líneas `+` no-comentario | **0 de 7** |

⇒ **Cero DDL, cero envs nuevas, cero `src/` funcional.** No hay que correr migraciones, ni setear variables
en Railway, ni forzar redeploy, ni tocar Supabase. **El merge es inerte en runtime.** El único efecto en
producción es que `npm test` gana 12 controles.

**No consulté Supabase, ni Railway, ni nada contra producción**, como corresponde: no hay nada que consultar.

---

## 7 · Puertas — re-medidas, y el dato que sorprende confirmado

| Puerta | Declarado | **Medido por mí** | ✓ |
|---|---|---|---|
| `npm test` — archivos | 296 | **296** | ✅ |
| `npm test` — total / passed / pending / failed | 5781 / 5762 / 19 / 0 | **5781 / 5762 / 19 / 0** | ✅ |
| suites falladas | 0 | **0** | ✅ |
| `tsc --noEmit` | 0 | **exit 0** | ✅ |
| `npm run lint` (`biome check src/`) | 0, 489 archivos | **exit 0, 489 archivos** | ✅ |
| `G-C1..G-C12` | 12/12 `passed` | **12/12 `passed`** | ✅ |

Leído del **reporter JSON**, con `testResults[0].name` verificado bajo `/wasiai-a2a/` — y comprobé que **las
296 rutas** del JSON están bajo esa raíz, no sólo la primera.

⚠️ **Un falso rojo que cacé y descarto**: `npx biome check src/` a través del hook imprimió
*"Lint: 2 errors"* seguido de `npm error could not determine executable to run`. Corriendo el binario real
(`./node_modules/.bin/biome`) y `npm run lint`: **0 errores, 489 archivos**. Los "2 errors" eran artefacto de
la invocación mangleada, **no del código**.

### 7.1 · 🔴 La puerta de tipos NO cubre ni un archivo de esta HU — confirmado

```
tsc --noEmit --listFiles  ⇒ 2505 archivos
  de src/                 : 489
  con "cited-lines-guard" : 0        ← los 4 archivos de la HU
  de test/ del repo       : 0        ← las 31 coincidencias "/test/" son TODAS de node_modules
```

Causa: `tsconfig.json:19` ⇒ `"include": ["src/**/*"]`. **Ni un solo archivo de `test/` del repo pasa por la
puerta de tipos.** Eso es exactamente por lo que `G-C8` valida forma **en runtime** (`test.ts:1318-1322`:
*"Nada de esto lo caza el editor: este archivo no lo typechequea CI ni lo lintea nadie"*) y por qué
`delegationFindings` hace lecturas defensivas (`test.ts:408-417`). **La decisión de diseño está justificada
por la realidad de la configuración.**

**Los typechequeé aparte**, como corresponde:

```
tsc --noEmit --ignoreConfig --strict --noUncheckedIndexedAccess \
    --target ES2022 --module NodeNext --moduleResolution NodeNext \
    --skipLibCheck --types node  test/cited-lines-guard.{test,citations,exceptions,scanner}.ts
⇒ EXIT 0
```

✅ **Los 4 archivos son type-clean bajo `--strict --noUncheckedIndexedAccess`**, aunque CI nunca los mire.
**Hallazgo positivo**, y también: la brecha de cobertura de `tsc` sobre `test/` es **preexistente y de todo
el repo**, no de esta HU.

---

## 8 · La deuda declarada que queda, con su nombre

Ninguna es un bloqueante. Las cinco están **escritas en el código o en los artefactos**, no descubiertas por mí:

| Deuda | Qué queda abierto | Verificado por mí |
|---|---|---|
| `TD-224-DELEGACION-CUESTA-CERO` | apagar una delegación cuesta **0 líneas** en el archivo del dueño; saca N claves de una vez. `test/readme-parity.test.ts` es un dueño usable HOY para 4 claves del money-path | ✅ precondiciones medidas (§2.1) |
| `TD-224-CANARIOS-POR-FROM` | el testigo del candado 2️⃣ se puede filtrar por `from`; 3 de 11 citadores aportan 1 solo canario | ✅ 3/11 re-derivado (§2.2) |
| `TD-224-QUIEN-VIGILA-AL-TESTIGO` | el esperado se deriva del propio conjunto de canarios ⇒ ciego a que el conjunto se achique; **5 líneas** lo desarman | ✅ son 5 líneas exactas (§2.3) |
| `TD-224-CITAS-DEL-PROPIO-GUARDIAN` | los 4 archivos del guardián no están en ningún corte: **260 tokens** sin testigo mecánico | ✅ 260 y su desglose (§3) |
| `TD-316-CITAS-PROJECT-CONTEXT` | `.nexus/project-context.md` no está en git ⇒ inalcanzable. Repo público: trackearlo publica su contenido | ✅ 5 tokens lo nombran (§3) |
| **`TD-224-MAPA-DE-DESPLAZAMIENTO-INCOMPLETO`** | **NUEVA, la abro yo** — §4.2 | ✅ 61 desplazadas, 27 fuera de alcance |

---

## 9 · Límites de lo que pude medir, con esas palabras

**Esto es lo que NO verifiqué, y hay que leerlo antes de apoyarse en mi verde:**

1. **No verifiqué el VALOR semántico de las 50 citas declaradas.** Verifiqué que el mecanismo se ponga rojo
   cuando la declaración deja de describir la línea. **Que la prosa alrededor de cada cita sea VERDADERA es
   otra pregunta**, es el ítem 3 de la no-cobertura del propio guardián, y **no la respondí**. Una cita con
   el número bien y la conclusión falsa pasa mi validación igual que pasa la suya.
2. **De las 10 promesas de rojo, probé 8.** `G-C2` (`test.ts:751`) y `G-C3` (`test.ts:834`) los verifiqué
   **leyendo** sus fixtures en memoria, no mutando el escáner. Son autocontenidos y con la respuesta escrita
   al lado, pero **no ejecuté su rojo**.
3. **No re-corrí los exploits del AR/CR** (los 4 bloqueantes en las dos direcciones, los 3 exploits, el
   31/19, los bordes de `citeTargetIfTracked`). Los tomo como medidos por esos roles; **mi evidencia es
   independiente de la suya**, no una repetición.
4. **El mapa de desplazamiento de §4.2 es por LCS**, y LCS empareja mal las líneas triviales. Descarté las
   anclas de < 5 caracteres y **verifiqué 4 casos abriendo el contenido en ambas revisiones**, pero los 61
   **no** los abrí uno por uno. El número **61 es un piso con ruido posible**, no un total exacto. Lo que sí
   es exacto es que `ar-report.md` y `ar-report-it2.md` están **fuera del alcance declarado de la tabla**.
5. **No verifiqué nada contra producción** (Supabase, Railway) — **a propósito y por instrucción**, y además
   innecesario: §6 mide que no hay superficie de runtime que tocar.
6. **No corrí `npm run test:coverage`.** La cobertura de los 4 archivos del guardián no la medí; los README
   citan una medición del 2026-08-15 que no re-derivé.
7. **El "296 archivos" de los README** lo confirmé contra la corrida real, pero **no** re-derivé el
   `include` de `vitest.config.ts` sobre el índice de git de forma independiente — me apoyé en que
   `test/readme-numbers.test.ts` pasó.

---

## 10 · Veredicto

# ✅ APROBADO PARA DONE

- **12/12 ACs en PASS**, cada uno con evidencia `archivo:línea`. **8 con el rojo ejecutado y el árbol
  restaurado con md5 verificado**; 4 con derivación mecánica. **Ninguno se da por bueno "porque la suite
  está verde".**
- **Las 3 afirmaciones falsas que el CR midió están corregidas y las 3 nuevas dicen lo medido, sin
  suavizar** — verificadas llamando a la función, no leyendo la prosa. La 3ª declara un agujero abierto y
  **no lo maquilla**.
- **Una 4ª promesa de rojo sin testigo previo, probada: G-C9 se pone rojo** al matar al dueño de la
  delegación de `_INDEX.md`.
- **Los 260 tokens y su desglose 89/101/29/41 cierran exacto**, igual que 57, 14, 50, 53, 31, 11, 18 y
  `P1=15 P2=19 P3=16 P4=7`. **Todos los números publicados del guardián se re-derivan.**
- **`_INDEX.md:144` INTACTA** por md5, por conteo de líneas y por `G-F1` verde.
- **Drift: ninguno en scope, ni en waves, ni en el árbol.** Los 9 artefactos en git; éste es el décimo.
- **Puertas verdes re-medidas**: 296 / 5781 / 5762 / 19 / **0 failed**, `tsc` 0, `biome` 0 (489).
- **Cero DDL, cero envs, cero `src/` funcional ⇒ el merge no requiere ninguna acción de ops.**

**El único hallazgo es `TD-224-MAPA-DE-DESPLAZAMIENTO-INCOMPLETO` (§4.2): deuda documental en artefactos
inmutables, dentro de un silencio que el propio guardián declara. No bloquea, y queda con nombre.**

**Mergeá.**

---
*F4 · nexus-qa · 2026-08-19 · HEAD `9b6780a` · árbol restaurado y verificado por md5 tras 9 mutaciones*
