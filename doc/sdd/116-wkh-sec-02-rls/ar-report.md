# AR Report — #116 [WKH-SEC-02] RLS Postgres-level (defensa en profundidad)

> Adversary Review (F3 → AR) — NexusAgil QUALITY
> Fecha: 2026-06-20
> Branch: feat/116-wkh-sec-02-rls
> Reviewer: nexus-adversary
> Subject (untracked, este HU): 4 archivos
>   - supabase/migrations/20260607000000_wkh_sec02_rls.sql
>   - supabase/migrations/20260607000000_wkh_sec02_rls_down.sql
>   - scripts/verify-rls-enabled.mjs
>   - test/verify-rls-enabled.test.ts

## Veredicto: APROBADO

Cero BLOQUEANTES. 1 MENOR (informativo, no bloquea DONE). El claim central
—service_role bypassa RLS, cero impacto en el servicio en vivo— está VERIFICADO
de punta a punta. La superficie de ataque crítica (¿algún acceso a las 7 tablas
con rol != service_role?) fue auditada repo-wide y resultó vacía.

---

## Evidencia de las pruebas ejecutadas

| Check | Resultado |
|-------|-----------|
| `npm test` | **1579 passed, 3 skipped** (e2e real, requieren creds) — esperado |
| `npx tsc --noEmit` | 0 errores |
| `npm run lint` (`biome check src/`) | exit 0 (1 info pre-existente en `reputation.ts`, NO de este HU) |
| `migrate:preflight` UP | **PASS** (ENABLE no es HIGH; solo MEDIUM informativo por `COMMIT;`) |
| `migrate:preflight` DOWN | **BLOCKED/HIGH** — correcto y esperado (DT-6: el down se aplica directo, no por preflight) |
| Timestamp `20260607000000` | único en `supabase/migrations/` |
| Smoke `verify-rls-enabled.mjs` (deps inyectadas) | sin config → exit 3; `rls_enabled:'t'` → flag disabled (fail-safe); 7 tablas |

---

## Ataque central: ¿RLS rompe el servicio en vivo?

**NO.** Verificado:

1. **Cliente 100% service_role.** `src/lib/supabase.ts:12` usa
   `process.env.SUPABASE_SERVICE_KEY` (no anon). Es el ÚNICO `createClient` de
   runtime de producción. Singleton exportado, importado por todos los services.
2. **Cero clientes anon en el repo.** `grep -rn "ANON|publishable|anon"` sobre
   `src/` y `scripts/` → 0 resultados de cliente anon. No hay edge functions
   (`supabase/functions` no existe).
3. **Otros `createClient` auditados, todos service_role:**
   - `scripts/check-schema-hash.mjs:24` → `SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_SERVICE_KEY`, y solo toca `kite_schema_transforms` (NO una de las 7).
   - `src/__tests__/e2e/*.real.test.ts` → `INTEGRATION_TEST_SERVICE_KEY` (service_role); además `skipIf` sin creds.
   - `scripts/hackathon-e2e.mjs` / `verify-rls-enabled.mjs` → Management API con PAT (`SUPABASE_ACCESS_TOKEN`), no es un rol de datos sujeto a RLS.
   - `scripts/smoke-prod-deposit.mjs` → pega al servicio por HTTP, que internamente usa service_role.
4. **Conclusión:** todo acceso a las 7 tablas pasa por service_role (BYPASSRLS).
   `ENABLE` sin policy no cambia el comportamiento del servicio. AC-3/AC-5 OK.

---

## Ataque: ¿las 7 tablas son las correctas? ¿gap de cobertura?

- Las 7 EXISTEN y cada una tiene `owner_ref TEXT NOT NULL` (verificado en sus
  CREATE TABLE: a2a_agent_keys L10, a2a_key_sessions L4, a2a_delegations L14,
  a2a_key_deposits L10, a2a_receipts L8, a2a_key_spend_policies L13,
  a2a_key_dest_spend_ledger L39). El set del .mjl/.sql/test coincide exactamente.
- `registries` y `kite_schema_transforms` TAMBIÉN tienen `owner_ref`
  (20260427210000, 20260427230000) pero están EXCLUIDAS por CD-9/Out-of-Scope.
  Se acceden vía el mismo singleton service_role (`registry.ts`, `transform.ts`),
  por lo que excluirlas NO rompe nada y NO abre un hueco explotable: la defensa
  app-layer + service_role sigue. Es decisión de scope documentada, no finding.
  (Ver MNR-1 abajo: vale dejar trazado que NO son "todas las tablas con owner_ref".)

---

## ENABLE sin policy = deny-all, sin FORCE

- `ENABLE ROW LEVEL SECURITY` sin ninguna `CREATE POLICY` → Postgres deniega por
  defecto a todo rol non-bypass (anon/authenticated). Correcto (AC-2).
- `FORCE` NO hace falta: solo afecta al table-owner, no a service_role, que
  bypassa por el atributo `BYPASSRLS`. Decisión DT-4 segura, sin hueco.
- Test estructural confirma: 7 ENABLE, 0 FORCE, 0 CREATE POLICY, 0 CREATE FUNCTION
  (`test/verify-rls-enabled.test.ts:100-128`).

## Reversibilidad / Idempotencia

- Down: 7 `DISABLE ROW LEVEL SECURITY` en `BEGIN/COMMIT`, vuelve al estado previo
  (AC-4). `ENABLE`/`DISABLE` son idempotentes en PG (AC-6). Up y down envueltos en
  transacción → fallo parcial imposible.

