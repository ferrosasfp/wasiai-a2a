# AR Report — iteración 2 · HU 224 · WKH-362 · el guardián de citas

> Rama `feat/224-citas-archivo-linea-sin-testigo` · HEAD `06758af` · F3 `5af987e` · `main` `b31ddba` (intacto) ·
> nada pusheado.
> Diff del fix-pack: **5 archivos, 0 líneas en `src/`**.
> Árbol final: `git status --porcelain` = los 4 untracked de entrada, ni uno más.
> `doc/sdd/212-…/story-file.md` md5 `7904ef74a1c46d7880e0ca5d38e3eed4` — **intacto**.
>
> ⚠️ **Materializado por el orquestador**, verbatim. El adversary declaró **en su primera línea** que su política
> le impide escribir `.md`.

## VEREDICTO: **APROBADO con MENORes**

**Sin hedging**: los 4 BLOQUEANTEs de la it-1 están cerrados, verificados **ejecutando los mutantes en las dos
direcciones**, no leyendo la tabla del Dev. Los 5 MENORes están resueltos o declarados con costo medido. Las 3
puertas dan exactamente los números declarados. **Ningún BLOQUEANTE nuevo.** 6 MENORes, todos con repro ejecutable.

---

# 🔴 EL BARRIDO DE `TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS`

El Dev cerró la deuda con *"hasta que alguien lo busque, no sé si hay más"*. **Lo busqué. Hay uno más, y es peor
que el de `G-C10` porque nadie lo declaró.**

## Universo ENUMERADO (no buscado)
`test/` con `readFileSync` = **16 archivos** (el brief decía 15). Los 16, con su corpus y veredicto:

| # | Archivo | Corpus | ¿Se lee a sí mismo? | Veredicto |
|---|---|---|---|---|
| 1 | `agent-links.migration.test.ts` | `.sql` | no | OK |
| 2 | `cited-lines-guard.test.ts` | 14 paths + su propio archivo | **SÍ** | **ARREGLADO** (M10) |
| 3 | `docs-referenced-by-code-exist.test.ts` | `git ls-files` no-`doc/` **incluyéndose** | **SÍ** | 🔴 **VACUO — `MNR-it2-1/2`** |
| 4-6 | `hu198-…`, `hu202-…`, `negative-amount-guard.…` | `.sql` | no | OK |
| 7 | `ownership-filter-guard.test.ts` | `git ls-files -z src` (él vive en `test/`) | no | OK |
| 8 | `payment-guards-live-in-one-place.test.ts` | lista explícita de 3 `src/` | no | OK |
| 9 | `readme-numbers.test.ts` | configs + READMEs; el `toContain` es sobre **paths** | no | OK |
| 10 | `readme-parity.test.ts` | los 2 README | no | OK |
| 11 | `scripts-imported-by-tests-are-tracked.test.ts` | `readdirSync(test/)` **incluyéndose** | sí, **pero el regex exige `../`** | **OK — medido** |
| 12 | `sdd-index-matches-folders.test.ts` | `_INDEX.md` + `git ls-files src` | no | OK |
| 13 | `test-files-are-run-in-ci.test.ts` | paths + configs | no | OK |
| 14-16 | `verify-rls-enabled`, `wkh307-…`, `wkh315-…` | `.sql` | no | OK |

**Extendido más allá del universo declarado**: los **31** `src/**/*.test.ts` con `readFileSync`, filtrados por
*"¿barre un corpus que lo contiene?"* → **5 candidatos**, **los 5 clear**: tres usan listas explícitas;
`compose.stranded.test.ts:958` y `deposit-minimum.test.ts:28` **filtran `.test.` fuera del barrido**; y
`src/__tests__/discover-callsites.test.ts` **se excluye explícitamente** (`const SELF = …` en `:126`, aplicado en
`:272`).
🎯 **Ese `SELF` es arte previo del propio repo para este defecto**, y es una **segunda forma de arreglo** distinta
del recorte de cabecera. Vale que el Dev lo mire.

