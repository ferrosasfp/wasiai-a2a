# Work Item — [WKH-71] Operator Wallet — Auto-Alert Below Threshold + Funding Runbook

## Resumen

Detectar y alertar automáticamente cuando un wallet operador/relayer se queda
sin fondos de gas ANTES de que rompa settles en silencio, y documentar el
runbook de fondeo. El incidente de hoy (2026-07-05: el settle wallet del
facilitator se secó — 0 AVAX Fuji — y Chaski mostró "$0 · done" durante ~6h
sin alerta, ver memoria `chaski-facilitator-fix-2026-07-05`) es el escenario
exacto que este ticket (mayo 2026) predijo. El ticket original hablaba de
USDC mainnet; el ecosistema hoy corre en **testnet + gas nativo multi-chain**
(Fuji 43113, Kite 2368, Base Sepolia 84532), así que las ACs se actualizan a
esa realidad.

## Sizing

- SDD_MODE: mini (monitor nuevo + wiring de error + doc), con AR obligatorio
  por tocar `src/services/fee-charge.ts` (money-path adyacente)
- Estimación: **FAST+AR** (recomendado por el ticket original; el Architect
  puede escalar a QUALITY en F2 si el diseño del monitor multi-wallet resulta
  más acoplado de lo previsto — ver Missing Inputs)
- Branch sugerido: `feat/149-wkh-71-operator-wallet-alert`

## Acceptance Criteria (EARS)

- **AC-1**: WHEN el balance nativo de gas de un wallet monitoreado cae por
  debajo de su umbral CRÍTICO configurado para esa chain, the system SHALL
  disparar un webhook de alerta severidad `critical` vía
  `mcp-servers/wasiai-x402/src/alerts.mjs::sendAlert()` (reusando el cliente
  existente — Slack/Discord auto-detectado, fail-open, timeout 5s, sin
  retries).
- **AC-2**: WHEN el balance nativo de gas de un wallet monitoreado cae por
  debajo de su umbral WARNING (pero sigue por encima del CRÍTICO) para esa
  chain, the system SHALL disparar la misma alerta con severidad `warning`.
