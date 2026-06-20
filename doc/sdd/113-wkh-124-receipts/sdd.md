# SDD #113: [WKH-124] KEY-RECEIPTS — Recibos inmutables HMAC-encadenados + verify endpoint

> SPEC_APPROVED: no
> Fecha: 2026-06-19
> Tipo: feature (security)
> SDD_MODE: full
> Branch: feat/113-wkh-124-receipts
> Artefactos: doc/sdd/113-wkh-124-receipts/
> Épica: E16 (KEY-RECEIPTS)

---

## 1. Resumen

Se agrega un **recibo inmutable por pago exitoso** que captura el linaje completo
(`session_id → agent_key_id → owner_ref`) más los detalles del cobro (monto,
chain, tx_hash, counterparty, timestamp), encadenado por owner mediante
`prev_receipt_hash` (ledger-style) y firmado server-side con HMAC-SHA256
(`receipt_hash = HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical_json)`).

La emisión es **best-effort / fire-and-forget** en dos puntos: (a) al confirmarse
`chargeProtocolFee → status:'charged'`; (b) al confirmarse un débito de budget en
las 3 rutas (master / delegation / key-session). Un fallo de emisión **NUNCA**
interrumpe el flujo de pago. Se expone `GET /receipts`, `GET /receipts/:id` y
`GET /receipts/:id/verify` (este último recomputa el hash y reporta tamper). El
anclaje on-chain (Merkle root) se difiere a WKH-124b.

**Resultado esperado:** evidencia verificable y tamper-evident de "quién autorizó
qué", portable para disputas, sin gas ni latencia de bloque.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 113 (WKH-124) |
| **Tipo** | feature / security |
| **SDD_MODE** | full |
| **Objetivo** | Recibos inmutables HMAC-encadenados (append-only) emitidos best-effort en settlement + endpoint de verificación. |
| **Reglas de negocio** | Append-only; best-effort (no rompe el pago); Ownership Guard en toda lectura; secret nunca expuesto; integración estrictamente aditiva. |
| **Scope IN** | Ver §6 IN |
| **Scope OUT** | Ver §6 OUT |
| **Missing Inputs** | Resueltos en §10 (counterparty, índice, scope verify). |

### Acceptance Criteria (EARS) — heredados del work-item

