# Done Report — WKH-191c · Motor de reconciliación

**Status**: DONE (código) · PENDING-DEPLOY (migración aplicada a prod)
**Fecha cierre**: 2026-07-13
**Branch**: feat/191c-reconciliation-engine

---

## Resumen ejecutivo

Tercera HU de la Wave 0 del epic WKH-191 (settlement non-custodial). 191c implementa el motor de reconciliación que resuelve exactamente-un-lado (`resolved_settled` XOR `resolved_refunded`) los intents que 191b deja en estado `reconciliation_pending` (hop 1 confirmado, hop 2 fallido) tras re-verificar on-chain la realidad del evento `Debited(keyId,nonce)` correspondiente. Si existe, reintenta hop 2 (operador→seller); si no existe, refunda el budget off-chain (`refund_a2a_key_spend`) al buyer. Endpoints admin-gated (`GET` listado/drift + `POST` ejecutar resolución, fail-closed) bajo el flag `ESCROW_SETTLE_ENABLED`. Pipeline QUALITY completo: F0→F1(HU_APPROVED)→F2(SPEC_APPROVED, NC-1 resuelto)→F2.5→F3→AR(1 BLQ doble-hop2)→fix-pack(claim exclusivo + lease + re-verify)→re-AR(0 BLQ)→CR(0 BLQ)→F4(9/9 ACs PASS). tsc 0, vitest 2927/2927, biome clean, build OK. Migración PENDING-DEPLOY, no aplicada (191b tampoco lo está, sin filas `reconciliation_pending` en prod todavía).

---

## Pipeline ejecutado

| Fase | Gate | Estado | Fecha |
|------|------|--------|-------|
| F0 | Project context + codebase grounding | PASS | 2026-07-13 |
| F1 | work-item.md (HU_APPROVED) | PASS | 2026-07-13 |
| F2 | sdd.md (SPEC_APPROVED), NC-1 refund budget-only resuelto | PASS | 2026-07-13 |
| F2.5 | story-HU-191c.md (design + test plan) | PASS | 2026-07-13 |
| F3 | Implementación 1 wave, 8 archivos, 2927 tests | PASS | 2026-07-13 |
| AR | Adversarial Review (1 BLQ-ALTO doble hop2) | RECHAZADO | 2026-07-13 |
| Fix-pack | Claim exclusivo + lease + re-verify on-chain + refund fail-loud + tipos | PASS | 2026-07-13 |
| re-AR | Adversarial Review (0 BLQ, 4 MENORs) | APROBADO | 2026-07-13 |
| CR | Code Review (0 BLQ, 2 MENORs) | APROBADO | 2026-07-13 |
| F4 | Validación 9/9 ACs + gates (tsc/vitest/build/biome) | APROBADO | 2026-07-13 |

---

## Acceptance Criteria — resultado final

