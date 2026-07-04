# Story File — #138: [WKH-136] Splits atómicos al settlement (bps: plataforma / creador / referral)

> SDD: doc/sdd/138-wkh-136-atomic-splits-bps/sdd.md (fuente de verdad — Dev NO necesita releerlo)
> Fecha: 2026-07-03
> Branch: feat/138-wkh-136-atomic-splits-bps
> Tipo: feature money-path — QUALITY. Cualquier bug acá es pérdida de fondos o doble-cobro.

---

## Goal

Generalizar el **protocol fee único** (1% cost-based, WKH-132; hoy cobrado a UNA wallet
`WASIAI_PROTOCOL_FEE_WALLET` vía `chargeProtocolFee()`) en **N splits configurables en
basis points (bps)** ruteados a **plataforma / creador / referral** en el settlement.
Los splits **SUBDIVIDEN** el fee actual: el total cobrado al caller **NO cambia**
(invariante WKH-132). Con la config por defecto (`10000/0/0`) el comportamiento es
**byte-idéntico al de hoy** (1 leg = 100% plataforma) → opt-in, cero regresión.

**La decisión de arquitectura central (bakeada, no reabrir):** los dos call-sites del fee
(`routes/compose.ts:574` y `services/orchestrate.ts:1065`) ya comparten un único punto de
entrada `chargeProtocolFee()`. **NO se tocan.** Se reescribe SOLO el **interior** de
`chargeProtocolFee` para que, en vez de un `sign()+settle()` a una wallet, ejecute **N legs
idempotentes** vía un módulo hermano `fee-split.ts`, cada leg reusando **exactamente** el
mismo primitivo (`getPaymentAdapter().sign()/.settle()` + `verifyDefaultChainSettle`). Un
solo punto de cálculo ⇒ cero divergencia entre `/orchestrate` y `/compose`.

**Atomicidad = contable all-or-nothing a nivel app** (SG-3/SG-7 ratificados): el plan de
splits se valida `Σbps == 10000` **fail-CLOSED antes** de cualquier transfer; cada leg es
idempotente con status propio; el agregado **NUNCA** se reporta `charged` si un leg
obligatorio falló; el dust se absorbe en plataforma. Reversal on-chain de transfers a
externos = **imposible sin escrow** → `reverseFeeSplits` es **ledger-only** (auditable) y
en v1 **NO se cablea** a orchestrate/compose (el fee se cobra post-success → nunca está en
el path de refund). Se expone como capacidad + test, lista para el seam SP-1/SP-2 de WKH-135.

---

## Forks ratificados por el humano (BAKEADOS — no reabrir)

- **SG-1**: config **global env server-side** (`SPLIT_BPS_PLATFORM/CREATOR/REFERRAL`).
  NUNCA per-request (CD-6: un split libre en el body = robo del cut de plataforma).
- **SG-2**: referral = columna `a2a_agents.referrer_ref` (capturada al publicar,
  server-side). Ausente → su bps re-ruta a plataforma.
- **SG-3**: atomicidad = contable all-or-nothing a nivel app (definida arriba).
- **SG-4**: splits **solo sobre el fee actual** (SP-0). SP-1/SP-2 de WKH-135 **diferidos**
  (seam-compatible, no construir sobre código no-mergeado).
- **SG-5**: creador = `payout_wallet` (self-published) o `metadata.payTo` (registry) del
  agente **primario** (step[0] en orchestrate / agente único en compose).
- **SG-6**: recipient inválido/ausente → su bps se re-ruta a **plataforma**; fila `skipped`.
- **SG-7**: reverse = **ledger-only** en v1 (clawback on-chain a externos imposible sin escrow).

---

## Acceptance Criteria (EARS) — copiados del SDD aprobado (QA valida en F4)

- **AC-1** — WHEN se dispara un settlement de protocol fee (`/orchestrate/execute` o
  `/compose`), THE system SHALL dividir el fee en 1..N recipients según una config de bps
  cuya suma SHALL ser exactamente **10000** antes de aplicar cualquier split.
- **AC-2** — IF los bps no suman exactamente 10000, THEN THE system SHALL **rechazar el
  cálculo** (fail-CLOSED, cero cobro parcial) con un error explícito (`SplitConfigError`).
