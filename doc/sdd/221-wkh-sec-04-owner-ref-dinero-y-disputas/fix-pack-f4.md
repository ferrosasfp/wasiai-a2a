# Fix-pack de F4 (validación) — WKH-SEC-04

> Worktree `/home/ferdev/.openclaw/workspace/wt-sec04`, base `b7fa4e7`, HEAD antes de este
> fix-pack `c09badc` (el fix-pack del CR). Input: `validation.md` (veredicto **RECHAZADO**:
> 1 `BLOQUEANTE` + 1 `BLOQUEANTE-BAJO` + 5 MENORes).
>
> **Todas las citas `archivo:línea` de este documento están medidas contra el árbol DESPUÉS
> de la última edición de este fix-pack**, con el control de §7. Ninguna se copió del encargo.
>
> **Cero código ejecutable.** `git diff c09badc -- src` toca 1 archivo, con **3 `−` y 3 `+`**
> que empiezan todas con `*`. La suite no se movió ni un test.

## Por qué un archivo nuevo, y por qué el `MNR-2`/`MNR-3` NO está acá

Las dos cosas, por la misma razón que en el fix-pack anterior (`fix-pack-cr.md:15-24`):

- **La narrativa va acá.** Meterle una tercera tanda de «antes → después» a `fix-pack-cr.md`
  hace ambiguo a qué ronda pertenece cada número.
- **La lista de citas ancladas va in-place en `fix-pack-cr.md`**, porque es ahí donde vive la
  lista incompleta que F4 pidió ampliar (el ítem 1 de «Lo que NO pude verificar», `:244-249`).
  Duplicarla acá garantiza que alguien lea la vieja.
- **Y va al FINAL de ese archivo, no en el medio.** El ítem 1 está en `:244-249` y la tabla de
  barrido en `:285-289`; `validation.md:255` cita los dos. Insertar renglones arriba habría
  corrido `:285-289` y roto la cita de `validation.md` **a este mismo changeset**. Es
  literalmente el defecto que este fix-pack viene a cerrar, así que se evitó a propósito: el
  addendum es `fix-pack-cr.md:297-340` y **no movió una sola línea de las 293 de arriba**.

---

## `BLQ-1` — la frase refutada, viva en un CUARTO sitio dentro de `src/`

- **Sitio**: `src/adapters/escrow/debit-capture.test.ts:11-15`, el header ajeno que esta HU
  agregó en W4. · **CD-7**
- **Decía**: «su control de dueño es un espía de argumento (`:539`), **que pasa igual con el
  nombre de la columna mal escrito**».
- **Por qué era falso**: está medido tres veces (AR, CR, y F4 §2 con repro propio). Mutando
  `debit-capture.ts:120` a `.eq('ownerRef', ownerRef)` la corrida de este mismo archivo da
  `Tests 1 failed | 19 passed (20)`, **rojo en `:539`**, porque `toContainEqual` compara el
  **par** exacto `['owner_ref', OWNER]`. El espía **sí** caza el typo de columna.
- **Lo grave, y es lo que lo hacía BLOQUEANTE**: a 30 líneas, `debit-capture.ownership.test.ts:47-52`
  afirma **exactamente lo contrario**, y es el que tiene razón. Dos archivos del mismo merge
  se contradecían sobre el mismo espía.

**Cómo quedó** — con la formulación ya validada del archivo hermano (`:43-45`), que separa lo
que el espía **no** prueba de lo que **sí** caza:

```
 * ⚠️ WKH-SEC-04 — LÍMITE DE ESTE ARCHIVO: sus dobles NO aplican los filtros
 * (`:85` y `:469` son `eq: () => builder`) y su control de dueño es un espía de
 * argumento (`:539`): prueba QUE LA LLAMADA SE HIZO, no QUÉ FILAS VOLVIERON — la
 * columna mal escrita SÍ la caza, medido en `debit-capture.ownership.test.ts:43-52`;
 * ese archivo cubre por comportamiento `debit-capture.ts` (`:120` y `:212`).
```

