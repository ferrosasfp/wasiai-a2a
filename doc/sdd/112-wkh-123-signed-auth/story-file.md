# Story File — #112: [WKH-123] KEY-SIGNED-AUTH (EIP-712 master + HMAC-SHA256 session)

> SDD: doc/sdd/112-wkh-123-signed-auth/sdd.md
> Fecha: 2026-06-19
> Branch: feat/112-wkh-123-signed-auth

---

## Goal

Agregar una capa de **autenticación por firma por-request, opt-in**, sobre los tokens existentes:
**EIP-712** para master keys (`wasi_a2a_*`, ancla = `funding_wallet`) y **HMAC-SHA256** para session keys
(`wasi_a2a_sess_*`, ancla = `signing_secret`). Un token filtrado deja de ser usable sin la firma correcta
por request. El modo es **opt-in** (`require_signature`) y **back-compat absoluta**: cualquier token con
`require_signature` false/null sigue autenticándose con bearer puro, idéntico al pre-WKH-123. El branch
WKH-101 (`wasi_a2a_session_*`, delegaciones) **NO se toca**.

---

## Acceptance Criteria (EARS)

> Copiados del SDD/work-item aprobados. QA los verifica en F4.

1. **AC-1** WHEN una master key tiene `require_signature: true` y el request trae `x-a2a-signature` + `x-a2a-nonce` + `x-a2a-timestamp` válidos y la firma EIP-712 recupera al `funding_wallet` bindeado, THEN the system SHALL autenticar y continuar al debit normal (igual que bearer válido).
2. **AC-2** WHEN una session key (`wasi_a2a_sess_*`) tiene `require_signature: true` y el request trae los 3 headers válidos y el HMAC-SHA256 coincide (clave derivada del `signing_secret`), THEN the system SHALL autenticar y continuar al debit normal.
3. **AC-3** WHEN un token (master o session) tiene `require_signature: true` y NO incluye `x-a2a-signature`, THEN the system SHALL responder `401` con `error_code: "SIGNATURE_REQUIRED"`.
4. **AC-4** WHEN un token tiene `require_signature: true` y trae `x-a2a-signature` pero la firma no verifica (EIP-712 recover ≠ `funding_wallet`, o HMAC no coincide), THEN the system SHALL responder `401` con `error_code: "SIGNATURE_INVALID"`.
5. **AC-5** WHEN la firma es estructuralmente válida pero el `x-a2a-nonce` ya fue visto para ese token dentro del TTL, THEN the system SHALL responder `401` con `error_code: "NONCE_REPLAY"`.
6. **AC-6** WHEN la firma es estructuralmente válida pero el `x-a2a-timestamp` (epoch seconds) está más de `SIGNED_AUTH_CLOCK_SKEW_SECONDS` en el pasado o futuro, THEN the system SHALL responder `401` con `error_code: "TIMESTAMP_EXPIRED"`.
7. **AC-7** WHILE un token tiene `require_signature: false` o ausente/NULL, the system SHALL autenticar requests bearer (master y session) sin requerir ningún header de firma, idéntico al pre-WKH-123 (headers de firma presentes se IGNORAN).
8. **AC-8** WHILE el branch `wasi_a2a_session_*` (WKH-101) maneja el request, the system SHALL ignorar `x-a2a-signature`/`x-a2a-nonce`/`x-a2a-timestamp` y NO aplicar lógica de WKH-123.
9. **AC-9** IF una master key tiene `require_signature: true` pero `funding_wallet` es NULL, THEN the system SHALL responder `403` con `error_code: "FUNDING_WALLET_NOT_BOUND"`.
10. **AC-10** WHEN el owner activa `require_signature` en una key/session via endpoint de gestión, the system SHALL verificar `owner_ref` del caller == `owner_ref` del row antes de escribir, y responder `403 OWNERSHIP_MISMATCH` si no coincide.
11. **AC-11** WHEN se crea una session key con `require_signature: true`, the system SHALL generar un `signing_secret` de 32 bytes aleatorios, persistir SOLO su SHA-256 (nunca el plano), y devolver el `signing_secret` plano una única vez en la respuesta 201.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/types/a2a-key.ts` | Modificar | Agregar campos a rows + 5 interfaces nuevas + union de error codes (ver Wave 0) | `src/types/a2a-key.ts:34-68,157-186,247-306` |
| 2 | `src/services/security/errors.ts` | Modificar | 5 error classes nuevas + ampliar `OwnershipOp` union | `src/services/security/errors.ts:335-380` |
| 3 | `supabase/migrations/20260604000000_wkh123_signed_auth.sql` | Crear | ALTER tablas + columna `signing_secret_hash` + tabla `a2a_signed_auth_nonces` (SQL textual abajo) | `supabase/migrations/20260603000000_a2a_key_sessions.sql:1-23` |
| 4 | `supabase/migrations/20260604000000_wkh123_signed_auth_down.sql` | Crear | DROP tabla + DROP COLUMNS (SQL textual abajo) | `supabase/migrations/20260603000000_a2a_key_sessions_down.sql` |
| 5 | `.env.example` | Modificar | 4 env vars nuevas (`REQUEST_EIP712_*`, `SIGNED_AUTH_*`) | `.env.example:143-160` |
| 6 | `src/services/signed-auth.ts` | Crear | Nuevo service: domain builder, fail-safe getters, checkTimestamp, verify EIP-712, verify HMAC, checkAndRecordNonce | `src/services/delegation.ts:50-56,141-173`; `src/services/llm/transform-hmac.ts` |
| 7 | `src/services/identity.ts` | Modificar | `setRequireSignature(keyId, ownerRef, value)` con ownership guard | `src/services/identity.ts:109-124` (`deactivate`) |
| 8 | `src/services/key-session.ts` | Modificar | Extender `create` (genera secret si `require_signature:true`) + `setRequireSignature(sessionId, ownerRef, value)` | `src/services/key-session.ts:181-208,330-350` |
| 9 | `src/middleware/a2a-key.ts` | Modificar | Helpers `send401signed`/`extractSignedHeaders` + check de firma en branch master (~647→682) y branch sess (~503→506). **NO tocar branch WKH-101 (263-461).** | `src/middleware/a2a-key.ts:78-129,467-630,632-757` |
| 10 | `src/routes/auth.ts` | Modificar | 2 endpoints PATCH `.../require-signature` + extender `parseCreateKeySessionInput` para `require_signature?` | `src/routes/auth.ts:279-327,1182-1221` |
| 11 | `src/services/signed-auth.test.ts` | Crear | Tests del service (timestamp, EIP-712 round-trip, HMAC, nonce, fail-safe) | `src/services/key-session.test.ts:1-55` |
| 12 | `src/middleware/a2a-key.test.ts` | Modificar | Tests de middleware (AC-1..AC-10 en ambos branches + WKH-101 ignora) | `src/services/key-session.test.ts:1-55` |
| 13 | `src/routes/auth.signed-auth.test.ts` | Crear | Tests de rutas PATCH (ownership) + POST key-session con `require_signature` (AC-10, AC-11) | `src/services/key-session.test.ts:1-55` |

---

## Esquema de firma EXACTO (vinculante — sin ambigüedad)

> Ambos esquemas firman el **mismo conjunto lógico de campos**: `token_hash, method, path, nonce, timestamp`.
> Solo difiere el encoding. **NO mezclar**: master → EIP-712, session → HMAC.

### Campos comunes (cómo los obtiene el server)

- **`token_hash`**: el SHA-256 del bearer crudo, **ya computado por el lookup**.
  - Branch master: la var `keyHash` (a2a-key.ts ~L636).
  - Branch sess: la var `hash` (a2a-key.ts ~L470).
  - HMAC usa el hash **hex lowercase SIN `0x`**. EIP-712 usa **`0x${hash}` lowercase** (32 bytes → `bytes32`).
- **`method`**: `request.method.toUpperCase()` (ej. `"POST"`).
- **`path`**: `request.url.split('?')[0]` — **sin query string** (ej. `"/api/v1/compose"`).
- **`nonce`**: header `x-a2a-nonce`.
- **`timestamp`**: header `x-a2a-timestamp`, epoch **seconds** entero.

### EIP-712 (master keys)

Typed-data **construido por el SERVER** desde el lookup + headers (el caller manda **solo** la firma; PROHIBIDO aceptar un `typed_data` del cliente — CD-9):

```ts
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

