# SDD #215: [WKH-318] `limit` colapsa el registro federado — y la respuesta lo niega

> SPEC_APPROVED: sí — 2026-07-30 (orquestador, delegado por Fernando)
> Story File: `story-HU-318.md`
> Fecha: 2026-07-30
> Tipo: bug + improvement (money-path + superficie pública)
> SDD_MODE: full
> Branch: `feat/215-wkh-318-discover-limit-federado`
> Worktree: `/home/ferdev/.openclaw/workspace/wt-318`
> Artefactos: `doc/sdd/215-wkh-318-discover-limit-colapsa-registro-federado/`

---

## 1. Resumen

Cualquier `limit` en `/discover` hace desaparecer al registro federado `WasiAI`
(20 de 23 agentes), y la respuesta sigue afirmando que ese registro contribuyó.
`/compose` y `/orchestrate` pasan `limit` internamente, así que la orquestación
viene eligiendo entre 3 agentes creyendo elegir entre 23.

Se arregla en dos cortes entregables por separado:

- **Corte A — honestidad.** La respuesta deja de afirmar más de lo que la
  evidencia sostiene: `registries` pasa a listar sólo las fuentes que
  **aportaron filas**, y se agregan dos campos aditivos (`sources[]`,
  `catalogStatus`) que distinguen **tres** estados por fuente: *respondió*,
  *respondió pero hay más que no trajimos*, *no pude preguntarle*. No cambia qué
  agentes vuelven. Entregable solo, y hace **auto-detectable** cualquier
  regresión del corte B.
- **Corte B — que el fetch funcione con `limit`.** Cada registro declara su
  techo (`schema.discovery.maxLimit`) y `queryRegistry` acota el over-fetch a
  ese techo. Devuelve los agentes federados sin tocar `wasiai-v2` y sin quitar
  el `limit` (prohibido, ya rechazado por AR).

Sobre esos dos se monta la decisión del founder: **el caller declara su
tolerancia**. Por defecto se sirve el catálogo parcial y **se declara**; con
`requireCompleteCatalog: true` la request se **rechaza sin cobrar**.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 215 / WKH-318 |
| **Tipo** | bug (money-path) + improvement (contrato público) |
| **SDD_MODE** | full |
| **Objetivo** | Que `/discover` deje de reportar una falla de fetch como éxito, que el fetch federado funcione con `limit`, y que el caller pueda negarse a pagar por una orquestación hecha sobre un catálogo incompleto. |
| **Reglas de negocio** | (1) Un registro caído no tumba `/discover`. (2) Servir de menos afirmando que se sirvió todo está prohibido. (3) No se paga por un resultado producido en condiciones que el caller no aceptó. (4) Un **registro** caído no es un **agente** caído. |
| **Scope IN** | §6 |
| **Scope OUT** | §6 |
| **Missing Inputs** | §9 |

### Acceptance Criteria (EARS) — heredados del work-item

Los 8 AC del work-item se conservan **textualmente**. Mapeo a waves y tests en §5.4.

- **AC-1** camino feliz con `limit` · **AC-2** registro sin `limitParam` ·
  **AC-3** fetch que falla · **AC-4** honestidad de `registries`/`excluded` ·
  **AC-5** pool de `/compose` · **AC-6** `/orchestrate` mismo defecto ·
  **AC-7** no-regresión del camino sin `limit` · **AC-8** evidencia contra producción.

**AC-9 (nuevo, de la decisión del founder)** — IF el caller declara
`requireCompleteCatalog: true` y el catálogo resultante no es `complete`, THEN
el sistema SHALL rechazar la request **sin dejar débito neto**, y el rechazo
SHALL nombrar la fuente que no se pudo consultar y su motivo, distinguiéndose
de "no hay agentes".

**AC-10 (nuevo)** — WHEN el caller **no** declara `requireCompleteCatalog`, the
system SHALL servir con el catálogo disponible, marcar la respuesta como
parcial, y **no** agregar ninguna llamada de I/O respecto del comportamiento de
hoy.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos (todos verificados con Read/Glob; paths reales)

| Archivo | Por qué | Patrón extraído |
|---|---|---|
| `src/services/discovery.ts` | el defecto vive acá | fanout `Promise.all` + `.catch(()=>[])` (`:273-297`); `contributingRegistries = registries.map(r=>r.name)` (`:481`); gate `query.limit && schema.limitParam` (`:591-596`); `throw` del `!response.ok` FUERA de `cb.execute` (`:618-633`); payload no-array → `return []` (`:642-644`) |
| `src/lib/discovery-fetch-limit.ts` | contrato del over-fetch y del pool | `resolveUpstreamFetchLimit = max(pageLimit, env ?? 200)`; `COMPOSE_POOL_MIN_LIMIT = 50`; el docstring `:107-111` **rechaza explícitamente** la opción "sin `limit`" |
| `src/services/compose.ts` | consumidor money-path | `discoverAgentPool()` único productor del pool (`:134-138`); `DiscoverCache` memoiza la MISMA Promise (`:159-169`); `resolveAgent` llama `discoverAll()` **siempre**, incluso en el camino `getAgent` OK (`:1339`); el loop resuelve el step 0 antes de invocar nada (`:337-342`) |
| `src/routes/compose.ts` | dónde se corta sin cobrar | cadena de preHandlers (`:844-884`); `resolveComposeCapabilitiesHandler` corre **antes** de `requirePaymentOrA2AKey` y por eso "el descubrimiento es GRATIS" (`:278-312`); 503 `REGISTRY_UNAVAILABLE` pre-débito (`:830-836`); guard post-débito que **sí reembolsa** con `refundComposeStep0` (`:919-925`) |
| `src/lib/compose-step-shape.ts` | patrón "rechazar sin débito" | el docstring `:8-15` fija la propiedad: lo que se valida acá se rechaza SIN débito y SIN discovery |
| `src/services/orchestrate.ts` | consumidor money-path | `planOrchestration` es **cero débito** (`:456-459`); discovery `:557-561` y broaden-retry `:577-580`; early-returns por `planStatus` (`:501-541`, `:595-613`) |
| `src/routes/orchestrate.ts` | por qué el plan es gratis | `markSkipMiddlewareDebitHandler` (`:67-71`, `:142`) |
| `src/middleware/a2a-key.ts` | verificar que "gratis" es verdad | `skipMiddlewareDebit` respetado en **los cuatro** sitios de débito (`:721`, `:965`, `:1205`, `:1321`) y en el credit-back huérfano (`:623`) |
| `src/routes/capabilities.ts` | superficie pública que replica el bug | `discover({})` + `registries: discovered.registries` (`:62-77`); patrón de **cambio aditivo** sobre respuesta pública (HU-204, `:35-43`) |
| `src/routes/discover.ts` | contrato documentado | JSDoc del contrato de paginación (`:71-77`); validación pre-fanout (`:23-44`) |
| `src/types/index.ts` | tipos a extender | `RegistrySchema.discovery` (`:130-145`); `DiscoveryResult` (`:376-388`); `OrchestratePlanStatus` (`:814-819`) |
| `src/lib/circuit-breaker.ts` | evaluar si entra | `execute()` sólo cuenta como falla lo que **tira dentro** del callback (`:74-89`) |
| `supabase/migrations/20260401000000_kite_registries.sql` | el registro real | `limitParam: "limit"` (`:48`), endpoint `:41`, `auth {type:header, key:x-agent-key}` (`:67`) |
| `src/services/registry.ts` | cómo viaja `schema` | `schema` es JSONB **pass-through** (`:92`, `:155`) — un campo nuevo NO necesita cambio de service ni de ruta |
| `src/services/discovery.limit.test.ts` | exemplar de tests | mocks de `registry.js` / `undici` / `agent.js` / `reputation.js` / `identity.js`; helper `serveHonoringLimit` que **captura los `limit` enviados upstream** |
| `wasiai-v2/src/app/api/v1/capabilities/route.ts` | la otra punta (sólo lectura) | cap `1..100` → 400 (`:99-108`); default `20` (`:114`); `next_cursor` (`:157-158`, `:191`); **loop-break TD-002** (`:34-51`, `:76-90`) |

