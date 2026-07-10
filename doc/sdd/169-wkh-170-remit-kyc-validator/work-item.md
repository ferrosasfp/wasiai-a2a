# Work Item — [WKH-170] Publicar `remit-kyc-validator` como agente standalone del marketplace A2A

## Resumen
Registrar el agente de KYC (`remit-kyc-validator`, repo `wasiai-remittance-agents`) como agente
**REGISTRADO y facturable** en el protocolo A2A (`wasiai-a2a`), usando el workflow **Free KYC ($0) / fallback
simulado** (Didit real con AML queda en etapa 2, Fase A, fuera de scope). Objetivo: probar el riel completo
`discover → pagar → invocar → fee-split` con un agente KYC REAL registrado, en paralelo al demo
`agentshop-kyc-validator` (que queda intacto y vivo para los jurados del grant), y con la garantía dura de que
el output **nunca** expone PII (DNI/`legalId`, `travelRuleData`).

## Sizing
- SDD_MODE: full
- Estimación: S (la lógica del agente y el fail-safe YA están implementados y testeados; el trabajo nuevo es
  el wrapper HTTP + su test suite, forkeando un patrón ya probado en producción por WKH-171)
- Branch sugerido: feat/169-wkh-170-remit-kyc-validator
- **QUALITY** (no FAST/LAUNCH) — justificación: KYC/compliance es dato sensible (PII: DNI, Travel Rule data)
  y el output alimenta un gate money-path (`payoutAllowed`). Aunque esta HU NO ejecuta ningún payout real
  (value-delivery es Fase A, Scope OUT), un descuido de redacción de PII en el wrapper HTTP sería una
  filtración de datos personales real en telemetría/logs del gateway — mismo precedente de severidad que
  WKH-155 (RLS/PII anon-readable). Registrar el agente reusa infraestructura ya QUALITY-hardened (WKH-134/
  135/143b/173), pero el endpoint HTTP nuevo no está auditado todavía.

## Grounding (F0) — hallazgos clave

### 1. El registro en `wasiai-a2a` NO requiere código nuevo (mismo mecanismo que WKH-171)
`POST /agents` (WKH-134, `src/routes/agents.ts` + `src/services/agent.ts`) es self-serve publish
production-ready y **ahora gratis** (WKH-173 deployado: `requireA2AKey()` — auth-only, sin débito/fee
placeholder). Persiste en `a2a_agents` (slug PK, `agent_url`, `price_usdc`, `capabilities`, `metadata` JSONB,
`payout_wallet`/`referrer_ref`), y `discoveryService.discover()`/`publishedAgentService.listAsAgents()`
(`discovery.ts:~243`) ya mergea estas filas en el mismo pipeline que los agentes de marketplace. **Registrar
`remit-kyc-validator` es una llamada HTTP en runtime, cero código nuevo en `wasiai-a2a`.**

### 2. La lógica del agente y el fail-safe YA están implementadas y testeadas
`wasiai-remittance-agents/src/agents/kyc-validator.ts`:
- `SLUG = "remit-kyc-validator"` (línea 13), `PRICE_USDC = 0.02` (línea 14).
- `runKycValidator()` (líneas 75-98) devuelve `KycAgentOutput` (slug, approved, riskLevel, reasons,
  verificationId, provenance, payoutAllowed) — **sin** `legalId` ni `travelRuleData`; el comentario en línea
  28-33 documenta explícitamente que esto es BLQ-MED-1 resuelto de una AR previa.
- `isPayoutAllowed()` (líneas 56-69): gate fail-safe — `provenance` fuera de `REAL_KYC_PROVENANCES` (hoy solo
  `"didit"`) exige `NODE_ENV !== 'production'` **Y** `ALLOW_FALLBACK_KYC==='true'` explícito; en producción
  el fallback NUNCA habilita `payoutAllowed`, sin excepción.
- `kyc-validator.test.ts` (24-57) ya cubre: PII no viaja en el output (línea 19: `not.toContain(dni)`,
  línea 20: `travelRuleData` ausente de las keys), y las 3 combinaciones del fail-safe (fallback+nada→false,
  fallback+opt-in+non-prod→true, PROD+fallback+opt-in→false).

