# SDD #178: [WKH-191g] Wire de `arbiter.ts` al contrato `WasiAIEscrow` (rol arbiter)

> SPEC_APPROVED: no
> Fecha: 2026-07-13
> Tipo: feature
> SDD_MODE: full
> Branch: feat/191g-arbiter-onchain-wire
> Artefactos: doc/sdd/178-wkh-191g-arbiter-onchain-wire/
> Epic: WKH-191 (fila 172) · Wave 1 (HU 7/8) · depende de 191f (fila 177, DONE·UPGRADE-PENDING)

---

## 1. Resumen

`WasiAIEscrow.sol` (191f, congelado) ya expone las funciones on-chain que el árbitro
necesita para mover fondos escrow-custodiados SIN firma del buyer: `lockForDispute`,
`resolveDispute(keyId,seller,sellerAmount,nonce)`, `releaseDispute` — todas `onlyArbiter`
y gateadas por `arbitrationConsent(keyId)`. Hoy `src/services/arbiter.ts` resuelve TODO
sobre el `budget` off-chain vía `settlePaymentIntentOnChain` (operator-custodial). Esta HU
**cablea el camino on-chain en paralelo y flag-gated**, sin tocar Solidity ni romper
WKH-139 v2 (auto-resolve) ni WKH-189 (override admin):

- al transicionar un intent a `'disputed'` → best-effort `lockForDispute` por el deposit total;
- al resolver `release`/`split` (`settleUsd > 0`) → `resolveDispute` en vez del settle custodial;
- al resolver `refund` (`settleUsd <= 0`) → best-effort `releaseDispute` (libera el lock).

