# Work Item — [WKH-143] Activar splits de creador/referral (cablear el seam de WKH-136)

## Resumen

WKH-136 (DONE, en prod) entregó el engine de splits (`fee-split.ts`:
`computeSplits`/`resolveRecipients`/`settleFeeSplits`/`reverseFeeSplits`),
totalmente testeado, pero en v1 **creador y referral SIEMPRE se re-rutan a
plataforma** porque la firma de `chargeProtocolFee` (`{orchestrationId,
feeBaseUsdc, feeRate}`) no transporta el agente primario. Esta HU cablea ese
seam: resuelve el agente primario en los dos call-sites, amplía la firma de
`chargeProtocolFee` para transportar su contexto de creador/referral, y
verifica que el comportamiento default (`10000/0/0`) siga siendo
byte-idéntico. Money-path. Ref: `doc/sdd/138-wkh-136-atomic-splits-bps/done-report.md`.

## Sizing

- SDD_MODE: full (QUALITY — money-path, toca `chargeProtocolFee` + 2
  call-sites + posible extensión de tipos internos)
- Estimación: M
- Branch sugerido: `feat/144-wkh-143-activate-creator-referral-splits`

## F0 — Grounding (confirmado contra código real)

| Hecho | Evidencia |
|-------|-----------|
| Firma actual de `chargeProtocolFee` | `src/services/fee-charge.ts:180-183` — `{orchestrationId, feeBaseUsdc, feeRate}`. NO transporta agente. |
| Call-site #1 (`/orchestrate/execute`) | `src/services/orchestrate.ts:1064-1069` — invocado SOLO si `pipeline.success`, con `feeBaseUsdc: pipeline.totalCostUsdc`. `pipeline` es un `ComposeResult` con `pipeline.steps: StepResult[]`, cada uno con `agent: Agent` completo (`src/types/index.ts:359-361`). Agente primario = `pipeline.steps[0]?.agent`. |
| Call-site #2 (`/compose`) | `src/routes/compose.ts:574-578` — dentro de un `try/catch`, con `feeBaseUsdc: result.totalCostUsdc`. `result` es el mismo shape `ComposeResult`. Agente primario = `result.steps[0]?.agent`. |
| `resolveRecipients(config, ctx: SplitContext)` | `src/services/fee-split.ts:203-260` — `SplitContext = {platformWallet, creator?: SplitPartyRef|null, referral?: SplitPartyRef|null}` (`SplitPartyRef = {wallet: string|null, ownerRef: string|null}`). Hoy `fee-charge.ts:240-242` invoca con SOLO `{platformWallet}` → creator/referral siempre `undefined` → fallback SG-6 (bps re-ruteado a plataforma, fila `skipped`). |
| Fallback pattern de wallet ya existente en el codebase | `src/services/compose.ts:788-801` (invocación de agentes, dinero DISTINTO — pago por-llamada al agente, no split del fee): `meta.payTo` (canónico, registries kite) con fallback `meta.payment.contract` (marketplace wasiai-v2). Mismo criterio a reusar para resolver el "creator" de agentes NO self-published. |
| Columnas `a2a_agents.payout_wallet` / `referrer_ref` | Migración `supabase/migrations/20260705000000_wkh136_fee_splits.sql:70-72` — YA existen en prod caldz (`ALTER TABLE a2a_agents ADD COLUMN IF NOT EXISTS payout_wallet TEXT, referrer_ref TEXT`). Nullable, sin default. |
| **Hallazgo crítico (F0, no estaba en la HU original)**: ningún código escribe hoy esas dos columnas | `src/services/agent.ts` (`publish`/`update`, WKH-134) construye el row insert/update SIN `payout_wallet` ni `referrer_ref` (`agent.ts:279-291`, `412-448`); `PublishAgentInput`/`UpdateAgentInput` (`src/types/index.ts:118-150`) no tienen esos campos. **⇒ Para agentes self-published, `payout_wallet`/`referrer_ref` son SIEMPRE `NULL` hoy** — cablear el seam de creator NO activa pagos reales a self-published hasta que exista un write-path (fuera de esta HU, ver Missing Inputs). |
| `Agent.id` para self-published | `src/services/agent.ts:107-126` (`mapRowToAgent`): `id: row.slug`, `registry_id: SELF_PUBLISHED_REGISTRY_ID`. Permite re-consultar `a2a_agents` por `agent.slug` cuando `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID`. `publishedAgentService.getRow(slug)` YA existe (`agent.ts:220-231`) pero su `AgentRow` interno (`agent.ts:42-53`) NO tipa `payout_wallet`/`referrer_ref` (aunque `select('*')` ya los trae en runtime) — hay que ampliar esa interfaz interna. |
| Agentes de marketplace/registry SÍ tienen `payTo` poblado hoy | `agent.metadata.payTo`/`payment.contract` viene del Agent Card real del proveedor (dato existente, no requiere write-path nuevo) — la resolución de "creator" para ESTOS agentes puede activarse de verdad con solo esta HU. |
| MNR-3 (auto-blindaje WKH-136) | `src/services/fee-charge.ts:269-277` — comentario explícito: `extrasFailed` hoy solo se evalúa en el return de éxito post-settle (línea ~489-496); los returns tempranos (`already-charged` charged/in-progress, `23505` unique_violation) NO lo consultan. Inalcanzable en v1 porque no hay extras reales; al cablear el seam SÍ es alcanzable → debe cerrarse en esta HU. |
| MNR-2 (reverse de plataforma, fuera de scope) | `reverseFeeSplits` (`fee-split.ts:579-660`) NO está cableado a orchestrate/compose (fee post-success ⇒ mutuamente excluyente con refund, §4.7 SDD-138) — sigue así, no lo toca esta HU. |

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `chargeProtocolFee` se invoca desde `/orchestrate/execute`
  (`orchestrate.ts:~1065`) o `/compose` (`compose.ts:~574`) y el pipeline
  tiene ≥1 step, THE system SHALL resolver el agente primario como
  `steps[0].agent` y construir su contexto de creador (`SplitPartyRef`) ANTES
  de invocar `chargeProtocolFee`.