## `MNR-it2-1` · un control que NO PUEDE ponerse rojo, en `main`, sin declarar
**`test/docs-referenced-by-code-exist.test.ts:52` + `:258-273`**
```ts
:52   const ROOT_DOCS_CITED_BARE = ['CLAUDE.md'] as const;
:258  it('la lista declarada NO está de adorno: el código realmente cita esos documentos', () => {
:261    const code = codeFiles().map(f => readFileSync(...)).join('\n');
:271      expect(code, `${doc} ya no lo cita ningún archivo de código`).toContain(doc);
```
`codeFiles()` (`:121-125`) = `git ls-files` filtrado a no-`doc/` + extensión de código. **Este archivo es `.ts`, no
vive en `doc/`, y está trackeado ⇒ está dentro de su propio corpus.** El literal `'CLAUDE.md'` de `:52` **es parte
de `code`**. El control se satisface con su propia declaración.

**Reproducción ejecutada**:
```
mutante: :52 'CLAUDE.md' -> 'ZZQ-DOC-QUE-NO-EXISTE-EN-NINGUN-LADO.md'
=> passed=3 failed=1/4
   ROJO:  los documentos de raiz que el codigo cita por nombre siguen en el repo  (:248 - OTRA afirmacion)
   VERDE: la lista declarada NO esta de adorno...                                 <- el control auditado
```
**Es el mismo mecanismo, la misma prueba y el mismo resultado** que el hallazgo del Dev en `G-C10`.

**Impacto**: si mañana alguien borra las menciones a `CLAUDE.md` de `src/` (medido: **19 archivos de código la citan
hoy, 5 de ellos `src/` no-test**), el control cuyo nombre literal es *"la lista declarada NO está de adorno"*
**sigue verde**. El comentario `:259-260` promete lo que no puede entregar: *"Si alguien borra las citas, la lista
queda vieja… Esto lo detecta."* **No lo detecta.**
**Sugerencia**: excluir el propio archivo del corpus, con el patrón que ya existe en `discover-callsites.test.ts`.
La cabecera `:131-135` **ya sabe** que *"el guardián se escanea a sí mismo"* — esa nota se usó para evitar un falso
positivo y **no se usó para notar la auto-satisfacción**.
**Alcance: FUERA del Scope IN.** Código pre-existente en `main`. **No bloquea.**

## `MNR-it2-2` · el control de armado del mismo archivo también se auto-satisface
**`:233`**: `expect(refs.map(r => r.docPath)).toContain('doc/QUICKSTART-PUBLISH.md')`. `refs` sale de
`pathShapedDocRefs()`, que barre `codeFiles()` — que incluye este archivo ⇒ **la línea 233 se produce a sí misma
como `ref`**.
**Reproducción**: literal → `doc/ZZQ-NO-EXISTE…` ⇒ el control auditado **VERDE**; el rojo vino de **otro** test.
Medido: hoy sólo **2** archivos citan ese doc, **y uno de los dos es este test**. **Fuera de Scope IN.**

---

# LOS 4 BLOQUEANTES DE LA IT-1 — CERRADOS, EN LAS DOS DIRECCIONES

**Método**: worktree detached en `5af987e` con `node_modules` enlazado; arnés propio con copia + md5 pre-registrado
(**nunca `git checkout --`**), aborto si el ancla no aparece exactamente N veces, restauración en `finally`
verificada por md5, reporter JSON con **la raíz validada adentro del JSON**, **nunca el exit code**. Filtrado el
warning `Failed to load source map` que dio el falso `PARSE_ERROR` en la it-1. Worktree eliminado.

