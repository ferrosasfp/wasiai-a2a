# Work Item — [WKH-371] Las citas sueltas se pudren en silencio, y el instrumento que las cuenta cuenta puertos

> **Fase F1 · Rol `nexus-analyst` · 2026-08-28 · Issue de origen: `ferrosasfp/wasiai-a2a#178`**

---

## ⚠️ CÓMO LEER LAS CITAS DE ESTE DOCUMENTO (léelo antes que nada)

1. **Este documento numera el árbol medido en F1** (`main`, working tree del 2026-08-28).
   Igual que la fila 226 de `doc/sdd/_INDEX.md` —que declara textualmente que sus
   `archivo:línea` numeran el árbol PREVIO a su HU y que **re-anclarlos volvería falsa la
   frase**— **este work-item NO se re-ancla** cuando el código se mueva. Es un registro de
   lo que se midió un día, no un puntero vivo. **CD-5 lo prohíbe explícitamente.**

2. **Cada cita lleva su procedencia.** Este F1 corrió **SIN SHELL**: sólo `Read`, `Write` y
   `Glob`. **No hubo `grep`, ni `git`, ni acceso a la red.**
   - `[MEDIDO-F1]` = abrí el archivo con `Read` y leí esa línea.
   - `[HEREDADO]` = me lo pasó el orquestador o está escrito en otro artefacto del repo. **No lo verifiqué.**
   - `[NO MEDIDO]` = no se pudo medir. **No es un cero: es una ausencia de instrumento.**

3. ⛔ **Ningún conteo de este documento es exhaustivo.** Sin `grep` no hay barrido. Todo
   número que doy es una **cota inferior obtenida abriendo archivos de a uno**, y está
   marcado como tal. El primer entregable de la HU es, precisamente, el instrumento que
   convierte estas cotas en mediciones.

---

## Resumen

Una cita `archivo:línea` escrita en **forma suelta** (`` `:60` ``, ` :208` — el número sin
el nombre del archivo al lado) se pudre cuando alguien inserta líneas más arriba, y
**ningún guardián de este repo la ve**. Los dos guardianes que existen —
`test/cited-lines-guard.test.ts` en este repo y `src/composition/citas-ancladas.test.ts` en
`chaski-v3` `[HEREDADO]`— funcionan, pero la forma suelta queda fuera de su universo **por
construcción**: sin el nombre del archivo, el guardián no sabe qué archivo abrir.

**Y el problema no es sólo que no se vean: es que nadie sabe cuántas hay**, porque el patrón
que las cuenta (`:[0-9]+`) también cuenta puertos, chain IDs, ratios, marcas de tiempo y
valores de propiedades JSON. **El primer entregable de esta HU no es el arreglo ni el conteo:
es el DISCRIMINADOR** — la forma de separar una cita de un puerto. Hasta que exista, cualquier
número que alguien diga sobre esta deuda es una afirmación sin instrumento.

---

## 🔴 F0 — LA PREMISA DEL ISSUE ESTÁ MEDIDA CON UN INSTRUMENTO ROTO

### Lo que el issue afirma, y por qué no se sostiene

El issue #178 afirma **«8501 tokens sueltos»** (`chaski-v3` 666 + `wasiai-a2a` 7835),
medidos el 2026-08-25 `[HEREDADO — no pude leer el issue, ver MI-1]`.

El propio `_INDEX.md` ya registra que ese número **depende del patrón**: la fila 226 dice
textualmente que los números del issue *«dependen del patron: 666/7835 con rangos, **592/4222**
con `` `:N` `` a secas»* (`doc/sdd/_INDEX.md:218`) `[MEDIDO-F1]`. **Dos patrones, dos
respuestas, un factor de ~1,85 entre ellas, y ninguna declara su perímetro.**

Re-medido por el orquestador el 2026-08-28 `[HEREDADO]`:

| Alcance | tokens `:N` | anclados (P1/P2) | "sueltos" (residuo) |
|---|---|---|---|
| `src` + `test` + `scripts` | 2146 | 676 | ~1470 |
| + `doc/` | 32107 | 17335 | ~14772 |

⇒ **el número se mueve un orden de magnitud según el alcance, y nadie lo declaró.**

### El problema real es peor: la mayoría de esos "sueltos" NO SON CITAS

Descomposición de `src/` (1710 tokens `:N`) `[HEREDADO]`:

```
anclados (traen archivo al lado)   538
chain IDs / CAIP-2                 125     eip155:43113 · eip155:84532
horas, ratios, PUERTOS             385     localhost:3001 · 1:1 · 1:50-2:10
⇒ candidatos reales               ~662     y ahí TODAVÍA sobran puertos
```

**Y esto no es una sorpresa: el repo ya lo tenía escrito.** El docblock del escáner
(`test/cited-lines-guard.scanner.ts`, nota (b) del bloque «LO QUE ESTE ESCÁNER NO VE») dice
que un `:N` suelto *«es indistinguible de un puerto (`:8443`, `:443`, `:80`), de un offset
(`:0`), del valor de una propiedad (`{reputation:100}`, `minLength:1`) o de un timestamp ISO
(`T00:00:00`)»*, y que descartarlos por rango *«sería inventar una heurística que mañana se
come una cita real a la línea 80»* `[MEDIDO-F1]`.

