# Auditoría D — Rendimiento / Gas — WasiAIEscrow.sol (WKH-126a)

> **Tipo**: auditoría de gas/performance (read-only). NO se modifica código ni tests.
> **Contrato**: `contracts/src/WasiAIEscrow.sol` (escrow no-custodial USDC, UUPS, Foundry).
> **Compilación**: solc 0.8.24, `optimizer = true`, `optimizer_runs = 200`, `via_ir = false`.
> **Fecha**: 2026-06-22. Fuente de números: `forge test --gas-report` + `.gas-snapshot`.
> **Regla rectora**: NO sacrificar seguridad por gas. CEI, nonReentrant, ownership checks y atomicidad de batch son intocables.

---

## 1. Tabla de gas actual (gas report, runtime)

| Función | Min | Avg | Median | Max | # Calls |
|---------|-----|-----|--------|-----|---------|
| `deposit` | 5 486 | 54 039 | 35 467 | 89 673 | 5 164 |
| `debit` (single) | 5 742 | 43 772 | 20 820 | 83 778 | 8 930 |
| `debitBatch` (n=2) | 6 454 | 65 033 | 63 769 | 124 877 | 3 |
| `withdraw` | 7 603 | 19 925 | 7 603 | 33 335 | 8 944 |
| `initialize` | 23 226 | 161 744 | 168 041 | 168 041 | 23 |
| `escrowBalance` (view) | 2 513 | — | 2 513 | 2 513 | 9 156 |
| Deployment (impl) | — | — | — | 1 859 144 | — |

Notas de lectura:
- El **Min** de cada función mutadora es un revert temprano (validación de input antes de tocar storage) → no es el path representativo.
- **`debit` Max 83 778** = path cold (primer toque de `_usedNonces[keyId][nonce]`, `_balances[keyId]` cold, y `safeTransfer` a un operador con balance USDC que pasa de 0 a >0 = SSTORE cold caro en el token). **Median 20 820** = path warm (storage ya tocado en el mismo tx/setup).
- **`debitBatch` n=2**: Max 124 877, Median 63 769. El test sólo ejercita batches de tamaño 2 (`test/WasiAIEscrow.t.sol:139,167`), por eso # Calls = 3.

### 1.1 Costo del PATH CALIENTE — `debitBatch` por elemento

Este es el costo operativo recurrente: el operador paga este gas en **cada liquidación en lote** (`gas-settlement-economics.md` → "el operador es quien manda la tx de débito y paga el gas").

Descomposición del costo por elemento del loop (`_verifyAndConsume` + `emit Debited` + `total += amounts[i]`):

| Componente por elemento | Gas aprox. | Origen |
|-------------------------|-----------|--------|
| `ECDSA.recover` (ecrecover precompile + memoria) | ~3 000–3 500 | `:96` |
| `keccak256(abi.encode(...))` structHash + `_hashTypedDataV4` | ~600–900 | `:94–95` |
| SLOAD `_depositor[keyId]` (cold) | 2 100 | `:97` |
| SLOAD `_usedNonces[keyId][nonce]` (cold) | 2 100 | `:92` |
| SSTORE `_usedNonces[keyId][nonce]` 0→1 (cold set) | 22 100 | `:101` |
| SLOAD `_balances[keyId]` (cold) | 2 100 | `:99/:102` |
| SSTORE `_balances[keyId]` (warm, modifica no-cero) | ~2 900 | `:102` |
| `emit Debited` (2 topics indexed + 2 data words) | ~1 900 | `:126` |
| overhead loop (cond `i < length` + `i++` checked + calldata loads) | ~150–250 | `:123–125` |
| **Costo marginal por elemento (cold, típico mainnet)** | **≈ 38 000–40 000** | — |

> El costo dominado por el **SSTORE cold del nonce (22 100)** — es irreductible por diseño anti-replay (CD-3) y NO debe tocarse.
> Verificación cruzada con los números medidos: `debitBatch(n=2) Max 124 877` ≈ overhead fijo (nonReentrant SSTORE ~2 900 + dispatch + 1 `safeTransfer` final cold ~30 000) **+ 2 × ~40 000 elemento**. Consistente.
> **Marginal por elemento ≈ 38–40k gas cold / ≈ 18–20k warm** (si el operador re-debita un keyId ya tocado en el mismo tx, caso raro en settlement por-ventana).

