# Final Report — WKH-SEC-02c: RLS Postgres-level en `registries` y `kite_schema_transforms`

> **Status**: ✅ DONE · **Fecha**: 2026-06-22 · **Branch**: `feat/118-wkh-sec-02c-rls-registries` · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (6/6 ACs PASS). **Migración lista para aplicar a prod.**

## 1. Resumen ejecutivo

WKH-SEC-02c extiende la defensa RLS (deny-by-default, sin policy, sin FORCE) de WKH-SEC-02 (7 tablas) a las 2 tablas con `owner_ref` que quedaron fuera: `registries` y `kite_schema_transforms`. Resultado: **9 tablas con `ENABLE ROW LEVEL SECURITY`**. Patrón 1:1 con SEC-02 (ya auditado y en prod). El único cliente Supabase es `service_role` (BYPASSRLS) → **cero cambio de comportamiento en producción**. Spinoff de `doc/sdd/116-wkh-sec-02-rls/report.md` §6/§8.

## 2. Pipeline (QUALITY AUTO, 2026-06-22)

HU_APPROVED + SPEC_APPROVED self-aprobados → F2.5 → F3 (2 waves: W0 DDL, W1 verify script + test; 0 archivos en `src/`) → AR (APROBADO, 0 BLQ, 2 MNR) + CR (APROBADO, 0 BLQ, 2 MNR) → F4 (APROBADO PARA DONE, 6/6 ACs PASS).

## 3. AC results (6/6 PASS — ver validation.md)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 relrowsecurity=true tras up | ✅ PASS | up L10-11 (2 ENABLE) + `verify-rls-enabled.test.ts:105-110` |
| AC-2 deny-default sin policy | ✅ PASS | up sin CREATE POLICY + `test:117-119, 54-61` (unexpected=a2a_tasks) |
| AC-3 down DISABLE x2 | ✅ PASS | down L9-10 + `test:135-139` |
| AC-4 service_role sin cambio | ✅ PASS (estructural) | `src/lib/supabase.ts:12,29` único cliente; smoke W2 post-deploy |
| AC-5 verify 9/9 | ✅ PASS | `verify-rls-enabled.mjs:29-30` + `test:75-81` |
| AC-6 idempotencia | ✅ PASS (estructural) | ENABLE idempotente en PG + `test:126-129`; re-apply W2 post-deploy |

## 4. Decisiones clave

- **DT-1** deny-default puro (sin CREATE POLICY) — patrón SEC-02 reutilizado.
- **DT-2** timestamp `20260610000000` (posterior a la última, sin colisión).
- **DT-3** `verify-rls-enabled.mjs` extendido (no duplicado), `RLS_TABLES` único array 7→9.
- **DT-4** sin FORCE (service_role bypassa por BYPASSRLS, no por ownership).
- **DT-5** `kite_schema_transforms.owner_ref` nullable no afecta deny-default (ENABLE sin policy bloquea todos los rows).

## 5. Archivos

**Nuevos**: `supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql` (up) + `..._down.sql` (down).
**Modificados**: `scripts/verify-rls-enabled.mjs` (7→9), `test/verify-rls-enabled.test.ts` (conteos 7→9, "unexpected" → a2a_tasks CD-8, conteo DDL por sentencia CD-7). **`src/` intacto**.

## 6. Gates

tsc 0 · biome 0 · vitest 1625 passed / 0 failed · verify-rls 15 passed.

## 7. Las 9 tablas con RLS (defensa uniforme)

`a2a_agent_keys`, `a2a_key_sessions`, `a2a_delegations`, `a2a_key_deposits`, `a2a_receipts`, `a2a_key_spend_policies`, `a2a_key_dest_spend_ledger` (SEC-02) + **`registries`, `kite_schema_transforms`** (SEC-02c). Toda tabla con `owner_ref` queda con deny-default para anon/authenticated.

## 8. Deploy a Producción (W2, post-merge)

Aplicar `20260610000000_wkh_sec02c_rls_registries.sql` vía Supabase Management API a `caldzjhjgctpgodldqav` → `node scripts/verify-rls-enabled.mjs` debe reportar **9/9** → smoke (registry CRUD + transform cache idéntico). **Rollback**: `..._down.sql` (DISABLE x2).

## 9. Deuda técnica (MNR cosméticos, no bloquean)

- JSDoc de `verify-rls-enabled.mjs` (L3/L6/L7/L58) dice "7 tablas" (el array sí dice 9).
- Comentario `(lección WKH-121)` en el test (heredado, atribución real WKH-SEC-02).
- Doc del SDD contó 6 `.from('registries')` (son 7, +event.ts:94) — sin impacto.

## 10. Lección

ENABLE RLS sin CREATE POLICY = deny-default cero-mantenimiento (rollback = DISABLE). Al ampliar un set canónico (tablas RLS), reescribir los tests que usaban miembros del set como "inesperados" (acá `registries`→`a2a_tasks`). Conteo de DDL por sentencia completa, no substring (lección SEC-02).
