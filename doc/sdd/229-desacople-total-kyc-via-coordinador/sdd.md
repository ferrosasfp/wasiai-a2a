# SDD #229 — [WKH-366] Chaski deja de hablarle directo al agente de KYC: todo pasa por el Coordinador

- **SDD_MODE**: full
- **Modo**: QUALITY (no negociable)
- **Repos**: 3 — `wasiai-remittance-agents` (A) · `wasiai-a2a` (B, ancla) · `chaski-v3` (C)
- **Work item**: `doc/sdd/229-desacople-total-kyc-via-coordinador/work-item.md` (HU_APPROVED 2026-08-26)
- **Plan aprobado**: `/home/ferdev/.claude/plans/cozy-drifting-bonbon.md`
- **Fecha**: 2026-08-26

---

## 1. Resumen

Chaski invoca hoy al agente de KYC por HTTP directo (2 `fetch` físicos, 3 call sites, el tercero en
el momento del desembolso). Esta HU agrega **dos endpoints nuevos en el agente que hablan el
dialecto de `/compose`**, **dos filas nuevas en el catálogo del Coordinador**, y **un transporte
nuevo en Chaski detrás de la bandera `KYC_TRANSPORT`** (default `direct`).

Lo que **no** hace: no reescribe la lógica de KYC (ya existe, WKH-233), no toca
`kyc_session_tokens`, no toca `/invoke`, no rota ningún secreto, no mueve ningún control del borde.

El eje de riesgo que esta HU **abre y tiene que cerrar en el mismo corte** es la suplantación de
agente: el Coordinador resuelve por capacidad con un ranking (`verified` → reputación → precio) cuya
primera clave es **auto-reportada** por el candidato. Se cierra pinando por `slug` en los tres
niveles (emisor, Coordinador, verificación post-hoc del ejecutor). Ver §5.

---

## 2. Context Map (Codebase Grounding)

### 2.1 Archivos leídos, y qué se extrajo de cada uno

#### `wasiai-a2a` (Repo B — ancla)

| Archivo:línea | Por qué se leyó | Qué se extrajo |
|---|---|---|
| `src/services/compose.ts:1997-2001` | forma de la invocación | **Un solo POST a `agent.invokeUrl` literal**, sin `method` ni `path` por step. Confirmado. |
| `src/services/compose.ts:2031` | forma de la respuesta | `const output = data.result ?? data;` — los dos envoltorios funcionan. |
| `src/services/compose.ts:1536-1553` | de dónde sale `StepResult.output` | `output` se asigna en el literal del `StepResult` **desde el resultado crudo del agente**, antes de cualquier bridge. |
| `src/services/compose.ts:1580-1645` | bridge LLM (CD-2) | El bridge corre **sólo dentro de `if (i < steps.length - 1)`** y muta `lastOutput`, **no** `result.output`. Ver §5.2. |
| `src/services/compose.ts:1698-1736` | `resolveAgent` | Resuelve **sólo por slug** (`discoveryService.getAgent(step.agent)`), con fallback `agents.find(a => a.slug === step.agent)` sobre el pool (`:1723-1724`). |
| `src/services/compose.ts:1822-1825, 1852` | credencial saliente | `resolveSelfPublishedAuthHeaders(agent.invokeUrl)` sólo si `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID`. |
| `src/services/compose.ts:1880-1883` | propagación de headers | `x-a2a-key` sólo si `registry.ownerRef === SYSTEM_OWNER_REF`. Ningún otro header viaja. |
| `src/routes/compose.ts:1175-1215` | cadena de preHandlers | Orden real: `contractingGuard` → `timeout` → **`validateComposeBodyHandler`** → **`resolveComposeCapabilitiesHandler`** → `resolveComposePriceHandler` → `requirePaymentOrA2AKey`. Todo lo anterior al pago es **gratis y sin débito**. |
| `src/routes/compose.ts:180-209` | dónde se valida el pipeline entero | `validateComposeBody(steps)` ve **todos** los steps → es el único punto pre-pago con visión de pipeline. |
| `src/routes/compose.ts:352-415` | resolución por capacidad | `resolveCapability` → `result.agents[0]` (la cabeza del ranking). Falla-cerrado con 422 `no_agent_match`. |
| `src/lib/compose-step-shape.ts:1-15, 49, 112` | dónde va el guard nuevo | Módulo **LEAF** (único import: otro leaf). Su docblock declara: *"Cualquier check que se agregue a este archivo hereda esa propiedad"* (pre-débito, pre-discovery). |
| `src/lib/capability-risk.ts:60, 102-116, 127` | clasificación de capacidades | **Única copia** de la clasificación. `NON_DISBURSEMENT_CAPABILITIES` ya contiene `kyc-hosted-redirect` y `legacy-single-shot-kyc`. |
| `src/services/capability-resolver.ts:9-20, 44-50, 158-190` | el ranking | *"Acá NO hay ranking propio. A propósito."* Y — decisivo para §5.1 — *"`max_price_usdc` y `min_reputation` sí quedan porque son restricciones legítimas del que pide, **no una forma de señalar un agente concreto por la puerta de atrás**"*. |
| `src/services/discovery.ts:577-584` | ¿es forjable `verified`? | **Sí**, para federados: *"sale del card que AUTO-REPORTA el registry"*. Y está hardcodeado `false` para todo self-published. |
| `src/services/discovery.ts:623-655` | el sort | `verified` (1ª clave) → `computedReputation?.score ?? reputation` → precio asc → sorteo. |
| `src/services/discovery.ts:1387-1398` | `getAgent` | **LOCAL-FIRST**: la fila self-published gana antes de consultar ningún registry federado. |
| `src/services/agent.ts:154, 443-449, 480, 578-584` | publicación y unicidad | `verified: false` hardcodeado; `slug` es **PK** y una colisión es `Agent '<slug>' already exists` (dos veces: pre-check y constraint de BD). |
| `src/services/registry.ts:462-467` | alcance de los registries | `getEnabled()` es **global**, sin filtro por owner ⇒ cualquier owner que registre un registry habilitado aporta candidatos al pool global. |
| `src/lib/agent-http-error.ts:90-92` | qué sobrevive del status | `classifyAgentFailure`: `INPUT_REJECTED` para 400/422, `AGENT_ERROR` para **todo lo demás** (401, 502, 429, 500…). |
| `src/types/index.ts:984-1024` | `ComposeStep` | `agent?` \| `capability?` (mutuamente excluyentes), `constraints?`, `input`, `passOutput?`, `inputFromPrevious?`, `acceptanceCriteria?`. **No hay `method`, `path` ni `bridgeType`.** |
| `src/types/index.ts:1461-1466` | `StepResult.bridgeType` | Es un campo de **salida**, no de entrada. Ver §5.2 — AC-7 como está redactado describe algo inexistente. |
| `src/types/index.ts:305-306` | constantes | `SELF_PUBLISHED_REGISTRY_ID = 'self-published'`, `SELF_PUBLISHED_REGISTRY_NAME = 'self-published'`. |
| `scripts/probe-money-path.mjs:1-20, 182-250` | molde del smoke (AC-13) | 6 exit codes, `deriveInput(inputSchema)` en la misma corrida, `schemaFingerprint`, escalera `classify()` pura y testeada. |
| `test/probe-money-path.test.mjs` | que la sonda tiene suite | Las funciones puras del script se testean aparte. Molde para el smoke de C. |
| `package.json:7-18` | gate real de B | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` (biome) → `npm test` (vitest). **`npm run qa` NO existe.** |
| `test/cited-lines-guard.test.ts` (existe) | candado de citas de B | Toda cita `archivo:línea` que escriba el Dev en `wasiai-a2a` entra a este candado. |

#### `wasiai-remittance-agents` (Repo A)

| Archivo:línea | Por qué | Qué se extrajo |
|---|---|---|
| `src/manifest/registry.ts:8, 51-118, 121-122, 163-164, 268-270` | molde de la ficha | `pathSlug !== slug` **ya es la norma** (`remit-corridor-fx` → `remit-corridor-fx-solana`) y está declarado DELIBERADO en `:8`. `findEntry(pathSlug)`. |
| `src/manifest/registry.ts:35-41` | riesgo de OPS | *"TOCAR ESTE ARCHIVO NO REPUBLICA la ficha del catálogo del gateway"*. La copia es manual. |
| `src/manifest/registry.test.ts:13, 124, 155-161` | candados que se van a poner rojos | `toHaveLength(3)` → 5; `kyc?.capabilities` `toHaveLength(6)`; **sin `slug`, `pathSlug` ni `payToEnv` duplicados**. |
| `src/manifest/input-schema-drift.test.ts:28-46, 152-180, 196-199` | el candado que decide §5.4 | `VALIDATORS` es `pathSlug → ZodObject`; el mapa tiene que cubrir **exactamente** los `pathSlug` del registro; y `properties` publicadas **≡** properties derivadas de Zod. El derivador **LANZA** ante un tipo Zod que no conoce. |
| `src/manifest/paytos.ts:10-31` | payTo | Fail-closed por entrada, lectura en tiempo de llamada, una env por entrada. |
| `src/app/api/agents/remit-kyc-validator/session/route.ts:1-128` | molde exacto del endpoint nuevo | Orden normativo del guard (1 auth → 2 `safeParse` → … → 7 el único `fetch`), `NO_STORE` en **las 4 ramas**, 502 fijo + `errorCode` extraído por regex, **nunca un 500**. |
| `src/app/api/agents/remit-kyc-validator/decision/route.ts:30-149` | ídem + deuda | 401 **byte-idéntico** para los 4 veredictos; `no-store` + `Vary`; y la **deuda declarada**: `sessionId`/`identityClaim` en el query string, con el fix (a) = *"mover los dos parámetros al body de un POST"*. |
| `src/app/api/agents/remit-kyc-validator/invoke/route.ts:26-28` | envoltorio | `/invoke` devuelve `{ result }`. |
| `src/app/api/agents/remit-kyc-validator/manifest/route.ts:1-40` | molde del manifest | Wrapper fino sobre `buildManifest(PATH_SLUG)`, `force-dynamic`, 503 value-free. |
| `src/agents/kyc-validator.ts:19-20, 132-137, 142-148, 198-200, 239-287, 290+, 382-385, 405-418, 439-485` | la lógica a envolver | `KycSessionInputSchema` (`.strict()`, `{identityRef?, callbackUrl?}`); `KycSessionOutcome` = `callback_not_allowed \| ok`; `runKycDecision({sessionId, identityClaim, decisionTokenHeader})` → `invalid_request \| unauthorized \| ok`; `isStatusPayoutAllowed` con 3 comparaciones `!== true`. |
| `src/auth/invoke-auth.ts:53-80` | credencial de entrada | `Authorization: Bearer <INVOKE_AUTH_SECRET>`, veredicto cerrado de 5, **nace apagado** si la env falta. |
| `package.json:10-17` | gate real de A | `npm run typecheck` → `npm test` → `npm run build`. **No tiene lint.** Y **no tiene candado de citas** (verificado: no existe `*cit*` en `src/`). |

#### `chaski-v3` (Repo C)

| Archivo:línea | Por qué | Qué se extrajo |
|---|---|---|
| `src/infrastructure/a2a/gateway-client.ts:1-14` | CD-1/WKH-304 | *"NO resuelve el agente por nombre — manda `capability` … y el GATEWAY resuelve"*. |
| `src/infrastructure/a2a/gateway-client.ts:110-118` | `GatewayAgentRef` | `{ slug, registry?, capability?, trial? }` — **el ejecutor real viaja de vuelta**. Es la base de la verificación post-hoc de §5.1. |
| `src/infrastructure/a2a/gateway-client.ts:195-217` | `readAgentRef` | Estrecha `steps[i].agent.slug` y `registry` sin inventar nada. |
| `src/infrastructure/a2a/gateway-client.ts:232-242` | config | `WASIAI_A2A_GATEWAY_URL` + `WASIAI_A2A_AGENT_KEY` (+ `WASIAI_A2A_PAYMENT_CHAIN`). |
| `src/infrastructure/a2a/gateway-client.ts:296-406` | `runViaGateway` | La escalera completa: `not_configured` → `invalid_steps` → fetch → mapeo por status → `success!==true` → largo de `steps` → `output` por step. `x-a2a-key` en `:324`. |
| `src/infrastructure/kyc/agent-env.ts:31, 51-83` | el slug y el rollback | `KYC_AGENT_PATH = "/api/agents/remit-kyc-validator"` — **única aparición en producción**, con `T-ENV-3` contándola. Y: *"el rollback NO ES rotar `KYC_DECISION_TOKEN_SECRET`: eso es un CORTE (CD-21)"*. |
| `src/infrastructure/kyc/agent-kyc-client.ts:29-113, 166-306` | el hermano a construir | `AgentKycCall<T>` = `{ok:true,output} \| {ok:false,upstream:number}`; `KycAgentConfigError`; `UPSTREAM_INVOKE_SECRET_UNSET = -1`; el borde **se estrecha, no se castea**; `identityMatches` se preserva AUSENTE; una clave desconocida **no tira**. |
| `src/infrastructure/payout/authority.ts:130-186, 216-234` | Guard 3..5 y P-7 | Guard 3 (owner-scoped) **antes** del viaje; `!r.ok` ⇒ `kyc_reauth_failed`/502; `payoutAllowed !== true` ⇒ `kyc_not_approved`/200; `catch` ⇒ 502 con log value-free. |
| `app/api/kyc/session/route.ts:365-400` | consumo del cliente | El `upstream` viaja en el **body** del 502. Precedente escrito de que un sentinela negativo **sí** cambia el conjunto observable del body y se dice en voz alta. |
| `app/api/kyc/decision/route.ts:45-115` | ídem + P-5/P-6 | 401 byte-idéntico, `upstream: 0` para "no hubo status upstream", `try/catch` de la route. |
| `src/composition/agent-slug-residue.static.test.ts:1-99` | el candado de slugs | `PROHIBIDAS = ["remit-corridor-fx","remit-cashout-payout"]`. **`remit-kyc-validator` NO entra**, con la excepción escrita dentro del propio candado y el conteo delegado a `T-ENV-3`. |
| `src/composition/` (17 archivos) | moldes de guards estáticos | `kyc-verification-id-guard.static.test.ts` es el exemplar nombrado para "un grep que corre en cada `npm test`". |
| `scripts/smoke-solana-e2e.ts`, `scripts/smoke-helpers.ts`, `scripts/smoke-helpers.test.ts` | molde del smoke de C | Script `.ts` corrido con `tsx`, helpers puros en módulo aparte **con su propio `.test.ts`**. |
| `tsconfig.scripts.json:1-5` | qué se typechequea | `include: ["scripts/**/*.ts"]` — **un `.mjs` queda fuera del gate**. Decide §5.5. |
| `package.json:8-20` | gate real de C | `npm run qa` = `lint`(biome sobre `src app scripts`) → `typecheck` → `typecheck:scripts` → `test`; después `npm run build`. |
| `src/composition/citas-ancladas.test.ts` (existe) | candado de citas de C | Toda cita que escriba el Dev en `chaski-v3` entra acá. |

### 2.2 Hechos medidos por el orquestador (2026-08-26) — incorporados, no re-medidos

**H-1 · La credencial saliente ya cubre el host del agente. VERIFICADO, no asumido.**
Control positivo en dos patas:
(a) `POST https://wasiai-remittance-agents.vercel.app/api/agents/remit-corridor-fx/invoke` sin
`Authorization` → `401 {"error":"unauthorized","reason":"credential_missing"}` ⇒ ese host **exige**
credencial.
(b) La sonda horaria (`.github/workflows/probe-money-path.yml`) da `success` en sus 4 últimas
corridas (2026-08-26 14:57Z, 13:11Z, 11:39Z, 10:47Z) invocando ese mismo agente **a través de
`/compose`**.
⇒ `A2A_SELF_PUBLISHED_OUTBOUND_AUTH` mapea `wasiai-remittance-agents.vercel.app`. Los endpoints
nuevos viven en el **mismo host** y el bearer se resuelve por **host** del `invokeUrl`
(`src/lib/self-published-auth.ts:59`, cableado en `src/services/compose.ts:1822-1825`), no por
slug ni por ruta.
**Consecuencia operativa: NO hace falta ninguna variable nueva en Railway.** El riesgo de OPS que el
work-item dejaba como "probablemente ya, verificar" queda cerrado.

