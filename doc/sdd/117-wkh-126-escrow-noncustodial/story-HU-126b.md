# Story File — WKH-126b · Integración TS del Escrow No-Custodial

> **Contrato ejecutable del Dev (F3).** Este es el ÚNICO input del Dev. Si algo no está
> aquí, no se implementa. Derivado de `sdd.md` (SPEC_APPROVED). No releer el SDD para codear.
>
> - HU: **WKH-126b** (sub-HU TS de E17; WKH-126a = contrato Solidity, fuera de scope)
> - Branch: `feat/117-wkh-126b-escrow-ts-integration` (ya estás en `fix/117-session-dest-cap`; el Dev crea/cambia branch)
> - Artefactos: `doc/sdd/117-wkh-126-escrow-noncustodial/`
> - Stack (no negociable): TypeScript strict, **viem v2** (CD-5, prohibido ethers.js), Fastify, Supabase, vitest.

---

## 0. Qué se construye y por qué (contexto compacto)

Hoy el fondeo de Agent Key es **custodial**: el agente hace `Transfer` ERC-20 a una EOA del
operador (`resolveTreasury`), `deposit-verifier.ts` valida el evento `Transfer` on-chain y
`budgetService.registerDeposit` acredita budget en DB.

Esta HU agrega el camino **no-custodial coexistente**: con `ESCROW_MODE_ENABLED === 'true'`
el agente deposita en un **contrato escrow** (WKH-126a) que emite
`Deposited(depositor, keyId, amount)`. Un nuevo adapter `escrow-verifier.ts` (espejo de
`deposit-verifier.ts`) verifica ese evento on-chain **antes** de acreditar (CD-1). El débito
por uso se autoriza con una firma **EIP-712 `DebitAuthorization`** construida server-side
(helper PURO; la presentación on-chain real `writeContract debit(...)` queda detrás del flag
y fuera de CI — CD-7).

**Aditivo y sin regresión (DT-4):** con el flag off (default) corre el flujo treasury actual
intacto (AC-8). El contrato Solidity está OUT; consumimos su ABI/interfaz como constante TS
**provisional** marcada `VERIFY-AT-IMPL` (converge byte-a-byte con 126a).

---

## 1. Scope IN — archivos a tocar (lista exhaustiva)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/adapters/escrow/abi.ts` | **crear** | W0 |
| 2 | `src/adapters/escrow/eip712.ts` | **crear** (tipos+domain en W0; `buildDebitAuthorization` en W3) | W0 + W3 |
| 3 | `src/adapters/escrow-verifier.ts` | **crear** | W0 (tipos) + W1 (cuerpo) |
| 4 | `src/routes/auth.ts` | **modificar** (handler `/deposit` paso 5 + paso 6b) | W2 |
| 5 | `.env.example` | **modificar** (ya existe) | W2 |
| 6 | `src/adapters/escrow-verifier.test.ts` | **crear** | W4 |
| 7 | `src/adapters/escrow/eip712.test.ts` | **crear** | W4 |
| 8 | `src/routes/auth.escrow.test.ts` | **crear** | W4 |

> **NO TOCAR** (verificado, prohibido por CD/scope OUT):
> - `src/services/budget.ts` — `registerDeposit` se llama sin cambios (DT-6, CD-2).
> - `src/services/receipt.ts` — solo se llama `receiptService.emit(...)` (CD-6). Cero cambios.
> - `src/adapters/deposit-verifier.ts` — se **importa** sus helpers chain-genéricos (DT-6); cero cambios al archivo.
> - `src/adapters/chain-resolver.ts`, `src/adapters/registry.ts`, `src/adapters/types.ts`, `src/services/security/errors.ts` — solo lectura/reuso.
> - Handler `GET /deposit-info` (`auth.ts:753-779`) — fuera de scope.
> - `register_a2a_key_deposit` RPC / schema DB — sin migración (DT-9: NO se agrega `escrow_balance`).

> **La carpeta `src/adapters/escrow/` NO existe** (verificado: `src/adapters/` tiene
> `avalanche/ base/ kite-ozone/ __tests__/` + archivos sueltos). El Dev la crea.

---

## 2. Anti-Hallucination Checklist (específico de esta HU)

Antes de escribir cada archivo, confirmá:

- [ ] **viem-only (CD-5)**: imports SOLO desde `'viem'` y `'viem/accounts'`. APIs usadas: `createPublicClient`, `decodeEventLog`, `parseAbiItem`, `formatUnits`, `parseUnits`, `http`, `hashTypedData`, `recoverTypedDataAddress`, `keccak256`, `toHex`/`stringToBytes`, `privateKeyToAccount`. **NINGÚN** import de `ethers`.
- [ ] **No hardcodes (CD-3)**: ninguna dirección de contrato, chainId ni topic0 literal. Direcciones desde `process.env.A2A_ESCROW_CONTRACT_<FAMILY>`; topic0 derivado por viem vía `parseAbiItem`; typehash derivado por viem (NUNCA `keccak256("DebitAuthorization(...)")` a mano).
- [ ] **Flag estricto (CD-11)**: `process.env.ESCROW_MODE_ENABLED === 'true'` (comparación de string exacta). PROHIBIDO `Boolean(process.env.ESCROW_MODE_ENABLED)`.
- [ ] **Match desde el evento on-chain (CD-8)**: `amountUsd`, `from` (depositor) y `keyId` SIEMPRE del evento `Deposited` decodificado, NUNCA de `body.amount`/`body.from`. `body.amount` solo para el chequeo opcional `AMOUNT_MISMATCH` reparseando con `parseUnits`.
- [ ] **Ownership Guard (CD-4)**: `registerDeposit(callerKey.id, chainId, amountUsd, callerKey.owner_ref, txHash, token)` con `owner_ref` no-undefined. NO introducir ninguna query `.from('a2a_agent_keys')` nueva.
- [ ] **callerKey como única fuente de linaje (CD-9)**: usar `callerKey.owner_ref`/`callerKey.id`/`callerKey.funding_wallet` (de `resolveCallerKey`). NO inventar `request.a2aKeyRow`/`scopingKeyRow`.
- [ ] **receiptService intacto (CD-6)**: solo `receiptService.emit(...)`, fire-and-forget, sin await bloqueante que propague error. `emit` ya es NUNCA-throw.
- [ ] **Tests contra mock (CD-7)**: cero dependencia del deploy 126a; `writeContract debit(...)` NO se ejecuta en CI.
- [ ] **`verifyingContract` en el domain escrow (CD-12)**: el domain incluye `verifyingContract`; rechazar firmar si no está configurado. PROHIBIDO firmar con `chainId`/`verifyingContract` cero/placeholder.
- [ ] Lo provisional (forma del ABI / `keyId` / `nonce`) va marcado en JSDoc `PROVISIONAL — VERIFY-AT-IMPL con WKH-126a`. No presentar como canónico.

---

## 3. Interfaz EIP-712 `DebitAuthorization` — LITERAL (implementar tal cual)

> Contrato de interfaz 126a↔126b. **PROVISIONAL — VERIFY-AT-IMPL con WKH-126a**: la forma
> canónica converge byte-a-byte con el contrato. Los tests corren contra esta forma (CD-7).

### Dominio (incluye `verifyingContract` — DT-8/CD-12)

```ts
domain = {
  name:              process.env.ESCROW_EIP712_NAME ?? 'WasiAIEscrow',
  version:           process.env.ESCROW_EIP712_VERSION ?? '1',
  chainId:           <chainId del bundle: bundle.chainConfig.chainId>, // ej. 2368 kite, 43113 fuji, 84532 base-sepolia
  verifyingContract: <A2A_ESCROW_CONTRACT_<FAMILY>>,                   // dirección escrow en esa chain
}
```

> Diferencia con `signed-auth.ts`/`delegation.ts` (que **omiten** `verifyingContract`): el escrow
> **SÍ** lo incluye porque el verificador es el contrato on-chain (`ECDSA.recover`), no el server.

### Struct (primaryType `DebitAuthorization`)

```
DebitAuthorization {
  bytes32 keyId;     // identificador on-chain de la Agent Key (ver "Derivación de keyId")
  uint256 amount;    // monto a debitar en unidades ATÓMICAS del token (NO USD humano)
  uint256 deadline;  // epoch seconds; contrato revierte si block.timestamp > deadline
  uint256 nonce;     // anti-replay del débito (126a define política monotónica/aleatoria)
}
```

> **`nonce` agregado** respecto al work-item (que listaba `{keyId, amount, deadline}`): defensa
> anti-replay del débito. **VERIFY-AT-IMPL**: si 126a no implementa `nonce`, degradar a 3 campos
> y documentar como TD (no marcar la HU done sin el gate — ver §9 R-2).

### Tipos viem (`as const`, typehash derivado por viem — CD-3)

```ts
export const DEBIT_AUTHORIZATION_TYPES = {
  DebitAuthorization: [
    { name: 'keyId',    type: 'bytes32' },
    { name: 'amount',   type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
  ],
} as const;
```

El typehash canónico (`keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")`)
lo deriva viem (`hashTypedData`/`recoverTypedDataAddress`). **NO hardcodear** (CD-3). 126a debe
usar EXACTAMENTE el mismo string de tipo (mismo orden de campos).

### Derivación de `keyId` (bytes32) — **VERIFY-AT-IMPL con 126a**

`a2a_agent_keys.id` es UUID texto; `keyId` on-chain es `bytes32`. **Provisional elegido:**
`keyId = keccak256(stringToBytes(callerKey.id))` (determinista, robusto frente a formatos de
UUID). El verifier compara el `keyId` decodificado del evento `Deposited` contra
`keccak256(stringToBytes(callerKey.id))`. **DEBE coincidir byte-a-byte con 126a** (lección
WKH-125: un solo origen canónico para la clave).

### Firmante

