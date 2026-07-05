# Validation Report — HU WKH-137 v1 (Invocation Links) — DENSE

**Veredicto**: **F4: PASS** (money-path; validado con evidencia runtime real, no solo lectura de código)
**Fecha**: 2026-07-04
**Branch**: `feat/139-wkh-137-invocation-links` @ `16e33b6`
**PR**: #161

> Nota de proceso: no existen `ar-report.md` / `cr-report.md` como artefactos
> separados en `doc/sdd/139-wkh-137-im-qr-payments/`. El único rastro documental
> de AR/CR es `auto-blindaje.md` (BLQ-1 + MNR-a/b/c, con causa raíz y fix).
> Dado que no había reporte que "leer" para confirmar gates (regla del F4:
> "no re-ejecutar si CR ya confirmó"), F4 ejecutó los gates + verificación
> runtime completa de forma independiente (ver §Gates y §Runtime). Esto es una
> desviación de proceso (CLAUDE.md regla de reportes con evidencia archivo:línea
> por fase) — se recomienda a nexus-docs registrarlo en la Retro, no bloquea DONE
> porque la evidencia fue reconstruida 100% de forma independiente acá.

---

## Runtime checks (Postgres efímero, Docker — NO prod)

Migración `20260706000000_wkh137_agent_links.sql` aplicada contra Postgres 15
efímero (contenedor `qa-wkh137-pg`, descartado al finalizar) con un baseline
mínimo (`a2a_agent_keys` stub + `trigger_set_updated_at` + roles `anon`/
`authenticated`/`service_role`). Migración aplicó limpio, sin errores.

| Check | Esperado (SDD/Story) | Real (query) | Resultado |
|---|---|---|---|
| Columnas/nullability | 16 cols, NOT NULL en id/token_hash/owner_ref/key_id/slug/max_price_usdc/chain_id/status/expires_at/created_at/updated_at | `information_schema.columns` → exacto match, incl. `is_nullable='NO'` en las 10 NOT NULL y `'YES'` en registry/redeemed_at/settle_tx_hash/consumed_cost_usdc/error_message | ✅ |
| CHECK `max_price_usdc >= 0` | presente | `pg_get_constraintdef` → `CHECK ((max_price_usdc >= (0)::numeric))` | ✅ |
| CHECK `status IN (...)` | 4 estados | `CHECK ((status = ANY (ARRAY['open','redeeming','redeemed','failed'])))` | ✅ |
| UNIQUE `token_hash` (CD-12, sin índice extra) | 1 solo índice UNIQUE, sin índice redundante | `pg_indexes` → `a2a_agent_links_token_hash_key` (UNIQUE btree); no hay 2º índice sobre `token_hash` | ✅ |
| FK `key_id → a2a_agent_keys(id) ON DELETE CASCADE` | presente | `pg_get_constraintdef` → `FOREIGN KEY (key_id) REFERENCES a2a_agent_keys(id) ON DELETE CASCADE` | ✅ |
| Índices declarados | `idx_..._key_owner`, `idx_..._owner`, `idx_..._status` | los 3 existen (`pg_indexes`) | ✅ |
| RLS deny-by-default | `ENABLE ROW LEVEL SECURITY`, sin policy permisiva | `pg_class.relrowsecurity = t`; `pg_policies` → 0 rows | ✅ |
| RPC hardening | `SECURITY DEFINER` + `search_path=public,pg_temp` + REVOKE PUBLIC/anon/authenticated + GRANT service_role | `pg_proc.prosecdef=t` + `proconfig={"search_path=public, pg_temp"}` en ambos RPC; `information_schema.routine_privileges` → solo `postgres`(owner)+`service_role` tienen EXECUTE, ni `anon` ni `authenticated` | ✅ |
| Down migration reversible (CD-11) | `DROP FUNCTION` firmas exactas + `DROP TABLE`, BEGIN/COMMIT | aplicado tras el up; `to_regclass('a2a_agent_links')` y `to_regprocedure(...)` de ambos RPC → NULL post-down | ✅ |

### Comportamiento funcional de los 2 RPC (contra Postgres real, no mocks)

