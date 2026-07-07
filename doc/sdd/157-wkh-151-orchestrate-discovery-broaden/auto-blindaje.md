# Auto-Blindaje — WKH-151

### [2026-07-06] Wave 1 — biome line-width en objeto inline del test
- **Error**: `./node_modules/.bin/biome check src/` falló con 1 error de formato en `orchestrate.test.ts`: un objeto request inline `{ goal: '...', budget: 5.0, preferCapabilities: ['x'] }` excedía el ancho de línea de biome y debía romperse en multilínea.
- **Causa raíz**: escribí el argumento del `planOrchestration` en una sola línea; biome (formatter) exige multilínea cuando el objeto supera el print-width.
- **Fix**: `./node_modules/.bin/biome check --write src/services/orchestrate.test.ts` (auto-format), recheck limpio (0 errores).
- **Aplicar en**: al escribir objetos literales como args en tests/código, correr `biome check --write` sobre el archivo tocado antes del gate final en vez de asumir que el formato manual pasa. Nota de proceso: `npx biome` se rompe bajo el hook RTK → usar el binario directo `./node_modules/.bin/biome`.
