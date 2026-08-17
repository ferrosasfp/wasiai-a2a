# SDD #223 — [WKH-360] El coordinador es un agente: descubrible, contratable y a prueba de contratarse a sí mismo

> Producto de F2 (`nexus-architect`), 2026-08-17. Input: `work-item.md` (F1, mismo
> directorio), `.nexus/project-context.md`, `CLAUDE.md`, y los expedientes 220 / 221 / 222
> como exemplars de forma.
>
> **Disciplina de este documento.** Todo `archivo:línea` fue abierto y leído en ESTA
> sesión y su número re-derivado con `grep -n` / `Read` contra `3823580` — ninguno
> copiado del work-item ni del encargo. Todo número (conteos, precios, profundidades,
> costos) sale de un comando cuya reproducción está en el Anexo, con el commit al lado.
> Donde no pude medir dice `[NEEDS CLARIFICATION]` o **"medición inconclusa"**, con las
> dos lecturas posibles, y no una afirmación.
>
> **Commit del árbol base de todas las mediciones: `3823580`**
> (`3823580 docs(sdd): WKH-360 F1 + su fila en el indice (el guardian la exigia)`).

---

## 1. Resumen

Tres agujeros, y el del medio mueve plata:

1. **La carta existe y no dice cómo contratarla.** `GET /.well-known/agent.json` sirve
   una carta de **9 claves** con `authentication.schemes: []` y sin precio ni endpoint por
   skill. Medido en el gateway vivo de prod (Anexo A-1), no leído del código.
2. **No existe ningún guard anti-bucle, y lo confirmé por barrido.** El único `isSelf*`
   de `src/` es `isSelfReferral` (`src/services/agent-split-context.ts:69`), que es del
   split de fees. `resolveBaseUrl` — el único lector de "quién soy" del repo — se importa
   en **4 archivos de producción** y **ninguno** es del camino de compose/orchestrate
   (Anexo A-2). El camino de invocación no tiene noción de identidad propia.
3. **El fee en cascada es invisible en `/compose`.** El propio código lo dice
   (`src/routes/compose.ts:1050-1053`) y la respuesta es
   `reply.send({ kiteTxHash, ...result })` (`:1127`), mientras `/orchestrate/plan` sí
   declara `protocolFeeUsdc` / `feeRatePercent` (`src/routes/orchestrate.ts:439-440`).

Esta HU cierra los tres. Lo que este SDD **agrega** al work-item son cinco cosas que la
F1 no podía saber sin `Bash` ni red, y una de ellas **cambia el diseño**:

### 1.1 Lo que medí y que corrige o precisa al work-item

| # | Hallazgo medido | Consecuencia de diseño |
|---|---|---|
| **M-1** | **El guard de bucle en el loop del service NO alcanza para el step 0.** El débito del step-0 de `/compose` lo hace el middleware `requirePaymentOrA2AKey` (`src/routes/compose.ts:867-884`), que corre **antes** de que `composeService` exista; y en `/orchestrate` lo hace el propio service **antes** de llamar a compose (`src/services/orchestrate.ts:1133-1157`, `:1213`). Un bucle en el step 0 con el guard sólo en el loop se **cobra y se reembolsa best-effort** — exactamente lo que DT-6/CD-3 prohíben. | El guard de Capa 1 vive en **TRES sitios**, no uno. Ver §4.3. |
| **M-2** | **`new URL('https://EXAMPLE.com./x').hostname === 'example.com.'`** — el punto final **sobrevive**. Comparar identidad con `new URL(...).hostname` sin normalizar deja un bypass de una tecla. Y de paso: el docblock de `src/lib/self-published-auth.ts:82` afirma que su canonicalización deja el host *"sin punto final"* — **es falso**, medido (Anexo A-3). | El canonicalizador propio **quita el punto final explícitamente**, con test. Se reporta el over-claim ajeno como MENOR fuera de scope. |
| **M-3** | **`Number.parseInt('1e9', 10) === 1`** y **`Number('') === 0`** (Anexo A-3). Un `x-a2a-contracting-depth: 1e9` leído con `parseInt` da profundidad 1: pasa cualquier techo. Un header vacío leído con `Number` da 0: **primitiva de reseteo del contador**. | La profundidad se parsea con `^[0-9]{1,3}$` estricto y **presente-pero-ilegible se RECHAZA** (no se degrada a 0). Ver §4.5. |
| **M-4** | **La Capa 2 cubre el vector de redirect que la Capa 1 no ve, y lo cubre por accidente favorable.** `ssrfFetch` sigue redirects a mano (`src/lib/ssrf-dispatcher.ts:417-481`) y sólo revalida SSRF por hop (`:423`): un `invokeUrl` de tercero que responda `302 → https://<nosotros>/compose` **no lo ve la Capa 1**. Pero `CREDENTIAL_HEADERS` son 4 nombres explícitos (`:286-291`) y los nuestros no están, así que la traza **sobrevive el hop** y la Capa 2 lo caza en el inbound. | `src/lib/ssrf-dispatcher.ts` queda **FUERA del Scope IN**. Sin este dato lo natural era tocarlo (y chocar con CD-4). |
| **M-5** | **AC-8 tiene un número, no una promesa.** Los **25** agentes descubribles en prod (`POST /discover` con `{}`, Anexo A-4) tienen `invokeUrl` en `wasiai-v2.vercel.app` (22) y `wasiai-remittance-agents.vercel.app` (3). **0 de 25** apuntan al host del gateway. La Capa 1 con la identidad de hoy rechaza **cero** agentes del catálogo vivo. | CD-2 deja de ser aspiracional: tiene una línea base medible. |

Y dos cierres de los Missing Inputs de la F1:

- **Missing Input #5 RESUELTO (la suite NO está roja).** Los tres guardianes del repo
  pasan en `3823580`: `Test Files 3 passed (3)`, `Tests 29 passed (29)`. La suite
  completa: **`Test Files 280 passed | 6 skipped (286)`, `Tests 5441 passed | 19 skipped
  (5460)`, exit 0**. La fila `222` y la `223` **existen** (`doc/sdd/_INDEX.md:187` y
  `:215`). `tsc --noEmit` → exit 0. Anexo A-5.
- **Riesgo de conflicto de ramas RESUELTO: es CERO.** Las 13 ramas con worktree vivo
  (`git worktree list`) están **todas mergeadas** en `main`
  (`git rev-list --count main..<rama> == 0` para las 13). Ninguna HU en vuelo toca
  `src/services/compose.ts` ni `src/routes/compose.ts`. Anexo A-6.

---

## 2. Work Item y Acceptance Criteria

Fuente: `doc/sdd/223-coordinador-como-agente/work-item.md` (373 líneas). Los 12 ACs se
heredan **sin reabrirse**. Mapa AC → dónde se resuelve en este SDD:

| AC | Qué exige | §  | Wave |
|----|-----------|----|------|
| AC-1 | carta con precio, esquema de auth y endpoint por skill; sigue gratis y sin rate-limit | §4.7 | W3 |
| AC-2 | una sola función `buildSelfAgentCard`; `/capabilities` sigue derivando | §4.7 | W3 |
| AC-3 | dato no resoluble ⇒ **omitir** el campo (nunca `0`/`null`/placeholder) | §4.7.3 | W3 |
| AC-4 | bucle DIRECTO: rechazo **antes** del débito y **antes** del fetch, `errorCode` propio | §4.3 | W1 |
| AC-5 | bucle TRANSITIVO: traza entrante que ya nos contiene ⇒ mismo `errorCode`, antes de cobrar | §4.5 | W2 |
| AC-6 | techo de profundidad, fail-closed ante techo ausente/ilegible | §4.5 | W2 |
| AC-7 | propagación: emitir traza + profundidad incrementada en el invoke | §4.6 | W2 |
| AC-8 | caso legítimo **byte-idéntico** (entrante y saliente, incluido un pipeline de `MAX_COMPOSE_STEPS`) | §4.9, §7 | W1–W4 |
| AC-9 | no auto-inmunidad: el caso directo NO exige cooperación; la limitación queda escrita en código y en el error | §4.4 | W1/W2 |
| AC-10 | `/compose` 200 declara el fee de protocolo de **este** gateway, aditivo | §4.8 | W4 |
| AC-11 | fee de orquestación **ajeno** por separado; no declarado ⇒ marcado, nunca `0` | §4.8.2 | W4 |
| AC-12 | estrictamente aditivo en las dos respuestas | §4.8.4 | W4 |

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos, y qué saqué de cada uno

| Archivo (líneas leídas) | Qué extraje |
|---|---|
| `src/services/compose.ts` (`:190-620`, `:690-750`, `:1100-1170`, `:1334-1571`) | El pipeline entero del camino de dinero. Orden exacto: `resolveAgent` (`:338`) → scoping (`:351-376`) → `resolveStepInput` (`:400`) → gas (`:432-433`) → guard de budget (`:446-461`) → `stepDestination` (`:486-488`) → **débito per-step (`:545-553`)** → `invokeAgent` (`:618`) → `finishSuccessfulStep` (`:629`). Refund best-effort en `:704-733`. Retry re-invoca en `:969`. |
| `src/services/compose.ts` (`:1373-1571`) | `invokeAgent`: headers construidos en `:1424-1431`; `x-a2a-key` sólo si el registry es system-trusted (`:1445-1448`); SSRF pre-fetch en `:1489-1503`; **el único `ssrfFetch` de invocación de agentes en `:1516`**; parseo de la respuesta en `:1538-1539`; `signAndSettleDownstream` en `:1555`; return en `:1565-1569`. |
| `src/routes/compose.ts` (`:40-140`, `:375-500`, `:505-564`, `:700-838`, `:840-890`, `:990-1133`) | La cadena de preHandlers **completa** (`:845-885`) y el punto exacto del débito. `resolveComposePriceHandler` (`:700-838`) ya resuelve el agente del step 0 y aborta pre-débito con `return reply` (`:719`, `:756`, `:833`). Mapeo de `errorCode`→status en `:1026-1031`. El comentario que dice que no se serializa fee en `:1050-1053`. `feeResult.feeUsdc` disponible en `:1095`. Respuesta en `:1127`. |
| `src/routes/orchestrate.ts` (`:60-160`, `:279-300`, `:330-460`, `:463-520`) | `markSkipMiddlewareDebitHandler` (`:71-75`) apaga el débito del middleware en las **tres** rutas (`:146`, `:288`, `:515`). `feeRatePercent` (`:350-353`) y `protocolFeeUsdc` (`:365-368`) derivados de `getProtocolFeeRate()`. Respuesta de `/plan` en `:433-447`. |
| `src/services/orchestrate.ts` (`:1060-1250`) | `executeApprovedPlan`. **El comentario de `:1099-1100` es la doctrina que esta HU reusa**: *"Cap gate — ANTES del price-fallback y de cualquier `budgetService.debit` o `composeService.compose`"*. Débito del step-0 en `:1133-1157`; `composeService.compose` en `:1213`. |
| `src/services/agent-card.ts` (`:1-246`) | `resolveBaseUrl` (`:67-76`): `BASE_URL` > `x-forwarded-proto`+hostname > protocol+hostname. `buildSelfAgentCard(baseUrl)` (`:197-245`), `authentication.schemes: []` (`:228-230`). El patrón de omisión de campos opcionales (`:169-190`). El patrón "el route resuelve ANTES de llamar" (`:113-114`). |
| `src/lib/self-published-auth.ts` (`:1-253`) | **El exemplar central de este SDD**: env-var como mapa/lista de hosts, `canonicalizeHostKey` (`:89-105`), `parseEnv` sin cache (`:107-181`), estado público sin secretos (`:187-191`), `assertSelfPublishedAuthEnv` (`:201-218`), consumo en `:232-252`. |
| `src/lib/env.ts` (`:1-152`) | `isProduction()` (`:22-24`). El tratamiento **de dos niveles** de una env: `assertDepositMinimumEnv` (`:107-131`) → *presente-pero-ilegible = THROW en cualquier NODE_ENV; ausente = warning ruidoso*. `assertRequiredEnv` (`:133-151`) → prod-only. |
| `src/lib/discovery-fetch-limit.ts` (`:1-301`) | Por qué el módulo nuevo va **leaf** (`:1-11`) y cómo se documenta un techo con su derivación y sus contra-ejemplos. |
| `src/lib/ssrf-dispatcher.ts` (`:60-130`, `:150-220`, `:280-320`, `:380-501`) | `isBlockedAddress` como predicado compartido (`:99`, `:212`, `:309` de `url-validator`). `MAX_REDIRECT_HOPS = 5` (`:179`). El loop manual de redirects (`:417-481`) con revalidación por hop (`:423`). `CREDENTIAL_HEADERS` = 4 nombres (`:286-291`) y `stripCredentialHeaders` (`:298-317`), aplicado sólo cross-origin (`:469-471`). |
| `src/middleware/timeout.ts` (`:1-25`) | `createTimeoutHandler` **sólo manda un 504**; no aborta trabajo. |
| `src/middleware/rate-limit.ts` (`:1-66`) | `orchestrateRateLimit()` (`:52-58`): `RATE_LIMIT_ORCHESTRATE_MAX` default **10** / `RATE_LIMIT_WINDOW_MS` default **60000**. Store en proceso (`:36-45`). |
| `src/middleware/a2a-key.ts` (`:160-210`) | `extractSignedHeaders` (`:187-195`): el patrón de lectura de headers `x-a2a-*` (`pick` con `typeof h === 'string'`, ausencia → `undefined`). |
| `src/services/fee-charge.ts` (`:1-135`) | `FeeChargeResult` como unión discriminada de **4** estados (`:75-90`): `charged` / `already-charged` / `skipped(WALLET_UNSET)` / `failed`. `getProtocolFeeRate()` (`:133`), rango `[0.0, 0.10]`, default `0.01` (`:106-108`). |
| `src/services/agent-price.ts` (`:1-124`) | `resolveAgentPriceUsdc` (`:44-85`, cache 60 s) y `resolveAgentDestination` (`:105-115`) — **resuelve el `Agent` completo y descarta el `invokeUrl`**. |
| `src/adapters/registry.ts` (`:505-537`) | `acceptsInboundPayment` (`:522`) — la ÚNICA definición de la asimetría — y `getInboundPaymentChainKeys()` (`:532`). |
| `src/lib/pricing-constants.ts`, `src/lib/compose-limits.ts`, `src/lib/step0-debit.ts` | `PLACEHOLDER_FEE_USD = 1.0` (`pricing-constants.ts:16`); `MAX_COMPOSE_STEPS = 5` (`compose-limits.ts:38`); `resolveStep0DebitUsd` (`step0-debit.ts:28-34`). |
| `src/lib/stranded-payment.ts` (`:320-370`) | `resolveEffectivePipelineBudgetUsd` (`:342-348`) y por qué el techo **se entrega sin configurar** (`:325-337`) ⇒ hoy `+Infinity`. |
| `src/types/index.ts` (`:1076-1200`, `:1363-1422`, `:1673-1733`) | `ComposeResult` (`:1076-1116`) y su `errorCode` de 3 valores (`:1091`); `StepResult` (`:1144-…`) con `downstreamSkipCode` como exemplar de campo aditivo; `OrchestratePlanResult` (`:1363-1422`) con `discoveredAgents: Agent[]` (`:1398`); `AgentSkill` (`:1673-1677`) y `AgentCard` (`:1679-1733`). |
| `src/services/discovery.ts` (`:1345-1382`), `src/services/agent.ts` (`:139`) | De dónde sale `invokeUrl`: `registry.invokeEndpoint` con `{slug}`/`{agentId}` (federado) o `row.agent_url` (self-published). **Los dos los controla un caller autenticado.** |
| `src/index.ts` (`:170-230`, `:270-310`) | El log de arranque con `setting`/`hosts`/`count` (`:173-182`) como exemplar. Los prefijos de ruta (`:270-310`). |
| `doc/sdd/220…/auto-blindaje.md`, `221…/auto-blindaje.md`, `222…/auto-blindaje.md` | §3.6. |