**La edición se hizo LÍNEA-NEUTRA, y acá no era opcional**: el bloque medía 5 líneas y sigue
midiendo 5. Este header **contiene tres auto-citas** (`:85`, `:469`, `:539`) y esas tres las
citan además `mutation-log.md`, `_INDEX-row.md`, `auto-blindaje.md`, `code-review.md`,
`adversarial-review.md` y `validation.md`. Una sexta línea las habría corrido **todas** a
`:86`/`:470`/`:540` — el bug de `BLQ-BAJO-2`, reproducido mientras se arregla. Verificado
después de editar:

```
$ sed -n '85p;469p;539p' src/adapters/escrow/debit-capture.test.ts
    eq: () => builder,
      eq: () => builder,
    expect(calls.eq).toContainEqual(['owner_ref', OWNER]);
```

**Por qué el rango citado es `:43-52` y no `:47-52`**: `:47-52` es sólo la mitad *medida* (el
typo). `:43-45` es la otra mitad —«un espía prueba QUE LA LLAMADA SE HIZO, no QUÉ FILAS
VOLVIERON»—, que es la frase que se está adoptando. El rango cubre las dos.

```
$ sed -n '43p;52p' src/adapters/escrow/debit-capture.ownership.test.ts
 * registran el filtro y no lo aplican. Un espía prueba QUE LA LLAMADA SE HIZO,
 * comando que refuta esta frase si algún día deja de ser cierta.
```

---

## `BLQ-BAJO-2` — la cita que la propia HU corrió, en el archivo que CD-21 nombra

- **Sitio**: `test/ownership-filter-guard.test.ts:122`. · **CD-21**
- **Decía**: `` `git ls-files src` (`:140-142`) ``. Era **correcta en `b7fa4e7`** y la rompió
  la reescritura del punto 8 (AC-7): `+20 −5` dentro de `@@ -81,11 +81,26 @@`, neto **+15**.
- **Por qué las tres rondas la dejaron pasar**: nadie la escribió, **la desplazaron**. No la
  cubre la regla de `auto-blindaje.md:150-157` (`grep -rn "<archivo>:[0-9]"`), porque el que
  cita es el propio archivo editado y con un `:NNN` **desnudo**.

**Cómo quedó**: `` `:140-142` `` → `` `:155-157` ``.

### ⚠️ Desviación de la sugerencia de QA, con la medición al lado

`validation.md:84` sugiere `` `:157-159` ``. **No se aplicó, y el motivo es medible.** El
rango original `:140-142` no era «la línea del `ls-files`»: era **el docblock + la firma de
`trackedSourceFiles()` + la llamada**. Con `140 + 15 = 155`, el rango fiel es `:155-157`, y
devuelve **el mismo texto, línea por línea**, que devolvía en la base:

```
$ sed -n '155,157p' test/ownership-filter-guard.test.ts          # HOY
/** Contra el ÍNDICE de git, no contra el disco: es lo que `checkout` trae. */
function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'src'], {

$ git show b7fa4e7:test/ownership-filter-guard.test.ts | sed -n '140,142p'   # LO QUE DECÍA
/** Contra el ÍNDICE de git, no contra el disco: es lo que `checkout` trae. */
function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'src'], {
```

`:157-159`, en cambio, **corta el `execFileSync` por la mitad** (abre en `:157` y cierra en
`:161`) y pierde el comentario que ancla el «contra el ÍNDICE, no contra el disco» que la
frase citante está justificando:

```
$ sed -n '157,161p' test/ownership-filter-guard.test.ts
  const out = execFileSync('git', ['ls-files', '-z', 'src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
```

El encargo pedía explícitamente «verificá el cierre del `execFileSync`». Verificado: no cierra
en `:159`. Se aplicó el rango fiel. **`:140-142` y `:155-157` miden lo mismo en caracteres**,
así que la línea no se re-acomodó.

---

## `MNR-1` — seis líneas donde el Story File autorizaba una. **Declarado, no recortado**

El Story File prohíbe tocar los cuatro tests preexistentes «más allá de **una línea de
comentario** en el header (§9)» (`story-HU-WKH-SEC-04.md:667-668`). Se entregaron **6 líneas
en cada uno** de los dos headers ajenos (`debit-capture.test.ts:10-15`,
`arbiter/evidence.test.ts:10-15`): la línea `*` de separación más cinco de prosa.

