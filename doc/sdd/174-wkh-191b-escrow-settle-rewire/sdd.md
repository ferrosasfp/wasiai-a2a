# SDD — [WKH-191b] Rewire escrow-aware del settle (flujo normal, two-hop)

> F2 · SDD_MODE full · Estimación L · Branch `feat/191b-escrow-settle-rewire`
> Input: `work-item.md` (esta carpeta) + `sdd.md`/`done-report.md` de 191a (fila 173) + epic (fila 172).
> Alcance: **consumir** la firma `valid` que 191a persiste (INERTE) y ejecutar el settle real
> como un **two-hop on-chain** (escrow.debit → operador→seller), flag-gated, byte-idéntico con
> el flag OFF. Cero Solidity, cero cambios al accounting off-chain de `budget`.

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo:línea | Por qué lo leí | Qué extraje / patrón |
|---|---|---|
| `src/services/payment-intent.ts:347-463` | El seam WKH-136 `settlePaymentIntentOnChain` (hop 2 de HOY) | sign→settle→verify; vocabulario `failureKind: 'unequivocal'\|'ambiguous'`; **NUNCA rechaza** (CD-7). `usdToWei(finalAmountUsd)` **hardcodea 18 decimales** (`:145-149`) → ver R-1 (convergencia con USDC 6d de Base). Hop 2 = este seam TAL CUAL (DT-5). |
| `src/services/payment-intent.ts:568-696` | `closeSession` — punto de settle + captura 191a | Rama `open→closing` (`:679-683`) computa `finalUsd = min(consumed,deposit)`; `:687-696` invoca `captureDebitSignatureBestEffort` (191a); `:727-733` llama `settlePaymentIntentOnChain`. **Ese call-site es el que 191b intercepta.** |
| `src/services/payment-intent.ts:768-836` | Ramas de fallo del settle (session) | `unequivocal` → `finalize('failed_unequivocal')` = **refund**; `ambiguous` → `RECONCILE:` + `finalize('failed_ambiguous')` = **status failed, NO refund**. El patrón `failed_ambiguous` YA es "no-refund + reconciliar". |
| `src/services/payment-intent.ts:897-1160` | `settleUpto` — settle + captura + fallo | `:1005-1014` captura 191a; `:1044-1061` `debitBuyer` (débito off-chain ANTES del settle); `:1063-1069` `settlePaymentIntentOnChain`; ramas de fallo idénticas a session. `debitBuyer` NO se toca (Scope OUT). |
| `src/services/payment-intent.ts:229-305` | `recordSettleOutcome` + `finalizePaymentIntent` (wrappers TS) | BLQ-DR: persistir veredicto ANTES del side-effect. El wrapper de 191b usa el MISMO principio para el hop-1 tx hash. |
| `supabase/migrations/20260704000000_wkh135_payment_intents.sql:305-455` | `record_settle_outcome` + `finalize_payment_intent` (SQL) | `settle_outcome` CHECK ∈ `('settled','failed_unequivocal','failed_ambiguous')`. `finalize` con `failed_ambiguous` (rama `ELSE`, `:439-445`) = **status='failed', NO refund**. → 191b **reusa `failed_ambiguous`** para reconciliation-pending; **NO agrega** un settle_outcome nuevo (evita tocar el RPC auditado). |
| `src/adapters/escrow/debit-capture.ts:20-238` | Módulo 191a (capture + reader base) | `isDebitCaptureEnabled()`, gate escrow (`resolveEscrowContract`), `getDefaultChainKey`, `getAdaptersBundle`, `parseUnits(finalAmountUsd, token.decimals)`. El reader de 191b vive acá (sibling). |
| `src/adapters/escrow/eip712.ts:31-38,150-178` | `DEBIT_AUTHORIZATION_TYPES` + `recoverDebitAuthorization` (CD-7 reuso) | Orden EXACTO `keyId,amount,deadline,nonce`. 191b NO re-firma: consume la firma cruda del cliente ya persistida (`debit_signature`). |
| `src/adapters/escrow/abi.ts:19-60` | `ESCROW_ABI` con `debit` (5 args) | `debit(bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce, bytes signature)`. Falta el evento `Debited` para la re-verificación → se agrega (aditivo, converge con el contrato). |
| `src/adapters/escrow-verifier.ts:94-254` | `resolveEscrowContract` + patrón de verificación on-chain | Gate por chain (`A2A_ESCROW_CONTRACT_<FAMILY>` → `null` = fallback). `verifyEscrowDeposit` escanea logs por `Deposited` filtrando por dirección del contrato + min confirmaciones → **espejo directo** para re-verificar `Debited` en hop 1. |
| `src/adapters/deposit-verifier.ts:68-217` | Helpers chain-genéricos (DT-6) | `resolveChainFamilyEnvSuffix`, `resolveMinConfirmations`, `resolveRpcUrl`, `resolveChainObject`, `buildRpcTransport`. Reuso obligatorio para el walletClient/publicClient de hop 1 (sin duplicar). |
| `src/adapters/base/gasless.ts:235-296,392-480` | **Exemplar del writeContract + receipt** | `createWalletClient({account: privateKeyToAccount(OPERATOR_PRIVATE_KEY), chain, transport: buildRpcTransport(...)})`; `walletClient.writeContract({address, abi, functionName, args, chain, account})`; `publicClient.waitForTransactionReceipt({hash, timeout})`; `receipt.status !== 'success'` = revert. Patrón EXACTO para hop 1. |
| `src/adapters/base/payment.ts:61,455-495` | Decimals reales del token de hop 2 en Base | `USDC_DECIMALS = 6`; `sign()` toma `opts.value` **verbatim como atómico 6d**. Confirma R-1: `usdToWei` (18d) del seam **no converge** con Base USDC (6d). |
| `contracts/src/WasiAIEscrow.sol:62,120-156` | `debit`/`_verifyAndConsume` + evento (solo lectura) | `event Debited(bytes32 indexed keyId, address indexed operator, uint256 amount, uint256 nonce)` (`:62`); `debit` paga a `msg.sender`=operador (`:154`); `_usedNonces[keyId][nonce]` quemado SOLO en debit exitoso (`:139`); `_operator` gate → `NotOperator` si `OPERATOR_PRIVATE_KEY` ≠ operador on-chain (191d). |
| `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql` | Tabla + RPC 191a a extender | `a2a_payment_intent_debit_signatures` (historial 1:N; `uq_debit_sig_valid_nonce WHERE status='valid'`); RPC `capture_debit_signature`. 191b agrega columnas nullable + 2 RPC, sin tocar lo existente. |
| `doc/sdd/173-…/done-report.md` (Notas para 191b) | Herencia directa | `debit_amount_atomic`/`debit_nonce` tipadas `string` (NUMERIC 78,0) → `BigInt()` al leer; binding `buyer_wallet==depositor` ya validado en captura (191a). |
| `doc/sdd/{173,171}-…/auto-blindaje.md` | Errores recurrentes (ver §11) | biome-write en cada archivo (código+test); NUMERIC uint256 → `string`; supabase select tipado a mano → `as unknown as T`; validar RANGO antes del clamp. |

