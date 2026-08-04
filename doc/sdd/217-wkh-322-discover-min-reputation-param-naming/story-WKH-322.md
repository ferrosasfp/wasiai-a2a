# Story File — WKH-322 · `/discover` deja de descartar parámetros en silencio

| Campo | Valor |
|---|---|
| HU | WKH-322 |
| SDD | [`sdd.md`](sdd.md) — `SPEC_APPROVED` otorgado |
| Work item | [`work-item.md`](work-item.md) — `HU_APPROVED` |
| Metodología | QUALITY |
| Branch | `feat/217-wkh-322-discover-reputation-param-naming` (desde `main`) |
| Archivos de producción | 2 (`src/lib/discovery-query.ts`, `src/routes/discover.ts`) |
| Archivos de test | 2 (aditivos) + 1 corrección (`e2e.test.ts`) |
| Scripts a corregir | 2 (`scripts/perf-bench.mjs`, `scripts/k6-load-test.js`) — ver §2 |
| Doc público | 1 (`doc/INTEGRATION.md`) |
| Fecha | 2026-08-04 |

> **Este documento es tu único contrato.** Si algo no está acá, no lo hagas. Si algo
> acá te parece mal, paralo y escribilo — no lo "mejores" en silencio, que es
> literalmente el bug que esta HU viene a matar.

---

## 1. Qué se construye, y por qué las dos mitades son UNA sola decisión

`/discover` tiene un filtro de reputación real y funcionando. El bug no es el filtro:
es que **la ruta lee `minReputation` (camelCase) y nada más**. Un caller que llega con
la convención de `/compose` — donde el mismo concepto se llama `min_reputation`
(`src/lib/compose-step-shape.ts:51`, `src/services/capability-resolver.ts:110-112`) —
no recibe ni el filtro ni un error. Recibe 200 y una respuesta idéntica a la de no
haber pedido nada.

Y el problema es más ancho que un nombre: **ninguna de las dos rutas raíz de
`/discover` declara `schema:` de Fastify** (verificado: `src/routes/discover.ts:133-174`
y `:186-241`), así que **cualquier** clave mal escrita se descarta con 200. No es "un
parámetro con dos nombres". Es **una superficie sin esquema**.

### Se implementan las DOS mitades, y el ORDEN DEL ARGUMENTO importa

1. **Alias `min_reputation`** → tratado como sinónimo válido de `minReputation`.
2. **400 `UNKNOWN_DISCOVER_PARAM`** para toda clave fuera de la lista blanca.

**No son dos features. Son una.** Y no en cualquier orden:

- **El alias sin el 400** arregla exactamente un nombre y deja pasar el próximo typo.
  Ya sabemos que hay próximo typo: hay tres medidos (§2).
- **El 400 sin el alias** le cobra al caller **una inconsistencia nuestra**.
  `min_reputation` se llama así porque **así se llama en `/compose`**, en esta misma
  API, para esta misma capacidad. Devolverle 400 a quien leyó bien la mitad de nuestra
  propia documentación es cobrarle el desorden que pusimos nosotros.
- **El alias es lo que vuelve legítimo al 400.** Primero dejamos de contradecirnos;
  recién después exigimos precisión.

> ⛔ **Si mergeás una sola de las dos mitades, la HU no cierra.** No hay "corte A".
> No hay "el alias primero y el 400 en otra PR". W0+W1+W2 entran juntas o no entran.

### No es una política nueva: ya la escribimos, una capa más adentro

`src/lib/compose-step-shape.ts:176-185` **ya rechaza** toda clave desconocida dentro de
`step.constraints`, y el comentario que la justifica (`:168-175`) dice textual:

> *"Decirle que no se soporta es honesto; ignorarlo, no."*

**La asimetría que esta HU corrige es perversa, y conviene que quede escrita en el
código nuevo:** la superficie que **cobra** (`/compose`) es estricta, y la superficie
**gratuita** (`/discover`) es permisiva — **y la gratuita es donde el integrador decide
a quién le va a pagar.** Un parámetro ignorado en la consulta gratis se paga en la
llamada siguiente.

---

## 2. Impacto medido — no estimado. Y una corrección al SDD

Esta sección es la que **te da permiso** a meter un 400 en una superficie pública sin
volver a pasar por un gate humano. Está medida, con archivo:línea.

### 2.1 GET — limpio (14 query strings, cero roturas)

Enumeradas TODAS las query strings contra `/discover` en `src/`, `scripts/` y
`packages/`. Las claves usadas son, exhaustivamente:

```
capabilities · q · maxPrice · minReputation · allowTrial · limit · registry · verified
```

Las 8 están en la lista blanca. **Cero roturas por GET.**

Callers internos verificados uno por uno:

| Caller | Qué manda | Veredicto |
|---|---|---|
| `scripts/doctor-dast.js:81` | `?q=<payload>` | OK |
| `scripts/doctor-dast.js:126` | `/discover` sin params | OK |
| `scripts/doctor-chaos.js:181,198` | `?q=chaos&limit=1`, `?q=recovery&limit=1` | OK |
| `scripts/doctor-chaos.js:85-86` | `POST { capabilities, limit }` | OK |
| `scripts/k6-load-test.js:121` | `?q=price&limit=5` | OK |
| `scripts/smoke-base-downstream.mjs:116` | `POST { q }` | OK |
| `scripts/smoke-downstream-x402.mjs:152-156` | `POST { q: 'base' }` | OK |
| `scripts/smoke-downstream-x402.mjs:384-388` | `POST { q: GOAL }` | OK |
| `scripts/smoke-capabilities-schema.mjs:59` | `/discover` sin params | OK |
| `packages/agent-sdk/src/agent.ts:496-513` | `POST` con `q, capabilities, maxPrice, minReputation, limit, registry, verified` | **OK — las 7 están whitelisted** |
| `src/middleware/event-tracking.ts:19` | sólo lista el prefijo para telemetría | no llama |

**Callers internos del motor** (`src/routes/orchestrate.ts`, `src/services/capability-resolver.ts:124`,
`src/routes/capabilities.ts`, `src/mcp/tools/discover-agents.ts`) invocan
`discoveryService.discover({...})` **en proceso**: no pasan por el parser de query, así
que el 400 les es transparente. **No los toques.**

**Documentación pública** (`doc/INTEGRATION.md:126`, `:994`, `:1036`,
`doc/QUICKSTART-PUBLISH.md`, `doc/BASE-EVIDENCE.md`): sólo `capabilities`, `limit`, `q`.
**Ningún ejemplo publicado quedaría rechazado.**

### 2.2 🔴 POST — el SDD dijo "cero", F2.5 dijo CUATRO y son OCHO. Corrección del fix-pack

> El §3.4 del SDD afirma *"radio interno medido = 0 … no rompe ni un test existente"*.
> **Eso es falso.** La medición del SDD enumeró las query strings de GET y **no
> enumeró los bodies de POST**. Acá está lo que faltaba.

El parámetro público de texto libre es **`q`**. El campo **`query`** es el nombre
**INTERNO** del tipo `DiscoveryQuery` (`src/types/index.ts:449-451`), y la ruta traduce
uno al otro en `src/routes/discover.ts:229`:

```ts
query: body.q != null ? String(body.q) : undefined,
```

**`body.query` no lo lee nadie.** Y **ocho** call-sites de este repo mandan exactamente eso:

| # | Archivo:línea | Body | Consecuencia del 400 |
|---|---|---|---|
| 1 | `src/__tests__/e2e/e2e.test.ts:274-280` | `payload: { query: 'test' }` | El test afirma `statusCode === 200` (`:279`) → **SUITE EN ROJO** |
| 2 | `scripts/perf-bench.mjs:11` | `{ query: '', limit: 10 }` | 400 contra prod |
| 3 | `scripts/perf-bench.mjs:12` | `{ query: 'price', limit: 5 }` | 400 contra prod |
| 4 | `scripts/k6-load-test.js:127` | `{ capabilities: ['defi'], query: 'oracle', limit: 3 }` | `checkResponse(..., 200)` en `:130` → check en rojo |
| 5 | `scripts/k6-deep-test.js:356` | `body.query = query.q` | `check 'discover POST 200'` (`:364`) en rojo en cada iteración con `q` no vacío |
| 6 | `scripts/smoke-e2e-comprehensive.mjs:144` | `{ query: '', limit: 50 }` | 400 → `agents` `undefined` → `?? []` → **el smoke imprime `0/5 target slugs found` y SIGUE, sin fallar** |
| 7 | `scripts/smoke-e2e-cross-chain.mjs:127` | `{ query: '', limit: 50 }` | 400 → falla en `:132`, pero diagnosticado como "Missing agents" |
| 8 | `scripts/smoke-e2e-final.mjs:147` | `{ query: '', limit: 50 }` | 400 → falla en `:153`, pero diagnosticado como "Missing" |

> **Corrección del fix-pack (2026-08-04).** F2.5 enumeró 4 y el AR encontró 2 más
> (`#5`, `#6`). El re-grep del fix-pack encontró **otros 2** que el AR tampoco tenía
> (`#7`, `#8`): son copias literales de `#6`, y el AR los perdió porque grepeó por
> nombre de archivo conocido en vez de por la clave. **El grep que encuentra los 8** es
> por la CLAVE (`"query"\s*:` sobre `scripts/`, `src/`, `packages/`), cruzado con "¿el
> destino de este `fetch`/`http.post` es `/discover`?" — hay 12 hits más de
> `JSON.stringify({ query: sql })` que van a la API de Supabase y NO son de esta clase.
>
> Los `#6`, `#7` y `#8` se corrigen además con un assert de status: el `#6` no fallaba
> (mudo) y el `#7`/`#8` fallaban señalando el lugar equivocado.

**Verificados y descartados** (mandan `q` o no van a `/discover`):
`scripts/hackathon-e2e.mjs:112-116` y `:375` (este último es
`api.supabase.com/.../database/query`), `scripts/report-stranded-exposure.mjs:80`,
`scripts/doctor-chaos.js`, `scripts/doctor-dast.js`, `scripts/smoke-base-downstream.mjs:116`,
`scripts/smoke-downstream-x402.mjs:152,384`, `scripts/smoke-capabilities-schema.mjs:59`,
`packages/agent-sdk/src/agent.ts:496-513` (y su `dist/agent.js`).

**El daño va más allá del rojo.** `scripts/perf-bench.mjs:11-12` declara dos escenarios
llamados *"POST /discover (empty query)"* y *"POST /discover (filter category)"*. Como
el servidor descarta `query`, **los dos miden la misma llamada sin filtrar**. El
benchmark de "filtrar por categoría" nunca filtró nada, y su número se viene publicando
como si significara algo.

**Tres apariciones independientes de la MISMA clase, en 24 horas:**

| Nombre escrito | Nombre real | Dónde mordió | Costo observado |
|---|---|---|---|
| `min_reputation` | `minReputation` | el bug que origina la HU | filtro de reputación inerte |
| `capability` | `capabilities` | la medición del work-item | 23 agentes donde había 1 (factor 23) |
| `query` | `q` | 8 call-sites de este repo | dos benchmarks que miden lo mismo y no lo dicen, y un smoke mudo |

Los tres son nombres **plausibles**. Los tres devuelven **200**. Ninguno hizo nada.

### 2.3 Qué cambia esto en el argumento (leelo antes de pensar que te complica)

El permiso para meter el 400 **no se debilita: se invierte a favor**. Ya no descansa en
"no rompe nada" (que era falso), sino en algo más fuerte y medido: **si en este repo se
escribió `query` en ocho lugares distintos y nadie se enteró en meses, el silencio ya
está costando plata y credibilidad de medición.**

Lo que sí cambia, y hay que decirlo con honestidad, es **R-1**: si nosotros lo
escribimos mal ocho veces, la probabilidad de que un integrador externo también lo
haya hecho **no es baja**. Ver §9.

### 2.4 Por qué `query` NO se aliasa (aplicando el criterio que ya fijó el SDD)

DT-5 del SDD fija el criterio: **se aliasa sólo un nombre que YA sea contrato público en
otra superficie de esta API.**

- `min_reputation` **califica**: es contrato público de `/compose`
  (`compose-step-shape.ts:51`), documentado y en uso por chaski-v3.
- `query` **NO califica**: es un nombre **interno** que se filtró a ocho call-sites. No
  está documentado en ningún lado como parámetro público.
- `capability` **NO califica**: es un singular plausible, nada más.

Aliasar por plausibilidad es aceptar que el número de nombres válidos crece con la
imaginación de los callers, y cada sinónimo hay que mantenerlo, documentarlo y testearlo
para siempre. **Para `query` y `capability` la respuesta correcta es el 400 que nombra
el parámetro bueno.** Se enseña el nombre canónico una vez y no se crea un segundo.

⇒ **Los 8 call-sites se arreglan** (`query` → `q`). Eso además **repara el benchmark**
en vez de sólo callarlo. Es un ensanchamiento de scope **declarado**, no de contrabando:
`scripts/perf-bench.mjs`, `scripts/k6-load-test.js`, `scripts/k6-deep-test.js` y los tres
`scripts/smoke-e2e-*.mjs` no estaban en el Scope IN del work-item y entran acá por esta
razón y sólo por esta.

---

## 3. Constraint Directives — heredadas y vigentes

### Del work-item

- **CD-1** — PROHIBIDO tocar `src/services/capability-resolver.ts`,
  `src/routes/compose.ts` o cualquier lectura de `constraints.min_reputation`. Ese
  camino ya filtra bien y es **money-adjacent** (decide qué agente cobra).
- **CD-2** — OBLIGATORIO reusar `parseMinReputation`
  (`src/lib/discovery-query.ts:44-57`) como **único** validador de rango `[0,100]` para
  **los dos** nombres. PROHIBIDO duplicar la lógica: un alias con su propio parseo
  divergiría y reabriría la clase que el fix-pack P1 ya cerró.
- **CD-3** — PROHIBIDO agregar queries/RPC nuevas. El camino sin parámetro de reputación
  sigue con el mismo costo de I/O, byte por byte. Todo lo que agrega esta HU es
  in-process y O(claves de la request).
