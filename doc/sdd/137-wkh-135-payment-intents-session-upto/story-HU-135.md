# Story File — #137: [WKH-135] Intents de pago `session` (metered) + `upto` (cap dual-firmado)

> SDD: doc/sdd/137-wkh-135-payment-intents-session-upto/sdd.md
> Fecha: 2026-07-03
> Branch: feat/137-wkh-135-payment-intents-session-upto
> Tipo: feature money-path (QUALITY) — AR + CR obligatorios
> **Dev lee SOLO este documento. Si algo no está acá → PARÁ y escalá al Architect. No inventes.**

---

## Goal

Agregar dos intents de pago nuevos al money-path de wasiai-a2a, con naming compatible
con el Agent Payments Protocol (APP) de OKX, SIN tocar el intent `charge` (x402) ni
`/compose`/`/orchestrate`:

- **`session`** (metered): el Buyer abre una sesión con un **deposit** que se **reserva
  contra su budget prepago** de Agent Key (débito real vía `increment_a2a_key_spend`).
  Durante la sesión el gateway acumula **vouchers** de uso (append-only, idempotentes,
  **sin firmar** en V1). Al cierre → **UN solo settle on-chain** de `min(Σvouchers, deposit)`
  al Seller + **refund del residual** (`deposit − consumido`) al Buyer vía `refund_a2a_key_spend`.
- **`upto`** (cap dual-firmado): el Buyer **firma un cap EIP-712** (anclado a su
  `funding_wallet`, espejo directo de `delegation.ts`). El Seller reporta el uso real.
  El settle cobra **exactamente `min(cap, uso)`** — **clampa al cap**, nunca rechaza,
  nunca cobra > cap. El débito ocurre en el settle (upto NO reserva al abrir).

Esta HU deja un **helper de settle aislado** (`settlePaymentIntentOnChain`) que **WKH-136
(splits bps) va a envolver** — es interfaz estable, NO la refactorices.

---

## FORKS DE PRODUCTO — YA RATIFICADOS POR EL HUMANO (NO reabrir)

Están bakeados en este contrato. Implementalos tal cual, no los cuestiones:

- **SG-1 (session = gateway mide)**: voucher = fila append-only server-side, idempotente
  por `voucher_id` vía `UNIQUE(intent_id, voucher_id)`. **Firma del voucher = campo
  OPCIONAL reservado** (`voucher_signature TEXT NULL`), NO se verifica ni se requiere en V1.
  Deposit = reserva real contra el budget prepago (`increment_a2a_key_spend` dentro del
  RPC `open`). Settle = único, del `min(Σvouchers, deposit)`, al cierre. Refund del
  residual vía `refund_a2a_key_spend`.
- **SG-2 (upto = clamp al cap)**: uso > cap → settle = cap + telemetría (`log.warn`
  `cap_exceeded`), **nunca rechaza, nunca > cap**. Cap firmado EIP-712 anclado a
  `funding_wallet`. Seller-attestation EIP-712 = OPCIONAL, no en V1.
- **SG-3 (endpoints dedicados)**: `/payments/session/*` + `/payments/upto/*`. **NO tocar
  `/compose` ni `/orchestrate`**. Código 100% aditivo.

---

## Acceptance Criteria (EARS) — copiados del SDD

- **AC-1** — WHEN un intent `session` se cierra, THE system SHALL settlear **exactamente
  una vez** por intent, usando la PK del intent (UUID server-side) como clave de
  idempotencia (patrón `a2a_protocol_fees.orchestration_id`); un retry del cierre NUNCA
  produce un segundo cobro.
- **AC-2** — WHEN un intent `session` completa su settlement, THE system SHALL calcular y
  **creditar el residual** (`residual = deposit − Σvouchers_settled`) al budget del Buyer,
  sin retener fondos no consumidos.
- **AC-3** — WHEN un intent `upto` se settlea, THE system SHALL cobrar exactamente
  **`min(cap, uso_reportado)`** y NUNCA un monto mayor al cap firmado por el Buyer.
- **AC-4** — WHILE cualquier estado intermedio de `session`/`upto` persiste, THE system
  SHALL aplicar el Ownership Guard `owner_ref` (patrón CLAUDE.md / WKH-53) en TODA
  tabla/query/RPC nueva, sin excepción.
- **AC-5** — IF los identificadores de intent se exponen en superficie pública, THEN THE
  system SHALL usar los literales `"session"`/`"upto"` (compat APP), no un nombre interno.
- **AC-6** — IF un flujo queda a medio camino más de una ventana `expires_at`, THEN THE
  system SHALL resolverlo determinísticamente (**expiry → auto-settle del consumido +
  refund del residual**), sin retener fondos indefinidamente.

---

## Wave -1: Environment Gate (OBLIGATORIO — verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a

# 1. Deps instaladas
npm install 2>/dev/null || echo "FALTA package.json"

# 2. Archivos base del Scope IN existen (exemplars + destinos de modificación)
ls src/services/fee-charge.ts src/services/budget.ts src/services/delegation.ts \
   src/adapters/settle-verifier.ts src/adapters/registry.ts \
   src/routes/auth/key-session.ts src/routes/auth/parsers.ts \
   src/types/index.ts src/types/a2a-key.ts src/types/database.types.ts \
   src/index.ts \
   supabase/migrations/20260603000000_a2a_key_sessions.sql \
   supabase/migrations/20260606000000_a2a_key_spend_policies.sql \
   2>/dev/null || echo "FALTA archivo base — PARAR"

# 3. RPCs reusados existen en migraciones
grep -rl "FUNCTION increment_a2a_key_spend" supabase/migrations/ >/dev/null || echo "FALTA increment_a2a_key_spend"
grep -rl "FUNCTION refund_a2a_key_spend"    supabase/migrations/ >/dev/null || echo "FALTA refund_a2a_key_spend"

# 4. Symbols reusados exportados
grep -q "export async function verifyDefaultChainSettle" src/adapters/settle-verifier.ts || echo "FALTA verifyDefaultChainSettle"
grep -q "export function getPaymentAdapter"             src/adapters/registry.ts        || echo "check getPaymentAdapter export"
grep -q "async debit"  src/services/budget.ts || echo "FALTA budgetService.debit"
grep -q "async credit" src/services/budget.ts || echo "FALTA budgetService.credit"

