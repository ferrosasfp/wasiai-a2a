# Work Item — [WKH-133] Cerrar el loop de reputación: write-back on-chain a ERC-8004

## Resumen
Hoy WasiAI A2A solo **lee** el `ReputationRegistry` ERC-8004 (`src/adapters/erc8004-reputation.ts::getSummary()`, read-only, env-gated). Esta HU cierra el loop: tras una task settleada con éxito (`a2a_events`, `status='success'`, `cost_usdc>0`), el sistema debe **escribir** una attestation/feedback al `ReputationRegistry` on-chain, de forma best-effort, idempotente y sin bloquear el hot-path de settlement. Objetivo competitivo (`doc/competitive/okx-ai-analysis-2026-07.md`, P0 #2): OKX promete "reputación portable onchain" sin schema ni mecánica pública — nosotros lo shippeamos real y verificable en explorer.

## Sizing
- SDD_MODE: **full** (QUALITY — el proyecto opera siempre en modo QUALITY; además el riesgo lo exige: on-chain write + operator key + gas + idempotencia)
- Estimación: **M**
- Branch sugerido: `feat/133-wkh-133-erc8004-writeback`

### Justificación del sizing
Toca tres categorías de riesgo simultáneas que en este repo siempre disparan AR/CR estricto (ver `CLAUDE.md` — Security Conventions, y el patrón de todas las HUs on-chain previas: WKH-100/101/103/126):
1. **On-chain write real** (primera vez que se escribe al ReputationRegistry — hasta ahora todo el código ERC-8004 es explícitamente read-only, `erc8004-reputation.ts:11` "NEVER writes (CD-7/CD-8)").
2. **Operator key** — cualquier tx firmada consume gas del wallet operador compartido (ver memoria `mainnet-gas-accounting.md`, `kite-relayer-gas-drain.md`: el wallet operador ya es un recurso escaso/monitoreado).
3. **Money-adjacent / hot-path** — el trigger nace en el flujo de settlement de `/compose` y `/orchestrate`; un bug puede bloquear o enlentecer el path de cobro real.

## Acceptance Criteria (EARS)

- AC-1: WHEN una task/evento en `a2a_events` settlea con `status='success'` AND `cost_usdc>0`, the system SHALL disparar la escritura de una attestation/feedback al `ReputationRegistry` ERC-8004, de forma asíncrona y best-effort (fuera del path de respuesta al caller).
- AC-2: WHILE la feature de write-back no está habilitada por env flag, O falta configuración (registry address / RPC / operator key) para el chain de escritura, the system SHALL omitir la escritura on-chain silenciosamente — sin error visible al caller, sin tocar el settlement subyacente (mismo patrón de degradación graceful que `erc8004-reputation.ts` `REGISTRY_NOT_CONFIGURED`).
- AC-3: IF un evento settleado ya fue attestado exitosamente (tx confirmada), THEN the system SHALL NOT volver a escribir una attestation duplicada para ese mismo evento — idempotencia mediante un marcador persistido (sobrevive restarts del proceso).
- AC-4: IF la transacción de write-back falla (RPC caído, revert, gas insuficiente, timeout), THEN the system SHALL loguear el fallo server-side (nunca `error.message` crudo a ningún caller) y NO reintentar sincrónicamente dentro del mismo request — el evento queda marcado como no-attestado para un intento posterior.
- AC-5: the system SHALL NOT escribir attestations para eventos con `status='failed'` o `cost_usdc<=0` — paridad anti-sybil con la fórmula off-chain existente (`src/services/reputation.ts`, `tasks_settled` exige `success AND cost_usdc>0`).
- AC-6: WHEN el write-back está habilitado, the system SHALL firmar la transacción usando la cuenta derivada de `OPERATOR_PRIVATE_KEY` ya existente en el repo (sin introducir un secret nuevo), resuelta por chain (mismo patrón de cliente lazy-cacheado por red que `erc8004-reputation.ts:113-127`).
- AC-7: the system SHALL ejecutar el write-back fuera del camino síncrono de respuesta de `/compose`, `/orchestrate` y `/a2a` (task/message endpoints) — la latencia p95 de esos endpoints SHALL NOT incrementarse de forma medible por esta feature.

## Scope IN

- Nuevo adapter/módulo de escritura (p.ej. `src/adapters/erc8004-reputation-writer.ts`, sibling de `erc8004-reputation.ts`) que use `viem` `WalletClient` + `privateKeyToAccount(OPERATOR_PRIVATE_KEY)` para firmar la tx de feedback al `ReputationRegistry`.
- Punto de disparo tras settlement exitoso — candidatos a evaluar en F2: hook en `eventService.track()` (`src/services/event.ts`) cuando `status==='success' && costUsdc>0`, o consumidor de la queue BullMQ ya presente en el stack (`project-context.md` — Queue: Redis + BullMQ).
- Persistencia de idempotencia: nueva columna en `a2a_events` (p.ej. `reputation_tx_hash`, `reputation_attested_at`) o tabla dedicada `a2a_reputation_writebacks` — requiere migración DB (Architect decide formato en F2, ver Missing Inputs).
- Env vars nuevas de gating: reutilizar `ERC8004_REPUTATION_REGISTRY_ADDRESS[_BASE_MAINNET|_BASE_SEPOLIA]`, `OPERATOR_PRIVATE_KEY`, `ERC8004_RPC_TIMEOUT_MS` ya existentes + un flag explícito nuevo de habilitación (p.ej. `ERC8004_REPUTATION_WRITEBACK_ENABLED`, default `false`).
- Tests unitarios + contract test mirror del patrón `src/adapters/erc8004-reputation.test.ts` (mock de `writeContract`, casos: éxito, revert, RPC down, idempotencia, flag off).
- Verificación de la función de escritura real del contrato `ReputationRegistry` (ABI) — hoy el repo solo documenta `getSummary` (view); Architect/Dev deben confirmar la firma de escritura (`giveFeedback`/`submitFeedback` o equivalente) contra el ABI oficial del repo `erc-8004/erc-8004-contracts`.

## Scope OUT

- NO se toca `erc8004-identity.ts` (permanece read-only — solo Identity Registry, no Reputation).
- NO se generaliza a los `AttestationAdapter` stub existentes en Kite/Avalanche (`src/adapters/kite-ozone/attestation.ts`, `src/adapters/avalanche/attestation.ts`, `src/adapters/base/attestation.ts` — los tres son stubs no-op hoy). Esta HU escribe directo al `ReputationRegistry` de **Base** (única chain con address de Reputation Registry ya documentada/leída); no reutiliza ni completa la interfaz `AttestationAdapter` genérica multi-chain.
- NO se implementa backfill retroactivo de eventos `a2a_events` históricos ya settleados antes de esta HU — solo forward desde el deploy (asunción conservadora, ver Missing Inputs).
- NO se modifica la fórmula de reputación off-chain (`src/services/reputation.ts` queda intacta — sigue siendo la fuente primaria consumida por AgentCard/discover; el write-back es aditivo).
- NO se construye UI/dashboard con indicador de "reputación on-chain escrita" (futuro).
- NO se implementa el mecanismo de disputas/staked-evaluators (roadmap competitivo P2 #8, HU separada).
- NO se introducen secrets nuevos — reutiliza `OPERATOR_PRIVATE_KEY` ya presente en env.

## Decisiones técnicas (DT-N)

- DT-1: Reusar `OPERATOR_PRIVATE_KEY` para firmar en vez de un writer key dedicado — reduce secret sprawl, pero acopla el gas de write-back al mismo wallet que otros flujos operador (protocol fee, gasless). Riesgo de drenaje compartido (ver memoria `kite-relayer-gas-drain.md`) — el monitoreo de balance del operador debe incluir esta nueva fuente de consumo de gas.
- DT-2: Ejecución **asíncrona/fuera del hot-path** (background job o fire-and-forget `.catch()`), nunca inline antes de responder al caller de `/compose`/`/orchestrate` — protege latencia (mismo patrón que `eventService.track()`, diseñado explícitamente "fire-and-forget: caller usa `.catch()`").
- DT-3: Idempotencia vía marcador **persistido en DB** (no in-memory) — debe sobrevivir restarts del proceso (patrón ya usado para idempotencia por `request.id` en fee-compose, WKH-118 / #115).
- DT-4: Scope **Base-only** para v1 — única chain con `ReputationRegistry` address operativa hoy (leída por `erc8004-reputation.ts`); evita expandir a 3 chains en una sola HU. Kite/Avalanche quedan como AttestationAdapter stubs sin tocar.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO bloquear la respuesta de `/compose`, `/orchestrate` o `/a2a` (task/message) esperando confirmación de la tx de write-back — SIEMPRE async/best-effort.
- CD-2: PROHIBIDO escribir una attestation duplicada para el mismo evento settleado — OBLIGATORIO verificar/persistir el marcador de idempotencia antes de emitir la tx; ante fallo de escritura, PROHIBIDO reintentar automáticamente dentro del mismo request.
- CD-3: OBLIGATORIO fail-open hacia el resto del sistema: cualquier error de RPC/contrato/gas en el write-back se loguea server-side únicamente (nunca `error.message` crudo a ningún caller — patrón CD-18 de `reputation.ts`) y NUNCA marca la task/evento subyacente como `failed`.
- CD-4: PROHIBIDO hardcodear registry address, RPC URL o cualquier parámetro de chain — todo desde env vars existentes (mismo patrón CD-4 de `erc8004-reputation.ts`/`erc8004-identity.ts`).
- CD-5: OBLIGATORIO gatear la feature completa detrás de un env flag explícito con default OFF — sin configurar, el sistema se comporta exactamente como hoy (100% read-only).
- CD-6: PROHIBIDO exponer el operator private key o cualquier material de firma en logs, respuestas HTTP o metadata persistida — solo el `txHash` resultante puede loguearse/persistirse.

## Missing Inputs

- **[bloqueante para F2]** ABI/función exacta de escritura del `ReputationRegistry` ERC-8004 (p.ej. `giveFeedback(agentId, clientAddress, value, decimals, tag1, tag2)` o equivalente) NO está documentada en el repo — el reader actual solo verificó `getSummary` (view, `erc8004-reputation.ts:22-29`). Architect DEBE verificar la firma de escritura contra el ABI oficial `abis/ReputationRegistry.json` del repo `erc-8004/erc-8004-contracts` antes de cerrar el SDD (mismo rigor que el `[VERIFY-AT-IMPL]` ya resuelto para `getSummary`).
- **[NEEDS CLARIFICATION]** Backfill: ¿solo forward desde el deploy de esta HU, o también backfill de eventos `a2a_events` históricos ya settleados? Asumo **forward-only** (conservador) salvo indicación contraria del humano.
- **[NEEDS CLARIFICATION]** Alcance multi-chain: ¿Base-only v1 (asumido) o debe extenderse a Kite/Avalanche en la misma HU, dado que el `AttestationAdapter` interface ya existe stubbed en las 3 chains? Asumo **Base-only**.
- **[resuelto en F2]** Mecanismo de disparo concreto: BullMQ job (infra ya en el stack) vs fire-and-forget inline — Architect decide en F2 según trade-off de reliability/observabilidad (reintentos, dead-letter) vs simplicidad.
- **[resuelto en F2]** Mapping determinista entre el score off-chain 0-100 (`src/services/reputation.ts::computeFromAccumulator`) y el `value`/`decimals` on-chain (formato `int128`/`uint8` visto en `getSummary`) — Architect define la fórmula exacta en el SDD.

## Análisis de paralelismo

- No bloquea ni es bloqueada por HUs previas del índice (última entrada `_INDEX.md`: #132, WKH-135, DONE). Es una HU standalone que solo agrega un writer nuevo + hook de settlement; no modifica lógica de billing/compose existente.
- Puede correr en **paralelo** con cualquier otro P0 del roadmap competitivo que no toque `src/adapters/erc8004-*.ts` ni `src/services/event.ts` (p.ej. el ítem "Ship SDK" del mismo doc competitivo, #3) — sin overlap de archivos.
- Dependencia externa dura: acceso al ABI de escritura del `ReputationRegistry` oficial ERC-8004 (Missing Inputs, bloqueante) — sin eso, F2 no puede cerrar el Story File con la firma de función correcta.