⇒ **el escáner de este repo declara por escrito que este discriminador NO EXISTE.** La HU
existe para construirlo, no para descubrir que falta.

### ⚠️ Un hallazgo de F0 que apunta en la dirección CONTRARIA y hay que anotar

Leí `src/adapters/chain-resolver.ts` entero (447 líneas) buscando la mezcla cita/puerto que
el análisis predice. Resultado medido: **el archivo tiene CERO tokens `:N`** `[MEDIDO-F1]`.
Y sin embargo cita otros archivos **nueve veces**: `registry.ts`, `settle-verifier.ts`,
`downstream-payment.ts`, `types.ts`, `doc/architecture/MULTI-CHAIN.md §10`, **todas sin
número de línea**.

⇒ **Existe una QUINTA forma que ningún escáner cuenta y que no puede pudrirse: la referencia
a nivel de ARCHIVO.** Es la forma dominante en `src/adapters/`, y es —probablemente— la
forma correcta para la mayoría de los casos. **Eso cambia la recomendación de la HU** (ver
DT-4): el arreglo de una cita suelta rota no siempre es anclarla; a veces es **borrarle el
número**, que es la única variante con costo de mantenimiento cero.

### Pero las citas sueltas DE VERDAD existen, y esta semana costaron caro

- En la muestra del orquestador apareció una viva: `` (+ `:60` walletClient sobre
  `kiteTestnet`, `:70` dominio EIP-712 …) `` `[HEREDADO]`.
- **HUs 230 y 231 (esta misma semana): 1 BLOQUEANTE y 5 MENORes de esta clase**, y el barrido
  de los README encontró **7 citas rotas, cinco de ellas CORRIDAS** (no mal escritas)
  `[HEREDADO]`.
- El `BLQ-2` de la 231 nació de **sumar un delta en vez de abrir la línea**: el
  desplazamiento real de la región era `+78` y se le aplicó `+64`, el delta de una pasada
  anterior (`doc/sdd/231-wkh-370-catalogo-vs-agentes-vivos/auto-blindaje.md`, bloque
  `BLQ-2 / MNR-2`) `[MEDIDO-F1]`.
- Ese mismo bloque trae la medición que define la severidad: **con dos citas apuntando a
  `:99999`/`:99998` —líneas inexistentes en un archivo de 950— `npm test` completo salió
  VERDE (`314 passed | 6 skipped (320)`, `6349 passed`)**. `[MEDIDO-F1, leído del artefacto]`
  **No hay ningún rojo que confirmar porque no hay guardián.**
- Y la 231 tuvo que re-derivar sus citas **CUATRO veces**, la última porque *«un párrafo de
  prosa que crece 3 renglones desplaza tanto como un `if`»* (mismo archivo, bloque
  `FIX-PACK · CUARTA pasada`) `[MEDIDO-F1]`.

### Por qué la forma suelta queda fuera del universo del guardián (mecanismo, no opinión)

`test/cited-lines-guard.scanner.ts` distingue cuatro formas `[MEDIDO-F1]`:

| Forma | Ejemplo | Cómo la produce el escáner | ¿Anclable? |
|---|---|---|---|
| **P1** | `src/services/agent.ts:721` | `FILE_CITE_RE` (`:121-122`), path **con** `/` | Sí |
| **P2** | `agent.ts:721` | `FILE_CITE_RE`, path **sin** `/` | Sí (basename) |
| **P3** | `` `:692` `` | `BARE_CITE_RE` (`:125`) + backticks a ambos lados (`:195`) | **No** |
| **P4** | `:208` | `BARE_CITE_RE`, sin backticks | **No** |

El registro `CITED_LINES` se clavea por `{from, cite-token}` y **exige un campo `target`**
(el archivo citado). Para P1/P2 el guardián puede CRUZAR el token contra el `target`
declarado (`citeMatchesTarget`); para P3/P4 **`citePathOf` devuelve `null`** y el cruce
mecánico **es vacuo por construcción** — queda dependiendo de un `targetReason` escrito a
mano `[MEDIDO-F1]`.

Y el propio guardián declara el agujero dos veces:
- punto **2** de su lista de no-cobertura: *«LAS CITAS EN PROSA SUELTA … Es la razón por la
  que el conteo de este guardián es un PISO y no un total, y no hay cota superior conocida»*
  (`test/cited-lines-guard.test.ts:118-123`) `[MEDIDO-F1]`;
- punto **14**: de los **261** tokens que los 4 archivos del propio guardián agregaron al
  repo, **102 son `:N` sueltos (P3/P4) sin archivo** (`:166-232`, desglose en `:182-183`)
  `[MEDIDO-F1]`. **El guardián de citas es, él mismo, el mayor productor de citas sueltas
  del repo.**

---

## 🎯 EL DISCRIMINADOR QUE SE PROPONE, Y SU PRECISIÓN MEDIDA

### La cascada (propuesta, a validar en F2)

**No es una heurística de rango.** Es una cascada de reglas **sintácticas** más **una** regla
de contexto, con un residuo `INDECIDIBLE` de primera clase. Cada capa se puede desactivar y
medir por separado.

