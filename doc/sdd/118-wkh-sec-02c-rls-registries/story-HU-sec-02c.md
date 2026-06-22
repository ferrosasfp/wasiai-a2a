# Story File — HU WKH-SEC-02c: RLS Postgres-level en `registries` y `kite_schema_transforms`

> Contrato autocontenido para el Dev (F3). Ejecutá wave por wave. NO necesitás releer el SDD.
> SPEC_APPROVED: SÍ. Branch: `feat/118-wkh-sec-02c-rls-registries`.
> Tipo: security / DDL hardening. **CERO código de producción.**

---

## 0. Contexto compacto (qué se construye y por qué)

WKH-SEC-02 ya habilitó RLS (deny-by-default, sin policy, sin FORCE) en **7 tablas** con `owner_ref`.
Quedaron **2 tablas con `owner_ref` fuera** de ese scope: `registries` y `kite_schema_transforms`.
Esta HU las suma: `ENABLE ROW LEVEL SECURITY` en ambas → deny-all para `anon`/`authenticated`,
mientras `service_role` (el ÚNICO cliente del servicio, `SUPABASE_SERVICE_KEY` en `src/lib/supabase.ts`)
bypassa nativamente por `BYPASSRLS`. **Cero cambio de comportamiento en prod.**

El patrón es 1:1 con SEC-02 (ya auditado, en prod). Solo se tocan 4 archivos: 2 `.sql` nuevos +
`scripts/verify-rls-enabled.mjs` (7→9 tablas) + su test.

---

## 1. Scope IN (lista exhaustiva — NO tocar nada más)

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql` | CREATE (up) |
| 2 | `supabase/migrations/20260610000000_wkh_sec02c_rls_registries_down.sql` | CREATE (down) |
| 3 | `scripts/verify-rls-enabled.mjs` | EDIT (RLS_TABLES 7→9 + comentarios) |
| 4 | `test/verify-rls-enabled.test.ts` | EDIT (paths, conteos 7→9, test "unexpected") |

### Scope OUT explícito (PROHIBIDO tocar)
- NO `src/services/registry.ts` ni `src/services/llm/transform.ts` (ya 100% service_role).
- NO `CREATE POLICY` (ni permisiva ni `WITH CHECK`).
- NO `FORCE ROW LEVEL SECURITY`.
- NO agregar columna `owner_ref` (ya existe en ambas tablas).
- NO tablas sin `owner_ref` (`a2a_tasks`, `a2a_events`, cache).
- NO cualquier archivo fuera de la lista de 4.

---

## 2. Anti-Hallucination Checklist (específico de esta HU)

- [ ] Timestamp `20260610000000` está libre (verificado F2: última = `20260609000000_wkh_sec02b_owner_ref_rpc.sql`).
- [ ] Las 2 tablas existen con `owner_ref`: `registries` (`TEXT NOT NULL DEFAULT 'system'`), `kite_schema_transforms` (`TEXT` nullable). NO crear columna.
- [ ] El único cliente Supabase es `service_role` (`src/lib/supabase.ts` → `createClient(url, SUPABASE_SERVICE_KEY)`). NO hay cliente anon → AC-4 por construcción.
- [ ] El exemplar literal del up/down es `20260607000000_wkh_sec02_rls.sql` / `_down.sql` — espejá su forma EXACTA (BEGIN/COMMIT, 1 ALTER por tabla, comentario de cabecera, sin FORCE, sin policy).
- [ ] El test usa `countDdlStatements` (regex de sentencia completa), NO `includes(...)` crudo (lección SEC-02 auto-blindaje [2026-06-20 03:19]).
- [ ] El test "unexpected" hoy usa `registries` (L54-58); al entrar `registries` al set canónico, DEBE reescribirse usando `a2a_tasks` (tabla SIN `owner_ref`, fuera del set).

---

## 3. Constraint Directives (CD-1..8) — por wave

| CD | Wave | Regla |
|----|------|-------|
| **CD-1** | W0.1 | PROHIBIDO `CREATE POLICY` en el up (ni permisiva ni `WITH CHECK`). Deny-default = solo `ENABLE`. |
| **CD-2** | W0.1 | PROHIBIDO `FORCE ROW LEVEL SECURITY`. Solo `ENABLE` (service_role bypassa por `BYPASSRLS`, no por ownership). |
| **CD-3** | W0.2 | OBLIGATORIO que el down use `DISABLE ROW LEVEL SECURITY` (NO `DROP TABLE`, NO `DROP POLICY` — no se creó ninguna). |
| **CD-4** | W0.1, W0.2 | OBLIGATORIO envolver ambas migraciones en `BEGIN;` … `COMMIT;` (atomicidad). |
| **CD-5** | todas | PROHIBIDO tocar `src/`. Cero código de producción. |
| **CD-6** | W0.1, W0.2 | PROHIBIDO `CREATE [OR REPLACE] FUNCTION` (es DDL de tablas, sin RPC). |
| **CD-7** | W1.2 | OBLIGATORIO: el test estructural del `.sql` cuenta sentencias DDL completas vía `countDdlStatements` (espera **2**), NO `includes('ENABLE ROW LEVEL SECURITY')` crudo. Ref: WKH-SEC-02 auto-blindaje [2026-06-20 03:19] (el comentario de cabecera menciona la operación y rompe el substring). |
| **CD-8** | W1.2 | OBLIGATORIO: reescribir el test "unexpected" (`test/verify-rls-enabled.test.ts` L54-58, que hoy usa `registries`) para usar `a2a_tasks` (tabla SIN `owner_ref`, fuera del set canónico). Sin esto el test queda contradictorio. |
| **CD-9** | todas | PROHIBIDO modificar archivos fuera de los 4 del Scope IN. |

---

## 4. Waves (orden SERIAL — W0 → W1)

### Wave 0 — DDL (serial)

#### W0.1 — Crear el up
Path: `supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql`

**Contenido literal (copiar exacto):**

```sql
-- WKH-SEC-02c (2026-06-22) — RLS defensa en profundidad (DT-1, DT-2, DT-4).
-- Spinoff de WKH-SEC-02: habilita ROW LEVEL SECURITY en las 2 tablas con
-- owner_ref que quedaron fuera de ese scope (registries, kite_schema_transforms).
-- Sin FORCE (DT-4): service_role bypassa por BYPASSRLS; FORCE solo afecta al
-- table owner, no a service_role. Sin policy permisiva (DT-1): ENABLE sin
-- policy => deny-all para anon/authenticated (deny-by-default), service_role
-- bypassa nativamente. ENABLE es idempotente (re-aplicable sin error, AC-6).
BEGIN;

