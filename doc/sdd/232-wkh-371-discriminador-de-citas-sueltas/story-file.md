# Story File — [WKH-371] El discriminador de citas sueltas

> **Fase F2.5 · Rol `nexus-architect` · 2026-08-28 · `main` @ `c556b5c`, working tree LIMPIO**
> Contrato AUTOSUFICIENTE para `nexus-dev`. Input: `sdd.md` (SPEC_APPROVED) + `work-item.md`.
> **Si algo no está acá, no está en la HU.** Si algo de acá contradice tu memoria, gana esto.

---

# 🛑 BLOQUE 0 — ANTI-ALUCINACIÓN. LEELO ANTES DE ESCRIBIR UNA LÍNEA

Esta HU ya tuvo **una medición que se cayó** y **dos defectos encontrados en el guardián que
existe**. Los cinco puntos de abajo no son contexto: son las trampas medidas de este trabajo.

### 1 · El «100 %» del F1 era 21 %

El F1 derivó sus reglas D1–D4 leyendo `test/cited-lines-guard.exceptions.ts` y después midió su
precisión **sobre ese mismo archivo**: 11 de 11 = 100 %. Medido contra un oráculo **independiente
y preexistente** —las 19 entradas de `CITED_LINES` con token P3/P4, etiquetadas a mano en *otras*
HUs entre el 2026-08-19 y el 2026-08-27, antes de que existiera ningún clasificador—:
**recall 4/19 = 21 %**, con **5 falsos negativos silenciosos**.

⇒ **Calibrar no es medir.** `AC-2` lo vuelve bloqueante. Si en algún momento de esta HU te
encontrás midiendo el clasificador contra datos que salieron del clasificador (o contra el archivo
del que sacaste una regla), **parate**: eso es el defecto, no la evidencia.

### 2 · La causa de los 5 FN tiene nombre: LA AUTO-CITA

Un párrafo que cita **su propio archivo nunca lo nombra**, y la regla del F1 exigía que lo
nombrara. Los 5 FN son 5 auto-citas. Con la regla nueva (D5): **16/19, 0 FN silenciosos, 0
destinos mal resueltos**. Los 5 sitios están en la tabla de W2.3 con su línea exacta.

### 3 · 🔴 El guardián que YA EXISTE es VACUO para esta forma — verificado en el árbol

```
test/cited-lines-guard.scanner.ts:304   export function citeMatchesTarget(fromFile, token, target)
test/cited-lines-guard.scanner.ts:306     if (raw === null) return true;
```

`citePathOf` devuelve `null` para todo token P3/P4 (no tienen ruta) ⇒ **`citeMatchesTarget`
devuelve `true` sin mirar nada**. El código de error `E-CITE_TARGET_MISMATCH` **no puede
dispararse jamás** para las 19 entradas P3/P4. Ése es el agujero de `AC-4`, y **tenés que verlo
rojo antes de arreglarlo** (W4.0).

> ⚠️ **PRECISIÓN QUE TE VA A SALVAR DE UN FALSO KILLED.** El encargo dice «las 19 entradas podrían
> declarar cualquier destino y nada las contradiría». **Eso es demasiado fuerte, y lo verifiqué.**
> Lo vacuo es **`citeMatchesTarget`**, no `G-C5` entero: `G-C5` (`test/cited-lines-guard.test.ts:989`)
> **también** cruza `mustContain` contra `target:line` y emite `E-TARGET_MISSING`,
> `E-LINE_OUT_OF_RANGE`, `E-WRONG_FILE`, `E-ANCHOR_GONE`, `E-LINE_MOVED`; y `G-C6` (`:1017`) cruza
> `symbolPath`. **Si mutás el `target` de una entrada P3/P4 a un archivo cualquiera, el gate se
> pone rojo HOY — pero por `E-ANCHOR_GONE`, no por lo que tu guard nuevo verifica.** Ese mutante
> «muere» sin probar nada. El mutante correcto está especificado en **W4.2**, y su diseño es
> mutar **el párrafo del citador**, no el registro.

### 4 · `citeTargetIfTracked` elige `candidates[0]` en silencio

```
test/cited-lines-guard.scanner.ts:265   if (!raw.includes('/')) return candidates[0] ?? null;
```

Medido hoy contra el índice de git: `sdd.md` tiene **127** candidatos, `work-item.md` **190**,
`index.ts` **9**. ⇒ un contexto `sdd.md` resolvería a **uno arbitrario de 127**. Por eso **CD-12**:
⛔ no se usa `citeTargetIfTracked` como resolvedor de destino y ⛔ **no se lo modifica** (es el
candado de `SCANNER_FALSE_POSITIVES`, vigilado por `G-C8`/`G-C11`).

### 5 · Los backticks NO discriminan — refutado por los dos lados

- `test/cited-lines-guard.exceptions.ts` escribe puertos **backtickeados**: `` `:8443` ``,
  `` `:443` ``, `` `:80` ``, `` `:0` `` (forma P3, la más «de cita» que existe) — son RUIDO.
- Y al revés: 42 de los 229 `CITA` de la variante C son **P4**, o sea sin un solo backtick.

⛔ **Ninguna regla tuya puede apoyarse en los backticks.** Ni en el rango del número (**CD-4**).

---

# 1 · Qué se construye, y por qué

Un `:N` suelto (`` `:60` ``, `:208`) se pudre cuando alguien inserta líneas más arriba y **ningún
guardián lo ve**: sin el nombre del archivo, el guardián no sabe qué archivo abrir. Y nadie sabe
cuántos hay, porque el patrón que los cuenta cuenta también puertos, chain IDs y timestamps.

**El entregable es el DISCRIMINADOR** (`classifyBareCite`), **su medición honesta** (una muestra
reservada etiquetada antes de que el clasificador exista) y **el cruce mecánico** que hoy es vacuo.

Se parte en **dos cortes**. **El Corte A cierra solo y ya vale** (convierte «8501» en un número con
instrumento). El Corte B agrega el guard que puede ponerse rojo y las correcciones.

---

# 2 · El gate — el comando exacto, y las dos trampas

⛔ **`npm run qa` NO EXISTE en este repo.** El gate es la secuencia de `.github/workflows/ci.yml`,
**en este orden, completo, una vez por wave**:

```bash
git add -A                                # CD-7 — ver abajo por qué NO es opcional
npx tsc -p tsconfig.json --noEmit         # esperado: exit 0
npm run lint                              # esperado: "Checked 520 files ... No fixes applied." exit 0
npm test                                  # esperado: Test Files 314 passed | 6 skipped (320)
                                          #           Tests     6350 passed | 19 skipped (6369)
```

**Línea base `[VERIFICADA en F2 sobre el árbol limpio]`: `tsc 0 · lint 520 · 314/320 archivos ·
6350/6369 casos`.** Publicá los cuatro números al cerrar cada wave.

> ⚠️ `npm test` emite `Failed to load source map for typescript.js` (ruido de vite, exit 0).
> **No es una regresión.** No lo reportes como hallazgo.

### Trampa A — `git add -A` antes del gate (CD-7)

`test/readme-numbers.test.ts:83` enumera con `git ls-files`, o sea **contra el ÍNDICE**. Con
archivos untracked el gate **da verde en falso**.

### Trampa B — los 4 números del README: **medido, NO cambian con esta HU**

El encargo advierte que «si sumás archivos, los 4 números de `README.md`/`README.es.md` cambian».
**Lo medí y para esta HU es FALSO, y saberlo te ahorra una edición innecesaria de los README:**

| Número | De dónde sale | ¿Lo mueve esta HU? |
|---|---|---|
| `**320 test files**` (`README.md:378`, `README.es.md:412`) | `vitest.config.ts:5` → `['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.test.mjs']` sobre `git ls-files` | ❌ **NO**. `test/cited-lines-guard.sample.ts` **no matchea `*.test.ts`**. Medido hoy: 320 trackeados, README declara 320 |
| `over **N** files` (lint) | `biome.json:9` → `["src/**/*.ts"]` | ❌ NO — esta HU no agrega archivos a `src/` |
| `**N** variables` | `.env.example` | ❌ NO |
| pisos de cobertura | `vitest.config.ts` thresholds | ❌ NO |

⇒ ⛔ **PROHIBIDO editar los números de los README en esta HU.** Si alguno cambiara, es la señal de
que creaste un archivo con un nombre que no corresponde (`*.test.ts` en vez de `.sample.ts`).
**Derivalo corriendo el guardián; nunca lo escribas a mano.**

### El typecheck que el gate NO hace (CD-16, DT-12)

`tsconfig.json:19` es `"include": ["src/**/*"]` y `package.json:11` es `"lint": "biome check src/"`
⇒ **nada del gate typechequea ni lintea `test/`**, y este repo lo pagó dos veces en tres HUs.
⛔ **NO se toca `tsconfig.json`.** En cada wave, además del gate, corré esto y anotá el exit
(hoy sale limpio, exit 0):

```bash
npx tsc --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck \
  test/cited-lines-guard.scanner.ts test/cited-lines-guard.citations.ts \
  test/cited-lines-guard.exceptions.ts test/cited-lines-guard.sample.ts \
  test/cited-lines-guard.test.ts
```

---

# 3 · Herramientas — footguns MEDIDOS de este entorno

