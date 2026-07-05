# Validation Report — WKH-139 v2 (Agente-Árbitro Autónomo de Disputas)

**Veredicto**: **F4: PASS** (1 hallazgo MENOR, no bloqueante — ver §5)
**Branch**: `feat/145-wkh-139-agent-arbiter` @ `c8c7862` · PR #166
**Fecha**: 2026-07-04
**Método**: worktree aislado (`git worktree add --detach c8c7862`), Postgres 15 efímero en Docker (`postgres:15-alpine`, contenedor `wkh139-pg`, puerto 55432, destruido al cierre). Árbol principal NO tocado; ninguna migración aplicada a prod/caldz.

---

## 1. Runtime / Migración (Postgres 15 efímero — evidencia en vivo)

Se reconstruyó el historial completo de 34 migraciones (`20260401000000_kite_registries.sql` → `20260704100000_wkh139_arbiter.sql`, incl. `kite_schema_transforms.sql` y roles `anon`/`authenticated`/`service_role` simulando Supabase) sobre una DB vacía. Las 34 aplicaron limpio (`ALTER TABLE`/`CREATE FUNCTION`/... sin error).

| Check | Resultado |
|---|---|
| `a2a_payment_intents_status_check` (+3 estados) | `CHECK (status = ANY (ARRAY['open','closing','settled','refunded','expired','failed','disputed','arb_closing','arb_hold']))` ✅ |
| `a2a_receipts_receipt_type_check` (+4 tipos) | `CHECK (... 'protocol_fee','budget_debit','deposit_verified','arbitration_release','arbitration_refund','arbitration_split','arbitration_hold')` ✅ |
| Tabla `a2a_arbitrations` | Existe, columnas/tipos/CHECKs/índices/FK `ON DELETE CASCADE` exactos al spec; `\d` → RLS **enabled, Policies: (none)** → deny-by-default confirmado ✅ |
| `open_dispute(uuid,text)` | `SECURITY DEFINER`; `GRANT` sólo a `service_role` (+owner postgres); `anon`/`authenticated` NO aparecen en `role_routine_grants` → REVOKE confirmado ✅ |
| `close_payment_intent_for_arbitration(uuid,text,numeric)` | idem hardening ✅ |
| **Gate anti-race `open_dispute`** | `open_dispute` en intent `open` → `disputed`. Reintento inmediato → `ERROR: INTENT_NOT_OPEN: intent … is disputed` (literal, capturado) ✅ AC-4 (DB-level) |
| **Ownership guard `open_dispute`** | owner incorrecto → `ERROR: OWNERSHIP_MISMATCH: intent … not owned by caller` (literal) ✅ CD-2 |
| **Clamp `close_payment_intent_for_arbitration` (arriba)** | `p_arb_amount=999` sobre `authorized_usd=100` → `final_amount=100.00000000` (clampado, NO 999) ✅ |
| **Clamp (abajo)** | `p_arb_amount=-50` sobre `authorized_usd=50` → `final_amount=0` (clampado a 0, NO negativo) ✅ |
| **Recovery / no-re-clamp** | Reinvocar `close_payment_intent_for_arbitration` sobre intent ya en `arb_closing` con `p_arb_amount=9999` → `final_amount=0` (el monto YA persistido en `consumed_usd`, ignora el nuevo argumento) — confirma "NO re-transiciona, NO re-clampa" ✅ |
| **Option B — gate ensanchado** | `SELECT prosrc FROM pg_proc WHERE proname='record_settle_outcome'` → `IF v_status NOT IN ('closing','arb_closing') THEN`. Idem `finalize_payment_intent`. Diff línea-por-línea contra `20260704000000_wkh135_payment_intents.sql:313-455`: **única diferencia es esa línea del predicado** en ambas funciones — todas las ramas de dinero (`settled`/`failed_unequivocal`/`else`, `refund_a2a_key_spend`, clamps) son **verbatim** ✅ CD-6 |
| **Ciclo E2E release**: `open→disputed→arb_closing→settled` | `close_payment_intent_for_arbitration(999)` → clamp a 100 → `arb_closing`; `record_settle_outcome('settled',...)` + `finalize_payment_intent(...,'settled',...)` → `status=settled, settle_tx_hash=0xTXHASH, consumed_usd=100, residual_usd=0` ✅ AC-3 |
| **Ciclo E2E refund**: `open→disputed→arb_closing→settled(residual=deposit)` | intent `authorized_usd=50`, clamp(-50)→0 → `arb_closing`; finalize con `residual=50` → `status=settled, residual_usd=50` (buyer recupera el 100%) ✅ AC-3 |
| **Exactly-once** | `finalize_payment_intent` reinvocado sobre intent ya `settled` (status fuera de `closing`/`arb_closing`) → no-op silencioso (`status`/`residual_usd` sin cambio en 3 llamadas) ✅ AC-4 |
| **AC-4 a nivel del RPC normal** | `close_payment_intent_for_settle` sobre intent `disputed` → `final_amount=0, prev_status=disputed`, **status permanece `disputed`** (no transiciona) — el RPC viejo es inerte sobre `disputed`; el guard real que produce `INTENT_NOT_OPEN` vive en TS (`closeSession`, ver §2) ✅ |
| **`_down` reversible** | Sobre slate limpio (sin filas en estados nuevos): `DROP FUNCTION` ×2, `DROP TABLE a2a_arbitrations`, ambos CHECK restaurados a su set previo (`status`: sin `disputed/arb_closing/arb_hold`; `receipt_type`: sin los 4 `arbitration_*`), `record_settle_outcome`/`finalize_payment_intent` restaurados a `IF v_status <> 'closing'` — confirmado con `SELECT prosrc` post-down ✅ |
| **Re-up idempotente** | Tras el `_down`, se re-aplicó `20260704100000_wkh139_arbiter.sql` completo sin error; CHECK vuelve a incluir los 3 estados nuevos ✅ |

