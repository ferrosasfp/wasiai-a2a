# Work Item — [WKH-55] Downstream x402 Payment — wasiai-a2a → wasiai-v2 Agents (Avalanche Fuji)

| Campo | Valor |
|---|---|
| **HU-ID** | WKH-55 |
| **Fecha** | 2026-04-24 |
| **Status** | IN PROGRESS |
| **Sizing** | QUALITY |
| **SDD_MODE** | full |
| **Branch** | `feat/wkh-55-downstream-x402-fuji` |
| **Paralelo con** | WAS-V2-1 (wasiai-v2 receptor side — Scope IN independiente) |

---

## Resumen

Cuando el gateway invoca un agente del marketplace wasiai-v2 vía `compose.invokeAgent`, **añadir** (de forma aditiva, sin reemplazar el flujo `x-agent-key`) un pago downstream x402 real en Avalanche Fuji: firmar EIP-3009 sobre la USDC canónica de Fuji (6 decimales, `eip155:43113`) y llamar al `/settle` del wasiai-facilitator ya live. El resultado (`downstreamTxHash`, `downstreamBlockNumber`, `downstreamSettledAmount`) se expone en el body de respuesta de `/compose` y `/orchestrate`. El comportamiento es 100% opcional vía feature flag `WASIAI_DOWNSTREAM_X402`; si no está seteado, el codebase se comporta bit-exact igual que antes de esta HU.

---

## Smart Sizing Rationale — QUALITY

Esta HU no admite modo FAST ni FAST+AR por las siguientes razones acumulativas:

1. **Riesgo on-chain irreversible**: una firma EIP-3009 mal construida o enviada a un contrato incorrecto mueve USDC real de la operator wallet. No hay rollback.
2. **Cross-repo**: la cadena involucra wasiai-a2a (este repo), wasiai-facilitator (Fuji adapter live), y wasiai-v2 (como receiver — sus agent cards deben exponer `payment`). Tres repos en distintos estados de madurez.
3. **Dominio crítico distinto al actual**: el signing EIP-3009 existente opera sobre Kite (chainId=2368) con PYUSD (18 decimales). El nuevo flujo usa Fuji (chainId=43113) con USDC canónica (6 decimales). El cambio de decimales es una fuente de error de rango de magnitud 10^12 con consecuencias financieras.
4. **Nuevo módulo `src/lib/downstream-payment.ts`**: cero cobertura de tests preexistente. Requiere diseño desde cero, incluyendo la interface con el facilitator y la tipología de errores.
5. **Modificación de contrato de API pública**: los responses de `/compose` y `/orchestrate` cambian de shape al incluir `downstreamTxHash`. Cualquier consumer que valide el schema con strict mode (ej: un agente A2A) puede romperse si el Architect no decide correctamente si el campo es `optional` o `always-present`.
6. **Pre-flight balance check**: leer el balance USDC on-chain antes de firmar añade un RPC call síncrono en el camino crítico; el impacto en latencia debe modelarse.

Conclusión: el SDD debe cubrir la secuencia sign/settle, el contrato de errores, los tipos exactos de los decimales (6 vs 18), el timing (before vs after invoke), la política de fallback y el shape de response. QUALITY obligatorio.

---

## Skills Router

| Skill | Rol | Por qué |
|---|---|---|
| `nexus-architect` | F2 + F2.5 | SDD detallado: secuencia, tipos, decimales, timing DT-E, shape de response |
| `nexus-adversary` | AR + CR | Riesgo on-chain: validar el pre-flight check, el decimal mismatch, el scope del fallback |

---

## Acceptance Criteria (EARS)

### AC-1 — Zero-regresión cuando flag ausente

WHEN `WASIAI_DOWNSTREAM_X402` is not set (undefined, empty string, or any value !== `'true'`), the system SHALL execute `compose.invokeAgent` with exactly the same request shape, headers, and response body as the pre-WKH-55 baseline, with no EIP-3009 signing, no RPC calls to Fuji, and no additional fields in the `StepResult`.

### AC-2 — Firma EIP-3009 correcta sobre USDC Fuji

