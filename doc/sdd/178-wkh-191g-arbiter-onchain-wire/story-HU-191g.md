# Story File — HU 191g · Wire de `arbiter.ts` al contrato `WasiAIEscrow` (rol arbiter)

> Contrato autocontenido para el Dev (F3). El Dev SOLO lee este archivo.
> Si algo no está acá, no se hace. Todos los paths/líneas fueron verificados con Read/Grep.
>
> - SDD fuente: `doc/sdd/178-wkh-191g-arbiter-onchain-wire/sdd.md` (SPEC_APPROVED)
> - Epic: WKH-191 · Wave 1 (HU 7/8) · depende de 191f (DONE·UPGRADE-PENDING)
> - Branch: `feat/191g-arbiter-onchain-wire`
> - Tipo: feature · SDD_MODE: full

---

## 1. Contexto compacto (qué se construye y por qué)

`WasiAIEscrow.sol` (191f, **congelado**) ya expone las funciones on-chain que el árbitro
usa para mover fondos escrow-custodiados SIN firma del buyer: `lockForDispute`,
`resolveDispute(keyId,seller,sellerAmount,nonce)`, `releaseDispute` — todas `onlyArbiter`
y gateadas por `arbitrationConsent(keyId)`. Hoy `src/services/arbiter.ts` resuelve TODO
sobre el `budget` off-chain vía `settlePaymentIntentOnChain` (operator-custodial).

Esta HU **cablea el camino on-chain en paralelo, flag-gated y aditivo**, sin tocar Solidity
ni romper WKH-139 v2 (auto-resolve) ni WKH-189 (override admin):

- al transicionar un intent a `'disputed'` → best-effort `lockForDispute` por el deposit total;
- al resolver `release`/`split` (`arbMicro > 0`) → `resolveDispute` en vez del settle custodial;
- al resolver `refund` (`arbMicro <= 0`) → best-effort `releaseDispute` (libera el lock).