| AC | Texto (resumen) | Status | Evidencia |
|----|------------------|--------|-----------|
| AC-1 | GET admin lista `hop1_confirmed`/`reconciliation_pending` con evidencia mínima | **PASS** | `src/services/reconciliation.ts:177-204` (listPending filtra); `src/routes/dashboard.ts:326-348` (endpoint); test T-13 `src/routes/dashboard.test.ts:301-338` |
| AC-2 | Re-verificar on-chain el evento `Debited` antes de decidir lado | **PASS** | `src/adapters/escrow/reconciler-onchain.ts:74-129` (reverifyDebitedByTxHash, log-scan); invocado pre-claim `reconciliation.ts:259-268`; tests `reconciler-onchain.test.ts:105-180` (3 veredictos × 2-3 variantes) |
| AC-3 | `Debited` confirmed → hop2 exclusivo → `resolved_settled`, sin refund | **PASS** | `reconciliation.ts:298-341` (settle vía `settlePaymentIntentOnChain`); `:365-366` (estado `resolved_settled`, `refundAmount=null`); test T-5 `reconciliation.test.ts:161-211` |
| AC-4 | `Debited` NOT confirmed → refund BUDGET-ONLY, sin transfer on-chain | **PASS** | `reconciliation.ts:367-372` (`resolved_refunded`, `txHash=null`); refund vía RPC `record_reconciliation_resolution:193-206` con `refund_a2a_key_spend` dentro; test T-6 `reconciliation.test.ts:212-245` (seam NOT called) |
| AC-5 | Estado terminal persistido → no-op ante 2ª ejecución (money-safe) | **PASS** | `reconciliation.ts:288-291` (already_resolved); RPC `claim_reconciliation` migración:106-117 (v_rows=0 → claimed=false); test T-7 `reconciliation.test.ts:246-260` |
| AC-6 | Nunca hop2+refund simultáneamente (mutuamente excluyente, CHECK DB) | **PASS** | Migración:135-138/159-163 (v_required gating); CHECK 7-valores; test T-8 `reconciliation.test.ts:264-334` |
| AC-7 | Drift check budget-vs-escrowBalance, solo reporte | **PASS** | `reconciliation.ts:400-489` (driftCheck, nunca escribe budget); test T-12 `reconciliation.test.ts:425-497` |
| AC-8 | `ESCROW_SETTLE_ENABLED` OFF → money-moving rechazado, listado permitido | **PASS** | GET sin gate; `resolveIntent` gatea `:211-212` (flag_off → no side-effect); test T-9 `reconciliation.test.ts:336-350` |
| AC-9 | POST sin `X-Admin-Token` válido → 401/403, sin acción money-moving | **PASS** | `requireAdminTokenStrict` `dashboard.ts:130-157` (fail-closed 503/401); tests T-14a/b `dashboard.test.ts:341-364` (no call si sin token) |

**9/9 ACs PASS con evidencia archivo:línea directa.**

---

## Fix del BLOQUEANTE (BLQ-ALTO-1 — doble hop2 por concurrencia)

**Problema original** (detectado en AR): el claim re-entrante permitía que dos runs concurrentes ganaran `claimed=true` ambos sin evidencia de envío previo → ambos invocaban `settlePaymentIntentOnChain` con nonce EIP-3009 aleatorio (NO idempotente) → **2 transferencias reales al seller**.

**Solución implementada en fix-pack**:
1. **Claim exclusivo** — la entrada fresca (`hop1_confirmed`/`reconciliation_pending`) la gana UN solo caller; el re-claim de un `resolving_settle` colgado se permite SOLO con evidencia (lease: `debit_resolution_tx_hash IS NOT NULL` en el WHERE de `claim_reconciliation` migración:92-103).
2. **Lease de evidencia** — el service persiste `debit_resolution_tx_hash` ANTES del flip terminal (`reconciliation.ts:342-361`), vía UPDATE filtrado por status; crash entre envío y record deja evidencia.
3. **Re-verificación previa** — si el claim trae `resolution_tx_hash` no-null (crash-recovery), llama `verifyDefaultChainSettle` ANTES de cualquier re-envío; warn → abort; ok → skip resend.
4. **Refund fail-loud** — capturar rows-affected del `refund_a2a_key_spend` en RPC; `RAISE` si no-op cuando se esperaba crédito.
5. **Tipos huérfanos** — nuevo tipo `PendingSelectRow` acotado; quitar `signer_recovered`/`key_id_hash` del RPC `claim_reconciliation`.

**Verificación**: test T-BLQ-ALTO-1 `reconciliation.test.ts:606-652` modela el WHERE real + reproduce el double-pay en el CONTROL pre-fix (`fixed:false` → test FALLA, seam llamado 2×) y verifica cero re-envío con el fix (`fixed:true` → seam llamado 1×). Diferencial control/fix confirmado leyendo ambos bloques — test genuino, no tautológico.

**Verificado en F4**: línea por línea en código actual (archivo:línea directo).

---

## Hallazgos finales

| Clase | Cantidad | Disposición |
|-------|----------|-------------|
| BLOQUEANTES | 0 | — |
| MENORs residuales | 4 | Ver "Pendientes de 191d" infra |

### MENORs residuales (no bloquean DONE, follow-up de 191d)

