# SDD #145: [WKH-139 v2] Agente-Árbitro Autónomo de Disputas

> SPEC_APPROVED: no
> Fecha: 2026-07-04
> Tipo: feature (money-path, alta sensibilidad — decide plata sin humano)
> SDD_MODE: full
> Branch: feat/145-wkh-139-agent-arbiter
> Artefactos: doc/sdd/145-wkh-139-agent-arbiter/

---

## 1. Resumen

Se construye un **agente-árbitro autónomo** que resuelve una disputa sobre un
payment-intent `session` (WKH-135) decidiendo uno de tres desenlaces —
`release` (todo al Seller), `refund` (todo al Buyer) o `split` (parcial) — y lo
**ejecuta reusando exactamente los primitivos de settle/refund ya probados** del
intent `session` (seam `settlePaymentIntentOnChain` + `record_settle_outcome` +
`finalize_payment_intent`), emitiendo un **recibo inmutable** (WKH-124) de la
resolución.

La decisión es **rules-first**: un motor determinístico ancla la resolución en
evidencia verificable (el ledger append-only de vouchers + la proof-chain de
recibos HMAC + el estado del intent). El **LLM sólo se invoca cuando la evidencia
determinística es internamente inconsistente** (integridad de la proof-chain rota
o fuentes de evidencia que se contradicen) y **nunca ejecuta fondos** — sólo
produce una recomendación acotada a los 3 desenlaces; el código determinístico la
aplica. El árbitro **auto-resuelve sólo hasta un tope** (`ARBITER_AUTO_CAP_USD`);
por encima del tope, o cuando ni las reglas ni el LLM pueden decidir sin
ambigüedad → **hold + flag a revisión humana, sin mover un centavo**. Todo el
feature está detrás de una **flag global OFF por default** (byte-idéntico apagado)
y opera **sólo en testnet**.

Resultado esperado: money-path con exactly-once, fail-closed, anti-race con el
`closeSession` normal, ownership guard y montos chain-aware (micro-USD entero),
sin que el árbitro pueda crear plata ni exceder el hold del intent.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 145 (WKH-139 v2) |
| **Tipo** | feature / billing / money-path |
| **SDD_MODE** | full |
| **Objetivo** | Árbitro autónomo rules-first que resuelve disputas sobre `session` intents y ejecuta el desenlace via los primitivos de settle existentes, con LLM acotado sólo para ambigüedad genuina, tope de auto-autoridad, hold+flag sobre-tope, y recibo inmutable. |
| **Reglas de negocio** | Ver §5 (Constraint Directives) + los 5 defaults conservadores §4.11. |
| **Scope IN** | Ver §6 IN. |
| **Scope OUT** | Ver §6 OUT. |
| **Missing Inputs** | Los 3 `[NEEDS CLARIFICATION]` del work-item quedan resueltos con **defaults conservadores a RATIFICAR por el user** (§4.11) — cero markers abiertos. |

### Acceptance Criteria (EARS)

**AC-1**: WHEN se abre una disputa sobre un `session` intent y la evidencia
determinística (ledger de vouchers + estado del intent + proof-chain de recibos)
es inequívoca, THE system SHALL resolver la disputa mediante reglas
determinísticas SIN invocar al LLM.

**AC-2**: IF el motor de reglas no puede decidir sin ambigüedad genuina (proof-chain
con integridad rota, o fuentes de evidencia que se contradicen — criterio exacto §4.6),
THEN THE system SHALL escalar a una decisión asistida por LLM **acotada a
`{release,refund,split}`** y SHALL NUNCA permitir que el LLM ejecute movimiento de
fondos — la ejecución siempre pasa por código determinístico.

**AC-3**: WHEN el árbitro alcanza una decisión (rules o LLM) dentro del tope de
autoridad, THE system SHALL ejecutarla a través de los primitivos de settle/refund
existentes de `session` (con un monto de settle **forzado por el árbitro**) y SHALL
emitir un recibo inmutable (WKH-124) documentando desenlace, monto, método
(rules/llm) y — si hubo LLM — el razonamiento registrado.

**AC-4**: WHILE un payment intent está en estado de disputa (`disputed` /
`arb_closing` / `arb_hold`), THE system SHALL NOT permitir que `closeSession`
(cierre normal) settlee el mismo intent concurrentemente (previene doble-settle).

**AC-5**: WHERE el árbitro mueve fondos, THE system SHALL restringir sus acciones a
chain IDs de testnet (`kite-ozone-testnet`=2368, `avalanche-fuji`=43113,
`base-sepolia`=84532) y SHALL NOT operar sobre chain IDs de mainnet.

**AC-6**: IF el monto en disputa (`authorized_usd` del intent) supera
`ARBITER_AUTO_CAP_USD` (env, default 25), OR el desenlace no se pudo determinar sin
ambigüedad (rules + LLM agotados), THEN THE system SHALL transicionar el intent a
`arb_hold`, emitir un recibo `arbitration_hold`, y **NO mover fondos** (revisión
humana; decisión reversible en v1).

