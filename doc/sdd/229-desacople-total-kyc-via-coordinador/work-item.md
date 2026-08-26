# Work Item — [WKH-366] Chaski deja de hablarle directo al agente de KYC — todo pasa por el Coordinador

## Resumen

Chaski (`chaski-v3`) invoca hoy al agente `remit-kyc-validator` (`wasiai-remittance-agents`)
**directo**, en 3 call sites, saltándose el Coordinador (`wasiai-a2a`). El agente se consume
gratis, fuera del carril de pago, y el tercer call site corre **en el momento del desembolso**.
Esta HU cierra el desacople: dos endpoints nuevos en el agente que hablan el dialecto de
`/compose`, sus filas en el catálogo, y un transporte nuevo en Chaski detrás de una bandera —
sin romper a nadie y sin que nadie tenga que re-verificarse.

Es una **HU de tres repos**, coordinada, y toca el camino del dinero: metodología **QUALITY**,
sin negociación, revisada por David (mentor de la incubadora Solana LATAM Labs).

## Contexto — plan ya aprobado por el founder

El diseño, la evidencia `archivo:línea` y las decisiones de producto ya están decididas en
`/home/ferdev/.claude/plans/cozy-drifting-bonbon.md` (medido el 2026-08-26). Este work-item
las normaliza en ACs EARS; **no re-decide el diseño**.

### El problema, medido

| # | Call site | Momento |
|---|---|---|
| 1 | `chaski-v3/app/api/kyc/session/route.ts:375` → `createAgentKycSession` | crear la sesión |
| 2 | `chaski-v3/app/api/kyc/decision/route.ts:89` → `readAgentKycDecision` | leer el veredicto (pantalla) |
| 3 | `chaski-v3/src/infrastructure/payout/authority.ts:180` → `readAgentKycDecision` | **autorizar el desembolso** |

Los `fetch` físicos son 2: `agent-kyc-client.ts:190` (POST session) y `:246` (GET decision).
La URL se compone en `agent-env.ts:81` (verificado: `kycAgentUrl()` compone
`${base}${KYC_AGENT_PATH}/${endpoint}`, `KYC_AGENT_PATH = "/api/agents/remit-kyc-validator"`).

**Control que cierra la pregunta**: la ruta que Chaski construye da 401 en el host del agente
(existe) y 404 en el Coordinador (no existe).

### El bloqueante es de FORMA, no de permisos

- `/compose` hace **exactamente un POST a `agent.invokeUrl` literal**
  (`wasiai-a2a/src/services/compose.ts:1997-2001`, verificado). No hay `method` ni `path` por
  step (`wasiai-a2a/src/types/index.ts:984-1024`, verificado: `ComposeStep` tiene `agent?`,
  `capability?`, `constraints?`, `input`, sin ruta ni verbo).
- La fila del catálogo apunta a `…/remit-kyc-validator/invoke` y su `required` incluye
  `legalId` ⇒ el único camino alcanzable hoy manda el documento por la red. CD-10 (regla
  vigente del repo) lo prohíbe.
- **Verificado hoy (2026-08-26): `/session` y `/decision` YA EXISTEN** en
  `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/{session,decision}/route.ts`,
  sin PII, con `guardInvokeAuth` y `no-store` en las 4 ramas. Son los mismos que Chaski invoca
  directo hoy. Reusan `runKycSession` (`kyc-validator.ts:239-287`) y `runKycDecision`
  (`:289+`, contrato de 9/10 claves). El manifiesto (`registry.ts:64-77`) ya documenta el
  flujo hosted-redirect como RECOMENDADO y ya declara las capacidades `kyc-hosted-redirect` /
  `legacy-single-shot-kyc`. **Son inalcanzables por `/compose`** porque uno es POST con otra
  ruta y el otro es GET con query — no porque falte lógica.

⇒ **Falta un adaptador de forma en el agente + su fila en el catálogo**, no una reescritura.
Las credenciales de los dos lados ya funcionan (el mismo host ya recibe invocaciones del
Coordinador hoy vía otro agente).

### Hallazgo adicional del Analyst — el terreno ya está más allanado de lo que el título sugiere

`WKH-233` (HU previa, ya en `main` de `chaski-v3` y de `wasiai-remittance-agents`) ya construyó
el camino hosted-redirect sin PII (`/session` + `/decision`, `guardInvokeAuth`, `no-store`,
`decisionToken` HMAC). Esta HU **no** construye ese camino: envuelve lo que ya existe en dos
endpoints de forma compose-compatible y lo conecta al Coordinador. El presupuesto de escala de
Repo A (abajo) refleja eso: son adaptadores, no lógica nueva.

