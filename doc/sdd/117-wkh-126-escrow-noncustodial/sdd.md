# SDD #117: [WKH-126b] Integración TS del Escrow No-Custodial — escrow-verifier + routing condicional /deposit + ABI/EIP-712

> SPEC_APPROVED: no
> Fecha: 2026-06-21
> Tipo: feature (security / payment / custodia de fondos)
> SDD_MODE: full
> Branch: feat/117-wkh-126b-escrow-ts-integration
> Artefactos: doc/sdd/117-wkh-126-escrow-noncustodial/
> Épica: E17 (ESCROW NO-CUSTODIAL) — sub-HU TS (WKH-126a = contrato Solidity, hermana/prerequisito)

---

## 1. Resumen

Hoy el fondeo de una Agent Key es **custodial**: el agente transfiere USDC vía
ERC-20 `Transfer` a una EOA del operador (`resolveTreasury`), `deposit-verifier.ts`
verifica el evento `Transfer(from,to,value)` on-chain y `budgetService.registerDeposit`
acredita budget en DB. El saldo per-key vive solo en Postgres y el operador
custodia físicamente los fondos.

Esta HU (**WKH-126b**) introduce la **integración TypeScript** del modelo
no-custodial: cuando `ESCROW_MODE_ENABLED === 'true'`, el agente deposita en un
**contrato escrow** (WKH-126a) que emite `Deposited(depositor, keyId, amount)`. Un
nuevo adapter `escrow-verifier.ts` (espejo de `deposit-verifier.ts`) verifica ese
evento on-chain antes de acreditar (verify-before-credit, CD-1). El débito por uso
se autoriza con una **firma EIP-712 `DebitAuthorization`** que el gateway construye
server-side y presenta al contrato (`debit(keyId, amount, deadline, signature)`),
de modo que el operador **nunca** puede retirar más de lo firmado por operación.

La feature es **estrictamente aditiva y coexistente** (DT-4): con el flag off
(default) el flujo treasury actual corre **sin ninguna regresión**. El contrato
Solidity (WKH-126a) está **fuera de scope**; esta HU consume su ABI/interfaz como
constante TS provisional y testea contra mock viem / anvil sin depender del deploy
(CD-7).

**Resultado esperado:** trust-minimización del fondeo prepago — los fondos viven en
un contrato verificable, no en una EOA del operador, y cada débito tiene una
autorización EIP-712 auditable encadenada con los recibos inmutables de WKH-124.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 117 (WKH-126b) |
| **Tipo** | feature / security / payment |
| **SDD_MODE** | full |
| **Objetivo** | Integración TS del escrow no-custodial: verificación on-chain del evento `Deposited`, routing condicional en `/deposit` por flag, ABI + helper EIP-712 `DebitAuthorization`, multichain (Kite/Avalanche/Base), tests contra mock. |
| **Reglas de negocio** | verify-before-credit; anti-replay `UNIQUE(chain_id,tx_hash)`; Ownership Guard `owner_ref`; viem-only; no hardcodes; coexistencia vía flag sin regresión; receiptService solo se llama, no se modifica. |
| **Scope IN** | Ver §6 IN |
| **Scope OUT** | Ver §6 OUT |
| **Missing Inputs** | Resueltos en §11 (forma del ABI/dominio EIP-712 fijada provisionalmente; campo `escrow_balance` → NO se agrega, ver DT-9). |

### Acceptance Criteria (EARS) — heredados del work-item (11 ACs)

- **AC-1**: WHEN un agente transfiere USDC al escrow y llama `POST /deposit` con `tx_hash`, THEN el sistema SHALL verificar on-chain el evento `Deposited(depositor, keyId, amount)` correspondiente al `funding_wallet` bindeado y SHALL acreditar solo si la verificación es exitosa (verify-before-credit).
- **AC-2**: WHILE no haya confirmaciones suficientes (`A2A_DEPOSIT_MIN_CONFIRMATIONS_<FAMILY>`), the system SHALL reject con `INSUFFICIENT_CONFIRMATIONS` y NO acreditar budget.
- **AC-3**: IF el `(chain_id, tx_hash)` ya fue procesado, THEN the system SHALL responder `409 DEPOSIT_ALREADY_CREDITED` sin double-credit.
- **AC-4**: WHILE el agente tiene fondos en el escrow, the system SHALL NOT permitir que el operador retire sin una autorización EIP-712 firmada linkeada a un recibo válido.
- **AC-5**: IF una tx intenta retirar sin autorización EIP-712 válida, THEN the system SHALL revertir (enforced por WKH-126a; la integración TS SHALL NOT generar/presentar autorizaciones inválidas o faltantes).
- **AC-6**: WHEN `/deposit` recibe un `tx_hash` de escrow, the system SHALL verificar `Deposited.depositor == funding_wallet` del caller y retornar `403 FUNDING_WALLET_MISMATCH` ante discrepancia.
- **AC-7**: WHEN `budgetService.registerDeposit` se llama tras verificación escrow, the system SHALL pasar `owner_ref` y NO acreditar a una key cuyo `owner_ref` no coincide con el caller (Ownership Guard WKH-53).
- **AC-8**: WHILE `ESCROW_MODE_ENABLED` no es `'true'`, the system SHALL operar con el flujo treasury EOA existente (sin breaking change).
- **AC-9**: WHERE `ESCROW_MODE_ENABLED === 'true'`, the system SHALL rutear la verificación a través del escrow adapter en lugar de `resolveTreasury`, usando el mismo RPC `register_a2a_key_deposit` y el mismo shape `{ balance, chain_id }`.
- **AC-10**: WHEN el escrow está habilitado, the system SHALL soportar al menos las mismas chain keys que `deposit-verifier.ts` (`kite-ozone-testnet`, `avalanche-fuji`, `base-sepolia`) con dirección de contrato por chain resoluble desde env vars (sin hardcodes).
- **AC-11**: WHEN un depósito se acredita desde el flujo escrow, the system SHALL emitir un recibo `deposit_verified` vía `receiptService.emit` (best-effort, fire-and-forget) con `tx_hash` = el hash on-chain.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos y patrón extraído