- **AC-2**: WHEN el agente primario es de un registry externo (NO
  self-published) y expone una wallet resoluble vía `agent.metadata.payTo`
  (fallback `agent.metadata.payment.contract`, mismo criterio de
  `compose.ts:788-801`), THE system SHALL pasar esa wallet como `creator` a
  `resolveRecipients` (vía la firma ampliada de `chargeProtocolFee`).
- **AC-3**: WHEN el agente primario es self-published
  (`registry_id === SELF_PUBLISHED_REGISTRY_ID`) y su fila `a2a_agents` tiene
  `payout_wallet` no-nulo con formato de address válido, THE system SHALL
  resolverlo como `creator` de la misma forma que AC-2.
- **AC-4**: IF el agente primario no tiene wallet de creador resoluble
  (self-published sin `payout_wallet`, o registry sin `payTo`/`payment.contract`),
  THEN THE system SHALL comportarse exactamente igual que hoy: el bps de
  creador se re-enruta a plataforma vía el fallback SG-6 ya existente en
  `resolveRecipients` (fila `skipped`, sin error, sin abortar el cobro).
- **AC-5**: WHILE la config de splits permanece en el default `10000/0/0`
  (`SPLIT_BPS_PLATFORM=10000`), THE system SHALL producir un resultado
  byte-idéntico al comportamiento actual (cero legs adicionales, cero cambio
  en `protocolFeeUsdc`, `fee-charge.test.ts` + `orchestrate.billing.test.ts` +
  suites money-path existentes verdes sin modificarlas).
- **AC-6**: WHEN un leg adicional (creator/referral) falla su settle DESPUÉS
  de que el agregado ya fue marcado `already-charged` en un return temprano
  (`existing.status==='charged'`, `existing.status==='pending'`, o `23505`
  unique_violation en el INSERT de `a2a_protocol_fees`), THE system SHALL
  evaluar `extrasFailed` en ESOS returns tempranos también (no solo en el
  path de éxito post-settle) y degradar el agregado a `failed` cuando
  corresponda (cierre de MNR-3).