| # | Mutante | ANTES (`5af987e`) | DESPUÉS (`06758af`) | Mata |
|---|---|---|---|---|
| **M1** | cita real P1 movida a `SCANNER_FALSE_POSITIVES` con excusa de 40+ chars | **10/10 VERDE** ✅ replicado | **11/12 MUERE** | `G-C8` |
| **M2-cal** | `https://x.io:8443/y` declarado ruido (**el input exacto de la it-1**) | 12/12 | **12/12 VERDE** — el ruido legítimo sigue declarable | — |
| **M10** | literal del assert de `G-C10` → cadena imposible | **10/10 VERDE** ✅ replicado | **11/12 MUERE** | `G-C10` |
| **M7** | `citeTargetIfTracked` → siempre `null` | n/a | **11/12 MUERE** | `G-C11` |
| **M8** | `delegationFindings` → siempre `[]` | n/a | **11/12 MUERE** | `G-C12` |

## 1 · `BLQ-ALTO-1` — **CERRADO**
`citeTargetIfTracked()` (`scanner.ts:251-267`) aplicada en `G-C8` (`test.ts:1070-1081`).
**El 31/19 — VERIFICADO, exacto**: derivado con `citeNamesFile` sobre `CITED_LINES`, **31 de 50** tienen archivo en
el token, **19 no**; y las 31 resuelven **todas** a un archivo trackeado ⇒ **hoy la protección es completa sobre ese
subconjunto**. El límite está escrito **en los dos lugares donde se lee**: `exceptions.ts:39-46` (donde se escribe
la excusa) y `test.ts:1065-1069` (al lado de la ejecución).

**Bordes atacados**:
- ✅ `./` y `../` resueltos contra el citador (`./payment-spec-writer.ts:1`, `../services/compose.ts:688`,
  `../../src/services/compose.ts:688`) → todos resuelven. **Sin bypass.**
- ✅ Sufijo alineado por segmento: `ypes/database.types.ts:2567` → `null`. Correcto.
- ✅ Basename ambiguo (`index.ts` = 9 candidatos) → `candidates[0]`: **el lado seguro** (cualquier candidato ⇒
  no-`null` ⇒ bloqueado); el path elegido sólo viaja al mensaje.
- ⚠️ Mayúsculas en FS case-insensitive → `null`. Población hoy 0, `git ls-files` es case-exacto. **No es finding.**
- 🔴 **Archivo que existe en disco y NO está en el índice** → `MNR-it2-4`.

## 2 · `BLQ-MED-1` — **CERRADO**, y el ataque pedido: **SÍ, se puede**
`G-C9` usa `delegationFindings()` (`test.ts:321-395`), probada por `G-C12` en las dos direcciones.
Escribí un dueño que **nombra** el target y **no lo vigila**, **sin inventar nada** — usando un archivo ya en `main`:
```
DELEGATED_TARGETS += { target: 'src/lib/downstream-payment.ts',
  ownedBy: 'los invariantes de money-path en src/lib/money-invariants.fuzz.test.ts',
  ownerFiles: ['src/lib/money-invariants.fuzz.test.ts'], ownerControls: ['money-path FUZZ'], reason: <41+ chars> }
+ borrar las 4 declaraciones de downstream-payment.ts
=> 12/12 VERDE.  4 citas del modulo de liquidacion del money-path fuera del universo.
```
El dueño falso **existe**, **corre**, **sus controles siguen escritos** y **nombra el target** — pero lo nombra **en
un comentario** (`money-invariants.fuzz.test.ts:14`), y **no verifica una sola cita**.