ALTER TABLE public.registries             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kite_schema_transforms ENABLE ROW LEVEL SECURITY;

COMMIT;
```

> Verificación CD-1/CD-2/CD-4/CD-6: no hay `CREATE POLICY`, no hay `FORCE`, no hay `CREATE … FUNCTION`, está dentro de `BEGIN;`/`COMMIT;`.

#### W0.2 — Crear el down
Path: `supabase/migrations/20260610000000_wkh_sec02c_rls_registries_down.sql`

**Contenido literal (copiar exacto):**

```sql
-- WKH-SEC-02c down-migration — revierte RLS en las 2 tablas (AC-3).
-- DISABLE ROW LEVEL SECURITY es idempotente (re-aplicable sin error).
-- NOTA OPS (DT-6): este down NO pasa por `npm run migrate:preflight`. El
-- analizador estático marca DISABLE ROW LEVEL SECURITY como HIGH (correcto para
-- un DISABLE accidental en un up). Aquí es un DISABLE deliberado: se aplica
-- directo via Management API, igual que el up.
BEGIN;

ALTER TABLE public.registries             DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.kite_schema_transforms DISABLE ROW LEVEL SECURITY;

COMMIT;
```

> Verificación CD-3/CD-4: solo `DISABLE` (sin DROP), dentro de `BEGIN;`/`COMMIT;`.

#### W0.3 — Preflight del up (CLI)
```bash
npm run migrate:preflight supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql
```
Esperado: **PASS** (`ENABLE` no es HIGH). El down NO se pasa por preflight (DT-6).

---

### Wave 1 — Verificación (tras W0)

#### W1.1 — Editar `scripts/verify-rls-enabled.mjs` (7→9)

**Cambio A — el array `RLS_TABLES` (líneas 21-29 actuales):**

Reemplazar:
```js
export const RLS_TABLES = [
  'a2a_agent_keys',
  'a2a_key_sessions',
  'a2a_delegations',
  'a2a_key_deposits',
  'a2a_receipts',
  'a2a_key_spend_policies',
  'a2a_key_dest_spend_ledger',
];
```
por:
```js
export const RLS_TABLES = [
  'a2a_agent_keys',
  'a2a_key_sessions',
  'a2a_delegations',
  'a2a_key_deposits',
  'a2a_receipts',
  'a2a_key_spend_policies',
  'a2a_key_dest_spend_ledger',
  'registries',
  'kite_schema_transforms',
];
```

**Cambio B — comentario de cabecera del array (líneas 19-20 actuales):**

Reemplazar:
```js
// Las 7 tablas EXACTAS con owner_ref (set canónico, WKH-SEC-02). Definidas una
// sola vez y reusadas para construir el query y para validar el resultado.
```
por:
```js
// Las 9 tablas EXACTAS con owner_ref (set canónico, WKH-SEC-02 + WKH-SEC-02c).
// Definidas una sola vez y reusadas para construir el query y validar el resultado.
```

> `buildRlsQuery()`, `evaluateRlsRows()` y los logs ya usan `RLS_TABLES`/`.length` → se propagan solos.
> (Opcional, no bloqueante: el JSDoc de cabecera del archivo y de `buildRlsQuery` dicen "7 tablas" — podés actualizar a "9 tablas". No cambia comportamiento.)

#### W1.2 — Editar `test/verify-rls-enabled.test.ts` (7→9 + CD-7 + CD-8)

**Cambio A — paths del `.sql` (líneas 17-18 actuales):**

Reemplazar:
```ts
const UP_PATH = resolve(MIGRATIONS, '20260607000000_wkh_sec02_rls.sql');
const DOWN_PATH = resolve(MIGRATIONS, '20260607000000_wkh_sec02_rls_down.sql');
```
por:
```ts
const UP_PATH = resolve(MIGRATIONS, '20260610000000_wkh_sec02c_rls_registries.sql');
const DOWN_PATH = resolve(MIGRATIONS, '20260610000000_wkh_sec02c_rls_registries_down.sql');
```

**Cambio B — test "7/7 enabled" (líneas 31-37): renombrar a 9/9.** Solo cambia el título; el cuerpo usa `allEnabled()` (derivado de `TABLES`).

Reemplazar:
```ts
  it('7/7 enabled → ok=true (exit 0)', () => {
```
por:
```ts
  it('9/9 enabled → ok=true (exit 0)', () => {
```

**Cambio C — test "tabla inesperada" (líneas 54-59, CD-8).** Hoy usa `registries` como inesperada; ahora `registries` es esperada → usar `a2a_tasks` (sin owner_ref, fuera del set).

Reemplazar:
```ts
  it('tabla inesperada en el set → ok=false (exit 1)', () => {
    const rows = [...allEnabled(), { table_name: 'registries', rls_enabled: true }];
    const result = evaluateRlsRows(rows);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toContain('registries');
  });
```
por:
```ts
  it('tabla fuera del set canónico → ok=false, unexpected (exit 1)', () => {
    // a2a_tasks NO tiene owner_ref → fuera del set de 9 (CD-8). registries ahora
    // SÍ es esperada, por eso no puede usarse como "unexpected".
    const rows = [...allEnabled(), { table_name: 'a2a_tasks', rls_enabled: true }];
    const result = evaluateRlsRows(rows);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toContain('a2a_tasks');
  });
```

**Cambio D — test "respuesta vacía" (líneas 61-65): 7→9.**

Reemplazar:
```ts
  it('respuesta vacía → ok=false, faltan las 7', () => {
    const result = evaluateRlsRows([]);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(7);
  });
```
por:
```ts
  it('respuesta vacía → ok=false, faltan las 9', () => {
    const result = evaluateRlsRows([]);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(9);
  });
```

**Cambio E — test `buildRlsQuery` "exactamente las 7" (líneas 72-79): 7→9.**

Reemplazar:
```ts
  it('consulta exactamente las 7 tablas esperadas', () => {
    expect(TABLES).toHaveLength(7);
```
por:
```ts
  it('consulta exactamente las 9 tablas esperadas', () => {
    expect(TABLES).toHaveLength(9);
```

**Cambio F — test up estructural "7 ENABLE" (líneas 103-104, CD-7).** El `for (const t of TABLES)` ya recorre las 9 — solo cambia el conteo y el título.

Reemplazar:
```ts
  it('tiene 7 ENABLE ROW LEVEL SECURITY, uno por tabla', () => {
    expect(countDdlStatements(sql, 'ENABLE')).toBe(7);
```
por:
```ts
  it('tiene 2 ENABLE ROW LEVEL SECURITY, uno por tabla', () => {
    expect(countDdlStatements(sql, 'ENABLE')).toBe(2);
```

> ⚠️ El nuevo `.sql` tiene SOLO 2 tablas (`registries`, `kite_schema_transforms`), no las 9 del set canónico. El bucle `for (const t of TABLES)` que valida `ALTER TABLE public.${t}` FALLARÍA contra el nuevo archivo porque las otras 7 tablas NO están en este `.sql`. Hay que acotar el bucle a las 2 tablas de ESTA migración.

Reemplazar el cuerpo completo del bloque (líneas 103-109):
```ts
  it('tiene 7 ENABLE ROW LEVEL SECURITY, uno por tabla', () => {
    expect(countDdlStatements(sql, 'ENABLE')).toBe(7);
    for (const t of TABLES) {
      expect(sql).toContain(`ALTER TABLE public.${t}`);
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY;`));
    }
  });
```
por:
```ts
  it('tiene 2 ENABLE ROW LEVEL SECURITY, una por tabla (registries, kite_schema_transforms)', () => {
    expect(countDdlStatements(sql, 'ENABLE')).toBe(2);
    for (const t of ['registries', 'kite_schema_transforms']) {
      expect(sql).toContain(`ALTER TABLE public.${t}`);
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY;`));
    }
  });
```

**Cambio G — test down estructural "7 DISABLE" (líneas 133-138, CD-7).** Mismo razonamiento: el down nuevo tiene 2 tablas.

Reemplazar:
```ts
  it('tiene 7 DISABLE ROW LEVEL SECURITY, uno por tabla', () => {
    expect(countDdlStatements(sql, 'DISABLE')).toBe(7);
    for (const t of TABLES) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+DISABLE ROW LEVEL SECURITY;`));
    }
  });
```
por:
```ts
  it('tiene 2 DISABLE ROW LEVEL SECURITY, una por tabla (registries, kite_schema_transforms)', () => {
    expect(countDdlStatements(sql, 'DISABLE')).toBe(2);
    for (const t of ['registries', 'kite_schema_transforms']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+DISABLE ROW LEVEL SECURITY;`));
    }
  });
```

> Los demás tests (FORCE, CREATE POLICY, CREATE FUNCTION, BEGIN/COMMIT, `una tabla false`, `tabla faltante`, `pg_class`) NO requieren cambios: validan propiedades del `.sql`/función que siguen siendo ciertas. El de "tabla faltante" usa `a2a_receipts` que sigue en el set → OK. El de "una tabla false" usa `TABLES[2]` (`a2a_delegations`) → OK.

#### W1.3 — Verde local
```bash
npm run test    # vitest — suite completa verde
npx tsc --noEmit # 0 errores
npm run lint     # 0 errores
```

---

### Wave 2 — Deploy (manual, fuera de vitest — NO es parte de F3 automatizable)
Documentado en SDD §13. El Dev deja W2 para el paso de ops post-merge:
1. Dev apply (up) vía Management API → `bdwvrwzvsldephfibmuu`.
2. `node scripts/verify-rls-enabled.mjs` → **9/9** true.
3. Smoke registry CRUD + transform cache → service_role idéntico.
4. Re-aplicar up (idempotencia, AC-6) → sin error.
5. Prod apply + verify 9/9 + smoke (`caldzjhjgctpgodldqav`).

---

## 5. Patrones a seguir (exemplars verificados)

| Patrón | Exemplar (path real verificado) |
|--------|--------------------------------|
| Up migration (BEGIN/COMMIT, 1 ALTER/tabla, comentario cabecera, sin FORCE/policy) | `supabase/migrations/20260607000000_wkh_sec02_rls.sql` |
| Down migration (DISABLE, NOTA OPS DT-6) | `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` |
| `RLS_TABLES` / `buildRlsQuery` / `evaluateRlsRows` | `scripts/verify-rls-enabled.mjs` (mismo archivo) |
| `countDdlStatements` (regex sentencia completa, no substring) | `test/verify-rls-enabled.test.ts` L93-98 (ya presente, reusar) |

---

## 6. Test Plan (≥1 por AC — 6 ACs)

| AC | Qué valida | Archivo | Caso (it) |
|----|-----------|---------|-----------|
| **AC-1** (`relrowsecurity=true` tras up) | up tiene 2 ENABLE, una por tabla | `test/verify-rls-enabled.test.ts` | `tiene 2 ENABLE ROW LEVEL SECURITY, una por tabla (registries, kite_schema_transforms)` (vía `countDdlStatements('ENABLE')===2`) |
| **AC-2** (deny-default, sin policy) | up sin CREATE POLICY ni FORCE + tabla fuera-del-set → unexpected | `test/verify-rls-enabled.test.ts` | `no crea ninguna policy …` + `no usa FORCE …` + `tabla fuera del set canónico → ok=false, unexpected` |
| **AC-3** (down DISABLE x2, estado previo) | down tiene 2 DISABLE, una por tabla | `test/verify-rls-enabled.test.ts` | `tiene 2 DISABLE ROW LEVEL SECURITY, una por tabla (…)` (vía `countDdlStatements('DISABLE')===2`) |
| **AC-4** (service_role sin cambio) | confirmado por construcción (único cliente = service_role, `src/lib/supabase.ts`) + smoke manual W2 | smoke E2E dev (W2.3) | registry CRUD + transform cache hit/miss → idéntico |
| **AC-5** (verify reporta 9/9) | `buildRlsQuery` consulta 9 tablas + `evaluateRlsRows` 9/9 → ok=true + vacío → 9 missing | `test/verify-rls-enabled.test.ts` | `consulta exactamente las 9 tablas esperadas` + `9/9 enabled → ok=true` + `respuesta vacía → ok=false, faltan las 9` |
| **AC-6** (idempotencia re-aplicar up) | ENABLE idempotente; up envuelto en BEGIN/COMMIT + preflight PASS | `test/verify-rls-enabled.test.ts` (`envuelve … BEGIN; … COMMIT;`) + W0.3 preflight + W2.4 re-apply manual | estructura BEGIN/COMMIT + preflight PASS + re-aplicar dev sin error |

> Nota: "anon denegado" no se testea en CI (no hay BD con roles `anon`/`authenticated` reales). Se cubre por ausencia verificada de policy (deny-default por construcción) + smoke manual dev antes de prod (igual que SEC-02).

---

## 7. Definition of Done

- [ ] `supabase/migrations/20260610000000_wkh_sec02c_rls_registries.sql` creado (up, 2 ENABLE, BEGIN/COMMIT, sin FORCE/policy/función).
- [ ] `supabase/migrations/20260610000000_wkh_sec02c_rls_registries_down.sql` creado (down, 2 DISABLE, BEGIN/COMMIT, sin DROP).
- [ ] `scripts/verify-rls-enabled.mjs` con `RLS_TABLES` de 9 entradas (incl. `registries`, `kite_schema_transforms`).
- [ ] `test/verify-rls-enabled.test.ts` actualizado: paths nuevos, conteos 9 (y 2 por `.sql`), test "unexpected" usa `a2a_tasks` (CD-8), conteo DDL vía `countDdlStatements` (CD-7).
- [ ] `npx tsc --noEmit` → **0 errores**.
- [ ] `npm run lint` → **0 errores**.
- [ ] `npm run test` → **suite verde** (toda la suite, no solo este archivo).
- [ ] ≥1 test por AC (AC-1..6) presente y verde (los que aplican en CI; AC-4/AC-6 completan en W2 manual).
- [ ] `npm run migrate:preflight <up>` → PASS (W0.3).
- [ ] NINGÚN archivo fuera de los 4 del Scope IN fue modificado (CD-9). Sin tocar `src/` (CD-5).
- [ ] Sin `CREATE POLICY`, sin `FORCE`, sin `CREATE … FUNCTION` en ninguna migración (CD-1, CD-2, CD-6).

---

*Story File generado por NexusAgil — Architect F2.5. El Dev SOLO lee este archivo.*