El agente (o el gateway en su nombre) firma. El helper de 126b firma con la cuenta viem
derivada del secret (`OPERATOR_PRIVATE_KEY` o session key) y hace **recover de sanity**
off-chain (`recoverTypedDataAddress` debe devolver la cuenta esperada) antes de considerar la
autorización presentable. El helper es **PURO** sobre la construcción: no toca DB ni red.

---

## 4. Waves — orden serial y dependencias

```
W0 (SERIAL: contratos/tipos/ABI/domain) ──► W1 (escrow-verifier cuerpo)
                                        └──► W2 (routing auth.ts + recibo + .env.example)
                                        └──► W3 (helper buildDebitAuthorization)
W1 + W2 + W3 ──► W4 (tests, ≥1 por AC)
```

- **W0 es bloqueante** de todo lo demás (define tipos/ABI/domain compartidos). Hacerlo primero, completo.
- **W1, W2, W3** dependen de W0 pero son independientes entre sí.
- **W4** depende de W1+W2+W3 (testea cada uno).
- **No hay gates humanos entre waves.** Corré W0→W1→W2→W3→W4 secuencial.

---

### W0 — Contratos de interfaz (tipos, ABI, domain) [SERIAL]

#### 4.0.1 · `src/adapters/escrow/abi.ts` (crear)

ABI escrow tipado viem `as const`. JSDoc: `PROVISIONAL — coordinar forma canónica con WKH-126a (VERIFY-AT-IMPL)`.

Debe exportar `ESCROW_ABI` con al menos:
- `event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)`
- `function deposit(bytes32 keyId, uint256 amount)` (emite `Deposited`)
- `function debit(bytes32 keyId, uint256 amount, uint256 deadline, bytes signature)`
- `function escrowBalance(bytes32 keyId) view returns (uint256)` (read opcional, DT-9)

Forma viem `as const` (cada item objeto `{ type, name, inputs, ... }`). Para el decode del evento
en W1 derivar el item con `parseAbiItem('event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)')`
(patrón `deposit-verifier.ts:60-63` — topic0 derivado por viem, NUNCA literal).

#### 4.0.2 · `src/adapters/escrow/eip712.ts` (crear — solo tipos+domain en W0)

En W0 declarar:
- `DEBIT_AUTHORIZATION_TYPES` (`as const`, §3).
- `export type DebitAuthorizationMessage = { keyId: \`0x${string}\`; amount: bigint; deadline: bigint; nonce: bigint; }`.
- `export function buildDebitDomain(chainId: number, verifyingContract: \`0x${string}\`)` → objeto domain (§3), leyendo `ESCROW_EIP712_NAME`/`ESCROW_EIP712_VERSION` con defaults `'WasiAIEscrow'`/`'1'`.
- JSDoc `PROVISIONAL — VERIFY-AT-IMPL con WKH-126a`.

> El cuerpo de `buildDebitAuthorization`/`hashDebitAuthorization` se completa en **W3**.

**Patrón a seguir** (env-driven domain + `as const`): `signed-auth.ts:47-64` (`REQUEST_TYPES` +
`buildRequestDomain`). **Diferencia clave**: acá el domain SÍ lleva `verifyingContract` (CD-12),
contraste con `delegation.ts:49-56` (lo omite).

#### 4.0.3 · `src/adapters/escrow-verifier.ts` (crear — solo tipos en W0)

Declarar (cuerpo en W1):

```ts
export type EscrowVerificationReason =
  | 'TX_NOT_FOUND'
  | 'TX_REVERTED'
  | 'INSUFFICIENT_CONFIRMATIONS'
  | 'CHAIN_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'RPC_UNAVAILABLE'
  | 'ESCROW_CONTRACT_NOT_CONFIGURED'  // DT-7: env A2A_ESCROW_CONTRACT_<FAMILY> ausente/inválida
  | 'DEPOSIT_EVENT_NOT_FOUND'         // ningún Deposited del escrow con keyId del caller
  | 'KEY_ID_MISMATCH';                // Deposited.keyId != keccak256(callerKey.id)

export interface EscrowDepositVerification {
  ok: boolean;
  reason?: EscrowVerificationReason; // solo si ok=false
  amountAtomic?: bigint;
  amountUsd?: string;     // formatUnits(amount, token.decimals)
  tokenSymbol?: string;   // bundle.payment.supportedTokens[0].symbol
  from?: `0x${string}`;   // == Deposited.depositor (reusa gate funding-wallet del handler)
  confirmations?: number;
}
```

> **Compatibilidad estructural (DT-5/DT-10, VERIFY-AT-IMPL)**: `auth.ts` consume `ok`, `reason`,
> `amountUsd`, `from`, `tokenSymbol`. Estos campos deben tener los MISMOS nombres que
> `DepositVerification` (`deposit-verifier.ts:37-47`). NO reescribir `DepositVerification`; el
> escrow define su propio tipo con campos compatibles.

---

### W1 — `escrow-verifier.ts` (lectura on-chain del evento `Deposited`)

**Exemplar espejo**: `src/adapters/deposit-verifier.ts:185-310` (`verifyDeposit`). Replicá la
mecánica completa con estas diferencias.

