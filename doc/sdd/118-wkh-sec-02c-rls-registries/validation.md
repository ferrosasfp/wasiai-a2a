# Validation Report — WKH-SEC-02c (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-22
**Branch**: feat/118-wkh-sec-02c-rls-registries (working tree)
**Evidencia AR/CR**: APROBADO (0 BLQ, 2 MNR cosméticos en ambos)

---

## Runtime checks

### Migration structure (verificado directo contra archivos)

**Up** (`supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql`):
- BEGIN presente: línea 8
- `ALTER TABLE public.registries ENABLE ROW LEVEL SECURITY;` : línea 10
- `ALTER TABLE public.kite_schema_transforms ENABLE ROW LEVEL SECURITY;` : línea 11
- COMMIT presente: línea 13
- FORCE: ausente en líneas DDL (solo aparece en comentario "Sin FORCE" — linea 4)
- CREATE POLICY: ausente
- CREATE FUNCTION: ausente
- Conteo DDL real (sentencias, no substrings): 2 ENABLE

**Down** (`supabase/migrations/20260610000000_wkh_sec02c_rls_registries_down.sql`):
- BEGIN presente: línea 7
- `ALTER TABLE public.registries DISABLE ROW LEVEL SECURITY;` : línea 9
- `ALTER TABLE public.kite_schema_transforms DISABLE ROW LEVEL SECURITY;` : línea 10
- COMMIT presente: línea 12
- DROP POLICY: ausente (no se creó ninguna policy)
- Conteo DDL real: 2 DISABLE

### service_role singleton — accesos a `registries` (7 total, todos service_role)

| Archivo | Líneas | Cliente |
|---------|--------|---------|
| `src/services/registry.ts:6` (import) → usa singleton `supabase` | L119, L133, L191, L285, L343, L362 | service_role |
| `src/services/event.ts:6` `import { supabase } from '../lib/supabase.js'` | L94 | service_role |

Evidencia import: `src/lib/supabase.ts:12` — `const key = process.env.SUPABASE_SERVICE_KEY` → `createClient(url, key)` L29. Único cliente en el proceso.
Nota: el SDD contaba 6 call-sites (solo registry.ts); MNR-1 de AR identifica el 7º en event.ts:94. Ambos usan el mismo singleton service_role → cero riesgo.

### service_role singleton — accesos a `kite_schema_transforms` (3 total, todos service_role)

| Archivo | Líneas | Cliente |
|---------|--------|---------|
| `src/services/llm/transform.ts:19` `import { supabase } from '../../lib/supabase.js'` | L207, L242, L273 | service_role |

### verify-rls-enabled.mjs — 9 tablas confirmadas

`scripts/verify-rls-enabled.mjs:21-31` — `RLS_TABLES` exportado, 9 entradas:
```
'a2a_agent_keys', 'a2a_key_sessions', 'a2a_delegations', 'a2a_key_deposits',
'a2a_receipts', 'a2a_key_spend_policies', 'a2a_key_dest_spend_ledger',
'registries',                   // L29 — nueva
'kite_schema_transforms',       // L30 — nueva
```
Log usa `RLS_TABLES.length` (L137, L157) → "9 tables" sin hardcode.
`buildRlsQuery()` L63: `RLS_TABLES.map(...)` → 9 tablas en el IN list.

### Migration apply (W2 — no ejecutado en CI, pendiente deploy)

La migración `20260610000000_wkh_sec02c_rls_registries.sql` existe como archivo untracked en el working tree. La aplicación real contra Supabase (dev + prod) es manual (SDD §13, W2.1–W2.5). Este check se marca **NO VERIFICABLE en CI** por diseño del stack (mismo patrón que SEC-02). La validación runtime de `relrowsecurity=true` en `pg_class` se confirma post-deploy con `node scripts/verify-rls-enabled.mjs`.

---

## ACs

