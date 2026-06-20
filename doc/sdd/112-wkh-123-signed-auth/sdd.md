# SDD — [WKH-123] KEY-SIGNED-AUTH: Auth por firma (EIP-712 master + HMAC-SHA256 session)

> F2 — Architect. Input: `work-item.md` (11 ACs, 7 DTs, 7 CDs, 3 missing inputs).
> Modo: QUALITY. Estimación: L. Branch: `feat/112-wkh-123-signed-auth`.
> Stack verificado contra `project-context.md` y código real (no se asume nada).

---

## 1. Context Map — archivos leídos y patrón extraído

| Archivo | Líneas leídas | Por qué | Patrón extraído |
|---------|---------------|---------|-----------------|
| `src/middleware/a2a-key.ts` | 1-761 (completo) | Punto de inserción del check de firma | 3 branches: **WKH-101** `wasi_a2a_session_` (líneas 263-461), **WKH-121 sess** `wasi_a2a_sess_` (467-630), **master** (632-757). El lookup del token ocurre en cada branch ANTES del debit (sess: 470-471; master: 636-639). El check de firma se inserta DESPUÉS del lookup+is_active y ANTES del `resolveTargetChain`/debit. |
| `src/services/delegation.ts` | 1-468 (completo) | Patrón EIP-712 con viem | `import { recoverTypedDataAddress } from 'viem'` (línea 18). `buildDomain()` lee env con default (50-56). `DELEGATION_TYPES = {...} as const` sin `EIP712Domain` en `types` (64-78). Recover dentro de try/catch → throw error class (141-173). Domain binding ANTES de recover. |
| `src/services/key-session.ts` | 1-414 (completo) | Extender `create` + agregar `setRequireSignature` | `create` valida → genera token `wasi_a2a_sess_<48 random bytes hex>` → `tokenHash = sha256` → INSERT solo el hash (181-208). `revoke` = patrón UPDATE `.eq('id').eq('owner_ref').select('id')` → 0 rows → `logOwnershipMismatch` + throw (330-350). |
| `src/services/identity.ts` | 1-352 (completo) | Agregar `setRequireSignature` master | `deactivate` (109-124) es el patrón canónico: UPDATE `.eq('id', keyId).eq('owner_ref', ownerId).select('id')` → 0 rows → `logOwnershipMismatch('deactivate', keyId, ownerId)` + `OwnershipMismatchError`. `lookupByHash` (89-103) PGRST116 → null. |
| `src/types/a2a-key.ts` | 1-333 (completo) | Agregar campos a rows + nuevas interfaces | `A2AAgentKeyRow` (34-68), `KeySessionRow` (269-284), `CreateKeySessionInput` (287-293), `KeySessionResponse` (296-306). Patrón EIP-712 types (157-186). `SessionKeyErrorCode` union (247-259). |
| `src/routes/auth.ts` | 1-1239 (completo) | Endpoints PATCH + extender POST /key-session | Gate sub-sesión: `rawKeyFromRequest` + `.startsWith(PREFIX)` ANTES de `resolveCallerKey` (1115-1121, 1188-1195). `resolveCallerKey` (112-141). `parseCreateKeySessionInput` (279-327). Map de error class → status en catch (1138-1154). DELETE `/key-session/:id` (1182-1221) = patrón ownership endpoint. |
| `src/services/security/errors.ts` | 1-410 | Agregar error classes + reusar logger | Patrón error class: `readonly code = '...' as const; this.name = '...'`. `logOwnershipMismatch` tiene overload posicional `(op:'getBalance'\|'deactivate', keyId, ownerId)` y de objeto `({op, resourceId, callerOwnerRef})` (356-380). `OwnershipOp` union (335-345). |
| `supabase/migrations/20260603000000_a2a_key_sessions.sql` | 1-97 (completo) | Patrón ALTER + nueva tabla + hardening RPC | Tabla con `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Bloque hardening RPC: `SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` (90-96). |
| `.env.example` | 143-160 | Patrón de env vars del domain | `DELEGATION_EIP712_NAME=WasiAI-a2a Delegation`, `DELEGATION_EIP712_VERSION=1`, `KITE_CHAIN_ID=` (sin default), `SESSION_MAX_TTL_SECONDS=86400` con fail-safe documentado. |
| `src/services/key-session.test.ts` | 1-55 | Patrón de mocks de tests | `vi.mock('../lib/supabase.js')` con `{ from: vi.fn(), rpc: vi.fn() }`; `vi.mock('../adapters/registry.js')`; `makeParentKey(overrides)` fixture. |
| `doc/sdd/110-wkh-121-key-sessions/auto-blindaje.md` | completo | Lecciones de la HU previa | Aridad estricta de `toHaveBeenCalledWith` al sumar args posicionales (→ CD-13). |
| `doc/sdd/104-tech-debt-closure/auto-blindaje.md` | completo | Lecciones HU previa | `process.env.X = undefined` NO borra (usar `delete`); `mockResolvedValueOnce` no consumido contamina suite; `describe.skipIf` evalúa el cuerpo (→ CD-14). |

**Drift detectado**: ninguno. El stack del código coincide con `project-context.md` (viem ^2.47, Fastify ^5.8, Vitest ^4.1, Supabase service-role bypass RLS).

---

## 2. Decisiones técnicas (DT-N)

Las DT-1..DT-7 vienen del work-item. Acá quedan **resueltas con rigor** donde estaban abiertas (DT-4, DT-7, canonical body, endpoint de activación).

### DT-1 (heredada) — Dos esquemas: EIP-712 (master) + HMAC-SHA256 (session)
Master keys anclan en `funding_wallet` (EOA) → EIP-712 vía `recoverTypedDataAddress` (mismo stack que WKH-101, `delegation.ts:18,148`). Session keys nacieron sin wallet (WKH-121) → HMAC-SHA256 con `signing_secret` server-generated. Sin cambios al ancla de cada esquema.

### DT-2 (heredada) — Domain EIP-712 distinto del de delegaciones
Nuevo domain `WasiAI-a2a Request` (vs `WasiAI-a2a Delegation` de WKH-101). Env vars **nuevas y distintas**: `REQUEST_EIP712_NAME` (default `WasiAI-a2a Request`), `REQUEST_EIP712_VERSION` (default `1`), `chainId: Number(process.env.KITE_CHAIN_ID)` (reusa la var existente, igual que `delegation.ts:54`). `buildRequestDomain()` replica el patrón de `delegation.ts:50-56` con las vars nuevas. **Domain binding** obligatorio (no se valida domain del cliente porque el server CONSTRUYE el typed-data desde headers + lookup, ver DT-3).

### DT-3 (RESUELTO) — Canonical EIP-712 message del request
A diferencia de WKH-101 (donde el cliente manda el `typed_data` completo), en WKH-123 el server **reconstruye** el typed-data desde datos que ya posee (`token_hash` del lookup) + headers (`nonce`, `timestamp`) + request (`method`, `path`). El caller solo manda la **firma**. Esto elimina la superficie de un `typed_data` malicioso.

**EIP-712 types (canónico, server-side, `as const`):**
```
const REQUEST_TYPES = {
  Request: [
    { name: 'token_hash', type: 'bytes32' },
    { name: 'method',     type: 'string'  },
    { name: 'path',       type: 'string'  },
    { name: 'nonce',      type: 'bytes32' },
    { name: 'timestamp',  type: 'uint64'  },
  ],
} as const;
```

**Canonicalización exacta (vinculante para el Dev):**
- `token_hash`: `0x` + `crypto.createHash('sha256').update(rawKey).digest('hex')` → 32 bytes → válido `bytes32`. **YA conocido por el server** post-lookup (master: `keyHash` línea 636; sess: `hash` línea 470). El server lo pasa como `0x${hash}` (lowercase).
- `method`: `request.method.toUpperCase()` (ej. `"POST"`). El caller debe firmar el método HTTP en mayúsculas.
- `path`: `request.url` **sin query string** — se toma `request.url.split('?')[0]` (ej. `"/api/v1/compose"`). Documentar que el caller firma el path sin querystring.
- `nonce`: header `x-a2a-nonce`, debe matchear `/^0x[0-9a-fA-F]{64}$/` (bytes32). Si no matchea → `SIGNATURE_INVALID`.
- `timestamp`: header `x-a2a-timestamp`, epoch **seconds** entero → se pasa como `BigInt(timestamp)` (igual que `delegation.ts:161` convierte `uint64` a bigint).

**El body HTTP NO se firma** en el MVP (decisión de F2 sobre el missing input #2): el work-item exige MÍNIMO `method+path+nonce+timestamp`; firmar el body agrega complejidad de canonicalización JSON (orden de claves, encoding) y un riesgo de divergencia caller/server alto, sin valor anti-filtrado adicional (el `token_hash`+`nonce` ya atan la firma al token y la hacen de un solo uso). Firmar el body queda como TD futuro si se requiere integridad de payload. **[CD-8]**

### DT-4 (RESUELTO) — Anti-replay con tabla Supabase `a2a_signed_auth_nonces`
**Decisión: tabla Supabase, NO Redis.** Justificación:
1. El stack ya usa Supabase service-role para todo el hot-path de auth (`identity.lookupByHash`, `key-session.lookupByTokenHash`); agregar una segunda dependencia (Redis) en el hot-path de auth introduce un punto de fallo nuevo y latencia de red adicional.
2. El nonce debe cruzarse con `token_hash` (no es un nonce global) y persistir con TTL exacto. Un `INSERT ... ON CONFLICT DO NOTHING` sobre `UNIQUE(token_hash, nonce)` da la garantía de atomicidad anti-replay en **una sola query** (igual idea que el `UNIQUE(key_id, nonce)` 23505 de `delegation.ts:240-243`): si el INSERT afecta 0 rows (conflicto) → replay.
3. Fail-open de Redis sería inaceptable (un Redis down NO debe permitir replays); con tabla, si Supabase está down el auth entero falla 503 (consistente con el resto del middleware).
4. La limpieza de filas expiradas es por `expires_at` con un índice; no requiere job en el MVP (el `UNIQUE` previene replay aunque la fila vieja siga; un cron de limpieza es housekeeping, no correctness). **[CD-3]**

Patrón exacto del check (`signedAuthService.checkAndRecordNonce`):
```
INSERT INTO a2a_signed_auth_nonces (token_hash, nonce, expires_at)
VALUES ($token_hash, $nonce, now() + ttl)
-- supabase: .insert(row) → si error.code === '23505' → NONCE_REPLAY
```
Se usa el `UNIQUE(token_hash, nonce)` → `23505` ⇒ `NonceReplayError`. **El INSERT del nonce ocurre DESPUÉS de validar firma+timestamp y ANTES de retornar éxito** (CD-3). Orden: validar timestamp → validar firma → record nonce (replay check) → success.

### DT-5 (heredada) — Detección del modo firmado en el middleware
El middleware lee `require_signature` del row ya cargado por el lookup. Tabla de decisión por branch (master y sess):
| `require_signature` | headers de firma | Acción |
|---------------------|------------------|--------|
| `false` / `null` | cualquiera | flujo bearer INTACTO (back-compat, CD-1). Headers ignorados. |
| `true` | falta `x-a2a-signature` | `401 SIGNATURE_REQUIRED` |
| `true` (master) | `funding_wallet === null` | `403 FUNDING_WALLET_NOT_BOUND` (AC-9) |
| `true` | presentes | rama de verificación (timestamp → firma → nonce) |

El check se inserta: **master** entre la validación `is_active` (línea 647) y `resolveTargetChain` (línea 682); **sess** entre `is_active` del parent (498-503) y `resolveTargetChain` (506). El branch WKH-101 (`wasi_a2a_session_`, 263-461) **NO se toca** (CD-2).

### DT-6 (heredada) — Clock skew y TTL configurables
`SIGNED_AUTH_CLOCK_SKEW_SECONDS` (default 300) y `SIGNED_AUTH_NONCE_TTL_SECONDS` (default 300). Fail-safe idéntico a `key-session.ts:66-69`: `Number(env ?? default); Number.isFinite(v) && v > 0 ? v : default`. El TTL del nonce **debe ser >= clock_skew** (DT-6 del work-item); si el env del TTL resuelto es menor que el skew resuelto, se usa `max(ttl, skew)` para garantizar que el nonce viva al menos tanto como la ventana de timestamp.

### DT-7 (RESUELTO) — Esquema HMAC-SHA256 criptográficamente sólido
**Problema central:** el server persiste solo `signing_secret_hash = SHA-256(signing_secret)` (CD-5, nunca el plano). Un HMAC clásico con clave = `signing_secret` plano NO es verificable por el server, que no tiene el plano.

**Esquema elegido (opción (c) del work-item) — clave HMAC derivada = el hash que AMBOS lados conocen:**

```
clave_hmac = SHA-256(signing_secret)        // == signing_secret_hash (en DB)
mensaje    = canonical_string                // ver abajo
firma      = HMAC-SHA256(key = clave_hmac, message = canonical_string)  → hex
```

- El **caller** tiene el `signing_secret` plano (recibido una sola vez en la 201). Deriva `key = SHA-256(secret)` y computa `HMAC-SHA256(key, mensaje)`.
- El **server** tiene `signing_secret_hash = SHA-256(secret)` en DB (== `key`). Recomputa `HMAC-SHA256(signing_secret_hash, mensaje)` y compara en **tiempo constante** (`crypto.timingSafeEqual`).

**Por qué es sólido:**
- El server NUNCA necesita el secret plano: la clave efectiva del HMAC es `SHA-256(secret)`, que el server ya tiene. ✓
- El secret plano NUNCA se persiste ni viaja en cada request (solo se usa client-side para derivar la clave). ✓
- Un atacante que filtre solo el `session_token` NO puede firmar: necesita además el `signing_secret` plano (devuelto una sola vez). ✓
- Un atacante que comprometa la DB obtiene `signing_secret_hash` = la clave HMAC → **podría firmar**. Esto es una **propiedad conocida y aceptada** de este esquema simétrico derivado (igual riesgo que tener cualquier clave simétrica server-side); se documenta como TD: el modelo de amenaza de WKH-123 es **token filtrado en tránsito/logs**, NO DB comprometida (esa es WKH-SEC-02 / RLS). El HMAC clásico (clave = secret plano) tendría la misma exposición si el server guardara el plano; acá el server guarda el hash, que es estrictamente **mejor** porque el plano nunca toca la DB. **[documentar en CD-5 + nota TD]**

**Canonical string del HMAC (idéntico contenido lógico que el EIP-712 message, encoding determinista):**
```
canonical = `${token_hash}\n${method}\n${path}\n${nonce}\n${timestamp}`
```
donde:
- `token_hash` = `sha256(rawKey)` hex lowercase **sin** prefijo `0x` (es el `hash` ya computado en el branch sess, línea 470).
- `method` = `request.method.toUpperCase()`.
- `path` = `request.url.split('?')[0]`.
- `nonce` = header `x-a2a-nonce` tal cual (string; para HMAC NO se exige forma bytes32, basta string no vacío `<= 256 chars`).
- `timestamp` = header `x-a2a-timestamp` tal cual (string de epoch seconds).
- separador `\n` (`0x0A`) — fijo, documentado, sin ambigüedad de longitud.

Implementación server (Node, sin libs nuevas):
```
const key = Buffer.from(signing_secret_hash, 'hex');   // 32 bytes
const expected = crypto.createHmac('sha256', key).update(canonical).digest();
const provided = Buffer.from(x_a2a_signature, 'hex');
const ok = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
```
El caller manda `x-a2a-signature` = `HMAC-SHA256(...).digest('hex')` (64 hex chars).

> **Nota de consistencia EIP-712 vs HMAC**: el contenido firmado es el MISMO conjunto de campos (`token_hash, method, path, nonce, timestamp`) en ambos esquemas; solo difiere el encoding (EIP-712 structured hash para master vs string `\n`-delimitado para HMAC session). El Dev NO debe mezclar: master → EIP-712, sess → HMAC.

### DT-8 (RESUELTO) — Endpoints de activación: PATCH dedicados (confirmado)
Se **confirma** el supuesto del work-item: dos endpoints PATCH dedicados, mínima superficie:
- `PATCH /auth/agent-key/:id/require-signature` — body `{ "require_signature": boolean }`. Auth con master key (caller), ownership guard server-side. Master no puede activar firma sin `funding_wallet` bound → si `require_signature:true` y la key target no tiene `funding_wallet` → `400 FUNDING_WALLET_NOT_BOUND` (se rechaza activar lo que sería inutilizable, defensa temprana — el 403 de AC-9 ocurre en runtime).
- `PATCH /auth/key-session/:id/require-signature` — body `{ "require_signature": boolean }`. Auth con master key. Solo válido si la sesión tiene `signing_secret_hash` (se setea al crear con `require_signature:true`); si target no tiene `signing_secret_hash` y se pide `true` → `400 SIGNING_SECRET_NOT_SET` (no se puede activar HMAC sin secret). Ambos gatean sub-sesión como authenticator (patrón `rawKeyFromRequest` + prefix, auth.ts:1115-1121).

> No hay un endpoint de "settings" PATCH preexistente sobre `a2a_agent_keys`/`a2a_key_sessions` (verificado: `auth.ts` solo tiene POST signup/deposit/funding-wallet/bind/delegation/key-session, GET me/list, DELETE). Por eso PATCH dedicado es lo correcto. **[NEEDS CLARIFICATION resuelto → PATCH dedicado]**

---

## 3. Constraint Directives (CD-N)

CD-1..CD-7 **heredadas del work-item** (vinculantes). CD-8..CD-14 nuevas de F2.

- **CD-1 (heredada): BACK-COMPAT ABSOLUTA.** Tokens con `require_signature` false/null → flujo bearer idéntico al pre-WKH-123. Test obligatorio AC-7 master + sess.
- **CD-2 (heredada): NO TOCAR BRANCH WKH-101.** El branch `wasi_a2a_session_` (a2a-key.ts:263-461) NO recibe lógica WKH-123; ignora `x-a2a-*` headers. Test AC-8.
- **CD-3 (heredada): ANTI-REPLAY OBLIGATORIO.** Record del nonce ANTES de retornar éxito; nonce ya visto → `NONCE_REPLAY` aunque la firma sea válida.
- **CD-4 (heredada): OWNERSHIP GUARD en escrituras.** `setRequireSignature(keyId, ownerRef, value)` y el de sesión con `ownerRef: string` ESTRICTO. UPDATE `.eq('id').eq('owner_ref').select('id')` → 0 rows → `logOwnershipMismatch` + `OwnershipMismatchError` (patrón `identity.deactivate` 109-124).
- **CD-5 (heredada): SECRET PLANO NUNCA persistido/logueado.** Solo `SHA-256` en DB. Nunca loguear `signing_secret` plano, `x-a2a-signature`, ni el bearer. Los logs de error del middleware ya usan solo `err.message` (patrón líneas 451-454, 620-623) — mantener.
- **CD-6 (heredada): SIN `any` / `as unknown`.** `SignedAuthHeaders`, `SignedAuthResult`, `SignedAuthNonceRow`, `RequestEip712Domain`, `RequestTypedDataMessage` tipadas completas.
- **CD-7 (heredada): viem, NO ethers.** EIP-712 recover vía `recoverTypedDataAddress` (delegation.ts:18). HMAC vía `node:crypto`.
- **CD-8 (F2): El body HTTP NO se firma en el MVP.** Solo `token_hash+method+path+nonce+timestamp`. El middleware NO lee `request.body` (consistente con la nota CD-7 existente del middleware, línea 249).
- **CD-9 (F2): El server CONSTRUYE el typed-data EIP-712; el caller solo manda la firma.** PROHIBIDO aceptar un `typed_data` del cliente en el path de auth (a diferencia de WKH-101). Esto cierra la superficie de un typed-data malicioso.
- **CD-10 (F2): Comparación HMAC en tiempo constante.** `crypto.timingSafeEqual` sobre buffers de igual longitud; comparar longitud primero (no como rama de timing del secreto). PROHIBIDO `===` sobre strings de firma.
- **CD-11 (F2): El check de firma va DESPUÉS del lookup+is_active y ANTES del debit**, en master y sess. NO debitar si la firma falla (el caller no paga por un request no autenticado).
- **CD-12 (F2): Migración aditiva y reversible.** `ADD COLUMN ... DEFAULT false` (no rompe filas existentes → todas quedan `require_signature=false` = bearer, CD-1). Down-migration `*_down.sql` que dropea columnas/tabla nuevas (patrón `20260603000000_a2a_key_sessions_down.sql`).
- **CD-13 (F2, de auto-blindaje WKH-121): aridad de mocks.** Si se agrega un arg posicional a una función mockeada muy llamada (no aplica si `setRequireSignature` es nueva), `grep -rn "toHaveBeenCalledWith"`. Para WKH-123 los métodos nuevos no cambian firmas existentes → riesgo bajo, pero `budgetService.debit` y `lookupByTokenHash` NO se modifican en firma.
- **CD-14 (F2, de auto-blindaje WKH-104): tests gateados por env.** Usar `delete process.env.X` (no `= undefined`) para desetear; setup que lanza va en `beforeEach`/`beforeAll`, no en el cuerpo del `describe`; resetear mocks con `mockReset()` no `mockResolvedValueOnce` heredable.

---

## 4. Waves de implementación

> Orden serial entre waves; dentro de cada wave los archivos son independientes salvo nota.

### W0 — Contratos: tipos + migración + errores + env (SERIAL, base de todo)
1. `src/types/a2a-key.ts`:
   - `A2AAgentKeyRow`: agregar `require_signature: boolean;`
   - `KeySessionRow`: agregar `require_signature: boolean;` y `signing_secret_hash: string | null;`
   - `CreateKeySessionInput`: agregar `require_signature?: boolean;`
   - `KeySessionResponse`: agregar `signing_secret?: string;` (devuelto SOLO cuando se creó con `require_signature:true`, una vez).
   - Nuevas interfaces: `SignedAuthHeaders { signature: string; nonce: string; timestamp: string }`, `SignedAuthResult` (discriminated union: `{ ok: true }` | `{ ok: false; code: SignedAuthErrorCode }`), `SignedAuthNonceRow { token_hash: string; nonce: string; expires_at: string }`, `RequestEip712Domain { name: string; version: string; chainId: number }`, `RequestTypedDataMessage { token_hash: \`0x${string}\`; method: string; path: string; nonce: \`0x${string}\`; timestamp: number }`.
   - Nuevo type union `SignedAuthErrorCode = 'SIGNATURE_REQUIRED' | 'SIGNATURE_INVALID' | 'NONCE_REPLAY' | 'TIMESTAMP_EXPIRED' | 'FUNDING_WALLET_NOT_BOUND'`.
2. `src/services/security/errors.ts`: agregar error classes (patrón existente `readonly code = '...' as const`):
   - `SignatureRequiredError` (`SIGNATURE_REQUIRED`), `SignatureInvalidError` (`SIGNATURE_INVALID`), `NonceReplayError` (`NONCE_REPLAY`), `TimestampExpiredError` (`TIMESTAMP_EXPIRED`), `SigningSecretNotSetError` (`SIGNING_SECRET_NOT_SET`). Agregar `'keySessionSetRequireSignature'` y `'keySetRequireSignature'` a `OwnershipOp` union si se usa el logger de objeto.
3. `supabase/migrations/20260604000000_wkh123_signed_auth.sql` (+ `_down.sql`):
   - `ALTER TABLE a2a_agent_keys ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;`
   - `ALTER TABLE a2a_key_sessions ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;`
   - `ALTER TABLE a2a_key_sessions ADD COLUMN IF NOT EXISTS signing_secret_hash TEXT;` (NULL = sin secret).
   - `CREATE TABLE IF NOT EXISTS a2a_signed_auth_nonces ( token_hash TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT uq_signed_auth_nonce UNIQUE (token_hash, nonce) );`
   - `CREATE INDEX IF NOT EXISTS idx_signed_auth_nonces_expires ON a2a_signed_auth_nonces (expires_at);` (housekeeping/limpieza).
   - **Sin RPC** → no requiere bloque `search_path/REVOKE/GRANT` (el INSERT/SELECT lo hace el service con service-role como las demás tablas; no se crea función nueva).
   - `_down.sql`: `DROP TABLE IF EXISTS a2a_signed_auth_nonces;` + `ALTER TABLE ... DROP COLUMN IF EXISTS ...` (3 columnas).
4. `.env.example` (bloque nuevo después de líneas 143-160):
   - `REQUEST_EIP712_NAME=WasiAI-a2a Request`
   - `REQUEST_EIP712_VERSION=1`
   - `SIGNED_AUTH_CLOCK_SKEW_SECONDS=300`
   - `SIGNED_AUTH_NONCE_TTL_SECONDS=300`
   - (reusa `KITE_CHAIN_ID` existente para el domain chainId).

### W1 — Service `src/services/signed-auth.ts` (depende de W0)
`signedAuthService` con (todas funciones puras donde se puede, sin `request` Fastify directo — recibe primitivos):
- `buildRequestDomain(): RequestEip712Domain` — patrón `delegation.ts:50-56` con env nuevas.
- `clockSkewSeconds()` / `nonceTtlSeconds()` — fail-safe patrón `key-session.ts:66-69`; el TTL devuelve `max(ttl, skew)`.
- `checkTimestamp(timestampHeader: string): boolean` — parse epoch seconds; `Math.abs(now - ts) <= clockSkew`; NaN/no-entero → false (TIMESTAMP_EXPIRED).
- `verifyEip712RequestSignature({ tokenHash, method, path, nonce, timestamp, signature, fundingWallet }): Promise<boolean>` — construye message canónico (DT-3), `recoverTypedDataAddress`, compara `recovered.toLowerCase() === fundingWallet.toLowerCase()`; valida `nonce` es bytes32 hex; try/catch → false.
- `verifyHmacRequestSignature({ tokenHash, method, path, nonce, timestamp, signature, signingSecretHash }): boolean` — canonical string `\n`-delimitado (DT-7), `crypto.createHmac('sha256', Buffer.from(signingSecretHash,'hex'))`, `timingSafeEqual` (CD-10).
- `checkAndRecordNonce(tokenHash: string, nonce: string): Promise<boolean>` — `INSERT a2a_signed_auth_nonces` con `expires_at = now + ttl`; `23505` → false (replay); otro error → throw (→ 503). Devuelve true si registró (no replay).
- Función orquestadora opcional para reuso en ambos branches, ej. `verifySignedAuth(...)` que ordena timestamp → firma → nonce y devuelve `SignedAuthResult`.

### W2 — Middleware + services de activación (depende de W1)
- `src/middleware/a2a-key.ts`:
  - Agregar union `SignedAuthMiddlewareErrorCode` y helper `send401signed(reply, code, msg)` (patrón `send403session`, líneas 123-129; pero status **401** para SIGNATURE_*/NONCE/TIMESTAMP, **403** para FUNDING_WALLET_NOT_BOUND).
  - Helper `extractSignedHeaders(request): SignedAuthHeaders | null` (lee `x-a2a-signature`/`x-a2a-nonce`/`x-a2a-timestamp`).
  - **Branch master** (insertar entre línea 647 y 682): si `keyRow.require_signature === true` → verificar (orden DT-3 / AC-9 funding_wallet null → 403 FUNDING_WALLET_NOT_BOUND; sin signature → 401 SIGNATURE_REQUIRED; timestamp fuera → 401 TIMESTAMP_EXPIRED; firma EIP-712 inválida → 401 SIGNATURE_INVALID; nonce replay → 401 NONCE_REPLAY). Si pasa → continuar al debit normal.
  - **Branch sess** (insertar entre línea 503 y 506): si `session.require_signature === true` → verificar HMAC (sin signature → 401 SIGNATURE_REQUIRED; timestamp → 401 TIMESTAMP_EXPIRED; HMAC inválido → 401 SIGNATURE_INVALID; nonce replay → 401 NONCE_REPLAY). El `signing_secret_hash` null + require_signature true es un estado imposible si se crea bien, pero defensivo → 401 SIGNATURE_INVALID.
  - **Branch WKH-101 (263-461): NO se toca** (CD-2).
- `src/services/identity.ts`: agregar `setRequireSignature(keyId: string, ownerRef: string, value: boolean): Promise<void>` (patrón `deactivate` 109-124).
- `src/services/key-session.ts`:
  - Extender `create`: si `input.require_signature === true` → generar `signing_secret = crypto.randomBytes(32).toString('hex')`, persistir `signing_secret_hash = sha256(signing_secret)` y `require_signature=true` en el INSERT; devolver `signing_secret` plano en `KeySessionResponse` (una sola vez, CD-5). Si false/undefined → no genera secret, `require_signature=false`.
  - Agregar `setRequireSignature(sessionId: string, ownerRef: string, value: boolean): Promise<void>` (patrón `revoke` 330-350 → `SessionNotFoundError` disclosure-safe si 0 rows). Si `value=true` y la sesión no tiene `signing_secret_hash`, el route lo valida (necesita leer el row) → `SigningSecretNotSetError`.

### W3 — Rutas PATCH (depende de W2)
- `src/routes/auth.ts`:
  - `PATCH /agent-key/:id/require-signature`: gate sub-sesión (rawKeyFromRequest + prefix), `resolveCallerKey`, validar body `require_signature: boolean`, si `true` validar que la key target (la del caller — `:id` debe ser `callerKey.id`, defense-in-depth como deposit.ts:555) tenga `funding_wallet` → si no `400 FUNDING_WALLET_NOT_BOUND`, llamar `identityService.setRequireSignature(callerKey.id, callerKey.owner_ref, value)`. Catch `OwnershipMismatchError` → 403.
  - `PATCH /key-session/:id/require-signature`: gate sub-sesión, `resolveCallerKey`, validar body, llamar `keySessionService.setRequireSignature(:id, callerKey.owner_ref, value)`. Catch `SessionNotFoundError` → 404, `SigningSecretNotSetError` → 400.
  - Extender `parseCreateKeySessionInput` (279-327): aceptar `require_signature?: boolean` (si presente, debe ser boolean; si no boolean → null/INVALID_INPUT). Propagar a `CreateKeySessionInput`.

### W4 — Tests (depende de W0-W3)
Archivos: `src/services/signed-auth.test.ts` (nuevo), extensiones de `src/middleware/a2a-key.test.ts` y `src/routes/auth.signed-auth.test.ts` (nuevo). Ver §6.

---

## 5. Exemplars verificados (paths confirmados con Read)

| Exemplar | Path:líneas | Qué replicar |
|----------|-------------|--------------|
| EIP-712 + viem recover | `src/services/delegation.ts:18,50-56,64-78,141-173` | `recoverTypedDataAddress`, `buildDomain`, `as const` types, recover en try/catch → error |
| Branch sess insert point | `src/middleware/a2a-key.ts:467-630` (insertar firma entre 503-506) | lookup → is_active → [FIRMA] → resolveTargetChain → debit |
| Branch master insert point | `src/middleware/a2a-key.ts:632-757` (insertar firma entre 647-682) | lookup → is_active → daily → per_call → [FIRMA] → resolveTargetChain → debit |
| send403 helpers | `src/middleware/a2a-key.ts:78-129` | factory `send401signed` análogo |
| Ownership UPDATE write | `src/services/identity.ts:109-124` (`deactivate`) | `setRequireSignature` master |
| Ownership UPDATE sess | `src/services/key-session.ts:330-350` (`revoke`) | `setRequireSignature` sess (404 disclosure-safe) |
| Token+secret gen | `src/services/key-session.ts:181-184` | `crypto.randomBytes(32).toString('hex')` + `sha256` |
| Anti-replay 23505 | `src/services/delegation.ts:240-243` | `INSERT` → `error.code === '23505'` → replay error |
| Migración tabla+hardening | `supabase/migrations/20260603000000_a2a_key_sessions.sql:1-23,90-96` | `CREATE TABLE IF NOT EXISTS`, `UNIQUE`, índices (sin RPC → sin hardening block) |
| Endpoint ownership + gate sub-sesión | `src/routes/auth.ts:1182-1221` (DELETE key-session) | PATCH análogo |
| Endpoint funding_wallet gate | `src/routes/auth.ts:601-606`, `deposit.ts:555` | defense-in-depth `:id === callerKey.id`, FUNDING_WALLET_NOT_BOUND |
| Test mocks supabase/registry | `src/services/key-session.test.ts:1-55` | `vi.mock` + `makeParentKey` fixture |
| Env domain pattern | `.env.example:143-160` | bloque `REQUEST_EIP712_*` + `SIGNED_AUTH_*` |

---

## 6. Plan de tests (≥1 por cada uno de los 11 ACs)

| # | AC | Test (archivo) | Caso |
|---|----|----------------|------|
| T1 | AC-1 | `a2a-key.test.ts` | master `require_signature:true` + headers + firma EIP-712 que recupera `funding_wallet` → autentica + debita (200, mismo flujo que bearer). |
| T2 | AC-2 | `a2a-key.test.ts` | sess `require_signature:true` + headers + HMAC válido (derivado del secret) → autentica + debita. |
| T3 | AC-3 | `a2a-key.test.ts` | `require_signature:true` (master y sess) sin `x-a2a-signature` → `401 SIGNATURE_REQUIRED`. |
| T4 | AC-4a | `signed-auth.test.ts` + `a2a-key.test.ts` | EIP-712 recover devuelve signer ≠ funding_wallet → `401 SIGNATURE_INVALID`. |
| T5 | AC-4b | `signed-auth.test.ts` + `a2a-key.test.ts` | HMAC con clave incorrecta → `timingSafeEqual` false → `401 SIGNATURE_INVALID`. |
| T6 | AC-5 | `signed-auth.test.ts` | `checkAndRecordNonce` con nonce ya insertado (`23505`) → replay; en middleware → `401 NONCE_REPLAY` aun con firma válida. |
| T7 | AC-6 | `signed-auth.test.ts` | timestamp `now - (skew+1)` y `now + (skew+1)` → `checkTimestamp` false → `401 TIMESTAMP_EXPIRED`. |
| T8 | AC-7 | `a2a-key.test.ts` | master y sess con `require_signature:false`/`null` y SIN headers → bearer autentica normal (back-compat, CD-1). Con headers presentes pero `require_signature:false` → ignorados, autentica igual. |
| T9 | AC-8 | `a2a-key.test.ts` | token `wasi_a2a_session_*` (WKH-101) con `x-a2a-signature` presente → branch WKH-101 procesa SIN tocar lógica WKH-123 (no SIGNATURE_REQUIRED, no verifica). |
| T10 | AC-9 | `a2a-key.test.ts` | master `require_signature:true` + `funding_wallet:null` → `403 FUNDING_WALLET_NOT_BOUND`. |
| T11 | AC-10 | `auth.signed-auth.test.ts` | PATCH `/agent-key/:id/require-signature` con owner que no matchea → `setRequireSignature` 0 rows → `403 OWNERSHIP_MISMATCH`; sess análogo → `404 SESSION_NOT_FOUND`. |
| T12 | AC-11 | `auth.signed-auth.test.ts` + `key-session.test.ts` | POST `/auth/key-session` con `require_signature:true` → 201 incluye `signing_secret` plano UNA vez; el row persiste solo `signing_secret_hash` (nunca el plano); segunda lectura (GET list) NO expone el secret. |
| T13 | — | `signed-auth.test.ts` | `clockSkewSeconds`/`nonceTtlSeconds` fail-safe: env NaN/<=0/ausente → default 300; TTL = max(ttl, skew). |
| T14 | — | `signed-auth.test.ts` | EIP-712 canonical message: `method` upper, `path` sin querystring, `token_hash` con `0x`. Firma generada con viem `signTypedData` de una cuenta de test verifica OK (round-trip). |
| T15 | CD-5 | `key-session.test.ts` | el `signing_secret` plano NUNCA aparece en el row insertado (assert sobre el arg de `.insert`), solo el hash. |

**Notas de test (CD-14, auto-blindaje)**: para generar firmas EIP-712 válidas en T1/T14 usar `privateKeyToAccount` + `account.signTypedData` de viem (test-only); para HMAC válido en T2/T5 derivar `key=sha256(secret)` y `createHmac`. Env vars de test: setear `REQUEST_EIP712_NAME/VERSION` y `KITE_CHAIN_ID` en `beforeEach`, `delete` para casos de ausencia (NO `= undefined`). Setup de cliente en `beforeAll`/`beforeEach`, no en cuerpo de `describe`.

---

## 7. Readiness Check

- [x] Stack confirmado contra `project-context.md` (viem ^2.47, Fastify ^5.8, Supabase service-role, Vitest ^4.1). Sin drift.
- [x] Todos los exemplars verificados con Read y line ranges reales (§5).
- [x] Punto de inserción del check de firma identificado exactamente en ambos branches (master 647→682, sess 503→506) sin tocar WKH-101 (263-461).
- [x] **Esquema HMAC resuelto SIN ambigüedad** (DT-7): clave = `SHA-256(secret)` = `signing_secret_hash` (conocido por ambos), `HMAC-SHA256(key, canonical)`, comparación `timingSafeEqual`. Criptográficamente sólido para el modelo de amenaza (token filtrado), con TD documentado (DB-comprometida fuera de scope → WKH-SEC-02).
- [x] **Canonical body definido** (DT-3 EIP-712 + DT-7 HMAC): `token_hash, method(upper), path(sin query), nonce, timestamp`. Body HTTP NO firmado (CD-8).
- [x] **Anti-replay decidido** (DT-4): tabla Supabase `a2a_signed_auth_nonces` con `UNIQUE(token_hash, nonce)` → `23505` = replay. NO Redis. Justificado.
- [x] **Endpoints de activación confirmados** (DT-8): PATCH dedicados `/auth/agent-key/:id/require-signature` y `/auth/key-session/:id/require-signature`.
- [x] Migración: `20260604000000_wkh123_signed_auth.sql` (timestamp siguiente disponible verificado contra `ls`; la última es `20260603000000`). Aditiva + reversible (CD-12), `_down.sql` incluido.
- [x] Todas las CDs heredadas (CD-1..CD-7) propagadas + 7 nuevas (CD-8..CD-14).
- [x] Plan de tests cubre los 11 ACs (T1-T12) + edge cases crypto/env (T13-T15).
- [x] Auto-blindaje histórico aplicado (CD-13 aridad mocks WKH-121; CD-14 env/mocks WKH-104).
- [x] **Sin `[NEEDS CLARIFICATION]` residuales de criptografía.** Único residual no-bloqueante: la decisión de un cron de limpieza de `a2a_signed_auth_nonces` (housekeeping, no correctness — el UNIQUE previene replay igual). Se difiere; no bloquea SPEC_APPROVED.

**Estado: LISTO para SPEC_APPROVED.**
