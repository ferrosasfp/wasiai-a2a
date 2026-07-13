# F4 — QA Validation Report — WKH-191b (escrow settle rewire, two-hop)

> Fecha: 2026-07-13 · Branch: `feat/191b-escrow-settle-rewire` · Reviewer: nexus-qa
> Input: work-item.md + sdd.md + story-HU-191b.md + ar-report.md (APROBADO, 0 BLQ) +
> cr-report.md (APROBADO, 0 BLQ, MNR-1 cerrado en fix-pack) + handoff-191c.md

## Veredicto global: **APROBADO PARA DONE**

7/7 ACs PASS con evidencia archivo:línea. 0 drift. 0 hallazgos runtime nuevos.
Migration NO aplicada a ninguna DB (correcto — Wave 0 sigue PENDING-DEPLOY, igual
que 191a). Gates confirmados en vivo (no solo leídos de CR).

## Gates (re-ejecutados en vivo, no solo leídos de CR)

| Gate | Resultado |
|------|-----------|
| `npx tsc --noEmit` | 0 errores |
| `npx vitest run` | **2899 passed / 0 failed** / 10 skipped (159 files) — coincide con lo reportado por AR/CR (2896, +3 del fix-pack: 1 tautológico eliminado, 3 wrapper tests nuevos reales) |
| `npm run build` | OK, sin errores |
| `./node_modules/.bin/biome check src/` | 317 archivos, 0 fixes, 0 hallazgos |

## Runtime checks

