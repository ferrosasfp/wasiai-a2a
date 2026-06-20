# Code Review (CR) — WKH-123 KEY-SIGNED-AUTH

> Agente: nexus-adversary (CR / calidad). Corrido EN PARALELO con AR.
> Fecha: 2026-06-19 · Branch: `feat/112-wkh-123-signed-auth`
> Story File: `doc/sdd/112-wkh-123-signed-auth/story-file.md`
> Estado del trabajo: uncommitted en working tree (verificado con `git status`).

## Alcance revisado

- `src/services/signed-auth.ts` (nuevo, 315 L)
- `src/middleware/a2a-key.ts` (+85 L, 0 borradas)
- `src/services/identity.ts`, `src/services/key-session.ts`
- `src/services/security/errors.ts`, `src/types/a2a-key.ts`, `src/types/index.ts`
- `src/routes/auth.ts` (+141 L)
- `src/services/signed-auth.test.ts`, `src/routes/auth.signed-auth.test.ts`, `src/middleware/a2a-key.test.ts`, `src/services/key-session.test.ts`
- migración `20260604000000_*` (.sql + _down.sql)
- 14 fixtures de tests adyacentes (+1 línea c/u)

Verificaciones ejecutadas:
- `npx tsc --noEmit` → 0 errores.
- `vitest run signed-auth.test.ts auth.signed-auth.test.ts` → 41 PASS / 0 FAIL.
- `vitest run a2a-key.test.ts key-session.test.ts` → 99 PASS / 0 FAIL.

---

## Check 1 — Naming consistency → OK

- `buildRequestDomain` espeja `delegation.ts:buildDomain`; `REQUEST_TYPES` espeja `DELEGATION_TYPES` (`as const`, sin `EIP712Domain` en `types`).
- `verifyEip712RequestSignature` / `verifyHmacRequestSignature` / `checkAndRecordNonce` / `verifySignedAuth`: nombres descriptivos y consistentes con el verbo del servicio.
- `verifyHmacRequestSignature` replica fielmente `transform-hmac.ts:verifyTransformFn` (regex hex previa, check de longitud antes de `timingSafeEqual`, `Buffer.from` en try/catch).
- Error codes (`SIGNATURE_REQUIRED`/`SIGNATURE_INVALID`/`NONCE_REPLAY`/`TIMESTAMP_EXPIRED`/`FUNDING_WALLET_NOT_BOUND`) consistentes entre el union `SignedAuthErrorCode` (`a2a-key.ts:359`), las error classes (`errors.ts:337-380`) y los `error_code` de respuesta del middleware/rutas.
- Tipos claros: `SignedAuthResult` discriminado, `SignedAuthHeaders`, `RequestEip712Domain` bien nombrados.

## Check 2 — Complejidad → OK

- `verifySignedAuth` (`signed-auth.ts:242-314`): orquestador lineal, ~70 L incluyendo el JSDoc; el cuerpo ejecutable es una secuencia plana de guardas (completitud → funding_wallet → timestamp → firma → nonce). Ciclomática baja, sin nesting profundo. Legible.
- Inserts del middleware (`a2a-key.ts` branch sess ~L533 y branch master ~L736): ~28 L cada uno, guardados por `if (require_signature === true)`. El bloque nuevo NO altera el flujo bearer (diff puramente aditivo: +85/-0). El branch WKH-101 (263-461) quedó intacto (verificado: 0 líneas tocadas en ese rango).
- Ninguna función nueva supera 50 L de lógica. El middleware ya largo no se volvió inmanejable: el grueso se delegó al service y a 2 helpers (`sendSignedAuthError`, `extractSignedHeaders`).

## Check 3 — DRY → MNR-1 (ver abajo)

