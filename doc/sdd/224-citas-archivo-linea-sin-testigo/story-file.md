# Story File — HU 224 · WKH-362 · `TD-316-CITAS-SIN-TESTIGO`
## Testigo mecánico para las citas `archivo:línea`

> **Fase**: F2.5 · **Metodología**: QUALITY · **Gate cumplido**: `SPEC_APPROVED` (clinical review, modo AUTO)
> **SDD**: `doc/sdd/224-citas-archivo-linea-sin-testigo/sdd.md` · **Work item**: `.../work-item.md`
> **Base**: `main` = `b31ddba6206de28f063eb867d78d7f53e4de450e` — ✔ medido por mí (`/usr/bin/git rev-parse HEAD`)
> **Rama a crear**: `feat/224-citas-archivo-linea-sin-testigo` — ✔ medido por mí que **NO existe**
> (`/usr/bin/git rev-parse --verify …` → `fatal: Needed a single revision`). Rama actual: `main`.
> **Fecha**: 2026-08-19

> ⛔ **El Dev lee SOLO este documento.** Si algo no está acá, PARÁ y escalá al Architect.
> No abras el SDD para "completar" — si te falta, es un defecto de este contrato y hay que arreglarlo acá.
> **La única excepción**: los archivos del repo que este documento te manda a abrir. Ésos se abren SIEMPRE
> (CD-4), y son la fuente de verdad de todo número que escribas.

---

# 0. LEÉ ESTO ANTES QUE NADA — el argumento de existencia es un número, no una opinión

## 0.1 La tasa base de un humano concentrado es ~3 %

Textual del SDD §0.0, y es la medición **de este propio pipeline**:

> El Architect escribió el SDD **mientras trabajaba en este defecto**, con toda la atención puesta
> exactamente en él. Al re-verificar sus propias citas antes de cerrar encontró **2 mal de ~60**.
> Una de las dos salió de **copiar un número del work-item en vez de abrir el archivo** — o sea, la
> violación literal del **CD-4 que él mismo estaba redactando en ese momento**.

⇒ **Tasa de defecto ≈ 3 % en el mejor caso posible.** Ése **es** el argumento de existencia del
guardián. **No es un problema de descuido ajeno: es la tasa base de un humano concentrado.**
Si vos, Dev, leés esto pensando "a mí no me va a pasar", ya estás calibrado y el número es 3 %.

## 0.2 🔴 HALLAZGO DE ESTE F2.5: la corrección **H-2 del SDD es FALSA**, y hay que NO aplicarla

Medido por mí en este F2.5, con tres instrumentos y control positivo:

| Instrumento | Resultado |
|---|---|
| `command grep -n '' tsconfig.json` | `19:  "include": ["src/**/*"],` · `17:    "sourceMap": true` · `18:  },` |
| `sed -n '19p' tsconfig.json` | `  "include": ["src/**/*"],` |
| `/usr/bin/git show HEAD:tsconfig.json \| command grep -n 'include\|sourceMap'` | `17: "sourceMap"` · `19: "include"` |
| `/usr/bin/git status --porcelain tsconfig.json` | **vacío** ⇒ el archivo del disco **es** el de `HEAD`, no hay edición local que explique la diferencia |
| `wc -l tsconfig.json` | **21** — el archivo entero entra en pantalla, no hay ambigüedad de offset |

⇒ **`tsconfig.json:19` ES `"include": ["src/**/*"],`.** La cita que hacen
`test/sdd-index-matches-folders.exceptions.ts:15` y `test/ownership-filter-guard.exceptions.ts:24`
**es CORRECTA**. El SDD afirmó que `:19` era `"sourceMap": true` y que el `include` estaba en `:20`:
**las dos afirmaciones son falsas** (`:20` es `"exclude"`, `:17` es `"sourceMap"`).

### Por qué esto no es una errata y hay que leerlo entero

1. **Cambia el trabajo.** El SDD manda, en W3, corregir
   `test/sdd-index-matches-folders.exceptions.ts:15` de `tsconfig.json:19` → `:20`.
   **Aplicar esa instrucción INTRODUCIRÍA una cita falsa** en el repo, dentro de la HU que existe para
   sacarlas. ⇒ **W3 baja de 5 correcciones a 4** (§11.W3). **No toques esa línea.**
2. **Sube la tasa medida.** Ya no son 2 de ~60 (3 %): son **3 de ~60 (5 %)**, y el tercero apareció
   sólo porque un segundo lector lo re-abrió.
3. **Es un modo de falla PEOR que el original**, y es nuevo:
   la cita original estaba **bien** y el revisor la declaró **mal**. No es "un número que envejeció":
   es **una corrección que empeora el repo**, emitida por alguien que estaba midiendo a propósito.
   Un guardián mecánico habría dado **verde** sobre `:19` y el revisor no habría escrito nada.
4. **Disuelve un párrafo del SDD.** El SDD decía que "una de las dos entra al Corte A y la otra es
   Corte B — y esa asimetría hay que declararla". **No hay asimetría**: las dos citas son correctas.
   `test/ownership-filter-guard.exceptions.ts:24` sigue fuera del Corte A por tamaño, no por deuda.
5. **El `mustContain` de esa entrada es de lujo.** ✔ Medido: `"include"` aparece **1 sola vez** en
   `tsconfig.json` (`command grep -c '"include"' tsconfig.json` → `1`) ⇒ la unicidad de AC-3 se
   cumple con una needle sola, y el `symbolPath` es `[]` legítimo (target `.json`, sin símbolos TS).
   **Es el mejor caso de prueba que tenés para el camino `symbolPath: []` de CD-12.**

⚠️ **Lo que NO cambia**: la *conclusión* que esas dos citas sostienen —que CI no typechequea ni lintea
`test/`— **sigue siendo cierta** (✔ medido por mí: `package.json:11` = `"lint": "biome check src/",`
y el `include` es `["src/**/*"]`). Es exactamente el patrón que el propio SDD describió para H-2:
**conclusión bien, número mal** — sólo que acá el número estaba bien y la corrección estaba mal.
**DT-4 (validación en runtime, no por tipo) queda intacta.**

## 0.3 Marcas de cita — obligatorias en todo lo que escribas

Este documento marca **cada** cita. Vos tenés que hacer lo mismo en tus commits, en tu reporte y en
cualquier prosa que escribas durante la HU.

| Marca | Significado |
|---|---|
| ✔ | **Medida por mí (Architect) en este F2.5.** Abrí el archivo y leí la línea. |
| `[HEREDADO]` | Viene del SDD, del work-item o del auto-blindaje. **No la re-derivé.** |
| `[NO MEDIDO]` | No la pude medir, y lo digo en vez de afirmarla. |

⚠️ **`[HEREDADO]` no es "probablemente bien".** §0.2 es un `[HEREDADO]` del SDD que resultó **falso**.
Toda cita `[HEREDADO]` de este documento es **checklist de qué abrir**, nunca insumo del registro.

## 0.4 Instrumentos — la lista no es folclore, cada ítem ya produjo un cero falso

| Necesitás | Usá | ⛔ NO uses, y por qué |
|---|---|---|
| cualquier cosa de git | **`/usr/bin/git`** | `git diff` bajo el hook **TRUNCA** (3250→532 bytes, cortando hunks, **exit 0**) ⇒ un barrido negativo da **CERO FALSO** |
| listar el índice | **`rtk proxy git ls-files`** | `git ls-files` bajo el hook devuelve **vacío**. ✔ Control positivo mío: `rtk proxy git ls-files` da **1823** archivos y el filtro sobre `src`+`test` coincide con el del SDD |
| buscar en archivos | **`command grep -n`** | `grep` bajo el hook devuelve **conteos** en vez de rutas |
| leer un archivo | **`sed -n 'Np'`** / `sed -n 'A,Bp'` | **`cat` CORROMPE** al redirigirse (falla silenciosa, exit 0) |
| historial | `rtk proxy "git log --merges"` | `git log --oneline` bajo el hook **BORRA los commits de merge** |
| correr un test | `npx vitest run <archivo>` **sin redirigir** | `npx vitest run > archivo` **trunca a 500 chars con exit 0** |
| exit code | leerlo **directo**, `echo $?` en la línea siguiente | **los exit codes NO sobreviven un pipe** |
| lint | `./node_modules/.bin/biome check src/` | `npx biome` **no resuelve el binario** |

🔴 **La regla que las engloba (CD-3): ante un CERO, un número redondo o un "todo igual",
CONTROL POSITIVO antes de creerle.** Un cero de un instrumento truncado es indistinguible de
"no hay nada", y **ésta es la HU donde eso se paga doble**.

🔴 **NO corras `npm test` completo** durante W0–W3. Hay otros agentes corriendo suites en esta máquina.
Corré **sólo** `npx vitest run test/cited-lines-guard.test.ts`. La suite completa se corre **una vez**,
al final de W4 (§11.W4). Todo número de suite que cites de artefactos previos va marcado `[HEREDADO]`.

---

# 1. Goal

Construir un guardián en `test/` que, sobre un universo **explícito de 14 archivos**, exija que **cada
cita `archivo:línea` esté declarada a mano** con (a) el texto que esa línea tiene que contener y (b) el
**camino de símbolos** que la contiene; y que ponga `npm test` en **rojo** cuando el texto se movió,
cuando la declaración es **ambigua**, cuando el **archivo** citado es el equivocado, o cuando aparece
una cita **nueva sin declarar**.

**Por qué**: hoy **ningún** test del repo puede ponerse rojo porque un comentario, un docblock o un
nombre de test apunten a la línea equivocada. `codeOnly`
(✔ `test/payment-guards-live-in-one-place.test.ts:45` = `function codeOnly(file: string): string {`)
**borra los comentarios antes de mirar**, y **tiene que hacerlo** (✔ su docblock `:16-20` explica el
falso positivo que lo obliga: `routes/agents.ts` menciona `x402` en un mensaje de error de auth y
`getInitializedChainKeys()` en un comentario). ⇒ **el guardián estructural más nuevo del repo no puede
ponerse rojo por prosa, por construcción.** Ese guardián **no es el bug: es la razón por la que el
agujero es estructural.**

---

# 2. Las dos decisiones que llegaron con el `SPEC_APPROVED` — escritas como decididas

## D-1 · SÍ, el guardián nace cubriendo el **6,0 %**, y el porqué va en el código

**Corte A = 45 anclas = 6,0 % de `src`+`test` y 0,21 % del repo. APROBADO.**

La alternativa **no** es "cubrir más". Es una de estas dos:
- **seguir cubriendo 0 %** (que es lo que hay hoy), o
- **bloquear la HU** hasta declarar a mano **749** needles.

Y el mecanismo hace que la cobertura crezca **por trinquete, no por campaña**: `G-C4` (el `G-F2` de
esta HU — *"cita nueva sin declarar = rojo"*) obliga a declarar **cada cita nueva en el momento en que
se escribe**, que es cuando es barata. Nadie tiene que acordarse de nada.

⚠️ **Y por eso existe CD-8**: la cobertura honesta se **publica**. Sin ese número, un guardián verde
sobre el 6 % se lee como *"las citas del repo ya están verificadas"*, que es exactamente **prosa que
afirma de más**. Los dos porcentajes van en el docblock (`G-C10`), en el commit y en el reporte.

## D-2 · NO se trackea `.nexus/project-context.md`, y la razón es nueva

El SDD lo excluyó **por medición**: ✔ `/usr/bin/git ls-files -- .nexus` devuelve **vacío** ⇒ el
archivo **no está en el índice de git** ⇒ por **AC-6** queda fuera del universo **para siempre, por
construcción**. Eso no cambia.

⛔ **Lo que cambia es la deuda.** El SDD proponía `TD-316-CITAS-PROJECT-CONTEXT` como *"decidir si se
trackea"*. **Redactala así, textual:**

