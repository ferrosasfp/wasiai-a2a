# Work Item — [WKH-172] Publicar `remit-cashout-payout` como agente standalone del marketplace A2A

## Resumen
Registrar el agente de payout (`remit-cashout-payout`, repo `wasiai-remittance-agents`) como agente
**REGISTRADO y facturable** en el protocolo A2A (`wasiai-a2a`), etapa 1: payout **mock** (`FallbackPayoutProvider`,
NUNCA mueve plata real) para validar el riel completo `discover → pagar → invocar → fee-split` con el
**hard-gate de KYC**, **idempotencia** y **reembolso/credit-back** — la garantía money-path del leg más
sensible del trío `remit-*` (KYC → FX → Payout). El desembolso REAL vía TransFi (etapa 2, Fase A, WKH-168)
queda explícitamente fuera de scope. En paralelo al demo `agentshop-cashout-matcher` (queda intacto y vivo
para los jurados del grant Team1).

## Sizing
- SDD_MODE: full
- Estimación: **M** (mayor que WKH-170/171 — S — por el Missing Input #1: un hallazgo de F0 no presente en
  los agentes hermanos, que puede requerir tocar el fail-safe money-path `assertPayoutProviderSafe()`,
  candidato obligatorio a escrutinio de Adversary Review)
- Branch sugerido: feat/170-wkh-172-remit-cashout-payout
- **QUALITY** (no FAST/LAUNCH) — justificación: es el leg regulado y más sensible del trío (payout/
  disbursement). Aunque el desembolso es mock en etapa 1, los 3 gates que esta HU valida (KYC, idempotencia,
  reembolso) son exactamente la garantía money-path que hace seguro habilitar el desembolso real en etapa 2.
  Un descuido acá (gate bypasseable, PII de beneficiario filtrada, fail-safe mal calibrado) es equivalente en
  severidad a los precedentes WKH-155 (PII) y WKH-53 (IDOR money-path).

## Grounding (F0) — hallazgos clave

### 1. El registro en `wasiai-a2a` NO requiere código nuevo (mismo mecanismo que WKH-170/171)
`POST /agents` (WKH-134, `src/routes/agents.ts` + `src/services/agent.ts`) es self-serve publish
production-ready y gratis (WKH-173 deployado: `requireA2AKey()`, auth-only sin débito). Persiste en
`a2a_agents` (slug PK, `agent_url`, `price_usdc`, `capabilities`, `metadata` JSONB, `payout_wallet`/
`referrer_ref`); `discoveryService.discover()` ya mergea estas filas. **Registrar `remit-cashout-payout` es
una llamada HTTP en runtime, cero código nuevo en `wasiai-a2a`.**

### 2. La lógica del agente YA está implementada y testeada — `src/agents/cashout-payout.ts`
- `SLUG = "remit-cashout-payout"` (línea 14), `PRICE_USDC = 0.03` (línea 15).
- `CashoutPayoutInputSchema` (17-29) exige `kycVerificationId` + `kycPayoutAllowed: boolean` (el hard-gate,
  provisto por el caller/pipeline — típicamente el output de `remit-kyc-validator`) + `idempotencyKey`.
- **Hard-gate KYC confirmado** (71-82): `if (!input.kycPayoutAllowed)` → devuelve `200` con
  `executed:false, status:"blocked", reason:"kyc_gate_not_passed"` SIN llamar al provider — no hay forma de
  bypassear el gate desde el input (no hay override).
- `runCashoutPayout()` devuelve `CashoutPayoutOutput` (slug, executed, status, payoutId, deliveredLocal,
  txRef, reason, provenance) — **sin** `beneficiary.name`/`destination`/`travelRuleData` (no se ecoan de
  vuelta). `resolveTravelRuleData()` (110-122) es un **STUB** (`TODO WKH-168/sandbox`) que NUNCA propaga PII
  al output.
- `cashout-payout.test.ts` (24 líneas) ya cubre: gate KYC bloqueando (15-20), fail-safe PROD sin provider
  real → throws (26-30), fail-safe dev sin opt-in → throws (32-37), dev+opt-in → fallback mock ejecuta
  (39-47), input inválido → throws (49-51).

### 3. Provider en etapa 1: 100% `FallbackPayoutProvider`, TransFi gated OFF (`src/providers/payout.ts`)
- `getPayoutProvider()` (108-118): sin `TRANSFI_API_KEY` → `FallbackPayoutProvider` (mock, `provenance:
  "local-fallback"`, `deliveredLocal: null`, `txRef: null` — nunca entrega real). Con key pero
  `TRANSFI_ADAPTER_READY!=='true'` → lanza `transfi_adapter_not_ready`, fail-loud (mismo patrón KYC/Didit).