WHEN `WASIAI_DOWNSTREAM_X402=true` AND `agent.payment.method === 'x402'` AND `agent.payment.chain === 'avalanche'`, the system SHALL sign an EIP-3009 `TransferWithAuthorization` using `viem.signTypedData` with domain `{ name: 'USD Coin', version: '2', chainId: 43113, verifyingContract: <FUJI_USDC_ADDRESS> }`, primaryType `TransferWithAuthorization`, and the message fields `{ from, to: agent.payment.contract, value: <priceUsdc * 10^6 as BigInt>, validAfter: 0n, validBefore: <now + 300s>, nonce: <random 32 bytes> }`.

### AC-3 — downstreamTxHash propagado en la respuesta

WHEN the downstream EIP-3009 signing and the POST `/settle` to `WASIAI_FACILITATOR_URL` with `network: 'eip155:43113'` both succeed (HTTP 200, `settled: true`), the system SHALL include `downstreamTxHash`, `downstreamBlockNumber`, and `downstreamSettledAmount` in the `StepResult` for that agent, and SHALL propagate these fields into the `ComposeResult` and `OrchestrateResult` response bodies.

### AC-4 — Downstream failure no bloquea el invoke principal

IF the POST `/settle` to the facilitator returns a non-2xx status, a network error, or `settled: false`, THEN the system SHALL log a warning containing `agentSlug` and `errorClass` and SHALL return the invoke result to the caller with `downstreamTxHash: undefined`, without throwing an exception or modifying the HTTP status of the compose/orchestrate response.

### AC-5 — Method no x402 → skip gracefully

WHEN `agent.payment` is present AND `agent.payment.method !== 'x402'`, the system SHALL skip the downstream payment attempt, log at info level `[Downstream] method=${agent.payment.method} not supported — skipped`, and SHALL NOT include any `downstreamTxHash` field in the StepResult.

### AC-6 — Chain no soportada → skip gracefully

WHEN `agent.payment` is present AND `agent.payment.method === 'x402'` AND `agent.payment.chain !== 'avalanche'`, the system SHALL skip the downstream payment attempt, log at info level `[Downstream] chain=${agent.payment.chain} not yet supported — skipped`, and SHALL NOT include any `downstreamTxHash` field in the StepResult.

### AC-7 — agentMapping propaga el campo `payment` del agent card

WHEN the wasiai-v2 registry's `agentMapping` is applied in `discoveryService.mapAgent`, the system SHALL map the `payment` field from the upstream agent card raw response into `agent.payment` of type `AgentPaymentSpec` (`{ method: string; chain: string; contract: string }`), preserving the original object without transformation.

### AC-8 — `payTo` del downstream es el `payment.contract` del agent card

WHEN constructing the EIP-3009 `TransferWithAuthorization` for a downstream payment, the system SHALL use `agent.payment.contract` (the address declared by the agent in its own card, e.g. the marketplace receiving contract on Fuji) as the `to` field of the transfer, and SHALL NOT use any other address.

### AC-9 — Conversión de decimales USDC correcta (6 decimales)

WHEN computing the `value` field for the EIP-3009 authorization, the system SHALL compute `BigInt(Math.round(agent.priceUsdc * 1_000_000))` (6 decimal places for USDC on Fuji) and SHALL NOT use the Kite/PYUSD formula of `BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12)` (which produces 18-decimal wei).

### AC-10 — Pre-flight balance check antes de firmar

WHEN `WASIAI_DOWNSTREAM_X402=true` and a downstream payment is about to be signed, the system SHALL read the operator wallet's USDC balance on Fuji via a `balanceOf(operatorAddress)` ERC-20 read call, and IF the balance is less than the required `value` in atomic units, THEN the system SHALL skip the payment, log a warning with code `INSUFFICIENT_BALANCE`, and return the invoke result without `downstreamTxHash` (non-blocking, same policy as AC-4).

### AC-11 — Tests unitarios por AC

WHEN the test suite is executed with `vitest run`, the system SHALL pass unit tests covering each of AC-1 through AC-10 using mocks for the Fuji RPC, the facilitator HTTP call, and the viem wallet client, with zero real on-chain transactions in CI.

### AC-12 — Snapshot de regresión del body de invoke al marketplace