- **CD-4** — PROHIBIDO modificar `applyReputationFloor` o el carril de estreno en
  `src/services/discovery.ts`. **Sólo se toca la capa de PARSEO/VALIDACIÓN.**

### Del SDD

- **CD-5** 🔒 — **PROHIBIDO implementar el rechazo con `schema` de Fastify /
  `additionalProperties: false`.** Ver §4: es un candado, no una nota.
- **CD-6** — OBLIGATORIO que GET y POST pasen por el **mismo** helper
  (`parseFiltersOr400`). Es la razón por la que ese helper existe: ver el comentario de
  WKH-313 en `src/routes/discover.ts:39-42` — *"un flag que sólo se valida en GET deja
  al otro camino aceptando basura por el mismo endpoint"*. **Todo test nuevo de ruta
  tiene su gemelo POST.**
- **CD-7** — PROHIBIDO agregar sinónimos más allá de `min_reputation`. PROHIBIDO el
  matcheo difuso / "quisiste decir X" por distancia de edición.
- **CD-8** — OBLIGATORIO que `doc/INTEGRATION.md` (W2) entre en el **mismo PR/merge** que
  el wiring (W1). Partirlo dejaría en `main` o un doc que promete lo que el código no
  hace, o un código que rompe callers sin contrato publicado.
- **CD-9** *(auto-blindaje WKH-319 + WKH-313)* — PROHIBIDO escribir comentarios o
  docstrings que afirmen propiedades universales no verificables con un input concreto.
  **Cada frase del código nuevo tiene que ser falsable.** Nada de *"esto garantiza que
  siempre…"* sin el test que lo clava al lado. Un comentario seguro de sí mismo apaga las
  tres revisiones siguientes; ya costó cinco iteraciones en una HU de este repo.
- **CD-10** *(auto-blindaje WKH-313 ×3, WKH-319)* — PROHIBIDO que un test derive su
  expectativa de la misma constante que verifica. Ver §7.3.
- **CD-11** *(auto-blindaje WKH-315)* — antes de cambiar la firma de `parseFiltersOr400`,
  grepear **call-sites y casts**, no sólo valores. Un `as` en un test es una dependencia
  invisible para un grep por valor. (Ya hecho: §6 W1.1.)
- **CD-12** *(auto-blindaje WKH-318)* — si trabajás en un worktree nuevo, **verificá que
  `node_modules/` exista antes de leer un `tsc --noEmit` como baseline**. Un `TS2307`
  masivo sobre paquetes de terceros casi nunca es "la rama está rota".
- **CD-13** — PROHIBIDO cambiar el shape del cuerpo de error. Sigue siendo
  `{ error, code }`, igual que los tres 400 que la ruta ya emite
  (`src/routes/discover.ts:50`).

---

## 4. 🔒 CD-5 — la trampa de Fastify. Leé esto ANTES de escribir una línea

**Vas a tener el impulso de usar un `schema` de Fastify, porque es lo idiomático.**
Ese impulso es la trampa, y hacerlo produciría **lo contrario** de lo buscado.

Verificado en este árbol:

1. `src/index.ts:95-106` construye la instancia así:
   ```ts
   const fastify = Fastify({ logger: { redact: REDACT_PATHS }, genReqId, trustProxy: ... });
   ```
   **No hay opción `ajv:`.**
2. Sin `ajv` custom rigen los defaults de `@fastify/ajv-compiler` (v4.0.5 con Fastify
   5.9.0, verificado en `node_modules/`). Su README los lista, y entre ellos está:
   ```js
   { coerceTypes: 'array', useDefaults: true, removeAdditional: true, ... }
   ```
3. Con **`removeAdditional: true`**, declarar `additionalProperties: false` hace que ajv
   **BORRE** las claves desconocidas **antes de que el handler vea el objeto**. No hay
   error. No hay log. El handler **ni siquiera puede enterarse de que existieron**.

**Sería cambiar un silencio por otro, más profundo.** Hoy la clave al menos llega al
handler y es observable; con el schema ingenuo desaparecería antes.

El propio repo ya dejó la pista: `src/routes/orchestrate.ts:79` documenta que el schema
de `steps[]` **no** declara `additionalProperties: false` *"así que ajv NO remueve las
claves que no conoce"*.

⇒ **El chequeo vive en código de aplicación**, en el módulo leaf + el helper compartido,
donde el conjunto de claves recibidas es observable. Es, además, el mismo lugar donde
`/compose` puso el suyo.

---

## 5. Scope

### IN — la lista exhaustiva de archivos que tocás