- **domain**: `buildRequestDomain()` → `{ name: REQUEST_EIP712_NAME (default "WasiAI-a2a Request"), version: REQUEST_EIP712_VERSION (default "1"), chainId: Number(process.env.KITE_CHAIN_ID) }`. Replica `delegation.ts:50-56` con las env nuevas. **Distinto** del domain de delegaciones (`WasiAI-a2a Delegation`).
- **message**: `{ token_hash: \`0x${hash}\`, method, path, nonce, timestamp: BigInt(timestamp) }`. El `nonce` debe matchear `/^0x[0-9a-fA-F]{64}$/` (bytes32); si no → tratar como firma inválida.
- **recover**: `recoverTypedDataAddress({ domain, types: REQUEST_TYPES, primaryType: 'Request', message, signature })` — espejo de `delegation.ts:148`. En `try/catch` → cualquier throw devuelve `false`.
- **comparación**: `recovered.toLowerCase() === fundingWallet.toLowerCase()`.

### HMAC-SHA256 (session keys)

```ts
clave_hmac = SHA-256(signing_secret)        // === signing_secret_hash (lo que el server tiene en DB)
canonical  = `${token_hash}\n${method}\n${path}\n${nonce}\n${timestamp}`   // token_hash SIN 0x
firma      = HMAC-SHA256(key = clave_hmac, message = canonical)  → hex (64 chars)
```