### 3. Provider en etapa 1: 100% `FallbackKycProvider`, Didit gated fail-loud
`src/providers/kyc.ts`, `getKycProvider()` (líneas 103-113): sin `DIDIT_API_KEY` → `FallbackKycProvider`
(determinístico, `provenance:"local-fallback"`, línea 75). Con `DIDIT_API_KEY` seteada pero
`DIDIT_ADAPTER_READY!=='true'` → **lanza** (`didit_adapter_not_ready`), fail-loud, nunca degrada
silenciosamente al fallback. Etapa 1 de esta HU corre exclusivamente con ambas env vars sin setear.

### 4. GAP HTTP: NO existe endpoint invocable todavía (a diferencia de `remit-corridor-fx`, que ya lo tiene)
`Glob` de `src/app/api/agents/**` en `wasiai-remittance-agents` solo devuelve la ruta de
`remit-corridor-fx/invoke/route.ts` (WKH-171, ya deployada en `wasiai-remittance-agents.vercel.app`). No
existe `src/app/api/agents/remit-kyc-validator/invoke/route.ts`. El scaffold Next 14 (package.json,
tsconfig, vitest.config, next.config.mjs) SÍ existe ya (entregado por WKH-171) — el trabajo de esta HU es
**forkear el mismo endpoint** (`remit-corridor-fx/invoke/route.ts`) envolviendo `runKycValidator` en vez de
`runCorridorFx`, y agregarlo al MISMO deploy Vercel (no un proyecto nuevo).

### 5. Aislamiento del demo — verificado
`wasiai-agentshop/src/app/api/agents/agentshop-kyc-validator/invoke/route.ts` es el demo vivo (agente
simulado). El README de `wasiai-remittance-agents` (línea 34) ya declara `remit-kyc-validator` como la
versión "v2 real en paralelo" con slug/servicio/registro separados. Esta HU no toca ningún archivo de
`wasiai-agentshop`.

### 6. Precedente directo: WKH-171 (`remit-corridor-fx`, fila 167 de `_INDEX.md`) ya resolvió las 2
decisiones estructurales que aplican igual acá — no se reabren:
- Modo de pago: **a2a-key prepago** (Opción A), cero código nuevo en `wasiai-a2a`.
- Stack: Next.js App Router, mismo deploy Vercel `wasiai-remittance-agents`.

## Acceptance Criteria (EARS)

- AC-1: WHEN un caller consulta `POST /discover` (o `GET /agents/remit-kyc-validator/agent-card`) en
  `wasiai-a2a`, the system SHALL devolver `remit-kyc-validator` como agente activo (`status: active`,
  `enabled: true`), distinto y sin reemplazar a `agentshop-kyc-validator`.
- AC-2: WHEN se registra `remit-kyc-validator` vía `POST /agents`, the system SHALL persistir una fila NUEVA
  en `a2a_agents` con slug EXACTO `remit-kyc-validator` (idéntico al `SLUG` exportado por
  `src/agents/kyc-validator.ts`), sin modificar ninguna fila/registro de `agentshop-*`.
- AC-3: WHEN se invoca `remit-kyc-validator` con un input válido, the system SHALL responder `200` con un
  body cuyo `result` contenga EXCLUSIVAMENTE los campos `slug`, `approved`, `riskLevel`, `reasons`,
  `verificationId`, `provenance`, `payoutAllowed` — the system SHALL NUNCA incluir `legalId` ni
  `travelRuleData` (ni en claro ni anidados) en ninguna parte de la respuesta HTTP (200/400/502).
- AC-4: WHILE `DIDIT_API_KEY`/`DIDIT_ADAPTER_READY` permanezcan sin configurar en el deploy (default de esta
  HU, etapa 1), the system SHALL servir toda verificación exclusivamente vía `FallbackKycProvider`
  (`provenance: "local-fallback"`), nunca intentar el adapter Didit.
- AC-5: IF el `provenance` de la verificación no pertenece al conjunto de proveniencias reales (`"didit"`) Y
  el deploy corre en producción (`NODE_ENV==='production'`), THEN the system SHALL devolver
  `payoutAllowed: false` sin excepción, sin importar el valor de `ALLOW_FALLBACK_KYC`.
- AC-6: WHEN el endpoint HTTP de `remit-kyc-validator` recibe `POST` con un body válido, the system SHALL
  responder `200` con un body legible por `data.result ?? data` (contrato de `compose.ts`), consistente con
  el patrón ya usado por `remit-corridor-fx`.
