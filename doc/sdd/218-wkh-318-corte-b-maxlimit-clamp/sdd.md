# SDD #218: [WKH-318 corte B / W3] El over-fetch se clampea al techo que el registry declara

- **Work item**: `doc/sdd/218-wkh-318-corte-b-maxlimit-clamp/work-item.md`
- **Corte A (contexto obligatorio)**: `doc/sdd/215-wkh-318-discover-limit-colapsa-registro-federado/` (`report.md`, `backlog.md`, `decisiones.md`) — mergeado a `main` en `6eb4f8a` (+ `ca9ffb8`)
- **Branch**: `feat/218-wkh-318-corte-b-maxlimit-clamp` (base `0cad63d`)
- **Modo**: QUALITY · SDD_MODE full · estimación M
- **Estado**: listo para `SPEC_APPROVED` (ver §11)

---

## 1. Resumen

`queryRegistry` manda al registry el over-fetch (`max(pageLimit, 200)`,
`src/lib/discovery-fetch-limit.ts:47-52`) sin mirar si ese registry declaró un
techo propio. El registry `wasiai` responde `400` sobre `limit > 100`, y ese `400`
tumba la fuente entera (`src/services/discovery.ts:1115-1117`). Medido en
producción: `/discover?limit=N` devuelve 3 de 23 agentes para cualquier `N`.

Esta HU agrega **una sola cosa**: cuando el registry declara
`schema.discovery.maxLimit`, el límite que se le envía es
`min(over-fetch, maxLimit)`. El campo ya existe desde el corte A
(`src/types/index.ts:145-160`) y hoy no lo lee nadie — verificado con `grep -rn
"maxLimit" --include=*.ts`: 3 hits, los 3 en ese mismo bloque de JSDoc.

**Lo que esta HU NO hace, dicho antes que lo que sí hace**, porque es la afirmación
que se puede leer de más:

1. **El código solo no arregla producción.** Sin la migración de datos, ninguna
   fila de `registries` en bdwv tiene `maxLimit`, el clamp no aplica a nadie, y
   `/discover?limit=50` sigue devolviendo 3 de 23. La migración **la aplica el
   founder** (§4.5). Input que lo falsifica si me equivoco: desplegar W0+W1 sin la
   migración y ver `total > 3` en `/discover?limit=50`.
2. **No cierra B-3 para todos los registries**, solo para los que declaran
   `maxLimit`. Un registry que clampea en silencio y no declara nada sigue
   reportándose `ok` sobre una página recortada, exactamente igual que hoy
   (§8, TD-318B-1 — corrige una afirmación del `backlog.md` del corte A).
3. **No toca el camino sin `limit` del caller.** `/capabilities` de este repo
   (`src/routes/capabilities.ts:62`, `discover({})`) no manda `limitParam` hoy y
   no lo mandará después (CD-2).

---

## 2. Context Map (Codebase Grounding)

Cada archivo abierto con `Read`, cada número de línea leído del árbol en
`0cad63d`, no de memoria ni del work-item.

| Archivo | Líneas leídas | Qué extraje |
|---|---|---|
| `src/lib/discovery-fetch-limit.ts` | 1-119 (completo) | `DEFAULT_UPSTREAM_FETCH_LIMIT = 200` (:26); `COMPOSE_POOL_MIN_LIMIT = 50` (:32); `resolveUpstreamFetchLimit` (:47-52) = `max(pageLimit, env ?? 200)` con el patrón "env inválida ⇒ default, nunca NaN en la query string" (:37-38); `resolveComposeAgentPoolLimit` (:117-119); la **precondición de una sola fuente contribuyente** (:77-105). Módulo **LEAF, cero imports** — y el docstring (:4-10) explica que eso no es estilo: media docena de suites mockean `../services/discovery.js` completo sin `importOriginal`, así que un export nuevo del service quedaría `undefined` ahí (ya rompió 12 y 84 tests). **El helper nuevo va acá, no en el service.** |
| `src/services/discovery.ts` | 225-274, 630-704, 1030-1249 | `queryRegistry` (:1038-1042); el bloque del límite (:1072-1076) con `sentLimit: number \| undefined`; el `throw new RegistryHttpError` (:1115-1117); el bloque de evidencia de truncamiento (:1165-1204) donde `page_full` se decide con `agents.length >= sentLimit` (:1184-1190) — **usa `sentLimit`, así que hereda el clamp sin tocarse**; la construcción de `sources[]` (:657-668); `contributingRegistries` (:678-680); el `slice(0, query.limit)` GLOBAL (:638); la fuente local con `state: 'ok'` incondicional (:250-254, es B-5, fuera de alcance); `const log = getLogger('discovery')` (:63) y el precedente de `log.warn` con `error_code` (:270-276). |
| `src/types/index.ts` | 120-199 | `RegistrySchema.discovery` (:130-168). `maxLimit?: number` (:145-160) con el JSDoc que dice textual *"TODAVÍA NO LO LEE NADIE"* — esta HU lo vuelve falso y por eso el JSDoc entra en W0. `nextCursorPath` (:161-167). |
| `src/services/registry.ts` | grep de `schema` | `schema: row.schema` (:92) y los comentarios M9 *"narrowing acotado — `schema`/`auth` jsonb (`Json`) → shapes de dominio"* con `as unknown as` (:153-155, :180, :219, :287, :396, :472). **El tipo `number` de `maxLimit` es una promesa de TypeScript, no una garantía de runtime.** De acá sale DT-3. |
| `src/routes/registries.ts` | grep de `schema` / `zod` | El `POST` valida **presencia** de `schema` (:69) y guarda `schema: body.schema` (:251) tal cual. Cero `zod`/`typebox` en el archivo. Cualquier caller que puede crear un registry puede poner cualquier JSON en `maxLimit`. |
| `src/services/compose.ts` | grep | `import { resolveComposeAgentPoolLimit }` (:33) y `.discover({ limit: resolveComposeAgentPoolLimit() })` (:136) — el pool que hidrata `payment.chain` (money-path). |
| `src/services/orchestrate.ts` | 540-600 | `limit: 50` en el discover principal (:560) y en el broaden-retry (:579). Confirmado con `grep -n "limit: 50"`: exactamente 2 hits. |
| `src/mcp/tools/discover-agents.ts` | 30-45 | `limit: input.limit ?? 20` (:37). |
| `src/routes/capabilities.ts` / `src/routes/discover.ts` | grep | `capabilities.ts:62` = `discover({})` **sin `limit`**; `discover.ts:219` y `:289` son los que propagan el `limit` del caller. |
| `supabase/migrations/20260730010000_wkh318_registry_next_cursor_path.sql` + `_down.sql` | completos | Exemplar exacto de la migración: `jsonb_set(schema, '{discovery,X}', ..., true)` con `WHERE id = 'wasiai' AND schema -> 'discovery' IS NOT NULL`, aviso de no tocar `auth`, "Aplicar SOLO a bdwv". El `_down` quita la clave con `(schema -> 'discovery') - 'clave'`. |
| `src/services/discovery.truncation.test.ts` | 1-215 | Harness reutilizable: `makeRegistry` (:81-93), `withCursorPath` (:96-107), `catalog(n)` (:109-120), **`serve()` que captura los `limit` enviados upstream** (:126-133), `beforeEach` que borra `DISCOVERY_UPSTREAM_FETCH_LIMIT` (:136-140). |
| `src/services/discovery.limit.test.ts` | grep de `it(` | `serveHonoringLimit` (:102); T-4 (el limit del caller no viaja upstream), T-6 (monotonía), T-7 (env inválida ⇒ 200, no NaN), T-8 (sin `limit` no se manda `limitParam`), T-9 (registry sin `limitParam`). **Estos cinco son la línea base de no-regresión de AC-2.** |
| `src/services/discovery.sources.test.ts` | grep de `it(` | T-SRC-01..T-SRC-13; el harness de fuentes caídas y `catalogStatus`. |
| `src/services/compose.discovery-pool.test.ts` | grep | `describe` (:233), T-POOL-1/2 (agente fuera del top-50 hidrata `payment.chain`), T-POOL-3 (page size == over-fetch), T-POOL-5 (piso de 50), **T-POOL-7 (:348), el path REAL de `/compose` hasta `signAndSettleDownstream`** — el patrón para AC-5. |
| `doc/sdd/215-.../backlog.md` | completo | B-3 (:139-149) y su afirmación "W3 lo cierra por construcción"; B-4 (:153-166) sobre la migración sin aplicar. |
| `doc/sdd/215-.../decisiones.md` | completo | D-1: `sources[].failure` se publica; **"agregar un valor al enum es la señal para releer esta decisión"** (:60) — de ahí sale CD-4 (no tocar `classifyFetchFailure`). |
| `doc/sdd/_INDEX.md` | filas 209/211/213/215/216/217 | Estado de las HUs vecinas y el dato clave de F4 del corte A: verificación read-only contra bdwv de que `20260730010000_...` **no estaba aplicada** al 2026-07-30. |
| Auto-blindaje de las 3 últimas DONE (`217`, `215`, `213`) | headings + secciones citadas | Patrones recurrentes → CD-7..CD-13 (§7). |

