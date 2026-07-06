# Validation Report — WKH-115 (Inbound Adapter) — F4 QA

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-06
**Branch**: feat/155-wkh-115-inbound-adapter (uncommitted working tree)

## Runtime checks (core F4 value)

- **never-throw (CD-9)**: dry-run real de `genericWebhookAdapter.validate`/`normalize`
  vía `npx tsx` sobre 14 payloads basura (`{length:1}`, `[]`, `null`, `42`, `'str'`,
  función, `{__proto__:{x:1}}`, objeto circular auto-referenciado, `{goal:[]}`,
  `{constraints:5}`, `undefined`, `true`, `Symbol`, `Map`) → **cero throws en los 14**,
  siempre devuelve `{ok:false,reason}` / `NormalizedInboundTask` con defaults seguros.
- **Mapeo (AC-3)**: dry-run del payload de ejemplo del SDD →
  `{goal:"build a report", externalRef:"ext-42", budgetUsdc:3.5, constraints:{...}, embeddedUrls:[cb,art], declaresExternalEscrow:false}` — match exacto.
- **capBudget (AC-6)**: import + invocación real de `inboundTaskService.capBudget`
  (no re-implementación) → declared=100/cap=10→**10**; declared=null→default **2**;
  declared=4→**4**. `validate` rechaza budget_usdc negativo/NaN/Infinity/string ANTES
  de llegar a capBudget (confirmado — nunca "inválido pasa a capBudget").
- **escrow (AC-5)**: dry-run `normalize({payment:{...}})`/`{escrow:'0xabc'}` →
  `declaresExternalEscrow:true`; `{payment:null}` → `false` (no-null check correcto).
- **HMAC real (`verifySourceAuth`)**: import + invocación real (no mock) contra el
  módulo compilado (env fake `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` solo para
  resolver el import, sin tocar red): firma válida→SourceConfig; firma
  incorrecta→null; hex malformado→null; hex de 63 chars (length-check)→null;
  timestamp fuera de ventana→null; `ts='1e10'`→null (guard `^\d+$` bloquea antes
  de `Number()`); fuente no configurada→null. Muestreo de timing (2000 iteraciones):
  fuente-no-configurada 5.17ms vs fuente-configurada-firma-mala 8.33ms — ambas ramas
  computan el HMAC (MNR-1 fix presente en runtime, no solo en código).
- **Migración en Postgres efímero** (Docker `postgres:15-alpine`, puerto local,
  destruido al finalizar — NO tocó bdwv): `up.sql` aplica limpio (`CREATE TABLE`,
  4 índices, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, trigger). Verificado por
  `information_schema.columns` + `pg_constraint` + `pg_policies`:
  - `owner_ref`/`source`/`goal`/`status` → `is_nullable='NO'` ✅
  - `CHECK (status IN ('ingested','routed','settled','rejected','failed'))` ✅ (vía `pg_get_constraintdef`)
  - `uq_a2a_inbound_tasks_source_extref` UNIQUE **parcial** `WHERE external_ref IS NOT NULL` ✅
  - `relrowsecurity=t`, **cero rows en `pg_policies`** → deny-by-default confirmado ✅
  - `down.sql` (`DROP TABLE ... CASCADE` en BEGIN/COMMIT) → tabla desaparece limpio ✅
