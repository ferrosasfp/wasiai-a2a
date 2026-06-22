# Work Item — [WKH-126b] Integración TS del Escrow No-Custodial en wasiai-a2a

> **Nota de splitting (2026-06-21)**: esta HU fue separada en dos sub-HUs tras resolución de NC-1 en el gate.
> - **WKH-126a** = contrato Solidity del escrow (repo/carpeta aparte, pipeline Foundry/Hardhat) — HU hermana y PREREQUISITO de esta.
> - **WKH-126b** = esta HU = SOLO la integración TypeScript en `wasiai-a2a` (escrow-verifier, routing condicional, env vars, tests contra ABI/interface).

## Resumen

El fondeo de Agent Key hoy es custodial: el USDC depositado queda en una EOA del operador (`resolveTreasury`), y el saldo per-key vive solo en la DB. Esta HU (WKH-126b) introduce la integración TypeScript del modelo de escrow no-custodial en `wasiai-a2a`: el gateway verifica el evento `Deposited` emitido por el contrato escrow (WKH-126a), acredita budget solo si la verificación es exitosa, y autoriza cada débito mediante una firma EIP-712 presentada al contrato. El objetivo es cerrar el gap de trust-minimización requerido por inversores y habilitado por la infraestructura de recibos inmutables de WKH-124.

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: L (toca payment + custodia de fondos + integración EIP-712 + adapter escrow multichain)
- **Pipeline**: QUALITY (obligatorio — superficie de seguridad máxima)
- **Branch sugerido**: `feat/117-wkh-126b-escrow-ts-integration`
- **Sub-HUs**: WKH-126a (contrato) es hermana/prerequisito; ver Análisis de Paralelismo

---

## Acceptance Criteria (EARS)

### Depósito al Escrow

**AC-1**: WHEN un agente autónomo transfiere USDC al contrato escrow en la cadena configurada y llama `POST /deposit` con el `tx_hash`, THEN el sistema SHALL verificar on-chain que el evento `Deposited(depositor, agent_key_id, amount)` (o equivalente) emitido por el contrato escrow corresponde al `funding_wallet` bindeado y SHALL acreditar el budget solo si la verificación es exitosa (verify-before-credit, CD-4 preservado).

**AC-2**: WHILE el contrato escrow no haya recibido confirmaciones suficientes (`A2A_DEPOSIT_MIN_CONFIRMATIONS_<FAMILY>`), the system SHALL reject the deposit request with `error_code: INSUFFICIENT_CONFIRMATIONS` y SHALL NOT acreditar ningún budget.

**AC-3**: IF el `tx_hash` presentado ya fue procesado para esa combinación `(chain_id, tx_hash)`, THEN the system SHALL respond with `409 DEPOSIT_ALREADY_CREDITED` and SHALL NOT double-credit (anti-replay UNIQUE constraint en DB preservado).

### No-Retiro Arbitrario por el Operador

**AC-4**: WHILE el agente tiene fondos en el contrato escrow, the system SHALL NOT allow the operator EOA (`OPERATOR_PRIVATE_KEY`) to withdraw those fondos unilaterally without a signed EIP-712 debit authorization linked to a valid receipt in `a2a_receipts`.

**AC-5**: IF una transacción intenta retirar fondos del escrow sin presentar una autorización EIP-712 firmada válida, THEN the system SHALL revert the on-chain transaction (enforced by the contract — WKH-126a — but the TS integration SHALL NOT generate or present invalid/missing authorizations).

### Preservación de Ownership Guard y Anti-Replay

**AC-6**: WHEN `POST /deposit` recibe un `tx_hash` de depósito al escrow, the system SHALL verify that the on-chain `depositor` address matches the `funding_wallet` bound to the caller's key (`Deposited.depositor == funding_wallet`), and SHALL return `403 FUNDING_WALLET_MISMATCH` if there is a discrepancy (BLQ-MED-1 preservado).

**AC-7**: WHEN `budgetService.registerDeposit` is called after escrow deposit verification, the system SHALL pass `owner_ref` as a parameter and SHALL NOT credit budget to a key whose `owner_ref` does not match the authenticated caller (Ownership Guard WKH-53 preservado).

### Coexistencia / Migración

**AC-8**: WHILE la feature flag `ESCROW_MODE_ENABLED` no está activa (`'true'`), the system SHALL operate with the existing treasury EOA flow (sin breaking change, compatibilidad total con el flujo actual de `deposit-verifier.ts`).

