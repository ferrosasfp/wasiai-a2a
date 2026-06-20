# Validation Report — WKH-123 KEY-SIGNED-AUTH (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-19
**Branch**: feat/112-wkh-123-signed-auth (uncommitted working tree sobre WKH-122)

---

## Runtime / Migration checks

- **Migración `20260604000000_wkh123_signed_auth.sql`** — existe con contenido correcto.
  - `ALTER TABLE a2a_agent_keys ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;`
  - `ALTER TABLE a2a_key_sessions ADD COLUMN IF NOT EXISTS require_signature BOOLEAN NOT NULL DEFAULT false;`
  - `ALTER TABLE a2a_key_sessions ADD COLUMN IF NOT EXISTS signing_secret_hash TEXT;` (NULL = sin secret)
  - `CREATE TABLE IF NOT EXISTS a2a_signed_auth_nonces (... CONSTRAINT uq_signed_auth_nonce UNIQUE (token_hash, nonce));`
  - `CREATE INDEX IF NOT EXISTS idx_signed_auth_nonces_expires ...`
  - Back-compat: `DEFAULT false` garantiza que filas existentes queden en bearer puro (AC-7, CD-1). Verificado texto vs spec story-file.md §SQL textual: match exacto.
- **`_down.sql`** — existe. Revierte tabla + 3 columnas con `DROP ... IF EXISTS`. Reversible (CD-12).
- **DB apply remota**: NO VERIFICABLE (implementación en working tree sin commit; el orquestador ejecuta la migración antes del merge). Nonces UNIQUE se verifican via INSERT atómico en código; constraint visible en `.sql` source.
- **Env vars `REQUEST_EIP712_*` / `SIGNED_AUTH_*`**: presentes en `.env.example` líneas 165-173. Código: `signed-auth.ts:60-63` (buildRequestDomain) y `:69-89` (fail-safe getters).

---

## AC Verification