- El **caller** tiene el `signing_secret` plano (recibido una sola vez en la 201). Deriva `key = SHA-256(secret)` y firma.
- El **server** ya tiene `signing_secret_hash` (= `SHA-256(secret)` = la key). Recomputa y compara en **tiempo constante**:

```ts
const key = Buffer.from(signingSecretHash, 'hex');           // 32 bytes
const expected = crypto.createHmac('sha256', key).update(canonical).digest();
const provided = Buffer.from(xA2aSignature, 'hex');
const ok = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
```

- El secret plano **nunca viaja en cada request** ni se persiste. PROHIBIDO `===` sobre strings de firma (CD-10).
- Validar la firma como hex 64-char ANTES de `Buffer.from` (rechazar malformadas sin throw, patrón `transform-hmac.ts:69`).

### Anti-replay (ambos esquemas)

```ts
// INSERT en a2a_signed_auth_nonces, UNIQUE(token_hash, nonce):
//   .insert({ token_hash, nonce, expires_at: <now + ttl ISO> })
//   si error.code === '23505'  → NONCE_REPLAY (devuelve false)
//   si otro error             → throw (→ 503)
//   sin error                 → registró (no replay) → true
```

- **Orden de verificación obligatorio** (CD-3, CD-11): `checkTimestamp` → verificar firma → `checkAndRecordNonce` → éxito. El nonce se registra ANTES de retornar éxito y DESPUÉS de validar firma+timestamp.
- `timestamp` fuera de `±SIGNED_AUTH_CLOCK_SKEW_SECONDS` → `TIMESTAMP_EXPIRED`. NaN/no-entero → expirado.

---

## SQL de la migración (textual — copiar tal cual)

### `supabase/migrations/20260604000000_wkh123_signed_auth.sql`

```sql
-- WKH-123 KEY-SIGNED-AUTH: auth por firma opt-in (EIP-712 master + HMAC-SHA256 session)
-- Aditiva y reversible. Filas existentes quedan require_signature=false (= bearer, back-compat).

-- 1. Flag opt-in en master keys
ALTER TABLE a2a_agent_keys
  ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;

-- 2. Flag opt-in + secret hash en session keys
ALTER TABLE a2a_key_sessions
  ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE a2a_key_sessions
  ADD COLUMN IF NOT EXISTS signing_secret_hash TEXT;   -- NULL = sin secret (HMAC no disponible)

-- 3. Anti-replay: nonces vistos por token, con TTL. UNIQUE(token_hash, nonce) = garantía atómica.
CREATE TABLE IF NOT EXISTS a2a_signed_auth_nonces (
  token_hash  TEXT        NOT NULL,
  nonce       TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_signed_auth_nonce UNIQUE (token_hash, nonce)
);

-- Índice para housekeeping/limpieza de filas expiradas (no requiere job en MVP).
CREATE INDEX IF NOT EXISTS idx_signed_auth_nonces_expires
  ON a2a_signed_auth_nonces (expires_at);
```

> **Sin RPC** → NO requiere bloque `SET search_path` / `REVOKE` / `GRANT`. El INSERT/SELECT lo hace el service con service-role, igual que las demás tablas. No se crea ninguna función.

### `supabase/migrations/20260604000000_wkh123_signed_auth_down.sql`

```sql
-- WKH-123 down-migration
DROP TABLE IF EXISTS a2a_signed_auth_nonces;

ALTER TABLE a2a_key_sessions DROP COLUMN IF EXISTS signing_secret_hash;
ALTER TABLE a2a_key_sessions DROP COLUMN IF EXISTS require_signature;
ALTER TABLE a2a_agent_keys   DROP COLUMN IF EXISTS require_signature;
```

---

## Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU define el contrato de auth caller ↔ middleware y los endpoints PATCH/POST. Dev no empieza si algún campo está vacío.

### Caller (firmante) → Middleware (`a2a-key.ts` preHandler)

**Request — headers de firma (cuando `require_signature: true`):**

