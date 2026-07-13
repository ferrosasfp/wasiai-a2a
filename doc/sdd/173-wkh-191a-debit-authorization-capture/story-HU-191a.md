# Story File — HU-191a: Captura + persistencia de la firma EIP-712 `DebitAuthorization` (flujo normal)

> Contrato autocontenido para el Dev (F3). El Dev SOLO lee este archivo.
> Si algo no está acá, NO se hace. Si algo contradice al código real al abrirlo → PARÁ y escalá al Architect.
>
> - SDD fuente: `doc/sdd/173-wkh-191a-debit-authorization-capture/sdd.md` (SPEC_APPROVED)
> - Work item: `doc/sdd/173-wkh-191a-debit-authorization-capture/work-item.md`
> - Epic: `doc/sdd/172-wkh-191-escrow-noncustodial-settlement/work-item.md` (Wave 0, fila 172 `_INDEX.md`)
> - Branch: `feat/191a-debit-authorization-capture`
> - Tipo: money-path adyacente (**firma INERTE** — cero movimiento de fondos) · additive migration · flag-gated default OFF
> - Estado esperado al cierre: `DONE (código) · PENDING-DEPLOY` (esta HU NO aplica migración a `caldz`/`bdwv` ni flipea `ESCROW_DEBIT_CAPTURE_ENABLED`)

---

## 1. Contexto compacto (qué construís y por qué)

El settlement de payment-intents hoy es **operator-custodial**: en `close`/`settle`, el operador mueve fondos propios sin ninguna firma criptográfica del comprador (`settlePaymentIntentOnChain`). El epic WKH-191 va hacia un settlement **no-custodial** donde el operador presenta una firma EIP-712 `DebitAuthorization` del buyer a `WasiAIEscrow.debit()`.

Esta HU (191a, primer eslabón de Wave 0) construye SOLO la **captura + validación + persistencia** de esa firma. La firma queda **INERTE**: se recibe en el body del `close`/`settle`, se recupera el firmante reusando `eip712.ts`, se valida contra el monto server-computado y el `buyer_wallet` del intent, y se persiste (valid/invalid + motivo) para que **191b** (rewire real) la consuma. **NADA on-chain se dispara en 191a.** El `close`/`settle` sigue corriendo byte-idéntico por el path operator-custodial existente.

Todo va detrás del flag `ESCROW_DEBIT_CAPTURE_ENABLED` (default OFF): con OFF, el comportamiento es byte-idéntico al actual (los campos `debit*` del body ni se parsean).

**Por qué firmar en CLOSE/SETTLE y no en OPEN**: el contrato exige el monto EXACTO firmado (`if (amount > bal) revert InsufficientBalance`, `WasiAIEscrow.sol:137`), no un tope. El monto final (`min(Σvouchers, deposit)` / `min(cap, uso)`) recién se conoce al cerrar, y el cliente lo puede computar sin ambigüedad en ese momento. Ver work-item "Nuance de diseño".

Invariantes a preservar: (a) el settle NUNCA se altera/bloquea por la captura (best-effort no-throw); (b) cero `escrow.debit()`/`writeContract`; (c) Ownership Guard `owner_ref` en tabla + RPC + lectura de `buyer_wallet`; (d) anti-replay del nonce escopeado por `key_id`, espejo de `_usedNonces[keyId][nonce]`.

---

## 2. Acceptance Criteria (EARS) — copiados del SDD/work-item

- **AC-1**: WHEN `ESCROW_DEBIT_CAPTURE_ENABLED=true` AND el caller envía `debitSignature` + `debitNonce` + `debitDeadline` (+ `debitAmount`, DT-3b) en el body de `POST /session/:id/close` o `POST /upto/:id/settle`, THE system SHALL recuperar el firmante EIP-712 `DebitAuthorization` reusando `DEBIT_AUTHORIZATION_TYPES`/`buildDebitDomain` de `src/adapters/escrow/eip712.ts` y SHALL persistir la firma, el firmante recuperado y el resultado de la validación ligados al `intent_id`, sin alterar el resultado del close/settle.
- **AC-2**: IF el firmante recuperado no coincide con `buyer_wallet` del intent, OR el `amount` firmado (unidades atómicas del token del escrow) no coincide EXACTAMENTE con el monto final server-computado, OR el `nonce` ya fue usado para ese `keyId`, THEN THE system SHALL marcar la firma como inválida (con motivo específico persistido) y SHALL NOT rechazar ni alterar el close/settle subyacente.
- **AC-3**: WHEN `ESCROW_DEBIT_CAPTURE_ENABLED=false` (default) OR no hay contrato escrow configurado para la chain del intent (`resolveEscrowContract` devuelve `null`), THE system SHALL ejecutar `close`/`settle` byte-idénticamente al comportamiento actual, ignorando cualquier campo `debit*` del body.
- **AC-4**: WHILE una firma `DebitAuthorization` válida está persistida, THE system SHALL NOT invocar `WasiAIEscrow.debit()` ni mover fondos en base a ella — el settlement fluye EXCLUSIVAMENTE por `settlePaymentIntentOnChain`.
- **AC-5**: IF el mismo par `(keyId, debitNonce)` se somete dos veces, THEN THE system SHALL marcar como inválida la segunda ocurrencia (`NONCE_ALREADY_USED`, espejo de `_usedNonces[keyId][nonce]`) sin afectar el settle.
- **AC-6**: WHERE el `debitDeadline` recibido ya venció (`now > deadline`) al momento de captura, THE system SHALL marcar la firma como inválida con motivo `DEADLINE_EXPIRED` en vez de válida.

---

