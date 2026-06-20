# Story File — #113: [WKH-124] KEY-RECEIPTS (recibos inmutables HMAC-encadenados + verify endpoint)

> SDD: doc/sdd/113-wkh-124-receipts/sdd.md
> Fecha: 2026-06-19
> Branch: feat/113-wkh-124-receipts

---

## Goal

Agregar un **recibo inmutable por pago exitoso** que captura el linaje completo
(`session_id → agent_key_id → owner_ref`) más los detalles del cobro (monto, chain,
tx_hash, counterparty, timestamp), **encadenado por owner** mediante `prev_receipt_hash`
(ledger-style, estilo proof-chain Kite Passport) y firmado server-side con
`receipt_hash = HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical_json)`.

La emisión es **best-effort / fire-and-forget** en dos puntos:
(a) al confirmarse `chargeProtocolFee → status:'charged'` (emitido desde el call-site
de `orchestrate.ts`, que SÍ tiene el linaje); (b) al confirmarse un débito de budget en
las 3 rutas (master / delegation / key-session). **Un fallo de emisión NUNCA interrumpe
el flujo de pago.** Se expone `GET /receipts`, `GET /receipts/:id` y
`GET /receipts/:id/verify` (este último recomputa el hash y reporta tamper). El anclaje
on-chain (Merkle root) se difiere a WKH-124b.

**Tabla append-only** salvo el UPDATE-once que escribe `receipt_hash` por primera vez
(el flujo es INSERT con `receipt_hash=''` → leer row → computar HMAC → UPDATE-once).

---

## Acceptance Criteria (EARS)

> Copiados del SDD/work-item aprobados. QA los verifica en F4.

1. **AC-1** WHEN `chargeProtocolFee` retorna `{ status:'charged', txHash }`, THEN el sistema SHALL emitir un recibo `protocol_fee` con `{ agent_key_id?, owner_ref, session_id:null, amount_usd:feeUsdc, chain_id, tx_hash, counterparty:WASIAI_PROTOCOL_FEE_WALLET, orchestration_id, receipt_type:'protocol_fee' }` antes de retornar el resultado al caller (best-effort, AC-6).
2. **AC-2** WHEN un débito de budget se confirma exitoso en cualquiera de las 3 rutas (master / delegation / key-session), THEN el sistema SHALL emitir un recibo `budget_debit` con el linaje disponible (`agent_key_id`, `owner_ref`, `session_id?`, `delegation_id?`, `amount_usd`, `chain_id`, `counterparty:null`) como best-effort (SHALL NOT propagar fallo de emisión al resultado del débito).
3. **AC-3** WHEN se crea un recibo, THEN el sistema SHALL computar `receipt_hash = HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical_payload)` donde `canonical_payload` incluye todos los campos + `prev_receipt_hash`, y persistirlo como append-only (sin UPDATE/DELETE, salvo el UPDATE-once del hash).
4. **AC-4** WHEN `GET /receipts/:id/verify` se llama con id válido Y `owner_ref` del caller == `owner_ref` del recibo, THEN el sistema SHALL recomputar el hash de los campos almacenados, compararlo con el almacenado, y retornar `{ valid:true, receipt_id, computed_hash, stored_hash }` si coinciden.
5. **AC-5** IF `verify` detecta mismatch (`computed_hash !== stored_hash`), THEN SHALL retornar `{ valid:false, receipt_id, tamper_detected:true }` con HTTP 200.
6. **AC-6** IF la emisión falla (insert error, secret faltante, o cualquier excepción), THEN SHALL loguear WARN y retornar el resultado original sin cambios — el flujo de pago SHALL NOT interrumpirse.
7. **AC-7** WHEN `GET /receipts` lo llama un caller autenticado, THEN SHALL retornar SOLO recibos donde `owner_ref` == caller (`.eq('owner_ref', callerOwnerRef)` OBLIGATORIO).
8. **AC-8** WHEN `GET /receipts/:id/verify` (o `GET /receipts/:id`) se llama y el `owner_ref` del recibo NO coincide con el del caller, THEN SHALL retornar 404 (disclosure-safe).

---

## Files to Modify/Create

