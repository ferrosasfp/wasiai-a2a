# Work Item — [WKH-124] KEY-RECEIPTS: Recibos inmutables + proof-chain

## Resumen

Agregar un **recibo inmutable por pago exitoso** que capture el linaje completo (session_id → agent_key_id → owner_ref) más los detalles del cobro (monto, chain, tx_hash, counterparty, timestamp), encadenado mediante `prev_receipt_hash` (ledger-style) y firmado server-side con HMAC-SHA256. El recibo se emite de forma best-effort al completarse un cobro exitoso en `fee-charge.ts` (status `charged`) o un débito de budget exitoso (compose/orchestrate), SIN romper el flujo de pago si la emisión falla. Se expone un endpoint `GET /receipts/:id/verify` que recomputa el hash/firma y valida la integridad de la cadena.

Beneficiario principal: propietarios de Agent Keys que necesitan evidencia verificable de quién autorizó qué (Proof-of-AI estilo Kite Passport), portable para resolución de disputas.

## Sizing

- **SDD_MODE**: full (tabla nueva, service nuevo, endpoint nuevo, integración best-effort en fee-charge y budget paths)
- **Estimación**: L — confirmado (toca 4 puntos de integración: fee-charge, budget/compose, orchestrate, route; más tabla DB + migration)
- **Branch sugerido**: `feat/113-wkh-124-receipts`

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `chargeProtocolFee` retorna `{ status: 'charged', txHash }`, THEN the system SHALL emit a receipt capturing `{ agent_key_id, owner_ref, session_id (null si master key), amount_usd, chain_id, tx_hash, counterparty: WASIAI_PROTOCOL_FEE_WALLET, receipt_type: 'protocol_fee', timestamp }` before returning the charge result to the caller.

- **AC-2**: WHEN `budgetService.debit` retorna `{ success: true }` en cualquiera de las 3 rutas (master key / delegation / key-session), THEN the system SHALL emit a receipt capturing the linaje completo disponible en el contexto (`agent_key_id`, `owner_ref`, `session_id` si aplica, `delegation_id` si aplica, `amount_usd`, `chain_id`, receipt_type: 'budget_debit') as best-effort (SHALL NOT propagate receipt emission failure to the debit result).

- **AC-3**: WHEN a receipt is created, THEN the system SHALL compute `receipt_hash = HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical_payload)` where `canonical_payload` includes all receipt fields plus `prev_receipt_hash` (null-safe: "null" string if first receipt for owner), and SHALL store the receipt as append-only (no UPDATE/DELETE on committed rows).

- **AC-4**: WHEN `GET /receipts/:id/verify` is called with a valid receipt id AND the caller's `owner_ref` matches the receipt's `owner_ref`, THEN the system SHALL recompute the receipt_hash from stored fields, compare with stored hash, and return `{ valid: true, receipt_id, computed_hash, stored_hash }` if they match.

- **AC-5**: IF `GET /receipts/:id/verify` detects a hash mismatch (computed_hash !== stored_hash), THEN the system SHALL return `{ valid: false, receipt_id, tamper_detected: true }` with HTTP 200 (the endpoint itself succeeds; the result signals tampering).

- **AC-6**: IF receipt emission fails (DB insert error, signing secret missing, or any exception during emission), THEN the system SHALL log the error at WARN level and return the original payment/debit result unchanged — the payment flow SHALL NOT be interrupted.

- **AC-7**: WHEN `GET /receipts` is called by an authenticated caller, THEN the system SHALL return only receipts where `owner_ref` matches the caller's `owner_ref` (Ownership Guard: `.eq('owner_ref', callerOwnerRef)` is MANDATORY; reads without this filter are PROHIBITED).

- **AC-8**: WHEN `GET /receipts/:id/verify` is called and the receipt `owner_ref` does NOT match the caller's `owner_ref`, THEN the system SHALL return 404 (disclosure-safe: no reveal of existence of receipts belonging to other owners).

## Scope IN

- `src/services/receipt.ts` — nuevo service: `emitReceipt`, `verifyReceipt`, `listReceipts`
- `src/routes/receipts.ts` — nuevo router: `GET /receipts`, `GET /receipts/:id`, `GET /receipts/:id/verify`
- `src/services/fee-charge.ts` — integración best-effort de `emitReceipt` al retornar `status: 'charged'`
- `src/services/budget.ts` — integración best-effort de `emitReceipt` en las 3 rutas (master, delegation, key-session) al retornar `{ success: true }`
- `src/types/receipt.ts` (o añadir a `src/types/index.ts`) — tipos `ReceiptRow`, `ReceiptType`, `VerifyReceiptResult`
- `supabase/migrations/20260605000000_a2a_receipts.sql` — tabla `a2a_receipts` append-only + índices
- `supabase/migrations/20260605000000_a2a_receipts_down.sql` — reversión
- `src/index.ts` — registrar el nuevo router de receipts
- Tests unitarios e2e cubriendo AC-1..AC-8

