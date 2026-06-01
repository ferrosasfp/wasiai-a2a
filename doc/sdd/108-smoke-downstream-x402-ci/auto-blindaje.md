# Auto-Blindaje — WKH-108 (smoke downstream x402 CI)

### [2026-06-01 09:27] FIX-PACK — biome no procesa archivos .mjs
- **Error**: `biome check --write` con un config temporal que usaba `files.includes` apuntando directamente a `scripts/smoke-downstream-x402.mjs` y `test/smoke-downstream-x402.test.mjs` reportó "No files were processed in the specified paths" y los ignoró.
- **Causa raíz**: el `biome.json` del repo restringe `files.includes` a `src/**/*.ts`; al pasar paths .mjs explícitos en un config temporal con un `includes` literal a esos paths, biome los trató como ignorados (el glob literal no calzó con su resolución interna de includes para extensiones no .ts).
- **Fix**: usar un config temporal con `files.includes: ["**/*.mjs"]` (glob por extensión, no path literal) y pasar los archivos como argumentos. Biome procesó 2 files y aplicó formato a 1.
- **Aplicar en**: cualquier FIX-PACK o F3 futuro que toque archivos `.mjs`/`.cjs` (scripts, smokes, workflows helpers). El `biome.json` del repo solo cubre `src/**/*.ts`; para lint/format de scripts hay que usar un config temporal con `includes: ["**/*.mjs"]`.