---

## 2. Oportunidades evaluadas (con números)

### OP-1 — `unchecked { ++i }` + cachear `keyIds.length` en el loop — VALE LA PENA (marginal)

**Evidencia**: `src/WasiAIEscrow.sol:123` → `for (uint256 i = 0; i < keyIds.length; i++)`.

Dos micro-opts independientes:
- **`++i` dentro de `unchecked`**: el `i++` checked agrega un chequeo de overflow por iteración. `i` está acotado por `keyIds.length` (calldata array, max ~2^32 práctico) → overflow imposible. Ahorro: **~30–40 gas por iteración**.
- **Cachear `keyIds.length`**: hoy `keyIds.length` se evalúa en cada vuelta de la condición. Para arrays **calldata** el `.length` es barato (se lee de calldata, ~no-SLOAD), por eso el ahorro real acá es **menor que para arrays en storage**: **~10–15 gas por iteración**. El optimizer de solc a veces ya lo hoista; con `runs=200` no siempre.

**Ahorro combinado**: ~40–55 gas/elemento. Para un batch típico de 20 settlements → **~800–1 100 gas por tx**. Para batch de 50 → ~2 000–2 750 gas.

**Cuantificación económica**: sobre un `debitBatch` de ~125k–1.6M gas, esto es **<0.2% del costo total**. En testnet: despreciable. En mainnet a 30 gwei: ~0.00003 ETH por batch de 20. **Es real pero marginal.**

**¿Rompe algo?** No. `unchecked{++i}` con cota de array es un patrón estándar y seguro (OZ lo usa). No afecta CEI ni atomicidad. Legibilidad: leve costo, mitigable con comentario.

**Prioridad**: **BAJA**. Es la opt que el CR ya marcó (MNR-3 en `cr-report.md:88`). Recomendado SÓLO si se toca el archivo por otra razón. No justifica un fix-pack dedicado por sí sola.

---

### OP-2 — SLOADs redundantes de `_balances[keyId]` y `_depositor[keyId]` en `_verifyAndConsume` — VALE LA PENA (el de mayor impacto técnico)

**Evidencia**: `src/WasiAIEscrow.sol:97,99,102`.
```
:97   if (recovered != _depositor[keyId]) ...      // SLOAD #1 _depositor
:99   if (amount > _balances[keyId]) ...           // SLOAD #1 _balances
:102  _balances[keyId] -= amount;                  // SLOAD #2 _balances + SSTORE
```

- **`_balances[keyId]`** se lee dos veces: línea 99 (comparación) y línea 102 (el `-=` hace SLOAD + SSTORE). El segundo SLOAD es **warm** (EIP-2929: 100 gas) porque el 99 ya lo calentó dentro del mismo tx → ahorro de cachear en memoria local ≈ **~100 gas/elemento** (no 2 100; el cold ya se pagó en :99).
- **`_depositor[keyId]`** se lee una sola vez (:97) → **no hay redundancia ahí**. No es finding.

**Ahorro real**: cachear `_balances[keyId]` en una variable local (`uint256 bal = _balances[keyId]; if (amount > bal) ...; _balances[keyId] = bal - amount;`) ahorra **~100 gas/elemento** (un SLOAD warm). En batch de 20 → ~2 000 gas.

**¿Rompe algo?** No, si se mantiene el orden CEI (la escritura sigue ANTES de cualquier transfer). El refactor es local a `_verifyAndConsume`, no cambia semántica. Riesgo: BAJO — sólo cuidar de no introducir un read-after-write stale.

**Prioridad**: **BAJA-MEDIA**. Más limpio en intención que OP-1, ahorro comparable. Es la única optimización de "SLOAD redundante" genuina del contrato — el resto de los accesos a storage son necesarios (nonce check + set, balance check + set son lógicamente distintos).

> **IMPORTANTE — falso positivo descartado**: NO existe SLOAD redundante de `_depositor`. Una sola lectura. No reportar como hallazgo.

---

### OP-3 — Struct packing del storage — NO VALE LA PENA (despreciable + riesgo UUPS)