### 3.2 Exemplars verificados (existen, los abrí, cito su forma)

| Qué copio | De dónde | Verificado |
|---|---|---|
| Módulo **leaf** con cero imports, consumido por route + service | `src/lib/compose-limits.ts:1-38`, `src/lib/discovery-fetch-limit.ts:1-11`, `src/lib/downstream-skip-code.ts` | `ls -la src/lib/` + `Read` |
| Env de **lista de hosts** canonicalizada + fail-closed + assert de arranque | `src/lib/self-published-auth.ts:59`, `:89-105`, `:201-218` | `Read` completo (253 líneas) |
| Env de **dos niveles** (ilegible ⇒ throw; ausente ⇒ warn ruidoso) | `src/lib/env.ts:107-131` | `Read` completo |
| **Log de arranque** estructurado con `setting`/`value`/`count` | `src/index.ts:173-182`, `:189-205` | `Read` |
| **Guard pre-débito en preHandler** que aborta con `return reply` | `src/routes/compose.ts:719-722`, `:756-759`, `:833-836`, y `validateComposeBodyHandler` en el array (`:857`) | `Read` |
| **Guard pre-débito en service** con el orden escrito en el comentario | `src/services/orchestrate.ts:1099-1115` | `Read` |
| **Campo aditivo en respuesta pública** con el patrón de omisión | `src/routes/capabilities.ts:41-43` y `:77-86`; `src/services/agent-card.ts:169-190` | `Read` |
| **Campo aditivo threadeado** `invokeAgent → finishSuccessfulStep → StepResult` | `downstreamSkipCode`: `compose.ts:1395`, `:1563`, `:1128`; `types/index.ts:1188-1199` | `Read` |
| **`errorCode` nuevo que NO agrega rama de status** | `INPUT_MAPPING_FAILED`: `types/index.ts:1086-1090`, `routes/compose.ts:1026-1031` | `Read` |
| **Lectura de header `x-a2a-*`** con `pick` estricto | `src/middleware/a2a-key.ts:187-195` | `Read` |
| **Tri-estado en vez de booleano** para un resultado externo | `src/services/fee-charge.ts:75-90`; `PAYOUT_NO_SPEND_CODES` (`.nexus/project-context.md:247-250`) | `Read` |

### 3.3 Línea base, medida en este worktree

```
commit                3823580
tsc --noEmit          exit 0
guardianes (3)        Test Files 3 passed (3) · Tests 29 passed (29)
suite completa        Test Files 280 passed | 6 skipped (286)
                      Tests 5441 passed | 19 skipped (5460)  · exit 0
prod /.well-known     9 claves · authentication.schemes: [] · sin paymentIntents
prod /discover {}     total=25 · hosts: wasiai-v2.vercel.app (22),
                      wasiai-remittance-agents.vercel.app (3) · gateway: 0
```

### 3.4 Los cinco ataques de URL, medidos uno por uno

Estos son los que un AR va a tirar contra la Capa 1. Medidos con `node -e` (Anexo A-3),
no razonados:

| Variante del destino | `new URL(...).hostname` | ¿matchea `gw.example.com`? | Cómo lo cierra el diseño |
|---|---|---|---|
| `https://GW.EXAMPLE.COM/compose` | `gw.example.com` | **sí** (`new URL` baja a minúsculas) | gratis |
| `https://gw.example.com./compose` | **`gw.example.com.`** | **NO** ⚠️ | el canonicalizador **quita el punto final** (§4.2) |
| `https://пример.рф/` vs `https://xn--e1afmkfd.xn--p1ai/` | los dos `xn--e1afmkfd.xn--p1ai` | **sí** | gratis (punycode) |
| `https://gw.example.com:8443/compose` | `gw.example.com` (`port` = `8443`) | **sí** | se compara **sólo el hostname**: puerto y esquema se ignoran (§4.2) |
| `https://user:pw@gw.example.com/` | `gw.example.com` | **sí** | gratis (userinfo no entra al hostname) |
| `https://69.46.46.64/compose` (nuestra IP) | `69.46.46.64` | **NO** ⚠️ | **residual declarado** (§10, R-3): la comparación es por NOMBRE |
| `https://tercero.example/r` → `302 → https://gw.example.com/compose` | `tercero.example` en el momento del guard | **NO** | lo caza la **Capa 2** vía la traza, que sobrevive el hop (M-4) |

Dato colateral que convierte el punto final de teórico en medido, **y de paso muestra por
qué no alcanza con que hoy no funcione**: `https://wasiai-a2a-production.up.railway.app./health`
devuelve **404** desde el borde de Railway (`/health` devuelve `200`). O sea que hoy la
variante con punto final **no llega a la app**. Eso NO es un guard: es la política de
ruteo por Host de un hosting, que cambia el día que se agrega un dominio propio o se
mueve el deploy. Es la clase *"lo que frena es accidental, no un guard"*, y por eso el
canonicalizador lo normaliza igual y hay un test que lo fija.

### 3.5 El header hostil, medido

| Valor de `x-a2a-contracting-depth` | `Number.parseInt(v,10)` | `Number(v)` | `^[0-9]{1,3}$` | Qué hace el diseño |
|---|---|---|---|---|
| ausente | — | — | — | profundidad **0** (caller directo; es el 100% del tráfico de hoy) |
| `'0'` … `'999'` | igual | igual | ✅ | valor |
| `'1e9'` | **`1`** ⚠️ | `1000000000` | ❌ | **RECHAZO** |
| `''` | `NaN` | **`0`** ⚠️ | ❌ | **RECHAZO** (si fuera 0 sería un reseteo del contador) |
| `' 2'` | **`2`** ⚠️ | `2` | ❌ | **RECHAZO** |
| `'2abc'` | **`2`** ⚠️ | `NaN` | ❌ | **RECHAZO** |
| `'0x10'` | `0` | `16` | ❌ | **RECHAZO** |
| `'1000'` (4 dígitos) | `1000` | `1000` | ❌ | **RECHAZO** (por forma, antes de comparar) |

Las cuatro filas con ⚠️ son la razón por la que este SDD **no usa `parseInt` ni `Number`**
para la profundidad. Tres de ellas producen un número **plausible y menor al techo**: el
modo de falla no es un error, es un guard que aplaude.

### 3.6 Auto-Blindaje histórico (las 3 HUs DONE más recientes)

Leí `doc/sdd/222-…/auto-blindaje.md` (7 entradas), `doc/sdd/221-…/auto-blindaje.md`
(8 entradas) y `doc/sdd/220-…/auto-blindaje.md` (3 entradas). Dos patrones aparecen en
**las tres** — o sea que ya no son anécdota, y por eso bajan a CD-11 y CD-12:

- **Patrón A — "mis propias ediciones corrieron las líneas que yo citaba"**, en las 3:
  `220:25-36`, `221:36-57`, `221:128-160`, `221:185-224`, `222:134-192`. En 221 el mismo
  defecto volvió **dentro de su propia corrección**, y en 222 un "fix declarado" arregló
  2 de 6 citas y **apagó la sospecha** sobre las otras 4. El control que funciona no es
  cuidado: es `git diff -U0 <base> -- <archivo> | grep '^@@'` para sacar el punto de
  inserción y el delta, y re-medir **toda** cita del propio archivo por debajo de ese
  punto comparando **contenido**, no número (`221:204-214`). Y la edición **línea-neutra**
  pasa de preferencia a obligación cuando el bloque editado tiene auto-citas.
- **Patrón B — "escribí un número/hash/consecuencia que no medí, con el mismo tono que
  los que sí medí"**, en las 3: `220:38-48` (casi copié el conteo del CR), `221:98-124`
  (tres afirmaciones infalsificables **dentro de su propio archivo**), `222:8-36` (copié
  del Story File "la suite queda ciega" y eran 13 rojos, 11 fuera), `222:109-130` (un
  hash de commit **inventado con forma correcta**), `222:254-290` (un mutante al que le
  cargué 2 rojos preexistentes, y un `sha256sum` sin su commit).

Dos más que valen solos y también bajan a CD:

- **`cmd | tail; echo $?` mide el exit de `tail`**, y el wrapper de este shell corrompe la
  salida redirigida con exit 0 — las dos empujan al **verde falso** (`221:164-181`).
- **`sed -n '326p;287p;292p'` imprime en orden de ARCHIVO**, no en el que pediste, y casi
  produjo un hallazgo falso porque las tres líneas eran plausibles (`221:228-250`).
- **Un refixture consume un testigo sin poner nada en rojo** (`222:196-250`, dos instancias
  medidas). Aplica directo acá: si una wave cambia un `url:` que otra usa como
  discriminante, el testigo se apaga en verde.

### 3.7 Lo que el AR va a atacar, en orden

1. **La variante de URL.** Punto final, mayúsculas, puerto, userinfo, IDN, IP literal,
   redirect. §3.4 tiene la tabla y §10 el residual honesto.
2. **El orden respecto del dinero.** ¿El corte del step 0 está antes del middleware de
   débito en `/compose` y antes de `budgetService.debit` en `/orchestrate`? Es M-1 y es
   la mitad del valor de la HU.
3. **El header forjado.** Los 8 valores de §3.5, más un header de 8 KB y una traza de
   10.000 elementos.
4. **La vacuidad.** ¿Cada test de rechazo tiene su gemelo que prueba que el endpoint
   sigue vivo? CD-7.
5. **El over-claim.** "bucle transitivo cerrado" a secas. CD-6 obliga a lo contrario.
6. **Las citas.** Patrón A de §3.6.

---

## 4. Diseño técnico

### 4.1 Vista de una pantalla

```
                     ┌──────────────────────────────────────────┐
   petición entrante │ preHandler NUEVO  (Capa 2, inbound)      │  ← AC-5 / AC-6
   (compose /        │  · traza contiene mi id  → LOOP          │    ANTES de
    orchestrate*)    │  · profundidad >= techo  → DEPTH         │    requirePaymentOrA2AKey
                     │  · header mal formado    → MALFORMED     │
                     └───────────────┬──────────────────────────┘
                                     │
                     ┌───────────────▼──────────────────────────┐
   /compose          │ resolveComposePriceHandler (ya existe)   │  ← AC-4, step 0
   sólo              │  + Capa 1 sobre el invokeUrl del step 0  │    ANTES del
                     └───────────────┬──────────────────────────┘    débito del middleware
                                     │
                     ┌───────────────▼──────────────────────────┐
                     │ requirePaymentOrA2AKey  ← EL DÉBITO       │
                     └───────────────┬──────────────────────────┘
                                     │
   /orchestrate*     ┌───────────────▼──────────────────────────┐
   sólo              │ executeApprovedPlan, tras el cap gate    │  ← AC-4, step 0
                     │  + Capa 1 sobre TODOS los steps del plan │    ANTES de
                     └───────────────┬──────────────────────────┘    budgetService.debit
                                     │
                     ┌───────────────▼──────────────────────────┐
                     │ composeService.executePipeline, loop i    │
                     │  + Capa 1 por step (autoritativa)        │  ← AC-4, steps 1..N
                     │    ANTES de budgetService.debit (:545)   │    (y anti-drift del
                     └───────────────┬──────────────────────────┘     preflight)
                                     │
                     ┌───────────────▼──────────────────────────┐
                     │ invokeAgent: emite traza + profundidad+1 │  ← AC-7
                     │  + Capa 1 de último recurso, pre-fetch   │    (NO es el guard de
                     └──────────────────────────────────────────┘     dinero — §4.3.4)
```

### 4.2 DT-A — La identidad propia: **por nombre, desde env, y nunca desde el request como única fuente**

`resolveBaseUrl` (`src/services/agent-card.ts:67-76`) **no sirve** como fuente única del
guard, por dos motivos medidos y uno estructural:

1. **Su rama 2 y 3 dependen de headers del caller**: `x-forwarded-proto` y
   `request.hostname` (que es el `Host`, o el `X-Forwarded-Host` con `trustProxy`
   activo). Una identidad que el caller puede mover es una identidad que el caller puede
   **vaciar**.
2. **Necesita un `FastifyRequest`**, y el loop de `composeService.executePipeline`
   (`:305-313`) no lo tiene: recibe un `ComposeRequest`, que no lo lleva
   (`src/types/index.ts` → `ComposeRequest`; verificado en el destructuring de `:314-328`).
