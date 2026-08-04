# Story File — WKH-318 corte B · el over-fetch se clampea al techo que el registry DECLARA

| Campo | Valor |
|---|---|
| HU | WKH-318 corte B (W3 del corte A) |
| SDD | [`sdd.md`](sdd.md) — `SPEC_APPROVED` otorgado (7/7 criterios) |
| Work item | [`work-item.md`](work-item.md) — `HU_APPROVED` |
| Metodología | QUALITY |
| Branch | `feat/218-wkh-318-corte-b-maxlimit-clamp` (HEAD `310b2cd`) — **no cambies de rama, no mergees, no pushees** |
| Archivos de producción | **2** (`src/lib/discovery-fetch-limit.ts`, `src/services/discovery.ts`) |
| Archivos de tipos/prosa | 1 (`src/types/index.ts`, sólo JSDoc) |
| Migraciones | 2 archivos nuevos, **NO se aplican** |
| Archivos de test | 4 (aditivos + 2 líneas de mock que cambian, §7.5) |
| Doc de trazabilidad | 1 (`doc/sdd/215-.../backlog.md`, 2-4 líneas) |
| Fecha | 2026-08-04 |

> **Este documento es tu único contrato.** No leas el SDD: todo lo que necesitás está
> acá. Si algo que necesitás no está acá, **no lo inventes** — grepealo, y si no existe,
> pará y escribilo en el reporte.

---

## 1. Qué se construye, en una frase que se puede falsificar

Cuando un registry declara `schema.discovery.maxLimit`, el `limitParam` que le enviamos
pasa a ser `min(over-fetch, maxLimit)` en vez del over-fetch pelado.

Input que lo verifica: registry con `maxLimit: 100`, `discover({ limit: 500 })` ⇒ la URL
que sale lleva `?limit=100`. Hoy lleva `?limit=500`.

**Eso es todo el cambio de conducta.** Una línea de aritmética, dos `log.warn`, dos
helpers en un módulo leaf, dos archivos SQL que nadie ejecuta, y trece tests.

### El bug que lo motiva, medido

`resolveUpstreamFetchLimit` (`src/lib/discovery-fetch-limit.ts:47-52`) devuelve
`max(pageLimit, 200)` y `queryRegistry` lo manda tal cual
(`src/services/discovery.ts:1073-1076`) sin mirar si ese registry declaró un techo. El
registry `wasiai` responde **`400`** a cualquier `limit > 100`, y ese `400` tumba la
fuente **entera** (`src/services/discovery.ts:1115-1117` lanza `RegistryHttpError`).

Medido en producción el 2026-08-04: `GET /discover?limit=N` devuelve **3 de 23 agentes**
para cualquier `N` — sobreviven sólo los 3 self-published.

---

## 2. 🔴 LEELO ANTES DE EMPEZAR: esta HU no arregla producción

**Con tu código desplegado y la migración sin aplicar, `/discover?limit=50` sigue
devolviendo 3 de 23.** No "casi lo arregla". No lo arregla.

La cadena, paso a paso, cada uno verificable:

1. Ninguna fila de `registries` en bdwv tiene hoy `schema.discovery.maxLimit`.
2. ⇒ `schema.maxLimit` es `undefined` en toda invocación de `queryRegistry`.
3. ⇒ `clampToRegistryMaxLimit(200, undefined)` devuelve `200` (§6 W0.2).
4. ⇒ el `limitParam` que sale por la red es **byte-idéntico** al de hoy.
5. ⇒ el registry `wasiai` sigue recibiendo `limit=200`, sigue contestando `400`, la
   fuente sigue cayendo.
6. ⇒ **el catálogo público sigue degradado.**

Y el `warn` de `REGISTRY_MAX_LIMIT_INVALID` **tampoco** se emite en ese estado:
`undefined` es **ausencia de declaración**, no declaración inválida. Son casos distintos
y el código los separa (§6 W1.2).

Lo que esta HU entrega es: **el clamp existe, funciona, y se activa solo el día que el
dato esté**. La migración que pone el dato **la aplica el founder** (§6 W2).

> ⛔ **PROHIBIDO** escribir en el commit, en el auto-blindaje, en un comentario o en
> cualquier `.md` que esta HU "arregla el catálogo", "restaura los 23 agentes" o
> "cierra el 400 en producción". Es falso hasta que la migración se aplique, y una
> frase que afirma de más apaga las tres revisiones siguientes. Si querés una frase
> corta y verdadera, usá esta: *"el clamp existe y funciona; se activa cuando la fila
> de `registries` declare su techo"*.

---

## 3. 🔴 La decisión central: un registry SIN `maxLimit` NO se clampea

**Sin declaración, cero clamp, comportamiento byte-idéntico al de hoy.**

Vas a tener el impulso de "mejorarlo" poniendo un default de 100, porque arreglaría
producción sin esperar la migración. **Ese impulso es la trampa de esta HU.** Las tres
razones, en orden de peso:

### 3.1 Un default de 100 cambia un `400` ruidoso por un recorte MUDO

Hoy `wasiai` grita `400` y desde el corte A eso sale publicado como `state: 'failed'` /
`failure: 'http_error'` en `sources[]` (`src/services/discovery.ts:657-668`), y arrastra
`catalogStatus: 'partial'` (`src/lib/discovery-sources.ts:58`). Es visible.

Con un default de 100 aplicado a un registry que acepta **1000**: le pedimos 100, nos da
100, y el pool de ranking de esa fuente cae de 200 a 100 filas **sin que nadie lo haya
pedido y sin que nada lo diga**.

Input concreto del daño: un registry con 300 agentes activos donde el agente Solana que
`/compose` necesita hidratar está en la posición 150 del ranking (verified-first →
reputación desc → precio asc). Con over-fetch 200 entra; con default 100 **no entra**,
`payment.chain` no se hidrata, queda el `avalanche` hardcodeado de `getAgent`, y el leg
downstream se saltea en silencio. Es exactamente el caso que
`src/lib/discovery-fetch-limit.ts:59-75` documenta como BLQ-BAJO-1 de WKH-189: **el
agente no se cobra, en silencio.**

### 3.2 `100` no es un estándar: es el número de `wasiai-v2`

Elegirlo como default global es generalizar el contrato de **un** servidor a todos los
demás. No existe especificación que lo respalde y no la vamos a inventar.

### 3.3 AC-2 y CD-3 lo mandan

"Preservar el comportamiento actual byte-idéntico" y "el clamp es estrictamente aditivo,
nunca puede volverse más restrictivo por default".

### El costo, sin maquillar

Un registry que se agregue mañana con techo real de 40 y **sin** declarar `maxLimit`
sigue roto exactamente como hoy: recibe 200, contesta 400, la fuente cae. **Esta HU no
lo cubre.** Lo que sí hay es que el corte A ya lo hace visible en `sources[]` en vez de
invisible. La salida real para ese caso es validar/declarar el techo en el alta del
registry, que es **TD-318B-3** y no entra acá.

---

## 4. 🔴 Dónde va el clamp, y por qué ahí no es cuestión de estilo

**La aritmética va en `src/lib/discovery-fetch-limit.ts`. El call-site va en
`src/services/discovery.ts`. No al revés, y no todo junto en el service.**

