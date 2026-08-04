# Adversarial Review — WKH-322

Rama `feat/217-wkh-322-discover-reputation-param-naming` (4 commits sobre `main`).
Mediciones contra producción del 2026-08-04.

**Persistido por el orquestador**: el agente de AR no tenía herramienta de escritura por
política de salida. Entregó el reporte en su mensaje; este archivo es esa entrega.

## VEREDICTO: RECHAZADO (2 BLOQUEANTEs activos)

---

## `BLQ-ALTO-1` — Integration · el 400 alcanza la puerta de entrada pública del marketplace

`wasiai-v2` `GET /api/v1/capabilities` está **delegado a a2a `/discover` en prod** y
reenvía **todos** los query params sin filtrar, renombrando sólo tres.

Evidencia:
- `wasiai-v2/src/app/api/v1/capabilities/route.ts:61-74` — `translateParamsForA2A` renombra
  únicamente `tag`→`capabilities`, `max_price`→`maxPrice`, `min_reputation`→`minReputation`.
  **`category` y `cursor` no se tocan.**
- `wasiai-v2/src/app/api/v1/capabilities/route.ts:84-87` — forward a `${WASIAI_A2A_BASE_URL}/discover`.
- `wasiai-v2/src/lib/proxy/forward-handler.ts:156-160` — `appendSearchParams` copia **cada**
  param: `sp.forEach((v,k) => u.searchParams.set(k,v))`.
- `wasiai-v2/src/lib/proxy/forward-handler.ts:129-132` — sólo 402 y ≥500 tienen tratamiento
  especial; **el 400 upstream se devuelve tal cual al cliente público**.
- `wasiai-v2/src/features/docs/content/discovery.tsx:14,17,52,56` — la página de docs pública
  publica los curl `.../api/v1/capabilities?category=defi&max_price=0.01` y
  `.../api/v1/capabilities?limit=5&cursor=<next_cursor>`, y documenta `category` y `cursor`
  en la tabla de query params.
- `wasiai-a2a/src/lib/discovery-query.ts:187-198` — ni `category` ni `cursor` están en
  `ALLOWED_DISCOVER_PARAMS`; `:283-288` lanza.

Reproducción (medida en vivo):

```
curl "https://app.wasiai.io/api/v1/capabilities?category=defi&max_price=0.01"   -> 200
curl "https://app.wasiai.io/api/v1/capabilities?limit=5&cursor=eyJhIjoxfQ=="    -> 200
```

Post-merge, esos dos comandos devuelven **400 `UNKNOWN_DISCOVER_PARAM`**. Verificado a nivel
unidad sobre la rama (`npx tsx`, import directo de `src/lib/discovery-query.ts`):

```
assertKnownDiscoverParams({category:'defi'}) => THROW UnknownDiscoverParamError
assertKnownDiscoverParams({cursor:'x'})      => THROW UnknownDiscoverParamError
```

Secundario del mismo mecanismo: el guard `!searchParams.has(a2aName)` (`route.ts:69`) deja
pasar los **dos** nombres cuando el caller manda `minReputation` y `min_reputation` juntos.
Medido: `?tag=oracle&minReputation=50&min_reputation=0.5` → **200**. Post-merge → **400
`CONFLICTING_MIN_REPUTATION`**.

La suite de a2a no puede cazarlo porque el caller vive en otro repo. §2.1 del Story File dice
*"Ningún ejemplo publicado quedaría rechazado"*: es cierto para `doc/INTEGRATION.md` y falso
para la documentación publicada del ecosistema.

Salidas posibles (decisión de contrato, no de código): (a) `category`/`cursor` entran a
`ALLOWED_DISCOVER_PARAMS` como parámetros de primera o como no-ops explícitos, (b) el proxy de
v2 consume/descarta los params que son suyos antes de reenviar — cambio en v2, en la misma
ventana, (c) el guard sale detrás de una bandera hasta que v2 esté alineado.

### ⚠️ Medición del orquestador que acota el impacto (2026-08-04, en vivo)

Los dos parámetros **hoy no hacen nada**. Sonda discriminante contra `app.wasiai.io`:

```
?max_price=0.01                      -> 8 agentes
?category=defi&max_price=0.01        -> 8 agentes   (lista idéntica a ?category=BASURA)
?category=BASURA&max_price=0.01      -> 8 agentes

?limit=3                             -> [remit-corridor-fx-solana, remit-kyc-validator, remit-cashout-payout-solana]
?limit=3&cursor=eyJhIjoxfQ==         -> lista IDÉNTICA
?limit=3&cursor=BASURA_TOTAL         -> lista IDÉNTICA
```

`category=defi` y `category=BASURA` devuelven el **mismo conjunto**: el parámetro no filtra.
Un cursor inventado y uno basura devuelven la **misma primera página** de un catálogo de 23:
el parámetro no pagina.

