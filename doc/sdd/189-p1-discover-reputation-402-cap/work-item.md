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

**TD-189-1**: el over-fetch es una ventana FIJA por registry, así que todas las
propiedades que dependen de "el fetch trae todo lo que importa" tienen la misma
precondición: **la unión de las filas que aportan las fuentes contribuyentes entra
en la ventana**. Hoy se cumple con margen (~32 agentes por registry contra 200).
Los tres residuales, en un solo lugar:

1. **`total` subestima** si el catálogo de UN registry supera la ventana (el fetch
   se trunca antes de contar).
2. **Suma entre registries** (AR it3): el fetch es por-registry pero el `slice` del
   page size es GLOBAL (`discovery.ts:293` concatena, `:399` corta), así que con N
   fuentes el fetch puede traer 200·N filas y la página conserva 200 ⇒ el `slice`
   descarta candidatos que el fetch SÍ trajo, y el ranking decide cuáles. Rompe el
   "superconjunto" del pool por-slug de `/compose` (ver BLQ-BAJO-1 más abajo).
3. **Registry sin `limitParam`** (AR it3): el gate es
   `query.limit && schema.limitParam` (`discovery.ts:509`) y `limitParam` es
   opcional (`types/index.ts:134`), creable por cualquier caller vía
   `POST /registries`. Esa fuente ignora el knob por completo, devuelve su
   paginación default, y aporta al total del `slice` global.

La solución real para los tres es paginación cursor-based federada + un `count`
upstream — fuera de scope de un fix-pack P1. Mitigación operativa mientras tanto:
`DISCOVERY_UPSTREAM_FETCH_LIMIT` tiene que superar la **suma** de los catálogos, no
el más grande (documentado así en `.env.example`).

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

> ⚠️ **CORREGIDO POR EL AR (MENOR-1).** Lo que decía esta sección era falso y se
> reemplazó por la versión honesta de más abajo. Se deja el texto viejo tachado
> porque el error importa: era una garantía inventada, escrita justo en el texto
> que el operador lee antes de bajar una perilla de dinero.
>
> ~~Vida máxima de un compose-run = `TIMEOUT_COMPOSE_MS` (default 180.000 ms).
> Un run no puede sobrevivir a su propio timeout. TTL default =
> `max(TIMEOUT_COMPOSE_MS × 10, 30 min)`, margen de 10×. Piso del override =
> `TIMEOUT_COMPOSE_MS × 2`: un operador no puede configurar un TTL que expire
> dentro de la ventana viva de un run.~~

**Por qué era falso** (verificado archivo por archivo):

- `src/middleware/timeout.ts:12-20` sólo **manda** el 504. No hay
  `AbortController`, no hay `signal`, no se cancela nada: el pipeline sigue
  corriendo después de que el caller recibió el timeout.
- `src/services/compose.ts:1054` invoca al agente con `ssrfFetch(...)` **sin**
  `signal`, y `src/lib/ssrf-dispatcher.ts:114-125` construye el `Agent` de undici
  **sin** `headersTimeout`/`bodyTimeout` → el único freno son los defaults de
  undici (300 s). Y `bodyTimeout` es de **inactividad**: un agente que manda un
  byte cada 299 s mantiene el hop vivo indefinidamente.

Conclusión: **no existe cota superior dura** de wall-clock para un run, así que
NINGÚN número de TTL puede prometer "no expira dentro de un run vivo". Con el TTL
viejo de 30 min contra una cota realista de 25 min, el margen efectivo era ~1.2×,
no 10×.

### Decisión (opción B del AR): no cancelar, y decir la verdad

Se descartó cancelar el pipeline en el 504. Abortar un run **en medio de un
settle** produce exactamente el estado indeterminado
broadcasteado-pero-no-confirmado del que este Map protege: el remedio sería peor
que la enfermedad, y cancelar el money-path no es scope de un fix-pack. (Si
alguna vez se hace, el lugar correcto es un deadline por hop en
`ssrf-dispatcher.ts`, no un `abort` sobre el pipeline entero.)

Lo que sí cambia: los números dejan de derivar de una env que **no** gobierna la
ejecución y pasan a derivar de la cota más grande que se puede citar con datos del
repo (`src/adapters/solana/payment.ts`):