| Header | Tipo | Descripción |
|--------|------|-------------|
| `authorization` | `Bearer wasi_a2a_*` / `Bearer wasi_a2a_sess_*` | bearer token (igual que hoy) |
| `x-a2a-signature` | string hex | EIP-712 sig (`0x...`, master) o HMAC-SHA256 hex 64-char (session) |
| `x-a2a-nonce` | string | master: bytes32 `0x[0-9a-fA-F]{64}`; session: string no vacío ≤256 chars |
| `x-a2a-timestamp` | string | epoch **seconds** entero |

**Response exitoso:** continúa al flujo normal (debit) — mismo 2xx que bearer.

**Errores:**

| HTTP | `error_code` | Cuándo |
|---|---|---|
| 401 | `SIGNATURE_REQUIRED` | `require_signature:true` y falta `x-a2a-signature` |
| 401 | `SIGNATURE_INVALID` | firma presente pero recover≠funding_wallet (master) o HMAC no coincide (session) |
| 401 | `NONCE_REPLAY` | nonce ya visto para ese token en el TTL (aun con firma válida) |
| 401 | `TIMESTAMP_EXPIRED` | timestamp fuera de `±SIGNED_AUTH_CLOCK_SKEW_SECONDS` |
| 403 | `FUNDING_WALLET_NOT_BOUND` | master `require_signature:true` y `funding_wallet` NULL |
| 503 | — | error de DB al registrar el nonce (no swallow) |

### Caller (master) → `PATCH /auth/agent-key/:id/require-signature`

**Auth:** master key (gate sub-sesión + `resolveCallerKey`). `:id` debe ser `callerKey.id` (defense-in-depth).

**Request body:** `{ "require_signature": boolean }`

**Response 200:** `{ ok: true, require_signature: <value> }` (forma exacta según patrón de la ruta existente; mantener consistente con el resto de `auth.ts`).

**Errores:** `400 FUNDING_WALLET_NOT_BOUND` (si `true` y la key no tiene `funding_wallet`), `400 INVALID_INPUT` (body no boolean), `403 OWNERSHIP_MISMATCH`, `401` (auth).

### Caller (master) → `PATCH /auth/key-session/:id/require-signature`

**Auth:** master key (gate sub-sesión + `resolveCallerKey`).

**Request body:** `{ "require_signature": boolean }`

**Errores:** `400 SIGNING_SECRET_NOT_SET` (si `true` y la sesión no tiene `signing_secret_hash`), `400 INVALID_INPUT`, `404 SESSION_NOT_FOUND` (ownership/no existe — disclosure-safe), `401` (auth).

### Caller → `POST /auth/key-session` (extendido)

**Request body:** acepta opcional `require_signature?: boolean` (si presente, DEBE ser boolean; si no boolean → `INVALID_INPUT`).

**Response 201:** además del `session_token` actual, incluye `signing_secret` (plano, 64 hex chars) **SOLO** cuando se creó con `require_signature: true`. Nunca aparece en GET/list posteriores.

---

## Exemplars

### Exemplar 1: EIP-712 recover con viem
**Archivo**: `src/services/delegation.ts:141-173` (recover) + `:50-56` (domain) + `:64-78` (`as const` types) + `:18` (import)
**Usar para**: `signed-auth.ts` → `buildRequestDomain` y `verifyEip712RequestSignature`
**Patrón clave**:
- `import { recoverTypedDataAddress } from 'viem'`.
- Domain leído de env con default. Types `as const`, sin `EIP712Domain` en `types`.
- Recover dentro de `try/catch`; cualquier throw → resultado negativo (acá → `false`).
- `uint64` se pasa como `BigInt(value)` (ver `delegation.ts:161`).

### Exemplar 2: HMAC con node:crypto + timingSafeEqual
**Archivo**: `src/services/llm/transform-hmac.ts` (completo)
**Usar para**: `signed-auth.ts` → `verifyHmacRequestSignature`
**Patrón clave**:
- `import { createHmac, timingSafeEqual } from 'node:crypto'`.
- Validar que la firma es hex 64-char ANTES de `Buffer.from` (rechaza malformadas sin throw).
- `if (provided.length !== expected.length) return false;` ANTES de `timingSafeEqual` (evita throw por longitud).
- NUNCA `===` sobre buffers/strings de firma.

