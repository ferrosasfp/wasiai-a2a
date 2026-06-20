# Validation Report — WKH-122 Revocación granular de session keys

**Veredicto**: APROBADO PARA DONE · **Fecha**: 2026-06-19 · **Branch**: feat/111-wkh-122-session-revoke

> Persistido por el orquestador desde el veredicto F4 de nexus-qa (sin alterar resultado).

## Runtime checks
- **Sin migración**: `git diff HEAD -- supabase/` vacío. `revoked_at` ya existe en `a2a_key_sessions` (WKH-121, prod). N/A aplicar a BD.
- **Sin env vars nuevas**. N/A.

## Drift Detection
- Scope IN: 6 archivos (errors.ts, key-session.ts, auth.ts, key-session.test.ts, auth.key-session.test.ts NUEVO, a2a-key.test.ts anotación). Sin código de prod fuera del Scope IN.
- `src/middleware/a2a-key.ts` (prod) NO tocado (0 líneas). WKH-101/delegation intactos.
- Spec adherence: DT-1 (DELETE), DT-2 (404 SESSION_NOT_FOUND disclosure-safe), CD-1/3/5/6/7 verificados. Wave order W0→W1→W2→W3 correcto.

## AC Verification (7/7 PASS)
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 revocación → 200 {revoked:true} + revoked_at | PASS | `auth.key-session.test.ts:115` (T-REVOKE-OK); prod `auth.ts:1204-1205` |
| AC-2 sesión revocada → middleware 403 SESSION_TOKEN_INVALID | PASS | `a2a-key.test.ts:1547` (anotado AC-2); middleware `a2a-key.ts:480-486` sin tocar |
| AC-3 ownership/inexistente → 404 SESSION_NOT_FOUND disclosure-safe | PASS | `auth.key-session.test.ts:130` + `key-session.test.ts:503`; prod `key-session.ts:342-348`, `auth.ts:1207-1208` |
| AC-4 idempotencia → 200 | PASS | `auth.key-session.test.ts:144` + `key-session.test.ts:489`; prod `key-session.ts:330-350` |
| AC-5 sub-sesión → 403 SESSION_NOT_ALLOWED | PASS | `auth.key-session.test.ts:160` (revoke/lookup NOT called); prod `auth.ts:1191-1195` |
| AC-6 no rompe deactivate/WKH-101 | PASS | delegation.ts + auth.delegation.test.ts sin tocar; suite completa 1429 pass |
| AC-7 firma `ownerId: string` + doble `.eq` | PASS | `key-session.ts:330` firma; `:334-335` `.eq('id').eq('owner_ref')`; `key-session.test.ts:485-486` |

## Quality Gates
- `tsc --noEmit`: PASS (exit 0)
- `vitest run`: PASS — **1429 passed / 3 skipped / 0 fail**
- `lint` (biome): PASS (exit 0; 1 info pre-existente en reputation.ts, fuera de scope)

## AR/CR Follow-up
- 0 BLOQUEANTEs.
- MNR-1 (AR+CR): `T-NOTFOUND-SVC` no assertea la telemetría `logOwnershipMismatch` (op protegido por enum en compile-time). Deuda aceptada → backlog.
- MNR-2 (CR): `T-IDEMPOTENT-ROUTE` redundante con happy path (idempotencia real en T-IDEMPOTENT-SVC). Deuda aceptada → backlog.

**APROBADO PARA DONE** — 7/7 ACs PASS con evidencia archivo:línea, gates verdes, sin drift, sin migración.
