# Auto-Blindaje — WKH-143b (write-path de creator/referral)

### [2026-07-04] Wave 1 — Orden de imports (biome) al agregar `wallet-format.js`
- **Error**: `biome check` falló en `src/services/agent.ts` — coloqué
  `import { isValidWallet } from '../lib/wallet-format.js';` entre `supabase.js` y
  el bloque `url-validator.js`, rompiendo el orden alfabético que exige Biome
  (organizeImports).
- **Causa raíz**: agrupé mentalmente por "lib/" sin respetar el orden alfabético
  intra-grupo: `url-validator` < `wallet-format`.
- **Fix**: mover el import de `wallet-format.js` DESPUÉS del bloque
  `url-validator.js`. `agents.ts` ya lo tenía en orden correcto
  (`url-validator` → `wallet-format` → `middleware/`).
- **Aplicar en**: cualquier archivo que agregue un import nuevo de `../lib/*` —
  verificar el orden alfabético del path completo dentro del grupo antes de
  cerrar la wave; correr `biome check` sobre los archivos tocados.
