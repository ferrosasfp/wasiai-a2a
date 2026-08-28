# Censo de citas sueltas — WKH-371

> **Foto del 2026-08-28**, derivada contra el commit base `19405baf7f173033c4ef81dc8380238f1cda73ba`.
> Re-publicada tras el **fix-pack 1** (AR y CR, los dos RECHAZADO).
>
> ⛔ **LA PRIMERA VERSIÓN DE ESTE DOCUMENTO ABRÍA DICIENDO «todos los números se DERIVAN corriendo
> una función nombrada; ninguno está escrito a mano», Y ERA FALSO EN SEIS.** Lo que las dos
> revisiones independientes encontraron es un patrón exacto, y vale más que la lista de arreglos:
>
> > **Todo número con un testigo mecánico que lo RE-DERIVA en la corrida salió exacto.
> > Todo número sin ese testigo salió mal — y los seis, hacia arriba.**
>
> Así que la frase correcta es ésta: **§9 dice, número por número, cuál tiene testigo y cuál es una
> foto.** Los que son foto llevan fecha y no se clavan en ningún test. Si un número con testigo no
> coincide con el árbol de hoy, el que tiene razón es la función; si es una foto, envejeció, y eso
> también es información.

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
  este repo, y hay citas de este repo que apuntan ahí — los dos sitios de `src/lib/capability-risk.ts`
  de §11. ⚠️ **No son falsos positivos**: salen `INDECIDIBLE`, y el modo que ilustran tiene **0
  instancias medidas** sobre los 1152 tokens (§7.4).

---

## 3 · `doc/` se mide y NO se toca

**Medición**: `git ls-tree -r --name-only <base> -- doc | wc -l` → **1097 archivos trackeados**, de
los cuales **1085** son de texto, con **12785** tokens sueltos.

**Cuántos artefactos declaran numerar el ÁRBOL VIVO** (o sea, cuántos podrían pudrirse):

```
/usr/bin/grep -rlE "numeran? el árbol|árbol vivo|árbol PREVIO|numera el árbol" doc/
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/_INDEX-row.md
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/story-file.md
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/work-item.md
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/sdd.md
  doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/censo.md
  doc/sdd/_INDEX.md
```

**6 de 1085**, y **CINCO de los seis son artefactos de ESTA HU**. El sexto es `doc/sdd/_INDEX.md`.
⇒ `doc/` es **histórico prácticamente en su totalidad**, y sus 12785 tokens describen árboles
pasados: re-anclarlos sería falsificar el registro.

> ⚠️ **Este número envejeció DOS veces, y la segunda la causó este mismo documento.** El SDD midió
> **3 de ~1095**; la primera versión de este censo publicó **5 de 1085** y su propio `grep` ya
> devolvía **6** — el sexto es **este archivo**, que pasó a contener las palabras que el `grep`
> busca en el momento en que se escribió el renglón. Es literalmente el defecto de la HU cometido
> por la HU: **medir un conjunto al que el acto de medir te agrega**. Es la razón por la que este
> número lleva fecha y commit, y por la que **no se clava en ningún test**.

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

> ⚠️ **El 25 de `DATO` es un conteo exacto de lo que D2 dispara, y NO mide lo que la definición
> publicada decía.** Los 25 se abrieron uno por uno: los 25 son valores dentro de un literal JSON o
> de un string de shell, y ninguno es «la cita de otro archivo transcripta como dato». La definición
> se ensanchó a lo que la regla hace, la clase **solapa con `RUIDO`**, y **la precisión publicada en
> §7 es la de la clase `CITA` y sólo ésa**. El desarrollo está en §7.2, con la matriz 4×4.

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
   ⚠️ **Y arreglarlo BAJÓ el recall contra el oráculo.** No es una regresión: el defecto estaba
   *compensando* una limitación de D6. Algunas entradas resolvían bien porque el segundo archivo del
   párrafo se tragaba silenciosamente. **Estaban bien por la razón equivocada.**
   🔴 **La cifra «17/19 → 12/19» NO REPRODUCE, y va corregida.** El AR reconstruyó el árbol
   pre-arreglo y no le dio; se re-midió acá con el mutante «revertir `if (tracked.has(raw)) return
   [raw];`» sobre el árbol entregado:

   ```
   con el arreglo (árbol entregado) : bare=19  CITA=6  TP=6  INVENTADOS=0
   sin el arreglo (revertido)       : bare=19  CITA=6  TP=5  INVENTADOS=1
       src/lib/operator-address.ts `:1-16`  decl=src/adapters/registry.ts  res=src/routes/agents.ts
   ```

   **El 17/19 y el 12/19 son de un estado intermedio del árbol que ya no existe** (entre otras
   cosas, D5 todavía estaba encendida). Lo que se conserva —y es lo que vale— es la DIRECCIÓN, ahora
   medida sobre el árbol de hoy: **revertir el arreglo no sube el recall, y fabrica un destino
   INVENTADO**. El arreglo mejora y no hay que revertirlo. La lección del auto-blindaje («cuando una
   métrica empeora al arreglar un bug, preguntá qué otro defecto estaba compensando») se sostiene
   entera; **el número que la ilustraba, no**.
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

#### La matriz 4×4, y las 6 discrepancias que el scoring binario esconde

El scoring de `G-C17b` es **binario** (`pred = label === 'CITA'`), así que colapsa las otras tres
clases: `RUIDO`, `DATO` e `INDECIDIBLE` son «no-CITA» y da lo mismo cuál salga. Los datos para
distinguirlas siempre estuvieron; lo que faltaba era dejar de colapsarlos. Re-derivada sobre los
mismos 120 sitios:

| humano ＼ máquina | `CITA` | `RUIDO` | `DATO` | `INDECIDIBLE` | total |
|---|---|---|---|---|---|
| **`CITA`** | **15** | 0 | 0 | 44 | 59 |
| **`RUIDO`** | 0 | **53** | 4 | 2 | 59 |
| **`DATO`** | 0 | 0 | **0** | 0 | **0** |
| **`INDECIDIBLE`** | 0 | 0 | 0 | **2** | 2 |
| total | 15 | 53 | 4 | 48 | **120** |

**Lo que la matriz dice y el binario no:**

- 🔴 **La clase `DATO` acierta 0 de 4, y en el perímetro entero acierta 0 de 25.** Los 4 sitios donde
  la regla D2 dispara están etiquetados **`RUIDO`** por el humano. Y abierto el censo completo de los
  25 `DATO` del perímetro, uno por uno: **los 25 son valores dentro de un literal JSON o de un string
  de shell** (`'{"a":2,"z":1}'`, `'{"selfHostCount":1,…}'`, `-d '{"goal":"test",…}'`). **Ninguno es
  la cita de otro archivo**, que es lo que la definición publicada decía.
- **La causa es una definición más angosta que la regla.** `BareLabel` definía `DATO` como *«el VALOR
  de un campo `cite:` / `quote:` de un registro, o sea la cita de OTRO archivo transcripta como
  dato»*; D2 dispara con *«el carácter anterior al `:` es una comilla»*. La segunda es mucho más
  ancha que la primera.
- **Se eligió ENSANCHAR LA DEFINICIÓN, no angostar la regla, y el motivo va escrito**: distinguir
  «literal de string» de «campo `cite:` de un registro» exige mirar el nombre de la clave, o sea una
  heurística nueva sobre el texto — la misma clase de invención que esta cascada existe para no
  hacer. La definición nueva vive en el docblock de `BareLabel` y dice lo que D2 hace: *el token está
  dentro de un literal de string*.
- ⛔ **Consecuencia, y es lo que limita lo que este censo puede afirmar: `DATO` SOLAPA con `RUIDO`.**
  Un `:1` dentro de `'{"a":1}'` es las dos cosas, y sale `DATO` sólo porque D2 evalúa primero. Las
  dos etiquetas son defendibles sobre el mismo token, y el humano no se equivocó al poner `RUIDO`.
- ⛔ **Por eso la precisión y el recall publicados son los de la clase `CITA`, y sólo ésa.** Las otras
  tres **no se midieron**: las 6 discrepancias de la fila `RUIDO` (4 → `DATO`, 2 → `INDECIDIBLE`) no
  aparecen en ningún número de §7.2, y con el scoring binario no podían aparecer.
- **Lo que la matriz confirma, y es lo que importa para el money-path del guardián**: la columna
  `CITA` tiene **15 y sólo 15**, todos con etiqueta humana `CITA`. **Cero tokens que un humano llamó
  `RUIDO` o `DATO` salieron `CITA`.** El error del clasificador es de SILENCIO (44 `INDECIDIBLE` que
  eran citas), no de invención.

**Agregado ponderado por el marco** (P3 = 130/1130 = 11,5 %, P4 = 1000/1130 = 88,5 %):
**precisión ≈ 95 %, recall ≈ 29 %.** ⚠️ Es una **estimación sobre estimaciones** —pondera las tasas
de cada estrato por su tamaño en el marco, no un conteo— y por eso el número que manda es el de cada
estrato por separado.

### 7.3 · El otro oráculo: las entradas P3/P4 que ya existían en el repo

Las 19 entradas P3/P4 de `CITED_LINES`, etiquetadas a mano entre el 2026-08-19 y el 2026-08-27 en
**otras** HUs. **Recall 6/19 (32 %), y 0 destinos mal resueltos.**

```
ORACLE bare=19   CITA=6   TP=6   MISMATCH=0
```

> 🔴 **ACÁ DECÍA «12/19 (63 %)», Y ERA EL DOBLE DEL MEDIDO.** Lo encontraron el AR y el CR, cada uno
> por su lado, re-derivándolo con el bucle literal de `G-C17`. **El 12 es el número CON D5
> ENCENDIDA** —verificado mutando la cascada para que D5 vuelva a emitir `CITA`: da exactamente 12—,
> y D5 se degradó (§8) **en el mismo commit que introdujo este censo**. O sea que la cifra **nació
> vieja**: se midió antes de la degradación y nunca se re-derivó después. De las 19, **6 caen en
> D5**, y ésas son exactamente las que se perdieron: 12 − 6 = 6.
> **La lección, que es la de esta HU entera**: un número medido sobre un árbol que cambia en el
> mismo commit no es una medición, es un recuerdo. El único antídoto es re-derivarlo en la corrida
> que lo publica, que es lo que `G-C17b` hace con los números de §7.2 y lo que este renglón no tenía.

**El desglose de las 19, re-derivado** (`CITA` 6 · `INDECIDIBLE` 13):

| Regla | Entradas | Clase | Cuáles |
|---|---|---|---|
| D3a | **4** | `CITA` | `src/types/index.ts:207` · `src/lib/operator-address.ts:19` y `:20` · `CLAUDE.md:265` |
| D3b | **2** | `CITA` | las dos de `test/payment-guards-live-in-one-place.test.ts` (`:17`, `:18`) |
| D6 | **6** | `INDECIDIBLE` | las 5 de `src/routes/agents.publish.test.ts` + `src/lib/operator-address.ts:14` |
| D5 | **6** | `INDECIDIBLE` | `types/index.ts:288` · `compose.ts:751` · `agents.ownership.test.ts:13` ×2 · `fee-split.ts:494` ×2 |
| D7 | **1** | `INDECIDIBLE` | `src/routes/agents.ownership.test.ts:25` |
| | **19** | **6 `CITA` + 13 `INDECIDIBLE`** | |

