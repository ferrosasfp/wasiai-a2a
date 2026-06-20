# Work Item — [WKH-123] KEY-SIGNED-AUTH: Auth por firma en vez de bearer secreto

## Resumen

Agregar una **capa de autenticación por firma** sobre los tokens de la Agent Key y las session keys server-side (WKH-121), de modo que un token filtrado no sea usable sin la firma correspondiente por request. El modo firmado es **opt-in** (un campo en la key/sesión lo activa) y **coexiste** con el bearer actual: callers que no habiliten la firma siguen autenticándose con su bearer sin cambios (back-compat absoluta con WKH-101, WKH-121, WKH-122).

Alcance MVP: **EIP-712 request signing para master keys (`wasi_a2a_*`)** cuya `funding_wallet` esté bindeada, más **HMAC-SHA256 request signing para session keys (`wasi_a2a_sess_*`)** sin wallet. Ambos comparten el mismo contrato de anti-replay (nonce + timestamp). El esquema WebAuthn/passkey y el signing de delegaciones EIP-712 (WKH-101) quedan FUERA de este scope.

---

## Sizing

- SDD_MODE: full
- Estimación: L (confirmada — toca middleware, 3 branches de auth, 2 esquemas de firma, migración DB, anti-replay, tests)
- Branch sugerido: `feat/112-wkh-123-signed-auth`
- Ruta: QUALITY (identidad/seguridad/pago — mandatorio)

---

## Skills Router

- `security/auth` — diseño de esquemas de firma, anti-replay, gestión de claves públicas/HMAC
- `backend/middleware` — integración en Fastify preHandler, branches de detección, coexistencia con branches existentes

---

## Acceptance Criteria (EARS)

### Flujo firmado — habilitación y activación

**AC-1 (opt-in en master key)**
WHEN a master key tiene `require_signature: true` en su row y el request incluye headers `x-a2a-signature` y `x-a2a-nonce` y `x-a2a-timestamp` válidos y la firma EIP-712 recupera al `funding_wallet` bindeado, THEN the system SHALL autenticar el request y continuar al debit normal (igual que un bearer válido sin firma).

**AC-2 (opt-in en session key)**
WHEN una session key (`wasi_a2a_sess_*`) tiene `require_signature: true` en su row y el request incluye headers `x-a2a-signature` y `x-a2a-nonce` y `x-a2a-timestamp` válidos y la firma HMAC-SHA256 es correcta (clave derivada del `signing_secret` de la sesión), THEN the system SHALL autenticar el request y continuar al debit normal de la sesión.

### Modo firmado requerido — rechazo por firma ausente o inválida

**AC-3 (firma ausente cuando se requiere)**
WHEN un token (master o session) tiene `require_signature: true` y el request NO incluye `x-a2a-signature`, THEN the system SHALL responder 401 con `error_code: "SIGNATURE_REQUIRED"`.

**AC-4 (firma inválida)**
WHEN un token tiene `require_signature: true` y el request incluye `x-a2a-signature` pero la firma no verifica (EIP-712 recover devuelve un signer distinto de `funding_wallet`, o el HMAC no coincide), THEN the system SHALL responder 401 con `error_code: "SIGNATURE_INVALID"`.

### Anti-replay

**AC-5 (nonce ya visto)**
WHEN la firma del request es estructuralmente válida pero el `x-a2a-nonce` ya fue visto para ese token en el TTL de anti-replay (configurable, default 5 min), THEN the system SHALL responder 401 con `error_code: "NONCE_REPLAY"`.

**AC-6 (timestamp fuera de ventana)**
WHEN la firma del request es estructuralmente válida pero el `x-a2a-timestamp` (epoch seconds) está más de `SIGNED_AUTH_CLOCK_SKEW_SECONDS` segundos en el pasado o en el futuro respecto al reloj del servidor, THEN the system SHALL responder 401 con `error_code: "TIMESTAMP_EXPIRED"`.

### Back-compat

**AC-7 (bearer sigue funcionando sin firma)**
WHILE un token tiene `require_signature: false` o el campo está ausente/NULL, the system SHALL autenticar requests bearer existentes (master y session) sin requerir ningún header de firma, con comportamiento idéntico al pre-WKH-123.