**Evidencia**: `src/WasiAIEscrow.sol:34–44`.
```
:34  IERC20 internal _usdc;            // slot 0  (address, 20 bytes)
:35  uint256 internal _upgradeTimelock;// slot 1  (32 bytes)
:36  bool internal _upgradeRenounced;  // slot 2  (1 byte, resto desperdiciado)
     mappings...                        // slots 3–7 (cada mapping = 1 slot de base)
:44  uint256[44] private __gap;        // slots 8–51
```

Análisis de packing:
- `_usdc` (address, 20 bytes) **+** `_upgradeRenounced` (bool, 1 byte) **cabrían en el mismo slot** (21/32 bytes) → ahorraría 1 slot de inicialización.
- Pero `_upgradeTimelock` (uint256) está en el medio (slot 1) rompiendo la adyacencia. Para empacar habría que reordenar (`_usdc` + `_upgradeRenounced` juntos, `_upgradeTimelock` después).

**Ahorro**: 1 slot menos = ~20 000 gas **una sola vez en `initialize`** (deploy). **CERO ahorro en el path caliente** (`debitBatch` no toca estas variables). Los 3 mappings (`_balances`, `_depositor`, etc.) NO se pueden empacar entre sí (cada mapping ocupa su slot base por regla de Solidity).

**¿Rompe algo?** **SÍ, RIESGO ALTO.** Reordenar storage en un contrato **UUPS upgradeable ya auditado** (CD-9: "order stable, __gap last") rompe el layout para futuros upgrades y contradice una Constraint Directive explícita. El ahorro es one-shot en deploy y **no toca el costo recurrente**.

**Prioridad**: **NO HACER.** El tradeoff es pésimo: ~20k gas one-shot vs. riesgo de storage collision en upgrades. CD-9 manda. Marcar como evaluado-y-descartado.

---

### OP-4 — `emit Debited` por elemento dentro del loop — NO TOCAR (observabilidad > gas)

**Evidencia**: `src/WasiAIEscrow.sol:126` (dentro del loop) vs `:111` (en `debit` single).

`emit Debited` cuesta **~1 900 gas/elemento** (LOG3: 2 topics indexed `keyId`+`operator` + base + 2 data words `amount`+`nonce`). Agregarlo en un solo evento batch ahorraría ~1 900 × (n-1) gas... **pero rompe la trazabilidad por-keyId on-chain**.

**Tradeoff**:
- El evento por-elemento es lo que permite mapear cada débito on-chain ↔ recibo `a2a_receipts` (WKH-124) por `keyId` + `nonce`. Es la pista de auditoría del settlement.
- Un evento agregado obligaría a parsear calldata para reconstruir qué keyId se debitó cuánto → peor observabilidad, y el `nonce` por-key se perdería del log.

**Prioridad**: **NO HACER.** El `emit` por elemento es correcto. El ahorro (~1 900/elem) no compensa perder la auditabilidad on-chain del modelo de settlement. Confirmado como decisión de diseño correcta.

---

### OP-5 — `safeTransfer` agregada al final — YA ÓPTIMO (confirmado)

**Evidencia**: `src/WasiAIEscrow.sol:129` → **una sola** `_usdc.safeTransfer(msg.sender, total)` DESPUÉS del loop.

Confirmado: el batch hace **1 transfer**, no N. Esto es lo que hace que `debitBatch` amortice gas vs N llamadas a `debit`. Una transfer ERC-20 cuesta ~30k–50k gas (cold) → en un batch de 20, hacer 1 transfer en vez de 20 ahorra **~570k–950k gas** vs el peor caso naïve. **Esta es la optimización estructural más importante del contrato y ya está implementada.** Verificado en gas report (n=2 Max 124 877, no ~167k que serían 2 transfers cold separadas) y en `ar-report.md:57`, `cr-report.md:64`.

**Prioridad**: N/A — ya hecho, no tocar.

---

### OP-6 — `calldata` vs `memory` — YA ÓPTIMO (confirmado)

**Evidencia**: `:115–119` (`bytes32[] calldata`, `uint256[] calldata`, `bytes[] calldata`), `:86` (`bytes calldata signature`).

Todos los params de array y `bytes` en funciones `external` usan **`calldata`**, evitando la copia a memoria (que costaría ~3 gas/word + expansión). Correcto. Cambiar a `memory` sólo agregaría costo. No hay finding.

**Prioridad**: N/A — ya óptimo.

---

### OP-7 — Custom errors vs require-strings — YA ÓPTIMO (confirmado)

