# Code Review (Architect) — WKH-318 corte B / HU 218

**Rama** `feat/218-wkh-318-corte-b-maxlimit-clamp` · **HEAD** `4920399` · **Base** `main`
**Revisor**: nexus-architect (CR de calidad y patrones) · **Fecha** 2026-08-04

## Veredicto

> ## APROBADO CON MENORES

Seis hallazgos MENORES, ninguno cambia la conducta del clamp ni bloquea el merge.
Cinco son de prosa/nombres/punteros y uno es un test que falta. **Ninguno es
BLOQUEANTE**: el clamp implementado hace lo que el SDD decidió, en el lugar que el
SDD decidió, y los 13 tests existen y miden lo que dicen medir salvo el caso que
señalo en M-1.

**Alcance de este CR**: cohesión/acoplamiento, choke-point, nombres, honestidad de
tests, honestidad de prosa, duplicación, ruido de diff y deuda declarada. **Fuera
de alcance** (los cubre el AR, en paralelo): ataque, seguridad de la migración,
barrido de las 11 categorías.

---

## 1. Tabla por dimensión

| Dimensión | Veredicto | Evidencia / hallazgo |
|---|---|---|
| **Legibilidad** | OK | El bloque nuevo de `queryRegistry` (`src/services/discovery.ts:1081-1116`) es lineal: calcular → escribir el parámetro → dos `warn`. 40 líneas de las que ~23 son comentario, y cada comentario dice algo que el código no dice. Los `warn` copian la forma del exemplar (`discovery.ts:275-281`): `error_code` primero, mensaje con prefijo `[discovery.*]` en inglés. |
| **Cohesión / acoplamiento** | OK | Tres helpers, tres responsabilidades disjuntas: predicado (`:83`), aritmética (`:108`), comparación contra el piso (`:203`). `discovery-fetch-limit.ts` **sigue sin un solo import** (Done Definition §12), así que el argumento de "módulo LEAF" que motivó el diseño se mantiene. El tercer helper **se justifica**: ver §3. |
| **Choke-point único** | VERIFICADO | Un solo `searchParams.set(schema.limitParam, …)` en todo `src/` y un solo llamador de `queryRegistry`. Detalle medido en §5. |
| **Nombres** | 1 MENOR | `clampFallsBelowComposePoolFloor` promete más de lo que cumple (M-2). `isUsableRegistryMaxLimit`, `clampToRegistryMaxLimit`, `unclamped` y los dos `error_code` son exactos. |
| **Duplicación** | 1 MENOR | Cero literales `100`/`50`/`'wasiai'` nuevos en `src/` (CD-11 cumplido: el techo entra sólo por la fila de `registries`, el piso sólo por `COMPOSE_POOL_MIN_LIMIT:41`). La duplicación está en un helper de test (M-6). |
| **Prosa** | 3 MENORES | M-3 (atribución falsa al `typeof`), M-4 (4 punteros `archivo:línea` que hoy apuntan a otra línea), M-5 (una disyunción recortada a la mitad falsa). El resto de la prosa nueva resistió: verifiqué una por una las afirmaciones de `discovery-fetch-limit.ts:21-31`, `:92-106`, `:188-201` y `types/index.ts:146-170` y todas son falsables y verdaderas. |
| **Tests** | 1 MENOR | 13/13 presentes, nombrados, y cada uno mata al menos un mutante. El nombre de T-CLAMP-02 afirma "no hay warn" y el assert cubre la mitad (M-1), y el mutante que lo destaparía no está en la campaña. Revisión test por test en §6. |
| **Scope / ruido de diff** | LIMPIO | Cero ruido. Ver §7. |
| **Deuda declarada** | OK con una recomendación | 5/5 con dueño y gatillo; 2 con gatillo mecánico. TD-318B-3 hay que sacarla de esta carpeta al cerrar. Ver §9. |

---

## 2. Decisión que el Dev dejó para el CR: el cast `declared as number`

**`src/lib/discovery-fetch-limit.ts:112-116`.** El Dev respetó la firma `: boolean`
del contrato, puso `declared as number` con un comentario pegado, y propuso el type
predicate (`declared is number`) como "estrictamente mejor", dejando la decisión acá.

> ### DECISIÓN: se queda como está. NO convertir a type predicate.
>
> Y la razón NO es la que el Dev supuso (que es "cambio de contrato"). Es que el
> predicate sería **peor**, y lo medí.