- `FallbackPayoutProvider.execute()` (68-78) es **determinístico**: `payoutId: fallback-${idempotencyKey}` —
  dos invocaciones con el mismo `idempotencyKey` devuelven el mismo `payoutId` (idempotencia por
  construcción, no hay store persistente de dedupe porque el mock no tiene side-effects reales que duplicar).
- `assertValidPayout()` (99-105) guarda contra `payoutId` vacío / `deliveredLocal` NaN en cualquier provider.

### 4. ⚠️ HALLAZGO CRÍTICO — el fail-safe bloquea el mock INCONDICIONALMENTE en producción
`assertPayoutProviderSafe()` (`cashout-payout.ts:48-61`):
```
if (hasReal) return;
if (process.env.NODE_ENV === "production") {
  throw new Error("payout_refused: se requiere provider de payout REAL en producción (no fallback)");
}
if (process.env.ALLOW_FALLBACK_PAYOUT !== "true") { throw ...; }
```
Cuando `NODE_ENV==='production'` y no hay provider real configurado, **lanza SIEMPRE** — sin excepción, sin
importar `ALLOW_FALLBACK_PAYOUT`. Next.js/Vercel fijan `NODE_ENV=production` en **todo** deploy construido
(`next build && next start`), tanto "Production" como "Preview" — no es una distinción de ambiente de Vercel,
es la convención estándar de Node/Next. **No existe hoy ninguna forma de correr el mock en un deploy Vercel
real.** Esto es DISTINTO de KYC/FX (`getKycProvider()`/su equivalente FX no tienen este bloqueo condicionado a
`NODE_ENV`; el fail-safe de KYC actúa sobre el flag `payoutAllowed` de salida, no sobre la ejecución en sí).
Consecuencia: tal como está el código, **invocar `remit-cashout-payout` en el deploy resultará SIEMPRE en 502
`payout_refused`**, contradiciendo el objetivo explícito de la HU ("payout mock... para validar el riel").
Ver Missing Input #1 (bloqueante).

### 5. Idempotencia — presente en el input schema y en el mock, sin store persistente de dedupe
`idempotencyKey` es campo obligatorio del input; se pasa a `provider.execute()` y (en `TransFiPayoutProvider`)
viaja como header `idempotency-key` al partner (30-31 de `payout.ts`). En el mock, la idempotencia es
determinística (mismo key → mismo `payoutId`), pero no hay tabla que registre "ya ejecutado" — para el mock
esto es suficiente (no hay side-effect real que duplicar); para etapa 2 (TransFi real) la garantía de
no-doble-desembolso depende 100% de que el partner honre el header `idempotency-key` (fuera de scope, gated
sandbox WKH-168).