- AC-7: IF el body del request falla la validación Zod (ej. falta `legalId`/`senderCountry`), THEN the
  system SHALL responder `400` con un error estructurado que NO ecoe el valor de `legalId` recibido, nunca
  un 500 sin manejar.
- AC-8: WHEN un pipeline cuyo `steps[0]` es `remit-kyc-validator` completa con éxito Y el agente declaró
  `payoutWallet` al publicarse, the system SHALL liquidar el leg `creator` del protocol fee (1%) a esa
  wallet vía el mecanismo existente de `fee-split.ts`/`agent-split-context.ts`, auditable en
  `a2a_fee_splits` (status `charged` + `tx_hash`) — mismo mecanismo verificado por WKH-171, sin código nuevo.

## Scope IN

### `wasiai-remittance-agents`
- Endpoint HTTP nuevo `src/app/api/agents/remit-kyc-validator/invoke/route.ts` — fork de
  `remit-corridor-fx/invoke/route.ts` envolviendo `runKycValidator` (`src/agents/kyc-validator.ts`, YA
  implementado/testeado, sin cambios de lógica). Contrato: `200 {result}` / `400 invalid_input` (sin PII) /
  `502` en fallo del provider (sin leak de `err.message`).
- Test suite nueva `route.test.ts` para este endpoint (200/400/502 + un test explícito de NO-PII a nivel
  HTTP, espejo del test ya existente a nivel core en `kyc-validator.test.ts:16-22`).
- README: nueva sección "Endpoint HTTP + deploy (`remit-kyc-validator`)", espejo de la sección ya escrita
  para `remit-corridor-fx` (línea 58 en adelante).
- Redeploy del MISMO proyecto Vercel `wasiai-remittance-agents` (agregar la ruta nueva al deploy existente,
  NO un proyecto nuevo) — mutación de infra, gated por `!` humano.

### `wasiai-a2a`
- CERO código nuevo — mismo mecanismo self-serve (`POST /agents`, ya gratis por WKH-173).
- Registro runtime: 1 llamada `POST /agents` contra prod (Railway) con un a2a-key + `payoutWallet` —
  mutación de datos de prod, gated por `!` humano.

## Scope OUT
- `wasiai-agentshop` / `agentshop-kyc-validator` — NINGÚN archivo se toca. El demo queda intacto y vivo para
  los jurados del grant Team1.
- Adapter Didit real (`DiditKycProvider`, `DIDIT_API_KEY`/`DIDIT_ADAPTER_READY=true`) y AML real — etapa 2,
  Fase A (founder), explícitamente fuera de scope.
- `remit-corridor-fx` (ya DONE, WKH-171) y `remit-cashout-payout` (agente hermano, aún no scaffoldeado como
  endpoint) — no se tocan en esta HU.
- Wiring de `payoutAllowed` a un gate de payout/value-delivery real — hoy NO existe ningún consumidor de ese
  campo en `wasiai-a2a` (el value-delivery/`remittance_intents` es Fase A, WKH-168). Esta HU solo garantiza
  que el campo se calcula y se expone correctamente; no lo conecta a ninguna ejecución de pago.
- Mainnet — testnet-only en toda esta HU.
- Cualquier migración de schema en `wasiai-a2a` que no sea aditiva vía `metadata` JSONB.
- `src/services/orchestrate.ts` y el core de `src/services/compose.ts` — no se modifica el money-path
  central.
- Reabrir la decisión de modo de pago (x402-anónimo-directo al agente) — el mismo GAP documentado en WKH-171
  (`No payTo address...` si se invoca sin a2a-key) aplica igual acá y queda heredado, no reabierto.

## Decisiones técnicas (DT-N)
- DT-1: Reusar el mecanismo self-serve `POST /agents` (WKH-134/135/143b/173) — mismo patrón que WKH-171, sin
  `registries` nuevo.
- DT-2: Modo de pago = a2a-key prepago (Opción A, ratificada en WKH-171) — no se reabre para KYC.
- DT-3: Verificación de etapa 1 = 100% `FallbackKycProvider` (`local-fallback`) — Didit adapter existe en
  código pero permanece gated OFF (fail-loud si se setea la key sin `DIDIT_ADAPTER_READY=true`).
- DT-4: La redacción de PII se garantiza en la capa CORE (`runKycValidator`, ya testeado); el wrapper HTTP es
  fino y NO debe introducir ningún path que ecoe `legalId`/`travelRuleData` (logs, mensajes de error 400/502).