| Escenario | Query/acción | Resultado real | AC/CD |
|---|---|---|---|
| Claim único | `SELECT * FROM claim_agent_link('tokhash1')` sobre link `open` | Devuelve la fila; `status` pasa a `redeeming` | AC-2 |
| Doble-claim (mismo token, ya en `redeeming`) | 2º `claim_agent_link('tokhash1')` | `ERROR: LINK_ALREADY_USED` | AC-4/CD-4 |
| Claim expirado | link con `expires_at` en el pasado, `status='open'` | `ERROR: LINK_EXPIRED` | AC-4 |
| Claim inexistente | token no en tabla | `ERROR: LINK_NOT_FOUND: does-not-exist` | AC-4 |
| Settle con owner incorrecto | `settle_agent_link(id,'owner-B','redeemed',...)` sobre link de `owner-A` | `ERROR: OWNERSHIP_MISMATCH: link ... not owned by caller` | AC-6/CD-2 |
| Settle correcto | `settle_agent_link(id,'owner-A','redeemed','0xdead',1.5,null)` | `status='redeemed'`, `redeemed_at` seteado, `settle_tx_hash='0xdead'`, `consumed_cost_usdc=1.50000000` | AC-2 |
| Settle idempotente (2º settle sobre terminal `redeemed`) | `settle_agent_link(id,'owner-A','failed',...)` tras ya estar `redeemed` | No-op: `status` sigue `redeemed`, `error_message` NO se sobreescribe | CD-8 (exactly-once) |

**Env parity**: no aplica (HU no agrega env vars nuevas de infraestructura; `LINK_MAX_TTL_SECONDS` es opcional con fail-safe default 86400, verificado en `agent-link.ts:144-147` — no requiere estar seteada).

**Migration applied tracking**: no aplica a prod — la migración NO fue aplicada a Supabase real por instrucción explícita (solo Postgres efímero). Queda pendiente el paso de aplicación real (`scripts/apply-prod-migrations.sh` o equivalente) fuera de F4.

---

## AC Verification

| AC | Texto (resumen) | Status | Evidencia |
|---|---|---|---|
| AC-1 | Mint: token opaco hash-only, atado a slug/owner_ref/key_id/chain_id/maxPriceUsdc/expiresAt, retornado 1 vez en 201 | ✅ PASS | `src/services/agent-link.ts:198-232` (token `wasi_a2a_link_<96 hex>`, INSERT solo `token_hash`) + `src/services/agent-link.test.ts:168-189` (T1: `lastInsert` NO contiene el token crudo, `JSON.stringify(lastInsert)` no lo incluye) + runtime: migración confirma columna `token_hash TEXT NOT NULL UNIQUE`, no existe columna para el token crudo |
| AC-2 | Redeem exitoso: precio ≤ cap → invoca bajo owner del link, marca consumido atómicamente | ✅ PASS | `agent-link.ts:289-321` (claim atómico) + `agent-link.test.ts:217-234` (T5) + runtime: `claim_agent_link` FOR UPDATE transiciona `open→redeeming` en Postgres real (ver tabla runtime) |
| AC-3 | Precio > cap → 409 sin debitar/invocar/consumir | ✅ PASS | `agent-link.ts:307-318` (pre-claim, cero DB write) + `agent-link.test.ts:237-251` (T6: `mockExecute` NO llamado, `claim_agent_link` NO llamado, `settleCalls=0`) + `agent-link.ts:378-388` + `agent-link.test.ts:254-268` (T7: drift post-claim `__quoteStale` → `reopen`, cero débito) |
| AC-4 | Token inexistente/expirado/usado → 404/410/409 sin debit/invocación | ✅ PASS | `agent-link.ts:296-305` (service) + `agent-links.ts:164-171` (route mapping) + tests: T9 expirado (`agent-link.test.ts:271-283`), T10 usado (`:286-292`), T8 inexistente (`src/routes/agent-links.test.ts:120-129`) + runtime: `claim_agent_link` sobre token expirado/inexistente → `LINK_EXPIRED`/`LINK_NOT_FOUND` reales |
| AC-5 | Sin endpoint de mutación (mint-once) | ✅ PASS | `src/routes/agent-links.ts` solo registra 2 `fastify.post` (mint + redeem), cero PATCH/PUT + `src/routes/agent-links.test.ts:146-162` (T15/T15b: PATCH y PUT → 404 real vía `app.inject`) |
| AC-6 | Redeem exitoso aplica invariantes de execute (fee, receipt, Ownership Guard) | ✅ PASS | `agent-link.ts:362-374` reusa `orchestrateService.executeApprovedPlan` sin modificar `orchestrate.ts` (confirmado: `git diff --stat main...HEAD` NO incluye `src/services/orchestrate.ts` ni `compose.ts`) + `orchestrate.ts:1090` (receiptService), `:802/1055` (protocolFeeUsdc) — se ejecutan dentro del path reusado + Ownership Guard DB-level en `settle_agent_link` (runtime: `OWNERSHIP_MISMATCH` real, ver tabla) |
| AC-7 | Exposición del token = 1 ejecución hasta el cap, SIN filtrar saldo del owner | ✅ PASS (tras FIX-PACK BLQ-1) | `src/types/index.ts:589-611` (`RedeemResult` acotado: `orchestrationId`, `answer`, `protocolFeeUsdc`, `pipeline{success,output}` — SIN `remainingBudgetUsd`/`feeChargeError`/`feeChargeTxHash`/`refundError`/`debitFallback`) + `agent-link.ts:126-138` (`toRedeemResult()`) + **test BLQ-1** `agent-link.test.ts:338-367` (asserts `keys` NO contiene los 5 campos de billing + `JSON.stringify(res)` no contiene el balance `'999.99'`) |