| # | Regla | Qué mata | Fundamento medido |
|---|---|---|---|
| **D0** | `prev === ':'` | `::1` (IPv6) | Ya implementada, `scanner.ts:192` `[MEDIDO-F1]` |
| **D1** | el carácter **inmediatamente anterior** al `:` **no** puede ser `[A-Za-z0-9_]` | `localhost:3001`, `eip155:43113`, `1:50`, `T00:00:00`, `{reputation:100}`, `minLength:1` | En **todos** esos casos el `:` va pegado a un identificador o a un dígito. Una cita se escribe `` `:60` ``, ` :208`, `(:70` — precedida por backtick, espacio, paréntesis o inicio de línea |
| **D2** | el carácter anterior no puede ser `'` ni `"` | `{"key":1}`, y el **valor del campo `cite:`** de un registro declarado | Los `cite:` ya tienen testigo MEJOR (`G-C5`/`G-C7`); volver a contarlos es el duplicado que `payment-guards-live-in-one-place.test.ts` existe para prevenir |
| **D3** | en el **mismo párrafo** tiene que haber un token P1/P2 cuyo path esté **en el ÍNDICE DE GIT** | puertos y offsets citados en prosa *sobre* puertos | Reusa `citeTargetIfTracked` (`scanner.ts:251-267`), que **ya existe** y ya resuelve el caso `x.io:8443` (host no trackeado ⇒ no cuenta) `[MEDIDO-F1]` |
| **D4** | el token no puede ser el valor completo del campo `cite:`/`quote:` de un registro | los 89 tokens que son datos del registro (punto 14 del guardián) | Ídem D2: ya tienen testigo |
| **RESIDUO** | todo lo demás ⇒ **`INDECIDIBLE`**, va a una lista con motivo escrito | — | Un clasificador binario obliga a mentir en el borde |

### La medición, con su perímetro declarado y su límite escrito primero

⚠️ **ESTO ES UNA CALIBRACIÓN, NO UNA PRECISIÓN.** Las reglas D1–D4 las derivé **leyendo este
mismo archivo**, así que medirlas sobre él no dice nada sobre si generalizan. Es exactamente
el defecto *«controles que se leen a sí mismos»* que este repo ya tiene documentado. **AC-2
existe para que F2/F3 no pueda publicar este número como precisión.**

**Perímetro de la calibración, con su número: UN archivo, `test/cited-lines-guard.exceptions.ts`
(279 líneas), leído entero, 30 tokens P3/P4 etiquetados a mano uno por uno.** `[MEDIDO-F1]`

Elegido porque es el único lugar del repo con **etiquetas de verdad escritas a mano**:
`SCANNER_FALSE_POSITIVES` (`:247-278`) declara 3 tokens de ruido **con su motivo leído en el
sitio** `[MEDIDO-F1]`.

Etiquetas que puse (4 clases, no 2):

| Clase | n | Ejemplos |
|---|---|---|
| **CITA** (apunta a una línea real y puede pudrirse) | **11** | `:412` (`:163`), `:430` (`:175`), `:444` (`:185`), `:459`/`:475` (`:186`), `:320`/`:316` (`:111`) |
| **RUIDO** (puerto / offset / propiedad / timestamp) | **12** | `:8443`, `:443`, `:80`, `:0` (`:226`); `{reputation:100}` (`:254`); `minLength:1` (`:263`); `T00:00:00` ×2 (`:273`) |
| **DATO** (valor del campo `cite:`, ya tiene testigo) | **6** | `:250`, `:260`, `:270`, y los 3 backticked de `:160`/`:172`/`:182` |
| **ILUSTRATIVO** (ejemplo inventado, sin destino) | **1** | el `:336` genérico de `:47` |

Resultado de aplicar la cascada:

| Capas | Sobreviven | de ellos CITA | Falsos positivos | Falsos negativos | "Precisión" |
|---|---|---|---|---|---|
| D0 sólo (**hoy**) | 30 | 11 | 19 | 0 | **37 %** |
| D0+D1 | 26 | 11 | 15 | 0 | 42 % |
| D0+D1+D2 | 23 | 11 | 12 | 0 | 48 % |
| **D0+D1+D2+D3+D4** | **11** | **11** | **0** | **0** | **100 %** |

**El 100 % es la señal de que la medición no vale, no de que la regla sea buena.** Un
clasificador que acierta 11 de 11 sobre el archivo del que salió es un instrumento
comparándose contra su propia salida.

**Los falsos positivos y falsos negativos que SÍ valen** (los que la cascada tuvo que
aprender, con ejemplo de los dos lados):

- 🔴 **FP que mata a D1 sola, y es el caso más lindo del repo**: `exceptions.ts:47` escribe
  *«un `:336` que cita una línea de un `:8443` que es un puerto»* `[MEDIDO-F1]`. **El puerto
  está BACKTICKEADO**, o sea con la forma P3 más "de cita" que existe. Y `:226` tiene cuatro
  más: `` `:8443` ``, `` `:443` ``, `` `:80` ``, `` `:0` ``. ⇒ **los backticks NO discriminan
  nada**, y cualquier propuesta que se apoye en ellos ya está medida como falsa.