- **Migration apply state**: NO VERIFICABLE vía query directa — el sandbox de
  ejecución bloqueó la conexión a la DB compartida (`bdwvrwzvsldephfibmuu`, prod-
  adjacent) por política de auto-mode ("ambiguously prod under SHARED INFRA
  BIAS"). No forcé el bypass. Evidencia indirecta suficiente: `supabase/migrations/
  20260713000001_wkh191b_debit_hop1{,_down}.sql` existen solo en el working tree
  (no en un commit previo desplegado), `doc/sdd/_INDEX.md` fila 173 marca 191a como
  "DONE (código) · PENDING-DEPLOY" (mismo patrón, un día antes) y la fila 174 (esta
  HU) aún no tiene status DONE. Consistente con el diseño: Wave 0 completa se
  despliega junta, y el trabajo operacional de alinear `OPERATOR_PRIVATE_KEY` con
  el `_operator` on-chain es explícitamente 191d (Missing Inputs, work-item.md:272-277).
- **Env var**: `ESCROW_SETTLE_ENABLED` — nombre único, sin typos, un solo punto de
  lectura (`debit-capture.ts:69-73`, AND con `isDebitCaptureEnabled()`). Default
  unset ⇒ `isEscrowSettleEnabled()===false` ⇒ fast-path byte-idéntico
  (`payment-intent.ts:503`). No aplica parity-check de deployment target: la
  feature es PENDING-DEPLOY, flag-gated OFF por default en todos lados.
- **Seam byte-idéntico (WKH-136)**: `git diff e4f8f35 -- src/services/payment-intent.ts`
  → 0 líneas borradas dentro del cuerpo de `settlePaymentIntentOnChain` (:355-471,
  leído completo, idéntico a antes de 191b). Los únicos cambios: reorder de 1
  import, 2 call-sites (`closeSession`/`settleUpto`) que pasan `keyId` y llaman
  `settleEscrowAware` en vez del seam directo, y la función nueva `settleEscrowAware`
  (:490-620) agregada después.

## ACs — evidencia

| AC | Texto (resumen) | Status | Evidencia |
|----|------------------|--------|-----------|
| AC-1 | flag ON + firma valid + escrow configurado → hop1 confirmado → hop2 | PASS | `payment-intent.ts:524-576` (hop1 antes de hop2, orden secuencial); test `payment-intent.test.ts:1611` T-1 asserta `hop1Order < signOrder` vía `invocationCallOrder` (no proxy) |
| AC-2 | flag OFF / sin firma / sin escrow → byte-idéntico | PASS | `payment-intent.ts:503,507,509,519` (fast-paths); tests T-2 (`:1630`), T-2b (`:1643`) — `mockReadValidDebitSignature`/`mockExecuteDebitHop1` `.not.toHaveBeenCalled()` |
| AC-3 | hop1 fail-safe → fallback sin mover fondos | PASS | `payment-intent.ts:535-538` (`not_moved`→seam); `debit-executor.ts:151-153,172-179,196-198` (sin PK/RPC, write-throw, revert → `not_moved`); test T-3 (`payment-intent.test.ts:1655`) `record*` nunca llamados |
| AC-4 | hop1 éxito + hop2 fail/ambiguo → reconciliation-pending, sin refund | PASS | `payment-intent.ts:540-565` (hop1 ambiguous), `:590-606` (hop2 failed, remap unequivocal→ambiguous); tests T-4 (`:1671`), **T-4 caller** (`:1685`) asserta `db.row.settle_outcome==='failed_ambiguous'` **y** `db.refunds).toEqual([])` contra la DB in-memory real, T-4b (`:1704`) hop1 ambiguous sin hop2 (`mockSign.not.toHaveBeenCalled()`) |
| AC-5 | exactly-once — hop1 ya persistido → skip, solo hop2 | PASS | `payment-intent.ts:522-523` (`if (row.debit_hop1_tx_hash)` skip); RPC `record_debit_hop1` idempotente por `COALESCE` (`20260713000001_wkh191b_debit_hop1.sql:55-57`); test T-5 (`payment-intent.test.ts:1728`) + wrapper test idempotencia (`debit-executor.test.ts:342-360`) |
| AC-6 | chain sin escrow configurado → comportamiento AC-2 | PASS | `payment-intent.ts:508-509` (`resolveEscrowContract===null`→seam); test T-6 (`payment-intent.test.ts:1745`) |
| AC-7 | leer solo firma valid más reciente (owner_ref-guarded), sin duplicar anti-replay | PASS | `debit-capture.ts:112-122` (`.eq('owner_ref',...)`, `order by captured_at desc limit 1`); sin nuevo índice/constraint de nonce en 191b (grep confirma, único índice de unicidad sigue siendo `uq_debit_sig_valid_nonce` de 191a) |

## Ownership Guard + anti-replay

- Reader (`debit-capture.ts:118`): `.eq('owner_ref', ownerRef)` presente.
- Ambos RPC nuevos (`record_debit_hop1`, `record_debit_settle_status`,
  `20260713000001_wkh191b_debit_hop1.sql:43-52,95-104`): `SELECT owner_ref ...
  FOR UPDATE` + `IS DISTINCT FROM` → `OWNERSHIP_MISMATCH`; `SECURITY DEFINER` +
  `SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon,
  authenticated` + `GRANT ... TO service_role` en ambos. Patrón WKH-53 respetado.
- Anti-replay: nonce quemado on-chain (`_usedNonces`) + índice único parcial de
  191a — 191b no define un segundo mecanismo (AC-7 cumplido).

## Money-safety / accounting

- Ninguna rama de `settleEscrowAware` reembolsa cuando hop1 movió fondos
  (`reconciliation_pending` remapea `unequivocal→ambiguous`, CD-S4). Confirmado
  por T-4 caller con la DB in-memory (`db.refunds` vacío tras `failed_ambiguous`).
- El double-book temporal (buyer debitado on-chain + budget off-chain no
  reembolsado en `reconciliation_pending`) está explícitamente documentado en
  `handoff-191c.md` como invariante que 191c debe resolver (exactamente-un-lado,
  nunca double-credit, nunca fondos colgados) — no es un hallazgo nuevo de F4,
  ya lo abrió AR (MNR-1) y quedó formalizado en el handoff dedicado.

## Migración

Additive: 3 columnas nullable + `CHECK`, 1 índice parcial, 2 RPC `SECURITY
DEFINER` (`20260713000001_wkh191b_debit_hop1.sql`). `_down.sql` reversible
(dropea exactamente lo que agrega, no toca datos de 191a). Wrap `BEGIN/COMMIT`.
NO aplicada a ninguna DB (ver Runtime checks arriba).

## Drift

- Archivos modificados/nuevos == Scope IN exacto (migración+down, `abi.ts`
  aditivo, `debit-capture.ts`+test, `debit-executor.ts`+test nuevo,
  `payment-intent.ts`+test, `database.types.ts` aditivo, `_INDEX.md` fila 174).
  Sin refactors fuera de scope.
- Sin cambios en `contracts/` (CD-5) ni en `arbiter.ts` (CD-6) — confirmado
  (no aparecen en `git status`/diff).
- Fix-pack CR MNR-1 verificado cerrado: `grep "expect(true).toBe(true)"
  src/adapters/escrow/debit-capture.test.ts` → sin coincidencias; los 3 tests
  reales del wrapper `recordDebitHop1`/`recordDebitSettleStatus` existen en
  `debit-executor.test.ts:311-395` y assertan args exactos al RPC (incluyendo
  `p_nonce` como `string`, CD-S1) + propagación del hash COALESCE.

## AR/CR follow-up

- AR: APROBADO con MENORs (MNR-1 doc-only → cerrado vía `handoff-191c.md`;
  MNR-2 test-coverage opcional → backlog, no bloquea).
- CR: APROBADO con MENORs (MNR-1 test tautológico → cerrado en fix-pack,
  verificado arriba).
- Sin BLOQUEANTEs en ninguna revisión.

**Listo para DONE.**
