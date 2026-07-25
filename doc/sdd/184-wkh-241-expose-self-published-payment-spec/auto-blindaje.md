# Auto-Blindaje — WKH-241 (F3)

### [2026-07-25 02:33] Wave 2 — Gate de lint (biome format) rojo por líneas largas en el test nuevo
- **Error**: `npx biome check src/` salió con 1 error de formatter en
  `src/lib/payment-spec-reader.test.ts` (una llamada `expect(...)` y un `for (const chain of [...])`
  que biome parte en varias líneas). `tsc --noEmit` y `vitest run` ya estaban verdes.
- **Causa raíz**: escribí los tests a mano sin correr el formatter de biome antes del gate;
  biome (line width 80) reformatea llamadas/arrays que superan el ancho, y `biome check`
  (sin `--write`) trata el diff de formato como ERROR de CI, no como warning.
- **Fix**: `npx biome check --write src/` + re-verificación `npx biome check src/` → 0 errores.
  Ningún cambio semántico (solo saltos de línea).
- **Aplicar en**: cualquier archivo nuevo `.ts`/`.test.ts` de este repo — correr
  `npx biome check --write src/` ANTES de declarar el gate de lint, en especial en tests con
  literales largos (arrays de slugs, objetos de fixture, `expect(...)` anidados).

### [2026-07-25 02:20] Wave 0 — Imports huérfanos al extraer una función a un módulo leaf
- **Error potencial detectado y evitado**: al mover `readPayment` de `src/services/discovery.ts`
  a `src/lib/payment-spec-reader.ts`, `discovery.ts` quedaba con dos imports sin uso
  (`normalizeChainSlug` de `../adapters/chain-resolver.js` y el tipo `AgentPaymentSpec`).
- **Causa raíz**: `tsconfig.json` NO tiene `noUnusedLocals`, así que `tsc --noEmit` pasa igual;
  el único gate que lo caza es biome (`noUnusedImports`), que corre después.
- **Fix**: grep de las 2 referencias en `discovery.ts` inmediatamente después del move y
  eliminación de ambos imports en el mismo commit.
- **Aplicar en**: toda extracción/move de funciones entre módulos de este repo — grepear el
  archivo origen por cada símbolo que la función movida usaba (no confiar en `tsc`).