**Es una desviación literal, y queda como desviación consciente. No se recorta**, por tres
razones que se sostienen solas:

1. **Cero ejecutable.** Los dos hunks son `-9,0 +10,6`: inserción pura de comentario, ni una
   línea de código tocada. Lo que la prohibición protege —«romperían contratos de los que
   dependen decenas de tests»— está intacto.
2. **Una línea no alcanza para lo que §9 pide que digan.** El header tiene que declarar (a)
   que los dobles no aplican los filtros, (b) **dónde** están esos dobles, (c) qué mide
   entonces el archivo, y (d) qué archivo sí lo cubre. Comprimirlo a una línea produce
   exactamente la prosa que afirma de más que esta HU vino a extirpar.
3. **Recortarlo ahora costaría más de lo que arregla.** Las líneas del bloque son destino de
   citas externas: sacar líneas correría `:85`/`:469`/`:539` y `:55`/`:42`, que citan seis
   documentos. Se cambiaría un desvío de forma por el defecto de fondo de esta HU.

**Dónde queda declarado**: acá, y en `_INDEX-row.md:21` con todas las letras, que es el
artefacto que se lee sin abrir la carpeta. **Lo que NO se hace es dejar el `_INDEX` diciendo
«una línea»**: eso decía, y era falso — corregido en el mismo cambio.

---

## `MNR-2` y `MNR-3` — los dos punteros de `adversarial-review.md`

**No se edita el AR.** Es artefacto del revisor, está anclado a `99e3ed0` (`adversarial-review.md:3`)
y F4 §1.4 dictaminó que esa política es correcta. Lo que faltaba era que la lista de citas
ancladas-o-erróneas **los nombrara**, y la lista vivía en `fix-pack-cr.md` nombrando sólo a
`code-review.md`. Ampliada: **`fix-pack-cr.md:297-340`**, con los `sed -n` de los tres
sujetos pegados.

- `MNR-3` — `adversarial-review.md:169` cita `story-HU-WKH-SEC-04.md:696`. Es la **misma**
  cita falsa que este dev ya había corregido en `fix-pack-ar.md:246`; el desmentido
  (`fix-pack-cr.md:219-238`) nombraba sólo ese archivo. Ahora nombra los dos.
- `MNR-2` — `adversarial-review.md:149` cita `owner-scoped-fake.ts:152` («`onUpdateStart` es
  aditivo»). `:152` es `  /**`. La declaración está en `:158` y el default en `:229`, y **el
  AR cita `:229` en el mismo paréntesis**, que es el puntero que sostiene la afirmación.

**Y se verificó que no fuera desplazamiento**, que es la pregunta que F4 enseña a hacer:

```
$ git diff --stat 99e3ed0 -- src/services/__tests__/owner-scoped-fake.ts
                                        (vacío: el archivo es idéntico desde el ancla del AR)
```

O sea que `:152` no se corrió: el AR lo escribió apuntando una línea antes. Imprecisión de
autor, no desfase. Impacto nulo sobre la conclusión.

---

## `MNR-4` — `code-review.md` nombraba su HEAD pero no **declaraba** su ancla

Agregado a su blockquote, **sin tocar un solo número y sin agregar una línea**: se extendió la
línea 5, que ya existía, en vez de insertar una nueva. Eso no es prolijidad, es el hallazgo de
esta ronda aplicado a su propio arreglo — `validation.md:104` cita `code-review.md:4` y
`validation.md:182` cita `code-review.md:170`. Una línea insertada arriba las corría a las dos.

```
$ awk 'NR==5' doc/sdd/221-…/code-review.md
> `99e3ed0`. **Todas las citas `archivo:línea` de este documento están ancladas a `853ed66`**, no a HEAD: …

$ awk 'NR==4' doc/sdd/221-…/code-review.md        # control: NO se movió
> `feat/221-wkh-sec-04-owner-ref-dinero-y-disputas`, HEAD `853ed66`, base `b7fa4e7`, AR previo en

$ awk 'NR==170' doc/sdd/221-…/code-review.md      # control: NO se movió
$ command grep -rn "reverseFeeSplits" src/ --include=*.ts | wc -l
```