| AC | Texto (EARS, resumido) | Status | Evidencia |
|----|------------------------|--------|-----------|
| AC-1 | Master key require_signature:true + headers + firma EIP-712 válida → autentica + debit normal | PASS | `a2a-key.test.ts:1736` "AC-1: master require_signature + valid signature → 200, debit proceeds". Mock `verifySignedAuth` → `{ok:true}`, assert `mockDebit.toHaveBeenCalledWith(TEST_KEY_ID, 2368, 1.0)`. Código: `a2a-key.ts:745-763` (check master branch). |
| AC-2 | Session key require_signature:true + headers + HMAC válido → autentica + debit normal | PASS | `a2a-key.test.ts:1772` "AC-2: session require_signature + valid HMAC → 200, atomic session debit". Assert `mockSessionDebit.toHaveBeenCalledTimes(1)` + `tokenHashHex: SESS_HASH, scheme: {kind:'hmac', signingSecretHash:'f'.repeat(64)}`. Código: `a2a-key.ts:541-562` (check sess branch). |
| AC-3 | require_signature:true sin x-a2a-signature → 401 SIGNATURE_REQUIRED | PASS | `a2a-key.test.ts:1802` (master) y `:1823` (sess). Assert `statusCode 401`, `error_code 'SIGNATURE_REQUIRED'`, `mockVerifySignedAuth not.toHaveBeenCalled()`, `mockDebit not.toHaveBeenCalled()`. Código: `a2a-key.ts:743-751` (master early-return) y `:541-547` (sess). |
| AC-4 | require_signature:true + firma inválida (EIP-712 recover ≠ wallet, o HMAC mismatch) → 401 SIGNATURE_INVALID | PASS | `a2a-key.test.ts:1846` (master EIP-712) y `:1870` (sess HMAC). `verifySignedAuth` → `{ok:false, code:'SIGNATURE_INVALID'}`. Debit no ocurre. Lógica real: `signed-auth.ts:374-388` (EIP-712 wrong wallet round-trip real) y `:252-266` (HMAC wrong key). |
| AC-5 | Nonce ya visto → 401 NONCE_REPLAY (aun con firma válida) | PASS | `a2a-key.test.ts:1896` "AC-5: replayed nonce → 401 NONCE_REPLAY, no debit". `verifySignedAuth` → `{ok:false, code:'NONCE_REPLAY'}`, `mockDebit not.toHaveBeenCalled()`. Lógica: `signed-auth.ts:297-310` (nonce check DESPUÉS de firma), `signed-auth.test.ts:390-405` (round-trip real: INSERT 23505 → NONCE_REPLAY con firma EIP-712 válida). |
| AC-6 | Timestamp fuera de ±SIGNED_AUTH_CLOCK_SKEW_SECONDS → 401 TIMESTAMP_EXPIRED | PASS | `a2a-key.test.ts:1918` "AC-6: timestamp out of window → 401 TIMESTAMP_EXPIRED, no debit". `signed-auth.test.ts:120-133` (checkTimestamp: now-(skew+1)→false, now+(skew+1)→false, NaN→false). Código: `signed-auth.ts:97-102`. |
| AC-7 | require_signature false/null → bearer idéntico al pre-WKH-123 (headers ignorados) | PASS | `a2a-key.test.ts:1943` (master, headers SIG_HEADERS presentes → ignorados) y `:1960` (sess). Assert `mockVerifySignedAuth not.toHaveBeenCalled()` + debit ocurre normal. Código: `a2a-key.ts:745` `if (keyRow.require_signature === true)` — guard estricto. |
| AC-8 | Branch WKH-101 (wasi_a2a_session_*) ignora headers x-a2a-* | PASS | `a2a-key.test.ts:1979` "AC-8: wasi_a2a_session_ with signature headers → branch processes WITHOUT verifySignedAuth". `mockVerifySignedAuth not.toHaveBeenCalled()`. Branch WKH-101 range 263-461 intacto (diff main: solo hunks L38/131/533/736 según AR). |
| AC-9 | Master require_signature:true + funding_wallet NULL → 403 FUNDING_WALLET_NOT_BOUND | PASS | `a2a-key.test.ts:1997` "AC-9: master require_signature + funding_wallet null → 403 FUNDING_WALLET_NOT_BOUND, no debit". También: `auth.signed-auth.test.ts:149` (PATCH sin funding_wallet → 400 en activación). Código: `signed-auth.ts:267-269` + `a2a-key.ts:758-762` (sendSignedAuthError → 403 para FUNDING_WALLET_NOT_BOUND). |
| AC-10 | Owner activa require_signature → verifica owner_ref antes de escribir; 403 OWNERSHIP_MISMATCH si no coincide | PASS | `auth.signed-auth.test.ts:164` (:id != callerKey.id → 403), `:181` (service OwnershipMismatchError → 403), `:246` (sess: SessionNotFoundError → 404 disclosure-safe). Código: `identity.ts:133-157` (UPDATE .eq('owner_ref') → 0 rows → OwnershipMismatchError), `key-session.ts:383-430` (idem + SigningSecretNotSetError). |
| AC-11 | Crear session con require_signature:true → signing_secret 32 bytes, persistir solo SHA-256, devolver plano una vez | PASS | `auth.signed-auth.test.ts:293` (POST → 201 con signing_secret), `:348` (GET list no expone signing_secret). `key-session.test.ts` (CD-5: assert que .insert arg NO tiene 'signing_secret', solo hash). Código: `key-session.ts:190-246` (randomBytes(32) → hash → INSERT solo hash → response con plano una vez). |

---

## Drift Detection

**Scope IN (10 archivos prod + 14 fixtures + 3 archivos test nuevos + 2 .sql + .env.example):**

- 10 archivos prod del Scope IN: todos modificados conforme a lo esperado (sin tocar files fuera del scope).
- 14 fixtures: fanout puramente mecánico (`require_signature: false` / `signing_secret_hash: null`). Verificado: diff de los 14 archivos contiene CERO líneas nuevas que no sean esas dos propiedades.
- `doc/jury-qa*.md` y `doc/agent-key-vs-passport.md` (untracked): son archivos pre-existentes no commitados, anteriores a WKH-123. No son scope drift de esta HU.
- `src/routes/compose.ts`, `src/services/budget.ts`, `src/services/compose.ts`, `src/services/orchestrate.ts`: diff vs main contiene cambios de WKH-121 (BLQ-ALTO-1 keySessionContext) no de WKH-123. La implementación WKH-123 no tocó estos archivos.

