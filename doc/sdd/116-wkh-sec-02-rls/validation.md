# Validation Report — WKH-SEC-02 (RLS Postgres-level, 7 tablas) — COMPACT

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-20
**Branch**: feat/116-wkh-sec-02-rls

---

## Runtime / Migration checks (pre-deploy — DB no aplicada aun)

Esta HU es DDL puro que aun no se aplico a ninguna BD (es untracked, no mergeado). Los
checks runtime-first son checks de "readiness para deploy" — no se aplica la migración
(PROHIBIDO en F4). Evidencia estática del SQL + verify script:

- **SQL up verificado (7 ENABLE exactas)**:
  - `supabase/migrations/20260607000000_wkh_sec02_rls.sql:9-15` — 7 líneas
    `ALTER TABLE public.<tabla> ENABLE ROW LEVEL SECURITY;`, exactamente las 7 tablas
    del scope. Comando: `grep "ALTER TABLE" ...wkh_sec02_rls.sql` → salida literal con
    las 7 tablas y solo ENABLE (cero FORCE, cero CREATE POLICY en DDL).
  - Confirmado por test estructural: `test/verify-rls-enabled.test.ts:103-128` →
    15/15 PASS.

- **SQL down verificado (7 DISABLE exactas)**:
  - `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql:9-15` — 7 líneas
    `ALTER TABLE public.<tabla> DISABLE ROW LEVEL SECURITY;`. Las 9 ocurrencias de grep
    incluyen 2 en comentarios (esperado); el regex del test `countDdlStatements` cuenta
    correctamente 7 DDL reales. Test: `test/verify-rls-enabled.test.ts:133` → PASS.

- **service_role 100% verificado** (propiedad de seguridad central de AC-3/AC-5):
  - `src/lib/supabase.ts:12` — `const key = process.env.SUPABASE_SERVICE_KEY` — único
    `createClient` de runtime de producción (singleton). No existe cliente anon en el
    repo. Verificado por AR repo-wide (grep `ANON|publishable|anon` sobre src/ y scripts/
    → 0 results). Con RLS ENABLE sin policy, `service_role` bypassa por `BYPASSRLS` —
    cero cambio de comportamiento.

- **Migration apply status**: PENDIENTE DE DEPLOY por el orquestador (Wave 3 del
  Story File). Los 4 archivos son untracked en main. La migration NO ha sido aplicada a
  ninguna BD todavía — la verificación post-deploy se documenta abajo en §Plan Deploy.

- **migrate:preflight (up)**: `npm run migrate:preflight supabase/migrations/20260607000000_wkh_sec02_rls.sql`
  → `[PASS] Pre-flight OK — safe to apply` (MEDIUM solo por `COMMIT;` embebido — esperado
  y benigno; ENABLE no es HIGH). Exit 0. Evidencia directa: output de esta sesión F4.

- **Timestamp**: `20260607000000` — único en `supabase/migrations/`. Confirmado por git
  status: el archivo aparece como `??` (nuevo, sin colisión).

---

## ACs