⚠️ **Y ese último control encontró algo que no venía en el encargo.** `validation.md:182`
atribuye a `code-review.md:170` la verificación de los tres punteros (`:85`, `:469`, `:539`).
`:170` es otra cosa —la primera línea del bloque de `grep` del `MNR-1`—. Lo que sí los verifica
es **`code-review.md:66`**:

```
$ awk 'NR==66' doc/sdd/221-…/code-review.md
hechos que verifiqué: `debit-capture.test.ts:85` y `:469` son ambos `eq: () => builder`, y `:539` es
```

**No se edita `validation.md`**, por la misma política que el AR y el CR: es artefacto del
validador. Queda declarado en la tabla de `fix-pack-cr.md:297-340`. El veredicto de F4 no
depende de ese número: el hecho que la frase afirma —que el CR miró los punteros y no la
oración que los rodea— es cierto, y se lee en `:65-66`.

---

## `MNR-5` — `_INDEX-row.md:21` declaraba un estado que ya no era

- **Decía**: `in progress (F3 hecho; pendiente AR/CR/F4)`.
- **Dice**: `in progress (F3, AR, CR y F4 corridos; los tres veredictos fueron RECHAZADO
  —siempre por prosa, nunca por código ejecutable— y cada uno tiene su fix-pack aplicado …
  pendiente la re-validación de F4 y el cierre por DONE)`.

El cierre definitivo sigue siendo de `nexus-docs`. Lo que se corrige acá es que la fila **no
se mergee afirmando que AR/CR/F4 no corrieron**, habiendo corrido y habiendo rechazado.

---

## 7. EL CONTROL NUEVO — el que cierra la clase entera

> Después de la última edición, para **cada** archivo tocado:
> `git diff -U0 b7fa4e7 -- <archivo> | grep '^@@'` da el punto de inserción y el delta.
> **Toda cita del propio archivo con número mayor a ese punto se re-mide con `sed -n`, la
> haya escrito esta HU o no.** Y toda frase copiada a un archivo ajeno se re-lee **con la
> frase corregida al lado**, no sola.

Corrido con el índice ya cargado (`git add`), sobre los **20** archivos del merge. El resultado
que importa es que **el universo se parte en dos**, y una de las dos mitades no podía tener el
bug:

### 7.1 · Los 16 archivos 100% nuevos — no hay nada desplazado

`delta neto == tamaño`, o sea que el archivo entero nació en esta HU y **toda** cita suya la
escribió este dev (ya barridas 20/20 en el fix-pack anterior y 1.049/1.049 por F4):

```
_INDEX-row.md            +21 == 21      adversarial-review.md   +240 == 240
auto-blindaje.md        +250 == 250     code-review.md          +337 == 337
fix-pack-ar.md          +276 == 276     fix-pack-cr.md          +340 == 340
mutation-log.md         +203 == 203     sdd.md                  +812 == 812
story-HU-WKH-SEC-04.md  +759 == 759     validation.md           +375 == 375
fix-pack-f4.md (éste)   +395 == 395
debit-capture.ownership.test.ts  +327 == 327
arbiter.ownership.test.ts        +404 == 404
arbiter/evidence.ownership.test.ts +268 == 268
fee-split.ownership.test.ts      +395 == 395
reconciliation.ownership.test.ts +150 == 150
```

⚠️ **Sobre `validation.md` y este archivo**: hasta que se los hace `git add` no tienen hunks,
así que el clasificador los tira al otro balde por `delta 0`, no por tener contenido viejo. Es
un artefacto de la herramienta, no un hallazgo — y es el motivo por el que este control se
corre **con el índice ya cargado**.

### 7.2 · Los 4 archivos con contenido PREEXISTENTE — acá vive la clase del hallazgo

Son los únicos donde una auto-cita **que el dev no escribió** pudo correrse. Para cada cita
desnuda con `nº > punto de inserción` se compara el sujeto de HOY contra el sujeto que la
misma cita devolvía en `b7fa4e7` (`nº − delta`). `IGUAL` = la cita sobrevivió al desplazamiento:

