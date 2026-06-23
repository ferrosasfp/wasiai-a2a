# Runbook — Activar el escrow no-custodial en Base Sepolia (supervisado por humano)

> Estos pasos cambian el comportamiento de `/deposit` en prod para Base y escriben en la DB de prod. NO se ejecutan autónomamente — requieren OK explícito + supervisión. El código y el contrato ya están listos; esto es solo "encender".

## Estado actual (todo listo, NADA activado)
- Contrato `WasiAIEscrow` deployado + verificado + auditado + e2e on-chain probado en **Base Sepolia**: proxy `0x31C4C460C549C152088E2576BE145AA5C25bB462`.
- 126b (integración TS) + 126c (routing por-cadena) mergeados. `ESCROW_MODE_ENABLED` = OFF → todo treasury.
- Migración del `receipt_type` lista pero NO aplicada: `supabase/migrations/20260611000000_a2a_receipts_deposit_verified_check.sql`.

## Paso 1 — Aplicar la migración del receipt_type a prod
Vía Supabase Management API (proyecto `caldzjhjgctpgodldqav`), aplicar `20260611000000_a2a_receipts_deposit_verified_check.sql`. Additive (amplía el CHECK). Sin esto, los recibos `deposit_verified` no persisten (no bloquea el depósito, solo el recibo).

## Paso 2 — Setear env vars en Railway (variableUpsert → redeploy)
- `A2A_ESCROW_CONTRACT_BASE = 0x31C4C460C549C152088E2576BE145AA5C25bB462`
- `ESCROW_MODE_ENABLED = true`

Gracias a WKH-126c, esto activa escrow SOLO en Base; Kite/Avalanche siguen en treasury (no rompen).

⚠️ Verificar que NO haya flujos de depósito treasury en Base activos (ej. widget wasiai.io apuntando a treasury de Base) — al activar, Base espera depósitos al CONTRATO, no a la treasury.

## Paso 3 — E2E del gateway (cierra el círculo)
1. Crear agent key: `POST /auth/agent-signup {owner_ref}` → guardar `key` + `key_id` (UUID).
2. Bindear funding wallet: `POST /auth/funding-wallet` con la wallet que tiene USDC en Base Sepolia (ej. `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`, la del operador). El bind exige proof-of-control (firma).
3. Calcular `keyId = keccak256(utf8Bytes(key_id))` (igual que el gateway: `keccak256(stringToBytes(key_id))`).
4. Desde la funding wallet, on-chain en Base Sepolia: `USDC.approve(escrow, monto)` + `escrow.deposit(keyId, monto)`.
5. `POST /auth/deposit { key_id, chain_id: 84532, tx_hash }` → el gateway lee el evento `Deposited`, valida `depositor == funding_wallet` y el keyId, y acredita budget.
6. Verificar el budget acreditado (`GET` balance). ✅ Círculo cerrado: contrato + gateway + USDC real.
7. (Opcional) Liquidación: el operador firma/presenta `debitBatch`; el agente puede `withdraw` el saldo libre.

## Rollback
- Railway: `ESCROW_MODE_ENABLED=false` (vuelve a treasury, instantáneo).
- Migración: `..._down.sql`.

## Prerequisitos MAINNET (no testnet)
Auditoría externa · owner = multisig (no EOA) · decisión del lock optimista (DT-11) · replicar contrato a Kite/Avalanche con sus stablecoins.
