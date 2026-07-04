# SDD #137: [WKH-135] Intents de pago `session` (metered) + `upto` (cap dual-firmado)

> SPEC_APPROVED: no
> Fecha: 2026-07-03
> Tipo: feature (money-path)
> SDD_MODE: full (QUALITY)
> Branch: feat/137-wkh-135-payment-intents-session-upto
> Artefactos: doc/sdd/137-wkh-135-payment-intents-session-upto/

---

## 1. Resumen

Se agregan **dos intents de pago nuevos** al money-path de wasiai-a2a, nombrados de
forma compatible con el Agent Payments Protocol (APP) de OKX:

- **`session`** (metered / streaming): el Buyer abre una sesión de pago con un
  *deposit* (reserva contra su budget prepago de Agent Key). Durante la sesión se
  acumulan **vouchers** de uso (append-only, idempotentes por `voucher_id`). Al
  **cierre** se hace **UN solo settle on-chain** del total consumido al Seller y se
  **refundea el residual** (`deposit − Σvouchers`) al Buyer.
- **`upto`** (cap dual-firmado): el Buyer **firma un cap** de gasto (EIP-712,
  anclado a su `funding_wallet`, espejo de `delegation.ts`). El Seller reporta el
  uso real. El settle cobra exactamente **`min(cap, uso)`** y **nunca** más que el
  cap firmado.

Ambos reutilizan la infra existente de settle multi-chain
(`getPaymentAdapter().sign()/.settle()` + `verifyDefaultChainSettle`), el patrón de
idempotencia DB de `fee-charge.ts` (`a2a_protocol_fees`), y el Ownership Guard
`owner_ref` documentado en `CLAUDE.md`. **No se toca** el intent `charge` (x402) ni
los paths de débito master/delegación/key-session existentes.

Esta HU **desbloquea WKH-141** (bridge APP) y define **dos nuevos settle points**
(SP-1 `session close`, SP-2 `upto settle`) que **WKH-136 (splits) construirá encima**
— documentados abajo como interfaz estable (§4.9).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 137 |
| **Tipo** | feature (money-path) |
| **SDD_MODE** | full |
| **Objetivo** | Agregar los intents `session` (metered) y `upto` (cap dual-firmado) con settle único, idempotencia real y refund del residual, sin regresión en `charge`. |
| **Reglas de negocio** | AC-1..AC-6 (ver abajo). Money invariants: cero doble-cobro, residual correcto, `min(cap,uso)` inviolable, firmas EIP-712 verificadas, Ownership Guard en todo estado nuevo. |
| **Scope IN** | Modelo de datos (tabla nueva + ledger), servicio, EIP-712 del cap `upto`, endpoints `/payments/*`, idempotencia + refund, tests. |
| **Scope OUT** | Bridge APP (WKH-141), splits bps (WKH-136), intent `escrow`/disputas (WKH-139), IM/QR (WKH-137), embedded wallet (WKH-138), UI/dashboard. |
| **Missing Inputs** | 3 forks de producto para el SPEC gate (§10, tabla SPEC-GATE) — cada uno con PROPUESTA concreta a ratificar. |

### Acceptance Criteria (EARS)

- **AC-1** — WHEN un intent `session` se cierra, THE system SHALL settlear **exactamente
  una vez** por intent usando la PK del intent (UUID server-side) como clave de
  idempotencia (mismo patrón que `a2a_protocol_fees.orchestration_id`), de modo que un
  retry del cierre NUNCA produzca un segundo cobro.
- **AC-2** — WHEN un intent `session` completa su settlement, THE system SHALL calcular
  y **creditar el residual** (`residual = deposit − Σvouchers_settled`) al budget del
  Buyer, sin retener fondos no consumidos.
- **AC-3** — WHEN un intent `upto` se settlea, THE system SHALL cobrar exactamente
  **`min(cap, uso_reportado)`** y NUNCA un monto mayor al cap firmado por el Buyer,
  independientemente del uso que reporte el Seller.
- **AC-4** — WHILE cualquier estado intermedio de `session`/`upto` persiste, THE system
  SHALL aplicar el Ownership Guard `owner_ref` (patrón `CLAUDE.md` / WKH-53) en toda
  tabla/query/RPC nueva, sin excepción.
- **AC-5** — IF los identificadores de intent se exponen en superficie pública
  (request/response, Agent Card), THEN THE system SHALL usar los strings literales
  `"session"`/`"upto"` compatibles con APP (no un nombre interno arbitrario).
