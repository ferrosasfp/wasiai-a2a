# SDD — [WKH-371] El discriminador de citas sueltas

> **Fase F2 · Rol `nexus-architect` · 2026-08-28 · `main` @ `1e5a6aa`, working tree LIMPIO**
> Input: `doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/work-item.md` (HU_APPROVED)
> Issue de origen: `ferrosasfp/wasiai-a2a#178` — **leído entero en este F2, cierra MI-1**

---

## 0. Cómo leer las citas de este documento

1. **Este documento numera el árbol de HOY** (`main` @ `1e5a6aa`, `git status --porcelain`
   vacío). Igual que el work-item y que la fila 226 del `_INDEX.md`, **NO se re-ancla**
   cuando el código se mueva: es un registro de lo que se midió un día. **CD-5 lo prohíbe.**

2. **Procedencia de cada afirmación:**
   - `[MEDIDO-F2]` = lo derivé yo, en esta corrida, con un comando que está escrito acá al lado.
   - `[VERIFICADO]` = venía `[HEREDADO]` del F1 o del orquestador y lo re-medí. Si el número
     cambió, digo los dos.
   - `[REFUTADO]` = venía heredado y **es falso**. Digo con qué lo medí.
   - `[NO MEDIDO]` = sigue sin instrumento. Es una ausencia, no un cero.

3. **Toda la medición de este F2 salió de un prototipo desechable** en el scratchpad
   (`measure.ts` / `oracle.ts` / `variants.ts` / `census.ts`), que **importa el escáner REAL
   del repo** (`test/cited-lines-guard.scanner.ts`) en vez de re-implementarlo.
   ⚠️ **Control de instrumento corrido**: el prototipo re-deriva el índice de carácter de cada
   token con las mismas regexes, y se comparó su conteo contra `scanSource` archivo por archivo:
   **1706 archivos, 0 divergencias** `[MEDIDO-F2]`. Sin ese control, cualquier número de acá
   podría ser un defecto de mi herramienta y no del repo — que es exactamente el modo de falla
   «mi herramienta de medición fabricó un bug».
   ⛔ **Ese prototipo NO es el entregable.** El entregable lo escribe F3 dentro del escáner del
   repo (DT-5). Los números de acá son la **hipótesis medida** que F3 tiene que reproducir.

---

## 1. Resumen ejecutivo — y el hallazgo que da vuelta el F1

El F1 propuso una cascada D0–D4 y midió **11 de 11 = 100 %** sobre el archivo del que había
sacado las reglas, declarando que ese número **no valía** y volviéndolo `AC-2`.

**Este F2 hizo la medición que faltaba, y el resultado es peor de lo que el F1 temía.**

Existe en el repo un conjunto **hand-labelled, preexistente y causalmente anterior** a esta HU:
las **19 entradas de `CITED_LINES` cuyo token es P3/P4** (un `:N` suelto), cada una con su
`target` resuelto A MANO por un humano, escritas entre el **2026-08-19 y el 2026-08-27** en
WKH-362/225/335/366/370 `[MEDIDO-F2: git log sobre test/cited-lines-guard.citations.ts]`, más
las **3 entradas de `SCANNER_FALSE_POSITIVES`** (4 ocurrencias), que son RUIDO etiquetado a mano.
**Ese conjunto es un oráculo: nadie lo escribió mirando la salida de un clasificador que no
existía.**

Corriendo la cascada del F1 contra ese oráculo `[MEDIDO-F2]`:

| | valor |
|---|---|
| Recall de la cascada del F1 (`CITA` **con el target correcto**) | **4 de 19 = 21 %** |
| Falsos negativos **silenciosos** (etiquetados `RUIDO`, o sea que desaparecen) | **5** |
| Falsos positivos sobre las 4 ocurrencias de RUIDO etiquetado | **0** |

⇒ **El 100 % del F1 era 21 %.** Y el modo de falla dominante tiene nombre y es estructural:

> 🔴 **LA AUTO-CITA.** Cuatro de los cinco FN silenciosos son citas de un archivo **a sí mismo**
> (`src/types/index.ts:288` cita `` `:203-225` `` del propio `index.ts`; `src/services/compose.ts:751`
> cita `:634` del propio `compose.ts`; `src/routes/agents.ownership.test.ts:13` cita `` `:72` `` y
> `` `:76-77` `` de sí mismo). **D3 exige que el párrafo nombre un archivo — y cuando alguien habla
> de su propio archivo no lo nombra nunca.** Las cuatro fueron abiertas y leídas (§5.2).

Corregida la cascada (§7), el recall sube a **16/19 = 84 % con 0 FN silenciosos**, sin perder
ninguno de los RUIDO etiquetados. Ese es el entregable que este SDD especifica, junto con la
**muestra reservada** que lo tiene que medir de verdad (§8) — porque el oráculo de arriba, aunque
independiente, **sólo tiene ejemplos de la clase CITA y de 3 RUIDO**: no puede dar precisión.

---

## 2. Línea base del gate `[MEDIDO-F2]`

⛔ **`npm run qa` NO EXISTE en este repo.** El gate es la secuencia de `.github/workflows/ci.yml`
(steps «Typecheck» → «Lint» → «Test», verificados leyendo el workflow):

```
git add -A                              # CD-7: readme-numbers.test.ts enumera con `git ls-files`
npx tsc -p tsconfig.json --noEmit       # → TSC_EXIT=0
npm run lint                            # → "Checked 520 files in 239ms. No fixes applied." exit 0
npm test                                # → Test Files 314 passed | 6 skipped (320)
                                        #   Tests     6350 passed | 19 skipped (6369)
```

Corrido **una vez, completo y en orden**, sobre el árbol limpio de `1e5a6aa`.
**Coincide exactamente con la línea base que el encargo predecía** (`tsc 0 · lint 520 ·
314/320 · 6350/6369`). ⇒ La línea base del work-item queda `[VERIFICADO]`.

> ⚠️ El `npm test` emite un `Failed to load source map for typescript.js` de vite. Es ruido
> preexistente, exit 0, **no es un fallo** — anotado para que F3 no lo lea como regresión.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos en esta corrida

| Archivo | Por qué | Qué saqué |
|---|---|---|
| `test/cited-lines-guard.scanner.ts` (529 líneas, **leído entero**) | Es donde va el discriminador (DT-5) | Las 4 formas P1–P4, `FILE_CITE_RE` (`:121-122`), `BARE_CITE_RE` (`:125`), el descarte `::N` (`:192`), y **el defecto de §5.3** |
| `test/cited-lines-guard.test.ts` (1685 líneas; docblock 1-235 + índice de bloques) | El patrón de los controles y la lista de no-cobertura | `G-C1..G-C12`; el patrón «fixture en memoria en las dos direcciones» de `G-C2`/`G-C3`/`G-C11` |
| `test/cited-lines-guard.citations.ts` (774 líneas) | El registro y **el oráculo de §5** | `CitedLine`, `CORTE_A_PATHS` (14 paths, `:87-102`), `targetReason` |
| `test/cited-lines-guard.exceptions.ts` (278 líneas) | Es el archivo de **calibración** del F1 ⇒ hay que excluirlo | Las 3 listas y sus candados; `SCANNER_FALSE_POSITIVES` (`:248-278`) |
| `src/adapters/chain-resolver.ts` (446 líneas) | La «quinta forma» del F1 (opción C) | **0 tokens `:N`** confirmado; referencias por nombre de archivo sin número |
| `tsconfig.json` (21 líneas) | MI-7 | `"include": ["src/**/*"]` (`:19`) ⇒ **`test/` NO se typechequea** |
| `biome.json` (40 líneas) | El costo de la opción A | `files.includes: ["src/**/*.ts"]` (`:9`) ⇒ **Biome no toca `test/`** |
| `package.json` (`:11`) | Ídem | `"lint": "biome check src/"` |
| `.github/workflows/ci.yml` | El gate real | Typecheck → Lint → Test, en ese orden |
| `.gitignore` (`:180-196`) | ¿`doc/` es alcanzable? | Sí: excluye archivos de `doc/sdd/**` **de a uno**, no el árbol |
| `src/lib/capability-risk.ts` (`:82`) | CD-9 | **CD-9 nombraba el archivo equivocado** — ver §11 |
| `doc/sdd/{229,230,231}/auto-blindaje.md` (encabezados) | Auto-Blindaje histórico | Los 5 patrones recurrentes de §11.3 |
| Issue `#178` (vía `gh issue view`) | MI-1 | Cierra MI-1 — §4.3 |

### 3.2 Exemplars verificados (existen, path confirmado, leídos)