**Evidencia**: `revert ZeroAmount()`, `DepositorMismatch()`, `DeadlineExpired()`, `NonceAlreadyUsed()`, `InvalidSignature()`, `InsufficientBalance()`, `Unauthorized()`, `LengthMismatch()`, `ZeroAddress()`, `UpgradeRenounced()`, `TimelockNotElapsed()` — todos custom errors (`:55,67,72,90,92,97,99,121,134,136,143,...`).

**Cero** `require(cond, "string")` en el contrato. Custom errors ahorran ~50 gas en el revert + deployment más chico (no se almacenan strings). Correcto. No hay finding.

**Prioridad**: N/A — ya óptimo.

---

### OP-8 — `via_ir` — NO ACTIVAR (CD-10), nota informativa

**Evidencia**: `foundry.toml` → `via_ir = false` (comentado), CD-10 en `sdd.md:235`: "activar SOLO si forge build falla por stack too deep".

`forge build` compila sin error → **NO hay stack-too-deep**, por lo tanto CD-10 manda: NO activar. Nota técnica: `via_ir` (pipeline Yul) **típicamente reduce el gas runtime ~3–8%** en funciones con muchas variables locales como `debitBatch`/`_verifyAndConsume`, a costa de **build mucho más lento** y un binario distinto que requeriría re-auditar. Para un contrato custodiando fondos, cambiar el pipeline de compilación post-auditoría es un riesgo que el ~5% de gas NO justifica. **Confirmado: dejar `via_ir = false`.**

---

## 3. Resumen priorizado (qué accionar)

| ID | Optimización | Ahorro estimado | Path | ¿Seguro? | Prioridad |
|----|--------------|-----------------|------|----------|-----------|
| OP-2 | Cachear `_balances[keyId]` local en `_verifyAndConsume` | ~100 gas/elem (SLOAD warm) | **caliente** | Sí (mantener CEI) | **BAJA-MEDIA** |
| OP-1 | `unchecked{++i}` + cache `.length` | ~40–55 gas/elem | **caliente** | Sí | **BAJA** |
| OP-3 | Struct packing (`_usdc`+`_upgradeRenounced`) | ~20k one-shot, 0 recurrente | deploy | **NO — rompe CD-9 UUPS** | **NO HACER** |
| OP-4 | Evento agregado en batch | ~1 900/elem | caliente | rompe auditabilidad | **NO HACER** |
| OP-5 | 1 transfer al final | ~570k–950k (batch 20) | caliente | — | **YA HECHO** |
| OP-6 | calldata | — | — | — | **YA HECHO** |
| OP-7 | custom errors | — | — | — | **YA HECHO** |
| OP-8 | via_ir | ~3–8% runtime | — | re-auditar binario | **NO (CD-10)** |

### Veredicto de la auditoría

El contrato **ya tiene las optimizaciones estructurales de mayor impacto** (OP-5 transfer única, OP-6 calldata, OP-7 custom errors). El costo del path caliente está dominado por SSTOREs irreductibles por diseño de seguridad (nonce anti-replay 22 100 gas, balance update) — **correcto, no se deben tocar**.

Las únicas opts genuinas restantes (OP-1, OP-2) suman **~140–155 gas/elemento** = **<0.4% del costo por elemento (~38–40k)**. Son **micro-optimizaciones**: valen la pena SÓLO si se toca el archivo por otra razón (p.ej. un fix-pack de otro finding). **No justifican un cambio dedicado** que requiera re-auditar un contrato que custodia fondos.

> **No sacrificamos nada de seguridad por gas.** Todas las opts de impacto real chocan con CD-9 (packing) o con la auditabilidad/anti-replay → descartadas. Las micro-opts (OP-1/OP-2) son seguras pero despreciables. **Recomendación: dejar el contrato como está para esta versión; aplicar OP-1+OP-2 oportunísticamente si hay otro fix.**

---

## 4. Falsos positivos descartados (no son hallazgos)

- **SLOAD redundante de `_depositor`**: se lee 1 sola vez (`:97`). No existe redundancia. Descartado.
- **Packing de mappings**: cada mapping ocupa su slot base por regla de Solidity; no son empacables entre sí. Descartado.
- **`emit` agregado**: rompería el mapeo on-chain débito↔recibo. No es mejora, es regresión de observabilidad. Descartado.