- **AC-3** — WHEN un settlement con splits se ejecuta y ≥1 transfer falla mientras otras
  tienen éxito, THE system SHALL registrar el status **por-recipient**
  (`charged`/`failed`/`skipped`) y NUNCA reportar `charged` agregado si un recipient
  obligatorio falló.
- **AC-4** — WHILE un step/orchestration con splits aplicados es reembolsado, THE system
  SHALL revertir (a nivel ledger contable) **TODOS** los splits asociados — no solo el
  share de plataforma.
- **AC-5** — WHEN `/orchestrate/plan` (o el quote de compose) reporta el fee, THE system
  SHALL mantener el contrato de transparencia WKH-132/133 (`protocolFeeUsdc` /
  `feeRatePercent`): el total cobrado al caller es el MISMO número, con o sin splits.
- **AC-6** — IF un recipient resuelve a una wallet inválida/ausente, THEN THE system SHALL
  saltear (skip) ese recipient (log estructurado, sin crashear) y **re-enrutar su bps a la
  plataforma**.

---

## Files to Modify/Create

> **8 archivos** (Scope IN exhaustivo — NO tocar ninguno fuera de esta tabla).

| # | Archivo | Acción | Qué hacer | Exemplar (verificado) |
|---|---------|--------|-----------|-----------------------|
| 1 | `supabase/migrations/20260705000000_wkh136_fee_splits.sql` | Crear | Tabla `a2a_fee_splits` (`UNIQUE(orchestration_id, recipient_role)`, RLS deny-by-default, trigger updated_at, índices) + `ALTER a2a_agents ADD COLUMN IF NOT EXISTS payout_wallet TEXT, referrer_ref TEXT`. `BEGIN;...COMMIT;` | `20260421015829_a2a_protocol_fees.sql`, `20260703000000_wkh134_a2a_agents.sql` |
| 2 | `supabase/migrations/20260705000000_wkh136_fee_splits_down.sql` | Crear | `BEGIN;` DROP `a2a_fee_splits` + `ALTER a2a_agents DROP COLUMN IF EXISTS payout_wallet, referrer_ref;` `COMMIT;` | `20260703000000_wkh134_a2a_agents_down.sql` |
| 3 | `src/config/split-config.ts` | Crear | `getSplitConfig()` env-backed sin cache (lee `SPLIT_BPS_PLATFORM/CREATOR/REFERRAL`, valida cada entero en `[0,10000]` y `Σ==10000` fail-CLOSED) + `class SplitConfigError` (`statusCode = 400`) | `src/lib/price.ts` (patrón env-backed), `fee-charge.ts:100-121` (`getProtocolFeeRate`), `fee-charge.ts:63-69` (`ProtocolFeeError`) |
| 4 | `src/services/fee-split.ts` | Crear | `computeSplits()` (micro-USD entero, dust→platform), `resolveRecipients()` (server-side, fallback→platform), `settleFeeSplits()` (N legs idempotentes), `reverseFeeSplits()` (ledger-only, itera TODOS) + tipos `SplitLeg`/`SplitRecipientRole`/`FeeSplitRow` | `fee-charge.ts` (idempotencia + sign/settle + verify), `delegation.ts:112-121` (micro-USD), `compose.ts:788-801` (payTo resolve) |
| 5 | `src/services/fee-charge.ts` | **Modificar** | Reescribir SOLO el interior de `chargeProtocolFee()` (L163-354) → delega a `fee-split.ts`. **Firma pública INTACTA** (`{orchestrationId, feeBaseUsdc, feeRate}`). Extender `FeeChargeResult` (L48-57) con `splits?: SplitLeg[]` **aditivo**. `feeUsdcToWei` (L133-135) se reusa/exporta para `fee-split.ts` | (self) |
| 6 | `src/config/split-config.test.ts` | Crear | Tests de `getSplitConfig` (T-WRITE: negativo/NaN/>10000/no-entero/Σ≠10000 → `SplitConfigError`; default `10000/0/0` OK) | `fee-charge.test.ts` (mock env + assert throw) |
| 7 | `src/services/fee-split.test.ts` | Crear | Tests money-path (T-SUM/T-DUST/T-SPLIT/T-PARTIAL/T-TRANSP/T-FALLBACK/T-REV/T-CD6/T-IDEM/T-VERIFY) | `fee-charge.test.ts` (mocks de adapter/supabase/settle-verifier, líneas 1-55) |
| 8 | `.env.example` | Modificar | Documentar `SPLIT_BPS_PLATFORM=10000`, `SPLIT_BPS_CREATOR=0`, `SPLIT_BPS_REFERRAL=0` (Σ=10000) tras el bloque `PROTOCOL_FEE_RATE` (L481-490) | `.env.example:481-490` |

