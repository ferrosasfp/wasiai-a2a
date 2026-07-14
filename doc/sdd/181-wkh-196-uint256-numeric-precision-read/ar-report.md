# AR Report — WKH-196 (uint256 NUMERIC(78,0) precision-loss read fix)

- **Branch/commit**: `fix/181-wkh-196-uint256-numeric-precision-read` @ `d024b6c`
- **Reviewer**: nexus-adversary (AR)
- **Money-path / on-chain**: SÍ (escrow debit two-hop settle)
- **Veredicto**: **RECHAZADO** — 1 BLOQUEANTE-BAJO activo (typecheck roto en test). El fix funcional es correcto y completo; el blocker es de calidad de tipos, one-line.

---

## Resumen ejecutivo

El fix (castear `columna::text` en los 5 `.select()` que leen `debit_nonce` / `debit_amount_atomic` / `nonce` NUMERIC(78,0)) es **funcionalmente correcto, completo y bien testeado**. Barrido exhaustivo confirmó el inventario cerrado del SDD: NO hay ningún otro `.select()` que lea esas columnas sin cast, y no hay `.select('*')` sobre las dos tablas críticas. El bug real queda muerto: los tres sink-points hacen `BigInt(string)` directo sin pasar por `Number` intermedio.

Único hallazgo: el nuevo test T-NEW-1 introduce **2 errores de `tsc`** en `debit-capture.test.ts` (el resto del repo estaba tsc-clean sobre tests). No rompe runtime (102/102 tests PASS) ni el build de producción (`npm run build` excluye tests → exit 0), pero viola el gate auto-impuesto DT-5 ("`tsc` limpio antes de F3-done") y el Golden Path "TypeScript strict".

---

## Hallazgos por categoría

| # | Categoría | Severidad | Nota |
|---|-----------|-----------|------|
| 1 | Completitud del fix (inventario cerrado) | OK | Todos los `.from()` de las 2 tablas verificados |
| 2 | Corrección del cast (sin alias, key preservada) | OK | `::text` no renombra |
| 3 | CD-6 (deadline no casteado / driftCheck solo amount) | OK | Verificado + testeado (T-NEW-8) |
| 4 | Regresión / CD-1 / CD-4 (path captura intacto) | OK | Solo cambian literales del select |
| 5 | Ownership Guard (WKH-53) | OK | Cadenas `.eq('owner_ref')` intactas |
| 6 | Type Safety (tsc) | **BLQ-BAJO-1** | 2 errores tsc en test nuevo |
| 7 | Test Coverage / anti-tautología | OK | cast-presence = guarda real de regresión |
| 8 | Bug-alive post-fix (string→BigInt en el sink) | OK | Sin `Number` intermedio en ningún sink |
| 9 | Destructive Migrations | N/A | Sin migración (CD-3, 100% capa lectura) |
| 10 | RPC SECURITY DEFINER | N/A | No se agregó/modificó ninguna RPC |
| 11 | Cache Invalidation | N/A | Sin capa de cache nueva |

---

## BLQ-BAJO-1 — Type Safety: el test nuevo rompe `tsc --noEmit` (whole-project)

- **Categoría**: Type Safety
- **Archivo:línea**: `src/adapters/escrow/debit-capture.test.ts:561`
- **Descripción**: El builder-double define `select: vi.fn(() => builder)` (firma SIN argumentos, `stubReaderRow` L407). Por eso `builder.select.mock.calls` se tipa como `[][]` (tupla vacía). El nuevo T-NEW-1 hace:
  ```ts
  const selectArg = builder.select.mock.calls[0]?.[0] as string;
  ```
  Esto dispara dos errores de compilación:
  - `TS2493`: Tuple type `[]` of length 0 has no element at index 0 (`?.[0]`).
  - `TS2352`: Conversion of type `undefined` to type `string` may be a mistake (`as string`).
