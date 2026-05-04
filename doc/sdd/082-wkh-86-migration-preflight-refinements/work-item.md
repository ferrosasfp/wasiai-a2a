# Work Item — [WKH-86] Migration Pre-flight Refinements (manifest + DROP IF EXISTS + security hardening)

> Fase F1 (analyst) — Sprint AUTO 2026-05-03.
> Origen: carry-forward MNRs del WKH-78 (DONE 2026-05-02, post fix-pack iter 1).
> SDD path: `doc/sdd/082-wkh-86-migration-preflight-refinements/`

---

## Resumen

WKH-78 entregó `scripts/migrate-preflight.mjs` (1003 LOC) con 754/754 tests pasando y 7 ACs
cumplidos. Al cierre, quedaron 4 MNRs de AR iter 2 y 5 MNRs de CR marcados como carry-forward
no bloqueantes. Esta HU cierra el subconjunto que tiene fix claro, costo acotado (~120 LOC,
~2h) y sin ambigüedad de scope:

- `a2a_events` falta en el manifest de tablas esperadas (one-liner).
- `DROP TRIGGER IF EXISTS` y `DROP FUNCTION IF EXISTS` falsan positivos HIGH sobre patrones
  canónicos de migración idempotente (5/13 archivos del repo los usan).
- `findDeleteWithoutWhere` puede matchear `DELETE` dentro de string literals por regex greedy.
- Findings duplicados cuando múltiples RISK_PATTERNS matchean la misma línea.
- `runPostApplyCheck` loguea errores pero no falla el gate (exit code sigue siendo 0).
- URL de conexión psql expuesta en `ps` listing via argv (information disclosure).
- `// @ts-expect-error` en el test en lugar de shim `.d.ts` apropiado.

**Para quién**: el equipo de desarrollo y NexusAgil pre-merge pipeline.
**Por qué ahora**: antes de que WKH-54 (owner_ref en tasks) y WKH-SEC-02 (RLS policies)
corran el preflight en prod — esos MNRs se convierten en defectos activos en ese momento.

---

## Sizing

- **SDD_MODE**: mini (refinements sobre script existente, sin cambios a código productivo)
- **Estimación**: S (~120 LOC delta, 2h estimadas)
- **Pipeline**: FAST (tooling-only, sin payment surface, sin nuevas deps, sin cambios a `src/`)
- **Branch sugerido**: `feat/082-wkh-86-migration-preflight-refinements`
- **Skills router**: (1) `db-migrations` (SQL static analysis, regex safety),
  (2) `security-tooling` (process arg exposure, credential hiding via env)

---

## Contexto heredado de WKH-78

El script en `scripts/migrate-preflight.mjs` es el archivo base. Los constraint directives
heredados siguen vigentes. Específicamente relevantes para esta HU:

- **CD-FP3** (WKH-78): NO se puede bajar la severidad de un pattern existente. Los fixes de
  `DROP TRIGGER IF EXISTS` / `DROP FUNCTION IF EXISTS` consisten en agregar una excepción
  (IF EXISTS present = no HIGH), no en cambiar la severidad del pattern base.
- **CD-FP1** (WKH-78): cada nuevo behavior change en RISK_PATTERNS DEBE tener al menos 2
  fixtures de test (un caso positivo + uno negativo).
- **CD-FP2** (WKH-78): splitStatements() no debe romper migraciones reales del repo.
- **CD-6** (WKH-78): tests 100% mocks, sin conexión a DB real durante `npm test`.

Baseline de tests al cierre de WKH-78: **754 tests pasando**.

---

## Acceptance Criteria (EARS)

### AC-1 — a2a_events en EXPECTED_A2A_TABLES (MNR-iter2-2)

WHEN `scripts/migrate-preflight.mjs --post-apply` se ejecuta, the system SHALL incluir
`a2a_events` en el array `EXPECTED_A2A_TABLES` junto a las tablas ya declaradas, de modo que
la verificación de integridad post-apply detecte un DROP accidental de esa tabla.