---

## 2. AC Verification (código + test, archivo:línea)

| AC | Texto (resumen) | Status | Evidencia |
|----|---|--------|-----------|
| **AC-1** | Evidencia inequívoca → reglas SIN LLM | ✅ PASS | `src/services/arbiter/rules.ts:38-80` (`classify`, puro, sin I/O); reglas R-REFUND/R-RELEASE/R-SPLIT líneas 63-76. Test: `src/services/arbiter.test.ts:357-378` (`describe('AC-1 rules inequívoco')`) — `consumed==0 → refund, sin invocar LLM`. Corrida real: 88/88 tests del subset PASS (ver §4). |
| **AC-2** | Ambiguo → LLM acotado `{release,refund,split}`, LLM nunca ejecuta fondos | ✅ PASS | Ambigüedad: `rules.ts:44-61` (G-INTEGRITY/A-EMPTY-LEDGER/A-RECEIPT-MISMATCH). Escalación: `src/services/arbiter.ts:353-392`. Schema acotado + nunca-throw: `src/services/arbiter/llm-classifier.ts:75-165` (`classifyAmbiguous`, CD-9: catch→`return null` línea 154-161; validación de `decision`/`splitPct` líneas 129-150). LLM NUNCA toca el RPC de settle (sólo devuelve `{decision,splitPct?,reasoning}`; la ejecución es 100% en `arbiter.ts:414-579`). Test: `arbiter.test.ts:428-457` (`AC-2 escalado a LLM acotado`), `459-486` (LLM null → hold, fail-closed). |
| **AC-3** | Ejecuta vía settle/refund existentes + recibo inmutable con evidencia/método/razonamiento | ✅ PASS | Ejecución: `arbiter.ts:423-579` (`executeArbitration`) reusa `settlePaymentIntentOnChain` (import, `arbiter.ts:35`) + RPCs `record_settle_outcome`/`finalize_payment_intent` invocados directo (`arbiter.ts:109-171`). Recibo: `receiptService.emit(...)` en `emitAndRecord` (`arbiter.ts:762-783`) + fila `a2a_arbitrations` (`upsertArbitrationRow`, `arbiter.ts:208-243`, incluye `llm_reasoning`/`evidence_digest`). Tests: `arbiter.test.ts:380-426` (release/split), fail-closed settle: `arbiter.test.ts` describe `AC-3 fail-closed settle on-chain` (líneas ~633-687, refund completo en `unequivocal`, RECONCILE sin refund en `ambiguous`). Runtime DB (§1): ciclo release y ciclo refund confirmados end-to-end. |
| **AC-4** | Disputa bloquea cierre normal concurrente (anti-doble-settle) | ✅ PASS | Guard TS: `src/services/payment-intent.ts:577-588` — `prev_status ∈ {disputed,arb_closing,arb_hold}` → `throw new PaymentIntentError('INTENT_NOT_OPEN')`. Anti-race DB: `open_dispute` gate `status='open'` bajo `FOR UPDATE` (migración, confirmado en vivo §1). Test: `arbiter.test.ts` describe `AC-4 anti-race doble-settle` (`intent disputed → closeSession normal ve prev_status disputed → INTENT_NOT_OPEN`); exactly-once: describe `exactly-once (recovery idempotente)` (3 tests, recovery 2×/finalize-blip/settle-fail-blip). |
| **AC-5** | Restringido a testnet (2368/43113/84532), rechaza mainnet | ✅ PASS | `src/services/arbiter.ts:42-44` (`TESTNET_CHAIN_IDS` — **allowlist**, no blacklist) + guard `arbiter.ts:302-305` (`if (!TESTNET_CHAIN_IDS.has(...)) throw CHAIN_NOT_SUPPORTED`), ejecutado ANTES de `open_dispute` (BLQ-BAJO-1, ver §3). Test: `arbiter.test.ts:690-703` (`it.each([43114,8453]) → CHAIN_NOT_SUPPORTED`), `705-716` (testnet permitido). |
| **AC-6** | Sobre-tope (`ARBITER_AUTO_CAP_USD`, default 25) o ambigüedad irresoluble → `arb_hold`, cero fondos | ✅ PASS | Cap gate: `arbiter.ts:394-412` (ANTES de ejecutar, aplica a rules Y llm) + `getArbiterAutoCapUsd()` (`arbiter.ts:49-62`, nunca-throw, fallback+warn). Hold: `holdArbitration` (`arbiter.ts:728-758`) — update `disputed→arb_hold` owner+status-guarded (NO RPC de dinero), recibo `arbitration_hold` `amountUsd:0`. Test: `arbiter.test.ts:488-536` (sobre-tope + cap configurable por env), `459-486` (LLM null → hold). |
| **AC-7** | `ARBITER_ENABLED!=='true'` → 404 byte-idéntico, ningún intent entra en disputa | ✅ PASS | `src/routes/payments.ts:295-297,334-336` — el gate es lo PRIMERO en ambos handlers (antes de auth/parsing). `isArbiterEnabled()` (`arbiter.ts:65-67`, `=== 'true'` exacto). Guard TS en `closeSession` es rama muerta con flag OFF (línea 578 comentario explícito). Test: `arbiter.test.ts` describe `AC-7 flag OFF byte-idéntico` (3 tests: POST 404, GET 404, `closeSession` idéntico). |

