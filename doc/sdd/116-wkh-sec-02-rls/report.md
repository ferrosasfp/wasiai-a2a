# Final Report — WKH-SEC-02: RLS Postgres-level (defensa en profundidad)

> **Status**: ✅ DONE · **Fecha**: 2026-06-20 · **Branch**: `feat/116-wkh-sec-02-rls` · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (7/7 ACs PASS). **Migración aplicada y verificada en prod.**

## 1. Resumen ejecutivo
WKH-SEC-02 habilita **Row Level Security (RLS)** en las 7 tablas con `owner_ref`, agregando una capa de defensa Postgres-level contra accesos directos con roles `anon`/`authenticated`. La defensa app-layer (WKH-53 ownership guard) se mantiene intacta; RLS es un **backstop**, no un reemplazo. Como el cliente del servicio es **100% `service_role`** (que bypassa RLS por `BYPASSRLS`), el servicio en vivo **no cambia su comportamiento**.

## 2. Decisión de scope
- **Parte (A) RLS**: implementada. 7 tablas: `a2a_agent_keys`, `a2a_key_sessions`, `a2a_delegations`, `a2a_key_deposits`, `a2a_receipts`, `a2a_key_spend_policies`, `a2a_key_dest_spend_ledger`.
- **Parte (B)** (validar `p_owner_ref` dentro de `increment_a2a_key_spend`): **DIFERIDA a WKH-SEC-02b**. Razón: agregar un param a esa RPC fundacional crearía un overload (lección WKH-125/BLQ-MED-1) y rompería 3 callers; la RPC ya está REVOCADA de anon/authenticated, así que el riesgo residual es bajo.
- `ENABLE` sin `FORCE` (service_role bypassa por BYPASSRLS, que FORCE no toca) y **sin policy permisiva** (ENABLE sin policy = deny-all para non-bypass roles = el deny-default deseado).

## 3. Pipeline (QUALITY AUTO, 2026-06-20)
HU_APPROVED + SPEC_APPROVED self-aprobados. F2.5 → F3 → AR (APROBADO, auditoría repo-wide confirmó que RLS no rompe el servicio) + CR (APROBADO con MENORs) → F4 (APROBADO PARA DONE). Sin fix-pack.

## 4. AC results (7/7 PASS — ver validation.md)
RLS habilitado en las 7 tablas · deny-default anon/authenticated · service_role sin restricción (bypass nativo) · down deshabilita (7 DISABLE) · idempotente · verify script (`pg_class.relrowsecurity`) · zero regresión funcional. Gates: tsc 0 · 1579 tests · lint 0 · migrate:preflight(up) PASS.

## 5. Deploy + verificación en prod (HECHO)
- Migración `20260607000000_wkh_sec02_rls.sql` **aplicada a prod** (`<supabase-prod-ref>`), HTTP 201.
- **Verificado**: `relrowsecurity = true` en las 7 tablas (query a `pg_class`).
- **Smoke funcional en vivo** (sin datos sensibles): `GET /auth/key-session` con key inválida → **403** (el middleware consultó `a2a_agent_keys` bajo RLS y la query de service_role funcionó — bypass OK, no 500); `/health` → 200; `/discover` → 200. El servicio funciona idéntico post-RLS.
- **Rollback** disponible: `20260607000000_wkh_sec02_rls_down.sql` (7 DISABLE) aplicable directo vía Management API en <30s (NO pasa por migrate:preflight, que marca DISABLE como HIGH por diseño).

## 6. Hallazgos
0 BLOQUEANTEs. El AR verificó repo-wide que NO hay acceso anon a las 7 tablas (100% service_role) → RLS no rompe el servicio. MENORs (deuda): `registries` y `kite_schema_transforms` también tienen `owner_ref` pero quedaron fuera del scope (→ posible WKH-SEC-02c para defensa uniforme); el test usa `// @ts-expect-error` inerte en vez de un `.d.ts` shim (cosmético, no afecta gates).

## 7. Archivos
**Nuevos**: `supabase/migrations/20260607000000_wkh_sec02_rls.sql` (+down), `scripts/verify-rls-enabled.mjs`, `test/verify-rls-enabled.test.ts` (15 tests). **Cero cambios en el servicio** (src/services/middleware/routes/lib intactos) — propiedad de seguridad central.

## 8. Spinoffs
- **WKH-SEC-02b**: validar `p_owner_ref` dentro de `increment_a2a_key_spend` (con DROP + actualizar 3 callers, o una fn nueva `increment_a2a_key_spend_owned`).
- **WKH-SEC-02c** (opcional): RLS en `registries`/`kite_schema_transforms` para defensa uniforme.
- `scripts/verify-rls-enabled.mjs` queda como herramienta de ops reutilizable.

## 9. Lección
Habilitar RLS sobre una BD de prod es seguro SOLO si se confirma que el cliente es 100% un rol con BYPASSRLS (service_role). El grounding F0 verificó esto repo-wide ANTES de diseñar; el smoke funcional post-deploy lo confirmó en vivo. ENABLE sin policy = deny-all para non-bypass roles (no hace falta CREATE POLICY para denegar).