---

## 2. Decisiones técnicas (DT-N)

Heredadas del work-item: **DT-1** (two-hop secuencial, confirmar hop 1 antes de hop 2),
**DT-2** (idempotencia app-side vía tx hash de hop 1 persistido ANTES de hop 2), **DT-3**
(flag `ESCROW_SETTLE_ENABLED` AND `ESCROW_DEBIT_CAPTURE_ENABLED`), **DT-4** (corte 191b/191c),
**DT-5** (hop 2 = seam sin cambios), **DT-6** (reuso de helpers de `deposit-verifier.ts`).

Específicas del SDD:

- **DT-7 (wrapper, NO mutar el seam auditado):** el orquestador del two-hop es una función
  nueva `settleEscrowAware(...)` en `payment-intent.ts`. `settlePaymentIntentOnChain` (el seam
  WKH-136, auditado) queda **byte-idéntico** y se invoca INTERNAMENTE por el wrapper para el
  hop 2 y para el fallback. `closeSession`/`settleUpto` cambian su ÚNICO call-site
  (`…OnChain(...)` → `settleEscrowAware(...)`). Con el flag OFF el wrapper delega en la 1ª línea
  → cero lecturas nuevas, cero latencia, byte-idéntico (CD-1/CD-2). *(El work-item sugería
  "extender el seam"; el wrapper cumple el intent con menor riesgo sobre el código auditado —
  desviación consciente, reportada.)*
- **DT-8 (reconciliation-pending = `failed_ambiguous` + evidencia en la fila de la firma):** NO
  se agrega un `settle_outcome` nuevo. La marca reconciliation-pending se expresa con el
  veredicto EXISTENTE `failed_ambiguous` (que `finalize_payment_intent` ya trata como *status
  failed, NO refund*, `:439-445`) + prefijo `RECONCILE-ESCROW:` en `error_message` + el estado
  durable `debit_settle_status='reconciliation_pending'` (+ `debit_hop1_tx_hash`) en la fila de
  la firma consumida. Así 191c tiene una query limpia y 191b **no toca** los RPC money-path
  auditados (menor superficie de riesgo, CD-2).
- **DT-9 (persistencia = columnas nullable en la tabla 191a, no sibling):** el nonce se quema
  on-chain una sola vez y hay exactamente UNA fila `valid` por `(key_id, nonce)`
  (`uq_debit_sig_valid_nonce`). El ciclo de vida del consumo (hop1 → settled/reconcile) es 1:1
  con esa fila → columnas nullable aditivas alcanzan (work-item Scope IN). Sibling sería
  sobre-diseño.
- **DT-10 (walletClient escrow chain-genérico):** módulo nuevo `debit-executor.ts` con un
  walletClient cacheado por `ChainKey` derivado de `OPERATOR_PRIVATE_KEY` (espejo de
  `base/gasless.ts:235-266`), usando `resolveChainObject`/`resolveRpcUrl`/`buildRpcTransport`
  (DT-6). Un solo firmante on-chain nuevo: el operador presentando `debit()`.