### Hallazgo que simplifica el cutover

**Nadie tiene que re-verificarse.** `kyc_session_tokens` NO cambia de forma: Chaski sigue
escribiendo `(session_id, decision_token, owner_address)`
(`chaski-v3/app/api/kyc/session/route.ts:452-456`) y Guard 3 sigue leyendo por
`(session_id, owner_address)` (`chaski-v3/src/infrastructure/persistence/supabase-kyc-session-tokens.ts:80-94`).
El `decisionToken` es un HMAC del agente sobre el `sessionId`; enrutar el transporte no lo
toca. **Cambia el transporte, no el dato.**

### La decisión de seguridad que no puede quedar sin AC

`gateway-client.ts` resuelve por **capability**, no por slug (CD-1/WKH-304), y el ranking del
Coordinador es verified→reputación→precio. Si un tercero publica un agente barato con la
capability de KYC, podría ser elegido y devolver `payoutAllowed:true`. Inaceptable en el
camino del dinero. Ver AC-6 / CD-1.

### Constraint adicional

`/compose` puede transformar el output de un step con un LLM (`bridgeType:'LLM'`,
`wasiai-a2a/src/types/index.ts:1463-1466`, verificado: el campo existe en `StepResult`). Un
veredicto de cumplimiento reescrito por un modelo es inaceptable en steps de KYC. Ver AC-7 /
CD-2.

---

## Sizing

- SDD_MODE: **full** (multi-repo, money-path, seguridad)
- Modo: **QUALITY** (fijado, no negociable — CLAUDE.md del repo. No se baja el rigor bajo
  ningún argumento de velocidad)
- Estimación: **L** (tres repos, cambio de transporte en el camino del dinero, mecanismo
  anti-suplantación nuevo, script de verificación contra servicios desplegados)
- Branch sugerido, **uno por repo**:
  - `wasiai-remittance-agents`: `feat/wkh-366-kyc-compose-adapters`
  - `wasiai-a2a`: `feat/wkh-366-kyc-catalog-rows`
  - `chaski-v3`: `feat/wkh-366-kyc-gateway-transport`

### Presupuesto de escala esperado (regla 10 — el CR lo contrasta)

La pregunta que decide: *¿qué parte de esto seguiría existiendo si lo escribiera alguien que
ya conoce esta librería/patrón?*

| Repo | Qué cambia | Presupuesto de diff (código + tests) |
|---|---|---|
| `wasiai-remittance-agents` | 2 endpoints POST nuevos, **adaptadores de forma** sobre `runKycSession`/`runKycDecision` que ya existen; 2 filas de manifiesto nuevas (molde: la fila `remit-kyc-validator` ya existente, `registry.ts:50-114`); tests de guard-auth, no-PII, shape | **300-600 líneas.** Cero lógica de negocio nueva: si el diff toca `DiditKycProvider` o el core de `kyc-validator.ts` más allá de exportar lo que ya está, es una señal de scope creep. |
| `wasiai-a2a` | Ops (rows en `a2a_agents`, no necesariamente código) + 1 línea de `capability-risk.ts` (agregar capability(ies) nueva(s) a `NON_DISBURSEMENT_CAPABILITIES`) + el mecanismo anti-suplantación (AC-6, tamaño depende de la decisión F2: pin por slug es ~1 validación nueva; constraints es más) + verificación con `GET /discover/<slug>` | **50-250 líneas de código** + el trabajo de OPS (rows, no diff de git). Si el diff supera esto sin justificación escrita, revisar si se está tocando algo fuera de scope (p. ej. el core de `/compose`). |
| `chaski-v3` | Cliente hermano de `agent-kyc-client.ts` (mismo shape, transporte distinto) + bandera `KYC_TRANSPORT` + wiring dentro de las 2 funciones existentes (call sites NO cambian de forma) + `scripts/smoke-kyc-via-gateway.mjs` + tests de fail-closed/conmutación/aislamiento | **700-1200 líneas** (incluye el script de smoke, que es deliberadamente grande: deriva input del `inputSchema` publicado, no lo hardcodea). El guard de residuo (paso 7) es una HU/fase posterior — no cuenta en este presupuesto salvo que F2 decida incluirlo en este corte. |

---

## Acceptance Criteria (EARS)

**Repo A — `wasiai-remittance-agents`**