#### 4.1.1 · Reuso de helpers chain-genéricos (DT-6 — single source of truth)

**Importá** de `'./deposit-verifier.js'` (NO duplicar): `resolveChainFamilyEnvSuffix`,
`resolveMinConfirmations`. Para `resolveRpcUrl`/`resolveChainObject` están **privados** en
`deposit-verifier.ts` (no exportados) — el Dev tiene dos opciones, elegí la mínima:
- **(a)** exportarlos desde `deposit-verifier.ts` (cambio aditivo, agrega `export`) y reusarlos, **o**
- **(b)** replicar los dos `switch` en `escrow-verifier.ts` con JSDoc apuntando al original.

> **VERIFY-AT-IMPL**: preferí (a) si el `export` no rompe nada (es aditivo); si tocar
> `deposit-verifier.ts` te incomoda por el "NO TOCAR" del §1, esa nota aplica a la **lógica**;
> agregar `export` a dos helpers ya existentes es aceptable y preferible a duplicar. Documentá la
> decisión en el JSDoc.

#### 4.1.2 · `resolveEscrowContract(chainKey): \`0x${string}\` | null` (DT-7/CD-3)

```ts
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export function resolveEscrowContract(chainKey: ChainKey): `0x${string}` | null {
  const family = resolveChainFamilyEnvSuffix(chainKey);
  const addr = process.env[`A2A_ESCROW_CONTRACT_${family}`];
  if (addr && ADDRESS_RE.test(addr)) return addr as `0x${string}`;
  return null; // fail-loud → ESCROW_CONTRACT_NOT_CONFIGURED, cero crédito
}
```

> **A DIFERENCIA de `resolveTreasury` (`deposit-verifier.ts:103-118`): NO hay fallback a
> `OPERATOR_PRIVATE_KEY`** — el escrow es un contrato deployado, no una EOA derivable.

#### 4.1.3 · Cache propio + reset test-only (DT-6)

NO compartir el `Map` privado de `deposit-verifier.ts`. Declarar uno propio:

```ts
const _clients = new Map<ChainKey, PublicClient>();
export function _resetEscrowVerifier(): void { _clients.clear(); }
```

(Patrón `deposit-verifier.ts:163-181`.)

#### 4.1.4 · `verifyEscrowDeposit(args): Promise<EscrowDepositVerification>`

Args: `{ chainKey: ChainKey; bundle: AdaptersBundle; txHash: \`0x${string}\`; keyIdHash: \`0x${string}\`; expectedAmountUsd?: string }`
donde `keyIdHash = keccak256(stringToBytes(callerKey.id))` (lo pasa el handler — §3).

Orden de verificación (espejo `deposit-verifier.ts:190-309`):
1. `resolveEscrowContract(chainKey)` → si `null` → `{ ok:false, reason:'ESCROW_CONTRACT_NOT_CONFIGURED' }` (antes del client, fail-loud).
2. `getEscrowClient(chainKey)` (lazy) → null → `RPC_UNAVAILABLE`.
3. `getTransactionReceipt({ hash: txHash })` → throw → `TX_NOT_FOUND`.
4. `receipt.status !== 'success'` → `TX_REVERTED`.
5. `getChainId()` != `bundle.chainConfig.chainId` → `CHAIN_MISMATCH` (throw → `RPC_UNAVAILABLE`).
6. `getBlockNumber()`; `confirmations = Number(latest - receipt.blockNumber) + 1`; `< resolveMinConfirmations(chainKey)` → `INSUFFICIENT_CONFIRMATIONS`.
7. Recorrer `receipt.logs` filtrando `log.address.toLowerCase() === escrowContract.toLowerCase()` (filtro por contrato escrow, NO por token — diferencia con `deposit-verifier.ts:246`). Decodificar `Deposited` con `decodeEventLog({ abi:[DEPOSITED_EVENT], eventName:'Deposited', data, topics })` en try/catch (ignorar logs no decodificables).
8. Del evento extraer `{ depositor, keyId, amount }`. **CD-8**: `keyId !== keyIdHash` → continuar buscando; si ningún log matchea el `keyIdHash` → `KEY_ID_MISMATCH` (o `DEPOSIT_EVENT_NOT_FOUND` si no hubo ningún `Deposited` del escrow).
9. `from = depositor`, `amountAtomic = amount`, `amountUsd = formatUnits(amount, token.decimals)` con `token = bundle.payment.supportedTokens[0]`.
10. Si `expectedAmountUsd !== undefined`: reparsear con `parseUnits(expectedAmountUsd, token.decimals)` en try/catch; `!= amountAtomic` → `AMOUNT_MISMATCH` (patrón `deposit-verifier.ts:282-296`, CD-8). NUNCA acreditar `body.amount`.
11. Éxito: `{ ok:true, amountAtomic, amountUsd, tokenSymbol: token.symbol, from: depositor, confirmations }`.

> NO se devuelve `recipient` (no hay treasury en escrow). El gate funding-wallet del handler usa `from`.

---

### W2 — Routing condicional en `POST /deposit` + recibo