| Archivo | Líneas relevantes | Patrón / verdad extraída |
|---------|------------------|--------------------------|
| `src/adapters/deposit-verifier.ts` | 1-311 | **Exemplar principal**. `DepositVerification` interface; `VerifyDepositArgs`; lazy `publicClient` cache `Map<ChainKey, PublicClient>`; `getVerifierClient`/`_resetVerifier`; helpers env `resolveChainFamilyEnvSuffix`, `resolveMinConfirmations`, `resolveRpcUrl`, `resolveChainObject`; orden de verificación (client → receipt → status → chainId → confirmations → evento/amount); decode de evento con `decodeEventLog` + `parseAbiItem`; devuelve `from` (depositor) para el funding-wallet gate (BLQ-MED-1). El escrow-verifier es un **espejo estructural** de este archivo. |
| `src/routes/auth.ts` | 595-707 | Handler `POST /deposit`: auth (`resolveCallerKey`) → validación `DepositInput` → ownership pre-check (`body.key_id !== callerKey.id` → 403) → resolución chain/bundle → chain_id match → **`verifyDeposit`** (paso 5) → funding-wallet gate (5b) → `budgetService.registerDeposit` (paso 6) → `{ balance, chain_id }`. El routing condicional se inserta **en el paso 5** (qué verifier se llama), no bifurca el resto del handler (DT-5). |
| `src/routes/auth.ts` | 741-779 | `GET /deposit-info`: usa `resolveTreasury`/`resolveMinConfirmations`/`resolveChainFamilyEnvSuffix`. **NO se toca** salvo eventual extensión opcional (fuera de scope estricto). |
| `src/services/budget.ts` | 306-345 | `registerDeposit(keyId, chainId, amountUsd, ownerId, txHash, token?)` → RPC `register_a2a_key_deposit` (FOR UPDATE + UNIQUE(chain_id,tx_hash) + ownership DB-level). Mapea `DEPOSIT_ALREADY_CREDITED` → `DepositAlreadyCreditedError`, `OWNERSHIP_MISMATCH` → `OwnershipMismatchError`. **Sin cambios** (DT-6). |
| `src/services/receipt.ts` | 96-188 | `receiptService.emit(input)`: best-effort, NUNCA throw, guards (`ownerRef` + `RECEIPT_SIGNING_SECRET`), RPC `insert_receipt` + UPDATE-once del hash. Campos de `EmitReceiptInput`: `ownerRef, agentKeyId, sessionId, delegationId, receiptType, amountUsd, chainId, txHash, counterparty, orchestrationId`. **Solo se llama, no se modifica** (CD-6). |
| `src/services/signed-auth.ts` | 42-153 | **Exemplar EIP-712**. `REQUEST_TYPES` con `as const`; `buildRequestDomain()` lee env con defaults; `recoverTypedDataAddress({ domain, types, primaryType, message, signature })`; nonce `bytes32`, timestamp `uint64` → `BigInt(ts)`; `try/catch` → false sin throw. El helper de `DebitAuthorization` reusa esta forma exacta. |
| `src/services/delegation.ts` | 47-78 | EIP-712 con `verifyingContract` omitido y dominio leído de env (`DELEGATION_EIP712_NAME/VERSION`). Confirma el patrón `as const` para tipos + recover viem 2.50.4. Para el escrow **SÍ** incluimos `verifyingContract` (el contrato verifica con `ECDSA.recover`, DT-8). |
| `src/adapters/types.ts` | 1-146 | `ChainKey` (6 slugs), `AdaptersBundle` (`payment.supportedTokens[0]`, `chainConfig.chainId`), `TokenSpec`. La nueva interfaz `EscrowAdapter`/tipos de verificación viven en este patrón. |
| `src/adapters/deposit-verifier.test.ts` | 1-120 | **Exemplar de test**. `vi.mock('viem', importOriginal)` preservando `formatUnits`/`decodeEventLog`/`parseAbiItem`/`http` y mockeando `createPublicClient` (`getTransactionReceipt`/`getBlockNumber`/`getChainId`); fixtures `transferLog`, `topicAddr`, `makeBundle`; `ORIGINAL_ENV` snapshot + `_resetVerifier()` en `beforeEach`. El escrow test es un espejo con log `Deposited` en vez de `Transfer`. |
| `src/adapters/chain-resolver.ts` | 61-85 | `normalizeChainSlug`, `resolveChainKey` — usados por el handler para mapear `chain_id`/header → `ChainKey`. Sin cambios. |
| `src/adapters/registry.ts` | 209-222 | `getAdaptersBundle`, `getInitializedChainKeys`. Sin cambios. |
| `src/services/security/errors.ts` | 9-23+ | `OwnershipMismatchError`, `DepositAlreadyCreditedError`. Reusados; el escrow flow no agrega clases nuevas en la ruta de depósito. |

### Auto-Blindaje histórico aplicado (últimas HUs DONE)

