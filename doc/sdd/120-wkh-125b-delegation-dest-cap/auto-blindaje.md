# Auto-Blindaje — WKH-125b (delegation dest-cap)

### [2026-06-22 21:52] Wave 2 — Biome formatter rompió por línea larga en el e2e

- **Error**: `npm run lint` (biome check) reportó un format error en
  `src/__tests__/e2e/delegation-atomicity.real.test.ts:210` — la aserción
  `expect(Number(delAfter?.total_spent)).toBe(Number(delBefore?.total_spent));`
  excedía el ancho de línea y biome la quería multilínea.
- **Causa raíz**: escribí la aserción en una sola línea sin correr el formatter
  antes del check. Biome (a diferencia de prettier-on-save) falla el `check` si
  el formato no coincide, no lo auto-arregla en CI.
- **Fix**: envolví el `Number(delBefore?.total_spent)` en su propia línea
  (formato que biome imprime). `biome check` sobre los 7 archivos tocados → 0 errores.
- **Aplicar en**: cualquier aserción `expect(...).toBe(...)` con dos llamadas
  `Number(...)` anidadas o args largos → escribir ya multilínea, o correr
  `./node_modules/.bin/biome check <files>` antes de cerrar la wave de tests.

### [2026-06-22 21:50] Wave 2 — Lint global tiene 1 error PRE-EXISTENTE fuera de scope

- **Error**: `npm run lint` (biome check src/) reporta 1 error en
  `src/services/reputation.ts:116` (`lint/complexity/useLiteralKeys`).
- **Causa raíz**: NO es de esta HU. `git diff origin/main -- src/services/reputation.ts`
  → vacío. Es deuda pre-existente en main, fuera del Scope IN de WKH-125b.
- **Fix**: NO tocar (PROHIBIDO expandir scope). Lint scopeado a los 7 archivos
  de la HU (`biome check <7 files>`) → 0 errores. El error de reputation.ts
  debe trackearse como item aparte, no en esta branch.
- **Aplicar en**: cuando `npm run lint` global falle, separar errores propios
  de pre-existentes con `git diff origin/main -- <file>` antes de asumir culpa.
