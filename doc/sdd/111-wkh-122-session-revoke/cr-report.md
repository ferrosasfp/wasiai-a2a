# Code Review (CR) — WKH-122: Revocación granular de session keys

> Agente: nexus-adversary (modo CR — calidad de código)
> Fecha: 2026-06-19
> Branch: feat/111-wkh-122-session-revoke (cambios en working tree, no commiteados)
> Input: story-file.md + working-tree diff (errors.ts, key-session.ts, auth.ts, 3 test files)
> NOTA: corre en paralelo con AR. Findings de seguridad/integridad (ownership guard, IDOR,
> disclosure-safe 404) son territorio AR — referenciados acá pero no re-listados como CR.

---

## Archivos revisados

| Archivo | Tipo | Estado |
|---------|------|--------|
| `src/services/security/errors.ts` | productivo | +9 (clase `SessionNotFoundError`) |
| `src/services/key-session.ts` | productivo | +31 (método `revoke`) |
| `src/routes/auth.ts` | productivo | +48 (`DELETE /key-session/:id`) |
| `src/services/key-session.test.ts` | test | +56 (3 tests de `revoke`) |
| `src/routes/auth.key-session.test.ts` | test (NUEVO) | 174 L (4 tests de ruta) |
| `src/middleware/a2a-key.test.ts` | test | +4 (anotación AC-2) |

Verificaciones ejecutadas:
- `npx tsc --noEmit` → 0 errores.
- `npx vitest run` (key-session.test + auth.key-session.test + a2a-key.test) → PASS 86 / FAIL 0.

---

## Check 1 — Naming consistency · OK

- `keySessionService.revoke(sessionId, ownerId)` espeja exactamente `delegationService.revoke(delegationId, ownerRef)`
  (`delegation.ts:351`). Mismo verbo, misma aridad, misma posición (entre `list` y `debitSessionAndParent`).
- `SessionNotFoundError` (`errors.ts:319-325`) sigue el molde idéntico de las otras `Session*Error`
  (`SessionNotAllowedError` `errors.ts:313`, `SessionBudgetExhaustedError` `errors.ts:304`):
  `readonly code = '...' as const` + `constructor` con `super(msg)` + `this.name`. Consistente.
- Nombres de test descriptivos y trazables a AC (`T-REVOKE-OK (AC-1/AC-7)`, `T-SVC-OWNERSHIP`,
  `T-NOTFOUND-SVC (AC-3)`, etc.). Espeja la convención de `auth.delegation.test.ts`.

## Check 2 — Complejidad · OK

- `revoke` (service): 1 query, 2 guards lineales (`if (error)`, `if (!data || length===0)`). ~17 L. Ciclomática trivial.
- Handler `DELETE /key-session/:id` (`auth.ts:1182-1221`): gate → auth → try/catch lineal. ~40 L incluido el JSDoc.
  Un solo `try`, un solo `instanceof` branch + fallback. Sin anidamiento profundo. Bajo el umbral de 50 L de lógica.
- Ningún método nuevo supera complejidad razonable.

## Check 3 — DRY · OK

- `revoke` reusa el cliente `supabase` ya importado, `logOwnershipMismatch` (forma objeto), el patrón
  exacto del exemplar de delegación. No duplica helpers.
- El handler reusa `rawKeyFromRequest`, `KEY_SESSION_TOKEN_PREFIX` (constante, NO literal hardcodeado),
  `SessionNotAllowedError`, `resolveCallerKey` — todos preexistentes. El gate de sub-sesión es copia
  intencional y mínima del patrón de `POST /key-session` (CD-5), justificada por el contrato.
- Sin refactors ni "mejoras" de código adyacente (respeta CD "NO mejorar código adyacente").

## Check 4 — SOLID (lente pragmática) · OK

- SRP: `revoke` hace una sola cosa (UPDATE owner-guarded + mapeo de 0-rows a error de dominio).
  El handler solo orquesta (gate, auth, delega, mapea HTTP). Separación service/route limpia.
- El mapeo `instanceof SessionNotFoundError → 404` mantiene el error de dominio desacoplado del transporte HTTP
  (el service no conoce status codes). Correcto.
- Nada que romper conscientemente acá; la HU es deliberadamente pequeña y espeja un patrón probado.

## Check 5 — Tests · OK (con 1 MENOR)

Cobertura de los 7 ACs verificada:
- AC-1/AC-7: `T-REVOKE-OK` (ruta, 200 + `revoke('sess-1','user-1')`) + `T-SVC-OWNERSHIP` (service: asserts
  `chain.eq('id',...)` Y `chain.eq('owner_ref',...)` — el doble `.eq` SÍ se verifica de verdad). 
- AC-2: anotación del test existente `a2a-key.test.ts` (revoked → 403 SESSION_TOKEN_INVALID). Lógica intacta. 
- AC-3: `T-NOTFOUND-ROUTE` (404 SESSION_NOT_FOUND) + `T-NOTFOUND-SVC` (0 rows → `SessionNotFoundError`,
  y además assert `not.toBeInstanceOf(OwnershipMismatchError)` que blinda la divergencia CD-6). Buen assert negativo.