> **`TD-316-CITAS-PROJECT-CONTEXT`** — *antes de trackear `.nexus/project-context.md` hay que revisar
> qué contiene, porque **este repo es PÚBLICO**: meterlo en git **publica su contenido**. La deuda no
> es "trackearlo": es "revisar el contenido y recién después decidir".*

🪞 **Y dejá anotada la ironía en el docblock, porque es un dato útil y no un chiste:**
> `.nexus/project-context.md` es **justamente el documento que le pide al lector verificar sus citas**
> (`[HEREDADO]` — su encabezado `:6-12`), **y es el que ningún guardián de este repo puede alcanzar.**

**CD-13 sigue vigente**: PROHIBIDO meterlo al universo por cualquier vía que no sea trackearlo en git.
Una lista paralela rompería AC-6, que es lo único que garantiza que el universo no dependa del disco de
quien corre los tests.

---

# 3. Acceptance Criteria (EARS) — los 12, copiados del work-item aprobado

> Éstos son los criterios que QA verifica en F4, **con evidencia `archivo:línea`**. `[HEREDADO]` del
> work-item — el texto es normativo, no lo reescribas.

- **AC-1** — *Event-driven.* **WHEN** un archivo dentro del universo declarado contiene una cita
  `archivo:N` y esa cita **no** está declarada en el registro, **the system SHALL** poner `npm test`
  en rojo nombrando el archivo citador, su línea y la cita sin declarar. → **`G-C4` ★**
- **AC-2** — *Event-driven.* **WHEN** la línea citada deja de contener alguno de los textos que su
  declaración exige (`mustContain`), **the system SHALL** poner `npm test` en rojo nombrando la cita,
  el texto esperado y la razón probable (se corrió el archivo). → **`G-C5`**
- **AC-3** — *Unwanted.* **IF** el `mustContain` declarado matchea **más de una línea** del archivo
  citado, **THEN the system SHALL** poner `npm test` en rojo, porque esa declaración no puede
  distinguir la línea correcta de la equivocada. → **`G-C5`**
- **AC-4** — *Ubiquitous.* La declaración de cada cita **SHALL** identificar la **función o símbolo
  contenedor** de la línea citada, y el guardián **SHALL** ponerse rojo si la línea citada dejó de caer
  dentro de ese contenedor, **incluso cuando el `mustContain` siga matcheando**. → **`G-C6`** (+`G-C3`)
- **AC-5** — *Unwanted.* **IF** una cita nombra un archivo que **no existe** o una línea **fuera del
  rango**, **THEN the system SHALL** poner `npm test` en rojo **distinguiendo ese caso del de AC-2 en
  el mensaje**. → **`G-C5`**
- **AC-6** — *Ubiquitous.* El universo **SHALL** derivarse del **índice de git** en cada corrida, y el
  guardián **SHALL** ponerse rojo si el universo derivado queda vacío o por debajo de un piso
  declarado. → **`G-C1`**
- **AC-7** — *Ubiquitous.* El guardián **SHALL** incluir controles de armado que se pongan rojos ante
  un escáner que **no reporte nunca** y ante uno que **reporte siempre**, sobre **fixtures en memoria
  con la respuesta conocida de antemano**. → **`G-C1`/`G-C2`/`G-C3`**
- **AC-8** — *Event-driven.* **WHEN** el registro contiene una entrada cuyo sitio citador ya no existe
  (el comentario se borró), **the system SHALL** poner `npm test` en rojo. → **`G-C7`**
- **AC-9** — *Optional/state-driven.* **WHERE** una cita no se puede anclar mecánicamente, **the system
  SHALL** exigir una **excepción escrita a mano con su motivo**, y **SHALL** rechazar en runtime toda
  excepción con motivo vacío, demasiado corto, o **idéntico palabra por palabra a otro**. → **`G-C8`**
- **AC-10** — *Ubiquitous.* El corte **SHALL** dejar declarado por escrito, **en el propio docblock del
  guardián**, qué NO cubre, con al menos: citas en archivos **no trackeados por git**, citas en **prosa
  suelta**, y el **VALOR** semántico de la afirmación. → **`G-C10`**
- **AC-11** — *Event-driven.* **WHEN** el barrido se ejecute, **the system SHALL** buscar las citas con
  los **tres** patrones —con ruta, sin directorio, sólo línea entre backticks— y **SHALL** aceptar el
  prefijo `./`. → **`G-C2`, ampliado a CUATRO formas (§5.4). Se cumple *a fortiori*.**
- **AC-12** — *Unwanted.* **IF** el guardián nuevo verifica una propiedad que `G-08`, `G-09` o `G-10`
  de `test/ownership-filter-guard.test.ts` ya verifican, **THEN** el diseño **SHALL** rechazarse en el
  SDD antes de escribir código. → **CERRADO EN EL SDD, y re-verificado acá: §9. No genera control.**

---

# 4. Constraint Directives — 14, todas vigentes

## Heredadas del work-item

| CD | Regla |
|---|---|
| **CD-1** | ⛔ PROHIBIDO re-verificar lo que `G-08`/`G-09`/`G-10` ya verifican. **Se cumple mecánicamente**, no por disciplina — ver §9. |
| **CD-2** | ⛔ PROHIBIDO tocar lógica de producción. **Criterio de verificación, no de intención**: el diff sobre `src/` **sólo** puede contener líneas de **comentario** y archivos `*.test.ts`/`test/`. |
| **CD-3** | ✅ OBLIGATORIO usar los instrumentos de §0.4. **Ante un cero, control positivo.** |
| **CD-4** | ⛔ **PROHIBIDO escribir en el registro un `archivo:línea` que no hayas ABIERTO Y LEÍDO en esta HU.** Incluye los números heredados del work-item, **los de la tabla §5.5 de este documento** y **los del SDD**. Ni un solo `mustContain` puede salir de un documento. **Violación = BLOQUEANTE en AR.** |
| **CD-5** | ✅ OBLIGATORIO: la fila de esta HU en `doc/sdd/_INDEX.md` va **al FINAL**. ✔ Ya está en `:216` (última fila de datos) y `:144` está **intacta** (✔ medido por mí: contiene las 3 needles `remit.corridor-discovery`, `kyc-check`, `cashout-match` que `G-F1` exige). **NO la re-insertes. NO muevas nada por encima de la 144.** |
| **CD-6** | ⛔ PROHIBIDO volcar la salida del escáner al registro o a las excepciones. Se escriben **a mano, entrada por entrada, leyendo el sitio**. La salida del escáner es **checklist de qué mirar**, nada más. |
| **CD-7** | ⛔ PROHIBIDO tocar `codeOnly` ni ningún assert de `test/payment-guards-live-in-one-place.test.ts`. |
| **CD-8** | ⛔ PROHIBIDO presentar el verde como *"las citas del repo son correctas"*. **Todo reporte SHALL publicar 6,0 % y 0,21 %.** |
| **CD-9** | ✅ OBLIGATORIO no tocar `doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md` (untracked a propósito, **otra HU**). ✔ md5 verificado por mí en este F2.5: `7904ef74a1c46d7880e0ca5d38e3eed4`. **Verificalo de nuevo al cerrar.** |

## Nuevas del SDD

| CD | Regla |
|---|---|
| **CD-10** | ✅ **OBLIGATORIO: toda corrección de una cita dentro de un comentario es LÍNEA-NEUTRA.** Ver §11.W3 — tiene víctimas concretas medidas. **Verificación con DOS instrumentos** (uno solo da cero falso). |
| **CD-11** | ⛔ **PROHIBIDO copiar al registro el número que el propio guardián sugiere** en el mensaje de `E-LINE_MOVED`, sin abrir la línea. Es la puerta de atrás de CD-6. *(El mensaje **es** legítimo: deriva de una needle escrita a mano. Pero el que copia sin abrir no verifica que la needle siga describiendo lo que la prosa afirma.)* |
| **CD-12** | ⛔ **PROHIBIDO declarar `symbolPath: []` cuando el resolver devuelve un camino.** El guard lo **compara contra el resolver**. Sin esto, `[]` sería el apagador de AC-4. |
| **CD-13** | ⛔ PROHIBIDO agregar `.nexus/project-context.md` al universo por cualquier vía que no sea trackearlo en git. Ver **D-2**. |
| **CD-14** | ⛔ **PROHIBIDO que `exceptions.ts` exceptúe algo distinto de la UNICIDAD (AC-3) o del ANCLAJE de una cita en prosa suelta (AC-9).** Ver §8.2 — **es el candado que impide que el guardián se neutralice a sí mismo.** |

## Nueva de este F2.5

| CD | Regla |
|---|---|
| **CD-15** | ⛔ **PROHIBIDO "corregir" `test/sdd-index-matches-folders.exceptions.ts:15` (`tsconfig.json:19` → `:20`).** ✔ Medido en §0.2 con tres instrumentos: **`:19` es correcta**. Aplicar la instrucción del SDD introduciría una cita falsa dentro de la HU que existe para sacarlas. **Si tu diff toca esa línea, es BLOQUEANTE.** |

---

# 5. El universo — 45 anclas, y el número viene con su instrumento y su piso

## 5.1 Los 14 paths del Corte A (`CORTE_A_PATHS`)

✔ **Los 14 verificados por mí en este F2.5** contra `rtk proxy git ls-files` (1823 archivos en el
índice): **los 14 están**. Ninguno falta.

| # | Path | Anclas ✔ | Largo ✔ | Por qué entra |
|---|---|---|---|---|
| 1 | `src/types/index.ts` | **9** | 2318 | 3 citas falsas medidas. El archivo con más citas salientes del radio de WKH-316. |
| 2 | `src/routes/agents.ts` | **2** | 599 | 1 cita falsa medida + su largo cambia seguido. |
| 3 | `src/services/agent.ts` | **1** | 830 | Disparador explícito del auto-blindaje (su largo cambia seguido). |
| 4 | `src/services/agent.payment.test.ts` | **1** | 815 | Cita en test del camino del dinero, **ya re-apuntada una vez** (`MNR-1`). |
| 5 | `src/routes/agents.publish.test.ts` | **6** | 932 | 5 de sus 6 son forma **P3** (población de forma). |
| 6 | `src/routes/agents.ownership.test.ts` | **5** | 404 | Citas de ownership **que se imprimen en CI**. |
| 7 | `src/lib/operator-address.ts` | **6** | 114 | **Único citador con P1 relativo (`../`)** del corte. |
| 8 | `src/lib/payment-spec-writer.ts` | **0** | 382 | El módulo de los 7 guards del bloque `payment`. **Entra con CERO anclas a propósito**: presión hacia adelante a costo cero. |
| 9 | `src/lib/payment-spec-reader.ts` | **2** | 215 | El lector del bloque de pago. |
| 10 | `src/services/compose.ts` | **5** | 1804 | **La cita falsa del guard anti-doble-débito** (§5.5 H-1). |
| 11 | `src/services/fee-split.ts` | **2** | 721 | Las **dos son P4** (única población P4 de `src/` del corte) sobre el fee-split. |
| 12 | `test/payment-guards-live-in-one-place.test.ts` | **2** | 156 | Es el guardián cuyo `codeOnly` **crea** el agujero. |
| 13 | `test/sdd-index-matches-folders.exceptions.ts` | **1** | 192 | Es el **registro del exemplar**. ⚠️ Ya **no** entra por "cita falsa" — ver **CD-15**. |
| 14 | `CLAUDE.md` | **3** | — | Documento **normativo** del repo, y el que ya tuvo una lista a mano que envejeció mal. Sus 3 citas ✔ son **exactas hoy**. |
| | **TOTAL** | **45** | | 13 citadores + 1 con cero |

## 5.2 El número **45**, con su instrumento y su piso — nunca lo cites suelto

✔ **Re-derivado por mí en este F2.5 con un escáner propio e independiente del que corrió el SDD**
(`node`, 4 regex, sobre los 14 paths). Resultado, **idéntico al del SDD archivo por archivo**:

```
TOTAL P1=14 P2=12 P3=16 P4=3  =>  45
```

