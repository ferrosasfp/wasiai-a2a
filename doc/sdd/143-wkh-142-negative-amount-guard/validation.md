# Validation Report — HU WKH-142 (guard de importe negativo en el money-path)

**Veredicto**: **F4: FAIL** (bloqueante de proceso — gate `lint` rojo en CI/local; NO es un fallo de lógica de seguridad)
**Fecha**: 2026-07-04
**Branch**: `fix/143-wkh-142-negative-amount-guard` @ `a23cff0` · PR #164 (state OPEN, mergeable=MERGEABLE)

> No existen `cr-report.md` / `ar-report.md` en `doc/sdd/143-wkh-142-negative-amount-guard/` — este HU corrió por el pipeline "auto" (evidencia: `doc/sdd/143-wkh-142-negative-amount-guard/auto-blindaje.md`, sin reportes AR/CR formales). Por eso F4 re-corrió los gates (tsc/lint/test) en vez de solo leerlos, siguiendo la instrucción explícita de esta tarea.

---

## 1. Runtime / Integration checks (Postgres 15 efímero, Docker, NO prod)

Se aplicaron en orden los 39 archivos UP de `supabase/migrations/` (roles `anon`/`authenticated`/`service_role` creados a mano para satisfacer los `REVOKE`/`GRANT` de hardening; sin eso falla con `role "anon" does not exist`, no relacionado a este HU) hasta `20260707000000_wkh142_negative_amount_guard.sql` inclusive. Contenedor descartado al finalizar (`docker rm wkh142-pg`).

| # | Check | Comando | Resultado |
|---|---|---|---|
| R1 | AC-1: `increment_a2a_key_spend(..., -1, ...)` | `SELECT increment_a2a_key_spend('11111111-…'::uuid, 2368, -1, 'owner-qa');` | `ERROR: INVALID_AMOUNT: p_amount_usd -1 must be a non-negative number` — balance permanece en `10` (sin mutación) ✅ |
| R2 | AC-1: `NaN` | `..., 'NaN'::numeric, ...` | `ERROR: INVALID_AMOUNT: p_amount_usd NaN must be a non-negative number` — `daily_spent_usd=0`, sin mutación ✅ |
| R3 | AC-1: `NULL` | `..., NULL, ...` | `ERROR: INVALID_AMOUNT: p_amount_usd <NULL> must be a non-negative number` ✅ |
| R4 | CD-9: `0` sigue válido | `..., 0, ...` | Sin excepción, balance no cambia (10→10, correcto: débito de costo cero) ✅ |
| R5 | No-regresión: débito positivo `1.0` | `..., 1.0, ...` | Éxito; balance `10→9`, `daily_spent_usd=1.000000` ✅ |
| R6 | AC-2 (choke-point): `debit_with_dest_policy(..., -5, ...)` | vía `PERFORM increment_a2a_key_spend` | `ERROR: INVALID_AMOUNT...` con `CONTEXT: ... PL/pgSQL function debit_with_dest_policy(...) line 54 at PERFORM` — hereda el guard sin redefinirlo; balance sigue en `9` ✅ |
| R7 | AC-5: `INSERT a2a_agents (price_usdc=-1)` | directo, bypass write-boundary | `ERROR: 23514: new row ... violates check constraint "a2a_agents_price_usdc_nonneg"` (confirmado con `VERBOSITY=verbose` → SQLSTATE `23514` explícito) ✅ |
| R8 | AC-5 (MNR-1): `INSERT a2a_agents (price_usdc='NaN')` | directo | `ERROR: 23514` (mismo constraint) ✅ |
| R9 | No-regresión: `INSERT a2a_agents (price_usdc=1.0)` | directo | `INSERT 0 1` — éxito ✅ |
| R10 | AC-4 (clamp precede al constraint): down → mutar filas a `-1`/`NaN` con el constraint ausente → re-aplicar UP | ver detalle abajo | `UPDATE 2` (clamp) corre ANTES de `ALTER TABLE ADD CONSTRAINT` en la misma tx; ambas filas terminan en `price_usdc=0`; el `ADD CONSTRAINT` no falla ✅ |
| R11 | Reversibilidad `_down` (bidireccional) | down → repro del bug pre-HU → up | Con el guard removido (down aplicado), `increment_a2a_key_spend(..., -2, ...)` **NO** lanza excepción y el balance **SUMA**: `9.0 → 11.0` (reproduce exactamente el bug que esta HU cierra). Al re-aplicar el UP, el mismo `-2` vuelve a rechazarse con `INVALID_AMOUNT` ✅ |
| R12 | CD-4: hardening preservado tras `CREATE OR REPLACE` | `proconfig` + `has_function_privilege` | `search_path=public, pg_temp` presente; `service_role`→EXECUTE `t`; `anon`→`f`; `authenticated`→`f` ✅ |
| R13 | CD-7: `INVALID_AMOUNT` aparece exactamente 1 vez en el UP, 0 en el down | `grep -c` | UP: `1` (el `RAISE`); DOWN: `0` ✅. Solo `increment_a2a_key_spend` se redefine en la migración (`grep CREATE FUNCTION` → 1 match) ✅ |

