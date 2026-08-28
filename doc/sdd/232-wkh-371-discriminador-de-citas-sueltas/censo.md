# Censo de citas sueltas — WKH-371

> **Foto del 2026-08-28**, derivada contra el commit base `19405baf7f173033c4ef81dc8380238f1cda73ba`.
> Todos los números de este documento se DERIVAN corriendo una función nombrada; ninguno está
> escrito a mano. Si alguno no coincide con el árbol de hoy, el que tiene razón es la función.

---

## 0 · Lo que hay que leer antes de citar cualquier número de acá

**Un número de citas sueltas sin su PERÍMETRO y sin su PATRÓN no significa nada** (CD-1). Los cinco
números que este repo venía arrastrando difieren entre sí por un factor de **treinta**, y no porque
alguno estuviera mal: porque cada uno contaba una cosa distinta y ninguno decía cuál. §5 los pone
uno al lado del otro.

**Y este censo mide una FOTO.** El perímetro `src`+`test`+`scripts` es estable; el de `doc/` crece
cada vez que se abre una HU — incluida ésta.

---

## 1 · El perímetro, con su patrón

**Perímetro**: los archivos de `src/`, `test/` y `scripts/` presentes en el **índice de git** del
commit `19405ba` (no en el disco). **Patrón**: las cuatro formas sintácticas de `scanSource`
(`test/cited-lines-guard.scanner.ts`), de las cuales las SUELTAS son P3 (`` `:N` ``, con backticks)
y P4 (`:N`, sin backticks).

| Magnitud | Valor | Derivada por |
|---|---|---|
| archivos escaneados | **611 de 611** | `git ls-tree -r --name-only <base> -- src test scripts` |
| tokens P1 (path con `/` + `:N`) | **250** | `scanSource` |
| tokens P2 (basename + `:N`) | **498** | `scanSource` |
| tokens P3 (`` `:N` ``) | **277** | `scanSource` |
| tokens P4 (`:N`) | **1070** | `scanSource` |
| **total de citas** | **2095** | `scanSource` |
| **SUELTAS (P3+P4)** | **1347** | `scanSource` |

### Control de instrumento — 0 divergencias

Antes de creerle a esos números se re-derivó el conteo **archivo por archivo** con un recorrido
propio, escrito de cero y **sin usar ninguna de las expresiones regulares del escáner** (un caminado
carácter a carácter que implementa la misma gramática hacia adelante). Comparado contra `scanSource`
en los 611 archivos:

```
CONTROL DE INSTRUMENTO — divergencias archivo por archivo: 0
```

Sin ese control, un número de este censo podría ser un defecto del arnés de medición y no una
propiedad del repo. No es una precaución teórica: esta misma HU encontró **dos defectos** de su
propio instrumento (§6).

---

## 2 · Lo que queda AFUERA, cada uno con su número

Un candado con perímetro incompleto se lee como lista cerrada, así que cada exclusión va con su
medición.

| Fuera del perímetro | Archivos | Sueltos | Por qué |
|---|---|---|---|
| `doc/` | **1085** de texto (1097 trackeados) | **12785** | Registro histórico por defecto — ver §3 |
| Raíz del repo | **19** trackeados, **14** de texto | **37** | No entra al arreglo — ver §4 |
| Resto (`packages/`, `mcp-servers/`, `contracts/`, `supabase/`, `examples/`…) | **224** de texto | **119** | El `npm test` de la raíz no los corre |
| **Repo entero (archivos de TEXTO trackeados)** | | **14288** | Suma de los cuatro |

### Los 8 archivos AUTO-REFERENTES, fuera del universo del clasificador

No están fuera del *perímetro* (se cuentan en los 1347): están fuera del *universo del
clasificador*, porque contienen la respuesta que el clasificador tendría que producir.

| Archivo | Sueltos |
|---|---|
| `test/cited-lines-guard.scanner.ts` | 27 |
| `test/cited-lines-guard.test.ts` | 25 |
| `test/cited-lines-guard.citations.ts` | 73 |
| `test/cited-lines-guard.exceptions.ts` | 33 |
| `test/ownership-filter-guard.scanner.ts` | 1 |
| `test/ownership-filter-guard.test.ts` | 9 |
| `test/ownership-filter-guard.exceptions.ts` | 27 |
| **subtotal (los 7 de DT-11)** | **195** |
| `test/cited-lines-guard.sample.ts` | **0 al commit base** — no existía |
| **universo del clasificador** | **1347 − 195 = 1152** |

