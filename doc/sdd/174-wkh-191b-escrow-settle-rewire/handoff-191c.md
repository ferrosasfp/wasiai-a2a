# Handoff a 191c — Invariante de accounting de `reconciliation_pending`

> Origen: AR MNR-1 (ar-report.md) + CR §Nota categoría 5. 191b cierra el two-hop
> money-safe pero deja una **deuda de accounting temporal** que 191c DEBE resolver.
> Esto NO es código de 191b: es el contrato que 191c tiene que respetar.

## Estado que 191b produce: `debit_settle_status = 'reconciliation_pending'`

Se llega a `reconciliation_pending` por dos caminos (ambos con el flag ON, escrow
activo, firma `valid`):

1. **hop 1 confirmed + hop 2 fail** (`payment-intent.ts` — rama `o2.status==='failed'`):
   el escrow YA debitó `finalUsd` del buyer y los fondos están **en la wallet del
   operador**; el seam (operador→seller) falló. Remap `unequivocal→ambiguous` (CD-S4)
   → el caller finaliza `failed_ambiguous` → **NO reembolsa el budget off-chain**.
2. **hop 1 ambiguous** (`o1.kind==='ambiguous'`, p.ej. `RECEIPT_TIMEOUT`): la tx de
   `debit()` PUDO minarse → NO se corre hop 2; se marca `reconciliation_pending` con
   el tx tentativo. Igual → `failed_ambiguous` → **NO reembolsa**.

## El invariante (lo que 191c NO puede violar)

Cuando un intent queda en `reconciliation_pending`:

- El **buyer quedó debitado on-chain** (salió del escrow del buyer en el hop 1) **Y**
  el **budget off-chain NO se reembolsó** (remap `unequivocal→ambiguous` bloqueó el
  refund a propósito).
- Los fondos del hop 1 **los custodia el operador** (están en su wallet, no en el
  seller, no de vuelta en el buyer).
- Es una **doble-contabilización temporal**, NO una pérdida: los fondos son
  recuperables y el estado es durable + queryable
  (`WHERE debit_settle_status IN ('hop1_confirmed','reconciliation_pending')`,
  índice `idx_debit_sig_settle_status`).

## Lo que 191c DEBE hacer: completar EXACTAMENTE UN LADO

191c resuelve cada `reconciliation_pending` eligiendo **una** de estas dos acciones,
**nunca ambas, nunca ninguna**:

- **Completar el hop 2** (operador → seller): el seller cobra, el buyer queda
  correctamente debitado (on-chain) → flip a `settled`. NO reembolsar off-chain.
- **Devolver al buyer** (refund del escrow vía `withdraw()`/equivalente + reembolso
  del budget off-chain): el buyer queda entero, el seller no cobra → estado revertido.

### Prohibido en 191c (los dos modos de romper el invariante)

- ❌ **Double-credit**: reembolsar el budget off-chain **Y** dejar/completar el pago
  al seller → el buyer recupera su dinero y además el seller cobró = el operador
  paga de su bolsillo (o se pierde en el gap).
- ❌ **Fondos colgados**: no hacer ninguna de las dos → los fondos del hop 1 quedan
  atrapados indefinidamente en la wallet del operador; el buyer, doble-cobrado.

## Verificación previa obligatoria en 191c

Antes de decidir el lado, 191c debe re-verificar on-chain la **realidad** del hop 1
(el `debit_hop1_tx_hash` persistido puede ser tentativo si vino de un `ambiguous`):

- Si el `Debited(keyId, nonce)` NO se confirma on-chain → el hop 1 no movió fondos →
  el operador NO custodia nada → resolver reembolsando/reintentando sin doble-crédito.
- Si SÍ se confirma → el operador custodia `finalUsd` → completar exactamente un lado.

> Esta es la deuda de accounting temporal que 191b abre y **191c cierra**. 191b es
> money-safe (nunca paga mal ni reembolsa indebido); la resolución del pendiente es
> scope explícito de 191c (motor de reconciliación / drift budget-vs-escrowBalance).
