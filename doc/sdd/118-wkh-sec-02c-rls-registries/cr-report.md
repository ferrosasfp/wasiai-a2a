# CR Report — WKH-SEC-02c: RLS en `registries` y `kite_schema_transforms`

> **nexus-adversary · CR · 2026-06-22** · Branch `feat/118-wkh-sec-02c-rls-registries` (working tree)
> **Veredicto: APROBADO con MENORs** — 0 BLOQUEANTE, 2 MENOR.
> Gates reales: tsc 0 · biome 0 · vitest 1625 passed / 0 failed · verify-rls 15 passed.
> _Persistido por el orquestador (restricción de escritura del agente; contenido íntegro suyo)._

## Checklist CR

**1. Espejo del exemplar — OK.** `20260610000000_wkh_sec02c_rls_registries.sql` (+_down) es espejo estructural 1:1 de `20260607000000_wkh_sec02_rls.sql`: `BEGIN;…COMMIT;`, 1 `ALTER TABLE public.<t> ENABLE/DISABLE ROW LEVEL SECURITY` por tabla, sin FORCE, sin CREATE POLICY, sin CREATE FUNCTION. Única diferencia esperada: 2 tablas en vez de 7. Sin divergencias.

**2. verify-rls-enabled.mjs (7→9) — OK** (con MNR-1). `RLS_TABLES` extendido a 9 (`registries`, `kite_schema_transforms`, L29-30); único array canónico. Propagación por `.length` sin hardcodes (`buildRlsQuery` L63, `evaluateRlsRows` L83-86, logs L137/L157). Comentario del array (L19-20) actualizado. Pendiente cosmético: JSDoc del archivo (L3/L6/L7/L58) sigue diciendo "7 tablas" (MNR-1, marcado opcional en el Story).

**3. Test — OK.** Set canónico 7→9 (`9/9` L31, `toHaveLength(9)` L75-76). Conteo del nuevo .sql = **2** (up L106, down L136) — correcto (el .sql tiene 2 tablas). Bucle acotado a `['registries','kite_schema_transforms']` (L107/L137) evita el falso fallo. Caso "unexpected" reescrito a `a2a_tasks` (L54-61, sin owner_ref) → no relaja cobertura (CD-8). Tests no tocados siguen válidos contra el set de 9.

**4. Naming — OK** (con MNR-2). Nombre de migración coherente, timestamp posterior a 20260609000000, sin colisión. Inconsistencia menor: comentario `(lección WKH-121)` en `countDdlStatements` L96 (heredado, no introducido por esta HU).

**5. Cobertura de los 6 ACs — OK.** AC-1 (ENABLE===2 + match por tabla L105-111), AC-2 (no policy L117 + no FORCE L113 + unexpected L54-61), AC-3 (DISABLE===2 L135-140), AC-4 (service_role por construcción + smoke W2), AC-5 (verify 9/9 L31-37/L63-66/L75-81), AC-6 (BEGIN/COMMIT + preflight + re-apply W2). AC-4/AC-6 completan en W2 manual (consistente con SEC-02).

**6. Gates — CONFIRMADOS** (re-ejecutados): tsc 0 (exit 0); biome 0 (`biome check src/`, 1 info pre-existente en reputation.ts:116 fuera de scope, diff vacío vs origin/main; biome no escanea scripts/ ni test/); vitest 1625 passed / 0 failed; verify-rls 15 passed.

**Scope discipline — OK.** Exactamente los 4 archivos de Scope IN (2 modificados + 2 .sql nuevos). `src/` intacto (CD-5). BACKLOG.md/HACKATHON-FINAL.md/doc son working-tree pre-existente, NO producto de esta HU → NO incluir en el commit.

## Findings (MENOR, no bloquean)

- **MNR-1** (`scripts/verify-rls-enabled.mjs:3,6,7,58`): JSDoc del archivo y de `buildRlsQuery` siguen diciendo "7 tablas" (el array L19 sí dice 9). Cero impacto runtime (conteos derivan de `.length`). Marcado opcional en Story W1.1. Backlog.
- **MNR-2** (`test/verify-rls-enabled.test.ts:96`): comentario `(lección WKH-121)` vs la atribución real WKH-SEC-02. Comentario heredado, no tocado por esta HU. Backlog.

## Veredicto
**APROBADO con MENORs.** 0 BLQ, 2 MENOR (cosmética documental). Gates reales confirmados. Pipeline puede avanzar a F4.