**Exemplar**: `src/routes/auth.ts:602-707` (handler completo). Puntos de inserción exactos.

#### 4.2.1 · Imports (extender bloque `auth.ts:11-45`)

Agregar:
```ts
import { verifyEscrowDeposit } from '../adapters/escrow-verifier.js';
import { keccak256, stringToBytes } from 'viem';
import { receiptService } from '../services/receipt.js';
```
(El import de `viem` ya existe en `auth.ts:13` — agregá `keccak256, stringToBytes` ahí. Verificá si `receiptService` ya está importado antes de duplicar.)

#### 4.2.2 · Helper `escrowModeEnabled()` (CD-11)

A nivel módulo o local al plugin:
```ts
function escrowModeEnabled(): boolean {
  return process.env.ESCROW_MODE_ENABLED === 'true';
}
```
**CD-11**: comparación estricta. PROHIBIDO `Boolean(...)`. Cualquier otro valor → flag OFF (fail-safe a treasury, AC-8).

#### 4.2.3 · Paso 5 — selector (DT-10)

Reemplazar el bloque `auth.ts:651-657` (`const result = await verifyDeposit({...})`) por el selector:

```ts
// 5. Verificar on-chain ANTES de acreditar (AC-1 / CD-4).
const result = escrowModeEnabled()
  ? await verifyEscrowDeposit({
      chainKey,
      bundle,
      txHash: txHash as `0x${string}`,
      keyIdHash: keccak256(stringToBytes(callerKey.id)), // §3, VERIFY-AT-IMPL con 126a
      expectedAmountUsd: body.amount,
    })
  : await verifyDeposit({
      chainKey,
      bundle,
      txHash: txHash as `0x${string}`,
      expectedAmountUsd: body.amount,
    });
```

El bloque de manejo de error (`auth.ts:658-667`) se mantiene, **ampliando el mapeo de status (CD-10)**:
`RPC_UNAVAILABLE` **o** `ESCROW_CONTRACT_NOT_CONFIGURED` → 503; el resto → 400. (`FUNDING_WALLET_MISMATCH`
ya está en 5b → 403.) Ejemplo:
```ts
const reason = result.reason;
const status = reason === 'RPC_UNAVAILABLE' || reason === 'ESCROW_CONTRACT_NOT_CONFIGURED' ? 503 : 400;
```

> **Pasos 5b (funding-wallet gate, `auth.ts:669-678`), 6 (registerDeposit, `auth.ts:680-689`) y 7
> (respuesta) NO se bifurcan (DT-5).** El `result.from` del escrow == `Deposited.depositor`, reusa el
> gate `result.from.toLowerCase() !== callerKey.funding_wallet.toLowerCase()` sin cambios.

#### 4.2.4 · Paso 6b — recibo `deposit_verified` (DT-11/AC-11)

Tras el `registerDeposit` exitoso (justo antes del `return reply.status(200)` en `auth.ts:691`),
agregar emisión fire-and-forget (aplica a AMBOS caminos para consistencia; no rompe AC-8 — no cambia shape ni status):

```ts
// 6b. Recibo deposit_verified (AC-11) — best-effort, NUNCA bloquea ni propaga (DT-11).
void receiptService.emit({
  ownerRef: ownerRef,
  agentKeyId: callerKey.id,
  sessionId: null,
  delegationId: null,
  receiptType: 'deposit_verified',
  amountUsd: result.amountUsd,
  chainId,
  txHash,
  counterparty: null,
  orchestrationId: null,
});
```

> Campos exactos de `EmitReceiptInput` (verificado en `receipt.ts:96-188` y su uso del RPC
> `insert_receipt`): `ownerRef, agentKeyId, sessionId, delegationId, receiptType, amountUsd,
> chainId, txHash, counterparty, orchestrationId`. `emit` es **NUNCA-throw** (best-effort), por eso
> `void` sin `await` que propague. NO modificar `receipt.ts` (CD-6).
>
> **VERIFY-AT-IMPL (R-3)**: confirmar que `receiptType: 'deposit_verified'` es aceptado por la
> columna `receipt_type` / RPC `insert_receipt` (hoy se usan `protocol_fee`/`budget_debit`). Si hay
> un CHECK constraint, documentarlo — NO es bloqueante porque `emit` degrada a WARN sin romper el flujo.

#### 4.2.5 · `.env.example` (modificar — ya existe)

Documentar (con comentario, sin valores reales):
```
# ── Escrow no-custodial (WKH-126b, opt-in) ──
ESCROW_MODE_ENABLED=false                 # 'true' exacto activa el flujo escrow; cualquier otro valor = treasury (default)
A2A_ESCROW_CONTRACT_KITE=0x...            # dirección del contrato escrow en Kite
A2A_ESCROW_CONTRACT_AVALANCHE=0x...       # dirección del contrato escrow en Avalanche
A2A_ESCROW_CONTRACT_BASE=0x...            # dirección del contrato escrow en Base
ESCROW_EIP712_NAME=WasiAIEscrow           # domain EIP-712 (debe coincidir con WKH-126a)
ESCROW_EIP712_VERSION=1
```