**AC-7**: WHERE `ARBITER_ENABLED` !== `'true'`, THE system SHALL comportarse
byte-idéntico al estado actual: los endpoints de disputa responden 404 y ningún
intent entra jamás en un estado de disputa (el camino money-path normal queda
intacto).

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/payment-intent.ts` | Primitivo base (DT-1) | Seam `settlePaymentIntentOnChain` (único punto de settle on-chain, CD-7 nunca-throw, `failureKind` unequivocal/ambiguous); secuencia `close→record_settle_outcome→finalize`; recovery de `closing` con veredicto persistido + guarda in-flight vs huérfano (`allowStaleRecovery`); helpers micro-USD; `expireStale` sweep. |
| `src/routes/payments.ts` | Superficie HTTP a extender | `resolveCallerKey` → `owner_ref`; write-boundary `isFiniteNonNegative`/`isNonEmptyString`/`isDefaultChain`; `intentId` server-side; `sendPaymentError` (mapa code→HTTP disclosure-safe). |
| `supabase/migrations/20260704000000_wkh135_payment_intents.sql` | Estado + RPCs a extender | Tabla `a2a_payment_intents` (status CHECK enumerado, `settle_outcome`, `consumed_usd`, `authorized_usd` NUMERIC(20,8)); RPCs `close_payment_intent_for_settle` (FOR UPDATE + gate `status='open'`), `record_settle_outcome`, `finalize_payment_intent` (refund DENTRO de la tx status-gated). Patrón `SECURITY DEFINER` + `search_path` + REVOKE/GRANT service_role. |
| `src/services/receipt.ts` + `src/types/receipt.ts` | Recibo inmutable (CD-4) | `receiptService.emit` best-effort nunca-throw; HMAC-chain por owner; `EmitReceiptInput`; `ReceiptType` union; `verify()` con `tamper_detected`; owner-guard en `list/getById`. |
| `supabase/migrations/20260605000000_a2a_receipts.sql` + `20260611000000_a2a_receipts_deposit_verified_check.sql` | Extender `receipt_type` CHECK | Patrón additive: `DROP CONSTRAINT IF EXISTS ... ADD CONSTRAINT ... CHECK (receipt_type IN (...))`. |
| `src/services/llm/input-retry.ts` | Exemplar del LLM acotado (DT-3) | Cliente Anthropic lazy singleton; `anthropicCircuitBreaker.execute`; `AbortController` + `getLlmTimeoutMs`; `getInputRetryModel`/`getInputRetryMaxTokens`; **contrato nunca-throw → return null**; parse JSON estricto → validar shape → `null` en cualquier fallo; logs sin datos sensibles. |
| `src/services/llm/models.ts` | Getters de modelo/timeout env-driven | `getInputRetryModel/getInputRetryMaxTokens/getLlmTimeoutMs` (WKH-135). |
| `src/adapters/registry.ts` | Chain-aware / testnet guard (AC-5) | `getChainConfig().chainId`; `SUPPORTED_CHAINS` (testnet: kite-ozone-testnet/avalanche-fuji/base-sepolia; mainnet: kite-mainnet/avalanche-mainnet/base-mainnet). |
| `src/types/index.ts` | Tipos money-path | `SettleOutcome` (status `settled|failed|in_progress`, `failureKind`); `OpenSessionInput`. `exactOptionalPropertyTypes` en efecto (CD-15). |
| `doc/sdd/137.../auto-blindaje.md`, `138.../auto-blindaje.md` | Aprendizaje histórico (§ CDs 12–17) | BLQ-DR (money dentro de tx status-gated), BLQ-MED-1 (in-flight vs huérfano), BLQ-ALTO-1 (unequivocal vs ambiguous), RETURNS TABLE ambigüedad, `exactOptionalPropertyTypes`, biome noUnusedImports. |

### Auto-Blindaje histórico aplicado (últimas HUs DONE)

Patrones de error recurrentes detectados en WKH-135 (fila 137) y WKH-136 (fila 138),
convertidos en Constraint Directives de este SDD para prevenir su repetición:

- **Money fuera de la tx status-gated → double/lost refund** (WKH-135 BLQ-DR,
  BLQ-ALTO-1). → **CD-12**.
- **Estado intermedio sobrecargado: in-flight vs huérfano** (WKH-135 BLQ-MED-1). → **CD-13**.
- **`RETURNS TABLE` con nombres = columnas → "column reference is ambiguous"**
  (WKH-135 W0). → **CD-14**.
- **`exactOptionalPropertyTypes`: `?:` con `undefined` en objetos tipados**
  (recurrente WKH-133/134/136). → **CD-15**.
- **biome `noUnusedImports` / correr biome antes de cerrar wave** (WKH-135 W3). → **CD-16**.
- **Helper best-effort "nunca rechaza": TODA ruta de salida (incl. validación
  temprana) devuelve sentinela, no throw** (WKH-136 BLQ-MED-1). → **CD-9** (LLM classifier).

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/services/arbiter/llm-classifier.ts` (nuevo) | `src/services/llm/input-retry.ts` | LLM acotado nunca-throw, circuit-breaker, timeout, schema estricto → sentinela. |
| `src/services/arbiter.ts` (nuevo) — `executeArbitration` | `src/services/payment-intent.ts` `closeSession` | Secuencia settle→record→finalize, recovery, micro-USD, seam reuse (CD-6/CD-12/CD-13). |
| RPC `close_payment_intent_for_arbitration` (migración) | `close_payment_intent_for_settle` (rama `upto`, persiste `consumed_usd`) | FOR UPDATE + gate de status + persistir el monto forzado (MNR-2). |
| RPC `open_dispute` (migración) | `close_payment_intent_for_settle` (transición gateada) | Gate `status='open'` bajo FOR UPDATE = anti-race con el close normal. |
| Extensión `receipt_type` CHECK (migración) | `20260611000000_a2a_receipts_deposit_verified_check.sql` | DROP/ADD CONSTRAINT additive. |
| Endpoints `/payments/session/:id/dispute*` | `src/routes/payments.ts` `/session/:id/close` | auth, write-boundary, `sendPaymentError`. |
| `src/services/arbiter.test.ts` | `src/services/payment-intent.test.ts` | DB in-memory fiel + invariantes money-path. |

### Estado de BD relevante

| Tabla | Existe | Columnas / notas |
|-------|--------|------------------|
| `a2a_payment_intents` | Sí | `status CHECK IN ('open','closing','settled','refunded','expired','failed')` → **extender** con `'disputed','arb_closing','arb_hold'`. `authorized_usd`, `consumed_usd`, `settle_outcome`, `settle_tx_hash UNIQUE`, `residual_usd`, `owner_ref`, `key_id`, `chain_id`, `pay_to`, `expires_at`. |
| `a2a_payment_vouchers` | Sí | Ledger append-only `UNIQUE(intent_id, voucher_id)` — evidencia metered granular. |
| `a2a_receipts` | Sí | `receipt_type CHECK IN ('protocol_fee','budget_debit','deposit_verified')` → **extender** con los 4 tipos de arbitraje. HMAC-chain por owner. |
| `a2a_arbitrations` | **No** | **Nueva** (owner-guarded): registro auditable de la decisión + evidencia + razonamiento LLM. |

### Componentes reutilizables encontrados (NO recrear)

- `settlePaymentIntentOnChain` — único seam de settle on-chain. **Reusar tal cual** (CD-6).
- `record_settle_outcome` + `finalize_payment_intent` — persistencia de veredicto +
  refund atómico status-gated. **Reusar tal cual** (el refund del residual y el
  refund-completo en `failed_unequivocal` ya existen; el árbitro NO los reescribe).
