# Validation Report — WKH-SEC-04 (F4)

> QA · `nexus-qa` · 2026-08-06
> Worktree `/home/ferdev/.openclaw/workspace/wt-sec04`, rama
> `feat/221-wkh-sec-04-owner-ref-dinero-y-disputas`, HEAD `c09badc`, base `b7fa4e7`.
> Árbol verificado con `git status --porcelain` **vacío** antes y después de cada sonda
> (5 mutantes de reemplazo + 1 mutante de columna + 3 archivos de sonda temporales).
> Estado final: vacío, HEAD `c09badc`, ni un artefacto modificado.
>
> **Persistido por el orquestador**: el validador no puede emitir `.md` por configuración.

## VEREDICTO: **RECHAZADO** — 1 BLOQUEANTE + 1 BLOQUEANTE-BAJO

Los **7 ACs pasan** con evidencia propia. Los **13 mutantes mueren de verdad** (re-verifiqué 5,
elegidos por mí, con el guardián fuera de la corrida). **Cero producción tocada.** La suite, `tsc` y
`biome` están exactamente en la línea declarada.

Lo que bloquea es, otra vez, **el defecto recurrente de esta HU — y las dos instancias que quedan
vivas son las que ninguna de las tres rondas anteriores podía cazar con su método**, porque las tres
barrieron *lo que el dev escribió* y estas dos están en *lo que el dev desplazó* y en *lo que el dev
copió a un archivo ajeno*:

1. **`BLQ-1`** — la frase que el AR refutó como `BLQ-BAJO-2` **sigue viva, textual, en un cuarto
   sitio**, dentro de `src/`. El fix-pack corrigió 3 de 4 propagaciones.
2. **`BLQ-BAJO-2`** — la reescritura del punto 8 del guardián (AC-7) **corrió 15 líneas** y dejó rota
   una cita del **mismo archivo** que el dev no escribió y por eso no revisó.

Ninguno de los dos toca código ejecutable. Ninguno mueve la suite. Los dos son texto.

---

## 1. Barrido mecánico de citas — el gate

**Método**: extracción programática de **todas** las ocurrencias `archivo.ext:NNN(-MMM)` y `:NNN`
desnudas en los **18 archivos que se mergean** (`git diff --name-only b7fa4e7`), resolución del
archivo destino, y `sed -n` sobre el rango. Para cada `:NNN` desnudo decidí el archivo por el
contexto del párrafo y lo digo explícito.

**Universo medido: 1.049 ocurrencias.**

### 1.1 · Resultado global

| Clase | N | Veredicto |
|---|---|---|
| Fuera de rango (línea > tamaño del archivo) | **0** | ✅ |
| **Rotas a HEAD, con cita y sujeto en un archivo que esta HU editó** | **1** | ❌ `BLQ-BAJO-2` |
| Desfasadas a HEAD pero **correctas bajo un ancla declarada y verificada** | ~40 | ✅ (§1.3) |
| Punteros imprecisos en artefactos de revisor | 2 | MENOR (§MNR-2, MNR-3) |
| Resto | resuelve a su sujeto | ✅ |

### 1.2 · ❌ La cita rota — `BLQ-BAJO-2`

`test/ownership-filter-guard.test.ts:122` cita `` `:140-142` `` para `git ls-files src`. Ese rango
hoy devuelve un bloque de `import`. **El sujeto está en `:157`:**

```
$ sed -n '157p' test/ownership-filter-guard.test.ts
  const out = execFileSync('git', ['ls-files', '-z', 'src'], {
```

**Prueba de que lo rompió esta HU, no venía roto:**

```
$ git show b7fa4e7:test/ownership-filter-guard.test.ts | grep -n "ls-files"
107: *     `git ls-files src` (`:140-142`), a propósito: …
142:const out = execFileSync('git', ['ls-files', '-z', 'src'], {   ← ERA CORRECTA

$ grep -n "ls-files" test/ownership-filter-guard.test.ts        # HEAD
122: *     `git ls-files src` (`:140-142`), a propósito: …       ← el texto NO cambió
157:const out = execFileSync('git', ['ls-files', '-z', 'src'], { ← el sujeto SÍ se movió
```