### 3.2 Medición en vivo (GET gratuitos, `2026-07-30`)

Contra `https://wasiai-a2a-production.up.railway.app`:

| Request | `total` | `agents` | `registries` |
|---|---|---|---|
| `/discover` | 23 | 23 | `["WasiAI","self-published"]` |
| `/discover?limit=5` | **3** | 3 | `["WasiAI","self-published"]` ← la mentira |
| `/discover?limit=100` | **3** | 3 | idem |
| `/discover?limit=200` | **3** | 3 | idem |
| `/discover?capabilities=remit.quote&limit=10` | 0 | 0 | idem |
| `/discover?minReputation=0&limit=10` | **3** | 3 | idem |

**AC-8 queda medido en F2 para el estado PRE-fix** (F4 repite post-fix).

### 3.3 Dos hallazgos nuevos que el work-item no tenía (medidos hoy)

**(a) El loop-break es load-bearing y explica por qué la cadena del work-item es
correcta.** `wasiai-v2` delega `capabilities` a a2a `/discover`
(`route.ts:81-88`), pero rompe el ciclo cuando la request trae `x-agent-key` y
no trae `x-wasiai-source: v2-proxy` (`:47-51`): en ese caso corre el **handler
legacy** contra la tabla `agents` de v2. Verificado por medición:

| Request a `app.wasiai.io/api/v1/capabilities` | Resultado |
|---|---|
| sin `x-agent-key` (curl externo) → **delega a a2a** | shape de `/discover` (`agents/total/registries/excluded`), 23 agentes |
| con `x-agent-key` (lo que manda a2a) → **legacy** | shape v2 (`agents/total/next_cursor`) |
| legacy `?limit=101` y `?limit=200` | **HTTP 400** `limit must be between 1 and 100` |
| legacy `?limit=100` | 200, **22 agentes**, `next_cursor: null` |
| legacy sin `limit` | 200, **20 agentes**, `next_cursor: SET` |

Consecuencia operativa a nombrar: a2a manda `x-agent-key` sólo si
`registry.auth.value` está seteado (`discovery.ts:607`). **Si esa credencial se
borrara, v2 dejaría de romper el ciclo y quedaría `a2a → v2 → a2a`.** Es una
razón adicional para no tocar la columna `auth` (CD-4).

**(b) El techo de 20 ya está ocultando agentes AHORA.** El work-item lo dejó
como "no pude determinarlo": queda **determinado**. La tabla `agents` de v2
tiene **22 activos**; el camino sin `limit` trae **20** y devuelve `next_cursor`
no nulo. O sea que el `total: 23` de producción **no es el catálogo**, y hoy
`/discover` y `/capabilities` afirman completitud sobre una página truncada.
**Esto convierte la detección de truncamiento en parte obligatoria del corte A**:
sin ella, A cambiaría una mentira por otra (`catalogStatus: 'complete'` sobre 20
de 22).

### 3.4 Estado de BD relevante

| Tabla | Existe | Columnas relevantes | Cambio propuesto |
|---|---|---|---|
| `registries` (bdwv) | Sí | `id, name, discovery_endpoint, invoke_endpoint, agent_endpoint, schema (JSONB), auth (JSONB), enabled, created_at` | **UPDATE aditivo** sobre `schema->'discovery'` de la fila `id='wasiai'` (dos claves nuevas). **La columna `auth` NO se toca.** |

No hay columnas nuevas, no hay tabla nueva, no hay índice nuevo.

### 3.5 Auto-Blindaje histórico consultado (obligatorio)

Leídos `doc/sdd/208-compose-por-capacidad/auto-blindaje.md`,
`209-wkh-307-.../auto-blindaje.md`, `201-settle-success-false-not-proof/auto-blindaje.md`.
Patrones recurrentes (≥2 HUs) que se convierten en CD de esta HU:

| Patrón recurrente | Dónde apareció | CD que lo previene acá |
|---|---|---|
| Un test que mira el **status code** y no el **saldo** no detecta el cobro indebido | HU-208 W2 | **CD-9** |
| Una afirmación de "no agrega costo" hay que **asertarla como costo** (nº de llamadas de I/O), no como efecto | HU-208 W3-M5 | **CD-10** |
| **Dos expresiones separadas** para la misma cantidad divergen | HU-208 W2 (`step0-debit`) | **CD-11** |
| Un mutante puede dar **falso KILLED**: hay que probar que aterrizó | WKH-307 (M12) | **CD-12** |
| Un guard que se compara **consigo mismo** no prueba nada | 201 / memoria del proyecto | **CD-7** (heredada) |

---

## 4. Diseño Técnico

### 4.1 Decisiones técnicas (DT-N)

Se **heredan DT-1 … DT-5 del work-item**. Se agregan:

- **DT-6 — Cómo se expresa "parcial" sin romper integradores.**
  `registries` **conserva su tipo** (`string[]`) y su nombre; lo único que
  cambia es **cómo se calcula**: pasa de "los registros configurados"
  (`discovery.ts:481`) a "las fuentes que aportaron filas". En el camino sano el
  valor es **byte-idéntico** al de hoy. La degradación viaja en **dos campos
  nuevos**, aditivos:

  ```ts
  /** Tres estados por fuente. Un booleano ya habría perdido el tercero. */
  export type DiscoverySourceState =
    | 'ok'         // respondió, y lo que trajo es todo lo que tiene para esta query
    | 'truncated'  // respondió, pero hay más filas que NO trajimos
    | 'failed';    // NO se la pudo consultar

  export type DiscoverySourceFailure =
    | 'http_error' | 'timeout' | 'ssrf_blocked'
    | 'circuit_open' | 'bad_payload' | 'unknown';

  export interface DiscoverySource {
    name: string;
    state: DiscoverySourceState;
    /**
     * Filas que la fuente aportó al conjunto candidato, ANTES de los filtros
     * locales.  `null` cuando `state==='failed'` — NO 0.  Un 0 significa
     * "le pregunté y no tiene"; `null` significa "no pude preguntarle".
     */
    rows: number | null;
    failure?: DiscoverySourceFailure;        // sólo si state==='failed'
    truncationEvidence?: 'cursor' | 'page_full'; // sólo si state==='truncated'
  }

  /** Roll-up de request.  Mismo triplete, un nivel más arriba. */
  export type CatalogStatus = 'complete' | 'truncated' | 'partial';
  ```

  Y en `DiscoveryResult`: `sources: DiscoverySource[]` y
  `catalogStatus: CatalogStatus`, **requeridos en el tipo** (garantía de
  compilación: ningún constructor de `DiscoveryResult` puede omitirlos — mismo
  recurso que `RegistryPublic.authConfigured`, `types/index.ts:127`) y
  **aditivos en el cable** (no se quita ni se re-tipa ningún campo existente).

  Precedencia del roll-up: `partial` > `truncated` > `complete`. Sin registros
  habilitados (sólo self-published) → `complete`: no hay nada que haya fallado.

- **DT-6.1 — Qué significa "aportó filas".** Filas **devueltas por el fetch**,
  antes de los filtros locales (status/verified/caps/free-text/maxPrice/scope/
  minReputation). Motivo medido: hoy `?capabilities=remit.quote&limit=10`
  devuelve 0 agentes y `registries` con las dos fuentes. Si "aportó" se contara
  post-filtro, una query selectiva reportaría fuentes desaparecidas y el caller
  leería degradación donde sólo hubo un filtro. Los locales
  (`self-published`) se cuentan con la misma regla — que es, literalmente, la
  regla que `discovery.ts:482-484` ya aplica sólo a ellos. Esta HU la
  **generaliza** en vez de inventar una segunda.

- **DT-7 — Mecanismo del corte B: techo declarado por registro.**
  `RegistrySchema.discovery` gana `maxLimit?: number`. `queryRegistry` envía
  `min(resolveUpstreamFetchLimit(query.limit), maxLimit)` **sólo cuando
  `maxLimit` está declarado**. Ausente ⇒ comportamiento byte-idéntico al de hoy.

  Alternativas evaluadas y **rechazadas**, con argumento:

  | Opción | Por qué no |
  |---|---|
  | **Quitar el `limit`** | PROHIBIDA por el encargo y por AR (`discovery-fetch-limit.ts:107-111`): el pool pasaría a decidirlo el default de paginación del upstream — medido: **20**, y fuera de nuestro control. |
  | **Reintentar sin `limit` ante 4xx** | El reintento aterriza exactamente en ese default de 20; además enmascara 400 legítimos (un `tag` inválido se volvería "degradación"), y duplica round-trips en el peor momento. Puede volver como tier 2 si algún día hace falta; hoy agrega superficie sin agregar catálogo. |
  | **Descubrir el techo del upstream (probe / bisección)** | No hay convención estándar que responder; requiere estado cacheado por registro con su propia invalidación, y paga round-trips para averiguar algo que el registrante puede simplemente declarar. |
  | **Subir el cap de 100 en `wasiai-v2`** | Es nuestro repo, así que es viable — pero (i) CD-3 lo prohíbe en esta HU, (ii) arregla **un** registro y deja al siguiente registro de terceros con cap 100 rompiéndonos igual, y (iii) no toca el techo real de hoy, que es el default de 20 + `next_cursor`. Se propone como HU aparte y **coordinada** (§8). No es dependencia de ésta. |
  | **Paginar con `next_cursor`** | Es la solución de fondo al techo de 20, y es una HU con su propio riesgo (N round-trips por registro, corte por presupuesto de tiempo, orden estable). Fuera de alcance — pero su **detección** entra (DT-8). |

  Propiedad valiosa del mecanismo elegido: **si la migración no se aplica, el
  código es inerte** (sin `maxLimit` no hay clamp) y el sistema sigue
  comportándose como con el corte A solo, o sea reportando la degradación con
  honestidad. Falla en la dirección segura.

- **DT-8 — Truncamiento: se detecta, no se pagina.** `queryRegistry` marca
  `truncated` con dos evidencias, en este orden:
  1. `cursor` — `schema.discovery.nextCursorPath` declarado y ese campo llega
     no-nulo. **Exacta.** Es la que atrapa el caso real medido (20 de 22).
  2. `page_full` — se mandó un límite y llegaron **exactamente** esa cantidad de
     filas. **Heurística**, y su único error posible es de sobra-declarar
     (`rows === cap` con el catálogo justo del tamaño del cap). Sobre-declarar
     incompletitud es el lado seguro del error.

  Sin límite enviado y sin `nextCursorPath` declarado, no hay evidencia y el
  estado es `ok`: no se inventa una certeza que no tenemos.

  Esto además resuelve la única tensión que dejaba DT-5: cuando el techo del
  registro es menor que el over-fetch, el fetch es físicamente más chico de lo
  pedido — y **cada vez que el techo muerde, la fuente se reporta `truncated`**.
  La monotonía deja de ser una promesa que el código no puede cumplir y pasa a
  ser una afirmación verificable.

- **DT-9 — La tolerancia la declara el caller, en el body, a nivel request.**
  `requireCompleteCatalog?: boolean` en el body de `POST /compose`,
  `POST /orchestrate`, `/orchestrate/plan` y `/orchestrate/execute`.

  Por qué **body y no header**: en este repo los headers eligen **rail de
  transporte** (`x-payment-chain`, `routes/compose.ts:98`), no política de
  facturación. Por qué **a nivel request y no por step** (a diferencia de
  `constraints.allow_trial`, que introduce WKH-313): el fanout a registros
  corre **una vez por request** (`discovery.ts:273`), no por step; una
  tolerancia por step no tendría a qué aplicarse y obligaría a tocar el
  allowlist de `compose-step-shape.ts:156` — el mismo renglón que WKH-313 está
  editando **ahora** (§7, riesgo de colisión). Verificado con Grep:
  `allow_trial` **todavía no existe** en el código de este repo, sólo en el SDD
  de WKH-313.

  Por qué NO se agrega a `/discover`: `/discover` no cobra. Su obligación es
  decir la verdad, y con `catalogStatus` la dice. Un modo "rechazá si está
  incompleto" en un endpoint gratuito agrega superficie sin proteger dinero.

