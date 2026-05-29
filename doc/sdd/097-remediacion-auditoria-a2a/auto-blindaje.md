# Auto-Blindaje — WKH-AUDIT-A2A (F3)

### [2026-05-29 21:25] Wave 4 — `npm run format` toca 34 archivos fuera de Scope IN
- **Error**: `npm run format` (= `biome format --write src/`) reformateó ~34 archivos
  con drift de formato pre-existente (test files, adapters, routes ajenos), no solo
  los 2 archivos del Scope IN (`bazaar.ts`, `types/index.ts`).
- **Causa raíz**: el repo tenía drift de formato acumulado en baseline; `format --write`
  opera sobre todo `src/`, no sobre un subconjunto. El Story File W4 solo scope-ó 2 archivos.
- **Fix**: `git checkout --` de los ~30 archivos fuera de Scope IN, conservando solo los
  cambios de formato en `bazaar.ts` y `types/index.ts` (los diffs exactos predichos por el
  Story File) más mis archivos de código/test legítimos.
- **Aplicar en**: cualquier HU que use `npm run format` en un repo con drift baseline —
  restaurar archivos fuera de scope tras el format. Considerar `biome format <file>` por archivo.

### [2026-05-29 21:25] Wave 4 — `npm run format` NO resuelve `organizeImports`
- **Error**: tras `npm run format`, `npm run lint` (= `biome check`) seguía reportando
  `assist/source/organizeImports` en `src/lib/bazaar.ts:25` (import `ajv` mal ordenado).
- **Causa raíz**: `biome format` solo formatea; `organizeImports` es un assist de `biome check`,
  no de `format`. El Story File AC-7 asumió `format` + `lint` = exit 0, lo cual no se cumple
  para archivos con imports desordenados.
- **Fix**: como `bazaar.ts` ES Scope IN (W4), apliqué `biome check --write src/lib/bazaar.ts`
  (scoped a un solo archivo in-scope) para resolver el organizeImports. NO se tocó ningún
  archivo fuera de scope.
- **Aplicar en**: futuras HUs que prometan "lint clean" — `npm run format` ≠ `npm run lint`.
  Para imports usar `biome check --write` scoped al archivo in-scope.

### Nota — baseline NO limpio (deviation reportada al orquestador)
- `npx tsc --noEmit` arroja 6 errores PRE-EXISTENTES en archivos `.test.ts`/`__tests__`
  (excluidos de `tsconfig.build.json`, por eso `npm run build` pasa). No introducidos por esta HU.
- `npm run lint` (todo `src/`) sigue con errores PRE-EXISTENTES en ~30 archivos fuera de Scope IN.
  Los 9 archivos in-scope pasan `biome check` con 0 errores. No expandí scope para arreglar el resto.
- TODOs (AC-7 sub-punto): `grep -rn "TODO\|FIXME\|XXX" src/` → 0 marcadores reales accionables;
  solo la palabra española "TODOS" en JSDoc (`registries.ts`, `price.ts`). No-op, no se tocó.