**AC-9**: WHERE `ESCROW_MODE_ENABLED === 'true'`, the system SHALL route deposit verification through the escrow adapter in place of `resolveTreasury`, using the same `register_a2a_key_deposit` RPC and the same response shape `{ balance, chain_id }`.

### Multichain

**AC-10**: WHEN el escrow está habilitado, the system SHALL support at least the same chain keys currently supported by `deposit-verifier.ts` (`kite-ozone-testnet`, `avalanche-fuji`, `base-sepolia`) with a per-chain escrow contract address resolvable from env vars (no hardcodes).

### Receipts / Audit

**AC-11**: WHEN a deposit is successfully credited from the escrow flow, the system SHALL emit a `deposit_verified` receipt via `receiptService.emit` (best-effort, fire-and-forget, consistent with CD-B in receipt.ts) with `tx_hash` set to the on-chain transaction hash.

---

## Scope IN

- `src/adapters/deposit-verifier.ts` — extensión o nuevo adapter escrow (`escrow-verifier.ts`) que implementa la misma interfaz de verificación
- `src/adapters/escrow/abi.ts` — ABI del contrato escrow como constante TypeScript tipada (array viem-compatible), incluyendo la función `debit(keyId, amount, deadline, signature)` y el dominio/typehash EIP-712
- `src/routes/auth.ts` — `POST /deposit` routing condicional (feature flag `ESCROW_MODE_ENABLED`)
- `src/services/budget.ts` — sin cambios en `registerDeposit` (backward compatible); posiblemente nuevo método `registerEscrowDeposit` si el shape difiere (a resolver en F2)
- `src/adapters/types.ts` — posible nueva interfaz `EscrowAdapter` per-chain
- Variables de entorno: `ESCROW_MODE_ENABLED`, `A2A_ESCROW_CONTRACT_KITE`, `A2A_ESCROW_CONTRACT_AVALANCHE`, `A2A_ESCROW_CONTRACT_BASE`
- Tests: unit tests del escrow adapter contra ABI/interface mock (anvil o mock viem) + integración `POST /deposit` con escrow mode
- Migración DB (si aplica): a resolver en F2; si se agrega campo en `a2a_agent_keys` debe incluir migration reversible

## Scope OUT

- **Contrato Solidity del escrow (WKH-126a)**: FUERA de esta HU. El contrato vive en repo/carpeta aparte con pipeline Foundry/Hardhat. Esta HU solo consume su ABI/interfaz acordada. El e2e on-chain real depende del deploy de WKH-126a.
- **Modelo x402 (EIP-3009)**: el escrow es exclusivamente para el modelo prepago (agent key). x402 es el otro modelo de pago y queda fuera de esta HU.
- **Liquidación/withdrawal por el agente**: el mecanismo por el cual el agente recupera fondos no consumidos del escrow es fuera de scope (requiere diseño de governance del contrato — WKH-126a).
- **Mainnet deploy**: la HU cubre testnet (kite-ozone-testnet, avalanche-fuji, base-sepolia). Mainnet es una HU operacional posterior.
- **Cambios a `receiptService` core**: los recibos ya están implementados (WKH-124). Esta HU solo llama `receiptService.emit`, no modifica su lógica.
- **Reputación ERC-8004** (WKH-103): fuera de scope.
- **Session keys, delegaciones, constraints por destino** (WKH-121/122/125): no se modifican; deben seguir funcionando sin cambios después de esta HU.

---

## Decisiones Técnicas (DT-N)

**DT-1 — LOCKEADO 2026-06-21 (NC-2 RESUELTO): Modelo de débito = Opción A — Recibo firmado EIP-712.**

El agente firma una autorización EIP-712 por cada débito; el gateway presenta la firma al contrato escrow para retirar exactamente ese monto. Este modelo es el elegido porque:
- Es alineado con el vector "agente autónomo firma programáticamente" (headless-friendly, sin UI wallet).
- Encaja con los recibos inmutables de WKH-124: cada débito tiene un recibo firmado auditable.
- Impone granularidad per-operación: el operador nunca retira más de lo autorizado por firma.

Alternativas descartadas:
- **(B) Allowance con cap** — descartada: menos granular, permite al operador drenar el cap completo en una sola tx.
- **(C) Canal de pago lite** — descartada: complejidad de settlement batch fuera de alcance de esta HU.