**Las 6 de D5 son literalmente la diferencia entre el 12 publicado y el 6 medido.**

**El piso del guard, y por qué se BAJÓ en vez de subirlo:** `G-C17` y `G-C18` asserteaban `>= 6`,
o sea **exactamente el valor medido**, con un comentario al lado prometiendo margen. **Margen cero**:
una sola cita que dejara de resolver ponía el gate rojo sin que nada estuviera mal — un candado que
se pudre solo, con la etiqueta de que no se pudre.

**El piso nuevo es 2, y el número salió de medir, no de elegir.** El primer intento fue 4, y un
mutante lo tumbó:

| | |
|---|---|
| los 6 aciertos salen de **4 párrafos**, no de 6 | `types/index.ts` 1 · `operator-address.ts` **2** · `payment-guards-live-in-one-place.test.ts` **2** · `CLAUDE.md` 1 |
| el clasificador decide **por párrafo** | ⇒ una edición de prosa cuesta hasta **2**, no 1 |
| medido | agregando `src/services/budget.ts` al párrafo de `operator-address.ts` —una mención de paso, de las que cualquier HU escribe— el recall cae **de 6 a 4 de una sola vez** |
| ⇒ | con piso 4 el margen volvía a ser **cero**. Dos ediciones así cuestan 4, así que el piso tiene que aguantar 6 − 4 = **2** |

Y sigue siendo un control real: el modo de falla que importa —que el clasificador deje de
resolver— lleva el número a **0 ó 1**. ⚠️ Lo que un piso de 2 **no** detecta es una degradación
parcial, y eso es a propósito: una degradación parcial es indistinguible de una edición de prosa
legítima, que es justamente lo que pudre los candados.
⛔ **No se subió el piso para que el 12 diera.** El árbol no se ajusta al documento.

**Cero destinos mal resueltos es el invariante DURO** de los dos oráculos y del estrato P4. Un
`INDECIDIBLE` de más pide que alguien mire; un destino inventado pasa los controles. **Ése sí es un
`toEqual([])`, no un piso**, y no se movió.

### 7.4 · Falsos positivos: **hay UNO, y AC-1 pedía tres**

> 🔴 **ACÁ HABÍA TRES, Y DOS NO EXISTEN.** Los encontraron el AR y el CR por separado,
> re-derivándolos: los sitios publicados como `FP-2` y `FP-3` dan **`INDECIDIBLE [D6]`** e
> **`INDECIDIBLE [RESIDUO]`**, y la muestra reservada los etiqueta **`INDECIDIBLE` a mano** ⇒
> predicción = etiqueta ⇒ **son ACIERTOS**. Ni siquiera compartían regla, contra lo que este
> documento afirmaba. La contradicción estaba a la vista y con testigo mecánico propio:
> `test/cited-lines-guard.test.ts` asserta `{P3:{tp:13, fp:1, fn:44}, P4:{tp:1, fp:0, fn:1}}` y la
> suite pasa desde el primer día. **Todo número de este censo con testigo mecánico es exacto; los
> que fallaron son los que no lo tenían.**

**El único falso positivo medido sobre los 120 sitios de la muestra:**

| # | Sitio | Declarado a mano | Resuelto | Regla | Por qué |
|---|---|---|---|---|---|
| FP-1 | `src/services/spend-policy.ownership.test.ts:10` `` `:190` `` | `src/services/spend-policy.ts` | `src/routes/auth/spend-policy.ts` | D3a | El párrafo nombra el path completo de la RUTA (`src/routes/auth/spend-policy.ts:79`) y el del SERVICIO sólo por basename homónimo. La máquina se queda con el que resuelve; el humano sabe cuál es cuál por el resto de la sección |

**Y AC-1 pide ≥3 falsos positivos citados. Se cumple UNO. Se declara que no se cumple**, en vez de
buscar dos más hasta llegar al número: un FP inventado para llegar a 3 es la misma clase de defecto
que un destino inventado. El denominador dice por qué: sobre 120 sitios etiquetados, el clasificador
emite `CITA` **15 veces** y se equivoca **1**; no hay tres errores que citar porque no los hay.

#### El modo cross-repo: **previsto, con 0 instancias medidas**

Los ex-`FP-2` y `FP-3` ilustraban un modo real: un `:N` cuyo destino vive en
`wasiai-remittance-agents`, y un párrafo que nombra además algún archivo de acá ⇒ D3a devuelve el
LOCAL, o sea **afirma un destino local para una cita que apunta afuera**. Que el modo sea plausible
no lo vuelve observado, así que se barrió el perímetro entero:

```
universo (1152 tokens sueltos, sin los 8 auto-referentes, al commit base)
tokens con un repo ajeno nombrado en su párrafo : 13
de ésos, con veredicto CITA                     : 0
    RUIDO [D1] 6 · DATO [D2] 3 · INDECIDIBLE [D6] 2 · INDECIDIBLE [RESIDUO] 2
```

**0 de 1152.** Lo que protege a los dos sitios de `capability-risk.ts` es que sus párrafos nombran
**dos** archivos locales, no uno: D6 dispara antes que D3a. ⇒ **Queda declarado como modo previsto
sin instancia medida**, no como falso positivo, en este censo y en el docblock de
`classifyBareCite`. Es una salida legítima; publicarlo como medición no lo era.