**(1) El predicate narrowea a `never` justo la rama que existe para reportar la
basura.** En `discovery.ts:1088-1099` el call-site es
`schema.maxLimit !== undefined && !isUsableRegistryMaxLimit(schema.maxLimit)`, sobre
un campo declarado `number | undefined`. Con la firma `boolean`, `schema.maxLimit`
sigue siendo `number` dentro del `warn`. Con `declared is number`, TypeScript resta
`undefined` (primera mitad) y después resta `number` (segunda mitad) y deja
**`never`**. Medición (`tsc --strict --noEmit`, dos guards idénticos salvo la firma):

```
predicate  →  const asString: string = declared;   // COMPILA  ⇒ declared es `never`
boolean    →  const asString: string = declared;   // TS2322: Type 'number' is not
                                                   // assignable to type 'string'
```

O sea: el predicate le enseñaría al compilador que el campo `declared:
schema.maxLimit` que se loguea en `:1096` es imposible. Cualquier refactor futuro
—o cualquier regla de lint de código muerto— tiene licencia para borrar el único
campo que dice **cuál** fue la basura declarada. Es exactamente la clase
"prosa/tipo que afirma de más": el tipo diría `never` mientras en runtime ahí llega
`"100"`, `{}` o `null`.

**(2) El predicate no es más sano, sólo mueve de lugar la aserción no chequeada.**
TypeScript **no verifica el cuerpo** de un type predicate anotado a mano. `x is
number` es tan indemostrado como `as number`; la diferencia es que el `as` es un
punto no chequeado visible, en una línea, con el comentario que lo cubre al lado, y
el predicate es un punto no chequeado invisible que se propaga a todo call-site
presente y futuro.

**(3) La tercera variante tampoco gana.** `if (typeof declared !== 'number' ||
!isUsableRegistryMaxLimit(declared))` evita el cast sin tocar la firma, pero duplica
una cláusula del predicado — justo lo que `:104-106` se propuso evitar — y crea una
divergencia real si el predicado algún día se relaja.

**Acción recomendada (opcional, 2 líneas)**: agregar el punto (1) al comentario de
`:113-115`, para que esta pregunta no se relitigue en seis meses. Redacción
sugerida: *"Un type predicate (`declared is number`) sacaría el cast pero narrowearía
`schema.maxLimit` a `never` dentro del `warn` de `discovery.ts:1092` — o sea que le
enseñaría a tsc que el campo `declared` que ahí se loguea es imposible. Medido con
`tsc --strict`."*

---

## 3. ¿`isUsableRegistryMaxLimit` es un helper de más?

**No. Se justifica, y la justificación es verificable.** Tiene **dos** consumidores
con decisiones distintas:

| Consumidor | Decisión que toma | Qué pasaría sin el helper |
|---|---|---|
| `discovery-fetch-limit.ts:112` | ¿clampeo o devuelvo el número intacto? | inline del predicado |
| `discovery.ts:1090` | ¿emito `REGISTRY_MAX_LIMIT_INVALID`? | **segunda copia** del predicado, en otro módulo |

Las dos copias divergirían por construcción: la primera vez que alguien decida que
`0` es aceptable, o que un float se redondea, tocaría una sola. El resultado sería el
peor de los mundos: clampear sin avisar, o avisar sin clampear. El docstring de
`:104-106` dice exactamente esto y es cierto.

Prueba adicional de que no es decorativo: el warn del call-site **no puede** derivarse
del retorno de `clampToRegistryMaxLimit`, porque `sentLimit === unclamped` es
ambiguo (pasa con techo inválido **y** con techo válido mayor al over-fetch).

---

## 4. Hallazgos

### M-1 — MENOR (tests) · La mitad `sentLimit < unclamped` no tiene test ni mutante

**`src/services/discovery.ts:1101-1106`.** El guard es de dos mitades y el comentario
de arriba defiende la primera con un input concreto:

```
Sin `sentLimit < unclamped`, un operador que baja DISCOVERY_UPSTREAM_FETCH_LIMIT=10
contra un registry SIN `maxLimit` dispararía este warn, y eso sería salida
observable nueva en un camino que esta HU se comprometió a dejar intacto (CD-3).
```

La afirmación es **correcta** y está en tres lugares (código `:1101-1105`, commit
`7d58207`, story file). **No hay nada mecánico que la sostenga.** Medido: mutando

```ts
// mutante M11 (no está en la campaña)
if (clampFallsBelowComposePoolFloor(sentLimit)) {   // se borra `sentLimit < unclamped &&`
```

la suite **completa** queda verde: 4996 passed | 19 skipped, cero fallos atribuibles
(los 2 archivos rojos de mi corrida son por correr en una copia sin `.git`, ver §10).
Ningún test envía un límite menor a 50 sin `maxLimit`, que es la única forma de
distinguir las dos mitades.