**Code-complete pero INERTE**: sin `ARBITER_PRIVATE_KEY`, sin `setArbiter()` on-chain (191h,
Scope OUT) toda llamada `onlyArbiter` revierte `NotArbiter` → `not_moved`, y sin flujo de
captura de consentimiento (gap DT-3, Scope OUT) el view `arbitrationConsent(keyId)` es `false`
para el 100% de los keyIds → el sistema cae SIEMPRE al fallback operator-custodial (correcto).
Testeable con mocks de viem (patrón `debit-executor.test.ts`). Testnet-only (CD-6).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 178 (WKH-191g) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Cablear `arbiter.ts` a `lockForDispute`/`resolveDispute`/`releaseDispute` del escrow, flag-gated, en paralelo byte-idéntico al path custodial actual |
| **Reglas de negocio** | Triple gate (flag + escrow-en-chain + consent==true); wallet dedicada `ARBITER_PRIVATE_KEY`; on-chain autoritativo; nonce en namespace disjunto del de `debit()`; best-effort (nunca rompe la resolución) |
| **Scope IN** | `src/adapters/escrow/abi.ts`, nuevo `src/adapters/escrow/arbiter-executor.ts`, `src/adapters/escrow-verifier.ts` (view consent), `src/services/arbiter.ts` (3 puntos de wire) + tests |
| **Scope OUT** | `contracts/**` (191f), deploy/`setArbiter()` (191h), captura de `setArbitrationConsent` (gap DT-3), reconciliación de lock huérfano, mainnet |
| **Missing Inputs** | 191h no corrió (bloqueante de EJECUCIÓN, no de código); flujo de consent no existe (fallback correcto) |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN `ESCROW_ARBITER_ENABLED != 'true'` OR `resolveEscrowContract(chainKey) === null`, THE system SHALL resolver la disputa byte-idénticamente al path actual (`settlePaymentIntentOnChain` sobre budget off-chain), sin invocar ninguna función `onlyArbiter`.
- **AC-2**: WHEN el flag está ON y hay escrow en la chain, THE system SHALL consultar `arbitrationConsent(keyId)` (view, sin gas) ANTES de cualquier leg on-chain, y SHALL caer al path custodial si el resultado es `false`.
- **AC-3**: WHEN un intent transiciona a `'disputed'` bajo AC-2 con consent `true`, THE system SHALL invocar `lockForDispute(keyId, deposit_atomic)` best-effort EXACTAMENTE UNA VEZ por transición (cubre auto-resolve y `arb_hold`), registrando el outcome sin bloquear la resolución si el lock falla.
- **AC-4**: WHEN `executeArbitration` resuelve `release`/`split` (`settleUsd > 0`) bajo AC-2/AC-3, THE system SHALL invocar `resolveDispute(keyId, seller, sellerAmount, nonce)` en vez de `settlePaymentIntentOnChain`, con un `nonce` en namespace que NUNCA colisiona con los de `debit()`/`debitBatch()` sobre el mismo `keyId`.
- **AC-5**: WHEN `executeArbitration` resuelve `refund` (`settleUsd <= 0`) bajo las mismas condiciones, THE system SHALL invocar `releaseDispute(keyId)` best-effort en vez de dejar el lock huérfano.
- **AC-6**: IF cualquier leg on-chain resulta `ambiguous` (timeout receipt / RPC caído tras broadcast), THEN THE system SHALL mapearlo al `failureKind: 'ambiguous'` existente (→ `failed_ambiguous` / RECONCILE) y SHALL NOT asumir movimiento ni reintentar en el mismo request.
- **AC-7 (no-break)**: IF el wire no está operante (flag OFF / sin escrow / sin consent / `NotArbiter`), THEN THE system SHALL resolver disputas (auto WKH-139 v2 y override WKH-189) exactamente como hoy, sin cambio observable.
- **AC-8 (ubicuo)**: THE system SHALL firmar toda llamada `onlyArbiter` EXCLUSIVAMENTE con la wallet de `ARBITER_PRIVATE_KEY` — NUNCA `OPERATOR_PRIVATE_KEY`.

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `contracts/src/WasiAIEscrow.sol:104-288` | firmas/guards reales de las funciones a llamar | `onlyArbiter` → `NotArbiter`; `lockForDispute` incremental valida `newLocked<=balance`; `resolveDispute` valida consent + `sellerAmount<=locked` + `sellerAmount<=balance` + `!_usedNonces[keyId][nonce]` (CEI, paga al `seller`, no a msg.sender); `releaseDispute` requiere `locked>0` |
| `contracts/src/interfaces/IWasiAIEscrow.sol:21-94` | firmas byte-a-byte para extender el ABI TS | eventos `DisputeLocked(keyId,arbiter,amount,totalLocked)`, `DisputeResolved(keyId,arbiter,seller,sellerAmount,nonce)`, `DisputeReleased(keyId,arbiter,releasedAmount)`; funciones exactas |
| `src/adapters/escrow/debit-executor.ts:1-234` | **exemplar directo** del executor a espejar | wallet/public client cacheados per-`ChainKey`; `writeContract` catch→`not_moved`; `waitForTransactionReceipt` timeout→`ambiguous`; `status!=='success'`→`not_moved`; receipt-success-sin-evento→`ambiguous`; unión `Hop1Outcome`; nunca lanza; `parseAbiItem` para el topic0 |
| `src/adapters/escrow/abi.ts:19-71` | array `ESCROW_ABI as const` a extender | forma viem de function/event; hoy solo `Deposited`/`Debited`/`deposit`/`debit`/`escrowBalance` |
| `src/adapters/escrow-verifier.ts:94-118` | `resolveEscrowContract` + `getEscrowClient` cacheado a reusar para el view consent | resolver por `A2A_ESCROW_CONTRACT_<FAMILY>`; publicClient lazy per-ChainKey; `_resetEscrowVerifier` |
| `src/adapters/escrow/debit-capture.ts:162-173` | derivación canónica de keyId + atómico | `keyIdHash = keccak256(stringToBytes(keyId))`; `parseUnits(usd.toString(), token.decimals)`; `decimals` de `getAdaptersBundle(chainKey).payment.supportedTokens[0]` |
| `src/adapters/escrow/eip712.ts` + `src/routes/payments.ts:71` | esquema real del nonce de `debit()` (CD-3) | **el nonce de debit es `body.debitNonce`, un uint256 arbitrario SUPPLIED POR EL BUYER**, no server-generado ni range-bounded (ver DT-5) |
| `src/services/arbiter.ts:325-1012` | los 3 puntos de wire + choke-points | `openDispute`→`resolveDispute`(servicio, línea 391, único funnel post-transición)→`executeArbitration`(485); rama refund `arbMicro<=0`(523) no-op on-chain; rama release/split `arbMicro>0`(546) llama `settlePaymentIntentOnChain`; `resolveHold`(904) delega en `executeArbitration`(1011) → hereda el wire |
| `src/services/payment-intent.ts:363-539` | **exemplar del gate** (`settleEscrowAware`) + `SettleOutcome` | gate en cascada (flag→`getDefaultChainKey()`→`resolveEscrowContract`→…) delegando `settlePaymentIntentOnChain(base)` byte-idéntico en cada miss; `SettleOutcome{status,txHash,finalAmountUsd,error?,failureKind?}`; `usdToAtomic`/`parseUnits` + decimals del adapter |
| `src/adapters/registry.ts` (`getDefaultChainKey`, `getAdaptersBundle`) | el escrow opera sobre la **default chain** (no hay mapping chainId→ChainKey) | mismo `getDefaultChainKey()` que usan debit-capture/settleEscrowAware |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/adapters/escrow/arbiter-executor.ts` (nuevo) | `src/adapters/escrow/debit-executor.ts` | mismo contrato write→receipt→verify-event→outcome, cache de clients, "nunca lanza" |
| ABI ext en `abi.ts` | `IWasiAIEscrow.sol:79-94` + entradas `Debited`/`debit` ya presentes | convergencia byte-a-byte |
| `readArbitrationConsent` en `escrow-verifier.ts` | `getEscrowClient`/`resolveEscrowContract` del mismo archivo | reuso del publicClient cacheado |
| seam `settleArbitrationOnChain` en `arbiter.ts` | `settleEscrowAware` (payment-intent.ts:500-539) | gate en cascada → fallback byte-idéntico; devuelve `SettleOutcome` |

### Estado de BD relevante

| Tabla | Existe | Notas |
|-------|--------|-------|
| `a2a_payment_intents` | Sí | `authorized_usd`, `consumed_usd`, `pay_to`, `key_id`, `chain_id` — todo ya consumido por arbiter.ts |
| `a2a_arbitrations` | Sí | fila de auditoría (upsert best-effort); **sin columnas nuevas en 191g** (ver DT-6) |
| — | — | **NO hay migración en 191g** (telemetría del lock = logging estructurado, DT-6) |

### Componentes reutilizables

- `resolveEscrowContract`, `getEscrowClient`, `_resetEscrowVerifier` (escrow-verifier.ts) — reusar tal cual.
- `getDefaultChainKey`, `getAdaptersBundle` (registry.ts) — reusar tal cual.
- `SettleOutcome`, ramas settled/unequivocal/ambiguous de `executeArbitration` — **NO clonar**: el seam nuevo produce un `SettleOutcome` que entra en ellas sin tocarlas.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar | Wave |
|---------|--------|----------|----------|------|
| `src/adapters/escrow/abi.ts` | Modificar | +5 entradas function (`lockForDispute`, `resolveDispute`, `releaseDispute`, `arbitrationConsent` view, `lockedAmount` view) +3 event (`DisputeLocked`, `DisputeResolved`, `DisputeReleased`) | `IWasiAIEscrow.sol` | W0 |
| `src/adapters/escrow/arbiter-executor.ts` | Crear | wallet client `ARBITER_PRIVATE_KEY` cacheado per-ChainKey; `executeLockForDispute`/`executeResolveDispute`/`executeReleaseDispute` (write→receipt→verify-event→outcome, nunca lanzan); `deriveArbiterNonce` (pure); `_resetArbiterExecutor` | `debit-executor.ts` | W1 |
| `src/adapters/escrow-verifier.ts` | Modificar | +`readArbitrationConsent(chainKey, keyIdHash): Promise<boolean>` (view; cualquier error/RPC-null → `false`, CD-7) | `getEscrowClient`/`verifyEscrowDeposit` | W1 |
| `src/services/arbiter.ts` | Modificar | +`isEscrowArbiterEnabled()`; +best-effort `lockForDispute` en `resolveDispute` (servicio); +seam `settleArbitrationOnChain` swap en línea 546; +best-effort `releaseDispute` en rama refund (523) | `settleEscrowAware`/`isEscrowSettleEnabled` | W2 |
| `src/adapters/escrow/arbiter-executor.test.ts` | Crear | unit del executor + `deriveArbiterNonce` (mocks viem) | `debit-executor.test.ts` | W3 |
| `src/services/arbiter.test.ts` (o el existente) | Modificar/Crear | wire flag ON/OFF, consent T/F, cada rama | `debit-capture.test.ts` | W3 |

### 4.2 Modelo de datos

Sin cambios de schema. La telemetría del lock/resolve/release es logging estructurado
(DT-6). El `txHash` del `resolveDispute` confirmado fluye por el `SettleOutcome.txHash`
existente → persistido por `finalizePaymentIntent` + `receiptService.emit` (cero schema nuevo).

### 4.3 Componentes / Servicios — el seam `settleArbitrationOnChain`

Espejo exacto de `settleEscrowAware`. Firma idéntica en outputs a `settlePaymentIntentOnChain`
(devuelve `SettleOutcome`), para entrar sin fricción en las ramas ya probadas de
`executeArbitration`:

```
settleArbitrationOnChain({ intentId, ownerRef, payTo(seller), finalAmountUsd(arbUsd), chainId, keyId }):
  base = { intentId, ownerRef, payTo, finalAmountUsd, chainId }
  0. if !isEscrowArbiterEnabled()          -> return settlePaymentIntentOnChain(base)   // AC-1
  1. chainKey = getDefaultChainKey(); if null -> settlePaymentIntentOnChain(base)
  2. escrow  = resolveEscrowContract(chainKey); if null -> settlePaymentIntentOnChain(base)  // AC-1
  3. keyIdHash = keccak256(stringToBytes(keyId))
     if !(await readArbitrationConsent(chainKey, keyIdHash)) -> settlePaymentIntentOnChain(base) // AC-2/CD-7
  4. decimals = getAdaptersBundle(chainKey)?.payment.supportedTokens[0]?.decimals; if none -> seam
     sellerAmount = parseUnits(finalAmountUsd.toString(), decimals)
     nonce = deriveArbiterNonce(keyIdHash, intentId)                                     // CD-3
  5. o = await executeResolveDispute({ chainKey, escrowContract:escrow, keyIdHash, seller:payTo, sellerAmount, nonce })
     confirmed -> { status:'settled',  txHash:o.txHash, finalAmountUsd }
     not_moved -> { status:'failed', txHash:null, finalAmountUsd, error:o.reason, failureKind:'unequivocal' } // AC-6
     ambiguous -> { status:'failed', txHash:null, finalAmountUsd, error:o.reason, failureKind:'ambiguous'   } // AC-6
  catch(any) -> settlePaymentIntentOnChain(base)   // CD-7: jamás rompe el flujo del árbitro