### 2.1 Colisión de merge — medida, no supuesta

`git diff --stat main...<branch> -- src/services/discovery.ts src/types/index.ts
src/lib/discovery-fetch-limit.ts` sobre `feat/211-wkh-313`, `feat/212-wkh-314`,
`feat/213-wkh-315`, `feat/214-wkh-316`, `feat/216-wkh-319`: **salida vacía en los
cinco** (2026-08-04). WKH-313/315/319 ya están mergeadas a `main`
(`1b322e2`, `6946a80`, `6a2f292`). Conclusión: **cero roce** con los tres archivos
de esta HU. Esto reemplaza la nota "confirmar estado actual antes de ramificar" del
work-item (§Análisis de paralelismo), que quedó resuelta.

---

## 3. Decisión de diseño central: qué pasa con un registry que NO declara `maxLimit`

Es la decisión que gobierna todo el resto, así que va primero y con el trade-off
explícito.

### Opciones consideradas

| # | Opción | Qué pasa con `wasiai` (techo 100, no declarado aún) | Qué pasa con un registry nuevo de techo 40 | Qué pasa con un registry de techo 1000 |
|---|---|---|---|---|
| **A** | **Sin declaración no hay clamp** (comportamiento actual) | igual que hoy hasta que la migración lo declare | sigue roto: recibe 200, contesta 400, fuente `failed` — **pero visible** en `sources[]` | intacto: over-fetch 200, pool completo |
| B | Default pesimista global (p.ej. clampear todo a 100) | arreglado sin migración | arreglado por casualidad si su techo ≥ 100; sigue roto si es 40 | **roto en silencio**: le pedimos 100 de 1000 posibles y la respuesta corta se lee como catálogo completo |
| C | Sondeo adaptativo (reintentar con límite menor ante un 400) | arreglado sin migración | arreglado | intacto |

### Decisión: **Opción A**. Sin declaración, cero clamp, comportamiento byte-idéntico.

Tres razones, en orden de peso:

1. **B convierte un fallo ruidoso en uno silencioso, que es la clase de bug que
   esta HU vino a matar.** Hoy el registry `wasiai` grita `400` y desde el corte A
   eso sale publicado como `state: 'failed'` / `failure: 'http_error'` en
   `sources[]` (`discovery.ts:657-668`). Con un default de 100 aplicado a un
   registry que acepta 1000, le pedimos 100, nos da 100, la página se llena y —con
   el clamp— se reporta `truncated` (mejor que `ok`, pero) el **pool de ranking de
   esa fuente cae de 200 a 100 filas sin que nadie lo haya pedido**. Input que lo
   hace concreto: un registry con 300 agentes activos donde el agente Solana que
   `/compose` necesita hidratar está en la posición 150 del ranking
   (verified-first → reputación desc → precio asc). Con over-fetch 200 entra; con
   default 100 no entra, `payment.chain` no se hidrata y el leg downstream se
   saltea en silencio — el caso exacto que `discovery-fetch-limit.ts:59-75`
   documenta como BLQ-BAJO-1 de WKH-189.
2. **100 no es un estándar: es el número de `wasiai-v2`.** Elegirlo como default
   global es generalizar el contrato de un servidor a todos los demás. No leí
   ninguna especificación que lo respalde y no la voy a inventar.
3. **AC-2 y CD-3 del work-item aprobado lo mandan**: "preservar el comportamiento
   actual byte-idéntico" y "el clamp es estrictamente aditivo, nunca puede volverse
   más restrictivo por default".

**C (sondeo adaptativo) queda descartada, no diferida**: duplica requests contra
cada registry que devuelva 400 por cualquier motivo (auth vencida, endpoint
movido, rate limit), no tiene dónde memorizar el techo aprendido entre requests
—no hay cache de registries en `queryRegistry`— y el `400` no dice **por qué**
(`classifyFetchFailure` colapsa todos los status en `http_error`,
`discovery-sources.ts:76-91`, y eso está fuera de alcance). Reintentar sobre un
motivo desconocido es adivinar.