| Exemplar | Qué patrón se copia |
|---|---|
| `test/cited-lines-guard.scanner.ts` → `citeTargetIfTracked` (`:251-267`) | ✅ **existe donde el F1 dijo, y se reusa** (DT-2). Es la resolución contra el ÍNDICE de git |
| `test/cited-lines-guard.scanner.ts` → `scanSource` (`:161-207`) | Función pura sobre texto; el discriminador va al lado, con la misma firma-estilo |
| `test/cited-lines-guard.test.ts` → `G-C11` (`:1484`) | **El control en las DOS direcciones con fixtures en memoria**: mata la cita real y deja pasar el ruido. Los controles nuevos se calcan de acá |
| `test/cited-lines-guard.test.ts` → `G-C2` (`:745`) | Fixture en memoria con respuesta conocida de antemano, para que el escáner no se compare contra su propia salida |
| `test/ownership-filter-guard.scanner.ts` + `.exceptions.ts` | El par «parser puro + excusas escritas a mano leyendo el sitio» |
| `test/cited-lines-guard.citations.ts` (`:460-500`) | La forma de una entrada con `targetReason` para un token P3/P4 |

### 3.3 El exemplar que vale más que todos: el `targetReason` ya escribe D3 en prosa

`test/cited-lines-guard.citations.ts:482-491` declara `` `:95` `` en `src/lib/operator-address.ts`
con este motivo, escrito a mano en agosto:

> «El archivo lo nombra **la línea inmediatamente anterior del mismo docblock**
> (`getSolanaOperatorKeypair()` (`../adapters/solana/chain.ts:84`)), y las tres citas de esa
> oración —`:84`, `:95`, `:137-149`— hablan del mismo archivo.»

⇒ **D3 no es una heurística nueva: es la formalización mecánica de lo que los humanos de este
repo ya escriben a mano, entrada por entrada.** Eso es lo que hace que el oráculo de §5 sea un
oráculo y no una coincidencia.

---

## 4. El censo — todos los números, derivados hoy (AC-3, AC-8)

### 4.1 Población, con perímetro y patrón declarados en la misma frase (CD-1)

**Patrón**: las 4 formas de `scanSource` de `test/cited-lines-guard.scanner.ts` @ `1e5a6aa`.
**Universo**: el ÍNDICE DE GIT (`git ls-files`), no el disco. **Foto: 2026-08-28.**

| Perímetro | archivos | tokens `:N` | P1 | P2 | P3 | P4 | **sueltos (P3+P4)** |
|---|---|---|---|---|---|---|---|
| `src/` + `test/` + `scripts/` | **611** | 2095 | 250 | 498 | 277 | 1070 | **1347** |
| `doc/` | 1088 | 30077 | 7891 | 9511 | 9189 | 3486 | **12675** |
| **repo entero** (trackeado, sin binarios) | 1955 | 32378 | 8169 | 10031 | 9468 | 4710 | **14178** |

`[MEDIDO-F2, scratchpad/census.ts]`

### 4.2 Contraste con TODO lo heredado — y son cuatro instrumentos, no uno

| Fuente | «sueltos» en `wasiai-a2a` | Perímetro declarado |
|---|---|---|
| Issue #178 (2026-08-25) | **7835** | ⛔ ninguno |
| `_INDEX.md:218` (fila 226), patrón con rangos | 7835 | ⛔ ninguno |
| `_INDEX.md:218`, patrón `` `:N` `` a secas | 4222 | ⛔ ninguno |
| Orquestador (2026-08-28), `src+test+scripts` | ~1470 | sí |
| Orquestador, `+doc/` | ~14772 | sí |
| **Este F2**, `src+test+scripts` | **1347** | sí, y con el patrón |
| **Este F2**, repo entero | **14178** | sí, y con el patrón |

⇒ **Cinco números distintos para la misma pregunta, con un factor de 10 entre extremos.**
Ninguno de los tres primeros declara perímetro. **`[VERIFICADO — y la conclusión es que el
número heredado no era comparable, no que estuviera "mal"]`.** El del orquestador para
`src+test+scripts` (~1470) queda a **9 % por encima** del mío (1347); el de `+doc/` (~14772),
a **4 %** por encima de mi repo entero (14178) — o sea que **su orden de magnitud se
confirma y su dígito no**. Esto es exactamente lo que CD-1 existe para volver imposible.

### 4.3 MI-1 CERRADO — el issue #178, leído entero

Leído con `gh issue view 178 --repo ferrosasfp/wasiai-a2a --json body` `[MEDIDO-F2]`.
**No contradice nada del work-item.** Aporta tres cosas que hay que anotar:

1. El caso del bug es literal y confirma DT-6: `chaski-v3/src/presentation/flow-vm.test.ts:2060`
   cita `` `:1224` ``; el referente real se movió `+7` en `flow-vm.ts`, y a la cita se le aplicó
   **`+29`, el desplazamiento de `flow-vm.test.ts`, el archivo equivocado**. La cita de la línea
   de al lado (`:2059`) sí recibió el `+7` correcto.
2. El issue pide textualmente las tres cosas que son AC-1/AC-3 y §9 de este SDD: cuántos son
   citas vs datos, si se convierten o se acotan, y el perímetro declarado con su número.
3. El issue dice **7835** para este repo, sin perímetro ni patrón. §4.2 lo ubica.

### 4.4 `doc/` — medido, NO tocado (AC-3 + AC-5) `[MEDIDO-F2]`

- **1095 archivos trackeados** bajo `doc/` (1080 `.md`, 5 `.log`, 3 `.png`, 3 `.pdf`, 1 `.yaml`,
  1 `.sql`, 1 `.json`, 1 `.jpg`). Los 1088 no-binarios traen **30077 tokens `:N`**, de los cuales
  **12675 son sueltos**.
- `doc/` **es alcanzable** por un guardián: `.gitignore:180-196` excluye archivos de `doc/sdd/**`
  **de a uno** (once entradas individuales), o sea que el grueso viaja en el índice. `[VERIFICADO]`
- 🔴 **La medición que reemplaza al «392 con un patrón grosero» (cierra MI-4), y da vuelta la
  pregunta:** en vez de contar cuántos tokens llevan marcador histórico —que es una cota
  inferior de un patrón difuso— conté **cuántos artefactos de `doc/` declaran que numeran el
  ÁRBOL VIVO**, que es la excepción que AC-5 define. Barrido sobre los 1095 archivos con
  `grep -lE "numeran? el árbol|árbol vivo|árbol PREVIO|numera el árbol"`:

  > **3 archivos. Y dos de los tres son los artefactos de ESTA HU**
  > (`doc/sdd/232-…/work-item.md` y `doc/sdd/232-…/_INDEX-row.md`). El tercero es
  > `doc/sdd/_INDEX.md`.

  ⇒ **1092 de 1095 artefactos de `doc/` no declaran nada**, y bajo la regla default-histórico de
  AC-5 eso significa que **`doc/` es histórico prácticamente en su totalidad**. La decisión de
  no tocarlo deja de depender de estimar los 392: **no hay nada que re-anclar porque casi nada
  se declara vivo.** Ése es el número que va al censo, y se deriva (AC-8).

---

## 5. 🔴 La medición central: el oráculo preexistente

### 5.1 Qué es el oráculo, y por qué es independiente

| | |
|---|---|
| **Qué** | Las **19** entradas de `CITED_LINES` cuyo `cite` no nombra archivo (P3/P4) + las **3** entradas de `SCANNER_FALSE_POSITIVES` (**4** ocurrencias) |
| **Etiqueta de verdad** | Para las 19: `CITA`, y además **el `target` correcto**, resuelto a mano. Para las 3: `RUIDO` |
| **Quién las escribió** | Humanos, en 10 commits entre `5af987e` (2026-08-19) y `7fdd4fc` (2026-08-27), en WKH-362/225/335/366/370 `[MEDIDO-F2: git log]` |
| **Por qué es independiente de la calibración** | El F1 derivó D1–D4 leyendo **`test/cited-lines-guard.exceptions.ts`**, y etiquetó 30 tokens **de ese archivo**. `CITED_LINES` vive en **otro archivo** y **no fue leído para derivar ninguna regla** |
| **Por qué es independiente del clasificador** | El clasificador **no existía** cuando se escribieron. Es una precondición verificable, no una promesa |
| **Qué NO puede medir** | **Precisión.** Tiene 19 positivos y 4 negativos: es un instrumento de **recall**, y por eso NO reemplaza a la muestra reservada de §8 |
| **Su límite, escrito primero** | La clave del registro es `{from, cite}`, **no el sitio**. Para un token con varias ocurrencias, la etiqueta no dice *cuál* ocurrencia. Medido: el `:1` de `SCANNER_FALSE_POSITIVES` (el `minLength:1`) tiene otras ocurrencias en `src/types/index.ts` y el prototipo evalúa la primera que devuelve `scanSource` |