```
MAX_COMPOSE_STEPS            = 5        (routes/compose.ts:128, `steps.length > 5`)
UNDICI_DEFAULT_HOP_TIMEOUT   = 300_000  (default de undici 8; nuestro código no lo fija)
ESTIMATED_MAX_RUN_WALL_CLOCK = 5 × 300 s = 25 min
```

- **Ventana protegida** = `max(25 min, TIMEOUT_COMPOSE_MS × 2)` = **25 min**.
- **Piso del override** = la ventana protegida (**25 min**, antes 6 min). NO se
  vende como garantía: es coherencia interna — un TTL por debajo de la ventana
  protegida haría expirar una entrada que el desalojo todavía considera intocable.
- **TTL default** = `max(25 min × 2, TIMEOUT_COMPOSE_MS × 10, 30 min)` =
  **50 min** (antes 30 min).

La cota es una **estimación, no una garantía**, y así está escrita en el código y
en `.env.example`: cuenta UN hop por step (el invoke) y no cuenta los hops del
settle ni el caso del body trickle-feedeado, que no tiene techo. El número es
incómodo (25 min contra los 3 min del timeout del compose) y es el que hay.
Fijado por `T-TTL-11` (`intent-dedup.test.ts`), que assertea que el piso es
`>= ` la cota y **>** `TIMEOUT_COMPOSE_MS × 2`.

### Cap: SOFT, con ventana protegida (fail-safe hacia no-pagar-dos-veces)

Un cap duro tiene que desalojar algo, y tarde o temprano desaloja una entrada
viva → doble pago. Política elegida:

1. En cada `set`, barrer las entradas **expiradas** (edad > TTL).
2. Si aun así se supera `SOLANA_INTENT_DEDUP_MAX_ENTRIES` (default 10.000),
   desalojar las más viejas **primero**, pero **NUNCA** una con edad
   < ventana protegida (25 min con los defaults — ver la corrección de MENOR-1).
3. Si TODAS las entradas están dentro de la ventana protegida, **no se desaloja
   nada**: el Map excede el cap temporalmente y se emite un `warn` como señal
   operativa, **una vez por EPISODIO de saturación**: el flag se re-arma en cuanto
   el tamaño vuelve a bajar del cap (por barrido de expiradas, por desalojo o
   porque el operador subió el cap).

   > ⚠️ **CORREGIDO POR EL AR (MENOR-2).** Acá decía «una vez por ventana» y era
   > falso: `_warnedSoftCapBreached` sólo se re-armaba en `_resetSolanaClients`
   > (TEST-ONLY), o sea que era **warn-once-per-proceso** — breach a la hora 1,
   > recuperación, breach a la hora 20 → **silencio**. Mismo anti-patrón que este
   > mismo fix-pack ya había documentado para `FLAG_OFF` (`auto-blindaje.md`).
   > Fijado por `T-CAP-6` (recuperación por cap) y `T-CAP-7` (recuperación por
   > desalojo).

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

---

# Fix-pack del AR (iteración 2) — 1 BLOQUEANTE-BAJO + 6 MENOR

El AR validó los 5 fixes (reprodujo el barrido de 200.000 floats, la cobertura
hit-por-línea de los 5 sitios de dinero y las 3 mutaciones, + 4 propias) y
**rechazó** por un efecto colateral cruzado que el work-item no analizaba.

## BLQ-BAJO-1 — el over-fetch de H1 cambió la MEMBRESÍA del pool que `/compose` usa para hidratar `payment.chain`

**Mecanismo**: `queryRegistry` es compartido. `compose.resolveAgent` pedía
`discover({ limit: 50 })` para dos cosas del money-path: (a) hidratar el
`payment.chain` real (WKH-113/BASE-08, CD-5/CD-10 — el `getAgent` del marketplace
hardcodea `chain=avalanche`) y (b) el fallback de resolución por slug. Ese pool es
el **top-50 RANKEADO**. Con el over-fetch el ranking se calcula sobre ≤200 filas
por registry en vez de ≤50: **mismos 50 slots, 4× candidatos** ⇒ la composición
del top-50 cambia y un agente que antes entraba puede quedar afuera.