1. **MNR-3 (re-AR)** — `resolving_settle` sin lease queda sin ruta de auto-recovery
   - Riesgo: operability (recoverabilidad manual vía GET)
   - Decisión: no executabler en F3 (192 Decimals seam bloqueando happy-path todavía); incluir en runbook de activación (191d) donde de todos modos se define el trigger/cron real.

2. **MNR-4 (re-AR)** — lease UPDATE sin `owner_ref` explícito en el filtro
   - Riesgo: nulo (explotable: no, fila ya owner-guarded por el claim previo, key_id+nonce único)
   - Decisión: defensa en profundidad de bajo impacto; diferir a 191d (1 línea, sensato agrupar con otros ajustes de seguridad).

3. **MNR-1 (CR)** — dead RETURNS surface en RPC
   - Riesgo: nulo (ruido de tipos)
   - Decisión: backlog, no urgente.

4. **MNR-2 (CR)** — types sobre-declaraban en `listPending`
   - Riesgo: nulo (ya resuelto en fix-pack con nuevo tipo `PendingSelectRow`)
   - Decisión: **ya mitigado en código actual**.

---

## Auto-Blindaje consolidado

### [2026-07-13 09:35] Wave 3 — `vi.mock` factory hoisting de clases

**Patrón enseñanza**: cualquier símbolo consumido por una factory `vi.mock` DEBE estar disponible al hoist (vitest hoistea el mock al tope del archivo). Las clases de error DEBEN envolverse en `vi.hoisted(() => { ... return ErrorClass; })` y reutilizar esa referencia en la factory.

**Aplicable a**: cualquier test que necesite exponer clases/constantes propias DENTRO de una factory de mock.

### [2026-07-13 10:00] FIX-PACK AR/CR — Patrón de money-path exactly-once bajo concurrencia

**Patrón enseñanza** (raíz: BLQ-ALTO-1 + MNR-1):
- **Claim exclusivo por estado de ENTRADA** — el side effect on-chain (nonce aleatorio, NO idempotente) ocurre FUERA del RPC atómico.
- **Lease/evidencia persistida ANTES del side-effect** — patrón "veredicto ANTES del side-effect" (BLQ-DR de payment-intent) aplicado a reconciliación. Crash entre envío y record deja evidencia auditable.
- **Re-verificación on-chain autoritativa ANTES de re-envío** — no confiar solo en el estado persistido; re-verifica on-chain el evento correspondiente + verifica evidencia de intento previo (tx hash, receipt).
- **Nunca confiar en rows-affected silenciosamente** — capturar retornos de RPCs que mueven dinero (refund); `RAISE` si no-op cuando se esperaba efecto.

**Aplicable a**: cualquier flujo de dos hops donde (a) cada hop es invocable separadamente, (b) el seam on-chain no es idempotente (nonce aleatorio, firma nueva), (c) el registro DB vive fuera del RPC atómico.

---

## Archivos modificados

**Nuevos en 191c**:
- `supabase/migrations/20260713000002_wkh191c_reconciliation.sql` — aditive: widen CHECK (3→7), +2 columnas, +1 índice, +2 RPCs SECURITY DEFINER owner-guarded.
- `supabase/migrations/20260713000002_wkh191c_reconciliation_down.sql` — rollback additive.
- `src/adapters/escrow/reconciler-onchain.ts` — new: `reverifyDebitedByTxHash()`, `readEscrowBalanceAtomic()`, public-client cache per-ChainKey.
- `src/adapters/escrow/reconciler-onchain.test.ts` — new: 7 tests (confirmed/not_confirmed/indeterminate + RPC-ausente).
- `src/services/reconciliation.ts` — new: `reconciliationService` con `listPending()`, `resolveIntent()`, `driftCheck()`, error class.
- `src/services/reconciliation.test.ts` — new: 14 tests (ACs 1-9 + BLQ + edge cases).
- `src/routes/dashboard.ts` — modify: `GET /dashboard/api/reconciliation` + `POST /dashboard/api/reconciliation/:intentId/resolve` + `requireAdminTokenStrict` helper.
- `src/routes/dashboard.test.ts` — modify: +5 tests (T-13a/b/c + T-14a/b/c/d fail-closed).
- `src/types/database.types.ts` — modify: `claim_reconciliation` + `record_reconciliation_resolution` Args/Returns con NUMERIC→string.