- AC-4: `T-IDEMPOTENT-SVC` (≥1 row ya revocada → `resolves.toBeUndefined()` — idempotencia real a nivel service).
- AC-5: `T-SUBSESSION` (403 SESSION_NOT_ALLOWED + `revoke` NOT called + `lookupByHash` NOT called — prueba
  que el gate corta ANTES de auth, no solo el status). Assert significativo.
- Asserts son específicos (no vagos): status + body + spy-args + spy-not-called.

### MNR-1 — Categoría: Test Coverage
- **Archivo:línea**: `src/services/key-session.test.ts:503-517` (`T-NOTFOUND-SVC`).
- **Descripción**: El Test Plan del story (fila `T-NOTFOUND-SVC`) pedía verificar que en el path 0-rows
  se llama `logOwnershipMismatch({ op: 'keySessionRevoke', ... })`. El test verifica que se lanza
  `SessionNotFoundError` pero NO espía/asserta la llamada a `logOwnershipMismatch` ni el literal `'keySessionRevoke'`.
- **Por qué NO es bloqueante**: el literal `'keySessionRevoke'` está protegido en compile-time por el enum
  `OwnershipOp` (`errors.ts:344`) — `tsc` falla si se escribe mal. La telemetría de ownership-mismatch es
  observabilidad, no parte de un AC. Impacto real = nulo si el log cambiara silenciosamente (sería detectado por tsc/lint).
- **Sugerencia**: si se quiere paridad 1:1 con el Test Plan, espiar `logOwnershipMismatch` (vi.spyOn sobre el
  módulo real, no mockeado) y assert `.toHaveBeenCalledWith({ op: 'keySessionRevoke', resourceId: 'sess-unknown', callerOwnerRef: 'user-1' })`.
  Opcional — backlog, no bloquea DONE.

### MNR-2 — Categoría: Test Coverage
- **Archivo:línea**: `src/routes/auth.key-session.test.ts:144-158` (`T-IDEMPOTENT-ROUTE`).
- **Descripción**: A nivel de ruta el test de idempotencia es funcionalmente idéntico al happy `T-REVOKE-OK`
  (ambos mockean `revoke` → resolve void → 200). No ejercita "revocar 2 veces" porque la idempotencia es
  responsabilidad del service, no de la ruta — y eso SÍ está probado de verdad en `T-IDEMPOTENT-SVC`.
- **Por qué NO es bloqueante**: la idempotencia real (≥1 row aunque ya estuviera revocada) está cubierta a nivel
  service. El test de ruta es redundante pero no incorrecto; documenta el contrato HTTP.
- **Sugerencia**: opcionalmente invocar `app.inject` dos veces en el mismo test para hacer explícito el "2x → 200".
  Cosmético. No bloquea.

## Check 6 — Documentación inline · OK

- La divergencia 404 `SESSION_NOT_FOUND` vs 403 `OWNERSHIP_MISMATCH` está documentada en TRES lugares:
  JSDoc del handler (`auth.ts:1180`, "disclosure-safe, CD-6"), JSDoc del service (`key-session.ts`, "NO revela
  si el id existe para otro owner, CD-6"), y la clase `SessionNotFoundError` (`errors.ts:319`, "404 disclosure-safe").
- El gate de sub-sesión tiene comentario inline explicando el porqué del orden (BEFORE `resolveCallerKey`,
  "which would return null and lose the exact code, CD-5") — `auth.ts:1188-1190`.
- La anotación AC-2 en el middleware test explica que el middleware NO se modifica y por qué el test cubre
  el efecto inmediato. Clara.

---

## Findings — resumen

| ID | Severidad | Categoría | Archivo:línea |
|----|-----------|-----------|---------------|
| MNR-1 | MENOR | Test Coverage | key-session.test.ts:503-517 |
| MNR-2 | MENOR | Test Coverage | auth.key-session.test.ts:144-158 |

BLOQUEANTEs (cualquier nivel): **0**.

---

## VEREDICTO: APROBADO con MENORs

El código espeja fielmente el exemplar WKH-101, es lineal y de baja complejidad, no duplica nada evitable,
respeta TS strict (sin `any`/`as unknown`/`@ts-ignore` en código productivo), documenta la divergencia
deliberada en múltiples capas, y tiene cobertura de test real para los 7 ACs (incluido el doble `.eq`
del ownership guard y la idempotencia a nivel service). Los 2 MENORs son gaps cosméticos de cobertura sin
impacto funcional — NO bloquean DONE; entran a backlog o se cierran a discreción del Dev.

Territorio AR (ownership guard / IDOR / disclosure-safe 404 / CD-7 no-leak de PG): el código aplica el doble
`.eq('id').eq('owner_ref')`, mapea 0-rows a `SessionNotFoundError` (no propaga `error.message` crudo), y el
fallback 500 logea solo `errorClass`. Lo confirma el AR en paralelo.

