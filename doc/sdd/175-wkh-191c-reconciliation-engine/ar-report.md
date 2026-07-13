# Adversarial Review (AR) — WKH-191c · Motor de reconciliación

> Fase: AR (post-F3). Reviewer: nexus-adversary. Fecha: 2026-07-13.
> Input: story-HU-191c.md + sdd.md + archivos F3 (migración, reconciler-onchain.ts,
> reconciliation.ts, dashboard.ts, database.types.ts) + tests.
> Gate: `tsc --noEmit` = 0 errores · `vitest run` = 2923 passed / 10 skipped · biome = 0 findings.

## Veredicto global: RECHAZADO (1 BLOQUEANTE-ALTO activo)

El refund BUDGET-ONLY (foco #2) está **correcto y blindado**. El exactly-one-side
CROSS-side (settle XOR refund) está bien enforced por el claim gana-uno. Pero el
**exactly-one-side SAME-side bajo concurrencia** tiene un hueco de doble-pago on-chain
en el lado settle (foco #1). Un BLOQUEANTE-ALTO de data-integrity / money-path.

---

## BLQ-ALTO-1 — Doble hop2 (double-pay al seller) por resolve concurrente del mismo intent

- **Categoría**: Data Integrity (race condition / idempotencia money-path)
- **Archivos**:
  - `supabase/migrations/20260713000002_wkh191c_reconciliation.sql:80-102` (claim re-entrante)
  - `src/services/reconciliation.ts:254-326` (claim → crash-recovery → hop2)
  - `src/services/payment-intent.ts:355-471` (seam sin idempotencia, nonce EIP-3009 aleatorio)

### Descripción

El invariante de la HU (CD-1/CD-2, y R-2 que dice explícitamente estar mitigado) es:
"un intent resuelve hop2 XOR refund, nunca doble hop2/refund por concurrencia o retry".
El claim `claim_reconciliation` es el guard "gana-uno". PERO el UPDATE del claim incluye
el **propio target** en su WHERE:

```sql
AND debit_settle_status IN ('hop1_confirmed','reconciliation_pending', v_target);
```

y el comentario lo documenta: *"Re-claim del MISMO marker permitido (retry / crash-recovery)"*.
Consecuencia: dos runs concurrentes del **mismo lado** (settle) ambos obtienen
`claimed=true` — el primero mueve `hop1_confirmed → resolving_settle`, el segundo re-matchea
`resolving_settle` (ROW_COUNT=1) → también `claimed=true`. El `FOR UPDATE` sobre
`a2a_payment_intents` **serializa** los dos claims pero NO evita que ambos ganen.

En ese momento **ninguno** de los dos tiene `debit_resolution_tx_hash` persistido todavía
(se persiste recién en el paso 7, DESPUÉS del envío on-chain). Por eso el crash-recovery
(`reconciliation.ts:286`, `if (claimRow.resolution_tx_hash)`) **no dispara** para ninguno
de los dos → ambos con `skipResend=false` → **ambos llaman `settlePaymentIntentOnChain`**.

Y el seam NO tiene idempotencia propia: `payment-intent.ts:369` firma un nonce EIP-3009
**aleatorio** nuevo y settlea sin chequear si ya hubo un settle de este intent. → **dos
transferencias reales operador→seller**. Luego ambos llaman `record_reconciliation_resolution`;
el primero flipea `resolving_settle → resolved_settled`, el segundo ve `resolved_settled`,
`applied=false` (no-op en DB) — pero **el dinero ya se movió dos veces on-chain**.

El state-machine protege el **registro DB** y el **refund del budget** (que vive DENTRO del
RPC atómico, status-gated), pero **no** protege el envío on-chain del hop2, porque ese envío
ocurre FUERA del RPC gated y ANTES de persistir cualquier evidencia. Asimetría clave: el lado
**refund es seguro** (el crédito del budget está dentro del RPC gated → el 2º run ve
`applied=false` y no re-acredita); solo el lado **settle** tiene el envío on-chain sin gate.

### Reproducción

1. Intent en `reconciliation_pending`, `Debited` confirmado on-chain, flag ON, token admin OK.
2. Disparar dos `POST /dashboard/api/reconciliation/:intentId/resolve` casi simultáneos
   (doble-click, retry-on-timeout de un proxy, o —futuro 191d— el cron solapado con un retry
   manual). El endpoint es `rateLimit:false`.
3. Ambos: `reverify → 'confirmed'` → `side='settle'`.
4. Run-A claim: `hop1_confirmed → resolving_settle`, `claimed=true`, `resolution_tx_hash=null`.
5. Run-B claim (serializado tras A): `resolving_settle → resolving_settle`, ROW_COUNT=1,
   `claimed=true`, `resolution_tx_hash=null`.
6. Ambos: `resolution_tx_hash` null → crash-recovery no dispara → **ambos** invocan
   `settlePaymentIntentOnChain` → **2 tx on-chain al seller**.
- **Esperado**: exactamente 1 transferencia al seller.
- **Real**: 2 transferencias → el seller cobra 2×, el operador custodia 1 solo débito → **pérdida del operador = finalAmountUsd**.

La ventana es de **varios segundos** (latencia de sign+settle+re-verify on-chain), no un race
sub-milisegundo — perfectamente alcanzable con dos clicks o un retry.

### Impacto

Doble-pago on-chain al seller + pérdida del operador por intent. Rompe el invariante central
money-safe de la HU (CD-1/CD-2) y **la mitigación que R-2 declara resuelta**. Testnet-only y
flag/admin-gated hoy, pero 191d agrega un cron que hace la concurrencia rutinaria.

### Sugerencia (el Dev decide la implementación)

Cerrar la ventana de envío on-chain, no solo la de registro. Opciones:
- Que `claim_reconciliation` en el lado settle **solo** re-otorgue `claimed=true` desde
  `resolving_settle` cuando YA exista un `debit_resolution_tx_hash` (i.e., un intento previo
  que efectivamente envió); un re-claim sin tx previo debe perder (o requerir un token/lease
  por-run) para que solo un run envíe el primer hop2.
- Persistir un `debit_resolution_tx_hash` "tentativo"/lease ANTES del envío on-chain
  (patrón "veredicto persistido ANTES del side-effect" del propio BLQ-DR de payment-intent),
  de modo que el 2º run entre por crash-recovery y NO re-envíe.
- Alternativa mínima: serializar `resolveIntent` por `intentId` (advisory lock
  `pg_advisory_xact_lock` sobre el hash del intent) durante todo el flujo settle.

> Nota: el **lado refund NO requiere cambios** — ya es idempotente por diseño.

---

## MNR-1 — `record_reconciliation_resolution` ignora el rows-affected del refund (refund silencioso)

- **Categoría**: Data Integrity / Error Handling
- **Archivo**: `supabase/migrations/20260713000002_wkh191c_reconciliation.sql:180`

`PERFORM refund_a2a_key_spend(...)` descarta el `INT` (filas afectadas) que devuelve el RPC.
Si el refund es no-op (key borrada, owner_ref inconsistente entre `a2a_agent_keys` e intent,
o monto ≤0 por un edge), el flip a `resolved_refunded` igual ocurre y el RPC reporta
`applied=true` → el buyer **nunca recupera su budget**, el estado es terminal (no reintentable)
y **no hay señal**. Probabilidad baja (requiere inconsistencia de datos que 191a/191b previenen),
por eso MENOR, pero es un fallo silencioso en el corazón de la garantía money-safe del refund.

- **Sugerencia**: capturar el retorno (`v_refunded := refund_a2a_key_spend(...)`) y `RAISE`
  (o al menos loguear vía tabla de auditoría) si es `0` cuando se esperaba un crédito >0.

---

## MNR-2 — Retry de `settle_failed` puede re-enviar hop2 a ciegas (R-3, no gateado a revisión manual)

- **Categoría**: Data Integrity (idempotencia) — misma raíz que BLQ-ALTO-1
- **Archivo**: `src/services/reconciliation.ts:315-322`

En `settle_failed` el service retorna ANTES del paso 7, así que `debit_resolution_tx_hash`
**nunca se persiste**. Un retry posterior (o el cron 191d) re-claim `resolving_settle` con
`resolution_tx_hash=null` → crash-recovery no dispara → **re-envía hop2 a ciegas**. Si el fallo
previo fue `ambiguous` (la tx PUDO haber movido fondos), el retry duplica el pago. El SDD
documenta esto como **R-3** (prob B / impacto M, aceptado) y dice que el estado "queda
`resolving_*` (surface en el GET) para verificación manual" — pero el código **no bloquea** un
retry automático; la mitigación "manual review" no está enforced. Como está documentado
(respeto decisiones documentadas), lo dejo MENOR, pero señalo que el fix de BLQ-ALTO-1
(persistir evidencia antes del envío) también cerraría este vector.

---

## Categorías revisadas

| # | Categoría | Resultado |
|---|-----------|-----------|
| 1 | Security | **OK** — `requireAdminTokenStrict` fail-closed correcto (503 env unset dev+prod, 401 sin/malo header, timing-safe con guard de longitud, `dashboard.ts`); GET opt-in read-only; sin secrets; validación de `p_side`/`p_terminal_status` en RPCs. Tests T-14a/b/c/d cubren AC-9/CD-7. |
| 2 | Error Handling | **OK** — reader on-chain no-throw (todo error → `indeterminate`/`null`); service mapea errores a `ReconciliationError` disclosure-safe; seam nunca rechaza; try/catch en ambos endpoints. |
| 3 | Data Integrity | **BLQ-ALTO-1** (doble hop2 concurrente) + **MNR-1** (refund silencioso) + **MNR-2** (retry ambiguo). |
| 4 | Performance | **OK** — `driftCheck` hace awaits secuenciales por key (readContract + budget) — O(keys), pero es un reporte admin-triggered, acotado y report-only. No es finding. |
| 5 | Integration | **OK** — migración 100% aditiva, filas existentes intactas, backward-compat; DT-R2 (seam directo en vez de `settleEscrowAware`) documentada y respetada; sin deps nuevas; RPCs de wkh135/191a/191b no tocados. |
| 6 | Type Safety | **OK** — NUMERIC uint256 (`nonce`/`amount_atomic`) siempre `string`/`BigInt`; `database.types.ts` con `string` para esos params; casts a test-double justificados con biome-ignore; sin `any` productivo. |
| 7 | Test Coverage | **OK** — 14 tests, ≥1 por AC, sin `expect(true).toBe(true)`, T-8 documenta la integración SQL honestamente. Nota: ningún test ejercita el race concurrente (inherente al bug del diseño, no simulable en unit sin Postgres) — la falta de test NO oculta el bug pero tampoco lo caza; el fix debería venir con un test de concurrencia/integración. |
| 8 | Scope Drift | **OK** — solo los 9 archivos de Scope IN; `contracts/`, `arbiter.ts`, seam decimals (WKH-192) intactos. |
| 9 | Destructive Migrations | **OK** — DROP/ADD del CHECK dentro de `BEGIN/COMMIT`; down reversible; VERIFY-AT-IMPL (R-5) **verificado**: 191b agregó `debit_settle_status` vía `ADD COLUMN ... CHECK` inline → nombre auto `a2a_payment_intent_debit_signatures_debit_settle_status_check` (62 chars, sin truncar), que es exactamente el que el DROP CONSTRAINT targetea. No destructivo. |
| 10 | RPC SECURITY DEFINER | **OK** — ambos RPCs: `SET search_path = public, pg_temp`, `REVOKE ... FROM PUBLIC, anon, authenticated`, `GRANT ... TO service_role`, owner-guard `FOR UPDATE` sobre `a2a_payment_intents` + `IS DISTINCT FROM`. Sin SQL dinámico / `EXECUTE format`. El `p_owner_ref` que envía el service es el REAL de la fila (`reconciliation.ts:228`), no el del caller. |
| 11 | Cache Invalidation | **N/A** — la HU no introduce ninguna capa de cache (React Query/SWR/Redis/revalidate). El cache de public-client per-ChainKey es de conexión RPC, no de datos de negocio. |

---

## Orden del fix-pack (por prioridad)

1. **BLQ-ALTO-1** — cerrar el doble hop2 concurrente (persistir evidencia/lease antes del
   envío on-chain, o gate del re-claim settle, o advisory lock por intent). BLOQUEA el gate.
2. **MNR-1** — capturar rows-affected del refund (opcional, recomendado ahora: es money-path).
3. **MNR-2** — se cierra junto con BLQ-ALTO-1 (misma raíz); si no, documentar/gate el retry.

Solo **BLQ-ALTO-1** bloquea el gate. Las 2 MENOR se documentan y el Dev/orquestador deciden
si entran en el mismo fix-pack.

---

# Re-AR (post fix-pack) — 2026-07-13

> Reviewer: nexus-adversary. Input: fix-pack sobre `claim_reconciliation`,
> `record_reconciliation_resolution` (migración) + `reconciliation.ts` (lease + reverify) + test de race.
> Gate: `tsc --noEmit` = 0 · `vitest run` = **2927 passed** / 10 skipped (161 files) · biome = 0.

## Veredicto re-AR: APROBADO con MENORs (0 BLOQUEANTES)

`BLQ-ALTO-1` **RESUELTO y verificado en las dos capas**. `MNR-1` **RESUELTO**. Quedan 2 MENOR
(ambos money-safe, no bloquean el gate).

### BLQ-ALTO-1 — RESUELTO (doble hop2 concurrente)

**Capa 1 — claim exclusivo** (`migración :92-103`): el WHERE ya NO re-matchea incondicionalmente
el target. Ahora:
```sql
debit_settle_status IN ('hop1_confirmed','reconciliation_pending')      -- entrada fresca (gana-uno, serializada por FOR UPDATE)
OR (debit_settle_status = v_target
    AND (p_side = 'refund' OR debit_resolution_tx_hash IS NOT NULL))     -- re-claim SOLO con evidencia
```
Traza de la race: Run-A gana la entrada fresca (`hop1_confirmed → resolving_settle`, `tx=NULL`).
Run-B, concurrente, llega durante la ventana de envío de A (ANTES de que A persista el lease):
`status=resolving_settle` + `p_side=settle` + `debit_resolution_tx_hash IS NULL` → re-claim
DENEGADO → `claimed=false` → `already_resolved`. **Solo un run envía el hop2.** El lado refund
sigue permitiendo re-claim (idempotente por el status-gate del RPC) sin riesgo.

**Capa 2 — lease + re-verificación previa** (`reconciliation.ts :341-361`, `:302-320`): tras un
hop2 exitoso el service persiste `debit_resolution_tx_hash` sobre la fila `resolving_settle`
**ANTES** del flip terminal. Si el proceso muere entre el envío y el `record`, el lease queda
seteado → un retry re-claima ESA fila (el claim settle exige tx) y **re-verifica on-chain**
(`verifyDefaultChainSettle`) ANTES de re-enviar → `ok:true` → `skipResend` → nunca double-paga.

**Verificación**: los 4 tests de `describe('BLQ-ALTO-1 race ...')` son guardianes con
diferencial genuino: el CONTROL (`fixed:false`, semántica pre-fix) reproduce el re-envío
(`seamCalls === 1` = double-pay); el caso fixed asserta `seamCalls === 0`. La "entrada fresca"
asserta el lease (`row.tx === '0xsettle1'`) antes del flip, y el crash-recovery asserta que
`verifyDefaultChainSettle` corre y NO re-envía. Limitación honesta (declarada en el test): el
WHERE SQL se **modela** en el harness (no hay Postgres en unit) → el test guarda el contrato del
service; la corrección del WHERE de la migración descansa en review (verificado acá por traza).

**Vectores de double-move re-auditados — todos cerrados**:
- Concurrente fresh settle → 2º pierde el claim (sin lease en la ventana). OK.
- Concurrente tras lease → 2º re-claima pero `skipResend` (verify ok) + record gated. Cero re-envío. OK.
- Cross-side (settle↔refund) → el 2º lado nunca matchea el `v_target` opuesto → `claimed=false`. OK.
- Refund concurrente → crédito status-gated dentro del RPC → 2º `applied=false`, sin re-crédito. OK.

### MNR-1 — RESUELTO (refund silencioso)

`record_reconciliation_resolution :196-205`: captura `v_refunded := refund_a2a_key_spend(...)` y
`RAISE EXCEPTION 'REFUND_NOOP'` si `NULL`/`0`. El RAISE revierte atómicamente el flip a
`resolved_refunded` → el intent queda `resolving_refund` reintentable y el caller ve el error
(500) — nunca un refund fantasma marcado como resuelto. Idempotencia intacta (retry sobre
`resolved_refunded` → `v_rows=0` → `applied=false`, sin 2º crédito).

## MENORs residuales (no bloquean el gate)

### MNR-3 (NUEVO) — `resolving_settle` sin lease no es auto-completable (recoverability)

- **Categoría**: Data Integrity (recuperación) · **Archivo**: `reconciliation.ts :331-339` + `migración :99-102`
- Un settle que llega a `resolving_settle` pero **falla/crashea ANTES de persistir el lease**
  (`tx=NULL`) — p.ej. `settle_failed` con `failureKind:'unequivocal'`, o crash entre claim y envío —
  ya NO puede completarse vía `resolveIntent`: `reverify=confirmed → side=settle → claim` con
  `status=resolving_settle` + `tx IS NULL` → re-claim denegado → `already_resolved` para siempre.
  Queda **parkeado**: surface en el `GET` (`listPending` incluye `resolving_settle`) pero **sin
  ruta self-service ni endpoint admin** para requeuearlo → requiere intervención manual en DB.
- **Impacto**: money-SAFE (nunca double-paga, nunca pierde fondos — operador en custodia + auditable),
  pero un fallo unívoco que **podría** re-enviarse seguro queda bloqueado detrás de un paso manual.
  Es el tradeoff deliberado del fix y coincide con la filosofía documentada **R-3** ("queda
  `resolving_*` para verificación manual") → por eso MENOR, no bloqueante.
- **Sugerencia (opcional)**: un endpoint admin "requeue" que resetee `resolving_settle → reconciliation_pending`
  SOLO cuando `reverify=confirmed` y `debit_resolution_tx_hash IS NULL` (re-envío seguro), restaurando
  el auto-healing sin abrir la ventana de double-pay. O documentar el runbook manual en 191d.

### MNR-4 — lease UPDATE sin filtro `owner_ref` (defensa en profundidad)

- **Categoría**: Security (CD-8) · **Archivo**: `reconciliation.ts :347-352`
- El UPDATE del lease filtra por `key_id`+`debit_nonce`+`debit_settle_status` sin `owner_ref`.
  **NO explotable**: `key_id`+`nonce` es único y owner-bound (índice único anti-replay de 191a) y la
  fila ya pasó el claim owner-guarded; no hay cross-tenant posible. Es evidencia best-effort (el
  flip money-atomic real vive en el RPC owner-guarded). Solo se sugiere agregar `.eq('owner_ref', ownerRef)`
  como espejo del patrón CD-8/WKH-53 por consistencia. No bloquea.

## Orden del fix-pack (si el equipo decide accionar los MENOR)
1. **MNR-3** — endpoint/runbook de requeue para `resolving_settle` sin lease (recoverability).
2. **MNR-4** — `owner_ref` en el UPDATE del lease (1 línea, defensa en profundidad).

Ninguno bloquea DONE. El motor es money-safe: exactly-one-side (cross y same-side) enforced,
sin vectores de double-move, refund fail-loud, y los estados colgados son auditables.