- AC-1: WHEN un caller autenticado con `guardInvokeAuth` invoca el endpoint nuevo de sesión
  (path exacto a confirmar en F2, candidato `POST /api/agents/remit-kyc-session`) con un body
  que NO incluye `legalId`, the system SHALL crear la sesión hosted-redirect reusando
  `runKycSession` (`src/agents/kyc-validator.ts:239-287`) y SHALL devolver `sessionId`, `url`
  y `decisionToken` sin persistir ni reenviar ningún dato de identidad.
- AC-2: IF el body del endpoint nuevo de decisión (path a confirmar en F2, candidato
  `POST /api/agents/remit-kyc-decision`) incluye una clave fuera del schema `.strict()`, THEN
  the system SHALL responder 400 sin invocar al proveedor Didit.
- AC-3: El endpoint `/invoke` de `remit-kyc-validator` SHALL permanecer sin modificar en su
  ruta, su forma y su comportamiento observable durante toda la convivencia (pasos 1-7 del
  orden de ejecución).
- AC-4: WHEN se registran las capacidades de las filas de catálogo nuevas, the system SHALL
  declarar únicamente capacidades ya clasificadas como `'no-disbursement'` en
  `wasiai-a2a/src/lib/capability-risk.ts` (agregando la(s) capacidad(es) nueva(s) al set
  `NON_DISBURSEMENT_CAPABILITIES` si todavía no están), de modo que ningún step de KYC quede
  `'unclassified'`.

**Repo B — `wasiai-a2a`**

- AC-5: WHEN se publican las dos filas nuevas en el catálogo, the system SHALL exponer vía
  `GET /discover/<slug>` un `invokeUrl` que resuelve a los endpoints nuevos del agente (no a
  `/invoke`) y un `inputSchema.required` que NO incluye `legalId`.
- AC-6: IF un step de `/compose` declara una `capability` de KYC sin pinear el agente por
  `slug` (o sin `constraints` que sólo `remit-kyc-validator` pueda satisfacer), THEN the
  system SHALL rechazar el step o resolver exclusivamente al agente propio — nunca a un
  tercero verificado que publique la misma capacidad con mejor ranking o menor precio.
  [Mecanismo exacto: NEEDS CLARIFICATION, ver Missing Inputs — CD-1]
- AC-7: IF un step de KYC (sesión o decisión) declara `bridgeType:'LLM'` para transformar su
  output, THEN the system SHALL rechazarlo antes de invocar el pipeline. [CD-2]

**Repo C — `chaski-v3`**

- AC-8: WHILE `KYC_TRANSPORT` está ausente o vale `'direct'`, the system SHALL invocar el
  agente exactamente como hoy (mismo `fetch`, misma URL, mismo comportamiento observable) y
  SHALL NO emitir ninguna llamada al Coordinador.
- AC-9: WHEN `KYC_TRANSPORT='gateway'`, the system SHALL crear la sesión y leer la decisión a
  través de `runViaGateway` (`src/infrastructure/a2a/gateway-client.ts:296`) contra el
  Coordinador, con `x-a2a-key` en la cabecera, y SHALL NO emitir ningún `fetch` directo al
  host del agente.
- AC-10: WHILE el transporte es `'gateway'` y la respuesta del Coordinador reporta
  `agentFailure`, un 401, o cualquier resultado que no sea un veredicto explícito y positivo,
  the system SHALL tratarlo como no autorizado (fail-closed) y SHALL NO autorizar ningún
  desembolso.
- AC-11: Los tres call sites (`app/api/kyc/session/route.ts:375`,
  `app/api/kyc/decision/route.ts:89`, `src/infrastructure/payout/authority.ts:180`) SHALL
  seguir invocando las mismas dos funciones de alto nivel (`createAgentKycSession`,
  `readAgentKycDecision`) sin cambiar su firma pública; el transporte SHALL resolverse dentro
  de esas funciones, y los Guards 1-7 de `authority.ts` (incluidos P-3/P-7) SHALL permanecer
  intactos.
- AC-12: El aislamiento por owner SHALL preservarse bajo ambos transportes: un
  `(session_id, owner_address)` que no matchea SHALL seguir devolviendo
  `kyc_ownership_mismatch` con `httpStatus:200` (`authority.ts:130-174`,
  `supabase-kyc-session-tokens.ts:80-94`, sin cambios).

**Verificación (transversal)**