### AC-2 — DROP IF EXISTS no dispara HIGH (MNR-iter2-4)

WHEN el SQL de una migration contiene `DROP TRIGGER IF EXISTS <name>` OR
`DROP FUNCTION IF EXISTS <name>`, the system SHALL NOT emit a HIGH-risk finding for those
statements. WHEN el SQL contiene `DROP TRIGGER <name>` (sin `IF EXISTS`) OR
`DROP FUNCTION <name>` (sin `IF EXISTS`), the system SHALL emit a HIGH-risk finding (comportamiento
actual conservado).

### AC-3 — findDeleteWithoutWhere no matchea dentro de string literals (MNR-CR-2)

WHEN una migration SQL contiene la palabra `DELETE` dentro de un string literal (ej.
`INSERT INTO audit_log VALUES ('DELETE FROM old_table')`) y no contiene un statement
`DELETE FROM` real, the system SHALL NOT emit un HIGH-risk finding de "DELETE sin WHERE".

### AC-4 — Deduplicación de findings por línea+severidad (MNR-CR-3)

WHEN múltiples `RISK_PATTERNS` matchean el mismo statement SQL, the system SHALL emitir un
único finding de la severidad más alta, deduplicado por número de línea y nivel de riesgo,
sin repetir entradas para el mismo locus.

### AC-5 — runPostApplyCheck falla el gate en error (MNR-CR-4)

WHEN `runPostApplyCheck` detecta una tabla a2a_* faltante, un FK inválido, OR un índice
declarado ausente, the system SHALL terminar con exit code 1 (no solo loguear el error y
continuar con exit code 0).

### AC-6 — Credenciales no expuestas en ps listing (MNR-CR-1)

WHEN el script invoca `psql` para el shadow dry-run o el post-apply check, the system SHALL
NOT incluir la connection URL con credenciales como argumento posicional de `psql` en el
argv del proceso. La URL SHALL ser entregada a psql via la variable de entorno `PGPASSWORD`
más `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`, OR via stdin pipe, de forma que `ps aux` no
revele el password en texto plano.

### AC-7 — Baseline de tests preservado y @ts-expect-error eliminado (MNR-CR-5)

WHEN `npm test` corre, the system SHALL ejecutar 249 o más tests nuevos o existentes sin
regresiones (baseline WKH-78: 754; esta HU agrega tests para los nuevos comportamientos y
elimina el `// @ts-expect-error` del test existente, reemplazándolo por un shim `.d.ts`
apropiado). El conteo total SHALL ser mayor o igual a 754.

---

## Scope IN

1. `scripts/migrate-preflight.mjs` (MODIFICAR) — los 6 cambios de comportamiento listados
   en los ACs:
   - Agregar `a2a_events` a `EXPECTED_A2A_TABLES` (AC-1, ~1 línea).
   - Excluir `DROP TRIGGER IF EXISTS` / `DROP FUNCTION IF EXISTS` del pattern HIGH (AC-2,
     modificar el pattern `DROP <object>` o agregar lógica de exclusión).
   - Corregir `findDeleteWithoutWhere` para no matchear dentro de string literals ya
     stripeados por `stripStringLiterals()` — verificar que el fix sea consistente con el
     pipeline existente (AC-3).
   - Deduplicar findings cuando múltiples patterns matchean el mismo statement (AC-4).
   - Hacer que `runPostApplyCheck` retorne exit 1 (no solo log) en cualquier fallo (AC-5).
   - Reemplazar argv connection URL en `psql` spawn con variables de entorno separadas
     (`PGPASSWORD`, `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`) (AC-6).

2. `test/migrate-preflight.test.ts` (MODIFICAR) — tests para todos los nuevos
   comportamientos (ACs 1-7); eliminación de `// @ts-expect-error` y su reemplazo.

3. Shim `.d.ts` (NUEVO, si requerido por AC-7) — ubicación a determinar en F2, probable
   `test/types/` o `test/shims.d.ts`.