- **Reproducción**:
  ```
  npx tsc --noEmit
  → TypeScript: 2 errors in 1 files
    src/adapters/escrow/debit-capture.test.ts L561 (TS2352, TS2493)
  ```
  Antes de este commit el repo era tsc-clean sobre TODOS los test files (solo aparece 1 archivo con errores, el modificado por este fix). `npm run build` (usa `tsconfig.build.json`, que excluye `*.test.ts`) da exit 0, y `vitest run` da 102/102 PASS — por eso el pipeline definido (build/test/lint-biome) NO caza estos errores.
- **Impacto**: Rompe `tsc` de proyecto completo (el comando estándar de typecheck y lo que ve un IDE), que estaba limpio. Viola DT-5 del propio SDD ("Verificación obligatoria: `npm run build`/`tsc` limpio antes de F3-done") y el Golden Path "TypeScript strict". Sin impacto en runtime ni en money-path ni en el build de prod → severidad BAJA. Bloquea el gate solo para forzar la corrección de una línea y preservar el invariante tsc-clean del repo.
- **Sugerencia** (NO implementar aquí): tipar el arg del mock del select para que `mock.calls[0]?.[0]` sea `string | undefined`, p.ej. `select: vi.fn((_cols?: string) => builder)`, y ajustar el cast a `as string | undefined` (o guard). Alternativa: `(builder.select.mock.calls[0]?.[0] ?? '') as string`. Re-correr `npx tsc --noEmit` hasta 0 errores.

---

## Evidencia de las categorías OK (relevante)

- **Completitud (OK)**: `grep .from(...)` sobre las 2 tablas críticas → únicos sitios: `debit-capture.ts:115`, `reconciliation.ts:183/221/348/405`, `arbiter.ts:107`. Los 3 selects de reconciliation + reader + arbiter tienen `::text`; `reconciliation.ts:348` es un UPDATE con `.eq('debit_nonce', nonce)` (nonce = string exacto de un select ya-fixeado, filtro WHERE, sin precision-loss). No hay `.select('*')` sobre ninguna de las 2 tablas. `payment-intent.ts:539-541` (`BigInt(row.debit_amount_atomic)`/`BigInt(row.debit_nonce)`) consume el row de `readValidDebitSignature` (reader fixeado), no un select propio.
- **Cast sin alias (OK)**: los 5 selects castean preservando la key (`debit_nonce::text`, `debit_amount_atomic::text`, `nonce::text`) — sin prefijo `alias:`. `row.debit_nonce` / `existing.nonce` siguen mapeando. CD-7 respetado.
- **CD-6 (OK)**: `driftCheck` (`reconciliation.ts:407`) castea SOLO `debit_amount_atomic::text`, NO trae `debit_nonce` → no lo castea (evita error PostgREST de columna inexistente). `debit_deadline` (BIGINT) NO casteado en el reader (`debit-capture.ts:117`). Ambos verificados por T-NEW-8 y T-NEW-1.
- **Ownership Guard (OK)**: el diff solo cambia el string-literal del `.select()`; ninguna cadena `.eq('owner_ref', ...)` fue tocada (arbiter read-first mantiene `.eq('owner_ref', ownerRef)` en `arbiter.ts:110`).
- **Bug-alive (OK)**: todos los sinks hacen `BigInt(string)` directo — `payment-intent.ts:539/541`, `reconciliation.ts:200/250/431`, `arbiter.ts:121` (`BigInt(String(existing.nonce))`). No hay `Number()` / `JSON.parse` intermedio entre el select y el `writeContract`.
- **Test quality (OK)**: la capa cast-presence captura el arg real del `.select()` y falla si se quita `::text` (regresión AC-6 real). El round-trip ejercita `BigInt()` sobre el valor del incidente `4312989337224638380` y compara contra `4312989337224638380n`. Limitación (el mock provee el row ya-string, no reproduce la corrupción de PostgREST) documentada honestamente en SDD §7; la guarda real es cast-presence. No tautológico.

---

## Acción para el Dev (fix-pack)

1. **BLQ-BAJO-1** — corregir el tipado del mock del select en `debit-capture.test.ts:407/561` para que `npx tsc --noEmit` vuelva a 0 errores. One-line.

Tras el fix: re-correr `npx tsc --noEmit` (0 errores) + `vitest run` (mantener 102/102).