```

Punto de wire en `executeArbitration` (línea 546): reemplazar la llamada única
`settlePaymentIntentOnChain({...})` por `settleArbitrationOnChain({...keyId: row.key_id})`.
**Nada más cambia** en las ramas settled/unequivocal/ambiguous → exactly-once heredado,
`resolveHold` heredado (delega en `executeArbitration`, línea 1011).

> **Nota money-book (documentada, no resuelta en 191g)**: cuando `resolveDispute` da
> `not_moved` (`unequivocal`), la maquinaria existente reembolsa el deposit COMPLETO en el
> **budget off-chain** (libro autoritativo, decisión del founder en 191c) y deja el lock
> on-chain sin liberar. Es money-SAFE (fondos del propio buyer, congelados pero recuperables)
> y coincide con el Scope OUT del work-item ("reconciliación de lock huérfano = seguimiento").

### 4.4 Flujo principal (Happy Path, con 191h ya activo y consent==true)

1. `openDispute` valida chain/ownership → `open_dispute` (anti-race) → intent `'disputed'`.
2. `resolveDispute` (servicio) ejecuta **best-effort `lockForDispute(keyIdHash, deposit_atomic)`** UNA vez (gate: flag+escrow+consent). Outcome logueado; un fallo NO aborta.
3. rules/llm → cap gate → `executeArbitration`.
4. desenlace `release`/`split` (`arbMicro>0`): `settleArbitrationOnChain` → `executeResolveDispute` → `DisputeResolved` verificado → `settled` → `finalize` + receipt con el txHash on-chain.
5. desenlace `refund` (`arbMicro<=0`): **best-effort `releaseDispute(keyIdHash)`** (libera el lock) + el `finalize`/refund off-chain de hoy.

### 4.5 Flujo de error

- flag OFF / sin escrow / consent false / sin `ARBITER_PRIVATE_KEY` / `NotArbiter` (191h no corrió) → fallback `settlePaymentIntentOnChain` byte-idéntico (AC-1/AC-2/AC-7).
- `resolveDispute` revierte (nonce usado / `ExceedsLockedAmount` / etc.) → `not_moved` → `failureKind:'unequivocal'` (buyer made whole off-chain).
- receipt timeout / RPC caído tras broadcast → `ambiguous` → `failed_ambiguous` + RECONCILE (AC-6).
- lock/release fallan → logging estructurado, la resolución continúa (best-effort, CD-7).

## 5. Esquema de nonce disjunto (DT-5 / CD-3) — decisión

**Hallazgo de F2 (grounding)**: el nonce de `debit()` es `body.debitNonce`
(`src/routes/payments.ts:71`), un **uint256 arbitrario provisto por el buyer** — NO
server-generado, NO acotado a un rango. Comparte `_usedNonces[keyId][nonce]` con
`resolveDispute` (`WasiAIEscrow.sol:55,276`). No existe partición por-valor 100%
estructural contra un buyer malicioso (puede firmar cualquier nonce).

**Esquema elegido** (`deriveArbiterNonce(keyIdHash, intentId): bigint`, función pura,
unit-testeable en `arbiter-executor.ts`):

```
FLAG      = 1n << 255n                          // bit 255 reservado al árbitro
LOW_MASK  = (1n << 255n) - 1n
digest    = keccak256(encodePacked(['string','bytes32','string'],
                       ['WasiAIEscrow.arbiter-dispute.v1', keyIdHash, intentId]))