- 🔴 **FP que mata a D3 sin la condición de git**: `exceptions.ts:237` dice *«Las 3 entradas
  de hoy son `:100`, `:1` y `:00`»* — tres tokens de RUIDO — y el párrafo **sí** nombra un
  archivo (`https://x.io:8443/y`, `:238`) `[MEDIDO-F1]`. Sin exigir que el path esté en el
  índice de git, los tres sobreviven.
- 🟡 **FN potencial de D3, NO medido y declarado**: una cita suelta legítima cuyo párrafo
  nombra el archivo **sin número** (`ver \`agent.ts\`, en `:721``). D3 exige un token **P1/P2**,
  o sea con `:N`. Si el párrafo nombra el archivo a secas, D3 la descarta. **Esto es un
  falso negativo real y hay que medir su población en F2** — y la sospecha viene de un dato
  medido: en `chain-resolver.ts` **las nueve referencias son a nivel de archivo, sin número**.
- 🟡 **FN de D1, conocido y aceptado**: una cita escrita `ver linea:60` (identificador pegado
  al `:`) se pierde. Población `[NO MEDIDO]`; se acepta porque **degrada del lado ruidoso**
  (queda sin declarar y `G-C4` no la reclama), no del silencioso.

---

## 📐 EL PERÍMETRO QUE SE RECOMIENDA

**Corte 1 = `src/` + `test/` + `scripts/`. `doc/` se MIDE y NO se toca.**

| Universo | Entra al arreglo | Entra a la medición | Razón |
|---|---|---|---|
| `src/` | Sí | Sí | Es donde una cita rota engaña a quien audita un guard de dinero |
| `test/` | Sí | Sí | Ídem, y ahí vive el registro que justifica las excepciones de ownership |
| `scripts/` | Sí | Sí | Chico, y sus citas alimentan runbooks |
| **`doc/`** | ⛔ **NO** | **Sí, obligatorio (AC-3)** | **En `doc/` una cita suele ser REGISTRO HISTÓRICO, no un puntero vivo** |
| `.nexus/project-context.md` | ⛔ NO | No (no está en el índice de git) | `TD-316-CITAS-PROJECT-CONTEXT`: el repo es **PÚBLICO** |

**Por qué `doc/` NO se re-ancla, con dos precedentes escritos en este repo:**

1. `doc/sdd/_INDEX.md:218` (fila 226) declara textualmente: *«Todos los `archivo:línea` de
   ESTA fila numeran el árbol PREVIO a la HU … Re-anclarlos volvería falsa la frase: el
   `throw` de `compose.ts:1757` **ya no existe** (línea borrada, sin destino)»* `[MEDIDO-F1]`.
   **Re-anclar ahí no arregla una cita: fabrica una mentira.**
2. `doc/sdd/_INDEX.md:216` (fila 224) registra que **9** de los tokens del propio guardián son
   el token histórico `.gitignore:172` —*el bug que esa HU arregló, citado como ejemplo de lo
   que estaba mal*— y que meterlos al corte *«convertiría cada mención del bug en una cita
   rota»* `[MEDIDO-F1]`.

⚠️ **Y `doc/` SÍ es alcanzable por el guardián** — no está fuera por accidente. `.gitignore`
excluye archivos de `doc/sdd/**` **de a uno** (`:183-193`, once entradas individuales)
`[MEDIDO-F1]`, o sea que **el grueso de `doc/sdd/` está en el índice de git** y un corte
podría barrerlo. **Que no se barra es una DECISIÓN, y va escrita.**

**Lo que hay que medir en `doc/` antes de cerrar el perímetro (AC-3):** cuántos tokens
sueltos llevan **marcador histórico** cerca. El orquestador contó **392 con un patrón
grosero** `[HEREDADO — NO MEDIDO por mí, y el propio adjetivo "grosero" dice que es una
cota, no un número]`. La regla que propongo: un token de `doc/` es histórico **salvo que su
artefacto declare en su cabecera que numera el árbol vivo** — o sea **default histórico,
fail-closed hacia no tocar**, que es la dirección segura.

---

## ⚖️ ¿SE CONVIERTEN O SE ACOTAN? — las dos, con su costo

**NO pre-decidido en F1. Recomendación: ACOTAR (opción B), con la excepción escrita.**

### Opción A — CONVERTIR toda cita suelta a forma anclada

- **Costo medido, no estimado**: el remedio reproduce la enfermedad. La HU 231 re-derivó sus
  citas **cuatro veces**, y la cuarta fue porque *«los barridos miran lo que escribiste, no
  lo que desplazaste»* `[MEDIDO-F1]`. Convertir `` `:412` `` en `` `src/routes/agents.ts:412` ``
  alarga la línea, Biome la reparte, **y eso corre las líneas de abajo** — que es literalmente
  el defecto.
- **Costo adicional**: duplica el nombre del archivo N veces en el mismo párrafo. Cada
  duplicado es una cosa más que puede divergir.
- **Beneficio**: el guardián actual las cubre sin una línea de código nueva.

