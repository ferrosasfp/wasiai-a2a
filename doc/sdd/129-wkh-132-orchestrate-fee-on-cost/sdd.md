# SDD — [WKH-132] Protocol fee de /orchestrate proporcional al costo REAL del pipeline

- HU: WKH-132 (doc/sdd/129-wkh-132-orchestrate-fee-on-cost)
- Modo: QUALITY (money-path, AR obligatorio)
- SDD_MODE: full · Estimación: M
- Branch: `fix/129-wkh-132-orchestrate-fee-on-cost`
- Fase: F2 (SDD) — gate previo `HU_APPROVED` ✅

---

## 0. Resumen ejecutivo del diseño

El bug es un único acoplamiento: el protocol fee de `/orchestrate` se calcula como
`budget * feeRate` (base = budget declarado por el caller) en 4 sitios, mientras que
`/compose` (WKH-118) ya lo cobra sobre `result.totalCostUsdc` (costo real). La solución
**converge orchestrate al patrón de compose** — no inventa modelo nuevo:

1. **Quote (plan)**: `protocolFeeUsdc = maxQuotedCostUsdc − totalCostUsdc` (residual). Esto
   garantiza `maxQuotedCostUsdc == totalCostUsdc + protocolFeeUsdc` **por construcción** (AC-2),
   reusa la MISMA resolución de precios server-side que `quoteMaxCostUsdc` (AC-1/DT-2), y es
   independiente del budget (AC-9).
2. **Charge (execute)**: `chargeProtocolFee({ budgetUsdc: pipeline.totalCostUsdc })`, espejo
   exacto de `compose.ts:539` (DT-1). El fee cobrado deja de escalar con el budget.
3. **DT-3 resuelto**: el guard pre-planning `feeUsdc > budget` (orchestrate.ts:386) es **código
   muerto inalcanzable** (ver §3) — `getProtocolFeeRate()` ya clampa el rate a [0, 0.10], así que
   `budget*rate > budget` (⟺ `rate > 1`) nunca se cumple. Se **elimina** ese guard; el fail-fast
   real contra un rate corrupto lo sigue dando el clamp de `getProtocolFeeRate()` (Scope OUT,
   intacto) y el guard cost-vs-cost sobrevive dentro de `chargeProtocolFee` (fee-charge.ts:167).

Superficie money-path tocada: `src/services/orchestrate.ts` + `src/routes/orchestrate.ts`
(re-derivación /execute) + doc-comments en `fee-charge.ts` y `types/index.ts`. **Cero cambio
funcional en `fee-charge.ts`, `compose.ts` (route+service), `quoteMaxCostUsdc`,
`augmentX402ChallengeAmount`, débito/credit-back WKH-127, execution-id BLQ-MED-1.**

---

## 1. Context Map (archivos leídos — F0 grounding propio)