- **`database.types.ts` vs migración**: diff (`git diff -- src/types/database.types.ts`)
  confirma bloque `a2a_inbound_tasks` aditivo con nullability exacta a la tabla real
  (`budget_usdc`/`external_ref`/`orchestration_id`/`error_reason` nullable;
  `owner_ref`/`source`/`goal`/`status` requeridos; `constraints: Json`).

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | ✅ | `src/services/inbound-task.test.ts:162-180` ("el primer write es un insert con status=ingested") — orden de escrituras confirmado; `inbound.ts:88-91` invoca `ingest` tras auth OK. |
| AC-2 | ✅ | `src/routes/inbound.test.ts:120-148` (sin headers→401 cero ingest; verifyAuth null→401 cero ingest). Dry-run real de `verifySourceAuth` confirma cada rama de rechazo → `null`. |
| AC-3 | ✅ | `src/adapters/inbound/generic-webhook.test.ts:80-97` + dry-run runtime — mapeo exacto goal/id/budget_usdc/constraints/callback_url/artifact_url. |
| AC-4 | ✅ | `src/services/inbound-task.test.ts:185-216` — `orchestrate` invocado 1x in-process con `scopingKeyRow` de la fuente, `budget` capado (100→10), `chainId`; orden `['routed','settled']` confirmado; `'maxQuotedCostUsdc' in req === false` (VERIFY-AT-IMPL resuelto). |
| AC-5 | ✅ | `src/services/inbound-task.test.ts:243-262` — `payment`/`escrow` presente → `rejected`, `orchestrate` NUNCA invocado, `budget_usdc` del update es `undefined` (sin acreditar). Dry-run confirma `declaresExternalEscrow`. |
| AC-6 | ✅ | `capBudget` real invocado en dry-run + `inbound-task.test.ts:148-158` (`describe('capBudget (AC-6)')`); inválidos (negativo/NaN/Infinity/string) rechazados en `validate` (`generic-webhook.test.ts:34-58`) antes de llegar a capBudget — confirmado con dry-run. |
| AC-7 | ✅ | `src/services/inbound-task.test.ts:268-296` — URL SSRF-inválida → `rejected` razón `ssrf:*`, `orchestrate` nunca invocado; URL válida → sigue al ruteo, `validateOutboundUrl` llamado con la URL exacta. |
| AC-8 | ✅ | `src/adapters/inbound/generic-webhook.test.ts:153-164` — interfaz cumplida + fuente desconocida resuelve al adapter genérico (sin acoplamiento 3rd-party); never-throw confirmado en runtime (14 payloads basura). |
| AC-9 | ✅ | `src/services/inbound-task.test.ts:301-329` — `get`/`updateStatus` cross-tenant → `undefined`/`InboundTaskNotFoundError`; todas las queries (`updates`/`inserts`) confirmadas con `owner_ref` correcto. RLS deny-by-default confirmado en Postgres efímero. |

## Drift

- **Scope**: `git status --porcelain` = exactamente los 12 archivos del "Files to
  Modify/Create" del Story File + `doc/sdd/_INDEX.md` (aditivo estándar) + carpeta
  del propio SDD. Cero archivos fuera de scope.
- **Additive-only (CD-7)**: `git diff --stat` sobre `src/routes/orchestrate.ts`,
  `src/services/orchestrate.ts`, `src/routes/compose.ts`, `src/routes/tasks.ts` →
  vacío (cero cambios). Confirmado también por test dedicado
  (`inbound.test.ts:213-227`, parser raw-body no se filtra a `/ctrl`).
- **Migración**: creada pero NO aplicada contra bdwv (confirmado — Scope OUT explícito
  cumplido; solo se validó en Postgres efímero descartable).
- Sin drift de spec / waves.

## Gates (ejecutados por QA — no había cr-report.md en disco para confirmar)

- `npx tsc --noEmit` → 0 (verde)
- `npm run lint` (biome check src/) → "Checked 312 files... No fixes applied" (0)
- `npx vitest run` → **2758 pass / 0 fail** (baseline íntegro, incluye los 3 archivos
  de test nuevos de esta HU: 67 tests en `inbound.test.ts` + `inbound-task.test.ts` +
  `generic-webhook.test.ts`, todos verdes)

## AR/CR follow-up

- No existe `cr-report.md`/`ar-report.md` en disco para esta HU — el único artefacto
  de proceso persistido es `doc/sdd/155-wkh-115-inbound-adapter/auto-blindaje.md`,
  que documenta 2 MNR (MNR-1 timing side-channel de enumeración de fuentes, MNR-2
  replay/doble-cobro sin idempotency) + 1 NIT (timestamp permisivo) con sus fixes.
  QA verificó en runtime que los 3 fixes están efectivamente presentes en el código
  ejecutado (no solo documentados): MNR-1 confirmado por muestreo de timing arriba;
  MNR-2 confirmado por los 3 tests de idempotencia (`inbound-task.test.ts:334-414`,
  incluyendo la race del índice UNIQUE parcial vía `23505`); NIT-ts confirmado por
  el guard `^\d+$` en el dry-run HMAC.

**Listo para DONE.**
