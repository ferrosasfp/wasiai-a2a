# Adversarial Review (AR) — WKH-123 KEY-SIGNED-AUTH

> HU: #112 — KEY-SIGNED-AUTH (EIP-712 master + HMAC-SHA256 session, per-request signature opt-in)
> Branch: `feat/112-wkh-123-signed-auth` (working tree sobre HEAD = merge WKH-122)
> Revisor: nexus-adversary
> Fecha: 2026-06-19
> Suite: **1487 passed / 3 skipped** · `tsc --noEmit` 0 errores · biome clean (7 files)

---

## Resumen ejecutivo

**VEREDICTO: APROBADO.**

Esta es la HU más sensible de seguridad de la épica (auth + cripto) y la implementación
resiste el ataque. Se intentó: bypass de firma (header faltante/vacío/null), confianza en
typed-data del caller, comparación no-constante de HMAC, replay (TOCTOU + cross-context),
desactivación cross-tenant de `require_signature`, leak de secretos en logs, y tocar el
branch WKH-101. **Ninguno prosperó.** El orden de verificación CD-3/CD-11 (timestamp → firma
→ nonce → debit) está correcto en ambos branches; el anti-replay es atómico por
UNIQUE(token_hash,nonce) sin ventana TOCTOU; el HMAC usa `timingSafeEqual` con check de
longitud previo; el typed-data EIP-712 se construye 100% server-side; el domain es distinto
del de delegaciones (no hay cross-protocol replay); WKH-101 quedó byte-idéntico.

0 BLOQUEANTES. 3 MENORs (deuda/observaciones de diseño documentadas en contrato, ninguna
rompe un AC).

---

## Ataques cripto-específicos (resultado del PoC mental)