- **AC-3**: IF una operación de firma/transferencia on-chain que usa
  `OPERATOR_PRIVATE_KEY` dentro de `wasiai-a2a` (p.ej. `chargeProtocolFee` en
  `src/services/fee-charge.ts`, o el flujo gasless en
  `src/lib/gasless-signer.ts`) falla porque el wallet operador no tiene gas
  suficiente, THEN the system SHALL retornar/loguear un error explícito
  identificable (p.ej. razón `operator-funding-low` / mensaje "operator
  funding low") en vez de propagar el error crudo de viem/RPC
  (`insufficient funds for gas` genérico, timeout, o un 500 sin contexto).
- **AC-4**: the system SHALL documentar en un runbook (nuevo doc o extensión
  de `doc/operations/identities-runbook.md`) el funding workflow por wallet:
  qué wallet, en qué chain, umbral mínimo operativo, monto recomendado de
  recarga, faucet/fuente de fondeo, y el procedimiento paso a paso.
- **AC-5**: the system SHALL ejecutar el chequeo de balance vía un cron
  periódico (reusando la infraestructura `cron-job.org` + `setup-cronjob.mjs`
  ya existente; cadencia 15 min heredada de `wasiai-x402-balance-check`, más
  frecuente que el 1h del ticket original) que lee balances vía RPC público
  (lectura zero-cost, sin firmar transacciones).
- **AC-6**: WHILE el monitor está configurado con N wallets × M chains (vía
  env, sin redeploy de código para agregar una entrada), the system SHALL
  reportar/alertar cada combinación wallet+chain de forma independiente
  (un wallet por debajo de umbral en una chain no debe silenciar ni mezclar
  el estado de otro wallet/chain).

## Scope IN

- Nuevo módulo de balance-check multi-wallet / multi-chain de **gas
  nativo** en `mcp-servers/wasiai-x402/` (mismo patrón que
  `api/cron/balance-check.mjs` existente: reusa `src/alerts.mjs`,
  `src/kv-client.mjs`, `src/log.mjs`, `src/cron-auth.mjs`). Este es un
  módulo NUEVO y separado del `balance-check.mjs` actual (que chequea USDC
  ERC-20 del operador del **MCP** en Avalanche mainnet — un concern
  distinto, ver DT-5).
- Configuración vía env de los wallets/chains a monitorear: al menos
  `0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c` (settle wallet del
  facilitator, dirección pública, solo lectura) en Fuji/Kite/Base Sepolia
  donde aplique, y `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` (operador
  de `wasiai-a2a`, `OPERATOR_PRIVATE_KEY`) en las chains donde firma.
- Umbrales WARNING/CRITICAL por chain, configurables vía env, con defaults
  conservadores testnet.
- Wiring de la alerta al `sendAlert()` existente (severity `critical` /
  `warning`).
- Extensión de `scripts/setup-cronjob.mjs` para registrar el nuevo cron
  (o agregarlo al job existente si el diseño de F2 lo justifica).
- AC-3: manejo explícito del error de gas insuficiente en los puntos de
  `wasiai-a2a` donde `OPERATOR_PRIVATE_KEY` firma/transfiere on-chain
  (`src/services/fee-charge.ts`, `src/lib/gasless-signer.ts` y cualquier
  adapter de settle que use ese wallet).
- Runbook de funding (nuevo `doc/operations/*.md` o extensión de
  `identities-runbook.md`).

## Scope OUT

- **Auto-replenish** / auto-funding automático de wallets — decisión de
  tesorería explícitamente fuera de este ticket.
- Cambios en el repo **wasiai-facilitator** (dueño real del wallet
  `0x9c0638...` que se secó hoy) — ese repo no está en este workspace. Si
  se quiere el mismo error explícito (AC-3) del lado del facilitator
  (donde ocurrió el incidente real), requiere una HU companion en ese
  repo — fuera de scope de este work-item.
- El `balance-check.mjs` existente (USDC mainnet del operador MCP) — no se
  modifica, queda intacto.
- Cambios al payment/settle core (`compose.ts`, `orchestrate.ts`,
  `fee-split.ts`) más allá de envolver el error de gas insuficiente en un
  mensaje explícito — no se toca la lógica de negocio de fees/splits.
- Oracle de precio USD para los umbrales — se usa gas nativo directo (AVAX
  / ETH / KITE), sin conversión a USD.
- Mainnet — todo el alcance es testnet (Fuji, Kite testnet, Base Sepolia).

## Decisiones técnicas (DT-N)

- **DT-1**: Umbrales en **gas nativo por chain** (no USD-equivalente). Un
  RPC público de solo-lectura no trae precio; agregar un price-feed sería
  scope creep para una HU de alerta operacional. Cada chain define su
  propio par de env vars `WALLET_ALERT_THRESHOLD_<CHAIN>_WARNING` /
  `..._CRITICAL` en unidades nativas.
- **DT-2**: Lista de wallets a monitorear vía **config explícita en env**
  (no discovery dinámico ni lectura de otro repo) — cada entrada es
  `{label, address, chainIds[]}`. Extensible a N wallets sin tocar código.
- **DT-3**: AC-3 se implementa **solo dentro de `wasiai-a2a`**, en los
  puntos donde el código de este repo firma/transfiere con
  `OPERATOR_PRIVATE_KEY`. El gap real del incidente de hoy (facilitator
  wallet sin gas) vive en `wasiai-facilitator` y queda fuera — ver Scope
  OUT y Missing Inputs.
- **DT-4**: Cadencia del cron: se **reusa el intervalo de 15 min** ya
  provisto por `wasiai-x402-balance-check` en `cron-job.org` en vez de
  crear un cron nuevo de 1h (el ticket original pedía 1h; 15 min ya existe
  y es más seguro).
- **DT-5**: El nuevo monitor vive en un **módulo separado** del
  `balance-check.mjs` actual (que sigue siendo el check de USDC-spend del
  operador MCP en Avalanche mainnet — un concern distinto de "el relayer
  tiene gas para settlear"). Mezclarlos en el mismo archivo confundiría dos
  invariantes distintos.

## Constraint Directives (CD-N)

- **CD-1**: OBLIGATORIO reusar `mcp-servers/wasiai-x402/src/alerts.mjs::sendAlert()`
  (WKH-90/91) para el envío del webhook. PROHIBIDO crear un segundo cliente
  de alertas o duplicar la lógica de formato Slack/Discord.
- **CD-2**: PROHIBIDO loggear, incluir en el body del webhook, o exponer de
  cualquier forma private keys / secrets del operador. Solo direcciones
  públicas (`0x...`) y balances numéricos — mismo whitelist `ALLOWED_BODY_KEYS`
  de `alerts.mjs` (CD-12 histórico).
- **CD-3**: OBLIGATORIO que el chequeo de balance sea una **lectura RPC
  pública de costo cero** (`getBalance` / equivalente viem read-only).
  PROHIBIDO firmar transacciones o gastar gas para monitorear.
- **CD-4**: El comportamiento fail-open de `sendAlert()` (timeout 5s, nunca
  lanza excepción, sin retries) DEBE preservarse intacto. El monitor NUNCA
  debe romper el cron (siempre responde 200) ni el settle path si el
  webhook falla.
- **CD-5**: PROHIBIDO modificar la lógica de negocio de fees/splits en
  `src/services/fee-charge.ts` / `src/services/fee-split.ts` más allá de
  envolver el error de gas insuficiente en un mensaje/reason explícito.
  `chargeProtocolFee` DEBE seguir sin rechazar la promise (invariante
  existente, CD-B histórico de WKH-44).
- **CD-6**: PROHIBIDO hardcodear direcciones de wallets o umbrales en
  código — todo vía env vars con defaults documentados en `.env.example`
  (mismo patrón que `MCP_BALANCE_THRESHOLD_USDC`).

## Missing Inputs

- `[NEEDS CLARIFICATION]` Valores exactos de umbral WARNING/CRITICAL por
  chain (en unidades nativas AVAX/ETH/KITE) — F2 propondrá defaults
  conservadores testnet-appropriate; ajustables por env sin redeploy.
- `[NEEDS CLARIFICATION]` Confirmar que agregar el settle wallet del
  facilitator (`0x9c0638...`, dirección pública) como entrada de config en
  este monitor NO requiere ningún cambio en el repo `wasiai-facilitator`
  (solo lectura RPC de una dirección pública) — asumido SÍ, a validar en F2.
- `[bloqueante potencial, NO bloquea este work-item]` Si el humano quiere
  el mismo error explícito (AC-3) del lado del facilitator (donde ocurrió
  el incidente real de hoy), eso requiere una HU companion en el repo
  `wasiai-facilitator`, fuera de este workspace y de este work-item.

## Análisis de paralelismo

- No bloquea otras HUs activas del roadmap (splits, arbiter, APP bridge,
  Tempo rail — todas DONE/cerradas al momento de este F1).
- Puede correr en paralelo con cualquier HU que no toque
  `src/services/fee-charge.ts`, `src/lib/gasless-signer.ts`, o
  `mcp-servers/wasiai-x402/{src,api,scripts}` — tocar esos mismos archivos
  en simultáneo generaría conflicto de merge en el único punto money-path
  compartido (AC-3).
- El monitor nuevo (AC-1/2/5/6) es aditivo y desacoplado — no bloquea nada
  ni depende de nada del roadmap actual.