> **NOTA DE SCOPE (vs work-item):** el SDD **reduce** el scope: `fee-charge.ts` **NO se toca**.
> El `protocol_fee` se emite desde el call-site de `orchestrate.ts` (~L437-452), porque ahí
> SÍ están `request.a2aKeyRow.owner_ref/id` y `request.chainId` (que `chargeProtocolFee` no tiene
> en scope). Esto mantiene intacto el contrato de pago (CD-6). El SDD **agrega** `a2a-key.ts` y
> `orchestrate.ts` como puntos de emisión.

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/types/receipt.ts` | **Crear** | `ReceiptType`, `ReceiptRow` (todas las columnas, nullables como `T\|null`, `amount_usd:string`), `EmitReceiptInput`, `VerifyReceiptResult`, `ReceiptListItem`. **Tipos en archivo propio** (CD-8: sin fanout a row-types existentes). | `src/types/a2a-key.ts` |
| 2 | `supabase/migrations/20260605000000_a2a_receipts.sql` | **Crear** | Tabla `a2a_receipts` append-only + índices + RPC `insert_receipt` + hardening (SQL textual abajo — copiar tal cual). | `supabase/migrations/20260603000000_a2a_key_sessions.sql:1-23,28-96` |
| 3 | `supabase/migrations/20260605000000_a2a_receipts_down.sql` | **Crear** | `DROP FUNCTION insert_receipt(...)` + `DROP TABLE IF EXISTS a2a_receipts` (SQL textual abajo). | `..._a2a_key_sessions_down.sql` |
| 4 | `src/services/receipt.ts` | **Crear** | `receiptService.emit/verify/list/getById` + `buildCanonicalPayload` + `computeReceiptHash`. | `src/services/event.ts:52-85`; `src/services/signed-auth.ts:166-194`; `src/services/budget.ts:42-59` |
| 5 | `src/routes/receipts.ts` | **Crear** | `GET /receipts`, `GET /receipts/:id`, `GET /receipts/:id/verify`. `resolveCallerKey` reusado, ownership + 404 disclosure-safe. | `src/routes/auth.ts:1102-1113,1194-1233` |
| 6 | `src/services/budget.ts` | **Modificar** | Emisión `budget_debit` en ruta key-session (tras `return {success:true}` ~L88) y delegation (~L139), fire-and-forget. Master **NO** se toca aquí. | `src/services/budget.ts:79-139` |
| 7 | `src/middleware/a2a-key.ts` | **Modificar** | Emisión `budget_debit` master tras `debitResult.success` (~L816), con `keyRow.owner_ref/id`, `chainId`. | `src/middleware/a2a-key.ts:788-816` |
| 8 | `src/services/orchestrate.ts` | **Modificar** | Emisión `protocol_fee` tras `feeResult.status === 'charged'` (~L448), con `request.a2aKeyRow.owner_ref/id`, `request.chainId`, `feeResult.txHash`, `feeUsdc`, fee wallet de env, `orchestrationId`. | `src/services/orchestrate.ts:437-473` |
| 9 | `src/index.ts` | **Modificar** | `import receiptsRoutes` + `register(receiptsRoutes, { prefix:'/receipts' })`. | `src/index.ts:18-29,101-127` |
| 10 | `src/services/receipt.test.ts` | **Crear** | Unit: hash, canonical, verify match/tamper, ownership, secret-missing/RPC-reject best-effort. | `src/services/event.ts` (mock supabase) |
| 11 | `src/routes/receipts.test.ts` | **Crear** | e2e: list ownership, verify 200 match/tamper, 404 cross-owner. | `src/routes/auth.ts` |

> **Tests de los call-sites (AC-1, AC-2):** la emisión de `protocol_fee` (AC-1) y `budget_debit`
> (AC-2/3 rutas) se testea en los archivos de test EXISTENTES de los call-sites
> (`orchestrate.*.test.ts` / `a2a-key.test.ts` / `budget.test.ts`). **Modificar esos tests
> SOLO si ya existen**; si verificar AC-1/AC-2 desde el call-site es inviable sin reescribir
> tests grandes, cubrir el comportamiento con un test del propio `receiptService.emit` +
> un assert de que `emit` se invoca fire-and-forget. **NO romper aserciones `toHaveBeenCalledWith`
> de `budgetService.debit` (CD-7).**

---

## Esquema EXACTO (vinculante — sin ambigüedad)

### Flujo de emisión (`receiptService.emit`) — 3 pasos best-effort

> TODO el flujo va envuelto de forma que **nunca** propague excepción al pago. El call-site
> SIEMPRE invoca con `.catch(warn)` (CD-B); además `emit` internamente no debe re-lanzar.

1. **Guard previo.** Si `input.ownerRef` es vacío/falsy → `console.warn('[receipts] skip: no ownerRef')` + `return` (NO inserta). Si `RECEIPT_SIGNING_SECRET` unset → `console.warn` + `return` (NO inserta). (CD-D, DT-6.)
2. **RPC `insert_receipt(...)`** (atómico, bajo advisory lock por owner): devuelve `{ id, prev_receipt_hash, created_at }`. Inserta la fila con `receipt_hash = ''` (placeholder, aún sin firmar).
3. **Computar el hash en el service** (el secret NUNCA va a Postgres): `receipt_hash = computeReceiptHash(buildCanonicalPayload({...input, id, prev_receipt_hash, created_at}))`. Luego **UPDATE-once**: `.from('a2a_receipts').update({ receipt_hash: h }).eq('id', id).eq('receipt_hash', '')`. Escribe la columna `receipt_hash` por primera y única vez.

Cualquier error en pasos 2/3 → capturar y `console.warn('[receipts] emit failed', msg)` + `return`. Nunca throw.

### Canonical JSON determinista (DT-5) — algoritmo EXACTO

> **Firma (Node) y verify (lee NUMERIC string de Supabase) DEBEN coincidir byte a byte.**
> Por eso ambos lados aplican la MISMA normalización. NO confiar en orden de escritura del objeto.

1. Construir un objeto con EXACTAMENTE estas 13 keys (todas siempre presentes), **ordenadas alfabéticamente ascendente** vía `Object.keys(obj).sort()` (no por orden de escritura):
   `agent_key_id, amount_usd, chain_id, counterparty, created_at, delegation_id, id, orchestration_id, owner_ref, prev_receipt_hash, receipt_type, session_id, tx_hash`.
2. **Normalización de valores:**
   - `amount_usd`: **string decimal canónico** = `Number(value).toFixed(8)` (8 decimales, igual que `NUMERIC(20,8)`). Ej.: `1.5 → "1.50000000"`. Si el origen ya es string de Supabase, igual `Number(value).toFixed(8)`.
   - `chain_id`: **número** (no string): `2368`.
   - `created_at`: **ISO 8601 UTC** = `new Date(value).toISOString()`. Ej.: `"2026-06-19T12:34:56.789Z"`. El valor proviene de `now()` de Postgres (lo devuelve el RPC); se normaliza con `toISOString()` antes de firmar.
   - `id`, `owner_ref`, `receipt_type`: **string** tal cual.
   - `agent_key_id, session_id, delegation_id, tx_hash, counterparty, orchestration_id, prev_receipt_hash`: **string si presente; si null → el literal JSON `null`** (sin comillas; lo emite `JSON.stringify`). NO la cadena `"null"`. Lo que importa es la reproducibilidad: ambos lados usan el mismo `JSON.stringify`.
3. `canonical = JSON.stringify(orderedObject)` (V8 preserva orden de inserción para keys string no-numéricas → insertar las keys en el orden alfabético del paso 1).
4. `computeReceiptHash(canonical)`:
   - Si `RECEIPT_SIGNING_SECRET` unset → retornar `null` (señal "sin firma posible").
   - Si presente: `createHmac('sha256', RECEIPT_SIGNING_SECRET).update(canonical, 'utf8').digest('hex')` → 64 hex chars.

`verify` reconstruye `buildCanonicalPayload` con los MISMOS campos del row (mismo `toFixed(8)` / `toISOString()` / `JSON.stringify`) → mismo string → mismo hash. Comparar con `timingSafeEqual` length-checked (CD-A) o `===` sobre hex de igual longitud — preferir comparación sin throw.

### Verify (AC-4 / AC-5 / AC-8)

1. `getById(id, ownerRef)` con `.eq('owner_ref', ownerRef)`. Si null → 404 (AC-8, disclosure-safe).
2. Si `row.receipt_hash === ''` → `{ valid:false, receipt_id, reason:'UNSIGNED' }` (recibo nunca firmado; ventana INSERT→UPDATE). HTTP 200.
3. Si `RECEIPT_SIGNING_SECRET` unset → `{ valid:false, receipt_id, reason:'SIGNING_SECRET_UNAVAILABLE' }`. HTTP 200. NO expone el secret (CD-4).
4. Recomputar `computed = computeReceiptHash(buildCanonicalPayload(row))`; comparar con `row.receipt_hash` (stored).
   - Match → `{ valid:true, receipt_id, computed_hash, stored_hash }` (HTTP 200).
   - Mismatch → `{ valid:false, receipt_id, tamper_detected:true }` (HTTP 200, AC-5).

### Call-sites de emisión — linaje EXACTO por punto

| Punto | Archivo:línea | `receipt_type` | `ownerRef` | `agentKeyId` | `sessionId` | `delegationId` | `counterparty` | otros |
|-------|---------------|----------------|------------|--------------|-------------|----------------|----------------|-------|
| key-session | `budget.ts` tras `return {success:true}` ~L88 | `budget_debit` | `keySessionContext.ownerRef` | `keySessionContext.keyId` | `keySessionContext.sessionId` | `null` | `null` (DT-8) | `chainId`, `amountUsd`, `txHash:null`, `orchestrationId:null` |
| delegation | `budget.ts` tras `return {success:true}` ~L139 | `budget_debit` | `delegationContext.ownerRef` | `delegationContext.keyId` | `null` | `delegationContext.delegationId` | `null` (DT-8) | `chainId`, `amountUsd`, `txHash:null`, `orchestrationId:null` |
| master | `a2a-key.ts` tras `debitResult.success` ~L816 | `budget_debit` | `keyRow.owner_ref` | `keyRow.id` | `null` | `null` | `null` (DT-8) | `chainId` (en scope), `amountUsd:estimatedCostUsd`, `txHash:null`, `orchestrationId:null` |
| protocol_fee | `orchestrate.ts` tras `feeResult.status==='charged'` ~L448 | `protocol_fee` | `request.a2aKeyRow.owner_ref` | `request.a2aKeyRow.id` | `null` | `null` | `WASIAI_PROTOCOL_FEE_WALLET` (de env, en el call-site) | `chainId:request.chainId`, `amountUsd:feeUsdc`, `txHash:feeResult.txHash`, `orchestrationId` |

> **`EmitReceiptInput` lo arma cada call-site:**
> ```ts
> {
>   ownerRef: string;            // requerido — sin esto se skippea (NO se emite)
>   agentKeyId: string | null;
>   sessionId: string | null;
>   delegationId: string | null;
>   receiptType: 'protocol_fee' | 'budget_debit';
>   amountUsd: number | string;  // se normaliza a string decimal en canonical
>   chainId: number;
>   txHash: string | null;
>   counterparty: string | null;
>   orchestrationId: string | null;
> }
> ```

> **counterparty en `budget_debit` = `null` (DT-8):** el agent slug NO llega a `budget.debit` ni a
> los `*DebitContext` hoy. Decisión conservadora: `null`. **NO se amplían firmas ni los DebitContext**
> (CD-7). En `protocol_fee`, `counterparty = WASIAI_PROTOCOL_FEE_WALLET` (leída de env en el call-site).

---

## SQL de la migración (textual — copiar tal cual)

### `supabase/migrations/20260605000000_a2a_receipts.sql`

```sql
-- WKH-124 KEY-RECEIPTS: recibos inmutables HMAC-encadenados (append-only) por owner.
-- Aditiva y reversible. agent_key_id es NULLABLE (path protocol_fee no tiene la key en scope);
-- la integridad la garantiza receipt_hash, no la NOT-NULL constraint. owner_ref SÍ es NOT NULL
-- (clave de la cadena + Ownership Guard); si el call-site no tiene owner_ref → NO emite.