**R10 detalle**: se aplicó el `_down.sql` (dropea el constraint), se mutó `price_usdc` de una fila existente a `-1` y se insertó una fila nueva con `'NaN'::numeric` (posible solo porque el constraint estaba ausente — reproduce el escenario de "filas negativas preexistentes en prod" que motiva DT-4/CD-3). Al re-aplicar el `.sql` UP, el log mostró `UPDATE 2` (el clamp) inmediatamente antes de `ALTER TABLE` (que tuvo éxito) — confirma que en la migración real (no solo en el test estructural) el clamp neutraliza datos negativos/NaN antes de que el `ADD CONSTRAINT` pudiera fallar.

## 2. ACs — con evidencia archivo:línea + runtime

| AC | Texto (resumen EARS) | Status | Evidencia |
|----|---|---|---|
| AC-1 | RPC `increment_a2a_key_spend` con `p_amount_usd < 0`/NULL/NaN → RAISE `INVALID_AMOUNT` ANTES de tocar `budget`/`daily_spent_usd` | ✅ PASS | Código: `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql` guard entre ownership-guard y `is_active` (confirmado con `pg_proc.prosrc` en vivo, ver §1 fuente completa leída). Test: `test/negative-amount-guard.migration.test.ts` → `T1 (AC-1): guard NULL / < 0 / NaN + RAISE INVALID_AMOUNT, ANTES del UPDATE` PASS; `src/services/money-path.concurrency.test.ts` → `T2 (AC-1) negative amount guard — debit is rejected, balance unchanged` PASS. Runtime: R1/R2/R3/R4 (§1) |
| AC-2 | Los otros 3 RPC de débito heredan `INVALID_AMOUNT` vía `PERFORM increment_a2a_key_spend` (sin re-implementar) | ✅ PASS | Test: `T3 (AC-2 / CD-7): INVALID_AMOUNT aparece exactamente 1 vez (choke-point único)` + `T3 (CD-2): los 3 RPC hermanos debit_* NO se redefinen` (ambos PASS, `test/negative-amount-guard.migration.test.ts`). Runtime: R6 (§1) — `debit_with_dest_policy(-5)` rechazado con `CONTEXT: ... at PERFORM` mostrando el choke-point real |
| AC-3 | `compose.isInvalid` trata `agent.priceUsdc < 0` como inválido (mismo fallback `PLACEHOLDER_FEE_USD`) | ✅ PASS | Código: `src/services/compose.ts:210` (`agent.priceUsdc < 0` agregado a la condición, leído en vivo). Test: `src/services/compose.test.ts` → `T4 (AC-3) per-step negative priceUsdc → fallback debit (never negative) + registry-miss warn` PASS |
| AC-4 | Migración clampea `price_usdc < 0 → 0` ANTES del `ADD CONSTRAINT` (mismo tx) | ✅ PASS | Código: `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql` (`UPDATE` en L~126, `ALTER TABLE ADD CONSTRAINT` posterior, misma tx `BEGIN;`/`COMMIT;`). Test: `T5 (AC-4 / CD-3): el clamp UPDATE precede al ADD CONSTRAINT en la misma tx` PASS. Runtime: R10 (§1) — reproducido con filas reales negativas/NaN preexistentes, el clamp las neutraliza antes de que el constraint se agregue |
| AC-5 | INSERT/UPDATE directo con `price_usdc < 0` rechazado por Postgres (`23514`) | ✅ PASS | Código: `ALTER TABLE public.a2a_agents ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0 AND price_usdc <> 'NaN'::numeric)` (fix-pack MNR-1, commit `a23cff0`). Test: `T6 (AC-5)` + `MNR-1: el CHECK rechaza NaN` (ambos PASS). Runtime: R7/R8 (§1) — `INSERT` con `-1` y con `'NaN'::numeric` ambos rechazados con `SQLSTATE 23514` verificado explícitamente (`VERBOSITY=verbose`) |

### Invariantes adicionales verificados