3. **Está importado en 4 archivos y ninguno es del camino de compose** (Anexo A-2): usarlo
   ahí sería estrenar un lector nuevo del concepto en la ruta más caliente.

**El conjunto de identidad**, resuelto por una sola función del módulo leaf:

```
selfHostSet(hint?: string) =
     canon(hostname(BASE_URL))            si BASE_URL está seteada
   ∪ { canon(h) : h ∈ csv(A2A_SELF_HOSTS) }
   ∪ { canon(hint) }                      si el call-site tiene un request
```

- `canon(h)` = `new URL('https://' + h).hostname` con el **punto final quitado**
  (M-2), y `null` si no es exactamente un host (con esquema, puerto, userinfo o path →
  `null`). Es `canonicalizeHostKey` de `src/lib/self-published-auth.ts:89-105` **más** el
  strip del punto final, reescrito en el leaf (no se importa: ese módulo no es leaf y
  además su docblock afirma algo que no hace, M-2).
- La comparación es **sólo por `hostname`**: puerto y esquema se ignoran a propósito.
  `https://yo:8443/x` y `http://yo/x` **siguen siendo yo**, e ignorarlos es la dirección
  fail-closed (rechaza más, nunca menos).
- **Por qué el `hint` del request es seguro**: el conjunto se usa **únicamente como
  predicado de negación**. Agrandarlo sólo puede producir **más rechazos**, nunca menos.
  Un caller que mande `Host: victima-agente.com` logra que el gateway **se niegue** a
  llamar a `victima-agente.com` **en su propio request**, que es un auto-DoS de una sola
  petición, no un bypass. Esta monotonía es la propiedad que hay que atacar en el AR y la
  que hace admisible una fuente influible.
- **Por qué el `hint` hace falta**: sin él, un deploy sin `BASE_URL` ni `A2A_SELF_HOSTS`
  tiene conjunto **vacío** y la Capa 1 queda inerte — el escenario que CD-1 prohíbe. Con
  el `hint`, el caso más común del bucle (el caller le pega a `https://gw/compose` y el
  step apunta a `https://gw/...`) se corta **sin ninguna configuración**.
- **Identificador de la cadena (DT-5 del work-item)**: es el **primer elemento** del
  conjunto en orden canónico —`hostname(BASE_URL)` si existe, si no el primer
  `A2A_SELF_HOSTS`, si no el `hint`—. **No se agrega una env nueva para esto**: un
  `A2A_GATEWAY_ID` suelto es un cuarto lugar donde "quién soy" puede divergir. Derivarlo
  es lo que garantiza que la traza que emitimos sea comparable con el conjunto que
  comparamos.

**Estado de la configuración, publicado y no supuesto.** Dos mecanismos, siguiendo
`src/lib/env.ts:107-131`:

- **Presente-pero-ilegible ⇒ THROW en el arranque, en cualquier `NODE_ENV`.**
  `A2A_SELF_HOSTS='https://gw'` (con esquema) o con una entrada duplicada es el caso en el
  que el operador **cree** tener la identidad puesta.
- **Conjunto env VACÍO ⇒ `log.warn` ruidoso al arrancar**, con el texto que dice
  exactamente qué queda cubierto (el `hint` por request) y qué no (los alias que no son el
  host por el que entró la petición). **No THROW**: no pude verificar el valor de
  `BASE_URL` en el Railway de prod (§9, NC-1) y voltear el servicio por eso sería un
  radio de explosión mayor que el problema — es la misma disyuntiva, con la misma
  resolución, que `assertDepositMinimumEnv`.
- **`GET /health` publica el estado** (aditivo, sin valores sensibles):
  `contractingGuard: { selfHostCount: n, depthMax: d, source: 'env'|'request-only' }`.
  Un host no es un secreto —`POST /discover` ya publica el `invokeUrl` de los 25 agentes
  (§3.3)— y esto convierte "el guard está puesto" en algo verificable desde afuera en vez
  de una creencia. Precedente exacto: `/health` ya lleva el campo aditivo de pagos
  varados (HU-306, `.nexus/project-context.md:426`). ⚠️ `/health` está registrado **inline
  en `src/index.ts:237`**, no en `src/routes/` (§6, W1).

### 4.3 DT-B — La Capa 1 vive en TRES sitios, y sólo dos son guards de dinero

Éste es el hallazgo M-1 convertido en diseño. El work-item propuso el guard "antes del
débito (`compose.ts:545-573`)", que es correcto **para los steps 1..N y falso para el
step 0**, porque el step 0 lo debita otra capa.

#### 4.3.1 Sitio 1 — `/compose`, step 0: dentro de `resolveComposePriceHandler`

`src/routes/compose.ts:700-838`, en el mismo `try` donde ya vive `resolveAgentDestination`
(`:729-735`). Corre **antes** de `requirePaymentOrA2AKey` (`:867-884`) porque está antes en
el array de preHandlers (`:845-885`), y aborta con el idiom que este archivo ya usa tres
veces: `return reply.status(400).send({...})` (`:719`, `:756`, `:833`).

**Cómo obtiene el `invokeUrl` sin una resolución extra**: `resolveAgentDestination`
(`src/services/agent-price.ts:105-115`) ya resuelve el `Agent` completo y **descarta**
todo menos `{registry, slug}`. Se extiende su return con `invokeUrl` — aditivo, un solo
call-site en producción (`routes/compose.ts:729`), cero llamadas nuevas a discovery.

**Por qué el guard NO va en `augmentX402ChallengeAmount`** (que ya recorre los steps
1..N pre-débito, `routes/compose.ts:447-480`): sus dos call-sites lo envuelven en
`.catch()` (`:789-794`, `:815-820`). Un guard dentro de un bloque best-effort es un guard
que se puede tragar. Los steps 1..N los cubre el Sitio 3.

#### 4.3.2 Sitio 2 — `/orchestrate*`, todos los steps del plan: en `executeApprovedPlan`

`src/services/orchestrate.ts`, **inmediatamente después del cap gate (`:1115`) y antes del
price-fallback (`:1117-1127`)**. El comentario de `:1099-1100` ya declara ese punto como
"ANTES del price-fallback y de cualquier `budgetService.debit` o `composeService.compose`":
el guard nuevo se para exactamente ahí, y por lo tanto antes del débito de `:1149-1157`.

Cubre las **tres** rutas de orchestrate porque las tres desembocan acá, y las tres apagan
el débito del middleware con `markSkipMiddlewareDebitHandler` (`routes/orchestrate.ts:146`,
`:288`, `:515`), o sea que en orchestrate **el único débito del step 0 es el del service**.

**De dónde sale el `invokeUrl` acá**: `plan.discoveredAgents: Agent[]`
(`src/types/index.ts:1398`) trae los `Agent` completos. **PROHIBIDO cruzarlo a mano contra
`plan.steps[i].agent`**: sería una segunda expresión de la resolución y divergiría en
`/orchestrate/execute`, donde los steps vienen del body del cliente
(`routes/orchestrate.ts:478-491`). Se usa la MISMA función del Sitio 1
(`resolveAgentDestination`, extendida con `invokeUrl`), llamada por step. Costo: N lookups
con cache de 60 s (`agent-price.ts:16`, `:53-55`) y local-first para self-published
(`discovery.ts:1387-1389`) — y en `/execute` ese lookup ya ocurre igual dentro de
`quoteMaxCostUsdc` (`orchestrate.ts:1103-1106`).

#### 4.3.3 Sitio 3 — el loop del pipeline, steps 1..N: `composeService.executePipeline`

`src/services/compose.ts`, **después del bloque de scoping (`:376`) y antes de
`resolveStepInput` (`:400`)**. Tres razones para ese punto exacto, todas leídas del
comentario que ya está ahí (`:377-399`):

- el débito per-step está en `:545-553`, muy abajo ⇒ CD-3 satisfecho con margen;
- `getStepGasOverheadUsd` (`:432-433`) **LANZA** en mainnet sin configurar, así que un
  bucle no puede reportarse como un error de gas;
- la autorización va primero (doctrina escrita en `:385-386`): un caller sin scope para
  ese agente recibe `SCOPE_DENIED` (403) y no un error de bucle. Los dos rechazan antes
  de cobrar, así que el orden entre ellos no es una decisión de dinero.

Cubre el happy-path (`invokeAgent` en `:618`) y el retry adaptativo (`:969`) porque los dos
están dentro de la misma iteración del loop.

**Este sitio es autoritativo aunque los Sitios 1 y 2 ya hayan pasado**: el precio tiene
cache de 60 s y el catálogo puede cambiar entre el preflight y la ejecución. Un destino
que era ajeno cuando se cotizó puede ser propio cuando se ejecuta.

#### 4.3.4 Sitio 4 — `invokeAgent`, pre-fetch: NO es un guard de dinero, y hay que decirlo

`src/services/compose.ts`, junto al SSRF de `:1489-1503` y antes de `ssrfFetch` (`:1516`).
AC-4 exige que **no se emita la petición HTTP saliente**, y `:1516` es el único
`ssrfFetch` de invocación de agentes de todo `src/` (Anexo A-2): es el choke-point.

**Y es exactamente el sitio equivocado para el dinero**: un throw acá lo agarra el catch
per-step, o sea **después** del débito de `:545-553`. Por eso:

- se escribe **en el código**, en su propio comentario, que este no es el guard de CD-3
  sino el bloqueo de emisión de último recurso;
- si dispara, loguea a **`error`** con un mensaje que dice que el guard pre-débito **no
  corrió** y que hay residuo con reembolso best-effort;
- un test fija el ORDEN: con un destino propio, el Sitio 3 corta y `budgetService.debit`
  registra **cero llamadas** y `ssrfFetch` **cero llamadas**. Si algún día alguien mueve
  el Sitio 3, ese test se pone rojo antes de que el Sitio 4 lo tape.

### 4.4 DT-C — AC-9: dónde está escrita la no-auto-inmunidad, y por qué NO hay bandera

- **La Capa 1 no consulta ningún header del caller.** Su input es (destino resuelto,
  conjunto de identidad). Un test lo fija: request **sin ningún header de contratación** →
  rechazo igual.
- **NO se implementa la allow-list de CD-1.** CD-1 dice que *la única bandera admisible*
  es una allow-list vacía por default; no dice que haya que shippearla. **Hoy no existe
  ningún caso legítimo de auto-contratación**: los 25 agentes del catálogo vivo apuntan a
  otros dos hosts (M-5). Shippear un knob sin caso de uso es shippear el knob que alguien
  va a llenar. No shippear nada es estrictamente más fail-closed. Si aparece el caso,
  entra como HU propia **con la forma que CD-1 prescribe** (allow-list por host, vacía por
  default, `=== 'true'`/CSV estricto). Queda como **TD-360-1**.
- **La limitación de la Capa 2 viaja en la respuesta de error**, no sólo en el SDD
  (CD-6): el body del rechazo lleva `layer: 'direct' | 'chain'` y, para `'chain'`, la
  frase que dice que ese carril **depende de que la contraparte reenvíe los headers** y
  que contra alguien que los borra a propósito lo que queda en pie es el carril
  `'direct'`. El texto es una **constante del módulo leaf**, así que el mensaje que emite
  el código y el que asserta el test no pueden divergir.

### 4.5 DT-D — La Capa 2: contrato de los headers, y el rechazo de lo ilegible

**Nombres.** Familia `x-a2a-*`, que es la que este repo usa para lo que es **protocolo A2A**
(`x-a2a-key`, `x-a2a-nonce`, `x-a2a-signature`, `x-a2a-timestamp`,
`x-a2a-payment-chain`, `x-a2a-remaining-budget`), a diferencia de `x-wasiai-*`, que es
interno del gateway (Anexo A-2 lista los 29 headers `x-` del repo). Otro coordinador tiene
que poder hablar esto:

| Header | Forma | Ausente significa |
|---|---|---|
| `x-a2a-contracting-chain` | CSV de hostnames canónicos, en orden de contratación | cadena vacía |
| `x-a2a-contracting-depth` | entero decimal, `^[0-9]{1,3}$` | **0** |

**Ausente = 0 / vacío, y eso NO es una concesión**: es el 100% del tráfico de hoy. Tratar
la ausencia como rechazo sería romper todos los callers (CD-2). Lo que **no** puede
tratarse como ausencia es **presente-pero-ilegible**, porque ahí el reseteo del contador
es el ataque, no un accidente (M-3, tabla de §3.5).

**Validación del inbound, en este orden** (forma antes de semántica; largo antes de
parsear):

1. **Largo del header de cadena.** Techo derivado, no elegido:
   `min( (253 + 1) × (depthMax + 1), 4096 )`. El 253 es el largo máximo de un FQDN; el
   `+1` es el separador; el `depthMax + 1` son los elementos que una cadena legítima puede
   traer; el `4096` es un tope absoluto para que un `A2A_CONTRACTING_DEPTH_MAX` grande no
   deje el techo sin efecto. Con el default `depthMax = 2` ⇒ **762 caracteres**. Por
   encima: rechazo `CONTRACTING_CHAIN_MALFORMED`. **Antes** de `split`, porque el punto es
   no materializar un arreglo grande a pedido de un tercero (misma clase que
   `previewDeclaredMaxLimit`, `src/lib/discovery-fetch-limit.ts:136-147`).
2. **Cantidad de elementos** ≤ `depthMax + 1`. Por encima: mismo rechazo.
3. **Forma de cada elemento**: `canon(e)` distinto de `null`. Alguno inválido: mismo
   rechazo. (Rechazar y no ignorar: un elemento basura al lado de los válidos es la forma
   de meter ruido para que un lector laxo pierda el nuestro.)
4. **Profundidad**: ausente ⇒ 0; presente y `^[0-9]{1,3}$` ⇒ valor; presente y cualquier
   otra cosa ⇒ rechazo `CONTRACTING_DEPTH_MALFORMED`.
5. **Membresía**: `selfHostSet ∩ elementos ≠ ∅` ⇒ rechazo `CONTRACTING_LOOP_DETECTED`
   con `layer: 'chain'` (AC-5, mismo `errorCode` que AC-4 tal como AC-5 exige).
6. **Techo**: `depth >= depthMax` ⇒ rechazo `CONTRACTING_DEPTH_EXCEEDED` (AC-6).