**AC-8 (WKH-101 delegaciones no tocadas)**
WHILE el branch `wasi_a2a_session_*` (WKH-101) maneja el request, the system SHALL ignorar los headers `x-a2a-signature`/`x-a2a-nonce`/`x-a2a-timestamp` y NO aplicar ninguna lógica de WKH-123 (el signing de delegaciones EIP-712 es un scope futuro).

**AC-9 (modo firmado no activa sin `funding_wallet`)**
IF una master key tiene `require_signature: true` pero `funding_wallet` es NULL, THEN the system SHALL responder 403 con `error_code: "FUNDING_WALLET_NOT_BOUND"` (no puede usar EIP-712 sin ancla de firma).

### Ownership guard

**AC-10 (ownership en activación)**
WHEN el owner activa `require_signature` en una key o session key via endpoint de gestión, the system SHALL verificar que el `owner_ref` del caller coincide con el `owner_ref` del row antes de escribir, y responder 403 `OWNERSHIP_MISMATCH` si no coincide.

### Habilitación del signing secret (session keys)

**AC-11 (signing_secret generado server-side)**
WHEN se crea una session key con `require_signature: true` (flag en el `CreateKeySessionInput`), the system SHALL generar un `signing_secret` de 32 bytes aleatorios, persistir SOLO su SHA-256 (nunca el plano), y devolver el `signing_secret` plano una única vez en la respuesta 201 junto al `session_token`.

---

## Scope IN

- `src/middleware/a2a-key.ts` — detección de headers de firma + lógica de verificación en branch master y branch sess (WKH-121); NO tocar el branch `wasi_a2a_session_*` (WKH-101)
- `src/services/signed-auth.ts` — nuevo service: `verifyEip712RequestSignature`, `verifyHmacRequestSignature`, `checkNonceReplay`, `checkTimestamp`; EIP-712 domain para requests; anti-replay con Redis TTL
- `src/services/identity.ts` — método `setRequireSignature(keyId, ownerRef, value: boolean)` con ownership guard
- `src/services/key-session.ts` — extensión de `create` para `require_signature` flag + `signing_secret`; `setRequireSignature(sessionId, ownerRef, value: boolean)`
- `src/types/a2a-key.ts` — nuevos campos en `A2AAgentKeyRow` (`require_signature: boolean`) y `KeySessionRow` (`require_signature: boolean`, `signing_secret_hash: string | null`); nuevas interfaces `SignedAuthHeaders`, `SignedAuthResult`
- `src/routes/auth.ts` — endpoints `PATCH /auth/agent-key/:id/require-signature` y `PATCH /auth/key-session/:id/require-signature`; extensión de `POST /auth/key-session` para aceptar `require_signature` opcional
- `supabase/migrations/YYYYMMDD_wkh123_signed_auth.sql` — ALTER TABLE: `require_signature BOOLEAN DEFAULT false` en `a2a_agent_keys` y `a2a_key_sessions`; columna `signing_secret_hash TEXT NULL` en `a2a_key_sessions`; tabla `a2a_signed_auth_nonces (token_hash TEXT, nonce TEXT, expires_at TIMESTAMPTZ)` para anti-replay server-side
- `.env.example` — `SIGNED_AUTH_CLOCK_SKEW_SECONDS`, `SIGNED_AUTH_NONCE_TTL_SECONDS`, env vars del EIP-712 domain para requests (distintas del domain de delegaciones)
- Tests: `src/services/signed-auth.test.ts`, extensiones de `src/middleware/a2a-key.test.ts`, `src/routes/auth.signed-auth.test.ts`

---

## Scope OUT

