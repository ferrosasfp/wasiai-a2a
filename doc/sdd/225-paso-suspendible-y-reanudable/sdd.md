# SDD — [WKH-PENDIENTE] Paso suspendible y reanudable · **CORTE A** (`wasiai-a2a`)

> **Fase**: F2 · **SDD_MODE**: `full` · **Modo**: QUALITY (variante con dos focos de AR declarados)
> **Worktree**: `/home/ferdev/.openclaw/workspace/wt-225` · **Rama**: `feat/225-paso-suspendible-y-reanudable`
> **Base**: `5578998` · **Fecha**: 2026-08-23
> **Input**: `doc/sdd/225-paso-suspendible-y-reanudable/work-item.md` (497 líneas, leído completo)

---

## ⛔ CÓMO LEER ESTE DOCUMENTO

El F1 corrió **sin shell** y marcó cada cita `[MEDIDO]` / `[HEREDADO]` / `[NO MEDIDO]`. Este F2 **sí
tiene shell**. Regla que se aplicó:

- **Toda cita de este SDD está verificada con `sed`/`grep` sobre el árbol de `wt-225`**, salvo lo que
  diga explícitamente lo contrario.
- Donde el work-item traía `[NO MEDIDO]` y la medición **contradice** al work-item, se dice así,
  fuerte, con el comando y el control positivo. Hay **tres** casos y uno de ellos derriba el
  hallazgo que el F1 llamaba "el más caro" (DT-6).
- ⚠️ **`grep` bajo el hook `rtk` deforma la salida** de este entorno (mezcla números de línea con
  contenido). Todos los barridos de este documento se re-corrieron con **`/usr/bin/grep`** cuando la
  salida era ambigua. Los conteos de abajo salen de esas corridas.

**Alcance**: SÓLO el corte A (ítems 1-5 del checklist + la clasificación en código del 6).
⛔ El corte B (ítems 6-ops, 7, 8) **no se diseña acá**: su bloqueante MI-2 —la decisión (a)/(b) del
`decisionToken`— es del founder y no fue tomada. Donde el corte A obliga a anticipar algo del corte
B, se declara como **riesgo** y se sigue (§11).

---

## 1. Context Map — qué se leyó y qué patrón salió de ahí

