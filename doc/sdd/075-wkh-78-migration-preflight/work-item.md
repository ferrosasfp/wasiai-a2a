# Work Item — [WKH-78] DB Migration Pre-flight Checks Runbook

> Fase F1 (analyst) — Sprint AUTO post-hackathon "production-100".
> Ticket: https://ferrosasfp.atlassian.net/browse/WKH-78
> SDD path: `doc/sdd/075-wkh-78-migration-preflight/`

---

## Resumen

Toda migration nueva al proyecto wasiai-a2a se aplica directamente en producción
(Supabase `caldzjhjgctpgodldqav`) sin verificación previa. No existe dry-run, shadow DB,
ni post-apply integrity check. Un `DROP COLUMN` accidental o un `ALTER TABLE` de larga
duración en una tabla crítica se descubre en prod — en el peor momento.

Esta HU produce un **runbook documentado** (`doc/runbooks/migration-preflight.md`) y un
**script de pre-flight** (`scripts/migrate-preflight.mjs`) que debe ejecutarse ANTES de
aplicar cualquier migration en producción. El script: corre la migration en la shadow DB
(proyecto dev `bdwvrwzvsldephfibmuu`), detecta operaciones de riesgo en el SQL, y produce
un reporte humano-readable. No modifica Supabase prod. No aplica migrations automáticamente.

**Para quién**: el equipo de desarrollo (Fernando + cualquier contribuidor futuro) y el
orquestador NexusAgil antes de mergear PRs que incluyan archivos SQL nuevos en `migrations/`.

**Por qué ahora**: post-hackathon, el esquema prod está estabilizándose (tablas
`a2a_agent_keys`, `a2a_registries`, `a2a_tasks`, `a2a_transform_cache`). La siguiente
fase del roadmap implica migrations DDL más complejas (RLS policies WKH-SEC-02, `owner_ref`
en `tasks` WKH-54). Sin pre-flight, cada migration es un salto de fe sobre prod.

---

## Sizing

- **SDD_MODE**: mini (el scope es tooling + runbook, sin cambios al código productivo)
- **Estimación**: S (1 script ~150 LOC, 1 runbook Markdown, 1 test del script, sin deps nuevas)
- **Pipeline**: FAST (runbook + scripts no requieren full QUALITY — sin cambios a payment path,
  sin nuevas superficies de ataque en producción, sin deps externas nuevas que no sean ya
  disponibles en el proyecto)
- **Branch sugerido**: `feat/075-wkh-78-migration-preflight`
- **Skills router**: (1) `db-migrations` (análisis estático SQL, shadow DB, rollback patterns),
  (2) `ops-runbook` (documentación operacional, checklists, decision trees)

---

## Contexto de audit — setup actual de migrations

Hallazgos del F0 audit (2026-05-01):

| Item | Estado |
|------|--------|
| Supabase CLI | No instalado en el proyecto |
| Directorio `supabase/migrations/` | No existe |
| Directorio `migrations/` | Existe — archivos SQL ad-hoc (`kite_001_registries.sql`, etc.) |
| Script `migrate:dry-run` en `package.json` | No existe |
| Shadow DB automatizada | No configurada |
| Post-apply integrity check | No existe |
| Forma actual de aplicar migrations | Manual: copy-paste en Supabase Dashboard SQL Editor |
| Prod project | `caldzjhjgctpgodldqav` (Railway env `DATABASE_URL`) |
| Dev/shadow project | `bdwvrwzvsldephfibmuu` (usado como shadow manual) |
| Archivos SQL existentes en scope | `migrations/kite_001_registries.sql` y otros ad-hoc |

**Conclusión**: el mecanismo actual es completamente manual, sin guardrails automatizados.
No hay Supabase CLI, no hay `supabase db push`, no hay migration versioning formal. El script
de pre-flight que se entrega en esta HU NO asume Supabase CLI — usa `psql` directo contra
`DATABASE_URL` (shadow DB) y análisis estático del SQL.

---

## Acceptance Criteria (EARS)

### AC-1 — Análisis estático del SQL (riesgo de DDL peligroso)

WHEN `scripts/migrate-preflight.mjs <archivo.sql>` se ejecuta, the system SHALL analizar el
contenido del archivo SQL y reportar como RIESGO-ALTO cualquiera de las siguientes operaciones:
`DROP TABLE`, `DROP COLUMN`, `DROP INDEX`, `TRUNCATE`, `ALTER TABLE ... DROP`, `ALTER TABLE ...
RENAME TO`, `DELETE FROM` sin cláusula `WHERE`. El reporte SHALL incluir: número de línea,
operación detectada, nivel de riesgo (`HIGH` / `MEDIUM` / `INFO`).