### Opción B — ACOTAR: un guardián que entiende la forma suelta usando el archivo del contexto

- **Costo**: es exactamente D3. Hay que escribir la resolución de contexto y su lista de
  `INDECIDIBLE`s, y hay que medirla. **Es la mayor parte del trabajo de la HU.**
- **Beneficio**: **diff de una línea por cita** (declararla en el registro), no de una línea
  por *carácter*. El texto del repo no se mueve ⇒ **no dispara la cascada de re-derivación**.
- **Riesgo declarado**: D3 puede resolver al archivo equivocado cuando el párrafo nombra
  dos. Ése es **exactamente el caso del issue** (se aplicó el desplazamiento `+29` del archivo
  equivocado en vez de `+7`) `[HEREDADO]`. ⇒ **si el párrafo nombra más de un archivo
  trackeado, el token es `INDECIDIBLE` y NO se resuelve solo.**

### Opción C — la tercera, que sale de un hallazgo de F0 y no estaba en el encargo

**BORRAR el número.** En `src/adapters/chain-resolver.ts` las nueve referencias a otros
archivos **no tienen número de línea** y **no se pueden pudrir** `[MEDIDO-F1]`. Para toda cita
cuya prosa no dependa del número exacto (*"ver `registry.ts`"*), quitarle el `:N` es el único
arreglo con **costo de mantenimiento cero**.

**Recomendación de F1 (a ratificar en F2):**
**B para las inequívocas · C para las que no necesitan el número · A SÓLO para las AMBIGUAS**
(párrafo con más de un archivo trackeado), que son las peligrosas y las pocas.

---

## Sizing

- **SDD_MODE: `full`**
- **Modo del pipeline: `QUALITY`** — **CONFIRMADO, no heredado.** `CLAUDE.md` dice que este
  repo es siempre QUALITY y el tablero lo tenía así; **igual va evaluado, con razones propias**:
  1. **El primer entregable es un INSTRUMENTO, y el instrumento anterior ya mintió.** El
     "8501" del issue lo produjo un patrón que cuenta puertos. **Un clasificador mal calibrado
     es PEOR que ninguno**: publica una lista que se lee como cerrada, y lo que quede afuera
     nadie lo vuelve a buscar.
  2. **El entregable es un GUARD, y este repo tiene historial MEDIDO de guards vacuos**: la
     fila 224 enumera 16 + 31 archivos revisados y deja **uno defectuoso con nombre**
     (`test/docs-referenced-by-code-exist.test.ts`) **todavía vacuo en `main`**
     (`doc/sdd/_INDEX.md:216`) `[MEDIDO-F1]`.
  3. **El arreglo toca comentarios adentro de archivos del camino del dinero**, y la
     inserción de prosa desplaza igual que el código: la 231 lo pagó con 1 BLQ y 4 pasadas.
     Aplico el criterio ya usado por la fila 230: *«lo que decide el modo es la ubicación del
     arreglo, no la severidad del defecto»* `[MEDIDO-F1]`.
  ⛔ **Nunca por debajo de FAST+AR** — y acá ni siquiera se consideró bajar.
- **Estimación: L**, y **PARTIDA en dos cortes** (ver Waves): el costo no es el guard, es
  **declarar a mano el destino de cada cita suelta**, y ese trabajo es lineal en la población
  — que hoy **no se conoce**, porque el instrumento es lo que falta.
- **Branch sugerido:** `feat/232-wkh-371-discriminador-de-citas-sueltas`
  ⚠️ **Propuesta SIN VERIFICAR**: no pude correr `git rev-parse --abbrev-ref HEAD`.

### Corte sugerido

| Corte | Contenido | Entregable |
|---|---|---|
| **A** | El **DISCRIMINADOR** + su medición sobre una muestra **reservada** + el censo del perímetro (incluida la medición de `doc/`, sin tocarlo) | Un clasificador con precisión/recall publicados y su lista de `INDECIDIBLE` |
| **B** | El **guardián** que entiende la forma suelta (opción B/C) + la corrección de las citas, **en commits separados de A** | `npm test` capaz de ponerse rojo por una cita suelta corrida |

**A puede cerrar sin B y ya vale**: convierte «8501» en un número con instrumento.

---

## Acceptance Criteria (EARS)

- **AC-1 — EL DISCRIMINADOR, Y SU PRECISIÓN MEDIDA.**
  WHEN el clasificador se ejecuta sobre un token `:N` sin archivo (formas P3/P4 de
  `test/cited-lines-guard.scanner.ts`), the system SHALL emitir exactamente una de cuatro
  etiquetas —`CITA`, `RUIDO`, `DATO`, `INDECIDIBLE`—, y el entregable SHALL publicar su
  **precisión y su recall** medidos sobre una muestra etiquetada a mano, acompañados de **al
  menos 3 falsos positivos y 3 falsos negativos citados con su sitio y su motivo**.

- **AC-2 — LA MUESTRA DE CALIBRACIÓN NO PUEDE SER LA MUESTRA DE MEDICIÓN.**
  IF la muestra sobre la que se mide la precisión es la misma de la que se derivaron las
  reglas, THEN the system SHALL publicar ese número como **CALIBRACIÓN** y NO como precisión,
  y el AC **no se da por PASS** hasta que exista una muestra **reservada** (etiquetada antes
  de correr el clasificador, en archivos distintos), con su perímetro y su tamaño escritos.