| ⛔ No uses | ✅ Usá | Por qué (medido) |
|---|---|---|
| `Grep` (la tool) | `/usr/bin/grep -rn` | La tool respeta `.gitignore` y devuelve **CERO** sobre `doc/` |
| `cat` | `Read`, `sed -n 'A,Bp'`, `/usr/bin/awk` | Bajo `rtk` devolvió **69 líneas de un archivo de 79** |
| `git diff` | `/usr/bin/git diff` | Trunca cortando hunks (3250 líneas salieron 532) |
| `diff` | `/usr/bin/diff` o `sha256sum` | Dijo «Files are identical» sobre archivos DISTINTOS (**CD-17**) |
| `git checkout --` | `cp` desde backup | ⛔ **NUNCA.** Borra lo que estás midiendo |
| `git log` (bajo rtk) | `/usr/bin/git log` | Borra los merges |
| `npx <bin>` si falla | `./node_modules/.bin/<bin>` | Medido hoy: `npx tsx` se reescribió a `npm ... tsx` → «Missing script» |

**Backups**: subdirectorio propio de esta sesión, nunca `/tmp` compartido (ya hubo un `.bak` de
otra sesión contaminando una medición). Restauración **verificada por `sha256sum` antes y después**.

---

# 4 · El perímetro, con su número — **RE-DERIVADO POR MÍ HOY, y reproduce exacto**

**Patrón**: las 4 formas de `scanSource` (`test/cited-lines-guard.scanner.ts:161-207`).
**Universo**: el ÍNDICE DE GIT (`git ls-files`), no el disco. **Foto: 2026-08-28 @ `c556b5c`.**

```
archivos escaneados: 611 de 611
tokens por forma:  P1 250 · P2 498 · P3 277 · P4 1070      total 2095
SUELTOS (P3+P4):   1347
```

**Coincide DÍGITO A DÍGITO con §4.1 del SDD.** El SDD midió en `1e5a6aa` y yo en `c556b5c`: el
perímetro `src+test+scripts` **no se movió** porque los artefactos de esta HU viven en `doc/`.

### Los 7 archivos que quedan FUERA del universo del clasificador (DT-11, CD-13) — re-derivados

| Archivo | tokens P3/P4 |
|---|---|
| `test/cited-lines-guard.scanner.ts` | 27 |
| `test/cited-lines-guard.test.ts` | 25 |
| `test/cited-lines-guard.citations.ts` | 73 |
| `test/cited-lines-guard.exceptions.ts` | 33 |
| **subtotal cited-lines (4)** | **158** |
| `test/ownership-filter-guard.scanner.ts` | 1 |
| `test/ownership-filter-guard.test.ts` | 9 |
| `test/ownership-filter-guard.exceptions.ts` | 27 |
| **subtotal ownership (3)** | **37** |
| **TOTAL DT-11** | **195** |

**Marco bruto medido: 1347 − 195 = 1152.** Menos las ~25 ocurrencias ya etiquetadas por el oráculo
⇒ **~1127**, exactamente el marco de §8.2 del SDD. ✅

### ⛔ Lo que queda AFUERA, cada uno con su número — un candado con perímetro incompleto se lee como lista cerrada

| Fuera | Número | Por qué |
|---|---|---|
| `doc/` | **1096 archivos** (`git ls-files doc \| wc -l`, hoy) · 12675 sueltos `[foto del SDD]` | AC-5: registro histórico por defecto. Sólo 3 de ~1095 artefactos declaran numerar el árbol vivo, y 2 son de esta HU |
| Raíz del repo | **19 archivos trackeados** (medido hoy) · 33 sueltos `[foto del SDD]` | No entra al arreglo. ⚠️ **El SDD dice «13 archivos» — ver §9, discrepancia D-4** |
| Los 4 del guardián de citas | **158 sueltos** | DT-11/CD-13. `TD-224-CITAS-DEL-PROPIO-GUARDIAN` **no se cierra acá**, se declara |
| Los 3 de ownership-guard | **37 sueltos** | Ídem; sus 41 pares ya tienen testigo (`G-08`/`G-09`) |
| `.nexus/project-context.md` | **`[NO MEDIDO]`** — no está en el índice de git | `TD-316-CITAS-PROJECT-CONTEXT`: el repo es PÚBLICO. **Es una ausencia, no un cero** |
| `chaski-v3`, `wasiai-remittance-agents` | **`[NO MEDIDO]`** | `TD-371-PORTABILIDAD`: universos de git distintos |
| `mcp-servers/**`, `packages/**` | fuera del perímetro | El `npm test` de la raíz no los corre |

**Residuo del propio instrumento** (lo que el escáner NO ve, y por eso 1347 es un **PISO**): la
prosa suelta sin forma sintáctica («la línea 95»), las citas partidas en dos líneas, los archivos
sin extensión (`Dockerfile:12`), y el **valor semántico** de la afirmación.

---

# 5 · Scope IN — la lista exhaustiva de archivos que podés tocar

| # | Archivo | Wave | Qué se hace |
|---|---|---|---|
| 1 | `test/cited-lines-guard.sample.ts` | **W1** (nuevo) | El marco, la semilla, el sorteo y las 120 etiquetas |
| 2 | `test/cited-lines-guard.scanner.ts` | **W2.1** | `paragraphOf`, `resolveContextTarget`, `classifyBareCite`. ⛔ NO se modifica `citeTargetIfTracked` |
| 3 | `test/cited-lines-guard.test.ts` | **W2.2/2.3, W4** | `G-C13`..`G-C18` + el docblock (⚠️ ver D-1) |
| 4 | `test/cited-lines-guard.exceptions.ts` | **W2.4** | Los `INDECIDIBLE` con motivo **leído en el sitio** |
| 5 | `test/cited-lines-guard.citations.ts` | **W4** | Sólo si una entrada P3/P4 necesita corrección. ⛔ **NO se toca `CORTE_A_PATHS`** |
| 6 | `doc/sdd/232-…/censo.md` | **W3** (nuevo) | El censo publicado |
| 7 | Comentarios de `src/`, `test/`, `scripts/` | **W5** | ⛔ **100 % comentario** (CD-8), commit aparte |

## Scope OUT — ⛔ no lo toques ni «de paso»

- ⛔ **`doc/`** no se re-ancla (fuera de `doc/sdd/232-…/`). Se mide y se declara.
- ⛔ **`.nexus/project-context.md`** — repo público.
- ⛔ **`chaski-v3` / `wasiai-remittance-agents`** — otros repos.
- ⛔ **Ninguna línea de código EJECUTABLE en `src/`** (CD-8). Si el CR encuentra una, es BLOQUEANTE.
- ⛔ **Ampliar `CORTE_A_PATHS`** — es otra HU. Y además **`test/cited-lines-guard.test.ts:715`
  asserta `expect(CORTE_A_PATHS.length).toBe(14)`**: agregarle un path pone `G-C1` rojo.
- ⛔ **Modificar `citeTargetIfTracked`** (CD-12) ni `citeMatchesTarget` para P1/P2.
- ⛔ **`tsconfig.json`** — meter `test/**` al gate es otra HU.
- ⛔ **`doc/sdd/_INDEX.md` por encima de la línea 144** (CD-9) — ver abajo.

---

# 6 · Constraint Directives — no se negocian

| CD | Regla |
|---|---|
| **CD-1** | ⛔ PROHIBIDO publicar un número de citas sueltas sin declarar, **en la misma frase**, el PERÍMETRO y el PATRÓN que lo produjeron |
| **CD-2** | ⛔ **PROHIBIDO barrer deuda vieja y nueva en el mismo commit.** Parte de la deuda ya estaba rota ANTES; mezclarla hace imposible saber cuál era cuál |
| **CD-3** | ⛔ PROHIBIDO que un control busque un literal en la misma línea donde ese literal está escrito. Nunca puede fallar |
| **CD-4** | ⛔ PROHIBIDO descartar un token por el **RANGO** de su número |
| **CD-5** | ⛔ PROHIBIDO re-anclar una cita de `doc/sdd/**` que documente un árbol pasado (incluidos `work-item.md` y `sdd.md` de esta HU) |
| **CD-6** | ⛔ PROHIBIDO actualizar una cita sumándole un delta. **OBLIGATORIO abrir la línea** y confirmar el símbolo contenedor |
| **CD-7** | ⛔ PROHIBIDO correr el gate sin `git add -A` antes |
| **CD-8** | ⛔ PROHIBIDA cualquier línea de código EJECUTABLE en el diff de `src/` |
| **CD-9** | ⛔ **PROHIBIDO tocar `doc/sdd/_INDEX.md` por encima de la línea 144.** ✅ **VERIFICADO hoy**: `src/lib/capability-risk.ts:82` escribe ``bdwv (`doc/sdd/_INDEX.md:144`)`` y `src/lib/capability-risk.test.ts:58` lo repite. ⚠️ El **work-item decía `src/services/capability-risk.ts`, que NO EXISTE**; el archivo real es `src/lib/`. La fila 232 ya existe en `_INDEX.md:224` (las filas se **agregan al final**, así que ampliarla es seguro) |
| **CD-10** | **OBLIGATORIO que el arreglo de citas sea LO ÚLTIMO de cada wave**, después del formateador y de la última edición |
| **CD-11** | ⛔ PROHIBIDO generar cualquier lista de excepciones **volcando la salida del clasificador**. Cada entrada se escribe **después de leer el sitio** |
| **CD-12** | ⛔ PROHIBIDO usar `citeTargetIfTracked` como resolvedor de destino, y ⛔ prohibido modificarlo |
| **CD-13** | ⛔ PROHIBIDO que el clasificador corra sobre los 7 archivos de DT-11 |
| **CD-14** | ⛔ PROHIBIDO publicar un número de precisión sin (a) su intervalo, (b) los dos estratos por separado, (c) la palabra «foto» con su fecha |
| **CD-15** | ⛔ PROHIBIDO etiquetar la muestra reservada después de que `classifyBareCite` exista en el árbol |
| **CD-16** | **OBLIGATORIO** correr el typecheck de §2 en CADA wave y anotar el exit |
| **CD-17** | ⛔ PROHIBIDO usar el `diff` del entorno para verificar una restauración. `/usr/bin/diff` o `sha256sum`, **comparado antes y después** |
| **CD-18** | **OBLIGATORIO verificar que un mutante SE APLICÓ antes de correr la suite.** El rojo se confirma **por su MOTIVO literal**, no por el color |
| **CD-19** | El umbral de rechazo de D5 se escribe **ANTES** de medir: **>20 FP sobre 94 ⇒ D5 se degrada a `INDECIDIBLE`** y se re-publica todo |
| **CD-20** 🆕 | ⛔ **`test/cited-lines-guard.sample.ts` es el OCTAVO archivo auto-referente**: sus 120 entradas contienen el `target` que el clasificador tiene que producir. **Va a la misma exclusión que los 7 de DT-11** (CD-3/CD-13). Ver D-2 |
| **CD-21** 🆕 | ⛔ **El marco de la muestra y el censo del perímetro se derivan contra un COMMIT BASE FIJO**, anotado por hash, y **excluyendo los archivos que esta HU crea o engorda**. Si no, el instrumento se mide a sí mismo. Ver D-3 |