`git diff b7fa4e7 -- test/ownership-filter-guard.test.ts` es `+20 −5` **todo dentro de
`@@ -81,11 +81,26 @@`** (el punto 8, AC-7). Neto **+15**, y `142 + 15 = 157`. La aritmética cierra
exacta.

- **Categoría**: veracidad de la evidencia · **CD-21**, que nombra este archivo con todas las letras:
  «Re-verificar **al cierre** toda cita a un archivo que esta HU edita. Aplica al header del
  guardián» (`story-HU-WKH-SEC-04.md:683-685`).
- **Por qué las tres rondas lo dejaron pasar**: AR, CR y los dos fix-packs barrieron **las citas que
  el dev escribió**. Ésta el dev **no la escribió: la desplazó**. Es la variante que la regla del
  `auto-blindaje.md:150-157` (`grep -rn "<archivo>:[0-9]"`) no cubre, porque el que cita es **el
  propio archivo editado** y no aparece en un grep por nombre de archivo.
- **Sugerencia**: `` `:140-142` `` → `` `:157-159` ``. Cero código ejecutable.

**Verificación de que es la ÚNICA de su clase.** El guardián tiene 27 citas (9 desnudas + 18 con
nombre). De las 9 desnudas, **una sola es auto-referencia**, y es la rota. Los otros 3 archivos donde
esta HU insertó líneas tienen sus auto-citas **correctas a HEAD**:

```
debit-capture.test.ts:12 → `:85`  = "      eq: () => builder,"                          ✅
debit-capture.test.ts:12 → `:469` = "        eq: () => builder,"                        ✅
debit-capture.test.ts:13 → `:539` = "    expect(calls.eq).toContainEqual(['owner_ref', OWNER]);" ✅
evidence.test.ts:12      → `:55`  = "    eq: () => b,"                                   ✅
evidence.test.ts:13      → `:42`  = "const OWNER = 'tenant-A';"                          ✅
```

### 1.3 · Las citas «desfasadas» que **NO** son hallazgo — el ancla, validada

| Artefacto | Ancla | Dónde lo declara | Verificada |
|---|---|---|---|
| `story-HU-WKH-SEC-04.md` | `b7fa4e7` | `:8-9` | ✅ 11/11 |
| `sdd.md` | `b7fa4e7` | `:7-8` | ✅ |
| `code-review.md` | `853ed66` | `:4` | ✅ 7/7 |
| `adversarial-review.md` | `99e3ed0` | `:3` | ✅ (muestreo) |

Las citas del Story File a los dos archivos que esta HU **sí** editó resuelven **exactas** en
`b7fa4e7` (11 verificadas). A HEAD ninguna resuelve, y eso es **correcto**: un documento de F2.5 no
puede citar números posteriores a la implementación que él mismo ordena.

### 1.4 · Dictamen sobre la excepción del dev para `code-review.md`

> El dev declara (`fix-pack-cr.md:244-249`) que **no** corrigió las citas de `code-review.md` a
> propósito, porque es el artefacto del revisor y documenta el estado en `853ed66`.

**Dictamen: el criterio es CORRECTO. No es una excusa para dejar citas rotas.** Validado con tres
medidas:

**(a) El ancla resuelve — 7 de 7.** Las citas del CR a `fee-split.ownership.test.ts` que el fix-pack
corrió +3 resuelven todas a su sujeto en `853ed66`.

**(b) El desfase está enumerado, no escondido.** `fix-pack-cr.md:245-249` lista exactamente esas 7
citas y la causa. `git diff 853ed66 HEAD -- src/services/fee-split.ownership.test.ts` confirma:
`@@ -262,10 +262,13 @@`, neto **+3**, todo debajo de `:265`.

**(c) Corregirlo sería peor.** Reescribir los números produce un documento que dice haber revisado un
texto que en ese momento no existía. En una HU cuyo tema es *prosa que afirma de más*, eso es afirmar
de más sobre el propio proceso.

**Lo único que le falta va como `MNR-4`**: `code-review.md` **nombra** su HEAD pero **no declara** que
sus citas estén ancladas a él.

---

## 2. ❌ `BLQ-1` — la frase que el AR refutó, viva en un CUARTO sitio, dentro de `src/`

- **Archivo:línea**: `src/adapters/escrow/debit-capture.test.ts:12-13` — **agregada por esta HU**
  (`+6 −0`, commit `edd8258`, W4). · **CD-7**

**Dice, textual:**