| Archivo:línea | Por qué lo leí | Qué extraje |
|---|---|---|
| `src/services/orchestrate.ts:370-747` (`planOrchestration`) | Sitio del bug pre-planning + ensamblado del plan | `feeRate/feeUsdc` en :384-390; early-returns con `feeUsdc` en :426/478/627/679; `costPerStep`/`totalCostUsdc`/`maxQuotedCostUsdc` en :722-728; return `ready` con `protocolFeeUsdc: feeUsdc`, `feeUsdc` en :730-746 |
| `src/services/orchestrate.ts:757-786` (`quoteMaxCostUsdc`) | Fuente de `maxQuotedCostUsdc` | Calcula `pipelineUsd * (1 + getProtocolFeeRate())` con fallback `PLACEHOLDER_FEE_USD` por step + floor 1e-6. **Es el espejo de `augmentX402ChallengeAmount` (CD-7). NO se toca.** |
| `src/services/orchestrate.ts:806-1110` (`executeApprovedPlan`) | Sitio del charge + maxBudget | `feeUsdc` destructurado (:820); cap gate `__quoteStale` (:827-841); débito step-0 WKH-127 (:846-924); `maxBudget: budget - feeUsdc` (:931); `protocolFeeUsdc = feeUsdc` (:953); `chargeProtocolFee({ budgetUsdc: budget })` (:961-965); receipt `amountUsd: feeUsdc` (:993); credit-back WKH-127 (:1010-1072) |
| `src/services/fee-charge.ts:32-36,157-171` | Firma + guard interno del fee | `FeeChargeParams.budgetUsdc` (nombre engañoso); interno `feeUsdc = Number((budgetUsdc*feeRate).toFixed(6))` (:163); guard `if (feeUsdc > budgetUsdc) throw ProtocolFeeError` (:167). **Este guard es el que sobrevive (AC-4/CD-2).** |
| `src/services/fee-charge.ts:94-115` (`getProtocolFeeRate`) | Fail-fast real del rate corrupto | Clampa a [0.0, 0.10], fallback 0.01 + `log.error` (:107). **Es la defensa real; Scope OUT, intacta.** |
| `src/routes/compose.ts:127-178` (`augmentX402ChallengeAmount`) | Espejo de `quoteMaxCostUsdc` (AC-8/CD-7) | `pipelineUsd * (1 + getProtocolFeeRate())` con mismo fallback/floor. **NO se toca.** |
| `src/routes/compose.ts:528-541` (`chargeProtocolFee` cost-based) | **Patrón de referencia (DT-1)** | `budgetUsdc: result.totalCostUsdc` — costo REAL, no budget. Receipt usa `feeResult.feeUsdc` (:559). Es exactamente al patrón que orchestrate debe converger. |
| `src/routes/orchestrate.ts:200-236` (`/plan`) | Serialización del quote | Route hace pick de campos públicos; serializa `plan.protocolFeeUsdc`/`totalCostUsdc`/`maxQuotedCostUsdc` (:231-233). Los internos (`feeUsdc`) NO se serializan. |
| `src/routes/orchestrate.ts:307-428` (`/execute`) | Re-derivación server-side + BLQ-MED-1 | `orchestrationId = crypto.randomUUID()` server-side (:315, CD-4); re-resuelve `costPerStep`/`totalCostUsdc` (:335-351); `feeUsdc = body.budget * feeRate` (:350) ← **también hay que corregir**; construye `plan` (:360-377); gate 409 `QUOTE_STALE` (:399-405) |
| `src/services/compose.ts:100,158-169` | Uso interno de `maxBudget` (DT-4) | `maxBudget` es techo per-step: `totalCost + price + gas > maxBudget → budget exceeded`. Con fee cost-based (menor) → `maxBudget` mayor → más headroom, nunca regresa. |
| `src/types/index.ts:447-478` (`OrchestratePlanResult`) | Contrato del plan | Comment `feeUsdc = budget * rate` (:456) queda desactualizado → doc fix. Tipos de campos sin cambio (siguen `number`). |
| `src/lib/pricing-constants.ts` | `PLACEHOLDER_FEE_USD` | `= 1.0`. Explica por qué `quoteMaxCostUsdc.pipelineUsd >= totalCostUsdc` (over-estimate de precios inválidos) → residual `maxQuoted − total >= 0`. |
| `doc/sdd/128-orchestrate-plan-execute/auto-blindaje.md` | Errores recurrentes previos | 3 lecciones aplicables (ver §9 Constraint Directives CD-13..CD-15). |

---

## 2. Decisiones técnicas (DT-N)

### DT-1 — Charge en execute sobre el costo real (converger con WKH-118)
`chargeProtocolFee` en `executeApprovedPlan` pasa `budgetUsdc: pipeline.totalCostUsdc`
(costo real post-compose), espejo línea-a-línea de `compose.ts:539`. El interno de
`chargeProtocolFee` computa `feeUsdc = pipeline.totalCostUsdc * rate`. El receipt usa
`feeResult.feeUsdc` (espejo `compose.ts:559`), no la variable budget-based. **No es modelo
nuevo: es el patrón vigente de /compose.**

### DT-2 — Consistencia por construcción (`maxQuoted == total + fee`)
`protocolFeeUsdc` cotizado en el plan se deriva como **residual**:
```
protocolFeeUsdc = Number(Math.max(0, maxQuotedCostUsdc - totalCostUsdc).toFixed(6))
```
Ambos operandos ya provienen de la MISMA resolución server-side (`resolveAgentPriceUsdc`,
`forceRefresh=false`, cache fresco intra-request). Con esto AC-2 se cumple **trivialmente por
construcción**: `totalCostUsdc + (maxQuotedCostUsdc − totalCostUsdc) == maxQuotedCostUsdc`.

**Por qué residual y no `totalCostUsdc * rate`:** `quoteMaxCostUsdc.pipelineUsd` usa
`PLACEHOLDER_FEE_USD` (1.0) para precios inválidos (0/null/NaN), mientras `totalCostUsdc`
usa 0 para esos mismos steps. Entonces `maxQuotedCostUsdc = pipelineUsd*(1+rate)` puede ser
> `totalCostUsdc*(1+rate)`. Si computáramos `fee = totalCostUsdc*rate` por separado, AC-2 se
rompería en ese caso de placeholder (drift entre dos fórmulas paralelas — justamente lo que
DT-2 prohíbe). El residual absorbe cualquier over-estimate y mantiene la igualdad exacta sin
tocar `quoteMaxCostUsdc` (CD-7/AC-8 preservados). En el caso limpio (todos los precios > 0)
`pipelineUsd == totalCostUsdc` → `residual == totalCostUsdc*rate` (AC-9 se cumple: 0.061 →
0.00061). **Invariante**: `maxQuotedCostUsdc >= totalCostUsdc` siempre (cada término de
`pipelineUsd` ≥ su término en `totalCostUsdc`), por lo que el residual ≥ 0; el `Math.max(0, …)`
es defensa de redondeo.