## Los 5 patrones del Auto-Blindaje histórico que YA se repitieron (≥2 de las últimas 3 HUs)

Leídos de `doc/sdd/{229,230,231}-*/auto-blindaje.md`:

| # | Patrón | Dónde | Qué lo previene acá |
|---|---|---|---|
| 1 | Citas rotas por el **propio desplazamiento del Dev**, con deltas DISTINTOS por archivo | 229 (7 citas, 3 deltas distintos), 231 (`BLQ-2`: `+64` donde iba `+78`) | **CD-6 + CD-10** |
| 2 | **Correr las PARTES del gate no es correr el gate**; `lint` es el eslabón que nadie alcanza | 229 (W0), 230, 231 (W4.2: **28 rojos** que ninguna suite vio) | **CD-7 + §2 completo y en orden** |
| 3 | **Errores de tipos que `vitest` no puede ver** | 230 (W1), 229 (W2: `cacheHit: 'MISS'` no existe en el tipo) | **CD-16** |
| 4 | **Mutantes que NO se aplicaron y la corrida salió verde** | 229 (W2), 231 (`BLQ-1`: tres mutantes vivos) | **CD-18** |
| 5 | **Herramientas del entorno que mienten** (`diff` idénticos, scratchpad compartido) | 229 (W1), 230 (W1) | **CD-17 + §3** |

---

# 7 · La cascada — el contrato exacto de `classifyBareCite`

```ts
type BareLabel = 'CITA' | 'RUIDO' | 'DATO' | 'INDECIDIBLE';
interface BareVerdict {
  label: BareLabel;          // EXACTAMENTE una (AC-1)
  target?: string;           // presente si y sólo si label === 'CITA'
  why: string;               // el motivo, legible, con el nombre de la regla que decidió
  rule: 'D1'|'D2'|'D3a'|'D3b'|'D5'|'D6'|'D7'|'RESIDUO';
}
export function classifyBareCite(
  hit: FoundCite,                                  // el token, con file/line/cite/form
  src: string,                                     // el fuente del CITADOR
  tracked: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, readonly string[]>,
): BareVerdict;
```

| # | Regla | Decide | Población medida en F2 |
|---|---|---|---|
| **D0** | `prev === ':'` | descarta `::1` — **YA IMPLEMENTADA**, `scanner.ts:192`, no la reescribas | (fuera del universo) |
| **D1** | el carácter inmediatamente anterior al `:` es `[A-Za-z0-9_]` | ⇒ **`RUIDO`** (`localhost:3001`, `eip155:43113`, `T00:00:00`, `minLength:1`) | 976 |
| **D2** | el carácter anterior es `'` o `"` | ⇒ **`DATO`** (valor de un campo `cite:`/`quote:`, ya tiene testigo en `G-C5`/`G-C7`) | 38 |
| **D3a** | el **párrafo** contiene **exactamente un** archivo trackeado nombrado **con `:N`** | ⇒ **`CITA`**, target = ese | 102 |
| **D3b** | ídem pero nombrado **SIN `:N`** | ⇒ **`CITA`**, target = ese | 33 |
| **D6** | el párrafo nombra **más de un** archivo trackeado | ⇒ **`INDECIDIBLE`** — *es el bug del issue* | 104 |
| **D7** | el único contexto es un basename con **>1 candidato** | ⇒ **`INDECIDIBLE`** (nunca `candidates[0]`) | incluido en D6 |
| **D5** | el párrafo no nombra ningún archivo trackeado **y** el `:N` cae dentro del rango de líneas del propio citador | ⇒ **`CITA`**, target = **el propio citador** (auto-cita) | **94** |
| **RESIDUO** | todo lo demás | ⇒ **`INDECIDIBLE`**, con motivo escrito | — |

**Orden de evaluación**: D1 → D2 → (D6/D7 antes que D3, porque la ambigüedad gana) → D3a → D3b →
D5 → RESIDUO.

⚠️ **D7 sólo decide cuando la ambigüedad es el ÚNICO contexto.** Medido: la versión gruesa (todo
párrafo con *algún* nombre ambiguo ⇒ `INDECIDIBLE`) **bajó el recall de 84 % a 53 %**. Si el
párrafo tiene un contexto **no ambiguo** además del ambiguo, **gana el no ambiguo**.

⚠️ **D5 NO aplica** si el citador no tiene símbolos TS resolubles y el `:N` cae fuera del rango de
líneas del propio archivo ⇒ `INDECIDIBLE`, nunca `CITA`.

### `paragraphOf` — la definición mecánica (DT-10), y por qué el punto (c) es obligatorio

Corrida máxima de líneas alrededor del token, cortada por:
- **(a)** línea vacía;
- **(b)** línea de sólo decoración (`*`, `//`, `/**`, `*/`, reglas de guiones o cajas);
- **(c)** 🔴 **cambio de naturaleza** entre «línea que es sólo comentario» y «línea con código».

**Motivo medido**: sin (c), en `test/cited-lines-guard.citations.ts` —una lista de literales de
objeto **sin líneas en blanco entre entradas**— el párrafo **se derrama a través de varias
entradas** y produce `D6 multi(5)` con archivos de entradas vecinas.

### Salida esperada sobre el perímetro (hipótesis a RE-DERIVAR, ⛔ no un literal a copiar)

```
CITA 229 · RUIDO 976 · DATO 38 · INDECIDIBLE 104        (total 1347)
   de los 229 CITA: 102 por D3a · 33 por D3b · 94 por D5
```

Si tu corrida no da esto, **manda tu derivación** y anotá la diferencia con su causa (AC-8).

---

# 8 · WAVES

> **Regla transversal (CD-10):** en TODA wave, **arreglar citas es LO ÚLTIMO**, después de la
> última edición de esa wave, y **abriendo la línea, nunca sumando el delta**. La HU 231
> re-derivó **cuatro veces**, la última por un párrafo de prosa (*«un párrafo que crece 3
> renglones desplaza tanto como un `if`»*).
> **Regla transversal (CD-16):** el typecheck de §2 al cerrar cada wave, con su exit anotado.

## Dependencias

```
W0 ──> W1 ──(COMMIT S1, S2)──> W2 ──> W3 (COMMIT S3 · CORTE A CIERRA)
                                        │
                                        └──> W4 (COMMIT S4) ──> W5 (COMMIT S5) ──> W6
```

⛔ **W1 ANTES que W2, sin excepción.** Si etiquetás después de ver la salida del clasificador, la
medición **no vale** y hay que rehacerla entera.

---

## W0 — Serial. Nada empieza sin esto

| | |
|---|---|
| **Archivos** | **ninguno** (sólo medición) |

**W0.1** — Rama `feat/232-wkh-371-discriminador-de-citas-sueltas` desde `main` @ `c556b5c`.
Anotá el **hash del commit base** en un archivo de notas de tu scratchpad: **CD-21 y AC-9 lo
necesitan** (`git show <base>:<archivo>`).

**W0.2** — `git add -A` → gate completo en orden → publicá los 4 números contra §2.

**W0.3** — **Re-derivar el censo del perímetro** con un script desechable que **importe el escáner
REAL** (`test/cited-lines-guard.scanner.ts`), nunca re-implementando las regexes.

**Corré el control de instrumento antes de creerle a cualquier número**: re-derivá el conteo por
archivo con tu propio recorrido y compará contra `scanSource` archivo por archivo. Divergencias
esperadas: **0**. Sin ese control, un número tuyo puede ser un defecto de tu herramienta y no del
repo (patrón «mi herramienta de medición fabricó un bug»).

