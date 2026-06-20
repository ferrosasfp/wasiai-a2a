# Code Review (CR) — #116 WKH-SEC-02 (RLS Postgres-level)

> Agente: nexus-adversary (modo CR — calidad). Corrido EN PARALELO con AR (no leído).
> Fecha: 2026-06-20
> Branch: feat/116-wkh-sec-02-rls
> Scope CR: calidad/patrones (naming, complejidad, DRY, SOLID, tests, docs inline).
> Seguridad (deny-default, FORCE, service_role, IDOR) es dominio del AR — no se duplica aquí.

## Archivos revisados (HU WKH-SEC-02)
- `supabase/migrations/20260607000000_wkh_sec02_rls.sql`
- `supabase/migrations/20260607000000_wkh_sec02_rls_down.sql`
- `scripts/verify-rls-enabled.mjs`
- `test/verify-rls-enabled.test.ts`

(El `git diff main...HEAD` arrastra trabajo de HUs previas ya mergeadas; CR se limita a los 4 archivos creados por esta HU.)

---

## 1. Naming consistency — OK

- Migración up/down siguen el estilo del exemplar `20260427160000_secure_rpc_search_path.sql`:
  cabecera con HU + fecha + propósito, `BEGIN;`/`COMMIT;`, una sentencia DDL por línea, alineadas.
- `verify-rls-enabled.mjs` espeja `migrate-preflight.mjs`: funciones puras exportadas
  (`RLS_TABLES`, `buildRlsQuery`, `evaluateRlsRows`, `resolveProjectRef`) + `main(deps)` con
  I/O inyectado + CLI-guard idéntico (`verify-rls-enabled.mjs:166-171` vs `migrate-preflight.mjs:1135-1140`).
- `readEnv` reusa textual el parser del exemplar `apply-security-rpc-migration.mjs:9-21` (mismo
  regex, mismo manejo de comillas, mismo `try/catch` silencioso). Nombres de funciones claros y
  autodescriptivos.

## 2. Complejidad — OK

- `evaluateRlsRows` (`verify-rls-enabled.mjs:77-88`): pura, sin I/O, 3 derivaciones (`missing`,
  `disabled`, `unexpected`) sobre un `Map` por nombre. Legible y lineal. Maneja input no-array
  (`Array.isArray(rows) ? rows : []`, línea 78) sin ramas extra.
- `buildRlsQuery` (`:60-70`): arma el SELECT por join de líneas; deriva el `IN (...)` de `RLS_TABLES`.
- `main` (`:115-163`): orquestación plana, sin anidamiento profundo. Sin complejidad accidental.

## 3. DRY — OK

- El set de 7 tablas se define UNA sola vez (`RLS_TABLES`, `:21-29`) y se reusa para el query
  (`buildRlsQuery`) y para la validación (`evaluateRlsRows`, `resolveProjectRef`). El test consume
  la misma constante exportada (`test:20` `const TABLES = RLS_TABLES`) en vez de re-listar — bien.
- Reusa el patrón PAT + Management API (`POST .../database/query`, Bearer) del exemplar.
- `readEnv` se copia inline en vez de importarse, pero eso ES la convención del codebase: los ops
  scripts (`apply-security-rpc-migration.mjs`, `migrate-preflight.mjs`) son standalone y duplican el
  parser a propósito. No hay módulo compartido. No es finding.

## 4. SOLID — OK

- Separación I/O vs lógica: `evaluateRlsRows`/`buildRlsQuery`/`resolveProjectRef` puras; `main(deps)`
  recibe `fetch`/`env`/`argv`/`log`/`error`/`exit` inyectables (`:106-114`). Espeja `migrate-preflight.mjs`.
  Esto es lo que hace el test 100% mock posible sin tocar red/BD (CD-7).
- CLI-guard aísla el entrypoint del import (`:166-171`), igual que el exemplar.

## 5. Tests — OK

- `evaluateRlsRows` cubierto en los casos requeridos por el Test Plan: 7/7 ok (`test:31`), una en
  false (`:39`), tabla faltante (`:47`), tabla inesperada (`:54`), respuesta vacía → faltan las 7 (`:61`).
  Asserts significativos (no solo `ok`, también `missing`/`disabled`/`unexpected`).
- `buildRlsQuery`: consulta las 7 (`:73`) y usa `pg_class.relrowsecurity` no `information_schema` (`:81`).
- Estructural SQL: up 7 ENABLE (`:103`), sin FORCE (`:111`), sin CREATE POLICY (`:115`), sin funciones
  (`:119`), `BEGIN/COMMIT` (`:124`); down 7 DISABLE (`:133`), sin DROP POLICY (`:140`), `BEGIN/COMMIT` (`:144`).