**CERO** modificaciones a los call-sites: `routes/compose.ts`, `services/orchestrate.ts`,
`routes/orchestrate.ts` NO se tocan (heredan splits porque la firma de `chargeProtocolFee`
no cambia — clave anti-divergencia, CD-P1).

### ⚠️ Anti-hallucination — decisión de ubicación de tipos

El SDD §4.1 menciona `src/types/index.ts` / `database.types.ts` para los tipos nuevos.
**VERIFICADO:** `FeeChargeResult` NO vive en `types/index.ts` (grep vacío) — vive en
`src/services/fee-charge.ts:48-57`. **Por lo tanto:**
- Extendé `FeeChargeResult` **en `fee-charge.ts`** (donde está), agregando `splits?: SplitLeg[]`.
- Definí `SplitLeg`, `SplitConfig`, `SplitRecipientRole`, `FeeSplitRow` **en el módulo donde
  se usan** (`fee-split.ts` para runtime, importados por `fee-charge.ts`; `split-config.ts`
  exporta `SplitConfig`). NO crees tipos huérfanos en `types/index.ts` si no encajan con el
  patrón existente. Si `database.types.ts` tiene un registro tipado de tablas, agregá el row
  de `a2a_fee_splits` + columnas nuevas de `a2a_agents` ahí `[VERIFY-AT-IMPL: leer
  src/types/database.types.ts al implementar y seguir su forma exacta]`.

---

## Exemplars

### Exemplar 1: `chargeProtocolFee` — idempotencia + sign/settle + re-verify (el patrón CANÓNICO por leg)
**Archivo**: `src/services/fee-charge.ts` (leer L133-375 completo)
**Usar para**: archivos #4 (`settleFeeSplits`) y #5 (reescritura interior).
**Patrón clave (cada leg de `settleFeeSplits` lo replica exactamente):**
- `feeUsdcToWei(usdc)` = `String(BigInt(Math.round(usdc * 1e6)) * BigInt(1e12))` (L133-135).
  **Reusar tal cual** — exportarlo desde `fee-charge.ts` para `fee-split.ts` o replicar
  byte-idéntico. NUNCA un conversor paralelo (CD-3).
- Idempotencia: `SELECT status,tx_hash` por clave → si `charged` return already; si
  `pending` return inProgress; luego `INSERT ... status:'pending'`; capturar
  `insertErr.code === '23505'` (`PG_UNIQUE_VIOLATION`) → leg ya en curso, skip (L188-254).
- `sign()` en `let signResult: SignResult` con try/catch propio (L256-268); `settle()` con
  try/catch propio (L271-345); `if (!settleResult.success)` → `markFailed` + `failed`.
- **re-verify SIEMPRE antes de `charged`**: `await verifyDefaultChainSettle({ txHash,
  payTo: leg.wallet, requiredAmountAtomic: BigInt(feeWei) })` (L293-297). Si `.warn` →
  `log.warn` fail-OPEN (RPC_UNAVAILABLE); si `!.ok` → `markFailed` + `failed` (L300-315).
- `markFailed` best-effort (L359-375): update `failed` en try/catch que nunca throwea.
- **CD-B**: la función **NUNCA** rechaza la promise — todo error → status en el shape.
  El `try{}catch(err){ return {status:'failed',...} }` externo (L346-353) envuelve TODO.

### Exemplar 2: `getProtocolFeeRate` / `getPyusdUsdRate` — env-backed sin cache con guard
**Archivo**: `src/services/fee-charge.ts:100-121` + `src/lib/price.ts:1-60`
**Usar para**: archivo #3 (`getSplitConfig`).
**Patrón clave:**
- Re-lee `process.env.SPLIT_BPS_*` **en cada call** (sin cache; un restart aplica el cambio).
- Por cada valor: `raw === undefined || raw === '' → default`; `Number.parseInt(raw, 10)`;
  guard `!Number.isInteger(n) || n < 0 || n > 10000` (equivalente a `Number.isFinite` de
  price.ts pero **entero**, CD-7) → `SplitConfigError` (NO fallback silencioso: es fail-CLOSED,
  a diferencia de la rate que hace fallback; acá una config corrupta debe **rechazar el
  cobro**, AC-2).