⚠️ **Esto es una CONCORDANCIA, no una prueba.** Los dos escáneres se escribieron contra la misma
especificación de §5.4, así que **pueden compartir el mismo defecto**. Lo que la concordancia sí
descarta es un error de transcripción o de conteo. Lo que **no** descarta es que las 4 formas dejen
citas afuera.

🔴 **`45` es un PISO, no un total, por dos razones distintas y medibles:**

1. **Una cita en prosa suelta no la devuelve ningún patrón.** *"la línea 95"*, *"el guard de más
   abajo"*, *"el docblock de arriba"* no tienen forma sintáctica. **No hay cota superior conocida.**
   `[NO MEDIDO]` — y no es medible sin leer los 14 archivos a mano.
2. **P4 tiene falsos positivos.** `[HEREDADO]` del SDD: de los 45 P4 de todo `src`+`test`, **~7 son
   ruido** (`:8443` ×3, `:443`, `:80`, `:0`) ⇒ precisión de P4 ≈ 84 % **globalmente**. ✔ **En el Corte
   A los 3 P4 son citas reales, 0 ruido** (medido por mí: son `compose.ts:688 → :208` y las dos de
   `fee-split.ts:494`). El ruido cae del lado **RUIDOSO** (se declara una excepción con motivo escrito),
   **no del silencioso** — que es el criterio correcto.

## 5.3 Cobertura honesta — los dos números que CD-8 obliga a publicar

| Denominador | Cobertura |
|---|---|
| `src`+`test` (**749** anclas en 135 citadores de 513 archivos) `[HEREDADO]` | **6,0 %** (45/749) |
| El repo entero (`src`+`test`+`doc`+raíz ≈ **21.300** anclas) `[HEREDADO]` | **0,21 %** |

Contexto medido `[HEREDADO]` del SDD: `doc/` trackeado tiene **20.550** anclas en **736** citadores.
Ése es el motivo por el que el Corte D *"no es una HU: es un programa"*.

**La frase correcta**, y es la única admisible en el reporte:
> *"Estas 45 citas no pueden mentir sin que la suite se caiga."*

**La frase PROHIBIDA (CD-8):**
> ~~"Las citas del repo están verificadas."~~

## 5.4 Las **CUATRO** formas de cita — AC-11 dice tres, y con tres el guardián nace ciego

| # | Forma | Ejemplo real ✔ del repo | Corte A ✔ | `src`+`test` `[HEREDADO]` |
|---|---|---|---|---|
| **P1** | con ruta, **incluyendo `./` y `../`** | `src/lib/discovery-query.ts:219-229` · `../adapters/solana/chain.ts:84` | **14** | 174 |
| **P2** | sin directorio | `downstream-payment.ts:772` · `tsconfig.json:19` | **12** | 382 |
| **P3** | sólo `:N`, **entre backticks** | `` `:777` `` · `` `:66` `` | **16** | 148 |
| **P4** | sólo `:N`, **SIN backticks** ⬅ **la cuarta, y NO está en AC-11** | `:208` · `:316` · `:335` | **3** | 45 (~38 reales) |

🔴 **Por qué P4 no es opcional, con el caso medido:**
`src/services/compose.ts:688` cita **`:208`** para el guard `i > 0` **anti-doble-débito**, y ✔ el ancla
real es **`:571`**. Esa cita es **invisible a las tres formas de AC-11 porque es bare, sin backticks**.
**Ni el barrido que usó WKH-316 ni el que declaró "correcto" la habrían encontrado.** Apareció sólo al
agregar la cuarta forma.

Y el `./` no es cosmético: `[HEREDADO]` en otro repo un patrón perdió una cita **justo por excluir el
`./`** (`flow.tsx:1839 → ./splash.tsx:245`). ⇒ **va cubierto por fixture, no por confianza** (`G-C2`).

✔ **Falso positivo medido que hay que descartar en el escáner**: `::1` (IPv6, en `src/types/index.ts`).
Regla: **el carácter previo a los `:` no puede ser `:`**. Los puertos (`:8443`, `:443`, `:80`) y `:0`
**NO** se descartan en el escáner —descartarlos por rango sería inventar una heurística que mañana se
come una cita real— sino que van a `exceptions.ts` con motivo escrito. ✔ En el Corte A esta población
es **0**, y `SCANNER_FALSE_POSITIVES` **no afirma que sea > 0**.

## 5.5 🔴 Las citas falsas medidas — y **cuál dejó de serlo**

> ⚠️ **CD-4: esta tabla es CHECKLIST DE QUÉ ABRIR, NO el registro.** Todo número de acá se re-abre
> antes de escribirse. Copiar de esta tabla sin abrir = **BLOQUEANTE en AR**. Y estaría vieja en cuanto
> alguien inserte una línea en cualquiera de estos archivos.

### Las que SÍ hay que corregir (4 sitios, 5 correcciones)

| Dónde está escrita | Qué dice | ✔ Qué hay realmente en la línea citada | ✔ Ancla real | Needle candidata (**re-medila**) |
|---|---|---|---|---|
| `src/services/compose.ts:688` | `` guard `i > 0` de :208 `` | `:208` es prosa sobre el `intentId` del leg Solana — nada que ver | **`src/services/compose.ts:571`** | `['if (i > 0 &&', 'scopingKeyRow']` → ✔ **1** hit. ⚠️ `'i > 0'` solo da **5** (309/547/571/602/688) |
| `src/types/index.ts:1450` | `` guard `i>0` de compose.ts:130 `` | `src/routes/compose.ts:130` = `/**`; `src/services/compose.ts:130` = prosa del over-fetch | **`src/services/compose.ts:571`** | ídem. ⚠️ **el ARCHIVO también está mal** |
| `src/types/index.ts:207` | *"…y `` `:777` `` lo firma como `to`"* | `:777` no es esa línea | **`src/lib/downstream-payment.ts:922`** (`to: payToCheck.addr,`) | `['to: payToCheck.addr']` → ✔ **1** hit |
| `src/types/index.ts:510` | *"el bucket `'__anon__'` se excluye (`reputation.ts:182-183`)"* | `:182` es un comentario (*"del atacante en 2 identidades reales…"*) | **`src/services/reputation.ts:189`** | `['ANON_CALLER_BUCKET', 'failedCallers.add']` → ✔ **1**. ⚠️ `ANON_CALLER_BUCKET` solo da **3** |
| `src/routes/agents.ts:47` | *"helper privado de `registries.ts:35`"* | `:35` es `requireA2AKeyPresence,` — **un specifier de import** | **`src/routes/registries.ts:94`** (`async function mapOwnershipError(`) | `['async function ', 'mapOwnershipError(']` → ✔ **1**. ⚠️ `mapOwnershipError` solo da **4** |

⛔ **Y la que NO hay que corregir**: `test/sdd-index-matches-folders.exceptions.ts:15` →
`tsconfig.json:19`. ✔ **Es CORRECTA.** Ver **§0.2 y CD-15**.

### 🔴 Dos cosas que hacen a `compose.ts` el caso más importante del corte

1. **Son DOS citas independientes del MISMO candado del camino del dinero, las dos mal, apuntando a dos
   líneas equivocadas DISTINTAS** (`:208` y `:130`). No es un typo: es el defecto reproduciéndose.
2. **La afirmación de fondo de `:688` es CORRECTA** (su docblock local dice que `stepDebitedUsd` vale 0
   para `i === 0`). ⇒ **el número es lo único falso**, que es exactamente el modo de falla que hace
   que *"abrir y comparar"* **confirme la mentira**.

### ✔ Las dos que el auto-blindaje declaraba exactas — re-abiertas por mí, siguen exactas

- `src/lib/downstream-payment.ts:772` = `const payToCheck = validatePayTo(agent.payment.contract);`
- `src/lib/downstream-payment.ts:247` = `async function settleSolanaLeg(` ⇒ **la línea ES la firma**.
  **Es el ancla ideal** (DT-3) y el precedente del paso 2 de la escalera (§8.2).

### ✔ Y el caso que prueba que AC-4 explica, no sólo discrimina

`src/routes/registries.ts:35` **no tiene símbolo**: es un specifier de import, y el resolver devuelve
**`null`**. En el ancla real `:94` devuelve `FunctionDeclaration mapOwnershipError`. ⇒ AC-4 discrimina
**donde AC-2 ya discrimina, y además dice por qué**.

## 5.6 CHECKLIST de los 45 tokens — qué abrir, en qué orden

> 🔴 **CD-6: esto NO es el registro.** Es la lista de **qué archivos abrir**. Cada `mustContain` y cada
> `symbolPath` sale de **leer la línea**, no de esta tabla. La columna "cita" es el token literal tal
> como está escrito, que es lo que va en el campo `cite` (que **sí** se transcribe: es el texto, no un
> número derivado).
>
> ✔ Lista derivada por mí en este F2.5 con escáner propio. La columna "citador:línea" es **derivada**
> y **NO va al registro** (DT-7, §8.1) — está acá sólo para que sepas dónde mirar.

| # | Forma | Citador:línea (derivada, NO se guarda) | Token `cite` |
|---|---|---|---|
| 1 | P2 | `src/types/index.ts:207` | `downstream-payment.ts:772` |
| 2 | P3 | `src/types/index.ts:207` | `` `:777` `` 🔴 **FALSA → `:922`** |
| 3 | P2 | `src/types/index.ts:246` | `downstream-payment.ts:711-735` |
| 4 | P1 | `src/types/index.ts:271` | `lib/payment-spec-reader.ts:212-213` |
| 5 | P3 | `src/types/index.ts:288` | `` `:203-225` `` ⚠️ **auto-cita: el rango CONTIENE `:207`** |
| 6 | P1 | `src/types/index.ts:385` | `services/agent.ts:399` |
| 7 | P2 | `src/types/index.ts:510` | `reputation.ts:182-183` 🔴 **FALSA → `:189`** |
| 8 | P2 | `src/types/index.ts:661` | `20260401000000_kite_registries.sql:44-66` ⚠️ target `.sql` ⇒ `symbolPath: []` |
| 9 | P2 | `src/types/index.ts:1450` | `compose.ts:130` 🔴 **FALSA (archivo Y línea) → `src/services/compose.ts:571`** |
| 10 | P2 | `src/routes/agents.ts:47` | `registries.ts:35` 🔴 **FALSA → `:94`** |
| 11 | P1 | `src/routes/agents.ts:280` | `src/lib/discovery-query.ts:219-229` |
| 12 | P2 | `src/services/agent.ts:161` | `discovery.ts:449` |
| 13 | P2 | `src/services/agent.payment.test.ts:303` | `downstream-payment.ts:247` ✔ correcta (es la firma) |
| 14 | P3 | `src/routes/agents.publish.test.ts:790` | `` `:220` `` ⚠️ target = `routes/agents.ts` ⇒ **`targetReason`** |
| 15 | P3 | `src/routes/agents.publish.test.ts:790` | `` `:237` `` ⚠️ ídem |
| 16 | P3 | `src/routes/agents.publish.test.ts:791` | `` `:252` `` ⚠️ ídem |
| 17 | P3 | `src/routes/agents.publish.test.ts:791` | `` `:459` `` ⚠️ ídem |
| 18 | P3 | `src/routes/agents.publish.test.ts:791` | `` `:475` `` ⚠️ ídem |
| 19 | P1 | `src/routes/agents.publish.test.ts:802` | `src/middleware/forward-key.test.ts:204-232` |
| 20 | P3 | `src/routes/agents.ownership.test.ts:13` | `` `:72` `` (auto-cita) |
| 21 | P3 | `src/routes/agents.ownership.test.ts:13` | `` `:76-77` `` (auto-cita) |
| 22 | P1 | `src/routes/agents.ownership.test.ts:17` | `src/services/agent.ts:808` |
| 23 | P1 | `src/routes/agents.ownership.test.ts:18` | `src/services/agent.ts:822` |
| 24 | P3 | `src/routes/agents.ownership.test.ts:25` | `` `:211` `` (auto-cita) |
| 25 | P3 | `src/lib/operator-address.ts:14` | `` `:1-16` `` ⚠️ docblock de cabecera ⇒ resolver da `[]` |
| 26 | P1 | `src/lib/operator-address.ts:18` | `../adapters/solana/chain.ts:84` ⚠️ **`../` — normalizar** |
| 27 | P3 | `src/lib/operator-address.ts:19` | `` `:95` `` ⚠️ target = `chain.ts` (nombrado 1 línea antes) ⇒ **`targetReason`** |
| 28 | P3 | `src/lib/operator-address.ts:20` | `` `:137-149` `` ⚠️ ídem |
| 29 | P1 | `src/lib/operator-address.ts:52` | `../adapters/deposit-verifier.ts:167-175` |
| 30 | P1 | `src/lib/operator-address.ts:84` | `../adapters/solana/chain.ts:81-82` |
| 31 | P2 | `src/lib/payment-spec-reader.ts:7` | `discovery.ts:23` |
| 32 | P2 | `src/lib/payment-spec-reader.ts:145` | `downstream-payment.ts:772-777` |
| 33 | P1 | `src/services/compose.ts:575` | `src/routes/compose.ts:63-77` |
| 34 | **P4** | `src/services/compose.ts:688` | `:208` 🔴 **FALSA → `:571`** — la que las 3 formas de AC-11 no ven |
| 35 | P1 | `src/services/compose.ts:1548` | `types/index.ts:217-218` ⚠️ **víctima de CD-10** |
| 36 | P1 | `src/services/compose.ts:1635` | `adapters/kite-ozone/payment.ts:279` |
| 37 | P2 | `src/services/compose.ts:1658` | `discovery.ts:529` |
| 38 | **P4** | `src/services/fee-split.ts:494` | `:316` (auto-cita) |
| 39 | **P4** | `src/services/fee-split.ts:494` | `:335` (auto-cita) |
| 40 | P3 | `test/payment-guards-live-in-one-place.test.ts:17` | `` `:66` `` ⚠️ target = `routes/agents.ts` ⇒ **`targetReason`** |
| 41 | P3 | `test/payment-guards-live-in-one-place.test.ts:18` | `` `:124` `` ⚠️ ídem |
| 42 | P2 | `test/sdd-index-matches-folders.exceptions.ts:15` | `tsconfig.json:19` ✅ **CORRECTA — CD-15, NO TOCAR** |
| 43 | P1 | `CLAUDE.md:212` | `src/types/database.types.ts:2567` ⚠️ **el caso que fuerza el `symbolPath`** |
| 44 | P1 | `CLAUDE.md:250` | `src/services/registry.ts:172` |
| 45 | P3 | `CLAUDE.md:251` | `` `:174` `` ⚠️ target = `registry.ts` ⇒ **`targetReason`** |