- **Conteo de DDL robusto**: `countDdlStatements` (`:95-98`) usa regex `ALTER TABLE public.\w+ <action> ROW
  LEVEL SECURITY;` en vez de substring crudo. Esto corrige correctamente el bug del auto-blindaje (el
  substring contaba las menciones en el comentario "NOTA OPS" del down → `expected 9 to be 7`). El fix es
  el correcto y matchea la lección WKH-121 (matchers no-frágiles). Nombres de tests descriptivos.
- Verificado: `npx vitest run test/verify-rls-enabled.test.ts` → 15 PASS / 0 FAIL.

## 6. Documentación inline — OK

- Up `.sql` documenta: por qué ENABLE no FORCE (DT-4, `service_role` bypassa por BYPASSRLS), por qué sin
  policy (deny-by-default), e idempotencia (AC-6). Líneas 1-6.
- Down `.sql` documenta: idempotencia + por qué NO pasa por `migrate:preflight` (DT-6, DISABLE es HIGH
  deliberado). Líneas 1-6.
- `verify-rls-enabled.mjs`: header con propósito, exit codes, modos de uso, refs conocidas; JSDoc por
  función incluyendo por qué `pg_class` y no `information_schema` (`:57`).

---

## Evaluación del `// @ts-expect-error` (auto-blindaje) — MENOR

**Finding MNR-1 — Test Coverage / Type Safety (calidad)**

- **Archivo:línea**: `test/verify-rls-enabled.test.ts:12-13`
- **Descripción**: El Dev importó el `.mjs` con `// @ts-expect-error` en vez de un shim `.d.ts`. El
  exemplar designado para este patrón —`test/migrate-preflight.test.ts`— **explícitamente abandonó** ese
  enfoque: su header (líneas 9-15) documenta *"WKH-86 AC-7: the prior `// @ts-expect-error` was replaced
  by a typed module declaration shim at `test/types/migrate-preflight.d.ts` ... This gives the test file
  proper types ... without bypassing the type checker."* El shim ya existe en el repo
  (`test/types/migrate-preflight.d.ts`). El Dev re-introdujo el patrón que el exemplar deprecó.
- **Por qué NO es bloqueante**: el impacto real es nulo en todos los gates. `tsconfig.json` incluye solo
  `src/**/*` (`exclude` no lista nada extra, `include: ["src/**/*"]`), así que el archivo de test en
  `test/` **no lo typechequea `tsc`**; y `vitest.config.ts` no tiene bloque `typecheck`, así que vitest
  transpila vía esbuild sin chequear tipos. Resultado: el `@ts-expect-error` es **inerte** — no suprime
  ningún error que de otro modo rompería un gate, ni el shim del exemplar agrega enforcement por `tsc`
  (también vive fuera de `src/`). La diferencia es de **consistencia de patrón y tipos en el IDE**, no de
  corrección. No rompe ningún AC ni el build.
- **Reproducción**: `npm run build` (tsc -p tsconfig.build.json) → no toca `test/`. `npx vitest run
  test/verify-rls-enabled.test.ts` → 15 PASS con y sin la directiva. El comportamiento es idéntico.
- **Impacto**: pérdida de tipos en editor para los 3 imports (`RLS_TABLES`/`buildRlsQuery`/
  `evaluateRlsRows`) e inconsistencia con el exemplar que el Story File designó (Exemplar 4). Deuda menor.
- **Sugerencia**: crear `test/types/verify-rls-enabled.d.ts` espejando `test/types/migrate-preflight.d.ts`
  y reemplazar la directiva por `/// <reference path="./types/verify-rls-enabled.d.ts" />`. Alternativa
  aceptable: dejarlo como está si se prefiere no crear archivos extra — el comentario del auto-blindaje
  justifica la decisión de scope, y dado que la directiva es inerte, el riesgo es cero. **Decisión del
  Dev/orquestador: entra ahora o backlog. NO bloquea DONE.**

> Nota de calibración: clasificado MENOR (no BLQ-BAJO) porque no rompe nada — solo es subóptimo respecto
> de un exemplar. Regla: ante duda BLQ-BAJO/MENOR → MENOR.

---

## Resumen de findings

| ID | Categoría | Severidad | Archivo:línea |
|----|-----------|-----------|---------------|
| MNR-1 | Test Coverage / Type Safety | MENOR | test/verify-rls-enabled.test.ts:12 |

- Checks OK: Naming, Complejidad, DRY, SOLID, Tests, Docs inline (6/6).
- BLOQUEANTEs (ALTO/MED/BAJO): 0.
- MENORes: 1.

## Veredicto

**APROBADO con MENORs**

No hay BLOQUEANTEs. El gate de CR pasa. MNR-1 (`@ts-expect-error` vs shim `.d.ts`) se documenta para que
el orquestador/Dev decida si entra en un fix-pack o al backlog — su impacto es nulo en todos los gates
(el test no es typechequeado por `tsc` ni por vitest), así que no bloquea DONE.

*CR generado por NexusAgil — Adversary (Code Review).*
