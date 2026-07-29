# Story File — HU-306 (WKH-306): acotar y hacer visible el residuo de los pipelines que fallan a mitad de camino

> SDD: [`sdd.md`](sdd.md) · Work item: [`work-item.md`](work-item.md)
> Fecha: 2026-07-29 · Branch: `feat/190-wkh-306-visibilidad-pago-stranded`
> Baseline de tests: **4065 passed | 19 skipped**
>
> ⚠️ **El nombre de la carpeta miente.** Dice "prepago-agentes-propios" porque
> quedó del encargo original. **La HU pivoteó**: nada de prepago, saldos,
> recargas ni liquidación diferida. El banner del work-item lo explica. Si
> escribís la palabra `prepaid` en producción, rompiste la HU (CD-1) y hay un
> test que te lo va a decir (`T-NEUTRALITY-02`).
>
> **Este documento es el contrato.** El SDD es la justificación; no hace falta
> leerlo para implementar, pero cada `§N` de acá apunta ahí si querés el porqué.

---

## 1. Goal

Cuando `/compose` falla en el step `i`, la plata que ya salió on-chain hacia los
agentes de los steps `0..i-1` **no vuelve**, y hoy no queda registrada en ningún
lado durable: la única evidencia (`StepResult.downstreamTxHash`) muere con la
respuesta HTTP. Esta HU **no construye un riel de pago alternativo** (eso sería
prepago = ventaja estructural para los agentes de la casa). Hace tres cosas:

1. **Acotar** — la cota es una fórmula computable, no prosa; y el techo de
   exposición por pipeline queda **implementado, probado y apagado** (§5).
2. **Hacer visible** — un evento durable por run afectado + una lista **anidada
   dentro de la superficie admin que el operador ya abre**.
3. **Que no crezca en silencio** — un indicador de tres estados en `/health` que
   el health-monitor del trípode ya sabe leer.

Superficie de **SOLO LECTURA**: nada se reembolsa, reclama ni compensa.

---

## 2. Acceptance Criteria (los que QA verifica en F4)

Copiados del SDD §2.1/§2.2. No se reescriben.

| # | AC |
|---|---|
| **AC-1** | Cota máxima de exposición por pipeline **verificable por código** (derivada de `MAX_COMPOSE_STEPS` + el techo que esta HU implementa), no un número a mano en un documento. |
| **AC-2** | WHEN un pipeline falla en el step `i > 0` DESPUÉS de que al menos un step previo del MISMO run completó su settle downstream (`downstream.txHash` presente), THEN registrar ese pipeline como "pago stranded" en la superficie de reconciliación existente, correlacionando los steps del mismo run. |
| **AC-3** | Exponer por pipeline stranded, como mínimo: id del run, los steps que pagaron on-chain (agente, monto, txHash) y el step que falló — con el MISMO contrato de completitud ya candado (`total` exacto, `truncated`, sin lista independiente). |
| **AC-4** | IF la consulta del listado falla, THEN **propagar el error (throw)**, jamás devolver `[]`. |
| **AC-5** | WHEN la exposición acumulada en una ventana supera un umbral documentado, THEN emitir señal observable reusando un canal ya activo. |
| **AC-6** | Preservar el **pago por llamada como el ÚNICO método de cobro** para TODOS los agentes, propios y de terceros, sin distinción. |
| **AC-7** | Superficie de SOLO LECTURA — cero remediación automática. |
| **AC-8** | Contar TAMBIÉN el settle inbound x402 (`StepResult.txHash`), no sólo el downstream: en el camino sin `a2aKey` ese hash es un pago on-chain real al `payTo` del agente. AC-2 es el subconjunto mínimo; AC-8 lo amplía. |
| **AC-9** | IF el registro no se puede persistir (`eventService.track` rechaza), THEN devolver el MISMO `ComposeResult` que sin esta HU. |
| **AC-10** | WHEN el pipeline NO falla, o falla sin que nadie haya pagado, THEN comportamiento **byte-idéntico** a hoy: cero eventos nuevos, cero queries nuevas, misma respuesta. |

---

## 3. ⛔ EL PUNTO DE ESTRANGULAMIENTO ÚNICO — criterio de salida, no advertencia

### 3.1 Qué es

`composeService.compose()` tiene **siete** `return { success: false … }` dentro
del loop de steps (el SDD contó seis; WKH-305 agregó el séptimo,
`INPUT_MAPPING_FAILED` — lo cual **confirma** el argumento en vez de refutarlo).
Envolver los siete sería siete oportunidades de olvidarse uno, hoy y en cada HU
futura. En su lugar, **el cuerpo actual se renombra y `compose()` pasa a ser una
envoltura**:

```
compose(request)                    ← público, MISMA firma, MISMO nombre
  ├─ runId = randomUUID()           ← el composeRunId sube un nivel
  ├─ result = await this.executePipeline(request, runId)   ← el cuerpo de HOY, intacto
  ├─ if (!result.success) this.recordStrandedRunIfAny(runId, result)  ← fire-and-forget
  └─ return result                  ← el MISMO objeto, sin tocar
```

Los siete returns de fallo, por **ancla de contenido** (verificá que los siete
sigan existiendo antes de tocar nada; si el conteo no da, **PARÁ y escalá**):