`TD-224-CITAS-DEL-PROPIO-GUARDIAN` **se declara con su número re-derivado, no se cierra acá.**

### El residuo: por qué 1347 es un PISO y no un total

Lo que el escáner **no puede ver**, y por lo tanto no está en ningún número de este documento:

- **La prosa suelta.** «la línea 95», «el guard de más abajo», «el docblock de arriba» no tienen
  forma sintáctica. **No hay cota superior conocida**: medirla exige leer los 611 archivos a mano.
- **Las citas partidas en dos líneas.** Un `archivo.ts:` al final de una línea con el número al
  principio de la siguiente. Población hoy 0, y eso es una medición de HOY, no una propiedad.
- **Los archivos sin extensión.** `Dockerfile:12` pierde el nombre y cae al barrido suelto: se
  cuenta como P4, o sea que ENGORDA este censo con tokens que sí nombraban archivo.
- **El valor semántico.** El escáner encuentra el token; que la línea diga lo que la prosa afirma lo
  verifica `G-C5` con su `mustContain`, y sólo para las citas declaradas. Que la prosa sea VERDADERA
  no lo verifica nadie.
- **`.nexus/project-context.md`**: `[NO MEDIDO]`. No está en el índice de git y el repo es público.
  Es una **ausencia, no un cero** (`TD-316-CITAS-PROJECT-CONTEXT`).
- **`chaski-v3` y `wasiai-remittance-agents`**: `[NO MEDIDO]`. Universos de git distintos
  (`TD-371-PORTABILIDAD`). Medido: `wasiai-remittance-agents` aporta **0** archivos al índice de
  este repo, y hay citas de este repo que apuntan ahí (§7, FP-1/FP-2).

---

## 3 · `doc/` se mide y NO se toca

**Medición**: `git ls-tree -r --name-only <base> -- doc | wc -l` → **1097 archivos trackeados**, de
los cuales **1085** son de texto, con **12785** tokens sueltos.

**Cuántos artefactos declaran numerar el ÁRBOL VIVO** (o sea, cuántos podrían pudrirse):

```
/usr/bin/grep -rlE "numeran? el árbol|árbol vivo|árbol PREVIO|numera el árbol" doc/
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/_INDEX-row.md
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/sdd.md
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/story-file.md
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/work-item.md
  doc/sdd/_INDEX.md
```

**5 de 1085**, y **CUATRO de los cinco son artefactos de ESTA HU**. El quinto es `doc/sdd/_INDEX.md`.
⇒ `doc/` es **histórico prácticamente en su totalidad**, y sus 12785 tokens describen árboles
pasados: re-anclarlos sería falsificar el registro.

> ⚠️ El SDD midió **3 de ~1095**; hoy son **5 de 1085**. La diferencia no es un error del SDD: son
> los artefactos que la propia HU fue agregando entre el SDD y este censo. Es la razón por la que
> este número lleva fecha y commit, y por la que **no se clava en ningún test**.

`git diff --stat doc/ -- ':!doc/sdd/232-*'` → **vacío**. `doc/` no se tocó.

---

## 4 · La raíz del repo, con su REGLA de exclusión

El SDD declara «13 archivos · 33 sueltos» **sin decir qué regla lleva de la lista completa a 13**,
que es exactamente lo que CD-1 existe para impedir. Re-derivado acá **con su regla escrita**:

> **Regla**: archivos trackeados al commit base cuyo path no contiene `/`.

**19 archivos**: `.env.example`, `.gitignore`, `.gitmodules`, `.npmrc`, `.nvmrc`, `CLAUDE.md`,
`CROSS-CHAIN-E2E-PROVEN-2026-04-28.md`, `HACKATHON-FINAL.md`, `LICENSE`, `README.es.md`, `README.md`,
`biome.json`, `package-lock.json`, `package.json`, `railway.json`, `tsconfig.build.json`,
`tsconfig.json`, `vitest.config.ts`, `vitest.e2e.config.ts`.

De ésos, **14 son de texto** bajo el filtro de extensiones del censo, y suman **37 tokens sueltos**.
**No se pudo reproducir el 13**, y no se ajustó ningún número para que diera: se publica la regla y
lo que la regla produce.

---

## 5 · Los cinco números heredados, y por qué no eran comparables