- **AC-3 — EL PERÍMETRO SE DECLARA SIEMPRE, CON SU NÚMERO Y CON SU RESIDUO.**
  the system SHALL publicar el perímetro barrido **con el número derivado en la corrida**
  (nunca un literal copiado) y **la lista explícita de lo que queda afuera**, incluyendo la
  medición de `doc/` —población total y cuántos llevan marcador histórico— aunque `doc/` no
  se toque.

- **AC-4 — EL GUARDÁN TIENE QUE PODER FALLAR, Y EL ROJO SE CONFIRMA POR SU MOTIVO.**
  WHEN se muta una cita suelta clasificada `CITA` para que apunte a una línea que no dice lo
  declarado, the system SHALL poner el gate en rojo, y la evidencia SHALL incluir **el texto
  literal del fallo** (no sólo el color) **más un control positivo en la misma corrida**
  (verde antes de mutar, verde después de restaurar, restauración verificada por hash).

- **AC-5 — `doc/` ES REGISTRO HISTÓRICO POR DEFECTO.**
  WHILE un token vive en un archivo bajo `doc/`, the system SHALL tratarlo como registro
  histórico y **NO re-anclarlo**, salvo que la cabecera de ese artefacto declare
  explícitamente que numera el árbol vivo.

- **AC-6 — NINGÚN CONTROL PUEDE LEERSE A SÍ MISMO.**
  IF un control del guardián nuevo busca un literal en la misma línea donde ese literal está
  escrito, THEN the system SHALL considerarlo **vacuo** y el gate del propio guardián SHALL
  fallar. Cada control nuevo SHALL declarar, en el sitio, **qué input concreto lo pone rojo**.

- **AC-7 — LAS CITAS SE ARREGLAN AL FINAL, Y ABRIENDO LA LÍNEA.**
  WHEN una wave de esta HU edite prosa o código en un archivo que otro registro referencia
  por número de línea, the system SHALL re-derivar esas referencias **abriendo cada línea**,
  **después** del formateador y **después** de la última edición de esa wave; the system
  SHALL NOT actualizar una cita sumándole un delta.

- **AC-8 — TODO NÚMERO DE POBLACIÓN ES UNA FOTO Y SE DERIVA.**
  IF el entregable escribe un número de población de citas, THEN the system SHALL derivarlo
  en la corrida, SHALL marcarlo como foto con su fecha, y SHALL nombrar la función que lo
  deriva para que quien lo relea pueda re-obtenerlo.

- **AC-9 — LA DEUDA VIEJA Y LA NUEVA VAN EN COMMITS SEPARADOS.**
  the system SHALL entregar en commits distintos (a) el instrumento y el guardián y (b)
  cualquier corrección de citas; y por cada cita corregida SHALL declarar si estaba podrida
  **antes** del primer commit de esta HU, derivándolo del árbol base y no de la memoria.

- **AC-10 — EL GATE COMPLETO, EN ORDEN, CON EL ÁRBOL EN EL ÍNDICE.**
  WHEN se cierre cualquier wave, the system SHALL correr `git add -A` y luego
  `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`, **en ese orden y
  completo**, y SHALL publicar los cuatro números contra la línea base
  `tsc 0 · lint 520 · 314/320 archivos · 6350/6369 casos` `[HEREDADO]`.

---

## Scope IN

- `test/cited-lines-guard.scanner.ts` — el discriminador **se agrega acá**, como funciones
  puras, junto a `citeNamesFile` / `citeTargetIfTracked`. ⛔ **No se escribe un escáner nuevo**
  (DT-5).
- `test/cited-lines-guard.test.ts` — controles nuevos del discriminador, con fixtures **en
  memoria** en las dos direcciones (el patrón que ya usan `G-C2`/`G-C3`/`G-C11`).
- `test/cited-lines-guard.exceptions.ts` / `.citations.ts` — el registro de lo declarado y de
  los `INDECIDIBLE`, cada uno con motivo escrito **leyendo el sitio**.
- Un artefacto de censo del perímetro en `doc/sdd/232-…/` (el número, su método, y qué queda
  afuera).
- **Sólo en Corte B**: los comentarios de `src/` / `test/` / `scripts/` cuyas citas sueltas
  se corrijan, **en commit aparte**.

## Scope OUT

- ⛔ **`doc/` no se re-ancla.** Se mide y se declara (AC-3/AC-5).
- ⛔ **`.nexus/project-context.md`** — no está en el índice de git, y el repo es público
  (`TD-316-CITAS-PROJECT-CONTEXT`).
- ⛔ **`chaski-v3` y `wasiai-remittance-agents`.** El defecto es de los tres repos, pero el
  universo se deriva del índice de git y **los tres tienen universos distintos**: acá `doc/`
  viaja parcialmente (`.gitignore:183-193`) y en `wasiai-remittance-agents` está ignorado
  entero `[HEREDADO, de la fila 224]`. Queda como `TD-371-PORTABILIDAD`.