| Archivo | hunks | P | delta | cita | HOY | BASE | |
|---|---|---|---|---|---|---|---|
| `debit-capture.test.ts` | `-9,0 +10,6` | 10 | +6 | `:85` | `eq: () => builder,` | `:79` ídem | IGUAL |
| | | | | `:469` | `eq: () => builder,` | `:463` ídem | IGUAL |
| | | | | `:539` | `expect(calls.eq).toContainEqual([…])` | `:533` ídem | IGUAL |
| `arbiter/evidence.test.ts` | `-9,0 +10,6` | 10 | +6 | `:55` | `eq: () => b,` | `:49` ídem | IGUAL |
| | | | | `:42` | `const OWNER = 'tenant-A';` | `:36` ídem | IGUAL |
| `owner-scoped-fake.ts` | 11 hunks | 54 | **+82** | — | **cero citas desnudas** | — | n/a |
| `ownership-filter-guard.test.ts` | `-84,5 +84,20`, `-107 +122` | 84 | +15 | `:155` | `/** Contra el ÍNDICE de git…` | `:140` ídem | **IGUAL (arreglada)** |

**Las citas desnudas que NO son auto-referencia, adjudicadas leyendo el párrafo** (es el paso
que ningún script puede hacer solo, y el que QA hizo a mano sobre 1.049 ocurrencias):

```
$ sed -n '120p;212p' src/adapters/escrow/debit-capture.ts     # debit-capture.test.ts:15
      .eq('owner_ref', ownerRef)
    .eq('owner_ref', ownerRef)
$ sed -n '57p;76p;96p' src/services/arbiter/evidence.ts       # evidence.test.ts:14
    .eq('owner_ref', ownerRef)
    .eq('owner_ref', ownerRef);
    .eq('owner_ref', ownerRef);
$ sed -n '163p;190p;219p' src/services/spend-policy.ts        # guardián :21-23
      .eq('owner_ref', ownerId)   (×3)
$ sed -n '292p;311p;344p' src/services/spend-policy.test.ts   # guardián :22
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1');   (×3)
$ sed -n '124p;126p' src/services/task.ts                     # guardián :63
      .from('tasks')   /   .eq('owner_ref', ownerRef)
$ sed -n '552p;603p' src/adapters/solana/settle-ledger.ts     # guardián :114
      .from('a2a_solana_settle_intents')   (×2)
```

**Resultado del barrido con nombre explícito**: 138 citas `<archivo>:NNN` a los 19 archivos del
merge, con `NNN` mayor al punto de inserción. **0 fuera de rango.**

### 7.3 · `owner-scoped-fake.ts` — el que nadie había mirado con este control

Es el archivo con **el mayor desplazamiento del changeset** (`+82`, 11 hunks, punto de
inserción en `:54`) y F4 §1.2 no lo incluyó entre los tres que verificó. Con el control
aplicado: **no tiene ni una cita desnuda**, así que no hay auto-referencia que se haya podido
correr. Sus citas externas son todas con nombre y viven en `sdd.md`/`story-…md`, ancladas a
`b7fa4e7` (`sdd:7-8`, `story:8-9`) y verificadas 11/11 por F4, más `adversarial-review.md:149`
anclada a `99e3ed0` sobre un archivo que **no cambió desde ese commit**. Queda cerrado.

### 7.4 · La segunda mitad del control: la frase copiada, leída al lado de la corregida

`BLQ-1` no lo caza un barrido de números: los tres punteros eran exactos, lo falso era la
**oración**. Aplicado a los dos únicos textos que esta HU copió a un archivo ajeno:

```
$ sed -n '11,15p' src/adapters/escrow/debit-capture.test.ts   # el copiado, ya corregido
$ sed -n '43,52p' src/adapters/escrow/debit-capture.ownership.test.ts   # el original
   -> las dos dicen ahora lo mismo: el espía no prueba QUÉ FILAS VOLVIERON, y el typo SÍ lo caza

$ sed -n '11,15p' src/services/arbiter/evidence.test.ts       # el otro header ajeno
   -> «su doble NO aplica los filtros (`:55`) y su fixture tiene un solo dueño (`:42`)»
   -> contra `evidence.ownership.test.ts`: sin contradicción; los 5 punteros verificados arriba
```

