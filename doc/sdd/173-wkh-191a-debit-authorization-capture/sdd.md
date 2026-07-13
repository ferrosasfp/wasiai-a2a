# SDD — [WKH-191a] Captura + persistencia de la firma EIP-712 `DebitAuthorization` (flujo normal)

> F2 · SDD_MODE full · Estimación M · Branch `feat/191a-debit-authorization-capture`
> Input: `work-item.md` (esta carpeta) + epic `doc/sdd/172-wkh-191-escrow-noncustodial-settlement/work-item.md`.
> Alcance: **captura + validación + persistencia de una firma INERTE**. Cero side-effects on-chain, cero Solidity.

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo:línea | Por qué lo leí | Qué extraje / patrón |
|---|---|---|
| `contracts/src/WasiAIEscrow.sol:36-39` | Fuente de verdad del typehash | `DEBIT_AUTHORIZATION_TYPEHASH = keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")`. Orden EXACTO de campos. |
| `contracts/src/WasiAIEscrow.sol:80` | Domain del contrato | `__EIP712_init("WasiAIEscrow", "1")` → domain `name="WasiAIEscrow"`, `version="1"`. |
| `contracts/src/WasiAIEscrow.sol:121-141` | `_verifyAndConsume` | (a) `block.timestamp > deadline → DeadlineExpired`; (b) `deadline > block.timestamp + MAX_DEADLINE_TTL(1h) → DeadlineTooFar`; (c) `_usedNonces[keyId][nonce] → NonceAlreadyUsed`; (d) `recovered != _depositor[keyId] → InvalidSignature`; (e) `amount > bal → InsufficientBalance`. Nonce consumido SOLO en un `debit()` exitoso (`:139`). |
| `contracts/src/WasiAIEscrow.sol:45` | Ventana de la firma | `MAX_DEADLINE_TTL = 1 hours`. |
| `src/adapters/escrow/eip712.ts:31-73` | Reuso obligatorio (CD-5) | `DEBIT_AUTHORIZATION_TYPES` (`as const`, typehash derivado por viem), `buildDebitDomain(chainId, verifyingContract)` (defaults `WasiAIEscrow`/`1` vía env). NO duplicar. Falta un helper de **recover** (hoy solo build/hash). |
| `src/adapters/escrow-verifier.ts:94-101` | `resolveEscrowContract` | Lee `A2A_ESCROW_CONTRACT_<FAMILY>`; ausente/inválida → `null`. Es el gate de "aplica escrow a esta chain" (AC-3). |
| `src/adapters/escrow-verifier.ts:183,229-243` | Decimals del token (CD-8) | `token = bundle.payment.supportedTokens[0]`; `parseUnits(usd, token.decimals)` para USD→atómico, `formatUnits` inverso. NUNCA literal 18. |
| `src/services/payment-intent.ts:465-502` | Patrón de recover (mirror) | `verifyCapSignature` usa `recoverTypedDataAddress` de viem + domain-binding ANTES del recover. Espejo directo para el recover de `DebitAuthorization`. |
| `src/services/payment-intent.ts:564-819` | `closeSession` — dónde entra el monto final | `finalUsd = min(consumedMicro, depositMicro)/1e6`, computado en la rama `open→closing` (`:674-678`). Ese es el punto de captura. Delega on-chain a `settlePaymentIntentOnChain` (seam intacto). |
| `src/services/payment-intent.ts:879-1131` | `settleUpto` — dónde entra el monto final | `finalMicro = min(capMicro, reportedMicro)` (`:981`). Punto de captura análogo. |
| `src/services/payment-intent.ts:308-321` | Patrón Ownership Guard en RPC | `p_owner_ref` en TODO RPC (CD-6). |
| `src/routes/payments.ts:251-284, 438-477` | Endpoints close/settle | `POST /session/:id/close` y `POST /upto/:id/settle`. Auth vía `resolveCallerKey`; `callerKey.owner_ref` + `callerKey.funding_wallet` disponibles. Write-boundary `isNonEmptyString`/`isFiniteNonNegative`. |
| `src/routes/auth/deposit.ts:103` | keyId hash canónico | `keccak256(stringToBytes(callerKey.id))` = el `bytes32 keyId`. Idéntico en `me.ts:24`, `signup.ts:50`, tests. |
| `supabase/migrations/20260704000000_wkh135_payment_intents.sql` | Tabla base + RPC + RLS | `a2a_payment_intents` (PK `id`, `key_id UUID`, `buyer_wallet`, `owner_ref`); RLS deny-by-default + `GRANT ... service_role`; `close_payment_intent_for_settle` NO retorna `buyer_wallet`. Índice único parcial `uq_a2a_payment_intents_cap_nonce`. |
| `src/adapters/registry.ts:185-244` | Bundle por chain | `getAdaptersBundle(chainKey?)` (default si sin arg); `getChainConfig().chainId`; `getDefaultChainKey()`. |
| `src/adapters/base/payment.ts:61,391-449` | Decimals reales del token escrow | `USDC_DECIMALS = 6` (Base Sepolia USDC). `supportedTokens[0].decimals = 6`. |
| `src/adapters/kite-ozone/payment.ts:263-265` | Contraste | Token Kite = **18 decimals**. Confirma DT-2: NO reusar `usdToWei` (18d), depende de la chain del escrow. |
| `src/adapters/escrow/eip712.test.ts` | Patrón de test de firma | `privateKeyToAccount(pk).signTypedData(...)` como mock del firmante; aserciones sobre objeto, sin red/DB. |