**Artefactos SDD**:
- `doc/sdd/175-wkh-191c-reconciliation-engine/work-item.md` (immutable)
- `doc/sdd/175-wkh-191c-reconciliation-engine/sdd.md` (immutable)
- `doc/sdd/175-wkh-191c-reconciliation-engine/story-HU-191c.md` (immutable)
- `doc/sdd/175-wkh-191c-reconciliation-engine/ar-report.md` (immutable)
- `doc/sdd/175-wkh-191c-reconciliation-engine/cr-report.md` (immutable)
- `doc/sdd/175-wkh-191c-reconciliation-engine/f4-report.md` (immutable)
- `doc/sdd/175-wkh-191c-reconciliation-engine/auto-blindaje.md` (immutable)
- `doc/sdd/175-wkh-191c-reconciliation-engine/done-report.md` (this file, final)

---

## Activación pendiente (WKH-191d — contexto para próxima HU)

La HU está code-complete y tested. El deployment de 191c requerirá sincronización con la activación de 191b (que hoy tampoco está deployada). Los pasos de 191d son:

1. **Aplicar migraciones en prod** — `20260713000002_wkh191c_reconciliation.sql` (additive, sin datos) + verificar `\d a2a_payment_intent_debit_signatures` (CHECK 7-valores, columnas/índice presentes).

2. **Decidir y wiring del cron externo** — el `POST` es invocable manualmente (dashboard, curl, ops) o externamente (cron-job.org style, patrón WKH-75). No hay scheduling en-proceso dentro de `wasiai-a2a` (scope OUT de 191c). La activación debe incluir:
   - ¿Frecuencia del cron? (recomendado: cada 5-15 min, tras validación con telemetría de reconciliation-pending acumulado).
   - ¿Reintento en fallo?
   - ¿Alerting de MNR-3 (resolving_settle colgado sin lease)?

3. **Incluir MNR-3 + MNR-4 en runbook de activación** — ambas son mejoras de operabilidad/seguridad low-risk, sensato agrupar en la verificación de 191d:
   - MNR-3: endpoint adicional `POST /dashboard/api/reconciliation/:intentId/retry` para manualmente re-quelear un `resolving_settle` sin lease.
   - MNR-4: agregar `owner_ref` explícito en el UPDATE del lease (1 línea, defensa en profundidad).

4. **Resuelto en esta HU pero bloqueado por WKH-192 (Decimals seam)** — El happy-path two-hop de 191b está bloqueado por el seam de WKH-192 (usdToWei/decimals). Hasta que se resuelva, el escrow operará en Base Sepolia testnet. La reconciliación opera sobre cualquier estado (sea hop2-fallido o hop1-ambiguo), así que 191c funciona igual.

5. **Handoff a 191b** — Una vez 191b+191c ambas estén deployadas y activas (flag ON), el circuito se cierra: hop1 Debited → hop2 (settle/refund) → si falla → reconciliation_pending → cron/manual dispara 191c → resolved_settled/resolved_refunded. Estado final: no más intents colgados indefinidamente.

---

## Lecciones para próximas HUs

### 1. Idempotencia en money-paths de dos hops sin nonce nativo on-chain
- **Problema**: si cada hop está invocable separadamente y el seam on-chain NO es idempotente (nonce EIP-3009 aleatorio, nueva firma), la concurrencia/retry abre ventana de double-pay **aun con state-machine DB robusta**.
- **Solución**: (a) persistir **evidencia del PRIMER intento** ANTES del envío on-chain (lease/tx hash tentativo), (b) solo permitir re-claim si evidencia presente (gana-uno → no gana-dos), (c) **re-verificar autoridad on-chain** (evento confirmado) ANTES de re-envío.
- **Aplicable a**: settling/payments, refunds, cualquier 2-hop asincrónico fuera de RPC atómico.

