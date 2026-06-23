# Audit A — EIP-712 Signature & Fund Flow — WasiAIEscrow.sol

> nexus-adversary · 2026-06-22 · PoCs ejecutados (verdes) y borrados · suite base 22/22 PASS
> _Persistido por el orquestador (el agente no puede escribir .md)._

## Veredicto: FRONT-RUNNING CONFIRMADO Y EXPLOTABLE — CRÍTICO

Conteo: **CRÍTICO 1 · ALTO 1 · MEDIO 1 · BAJO 2 · OK-confirmados 4**

### F-A1 — CRÍTICO — Front-run / MEV steal: la firma no liga receptor y `debit` paga a `msg.sender`
- **Archivo:línea:** `WasiAIEscrow.sol:30-31` (typehash solo `keyId,amount,deadline,nonce`), `:94` (structHash sin receptor), `:110` (`safeTransfer(msg.sender, amount)`), `:129` (debitBatch idem), `:105-108` (sin onlyOperator).
- **Ataque (PoC verde):** el agente firma `DebitAuthorization(keyId, amount, deadline, nonce)` para que el operador liquide. El operador broadcastea `debit(...sig)` → la firma queda en el mempool público de Base. Un bot MEV copia `(keyId, amount, deadline, nonce, sig)`, front-runea con más gas → `_verifyAndConsume` pasa (la firma es válida para ese keyId, no liga caller) → `safeTransfer(msg.sender=bot, amount)`. **El bot cobra.** El nonce queda consumido → el tx del operador revierte `NonceAlreadyUsed`. PoC asserts: bot recibe el monto, operador 0, operador revierte.
- **Impacto:** robo del 100% de toda liquidación del operador por cualquiera que mire el mempool. En L2 con mempool público es trivial. **Bloquea cualquier deploy con fondos reales.**
- **Por qué el AR original lo perdió:** CD-2 / el invariant modelaron "el operador no puede robar al agente sin firma" — correcto pero INSUFICIENTE: omitieron al TERCERO que roba al operador. El invariant nunca modela un caller arbitrario reusando una firma válida.
- **Fix recomendado (#1):** agregar `address recipient` al struct EIP-712 + al typehash + `require(msg.sender == recipient)` (o transferir a `recipient`). Cierra F-A1 y F-A2. Obliga a bump del typehash y converger byte-a-byte con `src/adapters/escrow/eip712.ts:31-38` (4→5 campos) y el test del typehash. Alternativas: `onlyOperator` configurado (más simple, centraliza); treasury fijo (cambia modelo económico).

### F-A2 — ALTO — `debit`/`debitBatch` sin control de caller
- `:105-112`, `:114-130`. No hay onlyOperator ni allowlist. Habilitador estructural de F-A1. Cualquiera que consiga una firma válida (mempool, logs, leak de API de 126b) puede presentarla. Se cierra con el fix de F-A1 (recipient==msg.sender).

### F-A3 — MEDIO — `amount` = delta incremental, no neto acumulado (trampa de integración)
- `:99,102` (`amount > balance` / `balance -= amount`). El contrato trata cada debit como incremental. El SDD (DT-3) narra "neto acumulado por ventana". Coinciden SOLO si 126b firma un delta por nonce. Si 126b firmara el acumulado (neto=100 nonce1, neto=150 nonce2), el operador cobraría 100+150=250. No hay guardia on-chain. **Fix:** fijar la convención "amount = delta de la ventana" en NatSpec del contrato + eip712.ts + test de integración 126a↔126b.

### F-A4 — BAJO — `deadline` sin cota superior
- `:90` solo chequea no-expirado. Sin `deadline <= now + MAX_TTL`. Amplifica la ventana de F-A1. Fix opcional.

### F-A5 — BAJO — `Debited` emite `operator = msg.sender` aunque sea atacante
- `:47,111,126`. Bajo F-A1 los logs etiquetan al bot como "operator" → reconciliación off-chain engañosa. Subsumido por el fix de F-A1.

## Vectores OK (confirmados, no explotables)
- **Cross-keyId replay**: bloqueado (structHash incluye keyId). PoC → InvalidSignature.
- **Cross-chain replay**: bloqueado (EIP712Upgradeable usa `block.chainid` + `address(this)` en vivo, sin cache).
- **Malleability / address(0)**: OZ ECDSA v5.1.0 revierte en s-alto (InvalidSignatureS) y address(0) (ECDSAInvalidSignature). No bypass.
- **deadline=0/pasado**: bloqueado (DeadlineExpired).
- **Nonce**: sin colisión por reuso de número con distinto amount (primer uso marca el nonce; segundo revierte).