## 3. Scope IN — lista exhaustiva de archivos a tocar

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql` | CREAR (SQL exacto en §6.1) | W0 |
| 2 | `supabase/migrations/20260713000000_wkh191a_debit_signatures_down.sql` | CREAR (SQL exacto en §6.2) | W0 |
| 3 | `src/types/database.types.ts` | EDITAR: agregar Row/Insert/Update de la tabla nueva + la RPC `capture_debit_signature` al bloque `Functions` (§6.3) | W0 |
| 4 | `src/adapters/escrow/eip712.ts` | EDITAR: agregar `recoverDebitAuthorization(...)` (§6.4). Reusa `DEBIT_AUTHORIZATION_TYPES`/`buildDebitDomain`. Sale de PROVISIONAL para este call-site. | W0 |
| 5 | `src/adapters/escrow/eip712.test.ts` | EXTENDER (NO tocar los tests existentes): T-10 (recover) | W0 |
| 6 | `src/adapters/escrow/debit-capture.ts` | CREAR: `isDebitCaptureEnabled()` + `captureDebitSignature()` + `captureDebitSignatureBestEffort()` + tipos `DebitCaptureInput`/`DebitValidationReason` (§7.1) | W1 |
| 7 | `src/adapters/escrow/debit-capture.test.ts` | CREAR: T-1/T-2/T-2b/T-3b/T-4/T-5/T-6/T-6b/T-7/T-9 (§9) | W1 |
| 8 | `src/services/payment-intent.ts` | EDITAR: `closeSession`/`settleUpto` aceptan `debitCapture?: DebitCaptureInput`; invocación best-effort en la rama `open→closing` (§7.2). CERO cambios al seam `settlePaymentIntentOnChain`. | W1 |
| 9 | `src/services/payment-intent.test.ts` | EXTENDER (NO tocar los tests existentes): T-8 (best-effort no rompe settle) | W1 |
| 10 | `src/routes/payments.ts` | EDITAR: write-boundary aditivo + gate de flag en `close`/`settle`; pasa `debitCapture` al service (§7.3) | W1 |
| 11 | `src/routes/payments.test.ts` | EXTENDER (NO tocar los tests existentes): T-3/T-3b (byte-idéntico flag OFF / escrow no config) | W1 |

**PROHIBIDO tocar cualquier otro archivo.** En particular NO tocar `contracts/**` (CD-4), `settlePaymentIntentOnChain`, `escrow-verifier.ts` (solo se IMPORTA `resolveEscrowContract`), las RPCs existentes de `20260704000000_wkh135_payment_intents.sql`, ni el struct EIP-712 (`DEBIT_AUTHORIZATION_TYPES` se reusa tal cual, NO se duplica).

---

## 4. Anti-Hallucination Checklist (verificado con Read sobre el código real — usalo tal cual)

- **Struct EIP-712** — `src/adapters/escrow/eip712.ts:31-46`. `DEBIT_AUTHORIZATION_TYPES` (`as const`, orden EXACTO `keyId,amount,deadline,nonce`), `DebitAuthorizationMessage = { keyId:0x…; amount:bigint; deadline:bigint; nonce:bigint }`. **Reusalo, NO lo redefinas (CD-5).**
- **Domain** — `buildDebitDomain(chainId, verifyingContract)` en `eip712.ts:63-73`. Lee `ESCROW_EIP712_NAME`/`ESCROW_EIP712_VERSION` (defaults `'WasiAIEscrow'`/`'1'`). Reusalo tal cual.
- **Recover viem** — `recoverTypedDataAddress` de `viem`, ya importado en `eip712.ts:17` y usado en `buildDebitAuthorization` (`eip712.ts:135-141`). El nuevo `recoverDebitAuthorization` lo reusa. Espejo directo de `verifyCapSignature` (`payment-intent.ts:480-501`).
- **Convergencia con el contrato** — `WasiAIEscrow.sol`: typehash `keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")` (`:38-39`); domain `__EIP712_init("WasiAIEscrow","1")` (`:80`); `_verifyAndConsume`: `block.timestamp > deadline → DeadlineExpired` (`:125`), `deadline > block.timestamp + MAX_DEADLINE_TTL(1h) → DeadlineTooFar` (`:127`, `MAX_DEADLINE_TTL` en `:45`), `_usedNonces[keyId][nonce] → NonceAlreadyUsed` (`:129`), `recovered != _depositor[keyId] → InvalidSignature` (`:134`), nonce consumido SOLO en `debit()` exitoso (`:139`). **NO abrir/editar el .sol (CD-4): estos anchors son solo la fuente de verdad de la validación TS.**
- **`resolveEscrowContract(chainKey)`** — `escrow-verifier.ts:94-101`. Lee `A2A_ESCROW_CONTRACT_<FAMILY>`; ausente/inválida → `null`. Es el gate "aplica escrow a esta chain" (AC-3). **Importalo, no lo clones.**
- **`getDefaultChainKey(): ChainKey | null`** — `registry.ts:258-260` (exportado). El intent es default-chain-only (`payments.ts:isDefaultChain`, `:42-44,176`). Usalo para resolver el `chainKey` de la captura.
- **`getAdaptersBundle(chainKey?)`** — `registry.ts:237-244`, retorna `AdaptersBundle | undefined`. `getChainConfig(chainKey?)` — `registry.ts:221-227`, `.chainId`. `bundle.payment.supportedTokens[0].decimals` = decimals del token escrow. **Base Sepolia USDC = 6** (`base/payment.ts:61` `USDC_DECIMALS = 6`). NUNCA literal 18 / NUNCA `usdToWei` (CD-8 heredado; `usdToWei` asume 18d, específico Kite/PYUSD).
- **USD → atómico** — patrón `escrow-verifier.ts:229-243`: `parseUnits(usdString, token.decimals)` / `formatUnits(atomic, token.decimals)`. Usá `parseUnits(finalAmountUsd.toString(), token.decimals)`.
- **`keyId` canónico (bytes32)** — `keccak256(stringToBytes(uuid))`. Anchor `deposit.ts:103` (`keccak256(stringToBytes(callerKey.id))`). Acá el uuid es `intent.key_id` (== `row.key_id` que devuelve el close RPC).
- **Punto de captura session** — `payment-intent.ts:closeSession` (`:564`). Rama `open→closing` arranca en `:674`; `finalUsd = min(consumed, deposit)/1e6` en `:677`. Capturar DESPUÉS de `:678` y ANTES del `settlePaymentIntentOnChain` de `:709`. Ramas `prev_status !== 'open'` (`:595`) NO capturan (retry/recovery, sin firma nueva).
- **Punto de captura upto** — `payment-intent.ts:settleUpto` (`:879`). Rama `open→closing`: `finalMicro = min(cap, reported)` en `:981`, `finalUsd` en `:982`. Capturar DESPUÉS de `:982` y ANTES del débito/settle on-chain (`:1006+`). Ramas `prev_status !== 'open'` (`:913`) NO capturan.
- **Firma del close RPC** — `close_payment_intent_for_settle` (`wkh135` migration `:216-231`, tipado en `database.types.ts:2677-2695`) devuelve `key_id`, `chain_id`, `prev_status`, etc. **NO devuelve `buyer_wallet`** → el capture helper hace su propia lectura owner-guarded (§7.1 paso 5). `a2a_payment_intents.buyer_wallet` existe (`wkh135` migration `:25`, se setea al `open` = `funding_wallet` del opener; nullable).
- **Endpoints** — `payments.ts:252-284` (`POST /session/:id/close`) y `:439-477` (`POST /upto/:id/settle`). Auth vía `resolveCallerKey`; `callerKey.owner_ref` disponible. El body del settle upto ya se lee como `Record<string,unknown>` (`:449`); el del close hoy no lee body → agregar lectura defensiva.
- **Flag helper de referencia** — `isArbiterEnabled()` en `arbiter.ts:65-67` (`process.env.X === 'true'`). Clonar el patrón para `isDebitCaptureEnabled()`.
- **Seam no-throw de referencia** — `settlePaymentIntentOnChain` (CD-7 del archivo: "el settle NUNCA rechaza la promise"). `captureDebitSignatureBestEffort` debe imitar ese espíritu: try/catch total que NUNCA re-lanza.
- **Test signer** — `privateKeyToAccount(pk).signTypedData({domain, types, primaryType, message})` (patrón `eip712.test.ts:44-53`). Sin red ni DB. `keccak256(stringToBytes(uuid))` para keyId (`eip712.test.ts:27`).
- **Migración patrón** — `20260704000000_wkh135_payment_intents.sql` (tabla + RPC SECURITY DEFINER + `SET search_path = public, pg_temp` + `REVOKE … FROM PUBLIC, anon, authenticated` + `GRANT … TO service_role` + `ALTER TABLE … ENABLE ROW LEVEL SECURITY` deny-by-default). Down: `…_payment_intents_down.sql` (BEGIN/COMMIT + DROP FUNCTION con firma de tipos exacta + DROP TABLE).
- **Timestamp de migración** — la última es `20260712000000_wkh189_…`. Usá `20260713000000_wkh191a_debit_signatures[_down].sql`.

**Si algo de esta lista NO coincide con el código al abrirlo → PARÁ y escalá. No adivines.**

---

## 5. Constraint Directives (inline — inviolables)

Heredados del work-item + SDD:

- **CD-1** (flag-gated, default OFF): `ESCROW_DEBIT_CAPTURE_ENABLED` default OFF/unset. **Doble gate**: (a) primario en el route — con OFF los campos `debit*` NO se leen del body → el service recibe `debitCapture=undefined` → byte-idéntico; (b) secundario en el service — `captureDebitSignatureBestEffort` chequea `isDebitCaptureEnabled()` y retorna sin efecto si OFF. Con OFF: cero parseo, cero persistencia. Regresión: T-3.
- **CD-2** (best-effort, no bloqueante): PROHIBIDO que la captura bloquee/retrase/altere el resultado del close/settle. `captureDebitSignatureBestEffort` va envuelto en try/catch que **NUNCA re-lanza**; cualquier error se `log.warn` y se descarta. Regresión: T-8.
- **CD-3** (cero on-chain): PROHIBIDO invocar `WasiAIEscrow.debit()` / `writeContract` / cualquier adaptador on-chain desde el path de captura. La firma persistida es INERTE. Regresión: T-4.
- **CD-4** (cero Solidity): PROHIBIDO modificar cualquier archivo bajo `contracts/`. Los anchors `.sol` de §4 son solo lectura/fuente de verdad.
- **CD-5** (reuso exacto EIP-712): OBLIGATORIO reusar `DEBIT_AUTHORIZATION_TYPES`/`buildDebitDomain` de `eip712.ts`. PROHIBIDO definir un segundo struct paralelo/divergente. El typehash lo deriva viem, NUNCA hardcodeado.
- **CD-6** (Ownership Guard): OBLIGATORIO `owner_ref` en la tabla nueva, en el RPC (`FOR UPDATE` + `IS DISTINCT FROM` → RAISE `OWNERSHIP_MISMATCH`) y en la lectura de `buyer_wallet` (`.eq('id', intentId).eq('owner_ref', ownerRef)`). Patrón WKH-53. Regresión: T-7.
- **CD-7** (firma inerte): PROHIBIDO tratar una firma persistida y válida como habilitante de movimiento de fondos. Es un artefacto para 191b.

Específicos del SDD:

- **CD-S1** (mensaje server-side): el mensaje EIP-712 se **reconstruye server-side** — `keyId = keccak256(stringToBytes(intent.key_id))` y `serverAmountAtomic = parseUnits(finalUsd, decimals)` los deriva el server. PROHIBIDO recuperar sobre un typed-data crudo del cliente. El `debitAmount` del cliente se usa SOLO para reconstruir el mensaje que el cliente dice haber firmado (para distinguir `SIGNER_MISMATCH` de `AMOUNT_MISMATCH`), y siempre se cruza contra `serverAmountAtomic`.
- **CD-S2** (auto-blindaje WKH-173): ningún helper `async` de captura debe `return`ear un `FastifyReply`. La captura NO responde el request — solo persiste. El flujo de close/settle no cambia su early-return por la captura.
- **CD-S3** (auto-blindaje WKH-189): rutas Fastify con Body tipado → generic en `fastify.post<{ Body: … }>()`, nunca en el tipo del `request`. Correr `biome format --write` (o `biome check`) sobre cada archivo tocado antes del gate de cierre de wave.
- **CD-S4** (auto-blindaje WKH-189): queries supabase que tipan `data` a mano → `as unknown as T` (cast doble) para evitar `TS2352`. Si `database.types.ts` no queda actualizado antes de usar el RPC, el `supabase.rpc('capture_debit_signature', …)` puede requerir cast — preferí actualizar `database.types.ts` (Scope IN #3) sobre castear.
- **CD-S5** (validar rango/formato ANTES de persistir): validar formato de los inputs `debit*` en el helper ANTES de cualquier persistencia; nunca confiar en el clamp como primera baranda. El write-boundary del route NO rechaza el request por `debit*` malformado (best-effort), pero el helper los marca `invalid`/`MALFORMED_INPUT`.

---

## 6. W0 — Migración + tipos + recover (SERIAL, contratos primero)

### 6.1 Archivo UP — `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql`

Escribí el archivo EXACTAMENTE con este contenido:

```sql
-- ============================================================
-- Migration: 20260713000000_wkh191a_debit_signatures
-- WKH-191a: captura + persistencia de la firma EIP-712 DebitAuthorization
-- (INERTE — 191a NO mueve fondos, cero on-chain). Aditiva 100%. NO toca
-- a2a_payment_intents ni sus 5 RPC (wkh135). Crea:
--   - Tabla a2a_payment_intent_debit_signatures (historial 1:N por intent).
--   - Índice único PARCIAL uq_debit_sig_valid_nonce (anti-replay: SOLO una
--     firma 'valid' reserva (key_id, nonce) — espejo de _usedNonces del contrato,
--     que consume el nonce SOLO en un debit() exitoso).
--   - RPC capture_debit_signature (SECURITY DEFINER, owner-guarded, atómico).
--   - RLS deny-by-default (service_role bypassa por BYPASSRLS).
-- Patrón: 20260704000000_wkh135_payment_intents.sql.
-- ============================================================

BEGIN;

-- ── Tabla a2a_payment_intent_debit_signatures (sibling, append-only) ──
CREATE TABLE IF NOT EXISTS a2a_payment_intent_debit_signatures (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id               UUID NOT NULL REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref               TEXT NOT NULL,                 -- Ownership Guard (CD-6/WKH-53)
  key_id                  UUID NOT NULL,                 -- == intent.key_id (para el índice anti-replay)
  debit_key_id_hash       TEXT NOT NULL,                 -- keccak256(stringToBytes(key_id)) — bytes32 hex firmado
  debit_amount_atomic     NUMERIC(78,0) NOT NULL,        -- uint256 firmado (unidades atómicas del token escrow)
  debit_deadline          BIGINT NOT NULL,               -- epoch seconds firmado
  debit_nonce             NUMERIC(78,0) NOT NULL,        -- uint256 nonce firmado (escopeado por key_id)
  debit_signature         TEXT NOT NULL,                 -- 0x… la firma cruda del cliente
  debit_signer_recovered  TEXT,                          -- address recuperada (NULL si el recover lanzó)
  debit_validation_status TEXT NOT NULL
    CHECK (debit_validation_status IN ('valid','invalid','not_provided','not_applicable')),
  debit_validation_reason TEXT,                          -- motivo si invalid
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debit_sig_intent ON a2a_payment_intent_debit_signatures (intent_id);
CREATE INDEX IF NOT EXISTS idx_debit_sig_owner  ON a2a_payment_intent_debit_signatures (owner_ref);

-- Anti-replay (AC-5, DT-5): espejo de _usedNonces[keyId][nonce]. SOLO una firma
-- VALIDA reserva el (key_id, nonce). Intentos 'invalid' NO queman el nonce.
-- NO reusa uq_a2a_payment_intents_cap_nonce (dominio del cap upto, distinto).
CREATE UNIQUE INDEX IF NOT EXISTS uq_debit_sig_valid_nonce
  ON a2a_payment_intent_debit_signatures (key_id, debit_nonce)
  WHERE debit_validation_status = 'valid';

-- RLS deny-by-default (patrón wkh135: service_role bypassa por BYPASSRLS).
ALTER TABLE a2a_payment_intent_debit_signatures ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPC: capture_debit_signature (SECURITY DEFINER, atómico, owner-guarded)
-- Persiste la fila con el veredicto ya computado en TS, re-chequeando el
-- anti-replay del nonce dentro de la MISMA tx (race-safe). NUNCA mueve dinero.
-- Devuelve el status/reason EFECTIVAMENTE persistido (puede degradar a
-- NONCE_ALREADY_USED si otra firma 'valid' ganó el (key_id, nonce)).
-- ============================================================
CREATE OR REPLACE FUNCTION capture_debit_signature(
  p_intent_id     UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_key_id_hash   TEXT,
  p_amount_atomic NUMERIC,
  p_deadline      BIGINT,
  p_nonce         NUMERIC,
  p_signature     TEXT,
  p_recovered     TEXT,
  p_status        TEXT,
  p_reason        TEXT
) RETURNS TABLE(persisted_status TEXT, persisted_reason TEXT) AS $$
DECLARE
  v_owner  TEXT;
  v_status TEXT := p_status;
  v_reason TEXT := p_reason;
  v_exists INT;
BEGIN
  -- Ownership Guard DB-level (CD-6): el intent debe existir y pertenecer al caller.
  SELECT owner_ref INTO v_owner
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Anti-replay (AC-5): si se pretende persistir 'valid' pero el (key_id, nonce)
  -- ya tiene una firma 'valid', degradar a invalid/NONCE_ALREADY_USED.
  IF v_status = 'valid' THEN
    SELECT 1 INTO v_exists
      FROM a2a_payment_intent_debit_signatures
      WHERE key_id = p_key_id
        AND debit_nonce = p_nonce
        AND debit_validation_status = 'valid'
      LIMIT 1;
    IF FOUND THEN
      v_status := 'invalid';
      v_reason := 'NONCE_ALREADY_USED';
    END IF;
  END IF;

  -- INSERT con backstop de carrera: el índice parcial uq_debit_sig_valid_nonce
  -- rechaza un 'valid' concurrente → capturamos 23505 y re-insertamos como invalid.
  BEGIN
    INSERT INTO a2a_payment_intent_debit_signatures (
      intent_id, owner_ref, key_id, debit_key_id_hash, debit_amount_atomic,
      debit_deadline, debit_nonce, debit_signature, debit_signer_recovered,
      debit_validation_status, debit_validation_reason
    ) VALUES (
      p_intent_id, p_owner_ref, p_key_id, p_key_id_hash, p_amount_atomic,
      p_deadline, p_nonce, p_signature, p_recovered,
      v_status, v_reason
    );
  EXCEPTION WHEN unique_violation THEN
    v_status := 'invalid';
    v_reason := 'NONCE_ALREADY_USED';
    INSERT INTO a2a_payment_intent_debit_signatures (
      intent_id, owner_ref, key_id, debit_key_id_hash, debit_amount_atomic,
      debit_deadline, debit_nonce, debit_signature, debit_signer_recovered,
      debit_validation_status, debit_validation_reason
    ) VALUES (
      p_intent_id, p_owner_ref, p_key_id, p_key_id_hash, p_amount_atomic,
      p_deadline, p_nonce, p_signature, p_recovered,
      v_status, v_reason
    );
  END;

  persisted_status := v_status;
  persisted_reason := v_reason;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.capture_debit_signature(uuid, text, uuid, text, numeric, bigint, numeric, text, text, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.capture_debit_signature(uuid, text, uuid, text, numeric, bigint, numeric, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_debit_signature(uuid, text, uuid, text, numeric, bigint, numeric, text, text, text, text)
  TO service_role;

COMMIT;
```

> **VERIFY-AT-IMPL**: confirmá contra `20260704000000_wkh135_payment_intents.sql` que el tipo declarado de `a2a_payment_intents.key_id` es `UUID` (`:24`) y que `owner_ref` es `TEXT NOT NULL` (`:23`). Si difieren, alineá los tipos del RPC. La lista de tipos del `ALTER/REVOKE/GRANT` debe coincidir EXACTAMENTE con el orden de parámetros de la función (11 args).

### 6.2 Archivo DOWN — `supabase/migrations/20260713000000_wkh191a_debit_signatures_down.sql`

```sql
-- ============================================================
-- Down: 20260713000000_wkh191a_debit_signatures
-- Revierte SOLO lo de WKH-191a: el RPC + la tabla (con su índice parcial y RLS,
-- que caen con el DROP TABLE). NO toca nada de wkh135.
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS capture_debit_signature(uuid, text, uuid, text, numeric, bigint, numeric, text, text, text, text);
DROP TABLE IF EXISTS a2a_payment_intent_debit_signatures;
COMMIT;
```

### 6.3 Tipos generados — `src/types/database.types.ts`

Este archivo es la fuente de tipado de `supabase.from(...)` y `supabase.rpc(...)` (ver `close_payment_intent_for_settle` tipado en `:2677-2695`, `accumulate_payment_voucher` en `:2668-2675`). Agregá:

1. En `public.Tables`, el objeto `a2a_payment_intent_debit_signatures` con `Row`/`Insert`/`Update`/`Relationships` (seguí el shape de una tabla vecina existente en el archivo, p.ej. `a2a_payment_vouchers`). Columnas: `id`, `intent_id`, `owner_ref`, `key_id`, `debit_key_id_hash`, `debit_amount_atomic`, `debit_deadline`, `debit_nonce`, `debit_signature`, `debit_signer_recovered` (nullable), `debit_validation_status`, `debit_validation_reason` (nullable), `captured_at`, `created_at`. `NUMERIC` → `number` o `string` según la convención del archivo (VERIFY-AT-IMPL: mirá cómo tipa `authorized_usd`/`cap_nonce` en `a2a_payment_intents`).
2. En `public.Functions`, junto a `close_payment_intent_for_settle`:

```ts
      capture_debit_signature: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_key_id: string;
          p_key_id_hash: string;
          p_amount_atomic: number;
          p_deadline: number;
          p_nonce: number;
          p_signature: string;
          p_recovered: string | null;
          p_status: string;
          p_reason: string | null;
        };
        Returns: { persisted_status: string; persisted_reason: string | null }[];
      };
```

> Si el proyecto regenera este archivo con `supabase gen types` en vez de editarlo a mano, corré ese comando y verificá el diff. VERIFY-AT-IMPL: mirá si hay un script (`package.json`) de generación; si NO lo hay, editá a mano (como se ve por el estado actual del archivo).

### 6.4 Recover helper — `src/adapters/escrow/eip712.ts`

Agregá al final del módulo (reusa `DEBIT_AUTHORIZATION_TYPES`, `DebitAuthorizationMessage`, `DebitEip712Domain`, `recoverTypedDataAddress` ya importado):

```ts
export interface RecoverDebitAuthorizationParams {
  message: DebitAuthorizationMessage;
  domain: DebitEip712Domain;
  signature: string;
}

/**
 * Recupera el firmante de una firma `DebitAuthorization` YA recibida del cliente
 * (191a captura). Espejo off-chain de `ECDSA.recover` en
 * `WasiAIEscrow._verifyAndConsume`. Reusa `DEBIT_AUTHORIZATION_TYPES` (CD-5).
 * Helper PURO: no toca DB ni red, NUNCA ejecuta `writeContract` (CD-7).
 * Devuelve `null` si el recover lanza (firma malformada) — el caller lo trata
 * como SIGNER_MISMATCH.
 */