Los pasos 1–4 son rechazos **seguros**: un header forjado sólo puede hacer fallar **la
petición que lo trae**. No hay forma de usarlos contra un tercero.

**El techo, y su lectura fail-closed (AC-6).** `A2A_CONTRACTING_DEPTH_MAX`, entero
`^[0-9]{1,3}$` en `[0, 64]`. Ausente **o ilegible** ⇒ **el default del código**, jamás
`Infinity`. Patrón exacto de `resolveUpstreamFetchLimit`
(`src/lib/discovery-fetch-limit.ts:74-79`) y de `readPipelineCeilingUsd`
(`src/lib/stranded-payment.ts:351-356`), con una diferencia deliberada: acá el valor
ilegible además **se loguea al arrancar** (`warn`), porque un techo que se cae al default
en silencio es el caso en el que el operador cree tener otro número
(`src/lib/stranded-payment.ts:358-369` documenta ese mismo problema para el techo de
exposición).

### 4.5.1 El default del techo, derivado con números (no elegido)

El costo de un bucle **no es lineal en la profundidad: es exponencial, con base
`MAX_COMPOSE_STEPS`**. Eso es lo que decide el número, y no una intuición sobre "cuántos
coordinadores es razonable".

Datos medidos:

- fan-out por nivel = `MAX_COMPOSE_STEPS = 5` (`src/lib/compose-limits.ts:38`);
- peor caso del débito por step = `PLACEHOLDER_FEE_USD = $1.00`
  (`src/lib/pricing-constants.ts:16`), que es lo que se debita cuando el precio del agente
  es `0`/`null`/`NaN` (`src/services/compose.ts:499-531`, `src/routes/compose.ts:780`);
- gas overhead por step = **0** en testnet y sin env (`src/services/compose.ts:427-433`), y
  hoy **no hay ninguna red mainnet inicializada** (`.nexus/project-context.md:154`);
- techo de exposición por pipeline: **se entrega sin configurar** ⇒ `+Infinity`
  (`src/lib/stranded-payment.ts:325-337`, `:342-348`);
- `maxBudget: 0` o ausente sigue significando "sin límite" (`:346`,
  `src/services/compose.ts:450`).

Con un techo `D`, los débitos que un solo request de entrada puede provocar en el árbol
son `Σ_{k=1..D} 5^k = (5^(D+1) − 5) / 4`:

| `D` | peticiones que llegan a la app | débitos | peor caso en USD | ¿cubre el caso del deck? |
|---|---|---|---|---|
| 1 | 1 + 5 = 6 | 5 | **$5** | ❌ prohíbe que nos contrate un coordinador que a su vez contrate a otro |
| **2** | 1 + 5 + 25 = **31** | **30** | **$30** | ✅ plataforma → nosotros → otro coordinador → agentes |
| 3 | 156 | 155 | $155 | con un nivel de más sin caso de uso |
| 4 | 781 | 780 | $780 | idem |
| hoy (sin techo) | **sin cota** | sin cota | sólo lo frena el saldo de la key | — |

**Default = 2.** Es el número más chico que cubre la tesis que el deck ya publicó (*"el
coordinador es, a su vez, un agente A2A: cualquier plataforma puede contratar el pipeline
completo como un solo agente"*) y deja el peor caso en **$30 + el 1%** en vez de sin cota.
Subirlo es una env y multiplica por 5 por nivel; el `.env.example` va a llevar esta tabla.

**Y el techo NO detecta ciclos: acota costo.** Los ciclos los detecta la traza (paso 5).
El techo existe para el ciclo que la traza **no puede ver** — el que pasa por un
intermediario que no reenvía los headers. Confundir las dos cosas es el over-claim que
CD-6 prohíbe.

**Interacción con los otros techos, medida:**

- **El timeout NO es un freno.** `createTimeoutHandler` (`src/middleware/timeout.ts:8-25`)
  hace un `setTimeout` que **manda un 504 y nada más**: no aborta el pipeline. El propio
  route lo asume (`src/routes/compose.ts:1001-1004` maneja `reply.sent` **después** de que
  compose terminó). Es la clase *"un techo hecho con `Promise.race` no frena el trabajo"*,
  acá sin ni siquiera el `race`. Un bucle sigue gastando después del 504.
- **El rate-limit acota el bucle y, con la config default, se lo cobra a los demás.**
  `/compose` y `/orchestrate` van a `orchestrateRateLimit()` (`src/routes/compose.ts:844`,
  `src/routes/orchestrate.ts:471`), default **10 / 60 s**
  (`src/middleware/rate-limit.ts:52-58`, `.env.example:570-573`), store **en proceso**
  (`:36-45`, no hay Redis en este servicio). La key es la default de
  `@fastify/rate-limit`, `request.ip`; y `TRUST_PROXY` es **opt-in con default `false`**
  (`src/lib/env.ts:53`), así que detrás del borde de Railway **todos los callers externos
  comparten un bucket** — el problema que `src/lib/env.ts:28-37` ya documenta. Con `D=2`,
  las 31 peticiones consumen ~3 minutos del bucket compartido: el segundo efecto del techo
  no es sólo plata, es acotar un DoS auto-inflingido. **El valor de `TRUST_PROXY` en el
  Railway de prod no lo pude verificar** (§9, NC-2), así que esto se escribe con las dos
  lecturas y no como garantía.
- **`PIPELINE_EXPOSURE_CEILING_USD` y el `maxBudget` del caller no frenan nada hoy**: el
  primero se entrega apagado y el segundo tiene `0`/ausente = sin límite (citas arriba).

### 4.6 DT-E — AC-7: la emisión, y qué NO se toca

En `invokeAgent`, al construir `headers` (`src/services/compose.ts:1424-1431`), se agregan
las dos claves nuevas **después** de `Content-Type` y **antes** del spread de las
credenciales, para no poder pisar una credencial por accidente:

```
'x-a2a-contracting-chain': serialize([...cadenaEntrante, miId])
'x-a2a-contracting-depth': String(profundidadEntrante + 1)
```

- La cadena entrante y la profundidad entrante llegan **por parámetro** desde el
  `ComposeRequest` (campos aditivos `contractingChain?: string[]`,
  `contractingDepth?: number`), poblados por el preHandler de la Capa 2. **No se lee
  `process.env` ni un singleton mutable en el hot-path para esto**: el estado de la
  petición viaja en la petición (DT-7 del work-item: sin tabla, sin migración).
- **Sin `miId` no se emite ninguno de los dos.** Emitir una cadena sin nuestro eslabón
  sería peor que no emitir nada: el siguiente gateway leería una traza que **afirma** no
  contenernos. Ese caso se loguea una vez por invocación a `warn`.
- **CD-4 intacto**: no se toca `validateRegistryUrl` (`:1490`), ni el `ssrfFetch`
  (`:1516`), ni `isBlockedAddress`. El guard nuevo mira **identidad**; el viejo mira
  **rangos de IP**. Son ortogonales y se quedan separados.
- **`src/lib/ssrf-dispatcher.ts` NO entra al Scope IN** (M-4): la traza sobrevive el
  redirect porque `CREDENTIAL_HEADERS` son 4 nombres explícitos que no la incluyen
  (`:286-291`, `:298-317`), así que el vector de redirect lo cierra la Capa 2 del otro
  lado sin tocar ese archivo. Tocarlo cambiaría además el comportamiento de discovery y
  de los dos tools MCP que comparten `ssrfFetch` (Anexo A-2), o sea blast radius fuera del
  Scope IN por cero ganancia.

### 4.7 DT-F — La carta completa (AC-1/AC-2/AC-3), con una sola fuente por dato

`buildSelfAgentCard` sigue siendo **la única** función que la construye
(`src/services/agent-card.ts:197-245`) y `/capabilities` sigue derivando de ella
(`src/routes/capabilities.ts:33`, `:64-89`). AC-2 se cumple porque los datos nuevos se
**pasan resueltos**, siguiendo el patrón que ese archivo ya usa para `identity` y
`computedReputation` (`:113-114`: *"resuelto por el route ANTES de llamar"*).

#### 4.7.1 Los tres datos y su fuente única

| Dato de AC-1 | Fuente ÚNICA | Cita |
|---|---|---|
| **(b) esquemas de auth/pago** | `bearer` siempre (el carril de agent key prepaga no está gateado); `x402` **sólo si** `getInboundPaymentChainKeys().length > 0` | `src/adapters/registry.ts:532`, que a su vez usa `acceptsInboundPayment` (`:522`), *"Esta es la ÚNICA definición de la asimetría"* (`:518`) |
| **(a) precio** | No hay un precio fijo: el gateway cobra una **tasa** sobre el costo ejecutado. `feeRatePercent = getProtocolFeeRate() * 100`, **la misma expresión** que ya usa `/orchestrate/plan` | `src/services/fee-charge.ts:133`; `src/routes/orchestrate.ts:350-353` |
| **(c) endpoint por skill** | El prefijo con el que se registra cada ruta | `src/index.ts:271` (`/discover`), `:273` (`/compose`), `:274` (`/orchestrate`) |

Sobre **(a)**: declarar un `priceUsdc` por skill sería **fabricar una oferta**, que es
justo lo que AC-3 prohíbe. Lo honesto y lo que un integrador necesita es: (i) los precios
de los agentes son **pass-through**, (ii) el gateway cobra `feeRatePercent` sobre el costo
realmente ejecutado, (iii) el precio exacto de un pipeline se **cotiza** en
`POST /orchestrate/plan`, que ya devuelve `costPerStep`, `totalCostUsdc`,
`protocolFeeUsdc` y `maxQuotedCostUsdc` (`src/routes/orchestrate.ts:433-447`) y **no
cobra** (`:431`: *"Sin débito"*). O sea: la carta declara el **modelo** y apunta al
**cotizador**, que es lo que AC-1 admite con su *"o la forma de obtenerlo"*.

Sobre **(c)**: escribir los tres paths a mano en `agent-card.ts` es una segunda expresión
del registro de rutas de `src/index.ts:270-310`, y `tsc` no las ata. **El control es
mecánico, no una promesa**: un test que arranca la app con `fastify.inject()` y verifica
que cada `endpoint` declarado por la carta responda **distinto de 404**. Si alguien
renombra un prefijo, ese test se pone rojo.

Sobre **(b)** — **el riesgo real de esta wave**: `agent-card.ts` hoy sólo importa
`../adapters/app-intent-mapper.js` (`:3-5`). Importar `../adapters/registry.js` mete el
grafo de los bundles de cadena en un módulo que consumen 4 rutas, y **media docena de
suites mockean los módulos gordos completos** — el hazard que
`src/lib/discovery-fetch-limit.ts:1-11` documenta y que ya rompió 12 y 84 tests en otra
HU. Por eso: `buildSelfAgentCard(baseUrl, ctx?)`, con `ctx` resuelto por **una** función
exportada (`resolveSelfCardContext()`) y llamada desde `buildSelfAgentCard` mismo (un
call-site ⇒ AC-2 estricto). **Medición obligatoria de W3, antes de escribir el campo**:
`command grep -rn "vi.mock(.*adapters/registry" src/ test/ | wc -l` y correr las suites de
`agent-card` / `well-known` / `capabilities`. Si alguna queda `undefined`, el `ctx` pasa a
resolverse en los dos routes y `resolveSelfCardContext` se muda al leaf con la lista
inyectada. Los dos caminos están decididos; cuál se toma lo dice el número.

#### 4.7.2 Shape aditivo de la carta

`AgentCard` (`src/types/index.ts:1679-1733`) y `AgentSkill` (`:1673-1677`) crecen sólo con
campos opcionales:

```ts
// AgentSkill (aditivo)
endpoint?: { method: 'POST'; path: string };   // p.ej. { method:'POST', path:'/compose' }
pricing?:
  | { model: 'free' }
  | { model: 'protocol-fee-on-executed-cost'; feeRatePercent: number; quoteEndpoint: string };

// AgentCard (aditivo)
contracting?: {
  depthMax: number;                 // el techo efectivo, publicado
  chainHeader: string;              // 'x-a2a-contracting-chain'
  depthHeader: string;              // 'x-a2a-contracting-depth'
  bestEffortNote: string;           // CD-6, la misma constante del leaf
};
```

`authentication.schemes` deja de ser `[]`. `model: 'free'` para `discover` **no es una
afirmación de fe**: `src/routes/discover.ts` no tiene `requirePaymentOrA2AKey` ni
`preHandler` (medido, Anexo A-2), y el test lo fija con un `inject` sin credencial que
espera distinto de 402.

#### 4.7.3 AC-3, y cuál es su caso REAL

El patrón es el que el archivo ya aplica (`src/services/agent-card.ts:169-190`):
`...(x !== undefined && { x })`, nunca `0` ni `null` (CD-5, CD-10 por
`exactOptionalPropertyTypes`, `tsconfig.json`).

Y hay que decir cuál es el único disparador real, porque afirmar que "cualquier campo
puede omitirse" sin poder producir la omisión es prosa: `getProtocolFeeRate()` **nunca
falla** (clamp a `[0, 0.10]` con default `0.01`, `src/services/fee-charge.ts:106-108`,
`:133`), y los endpoints son estáticos. **El caso que sí ocurre es el esquema de pago**:
si ninguna chain inicializada acepta cobro de entrada, `x402` **no se lista** — y eso es
alcanzable hoy, porque `solana-devnet` ya sale con `acceptsInboundPayment: false` en prod
(`.nexus/project-context.md:152`, `src/routes/capabilities.ts:44-59`). El test de AC-3 monta
exactamente ese registry.

### 4.8 DT-G — El fee en cascada, visible y con tercer valor

#### 4.8.1 El fee propio en `/compose` (AC-10)

En el 200 de `src/routes/compose.ts:1127`, aditivo, con los **mismos nombres** que
`/orchestrate` para no estrenar un segundo vocabulario:

```ts
protocolFeeUsdc?: number;                                  // sólo charged | already-charged
feeRatePercent: number;                                    // getProtocolFeeRate() * 100, 6dp
protocolFeeStatus: 'charged' | 'not_charged' | 'unknown';  // el tercer valor
```

El mapeo desde `FeeChargeResult` (`src/services/fee-charge.ts:75-90`), que ya es una unión
de 4 estados:

| `feeResult.status` | `protocolFeeStatus` | `protocolFeeUsdc` |
|---|---|---|
| `charged` | `'charged'` | `feeResult.feeUsdc` (`routes/compose.ts:1095` ya lo lee) |
| `already-charged` | `'charged'` | `feeResult.feeUsdc` |
| `skipped` (`WALLET_UNSET`) | `'not_charged'` | **OMITIDO** |
| `failed`, o el `catch` de `:1110-1116` | `'unknown'` | **OMITIDO** |

Los dos OMITIDOS son CD-5 y no cosmética:

- en `skipped` el `feeUsdc` que trae el resultado es el monto **calculado y no cobrado**;
  reportarlo como "el fee cobrado" sería una afirmación falsa con formato de dato;
- en `failed` la disposición es **desconocida**, no cero: este mismo repo importa
  `hasBroadcastEvidence` en ese archivo (`src/services/fee-charge.ts:22`) justamente porque
  un HTTP que falla no prueba que no se transmitió. Es *"no pude preguntar" ≠ "no pasó"*.

**Dos efectos colaterales obligatorios**, los dos citas que esta HU invalida:

1. El comentario de `src/routes/compose.ts:1050-1053` afirma *"en compose (a diferencia de
   orchestrate) ningún campo de fee se serializa en el response"* y **deja de ser cierto**.
   Se reescribe en el mismo commit.
