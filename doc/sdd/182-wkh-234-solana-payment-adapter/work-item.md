# Work Item — [WKH-234] PaymentAdapter Solana en el gateway (payTo base58 + settle on-chain)

> Título Jira: HU-SOL-28 · PaymentAdapter Solana en el gateway (payTo base58 + settle on-chain) — habilita agentes Solana-native
> RE-SCOPE 2026-07-24 (post evaluación profunda de código). Nombre original ("discovery multichain") era incorrecto.

## Resumen

Habilitar el **pago/settle del fee del agente** en Solana devnet dentro del gateway `wasiai-a2a` (hoy 100% EVM-shaped: Kite/Avalanche/Base/Tempo). El **discovery YA encuentra** agentes Solana (la selección es por slug/capabilities/precio/reputación, chain-agnóstica — `discovery.ts` no descarta agentes con `payment:undefined`); el bloqueo real es la capa de dinero: `ChainKey`, `PaymentAdapter`, el resolver de slugs, el validador de wallet y el settle per-leg son todos EVM-shaped (`0x…`, EIP-3009/712, `chainId:number`). Esta HU construye el rail Solana nuevo — completo, código de producción, devnet, cero dinero real — para que un agente Solana-native pueda publicarse con `payout_wallet` base58 y cobrar su fee vía SPL-token transfer real y verificado on-chain.

Nota explícita: el money-path del **principal** de la remesa en Solana (escrow/deposit/release/gasless, facilitator+chaski) YA está HECHO y en estado HELD — esta HU es el pago del **fee del agente** dentro de `wasiai-a2a`, algo distinto.

## Sizing

- SDD_MODE: full
- Estimación: **L** (grande — B3 es un rail de pago nuevo completo, 1-3 semanas). Fuerte candidato a decomposición en sub-work-items en F2 (mismo patrón que el epic WKH-191, fila 172 de `_INDEX.md`, decompuesto en 8 sub-HUs).
- Sizing por sub-parte:
  - B1 (namespace/validador): **M**, 1-2 días
  - B2 (resolver + discovery): **S**, 0.5-1 día
  - B3 (AdaptersBundle Solana + settle real + wiring): **L**, 1-3 semanas
- Branch sugerido (epic-level): `feat/182-wkh-234-solana-payment-adapter`
  - Si el Architect decide decomponer en F2 (recomendado dado el tamaño de B3): `feat/182a-wkh-234a-solana-namespace`, `feat/182b-wkh-234b-solana-resolver`, `feat/182c-wkh-234c-solana-adapter-bundle`.

## Grounding (F0 — verificado línea por línea contra el código real, 2026-07-24)

