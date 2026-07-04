# Work Item — [WKH-138] Embedded agent-wallet + gasless beyond Kite (Avalanche/Base)

> Nota de numeración: este ítem es **Jira WKH-138** del roadmap OKX Wave 2
> (`doc/competitive/attack-plan-2026-07.md`). NNN de este SDD = **140**
> (asignado explícitamente por el orquestador; 139 no existe como carpeta SDD).

## Resumen
La HU original pide DOS cosas en un solo ticket P1/L: (1) una **wallet
embebida** para usuarios finales (email/passkey → wallet EIP-7702, con
signing separado de custodia) y (2) **gasless más allá de Kite** en
Avalanche/Base. Grounding contra el código confirma que hoy:

- **No existe ningún concepto de wallet embebida ni custodia de terceros.**
  El modelo de identidad actual es 100% BYO-wallet: el usuario firma con su
  propia EOA (`funding_wallet` en `a2a_agent_keys`, ancla exclusiva de
  `delegationService.create`, `src/services/delegation.ts:196-204`) y todo
  el resto (session keys, EIP-712 delegation, spend-policies) es
  autorización sobre esa EOA — nunca custodia de una clave privada de
  usuario.
- **Gasless SOLO existe para Kite** (`src/adapters/kite-ozone/gasless.ts`),
  vía un relayer propio EIP-3009 (`gasless.gokite.ai`) que firma con el
  `OPERATOR_PRIVATE_KEY` del operador y paga el gas. Avalanche y Base ya
  tienen la interfaz `GaslessAdapter` implementada pero como **stubs
  explícitos** que devuelven `501 gasless_not_supported_on_chain`
  (`src/adapters/avalanche/gasless.ts:9-15`, `src/adapters/base/gasless.ts:9-15`)
  — sus propios comentarios ya apuntan a "Biconomy/Gelato" y "CDP paymaster"
  como candidatos NO confirmados.
- `viem@2.53.1` (el `package.json` actual) YA trae soporte de EIP-7702
  (`node_modules/viem/account-abstraction/accounts/implementations/toSimple7702SmartAccount.ts`),
  pero **nada en `src/` lo usa hoy** — sería 100% construcción nueva, no una
  extensión de un patrón existente.

**Sizing honesto**: L + key-management (custodia de fondos de terceros) en
un solo ticket excede lo que un work item debe ser. Construir custodia
"casera" (MPC propio, derivación de claves desde passkey, etc.) sin
ratificación explícita del humano es un riesgo de seguridad inaceptable —
ver Constraint Directives. Esta HU se acota a un **v1 shippable y seguro**.

## v1 propuesto (acotado)
**Gasless en Avalanche/Base PRIMERO, SIN la wallet embebida.** Reutiliza el
patrón de defensa-en-profundidad ya shippeado en el path de Kite
(`src/routes/gasless.ts` + `src/adapters/*/gasless.ts` + `GaslessAdapter`
interface, `src/adapters/types.ts:100-105`) y llena los dos stubs
existentes con una implementación real. La wallet embebida (custodia,
EIP-7702, signing≠custody) queda **explícitamente fuera de este v1** y se
propone como HU separada (sugerido: WKH-138b) que NO puede arrancar sin que
el humano ratifique el modelo de custodia (ver Missing Inputs).

Razones para este recorte (no el inverso):
1. Cero superficie de custodia nueva — el mayor riesgo de seguridad de la
   HU original queda fuera.
2. Es una extensión directa de un patrón ya existente y ya revisado
   (Kite gasless, WKH-29/38/59/SEC-DRAIN-1) — no una construcción desde cero.
