# Auto-Blindaje — WKH-159 (greedy multilingual guard, cosmetic)

### [2026-07-07] Wave 1 — Biome line-width en objeto inline de test
- **Error**: `biome check src/` falló en un argumento de objeto inline
  `{ goal: 'a b c', budget: 5.0, chainId: 2368, scopingKeyRow: masterKeyRow() }`
  pasado a `orchestrateService.orchestrate(...)` — Biome exige el objeto
  multi-línea cuando la línea excede el ancho configurado.
- **Causa raíz**: escribí el request inline copiando el estilo de otro test más
  corto, sin correr el formatter antes del check.
- **Fix**: expandí el objeto a formato multi-línea (una prop por línea, coma
  trailing). Ningún cambio de lógica.
- **Aplicar en**: cualquier llamada nueva a `orchestrate`/`planOrchestration`
  con request inline en los tests — usar siempre objeto multi-línea (es el
  estilo dominante en `orchestrate.test.ts`). Correr `biome check src/` antes
  del gate, no solo `tsc`.
