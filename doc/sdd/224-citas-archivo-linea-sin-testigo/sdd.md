# SDD — [WKH-362 · TD-316-CITAS-SIN-TESTIGO] Testigo mecánico para las citas `archivo:línea`

> **Fase**: F2 · **SDD_MODE**: `full` · **Metodología**: QUALITY
> **Contrato de entrada**: `doc/sdd/224-citas-archivo-linea-sin-testigo/work-item.md` (12 ACs EARS, 6 DT, 9 CD)
> **Deuda origen**: `doc/sdd/214-wkh-316-escritor-payment-block/auto-blindaje.md:624-693`
> **Branch**: `feat/224-citas-archivo-linea-sin-testigo` — ✔ **verificada libre en este F2**:
> `/usr/bin/git rev-parse --verify feat/224-citas-archivo-linea-sin-testigo` → `fatal: Needed a single revision`.
> **Base**: `main` = `b31ddba6206de28f063eb867d78d7f53e4de450e` (✔ `/usr/bin/git rev-parse HEAD`).

---

## 0. CÓMO LEER ESTE DOCUMENTO (no es ceremonia: es el objeto de la HU)

Este SDD especifica un guardián contra citas `archivo:línea` falsas. Sería absurdo escribirlo con
citas sin medir. Por eso **cada cita lleva marca**:

| Marca | Significado |
|---|---|
| ✔ | **Medida por mí en este F2.** Abrí el archivo, leí la línea, y si el número venía de otro documento lo re-derivé. |
| `[HEREDADO]` | Viene del `work-item.md`, del `auto-blindaje.md` o de otro artefacto. **No la re-derivé.** |
| `[NO MEDIDO]` | No la pude medir con los instrumentos disponibles, y lo digo en vez de afirmarla. |

⚠️ **Ironía declarada, y es el `[NEEDS CLARIFICATION]` #3 de §14**: este SDD vive en `doc/sdd/`, que
✔ **NO está en el universo de ningún corte de esta HU** (medido: `doc/` trackeado tiene **20.550
anclas en 736 archivos citadores** — §3.4). O sea que **las citas de este documento no tienen testigo
tampoco.** La marca ✔ es lo único que las respalda, y es un respaldo humano, no mecánico. Decirlo es
el mínimo que exige **CD-8**.

### 0.0 Dato empírico de este propio F2, y va acá porque es evidencia de la HU

Escribí este SDD **mientras trabajaba en el defecto**, con la atención puesta exactamente en eso, y al
re-verificar mis propias citas antes de cerrar encontré **2 mal de ~60**:
`test/sdd-index-matches-folders.exceptions.ts:183-192` (el `export` está en **`:181`** — copié el número
del work-item en vez de abrirlo, que es **la violación literal de CD-4**) y
`test/ownership-filter-guard.scanner.ts:1-33` (el docblock cierra en **`:36`**). Las dos corregidas ✔.

⇒ **Tasa de defecto ≈ 3 % con el máximo de atención posible.** Ése es el argumento de sizing y de
existencia del guardián, y no es retórico: es la medición de este documento. Un proceso que dependa de
que alguien «tenga cuidado» ya está calibrado, y el número es 3 %.

### 0.1 Instrumentos usados, con su control positivo (CD-3)

| Instrumento | Uso | Control positivo ✔ |
|---|---|---|
| `/usr/bin/git ls-files` | derivar el universo | ✔ dio **515** archivos en `src`+`test`, y `rtk proxy git ls-files` dio **515** también ⇒ los dos coinciden, ninguno truncó. (El `git` del hook **sí** devuelve vacío según CD-3, así que no lo usé.) |
| `command grep -n` / `-c` | conteos y unicidad | ✔ Ante cada cero corrí el positivo: `grep -c 'i > 0' src/routes/compose.ts` = **0** y `grep -c 'i > 0 &&' src/services/compose.ts` = **1** ⇒ el cero era real y significaba «archivo equivocado», no «desapareció». |
| `sed -n 'Np'` | abrir una línea exacta | Usado en vez de `cat` (que ✔ corrompe al redirigirse, CD-3). |
| `node` + escáner propio (scratchpad) | derivar las 45 anclas del Corte A y las 20.550 de `doc/` | ✔ Control positivo del detector de duplicados: dio **cero** en el Corte A y **2** (`dashboard.ts:630`, `dashboard.ts:598`) en `test/ownership-filter-guard.exceptions.ts` ⇒ el cero no era del instrumento. |
| `typescript@6.0.3` compiler API | resolver el símbolo contenedor | ✔ **Ejecutado**, no supuesto: `ts.version` → `6.0.3`; resolvió los 6 casos de §3.5. |
| ⛔ `npm test` completo | — | **NO corrido.** Hay 3 agentes más con suites en esta máquina (~88 s de test en ~20 s de reloj, `it` triviales en 1.700-1.900 ms, y un namespace que resuelve vacío produciendo rojos `X is not a function` que se leen como bugs reales). Todo número de suite de este SDD es `[HEREDADO]`. |

---

## 1. Context Map — qué leí, por qué, y qué patrón extraje

| Archivo (✔ existe, leído en este F2) | Por qué lo abrí | Qué extraje |
|---|---|---|
| `test/ownership-filter-guard.test.ts` (✔ **686** líneas) | El encargo lo señala como **exemplar primario**. | El diseño completo que busco, funcionando sobre otra población: clave `archivo:línea` (`:317-318`), el test ★ (`G-08`, `:594`), la higiene de la lista (`G-09` `:613`, `G-10` `:633`), los controles de armado (`G-01` `:347`, `G-02` `:364`, `G-11` `:381`, `G-12` `:404`, `G-13` `:434`) y la anti-vacuidad del escáner con fixtures en memoria (`G-03` `:482` … `G-07` `:549`). El docblock del guardián cierra en `:134` y su función es declarar lo que NO mide. |
| `test/ownership-filter-guard.scanner.ts` (✔ **471** líneas) | Por qué el oráculo vive separado del test. | El patrón «parser puro del texto + wrapper que lee el disco» y, sobre todo, el docblock **«LO QUE ESTE ESCÁNER NO VE»** (`:15-35`, el docblock cierra en `:36`), que enumera 3 huecos medidos. Es el formato de honestidad que copio. Exports: `maskNonCode` (`:93`), `moduleStringConsts` (`:198`), `deriveTables` (`:243`), `scanSource` (`:349`), `GUARDED_VERBS` (`:467`). |
| `test/ownership-filter-guard.exceptions.ts` (✔ **520** líneas) | El encargo lo señalaba como el peor archivo; el F1 lo desmintió. | Confirmado el desmentido, y algo más: sus **41 pares `{file,line}` son invisibles a mi escáner por construcción** (§4.1). Sus anclas de prosa (✔ **40**: 14 con nombre de archivo + 26 sólo `:N`) apuntan a **otro** archivo que el par estructurado —el par dice `src/services/arbiter.ts:1178`, la prosa dice `src/routes/dashboard.ts:477` (✔ `:257-264`)— así que **no hay solapamiento con `G-09`**: la prosa justifica una lectura cross-tenant citando **el gate de admin de la ruta**, y eso no lo vigila nada. |
| `test/sdd-index-matches-folders.test.ts` (✔ **461** líneas) | Es el exemplar que el F1 eligió (`DT-1`). | `G-F1` en `:398` y `G-F2` en `:420` ✔ (los dos `it(` verificados uno por uno). El universo se deriva con `execFileSync('git',['ls-files','--','src'])` en `:421` y el patrón es `/doc\/sdd\/_INDEX\.md:(\d+)/g` en `:433` ✔. Y el patrón «control positivo del propio control» en `G-C` (`:332`) y `G-G` (`:447`). |
| `test/sdd-index-matches-folders.exceptions.ts` (✔ **192** líneas) | La forma del registro. | `CitedIndexLine = { from, line, mustContain }` en `:160-167` ✔; el docblock de `:169-180` con la frase que fija la regla —el `mustContain` *«es una afirmación sobre el mundo, no una lectura del mundo»*— ✔; y `CITED_INDEX_LINES` con **2** entradas en `:181-192` ✔. |
| `test/payment-guards-live-in-one-place.test.ts` | Por qué el agujero existe (Scope OUT) y por qué CD-1 importa. | `codeOnly` en `:45` ✔ (borra comentarios antes de mirar) y el docblock `:9-14` ✔ sobre por qué dos guardianes con el mismo criterio *«coinciden el día que se escriben y divergen después»*. **Este archivo no es el bug: es la razón por la que el agujero es estructural.** |
| `test/test-files-are-run-in-ci.test.ts` | Si los 3 archivos no-test que voy a crear rompen algo. | ✔ **No.** El guardián sólo alcanza a `*.test.*` (`:2`). Precedente en el mismo directorio: `ownership-filter-guard.{scanner,exceptions}.ts` ya existen y conviven. |
| `vitest.config.ts` | Si un archivo nuevo en `test/` se corre. | ✔ `include: ['src/**/*.test.ts','test/**/*.test.ts','test/**/*.test.mjs']` y `passWithNoTests: false`. ⇒ `test/cited-lines-guard.test.ts` entra por glob, sin tocar config. |
| `package.json` + `tsconfig.json` | Si el registro se valida por tipo o hay que validarlo en runtime (DT-4). | ✔ `"lint": "biome check src/"` (`package.json:11`) y `"include": ["src/**/*"]` en **`tsconfig.json:20`** — ⚠️ **no `:19`**, que es `"sourceMap": true`. Ver hallazgo H-2. `typescript@6.0.3` está en `devDependencies` (`:39`) ⇒ el compiler API está disponible para el resolver de símbolos. |
| `src/types/index.ts`, `src/routes/agents.ts`, `src/services/compose.ts`, `src/routes/compose.ts`, `src/routes/registries.ts`, `src/services/reputation.ts`, `src/lib/downstream-payment.ts`, `src/types/database.types.ts`, `src/services/registry.ts` | **CD-4**: re-abrir cada cita heredada antes de escribirla. | Las 4 tabuladas re-verificadas ✔ (§4.3) y **3 citas falsas nuevas encontradas** (§4.2). |
| `doc/sdd/214-wkh-316-escritor-payment-block/auto-blindaje.md:570-700` | La deuda origen. | El mecanismo (`codeOnly` borra comentarios), los tres disparadores, y la aritmética que **no cierra** (§3.3). |
| `doc/sdd/214-wkh-316-escritor-payment-block/sdd.md` §4.1 | Qué son «los 12 archivos». | ⚠️ **Son dos listas distintas con el mismo número** — ver §3.3. |
| `CLAUDE.md` §Security Conventions | Es normativo y ya tuvo una lista a mano que envejeció mal. | Sus 3 citas ✔ **son exactas hoy** (§3.2), y una de ellas es el caso que decide la forma de AC-3 (§3.5). |
| `doc/sdd/_INDEX.md:144` | CD-5. | ✔ **Intacta**: contiene las 3 needles que `G-F1` exige (`remit.corridor-discovery`, `kyc-check`, `cashout-match`). La fila 224 está en `:216` y **no la toco**. |