| Fuente | «sueltos» | Perímetro declarado | Patrón declarado |
|---|---|---|---|
| Issue #178 (2026-08-25) | 7835 | ⛔ ninguno | ⛔ ninguno |
| `_INDEX.md:218`, patrón con rangos | 7835 | ⛔ ninguno | parcial |
| `_INDEX.md:218`, patrón `` `:N` `` a secas | 4222 | ⛔ ninguno | parcial |
| Orquestador, `src+test+scripts` | ~1470 | sí | ⛔ ninguno |
| Orquestador, `+doc/` | ~14772 | sí | ⛔ ninguno |
| **Esta HU**, `src+test+scripts` | **1347** | sí | sí |
| **Esta HU**, repo entero (texto trackeado) | **14288** | sí | sí |

**La conclusión que va escrita: el número heredado NO ERA COMPARABLE, no que estuviera «mal».**
Entre 4222 y 14288 hay un factor de 3,4, y la diferencia entera se explica por qué archivos se
miraron y qué forma se contó. Ninguno de los cinco lo decía, así que ninguno de los cinco se puede
verificar ni refutar. Ése es el defecto que este documento existe para no repetir.

---

## 6 · El clasificador: lo que decide sobre el perímetro

Universo: los **1152** tokens sueltos del perímetro **sin los 8 archivos auto-referentes**.
Derivado por `classifyBareCite` (`test/cited-lines-guard.scanner.ts`).

| Clase | Tokens |
|---|---|
| `CITA` (con destino resuelto) | **38** |
| `RUIDO` | **953** |
| `DATO` | **25** |
| `INDECIDIBLE` | **136** |

| Regla | Tokens | Qué decide |
|---|---|---|
| D1 (carácter previo alfanumérico) | **953** | `RUIDO` |
| D2 (carácter previo comilla) | **25** | `DATO` |
| D3a (un archivo nombrado con `:N`) | **32** | `CITA` |
| D3b (un archivo nombrado sin `:N`) | **6** | `CITA` |
| D5 (auto-cita) | **36** | `INDECIDIBLE` — **DEGRADADA**, ver §8 |
| D6 (más de un archivo nombrado) | **61** | `INDECIDIBLE` |
| D7 (sólo contexto homónimo) | **15** | `INDECIDIBLE` |
| RESIDUO | **24** | `INDECIDIBLE` |

> ⚠️ **No coincide con la hipótesis del Story File** (`CITA 229 · RUIDO 976 · DATO 38 ·
> INDECIDIBLE 104` sobre 1347), y las causas están medidas:
> 1. **El denominador es otro**: la hipótesis contaba los 1347 tokens **incluyendo** los 8
>    archivos auto-referentes, que son 195 tokens y los más densos del repo.
> 2. **D5 se degradó** por su propio censo (§8): 94 `CITA` previstas pasaron a ser 36
>    `INDECIDIBLE` medidas.
> 3. **D3a/D3b rinden menos de lo previsto** (38 contra 135), y la causa es mecánica y está
>    medida: el contexto que decide suele estar del OTRO LADO de una línea ` *` vacía, que la
>    definición de párrafo (DT-10, punto (b)) corta.

### Los dos defectos que este censo encontró en SU PROPIO instrumento

Los dos producían respuestas **plausibles**, no errores, que es lo que los hace peligrosos.

1. **El path exacto no ganaba.** `mentionCandidates` resolvía `src/index.ts` a **dos** candidatos,
   porque `packages/agent-sdk/src/index.ts` también termina en `/src/index.ts`. Resultado:
   `AMBIGUOUS` sobre un nombre que no tiene nada de ambiguo, y tres citas reales perdidas.
   ⚠️ **Y arreglarlo BAJÓ el recall contra el oráculo, de 17/19 a 12/19.** No es una regresión: el
   defecto estaba *compensando* una limitación de D6. Cinco entradas resolvían bien porque el
   segundo archivo del párrafo se tragaba silenciosamente. **Estaban bien por la razón equivocada**,
   y el 17/19 previo era falso.
2. **El token se ubicaba con `indexOf`.** `classifyBareCite` buscaba el token con
   `linea.indexOf(token)`, que devuelve la primera aparición del *substring*, no la del *token*.
   Medido en `src/lib/url-validator.ts:129`, cuya línea escribe dos direcciones IPv6: el token real
   es el `:1` final (carácter previo `0` ⇒ `RUIDO`), pero `indexOf` caía adentro del `` `::1` ``
   anterior (carácter previo `:`) y el token terminaba clasificado **`CITA` a la línea 1 de su
   propio archivo**. Arreglado agregando la columna real a `FoundCite`.

