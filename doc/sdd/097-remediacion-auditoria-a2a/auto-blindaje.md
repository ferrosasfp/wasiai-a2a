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

### [2026-06-24 19:42] Wave 2b — `CREATE OR REPLACE FUNCTION` no puede cambiar el tipo de retorno
- **Error**: las RPC `refund_a2a_key_spend`/`refund_with_dest_policy` pasaban de
  `RETURNS void` a `RETURNS INT` (item A2). Un `CREATE OR REPLACE FUNCTION` directo
  con distinto return type falla en Postgres (`cannot change return type of existing function`).
- **Causa raíz**: Postgres trata el return type como parte de la identidad de la función;
  `OR REPLACE` solo permite cambiar el cuerpo, no la firma de retorno.
- **Fix**: `DROP FUNCTION IF EXISTS <firma exacta>` ANTES del `CREATE FUNCTION` con el nuevo
  `RETURNS INT`. El down hace lo simétrico para restaurar `RETURNS void`.
- **Aplicar en**: cualquier migración que cambie el tipo de retorno de una RPC existente —
  siempre DROP+CREATE, nunca OR REPLACE.

### [2026-06-24 19:42] Wave 2b — default mock de `creditWithDest` en compose.test sin `reverted` rompía el retry
- **Error**: al gatear el re-debit del retry adaptativo en `creditRes.reverted === true`,
  el default mock `mockCreditWithDest.mockResolvedValue({ success: true })` (sin `reverted`)
  hacía que el gate evaluara `undefined === true` → false → el retry NO re-debitaba → el test
  M3 (espera 2 débitos) habría fallado.
- **Causa raíz**: agregué un campo nuevo (`reverted`) al contrato del service pero el fixture
  default de los tests existentes no lo proveía. El gate estricto (`=== true`) lo trataba como
  no-revertido.
- **Fix**: actualicé el default mock a `{ success: true, reverted: true }` en `beforeEach`
  (mockCredit y mockCreditWithDest). Los tests A2 nuevos overridean con `reverted: false`.
- **Aplicar en**: al ampliar el shape de retorno de un service mockeado, actualizar SIEMPRE el
  default `mockResolvedValue` del fixture, no solo los tests nuevos.

### [2026-06-24 19:42] Wave 2b — supabase real (localhost:54321) en tests de middleware x402
- **Error**: el nuevo INSERT anti-replay en `x402.ts` invoca `supabase.from('a2a_x402_nonces')`.
  Los tests de middleware x402 (binding/chain-aware/...) NO mockeaban supabase → pegaban al
  cliente real apuntando a `localhost:54321` (inalcanzable en CI).
- **Causa raíz**: esos tests nacieron sin tocar la DB; mi cambio agregó una dependencia de DB
  en el hot path del middleware. El fail-open conservador salvó el verde (connection-refused
  → `unavailable` → settle procede), pero dependía de un side-effect frágil.
- **Fix**: agregué un `vi.mock('../lib/supabase.js')` determinista en `x402.binding.test.ts`
  (`mockNonceInsert` drive fresh/replay/db-error) y 3 tests M1 explícitos (fresh→settle,
  replay→402 sin settle, db-error→fail-open→settle). Los otros 3 archivos x402 siguen verdes
  por el fail-open (connection-refused rápido, no cuelga).
- **Aplicar en**: al introducir una dependencia de DB en un middleware ya cubierto por tests,
  mockear supabase explícitamente en esos archivos en vez de depender del connection-refused.
