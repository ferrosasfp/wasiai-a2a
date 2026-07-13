# Auto-Blindaje — HU 191g (wire arbiter → WasiAIEscrow)

### [2026-07-13 12:38] Wave 2 — Import placeholder inexistente en arbiter.ts
- **Error**: en el bloque de imports agregué una línea fantasma
  `executereleaseDisputePlaceholder as _unusedPlaceholder` que no existe en
  `arbiter-executor.ts`.
- **Causa raíz**: edición apresurada del bloque de imports (copy sobrante).
- **Fix**: removí la línea; el import quedó solo con los 4 símbolos reales
  (`deriveArbiterNonce`, `executeLockForDispute`, `executeReleaseDispute`,
  `executeResolveDispute`).
- **Aplicar en**: cualquier edición de bloques `import { ... }` — verificar que
  CADA símbolo importado exista con `grep "export .* <sym>"` antes de tsc.

### [2026-07-13 12:38] Wave 3 — Mocks vi.fn con aridad fija + spread (CD-AB-2)
- **Error**: `tsc` TS2556 "A spread argument must either have a tuple type or be
  passed to a rest parameter" en los wrappers `(...a: unknown[]) => mockX(...a)`
  cuando `mockX = vi.fn((): T => ...)` o `vi.fn((_chainKey: unknown) => ...)`
  (aridad 0 o 1, no rest).
- **Causa raíz**: patrón recurrente del epic 191 — un `vi.fn` tipado con parámetros
  fijos no acepta el spread de `unknown[]` del wrapper.
- **Fix**: tipar TODOS los mocks consumidos vía spread con rest param:
  `vi.fn((..._a: unknown[]): T => ...)`.
- **Aplicar en**: cualquier `vi.mock` factory que reexpone un hoisted `vi.fn`
  mediante `(...a) => mock(...a)`. Es el mismo hallazgo CD-AB-2 (≥3 HUs ya).

### [2026-07-13 12:39] Wave 3 — `release` requiere vouchers en la evidencia
- **Error**: los tests de wire con `consumedUsd == authorizedUsd` esperaban
  `decision: 'release'` pero obtenían `'hold'` (rules → ambiguous → LLM mock
  devuelve undefined → fail-closed HOLD).
- **Causa raíz**: `classify` de `rules.ts` NO clasifica `release` solo por
  `consumed >= deposit`; necesita `voucherCount`/`vouchersTotalUsd` que respalden
  el consumo (patrón del test existente AC-3, `arbiter.test.ts:477-479`).
- **Fix**: agregar `voucherCount: 2, vouchersTotalUsd: 10` a la evidencia de todos
  los escenarios release del wire.
- **Aplicar en**: cualquier test nuevo del árbitro que necesite un veredicto
  `release` determinístico por rules — copiar la forma de evidencia del exemplar
  AC-3, no asumir que `consumed>=deposit` basta.