| # | Vector de ataque | PoC mental | Resultado |
|---|------------------|------------|-----------|
| 1 | **Bypass de firma** (token `require_signature:true` sin firma) | enviar request sin `x-a2a-signature` | **PREVENIDO** — `a2a-key.ts:745-752` (master) y `:541-548` (sess): `if (require_signature === true)` exige `signature` no-vacía → 401 SIGNATURE_REQUIRED, `verifySignedAuth` ni siquiera se invoca, debit NO ocurre. Check estricto `=== true` (col `BOOLEAN NOT NULL`). |
| 1b | **Header presente pero nonce/timestamp ausente** | firma sí, nonce/ts no | **PREVENIDO (fail-closed)** — `signed-auth.ts:255-264` completeness check → SIGNATURE_REQUIRED antes de cualquier verificación. |
| 2 | **EIP-712: caller manda typed-data** (CD-9) | inyectar `typed_data` arbitrario | **PREVENIDO** — el middleware NO lee `request.body`; `verifyEip712RequestSignature` reconstruye domain+message desde lookup+headers (`signed-auth.ts:130-148`). El caller solo aporta `signature`. |
| 2b | **EIP-712 recover comparison** | recover ≠ funding_wallet | **CORRECTO** — `signed-auth.ts:149` `recovered.toLowerCase() === fundingWallet.toLowerCase()` (case-insensitive). `token_hash` como `0x${hash}` bytes32 (`:141`); nonce validado `/^0x[0-9a-fA-F]{64}$/` (`:126`) o → false. |
| 3 | **HMAC: comparación no-constante** (CD-10) | timing attack sobre la firma | **PREVENIDO** — `signed-auth.ts:193` `timingSafeEqual(expected, provided)`; check de longitud previo (`:192`) evita throw; validación hex 64-char ANTES de `Buffer.from` (`:178-179`); `Buffer.from` envuelto en try/catch (`:186-190`). Cero `===` sobre firmas. Key = `signing_secret_hash` (= SHA-256(secret)) según contrato. |
| 3b | **HMAC canonical injection** (nonce con `\n`) | nonce malicioso que reordene canonical | **NO EXPLOTABLE** — el atacante igual debe producir HMAC válido sobre el canonical resultante, lo que requiere el secret. Server y caller firman el MISMO string (mismo orden/separadores). |
| 4 | **Anti-replay TOCTOU** | 2 requests concurrentes, mismo nonce | **PREVENIDO** — `checkAndRecordNonce` (`signed-auth.ts:206-223`) es un único INSERT atómico con `UNIQUE(token_hash,nonce)`; NO hay SELECT-then-INSERT. Exactamente uno gana (true), el otro recibe `23505` → false → NONCE_REPLAY. Nonce scopeado al `token_hash` (no global). Se registra DESPUÉS de firma+timestamp y ANTES de retornar éxito → antes del debit. |
| 4b | **Timestamp fuera de ventana** | ts viejo/futuro | **CORRECTO** — `checkTimestamp` (`:97-102`) `Math.abs(now-ts) <= clockSkew`; NaN/no-entero → false (expirado). Verificado ANTES de la firma (orden CD-3). |
| 5 | **Replay cross-context** (firma de delegación reusada como request) | reusar sig WKH-101 | **PREVENIDO** — domain `WasiAI-a2a Request` (`signed-auth.ts:60`) ≠ `WasiAI-a2a Delegation` (`delegation.ts:51`); además los `types` difieren por completo → distinto EIP-712 typeHash/domainSeparator. HMAC incluye `method`+`path` en el canonical → firma de un endpoint no sirve en otro. |
| 6 | **Bypass-inverso / desactivar require_signature ajeno** | flippear flag de otro owner | **PREVENIDO** — `identity.setRequireSignature` (`identity.ts`) y `keySession.setRequireSignature` (`key-session.ts`) hacen UPDATE `.eq('id').eq('owner_ref')`; 0 rows → OwnershipMismatch/SessionNotFound. Master PATCH además exige `:id === callerKey.id` (`auth.ts:1267`). `ownerRef: string` estricto. |
| 7 | **Tocar WKH-101** (CD-2) | — | **PREVENIDO** — `git diff` muestra hunks SOLO en L38/131/533/736; rango 263-461 byte-idéntico. Test AC-8 confirma que un `wasi_a2a_session_` con headers de firma NO invoca `verifySignedAuth`. |
| 8 | **Leak de secretos** | secret/firma/bearer en log/response | **PREVENIDO** — `signed-auth.ts` tiene CERO logging; routes loguean solo `errorClass` (constructor name); middleware loguea solo `err.message`+`keyId`. INSERT de sesión lleva SOLO `signing_secret_hash` (test CD-5 asserta `not.toHaveProperty('signing_secret')` + hash === SHA-256(plano)). |
| 9 | **Ownership / IDOR** | leer/flippear key ajena | **PREVENIDO** — patrón Ownership Guard (WKH-53) aplicado; disclosure-safe 404 en sesiones; 403 en master. |

---

## 11 Categorías de Ataque

### 1. Security — **OK**
Auth bypass cerrado en ambos branches; check estricto `require_signature === true`; firma exigida pre-debit;
ownership guard en los 2 PATCH; sub-session tokens prohibidos como autenticadores de los PATCH
(`auth.ts:1250-1253` master, `:1318-1321` sess). EIP-712 server-built (CD-9). HMAC tiempo-constante (CD-10).
Domain anti cross-protocol. Sin secrets en código.

### 2. Error Handling — **OK**
`verifyEip712RequestSignature` y `verifyHmacRequestSignature` NUNCA throw (try/catch → false). DB error del
nonce (≠23505) → throw → 503 (no swallow). Routes mapean error-class → status; fallback 500
`REQUIRE_SIGNATURE_FAILED` sin leak. Middleware outer-catch → 503.

### 3. Data Integrity — **OK**
Anti-replay atómico (UNIQUE, 23505) sin TOCTOU. Orden timestamp→firma→nonce→debit garantizado (CD-11). Nonce
consumido solo tras firma+timestamp válidos. Debit jamás ocurre si la firma falla (asserts `mockDebit/mockSessionDebit not.toHaveBeenCalled` en AC-3/4/5/6/9).

