# Adversarial Review 2 (re-AR post fix-pack) — WKH-322

Rama `feat/217-wkh-322-discover-reputation-param-naming`, 9 commits sobre `main`
(4 de F3 + 4 del fix-pack + 1 de auto-blindaje). Mediciones en vivo del 2026-08-04
contra `wasiai-a2a-production.up.railway.app` y `app.wasiai.io`.
Mutación corrida en una copia fuera del repo; el arbol real quedo limpio
(`git status` identico antes y despues, rama sin cambiar, cero commits nuevos).

## VEREDICTO: RECHAZADO (2 BLOQUEANTEs activos, los dos `BLQ-MED`)

El fix-pack **arreglo bien lo que ataco**: los 3 asserts de smoke existen y funcionan,
los mutantes tienen firmas distintas y mueren donde el Dev dijo, el numero de `MNR-1`
quedo corregido en los tres lugares sin debilitar `R-2`/`R-3`, y `BLQ-ALTO-1` NO fue
"arreglado" por la ventana de atras.

Lo que sigue abierto es exactamente lo que el orquestador sospechaba: **la busqueda de
call-sites no cierra**. El numero crecio una cuarta vez: 4 -> 6 -> 8 -> **10**. Los dos
que faltan son `scripts/smoke-test.sh:229` (dentro del scope de grep que el propio
auto-blindaje declara canonico) y `mcp-servers/wasiai-x402/src/handlers.mjs:141`
(un directorio que ese scope no incluye).

---

## Parte 0 — `BLQ-ALTO-1`: verificacion de que NO se toco

Encargo explicito: no re-litigar la decision del founder, solo confirmar que el fix-pack
no la ejecuto por su cuenta. **Confirmado, las tres cosas**:

1. `src/lib/discovery-query.ts:202-213` — `ALLOWED_DISCOVER_PARAMS` tiene **exactamente
   las mismas 10 claves** que en el AR-1: `allowTrial, capabilities, includeInactive,
   limit, maxPrice, minReputation, min_reputation, q, registry, verified`. Ni `category`
   ni `cursor`.
2. **Cero banderas nuevas.** `git diff main..HEAD -- src/ scripts/ | grep '^+'` filtrado
   por `process.env|FEATURE_|FLAG` devuelve cero lineas. Los unicos hits de `category` en
   el diff son el nombre de un escenario de `perf-bench.mjs` y un comentario.
3. **`wasiai-v2` intacto.** `git diff --name-only main..HEAD` son 19 archivos, todos de
   este repo. El checkout de v2 (`/home/ferdev/.openclaw/workspace/wasiai-v2`) no aparece
   ni podria: es otro repo.

Medicion colateral que **refuerza** la base de la decision del founder y que no estaba en
el AR-1 — el mecanismo de passthrough de v2 esta probado, no inferido:

```
GET app.wasiai.io/api/v1/capabilities?q=oracle        -> 200, 1 agente (wasi-chainlink-price)
GET app.wasiai.io/api/v1/capabilities?q=BASURA_TOTAL  -> 200, 0 agentes
GET app.wasiai.io/api/v1/capabilities?pepito=1        -> 200, 23 agentes (sin efecto)
GET app.wasiai.io/api/v1/capabilities?query=oracle    -> 200, 23 agentes (sin efecto)
```

`q` no esta en `translateParamsForA2A` (v2 `capabilities/route.ts:61-74`) y **igual filtra**:
prueba directa de que `appendSearchParams` (`forward-handler.ts:156-160`) reenvia claves
arbitrarias verbatim a a2a `/discover`. Ese mismo mecanismo es el que hace que `query`
llegue al guard — ver `BLQ-MED-2`.

---

## Parte 1 — Cierre de la busqueda de call-sites

### Estrategia (por que cubre la clase entera)

No confie en la lista del Story File, ni en la mia del AR-1, ni en la del fix-pack.
Reencuadre el radio: **el guard no rechaza la clave `query`, rechaza TODA clave fuera de
la allowlist**. Buscar "call-sites de `query`" es buscar un sintoma; el radio real es
"todo par clave/valor que viaja hacia `/discover`". Tres barridos independientes que se
cruzan:

**(A) Universo por la CLAVE.** `grep -rnE '("|'"'"')?query("|'"'"')?[[:space:]]*:'` sobre
**todo el repo** (`--exclude-dir` solo `node_modules`, `dist`, `coverage`, `contracts`,
`.git`), incluyendo `*.sh`, `*.md`, `*.yml`, `*.json`, `*.py`. **168 hits**, agrupados por
archivo y cruzados a mano uno por uno.

**(B) Destino por la RUTA.** `grep -rnoE '/discover\?[^"'"'"'\` )]*'` — enumera **todos**
los query strings literales del repo (95 distintos), mas `grep -rn '/discover'` y
`grep -rn '/api/v1/capabilities'` para los POST. Verifique la **clave**, no solo la
presencia: cada query string contra las 10 de la allowlist.

**(C) Construccion dinamica.** `grep -rn 'searchParams.set|searchParams.append|URLSearchParams('`
sobre `src/ scripts/ packages/ mcp-servers/src`, y busqueda de spread (`...`) en un radio de
+/-3 lineas de cada `fetch`/`http.post` hacia `/discover`. Unico hit dinamico:
`src/services/discovery.ts:1054-1078`, que es **saliente** (a2a -> registro federado,
claves desde `schema.queryParam`), no entrante. Descartado con evidencia.

Lo que agrega esta estrategia respecto de la del auto-blindaje (`scripts/ src/ packages/`):
**`mcp-servers/`, `docs/`, `doc/`, `.github/` y la raiz**. El scope de tres directorios es
la falla estructural: `mcp-servers/wasiai-x402/` es un cliente HTTP publicado de este mismo
repo y esta fuera de los tres.

### Verificacion del descarte que el Dev ya hizo (no asumido)

Los hits de `JSON.stringify({ query: sql })` **son 12 y el descarte es CORRECTO**. Los
verifique uno por uno leyendo el destino de cada `fetch`:

| Archivo:linea | Destino | Veredicto |
|---|---|---|
| `scripts/apply-rce-migration.mjs:63` | `api.supabase.com/v1/projects/*/database/query` | descartado OK |
| `scripts/apply-security-rpc-migration.mjs:40` | idem | descartado OK |
| `scripts/apply-registries-owner-ref-migration.mjs:61` | idem | descartado OK |
| `scripts/apply-hu198-migration.mjs:139` | idem | descartado OK |
| `scripts/apply-hu202-migration.mjs:139` | idem | descartado OK |
| `scripts/apply-schema-hash-migration.mjs:60` | idem | descartado OK |
| `scripts/apply-wkh307-migration.mjs:150` | idem | descartado OK |
| `scripts/exercise-wkh307-functions.mjs:136` | idem | descartado OK |
| `scripts/hackathon-e2e.mjs:375` | idem (`sbApi`, `:365`) | descartado OK |
| `scripts/apply-prod-migrations.sh:33,68` | idem | descartado OK |
| `scripts/cleanup-wkh-35-prod-testkey.sh:23` | idem | descartado OK |
| `scripts/apply-wkh-35-prod.sh:25` | idem | descartado OK |
| `scripts/activate-mainnet-downstream.sh:48` | `backboard.railway.app` GraphQL (`"query": "mutation(...)"`) | descartado OK (el Dev no lo listo) |
| `scripts/switch-railway-to-prod-db.sh:40` | idem GraphQL | descartado OK (el Dev no lo listo) |

Descartes adicionales verificados, **no** call-sites de `/discover`:
`src/mcp/tools/discover-agents.ts:34` y `src/mcp/router.ts:288` llaman
`discoveryService.discover()` **in-process** (el guard vive en la ruta, no en el service);
`docs/mcp-integration.md:195,216,337` documenta **esa** tool MCP, cuyo campo `query` sigue
siendo correcto. `src/services/discovery.ts:325` es una linea de log.
`packages/agent-sdk/src/agent.ts:497-506` construye el body con una whitelist explicita
(`q, capabilities, maxPrice, minReputation, limit, registry, verified`) — las 7 estan en la
allowlist. `scripts/smoke-agentkey-compose.mjs:104` es un `input` de step de `/compose`.

### Inventario completo — los 10