⚠️ **Dos tokens en la misma línea existen** (items 38/39 en `fee-split.ts:494`, items 1/2 en
`types/index.ts:207`). ✔ **Medido: NO hay tokens `cite` DUPLICADOS dentro de un mismo citador** en el
Corte A ⇒ la clave `{from, cite}` de DT-7 es única hoy. **Control positivo del detector**: el mismo
detector encuentra ✔ **2 duplicados** en `test/ownership-filter-guard.exceptions.ts` ⇒ **el cero no es
vacuidad del instrumento.**

---

# 6. Cómo se define la UNICIDAD (AC-3) — hubo que **medirla**, no elegirla

## 6.1 La unicidad es de la **CONJUNCIÓN**, no de cada needle

✔ Medido sobre el **exemplar que ya está en `main`** (`CITED_INDEX_LINES`, con
`mustContain: ['remit.corridor-discovery','kyc-check','cashout-match']` sobre `doc/sdd/_INDEX.md`):

| needle | ocurrencias en `_INDEX.md` |
|---|---|
| `remit.corridor-discovery` | **2** |
| `kyc-check` | **2** |
| `cashout-match` | **4** |
| **las tres juntas (conjunción, en la misma línea)** | **1** |

🔴 **Ninguna needle es única por separado; la conjunción sí.**
⇒ **Si `AC-3` se implementara por needle, el exemplar que ya está en `main` sería ROJO** y la regla
sería inusable. **Esto no se podía saber sin medirlo, y es la decisión más barata de equivocar de toda
la HU.**

## 6.2 Y la unicidad necesita **ÁMBITO** — el caso que lo fuerza

✔ `CLAUDE.md:212` cita `src/types/database.types.ts:2567` para afirmar que `registries` **sí** tiene
`owner_ref`. La línea es `          owner_ref: string;`. ✔ Medido por mí:

| needle | hits en `database.types.ts` |
|---|---|
| `owner_ref: string;` | **66** |
| `owner_ref: string` (sin `;`) | **67** (hay un `owner_ref: string \| null`) |
| `owner_ref` (cualquiera) | **91** |

⇒ Con unicidad **de archivo**, esa cita **no se puede declarar** — **y es una cita correcta, normativa
y del criterio de seguridad del repo**. La regla tiene que admitirla.

## 6.3 🎯 La formulación que funciona — **probada ejecutando `typescript@6.0.3` sobre 11 líneas reales**

> **needle (conjunción) + `symbolPath` como SUBSECUENCIA ORDENADA, con whitelist de kinds de declaración.**

✔ `ts.version` verificado por mí en este F2.5 → **`6.0.3`** (`package.json:39` = `"typescript": "^6.0.3"`).

| Caso real | `symbolPath` declarado | Path real que da el resolver | Hits |
|---|---|---|---|
| `database.types.ts:2567` | `['registries','Row','owner_ref']` | `["Database","public","Tables","registries","Row","owner_ref"]` | ✔ **1**, y es 2567 |
| `registry.ts:174` | `['list']` | — | ✔ 1 |
| `reputation.ts:189` | `['accumulateRow']` | — | ✔ 1 |
| `registries.ts:94` | `['mapOwnershipError']` | — | ✔ 1 |

### 🔴 Los DOS descartes, y se descartaron **midiendo**, no opinando

| Variante descartada | Por qué falla, medido |
|---|---|
| **Sufijo del path** (`endsWith`) | **Falla en 4 de 5 casos**: el nodo más interno trae nombres de expresión (`add`, `failedCallers`, `request`, `from`) **que ningún humano escribiría**. |
| **Span del símbolo** (needle única dentro del rango de líneas del símbolo) | Para `database.types.ts:2567` da 1 hit **pero es VACUO**: el span es de **1 línea** (2567-2567), así que la unicidad es **tautológica**. Un candado tautológico aplaude cualquier cosa. |

### ✔ Y el control de vacuidad de la propia regla, sobre datos reales

Con `symbolPath: ['executePipeline']` y un `mustContain` perezoso `['i > 0']`,
`src/services/compose.ts:571` da ✔ **5 hits (309, 547, 571, 602, 688)** ⇒ **ROJO**.
**Es AC-3 funcionando sobre el código real del camino del dinero, no sobre un fixture.**
⇒ **No hay forma de declarar perezosamente y quedar verde.**

## 6.4 AC-4 caza **4 de 6** por sí sola, y va **obligatoria igual**

`[HEREDADO]` del SDD, medido allá: el ancla por símbolo caza **4 de las 6** citas falsas conocidas
**por sí sola**.

**No caza** la que se mueve **dentro del mismo símbolo**: ✔ `reputation.ts:182` y `:189` caen **las dos
en `accumulateRow`**, así que el `symbolPath` es idéntico y no discrimina. Ahí discrimina AC-2/AC-3.

🔴 **Va obligatoria igual, y la razón NO es "por si acaso":**
> **es lo único que hace la unicidad SATISFACIBLE** (§6.2 — sin ámbito, `database.types.ts:2567` es
> indeclarable).

⇒ `symbolPath` es **obligatorio cuando el resolver devuelve algo**. `symbolPath: []` se admite **sólo**
cuando el resolver devuelve vacío (targets `.md`/`.json`/`.sql`/`.yml`, y docblocks de cabecera —
✔ medido: `src/lib/operator-address.ts:14` da `null`). **Y el guard NO le cree al autor: compara contra
el resolver** (**CD-12**).

---

# 7. Contrato de datos

## 7.1 `test/cited-lines-guard.citations.ts`

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
  /** Textos que la línea DEBE contener. CONJUNCIÓN. A mano, leyendo el código. */
  readonly mustContain: readonly string[];
  /** Camino de símbolos contenedor, de afuera hacia adentro (subsecuencia ordenada).
   *  `[]` SÓLO si el resolver no devuelve nada (target sin símbolos, o docblock de cabecera). */
  readonly symbolPath: readonly string[];
  /** OBLIGATORIO cuando `cite` es P3/P4 y `target` NO es `from` (DT-11). */
  readonly targetReason?: string;
}