- AC-13: WHEN se ejecuta `scripts/smoke-kyc-via-gateway.mjs` contra los servicios desplegados
  (agente en `DIDIT_ENV=mock`, Coordinador en su URL real), the system SHALL derivar el input
  de sesión desde el `inputSchema` publicado por `GET /discover/<slug>` en esa misma corrida
  (nunca hardcodeado) y SHALL reportar uno de al menos 6 exit codes que distingan caída de
  prod, drift de contrato y config de la sonda.
- AC-14: WHEN la bandera pasa a `'gateway'` en preview, the system SHALL requerir una corrida
  real contra Didit hecha por el founder, con un desembolso verificado de punta a punta, ANTES
  de que la bandera pase a `'gateway'` en producción.
- AC-15: WHEN el transporte directo se elimina (paso 7 del orden de ejecución), the system
  SHALL incluir un guard de residuo que falle si aparece un `fetch` directo al host del agente
  en el código de producción de `chaski-v3`, y ese guard SHALL NO leerse a sí mismo (no puede
  buscar un literal en la misma línea donde ese literal aparece).

---

## Scope IN (por repo)

### Repo A — `wasiai-remittance-agents`
- Dos endpoints POST nuevos que hablan el dialecto de `/compose` (aditivo, `/invoke` no se
  toca), envolviendo `runKycSession`/`runKycDecision` (`src/agents/kyc-validator.ts:239-287`,
  `:439-485`) con el mismo `guardInvokeAuth` de `src/auth/invoke-auth.ts`.
- Actualización de `src/manifest/registry.ts` con la(s) ficha(s) nueva(s) (molde: la entrada
  `remit-kyc-validator` existente, `:50-114`).
- Tests: no-PII, shape del dialecto compose, guard de auth, gate completo del repo.

### Repo B — `wasiai-a2a`
- Registrar las 2 filas de catálogo nuevas (`a2a_agents`, acción de OPS).
- Verificar que `A2A_SELF_PUBLISHED_OUTBOUND_AUTH` cubre el host del agente.
- Agregar la(s) capability(ies) nueva(s) a `NON_DISBURSEMENT_CAPABILITIES`
  (`src/lib/capability-risk.ts`) si no están.
- Resolver e implementar el mecanismo anti-suplantación de AC-6 / CD-1.
- Verificar/cerrar AC-7 (bridge LLM prohibido en steps de KYC).
- Verificar con `GET /discover/<slug>` que el catálogo refleja los endpoints nuevos.

### Repo C — `chaski-v3`
- Cliente nuevo (hermano de `agent-kyc-client.ts`) que hable con el Coordinador vía
  `runViaGateway` (`src/infrastructure/a2a/gateway-client.ts:296`).
- Bandera `KYC_TRANSPORT='direct'|'gateway'`, default `'direct'`.
- Wiring dentro de `createAgentKycSession`/`readAgentKycDecision` — los 3 call sites no
  cambian de forma.
- `scripts/smoke-kyc-via-gateway.mjs` (molde: `wasiai-a2a/scripts/probe-money-path.mjs`).
- Tests de fail-closed, de conmutación de bandera (contar llamadas a cada doble, no leer
  status), de aislamiento de ownership.
- Gate completo: `npm run qa` → `npm run build`.

## Scope OUT (por repo, y transversal)

### Repo A
- Cambiar el contrato de `/session` o `/decision` ya existentes (los que Chaski usa hoy
  directo).
- Tocar `DiditKycProvider` o la lógica de verificación en sí.

### Repo B
- Cualquier cambio a la semántica de `/compose` (un POST por step) más allá de lo que AC-6/
  AC-7 requieran.
- Cambios a otros agentes del catálogo.

### Repo C
- Rotar `KYC_DECISION_TOKEN_SECRET` — eso es un CORTE, no un rollback (`agent-env.ts:27-29`,
  CD-21 ya vigente en el repo).
- Cambiar el contrato o el schema de `kyc_session_tokens`.
- Borrar el transporte directo o deprecar la fila `/invoke` — eso son los pasos 7 y 8 del
  orden de ejecución; quedan para una fase posterior de esta misma HU o una HU de seguimiento,
  a decidir en F2.

### Transversal (los 3 repos)
- Tocar `wasiai-facilitator` o el camino de pago on-chain.
- La suspensión de pipeline (WKH-225): está mergeada y encendida en prod, pero no hace falta
  para este desacople — la espera humana ocurre en la UI de Chaski, no dentro del pipeline.

---

## Decisiones técnicas (DT-N)