| Cita del ticket | Verificado | Nota |
|---|---|---|
| `src/adapters/types.ts:135-142` (`ChainKey` unión EVM-only) | ✅ exacto | Unión literal `'kite-ozone-testnet' \| 'kite-mainnet' \| 'avalanche-fuji' \| 'avalanche-mainnet' \| 'base-sepolia' \| 'base-mainnet' \| 'tempo-testnet'`. Comentario `:124-134` documenta el invariante de seguridad `-mainnet` suffix (WKH-150/144) — CUALQUIER slug nuevo debe respetarlo. |
| `src/adapters/types.ts:80-93` (`PaymentAdapter` EVM-shaped) | ✅ exacto | `chainId:number`, `getToken():\`0x${string}\``, `sign(opts:{to:\`0x${string}\`,...})`. `SettleRequest`/`X402Proof` (`:11-27`) llevan `authorization: X402PaymentRequest['authorization']` (EIP-3009 shape) + `signature`. |
| `src/adapters/chain-resolver.ts:22-64` (`SLUG_ALIASES` sin 'solana') | ✅ exacto | Confirmado: `normalizeChainSlug('solana')` → `undefined` (ningún alias Solana en el record). |
| `src/types/index.ts:96` (`AgentPaymentSpec.contract: \`0x${string}\``) | ✅ exacto | Interface completa en `:93-98`. |
| `src/lib/wallet-format.ts:20,26` (`ADDRESS_RE` EVM-only) | ✅ exacto | `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` (línea 20), `isValidWallet` (línea 26-30). Comentario `:8-12` documenta que es la ÚNICA fuente de verdad (write-path publish + money-path fee-split) — "prohibido un validador paralelo". |
| `src/services/agent.ts:329` (publish guard) | ⚠️ ligero corrimiento (línea 330) | `assertValidPayoutWallet(input.payoutWallet)` está en la línea 330, no 329 (comentario WKH-143b en 328-329). Mismo efecto: rechaza wallets no-EVM en publish. |
| `src/services/discovery.ts:100-102` (`readPayment` descarta chain desconocida) | ✅ exacto | `if (normalizeChainSlug(chainRaw) === undefined) return undefined;` — defensa WKH-113 (SEC-AR BLQ-MED-1). Confirma que basta con registrar el slug Solana en el resolver para que discovery lo acepte (B2). |
| `src/adapters/deposit-verifier.ts:66-74` + familia | ✅ exacto (offsets `:66-83`) | `ChainFamily = 'KITE'\|'AVALANCHE'\|'BASE'\|'TEMPO'`; `resolveChainFamilyEnvSuffix` es un **switch exhaustivo** sobre `ChainKey` — TypeScript rompería la compilación si se agrega un `ChainKey` sin extender este switch (defensa a preservar, ver CD-5). |
| `src/routes/compose.ts:162,238` | ⚠️ los números de línea citados pertenecen a **`src/services/compose.ts`**, no a `src/routes/compose.ts` (que solo tiene 647 líneas y es el handler HTTP). Verificado en `src/services/compose.ts:162` (`stepGasOverhead`) y `:238` (`budgetService.debit(...)`). |
| `compose.ts:823-829,932` (settle per-leg) | ✅ exacto en `src/services/compose.ts` | `:823-829` = `adapter.sign({ to: payTo as \`0x${string}\`, value: valueWei })` (EIP-3009 sign). `:932` = `getPaymentAdapter().settle({...})`. Ambos EVM-shaped 100%. |
| `orchestrate.ts:484` | ⚠️ no encontrado | `src/routes/orchestrate.ts` tiene 468 líneas (no llega a 484). El chain-id/budget que el ticket referencia vive en `src/services/compose.ts` (`chainId:number`, líneas 162/238 arriba) — el patrón se repite ahí, no en `orchestrate.ts:484`. Corregido en Scope IN. |
| `downstream-payment.ts:155-200` | ✅ exacto | `src/lib/downstream-payment.ts:152-168` resuelve `chainKey = normalizeChainSlug(agent.payment.chain)` (fail-loud si no reconocido, CD-6 del propio archivo), `:170-182` valida `payTo`, `:197-224` resuelve el `PaymentAdapter` y calcula el monto atómico con los decimals del adapter. Confirmado: esta es la pieza que YA liquida cada leg en SU red (Avalanche/Base/Kite) por-agente — el patrón a extender para Solana. |

## Acceptance Criteria (EARS)