**Auto-Blindaje histórico leído** (paso obligatorio): `auto-blindaje.md` de la HU 214 (la deuda origen)
y el índice de las HUs DONE previas. **Patrón recurrente encontrado y ya convertido en CD**: «desplacé
una cita sin re-abrirla» aparece en `MNR-1` **y** en `MNR-4` de la iteración anterior de la misma HU
(`[HEREDADO]`, `auto-blindaje.md:583-599`), o sea **≥2 apariciones del mismo tipo de error** ⇒ es el
origen de **CD-4** (heredado) y de **CD-10** (nuevo, §6).

---

## 2. Qué se construye (una frase)

Un guardián en `test/` que, para un universo de **14 paths declarados**, exige que **cada cita
`archivo:línea` esté declarada a mano** con (a) el texto que esa línea tiene que contener, (b) el
**camino de símbolos** que la contiene, y que se ponga **rojo** cuando el texto se movió, cuando la
declaración es **ambigua** (matchea más de una línea), cuando el archivo citado es el **equivocado**, o
cuando aparece una cita **nueva sin declarar**.

---

## 3. El universo: DT-2 resuelto con medición propia

### 3.1 El instrumento y su piso

El escáner enumera **cuatro** formas de cita (§4.4), sobre archivos `.ts/.tsx/.mjs/.cjs/.js/.md`
**trackeados por git**. ✔ Corrido en este F2 con `node` + `/usr/bin/git ls-files`:

| Población | Archivos citadores | Anclas | Instrumento |
|---|---|---|---|
| **Todo `src`+`test`** (el techo) | **135** de 513 | **749** (P1=174 · P2=382 · P3=148 · P4=45) | ✔ medido |
| **Corte A** (los 14 paths de §3.2) | **13** de 14 | **45** (P1=14 · P2=12 · P3=16 · P4=3) | ✔ medido |
| Todo `doc/` trackeado | **736** de 995 | **20.550** | ✔ medido |
| `CLAUDE.md` | 1 | **3** | ✔ medido |
| `README.md` | 1 | **7** | ✔ medido |
| `.nexus/project-context.md` | — | **N/A** | ✔ **NO está en git** (§4.5) |

⚠️ **Los tres números son PISOS, no totales, y por dos razones distintas y medibles:**

1. **Una cita en prosa suelta no la devuelve ningún patrón.** «la línea 95», «el guard de más
   abajo», «el docblock de arriba» no tienen forma sintáctica. No hay cota superior conocida.
   `[NO MEDIDO]` — y no es medible sin leer todo a mano.
2. **P4 tiene falsos positivos, y los conté.** ✔ De los 45 P4 globales, **~7 son ruido**:
   `:8443` (×3, puertos en URLs), `:443`/`:80` (`src/lib/ssrf-dispatcher.ts:342-343`), `:443` en un
   string de error, `:0` en un id de test. ⇒ precisión de P4 ≈ **84 %** sobre `src`+`test`. En el
   **Corte A** los 3 P4 son ✔ **citas reales, 0 ruido**. El ruido no es un problema: cae del lado
   **RUIDOSO** (se declara una excepción con motivo escrito), no del silencioso. Es el mismo criterio
   que el escáner de ownership declara para sus cadenas partidas (`scanner.ts:16-24`).

### 3.2 Los 14 paths del Corte A (esto **es** el contrato de tamaño de la HU)

Criterio de admisión, en este orden: (a) contiene una cita **medida como falsa**; (b) es código del
**camino del dinero** o de un **invariante de seguridad**; (c) es uno de los archivos cuyo **largo
cambia seguido** (disparador 2 de la deuda); (d) tiene población de **las cuatro formas**, para que
ningún patrón entre al repo sin datos reales que lo ejerciten.

| # | Path | Anclas ✔ | Por qué entra |
|---|---|---|---|
| 1 | `src/types/index.ts` | **9** | 3 citas falsas medidas (a). El archivo con más citas salientes del radio de WKH-316. |
| 2 | `src/routes/agents.ts` | **2** | 1 cita falsa medida (a) + disparador 2 (c). |
| 3 | `src/services/agent.ts` | **1** | Disparador 2 explícito del auto-blindaje (c). |
| 4 | `src/services/agent.payment.test.ts` | **1** | Cita en archivo de test del camino del dinero, ya re-apuntada una vez (b). |
| 5 | `src/routes/agents.publish.test.ts` | **6** | 5 de sus 6 son forma P3 (d). |
| 6 | `src/routes/agents.ownership.test.ts` | **5** | Citas en **nombres de test** de ownership → se imprimen en CI (b). |
| 7 | `src/lib/operator-address.ts` | **6** | Único citador con P1 **relativo** (`../adapters/...`) del corte (d). |
| 8 | `src/lib/payment-spec-writer.ts` | **0** | El módulo de los 7 guards del bloque `payment` (b). Entra con **cero** anclas a propósito: presión hacia adelante a costo cero. |
| 9 | `src/lib/payment-spec-reader.ts` | **2** | El lector del bloque de pago (b). |
| 10 | `src/services/compose.ts` | **5** | **1 cita falsa nueva medida acá** (H-1), y es el guard anti-doble-débito (a+b). |
| 11 | `src/services/fee-split.ts` | **2** | Las **dos** son P4 (única población P4 de `src/` en el corte) sobre el fee-split (b+d). |
| 12 | `test/payment-guards-live-in-one-place.test.ts` | **2** | Es el guardián cuyo `codeOnly` **crea** el agujero: sus 2 citas P3 justifican por qué borra comentarios (b). |
| 13 | `test/sdd-index-matches-folders.exceptions.ts` | **1** | **Cita falsa medida acá** (H-2) y es el registro del exemplar (a). |
| 14 | `CLAUDE.md` | **3** | Documento **normativo** del repo, y el que ya tuvo una lista a mano que envejeció mal. 3 entradas de costo. Sus 3 citas son ✔ exactas hoy — entra por (b), no por (a). |
| | **TOTAL** | **45** | 13 citadores + 1 con cero |

**Cobertura honesta del Corte A: 45 de 749 anclas de `src`+`test` = ✔ 6,0 %.** Sobre el repo entero
(`src`+`test`+`doc`+raíz ≈ 21.300 anclas medidas) es ✔ **0,21 %**. **CD-8 obliga a publicar estos dos
números en todo reporte de esta HU.** Un guardián así no dice «las citas del repo son correctas»:
dice «estas 45 no pueden mentir sin que la suite se caiga».

### 3.3 Por qué NO reuso el `46` ni el `55` heredados (y por qué el «12» tampoco)

`[HEREDADO]` `auto-blindaje.md:663-667` publica **41 + 14 = 55** anclas en un solo archivo y **46** en
los 12 juntos. **46 < 55.** El F1 ya lo marcó; ✔ **acá está la causa medida**: mi escáner sobre
`test/ownership-filter-guard.exceptions.ts` devuelve **40** anclas de prosa y **cero** de los 41 pares
estructurados, porque un par se escribe en dos líneas separadas (`file: 'src/...'` y `line: 1178`) y
**no forma nunca el token `archivo:N`**. ⇒ Las dos poblaciones no son comparables y **ninguna de las
dos es la mía**.

⚠️ **Y hay un tercer «12» que tampoco se puede heredar.** ✔ `doc/sdd/214-.../sdd.md` §4.1 lista **12**
archivos que **incluyen `README.md` y `doc/INTEGRATION.md` y excluyen
`test/ownership-filter-guard.exceptions.ts`**; el `auto-blindaje.md` habla de **12** archivos «de
`src/`+`test/`» que **incluyen `exceptions.ts`**. Son dos conjuntos distintos con la misma etiqueta.
⇒ **El Corte A no es «los 12 de WKH-316»: es la lista de §3.2, enumerada path por path.**

### 3.4 Roadmap de cortes (la función forzante se conserva, de a bocado)

| Corte | Universo | Anclas ✔ | Precondición |
|---|---|---|---|
| **A** (esta HU) | los 14 paths de §3.2 | **45** | — |
| B | `test/ownership-filter-guard.exceptions.ts` | **40** (14 P2 + 26 P4) | Necesita el mecanismo de A, y decidir la resolución de los 26 P4 (apuntan al `file` de su propia entrada, no al archivo citador). **Es el corte de mayor valor de seguridad del repo**: cada una justifica una lectura cross-tenant citando un gate de admin. |
| C | el resto de `src`+`test` | **664** (749 − 45 − 40) | Se parte por subárbol. |
| D | `README.md` + `doc/INTEGRATION.md` + los `doc/**` normativos | ≤ **20.557** | ⚠️ 736 citadores. **No es una HU: es un programa.** Requiere decidir antes si `doc/sdd/**` (histórico, inmutable de facto) entra o se congela. |
| — | `TD-316-CITAS-PORTABILIDAD` | — | DT-5. Va después de A. |