### DT-3 — Guard AC-7 pre-planning (DECISIÓN DE DISEÑO OBLIGATORIA — RESUELTA)

**Hallazgo clave:** el guard `if (feeUsdc > budget)` en `orchestrate.ts:386` es **inalcanzable**.
`feeUsdc = budget * feeRate`, entonces `feeUsdc > budget ⟺ feeRate > 1` (para `budget > 0`).
Pero `getProtocolFeeRate()` (fee-charge.ts:102-112) **garantiza `feeRate ∈ [0.0, 0.10]`**
(clampa cualquier valor fuera de rango / no-finito al fallback 0.01). Por lo tanto el guard
nunca dispara con ningún `PROTOCOL_FEE_RATE` posible. **Hoy no protege contra nada que
`getProtocolFeeRate()` no neutralice antes.**

**Opciones evaluadas (del work-item):**

| Opción | Descripción | Veredicto |
|---|---|---|
| (i) diferir el guard a post-planning | Fee único calculado una vez con el costo real; guard cost-aware después | ✅ **Elegida (adaptada)** |
| (ii) cota superior conservadora pre-planning + guard real post-costo | Mantener un guard previo con semántica distinta | ❌ Agrega superficie money-path sin beneficio (la cota superior sería `budget*rate`, que ya sabemos ≤ budget siempre) |
| (iii) redefinir `maxBudget` sin depender del fee-pre | Cambiar la fórmula del headroom | ⚠️ Innecesario — ver DT-4 (se conserva `budget - feeUsdc` con `feeUsdc` cost-based) |

**Decisión (opción (i) adaptada — mínima superficie, fail-fast preservado):**

1. **Eliminar** el bloque `orchestrate.ts:384-390` (`feeRate`, `feeUsdc = budget*rate`, guard
   `feeUsdc > budget`). Es dead-code + acopla el fee al budget.
2. Los 4 early-returns (`:426/478/627/679`) fijan `feeUsdc: 0` en vez de la variable
   budget-based (no hay steps ⇒ no hay costo ⇒ no hay fee; `protocolFeeUsdc` ya era `0` ahí).
3. El fail-fast contra un `PROTOCOL_FEE_RATE` corrupto **NO se pierde**: `getProtocolFeeRate()`
   sigue corriendo (con su clamp + `log.error`) dentro de `quoteMaxCostUsdc` (:780) durante
   planning y en `executeApprovedPlan` (:823, :964). El rate corrupto se neutraliza igual que
   hoy (clamp a 0.01). El HTTP-400 previo era **inobservable** (el guard nunca disparaba), así
   que eliminarlo es **behavior-preserving**.
4. El guard de seguridad exigido por CD-2/AC-4 **sobrevive** en `chargeProtocolFee`
   (fee-charge.ts:167): con `budgetUsdc = pipeline.totalCostUsdc` pasa a comparar
   `costo*rate > costo` (⟺ `rate > 1`) — la **semántica cost-aware correcta** que pide AC-4
   (fee-basado-en-costo contra la referencia de costo). Es el mismo guard que /compose ya
   ejercita en prod desde WKH-118, así que su corrección está probada.

**Tradeoff de latencia (Missing Input del work-item) — resuelto:** el work-item alertaba que
mover el guard a post-planning haría costar una ronda de discovery+LLM el fail-fast ante un
rate corrupto. **Ese tradeoff es MOOT**: no existe fail-fast que perder porque el guard
pre-planning nunca fue alcanzable (el clamp de `getProtocolFeeRate()` ya neutraliza el rate
corrupto en O(1), sin discovery). No hay regresión de latencia ni de comportamiento observable.
Escenario ops-only (rate corrupto): antes → clamp a 0.01 + log, sin 400. Después → idéntico.

### DT-4 — Reserva de headroom en compose (`maxBudget`)
Se **conserva** `maxBudget = budget − feeUsdc` (orchestrate.ts:931). Verificado en
`compose.ts:158-169`: `maxBudget` es techo per-step (`totalCost + price + gas > maxBudget →
budget exceeded`). Con el fix, `plan.feeUsdc` pasa a ser el fee **cost-based** (residual),
típicamente mucho menor que `budget*rate` en los escenarios del bug (0.00061 vs 0.01–0.05) →
`maxBudget` mayor → **más** headroom para que compose acomode steps. No puede introducir
budget-exceeded nuevos. **Nuevo invariante (CD-1)**: `maxBudget` reserva el protocol fee
*cost-based* que se cobrará, no `budget*rate`. Documentado.