Revisados `114-wkh-125`, `113-wkh-124`, `116-wkh-sec-02` (auto-blindaje.md). Patrones
recurrentes incorporados a los CD de esta HU:

- **WKH-125 / BLQ-ALTO-1**: nunca keyear un débito/match desde el **input crudo del
  caller**; usar la forma **canónica** del recurso. → **CD-8** (el match del depósito
  usa SIEMPRE valores on-chain del evento `Deposited`, nunca `body.amount`/`body.from`).
- **WKH-124 / Wave 2**: el row del caller en compose/orchestrate es `scopingKeyRow`,
  no `a2aKeyRow`; en `auth.ts` (este flujo) el row es `callerKey` (de `resolveCallerKey`).
  → **CD-9** (usar `callerKey.owner_ref`/`callerKey.id`/`callerKey.funding_wallet`; no
  inventar otra fuente).
- **WKH-125 / Wave 3 + WKH-124**: agregar un nuevo error-code obliga a ampliar el
  **union de tipos** + setearlo en el call-site + branch en la ruta. → **CD-10** (los
  nuevos `reason` del escrow se agregan al union `DepositVerificationReason` o a un
  union propio `EscrowVerificationReason`, y se mapean en `auth.ts`).
- **WKH-SEC-02 / Wave 2**: aserciones de test frágiles por substring. → recordatorio
  en el Test Plan: los tests del adapter assertean sobre el objeto de retorno
  (`{ ok, reason }`), no sobre strings sueltos.

---

## 4. Decisiones Técnicas (DT-N)

> Heredadas del work-item: **DT-1..DT-5** (ver work-item §"Decisiones Técnicas").
> DT-1 (modelo EIP-712) y DT-4 (coexistencia por flag) están **LOCKEADOS**.
> A continuación se refinan y se agregan DT-6..DT-10.

**DT-6 (refina DT-2): `escrow-verifier.ts` es un espejo estructural de `deposit-verifier.ts`.**
Se crea `src/adapters/escrow-verifier.ts` que exporta `verifyEscrowDeposit(args): Promise<EscrowDepositVerification>` con la MISMA mecánica de `verifyDeposit` (lazy publicClient cache propio, receipt → status → chainId → confirmations), pero:
- Decodifica `Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)` en vez de `Transfer`.
- El log se filtra por `log.address == escrowContractAddress` (de env, DT-7) en vez de por la dirección del token.
- `depositor` (= `Deposited.depositor`) se devuelve como `from` (mismo nombre de campo que `DepositVerification.from`) para reusar el funding-wallet gate del handler **sin cambios** (5b en `auth.ts`).
- Reusa los helpers de `deposit-verifier.ts` que son chain-genéricos: `resolveChainFamilyEnvSuffix`, `resolveMinConfirmations`, `resolveRpcUrl`, `resolveChainObject` (se **importan/reexportan**, no se duplican — single source of truth).
- Mantiene su propio `_clients` cache + `_resetEscrowVerifier()` test-only (no comparte el `Map` privado de deposit-verifier).

**DT-7: dirección del contrato escrow por chain desde env (CD-3).**
`resolveEscrowContract(chainKey): \`0x${string}\` | null` lee
`process.env.A2A_ESCROW_CONTRACT_<FAMILY>` (FAMILY ∈ KITE/AVALANCHE/BASE vía
`resolveChainFamilyEnvSuffix`), valida con `ADDRESS_RE`, retorna `null` si ausente/inválida
→ el verifier devuelve `reason: 'ESCROW_CONTRACT_NOT_CONFIGURED'` (fail-loud, cero crédito).
NO hay fallback a `OPERATOR_PRIVATE_KEY` (a diferencia de `resolveTreasury`): el escrow es
un contrato deployado, no una EOA derivable.

**DT-8 (refina DT-1/DT-3): interfaz EIP-712 `DebitAuthorization` con `verifyingContract`.**
A diferencia de los dominios de `signed-auth.ts`/`delegation.ts` (que omiten
`verifyingContract` porque verifican off-chain con `recoverTypedDataAddress`), el dominio
escrow **incluye `verifyingContract`** = la dirección del contrato escrow, porque el que
verifica la firma es el contrato on-chain con `ECDSA.recover`. Ver §9 (interfaz canónica).
El helper TS de esta HU **construye** y **valida localmente** (recover de sanity) la firma;
la **presentación on-chain** real (`writeContract debit(...)`) queda detrás del flag y
espera el deploy de 126a (no se ejecuta en CI — CD-7). El helper es PURO (no toca DB ni red
en su construcción del typed-data), facilitando el test unitario.

**DT-9 (resuelve TBD del work-item): NO se agrega columna `escrow_balance` a `a2a_agent_keys`.**
El saldo prepago sigue viviendo en la columna `budget` (DB) acreditado por
`register_a2a_key_deposit` — idéntico al flujo treasury. El saldo on-chain del contrato es
consultable en vivo vía RPC cuando se necesite (read-only `escrowBalance(keyId)` en el ABI,
opcional), pero **no se persiste** ni se agrega migración. Razón: evita doble fuente de
verdad del saldo (lección WKH-125: una sola fuente canónica) y mantiene `registerDeposit`
back-compat sin migración. → **No hay cambios de schema en esta HU.**