### AC-2 — Dry-run en shadow DB

WHEN `scripts/migrate-preflight.mjs <archivo.sql>` se ejecuta con `SHADOW_DATABASE_URL`
configurado, the system SHALL ejecutar la migration en la shadow DB dentro de una
TRANSACCIÓN que se hace ROLLBACK al final (never commits), y SHALL reportar: tiempo de
ejecución en ms, si la migration completó sin errores, el error exacto de Postgres si falló.
IF `SHADOW_DATABASE_URL` no está configurado, THEN the system SHALL saltar el paso de
dry-run con aviso `[WARN] SHADOW_DATABASE_URL not set — skipping shadow dry-run` y
continuar con el análisis estático.

### AC-3 — Gate de riesgo y bloqueo de apply automático

WHEN el análisis estático detecta al menos una operación de riesgo HIGH, OR WHEN el
dry-run en shadow DB reporta un tiempo de ejecución superior a 30 segundos, the system
SHALL imprimir `[BLOCKED] Migration requires human review before applying to production`
y SHALL terminar con exit code 1. WHEN ninguna condición de bloqueo se activa, the system
SHALL terminar con exit code 0 e imprimir `[PASS] Pre-flight OK — safe to apply`.

### AC-4 — Post-apply integrity check

WHEN `scripts/migrate-preflight.mjs --post-apply` se ejecuta con `DATABASE_URL` apuntando
a la DB donde se aplicó la migration (prod o shadow), the system SHALL verificar:
(a) que todas las tablas con prefijo `a2a_` siguen existentes (sin DROP inesperado),
(b) que los índices declarados en el SQL de la migration existen en la DB,
(c) que no hay constraints FK en estado `INVALID`. IF alguna verificación falla, THEN
the system SHALL imprimir `[FAIL] Integrity check failed: <detalle>` y terminar con
exit code 1.

### AC-5 — Sección rollback en el runbook

WHEN el archivo `doc/runbooks/migration-preflight.md` existe, the system SHALL incluir una
sección "Rollback de una migration fallida" que documente: (a) cómo restaurar desde un
backup Supabase Point-in-Time (PITR), (b) cómo revertir una migration DDL que no tiene
rollback automático (ALTER TABLE inverso, restaurar columna eliminada), (c) el template
de SQL de rollback que DEBE incluirse en cada nuevo archivo en `migrations/` como comentario
`-- ROLLBACK: <SQL inverso>` al final del archivo.

### AC-6 — Tests del script (unit, sin llamadas a DB real)

WHEN `npm test` corre, the system SHALL ejecutar tests de `scripts/migrate-preflight.mjs`
que usen mocks 100% (sin conexión a Supabase prod ni a shadow DB real) cubriendo: análisis
estático detecta DROP TABLE / DROP COLUMN / TRUNCATE correctamente, análisis estático
no bloquea en CREATE TABLE / CREATE INDEX / INSERT / UPDATE, exit code 1 en operación HIGH,
exit code 0 en migration sin operaciones peligrosas. El baseline de tests existente SHALL
seguir pasando sin regresiones.

### AC-7 — Integración en `package.json`

WHEN `npm run migrate:preflight -- migrations/<archivo>.sql` se ejecuta, the system SHALL
invocar `node scripts/migrate-preflight.mjs migrations/<archivo>.sql`. El script SHALL
funcionar con Node.js >=20 sin deps externas más allá de las ya en `package.json`
(o con `node:` built-ins solamente si no hay dep de DB disponible).

---

## Scope IN

1. `scripts/migrate-preflight.mjs` (NUEVO) — script pre-flight: análisis estático + shadow
   dry-run + post-apply check. Node.js ESM, compatible Node >=20. Sin deps nuevas si posible;
   si se necesita cliente Postgres para el dry-run, usar `@supabase/supabase-js` ya en
   `dependencies`. Para `psql` nativo: F2 architect decide si invocar el binario via
   `child_process.spawn` o usar Supabase REST API.

2. `doc/runbooks/migration-preflight.md` (NUEVO) — runbook completo: pre-flight checklist,
   cómo correr el script, interpretación del reporte, gate de review humano, sección rollback
   (AC-5), template de archivo SQL con `-- ROLLBACK:` comment.