### 3.5 La medición que decide la forma de AC-3 (§4.6 lo desarrolla)

✔ Sobre `doc/sdd/_INDEX.md`, el `mustContain` del **exemplar existente**
(`['remit.corridor-discovery','kyc-check','cashout-match']`):

| needle | ocurrencias en `_INDEX.md` |
|---|---|
| `remit.corridor-discovery` | **2** |
| `kyc-check` | **2** |
| `cashout-match` | **4** |
| **las tres juntas (conjunción)** | **1** |

⇒ **Ninguna needle es única por separado; la conjunción sí.** Si AC-3 exigiera unicidad **por
needle**, el exemplar que ya está en `main` sería **rojo** y la regla sería inusable. **AC-3 se define
sobre la CONJUNCIÓN.** Esto no se podía saber sin medirlo, y es la decisión más barata de equivocar de
todo el SDD.

---

## 4. Hallazgos de este F2 que cambian el diseño

### 4.1 CD-1 se satisface **mecánicamente**, no por disciplina (AC-12 cerrado)

Tres mediciones ✔:

1. Los **41 pares `{file,line}`** de `ownership-filter-guard.exceptions.ts` **no producen ningún token
   `archivo:N`** ⇒ mi escáner **no los puede ver**, ni queriendo. `G-08`/`G-09`/`G-10` siguen siendo
   sus únicos dueños.
2. En el Corte A hay ✔ **cero** tokens con target `doc/sdd/_INDEX.md` ⇒ **cero** solapamiento con
   `G-F1`/`G-F2` **hoy**.
3. Pero el solapamiento es posible **mañana**: si alguien agrega `doc/sdd/_INDEX.md:N` a
   `src/types/index.ts`, `G-C4` exigiría declararla y eso **sí** duplicaría a `G-F1`. ⇒ **DT-14**: el
   target `doc/sdd/_INDEX.md` se declara **delegado**, con dueño nombrado, y `G-C9` se pone rojo si el
   dueño desaparece.

⇒ **AC-12: el diseño NO re-verifica nada de `G-08`/`G-09`/`G-10`, y la separación es estructural.**

### 4.2 Tres citas falsas **nuevas**, encontradas por mí, ninguna heredada

**H-1 — `src/services/compose.ts:688` cita `:208` y es falsa. Es el guard anti-doble-débito.** ✔
El comentario dice *«…lo debita el middleware vía composeEstimatedCostUsd, guard `i > 0` de :208»*.
`:208` es un comentario de **WKH-234 sobre el `intentId` del leg Solana** — nada que ver. El ancla real
del guard `i > 0` es ✔ **`src/services/compose.ts:571`** (`if (i > 0 && scopingKeyRow && chainId !== undefined) {`).
**Tres cosas la hacen la cita más importante del corte:**
- Es **el mismo guard** que la cita falsa heredada de `src/types/index.ts:1450` (*«el guard `i>0` de
  compose.ts:130»*). ⇒ **dos citas independientes del mismo candado del camino del dinero, las dos
  mal, apuntando a dos líneas equivocadas distintas.**
- Es **invisible a las tres formas de AC-11**: es `:208` **sin backticks**. Ni el barrido que WKH-316
  usó ni el que declaró «correcto» la habrían encontrado. La encontré ✔ sólo con la **cuarta** forma.
- Su docblock local dice que `stepDebitedUsd` vale 0 para `i === 0`, o sea que la afirmación de fondo
  es correcta: **el número es lo único falso**, que es exactamente el modo de falla que hace que
  «abrir y comparar» confirme la mentira.