`src/lib/discovery-fetch-limit.ts` es un módulo **LEAF: cero imports** (verificalo, son
119 líneas y no hay una sola línea `import`). Su propio docstring (`:1-10`) explica por
qué eso no es una preferencia:

> *"media docena de suites mockean `../services/discovery.js` COMPLETO con factories sin
> `importOriginal` (`e2e/setup.ts`, `e2e/compose-flow.test.ts`, ...), así que un export
> nuevo del service que `compose.ts` consuma quedaría `undefined` ahí. Ya pasó dos veces
> en este fix-pack (12 y 84 tests rotos)."*

⇒ Si ponés `clampToRegistryMaxLimit` como export de `src/services/discovery.ts`, en esas
suites vale `undefined`, y `undefined(...)` es un `TypeError` en runtime que aparece a
docenas de tests de distancia del archivo que tocaste. **Ya rompió 12 tests una vez y 84
otra.** No lo repitas.

**El clamp se aplica en UN solo choke-point**: `queryRegistry`
(`src/services/discovery.ts:1038`). Por ahí pasan los cuatro consumidores medidos, y por
eso **ninguno de los cuatro se toca**:

| Consumidor | Archivo:línea | `limit` que manda |
|---|---|---|
| `/discover` | `src/routes/discover.ts:219`, `:289` | el del caller |
| `/compose` (money-path) | `src/services/compose.ts:136` vía `resolveComposeAgentPoolLimit()` | 50 → 200 |
| `/orchestrate` | `src/services/orchestrate.ts:560`, `:579` | 50 |
| MCP tool | `src/mcp/tools/discover-agents.ts:37` | `input.limit ?? 20` |

---

## 5. Constraint Directives — todas vigentes, ninguna negociable

### Heredadas del work-item

- **CD-1** — PROHIBIDO modificar código o config en `wasiai-v2`, `chaski-v3`,
  `wasiai-facilitator` o los agentes `remit-*`. Esta HU es 100% `wasiai-a2a`.
- **CD-2** — OBLIGATORIO que el camino **sin `limit` del caller** quede byte-idéntico.
  El gate `if (query.limit && schema.limitParam)` (`src/services/discovery.ts:1073`)
  **no cambia su condición de entrada**; sólo cambia el cálculo de `sentLimit` adentro.
- **CD-3** — OBLIGATORIO que un registry **sin** `maxLimit` tenga comportamiento
  byte-idéntico al actual. El clamp es estrictamente aditivo.
- **CD-4** — PROHIBIDO tocar `DiscoverySourceFailure`, `classifyFetchFailure`
  (`src/lib/discovery-sources.ts:76-91`) o `decisiones.md`/D-1 de WKH-318. Un `400`
  nuestro y un registry caído siguen siendo el mismo `http_error`. Es follow-up propio.
- **CD-5** — OBLIGATORIO que la migración sea aditiva (`jsonb_set` con
  `create_missing = true`), no toque la columna `auth`, y se aplique **SOLO a bdwv**
  (nunca a caldz, que es archivo mainnet).
- **CD-6** — verificar la precondición de `src/lib/discovery-fetch-limit.ts:77-105` si el
  diseño toca más de un registry con `maxLimit` propio. **Ya evaluada en F2: se declara
  `maxLimit` para UNA fila (`id='wasiai'`) y la precondición no cambia.** No la
  re-evalúes; si una HU futura declara un segundo, es TD-318B-5.

### Nuevas del SDD — las cuatro primeras salen de errores que ya cometimos ≥2 veces

- **CD-7 (guard contra sí mismo)** 🔒 — PROHIBIDO que un test del clamp compare contra un
  valor **recalculado** con `resolveUpstreamFetchLimit(...)`, `Math.min(...)` o una
  constante importada. La aserción se hace contra **el número literal leído de la query
  string enviada** (`upstreamLimits`). Ver §7.4: es la trampa de esta HU.
  Referencias: WKH-322 auto-blindaje *"escribí un test que medía la constante contra sí
  misma"*; WKH-315 *"el test probaba el validador, no la ausencia del fallback"*.
- **CD-8 (prosa falsable)** — cada afirmación universal en comentario o JSDoc va con el
  input concreto que la rompería, o no se escribe. Referencias: WKH-315 *"el
  sobre-anuncio apaga las revisiones"* (causa raíz de **5 iteraciones**); WKH-322 AR-4
  MNR-3. Fue el hallazgo principal de **tres HUs seguidas**.
- **CD-9 (la regla se aplica a TODAS las ramas, enumeradas)** — enumerá explícitamente,
  en el commit o en el auto-blindaje, qué hace el clamp en las **cinco** ramas, y tené un
  test por cada una:
  (a) federado con `limit` y `maxLimit` **válido** → T-CLAMP-01;
  (b) federado con `limit` **sin** `maxLimit` → T-CLAMP-02;
  (c) federado con `limit` y `maxLimit` **inválido** → T-CLAMP-08;
  (d) **sin** `limit` del caller → T-CLAMP-02b;
  (e) registry **sin** `limitParam` → T-CLAMP-02c.
  Referencia: WKH-318 auto-blindaje *"la misma regla se me escapó TRES veces, cada vez en
  un borde distinto"*; WKH-315 *"enuncié una regla y la apliqué a un solo caso"* (×3).
- **CD-10 (migración: copiar el exemplar entero)** — el SQL nuevo copia el
  `WHERE id = 'wasiai' AND schema -> 'discovery' IS NOT NULL`, el aviso de no tocar
  `auth`, y trae su `_down.sql`. Además lleva en **línea 2** el marcador textual de §6 W2.
  Referencia: WKH-315 *"copié el idioma de la migración exemplar, pero no la línea que
  cerraba la ventana"*.
- **CD-11 (una sola expresión por concepto)** — PROHIBIDO escribir `100`, `'wasiai'` o
  `50` como literal en `src/` para este cambio. El techo entra **sólo** por la fila de
  `registries`; el piso del pool se consulta por `clampFallsBelowComposePoolFloor`, no
  reimplementando `< 50`. El chequeo de validez vive en **una** función
  (`isUsableRegistryMaxLimit`), llamada desde los dos lugares que lo necesitan.
- **CD-12 (verde medido, no supuesto)** — antes de declarar terminado: `npx tsc --noEmit`
  **completo** (no `npm run build`, que no ve todo — lección de WKH-196), `npm run lint`,
  y la suite **completa**. El conteo de tests se **cita**, no se estima.
- **CD-13 (un techo inválido NO falla cerrado)** 🔒 — `maxLimit` inválido ⇒ **sin clamp**
  + `warn`. PROHIBIDO degradar a `1`, a `0` o al piso del pool. Con `maxLimit: 0` el
  fail-closed mandaría `limit=0`, el registry devolvería 0 filas y **el catálogo quedaría
  casi vacío en silencio**. Ignorar deja que el registry conteste; si su techo real es
  menor contesta `400`, que es visible. **Entre un catálogo vacío mudo y un `400`
  publicado, gana el `400`.**

---

## 6. Waves

**Orden: W0 → W1 → W3.** W2 y W4 son paralelizables y no dependen de nada.