- Tras parsear los 3: `if (platform + creator + referral !== 10000) throw SplitConfigError`.
- `SplitConfigError extends Error` con `readonly statusCode = 400` — espejo exacto de
  `ProtocolFeeError` (`fee-charge.ts:63-69`).
- Defaults: `SPLIT_BPS_PLATFORM=10000`, `CREATOR=0`, `REFERRAL=0` ⇒ Σ=10000 ⇒ 100%
  plataforma ⇒ 1 leg ⇒ byte-idéntico a hoy.

### Exemplar 3: `decimalStringToMicroUsd` — aritmética micro-USD entera SIN float64
**Archivo**: `src/services/delegation.ts:112-121`
**Usar para**: archivo #4 (`computeSplits`).
**Patrón clave — el cálculo de splits (SDD §4.5), NUNCA `parseFloat` lossy:**
```
totalMicro = Math.round(feeUsdc * 1e6)                    // micro-USD entero
for role in [platform, creator, referral]:
    legMicro[role] = Math.floor(totalMicro * bps[role] / 10000)   // truncado
dust = totalMicro - Σ legMicro[*]                          // >= 0 por floor
legMicro[platform] += dust                                 // plataforma absorbe dust
// INVARIANTE GARANTIZADO: Σ legMicro[*] === totalMicro  ⇒ ni se pierde ni se crea USD
amountUsdc[role] = legMicro[role] / 1e6
```
- Legs con `amount == 0` (bps==0 default, o fee minúsculo) → se **saltan** (no transfer nulo).
- El leg on-chain usa `feeUsdcToWei(leg.amountUsdc)` (Exemplar 1) para el `value` en wei.

### Exemplar 4: migración `a2a_protocol_fees` + `a2a_agents` (RLS deny-by-default)
**Archivos**: `supabase/migrations/20260421015829_a2a_protocol_fees.sql`,
`supabase/migrations/20260703000000_wkh134_a2a_agents.sql`
**Usar para**: archivo #1.
**Patrón clave:**
- `CREATE TABLE IF NOT EXISTS ... status TEXT CHECK (status IN (...))` + índices
  `CREATE INDEX IF NOT EXISTS`.
- Trigger updated_at: `DROP TRIGGER IF EXISTS set_updated_at ON <tabla>; CREATE TRIGGER
  set_updated_at BEFORE UPDATE ON <tabla> FOR EACH ROW EXECUTE FUNCTION
  trigger_set_updated_at();` (protocol_fees:30-34).
- RLS: envolver en `BEGIN;...COMMIT;`; `ALTER TABLE public.a2a_fee_splits ENABLE ROW LEVEL
  SECURITY;` **sin FORCE, sin policy permisiva** (deny-by-default; service_role bypassa por
  BYPASSRLS — a2a_agents:42-44).
- Schema exacto de `a2a_fee_splits` (SDD §4.2 — copiar tal cual):
```sql
a2a_fee_splits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orchestration_id UUID NOT NULL,
  recipient_role   TEXT NOT NULL CHECK (recipient_role IN ('platform','creator','referral')),
  recipient_wallet TEXT NOT NULL,
  owner_ref        TEXT NOT NULL,
  bps              INT  NOT NULL CHECK (bps >= 0 AND bps <= 10000),
  amount_usdc      NUMERIC(18,6) NOT NULL CHECK (amount_usdc >= 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','charged','failed','skipped','reversed')),
  tx_hash          TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (orchestration_id, recipient_role)
);
CREATE INDEX idx_a2a_fee_splits_orch   ON a2a_fee_splits (orchestration_id);
CREATE INDEX idx_a2a_fee_splits_owner  ON a2a_fee_splits (owner_ref);
CREATE INDEX idx_a2a_fee_splits_status ON a2a_fee_splits (status);
-- + trigger updated_at (patrón protocol_fees:30-34)
```
- `ALTER TABLE public.a2a_agents ADD COLUMN IF NOT EXISTS payout_wallet TEXT, ADD COLUMN IF NOT EXISTS referrer_ref TEXT;`