Esto es justo el corolario que el repo ya pagó caro: *enunciar la regla no alcanza,
hace falta un paso mecánico o un test*. Y el nombre del helper empuja en la dirección
equivocada (M-2), así que el próximo que lea `if (sentLimit < unclamped &&
clampFallsBelowComposePoolFloor(sentLimit))` va a pensar que la primera mitad es
redundante y la va a borrar, con la suite aplaudiendo.

**Fix (un sub-caso, ~8 líneas)** en T-CLAMP-02 (`src/services/discovery.limit.test.ts:258`),
que es donde ya vive la afirmación "y no hay warn":

```ts
// 4º sub-caso: el operador baja el over-fetch por env, SIN maxLimit declarado.
// El número enviado cae bajo el piso del pool y aun así NO warnea: el warn es
// del clamp, no del env (la primera mitad del guard de discovery.ts:1106).
process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT = '10';
const d = serveHonoringLimit(catalog(10));
await discoveryService.discover({ limit: 5 });
expect(d.upstreamLimits).toEqual(['10']);
expect(logSpy.warn).not.toHaveBeenCalledWith(
  expect.objectContaining({ error_code: 'REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL' }),
  expect.anything(),
);
```

El `beforeEach` (`:127`) ya borra la env, así que no hay fuga entre tests.
Y agregar **M11** al `mutation-log.md` con su test nominado.

Con esto el nombre del test ("y no hay warn") pasa a cubrir los **dos** códigos de
warn, que es lo que hoy promete y no cumple.

---

### M-2 — MENOR (nombres) · `clampFallsBelowComposePoolFloor` afirma una causa que no puede conocer

**`src/lib/discovery-fetch-limit.ts:203-205`.** El cuerpo es `sent <
COMPOSE_POOL_MIN_LIMIT`. La función recibe **un solo número** y no tiene forma de
saber si hubo clamp: `clampFalls…` es una afirmación causal sobre algo que no está en
su firma. Es la causa próxima de M-1 — el call-site necesita la primera mitad
precisamente porque el nombre miente sobre lo que la función ya cubre.

**Fix**: renombrar a `isBelowComposePoolFloor(sent)` o `fallsBelowComposePoolFloor(sent)`.
Un solo call-site (`discovery.ts:1106`), rename mecánico. Con el nombre neutro, el
`sentLimit < unclamped &&` de al lado se lee como lo que es: la parte que aporta el
"fue el clamp".

---

### M-3 — MENOR (prosa) · El crédito del `typeof` está mal puesto

**`src/lib/discovery-fetch-limit.ts:80-81`**: *"El `typeof` las corta antes del `Math.min`."*

Falso en runtime, y lo medí en las dos direcciones:

- **`Number.isInteger` es quien rechaza los no-números.** No coerciona: `"100"`,
  `"abc"`, `null`, `{}` y `1.5` dan `false` sin el `typeof`. Reemplazando el cuerpo por
  `Number.isInteger(declared) && (declared as number) >= 1`, `tsc --noEmit` sale
  limpio y los 4 archivos de test dan **56/56 passed**: la cláusula no cambia el
  veredicto para ningún input.
- **Pero el `typeof` sí es load-bearing — para el compilador.** Sin él,
  `declared >= 1` sobre `unknown` no compila: `TS18046: 'declared' is of type
  'unknown'` (medido con `tsc --strict`).

O sea que la cláusula **se queda**, pero por otra razón que la que el docstring da.
Consecuencia colateral: **ningún mutante aisló el `typeof`** — M9 borra las dos
cláusulas juntas, así que la campaña nunca preguntó si la primera hace algo.

**Fix (una frase)**: *"`Number.isInteger` es lo que rechaza `"100"`, `"abc"`, `null` y
`{}` — no coerciona. El `typeof` de adelante es lo que hace que `declared >= 1`
compile sobre `unknown` (sin él: TS18046); no cambia el veredicto de ningún input."*

---

### M-4 — MENOR (punteros) · Cinco referencias `archivo:línea` nuevas apuntan a las líneas **previas** al propio commit

Todas nacieron correctas contra el árbol de F1/F2 y quedaron corridas por las líneas
que esta misma HU agregó arriba. Es prosa falsable que hoy verifica falso, y es el
tipo de puntero que un revisor sigue una vez, no encuentra lo prometido, y deja de
seguir los demás.