**Números a reproducir** (re-derivados por el Architect hoy en `c556b5c`, reproducen exacto):

```
611 archivos · P1 250 · P2 498 · P3 277 · P4 1070 · total 2095 · SUELTOS 1347
DT-11: 158 (4 de cited-lines) + 37 (3 de ownership) = 195   ⇒ marco bruto 1152
```

### ✅ Criterio de terminado de W0
- [ ] Gate completo corrido en orden, 4 números publicados contra la base.
- [ ] Censo re-derivado, **con el control de instrumento en 0 divergencias**.
- [ ] Cada diferencia con los números de arriba, anotada con su causa (AC-8).
- [ ] Hash del commit base anotado.

---

## W1 — Serial. El marco y la muestra, **ANTES** del clasificador (AC-2, CD-15)

| | |
|---|---|
| **Archivos** | `test/cited-lines-guard.sample.ts` (**NUEVO**) |
| **Exemplar** | `test/ownership-filter-guard.scanner.ts` + `test/ownership-filter-guard.exceptions.ts` — el par «derivador puro + datos escritos a mano leyendo el sitio». Y `test/cited-lines-guard.exceptions.ts:247-278` (`SCANNER_FALSE_POSITIVES`) para la forma de una entrada con `reason` en prosa larga |

### W1.1 — El marco y el sorteo, **sin etiquetas**

```ts
export const SAMPLE_SEED = 'WKH-371';
export const SAMPLE_BASE_COMMIT = '<hash del commit base de W0.1>';   // CD-21
/** Los 8 archivos auto-referentes: los 7 de DT-11 + este mismo (CD-20). */
export const SELF_REFERENTIAL: readonly string[] = [ /* … */ ];
export function sampleFrame(...): readonly FoundCite[];   // 1347 − 195 − oráculo ≈ 1127
export function drawReservedSample(frame, seed): readonly SampleSite[];  // xorshift32
export const RESERVED_SAMPLE: readonly SampleSite[] = [ /* 120 sitios SIN etiqueta */ ];
```

- **Estratos: `P3` (con backticks) y `P4` (sin).** La forma la produce `scanSource` desde el
  2026-08-19 y **no participa de ninguna regla de la cascada** ⇒ estratificar por ella **no
  contamina**. ⛔ **PROHIBIDO estratificar por la etiqueta predicha.**
- **Motivo de estratificar (medido)**: `CITA` es **106/277 = 38 %** en P3 y **15/1070 = 1,4 %** en
  P4. Un sorteo simple de 120 traería ~2 citas de P4 y no diría nada.
- **n = 120 = 60 de P3 + 60 de P4.**
- **Sorteo**: PRNG determinista (`xorshift32` sobre `SAMPLE_SEED`) sobre el marco ordenado por
  `(file, line, col)`. Reproducible por cualquiera. ⛔ **Vos no elegís qué tokens etiquetar.**
- `sampleFrame()` **excluye** los 8 archivos de `SELF_REFERENTIAL` (CD-20) y las ocurrencias ya
  etiquetadas por el oráculo.

**⇒ COMMIT `S1`.** ⛔ Este commit **no toca ninguna cita** (CD-2).

### W1.2 — Etiquetar los 120 **abriendo cada sitio** (CD-11)

Por sitio: `label ∈ {CITA,RUIDO,DATO,INDECIDIBLE}`, `target` cuando sea `CITA`, y `reason` de una
línea **leída en el sitio**. ⛔ **PROHIBIDO volcar la salida de nada.**

**⇒ COMMIT `S2`** — anotá su hash.

### 🔴 La prueba de ceguera — **es criterio de terminado, no una promesa**

La independencia **no se promete: se garantiza por ORDEN DE COMMITS**, y se verifica así:

```bash
/usr/bin/git show S2:test/cited-lines-guard.scanner.ts | /usr/bin/grep -c classifyBareCite
# → 0    ⛔ cualquier otro valor invalida la medición entera
/usr/bin/git merge-base --is-ancestor S2 S3 && echo "S2 precede a S3"
```

⚠️ **Lo que este mecanismo NO garantiza, y va escrito en el censo:** vos leíste este Story File,
así que **conocés las reglas** cuando etiquetás. Eso es inevitable —etiquetar exige saber qué es
una `CITA`— y **no es lo que AC-2 prohíbe**. AC-2 prohíbe que la muestra sea la misma de la que
salieron las reglas, y que las etiquetas se ajusten después de ver la salida. **La independencia
es de la MUESTRA y del MOMENTO, no de la mente del que etiqueta.** Decirlo al revés es prosa que
afirma de más.

### ✅ Criterio de terminado de W1
- [ ] `RESERVED_SAMPLE` = 120 sitios, 60 P3 + 60 P4, sorteados con semilla escrita en el archivo.
- [ ] El sorteo **se re-corre y da lo mismo** (determinismo verificado, no supuesto).
- [ ] Las 120 etiquetas escritas **abriendo el sitio**, con `reason`.
- [ ] `git show S2:…scanner.ts | grep -c classifyBareCite` → **0**, salida pegada en las notas.
- [ ] Hashes de `S1` y `S2` anotados.
- [ ] Typecheck de §2, exit anotado. Gate completo, 4 números.

> **Fallback autorizado (riesgo 3 del SDD):** si 120 etiquetas a mano no son sostenibles, se baja a
> **40+40** y se publica el **intervalo más ancho**. ⛔ **Nunca** se publica un número sin intervalo
> (CD-14). Bajar el n es aceptable; publicar sin intervalo, no.

---

## W2 — El clasificador. **Acá recién nace `classifyBareCite`**

| | |
|---|---|
| **Archivos** | `test/cited-lines-guard.scanner.ts`, `test/cited-lines-guard.test.ts`, `test/cited-lines-guard.exceptions.ts` |
| **Depende de** | W1 cerrada con `S2` commiteado |

### Exemplars verificados (path confirmado y leído por el Architect hoy)

| Exemplar | Línea real | Qué copiar |
|---|---|---|
| `test/cited-lines-guard.scanner.ts` → `scanSource` | **:161-207** | Función **pura** sobre texto, misma firma-estilo. El discriminador va al lado |
| `test/cited-lines-guard.scanner.ts` → `citeTargetIfTracked` | **:251-267** | La resolución contra el ÍNDICE de git. ⛔ **Se LEE, no se modifica.** Su `candidates[0] ?? null` está en **:265** |
| `test/cited-lines-guard.scanner.ts` → `resolveSymbolPath` | **:467** | Lo que D5 necesita para «el citador tiene símbolos resolubles». `SYMBOLLESS` (`.md/.json/.sql/…`) en **:453** |
| `test/cited-lines-guard.test.ts` → `G-C11` | **:1484** | 🔴 **El control en las DOS direcciones con fixtures en memoria**: mata la cita real y deja pasar el ruido. **Los controles nuevos se calcan de acá** |
| `test/cited-lines-guard.test.ts` → `G-C2` | **:745** | Fixture en memoria con **la respuesta conocida de antemano**, para que el escáner no se compare contra su propia salida |
| `test/cited-lines-guard.test.ts` → `TRACKED` / `BY_BASENAME` / `readTracked` | **:266-298** | Ya existen. **Reusalos**, no los redeclares |
| `test/cited-lines-guard.citations.ts` | **:460-491** | La forma de una entrada P3/P4 con `targetReason` |

### 🔴 El exemplar que vale más que todos — D3 ya está escrita en prosa en el repo

`test/cited-lines-guard.citations.ts:482-491` declara `` `:95` `` en `src/lib/operator-address.ts`
con este motivo, escrito **a mano en agosto**:

> «El archivo lo nombra **la línea inmediatamente anterior del mismo docblock**
> (`getSolanaOperatorKeypair()` (`../adapters/solana/chain.ts:84`)), y las tres citas de esa
> oración —`:84`, `:95`, `:137-149`— hablan del mismo archivo.»

⇒ **D3 no es una heurística nueva: es la formalización mecánica de lo que los humanos de este repo
ya escriben a mano, entrada por entrada.**

### W2.1 — El código

En `test/cited-lines-guard.scanner.ts`, **al lado de `citeNamesFile` / `citeTargetIfTracked`**,
funciones **puras** (sin tocar disco, sin `execFileSync`):

- `paragraphOf(src, line)` → el párrafo (DT-10, con el punto (c)).
- `resolveContextTarget(...)` → `{ target: string } | 'AMBIGUOUS' | null`. ⛔ **NUNCA
  `string | null`**, porque eso es exactamente el defecto de `candidates[0]`.
- `classifyBareCite(...)` → `BareVerdict` (§7).

### W2.2 — Los controles `G-C13`..`G-C16`

### W2.3 — El oráculo ⇒ `G-C17`

**El oráculo son las 19 entradas de `CITED_LINES` con token P3/P4** — verificadas por mí hoy, con
su línea exacta en `test/cited-lines-guard.citations.ts`:

```
183 `:922`   220 `:203-225`   344 :634    462 `:1-16`   482 `:95`    494 `:137-149`
533 `:220`   544 `:237`       555 `:252`  566 `:459`    577 `:475`   599 `:72`
607 `:76-77` 640 `:211`       679 :316    692 :336      706 `:66`    717 `:124`
764 `:227`
```