⚠️ **Y las dos ediciones de `src/lib/capability-risk.ts` (§11) se mantienen, con OTRA
justificación.** Los cambios son correctos —escribir el path cross-repo completo hace la cita
verificable por un humano y saca el token del barrido suelto— pero **su motivo escrito no era
cierto**: no arreglaban un falso positivo medido. Ver la columna «Justificación» de §11, corregida.

### 7.5 · Falsos negativos, con su sitio y su motivo

Son **45**: los 44 del estrato P3 más el único de P4. Se agrupan en cuatro formas, y el reparto por
regla se re-deriva en la corrida: **D6 21 · D7 9 · D5 7 · RESIDUO 7 · D3a 1** (el `D3a` es `FP-1`,
que cuenta a la vez como falso positivo y como falso negativo porque acertó el archivo equivocado).
Cinco ejemplos abiertos:

> 🔴 **EL EX-`FN-1` NO ERA UN FALSO NEGATIVO: ERA UN ACIERTO.** Decía
> «`src/adapters/solana/facilitator-settle.ts:583` `` `:338` `` → D7». Re-derivado al commit base da
> **`CITA [D3b] target=src/index.ts`**, y la muestra lo etiqueta `CITA` con ese mismo target ⇒ **true
> positive**. Describía el estado **ANTERIOR** al arreglo «el path exacto gana» (§6, defecto 1) —
> literalmente el sitio que ese arreglo recuperó—, y esta tabla no se re-derivó después del arreglo.
> **Es el mismo modo de falla que el 12/19: una foto tomada antes de un cambio del mismo commit.**
> Se reemplaza por uno de los 45 reales.

| # | Sitio | Declarado | Regla | Por qué se pierde |
|---|---|---|---|---|
| FN-1 | `src/adapters/solana/facilitator-settle.ts:416` `` `:360` `` | `src/adapters/solana/facilitator-settle.ts` (auto-cita) | D5 | El párrafo es un comentario de bloque que explica «forma que no entiendo ⟹ `unaskable`» y cita **dos** líneas del propio archivo (`` `:360` `` y `` `:372` ``) sin nombrar ningún archivo. Sin nadie nombrado, la cascada llega a D5 — y D5 está degradada, así que la auto-cita se pierde. **Es exactamente lo que la degradación cuesta**, y por eso el ejemplo va acá y no en una nota al pie |
| FN-2 | `src/services/arbiter/evidence.test.ts:14` `` `:57` `` | `src/services/arbiter/evidence.ts` | D6 | La oración lo nombra («los tres `.eq('owner_ref', …)` de `evidence.ts`»), pero la línea siguiente nombra `evidence.ownership.test.ts` ⇒ dos archivos ⇒ ambigüedad |
| FN-3 | `src/services/fee-split.ownership.test.ts:196` `` `:404-407` `` | `src/services/fee-split.ts` | RESIDUO | El párrafo es un comentario de dos líneas encerrado entre líneas de código, y no nombra nada. `:404` ni siquiera cabe en el citador: **395 líneas** por `wc -l`, **396** por `split('\n').length`, que es lo que mira D5 — y `404` no entra en ninguna de las dos (el AR leyó 396 y tenía razón sobre su instrumento; el número de acá lleva ahora los dos) |
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

> 🔴 **ESTA TABLA MENTÍA EN 3 DE 7 FILAS, y el patrón es exacto: TODO número de este censo con
> testigo mecánico real salió exacto en las dos re-derivaciones independientes; TODO número cuyo
> «testigo» era un guard que no lo calcula, salió mal.** Los 6 números que fallaron (§7.3, §7.4,
> §7.5, §10.2, §11, §12) están todos en filas de acá que nombraban un testigo equivocado o
> declaraban «ninguno». Corregida, con la columna diciendo qué calcula cada guard **y qué no**.

| Número | Función que lo deriva | Testigo mecánico |
|---|---|---|
| 611 archivos, 2095 tokens, 1347 sueltos | `scanSource` sobre el índice del commit base | `G-C1`/`G-C2` |
| 1152 (universo del clasificador) | `scanSource` + `SELF_REFERENTIAL` | ⚠️ **parcial**: `G-C16` asserta que los 8 están DECLARADOS y son disjuntos del Corte A, **no** re-deriva el 1152 |
| 1130 (marco) = P3 130 + P4 1000 | `sampleFrame` contra el commit base | ⚠️ **piso**: `G-C17d` re-deriva el marco y verifica `>= 60` por estrato; el 1130 exacto es una foto |
| los 120 sitios sorteados | `drawReservedSample(frame, 'WKH-371')` | ✅ **`G-C17d`** — re-corre el sorteo y compara los 120 `siteKey` contra `RESERVED_SAMPLE`, en las dos direcciones |
| 13/14, 13/57, 1/1, 1/60 | `classifyBareCite` sobre `RESERVED_SAMPLE` | ✅ **`G-C17b` los RE-DERIVA y los compara contra los publicados acá** |
| la matriz 4×4 de §7.2 y el censo de los 25 `DATO` | `classifyBareCite` sobre `RESERVED_SAMPLE` y sobre el perímetro | ⛔ **ninguno** — el scoring de `G-C17b` es binario y colapsa las 3 clases no-`CITA` |
| recall **6/19** sobre el oráculo | `classifyBareCite` sobre `CITED_LINES` | ⚠️ **piso 2**, no igualdad: `G-C17` se pone rojo si cae de 2, **no** si el 6 cambia a 5 ó 7 |
| 6 de 19 con testigo (§10.2) | ídem, desde `G-C18` | ⚠️ **piso 2**, misma limitación |
| 0 destinos mal resueltos | `classifyBareCite` sobre `CITED_LINES` | ✅ **`G-C17`** — `toEqual([])`, igualdad dura, no piso |
| 19 / 13 / 4 del censo de D5 | `D5_CENSUS`, escrito a mano | ✅ **`G-C17c`** — tasa > 21 % ⇒ D5 sigue degradada, **y los 36 sitios salen `INDECIDIBLE`** |
| **6 de 1085** artefactos de `doc/` | `grep -rlE …` de §3 | ⛔ ninguno — es una foto, y ya envejeció una vez (§3) |
| 19 archivos de raíz, 37 sueltos | `git ls-tree` + `scanSource` | ⛔ ninguno — es una foto |
| 752 tokens en los 5 archivos del guardián | `scanSource` sobre ellos mismos | ⛔ ninguno — es una foto, y es el ítem 14 del docblock, que existe para denunciar eso |
| los 5 archivos del guardián typechequean | `tsc -p tsconfig.guards.json` | ✅ **`G-C19`** — corre el compilador y exige exit 0 |