---

## 7 · La medición honesta: precisión y recall

### 7.1 · Cómo se garantizó que la muestra no fuera la de calibración (AC-2)

**Por orden de commits, no por promesa.** Las 120 etiquetas de
`test/cited-lines-guard.sample.ts` se escribieron en el commit `5c9f383`, y en ese árbol
`classifyBareCite` **no existe**:

```
$ git show 5c9f383:test/cited-lines-guard.scanner.ts | grep -c classifyBareCite
0
$ git show 5c9f383:test/cited-lines-guard.sample.ts | grep -c "    label: "
120
```

> ⚠️ **Lo que este mecanismo NO garantiza**, y decirlo al revés sería prosa que afirma de más: quien
> etiquetó conocía las reglas de la cascada, porque etiquetar exige saber qué es una cita. Eso es
> inevitable. **La independencia es de la MUESTRA y del MOMENTO, no de la mente del que etiqueta.**
> Lo que sí queda cerrado es lo que AC-2 prohíbe: que la muestra sea la misma de la que salieron las
> reglas, y que las etiquetas se ajusten después de ver la salida.

**El marco**, derivado por `sampleFrame()` contra el commit base:

```
1347 sueltos − 195 (los 7 auto-referentes de DT-11) = 1152
1152 − 22 ocurrencias ya etiquetadas a mano en el repo = 1130   (P3 130 · P4 1000)
```

Las 22 son 18 entradas P3/P4 de `CITED_LINES` que caen dentro del perímetro (la 19ª vive en
`CLAUDE.md`, que es raíz) más 4 ocurrencias de `SCANNER_FALSE_POSITIVES` (una entrada `:00` cubre
dos ocurrencias de la misma línea). El Story File estimaba «~25 ⇒ ~1127»; el número exacto es 22.

**El sorteo**: `drawReservedSample()`, Fisher-Yates con `xorshift32` sembrado con `'WKH-371'`,
estratificado **por FORMA** (60 P3 + 60 P4). La forma la produce `scanSource` y **no participa de
ninguna regla de la cascada**, así que estratificar por ella no contamina. Determinismo verificado
re-corriendo el sorteo, no supuesto.

### 7.2 · Los dos estratos, POR SEPARADO (CD-14)

Intervalos de **Wilson al 95 %**. Los números se re-derivan en cada corrida por `G-C17b`.

| Estrato P3 (n=60) | Valor | IC 95 % |
|---|---|---|
| TP / FP / FN | 13 / 1 / 44 | |
| **precisión** | **13/14 = 92,9 %** | **[68,5 % – 98,7 %]** |
| **recall** | **13/57 = 22,8 %** | **[13,8 % – 35,2 %]** |

| Estrato P4 (n=60) | Valor | IC 95 % |
|---|---|---|
| TP / FP / FN | 1 / 0 / 1 | |
| precisión | 1/1 = 100 % | **[20,7 % – 100 %]** — un solo positivo: **no dice nada** |
| **tasa de cita NO detectada** | **1/60 = 1,7 %** | **[0,3 % – 8,9 %]** |

**Qué afirma cada estrato, y nada más:**

- **P3 mide PRECISIÓN.** De cada 100 tokens P3 que el clasificador llama `CITA`, entre 69 y 99
  apuntan al archivo que un humano declaró leyendo el sitio. Con 14 positivos el intervalo es ancho:
  **no se puede afirmar «≥95 %»**, sólo «probablemente por encima de dos tercios».
- **P4 acota el FALSO NEGATIVO.** Es el estrato masivo (1000 de 1130 del marco) y casi vacío de
  citas. Con 1 cita no detectada en 60, la cota superior al 95 % es **8,9 %**, o sea **hasta ~89
  citas P4 que el clasificador no ve**, sobre las 1000 del marco. Ése es el silencio, y es grande.
- **La composición del marco también se midió, y no era la esperada.** El Story File estimaba `CITA`
  en 38 % de P3; en el marco **sin los auto-referentes** resultó **57/60 = 95 %**. La causa: casi
  todo el ruido P3 del repo vive justamente en los archivos del guardián, que están excluidos.

**Agregado ponderado por el marco** (P3 = 130/1130 = 11,5 %, P4 = 1000/1130 = 88,5 %):
**precisión ≈ 95 %, recall ≈ 29 %.** ⚠️ Es una **estimación sobre estimaciones** —pondera las tasas
de cada estrato por su tamaño en el marco, no un conteo— y por eso el número que manda es el de cada
estrato por separado.