WHEN `WASIAI_DOWNSTREAM_X402` is undefined and `compose.invokeAgent` is called with a known agent fixture, the system SHALL produce a fetch call body that matches, byte-for-byte, the pre-WKH-55 snapshot recorded in the regression test, confirming zero behavioral drift.

---

## Scope IN

| Artefacto | Cambio |
|---|---|
| `src/services/compose.ts` | Añadir hook downstream post-invoke en `invokeAgent`: llama a `downstreamPaymentService.attemptDownstream(agent, input)` (fire-and-forget con captura de error no bloqueante) |
| `src/services/discovery.ts` — `mapAgent` | Mapear `payment` del raw agent card al campo `agent.payment` si existe en el raw response |
| `src/types/index.ts` | Añadir `AgentPaymentSpec` interface + campo `payment?: AgentPaymentSpec` en `Agent`; añadir `downstreamTxHash?`, `downstreamBlockNumber?`, `downstreamSettledAmount?` en `StepResult`; actualizar `OrchestrateResult` si se decide propagar |
| `src/lib/downstream-payment.ts` (NUEVO) | Toda la lógica de: feature flag check, agent.payment validation, balance pre-flight, EIP-3009 sign (Fuji domain), POST /settle al facilitator, error handling |
| `src/__tests__/unit/downstream-payment.test.ts` (NUEVO) | Tests unitarios AC-1..AC-12 con mocks |
| `src/__tests__/unit/compose.test.ts` (actualizar) | Snapshot regression test AC-12 |
| `.env.example` | Documentar `WASIAI_DOWNSTREAM_X402`, `FUJI_RPC_URL`, `FUJI_USDC_ADDRESS`, `FUJI_USDC_EIP712_VERSION` |

---

## Scope OUT

| Exclusión | Razón |
|---|---|
| `src/middleware/a2a-key.ts` | Auth inbound se mantiene sin cambios — WKH-53 |
| `src/middleware/x402.ts` | Auth inbound Kite se mantiene sin cambios |
| wasiai-v2 (cualquier archivo) | Phase 3 = WAS-V2-1. wasiai-v2 ya expone `payment` en su agent card; este repo solo lo lee |
| wasiai-facilitator (cualquier archivo) | Avalanche Fuji adapter ya live desde pre-condición. Fuera de scope de esta HU |
| Mainnet C-Chain (`eip155:43114`) | Solo testnet Fuji en V1. Mainnet es WKH-56 o posterior |
| Retry policy / dead-letter-queue para failures downstream | V2. Esta HU solo logea y continúa (AC-4) |
| Observabilidad / métricas downstream | V2. Los tx hashes en la respuesta bastan para tracing manual |
| Cadenas distintas a Avalanche Fuji | AC-6 hace skip graceful; los adapters específicos son HUs futuras |
| `AgentFieldMapping` extensión (schema del registry) | AC-7 se logra mapeando `payment` como pass-through del raw object — no se añaden campos al `AgentFieldMapping` type (raw ya está en `agent.metadata`) |

---

## Decisiones Técnicas

### DT-A — Feature flag booleano via env var

`WASIAI_DOWNSTREAM_X402=true` habilita el flujo. Cualquier otro valor (ausente, `false`, vacío) lo deshabilita. Razón: rollback instantáneo via toggle Railway env sin redeploy de código. La check se hace **una sola vez** al módulo load (no por request) para minimizar overhead.

### DT-B — Downstream es ADITIVO al `x-agent-key`, no reemplaza

El invoke al agente wasiai-v2 sigue usando el header `x-agent-key` exactamente como antes. El downstream payment es una capa encima que transfiere USDC on-chain para registrar la intención de pago en la cadena. No cambia la autenticación del invoke. Razón: preservar el path validado, permitir A/B, evitar que una falla de blockchain rompa el servicio de orquestación.

### DT-C — Operator wallet es la misma `0xf432baf...7Ba` multi-chain

La misma private key `OPERATOR_PRIVATE_KEY` ya usada para Kite se usa para Fuji. Razón: operativamente simple — la wallet ya tiene saldo USDC en Fuji (verificado 2026-04-24). El Architect evaluará en F2 si se justifica una variable `FUJI_OPERATOR_PRIVATE_KEY` separada para aislamiento de riesgo.