export async function recoverDebitAuthorization(
  params: RecoverDebitAuthorizationParams,
): Promise<`0x${string}` | null> {
  try {
    return await recoverTypedDataAddress({
      domain: params.domain,
      types: DEBIT_AUTHORIZATION_TYPES,
      primaryType: 'DebitAuthorization',
      message: params.message,
      signature: params.signature as `0x${string}`,
    });
  } catch {
    return null;
  }
}
```

> Podés remover/actualizar el banner "PROVISIONAL — VERIFY-AT-IMPL con WKH-126a" del header SOLO en la parte que aplica a este call-site (el struct converge byte-a-byte con `WasiAIEscrow.sol:38-39`, verificado en el SDD §3). NO borres los comentarios de `buildDebitAuthorization` (sigue siendo del path de firma server-side de 126b).

### 6.5 Gate de cierre W0

- [ ] `npx tsc --noEmit` verde (el nuevo tipo del RPC en `database.types.ts` compila; `recoverDebitAuthorization` tipa).
- [ ] T-10 (recover, en `eip712.test.ts`) verde.
- [ ] `biome check` sobre `eip712.ts` + `eip712.test.ts` (CD-S3).

---

## 7. W1 — Validación + captura + flag + wiring (depende de W0)

### 7.1 `src/adapters/escrow/debit-capture.ts` (CREAR)

Tipos + helpers. Imports: `keccak256, parseUnits, stringToBytes` de `viem`; `recoverDebitAuthorization, buildDebitDomain` de `./eip712.js`; `resolveEscrowContract` de `../escrow-verifier.js`; `getAdaptersBundle, getDefaultChainKey` de `../registry.js`; `supabase` (mismo import que usa `payment-intent.ts`); el logger `log` (mismo patrón del repo).

```ts
export type DebitValidationReason =
  | 'AMOUNT_MISMATCH'
  | 'SIGNER_MISMATCH'
  | 'DEADLINE_EXPIRED'
  | 'DEADLINE_TOO_FAR'
  | 'NONCE_ALREADY_USED'
  | 'MALFORMED_INPUT';