### 7.3 · El otro oráculo: las entradas P3/P4 que ya existían en el repo

Las 19 entradas P3/P4 de `CITED_LINES`, etiquetadas a mano entre el 2026-08-19 y el 2026-08-27 en
**otras** HUs. **Recall 12/19 (63 %), y 0 destinos mal resueltos.** Verificado por `G-C17`, que
asserta un **PISO** de 6 y nunca una igualdad: un test que exija «exactamente 12» se pone rojo el día
que alguien escriba una cita nueva, y ese rojo no señalaría nada falso.

**Cero destinos mal resueltos es el invariante DURO** de los dos oráculos y del estrato P4. Un
`INDECIDIBLE` de más pide que alguien mire; un destino inventado pasa los controles.

### 7.4 · Falsos positivos, con su sitio y su motivo

| # | Sitio | Declarado | Resuelto | Regla | Por qué |
|---|---|---|---|---|---|
| FP-1 | `src/services/spend-policy.ownership.test.ts:10` `` `:190` `` | `src/services/spend-policy.ts` | `src/routes/auth/spend-policy.ts` | D3a | El párrafo nombra el path completo de la RUTA (`src/routes/auth/spend-policy.ts:79`) y el del SERVICIO sólo por basename homónimo. La máquina se queda con el que resuelve; el humano sabe cuál es cuál por el resto de la sección |
| FP-2 | `src/lib/capability-risk.ts:85` `` `:77` `` | *(cross-repo)* | `doc/sdd/_INDEX.md` | D3a | El destino real es `wasiai-remittance-agents/src/manifest/registry.ts:77`, que **no está en el índice de este repo**. El párrafo nombra de paso `doc/sdd/_INDEX.md:144`, y ése es el que resuelve |
| FP-3 | `src/lib/capability-risk.ts:100` `` `:300` `` | *(cross-repo)* | `doc/sdd/_INDEX.md` | D3a | Idéntico al anterior, quince líneas más abajo |

FP-2 y FP-3 son **la misma forma de falla** y la más costosa de las tres: no es que el clasificador
elija mal entre dos archivos del repo, es que **afirma un destino local para una cita que apunta
afuera**. Están contados acá y declarados en el docblock de `classifyBareCite`, no escondidos.

### 7.5 · Falsos negativos, con su sitio y su motivo

Los 44 del estrato P3 se agrupan en cuatro formas. Cinco ejemplos abiertos:

| # | Sitio | Declarado | Regla | Por qué se pierde |
|---|---|---|---|---|
| FN-1 | `src/adapters/solana/facilitator-settle.ts:583` `` `:338` `` | `src/index.ts` | D7 | El párrafo nombra `src/index.ts` con path completo **y** un `index.ts` suelto tres líneas después. El homónimo suelto no gana, pero el párrafo tiene dos menciones distintas del mismo archivo y la segunda queda ambigua |
| FN-2 | `src/services/arbiter/evidence.test.ts:14` `` `:57` `` | `src/services/arbiter/evidence.ts` | D6 | La oración lo nombra («los tres `.eq('owner_ref', …)` de `evidence.ts`»), pero la línea siguiente nombra `evidence.ownership.test.ts` ⇒ dos archivos ⇒ ambigüedad |
| FN-3 | `src/services/fee-split.ownership.test.ts:196` `` `:404-407` `` | `src/services/fee-split.ts` | RESIDUO | El párrafo es un comentario de dos líneas encerrado entre líneas de código, y no nombra nada. `:404` ni siquiera cabe en el citador (395 líneas) |
| FN-4 | `src/routes/compose.no-charge-on-validation-error.test.ts:1056` `` `:352` `` | `src/services/compose.ts` | D7 | El contexto es `compose.ts:343`, y `compose.ts` tiene **2 candidatos** (`src/routes/` y `src/services/`). El clasificador se niega a elegir; el humano sabe que `refundComposeStep0` es del servicio |
| FN-5 | `src/services/fee-charge.ts:518` `:419` | `src/services/fee-charge.ts` (auto-cita) | D6 | El párrafo nombra `payment-intent.ts:434-469` y `adapters/errors.ts` de paso, así que la auto-cita nunca llega a evaluarse. **Es el único FN del estrato P4** |

---

## 8 · D5: la regla que su propio censo degradó