- **DT-10 — El default es `false` (servir parcial y declararlo).** Argumentos, en
  orden de peso:
  1. Es la primera mitad de la decisión del founder: *"cuando un registro
     federado se cae, la orquestación sigue con lo que tiene"*.
  2. **Un registro caído no es un agente caído.** Lo que se pierde es parte del
     catálogo **donde elegir**, y el agente correcto puede estar en la parte
     visible. Evidencia dura: el bug está activo en producción **ahora** y
     Chaski funciona, porque sus tres agentes son exactamente los que sobreviven
     al colapso. Un corte incondicional tumbaría hoy mismo una orquestación que
     funciona.
  3. Back-compat: invertir el default convertiría los 200 de hoy en 503 para
     **todo** integrador, incluido el del 03/08, y por una condición que en
     producción es permanente hasta que el corte B se despliegue.
  4. La honestidad ya no depende del flag: el caller que no sabe que la opción
     existe **igual recibe** `catalogStatus: 'partial'` y puede detectarlo.

  Rechazado con argumento: un default por env (`..._DEFAULT`). Un deploy podría
  empezar a rechazar requests pagas sin que ningún caller cambiara nada, y
  produciría dos deployments con semántica de facturación distinta detrás de la
  misma URL. La política de cobro la declara el que paga.

- **DT-11 — El "sin cobrar" se garantiza en DOS capas, y la segunda reembolsa.**
  Es la coherencia que el encargo pide nombrar: es la misma política que el
  founder ya eligió para los pagos indeterminados —**rechazar sin consumir la
  prueba**— aplicada a otro recurso. Acá el recurso es el saldo del caller, y
  "no consumir" significa que **no queda débito neto**.

  | Ruta | Capa 1 (pre-débito, **nunca se cobra**) | Capa 2 (TOCTOU, post-débito, **credit-back**) |
  |---|---|---|
  | `/orchestrate` | early-return dentro de `planOrchestration`, inmediatamente después del discovery y de su broaden-retry. **Cero débito por construcción**: el route marca `skipMiddlewareDebit` (`routes/orchestrate.ts:142`) y los cuatro sitios de débito del middleware lo respetan (`a2a-key.ts:721,965,1205,1321`); el débito real vive en `executeApprovedPlan`, que en este camino **no se llama**. | la ejecución baja a `composeService.compose` → cubierta por la capa 2 de `/compose`. |
  | `/compose` | preHandler `requireCompleteCatalogHandler`, ubicado **después** de `validateComposeBodyHandler` y **antes** de `resolveComposeCapabilitiesHandler` (y por lo tanto antes de `resolveComposePriceHandler` y de `requirePaymentOrA2AKey`). Idiom Fastify-5 `return reply.status(503).send(...)`, el mismo que ya usa el 503 `REGISTRY_UNAVAILABLE` (`compose.ts:830-836`). | dentro de `composeService.compose`: el catálogo se resuelve **antes del primer `invokeAgent`** y, si el caller exigió completo, se aborta y el route llama `refundComposeStep0(request, 0)` — copia literal del idiom de `compose.ts:919-925`, que existe precisamente porque a esa altura el débito ya se aplicó. |

  La capa 2 no es paranoia: entre el preHandler y el fetch del service pasan
  cientos de ms y son **dos fetches distintos**. Sin ella, "no se cobra por lo
  que el caller no aceptó" sería verdad en el caso fácil y falso en el caso real.

- **DT-12 — `no_agents` y `catalog_incomplete` no se colapsan.**
  `OrchestratePlanStatus` gana `'catalog_incomplete'`. `no_agents` significa
  *pregunté y no hay*; `catalog_incomplete` significa *no pude preguntar*. En
  `mapPlanEarlyReturnToOrchestrateResult` (`orchestrate.ts:396-422`) el nuevo
  status **no** entra en la lista de `pipelineSuccess === true` (donde sí está
  `no_agents`): no se pudo cumplir, y decir lo contrario sería el bug de esta HU
  reencarnado un nivel más arriba.