# 5. tsc + biome baseline verde ANTES de empezar
npx tsc --noEmit && npx biome check src/ 2>&1 | tail -5
```

**Si algo falla en Wave -1 → PARAR y reportar al orquestador. No implementar sobre un
entorno roto.** (Origen: Auto-Blindaje — F3 perdió tiempo sobre archivos inexistentes.)

---

## Files to Create/Modify

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `supabase/migrations/20260704000000_wkh135_payment_intents.sql` | Crear | 2 tablas (`a2a_payment_intents` + `a2a_payment_vouchers`) + 4 RPC atómicos + RLS deny-by-default + hardening + `trigger_set_updated_at` | `20260603000000_a2a_key_sessions.sql`, `20260606000000_a2a_key_spend_policies.sql` |
| 2 | `supabase/migrations/20260704000000_wkh135_payment_intents_down.sql` | Crear | `DROP FUNCTION` de los 4 RPC (con firma exacta de args) + `DROP TABLE` de las 2 tablas, dentro de `BEGIN;...COMMIT;` | `20260603000000_a2a_key_sessions_down.sql` |
| 3 | `src/services/payment-intent.ts` | Crear | Servicio: EIP-712 cap + open/voucher/close/settle/expire + `settlePaymentIntentOnChain` (seam WKH-136) | `fee-charge.ts`, `delegation.ts`, `budget.ts` |
| 4 | `src/services/payment-intent.test.ts` | Crear | Tests money-path (T-AC1..T-CONC, ver Test Expectations) | `fee-charge.test.ts`, `money-path.concurrency.test.ts` |
| 5 | `src/routes/payments.ts` | Crear | Endpoints `/payments/session/*` + `/payments/upto/*` con auth (`resolveCallerKey`) + write-boundary validation + `crypto.randomUUID()` | `src/routes/auth/key-session.ts`, `src/routes/orchestrate.ts` |
| 6 | `src/routes/payments.test.ts` | Crear | Tests de ruta (auth, owner guard, shape, write-boundary) | `src/routes/agents.ownership.test.ts` (patrón owner guard) |
| 7 | `src/types/index.ts` | Modificar | Agregar `PaymentIntentRow`, `PaymentVoucherRow`, `UptoCapTypedData`, `UptoEip712Domain`, DTOs (`OpenSessionInput`, `AddVoucherInput`, `CreateUptoInput`, `SettleOutcome`) | tipos `DelegationRow`/`DelegationTypedData`/`KeySessionRow` existentes |
| 8 | `src/types/database.types.ts` | Modificar | Row types de las 2 tablas + `Args`/`Returns` de los 4 RPC nuevos | rows/RPC existentes en el archivo. **[VERIFY-AT-IMPL R-1]** |
| 9 | `src/index.ts` | Modificar | `await fastify.register(paymentsRoutes, { prefix: '/payments' });` junto a L143-177 | L143-177 (bloque de registers) |

**CERO** modificaciones a: `x402.ts`, `compose.ts`, `orchestrate.ts`, `fee-charge.ts`,
`budget.ts`, `delegation.ts`, `settle-verifier.ts`. Se **consumen**, NO se editan (salvo
que un AR/CR lo exija explícitamente).

---

## Contrato de Integración ⚠️ BLOQUEANTE

Esta HU expone endpoints HTTP nuevos (cliente ↔ gateway) + settle on-chain (gateway ↔
facilitator). Contrato exacto:

### Cliente (Buyer) → `POST /payments/session`
Auth: header `x-a2a-key: <master key>` **o** `Authorization: Bearer wasi_a2a_*` (usar
`resolveCallerKey`). `owner_ref` = `callerKey.owner_ref`.

**Request:**
```json
{
  "keyId":      "string (UUID) — Agent Key del Buyer (debe pertenecer al caller)",
  "sellerRef":  "string — '<registry>/<slug>' del Seller",
  "payTo":      "string (0x…) — address on-chain del Seller para el settle",
  "chainId":    "number (int) — chain del settle",
  "depositUsd": "number finito >= 0 — deposit a reservar contra el budget",
  "ttlSeconds": "number (int) opcional — default PAYMENT_INTENT_TTL_SECONDS (3600)"
}
```
**Response 201:**
```json
{ "intentId": "string (UUID server-side)", "intentType": "session", "expiresAt": "ISO 8601" }
```

### Cliente → `POST /payments/session/:id/voucher`
**Request:** `{ "voucherId": "string — idempotency key del voucher", "amountUsd": "number finito >= 0" }`
**Response 200:** `{ "accepted": true|false, "consumedUsd": "number", "duplicate": true|false }`
(`duplicate:true` cuando el `voucherId` ya existía → NO incrementó `consumed`).

### Cliente → `POST /payments/session/:id/close`
**Request:** `{}` (sin body relevante)
**Response 200:** `{ "status": "settled"|"failed", "txHash": "string|null", "consumedUsd": "number", "residualUsd": "number" }`

### Cliente (Buyer) → `POST /payments/upto`
**Request:**
```json
{
  "keyId":        "string (UUID) — Agent Key del Buyer",
  "sellerRef":    "string — '<registry>/<slug>'",
  "payTo":        "string (0x…)",
  "chainId":      "number (int)",
  "capUsd":       "number finito >= 0 — cap firmado",
  "capSignature": "string (0x…) — firma EIP-712 del cap",
  "capNonce":     "string — nonce del cap (anti-replay, UNIQUE)",
  "typedData":    "object — { domain, types, primaryType, message } EIP-712 del cap"
}
```
**Response 201:** `{ "intentId": "string (UUID)", "intentType": "upto", "expiresAt": "ISO 8601" }`

### Seller/Cliente → `POST /payments/upto/:id/settle`
**Request:** `{ "reportedUsageUsd": "number finito >= 0" }`
**Response 200:** `{ "status": "settled"|"failed", "txHash": "string|null", "chargedUsd": "number", "cappedAt": true|false }`
(`cappedAt:true` cuando `reportedUsage >= cap` → se cobró exactamente `cap`).

### Errores (todos los endpoints)
| HTTP | error_code | Cuándo |
|------|-----------|--------|
| 422 | `INVALID_INPUT` | monto no finito / `< 0` / no-number, o campo requerido faltante (write-boundary, CD-12) |
| 400 | `CAP_SIGNATURE_INVALID` | firma del cap `upto` inválida / firmante ≠ `funding_wallet` / domain distinto / nonce reusado |
| 403 | `OWNERSHIP_MISMATCH` | el `keyId`/`intentId` no pertenece al `owner_ref` del caller (mapeo por prefijo, NUNCA msg crudo PG) |
| 403 | `Invalid or inactive API key` | `resolveCallerKey` null o `!is_active` |
| 404 | `INTENT_NOT_FOUND` | intent inexistente (o de otro owner — disclosure-safe, mismo código que ownership según patrón) |
| 409 | `INTENT_NOT_OPEN` | voucher sobre intent ya `closing`/`settled`/`expired` |
| 400 | `INSUFFICIENT_BUDGET` | deposit `session` excede el budget prepago del Buyer |

> **Regla de mapeo (CD-2/budget.ts):** el service captura el error del RPC, hace match
> por **prefijo del mensaje** (`err.message.includes('OWNERSHIP_MISMATCH')`, etc.) y
> retorna un `error` string estable. NUNCA propagar `err.message` crudo de Postgres al
> cliente.

---

## Diseño de la Migración (Archivo #1 + #2)

### Tabla `a2a_payment_intents`
```sql
CREATE TABLE IF NOT EXISTS a2a_payment_intents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- idempotency key (AC-1)
  intent_type    TEXT NOT NULL CHECK (intent_type IN ('session','upto')),  -- literal APP (AC-5)
  owner_ref      TEXT NOT NULL,                    -- Ownership Guard (AC-4/CD-2)
  key_id         UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  buyer_wallet   TEXT,                             -- funding_wallet (upto: ancla de la firma)
  seller_ref     TEXT NOT NULL,                    -- '<registry>/<slug>' normalizado
  pay_to         TEXT NOT NULL,                    -- address on-chain del Seller (settle)
  chain_id       INT  NOT NULL,
  authorized_usd NUMERIC(20,8) NOT NULL CHECK (authorized_usd >= 0),  -- session: deposit / upto: cap
  consumed_usd   NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (consumed_usd >= 0),
  cap_signature  TEXT,                             -- upto
  cap_nonce      TEXT,                             -- upto (anti-replay)
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','closing','settled','refunded','expired','failed')),
  settle_tx_hash TEXT UNIQUE,                      -- anti doble-settle a nivel row
  residual_usd   NUMERIC(20,8),                    -- session post-close
  expires_at     TIMESTAMPTZ NOT NULL,             -- AC-6
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_a2a_payment_intents_key_owner ON a2a_payment_intents (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_payment_intents_owner     ON a2a_payment_intents (owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_payment_intents_status    ON a2a_payment_intents (status);
-- anti-replay del cap upto (nonce único por owner): UNIQUE parcial
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_payment_intents_cap_nonce
  ON a2a_payment_intents (owner_ref, cap_nonce) WHERE cap_nonce IS NOT NULL;
```

### Tabla `a2a_payment_vouchers` (ledger append-only, solo `session`)
```sql
CREATE TABLE IF NOT EXISTS a2a_payment_vouchers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id         UUID NOT NULL REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref         TEXT NOT NULL,                 -- Ownership Guard (AC-4)
  voucher_id        TEXT NOT NULL,                 -- idempotency key del voucher (CD-3)
  amount_usd        NUMERIC(20,8) NOT NULL CHECK (amount_usd >= 0),
  voucher_signature TEXT,                          -- OPCIONAL reservado (SG-1, no se verifica en V1)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_id, voucher_id)                   -- anti doble-conteo (CD-3): 23505 = ya visto
);
CREATE INDEX IF NOT EXISTS idx_a2a_payment_vouchers_intent ON a2a_payment_vouchers (intent_id);
```

### RLS (deny-by-default, patrón WKH-SEC-02 — SIN policy permisiva)
```sql
ALTER TABLE a2a_payment_intents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE a2a_payment_vouchers ENABLE ROW LEVEL SECURITY;
-- service_role bypassa por BYPASSRLS; anon/authenticated → deny-all.
```

### `updated_at` trigger
Reusar el trigger existente `trigger_set_updated_at` (mismo que `a2a_protocol_fees`):
```sql
CREATE TRIGGER set_a2a_payment_intents_updated_at
  BEFORE UPDATE ON a2a_payment_intents
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
```
> **[VERIFY-AT-IMPL]** confirmá el nombre exacto de la función trigger en
> `20260421015829_a2a_protocol_fees.sql` antes de referenciarla. Si difiere, usá el nombre real.

### 4 RPC atómicos — TODOS con este hardening (patrón `debit_session_and_parent`)
Cada función:
- `SECURITY DEFINER` + `LANGUAGE plpgsql`
- `ALTER FUNCTION ... SET search_path = public, pg_temp;`
- `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated;`
- `GRANT EXECUTE ... TO service_role;`
- Lock con `FOR UPDATE` sobre el intent
- **Ownership Guard DB-level**: `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION 'OWNERSHIP_MISMATCH: ...'`

**1. `open_payment_intent(p_id UUID, p_intent_type TEXT, p_owner_ref TEXT, p_key_id UUID,
   p_buyer_wallet TEXT, p_seller_ref TEXT, p_pay_to TEXT, p_chain_id INT,
   p_authorized_usd NUMERIC, p_cap_signature TEXT, p_cap_nonce TEXT, p_expires_at TIMESTAMPTZ)`**
   → INSERT de la fila (el `id` lo genera el service con `crypto.randomUUID()`, se pasa
   como `p_id` — CD-1/CD-5). Para `session`: en la MISMA tx `PERFORM
   increment_a2a_key_spend(p_key_id, p_chain_id, p_authorized_usd)` (reserva del deposit;
   propaga `INSUFFICIENT_BUDGET`/`DAILY_LIMIT`/`KEY_INACTIVE`/`KEY_NOT_FOUND` → ROLLBACK
   total, la fila no persiste). Para `upto`: NO debita. Ownership: valida que `p_key_id`
   pertenece a `p_owner_ref` (SELECT `owner_ref FROM a2a_agent_keys WHERE id=p_key_id FOR
   UPDATE` → compara con `p_owner_ref`, `OWNERSHIP_MISMATCH` si difiere).

**2. `accumulate_payment_voucher(p_intent_id UUID, p_owner_ref TEXT, p_voucher_id TEXT,
   p_amount NUMERIC)` → RETURNS NUMERIC (consumed post-op)** — solo `session`.
   `SELECT ... FOR UPDATE` del intent; valida `status='open'` (si no → `RAISE
   'INTENT_NOT_OPEN'`) + owner. INSERT del voucher; si choca `UNIQUE(intent_id,voucher_id)`
   (23505) → NO incrementa, retorna `consumed_usd` actual (idempotente). Si es nuevo:
   `v_new := consumed_usd + p_amount`; **guard: si `v_new > authorized_usd` → clampa**
   (`v_new := authorized_usd`, el voucher se registra por su `amount` pero `consumed` no
   supera el deposit) — el settle nunca cobra > deposit. `UPDATE consumed_usd = v_new`.

**3. `close_payment_intent_for_settle(p_intent_id UUID, p_owner_ref TEXT, p_reported_usage
   NUMERIC)` → RETURNS record/tabla `(final_amount NUMERIC, prev_status TEXT, intent_type
   TEXT, key_id UUID, chain_id INT, pay_to TEXT, authorized_usd NUMERIC, consumed_usd NUMERIC)`**
   — `FOR UPDATE`; owner guard. **Transición `open→closing` (idempotencia del settle,
   AC-1)**: si el status ya es `closing`/`settled`/`refunded`/`expired`/`failed` → NO
   re-transiciona, retorna `prev_status` = ese estado (el service NO re-settlea). Computa
   `final_amount` bajo lock: `session` → `LEAST(consumed_usd, authorized_usd)`; `upto` →
   `LEAST(authorized_usd, p_reported_usage)`. (`p_reported_usage` = 0/NULL para session.)

**4. `finalize_payment_intent(p_intent_id UUID, p_owner_ref TEXT, p_tx_hash TEXT,
   p_final_amount NUMERIC, p_residual NUMERIC, p_success BOOLEAN, p_error TEXT)` → RETURNS
   VOID/record** — `FOR UPDATE`; owner guard. Si `p_success`: `status='settled'`,
   `settle_tx_hash=p_tx_hash`, `residual_usd=p_residual`; **para `session` con `p_residual
   > 0` → `PERFORM refund_a2a_key_spend(key_id, chain_id, p_residual, p_owner_ref)`** en la
   MISMA tx (credit-back, AC-2). `upto` NO refunda (no reservó). Si `NOT p_success`:
   `status='failed'`, `error_message=p_error`, **NO refund, NO settle_tx_hash**.

> **[VERIFY-AT-IMPL R-1]:** el orden/tipos exactos de los args (`NUMERIC` vs `INT`, orden
> posicional) se confirman byte-a-byte contra el patrón `debit_session_and_parent` al
> generar `database.types.ts`. Si tenés que ajustar la firma, actualizá también el `_down`
> (los `DROP FUNCTION` llevan la firma exacta de tipos) y los call-sites del service.

### `_down` (Archivo #2)
```sql
BEGIN;
DROP FUNCTION IF EXISTS finalize_payment_intent(uuid, text, text, numeric, numeric, boolean, text);
DROP FUNCTION IF EXISTS close_payment_intent_for_settle(uuid, text, numeric);
DROP FUNCTION IF EXISTS accumulate_payment_voucher(uuid, text, text, numeric);
DROP FUNCTION IF EXISTS open_payment_intent(uuid, text, text, uuid, text, text, text, integer, numeric, text, text, timestamptz);
DROP TABLE IF EXISTS a2a_payment_vouchers;
DROP TABLE IF EXISTS a2a_payment_intents;
COMMIT;
```
(Ajustá las firmas de `DROP FUNCTION` a las reales tras R-1.)

---

## Diseño del Servicio (Archivo #3) — `src/services/payment-intent.ts`

Exports:
```ts
export const paymentIntentService = {
  openSession(input),        // → { intentId, expiresAt }   (crea + reserva deposit)
  addVoucher(input),         // → { accepted, consumedUsd, duplicate }  (idempotente)
  closeSession(intentId, ownerRef),        // → SettleOutcome  (SP-1)
  createUpto(input),         // → { intentId, expiresAt }   (verifica cap EIP-712, NO debita)
  settleUpto(intentId, ownerRef, reportedUsageUsd),  // → SettleOutcome (SP-2)
  expireStale(),             // → void   (AC-6: auto-settle + refund de vencidos)
  verifyCapSignature(typedData, signature),  // → `0x${string}`  (mirror delegation.verifyTypedData)
};
// SEAM WKH-136 (NO refactorizar — interfaz estable, ver abajo):
export async function settlePaymentIntentOnChain(params: {
  intentId: string; ownerRef: string; payTo: string; finalAmountUsd: number; chainId: number;
}): Promise<SettleOutcome>;
```

### `settlePaymentIntentOnChain` — helper compartido (SP-1/SP-2, seam WKH-136)
**CRÍTICO: `closeSession` y `settleUpto` DEBEN ambos delegar el on-chain settle a esta
única función.** Es el punto que WKH-136 va a envolver para meter splits bps. NO dupliques
la lógica sign/settle/verify en cada método.

Flujo interno (espejo de `fee-charge.ts` `chargeProtocolFee` L256-345):
1. USD → wei: `feeUsdcToWei` pattern = `String(BigInt(Math.round(finalAmountUsd * 1e6)) *
   BigInt(1e12))`. **[VERIFY-AT-IMPL R-3]** confirmá los decimals del token de cada chain
   antes de asumir 1e12 (compose.ts:188 usa el mismo; si el token de la chain no es 6→18,
   ajustá).
2. `signResult = await getPaymentAdapter().sign({ to: payTo as \`0x${string}\`, value: wei });`
   — wrap en try/catch; error → `{ status:'failed' }` (CD-7, nunca rechazar).
3. `settleResult = await getPaymentAdapter().settle({ authorization, signature, network: paymentRequest.network ?? '' });`
   — `!settleResult.success` → `{ status:'failed' }`.
4. **`verifyDefaultChainSettle({ txHash: settleResult.txHash, payTo, requiredAmountAtomic:
   BigInt(wei) })` ANTES de marcar settled (CD-5)**:
   - `.warn === true` → `log.warn` (RPC_UNAVAILABLE, fail-OPEN, confiar en facilitator).
   - `.ok === false` → `{ status:'failed' }` (contradicción definitiva, fail-CLOSED). NO settled, NO refund.
5. Retorna `{ status:'settled', txHash, finalAmountUsd }` (el caller — closeSession/settleUpto
   — llama a `finalize_payment_intent` con el resultado y computa el residual para session).

### Reglas money-path del servicio (heredan de fee-charge.ts)
- **CD-7**: NINGÚN método de settle rechaza la promise. Todo error → objeto
  `{ status:'failed', error }` + best-effort mark failed vía `finalize_payment_intent(..., p_success=false)`.
- **CD-6**: montos comparados/computados en **micro-USD entero**. Reusá el patrón
  `decimalStringToMicroUsd` de delegation.ts (es privada allá — **replicá el helper puro
  en payment-intent.ts**, NO lo importes si no está exportado; verificá con
  `grep "export.*decimalStringToMicroUsd" src/services/delegation.ts` — hoy NO está
  exportada, así que copiá el helper puro). El residual: `residualMicro = Math.max(0,
  depositMicro − consumedMicro)`; nunca negativo (AC-2).
- **CD-2**: todo método recibe `ownerRef` (tipo `string`, NO `string | undefined`) y lo
  pasa como `p_owner_ref` al RPC. Ninguna query/RPC de estado de pago sin owner guard.
- Mapeo de errores PG por prefijo (patrón budget.ts L377-390), nunca msg crudo.

### `verifyCapSignature` (upto) — mirror de `delegation.ts` `verifyTypedData`
- `buildUptoDomain()`: `{ name: process.env.UPTO_EIP712_NAME ?? 'WasiAI-a2a Upto', version:
  process.env.UPTO_EIP712_VERSION ?? '1', chainId: Number(process.env.KITE_CHAIN_ID) }`
  (espejo exacto de `buildDomain()` en delegation.ts L53-59).
- **Domain binding ANTES del recover**: comparar `typedData.domain.{name,version,chainId}`
  contra `serverDomain`; si difiere → throw (rechazo → 400 `CAP_SIGNATURE_INVALID`).
- `UPTO_TYPES` con `as const` (espejo `DELEGATION_TYPES` L67-81). **[VERIFY-AT-IMPL R-2]**
  confirmá el struct exacto contra viem al implementar. Struct propuesto:
  ```ts
  const UPTO_TYPES = {
    UptoCap: [
      { name: 'seller_ref', type: 'string' },
      { name: 'cap',        type: 'string' },   // decimal USD como string (sin float64)
      { name: 'chain_id',   type: 'uint256' },
      { name: 'nonce',      type: 'bytes32' },
      { name: 'expires_at', type: 'uint64' },
    ],
  } as const;
  ```
- `recovered = await recoverTypedDataAddress({ domain, types: UPTO_TYPES, primaryType:
  'UptoCap', message, signature })`. **El firmante DEBE ser el `funding_wallet` de la key**
  (ancla EXCLUSIVA, CD-11 de delegation): comparar `recovered.toLowerCase() ===
  keyRow.funding_wallet` (que ya viene lowercase). Si no matchea → throw.

---

## Diseño de las Rutas (Archivo #5) — `src/routes/payments.ts`

Estructura: `export const paymentsRoutes: FastifyPluginAsync = async (fastify) => { ... }`
(espejo `keySessionRoutes` en key-session.ts).

Para cada endpoint:
1. **Auth**: `const callerKey = await resolveCallerKey(req);` (importado de
   `./auth/parsers.js`). `if (!callerKey?.is_active) return reply.status(403).send({ error:
   'Invalid or inactive API key' });`. `ownerRef = callerKey.owner_ref`.
2. **Write-boundary validation (CD-12)**: TODO monto (`depositUsd`, `capUsd`, `amountUsd`,
   `reportedUsageUsd`) → `if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return
   reply.status(422).send({ error_code: 'INVALID_INPUT' });`. Campos requeridos faltantes
   → 422. Usá `Number.isFinite` (rechaza NaN + Infinity, patrón fee-charge L108-109).
3. **`intentId` server-side**: `const intentId = crypto.randomUUID();` (CD-1/CD-5, NUNCA un
   id del cliente).
4. **`buyer_wallet` (upto)**: `callerKey.funding_wallet` (para la verificación del cap). Si
   `createUpto` y `funding_wallet == null` → 400 (no se puede anclar la firma).
5. Llamar el service; mapear errores del `SettleOutcome`/error string a HTTP (tabla de
   errores arriba). Nunca `throw` msg crudo.
6. **Schema Fastify** (opcional pero recomendado, patrón orchestrate.ts L57-71): validar
   shape básico (`required`, `type`) además del guard programático.

Endpoints exactos: `POST /session`, `POST /session/:id/voucher`, `POST /session/:id/close`,
`POST /upto`, `POST /upto/:id/settle`. (El prefijo `/payments` lo pone `index.ts`.)

---

## Exemplars

### Exemplar 1: settle idempotente + verify on-chain + CD-B
**Archivo:** `src/services/fee-charge.ts` (L163-354 `chargeProtocolFee`, L133-135 `feeUsdcToWei`).
**Usar para:** `settlePaymentIntentOnChain`, `closeSession`, `settleUpto`.
**Patrón clave:**
- Todo el cuerpo del settle wrapeado en `try/catch` externo → `{ status:'failed' }` (CD-B/CD-7).
- `sign()` en try/catch propio, `settle()` en try/catch propio, cada uno → markFailed + return.
- `verifyDefaultChainSettle({ txHash, payTo, requiredAmountAtomic: BigInt(wei) })`; `.warn`
  → log.warn + continuar; `.ok===false` → markFailed + return failed.
- `feeUsdcToWei`: `String(BigInt(Math.round(usd * 1e6)) * BigInt(1e12))`.
- `markFailed` best-effort (no propaga error del UPDATE).
- `PG_UNIQUE_VIOLATION = '23505'` para detectar idempotencia/race.

### Exemplar 2: EIP-712 cap firmado anclado a funding_wallet
**Archivo:** `src/services/delegation.ts` (L50-81 domain+types, L124-166 `verifyTypedData`).
**Usar para:** `verifyCapSignature`, `buildUptoDomain`, `UPTO_TYPES`, `decimalStringToMicroUsd`.
**Patrón clave:**
- `buildDomain()` lee env con `?? default`, `chainId: Number(process.env.KITE_CHAIN_ID)`.
- Types con `as const`; NO incluir `EIP712Domain` en `types` (viem lo infiere).
- Domain binding (`typedData.domain.name/version/chainId === serverDomain.*`) ANTES del recover.
- `recoverTypedDataAddress` de `viem` (CD-8: viem only, PROHIBIDO ethers).
- Firmante == `funding_wallet` (ancla exclusiva, CD-11).
- `decimalStringToMicroUsd` (L112-120): parse decimal string → micro-USD entero sin float64.
  **Está privada — copiá el helper puro tal cual en payment-intent.ts.**

### Exemplar 3: RPC atómico con FOR UPDATE + Ownership Guard DB-level
**Archivo:** `supabase/migrations/20260603000000_a2a_key_sessions.sql` (L28-96).
**Usar para:** los 4 RPC del Archivo #1 + el `_down` (Archivo #2).
**Patrón clave:**
- `SELECT ... INTO ... FROM ... WHERE id=... FOR UPDATE;` + `IF NOT FOUND THEN RAISE`.
- Ownership Guard: `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION
  'OWNERSHIP_MISMATCH: ...'`.
- Re-check de estado bajo lock (TOCTOU-safe).
- `PERFORM increment_a2a_key_spend(...)` para debitar (session deposit) — propaga
  INSUFFICIENT_BUDGET vía RAISE → ROLLBACK.
- Hardening: `SECURITY DEFINER`, `SET search_path=public,pg_temp`, `REVOKE ... FROM PUBLIC,
  anon, authenticated`, `GRANT ... TO service_role`.
- `_down`: `BEGIN; DROP FUNCTION IF EXISTS <nombre>(<tipos exactos>); DROP TABLE IF EXISTS ...; COMMIT;`

### Exemplar 4: tabla con owner_ref + ledger append-only + credit-back
**Archivo:** `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` (owner_ref,
CHECK, UNIQUE de idempotencia) + `refund_a2a_key_spend` (buscá la migración
`20260625000000_wkh_audit_a2_refund_rows_affected.sql` L30+ para la firma:
`refund_a2a_key_spend(p_key_id uuid, p_chain_id integer, p_amount_usd numeric, p_owner_ref text)`).
**Usar para:** las 2 tablas nuevas + la llamada a `refund_a2a_key_spend` en `finalize_payment_intent`.

### Exemplar 5: ruta con auth + owner_ref + shape
**Archivo:** `src/routes/auth/key-session.ts` (todo) + `src/routes/orchestrate.ts` (L57-90:
schema + `crypto.randomUUID()`).
**Usar para:** `src/routes/payments.ts`.
**Patrón clave:**
- `FastifyPluginAsync`, `resolveCallerKey(req)`, `callerKey.owner_ref`, `callerKey.is_active`.
- Error mapping por error class/code → `reply.status(N).send({ error_code })`.
- Nunca loguear ni devolver `err.message` crudo (`errorClass: err.constructor.name`).

### Exemplar 6: reuso de budget debit/credit
**Archivo:** `src/services/budget.ts` (L364-403 `credit` → `refund_a2a_key_spend`; L78-102
firma de `debit`).
**Usar para:** entender el shape del retorno (`{ success, error?, reverted? }`) y el mapeo
de errores por prefijo (L377-390). Para el deposit `session` la reserva se hace **dentro
del RPC `open_payment_intent`** (vía `increment_a2a_key_spend`), NO llamando `budgetService.debit`
desde el service (para que sea atómico con el INSERT del intent).

---

## Constraint Directives (checklist INVIOLABLE — copiados del SDD §5)

### OBLIGATORIO
- **CD-1**: idempotencia del settle por la **PK del intent (UUID via `crypto.randomUUID()`
  server-side)**, nunca un id del cliente.
- **CD-2**: Ownership Guard `owner_ref` en TODA tabla/query/RPC nueva — desnormalizado en la
  fila + validado DB-level (`OWNERSHIP_MISMATCH` bajo `FOR UPDATE`). Firmas de service con
  `ownerRef: string` (NO `undefined`).
- **CD-3**: idempotencia de vouchers por `UNIQUE(intent_id, voucher_id)` + del settle por
  transición de status bajo lock.
- **CD-5**: `verifyDefaultChainSettle` ANTES de marcar `settled`; contradicción definitiva →
  `failed`.
- **CD-6**: montos en **micro-USD entero** (`decimalStringToMicroUsd`), nunca `parseFloat`
  lossy para `min(cap,uso)` ni `residual`.
- **CD-7**: el settle NUNCA rechaza la promise; todo error → `{ status:'failed' }` +
  markFailed best-effort.
- **CD-8**: `viem` only (`recoverTypedDataAddress`); PROHIBIDO ethers.js.
- **CD-9** (Auto-Blindaje WKH-133): acumulación idempotente con `.upsert(row, { onConflict:
  '...', ignoreDuplicates: true }).select()` — **NO existe `.insert().onConflict()`
  encadenado** en supabase-js v2. Si usás JS para el voucher, `claimed.length===0` ⇒ ya
  reclamado. (En este diseño el voucher se inserta DENTRO del RPC; el 23505 lo maneja
  plpgsql. Si en algún punto insertás desde JS, aplicá esto.)
- **CD-10** (Auto-Blindaje WKH-134/133): con `exactOptionalPropertyTypes: true`, objetos
  tipados con **asignación condicional** (`if (x!==undefined) obj.x = x`), NUNCA `x: cond ?
  v : undefined`.
- **CD-11** (Auto-Blindaje WKH-133): todo `await` de lectura on-chain /
  `waitForTransactionReceipt` en try/catch — **timeout THROWS**, no retorna. (Aplica a lo
  que envuelva `verifyDefaultChainSettle`, aunque esa fn ya es no-throw.)
- **CD-12** (Auto-Blindaje WKH-134/142, money-path): validar TODO monto money-path en el
  **write-boundary** (422 si no es `number` finito `>= 0`) Y clampear en el **read-boundary**
  (`CHECK (>= 0)` en DB + parse defensivo).
- **CD-13** (Auto-Blindaje WKH-133): `BigInt(x)` sobre valores de DB/JSON (wei, nonces) en
  try/catch cuando el contrato exige no-throw.

### PROHIBIDO
- **CD-P1**: PROHIBIDO modificar `charge` (x402) o los paths de débito
  master/delegación/key-session. Código 100% aditivo. Validar cero regresión corriendo
  `orchestrate.billing.test.ts` + `money-path.concurrency.test.ts` +
  `money-path.resilience.test.ts`.
- **CD-P2**: PROHIBIDO inventar semántica de firma más allá de lo ratificado (SG-1/SG-2). El
  struct EIP-712 del cap está en R-2 (confirmar contra viem, no reinventar).
- **CD-P3**: PROHIBIDO reutilizar `a2a_key_sessions` (auth efímero) para estado de pago.
- **CD-P4**: PROHIBIDO hardcodear domain/wallet/token/chain — todo de env (`UPTO_EIP712_NAME/
  VERSION`, `KITE_CHAIN_ID`, `getPaymentAdapter()`, `PAYMENT_INTENT_TTL_SECONDS`).
- **CD-P5**: PROHIBIDO un id de billing que controle el cliente como clave única.
- **CD-P6**: PROHIBIDO `any`/`as unknown` (TS strict) y non-null assertion (biome). Usá `??
  null`/`?? default`.
- **CD-P7**: PROHIBIDO modificar archivos fuera de la tabla "Files to Create/Modify". **NO
  tocar el dir de WKH-136 (`doc/sdd/138-*`).**

---

## Anti-Hallucination Checklist (esta HU)

Verificados por el Architect (Glob/Read/Grep). Dev: si alguno NO matchea en runtime, PARÁ.

| Símbolo / path | Estado | Nota |
|----------------|--------|------|
| `src/services/fee-charge.ts` → `chargeProtocolFee`, `feeUsdcToWei` | ✅ existe | exemplar settle |
| `src/services/budget.ts` → `budgetService.credit` (→ `refund_a2a_key_spend`), `.debit` | ✅ existe | firma `credit(keyId, chainId, amountUsd, ownerRef)` |
| `src/services/delegation.ts` → `buildDomain`, `DELEGATION_TYPES`, `verifyTypedData`, `decimalStringToMicroUsd` | ✅ existe | `decimalStringToMicroUsd` es **privada** → copiar helper puro |
| `src/adapters/settle-verifier.ts` → `verifyDefaultChainSettle({txHash, payTo, requiredAmountAtomic})` | ✅ exportada | retorna `{ ok, reason, warn }` |
| `src/adapters/registry.ts` → `getPaymentAdapter()` | ✅ existe | `.sign({to,value})` / `.settle({authorization,signature,network})` |
| `src/routes/auth/parsers.ts` → `resolveCallerKey(req)` | ✅ exportada | retorna `A2AAgentKeyRow | null` con `.owner_ref`, `.is_active`, `.funding_wallet` |
| `A2AAgentKeyRow.funding_wallet` | ✅ `string | null` | ancla del cap upto |
| RPC `increment_a2a_key_spend` | ✅ existe | reusar en `open_payment_intent` (session deposit) |
| RPC `refund_a2a_key_spend(uuid, integer, numeric, text)` | ✅ existe | reusar en `finalize_payment_intent` (residual) |
| `trigger_set_updated_at` | ⚠️ **[VERIFY-AT-IMPL]** | confirmar nombre exacto en `20260421015829_a2a_protocol_fees.sql` |
| `a2a_payment_intents` / `a2a_payment_vouchers` | ❌ NO existen | **se crean** (Archivo #1) |
| Prefijo `/payments` en `index.ts` | ✅ libre | registrar en L143-177 |
| **R-1** firma exacta de los 4 RPC | 🔶 confirmar en F3 | contra `debit_session_and_parent`, al generar `database.types.ts` |
| **R-2** struct EIP-712 `UptoCap` | 🔶 confirmar en F3 | contra viem, espejo `DELEGATION_TYPES` |
| **R-3** conversión USD→wei | 🔶 confirmar en F3 | `BigInt(Math.round(usd*1e6))*BigInt(1e12)` (compose.ts:188) vs decimals del token de cada chain |

---

## Test Expectations (13 tests — ≥1 por AC + money-path)

| Test | ACs/Riesgo | Archivo | Cobertura |
|------|-----------|---------|-----------|
| **T-AC1** doble-cobro close | AC-1 | `payment-intent.test.ts` | 2 closes del mismo `intentId` → `settle()` llamado **1 sola vez** (2º ve `settled`/`closing`, no re-settlea) |
| **T-AC2** refund residual | AC-2 | `payment-intent.test.ts` | deposit=10, Σvouchers=3.7 → settle 3.7 al seller + `refund_a2a_key_spend` 6.3 al Buyer. Micro-USD exacto, sin off-by-one |
| **T-AC2b** residual 0/negativo | AC-2/CD-6 | `payment-intent.test.ts` | consumed==deposit → residual 0, NO refund; consumed>deposit (clamp) → residual 0, nunca negativo |
| **T-AC3** cap inviolable | AC-3 | `payment-intent.test.ts` | cap=5, uso=8 → cobra `min=5` + `cappedAt:true`; cap=5, uso=2 → cobra 2. NUNCA > cap |
| **T-AC4** owner guard (IDOR) | AC-4/CD-2 | `payment-intent.test.ts` + `payments.test.ts` | caller B intenta close/voucher/settle un intent de A → `OWNERSHIP_MISMATCH`/403; el tipo del service exige `ownerRef: string` (compila-guard) |
| **T-AC5** literal APP | AC-5 | `payments.test.ts` | request/response usan `"session"`/`"upto"` literales |
| **T-AC6** expiry | AC-6 | `payment-intent.test.ts` | intent vencido → `expireStale()` auto-settlea consumido + refund residual; no queda `open` con fondos retenidos |
| **T-SIG** firma del cap | Firma/replay | `payment-intent.test.ts` | firma válida (firmante==funding_wallet) → crea; firma de otra wallet / domain distinto / **nonce reusado** → rechazo, intent NO creado |
| **T-VCHR** voucher idempotente | CD-3/CD-9 | `payment-intent.test.ts` | mismo `voucherId` 2× → `consumed` incrementa **1 sola vez** (23505/upsert ignoreDuplicates) |
| **T-VERIFY** settle on-chain | CD-5 | `payment-intent.test.ts` | `settle()` success pero `verifyDefaultChainSettle.ok===false` → `failed`, NO `settled`, NO refund. `.warn===true` (RPC_UNAVAILABLE) → fail-OPEN + warn |
| **T-CONC** concurrencia | Race | `payment-intent.test.ts` | 2 closes concurrentes / 2 vouchers concurrentes → serializados por `FOR UPDATE`, sin doble efecto (patrón `money-path.concurrency.test.ts`) |
| **T-WRITE** guard money-path | CD-12 | `payments.test.ts` | `depositUsd`/`capUsd`/`amountUsd`/`reportedUsageUsd` negativo / NaN / no-number → 422, intent/voucher NO creado |
| **T-REGR** no-regresión | CD-P1 | (suite existente) | correr `orchestrate.billing.test.ts` + `money-path.concurrency.test.ts` + `money-path.resilience.test.ts` sin cambios → verde |

Framework: **vitest** (mismo que `fee-charge.test.ts`). Test-first para toda la lógica de
negocio/settlement.

---

## Waves

### Wave 0 (Serial Gate — contratos/tipos/DB, completar ANTES de W1)
- [ ] **W0.1**: Migración `20260704000000_wkh135_payment_intents.sql` + `_down` — 2 tablas +
  4 RPC + RLS + trigger + hardening. Exemplar 3+4. **Verificación: la migración parsea
  (revisá sintaxis SQL); `_down` con firmas exactas.**
- [ ] **W0.2**: Tipos en `src/types/index.ts` (`PaymentIntentRow`, `PaymentVoucherRow`,
  `UptoCapTypedData`, `UptoEip712Domain`, DTOs, `SettleOutcome`) + `database.types.ts` (rows
  + `Args`/`Returns` de los 4 RPC). **[VERIFY-AT-IMPL R-1].** Verificación: `tsc --noEmit`.

### Wave 1 (Parallelizable — lógica del servicio)
- [ ] **W1.1**: `payment-intent.ts` — EIP-712 (`verifyCapSignature`, `UPTO_TYPES`,
  `buildUptoDomain`, helper `decimalStringToMicroUsd` copiado). Exemplar 2. **[R-2].**
- [ ] **W1.2**: `payment-intent.ts` — `openSession` / `addVoucher` / `createUpto` (consumen
  RPCs W0, mapeo de errores por prefijo). Exemplar 6 + 3.
- [ ] **W1.3**: `payment-intent.ts` — `settlePaymentIntentOnChain` (seam §WKH-136) +
  `closeSession` / `settleUpto` / `expireStale`. Exemplar 1. **[R-3].**
- Verificación W1: `tsc --noEmit` + `biome check src/`.

### Wave 2 (Depende de W0+W1 — rutas)
- [ ] **W2.1**: `src/routes/payments.ts` — 5 endpoints + `resolveCallerKey` +
  write-boundary (CD-12) + `crypto.randomUUID()` + mapeo de errores. Exemplar 5.
- [ ] **W2.2**: `src/index.ts` — `await fastify.register(paymentsRoutes, { prefix:
  '/payments' });`.

### Wave 3 (Final — tests + verificación)
- [ ] **W3.1**: `payment-intent.test.ts` + `payments.test.ts` (13 tests).
- [ ] **W3.2**: correr suite money-path existente (CD-P1) + `tsc --noEmit` + `biome check` →
  todo verde.

### Verificación Incremental
| Wave | Verificación |
|------|--------------|
| W0 | SQL parsea + `tsc --noEmit` pasa |
| W1 | `tsc --noEmit` + `biome` pasan |
| W2 | `tsc` + `biome` + arranca fastify sin error de registro |
| W3 | 13 tests verdes + suite money-path existente verde + full QA |

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- `src/middleware/x402.ts`, `src/routes/compose.ts`, `src/routes/orchestrate.ts` (core),
  `src/services/fee-charge.ts`, `src/services/budget.ts`, `src/services/delegation.ts`,
  `src/adapters/settle-verifier.ts` — se **consumen**, no se editan.
- `a2a_key_sessions` / `key-session.ts` — concepto de auth distinto (SG/CD-P3).
- Splits bps (WKH-136) — solo dejás el seam `settlePaymentIntentOnChain`, NO lo implementás
  con splits. **NO tocar `doc/sdd/138-*`.**
- Bridge APP (WKH-141), escrow/disputas (WKH-139), IM/QR (WKH-137), embedded wallet
  (WKH-138), UI/dashboard.
- NO "mejorar" código adyacente. NO agregar dependencias nuevas (viem/supabase/fastify ya
  están).

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala al Architect. No inventar, no
> asumir, no improvisar.**

Situaciones de escalation:
- La firma real de un RPC (R-1) no encaja con lo asumido y rompe el `_down` o los call-sites.
- El struct EIP-712 (R-2) no valida contra viem con el shape propuesto.
- La conversión USD→wei (R-3) difiere por decimals del token de alguna chain.
- `trigger_set_updated_at` tiene otro nombre en la migración de fees.
- Un import necesario no está disponible / un exemplar cambió.
- Se necesita tocar un archivo fuera de la tabla "Files to Create/Modify".

---

*Story File generado por NexusAgil — F2.5. Money-path QUALITY. Seam `settlePaymentIntentOnChain`
es interfaz estable para WKH-136.*