## Scope OUT

- **Anclaje on-chain Merkle root periódico**: diferido a WKH-124b. El MVP usa firmado server-side; el anclaje on-chain es scope futuro explícito.
- **Emisión de recibo para eventos de discovery / compose sin debit** (events sin pago): no se cubre; solo pagos reales.
- **Webhook / notificación de recibo**: out of scope.
- **Modificación de la tabla `a2a_events`**: los eventos existentes no se alteran; `a2a_receipts` es una tabla nueva paralela, no un reemplazo.
- **Retroactive backfill**: no se emiten recibos retroactivos para pagos anteriores al deploy.
- **UI / Dashboard de recibos**: out of scope (solo API REST).
- **Revocación de recibos**: los recibos son append-only; ninguna operación los modifica.

## Decisiones técnicas (DT-N)

- **DT-1 — Esquema de inmutabilidad: firmado server-side + append-only (NO on-chain en MVP)**
  El recibo incluye `receipt_hash = HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical_json)` donde el canonical_json contiene todos los campos más `prev_receipt_hash`. La tabla `a2a_receipts` es append-only por contrato de aplicación (sin UPDATE/DELETE; se puede formalizar con policy PG futura). Esto da inmutabilidad práctica verificable sin gas, sin latencia de bloque y sin dependencia de RPC externo. El anclaje on-chain (Merkle root periódico) se difiere como WKH-124b. Justificación: la verificación de recibos es principalmente para disputas internas y auditoría; la firma HMAC permite detección de manipulación sin necesidad de chain externa para el MVP.

- **DT-2 — Cadena encadenada (prev_receipt_hash): last-receipt-per-owner**
  Cada recibo captura el hash del último recibo del mismo `owner_ref` como `prev_receipt_hash` (NULL en el primero). La consulta del "último recibo del owner" se hace bajo SELECT FOR UPDATE dentro de una transacción para evitar races. Esto forma un ledger encadenado por owner: modificar un recibo intermedio invalida todos los posteriores. El verificador de la cadena (endpoint `GET /receipts/:id/chain`) es scope futuro; en MVP solo se verifica el hash individual del recibo solicitado.

- **DT-3 — Disparador: post-settlement best-effort (fee-charge + budget debit)**
  La emisión del recibo ocurre como llamada fire-and-forget con `.catch(warn)` inmediatamente después de confirmar el pago (mismo patrón que `eventService.track` en los routes actuales). No bloquea el resultado del pago. Puntos de emisión:
  (a) en `chargeProtocolFee` al hacer el `UPDATE status: 'charged'` exitoso;
  (b) en `budgetService.debit` al retornar `{ success: true }` (las 3 rutas).
  El contexto de linaje disponible en cada punto dicta qué campos del recibo se pueden llenar (session_id puede ser null en master key path).

- **DT-4 — Tabla `a2a_receipts`: campos mínimos del recibo**
  ```
  id UUID PK (gen_random_uuid)
  owner_ref TEXT NOT NULL          -- Ownership Guard
  agent_key_id UUID NOT NULL REFERENCES a2a_agent_keys(id)
  session_id UUID REFERENCES a2a_key_sessions(id) ON DELETE SET NULL  -- null si master key / delegation
  delegation_id UUID REFERENCES a2a_delegations(id) ON DELETE SET NULL -- null si no es delegation
  receipt_type TEXT NOT NULL       -- 'protocol_fee' | 'budget_debit'
  amount_usd NUMERIC(20,8) NOT NULL
  chain_id INT NOT NULL
  tx_hash TEXT                     -- null si budget_debit sin tx_hash (débito interno)
  counterparty TEXT                -- fee wallet o agent slug / endpoint invocado
  orchestration_id TEXT            -- trazabilidad a a2a_protocol_fees si es protocol_fee
  prev_receipt_hash TEXT           -- NULL en el primer recibo del owner; encadenamiento
  receipt_hash TEXT NOT NULL       -- HMAC-SHA256(RECEIPT_SIGNING_SECRET, canonical)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ```
  El campo `receipt_hash` es inmutable post-insert (app-layer; el service NUNCA hace UPDATE sobre esta columna).

- **DT-5 — Canonical payload para HMAC**
  `JSON.stringify` con keys ordenadas de forma determinista (alphabetical sort), incluyendo: `id`, `owner_ref`, `agent_key_id`, `session_id`, `delegation_id`, `receipt_type`, `amount_usd` (string decimal), `chain_id`, `tx_hash`, `counterparty`, `orchestration_id`, `prev_receipt_hash`, `created_at` (ISO string). Esto garantiza reproducibilidad del hash sin dependencia del orden de inserción.

