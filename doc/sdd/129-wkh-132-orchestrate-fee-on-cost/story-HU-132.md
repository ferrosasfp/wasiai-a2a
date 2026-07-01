# Story File — [WKH-132] Protocol fee de /orchestrate proporcional al costo REAL del pipeline

> **Contrato ejecutable para el Dev (F3).** Autosuficiente: seguí las waves en orden.
> NO necesitás releer el SDD; todo lo accionable está acá. Si algo choca con el
> código real, **PARÁ y avisá al orquestador** (no inventes ni redisñes).
>
> - HU: WKH-132 · Modo: **QUALITY** (money-path, AR obligatorio)
> - Branch: `fix/129-wkh-132-orchestrate-fee-on-cost`
> - SDD fuente: `doc/sdd/129-wkh-132-orchestrate-fee-on-cost/sdd.md`

---

## 0. Contexto mínimo (leé esto y arrancá)

**Qué se arregla:** el protocol fee de `/orchestrate` (+ `/plan` + `/execute`) hoy se
calcula como `budget * feeRate` — escala con el budget declarado por el caller, no con
el costo real del pipeline (un pipeline de 0.061 USDC puede facturar 0.01–0.05 según el
budget). Se corrige a **fee cost-based**: rate sobre el **costo REAL** del pipeline.

**Regla de oro:** `/compose` (WKH-118) YA lo hace bien. **Convergé orchestrate al patrón
de `compose.ts:539`** (`budgetUsdc: result.totalCostUsdc`). NO inventás un modelo nuevo.
Fee del plan = **residual** (`maxQuotedCostUsdc − totalCostUsdc`). Fee cobrado en execute =
`chargeProtocolFee({ budgetUsdc: pipeline.totalCostUsdc })`.

**Superficie tocada (Scope IN):**
- `src/services/orchestrate.ts` (planOrchestration + executeApprovedPlan)
- `src/routes/orchestrate.ts` (/execute re-derivación)
- `src/services/fee-charge.ts` (SOLO doc-comment)
- `src/types/index.ts` (SOLO doc-comment)
- Tests: `orchestrate.test.ts`, `orchestrate.billing.test.ts`, `fee-charge.test.ts`,
  `routes/orchestrate.test.ts`, `compose.fee.test.ts`, `compose.test.ts` (regresión)

---

## 1. Constraint Directives — reglas accionables (tenelas a la vista mientras codeás)