/** Campos opcionales que el cliente somete en el body del close/settle. */
export interface DebitCaptureInput {
  signature: string;   // 0x-hex
  nonce?: string;      // decimal uint256 en string (bigint, sin float)
  deadline?: number;   // epoch seconds (entero)
  amount?: string;     // decimal uint256 atómico en string (DT-3b)
}

export interface CaptureDebitArgs {
  intentId: string;
  ownerRef: string;
  keyId: string;          // intent.key_id (uuid) — == row.key_id del close RPC
  chainId: number;        // row.chain_id (domain EIP-712)
  finalAmountUsd: number; // monto server-computado (min(Σvouchers,deposit) / min(cap,uso))
  capture: DebitCaptureInput;
}

// Espejo de WasiAIEscrow.MAX_DEADLINE_TTL = 1 hours (WasiAIEscrow.sol:45).
const MAX_DEADLINE_TTL_SECONDS = 3600n;

export function isDebitCaptureEnabled(): boolean {
  return process.env.ESCROW_DEBIT_CAPTURE_ENABLED === 'true';
}
```

`captureDebitSignature(args: CaptureDebitArgs): Promise<void>` — pasos (orden de prioridad de reason). NO responde ningún request (CD-S2); solo persiste:

1. **Gate escrow**: `chainKey = getDefaultChainKey()`. Si `null` → return (registry no init). `verifyingContract = resolveEscrowContract(chainKey)`. Si `null` → **no persistir** (AC-3, `not_applicable` conceptual, byte-idéntico). Return.
2. **Bundle/decimals**: `bundle = getAdaptersBundle(chainKey)`; `token = bundle?.payment.supportedTokens[0]`. Si falta → `log.warn` + return (config inválida). `decimals = token.decimals`.
3. **Derivar server-side (CD-S1)**: `keyIdHash = keccak256(stringToBytes(args.keyId))`; `serverAmountAtomic = parseUnits(args.finalAmountUsd.toString(), decimals)`. (VERIFY-AT-IMPL: si `finalAmountUsd.toString()` puede producir notación científica para montos raros, formatealo fixed — pero los montos son `micro/1e6`, seguros; test T-9 lo fija.)
4. **Parseo defensivo del body (CD-S5)**: `nonce = BigInt(capture.nonce)`, `deadline = BigInt(capture.deadline)`, `clientAmount = BigInt(capture.amount)`, envueltos en try/catch. Si alguno lanza (o un campo requerido falta) → persistir `status='invalid'`, `reason='MALFORMED_INPUT'`, `recovered=null` vía RPC (paso 8); return.
5. **Leer `buyer_wallet` owner-guarded (CD-6)**: `supabase.from('a2a_payment_intents').select('buyer_wallet').eq('id', args.intentId).eq('owner_ref', args.ownerRef).maybeSingle()`. Si error/no-row → `buyerWallet = null`. (El RPC re-verifica ownership en la persistencia; esta lectura es para el ancla del firmante.)
6. **Recover**: `recovered = await recoverDebitAuthorization({ domain: buildDebitDomain(args.chainId, verifyingContract), message: { keyId: keyIdHash, amount: clientAmount, deadline, nonce }, signature: capture.signature })`. Se reconstruye con `clientAmount` (lo que el cliente dice haber firmado) para distinguir signer- de amount-mismatch (AC-2).
7. **Status/reason (prioridad EXACTA)** — `now = BigInt(Math.floor(Date.now()/1000))`:
   - `now > deadline` → `invalid` / `DEADLINE_EXPIRED` (AC-6, espejo `sol:125`).
   - `deadline > now + MAX_DEADLINE_TTL_SECONDS` → `invalid` / `DEADLINE_TOO_FAR` (R-2, converge `sol:127`).
   - `recovered === null || buyerWallet === null || recovered.toLowerCase() !== buyerWallet.toLowerCase()` → `invalid` / `SIGNER_MISMATCH` (AC-2, espejo `sol:134`).
   - `clientAmount !== serverAmountAtomic` → `invalid` / `AMOUNT_MISMATCH` (AC-2).
   - resto → `valid` (reason `null`).
8. **Persistir vía RPC** `supabase.rpc('capture_debit_signature', { p_intent_id, p_owner_ref, p_key_id: args.keyId, p_key_id_hash: keyIdHash, p_amount_atomic: clientAmount.toString(), p_deadline: Number(deadline) /* o string según tipo BIGINT */, p_nonce: nonce.toString(), p_signature: capture.signature, p_recovered: recovered, p_status, p_reason })`. El status persistido devuelto puede degradar a `NONCE_ALREADY_USED` (AC-5). Si el RPC devuelve `error` (incl. `OWNERSHIP_MISMATCH`/`INTENT_NOT_FOUND`) → dejar propagar al wrapper (§7.1 `captureDebitSignatureBestEffort` lo atrapa). **NUNCA** invocar `escrow.debit()`/`writeContract` (CD-3/CD-7/AC-4).

> VERIFY-AT-IMPL: `debit_amount_atomic`/`debit_nonce` son `NUMERIC(78,0)` → pasar `bigint.toString()` (no `Number`, se pierde precisión > 2^53). `debit_deadline` es `BIGINT` → cabe en `number` para epoch seconds; pasá `Number(deadline)` o string, lo que el tipado del RPC acepte (§6.3). Elegí uno y sé consistente con `database.types.ts`.

`captureDebitSignatureBestEffort(args: CaptureDebitArgs): Promise<void>` — wrapper no-throw (CD-2):

```ts
export async function captureDebitSignatureBestEffort(
  args: CaptureDebitArgs,
): Promise<void> {
  if (!isDebitCaptureEnabled()) return; // gate secundario (CD-1)
  try {
    await captureDebitSignature(args);
  } catch (err) {
    log.warn(
      { intentId: args.intentId, detail: err instanceof Error ? err.message : 'unknown' },
      'debit signature capture failed (best-effort, discarded)',
    );
  }
}
```

### 7.2 `src/services/payment-intent.ts` (EDITAR)

1. Import: `captureDebitSignatureBestEffort, type DebitCaptureInput` de `../adapters/escrow/debit-capture.js`.
2. `closeSession(intentId, ownerRef, allowStaleRecovery = false, debitCapture?: DebitCaptureInput)` — agregar el 4º parámetro opcional. En la rama `open→closing`, **después de** `finalUsd` (`:677`) y **antes de** el `if (finalMicro <= 0)` / `settlePaymentIntentOnChain` (`:709`), insertar:

```ts
    if (debitCapture) {
      await captureDebitSignatureBestEffort({
        intentId,
        ownerRef,
        keyId: row.key_id,
        chainId: row.chain_id,
        finalAmountUsd: finalUsd,
        capture: debitCapture,
      });
    }