### Exemplar 5: `refund_with_dest_policy` — reverse compensatorio con lock + Ownership Guard
**Archivo**: `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy.sql`
**Usar para**: `reverseFeeSplits` en archivo #4 (versión **ledger-only en app-layer**, no un RPC nuevo salvo que se decida).
**Patrón clave:**
- Conceptualmente: leer las filas del settlement (`FOR UPDATE` en un RPC, o SELECT + guard
  en app-layer), verificar Ownership Guard `owner_ref` (mismatch → `OWNERSHIP_MISMATCH`),
  no-op defensivo si nada que revertir, marcar **TODOS** los legs `charged → reversed` +
  emitir fila/recibo compensatorio (patrón fila NEGATIVA WKH-129).
- **`reverseFeeSplits(orchestrationId, ownerRef)` DEBE iterar sobre TODOS los legs `charged`**
  (no solo el primero) — CD-4, el AR lo verifica citando archivo:línea.
- **v1: ledger-only y NO se cablea a orchestrate/compose.** Es una capacidad expuesta + test.
  Recordá el matiz honesto (SDD §4.7): un transfer on-chain a una wallet externa NO se puede
  clawback; el reverse marca el ledger contable, no mueve fondos de vuelta.

### Exemplar 6: `resolveRecipients` — resolución server-side del payTo (CD-6)
**Archivo**: `src/services/compose.ts:788-801` (resolución de `metadata.payTo`)
**Usar para**: `resolveRecipients` en archivo #4.
**Patrón clave (fuentes server-side, NUNCA del body del caller):**
- `platform`: `process.env.WASIAI_PROTOCOL_FEE_WALLET`, `owner_ref = 'platform'`. Vacía →
  skip TODO el fee (comportamiento `WALLET_UNSET` actual, fee-charge.ts:180-184).
- `creator`: agente primario (step[0]/único) → registry: `agent.metadata.payTo` (con
  fallback `metadata.payment.contract`, compose.ts:788-801); self-published:
  `a2a_agents.payout_wallet`. `owner_ref` del agente. Ausente/inválida → **re-ruta bps a
  platform** (SG-6), fila del recipient = `skipped`.
- `referral`: `a2a_agents.referrer_ref` → wallet resuelta server-side. Ausente → re-ruta a
  platform, fila `skipped`.
- `[VERIFY-AT-IMPL R-3]`: la forma exacta de leer `agent.metadata.payTo` (kite) vs
  `payout_wallet` (self-published) se confirma contra `compose.ts:788-801` y el schema de
  `a2a_agents` al implementar. Validá con `.eq('owner_ref', ...)` toda query nueva.

---

## Constraint Directives (INVIOLABLES — copiados del SDD §5)

### OBLIGATORIO
- **CD-1** (AC-2): `getSplitConfig()` valida `Σbps == 10000` **fail-CLOSED**
  (`SplitConfigError`, statusCode 400) **antes** de cualquier transfer. PROHIBIDO cobro
  parcial de una config inválida.
- **CD-2**: idempotencia **por recipient** vía `UNIQUE(orchestration_id, recipient_role)`.
  PROHIBIDO reusar la PK única de `a2a_protocol_fees` para >1 recipient. **Ownership Guard
  `owner_ref` en la tabla + en TODA query/RPC nuevo** (`.eq('owner_ref', ...)`, CLAUDE.md).
  Un leg/reverse sin owner guard → BLOQUEANTE (IDOR) en el AR.
- **CD-3**: cada leg reusa **exactamente** `getPaymentAdapter().sign()/.settle()` +
  `feeUsdcToWei` (fee-charge.ts:133-135) + `verifyDefaultChainSettle`. PROHIBIDO un
  mecanismo de transferencia paralelo.
- **CD-4**: `reverseFeeSplits` itera sobre **TODOS** los legs `charged` (no solo el primero).
- **CD-5** (AC-5): NO romper `protocolFeeUsdc == totalCostUsdc × feeRate` (WKH-132/133).
  `Σ amount_usdc de los legs == feeUsdc` exacto. El total al caller NO cambia. (No confundir
  el agregado reportado con la magnitud real — WKH-132 BLQ-MED-1.)
- **CD-6**: recipients resueltos **SOLO server-side** (env/`a2a_agents`/`registries`), NUNCA
  de input no-autenticado del caller. PROHIBIDO un `referralWallet`/`splits` libre en el body
  de `/orchestrate` o `/compose`.