| Dónde | Dice | Real |
|---|---|---|
| `src/lib/discovery-fetch-limit.ts:68` | `types/index.ts:160` | `types/index.ts:171` (el JSDoc creció +11 en el mismo commit `aace582`) |
| `src/services/discovery.limit.test.ts:22` | `discovery.ts:63` | `discovery.ts:68` (el bloque de import creció +5) |
| `src/services/compose.discovery-pool.test.ts:31` | `discovery.ts:63` | `discovery.ts:68` |
| `src/services/discovery.sources.test.ts:516-518` | `discovery.ts:1115-1117` lanza, `:1119` es el `json()` | `:1155-1157` y `:1159` (+40 líneas en `7d58207`) |
| `doc/sdd/218-.../auto-blindaje.md:94` | idem anterior | idem |

(El `work-item.md:22` cita `1115-1117` y **está bien**: se escribió contra `main`.)

**Fix**: 5 números. Regla para la próxima: los punteros a archivos que la propia HU
modifica se re-anclan en el último commit de la rama, no en el momento de escribirlos.

---

### M-5 — MENOR (prosa) · Una disyunción recortada a la mitad, y se quedó con la mitad falsa

**`src/lib/discovery-fetch-limit.ts:198-201`**: *"el agente que quede afuera no hidrata
`payment.chain` y su leg downstream **se saltea en silencio** (clase WKH-113 /
BLQ-BAJO-1)"*.

La redacción canónica del bug, en dos lugares que ya estaban en el repo, es una
**disyunción**:

- `src/services/compose.ts:125-126`: *"el leg downstream **se salteaba o apuntaba al
  rail equivocado**, en silencio"*
- `src/services/compose.discovery-pool.test.ts:16-17`: *"el leg downstream se saltea o
  apunta al rail equivocado: **el agente no se cobra, en silencio**"*

Y en el escenario que monta el propio T-CLAMP-05 de esta HU, la rama que ocurre es la
**segunda**: el agente no hidratado sale con el `chain: 'avalanche'` hardcodeado que
sirve el mimic de `agentEndpoint` (`compose.discovery-pool.test.ts:213-217`), no se
saltea. O sea: el input que falsifica la frase lo construye la propia HU, tres
archivos más allá.

Hereda de `sdd.md:506` (TD-318B-2 dice lo mismo recortado). El mensaje de log
(`discovery.ts:1113`) **no** tiene el defecto: dice sólo *"will not hydrate
payment.chain"*, que es exactamente lo que se sabe.

**Fix**: `se saltea` → `se saltea o apunta al rail equivocado`, en
`discovery-fetch-limit.ts:200` y en `sdd.md:506`.

---

### M-6 — MENOR (duplicación en tests) · `serveRegistryWithCeilingOf100` es `serveRegistry` + 3 líneas

**`src/services/compose.discovery-pool.test.ts:388-425`** vs **`:200-237`**. Las ramas
`/agent/` (con el `payment` hardcodeado a avalanche que es *el* punto del archivo) y
`/invoke/` están copiadas carácter por carácter; la única diferencia real es:

```ts
if (lim !== null && Number(lim) > 100) return Promise.resolve({ ok: false, status: 400 });
```

Son ~30 líneas duplicadas dentro del **mismo** archivo. El riesgo concreto no es
estético: el día que el mimic de `/agent/` cambie (otro campo de `payment`, otro
status), una de las dos copias queda vieja y su test **sigue verde midiendo otra
cosa**, que es justo el modo de falla que este archivo existe para cazar.

**Fix**: un parámetro opcional — `serveRegistry(rows, opts?: { ceiling?: number })` —
y `serveRegistryWithCeilingOf100(rows)` pasa a ser `serveRegistry(rows, { ceiling: 100 })`.
Toca sólo helpers de test, ningún assert.

**La tercera copia NO es hallazgo**: `serveWithCeilingOf100`
(`discovery.sources.test.ts:520-533`) vive en otro archivo, con otros helpers, y el
story file `:601-605` documentó y midió por qué `serveByHost` no sirve ahí. Está bien
resuelta y bien comentada.

---

## 5. El choke-point es realmente único (verificado)

| Verificación | Resultado |
|---|---|
| `searchParams.set(schema.limitParam, …)` en todo `src/` (sin tests) | **1** ocurrencia: `discovery.ts:1084` |
| Llamadores de `queryRegistry` | **1**: `discovery.ts:368` (el fanout de `discover`) |
| Otros `ssrfFetch` en `discovery.ts` | `:1335` — fetch de **un** agente por `agentEndpoint`; no lleva `limit` |
| Entradas al pipeline | `routes/discover.ts:219,289`; `services/orchestrate.ts:557,577`; `services/compose.ts:136`; `services/capability-resolver.ts:124`; `routes/capabilities.ts:62`; `mcp/tools/discover-agents.ts:33` — **todas** por `discoveryService.discover` |
| Archivos de esas entradas en el diff | **ninguno** |

Dos precisiones sobre la enumeración del commit `7d58207` ("los cuatro consumidores"),
ambas a favor:

- `routes/capabilities.ts:62` llama `discover({})` **sin** `limit` ⇒ rama (d), no se
  manda `limitParam`. Es un quinto punto de entrada que cae en una rama ya cubierta
  por T-CLAMP-02b, no un agujero.
- `services/capability-resolver.ts` nunca setea `limit` (grep: cero ocurrencias fuera
  de un comentario) ⇒ misma rama (d).

**No quedó ningún camino que arme un `limitParam` fuera del clamp.**

---

## 6. Los 13 tests, uno por uno: ¿el nombre describe lo que el assert verifica?

| Test | Nombre vs assert | Puede ponerse rojo solo |
|---|---|---|
| **T-CLAMP-01** `limit.test:246` | Exacto. `['100']` literal con `limit: 500`. | Sí — M1, M3 |
| **T-CLAMP-02** `limit.test:258` | **Media (M-1).** "byte-idéntico" está cubierto por los 3 sub-casos; **"y no hay warn"** es universal y el assert cubre sólo `REGISTRY_MAX_LIMIT_INVALID`. El otro código de warn no se testea nunca en ausencia de `maxLimit`. | Sí — M2. Pero no puede matar M11 |
| **T-CLAMP-02b** `:281` | Exacto: `[null]` con `discover({})`. | Sí — M5 |
| **T-CLAMP-02c** `:294` | Exacto: `[null]` sin `limitParam`. | Sí — M5 (en su forma final; ver §8) |
| **T-CLAMP-03** `truncation.test:291` | Exacto y **más fuerte que el nombre**: agrega `failure === undefined`, o sea "clampear no es fallar". | Sí — M1 |
| **T-CLAMP-03b** `:309` | Exacto: 23 filas bajo techo 100 ⇒ `'ok'` + `truncationEvidence === undefined`. Control del falso positivo. | Sí — M6 |
| **T-CLAMP-04** `sources.test:535` | Exacto. Usa negativas (`not.toBe('failed')`, `not.toBe('partial')`) pero `rows === 23` y `registries === ['test-registry']` lo anclan a un valor positivo: no puede pasar con la fuente caída. | Sí — M1 |
| **T-CLAMP-04b** `:556` | Exacto, y es el test que le da valor a T-CLAMP-04: prueba que el mimic **sí** devuelve 400 y que no hay default de 100 escondido. Buen control negativo. | Sí — M2 |
| **T-CLAMP-05** `pool.test:429` | Exacto. `new Set(upstreamLimits)` descarta orden/multiplicidad (correcto: compose consulta más de una vez) y no puede pasar con cero llamadas. Llega hasta `signAndSettleDownstream`. | Sí — M1 |
| **T-CLAMP-06** `limit.test:307` | Exacto, y el mejor diseñado del lote: la fuente del `100` es el **texto** del `.sql`, parseado con `JSON.parse`. Se cae si la migración cambia de clave o el lector cambia de path. | Sí — M4 |
| **T-CLAMP-07** `pool.test:456` | El nombre es honesto (afirma una **no**-rotura). Observación O-1: es el único de los 13 cuyo rojo depende de una mutación **fuera** de las líneas de esta HU (M7 vive en `compose.ts`). No puede detectar la remoción del clamp: con techo 100 o sin techo, el target (posición 5 de 150) entra igual. Es un guard de no-regresión del pool, no del clamp, y el mutation-log ya lo dice. | Sí, pero sólo vía `compose.ts` |
| **T-CLAMP-07b** `pool.test:477` | Exacto, y **el más honesto del lote**: afirma el residual (`['10']`, no `['50']`) en vez de disfrazarlo, y ancla el warn. El comentario `:481-482` explica por qué no hay piso, con la consecuencia. | Sí — M8 |
| **T-CLAMP-08** `limit.test:327` | Exacto: los 7 inválidos, `['200']` en los 7, más el warn, con `mockClear()` por iteración. El comentario nombra el valor prohibido concreto (`'NaN'`). | Sí — M9, M10 |

**Patrón "claim temporal/universal con assert de media"**: aparece **una** vez (M-1) y
es de baja gravedad. **Patrón "verde que no puede ponerse rojo"**: **cero** en sentido
estricto — los 13 matan al menos un mutante; T-CLAMP-07 es el único cuyo rojo vive
fuera del diff, y está declarado.

**Observaciones menores de test (no son hallazgos, no piden acción):**

- **O-3** — T-CLAMP-08 (`limit.test:331`) itera un array literal de 7 sin
  `expect(invalidos).toHaveLength(7)`: si alguien vacía la lista, el test pasa verde
  sin probar nada. Además, al fallar no dice **qué** valor falló (`it.each` lo diría).
  Hoy la lista es un literal visible tres líneas más arriba, así que el riesgo es bajo.