```
$ sed -n '11,13p' src/adapters/escrow/debit-capture.test.ts
 * ⚠️ WKH-SEC-04 — LÍMITE DE ESTE ARCHIVO: sus dobles NO aplican los filtros
 * (`:85` y `:469` son `eq: () => builder`) y su control de dueño es un espía de
 * argumento (`:539`), que pasa igual con el nombre de la columna mal escrito; el
```

**Es falso.** Repro **mío**:

```
$ python3 → src/adapters/escrow/debit-capture.ts:120
  ORIG|       .eq('owner_ref', ownerRef)
  MUT |       .eq('ownerRef', ownerRef)
$ git diff --stat   → 1 file changed, 1 insertion(+), 1 deletion(-)
$ ./node_modules/.bin/esbuild src/adapters/escrow/debit-capture.ts   → exit 0
$ node ./node_modules/vitest/vitest.mjs run src/adapters/escrow/debit-capture.test.ts
  ❯ src/adapters/escrow/debit-capture.test.ts:539:22
   Test Files  1 failed (1)
        Tests  1 failed | 19 passed (20)
$ git checkout -- … ; git status --porcelain   → vacío
```

**El espía SÍ caza la columna mal escrita.** `toContainEqual(['owner_ref', OWNER])` compara el par
exacto.

**Y el changeset se contradice a sí mismo.** A 30 líneas, en el archivo hermano ya corregido:

```
$ sed -n '47,52p' src/adapters/escrow/debit-capture.ownership.test.ts
 * Lo que ese espía SÍ caza es la columna mal escrita, y está medido: mutando
 * `debit-capture.ts:120` a `.eq('ownerRef', ownerRef)` … da `Tests 1 failed | 19 passed (20)`,
 * rojo en `:539`, porque `toContainEqual` compara el PAR exacto ['owner_ref', OWNER].
```

**Dos archivos del mismo merge afirman lo contrario sobre el mismo espía.**

- **Por qué se escapó**: `auto-blindaje.md:122-124` dice que la prosa viajó «del test al
  `mutation-log.md` y de ahí al `_INDEX-row.md`, y hubo que corregir los tres». Fueron **cuatro**. La
  cuarta no está aguas abajo en `doc/`: está **aguas al costado**, en el header ajeno de
  `debit-capture.test.ts`, escrito en la misma wave.
- **Por qué el CR no lo cazó**: `code-review.md:170` verificó los **punteros** (`:85`, `:469`, `:539`,
  los tres exactos) pero no la **afirmación** que los rodea. Es la lección de `auto-blindaje.md:111-112`:
  lo medido y lo supuesto conviven **con el mismo tono**.
- **Impacto**: instala en `src/` una afirmación falsa sobre la cobertura de un control del money-path
  y le baja el valor a un test que sí funciona.
- **Por qué BLOQUEANTE**: misma clase por la que el AR rechazó, nueva de esta HU, vive en `src/`, y
  **queda en contradicción abierta con un archivo del mismo commit**. Mergear con las dos frases
  garantiza que la próxima persona crea la equivocada.

---

## 3. Verificación de ACs — con evidencia propia

| AC | Status | Evidencia MÍA |
|---|---|---|
| **AC-1** | **PASS** | Mutantes propios: `arbiter.ts:1100` → `× AR-03` (`2 failed \| 5 passed`); `evidence.ts:96` → `× EV-04` (`2 failed \| 3 passed`); `evidence.ts:76` → `× EV-03`; `debit-capture.ts:120` → `× DC-03`. Las 7 funciones tienen test que **nombra su `archivo:línea` en el título** |
| **AC-2** | **PASS** | Mutante propio `fee-split.ts:618` → `× FS-03`, `1 failed \| 8 passed (9)`, esbuild exit 0. El hook `onUpdateStart` verificado **en ejecución** con sonda propia |
| **AC-3** | **PASS** | `evidence.ownership.test.ts:196-215` — «GRUPO B … **ESTO NO ES AISLAMIENTO ENTRE INQUILINOS**». Grupo C: `fee-split.ownership.test.ts:249`, `:358-362`. En el log: `mutation-log.md:197-203` |
| **AC-4** | **PASS** | `OWNER_A`/`OWNER_B` en los 5: `fee-split…:75-76`, `arbiter…:121-122`, `evidence…:60-61`, `reconciliation…:83-84`, `debit-capture…:123-124` |
| **AC-5** | **PASS** | `mutation-log.md:113-124`: 12 filas, cada una nombra un test distinto y cuenta aparte los 2 del guardián. **Re-medí 5 de 13, coinciden fila por fila** |
| **AC-6** | **PASS** | `git diff --name-only b7fa4e7 -- src` → **8**; filtrando `*.test.ts` y `__tests__/` quedan **0**. `git diff 853ed66 -- src` no-comentario → **0** |
| **AC-7** | **PASS** (con daño colateral, §1.2) | `+20 −5` dentro de `@@ -81,11 +81,26 @@`. El texto nuevo declara lo que sigue sin cubrir (el **valor** del filtro y los **42 `supabase.rpc()`**) y dice «⚠️ Y NO: quitar cualquiera de los 12 NO deja "la suite verde"» (`:99`). Ni el escáner ni las 41 excepciones se tocaron |

