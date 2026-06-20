# Report — HU [WKH-122] Revocación granular e instantánea de session keys

## Resumen ejecutivo

**Entrega:** Endpoint `DELETE /auth/key-session/:id` + `keySessionService.revoke(sessionId, ownerId)` para revocar una session key individual (`wasi_a2a_sess_*`) sin matar la master key ni las demás sesiones activas. La revocación es inmediata (el middleware WKH-121 ya chequea `revoked_at != null` en producción sin caché). La divergencia deliberada con WKH-101: responde 404 `SESSION_NOT_FOUND` (disclosure-safe) en lugar de 403 `OWNERSHIP_MISMATCH`.

**Status final:** **DONE** — 7/7 ACs PASS (validación F4 aprobada); 0 BLOQUEANTEs en AR/CR; 2 MENORs aceptados como deuda menor de cobertura de tests.

**Archivos clave:** `doc/sdd/111-wkh-122-session-revoke/` completo (work-item.md, sdd.md, story-file.md, ar-report.md, cr-report.md, report.md). Branch: `feat/111-wkh-122-session-revoke`. Sin migración de BD; sin tocar middleware.

---

## Pipeline ejecutado

| Fase | Estado | Fecha | Evidencia |
|------|--------|-------|-----------|
| **F0** — Project Context cargado | ✓ | 2026-06-19 | `.nexus/project-context.md` (WKH-121 base dep, confirmado prod) |
| **F1** — Work Item + ACs EARS | ✓ APPROVED | 2026-06-19 | `work-item.md` (7 ACs, scope IN/OUT claro, clinical review AUTO) |
| **F2** — SDD specification | ✓ APPROVED | 2026-06-19 | `sdd.md` (FULL, 10 secciones, context-map 8 archivos leídos, exemplars verificados) |
| **F2.5** — Story File autocontenido | ✓ | 2026-06-19 | `story-file.md` (4 exemplars reales, Anti-Hallucination Checklist, Escalation Rule) |
| **F3** — Implementación wave/wave | ✓ | 2026-06-19 | W0 (SessionNotFoundError), W1 (revoke service), W2 (DELETE route), W3 (6 tests) — 6 archivos tocados, sin fix-pack |
| **AR** — Adversarial Review | ✓ APROBADO | 2026-06-19 | `ar-report.md` (8 categorías: Security OK, Error Handling OK, ..., Scope Drift OK; MNR-1 assert de telemetría faltante) |
| **CR** — Code Review | ✓ APROBADO | 2026-06-19 | `cr-report.md` (6 checks: naming OK, complejidad OK, DRY OK, SOLID OK, tests OK, docs OK; MNR-1/MNR-2 cosméticas) |
| **F4** — QA Validation | ✓ APROBADO | 2026-06-19 | `validation.md` (7/7 ACs PASS, sin BLOQUEANTEs, evidencia archivo:línea por cada AC) |

**Síntesis:** Pipeline QUALITY AUTO sin gates humanos requeridos (F0/F1/F2 self-aprobados vía clinical review). F3 → AR/CR paralelo → F4 todo verde. Sin fix-pack: AR/CR aprobaron a la primera.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia archivo:línea |
|---|---|---|
| **AC-1** (revocación exitosa — 200 `{ revoked: true }`) | **PASS** | `auth.ts:1182-1221` handler `DELETE /key-session/:id` → `keySessionService.revoke(id, owner_ref)` → 200; `auth.key-session.test.ts:98-117` T-REVOKE-OK |
| **AC-2** (middleware rechaza `revoked_at != null` con 403 `SESSION_TOKEN_INVALID`, sin caché) | **PASS** | `a2a-key.ts:480-486` (WKH-121, no tocado); `a2a-key.test.ts:1543-1556` T-MW-REVOKED anotado como AC-2 (regresión) |
| **AC-3** (id inexistente / otro owner → 404 `SESSION_NOT_FOUND`, disclosure-safe) | **PASS** | `key-session.ts:338-345` 0-rows → `SessionNotFoundError`; `auth.ts:1216` mapeo `instanceof SessionNotFoundError` → 404; `auth.key-session.test.ts:119-136` T-NOTFOUND-ROUTE; `key-session.test.ts:503-517` T-NOTFOUND-SVC |
| **AC-4** (idempotencia — revocar 2x → 200 sin error) | **PASS** | `key-session.ts:331-336` UPDATE siempre ejecuta; ≥1 row ya revocada → `void` sin lanzar; `key-session.test.ts:518-532` T-IDEMPOTENT-SVC; `auth.key-session.test.ts:144-158` T-IDEMPOTENT-ROUTE |
| **AC-5** (sub-sesión `wasi_a2a_sess_*` autenticador → 403 `SESSION_NOT_ALLOWED`, gate ANTES de `resolveCallerKey`) | **PASS** | `auth.ts:1188-1192` gate pre-`resolveCallerKey`; `auth.key-session.test.ts:160-178` T-SUBSESSION (`revoke` NOT called, `lookupByHash` NOT called) |
| **AC-6** (no romper `DELETE /delegation/:id` ni branch `wasi_a2a_session_*`) | **PASS** | `delegation.ts` no modificado; `auth.delegation.test.ts` suite completa verde sin cambios; `a2a-key.ts` línea 480-486 intacta; `ar-report.md` "Integration / Backwards compat — OK" |
| **AC-7** (`keySessionService.revoke` requiere `ownerId: string` ESTRICTO, `.eq('id').eq('owner_ref')` obligatorio) | **PASS** | `key-session.ts:326` firma `async revoke(sessionId: string, ownerId: string): Promise<void>` (no `string \| undefined`); línea 331 `.eq('id', sessionId).eq('owner_ref', ownerId)` verificado; `key-session.test.ts:487-502` T-SVC-OWNERSHIP assert cadena |