### 4. Performance — **OK**
Hot path añade: 1 regex + 1 recover (EIP-712) o 1 HMAC (cheap) + 1 INSERT (nonce). Sin N+1, sin loops. `require_signature:false` → cero overhead (no se invoca el service). Limpieza de nonces expirados diferida (índice `expires_at`, MVP) — aceptable.

### 5. Integration — **OK**
Back-compat absoluta (CD-1): tests AC-7 master+sess confirman bearer idéntico con headers de firma IGNORADOS. Firma de `budgetService.debit` / `lookupByTokenHash` sin cambios. Migración aditiva.

### 6. Type Safety — **OK**
`tsc --noEmit` 0 errores en strict. Sin `any`/`as unknown` injustificado en código nuevo (los `as 0x${string}` son casts de branding viem, correctos). Discriminated union `SignedAuthResult`. `ownerRef: string` estricto. Casts en tests son `as unknown as ReturnType<...>` para mocks (test-only, aceptado).

### 7. Test Coverage — **OK**
140 tests WKH-123 verdes. Crypto real (privateKeyToAccount+signTypedData, createHmac) en `signed-auth.test.ts`. Middleware testea wiring con servicio mockeado, pero asserta args exactos (`tokenHashHex/method/path/scheme`) y mapeo de error_codes + no-debit. 11 ACs cubiertos. (Ver MNR-1.)

### 8. Scope Drift — **OK (mecánico, sin riesgo)**
14 fixtures fuera del Scope IN tocados: cada uno +1 línea exclusivamente `require_signature: false` / `signing_secret_hash: null` (required-field fanout documentado en auto-blindaje). `git diff` confirma cero cambios de lógica/asserts. No introduce riesgo. (Ver MNR-2.)

### 9. Destructive Migrations — **OK**
`20260604000000` aditiva: `ADD COLUMN IF NOT EXISTS ... DEFAULT false` (sin NOT NULL sobre data sin default — el default está), CREATE TABLE/INDEX IF NOT EXISTS. `_down.sql` reversible (DROP de lo nuevo). Sin DROP/ALTER TYPE/UPDATE masivo sobre data existente. Filas existentes → `require_signature=false` (back-compat).

### 10. RPC con SECURITY DEFINER — **N/A**
La HU no crea ninguna función Postgres. El INSERT/SELECT de nonces lo hace el service con service-role (igual que el resto). Sin SQL dinámico. (El contrato lo declara explícitamente.)

### 11. Cache Invalidation Logic — **N/A**
No se introduce capa de cache nueva. El "anti-replay" es una tabla durable, no un cache; su semántica (single-use por token_hash) es correcta y no tiene problema de cache-key cross-tenant (el key es `(token_hash,nonce)`, token_hash deriva del bearer del caller).

---

## Findings

### MNR-1 — [Test Coverage] No hay integration test con firma cripto REAL a través del middleware
- **Archivo**: `src/middleware/a2a-key.test.ts:65` (`vi.mock('../services/signed-auth.js')`)
- **Descripción**: el middleware mockea `verifySignedAuth`, así que ningún test recorre una firma EIP-712/HMAC real *a través del preHandler*. El round-trip cripto real vive aislado en `signed-auth.test.ts`. El acoplamiento middleware→service se cubre por `toHaveBeenCalledWith` (args exactos), por lo que un drift de contrato SÍ se detecta. Riesgo residual: un bug puramente en el cableado (que no cambie la forma del arg) podría escapar.
- **Impacto**: bajo — el split unit(crypto)+wiring(mock) es un patrón legítimo y los args están asertados. No rompe ningún AC.
- **Sugerencia**: opcional, post-merge — 1 test e2e que firme con `privateKeyToAccount` y pase por el middleware real (sin mock del service) para master y sess. Backlog, no bloqueante.