---

### W3 — Helper de construcción/validación EIP-712 de débito (server-side)

Completar `src/adapters/escrow/eip712.ts`. **Exemplar**: `signed-auth.ts:114-153`
(`recoverTypedDataAddress({ domain, types, primaryType, message, signature })`).

#### 4.3.1 · `buildDebitAuthorization(...)`

```ts
buildDebitAuthorization(params: {
  keyId: `0x${string}`;          // bytes32 (keccak256(stringToBytes(uuid)))
  amount: bigint;                // unidades ATÓMICAS
  deadline: bigint;              // epoch seconds
  nonce: bigint;
  chainId: number;
  verifyingContract: `0x${string}`;
  signer: PrivateKeyAccount;     // de privateKeyToAccount(OPERATOR_PRIVATE_KEY) o session key
}): Promise<{ signature: `0x${string}`; recovered: `0x${string}`; presentable: boolean }>
```

- **CD-12**: si `verifyingContract` no es una dirección válida (cero/placeholder/no configurada) → **lanzar** o retornar `{ presentable: false }` SIN firmar. PROHIBIDO firmar con `verifyingContract`/`chainId` cero.
- Construir typed-data: `domain = buildDebitDomain(chainId, verifyingContract)`, `types = DEBIT_AUTHORIZATION_TYPES`, `primaryType = 'DebitAuthorization'`, `message = { keyId, amount, deadline, nonce }`.
- Firmar con `signer.signTypedData({ domain, types, primaryType, message })`.
- **Recover de sanity**: `recoverTypedDataAddress({ domain, types, primaryType, message, signature })` debe `=== signer.address` (case-insensitive); si no → `presentable: false`.
- Helper **PURO**: no toca DB ni red, NO ejecuta `writeContract` (CD-7). La presentación on-chain es 126a.

#### 4.3.2 · `hashDebitAuthorization(...)`

Exportar `hashDebitAuthorization(params): \`0x${string}\`` vía `hashTypedData({ domain, types, primaryType, message })` para tests/auditoría.

---

### W4 — Tests (≥1 por AC, contra mock viem — CD-7)

**Patrón base** (exemplar `deposit-verifier.test.ts:1-120`):
- `vi.mock('viem', importOriginal)` preservando `formatUnits/decodeEventLog/parseAbiItem/parseUnits/hashTypedData/recoverTypedDataAddress/keccak256/stringToBytes/encodeAbiParameters/http` y mockeando `createPublicClient` (`getTransactionReceipt`/`getBlockNumber`/`getChainId`).
- Fixtures: `depositedLog({ depositor, keyId, amount })` (espejo de `transferLog`, `deposit-verifier.test.ts:53-67`) — topics `[topic0(Deposited), topicAddr(depositor), keyId]`, data = `encodeAbiParameters(parseAbiParameters('uint256'),[amount])`.
- `ORIGINAL_ENV = { ...process.env }` snapshot; `beforeEach`: `vi.clearAllMocks()` + `_resetEscrowVerifier()` + restaurar env + setear `A2A_ESCROW_CONTRACT_<FAMILY>` + RPC URLs.
- **Aserciones sobre el objeto de retorno** (`{ ok, reason }`), NO substrings (Auto-Blindaje WKH-SEC-02).

#### Mapeo AC → archivo → caso

| AC | Archivo | Caso de test |
|----|---------|-------------|
| **AC-1** | `escrow-verifier.test.ts` | `Deposited(depositor=funding, keyId, amount)` con confirmaciones → `{ ok:true, from===depositor, amountUsd===formatUnits(amount,decimals) }`. |
| **AC-2** | `escrow-verifier.test.ts` | `getBlockNumber` tal que `confirmations < min` → `{ ok:false, reason:'INSUFFICIENT_CONFIRMATIONS' }`. |
| **AC-3** | `auth.escrow.test.ts` | escrow mode; `budgetService.registerDeposit` mock lanza `DepositAlreadyCreditedError` → `409 DEPOSIT_ALREADY_CREDITED`. |
| **AC-4** | `eip712.test.ts` | `buildDebitAuthorization` produce firma cuya `recovered === signer.address` (`presentable:true`); sin firma válida → no presentable. |
| **AC-5** | `eip712.test.ts` | `verifyingContract` ausente/cero → NO firma (`presentable:false` o throw); CD-12. |
| **AC-6** | `auth.escrow.test.ts` | escrow mode; `verifyEscrowDeposit` (mock) devuelve `from != callerKey.funding_wallet` → `403 FUNDING_WALLET_MISMATCH`. |
| **AC-7** | `auth.escrow.test.ts` | escrow mode; assert `registerDeposit` llamado con 4º arg `=== callerKey.owner_ref`; mock `OwnershipMismatchError` → `403 OWNERSHIP_MISMATCH`. |
| **AC-8** | `auth.escrow.test.ts` | `ESCROW_MODE_ENABLED` unset → usa `verifyDeposit` (treasury); assert `verifyEscrowDeposit` **NO** se llamó. |
| **AC-9** | `auth.escrow.test.ts` | `ESCROW_MODE_ENABLED='true'` → usa `verifyEscrowDeposit`; respuesta `{ balance, chain_id }` (mismo shape, mismo RPC). |
| **AC-10** | `escrow-verifier.test.ts` | `resolveEscrowContract` resuelve por `A2A_ESCROW_CONTRACT_<FAMILY>` para kite/avalanche/base; ausente → `null` → `ESCROW_CONTRACT_NOT_CONFIGURED`. |
| **AC-11** | `auth.escrow.test.ts` | escrow mode exitoso → `receiptService.emit` (mock) llamado con `receiptType:'deposit_verified'` y `txHash`; un throw simulado de `emit` NO rompe la respuesta 200. |