```
W0 (leaf + tipos)  ──►  W1 (cableado)  ──►  W3 (tests)
W2 (migración)     ──  independiente
W4 (backlog corte A) ──  independiente
```

---

### W0 — Contratos y prosa (SERIAL, bloquea W1 y W3). Cero cambio de conducta.

#### W0.1 — `isUsableRegistryMaxLimit(declared: unknown): boolean`

En `src/lib/discovery-fetch-limit.ts`, **exportada**.

```
typeof declared === 'number' && Number.isInteger(declared) && declared >= 1
```

**Por qué `unknown` y no `number | undefined`** — y esto no es paranoia decorativa:

- `RegistrySchema.discovery.maxLimit` está tipado `number | undefined`
  (`src/types/index.ts:160`), pero el valor viene de una columna **`jsonb`** que
  `src/services/registry.ts:92` asigna directo (`schema: row.schema`), con el narrowing
  hecho por un `as unknown as` que los propios comentarios M9 llaman "narrowing acotado"
  (`src/services/registry.ts:153-155`).
- Y el write-path **no valida nada**: `POST /registries` verifica la **presencia** de
  `schema` (`src/routes/registries.ts:69`) y lo guarda tal cual
  (`src/routes/registries.ts:251`). **Cero `zod`, cero `typebox` en ese archivo.**
- ⇒ en runtime `maxLimit` puede ser `"100"`, `0`, `-5`, `1.5`, `null`, `{}` o `"abc"`.
  El tipo `number` es una promesa de TypeScript, no una garantía de runtime.

Si tipás el parámetro `number | undefined`, el guard parece código muerto y un revisor
futuro lo borra "porque tsc ya lo garantiza". **El `unknown` es lo que documenta la
desconfianza en la firma.**

⚠️ **El gotcha de `Math.min` que este guard corta**: `Math.min(200, "100")` devuelve
`100` (JS coerce el string) y `Math.min(200, "abc")` devuelve **`NaN`**, que terminaría
como `?limit=NaN` en la query string. Es el mismo hazard que
`src/lib/discovery-fetch-limit.ts:37-38` ya nombra ("nunca NaN en la query string"). El
`typeof` corta las dos antes de llegar a `Math.min`.

#### W0.2 — `clampToRegistryMaxLimit(fetchLimit: number, declared: unknown): number`

```
if (!isUsableRegistryMaxLimit(declared)) return fetchLimit;   // Opción A: sin clamp
return Math.min(fetchLimit, declared);
```

**OBLIGATORIO que llame a `isUsableRegistryMaxLimit`** (CD-11). PROHIBIDO copiar la
cadena `typeof`/`Number.isInteger`/`>= 1` una segunda vez: dos expresiones del mismo
concepto divergen, y el call-site necesita el mismo predicado para decidir si emitir el
`warn`.

> **Nota de trazabilidad**: el SDD §10 W0 listaba **dos** helpers. Este story file manda
> **tres**, y el tercero (`isUsableRegistryMaxLimit`) es una consecuencia directa de
> CD-11 + CD-13: sin él, el call-site tendría que reimplementar el guard para saber si
> lo que recibió era "ausente" o "inválido". **Es deliberado, no drift.**

#### W0.3 — `clampFallsBelowComposePoolFloor(sent: number): boolean`

```
return sent < COMPOSE_POOL_MIN_LIMIT;   // la constante de :32, sin duplicar el 50
```

Existe por CD-11: `sent < 50` escrito a mano en `src/services/discovery.ts` sería la
segunda expresión del mismo concepto. Su consumidor es el `warn` de W1.3.

#### W0.4 — Enmienda de prosa en `src/lib/discovery-fetch-limit.ts`

🔴 **Corrección al SDD, verificada en este árbol.** El SDD dice que la frase
*"nunca under-fetch"* está en `:36-46` (el docstring de la función). **Es falso**: está
en el docstring **de módulo**, en `:20-22`:

```
 * Ahora el upstream recibe un límite de OVER-FETCH independiente del page size.
 * Monótono: si el caller pide más que el over-fetch, gana el caller (nunca
 * under-fetch).
```

**Si sólo editás `:36-46`, la frase falsa se queda.** Editá `:20-22`.

Qué hay que decir ahí, y por qué:

- La frase **sigue siendo verdadera de la función**: `resolveUpstreamFetchLimit` no se
  modifica y sigue devolviendo `max(pageLimit, base)`.
- Lo que deja de ser verdad es la propiedad **del call-site**. Input que la falsifica:
  registry con `maxLimit: 100` + `GET /discover?limit=150` ⇒ se envía `100`, o sea
  **menos que lo que el caller pidió**.
- Eso es **correcto y deliberado**: el registry no puede dar más sin paginar, y paginar
  está descartado (TD-318-2: se detecta, no se pagina). Se reporta como
  `truncated`/`page_full`, no se esconde.

⇒ Escribí un puntero al clamp del call-site con ese input concreto al lado. **Sin ese
puntero, "nunca under-fetch" se lee como una garantía de extremo a extremo que el código
ya no da** (CD-8).

#### W0.5 — `src/types/index.ts:145-160` — el JSDoc de `maxLimit`

Hoy dice, textual en `:149`: **"⚠️ TODAVÍA NO LO LEE NADIE."** Esta HU vuelve esa frase
falsa. Reescribí el bloque `:145-160` con:

1. Qué hace el clamp cuando el campo está: `min(over-fetch, maxLimit)` en `queryRegistry`.
2. Qué pasa cuando **no** está: nada, sin clamp (§3).
3. Qué pasa cuando está y es **inválido**: sin clamp + `warn` (CD-13).
4. **El residual honesto, con su input** (CD-8): un registry que clampea en silencio y
   **no** declara `maxLimit` sigue leyéndose `ok`. Input: registry sin `maxLimit` que
   recibe `limit=200`, devuelve 100 filas y no manda cursor ⇒ `100 < 200` ⇒
   `completenessProven = true` ⇒ `state: 'ok'`, idéntico a hoy.

> ⛔ **PROHIBIDO escribir ahí que "esto cierra el truncamiento silencioso"**. Lo cierra
> **sólo para los registries que declaran `maxLimit`**. El `backlog.md` del corte A dice
> *"W3 lo cierra por construcción"* y esa redacción es la que W4 va a corregir.

#### ✅ Criterio de terminado de W0 — medible

1. `npx tsc --noEmit` exit 0.
2. **La suite completa verde SIN un solo test nuevo.** Los tres helpers todavía no los
   llama nadie, así que ningún test existente puede cambiar de color.
   **Si alguno cambia, es un hallazgo de W0 — paralo y escribilo.** No lo arregles en W1.
3. `git diff --stat` toca exactamente 2 archivos: `src/lib/discovery-fetch-limit.ts` y
   `src/types/index.ts`.
4. `src/lib/discovery-fetch-limit.ts` **sigue sin una sola línea `import`**.

---

### W1 — El cableado (depende de W0). Un solo bloque de `src/services/discovery.ts`.

#### W1.1 — El clamp, en `src/services/discovery.ts:1072-1076`

Hoy:

```ts
let sentLimit: number | undefined;
if (query.limit && schema.limitParam) {
  sentLimit = resolveUpstreamFetchLimit(query.limit);
  url.searchParams.set(schema.limitParam, sentLimit.toString());
}
```

