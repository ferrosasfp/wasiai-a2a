# SDD #138: [WKH-136] Splits atómicos al settlement (bps: plataforma / creador / referral)

> SPEC_APPROVED: no
> Fecha: 2026-07-03
> Tipo: feature (money-path)
> SDD_MODE: full (QUALITY)
> Branch: feat/138-wkh-136-atomic-splits-bps
> Artefactos: doc/sdd/138-wkh-136-atomic-splits-bps/
> Depende (lógico, SERIAL): SDD #137 (WKH-135 intents) — seam SP-1/SP-2 §4.9 de ese SDD.

---

## 1. Resumen

Se generaliza el **protocol fee único** (1% cost-based, WKH-132; cobrado hoy a UNA
sola wallet `WASIAI_PROTOCOL_FEE_WALLET` vía `chargeProtocolFee()`) en **N splits
configurables en basis points (bps)** ruteados a múltiples recipients
(**plataforma / creador / referral**) en el momento del settlement.

**Invariante de producto (RATIFICADO, no se cambia):** los splits **SUBDIVIDEN el
fee actual** — el costo total al caller **NO cambia** (CD-5 / AC-5, invariante
WKH-132: `protocolFeeUsdc == totalCostUsdc × feeRate`). La plataforma pasa a ser
**uno de los N splits**. Con la config por defecto (`10000/0/0`) el comportamiento
es **byte-idéntico al de hoy** (100% del fee a la plataforma) → opt-in, cero
regresión.

**Decisión de arquitectura central:** los dos call-sites del fee
(`routes/compose.ts:574` y `services/orchestrate.ts:1065`) **ya comparten un único
punto de entrada**: `chargeProtocolFee()` (`fee-charge.ts:163`). WKH-136 **NO toca
los call-sites**: reescribe el **interior** de `chargeProtocolFee` para que, en vez
de un `sign()+settle()` a una wallet, ejecute **N legs idempotentes** vía un módulo
hermano `fee-split.ts`, cada leg reusando **exactamente** el mismo primitivo
(`getPaymentAdapter().sign()/.settle()` + `verifyDefaultChainSettle`). Un solo punto
de cálculo ⇒ **cero divergencia** entre `/orchestrate` y `/compose` (riesgo
doble-cobro/divergencia neutralizado por construcción).

**Atomicidad (definición operacional, §4.6):** *contable all-or-nothing a nivel
aplicación* — el **plan** de splits se valida `Σbps == 10000` fail-CLOSED **antes**
de cualquier transfer; cada leg es idempotente y con status propio
(`charged/failed/skipped`); el agregado **NUNCA** se reporta `charged` si algún leg
obligatorio falló (AC-3); dust redondeado se absorbe determinísticamente. La
**atomicidad on-chain multi-output** (una tx con N outputs) queda **OUT** — requiere
el escrow `debitBatch` (WKH-126a), documentado como upgrade futuro.

Reutiliza: `getPaymentAdapter().sign()/.settle()`, `verifyDefaultChainSettle`,
`feeUsdcToWei`, el patrón de idempotencia DB de `a2a_protocol_fees`, el patrón
micro-USD entero de `delegation.ts` (`decimalStringToMicroUsd`), el Ownership Guard
`owner_ref` (`CLAUDE.md`), y el patrón de reverse compensatorio de
`refund_with_dest_policy` (WKH-129).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 138 (Jira WKH-136 del roadmap OKX Wave 1) |
| **Tipo** | feature (money-path) |
| **SDD_MODE** | full |
| **Objetivo** | Subdividir el protocol fee en N splits (bps) ruteados a plataforma/creador/referral en el settle, con `Σbps==10000` fail-closed, dust sin fuga, idempotencia por-recipient, Ownership Guard, y cero cambio del total cobrado al caller (WKH-132). |
| **Scope IN** | `fee-charge.ts` (reescritura interna), `fee-split.ts` (nuevo), config env de bps, tabla nueva `a2a_fee_splits` + RPCs, columnas net-new de resolución de creator/referral, tests money-path. |
| **Scope OUT** | Tocar el pago directo agente↔caller (`agent.payTo` service payment), escrow `debitBatch` on-chain multi-output, UI de config de splits (vive en wasiai-v2), KYC de recipients, wiring de SP-1/SP-2 de WKH-135 (seam-compatible pero diferido hasta merge). |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** — WHEN se dispara un settlement de protocol fee (`/orchestrate/execute` o
  `/compose`), THE system SHALL dividir el monto del fee en 1..N recipients según
  una config de bps cuya suma SHALL ser exactamente **10000** antes de aplicar
  cualquier split.
- **AC-2** — IF los bps no suman exactamente 10000, THEN THE system SHALL **rechazar
  el cálculo** (fail-CLOSED, cero cobro parcial) con un error explícito
  (`SplitConfigError`, mismo espíritu que `ProtocolFeeError` `fee-charge.ts:173-177`).
- **AC-3** — WHEN un settlement con splits se ejecuta y ≥1 transfer falla mientras
  otras tienen éxito, THE system SHALL registrar el status **por-recipient**
  (`charged`/`failed`/`skipped`) y NUNCA reportar `charged` agregado si un recipient
  obligatorio falló.
- **AC-4** — WHILE un step/orchestration con splits aplicados es reembolsado
  (credit-back WKH-127/129), THE system SHALL revertir (a nivel ledger contable)
  **TODOS** los splits asociados — no solo el share de plataforma. (Ver §4.7:
  matiz on-chain honesto + gating post-success.)
- **AC-5** — WHEN `/orchestrate/plan` (o el quote de compose) reporta el fee, THE
  system SHALL mantener el contrato de transparencia WKH-132/133 (`protocolFeeUsdc`
  / `feeRatePercent`): el total cobrado al caller es el MISMO número, con o sin
  desglose de splits.
- **AC-6** — IF un recipient resuelve a una wallet inválida/ausente, THEN THE system
  SHALL saltear (skip) ese recipient (log estructurado, sin crashear) y **re-enrutar
  su bps a la plataforma** (§SG-6 ratificado abajo).

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos (todos verificados con Read)