El único borrado en `owner-scoped-fake.ts` (`84 +`, `2 −`) son las **dos líneas del docblock que
declaraban la ausencia de `onUpdateStart`**: la modificación es genuinamente aditiva. ✅ CD-24.

---

## 4. Re-verificación de mutantes — 5 elegidos por mí

**Criterio**: los sitios con **menos verificación independiente previa** (los 5 que sólo tenían la
corrida del AR). Guardián **fuera de toda corrida**.

| Sitio | `git diff --stat` | Parseo | Rojos del archivo del sitio | AR §0 |
|---|---|---|---|---|
| `fee-split.ts:618` | `1 insertion(+), 1 deletion(-)` | exit 0 | `× FS-03` — `1 failed \| 8 passed (9)` | ✅ |
| `arbiter.ts:1100` | idem | exit 0 | `× AR-03` + `× AR-BS` — `2 failed \| 5 passed (7)` | ✅ |
| `arbiter/evidence.ts:76` | idem | exit 0 | `× EV-03` + `× EV-BS` — `2 failed \| 3 passed (5)` | ✅ |
| `arbiter/evidence.ts:96` | idem | exit 0 | `× EV-04` + `× EV-BS` — `2 failed \| 3 passed (5)` | ✅ |
| `debit-capture.ts:120` | idem | exit 0 | `× DC-03` + `× DC-BS` — `2 failed \| 3 passed (5)` | ✅ |

**Los 5 coinciden fila por fila.** Cada rojo **nombra su propio `archivo:línea` en el título**: ningún
par comparte firma. Árbol limpio después de cada uno.

**Cobertura acumulada: los 13 sitios tienen ≥2 verificaciones independientes.**

---

## 5. Cierre real de los hallazgos — repro propio

### 5.1 · Los 3 BLOQUEANTEs del AR

| # | Cerrado | Mi evidencia |
|---|---|---|
| `BLQ-BAJO-1` | **SÍ** | Verifiqué las 6 fuentes: migración `…wkh191a…sql:83-85` = `RAISE EXCEPTION 'OWNERSHIP_MISMATCH…'` ✅ · `debit-capture.ts:288` = `if (error) throw error;` ✅ · `:205-206`, `:212`, `:236-242`, `:247` ✅ |
| `BLQ-BAJO-2` | **NO — sólo 3 de 4 sitios** | Ver **`BLQ-1`** (§2). Corregido en `debit-capture.ownership.test.ts:43-52` ✅, `mutation-log.md:143-151` ✅, `_INDEX-row.md:21` ✅. **Vivo en `debit-capture.test.ts:13`** ❌ |
| `BLQ-BAJO-3` | **SÍ** | **Sonda propia**: `{"err":0,"warn":0,"info":0,"row_status":"pending","row_owner":"owner-B-0xbbbb","reported":"charged"}`. **Cero logs de cualquier nivel.** Y probé la refutación que el archivo ofrece (`:310-311`): agregando `expect(logSpy.error).toHaveBeenCalled()` → `1 failed \| 8 passed (9)`. **Falsable desde adentro de su propio archivo, tal como promete** |

### 5.2 · El BLOQUEANTE y los 3 MENORes del CR — los 4 cerrados

