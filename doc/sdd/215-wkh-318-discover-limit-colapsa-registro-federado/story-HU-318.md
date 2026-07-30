# Story File — HU-318 / WKH-318

> `limit` colapsa el registro federado — y la respuesta lo niega

| Campo | Valor |
|---|---|
| **HU** | WKH-318 (#215) |
| **Gate** | `SPEC_APPROVED` — 2026-07-30 |
| **SDD** | `doc/sdd/215-wkh-318-discover-limit-colapsa-registro-federado/sdd.md` |
| **Worktree** | `/home/ferdev/.openclaw/workspace/wt-318` (**trabajar SOLO acá**) |
| **Rama** | `feat/215-wkh-318-discover-limit-federado` |
| **Repo** | `wasiai-a2a` únicamente. `wasiai-v2` se LEE, nunca se escribe. |
| **Waves** | W0 → W1 → W2 (**= CORTE A, shippeable**) → W3 → W4 |

**Este archivo es el contrato completo. No hace falta abrir el SDD.** Todo path,
número de línea y snippet de acá fue verificado con `Read` contra el árbol de
`wt-318` el 2026-07-30. Si un número de línea no coincide, **rebasaste o mergeaste
algo**: leé §10 (orden de merge) antes de tocar nada.

---

## ⚠️ ENMIENDA DE F3 — el cuarto estado (`unverified`)

> **Escrita por el Dev al cerrar el corte A, después del fix-pack del AR.** Sin
> esto, F4 lee el contrato viejo y reporta un drift que no existe.

El AR marcó **BLQ-1**: `state: 'ok'` cargaba dos semánticas incompatibles —
*"respondió y trajo todo"* y *"respondió y no tengo forma de saber si trajo
todo"*— y elegía la primera. **Era el caso de producción**, no un borde: el
registro real se siembra sin `nextCursorPath`
(`20260401000000_kite_registries.sql:44-66`) y `/capabilities` llama a
`discover({})` sin `limit`, así que no se manda `limitParam`. Repro del AR: 20
filas **con `next_cursor` seteado** devolvían `{"state":"ok",
"catalogStatus":"complete"}` — o sea, el corte A **cambiaba una mentira por
otra**, que es textualmente lo que prohíbe la no-negociable §2.5.

**Enmienda**: `ok` deja de ser el default y pasa a ganarse con **evidencia
positiva** de completitud. Aparece un cuarto valor, `unverified`, en
`DiscoverySourceState` **y** en `CatalogStatus`.

| Antes (este archivo, W0.1/W0.2) | Ahora (código en el árbol) |
|---|---|
| `state: ok \| truncated \| failed` | `state: ok \| truncated \| **unverified** \| failed` |
| `catalogStatus: complete \| truncated \| partial` | `catalogStatus: complete \| **unverified** \| truncated \| partial` |
| precedencia `partial > truncated > complete` | `partial > truncated > **unverified** > complete` |

**El contrato vigente vive en el código**, no acá: `src/types/index.ts:405-478`
(los tipos y el porqué de cada estado) y `src/routes/discover.ts:82-99` (el
contrato público de la respuesta). Ante cualquier diferencia entre este archivo y
esos dos, **mandan esos dos**.

Los cuatro puntos de este story file que quedaron stale están corregidos **in
situ** y marcados `ENMIENDA F3`: §2.2, W1.4, W1.6 y TD-318-2. Los tests, mutantes
y evidencia del cambio están en `mutation-log.md` (M26, M29) y en
`auto-blindaje.md` (la entrada de BLQ-1).

---

## 1. El problema, y los datos que no se pueden perder

Pedimos 200 agentes al registro federado `WasiAI`, ese registro corta en 100 y
devuelve **HTTP 400**, el fanout se traga el error con `.catch(() => [])`, **y la
respuesta sigue afirmando que consultamos los dos registros**.

Medido contra `https://wasiai-a2a-production.up.railway.app` el 2026-07-30:

| Request | `total` | `agents` | `registries` |
|---|---|---|---|
| `/discover` | 23 | 23 | `["WasiAI","self-published"]`, `excluded: {"scope":0}` |
| `/discover?limit=5` | **3** | 3 | `["WasiAI","self-published"]` ← **la mentira** |
| `/discover?limit=50` | **3** | 3 | idem |
| `/discover?limit=100` | **3** | 3 | idem |
| `/discover?limit=200` | **3** | 3 | idem |
| `/discover?capabilities=remit.quote&limit=10` | 0 | 0 | idem |
| `/discover?minReputation=0&limit=10` | **3** | 3 | idem |

**Los 3 que sobreviven son EXACTAMENTE los 3 self-published**:
`remit-kyc-validator`, `remit-corridor-fx-solana`, `remit-cashout-payout-solana`.
Los otros 20 son del registro `WasiAI`.

> **Por eso Chaski sigue funcionando: sus tres agentes son justo los
> sobrevivientes. Es coincidencia afortunada, no diseño.** Este dato manda sobre
> el default de W4 (§8, DT-10): un rechazo incondicional tumbaría hoy mismo una
> orquestación que funciona.

`/compose` y `/orchestrate` pasan `limit` internamente
(`compose.ts:136`, `orchestrate.ts:560`), así que **la orquestación viene
eligiendo entre 3 agentes creyendo elegir entre 23**.

**Dato medido por el architect, NO re-verificado por el orquestador** (ese
endpoint pide credencial): la tabla `agents` de `wasiai-v2` tiene **22 activos**,
y el camino sin `limit` devuelve **20 con `next_cursor` seteado**. O sea: el
catálogo real es mayor que 23 y **hay agentes que nadie ve, ni siquiera hoy sin
`limit`**. Tratalo como hipótesis fuerte, no como hecho verificado dos veces —
pero **no lo ignores**: es la razón por la que la detección de truncamiento entra
en el corte A.

---

## 2. Las decisiones que NO se renegocian

Si el código te empuja a cambiar una de éstas, **parás y escalás**. No las
reinterpretes.

1. **`registries` conserva tipo y nombre** (`string[]`). Lo único que cambia es
   **cómo se calcula**: de "los registros configurados" a "las fuentes que
   aportaron filas". En el camino sano el valor es **byte-idéntico** al de hoy.
2. **La degradación viaja en campos NUEVOS**: `sources[]` con
   `state: ok|truncated|unverified|failed` y `rows: number|null`, más el roll-up
   `catalogStatus: complete|unverified|truncated|partial`.
   > **ENMIENDA F3 (BLQ-1)**: acá decía tres estados y un roll-up de tres. Son
   > **cuatro** de cada lado. `unverified` = *respondió, pero no hay forma de
   > saber si trajo todo*, y es el estado del caso de producción. `ok` exige
   > evidencia positiva de completitud; sin ella no se declara. Precedencia del
   > roll-up: `partial > truncated > unverified > complete`.
3. **`null` NO es `0`.** `rows: 0` significa *le pregunté y no tiene*.
   `rows: null` significa *no pude preguntarle*. Colapsarlos es el bug que esta
   HU existe para matar.
4. **El camino sano queda byte-idéntico.** Sin `limit` del caller no se manda
   ningún parámetro nuevo upstream. Sin `maxLimit` declarado no hay clamp.
5. **Detectar truncamiento entra en el corte A**, aunque paginar de verdad quede
   afuera. Razón, textual:
   > **Sin detectar truncamiento, el corte A cambiaría una mentira por otra**
   > (`catalogStatus: 'complete'` sobre 20 de 22).
6. **Pool parcial: el default sirve y declara.** El opt-in
   `requireCompleteCatalog: true` a nivel request ⇒ **rechazo sin débito neto en
   dos capas** (pre-pago, y TOCTOU post-débito con reembolso **antes del primer
   `invokeAgent`**).
7. **Los mutantes del rechazo asertan SALDO, no status.** Un test que sólo mira
   el código HTTP no prueba que no se cobró.
8. **Circuit breaker y paginación quedan FUERA** — TD-318-1 y TD-318-2 (§11).

---

## 3. Constraint Directives (heredadas del work-item y del SDD)

| CD | Tipo | Qué dice |
|---|---|---|
| **CD-1** | OBLIG. | El pool de `/compose` no puede achicarse. Todo cambio que toque el tamaño del candidate-set necesita el test de dinero (`T-CLAMP-04`). |
| **CD-2** | PROHIB. | Cambiar el ranking (verified-first → reputación desc → precio asc → tiebreak). |
| **CD-3** | PROHIB. | Escribir en `wasiai-v2`. Se lee, no se toca. Incluye subirle el cap de 100. |
| **CD-4** | OBLIG. | Un registro caído **no tumba** `/discover`: los agentes de las fuentes sanas se devuelven igual, HTTP 200. |
| **CD-5** | OBLIG. | El camino **sin** `limit` no cambia lo que envía upstream. |
| **CD-6** | OBLIG. | Los self-published entran por el mismo pipeline (mismo shape) que los federados. |
| **CD-7** | OBLIG. | **Un guard no se compara consigo mismo.** El test de honestidad tiene que asertar contra una cantidad de ORIGEN DISTINTO al cálculo que vigila (`T-SRC-07`). |
| **CD-8** | OBLIG. | El clamp de `maxLimit` **sólo** puede vivir dentro del gate `query.limit && schema.limitParam` que ya existe (`discovery.ts:591`). |
| **CD-9** | OBLIG. | Todo test que afirme "no se cobró" **asserta el saldo** (o el nº de llamadas al débito), nunca sólo el status code. |
| **CD-10** | OBLIG. | Toda afirmación de "no agrega costo" se asserta **como costo**: número exacto de llamadas de I/O, no ausencia de efecto. |
| **CD-11** | OBLIG. | **Una sola expresión** para "el catálogo está completo": `isCatalogComplete()` en `lib/discovery-sources.ts`. Prohibido que el preHandler, el service y el planner la deriven cada uno por su cuenta. |
| **CD-12** | OBLIG. | Disciplina de mutación de §9. Un KILLED sin prueba de que el mutante aterrizó **y compiló** no cuenta. |
| **CD-13** | PROHIB. | Que `catalogStatus` ausente/`undefined` se lea como completo. El lector es **fail-closed**. |
| **CD-14** | PROHIB. | Colapsar `failed` con `rows: 0`. |
| **CD-15** | PROHIB. | Que el rechazo por catálogo incompleto reutilice el mensaje o el código de "no hay agentes" (`no_agents` / `no_agent_match`). |
| **CD-16** | OBLIG. | Un escritor por repo. Sólo `wt-318`. |
| **CD-17** | PROHIB. | Tocar la columna `auth` de `registries`, o cualquier base que no sea **bdwv**. La migración es un `UPDATE` sobre `schema->'discovery'` y nada más. **La tabla `registries` guarda credenciales en esa columna: nunca imprimas ni devuelvas sus valores.** |
| **CD-18** | OBLIG. | Coordinación con WKH-313 y WKH-315: ver §10. Esta HU **no toca** `src/lib/discovery-query.ts`, `src/lib/compose-step-shape.ts`, `src/services/capability-resolver.ts`, el bloque `minReputation` de `discovery.ts:422-428`, ni el campo `DiscoveryResult.excluded`. |

---

## 4. Anti-Hallucination Checklist (específico de esta HU)

Antes de escribir una línea, marcá cada casilla. Todo lo de la derecha está
**verificado** en `wt-318` al 2026-07-30.

- [ ] `src/services/discovery.ts` tiene **851 líneas**. El fanout está en
      **273-297**, `contributingRegistries` en **481-484**, el `return` del
      pipeline en **486-502**, `queryRegistry` en **559-648**, el gate del
      `limit` en **591-596**, el `throw` del `!response.ok` en **631-633**, el
      `return []` del payload no-array en **642-644**.
- [ ] `src/lib/discovery-fetch-limit.ts` exporta **exactamente dos** funciones:
      `resolveUpstreamFetchLimit(pageLimit)` y `resolveComposeAgentPoolLimit()`.
      No inventes una tercera ahí.
- [ ] `DiscoveryResult` vive en `src/types/index.ts:376-388` y hoy tiene
      **3 campos requeridos** (`agents`, `total`, `registries`) + `excluded?`.
- [ ] `RegistrySchema.discovery` vive en `src/types/index.ts:130-145` y hoy tiene
      6 claves, **todas opcionales**.
- [ ] `OrchestratePlanStatus` vive en `src/types/index.ts:814-819` y hoy tiene
      **5 miembros**.
- [ ] `getNestedValue(obj, path)` ya existe en `src/services/discovery.ts:777-784`
      y soporta paths con punto. **No escribas otro.**
- [ ] `SSRFViolationError` (`src/lib/url-validator.ts:58-70`) y `CircuitOpenError`
      (`src/lib/circuit-breaker.ts:21-27`) **ambas setean `this.name`**. Eso es lo
      que permite clasificarlas desde un módulo leaf sin importarlas.
- [ ] `refundComposeStep0(request, alreadySpentUsd)` ya existe en
      `src/routes/compose.ts:532`. **Reusala, no escribas otro refund.**
- [ ] La rama `if (!result.success)` de `routes/compose.ts:989-1028` **ya llama a
      `refundComposeStep0`** y **ya mapea `errorCode` → status** (1009-1014). El
      layer 2 se engancha ahí; no armes un camino nuevo.
- [ ] `markSkipMiddlewareDebitHandler` (`routes/orchestrate.ts:142`) hace que
      `/orchestrate` **no debite en el middleware**. El débito real vive en
      `executeApprovedPlan`. Por eso un early-return en `planOrchestration` es
      **cero débito por construcción**.
- [ ] Los schemas de body de `/orchestrate`, `/orchestrate/plan` y
      `/orchestrate/execute` **NO declaran `additionalProperties: false`**
      (verificado con grep). Igual **declarás** `requireCompleteCatalog` como
      `{ type: 'boolean' }` para que un string sea 400 en el borde.
- [ ] El registro real `wasiai` se siembra en
      `supabase/migrations/20260401000000_kite_registries.sql:28-70`:
      `limitParam: "limit"`, `agentsPath: "agents"`, `auth {type:header,
      key:x-agent-key}`. **La columna `auth` no se toca (CD-17).**
- [ ] El exemplar de tests es `src/services/discovery.limit.test.ts` (211
      líneas). El bloque de mocks está en **20-62** y el helper que **captura los
      `limit` enviados upstream** en **96-110**. Copialos, no los reinventes.
- [ ] `npx tsc --noEmit` corre limpio **hoy**, antes de que toques nada.
      Verificalo primero: si ya está roto, es de otra rama y hay que avisar.

---

## 5. Scope

### IN — archivos que esta HU toca (lista exhaustiva)

**Producción**
1. `src/types/index.ts` — tipos nuevos + 3 extensiones.
2. `src/lib/discovery-sources.ts` — **NUEVO**, módulo leaf.
3. `src/services/discovery.ts` — fanout, `queryRegistry`, cálculo de `registries`, clamp.
4. `src/routes/discover.ts` — **sólo JSDoc** (71-77). Cero lógica.
5. `src/routes/capabilities.ts` — 2 campos aditivos en el payload.
6. `src/services/compose.ts` — pool devuelve el `DiscoveryResult`, guard layer 2.
7. `src/routes/compose.ts` — body, preHandler layer 1, mapeo a 503.
8. `src/services/orchestrate.ts` — early-return `catalog_incomplete`, propagación.
9. `src/routes/orchestrate.ts` — schema + propagación en 3 rutas.

**Migraciones** (bdwv únicamente)
10. `supabase/migrations/20260730010000_wkh318_registry_next_cursor_path.sql` + `_down.sql` (W2, corte A)
11. `supabase/migrations/20260730020000_wkh318_registry_max_limit.sql` + `_down.sql` (W3, corte B)

> **Corrección al SDD**, aplicada acá: el SDD nombra `2026073000000_registry_max_limit.sql`
> — **13 dígitos** (la convención del repo son 14) y colisiona con el prefijo
> `20260730000000_wkh307_*` que ya existe. Se usan los dos nombres de arriba, uno
> por corte, para que el corte A sea desplegable **sin** la migración del corte B.

**Tests**
12. `src/lib/discovery-sources.test.ts` — NUEVO
13. `src/services/discovery.sources.test.ts` — NUEVO
14. `src/services/discovery.truncation.test.ts` — NUEVO
15. `src/routes/compose.catalog-strict.test.ts` — NUEVO
16. `src/services/discovery.limit.test.ts` — extender
17. `src/services/compose.discovery-pool.test.ts` — extender
18. `src/services/orchestrate.test.ts` — extender
19. `src/routes/capabilities.inbound-chains.test.ts` — extender
20. **Los ~61 sitios de fixtures** que construyen un `DiscoveryResult` literal (W0.3).

### OUT — no lo hagas aunque te tiente

- Modificar `wasiai-v2` (CD-3), incluido subirle el cap de 100.
- Cambiar la semántica del circuit breaker (TD-318-1).
- Implementar paginación por `next_cursor` (TD-318-2).
- Reapuntar el `discoveryEndpoint` del registro `WasiAI`.
- Tocar el ranking, el filtro de scope de HU-208, o el residual TD-189-1.
- Mainnet. Devnet/testnet únicamente.
- `requireCompleteCatalog` en `/discover` (ese endpoint no cobra; su obligación
  es decir la verdad, y con `catalogStatus` la dice).
- La tarea #86.

---

## 6. Waves

Orden **estrictamente serial**: W0 → W1 → W2 → W3 → W4. No arranques una wave sin
el criterio de terminado de la anterior en verde.

---

### W0 — Contratos (SERIAL, bloquea todo)

**Archivos**: `src/types/index.ts`, `src/lib/discovery-sources.ts` (nuevo),
`src/lib/discovery-sources.test.ts` (nuevo), + los ~61 fixtures de W0.3.

#### W0.1 — Tipos nuevos en `src/types/index.ts`

**Dónde**: insertá el bloque **inmediatamente antes** de
`export interface DiscoveryResult {` (línea **376**), después del `}` que cierra
`DiscoveryQuery` (línea 374) y su línea en blanco (375).

> ⚠️ Esa posición no es cosmética: es el **hueco** entre los dos hunks que
> WKH-313 edita en este archivo (§10). Ponerlo en otro lado te garantiza un
> conflicto de merge.

**Después** (agregar):

> ⚠️ **ENMIENDA F3 (BLQ-1) — este bloque quedó viejo.** `DiscoverySourceState`
> tiene **cuatro** miembros (`ok | truncated | unverified | failed`) y
> `CatalogStatus` también (`complete | unverified | truncated | partial`). El
> bloque de abajo es el que se escribió en W0; el vigente está en
> `src/types/index.ts:405-478`, con el docstring que explica qué prueba cada
> estado. **Copiá de ahí, no de acá.**

```ts
// ============================================================
// WKH-318 — HONESTIDAD DEL CATÁLOGO FEDERADO
// ============================================================

/**
 * Tres estados por fuente. Un booleano ya habría perdido el tercero, que es
 * justo el que esta HU existe para no perder.
 */
export type DiscoverySourceState =
  | 'ok' // respondió, y lo que trajo es todo lo que tiene para esta query
  | 'truncated' // respondió, pero hay más filas que NO trajimos
  | 'failed'; // NO se la pudo consultar

export type DiscoverySourceFailure =
  | 'http_error'
  | 'timeout'
  | 'ssrf_blocked'
  | 'circuit_open'
  | 'bad_payload'
  | 'unknown';

export interface DiscoverySource {
  name: string;
  state: DiscoverySourceState;
  /**
   * Filas que la fuente aportó al conjunto candidato, ANTES de los filtros
   * locales (status/verified/caps/free-text/maxPrice/scope/minReputation).
   *
   * `null` cuando `state === 'failed'` — NUNCA 0 (CD-14). Un 0 significa "le
   * pregunté y no tiene"; `null` significa "no pude preguntarle".
   *
   * POR QUÉ PRE-FILTRO: medido en producción, `?capabilities=remit.quote&limit=10`
   * devuelve 0 agentes con las dos fuentes sanas. Si "aportó" se contara
   * post-filtro, una query selectiva reportaría fuentes desaparecidas y el
   * caller leería degradación donde sólo hubo un filtro.
   */
  rows: number | null;
  /** Sólo cuando `state === 'failed'`. */
  failure?: DiscoverySourceFailure;
  /** Sólo cuando `state === 'truncated'`. `cursor` es exacta; `page_full` es heurística. */
  truncationEvidence?: 'cursor' | 'page_full';
}

/** Roll-up de request. Mismo triplete, un nivel más arriba. */
export type CatalogStatus = 'complete' | 'truncated' | 'partial';

/** Referencia mínima de una fuente caída, para los cuerpos de error del money-path. */
export interface FailedSourceRef {
  name: string;
  failure: DiscoverySourceFailure;
}

/**
 * Lo que `queryRegistry` devuelve ahora. Antes devolvía `Agent[]` y toda la
 * información sobre CÓMO le fue a la fuente se perdía en el `.catch(() => [])`
 * del fanout.
 */
export interface RegistryFetchOutcome {
  agents: Agent[];
  state: DiscoverySourceState;
  rows: number | null;
  failure?: DiscoverySourceFailure;
  truncationEvidence?: 'cursor' | 'page_full';
}
```

#### W0.2 — Extensiones a tipos existentes

**(a) `DiscoveryResult` — `src/types/index.ts:376-388`**

**Antes** (líneas 376-379):
```ts
export interface DiscoveryResult {
  agents: Agent[];
  total: number;
  registries: string[];
```

**Después**:
```ts
export interface DiscoveryResult {
  agents: Agent[];
  total: number;
  /**
   * WKH-318: las fuentes que **aportaron filas** al conjunto candidato, NO las
   * fuentes configuradas. El tipo y el nombre no cambian; en el camino sano el
   * valor es byte-idéntico al de antes de esta HU. Sólo se acorta cuando una
   * fuente realmente no aportó nada.
   */
  registries: string[];
  /** WKH-318: estado POR FUENTE. Requerido: ningún constructor puede omitirlo. */
  sources: DiscoverySource[];
  /**
   * WKH-318: roll-up. Precedencia `partial` > `truncated` > `complete`.
   * Sin registros habilitados (sólo self-published) ⇒ `complete`: no hay nada
   * que haya fallado.
   */
  catalogStatus: CatalogStatus;
```

> ⛔ **NO toques `excluded`** — ni su docstring, ni su tipo. Es la línea que
> WKH-313 está reescribiendo (§10). Los dos campos nuevos van **arriba** de
> `excluded`, pegados a `registries`.

> **Por qué requeridos y no opcionales**: es el mismo recurso que
> `RegistryPublic.authConfigured` (`types/index.ts:127`) — garantía de
> compilación de que ningún constructor de `DiscoveryResult` puede omitirlos.
> Tiene un costo, y está presupuestado en W0.3.

**(b) `RegistrySchema.discovery` — `src/types/index.ts:130-145`**

**Antes** (líneas 143-145):
```ts
    /** Field mappings for agent object */
    agentMapping?: AgentFieldMapping;
  };
```

**Después**:
```ts
    /** Field mappings for agent object */
    agentMapping?: AgentFieldMapping;
    /**
     * WKH-318: techo de `limit` que este registro acepta, DECLARADO por el
     * registrante. Cuando está, `queryRegistry` envía
     * `min(over-fetch, maxLimit)`. **Ausente ⇒ comportamiento byte-idéntico al
     * de antes de esta HU** (el código es inerte sin la migración: falla en la
     * dirección segura).
     */
    maxLimit?: number;
    /**
     * WKH-318: path (dot-notation, `getNestedValue`) al cursor de paginación en
     * la respuesta del registro. Cuando está declarado Y llega no-nulo, la
     * fuente se reporta `truncated` con evidencia `cursor` (exacta). No se
     * pagina (TD-318-2): se DETECTA.
     */
    nextCursorPath?: string;
  };
```

**(c) `OrchestratePlanStatus` — `src/types/index.ts:814-819`**

**Antes**:
```ts
export type OrchestratePlanStatus =
  | 'ready'
  | 'insufficient_funds'
  | 'no_agents'
  | 'budget_exhausted'
  | 'no_relevant_agent';
```

**Después**:
```ts
export type OrchestratePlanStatus =
  | 'ready'
  | 'insufficient_funds'
  | 'no_agents'
  /**
   * WKH-318: NO se colapsa con `no_agents`. `no_agents` = *pregunté y no hay*;
   * `catalog_incomplete` = *no pude preguntar*, y el caller pidió
   * explícitamente un catálogo completo (CD-15).
   */
  | 'catalog_incomplete'
  | 'budget_exhausted'
  | 'no_relevant_agent';
```

**(d)** En `OrchestratePlanResult` (`types/index.ts:822+`) y en `OrchestrateResult`,
agregá `failedSources?: FailedSourceRef[];` (opcional, aditivo).
En `ComposeRequest` (`types/index.ts:510+`) agregá:
```ts
  /**
   * WKH-318: el caller declara su tolerancia a un catálogo parcial. `true` ⇒ si
   * el catálogo no es `complete`, se aborta ANTES del primer `invokeAgent` y el
   * route reembolsa el step-0. Ausente/`false` ⇒ comportamiento de hoy.
   */
  requireCompleteCatalog?: boolean | undefined;
```
En `ComposeResult` agregá `failedSources?: FailedSourceRef[];` y
`catalogStatus?: CatalogStatus;` (opcionales).
En `OrchestrateRequest` (`types/index.ts:754+`) agregá
`requireCompleteCatalog?: boolean | undefined;`.

#### W0.3 — El costo de los campos requeridos (NO lo descubras a mitad de W1)

Hacer `sources` y `catalogStatus` **requeridos** rompe `tsc` en todo fixture que
construya un `DiscoveryResult` literal. **Medido: ~61 sitios en 17 archivos.**

Enumeralos con:

```bash
cd /home/ferdev/.openclaw/workspace/wt-318 && npx tsc --noEmit 2>&1 | grep -E "sources|catalogStatus" | head -80
```

Los mayores concentradores (medido con un scan de literales `{agents, total,
registries}`): `src/services/orchestrate.test.ts` (31),
`src/services/capability-resolver.test.ts` (7),
`src/services/compose.chain-flow.test.ts` (6),
`src/__tests__/e2e/setup.ts:67` (1, **crítico**: lo comparten varias suites e2e).

**Parche mecánico**, idéntico en todos: agregar a cada literal

```ts
  sources: [],
  catalogStatus: 'complete',
```

⛔ **PROHIBIDO** resolverlo con `as any`, `as DiscoveryResult`, `@ts-expect-error`
o volviendo los campos opcionales. Ese atajo tira a la basura la única garantía
que estos campos requeridos compran. Este archivo ya pagó dos veces por un export
nuevo que quedó `undefined` en mocks (12 y 84 tests rotos — ver el docstring de
`lib/discovery-fetch-limit.ts:1-11`).

**Excepción única y explícita**: los tests que prueban el lector **fail-closed**
(`T-STRICT-05`) SÍ necesitan un `DiscoveryResult` sin `catalogStatus`. Ahí, y sólo
ahí, se usa un cast local con comentario:
```ts
// T-STRICT-05: simula una respuesta PREVIA a WKH-318 (sin catalogStatus).
// El lector es fail-closed (CD-13): sin dato, en modo estricto se rechaza.
const legacy = { agents: [], total: 0, registries: [] } as unknown as DiscoveryResult;
```

#### W0.4 — `src/lib/discovery-sources.ts` (NUEVO, módulo LEAF)

**Por qué leaf** (cero imports de runtime, sólo `import type`): lo consumen
`routes/compose.ts` y `services/compose.ts`, y media docena de suites mockean
`services/discovery.js` **completo** con factories sin `importOriginal`. Un export
nuevo del service quedaría `undefined` ahí. Mismo razonamiento, verbatim, que
`lib/discovery-fetch-limit.ts:1-11`.

```ts
/**
 * WKH-318 — el vocabulario de la honestidad del catálogo.
 *
 * Módulo LEAF: CERO imports de runtime (sólo `import type`). Ver el docstring de
 * `discovery-fetch-limit.ts:1-11` — `routes/compose.ts` y `services/compose.ts`
 * necesitan estas funciones, y media docena de suites mockean
 * `../services/discovery.js` COMPLETO con factories sin `importOriginal`, así que
 * un export nuevo del service quedaría `undefined` ahí.
 */
import type {
  CatalogStatus,
  DiscoverySource,
  DiscoverySourceFailure,
  FailedSourceRef,
} from '../types/index.js';

/**
 * Error de un registro que respondió con un status no-2xx.
 *
 * Existe para que el fanout pueda clasificar `http_error` sin parsear el mensaje.
 * El `message` se mantiene BYTE-IDÉNTICO al `Error` genérico que había antes
 * (`Registry ${name} returned ${status}`) para no romper ningún test que lo asserte.
 *
 * ⚠️ Se sigue tirando FUERA de `cb.execute` (`discovery.ts:631`). Esta HU NO
 * cambia la semántica del circuit breaker — ver TD-318-1.
 */
export class RegistryHttpError extends Error {
  public readonly status: number;
  constructor(registryName: string, status: number) {
    super(`Registry ${registryName} returned ${status}`);
    this.name = 'RegistryHttpError';
    this.status = status;
  }
}

/**
 * Roll-up. Precedencia: `partial` > `truncated` > `complete`.
 *
 * Sin fuentes (ningún registro habilitado, sólo self-published) ⇒ `complete`:
 * no hay nada que haya fallado. Eso NO es una suposición optimista — es que el
 * conjunto de cosas que podrían haber fallado está vacío.
 */
export function buildCatalogStatus(
  sources: readonly DiscoverySource[],
): CatalogStatus {
  if (sources.some((s) => s.state === 'failed')) return 'partial';
  if (sources.some((s) => s.state === 'truncated')) return 'truncated';
  return 'complete';
}

/**
 * Clasifica el motivo por el que no se pudo consultar una fuente.
 *
 * Se clasifica por `err.name` y NO por `instanceof`, a propósito: importar
 * `url-validator.js` o `circuit-breaker.js` acá rompería la propiedad de módulo
 * leaf. Las dos clases setean `this.name` en su constructor
 * (`url-validator.ts:65`, `circuit-breaker.ts:27`), así que el nombre es
 * estructuralmente confiable.
 *
 * Default `'unknown'`: un motivo que no reconocemos sigue siendo un FALLO. Nunca
 * degrada a `ok`.
 */
export function classifyFetchFailure(err: unknown): DiscoverySourceFailure {
  if (!(err instanceof Error)) return 'unknown';
  switch (err.name) {
    case 'SSRFViolationError':
      return 'ssrf_blocked';
    case 'CircuitOpenError':
      return 'circuit_open';
    case 'RegistryHttpError':
      return 'http_error';
    case 'AbortError':
    case 'TimeoutError':
      return 'timeout';
    default:
      return 'unknown';
  }
}

/**
 * LA ÚNICA expresión de "el catálogo está completo" (CD-11).
 *
 * FAIL-CLOSED (CD-13): `undefined` NO es completo. Una respuesta previa a esta
 * HU, o un mock que no setea el campo, se lee como *no sé* — y en modo estricto
 * *no sé* se rechaza. Escribir `!== 'partial'` acá reintroduce exactamente el bug
 * que esta HU mata.
 */
export function isCatalogComplete(
  result: { catalogStatus?: CatalogStatus } | null | undefined,
): boolean {
  return result?.catalogStatus === 'complete';
}

/** Proyección mínima de las fuentes caídas, para los cuerpos de error del money-path. */
export function listFailedSources(
  sources: readonly DiscoverySource[],
): FailedSourceRef[] {
  return sources
    .filter((s) => s.state === 'failed')
    .map((s) => ({ name: s.name, failure: s.failure ?? 'unknown' }));
}

/**
 * Mensaje del rechazo. Nombra la FUENTE y el MOTIVO, y nunca dice "no agents"
 * (CD-15): el motivo es *no pude preguntar*, no *pregunté y no hay*.
 */
export function describeIncompleteCatalog(failed: readonly FailedSourceRef[]): string {
  if (failed.length === 0) {
    return 'The agent catalog is incomplete (a source returned a truncated page) and this request asked for a complete one';
  }
  const list = failed.map((f) => `'${f.name}' (${f.failure})`).join(', ');
  return `Could not query registry ${list}; the agent catalog is incomplete and this request asked for a complete one`;
}
```

#### W0.5 — Tests de W0 (`src/lib/discovery-sources.test.ts`)

Módulo puro, sin mocks. Cubrir:

| Test | Qué fija |
|---|---|
| `T-LIB-01` | `buildCatalogStatus([])` ⇒ `'complete'` |
| `T-LIB-02` | precedencia: `[ok, truncated, failed]` ⇒ `'partial'`; `[ok, truncated]` ⇒ `'truncated'`; `[ok, ok]` ⇒ `'complete'` |
| `T-LIB-03` | `classifyFetchFailure` para las 5 clases nombradas + un `Error` desconocido ⇒ `'unknown'` + un no-Error (`'boom'`, `null`) ⇒ `'unknown'` |
| `T-LIB-04` | **fail-closed**: `isCatalogComplete(undefined)`, `isCatalogComplete(null)`, `isCatalogComplete({})` ⇒ **los tres `false`**; sólo `{catalogStatus:'complete'}` ⇒ `true` |
| `T-LIB-05` | `describeIncompleteCatalog` **contiene** el nombre de la fuente y el motivo, y **no contiene** `'no agent'` (case-insensitive) |
| `T-LIB-06` | `new RegistryHttpError('WasiAI', 400).message === "Registry WasiAI returned 400"` (byte-idéntico al mensaje previo) |

**Criterio de terminado de W0** (los tres, en este orden):
```bash
cd /home/ferdev/.openclaw/workspace/wt-318
npx tsc --noEmit                                  # limpio, CERO errores
npx vitest run src/lib/discovery-sources.test.ts  # verde
npx vitest run                                    # suite completa verde (W0.3 hecho)
```
> `npx tsc --noEmit` **completo**, no `npm run build`. `tsconfig.build.json`
> excluye tests; un `npm run build` verde con la suite rota ya pasó en este repo
> (lección WKH-196).

---

### W1 — Corte A: honestidad

**Archivos**: `src/services/discovery.ts`, `src/routes/capabilities.ts`,
`src/routes/discover.ts` (JSDoc), `src/services/discovery.sources.test.ts` (nuevo).

#### W1.1 — `queryRegistry` devuelve un outcome, no un array

**`src/services/discovery.ts:559-563`**

**Antes**:
```ts
  async queryRegistry(
    registry: RegistryConfig,
    query: DiscoveryQuery,
    skipUpstreamQuery = false,
  ): Promise<Agent[]> {
```

**Después**:
```ts
  async queryRegistry(
    registry: RegistryConfig,
    query: DiscoveryQuery,
    skipUpstreamQuery = false,
  ): Promise<RegistryFetchOutcome> {
```

**`src/services/discovery.ts:631-633`** — el `throw` se tipa, la semántica NO cambia.

**Antes**:
```ts
    if (!response.ok) {
      throw new Error(`Registry ${registry.name} returned ${response.status}`);
    }
```

**Después**:
```ts
    // WKH-318: mismo `throw`, mismo mensaje, MISMO LUGAR (fuera de `cb.execute`).
    // Sólo gana un `name` para que el fanout pueda clasificarlo como
    // `http_error` sin parsear texto. La semántica del circuit breaker NO cambia
    // en esta HU (TD-318-1): un 400 sostenido sigue sin abrir nada.
    if (!response.ok) {
      throw new RegistryHttpError(registry.name, response.status);
    }
```

**`src/services/discovery.ts:642-647`** — el payload no-array deja de ser un éxito vacío.

**Antes**:
```ts
    if (!Array.isArray(agentsData)) {
      return [];
    }

    // Map to standard Agent format
    return agentsData.map((raw) => this.mapAgent(registry, raw));
```

**Después**:
```ts
    // WKH-318 (CD-14): un payload que no es un array NO es "le pregunté y no
    // tiene". Es "respondió algo que no entiendo" ⇒ `failed` / `rows: null`.
    // Antes esto devolvía `[]` y era indistinguible de un catálogo vacío.
    if (!Array.isArray(agentsData)) {
      return {
        agents: [],
        state: 'failed',
        rows: null,
        failure: 'bad_payload',
      };
    }

    const agents = agentsData.map((raw) => this.mapAgent(registry, raw));
    // W2 reemplaza este bloque por la detección de truncamiento.
    return { agents, state: 'ok', rows: agents.length };
```

Importá arriba (`discovery.ts:12` está el import análogo del otro leaf):
```ts
import {
  buildCatalogStatus,
  classifyFetchFailure,
  RegistryHttpError,
} from '../lib/discovery-sources.js';
```
y agregá a los `import type` de la línea 24-30: `DiscoverySource`,
`RegistryFetchOutcome`.

#### W1.2 — El fanout construye outcomes, no arrays vacíos

**`src/services/discovery.ts:273-297`**

**Antes**:
```ts
    // Query all registries in parallel
    const results = await Promise.all(
      registries.map((registry) =>
        this.queryRegistry(registry, query, skipUpstreamQuery).catch((err) => {
          // TD-sprint-security MNR-5: SSRF violations are config issues,
          // not transient errors — log them with a distinct prefix so
          // operators can grep for misconfigured registry endpoints.
          if (err instanceof SSRFViolationError) {
            log.error(
              {
                registry: registry.name,
                category: err.category,
                reason: err.reason,
              },
              'SSRF blocked',
            );
          } else {
            log.error(
              { registry: registry.name, detail: err.message },
              'Error querying registry',
            );
          }
          return [] as Agent[];
        }),
      ),
    );
```

**Después**:
```ts
    // Query all registries in parallel
    const outcomes = await Promise.all(
      registries.map((registry) =>
        this.queryRegistry(registry, query, skipUpstreamQuery)
          .then((outcome) => ({ registry, outcome }))
          .catch((err) => {
            // TD-sprint-security MNR-5: SSRF violations are config issues,
            // not transient errors — log them with a distinct prefix so
            // operators can grep for misconfigured registry endpoints.
            if (err instanceof SSRFViolationError) {
              log.error(
                {
                  registry: registry.name,
                  category: err.category,
                  reason: err.reason,
                },
                'SSRF blocked',
              );
            } else {
              log.error(
                { registry: registry.name, detail: err.message },
                'Error querying registry',
              );
            }
            // WKH-318: el fallo deja de ser MUDO. Antes se degradaba a `[]` y la
            // respuesta seguía afirmando que este registro contribuyó — el bug
            // de esta HU. Ahora viaja como `failed`/`rows:null` hasta el caller,
            // y además queda un warn estructurado grepeable.
            const failure = classifyFetchFailure(err);
            log.warn(
              {
                error_code: 'REGISTRY_SOURCE_FAILED',
                registry: registry.name,
                failure,
              },
              '[discovery.source-failed] a registry could not be queried; the catalog is partial',
            );
            // CD-4: la excepción se sigue degradando — un registro caído NO
            // tumba /discover. Lo que cambia es que ahora se DECLARA.
            const outcome: RegistryFetchOutcome = {
              agents: [],
              state: 'failed',
              rows: null,
              failure,
            };
            return { registry, outcome };
          }),
      ),
    );
```

Y el merge, **líneas 299-301**:

**Antes**:
```ts
    // Merge results — los locales entran ANTES del pipeline común
    // (status/verified/caps/price/rep/sort/limit) → mismo shape (CD-6).
    let allAgents = [...results.flat(), ...localAgents];
```

**Después**:
```ts
    // Merge results — los locales entran ANTES del pipeline común
    // (status/verified/caps/price/rep/sort/limit) → mismo shape (CD-6).
    let allAgents = [
      ...outcomes.flatMap((o) => o.outcome.agents),
      ...localAgents,
    ];
```

#### W1.3 — `registries` se calcula desde los outcomes

**`src/services/discovery.ts:481-484`**

**Antes**:
```ts
    const contributingRegistries = registries.map((r) => r.name);
    if (localAgents.length > 0) {
      contributingRegistries.push(SELF_PUBLISHED_REGISTRY_NAME);
    }
```

**Después**:
```ts
    // ── WKH-318: `registries` = las fuentes que APORTARON FILAS ────────────
    //
    // Antes era `registries.map(r => r.name)`: la lista de fuentes CONFIGURADAS.
    // Una fuente que devolvía 400 y se degradaba a `[]` aparecía igual — la
    // respuesta afirmaba haberla consultado. Medido en producción: `?limit=50`
    // devolvía 3 agentes (los 3 self-published) y `["WasiAI","self-published"]`.
    //
    // "Aportó filas" = filas DEVUELTAS POR EL FETCH, antes de los filtros
    // locales. Es, literalmente, la misma regla que las líneas de abajo ya
    // aplicaban SÓLO a los self-published: acá se generaliza, no se inventa una
    // segunda. Contarlo post-filtro haría que una query selectiva
    // (`?capabilities=remit.quote`, medida: 0 agentes) reportara fuentes
    // desaparecidas y el caller leyera degradación donde sólo hubo un filtro.
    const sources: DiscoverySource[] = outcomes.map(({ registry, outcome }) => {
      const source: DiscoverySource = {
        name: registry.name,
        state: outcome.state,
        rows: outcome.rows,
      };
      if (outcome.failure) source.failure = outcome.failure;
      if (outcome.truncationEvidence) {
        source.truncationEvidence = outcome.truncationEvidence;
      }
      return source;
    });
    if (localAgents.length > 0) {
      sources.push({
        name: SELF_PUBLISHED_REGISTRY_NAME,
        state: 'ok',
        rows: localAgents.length,
      });
    }

    const contributingRegistries = sources
      .filter((s) => (s.rows ?? 0) > 0)
      .map((s) => s.name);
```

> ⚠️ El `.filter((s) => (s.rows ?? 0) > 0)` es **el** cambio de comportamiento de
> W1. Un `rows: 0` legítimo (le pregunté, no tiene) tampoco aparece en
> `registries` — eso es correcto y `T-SRC-02` lo fija: si no aportó filas, no
> contribuyó. Su estado sigue siendo visible y distinguible en `sources`.

**`src/services/discovery.ts:486-502`** — el `return` del pipeline.

**Antes** (extracto relevante, líneas 494-501):
```ts
      total: allAgents.length,
      registries: contributingRegistries,
      // HU-208: cuántos candidatos descartó el filtro de candidatura. ...
      excluded: { scope: excludedByScope },
```

**Después**:
```ts
      total: allAgents.length,
      registries: contributingRegistries,
      // WKH-318: el detalle POR FUENTE y su roll-up. Aditivos: no se quita ni se
      // re-tipa ningún campo previo.
      sources,
      catalogStatus: buildCatalogStatus(sources),
      // HU-208: cuántos candidatos descartó el filtro de candidatura. ...
      excluded: { scope: excludedByScope },
```

> ⛔ Insertá los dos campos **entre `registries:` y el comentario de `excluded`**,
> y no toques la línea `excluded:` ni su comentario. Es el punto de roce exacto
> con WKH-313 (§10).

#### W1.4 — El early-return de `discover()` también construye el shape

**`src/services/discovery.ts:220-223`**

**Antes**:
```ts
    // NO early-return si solo hay locales (sin registries habilitados).
    if (registries.length === 0 && localAgents.length === 0) {
      return { agents: [], total: 0, registries: [] };
    }
```

**Después**:
```ts
    // NO early-return si solo hay locales (sin registries habilitados).
    if (registries.length === 0 && localAgents.length === 0) {
      // WKH-318: `complete`, no `partial`. No hay fuentes ⇒ no hay nada que haya
      // fallado. "No tengo a quién preguntarle" no es "no pude preguntar".
      return {
        agents: [],
        total: 0,
        registries: [],
        sources: [],
        catalogStatus: 'complete',
      };
    }
```

> **ENMIENDA F3 (CR MNR-A + AR BLQ-2)**: el early-return **ya no escribe el
> literal `'complete'`**. Dos cosas cambiaron:
>
> 1. El roll-up lo calcula `buildCatalogStatus(sources)`. Un literal acá era una
>    **segunda expresión de la misma regla** (CD-11 aplicado al productor en vez
>    del lector), y era la única línea de producción nueva sin cobertura: si
>    alguien cambiaba la regla en el leaf, esta copia seguía devolviendo lo viejo
>    por un camino que ningún test recorría.
> 2. Esta rama **también se alcanza con la fuente local caída** (SELECT roto + cero
>    registries habilitados), y ahí el catálogo es `partial`, no `complete`. La
>    fila de `self-published` viaja en `sources` aunque no haya traído agentes.
>
> Forma real en el árbol (`src/services/discovery.ts`, buscá
> `const sources = localSource ? [localSource] : []`):
> ```ts
>       const sources = localSource ? [localSource] : [];
>       return {
>         agents: [],
>         total: 0,
>         registries: [],
>         sources,
>         catalogStatus: buildCatalogStatus(sources),
>       };
> ```
> Tests: `T-SRC-12` (local caída ⇒ `partial`) y `T-SRC-13` (ninguna fuente
> consultada ⇒ `complete`). Mutante: **M28**.

#### W1.5 — `/capabilities` deja de replicar la mentira

**`src/routes/capabilities.ts:64-77`**

**Antes**:
```ts
    return reply.send({
      name: card.name,
      ...
      chains,
      agents: discovered.agents,
      agentsTotal: discovered.total,
      registries: discovered.registries,
    });
```

**Después**:
```ts
    return reply.send({
      name: card.name,
      ...
      chains,
      agents: discovered.agents,
      agentsTotal: discovered.total,
      registries: discovered.registries,
      // WKH-318: cambio ADITIVO sobre una respuesta pública — mismo patrón que
      // HU-204 en este archivo (:41-43). Los 11 campos previos quedan intactos,
      // con el mismo nombre y el mismo valor. Esta superficie replicaba el bug:
      // afirmaba haber consultado registros que no habían contestado.
      catalogStatus: discovered.catalogStatus,
      sources: discovered.sources,
    });
```

#### W1.6 — JSDoc del contrato (`src/routes/discover.ts:71-77`)

**Antes**:
```
   * - `registries`: nombres de los registries que contribuyeron.
```

**Después**:
```
   * - `registries`: nombres de las fuentes que APORTARON FILAS. WKH-318: antes
   *   listaba los registries CONFIGURADOS, así que un registro que fallaba
   *   aparecía igual y la respuesta afirmaba haberlo consultado. El tipo
   *   (`string[]`) y el nombre no cambian; el valor sólo se acorta cuando una
   *   fuente realmente no aportó nada.
   * - `sources`: estado POR FUENTE. `state` es `ok` (respondió y trajo todo lo
   *   que tiene para esta query) | `truncated` (respondió, pero hay más filas
   *   que no trajimos) | `failed` (no se la pudo consultar). `rows` son las
   *   filas que aportó ANTES de los filtros locales, y es `null` — no 0 —
   *   cuando `state` es `failed`: 0 significa "le pregunté y no tiene", `null`
   *   significa "no pude preguntarle".
   * - `catalogStatus`: roll-up de la request. `complete` | `truncated` |
   *   `partial`, con precedencia `partial` > `truncated` > `complete`.
```

> **ENMIENDA F3 (BLQ-1)**: este JSDoc documenta **tres** estados y el roll-up de
> tres. En el árbol son **cuatro**, y además `ok` se define distinto: no es
> "respondió y trajo todo", es "respondió **y hay evidencia** de que trajo todo".
> El texto vigente está en `src/routes/discover.ts:82-99` e incluye las dos únicas
> formas de ganar esa evidencia (cursor vacío declarado, o página que no se
> llenó). **No re-escribas el archivo desde este bloque**: quedó viejo.

**Cero cambios de lógica en este archivo.**

#### W1.7 — Tests de W1 (`src/services/discovery.sources.test.ts`, nuevo)

Copiá el bloque de mocks de `src/services/discovery.limit.test.ts:20-62` y el
helper de captura de `:96-110`.

| Test | Qué fija | AC | Mutante que lo mata |
|---|---|---|---|
| `T-SRC-01` | fuente que responde **500** ⇒ `sources[0]` es `failed`/`rows:null`/`failure:'http_error'`, `registries` **no** la lista, `catalogStatus === 'partial'` | AC-3, AC-4 | **M1** |
| `T-SRC-02` | fuente que responde 200 con `[]` ⇒ `state:'ok'`, **`rows: 0`** (no `null`), `catalogStatus:'complete'`, y **no** aparece en `registries` | AC-4 | **M2** |
| `T-SRC-03` | 2 fuentes, una cae ⇒ los agentes de la sana se devuelven igual y `discover()` **resuelve** (no rechaza) | AC-3, CD-4 | **M3** |
| `T-SRC-04` | clasificación del motivo, 5 casos: `http_error` (500), `bad_payload` (200 con `{}`), `timeout` (`AbortError`), `ssrf_blocked` (`SSRFViolationError`), `circuit_open` (`CircuitOpenError` desde el mock del breaker) | AC-3 | **M4** |
| `T-SRC-05` | happy path ⇒ `registries` **byte-idéntico** al de hoy (`toEqual(['test-registry'])`) y `catalogStatus:'complete'` | AC-1 | **M1**, **M2b** |
| `T-SRC-06` | `/capabilities` expone `catalogStatus`+`sources` y **conserva los 11 campos previos** con el mismo nombre y valor (assert campo por campo, no `toMatchObject` laxo) | AC-4 | **M5** |
| `T-SRC-07` | **CD-7 — el guard no se compara consigo mismo**: 2 registros habilitados, **1 falla** ⇒ `sources.length === 2`, exactamente uno con `state:'failed'`, **y `registries.length === 1`**. Si el cálculo saliera de la lista de configurados, `registries.length` sería 2 | AC-4, CD-7 | **M1** |

**Mutantes de W1** (definición exacta para §9):

| # | Mutación |
|---|---|
| **M1** | Volver a `const contributingRegistries = registries.map((r) => r.name);` (el código de hoy, `:481`) |
| **M2** | En el fanout `.catch`, devolver `rows: 0` en vez de `rows: null` |
| **M2b** | Cambiar el filtro a `(s.rows ?? 0) >= 0` (off-by-one: incluye fuentes que no aportaron) |
| **M3** | Quitar el `.catch` del fanout (propagar la excepción) |
| **M4** | En `queryRegistry`, devolver `{agents: [], state:'ok', rows: 0}` para el payload no-array |
| **M5** | Quitar `registries` del payload de `/capabilities` |

**Criterio de terminado de W1**:
```bash
cd /home/ferdev/.openclaw/workspace/wt-318
npx tsc --noEmit
npx vitest run src/services/discovery.sources.test.ts src/routes/capabilities.inbound-chains.test.ts
npx vitest run src/services/discovery.test.ts src/services/discovery.limit.test.ts \
              src/services/discovery.selfpublished.test.ts src/services/discovery.capability-filters.test.ts
npx vitest run   # suite completa verde
```

---

### W2 — Corte A′: truncamiento  ⟵ **acá termina el CORTE A**

**Archivos**: `src/services/discovery.ts` (detección),
`supabase/migrations/20260730010000_wkh318_registry_next_cursor_path.sql` (+ `_down`),
`src/services/discovery.truncation.test.ts` (nuevo).

#### W2.1 — Detección en `queryRegistry`

Reemplazá el bloque final que W1.1 dejó (`return { agents, state: 'ok', rows: agents.length };`):

> ⚠️ **ENMIENDA F3 (BLQ-1) — el bloque de abajo quedó viejo en dos cosas.** El
> vigente está en `src/services/discovery.ts` (buscá
> `la completitud se PRUEBA, no se supone`):
> 1. **El fallback ya no es `ok`.** Se busca evidencia para los DOS lados y el
>    return final es `state: completenessProven ? 'ok' : 'unverified'`. El
>    `return { agents, state: 'ok', ... }` de abajo era el bug de BLQ-1.
> 2. **La lectura del cursor cambió** (AR MNR-G): se usa la veracidad del valor,
>    no `!== null`. Un `0` o un `false` son centinelas de "no hay más", no
>    cursores. Y la clave **ausente** (`undefined`) ya no se lee igual que la
>    clave **vacía**: la vacía DECLARA completitud, la ausente no declara nada.

**Después**:
```ts
    const agents = agentsData.map((raw) => this.mapAgent(registry, raw));

    // ── WKH-318 (DT-8): el truncamiento se DETECTA, no se pagina ───────────
    //
    // Dos evidencias, en este orden de precedencia:
    //
    //  1. `cursor` — EXACTA. El registro declaró `nextCursorPath` y ese campo
    //     llegó no-nulo. Es la que atrapa el caso real medido: v2 tiene 22
    //     agentes activos y el camino sin `limit` devuelve 20 con `next_cursor`
    //     seteado. Sin esta detección, el corte A cambiaría una mentira por otra
    //     (`catalogStatus: 'complete'` sobre 20 de 22).
    //
    //  2. `page_full` — HEURÍSTICA. Se mandó un límite y llegaron EXACTAMENTE
    //     esa cantidad de filas. Su único error posible es sobre-declarar
    //     (catálogo justo del tamaño del cap), y sobre-declarar incompletitud es
    //     el lado SEGURO del error.
    //
    // Sin límite enviado y sin `nextCursorPath` declarado NO hay evidencia, y el
    // estado es `ok`: no se inventa una certeza que no tenemos.
    let truncationEvidence: 'cursor' | 'page_full' | undefined;
    if (schema.nextCursorPath) {
      const cursor = getNestedValue(data, schema.nextCursorPath);
      // `null` explícito y `undefined` NO son evidencia. Que la CLAVE exista con
      // valor nulo es exactamente cómo un registro dice "no hay más".
      if (cursor !== null && cursor !== undefined && cursor !== '') {
        truncationEvidence = 'cursor';
      }
    }
    if (!truncationEvidence && sentLimit !== undefined && agents.length >= sentLimit) {
      truncationEvidence = 'page_full';
    }

    if (truncationEvidence) {
      return {
        agents,
        state: 'truncated',
        rows: agents.length,
        truncationEvidence,
      };
    }
    return { agents, state: 'ok', rows: agents.length };
```

Para que `sentLimit` exista, **el gate del límite (`:591-596`) captura el número
que efectivamente se envió**:

**Antes** (`discovery.ts:591-596`):
```ts
    if (query.limit && schema.limitParam) {
      url.searchParams.set(
        schema.limitParam,
        resolveUpstreamFetchLimit(query.limit).toString(),
      );
    }
```

**Después** (W2 — el clamp llega recién en W3):
```ts
    // WKH-318: el límite EFECTIVAMENTE enviado, para poder detectar `page_full`.
    // `undefined` ⇒ no se mandó ninguno (camino sin `limit` del caller, CD-5/CD-8).
    let sentLimit: number | undefined;
    if (query.limit && schema.limitParam) {
      sentLimit = resolveUpstreamFetchLimit(query.limit);
      url.searchParams.set(schema.limitParam, sentLimit.toString());
    }
```

> ⛔ **CD-8/CD-5**: `sentLimit` queda `undefined` en el camino sin `limit`. Nada
> nuevo se envía upstream ahí. `T-TRUNC-05` lo canda asertando **los parámetros
> capturados**, no el resultado.

#### W2.2 — Migración (corte A)

`supabase/migrations/20260730010000_wkh318_registry_next_cursor_path.sql`:

```sql
-- WKH-318 (W2 / corte A): declarar dónde vive el cursor de paginación del
-- registro `wasiai`, para poder DETECTAR truncamiento. No se pagina (TD-318-2).
--
-- Medido 2026-07-30: la tabla `agents` de wasiai-v2 tiene 22 activos y el camino
-- sin `limit` devuelve 20 con `next_cursor` seteado. Sin esta clave, /discover
-- seguiría afirmando completitud sobre una página truncada.
--
-- ⚠️ UPDATE ADITIVO sobre `schema->'discovery'`. La columna `auth` NO se toca
-- (CD-17): borrar esa credencial reabre la recursión a2a → v2 → a2a.
-- Aplicar SOLO a bdwv.
UPDATE registries
SET schema = jsonb_set(
      schema,
      '{discovery,nextCursorPath}',
      '"next_cursor"'::jsonb,
      true
    )
WHERE id = 'wasiai'
  AND schema -> 'discovery' IS NOT NULL;
```

`..._down.sql`:
```sql
UPDATE registries
SET schema = jsonb_set(
      schema,
      '{discovery}',
      (schema -> 'discovery') - 'nextCursorPath'
    )
WHERE id = 'wasiai'
  AND schema -> 'discovery' IS NOT NULL;
```

> **No la apliques vos.** La aplicación a bdwv la coordina el orquestador. El
> código es **inerte** sin ella (sin `nextCursorPath` no hay evidencia `cursor`),
> así que la wave se valida entera con tests.

#### W2.3 — Tests de W2 (`src/services/discovery.truncation.test.ts`, nuevo)

| Test | Qué fija | AC | Mutante |
|---|---|---|---|
| `T-TRUNC-01` | `nextCursorPath:'next_cursor'` declarado + payload con `next_cursor: 'abc'` ⇒ `state:'truncated'`, `truncationEvidence:'cursor'`, `catalogStatus:'truncated'` | AC-4 | **M6** |
| `T-TRUNC-02` | mismo schema, `next_cursor: null` ⇒ `state:'ok'` (no sobre-declara). Repetir con la clave **ausente** y con `''` | AC-4 | **M7** |
| `T-TRUNC-03` | sin `nextCursorPath`, `rows === sentLimit` (200 filas con over-fetch 200) ⇒ `truncated`/`page_full` | AC-4 | **M8** |
| `T-TRUNC-04` | `rows < sentLimit` ⇒ `ok`. Sin falso positivo por debajo del cap | AC-4 | **M9** |
| `T-TRUNC-05` | **camino SIN `limit`**: `upstreamLimits` capturados `=== [null]` (no se envía ningún parámetro nuevo) **y** sin cursor declarado el estado es `ok` | **AC-7**, CD-5, CD-8 | **M10** |
| `T-TRUNC-06` | precedencia: cursor no-nulo **y** página llena ⇒ `truncationEvidence === 'cursor'` (la exacta gana) | AC-4 | **M6** |

**Mutantes de W2**:

| # | Mutación |
|---|---|
| **M6** | Ignorar el cursor (borrar el bloque `if (schema.nextCursorPath)`) |
| **M7** | Tratar la **presencia de la clave** como evidencia (`if (schema.nextCursorPath && 'next_cursor' in data)`) |
| **M8** | `agents.length > sentLimit` en vez de `>=` |
| **M9** | Marcar `truncated` siempre que `sentLimit !== undefined` |
| **M10** | Mover el cálculo de `sentLimit` fuera del gate (enviar `limitParam` también sin `limit` del caller) |

**Criterio de terminado de W2**:
```bash
cd /home/ferdev/.openclaw/workspace/wt-318
npx tsc --noEmit
npx vitest run src/services/discovery.truncation.test.ts src/services/discovery.sources.test.ts
npx vitest run
```

---

## ▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜
## ▌  ⛳ FIN DEL CORTE A — W0 + W1 + W2                                  ▐
## ▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟

**Acá se puede parar, mergear y desplegar.** El corte A:

- **No cambia qué agentes vuelven.** Cero riesgo sobre el money-path.
- Hace que la respuesta deje de afirmar más de lo que la evidencia sostiene.
- **Hace auto-detectable cualquier regresión del corte B**: si el clamp de W3 se
  rompe, `catalogStatus` lo grita desde un `GET` gratuito.
- Efecto esperado inmediato en producción: `/discover?limit=N` seguirá devolviendo
  3 agentes, **pero** con `registries: ["self-published"]`,
  `catalogStatus: "partial"` y `sources[0] = {name:"WasiAI", state:"failed",
  rows:null, failure:"http_error"}`. Eso **es el objetivo**: hacer visible un
  defecto que hoy es mudo.

**Commit sugerido al cerrar el corte A**, antes de arrancar W3:
`fix(318): /discover deja de afirmar que consultó un registro que no contestó (corte A)`

---

### W3 — Corte B: clamp

**Archivos**: `src/services/discovery.ts:591-596` (el bloque que W2 ya tocó),
`supabase/migrations/20260730020000_wkh318_registry_max_limit.sql` (+ `_down`),
`src/services/discovery.limit.test.ts` (extender),
`src/services/compose.discovery-pool.test.ts` (extender).

#### W3.1 — El clamp

**Antes** (estado post-W2):
```ts
    let sentLimit: number | undefined;
    if (query.limit && schema.limitParam) {
      sentLimit = resolveUpstreamFetchLimit(query.limit);
      url.searchParams.set(schema.limitParam, sentLimit.toString());
    }
```

**Después**:
```ts
    // ── WKH-318 (DT-7): techo DECLARADO por el registro ────────────────────
    //
    // El bug: el over-fetch (200 por default) supera el cap de 100 del registro
    // federado, que responde 400, el fanout se lo traga y quedan sólo los
    // self-published. Medido: `/discover?limit=N` devolvía 3 de 23 para
    // CUALQUIER N, incluso mayor al total.
    //
    // El arreglo NO es quitar el `limit` (PROHIBIDO — ver el docstring de
    // `discovery-fetch-limit.ts:107-111`: el tamaño del pool pasaría a decidirlo
    // el default de paginación del upstream, medido en 20 y fuera de nuestro
    // control). Cada registro DECLARA su techo y nosotros lo respetamos.
    //
    // ⚠️ CD-8: el clamp vive DENTRO del gate `query.limit && schema.limitParam`
    // que ya existía. Sin `limit` del caller no se manda nada, igual que antes.
    // ⚠️ Sin `maxLimit` declarado el código es INERTE: si la migración no se
    // aplica, el comportamiento es byte-idéntico al del corte A. Falla en la
    // dirección segura.
    let sentLimit: number | undefined;
    if (query.limit && schema.limitParam) {
      const overFetch = resolveUpstreamFetchLimit(query.limit);
      sentLimit =
        typeof schema.maxLimit === 'number' &&
        Number.isFinite(schema.maxLimit) &&
        schema.maxLimit > 0
          ? Math.min(overFetch, schema.maxLimit)
          : overFetch;
      url.searchParams.set(schema.limitParam, sentLimit.toString());
    }
```

> **Nota sobre `maxLimit < COMPOSE_POOL_MIN_LIMIT` (50)**: se honra igual. Un
> techo declarado se respeta aunque sea incómodo — ignorarlo devuelve el 400 del
> upstream y **perdemos la fuente entera**, que es exactamente el bug de esta HU.
> La página se llena ⇒ la detección `page_full` de W2 marca la fuente `truncated`
> ⇒ el caller lo sabe. Además emitimos, una vez por fetch:
> ```ts
> if (sentLimit !== undefined && sentLimit < COMPOSE_POOL_MIN_LIMIT_FOR_WARN) {
>   log.warn(
>     { error_code: 'REGISTRY_CAP_BELOW_POOL_FLOOR', registry: registry.name, maxLimit: schema.maxLimit },
>     '[discovery.cap-below-pool-floor] the declared registry cap is below the compose pool floor; the pool for this source is smaller than the historical one',
>   );
> }
> ```
> `COMPOSE_POOL_MIN_LIMIT` es privado de `lib/discovery-fetch-limit.ts`. **No lo
> exportes** para esto: definí la constante del warn en `discovery.ts` como
> `const COMPOSE_POOL_MIN_LIMIT_FOR_WARN = 50;` con un comentario que apunta al
> leaf, o **exportalo** desde el leaf y usalo en los dos lados. **Elegí una y una
> sola** — CD-11: dos expresiones de la misma cantidad divergen (ya costó un cobro
> sin reembolso en este repo).

#### W3.2 — Migración (corte B)

`supabase/migrations/20260730020000_wkh318_registry_max_limit.sql`:
```sql
-- WKH-318 (W3 / corte B): el registro `wasiai` declara su techo de `limit`.
-- Medido 2026-07-30 contra app.wasiai.io/api/v1/capabilities (handler legacy):
--   ?limit=101 y ?limit=200 → HTTP 400 "limit must be between 1 and 100"
--   ?limit=100             → HTTP 200, 22 agentes, next_cursor null
-- Con este techo, el over-fetch de 200 se acota a 100 y la fuente vuelve.
--
-- ⚠️ UPDATE ADITIVO sobre `schema->'discovery'`. La columna `auth` NO se toca
-- (CD-17). Aplicar SOLO a bdwv.
UPDATE registries
SET schema = jsonb_set(schema, '{discovery,maxLimit}', '100'::jsonb, true)
WHERE id = 'wasiai'
  AND schema -> 'discovery' IS NOT NULL;
```
`..._down.sql`: mismo patrón que W2.2, quitando `'maxLimit'`.

#### W3.3 — Tests de W3

En `src/services/discovery.limit.test.ts` (extender; ya tiene `serveHonoringLimit`
que captura los `limit` enviados):

| Test | Qué fija | AC | Mutante |
|---|---|---|---|
| `T-CLAMP-01` | `maxLimit:100` + caller `limit=5` ⇒ `upstreamLimits === ['100']` | AC-1 | **M11** |
| `T-CLAMP-02` | registro **sin** `maxLimit` ⇒ `upstreamLimits === ['200']`, byte-idéntico a hoy | AC-7 | **M12** |
| `T-CLAMP-03` | registro sin `limitParam` ⇒ `upstreamLimits === [null]`, sus agentes entran, `state:'ok'` | **AC-2** | **M13** |
| `T-CLAMP-05` | `maxLimit: 20` (por debajo del piso de pool) ⇒ se honra (`['20']`), la fuente se marca `truncated`/`page_full`, y se emite `REGISTRY_CAP_BELOW_POOL_FLOOR` | CD-1 | **M15** |
| `T-CLAMP-06` | **reproducción del bug de producción**: registro que devuelve **400** ante `limit>100` + 3 locales self-published; con `maxLimit:100` y `limit=5` ⇒ **5 agentes**, `total` = unión pre-limit, `registries` con **las dos** fuentes, `catalogStatus:'complete'`. **Sin** el clamp el mismo test da `total:3` y `catalogStatus:'partial'` | AC-1, AC-3 | **M11** |

En `src/services/compose.discovery-pool.test.ts` (extender):

| Test | Qué fija | AC | Mutante |
|---|---|---|---|
| `T-CLAMP-04` | **el test de dinero (CD-1)**: 2 fuentes, una con `maxLimit:100` sirviendo **60** agentes donde el target es **el último por precio asc**; `resolveComposeAgentPoolLimit()` produce un pool que **CONTIENE al target** y de tamaño **≥ 50**. Assert explícito `pool.some(a => a.slug === TARGET)` | **AC-5** | **M14** |

> Por qué `T-CLAMP-04` es el test de dinero: si el target sale del pool,
> `payment.chain` no se hidrata, el leg downstream se saltea **en silencio**
> (`discovery-fetch-limit.ts:59-71`) y **el agente no se cobra**. Un test que sólo
> mire `pool.length` no lo detecta.

**Mutantes de W3**:

| # | Mutación |
|---|---|
| **M11** | Quitar el `Math.min` (usar siempre `overFetch`) ⇒ upstream recibe 200 |
| **M12** | Default `maxLimit = 100` para todos los registros |
| **M13** | Mover el clamp fuera del gate `schema.limitParam` (enviar el clamp aunque el registro no declare `limitParam`) |
| **M14** | Clampar el pool de compose a 20 (o bajar `COMPOSE_POOL_MIN_LIMIT`) |
| **M15** | Ignorar `maxLimit` cuando es menor que el piso de 50 |

**Criterio de terminado de W3**:
```bash
cd /home/ferdev/.openclaw/workspace/wt-318
npx tsc --noEmit
npx vitest run src/services/discovery.limit.test.ts src/services/compose.discovery-pool.test.ts \
              src/services/discovery.truncation.test.ts src/services/discovery.sources.test.ts
npx vitest run
```

---

### W4 — Money-path estricto

**Archivos**: `src/services/compose.ts`, `src/routes/compose.ts`,
`src/services/orchestrate.ts`, `src/routes/orchestrate.ts`,
`src/routes/compose.catalog-strict.test.ts` (nuevo),
`src/services/orchestrate.test.ts` (extender).

**Por qué W4 va después de W3**: `requireCompleteCatalog: true` sólo es una opción
**usable** cuando el catálogo completo es alcanzable. Antes de W3, todo caller
estricto sería rechazado siempre.

#### W4.1 — El pool de compose devuelve el resultado completo

**`src/services/compose.ts:111-113` y `:134-138` y `:159-169`**

**Antes**:
```ts
interface DiscoverCache {
  all(): Promise<Agent[]>;
}
...
function discoverAgentPool(): Promise<Agent[]> {
  return discoveryService
    .discover({ limit: resolveComposeAgentPoolLimit() })
    .then((r) => r.agents);
}
...
function createDiscoverCache(): DiscoverCache {
  let cached: Promise<Agent[]> | undefined;
  return {
    all() {
      if (!cached) {
        cached = discoverAgentPool();
      }
      return cached;
    },
  };
}
```

**Después**:
```ts
interface DiscoverCache {
  all(): Promise<Agent[]>;
  /** WKH-318: el MISMO fetch memoizado, sin descartar el estado del catálogo. */
  result(): Promise<DiscoveryResult>;
}
...
function discoverAgentPool(): Promise<DiscoveryResult> {
  // WKH-318: ya NO se descarta todo menos `.agents`. El estado del catálogo
  // (`catalogStatus`, `sources`) viaja junto al pool para que el guard del modo
  // estricto lea EXACTAMENTE el mismo fetch que produjo los candidatos — no otro.
  return discoveryService.discover({ limit: resolveComposeAgentPoolLimit() });
}
...
function createDiscoverCache(): DiscoverCache {
  // WKH-318: se memoiza la MISMA Promise del DiscoveryResult, y `all()` se deriva
  // de ella. Dos promesas distintas serían dos fetches distintos, y el guard
  // podría aprobar un catálogo que no es el que alimentó el pool (CD-11).
  let cached: Promise<DiscoveryResult> | undefined;
  const result = (): Promise<DiscoveryResult> => {
    if (!cached) {
      cached = discoverAgentPool();
    }
    return cached;
  };
  return {
    result,
    all: () => result().then((r) => r.agents),
  };
}
```

`resolveAgent` (`:1317-1318`) no cambia: `discoverAll()` sigue devolviendo
`Promise<Agent[]>` vía `discoverCache.all()` / `discoverAgentPool().then(r => r.agents)`.
**Ajustá el fallback sin cache**:
```ts
    const discoverAll = (): Promise<Agent[]> =>
      discoverCache ? discoverCache.all() : discoverAgentPool().then((r) => r.agents);
```

#### W4.2 — Guard layer 2 (TOCTOU) en `executePipeline`

**`src/services/compose.ts:336-342`**

**Antes**:
```ts
    // B7 (audit 2026-06-24): un solo discover() compartido por todo el pipeline.
    const discoverCache = createDiscoverCache();
    for (let i = 0; i < steps.length; i++) {
```

**Después**:
```ts
    // B7 (audit 2026-06-24): un solo discover() compartido por todo el pipeline.
    const discoverCache = createDiscoverCache();

    // ── WKH-318 (DT-11, capa 2): TOCTOU ────────────────────────────────────
    //
    // La capa 1 (el preHandler de la ruta) corre PRE-débito y ya vio el catálogo
    // sano. Entre aquel chequeo y este fetch pasan cientos de ms y son DOS
    // fetches distintos. Sin esta capa, "no se cobra por lo que el caller no
    // aceptó" sería verdad en el caso fácil y falso en el caso real.
    //
    // Corre ANTES del primer `invokeAgent` y antes de cualquier settle: la ruta
    // reembolsa el step-0 al ver este `errorCode` (mismo camino que ya existe
    // para `!result.success`, routes/compose.ts:1004). Débito neto: cero.
    //
    // CD-10: el fetch SÓLO ocurre si el caller optó explícitamente. Sin el flag,
    // este bloque no hace ni una llamada de I/O — el camino de hoy es idéntico.
    if (request.requireCompleteCatalog === true) {
      const catalog = await discoverCache.result();
      // CD-11: UNA sola expresión de "completo", compartida con el preHandler y
      // con el planner. CD-13: fail-closed ante `undefined`.
      if (!isCatalogComplete(catalog)) {
        const failed = listFailedSources(catalog.sources ?? []);
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: 0,
          totalLatencyMs: 0,
          // CD-15: NUNCA el mensaje ni el código de "no hay agentes". El motivo
          // es *no pude preguntar*, no *pregunté y no hay*.
          error: describeIncompleteCatalog(failed),
          errorCode: 'CATALOG_INCOMPLETE',
          catalogStatus: catalog.catalogStatus,
          failedSources: failed,
        };
      }
    }

    for (let i = 0; i < steps.length; i++) {
```

#### W4.3 — `routes/compose.ts`: body, preHandler layer 1, status 503

**(a) `ComposeBody` — `src/routes/compose.ts:107-110`**

**Antes**:
```ts
type ComposeBody = {
  steps: ComposeStep[];
  maxBudget?: number;
};
```
**Después**:
```ts
type ComposeBody = {
  steps: ComposeStep[];
  maxBudget?: number;
  /**
   * WKH-318 (DT-9): la tolerancia la declara EL QUE PAGA, a nivel request.
   *
   * Va en el BODY y no en un header porque en este repo los headers eligen rail
   * de transporte (`x-payment-chain`, :98), no política de facturación. Va a
   * nivel request y no por step porque el fanout a registros corre UNA vez por
   * request (`discovery.ts:273`), no por step.
   *
   * Ausente/`false` ⇒ se sirve con el catálogo disponible y se DECLARA
   * (`catalogStatus`). `true` ⇒ 503 `CATALOG_INCOMPLETE` sin débito neto.
   */
  requireCompleteCatalog?: boolean;
};
```

**(b) preHandler `requireCompleteCatalogHandler`** — definilo junto a
`resolveComposeCapabilitiesHandler` (después de `:374`):

```ts
/**
 * WKH-318 (DT-11, capa 1): rechazo PRE-DÉBITO cuando el caller exigió un catálogo
 * completo y no lo hay.
 *
 * ─── DÓNDE CORRE Y POR QUÉ ──────────────────────────────────────────────
 * DESPUÉS de `validateComposeBodyHandler` (shape) y ANTES de
 * `resolveComposeCapabilitiesHandler` — y por lo tanto antes de
 * `resolveComposePriceHandler` y de `requirePaymentOrA2AKey`. Nada de lo que
 * corre antes del middleware de pago debita ni settlea: acá NUNCA se cobra.
 *
 * Moverlo después de `requirePaymentOrA2AKey` reabre exactamente el agujero
 * HIGH-2 que este archivo ya pagó una vez (:124-128): un rechazo que el caller
 * igual paga.
 *
 * ─── BACK-COMPAT / CD-10 ────────────────────────────────────────────────
 * Sin `requireCompleteCatalog: true` este handler NO hace absolutamente nada:
 * cero discovery, cero queries, cero I/O. Un caller de los de hoy recorre el
 * mismo código que antes de esta HU. `T-STRICT-06` lo asserta contando LLAMADAS,
 * no efectos.
 */
async function requireCompleteCatalogHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as { requireCompleteCatalog?: unknown } | undefined;
  if (body?.requireCompleteCatalog !== true) return;

  const catalog = await discoveryService.discover({
    limit: resolveComposeAgentPoolLimit(),
  });
  // CD-11: la MISMA expresión que usa el service y el planner. CD-13: fail-closed.
  if (isCatalogComplete(catalog)) return;

  const failed = listFailedSources(catalog.sources ?? []);
  // Fastify 5 idiom: `return reply...` aborta el lifecycle de preHandlers ANTES
  // del middleware de débito — el mismo que usa el 503 REGISTRY_UNAVAILABLE
  // (:832-836) y el 422 no_agent_match (:349-356).
  return reply.status(503).send({
    error: describeIncompleteCatalog(failed),   // CD-15: nunca "no agents found"
    error_code: 'CATALOG_INCOMPLETE',
    catalogStatus: catalog.catalogStatus,
    failedSources: failed,
    requestId: request.id,
  });
}
```

Y en la cadena de preHandlers (**`src/routes/compose.ts:856-861`**):

**Antes**:
```ts
        validateComposeBodyHandler,
        // HU-208: resolver las capacidades a agentes concretos ANTES del
        // preHandler de precio ...
        resolveComposeCapabilitiesHandler,
```
**Después**:
```ts
        validateComposeBodyHandler,
        // WKH-318 (DT-11 capa 1): rechazo pre-débito si el caller exigió catálogo
        // completo. No-op cuando no lo exigió (cero I/O).
        requireCompleteCatalogHandler,
        // HU-208: resolver las capacidades a agentes concretos ANTES del
        // preHandler de precio ...
        resolveComposeCapabilitiesHandler,
```

**(c) Mapeo del error de la capa 2 a 503** — `src/routes/compose.ts:1009-1014`

**Antes**:
```ts
        let status = 400;
        if (result.errorCode === 'SCOPE_DENIED') {
          status = 403;
        } else if (result.errorCode === 'DEST_CAP_EXCEEDED') {
          status = 402;
        }
```
**Después**:
```ts
        let status = 400;
        if (result.errorCode === 'SCOPE_DENIED') {
          status = 403;
        } else if (result.errorCode === 'DEST_CAP_EXCEEDED') {
          status = 402;
        } else if (result.errorCode === 'CATALOG_INCOMPLETE') {
          // WKH-318 (capa 2 / TOCTOU): mismo status que el rechazo pre-débito.
          // El `refundComposeStep0(request, result.totalCostUsdc)` de :1004 ya
          // corrió con `totalCostUsdc === 0` (el guard aborta ANTES del primer
          // invokeAgent), así que el débito neto es cero.
          status = 503;
        }
```

> ⚠️ **No agregues un refund nuevo acá.** La rama `!result.success` ya llamó a
> `refundComposeStep0` en `:1004`. Un segundo refund sería un doble crédito.

**(d) Propagar el flag al service** — en la llamada a `composeService.compose`
(`:958-977`), agregá:
```ts
        // WKH-318: la tolerancia declarada por el caller viaja al service, que
        // la hace cumplir en la capa 2 (TOCTOU) antes del primer invokeAgent.
        requireCompleteCatalog: body.requireCompleteCatalog,
```

#### W4.4 — `orchestrate`: early-return `catalog_incomplete`

**`src/services/orchestrate.ts`** — insertá **entre la línea 592** (cierre del
bloque del broaden-retry) **y la línea 594** (`// AC5: No agents found`):

```ts
    // ── WKH-318 (DT-11 capa 1 / DT-12): catálogo incompleto en modo estricto ──
    //
    // VA ANTES del early-return `no_agents`, y el orden importa: si el catálogo
    // está incompleto Y no hay agentes, la verdad es *no pude preguntar*, no
    // *pregunté y no hay*. Colapsarlos sería el bug de esta HU reencarnado un
    // nivel más arriba (CD-15).
    //
    // CERO DÉBITO POR CONSTRUCCIÓN: la ruta marca `skipMiddlewareDebit`
    // (routes/orchestrate.ts:142) y los cuatro sitios de débito del middleware lo
    // respetan (a2a-key.ts:721, 965, 1205, 1321). El débito real vive en
    // `executeApprovedPlan`, que en este camino NO se llama.
    //
    // CD-10: sin el flag, este bloque no hace NADA — ni una llamada extra.
    if (
      request.requireCompleteCatalog === true &&
      !isCatalogComplete(discovered)   // CD-11 / CD-13: única expresión, fail-closed
    ) {
      const failed = listFailedSources(discovered.sources ?? []);
      const incompleteResult: OrchestratePlanResult = {
        orchestrationId,
        planStatus: 'catalog_incomplete',
        steps: [],
        costPerStep: [],
        totalCostUsdc: 0,
        protocolFeeUsdc: 0,
        maxQuotedCostUsdc: 0,
        reasoning: describeIncompleteCatalog(failed),
        consideredAgents: [],
        plannedCostUsd: 0,
        feeUsdc: 0,
        usedFallback: false,
        debitFallback: false,
        billingKeyRow,
        discoveredAgents: [],
        failedSources: failed,
      };

      eventService
        .track({
          eventType: 'orchestrate_goal',
          // `failed`: no se pudo cumplir. Decir `success` acá sería la misma
          // mentira que esta HU vino a matar.
          status: 'failed',
          latencyMs: Date.now() - startTime,
          costUsdc: 0,
          goal,
          metadata: {
            orchestrationId,
            agentCount: discovered.agents.length,
            fallback: false,
            broadenRetryUsed,
            retryAgentCount,
          },
        })
        .catch((err) => log.error({ err }, '[Orchestrate] event tracking failed'));

      return incompleteResult;
    }
```

**`mapPlanEarlyReturnToOrchestrateResult` (`:396-422`)**: `catalog_incomplete`
**NO** entra en la lista de `pipelineSuccess === true` — con el código actual eso
es automático (la lista es `no_agents || budget_exhausted`). **No la toques.**
Sólo agregá el passthrough de `failedSources` junto al de `remainingBudgetUsd`
(`:418-420`):
```ts
    ...(plan.failedSources !== undefined && { failedSources: plan.failedSources }),
```
y **actualizá el comentario `:399-400`** para incluir el nuevo status:
```ts
  // §7: insufficient_funds → false; no_agents → true; budget_exhausted → true;
  // no_relevant_agent → false; WKH-318 catalog_incomplete → false (no se pudo
  // cumplir; decir lo contrario sería el bug de esta HU un nivel más arriba).
```

**Propagación al compose** (`orchestrate.ts:1213-1235`), agregá al objeto:
```ts
      // WKH-318: la tolerancia del caller baja a compose, que la hace cumplir en
      // la capa 2 (TOCTOU) antes del primer invokeAgent.
      requireCompleteCatalog: request.requireCompleteCatalog,
```

#### W4.5 — `routes/orchestrate.ts`: schema y propagación (3 rutas)

En los **tres** schemas de body (`/` en `:117-132`, `/plan` en `:230-245`,
`/execute` en `:417-449`), agregá dentro de `properties`:
```ts
            // WKH-318: la tolerancia del caller a un catálogo parcial. Se declara
            // aunque el schema no use `additionalProperties:false`, para que un
            // valor no booleano sea 400 en el borde y no una verdad accidental.
            requireCompleteCatalog: { type: 'boolean' },
```

En `OrchestrateBody` (`:33-38`) y `OrchestrateExecuteBody` (`:43+`), agregá
`requireCompleteCatalog?: boolean;`.

En las **tres** llamadas al service (la de `/` está en `:160-181`), agregá:
```ts
            // WKH-318: la política de cobro la declara el que paga.
            requireCompleteCatalog: body.requireCompleteCatalog,
```

#### W4.6 — Tests de W4

Archivos: `src/routes/compose.catalog-strict.test.ts` (nuevo),
`src/services/orchestrate.test.ts` (extender).

> **CD-9 — TODOS los tests de rechazo de esta sección asertan SALDO, no status.**
> Un test que sólo mira el 503 no prueba que no se cobró. El patrón obligatorio:
> ```ts
> const before = await getBalanceForTest();
> const res = await app.inject({ method: 'POST', url: '/compose', payload, headers });
> const after = await getBalanceForTest();
> expect(after).toBe(before);            // ← el assert que importa
> expect(res.statusCode).toBe(503);      // ← el que NO alcanza solo
> expect(debitSpy).toHaveBeenCalledTimes(0);
> ```

| Test | Qué fija | AC | Mutante |
|---|---|---|---|
| `T-STRICT-01` | `/orchestrate` + fuente caída + `requireCompleteCatalog:true` ⇒ `planStatus:'catalog_incomplete'`, **saldo final === inicial**, y `executeApprovedPlan` **nunca invocado** (spy con 0 llamadas) | AC-9 | **M16** |
| `T-STRICT-02` | misma fuente caída **SIN** el flag ⇒ `planStatus:'ready'` y **se ejecuta**. Es el test del default (DT-10) y del caso Chaski de §1 | AC-10 | **M17** |
| `T-STRICT-03` | `/compose` + flag + fuente caída ⇒ **503 `CATALOG_INCOMPLETE`**, **saldo intacto**, `composeService.compose` **nunca invocado** | AC-9 | **M18** |
| `T-STRICT-04` | **TOCTOU**: el preHandler ve todo sano, el fetch del service falla ⇒ 503, **saldo de vuelta al inicial** (débito + refund), **cero `invokeAgent`**, **cero settle** | AC-9 | **M19**, **M20** |
| `T-STRICT-05` | `catalogStatus === undefined` (respuesta previa a la HU) + flag ⇒ **rechaza** (fail-closed) | AC-9, CD-13 | **M21** |
| `T-STRICT-06` | **CD-10**: **sin** el flag, el preHandler no hace **ni una** llamada a `discover` — assert sobre `discoverSpy.mock.calls.length` comparado contra la corrida baseline, **no** sobre el efecto | AC-10 | **M22** |
| `T-STRICT-07` | el cuerpo del rechazo **nombra la fuente y el motivo** y **NO** contiene `'no agent'` (case-insensitive), ni `code:'no_agent_match'`, ni `planStatus:'no_agents'` | AC-9, CD-15 | **M23** |
| `T-STRICT-08` | **la distinción**: un agente que falla en ejecución con catálogo `complete` sigue su camino de reembolso actual y **no** produce `CATALOG_INCOMPLETE`. `CATALOG_INCOMPLETE` habla del catálogo, nunca del agente | AC-9 | **M24** |
| `T-ORCH-RETRY` | `/orchestrate`: el **broaden-retry** (`orchestrate.ts:577-580`) usa el mismo conjunto de fuentes sanas que el primer pase y hereda el clamp (assert sobre los `limit` capturados en **las dos** llamadas) | **AC-6** | **M25** |

**Mutantes de W4**:

| # | Mutación |
|---|---|
| **M16** | Mover el chequeo de `planOrchestration` a `executeApprovedPlan` (post-débito) |
| **M17** | Invertir el default (`request.requireCompleteCatalog !== false`) |
| **M18** | Mover `requireCompleteCatalogHandler` **después** de `requirePaymentOrA2AKey` |
| **M19** | Cambiar el nuevo `status = 503` para que caiga en el `else` que no reembolsa (o sacar el `errorCode` para que no entre en la rama `!result.success`) |
| **M20** | Mover el guard de la capa 2 **después** del primer `invokeAgent` (dentro del loop, `i > 0`) |
| **M21** | `isCatalogComplete` ⇒ `result?.catalogStatus !== 'partial'` |
| **M22** | Quitar el gate `body?.requireCompleteCatalog !== true` del preHandler |
| **M23** | Reemplazar `describeIncompleteCatalog` por el mensaje genérico de `no_agents` |
| **M24** | Mapear cualquier fallo de step a `CATALOG_INCOMPLETE` |
| **M25** | Quitar el clamp sólo en el broaden-retry |

**Criterio de terminado de W4**:
```bash
cd /home/ferdev/.openclaw/workspace/wt-318
npx tsc --noEmit
npx vitest run src/routes/compose.catalog-strict.test.ts
npx vitest run src/services/orchestrate.test.ts src/services/orchestrate.billing.test.ts \
              src/services/orchestrate.quote-billing.test.ts src/services/compose.test.ts \
              src/routes/compose.test.ts src/routes/compose.no-charge-on-validation-error.test.ts
npx vitest run   # suite completa verde
```

---

## 7. Mapa AC → test (≥1 por AC)

| AC | Enunciado (abreviado) | Test(s) |
|---|---|---|
| **AC-1** | camino feliz con `limit` | `T-SRC-05`, `T-CLAMP-01`, `T-CLAMP-06` |
| **AC-2** | registro sin `limitParam` | `T-CLAMP-03` |
| **AC-3** | fetch que falla | `T-SRC-01`, `T-SRC-03`, `T-SRC-04`, `T-CLAMP-06` |
| **AC-4** | honestidad de `registries`/`excluded` | `T-SRC-01`, `T-SRC-02`, `T-SRC-06`, `T-SRC-07`, `T-TRUNC-01..04`, `T-TRUNC-06` |
| **AC-5** | pool de `/compose` | `T-CLAMP-04` |
| **AC-6** | `/orchestrate` mismo defecto | `T-ORCH-RETRY` |
| **AC-7** | no-regresión del camino sin `limit` | `T-TRUNC-05`, `T-CLAMP-02` |
| **AC-8** | evidencia contra producción | §8 (no es un test unitario) |
| **AC-9** | rechazo sin débito neto | `T-STRICT-01`, `T-STRICT-03`, `T-STRICT-04`, `T-STRICT-05`, `T-STRICT-07`, `T-STRICT-08` |
| **AC-10** | default sirve parcial, sin I/O extra | `T-STRICT-02`, `T-STRICT-06` |

**Totales**: **6 + 7 + 6 + 6 + 9 = 34 tests nuevos/extendidos**, **25 mutantes**
(M1, M2, M2b, M3…M25).

---

## 8. AC-8 — evidencia contra producción (para F4, no para el Dev)

No es un test unitario. Es el **mismo comando** que produjo la tabla de §1, a
correr **post-deploy** y a comparar contra ella:

```bash
GW=https://wasiai-a2a-production.up.railway.app
python3 -c "
import json, urllib.request as u
for q in ['/discover','/discover?limit=5','/discover?limit=50','/discover?limit=100',
          '/discover?capabilities=remit.quote&limit=10','/discover?minReputation=0&limit=10']:
    d = json.loads(u.urlopen(u.Request('$GW'+q, headers={'User-Agent':'curl/8'})).read())
    print(q, '| total=', d['total'], '| registries=', d.get('registries'),
          '| catalogStatus=', d.get('catalogStatus'), '| sources=', d.get('sources'))
"
```

Post-corte-A esperado: `total` sigue en 3 con `limit`, pero
`registries: ["self-published"]` y `catalogStatus: "partial"`.
Post-corte-B esperado: `total` sube a ~25 y `catalogStatus: "complete"`.

> Sólo GETs públicos. **No** consultes `GET /registries` para "verificar la
> migración" sin confirmar antes con el orquestador: ese endpoint ya expuso una
> credencial (hallazgo abierto de las pruebas profundas 2026-07-26).

---

## 9. Disciplina de mutación (CD-12, obligatoria)

Por **cada** mutante M1…M25:

1. **Árbol limpio** (`git status --short` vacío o sólo con lo ya commiteado).
2. **Respaldo por copia**: `cp src/services/discovery.ts /tmp/claude-*/scratchpad/discovery.ts.bak`
3. Aplicar la mutación.
4. **Probar que aterrizó**: `md5sum` del archivo **distinto** del respaldo. Un
   mutante que no cambió el archivo produce un falso KILLED (lección WKH-307/M12).
5. `npx tsc --noEmit` **completo y limpio**. **Un mutante que no compila NO cuenta
   como KILLED** — hay que reformularlo.
6. Correr la suite. El test nominado debe **fallar**.
7. **Restaurar por `cp`** desde el respaldo y **verificar por hash**.

⛔ **Nunca `git checkout --`** para restaurar: esta HU crea archivos untracked y
ese comando ya borró trabajo sin commitear en este repo (auto-blindaje 203).
⛔ **Nunca** `git reset --hard`, `git clean -fd`, `git stash drop/clear`, `git branch -D`.
⛔ **Nunca** redirijas a un archivo la salida de un comando que lee archivos
(`head`, `cat`, `sed`): el proxy `rtk` trunca y ya escribió
`// ... N lines omitted` **dentro de un fuente**, con exit 0. Usá `Read`/`Write`.

---

## 10. Orden de merge y puntos de roce

**Hay tres HUs en vuelo sobre este repo. No asumas que 318 mergea primero.**

| HU | Rama | Toca |
|---|---|---|
| WKH-313 | `feat/211-wkh-313-primer-trabajo` | `src/services/discovery.ts` (+373), `src/types/index.ts` (+154/−1), `src/routes/discover.ts` (+50), `src/services/reputation.ts`, `src/services/capability-resolver.ts` |
| WKH-315 | `feat/213-wkh-315-deposito-prepago-solana` | `src/adapters/solana/`, `src/routes/auth/`, `src/services/budget.ts`, `src/types/a2a-key.ts` |
| **WKH-318** | `feat/215-wkh-318-discover-limit-federado` | `src/services/discovery.ts`, `src/types/index.ts`, `src/routes/{discover,capabilities,compose,orchestrate}.ts`, `src/services/{compose,orchestrate}.ts` |

**WKH-315 no roza a 318**: cero archivos en común (verificado con `git diff --stat`).

**WKH-313 SÍ roza.** Hunks exactos de 313 (medidos con `git diff -U0 main...`,
numeración de `main`):

| Archivo | Hunks de WKH-313 (líneas de `main`) | Qué toca 318 | Veredicto |
|---|---|---|---|
| `src/types/index.ts` | `292-297`, `321-326`, `352-357`, **`384-390`**, `435-440` | inserta tipos nuevos en **375**, campos nuevos en **379-380**, `maxLimit`/`nextCursorPath` en **143-145**, `catalog_incomplete` en **814-819** | **ROCE en 384-390.** 313 reescribe `excluded?: { scope: number };` (línea **387**) por un objeto de 40 líneas con `reputation`, `trialAvailable`, `standingUnavailable`. **318 NO toca esa línea** — sus campos van pegados a `registries` (379). Los hunks quedan separados por ~4 líneas ⇒ merge limpio esperado, conflicto **posible** si alguien mueve el bloque. |
| `src/services/discovery.ts` | `17-34`, `365-370`, `399-405`, `419-430`, **`498-507`**, `534-556` | `220-223`, **`273-301`**, **`481-502`**, `559-563`, `591-596`, `631-633`, `642-647` | **DOS roces.** (a) 313 reescribe `excluded: { scope: excludedByScope },` (línea **501**) dentro del **mismo `return`** donde 318 inserta `sources` + `catalogStatus`. Por eso 318 los inserta **entre `registries:` (495) y el comentario de `excluded` (496)**: los renglones cambiados no se solapan. (b) el hunk `534-556` de 313 termina en el `/**` del docstring de `queryRegistry` (**556**); el primer cambio de 318 en esa función es la firma (**559**). Separación de 3 líneas. |
| `src/routes/discover.ts` | 15 hunks, de `6` a `168` — incluye **`69-77`** y **`76-78`** | **sólo el JSDoc de 71-77** | **ROCE DIRECTO.** 313 edita el mismo docstring. **Conflicto textual casi seguro.** |

### Si WKH-318 mergea SEGUNDO — qué re-anclar

1. **`types/index.ts` / `DiscoveryResult`**: 313 habrá convertido `excluded` en un
   objeto grande. La resolución es **quedarse con las dos cosas**: el `excluded`
   expandido de 313 **y** los `sources` / `catalogStatus` de 318, éstos últimos
   **arriba**, pegados a `registries`. Nunca metas la degradación **dentro** de
   `excluded` (CD-18) — son ejes distintos: `excluded` cuenta candidatos que un
   **filtro** descartó; `sources` dice si una **fuente** contestó.
2. **`discovery.ts` / el `return` del pipeline**: mismo criterio. El objeto final
   queda `{ agents, total, registries, sources, catalogStatus, excluded: {...} }`.
   El `excluded` es el de 313 completo, sin tocar.
3. **`discovery.ts` / `runDiscoveryPipeline`**: 313 inserta ~180 líneas después de
   la línea 504 y extrae `applyReputationFloor`. **Los cambios de 318 en el fanout
   (273-301) y en el cálculo de `sources` (481-495) siguen siendo válidos tal
   cual**; sólo cambian de número de línea. Re-anclá por el texto
   `const contributingRegistries`, no por número.
4. **`discovery.ts` / `queryRegistry`**: 313 **no la toca** (su último hunk termina
   en la línea 556). Todo lo de 318 ahí (firma, clamp, truncamiento, `throw`,
   payload no-array) entra sin conflicto.
5. **`routes/discover.ts`**: es el único conflicto textual casi seguro, y es **sólo
   JSDoc**. Resolución: conservar **ambos** bloques de documentación. El de 313
   documenta `allowTrial` / `excluded.reputation`; el de 318 documenta
   `registries` (semántica nueva), `sources` y `catalogStatus`. **Cero lógica en
   juego de este lado.**
6. Después de re-anclar: `npx tsc --noEmit` + `npx vitest run` completo, y
   **re-verificá `T-SRC-07`** (el guard de CD-7) — es el test que detecta si el
   cálculo de `registries` volvió a salir de la lista de configurados durante la
   resolución del conflicto.

### Si WKH-318 mergea PRIMERO

Avisale a quien mergee 313 que:
- `DiscoveryResult` ya tiene dos campos nuevos **arriba** de `excluded`;
- el `return` de `runDiscoveryPipeline` ya tiene `sources` y `catalogStatus` entre
  `registries` y `excluded`;
- el JSDoc de `routes/discover.ts` ya creció;
- **el fanout ya no devuelve `Agent[]`**: `queryRegistry` devuelve
  `RegistryFetchOutcome` y `results` pasó a llamarse `outcomes`. Si 313 agregó
  código que lee `results.flat()`, hay que re-anclarlo a
  `outcomes.flatMap((o) => o.outcome.agents)`.

**Recomendación**: mergear **el corte A de 318 primero** (es el cambio más chico y
el que no toca el money-path), o dejar 313 primero y re-anclar 318 con esta guía.
La decisión es del orquestador.

---

## 11. Deuda declarada (escribila en el reporte, no la implementes)

- **TD-318-1 — Circuit breaker.** El `throw` del `!response.ok` sigue **fuera** de
  `cb.execute` (`discovery.ts:631`), así que un 400 sostenido no abre nada.
  Meterlo adentro es una línea, pero cambia el money-path: un registro con 429
  transitorios abriría el circuito para **todas** las requests durante el cooldown
  (30 s, `circuit-breaker.ts:152`) y, bajo `requireCompleteCatalog: true`, eso son
  requests pagas rechazadas por una ráfaga. Merece su propia medición y su propio
  AR. **Lo que esta HU sí cierra**: el fallo deja de ser mudo, por tres vías
  (`sources[].failure`, el `log.warn` con `error_code: 'REGISTRY_SOURCE_FAILED'`, y
  `catalogStatus` observable desde un GET gratis).
- **TD-318-2 — Paginación por `next_cursor`.** El camino **sin** `limit` sigue
  mostrando 20 de 22 (medido por el architect, no re-verificado) — y ahora lo
  **declara** `truncated`. Vuelve a ser urgente cuando el catálogo federado supere 100.
  > **ENMIENDA F3 (BLQ-1)**: lo declara **`unverified`**, no `truncated`, y la
  > diferencia es justamente el punto de la HU. `truncated` afirma *"hay más filas
  > que no trajimos"*; sin `nextCursorPath` aplicado en la DB y sin `limitParam`
  > enviado, eso **no se puede afirmar**: lo único cierto es que no hay forma de
  > saberlo. Una vez aplicada la migración de W2 a bdwv, ese mismo camino pasa a
  > `truncated` con evidencia `cursor` — que es cuando la deuda se vuelve
  > accionable de verdad.
- **TD-318-3 — Threading del `DiscoveryResult`** del preHandler al service, para
  evitar el re-fetch del pool en modo estricto (hoy: preHandler + service = 2
  fetches, **sólo** para quien opta por el modo, y **pre-pago**).
- **HU sugerida (otro repo, otro escritor)** — subir el cap de `limit` en
  `wasiai-v2` (`route.ts:99-108`). **No es dependencia**: con el techo declarado en
  la DB, un cap más alto del otro lado sólo permitiría subir un número en una fila,
  sin deploy.

---

## 12. Done Definition

> **ENMIENDA F3 — alcance de lo entregado.** Esta checklist cubre la HU
> **completa** (W0→W4). Lo entregado y revisado hasta acá es el **CORTE A**
> (W0+W1+W2), que el propio archivo declara mergeable por sí solo (§ banner de
> fin de corte A). Al leerla, F4 debería contar contra el corte A:
>
> | Ítem | Corte A |
> |---|---|
> | 5 waves | **W0, W1, W2** hechas. W3 (clamp) y W4 (money-path estricto) **no empezadas**. |
> | "los 34 tests de §7" | son el total de las 5 waves. El corte A aporta **36**, medidos: 8 (`discovery-sources.test.ts`) + 18 (`discovery.sources.test.ts`) + 9 (`discovery.truncation.test.ts`) + 1 (`T-SRC-06`, en `capabilities.inbound-chains.test.ts`). Coincide con el delta de la suite completa: 4306 → 4342. `T-CLAMP-*` y `T-STRICT-*` son de W3/W4. |
> | "los 25 mutantes M1…M25" | del corte A se corrieron **16/16 KILLED** (M1–M10 + M26–M30, ver `mutation-log.md`). **M11–M25 son de W3/W4**: su código no existe todavía. |
> | "las 4 migraciones" | el corte A escribe **2** (up + down de `nextCursorPath`). Las de `maxLimit` son de W3. **Ninguna aplicada.** |
> | CD-9 / CD-10 (saldo, nº de llamadas) | **N/A en el corte A**: no toca el money-path. Aplican en W4. |
>
> Lo que **sí** se cumple entero en el corte A: `tsc --noEmit` completo en verde,
> suite completa en verde, `isCatalogComplete()` como única expresión de
> completitud, cero `as any`/`@ts-expect-error`, commits por wave sin push ni
> merge, y `auto-blindaje.md` escrito.

La HU está lista para AR cuando **todas** estas se cumplen:

- [ ] Las 5 waves implementadas en el orden W0 → W1 → W2 → W3 → W4.
- [ ] `npx tsc --noEmit` **completo** en verde (no `npm run build`).
- [ ] `npx vitest run` (suite completa) en verde.
- [ ] Los **34 tests** de §7 existen, con los nombres de este archivo.
- [ ] Los **25 mutantes** M1…M25 corridos con la disciplina de §9, cada uno con
      (a) prueba de que aterrizó (hash), (b) `tsc` limpio, (c) el test que lo mata
      nombrado. Un KILLED sin las tres cosas no cuenta.
- [ ] Cada afirmación de "no se cobró" está asertada **sobre el saldo** (CD-9), y
      cada afirmación de "no agrega costo" **sobre el número de llamadas** (CD-10).
- [ ] `isCatalogComplete()` es la **única** expresión de completitud en el repo
      (`grep -rn "catalogStatus ===\|catalogStatus !==" src/` devuelve **sólo**
      `lib/discovery-sources.ts`).
- [ ] Cero `as any`, cero `@ts-expect-error`, cero `any` explícito.
- [ ] Las 4 migraciones (2 up + 2 down) escritas, **no aplicadas** por el Dev.
- [ ] `git status --short` sin archivos inesperados fuera de §5-IN.
- [ ] Commits por wave, en `wt-318`, rama `feat/215-wkh-318-discover-limit-federado`.
      **Sin push, sin merge, sin tocar `main`.**
- [ ] `auto-blindaje.md` escrito en la carpeta de la HU con todo error propio
      cometido durante la implementación (es el insumo de la próxima HU).

---

*Story File generado por NexusAgil — F2.5. Todo path y número de línea verificado
contra `wt-318` el 2026-07-30.*