### El costo que acepto, sin maquillar

Un registry que se agrega mañana con techo < 200 y sin declarar `maxLimit`
**sigue roto exactamente como hoy**: 400 y fuente caída. Esta HU no lo cubre. Lo
que sí hay es que el corte A ya lo hace **visible** (`sources[].state: 'failed'`,
`catalogStatus: 'partial'`) en vez de invisible. La salida real para ese caso es
validar/declarar el techo en el alta del registry, que es TD-318B-3 y no entra acá.

---

## 4. Diseño técnico

### 4.1 DT-1 — El clamp vive en `queryRegistry`, el cálculo en el módulo leaf

Hereda DT-1 del work-item: un solo choke-point. `queryRegistry`
(`discovery.ts:1038`) es el punto por el que pasan **todos** los consumidores
medidos: `/discover` (`routes/discover.ts:219,289`), `/compose`
(`compose.ts:136`), `/orchestrate` (`orchestrate.ts:560,579`) y el tool MCP
(`mcp/tools/discover-agents.ts:37`). Ninguno de esos cuatro archivos se toca.

La **aritmética** va en `src/lib/discovery-fetch-limit.ts` por la razón que su
propio docstring documenta (:4-10): es un módulo LEAF y media docena de suites
mockean el service completo. Un helper exportado desde `discovery.ts` quedaría
`undefined` en esas suites — ya rompió 12 y 84 tests en el fix-pack P1.

### 4.2 DT-2 — `min(over-fetch, maxLimit)`, y la propiedad que esto rompe

Forma final del bloque `discovery.ts:1072-1076` (esto es diseño, no el parche
literal; el Dev lo escribe en F3):

```
sentLimit = clampToRegistryMaxLimit(
  resolveUpstreamFetchLimit(query.limit),
  schema.maxLimit,
);
url.searchParams.set(schema.limitParam, sentLimit.toString());
```

`resolveUpstreamFetchLimit` **no se modifica**. Su docstring (:36-46) afirma
*"Monótono: si el caller pide más que el over-fetch, gana el caller (nunca
under-fetch)"*, y esa frase **sigue siendo verdadera de la función**. Lo que deja
de ser verdad es la propiedad **del call-site**: con `maxLimit = 100` y
`query.limit = 150` se envían 100, o sea **menos que lo que el caller pidió**.

Input concreto que falsifica la lectura optimista: `GET /discover?limit=150`
contra el registry `wasiai` post-migración ⇒ `limitParam = 100` ⇒ como mucho 100
filas de esa fuente ⇒ la página puede volver con menos de 150 agentes. Eso es
**correcto y deliberado**: el registry no puede dar más sin paginar, y paginar está
descartado (TD-318-2). Se reporta como `truncated`/`page_full` (§4.4), no se
esconde. Por eso W0 agrega al docstring de `resolveUpstreamFetchLimit` un puntero
al clamp del call-site — sin ese puntero, la frase "nunca under-fetch" se lee como
una garantía de extremo a extremo que el código ya no da (CD-8).

### 4.3 DT-3 — El techo llega como `unknown`, no como `number`

`RegistrySchema.discovery.maxLimit` está tipado `number | undefined`
(`types/index.ts:160`), pero el valor viene de una columna `jsonb` que
`registry.ts:92` asigna directo y que los comentarios M9 (:153-155) declaran como
"narrowing acotado" vía `as unknown as`. Y el write-path no valida nada
(`routes/registries.ts:69,251`, sin `zod`). O sea: en runtime `maxLimit` puede ser
`"100"`, `0`, `-5`, `1.5`, `null`, `{}` o `"abc"`.

Por eso la firma del helper toma `unknown`:

```
export function clampToRegistryMaxLimit(fetchLimit: number, declared: unknown): number
```

Tipar el segundo parámetro `number | undefined` haría que el guard de runtime
parezca código muerto y un revisor futuro lo borraría "porque tsc ya lo garantiza".
El `unknown` es el que documenta la desconfianza en la firma.

**Techo usable** = `typeof declared === 'number' && Number.isInteger(declared) &&
declared >= 1`. Cualquier otra cosa ⇒ se devuelve `fetchLimit` sin tocar (=
Opción A, sin clamp) **y se emite un `log.warn` con
`error_code: 'REGISTRY_MAX_LIMIT_INVALID'`**.

Por qué ignorar y no fallar cerrado (CD-13): con `maxLimit: 0` el fail-closed
mandaría `limit=0` o `limit=1`, el registry devolvería 0-1 filas, y **el catálogo
quedaría casi vacío en silencio**. Ignorar deja que el registry conteste lo que
conteste, y si su techo real es menor contesta `400`, que es visible. Entre un
catálogo vacío mudo y un `400` publicado, gana el `400`.

Nota sobre `Math.min` y la coerción: `Math.min(200, "100")` devuelve `100` (JS
coerce), y `Math.min(200, "abc")` devuelve `NaN`, que terminaría como
`limit=NaN` en la query string. El guard de `typeof` corta las dos antes de llegar
a `Math.min`; el segundo caso es el mismo hazard que
`discovery-fetch-limit.ts:37-38` ya nombra ("nunca NaN en la query string").

### 4.4 DT-4 — La evidencia de truncamiento hereda el clamp sin tocarse

`discovery.ts:1184-1190` decide `page_full` con `agents.length >= sentLimit`.
Como el clamp modifica `sentLimit` **antes** de mandar el request, ese bloque
compara contra el número realmente enviado. **Cero líneas de cambio ahí.**

Consecuencia (AC-3): registry con `maxLimit: 100` y 100+ agentes ⇒ se piden 100,
llegan 100 ⇒ `truncated` / `page_full`. Registry con `maxLimit: 100` y 23 agentes
⇒ llegan 23 < 100 ⇒ `completenessProven` ⇒ `ok`. Ese segundo caso es el que
esperamos de `wasiai` hoy (23 agentes medidos).