| Archivo | Por qué | Patrón / hecho extraído |
|---------|---------|-------------------------|
| `src/services/fee-charge.ts` | **Punto de entrada único** a reescribir | `chargeProtocolFee({orchestrationId,feeBaseUsdc,feeRate})` → `feeUsdc=round(base×rate,6)` (L169); guard fail-CLOSED `feeUsdc>feeBaseUsdc → ProtocolFeeError` (L173-177); wallet vacía → `skipped/WALLET_UNSET` (L180-184); idempotencia por `a2a_protocol_fees.orchestration_id` INSERT pending→23505 (L227-243); `sign()`+`settle()` (L257-286); `verifyDefaultChainSettle` ANTES de `charged` (L293-315); `feeUsdcToWei` = `BigInt(Math.round(usdc*1e6))*BigInt(1e12)` (L133-135); CD-B nunca rechaza la promise (L346-353); `markFailed` best-effort (L359-375) |
| `src/routes/compose.ts` (L565-620) | Call-site #1 del fee (WKH-118) | `chargeProtocolFee({orchestrationId: request.id, feeBaseUsdc: result.totalCostUsdc, feeRate: getProtocolFeeRate()})` (L574-578); best-effort, NUNCA rompe el 200; ningún campo de fee se serializa en el response |
| `src/services/orchestrate.ts` (L1051-1130) | Call-site #2 del fee (WKH-132) | `chargeProtocolFee({orchestrationId, feeBaseUsdc: pipeline.totalCostUsdc, feeRate})` **gateado por `pipeline.success`** (L1064-1069); credit-back `refund_with_dest_policy` SOLO si `!pipeline.success` (L1114-1129) ⇒ **fee y refund son mutuamente excluyentes** (clave para AC-4, §4.7) |
| `src/routes/orchestrate.ts` (L220-248, L380-411) | Transparencia del quote (WKH-132/133) | `feeRatePercent = getProtocolFeeRate()*100` (L233); `protocolFeeUsdc = round(totalCostUsdc*rate,6)` (L248); el total al caller se deriva de la MISMA fuente → no debe cambiar (CD-5) |
| `supabase/migrations/20260421015829_a2a_protocol_fees.sql` | Esquema actual del fee | `orchestration_id UUID PRIMARY KEY` (única) + **una sola** `fee_wallet TEXT NOT NULL` → **incompatible tal cual con N-recipient**; `CHECK status IN (pending,charged,failed,skipped)`; trigger `trigger_set_updated_at` |
| `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy.sql` | Patrón de reverse compensatorio | `FOR UPDATE` + Ownership Guard bajo lock (`OWNERSHIP_MISMATCH`, L38-40); no-op defensivo si `amount<=0` (L44-46); fila compensatoria **NEGATIVA** en ledger (L79-80); hardening `SECURITY DEFINER`+`SET search_path`+`REVOKE/GRANT service_role` (L85-91) |
| `supabase/migrations/20260703000000_wkh134_a2a_agents.sql` | Origen del "creador" self-published | `slug PK`, `metadata JSONB`, `owner_ref NOT NULL`, `price_usdc`; **NO existe** columna `payTo`/payout → creador self-published = net-new (§4.4) |
| `src/services/agent.ts` (L151-166, L279-290) | `buildMetadata` de publish | Sólo persiste `inputSchema/outputSchema/discoverable` → **confirmado: publish NO captura payTo ni referrer hoy** (net-new); `owner_ref = request.a2aKeyRow.owner_ref` (L235) |
| `src/services/compose.ts` (L788-813) | Resolución del payTo del agente de registry | `agent.metadata.payTo` (kite) `|| agent.metadata.payment.contract` (wasiai-v2); es el **pago directo por el servicio** (Scope OUT como money-path), reusable SOLO como fuente de address del creador |
| `src/adapters/settle-verifier.ts` (vía SDD #137 §3) | Re-verify on-chain por leg | `verifyDefaultChainSettle({txHash,payTo,requiredAmountAtomic})→{ok,reason,warn}`; fail-OPEN en `RPC_UNAVAILABLE`, fail-CLOSED en contradicción; kill-switch `SETTLE_VERIFY_ONCHAIN` |
| `src/lib/price.ts` (L7,L49) + `src/services/llm/models.ts` (L12) | Patrón env-backed sin cache | `getProtocolFeeRate()`-style: re-lee `process.env` por request, guard/fallback, sin cache → modelo para `getSplitConfig()` |
| `doc/sdd/137-.../sdd.md` §4.9 | Seam SP-1/SP-2 | `settlePaymentIntentOnChain({intentId,ownerRef,payTo,finalAmountUsd,chainId})` — punto donde WKH-136 (futuro) interceptaría `payTo+finalAmountUsd` para N-recipients. **WKH-135 aún NO mergeado** → v1 no lo cablea (§SG-4) |
| `.env.example` (L481-490) | Env actual del fee | `WASIAI_PROTOCOL_FEE_WALLET=` (vacío por default), `PROTOCOL_FEE_RATE=0.01` → se agregan `SPLIT_BPS_*` con default backward-compatible |

### Auto-Blindaje histórico incorporado (últimas HUs DONE)

Leídos: `133-wkh-132-fee-transparency/auto-blindaje.md`,
`134-wkh-133-reputation-writeback/auto-blindaje.md`,
`135-wkh-134-agent-selfserve-publish/auto-blindaje.md`. Patrones recurrentes (≥2 HUs)
convertidos en CD (§5): validación money-path write+read boundary (WKH-134 BLQ-1 +
WKH-142), `exactOptionalPropertyTypes` (WKH-134 #1 + WKH-133 #1), `.upsert(...,
{onConflict,ignoreDuplicates})` NO `.insert().onConflict()` (WKH-133 #2),
`BigInt()`/on-chain read en try/catch (WKH-133 #3/#4), no confundir el techo/agregado
reportado con la magnitud real cost-based (WKH-132 BLQ-MED-1 — directamente aplicable
a "no romper `protocolFeeUsdc`" al desglosar en splits), correr `biome check` sobre
archivos tocados.

### Estado de BD relevante

| Tabla / columna | Existe | Notas |
|-----------------|--------|-------|
| `a2a_protocol_fees` | Sí | Se **conserva** como fila-agregado (parent). NO se rompe su PK ni su idempotencia (WKH-132/44). |
| `a2a_fee_splits` | **No** | Se **crea** (§4.2), child por-recipient con `UNIQUE(orchestration_id, recipient_role)`. |
| `a2a_agents.payout_wallet` | **No** | Columna net-new opcional (creador self-published, §4.4). |
| `a2a_agents.referrer_ref` | **No** | Columna net-new opcional (mecanismo de referral, §SG-2). |
| `registries` agents `metadata.payTo` | Sí | Fuente de address del creador para agentes de marketplace. |
| `WASIAI_PROTOCOL_FEE_WALLET` (env) | Sí | Wallet de la plataforma = **ancla garantizada** para dust y fallback (AC-6). |

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260705000000_wkh136_fee_splits.sql` | Crear | Tabla `a2a_fee_splits` + columnas net-new `a2a_agents.payout_wallet`/`referrer_ref` + RLS + hardening + trigger updated_at | `20260421015829_a2a_protocol_fees.sql`, `20260703000000_wkh134_a2a_agents.sql` |
| `supabase/migrations/20260705000000_wkh136_fee_splits_down.sql` | Crear | DROP reversible (tabla + columnas) | `..._down.sql` de WKH-135/134 |
| `src/services/fee-split.ts` | Crear | Cálculo de splits (micro-USD entero, dust→plataforma), resolución de recipients server-side, `settleFeeSplits` (N legs idempotentes), `reverseFeeSplits` | `fee-charge.ts`, `delegation.ts` (micro-USD), `refund_with_dest_policy` |
| `src/services/fee-split.test.ts` | Crear | Tests money-path (≥1/AC + Σbps, dust, refund N-way) | `fee-charge.test.ts` |
| `src/services/fee-charge.ts` | **Modificar** | Reescritura interna: `chargeProtocolFee` delega a `fee-split.ts` (firma pública INTACTA). `FeeChargeResult` extiende con `splits?: SplitLeg[]` | (self) |
| `src/config/split-config.ts` (o `src/lib/split-config.ts`) | Crear | `getSplitConfig()` env-backed sin cache: `SPLIT_BPS_PLATFORM/CREATOR/REFERRAL`, valida `Σ==10000` fail-CLOSED | `lib/price.ts`, `getProtocolFeeRate` |
| `src/types/index.ts` | Modificar | `SplitLeg`, `SplitConfig`, `SplitRecipientRole`, `FeeSplitRow` | tipos existentes |
| `src/types/database.types.ts` | Modificar | Row de `a2a_fee_splits` + columnas nuevas de `a2a_agents` + Args de RPCs | rows/RPC existentes |
| `.env.example` | Modificar | Documentar `SPLIT_BPS_*` (default `10000/0/0`) | L481-490 |

**Cero** modificaciones a los call-sites (`routes/compose.ts`, `services/orchestrate.ts`,
`routes/orchestrate.ts`). La firma pública de `chargeProtocolFee` NO cambia → los dos
call-sites heredan splits sin editarse (clave anti-divergencia).

### 4.2 Modelo de datos

**`a2a_protocol_fees` (existente) — se CONSERVA como fila-agregado (parent).** Sigue
siendo la clave de idempotencia del settlement completo (`orchestration_id` único) y
preserva `fee_usdc` = total del fee (WKH-132). `fee_wallet` queda como address de la
plataforma (compat). Ningún ALTER destructivo.

**Tabla nueva `a2a_fee_splits` — una fila por recipient por settlement (child).**

```
a2a_fee_splits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orchestration_id UUID NOT NULL,                    -- FK lógica al parent (settlement)
  recipient_role   TEXT NOT NULL
                   CHECK (recipient_role IN ('platform','creator','referral')),
  recipient_wallet TEXT NOT NULL,                    -- resuelta server-side (nunca del caller, CD-6)
  owner_ref        TEXT NOT NULL,                    -- Ownership Guard (CLAUDE.md) — del caller que paga el fee
  bps              INT  NOT NULL CHECK (bps >= 0 AND bps <= 10000),
  amount_usdc      NUMERIC(18,6) NOT NULL CHECK (amount_usdc >= 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','charged','failed','skipped','reversed')),
  tx_hash          TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (orchestration_id, recipient_role)          -- CD-2: idempotencia POR recipient
);
CREATE INDEX idx_a2a_fee_splits_orch  ON a2a_fee_splits (orchestration_id);
CREATE INDEX idx_a2a_fee_splits_owner ON a2a_fee_splits (owner_ref);
CREATE INDEX idx_a2a_fee_splits_status ON a2a_fee_splits (status);
-- trigger updated_at (reusa trigger_set_updated_at, patrón a2a_protocol_fees:30-34)
```

**Columnas net-new en `a2a_agents` (opcionales, nullable, backward-compatible):**

```
ALTER TABLE public.a2a_agents
  ADD COLUMN IF NOT EXISTS payout_wallet TEXT,   -- creador self-published (§4.4)
  ADD COLUMN IF NOT EXISTS referrer_ref  TEXT;   -- referral (§SG-2), owner_ref del referrer
```

**RLS:** `a2a_fee_splits` → `ENABLE ROW LEVEL SECURITY` deny-by-default (patrón
WKH-SEC-02c / `a2a_agents:44`). El cliente usa `SUPABASE_SERVICE_KEY` (BYPASSRLS) →
guard real = app-layer `.eq('owner_ref', ...)` (CLAUDE.md).

**Idempotencia (elección):** se replica el patrón `fee-charge.ts` **por leg**: INSERT
`pending` con `UNIQUE(orchestration_id, recipient_role)` → 23505 = leg ya en curso
(no re-cobra). El settle de cada leg re-verifica on-chain antes de marcar `charged`.
Alternativa considerada y descartada: RPC atómico multi-leg estilo `debit_session_and_parent`
— innecesario porque los transfers son secuenciales best-effort (no requieren una tx DB
única); el patrón `a2a_protocol_fees` (INSERT pending → settle → UPDATE) ya es el canon
del money-path para transfers on-chain. Se documenta como `[VERIFY-AT-IMPL R-2]`.

### 4.3 Config de bps — `getSplitConfig()` (env-backed, sin cache)

Espejo exacto de `getProtocolFeeRate()` (`fee-charge.ts:100`): re-lee `process.env` por
request, con guard fail-CLOSED.

```
getSplitConfig(): SplitConfig
  lee SPLIT_BPS_PLATFORM (default 10000), SPLIT_BPS_CREATOR (default 0),
      SPLIT_BPS_REFERRAL (default 0)
  cada valor: Number.parseInt, Number.isInteger, [0, 10000]  (CD-E-style, no NaN/Inf)
  Σ debe ser EXACTAMENTE 10000 → si no: THROW SplitConfigError (fail-CLOSED, AC-2/CD-1)
  default (10000/0/0) ⇒ Σ=10000 ⇒ 100% plataforma ⇒ comportamiento idéntico a hoy
```

**Justificación de "global env" (SG-1):** es la ÚNICA opción que (a) respeta CD-6
(recipients NUNCA derivados de input no-autenticado del caller — un `referralWallet`
libre en el body permitiría a un caller malicioso redirigir el cut de plataforma a su
wallet = robo de revenue de plataforma), (b) reusa el patrón ya auditado de
`PROTOCOL_FEE_RATE`, (c) tiene default backward-compatible (`10000/0/0` = 0 regresión).
Per-agente y per-request quedan como evolución futura (per-agente exige config surface
administrada + validación; per-request está esencialmente prohibido por CD-6).

### 4.4 Resolución de recipients (server-side, CD-6)

| Role | Wallet (fuente, server-side) | owner_ref | Si ausente/inválida (AC-6) |
|------|------------------------------|-----------|-----------------------------|
| `platform` | `WASIAI_PROTOCOL_FEE_WALLET` (env) | `'platform'` (sistema) | Wallet vacía → skip **TODO** el fee (comportamiento actual `WALLET_UNSET`, `fee-charge.ts:180-184`) |
| `creator` | agente **primario** (step[0] en orchestrate; el agente en compose): registry → `agent.metadata.payTo`; self-published → `a2a_agents.payout_wallet` | `owner_ref` del agente | Re-enruta su bps a **platform** (§SG-6); fila `skipped` |
| `referral` | `a2a_agents.referrer_ref` → wallet resuelta del referrer (§SG-2) | `referrer_ref` | Re-enruta su bps a **platform**; fila `skipped` |

**Agente primario (SG-5):** en un pipeline multi-step, "creador" es ambiguo. v1 =
owner/payTo del agente **step[0]** (orchestrate) o del agente único (compose).
Atribución proporcional multi-agente = futuro. La resolución NUNCA usa datos del body
del caller (CD-6): sale de `a2a_agents`/`registries`/env, autenticado server-side.

### 4.5 Cálculo de splits — micro-USD entero + dust determinístico (CD-6)

Entrada: `feeUsdc` (ya calculado por `chargeProtocolFee`, `feeBaseUsdc×feeRate`),
`config = getSplitConfig()` (validado `Σ==10000`).

```
totalMicro = Math.round(feeUsdc * 1e6)              // micro-USD entero (evita float64, CD-6)
for role in [platform, creator, referral]:
    legMicro[role] = Math.floor(totalMicro * bps[role] / 10000)   // truncado
dust = totalMicro - Σ legMicro[*]                    // >= 0 por floor; residuo del redondeo
legMicro[platform] += dust                           // §SG-6: plataforma absorbe el dust
// invariante GARANTIZADO: Σ legMicro[*] === totalMicro  ⇒ ni se pierde ni se crea USD
amountUsdc[role] = legMicro[role] / 1e6
```

**Justificación dust→plataforma:** determinístico, la plataforma era el 100% antes de
los splits (mínima sorpresa), garantiza `Σ legs == fee` exacto (AC-5 / CD-5 intacto).
Nunca se trunca-y-se-pierde ni se crea USD. Legs con `bps==0` (default creator/referral)
producen `amount==0` → se **saltan** (no se hace un transfer de 0). Legs con `bps>0` pero
`amount==0` por fee minúsculo → se saltan igual (`skipped`, sin transfer nulo).

### 4.6 Flujo principal — `settleFeeSplits` (dentro de `chargeProtocolFee`)

```
chargeProtocolFee({orchestrationId, feeBaseUsdc, feeRate}):
  feeUsdc = round(feeBaseUsdc * feeRate, 6)                         // SIN CAMBIO (L169)
  if feeUsdc > feeBaseUsdc: throw ProtocolFeeError                  // SIN CAMBIO (L173-177)
  config = getSplitConfig()                                        // AC-1: valida Σ==10000 (throw SplitConfigError, AC-2/CD-1)
  platformWallet = WASIAI_PROTOCOL_FEE_WALLET
  if !platformWallet: return {status:'skipped', reason:'WALLET_UNSET'}  // SIN CAMBIO (L180-184)
  legs = computeSplits(feeUsdc, config)                            // §4.5, dust→platform
  legs = resolveRecipients(legs, orchestrationId ctx)             // §4.4; inválido → bps a platform (AC-6)
  // idempotencia + parent
  upsert a2a_protocol_fees(orchestration_id, fee_usdc=feeUsdc, ...) pending   // patrón actual
  for leg in legs where amount > 0:                               // SECUENCIAL, best-effort
    INSERT a2a_fee_splits(orch, role, wallet, owner_ref, bps, amount, 'pending')  // 23505 ⇒ leg ya en curso, skip
    signResult = getPaymentAdapter().sign({to: leg.wallet, value: feeUsdcToWei(leg.amount)})   // CD-3
    settleResult = getPaymentAdapter().settle({...})
    verify = verifyDefaultChainSettle({txHash, payTo: leg.wallet, requiredAmountAtomic: BigInt(wei)})  // CD-5
    if !verify.ok (contradicción definitiva): UPDATE leg 'failed'          // AC-3
    else: UPDATE leg 'charged' + tx_hash
  aggregate:
    if TODOS los legs con amount>0 quedaron 'charged'/'skipped(orphan-rerouted)': parent 'charged'
    else (algún leg 'failed'): parent 'failed'  (AC-3 — nunca 'charged' agregado con un leg fallido)
  return {status, feeUsdc, splits: legs}                           // FeeChargeResult extendido
```

**Reglas money-path (heredan de `fee-charge.ts`):**
- CD-B: `chargeProtocolFee` **NUNCA** rechaza la promise; todo error → status en el
  shape (`failed`) + `markFailed` best-effort por leg y por parent.
- Cada leg reusa **exactamente** `feeUsdcToWei` + `sign()`+`settle()` +
  `verifyDefaultChainSettle` (CD-3 / DT-1 del work-item). PROHIBIDO un primitivo paralelo.
- `verifyDefaultChainSettle` ANTES de `charged` por leg; `RPC_UNAVAILABLE` → fail-OPEN +
  warn (`fee-charge.ts:300`), contradicción → `failed`.
- Montos en micro-USD entero (§4.5); nunca `parseFloat` lossy.

### 4.7 Refund / reverse de splits (AC-4 / CD-4) — matiz honesto

**Hecho de grounding (crítico, para el AR):** en `orchestrate.ts` el fee se cobra
**SOLO si `pipeline.success`** (L1064) y el credit-back ocurre **SOLO si
`!pipeline.success`** (L1114-1121) → **mutuamente excluyentes**. En `compose.ts` el fee
se cobra sobre `result.totalCostUsdc` **después** de que los refunds per-step internos ya
ocurrieron. ⇒ En el path SP-0 **el fee (y sus splits) NUNCA se cobra en un escenario que
luego se reembolsa**. AC-4 se satisface **estructuralmente** por el gating post-success.

**Límite honesto on-chain:** los legs del fee son **transfers on-chain a wallets
externas** (plataforma/creador/referral), NO débitos del budget prepago del caller. Un
transfer on-chain a una wallet externa **no se puede clawback** por RPC (a diferencia del
credit-back WKH-127/129 que revierte el ledger de budget del caller). Por eso "revertir
todos los splits" en el sentido de mover fondos de vuelta **no es físicamente posible**
para legs on-chain a externos.

**Mecanismo provisto (`reverseFeeSplits(orchestrationId, ownerRef)`):** para completar
CD-4/AC-4 como **capacidad** (y future-proof del seam SP-1/SP-2 de WKH-135, donde un
settle puede preceder a un refund por expiry), se implementa una reversión **a nivel
ledger contable**: `FOR UPDATE` sobre las filas del settlement, marca **TODOS** los legs
`charged` → `reversed` + emite una fila/recibo compensatorio (patrón
`refund_with_dest_policy` fila NEGATIVA, WKH-129) + Ownership Guard `owner_ref` bajo lock.
Itera sobre **todos** los recipients (no solo el primero) — el AR verifica esto citando
archivo:línea (CD-4). **En v1 NO se cablea a orchestrate/compose** (fee post-success → no
hay refund del fee ahí); se expone como API + test de la capacidad, lista para SP-1/SP-2.

**Ratificación requerida (SG-7):** ¿es aceptable que en v1 el reverse sea ledger-only
(auditable) + gating estructural, dado que el clawback on-chain de transfers a externos es
imposible sin escrow? La alternativa (splits vía escrow `debitBatch` con hold/release
reversible) es WKH-126a, fuera de scope.

### 4.8 Flujo de error / edge cases

| Caso | Resolución |
|------|-----------|
| `Σbps != 10000` | `getSplitConfig()` THROW `SplitConfigError` **antes** de todo transfer (AC-2/CD-1). Cero cobro parcial. |
| Retry del mismo `orchestrationId` | Parent `a2a_protocol_fees` ya `charged` → `already-charged` (SIN CAMBIO). Por leg: `UNIQUE(orch,role)` 23505 → leg no re-cobra. |
| Leg falla, otros OK | Leg → `failed`; parent → `failed` (AC-3). NUNCA `charged` agregado con un leg fallido. Legs OK quedan `charged` (observable por-recipient). |
| Recipient wallet inválida/ausente (AC-6) | Su bps se re-enruta a `platform` en `resolveRecipients` (bps sumado al leg platform ANTES de computeSplits final); fila del recipient huérfano = `skipped` + log estructurado. Sin abort, sin USD perdido. |
| `WASIAI_PROTOCOL_FEE_WALLET` vacía | Skip TODO el fee (`WALLET_UNSET`, comportamiento actual). La plataforma es el ancla; sin ella no hay dónde anclar dust/fallback. |
| Dust del redondeo | Absorbido por `platform` (§4.5). `Σ legs == fee` exacto garantizado. |
| `settle()` OK pero on-chain contradice (por leg) | `verifyDefaultChainSettle` fail-CLOSED → leg `failed`, no `charged` (CD-5). |
| RPC on-chain no disponible (por leg) | fail-OPEN + warn (facilitator ya confirmó), `fee-charge.ts:300`. |
| `feeUsdc` minúsculo → algún `legMicro==0` | Leg con `amount==0` se salta (no transfer nulo); su (0) no afecta el total. |
| Ownership mismatch en reverse | RPC `OWNERSHIP_MISMATCH` bajo lock → mapeo por prefijo, nunca msg crudo PG (CD-2, patrón WKH-129). |
| Config default `10000/0/0` | 1 solo leg (platform) con amount=fee → **byte-idéntico** al cobro actual (cero regresión). |

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO

- **CD-1** (heredado work-item CD-1 / AC-2): `getSplitConfig()` valida `Σbps == 10000`
  **fail-CLOSED** (`SplitConfigError`, statusCode 400 como `ProtocolFeeError`) **antes**
  de cualquier transfer. PROHIBIDO cualquier cobro parcial de una config inválida.
- **CD-2** (heredado work-item CD-2): idempotencia **por recipient** vía
  `UNIQUE(orchestration_id, recipient_role)`. PROHIBIDO reusar la PK única de
  `a2a_protocol_fees` para >1 recipient. Ownership Guard `owner_ref` en la tabla + en
  toda query/RPC nuevo (`.eq('owner_ref', ...)`, CLAUDE.md). Un leg/reverse sin owner
  guard → BLOQUEANTE (IDOR) para el AR.
- **CD-3** (heredado work-item CD-3): cada leg reusa **exactamente**
  `getPaymentAdapter().sign()/.settle()` + `feeUsdcToWei` (`fee-charge.ts:133-135`) +
  `verifyDefaultChainSettle`. PROHIBIDO un mecanismo de transferencia paralelo.
- **CD-4** (heredado work-item CD-4): `reverseFeeSplits` itera sobre **TODOS** los legs
  `charged` (no solo el primero). AR verifica citando archivo:línea.
- **CD-5** (heredado work-item CD-5 / AC-5): NO romper `protocolFeeUsdc == totalCostUsdc ×
  feeRate` (WKH-132/133). `Σ amount_usdc de los legs == feeUsdc` exacto. El total al
  caller NO cambia. (Auto-Blindaje WKH-132 BLQ-MED-1: no confundir el agregado reportado
  con la magnitud real.)
- **CD-6** (heredado work-item CD-6): recipients resueltos **SOLO server-side**
  (env/`a2a_agents`/`registries`), NUNCA de input no-autenticado del caller. PROHIBIDO
  un `referralWallet`/`splits` libre en el body de `/orchestrate` o `/compose`.
- **CD-7** (Auto-Blindaje WKH-134 BLQ-1 + WKH-142, recurrente ≥2 — money-path): validar
  TODO bps/monto en el **write-boundary** (rechazo explícito si no es entero finito en
  `[0,10000]` / `number >= 0`) Y clampear/`CHECK` en DB (read-boundary). Ref: WKH-134
  auto-blindaje#3.
- **CD-8** (Auto-Blindaje WKH-134 #1 + WKH-133 #1, recurrente ≥2): con
  `exactOptionalPropertyTypes:true`, construir objetos tipados (`SplitLeg`,
  `FeeChargeResult` extendido) con **asignación condicional** (`if (x!==undefined)
  obj.x=x`), NUNCA `x: cond ? v : undefined`.
- **CD-9** (Auto-Blindaje WKH-133 #2): idempotencia por INSERT `pending` + captura 23505
  (patrón `fee-charge.ts:239`). Si en algún punto se usa `upsert`, es
  `.upsert(row, {onConflict, ignoreDuplicates:true}).select()` — NO `.insert().onConflict()`
  (no existe en supabase-js v2).
- **CD-10** (Auto-Blindaje WKH-133 #4): `BigInt(wei)` sobre valores derivados de
  DB/cálculo envuelto en try/catch cuando el contrato es no-throw (CD-B).
- **CD-B** (heredado `fee-charge.ts`): `chargeProtocolFee` NUNCA rechaza la promise —
  todo error → status en el shape + `markFailed` best-effort (por leg y parent).

### PROHIBIDO

- **CD-P1**: PROHIBIDO cambiar la **firma pública** de `chargeProtocolFee`
  (`{orchestrationId, feeBaseUsdc, feeRate}`) — los dos call-sites NO se editan. Solo se
  **extiende** `FeeChargeResult` con `splits?` (aditivo, no rompe el `switch` existente).
- **CD-P2**: PROHIBIDO tocar el pago directo agente↔caller (`agent.payTo` service payment,
  `compose.ts:invokeAgent`) — es otro money-path (Scope OUT).
- **CD-P3**: PROHIBIDO on-chain multi-output / escrow `debitBatch` (WKH-126a) — v1 es N
  transfers secuenciales best-effort (DT-1 work-item).
- **CD-P4**: PROHIBIDO derivar el monto total del fee de otra fuente que
  `getProtocolFeeRate()` — los splits SUBDIVIDEN, no suman un cobro nuevo (DT-3 work-item).
- **CD-P5**: PROHIBIDO `any`/`as unknown` gratuito (TS strict) y non-null assertion
  (biome) — usar `?? null`/`?? default` (WKH-133 #1).
- **CD-P6**: PROHIBIDO hardcodear wallets/bps/token/chain — todo de env/DB
  (`SPLIT_BPS_*`, `WASIAI_PROTOCOL_FEE_WALLET`, `getPaymentAdapter()`).
- **CD-P7**: PROHIBIDO modificar archivos fuera del Scope IN (§4.1); NO tocar el dir de
  WKH-135 (137). Correr `biome check` sobre archivos tocados (WKH-132 auto-blindaje).

---

## 6. Scope

**IN:** `getSplitConfig()` env, `a2a_fee_splits` + columnas net-new de `a2a_agents` + RLS,
`fee-split.ts` (compute/resolve/settle/reverse), reescritura interna de `chargeProtocolFee`
(firma intacta), tipos, tests money-path (Σbps, dust, refund N-way, per-recipient status).

**OUT:** pago directo agente↔caller (`agent.payTo`), escrow `debitBatch` on-chain
multi-output (WKH-126a), UI de config (wasiai-v2), KYC de recipients, wiring de SP-1/SP-2
de WKH-135 (seam-compatible pero diferido hasta merge — §SG-4), atribución proporcional
multi-agente del creador, per-request/per-agente bps config (v1 = global env).

---

## 7. Riesgos (para AR)

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Divergencia entre call-sites (splits en uno, no en otro) | B | A | Único punto de entrada `chargeProtocolFee` reescrito por dentro; call-sites NO tocados (§1/CD-P1). Test T-DIV. |
| Fuga/creación de USD por dust/redondeo | M | A | Micro-USD entero + `dust→platform` ⇒ `Σ legs==fee` exacto (§4.5, CD-5). Test T-DUST. |
| `Σbps != 10000` cobra parcial | M | A | `getSplitConfig` fail-CLOSED antes de todo transfer (AC-2/CD-1). Test T-SUM. |
| Caller define su propio split (robo de revenue plataforma) | M | A | Recipients server-side only; global env config; CD-6. Test T-CD6. |
| Romper transparencia WKH-132 (`protocolFeeUsdc`) | B | A | Total = `feeBase×rate` intacto; splits subdividen (CD-5/CD-P4). Test T-TRANSP + suite WKH-132. |
| Leg falla → agregado reporta charged falso | M | A | Parent `failed` si algún leg obligatorio falla (AC-3). Test T-PARTIAL. |
| Refund no revierte todos los splits | B (SP-0) | A | Fee post-success (mutuamente excluyente con refund, §4.7) + `reverseFeeSplits` itera TODOS (CD-4). Test T-REV. |
| Clawback on-chain imposible (transfer a externos) | — | — | Documentado honesto (§4.7/SG-7); reverse = ledger-only en v1. Ratificación humana. |
| Regresión del cobro actual | B | A | Default `10000/0/0` = 1 leg platform = byte-idéntico. Suite `fee-charge.test.ts` + orchestrate/compose billing. Test T-REGR. |
| Doble-cobro por leg en retry | M | A | `UNIQUE(orch,role)` + INSERT pending 23505 (CD-2/CD-9). Test T-IDEM. |
| Recipient inválido crashea el settle | B | M | `resolveRecipients` fallback→platform, fila `skipped` (AC-6). Test T-FALLBACK. |

---

## 8. Dependencias

- `getPaymentAdapter()` / `verifyDefaultChainSettle` inicializados (multi-chain) — existen.
- `WASIAI_PROTOCOL_FEE_WALLET` seteada (ancla de dust/fallback; si vacía → skip como hoy).
- Env net-new: `SPLIT_BPS_PLATFORM` (default 10000), `SPLIT_BPS_CREATOR` (default 0),
  `SPLIT_BPS_REFERRAL` (default 0). Σ debe ser 10000.
- Migración aplicada en la DB correcta (caldz=a2a+mainnet / bdwv=dev; MEMORY db-topology).
- **SERIAL vs WKH-135:** el seam SP-1/SP-2 (§4.9 de SDD #137) NO está mergeado. v1 se
  limita a SP-0 (fee) y diseña `fee-split.ts` seam-compatible → cuando WKH-135 mergee, se
  adopta sin refactor. NO se construye sobre código no-mergeado.

---

## 9. Missing Inputs / SPEC-GATE — propuestas a ratificar

Todas resueltas como **PROPUESTA groundeada** (no `[NEEDS CLARIFICATION]` abiertos). El
humano ratifica/corrige en el SPEC gate.

| # | Fork | PROPUESTA (default groundeado) | Alternativa |
|---|------|-------------------------------|-------------|
| **SG-1** | Config de bps (per-agente/per-request/global) | **Global env** (`SPLIT_BPS_*`), default `10000/0/0` (= comportamiento actual, cero regresión). Reusa patrón `PROTOCOL_FEE_RATE`, respeta CD-6. | Per-agente (config surface administrada, futuro) / per-request (**prohibido** por CD-6). |
| **SG-2** | Atribución de **referral** (net-new) | **Columna `a2a_agents.referrer_ref`** (nullable) capturada **al publicar** (WKH-134, server-side, autenticada). Resuelta a wallet server-side. Ausente → bps folds a plataforma. Per-request referrer **rechazado** (CD-6, robo de revenue). | Parámetro de referral por-request firmado / tabla de atribución dedicada (futuro). |
| **SG-3** | Definición de **"atómico"** | **Contable all-or-nothing a nivel aplicación**: plan validado `Σ==10000` fail-CLOSED antes de transferir; legs idempotentes + status por-recipient; agregado nunca `charged` con leg fallido; dust determinístico. On-chain multi-output OUT. | Escrow `debitBatch` (WKH-126a) para atomicidad on-chain real (futuro). |
| **SG-4** | Endpoint scope | **SP-0 (fee) en `/orchestrate/execute` + `/compose`** vía la reescritura interna de `chargeProtocolFee`. SP-1/SP-2 (WKH-135) **diferidos** hasta merge (diseño seam-compatible). | Cablear SP-1/SP-2 ya (bloqueado: WKH-135 no mergeado; violaría "no construir sobre código no-mergeado"). |
| **SG-5** | Wallet del **creador** | Agente **primario** (step[0]/agente único): registry `metadata.payTo`, self-published `a2a_agents.payout_wallet` (net-new). Ausente → fallback plataforma. | Atribución proporcional multi-agente (futuro). |
| **SG-6** | Fallback recipient inválido (AC-6) | **Re-enrutar el bps huérfano a la plataforma** (ancla env garantizada); fila del recipient = `skipped` + log. Nunca abort, nunca USD perdido. | Descartar (dust perdido) / abortar settle (fail-closed total — más disruptivo). |
| **SG-7** | Refund de splits (AC-4) | **Estructural** (fee post-success, nunca cobrado en el path de refund SP-0) **+** `reverseFeeSplits` ledger-only (reversa contable auditable, itera TODOS los legs) para el seam SP-1/SP-2. Clawback on-chain de transfers a externos = imposible sin escrow (honesto). | Splits vía escrow reversible (WKH-126a, futuro). |

---

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| SPEC-GATE SG-1..SG-7 | §9 | 7 propuestas de producto — PROPUESTA lista, ratificar | Sí (gate humano) |
| [VERIFY-AT-IMPL] R-1 | §4.5 | `feeUsdcToWei(leg.amount)` reusa la conversión exacta (`BigInt(Math.round(usd*1e6))*BigInt(1e12)`) por leg — confirmar contra el token de cada chain al implementar | No |
| [VERIFY-AT-IMPL] R-2 | §4.2 | Firma/tipos exactos de la tabla `a2a_fee_splits` + columnas nuevas al generar `database.types.ts` (patrón `a2a_protocol_fees`) | No |
| [VERIFY-AT-IMPL] R-3 | §4.4 | Forma exacta de lectura de `agent.metadata.payTo` (kite) vs `payout_wallet` (self-published) contra `compose.ts:788-793` al implementar | No |

> Gate: SG-1..SG-7 se ratifican en SPEC_APPROVED. Los `[VERIFY-AT-IMPL]` NO bloquean el
> gate (se resuelven byte-a-byte en F3).

---

## 11. Plan de Tests (vitest — ≥1 por AC + money-path)

| Test | AC/Riesgo | Archivo | Descripción |
|------|-----------|---------|-------------|
| **T-SUM** Σbps fail-closed | AC-1/AC-2/CD-1 | `fee-split.test.ts` | config `5000/3000/1000` (Σ=9000) → `SplitConfigError`, **cero** `sign()`/`settle()` llamado. `10000/0/0` y `8000/1500/500` (Σ=10000) → OK. |
| **T-DUST** redondeo sin fuga | AC-5/CD-5/CD-6 | `fee-split.test.ts` | fee=$0.010001 con `3333/3333/3334` → `Σ amount_usdc == feeUsdc` exacto; dust en platform; ni pierde ni crea USD (micro-USD entero). |
| **T-SPLIT** reparto correcto | AC-1 | `fee-split.test.ts` | fee=$1.00, `8000/1500/500` → platform $0.80, creator $0.15, referral $0.05; 3 legs `charged` a las 3 wallets correctas. |
| **T-PARTIAL** status por-recipient | AC-3 | `fee-split.test.ts` | leg creator `settle()` falla, platform OK → creator `failed`, platform `charged`, **parent `failed`** (nunca `charged` agregado). |
| **T-TRANSP** transparencia intacta | AC-5/CD-5/CD-P4 | `fee-split.test.ts` + suite WKH-132 | con splits activos, `chargeProtocolFee` retorna `feeUsdc == feeBase×rate` (mismo total); `protocolFeeUsdc` del quote NO cambia. |
| **T-FALLBACK** recipient inválido | AC-6/SG-6 | `fee-split.test.ts` | creator wallet ausente → su bps re-enrutado a platform, fila creator `skipped`, settle NO crashea, `Σ==fee`. |
| **T-REV** reverse N-way | AC-4/CD-4 | `fee-split.test.ts` | 3 legs `charged` → `reverseFeeSplits` marca **los 3** `reversed` (no solo el 1º) + compensación; owner mismatch → `OWNERSHIP_MISMATCH`. |
| **T-CD6** recipients server-side | CD-6 | `fee-split.test.ts` | un `splits`/`referralWallet` en el body es IGNORADO; recipients solo de env/DB. |
| **T-IDEM** idempotencia por leg | CD-2/CD-9 | `fee-split.test.ts` | 2 llamadas mismo `orchestrationId` → cada leg cobra 1 sola vez (23505 / parent already-charged). |
| **T-WRITE** guard bps | CD-7 | `split-config.test.ts` | `SPLIT_BPS_*` negativo / `NaN` / >10000 / no-entero → `SplitConfigError`, sin cobro. |
| **T-VERIFY** on-chain por leg | CD-5 | `fee-split.test.ts` | leg `settle()` OK pero `verifyDefaultChainSettle` fail-CLOSED → leg `failed`, no `charged`. `RPC_UNAVAILABLE` → fail-OPEN + warn. |
| **T-DIV** cero divergencia | Riesgo divergencia | (suite existente) | `chargeProtocolFee` produce el MISMO comportamiento invocado desde el patrón de compose y de orchestrate (firma única). |
| **T-REGR** no-regresión default | Riesgo regresión/CD-P1 | (suite existente) | `10000/0/0` → `fee-charge.test.ts` + `orchestrate.billing.test.ts` + `money-path.*` verdes sin cambios (1 leg platform = comportamiento actual). |

---

## 12. Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene >=1 archivo asociado (§4.1: fee-split.ts / migración / split-config.ts / fee-charge.ts)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read (fee-charge, compose route, orchestrate service, protocol_fees migration, refund_with_dest_policy, a2a_agents, agent.ts, price.ts, settle-verifier vía #137)
[x] No hay [NEEDS CLARIFICATION] abiertos — 7 forks resueltos como PROPUESTA a ratificar (§9)
[x] Constraint Directives: 11 OBLIGATORIO + 7 PROHIBIDO (>=3)
[x] Context Map: 12 archivos leídos (>=2) + auto-blindaje de 3 HUs DONE
[x] Scope IN/OUT explícitos (§6)
[x] BD: tablas verificadas (a2a_protocol_fees/a2a_agents existen; a2a_fee_splits + columnas se crean)
[x] Happy Path completo (§4.6) + flujo de error (§4.8, 11 casos)
[x] Seam SP-1/SP-2 de WKH-135 documentado como diferido seam-compatible (§SG-4)
[x] Test plan >=1 por AC + money-path (§11, 13 tests: Σbps, dust, refund N-way, per-recipient status)
[x] Waves con W0 serial primero (§13)
[x] Money-path invariants: Σbps==10000 fail-closed, dust sin fuga, cero doble-cobro, refund itera TODOS, Ownership Guard, idempotencia (§5/§7)
[x] Auto-Blindaje histórico incorporado (WKH-132 BLQ-MED-1, WKH-133 #1/#2/#4, WKH-134 #1/#3, WKH-142) → CD-7..CD-10
```

**Estado:** LISTO para SPEC gate. Bloqueo residual = ratificación humana de SG-1..SG-7
(§9, sobre todo **SG-2 referral**, **SG-1 config bps global**, **SG-3/SG-7 atomicidad +
límite de clawback on-chain**). Los `[VERIFY-AT-IMPL]` R-1/R-2/R-3 se resuelven en F3.

---

## 13. Waves de Implementación

### Wave 0 (Serial Gate — contratos / tipos / DB / config)
- **W0.1**: Migración `20260705000000_wkh136_fee_splits.sql` + `_down` — tabla
  `a2a_fee_splits` (`UNIQUE(orchestration_id, recipient_role)`, RLS, trigger updated_at) +
  `ALTER a2a_agents ADD payout_wallet, referrer_ref`. Exemplar: `a2a_protocol_fees.sql`,
  `wkh134_a2a_agents.sql`. [VERIFY-AT-IMPL R-2].
- **W0.2**: `src/config/split-config.ts` — `getSplitConfig()` env-backed sin cache +
  `SplitConfigError` (fail-CLOSED `Σ==10000`). Exemplar: `getProtocolFeeRate` /
  `lib/price.ts`. **AC-1/AC-2/CD-1**.
- **W0.3**: Tipos `SplitLeg`, `SplitConfig`, `SplitRecipientRole`, `FeeSplitRow`,
  `FeeChargeResult` extendido (`splits?`) en `types/index.ts` + `database.types.ts`.
  CD-8 (`exactOptionalPropertyTypes`). [VERIFY-AT-IMPL R-2].

### Wave 1 (Parallelizable — lógica pura + settle)
- **W1.1**: `fee-split.ts` — `computeSplits(feeUsdc, config)` (micro-USD entero,
  dust→platform, §4.5) + `resolveRecipients` (server-side, fallback→platform, §4.4).
  Exemplar: `delegation.ts` (micro-USD). **AC-5/AC-6/CD-5/CD-6**. [VERIFY-AT-IMPL R-3].
- **W1.2**: `fee-split.ts` — `settleFeeSplits` (N legs idempotentes: INSERT pending →
  `sign()`+`settle()`+`verifyDefaultChainSettle` → charged/failed por leg; agregado AC-3).
  Exemplar: `fee-charge.ts:257-345`. **AC-1/AC-3/CD-2/CD-3/CD-5/CD-B**. [VERIFY-AT-IMPL R-1].
- **W1.3**: `fee-split.ts` — `reverseFeeSplits` (itera TODOS los legs charged → reversed +
  compensación, Ownership Guard bajo lock). Exemplar: `refund_with_dest_policy`. **AC-4/CD-4**.

### Wave 2 (Depende de W0+W1 — integración)
- **W2.1**: Reescritura interna de `chargeProtocolFee` (`fee-charge.ts`) → delega a
  `fee-split.ts`. **Firma pública INTACTA** (CD-P1); `FeeChargeResult` extendido aditivo.
  Los call-sites (`compose.ts`, `orchestrate.ts`) NO se tocan.
- **W2.2**: `.env.example` documenta `SPLIT_BPS_*` (default `10000/0/0`).

### Wave 3 (Final — tests + verificación)
- **W3.1**: `fee-split.test.ts` + `split-config.test.ts` (13 tests §11).
- **W3.2**: correr `fee-charge.test.ts` + `orchestrate.billing.test.ts` +
  `money-path.concurrency.test.ts` + `money-path.resilience.test.ts` (CD-P1/T-REGR) +
  `tsc` + `biome check` sobre archivos tocados (WKH-132 auto-blindaje).

---

*SDD generado por NexusAgil — FULL (F2). Money-path QUALITY.*
