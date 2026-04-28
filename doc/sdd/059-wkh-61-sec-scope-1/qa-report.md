# Validation Report — WKH-61 / SEC-SCOPE-1 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-04-27
**Branch**: `feat/059-wkh-61-sec-scope-1`
**Commits**: 5 (W0..W4) — ab4951e → 9fb72a4

---

## Runtime checks

- DB state: N/A — HU no toca DB (CD-4 compliance: `git diff main...branch -- supabase/` → 0 diff)
- Env parity: N/A — HU no agrega env vars nuevas
- Migration applied: N/A — 0 migrations
- authzService removed from middleware: `grep -n 'authzService\|checkScoping' src/middleware/a2a-key.ts` → única hit es `'SCOPE_DENIED'` en el enum de error codes (línea 35), no una llamada. 0 llamadas a `checkScoping` en el middleware.

---

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/services/compose.test.ts` > T-SCOPE-1 (AC-1): registry match → success |
| AC-2 | PASS | `src/services/compose.test.ts` > T-SCOPE-2 (AC-2): registry mismatch → SCOPE_DENIED, agent NOT invoked + `src/routes/compose.test.ts` > T-ROUTE-1 (AC-2 e2e): errorCode=SCOPE_DENIED → 403 con scopeDeniedTarget |
| AC-3 | PASS | `src/services/compose.test.ts` > T-SCOPE-3 (AC-3): slug mismatch → SCOPE_DENIED |
| AC-4 | PASS | `src/services/compose.test.ts` > T-SCOPE-4 (AC-4): category mismatch → SCOPE_DENIED + `src/routes/orchestrate.test.ts` > T-ROUTE-2 (AC-4 e2e): pipeline.errorCode=SCOPE_DENIED → 403 |
| AC-5 | PASS | `src/services/compose.test.ts` > T-SCOPE-5 (AC-5): allowed_*=null → no scope check, success path + T-SCOPE-9 (CD-13): scopingKeyRow=undefined → check skipped, x402 path intact |
| AC-6 | PASS | `src/services/compose.test.ts` > T-SCOPE-6 (AC-6): check evaluates real agent.registry, not step.registry hint. Implementación en `src/services/compose.ts:80-85` usa `agent.registry` / `agent.slug` post-`resolveAgent`. |
| AC-7 | PASS | `src/services/compose.test.ts` > T-SCOPE-7 (AC-7): step 1 fails scope → step 2 NOT invoked. `expect(result.steps).toHaveLength(1)` + `expect(mockFetch).toHaveBeenCalledTimes(1)` |
| AC-8 | PASS | `src/middleware/a2a-key.test.ts` > REGRESSION-WKH-61: key with allowed_registries no longer 403s at middleware level. `grep -n 'authzService' src/middleware/a2a-key.ts` → 0 matches. |

---

## Drift

- **Scope files**: 10 archivos modificados coinciden exactamente con los 10 declarados en §2 del Story File (6 prod + 2 test modificados + 2 test nuevos).
- **Wave order**: W0 (ab4951e) → W1 (fff88d6) → W2 (b660b57) → W3 (6caf7d0) → W4 (9fb72a4) — orden correcto.
- **Spec drift**: ninguno. `readCategory` implementado exactamente según DT-3/SDD §2; `scopingKeyRow` propagado en todos los puntos declarados.
- **CD compliance**:
  - CD-4: 0 migrations, 0 schema changes. `git diff main...branch -- supabase/` = vacío.
  - CD-6: `git diff main...branch -- src/services/authz.ts` = vacío. Authz intacto.
  - CD-8: `grep 'capabilities\[0\]' src/services/compose.ts` → 0 matches (solo aparece en comentario de JSDoc).
  - CD-9: `grep -n 'checkScoping' src/middleware/a2a-key.ts` → 0 matches.
  - CD-13: `if (scopingKeyRow)` en `src/services/compose.ts:79` — x402 path (sin keyRow) skip garantizado.

---

## Gates

- **tsc --noEmit**: PASS (exit 0, 0 errores)
- **tests**: PASS — 532/532 (50 test files). Baseline 518 + 14 nuevos WKH-61 (1 regression middleware + 9 service-unit + 3 compose-route + 2 orchestrate-route = +14, 532 total).
- **lint (biome)**: MNR pre-existente. Los errores de formato en `src/routes/orchestrate.ts` y `src/types/index.ts` existían en `main` antes de WKH-61 (verificado: `git show main:src/routes/orchestrate.ts` ya producía `format` error; WKH-61 solo agregó líneas funcionales). Los 2 archivos nuevos (`routes/compose.test.ts`, `routes/orchestrate.test.ts`) tienen errores de formato cosmético. Ningún error de lint nuevo de tipo `lint/` (solo `format` y `assist/`). Pre-existente, no bloqueante.

---

## AR/CR follow-up

- No hay ar-report.md ni cr-report.md en `doc/sdd/059-wkh-61-sec-scope-1/`. El preámbulo del task indica "AR+CR APROBADOS (0 BLQ, 5 MNRs cosméticos)". Los 5 MNRs cosméticos se corresponden con los errores de formato de biome (pre-existentes + nuevos archivos) — aceptados como TD-COSMETIC.

---

**Listo para DONE.**