Consecuencia para la decisión: **ninguna funcionalidad que hoy funcione se rompe.** Lo que el
400 hace es volver audible que la doc pública del marketplace promete dos parámetros muertos
— la misma clase de silencio que esta HU existe para matar, una capa más arriba. Eso NO anula
el hallazgo: un integrador que hoy recibe 200 pasaría a recibir 400, y la doc pública queda
desmentida. Pero cambia la pregunta de "¿rompemos producción?" a "¿publicamos que estaban
rotos, y en qué orden?".

---

## `BLQ-MED-2` — Scope · los call-sites de `query` son SEIS, no cuatro

El Story File §2.2 enumera 4 y la Done Definition pide *"Los 4 call-sites de `query`
corregidos"*. El Dev corrigió esos 4 y no re-grepeó. Faltan dos, ambos en este repo:

1. `scripts/k6-deep-test.js:356`
   ```js
   const body = { limit: 10 }
   if (query.q) body.query = query.q      // <- clave 'query'
   ```
   → `POST /discover {limit:10, query:'...'}` → 400 → el check `'discover POST 200'` (`:364`)
   queda en rojo en cada iteración con `q` no vacío (`queries[]`, `:330-334`).

2. `scripts/smoke-e2e-comprehensive.mjs:144`
   ```js
   body: JSON.stringify({ query: '', limit: 50 }),
   ```
   → 400 siempre → `discover.agents` es `undefined` → `?? []` (`:149`) → el smoke imprime
   `HTTP 400 — undefined agents available, 0/5 target slugs found` **y sigue**. No hay assert
   sobre el status.

El segundo es el peor: un smoke que deja de oler sin decirlo es exactamente la clase de
silencio que esta HU existe para matar, reproducida por el fix de la HU.

Ninguno está cableado a `npm test` ni a CI (grep sobre `package.json` y `.github/workflows/`:
cero hits) — mismo estatus que `perf-bench.mjs` y `k6-load-test.js`, que sí se corrigieron.

Verificados y **OK**: `scripts/hackathon-e2e.mjs:112-116`, `scripts/report-stranded-exposure.mjs:80`,
`scripts/doctor-chaos.js:85,181,198`, `scripts/doctor-dast.js:81,126`,
`scripts/smoke-base-downstream.mjs:116`, `scripts/smoke-downstream-x402.mjs:152,384`,
`scripts/smoke-capabilities-schema.mjs:59`, `packages/agent-sdk/src/agent.ts:496-513`.

---

## `MNR-1` — el número de R-3 es falso (la afirmación de fondo, no)

Story §9 R-3: *"hoy investiga con `?min_reputation=2` ve **23** agentes... Después de esta HU
verá **0**"*. Medido:

| Request | Hoy | Post-HU (equivalente `minReputation`) |
|---|---|---|
| `/discover?min_reputation=2` | 200, total **23** | 200, total **5**, `excluded.reputation: 18` |
| `/discover?capabilities=remittance-payout` | 200, total **1** (`remit-cashout-payout-solana`, reputation `null`) | idem |
| `/discover?capabilities=remittance-payout&minReputation=1` | 200, total **0** | idem |

El `0` pertenece al caso de `remittance-payout`, no al catálogo entero. **La afirmación
sustantiva de R-2/R-3 queda CONFIRMADA**: el conjunto vacío con piso ≥1 ya existe hoy por el
nombre camelCase; la HU no cambia ningún camino que hoy funcione (`/compose` intacto por CD-1;
chaski-v3 llama `/discover?capabilities=<cap>` sin piso). Lo que cambia para un caller directo
de `min_reputation` es que el filtro que pidió empieza a aplicarse: 23 → 5. Eso es el fix.

Acción: que el done-report no republique "23 → 0".

## `MNR-2` — TD-322-1 deja una asimetría dentro del mismo archivo de ruta

`GET /discover?registy=WasiAI` (typo) → 400. `GET /discover/wasi-chainlink-price?registy=WasiAI`
→ 200, y `discoveryService.getAgent(slug, undefined)` (`src/services/discovery.ts:1252-1273`)
cae al lookup local y después itera **todos** los registries habilitados: el caller recibe un
agente de un registry que no pidió, en silencio. Deuda declarada (§5 OUT / TD-322-1), no
bloquea — pero el guard nuevo hace la permisividad vecina *más* sorprendente, no menos.

## `MNR-3` — TD-322-2 se apoya en el mismo argumento money-path que justifica la HU

`src/routes/discover.ts:227` y `:297`: `verified: query.verified === 'true' ? true : undefined`.
`?verified=1` y `?verified=TRUE` → `undefined` → el caller cree haber filtrado a verificados,
recibe los no verificados y elige a quién pagarle. Fuera del alcance de ESTA HU (nombres vs
valores) y declarado — pero el 400 nuevo vuelve la inconsistencia audible: `?verifed=1` (typo
en el NOMBRE) ahora es error, `?verified=1` (VALOR malo) sigue siendo silencio.