Más las **3 entradas de `SCANNER_FALSE_POSITIVES`** (`test/cited-lines-guard.exceptions.ts:247-278`,
**4 ocurrencias**: `:100`, `:1`, `:00`×2), que son **RUIDO etiquetado a mano**.

**Los 5 falsos negativos de la cascada del F1** — abiertos y leídos, cumplen «≥3 FN con sitio y
motivo» de AC-1. Reprodúcelos:

| # | Sitio | Token | Target declarado | Entrada | Por qué D3 lo pierde |
|---|---|---|---|---|---|
| FN-1 | `src/types/index.ts:288` | `` `:203-225` `` | `src/types/index.ts` | citations.ts:220 | **Auto-cita.** El párrafo nombra un **símbolo** (`AgentPaymentSpec.contract`), no un archivo |
| FN-2 | `src/services/compose.ts:751` | `:634` | `src/services/compose.ts` | citations.ts:344 | **Auto-cita.** «guard `i > 0` de :634» — el párrafo entero habla de este archivo y por eso no lo nombra |
| FN-3 | `src/routes/agents.ownership.test.ts:13` | `` `:72` `` | sí mismo | citations.ts:599 | Auto-cita |
| FN-4 | ídem | `` `:76-77` `` | sí mismo | citations.ts:607 | Ídem, misma oración |
| FN-5 | `src/routes/agents.ownership.test.ts:25` | `` `:211` `` | sí mismo | citations.ts:640 | Auto-cita **mal desviada**: el párrafo nombra `src/services/agent.ownership.test.ts`, que resuelve por basename a **otro** archivo |

> 💡 `citations.ts` ya trae el comentario `── src/routes/agents.ownership.test.ts (las tres son
> AUTO-CITAS) ──`. **La auto-cita es 5 de 5**: no es un borde, es la forma principal en que este
> repo escribe una cita suelta.

### W2.4 — 🔴 El censo de FP de D5: **abrir los 94 sitios, TODOS**

D5 es la regla más agresiva y la única que afirma un target **sin ninguna evidencia en el
párrafo**. Por eso su verificación **no es un muestreo: es un censo**. Sólo **94 tokens** llegan a
D5 (los demás mueren antes: D1 976, D2 38, D3a 102, D3b 33, D6 104). **Abrilos todos, etiquetalos
a mano.**

⛔ **CD-19, escrito ANTES de medir:** si D5 tiene **más de 20 FP sobre 94**, **D5 se degrada a
`INDECIDIBLE` y se re-publica todo**. Sin umbral previo, cualquier resultado se narra como éxito.

Los `INDECIDIBLE` van a `test/cited-lines-guard.exceptions.ts` **con motivo leído en el sitio**
(CD-11), **nunca volcando la salida del clasificador**.

### W2.5 — La muestra reservada ⇒ `G-C17b`

Matriz de confusión **por estrato**, precisión y recall con **intervalo de Wilson al 95 %**, más el
**agregado ponderado por el marco** (peso P3 = |P3 del marco| / |marco|, ídem P4).

**Qué dice cada estrato, y nada más:**
- **P3 (n=60) → PRECISIÓN.** ~38 % predichos `CITA` ⇒ ~23 casos. Si la precisión real fuera 80 %,
  la probabilidad de observar **cero** errores en 23 es `0,80²³ = 0,6 %` ⇒ la muestra **distingue
  «≥95 %» de «≤80 %»**. Eso es lo que se afirma.
- **P4 (n=60) → COTA SUPERIOR DEL FALSO NEGATIVO.** Con 0 FN observados, la cota al 95 % es
  `1 − 0,05^(1/60) = 4,9 %`, o sea **≤ ~52 citas no detectadas entre los 1070 tokens P4**.

⛔ **CD-14: PROHIBIDO publicar un único número de precisión sin su intervalo y sin los dos
estratos.**

### Tests de W2 — cada uno con su mutante y el ROJO ESPERADO POR SU MOTIVO

| ID | AC | Qué cubre | **Mutante exacto** | **Rojo esperado (por su motivo)** |
|---|---|---|---|---|
| `G-C13` | AC-1 | La cascada emite **exactamente una** de las 4 etiquetas, y **las 4 son alcanzables** con fixtures en memoria | Hacer que `classifyBareCite` devuelva `'CITA'` también cuando `rule === 'D1'` | El fixture `localhost:3001` deja de estar en la clase `RUIDO` ⇒ *«la clase RUIDO quedó inalcanzable»* |
| `G-C14` | AC-1 | **Las dos direcciones** (calcado de `G-C11`, `:1484`): fixture `const url = 'http://localhost:3001/x';` ⇒ **`RUIDO`**; fixture `` // ver `agent.ts:12`, y el guard de `:20` `` ⇒ **`CITA`** con target resuelto | (a) aflojar D1 (sacar el chequeo del char previo); (b) endurecer D3 (exigir P1/P2 y borrar D3b) | (a) el puerto pasa a `CITA` ⇒ *«se esperaba RUIDO para `:3001`»*; (b) la cita cae a `INDECIDIBLE` ⇒ *«se esperaba CITA con target `…/agent.ts`»* |
| `G-C15` | AC-1, CD-12 | **Homónimo**: fixture cuyo único contexto es `sdd.md` ⇒ **`INDECIDIBLE`**, **nunca** `candidates[0]` | Sustituir `resolveContextTarget` por `citeTargetIfTracked` en D3b | Resuelve un target arbitrario de la lista ⇒ *«se esperaba INDECIDIBLE por AMBIGUOUS y se obtuvo target `doc/sdd/…/sdd.md`»* |
| `G-C16` | AC-6 | **El control no se lee a sí mismo**: los fixtures viven **en memoria** con la respuesta escrita antes; y se verifica que los **8** archivos auto-referentes están fuera del universo | Meter `test/cited-lines-guard.citations.ts` al universo | El token se resuelve leyendo **su propio campo `target:`** ⇒ *«archivo auto-referente dentro del universo del clasificador»* |
| `G-C17` | AC-2 | **El oráculo**: recall ≥ el **PISO** publicado sobre las 19 entradas P3/P4, **0 targets resueltos MAL**, y las 4 ocurrencias de `SCANNER_FALSE_POSITIVES` siguen dando `RUIDO`/`DATO` | **Sacar D5** de la cascada | El recall cae de 84 % a 58 % ⇒ *«recall 11/19 por debajo del piso»*, y aparecen **5 FN silenciosos** |
| `G-C17b` | AC-2 | **La muestra reservada**: los números del censo se **RE-DERIVAN** de `RESERVED_SAMPLE` en la corrida | Editar una etiqueta de `RESERVED_SAMPLE` sin tocar el censo | El número derivado ≠ el publicado ⇒ *«el censo declara X y la derivación da Y»* |

⚠️ **`G-C17` es un PISO, no una igualdad.** Un test que exija «exactamente 84 %» se pone rojo el
día que alguien escriba una cita nueva, y ese rojo **no señala nada falso**: es la fricción que
termina con alguien borrando el guardián.

⚠️ **`G-C15`: ⛔ PROHIBIDO clavar el número 127.** Medido hoy: `sdd.md` = **127** candidatos
(el SDD escribió 126 y **ya envejeció en 3 días, por culpa de esta misma HU**). El assert es
`candidates.length > 1`, **nunca** un dígito. Eso es un «candado que se pudre solo».

### ✅ Criterio de terminado de W2
- [ ] `paragraphOf`, `resolveContextTarget`, `classifyBareCite` **puras**, sin tocar disco.
- [ ] ⛔ `citeTargetIfTracked` (`:251-267`) y `citeMatchesTarget` para P1/P2 **sin modificar** —
      verificado con `/usr/bin/git diff` sobre esas líneas.
- [ ] `G-C13`..`G-C17b` en verde, **y cada uno visto ROJO con su mutante**, con el **texto literal**
      del fallo pegado en las notas y **CD-18 cumplido** (mutante verificado como aplicado antes
      de correr).
- [ ] Restauración de cada mutante **verificada por `sha256sum` antes/después** (CD-17).
- [ ] Los 94 sitios de D5 abiertos y etiquetados; el resultado contrastado con el **umbral ≤20 FP**
      de CD-19, y la decisión escrita.
- [ ] `INDECIDIBLE`s en `exceptions.ts`, cada uno con motivo **leído en el sitio**.
- [ ] Typecheck de §2, exit anotado. Gate completo, 4 números.
- [ ] ⚠️ **`G-C10` sigue verde** — ver D-1 en §9, es la trampa más probable de esta wave.

---

## W3 — El censo (depende de W0..W2)

| | |
|---|---|
| **Archivos** | `doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/censo.md` (**NUEVO**) |

**W3.1** — El censo publica, todo derivado en la corrida:
1. **Perímetro con su número, su patrón y su residuo** (§4 de este Story File) — CD-1.
2. **La medición de `doc/`**: población total y **cuántos artefactos declaran numerar el árbol
   vivo**. Medido en F2: **3 de ~1095**, y **dos de los tres son artefactos de ESTA HU**
   (`work-item.md` y `_INDEX-row.md`); el tercero es `doc/sdd/_INDEX.md`. ⇒ **`doc/` es histórico
   prácticamente en su totalidad** bajo la regla default-histórico de AC-5. **Re-derivalo**:
   `/usr/bin/grep -rlE "numeran? el árbol|árbol vivo|árbol PREVIO|numera el árbol" doc/`