**DT-10: el routing condicional vive en `auth.ts` paso 5, encapsulado en un selector.**
Se agrega un helper local `escrowModeEnabled(): boolean` (`process.env.ESCROW_MODE_ENABLED === 'true'`,
comparación estricta de string — patrón de flags del repo). En el paso 5 del handler:
`const verification = escrowModeEnabled() ? await verifyEscrowDeposit({...}) : await verifyDeposit({...});`
Ambos retornos son **estructuralmente compatibles** (`{ ok, reason?, amountUsd?, from?, tokenSymbol? }`)
de modo que los pasos 5b/6/7 del handler **no se bifurcan** (DT-5). El recibo `deposit_verified`
(AC-11) se emite tras el éxito en AMBOS caminos (ver DT-11).

**DT-11 (AC-11): emisión del recibo `deposit_verified` best-effort.**
Tras el `registerDeposit` exitoso (paso 6), se llama `receiptService.emit({ ownerRef: callerKey.owner_ref, agentKeyId: callerKey.id, sessionId: null, delegationId: null, receiptType: 'deposit_verified', amountUsd: result.amountUsd, chainId, txHash, counterparty: null, orchestrationId: null })` **sin await bloqueante / sin propagar error** (fire-and-forget; el `emit` ya es NUNCA-throw por contrato). Esto aplica a AMBOS caminos (treasury y escrow) para consistencia — el work-item lo pide explícito para el flujo escrow (AC-11); aplicarlo también al treasury es aditivo y no rompe AC-8 (no cambia el shape de respuesta ni el status). **VERIFY-AT-IMPL**: confirmar que `receiptType: 'deposit_verified'` es un valor aceptado por la columna `receipt_type` / RPC `insert_receipt` (hoy se usan `protocol_fee`/`budget_debit`); si hay un CHECK constraint, el Dev debe documentarlo (no es bloqueante porque `emit` es best-effort y degrada a WARN).

---

## 5. Constraint Directives (CD-N)

> Heredados del work-item: **CD-1..CD-7** (verify-before-credit, anti-replay UNIQUE,
> no hardcodes/env vars, Ownership Guard, viem-only, no tocar receiptService, tests
> contra mock). Se agregan CD-8..CD-12 derivados del diseño y del Auto-Blindaje.

**CD-1 (heredado)**: PROHIBIDO acreditar budget antes de que la verificación on-chain del evento `Deposited` sea exitosa. `verifyEscrowDeposit` retorna `{ ok:false }` → cero crédito.

**CD-2 (heredado)**: OBLIGATORIO preservar `UNIQUE(chain_id, tx_hash)` en `register_a2a_key_deposit`. La firma del RPC NO cambia (DT-6/DT-9). No hay migración en esta HU.

**CD-3 (heredado)**: PROHIBIDO hardcodear direcciones de contrato escrow, ABIs de bytecode o chain IDs. Direcciones desde `A2A_ESCROW_CONTRACT_<FAMILY>` (DT-7); topic0 del evento derivado del ABI por viem (`parseAbiItem`), NUNCA un hash literal.

**CD-4 (heredado)**: OBLIGATORIO Ownership Guard. El escrow flow llama `budgetService.registerDeposit(callerKey.id, chainId, amountUsd, callerKey.owner_ref, txHash, token)` con `owner_ref` no-undefined. No hay nuevas queries directas a `a2a_agent_keys` en este flujo (el adapter solo lee on-chain). AR DEBE buscar cualquier `.from('a2a_agent_keys')` sin `owner_ref` introducido por la HU.

**CD-5 (heredado)**: PROHIBIDO `ethers.js`. Todo blockchain (lectura de evento, ABI, construcción/recover EIP-712) usa `viem` v2: `createPublicClient`, `decodeEventLog`, `parseAbiItem`, `recoverTypedDataAddress`, `hashTypedData`. Imports SOLO desde `'viem'` / `'viem/accounts'`.

**CD-6 (heredado)**: PROHIBIDO modificar `receiptService`. El escrow flow SOLO llama `receiptService.emit(...)` (best-effort, fire-and-forget). Cero cambios en `src/services/receipt.ts`.

**CD-7 (heredado)**: OBLIGATORIO que los tests del escrow adapter y del helper EIP-712 corran contra mock viem / interfaz provisional — NO requieren el contrato WKH-126a deployado. El path on-chain `writeContract debit(...)` NO se ejecuta en CI (queda detrás del flag + tras deploy de 126a).

**CD-8 (Auto-Blindaje WKH-125 BLQ-ALTO-1)**: PROHIBIDO matchear/acreditar usando el input crudo del caller. El `amountUsd`, `depositor` (`from`) y `keyId` se derivan SIEMPRE del evento `Deposited` decodificado on-chain. `body.amount` solo se usa para la comparación opcional `AMOUNT_MISMATCH` (reparseada a atómico con `parseUnits`, igual que `deposit-verifier.ts:282-296`), nunca como valor acreditado.

**CD-9 (Auto-Blindaje WKH-124)**: OBLIGATORIO usar `callerKey` (de `resolveCallerKey`) como única fuente del linaje en `auth.ts`: `callerKey.owner_ref`, `callerKey.id`, `callerKey.funding_wallet`. PROHIBIDO inventar `request.a2aKeyRow`/`scopingKeyRow` u otra fuente en este handler.

**CD-10 (Auto-Blindaje WKH-125 Wave3 / WKH-124)**: si se agregan nuevos `reason` para el escrow, OBLIGATORIO (i) agregarlos al union de tipos (`EscrowVerificationReason`), (ii) mapearlos en `auth.ts` paso 5 (status code), (iii) cubrirlos con test. El mapeo de status sigue el patrón existente: `RPC_UNAVAILABLE`/`ESCROW_CONTRACT_NOT_CONFIGURED` → 503; el resto → 400 (excepto `FUNDING_WALLET_MISMATCH` → 403, ya en 5b).