- **DT-11 (timeout explícito de hop 1):** env `ESCROW_DEBIT_RECEIPT_TIMEOUT_MS` (default
  `60_000`, mismo orden que `GASLESS_RECEIPT_TIMEOUT_MS`/`FACILITATOR_TIMEOUT_MS=30_000`; el
  two-hop es más lento). `waitForTransactionReceipt({ hash, timeout, confirmations:
  resolveMinConfirmations(chainKey) })` — la opción `confirmations` cubre el umbral sin un
  chequeo manual de block-number.

---

## 3. Convergencia del `amount` — R-1 (CRÍTICO, money-path, activación)

**Hop 1** (`escrow.debit`) mueve `amount` en unidades atómicas del `_usdc` del contrato =
**USDC Base Sepolia, 6 decimales** (único deploy, epic hallazgo #4). La firma persistida por
191a ya está en 6d (`debit_amount_atomic` = `parseUnits(finalUsd, token.decimals)` con
`token=bundle(Base).supportedTokens[0]`). **Hop 1 converge.**

**Hop 2** reusa `settlePaymentIntentOnChain`, que computa `value = usdToWei(finalAmountUsd)`
= `BigInt(round(usd*1e6)) * 1e12` = **18 decimales hardcodeados** (`payment-intent.ts:145-149`).
`base/payment.ts:sign()` toma ese `value` **verbatim como atómico contra USDC 6d**
(`:464,490`). ⇒ en un default-chain **Base**, el forward operador→seller firmaría 10¹²× el
monto correcto.

**Implicación:** el escrow SOLO existe en Base Sepolia; la única config auto-consistente para
activar el two-hop es `default chain == Base Sepolia` (R-1 de 191a). Pero en ese default el
hop 2 (el seam de HOY, 18d) NO converge con USDC 6d → el `settle` sería rechazado por balance
insuficiente (`settle.success===false`).

**Por qué 191b sigue siendo money-safe igual (no pierde ni paga de más):** un hop 2 que falla
DESPUÉS de un hop 1 confirmado NO reembolsa ni asume pago — cae a **reconciliation-pending**
(§5, rama C-fail). Nunca se firma un pago incorrecto que el facilitator acepte: el
`InsufficientBalance` del token surface como `settle.success===false` → veredicto de fallo →
reconciliation-pending. **No hay pérdida ni sobrepago; hay un settle que no completa.**

**Corte de responsabilidad:** hacer el seam WKH-136 decimals-aware (6d en Base) está **fuera
de 191b** (DT-5 + CD-2 prohíben cambiar el comportamiento del seam auditado). Es un pre-existente
del seam (hoy default=kite 18d, por eso funciona). Se escala como **MI-1 (bloqueante de
activación end-to-end, NO de código de 191b)** — pertenece a 191d/191e o a una HU dedicada de
seam. **191b es code-complete, correcto y money-safe sin esto; el happy-path two-hop en Base no
completará hop 2 hasta que el seam sea decimals-aware.** Reportado al orquestador.

---

## 4. Persistencia (migración additive — extiende 191a)

### 4.1 Columnas nullable nuevas (DT-9)

```sql
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD COLUMN IF NOT EXISTS debit_hop1_tx_hash      TEXT,          -- tx de escrow.debit() (hop 1)
  ADD COLUMN IF NOT EXISTS debit_hop1_confirmed_at TIMESTAMPTZ,   -- confirmación on-chain de hop 1
  ADD COLUMN IF NOT EXISTS debit_settle_status     TEXT
    CHECK (debit_settle_status IS NULL OR
           debit_settle_status IN ('hop1_confirmed','settled','reconciliation_pending'));

-- Query de 191c: intents con hop 1 movido pero settle no completado.
CREATE INDEX IF NOT EXISTS idx_debit_sig_settle_status
  ON a2a_payment_intent_debit_signatures (debit_settle_status)
  WHERE debit_settle_status IN ('hop1_confirmed','reconciliation_pending');
```

`NULL` en `debit_settle_status` = firma capturada pero aún NO consumida (estado 191a).
`debit_hop1_tx_hash` presente = **guardia de exactly-once** (DT-2): si está seteado, hop 1 ya
se ejecutó → NUNCA re-debitar.

### 4.2 RPC `record_debit_hop1` (SECURITY DEFINER, owner-guarded, idempotente)

Persiste el tx hash de hop 1 **ANTES** de intentar hop 2 (BLQ-DR). Idempotente: si
`debit_hop1_tx_hash` ya está seteado, **no-op** (no lo sobreescribe) — segunda llamada retorna
el hash existente.

```
record_debit_hop1(
  p_intent_id UUID, p_owner_ref TEXT, p_key_id UUID, p_nonce NUMERIC, p_tx_hash TEXT
) RETURNS TABLE(persisted_tx_hash TEXT)
```
Lógica:
1. `SELECT owner_ref FROM a2a_payment_intents WHERE id=p_intent_id FOR UPDATE` → NOT FOUND →
   RAISE `INTENT_NOT_FOUND`; `IS DISTINCT FROM p_owner_ref` → RAISE `OWNERSHIP_MISMATCH` (CD-6/WKH-53).
2. `UPDATE a2a_payment_intent_debit_signatures
     SET debit_hop1_tx_hash = COALESCE(debit_hop1_tx_hash, p_tx_hash),
         debit_hop1_confirmed_at = COALESCE(debit_hop1_confirmed_at, now()),
         debit_settle_status = COALESCE(debit_settle_status, 'hop1_confirmed')
   WHERE key_id=p_key_id AND debit_nonce=p_nonce AND debit_validation_status='valid'`
   *(idempotente por COALESCE: la 1ª escritura gana; retries no mueven el hash).*
3. `RETURN` el `debit_hop1_tx_hash` efectivo de la fila.

### 4.3 RPC `record_debit_settle_status` (SECURITY DEFINER, owner-guarded)

Flip terminal del ciclo de vida del consumo, tras resolver hop 2.

```
record_debit_settle_status(
  p_intent_id UUID, p_owner_ref TEXT, p_key_id UUID, p_nonce NUMERIC, p_status TEXT
) RETURNS void   -- p_status ∈ ('settled','reconciliation_pending')
```
Owner-guard idéntico (paso 1) + `UPDATE … SET debit_settle_status=p_status WHERE key_id AND
debit_nonce AND debit_validation_status='valid'`. No mueve dinero. `search_path` fijado;
`REVOKE … FROM PUBLIC, anon, authenticated; GRANT … TO service_role` (patrón wkh135/191a).

### 4.4 Down-migration
`…_down.sql`: `DROP FUNCTION` de ambos RPC + `DROP INDEX idx_debit_sig_settle_status` +
`ALTER TABLE … DROP COLUMN` de las 3 columnas. Reversible, no destruye datos de 191a.

### 4.5 `database.types.ts`
Agregar las 3 columnas nullable a Row/Insert/Update de `a2a_payment_intent_debit_signatures`
(`debit_hop1_tx_hash: string | null`, etc.) + `record_debit_hop1`/`record_debit_settle_status`
en `Functions` (**`p_nonce: string`** — NUMERIC uint256, auto-blindaje 191a; `Returns` como
tipo). Correr `biome check --write` tras editar (auto-blindaje CD-S1).

---

## 5. El flujo `settleEscrowAware` (orquestador del two-hop)

Reemplaza el call-site `settlePaymentIntentOnChain(...)` en `closeSession` (`:727`) y
`settleUpto` (`:1063`). Firma:

```ts
settleEscrowAware(params: {
  intentId: string; ownerRef: string; payTo: string;
  finalAmountUsd: number; chainId: number; keyId: string;   // keyId = row.key_id (nuevo vs. el seam)
}): Promise<SettleOutcome>
```

Pasos (todo dentro de `try/catch` externo → cualquier error inesperado cae a
`settlePaymentIntentOnChain(params)` fallback, NUNCA rechaza — CD-2/CD-7):

**0. Fast-path flag OFF (byte-idéntico):**
`if (!isEscrowSettleEnabled()) return settlePaymentIntentOnChain(base)` — sin lecturas, sin
on-chain, sin latencia nueva (CD-1/CD-2, AC-2). `isEscrowSettleEnabled()` =
`process.env.ESCROW_SETTLE_ENABLED === 'true' && isDebitCaptureEnabled()` (AND, DT-3/CD-1).

**1. Gate escrow por chain (AC-6):**
`chainKey = getDefaultChainKey()`; `escrowContract = resolveEscrowContract(chainKey)`.
`escrowContract === null` → `return settlePaymentIntentOnChain(base)` (fallback; kite siempre
cae acá, R-1).

**2. Reader de la firma `valid` (AC-1/AC-7) — `readValidDebitSignature`:**
`SELECT debit_signature, debit_amount_atomic, debit_deadline, debit_nonce, debit_key_id_hash,
debit_hop1_tx_hash, debit_settle_status FROM a2a_payment_intent_debit_signatures WHERE
intent_id=? AND owner_ref=? AND debit_validation_status='valid' ORDER BY captured_at DESC LIMIT 1`
(owner-guarded, CD-6; cast `as unknown as Row` — auto-blindaje 189).
Si no hay fila → `return settlePaymentIntentOnChain(base)` (fallback, AC-2).
**Re-validaciones defensivas (fallback si fallan, ANTES de tocar on-chain — auto-blindaje 189
"validar antes del clamp"):**
  - `token = getAdaptersBundle(chainKey)?.payment.supportedTokens[0]`; `serverAtomic =
    parseUnits(finalAmountUsd.toString(), token.decimals)`; si `BigInt(row.debit_amount_atomic)
    !== serverAtomic` → fallback (el monto firmado ≠ el monto a settlear; NUNCA debitar un
    monto que no coincide — AC-7).
  - `now = floor(Date.now()/1000)`; `deadline = BigInt(row.debit_deadline)`; si `now > deadline`
    o `deadline > now + 3600n` → fallback (el contrato revertiría `DeadlineExpired`/`TooFar`;
    ahorramos el revert). *(191a ya validó esto en captura; defensa en profundidad.)*

**3. Guardia exactly-once (DT-2/CD-3/AC-5):**
`if (row.debit_hop1_tx_hash) { /* hop 1 YA ejecutado → NO re-debitar */ goto hop2 }`.

**4. Hop 1 — `executeDebitHop1` (§6):**
```
outcome1 = executeDebitHop1({ chainKey, escrowContract,
  keyIdHash: row.debit_key_id_hash, amount: BigInt(row.debit_amount_atomic),
  deadline: BigInt(row.debit_deadline), nonce: BigInt(row.debit_nonce),
  signature: row.debit_signature })
```
- `kind:'not_moved'` (writeContract lanzó pre-broadcast — `NotOperator`/gas/sim-revert — o
  `receipt.status==='reverted'`): **NINGÚN fondo del escrow salió** → **fallback**
  `return settlePaymentIntentOnChain(base)` (AC-3). No se escribe evidencia de consumo.
  *(Incluye `NonceAlreadyUsed` que surface como revert: money-safe, ver R-2.)*
- `kind:'ambiguous'` (`RECEIPT_TIMEOUT` / `DEBITED_EVENT_NOT_FOUND` con receipt success): el
  debit PUDO moverse → **NO fallback, NO hop 2**. Persistir reconciliation-pending
  (`record_debit_settle_status='reconciliation_pending'`; `record_debit_hop1` con el tx hash
  tentativo si existe) y `return { status:'failed', txHash:null, finalAmountUsd, failureKind:
  'ambiguous', error: 'RECONCILE-ESCROW: hop1 ambiguous ('+reason+')' }` (CD-4). 191c re-verifica.
- `kind:'confirmed'` (receipt success + confirmaciones + evento `Debited` matcheado):
  **persistir el tx hash ANTES de hop 2** (BLQ-DR/CD-3):
  `await recordDebitHop1({intentId, ownerRef, keyId, nonce: row.debit_nonce, txHash:
  outcome1.txHash})`. Continuar a hop 2.

**5. Hop 2 — el seam de HOY, sin cambios (DT-5):**
`outcome2 = await settlePaymentIntentOnChain(base)` (operador→seller EIP-3009, fondos propios
del operador — que YA recibió los del escrow en hop 1).
- `outcome2.status === 'settled'` → `recordDebitSettleStatus('settled')`; `return outcome2`
  (con el tx hash de hop 2). **Happy path two-hop: el seller cobró.**
- `outcome2.status === 'failed'` (`unequivocal` O `ambiguous`) → hop 1 YA movió los fondos del
  buyer al operador ⇒ **reconciliation-pending, NUNCA refund** (CD-4): `recordDebitSettleStatus
  ('reconciliation_pending')`; `return { status:'failed', txHash:null, finalAmountUsd,
  failureKind:'ambiguous', error: 'RECONCILE-ESCROW: hop1='+hop1Tx+' hop2-failed: '+
  (outcome2.error) }`.
  **⚠️ Remapeo money-path clave:** aun si `outcome2.failureKind==='unequivocal'` (que en el path
  normal dispararía **refund**), se FUERZA `failureKind:'ambiguous'` porque los fondos reales del
  buyer ya salieron del escrow → reembolsar el `budget`/`deposit` off-chain sería un
  doble-crédito contra el libro autoritativo on-chain (CD-4/CD-7-epic). El seller se paga en el
  retry hop-2-only (191c).

El caller (`closeSession`/`settleUpto`) recibe un `SettleOutcome` con el vocabulario existente
(`settled` / `failed`+`failureKind`) y lo procesa **sin cambios** en sus ramas ya escritas:
`ambiguous` → `RECONCILE:` + `finalize('failed_ambiguous')` = *status failed, NO refund*. La
única diferencia visible es el prefijo `RECONCILE-ESCROW:` y la evidencia en la fila de la firma.

---

## 6. `executeDebitHop1` (módulo nuevo `src/adapters/escrow/debit-executor.ts`)

WalletClient/publicClient cacheados por `ChainKey` (espejo `base/gasless.ts:235-296`).

```
executeDebitHop1(args): Promise<
  | { kind:'confirmed'; txHash:`0x${string}`; blockNumber:bigint }
  | { kind:'not_moved'; reason:string }
  | { kind:'ambiguous'; reason:string; txHash?:`0x${string}` } >
```

1. `wallet = getEscrowWalletClient(chainKey)` — `privateKeyToAccount(OPERATOR_PRIVATE_KEY)` +
   `resolveChainObject(chainKey)` + `buildRpcTransport({primary: resolveRpcUrl(chainKey),
   fallbackEnv: resolveRpcFallbackEnv(chainKey), chainId})`. Sin PK / sin RPC → `{ kind:
   'not_moved', reason:'OPERATOR_KEY_OR_RPC_UNSET' }` (fallback, money-safe).
2. **Broadcast (CD-8):**
   ```
   try { txHash = await wallet.writeContract({
     address: escrowContract, abi: ESCROW_ABI, functionName:'debit',
     args:[keyIdHash, amount, deadline, nonce, signature],
     chain: resolveChainObject(chainKey), account: wallet.account }) }
   catch (err) { return { kind:'not_moved', reason: sanitize(err) } }  // pre-broadcast → NO tx (AC-3)
   ```
3. **Receipt (DT-11):**
   ```
   try { receipt = await publicClient.waitForTransactionReceipt({
     hash: txHash, timeout: getEscrowReceiptTimeoutMs(),
     confirmations: resolveMinConfirmations(chainKey) }) }
   catch { return { kind:'ambiguous', reason:'RECEIPT_TIMEOUT', txHash } }  // broadcast, sin confirmar
   ```
4. `if (receipt.status !== 'success') return { kind:'not_moved', reason:'REVERTED', txHash }`
   *(revert = atómico, cero fondos movidos → fallback seguro; ver R-2).*
5. **Re-verify `Debited` (espejo `verifyEscrowDeposit:195-227`):** escanear `receipt.logs` por
   la dirección del `escrowContract`, `decodeEventLog(Debited)`, matchear
   `keyId===keyIdHash` (y `nonce===args.nonce`). No encontrado → `{ kind:'ambiguous', reason:
   'DEBITED_EVENT_NOT_FOUND', txHash }` (receipt success sin evento = contradicción; NO asumir).
6. `return { kind:'confirmed', txHash, blockNumber: receipt.blockNumber }`.

**`abi.ts` (aditivo, CD-7-safe):** agregar el evento a `ESCROW_ABI` — converge byte-a-byte con
el contrato (`WasiAIEscrow.sol:62`), NO es un ABI paralelo/divergente:
```ts
{ type:'event', name:'Debited', inputs:[
  { name:'keyId', type:'bytes32', indexed:true },
  { name:'operator', type:'address', indexed:true },
  { name:'amount', type:'uint256', indexed:false },
  { name:'nonce', type:'uint256', indexed:false } ], anonymous:false }
```

---

## 7. Exactly-once — el modelo completo (AC-5/CD-3)

| Capa | Garantía |
|---|---|
| **Status machine del intent** (`close_payment_intent_for_settle`, `FOR UPDATE`) | Solo UN caller gana `open→closing` → `settleEscrowAware` corre **una vez** por intent. Concurrentes ven `prev_status!=='open'` → rama idempotente, NO entran al two-hop. |
| **Guardia app-side** (§5 paso 3) | `debit_hop1_tx_hash` presente → **skip hop 1**, ir directo a hop 2 (retry-safe; los fondos ya están en el operador). Persistido ANTES de hop 2 (BLQ-DR). |
| **Nonce on-chain** (`_usedNonces[keyId][nonce]`, contrato `:139`) | Backstop final: un 2º `escrow.debit()` con la misma firma revierte `NonceAlreadyUsed`. |

`settleEscrowAware` es el **primitivo reusable que 191c invocará** para el retry hop-2-only
(guardia dispara → skip hop 1 → hop 2). Por eso la guardia es obligatoria aunque en el flujo
propio de 191b (single-winner) rara vez se re-entre.

---

## 8. Waves de implementación

### W0 (serial — migración + tipos + ABI; base de todo)
- **W0.1** Migración `supabase/migrations/<ts>_wkh191b_debit_hop1.sql` (§4.1 columnas + §4.2/§4.3
  RPCs) + `…_down.sql`.
- **W0.2** `src/adapters/escrow/abi.ts`: agregar evento `Debited` (§6, aditivo).
- **W0.3** `src/types/database.types.ts`: 3 columnas nullable + 2 RPC (`p_nonce:string`). `biome
  check --write`.

### W1 (reader de la firma `valid` — depende de W0)
- **W1.1** `src/adapters/escrow/debit-capture.ts`: `isEscrowSettleEnabled()` +
  `readValidDebitSignature({intentId, ownerRef, chainKey, finalAmountUsd})` (§5 paso 2,
  owner-guarded, re-valida amount+deadline). Devuelve la fila o `null` (→ fallback).

### W2 (ejecutor hop 1 — depende de W0.2)
- **W2.1** `src/adapters/escrow/debit-executor.ts`: `executeDebitHop1` (§6) +
  `getEscrowWalletClient`/`getEscrowPublicClient` (cache per-ChainKey) + `getEscrowReceiptTimeoutMs()`
  + `_resetDebitExecutor()` (TEST-ONLY, patrón `_resetVerifier`) + `recordDebitHop1` /
  `recordDebitSettleStatus` (wrappers RPC).

### W3 (wiring flag + two-hop en el service — depende de W1, W2)
- **W3.1** `src/services/payment-intent.ts`: `settleEscrowAware(...)` (§5); reemplazar el
  call-site en `closeSession` (`:727`) y `settleUpto` (`:1063`) — pasar `keyId: row.key_id`.
  `settlePaymentIntentOnChain` **sin cambios**.

Paralelizable: W0.2/W0.3 con W0.1; W1 y W2 en paralelo tras W0. W3 serial al final.
**Rutas (`payments.ts`) NO se tocan:** el reader lee de DB, no del body; el body `debit*` ya lo
persiste 191a.

---

## 9. Constraint Directives (CD-N)

Heredados del work-item: **CD-1** (flag AND default-OFF), **CD-2** (byte-idéntico flag-OFF /
sin firma / sin escrow / hop-1 fail), **CD-3** (exactly-once hop 1, persistir antes de hop 2),
**CD-4** (nunca asumir pago ni refund con hop1-ok/hop2-fail → reconciliation-pending), **CD-5**
(no tocar `contracts/`), **CD-6** (no tocar `arbiter.ts`/disputa), **CD-7** (reuso EXACTO de
`DEBIT_AUTHORIZATION_TYPES`/`ESCROW_ABI.debit`), **CD-8** (esperar min confirmaciones de hop 1
antes de hop 2).

Específicos del SDD:
- **CD-S1 (auto-blindaje 191a/189):** correr `biome check --write` sobre CADA archivo tocado
  (código + test + `database.types.ts`) antes del gate de wave. NUMERIC uint256 (`p_nonce`,
  `debit_amount_atomic`) → tipar **`string`** en `database.types.ts`; leer con `BigInt(...)`,
  nunca `Number()`.
- **CD-S2 (auto-blindaje 189):** el `select` tipado a mano de `readValidDebitSignature` → cast
  `data as unknown as Row | null`.
- **CD-S3 (money-path):** re-validar `amount` firmado == monto a settlear y la ventana de
  `deadline` **ANTES** de cualquier writeContract (validación primaria, no confiar en el revert
  del contrato como 1ª baranda). Mismatch → fallback, jamás debitar.
- **CD-S4:** el remapeo hop2-`unequivocal`→`ambiguous` tras hop1-confirmado es **obligatorio**
  (§5 paso 5): con fondos del buyer ya movidos on-chain, PROHIBIDO reembolsar off-chain
  (doble-crédito contra el libro autoritativo).
- **CD-S5:** `settleEscrowAware` **NUNCA** rechaza la promise (envuelto en `try/catch` → fallback
  al seam). Un throw inesperado NO debe romper `closeSession`/`settleUpto` (espejo CD-7 del seam).

---

## 10. Plan de tests (≥1 por AC)

Archivos: `debit-executor.test.ts` (nuevo, mock viem wallet/public client), `debit-capture.test.ts`
(reader), `payment-intent.test.ts` (`settleEscrowAware` con executor+seam mockeados),
`payments.test.ts` (flag OFF byte-idéntico). Firmante = firma cruda persistida (fixture 191a).

| Test | Cubre | Asserción |
|---|---|---|
| T-1 | AC-1 / happy path | flag ON + firma `valid` + escrow OK + `executeDebitHop1→confirmed` + seam→`settled`: `record_debit_hop1` llamado ANTES del seam; `debit_settle_status='settled'`; `SettleOutcome.txHash == hop2Tx`. El seller cobró. |
| T-2 | AC-2 (flag OFF) | `ESCROW_SETTLE_ENABLED` unset → `settleEscrowAware` delega en `settlePaymentIntentOnChain` en la 1ª línea; **cero** lecturas DB, cero `executeDebitHop1`, outcome byte-idéntico al baseline. |
| T-2b | AC-2 (sin firma) | flag ON pero no hay fila `valid` → fallback al seam; `executeDebitHop1` nunca llamado. |
| T-2c | AC-2 (amount mismatch) | fila `valid` con `debit_amount_atomic != parseUnits(finalUsd,6)` → fallback, sin hop 1. |
| T-3 | AC-3 (hop 1 not_moved) | `executeDebitHop1→{not_moved}` (writeContract lanza / receipt reverted) → fallback al seam; **cero** escritura de `debit_settle_status`; settle completa como HOY. |
| T-4 | AC-4 (hop2 fail) | `hop1→confirmed` (tx hash persistido) + seam→`failed(unequivocal)` → outcome remapeado a `failureKind:'ambiguous'`, `error` prefijo `RECONCILE-ESCROW:`, `debit_settle_status='reconciliation_pending'`; el caller **NO** reembolsa (spy sobre `finalize` con `failed_ambiguous`, no `failed_unequivocal`). |
| T-4b | AC-4 (hop1 ambiguous) | `executeDebitHop1→{ambiguous,RECEIPT_TIMEOUT}` → NO hop 2, reconciliation-pending, sin refund. |
| T-5 | AC-5 (exactly-once) | fila `valid` con `debit_hop1_tx_hash` YA seteado → `executeDebitHop1` **NUNCA** llamado; va directo al seam (hop 2); en éxito `debit_settle_status='settled'`. |
| T-6 | AC-6 (chain sin escrow) | `resolveEscrowContract=null` (default kite) → fallback al seam sin importar el flag; cero hop 1. |
| T-7 | AC-7 / anti-replay | el reader consulta solo `WHERE debit_validation_status='valid' ORDER BY captured_at DESC LIMIT 1`; `record_debit_hop1` es idempotente (2ª llamada no sobreescribe el hash — COALESCE). |
| T-8 | CD-8 / §6 | `executeDebitHop1` pasa `confirmations: resolveMinConfirmations(chainKey)` a `waitForTransactionReceipt`; receipt success sin evento `Debited` → `{ambiguous, DEBITED_EVENT_NOT_FOUND}`. |
| T-9 | CD-S5 | `readValidDebitSignature`/`executeDebitHop1` mock que lanza → `settleEscrowAware` cae al seam (fallback), NUNCA rechaza; `closeSession` retorna `SettleOutcome` normal. |
| T-10 | Ownership (CD-6) | `record_debit_hop1`/`record_debit_settle_status` con `owner_ref` ajeno → RAISE `OWNERSHIP_MISMATCH`. |
| T-11 | R-2 (narrow window) | receipt `reverted` (simula `NonceAlreadyUsed`) → `{not_moved}` → fallback; documentar money-safety (operador nets zero). |

---

## 11. Riesgos / notas

- **R-1 (BLOQUEANTE de activación end-to-end, NO de código — §3):** el seam WKH-136 usa
  `usdToWei` (18d hardcodeado); el escrow vive en Base Sepolia (USDC 6d). En un default-chain
  Base, el hop 2 no converge → `settle.success===false` → reconciliation-pending. 191b es
  money-safe igual (nunca paga mal ni reembolsa indebido), pero el happy-path two-hop no
  completará hasta que el seam sea decimals-aware. **Escalado como MI-1 → 191d/191e o HU de
  seam. Fuera de 191b (DT-5/CD-2).**
- **R-2 (narrow window, money-safe, 191c-detectado):** hop 1 confirmado on-chain pero crash
  ANTES de `record_debit_hop1` → un retry re-intenta hop 1 → revert `NonceAlreadyUsed` →
  `{not_moved}` → fallback al seam (operador paga al seller de fondos propios). El operador YA
  recibió los fondos del escrow en el hop 1 confirmado ⇒ **nets zero**: seller pagado una vez,
  buyer debitado una vez, sin pérdida. Drift on-chain (escrow debitado, tx de settle = fallback)
  que 191c reconcilia. No-destructivo.
- **R-3 (coexistencia budget↔escrow, DT-4):** 191b NO cambia el accounting off-chain
  (`increment/refund_a2a_key_spend`). En el happy path escrow los netos coinciden (escrow
  debita `finalUsd`; off-chain neto = `finalUsd`; residual queda en `escrowBalance` para
  `withdraw()` de 191c y el residual off-chain se refunda como HOY). La reconciliación FORMAL
  budget-vs-`escrowBalance` es 191c. Documentar en Story File.
- **R-4 (inerte hasta 191d):** con `OPERATOR_PRIVATE_KEY ≠ _operator` on-chain, TODO `debit()`
  revierte `NotOperator` → `{not_moved}` → fallback siempre (AC-3). 191b queda correcto e inerte;
  la activación real la confirma 191d.

---

## 12. Readiness Check

- [x] Two-hop secuencial con confirmación intermedia + timeout explícito (DT-1/DT-11) — §5/§6.
- [x] Las 3 ramas del two-hop resueltas money-safe: hop1-not_moved→fallback (AC-3);
  hop1-ambiguous→reconciliation-pending sin refund (AC-4); hop1-ok+hop2-fail→reconciliation-pending
  con remapeo `unequivocal→ambiguous` (CD-4/CD-S4) — §5.
- [x] Exactly-once en 3 capas (status machine + guardia app-side + nonce on-chain), guardia
  persistida ANTES de hop 2 (DT-2/CD-3/AC-5) — §7.
- [x] reconciliation-pending expresado con `failed_ambiguous` existente + evidencia en la fila
  de la firma (DT-8): **cero cambios** a `finalize_payment_intent`/`record_settle_outcome`
  auditados — §2/§4.
- [x] Reader `valid` owner-guarded + re-validación amount/deadline antes de on-chain (AC-7/CD-S3) — §5.
- [x] Migración additive (columnas nullable + 2 RPC owner-guarded + índice de 191c) reversible — §4.
- [x] Flag AND default-OFF con fast-path byte-idéntico (CD-1/CD-2) — §5 paso 0.
- [x] Reuso EXACTO `ESCROW_ABI.debit`/`DEBIT_AUTHORIZATION_TYPES`; `Debited` aditivo converge con
  el contrato (CD-7) — §6.
- [x] Seam WKH-136 byte-idéntico (wrapper DT-7); hop 2 sin cambios (DT-5) — §2/§8.
- [x] Cero `contracts/`, cero `arbiter.ts` (CD-5/CD-6) — el SDD solo lee Solidity.
- [x] Auto-blindaje histórico incorporado (biome-write, NUMERIC→string, cast supabase,
  validar-antes-del-clamp) — CD-S1..S3.
- [x] Test plan ≥1 por AC (AC-1..AC-7) + exactly-once + ownership + narrow-window — §10.
- **`[NEEDS CLARIFICATION]` / MI-1 (NO bloquea el código de 191b, SÍ la activación end-to-end):**
  el seam WKH-136 (`usdToWei` 18d) no converge con USDC 6d de Base — R-1/§3. Reportado al
  orquestador; recomendación: HU de seam decimals-aware o fold en 191d/191e antes de activar el
  flag en Base Sepolia. 191b es code-complete y money-safe sin esto.
```
