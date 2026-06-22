# Work Item — [WKH-SEC-02c] RLS Postgres-level en `registries` y `kite_schema_transforms`

## Resumen

Extiende la defensa RLS establecida por WKH-SEC-02 a las dos tablas con `owner_ref` que quedaron fuera de ese scope: `registries` y `kite_schema_transforms`. El objetivo es uniformidad: toda tabla con `owner_ref` en el proyecto tiene `ENABLE ROW LEVEL SECURITY` (deny-by-default para roles `anon`/`authenticated`). El servicio usa 100% `service_role` (BYPASSRLS), por lo que cero cambio de comportamiento en producción.

Spinoff explícito de `doc/sdd/116-wkh-sec-02-rls/report.md` §6 y §8.

---

## F0 Grounding — Hallazgos verificados

| Hecho | Evidencia |
|-------|-----------|
| Único cliente Supabase: `SUPABASE_SERVICE_KEY` (service_role) | `src/lib/supabase.ts:29` — `createClient(url, key)` donde `key = process.env.SUPABASE_SERVICE_KEY` |
| Cero acceso `anon`/`authenticated` a `registries` | `src/services/registry.ts` — todas las queries usan el singleton `supabase` (service_role). No existe segundo cliente anon. |
| Cero acceso `anon`/`authenticated` a `kite_schema_transforms` | `src/services/llm/transform.ts` — `getFromL2`, `persistToL2`, `update hit_count` usan el mismo singleton `supabase`. |
| `registries.owner_ref` existe | `supabase/migrations/20260427210000_registries_owner_ref.sql` — `ALTER TABLE registries ADD COLUMN IF NOT EXISTS owner_ref TEXT NOT NULL DEFAULT 'system'` |
| `kite_schema_transforms.owner_ref` existe | `supabase/migrations/20260427230000_kite_schema_transforms_owner.sql` — `ALTER TABLE kite_schema_transforms ADD COLUMN IF NOT EXISTS owner_ref TEXT` (nullable) |
| Patrón SEC-02 exacto | `supabase/migrations/20260607000000_wkh_sec02_rls.sql` — `ENABLE ROW LEVEL SECURITY` sin `FORCE`, sin policy, `BEGIN/COMMIT` |
| Down script SEC-02 | `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql` — `DISABLE ROW LEVEL SECURITY` en `BEGIN/COMMIT` |

**Nota sobre `kite_schema_transforms.owner_ref` nullable**: la columna admite NULL (filas legacy pre-WKH-60). El ENABLE RLS aplica exactamente igual: deny-default para `anon`/`authenticated` en TODOS los rows, incluidos los de owner_ref NULL. El servicio (service_role) bypassa RLS independientemente del valor de owner_ref.

---

## Sizing

- **SDD_MODE**: mini (patrón idéntico a SEC-02, sin lógica nueva en app-layer)
- **Estimación**: S
- **Smart Sizing**: FAST+AR justificable (patrón 1:1 con SEC-02, no hay cambio de comportamiento, cero código de producción). Sin embargo, por política del proyecto (RLS en prod = cuidado) se mantiene **QUALITY** con AUTO permitido.
- **Branch sugerido**: `feat/118-wkh-sec-02c-rls-registries`

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN la migración up se aplica, the system SHALL tener `relrowsecurity = true` en `pg_class` para las tablas `registries` y `kite_schema_transforms` (verificable con el script `verify-rls-enabled.mjs`).

- **AC-2**: WHILE el cliente es `anon` o `authenticated` (no service_role), the system SHALL denegar cualquier SELECT/INSERT/UPDATE/DELETE sobre `registries` y `kite_schema_transforms` por deny-default (ENABLE sin policy = deny-all para non-bypass roles).

- **AC-3**: WHEN la migración down se aplica, the system SHALL deshabilitar RLS en ambas tablas (`DISABLE ROW LEVEL SECURITY`), dejando el estado idéntico al previo al up.

- **AC-4**: WHILE el servicio opera con `SUPABASE_SERVICE_KEY` (service_role, BYPASSRLS), the system SHALL ejecutar todas las queries sobre `registries` y `kite_schema_transforms` sin error y sin cambio de comportamiento observable (cero regresión funcional).

- **AC-5**: WHEN el script `verify-rls-enabled.mjs` se ejecuta tras el up, the system SHALL reportar `relrowsecurity = true` para `registries` y `kite_schema_transforms` (además de las 7 tablas ya verificadas de SEC-02).