3. **Precisión y recall con intervalos**, los dos estratos por separado y el ponderado (CD-14).
4. **≥3 FP y ≥3 FN citados con su sitio y su motivo** — los FN ya son 5 (W2.3); los FP salen del
   censo de D5 (W2.4).
5. **El contraste con los 5 números heredados**, para que nadie vuelva a citar un número sin
   perímetro:

| Fuente | «sueltos» en `wasiai-a2a` | Perímetro declarado |
|---|---|---|
| Issue #178 (2026-08-25) | 7835 | ⛔ ninguno |
| `_INDEX.md:218`, patrón con rangos | 7835 | ⛔ ninguno |
| `_INDEX.md:218`, patrón `` `:N` `` a secas | 4222 | ⛔ ninguno |
| Orquestador, `src+test+scripts` | ~1470 | sí |
| Orquestador, `+doc/` | ~14772 | sí |
| **Esta HU**, `src+test+scripts` | **1347** | sí, y con el patrón |
| **Esta HU**, repo entero | **14178** `[foto F2]` | sí, y con el patrón |

**La conclusión que va escrita**: el número heredado **no era comparable**, no que estuviera «mal».

**W3.2** — **Cada número del censo nombra la función que lo deriva** (AC-8), y lleva la palabra
**«foto» con su fecha**.

**⇒ COMMIT `S3`** — **CORTE A CERRADO. AC-1, AC-2, AC-3, AC-5, AC-6, AC-8, AC-10 satisfechos.**

### ✅ Criterio de terminado de W3
- [ ] Cada número del censo tiene: perímetro + patrón en la misma frase, «foto» con fecha, y el
      **nombre de la función que lo deriva**.
- [ ] Ningún número copiado como literal de este Story File ni del SDD.
- [ ] `/usr/bin/git diff --stat doc/ -- ':!doc/sdd/232-*'` → **vacío** (AC-5).
- [ ] Typecheck de §2, exit anotado. Gate completo, 4 números. Hash de `S3` anotado.

---

## W4 — 🔴 El cruce mecánico de P3/P4: **el rojo que HOY NO EXISTE** (AC-4)

| | |
|---|---|
| **Archivos** | `test/cited-lines-guard.test.ts` (`G-C18`), `test/cited-lines-guard.citations.ts` (sólo si una entrada necesita corrección) |

### W4.0 — 🔴 PRIMERO: **ver la vacuidad, antes de arreglarla**

**No arregles nada todavía.** Demostrá que el cruce es vacuo **hoy**, con un test temporal en
memoria (no lo commitees; es evidencia para el AR):

```ts
// citeMatchesTarget devuelve true para CUALQUIER target cuando el token es P3/P4
citeMatchesTarget('src/lib/operator-address.ts', '`:95`', 'src/no/existe/ninguno.ts')  // → true
citeMatchesTarget('src/lib/operator-address.ts', '`:95`', 'CLAUDE.md')                 // → true
```

**Pegá esa salida en las notas.** Es la prueba de que `E-CITE_TARGET_MISMATCH` **no puede
dispararse** para ninguna de las 19 entradas P3/P4 (`scanner.ts:306`).

### W4.1 — El control `G-C18`

> Para toda entrada de `CITED_LINES` cuyo `cite` sea P3/P4: si `classifyBareCite` resuelve el token
> a **un** target, ese target **DEBE** ser igual al `target` declarado ⇒ código nuevo
> **`E-BARE_TARGET_MISMATCH`**. Si resuelve `INDECIDIBLE`, **sigue rigiendo el `targetReason`
> escrito a mano**, como hoy.

- **Costo: CERO declaraciones nuevas en el registro.** ⛔ No se amplía `CORTE_A_PATHS`.
- **Cobertura inmediata medida en F2: 16 de las 19** entradas pasan a tener testigo mecánico, y
  **las 16 coinciden** con lo que el humano declaró ⇒ el control **nace verde por MEDICIÓN, no por
  construcción**. Re-derivá ese 16 y publicalo.

### W4.2 — 🔴 EL MUTANTE DE AC-4 — leé esto entero antes de mutar

**⛔ NO uses el mutante que dice el SDD («mutar el `target` de una entrada P3/P4 a otro archivo
trackeado»). Lo verifiqué en el árbol y produce un FALSO KILLED**: `G-C5`
(`test/cited-lines-guard.test.ts:989`) ya cruza `mustContain` contra `target:line` y se pondría
rojo por **`E-ANCHOR_GONE`** o **`E-TARGET_MISSING`** — o sea que el mutante muere **sin haber
ejercitado tu control**, y creerías que `G-C18` funciona cuando podría estar vacuo.

**El mutante correcto muta el PÁRRAFO DEL CITADOR, no el registro.** Así, `target`, `line`,
`mustContain` y `symbolPath` quedan intactos ⇒ `G-C5`/`G-C6`/`G-C7` **siguen verdes** y el único
que puede ponerse rojo es `G-C18`.

**Sitio elegido y verificado hoy** — `src/services/compose.ts:751` (entrada `citations.ts:344`,
token `:634`, target declarado `src/services/compose.ts`, resuelto por **D5/auto-cita** porque el
párrafo **no nombra ningún archivo trackeado**):

```
// y vale 0 para `i === 0` (lo debita el middleware vía
// composeEstimatedCostUsd, guard `i > 0` de :634) ⇒ un compose de UN
```

**El mutante**: reemplazar **en la misma línea, sin cambiar el número de líneas**, la palabra
`middleware` por `chain-resolver.ts`, de modo que el párrafo pase a nombrar **exactamente un**
archivo trackeado ⇒ **D3b** resuelve `src/adapters/chain-resolver.ts` ≠ `src/services/compose.ts`
⇒ **`E-BARE_TARGET_MISMATCH`**.

🔴 **Por qué `chain-resolver.ts` y no `agent.ts` — MEDIDO hoy, y es la trampa que te haría concluir
que el guard no funciona:**

| basename | candidatos en el índice | ¿sirve de mutante? |
|---|---|---|
| `agent.ts` | **2** | ❌ D7 ⇒ `AMBIGUOUS` ⇒ `INDECIDIBLE` ⇒ **NO hay rojo** |
| `registry.ts` | **2** | ❌ ídem |
| `compose.ts` | **2** | ❌ ídem |
| `chain-resolver.ts` | **1** | ✅ |
| `fee-split.ts` | **1** | ✅ |
| `operator-address.ts` | **1** | ✅ |

⇒ **El nombre del mutante DEBE tener exactamente 1 candidato por basename.** Verificalo antes:

```bash
/usr/bin/git ls-files -z | tr '\0' '\n' | /usr/bin/awk -F/ '$NF=="chain-resolver.ts"' | wc -l   # → 1
```

**Efectos colaterales verificados de este mutante:**
- `chain-resolver.ts` **sin `:N` no produce ningún token** (`FILE_CITE_RE` exige `:(\d+)`) ⇒ **no
  hace falta declarar una entrada nueva** y `G-C4` sigue verde.
- El token `:634` sigue presente ⇒ **`G-C7` verde**.
- No cambia el número de líneas ⇒ **ninguna otra cita de `compose.ts` se desplaza** (CD-6).
- Es un comentario ⇒ **`npm run lint` no cambia** y **CD-8 se respeta**.

**Segundo mutante (control positivo del anclaje, no del guard nuevo)**: cambiar el `line` de una
entrada P3/P4 ⇒ **`E-LINE_MOVED`** por `G-C5`. **Declaralo como lo que es**: verifica que el
registro sigue anclado, **no** que el cruce nuevo funcione.

**Protocolo obligatorio del mutante (CD-17 + CD-18):**
1. `sha256sum` del archivo → anotar. Backup con `cp` en tu subdirectorio.
2. Aplicar el mutante. **Verificar que se aplicó** (`/usr/bin/grep -n chain-resolver src/services/compose.ts`).
3. **Control positivo antes**: la suite estaba verde.
4. Correr `npm test` → **capturar el TEXTO LITERAL del fallo**, y confirmar que dice
   `E-BARE_TARGET_MISMATCH` **y nada más**. ⛔ Si aparece otro código, tu mutante murió por otra
   causa: **el resultado no vale**.
5. Restaurar con `cp` desde el backup. ⛔ **Nunca `git checkout --`.**
6. `sha256sum` de nuevo → **igual al del paso 1**. Comparar con `/usr/bin/diff`, ⛔ nunca con `diff`.
7. `npm test` → verde. **Control positivo después.**

**⇒ COMMIT `S4`** — **AC-4 satisfecho.**

### ✅ Criterio de terminado de W4
- [ ] La vacuidad de `citeMatchesTarget` para P3/P4 **demostrada y pegada** (W4.0).
- [ ] `G-C18` verde sobre las 19 entradas; el «16 de 19 con testigo» **re-derivado**.
- [ ] El mutante del párrafo puso el gate rojo **por `E-BARE_TARGET_MISMATCH` y sólo por eso**,
      con el texto literal pegado.
- [ ] Los 7 pasos del protocolo cumplidos, con los dos `sha256sum`.
- [ ] `G-C10` verde (D-1). Typecheck de §2. Gate completo, 4 números. Hash de `S4`.

---

## W5 — Las correcciones (⛔ **COMMIT APARTE**, CD-2 / AC-9)

