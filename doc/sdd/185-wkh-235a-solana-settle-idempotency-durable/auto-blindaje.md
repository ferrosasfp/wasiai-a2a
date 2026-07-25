# Auto-Blindaje — 185 / WKH-235a (scope reducido: recuperación de firma tras timeout)

### [2026-07-25 09:20] Wave 0 — `bs58` no es dependencia declarada
- **Error**: primer impulso fue `import bs58 from 'bs58'` para encodear el Buffer de `Transaction.signature` a base58 (existe en `node_modules` como transitiva de `@solana/web3.js`).
- **Causa raíz**: asumir que un paquete presente en `node_modules` es usable. `package.json` NO lo declara, y `src/adapters/solana/chain.ts:85` ya documenta la decisión opuesta ("PURO — no depende de `bs58`") con un decoder base58 propio.
- **Fix**: encoder base58 puro y local en `payment.ts` (espejo del decoder de `chain.ts`), verificado por el test T-235a-AC1b (64 bytes cero ⇒ `'1'.repeat(64)`, incluido el manejo de ceros líderes). Cero dependencias nuevas.
- **Aplicar en**: cualquier import nuevo — chequear `package.json` (`dependencies`), no `node_modules`. Y buscar si el repo ya resolvió el mismo problema sin dependencia.

### [2026-07-25 09:26] Wave 1 — formato biome roto en el test nuevo
- **Error**: `npm run lint` falló (exit 1) por una línea del test que excedía el ancho del formatter (`mockRejectedValueOnce(new Error('blockhash fetch failed'));`).
- **Causa raíz**: escribir el test sin pasar el formatter antes del gate.
- **Fix**: `./node_modules/.bin/biome format --write` sobre el archivo → `biome check src/` exit 0.
- **Aplicar en**: correr `biome format --write` sobre los archivos tocados ANTES del gate de lint. Nota operativa: `npx biome ...` NO resuelve el binario en este entorno (el proxy de npm devuelve "could not determine executable to run") — usar `./node_modules/.bin/biome` o `npm run lint`.

### [2026-07-25 09:15] Wave 0 — riesgo evitado: partir `sendAndConfirmTransaction` en send+confirm
- **Error potencial (no cometido)**: para conocer la firma antes del envío, la ruta obvia era reemplazar `sendAndConfirmTransaction` por `getLatestBlockhash` + `tx.sign()` + `sendRawTransaction` + `confirmTransaction`.
- **Causa raíz**: no verificar primero qué expone la librería. `@solana/web3.js` YA da la firma en el camino de fallo: `TransactionExpiredTimeoutError` / `TransactionExpiredBlockheightExceededError` / `TransactionExpiredNonceInvalidError` tienen un campo público `signature: string` (`node_modules/@solana/web3.js/lib/index.d.ts:290-301`), y `sendAndConfirmTransaction` firma el MISMO objeto `Transaction` in-place → `tx.signature` (`index.d.ts:1600`) sobrevive al throw.
- **Fix**: `try/catch` alrededor de la llamada existente, recuperación en el `catch`. El camino feliz queda byte-idéntico (misma llamada, mismos args) y los tests existentes (que mockean sólo `sendAndConfirmTransaction`) no necesitaron ningún mock nuevo.
- **Aplicar en**: antes de rediseñar un flujo de una lib de terceros, leer sus `.d.ts` — el dato que "falta" suele estar en el error o en el objeto mutado.