- **AC-7**: WHERE el agente primario NO existe (`steps.length === 0`,
  edge-case defensivo), THE system SHALL invocar `chargeProtocolFee` sin
  contexto de creador/referral (`undefined`/`null`), preservando el
  comportamiento actual (100% a plataforma).

## Scope IN

- `src/services/fee-charge.ts`: ampliar `FeeChargeParams` con
  `creator?: SplitPartyRef | null` y `referral?: SplitPartyRef | null`
  (aditivo); pasar ambos a `resolveRecipients(splitConfig, { platformWallet,
  creator: params.creator, referral: params.referral })`; cerrar MNR-3
  (AC-6) en los returns tempranos.
- `src/services/orchestrate.ts` (~1065): resolver `pipeline.steps[0]?.agent`
  y construir su `SplitPartyRef` de creator (y de referral si aplica) antes
  de llamar `chargeProtocolFee`.
- `src/routes/compose.ts` (~574): mismo wiring con `result.steps[0]?.agent`.
- Nuevo helper de resolución (ubicación a decidir en F2 — candidato:
  `src/services/fee-split.ts` o módulo nuevo `agent-split-context.ts`) que,
  dado un `Agent | undefined`, devuelve `{ creator: SplitPartyRef | null;
  referral: SplitPartyRef | null }`: registry externo → `payTo`/fallback
  `payment.contract`; self-published → query a `a2a_agents` por `slug`
  (extendiendo el `AgentRow` interno de `agent.ts` con `payout_wallet` /
  `referrer_ref`, o exponiendo un nuevo método en `publishedAgentService`).
- Tests money-path nuevos: creator resuelto (registry con `payTo`), creator
  resuelto (self-published con `payout_wallet` seteado manualmente en fixture),
  fallback SG-6 (ambos ausentes), AC-6/MNR-3 en los 3 returns tempranos,
  regresión default `10000/0/0`.

## Scope OUT

- Write-path para `payout_wallet`/`referrer_ref` (extender
  `PublishAgentInput`/`UpdateAgentInput` + `POST`/`PATCH /agents`) — las
  columnas siguen sin mecanismo de escritura vía API; solo settable hoy por
  intervención manual en DB. Ver Missing Inputs #1.
- Mecanismo de captura de `referrer_ref` (qué es, cuándo se setea, quién lo
  provee) — no está definido en ningún código existente. Ver Missing Inputs
  #2/#3.
- Atribución proporcional multi-agente del creador (solo `steps[0]`, mismo
  criterio SG-5 de WKH-136) — ya documentado como OUT en WKH-136.
- `reverseFeeSplits` / cableado del reverse a orchestrate o compose (MNR-2,
  sigue diferido — el fee se cobra post-success, mutuamente excluyente con
  refund).
- Escrow on-chain multi-output / atomicidad on-chain real (WKH-126a) — sigue
  fuera de scope (heredado de WKH-136).
- Exponer `payout_wallet`/`referrer_ref` en cualquier endpoint público
  (`/discover`, AgentCard, `listAsAgents`, `listMine`) — PROHIBIDO (ver CD-5).

## Decisiones técnicas (DT-N)

