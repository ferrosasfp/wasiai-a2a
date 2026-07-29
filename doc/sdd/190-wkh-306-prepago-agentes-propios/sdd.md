# SDD #190 — [WKH-306] Acotar y hacer visible el residuo de pipelines que fallan a mitad de camino

> SPEC_APPROVED: no
> Fecha: 2026-07-28
> Tipo: feature — observabilidad sobre el money-path (NO mueve dinero)
> SDD_MODE: full
> Branch sugerido: `feat/190-wkh-306-visibilidad-pago-stranded`
> Artefactos: `doc/sdd/190-wkh-306-prepago-agentes-propios/`
> Work item: [`work-item.md`](work-item.md) (leer el banner del pivote: **nada de prepago**)
> Depende de: **WKH-305** (`doc/sdd/190-wkh-305-compose-field-mapping/sdd.md`) — merge primero, ver §11

---

## 1. Resumen

Cuando un pipeline de `/compose` falla en el step `i`, el dinero que ya salió
on-chain hacia los agentes de los steps `0..i-1` no vuelve. El gateway **revierte
el débito del caller para el step que falla** (`refundStepDebit`) pero **nada
revierte ni registra** los settles ya ejecutados de los steps anteriores, y la
única evidencia de esos pagos (`StepResult.downstreamTxHash` /
`downstreamSettledAmount`) **muere con la respuesta HTTP**. Hoy no se puede ni
medir cuánto es.

Esta HU **no construye un segundo riel de pago** (ver §5, DT-1: el prepago daría
ventaja estructural a los agentes de la casa, que es exactamente lo que la
neutralidad del marketplace prohíbe). Hace las tres cosas que convierten "asumir
el riesgo" en gestión profesional:

1. **Acotarlo** — la cota deja de ser prosa y pasa a ser una fórmula computable
   derivada de `MAX_COMPOSE_STEPS`, más un techo de exposición por pipeline
   **implementado y probado**, enchufado en el guard de presupuesto que YA
   existe. El techo viaja **apagado por default** y esta HU declara
   explícitamente qué dimensión de la cota queda abierta, por qué, y cuál es el
   gatillo para cerrarla (§4.6).
2. **Hacerlo visible** — un evento durable por run afectado (`compose_stranded_payment`)
   y una lista nueva **anidada dentro de la superficie que el operador ya
   consulta** (`AmbiguousReport.strandedRuns` en `GET /dashboard/api/reconciliation`),
   heredando tal cual las tres invariantes que ese archivo ya tiene candadas:
   `total` exacto, marca de truncamiento, y **tirar ante un error de query en vez
   de devolver `[]`**.
3. **Que no crezca en silencio** — umbral fundamentado sobre la exposición
   acumulada en una ventana, expuesto como un campo booleano ADITIVO en el
   `/health` que el **health-monitor del trípode ya poletea como target P0**
   (`gateway-a2a`), leído con el MISMO mecanismo `degradedPath` que ya usa el
   target del facilitator. Cero canales nuevos, cero crons nuevos, cero código
   nuevo en el monitor: una clave de más en un JSON de env.

La pieza de código no trivial es una sola: **un único punto de estrangulamiento**
en `composeService.compose` que ve el resultado final del pipeline y, si falló
después de que algún step pagó on-chain, deja constancia. No se toca ninguna
decisión de dinero: ni un débito, ni un refund, ni un settle, ni un orden.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 190 (WKH-306) |
| **Tipo** | feature — observabilidad sobre el money-path |
| **SDD_MODE** | full |
| **Objetivo** | Acotar con un número computable, hacer visible en la cola que el operador ya mira, y alertar si crece, el pago on-chain que queda varado cuando un pipeline falla después de haber pagado a agentes previos. |
| **Reglas de negocio** | Todos los agentes cobran por llamada, propios y de terceros, sin excepción (DT-1/CD-1). Superficie de SOLO LECTURA: nada se reembolsa, reclama ni compensa automáticamente. |
| **Scope IN / OUT** | §10 |
| **Missing Inputs** | Los 3 del work-item quedan **RESUELTOS** en §11. Cero pendientes de negocio. |

### 2.1 ACs heredados del work-item (EARS)

- **AC-1** — the system SHALL exponer una cota máxima de exposición económica por
  pipeline VERIFICABLE por código (derivada de `MAX_COMPOSE_STEPS` y del techo de
  precio que F2 determine), no un número estimado a mano en un documento.
- **AC-2** — WHEN un pipeline de `/compose` falla en el step `i > 0` DESPUÉS de que
  al menos un step previo del MISMO run completó su settle downstream on-chain
  (evidencia: `downstream.txHash` en ese `StepResult`), THEN the system SHALL
  registrar ese pipeline como "pago stranded" en la superficie de reconciliación
  existente, correlacionando los steps del mismo run.
- **AC-3** — the system SHALL exponer, por pipeline con pago stranded, como mínimo:
  identificador del run, el o los steps que pagaron on-chain (agente, monto,
  txHash) y el step que falló — reusando el MISMO contrato de completitud ya
  candado (`total` exacto, `truncated`, sin lista nueva independiente).
- **AC-4** — IF la consulta que arma este listado falla, THEN the system SHALL
  propagar el error (throw) en vez de devolver una lista vacía.
- **AC-5** — WHEN la cantidad de pipelines con pago stranded en una ventana supera
  un umbral documentado y fundamentado, THEN the system SHALL emitir una señal
  observable reusando un canal de observabilidad ya activo del repo.
- **AC-6** — the system SHALL preservar el pago por llamada como el ÚNICO método de
  cobro para TODOS los agentes, propios y de terceros, sin distinción.
- **AC-7** — the system SHALL tratar esta superficie como de SOLO LECTURA.

### 2.2 ACs derivados (agregados en F2, verificables)