El ABI del contrato (DT-3) deberá incluir una función de débito que recibe firma EIP-712, p.ej. `debit(bytes32 keyId, uint256 amount, uint256 deadline, bytes calldata signature)`, más el dominio EIP-712 y el typehash que el agente firma. El diseño preciso del ABI y del dominio es responsabilidad de WKH-126a; esta HU consume la interfaz acordada.

**DT-2**: El flujo de verificación on-chain del depósito al escrow lee el evento específico del contrato escrow (`Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)`) en lugar del evento `Transfer` ERC-20 directo a la treasury EOA. Se crea `escrow-verifier.ts` siguiendo el mismo patrón que `deposit-verifier.ts` (lazy publicClient cache, `verifyDeposit` retorna `DepositVerification`). La función de débito EIP-712 también se prepara en este adapter para cuando WKH-126a esté deployado.

**DT-3**: El ABI del contrato escrow se incluye en este repo como una constante TypeScript tipada (array viem-compatible) en `src/adapters/escrow/abi.ts`. El ABI incluye al menos:
- Función `deposit(bytes32 keyId, uint256 amount)` (o equivalente que emite `Deposited`)
- Función `debit(bytes32 keyId, uint256 amount, uint256 deadline, bytes calldata signature)` (modelo EIP-712)
- Evento `Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)`
- La forma exacta se coordina con WKH-126a; el Architect (F2) puede usar una interfaz provisional para tests.
- La dirección del contrato por chain se lee desde `process.env.A2A_ESCROW_CONTRACT_<FAMILY>`.

**DT-4 — LOCKEADO 2026-06-21 (NC-3 RESUELTO): Coexistencia vía feature flag `ESCROW_MODE_ENABLED` — NO reemplazo.**

Flag off (default) → flujo treasury actual (`resolveTreasury` + `deposit-verifier.ts`) sin ninguna regresión. Flag on → rutea al escrow adapter en `auth.ts` handler de `/deposit`. Ambos caminos son válidos durante la migración. No hay "reemplazo completo" en esta HU — la coexistencia es el estado final de esta HU; el cutover es una decisión operacional posterior.

**DT-5**: Los campos de `DepositVerification` retornados por el escrow adapter deben ser compatibles con los que espera `auth.ts` (mismo shape de respuesta `{ ok, reason?, amountUsd, from, ... }`). El handler de `/deposit` no se bifurca en lógica — solo el adapter cambia.

---

## Constraint Directives (CD-N)

**CD-1**: PROHIBIDO acreditar budget antes de que la verificación on-chain del evento escrow sea exitosa. El principio verify-before-credit (CD-4 original del WKH-35) aplica también al escrow adapter sin excepción.

**CD-2**: OBLIGATORIO preservar el anti-replay `UNIQUE(chain_id, tx_hash)` en `register_a2a_key_deposit`. El Postgres RPC no cambia de firma; si cambia, debe incluir migration reversible.

**CD-3**: PROHIBIDO hardcodear direcciones de contratos escrow, ABIs de bytecode o chain IDs. Toda referencia a contratos escrow viene de env vars (`A2A_ESCROW_CONTRACT_KITE`, `A2A_ESCROW_CONTRACT_AVALANCHE`, `A2A_ESCROW_CONTRACT_BASE`) o de los helpers de chain family existentes.

**CD-4**: OBLIGATORIO mantener el Ownership Guard (WKH-53): cualquier query o mutación sobre `a2a_agent_keys` en el escrow flow DEBE incluir `.eq('owner_ref', ownerId)`. Adversary Review DEBE buscar `.from('a2a_agent_keys')` sin `owner_ref` en el PR.

**CD-5**: PROHIBIDO usar `ethers.js`. Todo código blockchain (lectura de evento, validación de ABI, construcción de payload EIP-712) usa `viem` v2.

**CD-6**: PROHIBIDO modificar la lógica de `receiptService` (WKH-124). El escrow flow solo llama `receiptService.emit(...)` como best-effort fire-and-forget (idéntico al patrón de `budget.ts`).

**CD-7**: OBLIGATORIO que los tests del escrow adapter corran contra un mock/interfaz del contrato (viem mock o anvil local) — NO requieren el contrato WKH-126a deployado para pasar en CI.

---

## Missing Inputs