- **DT-13 — El circuit breaker NO cambia de semántica en esta HU (declarado).**
  Hoy el `throw` del `!response.ok` está fuera de `cb.execute`
  (`discovery.ts:618-633`), así que un 400 sostenido no abre nada. Meterlo
  adentro es una línea, pero **cambia el comportamiento del money-path**: un
  registro con 429 transitorios abriría el circuito para **todas** las requests
  durante el cooldown (30 s por default, `circuit-breaker.ts:152`), y bajo
  `requireCompleteCatalog: true` eso son requests pagas rechazadas por una
  ráfaga. Es un cambio que merece su propia medición y su propio AR.
  Lo que **sí** entra, y cierra el agujero real que el work-item señala ("el
  fallo es perfectamente mudo"): la falla deja de ser muda por tres vías —
  `sources[].failure` en la respuesta, un `log.warn` estructurado con
  `error_code: 'REGISTRY_SOURCE_FAILED'` (patrón de `compose.ts:258`), y el
  hecho de que `catalogStatus` sea observable desde afuera con un GET gratis.
  Queda **TD-318-1** (§8).

- **DT-14 — `next_cursor` queda fuera; el número queda dentro.** No se implementa
  paginación (Scope OUT del work-item). Pero el hallazgo deja de ser una
  incógnita: **v2 tiene 22 agentes activos y el camino sin `limit` muestra 20**
  (medido, §3.3). Post-corte-B el camino **con** `limit` trae los 22, así que el
  techo deja de morder al catálogo actual y vuelve a morder recién por encima de
  100. Mientras tanto el camino **sin** `limit` sigue mostrando 20 — y ahora lo
  **declara** como `truncated` (DT-8). Queda **TD-318-2** (§8).

### 4.2 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar |
|---|---|---|---|
| `src/lib/discovery-sources.ts` | **Crear** | Módulo **LEAF** (cero imports de runtime): `buildCatalogStatus(sources)`, `classifyFetchFailure(err)`, `isCatalogComplete(result)` (fail-closed ante `undefined`). Leaf por la razón ya documentada en `discovery-fetch-limit.ts:1-11`: lo consumen `routes/compose.ts` y `services/compose.ts`, y media docena de suites mockean `services/discovery.js` **completo**. | `src/lib/discovery-fetch-limit.ts`, `src/lib/compose-step-shape.ts` |
| `src/types/index.ts` | Modificar | `DiscoverySourceState`, `DiscoverySourceFailure`, `DiscoverySource`, `CatalogStatus`; `DiscoveryResult.sources` + `.catalogStatus` (requeridos); `RegistrySchema.discovery.maxLimit?` + `.nextCursorPath?`; `OrchestratePlanStatus += 'catalog_incomplete'`; `OrchestratePlanResult.failedSources?` | `RegistryPublic` (`:103-128`) para el recurso de garantía por compilación |
| `src/services/discovery.ts` | Modificar | `queryRegistry` devuelve `{agents, state, rows, failure?, truncationEvidence?}`; el `.catch` del fanout (`:275-295`) construye el outcome `failed` en vez de `[]`; `contributingRegistries` (`:481`) se calcula desde los outcomes; clamp `maxLimit` en `:591-596`; el `return []` del payload no-array (`:642-644`) pasa a `failed/bad_payload` | su propio `attachIdentities` (`:516-535`) para el estilo degradable |
| `src/routes/discover.ts` | Modificar | **Sólo JSDoc** del contrato (`:71-77`): documentar `sources` y `catalogStatus`. Cero cambio de lógica. | — |
| `src/routes/capabilities.ts` | Modificar | Agregar `catalogStatus` y `sources` al payload, sin tocar los campos previos | HU-204 en el mismo archivo (`:35-43`) |
| `src/services/compose.ts` | Modificar | `discoverAgentPool()` → devuelve el `DiscoveryResult`; `DiscoverCache` gana `result()` y `all()` sigue devolviendo `.agents`; guard de capa 2 antes del primer `invokeAgent`; `ComposeRequest.requireCompleteCatalog?` | `createDiscoverCache` (`:159-169`) |
| `src/routes/compose.ts` | Modificar | `ComposeBody.requireCompleteCatalog?`; preHandler `requireCompleteCatalogHandler` en la posición de DT-11; mapeo del error de capa 2 a 503 + `refundComposeStep0` | `resolveComposeCapabilitiesHandler` (`:313-374`) y el guard `unresolvedIndex` (`:919-925`) |
| `src/services/orchestrate.ts` | Modificar | early-return `catalog_incomplete` post-discovery en `planOrchestration`; propagar `requireCompleteCatalog` a `composeService`; `mapPlanEarlyReturnToOrchestrateResult` sin cambio de lista de éxito | early-return `no_agents` (`:595-613`) |
| `src/routes/orchestrate.ts` | Modificar | `requireCompleteCatalog` en el JSON-schema del body de las 3 rutas (`boolean`) | schema existente (`:117-132`) |
| `supabase/migrations/2026073000000_registry_max_limit.sql` | **Crear** | UPDATE idempotente de `schema->'discovery'` de `id='wasiai'`: `maxLimit: 100`, `nextCursorPath: 'next_cursor'`. **No toca `auth`.** | `20260401000000_kite_registries.sql` |
| tests (§5) | Crear/Modificar | ver §5 | `src/services/discovery.limit.test.ts` |

### 4.3 Flujo principal (happy path, post-fix)

1. Caller: `GET /discover?limit=5`.
2. `queryRegistry(WasiAI)`: `resolveUpstreamFetchLimit(5) = 200`, clamp por
   `maxLimit: 100` → **se envía `limit=100`**.
3. v2 legacy responde 200 con 22 filas, `next_cursor: null` → `22 < 100` y sin
   cursor ⇒ `state: 'ok'`, `rows: 22`.
4. `self-published` aporta 3 ⇒ `state: 'ok'`, `rows: 3`.
5. Filtros locales + ranking + `slice(0,5)`.
6. Respuesta: `agents.length = 5`, `total = 25`,
   `registries: ["WasiAI","self-published"]`, `catalogStatus: 'complete'`,
   `sources: [{WasiAI, ok, 22}, {self-published, ok, 3}]`.

### 4.4 Flujos de error

**(a) Una fuente cae, caller por defecto.** `sources[i] = {state:'failed',
rows:null, failure:'http_error'}`; `registries` **no** la incluye;
`catalogStatus: 'partial'`; los agentes de las fuentes sanas **se devuelven
igual** (DT-4/CD-4 intactos). `/compose` y `/orchestrate` siguen y el caller
recibe la marca de parcialidad en la respuesta.

**(b) Una fuente cae, caller con `requireCompleteCatalog: true`.**

- `/compose` → **503** antes del débito:
  ```json
  { "error": "Could not query registry 'WasiAI' (http_error); the agent catalog is incomplete and this request asked for a complete one",
    "error_code": "CATALOG_INCOMPLETE",
    "catalogStatus": "partial",
    "failedSources": [{ "name": "WasiAI", "failure": "http_error" }],
    "requestId": "..." }
  ```
  Nunca dice "no agents found": el motivo es *no pude preguntar*, no *pregunté y
  no hay*.
- `/orchestrate` → 200 con `planStatus: 'catalog_incomplete'`, `reasoning`
  nombrando la fuente y el motivo, `failedSources` en el resultado, `steps: []`,
  `totalCostUsdc: 0`. HTTP 200 por consistencia con los otros early-returns de
  plan (`insufficient_funds`, `no_agents`); lo que importa —y lo que el test
  candará— es que **el saldo no se movió**.

**(c) TOCTOU.** El preHandler vio todo sano, el fetch del service falla, el
caller exigió completo: `composeService` aborta **antes del primer
`invokeAgent`**, el route responde 503 `CATALOG_INCOMPLETE` y llama
`refundComposeStep0(request, 0)`. Débito neto: cero.

**(d) La distinción que no se puede perder.** Si el **agente elegido** falla
durante la ejecución con el catálogo completo, nada de esto interviene: sigue el
camino de reembolso que ya existe. `CATALOG_INCOMPLETE` habla del **catálogo**,
nunca del agente.

---

## 5. Plan de tests (≥1 por AC, con el mutante que mata cada uno)

Archivos: `src/services/discovery.sources.test.ts` (nuevo),
`src/services/discovery.truncation.test.ts` (nuevo),
`src/services/discovery.limit.test.ts` (extender),
`src/services/compose.discovery-pool.test.ts` (extender),
`src/routes/compose.catalog-strict.test.ts` (nuevo),
`src/routes/orchestrate.test.ts` (extender),
`src/routes/capabilities.inbound-chains.test.ts` (extender).

Mocks: copiar el bloque de `discovery.limit.test.ts:20-62` (logger, `registry.js`,
`circuit-breaker.js`, `undici`+global `fetch`, `agent.js`, `reputation.js`,
`identity.js`) y el helper que **captura los `limit` enviados upstream**
(`:96-110`).

### 5.1 Corte A — honestidad (W1)

| Test | Qué fija | AC | Mutante que lo mata |
|---|---|---|---|
| `T-SRC-01` | fuente que responde 500 ⇒ `sources` la marca `failed`/`rows:null`, `registries` **no** la lista, `catalogStatus:'partial'` | AC-3, AC-4 | **M1**: volver a `contributingRegistries = registries.map(r=>r.name)` (el código de hoy, `:481`) |
| `T-SRC-02` | fuente que responde 200 con `[]` ⇒ `state:'ok'`, `rows:0`, `catalogStatus:'complete'`, y **no** aparece en `registries` | AC-4 | **M2**: `rows: n ?? 0` (colapsa `failed` y "cero agentes" en la misma representación) |
| `T-SRC-03` | 2 fuentes, una cae ⇒ los agentes de la sana se devuelven igual y `/discover` responde 200 | AC-3, CD-4 | **M3**: propagar la excepción del fanout en vez de degradarla |
| `T-SRC-04` | clasificación del motivo: `ssrf_blocked`, `timeout`, `circuit_open`, `http_error`, **`bad_payload`** (payload no-array, hoy `return []` en `:642-644`) | AC-3 | **M4**: mapear `bad_payload` a `ok`/`rows:0` |
| `T-SRC-05` | happy path ⇒ `registries` **byte-idéntico** al de hoy y `catalogStatus:'complete'` | AC-1 | **M1** también; y **M2b**: excluir de `registries` a una fuente sana por un off-by-one |
| `T-SRC-06` | `/capabilities` expone `catalogStatus`+`sources` y **conserva** los 9 campos previos con el mismo nombre y valor | AC-4 | **M5**: renombrar/quitar `registries` del payload |
| `T-SRC-07` | **CD-7, el guard no se compara consigo mismo**: 2 registros habilitados, 1 falla ⇒ `sources.length===2`, exactamente uno `failed`, **y `registries.length===1`**. Si el cálculo saliera de la lista de configurados, `registries.length` sería 2 | AC-4, CD-7 | **M1** (y es el test que lo mata sin ambigüedad) |

### 5.2 Corte A' — truncamiento (W2)

| Test | Qué fija | AC | Mutante |
|---|---|---|---|
| `T-TRUNC-01` | `nextCursorPath` declarado + cursor no-nulo ⇒ `truncated`/`cursor`, `catalogStatus:'truncated'` | AC-4 | **M6**: ignorar el cursor |
| `T-TRUNC-02` | cursor `null` ⇒ `ok` (no sobre-declara) | AC-4 | **M7**: tratar la presencia de la clave como evidencia |
| `T-TRUNC-03` | `rows === limitEnviado` ⇒ `truncated`/`page_full` | AC-4 | **M8**: `>` en vez de `>=` |
| `T-TRUNC-04` | `rows < limitEnviado` ⇒ `ok` | AC-4 | **M9**: marcar siempre `truncated` cuando hay límite |
| `T-TRUNC-05` | camino **sin** `limit`: no se envía ningún parámetro nuevo upstream (assert sobre los params capturados, no sobre el resultado) y sin cursor declarado el estado es `ok` | **AC-7**, CD-5 | **M10**: enviar `limitParam` (o el clamp) en el camino sin `limit` |

### 5.3 Corte B — clamp (W3)

| Test | Qué fija | AC | Mutante |
|---|---|---|---|
| `T-CLAMP-01` | `maxLimit:100` + caller `limit=5` ⇒ upstream recibe **`100`** | AC-1 | **M11**: quitar el `Math.min` ⇒ recibe 200 |
| `T-CLAMP-02` | registro **sin** `maxLimit` ⇒ upstream recibe `200`, byte-idéntico a hoy | AC-7 | **M12**: default `maxLimit = 100` para todos |
| `T-CLAMP-03` | registro sin `limitParam` ⇒ no recibe nada, sus agentes entran, no degrada | **AC-2** | **M13**: enviar el clamp aunque no haya `limitParam` |
| `T-CLAMP-04` | **el test de dinero (CD-1)**: 2 fuentes, una con `maxLimit:100` sirviendo 60 agentes donde el target es el **último por precio asc**; `resolveComposeAgentPoolLimit()` produce un pool que **contiene al target** y de tamaño ≥ 50 | **AC-5** | **M14**: clampar el pool a 20 (o bajar `COMPOSE_POOL_MIN_LIMIT`) ⇒ el target sale del pool ⇒ `payment.chain` no se hidrata ⇒ el leg downstream se saltea *en silencio* (`discovery-fetch-limit.ts:59-71`) |
| `T-CLAMP-05` | `maxLimit < 50` ⇒ se honra igual, se marca `truncated` al llenar la página y se emite `REGISTRY_CAP_BELOW_POOL_FLOOR` | CD-1 | **M15**: ignorar `maxLimit` cuando es menor que el piso ⇒ 400 del upstream ⇒ fuente perdida |
| `T-CLAMP-06` | **reproducción del bug de producción**: registro que devuelve **400** ante `limit>100` (como el legacy de v2 medido) + 3 locales; con el clamp, `limit=5` ⇒ 5 agentes, `total` = unión pre-limit, `catalogStatus:'complete'` | AC-1, AC-3 | **M11** ⇒ vuelve `total=3` y `catalogStatus:'partial'` |

### 5.4 W4 — money-path (los que importan)

| Test | Qué fija | AC | Mutante |
|---|---|---|---|
| `T-STRICT-01` | `/orchestrate` + fuente caída + `requireCompleteCatalog:true` ⇒ `planStatus:'catalog_incomplete'`, **`getBalance` final === inicial**, y `executeApprovedPlan` **nunca invocado** | AC-9 | **M16**: mover el chequeo a `executeApprovedPlan` (post-débito) ⇒ el saldo baja |
| `T-STRICT-02` | misma fuente caída **sin** el flag ⇒ `planStatus:'ready'` y se ejecuta | AC-10, DT-10 | **M17**: invertir el default |
| `T-STRICT-03` | `/compose` + flag + fuente caída ⇒ **503 `CATALOG_INCOMPLETE`**, saldo intacto, `composeService.compose` nunca invocado | AC-9 | **M18**: mover `requireCompleteCatalogHandler` **después** de `requirePaymentOrA2AKey` ⇒ el saldo baja (es exactamente el agujero HIGH-2 de `compose.ts:124-128`) |
| `T-STRICT-04` | **TOCTOU**: preHandler sano, fetch del service caído ⇒ 503 y **saldo de vuelta al inicial**; cero `invokeAgent`, cero settle | AC-9 | **M19**: quitar el `refundComposeStep0` ⇒ saldo menor. **M20**: mover el guard después del primer `invokeAgent` ⇒ hay settle |
| `T-STRICT-05` | `catalogStatus === undefined` (respuesta vieja) + flag ⇒ **rechaza** (fail-closed) | AC-9 | **M21**: `!== 'partial'` en vez de `=== 'complete'` ⇒ `undefined` pasa como completo |
| `T-STRICT-06` | **CD-10**: sin el flag, el preHandler **no hace ni una** llamada a `discover` — assert sobre el **número de llamadas**, no sobre el efecto | AC-10 | **M22**: quitar el gate del flag ⇒ 1 llamada extra por request |
| `T-STRICT-07` | el cuerpo del rechazo **nombra la fuente y el motivo** y **no** contiene "no agents" | AC-9 | **M23**: reemplazar el mensaje por el genérico de `no_agents` |
| `T-STRICT-08` | **la distinción del founder**: agente que falla en ejecución con catálogo `complete` ⇒ sigue su camino de reembolso actual, **no** `CATALOG_INCOMPLETE` | AC-9 | **M24**: mapear cualquier fallo de step a `CATALOG_INCOMPLETE` |
| `T-ORCH-RETRY` | `/orchestrate`: el **broaden-retry** (`:577-580`) usa el mismo conjunto de fuentes sanas que el primer pase y hereda el clamp | **AC-6** | **M25**: quitar el clamp sólo en el retry (el bug del work-item: el mecanismo de repoblado igual de envenenado) |

**AC-8** no es un test unitario: es evidencia contra el entorno desplegado, con
GET gratuitos. Comando para F4 (mismo que produjo la tabla de §3.2), a correr
post-deploy y a comparar contra ella:

```
GW=https://wasiai-a2a-production.up.railway.app
python3 -c "import json,urllib.request as u;
[print(q, json.loads(u.urlopen(u.Request(GW+q,headers={'User-Agent':'curl/8'})).read())['total']) for q in
 ['/discover','/discover?limit=5','/discover?limit=100','/discover?capabilities=remit.quote&limit=10','/discover?minReputation=0&limit=10']]"
```

### 5.5 Disciplina de mutación (obligatoria, CD-12)

Por mutante: árbol limpio → aplicar → **probar que aterrizó** (hash del archivo
distinto del respaldo) → `npx tsc --noEmit` **completo y limpio** → correr la
suite → restaurar por `cp` desde el respaldo → **verificar por hash**. Nunca
`git checkout --` (auto-blindaje 203: borró trabajo sin commitear; y esta HU
crea archivos untracked). Un mutante que **no compila** no cuenta como KILLED:
hay que reformularlo.

---

## 6. Scope

**IN**

- `src/services/discovery.ts`, `src/lib/discovery-sources.ts` (nuevo),
  `src/types/index.ts`, `src/routes/discover.ts` (sólo JSDoc),
  `src/routes/capabilities.ts`.
- `src/services/compose.ts`, `src/routes/compose.ts`,
  `src/services/orchestrate.ts`, `src/routes/orchestrate.ts`.
- Migración aditiva sobre `registries.schema` (fila `id='wasiai'`), aplicada a
  **bdwv** únicamente.
- Los tests de §5.

**OUT** (todo lo del work-item, más lo que este SDD decide dejar afuera)

- Modificar `wasiai-v2` (CD-3). Incluye subir su cap de 100 → HU aparte (§8).
- Cambiar la semántica del circuit breaker (DT-13) → TD-318-1.
- Implementar paginación por `next_cursor` (DT-14) → TD-318-2.
- Reapuntar el `discoveryEndpoint` del registro `WasiAI`.
- Cambiar el ranking, el filtro de scope de HU-208, o el residual TD-189-1.
- Mainnet. Devnet/testnet únicamente.
- Confirmar o cerrar la tarea #86.
- `requireCompleteCatalog` en `/discover` (DT-9).

---

## 7. Constraint Directives

Se **heredan CD-1 … CD-7 del work-item, sin modificación**. Se agregan:

- **CD-8 (OBLIGATORIA)** — El camino **sin** `limit` queda **byte-idéntico** en
  lo que envía upstream. El clamp de `maxLimit` sólo puede aplicarse dentro del
  gate `query.limit && schema.limitParam` que ya existe (`discovery.ts:591`).
  Test que lo canda: `T-TRUNC-05`, que asserta los **parámetros capturados**, no
  el resultado.
- **CD-9 (OBLIGATORIA, del auto-blindaje HU-208 W2)** — Todo test de esta HU que
  afirme "no se cobró" debe assertar el **saldo** (o el nº de llamadas al
  débito), **nunca sólo el status code**. Un test que sólo mira el 503 no habría
  encontrado el bug que HU-208 encontró.
- **CD-10 (OBLIGATORIA, del auto-blindaje HU-208 W3-M5)** — Toda afirmación de
  "no agrega costo" se asserta como **costo**: número exacto de llamadas de I/O
  (`discover`, `getBalance`, `lookupByHash`), no ausencia de efecto observable.
- **CD-11 (OBLIGATORIA, del auto-blindaje HU-208 W2)** — **Una sola expresión**
  para "el catálogo está completo": `isCatalogComplete()` en
  `lib/discovery-sources.ts`. Prohibido que el preHandler, el service y el
  planner cada uno derive la condición por su cuenta. La divergencia de dos
  expresiones de la misma cantidad ya costó un cobro sin reembolso en este repo.
- **CD-12 (OBLIGATORIA, de WKH-307)** — Disciplina de mutación de §5.5. Un
  KILLED sin prueba de que el mutante aterrizó y compiló no cuenta.
- **CD-13 (PROHIBIDO)** — Que `catalogStatus` ausente/`undefined` se lea como
  completo. El lector es **fail-closed**: sin dato, en modo estricto se rechaza.
  Es el tercer valor, y perderlo es el bug que esta HU existe para matar.
- **CD-14 (PROHIBIDO)** — Colapsar `failed` con `rows: 0`. Una fuente que no se
  pudo consultar reporta `rows: null`.
- **CD-15 (PROHIBIDO)** — Que el rechazo por catálogo incompleto reutilice el
  mensaje o el código de "no hay agentes" (`no_agents` / `no_agent_match`).
- **CD-16 (OBLIGATORIA)** — Un escritor por repo. Esta HU escribe **sólo**
  `wasiai-a2a`, en el worktree `wt-318` / rama
  `feat/215-wkh-318-discover-limit-federado`. `wasiai-v2` se lee, nunca se
  escribe (CD-3).
- **CD-17 (PROHIBIDO)** — Tocar la columna `auth` de `registries`, cualquier base
  que no sea `bdwv`, o `caldz`. La migración es un `UPDATE` sobre
  `schema->'discovery'` y nada más. Motivo extra, medido en §3.3(a): borrar esa
  credencial reabre la recursión `a2a → v2 → a2a`.
- **CD-18 (OBLIGATORIA)** — Coordinación con **WKH-313** (`wt-313`, corriendo
  ahora): esta HU **no toca** `src/lib/discovery-query.ts`,
  `src/lib/compose-step-shape.ts`, `src/services/capability-resolver.ts`, el
  bloque `minReputation` de `discovery.ts:422-428`, ni el campo
  `DiscoveryResult.excluded`. La degradación viaja en **campos nuevos**
  (`sources`, `catalogStatus`), no dentro de `excluded`. Los puntos de contacto
  restantes son `src/types/index.ts` (bloques distintos) y `routes/discover.ts`
  (JSDoc). Verificado leyendo `doc/sdd/211-.../sdd.md` §DT-7/W0.2.

---

## 8. Riesgos, dependencias y deuda declarada

| Riesgo | P | I | Mitigación |
|---|---|---|---|
| Un integrador lee `registries` y se sorprende de que se acorte bajo falla | M | B | El tipo no cambia; el valor sólo se acorta cuando **realmente** una fuente no aportó. Es el arreglo, no un efecto colateral. Se documenta en el JSDoc de `routes/discover.ts` y en el reporte del 03/08. |
| `page_full` sobre-declara truncamiento (catálogo exactamente del tamaño del cap) | B | B | Sobre-declarar es el lado seguro; la evidencia `cursor` es exacta y tiene precedencia. `T-TRUNC-04` fija que no hay falso positivo por debajo del cap. |
| Colisión de merge con **WKH-313** (`wt-313`) sobre `discovery.ts` y `types/index.ts` | **A** | M | CD-18: bloques disjuntos + campos nuevos en vez de extender `excluded`. Coordinar el orden de merge con el orquestador. |
| Ship de A sin B ⇒ producción empieza a reportar `partial` en cada `/compose`/`/orchestrate` | A | B | **Es el objetivo**: hace visible un defecto que hoy es mudo. El default (DT-10) garantiza que nada se rompe mientras tanto. |
| La migración no se aplica a bdwv ⇒ el corte B no surte efecto | M | M | Falla segura: sin `maxLimit` el código es inerte y el sistema queda como con A solo (honesto). Verificable en F4 con `GET /registries` (el `schema` viaja en `RegistryPublic`). |
| Doble/triple fetch del pool en modo estricto (preHandler + resolver + service) | M | B | Es **pre-pago** y sólo para quien opta por el modo. Declarado como TD-318-3. |

**Dependencias**: ninguna bloqueante. El corte A no depende de nada; B depende de
A sólo por orden de merge (no técnicamente); W4 depende de A.

**Deuda declarada**

- **TD-318-1** — Circuit breaker: mover el `throw` del `!response.ok` dentro de
  `cb.execute` para que un no-2xx sostenido abra el circuito. Requiere medir el
  efecto sobre requests pagas en modo estricto (DT-13).
- **TD-318-2** — Paginación por `next_cursor`. Hoy el camino sin `limit` muestra
  **20 de 22** (medido) y lo declara `truncated`. Vuelve a ser urgente cuando el
  catálogo federado supere 100.
- **TD-318-3** — Threading del `DiscoveryResult` del preHandler al service para
  evitar el re-fetch del pool en modo estricto.
- **HU sugerida (otro repo, otro escritor)** — subir el cap de `limit` en
  `wasiai-v2` (`route.ts:99-108`) y/o exponer `/api/v1/capabilities/legacy`.
  **No es dependencia de esta HU**: con el clamp declarado, un cap más alto del
  otro lado sólo permitiría subir un número en una fila de la DB, sin deploy.

---

## 9. Missing Inputs / Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante |
|---|---|---|---|
| resuelto | DT-7 | Mecanismo del corte B: techo declarado por registro | No |
| resuelto | DT-10/DT-11 | Qué hacen `/compose` y `/orchestrate` con pool parcial: default degrada + opt-in estricto que rechaza sin cobrar | No |
| resuelto | §3.3(b) | Cuántos agentes tiene la tabla `agents` de v2: **22 activos**; el camino sin `limit` muestra 20 | No |
| resuelto | §3.2 | Medición cruzada `capabilities`/`minReputation` × `limit` (PRE-fix) | No |
| **[NEEDS CLARIFICATION]** | — | **Tarea #86** (0.14 USDC cobrados sin pago al agente): consistente con este defecto, **no confirmada**. Requiere trazar ese `orchestrationId`. **No bloquea**: el work-item ya la puso en Scope OUT y ningún AC depende de ella. | No |
| **[DECIDE FOUNDER]** | DT-6 | ¿`sources`/`catalogStatus` se documentan como **contrato público** a los colaboradores del 03/08, o quedan como observabilidad? El diseño los emite igual; la pregunta es sólo si se prometen estables. Recomendación: **públicos**, porque el valor de la honestidad es que alguien la lea. | No |
| **no pude determinarlo** | — | Si el `total: 23` histórico de producción coincidió alguna vez con el catálogo real de v2 (haría falta historial de la tabla `agents`, y esta fase es sólo lectura sobre superficies HTTP). | No |
| **no pude determinarlo** | — | Cuántos integradores externos leen hoy el campo `registries` de `/discover`. No hay telemetría por-campo. Mitigado por conservar tipo y nombre. | No |

---

## 10. Plan de implementación (Waves)

> **Corte A = W0 + W1 + W2. Es entregable, mergeable y desplegable solo.**

| Wave | Serial? | Archivos | Sale con |
|---|---|---|---|
| **W0** — contratos | **SERIAL** (bloquea todo) | `src/types/index.ts`, `src/lib/discovery-sources.ts` (nuevo) | tipos + módulo leaf + sus unit tests puros |
| **W1** — corte A: honestidad | tras W0 | `src/services/discovery.ts` (fanout, `queryRegistry`, `:481`), `src/routes/discover.ts` (JSDoc), `src/routes/capabilities.ts` | `T-SRC-01..07` |
| **W2** — corte A′: truncamiento | tras W1 | `src/services/discovery.ts` (detección), migración (`nextCursorPath`) | `T-TRUNC-01..05` |
| — | | **← CORTE A COMPLETO. Se puede parar acá y shipear.** | |
| **W3** — corte B: clamp | tras W2 | `src/services/discovery.ts` (`:591-596`), migración (`maxLimit: 100`) | `T-CLAMP-01..06` |
| **W4** — money-path estricto | tras W3 (paralelizable con W3 salvo `T-CLAMP-06`) | `src/services/compose.ts`, `src/routes/compose.ts`, `src/services/orchestrate.ts`, `src/routes/orchestrate.ts` | `T-STRICT-01..08`, `T-ORCH-RETRY` |

Orden justificado: A antes que B porque A hace **auto-detectable** cualquier
regresión de B (si el clamp se rompe, `catalogStatus` lo grita). W4 después de
W3 porque `requireCompleteCatalog: true` sólo es una opción **usable** cuando el
catálogo completo es alcanzable; antes de W3, todo caller estricto sería
rechazado siempre.

---

## 11. Readiness Check

- [x] Todos los paths citados verificados con Read/Glob/Grep. Cero paths inventados.
- [x] Stack respetado: Fastify + TypeScript strict, sin dependencias nuevas, sin `any`.
- [x] CD-1 … CD-7 del work-item heredadas literalmente; CD-8 … CD-18 agregadas.
- [x] Los 8 AC del work-item mapeados a ≥1 test; AC-9/AC-10 nuevos también.
- [x] Cada test de selección de agentes o de dinero trae su **mutante** nominado (M1 … M25).
- [x] Auto-Blindaje histórico leído (208, 209, 201) y convertido en CD-9 … CD-12.
- [x] Corte A entregable por separado y **primero**; el corte se sostiene (§10).
- [x] Punto exacto de corte sin cobrar identificado y verificado en el código (DT-11), no asumido.
- [x] Colisión con WKH-313 verificada leyendo su SDD, no inferida (CD-18).
- [x] Sin `[NEEDS CLARIFICATION]` bloqueantes: el único abierto (tarea #86) ya estaba en Scope OUT.
- [x] Un escritor por repo: `wasiai-v2` sólo se leyó (CD-3/CD-16).

---

*SDD generado por NexusAgil — FULL*