## `MNR-4` — eco sin cota del input del atacante en el cuerpo del 400

`src/lib/discovery-query.ts:224`: `` `unknown parameter '${String(received)}'...` `` sin límite
de longitud. `POST /discover` con una clave JSON de ~100 KB devuelve un 400 de ~100 KB (sin
`bodyLimit` configurado en `src/index.ts:95-106` → default 1 MiB). Va JSON-encodeado, así que
no hay inyección; es amplificación ~1x y ruido de logs. Bajo, pero es input no acotado reflejado.

---

## Las 11 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | Security | **MNR-4**. Sin superficie de authz nueva; el 400 revela sólo la allowlist, que W2 publica a propósito |
| 2 | Error Handling | **OK**. `parseFiltersOr400` (`src/routes/discover.ts:89-102`) re-lanza lo que no reconoce → una clase nueva sin `instanceof` da 500, no 200 silencioso |
| 3 | Data Integrity | **N/A**. La HU no escribe, no toca transacciones ni concurrencia |
| 4 | Performance | **OK**. El guard corre antes del fanout: GET `:216` antes de `:219`, POST `:270` antes de `:289` → un 400 cuesta cero fetch upstream y cero lectura de DB. El token de rate-limit se consume igual que antes. `event-tracking.ts:89-142` escribe una fila por request (ahora con `status:'failed'`): esperar un escalón en el panel de error-rate de `/discover` |
| 5 | Integration | **BLQ-ALTO-1**, **BLQ-MED-2** |
| 6 | Type Safety | **OK**. Cero `any`. Un solo cast (`src/routes/discover.ts:36`) detrás del guard `typeof`/`Array.isArray`. NaN no propaga: `Number.isFinite` corta en `discovery-query.ts:50` |
| 7 | Test Coverage | **OK**. Los tests de ruta afirman ausencia de fanout, no sólo el status. CD-10 respetado. El hueco real es el contrato cross-repo (= `BLQ-ALTO-1`) |
| 8 | Scope Drift | **OK**. Los 8 archivos declarados + `auto-blindaje.md`. `git diff --name-only main..HEAD` no toca `services/discovery.ts`, `capability-resolver.ts`, `compose.ts`, `compose-step-shape.ts` ni `_INDEX.md` |
| 9 | Destructive Migrations | **N/A**. Cero SQL |
| 10 | RPC `SECURITY DEFINER` | **N/A** |
| 11 | Cache Invalidation | **N/A** |

## Las 3 preguntas dirigidas

**El alias, ¿converge?** Sí, estructuralmente: los dos crudos pasan por el mismo
`parseMinReputation` y aguas abajo hay un solo campo (`resolveMinReputation`,
`discovery-query.ts:305-318`). Ejecutado sobre la rama, 15 entradas, cero divergencias:

```
('5','5')→5   ('5','5.0')→5   (0,undefined)→0   (undefined,0)→0   ('','5')→5
(true,1)→1    ([],0)→0        (['5'],'5')→5     ({valueOf:()=>5},5)→5
(['5','5'],undefined)→400 INVALID_MIN_REPUTATION   ('5' vs '7')→400 CONFLICTING
```

`0` sobrevive al `camel ?? snake` (no es nullish). Vacío/`null` cuentan como ausente.
`Number('0x10')`→16 y `Number('1e2')`→100 se aceptan, pero es preexistente e **idéntico por
los dos nombres**, así que no rompe la convergencia.

**¿El guard corre antes de consumir algo?** Sí, es lo primero del handler en los dos verbos
(GET `:212-217`, POST `:265-271`). Cero I/O upstream, cero DB.

**CD-5, el candado de Fastify.** **Confirmado, sin `schema`.** `fastify.get('/', async ...)`
(`:192-193`) y `fastify.post('/', async ...)` (`:245-246`) no reciben objeto de opciones; el
único que existe en el archivo es `{ config: { rateLimit: false } }` en `/:slug` (`:311`). En
`src/index.ts:95-106` la instancia se construye sin `ajv`, sin `setValidatorCompiler`, sin
`schemaErrorFormatter` y sin `querystringParser` custom. `removeAdditional` no puede correr.

---

## Fix-pack sugerido, en orden

1. `BLQ-ALTO-1` — decidir el contrato con `category`/`cursor` de v2 **antes** de mergear a2a.
2. `BLQ-MED-2` — `scripts/k6-deep-test.js:356` y `scripts/smoke-e2e-comprehensive.mjs:144`
   (`query` → `q`), y corregir el "4" de §2.2/Done Definition a "6".
3. `MNR-1` a `MNR-4` — al criterio del orquestador; `MNR-1` antes del done-report para no
   publicar una medición falsa.

Riesgo abierto que **no** se cierra acá: **R-2**, dueño founder, confirmado por medición
(`remit-cashout-payout-solana` es el único `remittance-payout` y su reputación es `null`).