## 3. BLQ-BAJO-1 (dispute mainnet no brickea) — cerrado

- **Fix primario** (pre-check money-free ANTES de transicionar): `arbiter.ts:286-305` — `SELECT owner_ref, chain_id` (sin `FOR UPDATE`, sin mutar) → `OWNERSHIP_MISMATCH`/`CHAIN_NOT_SUPPORTED` se lanzan **antes** de invocar `open_dispute`. Confirmado en runtime: dispute sobre chain mainnet nunca transiciona el intent (`db.row.status` sigue `'open'` en el test; en DB efímero, el guard TS nunca deja pasar un chain no-testnet a `open_dispute`, así que no hay caso DB-level de "disputed sobre mainnet" que probar aparte).
- **Rollback** (robustez): `arbiter.ts:321-326` (`try { return resolveDispute(...) } catch (err) { revertDisputeToOpen(...); throw err; }`) + `revertDisputeToOpen` (`arbiter.ts:702-722`, update `disputed→open` owner+status-guarded, money-free).
- **Sweep** (defensa en profundidad): `payment-intent.ts:1185-1199` (query `status='disputed' AND updated_at<stale`) + `payment-intent.ts:1224-1236` (loop → `arbiterService.revertDisputeToOpen`), vía import dinámico (`payment-intent.ts:1206`, rompe el ciclo `arbiter.ts↔payment-intent.ts`).
- Test: `arbiter.test.ts:721-765` — `(a) dispute mainnet → CHAIN_NOT_SUPPORTED SIN transicionar; sigue open y closeSession normal funciona` y `(b) throw post-transición (readEvidence tira) → revierte disputed→open; closeSession normal funciona`. Ambos verifican `db.row.status==='open'` tras el error, y que un `closeSession` posterior settlea con normalidad (`mockSettle` llamado, refund correcto). **Cierra BLQ-BAJO-1** ✅.

## 4. Runtime — gates (ejecutados en worktree aislado, NO en el árbol principal)