| CD | Regla accionable |
|----|------------------|
| **CD-1** | `maxBudget = budget − feeUsdc` (orchestrate.ts:931) SE CONSERVA. `feeUsdc` ahora es la reserva **cost-based** (residual del plan), no `budget*rate`. Solo actualizás el comment. |
| **CD-2** | El guard de seguridad del fee SOBREVIVE en `chargeProtocolFee` (fee-charge.ts:167). El guard pre-planning `feeUsdc > budget` (orchestrate.ts:386) se **elimina** (era inalcanzable). |
| **CD-3** | Débito/credit-back step-0 (WKH-127) NO se toca. Solo cambia el cálculo/cobro del fee. |
| **CD-4** | `execution-id` server-side (`crypto.randomUUID()`, BLQ-MED-1) en `/execute` NO se altera. |
| **CD-5** | Path atómico `/orchestrate` byte-idéntico externo EXCEPTO el valor de `protocolFeeUsdc`. |
| **CD-6** | Fee cobrado en `/execute` == fee cotizado en `/plan`. Se logra porque el charge está gateado por `if (pipeline.success)` → `pipeline.totalCostUsdc` == costo cotizado (dentro del cap gate). |
| **CD-7** | `augmentX402ChallengeAmount` (compose.ts:127-178) y `quoteMaxCostUsdc` (orchestrate.ts:757-786) siguen calculando `pipelineUsd*(1+rate)`. **NINGUNO se toca.** El fee residual deriva DE `quoteMaxCostUsdc`, nunca lo altera. |
| **CD-8** | `quoteMaxCostUsdc` es **INMUTABLE**. Prohibido cambiar su fórmula, `PLACEHOLDER_FEE_USD`, o el floor 1e-6. |
| **CD-9** | `protocolFeeUsdc` del plan DEBE ser exactamente `Number(Math.max(0, maxQuotedCostUsdc − totalCostUsdc).toFixed(6))`. **PROHIBIDO** recomputarlo como `budget*rate` NI como `totalCostUsdc*rate` por separado (drift en caso placeholder). |
| **CD-10** | Fee CHARGED en execute: `budgetUsdc: pipeline.totalCostUsdc` (espejo compose.ts:539). Receipt: `amountUsd: feeResult.feeUsdc` (espejo compose.ts:559). **PROHIBIDO pasar `budget`.** |
| **CD-11** | `fee-charge.ts` NO cambia funcionalmente. Guard :167 y cálculo :163 intactos. Sin rename `budgetUsdc` (call site compose.ts:539 = Scope OUT). Solo doc-comment. |
| **CD-12** | `getProtocolFeeRate()` (fee-charge.ts, clamp [0,0.10]) es el fail-fast real del rate corrupto. NO se toca. |
| **CD-13** | En tests multi-step con compose real: mockear `discoveryService.getAgent` **por slug** (`mockImplementation`), NUNCA `mockResolvedValue` de un único agente (si no, todos los steps cobran igual → invariante de costo falso). |
| **CD-14** | `_resetAgentPriceCache()` en `beforeEach` — el cache de `agent-price.ts` es module-level y sangra entre tests. |
| **CD-15** | PROHIBIDO non-null assertions (`steps[0]!`). Resolver con guard explícito (`const s0 = steps[0]; s0 ? … : …`). biome no auto-fixea unsafe. |

---

## 2. Anti-Hallucination gates (invariantes que NO se rompen)

- **WKH-44 (maxBudget):** `maxBudget = budget − feeUsdc` se conserva; NO cambiar la fórmula, solo el comment.
- **WKH-127 (débito/credit-back step-0):** débito base = `plannedCostUsd` (+gas), credit-back compara contra `plannedCostUsd`/`debitedUsd`. NO tocar `orchestrate.ts:843-924` ni `:1010-1072`.
- **BLQ-MED-1 (execution-id):** `crypto.randomUUID()` server-side en `/execute` como idempotency key del fee. NO alterar (routes/orchestrate.ts:315).
- **CD-7 espejo:** `quoteMaxCostUsdc` ↔ `augmentX402ChallengeAmount` misma fórmula. NO tocar ninguno.
- **Scope OUT intacto:** `compose.ts` (route+service), `augmentX402ChallengeAmount`, `quoteMaxCostUsdc`, rango `PROTOCOL_FEE_RATE`, PWA Yarvis. Sin endpoints nuevos ni migraciones DB.
- **Nota tests (auto-blindaje WKH-131):** mockear `getAgent` por slug + `_resetAgentPriceCache()` en `beforeEach`. Distinguir "test que codificaba el bug" (`protocolFeeUsdc == budget*rate` → ACTUALIZAR al valor cost-based) de "test de contrato real".

---

## 3. Waves ejecutables

> `orchestrate.ts` y `routes/orchestrate.ts` son superficie de dinero compartida.
> **W0→W4 son SERIALES.** No paralelizar internamente.
> **Antes de editar cada línea:** confirmá el nº de línea con Read (el código pudo shiftear).
> Los diffs de abajo son la fuente de verdad del CÓMO.

---

### W0 — Serial · Contratos + Tests-first (RED)

**Objetivo:** fijar los invariantes en tests que FALLAN contra el código actual, antes de tocar producción.

**W0.1 — doc-comment `src/types/index.ts:456`:**
```diff
-  /** feeUsdc = budget * rate (espejo del atómico). */
+  /** WKH-132: fee cost-based = maxQuotedCostUsdc − totalCostUsdc (residual);
+   *  == totalCostUsdc + protocolFeeUsdc por construcción (AC-2). 0 en early-returns. */
   protocolFeeUsdc: number;
```