- **AC-1** (publish): WHEN un agente se publica vía `POST /agents` con `payout_wallet` en formato base58 (pubkey Solana, 32 bytes) y `chain` resuelto a un `ChainKey` de la familia Solana, the system SHALL aceptar el registro sin activar el guard EVM (`isValidWallet`/`ADDRESS_RE`), persistiendo el wallet en su formato nativo.
- **AC-2** (settle real): WHEN un pipeline (`/compose` o `/orchestrate`) incluye un leg cuyo `agent.payment.chain` resuelve a un `ChainKey` Solana (ej. `solana-devnet`), the system SHALL liquidar el fee de ESE leg on-chain en Solana devnet vía un SPL-token transfer real (broadcast + confirm — NO simulate-only), usando el `PaymentAdapter` Solana registrado en su `AdaptersBundle`.
- **AC-3** (per-leg multichain): WHEN un pipeline mezcla legs en Avalanche/Base/Kite y Solana, the system SHALL liquidar cada leg en SU propia red (Avalanche/Base/Kite ya funciona hoy vía `downstream-payment.ts:152-224`; Solana se agrega como una rama adicional del mismo patrón chain-aware, sin cross-chain implícito).
- **AC-4** (no-regresión, ubiquitous): WHILE un pipeline corre 100% en chains EVM ya existentes (Kite/Avalanche/Base/Tempo), the system SHALL producir comportamiento observable byte-idéntico al pre-HU (mismo monto debitado, mismo shape de response, la suite de tests EVM existente pasa sin modificar sus expectativas).
- **AC-5** (unwanted — base58 inválido): IF el `payout_wallet`/`payTo` declarado con chain Solana no es un base58 válido de 32 bytes (falla checksum/longitud), THEN the system SHALL rechazar la publicación o el leg con un error explícito (400/422, mismo patrón que el `WalletFormatError` EVM hoy), sin persistir ni intentar settle.
- **AC-6** (unwanted — namespace/chain desconocido): IF el chain slug declarado no resuelve a un `ChainKey` conocido (ni EVM ni Solana) vía `normalizeChainSlug`, THEN the system SHALL descartar el leg/agente con `CHAIN_NOT_SUPPORTED` — mismo comportamiento defensivo hoy vigente (`discovery.ts:102`, `downstream-payment.ts:157`), sin fallback silencioso a otra chain ni a un default.
- **AC-7** (unwanted — doble-settle/replay): IF el mismo leg Solana se reintenta cuando la transacción SPL ya fue confirmada on-chain previamente (mismo intent/nonce), THEN the system SHALL detectar la confirmación previa antes de firmar un nuevo transfer (verify-before-settle, mismo principio que `settle-verifier.ts`/`deposit-verifier.ts` en EVM) y SHALL NOT emitir un segundo transfer SPL para el mismo cobro.
- **AC-8** (ledger CAIP-2): WHEN se debita el budget de un Agent Key por un leg Solana, the system SHALL registrar el chain-id en formato CAIP-2 (`solana:<cluster-id>`) en el ledger, de forma aditiva — sin romper columnas/queries que hoy asumen `chainId:number` EVM-céntrico para los chains existentes.
- **AC-9** (seguridad, ubiquitous): the system SHALL preservar el ownership guard (`owner_ref`) en toda query/mutación sobre `a2a_agent_keys` que el nuevo ledger/budget Solana introduzca en `src/services/*.ts` (CLAUDE.md, obligatorio).
- **AC-10** (exhaustividad de switch, ubiquitous): the system SHALL mantener sin `any` y sin fallos de `tsc --noEmit` cualquier `switch` exhaustivo existente sobre `ChainKey` (ej. `resolveChainFamilyEnvSuffix` en `deposit-verifier.ts:68-82`) tras extender la unión con el/los slug(s) Solana — el compilador debe forzar la actualización de todos los switches, no permitir un `default` silencioso.

## Scope IN