**NO es BLOQUEANTE nuevo**, por calibración y no por tolerancia: el Dev **declaró exactamente este límite** en
`test.ts:313-319` (*"NO comprueba que el dueño efectivamente VERIFIQUE las citas… presencia, no valor… lo que ya no
puede es inventarlo"*), y el exploit **no inventa, repurpone**. La declaración es **verdadera**.
⚠️ **El dato asimétrico que sí merece decirse**: `SCANNER_FALSE_POSITIVES` recibió un candado **mecánico**;
`DELEGATED_TARGETS` recibió uno de **presencia** — y la delegación es **la más barata de las dos**, porque **una
entrada saca N claves de una vez** (4 acá) contra 1 de la otra. **El interruptor más barato que queda es la
delegación.**

## 3 · `BLQ-BAJO-1` y `BLQ-BAJO-2` — **CERRADOS, y la 4ª que el Dev encontró también**
Población **derivada y verificada**: `UNICITY_EXCEPTIONS` = 3, `SCANNER_FALSE_POSITIVES` = 3, `UNANCHORABLE_PROSE`
= 0, con cabeceras que dicen **"al 2026-08-19 … es una FOTO, derivala"**.
Verificado **por derivación** que las claves con más de una ocurrencia son **exactamente 3**, con **4 ocurrencias de
más** (`:00`×2, `.gitignore:185`×3, `.gitignore:190-193`×2) = **57 tokens − 53 claves**.

**La decisión de NO hacer cierto el rojo del duplicado: CORRECTA, no una excusa elegante.** Dos razones:
1. Un `nth` es un **índice posicional** derivado del orden del documento: se pudre con cualquier inserción arriba.
   **Misma clase que el `fromLine` que el invariante prohíbe.**
2. **Y sobre todo: un `nth` no compraría nada verificable.** Todas las ocurrencias del mismo token en el mismo
   citador afirman **lo mismo** (mismo `target`, misma `line`, mismo `mustContain`). Lo único que las distingue es
   la prosa alrededor, que el guardián **declara que no verifica**. Sería un campo frágil a cambio de **cero poder
   de detección**.

## 4 · `G-C11` / `G-C12` — matan lo que dicen, y **apareció el tercer arreglo trucho** (`MNR-it2-3`)

---

# LOS 5 MENORES DE LA IT-1 — DECISIONES VERIFICADAS

### `MNR-1` (`Dockerfile:12`) — **abstención CORRECTA**, y hay una segunda consecuencia más fuerte
Medido aplicando el arreglo mínimo y barriendo los 14 paths:
- Consecuencia declarada — **CIERTA**: aparecen 3 tokens nuevos con forma de archivo, **exactamente el ruido que
  hoy está en `SCANNER_FALSE_POSITIVES`** (`reputation:100`, `minLength:1`, `2026-01-01T00:00`).
- 🔴 **Consecuencia NO escrita, y es la decisiva**: ese mismo arreglo **DECAPITA el dotfile** — `.gitignore:185`
  pasa a matchear como `gitignore:185` ⇒ **re-rompe exactamente el punto ciego que esta HU arregló**, del que
  dependen las 5 correcciones de `sdd-index-matches-folders.exceptions.ts`.
- Matiz honesto: la justificación generaliza de **un** arreglo candidato a **todos**. Un allowlist
  (`Dockerfile|Makefile|Procfile`) no tendría ninguna de las dos consecuencias, y `scanner.ts:65` dice que ya barrió
  esos nombres con **población 0**. **Diferir sigue siendo correcto** (degrada RUIDOSO: `G-C4` rojo). **No es
  finding**, es una precisión.

### `MNR-2` — **VERIFICADO**. La vara está donde vive la escalera (`exceptions.ts:75-98`), con el par que la fija y
el desempate («no tocar»). Coherente con el precedente del `tsconfig.json:19`.

### `MNR-3` — **entró y creció.** Es el hallazgo del control vacuo.

### 🎯 `MNR-4` (los tokens sin testigo) — **el desglose es EXACTO. La decisión es correcta, sin hedging.**
Derivado con `scanSource` sobre los 4 archivos, independientemente:

| Afirmación del docblock | Medido | ✓ |
|---|---|---|
| **243** tokens (`test` 61 · `citations` 100 · `exceptions` 45 · `scanner` 37) | 243 (61·100·45·37) | **exacto** |
| **87** son el campo `cite` de una entrada declarada | 87 | **exacto** |
| **97** son `:N` sueltos | 97 | **exacto** |
| **23** nombran archivos que no existen (fixtures) | 23 | **exacto** |
| **36** nombran archivo trackeado | 36 | **exacto** |
| 🪞 de esos 36, **9** son el token histórico `.gitignore:172` | **9** (`test.ts:90,187,670,710` · `citations.ts:380` · `scanner.ts:51,112,113,118`) | **exacto** |

**El argumento decisivo es cierto**: incluir los 4 paths convertiría **9 menciones del bug que esta HU arregló** en
9 citas rotas, más 23 excusas por fixtures. **La decisión de declarar y no incluir es la correcta**, y
`TD-224-CITAS-DEL-PROPIO-GUARDIAN` la nombra con **el arreglo real** (*"un corte que distinga un token que AFIRMA de
uno que es DATO"*), no con el atajo.
*Precisión sin severidad*: de los 23, **2 no son fixtures** — son `.nexus/project-context.md`, que **existe en
disco** y cuyo tracking es decisión abierta. «No existen **ni pueden**» es fuerte de más para ese par. **No cambia
la decisión, no es finding.**

### `MNR-5` — **VERIFICADO.** Los dos README publican **296** y `npm test` cuenta **296**. No hizo falta tocarlos, y
**no es fe**: `readme-numbers.test.ts` los pondría rojos.

---

# LOS 6 MENORES NUEVOS

### `MNR-it2-3` · 🎯 **el TERCER arreglo trucho: `G-C11`/`G-C12` prueban la REGLA; nada prueba su APLICACIÓN**
`test.ts:1070-1081` (la aplicación) vs `:1254-1311` (`G-C11`, el testigo). Los dos testigos usan **fixtures en
memoria**. **Nada verifica que `G-C8` APLIQUE `citeTargetIfTracked` al registro real.** Dos truchos, **los dos
medidos, los dos 12/12 VERDE**:

**Trucho A — debilitar la APLICACIÓN, no la regla**:
```ts
for (const e of SCANNER_FALSE_POSITIVES) {
  if (e.reason.trim().length > 150) continue;   // <- 1 linea, cara inocente
```
\+ M1 ⇒ **12/12 VERDE**. **`BLQ-ALTO-1` reabierto.**

**Trucho B — devolver algo NO vacío pero inútil**: resolver **sólo** los basenames que los fixtures de `G-C11`
usan ⇒ `G-C11` **12/12 VERDE** (sus 6 casos positivos son justo ésos). **Exploit completo**: trucho B +
`downstream-payment.ts:772` a la lista de ruido ⇒ **12/12 VERDE**, una cita real del money-path fuera del universo.

**Por qué es MENOR y no BLOQUEANTE** (explícito porque se consideró): no rompe ningún AC, no expone
vulnerabilidad, no pierde datos, y **exige editar el guardián mismo**, visible en cualquier diff. Pero es **el
residual de mayor valor**, porque el encabezado de `:1245-1252` dice *"un candado sin testigo es una línea de código
que nadie midió"* — **y el testigo construido cubre la regla, no su uso**.
**Sugerencia**: un fixture **NEGATIVO dentro de `G-C8`**, sobre el registro real. Cierra los dos truchos con un
control, porque atraviesa la función **y** su aplicación.

### `MNR-it2-4` · **la SEGUNDA salida de emergencia, no declarada**
`exceptions.ts:39-46` y `test.ts:1065-1069`. El párrafo 🚧 declara **una** salida (un token sin archivo). **Hay una
segunda**: un token que **sí** nombra un archivo, pero **que existe en disco y NO está en el índice de git**,
también devuelve `null` y también se puede declarar ruido.
**Reproducción end-to-end ejecutada**: una cita a `.nexus/project-context.md:6` en un archivo del Corte A +
su entrada en la lista de ruido ⇒ **12/12 VERDE**.
**La asimetría que lo hace defecto**: la misma cita **en `CITED_LINES`** pone el guardián **rojo**
(`E-TARGET_MISSING`, `test.ts:440-450`); **declarada ruido, pasa en verde**.
**Impacto**: población hoy **0** dentro del corte. **Es una frase que falta, no un agujero abierto.**

### `MNR-it2-5` · el **31 de las 50** no cumple la regla que el propio fix-pack escribió
`exceptions.ts:43-44` · `test.ts:1068-1069`. El fix-pack cerró `BLQ-BAJO-2` con la regla *"todo número va con fecha
y la palabra FOTO"* y la aplicó bien en dos cabeceras. **El número que el mismo fix-pack introduce** dice sólo
*"Del registro de hoy, 31 de las 50…"*: **sin fecha, sin FOTO, sin derivación, y sin nada que lo ponga rojo**.
Hoy es exacto (derivado: 31/19), así que **todavía no miente**.

### `MNR-it2-6` · la delegación: el límite está declarado, pero no dice **cómo se cae**
`delegationFindings` (`test.ts:377-393`) satisface *"el control sigue escrito"* y *"nombra el target"* con un
`includes` sobre el fuente **crudo** ⇒ **un comentario alcanza**. El repo **ya tiene el instrumento** para
distinguirlo: `codeOnly()` en `payment-guards-live-in-one-place.test.ts:45-55`.
**Sugerencia**: o exigir la coincidencia **en código y no en prosa**, o **escribir que el comentario cuenta**.

---

# LAS 11 CATEGORÍAS

| # | Categoría | Veredicto | Evidencia |
|---|---|---|---|
| 1 | Security | **N/A** | **0 líneas en `src/`**. Cero runtime, auth, input de red o secretos |
| 2 | Error Handling | **OK** | `delegationFindings` hace lecturas defensivas por campo (`:330-337`) porque **el archivo no lo typechequea CI**; probado con un fixture `as unknown as`. `G-C9` envuelve `readTracked` en try/catch y distingue «no trackeado» de «no legible» |
| 3 | Data Integrity | **N/A** | Sin DB, sin escrituras, sin concurrencia |
| 4 | Performance | **OK** | `SRC_CACHE` y `SF_CACHE` evitan re-parseo; el guardián no entra entre los 6 archivos más lentos (techo: 9,0 s) |
| 5 | Integration | **OK** | `citeTargetIfTracked` es export **nuevo**; los 7 existentes mantienen firma. Sin consumidores fuera de los 4 archivos. 296/296 sin regresión |
| 6 | Type Safety | **OK** | `tsc --strict --noUncheckedIndexedAccess` sobre los 4 ⇒ **0**. El único `as unknown as` construye una entrada **inválida en runtime** para probar la lectura defensiva. Sin `any` |
| 7 | Test Coverage | **MENOR** | `MNR-it2-3` (regla probada, aplicación no) · `MNR-it2-6` · `MNR-it2-1/2` (fuera de scope) |
| 8 | Scope Drift | **OK** | 5 archivos, **0 en `src/`**, 0 configs, 0 README |
| 9 | Destructive Migrations | **N/A** | Cero `.sql` |
| 10 | RPC `SECURITY DEFINER` | **N/A** | Ninguna función Postgres |
| 11 | Cache Invalidation | **OK** | `SF_CACHE` **compara el fuente antes de reusar** (`scanner.ts:383-384`) ⇒ un mismo path con contenido distinto **no** devuelve un AST viejo — **exactamente el bug que el arnés de mutación habría disparado** |

---

# LAS 3 PUERTAS — RE-MEDIDAS, TODAS EXACTAS

| Puerta | Declarado | Medido |
|---|---|---|
| `npm test` | 296 · 5781 · 5762 passed · 19 pending · 0 failed | **296 · 5781 · 5762 · 19 · 0 failed · exit 0**, `testResults[*].name` **todos** bajo `/wasiai-a2a/` (validado **adentro del JSON**) |
| `tsc --noEmit` | 0 | **0** |
| `biome check src/` | 0 (489) | **0**, «Checked 489 files» |

### 🎯 El dato sobre `tsc` — **CONFIRMADO, y sí está declarado donde se lee**
`tsconfig.json:19` es `"include": ["src/**/*"]` y `package.json:11` es `"lint": "biome check src/"`. **Medido, no
deducido**: `npx tsc --noEmit --listFiles | grep -c cited-lines-guard` ⇒ **0**. **El `tsc` verde de la puerta NO
cubre ni un archivo de esta HU.** Typechequeados aparte ⇒ **0 errores**.
**¿Declarado donde se lee? SÍ, en tres lugares, y uno es el correcto**: `citations.ts:50-53`, `exceptions.ts:100-102`
y —el que importa— el comentario de `G-C8` (`test.ts:982-987`) **más el mensaje de error del assert** (`:1101-1102`),
que es **lo que aparece en la salida de CI cuando falla**. Y no es prosa decorativa: es **la razón de diseño** de que
`G-C8` valide la forma en runtime en vez de por tipo.

---

# INSTRUMENTOS Y LÍMITES — con esas palabras
`/usr/bin/git` para todo git · `command grep -n` en todos los barridos · `git ls-files` vía `/usr/bin/git` y
`execFileSync` · **nunca redirigí vitest**: reporter JSON + parseo con Node · **nunca leí un exit code tras un
pipe**; la raíz se validó **adentro del JSON** · **filtrado el `Failed to load source map`** que dio el falso
`PARSE_ERROR` en la it-1 · scratchpad en **directorio único** · arnés con copia propia + md5 pre-registrado, aborto
por ancla no única, restauración en `finally` verificada por md5, **cero `git checkout --`**; las 11 corridas
restauraron OK y `git status --porcelain` final = idéntico al inicial · worktree creado, usado y **eliminado**.

**Lo que NO pude medir:**
- **No medí la VERDAD de la prosa** que rodea a las citas. Verifiqué números y anclas, no afirmaciones.
- **No barrí `doc/`, `scripts/`, `mcp-servers/` ni `packages/`** buscando el patrón auto-satisfactorio. Cubrí los 16
  de `test/` más los 31 `src/**/*.test.ts` filtrados. **Fuera de eso no sé si hay más**, y el filtro deja pasar
  variantes que no enumeré.
- **No corrí la suite completa bajo cada mutante**: cada uno corrió sólo su archivo.
- **No re-derivé el denominador** (749 / ~20.550). El fix de `G-C10` **dejó de depender de él** (verificado).
- **No ejecuté nada contra producción.** Cero red, cero Railway, cero Supabase, cero `pkill`.
- **No probé el guardián en un clone fresco.**

**Observación para el orquestador (no es finding contra el Dev)**: `sdd.md` y `story-file.md` están **untracked**
mientras `work-item.md`, `auto-blindaje.md` y `_INDEX-row.md` **sí** están trackeados. **El contrato contra el que se
implementó no está en git.** Resolverlo antes de F4/DONE, o el pipeline pierde sus propios artefactos.

# ORDEN SUGERIDO (ningún BLOQUEANTE — backlog, no gate)
1. **`MNR-it2-3`** — el fixture negativo dentro de `G-C8`. Cierra los dos truchos con un control. **Mayor retorno.**
2. **`MNR-it2-4`** — una frase: la segunda salida de emergencia.
3. **`MNR-it2-6`** — `codeOnly` en `delegationFindings`, o escribir que el comentario cuenta.
4. **`MNR-it2-5`** — fecha + FOTO + cómo derivar el 31/50.
5. **`MNR-it2-1` / `MNR-it2-2`** — **fuera de Scope IN**, vehículo a decidir fuera de este gate.

**Deuda abierta con su nombre**: `TD-224-CITAS-DEL-PROPIO-GUARDIAN` · `TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS`
(**ahora con inventario: 1 archivo más**) · `TD-316-CITAS-DOTFILE-EN-OTROS-CORTES` · `TD-316-CITAS-PROJECT-CONTEXT`.