- Reuso correcto de `recoverTypedDataAddress` (viem), del patrón `transform-hmac.ts`, de `logOwnershipMismatch`, del gate de sub-sesión (`rawKeyFromRequest` + `.startsWith`), y del lookup de token (`keyHash`/`hash` ya computados — no se re-hashea).
- El check de firma se factorizó bien: el grueso vive en `verifySignedAuth`; las dos branches del middleware solo difieren en `scheme` (eip712 vs hmac) y la var de token_hash.
- **Duplicación menor**: el preámbulo "extraer headers + cortar 401 SIGNATURE_REQUIRED si falta signature" está copiado literal en las dos branches del middleware (sess ~L536-546 y master ~L742-752). Ver MNR-1. No bloqueante.

## Check 4 — SOLID (lente pragmática) → OK

- `signed-auth.ts` está desacoplado del transporte: las funciones reciben PRIMITIVOS (`method`, `path`, `headers` planos, `tokenHashHex`), NO el `request` de Fastify (documentado en el header del archivo y respetado). El mapeo a HTTP vive en el middleware (`sendSignedAuthError`). Buena separación service/transporte.
- Discriminated union `SignedAuthResult` mantiene al service ignorante de status codes.

## Check 5 — Tests → OK

- **EIP-712 round-trip REAL**: `signed-auth.test.ts:69-86,174-187` firma con `privateKeyToAccount(TEST_PK).signTypedData(...)` y verifica que recupera `account.address`. No es un mock — firma criptográfica de verdad.
- **HMAC**: `signHmac` deriva `key = sha256(secret)` igual que el server (`:88-98`), test válido + wrong-key + malformed.
- **Nonce replay**: el service unit test mockea `insert` → `{code:'23505'}` y verifica `NONCE_REPLAY` con firma VÁLIDA (`:390-405`); el middleware test verifica `error_code NONCE_REPLAY` + `expect(mockDebit).not.toHaveBeenCalled()` (`a2a-key.test.ts:1896-1915`).
- **Cobertura de los 11 ACs**: AC-1..AC-9 en `a2a-key.test.ts` (master+sess, back-compat AC-7, WKH-101 ignora AC-8); AC-10/AC-11 en `auth.signed-auth.test.ts` (ownership 403/404, INVALID_INPUT, FUNDING_WALLET_NOT_BOUND, SIGNING_SECRET_NOT_SET, 201 con `signing_secret` una vez, **y el negativo crítico "GET list NEVER exposes signing_secret"**).
- Asserts significativos: `not.toHaveBeenCalled()` sobre debit, `toEqual({ok:false, code:...})` exacto, regex sobre el `signing_secret` de la 201.
- Nombres descriptivos; `beforeEach` limpia mocks y env (`delete process.env.X` para casos de ausencia — patrón correcto).

## Check 6 — Documentación inline → OK

- Header de `signed-auth.ts:1-22` explica los 2 esquemas, el anclaje, el orden timestamp→firma→nonce, y el contrato de primitivos.
- Reconstrucción server-side del typed-data documentada (`:106-113`, CD-9). Derivación HMAC key documentada (`:157-164`). Separador canonical documentado (`:181`). Orden de verificación documentado en `verifySignedAuth` (`:227-241`). Distinto domain para evitar cross-protocol reuse documentado (`:44-46`).
- Middleware: comentarios `3b.`/`5b.` explican dónde se insertó el check (después de is_active, antes del debit, CD-11) y la back-compat.

## Fanout de 14 fixtures → OK (ruido aceptable)

Cada archivo de test adyacente suma exactamente **1 línea** (`require_signature: false`) a su fixture de row, requerido porque `A2AAgentKeyRow`/`KeySessionRow` ahora tienen el campo obligatorio. Es el costo mecánico mínimo de un campo no-nullable nuevo; no introduce lógica ni ensucia. Aceptable.

---

## Findings

