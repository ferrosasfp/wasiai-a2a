# Auto-Blindaje — WKH-123 KEY-SIGNED-AUTH

### [2026-06-19 W0] Required-field fanout en fixtures de tests consumidores
- **Error**: agregar `require_signature: boolean` (no opcional) a `A2AAgentKeyRow` y `require_signature`/`signing_secret_hash` a `KeySessionRow` rompió `tsc` en 14 archivos de test fuera del Scope IN (TS2322/TS2741): cada fixture base que construye un literal completo del row carecía del campo nuevo.
- **Causa raíz**: el Story File W0.1 especifica el campo como `boolean` requerido (decisión del Architect, correcta para back-compat: el row siempre trae el flag desde DB). Un campo requerido nuevo en un row-type ampliamente consumido obliga a actualizar TODO fixture que lo materialice.
- **Fix**: inserción puramente mecánica de `require_signature: false,` (y `signing_secret_hash: null` para KeySessionRow) en cada fixture base, justo después de `metadata: {}` / `created_at`. Sin cambios de lógica, sin tocar asserts. Anclado al par `funding_wallet:` → `metadata: {}` para no afectar otros literales (ej. compose.test.ts con múltiples `metadata:`).
- **Aplicar en**: cualquier futura HU que agregue un campo requerido a `A2AAgentKeyRow`/`KeySessionRow` debe prever el fanout a los ~14 fixtures. Considerar un helper fixture compartido para no repetir el literal completo (TD potencial, fuera de scope acá).

### [2026-06-19 W4] organizeImports falló el lint tras agregar import en a2a-key.ts
- **Error**: `npm run lint` (biome) marcó `assist/source/organizeImports` en `src/middleware/a2a-key.ts:8` porque agregué `import { verifySignedAuth } from '../services/signed-auth.js'` en una posición que biome quería reordenar.
- **Causa raíz**: olvido de correr `npm run format` (que aplica organizeImports) ANTES de `npm run lint`. El orden del proyecto es format → lint.
- **Fix**: `biome check --write src/middleware/a2a-key.ts` aplicó el reorden seguro; tsc siguió en 0 tras el reorder. Confirmado que `signed-auth.ts` no tiene logging (CD-5) y que las 11 archivos WKH-123 pasan biome limpio.
- **Aplicar en**: SIEMPRE `npm run format` antes de `npm run lint` al agregar imports. Nota: el `info` de `lint/complexity/useLiteralKeys` en `src/services/reputation.ts:116` es PRE-EXISTENTE (diff vacío vs HEAD), severidad `info` (no falla el lint), y FUERA del Scope IN → no se toca.
