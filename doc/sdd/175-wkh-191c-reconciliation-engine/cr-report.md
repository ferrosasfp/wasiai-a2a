# Code Review (CR) — WKH-191c · Motor de reconciliación

> Agente: nexus-adversary (modo CR / calidad). Fecha: 2026-07-13.
> Input: `sdd.md` + `story-HU-191c.md` + archivos del Dev (migración, `reconciler-onchain.ts`,
> `reconciliation.ts`, `dashboard.ts`, `database.types.ts`, 3 test files).
> Gates verificados: `tsc --noEmit` = 0 errores · `vitest run` = **2923 PASS / 0 FAIL**
> (34 en los 3 archivos 191c, **24 tests nuevos**) · biome = 0 findings.

## Veredicto global: APROBADO con MENORs

No hay BLOQUEANTEs. 2 MENORs de calidad (no bloquean DONE). El pipeline puede avanzar a F4.

---

## Check 1 — Fidelidad SDD / Story File → OK

- Migración `20260713000002_wkh191c_reconciliation.sql` reproduce byte-a-byte el SQL del
  Story File §6 W0.1: widen CHECK 3→7 valores, +2 columnas nullable, índice parcial
  `idx_debit_sig_resolving`, 2 RPCs. Ídem `_down.sql` (restaura CHECK 3-valores).
- Los 2 RPCs coinciden con la spec: `claim_reconciliation` (gana-uno, transición condicional
  `IN ('hop1_confirmed','reconciliation_pending', v_target)`), `record_reconciliation_resolution`
  (flip status-gated `v_required` + `refund_a2a_key_spend` DENTRO del RPC, gated por
  `resolved_refunded AND p_refund_amount_usd>0`).
- `database.types.ts:2792+` agrega las 2 entradas RPC con `p_nonce:string` (NUMERIC uint256),
  `p_chain_id:number`, `p_refund_amount_usd:number|null` — exactamente lo especificado.
- Endpoints (`dashboard.ts:326` GET opt-in / `dashboard.ts:356` POST fail-closed) + estados
  (`resolving_*`/`resolved_*`) coinciden con §4.6 / §5.

### Desviación (a) — VERIFY-AT-IMPL del nombre del CHECK (R-5) → CORRECTA
`migration:21` usa `a2a_payment_intent_debit_signatures_debit_settle_status_check`. Verificado
contra 191b (`20260713000001_wkh191b_debit_hop1.sql:16-18`): el CHECK es una restricción de
**columna** inline (`ADD COLUMN ... CHECK (...)`) sin nombre → Postgres autogenera
`<tabla>_<col>_check`, que es exactamente ese literal. Longitud = **61 chars** (< límite 63 →
sin truncación). El `DROP CONSTRAINT IF EXISTS` matchea el nombre real → el widen efectivamente
reemplaza el CHECK (no queda el de 3-valores rechazando `resolving_*` en runtime). Decisión del
Dev correcta.

### Desviación (b) — hop2 vía `settlePaymentIntentOnChain` directo (DT-R2) → CORRECTA
`reconciliation.ts:308` invoca el seam directo (no `settleEscrowAware`), autorizado por DT-R2 y
CD PROHIBIDO explícito. Es hop 2 puro (operador→seller), no re-lee la firma caducada ni escribe
`debit_settle_status='settled'` fuera del state-machine. Implementación fiel.

## Check 2 — Calidad de los 24 tests nuevos → OK

- **T-6 (refund NO llama al seam)**: real — `reconciliation.test.ts:232` `expect(mockSettleSeam).not.toHaveBeenCalled()`
  + asserta `record_reconciliation_resolution` con `p_terminal_status:'resolved_refunded'`,
  `p_tx_hash:null`, `p_refund_amount_usd:2`. Money-safety verificada.
- **Idempotencia (T-7)**: `claim {claimed:false}` → `already_resolved`, `mockSettleSeam` no llamado,
  y `record` call `toBeUndefined()` (`:258`). Verifica el gana-uno, no tautológico.
- **exactly-one-side (T-8)**: honesto — documenta el gating SQL como integración no simulable y
  asserta la invariante observable (`:328` `.not.toMatchObject({p_terminal_status:'resolved_settled'})`
  en el lado refund). Cumple el auto-blindaje 191b.
- **Re-verificación**: cubre los 3 verdictos — `confirmed` (T-1), `not_confirmed` (T-2a otra
  address/otro keyId + T-2b revert), `indeterminate` (T-3a throw / T-3b RPC ausente / T-3c
  txHash null|sin-0x, con `not.toHaveBeenCalled()`).
- **fail-closed (T-14)**: 503 sin env (`:348`), 401 env-set sin header (`:361`), delega con token
  (`:385` `toHaveBeenCalledWith('i1')`), + T-14d NOT_PENDING→409.
- **Tautologías**: 0. Único `expect(true).toBe(true)` es una MENCIÓN en comentario
  (`reconciliation.test.ts:14`), no código. Grep confirmado.

## Check 3 — Migración (calidad / seguridad) → OK