### 5.2 Los resultados, por variante de cascada `[MEDIDO-F2, scratchpad/variants.ts]`

| Variante | Qué agrega | Recall (`CITA` **con target correcto**) | **FN silenciosos** | `INDECIDIBLE` | FP sobre los 4 RUIDO | `CITA` en el perímetro (1347) |
|---|---|---|---|---|---|---|
| **A** = la del F1 | D3 exige un token **P1/P2** en el párrafo | **4/19 = 21 %** | **5** | 10 | 0 | 102 |
| **B** = A + tier b | acepta también un **nombre de archivo SIN `:N`** en el párrafo | 11/19 = 58 % | 5 | 3 | 0 | 135 |
| **C** = B + auto-cita | sin ningún archivo en el párrafo ⇒ el target por defecto es **el propio citador** | **16/19 = 84 %** | **0** | 3 | 0 | 229 |
| **D** = C + homónimo | cualquier nombre ambiguo en el párrafo ⇒ `INDECIDIBLE` (versión gruesa) | 10/19 = 53 % | 0 | 9 | 0 | 177 |

**En ninguna variante hubo un solo target resuelto MAL**: cuando la cascada dice `CITA`, el
archivo que resuelve coincide con el que el humano declaró, **16 de 16 veces** en la variante C.
Eso es lo que la vuelve usable como *cross-check* mecánico (§9.2).

**Los 5 falsos negativos de la cascada del F1, abiertos y leídos uno por uno** (cumple AC-1 «≥3
FN citados con su sitio y su motivo», y CD-6: se abrió la línea, no se sumó un delta):

| # | Sitio | Token | Target declarado | Por qué D3 lo pierde |
|---|---|---|---|---|
| FN-1 | `src/types/index.ts:288` | `` `:203-225` `` | `src/types/index.ts` | **Auto-cita.** El párrafo dice «están en el docblock de `AgentPaymentSpec.contract` (`:203-225`)» — nombra un **símbolo**, no un archivo |
| FN-2 | `src/services/compose.ts:751` | `:634` | `src/services/compose.ts` | **Auto-cita.** «guard `i > 0` de :634» — el párrafo entero habla de este archivo y por eso no lo nombra |
| FN-3 | `src/routes/agents.ownership.test.ts:13` | `` `:72` `` | sí mismo | **Auto-cita.** «el mock registra los `.eq()` en `:72`» |
| FN-4 | `src/routes/agents.ownership.test.ts:13` | `` `:76-77` `` | sí mismo | Ídem, misma oración |
| FN-5 | `src/routes/agents.ownership.test.ts:25` | `` `:211` `` | sí mismo | Auto-cita **mal desviada**: el párrafo nombra `src/services/agent.ownership.test.ts`, que resuelve por basename a **otro** archivo (§5.3) |

⇒ **La auto-cita es 5 de 5.** No es un borde: es la forma principal en que este repo escribe una
cita suelta, y la regla del F1 la borra en silencio. Ese es el motivo por el que la cascada de
este SDD lleva una regla D5 que el F1 no tenía (§7).

### 5.3 Un defecto REAL de `citeTargetIfTracked` que aparece al reusarlo para D3

`test/cited-lines-guard.scanner.ts:265`:

```ts
if (!raw.includes('/')) return candidates[0] ?? null;
```

Para un path **sin `/`** (forma P2), devuelve **el primer candidato por basename, en silencio,
aunque haya varios**. Medido sobre el índice de git de hoy `[MEDIDO-F2]`:

```
190  work-item.md      126  sdd.md        109  done-report.md
142  auto-blindaje.md   70  ar-report.md    9  index.ts
```

⇒ un token `sdd.md:44` resuelve a **uno arbitrario de 126**. Hoy no hace daño porque
`citeTargetIfTracked` sólo se usa como predicado booleano «¿es un archivo trackeado?» en el
candado de `SCANNER_FALSE_POSITIVES`; **el día que su valor de retorno se use para decidir a qué
archivo apunta una cita —que es lo que D3 hace— pasa a ser exactamente el bug del issue: el
desplazamiento del archivo equivocado.** Por eso DT-8.

⚠️ Y hay un segundo defecto, **vacuo hoy en `main`**: `citeMatchesTarget` (`:304-306`) hace
`if (raw === null) return true;`. Para P3/P4 **el cruce mecánico devuelve `true` siempre**.
O sea que hoy una entrada P3/P4 de `CITED_LINES` puede declarar **cualquier** `target` y nada
lo contradice: sólo hay un `targetReason` en prosa. **Ese es el agujero que el Corte B cierra**
(§9.2), y es el que le da a AC-4 un rojo que hoy no existe.

---

## 6. Decisiones técnicas

### DT-1 — La cascada es sintáctica + contexto, con residuo explícito. **Se mantiene, ampliada.**
Nunca una heurística de rango (CD-4). Lo que cambia respecto del F1 es que la capa de contexto
tiene **tres niveles** en vez de uno, y que hay una regla **D5** para la auto-cita. Motivo: §5.2.

### DT-2 — D3 pregunta al ÍNDICE DE GIT, no al disco. **Confirmado.**
`citeTargetIfTracked` existe en `test/cited-lines-guard.scanner.ts:251-267` `[VERIFICADO — el F1
acertó el path y el rango]`, y se reusa. Usar el disco haría que el guardián dé distinto en CI
que en local. Y sin la condición de git, los 3 tokens de ruido de `exceptions.ts` sobreviven
porque el párrafo nombra `https://x.io:8443/y` — **`x.io` no está en el índice** y por eso cae.

### DT-3 — `INDECIDIBLE` es de PRIMERA CLASE. **Confirmado y ampliado.**
Además del caso «más de un archivo», ahora hay dos productores más: **homónimo ambiguo** (DT-8)
y **auto-cita en un archivo sin símbolos** (DT-9).

### DT-4 — Son TRES arreglos, no uno. **Confirmado, con los costos re-medidos.** Ver §9.

### DT-5 — Se EXTIENDE `test/cited-lines-guard.scanner.ts`, NO se escribe un escáner nuevo.
**Confirmado.** El motivo está escrito en el propio repo: hoy conviven **TRES** `stripComments`
(`TD-224-TRES-STRIPCOMMENTS`, docblock de `stripComments` en `scanner.ts:317-367`
`[VERIFICADO]`), y el escáner registra que «el punto ciego del dotfile se reprodujo DENTRO del
arreglo del punto ciego del dotfile» por duplicar un criterio. Un segundo discriminador es la
próxima divergencia.

### DT-6 — Un párrafo con MÁS DE UN archivo trackeado ⇒ `INDECIDIBLE`. **Confirmado.**
Es literalmente el caso del issue (§4.3): `+29` del archivo equivocado en vez de `+7`.
Población medida en el perímetro: **104 tokens** `[MEDIDO-F2]`.

### DT-7 — Corte A entrega valor sin Corte B. **Confirmado.** Ver §12.

### DT-8 🆕 — **La resolución para D3 es HOMÓNIMO-SEGURA, y NO se toca `citeTargetIfTracked`.**
D3 usa una función nueva `resolveContextTarget` que devuelve `{ target } | 'AMBIGUOUS' | null`
en vez de `string | null`. **No se modifica `citeTargetIfTracked`**: es el candado de
`SCANNER_FALSE_POSITIVES` (`G-C8`/`G-C11`) y cambiar su semántica movería un guard de dinero
adyacente sin necesidad. La regla: **>1 candidato por basename ⇒ `AMBIGUOUS` ⇒ `INDECIDIBLE`**,
nunca `candidates[0]`. Motivo medido: §5.3, y 126 candidatos para `sdd.md`.
⚠️ **La ambigüedad sólo decide cuando es el ÚNICO contexto.** Medido: la variante D, que dejaba
`INDECIDIBLE` cualquier párrafo que contuviera *algún* nombre ambiguo, **bajó el recall de 84 %
a 53 %** — o sea que la versión gruesa de esta regla cuesta 6 citas reales. Si el párrafo tiene
un contexto **no ambiguo** además del ambiguo, gana el no ambiguo.

### DT-9 🆕 — **D5, la AUTO-CITA: sin ningún archivo en el contexto, el target por defecto es el propio citador.**
Es la regla que sube el recall de 58 % a 84 % y lleva los FN silenciosos de 5 a **0** (§5.2).
**Su costo está acotado y medido**: en todo el perímetro, sólo **94 tokens** llegan a D5
—los demás ya murieron en D1 (976), D2 (38), D3a (102), D3b (33) o D6 (104)—, así que
D5 no es una compuerta que se abre sobre miles: **es una lista de 94 sitios que se pueden leer
a mano**, y W2.4 obliga a leerlos todos.
⚠️ **D5 NO aplica** si el citador no tiene símbolos TS resolubles y el `:N` cae fuera del rango
de líneas del propio archivo — en ese caso es `INDECIDIBLE`, no `CITA`.