- **CD-7** (money-path, recurrente WKH-134/142): validar TODO bps/monto en el
  **write-boundary** (rechazo explícito si no es entero finito en `[0,10000]` / `number >= 0`)
  Y `CHECK` en DB (read-boundary).
- **CD-8** (`exactOptionalPropertyTypes:true`, recurrente WKH-134/133): construir objetos
  tipados (`SplitLeg`, `FeeChargeResult` extendido) con **asignación condicional**
  (`if (x !== undefined) obj.x = x`), NUNCA `x: cond ? v : undefined`.
- **CD-9** (WKH-133): idempotencia por INSERT `pending` + captura `23505`. Si se usa `upsert`,
  es `.upsert(row, {onConflict, ignoreDuplicates:true}).select()` — NO `.insert().onConflict()`
  (no existe en supabase-js v2).
- **CD-10** (WKH-133): `BigInt(wei)` sobre valores de DB/cálculo envuelto en try/catch cuando
  el contrato es no-throw (CD-B).
- **CD-B**: `chargeProtocolFee` NUNCA rechaza la promise — todo error → status en el shape +
  `markFailed` best-effort (por leg y por parent).

### PROHIBIDO
- **CD-P1**: PROHIBIDO cambiar la **firma pública** de `chargeProtocolFee`
  (`{orchestrationId, feeBaseUsdc, feeRate}`). Los dos call-sites NO se editan. Solo se
  **extiende** `FeeChargeResult` con `splits?` (aditivo, no rompe el `switch` existente).
- **CD-P2**: PROHIBIDO tocar el pago directo agente↔caller (`agent.payTo` service payment,
  `compose.ts:invokeAgent`) — otro money-path (Scope OUT).
- **CD-P3**: PROHIBIDO on-chain multi-output / escrow `debitBatch` (WKH-126a). v1 = N
  transfers secuenciales best-effort.
- **CD-P4**: PROHIBIDO derivar el monto total del fee de otra fuente que `getProtocolFeeRate()`
  — los splits SUBDIVIDEN, no suman un cobro nuevo.
- **CD-P5**: PROHIBIDO `any`/`as unknown` gratuito (TS strict) y non-null assertion (biome) —
  usar `?? null`/`?? default`.
- **CD-P6**: PROHIBIDO hardcodear wallets/bps/token/chain — todo de env/DB (`SPLIT_BPS_*`,
  `WASIAI_PROTOCOL_FEE_WALLET`, `getPaymentAdapter()`).
- **CD-P7**: PROHIBIDO modificar archivos fuera del Scope IN (tabla de 8). **NO tocar el dir
  de WKH-135 (`doc/sdd/137-...`)**. Correr `biome check` sobre archivos tocados.

---

## Test Expectations (vitest — 13 tests, ≥1 por AC + money-path)

| Test | ACs/Riesgo que cubre | Archivo | Descripción |
|------|----------------------|---------|-------------|
| **T-SUM** | AC-1/AC-2/CD-1 | `fee-split.test.ts` | `5000/3000/1000` (Σ=9000) → `SplitConfigError`, **cero** `sign()`/`settle()`. `10000/0/0` y `8000/1500/500` → OK. |
| **T-DUST** | AC-5/CD-5/CD-6 | `fee-split.test.ts` | fee=$0.010001, `3333/3333/3334` → `Σ amount_usdc == feeUsdc` exacto; dust en platform; ni pierde ni crea USD. |
| **T-SPLIT** | AC-1 | `fee-split.test.ts` | fee=$1.00, `8000/1500/500` → platform $0.80, creator $0.15, referral $0.05; 3 legs `charged` a las 3 wallets correctas. |
| **T-PARTIAL** | AC-3 | `fee-split.test.ts` | leg creator `settle()` falla, platform OK → creator `failed`, platform `charged`, **parent `failed`** (nunca `charged` agregado). |
| **T-TRANSP** | AC-5/CD-5/CD-P4 | `fee-split.test.ts` | con splits activos, `chargeProtocolFee` retorna `feeUsdc == feeBase×rate` (mismo total). |
| **T-FALLBACK** | AC-6/SG-6 | `fee-split.test.ts` | creator wallet ausente → bps re-enrutado a platform, fila creator `skipped`, settle NO crashea, `Σ==fee`. |
| **T-REV** | AC-4/CD-4 | `fee-split.test.ts` | 3 legs `charged` → `reverseFeeSplits` marca **los 3** `reversed` + compensación; owner mismatch → `OWNERSHIP_MISMATCH`. |
| **T-CD6** | CD-6 | `fee-split.test.ts` | un `splits`/`referralWallet` en el body es IGNORADO; recipients solo de env/DB. |
| **T-IDEM** | CD-2/CD-9 | `fee-split.test.ts` | 2 llamadas mismo `orchestrationId` → cada leg cobra 1 sola vez (23505 / parent already-charged). |
| **T-VERIFY** | CD-5 | `fee-split.test.ts` | leg `settle()` OK pero `verifyDefaultChainSettle` fail-CLOSED → leg `failed`, no `charged`. `RPC_UNAVAILABLE` → fail-OPEN + warn. |
| **T-WRITE** | CD-7 | `split-config.test.ts` | `SPLIT_BPS_*` negativo / `NaN` / >10000 / no-entero → `SplitConfigError`, sin cobro. |
| **T-DIV** | Riesgo divergencia | (suite existente) | `chargeProtocolFee` = MISMO comportamiento invocado como lo hace compose y orchestrate (firma única). |
| **T-REGR** | Riesgo regresión/CD-P1 | (suite existente) | `10000/0/0` → `fee-charge.test.ts` + `orchestrate.billing.test.ts` + `money-path.*` verdes sin cambios (1 leg platform = comportamiento actual). |

