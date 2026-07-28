# HU-195 — Techo de wall-clock por request outbound (HOP, no PIPELINE)

Branch: `fix/195-outbound-wallclock-ceiling` · implementación `c7e1268` +
fix-pack del AR (este doc).

Origen: MNR-1 del AR de la HU-189, pre-existente — ningún hop outbound del
gateway tenía cota de wall-clock.

---

## 1. El agujero (resumen)

`lib/ssrf-dispatcher.ts` construía el `Agent` de undici sin `headersTimeout` ni
`bodyTimeout` (defaults de undici 8: 300 000 ms cada uno,
`node_modules/undici/lib/dispatcher/client.js:275-276`) y `middleware/timeout.ts`
sólo MANDA el 504 sin `AbortController`. Y `bodyTimeout` es un timeout de
**INACTIVIDAD**: undici lo REFRESCA en cada chunk (`client-h1.js` `onBody` →
`this.timeout.refresh()`), así que un peer que emite 1 byte cada 299 s clavaba el
socket **y el worker del pipeline** indefinidamente, hasta 5 hops por request.

Fix: `OUTBOUND_HOP_TIMEOUT_MS` (default 60 000) gobernando los **dos ejes**
(inactividad en el `Agent` + wall-clock con `AbortSignal` en el `fetch`).
Detalle en `src/lib/outbound-timeout.ts`.

**ALCANCE: HOP, NO PIPELINE.** El 504 sigue sin cancelar el run.

---

## 2. Inventario de egress — MÉTODO DEL BARRIDO (AR MNR-2)

La primera versión de esta tabla era **exactamente el output de
`grep -rn "fetch(" src/`**, y por eso tenía un punto ciego estructural: no puede
ver el egress que hace un SDK por su cuenta. El barrido de esta versión fue:

| Paso | Comando / criterio | Qué encuentra |
|---|---|---|
| 1 | `grep -rn "fetch(" --include=*.ts src/` | llamadas HTTP escritas a mano (14 sitios) |
| 2 | `grep -rn "ssrfFetch("` | los sitios que ya pasan por el wrapper con guard (5) |
| 3 | `grep -rn "createClient\|new Connection(\|createPublicClient(\|createWalletClient("` | clientes de SDK que hacen su **propio** egress |
| 4 | `grep -rln "openai\|anthropic\|axios\|node-fetch\|got("` | librerías HTTP de terceros |
| 5 | `grep -rn "LLM_TIMEOUT_MS\|FACILITATOR_TIMEOUT_MS\|AbortSignal.timeout"` | qué cota tiene cada sitio ya encontrado |

**Lo que NINGUNO de estos pasos puede ver, y hay que aceptar como límite del
método**: el egress que ocurre DENTRO de una dependencia (el socket lo abre la
librería, no nuestro código). En este repo son 4 casos —`supabase-js`,
`@anthropic-ai/sdk`, `viem` y `@solana/web3.js`— y se encuentran sólo por el
paso 3/4 (por el CONSTRUCTOR del cliente), nunca por el paso 1. El paso 3 fue
justamente el que agregó `lib/supabase.ts:33` a esta tabla: `createClient<Database>(`
**no matchea** `grep "createClient("` por el genérico, que es la misma clase de
falso-negativo que motivó este hallazgo.

### 2.1 CUBIERTO por `OUTBOUND_HOP_TIMEOUT_MS` (vía `ssrfFetch`)

| # | Sitio | Qué es |
|---|---|---|
| 1 | `services/compose.ts:1106` | hop de invoke del agente (**el agujero original**) |
| 2 | `services/discovery.ts:543` | fanout de registries |
| 3 | `services/discovery.ts:656` | `getAgent` por registry |
| 4 | `mcp/tools/get-payment-quote.ts:38` | probe MCP |
| 5 | `mcp/tools/pay-x402.ts:72` | probe MCP de pago |

Un presupuesto por llamada, COMPARTIDO por los hasta 5 hops de redirect, e
incluye el pre-flight SSRF de cada hop (con su fase de DNS — ver §3).

### 2.2 EXCLUIDO, con la razón de cada uno