| # | Archivo:linea | Que manda | Estado |
|---|---|---|---|
| 1 | `src/__tests__/e2e/e2e.test.ts:278` | `{ q: 'test' }` | **corregido** |
| 2 | `scripts/perf-bench.mjs:11` | `{ q: '', limit: 10 }` | **corregido** |
| 3 | `scripts/perf-bench.mjs:12` | `{ q: 'price', limit: 5 }` | **corregido** |
| 4 | `scripts/k6-load-test.js:127` | `{ capabilities, q, limit }` | **corregido** |
| 5 | `scripts/k6-deep-test.js:360` | `body.q = query.q` | **corregido** |
| 6 | `scripts/smoke-e2e-comprehensive.mjs:144` | `{ q: '', limit: 50 }` + assert | **corregido** |
| 7 | `scripts/smoke-e2e-cross-chain.mjs:127` | `{ q: '', limit: 50 }` + assert | **corregido** |
| 8 | `scripts/smoke-e2e-final.mjs:147` | `{ q: '', limit: 50 }` + assert | **corregido** |
| **9** | `scripts/smoke-test.sh:229` | `-d '{"query": "test"}'` | **ABIERTO -> `BLQ-MED-1`** |
| **10** | `mcp-servers/wasiai-x402/src/handlers.mjs:141` | `?query=<texto libre>` | **ABIERTO -> `BLQ-MED-2`** |

Verificados y **sin claves fuera de la allowlist** (no son call-sites rotos):
`scripts/doctor-chaos.js:85` (`{capabilities, limit}`), `:181`, `:198` (`?q=&limit=`),
`scripts/doctor-dast.js:39,81,126`, `scripts/doctor-security.sh:94` (`?q=`),
`scripts/doctor-uptime.sh:11` (`?limit=1`), `scripts/smoke-base-downstream.mjs:116`,
`scripts/smoke-downstream-x402.mjs:152,384`, `scripts/smoke-capabilities-schema.mjs:59`,
`scripts/report-stranded-exposure.mjs:80`, `scripts/hackathon-e2e.mjs:112` (`{limit:5}`),
`scripts/k6-deep-test.js:174,180,209,214,248,340,391`, `scripts/k6-load-test.js:121,163,184`,
`packages/agent-sdk/src/agent.ts:508`, `README.md:41,44`, `docs/api-reference.md:106`,
`doc/QUICKSTART-PUBLISH.md:68`, `doc/INTEGRATION.md:126,1038,1080`.
**Cero call-sites en `.github/workflows/`** (CI corre `npm test` y `npm run smoke:downstream`,
que es `smoke-downstream-x402.mjs`, ya OK).

---

## `BLQ-MED-1` — Integration / Test Coverage · el noveno call-site esta dentro del grep que el propio auto-blindaje declara canonico

**Archivo:linea**: `scripts/smoke-test.sh:227-237`

```sh
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/discover" \
  -H "Content-Type: application/json" \
  -d '{"query": "test"}')          # <- linea 229
...
if [ "$HTTP_CODE" = "200" ]; then
  report "POST /discover" "PASS" "$HTTP_CODE"
else
  report "POST /discover" "FAIL" "$HTTP_CODE" "expected 200"
fi
```

**Descripcion.** Es la clave `query` cruda hacia `POST /discover`. Post-merge devuelve
400 `UNKNOWN_DISCOVER_PARAM` y el smoke reporta **FAIL** sobre un deploy correcto.

Lo grave no es el FAIL (es ruidoso, que es lo bueno): es **donde estaba**. El
auto-blindaje (`auto-blindaje.md:86-89`) escribe el grep que "encuentra los 8":

```
grep -rnE "(\"|')?query(\"|')?\s*:" scripts/ src/ packages/
```