2. Ese comentario explica por qué `feeChargeTxHash` no se declara (biome
   `noUnusedVariables`). Sigue sin declararse: **el `txHash` del fee NO se serializa**.
   Publicar el hash de la transferencia del fee es exponer el movimiento de la wallet de
   plataforma; el caller necesita el **monto**, no el hash. Queda escrito.

#### 4.8.2 El fee ajeno (AC-11): se LEE, y el sobre tiene una sola definición

DT-8 del work-item: el monto ajeno **se lee, no se estima**. La señal de que el ejecutor de
un step es un coordinador es que su respuesta trae **el mismo sobre que nosotros
emitimos** — que es lo que hace que el contrato sea uno y no dos.

En `invokeAgent`, sobre el `data` **crudo**, antes del colapso `data.result ?? data`
(`src/services/compose.ts:1538-1539`):

| Lo que trae la respuesta del agente | Qué se pone en el `StepResult` |
|---|---|
| **sin** `protocolFeeStatus` | **nada** (no es un coordinador) → campo ausente |
| `protocolFeeStatus === 'charged'` **y** `protocolFeeUsdc` finito `> 0` | `coordinatorFee: { declared: true, usdc }` |
| `protocolFeeStatus` presente, cualquier otro caso | `coordinatorFee: { declared: false }` |

La primera fila es la que preserva AC-8/CD-2 **para el 100% del tráfico de hoy**: los 25
agentes de prod (M-5) no emiten ese campo, así que sus `StepResult` salen byte-idénticos.
Nunca se escribe `usdc: 0`.

`StepResult` (`src/types/index.ts:1144-…`) crece con un solo campo opcional, threadeado por
el camino que `downstreamSkipCode` ya abrió: `invokeAgent` lo devuelve
(`compose.ts:1382-1396`, `:1565-1569`), los dos call-sites lo pasan (`:629`, `:980`) y
`finishSuccessfulStep` (`:1123-1155`) lo pone en el `StepResult`.

#### 4.8.3 El rollup, una expresión y tres call-sites

```ts
cascadedOrchestrationFeeUsdc?: number;                  // suma de los declarados; ausente si no hubo ninguno
cascadedOrchestrationFeeStatus?: 'complete' | 'partial'; // 'partial' ⟺ ≥1 coordinador sin declarar
```

Una función pura sobre `StepResult[]`, llamada desde `/compose` (`routes/compose.ts:1127`),
`/orchestrate` atómico y `/orchestrate/execute` (los dos ya devuelven `protocolFeeUsdc`,
`src/services/orchestrate.ts:1246-1248`). **Ningún step coordinador ⇒ los dos campos
ausentes** ⇒ respuesta byte-idéntica.

`/orchestrate/plan` **no se toca**: es una cotización, no hubo ejecución, y el fee ajeno no
es conocible antes de invocar. Agregarle un campo de cascada sería inventar un dato.

#### 4.8.4 AC-12, y el gotcha de `fee_usdc`

Todo lo anterior son **claves nuevas**. Ninguna clave existente cambia de nombre ni de
valor: el patrón que este repo ya aplicó dos veces sobre respuestas públicas
(`src/routes/capabilities.ts:41-43` y `:77-86`). El control es un test que compara
`Object.keys` del 200 contra la línea base y exige que el conjunto viejo sea **subconjunto**
del nuevo, con los mismos valores.

**GOTCHA que no se debe pisar, y su cita exacta**: en la tabla `a2a_protocol_fees`,
`fee_usdc` es **la pata de PLATAFORMA post-split, no el total**; el total vive en la
columna aditiva `fee_total_usdc`. Lo dice el código que hace el INSERT:
`src/services/fee-charge.ts:428` escribe `fee_usdc: platformAmount` y el comentario de
`:429-431` aclara *"`fee_usdc` sigue siendo SOLO la pata de plataforma post-split
(WKH-136) — money-path invariante, sin tocar"*, con `fee_total_usdc: feeUsdc` en `:432`.
(Modelo completo: `doc/architecture/FEE-MODEL.md`; ⚠️ ese documento **no** usa el nombre
`fee_usdc` en ninguna línea — verificado con `grep`—, así que la única fuente de la
semántica de la columna es el código.)

Consecuencias normativas: los campos nuevos se llaman `protocolFeeUsdc` y
`cascadedOrchestrationFeeUsdc`, **nunca** `feeUsdc` ni `fee_usdc`; y **no se leen de la
tabla**: salen de `FeeChargeResult` (`src/services/fee-charge.ts:75-90`) y de la respuesta
del agente. Un campo público llamado `feeUsdc` alimentado con el total, al lado de una
columna `fee_usdc` que es la pata, es la confusión garantizada.

### 4.9 DT-H — Los códigos de error, y los DOS shapes de error que este repo tiene

`ComposeResult.errorCode` pasa de 3 a 5 valores (`src/types/index.ts:1091`):

```ts
errorCode?: 'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED' | 'INPUT_MAPPING_FAILED'
          | 'CONTRACTING_LOOP_DETECTED' | 'CONTRACTING_DEPTH_EXCEEDED';
```

**Los cinco mapean a un status que ya existe.** Los dos nuevos caen en el `default` de
`let status = 400` (`src/routes/compose.ts:1026-1031`): **cero ramas de status nuevas**,
exactamente el precedente de `INPUT_MAPPING_FAILED` (`src/types/index.ts:1086-1090`).
Se evaluó `508 Loop Detected` (RFC 5842) y se descarta: agrega una rama de status y un
código que ningún cliente de este ecosistema maneja, por cero información que el
`errorCode` no dé ya.

⚠️ **La trampa de shape, y hay que decirla porque el Dev la va a pisar.** Este repo usa
**TRES** nombres de clave para el código de error, según la capa. Medido con
`command grep -n "error_code:\|code: '" src/routes/compose.ts src/routes/orchestrate.ts`:

| Capa | Clave | Cita medida | Cuándo se usa |
|---|---|---|---|
| **preHandler, rechazo de dominio** | `error_code` | `src/routes/compose.ts:721` y `:758` (`AGENT_NOT_FOUND`), `:835` (`REGISTRY_UNAVAILABLE`), `:259` (`COMPOSE_PRICE_DRIFT`); `src/routes/orchestrate.ts:564`, `:806` (`QUOTE_STALE`) | el pedido es válido en forma y el gateway lo rechaza |
| **preHandler, validación de forma** | `code` | `src/routes/compose.ts:144`, `:154`, `:925` (`VALIDATION_ERROR`), `:352` (`no_agent_match`); `src/routes/orchestrate.ts:108` | el body está mal armado |
| **resultado del pipeline** | `errorCode` (**camel**) | `src/types/index.ts:1091`; serializado por el `...result` de `src/routes/compose.ts:1041-1044` y `:1127` | el pipeline arrancó y falló |

**Los guards nuevos usan `error_code`** (familia 1): un bucle de contratación es un rechazo
de dominio sobre un body bien formado, igual que `AGENT_NOT_FOUND`. **No** `code`, que en
este repo señala forma.

Consecuencia inevitable: **el mismo bucle sale como `error_code` si lo caza un preHandler y
como `errorCode` si lo caza el loop del pipeline.** No se unifica acá (sería rediseñar el
shape de error global, Scope OUT explícito del work-item), pero **el string es UNA constante
del módulo leaf** (CD-19) y T-CODE-1 lo fija en las dos superficies, así que un cliente
matchea un solo valor aunque tenga que mirar dos claves.

### 4.10 DT-I — El módulo leaf, y qué NO va adentro

`src/lib/contracting-chain.ts`, **cero imports** (ni `fastify`, ni `types`, ni nada de
`services/`), por el motivo que este repo documentó tres veces
(`src/lib/compose-limits.ts:1-9`, `src/lib/discovery-fetch-limit.ts:1-11`,
`src/lib/downstream-skip-code.ts`): lo van a consumir un route, dos services y un
middleware, y media docena de suites mockean los módulos gordos del money-path completos
con factories sin `importOriginal`.

Superficie exportada:

```ts
export const CONTRACTING_CHAIN_HEADER: 'x-a2a-contracting-chain';
export const CONTRACTING_DEPTH_HEADER: 'x-a2a-contracting-depth';
export const CONTRACTING_LAYER2_BEST_EFFORT_NOTE: string;      // CD-6, un solo texto
export const SELF_HOSTS_ENV: 'A2A_SELF_HOSTS';
export const DEPTH_MAX_ENV: 'A2A_CONTRACTING_DEPTH_MAX';

export function canonicalizeHost(raw: string): string | null;   // + strip del punto final (M-2)
export function resolveSelfHosts(hint?: string): { hosts: string[]; canonicalId: string | null };
export function classifySelfHostsEnv(): { state: 'absent' } | { state: 'configured'; hosts: string[] } | { state: 'invalid'; reason: string };
export function assertSelfHostsEnv(): string | null;            // throw si inválida; string de warn si ausente
export function resolveContractingDepthMax(): number;           // fail-closed al default del código
export function isContractingDepthMaxMisconfigured(): boolean;  // para el log de arranque

export type ContractingHeaderVerdict =
  | { ok: true; chain: string[]; depth: number }
  | { ok: false; code: 'CONTRACTING_LOOP_DETECTED'; layer: 'chain' }
  | { ok: false; code: 'CONTRACTING_DEPTH_EXCEEDED'; depth: number; depthMax: number }
  | { ok: false; code: 'CONTRACTING_DEPTH_MALFORMED' }
  | { ok: false; code: 'CONTRACTING_CHAIN_MALFORMED'; reason: string };

export function readInboundContracting(h: {                     // pasos 1..6 de §4.5
  chain: string | string[] | undefined;
  depth: string | string[] | undefined;
}, selfHosts: string[], depthMax: number): ContractingHeaderVerdict;

export function isSelfDestination(url: string, selfHosts: string[]): boolean;  // Capa 1
export function buildOutboundContractingHeaders(                // AC-7
  chain: string[], depth: number, canonicalId: string | null,
): Record<string, string>;                                      // {} si canonicalId es null
```

**Lo que NO va adentro** (y por eso es leaf): la resolución del `Agent`, el acceso a
`process.env.BASE_URL`… no — `BASE_URL` **sí** se lee acá (es `process.env`, no un import),
igual que `src/lib/self-published-auth.ts:115` y `src/lib/discovery-fetch-limit.ts:75`. Lo
que no va es cualquier `import` de otro módulo del repo, cualquier logging (los call-sites
loguean) y cualquier decisión de dinero.

### 4.11 DT-J — DT-7 confirmado: sin tabla, sin migración, sin ownership guard

Todo el estado viaja en la petición (headers entrantes + campos aditivos del
`ComposeRequest`). **Ninguna query nueva sobre ninguna tabla**, y en particular ninguna
sobre una tabla con `owner_ref`. CD-8 queda satisfecho por ausencia, y el control no es
esa frase: es que `test/ownership-filter-guard.test.ts` corre en cada `npm test`
(`CLAUDE.md` → Ownership Guard; el criterio lo deriva `deriveTables()` en
`test/ownership-filter-guard.scanner.ts`) y en `3823580` da **`Tests 13 passed (13)`**,
medido solo (Anexo A-5). Si alguna wave termina tocando una query, la regla aplica sin
excepción y hay que declararlo en el reporte.

⚠️ Y hay que leer lo que ese guardián **no** hace, porque su verde es fácil de sobre-leer:
verifica **PRESENCIA** del filtro, no su **VALOR**, y no mira los `supabase.rpc(...)`
(`CLAUDE.md` → Ownership Guard). Que dé 13 verde no prueba nada sobre esta HU más allá de
"no introdujo un sitio sin filtro".

---

## 5. Constraint Directives

### 5.1 Heredadas del work-item (íntegras, siguen aplicando)

CD-1 … CD-10 de `work-item.md:245-282` se heredan **sin cambios**. Dos notas de
implementación:

- **CD-1** se cumple por §4.4: no hay bandera, y por lo tanto no hay bandera con default
  OFF. La allow-list queda como TD-360-1, con la forma prescrita.
- **CD-3** se cumple en **tres** sitios, no uno (M-1 / §4.3). Un AR que encuentre el guard
  del step 0 **después** de `requirePaymentOrA2AKey` (compose) o después de
  `budgetService.debit` (orchestrate) marca **BLOQUEANTE**, aunque el guard del loop esté
  bien puesto.

### 5.2 Nuevas de este SDD, cada una con su medición y su control

- **CD-11 — PROHIBIDO cerrar una wave sin re-medir las citas que la propia wave
  desplazó.** Patrón A de §3.6, presente en las 3 HUs DONE. Control, **después** de la
  última edición: para cada archivo tocado, `git diff -U0 <base> -- <archivo> | grep '^@@'`
  da el punto de inserción y el delta; **toda** cita al propio archivo con número mayor a
  ese punto se re-mide comparando **contenido** (`HOY[n]` vs `BASE[n − delta]`), no número.
  `delta neto == tamaño` ⇒ archivo 100% nuevo ⇒ no puede tener nada desplazado (esa mitad
  es gratis). Edición **línea-neutra obligatoria** en bloques con auto-citas.