### Exemplar 3: Ownership UPDATE write (master)
**Archivo**: `src/services/identity.ts:109-124` (`deactivate`)
**Usar para**: `identity.setRequireSignature`
**Patrón clave**:
```ts
const { data, error } = await supabase
  .from('a2a_agent_keys')
  .update({ require_signature: value })
  .eq('id', keyId)
  .eq('owner_ref', ownerId)   // <- imprescindible (Ownership Guard, WKH-53)
  .select('id');
if (error) throw new Error(`...: ${error.message}`);
if (!data || data.length === 0) {
  logOwnershipMismatch('deactivate', keyId, ownerId);  // usar op propio (ver errors.ts)
  throw new OwnershipMismatchError();
}
```

### Exemplar 4: Ownership UPDATE sess (disclosure-safe 404)
**Archivo**: `src/services/key-session.ts:330-350` (`revoke`)
**Usar para**: `keySession.setRequireSignature`
**Patrón clave**: UPDATE `.eq('id').eq('owner_ref').select('id')` → 0 rows → `SessionNotFoundError` (404 disclosure-safe, no revela existencia cross-tenant).

### Exemplar 5: Token + secret generation
**Archivo**: `src/services/key-session.ts:181-208` (`create`)
**Usar para**: extender `create` con `signing_secret`
**Patrón clave**: `crypto.randomBytes(32).toString('hex')` para el secret; `sha256` para el hash; INSERT solo el hash + `require_signature`. Devolver el plano en la respuesta una sola vez.

### Exemplar 6: Anti-replay 23505
**Archivo**: `src/services/delegation.ts:240-243`
**Usar para**: `signed-auth.checkAndRecordNonce`
**Patrón clave**: `INSERT` → si `error.code === '23505'` → conflicto (replay). Otro error → throw.

### Exemplar 7: Branches del middleware + helpers de respuesta
**Archivo**: `src/middleware/a2a-key.ts:78-129` (`send403*` factory), `:467-630` (branch sess), `:632-757` (branch master), `:263-461` (branch WKH-101 — **NO TOCAR**)
**Usar para**: `send401signed`, `extractSignedHeaders`, inserción del check de firma
**Patrón clave**:
- Branch sess: lookup → is_active del parent (498-503) → **[INSERTAR FIRMA AQUÍ]** → `resolveTargetChain` (506) → debit.
- Branch master: lookup → is_active (647) → daily → per_call → **[INSERTAR FIRMA AQUÍ]** → `resolveTargetChain` (682) → debit.
- Logs de error usan solo `err.message` (451-454, 620-623) — mantener. NUNCA loguear firma/nonce/bearer/secret.

### Exemplar 8: Endpoint con gate sub-sesión + ownership
**Archivo**: `src/routes/auth.ts:1182-1221` (DELETE key-session), `:279-327` (`parseCreateKeySessionInput`), `:601-606` + `deposit.ts:555` (gate funding_wallet `:id === callerKey.id`)
**Usar para**: los 2 PATCH + extensión de `parseCreateKeySessionInput`
**Patrón clave**: `rawKeyFromRequest` + `.startsWith(PREFIX)` (gate sub-sesión) ANTES de `resolveCallerKey`; map de error class → status en el catch.

### Exemplar 9: Migración tabla + ALTER
**Archivo**: `supabase/migrations/20260603000000_a2a_key_sessions.sql:1-23` (CREATE TABLE/INDEX) y `_down.sql`
**Usar para**: la migración (ver SQL textual arriba — copiar tal cual, no re-derivar)

### Exemplar 10: Test mocks supabase/registry
**Archivo**: `src/services/key-session.test.ts:1-55`
**Usar para**: los 3 archivos de test
**Patrón clave**: `vi.mock('../lib/supabase.js')` con `{ from: vi.fn(), rpc: vi.fn() }`; `vi.mock('../adapters/registry.js')`; fixture `makeParentKey(overrides)`.

---

## Constraint Directives

