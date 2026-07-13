# Auto-Blindaje — WKH-191b (escrow settle rewire, two-hop)

Registro de errores cometidos y corregidos durante F3. Protege futuras HUs del
mismo error.

### [2026-07-13 08:04] Wave 1 — `npx biome` no resuelve el ejecutable
- **Error**: `npx biome check --write ...` devolvía `npm error could not determine executable to run` (el hook rtk/npx mangleaba la salida y no encontraba el bin).
- **Causa raíz**: en este entorno `biome` no está expuesto como ejecutable vía `npx`; el script del proyecto lo invoca como `biome ...` (resuelto por el PATH de npm-scripts), no vía npx directo.
- **Fix**: invocar el binario local directamente: `./node_modules/.bin/biome check --write <files>`.
- **Aplicar en**: cualquier gate de wave que corra biome — usar `./node_modules/.bin/biome`, no `npx biome`.

### [2026-07-13 08:13] Wave 3 — mocks de vitest tipados a 0 args rompen tsc
- **Error**: `tsc --noEmit` fallaba con `TS2556 (spread argument must have tuple type)` y `TS2554 (Expected 0 arguments, but got 1)` en los wrappers `vi.mock(...)` que delegan a mocks hoisted (`readValidDebitSignature`, `executeDebitHop1`, `recordDebitHop1`, `recordDebitSettleStatus`).
- **Causa raíz**: `vi.hoisted(() => vi.fn())` sin implementación infiere la firma `() => void` (0 args). Al envolverlo con `(...a: unknown[]) => mock(...a)` o `(args) => mock(args)` TS ve una llamada con 1 arg contra una firma de 0 args.
- **Fix**: (a) darle a cada `vi.fn` una implementación con parámetro explícito: `vi.fn((_args: unknown) => ...)`; (b) reemplazar los wrappers `(...a: unknown[]) => mock(...a)` por `(args: unknown) => mock(args)` (las funciones reales toman un único objeto).
- **Aplicar en**: todo mock de vitest de funciones que reciben args cuando el proyecto corre `tsc` sobre los tests — tipar el `vi.fn` con params, no dejar la firma inferida vacía.

### [2026-07-13 08:13] Wave 3 — `mockReturnValue(null)` sobre un `vi.fn` de retorno `string`
- **Error**: `TS2345 Argument of type 'null' is not assignable to parameter of type 'string'` en el test T-6 al hacer `mockResolveEscrowContract.mockReturnValue(null)`.
- **Causa raíz**: el mock existente estaba definido como `vi.fn(() => '0x…')`, cuyo retorno se infiere `string`; el reader/seam sin embargo puede devolver `null` (chain sin escrow).
- **Fix**: anotar el retorno del mock: `vi.fn((): string | null => '0x…')`.
- **Aplicar en**: mocks de resolvers que en producción devuelven `T | null` — tipar el retorno del `vi.fn` con la unión, no dejar que TS lo estreche a `T`.

### [2026-07-13 fix-pack] CR MNR-1 — test placeholder tautológico + cross-ref inexacta
- **Error**: `debit-capture.test.ts:543` tenía `it('record_debit_hop1 es idempotente…', () => { expect(true).toBe(true); })` — no asserta nada sobre el código (tautológico) y su comentario referenciaba un test de `recordDebitHop1` en `debit-executor.test.ts` que NO existía (`grep` sin coincidencias). Daba falsa cobertura.
- **Causa raíz**: se documentó la idempotencia COALESCE (semántica SQL, no simulable sin Postgres) con un placeholder verde en vez de dejarla como integración pendiente; y se apuntó a un test del wrapper que nunca se escribió.
- **Fix**: (a) test REAL del wrapper `recordDebitHop1` en `debit-executor.test.ts` (mockeando `supabase.rpc`): verifica args exactos al RPC `record_debit_hop1` con `p_nonce` como **string** (CD-S1) + propagación del `persisted_tx_hash` efectivo (COALESCE) + `data null → null`; (b) eliminado el `expect(true).toBe(true)`; (c) comentario honesto: idempotencia COALESCE = integración SQL (verificada en la migración, igual que T-10 ownership), wrapper con test vivo en `debit-executor.test.ts`.
- **Verificado no-tautológico**: mutación temporal (wrapper sin `supabase.rpc`) → el test FALLA en `toHaveBeenCalledWith`; revertida.
- **Aplicar en**: nunca cerrar un caso con `expect(true).toBe(true)` haciéndose pasar por cobertura. Si algo es integración SQL/manual, documentarlo como pendiente explícito (como T-10), NO simularlo tautológicamente. Y toda cross-reference a otro test debe verificarse con `grep` antes de commitear.
