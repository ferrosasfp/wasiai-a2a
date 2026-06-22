# Gas & Settlement Economics — Escrow (input de diseño para WKH-126a)

> **Status**: nota de diseño (no es código). Captura la discusión 2026-06-22 sobre quién paga gas, cuándo, y por qué transacción. Es **input para WKH-126a** (contrato + política de settlement). El architect de 126a la formaliza en su SDD.

## Regla base: leer es gratis, escribir cuesta gas
- **Leer** la cadena (consultar evento/saldo, `eth_getLogs`, `getTransactionReceipt`) → **0 gas**. La verificación de depósito del gateway (`escrow-verifier.ts` / `deposit-verifier.ts`) es 100% lectura → no paga gas.
- **Escribir** (cambiar estado on-chain) → cuesta gas.

## Modelo de hoy (treasury EOA, vivo en prod)
| Transacción | ¿Escribe? | Quién paga gas | Cuándo |
|-------------|-----------|----------------|--------|
| Depositar (agente → treasury, Transfer ERC-20) | Sí | **El agente** (funding wallet) | Al fondear, 1 sola vez |
| Gateway verifica el depósito (lee el evento) | No | Nadie | — |
| Gastar (debitar budget en compose/orchestrate) | No → va a la DB | Nadie | Cada pago, 0 gas |

**Propiedad clave del prepago**: fondear paga gas 1 vez; gastar es off-chain (DB) → 0 gas por pago. Fondeás una vez, gastás miles de veces sin gas.

## Modelo futuro (escrow, WKH-126a/126b)
| Transacción | ¿Escribe? | Quién paga gas | Cuándo |
|-------------|-----------|----------------|--------|
| `deposit(keyId, amount)` al contrato | Sí | **El agente** | Al fondear (posible `approve` previo si el contrato usa `transferFrom` → 2 tx, ambas las paga el agente) |
| Firmar `DebitAuthorization` EIP-712 (Opción A) | No (firma off-chain) | **Nadie, gratis** | Cada pago |
| `debit(keyId, amount, deadline, signature)` on-chain | Sí | **El operador** (gateway presenta la firma) | Al settlement |

**Punto fino de la Opción A elegida**: el agente firma gratis; **el operador es quien manda la tx de débito al contrato y paga el gas** de la liquidación. El agente nunca paga gas por gastar, solo por depositar.

## Módulo gasless (ya existe — WKH-29/38)
`src/routes/gasless.ts` + adapters: el **operador paga el gas por el usuario** en ciertos transfers ("on-chain transfer from operator wallet"), con un **cap anti-drenaje**. Patrón "vos firmás, yo pago el gas" ya implementado.

## Implicancia de negocio (a resolver en WKH-126a)
Cada liquidación on-chain le cuesta gas al operador. Mitigaciones:
1. **Día a día off-chain (DB)** + **settlement on-chain en LOTE**, no pago por pago. Mantener los débitos en `a2a_receipts` (WKH-124) y liquidar el neto.
2. El **1% protocol fee** (WKH-44/118) cubre, en parte, ese costo de gas.
3. **Hoy todo es testnet** → gas de juguete. La economía del gas pesa recién en **mainnet**.

## DECISIÓN ABIERTA para WKH-126a (settlement policy)
El contrato y el flujo necesitan definir explícitamente:
- **Cadencia de settlement**: ¿por pago, por umbral de monto acumulado, por tiempo (ej. cada N horas), o on-demand?
- **Quién dispara el `debit`**: ¿un job del operador? ¿el vendor que reclama? 
- **Batching**: ¿el contrato soporta `debitBatch(...)` para liquidar varios keyId/montos en una tx y amortizar gas?
- **Recibo ↔ débito on-chain**: cómo se mapea el neto de `a2a_receipts` a la firma `DebitAuthorization` presentada (monto, nonce anti-replay, deadline).
- **Quién paga el gas del depósito**: ¿el agente siempre, o se ofrece la vía gasless (operador paga con cap) para onboarding?

Estas decisiones definen el ABI final (`debit` vs `debitBatch`), el costo operativo, y la UX de fondeo.

Ver [[modelo-de-custodia-del-fondeo-de-agent]], [[wkh-126b-integraci-n-ts-del-escrow-no-custodial]].