| | |
|---|---|
| **Archivos** | Comentarios de `src/`, `test/`, `scripts/`. ⛔ **CD-8: 100 % comentario** |

### Las TRES salidas, con el costo ya medido

| Salida | Cuándo | Población medida | Costo |
|---|---|---|---|
| **(B) ACOTAR** — el cruce mecánico | `CITA` resuelta por D3a/D3b/D5 | **229** (102+33+94) | **CERO declaraciones nuevas.** 16/19 pasan a tener testigo. **Es la principal, y ya está hecha en W4** |
| **(A) CONVERTIR** — escribirle el archivo al lado | Sólo los `INDECIDIBLE` de D6 **accionables** | **34** (= 104 − 70 que viven en los 7 archivos de DT-11) | Diff de texto, **⛔ sin re-envolver el párrafo** |
| **(C) BORRARLE EL NÚMERO** | Cuando la oración **no usa** el número | subconjunto, se deriva acá | **Negativo** — borra deuda. **Costo de mantenimiento CERO: no se puede pudrir** |

### 🔴 Sobre la opción A — el SDD **REFUTÓ** la objeción del F1, y saberlo cambia lo que tenés que cuidar

El F1 dijo: *«alarga la línea, Biome la reparte, y eso corre las líneas de abajo»*. **Medido, es
falso, por dos caminos:**
1. `biome.json:9` es `"includes": ["src/**/*.ts"]` y `package.json:11` es `biome check src/` ⇒
   **Biome no toca `test/` en absoluto**.
2. Sobre `src/`, **Biome no reparte comentarios**: pasándole un docblock de **170 columnas** con
   tres citas ancladas por `--stdin-file-path`, la salida es **byte-idéntica**.

⇒ **El formateador NO desplaza nada al convertir una cita.** El riesgo real de A es **un humano
re-envolviendo el párrafo** — que es un mecanismo distinto y **evitable**.
⇒ ⛔ **PROHIBIDO re-envolver un párrafo que estés convirtiendo.** Si la línea queda larga, **queda
larga**.

**La objeción del F1 que SÍ se sostiene** (y por la que A no es política general): convertir
duplica el nombre del archivo N veces por párrafo, y **cada duplicado es una cosa más que puede
divergir**. A 1347 tokens, inaceptable.

### Criterio operativo de la opción C (para que no sea a ojo)

> *Si al borrar el `:N` la oración sigue siendo verdadera y sigue diciendo lo mismo, el número
> sobraba.*

**Exemplar verificado**: `src/adapters/chain-resolver.ts` — **446 líneas, 0 tokens `:N`**, y
referencia otros archivos por nombre (`registry.ts`, `settle-verifier.ts`, `downstream-payment.ts`,
`types.ts`, `doc/architecture/MULTI-CHAIN.md`) **sin número de línea**.
⚠️ El work-item decía **447 líneas**; son **446**.
**Cada aplicación de C se justifica por escrito**, en el commit.

### W5.3 — AC-9: la procedencia de cada corrección

Por **cada** cita corregida, declarar si estaba podrida **antes** del primer commit de esta HU,
**derivándolo del árbol base y no de la memoria**:

```bash
/usr/bin/git show <hash-base-de-W0.1>:<archivo> | sed -n '<N>p'
```

⛔ **CD-2**: parte de la deuda ya estaba rota antes. Mezclarla en un commit hace imposible saber
cuál era cuál — y **atribuirle al trabajo de hoy un daño preexistente apaga la búsqueda de la causa
real**.

**⇒ COMMIT `S5`.**

### ✅ Criterio de terminado de W5
- [ ] `/usr/bin/git diff` de `src/` **100 % comentario** — verificado línea por línea (CD-8).
- [ ] Ningún párrafo re-envuelto.
- [ ] Cada aplicación de C con su justificación escrita.
- [ ] Cada corrección con su procedencia derivada con `git show <base>:`, **no de memoria**.
- [ ] **CD-10**: las citas de esta wave re-derivadas **al final**, **abriendo cada línea**.
- [ ] Typecheck de §2. Gate completo, 4 números. Hash de `S5`.

---

## W6 — Cierre (serial)

1. `git add -A`
2. Gate completo **en orden, una vez**: `tsc` → `lint` → `test`. Los 4 números contra §2.
3. **Re-derivar todo número que las ediciones de W5 hayan movido** (AC-7/AC-8) — **abriendo la
   línea**, ⛔ nunca sumando el delta.
4. Typecheck de DT-12 (§2), exit anotado.
5. Verificar que los README **no cambiaron** (§2, trampa B). Si cambiaron, **derivá el número
   corriendo el guardián**, ⛔ nunca a mano.

---

# 9 · ⚠️ INCONSISTENCIAS SDD ↔ ÁRBOL REAL — verificadas por el Architect hoy

**Siete. Cada una con lo que tenés que hacer.** No son errores del SDD que invaliden la HU: son
renglones que, leídos literalmente, te mandan a un lugar equivocado.

### D-1 🔴 BLOQUEANTE SI LO IGNORÁS — `G-C10` se pone rojo cuando agregues `G-C13`+

`test/cited-lines-guard.test.ts:1461`:
```ts
expect(cabecera.includes('Naming: G-C1..G-C12')).toBe(true);
```
y el docblock lo escribe en **`:234`** (`* Naming: G-C1..G-C12.`). Además **`:1404`** delimita la
sección de no-cobertura con `cabecera.indexOf('Naming: G-C1')`.

**El SDD no lo menciona en ninguna wave ni en el presupuesto de escala.**

**Qué hacer**: al agregar `G-C13`..`G-C18`, actualizá **los dos** — el docblock `:234` a
`Naming: G-C1..G-C18.` **y** el literal del assert `:1461`. El `indexOf('Naming: G-C1')` de `:1404`
es un prefijo y sigue matcheando, no lo toques.
**Y agregá al docblock el ítem de no-cobertura del clasificador** (hoy la sección tiene **14**
ítems numerados; `G-C10` exige **≥8**, así que no hay riesgo de bajar del piso, pero **el silencio
nuevo hay que escribirlo**: qué NO cubre el discriminador).

### D-2 🔴 IMPORTANTE — el archivo nuevo es un **OCTAVO** archivo auto-referente

DT-11/CD-13 enumeran **7** archivos fuera del universo del clasificador. Pero
`test/cited-lines-guard.sample.ts` (W1.1) va a contener **120 entradas con su `target`**, o sea
**la respuesta que el clasificador tiene que producir**. Si el clasificador lo lee como contexto,
es exactamente el defecto de CD-3 («un control que se lee a sí mismo»).

**Qué hacer**: **CD-20**. `SELF_REFERENTIAL` = los 7 de DT-11 **+ `test/cited-lines-guard.sample.ts`**,
y `G-C16` verifica **8**, no 7. Declaralo con su número re-derivado (los 7 aportan **195**; el
octavo aporta lo suyo y hay que medirlo, no estimarlo).

### D-3 🔴 IMPORTANTE — el instrumento **contamina su propia medición**

`test/cited-lines-guard.sample.ts` va a traer **≥120 tokens P3/P4 nuevos** en `test/` (cada entrada
lleva un `cite: ':634'`, que **sí** matchea `BARE_CITE_RE`). Y los `INDECIDIBLE` de `exceptions.ts`
(W2.4) suman más. ⇒ **el perímetro pasa de 1347 a ~1470+ entre W1 y W3**, y el censo de W3
publicaría un número inflado por el propio instrumento.

**Qué hacer**: **CD-21**. El marco y el censo se derivan **contra el commit base de W0.1**
(hash anotado, `git ls-files` + `git show <base>:<archivo>`), **excluyendo los 8 auto-referentes**.
**Publicá los dos números** en el censo, con su explicación:
- «perímetro al commit base `<hash>`: **1347**»
- «perímetro al cierre de la HU: **N**, del cual **M** son tokens que esta HU agregó al
  instrumento».
Un solo número acá se lee como que la deuda creció, y sería falso.

### D-4 — `doc/` y los homónimos **ya envejecieron 3 días, por culpa de esta misma HU**

| Número | SDD (`1e5a6aa`) | Medido hoy (`c556b5c`) | Causa |
|---|---|---|---|
| archivos trackeados bajo `doc/` | 1095 | **1096** | El commit del SDD agregó `doc/sdd/232-…/sdd.md` |
| candidatos por basename `sdd.md` | 126 | **127** | Ídem |

Y **va a seguir creciendo** con `story-file.md`, `censo.md`, `ar-report.md`, `cr-report.md`,
`qa-report.md`, `done-report.md`, `auto-blindaje.md` de esta misma HU.

**Qué hacer**: ⛔ **nunca clavar 126 ni 127 en un test** (ver `G-C15`). El assert es
`candidates.length > 1`. Y en el censo, el número de `doc/` va con **«foto» + fecha + commit**.
El perímetro `src+test+scripts` (611/1347) **sí es estable** — no lo confundas con éste.

### D-5 — `CORTE_A_PATHS` está en `citations.ts:89-104`, no en `:87-102`

El SDD §3.1 dice «`CORTE_A_PATHS` (14 paths, `:87-102`)». **Medido**: el `export const` está en
**`:89`** y el `];` en **`:104`**; `:87-88` son las dos últimas líneas del docblock.
**Qué hacer**: nada más que no propagar el off-by-2. **CD-6 en acción: abrí la línea.**