### DT-D — Facilitator endpoint unificado con `network: 'eip155:43113'`

El downstream payment usa el mismo `WASIAI_FACILITATOR_URL` (wasiai-facilitator-production.up.railway.app) con `network: 'eip155:43113'` en el body del `/settle`. El facilitator ya tiene el adapter Fuji registrado (pre-condición cumplida). Razón: 1 endpoint, N adapters — arquitectura ya implementada en WFAC-52. No se añade una segunda variable de entorno de facilitator.

### DT-E — Timing: ¿Antes o después del invoke al agente? [DECIDIR EN F2]

Dos opciones:

- **Before invoke**: se firma y settlea ANTES de llamar al agente. Garantiza que el merchant recibe el pago incluso si el invoke falla después. Riesgo: si el invoke falla, se pagó sin recibir el servicio (sin mecanismo de refund en V1).
- **After invoke**: se firma y settlea DESPUÉS de que el invoke tuvo éxito. Solo se paga si el agente respondió OK. Riesgo: el merchant podría haber entregado el servicio sin recibir el pago (si settle falla).

El Architect debe recomendar cuál es el trade-off aceptable para V1. Consideración: AC-4 ya dice que el failure downstream NO bloquea — eso favorece "after invoke" porque el invoke ya tuvo éxito. Pero "before invoke" es más correcto semánticamente para un marketplace serio.

### DT-F — Decimal precision: 6 para USDC Fuji, no 18

USDC en Avalanche Fuji (`0x5425890298aed601595a70AB815c96711a31Bc65`) tiene **6 decimales**. El código existente para Kite/PYUSD usa 18 decimales (`BigInt(1e12)` multiplier). Este cambio es crítico y debe ser explícito en el código del nuevo módulo. El Architect deberá definir una constante `FUJI_USDC_DECIMALS = 6` visible en el código — no un magic number.

---

## Constraint Directives

| # | Directiva |
|---|---|
| CD-1 | OBLIGATORIO TypeScript strict — sin `any` explícito, sin `as unknown` salvo conversiones de tipo documentadas |
| CD-2 | OBLIGATORIO zero-regresión — el body de request al marketplace cuando `WASIAI_DOWNSTREAM_X402` no está seteado debe ser bit-exact igual al baseline (AC-1, AC-12 como verificación) |
| CD-3 | PROHIBIDO romper tests existentes — la suite de 388 tests debe pasar verde después de WKH-55 |
| CD-4 | PROHIBIDO modificar `src/middleware/a2a-key.ts` o `src/middleware/x402.ts` — auth inbound se mantiene intacto |
| CD-5 | PROHIBIDO duplicar código de signing EIP-3009 — el nuevo `downstream-payment.ts` DEBE usar `viem.signTypedData` (misma lib que `kite-ozone/payment.ts`); PROHIBIDO copiar-pegar el cuerpo completo del sign block |
| CD-6 | OBLIGATORIO errores downstream no bloquean el response del invoke principal — todo error en el path downstream debe ser capturado y logueado; la función downstream devuelve `null | DownstreamResult`, nunca lanza |
| CD-7 | PROHIBIDO tests E2E contra Fuji RPC en CI — todos los tests unitarios usan mocks para RPC, facilitator HTTP, y viem wallet client |
| CD-8 | OBLIGATORIO el domain EIP-712 para Fuji USDC usa exactamente: `name='USD Coin'`, `version='2'`, `chainId=43113`, `verifyingContract=<FUJI_USDC_ADDRESS>` — cualquier drift de estos valores produce firmas inválidas en cadena |
| CD-9 | OBLIGATORIO la dirección `FUJI_USDC_ADDRESS` se lee desde env var (no hardcoded en lógica) — aunque se documente el default `0x5425890298aed601595a70AB815c96711a31Bc65` en `.env.example` |
| CD-10 | PROHIBIDO ethers.js — viem v2 en todo el codebase |

---

## Missing Inputs