- **AC-8** — WHILE recolecta la evidencia de pago de los steps previos, the system
  SHALL contar TAMBIÉN el settle inbound x402 (`StepResult.txHash`), no sólo el
  downstream. Motivo: en el camino sin `a2aKey` ese hash es un pago on-chain REAL
  al `payTo` del agente hecho por el operador (`compose.ts`, bloque
  `if (agent.priceUsdc > 0 && !a2aKey && !inboundVmUnsupported)` → `adapter.sign` →
  `getPaymentAdapter().settle` y el comentario C2 "a2a still settles the
  authorization itself below (paying the agent's payTo on-chain)"). Listar sólo el
  downstream sub-declararía el residuo justo en el camino anónimo, que es el que
  NO tiene presupuesto de caller que lo acote (§4.6). AC-2 queda como el subconjunto
  mínimo obligatorio; AC-8 lo amplía y lo declara.
- **AC-9** — IF el registro del pago stranded no se puede persistir (fallo de
  `eventService.track`), THEN the system SHALL devolver el MISMO `ComposeResult`
  que devolvería sin esta HU (fire-and-forget, `.catch()` a log), porque un
  problema de telemetría no puede cambiar la respuesta de un money-path.
- **AC-10** — WHEN un pipeline NO falla, o falla sin que ningún step previo haya
  pagado on-chain, THEN the system SHALL comportarse de forma **byte-idéntica** a
  hoy: cero eventos nuevos, cero queries nuevas, misma respuesta.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos

| Archivo | Por qué | Hallazgo / patrón extraído |
|---------|---------|----------------------------|
| `src/services/compose.ts` (1424 líneas; loop `compose()` 171-805 e `invokeAgent` 1036-1424, leídos íntegros) | Es el archivo donde nace el residuo. | El hueco es real: `refundStepDebit` sólo revierte `stepDebitedUsd` del step que falla. **Seis** `return { success:false … }` distintos dentro del loop (agente no encontrado, scope denegado, presupuesto excedido, débito fallido, fallo de step sin retry, fallo tras retry) y **todos** llevan `steps: results`. `results` sólo se puebla en `finishSuccessfulStep` ⟹ `results.length` **es** el índice del step que falló. `composeRunId = randomUUID()` (`:182`) existe pero NUNCA llega a `eventService.track()`. |
| `src/services/event.ts` (249) | Dónde se persiste la telemetría. | `track()` recibe `metadata?: Record<string, unknown>` y lo inserta como `jsonb`. **Threadear el run id NO necesita migración.** `track()` TIRA si el insert falla ⟹ todos los callers usan `.catch()`. |
| `src/services/reconciliation.ts` (1271) | Es la superficie a extender (CD-2). | Contrato a heredar, textual en `listSettleUnknown`: `total` exacto vía `{count:'exact'}`, `truncated: total > rows.length`, y "un error de query TIRA en vez de devolver `[]` — una lista vacía por fallo mentiría 'no hay nada retenido', que es la peor respuesta posible acá". `listSettleUnknown()` se sirve ANIDADA dentro de `listAmbiguous()` a propósito ("dos listas hermanas de plata retenida se miran por turnos y una de las dos termina sin mirar"). `AMBIGUOUS_LIST_LIMIT = 500`. `getDriftThresholdAtomic()` (`:502-511`) es el patrón exacto de umbral por env con default seguro. |
| `src/lib/settle-withholding.ts` (237) | Exemplar directo: la HU hermana (HU-203) que ya resolvió "evento durable + lista anidada". | Leaf sin imports de servicios, `buildSettleUnknownEvent()` PURA que arma el input de `track()`, `COMPOSE_SETTLE_UNKNOWN_EVENT` como constante compartida entre productor y lector "para que no puedan divergir en el string". Es el molde de W0. |
| `src/routes/dashboard.ts` (778) | Dónde se sirve la superficie. | `GET /dashboard/api/reconciliation` con `preHandler: requireAdminToken`, devuelve `{pending, drift, ambiguous, flagEnabled}`. Como la lista nueva va ANIDADA en `ambiguous`, **el handler no cambia** (sólo su docstring). Las lecturas del panel usan el `requireAdminToken` opt-in (grandfathered); `requireAdminTokenStrict` es para escrituras de dinero — esta HU no escribe nada. |
| `src/lib/compose-limits.ts` (38) | Mitad "pasos" de la cota. | `MAX_COMPOSE_STEPS = 5` en un leaf con CERO imports + docstring de por qué una constante compartida le gana a un test que compara dos literales. Es el patrón de W0.1. |
| `src/lib/pricing-constants.ts` (16) | Si existía un techo de precio. | Sólo `PLACEHOLDER_FEE_USD = 1.0` (fallback de registry-miss). **No hay techo de precio por agente en ningún lado**: `grep` de `MAX_PRICE|MAX_AGENT_PRICE|PRICE_CAP` → 0 en producción; `maxPrice` es un filtro OPCIONAL del que busca (`discovery.ts:342-344`), y `ComposeRequest.maxBudget` es opcional. Confirma el `[bloqueante F2]` del work-item. |
| `src/types/index.ts` (`StepResult` 625-682, `ComposeResult` 561-620) | Qué evidencia sobrevive al fallo. | `StepResult` trae `agent: Agent`, `costUsdc`, `txHash?` (inbound x402), `downstreamTxHash?`, `downstreamSettledAmount?` (**atómico**, string), `downstreamBlockNumber?`. `ComposeResult.steps` viaja en TODOS los returns de error. ⚠️ El archivo ya tiene los tipos de WKH-305 sin commitear (§11). |
| `src/lib/downstream-payment.ts` (`DownstreamResult` 138-150) | Unidad del monto settleado. | `settledAmount` es **atomic units**; los decimals de la cadena del leg NO viajan en `StepResult` ⟹ el USD del reporte sale de `costUsdc` (§4.3). |
| `src/index.ts` (`/health` 133-145) | Dónde se engancha la alerta. | Handler trivial `{status,version,uptime,timestamp}`, `rateLimit:false`. Un campo ADITIVO no rompe nada. |
| `mcp-servers/wasiai-x402/src/health-monitor.mjs` (WKH-77) | El trípode, dentro de ESTE repo. | `parseHealthTargets` acepta `degradedPath` (dot-path); `_evaluateTarget` mapea un `degradedPath` **truthy** a severidad `warning` sin importar el tier ("un degradado-pero-vivo P0 es warning, no outage"). `fetchHealth` **no manda headers de auth** ⟹ el campo tiene que vivir en un endpoint público. |
| `mcp-servers/wasiai-x402/.env.example:228` (`HEALTH_MONITOR_TARGETS`) | Si el gateway ya es target. | **SÍ**: `{"label":"gateway-a2a","url":"…/health","tier":"P0","healthyField":"status","healthyValue":"ok",…}`, y el target `facilitator` YA usa `"degradedPath":"degraded"`. La alerta de AC-5 es **una clave más en ese JSON**. |
| `mcp-servers/wasiai-x402/src/alerts.mjs` | El canal. | `sendAlert` → webhook Discord `wasiai-alerts`, con whitelist de body. No se toca: el health-monitor ya lo llama por nosotros. |
| `doc/operations/oncall-runbook.md` (`:21`, `:119`) | Dónde se documenta el target. | Tabla de envs con `HEALTH_MONITOR_TARGETS` → ahí va la fila del `degradedPath` nuevo. |
| `supabase/migrations/20260404200000_events.sql` | Costo de la query de la ventana. | `a2a_events` tiene `idx_a2a_events_created (created_at DESC)`. Una query acotada por `created_at >= now()-ventana` usa ese índice ⟹ **no hace falta migración** (TD-203-01, el índice por `event_type`, sigue abierta y no se cierra acá). `cost_usdc NUMERIC(12,6)` ⟹ `::text` obligatorio (WKH-196). |
| `src/services/reconciliation.test.ts` (`:998-1345`) | Exemplar de los tests de la superficie. | Doble propio de supabase que captura la FORMA de la query **por tabla**, con el aviso explícito de HU-203: con una sola captura, la segunda query sobre la misma tabla pisa la forma de la primera y los candados quedan "verdes por el motivo incorrecto". Set completo a espejar: `T-203-SU-QUERY/-ROWS/-NUMERIC/-TRUNCATED/-NOT-TRUNCATED/-ERROR`. |
| `src/services/compose.test.ts` (`vi.mock('./event.js')` `:72`; `trackSpy` `:1022, :1137, :2901, :3324`) | Exemplar de los tests de emisión. | `eventService.track` ya está mockeado y espiado en esta suite; las aserciones sobre `metadata` ya existen. |
| `scripts/smoke-capabilities-schema.mjs` (`:1-45`) | Exemplar del script recomputable. | `GET /discover` es **libre** (read-only, sin pago), `BASE = argv[2] || A2A_URL || <prod>`, `fetch` pelado, cero dependencias. |
| `doc/sdd/190-wkh-305-compose-field-mapping/sdd.md` (§1, §4.4, §6.3) | La dependencia. | 305 mueve la construcción del input ANTES del débito ⟹ elimina de raíz la familia "entrada mala", y su §1 dice explícitamente "por eso esta HU va antes que ella". Sus CD-12..CD-18 son la destilación del auto-blindaje histórico: se heredan (§6.3). |
| `doc/sdd/190-p1-guards-sin-proteccion/auto-blindaje.md`, `doc/sdd/208-compose-por-capacidad/auto-blindaje.md` (leídos íntegros) | Aprendizaje histórico obligatorio. | 4 patrones recurrentes → CD-13..CD-19 (§6.3): cobertura ≠ protección, mutante que no compila = falso KILLED, test de dinero que mira el status en vez del balance, y "no agrega costo" que hay que probar contando I/O. |

### 3.2 Exemplars verificados (todos existen — confirmados con `ls`/`grep`/`Read`)

| Para crear/modificar | Seguir patrón de | Qué se copia |
|---|---|---|
| `src/lib/stranded-payment.ts` (NUEVO) | `src/lib/settle-withholding.ts` ✓ · `src/lib/compose-limits.ts` ✓ | Leaf: sólo `import type` + la constante compartida. Builder PURO del input de `track()`. Constante de `event_type` compartida productor↔lector. Docstring que explica qué se rompe si lo tocás. |
| `reconciliationService.listStrandedRuns()` | `reconciliationService.listSettleUnknown()` (`reconciliation.ts:641-670`) ✓ | `{count:'exact'}` + `order('created_at',{ascending:false})` + `.limit(AMBIGUOUS_LIST_LIMIT)` + `throw new ReconciliationError('INTERNAL')` + `::text` en el NUMERIC + `total`/`truncated`. |
| `StrandedRunsReport` anidado en `AmbiguousReport` | `AmbiguousReport.settleUnknown` (`reconciliation.ts:309-320`) ✓ | Campo nuevo ADENTRO del reporte que el operador ya abre; el docstring explica por qué no es una cola hermana. |
| Umbral por env con default seguro | `getDriftThresholdAtomic()` (`reconciliation.ts:501-511`) ✓ | Lee env, trimea, parsea, y ante ausencia/basura cae a un default que NO puede mentir. |
| Log estructurado de alerta | `payment-intent.ts:746` (`alert:'ESCROW_HOP2_LEASE_WRITE_FAILED'`) ✓ · `reconciliation.ts:1071` (`audit:`) ✓ | Clave `alert:` estable + mensaje en prosa accionable. |
| Campo aditivo booleano leído por el monitor | target `facilitator` con `"degradedPath":"degraded"` (`mcp-servers/wasiai-x402/.env.example:228`) ✓ | Un booleano público de "hay algo que mirar", sin números ni identificadores. |
| Script recomputable | `scripts/smoke-capabilities-schema.mjs` ✓ | `A2A_URL`/argv, `fetch` pelado, salida PASS/FAIL, exit code. |
| Tests de la superficie | `reconciliation.test.ts:998-1345` (`wireIntents`, `T-201-AMB-*`, `T-203-SU-*`) ✓ | Doble que captura la forma **por tabla y por llamada**. |
| Tests de emisión | `compose.test.ts:72, 1022, 2900-2990` ✓ | `vi.mocked(eventService.track)` + aserción sobre `metadata`. |
| Test estructural sobre el propio código | `src/routes/charged-routes.meta.test.ts:76-101` ✓ | Precedente de un test que lee la fuente/una lista y falla si aparece algo nuevo sin declararlo. |

### 3.3 Estado de BD relevante

| Tabla | Existe | Relevancia |
|---|---|---|
| `a2a_events` | SÍ (`20260404200000_events.sql`) | Único almacén que esta HU usa. `metadata jsonb` absorbe el run id y el detalle ⟹ **cero migraciones, cero columnas, cero RPC**. Índice `created_at DESC` presente ⟹ la query de ventana es barata. |
| `a2a_payment_intents` / `…_debit_signatures` | SÍ | **No se tocan.** El camino del budget de la agent key no crea intents (razón textual de `SettleUnknownEventRow`). |

### 3.4 Componentes reutilizables (no crear nuevos)

`eventService.track` · `reconciliationService` + su `ReconciliationError`/`AMBIGUOUS_LIST_LIMIT` ·
`GET /dashboard/api/reconciliation` + `requireAdminToken` · `MAX_COMPOSE_STEPS` ·
`health-monitor.mjs` + `alerts.mjs` + el cron `health-check` **ya desplegados** ·
`getLogger('…')`. Nada de esto se re-diseña.

---

## 4. Diseño

### 4.1 El único punto de estrangulamiento (la pieza no trivial)

`composeService.compose()` tiene **seis** returns de fallo dentro del loop y uno de
éxito al final. Envolver los seis sería seis oportunidades de olvidarse uno (hoy y
en cada HU futura). En vez de eso, el cuerpo actual se renombra a un método interno
y `compose()` pasa a ser una envoltura de diez líneas:

```
compose(request)                     ← público, NO cambia de firma ni de nombre
  ├─ runId = randomUUID()            ← el composeRunId sube un nivel
  ├─ result = await this.executePipeline(request, runId)   ← el cuerpo de hoy, intacto
  ├─ if (!result.success) recordStrandedRunIfAny(runId, result)   ← fire-and-forget
  └─ return result                   ← el MISMO objeto, sin tocar
```

Por qué así y no de otra forma:

- **Un solo lugar que decide**, así que ningún return de fallo puede quedar afuera —
  incluido el `INPUT_MAPPING_FAILED` que agrega WKH-305 y cualquiera que agregue una
  HU futura. Es la única forma de que la cobertura no dependa de la disciplina.
- **Cero cambios en las decisiones de dinero**: no se mueve ni un débito, ni un
  refund, ni un settle, ni el guard `i > 0`, ni `startTime`. El diff dentro del loop
  se limita a **agregar claves a `metadata`** de tres `track()` que ya existen.
- `composeRunId` se genera en la envoltura y se pasa como parámetro: el valor y su
  uso (`intentId` del leg Solana `${runId}:${i}`, claves de idempotencia de refund)
  quedan **byte-idénticos**. Mover la generación NO cambia la semántica: hoy también
  se genera una vez por invocación de `compose()`.
- `result.steps` ya trae todo lo necesario y `results.length` **es** el índice del
  step que falló (un `StepResult` sólo se pushea en `finishSuccessfulStep`).

### 4.2 Qué cuenta como "pago stranded"

`collectStrandedSteps(steps: StepResult[])` (leaf puro) devuelve un item por cada
step COMPLETADO con evidencia de pago on-chain:

| Evidencia | Campo | Qué es |
|---|---|---|
| `downstreamTxHash` no vacío | `downstream` | El leg operador→agente (WKH-55). **Es la evidencia que AC-2 nombra.** |
| `txHash` no vacío | `inbound` | El settle x402 del camino sin `a2aKey`, que paga al `payTo` del agente desde la wallet del operador (AC-8). |
| ambos | `both` | |

Si la lista queda vacía ⟹ **no se emite nada** (AC-10: fallo sin pago previo = hoy,
byte-idéntico). Si hay al menos uno **y** `result.success === false` ⟹ se emite UN
evento por run.

### 4.3 El evento durable

`event_type = 'compose_stranded_payment'` — constante `COMPOSE_STRANDED_PAYMENT_EVENT`
exportada del leaf y consumida por el productor (compose) y el lector
(reconciliation), por el mismo motivo textual que `COMPOSE_SETTLE_UNKNOWN_EVENT`.

| Campo de `a2a_events` | Valor | Por qué |
|---|---|---|
| `status` | `'failed'` | El run falló. |
| `cost_usdc` | Σ de `costUsdc` de los steps stranded | **USD, no atómico.** `downstreamSettledAmount` es atómico y los decimals de la cadena del leg NO viajan en `StepResult`; `costUsdc` es el precio del agente, que es EXACTAMENTE lo que se settlea (el gas overhead es margen del gateway y "never settled to the agent" — `compose.ts:289-294`). El atómico se guarda **verbatim, sin convertir**, dentro de cada item. |
| `tx_hash` | hash del PRIMER step stranded | Grep-abilidad desde el panel. ⚠️ El docstring DEBE decir que es el primero de N y que la lista completa vive en `metadata.paid_steps`; una columna que dice "el primero de varios" sin declararlo miente por omisión. |
| `agent_id` / `agent_name` / `registry` | `null` | **A propósito.** El agente que rompió el pipeline NO está en `ComposeResult` (sólo su índice). Poner ahí el primero que cobró haría que el panel señalara al agente equivocado durante un incidente. Se resuelve por join: ver `compose_run_id`. |
| `metadata.compose_run_id` | el run id | **La clave de join.** Es lo que hace que el `compose_step` `failed` del MISMO run (que SÍ trae `agent_id`/`agent_name`/`registry`) sea recuperable por query. Es la razón por la que DT-4 existe. |
| `metadata.failed_step_index` | `steps.length` | AC-3, "el step que falló". |
| `metadata.error_code` / `metadata.error` | `result.errorCode ?? null` / `result.error` truncado a 500 chars | Ya son públicos (viajan en la respuesta). Truncar acota el ruido en una tabla de telemetría. |
| `metadata.paid_steps[]` | `{step, agent_slug, registry, chain, cost_usdc, settled_atomic, tx_hash, evidence}` | AC-3: agente, monto y txHash por step que pagó. |
| `metadata.stranded_usd` | Σ (mismo número que `cost_usdc`) | Redundante a propósito: `cost_usdc` es NUMERIC y se lee con `::text`; el de metadata es el original sin pasar por la aritmética de PostgREST. Si divergen, hay un bug de precisión (lección WKH-196). |

Emisión: `eventService.track(buildStrandedPaymentEvent(...)).catch(logError)` —
fire-and-forget, exactamente como `recordSettleWithheld` (`compose.ts:561-582`). AC-9.

### 4.4 La superficie de lectura (AC-2/AC-3/AC-4)

```
GET /dashboard/api/reconciliation   ← MISMA ruta, MISMO gate, handler SIN CAMBIOS
└─ ambiguous: AmbiguousReport
   ├─ rows / total / truncated          (HU-201)
   ├─ settleUnknown: SettleUnknownReport (HU-203)
   └─ strandedRuns: StrandedRunsReport   ← NUEVO, ADITIVO (esta HU)
      ├─ rows: StrandedRunRow[]
      ├─ total      ← {count:'exact'}
      └─ truncated  ← total > rows.length
```

- **Anidado, no hermano**, por la razón textual de HU-203: dos listas de plata parada
  se miran por turnos y una queda sin mirar. Como va adentro de `ambiguous`, el
  handler de `routes/dashboard.ts` **no cambia una línea** (sólo su docstring) ⟹
  CD-2 se cumple en su forma más fuerte: no hay endpoint nuevo, ni tabla, ni cola.
- `listStrandedRuns()` se llama **secuencialmente** desde `listAmbiguous()`, después
  de `listSettleUnknown()`, por el motivo ya escrito ahí: con las promesas en vuelo,
  el fallo de una deja a la otra como unhandled rejection; en serie, el primer fallo
  tira y nunca se emite una lista a medias.
- Las tres invariantes se heredan **tal cual** y ninguna se puede debilitar (CD-3).
- **NO gateada por `isEscrowSettleEnabled()`**: el camino que produce estas filas
  (compose/orchestrate sobre budget de agent key) no tiene nada que ver con el
  escrow y corre siempre. Gatearla la dejaría vacía justo cuando importa.
- **NO se agrega el `event_type` nuevo a `SETTLE_UNKNOWN_EVENT_TYPES`** (CD-8): son
  preguntas distintas — "el settle quedó sin resolver" vs "el settle se confirmó y el
  pipeline falló después". Mezclarlas rompería el significado de la lista de HU-203.

`StrandedRunRow` espeja `SettleUnknownEventRow`: columnas reales tipadas
(`event_id`, `tx_hash`, `strandedUsd` vía `cost_usdc::text`, `created_at`) +
`metadata` **verbatim** + tres campos derivados del metadata con un lector
DEFENSIVO y puro (`runId`, `failedStepIndex`, `paidSteps`) que ante una forma
inesperada devuelve `null`/`[]` y **nunca tira**: una fila vieja o mal formada no
puede voltear la lista entera (eso sería devolver `[]` por otra puerta).

### 4.5 La alerta (AC-5)

**Canal: el trípode, sin tocarlo.** El health-monitor (WKH-77) ya poletea
`gateway-a2a → /health` cada 4 min como target **P0** y ya sabe leer un
`degradedPath`. La activación completa es agregar una clave al JSON de
`HEALTH_MONITOR_TARGETS`:

```jsonc
{"label":"gateway-a2a", "url":".../health", "tier":"P0",
 "healthyField":"status", "healthyValue":"ok",
 "degradedPath":"strandedPaymentExposureHigh"}      // ← lo único que se agrega
```

Un `degradedPath` truthy da severidad **`warning`** aunque el tier sea P0
(`health-monitor.mjs:204-208`) — que es exactamente lo correcto: hay plata que
reconciliar, no hay un outage.

**El campo, en `/health`** (ADITIVO, público, booleano):

| Valor | Significado |
|---|---|
| campo **ausente** | el umbral no está configurado ⟹ feature OFF ⟹ cero queries, `/health` byte-idéntico a hoy |
| `false` | se computó y **NO** hay breach |
| `true` | breach: la exposición acumulada en la ventana superó el umbral |
| `'unknown'` | **no se puede afirmar** que no haya breach (nunca se computó, o la última computación falló, o el dato está rancio) |

`'unknown'` es truthy ⟹ el monitor alerta. **Ese es el punto**: la doctrina de AC-4
("una lista vacía por error se lee igual que 'no hay nada', que es la peor mentira
posible") aplicada al tercer pilar. Un `false` por fallo de base de datos sería
exactamente esa mentira, en el único canal que la tendría que gritar.

**Cómo se computa, sin costo en el request path**: módulo `src/services/stranded-alert.ts`
con un snapshot en memoria. `/health` lee el snapshot **sincrónicamente** y, si está
rancio, dispara un refresh en background (`void refresh().catch(...)`). Nunca hay un
`await` a la base en el handler, nunca tira, y hay **como mucho una query por
`REFRESH_MS`** (constante, 60 s) aunque `/health` reciba miles de hits. La query es
un `count` acotado por `created_at >= now() - ventana`, que usa
`idx_a2a_events_created`. Sin timers (`setInterval` filtra en tests y en shutdown).

**El umbral, y por qué ese**: se expresa en **USD de exposición acumulada**, no en
cantidad de runs, para que se lea en la misma unidad que la cota de AC-1. Un
pipeline stranded aislado es ruido inevitable de un sistema distribuido (un agente
se cayó a mitad de camino); lo que hay que cazar es el fenómeno **sistémico**. El
valor recomendado es, por lo tanto, **diez pipelines en su peor caso por ventana**:

```
umbral_recomendado_usd = 10 × MAX_STRANDABLE_STEPS × precio_máximo_observado
                       = 10 × cota_de_AC-1        ← misma fórmula, un solo lugar
ventana_recomendada    = 60 min
```

Los dos números son **re-computables** por el mismo script de §4.6 (CD-6): la
fórmula vive una sola vez. La ventana de 60 min es 15× el período de poleo del
monitor (4 min), así que un breach se ve muchas veces antes de despejarse y no hay
flanco que se pierda; y es corta como para disparar durante el incidente y no al
día siguiente. Envs: `STRANDED_EXPOSURE_ALERT_THRESHOLD_USD` (ausente/inválido ⟹
**OFF**, patrón `getDriftThresholdAtomic`) y `STRANDED_EXPOSURE_ALERT_WINDOW_MIN`
(default 60).

**Segundo consumidor, gratis**: en cada transición a breach el módulo emite
`log.error({ alert: 'COMPOSE_STRANDED_PAYMENT_EXPOSURE_HIGH', windowMin, thresholdUsd, exposureUsd, runs }, …)`
— el idiom de alerta estructurada que el repo ya usa (`payment-intent.ts:746`). Así
la señal existe en los logs aunque el JSON de targets no se haya actualizado todavía.

### 4.6 La cota (AC-1) — qué queda cerrado y qué queda abierto, con su motivo

**La fórmula, en código** (`src/lib/stranded-payment.ts`):

```ts
export const MAX_STRANDABLE_STEPS = MAX_COMPOSE_STEPS - 1;   // 4 — derivado, no literal
export function maxStrandedExposureUsd(maxStepPriceUsd: number): number {
  return MAX_STRANDABLE_STEPS * maxStepPriceUsd;
}
```

`- 1` porque el step que falla no deja residuo por sí mismo: si su propio settle
quedó sin resolver, eso ya es la cola de HU-203 (`compose_settle_unknown`), otra
pregunta y otra lista. Se deriva de la constante compartida (no un `4` a mano) por
el motivo que ese mismo archivo documenta: dos números sueltos divergen en silencio.

**Las cotas que el código YA impone hoy** (verificadas, no supuestas):

| Dimensión | ¿Acotada? | Dónde |
|---|---|---|
| Cantidad de steps | **SÍ**, ≤ 4 | `MAX_COMPOSE_STEPS` (`compose-limits.ts:38`), validado en la ruta |
| Presupuesto del caller, camino agent-key | **SÍ** | cada step `i>0` debita ANTES de invocar; `!debitResult.success` ⟹ `return` sin `invokeAgent` (`compose.ts:319-336`) ⟹ la suma settleada no puede superar el budget vigente de la key |
| `maxBudget` declarado por el caller | **SÍ, si lo declara** | guard `totalCost + price + gas > maxBudget` ⟹ corta ANTES del débito y del invoke (`compose.ts:235-246`) |
| Cap por destino (spend policies) | **SÍ, si está configurado** | `DEST_CAP_EXCEEDED` |
| **Precio por agente** | **NO** | no existe techo en el repo (§3.1) |
| Camino x402 anónimo | **NO** | sin `scopingKeyRow` no hay débito per-step ⟹ ningún presupuesto acota el leg operador→agente |

⟹ **La cota es cerrada en pasos y en el camino autenticado; es ABIERTA en la
dimensión precio, y por lo tanto abierta en el camino x402 anónimo.**

**Lo que esta HU entrega para cerrarla** — el mecanismo, implementado y probado, en
el punto de corte que YA existe (no una rama nueva):

```ts
// leaf, puro
export function resolveEffectivePipelineBudgetUsd(callerMaxBudget: number | undefined): number
// = min(callerMaxBudget || +Infinity, PIPELINE_EXPOSURE_CEILING_USD || +Infinity)
```

se consume en el guard de `maxBudget` que ya corta antes del débito y antes del
invoke. Con `PIPELINE_EXPOSURE_CEILING_USD` **sin setear** el resultado es
`+Infinity` y el comportamiento es **byte-idéntico** (incluido que `maxBudget: 0`
sigue significando "sin límite", como hoy). Con la env seteada, la exposición máxima
por pipeline pasa a ser una **garantía de código**, en los dos caminos, x402 incluido.

**Y por qué viaja apagado (la cota abierta, declarada):** elegir hoy el número
significaría fijarlo **sin un solo dato de exposición real** — el motivo de existir
de esta HU es que ese dato **no se puede medir todavía**. Un techo demasiado bajo
**rechaza tráfico legítimo y ya pagado**, que es un daño mayor y de signo opuesto al
que se quiere evitar. Así que el mecanismo se entrega listo y el número queda como
decisión de operación **con gatillo escrito**:

> **Gatillo (va al runbook, §7 W4):** con 2 semanas de `strandedRuns` con tráfico
> real, correr `scripts/report-stranded-exposure.mjs` y setear
> `PIPELINE_EXPOSURE_CEILING_USD = 10 × cota_observada`. Mientras esté sin setear,
> la cota en la dimensión precio es **una medición de hoy, no una garantía**, y así
> tiene que estar escrito en el runbook.

**El número de hoy, recomputable** (CD-6): `scripts/report-stranded-exposure.mjs`
pega un `GET /discover` (libre) contra el gateway, saca `max(priceUsdc)` del catálogo
vivo e imprime `MAX_STRANDABLE_STEPS`, la cota y el umbral recomendado de §4.5. Si no
puede alcanzar el gateway, **sale con código ≠ 0 y un mensaje accionable**: nunca
imprime un número por defecto (un número inventado en un reporte de exposición es
peor que ningún número).

### 4.7 Flujos

| Caso | Qué pasa | Dinero |
|---|---|---|
| Pipeline exitoso | nada nuevo; 0 eventos, 0 queries | sin cambios |
| Falla el step 0 (nadie pagó todavía) | `collectStrandedSteps` → `[]` ⟹ no se emite nada | sin cambios |
| Falla el step 2 con los steps 0-1 settleados | 1 evento `compose_stranded_payment` + los `compose_step` con `compose_run_id` | **sin cambios** (el refund del step que falla es el de hoy) |
| Falla por débito insuficiente / scope / presupuesto en el step 2 | idem (el choke point los cubre igual que al throw del invoke) | sin cambios |
| Falla el step 2 y ADEMÁS su propio settle quedó sin resolver | 1 fila en `strandedRuns` (los steps 0-1) **y** 1 fila en `settleUnknown` (el step 2). Son dos hechos distintos y las dos listas dicen la verdad. | sin cambios |
| `eventService.track` rechaza | `.catch()` a log; el `ComposeResult` es el mismo (AC-9) | sin cambios |
| La query de la lista falla | **throw** `ReconciliationError('INTERNAL')` → el handler ya responde 500 `RECONCILIATION_FAILED` (AC-4) | — |
| La query del snapshot de alerta falla | el campo pasa a `'unknown'` ⟹ el monitor alerta `warning` | — |

---

## 5. Decisiones técnicas (DT)

- **DT-1 — El pago por llamada es estructural, no una preferencia (ancla de neutralidad).**
  Que un agente pueda entrar al marketplace **sin que WasiAI lo conozca de antemano**
  —sin relación previa, sin saldo fondeado, sin onboarding financiero— *es* la
  neutralidad. Un riel prepago sólo puede existir para quien YA tiene relación previa
  con el operador, y hoy esa relación la tienen únicamente los agentes de la casa
  (`remit-*`, `agentshop-*`). Si ese riel fuera estructuralmente más rápido o más
  barato (sin gas por llamada, sin ronda de settle), esos agentes ganarían pipelines
  **por el riel y no por la calidad**, que es la misma asimetría por la que
  `agent.payment.chain` ya no se usa como señal de ranking en discovery. El costo que
  se optimizaría es marginal (~USD 0,03 por agente) frente al costo de mantener DOS
  modelos de cobro para siempre. **Esto queda escrito acá a propósito**: reintroducir
  prepago no puede ser una optimización silenciosa dentro de seis meses; tiene que
  volver a pasar por este argumento. AC-6 y CD-1 son su candado ejecutable, y
  `T-NEUTRALITY-01` lo prueba con dinero, no con prosa.
- **DT-2 — El residuo se ASUME, no se evita con arquitectura nueva.** Gestión
  profesional = acotar (AC-1) + ver (AC-2/3) + alertar (AC-5). Esa es la HU entera.
- **DT-3 — Un único punto de estrangulamiento** (§4.1) en vez de envolver seis
  returns. La corrección no puede depender de que nadie se olvide.
- **DT-4 — La correlación de run se resuelve en proceso, y el `compose_run_id` en
  `metadata` es la clave de join.** Cuando el pipeline falla ya tenemos `result.steps`
  entero en la mano: no hace falta reconstruir nada por query. El run id se threadea
  igual —en `metadata` de los `compose_step` que ya se trackean— porque es lo que
  permite ir de la fila del residuo al `compose_step` `failed` que sí trae el agente
  culpable. `metadata` es `jsonb` ⟹ **aditivo, sin migración, sin cambiar la forma
  para ningún consumidor existente** (dashboard analytics, reputation-writeback).
- **DT-5 — La alerta reusa el target P0 que el health-monitor ya poletea**, con el
  mismo `degradedPath` que ya usa el facilitator. No hay cron nuevo, ni monitor
  nuevo, ni webhook nuevo: una clave más en `HEALTH_MONITOR_TARGETS`. El costo de
  computarla no toca el request path (snapshot cacheado, §4.5).
- **DT-6 — `'unknown'` en vez de `false` cuando no se puede afirmar.** La invariante
  de AC-4 aplicada al canal de alerta.
- **DT-7 — El USD del reporte sale de `costUsdc`, y el atómico se guarda verbatim.**
  Convertir el atómico necesitaría los decimals de la cadena del leg, que no viajan
  en `StepResult`; inventarlos sería un número de dinero fabricado.
- **DT-8 — El techo de exposición se implementa apagado, con gatillo escrito** (§4.6).
  El mecanismo es entregable de esta HU; el número es decisión de operación con dato.
- **DT-9 — Toda la lógica nueva pura vive en un leaf** (`src/lib/stranded-payment.ts`),
  por el motivo que `compose-limits.ts` documenta: media docena de suites mockean los
  módulos gordos del money-path completos, y un leaf sin dependencias no puede quedar
  `undefined` en ninguna.

---

## 6. Constraint Directives (CD)

### 6.1 Heredadas del work-item (íntegras, no negociables)

- **CD-1 (PROHIBIDO)**: introducir cualquier mecanismo de saldo prepago, crédito,
  recarga o liquidación diferida para NINGÚN agente, propio o tercero. El pago por
  llamada es el ÚNICO método de cobro, sin excepción.
- **CD-2 (PROHIBIDO)**: crear endpoint, tabla o "cola" de admin nueva e independiente.
  Se extiende ADITIVAMENTE la superficie existente.
- **CD-3 (OBLIGATORIO)**: toda query nueva de este listado propaga el error (throw);
  jamás devuelve `[]` ante fallo de base de datos.
- **CD-4 (PROHIBIDO)**: remediación automática (reembolso, reclamo, compensación).
  Superficie de SOLO LECTURA.
- **CD-5 (PROHIBIDO)**: resolver WKH-305 dentro de esta HU.
- **CD-6 (OBLIGATORIO)**: la fórmula de exposición máxima es RE-COMPUTABLE por código
  (test + script), no un número fijado a mano en prosa.

### 6.2 Nuevas de este SDD

- **CD-7 (PROHIBIDO)**: cambiar cualquier decisión de dinero de `compose.ts` — débito,
  refund, settle, retención HU-203, guard `i > 0`, `startTime`, orden de operaciones.
  El diff permitido dentro del loop es **agregar claves a `metadata`** de `track()`.
  Si el diff toca otra cosa, es **BLOQUEANTE** en AR.
- **CD-8 (PROHIBIDO)**: agregar `compose_stranded_payment` a `SETTLE_UNKNOWN_EVENT_TYPES`.
  Son preguntas distintas; mezclarlas corrompe la lista de HU-203.
- **CD-9 (OBLIGATORIO)**: la emisión es fire-and-forget con `.catch()`. PROHIBIDO
  `await`-earla en el camino de la respuesta o dejar que su fallo cambie el
  `ComposeResult` (AC-9).
- **CD-10 (OBLIGATORIO)**: `/health` no puede ganar un `await` a la base de datos ni
  un `setInterval`, ni puede tirar. Snapshot en memoria + refresh en background.
- **CD-11 (PROHIBIDO)**: exponer en `/health` conteos, montos, ids, slugs o cualquier
  cosa que no sea el booleano de tres estados. Es un endpoint público.
- **CD-12 (OBLIGATORIO)**: el lector de `metadata` de la superficie es DEFENSIVO y
  puro: una fila con forma inesperada devuelve `null`/`[]` y **nunca** tira ni tumba
  la lista entera (sería devolver `[]` por otra puerta, violando CD-3 de costado).

### 6.3 Derivadas del Auto-Blindaje histórico (obligatorias)

- **CD-13: PROHIBIDO afirmar que un guard está protegido por su cobertura de línea.**
  Se **muta primero** y se comprueba que un test se pone rojo. —
  `190-p1-guards-sin-proteccion/auto-blindaje.md#Wave 1`.
- **CD-14: PROHIBIDO un test de dinero que sólo mire el status code o el spy.** El
  efecto se asserta observable. — `208-.../auto-blindaje.md#Wave 2`.
- **CD-15: PROHIBIDO escribir un test o un comentario contra un `archivo:línea`
  heredado sin releer el archivo.** Los punteros de este SDD son archivo + **ancla de
  contenido**; si no coinciden al implementar, se reporta. — `190-p1-…#Wave 1`.
- **CD-16: OBLIGATORIO que todo mutante COMPILE antes de contarlo.** "No tests" o
  "FAIL archivo" es un **falso KILLED**. — `190-p1-…#Wave 2` y `193-…`.
- **CD-17: PROHIBIDO `git checkout --` sobre archivos con cambios sin commitear**
  durante la verificación por mutación. Se commitea, se muta, se restaura. —
  `193-…`, `203-…`. ⚠️ **Crítico acá**: el árbol tiene cambios de WKH-305 sin
  commitear (§11).
- **CD-18: OBLIGATORIO correr `npx tsc --noEmit` completo (incluye tests)**, no sólo
  `npm run build`. — lección WKH-196.
- **CD-19: OBLIGATORIO que un claim de "no agrega costo" se pruebe contando I/O**
  (llamadas), no sólo el efecto observable. — `208-…#Wave 3` (la mutación M5
  sobrevivió por esto). Aplica a AC-10 y al claim "cero queries con el umbral OFF".
- **CD-20: OBLIGATORIO correr `biome check --write` sobre los archivos nuevos ANTES
  de declarar los gates.** — `190-p1-…#Wave 3`.

---

## 7. Waves de implementación

### W0 — Serial gate: contrato + leaf puro (cero cambio de comportamiento)

| # | Tarea | Archivos |
|---|---|---|
| W0.1 | Leaf `stranded-payment.ts`: `COMPOSE_STRANDED_PAYMENT_EVENT`, `MAX_STRANDABLE_STEPS` (derivado de `MAX_COMPOSE_STEPS`), `maxStrandedExposureUsd()`, `recommendedAlertThresholdUsd()`, `collectStrandedSteps()`, `buildStrandedPaymentEvent()`, `readStrandedMetadata()` (defensivo), `resolveEffectivePipelineBudgetUsd()`. Cero imports de runtime salvo `compose-limits.js`; sólo `import type` para `StepResult`. Nunca tira. | `src/lib/stranded-payment.ts` (NUEVO) |
| W0.2 | Tipos de la superficie: `StrandedPaidStep`, `StrandedRunRow`, `StrandedRunsReport`, `AmbiguousReport.strandedRuns`. | `src/services/reconciliation.ts` (sólo tipos) |
| W0.3 | Unit del leaf: derivación de la cota, fórmulas, recolección de evidencia (3 combinaciones + vacío), builder, lector defensivo, `min()` del presupuesto efectivo. | `src/lib/stranded-payment.test.ts` (NUEVO) |

**Gate de salida**: `npx tsc --noEmit` verde + suite completa verde. Nadie llama al
leaf todavía ⟹ **cero cambio observable**.

### W1 — Detección y registro (depende de W0)

| # | Tarea | Archivos |
|---|---|---|
| W1.1 | Split del método: `compose()` envoltura + `executePipeline(request, runId)` con el cuerpo actual **intacto**; `composeRunId` pasa a parámetro. | `src/services/compose.ts` |
| W1.2 | `recordStrandedRunIfAny(runId, result)` en la envoltura: `collectStrandedSteps` → si no vacío, `track(build…).catch(log)`. | `src/services/compose.ts` |
| W1.3 | `compose_run_id` + `step` en `metadata` de los `track()` que ya existen (éxito `:962-983`, fallo `:595-611`, fallo-tras-retry `:719-738`) y en `buildSettleUnknownEvent` vía `recordSettleWithheld`. **Sólo claves nuevas.** | `src/services/compose.ts`, `src/lib/settle-withholding.ts` |
| W1.4 | Tests de emisión + neutralidad + no-regresión. | `src/services/compose.stranded.test.ts` (NUEVO, ver §8.1) |

### W2 — Superficie de lectura (depende de W0; paralela a W4)

| # | Tarea | Archivos |
|---|---|---|
| W2.1 | `reconciliationService.listStrandedRuns()` espejando `listSettleUnknown` (count exact, order, limit, `::text`, throw). | `src/services/reconciliation.ts` |
| W2.2 | `listAmbiguous()` la llama **en serie** y la anida en `strandedRuns`. | `src/services/reconciliation.ts` |
| W2.3 | Docstrings: `AmbiguousReport`, la ruta en `routes/dashboard.ts` (**sólo comentarios**, sin cambio de código). | `src/routes/dashboard.ts` |
| W2.4 | Tests de la superficie (6 candados heredados + defensivo). | `src/services/reconciliation.test.ts` |

### W3 — Alerta (depende de W2)

| # | Tarea | Archivos |
|---|---|---|
| W3.1 | `reconciliationService.countStrandedExposureSince(windowStart)` → `{runs, exposureUsd}`, misma doctrina (throw ante error). | `src/services/reconciliation.ts` |
| W3.2 | `stranded-alert.ts`: config por env, snapshot cacheado, refresh en background, `getStrandedHealthField()`, log `alert:` en la transición a breach. | `src/services/stranded-alert.ts` (NUEVO) |
| W3.3 | Campo aditivo en `/health` (ausente si el umbral no está configurado). | `src/index.ts` |
| W3.4 | Tests del snapshot + del shape de `/health`. | `src/services/stranded-alert.test.ts` (NUEVO) |
| W3.5 | Doc: fila del `degradedPath` en el runbook + envs nuevas. | `doc/operations/oncall-runbook.md`, `.env.example`, `mcp-servers/wasiai-x402/.env.example` |

### W4 — Cota (depende de W0 y de W1 por el archivo; paralela a W2/W3)

| # | Tarea | Archivos |
|---|---|---|
| W4.1 | `resolveEffectivePipelineBudgetUsd` enchufado en el guard de `maxBudget` existente (mensaje distinguible cuando el límite que ata es el techo del gateway). | `src/services/compose.ts` |
| W4.2 | Script recomputable. | `scripts/report-stranded-exposure.mjs` (NUEVO) |
| W4.3 | Doc de la cota + el **gatillo** de §4.6 + qué dimensión queda abierta y por qué. | `doc/operations/oncall-runbook.md`, `README`/`doc/INTEGRATION.md` si el campo público cambia (no cambia) |
| W4.4 | Tests de la cota y del techo. | `src/services/compose.stranded.test.ts`, `src/lib/stranded-payment.test.ts` |

**Paralelismo**: W0 → W1 → {W2 → W3, W4}. W1 y W4 tocan `compose.ts` ⟹ serie.

---

## 8. Plan de tests (≥ 1 por AC)

### 8.1 Por AC

| AC | Test | Qué prueba | Archivo |
|---|---|---|---|
| AC-1 | `T-COTA-01` | `MAX_STRANDABLE_STEPS === MAX_COMPOSE_STEPS - 1` **y** `=== 4` (las dos: la derivación y el valor de hoy, patrón `compose-limits`) | `stranded-payment.test.ts` |
| AC-1 | `T-COTA-02` | `maxStrandedExposureUsd(p)` = pasos × precio, y `recommendedAlertThresholdUsd` = 10 × cota | idem |
| AC-1 | `T-CEILING-01` | con `PIPELINE_EXPOSURE_CEILING_USD` seteado, el step que lo excedería **no debita y no invoca** (assert `mockDebit` y `fetch` no llamados) | `compose.stranded.test.ts` |
| AC-1 | `T-CEILING-02` | env **sin setear** ⟹ el pipeline caro corre igual (byte-idéntico) | idem |
| AC-1 | `T-CEILING-03` | `maxBudget:0` sigue significando "sin límite"; con caller-budget y techo, ata el **menor** | `stranded-payment.test.ts` |
| AC-2 | `T-STRAND-EMIT-01` | run con step 0 settleado (`downstreamTxHash`) + step 1 que tira ⟹ **un** `track` con `event_type='compose_stranded_payment'` | `compose.stranded.test.ts` |
| AC-2 | `T-STRAND-EMIT-02` | fallo del step 0 sin ningún pago previo ⟹ **cero** eventos de ese tipo | idem |
| AC-2 | `T-STRAND-EMIT-03` | pipeline exitoso ⟹ cero eventos de ese tipo | idem |
| AC-2 | `T-STRAND-EMIT-04` | el corte por **débito fallido** (no por throw del invoke) con un step previo pagado **también** emite — el choke point cubre los seis returns | idem |
| AC-3 | `T-STRAND-FIELDS` | el `metadata` trae `compose_run_id`, `failed_step_index`, y `paid_steps[]` con `agent_slug`, `cost_usdc`, `tx_hash`, `settled_atomic` verbatim | idem |
| AC-3 | `T-STRAND-JOIN` | el `compose_step` `failed` del MISMO run trae el MISMO `compose_run_id` **y** `agent_id` ⟹ el agente culpable es recuperable | idem |
| AC-3 | `T-STRAND-QUERY` | lee `a2a_events` filtrando por el `event_type` nuevo (no otra tabla, no otro filtro) | `reconciliation.test.ts` |
| AC-3 | `T-STRAND-TRUNCATED` / `T-STRAND-NOT-TRUNCATED` | `total` exacto vía `{count:'exact'}` y `truncated` correcto en ambos sentidos | idem |
| AC-3 | `T-STRAND-NUMERIC` | el select pide `cost_usdc::text` (WKH-196) | idem |
| AC-3 | `T-STRAND-NESTED` | `listAmbiguous()` devuelve `strandedRuns` anidado **y** sigue devolviendo `rows`/`settleUnknown` intactos | idem |
| AC-4 | `T-STRAND-ERROR` | error de query ⟹ **tira** `ReconciliationError('INTERNAL')`, NO `[]` | idem |
| AC-4 | `T-STRAND-ERROR-PROPAGA` | ese throw sube por `listAmbiguous()` (no se traga con un `try` interno) | idem |
| AC-5 | `T-ALERT-BREACH` / `T-ALERT-NO-BREACH` | exposición > umbral ⟹ `true` + log `alert:`; ≤ umbral ⟹ `false` y **sin** log | `stranded-alert.test.ts` |
| AC-5 | `T-ALERT-UNKNOWN` | query que falla / snapshot rancio / nunca computado ⟹ `'unknown'` (truthy), **nunca** `false` | idem |
| AC-5 | `T-ALERT-OFF` | umbral sin configurar ⟹ campo **ausente** en `/health` y **cero** llamadas a supabase (CD-19: se cuenta el I/O) | idem |
| AC-5 | `T-ALERT-WINDOW` | el filtro usa `created_at >= now - ventana` con la ventana configurada | idem |
| AC-5 | `T-ALERT-CACHE` | N lecturas dentro del TTL ⟹ **una** query (CD-19) | idem |
| AC-5 | `T-HEALTH-SHAPE` | `/health` sigue devolviendo `status:'ok'` (el `healthyField` del monitor **no** se rompe) y el campo es aditivo | `src/__tests__/…` o `index` test existente |
| AC-6 | `T-NEUTRALITY-01` | el MISMO pipeline con un agente propio (`remit-*`, registry `wasiai`) y con uno de tercero produce **exactamente los mismos** `debit` (monto, cantidad, destino): cobro idéntico, sin rama por dueño | `compose.stranded.test.ts` |
| AC-6 | `T-NEUTRALITY-02` | guard estructural: el código de producción del money-path no contiene identificadores de un riel prepago (`prepaid`/`prepay`/`topUp`/`deferredSettlement`) — regresión explícita contra el pivote | `compose.stranded.test.ts` |
| AC-7 | `T-READONLY-01` | `listStrandedRuns()` no llama `supabase.rpc` ni `insert/update/delete` | `reconciliation.test.ts` |
| AC-7 | `T-READONLY-02` | registrar un run stranded **no** dispara ningún `credit`/`creditWithDest` extra (el dinero movido es idéntico con y sin la HU) | `compose.stranded.test.ts` |
| AC-8 | `T-STRAND-INBOUND` | step pagado sólo por el inbound x402 (`txHash`, sin `downstreamTxHash`) ⟹ **también** cuenta, con `evidence:'inbound'` | idem |
| AC-9 | `T-STRAND-TRACK-THROWS` | `track` rechaza ⟹ el `ComposeResult` es idéntico y no hay unhandled rejection | idem |
| AC-10 | `T-STRAND-BYTE-IDENTICO` | pipeline exitoso: mismo `ComposeResult`, misma cantidad de `track` y de `debit` que en el baseline (CD-19) | idem |
| CD-8 | `T-STRAND-FAMILY-SEPARATE` | `listSettleUnknown()` sigue filtrando por **exactamente** los dos `event_type` históricos | `reconciliation.test.ts` |
| CD-12 | `T-STRAND-DEFENSIVE` | fila con `metadata` `null`/array/forma rara ⟹ `paidSteps: []`, `runId: null`, **sin throw**, y las demás filas se siguen listando | idem |

⚠️ **Gotcha obligatorio del harness** (lección textual de HU-203): `listAmbiguous()`
va a hacer **dos** queries sobre `a2a_events` (settleUnknown y strandedRuns). El doble
de `reconciliation.test.ts` captura **por tabla**, así que la segunda pisaría la forma
de la primera y los candados quedarían *verdes por el motivo equivocado*. La captura
tiene que discriminar por tabla **y por orden de llamada** (un array de capturas por
tabla) antes de escribir un solo assert.

### 8.2 Mutantes (todos COMPILAN — CD-16)

| # | Mutación | Test asesino |
|---|---|---|
| M1 | `MAX_STRANDABLE_STEPS = MAX_COMPOSE_STEPS - 1` → `= MAX_COMPOSE_STEPS` | `T-COTA-01` |
| M2 | borrar la llamada `recordStrandedRunIfAny(...)` de la envoltura | `T-STRAND-EMIT-01` |
| M3 | en `collectStrandedSteps`, quitar la rama `txHash` (dejar sólo `downstreamTxHash`) | `T-STRAND-INBOUND` |
| M4 | quitar `{ count: 'exact' }` del select | `T-STRAND-TRUNCATED` |
| M5 | `if (error) throw …` → `if (error) return { rows: [], total: 0, truncated: false }` | `T-STRAND-ERROR` |
| M6 | `truncated: total > rows.length` → `truncated: false` | `T-STRAND-TRUNCATED` |
| M7 | `breached = exposureUsd > threshold` → `breached = false` | `T-ALERT-BREACH` |
| M8 | ante error de la query, devolver `false` en vez de `'unknown'` | `T-ALERT-UNKNOWN` |
| M9 | `Math.min(callerBudget, ceiling)` → `callerBudget` | `T-CEILING-01` |
| M10 | `cost_usdc::text` → `cost_usdc` | `T-STRAND-NUMERIC` |
| M11 | agregar `COMPOSE_STRANDED_PAYMENT_EVENT` a `SETTLE_UNKNOWN_EVENT_TYPES` | `T-STRAND-FAMILY-SEPARATE` |
| M12 | borrar `compose_run_id` del `metadata` del `compose_step` de éxito | `T-STRAND-JOIN` |
| M13 | en el refresh del snapshot, ignorar el TTL y refrescar siempre | `T-ALERT-CACHE` |
| M14 | `collectStrandedSteps` devuelve también el step que falló (quitar el `-1` conceptual: incluir el índice `steps.length`) | `T-STRAND-FIELDS` (`paid_steps` no puede contener el índice fallido) |

Procedimiento (CD-13/CD-16/CD-17): commitear → mutar → correr la suite → **verificar
que el rojo es una aserción y no un error de parseo/compilación** → restaurar con
`git restore` **sólo del archivo mutado y sólo si no tiene otros cambios**.

### 8.3 Baseline

Baseline declarado: **3996 passed | 19 skipped**. Ningún test existente puede
cambiar de resultado; los nuevos suman. `npx tsc --noEmit` completo (CD-18) y
`biome check --write` sobre los archivos nuevos (CD-20).

---

## 9. Riesgos y residuo declarado

| # | Riesgo | Mitigación / declaración |
|---|---|---|
| R-1 | Un throw inesperado que escapa de `compose()` no pasa por el choke point ⟹ ese run no se registra. | **Residuo declarado.** No se envuelve en `try/catch` porque tragar una excepción del money-path para escribir telemetría es peor que perder una fila. Los casos conocidos vuelven como `ComposeResult` (los seis returns). |
| R-2 | El evento se emite fire-and-forget: si el insert falla, la fila no existe. | Igual que HU-203; queda el `log.error` como último registro. AC-9 lo exige y `T-STRAND-TRACK-THROWS` lo prueba. |
| R-3 | Un solo evento por run: si el mismo run pudiera reintentarse entero aguas arriba, habría dos filas con el mismo `compose_run_id`. | Hoy `composeRunId` es un UUID por **ejecución** de `compose()`, así que dos ejecuciones nunca comparten id; dos filas con el mismo id serían un bug y son detectables por query. Declarado. |
| R-4 | El snapshot de alerta es **por proceso**: con varias instancias, cada una computa lo suyo (misma verdad, leída de la misma base) pero el monitor pega sobre la que le toque. | Aceptable: la fuente es la base, no la memoria; el peor caso es un retraso de hasta un TTL. Declarado. |
| R-5 | TD-203-01 sigue abierta: `a2a_events` no tiene índice por `event_type`. La lista admin escanea. | La query **de la alerta** está acotada por `created_at` y usa `idx_a2a_events_created`. La lista admin hereda el mismo costo que `listSettleUnknown` ya tiene. **No se cierra acá** (necesita migración). |
| R-6 | La cota en la dimensión precio queda **abierta** mientras `PIPELINE_EXPOSURE_CEILING_USD` no se setee. | Declarado en §4.6 **con su motivo y su gatillo**, y el mecanismo va implementado y probado. |
| R-7 | El campo de `/health` es público. | Booleano de tres estados, sin números ni identificadores (CD-11); mismo nivel de exposición que el `degraded` del facilitator. |
| R-8 | Conflicto de merge con WKH-305 en `compose.ts`. | §11: 305 mergea primero; el diff de esta HU es de método-envoltura + claves de `metadata`, con solape mínimo con el bloque de débito que 305 mueve. |

---

## 10. Scope

**IN** — leaf `stranded-payment.ts`; envoltura + `recordStrandedRunIfAny` +
`compose_run_id`/`step` en la metadata de los `track()` existentes; techo de
exposición enchufado en el guard de presupuesto (apagado por default);
`listStrandedRuns` + `countStrandedExposureSince` + `AmbiguousReport.strandedRuns`;
`stranded-alert.ts` + campo aditivo en `/health`; script recomputable; doc (runbook,
`.env.example` × 2); tests.

**OUT** — WKH-305 (CD-5) · cualquier saldo/crédito/recarga/liquidación diferida
(CD-1) · remediación automática (CD-4) · endpoint/tabla/cola nueva (CD-2) ·
`wasiai-facilitator` · migraciones de base (incluida la de TD-203-01) · UI nueva del
panel más allá del JSON que ya sirve la ruta · cambiar el cobro de `remit-*` /
`agentshop-*` (ya cobran por llamada y así se quedan) · modificar
`health-monitor.mjs`/`alerts.mjs` (se reusan tal cual; lo único que cambia es una
clave del JSON de env, documentada).

---

## 11. Dependencias, orden de merge y estado del árbol

- **WKH-305 va primero.** Su SDD §1 lo dice explícitamente ("por eso esta HU va antes
  que ella") y se respeta. Consecuencia de **dimensionamiento**: después de 305, el
  débito ocurre con la entrada ya construida y validada, así que **toda la familia de
  fallos por entrada mala desaparece de raíz**. El residuo real que esta HU mide es,
  por lo tanto, **más chico** que el de hoy y está compuesto por fallos genuinos de
  ejecución (agente caído, timeout, proveedor que responde mal). El umbral de AC-5 se
  calibra sobre ese universo, no sobre el actual. Esta HU **no toca** ese código (CD-5).
- **Beneficio del choke point**: el `return` nuevo de 305 (`INPUT_MAPPING_FAILED`)
  queda cubierto automáticamente, sin una línea extra.
- ⚠️ **Estado del árbol al escribir este SDD**: `git status` muestra
  `M src/types/index.ts` y `?? src/lib/compose-input-mapping.ts` — **WKH-305 está en
  vuelo, sin commitear, en este mismo working tree**. Implicancias operativas:
  (a) CD-17 es crítico: nada de `git checkout --` durante la verificación por
  mutación; (b) el baseline de 3996/19 se re-mide sobre el árbol ya con 305 mergeada
  antes de abrir W0; (c) no se corre la suite completa mientras otro agente escribe
  en `src/`.
- **Sin overlap** con la fila 189 (P1-FIX-PACK: `discovery.ts`/`discovery-query.ts`/
  `downstream-skip-code.ts`).

---

## 12. Missing Inputs — RESUELTOS

| Missing Input (work-item) | Resolución |
|---|---|
| `[bloqueante F2]` ¿existe o debe crearse un techo de `agent.priceUsdc`? | **Resuelto en §4.6.** No existe (verificado). No se crea un techo **por agente** (rechazaría agentes legítimos del catálogo y es una decisión de producto que nadie pidió); se crea un techo **de exposición por pipeline**, enchufado en el guard de presupuesto que ya corta antes del débito y del invoke, **apagado por default**, con gatillo escrito para encenderlo con dato real. La dimensión precio queda **declarada como cota abierta** hasta entonces, con su motivo. |
| `[bloqueante F2]` mecanismo exacto de correlación de run | **Resuelto en §4.1/§4.3 (DT-4).** La correlación se hace **en proceso** (el `ComposeResult` ya trae todos los steps), y `compose_run_id` viaja en `metadata` (jsonb, aditivo, sin migración) como **clave de join** hacia el `compose_step` que sí identifica al agente que rompió el pipeline. |
| `[NEEDS CLARIFICATION]` umbral numérico de AC-5 | **Resuelto en §4.5**, y es **fundamentado, no elegido a dedo**: se expresa en la misma unidad que la cota de AC-1 (USD de exposición acumulada), el valor recomendado es `10 × cota` por ventana de 60 min (= 15× el período de poleo del monitor), y **se recomputa con el mismo script** que la cota (CD-6). Sin configurar ⟹ feature OFF, cero costo. Queda ratificable en `SPEC_APPROVED` cambiando un número, sin tocar código. |
| `[dependencia]` WKH-305 | §11. Declarada, no bloqueante para el desarrollo; sí para el merge. |

**Cero `[NEEDS CLARIFICATION]` abiertos en este SDD.**

---

## 13. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todos los ACs del work-item mapeados a diseño y a ≥ 1 test | ✅ AC-1..AC-7 + AC-8..AC-10 derivados (§8.1) |
| 2 | Cero `[NEEDS CLARIFICATION]` / cero TBD | ✅ §12 |
| 3 | Exemplars verificados con `ls`/`grep`/`Read` (paths reales) | ✅ §3.2 — los 9 existen |
| 4 | Waves con W0 serial y gate de salida explícito | ✅ §7 |
| 5 | Mutantes especificados con test asesino, todos compilables | ✅ §8.2 (14) |
| 6 | Las 3 invariantes heredadas de la superficie tienen test propio | ✅ `T-STRAND-TRUNCATED`, `T-STRAND-NUMERIC`/`-QUERY`, `T-STRAND-ERROR` |
| 7 | CDs del work-item heredados íntegros | ✅ §6.1 (CD-1..CD-6) |
| 8 | Auto-blindaje histórico incorporado como CD | ✅ §6.3 (CD-13..CD-20) |
| 9 | Cero migraciones / cero cambios de esquema | ✅ §3.3 |
| 10 | Cero endpoints, tablas o colas nuevas | ✅ §4.4 (el handler de la ruta no cambia) |
| 11 | Cero cambios en decisiones de dinero | ✅ CD-7 + `T-READONLY-02` + `T-STRAND-BYTE-IDENTICO` |
| 12 | Canal de alerta = trípode existente, sin código nuevo en el monitor | ✅ §4.5 (una clave en `HEALTH_MONITOR_TARGETS`) |
| 13 | Cota computable + techo implementado + dimensión abierta declarada con motivo y gatillo | ✅ §4.6 |
| 14 | Ancla de neutralidad escrita y con candado ejecutable | ✅ DT-1 + AC-6 + `T-NEUTRALITY-01/02` |
| 15 | Riesgos y residuo declarados | ✅ §9 (R-1..R-8) |
| 16 | Orden de merge y estado del árbol declarados | ✅ §11 |
| 17 | Baseline de tests declarado | ✅ §8.3 (3996 passed / 19 skipped) |

**Veredicto: LISTO PARA `SPEC_APPROVED`.**