1. **AC-1**: WHEN `chargeProtocolFee` retorna `{ status:'charged', txHash }`, THEN el sistema SHALL emitir un recibo `protocol_fee` con `{ agent_key_id?, owner_ref?, session_id:null, amount_usd:feeUsdc, chain_id, tx_hash, counterparty:WASIAI_PROTOCOL_FEE_WALLET, orchestration_id, receipt_type:'protocol_fee' }` antes de retornar el resultado al caller (best-effort, AC-6).
2. **AC-2**: WHEN un débito de budget se confirma exitoso en cualquiera de las 3 rutas (master / delegation / key-session), THEN el sistema SHALL emitir un recibo `budget_debit` con el linaje disponible (`agent_key_id`, `owner_ref`, `session_id?`, `delegation_id?`, `amount_usd`, `chain_id`, `counterparty:null`) como best-effort (SHALL NOT propagar fallo de emisión al resultado del débito).
3. **AC-3**: WHEN se crea un recibo, THEN el sistema SHALL computar `receipt_hash = HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical_payload)` donde `canonical_payload` incluye todos los campos + `prev_receipt_hash` (null-safe: literal `"null"` en JSON), y persistirlo como append-only (sin UPDATE/DELETE).
4. **AC-4**: WHEN `GET /receipts/:id/verify` se llama con id válido Y `owner_ref` del caller == `owner_ref` del recibo, THEN el sistema SHALL recomputar el hash de los campos almacenados, compararlo con el almacenado, y retornar `{ valid:true, receipt_id, computed_hash, stored_hash }` si coinciden.
5. **AC-5**: IF `verify` detecta mismatch (`computed_hash !== stored_hash`), THEN SHALL retornar `{ valid:false, receipt_id, tamper_detected:true }` con HTTP 200.
6. **AC-6**: IF la emisión falla (insert error, secret faltante, o cualquier excepción), THEN SHALL loguear WARN y retornar el resultado original sin cambios — el flujo de pago SHALL NOT interrumpirse.
7. **AC-7**: WHEN `GET /receipts` lo llama un caller autenticado, THEN SHALL retornar SOLO recibos donde `owner_ref` == caller (`.eq('owner_ref', callerOwnerRef)` OBLIGATORIO).
8. **AC-8**: WHEN `GET /receipts/:id/verify` (o `GET /receipts/:id`) se llama y el `owner_ref` del recibo NO coincide con el del caller, THEN SHALL retornar 404 (disclosure-safe).

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/fee-charge.ts` | Punto de emisión AC-1 | El éxito está en `chargeProtocolFee` L276-297: `UPDATE status:'charged'` (L278-286) y `return { status:'charged', feeUsdc, txHash }` (L297). Datos disponibles: `orchestrationId` (param), `txHash` (settle), `feeUsdc`, `walletAddress`=`WASIAI_PROTOCOL_FEE_WALLET` (L169). **NO hay `agent_key_id`/`owner_ref`/`chainId` en este scope** (chargeProtocolFee solo recibe `{orchestrationId, budgetUsdc, feeRate}`). Patrón best-effort interno: `try/catch` que jamás rechaza (CD-B). |
| `src/services/budget.ts` | Punto de emisión AC-2 (3 rutas) | `debit()` L70-194. **Ruta key-session** (L79-122): tiene `keySessionContext` con `sessionId, ownerRef, keyId` + `chainId, amountUsd`. **Ruta delegation** (L125-180): tiene `delegationContext` con `delegationId, ownerRef, keyId` + `chainId, amountUsd`. **Ruta master** (L182-194): SOLO `keyId, chainId, amountUsd` — **NO tiene `ownerRef`** (ni `sessionId`/`delegationId`). Lección clave abajo (DT-3). |
| `src/middleware/a2a-key.ts` | Call-site del step 0 de débito con linaje completo | `requirePaymentOrA2AKey` L243-846. Step 0 master debita en L788-792 (`budgetService.debit(keyRow.id, chainId, estimatedCostUsd)`) y TIENE `keyRow.owner_ref` (L799). Branch delegation L373-379 y branch session L576-582 debitan vía `delegationService`/`keySessionService` (NO vía `budgetService.debit`) y tienen `parentKey.owner_ref`, `delegation.id`/`session.id`, `chainId`. `request.a2aKeyRow` decorado (L57). |
| `src/services/orchestrate.ts` | Call-site del fee + best-effort pattern de referencia | L437-441 llama `chargeProtocolFee({orchestrationId, budgetUsdc, feeRate})`; `request.a2aKeyRow` (owner_ref, key.id) y `request.chainId` están en scope del route. `eventService.track(...).catch(...)` L457-473 = patrón fire-and-forget a espejar. |
| `src/services/event.ts` | Patrón fire-and-forget de servicio Supabase insert | `eventService.track` L52-85: `Partial<Row>` con `?? null`, `.insert(row).select().single()`, `throw` interno; el caller hace `.catch(warn)`. `EventRow` interface tipada (CD-1). |
| `src/services/llm/transform-hmac.ts` | Patrón HMAC a reusar | `createHmac('sha256', key).update(str).digest('hex')` (L41); verify con `timingSafeEqual`, rechazo de hex malformado ANTES de `Buffer.from` (L69-83). NUNCA throw en verify. |
| `src/services/signed-auth.ts` | HMAC reciente (WKH-123) + canonical string | `verifyHmacRequestSignature` L166-194: canonical determinista con `\n` separator (L181), `createHmac(...).digest()`, `timingSafeEqual` con length-check previo. Patrón de env fail-safe (L68-89). |
| `src/index.ts` | Registro de router | `await fastify.register(authRoutes, { prefix: '/auth' })` L121. Patrón: import default L18-29, register con prefix L101-127. |
| `src/routes/auth.ts` | Router REST + ownership + middleware | `resolveCallerKey(request)` L113-142 (lookup por hash de `x-a2a-key`/`Bearer wasi_a2a_*` → `A2AAgentKeyRow`). Patrón GET con ownership en service: `delegationService.list(callerKey.owner_ref)` L1110. Patrón disclosure-safe 404: `SessionNotFoundError → 404` L1219-1221. `FastifyPluginAsync` + `export default`. |
| `supabase/migrations/20260603000000_a2a_key_sessions.sql` | Patrón tabla + RPC atómico FOR UPDATE + hardening | `CREATE TABLE IF NOT EXISTS` con `gen_random_uuid()`, `NUMERIC(20,8)`, `TIMESTAMPTZ DEFAULT now()`, FKs `REFERENCES ... ON DELETE`. RPC `debit_session_and_parent` L28-88: `SELECT ... FOR UPDATE` (L44-49), Ownership Guard DB-layer (L56-61), hardening `SET search_path` + `REVOKE/GRANT` L91-96. |
| `supabase/migrations/20260604000000_wkh123_signed_auth.sql` | Patrón última migración + índice + down | `CREATE TABLE IF NOT EXISTS` + `CONSTRAINT uq_... UNIQUE(...)` + `CREATE INDEX IF NOT EXISTS`. Última migración = `20260604000000`. Down (`..._down.sql`): `DROP TABLE IF EXISTS` + `ALTER ... DROP COLUMN IF EXISTS`. |
| `src/types/index.ts`, `src/types/a2a-key.ts` | Dónde poner tipos | `DelegationDebitContext` (a2a-key.ts L245-250), `KeySessionDebitContext` (L351-355). `A2AAgentKeyRow` con `owner_ref`. NUMERIC de Supabase llega como `string` (CD-5 / `budget` es `Record<string,string>`). |
| `src/services/identity.ts` | Resolver owner_ref por keyId (ruta master) | `identityService.lookupByHash` existe; los métodos filtran por `owner_ref`. **No hay** un `getOwnerRefById(keyId)` público hoy → ver DT-3 (la emisión master NO se hace dentro de budget.debit). |
| `doc/sdd/110-wkh-121-key-sessions/auto-blindaje.md`, `112-wkh-123-signed-auth/auto-blindaje.md`, `101-.../auto-blindaje.md` | Aprendizaje de errores recurrentes | Ver CD-7, CD-8, CD-9 abajo. |

### Exemplars (verificados con Glob/Read — paths reales)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/services/receipt.ts` (HMAC + canonical) | `src/services/signed-auth.ts:166-194`, `src/services/llm/transform-hmac.ts:34-84` | `createHmac('sha256').update().digest('hex')`, hex-validate, `timingSafeEqual`, nunca throw en verify. |
| `src/services/receipt.ts` (insert best-effort) | `src/services/event.ts:52-85` | `Partial<Row>` + `?? null`, `.insert().select().single()`, tipado, caller hace `.catch`. |
| `src/services/receipt.ts` (ownership read) | `src/services/budget.ts:42-59` (`.eq('owner_ref', ownerId)`), `src/routes/auth.ts:1110` | Ownership Guard obligatorio (CD-3). |
| `src/routes/receipts.ts` | `src/routes/auth.ts:113-142,1102-1113,1194-1233` | `resolveCallerKey`, `FastifyPluginAsync`, GET ownership, 404 disclosure-safe. |
| `supabase/migrations/20260605000000_a2a_receipts.sql` | `20260603000000_a2a_key_sessions.sql:1-23`, RPC L28-96 | Tabla + índices + RPC atómico FOR UPDATE + hardening. |
| `..._a2a_receipts_down.sql` | `20260604000000_wkh123_signed_auth_down.sql` | `DROP FUNCTION` + `DROP TABLE IF EXISTS`. |
| Emisión en `fee-charge.ts` / call-sites | `src/services/orchestrate.ts:457-473` | `.track(...).catch(err => console.error(...))` fire-and-forget. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_agent_keys` | Sí | `id` (UUID PK), `owner_ref` (TEXT) |
| `a2a_key_sessions` | Sí | `id` (UUID PK), `owner_ref`, `key_id` |
| `a2a_delegations` | Sí | `id` (UUID PK) (referenciada por FK) |
| `a2a_protocol_fees` | Sí | `orchestration_id` (PK), `status`, `tx_hash` (NO se modifica, CD-6) |
| `a2a_receipts` | **No (se crea)** | Ver DT-4 |

### Componentes reutilizables

- `supabase` client en `src/lib/supabase.js` (usa SERVICE_KEY → bypassa RLS → ownership en app-layer, CD-3).
- `createHmac`/`timingSafeEqual` de `node:crypto` (ya en uso).
- `resolveCallerKey` (auth.ts) — reusar para el router de receipts.
- Patrón env fail-safe (`signed-auth.ts:68-89`).

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `supabase/migrations/20260605000000_a2a_receipts.sql` | Crear | Tabla `a2a_receipts` append-only + índices + RPC `insert_receipt` (DT-2) + hardening | `20260603000000_a2a_key_sessions.sql` |
| `supabase/migrations/20260605000000_a2a_receipts_down.sql` | Crear | `DROP FUNCTION insert_receipt` + `DROP TABLE a2a_receipts` | `..._wkh123_signed_auth_down.sql` |
| `src/types/receipt.ts` | Crear | `ReceiptType`, `ReceiptRow`, `EmitReceiptInput`, `VerifyReceiptResult`, `ReceiptListItem` | `src/types/a2a-key.ts` |
| `src/services/receipt.ts` | Crear | `receiptService.emit`, `verify`, `list`, `getById` + `buildCanonicalPayload`, `computeReceiptHash` | `event.ts`, `signed-auth.ts`, `transform-hmac.ts` |
| `src/services/fee-charge.ts` | Modificar | Emisión best-effort `protocol_fee` tras `status:'charged'` (DT-3a) | `orchestrate.ts:457-473` |
| `src/services/budget.ts` | Modificar (ver DT-3) | Emisión best-effort `budget_debit` en las rutas delegation + key-session (que SÍ tienen owner_ref); la ruta master se emite desde el call-site del middleware (DT-3) | `event.ts` patrón |
| `src/middleware/a2a-key.ts` | Modificar | Emisión best-effort `budget_debit` master tras debit step 0 exitoso (tiene `keyRow.owner_ref`) | `orchestrate.ts:457-473` |
| `src/routes/receipts.ts` | Crear | `GET /receipts`, `GET /receipts/:id`, `GET /receipts/:id/verify` | `auth.ts` |
| `src/index.ts` | Modificar | `import receiptsRoutes` + `register(..., { prefix:'/receipts' })` | `index.ts:121` |
| `src/services/receipt.test.ts` | Crear | Unit: hash, canonical, verify match/tamper, ownership, secret-missing skip | `signed-auth.test.ts` (si existe) |
| `src/routes/receipts.test.ts` | Crear | e2e: list ownership, verify 200/404, tamper | `auth.*.test.ts` |
| `src/services/fee-charge.test.ts` | Modificar | AC-1 emisión + AC-6 best-effort no rompe el charge | existente |
| `src/middleware/a2a-key.test.ts` + `src/services/budget.test.ts` | Modificar | AC-2 emisión en 3 rutas + best-effort | existentes |

### 4.2 Modelo de datos

**Tabla `a2a_receipts`** (DT-4). Decisión de índice resuelta en DT-2/§10.

```sql
CREATE TABLE IF NOT EXISTS a2a_receipts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref          TEXT NOT NULL,                                   -- Ownership Guard (CD-3)
  agent_key_id       UUID REFERENCES a2a_agent_keys(id) ON DELETE SET NULL,  -- ver DT-3: nullable
  session_id         UUID REFERENCES a2a_key_sessions(id) ON DELETE SET NULL,
  delegation_id      UUID REFERENCES a2a_delegations(id) ON DELETE SET NULL,
  receipt_type       TEXT NOT NULL CHECK (receipt_type IN ('protocol_fee','budget_debit')),
  amount_usd         NUMERIC(20,8) NOT NULL,
  chain_id           INT NOT NULL,
  tx_hash            TEXT,
  counterparty       TEXT,
  orchestration_id   TEXT,
  prev_receipt_hash  TEXT,                                            -- NULL en el primer recibo del owner
  receipt_hash       TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DT-2: índice para "último recibo del owner" (chain prev_receipt_hash) y para list (AC-7).