---

## BLQ-1 (leak cross-tenant) — CERRADO

Confirmado cerrado con evidencia directa:
- Shape público `RedeemResult` (`src/types/index.ts:599-611`) reemplaza el `OrchestrateResult` interno en la firma de `redeem()` (`agent-link.ts:289-292`).
- `toRedeemResult()` (`agent-link.ts:126-138`) es la ÚNICA vía de salida del redeem — no hay spread directo del result interno en ningún path (verificado leyendo las 3 salidas de `redeem`: éxito L444, catch-throw no aplica porque los errores no llevan body).
- Route (`agent-links.ts:157-162`) hace `{ kiteTxHash: req.paymentTxHash, ...result }` donde `result` YA es el `RedeemResult` acotado — no hay leak en la capa de ruta.
- Test `BLQ-1` (`agent-link.test.ts:338-367`) inyecta un `OrchestrateResult` "leaky" con `remainingBudgetUsd='999.99'` + 4 campos de billing, y asserta que NINGUNO aparece en el body devuelto — PASS confirmado en la corrida real (`npx vitest run` → 2413/2413 PASS).

**Status: CERRADO.**

---

## Invariantes money-path

| Invariante | Evidencia | Status |
|---|---|---|
| Single-use atómico (cero doble-redeem/doble-cobro bajo concurrencia) | `agent-link.test.ts:304-335` (T11, `Promise.allSettled` con 2 redeems concurrentes → 1 fulfilled + 1 rejected `AgentLinkAlreadyUsedError`, `mockExecute` llamado exactamente 1 vez, `settleCalls` con `outcome='redeemed'` exactamente 1) + runtime: `claim_agent_link` FOR UPDATE verificado directamente contra Postgres (2º claim sobre link en `redeeming` → `LINK_ALREADY_USED` real, no simulado) | ✅ |
| Price-cap server-side inviolable | `agent-link.ts:307-318` (pre-claim) + `:376-388` (post-claim `__quoteStale`) — el precio del canal NUNCA se usa como cap; `maxQuotedCostUsdc` viaja server-side a `executeApprovedPlan` (`agent-link.ts:370`) | ✅ |
| Fail-closed sin reopen tras débito real | `agent-link.ts:445-458` (catch genérico → `settle(...,'failed',...)`, terminal, CD-8) + test T13 (`agent-link.test.ts:420-437`: execute throw → `settleCalls[0].p_outcome==='failed'`; retry sobre link `status='failed'` → `AgentLinkAlreadyUsedError`, `mockExecute` sigue en 1 sola llamada — cero doble-cobro en retry) | ✅ |
| Reopen SOLO en débito-cero | 2 únicos call-sites de `outcome:'reopen'`: `__quoteStale` (`agent-link.ts:378-388`) y MNR-a `pipeline.success===false && totalCostUsdc===0` (`:396-409`) — ambos garantizan cero débito por el cap-gate/graceful-return del execute existente; NUNCA se reabre en el catch genérico (failed) | ✅ |
| MNR-a (fondos insuficientes → 503, no consume) | `agent-link.ts:396-409` + test service (`:370-396`) + test route (`src/routes/agent-links.test.ts:132-141`: 503 `LINK_EXECUTION_UNAVAILABLE`, no 200 ambiguo) | ✅ |
| MNR-b (settle-fail post-débito → result OK, no 502) | `agent-link.ts:420-443` (settle('redeemed') en su propio try/catch, log de reconciliación, `return toRedeemResult(result)` igual) + test (`agent-link.test.ts:399-417`: `settleResult` con error → `res.orchestrationId==='orch-1'` devuelto igual, NO throw) | ✅ |