| # | Sitio | Cota que YA tiene | Por qué queda afuera |
|---|---|---|---|
| 6 | `adapters/avalanche/payment.ts:278` `/verify` | `AbortSignal.timeout(FACILITATOR_TIMEOUT_MS)` = 30 s (`:282`) | ya acotado + settlement |
| 7 | `adapters/avalanche/payment.ts:324` `/settle` | 30 s (`:328`) | ya acotado + settlement |
| 8 | `adapters/base/payment.ts:299` `/verify` | 30 s (`:303`) | ya acotado + settlement |
| 9 | `adapters/base/payment.ts:345` `/settle` | 30 s (`:349`) | ya acotado + settlement |
| 10 | `adapters/tempo/payment.ts:235` `/verify` | 30 s (`:239`) | ya acotado + settlement |
| 11 | `adapters/tempo/payment.ts:277` `/settle` | 30 s (`:281`) | ya acotado + settlement |
| 12 | `adapters/kite-ozone/payment.ts:548` `/verify` (modo x402) | `X402_FACILITATOR_TIMEOUT_MS` = 30 s (`:552`) | ya acotado + settlement |
| 13 | `adapters/kite-ozone/payment.ts:590` `/settle` (modo x402) | 30 s (`:594`) | ya acotado + settlement |
| 14 | **`adapters/kite-ozone/payment.ts:317` `/verify` (modo pieverse)** | **NINGUNA** | gap residual — ver §4 |
| 15 | **`adapters/kite-ozone/payment.ts:362` `/settle` (modo pieverse)** | **NINGUNA** | gap residual — ver §4 |
| 16 | `adapters/kite-ozone/gasless.ts:124` `/tokens` | `AbortSignal.timeout(5000)` (`:125`) | ya acotado |
| 17 | `adapters/kite-ozone/gasless.ts:200` `/submit` | `AbortSignal.timeout(15000)` (`:204`) | ya acotado |
| 18 | `lib/gas-overhead.ts:285` (CoinGecko) | `PRICE_HOP_TIMEOUT_MS` (2 500 ms) | tiene su PROPIO techo, deliberadamente distinto — ver §5 |
| 19 | **`lib/supabase.ts:33` `createClient<Database>(url, key, …)`** | **NINGUNA** | ver abajo |
| 20 | LLM (4 call-sites vía `@anthropic-ai/sdk`, p.ej. `services/llm/input-retry.ts:86-98`) | `AbortController` + `LLM_TIMEOUT_MS` = 30 s | ya acotado |
| 21 | RPC EVM (`lib/rpc-transport.ts` → `viem` `http()`) | 10 s por default de viem (`viem/_cjs/clients/transports/http.js:26`) | ya acotado |
| 22 | `adapters/solana/chain.ts:75` `new Connection(...)` | **NINGUNA** | settlement (Solana web3.js) — gap reportado |

**#19 — `lib/supabase.ts:33` (AR MNR-2).** `createClient` se construye sin
`global.fetch` propio y sin timeout, así que `supabase-js` usa el `fetch` global
de Node → rigen los defaults de undici. Consecuencia real: **todo el money-path
de DB (débitos, refunds, ledger) corre sin cota de wall-clock**. Queda EXCLUIDO
de esta HU, y la razón NO es que sea inofensivo:

* el host es `SUPABASE_URL`, una env del operador: **no es atacante-influenciable**
  (el vector de esta HU es el hostname que llega por `POST /registries` o por
  `agent.invokeUrl`);
* acotar el DB client es un cambio de disponibilidad del money-path (¿qué hace un
  débito cuyo POST se abortó a mitad? es el mismo problema de "estado unknown"
  que §4), y necesita su propia HU con su decisión de reconciliación.

Lo que NO es aceptable es que la tabla no lo mencione: el barrido por `fetch(`
no lo veía, y "no aparece en el barrido" se leía como "no existe".

---

## 3. Qué cubre el techo, EXACTAMENTE (AR BLQ-BAJO-3)

El claim original (`.env.example` y `lib/outbound-timeout.ts`) decía "techo de
wall-clock de UN request outbound del gateway". **Era más ancho que la realidad.**
Medido por el AR con `node:dns` mockeado a 1 500 ms y `OUTBOUND_HOP_TIMEOUT_MS=200`:
`elapsedMs=1505` contra un techo declarado de 200 → **7.5× el techo**, y el
`signal` ya estaba abortado cuando el `fetch` arrancaba. La causa:
`ssrf-dispatcher.ts` hacía `await assertUrlAllowed(currentUrl)` DENTRO del loop
pero **fuera** del signal, y `url-validator.ts:296` hace `dns.lookup` sin timeout.

**Corregido en el fix-pack**: el pre-flight corre dentro del mismo presupuesto
(`assertUrlAllowedWithinBudget`, `ssrf-dispatcher.ts`). El guard NO se debilitó:
`assertUrlAllowed` sigue corriendo por hop ANTES de abrir el socket; lo único que
cambia es que agotar el presupuesto durante el DNS falla el hop (fail-closed) en
vez de esperar sin cota. Tests: `T-195-DNS-1/2/3`.

**RESIDUAL, follow-up con su propia HU**: `dns.lookup` no acepta `signal` y corre
en el threadpool de libuv (4 threads por default, compartidos con fs/crypto/zlib),
así que la carrera acota **lo que espera el gateway, no el slot del threadpool**:
un resolver lento sigue ocupando su thread hasta que contesta. Cerrarlo requiere
`dns.Resolver` con `timeout`, que cambia la semántica de resolución (deja de usar
`/etc/hosts` y NSS, contra la CD-A7 de `url-validator.ts`) y puede cambiar la
CLASIFICACIÓN SSRF de un host — eso es una HU aparte, no un fix-pack.