CREATE INDEX IF NOT EXISTS idx_a2a_receipts_owner_created
  ON a2a_receipts (owner_ref, created_at DESC);
```

> **Cambio vs work-item DT-4**: `agent_key_id` pasa de `NOT NULL` a **nullable** (`ON DELETE SET NULL`). Razón: en el path `protocol_fee` (AC-1) `chargeProtocolFee` NO tiene `agent_key_id` en scope (ver Context Map). Forzar NOT NULL rompería la emisión del fee → contradiría AC-1. La integridad del recibo la garantiza `receipt_hash`, no la NOT-NULL constraint. `owner_ref` SÍ es NOT NULL (es la clave de la cadena y del Ownership Guard); cuando el path no tiene owner_ref disponible, **no se emite** (skip best-effort), nunca se inserta con owner_ref vacío.

### 4.3 Servicios — `receiptService`

```
buildCanonicalPayload(fields) -> string      // DT-5 (algoritmo exacto abajo)
computeReceiptHash(canonical) -> string|null // HMAC-SHA256 hex; null si secret unset
emit(input: EmitReceiptInput) -> Promise<void>   // best-effort; NUNCA throw (CD-1)
verify(id, ownerRef) -> Promise<VerifyReceiptResult>  // recomputa + compara
list(ownerRef) -> Promise<ReceiptListItem[]>     // Ownership Guard (CD-3)
getById(id, ownerRef) -> Promise<ReceiptRow|null> // Ownership Guard; null = 404
```

`EmitReceiptInput` (lo arma cada call-site con su linaje):
```ts
{
  ownerRef: string;            // requerido — sin esto se skippea (no se emite)
  agentKeyId: string | null;
  sessionId: string | null;
  delegationId: string | null;
  receiptType: 'protocol_fee' | 'budget_debit';
  amountUsd: number | string;  // se normaliza a string decimal en canonical
  chainId: number;
  txHash: string | null;
  counterparty: string | null;
  orchestrationId: string | null;
}
```

### 4.4 Flujo principal (Happy Path)

**Emisión protocol_fee (AC-1):**
1. `chargeProtocolFee` confirma `status:'charged'` (fee-charge.ts L297).
2. ANTES del `return`, dispara `receiptService.emit({...}).catch(warn)` fire-and-forget con `counterparty = walletAddress`, `orchestrationId`, `txHash`, `amountUsd = feeUsdc`, `receiptType:'protocol_fee'`, `sessionId:null`. `chainId`/`agentKeyId`/`ownerRef`: ver DT-3a.
3. Retorna `{ status:'charged', feeUsdc, txHash }` sin esperar la emisión.

**Emisión budget_debit (AC-2), por ruta:**
- key-session: dentro de `budget.debit` ruta key-session (budget.ts L88), tras `return {success:true}` se dispara `emit({ ownerRef:keySessionContext.ownerRef, agentKeyId:keySessionContext.keyId, sessionId:keySessionContext.sessionId, delegationId:null, ... }).catch(warn)`.
- delegation: idem en la ruta delegation (budget.ts L139), `delegationId:delegationContext.delegationId, sessionId:null`.
- master: la ruta master de `budget.debit` NO tiene owner_ref → **NO emite ahí**. La emisión master se hace en el call-site `a2a-key.ts` step 0 (L788-816) tras `debitResult.success`, con `keyRow.owner_ref`, `keyRow.id`, `chainId`. (DT-3).

**Emisión interna del hash + cadena (AC-3, DT-2):**
1. `emit` arma `EmitReceiptInput`; si `ownerRef` vacío o `RECEIPT_SIGNING_SECRET` unset → WARN + return (no inserta).
2. Llama RPC `insert_receipt(...)` que, BAJO advisory lock por `owner_ref`: (a) lee el último `receipt_hash` del owner (`ORDER BY created_at DESC LIMIT 1`), (b) recibe el `receipt_hash` ya computado por el service con ese `prev_receipt_hash`, (c) inserta. Ver DT-2 para por qué el hash se computa en el service y el lock vive en el RPC.

**Verificación (AC-4/AC-5/AC-8):**
1. `GET /receipts/:id/verify` → `resolveCallerKey` → `receiptService.verify(id, callerOwnerRef)`.
2. `getById(id, ownerRef)` con `.eq('owner_ref', ownerRef)`. Si null → 404 (AC-8).
3. Recomputa `computeReceiptHash(buildCanonicalPayload(row))`; compara con `row.receipt_hash`.
4. Match → `{valid:true, receipt_id, computed_hash, stored_hash}` (200). Mismatch → `{valid:false, receipt_id, tamper_detected:true}` (200, AC-5).

### 4.5 Flujo de error

- Secret unset en `emit` → WARN, no inserta, el pago continúa (AC-6 / DT-6).
- Insert/RPC falla → `.catch(warn)` en el call-site, el pago continúa (AC-6 / CD-1).
- `verify` con secret unset → `{valid:false, receipt_id, reason:'SIGNING_SECRET_UNAVAILABLE'}` (200, no expone secret; CD-4).
- `:id` de otro owner → `getById` retorna null → 404 (AC-8, disclosure-safe).
- `owner_ref` ausente en el call-site → skip emisión (nunca inserta owner_ref vacío).

---

## 5. Decisiones Técnicas (DT-N)

### DT-1 — Inmutabilidad: HMAC server-side + append-only (heredada, sin cambios)
`receipt_hash = HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical_json)`. Append-only por contrato de app (CD-2). On-chain diferido a WKH-124b.

### DT-2 — Concurrencia de la cadena `prev_receipt_hash`: **opción (a) — `prev` bajo advisory lock en RPC + `receipt_hash` por UPDATE-once** [RESUELVE el riesgo clave]

**Problema:** la emisión es fire-and-forget; dos recibos del mismo `owner_ref` concurrentes podrían leer el mismo último hash y **bifurcar la cadena** (dos recibos con el mismo `prev_receipt_hash`).

**Restricción que fuerza el diseño:** el HMAC requiere `RECEIPT_SIGNING_SECRET`, que vive SOLO en Node, nunca en Postgres (CD-4). Por lo tanto el `receipt_hash` NO puede computarse dentro del RPC, y `lectura-de-prev + cómputo-de-hash + insert` no caben en una sola sentencia de DB. Además PostgREST corre cada `supabase.rpc()` en su propia transacción, así que un `pg_advisory_xact_lock` se libera al volver de la llamada — no se puede mantener el lock entre dos `rpc()` separados.

**Decisión (opción a), 2 pasos, garantía híbrida explícita:**

1. **RPC único `insert_receipt(...)`** (una transacción): toma `pg_advisory_xact_lock(hashtext(p_owner_ref))`, lee `prev_receipt_hash` = `receipt_hash` del último recibo del owner (`ORDER BY created_at DESC LIMIT 1`), INSERTA la fila con ese `prev_receipt_hash` y `receipt_hash = ''` (placeholder, aún sin firmar), y **RETURNS** `(id, prev_receipt_hash, created_at)`. El advisory lock garantiza que el `prev` asignado sea **lineal y sin bifurcación por owner** (dos inserts concurrentes del mismo owner se serializan: el segundo lee el `prev` ya commiteado por el primero).
2. **Service computa el hash** con el canonical que incluye `prev_receipt_hash`, `id` y `created_at` retornados (DT-5), y lo persiste con un **UPDATE-once** `WHERE id = $id AND receipt_hash = ''` (escribe la columna `receipt_hash` por primera y única vez).

**Por qué advisory lock y no `SELECT ... FOR UPDATE`:** no hay una fila canónica "cabeza de cadena" por owner que bloquear (la cabeza cambia en cada insert). `pg_advisory_xact_lock(hashtext(owner_ref))` da exclusión mutua por owner sin esa fila y se libera al COMMIT/ROLLBACK. Es el espíritu del patrón `debit_session_and_parent` (`a2a_key_sessions.sql:44-49`), adaptado a "lock por owner" en vez de "lock por row".

**Esto introduce un UPDATE → se acota CD-2 (no se viola):** el UPDATE toca SOLO `receipt_hash`, SOLO sobre filas con `receipt_hash = ''`, y jamás re-escribe un hash ya seteado. Ninguna otra columna ni fila firmada se modifica nunca. Cero DELETE. (Formalizado en CD-2.)

**Garantía neta del MVP (lo que se promete):**
- **`prev_receipt_hash` lineal y sin bifurcación por owner** (advisory lock) — la cadena es sólida.
- **`receipt_hash` tamper-evident e individual** (HMAC del canonical, incluye `prev_receipt_hash`).
- **Ventana de riesgo:** si el proceso muere entre INSERT(`hash=''`) y UPDATE(hash), queda un recibo con `receipt_hash=''` → `verify` lo reporta `{valid:false, reason:'UNSIGNED'}`. Es best-effort (AC-6): un recibo sin firmar es auditable pero marcado no-válido y nunca rompe el pago.

**Alternativa NO elegida (documentada):** opción (b) sin lock — aceptar que `prev_receipt_hash` puede bifurcar y que la única garantía es el `receipt_hash` individual. **Rechazada:** el valor del feature es el proof-chain; la opción (a) tiene costo bajo (lock por owner, no global) y entrega una cadena real. **No se considera** meter el secret en la DB vía `current_setting`/`SET LOCAL` (viola CD-4, riesgo de leak en logs de Postgres). Decisión CERRADA.

### DT-3 — Puntos de emisión y disponibilidad de `owner_ref` (resuelve la asimetría de las 3 rutas)

`budgetService.debit` tiene 3 rutas con linaje distinto:
- **key-session** (budget.ts L79-122): tiene `keySessionContext{sessionId, ownerRef, keyId}` → **emite dentro de budget.debit**.
- **delegation** (budget.ts L125-180): tiene `delegationContext{delegationId, ownerRef, keyId}` → **emite dentro de budget.debit**.
- **master** (budget.ts L182-194): SOLO `keyId, chainId, amountUsd`, **sin owner_ref** → **NO emite dentro de budget.debit**. La emisión master se hace en el **call-site del middleware** `a2a-key.ts:788-816` tras `debitResult.success`, donde `keyRow.owner_ref`, `keyRow.id`, `chainId` están en scope.

**Por qué no inyectar owner_ref a la firma de `budget.debit`:** auto-blindaje WKH-121 (`110-.../auto-blindaje.md`) documenta que ampliar la aridad de `budgetService.debit` rompe TODAS las aserciones `toHaveBeenCalledWith` en compose/orchestrate/budget tests. CD-6 exige integración aditiva sin tocar la firma de `debit`. Por eso la emisión master vive en el call-site (que ya tiene el linaje), no en la firma.

**DT-3a — protocol_fee:** `chargeProtocolFee` no tiene `agentKeyId/ownerRef/chainId`. Opciones:
- (i) emitir dentro de fee-charge con `agentKeyId:null, ownerRef:???` → sin ownerRef no se puede (owner_ref es NOT NULL). 
- **(ii) elegida:** la emisión del `protocol_fee` se dispara desde el **call-site de orchestrate** (`orchestrate.ts:437-452`), que SÍ tiene `request.a2aKeyRow.owner_ref`, `request.a2aKeyRow.id` y `request.chainId`, justo después de `feeResult.status === 'charged'`. El `txHash`, `feeUsdc`(amount), `counterparty`(=fee wallet, leída de env en el call-site), `orchestrationId` salen del resultado/scope. Esto mantiene fee-charge.ts con su contrato intacto (CD-6) y cumple AC-1 ("antes de retornar al caller" = el route retorna después).

> **Ajuste a AC-1 (documentado):** AC-1 dice "WHEN chargeProtocolFee retorna charged THEN emit". Se cumple semánticamente emitiendo en el call-site inmediato (orchestrate.ts) tras recibir `charged`, porque fee-charge.ts no tiene el linaje (owner/key/chain). El Scope IN del work-item lista `fee-charge.ts`; este SDD lo **reduce**: el cambio efectivo de emisión va en `orchestrate.ts` (call-site) + `a2a-key.ts` + `budget.ts`. `fee-charge.ts` NO se modifica (mejor para CD-6). Marcado en §6.

### DT-4 — Tabla `a2a_receipts` (heredada con 1 cambio)
Igual a work-item DT-4 salvo: `agent_key_id` **nullable** (justificación en §4.2). `CHECK` en `receipt_type`. Índice único `(owner_ref, created_at DESC)`.

### DT-5 — Canonical payload determinista (algoritmo EXACTO) [RESUELTO]

`buildCanonicalPayload(fields)` produce un string byte-a-byte reproducible:

1. Construir un objeto con EXACTAMENTE estas keys (todas siempre presentes):
   `agent_key_id, amount_usd, chain_id, counterparty, created_at, delegation_id, id, orchestration_id, owner_ref, prev_receipt_hash, receipt_type, session_id, tx_hash`.
2. **Orden de keys: alfabético ascendente** (el listado de arriba YA está ordenado; el Dev debe ordenar programáticamente con `Object.keys().sort()`, no confiar en el orden de escritura).
3. **Normalización de valores:**
   - `amount_usd`: **string decimal canónico**. Regla: `Number(amount).toFixed(8)` (8 decimales, igual que `NUMERIC(20,8)`), p.ej. `1.5 → "1.50000000"`. Si el origen ya es string de Supabase, se normaliza con el mismo `toFixed(8)` aplicado a `Number(value)`. (Garantiza que firma [Node] y verify [lee NUMERIC string de Supabase] coincidan.)
   - `chain_id`: número (no string): `2368`.
   - `created_at`: **ISO 8601 UTC** vía `new Date(value).toISOString()` (p.ej. `"2026-06-19T12:34:56.789Z"`). El valor proviene de `now()` de Postgres; el service lo lee del row insertado y lo normaliza con `toISOString()` antes de firmar. **Importante:** el hash se computa DESPUÉS de conocer `created_at` real del row (no antes del insert) — por eso el flujo es INSERT(hash='') → leer row con created_at/id/prev → computar hash → UPDATE (DT-2).
   - `id`, `owner_ref`, `receipt_type`: string tal cual.
   - `agent_key_id, session_id, delegation_id, tx_hash, counterparty, orchestration_id, prev_receipt_hash`: string si presente; **`null` → el literal JSON `null`** (NO la string `"null"`). Aclaración sobre el work-item AC-3 ("null string"): se serializa con `JSON.stringify`, que emite `null` (sin comillas) para `null`. Firma y verify usan el MISMO `JSON.stringify`, por lo que coinciden. (El work-item decía `"null"`; este SDD precisa: JSON `null` literal, consistente en ambos lados — lo que importa es la reproducibilidad, garantizada por usar la misma función.)
4. `canonical = JSON.stringify(orderedObject)` donde `orderedObject` se construye insertando las keys en orden alfabético (V8 preserva orden de inserción para keys string no-numéricas).
5. `receipt_hash = createHmac('sha256', RECEIPT_SIGNING_SECRET).update(canonical, 'utf8').digest('hex')`.

`verify` reconstruye `buildCanonicalPayload` con los MISMOS campos leídos del row (normalizando `amount_usd` con `toFixed(8)` y `created_at` con `toISOString()`) → mismo string → mismo hash. **Determinismo garantizado** porque ambos lados aplican la misma normalización a los valores que Supabase devuelve como string.

### DT-6 — `RECEIPT_SIGNING_SECRET` desde env (heredada)
`process.env.RECEIPT_SIGNING_SECRET`. Unset → `emit` hace WARN + skip (no inserta); `verify` retorna `{valid:false, reason:'SIGNING_SECRET_UNAVAILABLE'}`. Patrón env igual a `WASIAI_PROTOCOL_FEE_WALLET` (fee-charge.ts L169-175). Nunca se loguea ni se serializa (CD-4).

### DT-7 — Endpoint verify autenticado, recompute server-side (heredada)
`GET /receipts/:id/verify` usa `resolveCallerKey`. Recompute server-side; respuesta expone `computed_hash`/`stored_hash` pero NUNCA el secret (CD-4).

### DT-8 — counterparty en budget_debit = `null` [RESUELVE [NEEDS CLARIFICATION]]
El agent slug no llega a `budgetService.debit` ni a los contextos `*DebitContext` hoy. Decisión conservadora: `counterparty = null` en recibos `budget_debit`. NO se amplían firmas ni los DebitContext (respeta CD-6 + auto-blindaje WKH-121). Para `protocol_fee`, `counterparty = WASIAI_PROTOCOL_FEE_WALLET`. Ampliar counterparty con el slug real queda como TD futuro (requiere propagar el slug por la cadena compose→debit).

---

## 6. Constraint Directives

### OBLIGATORIO seguir
- **CD-A**: HMAC con `createHmac('sha256', secret).update(canonical,'utf8').digest('hex')` (patrón `signed-auth.ts`/`transform-hmac.ts`). `verify` valida hex y usa `timingSafeEqual` (length-check previo); NUNCA throw.
- **CD-B**: `receiptService.emit` se invoca SIEMPRE como fire-and-forget `.catch(e => console.warn('[receipts] emit failed', e instanceof Error ? e.message : e))`. Nunca con `await` que bloquee el path de pago.
- **CD-C**: la fn RPC nueva (`insert_receipt`) lleva hardening: `SET search_path = public, pg_temp` + `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role` (patrón `a2a_key_sessions.sql:91-96`).
- **CD-D**: `EmitReceiptInput.ownerRef` es `string` no-vacío; si el call-site no lo tiene → NO llama emit (skip), nunca inserta owner_ref vacío.

### PROHIBIDO
- **CD-1** (heredada): la emisión NUNCA bloquea ni lanza excepción que interrumpa el pago/débito. Cualquier fallo → SOLO WARN.
- **CD-2** (heredada, **con excepción acotada de DT-2**): `receipt.ts` NUNCA hace `UPDATE`/`DELETE` sobre `a2a_receipts`, **EXCEPTO** el UPDATE-once que escribe `receipt_hash` por primera vez (`WHERE id = $id AND receipt_hash = ''`). Ese UPDATE: (a) toca SOLO la columna `receipt_hash`; (b) solo aplica a filas con `receipt_hash = ''` (recién insertadas, aún sin firmar); (c) jamás re-escribe un hash ya seteado. Ninguna otra columna ni fila firmada se modifica jamás. Cero DELETE.
- **CD-3** (heredada): todo SELECT sobre `a2a_receipts` desde `receipt.ts` incluye `.eq('owner_ref', ownerRef)` con `ownerRef: string` (nunca `string | undefined`). Ausencia = BLOQUEANTE en AR/CR (igual WKH-53). `list`, `getById`, `verify` lo cumplen.
- **CD-4** (heredada): `RECEIPT_SIGNING_SECRET` NUNCA se loguea, expone en HTTP, ni se persiste en DB (ni vía `current_setting`/`SET LOCAL`). `verify` muestra hashes, nunca el secret.
- **CD-5** (heredada): TypeScript strict, sin `any`. `ReceiptRow` modela exactamente las columnas; `amount_usd` (NUMERIC) tipado como `string`; nullable columns como `T | null`.
- **CD-6** (heredada): NO modificar schema de `a2a_events`/`a2a_protocol_fees`, NI las firmas/retorno de `chargeProtocolFee`/`budgetService.debit`. NO tocar `fee-charge.ts` (la emisión fee vive en el call-site orchestrate.ts, DT-3a). Integración estrictamente aditiva.
- **CD-7** (auto-blindaje WKH-121, `110-.../auto-blindaje.md`): PROHIBIDO ampliar la aridad de `budgetService.debit` o de los `*DebitContext`. La emisión usa el contexto ya existente; el path master emite desde el call-site. Si algún test mockea `debit`, NO se rompen aserciones de aridad.
- **CD-8** (auto-blindaje WKH-123, `112-.../auto-blindaje.md`): si se agrega un campo a `A2AAgentKeyRow`/`KeySessionRow`/`*Row` consumido por fixtures → prever el fanout a ~14 tests. **Mitigación:** los tipos nuevos de receipt (`ReceiptRow`, etc.) viven en `src/types/receipt.ts` y NO se agregan campos requeridos a row-types existentes → cero fanout esperado.
- **CD-9** (auto-blindaje WKH-123): SIEMPRE `npm run format` ANTES de `npm run lint` al agregar imports (biome organizeImports). Orden: format → lint → tsc.

---

## 7. Plan de Implementación (Waves)

### Wave 0 — Serial Gate (contratos, migración, tipos, env)
- [ ] **W0.1** `src/types/receipt.ts`: `ReceiptType`, `ReceiptRow` (todas las columnas, nullables como `T|null`, `amount_usd:string`), `EmitReceiptInput`, `VerifyReceiptResult`, `ReceiptListItem`. (Exemplar: `types/a2a-key.ts`.) → typecheck.
- [ ] **W0.2** `supabase/migrations/20260605000000_a2a_receipts.sql`: tabla (DT-4/§4.2) + índice `(owner_ref, created_at DESC)` + RPC `insert_receipt(p_owner_ref, p_agent_key_id, p_session_id, p_delegation_id, p_receipt_type, p_amount_usd, p_chain_id, p_tx_hash, p_counterparty, p_orchestration_id)` que toma `pg_advisory_xact_lock(hashtext(p_owner_ref))`, lee `prev_receipt_hash`, inserta con `receipt_hash=''`, y RETURNS la fila (id, prev_receipt_hash, created_at) + hardening (CD-C). (Exemplar: `a2a_key_sessions.sql`.)
- [ ] **W0.3** `..._a2a_receipts_down.sql`: `DROP FUNCTION insert_receipt(...)` + `DROP TABLE IF EXISTS a2a_receipts`.
- [ ] **W0.4** Documentar `RECEIPT_SIGNING_SECRET` en `.env.example` / project-context env list (sin valor).

### Wave 1 — Service (depende de W0)
- [ ] **W1.1** `src/services/receipt.ts`: `buildCanonicalPayload` (DT-5 exacto), `computeReceiptHash` (HMAC, null si secret unset), `emit` (RPC insert→leer row→hash→UPDATE-once; best-effort, nunca throw), `verify`, `list`, `getById` (todos con Ownership Guard CD-3). (Exemplars: `event.ts`, `signed-auth.ts`, `transform-hmac.ts`.) → typecheck.

### Wave 2 — Integración best-effort (depende de W1)
- [ ] **W2.1** `src/services/budget.ts`: emisión `budget_debit` en ruta key-session (L88) y ruta delegation (L139), fire-and-forget `.catch(warn)`. Master NO se toca aquí (DT-3).
- [ ] **W2.2** `src/middleware/a2a-key.ts`: emisión `budget_debit` master tras `debitResult.success` (L~816), con `keyRow.owner_ref/id`, `chainId`. (CD-9: format antes de lint por el import nuevo.)
- [ ] **W2.3** `src/services/orchestrate.ts`: emisión `protocol_fee` tras `feeResult.status === 'charged'` (L~448), con `request.a2aKeyRow.owner_ref/id`, `request.chainId`, `feeResult.txHash`, `feeUsdc`, fee wallet de env, `orchestrationId`. (DT-3a; `fee-charge.ts` NO se toca.)

### Wave 3 — Router + registro (depende de W1)
- [ ] **W3.1** `src/routes/receipts.ts`: `GET /receipts` (list, ownership), `GET /receipts/:id` (getById, 404 disclosure-safe), `GET /receipts/:id/verify` (verify, 200 match/tamper, 404 cross-owner). `resolveCallerKey` reusado. (Exemplar: `auth.ts`.)
- [ ] **W3.2** `src/index.ts`: `import receiptsRoutes` + `register(receiptsRoutes, { prefix:'/receipts' })`.

### Wave 4 — Tests (depende de W1/W2/W3)
- [ ] **W4.1** `src/services/receipt.test.ts` (ver §8).
- [ ] **W4.2** `src/routes/receipts.test.ts` (ver §8).
- [ ] **W4.3** `src/services/fee-charge.test.ts` (NO se modifica fee-charge; el test de emisión fee va en orchestrate o en receipt.test) — ajustar: AC-1 se testea en `orchestrate.*.test.ts` o un test del call-site.
- [ ] **W4.4** `src/middleware/a2a-key.test.ts` + `src/services/budget.test.ts`: AC-2 emisión 3 rutas + best-effort no rompe el débito (CD-7: NO romper aserciones de aridad de `debit`).

### Dependencias
| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.1 | W0.1, W0.2 | tipos + RPC |
| W2.* | W1.1 | usa `receiptService.emit` |
| W3.* | W1.1 | usa `receiptService.list/getById/verify` |
| W4.* | W1-W3 | testea todo |

### Estimación
- Archivos nuevos: 6 (migration ×2, types, service, route, service.test, route.test → 7 con tests).
- Archivos modificados: 4 (`budget.ts`, `a2a-key.ts`, `orchestrate.ts`, `index.ts`) + tests existentes.
- Líneas estimadas: ~600 (service ~220, route ~120, migration ~70, types ~70, integraciones ~60, tests ~200+).

---

## 8. Plan de Tests (≥1 por AC)

| Test | AC | Wave | Framework |
|------|----|------|-----------|
| `receipt.test`: `computeReceiptHash` produce hex 64-char determinista para canonical fijo | AC-3 | W4.1 | vitest |
| `receipt.test`: `buildCanonicalPayload` ordena keys alfabético + normaliza amount(`toFixed(8)`)/created_at(ISO)/null | AC-3/DT-5 | W4.1 | vitest |
| `receipt.test`: `verify` con row no manipulado → `{valid:true, computed==stored}` | AC-4 | W4.1 | vitest |
| `receipt.test`: `verify` con `amount_usd` alterado → `{valid:false, tamper_detected:true}` | AC-5 | W4.1 | vitest |
| `receipt.test`: `emit` con `RECEIPT_SIGNING_SECRET` unset → no inserta, WARN, no throw | AC-6/DT-6 | W4.1 | vitest |
| `receipt.test`: `emit` con RPC que rechaza → `.catch` absorbe, no throw (best-effort) | AC-6/CD-1 | W4.1 | vitest |
| `receipt.test`: `list(ownerA)` solo devuelve recibos de ownerA (mock `.eq('owner_ref',...)` presente) | AC-7/CD-3 | W4.1 | vitest |
| `receipts.route.test`: `GET /receipts/:id/verify` owner-match → 200 `{valid:true}` | AC-4 | W4.2 | vitest |
| `receipts.route.test`: tamper → 200 `{valid:false, tamper_detected:true}` | AC-5 | W4.2 | vitest |
| `receipts.route.test`: `:id` de otro owner → 404 (disclosure-safe) | AC-8 | W4.2 | vitest |
| `receipts.route.test`: `GET /receipts` filtra por owner del caller | AC-7 | W4.2 | vitest |
| `orchestrate`/call-site test: fee `charged` → `receiptService.emit` llamado con `receipt_type:'protocol_fee'`, counterparty=fee wallet | AC-1 | W4.3 | vitest |
| `orchestrate`/call-site test: `emit` rechaza → la respuesta del orchestrate/charge sigue OK | AC-6 | W4.3 | vitest |
| `budget.test` + `a2a-key.test`: debit success en ruta master → emit `budget_debit` desde call-site; sin romper `toHaveBeenCalledWith` de `debit` | AC-2/CD-7 | W4.4 | vitest |
| `budget.test`: debit success en ruta key-session y delegation → emit con `session_id`/`delegation_id` respectivos | AC-2 | W4.4 | vitest |
| `budget.test`: emit rechaza → `debit` sigue devolviendo `{success:true}` | AC-2/AC-6 | W4.4 | vitest |

---

## 9. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Bifurcación de la cadena `prev_receipt_hash` bajo concurrencia | M | M | DT-2: advisory lock por owner en `insert_receipt` (cadena lineal garantizada para `prev`). |
| Ventana INSERT(hash='')→UPDATE(hash) deja recibo sin firmar si el proceso muere | B | B | `verify` reporta `{valid:false, reason:'UNSIGNED'}`; best-effort (AC-6) no rompe pago; recibo auditable. |
| Hash no reproducible (firma≠verify) por normalización inconsistente | M | A | DT-5: misma normalización (`toFixed(8)`/`toISOString()`/`JSON.stringify`) en ambos lados; test de determinismo (W4.1). |
| Romper aserciones de aridad de `debit` (auto-blindaje WKH-121) | M | M | CD-7: NO ampliar firma; emisión vía contexto/call-site existente. |
| `agent_key_id` NOT NULL rompía emisión protocol_fee | — | — | Mitigado: §4.2 lo hace nullable. |
| Lint falla por import nuevo (auto-blindaje WKH-123) | B | B | CD-9: format antes de lint. |

## 10. Missing Inputs / Resoluciones

- **[RESUELTO]** counterparty en `budget_debit` → `null` (DT-8). No se amplían firmas.
- **[RESUELTO]** Índice "último recibo del owner" → `(owner_ref, created_at DESC)` (DT-2/§4.2). Sirve para chain-read y para `list` (AC-7).
- **[RESUELTO]** Scope de verify → **MVP = verificación individual** del recibo solicitado (AC-4/AC-5). Verificación de cadena completa (`/receipts/:id/chain`) = scope futuro (no MVP).
- **[RESUELTO]** Concurrencia de la cadena → DT-2 (opción a, advisory lock + hash UPDATE-once). Garantía del MVP explícita en DT-2.

## 11. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Sin `[NEEDS CLARIFICATION]` residuales. | No |

> Nota de scope vs work-item: el SDD **reduce** el Scope IN en `fee-charge.ts` (NO se modifica; la emisión fee vive en `orchestrate.ts`, DT-3a) y **agrega** `src/middleware/a2a-key.ts` y `src/services/orchestrate.ts` como puntos de emisión (necesarios para tener `owner_ref` real). Esto respeta CD-6 (no toca contratos de pago) y CD-7 (no amplía firmas). Decisión del Architect en F2; no requiere re-aprobación del QUÉ (el comportamiento observable de los ACs no cambia).

---

## Readiness Check

```
[x] Cada AC (1..8) tiene ≥1 archivo asociado en §4.1 y ≥1 test en §8
[x] Cada archivo en §4.1 tiene Exemplar verificado con Glob/Read (paths reales)
[x] No hay [NEEDS CLARIFICATION] pendientes (los 4 missing inputs resueltos en §10)
[x] Constraint Directives: ≥3 PROHIBIDO (CD-1..CD-9 + CD-A..CD-D)
[x] Context Map: ≥2 archivos leídos (13 leídos con line ranges reales)
[x] Scope IN/OUT explícitos (§6 work-item + §11 nota de reducción)
[x] BD: tablas existentes verificadas; tabla nueva `a2a_receipts` especificada
[x] Happy Path completo (§4.4: emisión fee + 3 rutas debit + verify)
[x] Flujo de error definido (§4.5: secret unset, insert fail, cross-owner 404, UNSIGNED)
[x] Concurrencia de cadena resuelta y garantía del MVP especificada (DT-2)
```

---

*SDD generado por NexusAgil — FULL — WKH-124*