### DT-10 🆕 — **El contexto es el PÁRRAFO, y un párrafo nunca cruza la frontera comentario↔código.**
Definición mecánica: corrida máxima de líneas alrededor del token, cortada por (a) línea vacía,
(b) línea de sólo decoración (`*`, `//`, `/**`, `*/`, reglas de guiones/cajas), y (c) **cambio de
naturaleza** entre «línea que es sólo comentario» y «línea con código».
Motivo medido: sin (c), en `test/cited-lines-guard.citations.ts` —una lista de literales de
objeto sin líneas en blanco entre entradas— **el párrafo se derrama a través de varias entradas**
y produce `D6 multi(5)` con archivos de entradas vecinas `[MEDIDO-F2]`.

### DT-11 🆕 — ⛔ **Los 4 archivos del propio guardián quedan FUERA del universo del clasificador.**
No es comodidad: es AC-6/CD-3. En `citations.ts` el campo `target:` de una entrada es el nombre
del archivo **sin `:N`** en la misma región que su `cite:` ⇒ el tier-b de D3 leería **la respuesta
que tiene que verificar**. Un control que resuelve un token usando el campo que declara su
solución **no puede fallar**. Se declara con su número: `test/cited-lines-guard.{scanner,test,
citations,exceptions}.ts` aportan **158 tokens P3/P4** de los 1347, y `test/ownership-filter-guard.
{scanner,test,exceptions}.ts` otros **37** ⇒ **195 fuera** `[MEDIDO-F2]`. `TD-224-CITAS-DEL-PROPIO-GUARDIAN`
**no se cierra acá** (Scope OUT del work-item); se **declara con su número re-derivado**.