Lo que queda (forma; escribilo vos):

```
let sentLimit: number | undefined;
if (query.limit && schema.limitParam) {
  const unclamped = resolveUpstreamFetchLimit(query.limit);
  sentLimit = clampToRegistryMaxLimit(unclamped, schema.maxLimit);
  url.searchParams.set(schema.limitParam, sentLimit.toString());
  // los dos warn de W1.2 y W1.3
}
```

⚠️ **CD-2: el gate `if (query.limit && schema.limitParam)` no cambia su condición.**
Sólo cambia el cálculo de adentro. El comentario de `:1065-1069` explica por qué ese gate
existe — *"imponer un cap donde antes no había ninguno sería reintroducir el mismo bug de
clase 'esconder agentes' en el path sin `limit`"*. Leelo antes de tocarlo.

#### W1.2 — `warn` de techo inválido

Condición exacta:

```
schema.maxLimit !== undefined && !isUsableRegistryMaxLimit(schema.maxLimit)
```

**El `!== undefined` es la línea que separa "no declaró" de "declaró basura", y es
observable**: un JSON sin la clave da `undefined`; un `"maxLimit": null` explícito da
`null`. `undefined` **no** warnea (§2, punto 4). `null` **sí** warnea.

Formato — copiá el precedente de `src/services/discovery.ts:270-277`, con `error_code`
como **primer campo** del objeto:

```
log.warn(
  { error_code: 'REGISTRY_MAX_LIMIT_INVALID', registry: registry.name, declared: <el valor crudo> },
  '<mensaje>',
);
```

`log` ya existe en el módulo: `const log = getLogger('discovery')`
(`src/services/discovery.ts:63`). **No agregues un logger nuevo.**

#### W1.3 — `warn` de techo por debajo del piso del pool de `/compose`

Condición exacta — **las dos partes, no una sola**:

```
sentLimit < unclamped && clampFallsBelowComposePoolFloor(sentLimit)
```

**Por qué las dos.** Si mirás sólo `clampFallsBelowComposePoolFloor(sentLimit)`, un
operador que setea `DISCOVERY_UPSTREAM_FETCH_LIMIT=10` contra un registry **sin**
`maxLimit` produciría el `warn` — y eso viola CD-3, porque estaríamos agregando salida
observable a un camino que esta HU se comprometió a dejar intacto. La primera mitad
(`sentLimit < unclamped`) es la que dice "el clamp fue quien bajó el número".

`error_code: 'REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL'`, con `registry` y `sentLimit`.

**Qué avisa y qué NO impide** (TD-318B-2): `resolveComposeAgentPoolLimit()`
(`src/lib/discovery-fetch-limit.ts:117-119`) existe para que `/compose` tenga un pool con
piso histórico 50. Un registry que declare `maxLimit: 10` hunde ese pool a 10 filas para
esa fuente, y el agente que quede afuera no hidrata `payment.chain` ⇒ leg downstream
salteado en silencio.

> ⛔ **PROHIBIDO poner un piso al clamp** (nada de `max(50, min(...))`). Mandarle 50 a un
> registry que declaró 10 nos devuelve un `400` y perdemos la fuente **entera** en vez de
> quedarnos con 10 de sus filas. **La declaración del registry gana; el costo se declara
> en vez de esconderse.** El `warn` avisa, no impide. Eso está pineado por T-CLAMP-07b.

#### W1.4 — Lo que NO se toca en este archivo

- **El bloque de evidencia de truncamiento (`:1165-1204`) no cambia una línea.**
  `:1184-1190` decide `page_full` con `agents.length >= sentLimit`, y como el clamp
  modifica `sentLimit` **antes** de mandar el request, ese bloque ya compara contra el
  número realmente enviado. **Hereda el clamp gratis.**
  Consecuencia (AC-3): `maxLimit: 100` con 100+ agentes ⇒ pedimos 100, llegan 100 ⇒
  `truncated`/`page_full`. `maxLimit: 100` con 23 agentes ⇒ llegan 23 < 100 ⇒
  `completenessProven` ⇒ `ok`. Ese segundo caso es el que esperamos de `wasiai` hoy.
- El `throw new RegistryHttpError` (`:1115-1117`).
- `classifyFetchFailure` / `DiscoverySourceFailure` (CD-4).
- La construcción de `sources[]` (`:657-668`) y `contributingRegistries` (`:678-680`).
- El `slice(0, query.limit)` global (`:638`).
- La fuente local con `state: 'ok'` (`:250-254`) — es B-5 del corte A, fuera de alcance.

#### ✅ Criterio de terminado de W1 — medible

1. `npx tsc --noEmit` exit 0.
2. **La suite COMPLETA verde** (`npm test`), no sólo los archivos que tocaste. Los tests
   de no-regresión de §7.5 tienen que pasar **sin modificarse en su conducta**.
3. `git diff src/services/discovery.ts` muestra cambios **sólo** dentro del bloque
   `:1072-1076` (+ las líneas de `warn`). Si aparece un `-` en cualquier otra parte del
   archivo, revertilo.
4. `grep -n "100\|\b50\b" src/services/discovery.ts` no devuelve ningún literal nuevo
   relacionado con este cambio (CD-11).

---

### W2 — Migración de datos (independiente; **NO se aplica**)

Dos archivos nuevos, copiando **línea por línea** la forma del exemplar
`supabase/migrations/20260730010000_wkh318_registry_next_cursor_path.sql` (19 líneas) y
su `_down` (18 líneas). Leelos antes de escribir.

| Archivo | Contenido |
|---|---|
| `supabase/migrations/20260804000000_wkh318b_registry_max_limit.sql` | `UPDATE registries SET schema = jsonb_set(schema, '{discovery,maxLimit}', '100'::jsonb, true) WHERE id = 'wasiai' AND schema -> 'discovery' IS NOT NULL;` |
| `supabase/migrations/20260804000000_wkh318b_registry_max_limit_down.sql` | `UPDATE registries SET schema = jsonb_set(schema, '{discovery}', (schema -> 'discovery') - 'maxLimit') WHERE id = 'wasiai' AND schema -> 'discovery' IS NOT NULL;` |

Obligatorio en **ambos**, copiado del exemplar:

- El `WHERE id = 'wasiai' AND schema -> 'discovery' IS NOT NULL` completo.
- El aviso de que **la columna `auth` NO se toca** (borrar esa credencial reabre la
  recursión a2a → v2 → a2a).
- La línea **"Aplicar SOLO a bdwv"**. Nunca caldz: caldz es archivo mainnet.

#### 🔴 El marcador de línea 2 — textual, en LOS DOS archivos

```
-- NO aplicar: la aplica el founder (accion gated, classifier)
```

⚠️ **No busques precedente de esta línea: no existe.** `grep -rn "NO aplicar"
supabase/migrations/` devuelve **0 hits** sobre los 100 archivos del directorio. La
convención la crea esta HU (CD-10). Copiala carácter por carácter, sin tildes, en la
**línea 2** (la línea 1 es el título `-- WKH-318 corte B — ...`).

#### ⛔ Vos NO ejecutás esta migración