Si el que queda afuera es un agente non-EVM resuelto vía `agentEndpoint`, pierde
la hidratación ⇒ `payment.chain` se queda en el default ⇒ el leg downstream se
saltea (guard de familia del payTo / `NO_PAYMENT_FIELD`) o apunta al rail
equivocado: **el agente no se cobra, en silencio**. Atenuante: los agentes
self-published resuelven local-first con su payment completo
(`discovery.ts:606-611`), así que los remit de la incubación no se ven afectados.

### Fix

`src/lib/discovery-fetch-limit.ts` (módulo **leaf** nuevo: `compose.ts` no puede
importar de `services/discovery.ts` porque media docena de suites lo mockean
completo — la misma reincidencia ya documentada en `auto-blindaje.md`). Se movió
ahí `resolveUpstreamFetchLimit` y se agregó
`resolveComposeAgentPoolLimit() = resolveUpstreamFetchLimit(50)`.

Propiedades, con su precondición al lado (**corregido en la iteración 3**: la
versión anterior las afirmaba sin condiciones y el AR probó que dos de las tres son
falsas con ≥2 registries):

1. **Idempotencia — verdadera sin condiciones.** `resolveUpstreamFetchLimit` cumple
   `max(max(a,b), b) === max(a,b)`, así que el page size del pool es exactamente el
   número que se le pide a **cada** registry.
2. **El `slice` no descarta lo fetcheado — sólo con UNA fuente contribuyente.** El
   `slice` es GLOBAL (`discovery.ts:399` sobre la concatenación de `:293`) y el
   over-fetch es POR REGISTRY. Con N fuentes el fetch trae hasta 200·N filas y la
   página conserva 200 ⇒ el `slice` sí descarta candidatos traídos. Y `limitParam`
   es opcional (`types/index.ts:134`, gate en `discovery.ts:509`): un registry sin
   `limitParam` devuelve su paginación default y para esa fuente no hay alineación
   ninguna.
3. **Superconjunto del pool de `main` — sólo con UNA fuente contribuyente.** Con una
   sola, se sostiene por aritmética (el fetch de 200 filas en orden de registry
   contiene las 50 de antes; el peor caso reproducido, `49 + 150 = 199 < 200`,
   entra). Con 2+ **es falsa**: repro del AR sobre el pipeline real (sólo undici
   mockeado) con 3 registries — dos sirviendo 400 filas cuyas primeras 50 son
   `verified:false` rep 0 y el resto `verified:true` rep 100, más uno chico con el
   target (`verified:true`, rep 50, `payment.chain='solana-devnet'`) → `pool=200`,
   `total=401`, `idx(target) = -1` ⇒ `resolveAgent` cae al hardcode
   `chain='avalanche'` del marketplace, mientras el mimic de `main` (pool 50) lo
   encuentra y devuelve `solana-devnet`.

**Severidad del residual: BAJA y no alcanzable en prod hoy** (los registries reales
tienen ~32 agentes, muy por debajo de la ventana de 200). Lo que estaba roto era la
**afirmación**, que además era el argumento load-bearing del cierre de este
bloqueante. Los dos casos nuevos quedan plegados en **TD-189-1** (arriba) y la
precondición vive pegada a la afirmación en
`src/lib/discovery-fetch-limit.ts` (`resolveComposeAgentPoolLimit`),
`src/services/discovery.ts` (el comentario del `slice`), `src/services/compose.ts`
(`discoverAgentPool`) y `.env.example`.

`compose.ts` tiene ahora **un solo productor** del pool (`discoverAgentPool`),
consumido por `createDiscoverCache` y por el fallback de `resolveAgent`: si
divergieran, el hit de cache y el fallback resolverían sobre pools distintos.

**Por qué NO `discover({})`** (la otra opción que ofrecía el AR): sin `limit` no se
manda `limitParam`, así que el tamaño del pool lo decidiría el **default de
paginación del registry**. Un registry que pagina de a 25 devolvería 25 filas:
peor que hoy y fuera de nuestro control.

### Tests (`src/services/compose.discovery-pool.test.ts`, 7)

No mockea `discoveryService` — el bug vive en la interacción page-size ↔
over-fetch, y un mock de `discover()` fabrica el pool y por construcción no lo
puede observar. Se mockea sólo el borde de red (undici), como en
`discovery.limit.test.ts`.