---

## Scope OUT

- **MNR-iter2-1** (GRANT/REVOKE en HIGH sub-patterns): clasificación actual es MEDIUM y
  está justificada per RPC migration precedent. NO se toca en esta HU.
- **MNR-iter2-3** (line attribution en statement boundary edge cases): requiere SQL parser
  real (no regex). HU separada cuando se priorice.
- NO modificar `doc/runbooks/migration-preflight.md` — los cambios de comportamiento son
  del script, no del runbook.
- NO tocar `src/`, `mcp-servers/`, ni ningún código productivo del servidor.
- NO agregar deps nuevas a `package.json`.
- NO cambiar el mecanismo de apply de migrations — sigue siendo manual.
- NO implementar parametrización del timeout de 30s (backlog MNR-CR aceptado).
- NO cambiar el naming de `SHADOW_DATABASE_URL` (backlog MNR-CR aceptado).

---

## Decisiones técnicas (DT-N)

- **DT-1** [PARA F2]: ¿Cómo implementar la exclusión de `IF EXISTS` en `DROP TRIGGER` y
  `DROP FUNCTION`? Opción A — modificar el regex del pattern `DROP <object>` para excluir
  `IF EXISTS` vía negative lookahead (`/\bdrop\s+(?!.*\bif\s+exists\b)(trigger|function)/i`).
  Opción B — post-filtrar findings con una función auxiliar `isIdempotentDrop(stmt)`.
  Opción A es más directa si el regex lo permite sin ambigüedad. Opción B es más testeable.
  Architect decide según legibilidad y compatibilidad con `stripStringLiterals()`.

- **DT-2** [PARA F2]: ¿La deduplicación de findings (AC-4) vive dentro de `analyzeSQL()` o
  como post-procesamiento en `main()`? Recomendación: post-procesamiento en `analyzeSQL()`
  antes de retornar findings, de forma que los callers (tests incluidos) ya reciban la lista
  deduplicada. Key: `line + level` (no `line + op`, porque distintos ops en la misma línea
  con la misma severidad deben colapsar en uno).

- **DT-3** [PARA F2]: Para AC-6 (psql argv), ¿se usa `PGPASSWORD` + args individuales o
  una connection string vía stdin (`echo $URL | psql -f -`)? El approach `PGPASSWORD` es más
  portable entre versiones de psql y más explícito. Sin embargo, el host/port/dbname deben
  parsearse de la URL. Alternativa: usar `--dbname` con URL pero sin password embebido
  (URL form: `postgresql://user@host:port/dbname` sin contraseña, y `PGPASSWORD` aparte).
  Architect decide cual es más simple de mantener y qué unit test cubre el caso.

- **DT-4** [PARA F2]: ¿El shim `.d.ts` para eliminar `// @ts-expect-error` (AC-7) es un
  archivo de tipos en `test/types/` o una declaración global en `tsconfig` del workspace de
  tests? Architect verifica el `tsconfig.json` y la estructura de `test/` para elegir el
  path de menor fricción.

---

## Constraint Directives (CD-N)

### Heredados de WKH-78 (vigentes)

- **CD-WKH78-1** (ex CD-1): PROHIBIDO que el script ejecute DML/DDL con efecto permanente
  contra prod `DATABASE_URL`.
- **CD-WKH78-2** (ex CD-2): OBLIGATORIO BEGIN + ROLLBACK en dry-run; nunca COMMIT.
- **CD-WKH78-3** (ex CD-3): PROHIBIDO incluir URLs o secrets reales en el repositorio.
- **CD-WKH78-4** (ex CD-4): OBLIGATORIO exit code 1 en HIGH risk o dry-run failure.
- **CD-WKH78-5** (ex CD-5): PROHIBIDO agregar deps nuevas al `package.json`.
- **CD-WKH78-6** (ex CD-6): tests 100% mocks, sin conexión real durante `npm test`.
- **CD-WKH78-FP1**: cada cambio de comportamiento en RISK_PATTERNS DEBE tener ≥2 fixtures
  de test (caso positivo + caso negativo).