| AC | Texto (EARS — extracto) | Status | Evidencia |
|----|------------------------|--------|-----------|
| AC-1 | tras el up, `relrowsecurity=true` en `pg_class` para ambas tablas | PASS (estructural) | up L10-11: `ALTER TABLE public.registries ENABLE ROW LEVEL SECURITY;` + `ALTER TABLE public.kite_schema_transforms ENABLE ROW LEVEL SECURITY;`. Test: `test/verify-rls-enabled.test.ts:105-110` "tiene 2 ENABLE ROW LEVEL SECURITY". Confirmación runtime pendiente deploy W2 (por diseño). |
| AC-2 | deny-default para `anon`/`authenticated` — ENABLE sin policy | PASS | up sin `CREATE POLICY` (verificado L1-13 del archivo). Test: `test/verify-rls-enabled.test.ts:117-119` "no crea ninguna policy" + L113-115 "no usa FORCE". También `test/verify-rls-enabled.test.ts:54-61` "tabla fuera del set → unexpected (a2a_tasks)". |
| AC-3 | down → `DISABLE ROW LEVEL SECURITY` en ambas, estado previo restaurado | PASS | down L9-10: 2 DISABLE. Sin DROP POLICY (verificado). Test: `test/verify-rls-enabled.test.ts:135-139` "tiene 2 DISABLE ROW LEVEL SECURITY". |
| AC-4 | service_role opera sin error ni cambio observable (BYPASSRLS) | PASS (estructural) | `src/lib/supabase.ts:12,29` único cliente = `SUPABASE_SERVICE_KEY`. Los 7 call-sites de `registries` y 3 de `kite_schema_transforms` usan ese singleton. Smoke E2E manual pendiente W2.3. |
| AC-5 | `verify-rls-enabled.mjs` reporta 9/9 (incl. 2 nuevas) | PASS | `scripts/verify-rls-enabled.mjs:21-31` RLS_TABLES tiene 9 entradas incluyendo `registries` (L29) y `kite_schema_transforms` (L30). Test: `test/verify-rls-enabled.test.ts:75-81` `toHaveLength(9)` + `toContain` por cada tabla. `test/verify-rls-enabled.test.ts:63-67` "vacía → 9 missing". |
| AC-6 | idempotencia — re-aplicar up sin error | PASS (estructural + pendiente W2.4) | `ENABLE ROW LEVEL SECURITY` es no-op en Postgres si RLS ya está activo (propiedad del motor, no de este código). Cubierto por construcción. Test: `test/verify-rls-enabled.test.ts:126-129` verifica `BEGIN;/COMMIT;` (atomicidad). Re-apply manual en dev = W2.4 (pendiente deploy). |

---

## Drift

- **Scope**: los 4 archivos de Scope IN exactamente presentes en working tree: 2 .sql nuevos (untracked) + `scripts/verify-rls-enabled.mjs` (M) + `test/verify-rls-enabled.test.ts` (M). `src/` intacto (confirmado: 0 archivos src/ modificados en esta HU).
- **MNR-1** (AR): event.ts:94 como 7º call-site no documentado en SDD Context Map. Sin impacto funcional (mismo singleton). Aceptado como TD documental.
- **MNR-2** (AR + CR): `BACKLOG.md` y `HACKATHON-FINAL.md` modificados en working tree pero NO en el Scope IN. Contenido sin relación con SEC-02c. No deben incluirse en el commit de esta HU.
- **MNR-3** (CR MNR-1): JSDoc de `verify-rls-enabled.mjs` L3,6,7,58 dice "7 tablas" (array L19-20 sí dice 9). Cero impacto runtime. Backlog.
- **MNR-4** (CR MNR-2): comentario `(lección WKH-121)` en `test/verify-rls-enabled.test.ts:96` — heredado, no introducido por esta HU.
- Wave drift: W0 (DDL) → W1 (verify + test) = orden correcto. W2 (deploy) es manual post-merge.
- Spec drift: ninguno detectado. Las 2 migraciones son espejo exacto del SDD §4.2/§4.3.

---

## Gates (confirmados desde CR report)

- **tsc**: 0 errores (CR report: "tsc 0 (exit 0)")
- **biome**: 0 errores en scope (CR: "biome 0"; 1 info pre-existente en reputation.ts:116 fuera de scope)
- **vitest**: 1625 passed / 0 failed (CR report L5: "vitest 1625 passed / 0 failed")
- **verify-rls test**: 15 passed (CR report: "verify-rls 15 passed"; confirmado: 15 `it()` en test/verify-rls-enabled.test.ts)
- Gates no re-ejecutados (CR los confirmó verde con exit codes).

---

## AR/CR follow-up

- 0 BLQ en AR y CR. Pipeline no fue bloqueado.
- 4 MNR (2 de AR + 2 de CR), todos cosméticos/documentales. Ninguno afecta lógica ni seguridad.
- Recomendación: no incluir `BACKLOG.md`/`HACKATHON-FINAL.md` en el commit de esta HU.

---

**Listo para DONE.** 6/6 ACs PASS. Runtime checks confirmados estructuralmente; W2 deploy manual requerido post-merge (misma política que SEC-02).