- `receiptService.emit` — recibo inmutable best-effort. **Reusar**.
- `anthropicCircuitBreaker` + `getLlmTimeoutMs`/`getInputRetryModel` — infra LLM.
- `resolveCallerKey` + `sendPaymentError` + write-boundary helpers en `payments.ts`.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260704100000_wkh139_arbiter.sql` | Crear | Extiende status CHECK (+3 estados); crea tabla `a2a_arbitrations` (RLS deny-by-default); RPC `open_dispute` (open→disputed); RPC `close_payment_intent_for_arbitration` (disputed→arb_closing, monto forzado persistido en `consumed_usd`); extiende `receipt_type` CHECK (+4). | migración WKH-135 + `..._deposit_verified_check.sql` |
| `supabase/migrations/20260704100000_wkh139_arbiter_down.sql` | Crear | Reversa: DROP RPCs/tabla, restaura ambos CHECK a su set previo. | `..._down.sql` de WKH-135 |
| `src/types/arbiter.ts` | Crear | Tipos: `ArbiterDecision`, `ArbiterMethod`, `DisputeEvidence`, `ArbiterOutcome`, `ArbiterError`/codes. Sin `any`. | `src/types/receipt.ts` |
| `src/types/receipt.ts` | Modificar | Extender `ReceiptType` con los 4 tipos de arbitraje. | — |
| `src/types/database.types.ts` | Modificar | Regenerar/extender: nueva tabla + 2 RPCs. | patrón WKH-135 |
| `src/services/arbiter/evidence.ts` | Crear | Lector de evidencia **on-chain/DB únicamente**: estado del intent + ledger de vouchers + proof-chain de recibos (con verify de integridad). Owner-guarded. | `src/services/receipt.ts` |
| `src/services/arbiter/rules.ts` | Crear | Motor determinístico puro `classify(evidence)` → decisión inequívoca o `{ambiguous, reason}`. Sin I/O. | funciones puras micro-USD de `payment-intent.ts` |
| `src/services/arbiter/llm-classifier.ts` | Crear | LLM acotado nunca-throw: recibe resumen de evidencia, devuelve `{decision, splitPct?, reasoning}` acotado o `null`. NUNCA ejecuta fondos. | `src/services/llm/input-retry.ts` |
| `src/services/arbiter.ts` | Crear | Orquesta: `openDispute` (gate + evidencia + rules→llm→cap → execute/hold) + `executeArbitration` (settle forzado via seam + finalize + recibo + fila `a2a_arbitrations`) + `recoverArbClosing`. | `src/services/payment-intent.ts` |
| `src/services/payment-intent.ts` | Modificar | (a) `closeSession`: guarda que rechaza `prev_status ∈ {disputed,arb_closing,arb_hold}` → `INTENT_NOT_OPEN` (anti-race, AC-4). (b) `expireStale`: barre también `arb_closing` viejos → `arbiterService.recoverArbClosing`. | branches existentes de `closeSession`/`expireStale` |
| `src/routes/payments.ts` | Modificar | `POST /session/:id/dispute` (gated por `ARBITER_ENABLED`, 404 si off) + `GET /session/:id/dispute` (estado, owner-guarded). | `/session/:id/close` |
| `src/services/arbiter/rules.test.ts` | Crear | Unit del motor determinístico (todas las reglas + ambigüedad). | `payment-intent.test.ts` |
| `src/services/arbiter.test.ts` | Crear | Integración money-path: rules-inequívoco, ambiguo→LLM, sobre-tope→hold, anti-race doble-settle, fail-closed, flag OFF byte-idéntico. | `payment-intent.test.ts` |

### 4.2 Modelo de datos

**Extensión status CHECK** de `a2a_payment_intents` (additive):
```
status CHECK IN ('open','closing','settled','refunded','expired','failed',
                 'disputed','arb_closing','arb_hold')
```
- `disputed`: disputa abierta, decisión pendiente/tomada, dinero aún NO movido.
- `arb_closing`: árbitro ejecutando el settle forzado on-chain (espejo de `closing`;
  el monto forzado ya persistido en `consumed_usd`). Estado intermedio recuperable.
- `arb_hold`: sobre-tope o ambigüedad irresoluble → congelado, dinero NO movido,
  revisión humana (reversible en v1).

**Nueva tabla `a2a_arbitrations`** (RLS deny-by-default, service_role bypass):
| Columna | Tipo | Nota |
|---------|------|------|
| `id` | UUID PK | |
| `intent_id` | UUID FK → a2a_payment_intents(id) ON DELETE CASCADE | |
| `owner_ref` | TEXT NOT NULL | Ownership Guard (CD-2) |
| `decision` | TEXT CHECK IN ('release','refund','split','hold') | |
| `method` | TEXT CHECK IN ('rules','llm','hold') | rules-first vs escalado |
| `at_stake_usd` | NUMERIC(20,8) | = `authorized_usd` del intent (base del cap, AC-6) |
| `settle_usd` | NUMERIC(20,8) | monto forzado al Seller (0 si refund/hold) |
| `ambiguity_reason` | TEXT NULL | por qué se escaló (o por qué hold) |
| `llm_reasoning` | TEXT NULL | razonamiento auditable si `method='llm'` (CD-4) |
| `evidence_digest` | TEXT NULL | hash/resumen de la evidencia consultada |
| `status` | TEXT CHECK IN ('decided','executed','held') | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |
Índices: `(intent_id)`, `(owner_ref)`. UNIQUE parcial `(intent_id)` para 1 arbitraje
activo por intent.

**Extensión `receipt_type` CHECK** de `a2a_receipts` (additive):
```
receipt_type IN ('protocol_fee','budget_debit','deposit_verified',
                 'arbitration_release','arbitration_refund',
                 'arbitration_split','arbitration_hold')