**Si un número de acá y su función discrepan, el que tiene razón es la función.** `G-C17b` está
escrito exactamente para que esa discrepancia sea un rojo y no un silencio: si alguien cambia una
etiqueta de la muestra y no re-publica este documento, el gate lo dice con los dos números al lado.

⚠️ **Y lo que un PISO no dice**: `G-C17` con piso 2 y medición 6 no se pone rojo si el 6 pasa a 5.
Eso es a propósito —un candado clavado sobre el valor medido se pudre solo—, pero significa que el
«6/19» publicado **no tiene un candado de igualdad**. Si alguien lo necesita exacto, lo re-deriva.

---

## 10 · El cruce mecánico que HOY NO EXISTÍA (`G-C18`)

### 10.1 · La vacuidad, demostrada ANTES de arreglarla

`citeMatchesTarget` abre con `if (raw === null) return true`, y `citePathOf` devuelve `null` para
**todo** token P3/P4. Medido sobre el árbol, antes de escribir una línea del control:

```
citeMatchesTarget('src/lib/operator-address.ts', '`:95`', 'src/no/existe/ninguno.ts')  -> true
citeMatchesTarget('src/lib/operator-address.ts', '`:95`', 'CLAUDE.md')                 -> true
citeMatchesTarget('src/lib/operator-address.ts', '`:95`', 'package.json')              -> true
citePathOf('`:95`') -> null      citePathOf(':634') -> null

entradas de CITED_LINES cuyo token NO nombra archivo: 19
para las 19, citeMatchesTarget(from, cite, 'CUALQUIER/COSA.ts') === true : true
```

⇒ **`E-CITE_TARGET_MISMATCH` no podía dispararse jamás para ninguna de las 19.**

> ⚠️ Eso **no** quiere decir que esas entradas no tuvieran ningún testigo, y decirlo al revés sería
> afirmar de más: `G-C5` ya cruza `mustContain` contra `target:line` y `G-C6` cruza `symbolPath`. Lo
> que faltaba es lo que `G-C18` agrega: cruzar el token contra **el contexto en que está escrito**.

### 10.2 · Lo que el control compra, re-derivado

**6 de las 19** entradas P3/P4 pasan a tener testigo mecánico, y **las 6 coinciden** con lo que el
humano declaró ⇒ el control **nace verde por MEDICIÓN, no por construcción**. Las otras 13 salen
`INDECIDIBLE` y siguen rigiendo por su `targetReason` escrito a mano, como hasta hoy.
**Costo: cero declaraciones nuevas.** No se amplió `CORTE_A_PATHS` (sigue en 14) ni `CITED_LINES`.

> 🔴 **ACÁ DECÍA «12 de las 19», y es el mismo número viejo de §7.3**: el 12 es con D5 encendida, y
> D5 se degradó en el mismo commit. Son **6**, y son las mismas 6 del oráculo — no es casualidad,
> las dos secciones corren el mismo bucle sobre la misma lista.
>
> El Story File preveía 16 de 19. Son 6, y la causa es la degradación de D5 (§8): de las 13 que
> faltan, **6 son auto-citas** que D5 resolvía y que ahora salen `INDECIDIBLE`, 6 son D6 y 1 es D7.

`G-C18` asserta un **PISO de 2** con la medición en **6**, no una igualdad, por la misma razón que
`G-C17`: cuántas llegan a tener testigo depende de cómo esté escrita la prosa de cada citador, y eso
cambia con cada HU. El piso era 6 —clavado sobre el valor medido, margen cero— hasta el fix-pack 1.

### 10.3 · El mutante — y el que habría sido un FALSO KILLED

⛔ **El mutante obvio no sirve.** Cambiarle el `target` a una entrada P3/P4 pone el gate rojo hoy,
pero por `G-C5`. Se verificó corriéndolo: mutar `line: 634` → `line: 640` en la entrada de
`compose.ts` da

```
× G-C5: el ancla citada sigue ahí, es única, y el archivo citado es el correcto
  src/services/compose.ts :: :634
      E-LINE_MOVED · se corrió el archivo: tu ancla está ahora en
      `src/services/compose.ts:634` y la cita dice `:640`.
```

…y **`G-C18` queda VERDE**. Ese mutante muere sin ejercitar el control nuevo: quien lo usara
concluiría que `G-C18` funciona cuando podría estar vacuo.