| # | Archivo | Acción |
|---|---|---|
| 1 | `src/lib/discovery-query.ts` | **modificar, aditivo puro** — no se altera una línea existente |
| 2 | `src/routes/discover.ts` | **modificar** — helper + 2 handlers raíz + 2 tipos |
| 3 | `src/lib/discovery-query.test.ts` | **modificar, aditivo** — `T-U1..T-U6` |
| 4 | `src/routes/discover.minreputation.test.ts` | **modificar, aditivo** — `T-R22..T-R34` |
| 5 | `src/__tests__/e2e/e2e.test.ts:278` | **corregir** — `{ query: 'test' }` → `{ q: 'test' }` (§2.2 #1) |
| 6 | `scripts/perf-bench.mjs:11-12` | **corregir** — `query:` → `q:` (§2.2 #2/#3) |
| 7 | `scripts/k6-load-test.js:127` | **corregir** — `query:` → `q:` (§2.2 #4) |
| 8 | `doc/INTEGRATION.md` | **modificar** — §`/discover` + tabla de errores |

### OUT — no lo hagas aunque te tiente

- ⛔ **`src/services/discovery.ts`** — `applyReputationFloor`, el carril de estreno, el
  orden del pipeline. **Nada.** (CD-4)
- ⛔ **Todo `/compose`**: `capability-resolver.ts`, `compose.ts`, `compose-step-shape.ts`.
  Ni siquiera un comentario. (CD-1)
- ⛔ **`GET /discover/:slug`** (`src/routes/discover.ts:247-268`) — otra ruta, otro
  contrato, otro tipo de caller (`rateLimit: false`), y el work-item no la nombra. Sigue
  descartando `?foo=bar` en silencio. Es **deuda TD-322-1**, declarada, no tuya.
- ⛔ **Aliasar `capability`, `query`, o cualquier otro nombre.** (CD-7, §2.4)
- ⛔ **Endurecer `verified` / `includeInactive`** (`src/routes/discover.ts:168-169`,
  `:236-237`): hoy `?verified=1` y `?verified=TRUE` colapsan a `undefined` en silencio.
  Misma clase, pero sobre **valores**, no sobre **nombres**, y nadie lo midió. Deuda
  **TD-322-2**.
- ⛔ **`chaski-v3`, `wasiai-facilitator`, `wasiai-remittance-agents`** — prohibido.
- ⛔ **Arreglar la reputación de `remit-cashout-payout-solana`** o el piso de chaski-v3.
  Ver §9 R-2: **tiene dueño y no sos vos.**
- ⛔ **`doc/sdd/_INDEX.md`** y `_INDEX-row.md` — ver §12. Es de `nexus-docs`.

---

## 6. Waves

**Orden estrictamente serial: W0 → W1 → W2.** No hay paralelizable: la HU toca 2
archivos de producción y el segundo depende del primero. W2 podés redactarla en paralelo
a W1, pero **no mergea sin ella** (CD-8).

---

### W0 — Contrato y validadores (SERIAL, bloquea todo)

**Todo en `src/lib/discovery-query.ts`. Aditivo puro: no modifiques ninguna de las 153
líneas existentes.** Ese módulo es LEAF a propósito — su docstring (`:1-10`) explica que
los tests de la ruta mockean `../services/discovery.js` **completo** con una factory sin
`importOriginal`, así que cualquier export nuevo que la ruta consuma desde el service
quedaría `undefined` en esos tests. **Un validador de input no es lógica de service.**

#### W0.1 — `ALLOWED_DISCOVER_PARAMS`

Constante **exportada**, `ReadonlySet<string>`, con **exactamente 10 claves**:

```
allowTrial · capabilities · includeInactive · limit · maxPrice ·
minReputation · min_reputation · q · registry · verified
```

**Declarala en ese orden (alfabético)** para que el mensaje del 400 sea estable y
testeable.

Las 9 primeras son **exactamente lo que la ruta ya lee hoy** — verificado contra el tipo
`Querystring` (`src/routes/discover.ts:137-147`) y el tipo `Body` (`:190-200`), que
declaran las mismas 9. La décima es el alias.

> 🔴 **`capabilities`, con S. `capability` NO va en la lista.** Es el nombre que falló
> en la medición del work-item y devolvió el catálogo entero con 200. Si lo agregás,
> estás creando el segundo nombre que esta HU existe para no crear.

**Docstring obligatorio** — copiá el modelo de `ALLOWED_STEP_CONSTRAINTS`
(`src/lib/compose-step-shape.ts:39-57`), incluyendo:

- Que se exporta para que el test negativo lea ESTA lista y no una copia.
- La advertencia de que **agregar una clave acá es decisión de producto, no un detalle
  de validación** (la frase equivalente está en `compose-step-shape.ts:46-47`).
- Por qué `min_reputation` está y `capability` / `query` no (§2.4). Con causa, no con
  gusto.

**Cita obligatoria del precedente** (punto 3 del encargo). En el docstring del chequeo
tiene que quedar escrito, con estas palabras:

> `/compose` ya rechaza toda clave desconocida en `step.constraints`
> (`compose-step-shape.ts:176-185`), y ahí quedó escrito por qué: *"Decirle que no se
> soporta es honesto; ignorarlo, no."* Lo que faltaba era la simetría, y la asimetría era
> perversa: **la superficie que cobra era estricta y la gratuita era permisiva — y la
> gratuita es donde el integrador decide a quién pagarle.**

⚠️ **CD-9 aplica a ese docstring.** Escribí hechos verificables (rutas, líneas, la
decisión y su motivo). **No** escribas *"esto garantiza que ningún parámetro se pierda"*:
es falso (`/discover/:slug` sigue perdiéndolos, TD-322-1) y apagaría la próxima revisión.

#### W0.2 — Las tres clases de error

Mismo patrón que las tres existentes (`:25-33`, `:74-80`, `:124-132`): `extends Error`,
`readonly code = '...' as const`, `constructor(readonly received: unknown)`, `this.name`.

| Clase | `code` | Cuándo |
|---|---|---|
| `UnknownDiscoverParamError` | `UNKNOWN_DISCOVER_PARAM` | clave fuera de la lista blanca |
| `ConflictingMinReputationError` | `CONFLICTING_MIN_REPUTATION` | los dos nombres con valores distintos |
| `InvalidDiscoverBodyError` | `INVALID_DISCOVER_BODY` | body de POST que no es objeto plano |

**Un código por causa.** No reuses `UNKNOWN_DISCOVER_PARAM` para el body malformado:
sería mentir sobre la causa.

#### W0.3 — `assertKnownDiscoverParams(raw: Record<string, unknown>): void`

Recorre las claves y **lanza en la primera desconocida**.

**El mensaje del 400 tiene que ser útil** (punto 4 del encargo). Formato exacto:

```
unknown parameter '<clave>'. Accepted parameters: allowTrial, capabilities,
includeInactive, limit, maxPrice, minReputation, min_reputation, q, registry, verified
```

Construí la lista uniendo `ALLOWED_DISCOVER_PARAMS` con `', '` en su orden de
declaración (por eso W0.1 pide orden alfabético).

> **Por qué el mensaje importa tanto:** un 400 que no dice el nombre correcto convierte
> un error de un carácter en media hora de búsqueda. Eso es exactamente lo que costó
> hoy con `capability`. El caller tiene que poder arreglarlo **sin abrir la
> documentación**.

⚠️ **Precisión de la prosa (CD-9) — gotcha de JS.** Te va a tentar escribir *"recorre las
claves en el orden en que el caller las escribió"*. **Es falso** y es falsable con un
input concreto: JS enumera primero las claves con forma de índice entero, en orden
numérico ascendente, antes que las demás. Con `?1=a&capability=b`, `Object.keys` devuelve
`['1', 'capability']` y el error reporta `'1'`, no `'capability'`.

⇒ El docstring debe decir **"lanza en UNA clave desconocida y el mensaje la nombra"**, y
nada sobre "la primera que escribió el caller". Determinismo sí (mismo input ⇒ mismo
mensaje); "orden del caller" no. **No uses `Object.keys().sort()`**: escondería aún más
la clave que el caller leería primero.

#### W0.4 — `resolveMinReputation(camelRaw: unknown, snakeRaw: unknown): number | undefined`

```
a = parseMinReputation(camelRaw)     // CD-2: el ÚNICO validador
b = parseMinReputation(snakeRaw)     // CD-2: el MISMO, sobre el otro nombre
si a !== undefined && b !== undefined && a !== b  ->  throw ConflictingMinReputationError
devolver a ?? b
```

Consecuencias, **todas deliberadas** — no las "simplifiques":

- **Equivalencia por construcción.** Los dos nombres colapsan al mismo `number` y
  alimentan el mismo campo `minReputation` del `DiscoveryQuery`. **Aguas abajo del parser
  hay UN solo camino**, byte por byte el de hoy. Por eso el fail-closed de AC-4 no puede
  debilitarse: no existe una segunda rama que pueda divergir.
- **La comparación es entre NORMALIZADOS, no entre crudos.** `('5', 5)` y `('5', '5.0')`
  → `5`, sin conflicto. Comparar los crudos daría un falso conflicto.
- **Vacío = ausente.** `?minReputation=5&min_reputation=` **no** es conflicto: el segundo
  parsea a `undefined` por el contrato ya vigente de `discovery-query.ts:45`.
- **Conflicto → 400, NO precedencia.** Se descartó "gana el camelCase" con un caso
  concreto: `?minReputation=0&min_reputation=5` (default de plantilla + override
  explícito) devolvería `0` — el piso explícito del caller descartado en silencio, o sea
  **la misma clase de bug que esta HU cierra, con el signo invertido**. Dos valores
  incompatibles no se pueden honrar los dos.
- **Un valor inválido por CUALQUIERA de los dos nombres da el MISMO
  `INVALID_MIN_REPUTATION`** (CD-2). No inventes un código nuevo para el alias.

#### W0.5 — Unit tests `T-U1..T-U6`

En `src/lib/discovery-query.test.ts`. Seguí el patrón del archivo: naming `T-<letra><n>`
(hoy conviven `T-V*`, `T-L*`, `T-AT*`), y el patrón `try / expect.unreachable / catch`
para afirmar `code` y `received`.

#### ✅ Criterio de terminado de W0 — verificable

1. `npx tsc --noEmit` **limpio y completo** (no `npm run build`: la lección de WKH-196 es
   que `build` no ve todo).
2. `npx vitest run src/lib/discovery-query.test.ts` verde, con `T-U1..T-U6` presentes.
3. `git diff src/lib/discovery-query.ts` muestra **sólo agregados**: ninguna de las 153
   líneas originales aparece con `-`.
4. `git diff --stat` no toca ningún archivo fuera de `src/lib/discovery-query.ts` y su
   test.

> W0 es aditiva y **no vuelve requerido ningún campo de un tipo compartido**, así que el
> dolor de W0 de WKH-318 (los dobles de test que dejaron de compilar) **no aplica acá**.
> Verificado: ningún tipo existente cambia.

---

### W1 — Wiring en la ruta (depende de W0)

#### W1.1 — `parseFiltersOr400` cambia de firma (CD-11 ya aplicada)

Hoy (`src/routes/discover.ts:25-55`) recibe tres campos elegidos a mano:

```ts
raw: { minReputation: unknown; limit: unknown; allowTrial: unknown }
```

**Ese "elegidos a mano" ES el bug**: el helper nunca ve las claves que nadie eligió, así
que no puede notar que existen. Pasa a recibir el **bag crudo**:

```ts
raw: unknown
```

**Call-sites grepeados (CD-11): son exactamente 2** — `src/routes/discover.ts:153` (GET)
y `:220` (POST). **No hay ningún otro, ni ningún cast `as` sobre el helper**, en `src/`,
`scripts/` ni `packages/`. El helper no se exporta.

#### W1.2 — Los cuatro pasos dentro del helper, EN ESTE ORDEN

```
1. guarda de forma del body        -> InvalidDiscoverBodyError
2. assertKnownDiscoverParams(raw)  -> UnknownDiscoverParamError
3. resolveMinReputation(raw.minReputation, raw.min_reputation)
                                   -> ConflictingMinReputationError | InvalidMinReputationError
4. parseLimit(raw.limit) / parseAllowTrial(raw.allowTrial)   [sin cambios]
```

**Primero la FORMA, después los VALORES. El orden es una decisión, no un accidente**, y
hay que pinearlo con test (`T-R31`). Con `allErrors: false` de facto (un solo error por
respuesta) el orden se elige o se sufre.

Se elige forma primero porque **una clave desconocida significa que el modelo mental del
caller sobre la forma de la API está equivocado**; devolverle un error de valor sobre
*otro* parámetro lo manda a buscar al lugar equivocado. Es el mismo razonamiento que
`capability-resolver.ts:136-174` aplica al ordenar los motivos del 422 (alcance antes que
reputación; "no pude leer" antes que "no alcanzan").

**Guarda de forma (paso 1)** — poné el helper a recibir `unknown` y resolvelo ahí, así
GET y POST comparten también esto (CD-6):

- `null` / `undefined` → tratar como `{}` → sigue. **Es el comportamiento de hoy y está
  pineado** por `src/routes/discover.test.ts:203` (`payload: {}` → 200 con filtros
  all-undefined). No lo rompas.
- objeto plano → sigue.
- **array o primitivo → `InvalidDiscoverBodyError`.** Sin esta guarda, `Object.keys([1,2])`
  devuelve `['0','1']` y el 400 diría `unknown parameter '0'`: loud, pero incomprensible.

Los tres `catch` nuevos se suman a la cadena `instanceof` existente (`:45-52`). **El
shape del cuerpo no cambia**: `{ error: err.message, code: err.code }` (CD-13).

#### W1.3 — GET

- `src/routes/discover.ts:153-157`: pasar **`request.query` completo** en vez de los tres
  campos.
- `src/routes/discover.ts:137-147`: sumar `min_reputation?: string;` al tipo
  `Querystring`.
- **Nada más cambia** en el handler: `filters.minReputation` ya alimenta la llamada a
  `discoveryService.discover` en `:164`.

#### W1.4 — POST

- **Mover la llamada a `parseFiltersOr400` para que sea lo PRIMERO del handler**, antes
  de la normalización de `capabilities` (`:206-218`). Hoy está después (`:220`). Razón:
  no hacer trabajo de coerción sobre una request que ya está rechazada, y que la guarda
  de forma corra antes de que alguien lea `body.capabilities` de un array.
- Pasarle `request.body` **crudo** (el helper resuelve `null`/`undefined` → `{}`).
- `src/routes/discover.ts:190-200`: sumar `min_reputation?: number;` al tipo `Body`.
- El `const body = (request.body ?? {}) as Record<string, unknown>` de `:204` puede
  quedarse para la lectura posterior de `capabilities`/`q`/etc.

#### W1.5 — Tests de ruta `T-R22..T-R34`

En `src/routes/discover.minreputation.test.ts`. **Continuá la numeración: el archivo
llega hoy a `T-R21`** (`:368`). Usá el setup que ya existe (`:22-56`): mock de
`../services/discovery.js` con factory sin `importOriginal`, `app.inject`,
`mockDiscover.mockClear()` en `beforeEach`.

**CD-6: cada caso nuevo lleva su gemelo POST.**

#### W1.6 — 🔴 Los ocho call-sites internos que hoy mandan `query`

**Esto no es opcional y no es cosmético.** Sin esto, W1 deja la suite en rojo y cinco
scripts rotos contra producción. Ver §2.2 para la evidencia completa.

| Archivo:línea | De | A |
|---|---|---|
| `src/__tests__/e2e/e2e.test.ts:278` | `payload: { query: 'test' }` | `payload: { q: 'test' }` |
| `scripts/perf-bench.mjs:11` | `body: { query: '', limit: 10 }` | `body: { q: '', limit: 10 }` |
| `scripts/perf-bench.mjs:12` | `body: { query: 'price', limit: 5 }` | `body: { q: 'price', limit: 5 }` |
| `scripts/k6-load-test.js:127` | `{ capabilities: ['defi'], query: 'oracle', limit: 3 }` | `{ capabilities: ['defi'], q: 'oracle', limit: 3 }` |
| `scripts/k6-deep-test.js:356` | `body.query = query.q` | `body.q = query.q` |
| `scripts/smoke-e2e-comprehensive.mjs:144` | `{ query: '', limit: 50 }` | `{ q: '', limit: 50 }` **+ assert de status** |
| `scripts/smoke-e2e-cross-chain.mjs:127` | `{ query: '', limit: 50 }` | `{ q: '', limit: 50 }` **+ assert de status** |
| `scripts/smoke-e2e-final.mjs:147` | `{ query: '', limit: 50 }` | `{ q: '', limit: 50 }` **+ assert de status** |

Los tres `smoke-e2e-*` llevan además un `if (res.status !== 200) → exit 1`. En
`smoke-e2e-comprehensive.mjs` es **obligatorio**: sin él la fase A.2 es muda (el 400 se
tapa con `?? []` y el smoke imprime `0/5` con un ✓ al lado). En los otros dos el smoke ya
fallaba, pero por "Missing agents", que manda a buscar al lugar equivocado.

**Dejá escrito en el reporte final** (no en el código): los números históricos de
`perf-bench.mjs` **no son comparables** con los de después del fix. El escenario
*"filter category"* nunca filtró — medía lo mismo que *"empty query"*. Decirlo es parte
del arreglo; callarlo sería repetir la clase de bug a nivel de documentación.

> **No aproveches para "mejorar" esos scripts.** Cambiás `query` por `q` y nada más.

#### ✅ Criterio de terminado de W1 — verificable

1. `npx tsc --noEmit` limpio.
2. **La suite COMPLETA en verde** — `npm test`, no sólo los archivos que tocaste.
   *"Sólo lo vi porque corrí la suite COMPLETA"* es una lección escrita de este repo, y
   §2.2 es exactamente el caso: el archivo que se rompe (`e2e.test.ts`) **no es ninguno
   de los que estás editando**.
3. `T-R22..T-R34` presentes y verdes.
4. Los mutantes de §7.2 corridos a mano, y **cada uno mata al menos un test nombrado**.
5. `grep -rn "query:" scripts/perf-bench.mjs scripts/k6-load-test.js` no devuelve nada
   dentro de un body de `/discover`.

---

### W2 — Contrato público (MISMA PR que W1 — CD-8)

`doc/INTEGRATION.md`.

#### W2.1 — Lista explícita de parámetros aceptados

⚠️ **Hoy el doc NO tiene una lista exhaustiva de parámetros de `/discover`**: los
describe en prosa (`:229-370`) y la frase de `:253-255` — *"Filters are applied by the
gateway (status, `verified`, `capabilities`, free-text `q`, `maxPrice`,
`minReputation`)"* — **omite `registry`, `limit`, `allowTrial` e `includeInactive`**.

**Un 400 sobre claves desconocidas exige una lista canónica publicada.** Sin eso, el
error es correcto y el doc no permite arreglarlo. Insertá la lista de las **10** claves
justo después de `:255`, con una línea por parámetro.

#### W2.2 — Las tres afirmaciones nuevas

1. **`min_reputation` se acepta como alias de `minReputation`** en GET y POST, con
   idéntica validación y resultado idéntico.
2. **La frase de convergencia**: *si querés un solo nombre que sirva en las DOS
   superficies (`/discover` y `constraints` de `/compose`), usá `min_reputation`.* Es lo
   único que se rescató de la opción "unificar la convención", que se evaluó y se rechazó
   porque renombrar `/compose` rompería a chaski-v3 **en la primera request** (la
   allowlist de `compose-step-shape.ts:49-57` es estricta).
3. **Toda clave no listada devuelve `400 UNKNOWN_DISCOVER_PARAM`**, con el nombre de la
   clave ofensora y la lista de aceptadas. Decilo con el motivo: un parámetro ignorado en
   la consulta gratuita se paga en la llamada siguiente.

#### W2.3 — Tabla de errores (`doc/INTEGRATION.md:721-731`)

La fila `400 Bad Request` (`:723`) hoy sólo nombra `INVALID_MIN_REPUTATION`. Sumá:
`UNKNOWN_DISCOVER_PARAM`, `CONFLICTING_MIN_REPUTATION`, `INVALID_DISCOVER_BODY`.

**Alcance acotado, y se permite exactamente esto y nada más:** completar en la misma
celda los códigos que ya existen y el doc omite — `INVALID_LIMIT`, `INVALID_ALLOW_TRIAL`.
Es la misma celda y hoy está incompleta.

#### ✅ Criterio de terminado de W2 — verificable

1. **Cada afirmación nueva del doc corresponde a un test nombrado de §7.1.** Si escribiste
   una frase que no podés mapear a un `T-*`, o sobra la frase o falta el test (CD-9).
2. La lista de 10 parámetros del doc coincide, uno a uno, con
   `ALLOWED_DISCOVER_PARAMS`. **Comparación a ojo, deliberadamente**: un script que las
   derive de la constante mediría la constante contra sí misma (CD-10).
3. `INVALID_DISCOVER_BODY` sólo se documenta para `POST`.

---

## 7. Tests

### 7.1 Mapa AC → test → mutante que lo mata

| AC | Test | Qué afirma | Mutante que DEBE matar |
|---|---|---|---|
| AC-1 | `T-R22` | `?minReputation=7` llega al service como `7`; la respuesta serializa `excluded.reputation` | quitar `minReputation` del objeto pasado a `discover` |
| AC-1 | `T-R23` | `POST { minReputation: 7 }` idem (simetría CD-6) | wirear sólo el GET |
| AC-2 | `T-R24` | `?min_reputation=2` llama a `discover` con `{ minReputation: 2 }` — **no** `undefined` | devolver `undefined` cuando sólo viene el snake |
| AC-2 | `T-R25` | `?min_reputation=2` y `?minReputation=2` producen **el mismo objeto de llamada** y la misma respuesta | cualquier divergencia entre las dos ramas |
| AC-2 | `T-R26` | `?capability=remittance-payout` → **400**, el mensaje **contiene `capabilities`**, y `mockDiscover` **no fue llamado** | aceptar claves desconocidas |
| AC-2 | `T-R27` | `?bogusparam=zzz` → 400 (la **clase**, no sólo el near-miss) | lista blanca implementada como "rechazo sólo lo que se parece" |
| AC-3 | `T-U1` | `resolveMinReputation('5', undefined) === resolveMinReputation(undefined, '5') === 5` | parseo distinto por rama |
| AC-3 | `T-U2` | ambos con valores distintos → `ConflictingMinReputationError`, `code: 'CONFLICTING_MIN_REPUTATION'` | "gana el camelCase" |
| AC-3 | `T-U3` | `('5', 5)` y `('5','5.0')` → `5`, sin lanzar | comparar los crudos en vez de los normalizados |
| AC-3 | `T-U4` | `('5', '')` → `5` (vacío = ausente, no conflicto) | tratar `''` como presente |
| AC-3 | `T-R28` | ruta: `?minReputation=1&min_reputation=5` → 400 sin fanout | — |
| AC-4 | `T-R29` | con el service devolviendo `excluded.standingUnavailable: true` y `agents: []`, **los dos nombres** producen la misma respuesta fail-closed | un alias que "ablande" el piso (p. ej. mandar `0` en vez del valor) |
| AC-5 | `T-R30` | **enumeración LITERAL** de los 10 parámetros, uno por uno, cada uno con valor válido → 200 | sacar una clave de la lista blanca |
| DT-8 | `T-R31` | `?capability=x&minReputation=abc` → 400 `UNKNOWN_DISCOVER_PARAM` (forma antes que valor) | invertir el orden |
| DT-9 | `T-R32` | `POST` body array → 400 `INVALID_DISCOVER_BODY`; `POST` body `{}` → 200 (pin de `discover.test.ts:203`) | guarda ausente |
| CD-2 | `T-U5` | `resolveMinReputation(undefined, 'abc')` lanza `InvalidMinReputationError` — **no** un error nuevo | validador duplicado para el alias |
| — | `T-U6` | el mensaje de `assertKnownDiscoverParams` contiene la clave ofensora **y** los literales `'capabilities'` y `'minReputation'` | mensaje genérico tipo "bad request" |
| borde | `T-R33` | `?minReputation=1&minReputation=1` (repetido ⇒ array) → 400 `INVALID_MIN_REPUTATION`, como hoy | aplanar arrays "para ser amable" |
| 🔴 §2.2 | **`T-R34`** | `POST { query: 'test' }` → **400 `UNKNOWN_DISCOVER_PARAM`**, y el mensaje **nombra `q`** | aliasar `query` "para no romper el e2e" |

**`T-R34` es el pin de regresión del hallazgo de §2.2.** Es el test que impide que
alguien, dentro de seis meses, vuelva a mandar el nombre interno del tipo y se entere
por un benchmark que miente.

### 7.2 Disciplina de mutación (obligatoria)

**Antes de declarar F3 terminado**, aplicá a mano cada mutante de la columna derecha y
verificá que **mata al menos un test nombrado**. Revertí después de cada uno.

Un mutante que sobrevive **es un test que no prueba lo que dice**. En este repo ya pasó
tres veces en una sola HU (auto-blindaje WKH-313). Dejá el registro en el reporte: mutante
→ test que murió.

### 7.3 🔴 `T-R30` — la trampa de la constante que se mide a sí misma (CD-10)

`T-R30` es el test peligroso. **Si lo escribís iterando `ALLOWED_DISCOVER_PARAMS`,
mide la constante contra sí misma**: agregar `pepito` a la lista haría que el test
**pase** y afirme que `pepito` es un parámetro público.

⇒ **`T-R30` enumera los 10 nombres a mano, escritos uno por uno**, tomados de dos fuentes
que **no** son la constante: `doc/INTEGRATION.md` y la firma de `request.query` /
`request.body` en `src/routes/discover.ts`.

Los tests **negativos** (`T-R26`, `T-R27`) sí pueden apoyarse en la constante: ahí el
sesgo va en la dirección segura.

> *"Tres copias de un razonamiento no son tres verificaciones."*

---

## 8. Anti-Hallucination Checklist — específico de esta HU

Antes de escribir código, confirmá cada punto. **Todos fueron verificados con Read/Grep
en este árbol; si alguno no coincide, PARÁ y avisá — significa que el árbol cambió.**

- [ ] `src/lib/discovery-query.ts` tiene **153 líneas** y exporta exactamente:
      `MIN_REPUTATION_FLOOR`, `MIN_REPUTATION_CEIL`, `InvalidMinReputationError`,
      `parseMinReputation`, `InvalidLimitError`, `parseLimit`,
      `InvalidAllowTrialError`, `parseAllowTrial`. **No importa nada de `services/`.**
- [ ] `parseMinReputation` está en `:44-57` y devuelve `undefined` para
      `undefined | null | ''` (`:45`). **No lo toques.**
- [ ] `parseFiltersOr400` está en `src/routes/discover.ts:25-55` y **no se exporta**.
      Call-sites: **exactamente 2** (`:153`, `:220`).
- [ ] El tipo `Querystring` del GET declara **9** claves (`:137-147`). El tipo `Body` del
      POST declara **las mismas 9** (`:190-200`).
- [ ] **Ninguna de las dos rutas raíz registra `schema:`.** Verificalo vos mismo antes de
      empezar.
- [ ] `src/index.ts:95-106` construye Fastify **sin opción `ajv`** ⇒ rigen los defaults
      con `removeAdditional: true` ⇒ **CD-5**.
- [ ] `ALLOWED_STEP_CONSTRAINTS` existe en `src/lib/compose-step-shape.ts:49-57` y el
      chequeo de clave desconocida está en `:176-185`. Es tu exemplar. **Leelo, no lo
      modifiques.**
- [ ] `src/routes/discover.minreputation.test.ts` llega hoy a **`T-R21`** (`:368`) y
      mockea `../services/discovery.js` en `:22-27`.
- [ ] `src/lib/discovery-query.test.ts` usa naming `T-V*` / `T-L*` / `T-AT*`.
- [ ] `DiscoveryQuery` está en `src/types/index.ts:449+` y su campo de texto libre se
      llama **`query`** (interno), mientras el parámetro público es **`q`**. Esa
      diferencia es la causa del hallazgo de §2.2.
- [ ] `src/routes/discover.ts:229` hace `query: body.q != null ? String(body.q) : undefined`.
- [ ] `doc/INTEGRATION.md:253-255` describe los filtros y **omite** `registry`, `limit`,
      `allowTrial`, `includeInactive`. La tabla de errores está en `:721-731`.
- [ ] `src/routes/discover.test.ts:203` tiene `payload: {}` → **200**. Ese es el pin que
      la guarda de body no puede romper.

**Si un path, una línea o una función que necesitás no está en esta lista: no la
inventes.** Grepeala. Si no existe, escribilo en el reporte y pará.

---

## 9. Riesgos declarados — con dueño

### R-1 — El 400 puede romper a un integrador externo

**Estado corregido en F2.5, y corregido otra vez en el fix-pack.** El SDD afirmaba radio
interno = 0; F2.5 dijo 4; **son 8 call-sites** (§2.2). Eso **sube**, no baja, la
probabilidad estimada del radio externo: si en este repo se escribió `query` ocho veces
sin que nadie lo notara — y hicieron falta tres pasadas para contarlas — un integrador
externo bien pudo hacer lo mismo.

**Mitigaciones asumidas de antemano, no descubiertas después:**

1. La lista blanca incluye **todo** lo que la ruta ya lee hoy, más el alias.
2. El mensaje del 400 nombra la clave ofensora **y** enumera las aceptadas ⇒ el arreglo
   del lado del caller es mecánico.
3. `doc/INTEGRATION.md` publica la lista canónica **en el mismo merge** (CD-8).
4. **No se toca `GET /discover/:slug`** (TD-322-1).

**Disparador de reversión — declarado ahora, no improvisado después:** si post-deploy
aparecen 400 `UNKNOWN_DISCOVER_PARAM` de un caller real, la respuesta **NO** es apagar el
guard. Es: (a) agregar el nombre a la lista si resulta ser contrato legítimo, o (b) avisar
al integrador si es un typo. Apagar el guard sería restaurar el silencio.

### R-2 — 🔴 El agente que entrega la plata queda fuera con cualquier piso ≥ 1

**Medido contra producción, no inferido:**

```
GET /discover?capabilities=remittance-payout
  -> 1 agente: remit-cashout-payout-solana
     registry=self-published  verified=false  reputation=null  computedReputation=null

GET /discover?capabilities=remittance-payout&minReputation=1
  -> total 0   excluded { reputation: 1, trialAvailable: 1, standingUnavailable: false }
```

**`remit-cashout-payout-solana` es el ÚNICO agente del catálogo con `remittance-payout`.**
No es "no está entre los 6": **es que no hay segundo candidato**. Con piso ≥ 1 el conjunto
es **CERO**, y `/compose` con `constraints: { min_reputation: 2 }` — la constante que usa
chaski-v3 — recibe `agents: []` y devuelve **422 `excluded_by_reputation`**. Si chaski
pasa a `a2a-gateway`, **la composición no encuentra a nadie**.

`standingUnavailable: false` ⇒ el gateway **sí pudo leer** el historial. No es el modo "no
pude preguntar": la exclusión es real y significa lo que parece.

> ⛔ **DUEÑO: el founder. NO ES TUYO, Y NO LO ARREGLES.** CD-1 prohíbe tocar el camino de
> `/compose`, y la salida existente (`allow_trial: true`, que lo admite por el carril de
> estreno de WKH-313 con `remaining_settled_tasks: 3`) es una **decisión de producto**, no
> de dev. Si te encontrás pensando "ya que estoy, le pongo `allowTrial` por default" →
> **STOP**: eso es relajar, por tu cuenta, un piso de riesgo que el caller pidió, sobre el
> camino del dinero. Es exactamente el defecto que este repo ya rechaza por escrito.

**Escribilo en el reporte final como riesgo abierto con dueño founder. No lo cierres.**

### R-3 — Esta HU hace VISIBLE a R-2

Un integrador que hoy investiga con `?min_reputation=2` ve **23** agentes — el catálogo
entero, porque el filtro que pidió no se aplica — y concluye que hay oferta de sobra.
Después de esta HU verá **5**, con `excluded.reputation: 18` explicando la diferencia.

> ⚠️ **Corrección del fix-pack (AR MNR-1), medida contra producción el 2026-08-04.** Este
> párrafo decía "verá **0**". Es falso: el `0` pertenece a OTRO caso, el de R-2
> (`?capabilities=remittance-payout&minReputation=1` → total 0). Sobre el catálogo entero
> con piso 2 el resultado es **5**. La afirmación de fondo de R-2/R-3 no cambia: el
> conjunto vacío con piso ≥1 sobre `remittance-payout` ya existe HOY por el nombre
> camelCase, y esta HU no rompe ningún camino que hoy funcione. Lo que cambia para un
> caller directo de `min_reputation` es que el filtro que pidió empieza a aplicarse:
> **23 → 5**. Eso es el fix, no una regresión.
>
> **El done-report NO debe republicar "23 → 0".**

**No mitigar. Un diagnóstico correcto no es una regresión.** Si en el AR alguien reporta
"la HU rompió discovery de payout", la respuesta es: discovery de payout ya estaba roto;
lo que cambió es que ahora lo dice.

### R-5 — Dos nombres para siempre

Deuda **TD-322-3**, decisión consciente. La convergencia real exigiría romper `/compose`,
verificado como inviable.

---

## 10. Lo que NO se renegocia

1. **Alias + 400 en el mismo merge.** Sin excepción. (§1)
2. **CD-5: nada de `schema` + `additionalProperties: false`.** (§4)
3. **`capabilities` en la lista; `capability` NO.** (W0.1)
4. **El mensaje del 400 nombra la clave mala y lista las buenas.** (W0.3)
5. **`parseMinReputation` es el único validador de rango, para los dos nombres.** (CD-2)
6. **GET y POST por el mismo helper; cada test con su gemelo POST.** (CD-6)
7. **`T-R30` enumera a mano.** (CD-10, §7.3)
8. **R-2 se declara, no se arregla.** (§9)
9. **La suite COMPLETA en verde, no sólo los archivos tocados.** (§6 W1)

---

## 11. Done Definition

- [ ] W0, W1 y W2 completas, **en la misma rama y el mismo merge** (CD-8).
- [ ] `npx tsc --noEmit` **limpio** sobre todo el proyecto.
- [ ] `npm test` **completo en verde** — incluido `src/__tests__/e2e/e2e.test.ts`.
- [ ] `npm run lint` en verde (`main` ya estuvo rojo por saltear esto: commit `34e1f2b`).
- [ ] `T-U1..T-U6` y `T-R22..T-R34` presentes, nombrados y verdes.
- [ ] **Todos** los mutantes de §7.1 corridos a mano y muertos, con el registro
      mutante → test en el reporte.
- [ ] Los 8 call-sites de `query` corregidos (§6 W1.6), y los tres `smoke-e2e-*.mjs` con
      su assert de status.
- [ ] `doc/INTEGRATION.md` con los 10 parámetros, el alias, la frase de convergencia y las
      3 filas nuevas de la tabla de errores.
- [ ] `git diff` **no toca**: `src/services/discovery.ts`, `src/services/capability-resolver.ts`,
      `src/routes/compose.ts`, `src/lib/compose-step-shape.ts`, `doc/sdd/_INDEX.md`.
- [ ] `git diff` **no toca** `GET /discover/:slug` (`src/routes/discover.ts:247-268`).
- [ ] Ningún comentario nuevo afirma una propiedad universal no falsable (CD-9).
- [ ] Reporte final con: R-2 declarado con dueño founder, la corrección de §2.2 sobre el
      radio de impacto, la nota de que los números de `perf-bench.mjs` no son comparables,
      y TD-322-1 / TD-322-2 / TD-322-3.

---

## 12. Bookkeeping — para `nexus-docs`, NO para el Dev

⛔ **No toques nada de esta sección.** Queda escrito acá para que no se pierda.

1. **`doc/sdd/217-.../_INDEX-row.md` quedó SIN PEGAR** en `doc/sdd/_INDEX.md` (el analyst
   no tuvo herramienta de edición).
2. **Y además está desactualizado**: dice *"in progress (F1 — esperando HU_APPROVED)"* y
   da DT-2 por pendiente. DT-2 **ya se cerró con git**, y son **TRES** filas viejas, no
   dos:

| Fila | `_INDEX.md` dice | git dice |
|---|---|---|
| `211` (WKH-313) | *"NO MERGEADO — pendiente orden de merge coordinado"* | mergeado (`1b322e2`) |
| `215` (WKH-318) | *"DONE (corte A)"* + no pusheado | mergeado (`6eb4f8a`, `ca9ffb8`) |
| `216` (WKH-319) | *"DONE (código, en worktree — pendiente merge/decisión del founder)"* | mergeado (`d34c961`, `d9bd2ef`) |

3. Son **tres casos nuevos** del patrón que el propio `_INDEX.md` ya documenta en su nota
   final: *"Un estado desactualizado acá hace planificar mal."* El F1 de esta misma HU
   estuvo a punto de repetirlo — su análisis de paralelismo recomienda *"resolver primero
   DT-2 antes de abrir esta rama"*, esperando un merge que ya había ocurrido.

---

## 13. Nota de convención

Las HUs previas nombran su story file `story-HU-NNN.md`
(`story-HU-313.md`, `story-HU-315.md`, `story-HU-318.md`). Este se llama
`story-WKH-322.md` porque así lo pidió el orquestador. **No es un error de tipeo**; si el
pipeline busca `story-HU-322.md`, este es el archivo.