- **AC-6** — IF un flujo `session`/`upto` queda a medio camino (deposit hecho pero
  nunca cerrado; cap autorizado pero uso nunca reportado) por más de una ventana
  configurable (`expires_at`), THEN THE system SHALL resolverlo de forma determinística
  (**expiry → auto-settle del consumido + refund del residual**), sin retener fondos
  indefinidamente.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/fee-charge.ts` | Patrón canónico de settle + idempotencia DB | Tabla PK única (`a2a_protocol_fees.orchestration_id`), estados `pending→charged\|failed\|skipped`, INSERT pending → 23505 = already-in-progress, `sign()`+`settle()`, `verifyDefaultChainSettle` ANTES de marcar charged, CD-B "jamás rechazar la promise", `markFailed` best-effort |
| `src/services/budget.ts` | Débito/crédito atómico + Ownership Guard | `debit(...)` con `ownerRef: string` REQUERIDO; `credit(keyId, chainId, amountUsd, ownerRef)` → RPC `refund_a2a_key_spend` (FOR UPDATE, `reverted = data>=1`); `registerDeposit(...)` anti-replay `UNIQUE(chain_id, tx_hash)`; mapeo de errores PG por prefijo, nunca propaga msg crudo |
| `src/services/delegation.ts` | EIP-712 cap firmado por el owner (análogo directo de `upto`) | `DELEGATION_TYPES` (`as const`, typehash derivado por viem), `buildDomain()` lee env (`DELEGATION_EIP712_NAME/VERSION`, `KITE_CHAIN_ID`), `verifyTypedData()` valida domain binding ANTES de `recoverTypedDataAddress`, ancla = `funding_wallet` (CD-11), `exceedsPerTxLimit`/`decimalStringToMicroUsd` (comparación de montos en micro-USD entero, sin float64) |
| `src/services/signed-auth.ts` | EIP-712 request-scoped + anti-replay | `recoverTypedDataAddress` server-side, domain de env con default, anti-replay `INSERT ... UNIQUE(token_hash,nonce)` → 23505 = replay, orden timestamp→firma→nonce, NUNCA throw en verify |
| `src/adapters/escrow/eip712.ts` | Struct EIP-712 de autorización de débito con montos atómicos | `DebitAuthorization` (`keyId`,`amount uint256`,`deadline uint256`,`nonce uint256`), `buildDebitDomain` con `verifyingContract`, recover de sanity off-chain, `[VERIFY-AT-IMPL]` para la forma exacta del struct |
| `src/adapters/settle-verifier.ts` | Re-verificación on-chain del settle (CD-5) | `verifyDefaultChainSettle({txHash, payTo, requiredAmountAtomic})` → `{ok, reason, warn}`; fail-OPEN en `RPC_UNAVAILABLE`, fail-CLOSED en contradicción definitiva; kill-switch `SETTLE_VERIFY_ONCHAIN` |
| `src/adapters/types.ts` | Interface del PaymentAdapter | `sign({to, value})→SignResult`, `settle({authorization, signature, network})→SettleResult{txHash, success, error}`, `ChainKey`, `AdaptersBundle` |
| `supabase/migrations/20260603000000_a2a_key_sessions.sql` | Colisión de naming + patrón RPC atómico | Tabla `a2a_key_sessions` (auth efímero, WKH-121); RPC `debit_session_and_parent` con `FOR UPDATE`, Ownership Guard DB-level (`OWNERSHIP_MISMATCH`), `SECURITY DEFINER` + `SET search_path` + `REVOKE/GRANT service_role` |
| `supabase/migrations/20260421015829_a2a_protocol_fees.sql` | Tabla de idempotencia de settle | PK única, `CHECK status IN (...)`, índices por status/created_at, trigger `trigger_set_updated_at` |
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` | Ledger append-only + tabla con owner_ref (patrón para vouchers) | `owner_ref TEXT NOT NULL`, `CHECK (max_usd >= 0)`, `UNIQUE(key_id, destination)` como target de upsert idempotente, índice `(key_id, owner_ref)` |
| `supabase/migrations/20260607000000_wkh_sec02_rls.sql` | RLS deny-by-default | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` sin policy → deny-all para anon/authenticated; service_role bypassa por BYPASSRLS |
| `src/routes/orchestrate.ts` | Server-side ID gen + quote→approve→execute | `crypto.randomUUID()` para el id de billing (L90/197/345), NUNCA un id que manda el cliente |
| `src/index.ts` | Registro de rutas | `fastify.register(routes, { prefix: '/x' })`; prefijo `/payments` está libre |

### Exemplars verificados (Glob/Read confirmados)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/services/payment-intent.ts` (nuevo) | `src/services/fee-charge.ts` + `src/services/budget.ts` | Settle único idempotente + refund residual + mapeo de errores PG |
| EIP-712 del cap `upto` (en `payment-intent.ts` o módulo) | `src/services/delegation.ts` (`DELEGATION_TYPES`, `verifyTypedData`, `buildDomain`) | Cap firmado por el owner, anclado a `funding_wallet`, domain binding |
| `supabase/migrations/20260704000000_wkh135_payment_intents.sql` (+ `_down`) | `20260603000000_a2a_key_sessions.sql` + `20260606000000_a2a_key_spend_policies.sql` | Tabla + ledger + RPC atómico con FOR UPDATE + Ownership Guard + RLS + hardening |
| `src/routes/payments.ts` (nuevo) | `src/routes/auth/key-session.ts` + `src/routes/orchestrate.ts` | Route con auth middleware, `crypto.randomUUID()` server-side, `request.a2aKeyRow.owner_ref` |
| `src/services/payment-intent.test.ts` (nuevo) | `src/services/fee-charge.test.ts` + `src/services/money-path.concurrency.test.ts` | Cobertura money-path: doble-cobro, refund, cap, firmas |

### Estado de BD relevante

| Tabla | Existe | Notas |
|-------|--------|-------|
| `a2a_agent_keys` | Sí | Fuente del `funding_wallet` (ancla EIP-712) y del budget prepago; owner_ref |
| `a2a_key_sessions` | Sí | **NO tocar** — auth efímero (WKH-121), concepto distinto (ver §4.4 naming) |
| `a2a_protocol_fees` | Sí | Exemplar de idempotencia; no se reutiliza, se replica el patrón |
| `a2a_payment_intents` | **No** | **Se crea** (§4.2) |
| `a2a_payment_vouchers` | **No** | **Se crea** (§4.2) |

### Componentes reutilizables encontrados (reusar, NO clonar)

