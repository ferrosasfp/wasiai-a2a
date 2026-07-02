# Auto-Blindaje — Audit 2026-07-01 fix-pack (H1 dual-ledger step-0 + NITs)

### [2026-07-01] H1 — `exactOptionalPropertyTypes` rechaza `p_destination: x ?? undefined`
- **Error**: el CR NIT-1 pedía reemplazar el doble-cast `as unknown as ...Args` por
  `p_destination: destination ?? undefined`. Eso NO compila: `tsconfig` tiene
  `exactOptionalPropertyTypes: true`, y `p_destination?: string` (sin `| undefined`)
  no admite asignar `undefined` explícito → TS2375 en budget.ts:505 y :557.
- **Causa raíz**: bajo `exactOptionalPropertyTypes`, una propiedad opcional NO es lo
  mismo que una propiedad `| undefined`. Setearla a `undefined` es distinto de omitirla.
- **Fix**: conditional spread `...(destination !== undefined && { p_destination: destination })`.
  Omite la key cuando no hay destino → aplica el `DEFAULT NULL` del SQL (equivalente
  al viejo `null`), sin cast alguno.
- **Aplicar en**: cualquier arg de RPC Supabase con campo opcional `p_x?: T` donde se
  quiera "sin valor / NULL por default". Usar spread condicional, nunca `?? undefined`
  ni `?? null` (este último requiere el cast que justamente queremos eliminar).

### [2026-07-01] H1 — cambiar `null` explícito a key-omitida rompe asserts de tests
- **Error**: al aplicar NIT-1, el test `creditDelegation passes p_destination:null when
  no destination` falló: esperaba el objeto RPC con `p_destination: null`, pero ahora la
  key se omite.
- **Causa raíz**: el test acoplaba la aserción a la forma interna del payload (`null`
  explícito) en vez de al comportamiento observable (destino ausente ⇒ NULL por default).
- **Fix**: actualizar la aserción para NO incluir `p_destination` (omitido) + comentario
  explicando la equivalencia con el `DEFAULT NULL` del SQL.
- **Aplicar en**: al cambiar la representación "sin valor" de un arg de RPC (null↔omitido),
  grepear los tests que asserten `toHaveBeenCalledWith(...{ p_x: null })` y ajustarlos.