| Gate | Resultado | Nota |
|---|---|---|
| `npx tsc -p tsconfig.json --noEmit` | ✅ exit 0, "TypeScript compilation completed" | |
| `npm run lint` (`biome check src/`) | ✅ "Checked 292 files in 93ms. No fixes applied." | Explícitamente re-corrido (no sólo leído) porque lint rompió en WKH-142; limpio acá. |
| `npx vitest run` subset (`arbiter.test.ts`, `rules.test.ts`, `evidence.test.ts`, `payment-intent.test.ts`, `routes/payments.test.ts`) | ✅ 5 files, **88/88 passed** | |
| `npm test` (suite completa) | ✅ 148 files passed / 4 skipped, **2582 passed / 10 skipped**, 0 failed | Skips son `*.real.test.ts` gateados por `INTEGRATION_TEST_DB_URL` (ausente), no relacionados a esta HU. |
| CI GitHub Actions @ `c8c7862` (headRefOid confirmado) | ✅ `build-test` (tsc+lint+test), `coverage`, `light-smoke`, Vercel preview — **5/5 checks SUCCESS** | Corrido por el pipeline, no re-ejecutado acá; usado como confirmación adicional. |

## 5. Drift Detection

- **Scope**: `git diff --name-only main...feat/145-wkh-139-agent-arbiter` = 16 archivos. 13/13 del "Files to Modify/Create" del Story File presentes. **2 archivos fuera de la tabla literal**: `src/services/arbiter/evidence.test.ts` y `src/services/payment-intent.test.ts` (modificado). Ambos son tests que ejercitan código YA en scope (`evidence.ts` es item 6, `payment-intent.ts` es item 10) — **no es scope creep de money-path**, es cobertura de test razonable sobre el propio cambio. Sin impacto en el veredicto.
- **Wave order**: commits `60a3681` (feat, W0-W4 completo) → `c8c7862` (fix-pack BLQ-BAJO-1) — orden correcto, fix-pack posterior al AR.
- **Dinero intacto**: confirmado byte-a-byte en §1 (Option B) — sólo el predicado de status cambia en `record_settle_outcome`/`finalize_payment_intent`; ninguna rama de `refund_a2a_key_spend` ni clamp tocada.
- **Archivos ajenos al diff** (untracked pre-existentes: `doc/sdd/137.../validation.md`, `doc/security/audit-delta-2026-07-02.md`, etc.) — no relacionados a esta rama, no tocados por este QA.
- **Hallazgo MENOR (no bloqueante)**: `ARBITER_ENABLED` y `ARBITER_AUTO_CAP_USD` **no están documentados en `.env.example`**, rompiendo la convención existente del repo para flags de esta clase (`GASLESS_ENABLED`, `ESCROW_MODE_ENABLED`, `PASSPORT_BINDING_ENABLED`, `GASLESS_DEFAULT_CAP_USD` sí están documentados). Funcionalmente inocuo (default OFF / default 25, ambos fail-safe, código no depende de que `.env.example` exista), pero afecta operabilidad al momento de activar el flag en un entorno real. **Recomendación**: agregar ambas entradas a `.env.example` en un fix-pack chico antes de activar `ARBITER_ENABLED=true` en cualquier entorno.

## 6. Gate Confirmation

CI (`build-test`: tsc+lint+test, `coverage`) verde en GitHub Actions contra `c8c7862` (headRefOid confirmado vía `gh pr view --json headRefOid`) — 5/5 checks SUCCESS. Adicionalmente re-corridos en worktree aislado (§4) por pedido explícito del orquestador (antecedente WKH-142 lint-break) — mismos resultados verdes.

---

## Veredicto final

Los 7 ACs + BLQ-BAJO-1 tienen evidencia archivo:línea y/o runtime en vivo. Invariantes money-path (anti-race, exactly-once, clamp `[0,deposit]`, cap+hold, LLM-sin-autoridad-de-ejecución, Option B byte-idéntico para intents normales, flag OFF byte-idéntico) confirmadas tanto en código+test como en Postgres real. Migración up/down/re-up validada en Docker efímero, NO aplicada a prod. Único hallazgo es MENOR (gap de documentación en `.env.example`, no afecta comportamiento ni ACs).

**F4: PASS — listo para DONE**, con la recomendación menor de completar `.env.example` antes de flippear `ARBITER_ENABLED` en cualquier entorno real.