### OBLIGATORIO
- **CD-1: BACK-COMPAT ABSOLUTA.** `require_signature` false/null → flujo bearer IDÉNTICO al pre-WKH-123 (master y sess). Headers de firma presentes con `require_signature:false` → IGNORADOS. Test AC-7.
- **CD-3: ANTI-REPLAY OBLIGATORIO.** Registrar el nonce ANTES de retornar éxito. Nonce ya visto → `NONCE_REPLAY` aunque la firma sea válida. Orden: timestamp → firma → nonce.
- **CD-4: OWNERSHIP GUARD estricto.** `setRequireSignature(keyId, ownerRef, value)` con `ownerRef: string` ESTRICTO (no `string | undefined`). UPDATE `.eq('id').eq('owner_ref').select('id')` → 0 rows → log + error.
- **CD-5: SECRET PLANO NUNCA persistido/logueado.** Solo SHA-256 en DB. NUNCA loguear `signing_secret`, `x-a2a-signature` ni el bearer. Logs de error solo `err.message`.
- **CD-9: El server CONSTRUYE el typed-data EIP-712.** El caller manda SOLO la firma. PROHIBIDO aceptar un `typed_data` del cliente en el path de auth.
- **CD-10: HMAC en tiempo constante.** `crypto.timingSafeEqual` sobre buffers de igual longitud (comparar longitud primero). PROHIBIDO `===` sobre strings de firma.
- **CD-11: El check de firma va DESPUÉS del lookup+is_active y ANTES del debit**, en master y sess. NO debitar si la firma falla.
- **CD-12: Migración aditiva y reversible.** `ADD COLUMN ... DEFAULT false`. `_down.sql` que dropea lo nuevo.
- Usar `node:crypto` (`createHash`/`createHmac`/`timingSafeEqual`/`randomBytes`); precedente `transform-hmac.ts`.
- Env con fail-safe: `Number(env ?? default); Number.isFinite(v) && v > 0 ? v : default` (patrón `key-session.ts:66-69`). El TTL del nonce devuelve `max(ttl, skew)`.

### PROHIBIDO
- **CD-2: NO TOCAR el branch WKH-101** (`wasi_a2a_session_*`, `a2a-key.ts:263-461`). Ese branch IGNORA los headers `x-a2a-*` y no aplica nada de WKH-123. Test AC-8.
- **CD-7: PROHIBIDO ethers.** EIP-712 vía `recoverTypedDataAddress` de `viem`. HMAC vía `node:crypto`.
- **CD-6: PROHIBIDO `any` / `as unknown`.** TS strict. Tipar completas: `SignedAuthHeaders`, `SignedAuthResult`, `SignedAuthNonceRow`, `RequestEip712Domain`, `RequestTypedDataMessage`, `SignedAuthErrorCode`.
- **CD-8: NO firmar el body HTTP** (MVP). Solo `token_hash+method+path+nonce+timestamp`. El middleware NO lee `request.body`.
- NO agregar dependencias nuevas — ninguna (todo con `viem` ya instalado y `node:crypto`).
- NO modificar la firma de `budgetService.debit` ni `lookupByTokenHash` (CD-13: si tocaras una firma muy usada, `grep -rn "toHaveBeenCalledWith"` — acá no aplica, métodos nuevos).
- NO modificar archivos fuera de la tabla "Files to Modify/Create".

---

## Anti-Hallucination Checklist (específico WKH-123)

Antes de dar por terminada cada wave, verificar:

- [ ] El branch WKH-101 (`wasi_a2a_session_`, `a2a-key.ts:263-461`) quedó **intacto** (diff vacío en ese rango).
- [ ] El check de firma master se insertó entre is_active (~L647) y `resolveTargetChain` (~L682); el sess entre is_active del parent (~L503) y `resolveTargetChain` (~L506). **Antes del debit.**
- [ ] `require_signature` false/null → el flujo bearer NO cambió (revisar que el `if (require_signature === true)` envuelve TODO el bloque nuevo).
- [ ] El `signing_secret` plano NUNCA se persiste (assert: el arg de `.insert` solo contiene `signing_secret_hash`) ni se loguea.
- [ ] Firma (`x-a2a-signature`), nonce, bearer y secret NUNCA aparecen en `console.*` / `logger.*` / `reply` de error.
- [ ] `setRequireSignature` (identity y key-session) tiene firma con `ownerRef: string` (NO `string | undefined`) y filtra `.eq('owner_ref', ...)`.
- [ ] EIP-712 con `viem` (`recoverTypedDataAddress`), HMAC con `node:crypto` (`createHmac`). CERO `ethers`.
- [ ] HMAC comparado con `timingSafeEqual` (NO `===`), con check de longitud previo.
- [ ] TS strict: sin `any`, sin `as unknown`. Todas las interfaces nuevas tipadas.
- [ ] Tests: aridad de mocks correcta en `toHaveBeenCalledWith`; env de test se desetea con `delete process.env.X` (NO `= undefined`); setup en `beforeEach`/`beforeAll`, no en cuerpo de `describe`; sin `mockResolvedValueOnce` heredable entre tests.
- [ ] La migración usa `20260604000000` (último existente es `20260603000000`) y trae su `_down.sql`.

---

## Test Expectations