**H-2 — `tsconfig.json:19` es falsa, y está citada DOS veces, en dos guardianes distintos.** ✔
`test/ownership-filter-guard.exceptions.ts:24` y `test/sdd-index-matches-folders.exceptions.ts:15`
afirman que CI no typechequea `test/` *«(`tsconfig.json:19` incluye sólo `src/**/*`)»*. Medido:
`tsconfig.json:19` es **`"sourceMap": true`**; el `"include": ["src/**/*"]` está en **`:20`**.
La **conclusión es cierta** (`test/` no se typechequea ni se lintea: `package.json:11` es
`biome check src/` ✔), el **número está corrido en uno**. El F1 lo marcó `[NO MEDIDO]` y el
auto-blindaje también; ✔ **acá está medido**. Una de las dos entra al Corte A (path #13); la otra es
**Corte B** — y esa asimetría hay que declararla, no esconderla.

**H-3 — `src/routes/registries.ts:35` no es sólo «la línea equivocada»: no tiene símbolo.** ✔
`:35` es `requireA2AKeyPresence,` (un **specifier de import**), y el resolver de símbolos devuelve
**`null`** ahí, mientras que en el ancla real `:94` devuelve `FunctionDeclaration mapOwnershipError`.
⇒ es el caso que prueba que **AC-4 discrimina donde AC-2 ya discrimina, y además explica**.

### 4.3 Las 4 citas heredadas, re-abiertas una por una (CD-4 cumplido en este F2)

| Cita (donde está escrita) | Lo que afirma | ✔ Qué hay en la línea citada | ✔ Ancla real | Needle **única** medida |
|---|---|---|---|---|
| `src/types/index.ts:1450` → `compose.ts:130` | el guard `i>0` | `src/routes/compose.ts:130` = `/**`; `src/services/compose.ts:130` = prosa del over-fetch | `src/services/compose.ts:571` | `['if (i > 0 &&','scopingKeyRow']` → **1** ocurrencia (`i > 0 &&` solo ya da 1; `i > 0` solo da **5**) |
| `src/routes/agents.ts:47` → `registries.ts:35` | helper privado | `requireA2AKeyPresence,` (specifier de import) | `src/routes/registries.ts:94` | `['async function ','mapOwnershipError(']` → **1** (`mapOwnershipError` solo da **4**) |
| `src/types/index.ts:510` → `reputation.ts:182-183` | el bucket `'__anon__'` se excluye | prosa de un bloque `CR MNR-2` | `src/services/reputation.ts:189` | `['ANON_CALLER_BUCKET','failedCallers.add']` → **1** (`ANON_CALLER_BUCKET` solo da **3**) |
| `src/types/index.ts:207` → `` `:777` `` | *«lo firma como `to`»* | `contract: agent.payment.contract,` | `src/lib/downstream-payment.ts:922` | `['to: payToCheck.addr']` → **1** |

Las dos que el auto-blindaje declara **exactas** también las re-abrí ✔: `downstream-payment.ts:772` es
`const payToCheck = validatePayTo(agent.payment.contract);` y `downstream-payment.ts:247` es
`async function settleSolanaLeg(` (la línea **es** la firma — el ancla ideal de DT-3).

⚠️ **Las 3 columnas «needle única» de esta tabla son el insumo del registro, y NO son el registro.**
El Dev tiene que **volver a abrir cada línea** en W3/W4 (CD-4). Copiarlas de acá sin abrirlas sería
cometer, dentro de la HU que arregla el defecto, exactamente el defecto — y esta tabla estaría vieja
en cuanto alguien inserte una línea en cualquiera de esos 5 archivos.

### 4.4 AC-11 se amplía a **cuatro** formas (medido, no opinado)

| # | Forma | Ejemplo real ✔ del repo | Población en Corte A | Población en `src`+`test` |
|---|---|---|---|---|
| **P1** | con ruta (incl. `./` y `../`) | `src/lib/discovery-query.ts:219-229` (`routes/agents.ts:280`) · `../adapters/solana/chain.ts:84` (`operator-address.ts:18`) | **14** | 174 |
| **P2** | sin directorio | `downstream-payment.ts:772` (`types/index.ts:207`) · `tsconfig.json:19` | **12** | 382 |
| **P3** | sólo `:N`, **entre backticks** | `` `:777` `` (`types/index.ts:207`) · `` `:66` `` (`payment-guards…:17`) | **16** | 148 |
| **P4** | sólo `:N`, **SIN backticks** ⬅ **nueva** | `:208` (`compose.ts:688`, **falsa**, H-1) · `(:316` y `:335` (`fee-split.ts:494`) | **3** | 45 (~38 reales) |

**Por qué P4 no es opcional**, con la medición: la forma más común de cita **de todo el repo** dentro
de un archivo que ya nombró su objetivo es la corta, y **la mayoría no lleva backticks**. En
`test/ownership-filter-guard.exceptions.ts` hay ✔ **26** P4 y **cero** P3. Un guardián que implemente
literalmente las tres formas de AC-11 nace con un punto ciego que contiene **la cita falsa del camino
del dinero que encontré (H-1)**. ⇒ **AC-11 se cumple ampliándolo: `SHALL` buscar las tres formas
declaradas *y* la cuarta.** El `./` y el `../` van dentro de P1 (el caso de otro repo que perdió
`flow.tsx:1839 → ./splash.tsx:245` ✔ está cubierto por fixture, no por confianza).

**Falsos positivos conocidos de P4 y su tratamiento** ✔: `::1` (IPv6, en `src/types/index.ts:1172`) se
descarta en el escáner (regla: el carácter previo no puede ser `:`); puertos (`:8443`, `:443`, `:80`)
y `:0` **no** se descartan en el escáner —descartarlos por rango sería inventar una heurística que
mañana se come una cita real— sino que van a `exceptions.ts` con motivo escrito. ✔ En el Corte A esta
población es **0**.

### 4.5 `.nexus/project-context.md` queda fuera **por medición, no por preferencia**

El F1 lo marcó `[NO MEDIDO]` y recomendó diferirlo. ✔ Medido: `/usr/bin/git ls-files -- .nexus`
devuelve **vacío** ⇒ **el archivo no está trackeado por git**. Por **AC-6** (el universo se deriva del
índice de git) queda fuera **de todos los cortes, para siempre, por construcción**. Y es el peor caso
posible del defecto: `[HEREDADO]` su encabezado `:6-12` **le pide al lector abrir las citas y
verificar**. ⇒ va en la lista de no-cobertura (AC-10) y genera **`TD-316-CITAS-PROJECT-CONTEXT`**
(la salida no es meterlo al universo rompiendo la derivación: es decidir si el archivo se trackea).

### 4.6 La unicidad necesita un **ámbito**, y el ámbito es el camino de símbolos

Caso que lo fuerza ✔: `CLAUDE.md:212` cita `src/types/database.types.ts:2567` para afirmar que
`registries` **sí** tiene `owner_ref`. La línea es `owner_ref: string;` y ese texto aparece ✔ **66
veces** en el archivo. Con unicidad **de archivo**, esa cita **no se puede declarar** — y es una cita
correcta, normativa y del criterio de seguridad del repo.

Probé tres formulaciones. Resultados ✔ (`typescript@6.0.3`, ejecutado):

| Formulación | `database.types.ts:2567` | `registry.ts:174` | `reputation.ts:189` | `registries.ts:94` |
|---|---|---|---|---|
| needle única en el **archivo** | ✗ 66 hits | ✗ 6 hits | ✓ 1 | ✓ 1 |
| needle única en el **span del símbolo interno** | ✓ 1 — pero **vacuo**: el span es de **1 línea** (`owner_ref` 2567-2567), así que la unicidad es tautológica | ✓ 1 (span 173-174) | ✓ 1 | ✓ 1 |
| **needle + `symbolPath` como subsecuencia ordenada** ⬅ **elegida** | ✓ **1 hit, y es 2567**, con `['registries','Row','owner_ref']` sobre el path real `["Database","public","Tables","registries","Row","owner_ref"]` | ✓ 1 con `['list']` | ✓ 1 con `['accumulateRow']` | ✓ 1 con `['mapOwnershipError']` |

Y el **control de vacuidad de la propia regla** ✔: con `symbolPath:['executePipeline']` y un
`mustContain` perezoso `['i > 0']`, `src/services/compose.ts:571` da **5 hits (309, 547, 571, 602,
688)** ⇒ **ROJO**. Es AC-3 funcionando sobre datos reales, no sobre un fixture.

⚠️ Dos variantes que descarté **midiendo**, no opinando: el **sufijo** del path (`endsWith`) falla en
4 de 5 casos porque el nodo más interno trae nombres de expresión (`add`, `failedCallers`, `request`,
`from`) que ningún humano escribiría; y el path sin **whitelist de kinds** produce esos mismos
nombres. La combinación que funciona es: **whitelist de declaraciones + subsecuencia ordenada**.

---

## 5. Decisiones técnicas

### 5.1 Heredadas del work-item — estado en este F2

| DT | Estado |
|---|---|
| **DT-1** — se extiende el diseño existente, no se inventa | ✔ **Confirmada** con los line numbers re-verificados (`:160-167`, `:181-192`, `G-F1` `:398`, `G-F2` `:420`). |
| **DT-2** — universo por PATH explícito | ✔ **Resuelta**: los **14 paths** de §3.2, **45 anclas**. Los dos rechazos del F1 (techo decreciente · barrido por diff) **se respetan y se refuerzan**: además de «acota la tasa, no cierra el camino», ✔ medí que `doc/` tiene 20.550 anclas ⇒ un techo sobre esa población sería el escondite perfecto. |
| **DT-3** — anti-vacuidad = unicidad, y la cita ideal apunta a la **firma** | ✔ **Confirmada y precisada**: la unicidad es de la **conjunción** (§3.5) con **ámbito `symbolPath`** (§4.6). La convención de la firma se mantiene como **paso 2 de la escalera** de DT-13. |
| **DT-4** — validación en **runtime**, no por tipo | ✔ **Confirmada con medición propia**: `package.json:11` = `biome check src/` y el `include` de `tsconfig.json` (en `:20`, no `:19`) es `["src/**/*"]` ⇒ nada de `test/` se lintea ni se typechequea. |
| **DT-5** — sólo `wasiai-a2a` | ✔ **Confirmada, con la justificación corregida**: el argumento del F1 (`doc/` viaja «a medias») es cierto **y además insuficiente**; el argumento decisivo medido es que ✔ `.nexus/project-context.md` **no está en git en este repo** (§4.5) ⇒ ni siquiera dentro de un repo el universo es uniforme. |
| **DT-6** — el defecto es sistémico y va escrito en el guardián | ✔ **Confirmada y ampliada**: agrego al docblock la ronda de anoche (`[HEREDADO]`: una corrección recién medida por un revisor que **no** se equivocó ya estaba vieja al aplicarse, porque el arreglo desplazó la línea medida) y **H-1/H-2 medidas acá**. |

### 5.2 Nuevas

- **DT-7 — La clave del registro NO es una línea del citador.**
  La entrada se identifica por `{ from, cite }` (archivo citador + **el token literal**), no por
  `fromLine`. **La línea del citador se DERIVA en cada corrida.**
  *Por qué*: un registro cuyas claves son números de línea del citador se rompe con cualquier
  inserción en el citador, y esta HU existe porque **los números no sobreviven a las ediciones — ni a
  las propias**. Guardar `fromLine` sería construir, dentro del arreglo, el defecto que arregla.
  *Contra qué se cambia*: se pierde el «candado de largo» sobre los 13 citadores (con `fromLine`, toda
  inserción daba rojo). Lo cambio a propósito: ese rojo no señala nada falso y su fricción es lo que
  hace que alguien borre el guardián. La derivación mantiene AC-1/2/3/4/8 intactos.
  *Precondición medida* ✔: **cero** tokens duplicados dentro de un mismo citador en el Corte A (con
  control positivo: el detector encuentra 2 duplicados en `exceptions.ts`) ⇒ `{from, cite}` es único
  hoy. Si mañana aparece un duplicado, `G-C4` se pone rojo y pide un campo `nth`.

- **DT-8 — El escáner busca **cuatro** formas.** §4.4. Amplía AC-11, que se cumple *a fortiori*.

- **DT-9 — AC-3 es unicidad de la **conjunción**, no de cada needle.** §3.5. Si fuera por needle, el
  exemplar que ya está en `main` sería rojo.

- **DT-10 — El ancla de AC-4 es un `symbolPath` (subsecuencia ordenada), resuelto con el compiler
  API de `typescript@6.0.3`.** §4.6.
  *Por qué el compiler API y no una heurística de texto*: una heurística de indentación sobre código
  con 5 niveles de anidamiento es exactamente «la herramienta de medición que fabrica un bug». El
  compiler API ya es `devDependency` ✔, `ts.createSourceFile` es **puro sobre un string** ⇒ el
  resolver sigue siendo testeable con fixtures en memoria (requisito de AC-7).
  *Respuesta explícita a «¿el guard debe preferir/exigir anclas por símbolo?»*: **sí, y no como
  preferencia estilística sino porque es lo único que hace la unicidad satisfacible** (§4.6). El
  `symbolPath` es **obligatorio** cuando el resolver devuelve algo; `symbolPath: []` se admite **sólo**
  cuando el resolver devuelve vacío (targets `.md`/`.json`/`.sql`, y docblocks de cabecera — ✔ medido:
  `src/lib/operator-address.ts:14` devuelve `null`). **El guard no le cree al autor: compara contra el
  resolver** (CD-12).

- **DT-11 — La resolución del target la declara el humano; el guard la verifica donde puede.**
  El escáner **enumera** tokens; **no adivina** a qué archivo apuntan. Razón medida ✔: un P4 puede
  apuntar al propio citador (`compose.ts:688` → `compose.ts:208`) o a **otro** archivo nombrado dos
  líneas antes (`operator-address.ts:19` `` `:95` `` → `../adapters/solana/chain.ts`), y un P2
  (`dashboard.ts:515`) admite tantos candidatos como basenames iguales haya en el índice (✔ hay **2**
  `compose.ts`). ⇒ el registro trae `target` **a mano**, y el guard chequea:
  - **P1**: el token, normalizado contra el directorio del citador (`./`, `../`), **debe** ser igual al
    `target` declarado.
  - **P2**: el `basename` del token **debe** ser igual al del `target`.
  - **P3/P4**: si el `target` **no** es el propio citador, la entrada exige `targetReason` (motivo
    escrito, validado en runtime como los de `G-10`). Si es el propio citador, no hace falta.

- **DT-12 — Seis códigos de fallo discriminados, y el mensaje dice **cómo re-apuntar**.** §7.
  El work-item lo pide en su análisis de paralelismo: el que lee el rojo estaba haciendo otra cosa.

- **DT-13 — La escalera de tres pasos cuando el `mustContain` no puede ser único.** Obligatoria **en
  este orden**:
  1. **Alargar la conjunción.** ✔ Medido: `mapOwnershipError` solo → 4 hits; `['async function ','mapOwnershipError(']` → 1.
  2. Si la línea es **intrínsecamente no identificable** (`});`, `}`, `*/`): **la cita está mal y se
     RE-APUNTA a la línea de la firma** del símbolo contenedor. **No es una excepción: es corregir el
     comentario** (DT-3, y precedente ✔ `downstream-payment.ts:247` = `async function settleSolanaLeg(`).
  3. **Sólo si 1 y 2 son imposibles** (target sin símbolos y línea genuinamente repetida) → entrada en
     `exceptions.ts` con motivo ≥ 40 caracteres, **no duplicado palabra por palabra**.
  ⚠️ **Y la excepción ACOTA, NO ANULA**: una cita exceptuada de la unicidad **sigue** obligada a que el
  archivo exista, la línea exista y la conjunción matchee **esa** línea (AC-2, AC-5). Lo único que se
  exceptúa es el `hits === 1`. Sin esta cláusula, `exceptions.ts` sería el interruptor de apagado del
  guardián — que es el modo de falla de todo archivo de excepciones.

- **DT-14 — La delegación a `G-F1`/`G-F2` es explícita y con dueño vivo.**
  `DELEGATED_TARGETS = [{ target: 'doc/sdd/_INDEX.md', ownedBy: 'G-F1/G-F2 en test/sdd-index-matches-folders.test.ts:398,420', reason }]`.
  El escáner descarta esos tokens **y** `G-C9` se pone rojo si el dueño desapareció (busca
  `CITED_INDEX_LINES` en `test/sdd-index-matches-folders.exceptions.ts`). ⇒ CD-1 se cumple sin dejar
  un agujero silencioso. ✔ Población hoy en Corte A: **0** — y el control **no** afirma que sea > 0
  (eso sería un candado que se pudre solo); afirma que **la delegación tiene dueño**.

- **DT-15 — Cuatro archivos, no uno.** `test/cited-lines-guard.{test,scanner,citations,exceptions}.ts`.
  El escáner separado por la razón ya escrita en el repo ✔ (`ownership-filter-guard.scanner.ts:4-10`:
  un oráculo que sólo se puede invocar sobre el árbol real se compara contra su propia salida).
  El registro separado de las excepciones porque son dos afirmaciones distintas: «esto tiene que
  seguir diciendo X» vs «esto no se puede anclar, y acá está por qué».

---

## 6. Constraint Directives

**Heredados del work-item — vigentes sin cambios**: **CD-1** (no re-cubrir `G-08`/`G-09`/`G-10` —
✔ satisfecho mecánicamente, §4.1) · **CD-2** (nada de lógica de producción; el diff sobre `src/` sólo
comentarios y `*.test.ts`) · **CD-3** (instrumentos no corruptos; ante un cero, control positivo) ·
**CD-4** (prohibido escribir en el registro un `archivo:línea` que no se haya abierto **en esta HU** —
incluye **la tabla de §4.3 de este SDD**) · **CD-5** (la fila del índice va al FINAL; ✔ ya está en
`_INDEX.md:216` y `:144` está intacta — **no se re-inserta**) · **CD-6** (prohibido volcar la salida
del escáner al registro) · **CD-7** (no tocar `codeOnly` ni ningún assert de
`payment-guards-live-in-one-place.test.ts`) · **CD-8** (prohibido presentar el verde como «las citas
del repo son correctas»; publicar **6,0 %** y **0,21 %**) · **CD-9** (no tocar
`doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md` — ✔ md5 verificado en este F2:
`7904ef74a1c46d7880e0ca5d38e3eed4`).

**Nuevos:**

- **CD-10 — OBLIGATORIO: toda corrección de una cita dentro de un comentario es LÍNEA-NEUTRA.**
  Motivo medido, y es el patrón recurrente del Auto-Blindaje (≥2 apariciones, `MNR-1` y `MNR-4`):
  el defecto **no** es escribir mal, es **desplazar y no re-verificar**. Un arreglo que agregue o quite
  líneas en un archivo del Corte A invalida las citas que apuntan **a** ese archivo y las que salen
  **de** él. **Verificación con DOS instrumentos**, porque uno solo puede dar cero falso:
  `/usr/bin/git diff --numstat <archivo>` debe dar `N N` (añadidas = borradas), **y** `wc -l` antes y
  después debe coincidir. ⚠️ `git diff` bajo el hook **trunca con exit 0** ⇒ **sólo `/usr/bin/git`**.
- **CD-11 — PROHIBIDO copiar al registro el número que el propio guardián sugiere en su mensaje de
  re-apuntado, sin abrir la línea.** Es la puerta de atrás de CD-6: el mensaje de `E-LINE_MOVED` trae
  el número corregido, y copiarlo sin abrir convierte el registro en un volcado del escáner. *(El
  mensaje **es** legítimo — deriva de una needle escrita a mano y única, no de la lectura del mundo —
  pero el que copia sin abrir no verifica que la needle siga describiendo lo que la prosa afirma.)*
- **CD-12 — PROHIBIDO declarar `symbolPath: []` cuando el resolver devuelve un camino.** El guard lo
  compara contra el resolver y se pone rojo. Sin esto, `[]` sería el apagador de AC-4.
- **CD-13 — PROHIBIDO agregar `.nexus/project-context.md` al universo por cualquier vía que no sea
  trackearlo en git.** ✔ No está en el índice (§4.5); meterlo con una lista paralela rompería AC-6, que
  es lo único que garantiza que el universo no dependa del disco de quien corre los tests.
- **CD-14 — PROHIBIDO que `exceptions.ts` exceptúe algo distinto de la **unicidad** (AC-3) o del
  **anclaje** de una cita en prosa suelta (AC-9).** Existencia del archivo, existencia de la línea y
  match de la conjunción **no son exceptuables**. Ver DT-13.

---

## 7. Contrato de datos y algoritmo

### 7.1 `test/cited-lines-guard.citations.ts` (escrito a mano — CD-6)

```ts
/** Una cita `archivo:línea` declarada, con lo que esa línea tiene que decir. */
export interface CitedLine {
  /** Archivo CITADOR (path relativo a la raíz, trackeado por git). */
  readonly from: string;
  /** El token literal, tal como está escrito. Ej: 'compose.ts:130' | '`:777`' | ':208'. */
  readonly cite: string;
  /** Path relativo del archivo apuntado, RESUELTO A MANO (DT-11). */
  readonly target: string;
  /** Línea 1-based dentro de `target`. Si el token es un rango A-B, esto es A. */
  readonly line: number;
  /** Fin del rango, si el token era `A-B`. `undefined` = cita de una línea. */
  readonly endLine?: number;
  /** Textos que la línea DEBE contener. Conjunción. A mano, leyendo el código. */
  readonly mustContain: readonly string[];
  /** Camino de símbolos contenedor, de afuera hacia adentro (DT-10). `[]` sólo si el
   *  resolver no devuelve nada (target sin símbolos, o docblock de cabecera). */
  readonly symbolPath: readonly string[];
  /** OBLIGATORIO cuando `cite` es P3/P4 y `target` NO es `from` (DT-11). */
  readonly targetReason?: string;
}
```

`test/cited-lines-guard.exceptions.ts` exporta `UNICITY_EXCEPTIONS` (`{from, cite, reason}`, para el
paso 3 de DT-13), `UNANCHORABLE_PROSE` (AC-9) y `SCANNER_FALSE_POSITIVES` (los `:8443`/`:443`/`:0`
de P4 — vacío en el Corte A ✔, y **no se afirma que sea > 0**).

### 7.2 `test/cited-lines-guard.scanner.ts` — funciones puras

| Export | Firma | Qué hace |
|---|---|---|
| `scanSource` | `(src: string, file: string) => FoundCite[]` | Las 4 formas de §4.4 sobre un string. `FoundCite = {file, line, cite, form: 'P1'\|'P2'\|'P3'\|'P4', path?, num, endNum?}`. Descarta `::N`. |
| `resolveSymbolPath` | `(src: string, file: string, line: number) => string[]` | Compiler API. Whitelist de kinds de declaración + `it`/`test`/`describe` con string literal. Devuelve `[]` si no hay ninguno. |
| `normalizeTarget` | `(fromFile: string, token: string) => string \| null` | Resuelve `./`, `../` y el path relativo al citador. `null` para P2/P3/P4. |
| `locate` | `(targetSrc, targetFile, needles, symbolPath) => number[]` | Las líneas que cumplen **needles ⊆ línea** y **`symbolPath` es subsecuencia ordenada del path de esa línea**. |

⚠️ **`resolveSymbolPath` NO se aplica a targets sin símbolos** (`.md`, `.json`, `.sql`, `.yml`):
devuelve `[]` y el guard exige `symbolPath: []`.

### 7.3 Los seis códigos de fallo (DT-12) — cómo se distingue «se corrió» de «archivo mal»

Para cada entrada declarada, en **este orden**:

| # | Condición | Código | Mensaje (qué dice y cómo re-apuntar) |
|---|---|---|---|
| 1 | `target` no está en el índice de git | `E-TARGET_MISSING` | «el archivo citado no existe (o no está trackeado). Un cero de grep acá no significa "el ancla desapareció".» |
| 2 | El token no es consistente con `target` (DT-11) | `E-CITE_TARGET_MISMATCH` | «la entrada dice `target: X` y el token cita `Y`: o la entrada se copió de otra, o el comentario cambió.» |
| 3 | `line` > líneas del `target` | `E-LINE_OUT_OF_RANGE` | **AC-5**. «la línea citada está fuera del archivo (tiene N líneas).» |
| 4 | `locate(...)` devuelve **> 1** hit | `E-NEEDLE_VACUOUS` | **AC-3**. «tu declaración matchea las líneas [a, b, c]: no puede distinguir la correcta de la equivocada. Escalera de DT-13: alargá la conjunción, o re-apuntá la cita a la firma.» |
| 5 | **1** hit y **≠** `line` (o fuera de `[line, endLine]`) | `E-LINE_MOVED` | **AC-2**. «se corrió el archivo: tu ancla está ahora en **:M**. Re-apuntá la cita de `from` de `:N` a `:M`. ⚠️ Abrí `:M` antes de copiar este número (CD-11).» |
| 6 | **0** hits en `target`, pero **1** hit en **exactamente un** archivo del índice con el **mismo basename** | `E-WRONG_FILE` | **El caso `compose.ts:130`.** «el ARCHIVO citado está mal, no la línea: tu ancla vive en `src/services/compose.ts:571`. Buscar en el archivo citado da CERO, y ese cero **no** es "ya no está".» |
| 7 | **0** hits en `target` y **0** en los hermanos | `E-ANCHOR_GONE` | «el ancla desapareció del repo. Antes de re-apuntar, **releé la prosa**: puede que la afirmación también sea falsa ahora, no sólo el número.» |
| 8 | `symbolPath` declarado ≠ resolver en `line` | `E-SYMBOL_DRIFT` | **AC-4**. «la línea citada cae dentro de `[…]` y vos declaraste `[…]`.» |
| 9 | `symbolPath: []` y el resolver devuelve algo | `E-SYMBOL_OMITTED` | **CD-12**. |

El paso 6 **es** el control positivo del cero, dentro del guardián: nunca se reporta «no está» sin
haber buscado en los hermanos primero. ✔ Validado a mano en el caso real: `grep 'i > 0'
src/routes/compose.ts` → **0**; en `src/services/compose.ts` → **1** (y el basename tiene ✔ exactamente
**2** candidatos en el índice).

---

## 8. Los controles: `G-C1` … `G-C10`

> ⚠️ El work-item reservó `G-C1..G-C9`. **Uso diez** y digo por qué: **AC-10** (declarar lo que no se
> cubre) es verificable mecánicamente y merece su propio `it(`; meterlo dentro de otro control lo haría
> invisible en la salida de CI, que es justo donde tiene que leerse.

| Control | AC | Qué afirma | Mutante que lo mata (input concreto) |
|---|---|---|---|
| **G-C1** — armado del universo | AC-6, AC-7 | Los **14** paths declarados están **todos** en el índice de git; el barrido devolvió **≥ 40** anclas; y **cada una de las 4 formas tiene ≥ 1** población real (✔ hoy 14/12/16/3). | Borrar un path de la lista → el conteo de archivos deja de ser 14. Romper el regex de P4 → `P4 === 0` → rojo. Un `ls-files` que devuelva vacío → 0 archivos → rojo. **Sin el piso por forma, romper P4 sólo bajaría el total de 45 a 42 y el guardián seguiría verde** — que es la falla medida de WKH-316. |
| **G-C2** — el escáner no es vacuo | AC-7, AC-11 | Fixtures **en memoria** con la respuesta conocida: las 4 formas, `./`, `../`, un rango `A-B`, y `::1` que **no** debe reportarse. | Un escáner que **no reporte nunca** (los 8 casos positivos quedan en 0). Un escáner que **reporte siempre** (`::1` aparece). Quitar el `./` del regex → el caso `./splash.tsx:245` desaparece. |
| **G-C3** — el resolver de símbolos no es vacuo | AC-4, AC-7 | Fixtures: función anidada en clase → `['C','m']`; docblock de cabecera → `[]`; `it('…')` → el nombre del test; `PropertySignature` dentro de dos type literals → los 3 nombres. | Un resolver que devuelva siempre `[]` (los 3 casos positivos fallan). Uno que devuelva el nodo más interno **sin whitelist** → aparece `add`/`from` (✔ medido: es la variante que descarté). Uno que use `getStart` en vez de `getFullStart` → el docblock deja de mapear a su declaración. |
| **G-C4 ★** — toda cita está declarada | **AC-1** | Toda cita que el escáner encuentra en los 14 paths está en `CITED_LINES`, en una excepción, o es un target delegado. **Y el invariante estricto**: `encontradas === declaradas + exceptuadas + delegadas`. | Agregar un comentario `// ver foo.ts:42` a `src/types/index.ts` → rojo con archivo, línea (derivada) y token. **Sin el invariante estricto**, una entrada declarada que ya no existe en el fuente no se nota (es AC-8, y por eso G-C7). |
| **G-C5** — el ancla sigue ahí, y es única | AC-2, AC-3, AC-5 | Por entrada: los 6 códigos de §7.3. | Cambiar `compose.ts:571` de sitio → `E-LINE_MOVED` con el número nuevo. Declarar `mustContain:['i > 0']` → `E-NEEDLE_VACUOUS` con los ✔ 5 hits reales. Poner `line: 99999` → `E-LINE_OUT_OF_RANGE`. Declarar `target:'src/routes/compose.ts'` → `E-WRONG_FILE` apuntando a `services/`. |
| **G-C6** — el símbolo contenedor es el declarado | AC-4 | El `symbolPath` declarado es subsecuencia del path que el resolver da en `line`; `[]` sólo si el resolver da `[]`. | Mover la cita de `:571` a `:208` **dejando la needle** → ✔ el resolver da `compose` vs `executePipeline` → `E-SYMBOL_DRIFT`. Vaciar un `symbolPath` → `E-SYMBOL_OMITTED`. |
| **G-C7** — ninguna entrada sobrevive a su sitio | AC-8 | Toda entrada de `CITED_LINES` corresponde a un token que el escáner **encuentra hoy** en su `from`. | Borrar el comentario citador y dejar la entrada → rojo. Simétrico de `G-09` ✔ (`test/ownership-filter-guard.test.ts:613`). |
| **G-C8** — forma y motivo, en RUNTIME | AC-9, DT-4 | `mustContain` no vacío y sin strings de < 4 caracteres; `line ≥ 1` entero; motivos de excepción ≥ 40 caracteres y **únicos palabra por palabra**; `targetReason` presente cuando DT-11 lo exige. | `mustContain: []` (compila, no rompe lint, entraría al repo — ✔ `package.json:11` no lintea `test/`). Dos excepciones con el mismo motivo copiado → rojo, igual que ✔ `G-10` (`:651-655`). |
| **G-C9** — la delegación tiene dueño vivo | CD-1 | Cada `DELEGATED_TARGETS[i].ownedBy` sigue existiendo: `CITED_INDEX_LINES` está en `test/sdd-index-matches-folders.exceptions.ts` y los `it(` de `G-F1`/`G-F2` están en su test. | Borrar `G-F2` → rojo acá. **Sin este control, borrar `G-F2` dejaría los `_INDEX.md:N` sin dueño y sin que nada avise** (y con `G-C4` descartándolos en silencio). |
| **G-C10** — el guardián declara lo que NO cubre | AC-10 | El docblock de `cited-lines-guard.test.ts` contiene la sección de no-cobertura con **≥ 8** ítems enumerados, e incluye literalmente los tres que AC-10 exige (no trackeados por git · prosa suelta · el VALOR de la afirmación). | Borrar la sección → rojo. Precedente ✔: el docblock de `ownership-filter-guard.test.ts` cierra en `:134` y su función es exactamente ésta. |

**Cobertura de los 12 ACs**: AC-1→G-C4 · AC-2→G-C5 · AC-3→G-C5 · AC-4→G-C6 (+G-C3) · AC-5→G-C5 ·
AC-6→G-C1 · AC-7→G-C1/G-C2/G-C3 · AC-8→G-C7 · AC-9→G-C8 · AC-10→G-C10 · AC-11→G-C2 (ampliado a 4
formas, DT-8) · **AC-12→§4.1 de este SDD** (es un AC sobre el diseño, no sobre el código: se cierra
acá, con las 3 mediciones, y no genera control).

---

## 9. Waves de implementación

> ⚠️ **El guardián está ROJO desde W1 hasta el final de W4, por diseño.** Es `G-F2` aplicado: «cita
> nueva sin declarar = rojo» y al principio **ninguna** está declarada. El Dev **no** debe interpretar
> ese rojo como error, y **no** debe apagarlo agregando un escape. El criterio de avance de cada wave
> está en la columna «Verde cuando».

### W0 — Contratos y escáner (SERIAL, nada depende de nada)

| Archivo | Acción |
|---|---|
| `test/cited-lines-guard.scanner.ts` | **CREAR**. Los 4 exports de §7.2. Puro sobre strings. `import ts from 'typescript'`. |
| `test/cited-lines-guard.citations.ts` | **CREAR**. `interface CitedLine` (§7.1) + `CITED_LINES: readonly CitedLine[] = []` + `DELEGATED_TARGETS` (DT-14) + `CORTE_A_PATHS` (los 14 de §3.2). |
| `test/cited-lines-guard.exceptions.ts` | **CREAR**. Los 3 arrays de §7.1, vacíos, con sus docblocks de motivo. |

**Verde cuando**: `npx vitest run test/cited-lines-guard.scanner.ts` no aplica (no es test); el criterio
es que `tsx` pueda importar los 3 módulos sin error. ⚠️ **CD-3**: `npx vitest run > archivo` trunca a
500 chars con exit 0 — no redirigir.

### W1 — El instrumento se prueba antes de usarse (paralelizable con W0 sólo en lectura)

| Archivo | Acción |
|---|---|
| `test/cited-lines-guard.test.ts` | **CREAR** con `G-C1`, `G-C2`, `G-C3`, `G-C10` **solamente**. |

**Verde cuando**: los 4 pasan. **Son verdes desde el primer minuto y no dependen del registro.** Este
corte de wave es deliberado: si el escáner y el resolver no están probados con fixtures antes de que
alguien empiece a declarar 45 entradas, las 45 se escriben contra un instrumento no verificado.

### W2 — El guardián propiamente dicho

| Archivo | Acción |
|---|---|
| `test/cited-lines-guard.test.ts` | **MODIFICAR**: agregar `G-C4` … `G-C9`. |

**Verde cuando**: `G-C1..G-C3`, `G-C9`, `G-C10` verdes y **`G-C4` rojo con exactamente 45 citas sin
declarar** — ése es el criterio de éxito de W2: el rojo tiene que enumerar **45**, no 42 ni 49. Si
enumera otro número, el escáner difiere de la medición de §3.2 y hay que reconciliar **antes** de
seguir.

### W3 — Declarar las 18 anclas de los 5 archivos con citas falsas medidas (+ corregirlas)

| Archivo | Acción | Anclas |
|---|---|---|
| `test/cited-lines-guard.citations.ts` | **MODIFICAR**: 18 entradas a mano | — |
| `src/types/index.ts` | **MODIFICAR — SÓLO COMENTARIOS**: `:207` (`` `:777` ``→`:922`), `:510` (`reputation.ts:182-183`→`:189`), `:1450` (`compose.ts:130`→`src/services/compose.ts:571`) | 9 |
| `src/services/compose.ts` | **MODIFICAR — SÓLO COMENTARIO**: `:688` (`:208`→`:571`) — **H-1** | 5 |
| `src/routes/agents.ts` | **MODIFICAR — SÓLO COMENTARIO**: `:47` (`registries.ts:35`→`registries.ts:94`) | 2 |
| `test/sdd-index-matches-folders.exceptions.ts` | **MODIFICAR — SÓLO COMENTARIO**: `:15` (`tsconfig.json:19`→`:20`) — **H-2** | 1 |
| `src/services/agent.payment.test.ts` | declarar (su cita ya está correcta ✔) | 1 |

**CD-10 aplica a las 5 correcciones: LÍNEA-NEUTRAS**, verificadas con `/usr/bin/git diff --numstat`
**y** `wc -l`. **CD-4 aplica a las 18**: abrir cada línea, incluidas las 4 de la tabla de §4.3.

**Verde cuando**: `G-C4` rojo con **27** pendientes (45 − 18) y **cero** fallos de `G-C5`/`G-C6`/`G-C8`
sobre las 18 declaradas.

### W4 — Declarar las 27 restantes

`src/lib/operator-address.ts` (6) · `src/routes/agents.publish.test.ts` (6) ·
`src/routes/agents.ownership.test.ts` (5) · `CLAUDE.md` (3) · `src/lib/payment-spec-reader.ts` (2) ·
`src/services/fee-split.ts` (2) · `test/payment-guards-live-in-one-place.test.ts` (2) ·
`src/services/agent.ts` (1). Sólo se modifica `test/cited-lines-guard.citations.ts`
(⚠️ **y `src/`/`CLAUDE.md` únicamente si alguna resulta falsa** — en ese caso, CD-10).

**Verde cuando**: **los 10 controles verdes.** Éste es el primer momento en que `npm test` puede pasar.

⚠️ **W3 y W4 NO son paralelizables entre sí**: las dos escriben en
`test/cited-lines-guard.citations.ts`. Serial, mismo autor.

### W5 — El docblock (AC-10) y la reconciliación de números

| Archivo | Acción |
|---|---|
| `test/cited-lines-guard.test.ts` | **MODIFICAR**: docblock con la lista de no-cobertura (§11) + el mecanismo de DT-6. |
| `test/cited-lines-guard.scanner.ts` | **MODIFICAR**: docblock «LO QUE ESTE ESCÁNER NO VE», con los FP de P4 y el límite de la prosa suelta. |

⚠️ **Y una advertencia sobre los números del docblock**: todo número que se escriba ahí (45, 749,
20.550, 6,0 %) es una **foto** y `G-C1` sólo verifica un **piso** ⇒ envejece en silencio, que es
exactamente el defecto de esta clase. El docblock **debe** decir de dónde se deriva cada número
(«correr el escáner sobre `CORTE_A_PATHS`») en vez de sólo declararlo.

---

## 10. Exemplars verificados (todos ✔ con `ls-files`/`Read`, con line ranges reales)

| Exemplar | Line range ✔ | Qué se copia |
|---|---|---|
| `test/ownership-filter-guard.test.ts` | `:317-318` (clave `archivo:línea`) · `:594` (`G-08` ★) · `:613-630` (`G-09`, incl. el invariante estricto en `:630` y el piso en `:629`) · `:633-686` (`G-10`, incl. motivos duplicados y el cruce `table`/`verb`) | **Exemplar primario.** La estructura entera: test ★ + higiene de la lista + validación en runtime + mensajes de error que dicen cómo arreglar. `G-C4`≈`G-08`, `G-C7`≈`G-09`, `G-C8`≈`G-10`. |
| `test/ownership-filter-guard.test.ts` | `:347` `:364` `:381` `:404` `:434` (controles de armado) · `:325-337` (por qué un piso no alcanza contra un universo **sesgado**) | `G-C1`. De acá sale la idea del **piso por forma de cita**, no sólo global: es el análogo del sesgo que `G-11`/`G-12` cierran. |
| `test/ownership-filter-guard.test.ts` | `:477-478` (el harness `scan`) · `:482` `:496` `:513` `:537` `:549` (`G-03`..`G-07`) | `G-C2`/`G-C3`: fixtures en memoria con la respuesta conocida de antemano, y el comentario `// Input que lo pone en rojo:` **en cada uno**. Esa línea de comentario es el formato del «mutante que lo mata». |
| `test/ownership-filter-guard.scanner.ts` | `:1-36` (docblock; la sección «LO QUE ESTE ESCÁNER NO VE» arranca en `:15`) · `:93` `:198` `:243` `:349` `:467` (exports) | `DT-15` y `G-C10`. |
| `test/sdd-index-matches-folders.exceptions.ts` | `:160-167` (`CitedIndexLine`) · `:169-180` (el docblock del «a mano») · `:181-192` (`CITED_INDEX_LINES`, 2 entradas) | `DT-1`. El tipo de §7.1 es su generalización. |
| `test/sdd-index-matches-folders.test.ts` | `:398-418` (`G-F1`) · `:420-446` (`G-F2`, con `execFileSync('git',['ls-files'…])` en `:421` y el patrón en `:433`) | `G-C4`/`G-C5`. Y el dueño que `G-C9` vigila. |
| `test/sdd-index-matches-folders.test.ts` | `:332-334` (`G-C`) · `:447` (`G-G`) | El patrón **«control positivo del propio control»**: `expect(ambiguous.length, 'ya no hay números compartidos: revisá si este control sigue teniendo sentido').toBeGreaterThan(0)`. Es el precedente que autoriza el piso por forma de `G-C1`. |
| `test/payment-guards-live-in-one-place.test.ts` | `:9-14` (por qué dos guardianes divergen) · `:16-20` (por qué `codeOnly` **tiene** que borrar comentarios) · `:45` (`codeOnly`) | `CD-1`, `CD-7`, Scope OUT. |
| `test/test-files-are-run-in-ci.test.ts` | `:2` (alcance = `*.test.*`) | Que los 3 archivos no-test nuevos no rompen ese guardián. |
| `vitest.config.ts` | `:5` (`include`) · `:16` (`passWithNoTests: false`) | Que `cited-lines-guard.test.ts` se corre sin tocar config. |

---

## 11. Lo que este guardián NO va a cubrir (borrador de AC-10, ≥ 8 ítems para `G-C10`)

1. **Las citas en archivos no trackeados por git.** ✔ Caso medido y grave:
   `.nexus/project-context.md` (§4.5) — el documento que **le pide al lector verificar sus citas** es
   inalcanzable por construcción.
2. **Las citas en prosa suelta** («la línea 95», «el guard de más abajo»). No tienen forma sintáctica.
   Es la razón por la que **45 es un piso y no un total**.
3. **El VALOR semántico de la afirmación.** El guardián verifica que la línea diga lo declarado; **no**
   que la prosa alrededor sea verdadera. ✔ Caso medido: H-2 tenía el número mal y la **conclusión
   bien**; el simétrico (número bien, conclusión falsa) pasa en verde. Es el mismo hueco que el guard
   de ownership declara para el **valor** del filtro (`scanner.ts:24-26`).
4. **El 94 % de `src`+`test`** ✔ (704 de 749 anclas) y el **99,8 %** del repo. §3.1-3.2.
5. **Los 41 pares `{file,line}` de `ownership-filter-guard.exceptions.ts`**: dueño = `G-08`/`G-09`/`G-10`.
   No es un hueco, es una delegación — pero se lee igual si no está escrito.
6. **Las citas a `doc/sdd/_INDEX.md`**: dueño = `G-F1`/`G-F2`, vigilado por `G-C9`.
7. **Las citas que apuntan a una línea correcta de un archivo que dejó de ser el relevante** (el
   refactor movió el candado a otro módulo y la vieja línea sigue existiendo, diciendo lo mismo).
8. **Los rangos `A-B`**: se verifica que la conjunción caiga **dentro** del rango, no que las B−A+1
   líneas sigan diciendo lo que la prosa afirma del bloque entero.
9. **`README.md`, `doc/INTEGRATION.md` y los 20.550 anclas de `doc/`** ✔ — Corte D, y hoy es un
   programa, no una HU.
10. **La cita que se escribe en un archivo fuera de los 14 paths.** El universo es explícito: un
    archivo nuevo no entra solo. ⇒ **cada corte siguiente tiene que ampliar `CORTE_A_PATHS`**, y
    mientras no se amplíe, el silencio es real.

---

## 12. Plan de tests

**Archivos de test**: uno solo nuevo, `test/cited-lines-guard.test.ts`, con **10 `it(`**. Sin tests de
comportamiento nuevos en `src/` (CD-2: esta HU no cambia una respuesta HTTP).

**Formato obligatorio, copiado del exemplar** ✔ (`test/ownership-filter-guard.test.ts:483`, `:497`,
`:514`): cada `it(` arranca con un comentario `// Input que lo pone en rojo: …`. El mutante de cada
control está en la tabla de §8 y **va escrito dentro del test**, no en un reporte que nadie relee.

**Fixtures de `G-C2` (en memoria, respuesta conocida)** — mínimo:

| Fixture | Esperado |
|---|---|
| `// ver src/services/agent.ts:721` | 1 cita P1, `path='src/services/agent.ts'`, `num=721` |
| `// ver ./splash.tsx:245` | 1 cita P1 con `./` — ⚠️ el caso que otro repo perdió |
| `// ver ../adapters/solana/chain.ts:84` | 1 cita P1 con `../`, normalizada contra el dir del citador |
| `// ver agent.ts:721` | 1 cita P2, sin path resoluble |
| ``// ver `:692` `` | 1 cita P3 |
| `// guard i>0 de :208` | 1 cita P4 — **el caso H-1** |
| `// ver types/index.ts:203-225` | 1 cita con `endNum=225` |
| `const local = '::1';` | **0** citas (el FP medido) |
| `const url = 'https://x:8443/y';` | 1 cita P4 → confirma que el ruido cae del lado **ruidoso** (se exceptúa, no se adivina) |

**Fixtures de `G-C3`**: clase con método → `['C','m']`; docblock de cabecera → `[]`; `it('AG-01: …')`
→ `['it(AG-01: …)']`; `PropertySignature` a 3 niveles → los 3 nombres.

**Verificación del universo, sin correr la suite completa** (restricción de máquina): el Dev corre
**sólo** `npx vitest run test/cited-lines-guard.test.ts` en cada wave. La suite completa se corre
**una vez**, al final de W4, y si aparece un rojo con la firma `X is not a function` **hay que
re-correr sólo ese archivo antes de creerle** — está medido que es el modo de falla de esta máquina con
3 agentes concurrentes.

**Regresión que hay que vigilar explícitamente**: las 5 correcciones de comentarios de W3 tocan
`src/types/index.ts` y `src/services/compose.ts`, que son ✔ el target de citas **entrantes** desde
otros archivos (`src/services/compose.ts:1548` cita `types/index.ts:217-218`). **CD-10 (línea-neutra)
es lo que impide que el arreglo rompa esas citas** — y es el mismo error que se cometió anoche
`[HEREDADO]`.

---

## 13. Análisis de riesgo del propio diseño (para el Adversary)

| Riesgo | Mitigación en este SDD |
|---|---|
| El guardián nace vacuo porque el registro se llenó volcando el escáner | CD-6 + CD-11 + `G-C8` (motivos únicos palabra por palabra) + `G-C5` (una needle copiada de la entrada de arriba matchea otra línea → `E-NEEDLE_VACUOUS`) |
| El registro se llena con `mustContain` genéricos que pasan por casualidad | **`G-C5` caso 4**: ✔ medido, `['i > 0']` da 5 hits → rojo. No hay forma de declarar perezosamente y quedar verde. |
| `exceptions.ts` se vuelve el interruptor de apagado | **CD-14 + DT-13**: la excepción exceptúa **sólo la unicidad**; existencia y match no son exceptuables. |
| Alguien arregla el rojo borrando un path de `CORTE_A_PATHS` | `G-C1` exige **14** archivos exactos. Borrar un path es un cambio visible en el diff de un `it(`, no un silencio. |
| El resolver de símbolos fabrica un bug y los 45 `symbolPath` se escriben mal | `G-C3` con fixtures de respuesta conocida **antes** de W3 (por eso W1 va antes de W3), y ✔ el resolver ya está corrido a mano sobre 11 líneas reales en este F2. |
| El guardián se pone rojo por una HU ajena y alguien lo borra en vez de re-apuntar | `E-LINE_MOVED` trae **el número corregido**; `E-WRONG_FILE` trae **el archivo y la línea**. Es la mitigación que el work-item pide en su análisis de paralelismo. |
| Los números del docblock envejecen y nadie lo nota | Declarado en W5: el docblock dice **cómo derivar** cada número, y `G-C1` es un piso (no verifica el 45). **Este riesgo se acota, no se cierra**, y va dicho así. |
| `typescript` desaparece de `devDependencies` | ✔ `npm test` no correría en absoluto (`vitest` lo necesita). No hace falta control propio. |

---

## 14. `[NEEDS CLARIFICATION]` — estado

1. `[RESUELTO en este F2]` **La lista de paths del Corte A y el piso de AC-6**: §3.2 (14 paths) y §8
   `G-C1` (14 archivos exactos + ≥ 40 anclas + ≥ 1 por forma).
2. `[RESUELTO en este F2]` **El formato del registro y cómo se resuelve `inSymbol`**: §7.1, un
   `citations.ts` + un `exceptions.ts` para todo el corte (no uno por universo: partirlos ahora
   crearía la divergencia que CD-1 castiga). `inSymbol` se llama `symbolPath`, se resuelve con el
   compiler API, y **no** se colapsa en «que el `mustContain` incluya la firma»: ✔ medido, esa variante
   barata **no alcanza** para `database.types.ts:2567` (§4.6), que es una cita normativa real.
3. `[RESUELTO en este F2, contra la recomendación del F1]` **¿`project-context.md` y `CLAUDE.md` en el
   Corte A?** `project-context.md`: **NO, y no por costo — por medición**: ✔ no está en git (§4.5).
   `CLAUDE.md`: **SÍ**, entra. ✔ Son **3** anclas (costo despreciable) y es el documento normativo del
   repo. El F1 recomendó dejar los dos afuera; lo cambio con el número en la mano.
4. `[ABIERTO — para el humano, NO bloqueante para F2.5]` **¿El repo acepta un guardián que nace
   cubriendo 6,0 % de `src`+`test` y 0,21 % del repo?** DT-2 asume que sí y CD-8 obliga a publicar los
   dos porcentajes en todo reporte. Si la respuesta es no, **lo que cambia no es el diseño: es el
   número de cortes que hay que planificar** (§3.4).
5. `[ABIERTO — decisión de founder, diferida]` **`TD-316-CITAS-PROJECT-CONTEXT`**: ¿se trackea
   `.nexus/project-context.md` en git? Es la única forma de que sus citas puedan tener testigo. **No
   es alcance de esta HU.**

---

## 15. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todos los exemplars existen y sus line ranges están verificados | ✔ **SÍ** — §10, 10 archivos, cada rango abierto en este F2 |
| 2 | El universo está derivado con instrumento propio, con su piso y su población por forma | ✔ **SÍ** — §3.1-3.2: 14 paths, 45 anclas, P1=14/P2=12/P3=16/P4=3 |
| 3 | Ningún número heredado se copió | ✔ **SÍ** — el 46, el 55 y los dos «12» quedan explicados y descartados (§3.3) |
| 4 | Las citas heredadas de CD-4 fueron re-abiertas | ✔ **SÍ** — 4 tabuladas + 2 declaradas exactas (§4.3), y **3 falsas nuevas** encontradas (§4.2) |
| 5 | CD-1 verificado, no asumido | ✔ **SÍ** — 3 mediciones (§4.1) + `G-C9` para el caso futuro |
| 6 | AC-3 tiene formulación decidida y **medida** | ✔ **SÍ** — conjunción (§3.5) con ámbito `symbolPath` (§4.6), incluido el control de vacuidad con 5 hits reales |
| 7 | La pregunta «¿anclar por símbolo?» está decidida y justificada | ✔ **SÍ** — DT-10: sí, obligatorio donde el resolver devuelva algo, y **medido** que catchea 4 de las 6 citas falsas conocidas por sí solo |
| 8 | «Línea corrida» vs «archivo mal» distinguidos con mensaje propio | ✔ **SÍ** — §7.3, 9 códigos, con el control positivo del cero dentro del algoritmo |
| 9 | Qué hace el guard cuando el `mustContain` no puede ser único | ✔ **SÍ** — DT-13, escalera de 3 pasos, y la excepción **acota y no anula** (CD-14) |
| 10 | Waves con archivos exactos y criterio de verde por wave | ✔ **SÍ** — §9, W0..W5, incluido que el rojo de W1-W4 es esperado y con qué número |
| 11 | Plan de tests con el mutante que mata cada control | ✔ **SÍ** — §8 (tabla) + §12 (fixtures) |
| 12 | Lista de no-cobertura redactada (AC-10) y con control mecánico | ✔ **SÍ** — §11 (10 ítems) + `G-C10` |
| 13 | Los `[NEEDS CLARIFICATION]` del work-item resueltos o escalados | ✔ **SÍ** — §14: 3 resueltos con medición, 2 escalados y **no bloqueantes** |
| 14 | Ningún `[TBD]` sin resolver dentro del alcance del SDD | ✔ **SÍ** |
| 15 | Se respetaron las prohibiciones de la fase | ✔ **SÍ** — cero líneas de código de producción; el único archivo escrito es este `sdd.md`; `main` intacto; nada pusheado; `story-file.md` de la HU 212 con md5 verificado sin cambios |

### ⚠️ Lo que este F2 **no** midió, y el F3 tiene que medir

- **`[NO MEDIDO]`** El tiempo real de `npm test` con el guardián nuevo. No corrí la suite completa
  (3 agentes concurrentes; ver §0.1). El costo esperado es un `readFileSync` + un `createSourceFile`
  por target distinto (≈ 25 archivos) — **estimación, no medición**.
- **`[NO MEDIDO]`** Si el `symbolPath` de **cada una** de las 45 anclas es escribible en ≤ 3 elementos.
  Verificado ✔ para 11 líneas reales; las otras 34 se descubren al declararlas. **Si alguna necesita 6
  elementos** (como `database.types.ts`, que necesita 3 de 6), es aceptable; si alguna necesita el path
  **completo** para ser única, eso es señal de que la cita hay que re-apuntarla (DT-13 paso 2).
- **`[HEREDADO]`** Todo número de la suite (5308 tests, tiempos) viene de artefactos previos.

---

**Artefacto**: `doc/sdd/224-citas-archivo-linea-sin-testigo/sdd.md`
**Siguiente gate**: `SPEC_APPROVED` (texto exacto). Después de eso, F2.5 → `story-file.md`.
