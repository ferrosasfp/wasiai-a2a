# Auto-Blindaje — Gas overhead pass-through (audit 2026-06-25)

### [2026-06-25 05:30] Wave 2 — Test leak: `mockResolvedValueOnce` survives `vi.clearAllMocks()`
- **Error**: el nuevo test de refund en `compose.test.ts` veía `result.success === true`
  (step 0 con output `"retry-done"`) en vez de fallar; el 502 del step 1 nunca fallaba el
  pipeline.
- **Causa raíz**: tests hermanos del bloque WKH-130 dejan encolados valores en
  `mockRegen` (`regenerateInputFromErrors`) vía `mockResolvedValueOnce(...)`.
  `vi.clearAllMocks()` limpia `mock.calls`/`mock.results` pero NO drena la cola de
  `*Once`. El global `beforeEach` hacía `mockRegen.mockResolvedValue(null)` (default
  persistente) pero ese default queda DETRÁS de los `Once` encolados → el primer
  step consumía un `Once` con un input regenerado → retry inesperado.
- **Fix**: en el `beforeEach` del bloque nuevo, `mockRegen.mockReset()` +
  `mockResolvedValue(null)` y `mockFetch.mockReset()` para drenar las colas `Once`.
  También se fija `registryService.getEnabled` a `[]` (clearAllMocks borra la impl).
- **Aplicar en**: cualquier test nuevo agregado al FINAL de un archivo con bloques
  que usan `mockResolvedValueOnce` (compose.test.ts, orchestrate.*). Si el test
  depende del orden de la cola de fetch/regen, llamar `.mockReset()` explícito en su
  propio `beforeEach`, no confiar en `clearAllMocks`.

### [2026-06-25 05:31] Wave 2 — Partial-refund en orchestrate: gas no se reembolsa si step-0 settleó
- **Error**: al sumar el gas overhead a `debitedUsd` del step-0 de orchestrate, la rama
  AC-6 (parcial) `Math.max(0, debitedUsd - pipeline.totalCostUsdc)` reembolsaba el gas
  overhead incluso cuando el step-0 SÍ settleó (gas ya gastado on-chain).
- **Causa raíz**: `pipeline.totalCostUsdc` se contabiliza SOLO con `agent.priceUsdc`
  (no incluye gas). Comparar contra `debitedUsd` (price+gas) dejaba un delta = gas que
  se devolvía indebidamente → revenue leak del gas en fallo parcial.
- **Fix**: en la rama parcial, comparar contra `plannedCostUsd` (porción de precio del
  step-0), NO contra `debitedUsd`. La rama de fallo total (`totalCostUsdc===0`) sí
  reembolsa `debitedUsd` completo (price+gas) porque nada settleó.
- **Aplicar en**: cualquier cálculo de refund que mezcle montos cobrados-con-overhead
  contra costos-reales-sin-overhead. El overhead solo se reembolsa si el settle (y por
  ende el gasto de gas) NO ocurrió.