- No corras `supabase db push`, ni `psql`, ni el MCP de Supabase, ni ningún script que
  aplique migraciones.
- No busques credenciales de bdwv. No abras `m5-keys/`.
- El pipeline **escribe** la migración; **el founder la aplica**.

Verificación read-only de un renglón, **para el founder** (dejala en el reporte, no la
corras vos):

```sql
SELECT id,
       schema->'discovery'->'nextCursorPath' AS cursor_path,
       schema->'discovery'->'maxLimit'       AS max_limit
FROM registries WHERE id = 'wasiai';
```

Esperado post-migración: `cursor_path = "next_cursor"`, `max_limit = 100`.

**Timestamp verificado sin colisión**: el archivo más nuevo del directorio hoy es
`20260731000000_wkh315_solana_deposit.sql`, así que `20260804000000` queda último en
orden lexicográfico.

---

### W3 — Tests (depende de W1). Paralelizable por archivo.

| Sub-wave | Archivo | Tests |
|---|---|---|
| W3.a | `src/services/discovery.limit.test.ts` | T-CLAMP-01, 02, 02b, 02c, 06, 08 |
| W3.b | `src/services/discovery.truncation.test.ts` | T-CLAMP-03, 03b |
| W3.c | `src/services/discovery.sources.test.ts` | T-CLAMP-04, 04b |
| W3.d | `src/services/compose.discovery-pool.test.ts` | T-CLAMP-05, 07, 07b |

Detalle completo en §7.

---

### W4 — Trazabilidad (independiente, sin código)

`doc/sdd/215-wkh-318-discover-limit-colapsa-registro-federado/backlog.md`, sección **B-3**
(`:139-149`). Hoy dice:

> *"**W3 lo cierra** por construcción: con `maxLimit` declarado se envía
> `min(over-fetch, maxLimit)`, la página se llena, y `page_full` marca `truncated`."*

**Agregá 2-4 líneas** (no reescribas el resto del archivo) diciendo:

- B-3 queda **cerrado sólo para los registries que declaran `maxLimit`**, no para todos.
- El input que lo demuestra: registry **sin** `maxLimit` que recibe `limit=200`, devuelve
  100 filas y no manda cursor ⇒ `100 < 200` ⇒ `completenessProven = true` ⇒ `state: 'ok'`,
  idéntico a hoy.
- Puntero a `doc/sdd/218-wkh-318-corte-b-maxlimit-clamp/` y a **TD-318B-1**.

---

## 7. Tests

### 7.1 Mapa AC → test → mutante

**13 tests, 7 ACs, 10 mutantes.** Todo test afirma sobre `upstreamLimits`, que es el
valor **leído de la URL enviada** (CD-7).

| Test | Archivo | AC / CD | Qué monta | Qué afirma | Mutante |
|---|---|---|---|---|---|
| **T-CLAMP-01** | `discovery.limit.test.ts` | AC-1, CD-9(a) | `maxLimit: 100`, `discover({ limit: 500 })` | `upstreamLimits` es **`['100']`** (literal) | M1, M3 |
| **T-CLAMP-02** | `discovery.limit.test.ts` | AC-2, CD-9(b) | **sin** `maxLimit`, 3 sub-casos: `limit=5`⇒`'200'`; `limit=500`⇒`'500'`; `DISCOVERY_UPSTREAM_FETCH_LIMIT=300`+`limit=5`⇒`'300'`. **Además**: `logSpy.warn` NO fue llamado con `REGISTRY_MAX_LIMIT_INVALID` | byte-idéntico a T-4/T-6/T-5 de hoy | M2 |
| **T-CLAMP-02b** | `discovery.limit.test.ts` | AC-2, CD-2, CD-9(d) | `maxLimit: 100`, `discover({})` **sin** `limit` | `upstreamLimits` es **`[null]`** — no se envía ningún `limitParam` | M5 |
| **T-CLAMP-02c** | `discovery.limit.test.ts` | AC-2, CD-9(e) | `maxLimit: 100` y **sin** `limitParam`, `discover({ limit: 500 })` | `upstreamLimits` es **`[null]`** | M5 |
| **T-CLAMP-03** | `discovery.truncation.test.ts` | AC-3 | `maxLimit: 100`, sin `nextCursorPath`, el mock devuelve **100** filas ante `limit=500` | `sources[0].state === 'truncated'`, `truncationEvidence === 'page_full'`, `rows === 100`, `catalogStatus === 'truncated'`, y `failure` es `undefined` | M1 |
| **T-CLAMP-03b** | `discovery.truncation.test.ts` | AC-3 | `maxLimit: 100`, el mock devuelve **23** filas | `sources[0].state === 'ok'` (sin falso positivo de truncamiento bajo el techo) | M6 |
| **T-CLAMP-04** | `discovery.sources.test.ts` | AC-4 | **mimic del contrato medido de `wasiai`**: `limit > 100` ⇒ `{ ok: false, status: 400 }`; `limit <= 100` ⇒ 200 + catálogo. `maxLimit: 100`, `discover({ limit: 200 })` | la fuente **no** es `failed`, `failure` es `undefined`, `rows > 0`, `catalogStatus !== 'partial'` | M1 |
| **T-CLAMP-04b** | `discovery.sources.test.ts` | AC-4 (control negativo) | el **mismo** mimic **sin** `maxLimit` | la fuente **sí** es `failed` / `http_error`, `catalogStatus === 'partial'` | M2 |
| **T-CLAMP-05** | `compose.discovery-pool.test.ts` | AC-5 | patrón **T-POOL-7** (`:348-363`, path real hasta `signAndSettleDownstream`): mimic con techo 100, 100 agentes, target Solana fuera del top-50 | `payment.chain === 'solana-devnet'` y `payment.contract === SOLANA_PAY_TO` en el agente que llega al settle | M1 |
| **T-CLAMP-06** | `discovery.limit.test.ts` | AC-6 | el `schema.discovery` se construye con `JSON.parse` del **mismo literal jsonb que escribe la migración**: `{"limitParam":"limit","nextCursorPath":"next_cursor","maxLimit":100}` | `upstreamLimits` es `['100']` **sin una línea de código extra** | M4 |
| **T-CLAMP-07** | `compose.discovery-pool.test.ts` | AC-7 (positivo) | `maxLimit: 100`, catálogo de 150 con el target en la posición 5 | el target sigue hidratando `payment.chain` (el pool ≥ el piso histórico de 50) | M7 |
| **T-CLAMP-07b** | `compose.discovery-pool.test.ts` | AC-7 (residual honesto) | `maxLimit: 10`, 200 agentes activos | `upstreamLimits` es `['10']` **y** `logSpy.warn` fue llamado con `error_code: 'REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL'` | M8 |
| **T-CLAMP-08** | `discovery.limit.test.ts` | CD-13, CD-9(c) | tabla de 7 inválidos: `"100"`, `"abc"`, `0`, `-5`, `1.5`, `null`, `{}` | en los **siete**: `upstreamLimits` es `['200']` — nunca `'NaN'`, nunca `'0'`, nunca `'1'` — y `logSpy.warn` fue llamado con `REGISTRY_MAX_LIMIT_INVALID` | M9, M10 |

### 7.2 Los 10 mutantes, y quién mata a cada uno