nonce     = FLAG | (BigInt(digest) & LOW_MASK)  // siempre en [2^255, 2^256)
```

**Garantías de no-colisión (triple capa)**:

1. **Estructural (vs cliente honesto)** — todo nonce de árbitro tiene el bit 255 seteado;
   el rango `[2^255, 2^256)` queda RESERVADO. Convención documentada (mismo espíritu que la
   "delta convention" de `eip712.ts`): el cliente de referencia WasiAI genera nonces de
   `debit()` en `[0, 2^255)`. `[NEEDS CLARIFICATION → no bloqueante]`: como el nonce de debit
   hoy es buyer-supplied, esta convención constriñe al cliente de referencia/futuro, no es un
   enforcement on-chain. Se documenta como TD para el SDK del buyer.
2. **Probabilística (vs cualquier cliente, incl. malicioso que setee bit 255)** — los 255
   bits bajos son un digest keccak uniformemente distribuido; P(colisión con un nonce de
   debit específico) = 2⁻²⁵⁵, mismo orden que la seguridad EIP-712 que el propio contrato
   asume. Negligible.
3. **Determinismo → exactly-once (defensa en profundidad)** — el nonce depende SOLO de
   `(keyIdHash, intentId)`: la misma disputa siempre mapea al mismo nonce. Una re-invocación
   de `resolveDispute` para el mismo intent produce el MISMO nonce → el guard
   `NonceAlreadyUsed` del contrato hace el doble-resolve `not_moved` (money-safe). Es una
   segunda baranda SOBRE el exactly-once primario (status-gate DB de
   `close_payment_intent_for_arbitration`, que ya impide re-entrar la rama de settle).

**Por qué determinista (no salteado con contador)**: un salt por-intento haría que un retry
use un nonce distinto y podría **doble-pagar** si el 1er intento fue `ambiguous` pero
realmente se minó. El determinismo preserva la propiedad de exactly-once, prioritaria sobre
la resistencia a griefing (ver Riesgos R-3), especialmente en un path INERTE hasta 191h.

## 6. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-1 (triple gate)**: `ESCROW_ARBITER_ENABLED === 'true'` AND `resolveEscrowContract(chainKey) !== null` AND `readArbitrationConsent(keyIdHash) === true`. Faltando cualquiera → `settlePaymentIntentOnChain(base)` byte-idéntico. Espejo de `settleEscrowAware`.
- **CD-2 (no-break WKH-139/189)**: el wire es ADITIVO. NO tocar `rules.ts`/`llm-classifier.ts`/`evidence.ts`/`dashboard.html`/`resolveHold`. Las ramas settled/unequivocal/ambiguous de `executeArbitration` no cambian de forma.
- **CD-3 (nonce disjunto)**: usar `deriveArbiterNonce` (§5). PROHIBIDO cualquier derivación que pueda colisionar con un nonce de `debit()`.
- **CD-4 (re-verify on-chain)**: mismo patrón `debit-executor.ts:181-233` — timeout/RPC→`ambiguous`, revert→`not_moved`, receipt-success-sin-evento-matcheado→`ambiguous`. NUNCA asumir movimiento. `resolveDispute` verifica `DisputeResolved(keyId,…,nonce)`; `lockForDispute` verifica `DisputeLocked(keyId,…)`; `releaseDispute` verifica `DisputeReleased(keyId,…)`.
- **CD-5 (wallet dedicada)**: el wallet client SOLO deriva de `ARBITER_PRIVATE_KEY`. Cache propio (Maps nuevos en `arbiter-executor.ts`), NO reusar `getEscrowWalletClient` de `debit-executor.ts` (lee `OPERATOR_PRIVATE_KEY`). Sin la env / RPC → `not_moved` (nunca lanza).
- **CD-6 (best-effort)**: `lockForDispute` y `releaseDispute` son best-effort: outcome logueado, un fallo NO bloquea ni lanza en el flujo del árbitro (`try/catch`, patrón `upsertArbitrationRow`).
- **CD-7 (consent silencioso)**: `readArbitrationConsent` devuelve `false` ante cualquier error/RPC-null; `false` → fallback silencioso, PROHIBIDO error/warning ruidoso o bloqueo (es el estado esperado hasta la HU de captura de consent).
- **ABI convergente byte-a-byte** con `IWasiAIEscrow.sol`; topic0 de eventos derivado por `parseAbiItem` (NUNCA literal).
- **Ownership Guard**: no aplica query nueva sobre `a2a_agent_keys`; el keyId es el `row.key_id` del intent ya owner-verificado.

### PROHIBIDO

- NO tocar `contracts/**` ni proponer cambios de Solidity (191f congelado).
- NO deployar / `setArbiter()` / migrar (191h, Scope OUT).
- NO invocar `setArbitrationConsent` (191g solo consulta el view; el set es Scope OUT).
- NO reusar `OPERATOR_PRIVATE_KEY` para llamadas `onlyArbiter` (CD-5).
- NO agregar dependencias ni migraciones (DT-6).
- NO clonar el money-path de `executeArbitration`; reusar el seam (CD-2).
- NO cerrar tests con `expect(true).toBe(true)` (Auto-Blindaje 191b, ver CD-AB).
- NO dejar mocks `vi.fn()` sin firma tipada ni usar símbolos top-level en factories `vi.mock` (Auto-Blindaje 191b/191c, ver CD-AB).

### CD-AB — Constraint Directives de Auto-Blindaje (patrones de error recurrentes del epic)

- **CD-AB-1**: usar `./node_modules/.bin/biome`, NUNCA `npx biome` — no resuelve el ejecutable en este entorno (191b auto-blindaje#1).
- **CD-AB-2**: en tests con `tsc`, todo `vi.fn` que reciba args va tipado con params (`vi.fn((_a: unknown) => …)`) y los resolvers `T|null` con retorno anotado (`vi.fn((): string|null => …)`) — mocks a 0 args rompen `tsc` (191b auto-blindaje#2/#3). Recurrente ≥2 HUs.
- **CD-AB-3**: todo símbolo (clase de error, fixture) consumido por una factory `vi.mock` va dentro de `vi.hoisted` o de la propia factory — `vi.mock` es hoisted (191c auto-blindaje#1).
- **CD-AB-4**: nunca cobertura tautológica (`expect(true).toBe(true)`); toda cross-ref a otro test se verifica con `grep` antes de commitear (191b auto-blindaje#4). Recurrente con CD-AB-2 en la disciplina de tests money-path.
- **CD-AB-5 (money-path de 2 hops)**: cualquier side-effect on-chain que ocurra FUERA de un RPC atómico exige (a) claim exclusivo por estado de entrada, (b) evidencia/lease persistida ANTES del side-effect, (c) re-verificación on-chain autoritativa ANTES de re-enviar; nunca marcar un money side-effect como aplicado sin chequear rows-affected (191c auto-blindaje#2). Aquí: el determinismo del nonce (§5) + el status-gate DB son las barandas de exactly-once; el executor re-verifica el evento antes de reportar `confirmed`.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| R-1: divergencia ABI TS vs Solidity | B | A | Convergencia byte-a-byte con `IWasiAIEscrow.sol` (verificado §3); test de forma |
| R-2: leftover lock en `not_moved`/`unequivocal` (dual-book) | M | B | Money-safe (fondos del buyer, recuperables); documentado §4.3; reconciliación de lock = Scope OUT/seguimiento |
| R-3: griefing — buyer pre-consume el nonce derivado (público) para forzar `not_moved` | B | B | Money-SAFE (nada se mueve mal); path INERTE hasta 191h; testnet-only; follow-up: variante con contador de intentos (NO en 191g, rompería exactly-once, §5) |
| R-4: `getDefaultChainKey` distinto del `chain_id` del intent | B | M | El escrow opera sobre la default chain (igual que settleEscrowAware/debit-capture); si difiere → fallback custodial (correcto) |
| R-5: doble `lockForDispute` (top-up) por doble transición | B | B | `open_dispute` es anti-race (FOR UPDATE); lock una vez por transición; `lockForDispute` valida `newLocked<=balance` |
| R-6: mocks/tsc/biome del pipeline | M | B | CD-AB-1..4 |

## 8. Dependencias

- **DONE (congelado)**: 191f (contrato), 191a/191b/191c (patrones escrow/executor/gate), WKH-192 (`usdToAtomic` decimals-aware), WKH-139 v2, WKH-189.
- **Bloquea**: 191h (deploy/upgrade + `setArbiter()` + smoke E2E) — necesita este wire en `main`.
- **Bloqueante de EJECUCIÓN (no de código)**: 191h no corrió → `NotArbiter`; captura de consent no existe → `false`. Ambos → fallback correcto. 191g es code-complete/testeable con mocks.

## 9. Missing Inputs

- [x] Nombre de env flag → **RESUELTO: `ESCROW_ARBITER_ENABLED`** (familia `ESCROW_SETTLE_ENABLED`/`ESCROW_DEBIT_CAPTURE_ENABLED`; patrón `=== 'true'` exacto). Nueva env `ARBITER_PRIVATE_KEY` (dedicada).
- [x] Derivación del nonce → **RESUELTO: §5** (determinista, bit 255 reservado + digest keccak).
- [x] Persistencia del outcome del lock → **RESUELTO: logging estructurado, sin migración (DT-6)**.
- [x] Re-verificar `lockedAmount` antes de `resolveDispute` → **RESUELTO: confiar en el revert `ExceedsLockedAmount` del contrato** (recomendación del Analyst; ya cubierto por CD-4; sin view extra).
- [ ] `[Scope OUT / HU separada]` flujo de captura de `setArbitrationConsent` (tx directa del depositante; no delegable por firma). No bloquea el CÓDIGO de 191g.
- [ ] `[bloqueante de EJECUCIÓN]` 191h (upgrade + `setArbiter()`).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [NEEDS CLARIFICATION] | §5 | La convención "cliente de referencia usa nonces de debit en [0,2^255)" constriñe al SDK del buyer, no es enforcement on-chain — confirmar como TD del SDK | No (la capa probabilística 2⁻²⁵⁵ ya cubre el caso general) |
| [TBD] | §4.3 | Reconciliación del lock huérfano en `not_moved`/`ambiguous` — Scope OUT, seguimiento | No |

> No hay [NEEDS CLARIFICATION] BLOQUEANTES. El único marker es una convención de SDK cuya
> ausencia queda cubierta por la garantía probabilística (2⁻²⁵⁵) del esquema de nonce.

---

## Plan de Implementación (Waves)

### Wave 0 (Serial Gate) — contratos/tipos, sin lógica de red

- [ ] W0.1: extender `ESCROW_ABI` en `abi.ts` con 5 functions + 3 events (byte-a-byte `IWasiAIEscrow.sol`). → Exemplar: `IWasiAIEscrow.sol:79-94`, entradas existentes de `abi.ts`.
- [ ] W0.2: uniones de outcome (`LockOutcome`/`ResolveOutcome`/`ReleaseOutcome`, forma `Hop1Outcome`) + `deriveArbiterNonce` (pura) + `isEscrowArbiterEnabled()` en `arbiter.ts`. → Exemplar: `Hop1Outcome`, `isEscrowSettleEnabled`.
- Verificación: `tsc --noEmit`.

### Wave 1 (Parallelizable) — módulos aislados

- [ ] W1.1: `arbiter-executor.ts` — wallet/public client cacheados desde `ARBITER_PRIVATE_KEY`; `executeLockForDispute`/`executeResolveDispute`/`executeReleaseDispute` (write→receipt→verify-event→outcome, nunca lanzan); `_resetArbiterExecutor`. → Exemplar: `debit-executor.ts:74-234`.
- [ ] W1.2: `readArbitrationConsent(chainKey, keyIdHash)` en `escrow-verifier.ts` (view; error/RPC-null → `false`). → Exemplar: `getEscrowClient`/`resolveEscrowContract`.
- Verificación: `tsc` + unit de W1.1.

### Wave 2 (Integración) — el wire en arbiter.ts (depende W0+W1)

- [ ] W2.1: seam `settleArbitrationOnChain` (§4.3) + swap de la línea 546 en `executeArbitration`. → Exemplar: `settleEscrowAware`.
- [ ] W2.2: best-effort `lockForDispute` al inicio de `resolveDispute` (servicio, línea ~396, tras tener `row`), una vez, gate CD-1. → Exemplar: `upsertArbitrationRow` (try/catch best-effort).
- [ ] W2.3: best-effort `releaseDispute` en la rama refund (`arbMicro<=0`, línea 523) bajo gate CD-1.
- Verificación: `tsc` + suite arbiter.

### Wave 3 (Final) — tests + gates

- [ ] W3.1: `arbiter-executor.test.ts` (mocks viem) + tests del wire.
- Verificación: `tsc` + `vitest` full + `./node_modules/.bin/biome check` (CD-AB-1).

## Test Plan

| Test | AC/CD | Wave | Caso |
|------|-------|------|------|
| flag OFF → `settlePaymentIntentOnChain`, cero on-chain | AC-1/AC-7 | W3 | gate primera línea |
| escrow no configurado (`resolveEscrowContract===null`) → fallback | AC-1 | W3 | |
| flag ON + escrow + `consent===false` → fallback, sin `executeResolveDispute` | AC-2/CD-7 | W3 | |
| flag ON + escrow + `consent===true` + `release`/`split` → `executeResolveDispute(seller,sellerAmount,nonce)` | AC-4 | W3 | |
| desenlace `refund` (`arbMicro<=0`) → `executeReleaseDispute`, no `resolveDispute` | AC-5 | W3 | |
| transición a `'disputed'` → `executeLockForDispute` UNA vez por deposit total | AC-3 | W3 | |
| `deriveArbiterNonce` — determinista, bit 255 seteado, ≠ para distinto (keyId,intentId), disjunto de nonces de debit de muestra | AC-4/CD-3 | W3 | pura |
| `executeResolveDispute`: revert→`not_moved`; timeout→`ambiguous`; receipt-success-sin-`DisputeResolved`→`ambiguous`; evento OK→`confirmed` | AC-6/CD-4 | W3 | mocks viem |
| sin `ARBITER_PRIVATE_KEY` / sin RPC → `not_moved` (nunca lanza) | AC-8/CD-5 | W3 | |
| lock/release fallan → logueado, la resolución NO se rompe | CD-6 | W3 | |
| idempotencia: 2ª `executeResolveDispute` (mismo intent, mismo nonce) → `not_moved` (`NonceAlreadyUsed` mockeado) | §5/CD-AB-5 | W3 | |
| `readArbitrationConsent`: view true/false; RPC null → `false` | AC-2/CD-7 | W3 | |

> Sin `expect(true).toBe(true)` (CD-AB-4). Mocks tipados (CD-AB-2), símbolos en `vi.hoisted` (CD-AB-3).

## Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | `tsc --noEmit` |
| W1 | `tsc` + unit executor |
| W2 | `tsc` + suite arbiter |
| W3 | `tsc` + `vitest` full + `./node_modules/.bin/biome check` |

---

## Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado (tabla 4.1 + Test Plan)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (paths reales confirmados)
[x] No hay [NEEDS CLARIFICATION] BLOQUEANTES (el único es convención de SDK, cubierto por 2^-255)
[x] Constraint Directives incluyen >3 PROHIBIDO + 7 CD + 5 CD-AB
[x] Context Map tiene 10 archivos leídos
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: a2a_payment_intents/a2a_arbitrations verificadas; sin migración nueva
[x] Happy Path completo (§4.4) + Flujo de error (§4.5)
[x] Nonce disjunto resuelto y justificado (§5)
[x] Auto-Blindaje histórico incorporado (CD-AB-1..5 de 191b/191c/191f)
```

*SDD generado por NexusAgil — FULL — Architect F2*