- **WebAuthn / passkey**: requiere cliente browser + autenticador hardware/software; callers A2A son headless. HU futura (WKH-126 o similar).
- **Firma de delegaciones WKH-101** (`wasi_a2a_session_*`): esas delegaciones ya se crean con una firma EIP-712 del typed-data completo; extender ese branch es scope separado.
- **RLS Postgres** para `a2a_signed_auth_nonces` o `a2a_agent_keys`/`a2a_key_sessions`: trackeado en WKH-SEC-02, independiente.
- **Signing de delegaciones (WKH-101) per-request**: el modelo WKH-101 ya protege la creación con EIP-712; aplicarle también signing por request es TD futuro.
- **SDK client-side** para generar firmas desde lenguajes distintos a TypeScript: es documentación/tooling, no middleware.
- **On-chain ancla del nonce** (inmutabilidad Merkle-proof): diferido a WKH-124 (recibos inmutables).

---

## Decisiones técnicas (DT-N)

**DT-1: EIP-712 para master keys, HMAC-SHA256 para session keys (dos esquemas)**

La elección está guiada por el ancla disponible:
- Las master keys ya tienen `funding_wallet` (EOA) y `viem` (`recoverTypedDataAddress`) ya en el stack (WKH-101). EIP-712 encaja sin nueva infraestructura.
- Las session keys de WKH-121 nacieron *sin* wallet (ese fue su punto diferenciador). Obligar EIP-712 aquí significa obligar al caller a tener un EOA, rompiendo el propósito de WKH-121. HMAC-SHA256 con un `signing_secret` server-generated (devuelto al crear la sesión con `require_signature: true`) da la misma garantía anti-filtrado sin wallet.
- El `signing_secret` NUNCA se persiste plano; solo su SHA-256. El HMAC se computa sobre el cuerpo canónico del request (método + path + nonce + timestamp).

**DT-2: Dominio EIP-712 distinto del de delegaciones**

El domain de WKH-101 (`WasiAI-a2a Delegation`) firma una *policy*. El domain de WKH-123 firma un *request individual*. Usar el mismo domain abre replay cross-context. Nuevo domain: `WasiAI-a2a Request` con `version: "1"`, `chainId: KITE_CHAIN_ID`. Env vars distintas: `REQUEST_EIP712_NAME`, `REQUEST_EIP712_VERSION` (distintas de `DELEGATION_EIP712_NAME`).

**DT-3: Mensaje EIP-712 del request**

El typed-data firmado cubre: `{ token_hash: bytes32, method: string, path: string, nonce: bytes32, timestamp: uint64 }`. El `token_hash` es el SHA-256 del bearer token del caller (ya conocido por el server al hacer el lookup). Esto ata la firma a ESE token específico — incluso si el signer filtra la firma junto al token, ambos son necesarios juntos (y el nonce los hace de un solo uso).

**DT-4: Anti-replay con tabla Supabase (no Redis)**

El stack ya tiene Redis, pero los nonces necesitan persistir con TTL exacto y cruzarse con el `token_hash`. Una tabla `a2a_signed_auth_nonces` en Supabase con `expires_at` + job de limpieza (o TTL-based SELECT) evita una dependencia Redis adicional en el hot path de auth. Si el Redis está down, el auth sigue. [NEEDS CLARIFICATION: si se prefiere Redis SETEX para nonces por latencia, el Architect puede decidirlo en F2 — ambos son válidos; la tabla es el supuesto conservador].

**DT-5: Detección del modo firmado en el middleware**

El middleware detecta `require_signature` leyendo el row (ya cargado en el lookup del bearer). Si `require_signature === true` y hay headers `x-a2a-signature`/`x-a2a-nonce`/`x-a2a-timestamp` → rama de verificación. Si `require_signature === true` y NO hay headers → 401 SIGNATURE_REQUIRED. Si `require_signature === false` o NULL → flujo bearer intacto. El check ocurre DESPUÉS del lookup del token y ANTES del debit, en ambos branches (master y sess).

**DT-6: Ventana de clock skew y TTL de nonce configurables via env**

`SIGNED_AUTH_CLOCK_SKEW_SECONDS` (default 300, 5 min) y `SIGNED_AUTH_NONCE_TTL_SECONDS` (default 300, 5 min, debe ser >= clock_skew para que el nonce expire no antes de que el timestamp ya esté fuera de ventana). Fail-safe: valores NaN o <= 0 → default.

**DT-7: `signing_secret` de sesión devuelto una sola vez, hash persistido**