**Criterio Test-First:** lógica de negocio money-path → **SÍ, test-first** para
`getSplitConfig`, `computeSplits`, `settleFeeSplits`, `reverseFeeSplits`.

**Mocks (patrón `fee-charge.test.ts:1-55`, verificado):** `vi.mock('../lib/logger.js')`,
`vi.mock('../adapters/registry.js', () => ({ getPaymentAdapter: () => ({ sign: mockSign,
settle: mockSettle }) }))`, `vi.mock('../adapters/settle-verifier.js', () => ({
verifyDefaultChainSettle: (...a) => mockVerifySettle(...a) }))` (default
`{ok:true}`), `vi.mock('../lib/supabase.js')` con `from` chainable, `process.env.SPLIT_BPS_*`
seteado por test en `beforeEach`/`afterEach`.

---

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "revisar package.json"
# Archivos base del Scope IN existen:
ls src/services/fee-charge.ts src/services/delegation.ts src/lib/price.ts \
   src/adapters/settle-verifier.ts .env.example \
   supabase/migrations/20260421015829_a2a_protocol_fees.sql \
   supabase/migrations/20260703000000_wkh134_a2a_agents.sql 2>/dev/null || echo "FALTA archivo base"
# Env de referencia (NO se necesita DB real para los tests — todo mockeado):
echo "SPLIT_BPS_PLATFORM default=10000 / CREATOR=0 / REFERRAL=0"
npx tsc --noEmit 2>&1 | head -5   # baseline verde antes de empezar
```
**Si algo falla → PARAR y reportar al orquestador. No implementar sobre entorno roto.**

### Wave 0 (Serial Gate — contratos / tipos / DB / config; completar antes de todo)
- [ ] **W0.1** → Archivo #1 + #2: migración `20260705000000_wkh136_fee_splits.sql` + `_down`
  (tabla `a2a_fee_splits`, RLS deny-by-default, trigger updated_at, índices; `ALTER a2a_agents
  ADD payout_wallet, referrer_ref`). Exemplar 4. `[VERIFY-AT-IMPL R-2]`.
- [ ] **W0.2** → Archivo #3: `src/config/split-config.ts` — `getSplitConfig()` env-backed sin
  cache + `SplitConfigError` (fail-CLOSED `Σ==10000`). Exemplar 2. **AC-1/AC-2/CD-1/CD-7**.
- [ ] **W0.3** → tipos: extender `FeeChargeResult` en `fee-charge.ts` (`splits?: SplitLeg[]`,
  aditivo, CD-8); definir `SplitLeg`/`SplitRecipientRole`/`FeeSplitRow` en `fee-split.ts`;
  `SplitConfig` en `split-config.ts`. Agregar row de `a2a_fee_splits` a `database.types.ts`
  si sigue el patrón existente. `[VERIFY-AT-IMPL R-2]`.

### Wave 1 (Parallelizable — lógica pura + settle, dentro de `fee-split.ts`)
- [ ] **W1.1** → Archivo #4: `computeSplits(feeUsdc, config)` (micro-USD entero, dust→platform,
  Exemplar 3) + `resolveRecipients` (server-side, fallback→platform, Exemplar 6).
  **AC-5/AC-6/CD-5/CD-6**. `[VERIFY-AT-IMPL R-3]`.
- [ ] **W1.2** → Archivo #4: `settleFeeSplits` (N legs idempotentes: INSERT pending →
  `sign()+settle()+verifyDefaultChainSettle` → charged/failed por leg; agregado AC-3).
  Exemplar 1. **AC-1/AC-3/CD-2/CD-3/CD-5/CD-B**. `[VERIFY-AT-IMPL R-1]`.
- [ ] **W1.3** → Archivo #4: `reverseFeeSplits(orchestrationId, ownerRef)` (itera TODOS los
  legs `charged` → `reversed` + compensación, Ownership Guard bajo lock, ledger-only, NO
  cableado a call-sites). Exemplar 5. **AC-4/CD-4**.

### Wave 2 (Depende de W0+W1 — integración)
- [ ] **W2.1** → Archivo #5: reescritura interior de `chargeProtocolFee` → delega a
  `fee-split.ts`. **Firma pública INTACTA** (CD-P1). `FeeChargeResult` extendido aditivo.
  Los call-sites (`compose.ts`, `orchestrate.ts`) NO se tocan.
- [ ] **W2.2** → Archivo #8: `.env.example` documenta `SPLIT_BPS_*` (default `10000/0/0`).

### Wave 3 (Final — tests + verificación)
- [ ] **W3.1** → Archivos #6 + #7: `split-config.test.ts` + `fee-split.test.ts` (13 tests).
- [ ] **W3.2**: correr `fee-charge.test.ts` + `orchestrate.billing.test.ts` +
  `money-path.concurrency.test.ts` + `money-path.resilience.test.ts` (CD-P1/T-REGR) + `tsc
  --noEmit` + `biome check` sobre archivos tocados. Confirmar que con default `10000/0/0` el
  comportamiento es **byte-idéntico** (1 leg platform).

### Verificación Incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | `tsc --noEmit` verde; migración parsea (SQL sin error de sintaxis) |
| W1 | `tsc --noEmit` + tests de `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`reverseFeeSplits` |
| W2 | `tsc --noEmit` + `fee-charge.test.ts` sigue verde (firma intacta) |
| W3 | full: 13 tests nuevos + suites money-path existentes + `biome check` |

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- Call-sites del fee: `routes/compose.ts`, `services/orchestrate.ts`, `routes/orchestrate.ts`
  (heredan splits sin editarse — CD-P1).