---

## Gates (ejecutados por F4 — sin cr-report.md que confirmar)

- `npx tsc --noEmit` → **verde** (exit 0, "TypeScript compilation completed", sin errores).
- `npx vitest run` (suite completa) → **2413 passed / 0 failed** (incluye los 15 tests de la HU: `src/services/agent-link.test.ts` (13), `src/routes/agent-links.test.ts` (5, incl. T2b), `test/agent-links.migration.test.ts` (6 estructurales)).
- Biome/lint: no re-ejecutado explícitamente en esta sesión (no había cr-report.md que lo confirmara); `tsc` limpio + `auto-blindaje.md` documenta que CD-9/CD-10 (exactOptionalPropertyTypes, biome-ignore puntual) ya se aplicaron durante Wave 2 — no se detectó código muerto ni antipatrón al leer `agent-link.ts`/`agent-links.ts` completos.

---

## Drift Detection

- **Scope**: `git diff --stat main...feat/139-wkh-137-invocation-links` → exactamente los 10 archivos del Story File (`Files to Modify/Create` #1-10), con `test/agent-links.migration.test.ts` en vez de tocar `verify-rls-enabled.test.ts` (opción explícitamente prevista en el `[VERIFY-AT-IMPL]` del Story File, §Test Expectations nota test 14). **Cero archivos fuera de Scope IN.**
- **Cero cambios** a `src/services/compose.ts`, `src/services/orchestrate.ts` (service), `src/services/agent-price.ts` — confirmado por ausencia en el diff-stat (CD-13).
- **Waves**: implementadas en 2 commits (`344e808` feat completo W0-W3, `16e33b6` fix-pack post-AR BLQ-1+MNR). No hay evidencia de violación de orden (tipos/DB antes que service, service antes que route) — el diff es coherente con las dependencias declaradas.
- **Tests**: los 15 tests planeados en el Story File existen 1:1, más 2 adicionales (T2b prefijo link, agente-inexistente) — sin huecos.

---

## AR/CR follow-up

- BLQ-1 (leak cross-tenant): CERRADO, ver arriba.
- MNR-a/b: implementados y testeados (ver invariantes).
- MNR-c (gas overhead en mainnet, cap podría excederse por `STEP_GAS_OVERHEAD_USD`): documentado en `auto-blindaje.md:66-79` como deuda técnica explícita a resolver ANTES de ir a mainnet con overhead > 0 (hoy default 0 = sin impacto). Aceptado como TD, no bloquea testnet/v1.
- **Gap de proceso**: no existen `ar-report.md`/`cr-report.md` como artefactos en `doc/sdd/139-wkh-137-im-qr-payments/`. Recomendado para la Retro (nexus-docs): el pipeline saltó la generación de esos 2 archivos aunque el trabajo de AR (hallazgo BLQ-1) sí ocurrió y quedó documentado en `auto-blindaje.md`.

---

**F4: PASS — listo para DONE**, con la salvedad documental (no bloqueante) arriba.