```

**RPC `open_dispute(p_intent_id, p_owner_ref)` → RETURNS TABLE(...)**:
- FOR UPDATE + ownership guard (owner mismatch → `OWNERSHIP_MISMATCH`; no existe →
  `INTENT_NOT_FOUND`).
- Gate: si `status <> 'open'` → `INTENT_NOT_OPEN` (no se disputa lo ya
  settleado/en-cierre/expirado). **Esta cláusula + FOR UPDATE = anti-race con el
  close normal** (ambos exigen `status='open'`; el row-lock serializa; el perdedor ve
  no-open y aborta).
- Transición `open → disputed`.
- Devuelve snapshot para el árbitro: `intent_type, key_id, chain_id, pay_to,
  authorized_usd, consumed_usd, expires_at`. (Nombres de OUT distintos de columnas o
  columnas calificadas con alias — CD-14.)

**RPC `close_payment_intent_for_arbitration(p_intent_id, p_owner_ref, p_arb_amount)`**:
- FOR UPDATE + ownership guard.
- Gate: `status='disputed'` → transiciona `disputed → arb_closing`; `status='arb_closing'`
  → recovery (no re-transiciona, devuelve prev_status='arb_closing' + `settle_outcome`
  persistido, espejo de la rama `closing` de `close_payment_intent_for_settle`);
  cualquier otro → `INTENT_NOT_OPEN`.
- **Clamp** `p_arb_amount` a `[0, authorized_usd]` (el árbitro NUNCA settlea > deposit
  — invariante "no crear plata").
- **Persiste** el monto forzado en `consumed_usd` al transicionar (MNR-2: la recovery
  y la idempotencia leen el monto real de la fila, no lo recomputan).
- Devuelve la misma forma que `close_payment_intent_for_settle` (final_amount,
  prev_status, intent_type, key_id, chain_id, pay_to, authorized_usd, consumed_usd,
  settle_tx_hash, settle_outcome).

> **Reuso sin cambios**: `record_settle_outcome` y `finalize_payment_intent` NO se
> modifican. El árbitro los invoca con `p_outcome='settled'` y
> `p_residual = authorized_usd − arb_amount`; `finalize` (rama `session` + `settled`)
> ya acredita ese residual al Buyer. En `failed_unequivocal` (settle no ocurrió) ya
> refunda el deposit completo. **Toda la máquina de exactly-once/BLQ-DR se hereda.**

### 4.3 Servicios / Arquitectura

Máquina de estados de la disputa (sobre el `session` intent):

```
                       open  (intent activo WKH-135)
                         │  POST /session/:id/dispute   (ARBITER_ENABLED=true)
                         │  open_dispute()  [FOR UPDATE, gate status=open]
                         ▼
                     disputed ──────────────────────────────────────┐
                         │  arbiter.resolve():                        │
                         │   1. readEvidence (on-chain/DB only)       │
                         │   2. rules.classify()                      │
                         │        ├─ inequívoco ─────────┐            │
                         │        └─ ambiguo → llm-classifier()       │
                         │             ├─ decisión ──────┤            │
                         │             └─ null/ambiguo ──┼──► HOLD    │
                         │   3. cap gate (at_stake ≤ CAP)?            │
                         │        NO ────────────────────┼──► HOLD    │
                         │        SÍ                      ▼            │
                         │  close_payment_intent_for_arbitration()    │
                         ▼  [gate status=disputed → arb_closing]      │
                     arb_closing                                      │
                         │  settlePaymentIntentOnChain(arb_amount)    │  (arb_amount=0
                         │  record_settle_outcome(verdict)            │   → sin tx,
                         │  finalize_payment_intent(settled,residual) │   full refund)
                         │  receiptService.emit(arbitration_*)        │
                         ▼                                            ▼
              settled / refunded (terminal)                      arb_hold
                                                          (dinero NO movido; recibo
                                                           arbitration_hold; humano)