- DT-1: **Dos filas de catálogo, no una con `op` discriminado** (schemas planos, precios
  independientes, capacidades honestas). Recomendación del plan aprobado; F2 la confirma o la
  refuta por escrito.
- DT-2: El transporte nuevo en Chaski se activa por bandera `KYC_TRANSPORT`, default
  `'direct'`. El rollback real es la bandera (una env, sin redeploy), nunca rotar el secreto
  del `decisionToken`.
- DT-3: `kyc_session_tokens` no cambia de forma. El `decisionToken` es un HMAC del agente
  sobre el `sessionId`; enrutar el transporte no lo toca.
- DT-4: La verificación de cableado end-to-end se hace con un script que pega contra los
  servicios DESPLEGADOS de verdad (molde `probe-money-path.mjs`), no con un test que dobla
  `fetch` — es el modo de falla que dejó 8 días de 502 invisibles.
- DT-5: **El orden de ejecución de los 8 pasos es load-bearing** y no se negocia: agente →
  Coordinador → Chaski (bandera en `direct`) → e2e en mock → bandera `gateway` en preview +
  corrida real de Didit del founder → bandera `gateway` en prod → borrar transporte directo +
  guard de residuo → deprecar `/invoke`.

## Constraint Directives (CD-N)

- CD-1: **PROHIBIDO** que un step de `/compose` con capability de KYC resuelva a un agente
  distinto de `remit-kyc-validator` por ranking (verified→reputación→precio). OBLIGATORIO
  pinear por slug o exigir `constraints` que sólo el agente propio satisfaga, en el camino del
  dinero (`authority.ts:180`).
- CD-2: **PROHIBIDO** el bridge LLM (`bridgeType:'LLM'`) en cualquier step de KYC (sesión o
  decisión). Un veredicto de cumplimiento reescrito por un modelo es inaceptable.
- CD-3: **OBLIGATORIO** mantener `/invoke` vivo y sin modificar en su forma hasta el paso 8
  (deprecación explícita). Convivencia, sin romper a nadie.
- CD-4: **PROHIBIDO** cambiar el contrato del `decisionToken` o su secreto en esta HU.
- CD-5: **PROHIBIDO** tocar `wasiai-facilitator` o el camino de pago on-chain.
- CD-6: **OBLIGATORIO** correr el gate COMPLETO de cada repo, en su orden real y leído del
  `package.json` de ESE repo (no se hereda entre repos): `wasiai-remittance-agents` =
  `npm run typecheck` → `npm test` → `npm run build` (no tiene lint); `wasiai-a2a` =
  `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` (`npm run qa` NO existe
  acá); `chaski-v3` = `npm run qa` → `npm run build`.
- CD-7: **PROHIBIDO** dar por probado el cableado end-to-end con un test que doble `fetch`
  (`vi.stubGlobal`). Se requiere el script de verificación (AC-13) contra servicios
  desplegados.
- CD-8: **OBLIGATORIO** que todo test que afirme un comportamiento se rompa a propósito antes
  de darlo por bueno, con el rojo citado como evidencia (AR/CR/F4).
- CD-9: **PROHIBIDO** que un guard se lea a sí mismo (AC-15): si busca un literal en la misma
  línea donde ese literal aparece, nunca puede fallar.

---

## Los 7 controles del borde (P-1..P-7) — cómo se preservan

Todos viven en las **rutas** de Chaski, aguas arriba del cliente. El desacople reemplaza sólo
el `fetch` del fondo de la pila; ningún control se mueve.

| Control | Dónde vive hoy | Cómo se preserva bajo este cambio |
|---|---|---|
| P-1 rate-limit IP+address antes de gastar cuota | `app/api/kyc/session/route.ts:110` | Intacto: vive en la ruta, aguas arriba de `createAgentKycSession`. El transporte nuevo no la toca (AC-11). |
| P-2 key del limiter no forjable | `:49` | Intacto, mismo motivo que P-1. |
| P-3 PoP S5: el binding es la dirección PROBADA, nunca `body.vendorData` | `:193-238`, asignado en `:222` | Intacto: el binding se resuelve antes de llamar a `createAgentKycSession`; el transporte no participa de esa decisión (AC-11). |
| P-4 sin prueba ⇒ sesión sin atar, pero la persona se verifica igual | `agent-kyc-client.ts:184-185`, `route.ts:321` | Se replica en el input del step nuevo: el transporte `gateway` manda el mismo input que el transporte `direct` (AC-8/AC-9 exigen comportamiento observable idéntico). |
| P-5 `/decision` exige credencial | `app/api/kyc/decision/route.ts:53-56` | Intacto del lado de Chaski; del lado del agente, el endpoint nuevo de decisión exige el mismo `decisionToken` (AC-2, mismo `runKycDecision`). |
| P-6 anti-enumeración: 401 byte-idéntico | `:54-56`, `:64-68` | Intacto: el 401 lo emite Chaski o el agente antes de tocar al partner; el Coordinador no agrega una tercera forma de 401 (a verificar en F4: los 3 caminos siguen dando el mismo body). |
| P-7 ningún `fetch` al borde antes de pasar los guards | `authority.ts:130-131` | Intacto: Guard 3 (la credencial owner-scoped) sigue yendo antes de `readAgentKycDecision`, sea cual sea el transporte (AC-11/AC-12). |