### D-6 — «Raíz del repo: 13 archivos» — el índice tiene **19**

El SDD §10 declara la raíz con «13 archivos · 33 sueltos». **Medido hoy: 19 archivos trackeados
sin `/`** (`.env.example`, `.gitignore`, `.gitmodules`, `.npmrc`, `.nvmrc`, `CLAUDE.md`,
`CROSS-CHAIN-E2E-PROVEN-2026-04-28.md`, `HACKATHON-FINAL.md`, `LICENSE`, `README.es.md`,
`README.md`, `biome.json`, `package-lock.json`, `package.json`, `railway.json`,
`tsconfig.build.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.e2e.config.ts`).
El SDD **no declara la regla de exclusión** que llevaría 19 a 13 ⇒ el número **no es reproducible
como está escrito**, que es lo que CD-1 existe para impedir.
**Qué hacer**: en el censo de W3, **re-derivá la raíz declarando su regla** (p. ej. «trackeados sin
`/`, excluyendo binarios y `package-lock.json`») y publicá el número que salga.

### D-7 — el work-item nombra **dos archivos que no existen**

- **`src/services/capability-risk.ts`** (CD-9 del work-item) → el real es **`src/lib/capability-risk.ts:82`**
  (ya corregido en el SDD §11.1; **verificado hoy**, y hay una segunda cita en
  `src/lib/capability-risk.test.ts:58`).
- **`src/adapters/chain-resolver.ts` «447 líneas»** → son **446**.

⇒ **CD-9 sigue vigente e íntegra**: ⛔ no toques `doc/sdd/_INDEX.md` por encima de la línea 144
(hoy la 144 es la fila 157 / WKH-151). La fila 232 ya está en `_INDEX.md:224` y las filas se
**agregan al final**, así que trabajar ahí es seguro.

---

# 10 · Presupuesto de escala (el CR lo contrasta — regla 10 de `CLAUDE.md`)

| Wave | Archivo | Líneas netas | De las cuales son DATOS a mano |
|---|---|---|---|
| W1 | `test/cited-lines-guard.sample.ts` (nuevo) | ≤ **780** | ~700 |
| W2.1 | `test/cited-lines-guard.scanner.ts` | ≤ **200** | 0 (≈90 código, ≈110 docblock) |
| W2.2/3 | `test/cited-lines-guard.test.ts` | ≤ **280** | 0 |
| W2.4 | `test/cited-lines-guard.exceptions.ts` | ≤ **120** | ~100 |
| W3 | `doc/sdd/232-…/censo.md` (nuevo) | ≤ **420** | — |
| **Corte A** | | **≤ 1800** | **~800** |
| W4 | `test/cited-lines-guard.{test,citations}.ts` | ≤ **160** | 0 |
| W5 | comentarios de `src`/`test`/`scripts` | ≤ **120** | 0 |
| **Corte B** | | **≤ 280** | |
| **TOTAL** | | **≤ 2080** | |

**La pregunta que decide**: *¿qué parte de esto seguiría existiendo si lo escribiera alguien que ya
conoce esta librería?* Respuesta: **las ~800 líneas de datos etiquetados a mano seguirían existiendo
enteras** — son la medición, no la implementación, y no hay forma de abreviarlas sin destruir AC-2.
**El código ejecutable nuevo es ~250 líneas.**
Si el diff excede **2×** el presupuesto: **se justifica por escrito o se recorta**. Un exceso
justificado es información; un exceso silencioso es el hallazgo.

---

# 11 · ✅ ANTI-HALLUCINATION CHECKLIST — específica de esta HU

Marcá cada una **antes** de decir que terminaste una wave.

**Sobre lo que NO existe:**
- [ ] No usé `src/services/capability-risk.ts` — **no existe**; es `src/lib/`.
- [ ] No asumí que `npm run qa` existe — **no existe en este repo**.
- [ ] No agregué nada a `CORTE_A_PATHS` — `test.ts:715` asserta `.toBe(14)`.
- [ ] No modifiqué `citeTargetIfTracked` (`:251-267`) ni `citeMatchesTarget` para P1/P2.
- [ ] No toqué `tsconfig.json`.

**Sobre los números:**
- [ ] **Ningún número de este Story File lo copié como literal**: los re-derivé (AC-8).
- [ ] Todo número que publiqué lleva **perímetro + patrón en la misma frase** (CD-1).
- [ ] Todo número de población lleva **«foto» + fecha + la función que lo deriva**.
- [ ] Ningún test clava un conteo de homónimos (126/127) — el assert es `> 1`.
- [ ] Todo `[NO MEDIDO]` sigue diciendo `[NO MEDIDO]` — **una ausencia no es un cero**.

**Sobre la medición:**
- [ ] Etiqueté los 120 **antes** de que `classifyBareCite` existiera, y lo probé con
      `git show S2:…scanner.ts | grep -c classifyBareCite` → **0**.
- [ ] Ninguna lista de excepciones salió de volcar la salida del clasificador (CD-11).
- [ ] Ningún control busca un literal en la línea donde ese literal está escrito (CD-3).
- [ ] Los **8** archivos auto-referentes están fuera del universo del clasificador (CD-20).
- [ ] El umbral de D5 (≤20 FP sobre 94) lo escribí **antes** de medir (CD-19).
- [ ] Publiqué precisión **con** intervalo y **con** los dos estratos (CD-14).

**Sobre los mutantes:**
- [ ] Verifiqué que **cada mutante SE APLICÓ** antes de correr la suite (CD-18).
- [ ] Confirmé cada rojo **por su MOTIVO LITERAL**, no por el color.
- [ ] Para cada mutante me pregunté: **¿qué OTRO control podría estar matándolo?** — y descarté esa
      posibilidad. (Es el falso KILLED de W4.2.)
- [ ] Restauré con `cp` desde backup, **nunca** con `git checkout --`, y comparé `sha256sum`
      antes/después con `/usr/bin/diff` (CD-17).
- [ ] Control positivo verde **antes** y **después** de cada mutación.

**Sobre las citas y el gate:**
- [ ] Arreglé citas **al final** de cada wave, **abriendo la línea**, ⛔ nunca sumando el delta.
- [ ] Corrí `git add -A` **antes** del gate, siempre.
- [ ] Corrí el gate **completo y en orden** (`tsc` → `lint` → `test`), no sus partes.
- [ ] Corrí el typecheck de DT-12 y anoté el exit (CD-16).
- [ ] `G-C10` sigue verde después de agregar controles (D-1).
- [ ] Usé `/usr/bin/grep`, `sed -n`, `/usr/bin/git diff`, `/usr/bin/diff` — ⛔ nunca `cat`.

---

# 12 · DONE DEFINITION

**Corte A cerrado (`S3`) — la HU ya vale aunque B no entre:**
- [ ] `classifyBareCite` emite **exactamente una** de 4 etiquetas, con `target` cuando es `CITA`.
- [ ] **AC-1**: precisión y recall publicados sobre una muestra etiquetada a mano, con **≥3 FP** y
      **≥3 FN** citados con su sitio y su motivo.
- [ ] **AC-2**: la muestra de medición **NO** es la de calibración; ceguera probada por orden de
      commits.
- [ ] **AC-3**: perímetro publicado con su número derivado y **su residuo completo**, incluida la
      medición de `doc/`.
- [ ] **AC-5**: `doc/` medido y **no tocado** (`git diff --stat doc/` vacío fuera de `232-*`).
- [ ] **AC-6**: ningún control se lee a sí mismo; cada control declara **en el sitio** qué input
      concreto lo pone rojo.
- [ ] **AC-8**: todo número es una foto, con fecha y con la función que lo deriva.
- [ ] **AC-10**: gate completo, en orden, con los 4 números publicados.

**Corte B cerrado (`S5`):**
- [ ] **AC-4**: el gate se pone **rojo** por una cita suelta que resuelve a otro archivo, con el
      **texto literal** del fallo, control positivo verde antes y después, y restauración
      verificada por hash.
- [ ] **AC-7**: las citas se re-derivaron **abriendo la línea**, al final, después del formateador.
- [ ] **AC-9**: instrumento (`S1..S3`) y correcciones (`S5`) en **commits distintos**, y la
      procedencia de cada cita corregida derivada con `git show <base>:`, no de memoria.

**Siempre:**
- [ ] Los 4 números del gate contra la base `tsc 0 · lint 520 · 314/320 · 6350/6369`, o la
      diferencia explicada.
- [ ] Diff de `src/` **100 % comentario**.
- [ ] `TD-224-CITAS-DEL-PROPIO-GUARDIAN` **declarada con su número re-derivado** (no cerrada).
- [ ] `TD-371-PORTABILIDAD` declarada.
- [ ] **⛔ NO hacer push.** El orquestador maneja el cierre.

---

## Apéndice — si sólo leés una cosa de este documento

> **La cascada aprobada en F1 tenía 21 % de recall y borraba 5 citas reales en silencio. No se
> descubrió corrigiendo el 100 %: se descubrió buscando un conjunto etiquetado que nadie hubiera
> escrito mirando el clasificador — y resultó que ya existía en el repo desde agosto.**
>
> La lección operativa está escrita en este mismo repo: *un instrumento que se compara contra su
> propia salida da verde con cualquier implementación, incluida la que no encuentra nada.*
