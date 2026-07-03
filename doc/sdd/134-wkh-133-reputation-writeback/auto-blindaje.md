# Auto-Blindaje — WKH-133 Reputation write-back on-chain

Registro de errores cometidos durante F3 y su corrección, para blindar HUs futuras.

### [2026-07-03] W1 — `walletClient.account` es `Account | undefined` en el tipo genérico
- **Error**: `tsc` falló con TS2322 al pasar `account: walletClient.account` a `writeContract`: el tipo del client devuelto por `ReturnType<typeof createWalletClient>` (sin genéricos explícitos) incluye `undefined` en `.account`, pero `writeContract` exige `` `0x${string}` | Account | null ``.
- **Causa raíz**: `createWalletClient` sin type args no propaga que `account` fue provisto → el union incluye `undefined`. En runtime el client SIEMPRE se construye con `account` (getWriterWalletClient), pero el tipo no lo sabe.
- **Fix**: `account: walletClient.account ?? null` (coalesce a `null`, que es un valor válido del param). En runtime real nunca es `undefined`; en los tests el mock de `createWalletClient` no expone `.account` y `null` es inocuo.
- **Aplicar en**: cualquier módulo que cachee un `WalletClient` vía `ReturnType<typeof createWalletClient>` y pase `.account` a `writeContract`/`sendTransaction`. Preferir `?? null` sobre non-null assertion (prohibido por biome — CD-11).

### [2026-07-03] W3 — La API `.insert().onConflict()` del snippet del Story File NO existe en supabase-js v2
- **Error potencial**: el pseudo-código del Story File (§W3, `[VERIFY-AT-IMPL]`) mostraba `.insert({...}).onConflict('event_id').select()`. `onConflict` NO es un método del query builder de `@supabase/postgrest-js` (v2.101.1 en el repo).
- **Causa raíz**: en supabase-js v2 el `ON CONFLICT DO NOTHING` se expresa vía `upsert(values, { onConflict, ignoreDuplicates })`, no como método encadenado sobre `insert`.
- **Fix (resolución del VERIFY-AT-IMPL)**: se usó `.upsert(claimRow, { onConflict: 'event_id', ignoreDuplicates: true }).select()`. Verificado contra `node_modules/@supabase/postgrest-js/dist/index.d.mts:2752-2766` (firma real) y el uso existente `spend-policy.ts:136`. Semántica confirmada: `ignoreDuplicates:true` → `Prefer: resolution=ignore-duplicates` → `INSERT ... ON CONFLICT DO NOTHING`; con `.select()` las filas devueltas son SOLO las insertadas (las ignoradas por conflicto devuelven 0 filas). Por lo tanto `claimed.length === 0` ⇒ evento ya reclamado ⇒ return sin tx (barrera anti-doble-gasto CD-2).
- **Aplicar en**: cualquier claim idempotente futuro. Nunca asumir `.onConflict()` encadenado; usar `upsert(..., { onConflict, ignoreDuplicates })`.

### [2026-07-03] W1/W3 — `waitForTransactionReceipt` en timeout THROWS, no retorna
- **Error potencial**: asumir que el timeout del receipt se refleja en `receipt.status`. En viem v2, al superar `timeout` la función lanza `WaitForTransactionReceiptTimeoutError` (no retorna un receipt).
- **Causa raíz**: la API distingue timeout de espera (throw) vs revert on-chain (receipt.status='reverted').
- **Fix**: `try { receipt = await waitForTransactionReceipt(...) } catch (err) { if (err instanceof WaitForTransactionReceiptTimeoutError) return RECEIPT_TIMEOUT; return classifyWriteError(err); }` y `if (receipt.status !== 'success') return REVERTED`. Verificado en `node_modules/viem/_types/actions/public/waitForTransactionReceipt.d.ts` (param `timeout?: number`, receipt `status: 'success' | 'reverted'`).
- **Aplicar en**: todo await de `waitForTransactionReceipt`: envolver en try/catch y separar timeout (throw) de revert (status).