- **CD-12 — PROHIBIDA toda cifra, hash o consecuencia sin el comando que la produjo y el
  commit del árbol.** Patrón B de §3.6, presente en las 3. Prueba de bolsillo antes de
  escribir una frase: *¿qué corrida la pone en rojo si deja de ser cierta?* Si la respuesta
  es "ninguna, porque acá está mockeado", la frase no va, o va **declarada como no
  medible**. Ningún identificador se escribe antes de existir (`git rev-parse <hash>` sobre
  cada hash citado).
- **CD-13 — PROHIBIDO adjudicar un veredicto con el exit code de un pipe.** Nunca
  `cmd | tail; echo $?` (mide `tail`) y nunca redirección a través del wrapper de este
  shell (corrompe con exit 0). Las dos fallas empujan al **verde falso**
  (`221-…/auto-blindaje.md:164-181`). Se usa `cmd; rc=$?`, `PIPESTATUS[0]`, o
  `node ./node_modules/vitest/vitest.mjs run` y `./node_modules/.bin/tsc` a pelo.
  Para adjudicar un `archivo:línea`, la sonda tiene que imprimir el **número pegado al
  texto** (`grep -n`, `awk 'NR==n{print NR": "$0}'`); `sed -n 'Np;Mp'` imprime en orden de
  ARCHIVO y ya produjo un hallazgo falso (`221-…:228-250`).
- **CD-14 — PROHIBIDO leer la profundidad con `parseInt` o `Number`.** Medido: `'1e9'`→`1`,
  `' 2'`→`2`, `'2abc'`→`2`, `''`→`0` (§3.5). Sólo `^[0-9]{1,3}$`. Y **presente-pero-ilegible
  se RECHAZA**, nunca se degrada a 0: degradar es la primitiva de reseteo del contador.
- **CD-15 — OBLIGATORIO quitar el punto final del hostname en las DOS puntas de la
  comparación.** Medido: `new URL('https://EXAMPLE.com./x').hostname === 'example.com.'`
  (M-2). Que hoy Railway conteste 404 a esa forma **no es un guard** y no cuenta como
  mitigación (§3.4).
- **CD-16 — PROHIBIDO validar la semántica del header antes de su forma y su largo.** El
  orden de §4.5 (1 largo → 2 conteo → 3 forma → 4 profundidad → 5 membresía → 6 techo) es
  normativo: el `split` va **después** del chequeo de largo, para no materializar un
  arreglo grande a pedido de un tercero.
- **CD-17 — PROHIBIDO que el guard de `invokeAgent` (Sitio 4) se presente como el guard de
  CD-3.** Corre después del débito. Su comentario tiene que decirlo, su log tiene que ser
  `error`, y el test del ORDEN (cero llamadas a `budgetService.debit` y cero a `ssrfFetch`)
  es lo que prueba que el guard de dinero es otro.
- **CD-18 — PROHIBIDO emitir la traza sin nuestro propio eslabón.** Sin `canonicalId`, los
  **dos** headers se omiten. Una cadena que no nos contiene es una afirmación falsa que el
  siguiente gateway va a creer.
- **CD-19 — OBLIGATORIO que el string de cada `errorCode`/`error_code` nuevo sea UNA
  constante del leaf**, consumida por las dos superficies (§4.9). Dos literales iguales
  escritos en dos capas divergen, y el cliente no tiene forma de saber cuál mirar.
- **CD-20 — PROHIBIDO cerrar W3 sin haber medido el hazard del mock de
  `adapters/registry`** (§4.7.1). Los dos caminos están decididos; el que se toma lo decide
  el número, no la comodidad.
- **CD-21 — OBLIGATORIO reescribir, en el mismo commit, las dos prosas que esta HU vuelve
  falsas**: `src/routes/compose.ts:1050-1053` (afirma que compose no serializa fee) y
  cualquier `.md` que copie esa frase. Control: `command grep -rn "ningún campo de fee"
  src/ doc/`.
- **CD-22 — PROHIBIDO que una wave de fixtures cambie un `url:` que otra usa como
  testigo sin re-contar los rojos del mutante correspondiente.** Dos instancias medidas en
  WKH-345 (`222-…/auto-blindaje.md:196-250`): un refixture **apaga un testigo sin poner
  nada en rojo**. Si el mutante da **un** rojo, ése es el único testigo y hay que
  escribirlo **en el testigo**, no sólo en el `.md`.
- **CD-23 — PROHIBIDO tocar `src/lib/ssrf-dispatcher.ts`, `src/lib/url-validator.ts` y
  `src/lib/downstream-payment.ts`.** Los tres quedan fuera del Scope IN por medición
  (M-4 para el primero; §9 NC-3 para el tercero). Tocarlos reabre CD-4 o amplía el blast
  radius a discovery / MCP por cero ganancia.

---

## 6. Waves

`W0` es serial. `W3` es paralelizable de verdad contra `W1`/`W2` en otro worktree (no
comparte ningún archivo). `W4` depende de `W2`.

### Wave 0 — serial · el módulo leaf, los tipos y la línea base (sin comportamiento)

| Archivo | Qué entra |
|---|---|
| `src/lib/contracting-chain.ts` | **NUEVO**. Toda la superficie de §4.10. Cero imports. Docblock con: por qué es leaf, la tabla de §3.5, la medición de M-2, y la derivación del techo de §4.5.1. |
| `src/lib/contracting-chain.test.ts` | **NUEVO**. Los 8 valores de profundidad, las 6 variantes de host, el largo/conteo/forma de la cadena, el fail-closed del techo. |
| `src/types/index.ts` | `ComposeResult.errorCode` +2 valores (`:1091`). `StepResult.coordinatorFee?` (aditivo). `AgentCard.contracting?`, `AgentSkill.endpoint?`/`pricing?`. `ComposeRequest.contractingChain?`/`contractingDepth?`. **Sólo tipos: cero comportamiento.** |
| `.env.example` | `A2A_SELF_HOSTS`, `A2A_CONTRACTING_DEPTH_MAX` con la tabla de §4.5.1 pegada. |

**Cierre de W0**: `./node_modules/.bin/tsc --noEmit` exit 0 y la suite completa en el
mismo `280 passed | 6 skipped` / `5441 passed | 19 skipped`. Un cambio de tipos que mueva
un test es una señal, no ruido.

### Wave 1 — el bucle DIRECTO (Capa 1). **Si la HU se cortara acá, ya cierra el caso peor.**

| Archivo | Qué entra |
|---|---|
| `src/services/agent-price.ts` | `resolveAgentDestination` devuelve además `invokeUrl` (aditivo, un call-site en prod). |
| `src/routes/compose.ts` | **Sitio 1** dentro de `resolveComposePriceHandler` (`:700-838`), junto a `resolveAgentDestination` (`:729-735`). Aborta con `return reply.status(400).send({error, error_code, requestId})`. |
| `src/services/orchestrate.ts` | **Sitio 2** tras el cap gate (`:1115`), antes del price-fallback (`:1117`). |
| `src/services/compose.ts` | **Sitio 3** tras el scoping (`:376`), antes de `resolveStepInput` (`:400`). **Sitio 4** junto al SSRF (`:1489-1503`), antes de `ssrfFetch` (`:1516`), con el comentario de CD-17. |
| `src/index.ts` | `assertSelfHostsEnv()` + log de arranque con `setting`/`hosts`/`count`, forma de `:173-182`. Y el `contractingGuard` aditivo de `/health`: ⚠️ **`/health` NO vive en `src/routes/`** — está registrado **inline** en `src/index.ts:237` (medido: `command grep -rn "'/health'" src/index.ts src/routes/*.ts` da un solo hit y es ése). El campo se agrega ahí, con la forma del campo aditivo de pagos varados de HU-306 (`.nexus/project-context.md:426`). |
| tests | T-L1-* y sus gemelos positivos (§7). |

### Wave 2 — el bucle TRANSITIVO y el techo (Capa 2 + AC-7)

| Archivo | Qué entra |
|---|---|
| `src/middleware/contracting-guard.ts` | **NUEVO**. El preHandler inbound. Llama `readInboundContracting` y, si `ok`, deja `request.contractingChain`/`contractingDepth`. Aborta con el shape `error_code`. |
| `src/routes/compose.ts` | El preHandler nuevo **al principio** del array (`:845-885`), antes de `validateComposeBodyHandler` (`:857`). Threading de `contractingChain`/`contractingDepth` al `composeService.compose`. |
| `src/routes/orchestrate.ts` | Idem en las **tres** cadenas (`:137-151`, `:281-293`, `:505-517`), antes de `markSkipMiddlewareDebitHandler`. |
| `src/services/orchestrate.ts` | Propagación al `composeService.compose` de `:1213-1240`. |
| `src/services/compose.ts` | **AC-7**: los dos headers en `headers` (`:1424-1431`), vía `buildOutboundContractingHeaders`. |
| tests | T-L2-*, T-DEPTH-*, T-PROP-* y gemelos (§7). |

### Wave 3 — la carta (paralelizable, otro worktree)

| Archivo | Qué entra |
|---|---|
| `src/services/agent-card.ts` | `resolveSelfCardContext()` + `buildSelfAgentCard` con `endpoint`/`pricing` por skill, `authentication.schemes` derivado y `contracting`. **Medición de CD-20 primero.** |
| `src/routes/well-known.ts`, `src/routes/capabilities.ts` | Sólo si CD-20 obliga a mover la resolución al route. Si no: **cero cambios** (`/capabilities` deriva de la carta y hereda todo). |
| `doc/` | La decisión DT-1 escrita y el procedimiento de registro externo (§9, NC-4). |
| tests | T-CARD-* (§7). |

### Wave 4 — el fee en cascada (depende de W2)

| Archivo | Qué entra |
|---|---|
| `src/services/compose.ts` | Lectura del sobre del coordinador sobre el `data` crudo (antes de `:1539`); `coordinatorFee` en el return de `invokeAgent` (`:1382-1396`, `:1565-1569`), en los dos call-sites (`:629`, `:980`) y en `finishSuccessfulStep` (`:1123-1155`). |
| `src/lib/contracting-chain.ts` | El lector/escritor del sobre (una definición, dos direcciones). |
| `src/routes/compose.ts` | `protocolFeeUsdc`/`feeRatePercent`/`protocolFeeStatus` + rollup en `:1127`. **CD-21: reescribir `:1050-1053`.** |
| `src/routes/orchestrate.ts`, `src/services/orchestrate.ts` | Rollup en el atómico y en `/execute`. `/plan` **no se toca**. |
| tests | T-FEE-* y el test de `Object.keys` de AC-12 (§7). |

---

## 7. Plan de tests

≥1 por AC, cada uno con su **mutante** y su **sitio de aplicación escrito**. Los `T-*+`
son los gemelos positivos de CD-7.