- `BLQ-BAJO-1` (CR): `sed -n '199,202p'` → `mockRpc.mockResolvedValue({` ✅ exacto, con la
  desambiguación escrita («de ESTE archivo»). **Control de la edición línea-neutra**: el bloque sigue
  midiendo 4 líneas (`:32-35`), así que las 3 citas de `doc/` siguen resolviendo ✅
- `MNR-1`: las 4 líneas anfitrionas y sus destinos verificados ✅
- `MNR-2`: corrí el grep **yo** → `20` hits, `1/6/7/6`, idéntico a lo declarado. Los 6 de
  `fee-split.ts`: `:640` definición, `:666`/`:680`/`:702` logs, `:18` y `:628` **comentarios** ✅
- `MNR-3`: medido **a pelo, sin pipe** → `tsc` exit 0, `biome` exit 0 ✅

### 5.3 · Los 2 extra que el dev encontró por su cuenta — verificados ✅

`fix-pack-ar.md:37` hoy dice `:199-202` y resuelve. `fix-pack-ar.md:246` hoy dice `:667-668`, que es
la prohibición real (`:696` era otro bullet).

**Además verifiqué las 20 filas de la tabla de barrido propia del dev** (`fix-pack-cr.md:148-166`,
`:285-289`), anfitrión por anfitrión. **Las 20 resuelven.** Es la parte más sólida de las tres rondas:
el dev midió **al final**, no durante, y se nota.

---

## 6. Los dos hallazgos de comportamiento declarados como deuda

**Coincido con el AR §3: deuda declarada, NO tarea propia.** Y ninguna frase afirma de más. Medí las
dos.

**(a) `chargeLeg` reporta `charged` con la escritura acotada.** Declaración en
`fee-split.ownership.test.ts:297-311`, que separa **dos caminos** y sólo uno deja rastro: (i)
`updateErr != null` → logueado (`fee-split.ts:540-547`, intencional según `:541-542`); (ii) UPDATE con
**cero filas** → `updateErr` es `null`, `:540-547` no corre, **ni una línea de log**. Medido: `0/0/0`.
La frase «divergencia MUDA» es la correcta. **Alcance bien declarado**: nada en el repo reescribe
`owner_ref`, riesgo hoy = 0.

**(b) `reverseFeeSplits` afirma la reversa entera sin filas matcheadas.** Sonda propia sobre FS-04:

```
QA_reversedCount: 1
QA_leg0:   { "status": "reversed", "txHash": "0xAAA-tx-de-A", "ownerRef": "owner-B-0xbbbb", … }
QA_row_status: "charged"        ← la fila persistida NO se reversó
```

La frase «NI el contador NI el payload son evidencia de que algo se haya reversado» (`:383`) es
**exacta**. **Alcance bien declarado**: `reverseFeeSplits` no tiene llamador de producción (los 20
hits viven en `fee-split.ts`, sus dos tests, y **un comentario** de `fee-charge.ts:677`). Impacto hoy
= 0; cuando se cablee, se vuelve una afirmación contable falsa. **Merece TD con ticket.**

---

## 7. Runtime / regresión

```
$ node ./node_modules/vitest/vitest.mjs run
 Test Files  273 passed | 6 skipped (279)
      Tests  5358 passed | 19 skipped (5377)
   Duration  10.10s

$ ./node_modules/.bin/tsc --noEmit ; echo "exit=$?"        → exit=0
$ ./node_modules/.bin/biome check src/ ; echo "exit=$?"    → Checked 472 files. exit=0
```

**Idéntico a la baseline.** Trampas de medición respetadas: `node ./node_modules/vitest/vitest.mjs`
(no `npx vitest`), binarios directos (no `npx biome`), y **ningún exit code leído después de una
tubería**.

Los 5 archivos nuevos aparte: `Test Files 5 passed (5)` · `Tests 28 passed (28)`.

---

## 8. Drift detection

| # | Control | Resultado |
|---|---|---|
| 1 | Scope IN vs Story File §5 | ✅ Los 11 previstos, ni uno más |
| 2 | Orden de waves W0→W4 | ✅ `a02355e` → `2037545` → `12824b8` → `edd8258` → `99e3ed0` → `853ed66` → `c09badc` |
| 3 | Spec drift (3 funciones clave) | ✅ Como las describe `sdd.md:348-353` |
| 4 | Test drift | ✅ Los 28 tests prometidos existen |
| 5 | CD-18 (frase prohibida) | ✅ Los 13 hits son la prohibición misma o el guardián `:99` declarándola falsa |
| 6 | Out of Scope (escáner + 41 excepciones) | ✅ El diff del guardián es todo `@@ -81,11 +81,26 @@` |
| 7 | «una línea de comentario» | ⚠️ **MNR-1** — se entregaron **6** en cada header ajeno |

