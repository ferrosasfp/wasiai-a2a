# Auto-Blindaje — M9: Cliente Supabase tipado con `Database`

Contexto: auditoría 2026-06-24, item M9. Tipar `createClient<Database>(...)` con el
schema real de prod (`src/types/database.types.ts`) para eliminar/justificar los
`data as DomainType` ciegos sobre filas de Supabase.

### [2026-06-24 23:50] M9 — Spread que omite arg opcional cambió el payload del RPC (3 tests rojos)
- **Error**: al tipar el cliente, los args opcionales de RPC (`p_token`,
  `p_destination`) se generaron como `string` (no `string | null`). Para satisfacer
  el tipo cambié `p_token: token ?? null` → `...(token ? { p_token: token } : {})`
  (omitir la key cuando no hay valor). Eso rompió 3 tests:
  `budget.test.ts` (AC-10 "passes p_token: null when token omitted"),
  `delegation.test.ts` y `key-session.test.ts` (RPC success), que assertean
  `toHaveBeenCalledWith(..., { ..., p_token: null })` / `p_destination: null`.
- **Causa raíz**: el contrato verificado por los tests NO es solo el efecto en DB
  (NULL vía `DEFAULT NULL`), sino el PAYLOAD EXACTO enviado al RPC (`p_token: null`
  presente). Omitir la key cambia el payload aunque el resultado en DB sea idéntico.
  Asumí equivalencia "omitir == null" sin leer la aserción del test.
- **Fix**: revertir a `p_token: token ?? null` / `p_destination: destination ?? null`
  y, en vez de tocar el payload, narrowear SOLO el TIPO del objeto de args al
  `Database['public']['Functions'][<rpc>]['Args']` vía `as unknown as ...`. El tipo
  generado es incompleto (no captura nullability del arg, confirmado contra la SQL
  fn `p_token TEXT DEFAULT NULL`); el cast acotado y documentado reconcilia el tipo
  sin alterar qué se envía.
- **Aplicar en**: cualquier futura tipificación de `supabase.rpc(...)`. NUNCA cambiar
  el payload (omitir/renombrar args) para satisfacer el typechecker si hay tests que
  assertean `toHaveBeenCalledWith`. Narrowear el TIPO del objeto de args, no su forma.

### [2026-06-25 03:50] M9 — Biome formatter error en el tipo generado
- **Error**: `biome check src` reportó 1 error (formatter) sobre
  `src/types/database.types.ts`: el generador de Supabase emite double-quotes y sin
  semicolons, que biome quiere reformatear.
- **Causa raíz**: archivo generado por herramienta externa (supabase gen types) no
  pasa por el formatter del repo al crearse.
- **Fix**: `biome check --write src/types/database.types.ts` (solo formato; no cambia
  los tipos — tsc sigue en 0 errores tras el reformat).
- **Aplicar en**: cualquier archivo generado que se commitee (types, snapshots).
  Pasarlo por `biome check --write` antes de commitear para que no rompa el gate.

## Hallazgo colateral (NO corregido — fuera de scope M9)
- **`tasks` no tiene columna `owner_ref` en el schema de prod**: el tipo generado lo
  confirma y `test/verify-rls-enabled.test.ts` lo afirma ("a2a_tasks NO tiene
  owner_ref"). El service `task.ts` (WKH-54) filtra/inserta por `owner_ref` igual.
  El cliente tipado rechazaba esos `.eq('owner_ref', ...)`. Para NO cambiar la lógica
  ni el payload (constraint M9), se aisló la columna off-schema en un literal
  documentado (`OWNER_REF_COL`) + narrowing acotado en insert/update. La discrepancia
  estructural (columna ausente vs código que la usa) queda registrada para una HU
  futura; NO se tocó la migración ni el comportamiento.