| Test | ACs / objetivo | Framework | Tipo |
|------|----------------|-----------|------|
| `src/middleware/a2a-key.test.ts` | AC-1 (master EIP-712 OK→debit), AC-2 (sess HMAC OK→debit), AC-3 (sin sig→401 SIGNATURE_REQUIRED master+sess), AC-4 (EIP-712 signer≠wallet y HMAC mal→401 SIGNATURE_INVALID), AC-5 (nonce replay→401 NONCE_REPLAY aun con firma válida), AC-6 (timestamp fuera ventana→401 TIMESTAMP_EXPIRED), AC-7 (bearer back-compat master+sess; headers ignorados con require_signature:false), AC-8 (token WKH-101 con headers→branch 101 procesa sin verificar), AC-9 (master require_signature:true + funding_wallet null→403 FUNDING_WALLET_NOT_BOUND) | Vitest | integration |
| `src/services/signed-auth.test.ts` | EIP-712 round-trip con `privateKeyToAccount`+`signTypedData` (canonical: method upper, path sin query, token_hash con 0x); HMAC válido/inválido (key=sha256(secret)); `checkTimestamp` (now±(skew+1)→false); `checkAndRecordNonce` 23505→replay; fail-safe `clockSkewSeconds`/`nonceTtlSeconds` (NaN/<=0/ausente→300, TTL=max(ttl,skew)) | Vitest | unit |
| `src/routes/auth.signed-auth.test.ts` | AC-10 (PATCH agent-key owner≠→403 OWNERSHIP_MISMATCH; PATCH key-session owner≠→404 SESSION_NOT_FOUND; require_signature:true sin funding_wallet→400 FUNDING_WALLET_NOT_BOUND; require_signature:true sin signing_secret_hash→400 SIGNING_SECRET_NOT_SET), AC-11 (POST key-session require_signature:true→201 con signing_secret una vez; GET list NO lo expone) | Vitest | integration |
| `src/services/key-session.test.ts` (extensión) | CD-5 (el `signing_secret` plano NUNCA en el arg de `.insert`, solo el hash); `create` con require_signature:true genera secret y persiste hash | Vitest | unit |

> Para firmas EIP-712 válidas en tests usar `privateKeyToAccount` + `account.signTypedData` de viem (test-only). Para HMAC válido derivar `key=sha256(secret)` + `createHmac`. Setear `REQUEST_EIP712_NAME/VERSION` y `KITE_CHAIN_ID` en `beforeEach`; `delete` para casos de ausencia.

### Criterio Test-First

| Tipo de cambio | Test-first? |
|----------------|-------------|
| `signed-auth.ts` (lógica crypto) | Sí |
| middleware branches / rutas PATCH | Sí |
| migración SQL / `.env.example` | No |
| tipos / error classes | No (cubiertos por los tests de consumidores) |

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN deben existir:
ls src/middleware/a2a-key.ts src/services/identity.ts src/services/key-session.ts \
   src/types/a2a-key.ts src/routes/auth.ts src/services/security/errors.ts \
   src/services/delegation.ts src/services/llm/transform-hmac.ts \
   supabase/migrations/20260603000000_a2a_key_sessions.sql 2>/dev/null || echo "FALTA archivo base"
# Confirmar que NO existe ya la migración nueva:
ls supabase/migrations/20260604000000_wkh123_signed_auth.sql 2>/dev/null && echo "YA EXISTE — revisar"
# tsc baseline limpio:
npx tsc --noEmit && echo "tsc baseline OK"
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.

### Wave 0 — Contratos (SERIAL, base de todo)
- [ ] W0.1: `src/types/a2a-key.ts` → campos en `A2AAgentKeyRow` (`require_signature: boolean`), `KeySessionRow` (`require_signature: boolean`, `signing_secret_hash: string | null`), `CreateKeySessionInput` (`require_signature?: boolean`), `KeySessionResponse` (`signing_secret?: string`); interfaces `SignedAuthHeaders`, `SignedAuthResult` (discriminated union `{ok:true} | {ok:false; code:SignedAuthErrorCode}`), `SignedAuthNonceRow`, `RequestEip712Domain`, `RequestTypedDataMessage`; union `SignedAuthErrorCode`. → Archivo #1
- [ ] W0.2: `src/services/security/errors.ts` → `SignatureRequiredError`, `SignatureInvalidError`, `NonceReplayError`, `TimestampExpiredError`, `SigningSecretNotSetError` (patrón `readonly code = '...' as const`); ampliar `OwnershipOp` si se usa logger de objeto. → Archivo #2
- [ ] W0.3: crear `20260604000000_wkh123_signed_auth.sql` + `_down.sql` (SQL textual de este doc). → Archivos #3, #4
- [ ] W0.4: `.env.example` → `REQUEST_EIP712_NAME=WasiAI-a2a Request`, `REQUEST_EIP712_VERSION=1`, `SIGNED_AUTH_CLOCK_SKEW_SECONDS=300`, `SIGNED_AUTH_NONCE_TTL_SECONDS=300`. → Archivo #5
- Verificación: `npx tsc --noEmit` pasa.