export const CITED_LINES: readonly CitedLine[] = [ /* … a mano … */ ];
export const CORTE_A_PATHS: readonly string[] = [ /* los 14 de §5.1 … */ ];
export const DELEGATED_TARGETS = [{
  target: 'doc/sdd/_INDEX.md',
  ownedBy: 'G-F1/G-F2 en test/sdd-index-matches-folders.test.ts',
  reason: '…',
}] as const;
```

🔴 **NO existe el campo `fromLine`. Es un invariante, no un detalle. Ver §8.1.**

## 7.2 `test/cited-lines-guard.exceptions.ts` — tres arrays, todos con motivo escrito

| Export | Para qué | Población en Corte A |
|---|---|---|
| `UNICITY_EXCEPTIONS` (`{from, cite, reason}`) | Paso 3 de la escalera de §8.2 | vacío al empezar |
| `UNANCHORABLE_PROSE` | AC-9 — prosa suelta | vacío al empezar |
| `SCANNER_FALSE_POSITIVES` | Los `:8443`/`:443`/`:0` de P4 | ✔ **0 en el Corte A** — y **NO se afirma que sea > 0** (eso sería un candado que se pudre solo) |

## 7.3 `test/cited-lines-guard.scanner.ts` — funciones **puras** (testeables con fixtures)

| Export | Firma | Qué hace |
|---|---|---|
| `scanSource` | `(src: string, file: string) => FoundCite[]` | Las 4 formas de §5.4 sobre un **string**. `FoundCite = {file, line, cite, form: 'P1'\|'P2'\|'P3'\|'P4', path?, num, endNum?}`. **Descarta `::N`.** |
| `resolveSymbolPath` | `(src: string, file: string, line: number) => string[]` | Compiler API. Whitelist de kinds de declaración + `it`/`test`/`describe` con string literal. `[]` si no hay ninguno. |
| `normalizeTarget` | `(fromFile: string, token: string) => string \| null` | Resuelve `./`, `../` y el path relativo al citador. `null` para P2/P3/P4. |
| `locate` | `(targetSrc, targetFile, needles, symbolPath) => number[]` | Las líneas que cumplen **needles ⊆ línea** Y **`symbolPath` es subsecuencia ordenada del path de esa línea**. |

⚠️ `resolveSymbolPath` **no se aplica a targets sin símbolos** (`.md`, `.json`, `.sql`, `.yml`):
devuelve `[]` y el guard exige `symbolPath: []`.
⚠️ `ts.createSourceFile` es **puro sobre un string** ⇒ el resolver sigue siendo testeable con fixtures
en memoria, que es requisito de **AC-7**.

**Por qué el compiler API y no una heurística de texto**: una heurística de indentación sobre código con
5 niveles de anidamiento es exactamente *"la herramienta de medición que fabrica un bug"*.

## 7.4 🔴 Los **NUEVE** códigos de fallo — y el paso 6 es el control positivo DENTRO del algoritmo

Para cada entrada declarada, **en este orden**:

| # | Condición | Código | Qué dice el mensaje |
|---|---|---|---|
| 1 | `target` no está en el índice de git | `E-TARGET_MISSING` | *"el archivo citado no existe (o no está trackeado). **Un cero de grep acá no significa 'el ancla desapareció'.**"* |
| 2 | El token no es consistente con `target` (DT-11) | `E-CITE_TARGET_MISMATCH` | *"la entrada dice `target: X` y el token cita `Y`: o la entrada se copió de otra, o el comentario cambió."* |
| 3 | `line` > líneas del `target` | `E-LINE_OUT_OF_RANGE` | **AC-5.** *"la línea citada está fuera del archivo (tiene N líneas)."* |
| 4 | `locate(...)` devuelve **> 1** hit | `E-NEEDLE_VACUOUS` | **AC-3.** *"tu declaración matchea las líneas [a,b,c]: no puede distinguir la correcta de la equivocada. Escalera: alargá la conjunción, o re-apuntá la cita a la firma."* |
| 5 | **1** hit y **≠** `line` (o fuera de `[line,endLine]`) | `E-LINE_MOVED` | **AC-2.** *"se corrió el archivo: tu ancla está ahora en `:M`. Re-apuntá la cita de `<from>` de `:N` a `:M`. ⚠️ **Abrí `:M` antes de copiar este número (CD-11).**"* |
| 6 | **0** hits en `target`, pero **1** hit en **exactamente un** archivo del índice con el **mismo basename** | `E-WRONG_FILE` | *"el **ARCHIVO** citado está mal, no la línea: tu ancla vive en `src/services/compose.ts:571`. **Buscar en el archivo citado da CERO, y ese cero NO es 'ya no está'.**"* |
| 7 | **0** hits en `target` **y 0** en los hermanos | `E-ANCHOR_GONE` | *"el ancla desapareció del repo. Antes de re-apuntar, **releé la prosa**: puede que la afirmación también sea falsa ahora, no sólo el número."* |
| 8 | `symbolPath` declarado ≠ resolver en `line` | `E-SYMBOL_DRIFT` | **AC-4.** *"la línea citada cae dentro de `[…]` y vos declaraste `[…]`."* |
| 9 | `symbolPath: []` y el resolver devuelve algo | `E-SYMBOL_OMITTED` | **CD-12.** |

### 🎯 Por qué el paso 6 es la pieza importante

**El paso 6 ES el control positivo del cero, y vive DENTRO del algoritmo.**
El guardián **nunca reporta "no está" sin haber buscado primero en los hermanos con el mismo basename.**

✔ Validado a mano por mí sobre el caso real:
- `command grep -c 'i > 0' src/routes/compose.ts` → **0**
- `command grep -c 'i > 0 &&' src/services/compose.ts` → **1**
- basenames `compose.ts` en el índice → ✔ **exactamente 2**

⇒ Es lo que faltaba en el caso donde **el archivo citado estaba mal** y buscar ahí daba **cero**, que se
leía como *"ya no está"*. **`E-WRONG_FILE` es el arreglo de ese error de lectura, hecho mecánico.**

---

# 8. Los invariantes que NO se pueden negociar

> Si el Dev toca alguno de estos tres, **rompe la HU entera**, no un detalle.

## 8.1 🎯 EL REGISTRO **NO GUARDA LA LÍNEA DEL CITADOR**

**La clave es `{from, cite-token}`. La línea del citador se DERIVA en cada corrida.**

**Razón, textual del SDD y es la frase que decide:**
> *"Guardar `fromLine` sería construir, **dentro del arreglo, el defecto que arregla**."*

Un registro cuyas claves son números de línea del citador **se rompe con cualquier inserción en el
citador** — y esta HU existe precisamente porque **los números no sobreviven a las ediciones, ni a las
propias**.

**Qué se pierde a propósito**: el "candado de largo" sobre los 13 citadores (con `fromLine`, toda
inserción daba rojo). Se cambia **a sabiendas**: ese rojo **no señala nada falso**, y su fricción es lo
que hace que alguien termine borrando el guardián. La derivación mantiene AC-1/2/3/4/8 **intactos**.

**Precondición medida** ✔ (§5.6): cero tokens duplicados dentro de un mismo citador en el Corte A, con
control positivo (el detector encuentra 2 en `exceptions.ts`) ⇒ `{from, cite}` es único **hoy**.
Si mañana aparece un duplicado, **`G-C4` se pone rojo y pide un campo `nth`** — no falla en silencio.

⛔ **Si agregás `fromLine` "para que el mensaje de error sea más lindo", rompés la HU.**
El mensaje de error **puede** imprimir la línea derivada. **El registro no la guarda.**

## 8.2 🔴 LA ESCALERA DE 3 PASOS, y el candado que impide el interruptor de apagado

**Cuando el `mustContain` no puede ser único, en ESTE orden:**

| Paso | Qué hacer | Evidencia ✔ |
|---|---|---|
| **1** | **Alargar la conjunción.** | `mapOwnershipError` solo → **4** hits; `['async function ','mapOwnershipError(']` → **1** |
| **2** | Si la línea es **intrínsecamente no identificable** (`});`, `}`, `*/`): **la cita está mal y se RE-APUNTA a la línea de la FIRMA** del símbolo contenedor. **No es una excepción: es corregir el comentario.** | Precedente ✔ `downstream-payment.ts:247` = `async function settleSolanaLeg(` |
| **3** | **Sólo si 1 y 2 son imposibles** (target sin símbolos y línea genuinamente repetida) → entrada en `exceptions.ts` con motivo **≥ 40 caracteres** y **no duplicado palabra por palabra**. | Formato de `G-10` |

### 🔴 CD-14 — la excepción **ACOTA la unicidad, NUNCA la existencia ni el match**

> *"Si no, **`exceptions.ts` es el interruptor de apagado**."*

Una cita exceptuada de la unicidad **SIGUE OBLIGADA** a que:
- el **archivo exista** (`E-TARGET_MISSING`),
- la **línea exista** (`E-LINE_OUT_OF_RANGE`, AC-5),
- y la conjunción **matchee ESA línea** (AC-2).

**Lo único que se exceptúa es el `hits === 1`.**

🔴 **Esto es lo que impide que el guardián se neutralice a sí mismo.** Sin esta cláusula, cualquiera que
vea un rojo escribe una excepción y el guardián deja de medir — que es **el modo de falla de todo
archivo de excepciones que existe**. **Escribí CD-14 en el docblock de `exceptions.ts`, con esa fuerza.**

## 8.3 CD-12 — `symbolPath: []` no es un escape

El guard **compara `symbolPath` contra el resolver**. `[]` cuando el resolver devuelve algo → rojo
(`E-SYMBOL_OMITTED`). **Sin esto, `[]` sería el apagador de AC-4** y las 45 entradas se declararían con
`[]` el primer día de fricción.

---

# 9. CD-1 / AC-12 — la separación se cumple **MECÁNICAMENTE**, no por disciplina

> El work-item pedía rechazar el diseño en el SDD si se solapaba con `G-08`/`G-09`/`G-10`.
> **El SDD lo cerró con tres mediciones. No tenés que verificarlo de nuevo — tenés que NO romperlo.**

## 9.1 Las tres mediciones

1. ✔ Los **41 pares `{file,line}`** de `test/ownership-filter-guard.exceptions.ts` **nunca producen el
   token `archivo:N`**: cada par se escribe en **dos líneas separadas** (`file: 'src/...'` y
   `line: 1178`). ⇒ **el escáner no los puede ver, ni queriendo.**
2. ✔ En el Corte A hay **CERO** tokens con target `doc/sdd/_INDEX.md` ⇒ **cero** solapamiento con
   `G-F1`/`G-F2` **hoy**.
3. El solapamiento es posible **mañana**: si alguien agrega `doc/sdd/_INDEX.md:N` a un archivo del
   Corte A, `G-C4` exigiría declararla y **eso sí duplicaría a `G-F1`**. ⇒ `DELEGATED_TARGETS` + **`G-C9`**
   (rojo si el dueño desaparece).

## 9.2 🔴 POR QUÉ los 41 están afuera — no es "no importan", es que **ya tienen testigo mejor**

Y esto hay que entenderlo, porque si lo leés como "quedan sin cubrir" vas a querer cubrirlos:

| Guardián existente | Qué garantiza, ✔ verificado por mí |
|---|---|
| `test/ownership-filter-guard.test.ts:317-320` | **La clave del match ES `archivo:línea`**: `const key = (file, line) => \`${file}:${line}\`` y el `Set` de excepciones se arma con esa clave. ⇒ testigo **con precisión de línea, en las DOS direcciones**. |
| `G-09` (`:613`) | Se pone **rojo** cuando una excepción ya no corresponde a su sitio, **y su mensaje nombra literalmente este caso** (*"o la consulta se movió de línea"*). Incluye el invariante estricto `:630` (`UNFILTERED.length === EXCEPTIONS.length`) y el piso `:629` (`>= 35`). |
| `G-10` (`:633`) | Cruza `table`/`verb` contra la cadena real — es un `mustContain` semántico **ya implementado** — y rechaza motivos duplicados (`:651-655`). |

⇒ **Re-cubrirlos sería el duplicado exacto que `test/payment-guards-live-in-one-place.test.ts:9-14`
existe para prevenir.** ✔ Su docblock, textual: *"los dos criterios coinciden [el día que se escriben],
así que toda la suite sigue verde. Lo que cambia es después — la próxima corrección de borde se aplica
en un lado y no en el otro, y el desacuerdo aparece como un rechazo inexplicable en un camino de
dinero."*

⚠️ **Lo que en `ownership-filter-guard.exceptions.ts` SÍ sigue sin testigo son sus ANCLAS DE PROSA**
(`[HEREDADO]`: **40** = 14 con nombre de archivo + 26 sólo `:N`), que apuntan a **otro** archivo que el
par estructurado. **Ésas son Corte B, no Corte A.** No las toques en esta HU.

---

# 10. Files to Create / Modify

## 10.1 Crear (4 archivos, todos en `test/`)

| # | Archivo | ✔ Verificado que NO existe | Exemplar |
|---|---|---|---|
| 1 | `test/cited-lines-guard.scanner.ts` | ✔ libre | `test/ownership-filter-guard.scanner.ts` |
| 2 | `test/cited-lines-guard.citations.ts` | ✔ libre | `test/sdd-index-matches-folders.exceptions.ts:160-192` |
| 3 | `test/cited-lines-guard.exceptions.ts` | ✔ libre | `test/ownership-filter-guard.exceptions.ts` |
| 4 | `test/cited-lines-guard.test.ts` | ✔ libre | `test/ownership-filter-guard.test.ts` |

✔ **Verificado por mí que estos 4 archivos nuevos no rompen nada:**
- `test/test-files-are-run-in-ci.test.ts:2-3` — su alcance es **`*.test.*`**, así que los **3 archivos
  no-test** quedan afuera. **Precedente en el mismo directorio**: `ownership-filter-guard.{scanner,exceptions}.ts`
  ya existen y conviven.
- `vitest.config.ts:5` = `include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.test.mjs']`
  y `:16` = `passWithNoTests: false` ⇒ **`cited-lines-guard.test.ts` entra por glob, sin tocar config.**

## 10.2 Modificar — SÓLO COMENTARIOS (CD-2 + CD-10)

| Archivo | Línea | Cambio | Neutralidad |
|---|---|---|---|
| `src/types/index.ts` | `:207` | `` `:777` `` → `` `:922` `` | 3 chars → 3 chars |
| `src/types/index.ts` | `:510` | `reputation.ts:182-183` → `reputation.ts:189` | ⚠️ **el texto se acorta — cuidá que no se re-envuelva el párrafo** |
| `src/types/index.ts` | `:1450` | `compose.ts:130` → `src/services/compose.ts:571` | ⚠️ **el texto se alarga — MÁXIMO riesgo de re-envolver** |
| `src/services/compose.ts` | `:688` | `:208` → `:571` | 4 chars → 4 chars |
| `src/routes/agents.ts` | `:47` | `registries.ts:35` → `registries.ts:94` | 2 chars → 2 chars |

⛔ **`test/sdd-index-matches-folders.exceptions.ts:15` NO SE TOCA** — **CD-15**, ver §0.2.

## 10.3 ⛔ NO se toca

`doc/sdd/_INDEX.md` (✔ la fila 224 ya está en `:216`, última fila — **CD-5**) ·
`doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md` (**CD-9**) ·
`test/payment-guards-live-in-one-place.test.ts` (**CD-7** — es del Corte A como **citador**, sus 2 citas
se **declaran**, pero **ni un assert se toca**) · `vitest.config.ts` · `tsconfig.json` · `package.json` ·
**cualquier línea de lógica de producción** (**CD-2**).

---

# 11. Waves — el orden importa, y el porqué también

> ⚠️ **El guardián está ROJO desde W2 hasta el final de W4, POR DISEÑO.** Es `G-C4` (*"cita nueva sin
> declarar = rojo"*) y al principio **ninguna** está declarada. **NO interpretes ese rojo como error.
> NO lo apagues con un escape.** El criterio de avance está en la columna "Verde cuando".

## W-1 · Environment Gate — OBLIGATORIO antes de tocar código

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a

# 1. Base correcta
/usr/bin/git rev-parse HEAD          # esperado: b31ddba6206de28f063eb867d78d7f53e4de450e
/usr/bin/git rev-parse --abbrev-ref HEAD

# 2. Crear la rama (verificada libre en F2/F2.5)
/usr/bin/git checkout -b feat/224-citas-archivo-linea-sin-testigo
echo "exit=$?"

# 3. El archivo PROHIBIDO sigue intacto (CD-9)
md5sum doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md
# esperado EXACTO: 7904ef74a1c46d7880e0ca5d38e3eed4

# 4. typescript disponible para el resolver (DT-10)
node -e "console.log(require('typescript').version)"     # esperado: 6.0.3

# 5. Los 14 paths del Corte A están en el índice de git
rtk proxy git ls-files > /tmp/idx.txt
wc -l < /tmp/idx.txt          # control positivo: NO puede dar 0 ni vacío. F2.5 midió 1823.

# 6. Los 4 archivos nuevos están libres
ls test/cited-lines-guard.* 2>/dev/null; echo "exit=$? (2 = no existen = OK)"

# 7. biome resuelve
ls -l ./node_modules/.bin/biome
```

🔴 **Si algo falla acá: PARÁ y reportá.** No implementes sobre un entorno roto.
⚠️ **Si `wc -l < /tmp/idx.txt` da 0**: usaste `git ls-files` en vez de `rtk proxy git ls-files`.
Ése es el cero falso número uno de este repo.

---

## W0 · Contratos y escáner (SERIAL — nada depende de nada)

| Archivo | Acción |
|---|---|
| `test/cited-lines-guard.scanner.ts` | **CREAR**. Los 4 exports de §7.3. **Puro sobre strings.** `import ts from 'typescript'`. |
| `test/cited-lines-guard.citations.ts` | **CREAR**. `interface CitedLine` (§7.1) + `CITED_LINES = []` + `DELEGATED_TARGETS` + `CORTE_A_PATHS` (los **14** de §5.1). |
| `test/cited-lines-guard.exceptions.ts` | **CREAR**. Los 3 arrays de §7.2, **vacíos**, con sus docblocks de motivo (**CD-14** escrito acá). |

**Verde cuando**: los 3 módulos importan sin error.
```bash
npx tsx -e "import('./test/cited-lines-guard.scanner.ts').then(()=>console.log('scanner OK'))"
```
⚠️ **No redirijas la salida de `vitest` a un archivo** (trunca a 500 chars con exit 0).

---

## W1 · 🎯 EL INSTRUMENTO SE PRUEBA **ANTES** DE USARSE

| Archivo | Acción |
|---|---|
| `test/cited-lines-guard.test.ts` | **CREAR** con **`G-C1`, `G-C2`, `G-C3`, `G-C10` SOLAMENTE**. |

**Verde cuando**: los **4 pasan**. **Son verdes desde el primer minuto y NO dependen del registro.**

### 🔴 Por qué W1 va antes de W2, y no es burocracia

**Esta noche, en esta misma máquina, DOS arneses de mutación produjeron resultados FALSOS:**

| Arnés | Qué hizo mal | Qué produjo |
|---|---|---|
| A | Restauró con `git checkout --` | **Borró lo que medía**, y dio **6 `SOBREVIVE`** que **confirmaban exactamente lo que el operador esperaba** |
| B | Salió **sin restaurar** | Dejó **5 de 7** sustituciones aplicadas en el árbol |

🔴 **A los dos los cazó el `md5`, NO la lectura del resultado.**
⇒ **Un instrumento no probado FABRICA la evidencia que uno espera.**
Si el escáner y el resolver no están probados con fixtures **antes** de que empieces a declarar 45
entradas, **las 45 se escriben contra un instrumento no verificado** y el verde final no dice nada.

---

## W2 · El guardián propiamente dicho

| Archivo | Acción |
|---|---|
| `test/cited-lines-guard.test.ts` | **MODIFICAR**: agregar `G-C4` … `G-C9`. |

**Verde cuando**: `G-C1..G-C3`, `G-C9`, `G-C10` verdes **y `G-C4` ROJO enumerando EXACTAMENTE 45 citas
sin declarar.**

🔴 **El criterio de éxito de W2 ES el número.** Tiene que enumerar **45**, no 42 ni 49.
- **42** ⇒ te comiste los 3 P4 (el regex de la cuarta forma está mal). **Ahí adentro está la cita falsa
  del camino del dinero (item 34).**
- **≠ 45 por otro lado** ⇒ tu escáner difiere de las **dos** derivaciones independientes (SDD y F2.5).
  **Reconciliá ANTES de seguir.** La distribución esperada es **P1=14 · P2=12 · P3=16 · P4=3**, y el
  desglose por archivo está en §5.1 — **compará archivo por archivo, no sólo el total**: un total que
  cierra puede tener dos errores que se compensan.

```bash
npx vitest run test/cited-lines-guard.test.ts
echo "exit=$?"
```

---

## W3 · Las **18** anclas de los archivos con citas falsas (+ sus **5** correcciones)

| Archivo | Acción | Anclas |
|---|---|---|
| `test/cited-lines-guard.citations.ts` | **MODIFICAR**: 18 entradas **a mano** | — |
| `src/types/index.ts` | **SÓLO COMENTARIOS**: `:207`, `:510`, `:1450` | 9 |
| `src/services/compose.ts` | **SÓLO COMENTARIO**: `:688` (`:208`→`:571`) | 5 |
| `src/routes/agents.ts` | **SÓLO COMENTARIO**: `:47` (`registries.ts:35`→`:94`) | 2 |
| `test/sdd-index-matches-folders.exceptions.ts` | **declarar solamente** — ⛔ **CD-15: NO corregir** | 1 |
| `src/services/agent.payment.test.ts` | **declarar solamente** (✔ su cita ya es correcta) | 1 |
| | | **18** |

### 🔴 CD-10 — línea-neutra, y acá están las **VÍCTIMAS CONCRETAS MEDIDAS**

**No es una regla abstracta. Si tu edición corre una línea, rompés estas dos citas del propio Corte A:**

| Víctima ✔ medida por mí | Por qué se rompe |
|---|---|
| `src/services/compose.ts:1548` cita `types/index.ts:217-218` | **Cita ENTRANTE**. `:207` (que editás) está **antes** de `:217-218` ⇒ una línea de más en `:207` corre el target. |
| `src/types/index.ts:288` cita `` `:203-225` `` | **AUTO-CITA cuyo rango CONTIENE `:207`.** Editar dentro del rango sin neutralidad lo corre. |

⇒ **Una edición no-neutra en W3 pondría rojo el guardián que estás construyendo, en la misma wave.**
Y es **el mismo error que se cometió anoche** (`[HEREDADO]`: `MNR-1` y `MNR-4` del auto-blindaje de la
HU 214 — *"desplacé una cita sin re-abrirla"*, **≥2 apariciones** ⇒ es el patrón recurrente que
originó CD-4 y CD-10).

### Verificación de neutralidad — **DOS instrumentos, porque uno solo da cero falso**

```bash
# ANTES de editar, por cada archivo:
wc -l src/types/index.ts src/services/compose.ts src/routes/agents.ts

# DESPUÉS de editar:
/usr/bin/git diff --numstat src/types/index.ts src/services/compose.ts src/routes/agents.ts
#   -> tiene que dar  N  N  (añadidas == borradas) en CADA fila
wc -l src/types/index.ts src/services/compose.ts src/routes/agents.ts
#   -> tiene que dar EXACTAMENTE los mismos números que antes
```
🔴 **`git diff` bajo el hook TRUNCA con exit 0.** Usá **`/usr/bin/git`** o el `--numstat` te va a decir
que todo está bien cuando no lo está. **Ése es el cero falso que esta HU existe para cazar.**

Largos ✔ medidos por mí en `b31ddba` (control): `src/types/index.ts` = **2318** ·
`src/services/compose.ts` = **1804** · `src/routes/agents.ts` = **599**.

### CD-4 aplica a las 18

**Abrí cada línea.** Incluidas las 5 de la tabla §5.5 y las 4 needles candidatas. **§0.2 es la prueba
de que un número heredado de un documento cuidadoso puede estar mal.**

**Verde cuando**: `G-C4` rojo con **27** pendientes (45 − 18) **y CERO fallos** de
`G-C5`/`G-C6`/`G-C8` sobre las 18 declaradas.

---

## W4 · Las **27** restantes

`src/lib/operator-address.ts` (6) · `src/routes/agents.publish.test.ts` (6) ·
`src/routes/agents.ownership.test.ts` (5) · `CLAUDE.md` (3) · `src/lib/payment-spec-reader.ts` (2) ·
`src/services/fee-split.ts` (2) · `test/payment-guards-live-in-one-place.test.ts` (2) ·
`src/services/agent.ts` (1). **= 27** ✔

Sólo se modifica `test/cited-lines-guard.citations.ts`.
⚠️ **Y `src/`/`CLAUDE.md` únicamente si alguna resulta falsa** — en ese caso, **CD-10** otra vez.

⚠️ **W3 y W4 NO son paralelizables entre sí**: las dos escriben en
`test/cited-lines-guard.citations.ts`. **Serial, mismo autor.**

**Verde cuando**: **los 10 controles verdes.** Éste es el **primer** momento en que `npm test` puede
pasar.

```bash
npx vitest run test/cited-lines-guard.test.ts   # primero SOLO el archivo
echo "exit=$?"
npm test                                        # UNA vez, y sólo acá
echo "exit=$?"
./node_modules/.bin/biome check src/
echo "exit=$?"
npx tsc --noEmit
echo "exit=$?"
```

🔴 **Si aparece un rojo con la firma `X is not a function`: re-corré SÓLO ese archivo antes de
creerle.** `[HEREDADO]`: está medido que es el modo de falla de esta máquina con 3 agentes concurrentes
(un namespace que resuelve vacío produce rojos que se leen como bugs reales).

---

## W5 · El docblock de no-cobertura (AC-10) + la reconciliación de números

| Archivo | Acción |
|---|---|
| `test/cited-lines-guard.test.ts` | **MODIFICAR**: docblock con los **10 ítems** de §11.5 + D-2 (la ironía) + el mecanismo del defecto. |
| `test/cited-lines-guard.scanner.ts` | **MODIFICAR**: docblock **"LO QUE ESTE ESCÁNER NO VE"**, con los FP de P4 y el límite de la prosa suelta. Exemplar ✔: `test/ownership-filter-guard.scanner.ts:15-35` (el docblock cierra en `:36`). |

### 🔴 La advertencia sobre los números del docblock

**Todo número que escribas ahí (45, 749, 20.550, 6,0 %) es una FOTO, y `G-C1` sólo verifica un PISO**
⇒ **envejece en silencio, que es exactamente el defecto de esta clase.**

⇒ **El docblock DEBE decir de dónde se deriva cada número** (*"correr el escáner sobre
`CORTE_A_PATHS`"*) en vez de sólo declararlo. Precedente vivo en el repo: `CLAUDE.md:250` dice
*"no te apoyes en el número de acá: derivalo"* y nombra la función que lo deriva.

**Verde cuando**: `G-C10` verde con **≥ 8** ítems y los 3 literales que AC-10 exige.

### 11.5 · Los 10 ítems de no-cobertura (AC-10)

1. **Las citas en archivos NO trackeados por git.** ✔ Caso medido y grave: `.nexus/project-context.md`
   — **el documento que le pide al lector verificar sus citas es inalcanzable por construcción** (D-2).
2. **Las citas en prosa suelta** (*"la línea 95"*, *"el guard de más abajo"*). Sin forma sintáctica.
   **Es la razón por la que 45 es un PISO y no un total.**
3. **El VALOR semántico de la afirmación.** El guardián verifica que la línea diga lo declarado; **no**
   que la prosa alrededor sea verdadera. ⇒ *número bien + conclusión falsa* **pasa en verde**.
4. **El 94 % de `src`+`test`** (704 de 749 anclas) y el **99,8 %** del repo.
5. **Los 41 pares `{file,line}` de `ownership-filter-guard.exceptions.ts`** — dueño `G-08`/`G-09`/`G-10`.
   No es un hueco, es una **delegación**; pero **se lee igual si no está escrito**.
6. **Las citas a `doc/sdd/_INDEX.md`** — dueño `G-F1`/`G-F2`, vigilado por `G-C9`.
7. **Las citas que apuntan a una línea correcta de un archivo que dejó de ser el relevante** (el
   refactor movió el candado a otro módulo y la vieja línea sigue existiendo, diciendo lo mismo).
8. **Los rangos `A-B`**: se verifica que la conjunción caiga **dentro** del rango, **no** que las
   B−A+1 líneas sigan diciendo lo que la prosa afirma del bloque entero.
9. **`README.md`, `doc/INTEGRATION.md` y las 20.550 anclas de `doc/`** — Corte D, y **hoy es un
   programa, no una HU**.
10. **La cita que se escribe en un archivo FUERA de los 14 paths.** El universo es explícito: **un
    archivo nuevo no entra solo.** ⇒ cada corte siguiente tiene que ampliar `CORTE_A_PATHS`, y
    **mientras no se amplíe, el silencio es real.**

⚠️ **Ítem 11 opcional pero recomendado**: este documento (`story-file.md`) y el `sdd.md` viven en
`doc/sdd/`, que **no está en el universo de ningún corte**. **Las citas de los propios artefactos de
esta HU no tienen testigo tampoco.** §0.2 es la prueba empírica de que eso importa.

---

# 12. Los 10 controles — cada uno con **su mutante escrito adentro del `it(`**

> **Formato OBLIGATORIO**, copiado del exemplar ✔ (`test/ownership-filter-guard.test.ts:483`, `:497`,
> `:514`): **cada `it(` arranca con un comentario `// Input que lo pone en rojo: …`.**
> El mutante **va escrito dentro del test**, no en un reporte que nadie relee.

| Control | AC | Qué afirma | 🔴 Mutante que lo mata (input concreto) |
|---|---|---|---|
| **G-C1** — armado del universo | AC-6, AC-7 | Los **14** paths declarados están **todos** en el índice de git; el barrido devolvió **≥ 40** anclas; **y cada una de las 4 formas tiene ≥ 1** población real (✔ hoy 14/12/16/3). | Borrar un path → el conteo deja de ser 14. Romper el regex de P4 → `P4 === 0` → rojo. Un `ls-files` que devuelva vacío → 0 archivos → rojo. 🔴 **Sin el piso POR FORMA, romper P4 sólo bajaría el total de 45 a 42 y el guardián seguiría verde — que es la falla medida de WKH-316.** |
| **G-C2** — el escáner no es vacuo | AC-7, AC-11 | Fixtures **en memoria** con la respuesta conocida: las 4 formas, `./`, `../`, un rango `A-B`, y `::1` que **NO** debe reportarse. | Un escáner que **no reporte nunca** (los 8 positivos quedan en 0). Uno que **reporte siempre** (`::1` aparece). **Quitar el `./` del regex → el caso `./splash.tsx:245` desaparece.** |
| **G-C3** — el resolver no es vacuo | AC-4, AC-7 | Fixtures: función anidada en clase → `['C','m']`; docblock de cabecera → `[]`; `it('…')` → el nombre del test; `PropertySignature` en dos type literals → los 3 nombres. | Un resolver que devuelva siempre `[]` (los 3 positivos fallan). Uno **sin whitelist de kinds** → aparece `add`/`from` (✔ **es la variante que se descartó midiendo**, §6.3). Uno que use `getStart` en vez de `getFullStart` → **el docblock deja de mapear a su declaración**. |
| **G-C4 ★** — toda cita está declarada | **AC-1** | Toda cita que el escáner encuentra en los 14 paths está en `CITED_LINES`, en una excepción, o es target delegado. **Y el invariante ESTRICTO**: `encontradas === declaradas + exceptuadas + delegadas`. | Agregar `// ver foo.ts:42` a `src/types/index.ts` → rojo con archivo, línea **derivada** y token. 🔴 **Sin el invariante estricto, una entrada declarada que ya no existe en el fuente no se nota** (es AC-8 — por eso además `G-C7`). Exemplar del invariante ✔: `ownership-filter-guard.test.ts:630`. |
| **G-C5** — el ancla sigue ahí, y es única | AC-2, AC-3, AC-5 | Por entrada: los 9 códigos de §7.4. | Mover `compose.ts:571` de sitio → `E-LINE_MOVED` con el número nuevo. Declarar `mustContain:['i > 0']` → `E-NEEDLE_VACUOUS` con los ✔ **5 hits reales**. `line: 99999` → `E-LINE_OUT_OF_RANGE`. Declarar `target:'src/routes/compose.ts'` → `E-WRONG_FILE` apuntando a `services/`. |
| **G-C6** — el símbolo contenedor es el declarado | AC-4 | El `symbolPath` declarado es **subsecuencia ordenada** del path que el resolver da en `line`; `[]` sólo si el resolver da `[]`. | Mover la cita de `:571` a `:208` **dejando la needle** → ✔ el resolver da `compose` vs `executePipeline` → `E-SYMBOL_DRIFT`. Vaciar un `symbolPath` → `E-SYMBOL_OMITTED`. |
| **G-C7** — ninguna entrada sobrevive a su sitio | AC-8 | Toda entrada de `CITED_LINES` corresponde a un token que el escáner **encuentra HOY** en su `from`. | Borrar el comentario citador y dejar la entrada → rojo. Simétrico de `G-09` ✔ (`ownership-filter-guard.test.ts:613`). |
| **G-C8** — forma y motivo, en **RUNTIME** | AC-9, DT-4 | `mustContain` no vacío y sin strings de < 4 chars; `line ≥ 1` entero; motivos ≥ 40 chars y **únicos palabra por palabra**; `targetReason` presente cuando DT-11 lo exige. | `mustContain: []` → **compila, no rompe lint, ENTRARÍA AL REPO** (✔ `package.json:11` = `biome check src/`, no lintea `test/`; `tsconfig.json:19` = `include: ["src/**/*"]`, no lo typechequea). Dos excepciones con el mismo motivo → rojo, igual que ✔ `G-10` (`:651-655`). |
| **G-C9** — la delegación tiene dueño **vivo** | CD-1 | Cada `DELEGATED_TARGETS[i].ownedBy` sigue existiendo: `CITED_INDEX_LINES` está en `test/sdd-index-matches-folders.exceptions.ts` **y** los `it(` de `G-F1`/`G-F2` están en su test. | Borrar `G-F2` → rojo acá. 🔴 **Sin este control, borrar `G-F2` dejaría los `_INDEX.md:N` sin dueño y sin que nada avise — con `G-C4` descartándolos en silencio.** ⚠️ **Población hoy = 0, y el control NO afirma que sea > 0** (eso sería un candado que se pudre solo): afirma que **la delegación tiene dueño**. |
| **G-C10** — el guardián declara lo que NO cubre | AC-10 | El docblock contiene la sección de no-cobertura con **≥ 8** ítems, **e incluye literalmente los tres** que AC-10 exige (no trackeados por git · prosa suelta · el VALOR de la afirmación). | Borrar la sección → rojo. Precedente ✔: el docblock de `ownership-filter-guard.test.ts` cierra en `:134` y **su función es exactamente ésta**. |

**Cobertura de los 12 ACs**: AC-1→`G-C4` · AC-2→`G-C5` · AC-3→`G-C5` · AC-4→`G-C6`+`G-C3` ·
AC-5→`G-C5` · AC-6→`G-C1` · AC-7→`G-C1`/`G-C2`/`G-C3` · AC-8→`G-C7` · AC-9→`G-C8` · AC-10→`G-C10` ·
AC-11→`G-C2` (ampliado a 4 formas) · **AC-12→§9** (es un AC sobre el diseño; se cierra ahí, no genera
control).

> ⚠️ El work-item reservó `G-C1..G-C9`. **Son DIEZ**, y el porqué: **AC-10 es verificable mecánicamente
> y merece su propio `it(`.** Meterlo dentro de otro control lo haría **invisible en la salida de CI**,
> que es justo donde tiene que leerse.

## 12.1 Fixtures mínimos de `G-C2` (en memoria, respuesta conocida de antemano)

| Fixture | Esperado |
|---|---|
| `// ver src/services/agent.ts:721` | 1 cita **P1**, `path='src/services/agent.ts'`, `num=721` |
| `// ver ./splash.tsx:245` | 1 cita **P1 con `./`** — ⚠️ **el caso que otro repo perdió** |
| `// ver ../adapters/solana/chain.ts:84` | 1 cita **P1 con `../`**, normalizada contra el dir del citador |
| `// ver agent.ts:721` | 1 cita **P2**, sin path resoluble |
| ``// ver `:692` `` | 1 cita **P3** |
| `// guard i>0 de :208` | 1 cita **P4** — **el caso real del camino del dinero** |
| `// ver types/index.ts:203-225` | 1 cita con `endNum=225` |
| `const local = '::1';` | **0** citas (el FP medido) |
| `const url = 'https://x:8443/y';` | **1** cita P4 → confirma que el ruido cae del lado **RUIDOSO** (se exceptúa, **no se adivina**) |

## 12.2 Fixtures mínimos de `G-C3`

| Fixture | Esperado |
|---|---|
| clase `C` con método `m` | `['C','m']` |
| docblock de cabecera (línea 1) | `[]` |
| `it('AG-01: …')` | el nombre del test |
| `PropertySignature` a 3 niveles de type literal | los 3 nombres |

---

# 13. 🔴 El arnés de mutación — reglas OBLIGATORIAS

> **Por qué esto es normativo y no un consejo**: esta noche **dos arneses produjeron resultados falsos**
> (§W1). **A los dos los cazó el `md5`, no la lectura del resultado.**

| # | Regla | Por qué |
|---|---|---|
| 1 | **Restaurá desde una COPIA PROPIA** que hiciste antes de mutar. | ⚠️ **`git checkout --` NO restaura un archivo untracked**, ni el pre-mutante de un archivo que **vos ya editaste** en la misma wave. El arnés A restauró así y **borró lo que medía**. |
| 2 | **Verificá la restauración por `md5` contra tu PRE-REGISTRO**, nunca contra `HEAD`. | En W3/W4 los archivos **ya difieren de `HEAD` legítimamente**. Comparar contra `HEAD` da rojo siempre o verde siempre, según cómo lo escribas. |
| 3 | **ABORTÁ si el ancla no aparece EXACTAMENTE N veces** en el fuente antes de sustituir. | ⚠️ **Un ancla que aparece dos veces no se aplica donde creés, y NO TE ENTERÁS.** Verificá la sustitución **por el TEXTO RESULTANTE**, no por el exit code de la herramienta. |
| 4 | **NO salgas sin restaurar.** Restauración en `trap`/`finally`, y **verificá con `md5` + `/usr/bin/git status --porcelain` después**. | El arnés B salió sin restaurar y dejó **5 de 7** sustituciones vivas en el árbol. |
| 5 | **Un mutante que "SOBREVIVE" y confirma lo que esperabas es sospechoso**, no un resultado. | El arnés A dio **6 `SOBREVIVE`** que **confirmaban exactamente la hipótesis del operador**. Ver "la evidencia que se auto-confirma". |
| 6 | **Sustituí por REEMPLAZO, no por borrado.** | `[HEREDADO]`: borrar una línea con cola de sintaxis tumba N archivos por `PARSE_ERROR`, que leído rápido es **un KILLED espectacular y falso**. |

### Esqueleto mínimo

```bash
F=test/cited-lines-guard.citations.ts
cp "$F" /tmp/pre.$$                       # 1: copia PROPIA
md5sum /tmp/pre.$$                        # 2: pre-registro
command grep -c 'ANCLA_EXACTA' "$F"       # 3: tiene que dar EXACTAMENTE N; si no, ABORTÁ
trap 'cp /tmp/pre.$$ "$F"; md5sum "$F" /tmp/pre.$$; /usr/bin/git status --porcelain "$F"' EXIT   # 4
# ...mutar por reemplazo, verificar el TEXTO resultante, correr el test...
npx vitest run test/cited-lines-guard.test.ts; echo "exit=$?"   # exit code DIRECTO, sin pipe
```

⚠️ **El candado que deriva de `git ls-files` deriva del ÍNDICE**: un archivo **nuevo no cuenta hasta
que lo agregás** (`/usr/bin/git add`). `[HEREDADO]`: eso **ya hizo pasar una puerta en verde y explotar
la siguiente**. ⇒ **Antes de correr `G-C1` sobre los archivos nuevos, `git add` primero.**

---

# 14. Anti-Hallucination Checklist — específico de esta HU

Marcá cada uno **antes** de dar la HU por terminada:

- [ ] **Todo `mustContain` salió de ABRIR la línea**, no de este documento, no del SDD, no del
      work-item, no del mensaje de error del guardián (**CD-4 + CD-6 + CD-11**).
- [ ] **Ningún `symbolPath` se escribió sin correr el resolver** sobre esa línea (**CD-12**).
- [ ] **`test/sdd-index-matches-folders.exceptions.ts:15` NO está en el diff** (**CD-15**).
- [ ] **El registro NO tiene el campo `fromLine`** (§8.1).
- [ ] **`exceptions.ts` no exceptúa nada que no sea unicidad o anclaje de prosa** (**CD-14**).
- [ ] **El diff sobre `src/` contiene SÓLO líneas de comentario** — verificalo, no lo asumas:
      `/usr/bin/git diff -- src/ | command grep -n '^[+-]' | command grep -v '^\S*[+-][+-]'` y leelo.
- [ ] **Las 5 correcciones son LÍNEA-NEUTRAS**, verificadas con **`/usr/bin/git diff --numstat` Y `wc -l`**.
- [ ] **`G-C1` cuenta 14 paths** y **cada forma tiene ≥ 1** (no sólo el total ≥ 40).
- [ ] **`G-C4` enumeró 45 en W2**, con desglose **P1=14 P2=12 P3=16 P4=3**, comparado **archivo por
      archivo** contra §5.1.
- [ ] **Cada `it(` arranca con `// Input que lo pone en rojo: …`** y ese input **se corrió de verdad**.
- [ ] **Cada mutante corrido siguió las 6 reglas de §13**, con `md5` antes y después.
- [ ] **`md5sum doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md` = `7904ef74a1c46d7880e0ca5d38e3eed4`**.
- [ ] **`doc/sdd/_INDEX.md:144` intacta** — contiene las 3 needles de `G-F1`.
- [ ] **Toda cita que escribas en prosa (commits, reporte) lleva marca** ✔ / `[HEREDADO]` / `[NO MEDIDO]`.
- [ ] **Todo número de la suite que cites de un artefacto va marcado `[HEREDADO]`.**
- [ ] **Los dos porcentajes (6,0 % y 0,21 %) están en el docblock Y en el reporte** (**CD-8**).
- [ ] **Ningún número va suelto**: cada uno con su instrumento y con si es piso o total.

---

# 15. Out of Scope — no lo toques bajo ninguna circunstancia

- ⛔ **`codeOnly`** y **cualquier assert** de `test/payment-guards-live-in-one-place.test.ts` (**CD-7**).
  *Romperlo cambia un agujero de documentación por un agujero en un guard del camino del dinero.*
- ⛔ **Los 41 pares `{file,line}`** de `test/ownership-filter-guard.exceptions.ts` (**CD-1**, §9).
- ⛔ **Las 40 anclas de PROSA** de ese mismo archivo — **son Corte B**, no éste.
- ⛔ **`doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md`** (**CD-9**).
- ⛔ **`m5-keys/`**.
- ⛔ **Los otros dos repos** (`wasiai-remittance-agents`, `chaski-v3`) — `TD-316-CITAS-PORTABILIDAD`.
- ⛔ **`.nexus/project-context.md`** (**CD-13** + **D-2**).
- ⛔ **`README.md`, `doc/INTEGRATION.md`, `doc/**`** — Corte D.
- ⛔ **Cualquier línea de lógica de producción**, `supabase.rpc(...)`, RLS (WKH-SEC-02) (**CD-2**).
- ⛔ **NO pushear. NO tocar `main`.** El repo es **PÚBLICO**, está en **Railway** y **cobra x402**.
- ⛔ NO "mejorar" código adyacente. NO agregar dependencias (**ninguna** — `typescript` y `vitest` ya
  están en `devDependencies` ✔).

---

# 16. Done Definition

| # | Ítem |
|---|---|
| 1 | Los **4 archivos nuevos** creados y agregados al índice (`/usr/bin/git add`). |
| 2 | **Los 10 controles VERDES**: `npx vitest run test/cited-lines-guard.test.ts` → exit **0**. |
| 3 | **Las 45 anclas** declaradas, exceptuadas o delegadas — con `G-C4` verificando `encontradas === declaradas + exceptuadas + delegadas`. |
| 4 | **Las 5 correcciones** aplicadas y **línea-neutras**, con la evidencia de los dos instrumentos pegada en el reporte. |
| 5 | `npm test` exit **0** (corrido **una vez**, al final). `npx tsc --noEmit` exit **0**. `./node_modules/.bin/biome check src/` exit **0**. |
| 6 | El **docblock de no-cobertura** con ≥ 8 ítems, los 3 literales de AC-10, **la ironía de D-2**, y **cómo se deriva cada número**. |
| 7 | **Anti-Hallucination Checklist (§14) completo**, ítem por ítem, con la evidencia al lado. |
| 8 | **Auto-Blindaje escrito** (§17) — no al final "si sobra tiempo": **a medida que pasa**. |
| 9 | Reporte con los **dos porcentajes** (**CD-8**) y **cada cita marcada** ✔/`[HEREDADO]`/`[NO MEDIDO]`. |
| 10 | `md5` de **CD-9** re-verificado al cerrar. |

---

# 17. Auto-Blindaje — escribilo A MEDIDA QUE PASA

**Archivo**: `doc/sdd/224-citas-archivo-linea-sin-testigo/auto-blindaje.md`

🔴 **En esta HU el Auto-Blindaje NO es paperwork: es el mismo dato que la HU produce.**
Cada vez que escribas un número que resulte mal, **ése es el fenómeno bajo estudio**. §0.2 existe
porque el SDD escribió el suyo.

Formato por entrada:

```markdown
### [YYYY-MM-DD HH:MM] WN — <título en una línea, con el error, no con la solución>

- **Error**: qué escribí y qué había realmente. Con `archivo:línea` de las DOS cosas.
- **Cómo apareció**: ¿lo cazó un test? ¿un md5? ¿una re-lectura? ¿o me lo dijo alguien?
  (⚠️ si lo cazó "leer el resultado", desconfiá: los dos arneses de anoche pasaron esa prueba.)
- **Instrumento que lo habría cazado antes**: si existe, ¿por qué no corría?
- **Fix**: qué quedó, y **si fue línea-neutra** (`--numstat` + `wc -l`).
- **Clase**: ¿es el patrón recurrente "desplacé una cita sin re-abrirla"? ¿o uno nuevo?
```

### Patrones recurrentes ya identificados — si repetís uno, decilo

| Patrón | Origen | Ya convertido en |
|---|---|---|
| *"desplacé una cita sin re-abrirla"* | `MNR-1` **y** `MNR-4` de la HU 214 (**≥2 apariciones**) | **CD-4** + **CD-10** |
| *"copié un número de un documento en vez de abrir el archivo"* | El SDD de esta misma HU, §0.0 | **CD-4** |
| *"corregí una cita que estaba bien"* ⬅ **NUEVO, de este F2.5** | §0.2 | **CD-15** |
| *"un cero de grep se leyó como 'ya no está'"* | `auto-blindaje.md:612` de la HU 214 | **`E-WRONG_FILE`** (§7.4 paso 6) |
| *"el arnés de mutación fabricó la evidencia esperada"* | Dos arneses, esta noche | **§13, reglas 1-6** |

### Deuda a dejar declarada al cerrar

- **`TD-316-CITAS-PROJECT-CONTEXT`** — redacción textual en **D-2**. **No es "trackearlo".**
- **`TD-316-CITAS-PORTABILIDAD`** — los otros dos repos.
- **Cortes B / C / D** — B = las 40 anclas de prosa de `ownership-filter-guard.exceptions.ts`
  (`[HEREDADO]`: *"el corte de mayor valor de seguridad del repo"* — **cada una justifica una lectura
  cross-tenant citando un gate de admin, y eso hoy no lo vigila nada**); C = el resto de `src`+`test`
  (**664**); D = `doc/**` (**≤ 20.557**, 736 citadores — **un programa, no una HU**).

---

# 18. Escalation Rule

> **Si algo no está en este Story File, PARÁ y preguntá al Architect.**
> No inventes. No asumas. No improvises. No abras el SDD para completar.
>
> **Y hay un caso específico en el que PARAR es obligatorio:**
> si `G-C4` en W2 enumera un número **distinto de 45**, o si el desglose por forma no da
> **P1=14 P2=12 P3=16 P4=3** — **NO ajustes el número esperado.** Reconciliá el escáner contra §5.1
> archivo por archivo y **reportá la diferencia**. Un total que cierra puede tener dos errores que se
> compensan; y **§0.2 es la prueba de que el documento también puede estar mal.**

---

## Estado de este artefacto

| Ítem | Estado |
|---|---|
| Exemplars con line ranges | ✔ **Los 8 re-verificados por mí en este F2.5** (§10.1, §12, §9.2) |
| Universo (45 anclas) | ✔ **Re-derivado por mí con escáner independiente** — coincide archivo por archivo |
| Los 14 paths en el índice de git | ✔ **Los 14 verificados** |
| Las 5 citas falsas a corregir | ✔ **Las 5 re-abiertas por mí** |
| La 6.ª "cita falsa" del SDD (H-2) | 🔴 **DESMENTIDA por mí** — §0.2, **CD-15** |
| `[NEEDS CLARIFICATION]` | ✔ **Ninguno abierto** — los 2 del SDD llegaron **resueltos** con el `SPEC_APPROVED` (§2) |
| `[TBD]` | ✔ **Ninguno** |
| Prohibiciones de fase | ✔ Cero líneas de código de producción escritas; el único archivo escrito es este `story-file.md`; `main` intacto; nada pusheado; md5 de CD-9 verificado sin cambios |

**Artefacto**: `doc/sdd/224-citas-archivo-linea-sin-testigo/story-file.md`
**Siguiente paso**: **F3 (`nexus-dev`)** — sin gate humano intermedio.