3. Cierra un gap real y citado en el análisis competitivo
   (`doc/competitive/okx-ai-analysis-2026-07.md` línea 26: "Gasless Gap —
   Avalanche/Base gasless missing").
4. Es shippeable con QUALITY completo (SDD + AR + CR) en un ciclo, a
   diferencia del alcance L original.

## Sizing
- SDD_MODE: full
- QUICK_FLOW: **QUALITY** (money-path — el operator wallet paga gas real;
  cualquier bug es drain de fondos, mismo dominio que WKH-59/SEC-DRAIN-1).
- Estimación: **M** (reducida desde L — el alcance original incluía la
  wallet embebida, que es la parte L/custodia; este v1 reutiliza interfaces
  y patrones ya existentes).
- Branch sugerido: `feat/140-wkh-138-gasless-avalanche-base`

## Skills Router
- `nexus-agile` (metodología, obligatoria)
- Dominio: money-path / key-management — mismo dominio que WKH-59
  (SEC-DRAIN-1, cap per-call antes del debit), WKH-104/086 (multi-chain
  adapters), WKH-101 (EIP-712 delegation). Reusar sus patrones de
  fail-closed + idempotencia, no reinventarlos. NO aplica ningún skill de
  custodia/MPC — ese dominio queda fuera de este v1 por diseño.

## Acceptance Criteria (EARS)

- AC-1: WHEN un caller autenticado con Agent Key invoca `POST
  /gasless/transfer` seleccionando `avalanche-fuji`, `avalanche-mainnet`,
  `base-sepolia` o `base-mainnet` (mecanismo de selección de chain
  **[NEEDS CLARIFICATION]** — hoy la ruta no recibe chain, ver Missing
  Inputs), the system SHALL ejecutar la transferencia sin exigir que el
  caller posea el token nativo de gas de esa chain, con el mismo contrato
  de respuesta (`{ txHash }`) que hoy usa Kite
  (`src/adapters/types.ts:57-59`).

- AC-2: WHEN una request de gasless transfer excede el cap por-call
  configurado (`GASLESS_DEFAULT_CAP_USD` o un override por chain — a
  definir en F2), the system SHALL rechazarla con `403 PER_CALL_LIMIT`
  ANTES de debitar el budget del Agent Key del caller — mismo orden que
  `gaslessCostEstimatorPreHandler` (`src/routes/gasless.ts:31-77`) impone
  hoy para Kite.

- AC-3: WHILE el `funding_state` del adapter gasless de una chain
  (Avalanche o Base) no es `'ready'` (`'unconfigured'` / `'unfunded'` /
  `'disabled'`), the system SHALL responder `503 gasless_not_operational`
  a cualquier intento de transfer en esa chain — mismo guard que
  `src/routes/gasless.ts:111-119` ya aplica.

- AC-4: WHEN `GET /gasless/status` se consulta para Avalanche o Base, the
  system SHALL reportar el `funding_state`/`operatorAddress`/
  `supportedToken` REAL de esa chain, reemplazando la respuesta hardcodeada
  actual (`enabled: false, funding_state: 'disabled'`,
  `src/adapters/avalanche/gasless.ts:39-50`,
  `src/adapters/base/gasless.ts:38-49`).

- AC-5: IF el estimador de costo de un transfer gasless en Avalanche/Base
  usa una conversión de precio/decimales incorrecta para el token de esa
  chain (hoy `pyusdWeiToUsd`, `src/lib/price.ts:94-102`, es
  PYUSD-específico — Avalanche/Base settlean USDC, no PYUSD), THEN the
  system SHALL rechazar la request (fail-closed) en vez de aplicar un cap
  mal calculado — previene la clase de bug de WKH-59/SEC-DRAIN-1
  (subvaluación → drain del operator wallet) en la chain nueva.

- AC-6: the system SHALL NOT introducir en esta HU ningún código de
  custodia de llaves privadas de usuario final, derivación de claves desde
  passkey, ni contrato/authorization EIP-7702 — ese alcance queda
  explícitamente fuera (Scope OUT) y diferido a una HU separada pendiente
  de ratificación humana del modelo de custodia.

## Scope IN
- `src/adapters/avalanche/gasless.ts` — reemplazar el stub
  (`AvalancheGaslessAdapter.transfer` hoy siempre `throw
  GaslessNotSupportedError`) por una implementación real.
- `src/adapters/base/gasless.ts` — mismo reemplazo para
  `BaseGaslessAdapter`.
- `src/routes/gasless.ts` — hoy `getGaslessAdapter()` no recibe `chainKey`
  (usa el default chain del proceso, `src/adapters/registry.ts:182-184`);
  para soportar Avalanche/Base necesita selección explícita de chain
  (header `x-payment-chain` vía `resolveChainKey`,
  `src/adapters/chain-resolver.ts:77-88`, mismo patrón que
  `x402`/`compose` ya usan) — mecanismo exacto a definir en F2.
- `src/lib/price.ts` — extender (o crear un hermano chain-aware) para no
  asumir PYUSD/6-decimales en chains que settlean USDC.
- `src/adapters/types.ts` (`GaslessAdapterStatus`) — si el status por-chain
  requiere campos nuevos (p. ej. distinguir USDC de PYUSD en
  `supportedToken`).
- Documentación operativa (fondeo del operator wallet en Avalanche/Base,
  mismo espíritu que `doc/architecture/CHAIN-ADAPTIVE.md` ya referenciado
  en los `documentation` fields de los stubs).

## Scope OUT
- **Wallet embebida** (email/passkey → wallet) — cualquier código de
  custodia, MPC, derivación de clave desde passkey, o integración con un
  proveedor de wallet-as-a-service (Privy/Turnkey/Dynamic/etc.). Diferido a
  HU separada (sugerido WKH-138b), bloqueada hasta ratificación humana del
  modelo de custodia.
- **EIP-7702** (upgrade de EOA a smart account, authorization delegation) —
  fuera de este v1 en su totalidad; solo aplica al alcance de wallet
  embebida diferido.
- Session keys / spend-policies / EIP-712 delegation — ya existen
  (`src/services/delegation.ts`) y no se modifican en esta HU.
- Pagos IM-native / QR (WhatsApp/Telegram) — HU separada, Jira **WKH-137**
  del mismo roadmap (Wave 2).
- Cualquier trabajo en repos consumidores (Chaski/yarvis, wasiai-v2) — este
  repo es el gateway neutral; si la wallet embebida eventualmente requiere
  un SDK de un proveedor externo, es probable que viva en el consumidor, no
  acá (ver Missing Inputs).

## Decisiones técnicas (DT-N)
- DT-1: El v1 reusa EXACTAMENTE la misma interfaz `GaslessAdapter`
  (`src/adapters/types.ts:100-105`) que Kite ya implementa — Avalanche/Base
  solo reemplazan el cuerpo de `transfer()`/`status()`, sin tocar el
  contrato que consume `src/routes/gasless.ts`.
- DT-2: El mecanismo gasless concreto por chain (relayer propio estilo
  EIP-3009/Kite, paymaster ERC-4337, o un proveedor tipo Biconomy/Gelato —
  los tres ya mencionados como candidatos no confirmados en los comentarios
  de los stubs actuales) se decide en F2 por Architect — el Analyst NO
  elige arquitectura de pagos.
- DT-3: Si F2 decide un relayer propio (mismo patrón que Kite), el
  `OPERATOR_PRIVATE_KEY` actual (el wallet que ya paga gas en Kite/Base
  para settlement x402, ver memoria `kite-relayer-gas-drain.md`) es
  candidato natural a reusarse para gasless también — pero requiere validar
  fondeo/alertas de balance por chain de forma independiente (no compartir
  balance sin contabilidad separada entre "gas para settle x402" y "gas
  para gasless transfer").
- DT-4: La wallet embebida (fuera de scope) NO se decide en este documento
  — cualquier DT sobre custodia pertenece a la HU separada, después de que
  el humano ratifique el proveedor/modelo (Missing Inputs #1).

## Constraint Directives (CD-N)
- CD-1: **PROHIBIDO** construir custodia de llaves privadas de usuario
  final (MPC casero, derivación de clave desde passkey, almacenamiento de
  seed phrases) en cualquier alcance de esta HU o su sucesora sin un
  proveedor de custodia auditado y probado en producción, ratificado
  explícitamente por el humano en una HU separada. Ninguna implementación
  in-house de custodia se acepta.
- CD-2: **OBLIGATORIO** que cualquier nuevo path de gasless en
  Avalanche/Base reutilice el mismo patrón de defensa-en-profundidad que
  Kite: (a) cap per-call ANTES del debit
  (`gaslessCostEstimatorPreHandler`), (b) `requirePaymentOrA2AKey` para
  auth+debit, (c) gate de `funding_state` (`503` si no `'ready'`), (d) log
  estructurado del resultado (`src/routes/gasless.ts:128-138`). PROHIBIDO
  exponer un endpoint gasless nuevo que bypasee `requirePaymentOrA2AKey`.
- CD-3: **OBLIGATORIO** manejo chain-aware de token/decimales — PROHIBIDO
  reusar `pyusdWeiToUsd` (`src/lib/price.ts:94-102`) sin adaptarlo o
  reemplazarlo por chain; Avalanche/Base mueven USDC (6 decimales) bajo un
  rate y símbolo distintos a PYUSD. Ver AC-5 (fail-closed si el precio no
  se puede calcular con certeza para esa chain).
- CD-4: **PROHIBIDO** hardcodear ninguna nueva private key, endpoint de
  relayer/paymaster, o URL de proveedor externo — toda config nueva vía env
  vars (Golden Path, CLAUDE.md "Sin hardcodes").
- CD-5: **PROHIBIDO** introducir EIP-7702 authorization/delegation en
  producción en el alcance de esta HU. Si en el futuro se aborda (HU
  separada), requiere: (a) confirmar soporte real del chain objetivo
  (Avalanche C-Chain / Base, mainnet vs testnet — hoy sin confirmar en este
  repo) y (b) una revisión de seguridad dedicada — una delegation mal
  implementada puede dejar la EOA del usuario bajo control de un contrato
  malicioso.
- CD-6: **OBLIGATORIO** que AR verifique, citando archivo:línea, que el
  nuevo código de Avalanche/Base gasless NO introduce ningún endpoint,
  campo, o flag que permita a un caller controlar directamente la wallet
  que paga (`OPERATOR_PRIVATE_KEY`) o su destino sin pasar por el cap +
  debit existente — mismo espíritu que el guard de WKH-59/SEC-DRAIN-1.

## Missing Inputs
- **[NEEDS CLARIFICATION — bloqueante para la HU de wallet embebida, NO
  para este v1]** Modelo de custodia: ¿MPC (ej. proveedor tipo
  Web3Auth/Fireblocks), passkey-derived (ej. WebAuthn + secure enclave), o
  un wallet-as-a-service tipo Privy/Turnkey/Dynamic? El humano no
  especificó proveedor. **NO construir custodia casera sin esta
  ratificación.**
- **[NEEDS CLARIFICATION — bloqueante para la HU de wallet embebida]** Qué
  hace EIP-7702 concretamente en este contexto (¿upgrade de la EOA del
  usuario a smart account para permitir sponsored/batched tx?) y si el
  chain objetivo (Avalanche C-Chain, Base — mainnet y/o testnet) ya soporta
  EIP-7702 en producción hoy. `viem@2.53.1` trae el primitivo
  (`toSimple7702SmartAccount`) pero eso no confirma soporte del chain.
- **[NEEDS CLARIFICATION — bloqueante para F2 de este v1]** Mecanismo
  gasless concreto por chain: relayer propio estilo EIP-3009 (patrón
  Kite/`gasless.gokite.ai`), paymaster ERC-4337, o un proveedor externo
  (Biconomy/Gelato, ya mencionados en los stubs actuales como candidatos no
  confirmados). Sin esto, Architect no puede escribir el SDD.
- **[NEEDS CLARIFICATION]** Quién paga el gas y cómo se previene
  drain/abuso más allá del cap actual: ¿el `OPERATOR_PRIVATE_KEY` existente
  (0xf432, ya paga gas en Kite/Base para settlement x402) asume también
  Avalanche/Base gasless, o se separa un wallet dedicado por chain con
  fondeo y alertas independientes? Impacta contabilidad de gas y el riesgo
  de agotamiento cruzado entre settle x402 y gasless transfer.
- **[NEEDS CLARIFICATION]** Si la wallet embebida (fuera de este v1)
  eventualmente se construye: ¿vive en `wasiai-a2a` (gateway neutral) o en
  un repo consumidor (Chaski/yarvis, wasiai-v2)? Un proveedor SaaS de
  wallet-as-a-service normalmente se integra del lado de la app
  consumer-facing, no del gateway — pero el humano no lo especificó.
- **[NEEDS CLARIFICATION — no bloqueante para F2 de este v1, sí para el
  Scope IN exacto]** Selección de chain en `POST /gasless/transfer`: hoy la
  ruta no recibe ningún parámetro de chain (usa el default del proceso).
  ¿Se agrega vía header `x-payment-chain` (mismo patrón que x402/compose),
  vía body, o vía un endpoint por-chain separado?

## Análisis de paralelismo
- No bloquea ni es bloqueado por WKH-137 (IM/QR, mismo Wave 2) —
  transportes distintos (IM/QR toca `routes`/mensajería, esta HU toca
  `adapters/*/gasless.ts` y `lib/price.ts`); pueden correr en paralelo sin
  conflicto de archivos.
- No bloquea Wave 1 (WKH-135 intents, WKH-136 splits — ya DONE, filas 137-138
  de `_INDEX.md`) ni Wave 3 (WKH-139 dispute/escrow, WKH-141 bridge APP) —
  ejes técnicos independientes (gasless vs fee-splitting vs disputas).
- La HU de wallet embebida (diferida, sugerida WKH-138b) SÍ depende de este
  documento como precedente de scoping, pero NO depende técnicamente del
  v1 de gasless — podrían decidirse en paralelo una vez que el humano
  ratifique el modelo de custodia, aunque se recomienda resolver primero el
  v1 de gasless (menor riesgo, mayor certeza de shippeo) antes de abrir la
  conversación de custodia.