- **DT-6 — RECEIPT_SIGNING_SECRET desde env var**
  El HMAC key es `process.env.RECEIPT_SIGNING_SECRET`. Si no está seteado: emitReceipt logúea WARN y hace skip silencioso (mismo patrón que `WASIAI_PROTOCOL_FEE_WALLET` en fee-charge). El verify endpoint indica en la respuesta si el recibo no puede verificarse (secret no disponible). Nunca se hardcodea ni se persiste el secret.

- **DT-7 — Endpoint de verificación: HTTP GET, sin auth opcional para receipts propios**
  `GET /receipts/:id/verify` requiere autenticación (mismo middleware `requirePaymentOrA2AKey`). La verificación recomputa el hash del lado del servidor usando el stored canonical payload, sin que el caller tenga acceso al HMAC key. La respuesta incluye `{ valid, computed_hash, stored_hash, receipt_id }` — sin exponer el secret.

## Constraint Directives (CD-N)

- **CD-1 — PROHIBIDO**: la emisión de un recibo NUNCA bloquea ni lanza excepción que interrumpa el flujo de pago/debit. Se implementa como fire-and-forget con `.catch((e) => console.warn('[receipts] emit failed', e.message))`. Cualquier fallo de `emitReceipt` produce SOLO un log WARN.

- **CD-2 — OBLIGATORIO: append-only**: el service `receipt.ts` NUNCA emite una query `UPDATE` o `DELETE` sobre `a2a_receipts`. Solo `INSERT` y `SELECT`. El `receipt_hash` es inmutable desde el primer insert.

- **CD-3 — OBLIGATORIO: Ownership Guard en todas las lecturas**: cualquier SELECT sobre `a2a_receipts` hecho desde `src/services/receipt.ts` DEBE incluir `.eq('owner_ref', ownerRef)` con `ownerRef: string` (nunca `string | undefined`). Ausencia del filtro es BLOQUEANTE en AR/CR (igual que WKH-53 para `a2a_agent_keys`).

- **CD-4 — PROHIBIDO**: el `RECEIPT_SIGNING_SECRET` NUNCA se loguea, expone en respuestas HTTP, ni se persiste en DB. La respuesta de verify muestra `computed_hash` y `stored_hash` pero NO el secret.

- **CD-5 — OBLIGATORIO**: TypeScript strict — sin `any` explícito. El tipo `ReceiptRow` debe modelar exactamente las columnas de la migración. Los campos numéricos de Supabase (NUMERIC) llegan como `string`; tiparlo así.

- **CD-6 — PROHIBIDO**: no se modifica el schema de `a2a_events`, `a2a_protocol_fees`, ni el flujo de retorno de `chargeProtocolFee` / `budgetService.debit`. La integración es estrictamente aditiva.

## Missing Inputs

- **[resuelto en F2]** — ¿Qué context de linaje está disponible en `budgetService.debit` para los 3 paths? Verificado: el master key path tiene `keyId` + `chainId`; la ruta `keySessionContext` tiene `sessionId`, `ownerRef`, `keyId`; la ruta `delegationContext` tiene `delegationId`, `ownerRef`, `keyId`. El `orchestrationId` del fee no viaja por budget.debit (es campo separado de `chargeProtocolFee`). El `counterparty` en el budget_debit path [NEEDS CLARIFICATION] — en compose/orchestrate hay un agent slug disponible en el caller, pero no llega a `budgetService.debit` actualmente. Opción conservadora: counterparty = null en budget_debit (se puede agregar en F2).

- **[resuelto en F2]** — Índice de `prev_receipt_hash` para la consulta "último recibo del owner": usar `(owner_ref, created_at DESC)` o `(owner_ref, id)` con ORDER BY created_at DESC LIMIT 1. El Architect elige en F2.

- **[NEEDS CLARIFICATION / opción conservadora]** — ¿La verificación de cadena completa (`prev_receipt_hash` encadenada de todos los recibos del owner) es parte del MVP o solo se verifica el hash individual del recibo solicitado? Se asume **MVP = verificación individual** (AC-4/AC-5). La verificación de cadena completa es scope futuro.

## Análisis de paralelismo

- **Esta HU depende de**: WKH-121 (session keys, tabla `a2a_key_sessions` — DONE), WKH-123 (signed auth — DONE). No depende de WKH-125 (constraints programables — pendiente).
- **Esta HU NO bloquea**: WKH-125 (constraints programables) puede ir en paralelo.
- **Referencia a tablas existentes**: `a2a_agent_keys`, `a2a_key_sessions`, `a2a_delegations` — todas DONE y estables.
- **Sin conflicto de schema**: la migración `20260605000000_a2a_receipts.sql` es una tabla nueva; no toca las migraciones `20260603` ni `20260604`.
- **Sin conflicto de archivos**: `fee-charge.ts` y `budget.ts` reciben llamadas aditivas fire-and-forget; ningún otro WKH en vuelo modifica esos archivos actualmente.