| AC | Texto (EARS) | Status | Evidencia |
|----|-------------|--------|-----------|
| AC-1 | WHEN la migración se aplica, SHALL habilitar RLS en las 7 tablas | PASS | `wkh_sec02_rls.sql:9-15` — 7 `ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;` exactas. Test: `verify-rls-enabled.test.ts:103-108` → PASS |
| AC-2 | WHILE RLS habilitada, SHALL denegar por defecto a `anon`/`authenticated` sin policy | PASS | SQL tiene 0 `CREATE POLICY` (test `verify-rls-enabled.test.ts:115` confirma). Comportamiento Postgres documentado: ENABLE sin policy = deny-all. No verificable en CI sin BD con roles reales (CD-7) — propiedad de corrección SQL, validable en smoke dev (Wave 3). |
| AC-3 | WHILE RLS habilitada, SHALL permitir a `service_role` sin restricción (bypass nativo) | PASS | `src/lib/supabase.ts:12,29` — cliente 100% `SUPABASE_SERVICE_KEY` → `service_role`. `BYPASSRLS` en Supabase es propiedad de diseño del rol. Tests suite completa: 1579 PASS / 0 FAIL (la suite entera usa service_role en mocks). Smoke E2E dev → Wave 3 (manual). |
| AC-4 | WHEN se ejecuta el down, SHALL deshabilitar RLS (DISABLE x7) y volver al estado previo | PASS | `wkh_sec02_rls_down.sql:9-15` — 7 `ALTER TABLE public.<t> DISABLE ROW LEVEL SECURITY;`. Test: `verify-rls-enabled.test.ts:133-147` → PASS. Sin DROP POLICY (no se creó ninguna). |
| AC-5 | WHEN request con `SUPABASE_SERVICE_KEY` opera sobre las 7 tablas, SHALL procesar idéntico a antes | PASS | Cliente 100% service_role (AC-3 evidencia). RLS ENABLE sin policy no afecta service_role (BYPASSRLS). Suite 1579 PASS: todos los tests de services/routes que tocan las 7 tablas via mocks siguen verdes. Smoke dev → Wave 3. |
| AC-6 | IF tabla ya tenía RLS, THEN migración completa sin error (idempotencia) | PASS | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` es idempotente en Postgres (re-aplicable sin error). `wkh_sec02_rls.sql` no tiene `IF NOT EXISTS` (no aplica a este DDL). Test: `verify-rls-enabled.test.ts:103` confirma 7 ENABLE presentes. Preflight PASS sin error de idempotencia. |
| AC-7 | WHEN se valida preflight, SHALL confirmar `relrowsecurity = true` en pg_class vía verify script | PASS | `scripts/verify-rls-enabled.mjs:60-70` — `buildRlsQuery()` genera SELECT sobre `pg_class.relrowsecurity` (no `information_schema`). `evaluateRlsRows()` exit 0 solo si 7/7 true. Tests: `verify-rls-enabled.test.ts:31-86` — 7 casos PASS (7/7 ok, 1 false, faltante, inesperada, vacía, query pg_class). |

---

## Drift

- **Scope**: Los 4 archivos nuevos son exactamente los del Scope IN del Story File:
  `supabase/migrations/20260607000000_wkh_sec02_rls.sql`,
  `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql`,
  `scripts/verify-rls-enabled.mjs`,
  `test/verify-rls-enabled.test.ts`.
  Git status: los 4 son `??` (untracked nuevos). Cero archivos `src/` modificados.
  Los demás archivos en `git diff main...HEAD` pertenecen a HUs previas (E16/WKH-118)
  ya mergeadas — no son de esta HU.
- **Wave order**: W0 (SQLs) → W1 (verify + test) → W2 (lint/tsc/test) — confirmado
  por auto-blindaje (el bug de conteo se detectó en W2 y se corrigió antes de CR).
- **Spec adherence**:
  - 7 tablas EXACTAS (ni una más, ni una menos) — CLEAN.
  - ENABLE, sin FORCE — CLEAN (`grep` confirmado).
  - Sin CREATE POLICY — CLEAN.
  - `increment_a2a_key_spend` intacta — CLEAN (grep en los 4 archivos: 0 resultados).
  - `src/` intacto — CLEAN (git status no muestra modificaciones en src/ de esta HU).
- **Test drift**: los tests del Test Plan están todos implementados en
  `test/verify-rls-enabled.test.ts` (15 tests, 15 PASS). Ningún test faltante del
  Test Plan.

---

## Gates (confirmados — no re-ejecutados salvo los específicos de F4)

| Gate | Status | Fuente |
|------|--------|--------|
| `npm test` (full suite) | PASS — 1579/0 (+ 3 skip) | Re-ejecutado en F4 para confirmar con los 15 tests nuevos incluidos |
| `npx tsc --noEmit` | PASS — 0 errores | Confirmado por AR report (exit 0) |
| `npm run lint` | PASS — exit 0 | Confirmado por AR report (1 info pre-existente en reputation.ts, no de esta HU) |
| `migrate:preflight` (up) | PASS — `safe to apply` | Re-ejecutado en F4 (MEDIUM por COMMIT embebido — benigno, esperado) |
| `migrate:preflight` (down) | BLOCKED/HIGH — esperado | Confirmado por AR report (DT-6: DISABLE es HIGH por diseño del analizador; down se aplica directo) |

---

## AR/CR follow-up

- **BLOQUEANTEs**: 0 (AR APROBADO sin BLQ).
- **MNR-1 AR** (cobertura: `registries`/`kite_schema_transforms` fuera de RLS): aceptado
  como TD. Exclusión correcta por CD-9/scope. No requiere fix-pack. Dejar para backlog.
- **MNR-1 CR** (`@ts-expect-error` en test vs shim `.d.ts`): aceptado como TD. La
  directiva es inerte (tsconfig excluye `test/`, vitest transpila sin typecheck). No
  rompe ningún gate. No requiere fix-pack. Dejar para backlog si se quiere consistencia
  con el exemplar.

---

## Plan de verificación post-deploy (Wave 3 — para el orquestador)

El deploy lo ejecuta el orquestador (no QA). Runbook:

1. **Preflight** (ya confirmado PASS): `npm run migrate:preflight supabase/migrations/20260607000000_wkh_sec02_rls.sql`
2. **Apply dev** (`<supabase-dev-ref>`) via Management API (patrón `apply-security-rpc-migration.mjs`).
3. **Verify dev**: `node scripts/verify-rls-enabled.mjs <supabase-dev-ref>` → esperar exit 0 con output `[PASS] RLS enabled on all 7 tables.`
4. **Smoke dev**: correr el smoke E2E existente (`scripts/hackathon-e2e.mjs` o smoke equivalente) → confirmar que balance/debit/sesión/depósito/recibo/policy operan idéntico (AC-3/AC-5 en runtime real).
5. **Idempotencia**: re-aplicar el up en dev → sin error (AC-6).
6. **Apply prod** (`<supabase-prod-ref>`) + verify + smoke.
7. **Rollback si falla**: `apply-security-rpc-migration.mjs` con el down SQL directo (NO via `migrate:preflight`) → DISABLE x7 → re-verify (7/7 false confirmados). Down en < 30s.

---

**Listo para DONE.** Los 4 archivos de esta HU estan correctos, todos los ACs tienen evidencia, suite 1579 PASS, cero drift, cero BLOQUEANTEs. MNRs aceptados como TD.