| Invariante | Status | Evidencia |
|---|---|---|
| RPC RAISE (4 rutas) | ✅ | Master (R1-R5 directo) + choke-point (R6, `debit_with_dest_policy`). Las otras 2 (`debit_session_and_parent`, `debit_delegation_and_parent`) no se ejercitaron en runtime real (requieren tablas `a2a_key_sessions`/`a2a_delegations` con filas seedeadas — fuera del alcance de este ciclo dado que comparten el mismo `PERFORM`), pero SÍ están cubiertas en unit test: `src/services/delegation.test.ts` → `WKH-142 INVALID_AMOUNT (parent RPC) → InvalidDebitAmountError` PASS; `src/services/key-session.test.ts` → `WKH-142 INVALID_AMOUNT (parent RPC) → InvalidDebitAmountError` PASS |
| CHECK negativo + NaN | ✅ | R7/R8 (runtime) + T6/MNR-1 (unit) |
| No-regresión (positivo) | ✅ | R5/R9 (runtime, débito y precio positivos) + `src/services/budget.test.ts` → `T9 no-regression: positive debit still succeeds (master route)` + `src/services/compose.test.ts` → `T9 no-regression: positive per-step priceUsdc debits the real price, no fallback` (ambos PASS) |
| Error code estable `DEBIT_INVALID_AMOUNT` (4 rutas) | ✅ | `src/services/budget.test.ts`: `T7 master route...`, `T7 master-dest route...`, `T8 session route...`, `T8 delegation route...` (las 4 PASS) |
| Reversibilidad `_down` | ✅ | R11 (§1) — bidireccional, con reproducción real del bug pre-HU al bajar el guard |

## 3. Drift Detection

`git diff --name-only main...fix/143-wkh-142-negative-amount-guard` (15 archivos) = **exactamente** el Scope IN del Story File (§2: migración UP/DOWN, `errors.ts`, `budget.ts`, `delegation.ts`, `key-session.ts`, `compose.ts`, los 7 test files, + `doc/.../auto-blindaje.md` como artefacto de proceso). Cero archivos fuera de scope.

- `refund_a2a_key_spend` / `refund_with_dest_policy` / `refund_delegation_and_parent` / `refund_session_and_parent`: **intactas** (CD-2) — `git diff -- '*refund*'` vacío.
- Los 3 RPC hermanos (`debit_with_dest_policy`, `debit_session_and_parent`, `debit_delegation_and_parent`): **NO redefinidos** en la migración (solo `increment_a2a_key_spend` vía `CREATE OR REPLACE`, confirmado con grep).
- Wave order: commit único `33a49af` cubre W0-W3 (tamaño S, aceptable) + fix-pack `a23cff0` (MNR-1, post-hoc). Sin violación de orden (migración primero dentro del mismo commit, según diff stat).
- **Drift: none.**

## 4. Gate Confirmation

**No hay `cr-report.md`** (pipeline "auto", sin CR formal documentado) → gates re-ejecutados en worktree aislado (`git worktree add --detach a23cff0`, fuera del working tree principal):

| Gate | Resultado | Detalle |
|---|---|---|
| `npx tsc -p tsconfig.json --noEmit` | ✅ PASS | "TypeScript compilation completed", exit 0 |
| `npm test` (vitest) | ✅ PASS | 143 test files passed, 4 skipped; **2516 tests passed**, 10 skipped, 0 failed |
| `npm run lint` (biome check src/) | ❌ **FAIL** | `Found 3 errors` — formato roto en `src/services/budget.test.ts`, `delegation.test.ts`, `key-session.test.ts` (líneas del mock `error: { message: 'INVALID_AMOUNT: ...' }` exceden el ancho de línea de Biome y no fueron pasadas por el formatter antes de commitear). **Confirmado también en CI**: PR #164, check `build-test` → `conclusion: FAILURE` (job 85118164340, step "Lint" failed, exit code 1, ejecutado 2026-07-04T08:36:55Z) |
| `npm run build` | No re-ejecutado (implícito en `tsc --noEmit`, que es lo que corre el script `build`) | — |

**Este es un hallazgo real, no un "gate ya confirmado por CR"** — no existe reporte de CR que lo haya validado, y el propio CI de GitHub confirma el mismo fallo (`build-test: FAILURE`) desde antes de que F4 corriera. El fix es trivial (correr el formatter de Biome sobre los 3 archivos de test — `npx biome check --write src/`), pero es un gate rojo real que bloquea merge y no puede marcarse PASS sin evidencia falsa.

## 5. Veredicto

- **Seguridad / money-path (núcleo de la HU)**: 5/5 ACs PASS con evidencia de código + test + runtime en Postgres real. El guard funciona exactamente como se especificó, en las 4 rutas, con el CHECK simétrico (NaN incluido, fix MNR-1), clamp verificado con datos reales, y reversibilidad confirmada bidireccionalmente (incluida la reproducción del bug original al remover el guard).
- **Gate de calidad**: `lint` (Biome format) **FAIL**, tanto local como en CI (PR #164, `build-test` conclusion=FAILURE). `tsc` y `npm test` (2516/2516) PASS.

**F4: FAIL** — bloqueante de proceso (gate rojo), no de seguridad. Corresponde relanzar al Dev para un fix-pack mínimo: `npx biome check --write src/services/budget.test.ts src/services/delegation.test.ts src/services/key-session.test.ts` (o equivalente), commitear, y re-verificar CI verde antes de mergear. Ningún AC ni invariante de seguridad requiere cambios.