- ⛔ **Ninguna línea de código ejecutable en `src/`.** El diff de `src/` es 100 % comentario
  (CD-8).
- ⛔ Los 41 pares `{file,line}` de `test/ownership-filter-guard.exceptions.ts`: ya tienen
  testigo (`G-08`/`G-09`) y re-cubrirlos es el duplicado que
  `payment-guards-live-in-one-place.test.ts` existe para prevenir. **Sus citas de PROSA sí
  entran** (son la `TD-370-EXCEPTIONS-SIN-GUARDIAN`, medida con control positivo en la 231).
- ⛔ `TD-224-CITAS-DEL-PROPIO-GUARDIAN` **no se cierra en esta HU**: el guardián se hace más
  denso al agregarle el discriminador. Se **declara**, con su número re-derivado (AC-8).
- ⛔ Ampliar `CORTE_A_PATHS` a archivos nuevos: es otra HU (obliga a declarar todas sus citas
  de una vez y mueve los invariantes de conteo).

---

## Decisiones técnicas (DT-N)

- **DT-1 — El discriminador es una CASCADA sintáctica + UNA regla de contexto, con residuo
  explícito.** Nunca una heurística de rango. Motivo medido: el escáner ya rechazó por escrito
  descartar por rango (*«se come mañana una cita real a la línea 80»*), y la decisión de
  reportar el ruido **a propósito** —para que caiga del lado ruidoso y no del silencioso— es
  correcta y **se conserva**.
- **DT-2 — D3 pregunta al ÍNDICE DE GIT, no al disco.** Reusa `citeTargetIfTracked`
  (`scanner.ts:251-267`) `[MEDIDO-F1]`. Sin esa condición, los 3 tokens de ruido de
  `exceptions.ts:237` sobreviven porque el párrafo nombra `x.io:8443`. Y usar el disco haría
  que el guardián dé distinto en CI que en local.
- **DT-3 — El residuo `INDECIDIBLE` es de PRIMERA CLASE.** Un clasificador binario obliga a
  mentir en el borde y empuja a inventar heurísticas. `INDECIDIBLE` con motivo escrito es el
  lado ruidoso.
- **DT-4 — Tres arreglos, no uno:** anclar (A), acotar con contexto (B), **borrar el número**
  (C). C sale de un hallazgo de F0 (`chain-resolver.ts`: nueve referencias a nivel de archivo,
  cero tokens `:N`) y es el único con costo de mantenimiento cero.
- **DT-5 — Se EXTIENDE el escáner existente, NO se escribe uno nuevo.** Motivo medido y
  escrito en el repo: hoy conviven **TRES** `stripComments` (`TD-224-TRES-STRIPCOMMENTS`,
  `scanner.ts` en el docblock de `stripComments`) `[MEDIDO-F1]`, y el propio escáner registra
  que *«el punto ciego del dotfile se reprodujo DENTRO del arreglo del punto ciego del
  dotfile»* por duplicar un criterio. Un segundo discriminador es la próxima divergencia.
- **DT-6 — Un párrafo que nombra MÁS DE UN archivo trackeado ⇒ `INDECIDIBLE`.** Es
  literalmente el caso del issue (delta del archivo equivocado). Resolverlo solo sería
  automatizar el bug.
- **DT-7 — Corte A entrega valor sin Corte B.** El censo con instrumento ya reemplaza al
  "8501". Si B no entra, A **no queda a medias**: queda un número que se puede citar.

---

## Constraint Directives (CD-N)

- **CD-1 — ⛔ PROHIBIDO publicar un número de citas sueltas sin declarar, en la misma frase,
  el PERÍMETRO y el PATRÓN que lo produjeron.** Un candado con perímetro incompleto es peor
  que ninguno: se lee como lista cerrada. Lo que no cubra va escrito.
- **CD-2 — ⛔ PROHIBIDO barrer deuda vieja y nueva en el mismo commit.** Una parte grande ya
  estaba rota **antes** de cualquier edición reciente (la 231 lo reprodujo con
  `git show 091db28:`). Mezclarlas hace imposible saber cuál era cuál — y **atribuirle al
  trabajo de hoy un daño preexistente apaga la búsqueda de la causa real**.
- **CD-3 — ⛔ PROHIBIDO que un control busque un literal en la misma línea donde ese literal
  aparece.** Nunca puede fallar. Ya pasó en este repo y hay uno **todavía vacuo en `main`**.
- **CD-4 — ⛔ PROHIBIDO descartar un token por el RANGO de su número.** «Los números chicos
  no son líneas» se come mañana una cita real a la línea 80.
- **CD-5 — ⛔ PROHIBIDO re-anclar una cita de `doc/sdd/**` que documente un árbol pasado.**
  Incluye este mismo work-item. Precedentes: la fila 226 (`compose.ts:1757` ya no existe) y
  los 9 tokens históricos `.gitignore:172` de la fila 224.
- **CD-6 — ⛔ PROHIBIDO actualizar una cita sumándole un delta. OBLIGATORIO abrir la línea**
  y confirmar el símbolo contenedor. `BLQ-2` de la 231 nació exactamente de esto (`+64` donde
  correspondía `+78`).