**CD-11**: OBLIGATORIO que `escrowModeEnabled()` use comparación estricta `=== 'true'`. Cualquier otro valor (`'1'`, `'TRUE'`, `''`, undefined) → flag OFF (fail-safe hacia el flujo treasury existente, AC-8). PROHIBIDO `Boolean(process.env.ESCROW_MODE_ENABLED)` (truthy de string no-vacío rompería el default).

**CD-12**: OBLIGATORIO que el helper EIP-712 `DebitAuthorization` incluya `verifyingContract` en el dominio (DT-8) y rechace construir la firma si la dirección del contrato escrow no está configurada (sin contrato → no hay `verifyingContract` válido → no se puede firmar un débito presentable). PROHIBIDO firmar con `chainId` o `verifyingContract` placeholder/cero.

---

## 6. Scope

### IN (archivos a crear/modificar)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/adapters/escrow/abi.ts` | **crear** — ABI escrow tipado (array viem `as const`) + constantes EIP-712 (typehash/struct fields). Provisional, coordinado con 126a. | W0 |
| 2 | `src/adapters/escrow/eip712.ts` | **crear** — `buildDebitDomain`, `DEBIT_AUTHORIZATION_TYPES`, `buildDebitAuthorization(...)` (helper PURO de construcción + recover de sanity). | W0/W3 |
| 3 | `src/adapters/escrow-verifier.ts` | **crear** — `verifyEscrowDeposit`, `EscrowDepositVerification`, `EscrowVerificationReason`, `resolveEscrowContract`, `_resetEscrowVerifier`. | W1 |
| 4 | `src/routes/auth.ts` | **modificar** — paso 5 del handler `/deposit`: selector `escrowModeEnabled()` + emisión recibo `deposit_verified` (paso 6b). | W2 |
| 5 | `src/adapters/escrow-verifier.test.ts` | **crear** — unit tests del verifier (mock viem). | W4 |
| 6 | `src/adapters/escrow/eip712.test.ts` | **crear** — unit tests del helper EIP-712 (recover round-trip). | W4 |
| 7 | `src/routes/auth.escrow.test.ts` | **crear** — tests de integración del handler `/deposit` en escrow mode (mockeando `verifyEscrowDeposit` + `budgetService` + `receiptService`). | W4 |
| 8 | `.env.example` | **modificar** (si existe) — documentar `ESCROW_MODE_ENABLED`, `A2A_ESCROW_CONTRACT_KITE/AVALANCHE/BASE`, `ESCROW_EIP712_NAME/VERSION`. | W2 |

> **VERIFY-AT-IMPL**: el tipo de retorno de `verifyEscrowDeposit` y `verifyDeposit` deben
> ser estructuralmente compatibles en los campos que `auth.ts` consume (`ok`, `reason`,
> `amountUsd`, `from`, `tokenSymbol`). Si se introduce un union de `reason` distinto,
> aplicar CD-10. No se reescribe `DepositVerification`; el escrow define su propio tipo.

### OUT

- **Contrato Solidity WKH-126a** (repo/carpeta aparte, Foundry/Hardhat). Esta HU consume su ABI/interfaz.
- **x402 / EIP-3009** (otro modelo de pago).
- **Withdrawal/liquidación del agente** (governance del contrato — 126a).
- **Mainnet deploy** (testnet only).
- **Cambios a `receiptService` core** (WKH-124, solo se llama).
- **Reputación ERC-8004** (WKH-103).
- **Session keys / delegaciones / constraints por destino** (WKH-121/122/125): no se tocan; deben seguir funcionando.
- **Presentación on-chain real `writeContract debit(...)`** (depende del deploy 126a; el helper construye/valida la firma, pero la tx on-chain queda detrás del flag y fuera de CI).
- **Migración DB / columna `escrow_balance`** (DT-9: no se agrega).

---

## 7. Waves de implementación

> W0 es **serial** (contratos/tipos compartidos). W1..W3 dependen de W0. W4 (tests)
> cubre cada wave. No hay gates humanos entre waves.

### W0 — Contratos de interfaz (tipos, ABI, dominio EIP-712) [SERIAL]

- **`src/adapters/escrow/abi.ts`**: exportar `ESCROW_ABI` (array viem `as const`) con, al menos:
  - `event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)`
  - `function deposit(bytes32 keyId, uint256 amount)` (emite `Deposited`)
  - `function debit(bytes32 keyId, uint256 amount, uint256 deadline, bytes signature)`
  - `function escrowBalance(bytes32 keyId) view returns (uint256)` (read opcional, DT-9)
  - Marcado en JSDoc como **PROVISIONAL — coordinar forma canónica con WKH-126a**.
- **`src/adapters/escrow/eip712.ts`**: definir `DEBIT_AUTHORIZATION_TYPES` (`as const`) y `buildDebitDomain(chainKey, verifyingContract)` (§9). Tipo `DebitAuthorizationMessage`.
- **Tipos del verifier**: `EscrowVerificationReason`, `EscrowDepositVerification` (en `escrow-verifier.ts`, declarados en W0 aunque el cuerpo se complete en W1).

### W1 — `escrow-verifier.ts` (lectura on-chain del evento `Deposited`)