- **[NC-1 RESUELTO 2026-06-21]**: Contrato Solidity separado como WKH-126a (HU hermana/prerequisito). Esta HU = WKH-126b = solo integración TS. El ABI se usa como constante provisional coordinada con 126a.
- **[NC-2 RESUELTO 2026-06-21]**: Modelo de débito = Opción A (EIP-712). Ver DT-1 lockeado.
- **[NC-3 RESUELTO 2026-06-21]**: Coexistencia vía flag `ESCROW_MODE_ENABLED` (no reemplazo). Ver DT-4 lockeado. AC-8/AC-9 son consistentes con esta decisión.
- **[TBD — F2]**: Forma exacta del ABI/dominio EIP-712 del contrato escrow (depende de WKH-126a). El Architect define la interfaz provisional en F2 para que los tests no bloqueen.
- **[TBD — F2]**: Si se requiere campo `escrow_balance` observable en `a2a_agent_keys` o si el saldo on-chain se consulta siempre en vivo. Resolver en F2.

---

## Análisis de Paralelismo

- **Esta HU (WKH-126b) depende de**: WKH-126a (interfaz/ABI del contrato) para el e2e on-chain real. Los tests en CI no la bloquean (mock/interfaz provisional). WKH-124 (DONE), WKH-35 (DONE), WKH-53 (DONE).
- **WKH-126a depende de**: decisión de modelo de débito (RESUELTA — EIP-712). Puede arrancar inmediatamente en paralelo con el diseño F2 de esta HU.
- **Esta HU bloquea**: ninguna HU activa identificada depende del escrow. Las HUs de billing (compose, orchestrate) no se tocan.
- **No interfiere con**: WKH-121 (session keys), WKH-122 (revocación), WKH-123 (signed auth), WKH-125 (constraints por destino) — todos DONE, no se tocan.
- **Branch**: `feat/117-wkh-126b-escrow-ts-integration` (rama propia; WKH-126a tiene su propio branch/repo).

---

## Contexto Adicional para el Architect (F2)

### Flujo actual (custodial)

```
Agente → Transfer ERC-20 → Treasury EOA (resolveTreasury)
POST /deposit { tx_hash, key_id, chain_id }
  → verifyDeposit (lee evento Transfer, valida to==treasury, from==funding_wallet)
  → budgetService.registerDeposit → RPC register_a2a_key_deposit
  → { balance }
```

### Flujo objetivo (no-custodial, escrow, modelo EIP-712)

```
Agente → deposit(keyId, amount) en EscrowContract → evento Deposited(depositor, keyId, amount)
POST /deposit { tx_hash, key_id, chain_id }
  → escrowVerifier.verifyDeposit (lee evento Deposited, valida depositor==funding_wallet)
  → budgetService.registerDeposit (sin cambios)
  → { balance }

Débito por uso (autorizado on-chain con EIP-712):
  compose/orchestrate → budgetService.debit → receiptService.emit (recibo inmutable)
  operador construye payload EIP-712 { keyId, amount, deadline } firmado,
  presenta debit(keyId, amount, deadline, signature) al contrato escrow.
  El contrato verifica la firma y transfiere exactamente `amount` al operador.
```

### Dominio EIP-712 esperado (provisional — WKH-126a define canónicamente)

```
DebitAuthorization {
  bytes32 keyId;
  uint256 amount;
  uint256 deadline;
}
// domain: { name: "WasiAIEscrow", version: "1", chainId, verifyingContract }
```

El agente (o el gateway en nombre del agente) firma `DebitAuthorization` con su `OPERATOR_PRIVATE_KEY` o con la clave de sesión correspondiente. El contrato verifica la firma con `ECDSA.recover`.

### Archivos relevantes (grounding F0 verificado)

- `/src/adapters/deposit-verifier.ts` — patrón de verificación on-chain (publicClient lazy cache, `verifyDeposit`, `resolveTreasury`, `resolveMinConfirmations`)
- `/src/routes/auth.ts:602` — handler `POST /deposit` (ownership pre-check, verify-before-credit, funding-wallet gate, registerDeposit call)
- `/src/routes/auth.ts:459` — handler `POST /funding-wallet` (bind con proof of control — se preserva sin cambios)
- `/src/services/budget.ts:314` — `registerDeposit` (anti-replay, ownership guard, RPC `register_a2a_key_deposit`)
- `/src/services/receipt.ts` — `receiptService.emit` (best-effort, fire-and-forget, HMAC-SHA256)
- `/src/adapters/types.ts` — `ChainKey`, `AdaptersBundle`, `TokenSpec`