#### Tests adicionales exigidos por CD (no-AC)

| CD | Archivo | Caso |
|----|---------|------|
| **CD-8** | `escrow-verifier.test.ts` | `body.amount` (`expectedAmountUsd`) != on-chain `amount` → `AMOUNT_MISMATCH`; el valor acreditado siempre es el on-chain. |
| **CD-11** | `auth.escrow.test.ts` | `escrowModeEnabled()`/handler: parametrizado `'1'`,`'TRUE'`,`''`,`undefined` → flag OFF (treasury); solo `'true'` exacto → escrow. |
| **CD-10** | `escrow-verifier.test.ts` / `auth.escrow.test.ts` | mapeo de status: `RPC_UNAVAILABLE`/`ESCROW_CONTRACT_NOT_CONFIGURED` → 503; resto → 400. |
| **CD-3** | `escrow-verifier.test.ts` | (implícito) topic0 derivado por `parseAbiItem`, no literal — assert que el decode funciona sin hash hardcodeado. |

> **AC-5** real (revert on-chain) lo enforce 126a; 126b solo garantiza no construir/presentar
> autorizaciones inválidas (CD-7). El test cubre la parte TS.

---

## 5. Patrones a seguir (exemplars verificados — paths reales en disco)

| Para | Exemplar (path:línea verificado) | Qué copiar |
|------|----------------------------------|-----------|
| Estructura del verifier, cache lazy, orden de checks, decode evento | `src/adapters/deposit-verifier.ts:185-310` | Espejo completo para `verifyEscrowDeposit`. |
| Helpers env chain-genéricos | `src/adapters/deposit-verifier.ts:67-95` | `resolveChainFamilyEnvSuffix`, `resolveMinConfirmations` (importar, no duplicar). |
| `resolveTreasury` (contraste — escrow NO usa fallback PK) | `src/adapters/deposit-verifier.ts:103-118` | Patrón `resolveEscrowContract` (sin fallback OPERATOR_PRIVATE_KEY). |
| `_resetVerifier` + `_clients` Map | `src/adapters/deposit-verifier.ts:163-181` | `_resetEscrowVerifier` + cache propio. |
| AMOUNT_MISMATCH sin pérdida de precisión | `src/adapters/deposit-verifier.ts:282-296` | `parseUnits` + comparación BigInt (CD-8). |
| Test verifier: mock viem, fixtures de log, env snapshot | `src/adapters/deposit-verifier.test.ts:1-120` | Espejo para `escrow-verifier.test.ts` (log `Deposited`). |
| Handler `/deposit` (puntos 1-7) | `src/routes/auth.ts:602-707` | Inserción selector (5) + recibo (6b). |
| Import block del handler | `src/routes/auth.ts:11-45` | Dónde agregar imports nuevos. |
| `registerDeposit` firma + error classes | `src/services/budget.ts:314-345` | Reuso sin cambios; `DepositAlreadyCreditedError`/`OwnershipMismatchError`. |
| `receiptService.emit` campos + best-effort | `src/services/receipt.ts:96-188` | Llamada del recibo (campos exactos). |
| EIP-712 viem: `as const` types, recover, domain de env | `src/services/signed-auth.ts:47-64, 114-153` | Patrón del helper `DebitAuthorization`. |
| EIP-712 con `verifyingContract` omitido (CONTRASTE) | `src/services/delegation.ts:49-78` | El escrow SÍ incluye `verifyingContract` (CD-12). |
| Tipos chain | `src/adapters/types.ts:1-60` | `ChainKey`, `AdaptersBundle`, `TokenSpec`. |
| Resolución chain en handler | `src/adapters/chain-resolver.ts:61-85` | `normalizeChainSlug`/`resolveChainKey` (sin cambios). |

---

## 6. Constraint Directives — aplicabilidad por wave