---

## 8. Verificación — salidas reales

```
$ node ./node_modules/vitest/vitest.mjs run
 Test Files  273 passed | 6 skipped (279)
      Tests  5358 passed | 19 skipped (5377)
```

**Idéntico** a la baseline, al AR, al CR y a F4. Ni un test se movió: es el control de que no
se tocó nada ejecutable.

```
$ ./node_modules/.bin/tsc --noEmit ; echo "exit=$?"                 → exit=0
$ ./node_modules/.bin/biome check src/ ; echo "exit=$?"             → Checked 472 files. exit=0
```

Medidos **a pelo**, sin tubería antes del `$?` (lección `auto-blindaje.md:164-181`).

### AC-6 — cero producción

Medido **sin tuberías**, contando en `python3` sobre la salida de `git`, por el motivo de la
advertencia de abajo:

```
git diff --name-only b7fa4e7 -- src   →  8 archivos · 7 *.test.ts · 1 en __tests__/
                                         (los mismos 8 que verificaron AR, CR y F4)

git diff c09badc -- src               →  6 líneas +/- , 0 no-comentario
    - * argumento (`:539`), que pasa igual con el nombre de la columna mal escrito; el
    - * acotamiento por `owner_ref` de `debit-capture.ts` (`:120` y `:212`) lo cubre
    - * por comportamiento `src/adapters/escrow/debit-capture.ownership.test.ts`.
    + * argumento (`:539`): prueba QUE LA LLAMADA SE HIZO, no QUÉ FILAS VOLVIERON — la
    + * columna mal escrita SÍ la caza, medido en `debit-capture.ownership.test.ts:43-52`;
    + * ese archivo cubre por comportamiento `debit-capture.ts` (`:120` y `:212`).
```

**3 `−` y 3 `+`, las seis abren con `*`**: cero ejecutable, y línea-neutra, que es lo que
mantiene vivas las auto-citas `:85`/`:469`/`:539`.

⚠️ **Y acá volvió a pasar lo del `auto-blindaje.md:164-181`, en la misma sesión que lo
documenta.** `git diff --name-only b7fa4e7 -- src | wc -l` devolvió **`11`** para una lista de
**8** archivos: el wrapper del shell le inyecta renglones a la salida redirigida. El conteo por
pipe habría hecho fallar el AC-6 por un motivo inexistente. **Ningún número de este fix-pack
sale de una tubería.**

---

## 9. Lo que NO pude verificar

1. **Que el RPC `capture_debit_signature` rechace contra una base viva.** Sin cambios: se
   verifica leyendo la migración. Declarado dentro del archivo que hace la afirmación
   (`debit-capture.ownership.test.ts:32-35`).
2. **Los mutantes.** No se re-corrió ninguno. Este fix-pack no toca una línea ejecutable y la
   suite dando el mismo `5358 passed | 19 skipped` es el control de eso. La evidencia sigue
   siendo la del AR §0, el `mutation-log.md`, los 4 del CR y los 5 que re-corrió F4.
3. **Que la adjudicación de los `:NNN` desnudos sea exhaustiva.** El control de §7 los
   **enumera** mecánicamente, pero decidir a qué archivo apunta cada uno es lectura de
   párrafo. Se adjudicaron a mano los de los 4 archivos con contenido preexistente (§7.2), que
   son los únicos donde el desplazamiento es posible. Los de los 15 archivos nuevos se apoyan
   en el barrido de F4 (1.049 ocurrencias, 0 fuera de rango) y en el propio (20/20).
4. **Que `validation.md` no necesite su propia declaración de ancla.** No se lo tocó: es
   artefacto del validador y ya nombra su HEAD (`:4-5`). Su ancla queda declarada **desde
   afuera**, en `fix-pack-cr.md:297-340`, por la misma política que se aplicó al AR.