**W0.2 — doc-comment `src/services/fee-charge.ts:32-36` (CD-11, cero funcional):**
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

**W0.3 — Tests RED (deben fallar contra el código actual):**
- AC-1, AC-2, AC-9 en `orchestrate.test.ts`.
- AC-3 en `routes/orchestrate.test.ts` + `orchestrate.billing.test.ts`.
- Aplicá CD-13 (getAgent por slug), CD-14 (`_resetAgentPriceCache` en beforeEach), CD-15 (sin non-null).

**Verde al cerrar W0:** los tests nuevos compilan y FALLAN por el valor viejo (budget-based) — RED esperado. Doc-comments no rompen `tsc`.

**No tocar:** producción de orchestrate.ts/routes todavía; `quoteMaxCostUsdc`; guard interno de fee-charge.ts.

---

### W1 — Serial · `planOrchestration` (quote cost-based) — `src/services/orchestrate.ts`

**W1.1 — Eliminar bloque pre-planning budget-based (líneas 384-390):**
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
> **Si `ProtocolFeeError` queda huérfano en orchestrate.ts** → quitar su import (biome `noUnusedImports`). **Grepeá antes de borrar el import** — puede seguir usándose en otro sitio del archivo.

**W1.2 — Early-returns (4 sitios: :426, :478, :627, :679) → `feeUsdc: 0`:**
```diff
-        feeUsdc,
+        feeUsdc: 0, // WKH-132: sin steps ⇒ sin costo ⇒ sin fee
```
> Aplicar en los 4 sitios. `protocolFeeUsdc` ya era `0` en esos returns.

**W1.3 — Return `ready` (líneas 730-746) → fee residual (CD-9):**
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

**Verde al cerrar W1:** AC-1, AC-2, AC-9 (los de plan) pasan de RED a GREEN.

**No tocar:** `quoteMaxCostUsdc`; executeApprovedPlan (aún); débito step-0.

---

### W2 — Serial · `executeApprovedPlan` (charge cost-based) — `src/services/orchestrate.ts`

**W2.1 — `protocolFeeUsdc` reportado + charge base (líneas 950-965) (CD-10):**
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
> `feeRate` acá viene del destructuring/scope existente de execute (ya se computa vía `getProtocolFeeRate()` en :823/:964 — NO lo dupliques, reusá el que ya existe en el path de execute).

**W2.2 — Receipt `amountUsd` (línea 993) (CD-10):**
```diff
              receiptType: 'protocol_fee',
-             amountUsd: feeUsdc,
+             amountUsd: feeResult.feeUsdc, // WKH-132: espejo compose.ts:559
```

**W2.3 — `maxBudget` (línea 931) — SIN cambio de código, solo comment (CD-1/DT-4):**
```diff
-      maxBudget: budget - feeUsdc,
+      maxBudget: budget - feeUsdc, // WKH-132: feeUsdc = reserva COST-BASED (no budget*rate)
```
> `feeUsdc` acá es el destructurado del plan (:820), que tras W1 ya es cost-based. NO cambia el código, solo el comment.

**Verde al cerrar W2:** AC-3 (atómico), AC-5; regresión AC-6 (débito/credit-back WKH-127) verde sin tocarse.

**No tocar:** débito step-0 (:843-924); credit-back (:1010-1072); execution-id.

---

### W3 — Serial · `/execute` route re-derivación — `src/routes/orchestrate.ts` (líneas 349-351)