### 6. Reembolso/credit-back — es infraestructura EXISTENTE del gateway, no de este repo
`wasiai-a2a` ya tiene `src/services/refund-outbox.ts` (WKH-127/128/129/93-decisión-2026-07-06, fila 140/153 de
`_INDEX.md`): CUALQUIER fallo de step en `/compose`/`/orchestrate` (5xx o 4xx) se acredita de vuelta
automática e incondicionalmente, con auditoría en `a2a_refund_outbox`. Esto aplica genéricamente a
`remit-cashout-payout` sin código nuevo: si el step devuelve `502` (ej. por el fail-safe del hallazgo #4), el
caller ya fue debitado el precio del step y el gateway lo revierte por el mecanismo existente. **No hay
special-casing por agente** — se hereda automáticamente.

### 7. No-PII en output/logs — verificado en el core, falta verificarlo a nivel HTTP (endpoint aún no existe)
`CashoutPayoutOutput` no incluye `beneficiary`/`travelRuleData`. El `console.warn` de la ruta (patrón FX/KYC)
debe loguear SOLO `err.name`, nunca el input crudo (que sí contiene `beneficiary.name`/`destination`, PII de
contacto del beneficiario). Mismo patrón CD-6 que KYC (WKH-170).

### 8. GAP HTTP: el endpoint invocable NO existe todavía
`Glob` de `src/app/api/agents/**` en `wasiai-remittance-agents` solo devuelve `remit-corridor-fx` (WKH-171,
deployado) — `remit-kyc-validator` (WKH-170) está codeado pero PENDING-DEPLOY, y `remit-cashout-payout` no
tiene ruta HTTP en absoluto. El trabajo de esta HU es forkear el mismo patrón (`remit-kyc-validator/invoke/
route.ts` es el mejor exemplar por compartir el patrón CD-6 no-PII) envolviendo `runCashoutPayout`.

### 9. Aislamiento del demo — verificado
El README de `wasiai-remittance-agents` (línea 36) ya declara `remit-cashout-payout` como "v2 real en
paralelo" de `agentshop-cashout-matcher`, slug/servicio/registro separados. Esta HU no toca ningún archivo de
`wasiai-agentshop`.

## Acceptance Criteria (EARS)

- AC-1: WHEN un caller consulta `POST /discover` (o `GET /agents/remit-cashout-payout/agent-card`) en
  `wasiai-a2a`, the system SHALL devolver `remit-cashout-payout` como agente activo (`status: active`,
  `enabled: true`), distinto y sin reemplazar a `agentshop-cashout-matcher`.
- AC-2: WHEN se registra `remit-cashout-payout` vía `POST /agents`, the system SHALL persistir una fila NUEVA
  en `a2a_agents` con slug EXACTO `remit-cashout-payout` (idéntico al `SLUG` exportado por
  `src/agents/cashout-payout.ts`), sin modificar ninguna fila/registro de `agentshop-*`.
- AC-3: WHEN se invoca el endpoint con `kycPayoutAllowed: false` (hard-gate KYC no superado), the system
  SHALL responder `200` con `result.executed: false`, `result.status: "blocked"`,
  `result.reason: "kyc_gate_not_passed"`, y SHALL NUNCA invocar al payout provider (ni real ni fallback).
- AC-4: WHEN se invoca el endpoint con `kycPayoutAllowed: true` y un input válido, the system SHALL
  responder `200` con un `result` que contenga EXCLUSIVAMENTE los campos `slug`, `executed`, `status`,
  `payoutId`, `deliveredLocal`, `txRef`, `reason`, `provenance` — the system SHALL NUNCA incluir
  `beneficiary.name`, `beneficiary.destination` ni `travelRuleData` (ni en claro ni anidados) en ninguna
  parte de la respuesta HTTP (200/400/502) ni en logs estructurados.
- AC-5: WHEN se invoca el endpoint dos veces con el mismo `idempotencyKey` (mismo input, provider mock), the
  system SHALL devolver el mismo `payoutId` determinístico (`fallback-${idempotencyKey}`) en ambas
  respuestas, sin generar dos identificadores de payout distintos para el mismo reintento.
- AC-6: **[sujeto a Missing Input #1]** IF el deploy corre en producción (`NODE_ENV==='production'`) sin un
  provider de payout real configurado (`TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`), THEN the system SHALL
  rechazar la ejecución (`502`, `payout_refused` internamente) — el mock NUNCA se ejecuta silenciosamente en
  ese estado. `[NEEDS CLARIFICATION]`: si esta HU debe (a) aceptar el 502 permanente como comportamiento de
  etapa 1 en el deploy real, o (b) introducir un opt-in nuevo y explícito para permitir el mock en ese deploy
  específico — ver Missing Input #1.
- AC-7: IF la invocación de `remit-cashout-payout` como step pago de un pipeline `/compose`/`/orchestrate`
  falla (502 o excepción, incluyendo el caso del AC-6), THEN the system SHALL acreditar de vuelta el monto
  debitado por ese step vía el mecanismo de refund existente (`refund-outbox.ts`, WKH-127/128/129), sin
  requerir código nuevo en `wasiai-a2a`.
- AC-8: IF el body del request falla la validación Zod (ej. falta `idempotencyKey`/`beneficiary.method`
  inválido), THEN the system SHALL responder `400` con un error estructurado (Zod `.flatten()` únicamente)
  que NO ecoe el valor de `beneficiary.name`/`beneficiary.destination` recibido, nunca un 500 sin manejar.
- AC-9: WHEN un pipeline cuyo `steps[0]` es `remit-cashout-payout` completa con éxito Y el agente declaró
  `payoutWallet` al publicarse, the system SHALL liquidar el leg `creator` del protocol fee (1%) a esa wallet
  vía el mecanismo existente (`fee-split.ts`/`agent-split-context.ts`), auditable en `a2a_fee_splits` — mismo
  mecanismo verificado por WKH-170/171, sin código nuevo.

## Scope IN

### `wasiai-remittance-agents`
- Endpoint HTTP nuevo `src/app/api/agents/remit-cashout-payout/invoke/route.ts` — fork de
  `remit-kyc-validator/invoke/route.ts` (mismo patrón CD-6 no-PII: Zod `.safeParse()` → 400 `.flatten()`
  únicamente, try/catch → 502 con `err.name` solamente, éxito → `200 {result}`), envolviendo
  `runCashoutPayout` (`src/agents/cashout-payout.ts`, YA implementado/testeado, sin cambios de lógica salvo
  lo que resuelva Missing Input #1).
- Test suite nueva `route.test.ts` (200 gate-blocked / 200 fallback-mock-ejecuta-en-dev-con-opt-in / 400 /
  502 `payout_refused` en NODE_ENV=production / test explícito NO-PII a nivel HTTP, espejo del patrón CD-6 de
  KYC).
- README: nueva sección "Endpoint HTTP + deploy (`remit-cashout-payout`)".
- **CONDICIONAL a la resolución de Missing Input #1**: si el humano ratifica la opción (b) (opt-in nuevo para
  correr el mock en el deploy de etapa 1), un cambio ACOTADO a `assertPayoutProviderSafe()` en
  `cashout-payout.ts` — cambio sensible al fail-safe money-path, requiere AR explícito y CD dedicado.
- Redeploy del mismo proyecto Vercel `wasiai-remittance-agents` (agregar la ruta nueva, NO un proyecto
  nuevo) — mutación de infra, gated por `!` humano.

### `wasiai-a2a`
- CERO código nuevo — mismo mecanismo self-serve (`POST /agents`, ya gratis por WKH-173) y el mismo
  mecanismo de refund existente (`refund-outbox.ts`) que ya cubre cualquier step fallido genéricamente.
- Registro runtime: 1 llamada `POST /agents` contra prod (Railway) con un a2a-key + `payoutWallet` —
  mutación de datos de prod, gated por `!` humano.

## Scope OUT
- `wasiai-agentshop` / `agentshop-cashout-matcher` — NINGÚN archivo se toca. El demo queda intacto y vivo
  para los jurados del grant Team1.
- Adapter TransFi real (`TransFiPayoutProvider`, `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY=true`) y el
  desembolso REAL a Yape/Plin/banco — etapa 2, Fase A (WKH-168, founder), explícitamente fuera de scope.
- `resolveTravelRuleData()` (hoy STUB) y cualquier integración con el store seguro del Travel Rule data — no
  se toca (WKH-168).
- La máquina de estados `quote-lock → principal-in → payout → reconcile → refund` (value-delivery real,
  movimiento del principal USDC) — WKH-168, explícitamente fuera de scope. Esta HU es solo el LEAF que llama
  al (mock de) provider de payout.
- `remit-corridor-fx` (DONE, WKH-171) y `remit-kyc-validator` (DONE código · PENDING-DEPLOY, WKH-170) — no se
  tocan en esta HU.
- Cualquier re-verificación server-to-server del `kycVerificationId`/`kycPayoutAllowed` contra
  `remit-kyc-validator` — el agente confía en el booleano provisto por el caller/pipeline (boundary de
  confianza heredado del scaffold, ver Missing Input #6).
- Mainnet — testnet-only en toda esta HU.
- `src/services/orchestrate.ts` y el core de `src/services/compose.ts` en `wasiai-a2a` — no se modifica el
  money-path central; se reusa `refund-outbox.ts` tal cual, sin ampliarlo.
- Cualquier migración de schema en `wasiai-a2a` que no sea aditiva vía `metadata` JSONB.

## Decisiones técnicas (DT-N)
- DT-1: Reusar el mecanismo self-serve `POST /agents` (WKH-134/135/143b/173) — mismo patrón que WKH-170/171,
  sin `registries` nuevo.
- DT-2: Modo de pago = a2a-key prepago (Opción A, ratificada en WKH-171) — no se reabre.
- DT-3: Provider de etapa 1 = 100% `FallbackPayoutProvider` (`local-fallback`) — TransFi adapter existe en
  código pero permanece gated OFF (fail-loud si se setea la key sin `TRANSFI_ADAPTER_READY=true`).
- DT-4: **[PENDIENTE de F2, bloqueado por Missing Input #1]** — si `assertPayoutProviderSafe()` se ajusta con
  un opt-in narrow para etapa 1 en el deploy Vercel "prod" (`NODE_ENV==='production'`), o si la HU acepta el
  502 permanente en el invoke real y valida el resto del riel (registro/discovery/gate-KYC-a-nivel-de-código/
  reembolso-en-fallo) sin un 200 real en el deploy.
- DT-5: El mismo deploy Vercel de `remit-corridor-fx`/`remit-kyc-validator` aloja también este endpoint — no
  se crea un proyecto Vercel nuevo.
- DT-6: El hard-gate KYC (`kycPayoutAllowed`) es un booleano provisto por el CALLER (compose/orchestrator)
  como parte del input del step; el agente payout NO re-verifica contra `remit-kyc-validator` vía llamada
  server-to-server — confía en el dato del pipeline. Decisión heredada del scaffold ya escrito (no se reabre
  en esta HU), documentada como boundary de confianza explícito (ver Missing Input #6).
- DT-7: La garantía de reembolso (AC-7) se apoya 100% en infraestructura EXISTENTE (`refund-outbox.ts`,
  WKH-127/128/129) — cero código nuevo de billing en `wasiai-a2a` para esta HU.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar cualquier archivo de `wasiai-agentshop`, en particular
  `agentshop-cashout-matcher/**` o su registro/slug.
- CD-2: PROHIBIDO modificar `src/services/orchestrate.ts` o el core money-path de `src/services/compose.ts`
  en `wasiai-a2a`; PROHIBIDO ampliar `refund-outbox.ts` (se usa tal cual).
- CD-3: OBLIGATORIO usar el slug `remit-cashout-payout` (byte-idéntico al `SLUG` exportado por
  `src/agents/cashout-payout.ts`).
- CD-4: PROHIBIDO setear/activar `TRANSFI_API_KEY` o `TRANSFI_ADAPTER_READY=true` en el deploy de esta HU
  (TransFi real es etapa 2 / Fase A / WKH-168).
- CD-5: OBLIGATORIO testnet-only — `payoutWallet` debe ser una wallet EVM testnet (Kite/Avalanche/Base
  testnet), ninguna referencia a mainnet.
- CD-6: OBLIGATORIO — ningún response HTTP (200/400/502) del endpoint puede contener `beneficiary.name`,
  `beneficiary.destination` ni `travelRuleData` en ningún nivel de anidamiento, ni en logs estructurados
  (`console.warn` SOLO `err.name`, nunca `err.message`/stack/input). Debe existir al menos un test que lo
  verifique a nivel HTTP (no solo a nivel de la función core), incluyendo el path de error 400/502.
- CD-7: OBLIGATORIO que las mutaciones de infraestructura/prod (redeploy Vercel, `POST /agents` contra prod,
  `payoutWallet`, y CUALQUIER cambio a `assertPayoutProviderSafe()`) sean ejecutadas/ratificadas por el
  humano vía `!` — el pipeline automatizado no las ejecuta sin aprobación explícita.
- CD-8: El endpoint HTTP nuevo DEBE honrar el mismo contrato que `remit-corridor-fx`/`remit-kyc-validator`
  (`POST /invoke` → `200 {result:{...}}` / `400 invalid_input` / `502` en fallo del provider), consistente
  con `compose.ts`'s `data.result ?? data`.
- CD-9: PROHIBIDO que el mock simule o aparente un movimiento de fondos real — `deliveredLocal` DEBE
  permanecer `null`, `txRef` DEBE permanecer `null`, y `provenance: "local-fallback"` DEBE ser siempre visible
  en el output cuando se ejecuta en modo mock (nunca ofuscado o renombrado para parecer un desembolso real).
- CD-10: PROHIBIDO tocar `resolveTravelRuleData()` (stub) o introducir cualquier lógica de recuperación real
  del Travel Rule data — fuera de scope (WKH-168).
- CD-11: Si Missing Input #1 se resuelve con la opción (b) (opt-in nuevo para el deploy), el flag nuevo DEBE
  ser distinto por nombre de `ALLOW_FALLBACK_PAYOUT` (para no ampliar silenciosamente su alcance existente),
  debe requerir `NODE_ENV==='production'` explícito en su propia guarda, y su sola existencia en el código
  debe ir acompañada de un comentario que documente que activarlo fuera de este deploy de etapa 1 es un
  incidente de seguridad money-path.

## Missing Inputs

1. **[BLOQUEANTE, decisión humana/Architect]** El fail-safe `assertPayoutProviderSafe()` bloquea
   INCONDICIONALMENTE el fallback cuando `NODE_ENV==='production'`, y Next.js/Vercel fijan
   `NODE_ENV=production` en todo deploy construido (Production Y Preview) — no existe hoy ninguna forma de
   correr el mock en un deploy Vercel real. Tal como está el código, invocar `remit-cashout-payout` en el
   deploy SIEMPRE devolverá `502 payout_refused`. Opciones:
   - **(a)** Aceptar el 502 permanente como comportamiento esperado de etapa 1 — el "riel" se valida hasta
     discovery/registro/débito-y-reembolso-en-fallo (AC-7); el hard-gate KYC y la idempotencia se validan a
     nivel de código/tests (ya cubierto por `cashout-payout.test.ts`), no vía un `200` real en el deploy.
     Cero cambios al fail-safe.
   - **(b)** Introducir un flag NUEVO y explícito (distinto de `ALLOW_FALLBACK_PAYOUT`, ver CD-11) que
     habilite el mock en `NODE_ENV=production` SOLO para este deploy de etapa 1 — toca
     `assertPayoutProviderSafe()`, AR obligatorio.
   - **(c)** Validar el flujo E2E fuera del deploy Vercel prod (smoke local/CI con
     `NODE_ENV=test|development` + `ALLOW_FALLBACK_PAYOUT=true`); el deploy real queda registrado en el
     marketplace pero cualquier invoke real 502ea hasta etapa 2.
   Recomendación del Analyst: **(a)** es la más conservadora y coherente con "nunca mover plata real ni
   simular que se movió"; **(b)** es la que más se alinea con el objetivo literal de la HU pero exige el
   mayor escrutinio (AR obligatorio sobre un fail-safe money-path). Esta decisión determina si Scope IN
   incluye o no un cambio a `cashout-payout.ts`.
2. **[BLOQUEANTE, `!` humano]** a2a-key/owner_ref que va a publicar el agente + wallet EVM testnet
   (`payoutWallet`) a declarar para el creator-split — mismo patrón WKH-170/171.
3. **[BLOQUEANTE, `!` humano]** Redeploy del proyecto Vercel existente `wasiai-remittance-agents`
   (incluyendo la ruta nueva `remit-cashout-payout/invoke`) + confirmación explícita de que
   `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` permanecen sin setear (CD-4) + `POST /agents` contra prod con el
   `agent_url` resultante.
4. [resuelto en F2] `priceUsdc` exacto a registrar — recomendación del Analyst: `0.03` (ya declarado como
   `PRICE_USDC` en `cashout-payout.ts:15`).
5. [resuelto por precedente WKH-170/171, no se reabre] Modo de pago (a2a-key prepago) y stack (Next.js App
   Router, mismo deploy Vercel).
6. **[NEEDS CLARIFICATION, no bloqueante]** El hard-gate KYC (`kycPayoutAllowed`) es confiado del input del
   caller sin re-verificación server-to-server contra `remit-kyc-validator` — si un pipeline se orquesta
   manualmente (compose con steps arbitrarios) un caller podría enviar `kycPayoutAllowed: true` sin haber
   pasado por un KYC real. Es una decisión de diseño heredada del scaffold (no introducida por esta HU); una
   mitigación real (verificar `kycVerificationId` contra un store persistente/firmado) queda fuera de scope
   de etapa 1 (dependería de WKH-168 y de que exista un store real del que recuperar el Travel Rule data).

## Análisis de paralelismo
- Esta HU **NO bloquea** ninguna HU en curso en `wasiai-a2a` (WKH-157/152/158/159/160, filas 159-163 de
  `_INDEX.md`) — todas tocan `orchestrate.ts`/`discovery.ts`, que esta HU no modifica (Scope OUT, CD-2).
- Puede correr en **paralelo** con cualquiera de las anteriores sin conflicto de merge (superficie de código
  distinta: repo separado `wasiai-remittance-agents`, carpeta `remit-cashout-payout/` propia).
- **Prerequisito lógico compartido** con WKH-170/171: las tres comparten el MISMO deploy Vercel
  (`wasiai-remittance-agents`) — no hay conflicto de código, pero conviene coordinar el orden de los
  redeploys `!` humanos (WKH-170 sigue PENDING-DEPLOY).
- **Cierra el trío `remit-*`** (FX + KYC + Payout) — completa el set de agentes reales que puede componerse
  en un pipeline `/compose`/`/orchestrate` de remesa end-to-end, en paralelo al demo `agentshop-*`.
- Missing Input #1 debe resolverse ANTES de F2 con certeza de scope — si se ratifica la opción (b), Scope IN
  crece a incluir un cambio (acotado, con AR obligatorio) en `cashout-payout.ts`.