### MNR-1 — Duplicación del preámbulo signature-required en las dos branches del middleware
- **Categoría**: DRY
- **Archivo:línea**: `src/middleware/a2a-key.ts` branch sess (~L536-546) y branch master (~L742-752).
- **Descripción**: el bloque `extractSignedHeaders(request)` + `if (!signature) return 401 SIGNATURE_REQUIRED` + el `await verifySignedAuth({... scheme})` + `if (!signedResult.ok) sendSignedAuthError(...)` está copiado casi literal en ambas branches; solo cambian `tokenHashHex` (`hash` vs `keyHash`) y `scheme`. Podría extraerse a un helper `enforceSignedAuth(request, reply, tokenHash, scheme)` que devuelva `reply | null`.
- **Reproducción**: comparar los dos rangos — ~22 L casi idénticas.
- **Impacto**: bajo. Si en el futuro cambia el contrato del check (p.ej. agregar un header), hay que tocar 2 sitios → riesgo de drift. Hoy no rompe nada y la simetría está documentada como intencional (Exemplar 7).
- **Sugerencia**: opcional — extraer helper. No bloquea DONE. Backlog aceptable.

### MNR-2 — 4 error classes nuevas son dead code (nunca instanciadas)
- **Categoría**: Naming / deuda técnica
- **Archivo:línea**: `src/services/security/errors.ts:337` (`SignatureRequiredError`), `:346` (`SignatureInvalidError`), `:355` (`NonceReplayError`), `:364` (`TimestampExpiredError`).
- **Descripción**: el path de auth eligió (correctamente) el `SignedAuthResult` discriminado con `error_code` strings; el middleware NUNCA hace `throw new SignatureRequiredError()` etc. `grep -rn "new SignatureRequiredError|new SignatureInvalidError|new NonceReplayError|new TimestampExpiredError" src/` → 0 resultados. Solo `SigningSecretNotSetError` (`:373`) se usa (route layer). Las 4 clases quedaron definidas "por completitud" pero no se referencian.
- **Reproducción**: `grep -rn "new SignatureRequiredError\|new SignatureInvalidError\|new NonceReplayError\|new TimestampExpiredError" src/` → vacío.
- **Impacto**: bajo. Son ~28 L de código muerto. No rompen nada (tsc/lint pasan), pero confunden al próximo lector: parece que el flujo lanza esas clases cuando en realidad usa el union. El Story File (W0.2) las pidió explícitamente, así que NO es scope drift — es una decisión del contrato que terminó sin consumidor.
- **Sugerencia**: o bien removerlas (si el union es la fuente única de verdad), o documentar en el header del bloque que existen como referencia/futuro mapeo. Decisión del Dev/Architect. No bloquea DONE.

---

## Categorías sin hallazgos

| Check | Veredicto |
|-------|-----------|
| 1. Naming consistency | OK |
| 2. Complejidad | OK |
| 3. DRY | OK (1 MNR) |
| 4. SOLID | OK |
| 5. Tests | OK |
| 6. Documentación inline | OK |
| Fanout 14 fixtures | OK (ruido aceptable) |

---

## Nota cruzada AR (no es finding de CR)

Observaciones de seguridad/cripto que el orquestador debe deduplicar con AR (NO las clasifico yo, son territorio AR):
- `verifySignedAuth` registra el nonce DESPUÉS de validar firma+timestamp (orden CD-3 correcto); el INSERT con UNIQUE(token_hash,nonce) da atomicidad. AR debe confirmar el caso de carrera concurrente (dos requests mismo nonce simultáneos) — el UNIQUE lo cubre, pero AR valida.
- `extractSignedHeaders` / logs: verificado que firma/nonce/bearer/secret NO aparecen en `reply` ni en `fastify.log.error` (solo `errorClass`/`err.constructor.name`). CD-5 respetado a nivel código — AR confirma.
- HMAC con `timingSafeEqual` + check de longitud previo; cero `===` sobre firmas. EIP-712 vía viem, cero ethers. Todo CD-cumplido a nivel CR; la explotabilidad la cierra AR.

---

## Veredicto CR

**APROBADO con MENORs**

- 0 BLOQUEANTES.
- 2 MENORs (MNR-1 duplicación DRY, MNR-2 dead code de 4 error classes). Ninguno bloquea DONE; se documentan para backlog o fix opcional a criterio del Dev/Architect.
- tsc 0, lint-clean (tsc pasó), suite verde (140 tests de los archivos tocados PASS), back-compat y WKH-101 intactos.

El gate de CR NO se bloquea (no hay BLOQUEANTEs). Pasa a F4/QA.