### DT-5 — Rename cosmético `budgetUsdc → feeBaseUsdc` (DIFERIDO)
**NO se ejecuta en esta HU.** Renombrar `FeeChargeParams.budgetUsdc` forzaría cambiar el call
site `compose.ts:539` (`budgetUsdc: result.totalCostUsdc`), que está en **Scope OUT**. En su
lugar: se agrega un **doc-comment** aclaratorio en `fee-charge.ts:32-36` ("base sobre la que se
aplica el rate — el costo real, NO un budget declarado") — cambio comment-only, cero funcional,
in-scope (Scope IN lista `fee-charge.ts:32-36`), que ataca la causa raíz del bug (nombre
engañoso) sin tocar Scope OUT. El rename completo queda como TD para una HU de higiene futura.

---

## 3. Diseño concreto — diffs / pseudocódigo por archivo

### 3.1 `src/services/orchestrate.ts` — `planOrchestration`

**(a) Eliminar el bloque pre-planning budget-based (líneas 384-390):**
```diff
-    const feeRate = getProtocolFeeRate();
-    const feeUsdc = Number((budget * feeRate).toFixed(6));
-    if (feeUsdc > budget) {
-      throw new ProtocolFeeError(
-        `Protocol fee (${feeUsdc}) exceeds budget (${budget}) — check PROTOCOL_FEE_RATE env var.`,
-      );
-    }
+    // WKH-132 (DT-3): el fee ya NO se calcula sobre el budget. El guard previo
+    // `feeUsdc > budget` (⟺ rate > 1) era INALCANZABLE: getProtocolFeeRate()
+    // clampa el rate a [0, 0.10] (fee-charge.ts:102-112), su clamp+log.error ES
+    // el fail-fast real contra un PROTOCOL_FEE_RATE corrupto. El fee real se
+    // deriva post-planning del costo resuelto (AC-1); el guard cost-vs-cost
+    // sobrevive en chargeProtocolFee (fee-charge.ts:167), igual que /compose.
```
> Nota: si `ProtocolFeeError` deja de usarse en `orchestrate.ts`, quitar su import
> (biome `noUnusedImports`). Verificar con grep antes de editar.

**(b) Early-returns (4 sitios: :426, :478, :627, :679) — `feeUsdc,` → `feeUsdc: 0,`**
```diff
-        feeUsdc,
+        feeUsdc: 0, // WKH-132: sin steps ⇒ sin costo ⇒ sin fee
```

**(c) Return `ready` (líneas 730-746) — fee residual (AC-1/AC-2/DT-2):**
```diff
     const totalCostUsdc = costPerStep.reduce((sum, c) => sum + c, 0);
     const maxQuotedCostUsdc = await this.quoteMaxCostUsdc(steps, false);
+    // WKH-132 (DT-2): fee = residual del quote sobre el costo real → garantiza
+    // maxQuotedCostUsdc == totalCostUsdc + protocolFeeUsdc por construcción (AC-2).
+    // Reusa la MISMA resolución de precios que maxQuotedCostUsdc (AC-1). Budget-
+    // independent (AC-9). Math.max(0,…): defensa de redondeo (maxQuoted ≥ total).
+    const protocolFeeUsdc = Number(
+      Math.max(0, maxQuotedCostUsdc - totalCostUsdc).toFixed(6),
+    );

     return {
       orchestrationId,
       planStatus: 'ready',
       steps,
       costPerStep,
       totalCostUsdc,
-      protocolFeeUsdc: feeUsdc,
+      protocolFeeUsdc,
       maxQuotedCostUsdc,
       reasoning,
       consideredAgents: discovered.agents,
       plannedCostUsd,
-      feeUsdc,
+      feeUsdc: protocolFeeUsdc, // interno: reserva cost-based para maxBudget (DT-4)
       usedFallback,
       ...
     };
```

### 3.2 `src/services/orchestrate.ts` — `executeApprovedPlan`

**(d) `protocolFeeUsdc` reportado + charge base (líneas 950-965):**
```diff
-    // WKH-44 (AC-3): el fee ya fue calculado al inicio con `budget * feeRate`.
-    // `protocolFeeUsdc` expuesto en el result refleja ese valor ...
-    const protocolFeeUsdc = feeUsdc;
+    // WKH-132 (AC-1/DT-1): protocolFeeUsdc reportado = rate sobre el COSTO REAL
+    // ejecutado (pipeline.totalCostUsdc), no el budget. Igual al fee cotizado en
+    // /plan cuando el pipeline tuvo éxito total y el quote se honró (CD-6); el
+    // charge de abajo está gateado por pipeline.success.
+    const protocolFeeUsdc = Number(
+      (pipeline.totalCostUsdc * feeRate).toFixed(6),
+    );
     ...
     if (pipeline.success) {
       const feeResult = await chargeProtocolFee({
         orchestrationId,
-        budgetUsdc: budget,
+        budgetUsdc: pipeline.totalCostUsdc, // WKH-132/DT-1: espejo compose.ts:539
         feeRate,
       });
```

**(e) Receipt `amountUsd` (línea 993) — usar el fee cost-based del charge:**
```diff
              receiptType: 'protocol_fee',
-             amountUsd: feeUsdc,
+             amountUsd: feeResult.feeUsdc, // WKH-132: espejo compose.ts:559
```

**(f) `maxBudget` (línea 931) — SIN cambio de código; `feeUsdc` (destructurado :820) ahora
es cost-based (viene del plan). Actualizar SOLO el comment del invariante (CD-1/DT-4):**
```diff
-      maxBudget: budget - feeUsdc,
+      maxBudget: budget - feeUsdc, // WKH-132: feeUsdc = reserva COST-BASED (no budget*rate)
```

### 3.3 `src/routes/orchestrate.ts` — `/execute` re-derivación (líneas 349-351)

```diff
         const feeRate = getProtocolFeeRate();
-        const feeUsdc = Number((body.budget * feeRate).toFixed(6));
         const totalCostUsdc = costPerStep.reduce((sum, c) => sum + c, 0);
+        // WKH-132: base del fee = costo real resuelto server-side, NO budget.
+        // Sólo seedea plan.feeUsdc (reserva maxBudget); el fee REALMENTE cobrado
+        // se deriva de pipeline.totalCostUsdc dentro de executeApprovedPlan.
+        const feeUsdc = Number((totalCostUsdc * feeRate).toFixed(6));
```
> `plan.protocolFeeUsdc` (:367) y `plan.feeUsdc` (:372) en /execute se setean a `feeUsdc`
> (cost-based). Ninguno se serializa: el response usa `result.protocolFeeUsdc` de
> `executeApprovedPlan` (pipeline-based). Consistencia interna preservada.

### 3.4 `src/services/fee-charge.ts` — doc-comment only (DT-5)

```diff
 export interface FeeChargeParams {
   orchestrationId: string;
-  budgetUsdc: number;
+  /**
+   * WKH-132: base sobre la que se aplica el rate. NO es "el budget declarado":
+   * es el COSTO REAL del pipeline (compose.ts:539 y orchestrate execute pasan
+   * result/pipeline.totalCostUsdc). El guard interno `feeUsdc > budgetUsdc`
+   * (línea 167) es entonces cost-vs-cost (⟺ rate>1), el safety guard del fee.
+   * (rename budgetUsdc→feeBaseUsdc DIFERIDO: cambiaría compose.ts:539 = Scope OUT.)
+   */
+  budgetUsdc: number;
   feeRate: number;
 }
```
**Cero cambio funcional en fee-charge.ts** (el guard :167 y el cálculo :163 quedan idénticos).

### 3.5 `src/types/index.ts:456` — doc-comment only

```diff
-  /** feeUsdc = budget * rate (espejo del atómico). */
+  /** WKH-132: fee cost-based = maxQuotedCostUsdc − totalCostUsdc (residual);
+   *  == totalCostUsdc + protocolFeeUsdc por construcción (AC-2). 0 en early-returns. */
   protocolFeeUsdc: number;
```

---

## 4. Waves de implementación

> `orchestrate.ts` y `routes/orchestrate.ts` son superficie de dinero compartida: W1→W3 son
> **seriales** (mismo archivo / mismo path). No paralelizar internamente esta HU.

### W0 — Serial · Contratos + Tests-first (RED)
- Actualizar doc-comments de contrato: `types/index.ts:456` (§3.5) + `fee-charge.ts:32-36` (§3.4).
- Escribir los tests que codifican los ACs nuevos y **fallan contra el código actual** (RED):
  AC-1, AC-2, AC-9 en `orchestrate.test.ts`; AC-3 en `routes/orchestrate.test.ts` +
  `orchestrate.billing.test.ts`. Ver §5.
- Objetivo: fijar el invariante `maxQuoted == total + fee` y el fee budget-independiente antes
  de tocar producción.

### W1 — Serial · `planOrchestration` (quote cost-based)
- §3.1 (a) eliminar bloque pre-planning + limpiar import `ProtocolFeeError` si queda huérfano.
- §3.1 (b) 4 early-returns → `feeUsdc: 0`.
- §3.1 (c) return `ready` → `protocolFeeUsdc` residual + `feeUsdc: protocolFeeUsdc`.
- Verde: AC-1, AC-2, AC-9 (los de plan).

### W2 — Serial · `executeApprovedPlan` (charge cost-based)
- §3.2 (d) `protocolFeeUsdc` desde `pipeline.totalCostUsdc*rate` + `chargeProtocolFee`
  `budgetUsdc: pipeline.totalCostUsdc`.
- §3.2 (e) receipt `amountUsd: feeResult.feeUsdc`.
- §3.2 (f) comment del invariante `maxBudget`.
- Verde: AC-3 (atómico), AC-5, regresión AC-6.

### W3 — Serial · `/execute` route re-derivación
- §3.3 `feeUsdc = totalCostUsdc * feeRate` (reordenado tras `totalCostUsdc`).
- Verde: AC-3 (/execute), regresión AC-7 (T-EXEC-9 BLQ-MED-1).

### W4 — Serial · Regresión + Gates
- Suite completa verde: `orchestrate.test.ts`, `orchestrate.billing.test.ts`,
  `fee-charge.test.ts`, `routes/orchestrate.test.ts`, `compose.fee.test.ts`, `compose.test.ts`.
- `tsc --noEmit` limpio · `biome check` limpio · sin `any`/non-null-assertions.
- Verificar AC-8 (sin drift `quoteMaxCostUsdc` ↔ `augmentX402ChallengeAmount`).

---

## 5. Plan de tests (≥1 por AC)

| AC | Test | Archivo | Qué verifica |
|---|---|---|---|
| **AC-1** | `plan 'ready' → protocolFeeUsdc deriva del costo real` | `orchestrate.test.ts` | Pipeline con costo 0.061 → `protocolFeeUsdc ≈ 0.00061` (== `maxQuoted−total`), NUNCA `budget*rate`. |
| **AC-2** | `maxQuoted == total + fee (varios pipelines)` | `orchestrate.test.ts` | Para pipelines {1 step 0.02}, {3 steps 0.061}, {step con precio 0/placeholder}: `abs(maxQuotedCostUsdc − (totalCostUsdc + protocolFeeUsdc)) ≤ 1e-6`. |
| **AC-3** | `/execute cobra fee sobre pipeline.totalCostUsdc, no budget` | `routes/orchestrate.test.ts` + `orchestrate.billing.test.ts` | Spy de `chargeProtocolFee`: `budgetUsdc` arg == `pipeline.totalCostUsdc` (no `body.budget`). Fee cobrado ≈ fee cotizado en el happy path. |
| **AC-4** | `planOrchestration no lanza ProtocolFeeError con rate en rango` + `guard cost-vs-cost vive` | `orchestrate.test.ts` + `fee-charge.test.ts` | Con `PROTOCOL_FEE_RATE ∈ [0,0.10]` no hay throw pre-planning; `fee-charge.test.ts` mantiene el test de `feeUsdc > budgetUsdc → ProtocolFeeError` (regresión — guard intacto). |
| **AC-5** | `atómico: shape de respuesta idéntico salvo protocolFeeUsdc` | `orchestrate.test.ts` | Keys del `OrchestrateResult` idénticas al baseline; sólo cambia el valor numérico de `protocolFeeUsdc` (cost-based). |
| **AC-6** | `débito/credit-back step-0 WKH-127 intacto` | `orchestrate.billing.test.ts` | Débito base = `plannedCostUsd` (+gas), NO el fee; credit-back compara contra `plannedCostUsd`/`debitedUsd`. Tests WKH-127 existentes quedan verdes sin tocarse. |
| **AC-7** | `execution-id BLQ-MED-1 intacto` | `routes/orchestrate.test.ts` | T-EXEC-9 existente: 2 `/execute` mismo id de cliente → 2 execution-ids server-side distintos. Verde sin cambios. |
| **AC-8** | `quoteMaxCostUsdc == augmentX402ChallengeAmount (sin drift)` | `orchestrate.test.ts` / `compose.fee.test.ts` | Mismos steps → `quoteMaxCostUsdc(steps)` == `pipelineUsd*(1+rate)` que produce `augmentX402ChallengeAmount`. `quoteMaxCostUsdc` NO se modificó. |
| **AC-9** | `mismo pipeline (0.061), budget 1.0 vs 5.0 → mismo protocolFeeUsdc` | `orchestrate.test.ts` | **Test clave.** Dos `planOrchestration` con `budget=1.0` y `budget=5.0`, mismos steps/precios → `protocolFeeUsdc` idéntico (~0.00061). Falla contra el código viejo (0.01 vs 0.05). |

**Regresión explícita (no romper):**
- `compose.fee.test.ts` + `compose.test.ts`: el fee cost-based de /compose (WKH-118) sin cambio
  (no tocamos `compose.ts`).
- `orchestrate.billing.test.ts`: débito/credit-back step-0 WKH-127 + guard `i>0` intactos (AC-6).
- `routes/orchestrate.test.ts` T-EXEC-9: idempotencia execution-id BLQ-MED-1 (AC-7).
- `fee-charge.test.ts`: guard interno + idempotencia DB del fee sin cambio.

> **Lección auto-blindaje WKH-131 (aplicar en tests):** mockear `discoveryService.getAgent`
> **por slug** (`mockImplementation`, no `mockResolvedValue` de un único agente) para pipelines
> multi-step, y `_resetAgentPriceCache()` en `beforeEach` (cache module-level). Ver CD-13/CD-14.

---

## 6. Constraint Directives (CD-N)

**Heredados del work-item (obligatorios):**
- **CD-1 (WKH-44)**: `maxBudget` que ve `composeService.compose` DEBE seguir deduciéndose de una
  reserva para el fee. Nuevo invariante documentado: la reserva es ahora el fee **cost-based**
  (`plan.feeUsdc` = residual), no `budget*rate` (DT-4).
- **CD-2 (WKH-44 AC-7)**: el guard de seguridad del fee DEBE preservarse. Se preserva en
  `chargeProtocolFee` (fee-charge.ts:167) con semántica cost-vs-cost; el guard pre-planning
  inalcanzable se elimina (DT-3).
- **CD-3 (WKH-127)**: débito/credit-back step-0-only NO se toca. El fix afecta SOLO el
  cálculo/cobro del fee, nunca el débito step-0 ni los débitos per-step de compose (guard `i>0`).
- **CD-4 (BLQ-MED-1 / WKH-131)**: la `execution-id` server-side (`crypto.randomUUID()`) como
  idempotency key del fee en `/execute` NO se altera.
- **CD-5 (WKH-131 CD-4)**: el path atómico `/orchestrate` sigue byte-idéntico externamente
  EXCEPTO el valor corregido de `protocolFeeUsdc`.
- **CD-6 (esta HU)**: el fee cobrado en `/execute` == fee cotizado en `/plan` — satisfecho: el
  charge está gateado por `pipeline.success` (full success ⇒ `pipeline.totalCostUsdc` == costo
  cotizado dentro del bound del cap gate); drift por encima del cap → 409 `QUOTE_STALE` (sin
  charge). Ver §7 riesgo R-1.
- **CD-7 (espejo compose)**: `augmentX402ChallengeAmount` (compose.ts:127-178) y
  `quoteMaxCostUsdc` (orchestrate.ts:757-786) siguen calculando `pipelineUsd*(1+rate)`. **Ninguno
  se modifica.** El fee residual deriva DE `quoteMaxCostUsdc`, nunca lo altera.

**Nuevos (esta HU):**
- **CD-8**: `quoteMaxCostUsdc` (orchestrate.ts:757-786) es INMUTABLE en esta HU. Prohibido
  cambiar su fórmula, su fallback `PLACEHOLDER_FEE_USD` o su floor 1e-6.
- **CD-9**: `protocolFeeUsdc` del plan DEBE ser `Math.max(0, maxQuotedCostUsdc − totalCostUsdc)`
  redondeado a 6dp (residual). PROHIBIDO recomputarlo como `budget*rate` o como
  `totalCostUsdc*rate` por separado (drift en el caso placeholder).
- **CD-10**: el fee CHARGED en execute DEBE usar `pipeline.totalCostUsdc` como `budgetUsdc`
  (espejo compose.ts:539) y el receipt DEBE usar `feeResult.feeUsdc` (espejo compose.ts:559).
  PROHIBIDO pasar `budget`.
- **CD-11**: `fee-charge.ts` NO cambia funcionalmente (sólo doc-comment). El guard :167 y el
  cálculo :163 quedan intactos. Sin rename `budgetUsdc` (call site compose.ts:539 = Scope OUT).
- **CD-12**: `getProtocolFeeRate()` (fee-charge.ts, Scope OUT) es el fail-fast real del rate
  corrupto; su clamp [0,0.10] no se toca. La eliminación del guard pre-planning es
  behavior-preserving (guard inalcanzable).

**De auto-blindaje histórico (prevención de errores recurrentes):**
- **CD-13** (WKH-131 auto-blindaje #1/#2): en tests multi-step con compose real, mockear
  `discoveryService.getAgent` **por slug** (`mockImplementation`), nunca `mockResolvedValue` de un
  único agente (o todos los steps cobran el mismo precio → invariante de costo falso).
- **CD-14** (WKH-131 auto-blindaje #1): `_resetAgentPriceCache()` en `beforeEach` — el cache de
  `agent-price.ts` es module-level y sangra entre tests.
- **CD-15** (WKH-131 auto-blindaje #4): PROHIBIDO dejar non-null assertions (`steps[0]!`);
  resolver con guard explícito (`const s0 = steps[0]; s0 ? … : …`). biome no auto-fixea unsafe.

---

## 7. Riesgos abiertos

- **R-1 (BAJO — para bendición del Adversary):** CD-6 "fee cobrado == fee cotizado". El charge
  usa `pipeline.totalCostUsdc` (costo ejecutado real, patrón compose). Como el charge está
  gateado por `if (pipeline.success)`, sólo se cobra cuando TODOS los steps corrieron ⇒
  `pipeline.totalCostUsdc` == costo cotizado, dentro del bound del cap gate (drift por encima →
  409, sin charge). Micro-drift por price-tick bajo el cap es inherente al modelo compose y es
  caller-favorable (nunca sobre-cobra respecto al cap aprobado). **No requiere input del humano**
  — es diseño técnico alineado con DT-1; se señala para que AR lo valide explícitamente.
- **R-2 (BAJO):** si algún test legacy asertaba `protocolFeeUsdc == budget*rate` en orchestrate,
  fallará (es el bug). Debe ACTUALIZARSE al valor cost-based (no es regresión, es la corrección).
  Dev debe distinguir "test que codifica el bug" de "test de contrato real".

Ningún riesgo requiere conocimiento de DOMINIO del humano fuera del work-item. DT-3 resuelto
íntegramente como diseño técnico.

---

## 8. Exemplars verificados (paths confirmados con Read/Glob)

| Exemplar | Path:línea | Uso |
|---|---|---|
| Charge cost-based (patrón a copiar) | `src/routes/compose.ts:537-541` | `chargeProtocolFee({ budgetUsdc: result.totalCostUsdc })` |
| Receipt amount cost-based | `src/routes/compose.ts:559` | `amountUsd: feeResult.feeUsdc` |
| Guard cost-vs-cost (sobrevive) | `src/services/fee-charge.ts:163-171` | `feeUsdc = budgetUsdc*rate` + `if (feeUsdc > budgetUsdc) throw` |
| Clamp del rate (fail-fast real) | `src/services/fee-charge.ts:94-115` | rango [0,0.10] + fallback + log.error |
| Espejo del quote | `src/services/orchestrate.ts:757-786` | `pipelineUsd*(1+rate)` — INMUTABLE |
| Espejo x402 (no drift) | `src/routes/compose.ts:127-178` | misma fórmula — INMUTABLE |
| Toolbox de tests (mocks) | `src/services/orchestrate.test.ts` / `.billing.test.ts` | `getAgent` por slug + `_resetAgentPriceCache` |

---

## 9. Readiness Check

- [x] Work-item leído completo (9 ACs, 5 DTs, 7 CDs, Scope IN/OUT).
- [x] `project-context.md` leído (stack Fastify/Supabase/viem/TS strict confirmado).
- [x] Todos los exemplars verificados con Read (paths + líneas reales, §8). Cero paths inventados.
- [x] **DT-3 RESUELTO** (diseño técnico, no dominio): eliminar guard pre-planning inalcanzable;
      fail-fast preservado vía `getProtocolFeeRate()` clamp; guard cost-aware sobrevive en
      `chargeProtocolFee`. Tradeoff de latencia documentado y demostrado MOOT.
- [x] **DT-2 formalizado**: fee = residual `maxQuoted − total` → AC-2 por construcción.
- [x] **DT-1 concreto**: charge sobre `pipeline.totalCostUsdc`, espejo compose.ts:539.
- [x] DT-4 verificado: `maxBudget` conserva la reserva (ahora cost-based); uso interno en
      `compose.ts:158-169` revisado — no regresa.
- [x] DT-5 resuelto: rename DIFERIDO (Scope OUT), doc-comment en su lugar.
- [x] 7 CDs del work-item heredados + CD-8..CD-15 nuevos (incl. 3 de auto-blindaje WKH-131).
- [x] Plan de tests con ≥1 test por AC (9/9) + regresión explícita (compose/WKH-127/BLQ-MED-1).
- [x] Waves W0..W4 con W0 (contratos+tests-first) presente; W1-W3 seriales (money-path).
- [x] Sin `[NEEDS CLARIFICATION]` de diseño abiertos. R-1 marcado para validación del AR (no
      bloqueante, no requiere humano).
- [x] Scope OUT respetado: no se toca `compose.ts` (route/service), `augmentX402ChallengeAmount`,
      `quoteMaxCostUsdc`, débito step-0 WKH-127, execution-id BLQ-MED-1, rango PROTOCOL_FEE_RATE,
      PWA Yarvis. Sin nuevos endpoints ni migraciones DB.

**Estado: LISTO PARA `SPEC_APPROVED`.**
</content>
</invoke>