- **O-4** — `discovery.ts:1096` loguea `declared: schema.maxLimit` crudo, y el warn se
  emite **por registry y por query**. Un registry que declare un objeto grande como
  `maxLimit` se lo hace serializar en cada `/discover`. Es superficie, no calidad:
  **queda apuntado para el AR**, no lo cuento como hallazgo de CR.

---

## 7. Ruido en el diff: ninguno

- **Waves = commits, 1:1**, sin arrastre: `aace582` sólo W0 (2 archivos), `7d58207`
  sólo `discovery.ts`, `6edb179` sólo los 2 `.sql`, `272a82f` sólo los 4 tests,
  `4920399` sólo docs. Un lector puede revisar wave por wave.
- **Único cambio de líneas existentes**: el mock del logger en 2 archivos de test
  (`limit.test:20-29`, `pool.test:30-37`), que es **exactamente** la modificación que
  el story file `:656-667` autorizó, con el motivo medido (el factory creaba un objeto
  nuevo por llamada) y el exemplar correcto (`compose.test.ts:17-23`, verificado).
- **Cero** reformateos, imports huérfanos o líneas movidas. El único import nuevo
  (`discovery.ts:12-17`) trae exactamente los 3 símbolos que se usan.
- `doc/sdd/_INDEX.md` está en el rango `main..HEAD` pero lo tocó el commit de **F1**
  (`0cad63d`, analyst), no el Dev: la prohibición del Done Definition `:828` se cumple.
- **Nada** en `discovery-sources.ts`, `compose.ts`, `orchestrate.ts`, `routes/*`,
  `mcp/*` — la lista completa de `:826-828`.
- La migración copia el exemplar entero (`20260730010000_wkh318_registry_next_cursor_path.sql`):
  mismo `jsonb_set(..., true)`, mismo `WHERE id = 'wasiai' AND schema -> 'discovery'
  IS NOT NULL`, mismo aviso de no tocar `auth`, y **agrega** dos cosas que el exemplar
  no tenía: el `_down.sql` y el "Nunca a caldz". CD-10 cumplido y superado.

---

## 8. Los tres desmentidos del Story File: ¿quedan bien documentados a seis meses?

| # | Qué desmintió | Dónde quedó | ¿Lo encuentra quien lea en 6 meses? |
|---|---|---|---|
| 1 | La firma `: boolean` + `Math.min(fetchLimit, declared)` del contrato **no compila** | `auto-blindaje.md:48-64` + comentario **pegado al cast** en `discovery-fetch-limit.ts:113-115` | **Sí.** Es el mejor documentado: se llega desde el código, sin abrir un `.md`. Lo que faltaba —por qué no se resuelve con predicate— lo cierra §2 de este CR |
| 2 | El mutante M5 en su primera forma **no llegaba** a T-CLAMP-02c | `auto-blindaje.md:27-44` + `mutation-log.md:51-56` + commit `4920399` | **Sí**, y con la lección generalizada correcta: *"un mutante que no cambia la conducta observable no dice nada del test"*. Agregó además una salvaguarda mecánica (el script falla si el patrón no aparece exactamente una vez) |
| 3 | M9 **no** mata por `"abc"` (en JS `"abc" >= 1` es `false`); mata por `"100"` y `1.5` | `mutation-log.md:66-70` + commit `4920399` | **Sí.** Verifiqué el razonamiento: correcto. Y explica por qué la tabla de 7 valores es necesaria y uno solo no alcanzaba |

**Los tres desmentidos son correctos** (los verifiqué uno por uno) y los tres están
razonados, no sólo declarados. El Dev hizo lo que corresponde: **no editó el
contrato**.

**Residual de trazabilidad (no es del Dev)**: `story-WKH-318B.md` sigue diciendo lo
desmentido en §7.2 (M9) y en W0 (la firma), sin puntero a la corrección. Quien abra
primero el story file lee la versión falsa. **Acción para `nexus-docs` en el cierre**:
una línea al pie del story file — *"3 correcciones post-implementación: ver
`mutation-log.md` §M5/M9 y `auto-blindaje.md` §W0"* — y el mismo dato en el reporte
final. No es trabajo del Dev ni del CR.

---

## 9. La deuda declarada TD-318B-1..5: ¿dueño y criterio, o cajón?

**No es un cajón.** 5/5 tienen columna "Dueño / gatillo" llena y ninguno dice "más
adelante". Calidad desigual, en este orden:

| TD | Gatillo | Evaluación |
|---|---|---|
| **TD-318B-2** | "que aparezca `REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL` en logs" | **El mejor.** El gatillo está **implementado** (`discovery.ts:1107`) y **pineado por un test** (T-CLAMP-07b). Es una alarma cableada, no una nota. Único pero: no dice **dónde** se mira ese log ni si alerta a `#wasiai-alerts`; sin destino depende de que alguien mire |
| **TD-318B-5** | "cuando un **segundo** registry declare `maxLimit`" | Preciso y verificable con un `SELECT`. El story file `:175-176` además **prohíbe** re-evaluar la precondición ahora, así que no invita a trabajo especulativo |
| **TD-318B-1** | "W4 de WKH-318 / la HU que agregue evidencia B-6" | Dueño difuso (una HU que no existe) **pero** el criterio de cierre es concreto y —esto es lo que lo salva— quedó reflejado en **tres** lugares independientes: `backlog.md:149-156` del corte A, el JSDoc de `types/index.ts:165-170` y esta tabla, los tres con el mismo input falsificador. Es descubrible sin leer este SDD |
| **TD-318B-4** | "Solo si aparece impacto real" | Gatillo honesto pero **no observable**: no hay métrica de `catalogStatus` por registry. Aceptable para una deuda de prioridad baja y del "lado seguro" |
| **TD-318B-3** | "HU propia" | **El más cercano a un cajón**: sin gatillo, sin prioridad, sin número. Y es la contracara exacta de esta HU — el guard de **lectura** existe porque el guard de **escritura** (`routes/registries.ts:69,251` guarda `schema` sin validar) no existe |

**Recomendación (para `nexus-docs`, no bloquea el merge)**: TD-318B-3 tiene que salir
de esta carpeta y entrar al backlog con número propio. Una deuda que sólo vive en el
SDD de la HU que la creó desaparece cuando la carpeta deja de leerse; y esta en
particular es la que le da sentido al `unknown` de `isUsableRegistryMaxLimit:83`.

---

## 10. Cómo medí (reproducible, sin escribir en el repo)

Todo lo que digo "medido" se corrió sobre una **copia aislada**, nunca sobre el árbol
de trabajo:

```
git archive HEAD | tar -x -C <scratch>/mut
ln -s <repo>/node_modules <scratch>/mut/node_modules
```

- **Baseline**: `npx vitest run src/services/discovery.limit.test.ts` ⇒ 15 passed.
- **M11** (M-1): reemplazo exacto de la condición de `discovery.ts:1106`, verificado
  que el patrón aparece **una** vez ⇒ 4 suites 56/56 verdes, y suite **completa**
  4996 passed | 19 skipped, 0 fallos atribuibles. Revertido y `diff -q` contra el
  original ⇒ idénticos.
  (Los 2 archivos rojos de la corrida completa son `discover-callsites.test.ts` y un
  hermano: fallan con *"not a git repository"* porque la copia no tiene `.git`. No
  son del código.)
- **M-3**: cuerpo de `isUsableRegistryMaxLimit` sin el `typeof` ⇒ `tsc --noEmit`
  limpio + 56/56 verdes; y `tsc --strict` sobre un probe aislado sin el `typeof` y
  **sin** cast ⇒ `TS18046`.
- **§2 (predicate)**: dos guards idénticos salvo la firma, `tsc --strict --noEmit`,
  asignando el valor narroweado a `string` para revelar el tipo ⇒ `never` con
  predicate, `number` con `boolean`.
- El árbol del repo quedó **sin tocar**: el único archivo que escribí es este
  `cr-report.md`.

---

## 11. Lo que NO hay que cambiar (para que nadie lo "mejore")

1. **La decisión Opción A** (sin declaración usable no hay clamp) y la ausencia de un
   default de 100. Está justificada en `:92-97`, pineada por T-CLAMP-04b y matada por
   M2. Un default de 100 cambia un `400` ruidoso por un recorte mudo.
2. **`declared: unknown`** en los dos helpers. El campo viene de `jsonb` que el
   write-path no valida (`routes/registries.ts:69,251`, verificado); tiparlo `number |
   undefined` haría parecer código muerto a un guard que sí corta.
3. **El `!== undefined`** de `discovery.ts:1089`. Separa "no declaró" de "declaró
   basura" y la diferencia **es observable** (`undefined` no warnea, `null` sí).
4. **`sentLimit < unclamped`** en `:1106`. Es correcto: sacarlo emite salida nueva en
   el camino que CD-3 se comprometió a dejar intacto. Justamente por eso pido el test
   de M-1 antes de que alguien lo borre por parecer redundante.
