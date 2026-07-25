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

### [2026-07-25 09:45] Fix-pack AR — la fixture del test enmascaró un guard faltante
- **Error**: el test T-235a-AC1b usó `Buffer.alloc(64)` (64 bytes en CERO) como firma de la tx firmada in-place, y verificó `txHash === '1'.repeat(64)`. O sea: el test **codificó como esperado** que una pseudo-firma sin valor on-chain se acepte como txHash y se guarde en `_intentSignatures` (→ `settle_signature` del ledger). El AR lo marcó MENOR (MNR-3).
- **Causa raíz**: elegir la fixture por comodidad (`alloc` = ceros) en vez de por realismo. Una firma real NUNCA es todo-ceros; el todo-ceros es justamente el placeholder pre-firma de web3.js. La fixture cómoda pasó a ser el contrato del test.
- **Fix**: guard en `candidateSignatureFromFailure` (`raw.some((b) => b !== 0)`) → todo-ceros = "sin firma derivable" (mismo camino que `tx.signature === null`). T-235a-AC1b pasa a usar 63 ceros + `0x01` (base58 `'1'×63 + '2'`) y se agrega T-235a-AC1b0 que fija el rechazo del todo-ceros (cero lecturas RPC + propaga el error original).
- **Aplicar en**: cualquier fixture de material criptográfico (firmas, keys, hashes) — usar valores no-triviales; si el valor trivial es un sentinel/placeholder de la librería, el test debe afirmar que se RECHAZA, no que se acepta.

### [2026-07-25 09:50] Fix-pack AR — propiedad de seguridad sin test que la fije
- **Error**: nada en la suite fijaba "tx confirmada pero FALLIDA (`meta.err`) no se recupera". El comportamiento era correcto, pero dependía **sólo** del guard `if (!parsed?.meta || parsed.meta.err)` de `verify()`: un refactor que reordenara ese guard (p. ej. chequear el delta de balances primero) habría convertido un settle fallido en exitoso **con la suite verde**. Y es el modo de fallo más probable en devnet tras un timeout, porque `SendTransactionError` de web3.js SÍ trae `signature` en runtime (`node_modules/@solana/web3.js/lib/index.cjs.js:2300-2306`, aunque el `.d.ts` lo marque `private`) ⇒ el error entra al recovery con candidato válido.
- **Causa raíz**: al reusar `verify()` se asumió que "ya está testeado" sin comprobar que existiera un test del **camino compuesto** (settle → catch → recovery → verify → rechazo). Los tests de `verify()` aislado no cubren la composición.
- **Fix**: T-235a-AC2e — el error de send trae `signature`, y la tx on-chain tiene `meta.err` no nulo PERO delta de balances SUFICIENTE (así el rechazo sólo puede venir del `meta.err`, no de la validación de monto). Asserta `rejects` + 1 lectura RPC + 1 solo transfer.
- **Aplicar en**: cuando un fix nuevo hace *load-bearing* a un guard viejo, escribir el test **desde el caller nuevo**, con las demás validaciones deliberadamente satisfechas para aislar el guard bajo prueba.

### [2026-07-25 10:05] Fix-pack CR — codec duplicado en 2 archivos con el alfabeto copiado
- **Error**: el fix original agregó `base58Encode` + una **segunda copia** del `BASE58_ALPHABET` en `payment.ts`, cuando `chain.ts` ya tenía el alfabeto + `base58DecodeToBytes`. Dos mitades del mismo codec (encoder / decoder) en archivos distintos, con la constante duplicada: si alguien tocara un alfabeto, el roundtrip se rompería en silencio (encode y decode dejarían de ser inversos).
- **Causa raíz**: al escribir el encoder se lo pensó como "espejo del decoder" (y hasta se documentó así en el comentario) sin dar el paso siguiente obvio: si es el espejo, va en el MISMO módulo.
- **Fix**: `src/adapters/solana/base58.ts` con `BASE58_ALPHABET` + `base58Encode` + `base58DecodeToBytes`; `chain.ts` y `payment.ts` importan de ahí (move puro, cero cambios de lógica, comentarios de la decisión "no usar `bs58`" conservados). Suite existente verde sin tocar ningún test.
- **Aplicar en**: cuando escribís la mitad inversa de una función existente (encode/decode, serialize/parse, sign/verify), primero unificá en un módulo propio; una constante compartida (alfabeto, tabla, magic number) duplicada es señal de que el módulo faltaba.

### [2026-07-25 10:10] Fix-pack CR — función load-bearing del path de dinero con 1 solo vector
- **Error**: `base58Encode` produce el `txHash` del settle recuperado (→ `settle_signature` del ledger) y la suite lo ejercitaba con **un único** vector, indirecto (a través de `settle()`), sin roundtrip ni test directo. El fuzz de 3000 casos del AR fue evidencia de **sesión**, no regresión permanente: un refactor del codec podía pasar la suite verde.
- **Causa raíz**: confundir "está cubierto por un test que lo atraviesa" con "está fijado". El test de `settle()` cubre el *cableado*, no las propiedades del codec (ceros líderes, bytes altos, longitudes).
- **Fix**: `src/adapters/solana/base58.test.ts` — roundtrip `decode(encode(bytes)) === bytes` sobre 19 vectores fijos + 256 buffers pseudo-aleatorios **deterministas** (LCG sembrado con constante, NUNCA `Math.random()`: un test que falla 1 de cada N corridas no es evidencia, es ruido) + el vector conocido `0x0000287fb4cd → '11233QC4'` + un test que fija el bound `bytes.length - 1` del loop de ceros líderes (con su comentario en el código, para que nadie lo "simplifique").
- **Aplicar en**: toda función pura que produzca o consuma un identificador que termina persistido en el ledger (firmas, hashes, IDs): test **directo** + property test determinista, no sólo cobertura indirecta vía el caller.