**Resultado:** 7/7 PASS. Suite completa: 1429 tests pass, incluidos WKH-121/WKH-101 sin regresión.

---

## Hallazgos finales

### BLOQUEANTEs
**Total: 0.** AR + CR hallaron solamente MENORs. Seguridad verificada archivo:línea.

### MENORs
**Total: 2** (aceptados como deuda menor).

| ID | Severidad | Categoría | Ubicación | Descripción |
|---|---|---|---|---|
| **MNR-1** | MENOR | Test Coverage | `key-session.test.ts:503-517` | Test verifica `SessionNotFoundError` pero NO asserta invocación de `logOwnershipMismatch`. El `op` está protegido compile-time. |
| **MNR-2** | MENOR | Test Coverage | `auth.key-session.test.ts:144-158` | Test de idempotencia a nivel ruta redundante con happy path. Idempotencia real a nivel service. |

---

## Decisiones técnicas clave

| ID | Decisión | Justificación |
|---|---|---|
| **DT-1** | `DELETE /auth/key-session/:id` (no POST) | REST semántico; consistencia WKH-101; evita ambigüedad con `POST /key-session` (create) |
| **DT-2** | **404 `SESSION_NOT_FOUND`** (no 403) | Disclosure-safe; divergencia deliberada documentada 3 capas |
| **DT-3** | Middleware: sin cambios WKH-121 | Check ya en prod. Solo test regresión AC-2. |
| **DT-4** | Idempotencia UPDATE siempre | 0 rows → error; ≥1 row → void |
| **DT-5** | Clase `SessionNotFoundError` nueva | NO existe pre-HU; `code = 'SESSION_NOT_FOUND' as const` |

---

## Auto-Blindaje consolidado (8 riesgos)

| Riesgo | Status | Evidencia |
|---|---|---|
| Path `/auth/auth/...` duplicado | ✓ MITIGADO | CD-8: path interno `/key-session/:id` SIN `/auth`; test URL real `/auth/key-session/<id>` responde 200 |
| IDOR / ownership guard | ✓ MITIGADO | `.eq('id').eq('owner_ref')` ambos; firma `revoke(sessionId: string, ownerId: string)` (no undefined) |
| 403 en lugar de 404 disclosure-safe | ✓ MITIGADO | `instanceof SessionNotFoundError` → 404; test asserta `not.toBeInstanceOf(OwnershipMismatchError)` |
| Leak msg Postgres | ✓ MITIGADO | Handler logea solo `errorClass`, NUNCA `error.message` |
| Gate sub-sesión DESPUÉS de auth | ✓ MITIGADO | Gate `.startsWith(KEY_SESSION_TOKEN_PREFIX)` ANTES de `resolveCallerKey` |
| Caché entre revocación y middleware | ✓ MITIGADO | NO introduce caché; lookup directo Supabase; efecto inmediato |
| Carrera TOCTOU revoke vs débito | ✓ MITIGADO | RPC `debit_session_and_parent` re-chequea `revoked_at` bajo `FOR UPDATE` |
| Aserciones mock rotas por cambios firma | ✓ MITIGADO | `revoke` es función NUEVA; no cambia firmas preexistentes |

---

## Archivos modificados

**Productivos (3):**
- `src/services/security/errors.ts` (+9 L): `SessionNotFoundError`
- `src/services/key-session.ts` (+31 L): `async revoke(sessionId, ownerId)`
- `src/routes/auth.ts` (+48 L): `DELETE /key-session/:id`

**Tests (3):**
- `src/services/key-session.test.ts` (+56 L): 3 tests `revoke`
- `src/routes/auth.key-session.test.ts` (NUEVO, 174 L): 4 tests ruta
- `src/middleware/a2a-key.test.ts` (+4 L): anotación AC-2

**Total:** 6 archivos (5 mod + 1 nuevo); ~378 líneas (148 productivas + 230 tests).

---

## Veredicto final

**Status: DONE**

- F0→F1→F2→F2.5: Clinical review AUTO; 7 ACs EARS; SDD FULL.
- F3: 6 archivos, 0 fix-pack.
- AR: APROBADO sin BLOQUEANTEs.
- CR: APROBADO sin BLOQUEANTEs.
- F4 QA: APROBADO — 7/7 ACs PASS.

**Pipeline QUALITY completado.** Ready para merge + deploy. Auto-Blindaje 8 riesgos consolidado.

---

**Compilado por:** nexus-docs (DONE)  
**Fecha:** 2026-06-19  
**Branch:** feat/111-wkh-122-session-revoke  
**Índice:** `doc/sdd/_INDEX.md` entrada 111 → **DONE**