| Test | AC | Qué monta | Qué asserta | Mutante que lo mata (sitio exacto) |
|---|---|---|---|---|
| **T-L1-1** | AC-4 | `/compose` 1 step cuyo `invokeUrl` es `https://<self>/compose` | 400 + `error_code:'CONTRACTING_LOOP_DETECTED'` + **cero** llamadas a `budgetService.debit` | borrar el guard de `src/routes/compose.ts` (Sitio 1) |
| **T-L1-2** | AC-4, CD-3 | igual pero en `steps[2]` de un pipeline de 3 | rechazo con `errorCode` (camel) en el `...result`, `budgetService.debit` llamado **2** veces (steps 0,1) y **no** la 3.ª; `ssrfFetch` **no** llamado para ese step | mover el guard del Sitio 3 de `:376` a después de `:553` |
| **T-L1-3** | AC-4 | `/orchestrate` con un step propio | rechazo antes de `budgetService.debit` de `src/services/orchestrate.ts:1149` | mover el guard del Sitio 2 de después de `:1115` a después de `:1157` |
| **T-L1-4** | AC-4, CD-15 | destino `https://<self>./compose` (punto final) | **rechazo** | quitar el strip del punto final de `canonicalizeHost` |
| **T-L1-5** | AC-4 | destino `https://<SELF>:8443/compose` | **rechazo** | comparar `url.host` (con puerto) en vez de `url.hostname` |
| **T-L1-6** | AC-9 | destino propio, request **sin ningún header** de contratación | **rechazo** | condicionar la Capa 1 a la presencia de la traza |
| **T-L1-7** | AC-4, CD-17 | destino propio + guard del Sitio 3 stubeado a no-op | Sitio 4 corta, `ssrfFetch` **no** llamado, y se logueó a `error` | borrar el guard del Sitio 4 |
| **T-L1+1** | AC-8, CD-7 | pipeline de `MAX_COMPOSE_STEPS` (5) contra hosts ajenos | 200, mismo body, mismo `totalCostUsdc`, **5** débitos, **5** `ssrfFetch` | invertir el predicado (`!isSelfDestination`) |
| **T-L1+2** | AC-8 | los **dos** hosts reales de prod (`wasiai-v2.vercel.app`, `wasiai-remittance-agents.vercel.app`) como destinos | los dos pasan | agregar `.vercel.app` al conjunto de identidad |
| **T-L1+3** | AC-8 | `A2A_SELF_HOSTS` ausente **y** `BASE_URL` ausente **y** sin `hint` | pipeline normal 200 (el guard no puede inventar identidad) + warn de arranque emitido | hacer que el conjunto vacío rechace todo |
| **T-L2-1** | AC-5 | `x-a2a-contracting-chain: <self>` | 400 `CONTRACTING_LOOP_DETECTED` `layer:'chain'`, **cero** débitos | borrar el paso 5 de `readInboundContracting` |
| **T-L2-2** | AC-5, CD-6 | igual | el body del error contiene `CONTRACTING_LAYER2_BEST_EFFORT_NOTE` textual | borrar la nota del body |
| **T-L2-3** | AC-5 | cadena `otro-gw, <SELF>., tercero` (mayúsculas + punto final) | rechazo | no canonicalizar los elementos de la cadena |
| **T-DEPTH-1** | AC-6 | `x-a2a-contracting-depth: 2`, techo default | 400 `CONTRACTING_DEPTH_EXCEEDED`, cero débitos | cambiar `>=` por `>` |
| **T-DEPTH-2** | AC-6, CD-14 | `depth: '1e9'` | 400 `CONTRACTING_DEPTH_MALFORMED` (**no** pasa como 1) | usar `Number.parseInt(v,10)` |
| **T-DEPTH-3** | AC-6, CD-14 | `depth: ''` | 400 `CONTRACTING_DEPTH_MALFORMED` (**no** pasa como 0) | usar `Number(v)` |
| **T-DEPTH-4** | AC-6, CD-14 | `depth: ' 2'`, `'2abc'`, `'0x10'`, `'1000'` (4 sub-casos) | los 4 rechazados | relajar el regex a `^\d+$` (mata el 4.º) o a `/\d+/` (mata los 3 primeros) |
| **T-DEPTH-5** | AC-6 | `A2A_CONTRACTING_DEPTH_MAX='abc'` + `depth: 2` | rechazo (cayó al default del código, **no** a sin techo) | `?? Infinity` en `resolveContractingDepthMax` |
| **T-DEPTH-6** | AC-6 | env ausente + `depth: 2` | rechazo | idem |
| **T-CHAIN-1** | AC-5, CD-16 | header de cadena de 8192 caracteres | 400 `CONTRACTING_CHAIN_MALFORMED`, y `split` **no** ejecutado (espía) | mover el chequeo de largo después del `split` |
| **T-CHAIN-2** | AC-5 | 400 elementos válidos | rechazo por conteo | borrar el paso 2 |
| **T-L2+1** | AC-8, CD-7 | `chain: 'otro-gw.example'`, `depth: '1'`, techo 2 | **200**, mismo body/costo/settles que sin headers | rechazar toda cadena no vacía |
| **T-L2+2** | AC-8 | **sin** ninguno de los dos headers (el 100% del tráfico de hoy) | 200 byte-idéntico a la línea base | tratar la ausencia de `depth` como malformado |
| **T-PROP-1** | AC-7 | pipeline de 2 steps, entrada `chain:'a.example'`, `depth:'0'` | los `ssrfFetch` salen con `chain:'a.example,<self>'` y `depth:'1'` | no incrementar la profundidad |
| **T-PROP-2** | AC-7, CD-18 | `canonicalId` = null (sin env, sin hint) | **ninguno** de los dos headers se emite + warn | emitir la cadena sin nuestro eslabón |
| **T-PROP-3** | AC-7, CD-4 | pipeline normal | `Content-Type`, `x-a2a-key` y las credenciales del registry salen **iguales** que en la línea base | poner los headers nuevos después del spread de credenciales |
| **T-CARD-1** | AC-1 | `GET /.well-known/agent.json` | cada skill trae `endpoint` y `pricing`; `authentication.schemes` no está vacío; `contracting.depthMax` presente | borrar el bloque nuevo |
| **T-CARD-2** | AC-1 | idem | la ruta sigue siendo gratis y sin rate-limit (`config.rateLimit === false`, `src/routes/well-known.ts:11`) | quitar `rateLimit: false` |
| **T-CARD-3** | AC-1, AC-2 | `fastify.inject()` a cada `endpoint` declarado por la carta | ninguno da 404 | renombrar el prefijo `/compose` en `src/index.ts:273` |
| **T-CARD-4** | AC-2 | `GET /capabilities` | `methods`/`name`/`url` siguen derivando de la carta y el conjunto de claves crece sin perder ninguna | duplicar los skills a mano en `capabilities.ts` |
| **T-CARD-5** | AC-3 | registry donde ninguna chain acepta inbound (`getInboundPaymentChainKeys()` vacío) | `x402` **no** aparece en `schemes`, y no aparece `x402: false` ni `null` | listar `x402` incondicionalmente |
| **T-CARD-6** | AC-3, CD-5 | idem | ningún campo nuevo de la carta vale `0` ni `null` (barrido recursivo del JSON) | poner `feeRatePercent: 0` como placeholder |
| **T-FEE-1** | AC-10 | `/compose` 200 con `chargeProtocolFee` → `charged` | `protocolFeeUsdc === feeResult.feeUsdc`, `protocolFeeStatus === 'charged'`, `feeRatePercent === getProtocolFeeRate()*100` | recalcular el fee con un literal en vez de `getProtocolFeeRate()` |
| **T-FEE-2** | AC-10, CD-5 | `chargeProtocolFee` → `skipped(WALLET_UNSET)` | `protocolFeeStatus === 'not_charged'` y `protocolFeeUsdc` **ausente** | reportar `feeResult.feeUsdc` en `skipped` |
| **T-FEE-3** | AC-10, CD-5 | `chargeProtocolFee` → `failed` | `protocolFeeStatus === 'unknown'` y `protocolFeeUsdc` **ausente** | mapear `failed` a `'not_charged'` |
| **T-FEE-4** | AC-11 | step cuyo agente responde `{protocolFeeStatus:'charged', protocolFeeUsdc:0.02, ...}` | `steps[i].coordinatorFee === {declared:true, usdc:0.02}` y `cascadedOrchestrationFeeUsdc === 0.02`, `...Status === 'complete'` | leer el sobre después del colapso `data.result ?? data` |
| **T-FEE-5** | AC-11, CD-5 | agente que responde `{protocolFeeStatus:'unknown'}` sin monto | `coordinatorFee === {declared:false}`, `...Status === 'partial'`, y **ningún** `0` en el body | poner `usdc: 0` cuando no declara |
| **T-FEE-6** | AC-11 | agente normal (sin `protocolFeeStatus`) | `coordinatorFee` **ausente** y los dos campos de rollup **ausentes** | marcar todo step como `{declared:false}` |
| **T-FEE-7** | AC-12 | 200 de `/compose` y de `/orchestrate` | el `Object.keys` de la línea base es **subconjunto** del nuevo, con los mismos valores | renombrar `totalCostUsdc` |
| **T-CODE-1** | AC-4/AC-5, CD-19 | el mismo bucle por preHandler y por loop | los dos strings salen de la misma constante del leaf | escribir el literal a mano en una de las dos capas |
| **T-ENV-1** | CD-1, §4.2 | `A2A_SELF_HOSTS='https://gw'` (con esquema) | `assertSelfHostsEnv()` **lanza** | degradar a `[]` en silencio |
| **T-ENV-2** | §4.2 | `A2A_SELF_HOSTS` ausente | devuelve el string de warn (no lanza) y `/health` publica `source:'request-only'` | lanzar en el caso ausente (voltearía prod, NC-1) |
| **T-OWN-1** | CD-8 | — | `test/ownership-filter-guard.test.ts` sigue en `13 passed` | agregar una query sin `.eq('owner_ref', …)` |

---

## 8. Protocolo de mutación

Reglas, y las tres son de CD-12/CD-13:

1. **Cada mutante se corre contra la suite COMPLETA**, nunca contra los archivos tocados.
   Precedente: WKH-345 cantó verde con 2 rojos en el árbol que su corrida dirigida no podía
   ver (`222-…/auto-blindaje.md:40-75`), y el radio de impacto no se deduce del directorio.
2. **Cada resultado se escribe como par (rojos, commit del árbol base)** y cada
   `sha256sum` de "original" con el commit donde vale. Antes de atribuirle un rojo a un
   mutante, correr la suite **sin** el mutante en ese mismo commit: la resta es lo único
   que separa la víctima del preexistente (`222-…:254-290`).
3. **Si un mutante da UN solo rojo**, ése es el único testigo: se escribe **en el testigo**
   (no sólo en el `.md`) que es el único, con el número medido y el aviso de que
   refixturear su input lo apaga igual que borrarlo (CD-22, `222-…:196-250`).

Mutantes obligatorios (los que aíslan una decisión de dinero o un parseo hostil):

| # | Mutación | Archivo:sitio | Debe morir |
|---|---|---|---|
| M-1 | mover el guard del Sitio 3 debajo del débito | `src/services/compose.ts`, entre `:376` y `:553` | T-L1-2 |
| M-2 | mover el guard del Sitio 1 después de `requirePaymentOrA2AKey` | `src/routes/compose.ts:845-885` | T-L1-1 |
| M-3 | mover el guard del Sitio 2 después de `budgetService.debit` | `src/services/orchestrate.ts:1115` → `:1157` | T-L1-3 |
| M-4 | `Number.parseInt(depth,10)` en lugar del regex | `src/lib/contracting-chain.ts` | T-DEPTH-2, T-DEPTH-4 |
| M-5 | `Number(depth)` en lugar del regex | idem | T-DEPTH-3 |
| M-6 | borrar el strip del punto final | idem | T-L1-4, T-L2-3 |
| M-7 | comparar `url.host` en vez de `url.hostname` | idem | T-L1-5 |
| M-8 | `?? Number.POSITIVE_INFINITY` en el techo | idem | T-DEPTH-5, T-DEPTH-6 |
| M-9 | chequeo de largo **después** del `split` | idem | T-CHAIN-1 |
| M-10 | `>` en lugar de `>=` en el techo | idem | T-DEPTH-1 |
| M-11 | invertir el predicado de identidad | idem | T-L1+1 (y ~toda la suite: el control negativo de que el instrumento puede dar rojo de comportamiento) |
| M-12 | leer el sobre después de `data.result ?? data` | `src/services/compose.ts:1538-1539` | T-FEE-4 |
| M-13 | `usdc: 0` cuando el coordinador no declara | `src/lib/contracting-chain.ts` | T-FEE-5 |
| M-14 | reportar `feeUsdc` en `skipped` | `src/routes/compose.ts` (mapeo de §4.8.1) | T-FEE-2 |
| M-15 | headers nuevos **después** del spread de credenciales | `src/services/compose.ts:1424-1431` | T-PROP-3 |
| M-16 | emitir la cadena sin `canonicalId` | `src/lib/contracting-chain.ts` | T-PROP-2 |

---

## 9. Missing Inputs y `[NEEDS CLARIFICATION]`

- **NC-1 — [no bloqueante · condiciona un log, no el diseño] ¿Está seteada `BASE_URL` en el
  Railway de prod?** **Medición inconclusa, con las dos lecturas.** Probé
  `GET /.well-known/agent.json` con `X-Forwarded-Proto: http`: el `url` sigue saliendo
  `https://wasiai-a2a-production.up.railway.app` (Anexo A-1). Eso es compatible con
  **(a)** `BASE_URL` seteada (la rama 1 de `resolveBaseUrl` gana e ignora el header) **y**
  con **(b)** Railway sobreescribiendo `X-Forwarded-Proto` antes de que llegue a la app.
  No puedo distinguirlas desde afuera y las envs de Railway no se leen desde el repo. **Por
  eso el diseño no depende de la respuesta**: el conjunto vacío da `warn`, no `throw`
  (§4.2), y `/health` publica `selfHostCount` para que el operador lo confirme **después
  del deploy** en vez de suponerlo. *Pregunta exacta al founder*: `BASE_URL` en el
  servicio `wasiai-a2a-production` de Railway, ¿tiene valor? Y si el gateway va a tener un
  dominio propio además del de Railway, ¿cuáles son los dos hosts para `A2A_SELF_HOSTS`?
- **NC-2 — [no bloqueante] ¿`TRUST_PROXY` está seteada en prod?** Cambia si el rate-limit
  buckeatea por IP real o si todos los callers comparten uno (`src/lib/env.ts:28-37`,
  `:50-70`). Afecta **la narrativa** del §4.5.1 (cuánto DoS colateral produce un bucle),
  no el diseño del guard. Escrito con las dos lecturas.