- **DT-1**: `FeeChargeParams` se amplía con dos campos **opcionales**
  (`creator?: SplitPartyRef | null`, `referral?: SplitPartyRef | null`).
  Aditivo — no rompe la firma para callers que no los pasen (aunque en la
  práctica los DOS call-sites existentes se actualizan). Esto **deroga
  explícitamente CD-P1 de WKH-136** ("PROHIBIDO cambiar la firma pública de
  `chargeProtocolFee`") — esa CD queda superada por esta HU dedicada, tal
  como preveía el done-report de WKH-136 ("MNR-1 ... requiere HU dedicada").
  El AR de esta HU NO debe marcar el cambio de firma como violación.
- **DT-2**: la resolución de wallet del creador reusa **exactamente** el
  criterio de fallback de `compose.ts:788-801` (`metadata.payTo` canónico →
  fallback `metadata.payment.contract`) para agentes no-self-published; para
  self-published, una query dedicada a `a2a_agents` por `slug` (NO se amplía
  el shape público `Agent`/`/discover` con estas wallets — motivo: privacidad,
  evitar filtrar wallets de creadores en una respuesta pública/discoverable).
- **DT-3**: agente primario = `steps[0].agent` en ambos call-sites (orchestrate
  multi-step y compose single/multi-step) — ratifica la definición SG-5 de
  WKH-136 ("en un pipeline multi-step, creador es ambiguo; v1 = agente
  step[0]").
- **DT-4 (crítica de producto)**: dado que NINGÚN código escribe hoy
  `payout_wallet`/`referrer_ref`, esta HU activa el **wiring** (el "cable"),
  pero la activación REAL de pagos a creadores self-published y a
  referrers depende de un write-path que NO existe (Scope OUT). El impacto
  observable inmediato de esta HU es: (a) creators de agentes de
  MARKETPLACE/registry con `payTo` ya poblado SÍ empiezan a cobrar su split
  si `SPLIT_BPS_CREATOR > 0`; (b) creators self-published y todo referral
  siguen re-ruteándose a plataforma (mismo comportamiento hoy) hasta que
  exista el write-path. Este matiz debe comunicarse al humano explícitamente
  en el gate (no es una limitación oculta).
- **DT-5**: cierre de MNR-3 — extender la evaluación de `extrasFailed` a los
  3 returns tempranos de `chargeProtocolFee` (`existing.status==='charged'`,
  `existing.status==='pending'`, e insert `23505`), simétrico al path de
  éxito post-settle (`fee-charge.ts:489-496`).

## Constraint Directives (CD-N)

- **CD-1 (OBLIGATORIO)**: con la config default `SPLIT_BPS_PLATFORM=10000`
  (`SPLIT_BPS_CREATOR=SPLIT_BPS_REFERRAL=0`), el comportamiento SHALL ser
  byte-idéntico al actual — ninguna suite existente (`fee-charge.test.ts`,
  `orchestrate.billing.test.ts`, money-path.*) puede requerir modificación
  para seguir en verde.
- **CD-2 (OBLIGATORIO)**: reusar EXACTAMENTE el criterio de fallback
  `payTo` → `payment.contract` (DT-2) — PROHIBIDO un mecanismo paralelo de
  resolución de wallet.
- **CD-3 (OBLIGATORIO)**: cerrar MNR-3 (AC-6/DT-5) — `extrasFailed` SHALL
  evaluarse en los 3 returns tempranos, no solo en el path de éxito.
- **CD-4 (OBLIGATORIO)**: recipients SHALL seguir resolviéndose SOLO
  server-side (patrón CD-6 de WKH-136, heredado sin cambios) — PROHIBIDO
  aceptar `creator`/`referral`/wallet alguna del body de `/orchestrate` o
  `/compose`.
- **CD-5 (PROHIBIDO)**: PROHIBIDO exponer `payout_wallet`/`referrer_ref` en
  cualquier respuesta pública (`/discover`, AgentCard, `listAsAgents`,
  `listMine`, `GET /agents/:slug`). Estas columnas SOLO se leen server-side
  en el momento del charge.
- **CD-6 (PROHIBIDO)**: PROHIBIDO modificar el interior ya testeado de
  `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`reverseFeeSplits`
  (`fee-split.ts`) más allá de lo estrictamente necesario para recibir el
  contexto ya resuelto — esos primitivos ya están DONE y probados en
  WKH-136; esta HU SOLO cablea el input.
- **CD-7 (PROHIBIDO)**: PROHIBIDO construir en esta HU el write-path de
  `payout_wallet`/`referrer_ref` (`PATCH /agents`, captura de referrer en
  publish, etc.) salvo ratificación humana EXPLÍCITA que expanda el scope en
  el gate `HU_APPROVED`.
- **CD-8 (OBLIGATORIO)**: `exactOptionalPropertyTypes` — construir
  `FeeChargeParams`/contexto con asignación condicional (`if (v !== undefined)
  obj.x = v`), nunca `x: cond ? v : undefined` (patrón heredado WKH-134/133).

## Missing Inputs

- **[NEEDS CLARIFICATION] #1 (bloqueante para activación REAL de creator
  self-published, no bloqueante para F2)**: ¿esta HU debe incluir el
  write-path de `payout_wallet` (extender `PublishAgentInput`/
  `UpdateAgentInput` + `POST`/`PATCH /agents`) para que el creator de
  agentes self-published (WKH-134) pueda realmente cobrar? Sin esto, el
  wiring de esta HU solo activa creators de agentes de marketplace/registry
  externos (los que ya declaran `payTo`).
- **[NEEDS CLARIFICATION] #2 (bloqueante para activación REAL de referral)**:
  ¿qué es exactamente `referrer_ref`? ¿Un `owner_ref` de OTRO caller de a2a
  (cuya wallet payout se busca en su PROPIA fila `a2a_agents.payout_wallet`,
  exigiendo que el referrer también sea dueño de un agente self-published),
  o un identificador/código de referido pensado para un sistema de
  atribución que aún no existe?
- **[NEEDS CLARIFICATION] #3**: ¿cuándo/cómo se captura `referrer_ref`? ¿Al
  publicar el agente (query param, header), o es un campo que se setea
  fuera de banda (ops/manual) por ahora? Sin resolver esto, referral queda
  funcionalmente inactivo en la práctica aun con el seam cableado
  correctamente — es honesto documentarlo así en el DONE report si no se
  resuelve antes de F2.
- Resuelto en F0 (no bloqueante): agente primario = `steps[0].agent` en
  ambos call-sites (DT-3), reusando la definición SG-5 ya ratificada en
  WKH-136.

## Riesgos (para AR)

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Se interpreta el cambio de firma de `chargeProtocolFee` como violación de CD-P1 (WKH-136) | M | B | DT-1 documenta explícitamente la derogación — el AR de ESTA HU debe validar la firma NUEVA, no la vieja. |
| Creator self-published nunca cobra (payout_wallet siempre NULL) se confunde con un bug de esta HU | A | M | DT-4 lo documenta como comportamiento esperado (falta write-path, Scope OUT) — no es una regresión de esta HU. |
| Referral nunca se activa en la práctica (referrer_ref nunca escrito) | A | M | Mismo que arriba — [NEEDS CLARIFICATION] #2/#3; si no se resuelve, el DONE report debe decirlo honestamente. |
| Exponer wallets de creador en `/discover` u otro endpoint público (privacidad/scraping) | B | A | CD-5 explícito; AR debe verificar que ningún mapper público serialice `payout_wallet`/`referrer_ref`. |
| MNR-3 mal cerrado — un leg roto se reporta `already-charged` sin reflejar el fallo | M | A | AC-6/DT-5 + test dedicado en los 3 returns tempranos. |
| Query extra a `a2a_agents` por invocación (self-published) agrega latencia al money-path | B | B | Solo aplica cuando `registry_id===SELF_PUBLISHED_REGISTRY_ID` (agentes registry externos no pagan el costo); reusar `publishedAgentService.getRow` ya existente (sin duplicar queries). |

## Análisis de paralelismo

- Bloquea: nada explícitamente, pero es SERIAL respecto a cualquier trabajo
  futuro sobre `chargeProtocolFee` (misma superficie money-path que WKH-136).
- Puede ir en paralelo con: WKH-141 (bridge APP-compatible, en progreso,
  `doc/sdd/142-wkh-141-app-capability-declaration/`) — no comparte archivos
  (ese toca Agent Card outbound declarativo, no el money-path del fee).
- Depende lógicamente de WKH-136 (DONE, prod) — el engine ya existe y está
  testeado; esta HU solo cablea el input.
- Si se ratifica el Scope IN de los `[NEEDS CLARIFICATION]` #1-#3 (agregar
  write-path), eso debería tratarse como una HU separada (WKH-143b o
  similar) para no inflar el scope de esta — recomendación conservadora del
  Analyst.
