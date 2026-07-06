# Operator / Relayer Gas Funding Runbook — WKH-71

Cómo mantener con gas nativo a los wallets que firman/transfieren on-chain en
el ecosistema WasiAI (testnet). Complementa `identities-runbook.md` (identidades
y claves); acá el foco es **fondeo de gas** y la **respuesta a la alerta** del
monitor automático.

## Por qué existe (incidente 2026-07-05)

El settle wallet del facilitator (`0x9c0638…`) se quedó en **0 AVAX Fuji** y los
settles empezaron a fallar en silencio: Chaski mostró "$0 · done" durante ~6h sin
ninguna alerta. Este runbook + el monitor `api/cron/gas-balance-check.mjs`
(WKH-71) existen para que eso **avise antes** de romper, y para que cualquiera de
guardia sepa recargar en minutos.

El monitor NO recarga solo (auto-replenish está fuera de scope — decisión de
tesorería). Dispara un webhook `warning`/`critical`; la recarga es manual siguiendo
esta guía.

## Wallets monitoreados

| Wallet | Rol | Firma / paga gas en | Fuente de la clave |
|--------|-----|---------------------|--------------------|
| `0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c` | Settle wallet del **facilitator** | Fuji 43113 / Kite 2368 / Base Sepolia 84532 (donde settlea x402) | repo `wasiai-facilitator` (fuera de este workspace) |
| `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` | Operador del **gateway** (`OPERATOR_PRIVATE_KEY`) | Fuji 43113 / Base Sepolia 84532 (writeContract gasless) / Kite 2368 (firma) | `OPERATOR_PRIVATE_KEY` de `wasiai-a2a` |

> Solo se listan **direcciones públicas**. Las claves privadas NUNCA van en config,
> logs ni en el body de la alerta (CD-2). El monitor solo hace `getBalance`
> read-only (CD-3).

## Umbrales operativos (gas nativo, por chain)

Configurables por env sin redeploy (`WALLET_ALERT_THRESHOLD_<CHAIN>_{WARNING,CRITICAL}`,
ver `.env.example`). Defaults conservadores testnet:

| Chain | chainId | Símbolo | WARNING (recargar pronto) | CRITICAL (recargar YA) | Recarga recomendada | Faucet / fuente |
|-------|---------|---------|---------------------------|------------------------|---------------------|-----------------|
| Avalanche Fuji | 43113 | AVAX | 0.5 | 0.1 | **2 AVAX** | https://faucet.avax.network (Fuji C-Chain) |
| Kite testnet | 2368 | KITE | 0.5 | 0.1 | **2 KITE** | Faucet Kite (captcha-gated) — ver identities-runbook |
| Base Sepolia | 84532 | ETH | 0.05 | 0.01 | **0.05 ETH** | https://www.alchemy.com/faucets/base-sepolia; o bridge Sepolia→Base vía L1StandardBridge `0xfd0Bf71F60660E2f608ed56e1659C450eB113120` |

`WARNING` = margen para varios días de settles; `CRITICAL` = riesgo inminente de
que el próximo settle falle con `insufficient funds for gas`.

## Procedimiento de recarga (paso a paso)

1. **Identificar** de la alerta: `label`, `operator` (address), `chainId`,
   `balanceNative`, `symbol`, `severity`.
2. **Confirmar** el balance on-chain:
   - Fuji: https://testnet.snowtrace.io/address/&lt;address&gt;
   - Kite: explorer testnet Kite.
   - Base Sepolia: https://sepolia.basescan.org/address/&lt;address&gt;
3. **Obtener fondos** del faucet/fuente de la tabla (monto recomendado). Para
   Base Sepolia, si el faucet da ETH-Sepolia (L1), bridgear con el
   `L1StandardBridge` indicado (pasar gas explícito).
4. **Enviar** al `operator` address exacto de la alerta. Verificar chainId ANTES
   de enviar (no confundir Fuji con C-Chain mainnet 43114).
5. **Verificar** que el balance quedó por encima del umbral `WARNING`.
6. **Cerrar**: en el próximo tick (≤15 min) el monitor deja de alertar. Si querés
   confirmar ya, invocá el cron manualmente:
   `GET /api/cron/gas-balance-check` con header `Authorization: Bearer $CRON_SECRET`.

## Wallet del facilitator (`0x9c0638…`)

Vive en el repo `wasiai-facilitator` (fuera de este workspace). Este monitor
**solo lo lee** (dirección pública). La recarga es la misma (faucet → address).
Si además se quiere el error explícito `operator-funding-low` del lado del
facilitator cuando firma, eso requiere una HU companion en ese repo (Scope OUT
de WKH-71).

## Señal `operator-funding-low` (AC-3)

Dentro de `wasiai-a2a`, cuando una firma/transfer con `OPERATOR_PRIVATE_KEY`
falla por falta de gas, el error crudo de viem se re-etiqueta como
`operator-funding-low` en logs y mensajes (en `src/services/fee-charge.ts` y en
los adapters gasless de `src/adapters/{avalanche,base}/gasless.ts`). Si ves ese
reason en los logs, es la misma causa: **recargá gas** del operador en la chain
correspondiente siguiendo la tabla de arriba.

## Registro del cron

El job `wasiai-x402-gas-balance-check` se registra con
`npm run setup:cronjob` (script `scripts/setup-cronjob.mjs`), cadencia 15 min,
autenticado con `CRON_SECRET` (Bearer). Idempotente por título.