CREATE TABLE IF NOT EXISTS a2a_receipts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref          TEXT NOT NULL,                                          -- Ownership Guard (CD-3)
  agent_key_id       UUID REFERENCES a2a_agent_keys(id) ON DELETE SET NULL,  -- nullable (protocol_fee)
  session_id         UUID REFERENCES a2a_key_sessions(id) ON DELETE SET NULL,
  delegation_id      UUID REFERENCES a2a_delegations(id) ON DELETE SET NULL,
  receipt_type       TEXT NOT NULL CHECK (receipt_type IN ('protocol_fee','budget_debit')),
  amount_usd         NUMERIC(20,8) NOT NULL,
  chain_id           INT NOT NULL,
  tx_hash            TEXT,
  counterparty       TEXT,
  orchestration_id   TEXT,
  prev_receipt_hash  TEXT,                                                   -- NULL en el primer recibo del owner
  receipt_hash       TEXT NOT NULL DEFAULT '',                              -- '' = sin firmar (placeholder)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice para "último recibo del owner" (chain prev_receipt_hash) y para list (AC-7).
CREATE INDEX IF NOT EXISTS idx_a2a_receipts_owner_created
  ON a2a_receipts (owner_ref, created_at DESC);

-- ============================================================
-- RPC atómico: insert_receipt
-- Bajo advisory lock POR OWNER: lee el último receipt_hash del owner como prev,
-- inserta la fila con receipt_hash='' (el HMAC se computa en Node, NUNCA en Postgres),
-- y devuelve (id, prev_receipt_hash, created_at) para que el service firme + UPDATE-once.
-- El lock serializa inserts concurrentes del mismo owner → cadena lineal sin bifurcación.
-- ============================================================
CREATE OR REPLACE FUNCTION insert_receipt(
  p_owner_ref        TEXT,
  p_agent_key_id     UUID,
  p_session_id       UUID,
  p_delegation_id    UUID,
  p_receipt_type     TEXT,
  p_amount_usd       NUMERIC,
  p_chain_id         INT,
  p_tx_hash          TEXT,
  p_counterparty     TEXT,
  p_orchestration_id TEXT
) RETURNS TABLE (id UUID, prev_receipt_hash TEXT, created_at TIMESTAMPTZ) AS $$
DECLARE
  v_prev TEXT;
  v_id   UUID;
  v_at   TIMESTAMPTZ;