**H-2 · El `agent_url` del catálogo NO tiene que coincidir con el slug de la fila.**
Medido en el catálogo vivo (`GET /discover?limit=100`): la fila `remit-corridor-fx-solana` publica
`invokeUrl = …/api/agents/remit-corridor-fx/invoke`. El `agent_url` es una **columna libre por
fila**. Esto está además declarado del lado del agente (`src/manifest/registry.ts:8`).
⇒ el path del endpoint y el slug de la fila se eligen por criterios independientes. Decide §5.3 y
abarata §5.4.

**H-3 · El catálogo tiene 27 agentes publicados**: 24 en `wasiai-v2.vercel.app` y 3 en
`wasiai-remittance-agents.vercel.app` (`remit-cashout-payout-solana`, `remit-corridor-fx-solana`,
`remit-kyc-validator`).
⇒ **Hoy ningún tercero publica capacidades de KYC.** Y el catálogo **acepta registros de terceros**
(`POST /agents` self-published y `POST /registries` federado, los dos con sólo estar autenticado, y
`registryService.getEnabled()` es global). **El agujero es real aunque hoy no esté explotado.** Ni
más ni menos que eso.

### 2.3 Auto-blindaje histórico — patrones recurrentes que este SDD previene

Leídos: `doc/sdd/228-tablero-tres-preguntas/auto-blindaje.md`,
`doc/sdd/227-sonda-del-money-path/auto-blindaje.md`,
`doc/sdd/226-wkh-335-status-del-agente-estructurado/auto-blindaje.md` (las 3 HUs DONE más recientes).

| Patrón (nº de HUs donde aparece) | Evidencia | Se previene con |
|---|---|---|
| **Citas `archivo:línea` rotas por la propia edición** (3/3) | 226 §BLQ-2 y §fix-pack-3; 228 §FP2-B-3 y §FP3-B-3 ("un error de UNO en el conteo movió DIEZ citas") | **CD-13** |
| **Prosa que afirma un mecanismo que no existe / razón falsa** (3/3) | 228 §M-3, §M-4, §FP2-B-2; 227 §"la prosa del YAML describía un mecanismo inexistente"; 226 §BLQ-1 | **CD-14** |
| **Guard que se lee a sí mismo / escanea su propia prosa** (2/3) | 227 §"El guardián del YAML se denunció a sí mismo por su propia prosa" y §"Tres guardianes escaneaban PROSA junto con código" | **CD-9** (heredado) + §7.4 |
| **El DEFAULT de una escalera era PASS** (1/3, pero es money-path) | 227 §"El DEFAULT de una escalera de monitoreo era PASS" | **CD-15** |
| **Presupuesto de diff escrito ANTES de medirlo / excedido en silencio** (2/3) | 228 §"Escribí el presupuesto ANTES de medirlo" y §"se pasó del techo de 2x"; 226 §MNR-1 | **CD-16** |
| **Archivo nuevo sin `git add` ⇒ gate VERDE FALSO** (1/3, y es de clase) | 226 §"Un archivo NUEVO sin `git add` da un gate VERDE FALSO en este repo" | **CD-17** |
| **`lint` cazó lo que `tsc` y `vitest` dejaron pasar** (1/3) | 226 §Wave-1 | **CD-6** (heredado, orden completo) |

---

## 3. Resolución escrita de las 4 preguntas abiertas

### 3.1 Pregunta 1 — AC-6 / CD-1: anti-suplantación de agente

**Decisión: (a) pinear por `slug`, en TRES niveles independientes.** La opción (b) —`constraints`
que sólo el agente propio satisfaga— **se refuta**, y no por preferencia: por tres hechos medidos.

**Por qué (b) NO sirve. Tres razones, cada una suficiente por sí sola:**

1. **El vocabulario de `constraints` no puede expresar identidad.**
   `ALLOWED_STEP_CONSTRAINTS` (`src/lib/compose-step-shape.ts:49`) y `resolveCapability`
   (`src/services/capability-resolver.ts:158-183`) admiten exactamente tres claves:
   `max_price_usdc`, `min_reputation`, `allow_trial`. Ninguna nombra un publicador, un owner ni una
   identidad. Con el vocabulario de hoy, (b) **no es implementable sin agregar una clave nueva**.

2. **Agregar esa clave está PROHIBIDO por escrito en el propio repo.**
   `src/services/capability-resolver.ts:42-48`, textual:
   > *"⚠️ NO agregar una restricción de CHAIN. Se evaluó y se RECHAZÓ: forzar el rail es hacerle
   > trampa al ranking. […] `max_price_usdc` y `min_reputation` sí quedan porque son restricciones
   > legítimas del que pide, **no una forma de señalar un agente concreto por la puerta de atrás**."*
   Una constraint diseñada para que **sólo** nuestro agente la satisfaga es, literalmente, señalar
   un agente concreto por la puerta de atrás. (b) no es una opción más débil: es la opción que este
   módulo existe para rechazar.

3. **Y aunque se agregara, los criterios existentes son forjables o alcanzables.**
   - `verified` es la **primera clave del sort** (`src/services/discovery.ts:649-650`) y para un
     agente **federado sale del card que el propio agente publica**
     (`src/services/discovery.ts:577-584`, textual: *"sale del card que AUTO-REPORTA el registry"*).
     `registryService.getEnabled()` **no filtra por owner** (`src/services/registry.ts:462-467`), así
     que cualquier owner autenticado puede registrar un registry habilitado y aportar candidatos al
     pool global. Un tercero que declare `verified: true` **ordena por encima de nuestro agente**, que
     es self-published y tiene `verified: false` **hardcodeado** (`src/services/agent.ts:154`).
   - `min_reputation` sí filtra por el score **computado** (no por el auto-reportado), y por eso es
     una defensa real **hoy**; pero es un umbral que se alcanza trabajando, no una identidad. Un
     tercero que liquide tasks llega. Un piso no es un ancla.
   - El único ancla no forjable que existe es `Agent.identity` (ERC-8004, verificada on-chain,
     `attachIdentities`), y **no es un criterio de `constraints`** ni participa del sort.

   ⇒ La afirmación *"constraints que sólo el agente propio pueda satisfacer"* **no se puede
   demostrar** con el catálogo actual. Como el criterio de esta HU es que si no se puede demostrar
   no se afirma, (b) queda descartada.

**Por qué (a) SÍ sirve, y por qué la derogación de CD-1/WKH-304 es correcta acá y no en general:**

- **El pin por slug es no-falsificable por un tercero.** `slug` es la **PK** de `a2a_agents`; una
  colisión se rechaza dos veces (`src/services/agent.ts:449` pre-check, `:480` constraint de BD).
  Una vez que publicamos `remit-kyc-session` / `remit-kyc-decision`, **ningún tercero puede tomar
  esos nombres**. Y `discoveryService.getAgent` es **LOCAL-FIRST**
  (`src/services/discovery.ts:1391-1398`): la fila self-published gana antes de consultar ningún
  registry federado.