### Wave 1 — Service `signed-auth.ts` (depende de W0)
- [ ] W1.1: `src/services/signed-auth.ts` → `buildRequestDomain`, `clockSkewSeconds`/`nonceTtlSeconds` (fail-safe, TTL=max), `checkTimestamp`, `verifyEip712RequestSignature`, `verifyHmacRequestSignature`, `checkAndRecordNonce`, y orquestador `verifySignedAuth` → `SignedAuthResult`. Funciones reciben primitivos (no `request` Fastify). → Archivo #6 → Exemplars 1, 2, 6
- [ ] W1.2 (test-first, junto a W1.1): `src/services/signed-auth.test.ts`. → Archivo #11
- Verificación: `npx tsc --noEmit` + tests de `signed-auth.test.ts` verdes.

### Wave 2 — Middleware + services de activación (depende de W1)
- [ ] W2.1: `src/services/identity.ts` → `setRequireSignature(keyId, ownerRef, value)`. → Archivo #7 → Exemplar 3
- [ ] W2.2: `src/services/key-session.ts` → extender `create` (genera secret si `require_signature:true`, persiste solo hash, devuelve plano una vez) + `setRequireSignature(sessionId, ownerRef, value)`. → Archivo #8 → Exemplars 4, 5
- [ ] W2.3: `src/middleware/a2a-key.ts` → `send401signed`, `extractSignedHeaders`, check de firma en branch master (~647→682) y sess (~503→506). **NO tocar WKH-101.** → Archivo #9 → Exemplar 7
- [ ] W2.4: extender tests `src/middleware/a2a-key.test.ts` + tests del secret en `key-session.test.ts`. → Archivos #12, #13(parcial)
- Verificación: `npx tsc --noEmit` + tests de middleware/key-session verdes.

### Wave 3 — Rutas PATCH + POST (depende de W2)
- [ ] W3.1: `src/routes/auth.ts` → 2 endpoints PATCH `.../require-signature` + extender `parseCreateKeySessionInput` para `require_signature?`. → Archivo #10 → Exemplar 8
- [ ] W3.2: `src/routes/auth.signed-auth.test.ts`. → Archivo #13
- Verificación: `npx tsc --noEmit` + tests de rutas verdes.

### Wave 4 — Verificación final
- [ ] W4.1: `npx tsc --noEmit` → 0 errores.
- [ ] W4.2: format ANTES de lint, luego lint (orden del proyecto).
- [ ] W4.3: suite completa verde — **sin romper WKH-101 / WKH-121 / WKH-122**.
- [ ] W4.4: los 11 ACs cubiertos por al menos un test cada uno.

### Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | `tsc --noEmit` |
| W1 | `tsc` + `signed-auth.test.ts` |
| W2 | `tsc` + middleware/key-session tests |
| W3 | `tsc` + rutas tests |
| W4 | tsc 0 + format→lint + suite completa verde + 11 ACs |

---

## Done Definition

- `npx tsc --noEmit` → **0 errores** (TS strict, sin `any`).
- **format ANTES de lint**; lint limpio.
- Suite completa verde, **sin romper WKH-101 / WKH-121 / WKH-122**.
- Branch WKH-101 (`a2a-key.ts:263-461`) intacto (diff vacío).
- `signing_secret` plano nunca persistido ni logueado (CD-5 verificado en test).
- Los **11 ACs** cubiertos por al menos un test cada uno.
- Migración `20260604000000_wkh123_signed_auth.sql` + `_down.sql` aditiva y reversible.

---

## Out of Scope

> Dev NO toca bajo ninguna circunstancia:

- El branch WKH-101 `wasi_a2a_session_*` (`a2a-key.ts:263-461`).
- Firma del body HTTP (CD-8 — TD futuro).
- Redis para nonces (se decidió tabla Supabase).
- RLS Postgres (WKH-SEC-02).
- WebAuthn/passkey, SDK client-side, on-chain nonce anchoring.
- Firmas de `budgetService.debit` / `lookupByTokenHash` (no cambian).
- NO "mejorar" código adyacente ni refactors no solicitados.

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar. No asumir.

Escalar si: un exemplar ya no existe en esos rangos; las líneas de inserción del middleware difieren del rango indicado; la tabla/columna de DB no coincide con lo esperado; ambigüedad en un AC; el cambio requiere tocar archivos fuera de la tabla.

---

*Story File generado por NexusAgil — F2.5*