Patrón idéntico al `session_token` (WKH-121): el plano se devuelve en la 201 de `POST /auth/key-session`, el servidor persiste `signing_secret_hash = SHA-256(signing_secret)`. El HMAC se verifica computando `HMAC-SHA256(signing_secret_hash... )` — [NEEDS CLARIFICATION: el Architect debe definir en F2 si el HMAC se verifica con el hash del secret (deriver server-side) o si el secret plano se pide al caller en cada request; recomendación conservadora: el caller guarda el secret plano y lo usa para HMAC; el server verifica con el hash almacenado usando un HMAC derivado].

---

## Constraint Directives (CD-N)

**CD-1: BACK-COMPAT ABSOLUTA** — PROHIBIDO modificar el comportamiento de auth de cualquier token con `require_signature: false` o NULL. El bearer existente (master y sess) DEBE seguir funcionando sin headers de firma. Ningún caller actual debe ver un cambio de comportamiento hasta que opt-in.

**CD-2: NO TOCAR EL BRANCH WKH-101** — PROHIBIDO agregar lógica de WKH-123 (verificación de firma por request) al branch `wasi_a2a_session_*` de WKH-101. Ese branch puede recibir los headers `x-a2a-signature` en el request pero los IGNORA completamente.

**CD-3: ANTI-REPLAY OBLIGATORIO** — PROHIBIDO autenticar una firma válida si el nonce ya fue visto en el TTL de anti-replay, aunque la firma sea criptográficamente correcta. El check del nonce ocurre ANTES de retornar éxito al caller.

**CD-4: OWNERSHIP GUARD en todas las escrituras** — toda modificación a `require_signature` en `a2a_agent_keys` o `a2a_key_sessions` DEBE filtrar por `owner_ref` del caller autenticado (patrón CLAUDE.md / WKH-53). Firma `setRequireSignature(keyId: string, ownerRef: string, value: boolean)` — `ownerRef: string` ESTRICTO (no `string | undefined`).

**CD-5: SIGNING_SECRET plano NUNCA persistido ni logueado** — solo SHA-256 en DB. El log del server NUNCA debe incluir el `signing_secret` plano, el header `x-a2a-signature`, ni el bearer token en claro.

**CD-6: PROHIBIDO `any` ni `as unknown`** — TypeScript strict. Los tipos `SignedAuthHeaders`, `SignedAuthResult`, `SignedAuthNonceRow` deben ser interfaces tipadas completas.

**CD-7: PROHIBIDO ethers.js** — viem en todas las operaciones EIP-712 / crypto on-chain.

---

## Missing Inputs

- **[resuelto en F2]** Decisión final de almacenamiento anti-replay (Redis SETEX vs tabla Supabase): la tabla Supabase es el supuesto conservador del work-item; el Architect elige en F2 según latencia aceptable.
- **[resuelto en F2]** Canonical body del HMAC: el Architect define exactamente qué se firma (si se incluye el body del request HTTP, qué partes, encoding). El work-item define que MÍNIMO se firma `method + path + nonce + timestamp`; si agregar el body tiene valor, es decisión de F2.
- **[NEEDS CLARIFICATION — no bloquea]** ¿Activar `require_signature` vía endpoint PATCH separado o como campo en el PUT/PATCH de settings existente? El work-item asume PATCH dedicado (`/require-signature`) por menor superficie de cambio. Si hay un endpoint de settings existente que el humano prefiera extender, el Architect lo ajusta en F2.

---

## Análisis de paralelismo

- WKH-123 depende de WKH-121 (session keys, tabla `a2a_key_sessions`, branch `wasi_a2a_sess_*` en middleware) y WKH-122 (revocación) — ambos DONE y en main. No hay dependencia bloqueante pendiente.
- WKH-124 (recibos inmutables) y WKH-125 (constraints programables) son independientes y pueden ir en paralelo con WKH-123 si hay capacidad.
- WKH-123 NO debe ir en paralelo con ninguna HU que modifique `src/middleware/a2a-key.ts` o `src/types/a2a-key.ts` (riesgo de merge conflict en los mismos archivos).
- No bloquea ninguna HU downstream conocida; WKH-124 y WKH-125 tampoco dependen de WKH-123.