- **Qué prohíbe CD-1/WKH-304, leído en su propia letra.** El candado que lo materializa
  (`chaski-v3/src/composition/agent-slug-residue.static.test.ts:38-48`) dice que lo prohibido es
  *"un slug CABLEADO EN VEZ DE PEDIR UNA CAPACIDAD"*, y el daño medido fue que **la pantalla nombraba
  a quien no corría**. Es una regla sobre **usar el slug como atajo cuando pedir la capacidad
  funcionaría igual de bien**. Acá pedir la capacidad **no** funciona igual de bien: cambia quién
  contesta `payoutAllowed`. La derogación es correcta **exactamente en el conjunto de steps cuyo
  output es un veredicto de autorización de dinero**, y en ninguno más: los legs de FX y de payout
  siguen pidiendo capacidad, sin una línea de diff.
- ⚠️ **Y ese mismo candado escribe una instrucción que hay que responder, no ignorar** (`:60-62`):
  > *"El día que el gateway sepa expresar una capacidad de dos saltos con redirect humano, este slug
  > tiene que irse a `PROHIBIDAS` como los otros — y ese día hay que borrar este bloque, no
  > ampliarlo."*
  Este SDD **no lo cumple, y lo dice**: el gateway ya sabe expresar los dos saltos (es lo que esta
  HU construye), pero el slug **se queda** — deja de ser una URL y pasa a ser un pin de seguridad.
  Es un motivo distinto del que la instrucción anticipaba. Acción obligatoria en W3: **reescribir ese
  bloque del candado** para que diga el motivo nuevo, con la fecha y esta HU. Un bloque que dice
  "esto se va el día X" cuando el día X ya llegó y no se fue es prosa que envejeció (CD-14).

**El mecanismo, en tres niveles. Ninguno reemplaza a los otros:**

| Nivel | Dónde | Qué garantiza | Qué NO garantiza |
|---|---|---|---|
| **N1 · el emisor pinea** | `chaski-v3`, el step lleva `agent: <slug>`, nunca `capability` | El ranking no participa: `resolveAgent` busca por slug | Nada, si alguien "simplifica" el emisor de vuelta a capability |
| **N2 · el Coordinador rechaza la capacidad** | `wasiai-a2a`, `compose-step-shape.ts` + `AUTHORIZATION_CAPABILITIES` | Un step con capacidad de autorización se rechaza **400, pre-débito, pre-discovery** | El caso en que nuestra fila se deshabilite y el slug lo sirva un registry federado |
| **N3 · el consumidor verifica el ejecutor** | `chaski-v3`, contra `steps[0].agent` de la respuesta | Que quien contestó es `slug` esperado **y** `registry === 'self-published'`; si no, fail-closed | Que no se haya pagado (el débito ya ocurrió: es post-hoc). Protege la **autorización**, no el gasto |

N3 existe por un residual concreto: si nuestra fila quedara `enabled: false`, el lookup local
devuelve `null` y `getAgent` cae al fanout federado (`src/services/discovery.ts:1402-1408`), donde un
tercero **sí** puede servir un card con ese mismo slug. N3 lo caza; N1 y N2 no.

**El test que puede fallar** — §7.1, T-B3 (el impostor gana el ranking y el sistema lo rechaza) y su
**control positivo** T-B4 (el impostor gana el ranking **de verdad** cuando el guard no está: si T-B4
se pusiera verde-por-no-medir, T-B3 no probaría nada).

### 3.2 Pregunta 2 — Path exacto de los 2 endpoints nuevos

**Decisión:**

| Fila del catálogo (`slug`) | `pathSlug` del agente | Ruta HTTP (`invokeUrl` de la fila) |
|---|---|---|
| `remit-kyc-session` | `remit-kyc-session` | `POST {host}/api/agents/remit-kyc-session/invoke` |
| `remit-kyc-decision` | `remit-kyc-decision` | `POST {host}/api/agents/remit-kyc-decision/invoke` |

**Por qué, y por qué NO bajo el namespace `remit-kyc-validator/`:**

1. **Una fila del catálogo con precio propio exige una entrada de manifiesto propia, y el manifiesto
   se indexa por `pathSlug`.** `findEntry(pathSlug)` (`registry.ts:268-270`) y
   `buildManifest(PATH_SLUG)` son 1:1 con la ruta. Dos filas con precio y `payToEnv` propios ⇒ dos
   entradas ⇒ **dos `pathSlug` distintos** ⇒ dos directorios. Colgarlos de
   `remit-kyc-validator/compose-session/` dejaría dos filas del catálogo compartiendo una entrada de
   manifiesto, y `registry.test.ts:155-161` (sin `pathSlug` ni `payToEnv` duplicados) hace que eso ni
   siquiera sea representable.
2. **El leaf `invoke` y no `session`/`decision`.** Mantiene la forma uniforme del repo
   (`<pathSlug>/invoke` + `<pathSlug>/manifest`), deja el `manifest/route.ts` como copia literal del
   existente, y conserva verdadera la frase *"este guard se llama SÓLO desde los `invoke`"*
   (`src/auth/invoke-auth.ts:43`) — que pasa de 3 a 5 y se actualiza el número.
3. **Nada obliga a que el slug del catálogo iguale el path** (H-2, y `registry.ts:8` lo declara
   deliberado). Acá los elegimos **iguales** igual, por una razón que no es inercia: el `pathSlug`
   ya no puede reusarse, así que hacerlos coincidir es la opción con **una** cosa que recordar en vez
   de dos, y no cuesta nada.
4. **Impacto en los candados de `chaski-v3`, verificado.** `PROHIBIDAS` son
   `["remit-corridor-fx","remit-cashout-payout"]`
   (`agent-slug-residue.static.test.ts:82`) — ninguno de los dos slugs nuevos las contiene, así que
   el candado **no se pone rojo**. Y ninguno contiene la subcadena `remit-kyc-validator`, así que
   **`T-ENV-3` (que exige exactamente 1 aparición en `agent-env.ts`) tampoco se mueve**. Que ningún
   candado se ponga rojo **no** es permiso para no declarar nada: §7.3 agrega los conteos T-SLUG-1/2
   y §3.1 exige reescribir el bloque de excepción.
5. **`/invoke` de `remit-kyc-validator` no se toca** (AC-3/CD-3): rutas distintas, directorios
   distintos, entrada de manifiesto distinta.

### 3.3 Pregunta 3 — Nombres de capacidad

**Decisión: dos capacidades NUEVAS, `kyc-session-create` y `kyc-decision-read`, agregadas a
`NON_DISBURSEMENT_CAPABILITIES` (`src/lib/capability-risk.ts:102-116`), y a un set nuevo
`AUTHORIZATION_CAPABILITIES` en ese mismo archivo.**

- **Por qué no alcanza con las existentes.** `kyc-hosted-redirect` ya existe y ya está clasificada,
  pero la sirve **la fila vieja**. Si las filas nuevas la declararan también, una resolución por esa
  capacidad tendría 2–3 filas nuestras compitiendo entre sí por el ranking. Una capacidad por fila
  hace que "qué capacidad" y "qué contrato de input" sean la misma pregunta.
- **AC-4 queda satisfecha por construcción**: las dos entran a `NON_DISBURSEMENT_CAPABILITIES`, así
  que `classifyCapability` devuelve `'no-disbursement'` y **ningún step de KYC queda
  `'unclassified'`**. Sin esto, publicar el camino nuevo penalizaría al agente con el cupo estrecho
  — que es exactamente el argumento ya escrito en `capability-risk.ts:88-92` para las dos anteriores.
- **`AUTHORIZATION_CAPABILITIES` contiene EXACTAMENTE esas dos, y ninguna preexistente.** Esta es
  una decisión de alcance deliberada:
  - Meter `kyc-verification`, `kyc-check`, `kyc-hosted-redirect`, etc. **rompería con 400 a cualquier
    consumidor externo que hoy componga un step de KYC por capacidad**. No se puede medir desde el
    repo quién hace eso (`/orchestrate` no emite steps por capacidad — verificado: `orchestrate.ts`
    no construye `ComposeStep.capability`; y `chaski-v3` sólo usa `remittance-fx-quote` y
    `remittance-payout`, `gateway-client.ts:19-20`), pero "no lo veo desde acá" **no es** "no
    existe".
  - Las dos capacidades nuevas tienen, por construcción, **cero consumidores** el día que se
    publican. El guard es fail-closed sobre superficie nueva y **cero regresión** sobre la vieja.
  - **Residual declarado (R-1)**: las capacidades de KYC preexistentes siguen siendo resolubles por
    ranking. Para *Chaski* eso es inocuo (pinea por slug). Para un tercero que componga
    `capability: 'kyc-verification'`, el agujero de suplantación **sigue abierto** y esta HU **no lo
    cierra**. Cerrarlo requiere medir el tráfico vivo primero. Va a §8 como HU de seguimiento.
  - El módulo tiene que **decir** esto: agregar una capacidad preexistente al set es un cambio de
    contrato para terceros, no una línea más en un `Set`.

### 3.4 Pregunta 4 — Una fila o dos

**Decisión: DOS filas. Confirmada la recomendación del plan (DT-1), y no por estética.** El
argumento decisivo es mecánico y sale de un candado que ya existe:

`src/manifest/input-schema-drift.test.ts:28-31` mapea **un `pathSlug` a UN `z.ZodObject`**, y
`:196-199` exige que el mapa cubra **exactamente** los `pathSlug` del registro, sin sobrantes. El
derivador usa sólo API pública de Zod (`.shape`, `.isOptional()`, `.unwrap()`, `.options`…) y
**LANZA ante un tipo Zod que no conoce** (`:15-18`).