- `src/adapters/types.ts` — extender `ChainKey` con slug(s) Solana devnet (respetando el invariante `-mainnet` suffix de WKH-150/144, ver DT-4/CD-4); generalizar (o envolver) `PaymentAdapter`/`SettleRequest`/`X402Proof`/`SignRequest` para admitir direcciones/firmas no-EVM sin romper los 6 adapters EVM existentes (decisión de forma exacta diferida a F2/Architect — ver Missing Inputs #4).
- `src/adapters/chain-resolver.ts` — nuevos entries en `SLUG_ALIASES` para Solana (devnet), siguiendo el mismo patrón puro/total (B2).
- `src/adapters/registry.ts` — extender el factory dispatcher para instanciar el `AdaptersBundle` Solana.
- `src/adapters/solana/` (NUEVO) — mismo patrón de carpeta que `src/adapters/avalanche/`: `chain.ts`, `payment.ts` (el `PaymentAdapter` real: sign+settle+verify SPL-transfer con `@solana/web3.js`/`@solana/spl-token`), `attestation.ts` (stub explícito, Solana no tiene el mismo patrón de attestation que EVM hoy — Scope OUT real attestation), `gasless.ts` (stub `enabled:false`, graceful degradation — ver Missing Inputs #3), `identity.ts` (bundle usa `identity: null`, tipo ya lo permite), `index.ts`.
- `src/lib/wallet-format.ts` — validador base58 nuevo (namespace-aware), preservando `isValidWallet`/`ADDRESS_RE` EVM byte-idénticos (CD-2).
- `src/types/index.ts` — `AgentPaymentSpec` namespace-aware (`contract` deja de ser exclusivamente `\`0x${string}\``).
- `src/services/agent.ts` — `assertValidPayoutWallet` (línea ~330) namespace-aware.
- `src/services/discovery.ts` — sin cambios de lógica esperados (`readPayment` ya es genérico una vez el resolver reconoce el slug — B2 lo destraba solo); verificar con test que un agente Solana-native pasa el filtro.
- `src/lib/downstream-payment.ts` — nueva rama chain-aware para Solana (settle per-leg downstream), espejo de la rama EVM existente (`:152-224`).
- `src/services/compose.ts` — nueva rama para el settle inbound por-leg cuando `chainKey` resuelve a Solana (espejo de `:800-940`, hoy 100% EVM-shaped: `payTo as \`0x${string}\``, `adapter.sign({to,value})`, `getPaymentAdapter().settle(...)`).
- `src/services/budget.ts` / ledger — esquema CAIP-2 aditivo para el chain-id de legs Solana (AC-8), preservando ownership guard `owner_ref` (AC-9).
- `.env.example` — nuevas env vars Solana (`SOLANA_RPC_URL`, `SOLANA_USDC_MINT_DEVNET`, `SOLANA_OPERATOR_PRIVATE_KEY`, etc. — nombres exactos a definir en F2).
- `package.json` — nuevas dependencias `@solana/web3.js` (v1), `@solana/spl-token`.

## Scope OUT

- **Deposit/funding de Agent Key balance vía Solana** (`deposit-verifier.ts` familia Solana) — el budget del caller se sigue fondeando en una chain EVM existente; esta HU solo cubre el SETTLE downstream del fee en Solana. Ver Missing Inputs #2.
- **Gasless/sponsored-tx en Solana** (fee-payer pattern real) — el `GaslessAdapter` Solana queda como stub `enabled:false` (mismo patrón de graceful degradation que WKH-38/WKH-138 "v1 acotado"). Ver Missing Inputs #3.
- **Identity binding Solana** (equivalente ERC-8004 — Solana Agent Registry, ver engram `solana-erc8004-equivalent-agent-registry.md`) — relacionado a WKH-238, explícitamente fuera de esta HU.
- **Mainnet Solana** — devnet-only, sin excepción (CD-4).
- **Money-path del PRINCIPAL de la remesa en Solana** (escrow/deposit/release/gasless de facilitator+chaski) — YA HECHO, HELD, en otro repo. Esta HU es el fee del AGENTE dentro de `wasiai-a2a`.
- **Dashboard/UI** — sin cambios visuales; a lo sumo un badge/label si el Architect lo considera trivial en F2 (no asumido acá).
- **Discovery ranking/relevance logic** — `discovery.ts` no se toca más allá de la verificación de que el filtro de chain ya-genérico acepta Solana; NO se reabre la cadena WKH-151/152/159/160 (HUs `in progress` sobre `orchestrate.ts` relevance, filas 157/160/161/162/163 de `_INDEX.md` — riesgo de conflicto de merge en `orchestrate.ts`, pero zona de código distinta: relevance vs chain-resolution).

## Decisiones técnicas (DT-N)

- **DT-1 (namespace/address modeling)**: usar CAIP-10 (`solana:<cluster-genesis-hash-corta>:<base58-pubkey>`) para representar cuentas Solana en `payTo`/`payout_wallet` cuando se requiera namespace explícito, y CAIP-2 (`solana:<cluster-id>`) para el chain-id del ledger — en vez de reusar `chainId:number` EVM. Justificación: Solana no tiene un "chainId" numérico estilo EVM; CAIP-2/10 es el estándar cross-chain ya referenciado en el enunciado del ticket y evita colisión con el espacio numérico EVM existente (`chainConfig.chainId:number` en `AdaptersBundle`).
- **DT-2 (SDK)**: `@solana/web3.js` v1 (`Connection`, `PublicKey`, `Transaction`) + `@solana/spl-token` (`getOrCreateAssociatedTokenAccount`, `createTransferInstruction`) para el transfer USDC-SPL. El SDK vive EXCLUSIVAMENTE en `src/adapters/solana/*` (infrastructure/adapter) — nunca importado desde `src/services/` ni `src/routes/` directamente (clean architecture, ports&adapters, mismo patrón que `viem` encapsulado en `src/adapters/{avalanche,base,kite-ozone}/`).
- **DT-3 (settle-verify model)**: Solana no tiene un facilitator x402/EIP-3009 nativo hoy (no hay meta-tx gasless estándar equivalente). El `PaymentAdapter.settle()` Solana construye+firma+broadcast+confirma la transacción SPL-transfer directamente con la keypair operador/relayer del gateway (custodial de ESE lado, análogo a como Avalanche/Base ya firman hoy con `OPERATOR_PRIVATE_KEY` — el fee del downstream agent siempre lo paga/firma el gateway, no el caller final). `verify()` lee la confirmación on-chain (`getSignatureStatus`/`getParsedTransaction`) contra el amount+destination esperado — mismo principio "verify-before-trust" que `settle-verifier.ts` en EVM. Asunción a ratificar (Missing Inputs #1).
- **DT-4 (forma de extender `PaymentAdapter`)**: la interfaz hoy es 100% EVM-shaped (`chainId:number`, `getToken():0x…`, `sign({to:0x…})`). Extenderla sin romper los 6 adapters EVM existentes ni introducir `any` requiere una decisión de diseño (tipos discriminados por chain-family vs wrapper con placeholder tipado) — **diferida explícitamente al Architect en F2**; el Analyst no prescribe la implementación.
- **DT-5 (attestation/identity Solana)**: `attestation.ts` Solana queda como stub explícito que lanza `NOT_IMPLEMENTED` (no un no-op silencioso) — evita falsos-verdes si algún caller asume attestation real. `identity: null` en el `AdaptersBundle` Solana (tipo ya lo permite, `IdentityBindingAdapter | null`).

## Constraint Directives (CD-N)

- **CD-1 (OBLIGATORIO, ownership guard)**: toda query/mutación sobre `a2a_agent_keys` que el ledger/budget Solana introduzca en `src/services/*.ts` DEBE filtrar por `owner_ref` además del `id`. Cualquier función nueva que reciba `keyId` DEBE incluir `ownerId: string` (no `string | undefined`) en su firma. (CLAUDE.md, obligatorio.)
- **CD-2 (OBLIGATORIO, byte-identidad EVM)**: ningún pipeline 100%-EVM (Kite/Avalanche/Base/Tempo) puede cambiar de comportamiento observable como consecuencia de esta HU — mismo monto, mismo shape de response, tests EVM existentes verdes sin modificar sus expectativas (AC-4).
- **CD-3 (PROHIBIDO hardcodes)**: prohibido hardcodear el cluster/chain-id de Solana devnet, el mint address de USDC-SPL-devnet, el RPC endpoint o cualquier keypair del operador — todo vía env vars con defaults sensatos, nombres nuevos documentados en `.env.example`. `SOLANA_OPERATOR_PRIVATE_KEY` (o equivalente) NUNCA en logs ni error messages (mismo patrón que `OPERATOR_PRIVATE_KEY` EVM).
- **CD-4 (PROHIBIDO mainnet)**: devnet-only, sin excepción — mismo patrón testnet-only explícito que Tempo (WKH-090) y el árbitro del escrow (WKH-191f, gated hasta ratificación humana separada). Cualquier slug Solana que se agregue a `ChainKey` NO debe usar el sufijo `-mainnet` (o debe, si algún día se agrega mainnet, respetar el invariante de seguridad documentado en `types.ts:124-134` — `isMainnetChainKey()` clasifica por ese sufijo y drivea el fail-closed de WKH-144).
- **CD-5 (OBLIGATORIO, exhaustividad de switch)**: todo switch exhaustivo existente sobre `ChainKey` (`resolveChainFamilyEnvSuffix` en `deposit-verifier.ts:68-82`, y cualquier otro que aparezca en F2) DEBE extenderse para el/los nuevo(s) slug(s) Solana — `tsc --noEmit` debe fallar si algún switch queda no-exhaustivo. Preservar esta defensa, no introducir un `default` silencioso que la anule.
- **CD-6 (PROHIBIDO simular en producción)**: el settle SPL debe ser un broadcast+confirm real on-chain en devnet — cero datos simulados en prod (Golden Path, CLAUDE.md).
- **CD-7 (OBLIGATORIO, clean architecture)**: `@solana/web3.js`/`@solana/spl-token` viven exclusivamente en `src/adapters/solana/*`; nunca importados desde `src/services/` ni `src/routes/` directamente (ports & adapters, mandato explícito del programa).

## Missing Inputs

1. **[NEEDS CLARIFICATION — bloqueante para F2]** ¿El settle del fee en Solana lo firma/paga el OPERADOR del gateway (custodial, mismo patrón que Avalanche/Base hoy — el caller nunca posee una wallet Solana en este flujo), o se espera que el CALLER firme directamente (requeriría un flujo de firma cliente-side distinto, ed25519, análogo pero no igual a EIP-712)? DT-3 asume "operador firma" por default — confirmar antes de F2.
2. **[NEEDS CLARIFICATION — no bloqueante, resoluble en F2]** ¿Queda en Scope IN de esta HU permitir que un caller FONDEE su Agent Key balance vía un depósito en Solana (`deposit-verifier.ts` familia Solana), o el budget del caller siempre se fondea en una chain EVM y solo el SETTLE downstream ocurre en Solana? Recomendación del Analyst: Scope OUT (acotar a settle-only) para mantener el tamaño manejable — deposit/funding Solana como HU de seguimiento.
3. **[NEEDS CLARIFICATION — no bloqueante]** Gasless/sponsored-tx en Solana (fee-payer pattern) — ¿en scope o deferred? Recomendación: deferred, `GaslessAdapter` Solana como stub `enabled:false` (mismo patrón WKH-38/WKH-138 "v1 acotado").
4. **[NEEDS CLARIFICATION — bloqueante para F2, arquitectura]** Forma exacta de generalizar `PaymentAdapter`/`AgentPaymentSpec.contract` sin romper los 6 chains EVM existentes ni introducir `any` (DT-4). Diferido a Architect en F2, con Adversary revisando exhaustividad de switches y blast radius.
5. **[NEEDS CLARIFICATION — no bloqueante]** ¿Qué stablecoin/mint usar en devnet (USDC-SPL oficial de Circle en devnet, o un mint de test propio del programa Solana LATAM Labs)? Afecta CD-3/nombres de env vars.
6. **[NEEDS CLARIFICATION — no bloqueante]** Slug(s) exacto(s) a agregar a `ChainKey` (`solana-devnet` vs `solana-testnet` vs ambos) y aliases del resolver (`solana`, cluster genesis hash truncado, chainId numérico sintético si algún caller EVM-céntrico lo espera).

## Análisis de paralelismo

- **B1 + B2 pueden ir en la misma wave/PR** — tocan `wallet-format.ts`, `chain-resolver.ts`, `types/index.ts` (área chica, additive, sin tocar código EVM existente). B2 depende de que B1 defina el tipo namespace-aware primero, pero el trabajo es secuencial-rápido (0.5-2.5 días combinados).
- **B3 (rail nuevo) está BLOQUEADO por B1+B2** — necesita `ChainKey` extendido + `AgentPaymentSpec` namespace-aware como prerequisito antes de instanciar el `AdaptersBundle` Solana.
- **B3 bloquea a WKH-235/WKH-236** (según el ticket original) — esas HUs no pueden empezar hasta que el rail Solana exista.
- **Recomendación del Analyst para F2**: dado el tamaño de B3 (L, 1-3 semanas, rail de pago completo), sugerir al Architect decomponer en sub-work-items (ej. `WKH-234a` = AdaptersBundle + PaymentAdapter settle/verify aislado con tests; `WKH-234b` = wiring `downstream-payment.ts` + `compose.ts` per-leg; `WKH-234c` = ledger CAIP-2 + ownership guard) — mismo patrón que el epic WKH-191 (fila 172 de `_INDEX.md`, 8 sub-HUs, 2 waves). Esta HU (WKH-234) queda como el work-item EPIC-level; el Architect decide en F2 si genera SDDs separados por sub-parte o uno solo cubriendo B1+B2+B3.
- **Riesgo de conflicto de merge BAJO**: las HUs actualmente `in progress` (filas 159-163 de `_INDEX.md`: WKH-157/152/158/159/160) tocan `orchestrate.ts` pero en la zona de relevance/discovery-matching, no en chain-resolution ni en `compose.ts`/`downstream-payment.ts` — áreas de código distintas. Vigilar igual al mergear (mismo archivo `orchestrate.ts` en algunos casos).
- **No relacionada de forma bloqueante con WKH-113/WKH-238** — WKH-113 (discovery chain validation dinámica, YA DONE, fila 95) es justamente la defensa que esta HU debe respetar (`normalizeChainSlug` como choke-point); WKH-238 (Solana Agent Registry / identity) es Scope OUT explícito de esta HU pero relacionado a futuro.