---

## 2. Missing Inputs — RESUELTOS en F2

### MI-1 (decimals del token escrow) — RESUELTO
El escrow (`WasiAIEscrow`, único deploy en **Base Sepolia**, epic hallazgo #4) se inicializa con `_usdc` = USDC de Base Sepolia → **6 decimales** (verificado `base/payment.ts:61` `USDC_DECIMALS = 6`). El monto firmado se valida en **unidades atómicas del token de `bundle.payment.supportedTokens[0]` de la chain del intent** (patrón `escrow-verifier.ts:229-243`), NO con `usdToWei` (que asume 18d, específico Kite/PYUSD). Ver DT-2.

### MI-2 (forma de la tabla de persistencia) — RESUELTO → tabla sibling con historial
Se elige **tabla sibling nueva** `a2a_payment_intent_debit_signatures` (1:N con el intent), no columnas en `a2a_payment_intents`. Rationale: el cliente puede reintentar el close/settle (retry, expireStale) y presentar >1 intento de firma por intent; un historial append-only preserva todos los intentos (valid + invalid) para auditoría/telemetría de 191b, mientras que columnas únicas sobreescribibles perderían el rastro. Ver DT-6 + §4.

### MI-3 (no hay cliente/SDK real) — informativo
Los tests usan `PrivateKeyAccount` de viem como mock del firmante (patrón `eip712.test.ts`). Sin impacto en el diseño.

---

## 3. El shape EXACTO del EIP-712 `DebitAuthorization` (convergencia byte-a-byte)

**Reuso literal de `src/adapters/escrow/eip712.ts` (CD-5) — NO se define ningún struct paralelo.**

```
domain (buildDebitDomain(chainId, verifyingContract)):
  name:              "WasiAIEscrow"     // env ESCROW_EIP712_NAME default; == contrato :80
  version:           "1"                // env ESCROW_EIP712_VERSION default; == contrato :80
  chainId:           <chainId del escrow == chainId del intent>   // number
  verifyingContract: <resolveEscrowContract(chainKey)>            // 0x… address del contrato

types (DEBIT_AUTHORIZATION_TYPES, as const):
  DebitAuthorization: [
    { name: 'keyId',    type: 'bytes32' },
    { name: 'amount',   type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
  ]

primaryType: 'DebitAuthorization'

message (reconstruido server-side, NO tomado crudo del cliente):
  keyId:    keccak256(stringToBytes(intent.key_id))   // bytes32 — canónico (deposit.ts:103)
  amount:   parseUnits(finalAmountUsd, escrowTokenDecimals)  // BigInt, atómico (6d Base Sepolia)
  deadline: BigInt(debitDeadline)   // del cliente (epoch seconds)
  nonce:    BigInt(debitNonce)      // del cliente
```

**Verificación de convergencia con `_verifyAndConsume` (`WasiAIEscrow.sol:130-131`):**
- Orden de campos `keyId, amount, deadline, nonce` — **idéntico** al `abi.encode(TYPEHASH, keyId, amount, deadline, nonce)` del contrato. ✅
- `_hashTypedDataV4` del contrato usa el domain `EIP712("WasiAIEscrow","1")` + `block.chainid` + `address(this)`. viem `recoverTypedDataAddress` con el mismo domain reproduce el mismo digest. ✅
- `keyId` = `keccak256(stringToBytes(uuid))` — el contrato lo trata como `bytes32` opaco (`_depositor[keyId]`); el binding real vive en el deposit (`escrow-verifier.ts` matchea el mismo hash). ✅
- `amount` en unidades del `_usdc` del contrato (6d) — por eso DT-2 exige decimals del bundle de la chain del escrow, no 18. ✅

**Riesgo de convergencia (documentado, money-safe por inercia):** el `amount` firmado converge con el contrato solo si `bundle.payment.supportedTokens[0]` de la chain del intent es el MISMO token que el `_usdc` del escrow deployado en esa chain (mismos decimales). Como el escrow solo existe en Base Sepolia y los intents son default-chain-only (`payments.ts:42-44,176`), la única configuración auto-consistente para ACTIVAR la captura es `default chain == Base Sepolia` (`A2A_ESCROW_CONTRACT_BASE` seteado + bundle Base con USDC 6d). Cualquier divergencia de decimales NO mueve fondos (captura inerte): a lo sumo marca la firma `invalid` con `AMOUNT_MISMATCH`. Se registra como **R-1** en §8.

---

## 4. Persistencia (migración additive)

### 4.1 Tabla nueva `a2a_payment_intent_debit_signatures` (sibling, historial)

```sql
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
  debit_validation_reason TEXT,                          -- motivo si invalid (enum §5.3)
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debit_sig_intent  ON a2a_payment_intent_debit_signatures (intent_id);
CREATE INDEX IF NOT EXISTS idx_debit_sig_owner   ON a2a_payment_intent_debit_signatures (owner_ref);

-- Anti-replay (AC-5, DT-5): espejo de _usedNonces[keyId][nonce]. SOLO una firma
-- VALIDA reserva el (key_id, nonce) — igual que el contrato consume el nonce SOLO
-- en un debit() exitoso (WasiAIEscrow.sol:139). Intentos 'invalid' NO queman el nonce.
-- NO se reusa uq_a2a_payment_intents_cap_nonce (dominio del cap upto, distinto).
CREATE UNIQUE INDEX IF NOT EXISTS uq_debit_sig_valid_nonce
  ON a2a_payment_intent_debit_signatures (key_id, debit_nonce)
  WHERE debit_validation_status = 'valid';

-- RLS deny-by-default (patrón wkh135: service_role bypassa por BYPASSRLS).
ALTER TABLE a2a_payment_intent_debit_signatures ENABLE ROW LEVEL SECURITY;
```

Notas:
- `NUMERIC(78,0)` cubre `uint256` completo sin pérdida (78 dígitos ≥ 2^256).
- `debit_key_id_hash`/`debit_amount_atomic`/`debit_deadline`/`debit_nonce` = los 4 campos del mensaje EIP-712 tal como se validaron (útil para que 191b reconstruya y presente la misma firma sin re-derivar).
- Los valores de status `'not_provided'`/`'not_applicable'` quedan en el CHECK para forward-compat de 191b pero **no se escriben en 191a** (ver §5.4: se persiste fila solo cuando flag ON + escrow configurado + firma presente). Documentado.

### 4.2 RPC `capture_debit_signature` (SECURITY DEFINER, atómico, owner-guarded)

Persiste la fila con el veredicto ya computado en TS, re-chequeando el anti-replay del nonce dentro de la misma tx (race-safe). NUNCA mueve dinero.

```
capture_debit_signature(
  p_intent_id UUID, p_owner_ref TEXT, p_key_id UUID,
  p_key_id_hash TEXT, p_amount_atomic NUMERIC, p_deadline BIGINT, p_nonce NUMERIC,
  p_signature TEXT, p_recovered TEXT, p_status TEXT, p_reason TEXT
) RETURNS TABLE(persisted_status TEXT, persisted_reason TEXT)
```

Lógica:
1. `SELECT owner_ref FROM a2a_payment_intents WHERE id = p_intent_id FOR UPDATE` → si `IS DISTINCT FROM p_owner_ref` o NOT FOUND → RAISE `OWNERSHIP_MISMATCH`/`INTENT_NOT_FOUND` (CD-6). *(La captura es best-effort: el caller atrapa y descarta — CD-2/DT-4.)*
2. Si `p_status = 'valid'`: `SELECT 1 FROM …_debit_signatures WHERE key_id = p_key_id AND debit_nonce = p_nonce AND debit_validation_status = 'valid'`. Si existe → override `v_status := 'invalid'`, `v_reason := 'NONCE_ALREADY_USED'` (AC-5). Si no, `v_status := 'valid'`.
3. `INSERT` de la fila con `v_status`/`v_reason`. El índice parcial `uq_debit_sig_valid_nonce` es backstop de carrera (23505 sobre insert 'valid' concurrente → el caller lo captura y NO propaga; se re-registra como invalid `NONCE_ALREADY_USED` best-effort).
4. `RETURN` del status/reason efectivamente persistido.

`REVOKE … FROM PUBLIC, anon, authenticated; GRANT … TO service_role;` (patrón wkh135).

### 4.3 Down-migration
`…_down.sql`: `DROP FUNCTION IF EXISTS capture_debit_signature(...); DROP TABLE IF EXISTS a2a_payment_intent_debit_signatures;` (patrón `..._payment_intents_down.sql`).

---

## 5. Flujo server-side: paso, validación, gating

### 5.1 Route → Service (campos opcionales del body)

En `POST /session/:id/close` y `POST /upto/:id/settle` (`payments.ts`), write-boundary aditivo (NO obligatorio):
- `debitSignature?: string` (0x-hex no vacío),
- `debitNonce?: string` (decimal uint256 en string — `bigint` sin float),
- `debitDeadline?: number` (entero epoch seconds finito),
- `debitAmount?: string` (decimal uint256 atómico en string — ver DT-3b).

Reglas del write-boundary (CD-1):
- **Si `ESCROW_DEBIT_CAPTURE_ENABLED !== 'true'` → los 4 campos se ignoran por completo, no se parsean, no se pasan al service.** Comportamiento byte-idéntico (AC-3).
- Con flag ON: si `debitSignature` está ausente → no se intenta captura (no se persiste nada; `not_provided` NO se escribe). Si está presente pero malformado (no 0x-hex / nonce no numérico / deadline no entero) → NO rompe el request; se pasa al capture helper que lo marca `invalid` best-effort. El close/settle procede igual.
- Los campos se pasan a `closeSession`/`settleUpto` como un objeto opcional `debitCapture?`.

### 5.2 Service: punto de captura (best-effort, no bloqueante — DT-4/CD-2)

En `closeSession` y `settleUpto`, **dentro de la rama `open→closing`, después de computar `finalUsd`** (session `:677`, upto `:982`) y **antes de** `settlePaymentIntentOnChain`, invocar:

```ts
await captureDebitSignatureBestEffort({
  intentId, ownerRef, keyId: row.key_id, chainId: row.chain_id,
  finalAmountUsd: finalUsd, capture: debitCapture,
});
```

- `captureDebitSignatureBestEffort` está envuelto en `try/catch` que **NUNCA re-lanza** (mismo espíritu que `settlePaymentIntentOnChain` CD-7): cualquier error interno se loguea (`log.warn`) y se descarta. El `await` no puede afectar el resultado del settle porque no propaga excepciones ni muta el flujo.
- Se ejecuta **una sola vez** (solo en la transición `open→closing`; las ramas idempotentes/recovery `prev_status !== 'open'` NO capturan — no hay firma nueva del cliente en un retry de recovery).
- Con `finalMicro <= 0` (nada que cobrar): se captura igual si hay firma (el `amount` firmado sería 0 atómico; validación normal aplica).

### 5.3 Helper de validación (`captureDebitSignature`)

Nuevo módulo `src/adapters/escrow/debit-capture.ts` (o helper en `payment-intent.ts`; ver DT-7). Nuevo helper de **recover** en `eip712.ts` (reuso de tipos, CD-5): `recoverDebitAuthorization({ message, domain, signature }) → address | null`.

Pasos (orden de prioridad de reason):
1. **Gate escrow**: `chainKey = getDefaultChainKey()` (el intent es default-chain, `payments.ts:42`); `verifyingContract = resolveEscrowContract(chainKey)`. Si `null` → **no persistir** (`not_applicable`, AC-3, byte-idéntico). Return.
2. `token = getAdaptersBundle(chainKey)?.payment.supportedTokens[0]`. Si falta → no persistir (config inválida), `log.warn`. Return.
3. Derivar: `keyIdHash = keccak256(stringToBytes(keyId))`; `serverAmountAtomic = parseUnits(finalAmountUsd_asString, token.decimals)`.
4. Parseo defensivo del body: `nonce = BigInt(debitNonce)`, `deadline = BigInt(debitDeadline)`, `clientAmount = BigInt(debitAmount)`. Si alguno lanza → `status='invalid'`, `reason='MALFORMED_INPUT'`, `recovered=null`; persistir; return.
5. **Recover**: `recovered = recoverDebitAuthorization({ domain: buildDebitDomain(chainId, verifyingContract), message: { keyId: keyIdHash, amount: clientAmount, deadline, nonce }, signature })`. Se reconstruye con `clientAmount` (lo que el cliente dice haber firmado) para poder distinguir signer-mismatch de amount-mismatch (AC-2).
6. Determinar status/reason (prioridad):
   - `now > deadline` → `DEADLINE_EXPIRED` (AC-6, espejo `sol:125`).
   - `deadline > now + MAX_DEADLINE_TTL(3600)` → `DEADLINE_TOO_FAR` (converge `sol:127`; refuerza fidelidad — R-2).
   - `recovered === null || recovered.toLowerCase() !== buyer_wallet.toLowerCase()` → `SIGNER_MISMATCH` (AC-2, espejo `sol:134`). *(buyer_wallet: ver §5.5.)*
   - `clientAmount !== serverAmountAtomic` → `AMOUNT_MISMATCH` (AC-2 — el monto firmado ≠ `min(Σvouchers,deposit)` / `min(cap,uso)` computado server-side).
   - resto → `valid` (el RPC re-chequea nonce → puede degradar a `NONCE_ALREADY_USED`, AC-5).
7. Persistir vía `capture_debit_signature` RPC (§4.2). El status persistido devuelto puede diferir del pre-computado (degradación a `NONCE_ALREADY_USED`).
8. **Nunca** invocar `escrow.debit()` / `writeContract` / adaptador on-chain (CD-3/CD-7/AC-4). La firma persistida es INERTE.

### 5.4 `debit_validation_status` — cuándo se escribe qué

| Condición | Fila persistida | status |
|---|---|---|
| flag OFF | ninguna (campos ignorados) | — |
| flag ON, sin `debitSignature` | ninguna | — |
| flag ON, escrow no configurado (`resolveEscrowContract=null`) | ninguna | — (conceptualmente `not_applicable`, no se escribe) |
| flag ON, escrow OK, firma OK todos los checks | fila | `valid` |
| flag ON, escrow OK, falla algún check | fila | `invalid` (+reason) |

### 5.5 `buyer_wallet` para la comparación del firmante (DT-3)

El firmante recuperado se compara contra `buyer_wallet` **del intent** (persistido en `a2a_payment_intents.buyer_wallet` al `open`, = `funding_wallet` del opener). `close_payment_intent_for_settle` **no** retorna `buyer_wallet`, y modificar su `RETURNS TABLE` exige `DROP FUNCTION` (riesgo). Por eso el capture helper hace su **propia lectura owner-guarded**: `SELECT buyer_wallet FROM a2a_payment_intents WHERE id = intentId AND owner_ref = ownerRef` (defensa CD-6; best-effort). Se compara contra el `buyer_wallet` de la fila, no contra el `funding_wallet` del closer (que podría diferir si close y open usaron keys distintas del mismo owner). Si `buyer_wallet IS NULL` → `SIGNER_MISMATCH` (no hay ancla).

---

## 6. Flag `ESCROW_DEBIT_CAPTURE_ENABLED`

- Leída SIEMPRE como `process.env.ESCROW_DEBIT_CAPTURE_ENABLED === 'true'` (default OFF/unset). Helper `isDebitCaptureEnabled()` en un único choke-point (patrón `isArbiterEnabled()` en `arbiter.ts`).
- **Gate primario en el route** (antes de pasar campos al service): con OFF, los campos `debit*` no se leen del body → el service recibe `debitCapture=undefined` → byte-idéntico (AC-3, CD-1).
- **Gate secundario (defensa en profundidad) en el service**: `captureDebitSignatureBestEffort` chequea `isDebitCaptureEnabled()` y retorna sin efecto si OFF (por si algún caller interno pasara el objeto).
- Doble gate ⇒ imposible que con OFF se persista o se parsee una firma.

---

## 7. Waves de implementación

### W0 (serial — contratos/tipos/migración; base de todo)
- **W0.1** Migración `supabase/migrations/<ts>_wkh191a_debit_signature_capture.sql` (§4.1 tabla + §4.2 RPC) + `..._down.sql`. Regenerar tipos supabase si el repo los tipa (verificar patrón de generación del proyecto).
- **W0.2** `src/adapters/escrow/eip712.ts`: agregar `recoverDebitAuthorization(...)` (reusa `DEBIT_AUTHORIZATION_TYPES`/`buildDebitDomain`; sale de PROVISIONAL para este call-site). Firma pura, sin red/DB.
- **W0.3** Tipos: `DebitCaptureInput` (los 4 campos + opcionalidad) + `DebitValidationReason` enum en `src/types/` (o junto al helper).

### W1 (validación + captura — depende de W0)
- **W1.1** `src/adapters/escrow/debit-capture.ts`: `captureDebitSignature` (§5.3) + `captureDebitSignatureBestEffort` (wrapper no-throw) + `isDebitCaptureEnabled()`.
- **W1.2** `src/services/payment-intent.ts`: firmas de `closeSession`/`settleUpto` aceptan `debitCapture?: DebitCaptureInput`; invocación en la rama `open→closing` (§5.2). Cero cambios al seam `settlePaymentIntentOnChain`.
- **W1.3** `src/routes/payments.ts`: write-boundary aditivo + gate de flag (§5.1/§6). Pasa `debitCapture` a los service methods.

### W2 (persistencia — se cierra con W0.1)
- Ya cubierta por el RPC de W0.1; W2 = wiring del helper al RPC (`supabase.rpc('capture_debit_signature', …)`) — realmente parte de W1.1. Se lista aparte solo para el test plan de persistencia.

Paralelizable: W0.2/W0.3 en paralelo a W0.1. W1.* serial tras W0.

---

## 8. Riesgos / notas de convergencia

- **R-1 (decimales del escrow token):** el `amount` firmado converge con el contrato solo si `supportedTokens[0]` de la chain del intent == `_usdc` del escrow (mismos decimales). Solo auto-consistente con `default chain == Base Sepolia`. Divergencia ⇒ `AMOUNT_MISMATCH`, jamás movimiento de fondos (captura inerte). Documentar en Story File.
- **R-2 (ventana de deadline):** el contrato rechaza `deadline > now + 1h` (`DeadlineTooFar`). 191a agrega `DEADLINE_TOO_FAR` para que la firma capturada como `valid` sea efectivamente consumible por 191b dentro de la ventana. AC-6 solo exige `DEADLINE_EXPIRED`; `DEADLINE_TOO_FAR` es un refuerzo de fidelidad, no rompe AC-6.
- **R-3 (nonce quemado solo si valid):** el índice parcial `WHERE status='valid'` refleja que el contrato consume el nonce solo en `debit()` exitoso; intentos inválidos NO bloquean un reintento válido posterior con el mismo nonce (fiel al contrato).
- **R-4 (best-effort real):** el `await captureDebitSignatureBestEffort` corre en el hilo del settle. Debe estar garantizado no-throw (CD-2). Riesgo: una excepción no atrapada rompería el close/settle. Mitigación: wrapper `try/catch` total + test T-8 (flag ON + capture que lanza → settle intacto).

---

## 9. Constraint Directives (heredados del work-item + específicos del SDD)

Heredados: CD-1..CD-7 del work-item (flag-gated default OFF; captura no bloquea el settle; prohibido `debit()`/on-chain; prohibido tocar `contracts/`; reuso EXACTO de `eip712.ts`; Ownership Guard `owner_ref`; firma inerte).

Específicos del SDD:
- **CD-S1:** el mensaje EIP-712 se **reconstruye server-side** (keyId + amount server-derivados); el cliente NO dicta `keyId` ni el `amount` "de verdad" (se cross-chequea contra el server). Prohibido recover sobre un typed-data crudo provisto por el cliente.
- **CD-S2 (auto-blindaje WKH-173):** ningún helper `async` de captura debe `return`ear un `FastifyReply`; el flujo de close/settle no debe cambiar su early-return por la captura. La captura no responde el request — solo persiste.
- **CD-S3 (auto-blindaje WKH-189):** rutas Fastify con Body tipado → generic en `fastify.post<{ Body: … }>()`, nunca en el tipo del `request`. Correr `biome format --write` sobre cada archivo tocado antes del check de cierre de wave.
- **CD-S4 (auto-blindaje WKH-189):** queries supabase que tipan el `data` a mano → `as unknown as T[]` (cast doble) para evitar `TS2352`.
- **CD-S5:** validar RANGO/formato de los inputs `debit*` en el helper ANTES de cualquier persistencia; nunca confiar en el clamp como primera baranda (lección WKH-189 fix-pack). El write-boundary del route NO rechaza el request por `debit*` malformado (best-effort), pero el helper los marca `invalid`.

---

## 10. Plan de tests (≥1 por AC)

Archivos: `src/adapters/escrow/eip712.test.ts` (helper recover), `src/adapters/escrow/debit-capture.test.ts` (nuevo, unit de validación con supabase mockeado), `src/services/payment-intent.test.ts` (captura no bloquea el settle), `src/routes/payments.test.ts` (byte-idéntico flag OFF). Firmante = `privateKeyToAccount` (mock, patrón `eip712.test.ts`).

| Test | Cubre | Asserción |
|---|---|---|
| T-1 | AC-1 | firma válida (recovered==buyer_wallet, amount==final, deadline en ventana, nonce libre) → RPC persiste `status='valid'` con los 4 campos; el `SettleOutcome` del close/settle es idéntico al del caso sin firma. |
| T-2 | AC-2 (amount) | `debitAmount != serverFinalAtomic` → `invalid`/`AMOUNT_MISMATCH`; el settle NO se altera (mismo `status`/`txHash`). |
| T-2b | AC-2 (signer) | firma de una PK ≠ buyer_wallet → `invalid`/`SIGNER_MISMATCH`; settle intacto. |
| T-3 | AC-3 (flag OFF) | `ESCROW_DEBIT_CAPTURE_ENABLED` unset + body con `debit*` → CERO filas insertadas, response byte-idéntica al baseline; `capture_debit_signature` nunca llamado. |
| T-3b | AC-3 (escrow no config) | flag ON pero `A2A_ESCROW_CONTRACT_*` unset → `resolveEscrowContract=null` → cero persistencia, settle intacto. |
| T-4 | AC-4 (inerte) | tras persistir `valid`, se verifica que NINGÚN adaptador on-chain / `writeContract` / `escrow.debit()` fue invocado (spy sobre el adapter); el path de fondos sigue por `settlePaymentIntentOnChain`. |
| T-5 | AC-5 (anti-replay) | dos capturas `valid` con el mismo `(key_id, nonce)` → la 2ª persiste `invalid`/`NONCE_ALREADY_USED` (vía RPC + índice parcial); el settle de ambos requests intacto. |
| T-6 | AC-6 (deadline) | `debitDeadline` en el pasado → `invalid`/`DEADLINE_EXPIRED`, no `valid`. |
| T-6b | R-2 | `debitDeadline > now + 3600` → `invalid`/`DEADLINE_TOO_FAR`. |
| T-7 | Ownership (CD-6) | `capture_debit_signature` con `owner_ref` que no es dueño del intent → RAISE `OWNERSHIP_MISMATCH` (RPC), atrapado best-effort, settle intacto, sin fila `valid`. |
| T-8 | CD-2/DT-4/R-4 | flag ON + capture helper que lanza (mock que throwea) → `closeSession`/`settleUpto` retornan el `SettleOutcome` normal (la excepción no propaga). |
| T-9 | DT-2/MI-1 | `parseUnits` usa `token.decimals` (6 en Base Sepolia): un `finalAmountUsd=1.5` → `serverAmountAtomic == 1_500000n` (6d), NO `1.5e18`. |
| T-10 | §3 convergencia | `recoverDebitAuthorization` sobre una firma producida con el domain `WasiAIEscrow`/`1` + `DEBIT_AUTHORIZATION_TYPES` recupera exactamente `signer.address` (mirror del recover de `_verifyAndConsume`). |

---

## 11. Readiness Check

- [x] Typed-data resuelto byte-a-byte con `WasiAIEscrow._verifyAndConsume` (§3), reuso de `eip712.ts` (CD-5).
- [x] MI-1 (decimals=6 Base Sepolia USDC) resuelto y verificado en `base/payment.ts:61`.
- [x] MI-2 (tabla sibling `a2a_payment_intent_debit_signatures`) resuelto (§4, DT-6).
- [x] Punto de captura identificado en `payment-intent.ts` (rama `open→closing`, `finalUsd` conocido) — §5.2.
- [x] Gating flag doble (route + service) especificado — §6 (AC-3 byte-idéntico).
- [x] Anti-replay del nonce escopeado por `key_id`, índice parcial `WHERE status='valid'`, NO reusa `uq_a2a_payment_intents_cap_nonce` (DT-5) — §4.1.
- [x] Ownership Guard `owner_ref` en tabla + RPC + lectura de `buyer_wallet` (CD-6) — §4/§5.5.
- [x] Best-effort no-throw garantizado (wrapper) — §5.2/§9/T-8.
- [x] Cero side-effects on-chain (AC-4/CD-3/CD-7) — §5.3 paso 8 + T-4.
- [x] Cero cambios en `contracts/` (CD-4) — el SDD solo lee Solidity.
- [x] Exemplars verificados (paths reales) — §1.
- [x] Auto-blindaje histórico incorporado (WKH-173 FastifyReply, WKH-189 generics/biome/cast) — CD-S2..S5.
- [x] Test plan ≥1 por AC (AC-1..AC-6) + convergencia + best-effort — §10.
- Sin `[NEEDS CLARIFICATION]` bloqueantes. Nota abierta (no bloqueante): DT-3b agrega `debitAmount` como 4º campo opcional para poder distinguir `AMOUNT_MISMATCH` de `SIGNER_MISMATCH` (AC-2 pide reasons específicas); si el founder prefiere el mínimo de 3 campos, se degrada a un único reason `SIGNER_OR_AMOUNT_MISMATCH` (sigue money-safe). Reportado al orquestador.

---

## 12. Decisiones técnicas del SDD (además de las DT-1..DT-5 del work-item)

- **DT-6:** persistencia en tabla sibling con historial (MI-2). Ver §4.1.
- **DT-7:** helper de captura en módulo nuevo `src/adapters/escrow/debit-capture.ts` (aísla la dependencia de `escrow-verifier`/`registry` fuera de `payment-intent.ts`, que ya es grande; el service solo invoca el wrapper). El helper de **recover** vive en `eip712.ts` (junto a build/hash, reuso de tipos).
- **DT-3b (extiende DT-3):** el body incluye `debitAmount` opcional (atómico string) además de `debitSignature`/`debitNonce`/`debitDeadline`, para reconstruir el mensaje con lo que el cliente firmó y así distinguir `SIGNER_MISMATCH` vs `AMOUNT_MISMATCH` (AC-2). El server igual recomputa `serverAmountAtomic` y exige igualdad para `valid` (no confía en `debitAmount`). Desviación consciente de la lista literal de 3 campos del Scope IN — reportada.
</content>
</invoke>