| # | Ancla de contenido en `src/services/compose.ts` |
|---|---|
| 1 | ``error: `Agent not found: ${step.agent}` `` |
| 2 | `errorCode: 'SCOPE_DENIED',` (dentro del bloque `if (scopingKeyRow) {`) |
| 3 | `errorCode: 'INPUT_MAPPING_FAILED',` — **de WKH-305**, cubierto gratis |
| 4 | ``error: `Budget exceeded: would need ${totalCost + agent.priceUsdc + stepGasOverhead}, max is `` |
| 5 | ``error: `Step ${i} debit failed: ${debitResult.error ?? 'insufficient budget'}` `` |
| 6 | ``error: `Step ${i} failed after retry: ${firstError} | retry: ${retryError}` `` |
| 7 | ``error: `Step ${i} failed: ${firstError}` `` |

El return de éxito es el que termina en
`verificationStatus: summarizePipelineVerification(results),`.

### 3.2 Por qué funciona sin tocar nada más

- `results` **sólo** se puebla en `finishSuccessfulStep` (ancla: `results.push(result);`)
  ⟹ `result.steps.length` **es** el índice del step que falló. No hay que
  reconstruir nada por query.
- `composeRunId` se genera hoy una vez por invocación de `compose()`
  (ancla: `const composeRunId = randomUUID();`). Moverlo a la envoltura y
  pasarlo como parámetro **no cambia la semántica**: sus dos usos
  (``` `${composeRunId}:${i}` ``` como `intentId` del leg Solana, y
  `operationId: composeRunId` en `refundIdemKey`) quedan byte-idénticos.
- `this.resolveAgent` / `this.invokeAgent` / `this.finishSuccessfulStep` siguen
  resolviendo porque `executePipeline` vive en el MISMO object literal y se
  llama como `this.executePipeline(...)`.
- Los dos callers externos (`src/routes/compose.ts`, ancla
  `const result = await composeService.compose({`, y `src/services/orchestrate.ts`,
  ancla `const pipeline = await composeService.compose({`) invocan como método
  ⟹ el `this` se preserva. **No los toques.**

### 3.3 ⛔ CRITERIO DE SALIDA DEL DEV (no es una advertencia — es el gate)

> **El dev NO declara W1 terminada hasta poder afirmar, con el diff en la mano:
> `git diff src/services/compose.ts` contiene EXACTAMENTE tres clases de cambio
> y ninguna más.**
>
> 1. El **split** `compose()` → envoltura + `executePipeline(request, runId)`,
>    donde el cuerpo movido es idéntico salvo la firma y `composeRunId` como
>    parámetro.
> 2. **Claves nuevas agregadas** a los objetos `metadata:` de los `track()` que
>    YA existen.
> 3. En W4, la **sustitución del guard de `maxBudget`** descrita en §5.2 — y
>    nada más.
>
> **Si el diff toca cualquier decisión de dinero, es BLOQUEANTE.** Decisión de
> dinero = un débito, un refund, un crédito, un settle, la retención de HU-203,
> el guard `i > 0`, `startTime`, el orden de las operaciones, `stepDestination`,
> las claves de idempotencia, o el contenido de cualquier `return` existente
> fuera de lo listado arriba. No es "revisable en AR": es motivo de rechazo.
>
> **Cómo se demuestra, no cómo se promete:** en el reporte de W1, pegá el
> `git diff --stat` y la lista de hunks de `compose.ts` con una línea por hunk
> diciendo a cuál de las tres clases pertenece. Un hunk sin clasificar = W1 no
> está terminada.

CD asociado: **CD-7**.

---

## 4. El indicador de tres estados — "no sé" cuenta como alerta

`/health` gana **un** campo aditivo, público, booleano-de-tres-estados:

| Valor | Significado |
|---|---|
| campo **ausente** | el umbral no está configurado ⟹ feature OFF ⟹ **cero queries**, `/health` byte-idéntico a hoy |
| `false` | **se computó** y NO hay breach |
| `true` | breach: la exposición acumulada en la ventana superó el umbral |
| `'unknown'` | **no se puede afirmar** que no haya breach: nunca se computó, la última computación falló, o el dato está rancio |

**Por qué `'unknown'` y no `false`.** Es la misma doctrina que AC-4, aplicada al
tercer pilar. AC-4 dice que una lista vacía por error de base se lee igual que
"no hay nada retenido", que es la peor mentira posible. Un `false` por caída de
la base dice **"no hay nada que reportar"** en el único canal que existe para
gritarlo. Una caída de la base **no es** ausencia de problema: es ausencia de
información, y las dos cosas no se escriben igual.

`'unknown'` es **truthy** ⟹ el `degradedPath` del health-monitor lo lee como
degradado y alerta con severidad `warning` (ancla en
`mcp-servers/wasiai-x402/src/health-monitor.mjs`:
`if (_getPath(res?.json, target.degradedPath)) {`, que devuelve
`{ severity: 'warning', reason: 'health-degraded' … }` **sin importar el tier**).
Eso es exactamente lo correcto: hay plata para reconciliar, no hay un outage.

**Activación = una clave más en un JSON de env.** El gateway ya es target P0 del
monitor (ancla en `mcp-servers/wasiai-x402/.env.example`:
`HEALTH_MONITOR_TARGETS=[{"label":"gateway-a2a"`), y el target `facilitator` de
esa misma línea ya usa `"degradedPath":"degraded"`. **Cero código nuevo en el
monitor, cero cron nuevo, cero webhook nuevo.**

CDs asociados: **CD-6 (unknown ≠ false)**, **CD-10 (sin `await` a la base ni
`setInterval` en `/health`)**, **CD-11 (nada más que el booleano: es público)**.

---

## 5. La cota — qué queda cerrado y qué queda **abierto a propósito**

### 5.1 Lo cerrado

`src/lib/stranded-payment.ts` (leaf):

```ts
export const MAX_STRANDABLE_STEPS = MAX_COMPOSE_STEPS - 1;   // 4 — DERIVADO, no literal
export function maxStrandedExposureUsd(maxStepPriceUsd: number): number {
  return MAX_STRANDABLE_STEPS * maxStepPriceUsd;
}
export function recommendedAlertThresholdUsd(maxStepPriceUsd: number): number {
  return 10 * maxStrandedExposureUsd(maxStepPriceUsd);
}
```

`- 1` porque el step que falla no deja residuo por sí mismo: si SU settle quedó
sin resolver, eso ya es la cola de HU-203 (`compose_settle_unknown`), que es otra
pregunta y otra lista. Se **deriva** de `MAX_COMPOSE_STEPS` (ancla:
`export const MAX_COMPOSE_STEPS = 5;` en `src/lib/compose-limits.ts`) y no se
escribe `4` a mano, por el motivo que ese mismo archivo documenta: dos números
sueltos divergen en silencio.

### 5.2 El mecanismo del techo, entregado y **apagado**

```ts
// leaf, puro, lee env en CADA llamada (patrón getDriftThresholdAtomic)
export function resolveEffectivePipelineBudgetUsd(
  callerMaxBudget: number | undefined,
): number   // = min(callerMaxBudget || +Infinity, PIPELINE_EXPOSURE_CEILING_USD || +Infinity)
```

Se enchufa en el guard de presupuesto que **ya existe y ya corta antes del
débito y antes del invoke** (ancla del guard actual en `compose.ts`:
``if (\n        maxBudget &&\n        totalCost + agent.priceUsdc + stepGasOverhead > maxBudget\n      )``).
Sustitución exacta:

```ts
const effectivePipelineBudget = resolveEffectivePipelineBudgetUsd(maxBudget);
const wouldNeed = totalCost + agent.priceUsdc + stepGasOverhead;
if (wouldNeed > effectivePipelineBudget) {
  const ceilingBinds = !maxBudget || effectivePipelineBudget < maxBudget;
  return {
    success: false, output: null, steps: results,
    totalCostUsdc: totalCost, totalLatencyMs: totalLatency,
    error: ceilingBinds
      ? `Budget exceeded: would need ${wouldNeed}, max is ${effectivePipelineBudget} (gateway pipeline exposure ceiling)`
      : `Budget exceeded: would need ${wouldNeed}, max is ${maxBudget}`,
  };
}
```

- Env **sin setear** + `maxBudget` sin setear ⟹ `+Infinity` ⟹ el guard nunca
  dispara ⟹ **byte-idéntico**, incluido que `maxBudget: 0` sigue significando
  "sin límite" (`0 || Infinity`).
- Env sin setear + `maxBudget` presente ⟹ `ceilingBinds === false` ⟹ el mensaje
  es **string por string el de hoy**. El test existente que hace
  `expect(result.error).toContain('Budget exceeded')` en
  `src/services/compose.test.ts` sigue verde por el motivo correcto.
- **NO agregues un `errorCode` nuevo.** Sería tocar el union de
  `ComposeResult.errorCode` en `src/types/index.ts`, que es **la línea que
  WKH-305 está editando ahora mismo** (ver §9). El mensaje distinguible alcanza.

### 5.3 Lo que queda abierto, con motivo y gatillo — **el dev NO lo cierra**

| Dimensión | ¿Acotada hoy? |
|---|---|
| Cantidad de steps | **SÍ**, ≤ 4 |
| Presupuesto del caller (camino agent-key) | **SÍ** — cada step `i>0` debita antes de invocar |
| `maxBudget` declarado | **SÍ, si lo declara** |
| **Precio por agente** | **NO** — no existe techo en el repo (verificado: cero `MAX_PRICE`/`PRICE_CAP` en producción) |
| Camino x402 anónimo | **NO** — sin `scopingKeyRow` no hay débito per-step |

> ⛔ **`PIPELINE_EXPOSURE_CEILING_USD` se entrega SIN SETEAR y eso es la entrega
> correcta.** Elegir el número hoy sería fijarlo **sin un solo dato de exposición
> real** — y medir ese dato es el motivo de existir de esta HU. Un techo
> demasiado bajo **rechaza tráfico legítimo y ya pagado**, que es un daño mayor
> y de signo opuesto al que se quiere evitar.
>
> **El dev no tiene que "completar" nada acá.** Si te encontrás eligiendo un
> número, pará: estás cerrando con una corazonada la pregunta que la HU existe
> para responder con datos. El entregable es **el mecanismo**, no el valor.
>
> **Gatillo (va escrito al runbook, W4.3):** con 2 semanas de `strandedRuns` con
> tráfico real, correr `scripts/report-stranded-exposure.mjs` y setear
> `PIPELINE_EXPOSURE_CEILING_USD = 10 × cota_observada`. Mientras esté sin
> setear, **la cota en la dimensión precio es una medición de hoy, no una
> garantía**, y así tiene que estar escrito en el runbook — no "pendiente", no
> "TODO": declarado con su motivo.

---

## 6. Archivos — acción, qué hace, **ancla por contenido**

> Regla dura: **anclas por contenido, nunca por línea** (CD-15). Si un ancla no
> aparece donde este documento dice, **PARÁ y escalá**: significa que el árbol se
> movió (probable: WKH-305, §9).

### W0 — contrato + leaf puro

| Archivo | Acción | Qué hace | Ancla / exemplar |
|---|---|---|---|
| `src/lib/stranded-payment.ts` | **Crear** | Leaf. Exporta `COMPOSE_STRANDED_PAYMENT_EVENT = 'compose_stranded_payment'`, `MAX_STRANDABLE_STEPS`, `maxStrandedExposureUsd`, `recommendedAlertThresholdUsd`, `collectStrandedSteps`, `buildStrandedPaymentEvent`, `readStrandedMetadata`, `resolveEffectivePipelineBudgetUsd`. **Único import de runtime: `./compose-limits.js`.** Sólo `import type` para `StepResult`. **Nunca tira.** | Molde: `src/lib/settle-withholding.ts` — anclas `export const COMPOSE_SETTLE_UNKNOWN_EVENT = 'compose_settle_unknown';` y `export function buildSettleUnknownEvent(input: {`. Docstring de leaf: `src/lib/compose-limits.ts` |
| `src/services/reconciliation.ts` | Modificar (**sólo tipos**) | `StrandedPaidStep`, `StrandedRunRow`, `StrandedRunsReport`, `StrandedRunSelectRow`, y el campo `strandedRuns: StrandedRunsReport` dentro de `AmbiguousReport` | Anclas: `export interface AmbiguousReport {`, `settleUnknown: SettleUnknownReport;`, `export interface SettleUnknownEventRow {`, `interface SettleUnknownSelectRow {` |
| `src/lib/stranded-payment.test.ts` | **Crear** | Unit del leaf | — |

**Por qué el leaf es obligatorio**: `src/services/compose.test.ts` mockea módulos
enteros sin `importOriginal` (ancla: `vi.mock('../lib/downstream-payment.js', () => ({`,
con el comentario que explica que todo export no listado queda `undefined`). Un
leaf sin dependencias no puede quedar `undefined` en ninguna suite porque nadie
lo mockea.

### W1 — detección y registro (depende de W0)

| Archivo | Acción | Qué hace | Ancla |
|---|---|---|---|
| `src/services/compose.ts` | Modificar | (a) split envoltura/`executePipeline`; (b) `recordStrandedRunIfAny`; (c) `compose_run_id` + `step` como **claves nuevas** en los `metadata` de los tres `track()` existentes | Split: `async compose(request: ComposeRequest): Promise<ComposeResult> {` y `const composeRunId = randomUUID();`. `track` éxito: `...(retried && { retried: true }), // DT-8`. `track` fallo 1: `...(willRetry && { retry_attempted: true }),`. `track` fallo 2: `retry_failed: true, // DT-8` |
| `src/lib/settle-withholding.ts` | Modificar | `buildSettleUnknownEvent` acepta un `composeRunId?` opcional y lo mete en `metadata.compose_run_id`. **Aditivo**: sin el campo, la forma es la de hoy | Ancla: `export function buildSettleUnknownEvent(input: {` y `metadata: {` con `withholder: input.withholder,` |
| `src/services/compose.stranded.test.ts` | **Crear** | Emisión, neutralidad, no-regresión, techo | Harness a copiar de `src/services/compose.test.ts`: `function makeAgent(o: Partial<Agent> = {}): Agent {`, `vi.mock('./event.js', () => ({`, y el patrón de downstream de `mockDownstream.mockResolvedValue({` |

**Qué cuenta como stranded** (`collectStrandedSteps`, puro): un item por step
COMPLETADO con evidencia on-chain — `downstreamTxHash` no vacío ⟹ `'downstream'`;
`txHash` no vacío ⟹ `'inbound'` (AC-8); ambos ⟹ `'both'`. Lista vacía ⟹ **no se
emite nada** (AC-10). Lista no vacía **y** `result.success === false` ⟹ UN evento
por run.

**El evento** (`buildStrandedPaymentEvent`, puro):
`status: 'failed'`; `costUsdc` = Σ de `costUsdc` de los steps stranded (**USD, no
atómico**: `downstreamSettledAmount` es atómico y los decimals de la cadena del
leg no viajan en `StepResult` — inventarlos sería fabricar un número de dinero);
`txHash` = el del **primer** step stranded, **y el docstring TIENE que decir que
es el primero de N y que la lista completa vive en `metadata.paid_steps`** (una
columna que dice "el primero de varios" sin declararlo miente por omisión);
`agentId`/`agentName`/`registry` = **`null` a propósito** (el agente que rompió
el pipeline no está en `ComposeResult`, sólo su índice — poner ahí al primero que
cobró haría que el panel señale al agente equivocado durante un incidente; se
recupera por join con `compose_run_id`);
`metadata`: `compose_run_id`, `failed_step_index` (= `steps.length`),
`error_code`, `error` truncado a 500 chars, `stranded_usd` (redundante a
propósito: si diverge de `cost_usdc` leído con `::text`, hay un bug de precisión
— lección WKH-196), y `paid_steps[]` con
`{ step, agent_slug, registry, chain, cost_usdc, settled_atomic, tx_hash, evidence }`
(`settled_atomic` **verbatim, sin convertir**).

**Emisión**: `eventService.track(...).catch(logError)`, fire-and-forget, igual
que `recordSettleWithheld` (ancla: `const recordSettleWithheld = (`). **CD-9:
prohibido `await`-earla en el camino de la respuesta.**

### W2 — superficie de lectura (depende de W0; paralela a W4)

| Archivo | Acción | Qué hace | Ancla |
|---|---|---|---|
| `src/services/reconciliation.ts` | Modificar | `listStrandedRuns()` espejando `listSettleUnknown()`; `listAmbiguous()` la llama **en serie** y la anida en `strandedRuns` | `async listSettleUnknown(): Promise<SettleUnknownReport> {`, `.in('event_type', [...SETTLE_UNKNOWN_EVENT_TYPES])`, `const settleUnknown = await this.listSettleUnknown();`, `const AMBIGUOUS_LIST_LIMIT = 500;` |
| `src/routes/dashboard.ts` | Modificar (**sólo docstring**) | Agregar el párrafo de `strandedRuns` al docstring de la ruta. **Cero cambio de código**: la lista va anidada, el handler no se toca | `HU-203 suma \`ambiguous.settleUnknown\`` y `'/api/reconciliation',` |
| `src/services/reconciliation.test.ts` | Modificar | Refactor del doble (§7) + los candados nuevos | `function wireIntents(`, `const isEvents = table === 'a2a_events';` |

Las tres invariantes **se heredan tal cual y ninguna se puede debilitar**:
`{ count: 'exact' }` + `order('created_at', { ascending: false })` +
`.limit(AMBIGUOUS_LIST_LIMIT)`; `truncated: total > rows.length`; y
`if (error) { log.error(...); throw new ReconciliationError('INTERNAL'); }`.
`cost_usdc::text` obligatorio (WKH-196). **NO gateada por
`isEscrowSettleEnabled()`** — gatearla la dejaría vacía justo cuando importa.

`StrandedRunRow` espeja `SettleUnknownEventRow`: columnas reales tipadas +
`metadata` **verbatim** + tres campos derivados (`runId`, `failedStepIndex`,
`paidSteps`) leídos con `readStrandedMetadata`, que es **DEFENSIVO y puro**:
ante una forma inesperada devuelve `null` / `[]` y **nunca tira**. Una fila vieja
o mal formada que voltee la lista entera sería devolver `[]` por otra puerta
(CD-12).

**CD-8: PROHIBIDO** agregar `compose_stranded_payment` a
`SETTLE_UNKNOWN_EVENT_TYPES`. Son preguntas distintas ("el settle quedó sin
resolver" vs "el settle se confirmó y el pipeline falló después"); mezclarlas
corrompe la lista de HU-203.

### W3 — alerta (depende de W2)

| Archivo | Acción | Qué hace |
|---|---|---|
| `src/services/reconciliation.ts` | Modificar | `countStrandedExposureSince(sinceIso)` → `{ runs, exposureUsd, truncated }`. Misma doctrina: **throw** ante error de query |
| `src/services/stranded-alert.ts` | **Crear** | Config por env, snapshot en memoria, refresh en background, `getStrandedHealthField()`, log `alert:` en la transición a breach |
| `src/index.ts` | Modificar | **Una línea**: `...getStrandedHealthField(),` dentro del `reply.send({` del `/health` |
| `src/__tests__/e2e/setup.ts` | Modificar | **La misma línea** — el handler de `/health` está **duplicado** ahí |
| `src/__tests__/e2e/e2e.test.ts` | Modificar | `T-HEALTH-SHAPE` |
| `src/services/stranded-alert.test.ts` | **Crear** | Snapshot, TTL, unknown, OFF |
| `doc/operations/oncall-runbook.md`, `.env.example`, `mcp-servers/wasiai-x402/.env.example` | Modificar | Fila del `degradedPath` + envs nuevas |

> **Decisión de Architect en F2.5 (desviación declarada del SDD §7 W3.3).** El
> SDD listaba sólo `src/index.ts`. Al verificar el árbol encontré que el handler
> de `/health` está **duplicado literal** en `src/__tests__/e2e/setup.ts` (ancla:
> `// Health endpoint (same as index.ts)`), porque `src/index.ts` hace
> `await initAdapters()` a nivel de módulo y no es importable desde un test. Si
> sólo se toca `index.ts`, el campo **no es testeable end-to-end** y las dos
> copias divergen en silencio. Por eso: `getStrandedHealthField()` devuelve
> `{}` cuando el umbral no está configurado, y **las dos copias hacen el mismo
> spread de una línea**. El ancla del test existente a respetar es
> `it('AC-10: GET /health returns 200 with status and uptime'`.

**Cómo se computa, sin costo en el request path**: snapshot en memoria; `/health`
lo lee **sincrónicamente** y, si está rancio, dispara
`void refresh().catch(...)`. **Nunca** un `await` a la base en el handler, nunca
tira, y **como mucho una query por `REFRESH_MS` (60 s)** aunque `/health` reciba
miles de hits. **Sin `setInterval`** (filtra en tests y en shutdown). CD-10.

**El umbral**: en **USD de exposición acumulada**, misma unidad que la cota de
AC-1. Recomendado `10 × cota` por ventana de **60 min** (= 15× el período de
poleo del monitor, así que un breach se ve muchas veces antes de despejarse).
Envs: `STRANDED_EXPOSURE_ALERT_THRESHOLD_USD` (ausente/inválido ⟹ **OFF**;
patrón `getDriftThresholdAtomic`, ancla `function getDriftThresholdAtomic(): bigint {`)
y `STRANDED_EXPOSURE_ALERT_WINDOW_MIN` (default 60).

> **Decisión de Architect en F2.5 (detalle que el SDD §4.5 dejó implícito).**
> supabase-js **no puede hacer `SUM`** sin un RPC, y esta HU no crea RPCs.
> `countStrandedExposureSince` hace `select('cost_usdc::text', { count: 'exact' })`
> acotado por `event_type` + `created_at >= sinceIso`, con
> `.limit(AMBIGUOUS_LIST_LIMIT)`, y **suma en JS**. Consecuencia honesta: si
> `truncated`, `exposureUsd` es una **cota inferior**. Regla de lectura:
> `breached = truncated || exposureUsd > thresholdUsd` — 500 runs stranded en una
> ventana de 60 min ya es sistémico por definición, así que un truncamiento
> **nunca** puede producir un `false`. Test: `T-ALERT-LOWER-BOUND`.

**Segundo consumidor, gratis**: en cada transición a breach,
`log.error({ alert: 'COMPOSE_STRANDED_PAYMENT_EXPOSURE_HIGH', windowMin, thresholdUsd, exposureUsd, runs }, …)`
— el idiom del repo. Así la señal existe en los logs aunque el JSON de targets
todavía no se haya actualizado.

### W4 — cota (depende de W0 y de W1 por el archivo; paralela a W2/W3)

| Archivo | Acción | Qué hace |
|---|---|---|
| `src/services/compose.ts` | Modificar | **Sólo** la sustitución del guard de §5.2 |
| `scripts/report-stranded-exposure.mjs` | **Crear** | `GET /discover` (libre), `max(priceUsdc)` del catálogo vivo, imprime `MAX_STRANDABLE_STEPS`, la cota y el umbral recomendado. **Si no alcanza el gateway: exit ≠ 0 con mensaje accionable, NUNCA un número por defecto** (un número inventado en un reporte de exposición es peor que ningún número) |
| `doc/operations/oncall-runbook.md` | Modificar | La cota + **el gatillo de §5.3** + qué dimensión queda abierta y por qué |

Exemplar del script: `scripts/smoke-capabilities-schema.mjs` — anclas
`const BASE =\n  process.argv[2] ||` y el helper `const ok = (label, cond, detail = '') => {`.
`fetch` pelado, cero dependencias.

**Paralelismo**: `W0 → W1 → { W2 → W3 , W4 }`. **W1 y W4 tocan `compose.ts` ⟹
van en serie entre sí.** W2/W3 y W4 sí son paralelos entre sí.

---

## 7. ⚠️ La trampa del doble de test — leela antes de escribir un solo assert

`listAmbiguous()` hoy hace **dos** queries (una a `a2a_payment_intents`, una a
`a2a_events`). Con esta HU pasa a hacer **tres**: la segunda y la tercera son
**sobre la MISMA tabla `a2a_events`** (settleUnknown y strandedRuns).

El doble actual **captura por tabla** (ancla en `src/services/reconciliation.test.ts`:
`const isEvents = table === 'a2a_events';` con `const target = isEvents ? events : cap;`).
Con dos queries sobre esa tabla:

- `events.cols` y `events.countOpt` los **pisa la segunda** ⟹ `T-203-SU-NUMERIC`
  (`expect(cap.events.cols).toContain('cost_usdc::text')`) puede quedar verde
  **por las columnas de la query nueva**, no por las suyas;
- el `payload` es **compartido** ⟹ las dos queries devuelven las **mismas filas**
  ⟹ un test de `strandedRuns` "pasa" leyendo filas de `settleUnknown`.

En los dos casos el candado queda **verde por el motivo equivocado**, que es
peor que rojo: afirma una protección que no existe.

> **Este error ya está documentado**: es literalmente el que HU-203 dejó escrito
> en el propio archivo — *"HU-203: `listAmbiguous()` hace DOS queries sobre DOS
> tablas, así que la captura es POR TABLA. Con una sola, la segunda query pisaba
> la forma de la primera y los candados de HU-201 (`cap.table`, `cap.cols`)
> pasaban a afirmar cosas sobre la query equivocada — verdes por el motivo
> incorrecto."* Repetirlo un nivel más abajo sería no haber leído el comentario
> que ese bug dejó escrito.

**Obligatorio (CD-23)**: `wireIntents` pasa a capturar **por tabla Y por orden de
llamada** — un **array** de `Captured` por tabla, y un payload por índice de
llamada:

```ts
function wireIntents(
  rows: unknown[],
  count: number | null,
  opts: {
    eventCalls?: Array<{ rows?: unknown[]; count?: number | null; error?: { message: string } }>;
  } = {},
): Captured & { events: Captured[] } { /* … */ }
```

Y **antes de escribir un assert nuevo**, re-apuntar los `T-203-SU-*` existentes
a `events[0]` explícitamente. El ancla a preservar es
`const [col, values] = cap.events.inCalls[0] ?? [];` — que pasa a ser
`cap.events[0]!.inCalls[0]`.

**Validación del propio refactor (§8.2, lección "desarmar el escenario"):**
después del refactor, hacé que `listStrandedRuns` lea **la misma tabla con el
mismo filtro** que `listSettleUnknown` y comprobá que `T-STRAND-QUERY` se pone
**rojo**. Si sigue verde, el doble todavía no discrimina y el refactor no está
hecho.

---

## 8. Constraint Directives

### 8.1 Heredadas del work-item (íntegras, no negociables)

- **CD-1 (PROHIBIDO)** — cualquier saldo prepago, crédito, recarga o liquidación
  diferida, para NINGÚN agente, propio o tercero. Pago por llamada, único método.
- **CD-2 (PROHIBIDO)** — endpoint, tabla o "cola" de admin nueva e independiente.
  Se extiende **aditivamente** la superficie existente.
- **CD-3 (OBLIGATORIO)** — toda query nueva del listado **tira**; jamás `[]`.
- **CD-4 (PROHIBIDO)** — remediación automática. SOLO LECTURA.
- **CD-5 (PROHIBIDO)** — resolver WKH-305 dentro de esta HU.
- **CD-6 (OBLIGATORIO)** — la fórmula de exposición es **re-computable por
  código** (test + script), no un número en prosa.

### 8.2 Del SDD

- **CD-7 (PROHIBIDO)** — tocar cualquier decisión de dinero de `compose.ts`. Ver
  §3.3: es **criterio de salida**, no advertencia. **BLOQUEANTE en AR.**
- **CD-8 (PROHIBIDO)** — agregar el `event_type` nuevo a `SETTLE_UNKNOWN_EVENT_TYPES`.
- **CD-9 (OBLIGATORIO)** — emisión fire-and-forget con `.catch()`; su fallo no
  puede cambiar el `ComposeResult`.
- **CD-10 (OBLIGATORIO)** — `/health` sin `await` a la base, sin `setInterval`, y
  no puede tirar.
- **CD-11 (PROHIBIDO)** — exponer en `/health` conteos, montos, ids o slugs. Sólo
  el booleano de tres estados. Es público.
- **CD-12 (OBLIGATORIO)** — el lector de `metadata` es defensivo y puro: nunca
  tira, nunca voltea la lista entera.

### 8.3 Del Auto-Blindaje histórico (obligatorias)

- **CD-13** — PROHIBIDO afirmar que un guard está protegido **por su cobertura de
  línea**. Se muta primero y se comprueba el rojo. — `190-p1-guards-sin-proteccion/auto-blindaje.md#Wave 1`
- **CD-14** — PROHIBIDO un test de dinero que sólo mire el status code o el spy.
  El efecto se asserta observable. — `208-compose-por-capacidad/auto-blindaje.md#Wave 2`
- **CD-15** — PROHIBIDO escribir un test o un comentario contra un `archivo:línea`
  heredado sin releer el archivo. Los punteros de este documento son **archivo +
  ancla de contenido**; si no coinciden, se reporta. — `190-p1-…#Wave 1`
- **CD-16** — OBLIGATORIO que **todo mutante COMPILE** antes de contarlo. "No
  tests" o "FAIL de parseo" es un **falso KILLED**. — `190-p1-…#Wave 2`
- **CD-17** — PROHIBIDO `git checkout --` sobre archivos con cambios sin
  commitear durante la verificación por mutación. Se **commitea, se muta, se
  restaura**. ⚠️ Crítico acá: ver §9.
- **CD-18** — OBLIGATORIO `npx tsc --noEmit` **completo** (incluye tests), no
  sólo `npm run build`. — lección WKH-196
- **CD-19** — OBLIGATORIO que un claim de "no agrega costo" se pruebe **contando
  I/O**, no sólo el efecto observable. Aplica a AC-10 y al claim "cero queries
  con el umbral OFF". — `208-…#Wave 3` (la mutación M5 sobrevivió por esto)
- **CD-20** — OBLIGATORIO `biome check --write` sobre los archivos nuevos **antes**
  de declarar los gates. — `190-p1-…#Wave 3`

### 8.4 Nuevas — de las HUs que cerraron mientras se escribía esta

- **CD-21 (OBLIGATORIO) — un mutante que sobrevive tiene DOS causas posibles, y
  hay que determinar empíricamente cuál es antes de escribir una línea.**
  (a) falta un test, o (b) **la mutación no era una mutación** (código
  equivalente, rama inalcanzable, o la línea mutada no se ejecuta en ningún
  escenario). Escribir un test para (b) produce un test que "mata" algo que no
  estaba vivo: verde decorativo. **Procedimiento:** ante un sobreviviente, primero
  instrumentá la línea mutada (un `throw` a propósito) y comprobá que **alguna**
  prueba la ejecuta. Si nada la ejecuta, el hallazgo es "rama sin cobertura
  alcanzable" y se reporta como tal, no se tapa con un assert.
- **CD-22 (OBLIGATORIO) — una aserción que existe para probar que el escenario
  está armado se valida DESARMANDO el escenario y viendo el rojo.** Es la
  mutación aplicada a los propios tests. Concretamente en esta HU: para
  `T-STRAND-EMIT-01`, sacá el `downstreamTxHash` del fixture del step 0 y
  verificá que el test **falla**; si sigue verde, el test no estaba probando la
  emisión sino la existencia del spy. Idem para `T-NEUTRALITY-01` (cambiá el
  monto de uno de los dos agentes y tiene que ponerse rojo) y para
  `T-ALERT-CACHE` (bajá el TTL a 0 y tiene que ponerse rojo).
- **CD-23 (OBLIGATORIO)** — el doble de `reconciliation.test.ts` discrimina **por
  tabla Y por orden de llamada** antes del primer assert nuevo (§7).

---

## 9. Estado del árbol y WKH-305 — leer antes del primer comando

**WKH-305 está EN VUELO, sin commitear, en este mismo working tree.** Al escribir
este documento, `git status` mostraba modificaciones sin commitear en
`src/services/compose.ts`, `src/lib/compose-input-mapping.ts`,
`src/routes/orchestrate.ts` y varios tests. **Ese archivo central del money-path
lo está escribiendo otro agente ahora mismo.**

Estado de 305: **pasó AR y CR sin bloqueantes**, está en su último fix-pack.

### Reglas operativas (no negociables)

1. **`git status` como primer comando de la HU**, antes de tocar nada. Si aparece
   `M src/services/compose.ts` y no es tuyo ⟹ **esperá**. No arranques W1.
2. **WKH-305 mergea primero.** Recién después se abre la branch de esta HU
   **desde el `main` ya con 305 adentro**. Motivo concreto, no ceremonial: el
   union `ComposeResult.errorCode` y el bloque de construcción del input son
   **suyos**; branchear antes garantiza conflicto sobre el money-path.
3. **El baseline de `4065 passed | 19 skipped` se RE-MIDE** sobre el árbol ya con
   305 mergeada, **antes** de abrir W0. El número de arriba es el de hoy, no una
   verdad permanente.
4. **PROHIBIDO `git checkout --`** en cualquier momento, y muy especialmente
   durante la verificación por mutación (CD-17). El ciclo es
   **commitear → mutar → correr → `git restore` SÓLO del archivo mutado y SÓLO
   si no tiene otros cambios**.
5. **PROHIBIDO tocar los untracked protegidos**: `contracts/.gas-snapshot`,
   `doc/audit/`, `doc/jury-qa*.md`, `doc/solana-labs/`, y cualquier
   `doc/sdd/NNN-*/` que no sea esta carpeta.
6. **No corras la suite completa** mientras otro agente escribe en `src/`.

### Dimensionamiento (por qué 305 importa para el número, no para el código)

305 mueve la construcción del input **antes** del débito ⟹ **toda la familia de
fallos "por entrada mala" desaparece de raíz** (hoy un step con input inválido
cobra igual). Por lo tanto **el residuo que esta HU mide es MÁS CHICO que el de
hoy**, y está compuesto por fallos genuinos de ejecución: agente caído, timeout,
proveedor que responde mal. **El umbral de AC-5 se calibra sobre ese universo, no
sobre el actual** — y ése es otro motivo por el que el número del techo (§5.3)
no se elige hoy: se elegiría sobre una población de fallos que está por dejar de
existir.

**Beneficio directo del choke point**: el `return` que 305 agregó
(`INPUT_MAPPING_FAILED`) queda cubierto **sin una línea extra**. Esa es la
prueba de que la envoltura era el diseño correcto (§3).

**CD-5 sigue firme**: esta HU **no toca** el código de 305.

---

## 10. Tests — qué afirma cada uno

| AC | Test | Qué **afirma** | Archivo |
|---|---|---|---|
| AC-1 | `T-COTA-01` | `MAX_STRANDABLE_STEPS === MAX_COMPOSE_STEPS - 1` **y** `=== 4`: la derivación **y** el valor de hoy (patrón `compose-limits`) | `stranded-payment.test.ts` |
| AC-1 | `T-COTA-02` | `maxStrandedExposureUsd(p) = pasos × p`, y `recommendedAlertThresholdUsd = 10 × cota` | idem |
| AC-1 | `T-CEILING-01` | con `PIPELINE_EXPOSURE_CEILING_USD` seteado, el step que lo excedería **no debita y no invoca** (`budgetService.debit` y `fetch` **no llamados**) | `compose.stranded.test.ts` |
| AC-1 | `T-CEILING-02` | env sin setear ⟹ el pipeline caro corre igual y el mensaje de error es **string por string** el de hoy | idem |
| AC-1 | `T-CEILING-03` | `maxBudget: 0` sigue significando "sin límite"; con ambos, ata el **menor** | `stranded-payment.test.ts` |
| AC-2 | `T-STRAND-EMIT-01` | step 0 con `downstreamTxHash` + step 1 que tira ⟹ **exactamente un** `track` con `event_type='compose_stranded_payment'` | `compose.stranded.test.ts` |
| AC-2 | `T-STRAND-EMIT-02` | falla el step 0, nadie pagó ⟹ **cero** eventos de ese tipo | idem |
| AC-2 | `T-STRAND-EMIT-03` | pipeline exitoso ⟹ **cero** eventos de ese tipo | idem |
| AC-2 | `T-STRAND-EMIT-04` | el corte por **débito fallido** (no por throw del invoke) con un step previo pagado **también** emite ⟹ el choke point cubre returns que no son excepciones | idem |
| AC-3 | `T-STRAND-FIELDS` | el `metadata` trae `compose_run_id`, `failed_step_index`, y `paid_steps[]` con `agent_slug`, `cost_usdc`, `tx_hash`, `settled_atomic` **verbatim** | idem |
| AC-3 | `T-STRAND-JOIN` | el `compose_step` del MISMO run lleva el MISMO `compose_run_id` **y** su `agent_id` ⟹ el agente culpable es recuperable por join | idem |
| AC-3 | `T-STRAND-QUERY` | lee `a2a_events` filtrando por el `event_type` **nuevo** — no otra tabla, no otro filtro (§7: contra `events[1]`) | `reconciliation.test.ts` |
| AC-3 | `T-STRAND-TRUNCATED` / `-NOT-TRUNCATED` | `total` exacto vía `{count:'exact'}` y `truncated` correcto **en ambos sentidos** | idem |
| AC-3 | `T-STRAND-NUMERIC` | el select pide `cost_usdc::text` (WKH-196) | idem |
| AC-3 | `T-STRAND-NESTED` | `listAmbiguous()` devuelve `strandedRuns` anidado **y** `rows`/`settleUnknown` **intactos** | idem |
| AC-4 | `T-STRAND-ERROR` | error de query ⟹ **tira** `ReconciliationError('INTERNAL')`, NO `[]` | idem |
| AC-4 | `T-STRAND-ERROR-PROPAGA` | ese throw **sube** por `listAmbiguous()` (nadie lo traga con un `try` interno) | idem |
| AC-5 | `T-ALERT-BREACH` / `-NO-BREACH` | exposición > umbral ⟹ `true` **+ log `alert:`**; ≤ umbral ⟹ `false` **y sin log** | `stranded-alert.test.ts` |
| AC-5 | `T-ALERT-UNKNOWN` | query que falla / snapshot rancio / nunca computado ⟹ `'unknown'` (truthy). **Nunca `false`** | idem |
| AC-5 | `T-ALERT-LOWER-BOUND` | con `truncated`, `breached === true` aunque la suma parcial no llegue al umbral (§6/W3) | idem |
| AC-5 | `T-ALERT-OFF` | umbral sin configurar ⟹ campo **ausente** en `/health` **y cero llamadas a supabase** (CD-19: se cuenta el I/O) | idem |
| AC-5 | `T-ALERT-WINDOW` | el filtro usa `created_at >= now - ventana` con la ventana **configurada** | idem |
| AC-5 | `T-ALERT-CACHE` | N lecturas dentro del TTL ⟹ **una** query (CD-19) | idem |
| AC-5 | `T-HEALTH-SHAPE` | `/health` sigue devolviendo `status: 'ok'` (el `healthyField` del monitor **no se rompe**) y el campo es aditivo | `e2e.test.ts` |
| AC-6 | `T-NEUTRALITY-01` | **prueba con dinero**: el MISMO pipeline con un agente propio (`remit-*`, registry de la casa) y con uno de tercero produce **el mismo débito** — mismo **monto**, misma **cantidad de llamadas** a `budgetService.debit`, mismo **destino**. Ninguna rama por dueño | `compose.stranded.test.ts` |
| AC-6 | `T-NEUTRALITY-02` | guard estructural: el código de producción del money-path **no contiene** `prepaid` / `prepay` / `topUp` / `deferredSettlement`. Regresión explícita contra el pivote. Exemplar: `charged-routes.meta.test.ts`, ancla `const LEGACY_UNVALIDATED: ReadonlySet<string> = new Set([` | idem |
| AC-7 | `T-READONLY-01` | `listStrandedRuns()` **no** llama `supabase.rpc` ni `insert`/`update`/`delete` | `reconciliation.test.ts` |
| AC-7 | `T-READONLY-02` | registrar un run stranded **no** dispara ningún `credit`/`creditWithDest` extra: el dinero movido es **idéntico** con y sin la HU | `compose.stranded.test.ts` |
| AC-8 | `T-STRAND-INBOUND` | step pagado **sólo** por el inbound x402 (`txHash`, sin `downstreamTxHash`) ⟹ **también** cuenta, con `evidence: 'inbound'` | idem |
| AC-9 | `T-STRAND-TRACK-THROWS` | `track` rechaza ⟹ el `ComposeResult` es **idéntico** y no hay unhandled rejection | idem |
| AC-10 | `T-STRAND-BYTE-IDENTICO` | pipeline exitoso: mismo `ComposeResult`, **misma cantidad** de `track` y de `debit` que el baseline (CD-19) | idem |
| CD-8 | `T-STRAND-FAMILY-SEPARATE` | `listSettleUnknown()` sigue filtrando por **exactamente** los dos `event_type` históricos | `reconciliation.test.ts` |
| CD-12 | `T-STRAND-DEFENSIVE` | fila con `metadata` `null` / array / forma rara ⟹ `paidSteps: []`, `runId: null`, **sin throw**, y **las demás filas se siguen listando** | idem |

**CD-14 aplicado**: los tests de dinero (`T-NEUTRALITY-01`, `T-READONLY-02`,
`T-CEILING-01`) assertan **el efecto observable** — argumentos y cantidad de
llamadas a `budgetService.debit`/`creditWithDest` — **no** el status code ni la
mera existencia del spy.

---

## 11. Los 14 mutantes, uno por uno, con su asesino

> **Regla dura (CD-16): un mutante que NO COMPILA es un falso positivo.** "No
> tests found", "FAIL <archivo>" o un error de `tsc` **no son un KILLED**: son un
> mutante inválido que hay que reescribir. Antes de contar un KILLED, verificá
> que el rojo es **una aserción fallando**, no un parseo roto.
>
> **Regla dura (CD-21): un mutante que SOBREVIVE tiene dos causas** — falta un
> test, **o la mutación no era una mutación**. Determinalo empíricamente (§8.4)
> antes de escribir el test.
>
> **Ciclo (CD-17):** commitear → mutar → `npx vitest run <suite>` → verificar que
> el rojo es una aserción → `git restore` **sólo** del archivo mutado. **Jamás
> `git checkout --`.**

| # | Mutación (en el archivo indicado) | Test asesino | Compila porque |
|---|---|---|---|
| **M1** | `src/lib/stranded-payment.ts`: `MAX_STRANDABLE_STEPS = MAX_COMPOSE_STEPS - 1` → `= MAX_COMPOSE_STEPS` | `T-COTA-01` | sigue siendo `number` |
| **M2** | `src/services/compose.ts`: borrar la llamada `this.recordStrandedRunIfAny(runId, result);` de la envoltura (la función queda declarada, sin usar) | `T-STRAND-EMIT-01` | `noUnusedLocals` no aplica a métodos del object literal |
| **M3** | `stranded-payment.ts`, en `collectStrandedSteps`: quitar la rama `txHash` (dejar sólo `downstreamTxHash`) | `T-STRAND-INBOUND` | rama menos, mismo tipo de retorno |
| **M4** | `src/services/reconciliation.ts`: quitar `{ count: 'exact' }` del select de `listStrandedRuns` | `T-STRAND-TRUNCATED` | el 2º arg de `.select()` es opcional |
| **M5** | `reconciliation.ts`: `if (error) { …throw… }` → `if (error) return { rows: [], total: 0, truncated: false };` | `T-STRAND-ERROR` | el objeto satisface `StrandedRunsReport` |
| **M6** | `reconciliation.ts`: `truncated: total > rows.length` → `truncated: false` | `T-STRAND-TRUNCATED` | sigue siendo `boolean` |
| **M7** | `src/services/stranded-alert.ts`: `breached = exposureUsd > threshold` → `breached = false` | `T-ALERT-BREACH` | sigue siendo `boolean` |
| **M8** | `stranded-alert.ts`: ante error de la query, devolver `false` en vez de `'unknown'` | `T-ALERT-UNKNOWN` | `false` está en el union `boolean \| 'unknown'` |
| **M9** | `stranded-payment.ts`: `Math.min(callerBudget, ceiling)` → `callerBudget` (devolver el primer operando) | `T-CEILING-01` | sigue siendo `number` |
| **M10** | `reconciliation.ts`: `cost_usdc::text` → `cost_usdc` en el select de `listStrandedRuns` | `T-STRAND-NUMERIC` | es un string literal |
| **M11** | `src/lib/settle-withholding.ts`: agregar `COMPOSE_STRANDED_PAYMENT_EVENT` a `SETTLE_UNKNOWN_EVENT_TYPES` | `T-STRAND-FAMILY-SEPARATE` | el array es `as const` de strings; importar el leaf nuevo no cicla (ambos son leafs) |
| **M12** | `src/services/compose.ts`: borrar la clave `compose_run_id` del `metadata` del `track()` de **éxito** | `T-STRAND-JOIN` | `metadata` es `Record<string, unknown>`: una clave menos compila |
| **M13** | `stranded-alert.ts`: en el refresh, ignorar el TTL y refrescar **siempre** (quitar el guard de frescura) | `T-ALERT-CACHE` | se borra una condición, no un tipo |
| **M14** | `stranded-payment.ts`: `collectStrandedSteps` devuelve **también** el step que falló (incluir el índice `steps.length`) | `T-STRAND-FIELDS` — `paid_steps` **no puede** contener el índice fallido | mismo tipo de retorno, un elemento más |

**Mutantes que NO se escriben**: cualquiera que cambie la firma pública de
`compose()`, el orden de un débito, o borre un `await` de una operación de
dinero. Esos no son mutantes de esta HU: son violaciones de CD-7.

---

## 12. Verificación — gates por wave

| Wave | Gate de salida |
|---|---|
| **W-1** (environment) | `git status` limpio de cambios ajenos en `src/` (§9) · `npm install` OK · existen `src/lib/compose-limits.ts`, `src/lib/settle-withholding.ts`, `src/services/reconciliation.ts`, `src/services/compose.ts`, `mcp-servers/wasiai-x402/src/health-monitor.mjs` · **baseline re-medido** post-merge de 305 |
| **W0** | `npx tsc --noEmit` verde · suite completa **sin cambios respecto al baseline** (nadie llama al leaf ⟹ cero cambio observable) |
| **W1** | `npx tsc --noEmit` · suite verde · **§3.3: `git diff` de `compose.ts` clasificado hunk por hunk** · M2/M12 KILLED |
| **W2** | `npx tsc --noEmit` · suite verde · el refactor del doble validado desarmando el escenario (§7) · M4/M5/M6/M10/M11 KILLED |
| **W3** | `npx tsc --noEmit` · suite verde · M7/M8/M13 KILLED · `T-ALERT-OFF` cuenta **cero** llamadas a supabase |
| **W4** | `npx tsc --noEmit` · suite verde · M1/M9/M14 KILLED · el script corre contra el gateway y **falla con exit ≠ 0** si no lo alcanza |
| **Final** | `npx tsc --noEmit` **completo, incluye tests** (CD-18) · `npx biome check --write` sobre **todos** los archivos nuevos (CD-20) · `npm run lint` · **suite = baseline re-medido + los tests nuevos, cero regresiones** · los 14 mutantes con veredicto y evidencia de que el rojo fue una aserción |

**Baseline de referencia al escribir este documento: `4065 passed | 19 skipped`.**
Re-medilo después del merge de 305 (§9.3) y reportá **los dos números**: el
re-medido y el final. Ningún test existente puede cambiar de resultado; los
nuevos suman.

---

## 13. Out of scope — no lo toques

- **WKH-305** (orden débito/construcción de input) — CD-5.
- **Cualquier** saldo, crédito, recarga o liquidación diferida — CD-1.
- Remediación automática del pago stranded — CD-4.
- Endpoint, tabla, cola o migración de base nuevos — CD-2 / §6. **Cero
  migraciones**: `a2a_events.metadata` es `jsonb` y absorbe todo.
- `mcp-servers/wasiai-x402/src/health-monitor.mjs` y `alerts.mjs` — se **reusan
  tal cual**; lo único que cambia es una clave del JSON de env, documentada.
- `wasiai-facilitator` — esta HU no mueve dinero, sólo lo observa.
- TD-203-01 (índice por `event_type`) — sigue abierta, **no se cierra acá**.
- El cobro de `remit-*` / `agentshop-*` — ya cobran por llamada y así se quedan.
- **NO "mejorar" código adyacente.** **NO tocar `_INDEX.md`** (lo escribe
  `nexus-docs` en DONE). **NO commits** con `Co-Authored-By` — repo público.

---

## 14. Escalation

> **Si algo no está en este Story File, PARÁ y preguntá.** No inventes, no
> asumas, no improvises.

Situaciones que **obligan** a parar:

- Un **ancla de contenido** de §3.1 o §6 no aparece en el archivo (⟹ el árbol se
  movió; probablemente 305).
- Los `return { success: false … }` del loop de `compose()` **no son siete**.
- `git status` muestra cambios ajenos en `src/services/compose.ts`.
- Un mutante no compila después de dos intentos de reescribirlo.
- Un mutante sobrevive y no podés determinar empíricamente si es (a) o (b) de CD-21.
- El refactor del doble (§7) requiere tocar tests fuera de `reconciliation.test.ts`.
- Sentís la necesidad de **elegir un valor** para `PIPELINE_EXPOSURE_CEILING_USD`
  (§5.3): eso es exactamente lo que NO hay que hacer.

---

## 15. Anti-Hallucination Checklist (marcar antes de declarar la HU lista)

- [ ] Los **siete** returns de fallo de §3.1 existen, verificados por ancla de contenido.
- [ ] `git diff src/services/compose.ts` clasificado hunk por hunk en las **tres**
      clases permitidas de §3.3. Cero hunks sin clasificar.
- [ ] Ninguna decisión de dinero cambió: débito, refund, crédito, settle,
      retención HU-203, guard `i > 0`, `startTime`, orden, `stepDestination`,
      claves de idempotencia.
- [ ] `'unknown'` es truthy y **nunca** se degrada a `false` ante un fallo de base
      (`T-ALERT-UNKNOWN` lo prueba).
- [ ] Con el umbral OFF, el campo está **ausente** de `/health` y hay **cero**
      llamadas a supabase (contadas, no supuestas).
- [ ] `PIPELINE_EXPOSURE_CEILING_USD` se entrega **sin setear**, y el gatillo está
      escrito en el runbook con su motivo.
- [ ] `wireIntents` discrimina **por tabla y por orden de llamada**; los
      `T-203-SU-*` re-apuntados a `events[0]` y validados desarmando el escenario.
- [ ] Los 14 mutantes: veredicto + evidencia de que el rojo fue **una aserción**.
- [ ] `npx tsc --noEmit` completo (con tests) y `biome check --write` sobre los
      archivos nuevos.
- [ ] Suite = baseline re-medido + tests nuevos. Cero regresiones.
- [ ] Cero migraciones, cero endpoints nuevos, cero tablas nuevas, cero colas nuevas.
- [ ] Cero apariciones de `prepaid`/`prepay`/`topUp`/`deferredSettlement` en
      producción (`T-NEUTRALITY-02`).

---

*Story File generado por NexusAgil — F2.5 · WKH-306*