**Code-complete pero INERTE**: sin `ARBITER_PRIVATE_KEY` + `setArbiter()` on-chain (191h,
Scope OUT) toda llamada `onlyArbiter` revierte `NotArbiter` → `not_moved`; y sin flujo de
captura de consentimiento (Scope OUT) `arbitrationConsent(keyId)` es `false` para el 100% de
los keyIds → el sistema cae SIEMPRE al fallback operator-custodial (comportamiento correcto).
Todo se prueba con mocks de viem (patrón `debit-executor.test.ts`). **Testnet-only (CD-6).**

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/adapters/escrow/abi.ts` | Modificar (additive) | W0 |
| 2 | `src/adapters/escrow/arbiter-executor.ts` | **Crear** | W0 (tipos + `deriveArbiterNonce`) + W1 (executors/clients) |
| 3 | `src/adapters/escrow-verifier.ts` | Modificar (+`readArbitrationConsent`) | W1 |
| 4 | `src/services/arbiter.ts` | Modificar (3 puntos de wire + `isEscrowArbiterEnabled` + seam) | W2 |
| 5 | `src/adapters/escrow/arbiter-executor.test.ts` | **Crear** | W3 |
| 6 | `src/services/arbiter.test.ts` | Crear (o extender el existente si aparece) | W3 |

**PROHIBIDO tocar cualquier otro archivo.** En particular: NADA en `contracts/**`, ni
`rules.ts`/`llm-classifier.ts`/`evidence.ts`/`dashboard.html`, ni `resolveHold`, ni
`debit-executor.ts`, ni `payment-intent.ts` (se importan tal cual, sin modificar).

**Sin migraciones. Sin dependencias nuevas.** La telemetría del lock es logging estructurado.

---

## 3. Anti-Hallucination Checklist (específico de esta HU)

Antes de escribir código, confirmá que existen (ya verificado por el Architect; no re-inventar):

- [x] `ESCROW_ABI` es un array `as const` en `src/adapters/escrow/abi.ts:19-71` con hoy
      `Deposited`/`Debited`/`deposit`/`debit`/`escrowBalance`. Se le AGREGAN entradas, no se
      reordenan ni renombran las existentes.
- [x] Firmas byte-a-byte a copiar desde `contracts/src/interfaces/IWasiAIEscrow.sol`:
      eventos `:24-28`, funciones `:84-94`.
- [x] `Hop1Outcome` (unión `confirmed`/`not_moved`/`ambiguous`) vive en
      `src/adapters/escrow/debit-executor.ts:57-60` — es la **forma exacta** a espejar.
- [x] `getEscrowWalletClient` de `debit-executor.ts:74-99` lee `process.env.OPERATOR_PRIVATE_KEY`
      (`:77`). **NO reusar.** El árbitro necesita su propio cache leyendo `ARBITER_PRIVATE_KEY`.
- [x] `parseAbiItem` para derivar topic0 del evento: patrón `debit-executor.ts:53-55`. NUNCA
      hardcodear el hash del evento.
- [x] `resolveEscrowContract(chainKey)` EXPORTADA en `escrow-verifier.ts:94-101`. `getEscrowClient`
      es privada al mismo archivo (`:107-118`) → `readArbitrationConsent` (nueva, mismo archivo)
      la usa directamente. `_resetEscrowVerifier` `:121-123`.
- [x] `keccak256(stringToBytes(keyId))` es la derivación canónica del `bytes32 keyId`
      (`debit-capture.ts:172`); `parseUnits(usd.toString(), decimals)` para el atómico (`:173`);
      `decimals` de `getAdaptersBundle(chainKey)?.payment.supportedTokens[0]` (`:129/:164`).
- [x] `getDefaultChainKey`, `getAdaptersBundle` importables de `../registry.js` (patrón
      `debit-capture.ts:24`). El escrow opera sobre la default chain (no hay map chainId→ChainKey).
- [x] `SettleOutcome` (interface) vive en `src/types/index.ts:1228`
      (`status:'settled'|'failed'|'in_progress'`, `txHash`, `finalAmountUsd`, `error?`,
      `failureKind?`). El seam nuevo devuelve ESTA forma.
- [x] `settlePaymentIntentOnChain` ya está importado en `arbiter.ts:35` desde `./payment-intent.js`.
- [x] `isEscrowSettleEnabled` (`debit-capture.ts:69`) es el **espejo del gate** a copiar; el flag
      nuevo se llama `ESCROW_ARBITER_ENABLED` (patrón `=== 'true'` exacto).
- [x] `OpenDisputeRow` (`arbiter.ts:302-311`) y `ArbCloseRow` (`arbiter.ts:312-323`) AMBOS tienen
      `key_id: string`, `chain_id: number`, `pay_to: string`, `authorized_usd: number`. El wire
      usa estos campos ya presentes — sin selects nuevos.
- [x] `upsertArbitrationRow` (`arbiter.ts:261-299`) es el patrón best-effort `try/catch`+`log.warn`
      a copiar para lock/release.
- [x] `encodePacked` y `keccak256` existen en `viem` (verificado en `node_modules/viem`).
- [x] Punto de swap exacto: `arbiter.ts:546-552` (la ÚNICA llamada `settlePaymentIntentOnChain`
      en `executeArbitration`). Rama refund: `:523-543`. Best-effort lock: dentro de
      `resolveDispute` servicio, `:396`+ (tras tener `row`).

---

## 4. Constraint Directives (inline — heredados del work-item + SDD)

### OBLIGATORIO

- **CD-1 (triple gate)**: `ESCROW_ARBITER_ENABLED === 'true'` **AND**
  `resolveEscrowContract(chainKey) !== null` **AND**
  `readArbitrationConsent(chainKey, keyIdHash) === true`. Faltando cualquiera →
  `settlePaymentIntentOnChain(base)` **byte-idéntico**. Espejo de `settleEscrowAware`.
- **CD-2 (no-break WKH-139/189)**: el wire es ADITIVO. NO tocar
  `rules.ts`/`llm-classifier.ts`/`evidence.ts`/`dashboard.html`/`resolveHold`. Las ramas
  settled/unequivocal/ambiguous de `executeArbitration` **no cambian de forma**: el seam
  devuelve un `SettleOutcome` que entra en ellas sin modificarlas.
- **CD-3 (nonce disjunto)**: usar `deriveArbiterNonce` (§7). PROHIBIDO cualquier derivación que
  pueda colisionar con un nonce de `debit()`. Bit 255 SIEMPRE seteado.
- **CD-4 (re-verify on-chain)**: mismo patrón `debit-executor.ts:181-233` — timeout/RPC →
  `ambiguous`; revert (`status !== 'success'`) → `not_moved`; receipt-success SIN evento
  matcheado → `ambiguous`. NUNCA asumir movimiento. `resolveDispute` verifica
  `DisputeResolved(keyId,…,nonce)`; `lockForDispute` verifica `DisputeLocked(keyId,…)`;
  `releaseDispute` verifica `DisputeReleased(keyId,…)`.
- **CD-5 (wallet dedicada)**: el wallet client SOLO deriva de `ARBITER_PRIVATE_KEY`. Cache propio
  (Maps NUEVOS en `arbiter-executor.ts`). PROHIBIDO reusar `getEscrowWalletClient` de
  `debit-executor.ts` (lee `OPERATOR_PRIVATE_KEY`). Sin la env / RPC → `not_moved` (nunca lanza).
- **CD-6 (best-effort)**: `lockForDispute` y `releaseDispute` son best-effort: outcome logueado,
  un fallo NO bloquea ni lanza en el flujo del árbitro (`try/catch`, patrón `upsertArbitrationRow`).
- **CD-7 (consent silencioso)**: `readArbitrationConsent` devuelve `false` ante cualquier
  error/RPC-null; `false` → fallback silencioso. PROHIBIDO error/warning ruidoso o bloqueo (es el
  estado esperado hasta la HU de captura de consent).
- **ABI convergente byte-a-byte** con `IWasiAIEscrow.sol`; topic0 de eventos por `parseAbiItem`
  (NUNCA literal).
- **On-chain autoritativo**: nunca reportar `confirmed` sin re-verificar el evento correspondiente.

### PROHIBIDO

- NO tocar `contracts/**` ni proponer cambios de Solidity (191f congelado).
- NO deployar / `setArbiter()` / migrar (191h, Scope OUT).
- NO invocar `setArbitrationConsent` (191g solo consulta el view).
- NO reusar `OPERATOR_PRIVATE_KEY` para llamadas `onlyArbiter` (CD-5).
- NO agregar dependencias ni migraciones.
- NO clonar el money-path de `executeArbitration`; reusar el seam (CD-2).
- NO cerrar tests con `expect(true).toBe(true)` (CD-AB-4).
- NO alcanzar mainnet con ninguna llamada on-chain (testnet-only, CD-6).

### CD-AB — Auto-Blindaje (patrones de error recurrentes del epic 191)

- **CD-AB-1**: usar `./node_modules/.bin/biome`, NUNCA `npx biome` (191b#1).
- **CD-AB-2**: en tests, todo `vi.fn` que reciba args va tipado (`vi.fn((_a: unknown) => …)`) y
  los resolvers `T|null` con retorno anotado (`vi.fn((): string|null => …)`) — mocks a 0 args
  rompen `tsc` (191b#2/#3, recurrente ≥2 HUs).
- **CD-AB-3**: todo símbolo (clase de error, fixture) consumido por una factory `vi.mock` va
  dentro de `vi.hoisted` o de la propia factory — `vi.mock` es hoisted (191c#1).
- **CD-AB-4**: nunca cobertura tautológica; toda cross-ref a otro test se verifica con `grep`
  antes de commitear (191b#4).
- **CD-AB-5 (money-path 2 hops)**: el determinismo del nonce (§7) + el status-gate DB de
  `close_payment_intent_for_arbitration` son las barandas de exactly-once; el executor
  re-verifica el evento ANTES de reportar `confirmed`; nunca marcar un side-effect como aplicado
  sin evidencia on-chain (191c#2).

---

## 5. Waves — archivos exactos por wave

### Wave 0 (Serial Gate) — contratos/tipos, sin lógica de red

**W0.1 — extender `ESCROW_ABI` en `src/adapters/escrow/abi.ts`** (additive; convergencia
byte-a-byte con `IWasiAIEscrow.sol:24-28,84-94`). Agregar al array `as const`, DESPUÉS de las
entradas existentes:

- 3 eventos:
  - `DisputeLocked(bytes32 indexed keyId, address indexed arbiter, uint256 amount, uint256 totalLocked)`
  - `DisputeResolved(bytes32 indexed keyId, address indexed arbiter, address indexed seller, uint256 sellerAmount, uint256 nonce)`
  - `DisputeReleased(bytes32 indexed keyId, address indexed arbiter, uint256 releasedAmount)`
- 5 funciones:
  - `lockForDispute(bytes32 keyId, uint256 amount)` — `nonpayable`, sin outputs
  - `resolveDispute(bytes32 keyId, address seller, uint256 sellerAmount, uint256 nonce)` — `nonpayable`, sin outputs
  - `releaseDispute(bytes32 keyId)` — `nonpayable`, sin outputs
  - `arbitrationConsent(bytes32 keyId)` — `view`, returns `bool`
  - `lockedAmount(bytes32 keyId)` — `view`, returns `uint256`

  > Forma viem exacta a seguir: mirar cómo están declarados `Debited` (evento, `abi.ts:31-40`) y
  > `debit`/`escrowBalance` (funciones, `abi.ts:51-70`). Respetar orden de args y flags `indexed`
  > tal cual el Solidity. `DisputeResolved` tiene **3** args `indexed` (keyId, arbiter, seller).

**W0.2 — esqueleto de tipos + `deriveArbiterNonce` en `src/adapters/escrow/arbiter-executor.ts`**
(crear archivo; en W0 solo la parte PURA, sin viem clients):

- Uniones de outcome, misma forma que `Hop1Outcome` (`debit-executor.ts:57-60`). Reusar
  directamente `Hop1Outcome` importándolo, o declarar alias locales `LockOutcome`/`ResolveOutcome`/
  `ReleaseOutcome` idénticos en forma. **Recomendado: reusar `Hop1Outcome`** (misma forma, menos
  superficie).
- `deriveArbiterNonce(keyIdHash: string, intentId: string): bigint` — **función pura exportada**
  (unit-testeable). Fórmula EXACTA (§7). Usa `keccak256` + `encodePacked` de `viem`.
- `isEscrowArbiterEnabled(): boolean` → **vive en `arbiter.ts`** (W2), no acá; declararlo en W2.

- Verificación W0: `./node_modules/.bin/tsc --noEmit`.

### Wave 1 (Parallelizable) — módulos aislados

**W1.1 — completar `src/adapters/escrow/arbiter-executor.ts`** (espejo directo de
`debit-executor.ts:62-234`):

- Cache de clients per-`ChainKey` con Maps **nuevos** (`_arbiterWalletClients`,
  `_arbiterPublicClients`).
- `getArbiterWalletClient(chainKey)` — copia de `getEscrowWalletClient` (`:74-99`) pero leyendo
  `process.env.ARBITER_PRIVATE_KEY` (CD-5). Sin la env / sin RPC → `null`.
- `getArbiterPublicClient(chainKey)` — idéntico a `getEscrowPublicClient` (`:102-118`), cache propio.
- Reusar `getEscrowReceiptTimeoutMs()` importándolo de `./debit-executor.js` (o replicar con env
  propia si preferís aislar; **recomendado importar** para no duplicar). El timeout THROWS → `ambiguous`.
- `parseAbiItem` para cada evento (3 constantes tipo `DEBITED_EVENT`, `debit-executor.ts:53-55`):
  `DISPUTE_LOCKED_EVENT`, `DISPUTE_RESOLVED_EVENT`, `DISPUTE_RELEASED_EVENT`.
- 3 executors, cada uno con el contrato write→receipt→verify-event→outcome, **NUNCA lanzan**
  (mismo esqueleto que `executeDebitHop1`, `:137-234`):
  - `executeLockForDispute({ chainKey, escrowContract, keyIdHash, amount })` → verifica
    `DisputeLocked` (match por `keyId`).
  - `executeResolveDispute({ chainKey, escrowContract, keyIdHash, seller, sellerAmount, nonce })`
    → verifica `DisputeResolved` (match por `keyId` **y** `nonce`).
  - `executeReleaseDispute({ chainKey, escrowContract, keyIdHash })` → verifica `DisputeReleased`
    (match por `keyId`).
  - Cada uno: sin wallet/public client → `not_moved` (`ARBITER_KEY_OR_RPC_UNSET`); writeContract
    throw → `not_moved` (`WRITE_FAILED`); receipt timeout → `ambiguous` (`RECEIPT_TIMEOUT`);
    `status !== 'success'` → `not_moved` (`REVERTED`); evento no matcheado → `ambiguous`
    (`<EVENT>_NOT_FOUND`).
- `_resetArbiterExecutor()` (TEST-ONLY, limpia ambos Maps; patrón `_resetDebitExecutor`,
  `debit-executor.ts:128-131`).

**W1.2 — `readArbitrationConsent(chainKey: ChainKey, keyIdHash: string): Promise<boolean>` en
`src/adapters/escrow-verifier.ts`** (CD-7):

- Reusar `resolveEscrowContract(chainKey)` + `getEscrowClient(chainKey)` (privadas del mismo archivo).
- `readContract({ address, abi: ESCROW_ABI, functionName: 'arbitrationConsent', args: [keyIdHash] })`.
- **Cualquier** error / contrato-null / RPC-null → `return false` (try/catch total; sin warn ruidoso).

- Verificación W1: `tsc` + unit de W1.1.

### Wave 2 (Integración) — el wire en `arbiter.ts` (depende W0+W1)

**W2.0 — `isEscrowArbiterEnabled(): boolean`** en `arbiter.ts` (junto a `isArbiterEnabled`,
`:66`): `return process.env.ESCROW_ARBITER_ENABLED === 'true';`

**W2.1 — seam `settleArbitrationOnChain`** (nueva función en `arbiter.ts`, espejo de
`settleEscrowAware` de `payment-intent.ts:500-542`), firma que devuelve `SettleOutcome`:

```
settleArbitrationOnChain({ intentId, ownerRef, payTo, finalAmountUsd, chainId, keyId }):
  base = { intentId, ownerRef, payTo, finalAmountUsd, chainId }
  try:
    0. if !isEscrowArbiterEnabled()             -> return settlePaymentIntentOnChain(base)   // AC-1
    1. chainKey = getDefaultChainKey(); if !chainKey -> settlePaymentIntentOnChain(base)
    2. escrow = resolveEscrowContract(chainKey); if !escrow -> settlePaymentIntentOnChain(base)  // AC-1
    3. keyIdHash = keccak256(stringToBytes(keyId))
       if !(await readArbitrationConsent(chainKey, keyIdHash)) -> settlePaymentIntentOnChain(base)  // AC-2/CD-7
    4. decimals = getAdaptersBundle(chainKey)?.payment.supportedTokens[0]?.decimals
       if decimals == null -> settlePaymentIntentOnChain(base)
       sellerAmount = parseUnits(finalAmountUsd.toString(), decimals)
       nonce = deriveArbiterNonce(keyIdHash, intentId)                                        // CD-3
    5. o = await executeResolveDispute({ chainKey, escrowContract: escrow, keyIdHash,
                                         seller: payTo, sellerAmount, nonce })
       confirmed -> { status:'settled', txHash:o.txHash, finalAmountUsd }
       not_moved -> { status:'failed', txHash:null, finalAmountUsd, error:o.reason, failureKind:'unequivocal' }  // AC-6
       ambiguous -> { status:'failed', txHash:null, finalAmountUsd, error:o.reason, failureKind:'ambiguous' }    // AC-6
  catch(any) -> return settlePaymentIntentOnChain(base)   // CD-7: jamás rompe el flujo del árbitro
```

**Swap en `executeArbitration` (línea 546-552)**: reemplazar la ÚNICA llamada
`settlePaymentIntentOnChain({ intentId, ownerRef, payTo: row.pay_to, finalAmountUsd: arbUsd,
chainId: row.chain_id })` por `settleArbitrationOnChain({ intentId, ownerRef, payTo: row.pay_to,
finalAmountUsd: arbUsd, chainId: row.chain_id, keyId: row.key_id })`. **NADA MÁS cambia** en las
ramas settled/unequivocal/ambiguous (`:554-641`) → exactly-once heredado, `resolveHold` heredado
(`:1011` delega en `executeArbitration`).

**W2.2 — best-effort `lockForDispute`** en el método `resolveDispute` (servicio), tras tener `row`
(`arbiter.ts:396`+, ANTES de la clasificación). UNA sola vez por transición. Helper local
best-effort (patrón `upsertArbitrationRow`, `:261-299`):

```
if isEscrowArbiterEnabled():
  chainKey = getDefaultChainKey()
  escrow   = chainKey ? resolveEscrowContract(chainKey) : null
  if chainKey && escrow:
    keyIdHash = keccak256(stringToBytes(row.key_id))
    if await readArbitrationConsent(chainKey, keyIdHash):        // triple gate CD-1
      decimals = getAdaptersBundle(chainKey)?.payment.supportedTokens[0]?.decimals
      if decimals != null:
        amount = parseUnits(row.authorized_usd.toString(), decimals)   // DEPOSIT TOTAL, no settleUsd
        o = await executeLockForDispute({ chainKey, escrowContract: escrow, keyIdHash, amount })
        log.info({ intentId, kind:o.kind, ... }, 'arbiter lockForDispute outcome')
  // TODO envuelto en try/catch: un throw NUNCA aborta resolveDispute (CD-6)
```

> El lock cubre auto-resolve inmediato Y `arb_hold` porque `resolveDispute` (servicio) es el único
> funnel post-transición para AMBOS caminos.

**W2.3 — best-effort `releaseDispute`** en la rama refund de `executeArbitration`
(`arbMicro <= 0`, `:523`), ANTES o DESPUÉS de los `recordSettleOutcome`/`finalizePaymentIntent`
existentes (no los reemplaza — CD-2). Mismo gate y helper best-effort que W2.2, invocando
`executeReleaseDispute({ chainKey, escrowContract, keyIdHash })`. Un fallo se loguea y NO altera
el refund off-chain de hoy.

- Verificación W2: `tsc` + suite arbiter.

### Wave 3 (Final) — tests + gates

**W3.1 — `src/adapters/escrow/arbiter-executor.test.ts`** (crear; espejo de
`debit-executor.test.ts:1-90`): mockear `createWalletClient`/`createPublicClient` de viem con
`importOriginal` (preservar `keccak256`/`stringToBytes`/`parseAbiItem`/`decodeEventLog`/
`encodePacked`); `privateKeyToAccount` real. Ver §8 casos.

**W3.2 — tests del wire** (`src/services/arbiter.test.ts` o el existente; grep primero con
`grep -rn "arbiter" src/services/*.test.ts`): mockear `arbiter-executor.js` (las 3 executors +
`deriveArbiterNonce` real o pass-through), `escrow-verifier.js` (`readArbitrationConsent`,
`resolveEscrowContract`), y el flag por env. Ver §8 casos.

- Verificación W3: `tsc` + `vitest` full + `./node_modules/.bin/biome check` (CD-AB-1).

---

## 6. Patrones a seguir (exemplars verificados)

| Para | Seguir | Path:línea |
|------|--------|-----------|
| Unión de outcome + "nunca lanza" | `Hop1Outcome` + `executeDebitHop1` | `debit-executor.ts:57-60,137-234` |
| Cache wallet/public client per-ChainKey | `getEscrowWalletClient`/`getEscrowPublicClient` (leyendo `ARBITER_PRIVATE_KEY`, NO `OPERATOR_`) | `debit-executor.ts:74-118` |
| topic0 vía `parseAbiItem` | `DEBITED_EVENT` | `debit-executor.ts:53-55` |
| re-verify evento en `receipt.logs` | loop `decodeEventLog` + match keyId(+nonce) | `debit-executor.ts:200-230` |
| `_reset*` test-only | `_resetDebitExecutor` | `debit-executor.ts:128-131` |
| view via publicClient cacheado | `getEscrowClient` + `resolveEscrowContract` | `escrow-verifier.ts:94-118` |
| gate en cascada → fallback byte-idéntico | `settleEscrowAware` / `isEscrowSettleEnabled` | `payment-intent.ts:500-542`, `debit-capture.ts:69` |
| keyIdHash + atómico | `keccak256(stringToBytes(keyId))` / `parseUnits(usd.toString(), decimals)` | `debit-capture.ts:172-173` |
| best-effort try/catch + log.warn | `upsertArbitrationRow` | `arbiter.ts:261-299` |
| flag `=== 'true'` | `isArbiterEnabled` | `arbiter.ts:66` |
| mock viem en test | `vi.mock('viem', importOriginal)` + `mockWriteContract`/`mockWaitForReceipt` | `debit-executor.test.ts:26-38` |

---

## 7. `deriveArbiterNonce` — fórmula EXACTA (CD-3, §5 del SDD)

Función **pura, exportada** de `arbiter-executor.ts`, unit-testeable:

```ts
// FLAG bit 255 reservado al árbitro; el cliente de debit usa [0, 2^255)
const ARBITER_NONCE_FLAG = 1n << 255n;
const ARBITER_NONCE_LOW_MASK = (1n << 255n) - 1n;

export function deriveArbiterNonce(keyIdHash: string, intentId: string): bigint {
  const digest = keccak256(
    encodePacked(
      ['string', 'bytes32', 'string'],
      ['WasiAIEscrow.arbiter-dispute.v1', keyIdHash as `0x${string}`, intentId],
    ),
  );
  return ARBITER_NONCE_FLAG | (BigInt(digest) & ARBITER_NONCE_LOW_MASK);
  // resultado SIEMPRE en [2^255, 2^256)
}
```

**Garantías** (no re-derivar de otra forma):
1. Bit 255 SIEMPRE seteado → rango `[2^255, 2^256)` reservado (disjunto del cliente honesto de `debit`).
2. Digest keccak uniforme sobre los 255 bits bajos → P(colisión) = 2⁻²⁵⁵ (negligible, mismo orden EIP-712).
3. **Determinista** en `(keyIdHash, intentId)` → misma disputa ⇒ mismo nonce ⇒ retry produce el
   MISMO nonce ⇒ el guard `NonceAlreadyUsed` hace el doble-resolve `not_moved` (money-safe,
   exactly-once). PROHIBIDO salt/contador por-intento (rompería exactly-once).

---

## 8. Tests requeridos (mocks tipados — CD-AB-2/3/4)

### `arbiter-executor.test.ts` (mocks viem)

| Test | AC/CD | Caso |
|------|-------|------|
| `executeResolveDispute` happy | AC-4/CD-4 | `DisputeResolved(keyId,nonce)` matcheado → `confirmed` (txHash + blockNumber) |
| revert | CD-4 | `receipt.status !== 'success'` → `not_moved` (`REVERTED`) |
| timeout | AC-6/CD-4 | `waitForTransactionReceipt` throws → `ambiguous` (`RECEIPT_TIMEOUT`) |
| receipt success sin evento | AC-6/CD-4 | logs sin `DisputeResolved` matcheado → `ambiguous` |
| sin `ARBITER_PRIVATE_KEY` / sin RPC | AC-8/CD-5 | `not_moved` (`ARBITER_KEY_OR_RPC_UNSET`), NUNCA lanza |
| writeContract throw pre-broadcast | CD-4 | `not_moved` (`WRITE_FAILED`) |
| idempotencia | §7/CD-AB-5 | 2ª `executeResolveDispute` mismo nonce → revert mockeado `NonceAlreadyUsed` → `not_moved` |
| `executeLockForDispute` / `executeReleaseDispute` | AC-3/AC-5/CD-4 | happy (evento matcheado → `confirmed`) + revert → `not_moved` |
| `deriveArbiterNonce` | AC-4/CD-3 | (a) bit 255 seteado; (b) determinista (2 llamadas iguales ⇒ igual); (c) distinto para (keyId,intentId) distinto; (d) `>= 2n**255n` (disjunto del rango de debit de muestra) |

### wire en `arbiter.test.ts` (mockear `arbiter-executor.js` + `escrow-verifier.js` + env flag)

| Test | AC/CD | Caso |
|------|-------|------|
| flag OFF → `settlePaymentIntentOnChain`, cero on-chain | AC-1/AC-7 | `ESCROW_ARBITER_ENABLED` unset; assert `executeResolveDispute` NO llamado |
| escrow no configurado (`resolveEscrowContract===null`) → fallback | AC-1 | flag ON, escrow null |
| flag ON + escrow + `consent===false` → fallback, sin `executeResolveDispute` | AC-2/CD-7 | |
| flag ON + escrow + `consent===true` + release/split → `executeResolveDispute(seller, sellerAmount, nonce)` | AC-4 | assert args: seller=`pay_to`, nonce=`deriveArbiterNonce(...)` |
| refund (`arbMicro<=0`) → `executeReleaseDispute`, NO `resolveDispute` | AC-5 | |
| transición a `disputed` → `executeLockForDispute` UNA vez por deposit total | AC-3 | amount = `parseUnits(authorized_usd)` |
| lock/release fallan → logueado, la resolución NO se rompe | CD-6 | executor devuelve `not_moved`/throw; el outcome del árbitro es idéntico al happy off-chain |
| `resolveDispute` on-chain `not_moved` → `failureKind:'unequivocal'` (refund off-chain intacto) | AC-6 | rama `:584` inalterada |
| `resolveDispute` on-chain `ambiguous` → `failed_ambiguous` + RECONCILE | AC-6 | rama `:615` inalterada |

> Sin `expect(true).toBe(true)` (CD-AB-4). Mocks tipados (CD-AB-2). Símbolos de factory `vi.mock`
> en `vi.hoisted` o dentro de la factory (CD-AB-3). Verificar cross-refs con `grep` antes de commit.

---

## 9. Done Definition

- [ ] `abi.ts` extendido con 5 funciones + 3 eventos, byte-a-byte con `IWasiAIEscrow.sol` (W0.1).
- [ ] `arbiter-executor.ts` creado: 3 executors (nunca lanzan, re-verifican evento), clients
      cacheados desde `ARBITER_PRIVATE_KEY`, `deriveArbiterNonce` pura exportada, `_resetArbiterExecutor`.
- [ ] `readArbitrationConsent` en `escrow-verifier.ts`: view, error/RPC-null → `false` silencioso.
- [ ] `isEscrowArbiterEnabled` + seam `settleArbitrationOnChain` + swap línea 546 + best-effort
      `lockForDispute` (W2.2) + best-effort `releaseDispute` (W2.3), todo triple-gate CD-1.
- [ ] Ramas settled/unequivocal/ambiguous de `executeArbitration` y `resolveHold` **sin cambios de forma**.
- [ ] Tests: `arbiter-executor.test.ts` + wire tests, todos los casos §8, mocks tipados.
- [ ] `./node_modules/.bin/tsc --noEmit` limpio.
- [ ] `vitest` full verde.
- [ ] `./node_modules/.bin/biome check` limpio (CD-AB-1).
- [ ] NADA tocado en `contracts/**`, `rules.ts`, `llm-classifier.ts`, `evidence.ts`,
      `dashboard.html`, `resolveHold`, `debit-executor.ts`, `payment-intent.ts`.
- [ ] Sin migraciones, sin dependencias nuevas.
- [ ] Con flag OFF / sin consent (default): comportamiento byte-idéntico al de hoy (AC-7).

---

*Story File generado por NexusAgil — Architect F2.5. Contrato autocontenido; el Dev solo lee este archivo.*