- Pago directo agente↔caller (`agent.payTo` service payment, `compose.ts:invokeAgent`) — CD-P2.
- Escrow `debitBatch` / on-chain multi-output (WKH-126a) — CD-P3.
- Wiring de SP-1/SP-2 de WKH-135 (diferido hasta merge; diseño seam-compatible pero no cablear).
- UI de config de splits (vive en wasiai-v2), KYC de recipients, atribución proporcional
  multi-agente del creador, per-request/per-agente bps (v1 = global env).
- **`doc/sdd/137-...` (WKH-135) — NO tocar.**
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect. No inventar. No asumir.**

Situaciones de escalation:
- `FeeChargeResult` o `feeUsdcToWei` no están donde este doc dice (fee-charge.ts:48-57 / 133-135).
- `database.types.ts` no sigue un patrón de registro tipado de tablas → preguntar dónde van los tipos de row.
- `verifyDefaultChainSettle` cambió de firma respecto a settle-verifier.ts:312-337.
- El schema de `a2a_agents` no acepta el `ALTER ADD COLUMN` esperado.
- Ambigüedad en cómo resolver el "agente primario" (step[0]) en el contexto que llega a
  `chargeProtocolFee` — hoy la firma solo trae `orchestrationId/feeBaseUsdc/feeRate`. **Si la
  resolución del creador/referral requiere datos que NO llegan a `chargeProtocolFee` con su
  firma actual, ESCALAR:** puede que en v1 el creator/referral se resuelvan a `null` →
  re-rutan a platform (fila `skipped`), manteniendo la firma intacta (CD-P1). NO ampliar la
  firma pública sin ratificación.

---

*Story File generado por NexusAgil — F2.5. Money-path QUALITY.*