- **CD-7 — ⛔ PROHIBIDO correr el gate sin `git add -A` antes.**
  `test/readme-numbers.test.ts:83` enumera con `git ls-files`, o sea **contra el ÍNDICE**:
  con archivos untracked el gate **da verde en falso** `[HEREDADO, fila 230]`.
- **CD-8 — ⛔ PROHIBIDA cualquier línea de código EJECUTABLE en el diff de `src/`.** El diff
  de `src/` es 100 % comentario; si el CR encuentra una línea de código, es BLOQUEANTE.
- **CD-9 — ⛔ PROHIBIDO tocar `doc/sdd/_INDEX.md` por encima de la línea 144.**
  `src/services/capability-risk.ts` cita esa región `[HEREDADO]`, y desplazarla rompe una
  cita **del lado del código**.
- **CD-10 — OBLIGATORIO que el arreglo de citas sea LO ÚLTIMO de cada wave**, después del
  formateador. *«Un párrafo de prosa que crece 3 renglones desplaza tanto como un `if`»*; ya
  obligó a re-derivar cuatro veces.
- **CD-11 — ⛔ PROHIBIDO generar cualquiera de las listas de excepciones volcando la salida
  del clasificador.** Cada entrada se escribe **después de leer el sitio**. Un archivo de
  excusas derivado de la medición que consume deja el control verde por construcción.

---

## Missing Inputs

- **MI-1 `[bloqueante de F2]` — NO PUDE LEER EL ISSUE #178.** No tengo `WebFetch` ni shell, y
  no hay copia en el repo (`Glob` sobre `doc/**` no la encuentra). **Todo lo que este
  work-item dice del issue es de segunda mano**, del encargo del orquestador y de la fila 226
  del `_INDEX.md`. Leerlo entero es la **primera tarea de F2**, y puede contradecir algo de acá.
- **MI-2 `[bloqueante de F2]` — ESTE F1 NO CORRIÓ NI UN SOLO BARRIDO.** Sin `grep` y sin
  shell, **ningún conteo de este documento es exhaustivo**. La única medición propia es el
  etiquetado a mano de 30 tokens en 1 archivo. El censo del perímetro (AC-3) es trabajo de F2.
- **MI-3 — LA PRECISIÓN DE ARRIBA ES CALIBRACIÓN, NO PRECISIÓN.** Reglas y muestra salen del
  mismo archivo. **AC-2 lo vuelve un requisito, no una advertencia.**
- **MI-4 `[NO MEDIDO]` — la población de `doc/` con marcador histórico.** El 392 del
  orquestador viene declarado como *"patrón grosero"*, o sea una cota. La regla de decisión
  que propongo (default histórico) **no depende de ese número**, pero el perímetro sí.
- **MI-5 `[NO MEDIDO]` — la población del falso negativo de D3** (párrafo que nombra el
  archivo **sin** `:N`). El hallazgo de `chain-resolver.ts` sugiere que puede no ser chica.
  **Medirla es pre-requisito de aceptar D3 como está.**
- **MI-6 `[NO VERIFICADO]` — el nombre de la rama.** No pude correr `git`. Se declara sin
  medir en vez de afirmarlo.
- **MI-7 `[resuelto en F2]` — ¿el discriminador vive en `test/` o en `scripts/`?** Ponerlo en
  `test/` lo deja fuera de `tsc` y de `biome` (`tsconfig` incluye sólo `src/**/*`,
  `lint` es `biome check src/`) `[MEDIDO-F1, `exceptions.ts:122-124`]`. Eso ya pasa con el
  guardián actual y se resolvió typechequeando aparte; **hay que decidirlo explícitamente,
  no heredarlo**.

---

## Análisis de paralelismo

- **¿Bloquea a otras?** **Sí, débilmente pero de verdad.** Toda HU que edite prosa o código en
  `src/services/agent.ts`, `src/types/index.ts` o `test/ownership-filter-guard.exceptions.ts`
  va a desplazar citas y va a pagar el peaje de re-derivarlas a mano (la 231 lo pagó cuatro
  veces). **Cuanto antes exista el discriminador, más barato es ese peaje para todas.**
- **¿Puede ir en paralelo?** **Sí con cualquier HU que NO toque `test/cited-lines-guard.*`.**
  Su Scope IN es casi disjunto del de una HU de producto.
- ⚠️ **Conflicto real y previsible**: cualquier HU que corra **al mismo tiempo** y edite
  `src/` va a mover las líneas que el Corte B está declarando. ⇒ **el Corte B se secuencia,
  no se paraleliza**; el Corte A (instrumento + censo) sí puede correr en paralelo.
- **Deuda que esta HU puede cerrar de paso, si el discriminador sale bien**:
  `TD-370-EXCEPTIONS-SIN-GUARDIAN` (las citas de prosa del archivo que `CLAUDE.md` manda
  auditar, hoy **sin ningún testigo**, medido con control positivo en la 231). **No se promete
  en los ACs** — se nombra como candidata.
- **Dependencia externa: ninguna.** Sin credenciales, sin red, sin base de datos, sin
  despliegue. Es una HU enteramente local al repo.