| # | Mutación | Test(s) que DEBEN morir |
|---|---|---|
| **M1** | Quitar el clamp: `sentLimit = resolveUpstreamFetchLimit(query.limit)` | T-CLAMP-01, 03, 04, 05 |
| **M2** | Default pesimista: usar `100` cuando no hay declaración | T-CLAMP-02, T-CLAMP-04b |
| **M3** | `Math.max` en vez de `Math.min` | T-CLAMP-01 |
| **M4** | Romper el path `{discovery,maxLimit}` (leer `schema.max_limit` o de otro objeto) | T-CLAMP-06 |
| **M5** | Mover el clamp **fuera** del gate `query.limit && schema.limitParam` | T-CLAMP-02b, T-CLAMP-02c |
| **M6** | Forzar `page_full` siempre que haya clamp | T-CLAMP-03b |
| **M7** | Clampear también el page size del pool de `/compose` | T-CLAMP-07 |
| **M8** | Poner un piso de 50 al clamp (`max(50, min(...))`) | T-CLAMP-07b |
| **M9** | Quitar el `typeof` / `Number.isInteger` (`"abc"` ⇒ `NaN` upstream) | T-CLAMP-08 |
| **M10** | Quitar el `>= 1` (`0` ⇒ `?limit=0`) | T-CLAMP-08 |

**Disciplina obligatoria**: aplicá cada mutante a mano, corré `npx tsc --noEmit` + el
test nominado, verificá que **muere**, y revertí. Dejá el registro
`mutante → test que murió → hash` en `mutation-log.md` dentro de esta carpeta.

> **CD-7 aplica a la campaña**: un mutante "muerto" por un test que recalcula el valor
> esperado **no cuenta como muerto**. Ver §7.4.

### 7.3 Harness — usá el que ya existe, no inventes uno

| Archivo | Helper de captura | `makeRegistry` | Catálogo | `beforeEach` |
|---|---|---|---|---|
| `discovery.limit.test.ts` (216 líneas) | `serveHonoringLimit` `:102-115` | `:73-85` | `catalog(n, inactive)` `:88-99` | `:118-122` (borra `DISCOVERY_UPSTREAM_FETCH_LIMIT`) |
| `discovery.truncation.test.ts` (273) | `serve` `:126-133` | `:81-93` | `catalog(n)` `:109-120` | `:136-140` |
| `discovery.sources.test.ts` (504) | `serveByHost` `:135-142` **(ver nota)** | `:99-111` | `catalog(n, prefix)` `:113-124` | `:145-162` (incluye `mockLookup` de DNS) |
| `compose.discovery-pool.test.ts` (364) | `serveRegistry` `:194-231` | `:124-137` | `catalogWithTarget` `:169-186` | `:234-240` |

⚠️ **Nota sobre `serveByHost` (W3.c)**: rutea por **hostname** y la función de ruta **no
recibe la URL**, así que **no sirve** para un mimic que decide según el `?limit=`. Escribí
un helper local nuevo en ese archivo, sobre `mockFetch.mockImplementation((url) => ...)`,
igual que `serve` / `serveHonoringLimit`. **No modifiques `serveByHost`**: lo usan
T-SRC-01..13.

⚠️ **El body del `400` no se lee.** `src/services/discovery.ts:1115-1117` lanza
`RegistryHttpError` **antes** del `await response.json()` de `:1119`. El mimic puede
devolver `{ ok: false, status: 400 }` a secas; **no** afirmes nada sobre el mensaje de
error del registry, porque nunca llega a `sources[]`.

Regla de agregación de `catalogStatus`, para no adivinar
(`src/lib/discovery-sources.ts:55-62`): `failed` > `truncated` > `unverified` >
`complete`. Un solo `failed` en cualquier fuente ⇒ `'partial'`.

### 7.4 🔴 CD-7 — la trampa de esta HU, con el ejemplo exacto

**Esto ya fue hallazgo en WKH-217 y en WKH-213. Es el error más probable de este trabajo.**

```ts
// ⛔ MAL — el test se compara consigo mismo
expect(upstreamLimits[0]).toBe(String(Math.min(resolveUpstreamFetchLimit(500), 100)));

// ⛔ MAL — la constante importada mide la constante
expect(upstreamLimits[0]).toBe(String(MAX_LIMIT_DEL_REGISTRY));

// ✅ BIEN — el literal, escrito a mano
expect(upstreamLimits).toEqual(['100']);
```

**Por qué el primero no prueba nada**: si invertís `Math.min` por `Math.max` en el código
de producción **y** en el test, el test sigue verde. El mutante M3 sobrevive. Un guard que
recalcula la fórmula que vigila sólo detecta corrupción de transporte.

⇒ **Todas las aserciones de límite se escriben con el número entre comillas, a mano.** Y
por eso T-CLAMP-06 (AC-6) construye el schema con `JSON.parse` del literal jsonb: la
fuente del `100` es el **mismo texto que escribe la migración**, no una constante nuestra.

### 7.5 No-regresión: qué tiene que seguir verde SIN cambiar de conducta

| Archivo | Tests | Estado exigido |
|---|---|---|
| `discovery.limit.test.ts` | T-1 … T-9 | verdes, **sin modificar** |
| `discovery.truncation.test.ts` | T-TRUNC-01 … 08 | verdes, **sin modificar** |
| `discovery.sources.test.ts` | T-SRC-01 … 13 | verdes, **sin modificar** |
| `compose.discovery-pool.test.ts` | T-POOL-1 … 7 | verdes, **sin modificar** |

T-4 (`:158-165`), T-6 (`:176-183`), T-7 (`:185-192`), T-8 (`:194-202`) y T-9
(`:204-215`) de `discovery.limit.test.ts` son **la línea base de AC-2**: si alguno se
pone rojo, el clamp dejó de ser aditivo.

> **Si tenés que tocar uno, es un HALLAZGO**: escribí por qué **antes** de tocarlo.
> Precedente: WKH-315 — *"el story file afirmó que la suite no habría que tocarla, y sí
> hubo que tocarla — por tipos, no por conducta"*.

#### La única modificación de línea existente que este story file AUTORIZA

Para afirmar sobre los `warn` (T-CLAMP-02, 07b, 08) hace falta un logger espiable. Hoy
esos archivos mockean así:

```ts
vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
```

Ese factory crea un objeto **nuevo en cada llamada**, así que el test no puede alcanzar el
`vi.fn()` que `src/services/discovery.ts:63` capturó. Cambialo por el patrón hoisted, que
**ya existe en este repo** — exemplar exacto: `src/services/compose.test.ts:17-23`:

```ts
const logSpy = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));
```

**Aplicalo SÓLO en los dos archivos que lo necesitan**:
`src/services/discovery.limit.test.ts:20-22` y
`src/services/compose.discovery-pool.test.ts:30-32`.

No lo apliques en `discovery.truncation.test.ts` ni en `discovery.sources.test.ts`: ahí
no se afirma sobre logs y cambiar el mock sería ruido en el diff. `vi.clearAllMocks()` de
los `beforeEach` limpia `logSpy` entre tests, así que no hace falta nada más.

### 7.6 Evidencia que NO puede vivir en CI