### MNR-2 — [Scope Drift] Required-field fanout a 14 fixtures (deuda: fixture helper)
- **Archivo**: 12 `*.test.ts` + `src/__tests__/e2e/setup.ts` + `erc8004-identity-bridge.e2e.test.ts` (+1 línea c/u)
- **Descripción**: agregar `require_signature` como campo requerido obligó a editar cada fixture que materializa `A2AAgentKeyRow`/`KeySessionRow`. Mecánico y verificado seguro (diff = solo el campo nuevo), pero confirma la deuda ya anotada en auto-blindaje.
- **Impacto**: ninguno funcional; mantenibilidad.
- **Sugerencia**: helper fixture compartido (`makeAgentKeyRow`) en una HU futura. Ya trackeado como TD potencial en auto-blindaje.

### MNR-3 — [Security / Design] El `signing_secret_hash` ES la clave HMAC (compromiso de DB = forja de sesión)
- **Archivo**: `src/services/signed-auth.ts:182` + contrato §HMAC
- **Descripción**: para session keys, la clave HMAC es `signing_secret_hash` (= SHA-256(secret)), el MISMO valor almacenado en DB. A diferencia del master (donde el ancla es un address público y un dump de DB NO permite firmar), un lector de `a2a_key_sessions.signing_secret_hash` puede forjar firmas HMAC válidas para esa sesión. Es una propiedad inherente de HMAC simétrico y está DOCUMENTADA en el contrato (decisión de Architect, MVP).
- **Impacto**: equivalente al modelo bearer actual (un dump de DB ya expone material sensible); no es una regresión ni rompe un AC. No bloqueante.
- **Sugerencia**: documentar el threat-model explícitamente y considerar (TD futuro) derivar la HMAC key con un pepper de env (`HMAC(server_pepper, signing_secret_hash)`) para que el dump de DB por sí solo no baste. Fuera de scope de esta HU.

---

## Constraint Directives — verificación

| CD | Estado | Evidencia |
|----|--------|-----------|
| CD-1 back-compat absoluta | OK | AC-7 master+sess: `verifySignedAuth not.toHaveBeenCalled`, debit ocurre |
| CD-2 NO tocar WKH-101 | OK | diff hunks solo L38/131/533/736; 263-461 intacto; AC-8 verde |
| CD-3 anti-replay, orden ts→firma→nonce | OK | `signed-auth.ts:271-311` |
| CD-4 ownership guard estricto | OK | `identity/key-session.setRequireSignature` `.eq('owner_ref')`, `ownerRef:string` |
| CD-5 secret nunca persistido/logueado | OK | test CD-5 + grep logs limpio |
| CD-6 sin any/as unknown | OK | tsc strict 0 |
| CD-7 prohibido ethers | OK | `viem` recoverTypedDataAddress + `node:crypto` |
| CD-8 no firmar body | OK | middleware no lee `request.body` |
| CD-9 server construye typed-data | OK | `signed-auth.ts:130-148` |
| CD-10 HMAC timingSafeEqual | OK | `signed-auth.ts:192-193` |
| CD-11 firma post-lookup pre-debit | OK | `a2a-key.ts:536-562` sess, `:739-763` master |
| CD-12 migración aditiva/reversible | OK | `.sql` + `_down.sql` |

---

## Veredicto final

**APROBADO** (con 3 MENORs documentados, ninguno bloquea DONE).

- BLOQUEANTES: **0**
- MENORs: **3** (MNR-1 test e2e cripto opcional, MNR-2 fixture helper deuda, MNR-3 threat-model HMAC documentado)
- 11 ACs cubiertos por al menos un test cada uno; suite 1487 verde; tsc 0; lint clean; WKH-101/121/122 intactos.

El gate NO se bloquea. Se recomienda pasar a CR/F4. Los MENORs pueden ir a backlog.