- **CD-WKH78-FP3**: PROHIBIDO bajar la severidad de un pattern existente. Solo se puede
  agregar lógica de exclusión condicional para subpatrones específicos (IF EXISTS).

### Nuevos en WKH-86

- **CD-WKH86-1**: PROHIBIDO pasar la connection URL completa (con password embebido) como
  argv de `psql`. Verificable con un test que inspecciona el array `args` del spawn.
- **CD-WKH86-2**: OBLIGATORIO que `analyzeSQL()` retorne findings deduplicados por
  `(line, level)`. Dos patterns que matchean la misma línea con la misma severidad NO
  deben producir dos entradas separadas en el output.
- **CD-WKH86-3**: OBLIGATORIO que `runPostApplyCheck` termine con exit code 1 ante cualquier
  fallo verificado (tabla faltante, FK inválido, índice ausente). El comportamiento anterior
  de "log and continue" es BLOQUEANTE en AR si se detecta en esta HU.
- **CD-WKH86-4**: PROHIBIDO que el fix de AC-2 (`DROP IF EXISTS`) haga falsos negativos en
  `DROP TABLE IF EXISTS` — esa operación DEBE seguir siendo HIGH (CD-WKH78-FP3 aplica).

---

## Missing Inputs

- **[RESUELTO F1]** Baseline de tests WKH-78: 754 tests. Confirmado en done-report.md:19.
- **[RESUELTO F1]** `EXPECTED_A2A_TABLES` location: `scripts/migrate-preflight.mjs:742-749`.
- **[RESUELTO F1]** `findDeleteWithoutWhere` location: `scripts/migrate-preflight.mjs:173-191`.
  La función opera sobre el SQL crudo (no sobre la salida de `stripStringLiterals()`). Si
  `stripStringLiterals()` ya procesa el SQL antes de llamar a `findDeleteWithoutWhere`, AC-3
  podría ser un no-op. F2 architect DEBE verificar el call graph antes de tocar la función.
- **[NEEDS CLARIFICATION en F2]** DT-1: método exacto de exclusión IF EXISTS (regex vs
  post-filtro) — architect decide.
- **[NEEDS CLARIFICATION en F2]** DT-3: forma de pasar credenciales a psql sin exponer en
  argv — architect elige entre PGPASSWORD+args individuales vs URL sin password.
- **[NEEDS CLARIFICATION en F2]** DT-4: ubicación del shim `.d.ts` según estructura actual
  del proyecto.

---

## Análisis de paralelismo

- **Bloquea otras HUs?** NO — scope confinado a `scripts/` y `test/`. No toca `src/`.
- **Es prerequisito para?** WKH-54 (owner_ref en tasks) y WKH-SEC-02 (RLS policies) DEBERÍAN
  correr el preflight refinado antes de merge. Esta HU no los bloquea técnicamente — solo
  mejora la herramienta que ellos usarán.
- **Branch conflicts?** Improbable. La única colisión posible sería con otra HU que también
  modifique `scripts/migrate-preflight.mjs`, lo cual no está planificado.
- **Puede correr en paralelo con?** Cualquier HU de features (`src/`). Sin conflictos de
  merge esperados.

---

## Estado post-F1 (2026-05-03 modo AUTO)

- Contexto F0 verificado: WKH-78 DONE, 754 tests baseline, script en `scripts/migrate-preflight.mjs`.
- 7 ACs en formato EARS, sin lenguaje vago.
- Scope IN/OUT explícito (3 archivos IN, incluyendo posible shim nuevo).
- 4 DTs (todos para F2 — architect decide).
- 8 CDs (5 heredados activos de WKH-78 + 3 FP heredados + 4 nuevos de WKH-86).
- Sizing FAST confirmado.
- Branch propuesto: `feat/082-wkh-86-migration-preflight-refinements`.
- Listo para HU_APPROVED humano y luego F2 (architect).