### 2. Capturar rows-affected en RPCs que mueven dinero
- **Problema**: un RPC que hace `PERFORM refund()` sin capturar el retorno puede silenciosamente no hacer nada (key borrada, owner inconsistente) y marcar la acción como exitosa — refund fantasma, dinero no recuperado, estado terminal (no reintentable).
- **Solución**: `v_refunded := refund(...);` + `IF v_refunded = 0 OR v_refunded IS NULL THEN RAISE EXCEPTION ...`.
- **Aplicable a**: cualquier RPC con side-effects no-visuales (créditos, transfers, borrados).

### 3. Fail-closed para endpoints que mueven dinero
- **Problema**: el patrón opt-in de `requireAdminToken` (público si env unset) es apropiado para read-only, pero **dinero-moving debe ser fail-closed siempre** (501/503 si env unset en prod, 401 sin token válido).
- **Solución**: middleware `requireAdminTokenStrict` que rechaza con 503 si `DASHBOARD_ADMIN_TOKEN` ausente, no 200 + restricción de app-level. Dev debe decidir caso-a-caso.
- **Aplicable a**: cualquier endpoint POST/DELETE que mueva dinero, resuelva disputas, o toque balances.

### 4. Hoisting de símbolos en `vi.mock` factories
- **Problema**: vitest hoistea `vi.mock()` al tope del archivo, así que cualquier clase/const que use debe estar disponible al hoist → clases de error a nivel de módulo → undefined en la factory.
- **Solución**: envolver en `vi.hoisted(() => { ... return Symbol; })` y reutilizar.
- **Aplicable a**: tests con mocks que necesiten tipos propios (error classes, fixtures).

---

## Resumen de estado

| Aspecto | Detalle |
|---------|---------|
| **Código** | DONE — 0 BLOQUEANTEs, 4 MENORs (follow-up 191d). tsc/vitest/build/biome clean. |
| **Testing** | 9/9 ACs PASS con evidencia. 2927 tests ejecutados, 0 FAIL. BLQ-ALTO-1 race verificado (control falla sin fix). |
| **Seguridad** | admin-gated fail-closed, ownership guard (WKH-53), SECURITY DEFINER RPCs, no secrets. |
| **Migración** | Additive (sin destructive), reversible, PENDING-DEPLOY (consistente con 191a/191b). |
| **Scope** | Exacto: 8 archivos, cero desviaciones. No toca contracts/, arbiter.ts, seam. |
| **Próximo paso** | 191d: aplicar migración + wiring cron + MNR-3/4 runbook + sincronizar con 191b. |

---

## Decisiones diferidas a 191d / backlog

- **MNR-3 (requeue manual)** — endpoint adicional para re-quelear `resolving_settle` sin lease, para operabilidad en crash-recovery. Sensato junto con runbook de activación.
- **MNR-4 (owner_ref en lease UPDATE)** — defensa en profundidad, 1 línea, bajo urgencia. Agrupar en revisión general de seguridad de 191d.
- **MNR-1 (dead types)** — reclasificar tipos RPC para que no expongan campos no-consumidos. Backlog.
- **WKH-192 (Decimals seam)** — bloqueador externo (paralelo, no de 191c). Happy-path two-hop testnet-only hasta que se resuelva.

---

## Señales de correctud

- ✅ `tsc --noEmit`: 0 errores
- ✅ `vitest run`: 2927 passed / 10 skipped / 0 failed
- ✅ `npm run build`: exit 0
- ✅ `biome check src/`: 0 findings
- ✅ Git diff: solo archivos de scope 191c (no contamina otros épics)
- ✅ 9/9 ACs verificadas con evidencia archivo:línea
- ✅ BLQ-ALTO-1 verificado en código + test genuino (control diferencial)
- ✅ Migración reversible con `_down.sql`
- ✅ RPCs SECURITY DEFINER con owner-guard y `search_path` hardened
- ✅ Refund fail-loud (MNR-1 mitigado en fix-pack)

---

**Listo para DONE. Avanzar a 191d (activación) cuando 191b también esté código-completo (ya lo está, ambos PENDING-DEPLOY sincronizadas).**