---

## Las 8 categorías AR

### 1. Security — **OK**
DDL puro de RLS. Sin secrets en código. El verify usa PAT desde env, jamás lo
loguea (solo va en `Authorization: Bearer`, `verify-rls-enabled.mjs:141`); los
errlog imprimen status+body de la API (read-only query, sin PAT). RLS es defensa
en profundidad NUEVA, no remueve ninguna. Sin SQL dinámico, sin injection.

### 2. Error Handling — **OK**
`verify-rls-enabled.mjs`: `!res.ok` → log status+body + exit 1
(L146-149); config faltante → exit 3 (L129-132); `evaluateRlsRows` maneja `rows`
no-array (`Array.isArray` L78). `readEnv` ignora archivo ausente (try/catch).

### 3. Data Integrity — **OK**
Up/down en `BEGIN/COMMIT`. RLS no toca datos (solo flag de catálogo). Sin race:
es DDL one-shot de ops, no runtime concurrente.

### 4. Performance — **OK**
RLS ENABLE sin policy no añade overhead de evaluación de policy a service_role
(bypassa). Verify hace 1 SELECT read-only sobre `pg_class`. N/A loops/N+1.

### 5. Integration — **OK**
Backwards-compatible total: service_role intacto. Sin breaking change de contrato.
`migrate:preflight` UP=PASS, DOWN=HIGH (esperado, DT-6). Sin deps nuevas.

### 6. Type Safety — **OK**
`tsc --noEmit` 0 errores. `evaluateRlsRows` usa `=== true`/`!== true` estricto:
un `rls_enabled` truthy-no-boolean (ej. `'t'`) se trata como disabled →
fail-safe (bloquea deploy en vez de falso PASS). El `@ts-expect-error` del import
.mjs en el test es justificado (módulo JSDoc fuera de tsconfig src-only).

### 7. Test Coverage — **OK**
6 casos de `evaluateRlsRows` (7/7 ok, una false, faltante, inesperada, vacía) +
estructural up/down (conteo de DDL no-frágil ignorando comentarios — corrige el
bug del auto-blindaje 03:19) + assert de pg_class/no-information_schema. 100% mock,
sin red ni BD (CD-7). Cubre AC-1/2/4/6/7.

### 8. Scope Drift — **OK**
Solo los 4 archivos del Story File. `git status` confirma que NINGÚN `src/` ni
RPC ni tabla fuera de las 7 fue tocado por este HU (los demás archivos del diff
`main...HEAD` pertenecen a E16/WKH-118, ya mergeados aguas arriba, no a SEC-02).

### Categorías nuevas (9-11)
- **9. Destructive Migrations — OK.** No hay DROP/ALTER TYPE/UPDATE/TRUNCATE/rename.
  `ENABLE RLS` no destruye data ni schema; down reversible; ambos en transacción.
- **10. RPC SECURITY DEFINER — N/A.** Este HU NO crea ni modifica funciones
  (CD-12 verificado por test: 0 CREATE FUNCTION). La parte (B) sobre
  `increment_a2a_key_spend` está diferida a WKH-SEC-02b — fuera de scope.
- **11. Cache Invalidation — N/A.** No introduce ninguna capa de cache.

---

## Findings

### MNR-1 — Cobertura: "7 tablas con owner_ref" es exacto-por-scope, no exhaustivo
- **Categoría:** Integration / Data Integrity (informativo)
- **Evidencia:** `registries` (20260427210000_registries_owner_ref.sql:34) y
  `kite_schema_transforms` (20260427230000_kite_schema_transforms_owner.sql:36)
  tienen `owner_ref` pero quedan FUERA de RLS (CD-9, deliberado).
- **Impacto:** Ninguno hoy: ambas se acceden vía service_role (`registry.ts`,
  `llm/transform.ts`), la app-layer guard sigue. NO es un hueco explotable.
- **Por qué MENOR:** el Goal dice "las 7 tablas de usuario con owner_ref"; en
  rigor hay >7 tablas con owner_ref. La exclusión es correcta por scope, pero
  conviene que el backlog trackee si `registries`/`kite_schema_transforms`
  deben recibir RLS en una HU futura (defensa en profundidad uniforme).
- **Sugerencia (NO fixear en este HU):** dejar nota en BACKLOG/TD para evaluar
  RLS en esas 2 tablas en una iteración posterior. NO amplía scope de SEC-02.

---

## Gap de seguridad residual (con (B) diferida)

**Riesgo residual: BAJO y documentado.** La app-layer ownership guard (WKH-53)
sigue siendo la línea de defensa activa; RLS es backstop DB-level nuevo. La
parte (B) —ownership check dentro de `increment_a2a_key_spend`— se difiere a
WKH-SEC-02b, lo cual es aceptable porque la RPC ya está revocada de anon (su
único caller es service_role). Diferir (B) NO abre una vía de escalación nueva.

---

## Resumen para el orquestador

- **Veredicto: APROBADO.**
- BLOQUEANTES: 0. MENORES: 1 (MNR-1, informativo — NO bloquea DONE).
- `npm test`: 1579 pass / 3 skip. `tsc`: 0. `lint`: clean. preflight UP: PASS.
- El claim central (service_role bypassa RLS → cero regresión) está verificado
  repo-wide: 0 accesos a las 7 tablas con rol != service_role.
- Listo para avanzar a CR / F4. MNR-1 puede ir a backlog, no requiere fix-pack.