- Envuelta en `BEGIN/COMMIT` (`:12`/`:197`) → sin schema corrupto por fallo parcial.
- Ambos RPCs: `SECURITY DEFINER` + `SET search_path = public, pg_temp` (`:108-109`, `:190-191`)
  + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role`. Sin
  schema-hijacking; no expuesto a PostgREST anónimo.
- Owner-guard `FOR UPDATE` sobre `a2a_payment_intents` + compara `owner_ref` (`:69-78`, `:150-159`)
  — espejo 191b, CD-8.
- `refund_a2a_key_spend` corre DENTRO del flip, status-gated (`:177-181`) → money-atomic,
  exactamente-una-vez. Retry ve `resolved_*` → `applied=false` → no re-credita.
- Sin SQL dinámico (`EXECUTE format`) → sin superficie de inyección.
- `_down` reversible (drop funciones/índice/columnas + restore CHECK 3-valores) con nota honesta
  del supuesto "sin resoluciones en vuelo". Índice parcial correcto.
- Widen CHECK es aditivo sobre columna existente (no `NOT NULL` sin default, no `DROP COLUMN`,
  no `UPDATE` masivo) → no destructivo.

## Check 4 — Legibilidad / mantenibilidad → OK (2 MENORs)

- `reconciler-onchain.ts`: log-scan (`:104-125`) espeja `debit-executor.ts`; clasificación
  confirmed/not_confirmed/indeterminate clara y comentada; cache de client per-ChainKey propio
  (`:43`, `_resetReconcilerOnchain`); bigint bien tratado (`nonce===nonce`, `readContract` →
  `bigint|null`). `DEBITED_EVENT` derivado por `parseAbiItem` (topic0 nunca literal).
- `reconciliation.ts`: `resolveIntent` sigue el flujo §4.4 paso a paso con comentarios;
  `driftCheck` agrupa por key con `absBig`/threshold; manejo de embed PostgREST
  (`firstEmbed`) robusto; BigInt en todos los NUMERIC uint256.
- `requireAdminTokenStrict` (`dashboard.ts:121+`): fail-closed limpio, reusa `timingSafeEqual`/Buffer.

## Check 5 — Consistencia → OK

- `reconciler-onchain.ts` espeja `escrow-verifier.ts` (Map `_clients` + `getReconcilerClient`
  lazy + `_reset*` test-only) y `debit-executor.ts` (log-scan). NO reusa el Map de otro módulo.
- `reconciliation.ts` sigue el shape de servicio del repo (objeto exportado + `ReconciliationError`
  disclosure-safe, patrón `PaymentIntentError`).
- Endpoints siguen `dashboard.ts` WKH-189 (generic en `.get/post<>()`, `rateLimit:false`,
  cross-tenant admin deliberado con `requireAdminToken`).
- `requireAdminTokenStrict` compone bien con `requireAdminToken`: mismo timing-safe, pero el GET
  read-only usa el opt-in y el POST money-moving usa el strict (fail-closed 503). Correcto.

## Check 6 — Manejo de errores → OK

- `indeterminate` → abort sin mover dinero (`reconciliation.ts:250`); sin chainKey/escrow → abort
  (`:239-242`). CD-3 respetado.
- Crash-recovery: `verifyDefaultChainSettle` antes de re-enviar; `warn` → abort indeterminate
  (`:295-302`, evita double-move); `ok` → skipResend. R-3 documentado como residual aceptado.
- `settle.status!=='settled'` → `settle_failed`, deja `resolving_settle`, NO flip/refund (`:315-322`).
- `ReconciliationError.code → HTTP` completo con `default→500` (`dashboard.ts:38-55`); route hace
  try/catch y loguea solo `errorClass` (disclosure-safe).

---

## MENORs (no bloquean DONE)

### MNR-1 (Type Safety / dead surface) — `claim_reconciliation` retorna columnas no consumidas
- **Archivo**: `migration:52-56` (RETURNS `signer_recovered`, `key_id_hash`) vs
  `reconciliation.ts:263-271` (el service solo tipa/usa `claimed`, `resolution_tx_hash`,
  `amount_atomic`).
- **Descripción**: `signer_recovered` y `key_id_hash` eran evidencia para el transfer on-chain del
  refund, descartado al resolverse NC-1 = budget-only (DT-R4). Quedan como superficie de retorno
  muerta.
- **Impacto**: nulo en runtime; leve ruido de mantenibilidad. Reusable a futuro.
- **Sugerencia**: dejar un comentario en el RPC indicando que son evidencia forward-compat, o
  recortarlas. No urgente.

### MNR-2 (Type Safety) — `SigWithIntentRow` sobre-declara campos no seleccionados en `listPending`
- **Archivo**: `reconciliation.ts:161-173` — el SELECT de `listPending` no trae
  `debit_key_id_hash` ni el join `a2a_payment_intents`, pero castea a `SigWithIntentRow`
  (`:113-123`) que los declara.
- **Descripción**: interfaz reutilizada entre `listPending` y `resolveIntent`; en `listPending` esos
  campos quedan `undefined` en runtime aunque el tipo los promete. Ningún acceso los toca (el `map`
  solo usa columnas seleccionadas), así que no hay bug.
- **Impacto**: nulo en runtime; el tipo miente levemente sobre lo disponible.
- **Sugerencia**: un tipo `PendingSelectRow` acotado al SELECT, o documentar. No urgente.

---

## Categorías sin hallazgos (revisadas)
- Scope discipline: solo los 9 archivos in-scope; `contracts/` y `arbiter.ts` intactos (git status limpio).
- Sin deps nuevas, sin cron/scheduler, sin `withdraw()` on-chain para refund.
- Sin `any` injustificado (los `as any` son test-doubles de supabase con biome-ignore explícito).

## Resumen
| Check | Resultado |
|-------|-----------|
| 1. Fidelidad SDD/Story (incl. R-5, DT-R2) | OK |
| 2. Calidad 24 tests | OK |
| 3. Migración / seguridad RPC | OK |
| 4. Legibilidad/mantenibilidad | OK (MNR-1, MNR-2) |
| 5. Consistencia | OK |
| 6. Manejo de errores | OK |

**Gate CR: APROBADO con MENORs.** tsc 0 · vitest 2923/2923 · biome 0. Los 2 MENORs son deuda
técnica aceptable — se decide si entran ahora o al backlog; no bloquean el avance a F4.