---

## 4. Gap residual: `/verify` y `/settle` de Kite en modo `pieverse` (AR MNR-3)

`adapters/kite-ozone/payment.ts:317` y `:362` siguen **sin cota**.

**La justificación original era mecánicamente incorrecta.** Decía que "acotarlo
cancelaría plata en vuelo": **falso**. Abortar el request HTTP al facilitator NO
cancela un broadcast; sólo deja al gateway **CIEGO** al resultado (estado
`unknown`). Y contradecía 4 precedentes del propio repo, que ya acotan `/settle` a
30 s (`base:349`, `avalanche:328`, `tempo:281`, `kite-x402:594`).

**El dato que faltaba y agrava el gap**: `KITE_FACILITATOR_MODE` tiene default
**`pieverse`** (`getFacilitatorMode()`, `payment.ts:66`; `.env.example`:
`KITE_FACILITATOR_MODE=pieverse` — *"current production path"*). O sea que los 2
sitios sin cota son el **camino VIVO**, no código muerto.

**Razón real de la exclusión**: pasar de "sin cota" a "cota + estado `unknown`"
exige decidir qué hace el gateway con un settle de resultado desconocido
(¿reconcilia?, ¿reintenta?, ¿marca para revisión?). Eso es una HU de money-path
con su propia AR, no un timeout puesto de paso en un fix-pack.

---

## 5. Por qué el hop de CoinGecko tiene un techo DISTINTO (AR BLQ-BAJO-2)

`lib/gas-overhead.ts` usa `PRICE_HOP_TIMEOUT_MS` (= `LIVE_CALC_TIMEOUT_MS` + 500),
**estrictamente mayor** que el presupuesto de su propia `Promise.race`, y eso es
una decisión de semántica de dinero:

* La primera versión del fix usaba `AbortSignal.timeout(LIVE_CALC_TIMEOUT_MS)` y
  afirmaba "cero cambio en el valor devuelto". **Era falso.** Con CoinGecko
  colgado: pre-HU-195 → `result=0 elapsedMs=2004` (la race rechaza, valor
  irresoluble); con ese techo → `result=0.06 elapsedMs=2003` (el abort hace
  ALCANZABLE el fallback `<SYM>_USD_FALLBACK` y la race RESUELVE).
* Impacto: en producción `getStepGasOverheadUsd` lanzaba
  `GasOverheadUnavailableError` (fail-closed G-02, *"Refusing to settle"*) y pasó
  a devolver un valor **cacheado 60 s**. Un guard etiquetado fail-closed se
  convirtió en fail-open-con-fallback sin que nadie lo decidiera.
* La solución intuitiva NO sirve: acotar el hop POR DEBAJO del presupuesto de la
  race (1.8 s contra 2 s) hace que el fetch rechace ANTES y el fallback resuelva
  igual. El abort tiene que ocurrir **DESPUÉS** de que la race se rindió.
* Post-fix-pack: `result=0 elapsedMs=2003` (idéntico a pre-HU-195) y el socket
  muere a los ~2 500 ms. Candados: `T-195-GAS-2/3/4`.

---

## 6. RIESGO CONOCIDO — cobro sin entrega y sin refund para el caller x402 puro (AR MNR-1)

**NO se arregla en esta HU: necesita una decisión de producto.**

Es un bug **pre-existente** con **gatillo nuevo**:

* Para un caller **x402 puro**, el settle inbound ocurre en el middleware ANTES
  del handler (`src/middleware/x402.ts:568`) — o sea que la plata ya se movió
  on-chain cuando el compose arranca.
* `refundComposeStep0` hace **early-return sin `a2aKeyRow`**
  (`src/routes/compose.ts:319-328`): el camino de refund existe sólo para el
  caller con agent key prepaga.

**Condición de disparo (nueva por esta HU)**: un hop de invoke que antes tardaba
entre 61 s y 300 s y **entregaba** ahora es abortado a los 60 s. Resultado: el
caller x402 puro queda **cobrado on-chain, sin entrega y sin camino de refund**.

Antes de la HU ese caller esperaba (hasta 300 s de inactividad, o para siempre
con trickle-feed) y a veces recibía la entrega. El fix cambia "espera indefinida
que a veces entrega" por "falla acotada que no devuelve la plata". Las dos son
malas; cuál es peor es una decisión del founder, y las opciones (bajar/subir el
techo, extender el refund al caller x402, encolar el refund en el outbox de la
HU-194) tienen implicancias distintas de money-path.

**Estado**: abierto, documentado, sin fix silencioso.