- `resolveEscrowContract(chainKey)` (DT-7, env `A2A_ESCROW_CONTRACT_<FAMILY>` + `ADDRESS_RE`).
- `verifyEscrowDeposit(args)`: espejo de `verifyDeposit` (DT-6). Reusa helpers chain-genéricos importados de `deposit-verifier.ts`. Decodifica `Deposited` (filtro por `log.address == escrowContract`); valida `keyId` del evento corresponde a la key del caller (ver §9 sobre derivación de `keyId`); devuelve `from = depositor`, `amountUsd = formatUnits(amount, token.decimals)`, `tokenSymbol`.
- `_resetEscrowVerifier()` test-only (cache propio).

### W2 — Routing condicional en `POST /deposit` + recibo

- `escrowModeEnabled()` helper (CD-11) en `auth.ts` (o import desde el verifier).
- Paso 5: selector treasury vs escrow (DT-10). Pasos 5b/6/7 intactos (DT-5).
- Paso 6b: `receiptService.emit({ receiptType:'deposit_verified', ... })` fire-and-forget (DT-11).
- `.env.example` actualizado.

### W3 — Helper de construcción/validación de la firma EIP-712 de débito (server-side)

- `buildDebitAuthorization({ keyId, amount, deadline, chainKey, verifyingContract, signer })`: construye el typed-data (`domain + types + message`), opcionalmente firma con `signer` (cuenta viem derivada de `OPERATOR_PRIVATE_KEY` o session key) y hace un **recover de sanity** (`recoverTypedDataAddress` debe devolver la cuenta esperada). Helper PURO sobre la construcción; NO ejecuta `writeContract` (eso espera 126a, CD-7).
- Exporta `hashDebitAuthorization(...)` (vía `hashTypedData`) para tests/auditoría.

### W4 — Tests (mock / anvil) — ≥1 por AC

- `escrow-verifier.test.ts`, `eip712.test.ts`, `auth.escrow.test.ts` (ver §8). Todos contra mock viem; cero dependencia del deploy 126a (CD-7).

---

## 8. Plan de Tests (AC → test)

> Patrón: `vi.mock('viem', importOriginal)` preservando `formatUnits/decodeEventLog/parseAbiItem/hashTypedData/recoverTypedDataAddress/http` y mockeando `createPublicClient` (exemplar `deposit-verifier.test.ts:18-30`). Snapshot `ORIGINAL_ENV` + reset de cache en `beforeEach`. Aserciones sobre el **objeto de retorno** (`{ ok, reason }`), no substrings (Auto-Blindaje WKH-SEC-02).

| AC | Test | Archivo | Qué cubre |
|----|------|---------|-----------|
| AC-1 | `verifyEscrowDeposit ok=true cuando Deposited(depositor=funding,keyId,amount) tiene confirmaciones` | `escrow-verifier.test.ts` | Happy path: evento decodificado, `from`=depositor, `amountUsd` derivado de `token.decimals`. |
| AC-2 | `verifyEscrowDeposit reason=INSUFFICIENT_CONFIRMATIONS cuando confirmations < min` | `escrow-verifier.test.ts` | Bloque de confirmaciones (espejo deposit-verifier). |
| AC-3 | `POST /deposit escrow → 409 DEPOSIT_ALREADY_CREDITED cuando registerDeposit lanza DepositAlreadyCreditedError` | `auth.escrow.test.ts` | Anti-replay preservado (mock budgetService lanza la error class). |
| AC-4 | `buildDebitAuthorization produce firma cuya recover == signer; sin signature NO se presenta` | `eip712.test.ts` | El helper nunca emite autorización sin firma válida (la presentación on-chain real es 126a). |
| AC-5 | `buildDebitAuthorization lanza/retorna error si verifyingContract no configurado (no firma placeholder)` | `eip712.test.ts` | CD-12: no se construye autorización inválida/faltante (la revert on-chain es 126a). |
| AC-6 | `POST /deposit escrow → 403 FUNDING_WALLET_MISMATCH cuando depositor != funding_wallet` | `auth.escrow.test.ts` | Gate 5b reusado: `verifyEscrowDeposit` devuelve `from` != `callerKey.funding_wallet`. |
| AC-7 | `POST /deposit escrow llama registerDeposit con callerKey.owner_ref` | `auth.escrow.test.ts` | Ownership Guard: assert del 4º arg = `owner_ref` del caller; mock OWNERSHIP_MISMATCH → 403. |
| AC-8 | `POST /deposit con ESCROW_MODE_ENABLED unset usa verifyDeposit (treasury), no verifyEscrowDeposit` | `auth.escrow.test.ts` | Flag off → camino legacy; assert que `verifyEscrowDeposit` NO se llamó. |
| AC-9 | `POST /deposit con ESCROW_MODE_ENABLED='true' usa verifyEscrowDeposit y retorna { balance, chain_id }` | `auth.escrow.test.ts` | Flag on → escrow; mismo shape de respuesta, mismo RPC. |
| AC-10 | `resolveEscrowContract resuelve por A2A_ESCROW_CONTRACT_<FAMILY> para kite/avalanche/base; null si ausente` | `escrow-verifier.test.ts` | Multichain + no hardcode; `ESCROW_CONTRACT_NOT_CONFIGURED` cuando falta. |
| AC-11 | `POST /deposit escrow exitoso emite receiptService.emit con receiptType='deposit_verified' y txHash` | `auth.escrow.test.ts` | Recibo best-effort: assert del input de `emit`; un throw de `emit` (simulado) NO rompe la respuesta 200. |