```diff
         const feeRate = getProtocolFeeRate();
-        const feeUsdc = Number((body.budget * feeRate).toFixed(6));
         const totalCostUsdc = costPerStep.reduce((sum, c) => sum + c, 0);
+        // WKH-132: base del fee = costo real resuelto server-side, NO budget.
+        // Sólo seedea plan.feeUsdc (reserva maxBudget); el fee REALMENTE cobrado
+        // se deriva de pipeline.totalCostUsdc dentro de executeApprovedPlan.
+        const feeUsdc = Number((totalCostUsdc * feeRate).toFixed(6));
```
> `plan.protocolFeeUsdc` (:367) y `plan.feeUsdc` (:372) se siguen seteando a `feeUsdc` (ahora cost-based). Ninguno se serializa; el response usa `result.protocolFeeUsdc` de `executeApprovedPlan` (pipeline-based). Consistencia interna preservada.
> **NO tocar** `orchestrationId = crypto.randomUUID()` (:315, CD-4/BLQ-MED-1) ni el gate 409 `QUOTE_STALE` (:399-405).

**Verde al cerrar W3:** AC-3 (/execute); regresión AC-7 (T-EXEC-9 BLQ-MED-1) verde.

---

### W4 — Serial · Regresión + Gates

- Suite completa verde: `orchestrate.test.ts`, `orchestrate.billing.test.ts`, `fee-charge.test.ts`, `routes/orchestrate.test.ts`, `compose.fee.test.ts`, `compose.test.ts`.
- `tsc --noEmit` limpio.
- `biome check` limpio (sin `any`, sin non-null assertions — CD-15).
- Verificar AC-8: sin drift `quoteMaxCostUsdc` ↔ `augmentX402ChallengeAmount` (ninguno se modificó).

---

## 4. Tabla de ACs → tests (9/9)

| AC | Test | Archivo | Qué verifica | Wave |
|----|------|---------|--------------|------|
| **AC-1** | `plan 'ready' → protocolFeeUsdc deriva del costo real` | `orchestrate.test.ts` | Pipeline costo 0.061 → `protocolFeeUsdc ≈ 0.00061` (== `maxQuoted−total`), NUNCA `budget*rate`. | W0/W1 |
| **AC-2** | `maxQuoted == total + fee (varios pipelines)` | `orchestrate.test.ts` | Pipelines {1 step 0.02}, {3 steps 0.061}, {step precio 0/placeholder}: `abs(maxQuoted − (total + fee)) ≤ 1e-6`. | W0/W1 |
| **AC-3** | `/execute cobra sobre pipeline.totalCostUsdc, no budget` | `routes/orchestrate.test.ts` + `orchestrate.billing.test.ts` | Spy de `chargeProtocolFee`: `budgetUsdc` arg == `pipeline.totalCostUsdc`. Fee cobrado ≈ fee cotizado en happy path. | W0/W2/W3 |
| **AC-4** | `no lanza ProtocolFeeError con rate en rango` + `guard cost-vs-cost vive` | `orchestrate.test.ts` + `fee-charge.test.ts` | Con `PROTOCOL_FEE_RATE ∈ [0,0.10]` no hay throw pre-planning; `fee-charge.test.ts` mantiene test de `feeUsdc > budgetUsdc → ProtocolFeeError`. | W1/regresión |
| **AC-5** | `atómico: shape idéntico salvo protocolFeeUsdc` | `orchestrate.test.ts` | Keys de `OrchestrateResult` == baseline; solo cambia el valor de `protocolFeeUsdc`. | W2 |
| **AC-6** | `débito/credit-back step-0 WKH-127 intacto` | `orchestrate.billing.test.ts` | Débito base = `plannedCostUsd` (+gas), NO el fee; tests WKH-127 verdes sin tocar. | regresión |
| **AC-7** | `execution-id BLQ-MED-1 intacto` | `routes/orchestrate.test.ts` | T-EXEC-9: 2 `/execute` mismo id cliente → 2 execution-ids server distintos. Verde sin cambios. | regresión |
| **AC-8** | `quoteMaxCostUsdc == augmentX402ChallengeAmount (sin drift)` | `orchestrate.test.ts` / `compose.fee.test.ts` | Mismos steps → misma fórmula. `quoteMaxCostUsdc` NO modificado. | W4 |
| **AC-9** | `mismo pipeline (0.061), budget 1.0 vs 5.0 → mismo fee` | `orchestrate.test.ts` | **Test clave.** 2 `planOrchestration` budget=1.0 vs 5.0, mismos steps → `protocolFeeUsdc` idéntico (~0.00061). Falla contra código viejo (0.01 vs 0.05). | W0/W1 |