Ese regex **matchea** `-d '{"query": "test"}'` y `scripts/` **esta** en el scope. O sea que
el grep correcto se corrio y el paso de cruce a mano se abandono igual — que es
literalmente el modo de falla que la entrada de auto-blindaje diagnostica ("un grep ruidoso
se abandona"). La leccion quedo escrita y no se aplico en la misma sesion que la escribio.

**Reproduccion.**
```
Hoy:        curl -X POST https://wasiai-a2a-production.up.railway.app/discover \
              -H 'Content-Type: application/json' -d '{"query":"test"}'   -> 200
Post-merge: mismo comando -> 400 {"code":"UNKNOWN_DISCOVER_PARAM"}
Efecto:     bash scripts/smoke-test.sh -> "POST /discover  FAIL  400  expected 200"
```
Verificado a nivel unidad sobre la rama: `T-R34` (`discover.minreputation.test.ts:866`)
afirma exactamente ese 400 para `{ query: 'test' }`.

**Impacto.** El smoke manual de aceptacion queda rojo permanente sobre una release sana.
Un smoke que grita "roto" cuando esta bien se desactiva a la tercera vez, y despues no
avisa cuando algo se rompe de verdad. No esta en CI (`package.json:7-17` y
`.github/workflows/` no lo referencian), mismo estatus que los 8 ya corregidos.

**Sugerencia.** `{"query": "test"}` -> `{"q": "test"}`, y corregir el "8" del Story File
(§2.2 y Done Definition `story-WKH-322.md:851`) a **10**. Y, mas util que el numero:
que la Done Definition pida el **inventario con los descartados**, no un conteo — un numero
cerrado invita a releerlo, una lista con descartes invita a verificarlo.

---

## `BLQ-MED-2` — Integration · el decimo call-site es una tool MCP publicada de este repo, y devuelve el 400 como si fuera un resultado

**Archivo:linea**: `mcp-servers/wasiai-x402/src/handlers.mjs:140-141` y `:173-180`

```js
const url = new URL('/api/v1/capabilities', cfg.gatewayUrl);
if (input.query) url.searchParams.set('query', input.query);   // <- 141
...
let body;
try { body = await res.json(); } catch { body = {}; }
// AC-1: return body unchanged.
return body;                                                    // <- 180, SIN mirar res.status
```

**Descripcion — la cadena completa, cada eslabon medido**:

1. `WASIAI_GATEWAY_URL` default `https://app.wasiai.io` (`mcp-servers/wasiai-x402/README.md:110`).
2. La tool manda `?query=<texto>` a `GET /api/v1/capabilities` de **wasiai-v2**.
3. v2 delega a a2a `/discover` (`capabilities/route.ts:84-87`) y `appendSearchParams`
   (`forward-handler.ts:156-160`) copia **cada** clave. `translateParamsForA2A` solo renombra
   `tag`/`max_price`/`min_reputation` — `query` viaja tal cual.
   **Probado en vivo, no inferido**: `?q=oracle` -> 1 agente y `?q=BASURA_TOTAL` -> 0, con `q`
   fuera de la tabla de renombres. Si `q` llega, `query` llega.
4. Post-merge a2a contesta 400. `forward-handler.ts:129-132` solo trata especial 402 y >=500,
   asi que el 400 vuelve tal cual al MCP server.
5. `discoverAgentsHandler` **no mira el status** y devuelve el body: el agente MCP recibe
   `{error: "unknown parameter 'query'...", code: "UNKNOWN_DISCOVER_PARAM"}` en el lugar
   donde esperaba `{agents: [...]}`.

Esto es el pecado original de `BLQ-MED-2` del AR-1 (el smoke mudo) reproducido una capa mas
afuera: el fix-pack agrego el assert de status en los tres `smoke-e2e-*.mjs` y dejo sin
assert al cliente HTTP **publicado** del mismo repo.

**Reproduccion.**
```
Hoy (medido 2026-08-04):
  GET https://app.wasiai.io/api/v1/capabilities?query=oracle  -> 200, 23 agentes
  (el filtro no se aplica: identico a ?query=BASURA_TOTAL y a la llamada sin params)

Post-merge:
  mismo GET -> 400 UNKNOWN_DISCOVER_PARAM
  => discover_agents({query:"AVAX"}) devuelve el objeto de error, CERO agentes,
     y el handler lo entrega como si fuera la respuesta buena.
```
El contrato de la tool esta publicado en `mcp-servers/wasiai-x402/README.md:14` y `:120`
(`invoke discover_agents({query:"AVAX"})`) y su schema en `handlers.mjs:585`.

**Impacto.** Un agente LLM que llame `discover_agents` con `query` pasa de "23 agentes sin
filtrar" (200 impreciso) a "cero agentes y un objeto de error que parece un resultado".
Hoy la tool sirve para descubrir; post-merge, con ese argumento, no sirve y **no lo dice**.

**Nota de encuadre**: este NO es el `BLQ-ALTO-1` que el founder decidio aceptar. Esa decision
enumera `category` y `cursor`, params de la doc publica de **v2**, con dueño en otro repo.
Este es un tercer parametro muerto cuyo caller vive **en este repo**, en el Scope IN de facto
del fix-pack ("los call-sites de `query`"), y se arregla con una linea aca adentro.

**Sugerencia.** `url.searchParams.set('query', ...)` -> `'q'` (medido: `q` atraviesa v2 y
filtra de verdad, o sea que el fix ademas **repara** un filtro que nunca funciono).
Y, aparte: `discoverAgentsHandler` deberia chequear `res.status` antes de devolver el body —
es la misma regla mecanica que el auto-blindaje acaba de escribir para los smokes.

---

## Lo que ataque y esta BIEN (con evidencia, para que no se relea)

### 1. El assert de los tres smokes — **OK**

- Presente en los tres: `smoke-e2e-comprehensive.mjs:148-152`, `smoke-e2e-cross-chain.mjs:132-137`,
  `smoke-e2e-final.mjs:150-155`. Los tres: `if (res.status !== 200) { console.error(...); process.exit(1) }`.
- **Busque una rama de exit 0 tras un 400 y no existe.** Reproduje el patron exacto contra un
  stub local que contesta 400: con cuerpo JSON, `exit=1` por el assert; con cuerpo **no JSON**
  (un `text/html` de un proxy), `await res.json()` tira y Node 22 sale igualmente con `exit=1`
  por unhandled rejection. Las dos ramas medidas.
- Cada smoke tiene **un solo** call-site a `/discover`; no hay una segunda llamada sin cubrir.
- Unico pero, y es cosmetico -> `MNR-2`.

### 2. Mutacion propia — **OK**, las firmas son las que el Dev declaro

Copia del repo fuera del arbol real, `node_modules` por symlink. Baseline
`discovery-query.test.ts` + `discover.minreputation.test.ts`: **106 PASS / 0 FAIL**.
Suite completa del proyecto: **4982 PASS / 0 FAIL**. `npx tsc -p tsconfig.json --noEmit`: limpio.

| Mutante | Tests que mata | Esperado por el Dev | Veredicto |
|---|---|---|---|
| `toDiscoverParamBag`: `typeof raw !== 'object' \|\| Array.isArray(raw)` -> `Array.isArray(raw)` | **solo `T-R32c`** | el CR pedia exactamente esto | **KILLED, y solo por el test nuevo** |
| `describeReceivedParamName` sin truncar | `T-U9`, `T-U9b`, `T-R35`, `T-R35b` | identico (`auto-blindaje.md:130`) | **KILLED, firma exacta** |
| truncar en silencio (sin la anotacion) | `T-U9b`, `T-R35`, `T-R35b` | identico | **KILLED, firma DISTINTA de la anterior** |
| `MAX_ECHOED_PARAM_NAME_LENGTH` 64 -> 65 | solo `T-U9` | — | KILLED (la cota esta pineada al valor, no derivada) |
| `MAX_ECHOED_PARAM_NAME_LENGTH` 64 -> 10 | `T-U9`, `T-U10` | — | KILLED (`T-U10` no es decorativo: canda el borde) |
| `Object.keys(raw).find` -> `.reverse().find` | solo `T-U8` | — | KILLED (`T-U8` no es vacuo) |
| sacar `'registry'` de la allowlist | `T-R30`, `T-R30b` | — | KILLED |
| sacar `'min_reputation'` de la allowlist | 12 tests | — | KILLED |
| el mensaje deja de enumerar las aceptadas | `T-U6`, `T-R26`, `T-R26b`, `T-R34` | — | KILLED |
| `resolveMinReputation` sin chequeo de conflicto | `T-U2`, `T-R28`, `T-R28b` | — | KILLED |

La particion `T-U9` / `T-U9b` **se confirma**: los dos mutantes del truncado tienen firmas
distintas. La afirmacion del auto-blindaje es literalmente cierta.

**Patron inverso (test que suma verde y no puede ponerse rojo solo): busque y encontre uno,
y esta declarado.** Agregar `'pepito'` a `ALLOWED_DISCOVER_PARAMS` mata **cero** tests
(106/106 verdes). Pero eso esta escrito, con su razon y su modo de falla, en
`discovery-query.ts:171-178` ("Ningun test lo caza: `T-R30` enumera a mano a proposito
(CD-10)"), es exactamente `CR MNR-3`, y el fix-pack documento por que no metio el `satisfies`
(`auto-blindaje.md:150-154`). **No lo cuento como finding**: es deuda conocida con dueño, no
un descuido. Lo dejo medido para que la proxima HU sepa el costo exacto de la decision.

### 3. La correccion del `23 -> 5` — **OK, y re-medida por mi**

Medicion propia contra `wasiai-a2a-production.up.railway.app`, 2026-08-04:

```
/discover                                          -> total 23, excluded.reputation 0
/discover?min_reputation=2                         -> total 23, excluded.reputation 0   (el bug)
/discover?minReputation=2                          -> total  5, excluded.reputation 18  (el fix)
/discover?capabilities=remittance-payout           -> total  1
/discover?capabilities=remittance-payout&minReputation=1 -> total 0, excluded.reputation 1
```

`23 -> 5` con `excluded.reputation: 18` **confirmado de forma independiente**, y el `0`
pertenece efectivamente al caso `remittance-payout`.

Corregido en **los tres** lugares donde vivia, con la correccion fechada y firmada:
`sdd.md:155-162`, `sdd.md:572` (fila R-3 del registro de riesgos) y
`story-WKH-322.md:802-815`. Este ultimo agrega ademas
*"El done-report NO debe republicar 23 -> 0"*, que es la instruccion accionable.

**La afirmacion de fondo de R-2/R-3 NO se debilito**: los tres bloques conservan
"esta HU no rompe ningun camino que hoy funcione" y "un diagnostico correcto no es una
regresion", y `story-WKH-322.md:818-820` mantiene el guion anti-relajacion
("discovery de payout ya estaba roto; lo que cambio es que ahora lo dice"). La correccion
del numero **fortalece** el argumento: `23 -> 5` es un filtro que empieza a filtrar,
mientras que `23 -> 0` sonaba a apagon.

### 4. Scope drift — **OK**

19 archivos, cero fuera de lo justificado:
7 artefactos SDD (`CR MNR-4`, trackeo), `doc/INTEGRATION.md` (W2), 4 de `src/` (los declarados),
6 de `scripts/` (los 6 que §2.2 del Story File incorpora al scope con su razon escrita).
**No** aparecen `src/services/discovery.ts`, `capability-resolver.ts`, `compose.ts`,
`compose-step-shape.ts` (CD-1 respetado) ni `doc/sdd/_INDEX.md`.

---

## MENORes

### `MNR-1` — Prosa · el JSDoc de la cota promete resolver un log que nadie escribe

`src/lib/discovery-query.ts:222-223` (y el mismo texto replicado en el comentario de `T-U9`,
`discovery-query.test.ts` y en `story`/`auto-blindaje`):

> *"...amplificacion ~1x hacia la respuesta y, sobre todo, **una linea de log del tamaño del
> ataque por cada request**."*

**Es falso en las dos direcciones, y cada mitad es falsable con un input concreto**:

- **POST**: nada loguea el body ni el `message` del error. `parseFiltersOr400`
  (`routes/discover.ts:89-102`) hace `reply.status(400).send()` sin log; un `reply.send()` no
  dispara `setErrorHandler` (`middleware/error-boundary.ts:72`); `event-tracking.ts:117`
  persiste `endpoint: url.split('?')[0]`, o sea **sin query string**; los serializers de Fastify
  loguean `statusCode`, no el cuerpo. La linea de log grande **no existia** antes del fix, asi
  que la cota no la puede haber eliminado.
- **GET**: el logger de Fastify (`src/index.ts:95-97`, `logger: { redact: REDACT_PATHS }`, sin
  serializers custom) **si** loguea `req.url` completo, con el nombre gigante adentro. Ahi la
  linea de log grande existe y **la cota no la toca** — es el request, no la respuesta.

Repro: `GET /discover?<5000 chars>=1` -> la linea `incoming request` del log trae los 5000
caracteres, con cota o sin cota. `POST /discover` con una clave de 100 KB -> ninguna linea de
log crece, con cota o sin cota.

**Impacto**: es el patron que este proyecto arrastra en tres HUs seguidas. Una frase que
promete una propiedad hace que nadie vuelva a mirar ahi; la proxima persona que se pregunte
"¿estamos logueando input sin acotar?" lee este JSDoc y concluye que ya esta resuelto — y en
GET no lo esta. La cota SI cumple la mitad verdadera (el cuerpo del 400, `T-R35`/`T-R35b`).

**Sugerencia**: dejar solo la mitad medible ("el cuerpo del 400 crecia con el input"), y si el
log del GET importa, que sea una deuda con nombre — no una frase que la de por cerrada.

### `MNR-2` — Error Handling · el codigo lee el body ANTES del status, contra la regla que el propio fix-pack escribio

`auto-blindaje.md:117-118` fija la regla mecanica: *"el status se chequea **ANTES** de leer el
body, y el `?? []` va despues del chequeo, nunca en su lugar"*. Los tres smokes hacen lo
contrario:

```js
const disc = await discRes.json();      // smoke-e2e-final.mjs:149  <- el body primero
if (discRes.status !== 200) { ... }     // :150                     <- el status despues
```

Medido: con un 400 `application/json` no cambia nada (`exit=1` por el assert). Con un 400 de
cuerpo no-JSON (un `text/html` de un edge proxy) `await .json()` tira antes y el operador ve un
stack de `SyntaxError` en vez de `POST /discover devolvio HTTP 400`. **El exit code sigue siendo
1 en los dos casos**, por eso es MENOR y no bloqueante: el smoke no miente, solo diagnostica peor.

**Sugerencia**: mover el `.json()` debajo del `if`, o leer `.text()` y parsear despues. Y si la
regla del auto-blindaje se deja como esta, que el codigo la cumpla — una regla escrita que el
mismo commit desobedece se lee despues como cumplida.

### `MNR-3` — Prosa · el comentario de `T-R34` sigue diciendo "Cuatro call-sites"

`src/routes/discover.minreputation.test.ts:868-869`:

> *"`query` es el nombre INTERNO ... **Cuatro call-sites de este repo** lo escribieron mal y
> nadie se entero en meses"*

El comentario entro en W1 (`0592312`) y el commit del recuento (`45843e8`, *"eran OCHO, no
cuatro"*) toco `sdd.md`, `story-WKH-322.md` y 4 scripts — **no** este archivo. Verificado con
`git log main..HEAD -- src/routes/discover.minreputation.test.ts`: los commits que lo tocan son
`0592312`, `d24bcea` y `eaa34a7`, ninguno el del recuento.

**Impacto**: el numero desmentido sobrevive en el unico lugar que un dev futuro lee al tocar el
test. Y son 10, no 4 ni 8. Mismo caso, mas chico, que `MNR-1` del AR-1.

**Sugerencia**: sacar el numero del comentario. La frase funciona igual sin el ("varios
call-sites de este repo lo escribieron mal"), y un conteo dentro de un comentario de test es
deuda garantizada: nada lo obliga a envejecer bien.

### `MNR-4` — Type Safety · `slice(0, 64)` parte pares suplentes, y "characters" son unidades UTF-16

`src/lib/discovery-query.ts:249-251`.

- Un nombre cuyo caracter 64 es un emoji (par suplente) se corta al medio y el eco queda con un
  suplente alto suelto. Medido: `'a'.repeat(63) + '😀' + ...` -> `slice(0,64)` termina en
  `\ud83d`, `isWellFormed() === false`. **No rompe nada**: `JSON.stringify` lo escapa como
  `"\ud83d"` (JSON valido desde ES2019), Fastify serializa bien y el caller recibe un 400
  legible. Es cosmetico.
- `name.length` cuenta **unidades UTF-16**, no caracteres. Medido: 40 emojis -> `length === 80`.
  El mensaje dice *"the name sent was 80 characters long"* y `doc/INTEGRATION.md:296-299`
  publica *"the length you sent"*. Para un nombre con astrales el numero esta al doble.

**Impacto**: bajisimo (ningun nombre de parametro legitimo tiene astrales). Lo listo porque el
proposito declarado del anuncio es que el caller distinga "me lo recortaron" de "el server cree
que mi parametro se llama asi" — y un largo al doble erosiona justo esa distincion.

**Sugerencia**: `[...name].length` / `Intl.Segmenter` si se quiere el numero exacto, o cambiar
la palabra a "code units". Cualquiera de las dos, no las dos.

---

## Las 11 categorias

| # | Categoria | Veredicto |
|---|---|---|
| 1 | **Security** | **OK**. `MNR-4` del AR-1 (eco sin cota) esta **cerrado y verificado por mutacion**: cota 64 + anotacion, con 4 tests que la pinan. Sin superficie de authz nueva. Efecto colateral positivo no declarado: `{"__proto__": {...}}` y `{"constructor": ...}` ahora dan 400 en vez de llegar como claves del bag. El unico residuo es prosa (`MNR-1`) y cosmetica (`MNR-4`) |
| 2 | **Error Handling** | **MNR-2**. La cadena `instanceof` de `parseFiltersOr400` (`discover.ts:89-102`) cubre las 6 clases y re-lanza lo desconocido (una clase nueva sin `instanceof` da 500, no un 200 silencioso). Los 3 asserts de smoke funcionan en las dos ramas que probe. El orden body/status es el unico pero |
| 3 | **Data Integrity** | **N/A**. La HU no escribe, no abre transacciones, no toca concurrencia ni idempotencia — es validacion de input de lectura |
| 4 | **Performance** | **OK**. El guard es lo primero del handler en los dos verbos (`discover.ts:214`, `:265`): un 400 cuesta cero fetch upstream y cero DB. Mejora respecto de `main`, donde un body de 1 MiB con claves basura disparaba el fanout completo. Sigue en pie lo del AR-1: `event-tracking` va a marcar un escalon de `status:'failed'` en el panel de `/discover` |
| 5 | **Integration** | **BLQ-MED-1**, **BLQ-MED-2**. `BLQ-ALTO-1` sigue abierto por decision del founder (opcion A, 2026-08-04): verificado que el fix-pack no lo toco |
| 6 | **Type Safety** | **MNR-4**. Cero `any` nuevo. `tsc --noEmit` limpio sobre el proyecto entero. El unico cast (`raw as Record<string, unknown>`, `discover.ts:38`) esta detras de `null`/`undefined`/`typeof`/`Array.isArray`, y la mitad primitivo la cubre ahora `T-R32c` (mutante verificado). `NaN` no propaga (`Number.isFinite`, `discovery-query.ts:50`) |
| 7 | **Test Coverage** | **OK**. 106 tests en los dos archivos de la HU, 4982 en la suite completa, todos verdes. 10 mutantes propios: 10 muertos con la firma esperada. Los tests nuevos del fix-pack (`T-U9`, `T-U9b`, `T-U10`, `T-R32c`) tienen todos un mutante que los mata; ninguno es verde decorativo. El unico sobreviviente (agregar una clave a la allowlist) esta declarado como `CR MNR-3` con dueño |
| 8 | **Scope Drift** | **OK**. 19 archivos, todos dentro del Scope IN o de la ampliacion justificada de §2.2. CD-1 respetado |
| 9 | **Destructive Migrations** | **N/A**. Cero SQL en el diff; `supabase/migrations/` sin tocar |
| 10 | **RPC `SECURITY DEFINER`** | **N/A**. La HU no crea ni modifica funciones Postgres |
| 11 | **Cache Invalidation** | **N/A**. No se introduce ninguna capa de cache. `/discover` sigue consultando en vivo, sin TTL ni memoizacion nueva |

---

## Fix-pack sugerido, en orden

1. **`BLQ-MED-2`** — `mcp-servers/wasiai-x402/src/handlers.mjs:141` (`query` -> `q`). Primero
   porque es el unico que rompe una superficie **publicada** y consumida por terceros, y porque
   el fix ademas repara un filtro que nunca funciono. Conviene, en el mismo toque, el chequeo de
   `res.status` en `discoverAgentsHandler` (`:173-180`).
2. **`BLQ-MED-1`** — `scripts/smoke-test.sh:229` (`{"query"` -> `{"q"`).
3. Corregir el conteo a **10** donde se afirme cerrado: `story-WKH-322.md` §2.2 (tabla + prosa
   "ocho") y Done Definition `:851`. Y considerar reemplazar el conteo por el inventario con
   descartes — el numero ya fallo cuatro veces.
4. `MNR-1` (la frase del log), `MNR-3` (el "Cuatro" del comentario) — las dos son una linea, y
   son la clase de hallazgo que este proyecto viene arrastrando en tres HUs seguidas.
5. `MNR-2`, `MNR-4` — al criterio del orquestador.

Riesgo abierto que **no** se cierra aca: **R-2**, dueño founder. Re-confirmado por medicion
propia hoy (`remittance-payout` tiene un solo agente y con piso >=1 el conjunto queda vacio).

---

*Arbol de trabajo verificado limpio al cerrar: `git status --short` identico al del inicio,
rama `feat/217-wkh-322-discover-reputation-param-naming` sin cambios, sin commits nuevos.
La mutacion corrio en una copia en el scratchpad de sesion, con `node_modules` por symlink.*