BEGIN
  -- 1. Lock por owner (serializa la cadena; se libera al COMMIT/ROLLBACK de esta tx).
  PERFORM pg_advisory_xact_lock(hashtext(p_owner_ref));

  -- 2. prev_receipt_hash = receipt_hash del último recibo del owner (NULL si es el primero).
  SELECT r.receipt_hash INTO v_prev
    FROM a2a_receipts r
    WHERE r.owner_ref = p_owner_ref
    ORDER BY r.created_at DESC
    LIMIT 1;

  -- 3. INSERT con receipt_hash='' (placeholder; el service firma luego).
  INSERT INTO a2a_receipts (
    owner_ref, agent_key_id, session_id, delegation_id, receipt_type,
    amount_usd, chain_id, tx_hash, counterparty, orchestration_id,
    prev_receipt_hash, receipt_hash
  ) VALUES (
    p_owner_ref, p_agent_key_id, p_session_id, p_delegation_id, p_receipt_type,
    p_amount_usd, p_chain_id, p_tx_hash, p_counterparty, p_orchestration_id,
    v_prev, ''
  )
  RETURNING a2a_receipts.id, a2a_receipts.created_at INTO v_id, v_at;

  id                := v_id;
  prev_receipt_hash := v_prev;
  created_at        := v_at;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening obligatorio (CD-C).