| CD | Regla | Waves donde aplica |
|----|-------|--------------------|
| **CD-1** | Verify-before-credit: cero crédito si `verifyEscrowDeposit` retorna `ok:false`. | W1, W2 |
| **CD-2** | Preservar `UNIQUE(chain_id,tx_hash)` en `register_a2a_key_deposit`; firma RPC sin cambios; sin migración. | W2 |
| **CD-3** | No hardcodes: direcciones desde `A2A_ESCROW_CONTRACT_<FAMILY>`; topic0/typehash derivados por viem. | W0, W1, W3 |
| **CD-4** | Ownership Guard: `registerDeposit(..., callerKey.owner_ref, ...)` no-undefined; cero queries nuevas a `a2a_agent_keys`. | W2 |
| **CD-5** | viem-only; prohibido ethers.js; imports solo de `'viem'`/`'viem/accounts'`. | W0, W1, W3, W4 |
| **CD-6** | No modificar `receiptService`; solo `emit(...)` fire-and-forget. | W2 |
| **CD-7** | Tests contra mock; `writeContract debit(...)` NO en CI. | W3, W4 |
| **CD-8** | Match/credito SIEMPRE del evento `Deposited` on-chain, nunca `body.amount`/`body.from`. | W1, W4 |
| **CD-9** | `callerKey` única fuente de linaje (`owner_ref`/`id`/`funding_wallet`). | W2 |
| **CD-10** | Nuevos `reason` → union `EscrowVerificationReason` + mapeo status en `auth.ts` + test. | W0, W2, W4 |
| **CD-11** | `ESCROW_MODE_ENABLED === 'true'` estricto; prohibido `Boolean(...)`. | W2, W4 |
| **CD-12** | Domain escrow incluye `verifyingContract`; rechazar firmar sin contrato configurado. | W0, W3, W4 |

---

## 7. Definition of Done (Story File)

El Dev termina cuando TODO lo siguiente pasa:

- [ ] **Build**: `npm run build` / `tsc --noEmit` → **0 errores** (TypeScript strict, sin `any` explícito).
- [ ] **Lint**: linter del repo → **0 errores**.
- [ ] **Suite verde**: `npm test` (vitest) → toda la suite pasa, incluyendo los 3 archivos nuevos.
- [ ] **≥1 test por AC**: los 11 ACs cubiertos (§4 W4 tabla) + tests de CD-8/CD-10/CD-11/CD-12.
- [ ] **8 archivos del Scope IN** creados/modificados (§1); **0 archivos** fuera del Scope IN tocados (salvo el `export` aditivo opcional en `deposit-verifier.ts` por 4.1.1, documentado).
- [ ] **Anti-Hallucination Checklist (§2)** verificado item por item.
- [ ] **Sin regresión (AC-8)**: con flag off, el flujo treasury existente intacto — verificado por el test AC-8 y porque los pasos 5b/6/7 del handler no se bifurcan.
- [ ] **VERIFY-AT-IMPL documentados**: forma del ABI, derivación de `keyId`, presencia de `nonce`, y `receiptType:'deposit_verified'` marcados en JSDoc/comentarios como pendientes de converger con 126a / verificar constraint. NO presentados como canónicos.
- [ ] **Cero hardcodes** (direcciones/topic0/typehash) — grep manual de `0x` literales de 40/64 hex en producción == solo en tests/fixtures.

---

## 8. Orden de ejecución (resumen para el Dev)

1. **W0** — crear `escrow/abi.ts` (ABI `as const`), `escrow/eip712.ts` (tipos+domain), `escrow-verifier.ts` (solo tipos `EscrowVerificationReason`/`EscrowDepositVerification`). `tsc` verde.
2. **W1** — cuerpo de `escrow-verifier.ts` (`resolveEscrowContract`, cache, `verifyEscrowDeposit`, `_resetEscrowVerifier`). Reuso de helpers de `deposit-verifier.ts`.
3. **W2** — `auth.ts`: imports, `escrowModeEnabled()`, selector paso 5 + mapeo status CD-10, recibo paso 6b. `.env.example`.
4. **W3** — `escrow/eip712.ts`: `buildDebitAuthorization` + `hashDebitAuthorization`.
5. **W4** — `escrow-verifier.test.ts`, `escrow/eip712.test.ts`, `auth.escrow.test.ts`. Correr suite completa.
6. Verificar Definition of Done (§7).

---

## 9. Riesgos a documentar (no bloqueantes del Dev, pero anotar)

- **R-1 (interfaz cross-HU)**: ABI/`keyId`/`nonce` deben converger byte-a-byte con 126a. Cualquier divergencia se resuelve en `abi.ts`/`eip712.ts` aislado (sin tocar el handler).
- **R-2 (replay débito)**: si 126a omite `nonce`/`deadline`, una firma podría re-presentarse. 126b incluye `nonce` como defensa; si 126a lo omite, documentar TD y NO marcar done sin gate de seguridad.
- **R-3 (`receipt_type='deposit_verified'`)**: posible CHECK constraint en `a2a_receipts`. `emit` best-effort → un rechazo degrada a WARN sin romper el depósito; verificar constraint y escalar si existe (no bloqueante).
- **R-4 (e2e on-chain)**: `writeContract debit(...)` + e2e on-chain esperan deploy de 126a — fuera de CI (CD-7). Smoke on-chain = HU operacional posterior.

---

*Story File F2.5 — WKH-126b — generado por nexus-architect. No se escribió código de producción. Próxima fase: F3 (nexus-dev) wave por wave desde este documento.*
