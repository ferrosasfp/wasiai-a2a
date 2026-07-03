# Auto-Blindaje — WKH-132 (fee transparency)

### [2026-07-03 13:38] F3 — Biome format en `it.each(...)` multilínea
- **Error**: el bloque de test parametrizado (`it.each([...] as const)(...)` para AC-2)
  quedó con un salto de línea entre el `)` del array y los argumentos, que Biome
  colapsa a una sola línea; `biome check` marcó 2 errores de formato.
- **Causa raíz**: escribí el `it.each` con el estilo de indentación de un `it`
  normal, sin correr el formatter antes de dar por cerrado el archivo.
- **Fix**: `biome check --write` sobre los 2 archivos tocados; re-corrida de
  tests (23 PASS) para confirmar que el reformat no cambió semántica.
- **Aplicar en**: cualquier test nuevo — correr `./node_modules/.bin/biome check`
  sobre los archivos tocados antes del commit (el `npm test`/`tsc` no cubre formato).