ALTER FUNCTION public.insert_receipt(text, uuid, uuid, uuid, text, numeric, integer, text, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.insert_receipt(text, uuid, uuid, uuid, text, numeric, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_receipt(text, uuid, uuid, uuid, text, numeric, integer, text, text, text)
  TO service_role;
```

### `supabase/migrations/20260605000000_a2a_receipts_down.sql`

```sql
-- WKH-124 down-migration
DROP FUNCTION IF EXISTS insert_receipt(text, uuid, uuid, uuid, text, numeric, integer, text, text, text);
DROP TABLE IF EXISTS a2a_receipts;
```

> **`.env.example` / project-context:** documentar `RECEIPT_SIGNING_SECRET` (sin valor) en la lista de env vars.

---

## Tipos (`src/types/receipt.ts`) — contrato

> TS strict, sin `any`. `amount_usd` (NUMERIC) → **`string`**. Nullables → `T | null`. **En archivo propio**
> (CD-8: no agregar campos requeridos a `A2AAgentKeyRow`/`KeySessionRow`/`*Row` existentes → cero fanout).

- `ReceiptType = 'protocol_fee' | 'budget_debit'`
- `ReceiptRow` — modela EXACTO las columnas: `id:string`, `owner_ref:string`, `agent_key_id:string|null`, `session_id:string|null`, `delegation_id:string|null`, `receipt_type:ReceiptType`, `amount_usd:string`, `chain_id:number`, `tx_hash:string|null`, `counterparty:string|null`, `orchestration_id:string|null`, `prev_receipt_hash:string|null`, `receipt_hash:string`, `created_at:string`.
- `EmitReceiptInput` — el shape de arriba (lo arma cada call-site).
- `VerifyReceiptResult` — union: `{ valid:true; receipt_id:string; computed_hash:string; stored_hash:string }` | `{ valid:false; receipt_id:string; tamper_detected?:true; reason?:'UNSIGNED'|'SIGNING_SECRET_UNAVAILABLE' }`.
- `ReceiptListItem` — subset seguro para listar (sin exponer nada sensible; `receipt_hash` está OK, el secret NO).

---

## Servicios — `receiptService` (firmas)

```
buildCanonicalPayload(fields) -> string        // DT-5 exacto (keys sort, toFixed(8), toISOString, JSON null)
computeReceiptHash(canonical) -> string | null // HMAC-SHA256 hex; null si secret unset
emit(input: EmitReceiptInput) -> Promise<void> // best-effort; NUNCA throw (CD-1)
verify(id: string, ownerRef: string) -> Promise<VerifyReceiptResult>   // recompute + compare
list(ownerRef: string) -> Promise<ReceiptListItem[]>     // Ownership Guard (CD-3)
getById(id: string, ownerRef: string) -> Promise<ReceiptRow | null>    // Ownership Guard; null = 404
```

> **`ownerRef` SIEMPRE `string`** (nunca `string | undefined`) en `verify`/`list`/`getById`. TODO SELECT
> sobre `a2a_receipts` incluye `.eq('owner_ref', ownerRef)` (CD-3, igual WKH-53).

---

## Router (`src/routes/receipts.ts`) — endpoints

`FastifyPluginAsync` + `export default`. Reusar `resolveCallerKey(req)` de `auth.ts` (importarlo o replicar el patrón). Gate `if (!callerKey?.is_active) → 403`.

- `GET /receipts` → `receiptService.list(callerKey.owner_ref)` → 200 `{ receipts: [...] }` (o array plano, consistente con `auth.ts`). **Solo del owner** (AC-7).
- `GET /receipts/:id` → `receiptService.getById(req.params.id, callerKey.owner_ref)`; null → 404 disclosure-safe (AC-8).
- `GET /receipts/:id/verify` → `receiptService.verify(req.params.id, callerKey.owner_ref)`. 404 si cross-owner (AC-8); 200 con `{valid:true/false}` si propio (AC-4/AC-5).

> Registrar en `src/index.ts`: `import receiptsRoutes from './routes/receipts.js';` (junto al resto, ~L18-29) + `await fastify.register(receiptsRoutes, { prefix: '/receipts' });` (junto al resto de registros, ~L101-127).

---

## Exemplars (verificados con Read — paths y rangos reales)

### Exemplar 1: HMAC con node:crypto + comparación segura
**Archivo**: `src/services/signed-auth.ts:166-194` + `src/services/llm/transform-hmac.ts:34-84`
**Usar para**: `computeReceiptHash` y la comparación en `verify`.
**Patrón clave**: `createHmac('sha256', key).update(canonical, 'utf8').digest('hex')`; validar hex ANTES de `Buffer.from`; `if (provided.length !== expected.length) return false;` ANTES de `timingSafeEqual`; NUNCA throw en verify; NUNCA `===` sobre buffers de firma.

### Exemplar 2: Insert best-effort fire-and-forget de servicio Supabase
**Archivo**: `src/services/event.ts:52-85`
**Usar para**: `receiptService.emit` (estructura del insert) y el patrón caller `.catch`.
**Patrón clave**: `Partial<Row>` con `?? null`, `.insert(row).select().single()`, `throw` interno; el caller hace `.catch(warn)`. `EventRow` interface tipada (CD-5). En receipts el `emit` además NO re-lanza (best-effort total).

### Exemplar 3: Ownership Guard en SELECT
**Archivo**: `src/services/budget.ts:42-59` (`.eq('id').eq('owner_ref').single()`)
**Usar para**: `list`, `getById`, `verify`.
**Patrón clave**: `.eq('owner_ref', ownerId)` SIEMPRE presente con `ownerId: string`. `PGRST116` (0 rows) → null/404, no error 500.

### Exemplar 4: Best-effort fire-and-forget en call-site
**Archivo**: `src/services/orchestrate.ts:437-473`
**Usar para**: los 4 call-sites de emisión.
**Patrón clave**: el `chargeProtocolFee` está en L437-452; el `eventService.track({...}).catch(err => console.error(...))` (L457-473) es el patrón fire-and-forget exacto a espejar (`.catch` que solo loguea, jamás interrumpe el `return`).

### Exemplar 5: Call-site master debit (linaje completo)
**Archivo**: `src/middleware/a2a-key.ts:788-816`
**Usar para**: emisión `budget_debit` master.
**Patrón clave**: tras `const debitResult = await budgetService.debit(keyRow.id, chainId, estimatedCostUsd);` (L788-792) y `if (!debitResult.success)` (L793) — en el camino de éxito están `keyRow.id`, `keyRow.owner_ref`, `chainId`, `estimatedCostUsd` en scope. Insertar el `receiptService.emit({...}).catch(warn)` tras `debitResult.success` (~L816, antes de "8. Augment request").

### Exemplar 6: Call-sites budget.debit (key-session / delegation)
**Archivo**: `src/services/budget.ts:79-139`
**Usar para**: emisión `budget_debit` en las 2 rutas con owner_ref.
**Patrón clave**: ruta key-session tiene `keySessionContext{sessionId, ownerRef, keyId}` → emitir tras `return { success: true };` (L88). Ruta delegation tiene `delegationContext{delegationId, ownerRef, keyId}` → emitir tras `return { success: true };` (L139). **Ruta master (L182-194) NO emite** (sin owner_ref). **NO ampliar la firma de `debit`** (CD-7).

### Exemplar 7: Migración tabla + RPC FOR UPDATE/advisory + hardening
**Archivo**: `supabase/migrations/20260603000000_a2a_key_sessions.sql:1-23` (tabla+índices), `:28-88` (RPC con lock), `:90-96` (hardening)
**Usar para**: la migración (copiar el SQL textual de este doc — no re-derivar).
**Patrón clave**: `CREATE TABLE IF NOT EXISTS` con `gen_random_uuid()`, `NUMERIC(20,8)`, `TIMESTAMPTZ DEFAULT now()`, FKs `ON DELETE`; RPC `SECURITY DEFINER`; hardening `ALTER ... SET search_path` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role`. El RPC de receipts usa `pg_advisory_xact_lock(hashtext(owner_ref))` en vez de `FOR UPDATE` (no hay fila "cabeza de cadena" que lockear).

### Exemplar 8: Router REST + ownership + 404 disclosure-safe
**Archivo**: `src/routes/auth.ts:1102-1113` (GET ownership), `:1194-1233` (DELETE con 404 disclosure-safe)
**Usar para**: `src/routes/receipts.ts`.
**Patrón clave**: `resolveCallerKey(req)` → gate `is_active` → `service.list(callerKey.owner_ref)`; error class (p.ej. not-found) → `reply.status(404).send({ error_code: '...' })` sin revelar existencia cross-owner. `FastifyPluginAsync` + `export default`.

### Exemplar 9: Registro del router
**Archivo**: `src/index.ts:18-29` (imports), `:101-127` (registros con prefix)
**Usar para**: registrar `receiptsRoutes`.
**Patrón clave**: `import authRoutes from './routes/auth.js';` (L19) + `await fastify.register(authRoutes, { prefix: '/auth' });` (L121). Espejar para receipts.

---

## Constraint Directives

### OBLIGATORIO
- **CD-A (HMAC):** `createHmac('sha256', secret).update(canonical,'utf8').digest('hex')`. `verify` valida hex y compara sin throw (`timingSafeEqual` length-checked o `===` sobre hex de igual largo). NUNCA throw en verify.
- **CD-B (fire-and-forget):** `receiptService.emit` se invoca SIEMPRE como `.catch(e => console.warn('[receipts] emit failed', e instanceof Error ? e.message : e))`. NUNCA con `await` que bloquee el path de pago.
- **CD-C (hardening RPC):** `insert_receipt` lleva `SET search_path = public, pg_temp` + `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role`.
- **CD-D (ownerRef no-vacío):** `EmitReceiptInput.ownerRef` es `string` no-vacío; si el call-site no lo tiene → NO llama emit (skip). Nunca inserta owner_ref vacío.

### PROHIBIDO
- **CD-1:** la emisión NUNCA bloquea ni lanza excepción que interrumpa el pago/débito. Cualquier fallo → SOLO WARN.
- **CD-2 (append-only, excepción acotada):** `receipt.ts` NUNCA hace `UPDATE`/`DELETE` sobre `a2a_receipts`, **EXCEPTO** el UPDATE-once que escribe `receipt_hash` por primera vez (`.eq('id', id).eq('receipt_hash', '')`). Ese UPDATE: (a) toca SOLO la columna `receipt_hash`; (b) solo aplica a filas con `receipt_hash = ''`; (c) jamás re-escribe un hash ya seteado. Cero DELETE.
- **CD-3 (Ownership Guard):** todo SELECT sobre `a2a_receipts` desde `receipt.ts` incluye `.eq('owner_ref', ownerRef)` con `ownerRef: string` (nunca `string | undefined`). Ausencia = BLOQUEANTE (igual WKH-53). `list`, `getById`, `verify` lo cumplen.
- **CD-4 (secret):** `RECEIPT_SIGNING_SECRET` NUNCA se loguea, expone en HTTP, ni se persiste en DB (ni vía `current_setting`/`SET LOCAL`). El HMAC se computa app-side; el secret NUNCA va a Postgres. `verify` muestra hashes, nunca el secret.
- **CD-5 (TS strict):** sin `any`. `ReceiptRow` modela exactamente las columnas; `amount_usd` (NUMERIC) tipado como `string`; nullables como `T | null`.
- **CD-6 (aditivo):** NO modificar schema de `a2a_events`/`a2a_protocol_fees`, NI las firmas/retorno de `chargeProtocolFee`/`budgetService.debit`. **NO tocar `fee-charge.ts`** (la emisión fee vive en el call-site `orchestrate.ts`). Integración estrictamente aditiva.
- **CD-7 (aridad de `debit`):** PROHIBIDO ampliar la aridad de `budgetService.debit` o de los `*DebitContext`. La emisión usa el contexto ya existente; el path master emite desde el call-site (`a2a-key.ts`). **NO romper aserciones `toHaveBeenCalledWith` de `debit`** (~11 tests). [auto-blindaje WKH-121]
- **CD-8 (sin fanout de tipos):** los tipos nuevos viven en `src/types/receipt.ts`. NO agregar campos requeridos a row-types existentes (`A2AAgentKeyRow`/`KeySessionRow`/`*Row`) → cero fanout esperado. [auto-blindaje WKH-123]
- **CD-9 (orden de herramientas):** SIEMPRE `npm run format` ANTES de `npm run lint` al agregar imports (biome organizeImports). Orden: **format → lint → tsc**. [auto-blindaje WKH-123]

---

## Anti-Hallucination Checklist (específico WKH-124)

Antes de dar por terminada cada wave, verificar:

- [ ] **best-effort:** cada call-site invoca `receiptService.emit(...).catch(warn)` — NUNCA con `await` bloqueante. Un fallo de emisión NO cambia el `return` del pago/débito (CD-1, AC-6). Test: emit rechaza → el pago/débito sigue OK.
- [ ] **append-only:** `receipt.ts` NO tiene ningún `.delete()` ni `.update()` sobre `a2a_receipts` SALVO el UPDATE-once `.update({receipt_hash}).eq('id',id).eq('receipt_hash','')` (CD-2).
- [ ] **Ownership Guard:** `list`, `getById`, `verify` filtran `.eq('owner_ref', ownerRef)` con `ownerRef: string` (no `string | undefined`) (CD-3). Cross-owner → 404 (AC-8).
- [ ] **secret:** `RECEIPT_SIGNING_SECRET` NUNCA aparece en `console.*`/`logger.*`/`reply`. **NUNCA se pasa a un `supabase.rpc(...)` ni a SQL** (HMAC computado SOLO en Node). `verify` expone `computed_hash`/`stored_hash`, jamás el secret (CD-4).
- [ ] **firma de `debit` intacta:** la firma de `budgetService.debit` y los `*DebitContext` NO cambian. `grep -rn "toHaveBeenCalledWith" src/services/budget.test.ts src/services/compose*.test.ts src/services/orchestrate*.test.ts` → ninguna assertion de aridad rota (CD-7).
- [ ] **tipos aislados:** los tipos nuevos están SOLO en `src/types/receipt.ts`; NO se agregó ningún campo requerido a row-types existentes (CD-8).
- [ ] **NUMERIC→string:** `amount_usd` se tipa `string`; el canonical lo normaliza con `Number(value).toFixed(8)` (DT-5).
- [ ] **determinismo:** firma y verify usan EXACTAMENTE el mismo `buildCanonicalPayload` (keys `.sort()`, `toFixed(8)`, `toISOString()`, `JSON.stringify` con `null` literal). Test de round-trip verde.
- [ ] **disclosure-safe:** `:id` de otro owner → `getById` retorna null → 404 (no revela existencia) (AC-8).
- [ ] **migración:** usa `20260605000000` (último existente es `20260604000000`) y trae su `_down.sql` con `DROP FUNCTION` + `DROP TABLE`.
- [ ] **router registrado:** `import receiptsRoutes` + `register(..., { prefix:'/receipts' })` en `index.ts`.
- [ ] **orden de herramientas:** `npm run format` ANTES de `npm run lint`, luego `tsc` (CD-9).
- [ ] **TS strict:** sin `any`, sin `as unknown`. Todas las interfaces nuevas tipadas.

---

## Test Expectations (≥1 por AC)

| Test | AC / objetivo | Framework | Tipo |
|------|----------------|-----------|------|
| `receipt.test`: `computeReceiptHash` produce hex 64-char determinista para canonical fijo | AC-3 | Vitest | unit |
| `receipt.test`: `buildCanonicalPayload` ordena keys alfabético + normaliza amount (`toFixed(8)`), created_at (ISO), null → `null` literal | AC-3 / DT-5 | Vitest | unit |
| `receipt.test`: `verify` con row no manipulado → `{valid:true, computed==stored}` | AC-4 | Vitest | unit |
| `receipt.test`: `verify` con `amount_usd` alterado → `{valid:false, tamper_detected:true}` | AC-5 | Vitest | unit |
| `receipt.test`: `emit` con `RECEIPT_SIGNING_SECRET` unset → NO inserta, WARN, NO throw | AC-6 / DT-6 | Vitest | unit |
| `receipt.test`: `emit` con RPC que rechaza → `.catch` absorbe, NO throw (best-effort) | AC-6 / CD-1 | Vitest | unit |
| `receipt.test`: `list(ownerA)` aplica `.eq('owner_ref', ownerA)` (mock present) | AC-7 / CD-3 | Vitest | unit |
| `receipts.route.test`: `GET /receipts/:id/verify` owner-match → 200 `{valid:true}` | AC-4 | Vitest | integration |
| `receipts.route.test`: tamper → 200 `{valid:false, tamper_detected:true}` | AC-5 | Vitest | integration |
| `receipts.route.test`: `:id` de otro owner → 404 (disclosure-safe) | AC-8 | Vitest | integration |
| `receipts.route.test`: `GET /receipts` filtra por owner del caller | AC-7 | Vitest | integration |
| call-site test (orchestrate o receipt): fee `charged` → `emit` con `receipt_type:'protocol_fee'`, counterparty=fee wallet | AC-1 | Vitest | unit/integration |
| call-site test: `emit` rechaza → la respuesta del orchestrate/charge sigue OK | AC-1 / AC-6 | Vitest | unit/integration |
| call-site test (budget/a2a-key): debit success master → `emit` `budget_debit` desde call-site, sin romper `toHaveBeenCalledWith` de `debit` | AC-2 / CD-7 | Vitest | unit/integration |
| call-site test (budget): debit success key-session y delegation → `emit` con `session_id`/`delegation_id` respectivos | AC-2 | Vitest | unit |
| call-site test (budget): emit rechaza → `debit` sigue devolviendo `{success:true}` | AC-2 / AC-6 | Vitest | unit |

> **Mocks supabase:** `vi.mock('../lib/supabase.js')` con `{ from: vi.fn(), rpc: vi.fn() }` (patrón de los services existentes). Env de test: setear `RECEIPT_SIGNING_SECRET` en `beforeEach`; usar `delete process.env.RECEIPT_SIGNING_SECRET` (NO `= undefined`) para el caso de ausencia.

### Criterio Test-First

| Tipo de cambio | Test-first? |
|----------------|-------------|
| `receipt.ts` (HMAC + canonical + verify) | Sí |
| router / emisión en call-sites | Sí |
| migración SQL / `.env.example` | No |
| tipos | No (cubiertos por tests de consumidores) |

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN deben existir:
ls src/services/budget.ts src/middleware/a2a-key.ts src/services/orchestrate.ts \
   src/services/event.ts src/services/signed-auth.ts src/services/llm/transform-hmac.ts \
   src/routes/auth.ts src/index.ts \
   supabase/migrations/20260603000000_a2a_key_sessions.sql \
   supabase/migrations/20260604000000_wkh123_signed_auth.sql 2>/dev/null || echo "FALTA archivo base"
# Confirmar que la migración nueva NO existe aún:
ls supabase/migrations/20260605000000_a2a_receipts.sql 2>/dev/null && echo "YA EXISTE — revisar"
# tsc baseline limpio:
npx tsc --noEmit && echo "tsc baseline OK"
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.

### Wave 0 — Serial Gate (contratos, migración, tipos, env)
- [ ] **W0.1** `src/types/receipt.ts` (Archivo #1) → `ReceiptType`, `ReceiptRow`, `EmitReceiptInput`, `VerifyReceiptResult`, `ReceiptListItem`. → `tsc`.
- [ ] **W0.2** `supabase/migrations/20260605000000_a2a_receipts.sql` (Archivo #2) → tabla + índice `(owner_ref, created_at DESC)` + RPC `insert_receipt` + hardening (SQL textual — copiar tal cual).
- [ ] **W0.3** `supabase/migrations/20260605000000_a2a_receipts_down.sql` (Archivo #3) → `DROP FUNCTION` + `DROP TABLE`.
- [ ] **W0.4** Documentar `RECEIPT_SIGNING_SECRET` en `.env.example` / project-context env list (sin valor).
- Verificación: `npx tsc --noEmit` pasa.

### Wave 1 — Service (depende de W0)
- [ ] **W1.1** `src/services/receipt.ts` (Archivo #4) → `buildCanonicalPayload` (DT-5 exacto), `computeReceiptHash`, `emit` (RPC insert → leer row → hash → UPDATE-once; best-effort, nunca throw), `verify`, `list`, `getById` (todos con Ownership Guard CD-3). → Exemplars 1, 2, 3.
- [ ] **W1.2** (test-first) `src/services/receipt.test.ts` (Archivo #10).
- Verificación: `tsc` + `receipt.test.ts` verdes.

### Wave 2 — Integración best-effort (depende de W1)
- [ ] **W2.1** `src/services/budget.ts` (Archivo #6): emisión `budget_debit` en ruta key-session (~L88) y delegation (~L139), `.catch(warn)`. Master NO se toca aquí. → Exemplar 6.
- [ ] **W2.2** `src/middleware/a2a-key.ts` (Archivo #7): emisión `budget_debit` master tras `debitResult.success` (~L816), con `keyRow.owner_ref/id`, `chainId`. → Exemplar 5. (CD-9: format antes de lint por el import nuevo.)
- [ ] **W2.3** `src/services/orchestrate.ts` (Archivo #8): emisión `protocol_fee` tras `feeResult.status === 'charged'` (~L448), con `request.a2aKeyRow.owner_ref/id`, `request.chainId`, `feeResult.txHash`, `feeUsdc`, fee wallet de env, `orchestrationId`. → Exemplar 4. (`fee-charge.ts` NO se toca.)

### Wave 3 — Router + registro (depende de W1)
- [ ] **W3.1** `src/routes/receipts.ts` (Archivo #5): `GET /receipts`, `GET /receipts/:id`, `GET /receipts/:id/verify`. `resolveCallerKey` reusado. → Exemplar 8.
- [ ] **W3.2** `src/index.ts` (Archivo #9): `import receiptsRoutes` + `register(receiptsRoutes, { prefix:'/receipts' })`. → Exemplar 9.
- [ ] **W3.3** `src/routes/receipts.test.ts` (Archivo #11).

### Wave 4 — Verificación final
- [ ] **W4.1** `npx tsc --noEmit` → 0 errores (TS strict, sin `any`).
- [ ] **W4.2** **format ANTES de lint**, luego lint (CD-9).
- [ ] **W4.3** suite completa verde — **sin romper WKH-101 / WKH-121 / WKH-122 / WKH-123** (especialmente las aserciones de aridad de `budgetService.debit`, CD-7).
- [ ] **W4.4** los 8 ACs cubiertos por al menos un test cada uno.

### Dependencias
| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.1 | W0.1, W0.2 | tipos + RPC |
| W2.* | W1.1 | usa `receiptService.emit` |
| W3.* | W1.1 | usa `receiptService.list/getById/verify` |
| W4.* | W1–W3 | testea todo |

### Verificación Incremental
| Wave | Verificación |
|------|--------------|
| W0 | `tsc --noEmit` |
| W1 | `tsc` + `receipt.test.ts` |
| W2 | `tsc` + tests budget/a2a-key/orchestrate (sin romper aridad) |
| W3 | `tsc` + `receipts.route.test.ts` |
| W4 | tsc 0 + format→lint + suite completa verde + 8 ACs |

---

## Done Definition

- `npx tsc --noEmit` → **0 errores** (TS strict, sin `any`).
- **format ANTES de lint**; lint limpio.
- Suite completa verde, **sin romper WKH-101 / WKH-121 / WKH-122 / WKH-123**.
- La firma de `budgetService.debit` / `chargeProtocolFee` intacta (CD-6/CD-7); `fee-charge.ts` sin diff.
- `RECEIPT_SIGNING_SECRET` nunca logueado, expuesto en HTTP, ni enviado a Postgres (CD-4, verificado en test).
- `receipt.ts` append-only salvo el UPDATE-once de `receipt_hash=''` (CD-2).
- Los **8 ACs** cubiertos por al menos un test cada uno.
- Migración `20260605000000_a2a_receipts.sql` + `_down.sql` aditiva y reversible; router registrado en `index.ts`.

---

## Out of Scope

> Dev NO toca bajo ninguna circunstancia:

- `src/services/fee-charge.ts` (la emisión fee vive en el call-site `orchestrate.ts`, DT-3a).
- La firma/retorno de `budgetService.debit`, `chargeProtocolFee`, los `*DebitContext` (CD-6/CD-7).
- Schema de `a2a_events` / `a2a_protocol_fees`.
- Anclaje on-chain / Merkle root (WKH-124b).
- Endpoint de verificación de cadena completa `/receipts/:id/chain` (scope futuro; MVP = verify individual).
- Webhook / notificación de recibo; UI/Dashboard; backfill retroactivo; revocación de recibos.
- RLS Postgres (WKH-SEC-02).
- NO "mejorar" código adyacente ni refactors no solicitados.

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar. No asumir.

Escalar si: un exemplar ya no existe en esos rangos; las líneas de inserción de un call-site difieren del rango indicado (~L88/~L139/~L816/~L448); la tabla/columna/RPC no coincide con lo esperado; ampliar la firma de `debit` parece necesario (NO lo es — CD-7); un test exige tocar archivos fuera de la tabla "Files to Modify/Create".

---

*Story File generado por NexusAgil — F2.5 — WKH-124*