**Tests adicionales (no-AC pero exigidos por CD):**
- CD-8: `verifyEscrowDeposit ignora body.amount como valor acreditado; AMOUNT_MISMATCH cuando body.amount != on-chain amount`.
- CD-11: `escrowModeEnabled() === true SOLO con 'true' exacto` (parametrizado: `'1'`,`'TRUE'`,`''`,undefined → false).
- Reason mapping (CD-10): `RPC_UNAVAILABLE`/`ESCROW_CONTRACT_NOT_CONFIGURED` → 503; resto → 400.

---

## 9. Interfaz EIP-712 explícita — `DebitAuthorization` (entregable-contrato 126a ↔ 126b)

> Esta sección es el **contrato de interfaz** que WKH-126a DEBE implementar
> canónicamente y que 126b consume. Marcada **PROVISIONAL** hasta confirmación de
> 126a; los tests de 126b corren contra esta forma (CD-7).

### Dominio EIP-712

```
domain = {
  name:              "WasiAIEscrow",                    // env ESCROW_EIP712_NAME, default "WasiAIEscrow"
  version:           "1",                                // env ESCROW_EIP712_VERSION, default "1"
  chainId:           <chainId del bundle de la chain>,   // p.ej. 2368 (kite), 43113 (fuji), 84532 (base sepolia)
  verifyingContract: <A2A_ESCROW_CONTRACT_<FAMILY>>      // dirección del contrato escrow en esa chain (DT-8/CD-12)
}
```

> Diferencia clave con `signed-auth.ts`/`delegation.ts`: **`verifyingContract` SÍ se
> incluye** porque el verificador es el contrato on-chain (`ECDSA.recover`), no el server.

### Struct firmado (primaryType `DebitAuthorization`)

```
DebitAuthorization {
  bytes32 keyId;      // identificador on-chain de la Agent Key (ver "Derivación de keyId")
  uint256 amount;     // monto a debitar en unidades ATÓMICAS del token (no USD humano)
  uint256 deadline;   // epoch seconds; el contrato revierte si block.timestamp > deadline
  uint256 nonce;      // anti-replay del débito (monotónico o aleatorio; 126a define la política)
}
```

> **`nonce` agregado al struct del work-item**: el work-item provisional listaba
> `{keyId, amount, deadline}`. Para evitar replay de una misma autorización de débito
> (un operador no debe poder re-presentar la misma firma dos veces) se **añade `nonce`**.
> Esto es una recomendación de seguridad para 126a; si 126a no implementa nonce, 126b
> degrada el struct a 3 campos — pero se documenta como riesgo (ver §12). **VERIFY-AT-IMPL
> con 126a.**

### Type hash (derivado por viem, NO hardcodear)

```
DEBIT_AUTHORIZATION_TYPES = {
  DebitAuthorization: [
    { name: "keyId",    type: "bytes32" },
    { name: "amount",   type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce",    type: "uint256" },
  ],
} as const
```

El typehash canónico (`keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)")`)
lo deriva viem internamente (`hashTypedData`/`recoverTypedDataAddress`); 126b **no lo
hardcodea** (CD-3). 126a debe usar EXACTAMENTE el mismo string de tipo (mismo orden de
campos) para que las firmas sean compatibles.

### Firmante esperado

El **agente** (o el gateway en su nombre) firma `DebitAuthorization`. El recover
on-chain (`ECDSA.recover`) debe coincidir con el firmante autorizado registrado en el
contrato para ese `keyId`. En 126b, el helper firma con la cuenta viem derivada del
secret correspondiente (`OPERATOR_PRIVATE_KEY` o session key) y hace un **recover de
sanity** off-chain antes de considerar la autorización presentable.

### Derivación de `keyId` (bytes32) — **VERIFY-AT-IMPL con 126a**

El `keyId` on-chain es `bytes32`, pero `a2a_agent_keys.id` es un UUID (texto). La
correspondencia canónica la define 126a; opciones provisionales para 126b:
- `keyId = keccak256(utf8Bytes(uuid))` (determinista, sin colisión práctica), **o**
- el UUID empacado a `bytes32` (16 bytes con padding).
Se elige `keccak256(utf8Bytes(uuid))` como provisional (más robusto frente a formatos de
UUID). **Esta decisión DEBE coincidir byte-a-byte con 126a** (lección WKH-125: un solo
origen canónico para la clave). El verifier compara el `keyId` decodificado del evento
`Deposited` contra `keccak256(utf8Bytes(callerKey.id))`.

---

## 10. Exemplars verificados (paths reales en disco)

| Exemplar | Path (verificado con Read) | Uso |
|----------|---------------------------|-----|
| Deposit verifier (estructura, cache, helpers, decode evento) | `src/adapters/deposit-verifier.ts` | Espejo para `escrow-verifier.ts`. |
| Test de verifier (mock viem, fixtures de log) | `src/adapters/deposit-verifier.test.ts` | Espejo para `escrow-verifier.test.ts`. |
| Handler `/deposit` (puntos de inserción) | `src/routes/auth.ts:602-707` | Routing condicional + recibo. |
| `registerDeposit` (firma, error classes) | `src/services/budget.ts:314-345` | Reuso sin cambios. |
| `receiptService.emit` (best-effort, campos) | `src/services/receipt.ts:96-188` | Llamada del recibo `deposit_verified`. |
| EIP-712 viem (types `as const`, recover, domain de env) | `src/services/signed-auth.ts:42-153` | Patrón del helper `DebitAuthorization`. |
| EIP-712 con dominio de env (verifyingContract omitido — contraste) | `src/services/delegation.ts:47-78` | Confirma forma; el escrow SÍ incluye verifyingContract. |
| Tipos chain (`ChainKey`, `AdaptersBundle`, `TokenSpec`) | `src/adapters/types.ts:1-146` | Tipado del adapter. |
| Resolución chain en el handler | `src/adapters/chain-resolver.ts:61-85` | `normalizeChainSlug`/`resolveChainKey` (sin cambios). |
| Error classes | `src/services/security/errors.ts:9-23` | `OwnershipMismatchError`, `DepositAlreadyCreditedError`. |