**El argumento central de seguridad**: el cambio es de una sola capa, la más baja del stack
(el `fetch` físico), y ningún control del borde vive ahí.

---

## Riesgos a declarar

1. **Costo por desembolso.** El momento 3 corre en CADA pago; a 0.02 USDC por step, cada
   autorización pasa a costar. Hay que fondear la agent key de Chaski y decidir si la lectura
   de decisión debe costar menos que crear sesión. [Precio relativo: NEEDS CLARIFICATION,
   decisión de producto del founder — ver Missing Inputs]
2. **Latencia.** Un salto más en el camino del dinero. Medir antes y después del cutover.
3. **Cobro y fallo.** `/compose` cobra ANTES de invocar. Un agente que falla puede dejar plata
   gastada sin resultado (`settleRefundWithheld`). Verificar el comportamiento con el agente
   caído (parte de AC-10).
4. **Republicar el catálogo es MANUAL.** La ficha del Coordinador es una copia a mano del
   manifiesto del agente (`wasiai-remittance-agents/src/manifest/registry.ts:35-41`); nada las
   sincroniza. Cada cambio de schema exige una acción de OPS o el catálogo miente en silencio.

---

## Missing Inputs

- `[NEEDS CLARIFICATION]` Path exacto de los 2 endpoints nuevos en Repo A (candidato:
  `POST /api/agents/remit-kyc-session` / `POST /api/agents/remit-kyc-decision`, o bajo el
  namespace `remit-kyc-validator/`). El plan lo deja para F2.
- `[NEEDS CLARIFICATION]` Mecanismo exacto de AC-6/CD-1 (pin por `slug` en `ComposeStep.agent`
  vs. `constraints` sólo-satisfacibles por el agente propio). Explícitamente delegado por el
  plan a Architect + Adversary, debe quedar decidido y testeado antes de activar la bandera
  `gateway`.
- `[NEEDS CLARIFICATION]` Nombre de la capability nueva para el endpoint de decisión
  (`kyc-decision-read` es una sugerencia del plan, no confirmada).
- `[NEEDS CLARIFICATION]` Precio relativo de crear-sesión vs. leer-decisión (Riesgo 1) —
  decisión de producto del founder, no bloqueante para F2 pero sí antes de fondear en prod.
- `[resuelto]` Fecha, alcance de e2e (mock + 1 corrida real de Didit), naturaleza multi-repo,
  y "convivencia sin romper a nadie" — decisiones del founder ya tomadas, incorporadas arriba.

---

## Análisis de paralelismo

- **No bloquea ni es bloqueada por WKH-314/315** (x402 inbound / depósito Solana): repos y
  superficies de código disjuntas.
- **No depende de WKH-225** (suspensión de pipeline): confirmado fuera de alcance, no hace
  falta.
- **Depende de WKH-233** (ya en `main` de ambos repos): el camino hosted-redirect sin PII que
  esta HU envuelve YA EXISTE. No es una dependencia en vuelo, es terreno ya allanado.
- **Orden interno OBLIGATORIO** (DT-5): dentro de esta HU, Repo A tiene que desplegarse y
  verificarse ANTES de que Repo B registre las filas del catálogo, y Repo B tiene que
  verificarse (vía `GET /discover/<slug>`) ANTES de que Repo C active la bandera en
  `'gateway'`. El **código** de Repo C (cliente nuevo + bandera + tests) SÍ puede escribirse
  en paralelo con Repo A/B, siempre que la bandera quede en `'direct'` hasta que los pasos 1-2
  estén verificados en el entorno real (no en mock).
- **Tres worktrees, tres branches**, coordinados por el orquestador; las waves de F3 siguen el
  orden de ejecución de 8 pasos, no el orden de escritura de código.