### DT-12 🆕 — **MI-7 resuelto: el discriminador vive en `test/cited-lines-guard.scanner.ts`, y se typechequea A PROPÓSITO, con su comando escrito.**
`tsconfig.json:19` es `"include": ["src/**/*"]` y `package.json:11` es `"lint": "biome check src/"`
`[VERIFICADO]`, o sea que **nada del gate typechequea ni lintea `test/`**. Y eso ya mordió dos
veces en las últimas tres HUs (§11.3, patrón #3).
**Decisión: NO se toca `tsconfig.json`** (meter `test/**` al gate es otra HU: cambia el gate del
repo y arrastra 33 archivos que nadie typechequeó nunca). **Se agrega un paso manual obligatorio
en cada wave**, con este comando exacto, que hoy sale limpio `[MEDIDO-F2, exit 0]`:

```bash
npx tsc --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck \
  test/cited-lines-guard.scanner.ts test/cited-lines-guard.citations.ts \
  test/cited-lines-guard.exceptions.ts test/cited-lines-guard.sample.ts \
  test/cited-lines-guard.test.ts
```

### DT-13 🆕 — **La muestra reservada se DIBUJA a máquina y se ETIQUETA antes de que el clasificador exista.** Ver §8. Es la decisión que satisface AC-2.

### DT-14 🆕 — **El Corte B no amplía `CORTE_A_PATHS`; cierra el cruce VACUO de P3/P4.**
El work-item pone «ampliar `CORTE_A_PATHS`» en Scope OUT. El guardián de valor está en otro
lado y cuesta cero declaraciones nuevas: hoy `citeMatchesTarget` devuelve `true` para todo
P3/P4 (§5.3), así que **las 19 entradas P3/P4 del registro tienen su `target` sin ningún testigo
mecánico**. Con el clasificador, 16 de esas 19 se pueden cruzar. Ver §9.2 y AC-4.

---

## 7. La cascada final (variante **C′**) — el contrato del clasificador

```
classifyBareCite(token, sitio) -> { label, target?, why }
label ∈ { 'CITA', 'RUIDO', 'DATO', 'INDECIDIBLE' }        // exactamente una (AC-1)
```

| # | Regla | Decide | Población medida en el perímetro |
|---|---|---|---|
| **D0** | `prev === ':'` | descarta `::1` (IPv6) — **ya implementada**, `scanner.ts:192` | (fuera del universo) |
| **D1** | el carácter inmediatamente anterior al `:` es `[A-Za-z0-9_]` | ⇒ **`RUIDO`** — `localhost:3001`, `eip155:43113`, `1:50`, `T00:00:00`, `minLength:1` | **976** |
| **D2** | el carácter anterior es `'` o `"` | ⇒ **`DATO`** — es el valor de un campo `cite:`/`quote:` de un registro, que ya tiene testigo (`G-C5`/`G-C7`) | **38** |
| **D3a** | el **párrafo** (DT-10) contiene **exactamente un** archivo trackeado nombrado **con `:N`** | ⇒ **`CITA`**, target = ese | **102** |
| **D3b** | ídem pero nombrado **SIN `:N`** (la quinta forma del F1) | ⇒ **`CITA`**, target = ese | **33** |
| **D6** | el párrafo nombra **más de un** archivo trackeado | ⇒ **`INDECIDIBLE`** (DT-6: es el bug del issue) | **104** |
| **D7** | el único contexto es un nombre con **>1 candidato por basename** | ⇒ **`INDECIDIBLE`** (DT-8) | incluido arriba |
| **D5** | el párrafo no nombra ningún archivo trackeado, y el `:N` cae dentro del rango de líneas del propio citador | ⇒ **`CITA`**, target = **el propio citador** (auto-cita, DT-9) | **94** |
| **RESIDUO** | todo lo demás | ⇒ **`INDECIDIBLE`**, con motivo escrito | — |

⚠️ **Los backticks NO participan de ninguna regla, y eso está medido, no supuesto.** El F1
midió que `exceptions.ts` escribe `` `:8443` ``, `` `:443` ``, `` `:80` ``, `` `:0` `` —puertos
con la forma P3, la más «de cita» que existe—. Y al revés: en el perímetro, **42 de los 229
`CITA` de la variante C son P4**, o sea sin un solo backtick `[MEDIDO-F2]`. Toda propuesta que se
apoye en los backticks ya está refutada por los dos lados.

⛔ **Ninguna regla mira el RANGO del número** (CD-4).

**Salida esperada del clasificador sobre el perímetro completo, variante C** `[MEDIDO-F2, es la
HIPÓTESIS que F3 tiene que re-derivar, no un literal a copiar]`:

```
CITA 229 · RUIDO 976 · DATO 38 · INDECIDIBLE 104        (total 1347)
   de los 229 CITA: 102 por D3a · 33 por D3b · 94 por D5 (auto-cita)
```

---

## 8. 🎯 La muestra RESERVADA (AC-2) — de dónde sale y por qué es independiente

### 8.1 Los dos instrumentos, y qué mide cada uno

| | **Oráculo preexistente** (§5) | **Muestra reservada** (esta sección) |
|---|---|---|
| Origen | `CITED_LINES` P3/P4 (19) + `SCANNER_FALSE_POSITIVES` (3 entradas / 4 ocurrencias) | Sorteo con semilla sobre el marco residual |
| Etiquetado por | Humanos, ago-2026, en otras HUs | El Dev, en F3, **antes** de que el clasificador exista |
| Costo de etiquetado | **cero** (ya está escrito) | 120 sitios abiertos a mano |
| Qué mide | **recall** y **exactitud del target** | **precisión Y recall**, con intervalo |
| Qué NO mide | precisión (casi no tiene negativos) | nada sobre `doc/` (fuera del perímetro) |

**Los dos son obligatorios.** El oráculo solo no puede dar precisión; la muestra sola no tiene la
garantía de autoría anterior. Juntos cubren AC-1 y AC-2.

### 8.2 El marco (frame), con su número y su residuo

```
1347   tokens P3/P4 del perímetro src+test+scripts (§4.1)
−195   los 7 archivos del guardián y del guardián de ownership (DT-11): NO son universo
−~25   las ocurrencias ya etiquetadas por el oráculo (§5) — ya tienen verdad, no se re-sortean
=~1127 MARCO DE LA MUESTRA RESERVADA   ← F3 lo DERIVA; este número es una foto (AC-8)
```

⛔ **A este marco también se le resta cualquier archivo cuyo token individual este SDD haya
publicado clasificado.** Por eso **§5.2 sólo cita tokens del oráculo** (ya etiquetados y ya
excluidos) y todo lo demás de este SDD es agregado: si el SDD publicara la etiqueta de un token
del marco, quien lo lea antes de etiquetar ya no está ciego. **Es la razón por la que este
documento no trae ni una tabla token-por-token del perímetro.**

### 8.3 El sorteo — mecánico, con semilla, y estratificado por una variable INDEPENDIENTE

- **Estratos: `P3` (con backticks) y `P4` (sin).** La forma la produce `scanSource`, que existe
  desde el 2026-08-19 y **no participa de ninguna regla de la cascada** (§7): estratificar por
  ella no contamina. Estratificar por la etiqueta *predicha* sí lo haría, y por eso **no se hace**.
- **Motivo de estratificar**: la prevalencia es abismalmente distinta y un sorteo simple sería
  inútil. Medido `[MEDIDO-F2]`: `CITA` es **106/277 = 38 %** en P3 y **15/1070 = 1,4 %** en P4.
  Un sorteo simple de 120 traería ~2 citas de P4 y no diría nada.
- **n = 120: 60 de P3 + 60 de P4.**
- **Sorteo**: PRNG determinista con **semilla escrita en el archivo** (p. ej. `xorshift32` sobre
  `'WKH-371'`), sobre el marco ordenado por `(file, line, col)`. Reproducible por cualquiera.
  ⛔ **El Dev no elige qué tokens etiquetar.**

### 8.4 Por qué 120 alcanza para decir algo — y qué es exactamente lo que dice

No es un número redondo: es el tamaño en el que cada estrato contesta **una** pregunta falsable.

- **Estrato P3 (n=60) → PRECISIÓN.** El clasificador predice `CITA` en ~38 % ⇒ ~23 predichos
  `CITA` en la muestra. **Si la precisión real fuera 80 %, la probabilidad de observar CERO
  errores en 23 es `0,80²³ = 0,6 %`.** ⇒ la muestra **distingue «precisión ≥95 %» de
  «precisión ≤80 %»**. Eso es lo que se afirma; nada más.
- **Estrato P4 (n=60) → COTA SUPERIOR DEL FALSO NEGATIVO.** Ahí `CITA` es raro, así que el
  estrato no mide precisión: mide **cuántas citas se están perdiendo en silencio**. Con 60
  sorteados y **0 FN observados, la cota superior al 95 % es `1 − 0,05^(1/60) = 4,9 %`**, o sea
  **≤ ~52 citas no detectadas entre los 1070 tokens P4**. Ése es un número honesto que la
  medición del F1 **no podía producir de ninguna manera**.
- **Se publican los dos estratos por separado Y el agregado ponderado por el marco**
  (peso P3 = |P3 del marco| / 1127, ídem P4), con **intervalo de Wilson al 95 %**.
- ⛔ **PROHIBIDO publicar un único número de precisión sin su intervalo y sin los dos estratos.**

### 8.5 Cómo se garantiza que las etiquetas son CIEGAS — la precondición, no la promesa

**El mecanismo es de orden de commits, y es verificable después:**

1. **Commit `S1`** — se agrega `test/cited-lines-guard.sample.ts` con **el marco, la semilla y el
   sorteo**, y `RESERVED_SAMPLE` con los 120 sitios **sin etiqueta**.
2. **Commit `S2`** — se agregan las etiquetas, escritas **abriendo cada sitio** (CD-11: se lee el
   sitio, no se vuelca la salida de nada).
3. **Commit `S3` y posteriores** — recién acá nace `classifyBareCite`.

**La prueba de que las etiquetas no salieron del clasificador es que el clasificador no existía**:

```bash
git show S2:test/cited-lines-guard.scanner.ts | grep -c classifyBareCite    # → 0
git merge-base --is-ancestor S2 S3 && echo "S2 precede a S3"
```

⚠️ **Lo que este mecanismo NO garantiza, y va escrito:** el Dev leyó este SDD, así que **conoce
las reglas** cuando etiqueta. Eso es inevitable —etiquetar exige saber qué es una `CITA`— y no es
lo que AC-2 prohíbe. Lo que AC-2 prohíbe es que la muestra sea la misma de la que salieron las
reglas, y que las etiquetas se ajusten después de ver la salida. Lo primero lo asegura §8.2; lo
segundo, el orden de commits. **La independencia es de la MUESTRA y del MOMENTO, no de la mente
del que etiqueta**, y decirlo al revés sería prosa que afirma de más.

### 8.6 Los ≥3 FP y ≥3 FN de AC-1

- **FN: ya están, y son 5**, medidos en §5.2 contra el oráculo, cada uno con sitio y motivo
  abierto. F3 los reproduce y agrega los que aparezcan en la muestra.
- **FP: se cazan en el censo COMPLETO de la clase más riesgosa, no por muestreo.** Los **94**
  tokens que llegan a D5 (auto-cita) son la clase donde un FP es más probable, y son pocos:
  **W2.4 obliga a abrir los 94 y etiquetarlos a mano**. Eso convierte la pregunta «¿cuántos FP
  tiene D5?» en un **censo**, no en una estimación. Si de los 94 salen menos de 3 FP, se declara
  el número real y se buscan los que falten en el estrato P3 de la muestra.
  ⛔ Si D5 tuviera **más de 20 FP sobre 94**, D5 se degrada a `INDECIDIBLE` y se re-publica todo:
  ese umbral se escribe ANTES de medir, para que el resultado no se interprete a posteriori.

---

## 9. ¿Se convierten (A), se acotan (B) o se les borra el número (C)?

**Las tres, y la recomendación del F1 se RATIFICA — pero con un costo re-medido y una corrección.**

### 9.1 🔴 Opción A — el costo que el F1 le atribuyó está REFUTADO en su mecanismo

El F1 dijo: *«alarga la línea, Biome la reparte, y eso corre las líneas de abajo»*.

**Medido `[REFUTADO]`**, dos veces y por dos caminos:

1. `biome.json:9` es `"files": { "includes": ["src/**/*.ts"] }` y `package.json:11` es
   `biome check src/` ⇒ **Biome no toca `test/` en absoluto**.
2. Y sobre `src/`, **Biome no reparte comentarios**. Comprobado pasándole por `--stdin-file-path`
   un docblock de **170 columnas** con tres citas ancladas: la salida es **byte-idéntica**.

⇒ **El formateador NO desplaza nada al convertir una cita.** El riesgo de la opción A es que **un
humano re-envuelva el párrafo**, que es un mecanismo distinto y evitable. **La objeción del F1
sigue siendo válida pero por su OTRA razón**, la que sí se sostiene: convertir duplica el nombre
del archivo N veces por párrafo, y cada duplicado es una cosa más que puede divergir. A **1347
tokens**, eso es inaceptable como política general.

**⇒ A se usa SÓLO para los `INDECIDIBLE` de D6** (párrafo con más de un archivo trackeado): es el
único arreglo que **elimina** la ambigüedad en vez de acotarla. Población medida `[MEDIDO-F2]`:
**104 tokens** en el perímetro, de los cuales **70 viven en los 7 archivos que DT-11 saca del
universo** (36 en `cited-lines-guard.citations.ts`, 18 en `ownership-filter-guard.exceptions.ts`,
7+7 en los dos `*.test.ts`, 2 más) ⇒ **el conjunto realmente accionable es 34**. Los otros dos
sitios densos son `src/services/fee-split.ownership.test.ts` (10) y
`src/services/arbiter/evidence.test.ts` (5).

### 9.2 Opción B — ACOTAR. **Es la principal, y su costo es exactamente CERO declaraciones nuevas**

El guardián no necesita ampliar su universo (Scope OUT). Necesita **cerrar el cruce vacuo** de
§5.3: hoy `citeMatchesTarget` devuelve `true` para todo P3/P4, así que **el `target` de las 19
entradas P3/P4 del registro no lo verifica nada**.

Con el clasificador, la regla nueva es:

> Para toda entrada de `CITED_LINES` cuyo `cite` sea P3/P4: si `classifyBareCite` resuelve el
> token a **un** target, ese target **DEBE** ser igual al `target` declarado. Si resuelve
> `INDECIDIBLE`, sigue rigiendo el `targetReason` escrito a mano, como hoy.

- **Diff**: una función nueva + un control. **Cero entradas nuevas en el registro.**
- **Cobertura inmediata medida**: **16 de las 19** entradas pasan a tener testigo mecánico, y
  **las 16 coinciden** con lo que el humano declaró ⇒ el control **nace verde por medición, no
  por construcción** `[MEDIDO-F2]`.
- **Rojo real disponible para AC-4** (§13, T-AC4).
- **El texto del repo no se mueve** ⇒ no dispara la cascada de re-derivación de citas.

### 9.3 Opción C — BORRARLE el número. Confirmada, y con exemplar medido

`src/adapters/chain-resolver.ts`: **446 líneas, 0 tokens `:N`** `[VERIFICADO — el F1 dijo 447,
es 446]`, y referencia otros archivos por nombre (`registry.ts`, `settle-verifier.ts`,
`downstream-payment.ts`, `types.ts`, `doc/architecture/MULTI-CHAIN.md`) **sin número de línea**.
Es la única variante con **costo de mantenimiento cero**: no se puede pudrir.

**⇒ C se usa cuando la prosa NO depende del número.** Criterio operativo, para que no sea a ojo:
*si al borrar el `:N` la oración sigue siendo verdadera y sigue diciendo lo mismo, el número
sobraba.* Cada aplicación de C se justifica por escrito, en el commit del Corte B.

### 9.4 La decisión, en una tabla

| Clase del token | Salida | Población medida | Costo |
|---|---|---|---|
| `CITA` resuelta por D3a/D3b/D5 | **B** — se acota con el cruce mecánico | 229 (102+33+94) | 0 declaraciones nuevas |
| `INDECIDIBLE` por D6/D7 | **A** — se le escribe el archivo al lado | **34 accionables** (104 − 70 en los 7 archivos de DT-11) | diff de texto, **sin re-envolver el párrafo** |
| `CITA` cuya oración no usa el número | **C** — se le borra el `:N` | subconjunto, se deriva en Corte B | negativo (borra deuda) |
| `RUIDO` / `DATO` | nada | 976 + 38 | 0 |

---

## 10. El perímetro, con su número y su residuo (AC-3, CD-1)

**Perímetro del ARREGLO y de la MEDICIÓN fina: `src/` + `test/` + `scripts/` = 611 archivos
trackeados, 2095 tokens `:N`, 1347 sueltos.** `[MEDIDO-F2]`

⛔ **Lo que queda AFUERA, cada uno con su número — porque un candado con perímetro incompleto se
lee como lista cerrada:**

| Fuera | Número medido | Por qué |
|---|---|---|
| `doc/` | **1088 archivos · 30077 tokens · 12675 sueltos** | AC-5: registro histórico por defecto. Sólo **3 de 1095** artefactos declaran numerar el árbol vivo, y 2 son de esta HU (§4.4) |
| Raíz del repo (`CLAUDE.md`, `README.md`, …) | 13 archivos · **33 sueltos** | No entra al arreglo; `CLAUDE.md` ya está en `CORTE_A_PATHS` para lo anclado |
| Los 4 archivos del propio guardián | **158 sueltos** | DT-11: leerían la respuesta que verifican. `TD-224-CITAS-DEL-PROPIO-GUARDIAN` sigue abierta |
| `test/ownership-filter-guard.{scanner,test,exceptions}.ts` | **37 sueltos** | Ídem, y sus 41 pares `{file,line}` ya tienen testigo (`G-08`/`G-09`) |
| `.nexus/project-context.md` | `[NO MEDIDO — no está en el índice de git]` | `TD-316-CITAS-PROJECT-CONTEXT`: el repo es PÚBLICO |
| `chaski-v3`, `wasiai-remittance-agents` | `[NO MEDIDO]` | `TD-371-PORTABILIDAD`: universos de git distintos |
| Sub-paquetes con runner propio (`mcp-servers/**`, `packages/**`) | incluidos en el «repo entero» (14178) pero **no en el perímetro** | El `npm test` de la raíz no los corre (ver el comentario de `ci.yml`) |

**Residuo del propio instrumento** (lo que el escáner no ve, heredado del docblock de
`scanner.ts:15-68` y **no arreglado acá**): la prosa suelta sin forma sintáctica («la línea 95»),
las citas partidas en dos líneas, los archivos sin extensión (`Dockerfile:12`), y el valor
semántico de la afirmación. **Ninguno de esos entra al conteo de 1347, y por eso 1347 es un
PISO.**

---

## 11. Constraint Directives

### 11.1 Heredados del work-item — íntegros, no se negocian

**CD-1** (perímetro + patrón en la misma frase) · **CD-2** (deuda vieja y nueva en commits
separados) · **CD-3** (ningún control se lee a sí mismo) · **CD-4** (nunca descartar por rango) ·
**CD-5** (no re-anclar `doc/sdd/**`, incluido este SDD) · **CD-6** (abrir la línea, nunca sumar
un delta) · **CD-7** (`git add -A` antes del gate) · **CD-8** (⛔ ninguna línea EJECUTABLE en el
diff de `src/`) · **CD-10** (las citas se arreglan al final de cada wave) · **CD-11** (ninguna
lista de excepciones se genera volcando la salida del clasificador).

**CD-9 — CORREGIDO, el work-item nombraba el archivo equivocado.** Decía
`src/services/capability-risk.ts`; el archivo real es **`src/lib/capability-risk.ts`**, y la cita
está en **`src/lib/capability-risk.ts:82`** (`bdwv (`doc/sdd/_INDEX.md:144`)`), con una segunda
en `src/lib/capability-risk.test.ts:58` `[MEDIDO-F2]`. La directiva se mantiene igual:
⛔ **PROHIBIDO tocar `doc/sdd/_INDEX.md` por encima de la línea 144.**

### 11.2 Nuevos, salidos de las mediciones de este F2

- **CD-12** — ⛔ **PROHIBIDO usar `citeTargetIfTracked` como resolvedor de destino.** Devuelve
  `candidates[0]` en silencio para un basename con 126 homónimos (`scanner.ts:265`, §5.3). Para
  D3 se usa `resolveContextTarget`, que devuelve `AMBIGUOUS`. Y ⛔ **no se modifica
  `citeTargetIfTracked`**: es el candado de `SCANNER_FALSE_POSITIVES`.
- **CD-13** — ⛔ **PROHIBIDO que el clasificador corra sobre los 7 archivos de DT-11.** El campo
  `target:` de una entrada de `citations.ts` es la respuesta que el clasificador tiene que
  producir; leerlo como contexto es un control que se lee a sí mismo (CD-3).
- **CD-14** — ⛔ **PROHIBIDO publicar un número de precisión sin (a) su intervalo, (b) los dos
  estratos por separado y (c) la palabra «foto» con su fecha.** Un número solo se lee como cerrado.
- **CD-15** — ⛔ **PROHIBIDO etiquetar la muestra reservada después de que `classifyBareCite`
  exista en el árbol.** La precondición se verifica con `git show S2:… | grep -c` (§8.5), no se
  promete.
- **CD-16** — **OBLIGATORIO typechequear los 5 archivos del guardián con el comando de DT-12 en
  CADA wave**, y anotar el exit. `vitest` no ve errores de tipo, y este repo lo pagó dos veces en
  tres HUs (§11.3).
- **CD-17** — ⛔ **PROHIBIDO usar el `diff` del entorno para verificar una restauración.** Está
  medido que dice «Files are identical» sobre archivos que difieren. Se usa `/usr/bin/diff` o
  `sha256sum`, y **el hash se compara antes y después**.
- **CD-18** — **OBLIGATORIO verificar que un mutante SE APLICÓ antes de correr la suite.** Ya
  pasó dos veces que la corrida salió verde porque la mutación nunca llegó al archivo. El rojo se
  confirma **por su MOTIVO literal**, no por el color.
- **CD-19** — **El umbral de rechazo de D5 se escribe ANTES de medir**: >20 FP sobre los 94 ⇒ D5
  se degrada a `INDECIDIBLE` (§8.6). Sin umbral previo, cualquier resultado se puede narrar como
  éxito.

### 11.3 Del Auto-Blindaje histórico — patrones que YA se repitieron (≥2 de las últimas 3 HUs)

| # | Patrón | Dónde se repitió | Qué CD lo previene |
|---|---|---|---|
| 1 | **Citas rotas por el propio desplazamiento del Dev, con deltas DISTINTOS por archivo** | 229 («7 citas ancladas rotas con TRES deltas distintos»), 231 (`BLQ-2`, cuarta pasada, `+64` donde iba `+78`) | CD-6 + CD-10 |
| 2 | **Correr las PARTES del gate no es correr el gate; `lint` es el eslabón que nadie alcanza** | 229 (W0), 230 (§7.9), 231 (W4.2: **28 rojos** que ninguna suite vio) | CD-7 + AC-10 |
| 3 | **Errores de tipos que `vitest` no puede ver** | 230 (W1, «dos errores de tipos»), 229 (W2, `cacheHit: 'MISS'` no existe en el tipo y vitest lo dejó pasar) | **CD-16** — y es directamente MI-7 |
| 4 | **Mutantes que NO se aplicaron y la corrida salió verde** | 229 (W2), 231 (`BLQ-1`, tres mutantes vivos) | **CD-18** |
| 5 | **Herramientas del entorno que mienten** (`diff` idénticos, scratchpad compartido con `.bak` de otra sesión) | 229 (W1), 230 (W1) | **CD-17** + directorio de scratch único |

---

## 12. Waves de implementación

**Dos cortes, y el corte A cierra solo (DT-7).**
⚠️ **Regla transversal (CD-10): en TODA wave, arreglar citas es lo ÚLTIMO**, después de la última
edición de esa wave. Y **CD-16**: el typecheck de DT-12 al cerrar cada wave.

### CORTE A — el instrumento y el censo

#### W0 — Serial. Nada empieza sin esto
| | |
|---|---|
| **W0.1** | `git add -A` → gate completo en orden → publicar los 4 números contra §2 (AC-10) |
| **W0.2** | **Re-derivar** los números de §4.1 sobre el árbol de arranque. Si no coinciden con este SDD, **manda la derivación** y se anota la diferencia (AC-8) |
| **Archivos** | ninguno (sólo medición) |

#### W1 — Serial. El marco y la muestra, **antes** del clasificador (AC-2, CD-15)
| | |
|---|---|
| **W1.1** | 🆕 `test/cited-lines-guard.sample.ts`: `SAMPLE_SEED`, `sampleFrame()` (marco de §8.2, derivado), `drawReservedSample()` (xorshift32, estratificado P3/P4, 60+60) y `RESERVED_SAMPLE` con los **120 sitios SIN etiqueta** |
| | **⇒ COMMIT `S1`** (CD-2: este commit no toca ninguna cita) |
| **W1.2** | Etiquetar los 120 **abriendo cada sitio** (CD-11): `label` ∈ {CITA,RUIDO,DATO,INDECIDIBLE}, `target` cuando sea CITA, y `reason` de una línea leída en el sitio |
| | **⇒ COMMIT `S2`** — y se anota su hash: es la prueba de ceguera de §8.5 |
| **Archivos** | `test/cited-lines-guard.sample.ts` (nuevo) |

#### W2 — El clasificador (depende de W1). **Acá recién nace `classifyBareCite`**
| | |
|---|---|
| **W2.1** | `test/cited-lines-guard.scanner.ts`: `paragraphOf` (DT-10), `resolveContextTarget` (DT-8), `classifyBareCite` (§7). Funciones **puras**, sin tocar disco, al lado de `citeNamesFile` / `citeTargetIfTracked`. ⛔ No se modifica `citeTargetIfTracked` (CD-12) |
| **W2.2** | `test/cited-lines-guard.test.ts`: `G-C13`..`G-C16` con fixtures **en memoria en las dos direcciones**, calcados de `G-C11` (`:1484`) |
| **W2.3** | Correr el clasificador contra el **oráculo** de §5 ⇒ `G-C17` |
| **W2.4** | 🔴 **Abrir a mano los 94 sitios de D5** y etiquetarlos ⇒ el censo de FP de §8.6, con el umbral de CD-19 |
| **W2.5** | Correr el clasificador contra `RESERVED_SAMPLE` ⇒ matriz de confusión por estrato, precisión y recall con Wilson, y el ponderado por el marco |
| **Archivos** | `test/cited-lines-guard.scanner.ts`, `test/cited-lines-guard.test.ts`, `test/cited-lines-guard.exceptions.ts` (los `INDECIDIBLE` con motivo) |

#### W3 — El censo (depende de W0..W2)
| | |
|---|---|
| **W3.1** | 🆕 `doc/sdd/232-…/censo.md`: perímetro con su número, patrón, residuo (§10), medición de `doc/` (§4.4), precisión/recall con intervalos, ≥3 FP y ≥3 FN citados con sitio y motivo, y el contraste con los 5 números heredados (§4.2) |
| **W3.2** | Cada número del censo nombra **la función que lo deriva** (AC-8) |
| | **⇒ COMMIT `S3`** — Corte A cerrado. **AC-1, AC-2, AC-3, AC-5, AC-6, AC-8, AC-10 satisfechos** |
| **Archivos** | `doc/sdd/232-…/censo.md` (nuevo) |

### CORTE B — el guardián que puede fallar, y las correcciones

#### W4 — El cruce mecánico de P3/P4 (§9.2, DT-14)
| | |
|---|---|
| **W4.1** | El control nuevo `G-C18`: para toda entrada P3/P4 de `CITED_LINES`, si el clasificador resuelve **un** target, tiene que ser el declarado ⇒ `E-BARE_TARGET_MISMATCH` |
| **W4.2** | **AC-4**: mutar el `target` de una entrada P3/P4 a otro archivo trackeado ⇒ rojo, con el **texto literal**; y mutar el `line` ⇒ rojo por `E-LINE_MOVED`. Control positivo verde antes y después; **mutación verificada como APLICADA** (CD-18) y restauración por hash con `/usr/bin/diff` (CD-17) |
| | **⇒ COMMIT `S4`** — **AC-4 satisfecho** |
| **Archivos** | `test/cited-lines-guard.test.ts`, `test/cited-lines-guard.citations.ts` |

#### W5 — Las correcciones (⛔ **commit aparte**, CD-2 / AC-9)
| | |
|---|---|
| **W5.1** | Aplicar **A** a los **34** `INDECIDIBLE` de D6 accionables, **sin re-envolver el párrafo** (§9.1) |
| **W5.2** | Aplicar **C** donde la oración no use el número (§9.3), con la justificación escrita |
| **W5.3** | **AC-9**: por cada cita corregida, declarar si estaba podrida **antes** del primer commit de esta HU, derivándolo con `git show <base>:<archivo>` — **no de la memoria** |
| | **⇒ COMMIT `S5`** |
| **Archivos** | comentarios de `src/`/`test/`/`scripts/` (⛔ **CD-8: 100 % comentario**) |

#### W6 — Cierre (serial)
`git add -A` → gate completo en orden, **una vez** → los 4 números contra §2 → re-derivar todo
número que las ediciones de W5 hayan movido (AC-7/AC-8) → typecheck de DT-12.

---

## 13. Plan de tests — al menos uno por AC

| ID | AC | Archivo | Qué cubre | Cómo se pone ROJO |
|---|---|---|---|---|
| `G-C13` | AC-1 | `test/cited-lines-guard.test.ts` | La cascada emite **exactamente una** de las 4 etiquetas, y las 4 son alcanzables con fixtures en memoria | Devolver dos etiquetas, o que una clase quede inalcanzable |
| `G-C14` | AC-1 | ídem | **En las dos direcciones**, calcado de `G-C11`: un fixture `localhost:3001` ⇒ `RUIDO`; un fixture `` ver `agent.ts:12`, y `:20` `` ⇒ `CITA` con target `agent.ts` | Aflojar D1 ⇒ el puerto pasa a `CITA`; endurecer D3 ⇒ la cita cae a `RUIDO` |
| `G-C15` | AC-1, DT-8 | ídem | Homónimo: un fixture cuyo único contexto es `sdd.md` (126 candidatos) ⇒ `INDECIDIBLE`, **nunca** `candidates[0]` | Sustituir `resolveContextTarget` por `citeTargetIfTracked` ⇒ resuelve un target arbitrario y el test cae |
| `G-C16` | AC-6 | ídem | **El control no se lee a sí mismo**: los fixtures viven en memoria, con la respuesta escrita antes; y se verifica que los 7 archivos de DT-11 están fuera del universo | Meter `citations.ts` al universo ⇒ el token se resuelve con su propio campo `target:` ⇒ rojo |
| `G-C17` | AC-2 | ídem | **El oráculo**: recall ≥ el piso publicado sobre las 19 entradas P3/P4 de `CITED_LINES`, y **0 targets resueltos MAL**; y las 4 ocurrencias de `SCANNER_FALSE_POSITIVES` siguen dando `RUIDO`/`DATO` | Sacar D5 ⇒ el recall cae de 84 % a 58 % y el piso no se cumple (medido) |
| `G-C17b` | AC-2 | ídem | **La muestra reservada**: los números publicados en el censo se **re-derivan** de `RESERVED_SAMPLE` en la corrida; si el archivo cambia, el número cambia | Editar una etiqueta sin re-derivar ⇒ rojo |
| `G-C18` | AC-4 | ídem | El cruce mecánico P3/P4 (§9.2): target resuelto ≠ target declarado ⇒ `E-BARE_TARGET_MISMATCH` | **La mutación de W4.2**, con su texto literal |
| `T-AC3` | AC-3 | `doc/sdd/232-…/censo.md` + `G-C1` | El perímetro y su residuo se publican con el número **derivado en la corrida** | Un literal copiado ⇒ diverge de la derivación |
| `T-AC5` | AC-5 | censo | `doc/` se mide y no se toca; se publica cuántos artefactos declaran árbol vivo (3) | `git diff --stat doc/ -- ':!doc/sdd/232-*'` no vacío ⇒ violación |
| `T-AC7` | AC-7 | procedimiento | Las citas se re-derivan **abriendo la línea**, después de la última edición de la wave | Una cita que no coincide con su línea ⇒ `G-C5` rojo |
| `T-AC8` | AC-8 | `G-C1` + censo | Todo número de población es foto, con fecha y con el nombre de la función que lo deriva | Un número sin función nombrada ⇒ hallazgo de CR |
| `T-AC9` | AC-9 | `git log` | Instrumento (`S1..S3`) y correcciones (`S5`) en commits distintos; procedencia de cada cita corregida derivada con `git show <base>:` | Un commit que mezcla ⇒ BLOQUEANTE |
| `T-AC10` | AC-10 | gate | `git add -A` + tsc → lint → test, en orden, completo | Cualquier eslabón ≠ la base de §2 sin justificar |

⚠️ **`G-C17` es un PISO, no una igualdad.** Un test que exija «exactamente 84 %» se pone rojo el
día que alguien escriba una cita nueva, y ese rojo no señala nada falso: es la fricción que
termina con alguien borrando el guardián (el mismo argumento del docblock de `citations.ts`).

---

## 14. Presupuesto de escala (el CR lo contrasta — regla 10 de `CLAUDE.md`)

| Wave | Archivo | Líneas netas presupuestadas | De las cuales son DATOS a mano |
|---|---|---|---|
| W1 | `test/cited-lines-guard.sample.ts` (nuevo) | **≤ 780** | ~700 (120 entradas × ~5 líneas + cabecera) |
| W2.1 | `test/cited-lines-guard.scanner.ts` | **≤ 200** | 0 (≈90 de código, ≈110 de docblock, que es la proporción del archivo) |
| W2.2/3 | `test/cited-lines-guard.test.ts` | **≤ 280** | 0 |
| W2.4 | `test/cited-lines-guard.exceptions.ts` | **≤ 120** | ~100 (los `INDECIDIBLE` con motivo leído en el sitio) |
| W3 | `doc/sdd/232-…/censo.md` (nuevo) | **≤ 420** | — |
| **Corte A** | | **≤ 1800** | **~800** |
| W4 | `test/cited-lines-guard.{test,citations}.ts` | **≤ 160** | 0 |
| W5 | comentarios de `src`/`test`/`scripts` | **≤ 120** | 0 |
| **Corte B** | | **≤ 280** | |
| **TOTAL** | | **≤ 2080** | |

**La pregunta que decide (regla 10)**: *¿qué parte de esto seguiría existiendo si lo escribiera
alguien que ya conoce esta librería?* Respuesta acá: **las ~800 líneas de datos etiquetados a
mano seguirían existiendo enteras** — son la medición, no la implementación, y no hay forma de
abreviarlas sin destruir AC-2. **El código ejecutable nuevo es ~250 líneas.** Si el diff excede
2× el presupuesto, se justifica por escrito o se recorta.

---

## 15. Missing Inputs — estado

| MI | Estado |
|---|---|
| **MI-1** — no se pudo leer el issue #178 | ✅ **CERRADO**. Leído entero con `gh issue view`. No contradice el work-item; aporta §4.3 |
| **MI-2** — el F1 no corrió ni un barrido | ✅ **CERRADO**. §4.1 y §4.4: censo completo con control de instrumento (1706 archivos, 0 divergencias) |
| **MI-3** — la precisión del F1 es calibración | ✅ **CERRADO, y peor de lo esperado**: 21 % de recall contra el oráculo (§5.2). Reemplazado por §8 |
| **MI-4** — población de `doc/` con marcador histórico | ✅ **CERRADO dando vuelta la pregunta**: sólo **3 de 1095** artefactos declaran numerar el árbol vivo (§4.4) |
| **MI-5** — población del FN de D3 (párrafo con el nombre sin `:N`) | ✅ **CERRADO: 82 tokens** en el perímetro. Es la clase que la variante B recupera (recall 21 %→58 %) |
| **MI-6** — nombre de la rama | ✅ **CERRADO**. `main` @ `1e5a6aa`, tree limpio. Rama a crear: `feat/232-wkh-371-discriminador-de-citas-sueltas` |
| **MI-7** — ¿`test/` o `scripts/`? | ✅ **CERRADO**: `test/`, con typecheck explícito obligatorio (DT-12 + CD-16). Verificado que hoy sale limpio, exit 0 |
| 🆕 **MI-8** `[NO MEDIDO]` | La **precisión** de la cascada. Por definición, la mide F3 con §8. Este SDD publica la hipótesis, no el resultado |
| 🆕 **MI-9** `[NO MEDIDO]` | Cuántos de los 12675 sueltos de `doc/` son citas. No se mide en fino porque `doc/` no se toca; el censo publica la población y la regla de AC-5 |

---

## 16. Riesgos

1. **D5 (auto-cita) puede tener una precisión mala.** Es la regla más agresiva y la única que
   afirma un target sin ninguna evidencia en el párrafo. **Mitigado**: son sólo 94 tokens, W2.4
   los abre TODOS, y CD-19 fija el umbral de rechazo antes de medir.
2. **El etiquetador conoce las reglas.** Inherente. Declarado en §8.5; lo que se garantiza es la
   independencia de la muestra y del momento, no la de la mente.
3. **120 etiquetas a mano es trabajo lento y aburrido, y ahí es donde se cae la calidad.**
   Es el costo real de la HU (el F1 ya lo dijo: «el costo no es el guard»). Si F3 no puede
   sostenerlo, **el fallback es reducir a 40+40 y publicar el intervalo más ancho** — nunca
   publicar un número sin intervalo (CD-14).
4. **Este SDD publica números que envejecen solos.** Toda la §4 es una foto del 2026-08-28.
   Mitigado por W0.2 (re-derivar antes de empezar) y AC-8.
5. **W5 mueve texto y va a romper citas ancladas.** Es el patrón #1 del Auto-Blindaje, que ya
   costó una cuarta pasada en la 231. Mitigado por CD-6 + CD-10 y por dejar W5 al final.

---

## 17. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todos los `[HEREDADO]` del F1 verificados o refutados | ✅ — 1 refutado (costo de A/Biome), 2 corregidos (CD-9, 446 vs 447 líneas), el resto confirmado |
| 2 | Todos los `[NO MEDIDO]` cerrados o re-declarados con su motivo | ✅ — MI-1..MI-7 cerrados; MI-8/MI-9 abiertos **a propósito** y nombrados |
| 3 | Exemplars verificados con path real y leídos | ✅ — §3.2, los 6 |
| 4 | `citeTargetIfTracked` existe donde el F1 dijo | ✅ — `scanner.ts:251-267`, y **con un defecto nuevo medido** (§5.3) |
| 5 | Muestra reservada especificada: origen, independencia, tamaño, quién y cuándo etiqueta | ✅ — §8, con el mecanismo de ceguera verificable |
| 6 | Precisión **Y** recall, con ≥3 FP y ≥3 FN | ✅ — §8.4 (intervalos), §8.6 (los FP por censo), §5.2 (5 FN ya citados con sitio y motivo) |
| 7 | Perímetro declarado con su número Y su residuo | ✅ — §10 |
| 8 | `INDECIDIBLE` de primera clase, con sus productores | ✅ — D6, D7, residuo de D5 |
| 9 | Presupuesto de escala | ✅ — §14 |
| 10 | ≥1 test por AC | ✅ — §13, los 10 ACs |
| 11 | Línea base del gate medida y coincidente | ✅ — §2 |
| 12 | CDs heredados + nuevos + los del Auto-Blindaje histórico | ✅ — §11, 19 CDs |
| 13 | Ningún `[NEEDS CLARIFICATION]` sin marcar | ✅ — no queda ninguno |
| 14 | Waves con archivos exactos y frontera de commits | ✅ — §12, `S1..S5` |

**⇒ El SDD está LISTO para `SPEC_APPROVED`.**

---

### Apéndice — el detalle que el gate humano debería mirar antes de aprobar

Si sólo se lee una cosa de este documento, que sea ésta:

> **La cascada aprobada en F1 tenía 21 % de recall y borraba 5 citas reales en silencio.**
> No se descubrió corrigiendo el 100 %: se descubrió **buscando un conjunto etiquetado que
> nadie hubiera escrito mirando el clasificador**, y resultó que ya existía en el repo desde
> agosto. La lección operativa es la que este repo ya tiene escrita: *un instrumento que se
> compara contra su propia salida da verde con cualquier implementación, incluida la que no
> encuentra nada.*