| # | Input | Estado |
|---|---|---|
| MI-1 | ¿La API de wasiai-v2 (`GET /api/v1/capabilities`) ya incluye el campo `payment` en los agent cards en producción? | [NEEDS CLARIFICATION — resolver en F2: el Architect debe consultar o asumir y documentar] |
| MI-2 | ¿El `agentMapping` del registry wasiai-v2 en Supabase ya está configurado para pasar `payment`? O se debe actualizar el schema del registry via migration? | [NEEDS CLARIFICATION — resolver en F2] |
| MI-3 | ¿El timing del downstream payment (DT-E) es before o after invoke? | [Decidir en SDD F2 — trade-off documentado en DT-E] |
| MI-4 | ¿El `payment.contract` en el agent card de wasiai-v2 es la dirección del operador de wasiai-v2 en Fuji, o la dirección de un contrato de escrow? | [NEEDS CLARIFICATION — impacta AC-8; resolver en F2 con el registry wasiai-v2] |

---

## Riesgos Identificados

### R-1 — `payment.contract` apunta a un contrato wrong en Fuji

Si el `payment.contract` del agent card wasiai-v2 no es una dirección controlada por wasiai-v2 (sino un contrato de escrow, o peor, un contrato sin función de receive), la USDC puede quedar atrapada o producir un revert on-chain con pérdida de gas. Mitigación en F2: el Architect define un AC de validación de la receiving address (checksum + not-zero-address) antes del settle; se añade una nota operacional de validar la dirección en testnet antes de habilitar el flag.

### R-2 — Operator wallet sin saldo USDC en Fuji

Si el balance USDC de la operator wallet en Fuji cae a cero (por consumo en downstream payments o sin recarga), todos los downstream payments fallan silenciosamente (AC-4, AC-10). El servicio continúa operando pero sin registros on-chain. Mitigación: AC-10 hace el balance check por request y logea `INSUFFICIENT_BALANCE`; se recomienda añadir alertas de balance en V2 dashboard.

### R-3 — Drift de decimales Kite vs Fuji

Si el Dev copia el código de signing de `kite-ozone/payment.ts` sin ajustar los decimales (6 vs 18), el monto transferido será 10^12 veces mayor de lo esperado, drenando la wallet en pocos transactions. Mitigación: CD-5 prohíbe copiar-pegar; CD-8 es explícito sobre el domain; AC-9 tiene el cálculo correcto en el test.

### R-4 — wasiai-facilitator no tiene el adapter Fuji en `/supported`

La pre-condición dice que `eip155:43113` está live en producción (breaker CLOSED, validado 2026-04-24). Si cambia el estado del adapter, los settles fallan. Mitigación: AC-4 aplica — el fallback ya está definido.

---

## Análisis de Paralelismo

| HU | Repo | Scope IN | ¿Bloquea WKH-55? |
|---|---|---|---|
| **WKH-55** (esta HU) | wasiai-a2a | `src/services/compose.ts`, `src/lib/downstream-payment.ts`, `src/types/index.ts` | — |
| **WAS-V2-1** | wasiai-v2 | Exposición del campo `payment` en agent cards | No bloquea — WKH-55 hace skip graceful si `agent.payment` está ausente (AC-5/AC-6). Ambas pueden ir en paralelo |
| **wasiai-facilitator** (ya live) | wasiai-facilitator | Nada — Fuji adapter ya en producción | No bloquea |

**Conclusión**: WKH-55 y WAS-V2-1 son completamente paralelos. No comparten Scope IN. WKH-55 puede desarrollarse contra un mock del campo `payment` y activarse en producción una vez WAS-V2-1 deploya el campo real.

---

## Estimación

| Dimensión | Valor |
|---|---|
| Estimación | L |
| Complejidad técnica | Alta (new on-chain path, cross-chain decimal mismatch, new module from scratch) |
| Riesgo operacional | Alto (USDC real en Fuji, pre-flight check obligatorio) |
| Tests requeridos | 12 ACs unitarios + 1 snapshot regression |
| Archivos nuevos | 2 (`src/lib/downstream-payment.ts`, `src/__tests__/unit/downstream-payment.test.ts`) |
| Archivos modificados | 5 (`compose.ts`, `discovery.ts`, `types/index.ts`, `compose.test.ts`, `.env.example`) |
