# Auto-Blindaje — WKH-150 [WKH-144b]

### [2026-07-06 18:45] Wave 0 — `SUPPORTED_CHAINS` no está exportado (y es 6, no 7)
- **Error**: El work-item (AC-2b/2c) y el prompt piden "iterá `SUPPORTED_CHAINS`"
  para la exhaustividad del test, pero `SUPPORTED_CHAINS` en `registry.ts:28` es
  un `const` NO exportado, y además solo tiene 6 slugs (`tempo-testnet` se agrega
  dinámicamente en `getSupportedChains()` bajo `TEMPO_ADAPTER_ENABLED`).
- **Causa raíz**: importar `SUPPORTED_CHAINS` obligaría a exportarlo = tocar
  `registry.ts`, que está explícitamente PROHIBIDO por el orquestador. Conflicto
  entre "iterá SUPPORTED_CHAINS" y "NO tocar registry".
- **Fix**: enumerar vía un mapa tipado `Record<ChainKey, Chain>` en el test. La
  fuente canónica del invariante es el propio union `ChainKey` (F0 #2 del
  work-item), del cual `SUPPORTED_CHAINS` es un subconjunto. El `Record<ChainKey>`
  da exhaustividad en **compile-time** (agregar un `ChainKey` nuevo sin mapping
  rompe `tsc`), más fuerte que un check runtime contra `SUPPORTED_CHAINS`, y sin
  tocar `registry.ts`. Cubre los 7 slugs (incluye `tempo-testnet`).
- **Aplicar en**: cualquier test futuro que quiera "recorrer todas las chains" —
  preferí `Record<ChainKey, X>` (exhaustividad de tipos) sobre importar
  `SUPPORTED_CHAINS` (no exportado + incompleto por el flag de Tempo).

### [2026-07-06 18:45] Wave 0 — biome fuerza estilo propio de `it.each`
- **Error**: `biome check` marcó formato en el `it.each(cases)('...', fn)` que
  escribí (quería `it.each(\n  cases,\n)('...', fn => {...})`).
- **Causa raíz**: convención de line-break de biome para llamadas encadenadas.
- **Fix**: `biome check --write` (autofix); sin cambio semántico.
- **Aplicar en**: correr `./node_modules/.bin/biome check --write <archivo>` antes
  del gate en cualquier test nuevo con `it.each`. Nota: `npx biome` se rompe bajo
  el hook RTK ("could not determine executable") — usar el binario directo
  `./node_modules/.bin/biome`.