D5 era **la auto-cita**: «el párrafo no nombra ningún archivo y el `:N` cae dentro del rango de
líneas del propio citador ⇒ es una cita a sí mismo». Es la única regla que afirma un destino **sin
ninguna evidencia en el párrafo**, así que su verificación no fue un muestreo: fue un **CENSO**.

**El umbral se escribió ANTES de medir** (CD-19): *más de 20 destinos equivocados sobre 94 y D5 se
degrada a `INDECIDIBLE`*. Sin umbral previo, cualquier resultado se narra como éxito.

**Resultado del censo** (`D5_CENSUS`, 36 sitios abiertos y leídos uno por uno, en
`test/cited-lines-guard.exceptions.ts`):

| Veredicto | Sitios |
|---|---|
| `AUTO` — sí apunta a su propio archivo | **19** |
| `OTRO` — apunta a otro archivo | **13** |
| `RUIDO` — no es una cita (un slice de Python, un puerto) | **4** |
| **equivocados** | **17 de 36 = 47 %** |

**Las dos lecturas del umbral, escritas las dos porque elegir la cómoda en silencio es el defecto
que esta HU persigue:**

- **absoluta** («más de 20 FP») → 17 ≤ 20 ⇒ **D5 pasaría**;
- **como tasa** («20 sobre 94» = 21 %) → 47 % ⇒ **D5 NO pasa**.

**Manda la tasa.** El «20» sólo significa algo contra el denominador para el que se escribió, y el
denominador real salió **2,6 veces más chico**. Un umbral absoluto sobre una población que encogió
no es un umbral, es un regalo.

**Lo que la degradación cuesta y lo que compra**, sobre la muestra reservada (estrato P3):

| | precisión | recall |
|---|---|---|
| con D5 | 15/21 = **71 %** | 15/57 |
| sin D5 | 13/14 = **93 %** | 13/57 |

D5 aportaba **2 aciertos y 5 destinos inventados**. Un destino inventado es peor que un
`INDECIDIBLE`: el `INDECIDIBLE` pide que alguien mire, el destino inventado pasa los controles.

> 🔴 **Lo que esta degradación NO refuta**: que la auto-cita sea la forma principal en que este repo
> escribe una cita suelta. **19 de 36 sitios lo son**, y los 5 falsos negativos que el F1 midió
> contra las entradas ya etiquetadas son **5 de 5 auto-citas**. Lo que se midió es que *«el número
> cae dentro del rango de líneas del propio archivo»* **no alcanza para reconocerla**: en un archivo
> de 2000 líneas casi cualquier número cae adentro, así que la condición no discrimina nada.
> Queda abierto como **`TD-371-AUTOCITA`**: hace falta una señal de verdad —proximidad del contexto,
> «este archivo» escrito con todas las letras, o cruzar el `mustContain`— y no una cota que casi
> siempre se cumple.

---

## 9 · Dónde vive cada número

⛔ **Ningún número de este documento se lee de acá para tomar una decisión.** Cada uno se deriva:

| Número | Función que lo deriva | Testigo mecánico |
|---|---|---|
| 611 archivos, 2095 tokens, 1347 sueltos | `scanSource` sobre el índice del commit base | `G-C1`/`G-C2` |
| 1152 (universo del clasificador) | `sampleFrame` + `SELF_REFERENTIAL` | `G-C16` |
| 1130 (marco), el sorteo de 120 | `sampleFrame` / `drawReservedSample` | `G-C17b` |
| 13/14, 13/57, 1/1, 1/60 | `classifyBareCite` sobre `RESERVED_SAMPLE` | **`G-C17b` los RE-DERIVA y los compara contra los publicados acá** |
| recall 12/19 sobre el oráculo | `classifyBareCite` sobre `CITED_LINES` | `G-C17` (piso 6, no igualdad) |
| 19 / 13 / 4 del censo de D5 | `D5_CENSUS`, escrito a mano | `G-C17c` (tasa > 21 % ⇒ D5 sigue degradada) |
| 5 de 1085 artefactos de `doc/` | `grep -rlE …` de §3 | ⛔ ninguno — es una foto |
| 19 archivos de raíz, 37 sueltos | `git ls-tree` + `scanSource` | ⛔ ninguno — es una foto |

**Si un número de acá y su función discrepan, el que tiene razón es la función.** `G-C17b` está
escrito exactamente para que esa discrepancia sea un rojo y no un silencio: si alguien cambia una
etiqueta de la muestra y no re-publica este documento, el gate lo dice con los dos números al lado.
