# Auto-Blindaje — WKH-102 (orchestrate billing fix)

### [2026-05-31] Wave Tests — Integration test fallaba con "No payTo address"
- **Error**: el primer run de `orchestrate.billing.test.ts` (compose REAL) falló con
  `Step 0 failed: No payTo address for agent ...` en los 4 tests. El débito per-step
  nunca corría porque `invokeAgent` reventaba antes.
- **Causa raíz**: `compose.ts:385` firma x402 inbound cuando `agent.priceUsdc > 0 && !a2aKey`.
  El path master de `/orchestrate` (route `orchestrate.ts:78`) propaga SOLO `scopingKeyRow`,
  NO `a2aKey` → compose toma el branch x402 y requiere `metadata.payTo`. Mi fixture no lo tenía
  ni mockeaba el payment adapter.
- **Fix**: en el test (NO en producción) (a) mockear `../adapters/registry.js` `getPaymentAdapter`
  con `sign`/`settle` stub que resuelven OK, y (b) agregar `metadata.payTo` al fixture `makeAgent`.
  Esto refleja el path master real (sin a2aKey) sin tocar el SUT.
- **Aplicar en**: cualquier test de integración que ejercite `composeService.compose` con
  agentes `priceUsdc > 0` y sin `a2aKey` debe mockear el payment adapter + setear `metadata.payTo`,
  o pasar `a2aKey` para saltar el branch x402.

### [2026-05-31] Wave Tests — Biome lint: import sort + formatter
- **Error**: `npm run lint` (biome check) marcó 2 errores en el archivo nuevo:
  imports no ordenados (`Agent, A2AAgentKeyRow` → debe ser `A2AAgentKeyRow, Agent`) y un
  `.mockResolvedValue({...})` que el formatter quería multi-línea.
- **Causa raíz**: `npm run lint` es `biome check` (solo verifica, no fixea). El archivo se
  escribió con orden/formato distinto al canon de Biome.
- **Fix**: `./node_modules/.bin/biome check --write <archivo>` aplica organizeImports + format.
- **Aplicar en**: todo archivo nuevo/tocado — correr `biome check --write` (o `npm run format`
  + revisar organizeImports) ANTES de `npm run lint`, no después.