**El mutante correcto muta el PÁRRAFO DEL CITADOR**, dejando `target`, `line`, `mustContain` y
`symbolPath` intactos. En `src/services/compose.ts:750`, `middleware` → `chain-resolver.ts` (un
basename con **exactamente 1** candidato en el índice — con `agent.ts`, `registry.ts` o `compose.ts`,
que tienen 2, el resultado sería `AMBIGUOUS` y **no habría rojo**):

```
× G-C18: el cruce mecánico de los `:N` SUELTOS contra el `target` declarado
E-BARE_TARGET_MISMATCH  src/services/compose.ts:751 :634
    target declarado a mano : src/services/compose.ts
    destino del contexto    : src/adapters/chain-resolver.ts
    D3b: el párrafo nombra un solo archivo trackeado, sin número de línea:
         `src/adapters/chain-resolver.ts`.
```

**Y `G-C4`, `G-C5`, `G-C6` y `G-C7` quedaron VERDES**, que es lo que prueba que el rojo es del
control nuevo y no de un vecino. `tsc` y `lint` exit 0 (es un comentario, no cambia el formato ni el
número de líneas). Control positivo verde antes (`6358 passed`) y después (`6358 passed`);
restauración por `cp` desde backup, `sha256` idéntico
(`637b52a54127e87b75f02fbe3d2b0d85e109ee0f3130afb4c20aa0486cecd798`) y `/usr/bin/diff` sin
diferencias.

---

## 11 · Las correcciones (commit aparte), y su PROCEDENCIA

⛔ Van en un commit distinto del instrumento (CD-2 / AC-9). Mezclar deuda vieja y arreglo nuevo en
el mismo commit hace imposible saber cuál era cuál, y **atribuirle al trabajo de hoy un daño
preexistente apaga la búsqueda de la causa real**.

**Cinco tokens convertidos, 100 % comentario, sin re-envolver ningún párrafo y sin cambiar el número
de líneas de ningún archivo.** Son exactamente los tres falsos positivos de §7.4 más la única
contradicción numérica que el censo encontró.

### Procedencia, derivada del árbol base y no de la memoria

```
git show 19405ba:<archivo> | sed -n '<N>p'
```

Los cinco sitios salen **byte-idénticos** al commit base ⇒ **los cinco son deuda PREEXISTENTE**.
Ninguno lo produjo el trabajo de esta HU.

### Qué se cambió y por qué

| Sitio | Antes | Después | Opción | Justificación |
|---|---|---|---|---|
| `src/lib/capability-risk.ts:85` | `` `:77` ``, `` `:71-75` `` | path cross-repo completo | **A** | 🔴 **JUSTIFICACIÓN CORREGIDA.** Decía que el clasificador los resolvía a `doc/sdd/_INDEX.md`, y **eso no reproduce**: salen `INDECIDIBLE [D6]`, porque el párrafo nombra DOS archivos locales y D6 evalúa antes que D3a. El motivo verdadero es otro y sigue siendo bueno: el destino vive en `wasiai-remittance-agents`, que aporta **0** archivos al índice de este repo, así que sueltos esos tokens **no los puede verificar nadie, ni a mano ni a máquina**. Escritos completos, un humano los puede abrir en el otro repo. Lo que el cambio NO hace es arreglar un falso positivo medido: no había ninguno (§7.4) |
| `src/lib/capability-risk.ts:100` | `` `:300` `` | ídem | **A** | Idéntico, y con la **misma corrección**: salía `INDECIDIBLE [RESIDUO]`, no `CITA` |
| `src/services/spend-policy.ownership.test.ts:10` | `` `:190` ``, `spend-policy.ts:163` | `src/services/spend-policy.ts:163` y `:190` completos | **A** | `spend-policy.ts` tiene **2** candidatos (`src/routes/auth/` y `src/services/`). El párrafo nombraba el path completo de la RUTA y el del SERVICIO sólo por basename, así que el token resolvía al archivo equivocado. ✅ **Éste sí reproduce**: es `FP-1`, el único falso positivo medido de la HU. ⚠️ La edición además **borró la cláusula «y el caller no elige la key»** del encabezado de la sección, cosa que esta tabla no declaraba; **restaurada en el fix-pack 1**, con el archivo en las mismas 188 líneas |
| `src/services/fee-settle-broadcast-evidence.hu201.test.ts:355` | `(:316)` | `` (`fee-split.ts:316`) `` | **A** | `settleFeeSplits` vive en `fee-split.ts`; sueltos, los dos tokens se leían como auto-citas al archivo de test |
| `src/services/fee-settle-broadcast-evidence.hu201.test.ts:356` | `` de :335 `` | `` de `fee-split.ts:336` `` | **A** + corrección | 🔴 **El número estaba mal.** Abierto el destino (CD-6): `fee-split.ts:336` es `const priorTx = chargeable.find(…)`; `:335` es el `if (inProgress)`. Y el propio `fee-split.ts:494` escribe `:336` para la misma cosa ⇒ **dos archivos declaraban números distintos del mismo sitio, y nada los cruzaba** |

⛔ **No se aplicó la opción (C)** —borrarle el número a la oración— en ningún sitio: en los cinco, la
oración **usa** el número.

### El efecto, re-derivado sobre el árbol vivo (AC-7, CD-10)

| Archivo | Sueltos antes (commit base) | Sueltos después (árbol vivo) | Clases después | Falsos positivos después |
|---|---|---|---|---|
| `src/lib/capability-risk.ts` | **4** | **1** | 1 `INDECIDIBLE` [D5] (`:162` `` `:176-178` ``) | **0** |
| `src/services/spend-policy.ownership.test.ts` | 14 | **13** | 9 `INDECIDIBLE` [D6] + **4 `RUIDO`** [D1] (los `:00` de dos timestamps) | **0** |
| `src/services/fee-settle-broadcast-evidence.hu201.test.ts` | 2 | **0** | — | **0** |