> NUEVOS paths a crear (no existen aún, marcados como **crear** en §6): `src/adapters/escrow/abi.ts`,
> `src/adapters/escrow/eip712.ts`, `src/adapters/escrow-verifier.ts` y sus tests. La carpeta
> `src/adapters/escrow/` no existe hoy (verificado: `src/adapters/` tiene `avalanche/ base/ kite-ozone/ __tests__/` + archivos sueltos) — el Dev la crea.

---

## 11. Resolución de Missing Inputs (work-item §"Missing Inputs")

| TBD del work-item | Resolución en este SDD |
|-------------------|------------------------|
| Forma exacta del ABI/dominio EIP-712 | **Resuelto provisionalmente** en §9 + W0. `domain` con `verifyingContract`; struct `{keyId, amount, deadline, nonce}`; ABI con `deposit`/`debit`/`Deposited`/`escrowBalance`. Marcado VERIFY-AT-IMPL con 126a (no bloquea CI por CD-7). |
| Campo `escrow_balance` en `a2a_agent_keys` | **Resuelto: NO se agrega** (DT-9). Saldo prepago sigue en `budget`; saldo on-chain consultable en vivo. Sin migración. |
| Modelo de débito (NC-2) | Lockeado: EIP-712 (DT-1). |
| Coexistencia (NC-3) | Lockeado: flag `ESCROW_MODE_ENABLED` (DT-4/DT-10/CD-11). |
| Contrato separado (NC-1) | Lockeado: WKH-126a fuera de scope (§6 OUT). |

**No quedan `[NEEDS CLARIFICATION]` sin resolver.** Los puntos `VERIFY-AT-IMPL` (forma
canónica del ABI/keyId/nonce con 126a) son **coordinación entre HUs hermanas**, no
bloqueantes de esta HU: 126b testea contra la interfaz provisional y converge cuando 126a
publique la forma canónica.

---

## 12. Riesgos / Observaciones

- **R-1 (interfaz cross-HU)**: la forma del ABI, la derivación de `keyId` y la presencia
  de `nonce` en el struct deben converger byte-a-byte con WKH-126a. Mitigación: §9 es el
  contrato explícito; cualquier divergencia se resuelve actualizando `abi.ts`/`eip712.ts`
  (aislado, sin tocar el handler). Lección WKH-125: un solo origen canónico para la clave.
- **R-2 (replay de débito)**: si 126a NO implementa `nonce`/deadline en el contrato, una
  firma de débito podría re-presentarse. 126b incluye `nonce` en el struct como defensa;
  si 126a lo omite, documentar como TD y NO marcar la HU done sin el gate de seguridad.
- **R-3 (`receipt_type='deposit_verified'`)**: posible CHECK constraint en `a2a_receipts`.
  Como `emit` es best-effort (NUNCA throw), un rechazo degrada a WARN sin romper el flujo;
  el Dev debe verificar el constraint y, si existe, escalar (no es bloqueante del depósito).
- **R-4 (e2e on-chain)**: el path real `writeContract debit(...)` y el e2e on-chain esperan
  el deploy de 126a — fuera de CI por CD-7. El smoke on-chain se agenda como HU operacional
  posterior (igual que el deploy treasury de WKH-35 quedó "implementado, no desplegado").
- **R-5 (doble fuente de saldo)**: DT-9 evita persistir `escrow_balance` para no duplicar
  la verdad del saldo. Si negocio luego exige reconciliación on-chain↔DB, es una HU aparte.

---

## 13. Readiness Check (¿listo para SPEC_APPROVED?)

- [x] Todos los exemplars verificados con Read (paths reales) — §10.
- [x] Stack respetado: viem v2, Fastify, Supabase, TypeScript strict, vitest (project-context).
- [x] CD-1..CD-7 heredados + CD-8..CD-12 nuevos, todos justificados (§5).
- [x] DT-1..DT-5 heredados + DT-6..DT-11 nuevos (§4).
- [x] Interfaz EIP-712 `DebitAuthorization` definida completa (dominio + struct + typehash + firmante + keyId) — §9, entregable-contrato para 126a.
- [x] Waves ordenadas (W0 serial → W1..W3 → W4), archivos por wave (§6/§7).
- [x] ≥1 test por AC (11 ACs) + tests de CD — §8.
- [x] Sin hardcodes (direcciones/topic0/typehash desde env/ABI/viem) — CD-3.
- [x] Ownership Guard preservado (`owner_ref`), anti-replay UNIQUE preservado — CD-2/CD-4.
- [x] receiptService NO se modifica — CD-6.
- [x] Tests no dependen del deploy 126a — CD-7.
- [x] Missing Inputs resueltos; sin `[NEEDS CLARIFICATION]` abiertos — §11.
- [x] Coexistencia sin regresión verificada por AC-8 (flag off → camino legacy) — CD-11.

**Veredicto: SDD listo para revisión adversarial (F2 Adversary) → SPEC_APPROVED.**

---

*Architect F2 — 2026-06-21 — WKH-126b. No se escribió código de producción. Próxima fase: F2.5 (Story File) tras SPEC_APPROVED.*
