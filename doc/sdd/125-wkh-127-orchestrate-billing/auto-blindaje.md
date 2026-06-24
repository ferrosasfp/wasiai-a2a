# Auto-Blindaje — WKH-127 (Orchestrate Billing)

### [2026-06-23 20:15] Wave 5 — Test pre-existente fuera de Scope IN rompe por el nuevo débito step-0 en el service

- **Error**: tras implementar el débito post-plan en `orchestrateService.orchestrate`
  (W4.4), el archivo `src/services/orchestrate.billing.test.ts` (NO listado en el
  Scope IN del Story File) empezó a fallar: 4 tests (T-BILL-1..4). Esos tests
  ejercitan el COMPOSE REAL (no mockeado) con un `scopingKeyRow` master y
  aseveran el conteo EXACTO de `budgetService.debit` por step (steps 1..N). Antes
  de WKH-127 el service NO debitaba el step-0 (lo hacía el middleware), así que
  el conteo solo reflejaba los per-step. Ahora el service agrega un débito step-0
  (3-arg) → el conteo y el orden de llamadas cambiaron (p.ej. T-BILL-1 esperaba 2,
  ahora son 3: step-0 + steps 1,2).
- **Causa raíz**: el Story File §1 (Scope IN) y §5 (tabla de tests) omitieron este
  archivo. Es un test de integración WKH-102 que vive en el mismo límite que
  WKH-127 modifica (débito master en el service). El Story File listó
  `orchestrate.test.ts` (mocks de compose) pero no `orchestrate.billing.test.ts`
  (compose real). El cambio de comportamiento (mover step-0 al service, CD-11) es
  exactamente lo que rompe estas aserciones — comportamiento correcto, test
  desactualizado.
- **Fix**: actualizar las aserciones de `orchestrate.billing.test.ts` para
  contemplar el nuevo débito step-0 del service (forma 3-arg
  `debit(keyId, chainId, plannedCostUsd)`) ANTES de los débitos per-step
  (6-arg con destino) que produce compose. Se ajustó:
  - mock de `getBalance` para devolver un balance > 0 (sin esto, el pre-check
    `Number(bal) <= 0` con `getBalance` no mockeado devolvía `NaN`, y el nuevo
    `getBalance` post-refund/remaining se llamaba sin valor).
  - `beforeEach`: `getBalance` default `'10'`.
  - conteos/orden: T-BILL-1 (3 calls: step-0 0.06 + 0.02 + 0.03), T-BILL-2
    (2 calls: step-0 0.09 + 0.02), T-BILL-3 (step-0 OK + step-1 falla),
    T-BILL-4 (1 call: solo step-0 0.05 del service; sin per-step).
  La lógica de producción NO se cambió por estos tests; solo se actualizaron las
  expectativas para reflejar CD-11 (step-0 ahora en el service para master).
- **Aplicar en**: cuando un Story File mueve un débito/cobro entre capas
  (middleware ↔ service), buscar TODOS los tests que aseveran conteos de
  `budgetService.debit`/`credit` en ambas capas (incl. tests de integración con
  compose real), no solo los que el Story File lista explícitamente.
  `grep -rn "toHaveBeenCalledTimes\|mockDebit" src` sobre el método tocado.

### [2026-06-24 02:30] AR fix — BLQ-ALTO-1: double-charge de steps 1..N (drift de diseño SDD §4.0)

- **Error**: `plannedCostUsd` (la base del débito post-plan "step-0" del service en
  `orchestrate.ts`) se calculó como `sum(agent.priceUsdc)` de TODO el plan (greedy
  `cost = selected.reduce(...)` y LLM `plannedCostUsd = totalCost`). Pero
  `composeService.compose` SIGUE debitando los steps 1..N por separado (guard
  `i > 0` en compose.ts:136). Resultado: los steps 1..N quedaban debitados DOS
  veces — una en la suma del service (step-0), otra en compose. Total cobrado =
  Σplan + Σ(steps 1..N) en vez de Σplan. Es un path de dinero (crea cobro fantasma).
  Peor: los tests (`orchestrate.billing.test.ts` T-BILL-1/2/4 y `orchestrate.test.ts`
  T-AC1/AC3) habían sido AJUSTADOS para AFIRMAR la suma como correcta
  (`step0Call[2] ≈ 0.06`), benditando el bug.
- **Causa raíz**: DRIFT DE DISEÑO. El SDD §4.0 step-4 dijo "débito = sum del plan"
  cuando el modelo de billing real exige "débito = precio del step-0". El objetivo
  de WKH-127 era reemplazar el placeholder $1 que el middleware debitaba SOLO para
  el step-0 por el precio REAL del step-0 — no introducir un cobro nuevo por el plan
  entero. Compose nunca dejó de cobrar 1..N. El Dev implementó el SDD al pie de la
  letra (sum), heredando el error de diseño; los tests se calibraron a ese mismo
  modelo equivocado, así que pasaban en verde y ocultaban el double-charge. El AR
  (compose real, no mockeado) lo atrapó comparando el total debitado vs el costo real.
- **Fix** (quirúrgico, solo `orchestrate.ts` + tests; compose.ts y el guard `i>0`
  INTACTOS):
  - greedy (`greedyPlan`): `cost = selected[0]?.priceUsdc ?? 0` (antes: `reduce` suma).
    La suma del plan se conserva SOLO para el texto de `reasoning`.
  - LLM: `plannedCostUsd = discovered.agents.find(slug===budgetedAgents[0].slug)?.priceUsdc ?? 0`
    (antes: `= totalCost`).
  - Fallback $1 (AC-4) y refund (AC-5/AC-6) quedaron correctos sin cambios: con
    `debitedUsd = precio del step-0`, fallo total reembolsa el step-0 (arregla el
    incidente original) y fallo parcial da `max(0, step0 - totalCost) = 0` cuando el
    step-0 settleó. Se actualizaron los comentarios para reflejar la semántica step-0.
  - Tests recalibrados al modelo correcto + se agregó la REGRESIÓN clave: invariante
    `Σ(todos los débitos: service step-0 + compose steps 1..N) == costo real del plan`
    (cada step cobrado UNA vez). T-BILL-1: total 0.06 (no 0.11). T-AC1/AC3: step-0 =
    0.30 (no 0.50). T-AC5/AC6a/AC8: refund recalculado sobre debited=0.30.
- **Aplicar en**: cuando un SDD describe un débito como "suma/total" verificar SIEMPRE
  contra qué OTRA capa cobra los mismos ítems (acá compose con guard `i>0`). Si dos
  capas tocan el mismo conjunto de steps, el débito de cada capa debe ser DISJUNTO.
  Regla de oro para todo path de dinero: testear el INVARIANTE TOTAL (Σ débitos ==
  costo real, cada ítem una vez) con la dependencia REAL (no mockeada), nunca solo
  el conteo/monto por capa aislada — un mock de compose oculta el double-charge.