**Spec adherence (spot-check 4 puntos críticos):**
1. EIP-712 typed-data construido 100% server-side: `signed-auth.ts:130-148` — reconstruye domain+message desde lookup+headers. Caller solo aporta `signature`. (CD-9 OK)
2. HMAC: `clave = SHA-256(signing_secret) = signing_secret_hash`. Canonical `${tokenHash}\n${method}\n${path}\n${nonce}\n${timestamp}`. timingSafeEqual con check de longitud previo: `signed-auth.ts:178-193`. (CD-10 OK)
3. Anti-replay INSERT atómico UNIQUE(token_hash,nonce): `signed-auth.ts:214-220`. Error 23505 → false. Otro error → throw. (CD-3, DT-4 OK)
4. Orden de verificación CD-3: timestamp (L271) → firma (L277-305) → nonce (L307-311) → return ok. ANTES del debit. (CD-11 OK)

**Test drift:** NINGUNO — los 3 archivos de test nuevos (`signed-auth.test.ts`, `a2a-key.test.ts` extendido, `auth.signed-auth.test.ts`) existen y contienen los casos definidos en el Story File. Ningún test fue debilitado.

---

## Gates (confirmado de CR report)

- **tsc --noEmit**: 0 errores (confirmado por CR report + verificado en esta sesión: output "TypeScript compilation completed" sin errores).
- **vitest run (suite completa)**: 1487 passed / 3 skipped — confirmado por CR report y re-verificado: `1487 passed | 3 skipped (1490)`.
- **biome lint**: clean (confirmado por CR report: "biome clean (7 files)"). Auto-blindaje documenta que format → lint es el orden correcto y se aplicó.

---

## AR/CR follow-up

**BLOQUEANTEs**: 0. El ataque cripto resistió en todos los vectores (9 ataques simulados, todos PREVENIDOS).

**MENORs — aceptados como TD:**

| ID | Tipo | Archivo:línea | Descripción | Decisión |
|----|------|---------------|-------------|----------|
| MNR-1 (AR) / MNR-1 (CR) | Test Coverage / DRY | `a2a-key.ts` branch sess ~L536-546 y master ~L742-752 | Preámbulo signature-required duplicado en ambas branches (extractSignedHeaders + early-return). No hay e2e cripto real a través del middleware; el round-trip vive en `signed-auth.test.ts`. | Aceptado como TD. Backlog: helper `enforceSignedAuth` + 1 e2e test cripto post-merge. |
| MNR-2 (CR) | Dead code | `errors.ts:337, 346, 355, 364` | 4 clases (`SignatureRequiredError`, `SignatureInvalidError`, `NonceReplayError`, `TimestampExpiredError`) nunca instanciadas (el flujo usa `SignedAuthResult` discriminado). Solo `SigningSecretNotSetError:373` se usa en el route. | Aceptado. El Story File W0.2 las pidió por completitud. No rompen nada (tsc/lint pasan). |
| MNR-3 (AR) | Security/Design | `signed-auth.ts:182` | `signing_secret_hash` ES la HMAC key → dump de DB permite forjar firmas HMAC. Propiedad inherente de HMAC simétrico, documentada en el SDD (DT-7) y en el AR. Modelo de amenaza cubierto por WKH-123 es token filtrado en tránsito/logs, NO DB comprometida (WKH-SEC-02). | Aceptado. TD: pepper de env post-WKH-SEC-02. |

**CD-5 verificado en código**: `signed-auth.ts` tiene CERO líneas de logging (grep cero resultados). Routes loguean solo `errorClass` (constructor name). Middleware loguea solo `err.message` + `keyId`. `signing_secret_hash` en el middleware solo aparece como argumento a `verifySignedAuth`, nunca en logs.

**Ownership guard**: `identity.ts:138-156` y `key-session.ts:388-430` usan `.eq('id').eq('owner_ref')` — ambos con `ownerRef: string` estricto (no `string | undefined`). `auth.ts:1263` defiende `:id === callerKey.id` (defense-in-depth, AC-10).

---

**Listo para DONE.**