- `T-POOL-1/2`: 150 candidatos, target último del ranking → `payment.chain` sigue
  hidratando (`solana-devnet` y `base-sepolia`).
- `T-POOL-3`: el page size del pool == el over-fetch pedido al registry.
- `T-POOL-4/5`: el pool sigue a `DISCOVERY_UPSTREAM_FETCH_LIMIT` (300) y respeta
  el piso de 50 si el operador lo baja.
- `T-POOL-6`: el fallback por slug (getAgent 404) resuelve del MISMO pool.
- `T-POOL-7`: **borde del settle por el path real de `/compose`** (con
  `DiscoverCache`): la chain llega a `signAndSettleDownstream`.

**Mutación**:

| Mutante | Resultado |
|---|---|
| `resolveComposeAgentPoolLimit()` → `50` (o sea `main`) | **5 de 7 fallan** (T-POOL-1/2/4/6/**7**) — re-medido en it3: la tabla decía 4 y omitía T-POOL-7, que también muere (el borde del settle por el path real de `/compose`: `expected 'avalanche' to be 'solana-devnet'`) |
| `createDiscoverCache` → `discover({limit:50})` (divergencia cache↔fallback) | **1 de 7 falla** (T-POOL-7, el único que pasa por el cache) |

### Otros consumidores de `discover()` con `limit` implícito (revisados, el bug es de clase)

| Sitio | `limit` | Veredicto |
|---|---|---|
| `services/compose.ts` (cache + fallback) | 50 | **AFECTADO** — money-path. Corregido. |
| `services/orchestrate.ts:551,571` | 50 | **NO es bug**: es una ventana de candidatos para el planner LLM, **rankeada por diseño** (WKH-128). El over-fetch la hace más correcta (top-50 de 200 candidatos reales en vez de top-50 de 50 filas en orden de registry). No hidrata pagos: el `payment` lo resuelve después `compose.resolveAgent`. |
| `mcp/tools/discover-agents.ts:37` | `input.limit ?? 20` | **NO es bug**: es un endpoint de discovery, donde "top-N rankeado" ES el contrato. `mcp/schemas.ts:58` ya valida `integer, minimum 1, maximum 100`. |
| `routes/capabilities.ts:43` | ninguno | **No afectado**: sin `limit` no se manda `limitParam` ni se aplica `slice` (byte-idéntico). |

## MENOR-1 — la garantía falsa del knob de TTL

Ver la corrección in-place en la sección H5 (opción B: no cancelar, decir la
verdad, derivar el piso de la cota estimada por hops = 25 min). Tocados:
`src/adapters/solana/payment.ts`, `.env.example`, esta sección del work-item.

## MENOR-2 — el warn del cap era once-per-proceso

Ver la corrección in-place en H5. `_warnedSoftCapBreached` se re-arma cuando el
tamaño baja del cap (dos sitios: early-return por cap y post-desalojo).

## MENOR-3 — el invariante de 6 decimales quedó acotado al rango probado

`src/lib/atomic-amount.ts`: el docstring afirmaba categóricamente que para 6
decimales el resultado es idéntico al camino viejo. Se acota a **`[0, 100)`** (el
rango que se barrió, donde vive el catálogo entero) y se **declaran** los dos
contraejemplos que midió el AR, fijados en `T-6-4`:

- `5e-7` → viejo `0` / nuevo `1` (sub-grilla).
- `>= 1e21` → viejo **LANZABA** (fail-closed: `String(1e21)` es `'1e+21'` y
  `parseUnits` rechaza notación científica) / nuevo devuelve el atómico expandido.
  Es el precio de reemplazar `toFixed` por la expansión del exponente. `T-SCI-2`
  fijaba el valor nuevo pero nunca lo contrastaba contra el viejo, así que el
  cambio de fail-closed → éxito no quedaba declarado.

## MENOR-4 — `limit` sin validar contra un contrato nuevo que prometía otra cosa

`doc/INTEGRATION.md` prometía «exactly `min(limit, total)` agents» y el código no
lo cumplía para los degenerados: `limit=0` devolvía **todo** el catálogo (falsy ⇒
ni `limitParam` ni `slice`), `limit=-3` devolvía `total-3` (`slice(0,-3)`),
`limit=abc` devolvía todo. Preexistente e idéntico en `main`, pero el doc que lo
contradice es de este fix-pack, que sí validó `minReputation`.

`parseLimit` en `src/lib/discovery-query.ts` (el mismo leaf del validador de
`minReputation`): entero `>= 1`, o **400 `INVALID_LIMIT`**. Sin techo, a propósito:
el over-fetch es monótono y meter un techo reintroduciría el bug de clase
"esconder agentes" de H1. Doc y código alineados. 7 tests unitarios + 5 de ruta.

## MENOR-5 — el 6º (y el 7º) sitio de conversión USD→atómico

`src/lib/downstream-payment.ts` es la pata **OUTBOUND** (lo que el gateway paga) y
tenía `parseUnits(String(agent.priceUsdc), decimals)` en **dos** sitios: el EVM
(`:685`, el que marcó el AR) y el **leg Solana** (`:288`, que el AR no marcó — el
bug es de clase). Los dos pasan ahora por `usdToAtomicUnits`.

Divergencia que cierra: `priceUsdc = 1e-7` daba challenge inbound `0` (el helper
expande el exponente) y `INVALID_PRICE` downstream (`parseUnits` LANZA con
`'1e-7'`). Byte-idéntico para todo precio con representación decimal plana
(`toPlainDecimalString` es `String()` salvo cuando hay exponente).

**Guard nuevo, fail-closed**: si la conversión da **0 unidades atómicas**, el leg
se corta con `INVALID_PRICE`. Es la contrapartida honesta del cambio: un precio
sub-grilla que antes lanzaba ahora convierte, y con 6 decimales puede redondear a
0 — broadcastear un transfer de 0 quema gas y deja un recibo que dice que se pagó
cuando no se movió nada. Antes del cambio ese estado era **inalcanzable** (todo
decimal `< 1e-6` sale de `String()` en notación científica y `parseUnits` lanzaba),
así que el guard no cambia ningún caso preexistente. Tests `T-MNR5-1..4`
(incluye el leg Solana).

## MENOR-6 — punteros stale + campo público sin tipar

- `src/types/index.ts`, `src/services/compose.ts` y `auto-blindaje.md` apuntaban a
  `src/lib/downstream-payment.ts` para el `Record` exhaustivo de skip-codes, que
  vive en `src/lib/downstream-skip-code.ts` (se movió justamente para no romper
  las suites que mockean el módulo del money-path completo).
- `StepResult.downstreamSettle` pasa de `string` a
  `` `skipped:${PublicDownstreamSkipCode}` ``: con `string` la exhaustividad del
  `Record` se perdía justo en el borde de la API, que es donde importa que el
  contrato sea el cerrado. (Ciclo de tipos con el leaf, resuelto con `import type`
  — se borra en runtime, no hay ciclo de módulos.)

## Gates de la iteración 2

`tsc --noEmit` 0 · `biome check src/` 0 · **3362 passed | 11 skipped**
(baseline 3335 → **+27**) · cobertura verificada línea por línea en los archivos
tocados (los únicos statements sin hit son `catch` defensivos y getters
PREEXISTENTES; ninguna línea nueva en 0).

---

# Fix-pack del AR (iteración 3) — 1 BLOQUEANTE-BAJO + 2 MENOR

El re-AR validó la remediación de la it2 (el guard de 0 unidades atómicas no
introduce regresión de cobro — el mínimo del catálogo está 200× por encima del
umbral; los números del TTL son coherentes; el warn del cap es por episodio; el
bound `[0,100)` de `atomic-amount` es NECESARIO, midió 159.236 diferencias en
`[1e6,1e15)`; y la afirmación de cobertura se sostiene) y **rechazó por la
demostración**, no por el código.

## BLQ-BAJO-1 (it3) — la demostración que cerraba el bloqueante anterior es falsa con ≥2 registries

Corregido **in-place** en la sección de BLQ-BAJO-1 (it2): las tres propiedades
quedan enunciadas con su precondición al lado, y los dos casos nuevos (suma entre
registries, registry sin `limitParam`) están plegados en **TD-189-1**. La tabla de
mutaciones también se corrigió: **5 de 7**, re-medido, no 4.

Sitios tocados: `src/lib/discovery-fetch-limit.ts`, `src/services/discovery.ts`,
`src/services/compose.ts`, `src/services/compose.discovery-pool.test.ts`,
`.env.example` (dimensionamiento por **suma**, no por máximo), este work-item.

**Barrido general de afirmaciones absolutas** (la lección, aplicada al branch
entero): grep de «imposible / no puede / nunca / siempre / garantiza» sobre TODAS
las líneas agregadas por el branch. Resultado: la única afirmación defectuosa era
esta, repetida en 5 sitios; el resto (`SIEMPRE falso` del guard de binding con
`maxAmountRequired` negativo, «esta línea NUNCA tuvo el artefacto de `toFixed`», «una
entrada más joven que la ventana protegida NUNCA se desaloja») son verdaderas por
construcción o medidas. Detalle en `auto-blindaje.md`.

## MENOR-2 (it3) — `MAX_COMPOSE_STEPS` duplicado como literal

`src/lib/compose-limits.ts` (leaf nuevo, cero imports) exporta
`MAX_COMPOSE_STEPS = 5`; lo consumen `routes/compose.ts` (el guard de validación) y
`adapters/solana/payment.ts` (factor de `ESTIMATED_MAX_RUN_WALL_CLOCK_MS`, del que
salen la ventana protegida y el TTL del dedup de settles).

**Decisión: constante compartida, NO un test que compare literales.** El test
detecta la divergencia después de que alguien escribió el segundo número (y sólo si
corre esa suite); la constante la hace inescribible. Se conserva ADEMÁS el literal
independiente `5 * 300_000` en `solana/intent-dedup.test.ts` como tripwire: subir el
máximo de steps escala la cota del código y **rompe** la batería de TTL, que es
justo la señal de «re-revisá el margen a mano» que antes no existía.

Sobre la trampa del leaf (ya costó 12 y 84 tests en este fix-pack): archivo nuevo,
sin imports, y **ninguna** suite lo mockea (las suites mockean
`logger`/`supabase`/`ssrf-dispatcher`/`circuit-breaker`/`url-validator`/
`downstream-payment`/`payment-spec-reader`). Mismo patrón que `pricing-constants.ts`,
que `routes/compose.ts` ya importaba.

## MENOR-3 (it3) — `limit=1e21`: la misma clase que el `limit=0` que cerró la it2

`Number.isInteger(1e21)` es `true`, así que `?limit=1e21` pasaba `parseLimit`, se
reenviaba upstream como el literal `'1e+21'` (`discovery.ts:509-514`), un registry
que lo rechaza tira, el `catch` del fanout (`:267-287`) degrada a `[]` y el caller
recibía **200 con 0 agentes** — violando en silencio el `min(limit, total)` que
`doc/INTEGRATION.md:203-210` promete.

Fix: `Number.isSafeInteger` (todo entero seguro tiene representación decimal plana
en `String()`; la notación científica arranca en 1e21) + mensaje de error, JSDoc de
la ruta y `doc/INTEGRATION.md` alineados. **No** es un guard de memoria/CPU: no hay
`new Array(limit)` y `slice` no preasigna. Tests: `T-L8` (unitario, fija la
precondición del bug: `Number.isInteger(1e21) === true` y
`(1e21).toString() === '1e+21'`) y `T-R13` (ruta: 400 y el service NO se llama).

## Fuera de alcance (HU #48, no se toca acá)

El trickle-feed: `bodyTimeout` de undici es de INACTIVIDAD y nadie lo configura ⇒ un
request outbound no tiene techo de wall-clock. Corrección del AR a mi propio
razonamiento, anotada en `auto-blindaje.md` para que la HU arranque sabiéndolo:
acotar **sólo el hop de invoke** (`headersTimeout`/`bodyTimeout` en el dispatcher
SSRF, o un `signal` sólo en el fetch del invoke) **no** aborta un settle en vuelo —
mi «el remedio sería peor que la enfermedad» aplicaba al abort a nivel pipeline, no
al hop. O sea que existe un fix seguro y la cota estimada del run puede volverse
real.

## Gates de la iteración 3

`tsc --noEmit` 0 · `biome check src/` 0 (354 archivos) · **3364 passed | 11 skipped**
(3362 → **+2**: `T-L8` y `T-R13`; ninguna suite baja) · mutación re-medida:
`resolveComposeAgentPoolLimit() → 50` mata **5 de 7** (T-POOL-1/2/4/6/7).