- DT-5: El mismo deploy Vercel de `remit-corridor-fx` (WKH-171) aloja también este endpoint — no se crea un
  proyecto Vercel nuevo.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar cualquier archivo de `wasiai-agentshop`, en particular
  `agentshop-kyc-validator/**` o su registro/slug.
- CD-2: PROHIBIDO modificar `src/services/orchestrate.ts` o el core money-path de `src/services/compose.ts`
  en `wasiai-a2a`.
- CD-3: OBLIGATORIO usar el slug `remit-kyc-validator` (byte-idéntico al `SLUG` exportado por
  `src/agents/kyc-validator.ts`).
- CD-4: PROHIBIDO setear/activar `DIDIT_API_KEY` o `DIDIT_ADAPTER_READY=true` en el deploy de esta HU
  (Didit real es etapa 2 / Fase A).
- CD-5: OBLIGATORIO testnet-only — `payoutWallet` debe ser una wallet EVM testnet (Kite/Avalanche/Base
  testnet), ninguna referencia a mainnet.
- CD-6: OBLIGATORIO — ningún response HTTP (200/400/502) del endpoint puede contener `legalId` ni
  `travelRuleData` en ningún nivel de anidamiento. Debe existir al menos un test que lo verifique a nivel
  HTTP (no solo a nivel de la función core), incluyendo el path de error 400 (no ecoar el `legalId` recibido
  en el mensaje de validación).
- CD-7: OBLIGATORIO que las mutaciones de infraestructura/prod (redeploy Vercel, `POST /agents` contra prod,
  `payoutWallet`) sean ejecutadas por el humano vía `!` — el pipeline automatizado no las ejecuta sin
  aprobación explícita.
- CD-8: El endpoint HTTP nuevo DEBE honrar el mismo contrato que `remit-corridor-fx`
  (`POST /invoke` → `200 {result:{...}}` / `400 invalid_input` / `502` en fallo del provider), consistente
  con `compose.ts`'s `data.result ?? data`.

## Missing Inputs
1. **[BLOQUEANTE, `!` humano]** a2a-key/owner_ref que va a publicar el agente + wallet EVM testnet
   (`payoutWallet`) a declarar para el creator-split — mismo patrón que WKH-171 Missing Input #3.
2. **[BLOQUEANTE, `!` humano]** Redeploy del proyecto Vercel existente `wasiai-remittance-agents`
   (incluyendo la ruta nueva `remit-kyc-validator/invoke`) + confirmación explícita de que
   `DIDIT_API_KEY`/`DIDIT_ADAPTER_READY` permanecen sin setear (CD-4) + `POST /agents` contra prod con el
   `agent_url` resultante.
3. [resuelto en F2] `priceUsdc` exacto a registrar — recomendación del Analyst: `0.02` (ya declarado como
   `PRICE_USDC` en `kyc-validator.ts:14`), mismo patrón que `remit-corridor-fx` (`PRICE_USDC` del archivo →
   `priceUsdc` del payload de registro).
4. [resuelto por precedente WKH-171, no se reabre] Modo de pago (a2a-key prepago) y stack (Next.js App
   Router, mismo deploy Vercel) — ya ratificados en WKH-171 para el mismo repo/patrón.

## Análisis de paralelismo
- Esta HU **NO bloquea** ninguna HU en curso en `wasiai-a2a` (WKH-157/152/158/159/160, filas 159-163 de
  `_INDEX.md`) — todas tocan `orchestrate.ts`/`discovery.ts`, que esta HU no modifica (Scope OUT, CD-2).
- Puede correr en **paralelo** con cualquiera de las anteriores sin conflicto de merge (superficie de código
  distinta: repo separado `wasiai-remittance-agents`, carpeta `remit-kyc-validator/` propia, no colisiona
  con `remit-corridor-fx/`).
- **Prerequisito lógico compartido** con WKH-171: ambas comparten el MISMO deploy Vercel
  (`wasiai-remittance-agents`) — no hay conflicto de código, pero conviene coordinar el orden de los
  redeploys `!` humanos si ambos están pendientes de infra al mismo tiempo (no es un bloqueo técnico, es
  logística de despliegue).
- Es un prerequisito lógico (no técnico-bloqueante) para publicar `remit-cashout-payout` más adelante —
  mismo patrón de registro, distinto slug — pero eso queda explícitamente Scope OUT de esta HU.