---

## MENORes

- **`MNR-1`** — el Story File autorizaba «una línea de comentario» (`:667-668`) y se escribieron
  **seis** en cada uno de los dos headers ajenos. Cero ejecutable y contenido útil, pero es desviación
  literal no declarada. (En `debit-capture.test.ts` una de esas 6 es además el `BLQ-1`.)
- **`MNR-2`** — `adversarial-review.md:149` cita `owner-scoped-fake.ts:152` para «`onUpdateStart` es
  aditivo»; `:152` es `/**`. La declaración está en `:158` y el default en `:229`. El segundo puntero
  es exacto y es el que sostiene la afirmación: impacto nulo.
- **`MNR-3`** — la cita falsa `story:696` sobrevive en `adversarial-review.md:169`. El dev la corrigió
  en `fix-pack-ar.md:246` y lo documentó, **pero el desmentido nombra sólo ese archivo**, no el AR.
  Bajo la política (correcta) de no editar artefactos de revisor, falta **agregar
  `adversarial-review.md:169` a la lista de `fix-pack-cr.md`**.
- **`MNR-4`** — `code-review.md` nombra su ancla (`:4`) pero **no la declara**, como sí hacen
  `story:8-9` y `sdd:7-8`. Una línea en el blockquote, sin tocar un número.
- **`MNR-5`** — `_INDEX-row.md:21` sigue diciendo `in progress (F3 hecho; pendiente AR/CR/F4)`. Es
  trabajo de `nexus-docs`; lo anoto para que no se mergee así.

---

## Lo que NO pude verificar

1. **Que el RPC `capture_debit_signature` rechace contra una base viva.** Verificado **leyendo** la
   migración `:83-85` y `debit-capture.ts:288`. Ningún test del repo ejecuta ese RPC contra Postgres.
   **La limitación está correctamente declarada dentro del archivo que hace la afirmación**
   (`debit-capture.ownership.test.ts:32-35`).
2. **Que el caso (ii) de `BLQ-BAJO-3` se comporte igual contra PostgREST real.** Mi sonda corrió
   contra el falso.
3. **Las ~450 citas de `sdd.md` y `story-…md` que apuntan a producción**: resueltas mecánicamente (0
   fuera de rango) y revisada a mano una muestra de 45. Riesgo residual bajo: producción **no se tocó**,
   así que valen hoy lo que valían en `b7fa4e7`.
4. **Ningún check de DB/env/deployment**: la HU no toca migraciones, no agrega env vars, no despliega
   y no tiene superficie user-facing.

---

## Lo que quiero dejar dicho, porque lo verifiqué y se sostiene

El **núcleo técnico de la HU está entero y es de los buenos**: los 13 mutantes mueren por
comportamiento con el guardián fuera de la corrida (re-medí 5, coinciden fila por fila); el falso
compartido se extendió de forma genuinamente aditiva; la Clase B está declarada con las palabras
correctas y no se disfraza de IDOR; las dos deudas de comportamiento están medidas, no razonadas, y
ninguna afirma de más; no hay una línea de producción tocada; y la tabla de barrido del último
fix-pack resuelve **20 de 20**.

**Lo que falta son dos frases.** Una es falsa y contradice a su archivo hermano; la otra es un número
que la propia HU corrió. Las dos están **exactamente en el punto ciego del método que se usó para
cazarlas**: el barrido miró lo que el dev **escribió**, y estas viven en lo que el dev **desplazó** y
en lo que **copió a un archivo ajeno**. El control que las cierra a las dos, y que recomiendo dejar
escrito como regla:

> Después de la última edición, para **cada** archivo tocado:
> `git diff -U0 <base> -- <archivo> | grep '^@@'` da el punto de inserción y el delta.
> **Toda cita del propio archivo con número mayor a ese punto se re-mide, la haya escrito esta HU o
> no.** Y toda frase copiada a un archivo ajeno se re-lee **con la frase corregida al lado**, no sola.