La comprobación de AC-4 contra el registry **real** necesita red, y la suite no la tiene.
Va como evidencia manual de F4. Comando (`python3`+`urllib`, **no `curl` redirigido a
archivo**: bajo el proxy `rtk` la redirección corrompe la salida):

```
python3 -c "import urllib.request as u
for n in (100,101):
    try:
        r=u.urlopen('https://wasiai-v2.vercel.app/api/v1/capabilities?limit=%d'%n); print(n, r.status)
    except Exception as e: print(n, getattr(e,'code',e))"
```

Esperado (medido 2026-08-04): `100 200` y `101 400`.

---

## 8. Anti-Hallucination Checklist — específico de esta HU

Todo esto fue verificado con `Read`/`grep` en `310b2cd`. **Si algo no coincide, PARÁ y
avisá: significa que el árbol cambió.**

- [ ] `src/lib/discovery-fetch-limit.ts` tiene **119 líneas**, **cero imports**, y exporta
      exactamente **2** funciones: `resolveUpstreamFetchLimit` (`:47-52`) y
      `resolveComposeAgentPoolLimit` (`:117-119`).
- [ ] `DEFAULT_UPSTREAM_FETCH_LIMIT = 200` está en `:26` y **no se exporta**.
      `COMPOSE_POOL_MIN_LIMIT = 50` está en `:32` y **no se exporta**.
- [ ] La frase *"nunca under-fetch"* está en el docstring **de módulo**, `:20-22` — **no**
      en `:36-46` como decía el SDD (§6 W0.4).
- [ ] `src/services/discovery.ts` tiene **1408 líneas**. El bloque del límite está en
      `:1072-1076`. El gate es `if (query.limit && schema.limitParam)` (`:1073`).
- [ ] `const log = getLogger('discovery')` está en `src/services/discovery.ts:63`, y el
      precedente de `log.warn` con `error_code` como primer campo está en `:270-277`.
- [ ] `page_full` se decide en `:1184-1190` con `agents.length >= sentLimit`.
      **No lo toques.**
- [ ] `throw new RegistryHttpError(registry.name, response.status)` está en `:1115-1117`,
      **antes** del `await response.json()` de `:1119`.
- [ ] `src/types/index.ts` tiene **1889 líneas**; `RegistrySchema.discovery` está en
      `:130-168`; `maxLimit?: number` en `:160`; la frase **"TODAVÍA NO LO LEE NADIE"** en
      `:149`.
- [ ] `src/services/registry.ts:92` es `schema: row.schema`, y los `as unknown as` de M9
      están en `:153-155`. `src/routes/registries.ts:69` valida presencia y `:251` guarda
      `schema: body.schema`. **Cero `zod` en ese archivo** — verificalo vos.
- [ ] La migración exemplar es
      `supabase/migrations/20260730010000_wkh318_registry_next_cursor_path.sql` (19
      líneas) + `_down.sql` (18 líneas).
- [ ] `grep -rn "NO aplicar" supabase/migrations/` devuelve **0 hits** hoy. El marcador es
      convención nueva de esta HU.
- [ ] `src/lib/discovery-sources.ts:55-62` es `buildCatalogStatus` con la precedencia
      `failed > truncated > unverified > complete`.
- [ ] `src/services/compose.ts:33` importa `resolveComposeAgentPoolLimit` y `:136` lo usa
      en `.discover({ limit: ... })`. **No toques ese archivo.**
- [ ] `src/routes/capabilities.ts:62` es `discoveryService.discover({})` **sin `limit`** ⇒
      esta HU no cambia nada en ese camino.
- [ ] `src/services/compose.test.ts:17-23` es el exemplar del `logSpy` hoisted.
- [ ] `maxLimit` hoy tiene **3 hits** en `--include=*.ts`, los 3 dentro del JSDoc de
      `src/types/index.ts:145-160`. **Nadie lo lee.**
- [ ] `git status` está limpio salvo los archivos de esta HU, y la rama es
      `feat/218-wkh-318-corte-b-maxlimit-clamp`.

---

## 9. Scope

### IN — la lista exhaustiva

| # | Archivo | Acción | Wave |
|---|---|---|---|
| 1 | `src/lib/discovery-fetch-limit.ts` | 3 funciones nuevas + enmienda del docstring `:20-22` | W0 |
| 2 | `src/types/index.ts:145-160` | sólo JSDoc | W0 |
| 3 | `src/services/discovery.ts:1072-1076` | clamp + 2 `log.warn` | W1 |
| 4 | `supabase/migrations/20260804000000_wkh318b_registry_max_limit.sql` | nuevo | W2 |
| 5 | `supabase/migrations/20260804000000_wkh318b_registry_max_limit_down.sql` | nuevo | W2 |
| 6 | `src/services/discovery.limit.test.ts` | 6 tests + mock del logger | W3.a |
| 7 | `src/services/discovery.truncation.test.ts` | 2 tests | W3.b |
| 8 | `src/services/discovery.sources.test.ts` | 2 tests + helper local nuevo | W3.c |
| 9 | `src/services/compose.discovery-pool.test.ts` | 3 tests + mock del logger | W3.d |
| 10 | `doc/sdd/215-.../backlog.md` (B-3) | 2-4 líneas | W4 |
| 11 | `doc/sdd/218-.../mutation-log.md` | nuevo, la campaña de §7.2 | post-W3 |

### OUT — declarado, no omitido

- ⛔ **`classifyFetchFailure` / `DiscoverySourceFailure`** (`src/lib/discovery-sources.ts:76-91`).
  Un `400` nuestro y un registry caído siguen siendo el mismo `http_error`. (CD-4)
- ⛔ **`wasiai-v2`, `chaski-v3`, `wasiai-facilitator`, agentes `remit-*`**. (CD-1)
- ⛔ **Paginar por `next_cursor`** — se detecta, no se pagina. (TD-318-2)
- ⛔ **W4 de WKH-318** (`requireCompleteCatalog`, rechazo con reembolso) y sus
  precondiciones B-1 / B-5 / B-6.
- ⛔ **Validar el `schema` en el write-path de `POST/PATCH /registries`** — TD-318B-3.
- ⛔ **Aplicar la migración** — acción del founder, gated. (§6 W2)
- ⛔ **Tocar `DISCOVERY_UPSTREAM_FETCH_LIMIT` en Railway** — es decisión de operación del
  founder, no del pipeline. Ni la propongas en el código.
- ⛔ **`doc/sdd/_INDEX.md`** — es de `nexus-docs`.

---

## 10. Riesgos y deuda — declarados con dueño, no para que los arregles