3. `package.json` (MODIFICAR) — agregar script `migrate:preflight` (AC-7). Solo una línea
   en `scripts`. No agregar deps nuevas si el script puede usar built-ins o deps existentes.

4. `test/migrate-preflight.test.ts` (NUEVO, opcional `.mjs` si vitest lo soporta) — tests
   unitarios del script con mocks (AC-6). Archivo en `test/` consistente con la estructura
   existente.

5. `.env.example` (MODIFICAR) — agregar `SHADOW_DATABASE_URL` con comentario explicativo
   (apunta a bdwvrwzvsldephfibmuu, NO a prod).

---

## Scope OUT

- NO modificar Supabase prod (`caldzjhjgctpgodldqav`) — ni su schema, ni sus datos.
- NO modificar las migrations existentes en `migrations/` — el pre-flight es prospectivo.
- NO introducir Supabase CLI ni `supabase db push` — la HU no cambia el workflow de apply,
  solo agrega el pre-flight previo.
- NO implementar migration versioning formal (ej. flyway, dbmate, liquibase) — eso es
  una HU separada si se decide formalizar.
- NO aplicar migrations automáticamente desde el script — el apply sigue siendo manual.
- NO agregar lógica de migration scheduling ni CI/CD integration — runbook solo.
- NO tocar `src/`, `mcp-servers/`, ni ningún código productivo del servidor.
- NO agregar dependencias de terceros para el análisis SQL (regex sobre el texto del archivo
  es suficiente para los patterns de riesgo).
- NO implementar lock advisory de Postgres (pg_advisory_lock) — fuera de scope.
- NO correr migrations automáticas en el startup del servidor.

---

## Decisiones técnicas (DT-N)

- **DT-1** [PARA F2]: ¿El dry-run usa `@supabase/supabase-js` (REST) o `psql` via
  `child_process.spawn`? Trade-off: REST es más portable (no requiere `psql` instalado en
  la máquina del dev), pero Supabase REST API tiene límites en transacciones multi-statement.
  `psql` es más directo contra el wire protocol de Postgres pero requiere el binario.
  Recomendación analyst: usar `@supabase/supabase-js` con RPC `sql` si disponible, o
  `DATABASE_URL` directo con un cliente simple. Architect decide.

- **DT-2** [PARA F2]: ¿El ROLLBACK transaccional del dry-run es via `BEGIN; <migration SQL>;
  ROLLBACK;` o via un savepoint? Recomendación: `BEGIN ... ROLLBACK` envuelto todo. Si la
  migration tiene DDL que auto-commit (ej. `CREATE TYPE` en Postgres dentro de una
  transacción), documentar la limitación. Postgres soporta DDL en transacciones, a diferencia
  de MySQL — esto funciona para el caso Supabase PostgreSQL.

- **DT-3** [CEMENTADO F1]: El script NO aplica la migration en prod. El apply sigue siendo
  100% manual. Esta restricción es INVIOLABLE en esta HU.

- **DT-4** [PARA F2]: ¿El post-apply check (`--post-apply`) es un sub-comando del mismo
  script o un script separado? Recomendación: sub-comando del mismo script (un solo archivo
  `migrate-preflight.mjs` con flags `--post-apply`). Más simple de documentar en el runbook.

- **DT-5** [PARA F2]: ¿Los tests del script son `.test.ts` (vitest + TypeScript) o
  `.test.mjs` (vitest + ESM nativo)? El proyecto usa `vitest` con TypeScript strict. Los
  tests existentes están en `test/*.test.ts`. Recomendación: `test/migrate-preflight.test.ts`
  con import del script como módulo. F2 architect verifica si el script puede exportar las
  funciones de análisis para testear sin side effects.

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO que el script (`migrate-preflight.mjs`) ejecute ninguna query de tipo
  DML/DDL con efecto permanente contra `DATABASE_URL` del prod. El dry-run SOLO se ejecuta
  contra `SHADOW_DATABASE_URL`. Si el dev accidentalmente apunta `SHADOW_DATABASE_URL` al
  prod project, el script NO puede diferenciarlo — el runbook DEBE documentar este riesgo
  explícitamente.

- **CD-2**: OBLIGATORIO que el dry-run envuelva el SQL en `BEGIN` + `ROLLBACK` (nunca
  `COMMIT`). Si la conexión se cae mid-transaction, Postgres auto-rollback. Cualquier
  implementación que pueda commitear el dry-run a la shadow DB es BLOQUEANTE en AR.

