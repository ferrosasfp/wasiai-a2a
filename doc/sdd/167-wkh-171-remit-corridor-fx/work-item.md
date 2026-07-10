# Work Item — [WKH-171] Publicar `remit-corridor-fx` como agente standalone del marketplace A2A

## Resumen
Registrar el agente de cotización FX/corredor (`remit-corridor-fx`, repo `wasiai-remittance-agents`) como
agente **REGISTRADO y facturable** en el protocolo A2A (`wasiai-a2a`), usando el FX mid de mercado real
(`open.er-api.com`) + spread declarado (TransFi real queda en etapa 2, fuera de scope). Objetivo: probar el
riel completo `discover → pagar → invocar → fee-split` con un agente de remesa REAL, en paralelo al demo
`agentshop-corridor-discoverer` (que queda intacto y vivo para los jurados del grant).

## Sizing
- SDD_MODE: full
- Estimación: M (money-path: fee-split + x402/a2a-key + posible endpoint HTTP nuevo)
- Branch sugerido: feat/167-wkh-171-remit-corridor-fx
- **QUALITY** (no FAST/LAUNCH) — justificación: toca el money-path real (x402/a2a-key debit + protocol-fee
  creator-split via `payout_wallet`), aunque el registro en sí reusa infraestructura ya QUALITY-hardened
  (WKH-134/135/143b). El riesgo no está en el gateway (ya probado) sino en (a) un endpoint HTTP nuevo sin
  auditar todavía y (b) una decisión de arquitectura abierta sobre el modo de pago (ver Missing Inputs #1).

## Grounding (F0) — hallazgos clave

### 1. El registro en `wasiai-a2a` NO requiere código nuevo ni migración
`POST /agents` (WKH-134, `src/routes/agents.ts` + `src/services/agent.ts`) ya es un mecanismo de self-serve
publish production-ready: persiste en `a2a_agents` (slug PK, `agent_url`, `price_usdc`, `capabilities`,
`metadata` JSONB, `payout_wallet`/`referrer_ref` desde WKH-143b), con SSRF-guard write-time, ownership guard,
y `discoveryService.discover()` ya mergea estas filas (`publishedAgentService.listAsAgents()`,
`discovery.ts:241-251`) en el MISMO pipeline que los agentes de marketplace. **Registrar
`remit-corridor-fx` es una llamada HTTP en runtime (`POST /agents` con un a2a-key), no un cambio de código.**

### 2. Fee-split (creator) YA funciona para agentes self-published
`resolveAgentSplitContext` (`src/services/agent-split-context.ts:48-52`) lee `payout_wallet` de
`a2a_agents` vía `getSplitContextRow` y lo usa como leg `creator` del split del 1% protocol fee
(`fee-split.ts`, config prod `8000/1500/500` bps). Si se declara `payoutWallet` al publicar
`remit-corridor-fx`, el creator-split se liquida on-chain real y queda auditable en `a2a_fee_splits`
— esto SÍ prueba el leg de "fee-split" end-to-end sin código nuevo.

### 3. GAP arquitectónico — pago x402 directo al agente NO está soportado hoy para self-published
`PublishAgentInput` (`src/types/index.ts:118-139`) no tiene campo `payTo`/`payment`; `buildMetadata`
(`agent.ts:155-167`) sólo persiste `inputSchema`/`outputSchema`/`discoverable`. Consecuencia:
- `mapRowToAgent` nunca setea `Agent.payment` para filas self-published → `signAndSettleDownstream`
  (downstream x402) hace skip `NO_PAYMENT_FIELD` — el agente nunca recibe on-chain su `price_usdc` per-call.
- Peor: si un caller invoca `remit-corridor-fx` (precio 0.03 USDC) vía **x402 anónimo** (sin a2a-key),
  `compose.ts:812` (`invokeAgent`) **lanza** `No payTo address for agent ...` porque no hay
  `metadata.payTo` ni `metadata.payment.contract`. El único camino que funciona hoy sin cambios es el
  **a2a-key prepago** (el caller debita su budget vía `budgetService.debit`; el "pago" es un movimiento de
  ledger interno, no una transferencia on-chain per-call al agente).
- Ver Missing Inputs #1 — esto es una decisión de producto/arquitectura, no algo que el Analyst deba asumir.

### 4. `wasiai-remittance-agents` — lógica del agente lista, pero SIN servidor HTTP
`src/agents/corridor-fx.ts` (`runCorridorFx`) + `src/providers/fx.ts` (`FallbackFxProvider`, FX mid real
de `open.er-api.com` con spread declarado vía `FALLBACK_FX_SPREAD_BPS`/`FALLBACK_FX_FLAT_FEE_USD`; adapter
TransFi gateado OFF salvo `TRANSFI_ADAPTER_READY==='true'`) están implementados y testeados
(`corridor-fx.test.ts`, `fx.test.ts`). **Pero el repo es una librería TS pura (`package.json` sólo depende
de `zod`) — no tiene Next.js, Express, Fastify, `vercel.json` ni carpeta `api/`.** No existe hoy ningún
`agent_url` invocable. Los repos hermanos (`wasiai-lendable`/cobraya, `wasiai-agentshop`) exponen sus
agentes vía Next.js App Router (`src/app/api/agents/{slug}/invoke/route.ts`) deployado en Vercel — patrón de
referencia, pero requiere decisión de stack para este repo (ver Missing Inputs #2).

### 5. Aislamiento del demo — verificado
`wasiai-agentshop/src/app/api/agents/agentshop-corridor-discoverer/invoke/route.ts` es el demo vivo (datos
simulados `MOCK_CORRIDORS`). El README de `wasiai-remittance-agents` ya declara la intención de aislamiento
(slugs `remit-*`, servicio nuevo, registro separado). Esta HU NO toca ningún archivo de `wasiai-agentshop`.

## Acceptance Criteria (EARS)

- AC-1: WHEN un caller consulta `POST /discover` (o `GET /agents/remit-corridor-fx/agent-card`) en
  `wasiai-a2a`, the system SHALL devolver `remit-corridor-fx` como agente activo (`status: active`,
  `enabled: true`), distinto y sin reemplazar a `agentshop-corridor-discoverer`.
- AC-2: WHEN se registra `remit-corridor-fx` vía `POST /agents`, the system SHALL persistir una fila NUEVA
  en `a2a_agents` con slug EXACTO `remit-corridor-fx` (idéntico al `SLUG` exportado por
  `src/agents/corridor-fx.ts`), sin modificar ninguna fila/registro de `agentshop-*`.
- AC-3: WHEN se invoca `remit-corridor-fx` con un `amountUsd` válido, the system SHALL devolver una
  cotización cuyo `rate` derive del mid USD→PEN real (`open.er-api.com`) más el spread declarado
  (`FALLBACK_FX_SPREAD_BPS`), nunca un valor hardcodeado o simulado.
- AC-4: WHILE `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` permanezcan sin configurar (default de esta HU),
  the system SHALL servir toda cotización exclusivamente vía `FallbackFxProvider` (nunca intentar el
  adapter TransFi).
- AC-5: WHEN un pipeline cuyo `steps[0]` es `remit-corridor-fx` completa con éxito Y el agente declaró
  `payoutWallet` al publicarse, the system SHALL liquidar el leg `creator` del protocol fee (1%) a esa
  wallet vía el mecanismo existente de `fee-split.ts`/`agent-split-context.ts`, auditable en
  `a2a_fee_splits` (status `charged` + `tx_hash`).
- AC-6: WHEN el endpoint HTTP de `remit-corridor-fx` recibe `POST` con un body válido (`amountUsd` positivo,
  `destCountry`/`payoutMethod` opcionales), the system SHALL responder `200` con un body cuyo contenido sea
  legible por `data.result ?? data` (contrato de `compose.ts:892-893`) y matchee `CorridorFxOutput`.
- AC-7: IF el body del request al endpoint HTTP falla la validación Zod (ej. `amountUsd <= 0`), THEN the
  system SHALL responder `400` con un error estructurado, nunca un 500 sin manejar.
- AC-8: IF un caller invoca `remit-corridor-fx` vía x402 anónimo (sin a2a-key) mientras el agente no declara
  `payTo` on-chain, THEN el comportamiento exacto queda **[NEEDS CLARIFICATION]** — ver Missing Inputs #1
  (hoy el gateway lanza `No payTo address...`; si el humano NO ratifica agregar soporte `payTo`, esta HU
  debe documentar explícitamente que el camino x402-anónimo-directo-al-agente queda fuera de etapa 1).

## Scope IN

### `wasiai-remittance-agents`
- Endpoint HTTP nuevo que envuelve `runCorridorFx` (`src/agents/corridor-fx.ts`) honrando el contrato
  `POST /invoke → 200 {result:{...}}` documentado en el propio README del repo. Stack exacto (Next.js App
  Router igual que cobraya/agentshop vs. función serverless standalone vs. mini server) — decisión de F2.
- Deploy nuevo (Vercel u otro), separado del deploy de `wasiai-agentshop` — produce el `agent_url` real a
  registrar. Ejecución del deploy = mutación de infra, gated por `!` humano (ver Missing Inputs #3).

### `wasiai-a2a`
- CERO código nuevo si el humano ratifica el modo a2a-key para etapa 1 (Missing Input #1, opción A).
- SI el humano ratifica la opción B (soporte `payTo`/`payment` en self-publish para permitir x402-anónimo
  directo al agente): cambio aditivo y acotado en `PublishAgentInput`/`agent.ts`/`agents.ts` (nuevo campo
  opcional, sin migración — `metadata` ya es JSONB) + `mapRowToAgent` para surface `Agent.payment`. Esto se
  define recién en F2 tras la ratificación.
- Registro runtime: 1 llamada `POST /agents` contra prod (Railway) con un a2a-key + `payoutWallet` —
  mutación de datos de prod, gated por `!` humano (ver Missing Inputs #3).

## Scope OUT
- `wasiai-agentshop` / `agentshop-corridor-discoverer` — NINGÚN archivo se toca. El demo queda intacto y
  vivo para los jurados del grant Team1.
- `remit-kyc-validator`, `remit-cashout-payout` (agentes hermanos del mismo repo) — no se publican en esta
  HU.
- Adapter TransFi real (`TransFiFxProvider`, `TRANSFI_ADAPTER_READY=true`) — etapa 2, Fase A (founder),
  explícitamente fuera de scope.
- `remittance_intents` / value-delivery / movimiento del principal (WKH-168) — Fase A, HU separada.
- Mainnet — testnet-only en toda esta HU (Kite/Avalanche/Base testnets, consistente con el resto del stack).
- Cualquier migración de schema en `wasiai-a2a` que NO sea aditiva vía `metadata` JSONB.
- `src/services/orchestrate.ts` y el core de `src/services/compose.ts` — no se modifica el money-path
  central; a lo sumo se extiende `agent.ts`/`agents.ts` (self-publish) de forma aditiva.

## Decisiones técnicas (DT-N)
- DT-1: El registro usa el mecanismo self-serve YA EXISTENTE (`POST /agents`, WKH-134/135/143b) — NO se crea
  un `registries` (marketplace) nuevo ni se reutiliza el registro de `wasiai-agentshop`.
- DT-2: NO se requiere ninguna migración de DB nueva en `wasiai-a2a` para el registro base — `a2a_agents`
  (incl. `payout_wallet`/`referrer_ref` de WKH-143b) ya cubre slug, `agent_url`, `price_usdc`, capabilities
  y el creator-split. Solo una eventual Opción B (payTo) sería aditiva sobre `metadata` JSONB, sin migración.
- DT-3: La cotización de etapa 1 proviene 100% de `FallbackFxProvider` (FX mid real `open.er-api.com` +
  spread declarado) — ya implementado y testeado en `wasiai-remittance-agents`, sin cambios de lógica
  necesarios para esta HU.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar cualquier archivo de `wasiai-agentshop` o el registro/slug
  `agentshop-corridor-discoverer`.
- CD-2: PROHIBIDO modificar `src/services/orchestrate.ts` o el core money-path de `src/services/compose.ts`.
  Cualquier cambio en `wasiai-a2a` debe ser aditivo y acotado a `agent.ts`/`agents.ts`/`types/index.ts`
  (self-publish), y solo si F2 ratifica la Opción B.
- CD-3: OBLIGATORIO usar el slug `remit-corridor-fx` (byte-idéntico al `SLUG` exportado por
  `src/agents/corridor-fx.ts` en `wasiai-remittance-agents`).
- CD-4: PROHIBIDO activar el adapter TransFi (`TRANSFI_API_KEY` / `TRANSFI_ADAPTER_READY=true`) en esta HU.
- CD-5: OBLIGATORIO testnet-only — ninguna referencia a mainnet en el deploy o registro de esta HU.
- CD-6: OBLIGATORIO que las mutaciones de infraestructura/prod (deploy del nuevo servicio, `POST /agents`
  contra prod, cualquier env var nueva) sean ejecutadas por el humano vía `!` — el pipeline automatizado NO
  las ejecuta sin aprobación explícita.
- CD-7: El endpoint HTTP nuevo DEBE honrar el contrato documentado en el README de `wasiai-remittance-agents`
  (`POST /invoke` → `200 {result:{...}}`), consistente con `compose.ts`'s `data.result ?? data`.

## Missing Inputs
1. **[BLOQUEANTE]** Modo de pago para probar el "riel completo" en etapa 1: ¿alcanza con el camino
   **a2a-key prepago** (ya funciona hoy, cero código nuevo en `wasiai-a2a`, prueba
   discover→debit→invocar→fee-split-creator) o se requiere **x402 anónimo genuino** contra la wallet propia
   del agente (requiere agregar soporte `payTo`/`payment` a self-publish — código nuevo, acotado, en
   `wasiai-a2a`)? Recomendación del Analyst: usar a2a-key para etapa 1 (menor riesgo, cero cambios en el
   gateway ya QUALITY-hardened); diferir x402-anónimo-directo a una HU de seguimiento si se necesita.
2. **[BLOQUEANTE]** Stack/deploy target del endpoint HTTP nuevo en `wasiai-remittance-agents`: hoy el repo
   no tiene servidor (ni Next.js, ni Vercel, ni Express/Fastify). Necesita decisión de stack (Architect, F2)
   y un proyecto de hosting nuevo (separado de `wasiai-agentshop`, per README).
3. **[BLOQUEANTE]** Ejecución de las mutaciones de prod: (a) el a2a-key/owner_ref que va a publicar el
   agente, (b) la wallet EVM `payoutWallet` a declarar para el creator-split, (c) el deploy real del
   servicio nuevo. Estas 3 acciones requieren `!` del humano — el Analyst NO las ejecuta ni las asume.
4. [resuelto en F2] Stack exacto del server HTTP — Architect decide informado por Missing Input #2.
5. [resuelto en F2] Alcance exacto de la Opción B (payTo) si el humano la ratifica en Missing Input #1.

## Análisis de paralelismo
- Esta HU **NO bloquea** ninguna HU en curso (`WKH-157` fila 159, `WKH-152` fila 160, `WKH-158` fila 161,
  `WKH-159` fila 162, `WKH-160` fila 163) — todas tocan `orchestrate.ts`/`discovery.ts`, que esta HU NO
  modifica (Scope OUT explícito, CD-2).
- Puede correr en **paralelo** con cualquiera de las anteriores sin conflicto de merge (superficie de código
  distinta: `agent.ts`/`agents.ts` en `wasiai-a2a` vs. un repo separado `wasiai-remittance-agents`).
- Es un **prerequisito lógico** (no técnico-bloqueante) para publicar `remit-kyc-validator` y
  `remit-cashout-payout` más adelante — mismo patrón de registro, distinto slug — pero esos quedan
  explícitamente Scope OUT de esta HU.