```

3. `settleUpto(intentId, ownerRef, reportedUsageUsd, allowStaleRecovery = false, debitCapture?: DebitCaptureInput)` — mismo 5º parámetro opcional. En la rama `open→closing`, **después de** `finalUsd` (`:982`) y **antes de** el `if (finalMicro <= 0)` / débito+settle (`:1006+`), insertar el mismo bloque (`keyId: row.key_id`, `chainId: row.chain_id`, `finalAmountUsd: finalUsd`).

> CD-2/CD-S2: el `await captureDebitSignatureBestEffort(...)` NO puede alterar el flujo — el wrapper es no-throw y no retorna nada. NO envolverlo en lógica condicional que cambie el `return` del settle. NO capturar en las ramas `prev_status !== 'open'` (retry/recovery, sin firma nueva). NO tocar `settlePaymentIntentOnChain` ni las ramas de dinero.

### 7.3 `src/routes/payments.ts` (EDITAR)

Write-boundary aditivo + gate primario del flag (CD-1) en ambos endpoints. Reglas: con `!isDebitCaptureEnabled()` → NO leer los campos `debit*` → pasar `undefined` al service (byte-idéntico). Con flag ON → construir `debitCapture` SOLO si `debitSignature` es un string 0x-hex no vacío (los demás campos se pasan tal cual; el helper valida/marca invalid best-effort — el route NO rechaza por `debit*` malformado, CD-S5).

1. Import: `isDebitCaptureEnabled, type DebitCaptureInput` de `../adapters/escrow/debit-capture.js`.
2. Helper local (arriba del `paymentsRoutes`, junto a `isNonEmptyString`):

```ts
function extractDebitCapture(body: Record<string, unknown>): DebitCaptureInput | undefined {
  if (!isDebitCaptureEnabled()) return undefined; // gate primario (CD-1/AC-3)
  const sig = body.debitSignature;
  if (typeof sig !== 'string' || !sig.startsWith('0x') || sig.length < 4) {
    return undefined; // sin firma → no se intenta captura (not_provided, no se persiste)
  }
  return {
    signature: sig,
    ...(typeof body.debitNonce === 'string' ? { nonce: body.debitNonce } : {}),
    ...(typeof body.debitDeadline === 'number' ? { deadline: body.debitDeadline } : {}),
    ...(typeof body.debitAmount === 'string' ? { amount: body.debitAmount } : {}),
  };
}
```

3. `POST /session/:id/close` (`:252`): tipar el body y extraer la captura. Hoy el handler NO lee body → agregá lectura defensiva:

```ts
      const b = (req.body ?? {}) as Record<string, unknown>;
      const debitCapture = extractDebitCapture(b);
      // ...
      const outcome = await paymentIntentService.closeSession(
        req.params.id,
        callerKey.owner_ref,
        false,           // allowStaleRecovery (default explícito)
        debitCapture,
      );