**Corrección al `backlog.md` del corte A** (B-3, :139-149 dice "W3 lo cierra por
construcción"): lo cierra **para los registries que declaran `maxLimit`**. Para el
resto, el clamp silencioso del upstream sigue sin evidencia y sigue leyéndose
`ok`. Input que lo demuestra: registry sin `maxLimit` que recibe `limit=200`,
devuelve 100 filas y no manda cursor ⇒ `100 < 200` ⇒ `completenessProven = true`
⇒ `state: 'ok'`, idéntico a hoy. W4 (§6) hereda ese residual.

### 4.5 DT-5 — Migración de datos: aditiva, separada, y aplicada por el founder

**Archivos nuevos** (patrón copiado línea por línea del exemplar
`20260730010000_wkh318_registry_next_cursor_path.sql`, incluido el
`AND schema -> 'discovery' IS NOT NULL` y el aviso de no tocar `auth`):

- `supabase/migrations/20260804000000_wkh318b_registry_max_limit.sql`
- `supabase/migrations/20260804000000_wkh318b_registry_max_limit_down.sql`

`UPDATE registries SET schema = jsonb_set(schema, '{discovery,maxLimit}',
'100'::jsonb, true) WHERE id = 'wasiai' AND schema -> 'discovery' IS NOT NULL;`

El `_down` quita la clave: `jsonb_set(schema, '{discovery}', (schema ->
'discovery') - 'maxLimit')`.

⚠️ **La línea 2 de AMBOS archivos debe decir, textual**:
`-- NO aplicar: la aplica el founder (accion gated, classifier)`

**Por qué un script separado y no sumarlo al de `nextCursorPath`**: ver §5 (NC-1);
la evidencia dice que el de `nextCursorPath` ya está aplicado. Un script separado
mantiene el registro "aplicada / no aplicada" legible por archivo, y **la decisión
es robusta aunque mi deducción de NC-1 esté equivocada**: si `nextCursorPath` no
estuviera aplicada, el archivo nuevo sigue siendo correcto y ambos se aplican en
orden de timestamp.

**El valor `100` no se hardcodea en `src/`** (CD-11). Vive solo en el SQL. Un grep
de `100` en el diff de `src/` debe dar cero hits relacionados con este techo.

### 4.6 Comportamiento ANTES de que la migración se aplique — explícito

Este es el punto 3 del encargo y merece su propio párrafo porque es fácil
sobre-anunciarlo.

Con W0+W1 desplegados y la migración **sin aplicar**:

- `schema.discovery.maxLimit` es `undefined` en toda fila de `registries`.
- `clampToRegistryMaxLimit(200, undefined)` devuelve `200`.
- El `limitParam` enviado es idéntico al de hoy, byte por byte.
- El `warn` de `REGISTRY_MAX_LIMIT_INVALID` **no se emite** (`undefined` es
  ausencia de declaración, no declaración inválida — son casos distintos y el
  helper los separa).
- **Producción sigue degradada: `/discover?limit=50` sigue devolviendo 3 de 23.**

O sea: el código es **desplegable solo**, no rompe nada, y **no arregla nada**
hasta la migración. F4 no puede reclamar AC-4 ni AC-5 contra producción sin
evidencia de que la migración se aplicó. Lo que F4 sí puede reclamar sin la
migración es AC-1/AC-2/AC-3/AC-7 con registries mockeados, y AC-6 como la
verificación de que el mismo JSON que escribe el SQL activa el clamp sin código
extra.

### 4.7 Observabilidad mínima: el techo que hunde el pool de `/compose`

`resolveComposeAgentPoolLimit()` (`discovery-fetch-limit.ts:117-119`) existe para
que `/compose` tenga un pool con **piso histórico 50**. Un registry que declare
`maxLimit: 10` hunde ese pool a 10 filas para esa fuente, y el agente que quedó
afuera no hidrata `payment.chain` ⇒ leg downstream salteado en silencio (el caso
de `discovery-fetch-limit.ts:59-75`).

**No se impone un piso al clamp** (p.ej. `max(50, min(...))`): eso mandaría 50 a un
registry que declaró 10, cobraríamos un `400` y perderíamos la fuente **entera** en
vez de tener 10 de sus filas. La declaración del registry gana; el costo se
**declara** en vez de esconderse:

`log.warn({ error_code: 'REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL', registry, sentLimit })`
cuando el límite clampeado cae por debajo del piso del pool de compose.

El piso `50` **no se duplica**: se agrega al módulo leaf un predicado
`clampFallsBelowComposePoolFloor(sent: number): boolean` que lee la misma constante
`COMPOSE_POOL_MIN_LIMIT` (:32). Un `sent < 50` escrito a mano en `discovery.ts`
sería la segunda expresión del mismo concepto y divergiría (memoria: "guards que se
comparan consigo mismos" / CD-11 de WKH-318, "una sola expresión por concepto").

Queda como TD-318B-2: el `warn` avisa, no impide.

### 4.8 Superficie de riesgo del campo declarado (por qué `min` es seguro en la dirección hostil)

`maxLimit` lo puede escribir cualquier caller que pueda crear un registry
(`routes/registries.ts:251`, sin validación). Con `min`:

- Declarar un techo **alto** (`999999`) ⇒ `min(200, 999999) = 200` ⇒ **sin
  efecto**. No se puede usar para forzar un over-fetch mayor.
- Declarar un techo **bajo** (`1`) ⇒ le pedimos 1 fila ⇒ **se perjudica a sí
  mismo** (aparece con 1 agente). Efecto cruzado: su fuente queda `truncated` y
  eso arrastra el `catalogStatus` agregado a `truncated` para toda la respuesta.

Ese efecto cruzado es **de la misma clase y del mismo lado seguro** que B-2 del
corte A (`backlog.md:114-136`: un `nextCursorPath` hostil "fuerza `truncated`, que
es el lado seguro / sobre-declara incompletitud"). No abre un vector nuevo: sobre-
declarar incompletitud degrada disponibilidad de la afirmación, no la corrección.
Queda como TD-318B-4.

---

## 5. Missing Inputs — resolución de los 3 `[NEEDS CLARIFICATION]` del work-item

### NC-1 — ¿Está aplicada la migración de `nextCursorPath` en bdwv? → **RESUELTO: sí, por deducción sobre el código**

No tengo credenciales de bdwv en esta fase, así que lo resuelvo por la cadena
causal, que es verificable línea por línea:

1. La medición del founder (2026-08-04): `/discover` **sin `limit`** ⇒ fuente
   WasiAI en `truncated`.
2. `truncated` sale de dos evidencias y nada más (`discovery.ts:1192-1199`):
   `cursor` o `page_full`.
3. `page_full` exige `sentLimit !== undefined` (`discovery.ts:1184`).
4. `sentLimit` solo se setea dentro de `if (query.limit && schema.limitParam)`
   (`discovery.ts:1073`). Sin `limit` del caller, es `undefined`.
5. ⇒ La evidencia fue `cursor` ⇒ `schema.nextCursorPath` está presente en la fila
   ⇒ **la migración está aplicada** (o alguien escribió la clave a mano, que para
   este diseño es equivalente).

Esto es consistente con la línea de tiempo: el F4 del corte A verificó
read-only el 2026-07-30 que **no** estaba aplicada (`_INDEX.md` fila 215); se
aplicó entre esa fecha y el 2026-08-04.

**Decisión que se deriva**: script separado (§4.5). Y como el resultado no cambia
si la deducción falla, esto **no bloquea**.

**Verificación de un renglón para el founder cuando aplique la migración nueva**
(read-only, misma sesión):

```sql
SELECT id,
       schema->'discovery'->'nextCursorPath' AS cursor_path,
       schema->'discovery'->'maxLimit'       AS max_limit
FROM registries WHERE id = 'wasiai';
```

Esperado post-migración: `cursor_path = "next_cursor"`, `max_limit = 100`.

### NC-2 — ¿`DISCOVERY_UPSTREAM_FETCH_LIMIT=100` en Railway como paliativo? → **[NEEDS CLARIFICATION — DECISIÓN DEL FOUNDER]**. No la tomo.

Lo que sí puedo aportar es el análisis medido, para que la decisión sea de un
minuto:

- **Qué cubre**: todo caller con `limit <= 100`, porque
  `resolveUpstreamFetchLimit(n) = max(n, 100) <= 100`. Eso incluye los tres
  consumidores internos verificados: `/compose` (50, `compose.ts:136` vía
  `discovery-fetch-limit.ts:117-119`), `/orchestrate` (50,
  `orchestrate.ts:560,579`) y el tool MCP (20, `discover-agents.ts:37`).
  **El money-path queda cubierto por el paliativo.**
- **Qué NO cubre**: `/discover?limit=101` o más ⇒ `max(101,100) = 101` ⇒ 400 ⇒
  fuente caída. La superficie pública sigue rota para esos valores.
- **Qué cuesta**: el over-fetch global baja de 200 a 100 para **todos** los
  registries, o sea el pool de ranking de `/compose` cae a la mitad (el piso de 50
  se mantiene: `resolveUpstreamFetchLimit(50) = max(50,100) = 100`). Con ~23-32
  agentes por registry hoy, el efecto medible es nulo; deja de serlo si un registry
  supera 100 activos.
- **Recomendación**: aplicarlo ahora como paliativo **y revertirlo cuando la
  migración de esta HU esté aplicada**, para no dejar el pool permanentemente a la
  mitad. Si se revierte, el clamp declarativo ya cubre el caso `wasiai` para
  cualquier `limit`, incluido `limit=500`.

### NC-3 — ¿`wasiai-v2` propaga `limit` a nuestro `/discover`? → **[NEEDS CLARIFICATION — fuera de este repo]**

No es verificable desde `wasiai-a2a` y `wasiai-v2` está fuera de alcance (CD-1).
No bloquea nada de esta HU. Sonda de un comando para quien tenga acceso, que
distingue los dos casos sin leer código de v2: comparar el conteo de agentes de
`https://app.wasiai.io/api/v1/capabilities` contra el de nuestro `/discover` sin
`limit`. Si v2 devuelve ~3 mientras nuestro `/discover` sin `limit` devuelve 23, v2
está propagando un `limit`; si devuelve ~23, no.

---

## 6. Scope

### IN

| Archivo | Cambio | Wave |
|---|---|---|
| `src/lib/discovery-fetch-limit.ts` | `clampToRegistryMaxLimit(fetchLimit, declared)` + `clampFallsBelowComposePoolFloor(sent)` + enmienda al docstring de `resolveUpstreamFetchLimit` (:36-46) | W0 |
| `src/types/index.ts` | JSDoc de `maxLimit` (:145-160): borrar "TODAVÍA NO LO LEE NADIE" y describir el clamp real + el residual de §4.4 | W0 |
| `src/services/discovery.ts` | `:1072-1076` — clamp + los dos `log.warn`. Nada más en el archivo | W1 |
| `supabase/migrations/20260804000000_wkh318b_registry_max_limit.sql` (+ `_down`) | nuevos, con el marcador "NO aplicar" en línea 2 | W2 |
| `src/services/discovery.limit.test.ts` | tests nuevos del clamp (AC-1/2/8) | W3 |
| `src/services/discovery.truncation.test.ts` | AC-3 (page_full con el límite clampeado) | W3 |
| `src/services/discovery.sources.test.ts` | AC-4 (mimic del contrato de `wasiai`: 400 sobre >100) | W3 |
| `src/services/compose.discovery-pool.test.ts` | AC-5 y AC-7 (money-path) | W3 |
| `doc/sdd/215-.../backlog.md` | B-3: marcar CERRADO **para registries que declaran `maxLimit`** + puntero a esta HU (2-4 líneas, no reescritura) | W4 |

### OUT — declarado, no omitido

- **`classifyFetchFailure` / `DiscoverySourceFailure`** (`discovery-sources.ts:76-91`):
  un `400` nuestro y un registry caído siguen siendo el mismo `http_error`. Fuera
  por CD-4 y porque tocar el enum es, textual, la señal para releer D-1
  (`decisiones.md:53-62`, publicación anónima de `sources[].failure`). **Follow-up
  propio** (sugerido `WKH-324`). El blast radius inmediato desaparece igual: con la
  migración aplicada, `wasiai` deja de devolver 400 por este motivo.
- **`wasiai-v2`**: no se toca. Su techo de 100 es el contrato del servidor.
- **Paginación por `next_cursor`** (TD-318-2): se detecta, no se pagina.
- **W4 de WKH-318** (`requireCompleteCatalog`, rechazo con reembolso) y sus
  precondiciones **B-1 / B-5 / B-6**.
- **Validación del `schema` en el write-path de `POST/PATCH /registries`**:
  TD-318B-3.
- **`chaski-v3`, `wasiai-facilitator`, agentes `remit-*`**: cero archivos tocados.
- **Aplicar la migración**: acción del founder, gated. El pipeline la escribe, no
  la ejecuta.

---

## 7. Constraint Directives

**Heredados del work-item (CD-1..CD-6), sin cambios de redacción:**

- **CD-1**: PROHIBIDO modificar código o config en `wasiai-v2`, `chaski-v3`,
  `wasiai-facilitator` o los agentes `remit-*`.
- **CD-2**: OBLIGATORIO que el camino sin `limit` del caller quede byte-idéntico.
  El gate `if (query.limit && schema.limitParam)` (`discovery.ts:1073`) **no cambia
  su condición de entrada**; solo cambia el cálculo de `sentLimit` adentro.
- **CD-3**: OBLIGATORIO que un registry sin `maxLimit` tenga comportamiento
  byte-idéntico al actual (AC-2). El clamp es estrictamente aditivo.
- **CD-4**: PROHIBIDO tocar `DiscoverySourceFailure`, `classifyFetchFailure` o
  `decisiones.md`/D-1 de WKH-318.
- **CD-5**: OBLIGATORIO que la migración sea aditiva (`jsonb_set` con
  `create_missing = true`), no toque la columna `auth`, y se aplique SOLO a bdwv.
- **CD-6**: verificar la precondición de `discovery-fetch-limit.ts:77-105` si el
  diseño toca más de un registry con `maxLimit` propio.
  **Estado en F2: verificada.** Esta HU declara `maxLimit` para **una** fila
  (`id='wasiai'`), y la precondición ("una sola fuente contribuyente con
  `limitParam` declarado") no cambia: el clamp no agrega fuentes, solo baja el
  límite de una que ya contribuía. Si una HU futura declara `maxLimit` en un
  segundo registry, hay que releer ese bloque — queda anotado en TD-318B-5.

**Nuevos de este SDD.** Los cuatro primeros salen de patrones que se repitieron en
≥2 de las últimas HUs DONE (auto-blindaje de 217/215/213):

- **CD-7 (guard contra sí mismo)**: PROHIBIDO que un test del clamp compare contra
  un valor recalculado con `resolveUpstreamFetchLimit(...)`, `Math.min(...)` o la
  constante importada. La aserción se hace contra **el número literal leído de la
  query string enviada** (`upstreamLimits` de
  `discovery.truncation.test.ts:126-133`). Referencia: WKH-322 auto-blindaje
  `[2026-08-04 00:48] "escribí un test que medía la constante contra sí misma"`;
  WKH-315 `[W3.3] "el test probaba el validador, no la ausencia del fallback"`.
- **CD-8 (prosa falsable)**: cada afirmación universal en comentario o JSDoc va con
  el input concreto que la rompería, o no se escribe. Aplica en particular al
  docstring de `resolveUpstreamFetchLimit` (§4.2) y al JSDoc de `maxLimit`.
  Referencia: WKH-315 `it5 "el sobre-anuncio apaga las revisiones"` (causa raíz de
  5 iteraciones); WKH-322 AR-4 MNR-3; WKH-318 `[17:38] "tsc no atrapó todos los
  call-sites"`.
- **CD-9 (la regla se aplica a TODAS las ramas, enumeradas)**: el Dev debe
  enumerar explícitamente, en el commit o en el auto-blindaje, qué hace el clamp en
  las **cinco** ramas y tener un test por cada una: (a) federado con `limit` y
  `maxLimit` válido; (b) federado con `limit` sin `maxLimit`; (c) federado con
  `limit` y `maxLimit` inválido; (d) sin `limit` del caller; (e) registry sin
  `limitParam`. Referencia: WKH-318 auto-blindaje `[19:30] "la misma regla se me
  escapó TRES veces, cada vez en un borde distinto"`; WKH-315 `it4/it5/it6
  "enuncié una regla y la apliqué a un solo caso"` (3 veces, mismo autor).
- **CD-10 (migración: copiar el exemplar entero)**: el SQL nuevo copia el `WHERE id
  = 'wasiai' AND schema -> 'discovery' IS NOT NULL`, el aviso de no tocar `auth`, y
  trae su `_down.sql`. Además lleva en **línea 2**, textual:
  `-- NO aplicar: la aplica el founder (accion gated, classifier)`. Referencia:
  WKH-315 `FIX-PACK BLQ-MED-2 "copié el idioma de la migración exemplar, pero no la
  línea que cerraba la ventana"`.
- **CD-11 (una sola expresión por concepto)**: PROHIBIDO escribir `100`, `'wasiai'`
  o `50` como literal en `src/` para este cambio. El techo entra solo por la fila de
  `registries`; el piso del pool se consulta por
  `clampFallsBelowComposePoolFloor`, no reimplementando `< 50`.
- **CD-12 (verde medido, no supuesto)**: antes de declarar terminado, `npx tsc
  --noEmit` completo (no solo `npm run build`) + `biome` + la suite completa. El
  conteo de tests se cita, no se estima. Referencia: WKH-322 auto-blindaje
  `[00:50] "corrí el lint al final y estaba rojo por formato"`; memoria
  `wkh196-uint256-precision-escrow-live`.
- **CD-13 (un techo inválido no falla cerrado)**: `maxLimit` inválido ⇒ **sin
  clamp** + `warn`. PROHIBIDO degradar a 1, a 0 o al piso del pool: un catálogo
  casi vacío en silencio es peor que un `400` publicado (§4.3).

---

## 8. Riesgos, dependencias y deuda declarada

| ID | Qué queda abierto | Dueño / gatillo |
|---|---|---|
| **TD-318B-1** | B-3 (clamp silencioso del upstream) queda cerrado **solo para registries que declaran `maxLimit`**. Sin declaración, 100 filas ante un pedido de 200 sigue leyéndose `ok`. Corrige la redacción de `backlog.md:139-149`. | W4 de WKH-318 / la HU que agregue evidencia de completitud no auto-declarada (B-6) |
| **TD-318B-2** | Un registry con `maxLimit < 50` hunde el pool de `/compose` por debajo del piso histórico ⇒ clase WKH-113 (agente no hidratado; su leg se saltea **o apunta al rail equivocado**, en silencio — la disyunción entera, `compose.ts:125-126`; en el escenario de T-CLAMP-05 ocurre la segunda rama). Solo hay `warn`, no hay impedimento. | Gatillo: que aparezca `REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL` en logs |
| **TD-318B-3** | `POST/PATCH /registries` guarda `schema` sin validar (`routes/registries.ts:69,251`). El guard de esta HU es de **lectura**; el de escritura no existe. | HU propia — **movida a `backlog.md` de esta carpeta con criterio de cierre** (CR M-12: era la única sin gatillo). `nexus-docs` le pide número al cerrar |
| **TD-318B-6** | El marcador "NO aplicar" de las migraciones gated no tiene control mecánico, y `migrate-preflight.mjs` imprime `[PASS] safe to apply` (exit 0) sobre esos mismos archivos. | AR MNR-2. **Evaluada y NO implementada en el fix-pack**: `scripts/` está fuera del Scope IN y la herramienta es compartida (sus CD-FP1/CD-FP3 + el exit code que consume CI). Diseño propuesto y motivos en `backlog.md` |
| **TD-318B-4** | Un registry cualquiera puede forzar el `catalogStatus` agregado a `truncated` declarando un `maxLimit` chico. Mismo lado seguro que B-2. | Solo si aparece impacto real |
| **TD-318B-5** | La precondición de `discovery-fetch-limit.ts:77-105` se releerá cuando un **segundo** registry declare `maxLimit` (CD-6). | La HU que lo declare |
| **R-1** | El código desplegado sin la migración **no arregla producción** (§4.6). Riesgo de que el reporte final lo lea como arreglado. | Mitigación: F4 no puede marcar AC-4/AC-5 contra producción sin evidencia de la migración aplicada |
| **R-2** | Si el founder aplica el paliativo `DISCOVERY_UPSTREAM_FETCH_LIMIT=100` y **no lo revierte**, el pool queda a la mitad de forma permanente y silenciosa (NC-2). | Founder |
| **Dependencia** | Ninguna HU en vuelo toca los 3 archivos de esta HU (§2.1, medido). | — |

---

## 9. Plan de tests — uno por AC, con el mutante que lo mata

Nomenclatura `T-CLAMP-NN`. Todo test usa el harness ya existente
(`discovery.truncation.test.ts:81-133` / `discovery.limit.test.ts:102`) — CD-7:
la aserción es sobre `upstreamLimits`, el valor leído de la URL enviada.

| Test | Archivo | AC | Qué monta | Qué afirma | Mutante que lo mata |
|---|---|---|---|---|---|
| **T-CLAMP-01** | `discovery.limit.test.ts` | AC-1 | registry con `maxLimit: 100`, `discover({ limit: 500 })` | `upstreamLimits[0] === '100'` (literal, no recalculado) | M1: quitar el clamp; M3: `Math.max` en vez de `Math.min` |
| **T-CLAMP-02** | `discovery.limit.test.ts` | AC-2 | registry **sin** `maxLimit`, tres sub-casos: `limit=5` ⇒ `'200'`; `limit=500` ⇒ `'500'`; `DISCOVERY_UPSTREAM_FETCH_LIMIT=300` + `limit=5` ⇒ `'300'` | byte-idéntico a T-4/T-6/T-5 de la suite actual | M2: aplicar un default de 100 cuando no hay declaración |
| **T-CLAMP-02b** | `discovery.limit.test.ts` | AC-2 / CD-2 | registry **con** `maxLimit: 100`, `discover({})` sin `limit` | no se envía **ningún** `limitParam` (`upstreamLimits[0] === null`) | M5: mover el clamp fuera del gate `query.limit && schema.limitParam` |
| **T-CLAMP-02c** | `discovery.limit.test.ts` | AC-2 / CD-9(e) | registry con `maxLimit: 100` y **sin** `limitParam`, `discover({ limit: 500 })` | nunca se envía el parámetro | M5 variante |
| **T-CLAMP-03** | `discovery.truncation.test.ts` | AC-3 | `maxLimit: 100`, sin `nextCursorPath`, el mock devuelve **100** filas ante `limit=500` | `state === 'truncated'`, `truncationEvidence === 'page_full'`, `rows === 100`, `catalogStatus === 'truncated'` — y **no** `failed`/`http_error` | M1 (sin clamp se pide 500, llegan 100, `100 < 500` ⇒ `ok`: el mutante invierte el veredicto) |
| **T-CLAMP-03b** | `discovery.truncation.test.ts` | AC-3 | `maxLimit: 100`, el mock devuelve **23** filas | `state === 'ok'` (no hay falso positivo de truncamiento bajo el techo) | M6: forzar `page_full` siempre que haya clamp |
| **T-CLAMP-04** | `discovery.sources.test.ts` | AC-4 | **mimic del contrato medido de `wasiai`**: `limit > 100` ⇒ `400` con body `{"error":"limit must be between 1 and 100"}`; `limit <= 100` ⇒ `200` + catálogo. `maxLimit: 100`, `discover({ limit: 200 })` | la fuente **no** es `failed`, `failure` es `undefined`, `rows > 0`, `catalogStatus !== 'partial'` | M1 (sin clamp llega el 400 y la fuente cae) |
| **T-CLAMP-04b** | `discovery.sources.test.ts` | AC-4 (control negativo) | el mismo mimic **sin** `maxLimit` declarado | la fuente **sí** es `failed`/`http_error` — o sea el test de arriba mide el clamp y no al mock | M2 (un default pesimista haría pasar este caso y el test perdería su poder) |
| **T-CLAMP-05** | `compose.discovery-pool.test.ts` | AC-5 | patrón T-POOL-7 (:348, path real hasta `signAndSettleDownstream`): mimic con techo 100 y 100 agentes, el target Solana **fuera del top-50** por precio | `payment.chain` hidratado y la chain `solana` llega al settle. Contraste explícito: sin `maxLimit` el mismo escenario da pool vacío | M1 |
| **T-CLAMP-06** | `discovery.limit.test.ts` | AC-6 | el `schema.discovery` se construye con `JSON.parse` del **mismo literal jsonb que escribe la migración** (`{"maxLimit":100,"nextCursorPath":"next_cursor","limitParam":"limit"}`) | `upstreamLimits[0] === '100'` sin ninguna línea de código extra | M4: exigir que `maxLimit` venga de otro lado / romper el path `{discovery,maxLimit}` |
| **T-CLAMP-07** | `compose.discovery-pool.test.ts` | AC-7 (lado positivo) | `maxLimit: 100` ⇒ el pool de `/compose` es ≥ el piso histórico de 50 | el agente que el mimic de `main` (pool 50) encontraba sigue encontrándose | M7: clampear también el page size del pool |
| **T-CLAMP-07b** | `compose.discovery-pool.test.ts` | AC-7 (residual honesto) | `maxLimit: 10` con 200 agentes activos | el pool **es de 10** (se afirma el residual TD-318B-2, no se lo disfraza) **y** se emitió el `warn` `REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL` | M8: poner un piso de 50 al clamp (rompe la aserción de `10`) |
| **T-CLAMP-08** | `discovery.limit.test.ts` | CD-13 / DT-3 | tabla de `maxLimit` inválidos: `"100"` (string), `"abc"`, `0`, `-5`, `1.5`, `null`, `{}` | en los siete: `upstreamLimits[0] === '200'` (sin clamp, **nunca** `'NaN'`, `'0'`, `'1'`) y se emitió `REGISTRY_MAX_LIMIT_INVALID` | M9: quitar el `typeof`/`Number.isInteger` (`"abc"` ⇒ `NaN`); M10: quitar el `>= 1` (`0` ⇒ `limit=0`) |

**Evidencia que NO puede vivir en CI** (no hay red en la suite): la comprobación
contra el registry real de AC-4. Va como evidencia manual de F4, con este comando
—`python3`+`urllib` porque redirigir `curl` a archivo bajo el proxy `rtk` corrompe
la salida (memoria `rtk-proxy-corrupts-redirected-output`):

```
python3 -c "import urllib.request as u
for n in (100,101):
    try:
        r=u.urlopen('https://wasiai-v2.vercel.app/api/v1/capabilities?limit=%d'%n); print(n, r.status)
    except Exception as e: print(n, getattr(e,'code',e))"
```

Esperado (medido 2026-08-04): `100 200` y `101 400`.

**No-regresión obligatoria**: `discovery.limit.test.ts` T-1..T-9,
`discovery.truncation.test.ts` T-TRUNC-01..08, `discovery.sources.test.ts`
T-SRC-01..13 y `compose.discovery-pool.test.ts` T-POOL-1..7 deben pasar **sin
modificarse**. Si alguno hay que tocarlo, es hallazgo: se documenta por qué antes
de tocarlo (WKH-315 `[W0]`: "el story file afirmó que la suite no habría que
tocarla, y sí hubo que tocarla — por tipos, no por conducta").

---

## 10. Waves

**W0 — serial, bloquea todo. Contratos y prosa. Cero cambio de conducta.**
- `src/lib/discovery-fetch-limit.ts`: `clampToRegistryMaxLimit(fetchLimit: number,
  declared: unknown): number` + `clampFallsBelowComposePoolFloor(sent: number):
  boolean` + enmienda al docstring de `resolveUpstreamFetchLimit` (:36-46) con el
  puntero al clamp del call-site (§4.2, CD-8).
- `src/types/index.ts:145-160`: reescribir el JSDoc de `maxLimit` (ya no es "nadie
  lo lee") incluyendo el residual de §4.4 con su input falsificador.
- **Criterio de terminado de W0, medible**: `npx tsc --noEmit` exit 0 y la suite
  completa verde **sin un solo test nuevo** — los helpers todavía no los llama
  nadie, así que ningún test existente puede cambiar de color. Si alguno cambia, es
  un hallazgo de W0, no de W1.

**W1 — el cableado (depende de W0).**
- `src/services/discovery.ts:1072-1076`: `sentLimit = clampToRegistryMaxLimit(
  resolveUpstreamFetchLimit(query.limit), schema.maxLimit)`.
- Los dos `log.warn` (`REGISTRY_MAX_LIMIT_INVALID`,
  `REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL`), con el `error_code` como primer campo,
  siguiendo `discovery.ts:270-276`.
- **Nada más en el archivo.** El bloque de evidencia (:1165-1204) no se toca
  (§4.4).

**W2 — migración (paralelizable con W3/W4; no depende de W0/W1).**
- Los dos `.sql` de §4.5, con el marcador de línea 2 (CD-10). **No se aplican.**

**W3 — tests (depende de W1). Paralelizable internamente por archivo:**
- W3.a `discovery.limit.test.ts` (T-CLAMP-01, 02, 02b, 02c, 06, 08)
- W3.b `discovery.truncation.test.ts` (T-CLAMP-03, 03b)
- W3.c `discovery.sources.test.ts` (T-CLAMP-04, 04b)
- W3.d `compose.discovery-pool.test.ts` (T-CLAMP-05, 07, 07b)

**W4 — trazabilidad (paralelizable, sin dependencias de código).**
- `doc/sdd/215-.../backlog.md` B-3: marcar cerrado **para registries que declaran
  `maxLimit`** + puntero a esta carpeta. 2-4 líneas, sin reescribir el resto.

**Campaña de mutación** (después de W3): M1..M10 de §9, cada uno con hash de
mutación, `tsc` y el test nominado que lo mata, en `mutation-log.md`. CD-7 aplica:
un mutante "muerto" por un test que recalcula el valor no cuenta.

---

## 11. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Los 7 ACs tienen al menos un test nominado y un mutante | ✅ §9 (13 tests, 10 mutantes) |
| 2 | Todos los paths citados existen (verificados con `Read`/`grep` sobre `0cad63d`) | ✅ §2 |
| 3 | La decisión de diseño central (registry sin `maxLimit`) está tomada y justificada con trade-off | ✅ §3 (Opción A) |
| 4 | Está dicho qué hace el código **antes** de la migración | ✅ §4.6 — no arregla nada, no rompe nada |
| 5 | La migración lleva el marcador "NO aplicar" y su `_down` | ✅ §4.5 + CD-10 |
| 6 | NC-1 resuelto leyendo el repo | ✅ §5 (deducción sobre `discovery.ts:1073,1184,1192`) y la decisión es robusta al error |
| 7 | NC-2 (paliativo Railway) queda como decisión del founder, con recomendación | ✅ §5 — **no decidido acá** |
| 8 | NC-3 (wasiai-v2) declarado fuera, con sonda | ✅ §5 |
| 9 | CD-1..CD-6 heredados textualmente + CD-6 evaluado | ✅ §7 |
| 10 | CDs nuevos anclados a auto-blindaje histórico con cita | ✅ CD-7..CD-13 |
| 11 | Scope OUT explícito (2º defecto, v2, paginación, W4, write-path) | ✅ §6 |
| 12 | Deuda declarada con dueño/gatillo | ✅ §8 (TD-318B-1..5, R-1, R-2) |
| 13 | Colisión de merge medida | ✅ §2.1 (cero roce, 5 branches) |
| 14 | Waves con W0 serial y criterio de terminado medible | ✅ §10 |
| 15 | Cero código de producción escrito en F2 | ✅ solo este `.md` |

**TBDs sin resolver que bloqueen `SPEC_APPROVED`: ninguno.** Los dos
`[NEEDS CLARIFICATION]` que quedan (NC-2, NC-3) son decisiones de operación del
founder, no de diseño: el Dev puede implementar las 4 waves completas sin
respuesta para ninguno de los dos.