| ID | Qué queda abierto | Dueño / gatillo |
|---|---|---|
| **R-1** | El código desplegado **sin** la migración no arregla producción (§2). Riesgo de que el reporte final lo lea como arreglado. | Mitigación: F4 no puede marcar AC-4/AC-5 contra producción sin evidencia de la migración aplicada |
| **TD-318B-1** | B-3 queda cerrado **sólo** para registries que declaran `maxLimit`. Sin declaración, 100 filas ante un pedido de 200 sigue leyéndose `ok`. | W4 de WKH-318 |
| **TD-318B-2** | Un registry con `maxLimit < 50` hunde el pool de `/compose` bajo el piso histórico ⇒ clase WKH-113 (agente no hidratado, leg salteado en silencio). Sólo hay `warn`, no impedimento. | Gatillo: que aparezca `REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL` en logs |
| **TD-318B-3** | `POST/PATCH /registries` guarda `schema` sin validar. El guard de esta HU es de **lectura**; el de escritura no existe. | HU propia |
| **TD-318B-4** | Un registry puede forzar el `catalogStatus` agregado a `truncated` declarando un `maxLimit` chico. **Es el lado seguro**: sobre-declara incompletitud, no la esconde. Declarar un techo **alto** (`999999`) no hace nada: `min(200, 999999) = 200`. | Sólo si aparece impacto real |
| **TD-318B-5** | La precondición de `src/lib/discovery-fetch-limit.ts:77-105` se relee cuando un **segundo** registry declare `maxLimit`. | La HU que lo declare |

---

## 11. Lo que NO se renegocia

1. **Un registry sin `maxLimit` no se clampea.** Nada de default de 100. (§3)
2. **La aritmética vive en el módulo leaf**, no en el service. (§4)
3. **El gate `query.limit && schema.limitParam` no cambia su condición.** (CD-2)
4. **Techo inválido ⇒ sin clamp + `warn`.** Nunca fail-closed. (CD-13)
5. **`undefined` no warnea; `null` sí.** Ausencia ≠ declaración inválida. (§6 W1.2)
6. **Ningún literal `100`, `50` o `'wasiai'` en `src/`.** (CD-11)
7. **Los tests afirman el número entre comillas, escrito a mano.** (CD-7, §7.4)
8. **La migración no se ejecuta, y lleva el marcador en línea 2.** (§6 W2)
9. **Ningún texto puede decir que esta HU arregla producción.** (§2)
10. **La suite COMPLETA en verde, no sólo los archivos tocados.**

---

## 12. Done Definition

- [ ] W0, W1, W2, W3 y W4 completas, en la rama `feat/218-wkh-318-corte-b-maxlimit-clamp`.
- [ ] `npx tsc --noEmit` **completo** y limpio (no `npm run build`).
- [ ] `npm run lint` en verde (`main` ya estuvo rojo por saltear esto: commit `34e1f2b`).
- [ ] `npm test` **completo** en verde, con el conteo **citado**, no estimado (CD-12).
- [ ] Los **13** tests `T-CLAMP-*` presentes, nombrados y verdes.
- [ ] Los **10** mutantes M1..M10 corridos a mano, cada uno muerto por su test nominado,
      registrados en `doc/sdd/218-.../mutation-log.md`. Ningún mutante muerto por un test
      que recalcula la fórmula (CD-7).
- [ ] Las **5 ramas de CD-9** enumeradas explícitamente en el commit o el auto-blindaje,
      cada una con su test.
- [ ] Los tests de no-regresión de §7.5 verdes **sin cambio de conducta**; la única
      modificación de líneas existentes es el mock del logger en los 2 archivos de §7.5.
- [ ] Los 2 `.sql` con el marcador textual en **línea 2**, el `WHERE` completo, el aviso de
      `auth` y "SOLO bdwv". **No aplicados.**
- [ ] `src/lib/discovery-fetch-limit.ts` **sigue sin imports**.
- [ ] `git diff` **no toca**: `src/lib/discovery-sources.ts`, `src/services/compose.ts`,
      `src/services/orchestrate.ts`, `src/routes/discover.ts`, `src/routes/capabilities.ts`,
      `src/mcp/tools/discover-agents.ts`, `doc/sdd/_INDEX.md`.
- [ ] `git diff src/services/discovery.ts` no muestra cambios fuera de `:1072-1076` (+ los
      `warn`).
- [ ] Ningún comentario, commit o doc afirma que la HU arregla el catálogo en producción
      (§2). Ninguna frase nueva afirma una propiedad universal sin el input que la
      falsifica (CD-8).
- [ ] Reporte final con: R-1 declarado, TD-318B-1..5, el `SELECT` de verificación para el
      founder, y la corrección de §6 W0.4 sobre dónde vivía realmente la frase "nunca
      under-fetch".

---

## 13. Bookkeeping — para `nexus-docs`, NO para el Dev

⛔ No toques esta sección.

1. **NC-2 sigue abierto y es decisión del founder**: ¿aplicar
   `DISCOVERY_UPSTREAM_FETCH_LIMIT=100` en Railway como paliativo? Cubre a todo caller con
   `limit <= 100` (incluidos `/compose` 50, `/orchestrate` 50 y MCP 20 ⇒ el money-path
   queda cubierto), **no** cubre `?limit=101+`, y baja el over-fetch global de 200 a 100
   para todos los registries. Recomendación del SDD: aplicarlo **y revertirlo** cuando la
   migración esté aplicada.
2. **NC-3 sigue abierto y está fuera de este repo**: si `app.wasiai.io/api/v1/capabilities`
   (wasiai-v2) propaga `limit` a nuestro `/discover`. Sonda sin leer código de v2: comparar
   su conteo de agentes contra el de nuestro `/discover` **sin** `limit`.
3. El nombre de este archivo es `story-WKH-318B.md` (las HUs previas usan
   `story-HU-NNN.md`); así lo pidió el orquestador. No es un typo.

---

## ⚠️ Correcciones post-implementación — LEER ANTES DE CITAR ESTE ARCHIVO

Este story file se escribió **antes** de que el código existiera y quedó con
partes **desmentidas por la implementación**. No se editó el contrato a
propósito (lo desmentido se documentó aparte), así que quien lo lea primero lee
la versión vieja. Los punteros:

1. **W0 — la firma del contrato no compila tal cual.**
   `isUsableRegistryMaxLimit(declared: unknown): boolean` + `Math.min(fetchLimit,
   declared)` es incompatible bajo `strict`: un `boolean` no propaga narrowing.
   Se respetó la firma y se agregó `declared as number` con el comentario pegado.
   Ver `auto-blindaje.md` §W0 y la §2 del `cr-report.md` (mide por qué un type
   predicate sería **peor**: narrowearía `schema.maxLimit` a `never` en el warn).
2. **§7.2 — M9 no mata por `"abc"`.** En JS `"abc" >= 1` es `false`, así que ese
   caso sigue leyéndose inválido. Mata por `"100"` y por `1.5`.
   Ver `mutation-log.md` §M9.
3. **§7 — la campaña de 10 mutantes NO cubría el cambio entero.** El guard de
   W1.3 (`discovery.ts:1106`) quedó afuera y sus **dos** mitades sobrevivían a la
   suite completa (AR `BLQ-BAJO-2` = CR `M-1`, el mismo defecto medido por los
   dos). Se agregaron MA1/MA2 con las aserciones que los matan, y MA3 por la
   línea nueva del fix-pack. Ver `mutation-log.md` (13/13) y `auto-blindaje.md`.
4. **W0.3 — el helper se llama `isBelowComposePoolFloor`**, no
   `clampFallsBelowComposePoolFloor` (CR M-2: recibe un solo número y no puede
   conocer la causa; el nombre viejo hacía parecer redundante justo a la mitad
   del guard que no tenía test). Desviación deliberada del nombre del contrato.