Una sola fila con `op: 'session' | 'decision'` discriminado obliga a un `z.discriminatedUnion`, que
**no es un `ZodObject`** y que el derivador **no conoce** ⇒ o el candado se pone rojo, o hay que
aflojarlo. Aflojar el único mecanismo que impide que el catálogo mienta sobre el input, para ahorrar
una fila, es exactamente el intercambio que el work-item prohíbe ("si el diseño no puede preservar un
control, el veredicto correcto es no hacer el ítem, no aflojar el control").

Y con H-2 el argumento en contra de dos filas ("no inventar slugs") pierde su costo: el slug de la
fila no arrastra la ruta del agente.

Razones secundarias, ya nombradas en el plan y ahora verificadas: schemas planos (`required` honesto
en cada una: `[]` para sesión, `["sessionId","decisionToken"]` para decisión), precios independientes
(riesgo 1 del work-item: la lectura de decisión corre en **cada** desembolso), y capacidades honestas
(§3.3).

---

## 4. Decisiones técnicas (DT-N)

**Heredadas del work-item** (DT-1..DT-5), todas confirmadas:
- **DT-1** dos filas, no una con `op` — **CONFIRMADA** con el argumento mecánico de §3.4.
- **DT-2** bandera `KYC_TRANSPORT`, default `direct`; el rollback es la env, nunca rotar el secreto.
- **DT-3** `kyc_session_tokens` no cambia de forma.
- **DT-4** el cableado e2e se verifica con un script contra servicios desplegados.
- **DT-5** el orden de los 8 pasos es load-bearing.

**Nuevas:**

- **DT-6 · Los endpoints nuevos son `POST <pathSlug>/invoke` y devuelven `{ result: … }`.**
  El envoltorio `{ result }` es el que usa `/invoke` hoy (`invoke/route.ts:27`) y el que
  `readCoordinatorFee(data)` necesita leer **antes** del colapso `data.result ?? data`
  (`src/services/compose.ts:2024-2031`). Los dos envoltorios "funcionan", pero sólo uno deja lugar
  para el sobre del fee.

- **DT-7 · El dialecto compose usa schemas Zod PROPIOS, no reusa `KycSessionInputSchema` tal cual.**
  Concretamente `KycComposeSessionInputSchema = z.object({ identityRef: z.string().trim().min(1).max(128).optional() }).strict()`.
  **Sin `callbackUrl`.** Razón medida: la allowlist de orígenes **nace vacía y fail-closed**
  (`kyc-validator.ts:165-167`), así que publicar `callbackUrl` en el `inputSchema` del catálogo
  invita a un **400 garantizado** a cualquiera que arme la llamada leyendo la ficha — que es
  textualmente el bug que `input-schema-drift.test.ts:6-13` existe para no repetir. Y Chaski no lo
  manda (`agent-kyc-client.ts:174-176`, DT-11). El core `runKycSession` **no se toca**: recibe
  `parsed.data` y su propio `.parse()` lo acepta (`callbackUrl` es opcional).
  Análogo: `KycComposeDecisionInputSchema = z.object({ sessionId: min(1), identityClaim: min(1).optional(), decisionToken: min(1) }).strict()`.

- **DT-8 · El `decisionToken` viaja en el BODY del POST, no en una cabecera.**
  Obligado: el Coordinador **no propaga headers** hacia el agente (`compose.ts:1852-1883`; sólo
  emite los suyos). Y es **el fix que el propio repo recomienda**: `decision/route.ts:54-57` declara
  la deuda de que `sessionId` e `identityClaim` viajan en el query string y nombra como fix (a)
  *"mover los dos parámetros al body de un POST"*, con el costo de romper el contrato publicado. Acá
  el contrato es **nuevo y aditivo**, así que el costo no se paga: el endpoint nuevo nace con los
  tres datos en el body y **ninguno en el query**.
  ⚠️ Lo que **sí** es nuevo y hay que decir: el `decisionToken` pasa a transitar por el Coordinador
  dentro de `step.input`. Verificado que el Coordinador **no persiste ni loguea** los inputs de step
  (la metadata de `compose_step` son 9 campos, ninguno es el input:
  `src/services/compose.ts:1667-1683`) ni suspende salvo que el agente emita un sobre `a2a_suspend`
  (`:797-812`, que este agente no emite). Va como riesgo declarado R-2, no como no-riesgo.

- **DT-9 · `AUTHORIZATION_CAPABILITIES` vive en `src/lib/capability-risk.ts`.**
  Ese archivo declara ser **la única copia** de la clasificación (`:9-15`) y explica que una segunda
  lista en otro módulo es el bug garantizado. Un set nuevo de capacidades va ahí y en ningún otro
  lado. Se mantiene el módulo **LEAF** (cero imports de runtime) porque `compose-step-shape.ts`
  —también leaf— va a importarlo.

- **DT-10 · El guard de AC-6 corre en `validateComposeBody`, no en el resolver.**
  Es el único punto que (i) ve el pipeline entero, (ii) corre **antes** del débito, del discovery y
  del 402 (`routes/compose.ts:1188` vs `:1197-1199`), y (iii) es una función **pura** sobre el body.
  Rechazar en el resolver costaría un `discover` completo antes de decir que no.

- **DT-11 · CD-2 se cierra por estructura, y se enclava con dos candados.** Ver §5.2.

- **DT-12 · El transporte nuevo de Chaski es un despachador, no una rama dentro del cliente actual.**
  `src/infrastructure/kyc/kyc-transport.ts` exporta `createAgentKycSession` /
  `readAgentKycDecision` (mismas firmas). `agent-kyc-client.ts` **renombra** sus dos exports a
  `…Direct` sin tocar una línea de sus cuerpos. Los 3 call sites cambian **sólo el especificador del
  import** — cero cambio de forma (AC-11). Beneficio ordenado: en el paso 7 se borra un archivo
  entero en vez de desenredar un `if`.

- **DT-13 · `GatewayStep` pasa a ser una unión discriminada, y `runViaGateway` sigue siendo uno.**
  `{ capability, input, constraints? } | { agent, input }`. Los dos legs existentes (FX, payout)
  siguen pasando la primera variante ⇒ **el body que emiten es byte-idéntico** (candado T-C1). Se
  descartó duplicar la escalera de errores en una función hermana: son ~80 líneas de lógica de
  clasificación de fallos del camino del dinero, y dos copias es cómo se desincronizan (es el mismo
  argumento que `capability-risk.ts:9-15` hace para su propia lista).

- **DT-14 · El smoke de AC-13 es `.ts` corrido con `tsx`, no `.mjs`.**
  Medido: `chaski-v3/tsconfig.scripts.json` incluye `scripts/**/*.ts`, así que **un `.mjs` no lo
  typechequea nadie** y `npm run qa` pasaría verde sobre un script roto. El exemplar local
  (`scripts/smoke-solana-e2e.ts` + `smoke-helpers.ts` + `smoke-helpers.test.ts`) ya resuelve esto.
  Se desvía del nombre del work-item (`scripts/smoke-kyc-via-gateway.mjs`) **a propósito**: el
  archivo pasa a ser `scripts/smoke-kyc-via-gateway.ts` con `scripts/smoke-kyc-helpers.ts` +
  `scripts/smoke-kyc-helpers.test.ts`. El molde de **contenido** sigue siendo
  `wasiai-a2a/scripts/probe-money-path.mjs`.

- **DT-15 · Los pasos 7 y 8 (borrar el transporte directo, deprecar la fila `/invoke`) NO entran a
  esta HU.** Razón: el guard de residuo de AC-15 afirma *"no existe `fetch` directo al agente en
  producción"*, y mientras `KYC_TRANSPORT` tenga default `direct` esa afirmación es **falsa por
  diseño**. Mergear el guard en este corte lo dejaría rojo o —peor— lo obligaría a nacer con una
  excepción que lo vacía. AC-15 se **especifica completa** acá (§7.3) y se **implementa** en la HU de
  seguimiento, que arranca cuando el paso 6 esté observado. Lo que **sí** entra ahora son dos
  candados que ya pueden ser ciertos: T-SLUG-1/2 (conteo de apariciones de los slugs nuevos) y
  T-DIRECT-1 (el transporte directo no se propaga mientras conviven).

---

## 5. Diseño técnico

### 5.1 El mecanismo anti-suplantación, en código

**N2 — el guard del Coordinador.**

```
src/lib/capability-risk.ts
  + AUTHORIZATION_CAPABILITIES: ReadonlySet<string> = { 'kyc-session-create', 'kyc-decision-read' }
  + requiresPinnedAgent(capability: string): boolean   // normaliza con el MISMO `normalize` (:122-124)
  + NON_DISBURSEMENT_CAPABILITIES gana esas dos entradas

src/lib/compose-step-shape.ts        (leaf → leaf, se preserva)
  + validateAuthorityPinning(steps: unknown[]): ComposeStepShapeError | null
      · para cada step i con `capability` string tal que requiresPinnedAgent(capability):
          → { error: "Step <i>: capability '<c>' authorizes value delivery and must name the agent
                       explicitly (`agent`), not be resolved by ranking",
              code: 'capability_requires_pinned_agent', step: i }
  + ComposeStepShapeError['code'] gana 'capability_requires_pinned_agent'

src/routes/compose.ts:180-209  (validateComposeBody)
  + tras el bucle de validateComposeStepShape:
        const pinErr = validateAuthorityPinning(steps as unknown[]); if (pinErr) return pinErr;
```

Propiedades que esto hereda por **dónde** corre (`compose-step-shape.ts:8-15`): sin débito, sin
discovery, sin 402. Un impostor **no llega a ser consultado**.

⚠️ **Lo que el guard NO hace, escrito**: no mira `step.agent`. Un step pinado a un slug **ajeno**
pasa este guard y corre — es el caso legítimo de "quiero contratar a ese agente". El guard prohíbe
**delegar la elección**, no elegir mal a propósito.

**N3 — la verificación del ejecutor, del lado de Chaski.**

```
src/infrastructure/kyc/gateway-kyc-client.ts
  const KYC_SESSION_SLUG  = "remit-kyc-session";
  const KYC_DECISION_SLUG = "remit-kyc-decision";
  const EXPECTED_REGISTRY = "self-published";   // wasiai-a2a/src/types/index.ts:306

  tras un runViaGateway ok:
    const ref = r.agents[0];
    if (ref === null || ref.slug !== <slug esperado> || ref.registry !== EXPECTED_REGISTRY)
        return { ok: false, upstream: UPSTREAM_GATEWAY_AGENT_MISMATCH };
```

Fail-closed **por defecto**, no por enumeración: sólo el par exacto `(slug, registry)` pasa; `null`,
ausente, distinto o mal tipado ⇒ rechazo.

**Escalera de fallo → `AgentKycCall`, y sus sentinelas.** Todos negativos para no chocar con un
status HTTP real ni con el `0` ("no hubo status upstream") ni con `-1`
(`UPSTREAM_INVOKE_SECRET_UNSET`, `agent-kyc-client.ts:104`):

| Situación | `upstream` |
|---|---|
| `runViaGateway` devuelve cualquier `{ok:false}` (código cualquiera) | `UPSTREAM_GATEWAY_FAILURE = -2` |
| 200, pero el ejecutor no es el esperado (N3) | `UPSTREAM_GATEWAY_AGENT_MISMATCH = -3` |
| 200, pero el step trae `bridgeType` presente (§5.2) | `UPSTREAM_GATEWAY_BRIDGE_PRESENT = -4` |
| 200 y el output no estrecha (clave faltante / mal tipada) | **tira** (`kyc_agent_bad_response:…`), igual que el directo |
| config de gateway ausente | `UPSTREAM_GATEWAY_FAILURE = -2` (`runViaGateway` ya devuelve `not_configured`) |

⚠️ **El default de la escalera es FALLO** (CD-15). Se escribe como `if (todo-ok) return ok; return
fail;`, nunca como un `switch` sobre códigos conocidos con un `default: ok`. El status HTTP real del
agente **se pierde** en el camino (`agent-http-error.ts:90-92`: sólo sobrevive `INPUT_REJECTED` /
`AGENT_ERROR`), así que enumerar casos conocidos es estructuralmente imposible de hacer bien.

**Efecto sobre `authority.ts`: NINGUNO.** `!r.ok` ⇒ `kyc_reauth_failed`/502 sin mirar `upstream`
(`authority.ts:187-191`). El conjunto observable de `prepare` **no cambia** (CD-16 de ese repo).
Lo que **sí** cambia es el **body** de `/api/kyc/session` y `/api/kyc/decision`, que ecoan `upstream`
— igual que ya pasó con `-1`, y por eso se dice en voz alta (precedente escrito en
`app/api/kyc/session/route.ts:370-372`).

### 5.2 CD-2 / AC-7 — el bridge LLM

🔴 **AC-7, tal como está redactado, describe algo que no existe.** `bridgeType` **no es un campo de
entrada**: no está en `ComposeStep` (`src/types/index.ts:984-1024`, verificado clave por clave) y
sólo aparece como campo de **salida** en `StepResult` (`:1461-1465`). Un caller **no puede
declarar** `bridgeType: 'LLM'`. Rechazarlo "antes de invocar el pipeline" es rechazar un campo que
ningún body puede traer.

Lo que sí puede pasar, medido:

1. El bridge corre **sólo dentro de `if (i < steps.length - 1)`** (`src/services/compose.ts:1580`).
   ⇒ **un pipeline de UN step nunca entra al bloque**, y `steps[0].bridgeType` sale **ausente**.
2. Cuando corre, muta `lastOutput` (`:1631`), que es la **entrada del step siguiente**.
   `result.output` se asignó antes, desde el resultado crudo del agente (`:1536-1537`), y **el bridge
   no lo toca**.
3. Chaski lee `steps[i].output` (`gateway-client.ts:396`), o sea el crudo.

⇒ **El veredicto que Chaski lee no puede ser reescrito por un modelo, en ningún pipeline.**

**Reformulación operativa de AC-7** (para F4; la letra vieja no es verificable):
> WHEN un step de KYC se ejecuta vía `/compose`, the system SHALL entregar al caller el output
> **crudo del agente**, y el caller SHALL rechazar la respuesta si el step reporta que un bridge
> corrió sobre él.

**Enclavado con dos candados que pueden fallar** (si no, la garantía es incidental):

- **T-B5** (`wasiai-a2a`): pipeline de **2 steps**, `maybeTransform` doblado para devolver un objeto
  distinto. Assert: `steps[0].output` es **byte-idéntico** al body del agente 0, y **distinto** de
  la entrada que recibió el agente 1. Mutante que lo pone rojo: mover la asignación de
  `result.output` después del bridge.
- **T-B6** (`wasiai-a2a`): pipeline de **1 step**. Assert `steps[0].bridgeType === undefined` y que
  el doble de `maybeTransform` recibió **cero llamadas** (contador, no status). Mutante: cambiar el
  guard a `i <= steps.length - 1`.
- **T-C6** (`chaski-v3`): el transporte rechaza con `-4` si `steps[0].bridgeType` está presente.

**CD-2 pasa además a ser una propiedad del emisor**: el transporte de Chaski manda **exactamente un
step por llamada** (igual que los legs de FX y payout hoy, `gateway-client.ts:306-320`). Un step
único no tiene "siguiente".

### 5.3 Contratos de cable (los dos endpoints nuevos)

**`POST /api/agents/remit-kyc-session/invoke`**

```
Authorization: Bearer <INVOKE_AUTH_SECRET>          ← guardInvokeAuth(req, "remit-kyc-session")
body: { identityRef?: string }                      ← .strict()
200 → { result: { sessionId, url, decisionToken, provenance } }
400 → { error:"invalid_input", details: <Zod flatten()> }        (clave desconocida, tipo malo)
400 → { error:"invalid_input", details:{formErrors:["callback_origin_not_allowed"],…} }  ← inalcanzable
       hoy (el schema no admite callbackUrl) pero se mapea igual: el `switch` sobre `KycSessionOutcome`
       es exhaustivo y omitir la rama NO COMPILA
401 → el 401 de guardInvokeAuth, sin tocar
502 → { error:"verification_unavailable" }
Cache-Control: no-store  +  Vary: authorization      ← en las 4 ramas
```

**`POST /api/agents/remit-kyc-decision/invoke`**

```
Authorization: Bearer <INVOKE_AUTH_SECRET>
body: { sessionId: string, identityClaim?: string, decisionToken: string }   ← .strict()
200 → { result: { terminal, status, lifecycle, approved, riskLevel, verificationId,
                  provenance, payoutAllowed, reasons[], identityMatches? } }
400 → invalid_input (Zod)  |  400 { error:"missing_session" }   ← rama invalid_request del core
401 → { error:"unauthorized" }   ← BYTE-IDÉNTICO a las otras ramas de 401 (P-6). El core colapsa los
       4 veredictos de verifyDecisionToken a propósito (kyc-validator.ts:378-380)
502 → { error:"verification_unavailable" }
no-store + Vary en las 4 ramas
```

⚠️ **Cómo se preservan los status, y por qué importa.** No se colapsa nada a 200: bajo `/compose` el
400 se clasifica `INPUT_REJECTED` y todo lo demás `AGENT_ERROR`
(`wasiai-a2a/src/lib/agent-http-error.ts:90-92`). Si el endpoint nuevo devolviera 200 con un
`{error}` adentro, Chaski intentaría estrechar el output, tiraría
`kyc_agent_bad_response:decision:terminal` y el diagnóstico apuntaría al lugar equivocado.

⚠️ `runKycDecision` recibe el token en un parámetro llamado `decisionTokenHeader`
(`kyc-validator.ts:439-443`). El endpoint nuevo le pasa `parsed.data.decisionToken` **sin renombrar
el parámetro**: renombrarlo tocaría el core y la ruta vieja (CD-3). Queda declarado en el docblock
del endpoint nuevo — el nombre dice de dónde venía, no de dónde tiene que venir.

**Las dos entradas de manifiesto** (`src/manifest/registry.ts`):

| campo | `remit-kyc-session` | `remit-kyc-decision` |
|---|---|---|
| `pathSlug` / `slug` / `name` | `remit-kyc-session` | `remit-kyc-decision` |
| `capabilities` | `["kyc-session-create"]` | `["kyc-decision-read"]` |
| `inputSchema.required` | `[]` | `["sessionId","decisionToken"]` |
| `inputSchema.properties` | `identityRef` | `sessionId`, `identityClaim`, `decisionToken` |
| `chain` / `family` / `asset` | `solana-devnet` / `solana` / `USDC` | ídem |
| `payToEnv` | `REMIT_KYC_SESSION_PAYTO` | `REMIT_KYC_DECISION_PAYTO` |
| `priceUsdc` | `KYC_PRICE_USDC` (0.02) | `KYC_PRICE_USDC` (0.02) — ver §9 |

⚠️ **`payToEnv` tiene que ser único** (`registry.test.ts:155-161`), así que reusar
`REMIT_KYC_VALIDATOR_PAYTO` **no es opción**. Son **dos envs nuevas en Vercel**, y se siembran
**ANTES** del deploy del paso 1 (§6, W1-OPS). Sin ellas, `buildManifest` devuelve
`{ok:false, reason:"missing"}` y el `/manifest` da 503 — falla-cerrado, pero es una caída evitable
por orden. Es exactamente la clase de error que costó los 8 días de agosto.

⚠️ **`description`**: la del `remit-kyc-validator` nombra el flujo hosted-redirect como RECOMENDADO
(`registry.ts:63-64`). Las dos fichas nuevas describen **qué hace cada paso y qué NO recibe**
(ninguna recibe `legalId`) y **no** duplican la marca de deprecación de `/invoke`, que sigue viviendo
en su ficha. `registry.test.ts:89-124` (T-23, "la marca de deprecación, las dos mitades") se lee
antes de tocar la descripción del KYC viejo: **no se toca**.

### 5.4 Chaski — el transporte

```
src/infrastructure/kyc/kyc-transport.ts          [NUEVO]  el despachador
    readKycTransport(): "direct" | "gateway"      // process.env.KYC_TRANSPORT, trim, default "direct"
                                                  // ⛔ cualquier valor que no sea exactamente
                                                  //    "gateway" ⇒ "direct" (fail-safe: un typo NO
                                                  //    enciende el camino nuevo)
    export createAgentKycSession / readAgentKycDecision   // mismas firmas que hoy

src/infrastructure/kyc/gateway-kyc-client.ts     [NUEVO]  el hermano por gateway
    createAgentKycSessionViaGateway / readAgentKycDecisionViaGateway
    · arma UN step { agent: <slug>, input: {…} }  (nunca `capability`)
    · runViaGateway({ steps:[step] })
    · N3 (§5.1) + chequeo de bridge (§5.2) + estrechado campo a campo, COPIADO del directo
      (mismos `readString`/`readBoolean`/`readRiskLevel`, mismos códigos
       `kyc_agent_bad_response:<rama>:<campo>`) ⇒ los dos transportes fallan igual

src/infrastructure/kyc/agent-kyc-client.ts       [MOD]    renombra 2 exports a …Direct. Cuerpos intactos.
src/infrastructure/a2a/gateway-client.ts         [MOD]    GatewayStep → unión (DT-13) + cabecera reescrita
app/api/kyc/session/route.ts                     [MOD]    sólo el especificador del import
app/api/kyc/decision/route.ts                    [MOD]    sólo el especificador del import
src/infrastructure/payout/authority.ts           [MOD]    sólo el especificador del import
```

⛔ **`src/infrastructure/kyc/agent-env.ts` NO SE TOCA.** Contiene la única aparición del slug viejo
en producción y `T-ENV-3` cuenta apariciones **textuales** en ese archivo, prosa incluida. Un
comentario nuevo que lo nombre lo pone rojo.

**P-4 se replica, no se reinventa.** El transporte `gateway` arma el body con **la misma regla**:
`identityRef` ausente ⇒ **la clave se omite** (nunca `null`, nunca `undefined` explícito), porque el
schema es `.strict()` y omitirla es lo que materializa "sin prueba de posesión la persona se verifica
igual, con la sesión sin atar" (`agent-kyc-client.ts:169-172`). Ídem `identityClaim` en decisión.

### 5.5 El smoke de AC-13

`scripts/smoke-kyc-via-gateway.ts` + `scripts/smoke-kyc-helpers.ts` (+ `.test.ts`), contra
**servicios desplegados**, con el agente en `DIDIT_ENV=mock`.

```
1. GET  {gateway}/discover/remit-kyc-session      → inputSchema (+ fingerprint)
2. deriveInput(inputSchema)  ← DEL SCHEMA DE ESA CORRIDA. Nunca hardcodeado.
3. POST {gateway}/compose  { steps:[{ agent:"remit-kyc-session", input: <derivado> }] }
        assert: success, steps.length===1, steps[0].agent.slug/registry, bridgeType ausente,
                output = { sessionId, url, decisionToken, provenance }  (4 claves)
4. GET  {gateway}/discover/remit-kyc-decision     → inputSchema
        assert de DRIFT: required ⊆ { sessionId, identityClaim, decisionToken }.
        ⚠️ Este step NO se deriva ciegamente: su input es una CREDENCIAL emitida en el paso 3.
        Derivar `decisionToken: "x-decisionToken"` sólo probaría que el 401 funciona. Lo que se
        deriva es el CONJUNTO DE CLAVES; los VALORES vienen del paso 3. Si el catálogo pide una
        clave que la sonda no sabe llenar ⇒ exit DRIFT, no un verde.
5. POST {gateway}/compose  { steps:[{ agent:"remit-kyc-decision", input:{sessionId, decisionToken,
                                       identityClaim:<addr de prueba>} }] }
        assert: las claves del contrato, cruzadas contra el `outputSchema` publicado
6. self-test opt-in: repetir el paso 3 SIN una clave requerida ⇒ tiene que ser rechazado.
        ⚠️ Si la clave que se pidió romper no estaba en el cuerpo derivado ⇒ CONFIG, no PASS
        (`probe-money-path.mjs:250-263`: sin eso, un typo compra un hallazgo fabricado).
```

**Exit codes (≥6, cada uno atribuye la causa):**

| code | significado |
|---|---|
| 0 | PASS |
| 1 | excepción no manejada — defecto de la sonda |
| 2 | caída candidata de producción (5xx, timeout, DNS, `AGENT_ERROR`) |
| 3 | config de la sonda (envs, credencial, saldo, `INSUFFICIENT_BUDGET`) |
| 4 | **drift de contrato** (schema/claves/`outputSchema` cambiaron) |
| 5 | se **aceptó** un cuerpo inválido (el self-test no fue rechazado) |
| 6 | **suplantación**: el ejecutor no fue `(slug, self-published)` esperado |

⛔ **La escalera es pura, vive en `smoke-kyc-helpers.ts`, tiene su `.test.ts`, y su fila por defecto
NO es PASS** (CD-15; el precedente es `227/auto-blindaje.md:72`).
⛔ Nunca imprime la credencial, ni truncada.

---

## 6. Waves — el orden de DESPLIEGUE, que no es el de escritura

⚠️ **El código de W3 (Chaski) puede escribirse en paralelo con W1/W2**, siempre que la bandera quede
en `direct`. Lo que **no** se puede adelantar es el orden de **deploy y verificación**. Tres
worktrees, tres branches (los del work-item).

### W0 — Contratos y clasificación (SERIAL, sin deploy, cross-repo)

| Repo | Archivo | Qué |
|---|---|---|
| A | `src/agents/kyc-validator.ts` | `+ KycComposeSessionInputSchema`, `+ KycComposeDecisionInputSchema` (`.strict()`), exportados. **Cero cambio de comportamiento** en `runKycSession`/`runKycDecision`. |
| A | `src/manifest/registry.ts` | `+` las 2 entradas de §5.3 |
| A | `src/manifest/registry.test.ts` | `3 → 5` (`:13`); duplicados (`:155-161`) siguen valiendo |
| A | `src/manifest/input-schema-drift.test.ts` | `VALIDATORS` y `GATE_REQUIRED` ganan los 2 `pathSlug` nuevos |
| B | `src/lib/capability-risk.ts` | `+ 'kyc-session-create'`, `+ 'kyc-decision-read'` en `NON_DISBURSEMENT_CAPABILITIES`; `+ AUTHORIZATION_CAPABILITIES`; `+ requiresPinnedAgent()` |
| B | `src/lib/capability-risk.test.ts` | clasificación de las 2 nuevas + que ninguna capacidad preexistente entró al set nuevo |

**Salida de W0**: los dos repos compilan y sus gates pasan. Nada desplegado.

### W1 — Repo A: los endpoints (paralelizable interno: los 2 endpoints entre sí)

| Archivo | Qué |
|---|---|
| `src/app/api/agents/remit-kyc-session/invoke/route.ts` | NUEVO. Molde exacto: `remit-kyc-validator/session/route.ts` |
| `src/app/api/agents/remit-kyc-session/manifest/route.ts` | NUEVO. Copia literal de `remit-kyc-validator/manifest/route.ts` con otro `PATH_SLUG` |
| `src/app/api/agents/remit-kyc-decision/invoke/route.ts` | NUEVO. Molde: `remit-kyc-validator/decision/route.ts`, GET→POST, query→body |
| `src/app/api/agents/remit-kyc-decision/manifest/route.ts` | NUEVO |
| `src/auth/invoke-auth.ts:43` | prosa: "los 3 `invoke`" → 5 (CD-14) |
| tests | `…/remit-kyc-session/invoke/route.test.ts`, `…/remit-kyc-decision/invoke/route.test.ts`, `src/app/api/agents/compose-dialect-no-pii.test.ts` |

**W1-OPS (BLOQUEANTE, va ANTES del deploy):** sembrar `REMIT_KYC_SESSION_PAYTO` y
`REMIT_KYC_DECISION_PAYTO` en Vercel (mismo valor que `REMIT_KYC_VALIDATOR_PAYTO`).
**Gate A completo** (`npm run typecheck` → `npm test` → `npm run build`) → deploy. `/invoke` sigue
vivo. Verificación: `GET /api/agents/remit-kyc-session/manifest` da **200**, no 503.

### W2 — Repo B: guard + catálogo

| Archivo | Qué |
|---|---|
| `src/lib/compose-step-shape.ts` | `+ validateAuthorityPinning`, `+ code 'capability_requires_pinned_agent'` |
| `src/lib/compose-step-shape.test.ts` | los casos del guard |
| `src/routes/compose.ts:180-209` | cablear el guard dentro de `validateComposeBody` |
| `src/routes/compose.capability.test.ts` | T-B3, T-B4 (§7.1) |
| `src/routes/compose.test.ts` | T-B5, T-B6 (§5.2) |
| `doc/INTEGRATION.md` | si documenta los códigos de error de `/compose`, agregar el nuevo (verificar antes de escribir) |

**W2-OPS (no es diff de git):**
1. Publicar las **2 filas self-published** en `a2a_agents` con `agent_url` apuntando a los endpoints
   nuevos, `metadata.inputSchema` = copia exacta de la ficha de A, `metadata.outputSchema` (para que
   el smoke pueda cruzar nombres de campo), `enabled: true`, `discoverable: true`, capacidad única
   por fila, precio y payment spec de §5.3.
2. **Verificar `GET /discover/remit-kyc-session` y `GET /discover/remit-kyc-decision`** (AC-5):
   `invokeUrl` resuelve a los endpoints nuevos (**no** a `/invoke`) y `inputSchema.required` **no**
   contiene `legalId`.
3. **Credencial saliente: NO se toca nada** (H-1). Se re-verifica leyendo, no escribiendo: la sonda
   horaria sigue verde.

**Gate B completo** (`npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`) → deploy.

### W3 — Repo C: transporte con la bandera en `direct` (cero cambio de comportamiento)

| Archivo | Qué |
|---|---|
| `src/infrastructure/a2a/gateway-client.ts` | `GatewayStep` → unión (DT-13); emisión condicional; **cabecera del archivo reescrita** (CD-14: hoy afirma "NO resuelve el agente por nombre" sin excepción) |
| `src/infrastructure/kyc/gateway-kyc-client.ts` | NUEVO |
| `src/infrastructure/kyc/kyc-transport.ts` | NUEVO (despachador + `readKycTransport`) |
| `src/infrastructure/kyc/agent-kyc-client.ts` | rename de 2 exports a `…Direct`. **Cuerpos intactos** |
| `app/api/kyc/session/route.ts`, `app/api/kyc/decision/route.ts`, `src/infrastructure/payout/authority.ts` | sólo el especificador del import |
| `src/composition/agent-slug-residue.static.test.ts` | **reescribir el bloque WKH-233** (§3.1) |
| `src/composition/kyc-gateway-slug-count.static.test.ts` | NUEVO — T-SLUG-1/2, T-DIRECT-1 (§7.3) |
| `.env.example` | `KYC_TRANSPORT` documentado, con el orden de encendido y el ⛔ de no rotar el secreto |
| tests | `gateway-kyc-client.test.ts`, `kyc-transport.test.ts`, `authority.gateway.test.ts` |

⛔ `src/infrastructure/kyc/agent-env.ts`: **cero diff**.
**Gate C completo** (`npm run qa` → `npm run build`) → deploy con `KYC_TRANSPORT` **ausente**.

### W4 — Verificación e2e en mock (AC-13)

| Archivo | Qué |
|---|---|
| `scripts/smoke-kyc-helpers.ts` | NUEVO (puro: `deriveInput`, `assertExecutor`, `classify`, fingerprint) |
| `scripts/smoke-kyc-helpers.test.ts` | NUEVO |
| `scripts/smoke-kyc-via-gateway.ts` | NUEVO (I/O) |
| `package.json` | `+ "smoke:kyc-gateway": "tsx scripts/smoke-kyc-via-gateway.ts"` |

Corrida contra los servicios desplegados de W1/W2. **Exit 0 es el AC.**

### W5 — Cutover (OPS, sin diff)

5. `KYC_TRANSPORT=gateway` en **preview** → **corrida real de Didit del founder** con un desembolso
   verificado punta a punta (AC-14). Medir latencia antes/después (riesgo 2).
6. `KYC_TRANSPORT=gateway` en **producción**. Observar. Rollback = borrar la env.
   ⛔ **NUNCA** rotar `KYC_DECISION_TOKEN_SECRET` (`agent-env.ts:27-29`, CD-4/CD-21: eso es un CORTE
   que invalida los tokens de gente ya verificada que no cobró).

### W6 — HU de seguimiento (NO entra a este corte, DT-15)

7. Borrar el transporte directo + guard de residuo (AC-15, diseñado en §7.3).
8. Deprecar la fila `/invoke` del catálogo.

---

## 7. Plan de tests — ≥1 por AC

⚠️ **CD-8: cada test se rompe a propósito antes de darse por bueno**; el mutante y el rojo se citan
en el `auto-blindaje.md` y en F4. "El test pasa" es la mitad barata.

### 7.1 Repo B — el eje de seguridad

| id | AC | Qué mide | Mutante que lo pone rojo |
|---|---|---|---|
| **T-B1** | AC-4 | `classifyCapability('kyc-session-create')` y `('kyc-decision-read')` = `'no-disbursement'`; ninguna es `'unclassified'` | sacar una del set |
| **T-B2** | AC-4 | `AUTHORIZATION_CAPABILITIES` **no** contiene ninguna capacidad preexistente (se compara contra el `NON_DISBURSEMENT_CAPABILITIES` de antes de esta HU, escrito literal en el test) | agregar `kyc-verification` al set |
| **T-B3** | **AC-6** | 🔴 **El escenario del impostor.** Discovery doblado devuelve como `agents[0]` un `evil-kyc` con `verified:true`, `reputation:100`, `priceUsdc:0.000001` (o sea: **gana el ranking**). `POST /compose` con `{capability:'kyc-decision-read'}` ⇒ **400 `capability_requires_pinned_agent`**, el doble de `ssrfFetch` recibe **cero** llamadas, y **no hubo débito** | quitar la capacidad del set ⇒ el impostor gana, es invocado y devuelve `payoutAllowed:true` |
| **T-B4** | AC-6 | 🔴 **Control positivo del instrumento.** Con el MISMO doble, `resolveCapability('kyc-decision-read', undefined, undefined)` (sin pasar por el guard) devuelve **`evil-kyc`**. Si esto diera "no candidates", T-B3 estaría midiendo un doble que no arma el ataque | — (este test **afirma** que el agujero existe; su valor es que T-B3 no sea teatro) |
| **T-B5** | AC-7' | 2 steps, `maybeTransform` doblado: `steps[0].output` byte-idéntico al body del agente 0 y **distinto** de lo que recibió el agente 1 | mover `result.output` después del bridge |
| **T-B6** | AC-7' | 1 step: `steps[0].bridgeType === undefined` y `maybeTransform` **cero llamadas** (contador) | `i < steps.length - 1` → `i <= steps.length - 1` |
| **T-B7** | AC-6 | Un step con `agent:'remit-kyc-decision'` (pinado) **pasa** el guard y se invoca normal | invertir el predicado |
| **T-B8** | AC-6 | El guard corre **pre-pago**: 400 sin que el middleware de débito se haya ejecutado (contador del doble de débito = 0) | mover el guard al route handler |

**AC-5** se verifica en OPS con `GET /discover/<slug>` (evidencia: el JSON de la corrida, con
`invokeUrl` y `required`). No hay test unitario posible: la fila vive en la BD, no en el repo.

### 7.2 Repo A

| id | AC | Qué mide | Mutante |
|---|---|---|---|
| **T-A1** | AC-1 | `POST /remit-kyc-session/invoke` con `{identityRef}` ⇒ 200, `result` con **exactamente 4 claves** (`Object.keys().sort()`), y `runKycSession` recibió el input | agregar una 5ª clave al output |
| **T-A2** | AC-1 | Sin `identityRef` ⇒ 200 igual, y la clave **no** viaja al core (P-4) | `identityRef: input.identityRef ?? null` |
| **T-A3** | **AC-2** | Body con `legalId` (clave fuera del `.strict()`) ⇒ **400**, el doble de `fetch` recibe **cero** llamadas, y el body del 400 **no contiene el valor** del `legalId` | `.strict()` → `.passthrough()` |
| **T-A4** | AC-2 | Ídem para el endpoint de decisión, con una clave desconocida | ídem |
| **T-A5** | AC-1/2 | Sin `Authorization` ⇒ **401** en los dos endpoints, **antes** de parsear el body (contador: `req.json` no se llamó) | mover `guardInvokeAuth` después del `safeParse` |
| **T-A6** | AC-2 | Decisión con `decisionToken` inválido ⇒ **401 byte-idéntico** al de "sin token" y al de "sesión ajena", y el doble de `fetch` al partner recibe **cero** llamadas | agregar un `reason` a una de las ramas |
| **T-A7** | AC-1/2 | `no-store` + `Vary` en **las 4 ramas** de cada endpoint (200/400/401/502) — se comparan las cabeceras entre sí, no contra un literal | sacar `no-store` de una rama |
| **T-A8** | **AC-3** | `/api/agents/remit-kyc-validator/{invoke,session,decision}` byte-idénticos: el test existente no se toca y **sigue verde**. Se agrega un assert de que `MANIFEST_ENTRIES` conserva la entrada `remit-kyc-validator` con sus 6 capabilities y su `inputSchema` intacto | cambiar cualquier cosa de esa entrada |
| **T-A9** | AC-1/2 | `input-schema-drift` cubre los 2 `pathSlug` nuevos (lo hace el test existente, sólo hay que poblar los mapas) | publicar un `required` que Zod no exige |
| **T-A10** | AC-1 | Ninguna respuesta de los 2 endpoints contiene `legalId`, `travelRuleData` ni ningún dato de identidad (barrido sobre el JSON serializado de las 4 ramas) | ecoar `parsed.data` en el 400 |

### 7.3 Repo C

| id | AC | Qué mide | Mutante |
|---|---|---|---|
| **T-C1** | AC-8 | 🔴 **La bandera conmuta, y se mide CONTANDO, no leyendo status.** Con `KYC_TRANSPORT` ausente y con `"direct"`: el doble de `fetch` recibe **≥1** llamada al host del agente y **0** al gateway. Con `"gateway"`: **0** al agente y **≥1** al gateway | invertir el default |
| **T-C2** | AC-8 | Con `direct`, el body y la URL del `fetch` son **byte-idénticos** a los de antes de esta HU (snapshot del `RequestInit`) | tocar el cuerpo del cliente directo |
| **T-C3** | AC-8 | `KYC_TRANSPORT="GATEWAY"`, `" gateway"`, `"1"`, `"true"`, `""` ⇒ **`direct`**. Sólo el literal exacto enciende | `toLowerCase()` o truthiness |
| **T-C4** | AC-9 | Con `gateway`: el body de `/compose` lleva **`agent`** (nunca `capability`), **un solo step**, y `x-a2a-key` en la cabecera | emitir `capability` |
| **T-C5** | **AC-6** | 🔴 El gateway devuelve 200 con un output de decisión perfectamente válido pero `steps[0].agent.slug = "evil-kyc"` ⇒ `{ok:false, upstream:-3}` ⇒ `authority` devuelve `kyc_reauth_failed`/502 y **NO autoriza** | borrar el chequeo de slug ⇒ **autoriza un desembolso** |
| **T-C5b** | AC-6 | Ídem con el slug correcto pero `registry: "un-registry-cualquiera"` ⇒ rechazo | chequear sólo el slug |
| **T-C6** | AC-7' | 200 con `steps[0].bridgeType: "LLM"` ⇒ `{ok:false, upstream:-4}` | ignorar el campo |
| **T-C7** | **AC-10** | 🔴 **Fail-closed por defecto, no por enumeración.** Tabla: `not_configured`, `unavailable`, `bad_response`, `payment_required`(402), `forbidden`(403), `no_agent_match`(422), `step_failed`+`AGENT_ERROR`, `step_failed`+`INPUT_REJECTED`, `step_failed` **sin** `agentFailure`, y **un código inventado que no existe en el union** ⇒ los 10 dan `{ok:false}` ⇒ los 10 dan `kyc_reauth_failed`/502 y **ninguno autoriza** | un `default:` que devuelva `ok:true` |
| **T-C8** | AC-10 | 200 con `payoutAllowed: "true"` (el STRING) ⇒ `readBoolean` **tira** ⇒ 502. Y con `payoutAllowed:false` ⇒ `kyc_not_approved`/200 (no 502): las dos negativas **no** se colapsan | `=== true` → truthiness |
| **T-C9** | AC-11 | Los 3 call sites siguen llamando `createAgentKycSession` / `readAgentKycDecision` con la misma firma; `authority.ts` conserva los 7 guards en el mismo orden (assert estructural sobre el orden de efectos: `tokenStore.getForOwner` **antes** del transporte — contador) | mover Guard 3 después del viaje (rompe P-7) |
| **T-C10** | **AC-12** | Bajo **los dos** transportes: `(session_id, owner_address)` que no matchea ⇒ `kyc_ownership_mismatch` con `httpStatus:200`, y **el transporte no se invoca** (contador = 0) | pasar el claim crudo en vez del canonicalizado |
| **T-C11** | AC-9 | El transporte `gateway` **omite** la clave `identityRef` / `identityClaim` cuando no hay (P-4), no manda `null` | `?? null` |
| **T-C12** | AC-13 | `smoke-kyc-helpers.test.ts`: `deriveInput` deriva del argumento (caso `enum → primer valor`), y `classify` **no** devuelve PASS en su fila por defecto | hardcodear el input; `default: PASS` |
| **T-SLUG-1/2** | AC-15 (parcial) | Cada slug nuevo aparece **exactamente 1 vez** en producción (`src`+`app`, excluyendo tests y el propio guard) — molde: `T-ENV-3` en `agent-env.test.ts` | escribir el slug en un segundo módulo |
| **T-DIRECT-1** | AC-15 (parcial) | `kycAgentUrl` / `resolveKycAgentBaseUrl` se importan desde **exactamente un** módulo de producción (`agent-kyc-client.ts`) | importarlo desde el gateway-client |

**AC-15 completo (para la HU de seguimiento, ya diseñado):** guard estático en
`src/composition/kyc-direct-transport-residue.static.test.ts`, molde
`agent-slug-residue.static.test.ts:94-108` (walk de `src`+`app`, `SKIP_DIRS`, `isTestFile`,
exclusión de `SELF`). Busca: (i) la subcadena del path del agente, (ii) el símbolo `kycAgentUrl`,
(iii) `resolveKycAgentBaseUrl`. **No puede leerse a sí mismo** porque `path.resolve(full) !== SELF`
lo excluye del conjunto escaneado — el mismo mecanismo que el exemplar. Se merguea **el mismo día**
que se borra `agent-kyc-client.ts` y `agent-env.ts`, no antes (DT-15).

**AC-14** no es un test: es una precondición humana. Evidencia para F4 = la corrida del founder con
el hash del desembolso y la fecha, anotada en el reporte de cierre.

### 7.4 Reglas transversales de los tests

- ⛔ **Ningún guard se lee a sí mismo** (CD-9): todo guard estático excluye su propio path del walk.
- ⛔ **Ningún test de cableado se da por bueno con `vi.stubGlobal('fetch')`** (CD-7). Los dobles
  miden **decisiones**; el cableado lo mide W4 contra servicios desplegados.
- ⛔ **Los tests de orden miden CONTADORES, no status** (el molde está escrito en
  `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/session/route.ts:34-36`: *"No es
  un test sobre el status: es un test sobre el contador"*).

---

## 8. Constraint Directives

### Heredados del work-item (vigentes, sin cambio)

- **CD-1** PROHIBIDO que un step de `/compose` con capacidad de KYC resuelva por ranking. →
  materializado en §5.1 (3 niveles).
- **CD-2** PROHIBIDO el bridge LLM en steps de KYC. → §5.2.
- **CD-3** OBLIGATORIO mantener `/invoke` vivo y sin modificar hasta el paso 8.
- **CD-4** PROHIBIDO cambiar el contrato del `decisionToken` o su secreto.
- **CD-5** PROHIBIDO tocar `wasiai-facilitator` o el camino de pago on-chain.
- **CD-6** OBLIGATORIO el gate **completo** de cada repo, **en su orden real leído de su
  `package.json`** (verificado hoy, los 3): A = `typecheck` → `test` → `build` (no tiene lint);
  B = `npx tsc -p tsconfig.json --noEmit` → `lint` → `test` (**`npm run qa` NO existe**);
  C = `qa` (lint→typecheck→typecheck:scripts→test) → `build`.
- **CD-7** PROHIBIDO dar por probado el cableado con un test que doble `fetch`.
- **CD-8** OBLIGATORIO romper a propósito todo test que afirme un comportamiento, y citar el rojo.
- **CD-9** PROHIBIDO que un guard se lea a sí mismo.

### Nuevos (de este SDD)

- **CD-10** ⛔ **PROHIBIDO que `legalId` —o cualquier dato de identidad— aparezca en el `inputSchema`
  publicado, en el body aceptado o en la respuesta de los endpoints nuevos.** Es el eje medible de
  la HU. Los dos schemas son `.strict()` y los tests barren el JSON serializado de las 4 ramas
  (T-A3, T-A10).
- **CD-11** ⛔ **PROHIBIDO tocar `chaski-v3/src/infrastructure/kyc/agent-env.ts`.** Contiene la única
  aparición en producción del slug viejo y `T-ENV-3` cuenta apariciones **textuales, prosa incluida**.
- **CD-12** ⛔ **PROHIBIDO cambiar el orden de los guards de `authority.ts`.** Guard 3 (credencial
  owner-scoped) va **antes** de cualquier viaje al agente, sea cual sea el transporte (P-7). El
  transporte es la capa más baja y sólo esa se reemplaza.
- **CD-13** ⛔ **Toda cita `archivo:línea` que se escriba se re-deriva DESPUÉS de la última edición
  del archivo citado**, y se ancla al símbolo cuando el repo lo soporta. `wasiai-a2a`
  (`test/cited-lines-guard.test.ts`) y `chaski-v3` (`src/composition/citas-ancladas.test.ts`) tienen
  candado. ⚠️ **`wasiai-remittance-agents` NO tiene ninguno** (verificado): las citas que se escriban
  ahí **no las mira nadie** y hay que re-derivarlas a mano.
  *(Patrón recurrente en 3 de las 3 últimas HUs DONE — §2.3.)*
- **CD-14** ⛔ **Toda frase que afirme un mecanismo tiene que ser falsable con un input concreto, y
  se re-deriva si el cambio la volvió falsa.** Tres frases que **esta HU vuelve falsas** y hay que
  reescribir, no ampliar: (i) el bloque WKH-233 de `agent-slug-residue.static.test.ts:33-63`;
  (ii) la cabecera de `gateway-client.ts:1-14` ("NO resuelve el agente por nombre"); (iii)
  `invoke-auth.ts:43` ("los 3 `invoke`").
  *(Patrón recurrente en 3/3 — §2.3.)*
- **CD-15** ⛔ **La fila por DEFECTO de toda escalera de clasificación es FALLO.** Aplica al mapeo
  del transporte (§5.1) y al `classify()` del smoke (§5.5). Nunca `default: ok`.
  *(`227/auto-blindaje.md:72` — "El DEFAULT de una escalera de monitoreo era PASS".)*
- **CD-16** ⛔ **El presupuesto de diff se MIDE al cerrar cada wave, no se declara al empezar**, y un
  exceso >2x se justifica por escrito o se recorta (regla 10 del repo).
  *(`228/auto-blindaje.md:82` — "Escribí el presupuesto ANTES de medirlo".)*
- **CD-17** ⛔ **Todo archivo nuevo se `git add`ea ANTES de correr el gate.** En estos repos un
  archivo sin indexar da **verde falso**.
  *(`226/auto-blindaje.md:107`.)*
- **CD-18** ⛔ **PROHIBIDO agregar una capacidad PREEXISTENTE a `AUTHORIZATION_CAPABILITIES` en esta
  HU.** Es un cambio de contrato para consumidores externos que no se pueden enumerar desde el repo.
  Residual R-1.
- **CD-19** ⛔ **El transporte `gateway` estrecha el borde campo por campo, con los MISMOS lectores y
  los MISMOS códigos de error que el directo.** Un `as KycAgentDecisionOutput` haría que una clave
  faltante viajara como `undefined` hasta el gate del desembolso
  (`agent-kyc-client.ts:13-18`). Y `identityMatches` se preserva **AUSENTE**, nunca `?? false`.
- **CD-20** ⛔ **El `decisionToken` no puede llegar al navegador.** `gateway-kyc-client.ts` es
  server-only, igual que sus dos hermanos, y **no se importa** desde `src/presentation/**` ni desde
  `container.ts`.

---

## 9. Riesgos

| # | Riesgo | Estado / mitigación |
|---|---|---|
| **R-1** | Las capacidades de KYC **preexistentes** siguen siendo resolubles por ranking. Un tercero que publique `kyc-verification` puede ganar un step de **otro** consumidor. | **Declarado, NO cerrado** (CD-18). Chaski queda protegido (pinea). Cierre = HU de seguimiento, previa medición del tráfico vivo. |
| **R-2** | El `decisionToken` (una credencial) pasa a transitar por el Coordinador dentro de `step.input`. | Verificado que `/compose` **no persiste ni loguea** inputs de step (metadata de `compose_step` = 9 campos, ninguno el input: `src/services/compose.ts:1667-1683`) y que no suspende sin un sobre `a2a_suspend` (`:797-812`). Aun así es superficie nueva: **F4 tiene que verificar que ningún log del Coordinador lo contiene** en la corrida real. |
| **R-3** | **Costo por desembolso.** El momento 3 corre en **cada** pago; a 0.02 USDC/step cada autorización pasa a costar. | Fondear la agent key de Chaski en la red del header (`WASIAI_A2A_PAYMENT_CHAIN`; el saldo es **por red** — `probe-money-path.mjs:54-60`). **Precio relativo sesión vs. decisión: decisión de producto del founder**, ver §10. No bloquea F3; **bloquea el paso 6**. |
| **R-4** | **Latencia**: un salto más en el camino del dinero. | Medir antes/después en W5-5. `/compose` tiene techo de 180 s; `runViaGateway` de Chaski, **10 s** (`gateway-client.ts:335`); el agente, 8 s contra Didit. ⚠️ El techo de 10 s del cliente es **más chico** que el del gateway: un pipeline lento se corta del lado de Chaski. Verificar en la corrida real. |
| **R-5** | **Cobro y fallo**: `/compose` cobra **antes** de invocar. Un agente caído deja plata gastada sin resultado. | Parte de T-C7 (fail-closed) + observación en W5. El refund es best-effort (`settleRefundWithheld`). |
| **R-6** | **Republicar el catálogo es MANUAL** (`registry.ts:35-41`). Cambiar un schema en A sin republicar en B ⇒ **el catálogo miente en silencio**. | W2-OPS es un paso explícito con verificación por `GET /discover/<slug>`, y el smoke de W4 cruza el `inputSchema` publicado contra la respuesta real **en cada corrida** — que es el único mecanismo que detecta el drift después. |
| **R-7** | Las **2 envs nuevas de payTo** en Vercel. Sembradas después del deploy ⇒ `/manifest` da 503. | W1-OPS es **bloqueante y va antes del deploy**. Es la misma clase de error de orden que costó los 8 días. |
| **R-8** | La fila nueva se deshabilita ⇒ el slug puede ser servido por un registry federado de un tercero. | N3 (§5.1) lo caza: fail-closed antes de autorizar. El pago del step ya ocurrió (post-hoc). |
| **R-9** | `registry.test.ts:13` (`toHaveLength(3)`) y `:124` se ponen **rojos a propósito**. | Es el efecto buscado: el candado obliga a mirar la tabla. Se actualiza el número **midiendo**, no de memoria. |

---

## 10. Missing Inputs

- `[NEEDS CLARIFICATION — producto, founder]` **Precio relativo `remit-kyc-session` vs.
  `remit-kyc-decision`.** El default de este SDD es **0.02 USDC las dos** (= `KYC_PRICE_USDC`, lo que
  cobra hoy la fila de KYC). Argumento para que la lectura de decisión cueste **menos**: corre en cada
  desembolso y no gasta cuota del partner en el caso terminal. **No bloquea F3** (el precio vive en
  `registry.ts` y en la fila de OPS, y cambiarlo es una línea). **Sí bloquea el paso 6** (prod).
- `[resuelto en F2]` Mecanismo de AC-6 → §3.1 · Paths → §3.2 · Nombres de capacidad → §3.3 ·
  Una fila o dos → §3.4.

**Uncertainty markers — lo que este SDD NO puede afirmar:**

1. **Quién compone KYC por capacidad hoy, fuera de este ecosistema.** No es observable desde los
   repos. Por eso CD-18 y R-1.
2. **Si `remit-kyc-validator` tiene `computedReputation > 0` hoy.** Es un dato de la BD y **da igual
   para este diseño** — precisamente porque el pin por slug no depende de la reputación. Se dice para
   que nadie "arregle" un problema futuro con un `min_reputation` (que sería (b), ya refutada).
3. **Si el catálogo vivo de `remit-kyc-validator` declara hoy `kyc-hosted-redirect`.** El manifiesto
   de A la declara (`registry.ts:76`), pero la fila del Coordinador es una copia manual y puede estar
   atrasada (R-6). **No afecta el diseño** (las filas nuevas traen capacidades nuevas), pero W2-OPS
   tiene que **leerlo**, no asumirlo.

---

## 11. Presupuesto de escala (regla 10 — el CR lo contrasta)

La pregunta que decide: *¿qué parte de esto seguiría existiendo si lo escribiera alguien que ya
conoce este patrón?*

| Repo | Presupuesto del work-item | **Presupuesto de este SDD** | Razón del ajuste |
|---|---|---|---|
| `wasiai-remittance-agents` | 300–600 | **450–800** | El work-item contaba 2 endpoints + 2 fichas. El diseño agrega **2 `manifest/route.ts`** (copias literales, ~40 líneas c/u) y **2 schemas Zod propios** (DT-7). Sigue siendo **cero lógica de negocio nueva**: si el diff toca `DiditKycProvider`, `runKycSession`, `runKycDecision` o `isStatusPayoutAllowed` más allá de exportar, es scope creep. |
| `wasiai-a2a` | 50–250 código | **150–400 código** + OPS | El work-item estimaba "pin por slug ≈ 1 validación nueva". Es correcto para la validación (~40 líneas), pero se suman `AUTHORIZATION_CAPABILITIES` + `requiresPinnedAgent` (~50 con el docblock que el archivo exige) y **8 tests**, de los cuales T-B3/T-B4/T-B5/T-B6 necesitan armar dobles de discovery y de bridge (~200). ⛔ Si el diff toca `capability-resolver.ts`, `discovery.ts` o el core de `/compose`, es scope creep: el guard vive en el borde. |
| `chaski-v3` | 700–1200 | **800–1400** | Se suma la unión de `GatewayStep` (DT-13, ~30 + tests de no-regresión de los 2 legs vivos) y el smoke pasa a **3 archivos** en vez de 1 (DT-14: script + helpers + test de helpers). El guard de residuo de AC-15 **no cuenta acá** (DT-15, va a la HU de seguimiento). |

⚠️ **CD-16**: estos números se **re-miden** al cerrar cada wave con
`/usr/bin/git diff --stat` (⛔ nunca bajo el hook `rtk`, que trunca cortando hunks) y el resultado se
escribe en `auto-blindaje.md`. Un exceso >2x se justifica **por escrito** o se recorta.

---

## 12. Scope

### IN

**A**: 2 endpoints `invoke` + 2 `manifest` + 2 entradas de registro + 2 schemas Zod + sus tests +
la corrección de prosa de `invoke-auth.ts:43`.
**B**: `AUTHORIZATION_CAPABILITIES` + `requiresPinnedAgent` + `validateAuthorityPinning` + cableado
en `validateComposeBody` + 8 tests + los 2 candados de CD-2 + OPS (2 filas, verificación por
`/discover`).
**C**: `kyc-transport.ts` + `gateway-kyc-client.ts` + unión de `GatewayStep` + rename de 2 exports +
3 imports + `.env.example` + reescritura del bloque WKH-233 del candado + `kyc-gateway-slug-count` +
smoke (3 archivos) + tests.

### OUT

- **Pasos 7 y 8** (borrar el transporte directo, deprecar la fila `/invoke`) → HU de seguimiento
  (DT-15).
- **Cerrar R-1** (capacidades de KYC preexistentes resolubles por ranking) → HU de seguimiento.
- Cambiar el contrato de `/session` o `/decision` existentes; tocar `DiditKycProvider` o la lógica
  de verificación.
- Cambiar la semántica de `/compose` (un POST por step) más allá del guard de AC-6.
- Cambios a otros agentes del catálogo.
- Rotar `KYC_DECISION_TOKEN_SECRET`; cambiar `kyc_session_tokens`.
- `wasiai-facilitator` / el camino de pago on-chain.
- WKH-225 (suspensión de pipeline): confirmado innecesario.
- **Una restricción nueva en `ComposeStepConstraints`** — evaluada y rechazada en §3.1.

---

## 13. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Las 4 preguntas abiertas del work-item están **resueltas por escrito, con evidencia** | ✅ §3.1–§3.4 |
| 2 | AC-6 tiene un **mecanismo** y un **test que puede fallar** (impostor gana el ranking → el sistema rechaza) + su control positivo | ✅ §5.1, T-B3/T-B4/T-C5 |
| 3 | CD-2 tiene un mecanismo **verificable**, y la contradicción de AC-7 está declarada y reformulada | ✅ §5.2 |
| 4 | Todos los exemplars están **verificados con Read/grep** (paths reales + rangos de línea) | ✅ §2.1 |
| 5 | Los gates de los 3 repos están **leídos del `package.json` de cada uno** | ✅ CD-6 |
| 6 | Los 7 controles P-1..P-7 se preservan; ninguno se afloja | ✅ §5.4, CD-12, T-C9/T-C10 |
| 7 | Waves con **archivos exactos por repo**, en el orden de **despliegue** | ✅ §6 |
| 8 | ≥1 test por AC, con **mutante** declarado para cada uno | ✅ §7 (32 tests, 15 ACs) |
| 9 | Presupuesto de escala **por repo, ajustado con razón escrita** | ✅ §11 |
| 10 | Auto-blindaje histórico leído (3 HUs DONE) y los patrones recurrentes convertidos en CD | ✅ §2.3 → CD-13..CD-17 |
| 11 | Los `[NEEDS CLARIFICATION]` que quedan **no bloquean F3** y tienen su gate declarado | ✅ §10 (precio: bloquea el paso 6, no F3) |
| 12 | Riesgos nuevos declarados, sin exagerar ni minimizar | ✅ §9 (R-1..R-9; R-1, R-2, R-8 son nuevos de este SDD) |
| 13 | Ningún archivo de producción fue modificado por el Architect | ✅ |

**Veredicto: el SDD está listo para `SPEC_APPROVED`.**

Lo único que un revisor debería mirar antes de aprobar, porque es donde este SDD **decide** y no sólo
describe:
1. **§3.1** — la derogación de CD-1/WKH-304 acotada a los steps de autorización, y la reescritura
   obligatoria del bloque de excepción del candado de slugs.
2. **§3.3 / CD-18** — que `AUTHORIZATION_CAPABILITIES` arranque con **sólo** las dos capacidades
   nuevas, dejando R-1 abierto y declarado.
3. **§5.2** — que AC-7, como está redactado en el work-item, describe un campo de entrada que no
   existe, y su reformulación.
4. **DT-15** — que AC-15 se especifica ahora y se implementa en la HU de seguimiento.