> 🔴 **ESTA TABLA TENÍA DOS NÚMEROS MAL, y los dos hacia el lado cómodo.** Decía «3 sueltos antes»
> en `capability-risk.ts` cuando son **4**, y «13, todos `INDECIDIBLE`» cuando son **9
> `INDECIDIBLE` + 4 `RUIDO`**. Re-derivada corriendo `scanSource` + `classifyBareCite` contra el
> commit base (antes) y contra el disco (después).

**El único falso positivo medido (`FP-1`, §7.4) ya no existe en el árbol vivo.** Los otros dos que
esta sección decía haber arreglado **no eran falsos positivos**: eran aciertos, y las ediciones se
mantienen por el motivo corregido de la tabla de arriba.

> ⚠️ **Y los números de §7 NO cambian, a propósito.** La muestra reservada se mide contra el
> **commit base** (`G-C17b` lee los fuentes con `git show`), así que `13/14` y `13/57` siguen
> describiendo el árbol sobre el que se sorteó. Es lo que hace que ese control no sea un candado que
> se pudre solo — y también lo que impide «mejorar» la precisión publicada arreglando justo los
> sitios que la muestra mira. Los arreglos mejoran el ÁRBOL; la MEDICIÓN queda como fue.

### Lo que NO se tocó

- ⛔ `doc/` fuera de `doc/sdd/232-*`: **12785 tokens sueltos, medidos y no re-anclados.** Son
  registro histórico (§3).
- ⛔ Los 8 archivos auto-referentes: `TD-224-CITAS-DEL-PROPIO-GUARDIAN` **se declara con su número
  (195), no se cierra**.
- ⛔ Los 136 `INDECIDIBLE` restantes del perímetro. Son silencio declarado, no afirmaciones falsas:
  arreglarlos es otra HU, y el criterio para priorizarla está en `TD-371-AUTOCITA` (§8).
- ⛔ Ninguna línea de código ejecutable. El diff de `src/` es **100 % comentario**, verificado línea
  por línea con `git diff -U0`.

---

## 12 · Escala del diff, contrastada contra el presupuesto (regla 10 de `CLAUDE.md`)

> 🔴 **ESTA SECCIÓN SE MEDÍA A SÍ MISMA EXCLUYÉNDOSE, Y CON DOS INSTRUMENTOS.** El total publicado
> (3249) era el `numstat` del **commit ANTERIOR** —o sea sin la propia §12 ni `auto-blindaje.md`—, y
> las filas salían de un `grep '^+[^+]'`, **que no cuenta las líneas en blanco**. Por eso la tabla
> **no sumaba su propio total** y nadie lo notó: nadie suma una tabla. Re-medida acá **con un solo
> instrumento** (`git diff --numstat 19405ba`) y **en la última pasada**, después de todas las
> ediciones del fix-pack 1.

⚠️ **Y necesitó TRES pasadas, porque escribir la sección la mueve.** La primera dio
`censo.md 819 · total 4199`; la segunda `841 · 4221`; la cuarta y última, `859 · 4239`.
La última sólo cambió DÍGITOS —ninguna línea nueva— y por eso cerró. **Ése es el procedimiento para
cualquier métrica autorreferente: escribir, re-medir, y corregir sólo dígitos hasta que el número
deje de moverse.** Si la corrección agrega una línea, no cerró.

**Presupuesto del Story File: ≤ 2080 líneas.**

| Archivo | Presupuesto | Inserciones | Borrados | Factor | De las cuales |
|---|---|---|---|---|---|
| `test/cited-lines-guard.sample.ts` (nuevo) | ≤ 780 | **1450** | 0 | 1,86× | **1158 son DATOS a mano** — del `export const RESERVED_SAMPLE` a su `];` |
| `test/cited-lines-guard.test.ts` | ≤ 280 | **782** | 28 | **2,79×** | 10 controles nuevos (`G-C13`…`G-C19`) + los ítems 14 y 15 de no-cobertura |
| `test/cited-lines-guard.scanner.ts` | ≤ 200 | **470** | 0 | **2,35×** | la cascada + su docblock de medición |
| `test/cited-lines-guard.exceptions.ts` | ≤ 120 | **323** | 0 | **2,69×** | **267 son DATOS a mano** — el `D5_CENSUS`, sus 36 sitios con veredicto y motivo |
| `doc/sdd/232-…/censo.md` (nuevo) | ≤ 420 | **859** | 0 | 2,05× | — |
| `doc/sdd/232-…/auto-blindaje.md` (nuevo) | — | **297** | 0 | — | 16 entradas, 7 de ellas del fix-pack 1 |
| `tsconfig.guards.json` (nuevo) | — | **53** | 0 | — | §13; 39 de las 53 son el docblock que dice qué mide y qué no |
| `src/` (comentarios) | ≤ 120 | **5** | 5 | 0,04× | 100 % comentario |
| **TOTAL del trabajo de la HU** | **≤ 2080** | **4239** | **33** | **🔴 2,04×** | |
| + `ar-report.md` y `cr-report.md` (de los revisores) | — | 335 | 0 | — | |
| **TOTAL de la rama** | | **4574** | **33** | 2,20× | |

### 🔴 El factor pasó el 2×, así que la regla 10 obliga: justificar por escrito o recortar

**Se justifica, y el desglose dice exactamente dónde está el exceso.** El F3 original cerró en
**1,81×** re-medido (publicaba 1,56×, con el instrumento equivocado); el fix-pack 1 agregó **931
líneas** y lo empujó a **2,04×**. Las tres
piezas del exceso, con su tamaño:

1. **Los datos etiquetados a mano: 1425 líneas** (1158 de la muestra + 267 del censo de D5).
   **No son implementación: SON la medición.** Un clasificador sin ellas es exactamente el 100 % de
   precisión del F1, que se medía contra el archivo del que había sacado sus reglas. No hay forma de
   abreviarlas sin destruir AC-2 y CD-19. **Son el 34 % del total y el 71 % de lo que excede el
   presupuesto.**
2. **La prosa de medición: los docblocks del escáner y los ítems 14/15 del guardián.** También es
   medición —la degradación de D5 con sus dos lecturas del umbral, los dos defectos del propio
   instrumento, la matriz 4×4, lo que la cascada NO decide—. Borrarla dejaría un clasificador que
   **parece más seguro de lo que es**, que es el modo de falla que esta HU existe para no cometer.
3. **Lo que agregó el fix-pack 1, y es el bloque que hay que mirar con más desconfianza porque es el
   más nuevo**: 931 inserciones y 142 borrados, de las cuales **~180 son ejecutable** (`G-C17d` ~70, `G-C19` ~40,
   la disjunción de `G-C16` ~10, el bucle completo de `G-C17c` ~15, `tsconfig.guards.json` 14 líneas
   de config) y el resto es **la corrección de seis números publicados y la explicación de por qué
   estaban mal**. Esa proporción es incómoda y va escrita: **el fix-pack de una HU cuyos seis
   bloqueantes eran de prosa produce, necesariamente, casi toda prosa.**

**La pregunta que decide** —*¿qué parte de esto seguiría existiendo si lo escribiera alguien que ya
conoce esta librería?*— y su respuesta medida: **las 1425 líneas de datos, enteras**; los ~180 de
código ejecutable del fix-pack, enteros (son candados que faltaban, no explicación); y **la prosa de
las correcciones, no** — alguien que ya conociera el terreno habría publicado los números bien la
primera vez y no tendría que explicar por qué estaban mal. **Ése es el costo real del error, y
medirlo es la única forma de que la próxima HU lo evite.**

---

## 13 · 🔴 EL GATE DEL REPO ES ESTRUCTURALMENTE CIEGO A ESTE ENTREGABLE

Lo midió el AR y lo confirmó el orquestador. Va acá porque **este documento publicaba `tsc 0` y
`lint 520` como evidencia de la HU, y no lo son**:

```
tsconfig.json  →  "include": ["src/**/*"]
npm run lint   →  biome check src/

archivos del guardián que `tsc -p tsconfig.json` typechequea : 0
líneas nuevas de esta HU que `biome check src/` mira          : 0
```

Las ~3400 líneas que esta HU agrega viven todas en `test/` y en `doc/`. **`tsc` y `lint` corren, dan
exit 0, y ese verde es verdadero — pero no habla de este entregable.** El único control que corría
sobre estas líneas era `vitest`, que **transpila sin typechequear**. No es culpa de esta HU: la
configuración es previa y AC-10 manda esos comandos. Lo que sí era de esta HU es publicarlos como si
midieran algo que no miden.

### Lo que se hizo, y es repetible

`tsconfig.guards.json`, **aditivo** (no toca `tsconfig.json` ni `npm run lint`), con los 5 archivos
del guardián y las mismas `compilerOptions` estrictas del repo:

```
node ./node_modules/typescript/bin/tsc -p tsconfig.guards.json --noEmit
```

**Control positivo, corrido antes de escribir el guard** — inyectando
`const x: BareLabel = 'NO_EXISTE';` en `test/cited-lines-guard.scanner.ts`:

```
tsc -p tsconfig.json        --noEmit  →  exit 0     ← ciego
tsc -p tsconfig.guards.json --noEmit  →  exit 2
    test/cited-lines-guard.scanner.ts(123,7): error TS2322:
    Type '"NO_EXISTE"' is not assignable to type 'BareLabel'.
```

Lo corre **`G-C19`** en cada `npm test`, así que no es un config versionado que nadie invoca — que
es exactamente el defecto que el AR encontró en la maquinaria del sorteo (`BLQ-BAJO-2`) y que
`G-C17d` cierra. Un artefacto sin llamador no es una defensa.

⚠️ **`npx tsc` NO SIRVE PARA LEER ESTE RESULTADO.** Bajo el hook de este entorno imprime
«TypeScript compilation completed» y **tapa el exit code**, hasta para `--version`. Todo lo de arriba
se corrió con `node ./node_modules/typescript/bin/tsc`, y `G-C19` invoca ese binario directo.

### Lo que NO se hizo, con su número

`"include": ["test/**/*.ts"]` da **12 errores en 3 archivos**: `test/migrate-preflight.test.ts`,
`test/smoke-downstream-x402.method.test.ts` y `test/verify-rls-enabled.test.ts` — casi todos
`exactOptionalPropertyTypes` y `noUncheckedIndexedAccess`. Son archivos **fuera del Scope IN de esta
HU**. Ampliar el `include` sin arreglarlos dejaría el config en rojo permanente, que es la forma más
rápida de que alguien lo borre. Queda **`TD-371-TYPECHECK-TEST`**, con el número medido y el comando
que lo reproduce, en el docblock de `tsconfig.guards.json`.

⚠️ **Y una consecuencia de contabilidad**: la raíz del repo pasa de 19 a **20** archivos trackeados
en el árbol vivo. §4 sigue diciendo 19 porque se deriva del **commit base**, y eso es correcto — pero
si alguien re-corre esa regla hoy le va a dar 20.
