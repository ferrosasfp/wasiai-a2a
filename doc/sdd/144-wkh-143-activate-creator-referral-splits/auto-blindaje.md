# Auto-Blindaje — WKH-143 (activar splits creator/referral)

### [2026-07-04 02:58] Wave 2 — Import order tras agregar imports en call-sites
- **Error**: `biome check` falló con `organizeImports` en `orchestrate.ts`, `compose.ts` (routes), `agent-split-context.ts` y `fee-charge-splits.test.ts` — los imports nuevos (`splitsActive` de `../config/split-config.js`, `resolveAgentSplitContext`, `FeeChargeParams`, `SplitPartyRef`) se agregaron sin respetar el orden alfabético/agrupado que Biome exige.
- **Causa raíz**: Biome organiza imports por ruta; agregar una línea `import` en el punto "lógico" (junto a los otros de fee-charge) no coincide con el orden que Biome computa (`../config/...` va antes que `../lib/...`).
- **Fix**: `npx @biomejs/biome check --write` sobre los archivos tocados (safe fix). Typecheck + tests siguen verdes tras el reorder (solo movió líneas de import).
- **Aplicar en**: cualquier HU que agregue imports — correr `biome check --write` sobre los archivos tocados ANTES del commit, no confiar en el orden manual.

### [2026-07-04 02:58] Wave 3 — Orden de queries del mock supabase en tests del seam
- **Error potencial (evitado)**: en `fee-charge-splits.test.ts`, `settleFeeSplits` corre ANTES del idempotency SELECT de plataforma; si las colas `selectQ/insertQ/updateQ` se cargaban en orden plataforma-primero, los legs leerían el row equivocado.
- **Causa raíz**: `chargeProtocolFee` invoca `settleFeeSplits` (legs creator/referral/skipped) en la línea previa a construir `buildSplits` y al SELECT de plataforma. El orden real es: leg(s) adicional(es) → plataforma.
- **Fix**: cargar las colas en orden leg-adicional-primero (creator select/insert/update, LUEGO platform). Para el fallback SG-6, `recordSkipped` hace SOLO un `insert` (sin select) → la cola de select del skipped-case tiene solo el row de plataforma.
- **Aplicar en**: cualquier test futuro que ejercite `chargeProtocolFee` con splits activos — respetar el orden extras→plataforma en las colas del mock.
