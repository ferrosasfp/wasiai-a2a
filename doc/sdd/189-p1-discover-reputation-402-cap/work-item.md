# 189 — Fix-pack P1: `/discover` limit+minReputation, artefacto float del 402, señal de skip downstream, cap del dedup Solana

**Branch**: `fix/p1-discover-reputation-402-cap` (desde `main` @ `a35212e`)
**Origen**: 5 hallazgos P1 de una sesión de pruebas profundas.
**Regla de la sesión**: cada hallazgo se VERIFICA antes de arreglarse. El mapa del
hallazgo puede estar mal en cualquiera de las dos direcciones.

---

## Verificación previa (antes de tocar código)

| # | Hallazgo reportado | Veredicto | Corrección al diagnóstico |
|---|--------------------|-----------|---------------------------|
| 1 | `/discover` aplica `limit` dos veces → esconde agentes y `total` incorrecto | **CONFIRMADO** (mecanismo) / **PARCIALMENTE MAL DIAGNOSTICADO** (`total`) | Ver [H1](#h1) |
| 2 | `minReputation` se acepta y se ignora en silencio | **CONFIRMADO** + un modo de falla extra no reportado (NaN) | Ver [H2](#h2) |
| 3 | Artefacto de float de 1 wei en el challenge 402 | **CONFIRMADO** pero **la magnitud y la ubicación estaban mal** | Ver [H3](#h3) |
| 4 | Falta la señal del skip en la respuesta de `/compose` | **CONFIRMADO** | Ver [H4](#h4) |
| 5 | `_intentSignatures` crece sin cota | **CONFIRMADO** | Ver [H5](#h5) |

---

## H1 — `limit` doble en `/discover` {#h1}

### Evidencia del bug (probe reproducible, pre-fix)

Registry con `schema.discovery.limitParam = 'limit'` (así están los dos registries
reales del repo: `supabase/migrations/20260401000000_kite_registries.sql:48` y
`supabase/migrations/20260404000000_mock_community_registry.sql:31`), catálogo de
10 agentes de los cuales 3 `status:'inactive'`, request `limit=5`:

```
esperado: agents.length = 5, total = 7
medido:   agents.length = 2, total = 2
```

### Mecanismo real (las dos capas)

1. **`src/services/discovery.ts:446-448`** — `queryRegistry` reenvía el `limit`
   DEL CALLER al registry upstream (`url.searchParams.set(schema.limitParam,
   query.limit)`). El registry devuelve sus primeras `limit` filas **en su propio
   orden y sin aplicar nuestros filtros**.
2. **`src/services/discovery.ts:347`** — el pipeline vuelve a cortar
   (`allAgents.slice(0, query.limit)`) DESPUÉS de los filtros locales
   (status/verified/capabilities/free-text/maxPrice) y del sort.

El daño no es "cortar dos veces al mismo número": es que la **capa 1 trunca el
candidate-set ANTES de filtrar**. Los filtros locales existen precisamente porque
"upstream may not support all filter params" (comentario propio de
`discovery.ts:299`). Todo agente descartado en la capa 2 es un slot de la página
que ya no se puede rellenar → la página sale corta.

Efecto colateral tercero, no reportado: el comentario de `discovery.ts:322-324`
promete que la página es "el top-N por reputación real". Con la capa 1 activa eso
es falso — el top-N se elige sobre un subconjunto arbitrario elegido por el
registry, no sobre el catálogo.

### Corrección al diagnóstico: `total` NO estaba "incorrecto por no coincidir"

El hallazgo dice que el bug incluye que «el campo `total` no coincide con lo que
se devuelve». Eso, por sí solo, **no es un bug**: `total` (`discovery.ts:360` =
`allAgents.length`, pre-`limit`) es el denominador de paginación y DEBE ser
`>= agents.length` cuando hay `limit`. Un cliente necesita exactamente eso para
paginar.

El bug real de `total` es otro: como el pool venía truncado por la capa 1,
`total` **subestimaba los matches** (2 en vez de 7 en el probe). O sea: `total`
mentía en magnitud, no en semántica.

### Contrato elegido y documentado

No había contrato escrito para `total` (`doc/INTEGRATION.md` sólo lo menciona de
pasada; no hay OpenAPI en el repo). Se elige la semántica que un cliente espera
para poder paginar y se documenta:

> `total` = cantidad de agentes que **matchean todos los filtros**, antes de
> aplicar `limit`. `agents` = hasta `limit` de ellos, ordenados
> verified-first → reputación desc → precio asc. `total >= agents.length`.

Documentado en `src/routes/discover.ts` (JSDoc de GET y POST) y en
`doc/INTEGRATION.md`.

### Fix

`queryRegistry` deja de usar el `limit` del caller como límite de fetch upstream.
El `limit` del caller es **page size** (post-filtro); el upstream necesita un
límite de **over-fetch** independiente, para que los filtros locales tengan
holgura.

- Nuevo `resolveUpstreamFetchLimit(pageLimit)`: `max(pageLimit, env
  DISCOVERY_UPSTREAM_FETCH_LIMIT ?? 200)`. Monótono: un caller que pide
  `limit=500` fetchea 500; uno que pide 5 fetchea 200.
- Gate preservado: si el caller **no** manda `limit`, se sigue **sin** mandar
  `limitParam` (comportamiento de hoy byte-idéntico). Deliberado: imponer un cap
  de 200 donde antes no había ninguno sería re-introducir el mismo bug de clase
  "esconder agentes" en el path sin `limit`.

### Por qué 200 de default

Es un over-fetch de 40× sobre el `limit=5` del probe y de 2× sobre el `limit=100`
más grande que se ve en el repo, y sigue siendo un techo real contra un registry
patológico (el fetch ya está acotado además por `DISCOVERY_REGISTRY_TIMEOUT_MS`,
`discovery.ts:466-469`). Env-configurable para poder subirlo sin deploy de código.

### TD abierto

**TD-189-1**: con over-fetch, `total` es exacto sólo si el catálogo del registry
entra en la ventana de over-fetch (hoy: sí, con margen). Para catálogos > 200 por
registry, `total` vuelve a subestimar. La solución real es paginación cursor-based
federada + un `count` upstream — fuera de scope de un fix-pack P1.

---

## H2 — `minReputation` aceptado y silenciosamente ignorado {#h2}

### Evidencia

`minReputation` se parsea y se mete en el `DiscoveryQuery` en los dos handlers
(`src/routes/discover.ts:44-46` GET, `:98-99` POST), está en el tipo
(`src/types/index.ts:345`) y lo expone el SDK público
(`packages/agent-sdk/src/types.ts:73`, `agent.ts:502-503`).

`grep -n minReputation src/services/discovery.ts` → **0 hits**. Nunca se lee.
No filtra nada.

`/compose` y `/orchestrate` NO aceptan `minReputation` (grep vacío en
`src/routes/compose.ts` y `src/routes/orchestrate.ts`) → la sospecha del hallazgo
sobre esas dos rutas es **negativa**.

### Modo de falla extra, no reportado

`parseFloat('abc')` = `NaN`, y `NaN != null` es `true` → hoy un
`?minReputation=abc` produce `minReputation: NaN` en el query. Si se
implementara el filtro sin validar, `score >= NaN` es siempre `false` → **0
resultados, HTTP 200, sin explicación**. Cambiar el no-op silencioso por un
0-resultados silencioso sería cambiar un P1 por otro.

### Decisión: IMPLEMENTARLO (no rechazarlo con 400)

Hay fuente de reputación real y ya está cableada en el path de `/discover`:
`reputationService.computeReputationBatch` (`src/services/reputation.ts:228-277`)
computa un score determinista **0-100** desde `a2a_events` (tasks liquidadas con
`status='success' AND cost_usdc>0`, con cap anti-sybil por caller), y
`discovery.ts:325` (`attachReputations`) YA lo adjunta **pre-limit**, justo donde
hace falta filtrar. Costo del filtro: 0 queries nuevas.

Rechazar con 400 estaría injustificado teniendo la fuente disponible y ya en el
camino caliente.

### Sub-decisión (la importante): sobre QUÉ valor filtra

Filtra **sólo** `computedReputation.score` (el score off-chain del gateway),
**NO** el `agent.reputation` que reporta el registry.

Justificación: `agent.reputation` es un campo que el registry (y por lo tanto el
agente) **auto-reporta** en su card (`discovery.ts:524-526`,
`Number(raw.reputation)`), en una escala indefinida. Un filtro de calidad cuyo
valor lo controla la parte que se está filtrando no filtra nada: alcanza con
declarar `reputation: 100`. El score computado, en cambio, se deriva de tasks
efectivamente **pagadas y liquidadas**, con cap anti-sybil por caller.

Esto hace que el filtro sea deliberadamente MÁS estricto que el `sort` (que sí
usa el fallback `computedReputation?.score ?? reputation`, `discovery.ts:334-337`
— y ese sort NO se toca). Diferencia intencional y documentada: ordenar con un
dato auto-reportado es cosmético; **filtrar** con él es una falsa garantía.

**Fail-safe**: agente sin `computedReputation` (0 tasks liquidadas) cuenta como
score 0 → queda EXCLUIDO cuando `minReputation > 0`. Un agente sin historial no
puede colarse por un filtro de calidad.

### Escala: el JSDoc de la ruta estaba MAL

`src/routes/discover.ts:17` documentaba `minReputation: minimum reputation score
(0-1)`. La fuente real es 0-100 (`src/types/index.ts:295`: «0-100 entero,
determinista»). Se corrige el JSDoc a **0-100** y se valida el rango.

### Validación (cierra el modo NaN)

`parseMinReputation(raw)` exportado desde `src/services/discovery.ts`:
acepta un número finito en `[0, 100]`; cualquier otra cosa (NaN, negativo, > 100,
string no numérico) → **HTTP 400** `INVALID_MIN_REPUTATION` con mensaje claro.
Aplicado en GET y POST.

### TD abierto

**TD-189-2**: `maxPrice` tiene el MISMO modo de falla NaN
(`src/routes/discover.ts:43` → `discovery.ts:317-320`: `priceUsdc <= NaN` es
siempre `false` → 0 resultados con 200). NO se arregla acá para mantener el
commit de este hallazgo revertible y acotado, y porque cambiar
`?maxPrice=abc` de 200-vacío a 400 es un cambio de contrato que merece su propio
work item.

---

## H3 — Artefacto de float en el monto del challenge 402 {#h3}

### Corrección al diagnóstico: no es "1 wei" y no está donde decía el hallazgo

El hallazgo apuntaba a `src/middleware/x402.ts` y/o
`augmentX402ChallengeAmount` de `src/routes/compose.ts`, y a «una conversión que
pasa por `Number` en vez de quedarse en `BigInt`/string».

Ninguna de las dos ubicaciones es la causa, y no hay ningún `Number(...)`
involucrado. El monto atómico sale de `adapter.quote()`
(`x402.ts:260-262` → `resolvePaymentRequirements`), y **cada adapter** hace:

```ts
parseUnits(amountUsd.toFixed(DECIMALS), DECIMALS)
```

- `src/adapters/kite-ozone/payment.ts:394` — `toFixed(18)`, 18 dec ← **la chain default**
- `src/adapters/solana/payment.ts:178-181` — `toFixed(decimals)`
- `src/adapters/base/payment.ts:443-446` — `toFixed(6)`
- `src/adapters/avalanche/payment.ts:419-422` — `toFixed(6)`
- `src/adapters/tempo/payment.ts:364-367` — `toFixed(TEMPO_USD_DECIMALS)`

La causa es `Number.prototype.toFixed(18)`: pedirle a un double **18** dígitos
fraccionarios lo obliga a emitir su expansión binaria completa en vez del decimal
que el double representa.

### Magnitud medida (no es 1 wei)

| `amountUsd` | `toFixed(18)` | wei emitido | drift vs. el decimal real |
|---|---|---|---|
| 0.03 | `0.029999999999999999` | 29999999999999999 | **−1** |
| 0.1 | `0.100000000000000006` | 100000000000000006 | **+6** |
| 0.2 | `0.200000000000000011` | 200000000000000011 | +11 |
| 0.29 | `0.289999999999999980` | 289999999999999980 | −20 |
| 1.1 | `1.100000000000000089` | 1100000000000000089 | +89 |
| 1.005 | `1.004999999999999893` | 1004999999999999893 | **−107** |

El "1 wei" del reporte corresponde al caso `0.03`. El drift real va de **−107 a
+89 wei** en muestras realistas, y **cambia de signo**: positivo = el caller
firma y paga de más; negativo = el guard de binding inbound
(`x402.ts:461`, `BigInt(auth.value) < BigInt(requiredAmount)`) queda 1..107 wei
más permisivo que el precio real.

### Por qué los 6-dec (USDC) NO están afectados

`toFixed(6)` redondea el valor real del double a 6 decimales, y un double tiene
~15-17 dígitos significativos → para montos USD el redondeo a 6 dp coincide con
el decimal pretendido. Verificado empíricamente: **0 diferencias en 300.000
floats aleatorios** en `[0,100)` entre `parseUnits(v.toFixed(6),6)` y
`parseUnits(String(v),6)`.

### Fix

Helper compartido nuevo `src/lib/atomic-amount.ts` →
`usdToAtomicUnits(amountUsd, decimals): string`, que normaliza el número a su
**representación decimal más corta con round-trip** (`String(n)`, expandiendo
notación científica a decimal plano) y recién ahí llama a `parseUnits`. Los 5
adapters pasan a usarlo.

Se conserva la razón por la que existía el `toFixed`: `parseUnits` **lanza** con
notación científica (verificado: `parseUnits('1e-7', 6)` → `Number "1e-7" is not
a valid decimal number`), y `toFixed` la evitaba. El helper la evita expandiendo
el exponente a mano, sin pasar por la expansión binaria.

### Invariante exigido por el AR de la HU 188

`augmentX402ChallengeAmount`, `resolveComposePriceHandler`,
`resolveStep0GasOverheadUsd` y `deriveComposeDestination` **no se tocan** — el
fix vive en `src/adapters/*/payment.ts` + `src/lib/atomic-amount.ts`. La lógica
de **precio en USD** queda byte-idéntica; lo único que cambia es la conversión
USD → unidades atómicas, y sólo para tokens de > 6 decimales. Probado con un test
que fija el monto exacto para 18 y para 6 decimales sin tolerancia.

---

## H4 — La respuesta de `/compose` no dice por qué se salteó un leg {#h4}

### Evidencia

`signAndSettleDownstream` (`src/lib/downstream-payment.ts:502`) devuelve
`DownstreamResult | null`: `null` = salteado, **sin el código**. Los 25 sitios de
`return null` loguean `{ code }` server-side y ahí muere la información.
`src/services/compose.ts:1158` propaga sólo `...(downstream && { downstream })`,
y `finishSuccessfulStep` (`compose.ts:664-668`) sólo puebla los campos del caso
exitoso (`downstreamTxHash` / `downstreamBlockNumber` /
`downstreamSettledAmount`).

### Fix (aditivo, sin tocar el money-path)

Campo nuevo `StepResult.downstreamSettle?: string` con valor
`"skipped:<PUBLIC_CODE>"`, poblado sólo cuando el leg se salteó.

Captura sin editar los 25 `return null`: `createSkipCapturingLogger()`
(co-locado en `downstream-payment.ts`) **decora** el `DownstreamLogger` que
`invokeAgent` ya le pasa a `signAndSettleDownstream` y retiene el último `code`
visto. Si la función devolvió `null` y hubo código → se surfacea. Cero
modificaciones en la lógica de decisión de dinero.

Invariante del que depende: *todo* camino que retorna `null` loguea antes un
`{ code }`. Verificado sitio por sitio (25/25) y fijado con test.

Los dos códigos de sólo-observabilidad (`BALANCE_PRECHECK_SKIPPED`,
`BALANCE_LOW_ON_IDEMPOTENT_REPLAY`) **no** cortan el leg, así que nunca se
surfacean como skip: si después el settle sale bien, `downstream != null` y no se
emite nada.

### Revisión de fuga de información (pedida explícitamente)

Exponer los `DownstreamSkipCode` crudos **sí filtra estado interno**. Criterio
aplicado:

> Se expone verbatim lo que describe la **declaración del propio agente** (dato
> que el caller ya ve en `/discover`) o un **resultado terminal de pago**. Se
> genericiza lo que describe la **configuración del gateway**, el **wallet del
> operador** o sus **claves**.

| `DownstreamSkipCode` | Público | Por qué |
|---|---|---|
| `NO_PAYMENT_FIELD` | verbatim | la card del agente |
| `METHOD_NOT_SUPPORTED` | verbatim | `payment.method` del agente |
| `CHAIN_NOT_SUPPORTED` | verbatim | `payment.chain` del agente |
| `INVALID_PAY_TO_FORMAT` | verbatim | `payment.contract` del agente |
| `ZERO_PAY_TO` | verbatim | `payment.contract` del agente |
| `INVALID_PRICE` | verbatim | `priceUsdc` del agente |
| `SETTLE_FAILED` | verbatim | resultado terminal: no se pagó |
| `FLAG_OFF` | → `NOT_CONFIGURED` | revela el estado de un feature flag del gateway |
| `CHAIN_ENVIRONMENT_DRIFT` | → `NOT_CONFIGURED` | **es, por definición, un bug de config de operación nuestro** (ver `downstream-payment.ts:150-157`): revela que el destino configurado contradice la red declarada, o sea si el gateway apunta a testnet mientras publica mainnet |
| `MAINNET_NOT_ALLOWED` | → `NOT_CONFIGURED` | revela la allow-list de mainnets del gateway (`WASIAI_DOWNSTREAM_MAINNET_ALLOW`); permitiría enumerarla sondeando |
| `INSUFFICIENT_BALANCE` | → `UNAVAILABLE` | **revela que la hot wallet del operador está sin fondos en ese rail** — inteligencia operativa directa para cronometrar un abuso |
| `BALANCE_READ_FAILED` | → `UNAVAILABLE` | estado del RPC/wallet del operador |
| `BALANCE_PRECHECK_SKIPPED` | → `UNAVAILABLE` | idem (defensivo; no corta el leg) |
| `BALANCE_LOW_ON_IDEMPOTENT_REPLAY` | → `UNAVAILABLE` | idem (defensivo; no corta el leg) |
| `SIGNING_FAILED` | → `UNAVAILABLE` | falla firmando con `OPERATOR_PRIVATE_KEY` → revela que la clave del operador falta o es inválida |
| `VERIFY_FAILED` | → `SETTLE_FAILED` | el facilitator rechazó NUESTRA firma: detalle interno; para el caller es indistinguible de "no se pagó" |

Ningún código público nombra una env var, una address del operador ni un detalle
de config.

El mapeo es un `Record<DownstreamSkipCode, PublicDownstreamSkipCode>` **exhaustivo
por tipo**: agregar un código nuevo a `DownstreamSkipCode` sin decidir su
visibilidad **no compila**. Ese es el guard que evita la fuga por olvido.

### Cambio de contrato (aditivo)

Documentado en `doc/INTEGRATION.md`. Los clientes que no conocen el campo lo
ignoran; el caso exitoso no cambia.

---

## H5 — `_intentSignatures` sin cota {#h5}

### Evidencia

`src/adapters/solana/payment.ts:63` — `const _intentSignatures = new Map<string,
string>()`. Escrituras en `:264` (happy path) y `:334` (self-heal
`recoverConfirmedSettle`). Borrados: sólo `:217` (self-heal cuando la firma previa
no verifica) y `:398` (`_resetSolanaClients`, TEST-ONLY). Sin cap, sin TTL, sin
barrido → una entrada por intent, para siempre.

### La semántica que hay que no romper

Ese Map es lo que hace **idempotente** el settle de un leg Solana (`:197-218`):
si el intentId ya tiene firma, se verifica on-chain y se devuelve la firma previa
en vez de re-broadcastear. Si una entrada desaparece **mientras el intent sigue
vivo**, un retry re-broadcastea → **se paga dos veces**.

Dato que acota el problema: el `intentId` es `${composeRunId}:${i}`
(`src/services/compose.ts:329`, `:499`) y `composeRunId = randomUUID()` por
ejecución (`compose.ts:120`). Como el UUID es fresco por run, **ninguna ejecución
futura vuelve a preguntar por un intentId viejo**. Por lo tanto una entrada sólo
necesita sobrevivir a la ventana de vida de SU PROPIO compose-run.

### TTL elegido y su justificación

Vida máxima de un compose-run = `TIMEOUT_COMPOSE_MS`
(`src/routes/compose.ts:584`, default **180.000 ms** = 3 min). Un run no puede
sobrevivir a su propio timeout.

- **TTL default = `max(TIMEOUT_COMPOSE_MS × 10, 1.800.000 ms)` = 30 min** con el
  default de 180 s. Margen de **10×** sobre la vida máxima posible del run, y se
  mueve solo si el operador sube el timeout del compose.
- Override `SOLANA_INTENT_DEDUP_TTL_MS`, **con piso `TIMEOUT_COMPOSE_MS × 2`**:
  un operador no puede configurar un TTL que expire dentro de la ventana viva de
  un run. El piso es el guard fail-safe del knob.

### Cap: SOFT, con ventana protegida (fail-safe hacia no-pagar-dos-veces)

Un cap duro tiene que desalojar algo, y tarde o temprano desaloja una entrada
viva → doble pago. Política elegida:

1. En cada `set`, barrer las entradas **expiradas** (edad > TTL).
2. Si aun así se supera `SOLANA_INTENT_DEDUP_MAX_ENTRIES` (default 10.000),
   desalojar las más viejas **primero**, pero **NUNCA** una con edad
   < ventana protegida (`TIMEOUT_COMPOSE_MS × 2`).
3. Si TODAS las entradas están dentro de la ventana protegida, **no se desaloja
   nada**: el Map excede el cap temporalmente y se emite un `warn` (una vez por
   ventana) como señal operativa.

O sea: ante la duda, **conservar** — exactamente la preferencia pedida. El cap
acota el crecimiento en régimen; la ventana protegida garantiza que la
idempotencia nunca se rompe por presión de memoria. El techo real pasa a estar
determinado por el throughput dentro de la ventana protegida (6 min), que lo
acota el tráfico real, no el uptime del proceso.

Sin `setInterval`: el barrido es lazy (en `set` y en `get`), para no mantener el
event loop vivo ni introducir flakiness en los tests.

`getSettledSignature` (`:170-172`) y el read de `settle` (`:197`) pasan por el
mismo accessor con chequeo de TTL: una entrada expirada se trata como ausente.
El `delete` del self-heal (`:217`) y el `clear()` del reset (`:398`) siguen
funcionando igual.
