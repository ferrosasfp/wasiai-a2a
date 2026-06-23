# Runbook — Activar el escrow no-custodial (las 3 cadenas) — paso humano supervisado

> El contrato está deployado + verificado + e2e-probado on-chain en las **3 cadenas**. La migración del receipt_type ya está aplicada a prod. Falta SOLO activar el flag en Railway (cambia el comportamiento de `/deposit`). El clasificador de auto-mode bloquea este paso desde contexto autónomo/loop — lo hacés vos (dashboard) o agregás una regla de permiso de Bash.

## Direcciones del escrow (proxy UUPS) — listas
| Cadena | chainId | Env var | Dirección |
|--------|---------|---------|-----------|
| Base Sepolia | 84532 | `A2A_ESCROW_CONTRACT_BASE` | `0x31C4C460C549C152088E2576BE145AA5C25bB462` |
| Avalanche Fuji | 43113 | `A2A_ESCROW_CONTRACT_AVALANCHE` | `0x463A03c07dC370690f94d09A60f2Bf22A966C5dE` |
| Kite Ozone | 2368 | `A2A_ESCROW_CONTRACT_KITE` | `0x149D814e065DC8eb35E297eC36FAcfeEd204A102` |

Todas: owner/operator = `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` (EOA testnet), MIN_TIMELOCK 2d, typehash `0x5feea6...` (converge con 126b). Verificadas en sus explorers, e2e on-chain OK.

## Paso 1 — Setear env vars en Railway (vía dashboard, lo más simple)
Railway → proyecto wasiai-a2a → servicio → **Variables** → agregar:
- `ESCROW_MODE_ENABLED` = `true`
- `A2A_ESCROW_CONTRACT_BASE` = `0x31C4C460C549C152088E2576BE145AA5C25bB462`
- `A2A_ESCROW_CONTRACT_AVALANCHE` = `0x463A03c07dC370690f94d09A60f2Bf22A966C5dE`
- `A2A_ESCROW_CONTRACT_KITE` = `0x149D814e065DC8eb35E297eC36FAcfeEd204A102`

Guardar → Railway redeploya. Gracias a WKH-126c, cada cadena usa escrow SOLO si tiene su contrato configurado (las 3 lo tienen) y treasury en cualquier otra.

⚠️ Tras activar, los depósitos en estas cadenas esperan ir al CONTRATO (no a la treasury). Si hay un flujo treasury vivo (ej. widget wasiai.io), coordinar.

## Paso 2 — E2E HTTP del gateway (cierra el círculo, lo corro yo o vos)
1. `POST /auth/agent-signup {owner_ref}` → `key` + `key_id`.
2. `POST /auth/funding-wallet` bindeando la wallet con fondos (proof-of-control).
3. `keyId = keccak256(utf8Bytes(key_id))`.
4. On-chain: `approve` + `deposit(keyId, monto)` al proxy de la cadena.
5. `POST /auth/deposit { key_id, chain_id, tx_hash }` → budget acreditado.
6. Verificar balance acreditado. ✅ Círculo cerrado HTTP↔contrato.

(La verificación core `verifyEscrowDeposit` ya se probó contra un evento real on-chain → PASS.)

## Rollback
Railway: `ESCROW_MODE_ENABLED=false` (instantáneo, vuelve a treasury). Contratos: `..._down.sql` / no se borran (quedan deployados).

## Para que el agente (Claude) lo haga
Agregar una regla de permiso de Bash para el endpoint de Railway (`backboard.railway.app/graphql`) en settings, o autorizar explícitamente fuera del contexto /loop.

## Prerequisitos MAINNET (no testnet)
Auditoría externa profesional · owner = multisig (no EOA) · decisión del lock optimista (DT-11, griefing) · re-deploy con esos cambios.