**Regresión explícita (no romper):**
- `compose.fee.test.ts` + `compose.test.ts`: fee cost-based de /compose (WKH-118) sin cambio.
- `orchestrate.billing.test.ts`: débito/credit-back step-0 WKH-127 + guard `i>0` (AC-6).
- `routes/orchestrate.test.ts` T-EXEC-9: idempotencia execution-id (AC-7).
- `fee-charge.test.ts`: guard interno + idempotencia DB del fee sin cambio.

---

## 5. Exemplars verificados (patrones a copiar — paths reales del SDD §8)

| Exemplar | Path:línea | Uso |
|----------|-----------|-----|
| **Charge cost-based (patrón a copiar)** | `src/routes/compose.ts:537-541` | `chargeProtocolFee({ budgetUsdc: result.totalCostUsdc })` |
| **Receipt amount cost-based** | `src/routes/compose.ts:559` | `amountUsd: feeResult.feeUsdc` |
| Guard cost-vs-cost (sobrevive) | `src/services/fee-charge.ts:163-171` | `feeUsdc = budgetUsdc*rate` + `if (feeUsdc > budgetUsdc) throw` |
| Clamp del rate (fail-fast real) | `src/services/fee-charge.ts:94-115` | rango [0,0.10] + fallback + log.error |
| Espejo del quote (INMUTABLE) | `src/services/orchestrate.ts:757-786` | `pipelineUsd*(1+rate)` |
| Espejo x402 (INMUTABLE) | `src/routes/compose.ts:127-178` | misma fórmula |
| Toolbox de tests (mocks) | `src/services/orchestrate.test.ts` / `.billing.test.ts` | `getAgent` por slug + `_resetAgentPriceCache` |

---

## 6. Riesgos abiertos (para el AR, NO bloquean al Dev)

- **R-1 (BAJO):** CD-6 "fee cobrado == fee cotizado". El charge usa `pipeline.totalCostUsdc` gateado por `if (pipeline.success)` → solo cobra cuando TODOS los steps corrieron ⇒ costo ejecutado == cotizado (dentro del cap gate; drift por encima → 409, sin charge). Caller-favorable. Señalado para validación explícita del AR.
- **R-2 (BAJO):** tests legacy que asertaban `protocolFeeUsdc == budget*rate` en orchestrate FALLARÁN (es el bug). **ACTUALIZAR al valor cost-based** — no es regresión, es la corrección. Distinguir "test que codifica el bug" de "test de contrato real".

---

## 7. Definition of Done

- [ ] W0–W4 completadas en orden serial.
- [ ] Suite completa verde: `orchestrate.test.ts`, `orchestrate.billing.test.ts`, `fee-charge.test.ts`, `routes/orchestrate.test.ts`, `compose.fee.test.ts`, `compose.test.ts`.
- [ ] `tsc --noEmit` limpio.
- [ ] `biome check` limpio (sin `any`, sin non-null assertions — CD-15).
- [ ] **9/9 ACs verdes** con test dedicado (tabla §4).
- [ ] Regresión intacta: /compose fee (WKH-118), débito/credit-back step-0 (WKH-127, AC-6), execution-id (BLQ-MED-1, AC-7).
- [ ] Scope OUT intacto: `compose.ts` (route+service), `augmentX402ChallengeAmount`, `quoteMaxCostUsdc`, rango `PROTOCOL_FEE_RATE`, PWA Yarvis. Sin endpoints nuevos ni migraciones DB.
- [ ] `fee-charge.ts` sin cambio funcional (solo doc-comment — CD-11).
- [ ] Import `ProtocolFeeError` limpio en orchestrate.ts si quedó huérfano (grep antes de borrar).