- `getPaymentAdapter().sign()/.settle()` — settle multi-chain (Kite/Avalanche/Base).
- `verifyDefaultChainSettle(...)` — re-verificación on-chain (CD-5).
- `budgetService.debit(...)` / `budgetService.credit(...)` — reserva del deposit y refund del residual (atómicos, con owner guard).
- `decimalStringToMicroUsd(...)` (delegation.ts) — comparación de montos sin float64 (para `min(cap,uso)` y `residual`).
- `recoverTypedDataAddress` (viem) — verificación de la firma del cap.
- `trigger_set_updated_at` (migración tasks) — reusar en las tablas nuevas.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260704000000_wkh135_payment_intents.sql` | Crear | 2 tablas + 4 RPC atómicos + RLS + hardening | `20260603000000_a2a_key_sessions.sql` |
| `supabase/migrations/20260704000000_wkh135_payment_intents_down.sql` | Crear | DROP reversible de RPCs + tablas | `20260603000000_a2a_key_sessions_down.sql` |
| `src/services/payment-intent.ts` | Crear | Servicio: open/accumulate/close/settle + EIP-712 cap `upto` + refund | `fee-charge.ts`, `delegation.ts`, `budget.ts` |
| `src/services/payment-intent.test.ts` | Crear | Tests money-path (≥1 por AC) | `fee-charge.test.ts` |
| `src/routes/payments.ts` | Crear | Endpoints `/payments/session/*`, `/payments/upto/*` | `routes/auth/key-session.ts` |
| `src/routes/payments.test.ts` | Crear | Tests de rutas (auth, owner guard, shape) | `routes/agents.ownership.test.ts` |
| `src/types/index.ts` | Modificar | Tipos `PaymentIntentRow`, `PaymentVoucherRow`, `UptoCapTypedData`, DTOs | tipos existentes de delegation/session |
| `src/types/database.types.ts` | Modificar | Row types + Args de los 4 RPC nuevos | rows/RPC existentes |
| `src/index.ts` | Modificar | `register(paymentsRoutes, { prefix: '/payments' })` | L143-165 |

**Cero** modificaciones a `x402.ts`, `compose.ts`, `orchestrate.ts` (core), `fee-charge.ts`, `budget.ts` (se **consumen**, no se editan salvo que un AR lo exija).

### 4.2 Modelo de datos (tabla nueva + ledger)

**Tabla `a2a_payment_intents`** — una fila por intent (session **o** upto). La PK
(UUID server-side) es la clave de idempotencia del settle (AC-1).

```
a2a_payment_intents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- idempotency key (AC-1)
  intent_type   TEXT NOT NULL CHECK (intent_type IN ('session','upto')),  -- literal APP (AC-5)
  owner_ref     TEXT NOT NULL,                    -- Ownership Guard (AC-4/CD-2)
  key_id        UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  buyer_wallet  TEXT,                             -- funding_wallet del Buyer (upto: ancla firma)
  seller_ref    TEXT NOT NULL,                    -- destino "<registry>/<slug>" normalizado
  pay_to        TEXT NOT NULL,                    -- address on-chain del Seller (settle)
  chain_id      INT  NOT NULL,
  -- session: authorized_usd = deposit reservado; upto: authorized_usd = cap firmado
  authorized_usd NUMERIC(20,8) NOT NULL CHECK (authorized_usd >= 0),
  consumed_usd   NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (consumed_usd >= 0),
  -- upto: firma del cap + nonce (verificada server-side contra buyer_wallet)
  cap_signature  TEXT,
  cap_nonce      TEXT,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','closing','settled','refunded','expired','failed')),
  settle_tx_hash TEXT UNIQUE,                     -- anti doble-settle a nivel row
  residual_usd   NUMERIC(20,8),                   -- session: deposit − consumed (post-close)
  expires_at     TIMESTAMPTZ NOT NULL,            -- AC-6 (resolución determinística)
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_a2a_payment_intents_key_owner ON a2a_payment_intents (key_id, owner_ref);
CREATE INDEX idx_a2a_payment_intents_owner     ON a2a_payment_intents (owner_ref);
CREATE INDEX idx_a2a_payment_intents_status    ON a2a_payment_intents (status);
```

**Tabla `a2a_payment_vouchers`** — ledger append-only para `session` (acumulación
idempotente). Un voucher = una unidad de uso medido.

```
a2a_payment_vouchers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id   UUID NOT NULL REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,                      -- Ownership Guard (AC-4)
  voucher_id  TEXT NOT NULL,                      -- idempotency key del voucher (CD-3)
  amount_usd  NUMERIC(20,8) NOT NULL CHECK (amount_usd >= 0),
  voucher_signature TEXT,                         -- OPCIONAL (extensión buyer/seller attest)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_id, voucher_id)                  -- anti doble-conteo (CD-3): 23505 = ya visto
);
CREATE INDEX idx_a2a_payment_vouchers_intent ON a2a_payment_vouchers (intent_id);
```

**RLS (deny-by-default, patrón WKH-SEC-02):**
`ALTER TABLE a2a_payment_intents ENABLE ROW LEVEL SECURITY;`
`ALTER TABLE a2a_payment_vouchers ENABLE ROW LEVEL SECURITY;`
(sin policy permisiva → deny-all para anon/authenticated; service_role bypassa por BYPASSRLS).

**RPC atómicos (todos `SECURITY DEFINER` + `SET search_path=public,pg_temp` + `REVOKE
... FROM PUBLIC,anon,authenticated` + `GRANT ... TO service_role`, patrón
`debit_session_and_parent`):**

1. `open_payment_intent(...)` — inserta la fila del intent. Para `session`: debita
   `authorized_usd` (deposit) del parent budget en la MISMA tx (reusa
   `increment_a2a_key_spend`, propaga `INSUFFICIENT_BUDGET`/`OWNERSHIP_MISMATCH`).
   Para `upto`: NO debita (el cap es una autorización; el débito ocurre en el settle).
   Owner guard: `owner_ref` desnormalizado + valida contra el caller.
2. `accumulate_payment_voucher(p_intent_id, p_owner_ref, p_voucher_id, p_amount)` —
   `FOR UPDATE` sobre el intent; valida `status='open'` + owner; `INSERT` del voucher
   (23505 = idempotente, no incrementa); si es nuevo → `consumed_usd += amount`.
   **Guard: `consumed_usd` no puede exceder `authorized_usd`** (deposit) → si excede,
   se clampa el último voucher o se rechaza (auto-close, ver §4.5). Solo `session`.
3. `close_payment_intent_for_settle(p_intent_id, p_owner_ref)` — `FOR UPDATE`;
   transición `open→closing` (idempotencia del settle, AC-1); si ya está
   `closing`/`settled` → retorna el estado actual sin re-settlear. Computa el
   `final_amount` bajo lock: `session` → `min(consumed_usd, authorized_usd)`;
   `upto` → `min(authorized_usd, p_reported_usage)`.
4. `finalize_payment_intent(p_intent_id, p_owner_ref, p_tx_hash, p_residual)` —
   `FOR UPDATE`; marca `settled` + `settle_tx_hash` (o `failed` + error). Para
   `session` con residual > 0 → llama `refund_a2a_key_spend` (credit-back del
   residual, AC-2) en la MISMA tx. `session` upto residual: N/A (upto no reservó).

> **[VERIFY-AT-IMPL — R-1]** Firma exacta / tipos de los 4 RPC (orden de args,
> `NUMERIC` vs `INT`) se confirma contra el patrón `debit_session_and_parent` al
> generar `database.types.ts`. Mismo criterio que delegation/session.

### 4.3 Servicios

`src/services/payment-intent.ts` expone:

```
paymentIntentService = {
  openSession(params) -> { intentId, expiresAt }        // SP: crea + reserva deposit
  addVoucher(params)  -> { accepted, consumedUsd }      // idempotente por voucher_id
  closeSession(intentId, ownerRef) -> SettleOutcome     // SP-1 (settle point)
  createUpto(params)  -> { intentId, expiresAt }        // verifica cap EIP-712
  settleUpto(intentId, ownerRef, reportedUsage) -> SettleOutcome  // SP-2 (settle point)
  expireStale()       -> void                           // AC-6 (auto-settle + refund)
  // EIP-712 cap (upto) — mirror delegation.ts:
  verifyCapSignature(typedData, signature) -> address   // recover + domain binding
}
```

**Reglas money-path del servicio (heredan de fee-charge.ts):**
- El settle NUNCA rechaza la promise (CD-B): captura todo error → `{status:'failed'}`.
- `verifyDefaultChainSettle` se llama **antes** de marcar `settled` (CD-5); fail-OPEN
  en `RPC_UNAVAILABLE` (log warn), fail-CLOSED en contradicción.
- Montos comparados en micro-USD entero (`decimalStringToMicroUsd`), nunca float64.
- Nunca propaga el msg crudo de PG al cliente (mapeo por prefijo de error).

### 4.4 Naming — resolución de la colisión (AC-5 + DT-3)

| Concepto | Público (APP) | Interno (disambiguado) |
|----------|---------------|------------------------|
| Intent metered | `intent: "session"` | tabla `a2a_payment_intents.intent_type='session'`, servicio `payment-intent.ts`, ruta `/payments/session/*` |
| Intent cap | `intent: "upto"` | `a2a_payment_intents.intent_type='upto'`, `/payments/upto/*` |
| **Auth efímero (WKH-121, NO tocar)** | `keySessionId` | tabla `a2a_key_sessions`, servicio `key-session.ts`, ruta `/auth/key-session/*` |

**Regla de desambiguación (DT-3):** el string `"session"` como **valor del campo
`intent`** vive en un namespace distinto (`a2a_payment_intents` / `payment-intent.ts`
/ `/payments/*`) del "key session" de auth (`a2a_key_sessions` / `keySessionId` /
`/auth/key-session/*`). Se expone el literal `"session"`/`"upto"` en la superficie
pública (compat APP directa → WKH-141 sin mapping). Verificado: **no existe** hoy
ningún campo `intent`/`paymentIntent` en `src/` (grep vacío) → cero colisión de campo.

### 4.5 Flujo principal (Happy Path)

**`session`:**
1. `POST /payments/session` `{ keyId, sellerRef, chainId, depositUsd, ttlSeconds? }`
   → `intentId = crypto.randomUUID()` (server-side); `open_payment_intent` reserva
   `depositUsd` del budget del Buyer (owner guard). Retorna `{ intentId, expiresAt }`.
2. Durante el uso: `POST /payments/session/:id/voucher` `{ voucherId, amountUsd }`
   → `accumulate_payment_voucher` (idempotente por `voucherId`; `consumed_usd += amount`
   bajo lock; guard `consumed ≤ deposit`).
3. `POST /payments/session/:id/close`:
   - `close_payment_intent_for_settle` → `open→closing`, `final = min(Σvouchers, deposit)`.
   - `getPaymentAdapter().sign({to: pay_to, value: finalWei})` + `.settle(...)`.
   - `verifyDefaultChainSettle({txHash, payTo, requiredAmountAtomic: finalWei})`.
   - `finalize_payment_intent` → `settled` + tx_hash; `residual = deposit − final`;
     si `residual > 0` → `refund_a2a_key_spend` (credit-back al Buyer, AC-2).
   - Retorna `{ status:'settled', txHash, consumedUsd, residualUsd }`.

**`upto`:**
1. `POST /payments/upto` `{ keyId, sellerRef, chainId, capUsd, capSignature, capNonce,
   typedData }` → `verifyCapSignature` (recover EIP-712, domain binding, firmante ==
   `funding_wallet`); si OK → `open_payment_intent` (type `upto`, NO debita).
   Retorna `{ intentId, expiresAt }`.
2. Seller reporta uso: `POST /payments/upto/:id/settle` `{ reportedUsageUsd }`
   → `close_payment_intent_for_settle` computa `final = min(cap, reportedUsage)` bajo
   lock; `sign()`+`settle()`+`verifyDefaultChainSettle`; débito del `final` del budget
   del Buyer; `finalize_payment_intent` → `settled` + tx_hash.
   Retorna `{ status:'settled', txHash, chargedUsd, cappedAt: final===cap }`.

### 4.6 Flujo de error / edge cases

| Caso | Resolución |
|------|-----------|
| Retry del close/settle (mismo intentId) | `status` ya `closing`/`settled` → NO re-settlea (AC-1). Idempotente. |
| Voucher reenviado (mismo `voucherId`) | `UNIQUE(intent_id,voucher_id)` 23505 → no incrementa `consumed` (CD-3). |
| `uso > cap` (upto) | Clampa a `cap` (`min`); emite telemetría `cap_exceeded`. NUNCA cobra > cap (AC-3). |
| `Σvouchers > deposit` (session) | Guard en `accumulate_...`: clampa/rechaza el voucher que excede; opcional auto-close. Settle nunca cobra > deposit. |
| `residual` negativo o no-finito | `residual = max(0, deposit − consumed)` en micro-USD entero; nunca refund negativo (AC-2). |
| Firma del cap inválida (upto) | `verifyCapSignature` → rechazo 400 (`CAP_SIGNATURE_INVALID`); intent NO se crea. |
| `settle()` reporta success pero on-chain contradice | `verifyDefaultChainSettle` fail-CLOSED → marca `failed`, NO `settled`, NO refund (CD-5). |
| RPC on-chain no disponible | fail-OPEN (facilitator ya confirmó) + log warn (patrón fee-charge L300). |
| Intent abandonado (deposit sin close / cap sin report) | `expireStale()`: al pasar `expires_at` → auto-settle del `consumed` (session: `min(consumed,deposit)`; upto: 0 si no hubo report) + refund del residual (AC-6). |
| Ownership mismatch | RPC `OWNERSHIP_MISMATCH` → 403, mapeo por prefijo, nunca msg crudo PG (CD-2). |

---

## 4.9 SETTLE POINTS — Interfaz estable para WKH-136 (CRÍTICO)

Esta HU introduce **dos nuevos puntos de settlement** además del `charge`/fee
existente. **WKH-136 (splits atómicos bps) se diseñará ENCIMA de estos.** Se
documentan como **contrato estable**:

| ID | Punto | Función | Monto final que resuelve | Momento |
|----|-------|---------|--------------------------|---------|
| **SP-0** (existe) | protocol fee / downstream | `fee-charge.ts` `chargeProtocolFee` / `compose.ts` settle | fee = base×rate | `/compose`,`/orchestrate` |
| **SP-1** (nuevo) | `session` close | `paymentIntentService.closeSession` | `min(Σvouchers, deposit)` → `pay_to` | cierre de la sesión |
| **SP-2** (nuevo) | `upto` settle | `paymentIntentService.settleUpto` | `min(cap, reportedUsage)` → `pay_to` | reporte de uso del Seller |

**Seam de extensión para WKH-136:** ambos settle points computan un **`finalAmountUsd`
único** y llaman un helper interno compartido:

```
// interfaz que WKH-136 va a envolver/extender (NO la implementa esta HU con splits):
settlePaymentIntentOnChain(params: {
  intentId: string;      // idempotency key
  ownerRef: string;      // Ownership Guard
  payTo: string;         // recipient (hoy: 1 seller; WKH-136: N recipients por bps)
  finalAmountUsd: number;// hoy: monto único; WKH-136: se reparte en splits
  chainId: number;
}): Promise<SettleOutcome>
```

WKH-136 sustituirá `payTo + finalAmountUsd` por una **lista de recipients con bps**,
manteniendo la idempotencia por `intentId` y el `verifyDefaultChainSettle` por cada
transfer. **Esta HU deja el punto de cómputo del monto final aislado en una sola
función** para que WKH-136 no tenga que refactorizar el servicio: solo interceptar el
`finalAmountUsd`. Documentado explícitamente para que WKH-136 no duplique lógica.

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-1** (heredado): idempotencia del settle por la **PK del intent (UUID
  server-side vía `crypto.randomUUID()`)**, NUNCA un id que controle el cliente
  (patrón `orchestrationId` orchestrate.ts:90).
- **CD-2** (heredado): **Ownership Guard `owner_ref`** en TODA tabla/query/RPC nueva
  — desnormalizado en la fila + validado DB-level en cada RPC (`OWNERSHIP_MISMATCH`
  bajo `FOR UPDATE`, patrón `debit_session_and_parent`). Un AR que encuentre una query
  sin `.eq('owner_ref', ...)` o un RPC sin `p_owner_ref` sobre estado de pago → BLOQUEANTE (IDOR).
- **CD-3** (heredado): idempotencia de la **acumulación** de vouchers (`session`) por
  `UNIQUE(intent_id, voucher_id)` y del **settle** por transición de status bajo lock.
- **CD-5** (heredado): **re-verificar el settle on-chain** (`verifyDefaultChainSettle`)
  ANTES de marcar `settled`; contradicción definitiva → `failed`, no `settled`.
- **CD-6**: montos comparados/computados en **micro-USD entero** (`decimalStringToMicroUsd`
  de delegation.ts), NUNCA `parseFloat` lossy para `min(cap,uso)` ni `residual`.
- **CD-7**: el settle NUNCA rechaza la promise (CD-B de fee-charge); todo error →
  `{status:'failed'}` + `markFailed` best-effort.
- **CD-8**: `viem` only (`recoverTypedDataAddress`, `hashTypedData`); PROHIBIDO ethers.js.
- **CD-9** (Auto-Blindaje WKH-133): la acumulación idempotente del voucher usa
  `.upsert(row, { onConflict:'...', ignoreDuplicates:true }).select()` — **NO existe
  `.insert().onConflict()` encadenado** en supabase-js v2. `claimed.length===0` ⇒ ya
  reclamado. Ref: WKH-133 auto-blindaje#2.
- **CD-10** (Auto-Blindaje WKH-134 + WKH-133, recurrente ≥2): con
  `exactOptionalPropertyTypes: true`, construir objetos tipados con **asignación
  condicional** (`if (x!==undefined) obj.x = x`), NUNCA `x: cond ? v : undefined`.
  Ref: WKH-134 auto-blindaje#1, budget.ts `...(destination!==undefined && {...})`.
- **CD-11** (Auto-Blindaje WKH-133): todo `await waitForTransactionReceipt`/lectura
  on-chain envuelto en try/catch — **timeout THROWS** (`WaitForTransactionReceiptTimeoutError`),
  no retorna. Separar timeout (throw) de revert (`status`). Ref: WKH-133 auto-blindaje#3.
- **CD-12** (Auto-Blindaje WKH-134 + WKH-142, recurrente ≥2 — money-path): validar
  TODO monto money-path (`depositUsd`, `capUsd`, `amountUsd`, `reportedUsage`) en el
  **write-boundary** (rechazo explícito 422 si no es `number` finito `>= 0`) Y clampear
  en el **read-boundary** (`CHECK (>= 0)` en DB + parse defensivo). Ref: WKH-134
  auto-blindaje#3, WKH-142 (guard negativo money-path).
- **CD-13** (Auto-Blindaje WKH-133): `BigInt(x)` sobre valores de DB/JSON (montos wei,
  nonces) envuelto en try/catch cuando el contrato exige no-throw. Ref: WKH-133 auto-blindaje#4.

### PROHIBIDO

- **CD-P1** (heredado CD-1): PROHIBIDO modificar el comportamiento de `charge` (x402) o
  de los paths de débito master/delegación/key-session. Los intents nuevos son código
  aditivo. Validar cero regresión con `orchestrate.billing.test.ts`,
  `money-path.concurrency.test.ts`, `money-path.resilience.test.ts`.
- **CD-P2** (heredado CD-4): PROHIBIDO inventar la semántica de firma (struct EIP-712
  exacto del cap `upto`, esquema del voucher `session`) sin ratificación humana — los
  forks abiertos están en §10 (SPEC-GATE) con propuesta concreta.
- **CD-P3**: PROHIBIDO reutilizar `a2a_key_sessions` (auth) para estado de pago.
- **CD-P4**: PROHIBIDO hardcodear domain/wallet/token/chain — todo de env
  (`UPTO_EIP712_NAME/VERSION`, `KITE_CHAIN_ID`, `getPaymentAdapter()`).
- **CD-P5**: PROHIBIDO usar un id de billing que controle el cliente como clave única.
- **CD-P6**: PROHIBIDO `any`/`as unknown` (TS strict); PROHIBIDO non-null assertion
  (biome) — usar `?? null`/`?? default` (WKH-133 auto-blindaje#1).
- **CD-P7**: PROHIBIDO modificar archivos fuera del Scope IN (§4.1); NO tocar el dir de
  WKH-136 (138).

---

## 6. Scope

**IN:** modelo de datos (`a2a_payment_intents` + `a2a_payment_vouchers` + 4 RPC + RLS),
servicio `payment-intent.ts` (open/voucher/close/settle/expire + EIP-712 cap),
endpoints `/payments/session/*` + `/payments/upto/*`, idempotencia + refund residual +
`min(cap,uso)`, tipos, tests money-path.

**OUT:** bridge APP (WKH-141), splits bps (WKH-136 — solo se deja el seam §4.9), intent
`escrow`/disputas (WKH-139), IM/QR (WKH-137), embedded wallet (WKH-138), UI/dashboard,
modificar `charge`/x402.

---

## 7. Riesgos (para AR)

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Doble-cobro en retry del close/settle | M | A (pérdida de fondos) | PK del intent + transición `open→closing→settled` bajo `FOR UPDATE` (AC-1/CD-1/CD-3). Test T-AC1. |
| Refund residual incorrecto (off-by-one/redondeo/negativo) | M | A (leak de fondos) | Cómputo en micro-USD entero + `max(0, ...)` + `CHECK (>=0)` (CD-6/CD-12). Test T-AC2. |
| `uso > cap` cobra de más (upto) | M | A | `min(cap,uso)` bajo lock, cap firmado inviolable (AC-3). Test T-AC3. |
| Firma del cap forjada / replay | M | A | domain binding + `recoverTypedDataAddress` == `funding_wallet` + `cap_nonce` UNIQUE (delegation.ts). Test T-SIG. |
| Query/RPC sin owner guard (IDOR) | B | A | `owner_ref` en tabla + `p_owner_ref` en RPC + RLS (CD-2/AC-4). Test T-OWN. |
| Settle forjado por facilitator | B | A | `verifyDefaultChainSettle` fail-CLOSED en contradicción (CD-5). Test T-VERIFY. |
| Voucher doble-contado | M | M | `UNIQUE(intent_id,voucher_id)` + upsert ignoreDuplicates (CD-3/CD-9). Test T-VCHR. |
| Regresión en `charge`/orchestrate/compose | B | A | Código 100% aditivo; correr la suite money-path existente (CD-P1). |
| Fondos retenidos indefinidamente | B | M | `expires_at` + `expireStale()` auto-settle+refund (AC-6). Test T-AC6. |
| Concurrencia (2 closes / 2 vouchers simultáneos) | M | A | `FOR UPDATE` en todos los RPC. Test T-CONC (patrón money-path.concurrency). |

---

## 8. Dependencias

- `getPaymentAdapter()` / `verifyDefaultChainSettle` inicializados (multi-chain) — existen.
- `funding_wallet` bindeado en la Agent Key del Buyer (para verificar la firma del cap `upto`).
- Env: `UPTO_EIP712_NAME` (default `WasiAI-a2a Upto`), `UPTO_EIP712_VERSION` (default `1`),
  `KITE_CHAIN_ID`, `SETTLE_VERIFY_ONCHAIN`, `PAYMENT_INTENT_TTL_SECONDS` (default, p.ej. 3600).
- Migración aplicada en la DB correcta (caldz=a2a+mainnet / bdwv=dev; ver MEMORY db-topology).

---

## 9. Missing Inputs / SPEC-GATE — 3 forks de producto (PROPUESTA a ratificar)

Estos son los **forks de producto** para el humano en el SPEC gate. Cada uno tiene una
**PROPUESTA concreta** (default groundeado); ratificar o corregir en el gate. **No son
`[NEEDS CLARIFICATION]` abiertos**: son propuestas resueltas pendientes de OK humano
(CD-P2 exige ratificación de la semántica de firma).

| # | Fork | PROPUESTA (default groundeado) | Alternativa |
|---|------|-------------------------------|-------------|
| **SG-1** | Modelo del **voucher `session`** (qué se firma, qué dispara el settle) | **Gateway como autoridad de medición** (mismo trust model que el débito per-step de compose): voucher = fila append-only server-side idempotente por `voucher_id`; firma EIP-712 del voucher = campo **OPCIONAL reservado** (extensión buyer/seller attest, no requerido en V1). Cierre disparado por: close explícito del Buyer **OR** agotamiento del deposit **OR** `expires_at` (AC-6). | Voucher con firma EIP-712 obligatoria por unidad (buyer pre-autoriza / seller firma cada uso) — más pesado, difiere WKH-141. |
| **SG-2** | Semántica del **cap `upto`** (quién firma, quién reporta, qué canal) | **Buyer firma el cap** (EIP-712 obligatorio, anclado a `funding_wallet`, espejo delegation.ts). **Seller reporta uso vía `POST /payments/upto/:id/settle`**; el gateway **valida** el uso reportado contra el costo real re-derivado server-side (patrón `resolveAgentPriceUsdc`) cuando el flujo pasó por el gateway. `uso>cap` → **clamp a cap + telemetría** (nunca rechazo, nunca >cap). Attestation EIP-712 del seller = **OPCIONAL** en V1. | Seller-attestation EIP-712 obligatoria (dual-firma criptográfica estricta) — mayor fricción de integración. |
| **SG-3** | **Exposición** de los intents | **Endpoints dedicados `/payments/session/*` + `/payments/upto/*`** (aplican a una llamada a agente O a un pipeline); NO extender `/compose`/`/orchestrate` en V1 (evita regresión en el core money-path, CD-P1). | Extender `/compose`/`/orchestrate` con un campo `paymentIntent` — toca el core, más riesgo de regresión. |

> **Resueltos por el diseño (no van al gate):** persistencia = tabla nueva
> `a2a_payment_intents` + ledger (§4.2, DT-2 confirmado); naming = literal
> `"session"`/`"upto"` público + prefijo `payment_` interno (§4.4, AC-5); ambos intents
> en esta misma HU/PR (decisión de producto del orquestador ya tomada).

---

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| SPEC-GATE SG-1 | §9 | Modelo del voucher `session` — PROPUESTA lista, ratificar | Sí (gate humano) |
| SPEC-GATE SG-2 | §9 | Semántica del cap `upto` — PROPUESTA lista, ratificar | Sí (gate humano) |
| SPEC-GATE SG-3 | §9 | Superficie de exposición — PROPUESTA lista, ratificar | Sí (gate humano) |
| [VERIFY-AT-IMPL] R-1 | §4.2 | Firma/tipos exactos de los 4 RPC vs `debit_session_and_parent` al generar `database.types.ts` | No |
| [VERIFY-AT-IMPL] R-2 | §4.3 | Struct EIP-712 del cap `upto` (`Upto` types `as const`) confirmado contra viem al implementar (espejo `DELEGATION_TYPES`) | No |
| [VERIFY-AT-IMPL] R-3 | §4.5 | Conversión USD→wei del `finalAmount` (`BigInt(Math.round(usd*1e6))*BigInt(1e12)`, patrón compose.ts:188) confirmada contra el token de cada chain | No |

> Gate: los 3 SPEC-GATE se ratifican en SPEC_APPROVED. Los `[VERIFY-AT-IMPL]` NO
> bloquean el gate (se resuelven byte-a-byte en F3, como delegation/escrow).

---

## 11. Plan de Tests (vitest — ≥1 por AC + money-path)

| Test | AC/Riesgo que cubre | Archivo | Descripción |
|------|---------------------|---------|-------------|
| **T-AC1** doble-cobro close | AC-1 | `payment-intent.test.ts` | 2 closes del mismo `intentId` → 1 solo settle (2º ve `settled`, no re-settlea). Verifica `settle()` llamado 1 vez. |
| **T-AC2** refund residual | AC-2 | `payment-intent.test.ts` | deposit=10, Σvouchers=3.7 → settle 3.7 al seller + credit-back 6.3 al Buyer. Micro-USD exacto, sin off-by-one. |
| **T-AC2b** residual cero/negativo | AC-2/CD-6 | `payment-intent.test.ts` | consumed==deposit → residual 0, NO refund; consumed>deposit (guard) → residual clamp 0. |
| **T-AC3** cap inviolable | AC-3 | `payment-intent.test.ts` | cap=5, uso reportado=8 → cobra `min=5`. cap=5, uso=2 → cobra 2. NUNCA >cap. |
| **T-AC4** owner guard | AC-4/CD-2 | `payment-intent.test.ts` + `payments.test.ts` | caller B intenta close/voucher un intent de A → `OWNERSHIP_MISMATCH`/403; RPC sin `p_owner_ref` no compila (tipo requerido). |
| **T-AC5** literal APP | AC-5 | `payments.test.ts` | request/response usan `"session"`/`"upto"` literales; no un nombre interno. |
| **T-AC6** expiry | AC-6 | `payment-intent.test.ts` | intent vencido → `expireStale()` auto-settlea consumido + refund residual; no queda `open` con fondos retenidos. |
| **T-SIG** firma del cap | Riesgo firma | `payment-intent.test.ts` | firma válida (firmante==funding_wallet) → crea; firma de otra wallet / domain distinto / nonce reusado → rechazo, intent NO creado. |
| **T-VCHR** voucher idempotente | CD-3/CD-9 | `payment-intent.test.ts` | mismo `voucherId` 2 veces → `consumed` incrementa 1 sola vez (23505 / upsert ignoreDuplicates). |
| **T-VERIFY** settle on-chain | CD-5 | `payment-intent.test.ts` | `settle()` success pero `verifyDefaultChainSettle` fail-CLOSED → marca `failed`, NO `settled`, NO refund. RPC_UNAVAILABLE → fail-OPEN + warn. |
| **T-CONC** concurrencia | Riesgo concurrencia | `payment-intent.test.ts` | 2 closes concurrentes / 2 vouchers concurrentes → serializados por `FOR UPDATE`, sin doble efecto (patrón `money-path.concurrency.test.ts`). |
| **T-WRITE** guard money-path | CD-12 | `payments.test.ts` | `depositUsd`/`capUsd`/`amountUsd` negativo / NaN / no-number → 422, intent/voucher NO creado. |
| **T-REGR** no-regresión | CD-P1 | (suite existente) | correr `orchestrate.billing.test.ts` + `money-path.concurrency.test.ts` + `money-path.resilience.test.ts` sin cambios → verde. |

---

## 12. Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado en tabla 4.1 (payment-intent.ts / migración / payments.ts)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Glob/Read (fee-charge, budget, delegation, key_sessions migration, orchestrate, index)
[x] No hay [NEEDS CLARIFICATION] abiertos — 3 forks resueltos como PROPUESTA a ratificar en el gate (§9)
[x] Constraint Directives: 13 OBLIGATORIO + 7 PROHIBIDO (≥3)
[x] Context Map: 13 archivos leídos (≥2)
[x] Scope IN/OUT explícitos (§6)
[x] BD: tablas verificadas (a2a_agent_keys/a2a_key_sessions/a2a_protocol_fees existen; a2a_payment_intents/vouchers se crean)
[x] Happy Path completo para session y upto (§4.5)
[x] Flujo de error definido (§4.6, ≥1 caso — 10 casos)
[x] Settle points documentados como interfaz estable para WKH-136 (§4.9)
[x] Test plan ≥1 por AC + money-path (§11, 13 tests)
[x] Auto-Blindaje histórico incorporado (WKH-133 #1-4, WKH-134 #1/#3, WKH-142) → CD-9..CD-13
```

**Estado:** LISTO para SPEC gate. Bloqueo residual = ratificación humana de los 3
forks SG-1/SG-2/SG-3 (§9). Los `[VERIFY-AT-IMPL]` R-1/R-2/R-3 se resuelven en F3.

---

## 13. Waves de Implementación

### Wave 0 (Serial Gate — contratos/tipos/DB)
- **W0.1**: Migración `20260704000000_wkh135_payment_intents.sql` + `_down` — 2 tablas
  + 4 RPC (`open_payment_intent`, `accumulate_payment_voucher`,
  `close_payment_intent_for_settle`, `finalize_payment_intent`) + RLS + hardening.
  Exemplar: `20260603000000_a2a_key_sessions.sql`.
- **W0.2**: Tipos en `src/types/index.ts` (`PaymentIntentRow`, `PaymentVoucherRow`,
  `UptoCapTypedData`, DTOs) + `database.types.ts` (rows + Args de los 4 RPC).
  Exemplar: tipos delegation/session existentes. [VERIFY-AT-IMPL R-1].

### Wave 1 (Parallelizable — lógica)
- **W1.1**: `payment-intent.ts` — EIP-712 del cap (`verifyCapSignature`, `Upto` types,
  `buildUptoDomain`). Exemplar: `delegation.ts`. [VERIFY-AT-IMPL R-2].
- **W1.2**: `payment-intent.ts` — `openSession`/`addVoucher`/`createUpto` (consumen
  RPCs W0). Exemplar: `budget.ts` (mapeo de errores) + `fee-charge.ts` (idempotencia).
- **W1.3**: `payment-intent.ts` — `settlePaymentIntentOnChain` (seam §4.9) +
  `closeSession`/`settleUpto` + `expireStale`. Exemplar: `fee-charge.ts`
  (sign/settle/verify/markFailed). [VERIFY-AT-IMPL R-3].

### Wave 2 (Depende de W0 + W1 — rutas)
- **W2.1**: `src/routes/payments.ts` — endpoints + auth middleware + validación
  write-boundary (CD-12) + `crypto.randomUUID()`. Depende W1.1-1.3.
- **W2.2**: `src/index.ts` — `register(paymentsRoutes, { prefix: '/payments' })`.

### Wave 3 (Final — tests + verificación)
- **W3.1**: `payment-intent.test.ts` + `payments.test.ts` (13 tests §11).
- **W3.2**: correr suite money-path existente (CD-P1) + `tsc` + `biome`.

---

*SDD generado por NexusAgil — FULL (F2). Money-path QUALITY.*