5. **Las aserciones contra el string literal** (`['100']`, `['200']`, `['10']`). CD-7.
   Reemplazarlas por `String(Math.min(...))` dejaría sobrevivir a M3.
6. **`serveByHost` sin tocar** en `discovery.sources.test.ts`: lo usan T-SRC-01..13.

---

## 12. Resumen para el orquestador

1. **Veredicto: APROBADO CON MENORES.** Ninguno bloquea el merge; ninguno cambia la
   conducta del clamp.
2. El diseño central se sostiene: **un solo choke-point**, verificado con grep — un
   único `searchParams.set(schema.limitParam, …)` y un único llamador de
   `queryRegistry`; los 6 puntos de entrada (incluidos `/capabilities` y
   `capability-resolver`, que el commit no enumera) heredan gratis o caen en la rama
   "sin `limit`" ya testeada.
3. **Los tres helpers se justifican.** `isUsableRegistryMaxLimit` no es de más: tiene
   dos consumidores con decisiones distintas (clampear / avisar) y el warn **no** puede
   derivarse del retorno del clamp, porque `sentLimit === unclamped` es ambiguo.
4. **Decisión pedida — el cast se queda, y no por respeto al contrato**: medí que un
   type predicate narrowearía `schema.maxLimit` a **`never`** dentro del `warn` que
   existe para reportar la basura, y tsc **no verifica** el cuerpo de un predicate, así
   que no gana sanidad: sólo mueve una aserción no chequeada a un lugar invisible.
5. **Hallazgo principal (M-1)**: la mitad `sentLimit < unclamped` del guard de
   `discovery.ts:1106` está **enunciada en tres lugares con su input falsificador y no
   tiene ningún test**. Medido: borrarla deja la suite **completa** en verde. Fix = un
   sub-caso de 8 líneas en T-CLAMP-02 + M11 en el mutation-log.
6. **M-2** lo agrava: `clampFallsBelowComposePoolFloor` afirma una causa ("el clamp")
   que su cuerpo (`sent < 50`) no puede conocer, así que el nombre invita a borrar
   justo la mitad que no tiene test. Rename mecánico, un call-site.
7. **M-3**: el `typeof` no es quien rechaza `"abc"` (eso lo hace `Number.isInteger`,
   medido); es quien hace compilar `declared >= 1` sobre `unknown` (`TS18046`, medido).
   La cláusula se queda, la frase cambia.
8. **M-4**: cinco punteros `archivo:línea` quedaron corridos por las líneas que la
   propia HU agregó arriba (`types/index.ts:160`→`171`, `discovery.ts:63`→`68` ×2,
   `1115-1117`→`1155-1157`). Son 5 números.
9. **M-5**: "el leg se saltea en silencio" recorta una disyunción que el repo ya tenía
   bien escrita en `compose.ts:125-126`; en el escenario de T-CLAMP-05 lo que pasa es
   la **otra** rama (rail equivocado). Viene heredado del SDD.
10. **M-6**: `serveRegistryWithCeilingOf100` duplica ~30 líneas de `serveRegistry` en el
    mismo archivo. Un parámetro `{ ceiling }` lo cierra.
11. **Tests**: 13/13 presentes y cada uno mata al menos un mutante. Un solo claim de
    media (M-1). Cero tests incapaces de ponerse rojos; T-CLAMP-07 es el único cuyo
    rojo vive fuera del diff (M7 en `compose.ts`) y está declarado en el mutation-log.
    T-CLAMP-06 (schema desde el literal jsonb de la migración) y T-CLAMP-07b (afirma el
    residual en vez de disfrazarlo) son de calidad alta.
12. **Diff limpio**: waves 1:1 con commits, cero reformateos, cero imports huérfanos, la
    única línea existente modificada es el mock del logger que el story file autorizó
    explícitamente, y ninguno de los 7 archivos de la lista prohibida fue tocado.
13. **Deuda**: no es un cajón. TD-318B-2 tiene gatillo **cableado y testeado**;
    TD-318B-5 es verificable con un `SELECT`; TD-318B-1 está reflejada en tres lugares
    independientes. **TD-318B-3** (write-path sin validar) es la única floja y hay que
    sacarla al backlog con número propio: es la contracara del guard de lectura que
    esta HU acaba de montar.
14. **Los tres desmentidos del Dev son correctos** y están bien razonados (verifiqué los
    tres). Residual: el story file sigue afirmando lo desmentido sin puntero — que
    `nexus-docs` agregue una línea al pie en el cierre. No es trabajo del Dev.
15. **Sugerencia de orden**: M-1 (test) y M-2 (rename) van juntos, son el mismo problema
    visto desde dos lados. M-3/M-4/M-5 son texto. M-6 es opcional pero barato.