- **NC-3 — RESUELTO (era Missing Input #3 de la F1): `src/lib/downstream-payment.ts` NO
  entra al Scope IN.** Medido: `signAndSettleDownstream` se invoca en
  `src/services/compose.ts:1555`, o sea **después** de `ssrfFetch` (`:1516`), que a su vez
  está después del débito (`:545-553`) y del guard del Sitio 3. Un step cortado por el
  guard **nunca llega** a esa línea. Y `ssrfFetch` de `:1516` es el **único** de invocación
  de agentes en todo `src/` (Anexo A-2). El leg de salida no necesita un corte propio.
- **NC-4 — [no bloqueante · era Missing Input #1] ¿Qué catálogos A2A externos aceptan hoy
  una publicación abierta?** Sigue sin poderse verificar desde el repo, y esta sesión no
  amplía el dato. Lo medido: los registries vivos en prod son 2 y sus 25 agentes salen de
  `wasiai-v2.vercel.app` y `wasiai-remittance-agents.vercel.app` (A-4); Kite sigue
  `a2aSupport: none` y bloqueado por falta de API (`.nexus/project-context.md:474`, deuda
  #1); ERC-8004 sobre Base es un registro de **identidad**, no un catálogo de agentes
  (`src/adapters/erc8004-identity.ts`). **DT-2 se mantiene**: W3 entrega la carta completa
  y el procedimiento escrito, no un publicador. La tabla de candidatos que W3 tiene que
  escribir, con **qué verificar antes de publicar en cada uno**:

  | Candidato | Qué verificar ANTES de publicar | Estado hoy |
  |---|---|---|
  | Kite marketplace | que exista un endpoint de alta pública | bloqueado por falta de API (deuda #1) |
  | `wasiai-v2` (nuestro propio marketplace) | que listarnos ahí **no** nos meta en nuestro propio `/discover` (DT-1: el catálogo propio fabricaría el bucle) y que el `invokeUrl` publicado no sea el nuestro | es un registry activo; **decisión del founder** |
  | Directorios A2A de terceros (x402 Bazaar, Agentic.Market) | si aceptan alta abierta o son curados; qué campos exigen; si republican el `invokeUrl` | no verificado |
  | ERC-8004 (Base) | que se entienda que es identidad y no catálogo: no reemplaza el registro | adapter existe (`src/adapters/erc8004-identity.ts`) |

  *Pregunta exacta al founder*: ¿hay un catálogo A2A externo concreto donde quieras que el
  gateway aparezca? Si sí, entra como input de F2.5 sin cambiar nada de lo demás.
- **NC-5 — [reporte, fuera de scope] Drift documental detectado.** `.nexus/project-context.md`
  cita `acceptsInboundPayment` en `registry.ts:510-512` y `getInboundPaymentChainKeys` en
  `:520-525`; los reales son **`:522`** y **`:532`** (Anexo A-2). Y ese mismo archivo dice
  "23 agentes descubribles" (`:479`) cuando hoy son **25** (A-4). No lo arregla esta HU
  (está fuera del Scope IN); se reporta.
- **NC-6 — [reporte, fuera de scope] Over-claim en un docblock ajeno.** `src/lib/self-published-auth.ts:82`
  afirma que su canonicalización deja el host *"sin punto final"*. Medido: `new URL` **no**
  quita el punto final (M-2, A-3). No es un agujero de seguridad ahí (el peor caso es
  credencial que no sale), pero es una frase falsa en un módulo del camino de credenciales
  y **es exactamente la frase que haría que alguien reusara esa función para el guard de
  identidad creyendo que ya normaliza**. Candidato a MENOR.

---

## 10. Riesgos

| # | Riesgo | Probabilidad · Impacto | Mitigación en este SDD |
|---|---|---|---|
| **R-1** | **Falso positivo del guard**: rechazar un agente legítimo. Es el daño de signo opuesto y sería peor que el bug (mismo argumento que `stranded-payment.ts:333-337`). | baja · alto | M-5 mide **0 de 25** agentes afectados. T-L1+1/+2/+3 son el control. La comparación es por hostname exacto, sin sufijos ni wildcards. |
| **R-2** | **El guard queda inerte** en un deploy sin `BASE_URL` ni `A2A_SELF_HOSTS` (CD-1). | media (NC-1) · alto | El `hint` del request cubre el caso común sin configuración (§4.2); `warn` ruidoso al arrancar; `/health` lo publica; T-ENV-2 lo fija. |
| **R-3** | **Bypass por IP literal**: `https://69.46.46.64/compose` no matchea por nombre (§3.4). | baja · medio | **Residual declarado, no cerrado.** Cerrarlo pediría resolver DNS de nuestros propios hosts por step: caro, inestable (las IPs de Railway rotan) y solapado con el trabajo del módulo SSRF. Dos acotaciones medidas: el borde de Railway rutea **por Host** (evidencia: la variante con punto final da 404, §3.4), y un `https://` a la IP falla la validación de certificado. `A2A_SELF_HOSTS` acepta un literal si un operador lo necesita. **TD-360-2.** |
| **R-4** | **La Capa 2 no cierra el bucle transitivo contra un adversario** que borra headers. | alta · medio | Está en CD-6 y en el body del error, no sólo acá. Lo que queda en pie es la Capa 1 y el techo. **No se afirma lo contrario en ningún lado.** |
| **R-5** | **W3 rompe suites** por importar `adapters/registry` en `agent-card.ts` (12 y 84 tests roto ya pasó en otra HU). | media · medio | CD-20: se **mide** antes de escribir el campo; los dos caminos ya están decididos. |
| **R-6** | **Conflicto de merge** en los dos archivos más disputados del repo. | **nula, medida** · alto | Las 13 ramas con worktree vivo están **todas mergeadas** en `main` (A-6). Re-verificar al abrir la rama con el mismo comando. |
| **R-7** | **Citas rotas por la propia edición.** Este SDD cita ~90 `archivo:línea` de archivos que la HU **va a editar**. | **alta** (3 de 3 HUs previas) · medio | CD-11, con el control mecánico de `git diff -U0` + comparación de contenido. |
| **R-8** | El techo de profundidad **default 2** rechaza un caso legítimo futuro de 3 niveles. | baja · bajo | Es una env; la tabla de §4.5.1 está en `.env.example` para que subirlo sea una decisión con el número al lado (×5 por nivel). |

---

## 11. Dependencias

- **Ninguna HU bloquea a esta.** Todo lo que toca está en `main` y verde (§3.3).
- **Esta HU bloquea la promesa del deck**, no otra HU.
- **WKH-361** (bucle de discovery, Scope OUT del work-item) **comparte el módulo leaf de
  identidad**: conviene **después**, nunca en paralelo.
- **TD-360-1**: la allow-list de auto-contratación, con la forma de CD-1, si aparece un
  caso legítimo (§4.4).
- **TD-360-2**: el bypass por IP literal (R-3).
- Sin migración, sin tabla, sin cambio de env obligatoria para que el servicio arranque
  (DT-J).

---

## 12. Implementation Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todos los `archivo:línea` del SDD abiertos y re-derivados en esta sesión contra `3823580` | ✅ |
| 2 | Línea base medida (tsc, guardianes, suite completa) con el commit al lado | ✅ `5441 passed \| 19 skipped (5460)`, exit 0 |
| 3 | Los 12 ACs mapeados a §, wave y test | ✅ §2 |
| 4 | Punto de inserción **exacto** de cada guard, con la cita del código que ya está ahí | ✅ §4.3 (4 sitios) |
| 5 | El corte ocurre **antes** de todo movimiento de plata, en los **tres** caminos de débito | ✅ §4.3.1/.2/.3, mutantes M-1..M-3 |
| 6 | Identidad propia: fuente decidida, ataques de URL medidos, residual declarado | ✅ §4.2, §3.4, R-3 |
| 7 | Header: nombre, forma, orden de validación, techo con derivación numérica, input hostil medido | ✅ §4.5, §4.5.1, §3.5 |
| 8 | Carta: los 3 datos con **una** fuente cada uno y el caso real de AC-3 | ✅ §4.7 |
| 9 | Fee: shape aditivo, tri-estado, sobre con una sola definición, gotcha `fee_usdc` | ✅ §4.8 |
| 10 | Interacción con los techos existentes, derivada con números | ✅ §4.5.1 (timeout no frena; rate-limit con las dos lecturas) |
| 11 | Waves con archivos exactos y criterio de cierre | ✅ §6 |
| 12 | ≥1 test por AC, con gemelo positivo (CD-7) y mutante con sitio escrito | ✅ §7 (36 tests), §8 (16 mutantes) |
| 13 | CDs del work-item heredados íntegros + los nuevos con su medición | ✅ §5 |
| 14 | Auto-Blindaje de las 3 HUs DONE leído y bajado a CD ejecutable | ✅ §3.6 → CD-11..CD-13, CD-22 |
| 15 | Ownership guard: declarado que no se toca ninguna tabla, con el control | ✅ §4.11, T-OWN-1 |
| 16 | Riesgo de conflicto de ramas medido | ✅ R-6, A-6 |
| 17 | `[NEEDS CLARIFICATION]` con la pregunta exacta, y **ninguno bloqueante** | ✅ §9 (NC-1, NC-2, NC-4) |
| 18 | Sin TBDs. Sin frase de completitud sin control ejecutable | ✅ |

**Veredicto: LISTO PARA `SPEC_APPROVED`.** Los tres `[NEEDS CLARIFICATION]` son de
configuración de prod y de alcance de DT-2; ninguno cambia el diseño, y §4.2 está armado
justamente para no depender de la respuesta a NC-1.

---

## Anexo — comandos de reproducción

Todos contra `3823580`. **Sin pipes para adjudicar exit codes** (CD-13).

### A-1 · La carta viva de prod (gratis, read-only)

```bash
/usr/bin/curl -s --max-time 12 \
  https://wasiai-a2a-production.up.railway.app/.well-known/agent.json -o card.json
python3 -c "import json;d=json.load(open('card.json'));print(sorted(d.keys()));print(d['url'],d['authentication'],'paymentIntents' in d)"
#  ['authentication','capabilities','description','inputModes','invocationNote',
#   'name','outputModes','skills','url']            ← 9 claves
#  https://wasiai-a2a-production.up.railway.app {'schemes': []} False

# NC-1, medición inconclusa:
/usr/bin/curl -s --max-time 12 -H 'X-Forwarded-Proto: http' \
  https://wasiai-a2a-production.up.railway.app/.well-known/agent.json -o card2.json
#  url sigue https://  ⟹ (a) BASE_URL seteada  Ó  (b) Railway reescribe el header

# §3.4, la variante con punto final NO llega a la app:
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" "https://wasiai-a2a-production.up.railway.app/health"   # 200
/usr/bin/curl -s -o /dev/null -w "%{http_code}\n" "https://wasiai-a2a-production.up.railway.app./health"  # 404
```

### A-2 · Los barridos de `src/`

```bash
# No existe guard anti-bucle:
command grep -rn "self-loop\|selfLoop\|LOOP_DETECTED\|isSelf\|ownIdentity\|contracting" src/ --include=*.ts
#  único hit relevante: src/services/agent-split-context.ts:69  isSelfReferral  (fee split)

# "Quién soy" no se lee en el camino de compose:
command grep -rln "resolveBaseUrl" src/ --include=*.ts
#  agent-card.ts · agent-card.test.ts · routes/capabilities.ts · routes/agent-card.ts
#  · routes/well-known.ts · routes/capabilities.inbound-chains.test.ts · __tests__/e2e/setup.ts
#  ⟹ 4 archivos de producción, NINGUNO de compose/orchestrate

# El único ssrfFetch de invocación de agentes:
command grep -rn "ssrfFetch\|validateRegistryUrl" src/ --include=*.ts | command grep -v "\.test\.ts"
#  services/compose.ts:1516  ← el único de invocación
#  services/discovery.ts:1240,:1430 · mcp/tools/get-payment-quote.ts:38 · mcp/tools/pay-x402.ts:72

# /discover no tiene middleware de pago:
command grep -n "requirePaymentOrA2AKey\|preHandler" src/routes/discover.ts    # sin salida

# NC-5, el drift de project-context:
command grep -n "acceptsInboundPayment\|getInboundPaymentChainKeys" src/adapters/registry.ts
#  :522  export function acceptsInboundPayment
#  :532  export function getInboundPaymentChainKeys
#  (project-context dice :510-512 y :520-525)

# Familia de headers del repo (29 nombres x-*):
command grep -rhon "'x-[a-z0-9-]*'" src/ --include=*.ts | command sed 's/^[0-9]*://' | sort -u
```

### A-3 · Los parseos, medidos

```bash
node -e "
console.log(Number.parseInt('1e9',10));                              // 1        ⚠️
console.log(Number.parseInt(' 2',10), Number.parseInt('2abc',10));   // 2 2      ⚠️
console.log(Number.parseInt('0x10',10), Number(''));                 // 0 0      ⚠️
console.log(/^[0-9]{1,3}\$/.test('1e9'));                            // false
console.log(new URL('https://EXAMPLE.com./x').hostname);             // example.com.  ⚠️ M-2
console.log(new URL('https://EXAMPLE.COM/x').hostname);              // example.com
console.log(new URL('https://пример.рф/').hostname);                 // xn--e1afmkfd.xn--p1ai
console.log(new URL('https://gw.example.com:443/').port);            // ''  (elidido)
console.log(new URL('https://gw.example.com:8443/').port);           // '8443'
console.log(new URL('https://user:pw@gw.example.com/').hostname);    // gw.example.com
console.log(new URL('https://[::1]/').hostname);                     // [::1]
"
```

### A-4 · Los 25 agentes de prod y sus hosts (AC-8 / M-5)

```bash
/usr/bin/curl -s --max-time 20 -X POST \
  https://wasiai-a2a-production.up.railway.app/discover \
  -H 'Content-Type: application/json' -d '{}' -o disc.json
python3 -c "
import json,collections; from urllib.parse import urlparse
d=json.load(open('disc.json')); print('total', d['total'])
c=collections.Counter(urlparse(a['invokeUrl']).hostname for a in d['agents'])
[print(f'{n:3d}  {h}') for h,n in c.most_common()]"
#  total 25
#   22  wasiai-v2.vercel.app
#    3  wasiai-remittance-agents.vercel.app
#  ⟹ 0 apuntan al host del gateway
```

### A-5 · Línea base local

```bash
./node_modules/.bin/tsc --noEmit; echo "tsc_exit=$?"          # tsc_exit=0

node ./node_modules/vitest/vitest.mjs run \
  test/sdd-index-matches-folders.test.ts \
  test/docs-referenced-by-code-exist.test.ts \
  test/ownership-filter-guard.test.ts
#  Test Files  3 passed (3) · Tests  29 passed (29)

# El guardián de ownership, solo (la línea base de T-OWN-1 y de CD-8):
node ./node_modules/vitest/vitest.mjs run test/ownership-filter-guard.test.ts
#  Test Files  1 passed (1) · Tests  13 passed (13)

node ./node_modules/vitest/vitest.mjs run > baseline.txt 2>&1; echo "suite_exit=$?"
#  suite_exit=0
#  Test Files  280 passed | 6 skipped (286)
#       Tests  5441 passed | 19 skipped (5460)

command grep -n "^| *22[0-3]" doc/sdd/_INDEX.md    # filas 220, 221, 222 (:187), 223 (:215)
```

### A-6 · Conflicto de ramas (R-6)

```bash
git worktree list          # 14 entradas (main + 13 ramas)
for b in $(git worktree list --porcelain | command grep '^branch' | command sed 's|.*/heads/||'); do
  n=$(git rev-list --count main..$b); echo "$n  $b"
done
#  las 13 dan 0  ⟹ todas mergeadas en main ⟹ cero conflicto sobre el Scope IN
```

### A-7 · Control obligatorio de W3 (CD-20)

```bash
command grep -rn "vi.mock(.*adapters/registry" src/ test/
node ./node_modules/vitest/vitest.mjs run \
  src/services/agent-card.test.ts src/routes/capabilities.inbound-chains.test.ts
# Si algo queda undefined, `ctx` se resuelve en los routes (camino B de §4.7.1).
```

### A-8 · Control de cierre de CADA wave (CD-11)

```bash
BASE=3823580
for f in $(git diff --name-only $BASE); do
  echo "=== $f"; git diff -U0 $BASE -- "$f" | command grep '^@@'
done
# Toda cita al PROPIO archivo con nº mayor al punto de inserción se re-mide comparando
# CONTENIDO: HOY[n] vs BASE[n − delta]. `delta neto == tamaño` ⟹ archivo nuevo ⟹ exento.
command grep -rn "ningún campo de fee" src/ doc/          # CD-21
```