| # | Archivo (verificado con `sed`/`ls`) | Por qué se leyó | Patrón / hecho extraído |
|---|---|---|---|
| 1 | `src/services/compose.ts` (1804 líneas) | Es el bucle donde se decide el desenlace y donde vive el débito per-step | Envoltura `compose()` `:205-244`; `if (!result.success) recordStrandedRunIfAny` `:230`; camino del throw `:237-243`; `executePipeline` `:313-320`; estado local `:367-372`; guard `i > 0` `:571`; `try` del step `:698`, `catch` `:733`; `finishSuccessfulStep` `:1213`; `invokeAgent` `:1478`; fetch `:1738`; **settle `:1785`** |
| 2 | `src/types/index.ts` (2318 líneas) | El contrato que hay que ampliar sin romperlo | `ComposeResult.success: boolean` `:1181`; `errorCode` unión CERRADA de 5 `:1207-1212`; `StepResult` `:1265+`; *"lo leen consumidores fuera de este repo"* `:1290-1291`; `TaskState` incluye `'input-required'` `:2027`; `AgentLinkRow` `:1610-1627`; `AgentLinkClaim` `:1671-1679` |
| 3 | `src/routes/compose.ts` (1282 líneas) | El mapeo a HTTP y la interacción con el refund del step-0 | `createTimeoutHandler(TIMEOUT_COMPOSE_MS ?? '180000')` `:913-915`; `refundComposeStep0` `:541`; llamada a compose `:1034`; `if (reply.sent)` `:1088`; `if (!result.success)` `:1092`; mapeo de status `:1109-1113`; `reply.status(status).send({...result})` `:1127-1128`; bloque de fee `:1167+`; `reply.send({...result, ...})` `:1270-1276` |
| 4 | `src/services/orchestrate-quote.ts` (406 líneas) | Exemplar de firma HMAC + binding + orden load-bearing (DT-4) | Docblock LEAF `:26-27`; `QUOTE_TTL_SECONDS = 600` `:41` **sin override por env a propósito** `:37-40`; `QUOTE_CLOCK_SKEW_SECONDS = 60` `:44`; `quoteHmacKey()` sin fallback `:117-125`; `resolveQuoteCaller` `:136`; **orden load-bearing de 7 pasos** `:331-343`; `verifyQuote` `:345`; `timingSafeEqual` vía `hexEqual` |
| 5 | `src/lib/compose-limits.ts` (38 líneas, LEAF) | Exemplar de CD-13 y origen de DT-6 | `MAX_COMPOSE_STEPS = 5` `:38`; **docblock que nombra `ESTIMATED_MAX_RUN_WALL_CLOCK_MS` `:14` y `:33`** — ver §3, DT-6-BIS |
| 6 | `src/lib/stranded-payment.ts` (373 líneas, LEAF) | AC-7 y CD-12 | `COMPOSE_STRANDED_PAYMENT_EVENT` `:44`; ⛔ prohibición de mezclarlo con `SETTLE_UNKNOWN_EVENT_TYPES` `:37-43`; `collectStrandedSteps` `:172` (lee `downstreamTxHash`); `buildStrandedPaymentEvent` `:226`; `MAX_STRANDABLE_STEPS_ANY_PATH` `:86-87` |
| 7 | `src/services/stranded-alert.ts` (341 líneas) | Verificar que CD-2 protege una alerta real | `refreshStrandedExposure` `:228+`; `breached = truncated \|\| exposureUsd > thresholdUsd` `:243`; *"un canal que grita siempre es un canal que se aprende a ignorar"* `:288-290` |
| 8 | `src/lib/capability-risk.ts` (170 líneas) | AC-10 / DT-7 | `NON_DISBURSEMENT_CAPABILITIES` `:89-99` (9 entradas, **ninguna es `kyc-hosted-redirect`**); docblock que exige **una fuente por entrada** `:70-87` y el precedente `cashout-match` `:84-87`; `classifyCapabilities` `:137-154`; `needsTightTrialQuota` `:166-170`; **cita a `doc/sdd/_INDEX.md:144`** en `:81-82` |
| 9 | `supabase/migrations/20260706000000_wkh137_agent_links.sql` (184 líneas) | **El exemplar central de DT-3** | Tabla `:19-40`; RLS deny-by-default `:44`; `claim_agent_link` `:59-115` con **`FOR UPDATE` `:87`** y **`IF v_status = 'open' AND NOW() >= v_expires` `:93`**; `settle_agent_link` `:133-177` con **status-gate `:158-160`** y `reopen` `:167-169`; hardening `search_path`/`REVOKE`/`GRANT` `:117-122`, `:179-184` |
| 10 | `src/services/agent-link.ts` (≈520 líneas) | Cómo se consume ese exemplar desde TS | `maxTtlSeconds()` default **86400** `:143-146`; **`let ttl = maxTtlSeconds()`** (el default ES el máximo) `:180`; `expiresAtIso = new Date(Date.now() + ttl*1000)` **`:195` ← el ÚNICO sitio sensible al reloj**; pre-claim fast-fail Node-side `:317-326`; `claim_agent_link` `:494` |
| 11 | `src/routes/agent-links.ts` | Precedente EXACTO del mapeo HTTP de esta máquina de estados | `404 LINK_NOT_FOUND` `:174`; **`410 LINK_EXPIRED` `:178`**; **`409 LINK_ALREADY_USED` `:181`**; `503` retryable `:191-194`; ⚠️ toma el token del **path** (`req.params.token` `:164`) — **de acá se DIVERGE a propósito**, ver CD-8 |
| 12 | `src/adapters/solana/settle-ledger.ts` (657 líneas) | Resolver MI-3 | *"el reloj del lease es el de **Postgres**, no el de Node"* `:22-24`; fail-closed `:29-33`; ninguna función devuelve `boolean` `:34-36`; `LEASE_MS_DEFAULT = 120_000` `:59`; `resolveSettleLeaseMs` `:139-143`; ***"seguro por DEMOSTRACION, no por tiempo … El lease solo evita que dos procesos vivos se pisen"* `:485-491`** |
| 13 | `src/adapters/solana/payment.ts` (>1600 líneas) | Resolver MI-3 | **`// WKH-307: la idempotencia dejo de ser un Map de proceso y paso a una tabla` `:38-39`**; **`ya no hay nada de idempotencia que limpiar en memoria (el estado vive en a2a_solana_settle_intents)` `:1638-1639`** |
| 14 | `src/lib/outbound-timeout.ts` | La cota de wall-clock que SÍ existe | `DEFAULT_OUTBOUND_HOP_TIMEOUT_MS = 60_000` `:83`; **`60 s × MAX_COMPOSE_STEPS (5) = 300 s: el PEOR caso de un run completo` `:78`** |
| 15 | `src/services/reconciliation.ts` | AC-11 | `AmbiguousReport` `:317`; ensamblado `:675-684`; `listSettleUnknown` `:732-761`; **cross-tenant DELIBERADO gateado por `requireAdminToken` `:722-723`**; `listStrandedRuns` `:788+`; TD-203-01 (sin índice por `event_type`) `:726-731` |
| 16 | `src/services/inbound-task.ts` | **Consumidor del desenlace que el F1 NO tenía** | `CD-10: fail-closed — toda salida ≠ pipeline.success===true ⇒ 'failed'` `:21`; `if (result.pipeline.success === true)` `:518`; `safeMarkFailed` `:540-542` |
| 17 | `src/services/agent-link.ts` (2ª lectura) + `src/services/verification.ts` | Ídem | `success: result.pipeline.success` `:134`; `result.pipeline.success === false && totalCostUsdc === 0 ⇒ reopen` `:422-424`; **`verification.ts:70`: `if (o.success === false) return true` sobre el output DEL AGENTE** |
| 18 | `mcp-servers/wasiai-x402/src/synthetic-tx-monitor.mjs` | Ídem | `return pipeline.success === false;` `:85`, con docblock *"Absent/true is not [a failure signal]"* `:75` |
| 19 | `src/mcp/tools/orchestrate.ts` | El "mapper" del F1 (su consumidor #6) | **NO lee `success`**: sólo mapea `result.pipeline.steps` `:36-44`. Un campo aditivo no lo toca |
| 20 | `src/types/database.types.ts` (>3000 líneas) | Requisito de tipos del cliente instalado | `Tables.a2a_agent_links` `:489`; `Functions:` `:2866`; `reclaim_solana_settle_intent` `:2921`; `claim_agent_link` `:2987`; `settle_agent_link` `:2999` |
| 21 | `test/ownership-filter-guard.scanner.ts` (16 KB) | Cómo entra la tabla nueva al guardián | `deriveTables(typesSrc)` **`:243-283`** — el universo sale de `database.types.ts`, `owner_ref` a **10 espacios** dentro del bloque `Row` `:277`; lo que el escáner NO ve `:16-36` |
| 22 | `test/agent-links.migration.test.ts` | Exemplar de test estructural de migración | 100% mock sobre el `.sql` `:1-10`; asserts de RLS `:25-31`, CHECK `:33-37`, `SECURITY DEFINER`×2 y `FOR UPDATE;`×2 `:44-52` |
| 23 | `test/readme-numbers.test.ts` | 🔴 **Dependencia mecánica que nadie adivina** | Clava **archivos de test**, **variables de `.env.example`** y **archivos que linta Biome**, derivados del repo en cada `npm test` `:22-31` |
| 24 | `README.md` | Los tres números que esta HU mueve | **186 variables** `:351` · **303 test files** `:378` · **501 files** lintados `:383` (y su espejo en `README.es.md`, verificado por `test/readme-parity.test.ts`) |
| 25 | `.github/workflows/ci.yml` | 🔴 El gate real del repo | 7 pasos: `npm ci` → `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` → sub-paquete `mcp-servers/wasiai-x402` → sub-paquete `packages/agent-sdk` `:33-83` |
| 26 | `package.json` / `package-lock.json` | §8.1 | **NO existe script `qa`** (medido, ver §8.2); `@supabase/supabase-js` resuelto a **2.101.1** (`package-lock.json:829-830`) |
| 27 | `node_modules/@supabase/supabase-js/dist/index.d.mts` (checkout principal) | §8.1 — API de la versión INSTALADA | **`rpc<FnName extends string & keyof Schema['Functions'], …>` `:512-517`** |
| 28 | `wasiai-remittance-agents/src/manifest/registry.ts` | La FUENTE que AC-10 exige | `kyc-hosted-redirect` **`:76`**, `legacy-single-shot-kyc` **`:77`**, con el docblock que explica los dos caminos `:71-75`; *"COPIA MANUAL … nada la sincroniza"* `:36-42` |
| 29 | `.nexus/project-context.md` (668 líneas, **leído del checkout principal**) | Stack | bdwv/caldz `:97-101`; banderas `=== 'true'` `:252-268`; `input-required` `:370`; `_down.sql` `:403`; sin `REDIS_URL` `:597` |
| 30 | `doc/sdd/_INDEX.md` | CD-14 / G-F1 | **`:144` = la fila `157`**, que contiene `remit.corridor-discovery` — exactamente la línea que `capability-risk.ts:81-82` cita |

### ⚠️ Deriva de entorno detectada (no bloqueante, se reporta)

`.nexus/project-context.md` **no existe en el worktree `wt-225`** (está gitignoreado; vive sólo en el
checkout principal `/home/ferdev/.openclaw/workspace/wasiai-a2a/.nexus/project-context.md`, 668
líneas). Un sub-agente que trabaje sólo en el worktree **no puede leer la fuente de verdad del
stack**. Este SDD la leyó del checkout principal. Ponerlo en el Story File.

---

## 2. Los cuatro Missing Inputs — resueltos, con la medición

### 🔴 MI-3 — El TTL de la suspensión. **RESUELTO. Y el bloqueante que el F1 describía NO EXISTE.**

El work-item dice, textual: *"a resolver en F2 **con medición**, no por elección"*, y DT-6 lo llama
*"el hallazgo más caro de este F1"*. Se midió. **La premisa de DT-6 es un docblock rancio.**

#### Medición 1 — la constante que DT-6 invoca no existe en el repo

```
$ /usr/bin/grep -rn "WALL_CLOCK\|wallClock\|wall_clock" src/ test/ scripts/
src/lib/compose-limits.ts:14   *   · `adapters/solana/payment.ts` — factor de `ESTIMATED_MAX_RUN_WALL_CLOCK_MS`
src/lib/compose-limits.ts:33   * ⚠️ Si lo subís: re-revisá `ESTIMATED_MAX_RUN_WALL_CLOCK_MS` en
src/lib/ssrf-dispatcher.ts:411 const wallClockSignal = outboundWallClockSignal(init?.signal);   ← otra cosa
src/services/compose.test.ts:4089  const wallClockStart = Date.now();                            ← otra cosa
```

`ESTIMATED_MAX_RUN_WALL_CLOCK_MS` aparece **exactamente dos veces, las dos dentro del docblock de
`compose-limits.ts` que dice dónde vive** — y **cero veces en `src/adapters/solana/payment.ts`**,
que es donde el docblock afirma que vive.

**Control positivo del instrumento, en la misma corrida** (un cero sin control no es evidencia):
`grep -c "idempot" src/adapters/solana/payment.ts` → **9**. El `grep` lee ese archivo.

#### Medición 2 — por qué no existe, dicho por el código que lo reemplazó

- `src/adapters/solana/payment.ts:38-39`: *"WKH-307: la idempotencia dejo de ser un Map de proceso
  y paso a una tabla. Todo el acceso a datos del adapter vive en `settle-ledger.ts` (CD-7)."*
- `src/adapters/solana/payment.ts:1638-1639`: *"WKH-307: ya no hay nada de idempotencia que limpiar
  en memoria (el estado vive en `a2a_solana_settle_intents`)."*

⇒ **El "TTL del Map de idempotencia" que DT-6 teme que expire mientras el run sigue vivo ya no
existe.** El camino (c) de DT-6 ("apoyarse en el ledger durable") **no es una opción a elegir: es el
estado actual del código desde WKH-307.**

#### Medición 3 — lo único con reloj que queda, y por qué no toca a un run suspendido

`src/adapters/solana/settle-ledger.ts:59` — `LEASE_MS_DEFAULT = 120_000` (env
`SOLANA_SETTLE_LEDGER_LEASE_MS`, `:139-143`). Y su propio docblock dice qué protege:

> `settle-ledger.ts:485-491` — *"Tomar un reclamo vencido es seguro por **DEMOSTRACION, no por
> tiempo**: una fila `claimed` no tiene firma, y la firma se persiste ANTES de transmitir
> (invariante I2) ⟹ una fila `claimed` prueba que nunca se transmitio nada. **El lease solo evita
> que dos procesos vivos se pisen.**"*

Y un run suspendido **no tiene ningún claim en vuelo**, por dos hechos medidos:
1. el settle del step que suspende **ya terminó** cuando se lee su respuesta: en `invokeAgent` el
   `fetch` está en `compose.ts:1738`, el parseo del body en `:1760`, y `signAndSettleDownstream`
   recién en **`:1785`**. Cuando la suspensión se decide (después de `invokeAgent`, §4/DT-A1), el
   leg de ese step ya cerró;
2. los steps `i+1..N` usan `intentId` **distintos** — `` `${composeRunId}:${i}` `` (`compose.ts:704`).

⇒ **No hay ninguna entrada de idempotencia que pueda expirar mientras el run está suspendido.**

#### Medición 4 — contra qué reloj se compara el TTL, y qué pasa si difieren

| Sitio | Qué compara | Reloj | Autoritativo |
|---|---|---|---|
| `…wkh137_agent_links.sql:93` | `NOW() >= v_expires`, **dentro del `FOR UPDATE` `:87`** | **Postgres** | ✅ **SÍ** |
| `src/services/agent-link.ts:324` | `Date.now() >= new Date(link.expires_at)` | Node | ❌ NO — es "pre-claim fast-fail (cero DB write)" (`:317`) |
| `src/services/agent-link.ts:195` | **escribe** `expires_at = new Date(Date.now() + ttl*1000)` | **Node** | 🔴 **el único sitio sensible a skew** |

⇒ En la lectura, ambos lados de la comparación salen del **mismo** reloj (Postgres), así que un skew
node↔DB **no puede** volver reanudable un run vencido ni al revés. El único punto donde el skew se
cuela es la **escritura** del `expires_at`: la ventana efectiva queda `Node_now + TTL` medida contra
`PG_now`, o sea corrida por δ.

Magnitud de δ que el repo ya asume: **`QUOTE_CLOCK_SKEW_SECONDS = 60`**
(`orchestrate-quote.ts:44`, *"Tolerancia de `iat` en el futuro, por deriva de reloj entre
instancias"*).

**Decisión (DT-A6)**: el `expires_at` **lo escribe Postgres**, no Node — columna `ttl_seconds` +
trigger `BEFORE INSERT`. Cuesta 6 líneas de SQL y hace que la respuesta a MI-3 sea *"el TTL nunca
toca el reloj de Node"* de forma **exacta**, no aproximada. Es una mejora sobre el exemplar, no una
copia de su defecto.

#### El número, derivado

| Cota | Valor | De dónde sale (MEDIDO) |
|---|---|---|
| **Piso duro** | **> 180 s** | `TIMEOUT_COMPOSE_MS` default `180000` (`routes/compose.ts:914`). Por debajo del 504 del propio `/compose`, la suspensión no compra **nada** sobre esperar dentro del request |
| Referencia de wall-clock de un run | 300 s | `outbound-timeout.ts:78`: *"60 s × `MAX_COMPOSE_STEPS` (5) = 300 s: el PEOR caso de un run completo"*. **Ésta sí existe** (a diferencia de los "25 min" de DT-6) y **no acota** el TTL: acota el trabajo, no la espera |
| **Techo de la clase** | **86400 s** | **Dos sitios independientes con el mismo número, los dos para "una credencial con la que una persona vuelve"**: `agent-link.ts:145` (`LINK_MAX_TTL_SECONDS ?? 86400`) y `key-session.ts:72` (`SESSION_MAX_TTL_SECONDS ?? 86400`), y el primero se declara *"espejo de `maxTtlSeconds` en key-session.ts"* (`:141-142`) |
| Forma del default | **default = máximo** | `agent-link.ts:180`: `let ttl = maxTtlSeconds();` — si el caller no pide TTL, recibe el máximo |
| 🔴 **Techo condicional del money-path** | **`QUOTE_TTL_SECONDS = 600`** | `orchestrate-quote.ts:41`, **sin override por env A PROPÓSITO** (`:37-40`: *"una variable que alargue esta ventana sería una palanca silenciosa sobre el money-path"*). Un run que suspendió llevando `frozenStepPricesUsd` y se reanuda **después** de los 600 s honraría una garantía de precio vencida |

**⇒ Resolución de MI-3, en una línea:**

```
expires_at  :=  now()  +  make_interval(secs => LEAST(ttl_pedido, SUSPEND_MAX_TTL_SECONDS))
SUSPEND_MAX_TTL_SECONDS  = env SUSPEND_MAX_TTL_SECONDS ?? 86400   (fail-safe NaN/<=0 → 86400)
SUSPEND_MIN_TTL_SECONDS  = 181   (piso duro: TIMEOUT_COMPOSE_MS/1000 + 1)
default cuando el caller no pide  = SUSPEND_MAX_TTL_SECONDS   (forma de agent-link.ts:180)
```

**y, además, el invariante que hace falta y que no está en ningún AC** (se agrega como **CD-15**):

> Si el run llevaba `frozenStepPricesUsd`, `expires_at` se **acota además** por el `exp` del quote que
> los congeló. Un pipeline reanudado **nunca** puede debitar un precio congelado cuya garantía venció.
> Se implementa pasando ese instante al `open` y tomando el `LEAST` en Postgres.

⚠️ **Deuda que este hallazgo abre y que NO se arregla acá** (`TD-225-02`): el docblock de
`src/lib/compose-limits.ts:11-27` describe un mecanismo que WKH-307 borró. Es exactamente el modo de
falla "la cadena envejece sola": nadie editó esa frase y se volvió falsa. **Arreglarla es un cambio a
un LEAF del money-path en la misma HU que estrena estado durable** ⇒ va a HU aparte, con su fila.
Este SDD la deja documentada acá y en el reporte de cierre.

---

### 🔴 MI-5 — Barrido exhaustivo de consumidores del desenlace. **RESUELTO. Son 11, no 6.**

Comando (raíz del worktree, sin tests):

```
/usr/bin/grep -rn "result\.success\|pipeline\.success\|composeResult\.success\|\.success ===\|!res\.success\|res\.success" \
  src/ packages/ mcp-servers/ scripts/ --include=*.ts --include=*.mjs --include=*.js \
  | grep -v "\.test\.ts" | grep -v node_modules
```

**Control positivo** (un barrido que da poco tiene que probar que ve algo):
`grep -rn "\bsteps\b" src/ --include=*.ts | grep -v test | wc -l` → **284**. Y el barrido de
`StepResult` en no-test devuelve **28** sitios en 9 archivos. El instrumento lee el árbol.

| # | Sitio | Qué decide | ¿Estaba en el F1? | Efecto de un tercer estado |
|---|---|---|---|---|
| 1 | `src/services/compose.ts:230` | `if (!result.success) recordStrandedRunIfAny` | ✅ (#3) | **AC-1**: con `success:true` esta línea es no-op ⇒ **cero diff** |
| 2 | `src/services/compose.ts:237-243` | camino del throw ⇒ también registra residuo | ✅ (#4) | Sin cambios: la suspensión **no** viaja por throw (DT-A1) |
| 3 | `src/routes/compose.ts:1088` | `if (reply.sent)` (504) ⇒ refund | ✅ (#2) | La rama nueva va **después** de ésta, como hoy |
| 4 | `src/routes/compose.ts:1092` | `if (!result.success)` ⇒ refund step-0 + 400/402/403 | ✅ (#1) | La rama nueva va **antes** ⇒ un suspendido no llega acá |
| 5 | `src/routes/compose.ts:1167-1226` | **el cobro del fee de protocolo** sobre `result.totalCostUsdc` | ❌ **NO** | 🔴 **hallazgo**: si un suspendido tomara el camino de éxito, se cobraría el fee sobre el pipeline PARCIAL y **otra vez** al reanudar. Ver DT-A7 |
| 6 | `src/services/orchestrate.ts:1412` | `if (pipeline.success)` ⇒ cobra el fee | ✅ (#5, parcial) | **Inalcanzable por construcción** (DT-A2) |
| 7 | `src/services/orchestrate.ts:1487` | `if (!pipeline.success)` ⇒ credit-back del step-0 | ✅ (#5, parcial) | Ídem |
| 8 | `src/services/orchestrate.ts:1663` | `status: pipeline.success ? 'success' : 'failed'` (evento) | ❌ **NO** | Ídem |
| 9 | `src/services/inbound-task.ts:518` + `:540` | 🔴 **`CD-10: fail-closed — toda salida ≠ `success===true` ⇒ 'failed'`** (`:21`) | ❌ **NO** | Un suspendido marcaría la tarea inbound como **failed** de forma irreversible. Inalcanzable por DT-A2 |
| 10 | `src/services/agent-link.ts:134` y `:422-424` | copia `success` al redeem; `success===false && cost===0 ⇒ reopen` del link | ❌ **NO** | Ídem |
| 11 | `mcp-servers/wasiai-x402/src/synthetic-tx-monitor.mjs:85` | `return pipeline.success === false` (señal de falla del monitor sintético) | ❌ **NO** | Lee `/orchestrate` ⇒ inalcanzable. Y su docblock `:75` dice *"Absent/true is not [a failure signal]"* ⇒ `true` no lo despierta |

**Además, y no es un consumidor del `ComposeResult` sino del output del AGENTE:**

> 🔴 `src/services/verification.ts:70` — `if (o.success === false) return true;` dentro de
> `hasErrorSignal`, que también dispara con **`o.error` truthy** (`:68`) y con
> `o.status ∈ {'failed','error'}` (`:71-74`).
> ⇒ **El sobre de suspensión que devuelve el agente NO puede llevar una clave `error`, ni
> `success:false`, ni `status:'failed'|'error'`**, o `verifyStepOutput` marcaría el step como
> incompleto. Se convierte en **CD-16**.

**Y consumidores fuera de este repo**: `types/index.ts:1290-1291` lo dice textual. Medido cómo
salen: `routes/compose.ts:1127-1128` y `:1270-1276` hacen `reply.send({ ...result, … })`
**sin schema de respuesta** ⇒ todo campo del `ComposeResult` sale por HTTP. Por eso el cambio es
**estrictamente aditivo**: un campo opcional nuevo, `success` sigue siendo `boolean`, la unión
`errorCode` **no gana ningún miembro** (`types/index.ts:1207-1212` queda byte-idéntica).

**Scripts que leen el desenlace** (`scripts/smoke-*.mjs`, `scripts/hackathon-e2e.mjs`): 6 sitios,
todos sobre `/orchestrate` o sobre `pipeline.success === true` en el camino feliz. Ninguno se rompe
con un campo aditivo. **Sin diff.**

---

### MI-4 — Cómo vuelve el caller. **RESUELTO: redirect-driven, escritura-única, sin polling.**

**Decisión: la reanudación es SÓLO DE ESCRITURA y SINGLE-USE. No se agrega endpoint de polling.**

Justificación, en orden de peso:

1. **AC-5 la vuelve incompatible con el polling.** La redención es single-use y su atomicidad vive
   en la base (DT-4). Un caller que pollee el endpoint de reanudación **quema** el token en el
   primer poll. No son dos diseños posibles: el AC ya eligió.
2. **Un endpoint de estado sería superficie pública nueva con su propio IDOR.** Ningún AC lo pide.
   Y la lista de runs suspendidos que AC-11 sí pide es **admin** (`requireAdminToken`), no del caller.
3. **El consumidor real ya es redirect-driven.** Los momentos 1 y 2 de WKH-233 (`POST /session` →
   pantalla del proveedor → `GET /decision`) son exactamente eso: el navegador va y vuelve, y recién
   entonces el cliente pregunta. Copiar esa forma es cero rework para el corte B.
4. **Precedente en el repo**: `agentLinkService.redeem` es escritura-única y no tiene endpoint de
   estado (`routes/agent-links.ts`).

**Consecuencia que hay que escribir y no esconder** (§11, riesgo R-3): si la red se corta *después*
de que el resume ganó el claim, el token ya está consumido y el caller no puede reintentar. Se
mitiga con el **mismo** mecanismo del exemplar y con su **misma** precondición: `settle_suspended_run`
acepta `reopen` (→ `suspended`) **sólo** desde guards que corren **antes** de cualquier débito o
invoke de los steps restantes (`…agent_links.sql:167-169` + el razonamiento de `agent-link.ts:416-421`).
Todo lo que pase después es **terminal** (`failed`), nunca se reabre (CD-8 de WKH-137).

---

### MI-6 — `tasks` en la base real. **RESUELTO POR IRRELEVANCIA, y se dice así.**

**El diseño crea tabla propia** (`a2a_suspended_runs`, DT-A3) y **no toca `tasks`**. ⇒ La
contradicción entre el código (`src/services/task.ts:19-22`, que afirma que `tasks` tiene `owner_ref`
NOT NULL + índice + RLS en prod desde WKH-54), `CLAUDE.md` (que dice lo mismo),
`.nexus/project-context.md:620-621` (ídem) y la nota de memoria `tasks-owner-ref-missing.md` (que dice
lo contrario) **no afecta a ninguna línea de este corte A**.

⚠️ **NO se declara resuelta la contradicción.** No se consultó la base. Sigue abierta y es de otra HU.
Este SDD sólo afirma que **no bloquea**. La razón de fondo para no reusar `tasks` la escribió el
propio work-item (DT-2) y se ratifica: `tasks` modela el ciclo de vida A2A **público** y el estado de
reanudación lleva material **interno de billing** (`frozenStepPricesUsd`, los `StepResult` con sus
`downstreamTxHash`, la credencial exacta del caller).

> ✅ Se conserva el vocabulario de DT-2: el **nombre del estado** que se le muestra al mundo es
> `'input-required'`, el del estándar A2A, verificado en código: `src/types/index.ts:2027`.
> El nombre del **estado interno de la fila** es `'suspended'` (DT-A3), y son cosas distintas a
> propósito: uno es protocolo, el otro es la máquina de estados de una tabla nuestra.

---

## 3. Decisiones técnicas

### 3.1 Heredadas del work-item — estado tras la medición

| DT | Veredicto de este F2 |
|---|---|
| **DT-1** — el suspendido no es `success:false` | ✅ **Se honra la letra y el motivo.** Ver DT-A1 y la nota de tensión debajo |
| **DT-2** — vocabulario `input-required`; tabla propia vs `tasks` | ✅ **Resuelto: tabla propia.** Ver MI-6 |
| **DT-3** — el exemplar es `a2a_agent_links` / `claim_agent_link` | ✅ **Confirmado leyendo la migración entera** (`…wkh137_agent_links.sql`, 184 líneas). Se copia estructura, RPCs, hardening y máquina de estados |
| **DT-4** — firma como el quote, redención NO como el quote | ✅ Confirmado. `orchestrate-quote.ts:13-24` acepta la multi-redención a propósito; acá el single-use vive en `claim_suspended_run` |
| **DT-5** — secreto HMAC propio, sin fallback | ✅ Confirmado contra `orchestrate-quote.ts:117-125`. Env `COMPOSE_RESUME_HMAC_KEY`, fail-closed |
| **DT-6** — el TTL no es libre; `MAX × 300 s` = 25 min | 🔴 **REFUTADO por medición.** Ver MI-3. La constante no existe; el Map tampoco. Sustituido por **DT-A6** |
| **DT-7** — republicar cambia la clasificación de riesgo | ✅ **Re-verificado**: `capability-risk.ts:89-99` no contiene ninguno de los dos nombres ⇒ `classifyCapability` cae en `'unclassified'` (`:116`) ⇒ `needsTightTrialQuota` da `true` (`:169`). AC-10 lo previene |
| **DT-8** — el artefacto es opaco y no se interpreta | ✅ Confirmado. Se persiste y se devuelve tal cual, sin allowlist propia, sin reescritura |

> ### ⚠️ Tensión declarada entre DT-1 y MI-5 (leer antes de revisar DT-A1)
>
> DT-1 pide *"un tercer valor explícito en el contrato de `ComposeResult`"* y rechaza a la vez
> `success:false + errorCode` **y** un booleano al lado de `success`. **Las dos alternativas que
> quedan son incompatibles entre sí**:
> - un tercer valor de verdad en `success` **rompe el contrato público** que MI-5 midió
>   (`types/index.ts:1290-1291` + `reply.send({...result})` sin schema);
> - un campo aditivo es exactamente lo que DT-1 rechazó por dejar representable `{success:true,
>   suspended:true}`.
>
> **Resolución:** se toma el campo aditivo **y se cierra el estado imposible por construcción, no
> por convención** (DT-A2: la rama es inalcanzable salvo que `ComposeRequest.suspension` esté
> presente, y eso lo construye **un solo archivo**, con un test estático que lo clava). El estado
> `{success:true, suspended:true}` **no es un estado imposible mal modelado: es el estado
> suspendido**, y `{success:false, suspended:<algo>}` sí es imposible y sí se prohíbe con un test.
> Se declara acá para que el AR lo ataque a propósito y no lo descubra.

### 3.2 Decisiones nuevas de este F2

**DT-A1 — El desenlace suspendido es un campo ADITIVO de `ComposeResult`, y `success` vale `true`.**

```ts
export interface ComposeSuspension {
  /** `id` de la fila de `a2a_suspended_runs`. NO es el token. */
  runId: string;
  /** Índice del step que suspendió. */
  step: number;
  /** DT-8: lo que devolvió el agente, TAL CUAL. El gateway no lo interpreta. */
  artifact: unknown;
  /** ISO-8601. Lo escribió POSTGRES (DT-A6), no este proceso. */
  expiresAt: string;
  /** Vocabulario del estándar A2A (`types/index.ts:2027`). Constante, para el cliente. */
  state: 'input-required';
}
export interface ComposeResult {
  success: boolean;                 // ← SIN CAMBIOS
  …
  errorCode?: …;                    // ← SIN CAMBIOS, la unión no gana miembros
  /** WKH-225 — presente ⟹ el pipeline NO terminó: está esperando a una persona. */
  suspended?: ComposeSuspension;
}
```

`success: true` es la **única** de las dos opciones que cumple **CD-2 al pie de la letra** y además
su **motivo**: con `success:true`, `compose.ts:230` (`if (!result.success)`) es un no-op ⇒ **cero
eventos `compose_stranded_payment` y cero diff en esa línea** (AC-1 sale gratis).
⛔ Y NO se elige "porque queda lindo": `success:false` está prohibido por CD-2 y no es negociable.

*Rechazada — `compose()` lanza un `PipelineSuspendedError`*: obligaría a tocar el `catch` de
`compose.ts:237-243` (que registra residuo) y a poner un `try` alrededor de
`services/orchestrate.ts:1359`, o sea meter a `/orchestrate` —que es **Scope OUT**— dentro del diff.
Además el docblock `compose.ts:238-241` dice que convertir el throw en otra cosa *"cambiaría el
contrato con los dos callers"*.

*Rechazada — cambiar la firma de `compose()` a una unión discriminada*: medido, hay **>200**
call-sites `composeService.compose(` en las suites (`grep` no-test da 2, tests da el resto), y
`orchestrate.test.ts` mockea el retorno en ~25 sitios. Sería un diff de miles de líneas de test para
un cambio de forma.

**DT-A2 — La rama de suspensión es INALCANZABLE salvo que el caller la haya armado. Estructural, no
por disciplina.**

`ComposeRequest` gana un campo opcional:

```ts
/**
 * WKH-225 — presente ⟹ este pipeline PUEDE suspenderse. Ausente ⟹ el sobre del
 * agente no se mira siquiera y el comportamiento es byte-idéntico (AC-9).
 * ⛔ LO CONSTRUYE UN SOLO ARCHIVO: `src/routes/compose.ts`. Clavado por T-SUSP-CALLSITE.
 */
suspension?: {
  caller: ResumeCaller;      // credencial exacta (kind + id), espejo de QuoteCaller
  ownerRef: string;
  keyId: string;
  ttlSeconds?: number;
  /** epoch-ms del `exp` del quote que congeló precios, si hubo. CD-15. */
  frozenPricesExpireAtMs?: number;
};
```

Consecuencias medidas y **gratis**:
- `services/orchestrate.ts:1359` nunca lo pasa ⇒ `/orchestrate` (y con él `inbound-task.ts`,
  `agent-link.ts`, el `synthetic-tx-monitor`) **no puede ver un suspendido**. Scope OUT queda
  cumplido por construcción, no por acordarse.
- Con la bandera OFF, `routes/compose.ts` tampoco lo pasa ⇒ **cero filas nuevas, cero queries
  nuevas, cero claves nuevas en la respuesta** (AC-9 literal).
- **Test estático obligatorio `T-SUSP-CALLSITE`**: lee `src/services/orchestrate.ts` y verifica que
  la cadena `suspension:` **no aparece**. Exemplar del patrón: `T-COTA-03`, descrito en
  `lib/stranded-payment.ts:70-74` (*"lee `src/routes/orchestrate.ts` y exige que TODOS los
  `maxAgents.maximum` … sean exactamente este número"*).

**DT-A3 — Tabla nueva `a2a_suspended_runs` en bdwv, clonando la forma de `a2a_agent_links`.**

Columnas (el detalle exacto va al Story File; acá lo que es load-bearing):

| Columna | Por qué | AC |
|---|---|---|
| `id UUID PK` | El `runId` opaco que se le devuelve al caller | AC-2 |
| `token_hash TEXT NOT NULL UNIQUE` | **Sólo el hash.** Espejo de `…agent_links.sql:21` (UNIQUE = btree O(1), sin índice extra) | AC-4 |
| `owner_ref TEXT NOT NULL` | Ownership Guard app-layer (CD-4) | AC-6 |
| `key_id UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE` | Espejo de `:23` | — |
| `caller_kind TEXT NOT NULL CHECK IN ('key','session','delegation')` + `caller_id TEXT NOT NULL` | **La credencial EXACTA** a la que queda atado. Precedencia = la de `resolveQuoteCaller` (`orchestrate-quote.ts:136-144`) | AC-2, AC-4 |
| `compose_run_id UUID NOT NULL` | Correlación con los `compose_step` del mismo run y clave de idempotencia del fee (DT-A7) | AC-2 |
| `step_index INT NOT NULL CHECK (step_index >= 0)` | Dónde retomar | AC-8 |
| `steps_json JSONB NOT NULL` | **Los `StepResult` COMPLETOS**, no una versión reducida: `collectStrandedSteps` (`stranded-payment.ts:172-198`) lee `downstreamTxHash`, `costUsdc`, `agent.slug`, `agent.registry`, `agent.payment.chain`, `downstreamSettledAmount`. Sin ellos AC-7 no se puede cumplir | AC-2, AC-7, AC-8 |
| `last_output JSONB` | `lastOutput` (`compose.ts:370`) | AC-8 |
| `remaining_steps JSONB NOT NULL` | Los `ResolvedComposeStep` que faltan | AC-8 |
| `frozen_step_prices JSONB` | Los precios congelados ya debitados / por debitar | AC-2 |
| `total_cost_usdc NUMERIC(20,8) NOT NULL` · `total_latency_ms INT NOT NULL` | Los agregados (`compose.ts:368-369`) | AC-8 |
| 🔴 `contracting_chain JSONB` · `contracting_depth INT NOT NULL DEFAULT 0` | **Hallazgo de este F2**: si no se persisten, la reanudación arranca con `depth: 0` y **la profundidad del guard anti-bucle se reinicia**. Sería un bypass de un guard de dinero abierto por esta HU | AC-12 |
| `self_host_hint TEXT` | Sin él, `resolveSelfHosts` da `[]` y los SITIOS 3/4 quedan **inertes** (`compose.ts:349-355`, textual) | AC-12 |
| `chain_id INT` | Para el débito per-step de los steps restantes | AC-8 |
| `status TEXT NOT NULL DEFAULT 'suspended' CHECK IN ('suspended','resuming','resumed','failed','expired')` | Máquina de estados. Espejo de `…agent_links.sql:28-29` con **un estado más**: `expired` es terminal y **distinguible** de `failed`, porque AC-7 exige emitir el residuo **sólo** en la transición a `expired` | AC-5, AC-7 |
| `ttl_seconds INT NOT NULL CHECK (ttl_seconds BETWEEN 181 AND 86400)` | Ver DT-A6 | MI-3 |
| `expires_at TIMESTAMPTZ NOT NULL` | **Lo escribe el trigger, no la app** (DT-A6) | AC-7 |
| `resumed_at TIMESTAMPTZ` · `error_message TEXT` · `created_at` · `updated_at` | Espejo de `…agent_links.sql:30-36` | — |

Índices: `(owner_ref)`, `(status)`, `(key_id, owner_ref)`, `(expires_at)` — los tres primeros
espejan `…agent_links.sql:38-40`; el cuarto sirve a AC-11.
RLS: `ENABLE ROW LEVEL SECURITY` **sin `CREATE POLICY`** (deny-by-default, `…agent_links.sql:42-44`).
Trigger `updated_at`: reusa `trigger_set_updated_at` (`…agent_links.sql:46-50`).

**DT-A4 — Dos RPC atómicas, con la misma firma, hardening y semántica del exemplar.**

- `claim_suspended_run(p_token_hash TEXT, p_owner_ref TEXT)` → `suspended → resuming` bajo
  `FOR UPDATE`. Orden de los guards, **copiado del exemplar y load-bearing**:
  1. `SELECT … FOR UPDATE` por `token_hash`; `NOT FOUND` ⇒ `RAISE 'RUN_NOT_FOUND'`;
  2. 🔴 **`IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE 'RUN_NOT_FOUND'`** — el **mismo**
     literal que "no existe". AC-6 pide 404, no 403, y `types/index.ts:392-394` lo llama
     *"404 disclosure-safe"*. Que el mensaje sea idéntico es lo que lo hace disclosure-safe de
     verdad: si dijera `OWNERSHIP_MISMATCH`, el atacante aprendería que el run existe;
  3. `IF v_status = 'suspended' AND NOW() >= v_expires THEN` marcar `expired` **en la misma
     transacción** y `RAISE 'RUN_EXPIRED'`. La transición y el raise juntos son lo que hace que
     AC-7 emita **exactamente un** evento: la fila sólo puede pasar `suspended→expired` una vez;
  4. `IF v_status <> 'suspended' THEN RAISE 'RUN_ALREADY_USED'`;
  5. `UPDATE … SET status='resuming'` y devolver la fila.
- `settle_suspended_run(p_id, p_owner_ref, p_outcome, p_error)` → cierre exactly-once con
  **status-gate** `IF v_status <> 'resuming' THEN RETURN` (espejo de `…agent_links.sql:158-160`).
  `p_outcome ∈ {'resumed','reopen','failed'}`. ⛔ `reopen` **sólo** desde guards pre-débito
  (§MI-4).
- Hardening obligatorio en las dos, copiado verbatim del exemplar
  (`…agent_links.sql:117-122`, `:179-184`): `SECURITY DEFINER`, `SET search_path = public, pg_temp`,
  `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`.

**DT-A5 — Módulo LEAF nuevo `src/lib/resume-token.ts`, sólo `node:crypto`.**

- CD-13 lo exige y sus dos exemplars (`compose-limits.ts:3-9`, `stranded-payment.ts:20-24`) viven en
  `src/lib/` ⇒ **acá también**, no en `services/`.
- Formato `v1.<base64url(payload)>.<hmac hex64>`; payload `{v:1, bind, rid, iat, exp}`.
- `verifyResumeToken(token, caller, nowMs?)` con **los 7 pasos, en el mismo orden**, del docblock de
  `orchestrate-quote.ts:331-343`: forma/tamaño → secreto (fail-closed) → estructura → **HMAC sobre
  el string CRUDO + `timingSafeEqual`** → recién ahí parsear → vigencia (`exp` + `iat` no-futuro con
  `RESUME_CLOCK_SKEW_SECONDS = 60`) → binding. **AC-4 es literalmente esto.**
- 🔴 **Contexto de dominio distinto del quote**: la firma se calcula sobre
  `` `resume|${version}.${encoded}` `` (o secreto propio + prefijo propio), para que **un quote
  jamás verifique como resume ni al revés**. Es la lección del control #2 de WKH-233 (dos secretos
  de dos subsistemas que `kyc-auth.ts:25-27` prohíbe confundir).
- `resumeHmacKey()` lee `COMPOSE_RESUME_HMAC_KEY`; ausente o vacío ⇒ `null` ⇒ **fail-closed**, nunca
  lanza (DT-5, espejo de `orchestrate-quote.ts:117-125`).
- ⚠️ **El `exp` del token NO es la autoridad.** Es un fast-fail (espejo de `agent-link.ts:317-326`).
  La autoridad es `expires_at` comparado con `NOW()` **dentro** de `claim_suspended_run`.

**DT-A6 — `expires_at` lo escribe POSTGRES.** Columna `ttl_seconds` + trigger `BEFORE INSERT`:

```sql
NEW.expires_at := now() + make_interval(secs => NEW.ttl_seconds);
```

⇒ escritura y lectura del vencimiento usan **el mismo reloj**, y el único sitio sensible a skew del
exemplar (`agent-link.ts:195`) **no se replica**. Ver MI-3, medición 4.
*Alternativa rechazada — calcular el ISO en Node como hace el exemplar*: cuesta lo mismo y deja
`Node_now + TTL` medido contra `PG_now`; con el skew que el repo ya asume (`QUOTE_CLOCK_SKEW_SECONDS
= 60`, `orchestrate-quote.ts:44`) la ventana efectiva se corre en silencio.

**DT-A7 — El fee de protocolo se cobra UNA vez, al final, sobre el total completo.**

🔴 Hallazgo de MI-5 (#5). `routes/compose.ts:1167-1226` cobra `chargeProtocolFee({orchestrationId:
request.id, feeBaseUsdc: result.totalCostUsdc})` en el camino de éxito, y la idempotencia es **por
`orchestrationId`**. Si un suspendido tomara ese camino, se cobraría el fee sobre el pipeline
**parcial** y otra vez al reanudar (otro `request.id`, otra idempotencia) ⇒ **doble cobro de fee**.

⇒ **La rama de suspensión (202) se ubica ANTES del bloque de fee y no cobra nada.** El fee se cobra
al completar, sobre el `totalCostUsdc` **acumulado** (los steps pre-suspensión + los posteriores), y
la clave de idempotencia del fee en el camino de resume es el **`compose_run_id` de la fila**, no el
`request.id` del resume: es el único identificador estable a través de la suspensión, y es el mismo
que ya correlaciona el evento de residuo (`stranded-payment.ts:216-222`).

**DT-A8 — AC-12 (guard anti-bucle en la reanudación) sale gratis, PERO sólo si se persisten dos campos.**

La reanudación re-entra a `executePipeline` con los steps restantes ⇒ SITIO 3 (`compose.ts:444`) y
SITIO 4 corren de nuevo sobre ellos, y `selfIdentity` se re-resuelve. **Cero código nuevo.**
🔴 Lo que **no** es gratis: `contracting_chain` / `contracting_depth` / `self_host_hint`. Sin
persistirlos, la reanudación arranca con cadena vacía y profundidad 0 (`compose.ts:333-337`,
`:358-366`) ⇒ el guard de profundidad se reinicia. Ver DT-A3.
Y el razonamiento del propio código (`compose.ts:434-437`: *"el catálogo puede cambiar entre el
preflight y la ejecución"*) es **más** cierto tras horas de espera, no menos.

**DT-A9 — AC-7: el residuo se emite sólo en la transición a `expired`, y sólo si hubo pago on-chain.**

Se **reusa** el módulo LEAF existente, sin escribir aritmética nueva:
`collectStrandedSteps(steps_json)` (`stranded-payment.ts:172`) → si devuelve `[]`, **no se emite
nada** (AC-7 dice *"sólo si algún step ya dejó evidencia de pago on-chain"*, y ese predicado ya está
implementado: `stranded-payment.ts:177-180`) → si devuelve algo,
`buildStrandedPaymentEvent({composeRunId, strandedSteps, failedStepIndex: steps_json.length, …})`
(`:226`) → `eventService.track(...)` **fire-and-forget con `.catch`**, igual que
`compose.ts:277-295`.
⛔ CD-12 se honra: el `event_type` es el de siempre (`compose_stranded_payment`,
`stranded-payment.ts:44`) y **no se agrega a `SETTLE_UNKNOWN_EVENT_TYPES`**
(`settle-withholding.ts:170`).

**DT-A10 — AC-11: cuarta lista en `AmbiguousReport`, no un mezclado.**

`reconciliationService.listSuspendedRuns()` consulta **`a2a_suspended_runs`** (no `a2a_events`) y se
suma como cuarta clave de `AmbiguousReport` (`reconciliation.ts:317`, ensamblado `:675-684`).
Hereda las tres invariantes que ese archivo declara innegociables (`:713-721`): no gateada por
`isEscrowSettleEnabled()`, `count:'exact'` + `truncated`, y **un error de query TIRA** en vez de
devolver `[]`.
🔴 **Es cross-tenant DELIBERADO**, como `listSettleUnknown` (`reconciliation.ts:722-723`), porque es
superficie admin gateada por `requireAdminToken`. ⇒ **Necesita su entrada escrita a mano en
`test/ownership-filter-guard.exceptions.ts`**, una por sitio, con el motivo. Es entregable, no
opcional (§7, W2).
⚠️ `total_cost_usdc` se selecciona como **`total_cost_usdc::text`** — WKH-196: PostgREST entrega los
`NUMERIC` como número JSON y `JSON.parse` redondea (`reconciliation.ts:783-784`).

**DT-A11 — AC-10: las dos capacidades entran a `NON_DISBURSEMENT_CAPABILITIES` CON SU FUENTE.**

El docblock de `capability-risk.ts:70-87` exige **una fuente por entrada** y deja fuera lo que no se
pudo verificar (el precedente `cashout-match`, `:84-87`). Fuente medida para las dos:
`wasiai-remittance-agents/src/manifest/registry.ts:76` y `:77`, con el docblock `:71-75` que dice
textual que son **aditivas** y declaran *"POR QUE CAMINO se hace el trabajo"* (rol vs camino), y que
`legacy-single-shot-kyc` *"SE BORRA el dia que `/invoke` se retire de verdad"*.
Ninguna de las dos nombra un desembolso: el agente *"Autoriza o rechaza; no paga"*
(`capability-risk.ts:79-80`, sobre el mismo agente). ⇒ Entran, con esa cita en el docblock.

**DT-A12 — Bandera nueva `COMPOSE_SUSPEND_ENABLED`, `=== 'true'` estricto, default OFF.**

Convención obligatoria del repo (`project-context.md:252-268`,
`src/adapters/registry.ts:63`). Con la bandera OFF, `routes/compose.ts` no construye
`request.suspension` ⇒ por DT-A2 **nada se enciende**.

---

## 4. Waves de implementación

### 4.1 Presupuesto de líneas (regla 10 del `CLAUDE.md` — el CR lo contrasta en su check 7)

> **Qué es este número.** El total por wave es el **presupuesto** que el CR compara contra el diff
> real. **No es una meta.** Si el diff excede >2× hay que justificar por escrito o recortar. La
> pregunta que decide: *¿qué parte de esto seguiría existiendo si lo escribiera alguien que ya conoce
> este repo?* Este repo tiene densidad de docblock **alta y deliberada** (`compose.ts` = 1804 líneas
> con ~45% de comentario), así que los números de abajo la asumen; un diff **por debajo** del
> presupuesto en los archivos de contrato es tan sospechoso como uno por encima.

---

### **W0 — SERIAL. Contratos, tipos, migración, LEAF. Cero comportamiento nuevo.**

Nada de W0 cambia una sola decisión en runtime: los tipos son opcionales, la migración es aditiva, el
LEAF no lo importa nadie todavía, la bandera está OFF.

| # | Archivo | Nuevo | Qué hace | **Líneas** |
|---|---|---|---|---|
| 0.1 | `src/types/index.ts` | — | `ComposeSuspension`, `ResumeCaller`, `ComposeResult.suspended?`, `ComposeRequest.suspension?`, `SuspendedRunRow`, `SuspendedRunClaim`. ⛔ `errorCode` **NO se toca** | **+95** |
| 0.2 | `src/lib/resume-token.ts` | ✅ | LEAF, sólo `node:crypto`. Sign + verify con el orden de 7 pasos (DT-A5) | **+235** |
| 0.3 | `src/lib/resume-token.test.ts` | ✅ | Ver §6 (T-TOK-*) | **+330** |
| 0.4 | `supabase/migrations/20260823000000_wkh225_suspended_runs.sql` | ✅ | Tabla + índices + RLS + trigger de `expires_at` + 2 RPC con hardening | **+215** |
| 0.5 | `…_wkh225_suspended_runs_down.sql` | ✅ | `DROP FUNCTION`×2 (firma exacta) + `DROP TRIGGER` + `DROP FUNCTION` del trigger + `DROP TABLE`. Convención `project-context.md:403` | **+22** |
| 0.6 | `src/types/database.types.ts` | — | `Tables.a2a_suspended_runs` (Row/Insert/Update/Relationships) + `Functions.claim_suspended_run` + `Functions.settle_suspended_run`. 🔴 **Obligatorio**: sin esto `supabase.rpc()` no compila (§8.1) y la tabla no entra al guardián de ownership | **+110** |
| 0.7 | `test/wkh225-suspended-runs.migration.test.ts` | ✅ | Estructural sobre el `.sql`, exemplar `test/agent-links.migration.test.ts` | **+245** |
| 0.8 | `src/lib/capability-risk.ts` | — | AC-10: 2 entradas + su fuente en el docblock (DT-A11) | **+16** |
| 0.9 | `src/lib/capability-risk.test.ts` | — | T-CAP-1/2/3 (§6) | **+50** |
| 0.10 | `.env.example` | — | `COMPOSE_SUSPEND_ENABLED=`, `COMPOSE_RESUME_HMAC_KEY=`, `SUSPEND_MAX_TTL_SECONDS=` | **+16** |
| | | | **Subtotal W0** | **≈ 1334** |

**Puerta de salida de W0**: `npx tsc -p tsconfig.json --noEmit` limpio + `npm run lint` limpio +
`npm test` **verde sin cambios de comportamiento** (nadie importa el LEAF todavía).

---

### **W1 — PARALELIZABLE. Persistencia + el desenlace en el service.**

Dos frentes que no comparten archivo (el work-item ya lo señaló como "dos olas naturales"):
**W1-a** = `services/suspended-run.ts` + sus tests; **W1-b** = `services/compose.ts` + su suite.

| # | Archivo | Nuevo | Qué hace | **Líneas** |
|---|---|---|---|---|
| 1.1 | `src/services/suspended-run.ts` | ✅ | `open()` (insert), `claim()` (RPC), `settle()` (RPC), `expire()` (+ el residuo de DT-A9), `listForOwner()`. ⛔ **Toda** cadena `select`/`update`/`delete` cruza `.eq('owner_ref', …)` (CD-4). Ninguna función devuelve `boolean` (doctrina `settle-ledger.ts:34-36`): uniones discriminadas | **+345** |
| 1.2 | `src/services/suspended-run.test.ts` | ✅ | T-RUN-* (§6) | **+390** |
| 1.3 | `src/services/suspended-run.ownership.test.ts` | ✅ | Que el filtro **aísle**, con un falso que aplica los filtros pedidos. Exemplar: los `src/services/*.ownership.test.ts` que `CLAUDE.md` declara obligatorios | **+155** |
| 1.4 | `src/services/compose.ts` | — | (a) lector del sobre de suspensión sobre el `output` **después** de `invokeAgent`, dentro del `try` `:698-732`; (b) rama de suspensión: `finishSuccessfulStep` normal + persistir + `return {success:true, suspended, …}`; (c) fail-closed si el insert falla ⇒ `{success:false, errorCode:'SUSPEND_PERSIST_FAILED'}`… **⚠️ ver nota** | **+130** |
| 1.5 | `src/services/compose.suspend.test.ts` | ✅ | T-SUSP-* (§6) | **+430** |
| 1.6 | `test/ownership-filter-guard.exceptions.ts` | — | La entrada escrita a mano del sitio cross-tenant admin (DT-A10). **Se escribe leyendo el código, nunca volcando la salida del escáner** (`CLAUDE.md`) | **+24** |
| | | | **Subtotal W1** | **≈ 1474** |

> ⚠️ **Nota de 1.4(c) — `[NEEDS CLARIFICATION #1]`, ver §10.** `errorCode` es una unión CERRADA de 5
> miembros (`types/index.ts:1207-1212`) y la unión **no se toca** (contrato público, MI-5).
> ⇒ El fallo de persistencia se reporta con `success:false` **sin** `errorCode` (cae en el
> `default → 400` de `routes/compose.ts:1109`, el mismo camino que el guard de presupuesto de
> `compose.ts:531-541`, que **tampoco** agrega `errorCode` y dice por qué: *"sería tocar el union …
> que es de otra HU"*). El mensaje distinguible alcanza para el operador — es el precedente escrito.

**Puerta de salida de W1**: bandera OFF ⇒ suite verde y **byte-idéntica**. Bandera ON en test ⇒ la
suspensión persiste y devuelve el sobre; `compose.ts:230` no emite residuo (AC-1 medido, no
argumentado).

---

### **W2 — DEPENDE DE W1. Ruta, reanudación, reconciliación, y los números del README.**

| # | Archivo | Nuevo | Qué hace | **Líneas** |
|---|---|---|---|---|
| 2.1 | `src/routes/compose.ts` | — | (a) construir `request.suspension` tras la bandera + caller bindable; (b) rama `if (result.suspended)` **antes** de `:1092` y **antes** del fee ⇒ `202` con `{suspended, requestId}`; (c) `POST /compose/resume` con la misma cadena de preHandlers **menos** el de precio del step-0; (d) mapeo 400/404/409/410/503, espejo de `routes/agent-links.ts:173-195` | **+195** |
| 2.2 | `src/routes/compose.resume.test.ts` | ✅ | T-RES-* (§6) | **+440** |
| 2.3 | `src/services/reconciliation.ts` | — | `listSuspendedRuns()` + 4ª clave de `AmbiguousReport` (DT-A10) | **+100** |
| 2.4 | `src/services/reconciliation.test.ts` | — | T-REC-1/2/3 (§6) | **+120** |
| 2.5 | `README.md` | — | 🔴 **Obligatorio, mecánico**: `test/readme-numbers.test.ts` deriva del repo los **archivos de test** (`:378`, hoy 303), las **variables de `.env.example`** (`:351`, hoy 186) y los **archivos que linta Biome** (`:383`, hoy 501). Esta HU suma **+7 test files**, **+3 variables** y **+3 archivos `src/**/*.ts`**. Sin este diff, **`npm test` va a ROJO**. ⚠️ **Re-derivá los tres con los comandos que el propio README publica; no copies estos números** | **+8** |
| 2.6 | `README.es.md` | — | Espejo. `test/readme-parity.test.ts` lo exige | **+8** |
| 2.7 | `doc/sdd/_INDEX.md` | — | **CD-14** — la fila de `index-row.md`, **AL FINAL de la tabla**, después de la `224`. ⛔ Insertar cualquier línea **por encima de la 144** corre la tabla y rompe la cita de `capability-risk.ts:81-82` (control G-F1, `test/sdd-index-matches-folders.test.ts:398`). Verificado: `_INDEX.md:144` es hoy la fila `157`, la que contiene `remit.corridor-discovery` | **+1** |
| | | | **Subtotal W2** | **≈ 872** |

---

### 4.2 Presupuesto total

| Wave | Producción | Tests | Migración/SQL | Docs/config | **Total** |
|---|---|---|---|---|---|
| W0 | 346 | 625 | 237 | 126 | **1334** |
| W1 | 499 | 975 | 0 | 0 | **1474** |
| W2 | 295 | 560 | 0 | 17 | **872** |
| | **1140** | **2160** | **237** | **143** | **≈ 3680** |

**Umbral del CR (check 7): >7360 líneas exige justificación escrita o recorte.**
Ratio test:producción ≈ **1.9:1** — está en la norma medida del repo (5424 casos en 303 archivos de
test contra ~500 de `src/`).

---

## 5. Exemplars verificados (paths y rangos confirmados con `sed`)

| Qué se copia | Exemplar | Rango verificado | Qué se toma exactamente |
|---|---|---|---|
| Tabla + RPC atómica + RLS + hardening | `supabase/migrations/20260706000000_wkh137_agent_links.sql` | `:19-40` tabla · `:42-44` RLS · `:46-50` trigger · `:59-115` claim · `:87` `FOR UPDATE` · `:93` `NOW() >= v_expires` · `:117-122` hardening · `:133-177` settle · `:158-160` status-gate · `:167-169` reopen | Estructura completa. Se **agrega** el estado `expired` y el trigger de `expires_at` |
| Test estructural de migración | `test/agent-links.migration.test.ts` | `:1-10` docblock · `:22-31` RLS · `:33-37` CHECK · `:39-42` UNIQUE · `:44-52` `SECURITY DEFINER`×2 + `FOR UPDATE;`×2 | El patrón entero (100% mock sobre el `.sql`, sin DB) |
| Consumo TS de la RPC + TTL + fast-fail | `src/services/agent-link.ts` | `:140-146` maxTtl · `:180-193` default=max · **`:195`** (el sitio del que se DIVERGE) · `:317-326` fast-fail · `:410-434` reopen | Todo menos `:195` |
| Firma HMAC, binding, orden load-bearing | `src/services/orchestrate-quote.ts` | `:26-27` LEAF · `:37-44` TTL+skew · `:117-125` secreto sin fallback · `:136-144` precedencia del binding · **`:331-343`** orden de 7 pasos · `:345-406` `verifyQuote` | El mecanismo entero. **No** el multi-redeem (DT-4) |
| Módulo LEAF | `src/lib/compose-limits.ts` `:3-9` · `src/lib/stranded-payment.ts` `:20-27` | verificados | El motivo escrito de CD-13 y la ubicación (`src/lib/`) |
| Mapeo HTTP de esta máquina de estados | `src/routes/agent-links.ts` | `:173-195` | 404/410/409/503 y la forma `{ error_code: '…' }`. ⛔ **NO** el token en el path (`:164`) |
| Residuo (AC-7) | `src/lib/stranded-payment.ts` | `:44` event · `:172-198` collect · `:226-241` build · `src/services/compose.ts:277-295` emisión fire-and-forget con `.catch` | Se **reusa**, no se reimplementa |
| 4ª lista de reconciliación | `src/services/reconciliation.ts` | `:317` shape · `:675-684` ensamblado · `:703-761` `listSettleUnknown` · `:722-723` cross-tenant · `:783-784` `::text` | Estructura + las 3 invariantes + el `::text` |
| Test estático de call-site único | `src/lib/stranded-payment.ts` `:70-74` (describe `T-COTA-03`) · `test/payment-guards-live-in-one-place.test.ts` | verificados | El patrón de `T-SUSP-CALLSITE` |
| Doctrina de uniones discriminadas / fail-closed | `src/adapters/solana/settle-ledger.ts` | `:16-38` las 3 reglas | Ninguna función devuelve `boolean`; "no sé" nunca autoriza |
| Fuente de AC-10 | `wasiai-remittance-agents/src/manifest/registry.ts` | `:65-78` | Los dos strings + el motivo |

**Todos los paths existen.** Verificado con `sed -n` (que falla si el archivo no existe) y con
`ls`/`wc -l`. Ninguno se cita de memoria.

---

## 6. Plan de tests (≥1 por AC, y qué archivo lo lleva)

| AC | Test(s) | Archivo | Qué prueba, y cómo puede fallar |
|---|---|---|---|
| **AC-1** | `T-SUSP-1` la suspensión devuelve `success !== false`; `T-SUSP-2` **espía `eventService.track` y exige CERO llamadas con `event_type === 'compose_stranded_payment'`** en un run suspendido cuyo step anterior SÍ tiene `downstreamTxHash` | `src/services/compose.suspend.test.ts` | El fixture positivo tiene que llevar un `downstreamTxHash` real, si no `collectStrandedSteps` devuelve `[]` y el test pasa **por la razón equivocada** (lección: *el test del camino feliz ejercitaba el agujero*) |
| **AC-2** | `T-SUSP-3` la fila persiste **los 8 campos** que AC-2 enumera; `T-SUSP-4` la respuesta trae `artifact` + `runId` + `expiresAt` | `compose.suspend.test.ts` | Assert campo por campo, no `toMatchObject` parcial |
| **AC-3** | `T-SUSP-5` con 3 steps y suspensión en el 1: `budgetService.debit` **no** se llama para el step 2, `invokeAgent` **no** se llama para el step 2, `signAndSettleDownstream` **no** se llama, `credit*` **no** se llama | `compose.suspend.test.ts` | Cuatro espías, cuatro `not.toHaveBeenCalled()` |
| **AC-4** | `T-TOK-1..8`: firma inválida ⇒ `RESUME_INVALID`; **firma inválida ⇒ CERO llamadas a `supabase`** (el orden es el AC); `iat` futuro > skew ⇒ inválido; token de **quote** presentado como resume ⇒ inválido; secreto ausente ⇒ inválido (fail-closed); token >8 KB ⇒ inválido antes de decodificar | `src/lib/resume-token.test.ts` + `src/routes/compose.resume.test.ts` | El "cero llamadas a supabase" es lo que hace el AC verificable; sin eso sólo se prueba el código de error |
| **AC-5** | `T-RES-1` dos resumes con el mismo token ⇒ 2º da `RESUME_ALREADY_USED`; `T-RES-2` en el 2º, `debit`/`invokeAgent`/`settle` **no** se llaman; `T-RUN-1` `claim()` sobre una fila `resuming` devuelve `already_used` | `compose.resume.test.ts`, `suspended-run.test.ts` | Con un doble de supabase que **aplica el status-gate**, no uno que siempre dice OK |
| **AC-6** | `T-RES-3` resume con `owner_ref` distinto ⇒ **404** y **el body es idéntico** al de un `runId` inexistente (byte a byte); `T-RUN-2` la RPC levanta el **mismo** literal en los dos casos | `compose.resume.test.ts`, `test/wkh225-…migration.test.ts` | Si los mensajes difieren, el 404 no es disclosure-safe y el test lo caza |
| **AC-7** | `T-RES-4` run vencido ⇒ `RESUME_EXPIRED` + status `expired`; `T-RES-5` con evidencia on-chain ⇒ **exactamente 1** `compose_stranded_payment`; `T-RES-6` **sin** evidencia ⇒ **0**; `T-RES-7` dos intentos sobre el vencido ⇒ **sigue siendo 1** | `compose.resume.test.ts` | T-RES-7 es el que prueba el status-gate. Sin él, "exactamente uno" es una afirmación sin testigo |
| **AC-8** | `T-RES-8` reanudación válida ⇒ ejecuta **sólo** los steps restantes, `invokeAgent` recibe **sólo** los agentes de `remaining_steps`, y `result.steps` **incluye** los completados antes; `T-RES-9` `debit` no se llama para ningún step ≤ i | `compose.resume.test.ts` | Comparar el array de `steps` completo, no su `.length` |
| **AC-9** | `T-SUSP-6` con `COMPOSE_SUSPEND_ENABLED` ausente / `''` / `'TRUE'` / `'1'` / `'yes'` ⇒ **cero inserts, cero RPC, y las claves del `ComposeResult` son exactamente las de hoy** (comparación de `Object.keys` contra un snapshot de la rama base) | `compose.suspend.test.ts` | La comparación de claves es lo que hace falsable "cero claves nuevas" |
| **AC-10** | `T-CAP-1` `classifyCapability('kyc-hosted-redirect') === 'no-disbursement'`; `T-CAP-2` ídem `legacy-single-shot-kyc`; `T-CAP-3` **`needsTightTrialQuota` de las 6 capacidades REALES de `remit-kyc-validator` da `false`** | `src/lib/capability-risk.test.ts` | T-CAP-3 usa las 6 exactas de `wasiai-remittance-agents/src/manifest/registry.ts:66-78`. Es lo que prueba DT-7 |
| **AC-11** | `T-REC-1` `listAmbiguous()` trae la 4ª clave; `T-REC-2` un run suspendido **no** aparece en `listSettleUnknown` ni en `listStrandedRuns`; `T-REC-3` **`SETTLE_UNKNOWN_EVENT_TYPES` sigue teniendo exactamente los mismos miembros que hoy** | `src/services/reconciliation.test.ts` | T-REC-3 es el testigo mecánico de CD-12 |
| **AC-12** | `T-RES-10` la reanudación con un agente cuyo `invokeUrl` es propio ⇒ `CONTRACTING_LOOP_DETECTED`; `T-RES-11` la profundidad persistida se **restaura** (`depth` entrante 4 ⇒ el guard corta, `depth` 0 ⇒ no) | `compose.resume.test.ts` | T-RES-11 es lo que prueba DT-A8; sin él la persistencia de `contracting_depth` es código que nadie mira |

### Tests transversales (no cuelgan de un AC pero son de este SDD)

| Test | Archivo | Qué clava |
|---|---|---|
| `T-SUSP-CALLSITE` | `src/services/compose.suspend.test.ts` | `src/services/orchestrate.ts` **no contiene** `suspension:` ⇒ Scope OUT estructural (DT-A2) |
| `T-SUSP-GUARD571` | ídem | El texto exacto de `compose.ts:571` (`if (i > 0 && scopingKeyRow && chainId !== undefined) {`) **sobrevive**. CD-7. ⚠️ Se ancla por CONTENIDO, no por número de línea: esta HU inserta líneas antes y el número se mueve |
| `T-SUSP-NOERRCODE` | ídem | La unión `ComposeResult.errorCode` sigue teniendo **exactamente 5** miembros |
| `T-SUSP-IMPOSSIBLE` | ídem | No existe ningún camino que devuelva `{success:false, suspended:<presente>}` |
| `T-TOK-LEAF` | `src/lib/resume-token.test.ts` | El módulo importa **sólo** `node:crypto` (lectura del propio fuente). CD-13 |
| `T-MIG-*` | `test/wkh225-suspended-runs.migration.test.ts` | RLS sin `CREATE POLICY`; CHECK de los 5 estados; `token_hash UNIQUE`; `SECURITY DEFINER`×2; `FOR UPDATE;`×2; `search_path`/`REVOKE`/`GRANT` en las 2; el `_down.sql` dropea con la **firma exacta**; **`NOW()` aparece en el claim y `Date.now` NO aparece en ningún lado del SQL** (testigo de DT-A6) |
| `T-OWN-*` | `src/services/suspended-run.ownership.test.ts` | Que el filtro **aísle**, no que exista: un falso que aplica los filtros y devuelve la fila de OTRO owner ⇒ el service tiene que no encontrarla |

⚠️ **Lo que el guardián `test/ownership-filter-guard.test.ts` hace solo y lo que NO**: en cuanto
`a2a_suspended_runs` aparezca con `owner_ref` en el bloque `Row` de `database.types.ts`,
`deriveTables` (`test/ownership-filter-guard.scanner.ts:243-283`) la mete al universo **sola** y
exige el filtro en toda cadena `select`/`update`/`delete`. Lo que **no** mira es el **VALOR** del
filtro ni los `supabase.rpc(...)` — o sea: **las dos RPC de DT-A4 quedan enteras fuera del
guardián**. Por eso `T-OWN-*` y el guard `IS DISTINCT FROM` dentro del SQL no son redundantes: son
la única cobertura de ese hueco.

---

## 7. Constraint Directives

### 7.1 Heredados del work-item (los 14, sin excepción)

| CD | Estado en este SDD |
|---|---|
| **CD-1** el estado no vive en Chaski | ✅ Vive en `a2a_suspended_runs`, en bdwv |
| **CD-2** ⛔ no representar la suspensión como `success:false` | ✅ DT-A1: `success:true`. Testigo `T-SUSP-IMPOSSIBLE` |
| **CD-3** ⛔ nada de anti-replay en memoria | ✅ El single-use vive en `claim_suspended_run` (DT-A4) |
| **CD-4** ✅ `.eq('owner_ref', …)` obligatorio | ✅ En todo `select`/`update`/`delete` de W1.1. La única omisión (admin cross-tenant) lleva excepción escrita (W1.6) |
| **CD-5** ⛔ nada a caldz; todo a bdwv con `_down.sql` | ✅ W0.4 + W0.5 |
| **CD-6** ✅ bandera `=== 'true'`, default OFF | ✅ DT-A12; testigo `T-SUSP-6` con 5 valores |
| **CD-7** ⛔ no tocar el guard `i > 0` de `compose.ts:571` ni su comentario CD-11 | ✅ **Testigo mecánico `T-SUSP-GUARD571`**, anclado por contenido |
| **CD-8** ⛔ el identificador nunca en query string, URL, log ni mensaje de error | ✅ El resume va en el **body** de un `POST`. **Se DIVERGE a propósito del exemplar** `routes/agent-links.ts:164` (que lo toma del path). Logs value-free: sólo `runId`, `err.name`, status — nunca el token ni el `artifact` |
| **CD-9** ⛔ no debilitar los 7 controles de WKH-233 | ✅ El corte A no toca `chaski-v3` ni `wasiai-remittance-agents`: **cero diff**, cero control tocado. Se hereda al corte B |
| **CD-10** ⛔ no alcanzar el hosted-redirect por el `/invoke` deprecado | ✅ Corte B. En A no se invoca a ese agente |
| **CD-11** ⛔ no subir `MAX_COMPOSE_STEPS` | ✅ `compose-limits.ts` no se toca (ni siquiera para arreglar su docblock rancio — ver `TD-225-02`) |
| **CD-12** ⛔ nada de agregar el evento a `SETTLE_UNKNOWN_EVENT_TYPES` | ✅ Testigo `T-REC-3` |
| **CD-13** ✅ módulo de firma LEAF (sólo `node:crypto`) | ✅ `src/lib/resume-token.ts`; testigo `T-TOK-LEAF` |
| **CD-14** ✅ la fila del `_INDEX.md` **antes** del primer commit que trackee la carpeta | ✅ W2.7, **al final de la tabla** |

### 7.2 Nuevos de este SDD

- **CD-15** — ✅ **OBLIGATORIO**: si el run llevaba `frozenStepPricesUsd`, `expires_at` se acota
  además por el `exp` del quote que los congeló (`LEAST` en Postgres). ⛔ **PROHIBIDO** que un
  pipeline reanudado debite un precio congelado cuya garantía venció. Motivo medido:
  `QUOTE_TTL_SECONDS = 600` **no tiene override por env a propósito** (`orchestrate-quote.ts:37-40`,
  *"una palanca silenciosa sobre el money-path"*); dejar que la suspensión la alargue sería crear esa
  palanca por la puerta de atrás.
- **CD-16** — ⛔ **PROHIBIDO** que el sobre de suspensión que devuelve el agente contenga una clave
  `error`, `success:false`, o `status ∈ {'failed','error'}`. Medido:
  `src/services/verification.ts:66-74` (`hasErrorSignal`) dispara con cualquiera de las tres y
  marcaría el step como incompleto (`verificationStatus`). El discriminante del sobre es una clave
  propia, y su ausencia es el 100% del tráfico de hoy.
- **CD-17** — ✅ **OBLIGATORIO** persistir `contracting_chain`, `contracting_depth` y
  `self_host_hint`, y **restaurarlos** en la reanudación. ⛔ Reanudar con `depth: 0` es un bypass del
  guard anti-bucle de capa 1 abierto por esta HU (`compose.ts:333-337`, `:349-366`, `:444`).
- **CD-18** — ⛔ **PROHIBIDO** cobrar el fee de protocolo en la respuesta 202. Se cobra **una vez**,
  al completar, sobre el total acumulado, con `compose_run_id` como clave de idempotencia. Motivo
  medido: `routes/compose.ts:1167-1170` idempotiza por `orchestrationId` y el resume es otro
  `request.id` ⇒ el camino ingenuo cobra dos veces (DT-A7).
- **CD-19** — ✅ **OBLIGATORIO** que `expires_at` lo escriba **Postgres** (trigger), nunca Node.
  ⛔ **PROHIBIDO** replicar `agent-link.ts:195`. Motivo: MI-3, medición 4.
- **CD-20** — ✅ **OBLIGATORIO** actualizar los tres números derivados de **los dos** README en el
  **mismo commit** que agrega archivos de test, variables de `.env.example` o archivos bajo `src/`.
  ⛔ **PROHIBIDO copiar los números de este SDD**: re-derivarlos con los comandos que el propio
  README publica. Motivo medido: `test/readme-numbers.test.ts:22-31` los deriva del repo en **cada**
  `npm test`, y `test/readme-parity.test.ts` exige el espejo en `README.es.md`.
- **CD-21** — ⛔ **PROHIBIDO** que el `artifact` del agente se reescriba, se le agreguen parámetros,
  se valide contra una allowlist propia, o se loguee. Se persiste y se devuelve **tal cual** (DT-8).
- **CD-22** (⚡ **auto-blindaje**, ver §9) — ✅ **OBLIGATORIO** que toda función nueva de
  `suspended-run.ts` devuelva una **unión discriminada**, nunca un `boolean` ni un `null` que
  colapse "el guard lo rechazó" / "la escritura falló" / "el store no está".
  Doctrina escrita: `settle-ledger.ts:34-36`.

---

## 8. Librerías externas y gates

### 8.1 Tabla de librerías externas (regla 8 del `CLAUDE.md`)

| Paquete | Rango en `package.json` | **Versión INSTALADA** | Dónde se verificó el API | Qué se usa |
|---|---|---|---|---|
| `node:crypto` | — (built-in) | Node **>= 22** (`package.json` → `engines.node`) | La API que se usa (`createHmac`, `timingSafeEqual`, `createHash`, `randomBytes`) **ya está en uso en este repo** en `orchestrate-quote.ts:29` y `agent-link.ts:197-199`. No se estrena ningún símbolo | `resume-token.ts`, hash del token |
| `@supabase/supabase-js` | `^2.101.1` | **2.101.1** — leída del **lockfile**: `package-lock.json:829-830` (`"node_modules/@supabase/supabase-js": { "version": "2.101.1" }`), corroborada en `node_modules/@supabase/supabase-js/package.json:3` del checkout principal | 🔴 **Los `.d.ts` INSTALADOS**: `node_modules/@supabase/supabase-js/dist/index.d.mts:512-517`. ⛔ **NO** un `grep` en `node_modules` (matchea changelogs de otras versiones) | `.from().insert()/.select()/.update()`, `.rpc()` |

🔴 **Consecuencia medida de la firma instalada, y es un requisito duro del diseño:**

```ts
// node_modules/@supabase/supabase-js/dist/index.d.mts:512
rpc<FnName extends string & keyof Schema['Functions'], Args extends Schema['Functions'][FnName]['Args'] = never, …>(
  fn: FnName, args?: Args, options?: { head?: boolean; get?: boolean; count?: 'exact'|'planned'|'estimated' }
): PostgrestFilterBuilder<…>
```

`FnName` está acotado a **`keyof Schema['Functions']`**, y el cliente está tipado
`SupabaseClient<Database>` (`src/lib/supabase.ts:14`, `:34`). ⇒ **`claim_suspended_run` y
`settle_suspended_run` DEBEN declararse en `src/types/database.types.ts` bajo `Functions:`
(bloque en `:2866`) o `npx tsc --noEmit` falla.** Precedentes verificados: `claim_agent_link`
(`:2987`) y `settle_agent_link` (`:2999`). Eso es W0.6, y por eso W0.6 es **serial** y no opcional.

**⛔ NO se agrega ninguna dependencia nueva.** El diseño usa `node:crypto` (built-in) y el cliente de
Supabase que ya está. **Esto también es cumplir la regla 8, y se escribe explícitamente.**

### 8.2 🔴 El gate del repo — `[NEEDS CLARIFICATION #2]`

`CLAUDE.md:133` (regla 9) dice: *"F4 corre el gate ÚNICO del repo, siempre — acá es `npm run qa`"*.

**Medido: el script `qa` NO EXISTE.**

```
$ /usr/bin/grep -n '"qa"' package.json    →  (sin salida, exit 1)
```
en el worktree **y** en el checkout principal, en el commit base `5578998` (que es justamente el
commit `docs(claude): tres reglas de proceso…` que escribió esa regla). `package.json` declara:
`dev`, `build`, `start`, `lint`, `format`, `test`, `test:coverage`, `smoke:downstream`,
`migrate:preflight`. Ninguno es `qa`.

**El gate real del repo, medido, es `.github/workflows/ci.yml`** — 7 pasos ejecutables, en orden:

```
1. npm ci
2. npx tsc -p tsconfig.json --noEmit          (ci.yml:36-37)
3. npm run lint                               (ci.yml:39-40)   ← el primer eslabón que ya se saltó una vez
4. npm test                                   (ci.yml:42-43)
5. cd mcp-servers/wasiai-x402 && npm ci --ignore-scripts && npm test   (ci.yml:67-73)
6. cd packages/agent-sdk && npm install --ignore-scripts && npm test   (ci.yml:77-83)
```

⚠️ Los pasos 5 y 6 **no los toca `npm test` de la raíz** (`ci.yml:45-53`: el `include` de
`vitest.config.ts` es `src/**` + `test/**`), y estuvieron huérfanos hasta AR-3 de WKH-322.
⚠️ Y esta HU **toca** `mcp-servers/wasiai-x402` en su lectura (el `synthetic-tx-monitor`), aunque no
en su diff — el paso 5 corre igual.

**Propuesta al humano (no la ejecuto yo):** o bien se agrega el script
`"qa": "npx tsc -p tsconfig.json --noEmit && npm run lint && npm test"` a `package.json`, o bien la
regla 9 se re-escribe nombrando los 7 pasos de `ci.yml`. **Componer yo la secuencia y llamarla "el
gate" es exactamente lo que la regla 9 dice que NO es correr el gate.** Hasta que se decida, F4 debe
correr **los 6 pasos ejecutables de `ci.yml`, en orden, y citar la salida de cada uno**.

---

## 9. Auto-blindaje histórico aplicado

Se leyó `doc/sdd/_INDEX.md` y se buscó `auto-blindaje.md` en las últimas carpetas cerradas
(`223-coordinador-como-agente`, `224-citas-archivo-linea-sin-testigo`, y las cerradas de la serie
`21x`). **No hay archivos `auto-blindaje.md`** en esas carpetas (verificado con `ls`), así que **no
hay patrones recurrentes formales que heredar por esa vía**. En su lugar se destilaron los patrones
de error que el propio código documenta y que aplican a este diseño:

| Patrón | Dónde está documentado | CD que lo previene acá |
|---|---|---|
| Un `boolean` colapsa tres causas con tres remedios distintos | `settle-ledger.ts:34-36` ("lección del auto-blindaje de HU-202") | **CD-22** |
| Dos números en dos archivos divergen en silencio | `compose-limits.ts:21-27`, `stranded-payment.ts:53-57` | Todo número derivado, ninguno escrito a mano (`MAX_STRANDABLE_STEPS`, los del README) |
| Un docblock se vuelve falso sin que nadie lo edite | **Medido en vivo acá**: `compose-limits.ts:11-27` describe un Map que WKH-307 borró | `TD-225-02` + §2/MI-3 |
| Un número escrito a mano al lado de un comando que lo calcula | `test/readme-numbers.test.ts:1-19` | **CD-20** |
| Un `?? false` convierte "no se preguntó" en una acusación | Control #6 de WKH-233 | Ausencia preservada: si el agente no manda el sobre, no hay clave |
| Un fixture positivo que omite el campo que el guard compara | *"el test del camino feliz ejercitaba el agujero"* | La nota de AC-1 en §6 |
| Correr las partes de un gate no es correr el gate | `CLAUDE.md:133` | §8.2 |

---

## 10. `[NEEDS CLARIFICATION]` — abiertas al cierre de este F2

| # | Qué | Bloquea | Propuesta |
|---|---|---|---|
| **NC-1** | El fallo de persistencia de la suspensión (W1.4c) sale como `success:false` **sin `errorCode`**, porque la unión es cerrada y es contrato público. ¿Se acepta que caiga en el `default → 400` con mensaje distinguible? | ❌ No bloquea F2.5 | **Aceptar.** Es el precedente escrito del guard de presupuesto (`compose.ts:526-527`, textual: *"NO se agrega un `errorCode`: sería tocar el union … que es de otra HU"*) |
| **NC-2** | `npm run qa` **no existe** (§8.2). ¿Se agrega el script o se re-escribe la regla 9? | ⚠️ Bloquea **F4**, no F3 | Agregar el script en un commit propio, fuera de esta HU, **antes** de F4 |
| **NC-3** | La expiración **proactiva** (barrer runs que nadie reanuda) queda fuera: sin sweeper, un run abandonado **no emite residuo hasta que alguien intente reanudarlo**. AC-7 se cumple igual (es condicional: *"IF … se reanuda"*), pero la exposición queda sin contar. | ❌ No bloquea | **Aceptar como `TD-225-01`**, con su fila. Un sweeper es maquinaria nueva (el repo sólo tiene `REFUND_OUTBOX_SWEEP_MS`) y estrenarla en la misma HU que estrena el estado durable multiplica la superficie de AR |
| **NC-4** | El corte B tendrá que modelar los momentos 1 y 2 de WKH-233 como **dos steps** del pipeline (§11, R-1). ¿Lo ratifica el founder? | ❌ No bloquea el corte A | Se declara como riesgo, no como decisión. **NO se diseña acá** |
| **NC-5** | `TD-225-02`: arreglar el docblock rancio de `compose-limits.ts:11-27`. | ❌ No bloquea | HU aparte. Es un LEAF del money-path y CD-11 dice no tocar ese archivo en esta HU |

⛔ **Ninguna de las 5 bloquea el paso a F2.5.** NC-2 bloquea F4 y hay que resolverla antes.

---

## 11. Riesgos

| # | Riesgo | Evidencia | Mitigación |
|---|---|---|---|
| **R-1** 🔴 | **AC-8 dice "SHALL NOT re-invocar ningún step 0..i", y el veredicto del KYC vive en una segunda llamada al mismo agente** (`GET /decision`, momento 2 de WKH-233). Si el corte B modelara la sesión y la decisión como **un solo step**, la reanudación tendría que re-invocar el step `i` — que AC-8 prohíbe — o el caller tendría que **mandar el veredicto en el body del resume**, que es un veredicto de KYC **forjable por el cliente** | `work-item.md:182-183`; AC-8 | **El corte A no decide esto**, pero su contrato lo condiciona: el corte B tiene que modelar momento 1 = step `i` (suspende) y momento 2 = step `i+1` (lee el veredicto). Se declara como **NC-4** y se pasa al reporte de cierre. ⛔ El corte A **no** acepta el veredicto por el body del resume: el `resume` sólo lleva el token |
| **R-2** | Con la bandera ON y un caller **no bindeable** (x402 puro / anónimo), `resolveQuoteCaller` devuelve `null` (`orchestrate-quote.ts:152`) ⇒ no hay a qué atar el resume | Medido | `routes/compose.ts` **no construye** `request.suspension` para un caller no bindeable ⇒ ese pipeline nunca suspende y se comporta como hoy. Fail-closed |
| **R-3** | La red se corta después de que el resume ganó el claim ⇒ token consumido, el caller no puede reintentar | §MI-4 | `reopen` sólo desde guards pre-débito; todo lo posterior es terminal. Es la **misma** decisión que WKH-137 (CD-8), no una nueva |
| **R-4** | La suspensión persiste `steps_json` con los `StepResult` completos, que incluyen `output` del agente. **Un agente de KYC podría poner PII ahí** | `types/index.ts` `StepResult.output: unknown` | ⚠️ Se declara y **no se resuelve en el corte A**: hoy ese mismo `output` ya viaja al caller por HTTP y ya se serializa entero (`routes/compose.ts:1272`). La suspensión lo hace **durable**, que es un cambio de exposición real. **Foco obligatorio para el AR.** El corte B debe garantizar que el sobre del hosted-redirect no lleve PII (es precisamente su razón de ser: *"ningun endpoint de este repo lo recibe"*, `registry.ts:59`) |
| **R-5** | `a2a_suspended_runs` entra al universo del guardián de ownership **automáticamente** al aparecer en `database.types.ts` ⇒ una cadena sin filtro pone `npm test` en rojo en W1, no en W2 | `test/ownership-filter-guard.scanner.ts:243-283` | Es la mitigación, no el riesgo. Se escribe acá para que el Dev no lo lea como un rojo misterioso |
| **R-6** | Colisión con WKH-360 en `compose.ts` | 🔴 **[NO MEDIDO] en el F1 — MEDIDO acá**: la rama sale de `main` = `5578998`, y `WKH-360` ya está en `src/` de esa base (`grep -rl "WKH-360" src/` da 5+ archivos, incluidos `compose.ts` con los SITIOS 3/4). `git branch -a` confirma `main` y `feat/225-…` | **Sin colisión.** La HU 223 está mergeada |
| **R-7** | `.nexus/project-context.md` **no existe en el worktree** (gitignoreado) | §1 | El Story File tiene que apuntar al checkout principal |

---

## 12. Readiness Check

| # | Criterio | Estado |
|---|---|---|
| 1 | Todos los paths citados existen y se verificaron con `sed`/`ls`/`wc` | ✅ **30 archivos** en el Context Map, todos abiertos |
| 2 | Las citas `[HEREDADO]`/`[NO MEDIDO]` del work-item se re-verificaron | ✅ **3 contradicciones encontradas y documentadas**: `ESTIMATED_MAX_RUN_WALL_CLOCK_MS` no existe (§2/MI-3), los consumidores son 11 y no 6 (§2/MI-5), y `npm run qa` no existe (§8.2). El resto verificó |
| 3 | MI-3 resuelto **con medición**, no por elección | ✅ 4 mediciones + control positivo. El bloqueante que el F1 describía **no existe**; el TTL se deriva de dos sitios independientes del repo |
| 4 | MI-4 resuelto y justificado | ✅ Redirect-driven, escritura-única, sin polling. 4 razones, la primera es que AC-5 ya lo decidió |
| 5 | MI-5 barrido **exhaustivo con shell y control positivo** | ✅ 11 consumidores + 1 lector del output del agente (`verification.ts:70` ⇒ CD-16) + 6 scripts. Control positivo: 284 hits de `steps` |
| 6 | MI-6 resuelto | ✅ Por irrelevancia (tabla nueva), y **se dice así**: la contradicción sobre `tasks` sigue abierta y es de otra HU |
| 7 | Los 14 CD del work-item heredados | ✅ §7.1, uno por uno, con su testigo |
| 8 | CD nuevos declarados | ✅ 8 (CD-15..CD-22), cada uno con la medición que lo motiva |
| 9 | Waves con archivos exactos **y presupuesto de líneas** | ✅ §4. W0=1334 · W1=1474 · W2=872 · total ≈3680. Umbral del CR: 7360 |
| 10 | ≥1 test por AC, con el archivo que lo lleva | ✅ §6, 12 ACs + 7 transversales, y para cada uno **cómo puede fallar por la razón equivocada** |
| 11 | Sección 8.1 con la versión **INSTALADA** leída del lockfile y dónde se verificó el API | ✅ §8.1, con la consecuencia dura (`keyof Schema['Functions']` ⇒ W0.6 obligatorio) y la declaración explícita de que no se agrega dependencia |
| 12 | El gate del repo identificado y ejecutable | ⚠️ **NC-2**: `npm run qa` no existe. El gate real es `ci.yml` (6 pasos ejecutables). **Bloquea F4, no F3** |
| 13 | `[NEEDS CLARIFICATION]` marcadas | ✅ 5 (§10). **Ninguna bloquea F2.5** |
| 14 | Riesgos declarados | ✅ 7 (§11), incluidos dos focos obligatorios de AR (R-1 y R-4) además de los dos que el work-item ya declaró (replay del token, el reloj) |
| 15 | ⛔ Corte B **no** diseñado, decisión (a)/(b) **no** tomada | ✅ Se declara como R-1 / NC-4 y se pasa al reporte de cierre |
| 16 | ⛔ El guard `i > 0` de `compose.ts:571` intocado | ✅ CD-7 + testigo `T-SUSP-GUARD571` anclado por **contenido**, no por número de línea |

### Focos obligatorios del AR (declarados desde ya)

1. **Replay del token de reanudación** (heredado del work-item).
2. **El reloj** (heredado) — pero **re-apuntado**: el peligro que DT-6 describía no existe; el que sí
   existe es que el `expires_at` se escriba desde Node. Atacar CD-19.
3. **R-4 — PII durable** en `steps_json`.
4. **DT-A1/DT-A2** — que `{success:true, suspended}` sea inalcanzable desde `/orchestrate`. Atacar
   `T-SUSP-CALLSITE`: ¿es un testigo o es un control que se lee a sí mismo?
5. **CD-18** — el doble cobro del fee de protocolo.

---

**Veredicto: el SDD está listo para el gate `SPEC_APPROVED`.**
Las 5 `[NEEDS CLARIFICATION]` están marcadas; ninguna bloquea F2.5; NC-2 bloquea F4 y hay que
cerrarla antes de llegar ahí.