```

4. `POST /upto/:id/settle` (`:439`): ya lee `const b = (req.body ?? {}) as Record<string, unknown>` (`:449`). Agregá `const debitCapture = extractDebitCapture(b);` y pasalo:

```ts
      const outcome = await paymentIntentService.settleUpto(
        req.params.id,
        callerKey.owner_ref,
        b.reportedUsageUsd,
        false,           // allowStaleRecovery
        debitCapture,
      );
```

> CD-S3: el body tipado va con `as Record<string, unknown>` (patrón existente `:449`), NO con generic en `FastifyRequest` acá porque los campos son opcionales/best-effort. Mantené `FastifyRequest<{ Params: { id: string } }>` tal cual está. Con flag OFF, `extractDebitCapture` retorna `undefined` → llamada byte-idéntica (el 4º/5º arg opcional en `undefined` no cambia comportamiento). NO cambiar el shape de la response.

### 7.4 Gate de cierre W1

- [ ] `npx tsc --noEmit` verde.
- [ ] Tests T-1/T-2/T-2b/T-3/T-3b/T-4/T-5/T-6/T-6b/T-7/T-8/T-9 verdes.
- [ ] `biome check` sobre los 4 archivos de código tocados (CD-S3).
- [ ] Suite completa del repo verde; los tests existentes de `payment-intent.test.ts`/`payments.test.ts`/`eip712.test.ts` intactos.

---

## 8. W2 — Persistencia (cubierta por W0+W1)

La persistencia es el RPC `capture_debit_signature` (W0.1) invocado desde `captureDebitSignature` (W1.1, §7.1 paso 8). NO hay trabajo adicional: se lista aparte solo para los tests de persistencia (T-1/T-5/T-7). Verificar que el `supabase.rpc('capture_debit_signature', …)` compila con el tipo agregado en `database.types.ts` (§6.3); si no, actualizar el tipo (preferido sobre castear, CD-S4).

---

## 9. Tests requeridos (13 — ≥1 por AC + convergencia + best-effort)

Patrón: firmante = `privateKeyToAccount(pk).signTypedData(...)` (mock, `eip712.test.ts:44-53`), sin red. Supabase mockeado (mismo patrón que los tests de servicio existentes — VERIFY-AT-IMPL cómo `payment-intent.test.ts` mockea `supabase.rpc`/`supabase.from`). **NO tocar los tests existentes.**

| Test | AC/CD | Archivo | Descripción / asserción |
|------|-------|---------|-------------------------|
| **T-1** | AC-1 | `debit-capture.test.ts` | Firma válida (recovered==buyer_wallet, `clientAmount==serverAmountAtomic`, deadline en ventana, nonce libre) → `capture_debit_signature` invocado con `p_status='valid'` y los 4 campos derivados correctos (`p_key_id_hash`, `p_amount_atomic`, `p_deadline`, `p_nonce`). Mock del RPC devuelve `valid`. Assert los args del RPC. |
| **T-2** | AC-2 (amount) | `debit-capture.test.ts` | `debitAmount != serverFinalAtomic` → RPC llamado con `p_status='invalid'`, `p_reason='AMOUNT_MISMATCH'`. (La firma se produce sobre el `clientAmount` para que recover matchee el buyer_wallet y NO caiga en SIGNER_MISMATCH.) |
| **T-2b** | AC-2 (signer) | `debit-capture.test.ts` | Firma producida por una PK ≠ buyer_wallet (amount correcto) → `invalid` / `SIGNER_MISMATCH`. |
| **T-3** | AC-3 (flag OFF) | `payments.test.ts` | `ESCROW_DEBIT_CAPTURE_ENABLED` unset + body con `debit*` en `close` y `settle` → `extractDebitCapture` retorna `undefined`; el service recibe `debitCapture=undefined`; response byte-idéntica al baseline; el RPC `capture_debit_signature` NUNCA se llama (spy). |
| **T-3b** | AC-3 (escrow no config) | `debit-capture.test.ts` | Flag ON pero `A2A_ESCROW_CONTRACT_*` unset → `resolveEscrowContract=null` → cero persistencia (RPC no llamado). |
| **T-4** | AC-4 (inerte) / CD-3 | `debit-capture.test.ts` | Tras persistir `valid`, verificar (spy) que NINGÚN adaptador on-chain / `writeContract` / `escrow.debit()` fue invocado desde el path de captura. |
| **T-5** | AC-5 (anti-replay) | `debit-capture.test.ts` | Dos capturas `valid` con el mismo `(key_id, nonce)`: mock del RPC que en la 2ª devuelve `invalid`/`NONCE_ALREADY_USED` (simula la degradación DB). Assert la 2ª persiste `NONCE_ALREADY_USED`. (La lógica DB real se cubre por el test estructural + revisión; el unit valida que el helper propaga el status devuelto por el RPC.) |
| **T-6** | AC-6 (deadline expirado) | `debit-capture.test.ts` | `debitDeadline` en el pasado (`now-100`) → `invalid` / `DEADLINE_EXPIRED`, no `valid`. |
| **T-6b** | R-2 (deadline lejano) | `debit-capture.test.ts` | `debitDeadline > now + 3600` → `invalid` / `DEADLINE_TOO_FAR`. |
| **T-7** | CD-6 (Ownership) | `debit-capture.test.ts` | RPC mock que rechaza con error `OWNERSHIP_MISMATCH` → `captureDebitSignatureBestEffort` lo atrapa (no re-lanza); el caller no ve excepción. (El guard real vive en el RPC `FOR UPDATE`; el unit valida el best-effort + que se pasa `p_owner_ref` correcto.) |
| **T-8** | CD-2/DT-4/R-4 | `payment-intent.test.ts` | Flag ON + `captureDebitSignature` mockeado para **lanzar** → `closeSession`/`settleUpto` retornan el `SettleOutcome` normal (idéntico al sin-firma); la excepción NO propaga. |
| **T-9** | DT-2/MI-1 (decimals) | `debit-capture.test.ts` | `parseUnits` usa `token.decimals=6` (Base Sepolia): `finalAmountUsd=1.5` → `serverAmountAtomic == 1_500000n`, NO `1.5e18`. Assert el `p_amount_atomic` pasado al RPC == `'1500000'`. |
| **T-10** | §3 convergencia | `eip712.test.ts` | `recoverDebitAuthorization` sobre una firma producida con domain `WasiAIEscrow`/`1` + `DEBIT_AUTHORIZATION_TYPES` recupera exactamente `signer.address` (mirror de `_verifyAndConsume`). Firma malformada → `null`. |

> Nota sobre T-5/T-7: el anti-replay y el ownership tienen su lógica autoritativa en el RPC SQL. Como los tests unit mockean supabase, cubren que el **helper propaga/atrapa correctamente** el resultado del RPC. La lógica SQL en sí (índice parcial + `EXCEPTION unique_violation`, `IS DISTINCT FROM`) se valida por revisión (CR) + coincidencia byte-a-byte con §6.1. Si el repo tiene tests de integración con DB real (`*.real.test.ts`), NO agregar uno nuevo salvo que ya exista infra — mantené el scope en unit.

---

## 10. Out of Scope (NO tocar bajo ninguna circunstancia)

- `contracts/**` — cero Solidity (CD-4). Los `.sol` son solo lectura.
- Invocar `WasiAIEscrow.debit()` / `writeContract` / cualquier presentación on-chain (es 191b).
- `settlePaymentIntentOnChain` y las ramas de dinero de `closeSession`/`settleUpto` (refund, finalize, recordSettleOutcome).
- Las RPCs/tablas de `20260704000000_wkh135_payment_intents.sql` (no se modifican; solo se referencia `close_payment_intent_for_settle` y se lee `a2a_payment_intents.buyer_wallet`).
- Hacer los campos `debit*` OBLIGATORIOS (quedan opcionales — es decisión de 191b/rollout).
- `arbiter.ts`, `escrow-verifier.ts` (solo se importa `resolveEscrowContract`, NO se edita), reconciliación budget/escrowBalance (191c), deploy de contrato (191d).
- "Mejorar" código adyacente / refactors no solicitados.

---

## 11. Escalation Rule

> **Si algo no está en este Story File, el Dev PARA y escala al Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation concretas:
- El cuerpo real de `closeSession`/`settleUpto` difiere de los anchors `:677`/`:709`/`:982`/`:1006` (p.ej. la firma ya tiene otro parámetro opcional) → PARÁ, reportá la firma real.
- `a2a_payment_intents.buyer_wallet` no existe o tiene otro nombre → PARÁ (el ancla del firmante depende de él).
- `database.types.ts` se regenera por script y el diff no matchea §6.3 → reportá el diff antes de continuar.
- El tipo de `key_id`/`owner_ref` en `a2a_payment_intents` difiere de `UUID`/`TEXT` → alineá el RPC y reportá.
- `getDefaultChainKey`/`getAdaptersBundle`/`resolveEscrowContract` cambiaron de firma → PARÁ.

---

## 12. Riesgos heredados del SDD (para el Dev, informativo)

- **R-1** (decimales del escrow token): el `amount` firmado converge con el contrato SOLO si `supportedTokens[0]` de la chain del intent == `_usdc` del escrow (mismos decimales). Auto-consistente solo con `default chain == Base Sepolia` (USDC 6d). Cualquier divergencia ⇒ `AMOUNT_MISMATCH`, JAMÁS movimiento de fondos (captura inerte).
- **R-2** (ventana deadline): `DEADLINE_TOO_FAR` (`> now+1h`) es refuerzo de fidelidad para que una firma `valid` sea consumible por 191b dentro de la ventana del contrato. AC-6 solo exige `DEADLINE_EXPIRED`.
- **R-3** (nonce quemado solo si valid): el índice parcial `WHERE status='valid'` refleja que el contrato consume el nonce solo en `debit()` exitoso; intentos inválidos NO bloquean un reintento válido posterior con el mismo nonce.
- **R-4** (best-effort real): `captureDebitSignatureBestEffort` corre en el hilo del settle. DEBE ser no-throw garantizado (wrapper try/catch total). T-8 lo blinda.

---

*Story File generado por NexusAgil — F2.5 · WKH-191a*