- **CD-3**: PROHIBIDO incluir `DATABASE_URL` o `SHADOW_DATABASE_URL` reales en el
  repositorio. `.env.example` con placeholders únicamente.

- **CD-4**: OBLIGATORIO que el script termine con exit code 1 cuando detecta operación HIGH
  o cuando el dry-run falla. El exit code es la señal para futuras integraciones CI. Exit
  code 0 significa "safe to proceed".

- **CD-5**: PROHIBIDO agregar deps nuevas a `dependencies` ni `devDependencies` del
  `package.json` raíz si el script puede funcionar con los built-ins de Node.js y con
  `@supabase/supabase-js` ya existente. Si F2 determina que se necesita una dep adicional
  (ej. `postgres` para client directo), documentarlo como bloqueante y escalar al humano.

- **CD-6**: OBLIGATORIO que los tests del script usen mocks 100% — sin conexiones reales a
  Supabase prod ni a la shadow DB durante `npm test`. El mismo patrón que los tests del
  proyecto principal (vitest mocks).

- **CD-7**: El template `-- ROLLBACK: <SQL>` en el runbook es RECOMENDACIÓN, no enforcement
  automático. El script NO debe bloquear migrations sin el comentario — eso sería excesivo
  en esta fase. Solo el runbook lo documenta como best practice.

---

## Missing Inputs

- **[RESUELTO F1]** Mecanismo actual de migrations — auditado en F0. No hay Supabase CLI,
  no hay shadow DB automática, las migrations son `.sql` ad-hoc aplicados manualmente via
  dashboard.
- **[RESUELTO F1]** Shadow DB candidate — es el proyecto dev existente
  (`bdwvrwzvsldephfibmuu`). El `SHADOW_DATABASE_URL` debe apuntar ahí.
- **[RESUELTO F1]** Sizing FAST confirmado — no toca código productivo, sin cambios a
  payment path, sin nuevas superficies de seguridad.
- **[NEEDS CLARIFICATION en F2]** DT-1: mecanismo de dry-run (Supabase JS REST vs psql vs
  postgres.js). Architect decide según portabilidad y limitaciones del plan Supabase.
- **[NEEDS CLARIFICATION en F2]** DT-2: comportamiento exacto del ROLLBACK transaccional
  con DDL multi-statement (ej. migration con CREATE TABLE + CREATE INDEX + INSERT).
- **[NEEDS CLARIFICATION en F2]** DT-5: estructura del test file (`.ts` vs `.mjs`) y si el
  script puede exportar las funciones de análisis o si se necesita un wrapper.
- **[NEEDS CLARIFICATION en F2]** ¿El directorio `doc/runbooks/` ya existe o debe crearse?
  [RESUELTO F1]: No existe — debe crearse en esta HU.

---

## Análisis de paralelismo

- **Bloquea otras HUs?** NO — esta HU no toca `src/`, no toca Supabase prod, no toca el
  schema. Puede correr en paralelo con cualquier HU de product features.
- **Es prerequisito para?** SÍ — cualquier futura HU que incluya migrations DDL complejas
  (WKH-54 `owner_ref` en tasks, WKH-SEC-02 RLS policies) DEBERÍA pasar el pre-flight antes
  de merge. Pero WKH-78 no bloquea esas HUs técnicamente — solo metodológicamente.
- **Branch conflicts?** Muy improbable. El scope está confinado a `scripts/`,
  `doc/runbooks/`, `test/`, `.env.example`, y la línea en `package.json`.
- **Puede correr en paralelo con WKH-Y?** Sí, con cualquier HU que no toque los mismos
  archivos (la única colisión potencial es `package.json` y `.env.example`, que son triviales
  de resolver en merge).

---

## Estado post-F1 (2026-05-01 modo AUTO)

- Audit F0 completo: mecanismo de migrations actual documentado, shadow DB identificada.
- 7 ACs en formato EARS, sin lenguaje vago.
- Scope IN/OUT explícito (5 archivos IN, sin código productivo).
- 5 DTs (1 cementado, 4 para F2).
- 7 CDs (seguridad + constraints del script).
- Sizing FAST confirmado.
- Branch propuesto: `feat/075-wkh-78-migration-preflight`.
- Listo para HU_APPROVED humano y luego F2 (architect).