- **AC-6**: WHEN la migración up se aplica dos veces (idempotencia), the system SHALL no producir error (ENABLE es idempotente en Postgres).

---

## Scope IN

| Artefacto | Descripción |
|-----------|-------------|
| `supabase/migrations/<timestamp>_wkh_sec02c_rls_registries.sql` | Migración up: `ENABLE ROW LEVEL SECURITY` en `registries` y `kite_schema_transforms`. `BEGIN/COMMIT`. |
| `supabase/migrations/<timestamp>_wkh_sec02c_rls_registries_down.sql` | Migración down: `DISABLE ROW LEVEL SECURITY` en ambas tablas. `BEGIN/COMMIT`. |
| `scripts/verify-rls-enabled.mjs` | Actualizar el script existente para incluir `registries` y `kite_schema_transforms` en la lista de tablas verificadas. |
| `test/verify-rls-enabled.test.ts` | Actualizar el test para incluir las 2 nuevas tablas (total: 9 tablas verificadas). |

---

## Scope OUT

- Cualquier cambio en `src/services/registry.ts` o `src/services/llm/transform.ts` — el servicio ya es 100% service_role, no requiere adaptación.
- Creación de políticas RLS permisivas (CREATE POLICY) — la defensa es deny-by-default, sin política = deny-all para non-bypass.
- Cambio en el flag `FORCE` — service_role bypassa por BYPASSRLS (propiedad del rol), no por FORCE (que solo afecta al table owner). Sin FORCE, igual que SEC-02.
- Agregar `owner_ref` donde no existe — ambas columnas ya existen (verificado en F0).
- WKH-SEC-02b (validar `p_owner_ref` en `increment_a2a_key_spend`) — HU separada.
- Tablas sin `owner_ref` (`a2a_tasks`, `a2a_events`, `a2a_transform_cache`) — fuera de scope explícito.

---

## Decisiones técnicas

- **DT-1**: Replicar patrón SEC-02 exacto: `ENABLE ROW LEVEL SECURITY` sin `FORCE`, sin CREATE POLICY, `BEGIN/COMMIT`. Justificación: patrón ya auditado y verificado en prod para 7 tablas; divergir añade riesgo sin beneficio.
- **DT-2**: Timestamp de migración nuevo (distinto al de SEC-02) para evitar colisión de nombres en el sistema de migraciones de Supabase. El timestamp debe ser posterior a `20260607000000`.
- **DT-3**: El script `verify-rls-enabled.mjs` se extiende (no se duplica) para cubrir las 2 nuevas tablas. La lista de tablas verificadas pasa de 7 a 9. El test `verify-rls-enabled.test.ts` se actualiza en paralelo.
- **DT-4**: `kite_schema_transforms.owner_ref` es nullable (por diseño WKH-60 para filas legacy). Esto no afecta RLS: ENABLE sin policy = deny-all para anon/authenticated en todos los rows, el valor de owner_ref es irrelevante para el deny-default.

---

## Constraint Directives

- **CD-1**: PROHIBIDO agregar `WITH CHECK OPTION` o `CREATE POLICY` permisivas. El deny-default no necesita policy; agregarla podría abrir accesos no previstos.
- **CD-2**: PROHIBIDO usar `FORCE ROW LEVEL SECURITY`. El client es service_role (BYPASSRLS); FORCE afecta al table owner (postgres), no a service_role. Divergir del patrón SEC-02 sin justificación.
- **CD-3**: OBLIGATORIO que la migración down use `DISABLE ROW LEVEL SECURITY` (no DROP TABLE, no DROP POLICY). Rollback limpio en <30s.
- **CD-4**: OBLIGATORIO que ambas migraciones estén envueltas en `BEGIN/COMMIT` para atomicidad.

---

## Missing Inputs

- El timestamp exacto de la migración se define en F2/F2.5 (se tomará el timestamp del día de implementación). No es bloqueante.
- No hay inputs faltantes que bloqueen el avance a F2.

---

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs activas (es puramente aditiva en DB, sin cambio en app-layer).
- Puede correr en paralelo con WKH-SEC-02b (que toca RPCs, no tablas directas).
- Depende de: nada (SEC-02 ya está DONE y en prod, el patrón está probado).
- Riesgo de conflicto en `_INDEX.md`: coordinado (NNN 118 reservado para esta HU en el batch actual).
- Riesgo de conflicto en `scripts/verify-rls-enabled.mjs`: si otra HU del batch modifica ese archivo simultáneamente, se necesita merge. Bajo riesgo (el script es de ops, no de negocio).