```

**Anti-race (AC-4) — mecanismo, no promesa:**
- `open_dispute` y `close_payment_intent_for_settle` **ambos** exigen `status='open'`
  bajo `SELECT ... FOR UPDATE`. Postgres serializa por el row-lock: el primero
  transiciona (a `disputed` o a `closing`); el segundo ve el status no-`open` y
  aborta sin settlear. Doble-settle imposible.
- `closeSession` (servicio) gana una guarda: si `prev_status ∈
  {disputed,arb_closing,arb_hold}` → `throw INTENT_NOT_OPEN` (409). Hoy ese
  fallthrough devuelve `'settled'` erróneamente; **esta guarda es el único cambio de
  lógica en el path existente** y es inerte con la flag OFF (ningún intent alcanza
  esos estados).
- `close_payment_intent_for_arbitration` exige `status='disputed'`: si un
  `expireStale`/close concurrente ya lo movió, aborta.

**Exactly-once:** herencia directa de la máquina WKH-135 — el refund vive DENTRO de
`finalize_payment_intent` (status-gated en `arb_closing`); re-invocarlo cuando ya es
terminal = no-op. `record_settle_outcome` persiste el veredicto antes de que
`finalize` pueda fallar; la recovery LEE el veredicto (`recoverArbClosing`) y aplica
la acción correcta — nunca asume éxito (CD-12/CD-13). `settle_tx_hash UNIQUE` bloquea
doble-settle a nivel row.

### 4.4 Motor de reglas determinístico (rules-first, AC-1) y punto de escalación (AC-2)

Evidencia admisible (DT-2 / default #2 — **SÓLO on-chain/DB, cero inputs off-chain
de las partes**):
1. **Estado del intent**: `authorized_usd` (deposit), `consumed_usd` (Σvouchers
   aceptados, clampado ≤ deposit), `expires_at`, `chain_id`, `pay_to`, `seller_ref`.
2. **Ledger de vouchers** `a2a_payment_vouchers` (append-only, owner-guarded): la
   evidencia metered granular.
3. **Proof-chain de recibos** `a2a_receipts` filtrada por `session_id` (=intent id),
   cada recibo con `receiptService.verify()` (integridad HMAC / tamper).

`rules.classify(evidence)` (puro, sin I/O), en orden:

| Regla | Condición (determinística) | Desenlace |
|-------|----------------------------|-----------|
| **G-INTEGRITY** | algún recibo de la proof-chain de la sesión falla `verify()` (`tamper_detected`) | → `ambiguous('proof_chain_tampered')` |
| **A-EMPTY-LEDGER** | `consumed_usd > 0` pero el ledger de vouchers tiene 0 filas (agregado y granular se contradicen) | → `ambiguous('evidence_incomplete')` |
| **A-RECEIPT-MISMATCH** | existe un recibo de settle/budget para la sesión cuyo monto contradice `consumed_usd` fuera de tolerancia (micro-USD) | → `ambiguous('meter_receipt_mismatch')` |
| **R-REFUND** | `consumed_usd == 0` | → `refund` (settle=0) |
| **R-RELEASE** | `consumed_usd >= authorized_usd` (meter al/sobre cap) | → `release` (settle=deposit) |
| **R-SPLIT** | `0 < consumed_usd < authorized_usd` y el ledger corrobora (Σvouchers == consumed dentro de tolerancia) | → `split` (settle=consumed, refund=residual) |

**Criterio exacto de "ambigüedad genuina" (resuelve el TBD del work-item):** las
ramas `G-INTEGRITY`, `A-EMPTY-LEDGER`, `A-RECEIPT-MISMATCH` — es decir, **sólo cuando
las fuentes de evidencia determinística se contradicen o su integridad está rota**.
En v1, con evidencia estrictamente on-chain/DB y sin inputs de las partes, el ledger
append-only es dispositivo en la mayoría de los casos ⇒ **la escalación a LLM es
deliberadamente rara** (la postura más conservadora posible). Esto materializa
default #3 (rules-first; el LLM sólo clasifica ambigüedad, sin autoridad).

**Punto de escalación al LLM (`llm-classifier.ts`, AC-2, DT-3):** SÓLO si
`classify` devolvió `ambiguous`. Recibe un **resumen de evidencia on-chain/DB**
(montos, conteos, flags de integridad — NUNCA inputs libres de las partes) y devuelve
un objeto **acotado** `{ decision: 'release'|'refund'|'split', splitPct?: number,
reasoning: string }` o `null`. Reglas duras:
- Espejo de `input-retry.ts`: cliente lazy, `anthropicCircuitBreaker`, `AbortController`
  + `getLlmTimeoutMs`, `getInputRetryModel`/`getInputRetryMaxTokens`.
- **Contrato nunca-throw** (CD-9): API ausente, breaker abierto, timeout, JSON no
  parseable, shape inválido, `splitPct` fuera de `[0,100]` → `return null` (TODA ruta
  de salida devuelve sentinela, lección WKH-136).
- El código árbitro traduce la recomendación a `settle_usd` (clamp `[0,deposit]`) y la
  **ejecuta él mismo** por el seam determinístico. El LLM **jamás** toca fondos (CD-1).
- Si el LLM devuelve `null` → `arb_hold` (fail-closed, default #4).

### 4.5 Tope de autoridad + hold + flag (AC-6, default #1)

- `at_stake_usd = authorized_usd` (el máximo que el árbitro podría desplazar).
- `ARBITER_AUTO_CAP_USD` (env, default **25**). Si `at_stake_usd > cap` → **NO ejecutar**:
  transición `disputed → arb_hold`, fila `a2a_arbitrations(decision='hold',
  method='hold', status='held')`, recibo `arbitration_hold`, **cero movimiento de
  fondos**. Aplica **antes** de ejecutar, para decisiones rules Y llm.
- El hold es **reversible en v1** (default #4): el intent queda congelado, auditable,
  y un humano puede resolverlo por fuera (la herramienta de override humano es Scope
  OUT — sólo se provee el estado + el flag).

### 4.6 Ejecución del desenlace (AC-3) — mapeo a los primitivos existentes

`arbiter.executeArbitration(intentId, ownerRef, decision, settleUsd)`:
1. `close_payment_intent_for_arbitration(intentId, ownerRef, settleUsd)` →
   `disputed→arb_closing`, `arb_amount = clamp(settleUsd, 0, deposit)` persistido en
   `consumed_usd`. `residual = deposit − arb_amount`.
2. Si `arb_amount <= 0` (**refund**): short-circuit sin tx on-chain (espejo del
   `finalMicro<=0` de `closeSession`): `record_settle_outcome('settled', null,
   residual)` + `finalize_payment_intent('settled', residual)` → refund completo al
   Buyer. Sin transfer.
3. Si `arb_amount > 0` (**release** o **split**): `settlePaymentIntentOnChain({intentId,
   ownerRef, payTo, finalAmountUsd: arb_amount, chainId})` (seam CD-6, sin duplicar).
   - `settled` → `record_settle_outcome('settled', txHash, residual)` +
     `finalize('settled', residual)` → Seller cobra `arb_amount`, Buyer recupera
     `residual`. (release ⇒ residual 0; split ⇒ residual > 0.)
   - `failed/unequivocal` → `finalize('failed_unequivocal')` → Buyer recupera el
     deposit completo (settle no ocurrió). `failed/ambiguous` → `finalize('failed_
     ambiguous')` (RECONCILE, sin refund, log.warn) — herencia BLQ-ALTO-1.
4. Emitir recibo inmutable (`receiptService.emit`, best-effort) con
   `receipt_type='arbitration_release'|'arbitration_refund'|'arbitration_split'`,
   `amountUsd=arb_amount`, `sessionId=intentId`, `counterparty=seller_ref`,
   `chainId`, `txHash`. + insertar/actualizar fila `a2a_arbitrations(status='executed',
   settle_usd, decision, method, llm_reasoning, evidence_digest)`.

**Testnet guard (AC-5/CD-5):** antes de cualquier movimiento, el árbitro valida
`chain_id ∈ {2368 (kite-ozone-testnet), 43113 (avalanche-fuji), 84532 (base-sepolia)}`
y rechaza mainnet (2366/43114/8453) → `CHAIN_NOT_SUPPORTED` fail-closed. (El
`session` ya se abre sólo en la default chain via MNR-1; esta es defensa en
profundidad.)

### 4.7 Recovery de `arb_closing` (herencia BLQ-2/BLQ-DR/BLQ-MED-1)

`arbiter.recoverArbClosing(intentId, ownerRef, allowStaleRecovery)` espejo de la rama
`closing` de `closeSession`: re-invoca `close_payment_intent_for_arbitration` (que
devuelve prev_status='arb_closing' + `settle_outcome` persistido + `consumed_usd`=monto
forzado); aplica `finalizePaymentIntent` idempotente con el veredicto persistido;
`settle_outcome=NULL` + `!allowStaleRecovery` → `in_progress` no-op (in-flight, no
huérfano — CD-13). `expireStale` se extiende para barrer `status='arb_closing'` con
`updated_at` viejo (mismo umbral `PAYMENT_INTENT_CLOSING_STALE_SECONDS`) y llamar
`recoverArbClosing(..., true)`.

### 4.8 Flag global OFF (AC-7, default #5)

`ARBITER_ENABLED` (env, default **`false`**). Cuando != `'true'`:
- `POST/GET /session/:id/dispute` → 404 (como si la ruta no existiera).
- `openDispute`/`executeArbitration` nunca se invocan ⇒ ningún intent entra en
  `disputed/arb_closing/arb_hold` ⇒ la guarda de `closeSession` es rama muerta ⇒
  **el money-path normal es byte-idéntico a hoy**. La migración (CHECK additive + tabla
  nueva) es inerte (no cambia el comportamiento de ninguna query existente).

### 4.9 Flujo principal (Happy Path — rules-first, dentro del cap)

1. Buyer (owner del `session` intent) `POST /session/:id/dispute` (flag ON).
2. `open_dispute` transiciona `open → disputed` (anti-race gateado).
3. `readEvidence`: deposit=10, consumed=0 (0 vouchers), expirado.
4. `rules.classify` → `R-REFUND` (consumed==0), inequívoco, sin LLM (AC-1).
5. `at_stake=10 ≤ cap=25` → ejecutar. `close_payment_intent_for_arbitration(...,0)` →
   `arb_closing`, arb_amount=0.
6. Short-circuit: `finalize('settled', residual=10)` → Buyer recupera 10, sin tx.
7. Recibo `arbitration_refund` + fila `a2a_arbitrations(executed)`. Intent `refunded`.

### 4.10 Flujos de error

1. **Ambiguo → LLM → decide (AC-2)**: proof-chain con tamper → `G-INTEGRITY` →
   `llm-classifier` → `{decision:'split', splitPct:40, reasoning}` → clamp settle=deposit·0.4
   → si ≤ cap ejecuta split; recibo `arbitration_split` con `llm_reasoning`.
2. **Ambiguo → LLM null → hold (fail-closed)**: LLM breaker abierto/timeout → `null`
   → `arb_hold`, recibo `arbitration_hold`, cero fondos.
3. **Sobre-tope → hold+flag (AC-6)**: deposit=100 > cap=25 → `arb_hold` sin ejecutar,
   aún si la decisión rules fue inequívoca.
4. **Anti-race doble-settle (AC-4)**: `closeSession` concurrente sobre un intent ya
   `disputed` → guarda → `INTENT_NOT_OPEN` (409), no settlea.
5. **Settle on-chain falla**: herencia BLQ-ALTO-1 — unequivocal → refund del deposit;
   ambiguous → RECONCILE (sin refund) + log.warn.
6. **Flag OFF (AC-7)**: `POST /session/:id/dispute` → 404.
7. **Ownership mismatch / no existe**: `OWNERSHIP_MISMATCH` (403) / `INTENT_NOT_FOUND`
   (404), disclosure-safe (`sendPaymentError`).
8. **Chain mainnet (AC-5)**: `CHAIN_NOT_SUPPORTED` (422), cero fondos.

### 4.11 Los 5 defaults conservadores — **a RATIFICAR por el user** (NO reabrir)

Diseñados como constraints; documentados como pendientes de ratificación humana, no
reabiertos por el Architect:

| # | Default | Materializado en |
|---|---------|------------------|
| 1 | **Autoridad acotada**: auto-resuelve sólo hasta `ARBITER_AUTO_CAP_USD` (default 25); sobre el tope → hold+flag, NO ejecuta. | §4.5, AC-6, DT-5, CD-7 |
| 2 | **Evidencia determinística**: SÓLO proof-chain on-chain + ledger + estado del intent. PROHIBIDO inputs off-chain de las partes en v1. | §4.4, DT-2 (heredado), CD-8 |
| 3 | **Rules-first**: reglas determinísticas para lo inequívoco; el LLM SÓLO clasifica ambigüedad, SIN autoridad de ejecución. | §4.4, AC-1/AC-2, DT-3, CD-1/CD-9 |
| 4 | **Apelación / fail-closed**: ventana de override humano (decisión reversible en v1); ambigüedad o sobre-tope → hold+flag, jamás auto-release erróneo. | §4.5/§4.7, AC-6, DT-6, CD-10 |
| 5 | **Ejecución vía primitivos existentes** (settle/refund/split del residual) + **recibo inmutable**; **flag global OFF por default** (byte-idéntico apagado). | §4.6/§4.8, AC-3/AC-7, DT-7, CD-4/CD-6/CD-11 |

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (INVIOLABLES)

- **CD-1**: PROHIBIDO que el LLM tenga la última palabra sobre movimiento de fondos.
  Toda ejecución pasa por código determinístico que invoca el seam de settle. Nunca
  una transferencia disparada desde el prompt/response del LLM.
- **CD-2**: OBLIGATORIO Ownership Guard (`owner_ref`) en TODA tabla/query/RPC nueva de
  disputas (`a2a_arbitrations`, `open_dispute`, `close_payment_intent_for_arbitration`).
- **CD-3**: PROHIBIDO modificar `WasiAIEscrow.sol` o su ABI (WKH-126 fuera de scope).
- **CD-4**: OBLIGATORIO emitir un recibo inmutable (`receiptService.emit`, WKH-124) por
  cada decisión de arbitraje (incluido `hold`), con evidencia consultada y, si hubo
  LLM, el razonamiento registrado (en `a2a_arbitrations.llm_reasoning`).
- **CD-5**: PROHIBIDO habilitar acciones de arbitraje que muevan fondos sobre chain IDs
  de mainnet (guard explícito §4.6).
- **CD-6**: PROHIBIDO duplicar sign/settle/verify — toda ejecución reusa
  `settlePaymentIntentOnChain` + `record_settle_outcome` + `finalize_payment_intent`.

### Nuevos del SDD

- **CD-7** (default #1): OBLIGATORIO gate de tope `at_stake_usd > ARBITER_AUTO_CAP_USD`
  → `arb_hold` sin ejecutar, para decisiones rules Y llm, ANTES de cualquier settle.
- **CD-8** (default #2): PROHIBIDO consumir evidencia off-chain declarada por las partes
  (texto libre, adjuntos) en v1. La evidencia es SÓLO estado del intent + ledger de
  vouchers + proof-chain de recibos.
- **CD-9** (default #3): OBLIGATORIO que `llm-classifier` NUNCA lance hacia el árbitro:
  TODA ruta de salida (API ausente, breaker, timeout, JSON inválido, shape inválido,
  splitPct fuera de rango) devuelve `null` (sentinela), nunca throw (lección WKH-136).
  El schema de respuesta está acotado a `{release,refund,split(+pct)}`.
- **CD-10** (default #4): OBLIGATORIO fail-closed: ambigüedad irresoluble (LLM `null`) o
  sobre-tope → `arb_hold`, jamás un auto-release/refund a ciegas.
- **CD-11** (default #5): OBLIGATORIO flag `ARBITER_ENABLED` default OFF; con OFF, cero
  cambio de comportamiento en el money-path existente (byte-idéntico).
- **CD-12** (WKH-135 BLQ-DR): el refund/credit del residual DEBE vivir dentro de la tx
  status-gated de `finalize_payment_intent` (reuso sin cambios). PROHIBIDO mover dinero
  fuera de esa tx.
- **CD-13** (WKH-135 BLQ-MED-1): en `arb_closing`, discriminar in-flight
  (`settle_outcome=NULL` + `!allowStaleRecovery` → `in_progress` no-op) vs huérfano
  (veredicto persistido o stale → finalize). No asumir éxito.
- **CD-14** (WKH-135 W0): en los RPCs nuevos con `RETURNS TABLE`, calificar columnas con
  alias y/o nombrar los OUT distinto de las columnas fuente (evitar "column reference is
  ambiguous"). `SECURITY DEFINER` + `SET search_path` + REVOKE/GRANT service_role.
- **CD-15** (recurrente WKH-133/134/136): con `exactOptionalPropertyTypes`, nunca `x:
  cond ? v : undefined` en objetos tipados con opcionales — usar asignación condicional.
- **CD-16** (WKH-135 W3): correr `biome check src/` sobre los archivos nuevos antes de
  cerrar cada wave; sin imports "por si acaso" (`noUnusedImports`).
- **CD-17** (MNR-1): el write-boundary de los endpoints de disputa valida el intent
  (existencia + ownership) y el árbitro valida chain testnet explícitamente
  (fail-closed) antes de mover fondos.

### PROHIBIDO (resumen)

- NO agregar dependencias nuevas (Anthropic SDK, viem, supabase ya presentes).
- NO crear un segundo seam de settle ni tocar `WasiAIEscrow.sol`/WKH-126.
- NO darle al LLM autoridad de ejecución ni ampliarle el schema más allá de los 3
  desenlaces.
- NO settlear > `authorized_usd` (el árbitro no crea plata).
- NO modificar `record_settle_outcome`/`finalize_payment_intent`/`settlePaymentIntentOnChain`.
- NO usar `any`/`as unknown` fuera de los narrowings acotados ya presentes en el patrón.
- NO tocar archivos fuera de la tabla §4.1.

---

## 6. Scope

**IN:**
- Estados `disputed`/`arb_closing`/`arb_hold` (migración reversible).
- Servicio árbitro (`arbiter.ts` + `arbiter/{evidence,rules,llm-classifier}.ts`).
- RPCs `open_dispute` + `close_payment_intent_for_arbitration`.
- Tabla `a2a_arbitrations` (owner-guarded, RLS).
- 4 `receipt_type` de arbitraje (extensión CHECK + `ReceiptType`).
- Endpoints `POST/GET /payments/session/:id/dispute` (gated por flag).
- Guarda anti-race en `closeSession` + sweep de `arb_closing` en `expireStale`.
- Chains: **testnet únicamente**.
- Tests ≥1 por AC + los 6 casos requeridos (§Test Plan).

**OUT:**
- Mainnet.
- Disputas sobre `upto` (v1 sólo `session`).
- Modificar `WasiAIEscrow.sol`/ABI (WKH-126).
- UI/dashboard de revisión o herramienta de override humano (sólo se expone el estado
  `arb_hold` + recibo/flag).
- Red multi-árbitro / votación descentralizada.
- Reuso/modificación de `fee-split.ts` (WKH-136).
- Inputs off-chain de las partes como evidencia.

---

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Doble-settle árbitro vs close normal | B | A | Gate `status='open'` compartido bajo FOR UPDATE + guarda en `closeSession` + `settle_tx_hash UNIQUE` (CD-12/CD-13). |
| Árbitro settlea > deposit (crear plata) | B | A | Clamp `[0, authorized_usd]` en el RPC de arbitraje. |
| LLM mueve fondos / decide sobre-tope | B | A | CD-1 (LLM sin ejecución) + CD-7 (cap antes de settle). |
| Refund fuera de la tx status-gated (double-refund) | B | A | Reuso sin cambios de `finalize_payment_intent` (CD-12). |
| Recovery de `arb_closing` asume éxito | B | M | Veredicto persistido + discriminador in-flight (CD-13). |
| Flag OFF cambia el money-path | B | A | Guarda inerte + migración additive; test byte-idéntico. |
| Escalación LLM demasiado frecuente/insegura | B | M | Escalación deliberadamente rara (sólo contradicción de evidencia); fail-closed a hold. |
| `receipt_type` CHECK rechaza el nuevo tipo | B | B | Extensión CHECK en la misma migración; `emit` best-effort degrada a WARN. |

## 8. Dependencias

- DONE en `main`: WKH-135 (`payment-intent.ts`/RPCs/tabla), WKH-124 (`receipt.ts`),
  WKH-53 (Ownership Guard), infra LLM (`llm/models.ts`, `anthropicCircuitBreaker`),
  chain registry (`adapters/registry.ts`).
- Migración WKH-135 aplicada (estados + RPCs base). NO depende de WKH-126.

## 9. Missing Inputs

- Los 3 `[NEEDS CLARIFICATION]` del work-item quedan **resueltos con defaults
  conservadores a RATIFICAR** (§4.11) — NO bloquean F2.5. El user puede ajustar
  `ARBITER_AUTO_CAP_USD`, la política de evidencia (mantener on-chain-only), y si el
  hold debe agregar un delay de cooling-off explícito (hoy el hold ya es la ventana de
  override). Ninguno bloquea la implementación.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno abierto) | — | Los 3 forks del work-item tienen default conservador documentado y ratificable. | No |
| [RATIFY] | §4.11 | Los 5 defaults conservadores esperan ratificación humana en el gate SPEC_APPROVED — no son ambigüedad técnica. | No (gate humano) |

> Gate: 0 `[NEEDS CLARIFICATION]`. El humano ratifica los 5 defaults al aprobar el SDD.

---

## Readiness Check

```
[x] Cada AC (1–7) tiene al menos 1 archivo asociado en tabla §4.1
[x] Cada archivo en §4.1 tiene un Exemplar válido (verificado con Read/Glob)
[x] No hay [NEEDS CLARIFICATION] pendientes (3 forks → defaults conservadores §4.11)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-1..CD-17 + resumen §5)
[x] Context Map tiene >2 archivos leídos (11 leídos, §3)
[x] Scope IN y OUT explícitos y no ambiguos (§6)
[x] BD: tablas verificadas — a2a_payment_intents / a2a_payment_vouchers / a2a_receipts
    existen (migraciones leídas); a2a_arbitrations es nueva (declarada)
[x] Flujo principal (Happy Path) completo (§4.9)
[x] Flujo de error definido (8 casos, §4.10)
[x] Anti-race, exactly-once, fail-closed, ownership, montos micro-USD, testnet: cubiertos
[x] Auto-Blindaje histórico incorporado (CD-12..CD-17)
```

---

## Plan de Implementación (Waves)

### Wave 0 (Serial Gate — contratos, tipos, DB)
- [ ] W0.1: Migración `20260704100000_wkh139_arbiter.sql` (+ `_down`): extender status
  CHECK (+3), tabla `a2a_arbitrations` + RLS, RPC `open_dispute`, RPC
  `close_payment_intent_for_arbitration` (clamp + persistir monto), extender
  `receipt_type` CHECK (+4). Verificar en Postgres efímero. → Exemplar: migración WKH-135.
- [ ] W0.2: `src/types/arbiter.ts` (tipos) + extender `ReceiptType` en
  `src/types/receipt.ts` + `database.types.ts` (tabla + 2 RPCs). `tsc` limpio.

### Wave 1 (Parallelizable — módulos independientes)
- [ ] W1.1: `arbiter/evidence.ts` (lector on-chain/DB, owner-guarded) → Exemplar `receipt.ts`.
- [ ] W1.2: `arbiter/rules.ts` (motor determinístico puro + criterios de ambigüedad).
- [ ] W1.3: `arbiter/llm-classifier.ts` (LLM acotado nunca-throw) → Exemplar `input-retry.ts`.

### Wave 2 (Integración — depende de W0+W1)
- [ ] W2.1: `arbiter.ts` (`openDispute`/`executeArbitration`/`recoverArbClosing`):
  gate → evidencia → rules→llm→cap → seam de settle → finalize → recibo + fila
  `a2a_arbitrations`. → Exemplar `closeSession`.
- [ ] W2.2: `payment-intent.ts`: guarda anti-race en `closeSession` (rechaza estados de
  disputa) + sweep `arb_closing` en `expireStale`.

### Wave 3 (Rutas + flag)
- [ ] W3.1: `payments.ts`: `POST/GET /session/:id/dispute` gated por `ARBITER_ENABLED`
  (404 si off), write-boundary, `sendPaymentError`. → Exemplar `/session/:id/close`.

### Wave 4 (Tests + verificación)
- [ ] W4.1: `arbiter/rules.test.ts` + `arbiter.test.ts` (todos los ACs + 6 casos).
- [ ] W4.2: `npm test` + `tsc --noEmit` + `biome check src/` limpios (CD-16).

### Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | migración aplica/reversa en Postgres efímero; `tsc` |
| W1 | `tsc` + tests unit de rules |
| W2 | `tsc` + tests integración money-path |
| W3 | `tsc` + tests de ruta (flag on/off) |
| W4 | full QA: `npm test` + `tsc` + `biome` |

## Test Plan (≥1 por AC + casos obligatorios)

| Test | AC / caso | Wave | Framework |
|------|-----------|------|-----------|
| rules: consumed==0 → refund sin LLM | AC-1 (rules-first inequívoco) | W1/W4 | vitest |
| rules: consumed>=deposit → release; 0<consumed<deposit → split | AC-1 | W1/W4 | vitest |
| rules: tamper/ledger-mismatch/empty-ledger → ambiguous | AC-2 (trigger) | W1/W4 | vitest |
| árbitro: ambiguo → llm-classifier → decisión acotada, ejecuta, recibo con reasoning | AC-2/AC-3 | W4 | vitest |
| árbitro: llm devuelve null (breaker/timeout) → arb_hold, cero fondos | AC-2/AC-6 (fail-closed) | W4 | vitest |
| árbitro: at_stake > cap → arb_hold + recibo arbitration_hold, NO settle | AC-6 (sobre-tope→flag) | W4 | vitest |
| anti-race: closeSession sobre intent disputed → INTENT_NOT_OPEN (409), no settlea | AC-4 (doble-settle) | W4 | vitest |
| exactly-once: arb_closing recovery re-invocada → refund/settle 1 sola vez | AC-3/AC-4 | W4 | vitest |
| settle forzado on-chain falla unequivocal → refund deposit; ambiguous → RECONCILE | AC-3 (fail-closed) | W4 | vitest |
| release=deposit / split=partial / refund=0 mapean a settle+residual correctos | AC-3 | W4 | vitest |
| chain mainnet → CHAIN_NOT_SUPPORTED, cero fondos | AC-5 | W4 | vitest |
| flag OFF: POST /dispute → 404 + closeSession byte-idéntico (guarda inerte) | AC-7 (byte-idéntico) | W4 | vitest |
| ownership: dispute sobre intent de otro owner → OWNERSHIP_MISMATCH (403) | CD-2 | W4 | vitest |

## Estimación

- Archivos nuevos: 6 (1 migración +down, `types/arbiter.ts`, 4 módulos arbiter, 2 tests).
- Archivos modificados: 4 (`payment-intent.ts`, `payments.ts`, `types/receipt.ts`,
  `database.types.ts`).
- Tests nuevos: ~13 casos (≥1/AC + 6 obligatorios).
- Líneas estimadas: ~900 (migración ~300 SQL, servicio ~300, módulos ~200, tests ~250+).

---

*SDD generado por NexusAgil — FULL. Money-path QUALITY.*
