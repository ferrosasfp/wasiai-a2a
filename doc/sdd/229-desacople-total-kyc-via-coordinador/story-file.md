# Story File — [WKH-366] Chaski deja de hablarle directo al agente de KYC: todo pasa por el Coordinador

- **HU**: WKH-366 · **SDD**: `doc/sdd/229-desacople-total-kyc-via-coordinador/sdd.md` (SPEC_APPROVED AUTO, 2026-08-26)
- **Modo**: QUALITY, no negociable
- **Repos**: 3 · **Waves en este corte**: W0..W5 (W6 queda para la HU de seguimiento)
- **Fecha de derivación de TODAS las citas de este documento**: 2026-08-26, contra el `main` de cada repo

---

## 0. Cómo se lee este documento

Este es el **único** documento que el Dev necesita. Todo lo que hay acá está verificado contra el
árbol real; las citas `archivo:línea` se re-derivaron una por una el 2026-08-26 (no se copiaron del
SDD: 17 de las del SDD original ya habían quedado corridas una vez).

**Si algo no está acá, no se hace.** Si algo que está acá no coincide con el árbol cuando lo abrís,
**parás y avisás** — no lo "arreglás" en el momento.

### ⛔ Prohibiciones globales de esta HU

| # | Prohibido |
|---|---|
| P-A | Tocar `chaski-v3/src/infrastructure/kyc/agent-env.ts` — **cero diff, ni una coma, ni un comentario** (CD-11) |
| P-B | Tocar `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/{invoke,session,decision}/route.ts` (CD-3 / AC-3) |
| P-C | Tocar `DiditKycProvider` o el core de `kyc-validator.ts` más allá de **agregar dos `export const` de schema** |
| P-D | Cambiar el orden de los guards de `chaski-v3/src/infrastructure/payout/authority.ts` (CD-12 / P-7) |
| P-E | Rotar `KYC_DECISION_TOKEN_SECRET`. **El rollback es la bandera `KYC_TRANSPORT`, siempre.** Rotar el secreto es un CORTE que invalida los tokens de gente ya verificada que todavía no cobró (`chaski-v3/src/infrastructure/kyc/agent-env.ts:27-29`) |
| P-F | Tocar `wasiai-facilitator` o el camino de pago on-chain (CD-5) |
| P-G | Agregar una capacidad **preexistente** a `AUTHORIZATION_CAPABILITIES` (CD-18) |
| P-H | Agregar una clave nueva a `ComposeStepConstraints` / `ALLOWED_STEP_CONSTRAINTS` (evaluado y rechazado, §3.1 del SDD) |
| P-I | Tocar `capability-resolver.ts`, `discovery.ts` o el core de `services/compose.ts` de `wasiai-a2a`. El guard vive **en el borde** |
| P-J | Dar por probado el cableado e2e con un test que doble `fetch` (`vi.stubGlobal`) — CD-7 |

### 🔧 Herramientas (hay hooks que corrompen la salida en este entorno)

- ⛔ **NO uses `cat`** — un hook lo corrompe y borra líneas. Leé con `sed -n 'A,Bp'`.
- ⛔ **NO uses `git diff` pelado** — bajo el hook `rtk` **trunca cortando hunks** (3250 líneas salieron
  532). Usá **`/usr/bin/git diff`** siempre, y **`/usr/bin/git diff --stat`** para medir el presupuesto.
- ⛔ **NO uses `grep` pelado** — respeta el `.gitignore` y da **CERO falso**. Usá `/usr/bin/grep -rn`.
- ⛔ **NO uses `git log` bajo el hook** — borra los commits de merge.

### ⚙️ Serialización obligatoria

Son **3 worktrees en la misma máquina**. **Nunca corras dos suites en paralelo.** Está medido: 6
worktrees concurrentes ponen ROJA la suite de `main` y contaminan todo AC que dependa de tiempos.
Un gate por vez, de punta a punta, y recién después el siguiente.

---

## 1. Contexto compacto — qué se construye y por qué

Hoy Chaski (`chaski-v3`) le habla al agente de KYC (`wasiai-remittance-agents`) por **HTTP directo**,
con 2 `fetch` físicos y **3 call sites**, y el tercero corre **en el momento del desembolso**. Eso
salta el Coordinador (`wasiai-a2a`): el agente trabaja gratis, fuera del carril de pago.

Esta HU **no reescribe la lógica de KYC** (ya existe, WKH-233). Agrega:

1. **Dos endpoints nuevos en el agente** que hablan el dialecto de `/compose` (POST, body, `{result}`).
2. **Dos filas nuevas en el catálogo del Coordinador**, con capacidades propias.
3. **Un transporte nuevo en Chaski** detrás de la bandera `KYC_TRANSPORT` (default `direct`).

El eje de riesgo que esta HU **abre y tiene que cerrar en el mismo corte** es la **suplantación de
agente**: el Coordinador resuelve por capacidad con un ranking `verified → reputación → precio`, y
`verified` **es auto-reportado** por el candidato federado
(`wasiai-a2a/src/services/discovery.ts:577-586`, textual: *"sale del card que AUTO-REPORTA el
registry"*), mientras que todo self-published tiene `verified: false` **hardcodeado**
(`wasiai-a2a/src/services/agent.ts:154`). Un tercero que declare `verified: true` **ordena por encima
del agente propio** y podría devolver `payoutAllowed: true`. Eso se cierra con el pin por `slug` en
**tres niveles** (§3).

---

## 2. Los tres repos: ruta, branch, gate

| Repo | Ruta absoluta del worktree | Branch |
|---|---|---|
| **A** — `wasiai-remittance-agents` | `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents` | `feat/wkh-366-kyc-compose-adapters` |
| **B** — `wasiai-a2a` (ancla) | `/home/ferdev/.openclaw/workspace/wasiai-a2a` | `feat/wkh-366-kyc-catalog-rows` |
| **C** — `chaski-v3` | `/home/ferdev/.openclaw/workspace/chaski-v3` | `feat/wkh-366-kyc-gateway-transport` |

Los tres están hoy en `main` y limpios. Creá la branch en cada uno **antes de tocar nada**.

### Gates — son TRES DISTINTOS y no se heredan (CD-6)

Leídos del `package.json` de cada repo el 2026-08-26:

| Repo | Gate COMPLETO, **en este orden** | Verificado en |
|---|---|---|
| **A** | `npm run typecheck` → `npm test` → `npm run build` | `package.json:10-16` — **NO tiene lint** |
| **B** | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` | `package.json:7-17` — **`npm run qa` NO EXISTE acá** |
| **C** | `npm run qa` → `npm run build` | `package.json:8-19`; `qa` = `lint`→`typecheck`→`typecheck:scripts`→`test` |

⚠️ **Correr las PARTES de un gate no es correr el gate, y el orden importa.** Hubo un `import` sin
usar que sobrevivió **5 revisiones** porque todos corrían `vitest` y `tsc` y nadie llegaba a `lint`
—que en B y en C es el **primer** eslabón—. El gate se corre **entero, en orden, de una sola pasada**,
y su salida se cita.

⚠️ **`npm run lint` de B es `biome check src/`**: **no mira `test/`**. Los tests que escribas en
`src/**` sí se lintean; los de `test/**` no.

### 🔴 CD-17 — `git add` ANTES del gate, siempre

**Un archivo sin `git add` es invisible para 7 familias de guards ⇒ el gate da VERDE FALSO.** Cada
wave que crea archivos tiene el `git add` **dentro** de su criterio de terminado. No es higiene: es
el control.

---

## 3. 🔴 AC-6 / CD-1 — el pin por `slug` en TRES niveles

Esta es la razón de ser de media HU. **No es una validación más.**

### Por qué el pin por slug y no `constraints`

Tres hechos medidos, cada uno suficiente por sí solo:

1. **El vocabulario de `constraints` no puede expresar identidad.** `ALLOWED_STEP_CONSTRAINTS`
   (`wasiai-a2a/src/lib/compose-step-shape.ts:49-56`) admite exactamente tres claves:
   `max_price_usdc`, `min_reputation`, `allow_trial`.
2. **Agregar una clave está PROHIBIDO por escrito en el repo.**
   `wasiai-a2a/src/services/capability-resolver.ts:42-49`, textual:
   > *"⚠️ NO agregar una restricción de CHAIN. Se evaluó y se RECHAZÓ […] `max_price_usdc` y
   > `min_reputation` sí quedan porque son restricciones legítimas del que pide, **no una forma de
   > señalar un agente concreto por la puerta de atrás**."*
3. **`verified` es forjable y es la PRIMERA clave del sort**
   (`wasiai-a2a/src/services/discovery.ts:648-655`), y `registryService.getEnabled()` **no filtra por
   owner** (`wasiai-a2a/src/services/registry.ts:462`), así que cualquier owner autenticado aporta
   candidatos al pool global.

El pin por slug **sí** es no-falsificable: `slug` es la **PK** de `a2a_agents` y una colisión se
rechaza dos veces (`wasiai-a2a/src/services/agent.ts:449` pre-check y `:480` constraint de BD). Y
`discoveryService.getAgent` es **LOCAL-FIRST** (`wasiai-a2a/src/services/discovery.ts:1387`).

### Los tres niveles — ninguno reemplaza a los otros

| Nivel | Repo | Qué garantiza | Qué NO garantiza |
|---|---|---|---|
| **N1 · el emisor pinea** | C | El step lleva `agent: <slug>`, **nunca** `capability` ⇒ el ranking no participa | Nada, si alguien "simplifica" el emisor de vuelta a `capability` |
| **N2 · el Coordinador rechaza la capacidad** | B | Un step con capacidad de autorización se rechaza **400, pre-débito, pre-discovery** | El caso en que nuestra fila se deshabilite y un registry federado sirva el slug |
| **N3 · el consumidor verifica el ejecutor** | C | Que quien contestó es el `slug` esperado **y** `registry === "self-published"`; si no, fail-closed | Que no se haya pagado — el débito ya ocurrió. Protege la **autorización**, no el gasto |

**N3 existe por un residual concreto**: si nuestra fila quedara `enabled: false`, el lookup local
devuelve `null` y `getAgent` cae al fanout federado, donde un tercero **sí** puede servir un card con
ese mismo slug. N3 lo caza; N1 y N2 no.

⚠️ **Lo que N2 NO hace, y va escrito en el docblock del guard**: no mira `step.agent`. Un step pinado
a un slug **ajeno** pasa el guard y corre — es el caso legítimo de "quiero contratar a ese agente".
El guard prohíbe **delegar la elección**, no elegir mal a propósito.

### 🔴 T-B3 y su control positivo T-B4 — sin T-B4, T-B3 es teatro

- **T-B3**: el impostor **gana el ranking** (discovery doblado devuelve `evil-kyc` con
  `verified:true`, `reputation:100`, `priceUsdc:0.000001` como `agents[0]`) y el sistema lo **rechaza
  con 400** antes de gastar un centavo.
- **T-B4** (control positivo del **instrumento**): con el **mismo doble**, `resolveCapability(...)`
  llamado **sin pasar por el guard** devuelve **`evil-kyc`**.

**Si T-B4 no demuestra que el impostor gana de verdad, T-B3 no prueba nada**: estaría midiendo un
doble que no arma el ataque, y su verde vendría de que no hay ataque, no de que el guard funciona.
T-B4 **afirma que el agujero existe**; ese es todo su valor.

---

## 4. 🔴 CD-2 / AC-7 — el bridge LLM se cierra POR ESTRUCTURA

**AC-7, tal como está redactado en el work-item, describe algo que no existe.** `bridgeType` **NO es
un campo de entrada**: no está en `ComposeStep` (`wasiai-a2a/src/types/index.ts:984-1024`, verificado
clave por clave) y sólo aparece como campo de **salida** en `StepResult`
(`wasiai-a2a/src/types/index.ts:1466`). Un caller **no puede declarar** `bridgeType: 'LLM'`.

Lo que sí es cierto, medido:

1. El bridge corre **sólo dentro de `if (i < steps.length - 1)`**
   (`wasiai-a2a/src/services/compose.ts:1580`) ⇒ **un pipeline de UN step nunca entra al bloque**.
2. Cuando corre, muta `lastOutput` (`:1631`), que es la **entrada del step siguiente**.
   `result.output` se asignó **antes**, desde el resultado crudo del agente (`:1536-1537`), y el
   bridge **no lo toca**.
3. Chaski lee `steps[i].output`, o sea el crudo.

⇒ **El veredicto que Chaski lee no puede ser reescrito por un modelo, en ningún pipeline.**

**Reformulación operativa de AC-7 (la que F4 va a verificar):**
> WHEN un step de KYC se ejecuta vía `/compose`, the system SHALL entregar al caller el output
> **crudo del agente**, y el caller SHALL rechazar la respuesta si el step reporta que un bridge
> corrió sobre él.

**Qué lo ENCLAVA** (si no hay candado, la garantía es incidental y se pierde en el próximo refactor):

| Test | Repo | Enclava |
|---|---|---|
| **T-B5** | B | Que `result.output` se asigna **antes** del bridge y el bridge no lo toca |
| **T-B6** | B | Que un pipeline de 1 step **nunca** entra al bloque del bridge |
| **T-C6** | C | Que el transporte de Chaski **rechaza** si el step reporta un bridge |

**Y CD-2 es además una propiedad del emisor**: el transporte de Chaski manda **exactamente un step
por llamada**. Un step único no tiene "siguiente".

---

## 5. Los 7 controles del borde (P-1..P-7) — qué NO se toca

Todos viven en las **rutas** de Chaski, aguas arriba del cliente. Esta HU reemplaza **sólo el `fetch`
del fondo de la pila**; ningún control se mueve. Verificado archivo por archivo el 2026-08-26.

| # | Control | Dónde vive HOY (verificado) | Qué se hace |
|---|---|---|---|
| **P-1** | Rate-limit IP+address antes de gastar cuota | `chaski-v3/app/api/kyc/session/route.ts:110` | **Nada.** Vive en la ruta, aguas arriba de `createAgentKycSession` (`:375`) |
| **P-2** | Key del limiter no forjable (`clientIp` toma el XFF **más a la derecha**, nunca el leftmost spoofeable) | `chaski-v3/app/api/kyc/session/route.ts:49-52` | **Nada** |
| **P-3** | PoP S5: el binding es la dirección **PROBADA**, nunca `body.vendorData` | `chaski-v3/app/api/kyc/session/route.ts:218-222`, asignado en `:222` | **Nada.** Se resuelve antes de llamar al transporte |
| **P-4** | Sin prueba ⇒ sesión sin atar, pero la persona se verifica igual | `chaski-v3/src/infrastructure/kyc/agent-kyc-client.ts:166-172` (la regla) y `:183-185` (el código) | **Se REPLICA, no se reinventa**: el transporte `gateway` **omite la clave** `identityRef` cuando no hay. Nunca `null`, nunca `undefined` explícito |
| **P-5** | `/decision` exige credencial | `chaski-v3/app/api/kyc/decision/route.ts:53-56` | **Nada** del lado de Chaski. Del lado del agente, el endpoint nuevo exige el **mismo** `decisionToken` |
| **P-6** | Anti-enumeración: 401 **byte-idéntico** | `chaski-v3/app/api/kyc/decision/route.ts:54-56`; del lado del agente `.../remit-kyc-validator/decision/route.ts:18-33` | **Se preserva.** El endpoint nuevo de decisión emite el **mismo** `{"error":"unauthorized"}` sin `reason` ni `hint` para los 4 veredictos del token |
| **P-7** | Ningún `fetch` al borde antes de pasar los guards | `chaski-v3/src/infrastructure/payout/authority.ts:130-132` | **Nada.** Guard 3 (`tokenStore.getForOwner`, `:154`) sigue yendo **antes** de `readAgentKycDecision` (`:180`), sea cual sea el transporte. ⚠️ **`getForOwner`, JAMÁS `readForVerifiedSession`** — la segunda **no filtra por dueño** (`authority.ts:31-33`) |

**El argumento central de seguridad**: el cambio es de **una sola capa, la más baja del stack** (el
`fetch` físico), y ningún control del borde vive ahí. **Si tu diff toca cualquiera de las líneas de
la tercera columna, parás.**

---

## 6. 🚨 BLOQUEANTES DE ORDEN — en rojo, y no son negociables

### 🔴 R-7 · DOS envs nuevas en Vercel, sembradas **ANTES** del deploy de W1

`payToEnv` **tiene que ser único** — lo canda `wasiai-remittance-agents/src/manifest/registry.test.ts:155-161`
(`sin slugs, pathSlugs ni payToEnv duplicados`). Reusar `REMIT_KYC_VALIDATOR_PAYTO` **no es opción**:
el test no lo permite y el diseño tampoco.

| Variable | Proyecto | Ámbito | Valor |
|---|---|---|---|
| `REMIT_KYC_SESSION_PAYTO` | Vercel de **`wasiai-remittance-agents`** | Production **y** Preview | el mismo valor que `REMIT_KYC_VALIDATOR_PAYTO` |
| `REMIT_KYC_DECISION_PAYTO` | Vercel de **`wasiai-remittance-agents`** | Production **y** Preview | el mismo valor que `REMIT_KYC_VALIDATOR_PAYTO` |

⛔ **El Dev NO las setea. Son founder-only.** El Dev las **pide y espera**.

**Qué pasa si el orden se invierte**: `resolvePayTo` es fail-closed por entrada
(`wasiai-remittance-agents/src/manifest/paytos.ts:10-31`, paso 3: `value === "" ⇒ {ok:false,
reason:"missing"}`) ⇒ `buildManifest` devuelve `{ok:false}` ⇒ `GET /api/agents/remit-kyc-session/manifest`
da **503**. Falla cerrado, sí, pero es una **caída evitable por orden**. Es exactamente la clase de
error que costó **8 días** en agosto.

### 🔴 W2 no arranca hasta que W1 esté **desplegado y verificado en el entorno real**

Verificación de W1 antes de tocar W2: `GET https://<host>/api/agents/remit-kyc-session/manifest` y
`.../remit-kyc-decision/manifest` **devuelven 200, no 503**.

### 🔴 W3 se puede ESCRIBIR en paralelo con W1/W2, pero su bandera queda en `direct`

El **código** de C se puede escribir en paralelo. Lo que **no** se puede adelantar es el orden de
**deploy y verificación**: `KYC_TRANSPORT` **no pasa a `gateway`** hasta que W1 **y** W2 estén
verificados **contra los servicios desplegados**, no en mock.

### 🔴 W3 tiene que producir CERO cambio de comportamiento observable

Con `KYC_TRANSPORT` ausente o `"direct"`, el `fetch` que sale, su URL y su body son
**byte-idénticos** a los de antes de esta HU. Lo mide **T-C2** con un snapshot del `RequestInit`.

### 🔴 El rollback es la bandera. NUNCA rotar `KYC_DECISION_TOKEN_SECRET`

Rollback = **borrar la env `KYC_TRANSPORT`**. Sin redeploy. Rotar el secreto invalida **todos** los
`decisionToken` en vuelo, incluidos los de personas ya verificadas que no cobraron, y **no hay dónde
re-emitirlos** (`chaski-v3/src/infrastructure/kyc/agent-env.ts:27-29`).

---

## 7. ⚠️ Riesgos que tenés presentes MIENTRAS codeás

| # | Riesgo | Qué hacer |
|---|---|---|
| **R-4** | **El techo de `runViaGateway` es 10 s** (`chaski-v3/src/infrastructure/a2a/gateway-client.ts:335`, `AbortSignal.timeout(10_000)`), **más chico** que los 180 s de `/compose` (`wasiai-a2a/src/routes/compose.ts:1180-1182`, `TIMEOUT_COMPOSE_MS ?? '180000'`). El agente además tiene su propio techo contra Didit. | **Un pipeline lento se corta del lado de Chaski** y sale como `unavailable`. NO lo "arregles" subiendo el número: se **mide** en la corrida real de W5 y se decide ahí |
| **DT-14** | El smoke va como **`.ts`, no `.mjs`** | `chaski-v3/tsconfig.scripts.json:4` incluye `["scripts/**/*.ts"]` ⇒ **un `.mjs` no lo typechequea nadie** y `npm run qa` pasaría verde sobre un script roto |
| **CD-14** | **El candado de slugs de Chaski trae escrita una instrucción que esta HU vuelve FALSA** | `chaski-v3/src/composition/agent-slug-residue.static.test.ts:61-62` dice: *"El día que el gateway sepa expresar una capacidad de dos saltos con redirect humano, este slug tiene que irse a `PROHIBIDAS` como los otros — y ese día hay que borrar este bloque, no ampliarlo."* **Ese día llegó y el slug NO se va.** W3 **obliga** a reescribir el bloque `:32-63` con el motivo nuevo. Ver W3-C4 |
| **CD-17** | Un archivo sin `git add` ⇒ **verde falso** | `git add` en el criterio de terminado de cada wave que crea archivos |
| **R-2** | El `decisionToken` (una **credencial**) pasa a transitar por el Coordinador dentro de `step.input` | Verificado que `/compose` **no persiste ni loguea** los inputs de step (la metadata de `compose_step` son 9 campos, ninguno el input: `wasiai-a2a/src/services/compose.ts:1667-1683`). Aun así **es superficie nueva**: F4 verifica en la corrida real que ningún log del Coordinador lo contiene |
| **R-5** | `/compose` **cobra antes de invocar**. Un agente caído deja plata gastada sin resultado | Es parte de T-C7 (fail-closed) + observación en W5 |
| **R-6** | **Republicar el catálogo es MANUAL** | `wasiai-remittance-agents/src/manifest/registry.ts:36-42`, textual: *"TOCAR ESTE ARCHIVO **NO REPUBLICA** LA FICHA DEL CATALOGO DEL GATEWAY."* Cambiar un schema en A sin republicar en B ⇒ **el catálogo miente en silencio** |
| **R-9** | `registry.test.ts:13-15` y `:140` se ponen **rojos a propósito** | Es el efecto buscado: el candado obliga a mirar la tabla. Se actualiza el número **midiendo**, nunca de memoria |

---

## 8. 🔻 GAPS del SDD encontrados al derivar — leelos ANTES de codear

Encontré **8 divergencias entre el SDD y el árbol real**. No son cambios de diseño: son correcciones
de hecho. Están marcadas para que AR/CR sepan que salieron de F2.5 y no del Dev.

| # | Qué dice el SDD | Qué mide el árbol | Qué hacés |
|---|---|---|---|
| **G-1** | T-B5/T-B6 van en `src/routes/compose.test.ts` | El bridge vive en el **servicio** y `maybeTransform` se dobla en **`src/services/compose.test.ts:86-92`** | Van en **`src/services/compose.test.ts`** |
| **G-2** | T-B3 asserta "el doble de `ssrfFetch` recibe cero llamadas" | `src/routes/compose.capability.test.ts:53-55` moquea **`composeService` entero** ⇒ `ssrfFetch` nunca existe ahí | Asserts equivalentes-o-más-fuertes: `mockCompose`, `discoverMock` y `debitMock` **los tres en cero**. Molde: `:492-511` |
| **G-3** 🔴 | T-C6 lee `steps[0].bridgeType` de la respuesta de `runViaGateway` | **`runViaGateway` NO expone `bridgeType`.** Su `ok` es `{ok:true, outputs, agents}` (`gateway-client.ts:406`) y `readAgentRef` (`:195-217`) no lo lee. **T-C6 es inimplementable sin agregar superficie** | Agregás el mínimo especificado en **W3-C1**. Marcalo en el commit como *"superficie forzada por G-3, no decisión de diseño"* |
| **G-4** 🔴 | T-DIRECT-1: "`kycAgentUrl` / `resolveKycAgentBaseUrl` se importan desde **exactamente un** módulo de producción" | **FALSO HOY, sin ningún cambio.** `resolveKycAgentBaseUrl` se importa desde **4**: `agent-kyc-client.ts:20`, `authority.ts:70`, `app/api/kyc/session/route.ts:37`, `app/api/kyc/decision/route.ts:28`. `kycAgentUrl` sí es **1** | El test pinea **`kycAgentUrl` = 1** y **`resolveKycAgentBaseUrl` = la lista literal de 4 módulos**. Ver W3-C5 |
| **G-5** 🔴 | (no lo dice) | Los **tres** preflights `resolveKycAgentBaseUrl()` (`session/route.ts:73`, `decision/route.ts:39`, `authority.ts:97`) viven **fuera** del transporte y son el interruptor de rollback D-1 | ⇒ **`KYC_AGENT_BASE_URL` sigue siendo OBLIGATORIA bajo `KYC_TRANSPORT=gateway`.** Sin ella: 501 en las dos rutas y 503 en prod desde `authority`. Va documentado en `.env.example` (W3-C6) |
| **G-6** | Los tests nuevos se llaman T-SLUG-1/T-SLUG-2 | **Ya existe un `T-SLUG-1`** en `agent-slug-residue.static.test.ts:166` | Los nuevos se llaman **T-KGS-1 / T-KGS-2 / T-KGS-3** |
| **G-7** 🔴 | (no lo dice) | `chaski-v3/src/composition/readme-test-count.test.ts:87-90` canda el conteo de archivos de test declarado en **los DOS README**. Hoy: `README.md:417` `**154 test files**` y `README.es.md:441` `**154 archivos de test**` | W3 y W4 **agregan archivos de test** ⇒ **hay que actualizar los dos README, midiendo**. Está en el criterio de terminado de W3 y W4 |
| **G-8** | T-A7: "no-store + Vary en las 4 ramas (200/400/**401**/502)" | Para `/session` las 4 ramas son **200 / 400-invalid / 400-callback / 502**. El **401 lo emite `guardInvokeAuth` SIN `no-store`, y es DELIBERADO** (`.../decision/route.ts:93-97`). Tocarlo rompería el 401 byte-idéntico de los 3 `/invoke` (viola CD-3) | T-A7 cubre **las ramas que emite el propio handler**. `guardInvokeAuth` **no se toca** |

---

# WAVES

---

## W0 — Contratos y clasificación (SERIAL, sin deploy, cross-repo)

Nada se despliega. Los dos repos compilan y sus gates pasan.

### W0-A1 · Repo A — los dos schemas Zod del dialecto compose

**Repo**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents` · **Branch**: `feat/wkh-366-kyc-compose-adapters`
**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/src/agents/kyc-validator.ts` **[MOD — sólo agregar]**

**Exemplar a copiar**: `src/agents/kyc-validator.ts:132-137` (`KycSessionInputSchema`), verificado.
Zod instalado: **3.25.76** (`node_modules/zod/package.json`) — `.strict()`, `.trim()`, `.min()`,
`.max()`, `.flatten()` son todos API pública de Zod 3.

**El contrato, textual:**

```ts
/**
 * Input del dialecto compose de `POST /remit-kyc-session/invoke`.
 *
 * ⛔ SIN `callbackUrl`, y no es un olvido. La allowlist de orígenes NACE VACÍA y fail-closed
 * (`isCallbackOriginAllowed`, `:165-167`), así que publicar `callbackUrl` en el `inputSchema` del
 * catálogo invitaría a un 400 GARANTIZADO a cualquiera que arme la llamada leyendo la ficha — que es
 * textualmente el bug que `src/manifest/input-schema-drift.test.ts:6-13` existe para no repetir.
 * Y el consumidor real (chaski-v3) no lo manda.
 *
 * El core `runKycSession` NO se toca: recibe `parsed.data` y su propio `.parse()` lo acepta, porque
 * `callbackUrl` es opcional en `KycSessionInputSchema`.
 */
export const KycComposeSessionInputSchema = z
  .object({
    identityRef: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type KycComposeSessionInput = z.infer<typeof KycComposeSessionInputSchema>;

/**
 * Input del dialecto compose de `POST /remit-kyc-decision/invoke`.
 *
 * 🔴 LOS TRES DATOS VIAJAN EN EL BODY, NINGUNO EN EL QUERY. Es OBLIGADO —el Coordinador no propaga
 * headers hacia el agente (`wasiai-a2a/src/services/compose.ts:1880-1883`: sólo emite los suyos)—
 * y además es el fix (a) que el propio repo recomienda para la deuda de
 * `src/app/api/agents/remit-kyc-validator/decision/route.ts:54`. Acá el contrato es NUEVO y ADITIVO,
 * así que el costo que allá lo bloqueaba (romper el contrato publicado) no se paga.
 */
export const KycComposeDecisionInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    identityClaim: z.string().trim().min(1).optional(),
    decisionToken: z.string().trim().min(1),
  })
  .strict();

export type KycComposeDecisionInput = z.infer<typeof KycComposeDecisionInputSchema>;
```

⛔ **Cero cambio de comportamiento** en `runKycSession` (`:239-287`), `runKycDecision` (`:439-485`),
`isStatusPayoutAllowed` (`:405`) ni `KycSessionInputSchema` (`:132-137`). Sólo se **agrega**.

⚠️ **Por qué no se usa `.max()` en el schema publicado**: el derivador de deriva sólo espeja las
facetas `["type","enum","const","minLength","exclusiveMinimum"]`
(`src/manifest/input-schema-drift.test.ts:122`). `maxLength` no es una de ellas ⇒ **no se publica**.
El `.max(128)` del Zod es real y correcto; simplemente no viaja a la ficha.

---

### W0-A2 · Repo A — las dos entradas de manifiesto

**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/src/manifest/registry.ts` **[MOD]**

**Exemplar verificado**: la entrada `remit-kyc-validator` completa, `:50-119`. El array
`MANIFEST_ENTRIES` abre en `:49` y cierra en `:266` (`]);`). Las entradas nuevas van **antes del
`]);` de `:266`**. El tipo es `ManifestEntry` (`src/manifest/types.ts:64-76`, 11 campos, todos
`readonly` y todos obligatorios).

**Las dos entradas, textuales:**

```ts
  Object.freeze({
    pathSlug: "remit-kyc-session",
    slug: "remit-kyc-session",
    name: "remit-kyc-session",
    // Qué hace este paso y QUÉ NO RECIBE. ⛔ No duplica la marca de deprecación de `/invoke`: ésa
    // vive en la ficha de `remit-kyc-validator` y sus DOS MITADES están pinneadas por
    // `registry.test.ts:89-112` (T-23 / DT-3). Acá no se toca ni se copia.
    description:
      "Crea la sesion hosted-redirect de verificacion de identidad y devuelve la pantalla del proveedor mas el token con el que despues se lee el veredicto. NO recibe legalId ni ningun dato de identidad: el documento lo escanea la persona en la pantalla que hospeda el proveedor.",
    capabilities: Object.freeze(["kyc-session-create"]),
    inputSchema: Object.freeze({
      type: "object",
      required: Object.freeze([]),
      properties: Object.freeze({
        identityRef: Object.freeze({
          type: "string",
          minLength: 1,
          description:
            "Referencia opcional para atar la sesion a quien la pidio. Ausente ⇒ la sesion queda SIN ATAR y la persona se verifica igual.",
        }),
      }),
    }),
    chain: "solana-devnet",
    family: "solana",
    asset: "USDC",
    payToEnv: "REMIT_KYC_SESSION_PAYTO",
    priceUsdc: KYC_PRICE_USDC,
  }),
  Object.freeze({
    pathSlug: "remit-kyc-decision",
    slug: "remit-kyc-decision",
    name: "remit-kyc-decision",
    description:
      "Lee el veredicto de una sesion hosted-redirect ya creada. Exige el decisionToken emitido al crear la sesion. NO recibe legalId ni ningun dato de identidad, y no devuelve ninguno: lo unico que sale sobre identidad es el booleano identityMatches, y se omite cuando no hubo reclamo que comparar.",
    capabilities: Object.freeze(["kyc-decision-read"]),
    inputSchema: Object.freeze({
      type: "object",
      required: Object.freeze(["sessionId", "decisionToken"]),
      properties: Object.freeze({
        sessionId: Object.freeze({ type: "string", minLength: 1 }),
        identityClaim: Object.freeze({
          type: "string",
          minLength: 1,
          description:
            "Direccion PROBADA de quien reclama la sesion. Ausente ⇒ el agente omite identityMatches: no se pregunto.",
        }),
        decisionToken: Object.freeze({
          type: "string",
          minLength: 1,
          description: "HMAC emitido por remit-kyc-session sobre el sessionId. Credencial: no se loguea.",
        }),
      }),
    }),
    chain: "solana-devnet",
    family: "solana",
    asset: "USDC",
    payToEnv: "REMIT_KYC_DECISION_PAYTO",
    priceUsdc: KYC_PRICE_USDC,
  }),
```

⚠️ `KYC_PRICE_USDC` ya está importado en `:44` (`import { PRICE_USDC as KYC_PRICE_USDC } from "@/agents/kyc-validator";`). **No agregues un import nuevo ni redeclares el número.**

⚠️ `priceUsdc` de las dos = `KYC_PRICE_USDC` (0.02). El **precio relativo sesión vs. decisión** es un
`[NEEDS CLARIFICATION]` de producto del founder que **NO bloquea F3** — bloquea el paso 6 (prod).

---

### W0-A3 · Repo A — los candados que se ponen rojos a propósito

**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/src/manifest/registry.test.ts` **[MOD]**

| Línea | Hoy | Queda |
|---|---|---|
| `:13` | `it("declara exactamente 3 agentes", …)` | `it("declara exactamente 5 agentes", …)` |
| `:14` | `expect(MANIFEST_ENTRIES).toHaveLength(3);` | `toHaveLength(5)` — **medido con `MANIFEST_ENTRIES.length`, no de memoria** |
| `:140` | `it("ningún agente cobra en una chain EVM: **los 3** declaran solana-devnet / family solana", …)` | `los 5` — **CD-14**: es prosa que la HU vuelve falsa |

⛔ **NO se toca**: `:89-112` (T-23 / DT-3, la marca de deprecación del KYC viejo, **las dos mitades**),
`:107-124` (`toHaveLength(6)` sobre `findEntry("remit-kyc-validator")?.capabilities` — es sobre esa
entrada, no sobre el array), `:155-161` (duplicados — **sigue valiendo y es lo que fuerza R-7**).

⚠️ El test de `:107-124` que asserta que "ningún otro agente se cuelga de estas marcas" itera sobre
`["remit-corridor-fx","remit-cashout-payout"]` **literales** ⇒ las entradas nuevas no lo mueven.
Verificado.

---

### W0-A4 · Repo A — el check de deriva

**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/src/manifest/input-schema-drift.test.ts` **[MOD]**

Este es **el candado que decide DT-1** (dos filas y no una con `op` discriminado): `VALIDATORS`
mapea **un `pathSlug` a UN `z.ZodObject`** (`:28-32`) y el derivador **LANZA ante un tipo Zod que no
conoce** (`:101-102`, textual: *"Fail-loud: agregar un tipo Zod nuevo obliga a enseñárselo al
derivador, no lo deja sin cubrir"*). Un `z.discriminatedUnion` **no es un `ZodObject`** ⇒ una sola
fila obligaría a aflojar el único mecanismo que impide que el catálogo mienta sobre el input.

| Línea | Cambio |
|---|---|
| `:22-24` (imports) | agregar `KycComposeSessionInputSchema, KycComposeDecisionInputSchema` al import de `@/agents/kyc-validator` |
| `:28-32` `VALIDATORS` | `+ "remit-kyc-session": KycComposeSessionInputSchema,` `+ "remit-kyc-decision": KycComposeDecisionInputSchema,` |
| `:39-45` `GATE_REQUIRED` | `+ "remit-kyc-session": [],` `+ "remit-kyc-decision": [],` |
| `:198` | el nombre del `it` dice *"cubre a **los 3** agentes del registro"* → **5** (CD-14) |

⚠️ **`GATE_REQUIRED` vacío para las dos es una afirmación fuerte**: dice que la ficha no declara
`required` que Zod no exija. Verificalo corriendo el test, no razonando: la comprobación es
`compareObject` (3), `:176-180`.

---

### W0-B1 · Repo B — la clasificación de capacidades

**Repo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a` · **Branch**: `feat/wkh-366-kyc-catalog-rows`
**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/lib/capability-risk.ts` **[MOD]**

**Este archivo declara ser LA ÚNICA COPIA de la clasificación** (`:1-22`, textual: *"⚠️ ESTE ARCHIVO
ES LA ÚNICA COPIA. […] Una segunda lista en otro módulo es el bug garantizado"*) y es un **módulo
LEAF (cero imports de runtime)**. **Se preserva leaf**: `compose-step-shape.ts` —también leaf— va a
importarlo.

**Cambio 1** — `NON_DISBURSEMENT_CAPABILITIES` (`:102-114`) gana **dos entradas al final**, con su
razón escrita en el docblock que ya existe (`:67-101`; el molde son las entradas de
`kyc-hosted-redirect` / `legacy-single-shot-kyc`, `:84-97`):

```ts
  'kyc-session-create',
  'kyc-decision-read',
```

Razón a escribir en el docblock: son del **mismo** validador de KYC, que ya está declarado ahí
arriba como *"autoriza o rechaza; no paga"*. Sin estas dos entradas, `classifyCapability` cae a
`'unclassified'` y el agente recibiría el **cupo estrecho** — o sea que publicar el camino más seguro
lo penalizaría. Ese es exactamente el argumento que el archivo ya hace en `:92-97`. **AC-4 queda
satisfecha por construcción.**

**Cambio 2** — el set nuevo y su predicado, **después** de `NON_DISBURSEMENT_CAPABILITIES` y
**antes** de `normalize` (`:122-124`):

```ts
/**
 * Capacidades cuyo OUTPUT ES UN VEREDICTO DE AUTORIZACIÓN DE DINERO. Un step que las declara NO
 * puede resolverse por ranking: quién contesta cambia qué se autoriza.
 *
 * 🔴 CONTIENE EXACTAMENTE LAS DOS CAPACIDADES NUEVAS, Y NINGUNA PREEXISTENTE. Es una decisión de
 * alcance deliberada, no una lista a medio hacer:
 *
 *  · Meter `kyc-verification`, `kyc-check`, `kyc-hosted-redirect` o cualquier otra ROMPERÍA CON 400
 *    a cualquier consumidor externo que hoy componga un step de KYC por capacidad. Desde este repo
 *    NO se puede medir quién hace eso (`/orchestrate` no emite steps por capacidad, y chaski-v3 sólo
 *    usa `remittance-fx-quote` / `remittance-payout`), y "no lo veo desde acá" NO es "no existe".
 *  · Las dos de acá tienen, por construcción, CERO consumidores el día que se publican. El guard es
 *    fail-closed sobre superficie NUEVA y cero regresión sobre la vieja.
 *
 * ⛔ AGREGAR UNA CAPACIDAD PREEXISTENTE A ESTE SET ES UN CAMBIO DE CONTRATO PARA TERCEROS, no una
 * línea más en un `Set`. Cerrarlo requiere medir el tráfico vivo primero (residual R-1 de WKH-366).
 */
export const AUTHORIZATION_CAPABILITIES: ReadonlySet<string> = new Set([
  'kyc-session-create',
  'kyc-decision-read',
]);

/**
 * ¿Esta capacidad exige que el caller nombre al agente en vez de delegar la elección al ranking?
 *
 * Normaliza con el MISMO `normalize` que `classifyCapability` (`:122-124`): sin eso, mandar
 * `KYC-Decision-Read` esquivaría el guard con un cambio de mayúsculas — un bypass de una línea.
 */
export function requiresPinnedAgent(capability: string): boolean {
  return AUTHORIZATION_CAPABILITIES.has(normalize(capability));
}
```

⚠️ `normalize` está declarado en `:122-124` como `function` (hoisted) ⇒ podés usarlo desde arriba.
Si preferís, poné `requiresPinnedAgent` **después** de `classifyCapability` (`:127-132`). Lo que
**no** podés es escribir un segundo `toLowerCase()` a mano.

---

### W0-B2 · Repo B — T-B1 y T-B2

**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/lib/capability-risk.test.ts` **[MOD]**

⚠️ **Leé primero su docblock, `:1-15`**: *"NINGÚN test de este archivo itera `DISBURSEMENT_CAPABILITIES`
para después preguntarle a `classifyCapability` si sus elementos son de desembolso: eso comprueba que
un `Set` se contiene a sí mismo"*. **T-B2 tiene que respetar eso.**

| id | AC | Qué afirma | 🧬 Mutante que lo debe matar |
|---|---|---|---|
| **T-B1** | AC-4 | `classifyCapability('kyc-session-create') === 'no-disbursement'` y `classifyCapability('kyc-decision-read') === 'no-disbursement'`. Ninguna da `'unclassified'`. Y `requiresPinnedAgent` normaliza: `'KYC-Decision-Read'` y `'  kyc-decision-read '` dan `true` | sacar una del set `NON_DISBURSEMENT_CAPABILITIES` ⇒ `'unclassified'` |
| **T-B2** | AC-4 / CD-18 | `AUTHORIZATION_CAPABILITIES` **no contiene ninguna capacidad preexistente**. La lista de preexistentes se escribe **LITERAL en el test** (las 11 de `NON_DISBURSEMENT_CAPABILITIES` de antes de esta HU + las 4 de `DISBURSEMENT_CAPABILITIES`), **no** se deriva del set que se está midiendo | agregar `'kyc-verification'` a `AUTHORIZATION_CAPABILITIES` ⇒ rojo |

**Las 15 preexistentes, para copiar literal en T-B2** (verificadas en `capability-risk.ts:60-65` y
`:102-114`, estado previo a esta HU):

```
DISBURSEMENT (4):     remittance-payout · cashout · value-delivery · fiat-disbursement
NON_DISBURSEMENT (11): remittance-fx-quote · usdc-to-pen · corridor-pricing · kyc-verification ·
                       aml-screening · travel-rule · remittance-compliance ·
                       remit.corridor-discovery · kyc-check · kyc-hosted-redirect ·
                       legacy-single-shot-kyc
```

### ✅ Criterio de terminado de W0 (ejecutable)

```
# A
cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents
/usr/bin/git add -A
npm run typecheck && npm test && npm run build

# B  (SERIALIZADO: recién cuando A terminó)
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
/usr/bin/git add -A
npx tsc -p tsconfig.json --noEmit && npm run lint && npm test
```

Los dos gates **enteros y en orden**, en verde. **Nada desplegado.**

---

## W1 — Repo A: los dos endpoints (los 2 son paralelizables entre sí)

**Repo**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents` · **Branch**: `feat/wkh-366-kyc-compose-adapters`

### 🚨 W1-OPS — BLOQUEANTE, VA ANTES DEL DEPLOY

Ver **§6 R-7**. Las dos envs `REMIT_KYC_SESSION_PAYTO` y `REMIT_KYC_DECISION_PAYTO` en el Vercel de
`wasiai-remittance-agents`, Production **y** Preview. **El Dev las pide y espera. No las setea.**

### W1-A1 · `POST /api/agents/remit-kyc-session/invoke`

**Archivo NUEVO**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/src/app/api/agents/remit-kyc-session/invoke/route.ts`

**Exemplar a copiar, línea por línea**:
`/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/session/route.ts`
(128 líneas). Anclas verificadas: `:59` `export const dynamic`, `:62-65` `const NO_STORE`, `:68`
`export async function POST`, `:70-71` `guardInvokeAuth` **primera línea del handler**, `:73` el
`safeParse`, `:74-82` el 400 con `flatten()`, `:84` el `try`, `:86-99` el `switch` exhaustivo (`:95`
`case "ok"`), `:101-127` el `catch` con `errorCode` extraído por regex.

**El contrato de cable, textual:**

```
POST /api/agents/remit-kyc-session/invoke
Authorization: Bearer <INVOKE_AUTH_SECRET>          ← guardInvokeAuth(req, "remit-kyc-session")
Content-Type: application/json
body: { identityRef?: string }                       ← KycComposeSessionInputSchema, .strict()

200 → { "result": { sessionId, url, decisionToken, provenance } }     ← EXACTAMENTE 4 claves
400 → { "error":"invalid_input", "details": <parsed.error.flatten()> }
400 → { "error":"invalid_input", "details":{ "formErrors":["callback_origin_not_allowed"], "fieldErrors":{} } }
401 → el 401 de guardInvokeAuth, SIN TOCAR
502 → { "error":"verification_unavailable" }

Cache-Control: no-store  +  Vary: authorization      ← en las 4 ramas QUE EMITE ESTE HANDLER
                                                        (200 / 400-invalid / 400-callback / 502)
```

**Las cinco cosas que hay que hacer bien:**

1. **`{ result }` y no el objeto pelado.** Es el envoltorio de `/invoke`
   (`.../remit-kyc-validator/invoke/route.ts:28`) y el único que deja lugar para el sobre del fee:
   `readCoordinatorFee(data)` se ejecuta sobre el `data` **crudo**
   (`wasiai-a2a/src/services/compose.ts:2024`) **antes** del colapso `data.result ?? data` (`:2025`).
   Los dos envoltorios "funcionan"; sólo uno no borra el sobre.
2. **`guardInvokeAuth(req, "remit-kyc-session")` es la PRIMERA línea del handler**, antes de leer el
   body. Molde: `:70-71`. Lo mide **T-A5**.
3. **La rama `callback_not_allowed` se mapea igual, aunque hoy sea inalcanzable.** `KycSessionOutcome`
   (`src/agents/kyc-validator.ts:198-200`) es una **unión cerrada de 2** y el `switch` es exhaustivo:
   **omitir la rama NO COMPILA**. Escribí en el docblock que es inalcanzable con este schema y por qué.
4. **El `catch` extrae `errorCode` con el regex `/^[a-z][a-z0-9_]{2,47}/`** y loguea sólo
   `{errorName, errorCode?}`. Molde literal: `:107-127`. **Nunca un 500.**
5. **`NO_STORE` en las 4 ramas del handler.** El `Vary` va por la **constante exportada**
   (`INVOKE_AUTH_HEADER`, `src/auth/invoke-auth.ts:63`), nunca por un literal.

⛔ **G-8**: el 401 lo emite `guardInvokeAuth` y **no lleva `no-store`. Eso es deliberado y no se
toca** (`.../remit-kyc-validator/decision/route.ts:93-97`): ese módulo lo comparten los `/invoke`,
cuyo comportamiento el AR verificó **byte-idéntico**.

### W1-A2 · `GET /api/agents/remit-kyc-session/manifest`

**Archivo NUEVO**: `.../src/app/api/agents/remit-kyc-session/manifest/route.ts`

**Copia LITERAL** de `.../remit-kyc-validator/manifest/route.ts` (40 líneas), cambiando **una sola
línea**: `:12` `const PATH_SLUG = "remit-kyc-session";`. Nada más.

### W1-A3 · `POST /api/agents/remit-kyc-decision/invoke`

**Archivo NUEVO**: `.../src/app/api/agents/remit-kyc-decision/invoke/route.ts`

**Exemplar**: `.../remit-kyc-validator/decision/route.ts` (149 líneas), **convertido de GET a POST** y
de query-string a body. Anclas verificadas: `:18-33` el bloque *"EL 401 SALE BYTE-IDÉNTICO PARA LOS
CUATRO VEREDICTOS DEL TOKEN"*, `:64-67` imports, `:98` `dynamic`, `:106-109` `NO_STORE` (su `Vary`
lleva **las dos** cabeceras), `:111-113` handler + guard, `:115` el `try`, `:123-136` el `switch`
exhaustivo (`:128` `case "unauthorized"`), `:138-148` el `catch`.

**El contrato de cable, textual:**

```
POST /api/agents/remit-kyc-decision/invoke
Authorization: Bearer <INVOKE_AUTH_SECRET>          ← guardInvokeAuth(req, "remit-kyc-decision")
Content-Type: application/json
body: { sessionId: string, identityClaim?: string, decisionToken: string }
                                                     ← KycComposeDecisionInputSchema, .strict()

200 → { "result": { terminal, status, lifecycle, approved, riskLevel, verificationId,
                    provenance, payoutAllowed, reasons[], identityMatches? } }
400 → { "error":"invalid_input", "details": <flatten()> }        ← Zod
400 → { "error":"missing_session" }                              ← rama `invalid_request` del core
401 → { "error":"unauthorized" }                                 ← BYTE-IDÉNTICO (P-6)
502 → { "error":"verification_unavailable" }

Cache-Control: no-store  +  Vary: authorization      ← en las 4 ramas del handler (200/400/401/502)
```

**Las cinco cosas que hay que hacer bien:**

1. **El `decisionToken` viaja en el BODY.** Es **obligado**: el Coordinador **no propaga headers**
   hacia el agente (`wasiai-a2a/src/services/compose.ts:1880-1883`: `x-a2a-key` sólo si
   `registry.ownerRef === SYSTEM_OWNER_REF`; ningún otro header viaja). Y es **el fix (a) que el
   propio repo recomienda** (`.../remit-kyc-validator/decision/route.ts:54`), cuyo costo —romper el
   contrato publicado— acá **no se paga** porque el contrato es nuevo y aditivo.
2. **Se le pasa a `runKycDecision` sin renombrar su parámetro.** La firma real es
   `runKycDecision({ sessionId: string|null, identityClaim: string|null, decisionTokenHeader: string|null })`
   (`src/agents/kyc-validator.ts:439-443`). Llamás con
   `decisionTokenHeader: parsed.data.decisionToken`. **Renombrar el parámetro tocaría el core y la
   ruta vieja (CD-3/P-B).** Dejalo declarado en el docblock: *el nombre dice de dónde venía, no de
   dónde tiene que venir*.
3. **`identityClaim` ausente ⇒ se pasa `null`, no `undefined`.** El core lo espera `string | null`
   (`:441`) y hace `args.identityClaim?.trim() ?? ""` (`:456`). Con la clave ausente en el body,
   `parsed.data.identityClaim` es `undefined` ⇒ pasá `?? null`.
   ⚠️ Esto es del lado del **core**, no del cable: en el **cable** (el body que Chaski manda) la
   clave se **omite**. Son dos cosas distintas y las dos importan.
4. **El 401 es byte-idéntico para los 4 veredictos del token.** El core colapsa los cuatro a propósito
   (`:453-455`, `verifyDecisionToken(...) !== "valid"` ⇒ `{kind:"unauthorized"}`). El body es
   exactamente `{"error":"unauthorized"}`: **sin `reason`, sin `hint`, sin `WWW-Authenticate` propio**.
   Es P-6 y es anti-enumeración.
5. **Nada se colapsa a 200.** Bajo `/compose`, el 400 se clasifica `INPUT_REJECTED` y **todo lo demás**
   `AGENT_ERROR` (`wasiai-a2a/src/lib/agent-http-error.ts:90-91`). Si el endpoint devolviera 200 con
   un `{error}` adentro, Chaski intentaría estrechar el output, tiraría
   `kyc_agent_bad_response:decision:terminal` y **el diagnóstico apuntaría al lugar equivocado**.

### W1-A4 · `GET /api/agents/remit-kyc-decision/manifest`

**Archivo NUEVO**: `.../src/app/api/agents/remit-kyc-decision/manifest/route.ts` — copia literal,
`PATH_SLUG = "remit-kyc-decision"`.

### W1-A5 · La prosa que esta HU vuelve falsa (CD-14)

**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/src/auth/invoke-auth.ts` **[MOD — 1 línea]**

`:43` dice hoy: *"Este guard se llama SÓLO desde los **3** `invoke`."* Pasan a ser **5**.
Actualizá el número. Es una línea, y es CD-14.

### W1-A6 · Tests de W1

| id | AC | Archivo | Qué afirma | 🧬 Mutante |
|---|---|---|---|---|
| **T-A1** | AC-1 | `.../remit-kyc-session/invoke/route.test.ts` | `{identityRef:"..."}` ⇒ **200**, `body.result` tiene **exactamente 4 claves** (`Object.keys(result).sort()`), y `runKycSession` recibió el input | agregar una 5ª clave al output ⇒ rojo |
| **T-A2** | AC-1 / P-4 | ídem | Body `{}` ⇒ 200 igual, y la clave `identityRef` **NO llega al core** (assert sobre el argumento que recibió el doble de `runKycSession`) | `identityRef: input.identityRef ?? null` ⇒ rojo |
| **T-A3** 🔴 | **AC-2 / CD-10** | `.../remit-kyc-session/invoke/route.test.ts` | Body con `legalId` (clave fuera del `.strict()`) ⇒ **400**, el doble de `fetch` recibe **CERO** llamadas (contador), y el body del 400 **NO contiene el VALOR** del `legalId` | `.strict()` → `.passthrough()` ⇒ 200 + el DNI viaja |
| **T-A4** | AC-2 | `.../remit-kyc-decision/invoke/route.test.ts` | Ídem con una clave desconocida en el endpoint de decisión | ídem |
| **T-A5** | AC-1/2 | ambos | Sin `Authorization` ⇒ **401 en los dos**, **antes de parsear el body** (contador: `req.json` **no se llamó**) | mover `guardInvokeAuth` después del `safeParse` ⇒ rojo |
| **T-A6** | AC-2 / P-6 | `.../remit-kyc-decision/invoke/route.test.ts` | `decisionToken` inválido ⇒ **401 byte-idéntico** al de "sin token" y al de "sesión ajena" (los **3 JSON serializados se comparan ENTRE SÍ**, no contra un literal), y el doble de `fetch` al partner recibe **CERO** llamadas | agregar un `reason` a una sola de las ramas ⇒ rojo |
| **T-A7** | AC-1/2 | ambos | `no-store` + `Vary` en **las 4 ramas que emite el handler**. Las cabeceras **se comparan entre sí**, no contra un literal. ⛔ **G-8: el 401 de `guardInvokeAuth` queda FUERA del conjunto y no se toca** | sacar `no-store` de una rama ⇒ rojo |
| **T-A8** 🔴 | **AC-3** | `src/manifest/registry.test.ts` (assert nuevo) | Los tests existentes de `/remit-kyc-validator/{invoke,session,decision}` **no se tocan y siguen verdes**. Se agrega un assert de que `MANIFEST_ENTRIES` conserva la entrada `remit-kyc-validator` con sus **6 capabilities** y su `inputSchema` **intacto** (los 7 `required`) | cambiar cualquier cosa de esa entrada ⇒ rojo |
| **T-A9** | AC-1/2 | `src/manifest/input-schema-drift.test.ts` | El test existente **ya cubre** los 2 `pathSlug` nuevos: sólo hay que poblar los dos mapas (W0-A4). El `it` por entrada es un `for` sobre `MANIFEST_ENTRIES` (`:203-211`) | publicar un `required` que Zod no exige ⇒ rojo por `compareObject` (3) |
| **T-A10** 🔴 | **AC-1 / CD-10** | `src/app/api/agents/compose-dialect-no-pii.test.ts` **[NUEVO]** | Barrido sobre el **JSON serializado de las 4 ramas** de los **dos** endpoints: no aparece `legalId`, ni `travelRuleData`, ni ningún dato de identidad | ecoar `parsed.data` en el 400 ⇒ rojo |

**Regla transversal de los tests de orden** (molde escrito en
`.../remit-kyc-validator/session/route.ts:36`): *"No es un test sobre el status: es un test sobre el
contador."* Los tests de orden **cuentan llamadas**, no leen status.

⚠️ **`wasiai-remittance-agents` NO tiene candado de citas** (verificado: no existe ningún
`*cit*.test.ts`). Las citas `archivo:línea` que escribas ahí **no las mira nadie** ⇒ re-derivalas a
mano después de tu última edición (CD-13).

### ✅ Criterio de terminado de W1 (ejecutable)

```
cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents
/usr/bin/git add -A                       # ⛔ CD-17: sin esto el gate da VERDE FALSO
npm run typecheck && npm test && npm run build
/usr/bin/git diff --stat main             # presupuesto: 450–800 líneas (CD-16, se MIDE)
```

Y después, **en este orden**:
1. Confirmar con el founder que `REMIT_KYC_SESSION_PAYTO` y `REMIT_KYC_DECISION_PAYTO` **ya están**.
2. Deploy.
3. `GET https://<host>/api/agents/remit-kyc-session/manifest` ⇒ **200** (no 503).
4. `GET https://<host>/api/agents/remit-kyc-decision/manifest` ⇒ **200** (no 503).
5. `POST https://<host>/api/agents/remit-kyc-validator/invoke` sin `Authorization` ⇒ **401** (o sea:
   `/invoke` sigue vivo y sin cambios — AC-3).

**Sólo entonces arranca W2.**

---

## W2 — Repo B: el guard del Coordinador + el catálogo

**Repo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a` · **Branch**: `feat/wkh-366-kyc-catalog-rows`

### W2-B1 · El guard N2

**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/lib/compose-step-shape.ts` **[MOD]**

**Por qué acá y no en el resolver** (DT-10): es el único punto que (i) ve el pipeline entero,
(ii) corre **antes** del débito, del discovery y del 402, y (iii) es una función **pura** sobre el
body. El docblock del archivo lo dice textual (`:8-15`):

> *"lo llama `validateComposeBody`, que `routes/compose.ts` ejecuta en `validateComposeBodyHandler`,
> o sea ANTES de `resolveComposePriceHandler` y ANTES de `requirePaymentOrA2AKey`. Un body que falle
> acá se rechaza SIN débito y SIN discovery. **Cualquier check que se agregue a este archivo hereda
> esa propiedad**; cualquier check que se agregue al route handler NO."*

Verificado en la cadena real: `contractingGuardHandler` (`src/routes/compose.ts:1176`) →
`createTimeoutHandler` (`:1179`) → **`validateComposeBodyHandler` (`:1188`)** →
`resolveComposeCapabilitiesHandler` (`:1193`) → `resolveComposePriceHandler` (`:1197`) →
`requirePaymentOrA2AKey` (`:1198`).

**El contrato, textual:**

```ts
// (1) el import — el ÚNICO import nuevo, y es a otro LEAF: la propiedad de "no lo moquea nadie"
//     se conserva (mismo criterio que `:18-20`, el único import de hoy y también a un leaf).
import { requiresPinnedAgent } from './capability-risk.js';

// (2) el código nuevo en la unión de `ComposeStepShapeError['code']` (`:34`)
code: 'VALIDATION_ERROR' | 'ambiguous_step' | 'capability_requires_pinned_agent';

// (3) la función, exportada, al final del archivo
/**
 * WKH-366 / AC-6 / CD-1 — un step cuyo OUTPUT ES UN VEREDICTO DE AUTORIZACIÓN DE DINERO no puede
 * resolverse por ranking: quién contesta cambia qué se autoriza, y `verified` —la primera clave del
 * sort— la AUTO-REPORTA el candidato federado (`services/discovery.ts:577-586`).
 *
 * ⚠️ ESTE GUARD NO MIRA `step.agent`. Un step pinado a un slug AJENO pasa y corre: es el caso
 * legítimo de "quiero contratar a ese agente". Lo que se prohíbe es DELEGAR LA ELECCIÓN, no elegir
 * mal a propósito.
 *
 * Corre donde corre este archivo (ver el docblock de cabecera): sin débito, sin discovery, sin 402.
 * Un impostor NO LLEGA A SER CONSULTADO.
 */
export function validateAuthorityPinning(
  steps: unknown[],
): ComposeStepShapeError | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') continue;      // el shape ya lo validó `validateComposeStepShape`
    const capability = (s as RawStep).capability;
    if (typeof capability !== 'string' || capability.length === 0) continue;
    if (!requiresPinnedAgent(capability)) continue;
    return {
      error: `Step ${i}: capability '${capability}' authorizes value delivery and must name the agent explicitly ('agent'), not be resolved by ranking`,
      code: 'capability_requires_pinned_agent',
      step: i,
    };
  }
  return null;
}
```

### W2-B2 · Cablearlo

**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/routes/compose.ts` **[MOD — 2 líneas]**

Dentro de `validateComposeBody` (`:180-210`), **después** del bucle de `validateComposeStepShape`
(`:205-208`) y **antes** del `return null` (`:209`):

```ts
  // WKH-366 / AC-6: va DESPUÉS del shape (así el mensaje de un step malformado sigue siendo el
  // histórico) y ANTES del `return null`. Hereda pre-débito/pre-discovery de dónde corre esta
  // función: la usan `validateComposeBodyHandler` (`:1188`, el guard real) y el route handler
  // (defense-in-depth).
  const pinErr = validateAuthorityPinning(steps as unknown[]);
  if (pinErr) return pinErr;
```

Y el import: agregar `validateAuthorityPinning` al import existente de `'../lib/compose-step-shape.js'`
(hoy trae `validateComposeStepShape` en `:13`).

⚠️ `type ComposeValidationError = ComposeStepShapeError;` (`:158`) ⇒ el código nuevo entra al tipo
sin más trabajo.

### W2-B3 · Tests de W2

| id | AC | Archivo | Qué afirma | 🧬 Mutante |
|---|---|---|---|---|
| **T-B3** 🔴 | **AC-6** | `src/routes/compose.capability.test.ts` | **El escenario del impostor.** `discoverMock` devuelve como `agents[0]` un `evil-kyc` con `verified:true`, `reputation:100`, `priceUsdc:0.000001` — o sea que **gana el ranking**. `POST /compose` con `{ capability:'kyc-decision-read', input:{} }` ⇒ **400 con `code === 'capability_requires_pinned_agent'`**, y **`mockCompose`, `discoverMock` y `debitMock` los TRES en cero**, y `budgetState.balance` sin moverse | quitar `'kyc-decision-read'` de `AUTHORIZATION_CAPABILITIES` ⇒ el impostor gana, es invocado, y devuelve `payoutAllowed:true` |
| **T-B4** 🔴 | **AC-6 — CONTROL POSITIVO DEL INSTRUMENTO** | `src/services/capability-resolver.test.ts` | Con el **MISMO** doble de discovery, `resolveCapability('kyc-decision-read', undefined, undefined)` **devuelve `evil-kyc`**. **Si esto diera "no candidates", T-B3 estaría midiendo un doble que no arma el ataque y su verde no valdría nada** | — este test **afirma que el agujero existe**; su valor es que T-B3 no sea teatro |
| **T-B5** | AC-7' | `src/services/compose.test.ts` **(G-1)** | Pipeline de **2 steps**, con el doble de `maybeTransform` devolviendo un objeto **distinto** al del agente 0. `steps[0].output` es **byte-idéntico** al body del agente 0, **y distinto** de la entrada que recibió el agente 1 | mover la asignación de `result.output` **después** del bridge ⇒ rojo |
| **T-B6** | AC-7' | `src/services/compose.test.ts` | Pipeline de **1 step**: `steps[0].bridgeType === undefined` **y** el doble de `maybeTransform` recibió **CERO llamadas** (contador, no status) | `i < steps.length - 1` → `i <= steps.length - 1` ⇒ rojo |
| **T-B7** | AC-6 | `src/routes/compose.capability.test.ts` | Un step con `{ agent:'remit-kyc-decision', input:{} }` (pinado) **pasa** el guard y se invoca normal: 200, `mockCompose` llamado, `discoverMock` **no** llamado | invertir el predicado de `requiresPinnedAgent` ⇒ rojo |
| **T-B8** | AC-6 | `src/routes/compose.capability.test.ts` | El guard corre **pre-pago**: el 400 sale con `debitMock` en **cero** y `budgetState.balance` sin moverse. Y `lookupByHashMock` refleja que **no** hubo lookups extra | mover el guard al route handler (post-débito) ⇒ rojo |

**Moldes verificados para T-B3/T-B7/T-B8** — `src/routes/compose.capability.test.ts`:
- `:1-16` docblock (**este archivo corre el middleware de pago REAL sobre un balance en memoria**, que
  es lo único que permite afirmar *"no se cobró"* en vez de *"devolvió 4xx"*)
- `:57-62` `discoverMock` + `vi.mock('../services/discovery.js', …)`
- `:99-105` `debitMock` con `budgetState.balance -= amountUsd`
- `:145-163` `makeAgent(slug, over)`
- `:166-188` `discovered(agents, excluded?)`
- `:492-511` **T-CAPROUTE-10 — el molde EXACTO de "400 sin cobrar"**: `balanceBefore`,
  `expect(debitMock).not.toHaveBeenCalled()`, `expect(mockCompose).not.toHaveBeenCalled()`,
  `expect(discoverMock).not.toHaveBeenCalled()`, y recién al final el `statusCode` y el `code`.

**Molde verificado para T-B4** — `src/services/capability-resolver.test.ts:20-23` (`discoverMock`
hoisted) y `:30-45` (`makeAgent`).

**Molde verificado para T-B5/T-B6** — `src/services/compose.test.ts:86-92`
(`vi.mock('./llm/transform.js', () => ({ maybeTransform: vi.fn().mockResolvedValue({...}) }))`) y
`:130` (`import { maybeTransform } from './llm/transform.js'`).

### W2-B4 · Documentación de códigos de error

**Archivo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/INTEGRATION.md` **[MOD, condicional]**

**Verificá primero si existe y si documenta los códigos de error de `/compose`.** Si los documenta,
agregá `capability_requires_pinned_agent`. Si no, **no crees la sección**: no inventes documentación
que nadie pidió.

### W2-OPS · Las dos filas del catálogo (no es diff de git)

1. **Publicar las 2 filas self-published en `a2a_agents`**, con:
   - `slug` = `remit-kyc-session` / `remit-kyc-decision`
   - `agent_url` apuntando a **los endpoints nuevos** (`…/api/agents/remit-kyc-session/invoke` y
     `…/api/agents/remit-kyc-decision/invoke`), **no** a `/invoke` del validador viejo
   - `metadata.inputSchema` = **copia exacta** de la ficha de A (W0-A2)
   - `metadata.outputSchema` — hace falta para que el smoke de W4 pueda **cruzar nombres de campo**
   - `enabled: true`, `discoverable: true`
   - **una capacidad por fila**
   - precio y payment spec de W0-A2

   ⚠️ **El `agent_url` NO tiene que coincidir con el slug de la fila**: está medido en el catálogo
   vivo (`remit-corridor-fx-solana` publica `invokeUrl = …/api/agents/remit-corridor-fx/invoke`) y
   declarado deliberado del lado del agente (`wasiai-remittance-agents/src/manifest/registry.ts:8-10`).
   Acá los elegimos iguales igual, por tener **una** cosa que recordar en vez de dos.

2. **Verificar AC-5** con `GET /discover/remit-kyc-session` y `GET /discover/remit-kyc-decision`:
   - `invokeUrl` resuelve a los endpoints **nuevos**
   - `inputSchema.required` **NO** contiene `legalId`
   - **Guardá el JSON de las dos corridas: es la evidencia de AC-5.** No hay test unitario posible —
     la fila vive en la BD, no en el repo.

3. **⚠️ Leer, no asumir**: verificá qué capacidades declara HOY la fila viva de `remit-kyc-validator`
   en el catálogo. El manifiesto de A declara `kyc-hosted-redirect`
   (`wasiai-remittance-agents/src/manifest/registry.ts:76`) pero **la fila del Coordinador es una
   copia manual y puede estar atrasada** (R-6). No afecta el diseño; sí hay que **leerlo**.

4. **Credencial saliente: NO se toca nada.** Está **verificado, no asumido**:
   (a) `POST https://wasiai-remittance-agents.vercel.app/api/agents/remit-corridor-fx/invoke` sin
   `Authorization` da `401 {"error":"unauthorized","reason":"credential_missing"}` ⇒ ese host **exige**
   credencial; (b) la sonda horaria da `success` invocando ese mismo agente **a través de `/compose`**.
   El bearer se resuelve por **host** del `invokeUrl`
   (`wasiai-a2a/src/services/compose.ts:1822-1825`), no por slug ni por ruta, y los endpoints nuevos
   viven en el **mismo host**. ⇒ **NO hace falta ninguna variable nueva en Railway.**
   Se re-verifica **leyendo** (la sonda sigue verde), no escribiendo.

### ✅ Criterio de terminado de W2 (ejecutable)

```
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
/usr/bin/git add -A
npx tsc -p tsconfig.json --noEmit && npm run lint && npm test
/usr/bin/git diff --stat main             # presupuesto: 150–400 líneas de código (CD-16)
```

Después: deploy → las 2 filas publicadas → los dos `GET /discover/<slug>` verificados con su JSON
guardado.

**Sólo entonces se puede pensar en encender la bandera de W3.**

---

## W3 — Repo C: el transporte, con la bandera en `direct` (CERO cambio observable)

**Repo**: `/home/ferdev/.openclaw/workspace/chaski-v3` · **Branch**: `feat/wkh-366-kyc-gateway-transport`

⚠️ **Esta wave se puede ESCRIBIR en paralelo con W1/W2.** Lo que no se adelanta es el **encendido**.

⛔ **`src/infrastructure/kyc/agent-env.ts`: CERO DIFF.** Contiene la única aparición del slug viejo en
producción (`:32`) y `T-ENV-3` (`src/infrastructure/kyc/agent-env.test.ts:74-93`) cuenta apariciones
**TEXTUALES, prosa incluida**, y exige exactamente **1**. Un comentario nuevo que lo nombre lo pone
rojo.

### W3-C1 · `gateway-client.ts` — la unión + la superficie del bridge

**Archivo**: `/home/ferdev/.openclaw/workspace/chaski-v3/src/infrastructure/a2a/gateway-client.ts` **[MOD]**

**Cambio 1 — `GatewayStep` pasa a ser una unión discriminada** (DT-13). Hoy es
(`:97-101`, verificado):

```ts
export type GatewayStep = {
  capability: string; // NUNCA `agent` (CD-1)
  input: Record<string, unknown>;
  constraints?: GatewayConstraints;
};
```

Queda:

```ts
/**
 * Un step del pipeline. UNIÓN DISCRIMINADA, y las dos variantes existen por razones distintas:
 *
 *  · `{capability, …}` — el caso normal (CD-1/WKH-304): el GATEWAY resuelve quién ejecuta. Es lo que
 *    emiten los legs de FX y de payout, y su body es BYTE-IDÉNTICO al de antes de WKH-366 (T-C1b).
 *  · `{agent, …}` — WKH-366/AC-6: SÓLO para capacidades cuyo output es un VEREDICTO DE AUTORIZACIÓN
 *    DE DINERO. Ahí "delegar la elección" no es una simplificación: cambia quién contesta
 *    `payoutAllowed`. El Coordinador rechaza esas capacidades con 400 pre-débito
 *    (`capability_requires_pinned_agent`), así que el pin no es una preferencia: es el único camino.
 *
 * ⛔ Las dos claves son MUTUAMENTE EXCLUYENTES: `agent` + `capability` juntos ⇒ `ambiguous_step`
 * (400) del servidor. El tipo lo impide en compilación.
 */
export type GatewayStep =
  | { capability: string; input: Record<string, unknown>; constraints?: GatewayConstraints }
  | { agent: string; input: Record<string, unknown> };
```

**Cambio 2 — la emisión condicional.** Hoy el `map` del body es (`:329-333`, verificado):

```ts
        steps: params.steps.map((s) => ({
          capability: s.capability,
          input: s.input,
          ...(s.constraints ? { constraints: s.constraints } : {}),
        })),
```

Queda emitiendo **exactamente las claves de la variante que le tocó**, y **nada más**:

```ts
        steps: params.steps.map((s) =>
          "agent" in s
            ? { agent: s.agent, input: s.input }
            : {
                capability: s.capability,
                input: s.input,
                ...(s.constraints ? { constraints: s.constraints } : {}),
              },
        ),
```

🔴 **T-C1b canda que el body de la variante `capability` es BYTE-IDÉNTICO al de antes.** Los dos legs
vivos (FX y payout) no pueden cambiar ni un byte.

**Cambio 3 — 🔻 G-3: la superficie del bridge.** `runViaGateway` **no expone hoy `bridgeType`** —su
`ok` es `{ok:true, outputs, agents}` (`:406`) y `readAgentRef` (`:195-217`) no lo lee— así que
**T-C6 es inimplementable sin esto**. El SDD lo dio por disponible y no lo está.

Contrato mínimo, **fail-closed por construcción** (CD-15: la fila por defecto es FALLO):

```ts
/**
 * WKH-366 / CD-2 — ¿el gateway reportó que un BRIDGE corrió sobre este step?
 *
 * Uno por step, en el MISMO orden que `outputs`. `true` = el step trae un `bridgeType` presente y
 * distinto de `undefined`, sea cual sea su valor.
 *
 * 🔴 SE MIDE LA PRESENCIA, NO EL VALOR, Y ES A PROPÓSITO. Enumerar valores conocidos
 * (`"LLM"`, `"CACHE_L1"`, …) sería fail-OPEN sobre cualquier valor que el gateway agregue mañana, y
 * el consumidor de esto es el gate de un desembolso. Sólo la AUSENCIA pasa.
 */
bridged: boolean[];
```

y en el bucle de `:392-405` (el `for` abre en `:394`):

```ts
    bridged.push(isRecord(entry) && "bridgeType" in entry && entry.bridgeType !== undefined);
```

⚠️ **Esto NO es una decisión de diseño del Dev.** Es una superficie **mecánicamente forzada** por el
gap G-3. **Anotalo así en el commit y en el docblock**, para que AR/CR lo evalúen como tal.

**Cambio 4 — la cabecera del archivo, reescrita (CD-14).** Hoy `:1-6` afirma, sin excepción:

> *"3er modo de transporte value-delivery ("a2a-gateway"): **NO resuelve el agente por nombre** —
> manda `capability` (+ `constraints` opcionales) por step a POST /compose y el GATEWAY resuelve,
> fail-closed (WKH-304/CD-1). Este cliente ya no descubre agentes ni los elige"*

**Esta HU la vuelve falsa.** Reescribila —**no la amplíes**— para que diga:
(a) el caso general sigue siendo pedir la capacidad y que el gateway resuelva;
(b) **la excepción, acotada y con su motivo**: los steps cuyo output es un veredicto de autorización
de dinero llevan `agent`, porque delegar la elección cambia **quién contesta `payoutAllowed`**, y el
Coordinador rechaza esas capacidades con 400 pre-débito;
(c) que el conjunto de la excepción son exactamente **dos capacidades** y **ninguna más**;
(d) que la verificación post-hoc del ejecutor (N3) vive en `gateway-kyc-client.ts`.

⛔ **Escribí el nombre de la HU y la fecha.** Un bloque que dice "esto vale siempre" cuando ya no vale
es prosa que envejeció, que es el patrón recurrente en **3 de las 3** últimas HUs DONE.

### W3-C2 · `gateway-kyc-client.ts` — el hermano por gateway [NUEVO]

**Archivo NUEVO**: `/home/ferdev/.openclaw/workspace/chaski-v3/src/infrastructure/kyc/gateway-kyc-client.ts`

**Exemplar a copiar**: `src/infrastructure/kyc/agent-kyc-client.ts` (306 líneas) — **entero**, salvo
el transporte. Anclas verificadas: `:129` `AgentKycCall<T>`, `:131-133` `isRecord`, `:135-140`
`readString`, `:142-146` `readBoolean`, `:148-153` `readRiskLevel`, `:155-158` `warnUpstream`,
`:160-165` `warnError`, `:178` `createAgentKycSession`, `:183-185` la omisión de `identityRef`,
`:234` `readAgentKycDecision`, `:289-297` el estrechado de decisión, `:299-304` `identityMatches`
preservado ausente, `:270-288` la **REGLA NORMATIVA** de cómo entra un campo nuevo de `/decision`
(un lector estricto sobre un campo que el agente agrega y después revierte **corta el KYC entero**).

**El contrato, textual:**

```ts
// SERVER-ONLY, igual que sus dos hermanos. ⛔ PROHIBIDO importarlo desde `src/presentation/**` ni
// desde `container.ts` (CD-20): el `decisionToken` NO puede llegar al navegador.

const KYC_SESSION_SLUG = "remit-kyc-session";
const KYC_DECISION_SLUG = "remit-kyc-decision";
/** `wasiai-a2a/src/types/index.ts:305-306` — `SELF_PUBLISHED_REGISTRY_ID`/`_NAME`. */
const EXPECTED_REGISTRY = "self-published";

/** El gateway devolvió un `{ok:false}` de cualquier código (incluida config ausente). */
export const UPSTREAM_GATEWAY_FAILURE = -2;
/** 200, pero el ejecutor NO es el par `(slug, self-published)` esperado. N3 de AC-6. */
export const UPSTREAM_GATEWAY_AGENT_MISMATCH = -3;
/** 200, pero el gateway reportó que un BRIDGE corrió sobre el step. CD-2. */
export const UPSTREAM_GATEWAY_BRIDGE_PRESENT = -4;

export async function createAgentKycSessionViaGateway(input: {
  identityRef?: string;
}): Promise<AgentKycCall<KycAgentSessionOutput>>;

export async function readAgentKycDecisionViaGateway(input: {
  sessionId: string;
  identityClaim?: string;
  decisionToken: string;
}): Promise<AgentKycCall<KycAgentDecisionOutput>>;
```

**Los sentinelas son NEGATIVOS a propósito**: no pueden chocar nunca con un status HTTP real, ni con
el `0` ("no hubo status upstream"), ni con el `-1` de `UPSTREAM_INVOKE_SECRET_UNSET`
(`agent-kyc-client.ts:104`).

**El body que emite** (N1 — el pin):

```ts
// session
runViaGateway({ steps: [{ agent: KYC_SESSION_SLUG, input: body }] })
//   body = {}                                si no hay identityRef
//   body = { identityRef: <valor> }          si lo hay
//   ⛔ NUNCA `{ identityRef: null }` ni `{ identityRef: undefined }` explícito.

// decision
runViaGateway({ steps: [{ agent: KYC_DECISION_SLUG, input: body }] })
//   body = { sessionId, decisionToken }                      sin identityClaim
//   body = { sessionId, decisionToken, identityClaim }       con él
```

⛔ **`capability` NUNCA.** ⛔ **Exactamente UN step por llamada** (eso además cierra CD-2 por estructura:
un step único no tiene "siguiente").

**P-4 se REPLICA, no se reinventa**: la regla es idéntica a la del directo
(`agent-kyc-client.ts:166-172` la regla, `:183-185` el código): `identityRef` ausente ⇒ **la clave se omite**. El schema del agente
es `.strict()` y omitirla es lo que materializa *"sin prueba de posesión la persona se verifica igual,
con la sesión sin atar"*. Ídem `identityClaim` en decisión.

**La escalera de fallo — 🔴 el DEFAULT es FALLO (CD-15):**

```
1. runViaGateway devuelve { ok:false, ... }  (CUALQUIER código, incluido not_configured)
                                                        ⇒ { ok:false, upstream: -2 }
2. r.agents[0] === null | .slug !== <slug esperado> | .registry !== "self-published"
                                                        ⇒ { ok:false, upstream: -3 }   ← N3
3. r.bridged[0] === true                                ⇒ { ok:false, upstream: -4 }   ← CD-2
4. estrechado campo a campo con los MISMOS lectores     ⇒ una clave faltante o mal tipada TIRA
                                                           (`kyc_agent_bad_response:<rama>:<campo>`)
5. todo ok                                              ⇒ { ok:true, output }
```

🔴 **Se escribe como `if (todo-ok) return ok; return fail;`, NUNCA como un `switch` sobre códigos
conocidos con un `default: ok`.** El status HTTP real del agente **se pierde** en el camino
(`wasiai-a2a/src/lib/agent-http-error.ts:90-91`: sólo sobrevive `INPUT_REJECTED` / `AGENT_ERROR`),
así que enumerar casos conocidos es **estructuralmente imposible de hacer bien**.

🔴 **CD-19 — el borde se estrecha, NO se castea.** Los **mismos** `readString` / `readBoolean` /
`readRiskLevel`, los **mismos** códigos `kyc_agent_bad_response:<rama>:<campo>`, de modo que **los dos
transportes fallan igual**. Un `as KycAgentDecisionOutput` haría que una clave faltante viajara como
`undefined` hasta el gate del desembolso. Y **`identityMatches` se preserva AUSENTE, nunca `?? false`**:
ausente significa *"no se preguntó"*; `false` sería **una acusación sobre la persona**
(`agent-kyc-client.ts:299-304`).

**El campo `lifecycle` NO se lee.** El directo tampoco lo lee (verificado: `KycAgentDecisionOutput`,
`src/infrastructure/kyc/agent-contract.ts:52-70`, no lo declara) y una clave desconocida **no tira**
(candado `T-073-TOL-1` en `agent-kyc-client.test.ts`). **Los dos transportes tienen que tolerarla
igual.**

**Efecto sobre `authority.ts`: NINGUNO.** `!r.ok ⇒ kyc_reauth_failed/502` sin mirar `upstream`
(`authority.ts:187-191`). El conjunto observable de `prepare` **no cambia**. Lo que **sí** cambia es
el **body** de `/api/kyc/session` y `/api/kyc/decision`, que ecoan `upstream` — igual que ya pasó con
el `-1`, y por eso **se dice en voz alta**. El precedente está escrito en
`app/api/kyc/session/route.ts:370-372`, textual: *"⚠️ Y ESTO **SÍ** CAMBIA EL CONJUNTO OBSERVABLE,
dicho en voz alta […] El STATUS sigue siendo 502 en los dos."* **Escribí lo mismo para los tres
sentinelas nuevos `-2/-3/-4`.**

### W3-C3 · `kyc-transport.ts` — el despachador [NUEVO]

**Archivo NUEVO**: `/home/ferdev/.openclaw/workspace/chaski-v3/src/infrastructure/kyc/kyc-transport.ts`

**Por qué un despachador y no un `if` dentro del cliente actual** (DT-12): en el paso 7 (W6) se borra
**un archivo entero** en vez de desenredar un `if`. Y los 3 call sites cambian **sólo el especificador
del import** — cero cambio de forma (AC-11).

```ts
/**
 * WKH-366 — despachador del transporte de KYC. Exporta las MISMAS DOS FIRMAS que el cliente directo:
 * los 3 call sites cambian sólo de dónde importan, y ninguno cambia de forma (AC-11).
 */
export type KycTransport = "direct" | "gateway";

/**
 * ⛔ FAIL-SAFE: cualquier valor que NO sea exactamente `"gateway"` (tras `.trim()`) resuelve a
 * `"direct"`. Un typo NO enciende el camino nuevo. ⛔ NADA de `toLowerCase()`, nada de truthiness:
 * `"GATEWAY"`, `"1"`, `"true"`, `" gateway"` y `""` son todos `"direct"`.
 */
export function readKycTransport(): KycTransport {
  return process.env.KYC_TRANSPORT?.trim() === "gateway" ? "gateway" : "direct";
}

export async function createAgentKycSession(input: {
  identityRef?: string;
}): Promise<AgentKycCall<KycAgentSessionOutput>> {
  return readKycTransport() === "gateway"
    ? createAgentKycSessionViaGateway(input)
    : createAgentKycSessionDirect(input);
}

export async function readAgentKycDecision(input: {
  sessionId: string;
  identityClaim?: string;
  decisionToken: string;
}): Promise<AgentKycCall<KycAgentDecisionOutput>> {
  return readKycTransport() === "gateway"
    ? readAgentKycDecisionViaGateway(input)
    : readAgentKycDecisionDirect(input);
}
```

⚠️ **`.trim()` va antes de la comparación**, igual que en `invokeAuthHeader`
(`agent-kyc-client.ts:113`) y en `resolveKycAgentBaseUrl` (`agent-env.ts:52`). Ojo con el signo:
`" gateway".trim() === "gateway"` ⇒ **enciende**. Lo que NO enciende es `"GATEWAY"`, `"1"`, `"true"`,
`""` ni cualquier otro literal. **Ese es el punto de T-C3, y hay que escribir la tabla con el
resultado esperado de cada entrada — no razonarlo.**

⚠️ **Re-exportar también `KycAgentConfigError` y `UPSTREAM_INVOKE_SECRET_UNSET`**: los 3 call sites los
importan hoy del cliente directo (`app/api/kyc/session/route.ts:36`, `app/api/kyc/decision/route.ts:27`).
Si no los re-exportás, los call sites cambian **más** que el especificador y se rompe AC-11.

### W3-C4 · Renombres e imports — el cambio más chico posible

| Archivo | Cambio EXACTO |
|---|---|
| `src/infrastructure/kyc/agent-kyc-client.ts` **[MOD]** | **Renombrar los 2 exports** a `createAgentKycSessionDirect` (`:178`) y `readAgentKycDecisionDirect` (`:234`). ⛔ **Los CUERPOS quedan intactos, byte por byte.** |
| `app/api/kyc/session/route.ts` **[MOD]** | `:36` — sólo el **especificador** del import: `…/agent-kyc-client` → `…/kyc-transport`. La llamada de `:375` no cambia |
| `app/api/kyc/decision/route.ts` **[MOD]** | `:27` — ídem. La llamada de `:89` no cambia |
| `src/infrastructure/payout/authority.ts` **[MOD]** | `:69` — ídem. La llamada de `:180` no cambia. ⛔ **`:70` (`import { resolveKycAgentBaseUrl } from "../kyc/agent-env"`) NO SE TOCA** — ver G-5 |
| `src/composition/agent-slug-residue.static.test.ts` **[MOD]** | **Reescribir el bloque `:32-63`** — ver abajo |
| `.env.example` **[MOD]** | Documentar `KYC_TRANSPORT` — ver W3-C6 |
| `README.md` **[MOD]** | `:417` `**154 test files**` → el número **medido** (G-7) |
| `README.es.md` **[MOD]** | `:441` `**154 archivos de test**` → el mismo número **medido** (G-7) |

#### 🔴 La reescritura obligatoria del bloque WKH-233 del candado de slugs

`src/composition/agent-slug-residue.static.test.ts:32-63` trae hoy, en su párrafo (b), esta
afirmación:

> *"El gateway A2A resuelve capacidades con un `POST /compose` de N pasos, y `GET /decision` es un
> **GET con la credencial en una cabecera** y un redirect humano en el medio: **el protocolo NO SABE
> EXPRESAR eso hoy** (DT-1). No hay una capacidad que pedir en lugar del slug — hay un slug o no hay
> KYC."*

y cierra, en `:61-62`, con esta instrucción:

> *"El día que el gateway sepa expresar una capacidad de dos saltos con redirect humano, este slug
> tiene que irse a `PROHIBIDAS` como los otros — **y ese día hay que borrar este bloque, no
> ampliarlo**."*

**Ese día llegó: es esta HU. Y el slug NO se va.** El motivo es **distinto** del que la instrucción
anticipaba: el slug deja de ser una URL y pasa a ser un **pin de seguridad** (N1 de AC-6). Un bloque
que dice "esto se va el día X" cuando el día X ya llegó y no se fue es **prosa que envejeció**.

**Reescribí el bloque `:32-63`** para que diga, con la fecha (2026-08-26) y el número de HU (WKH-366):
- (a) el gateway **ya sabe** expresar los dos saltos: es lo que esta HU construyó (dos endpoints POST
  con el dialecto de `/compose`, dos filas de catálogo, dos capacidades);
- (b) y **aun así el slug se queda**, porque cambió de rol: ya no es una URL cableada sino el pin de
  AC-6/CD-1. Pedir la capacidad en su lugar **no funcionaría igual de bien**: cambia **quién contesta
  `payoutAllowed`**;
- (c) la derogación de CD-1/WKH-304 está **acotada exactamente** a los steps cuyo output es un
  veredicto de autorización de dinero, y en ninguno más: **los legs de FX y de payout siguen pidiendo
  capacidad, sin una línea de diff**;
- (d) qué lo canda ahora: `T-ENV-3` para el slug viejo + `T-KGS-1/2/3` (W3-C5) para los dos nuevos.

⛔ **No lo amplíes con un párrafo más abajo. Reescribilo.**

⚠️ Los dos slugs nuevos **no ponen rojo** el candado: `PROHIBIDAS` son
`["remit-corridor-fx","remit-cashout-payout"]` (`:82`, verificado) y ninguno de los dos nuevos las
contiene. Y ninguno contiene la subcadena `remit-kyc-validator` ⇒ **`T-ENV-3` tampoco se mueve.**
**Que ningún candado se ponga rojo NO es permiso para no declarar nada.**

### W3-C5 · El guard de conteo [NUEVO]

**Archivo NUEVO**: `/home/ferdev/.openclaw/workspace/chaski-v3/src/composition/kyc-gateway-slug-count.static.test.ts`

**Exemplar**: `src/composition/agent-slug-residue.static.test.ts` — `:67-71` (`ROOT`, `SCAN_DIRS`,
`SCAN_EXTS`, `SKIP_DIRS`), `:94` (`const SELF`), `:96-98` (`isTestFile`), `:100-112` (`walk`, con
`path.resolve(full) !== SELF && !isTestFile(full)`), `:139-150` (el **control de no-vacuidad**:
`expect(FILES.length).toBeGreaterThan(50)` + que el matcher matchee **y** que no matchee lo que no debe).

⛔ **CD-9 — ningún guard se lee a sí mismo.** El mecanismo es `path.resolve(full) !== SELF`, exactamente
el del exemplar. Un `expect(self.includes("literal"))` **nunca puede fallar**, porque el literal está
en la línea que lo busca; este repo ya pagó **tres controles vacuos** por ese error.

| id | AC | Qué afirma | 🧬 Mutante |
|---|---|---|---|
| **T-KGS-1** | AC-15 (parcial) | `"remit-kyc-session"` aparece **exactamente 1 vez** en producción (`src` + `app`, excluidos `*.test.*` y el propio guard) | escribir el slug en un segundo módulo ⇒ 2 ⇒ rojo |
| **T-KGS-2** | AC-15 (parcial) | Ídem para `"remit-kyc-decision"` | ídem |
| **T-KGS-3** 🔻 **(G-4)** | AC-15 (parcial) | **`kycAgentUrl`** se importa desde **exactamente 1** módulo de producción (`src/infrastructure/kyc/agent-kyc-client.ts`). **`resolveKycAgentBaseUrl`** se importa desde **exactamente 4**, y **la lista va escrita literal**: `src/infrastructure/kyc/agent-kyc-client.ts` · `src/infrastructure/payout/authority.ts` · `app/api/kyc/session/route.ts` · `app/api/kyc/decision/route.ts` | importar `kycAgentUrl` desde el gateway-client ⇒ 2 ⇒ rojo. Agregar un 5º importador de `resolveKycAgentBaseUrl` ⇒ rojo |

🔴 **G-4 es la corrección que evita un rojo gratuito**: el SDD decía "exactamente **un** módulo" para
los dos símbolos, y eso **es falso hoy, sin ningún cambio** — `resolveKycAgentBaseUrl` ya tiene 4
importadores de producción (medido). Escribirlo como decía el SDD dejaría el test rojo sobre `main`.

**Control de no-vacuidad obligatorio** (molde `:139-150`): el barrido tiene que **ver archivos**
(`FILES.length > 50`) y **encontrar la aguja cuando la aguja está**. Sin eso, un `walk` que devuelve
casi nada **aplaude**.

### W3-C6 · `.env.example`

**Archivo**: `/home/ferdev/.openclaw/workspace/chaski-v3/.env.example` **[MOD]**

Documentá `KYC_TRANSPORT` cerca del bloque de `WASIAI_A2A_*` (`:305-311`, verificado). Tiene que decir:

1. Valores: `direct` (default) | `gateway`. **Cualquier otro valor ⇒ `direct`.** Un typo NO enciende.
2. **El orden de encendido, y que el inverso rompe**: primero `gateway` en **preview** + la corrida
   real de Didit del founder (AC-14), y **recién después** `gateway` en producción.
3. **Rollback = borrar la env.** Sin redeploy.
4. ⛔ **El rollback NO ES rotar `KYC_DECISION_TOKEN_SECRET`: eso es un CORTE** que invalida los
   tokens de gente ya verificada que no cobró (`src/infrastructure/kyc/agent-env.ts:27-29`).
5. 🔻 **G-5, y es lo que más se va a olvidar**: bajo `KYC_TRANSPORT=gateway`, **`KYC_AGENT_BASE_URL`
   SIGUE SIENDO OBLIGATORIA**. Los tres preflights que la resuelven viven **fuera** del transporte y
   son el interruptor de rollback D-1 de WKH-233:
   `app/api/kyc/session/route.ts:73` (⇒ 501), `app/api/kyc/decision/route.ts:39` (⇒ 501),
   `src/infrastructure/payout/authority.ts:97` (⇒ 503 en prod). Quitarla **apaga el KYC entero**,
   sea cual sea el transporte.
6. Y que bajo `gateway` hacen falta además `WASIAI_A2A_GATEWAY_URL` + `WASIAI_A2A_AGENT_KEY`
   (`gateway-client.ts:232-242`; sin cualquiera de las dos, `readGatewayConfig` devuelve `null` y
   `runViaGateway` sale `not_configured` **sin fetch**), **con saldo en la red de
   `WASIAI_A2A_PAYMENT_CHAIN`** — el saldo de una Agent Key es **por red**.

### W3-C7 · Tests de W3

| id | AC | Archivo | Qué afirma | 🧬 Mutante |
|---|---|---|---|---|
| **T-C1** 🔴 | **AC-8** | `src/infrastructure/kyc/kyc-transport.test.ts` **[NUEVO]** | **La bandera conmuta, y se mide CONTANDO, no leyendo status.** Con `KYC_TRANSPORT` **ausente** y con `"direct"`: el doble de `fetch` recibe **≥1** llamada al host del agente y **0** al gateway. Con `"gateway"`: **0** al agente y **≥1** al gateway | invertir el default ⇒ rojo |
| **T-C1b** | AC-8 | `src/infrastructure/a2a/gateway-client.test.ts` (existente o nuevo) | El body que emite la variante **`{capability,…}`** es **byte-idéntico** al de antes de esta HU (snapshot del `body` serializado para un step de FX y uno de payout) | tocar el `map` de la variante capability ⇒ rojo |
| **T-C2** | AC-8 | `src/infrastructure/kyc/kyc-transport.test.ts` | Con `direct`, la **URL y el body** del `fetch` son byte-idénticos a los de antes de esta HU (snapshot del `RequestInit`) | tocar el cuerpo del cliente directo ⇒ rojo |
| **T-C3** | AC-8 | `src/infrastructure/kyc/kyc-transport.test.ts` | `"GATEWAY"`, `" gateway"` (tras trim **sí** enciende — ojo: `" gateway".trim() === "gateway"` ⇒ **`gateway`**), `"gateway "`, `"1"`, `"true"`, `""`, `undefined`. **Sólo el literal exacto tras `.trim()` enciende.** Escribí la tabla completa con el resultado esperado de cada uno | `toLowerCase()` o truthiness ⇒ rojo |
| **T-C4** | AC-9 | `src/infrastructure/kyc/gateway-kyc-client.test.ts` **[NUEVO]** | Con `gateway`: el body de `/compose` lleva **`agent`** (**nunca** `capability`), **un solo step**, y `x-a2a-key` en la cabecera | emitir `capability` ⇒ rojo |
| **T-C5** 🔴 | **AC-6 / N3** | `src/infrastructure/payout/authority.gateway.test.ts` **[NUEVO]** | El gateway devuelve **200 con un output de decisión perfectamente válido** (`payoutAllowed:true` incluido) pero `steps[0].agent.slug === "evil-kyc"` ⇒ `{ok:false, upstream:-3}` ⇒ `resolvePayoutAuthority` devuelve `kyc_reauth_failed`/**502** y **NO autoriza** | **borrar el chequeo de slug ⇒ AUTORIZA UN DESEMBOLSO** |
| **T-C5b** | AC-6 / N3 | ídem | Slug **correcto** pero `registry: "un-registry-cualquiera"` ⇒ rechazo. Y `agents[0] === null` ⇒ rechazo. Y `registry` **ausente** ⇒ rechazo | chequear sólo el slug ⇒ rojo |
| **T-C6** 🔴 | **AC-7' / CD-2** | `src/infrastructure/kyc/gateway-kyc-client.test.ts` | 200 con `steps[0].bridgeType: "LLM"` ⇒ `{ok:false, upstream:-4}`. Y con **cualquier otro valor** presente (`"SKIPPED"`, `"CACHE_L1"`, `123`) ⇒ **también rechaza** (se mide PRESENCIA, no valor) | ignorar el campo, o enumerar sólo `"LLM"` ⇒ rojo |
| **T-C7** 🔴 | **AC-10 — fail-closed POR DEFECTO, no por enumeración** | `src/infrastructure/payout/authority.gateway.test.ts` | Tabla de **10 filas**: `not_configured`, `unavailable`, `bad_response`, `payment_required`(402), `forbidden`(403), `no_agent_match`(422), `step_failed`+`agentFailure:"AGENT_ERROR"`, `step_failed`+`agentFailure:"INPUT_REJECTED"`, `step_failed` **sin** `agentFailure`, y **un código inventado que no existe en el union**. Las 10 ⇒ `{ok:false}` ⇒ las 10 ⇒ `kyc_reauth_failed`/502 ⇒ **ninguna autoriza** | un `default:` que devuelva `ok:true` ⇒ rojo |
| **T-C8** | AC-10 | `src/infrastructure/kyc/gateway-kyc-client.test.ts` | 200 con `payoutAllowed: "true"` (**el STRING**) ⇒ `readBoolean` **tira** ⇒ 502. Y con `payoutAllowed: false` ⇒ `kyc_not_approved`/**200**, no 502: **las dos negativas NO se colapsan** | `=== true` → truthiness ⇒ rojo |
| **T-C9** | AC-11 / P-7 | `src/infrastructure/payout/authority.gateway.test.ts` | Los 3 call sites siguen llamando `createAgentKycSession` / `readAgentKycDecision` con la misma firma, y `authority.ts` conserva los guards **en el mismo orden**: assert estructural sobre el orden de **efectos** — `tokenStore.getForOwner` (`:159`) se llamó **antes** del transporte (contador + orden de invocación) | mover Guard 3 después del viaje ⇒ rompe P-7 ⇒ rojo |
| **T-C10** 🔴 | **AC-12** | `src/infrastructure/payout/authority.gateway.test.ts` | Bajo **LOS DOS** transportes: un `(session_id, owner_address)` que **no matchea** ⇒ `kyc_ownership_mismatch` con `httpStatus:200`, **y el transporte NO se invoca** (contador = 0) | pasar el claim crudo en vez del canonicalizado ⇒ rojo |
| **T-C11** | AC-9 / P-4 | `src/infrastructure/kyc/gateway-kyc-client.test.ts` | El transporte `gateway` **OMITE la clave** `identityRef` / `identityClaim` cuando no hay. **No manda `null`.** Assert sobre `Object.keys(body).sort()` | `?? null` ⇒ rojo |

⛔ **CD-7 — ningún test de cableado se da por bueno con `vi.stubGlobal('fetch')`.** Estos dobles miden
**decisiones**. El **cableado** lo mide W4 contra servicios desplegados. Los dos son necesarios y
ninguno reemplaza al otro.

⛔ **CD-8 — cada test se rompe a propósito antes de darse por bueno**, y el rojo se cita en el
`auto-blindaje.md`. *"El test pasa"* es la mitad barata.

### ✅ Criterio de terminado de W3 (ejecutable)

```
cd /home/ferdev/.openclaw/workspace/chaski-v3
/usr/bin/git add -A                       # ⛔ CD-17

# G-7: MEDIR el conteo de archivos de test y actualizar los DOS README
#      (README.md:417 «**N test files**» · README.es.md:441 «**N archivos de test**»)
#      El guard es src/composition/readme-test-count.test.ts:87-90 — se mide, no se estima.

npm run qa && npm run build
/usr/bin/git diff --stat main             # presupuesto: 800–1400 líneas (CD-16)

# ⛔ VERIFICACIÓN OBLIGATORIA: agent-env.ts tiene CERO diff
/usr/bin/git diff main -- src/infrastructure/kyc/agent-env.ts   # tiene que salir VACÍO
```

**Deploy con `KYC_TRANSPORT` AUSENTE.** Cero cambio de comportamiento observable.

---

## W4 — Verificación e2e en mock (AC-13)

**Repo**: `/home/ferdev/.openclaw/workspace/chaski-v3` · misma branch.

🔴 **DT-14 — va como `.ts`, NO como `.mjs`.** `chaski-v3/tsconfig.scripts.json:4` incluye
`["scripts/**/*.ts"]` ⇒ **un `.mjs` no lo typechequea nadie** y `npm run qa` pasaría verde sobre un
script roto. El work-item decía `.mjs`; **se desvía a propósito**.

**Archivos:**

| Archivo | Qué |
|---|---|
| `/home/ferdev/.openclaw/workspace/chaski-v3/scripts/smoke-kyc-helpers.ts` **[NUEVO]** | **Puro**: `deriveInput`, `assertExecutor`, `classify`, `schemaFingerprint`. Cero I/O |
| `/home/ferdev/.openclaw/workspace/chaski-v3/scripts/smoke-kyc-helpers.test.ts` **[NUEVO]** | Sus tests. **Un script sin tests de sus piezas puras no es una sonda: es una opinión** |
| `/home/ferdev/.openclaw/workspace/chaski-v3/scripts/smoke-kyc-via-gateway.ts` **[NUEVO]** | La I/O |
| `/home/ferdev/.openclaw/workspace/chaski-v3/package.json` **[MOD]** | `+ "smoke:kyc-gateway": "tsx scripts/smoke-kyc-via-gateway.ts"` (molde: `"smoke:solana"`, `:17`) |

**Exemplar de ESTRUCTURA** (repo C): `scripts/smoke-solana-e2e.ts` + `scripts/smoke-helpers.ts` +
`scripts/smoke-helpers.test.ts` — script `.ts` con `tsx`, piezas puras en módulo aparte **con su
propio `.test.ts`**.

**Exemplar de CONTENIDO** (repo B): `/home/ferdev/.openclaw/workspace/wasiai-a2a/scripts/probe-money-path.mjs`.
Anclas verificadas: `:1-20` docblock con los exit codes, `:182-198` `deriveInput`, `:202-204`
`schemaFingerprint`, `:250-268` el envoltorio de self-test de `classify`, `:270-346` la escalera
`ladder()`, **`:343-345` el DEFAULT, que NO es PASS**.

### Los 6 pasos, contra servicios DESPLEGADOS, con el agente en `DIDIT_ENV=mock`

```
1. GET  {gateway}/discover/remit-kyc-session      → inputSchema (+ fingerprint)
2. deriveInput(inputSchema)   ← DEL SCHEMA DE ESA CORRIDA. ⛔ Nunca hardcodeado.
                                Falsable: si alguien lo hardcodeara, `deriveInput` dejaría de leer
                                su argumento y el caso `enum → primer valor` de la suite se pone rojo.
3. POST {gateway}/compose  { steps:[{ agent:"remit-kyc-session", input: <derivado> }] }
        assert: success === true
                steps.length === 1
                steps[0].agent.slug === "remit-kyc-session"
                steps[0].agent.registry === "self-published"
                steps[0].bridgeType AUSENTE
                output = { sessionId, url, decisionToken, provenance }   ← exactamente 4 claves
4. GET  {gateway}/discover/remit-kyc-decision     → inputSchema
        assert de DRIFT: required ⊆ { sessionId, identityClaim, decisionToken }
        ⚠️ ESTE STEP NO SE DERIVA CIEGAMENTE: su input es una CREDENCIAL emitida en el paso 3.
           Derivar `decisionToken: "x-decisionToken"` sólo probaría que el 401 funciona.
           Lo que se deriva es el CONJUNTO DE CLAVES; los VALORES vienen del paso 3.
           Si el catálogo pide una clave que la sonda no sabe llenar ⇒ exit DRIFT, NO un verde.
5. POST {gateway}/compose  { steps:[{ agent:"remit-kyc-decision",
                                      input:{ sessionId, decisionToken, identityClaim:<addr de prueba> } }] }
        assert: las claves del contrato, CRUZADAS contra el `outputSchema` publicado
                (mismo criterio que `probe-money-path.mjs:225-236`: si el catálogo ya no declara
                 el campo, es DRIFT y no un verde)
        assert: el mismo par (slug, registry) del paso 3, con el slug de decisión
6. self-test OPT-IN: repetir el paso 3 SIN una clave requerida ⇒ tiene que ser RECHAZADO.
        ⚠️ Si la clave que se pidió romper NO estaba en el cuerpo derivado ⇒ exit CONFIG, no PASS.
           Molde exacto: `probe-money-path.mjs:250-263`. Sin eso, un typo compra un hallazgo FABRICADO.
```

### Exit codes — ≥6, cada uno atribuye la causa

| code | Significado |
|---|---|
| `0` | **PASS** |
| `1` | excepción no manejada — **defecto de la sonda** |
| `2` | **caída candidata de producción** (5xx, timeout, DNS, `AGENT_ERROR`) |
| `3` | **config de la sonda** (envs, credencial, saldo, `INSUFFICIENT_BUDGET`) |
| `4` | **drift de contrato** (schema / claves / `outputSchema` cambiaron) |
| `5` | **se ACEPTÓ un cuerpo inválido** (el self-test no fue rechazado) |
| `6` | **SUPLANTACIÓN**: el ejecutor no fue el `(slug, self-published)` esperado |

🔴 **CD-15 — la escalera es PURA, vive en `smoke-kyc-helpers.ts`, tiene su `.test.ts`, y su fila por
defecto NO es PASS.** El precedente está escrito: *"El DEFAULT de una escalera de monitoreo era PASS"*.
El molde es `probe-money-path.mjs:343-345`:

```js
  // 12 — el default, y NO es PASS: la única clase que jamás debe alcanzarse por omisión no puede
  // ser la que dice que todo anda. Un camino que nadie previó sale ruidoso.
  return verdict('DOWN', 2, '...');
```

⛔ **Nunca imprime la credencial, ni truncada.** Ni el `decisionToken`, ni la Agent Key, ni la URL con
el `sessionId`.

### T-C12 — los tests de los helpers

| id | AC | Qué afirma | 🧬 Mutante |
|---|---|---|---|
| **T-C12** | AC-13 | `deriveInput` **deriva de su ARGUMENTO** (caso `enum → primer valor`, caso `required no derivable → reason`); `classify` **no** devuelve PASS en su fila por defecto; `assertExecutor` rechaza `null`, slug distinto, registry distinto y registry ausente | hardcodear el input ⇒ el caso del `enum` se pone rojo. `default: PASS` ⇒ rojo |

### ✅ Criterio de terminado de W4 (ejecutable)

```
cd /home/ferdev/.openclaw/workspace/chaski-v3
/usr/bin/git add -A                       # ⛔ CD-17
# G-7 otra vez: +1 archivo de test ⇒ re-medir y actualizar los DOS README
npm run qa && npm run build

# La corrida real contra W1/W2 desplegados, con el agente en DIDIT_ENV=mock:
npm run smoke:kyc-gateway ; echo "exit=$?"
```

**Exit 0 ES el AC.** Guardá la salida completa: es la evidencia de AC-13.

---

## W5 — Cutover (OPS, sin diff de git)

**Paso 5.** `KYC_TRANSPORT=gateway` en **preview** → **corrida real de Didit hecha por el founder**,
con un **desembolso verificado de punta a punta** (AC-14).

- **AC-14 no es un test: es una precondición humana.** La evidencia para F4 es la corrida del founder
  con **el hash del desembolso y la fecha**, anotada en el reporte de cierre.
- **Medir latencia antes y después** (R-4). Prestá atención al techo de **10 s** de
  `runViaGateway` (`gateway-client.ts:335`), que es **más chico** que los 180 s de `/compose`.
- **Verificar R-2**: que ningún log del Coordinador contiene el `decisionToken`.
- **Verificar R-3**: la agent key de Chaski tiene saldo **en la red de `WASIAI_A2A_PAYMENT_CHAIN`**
  (el saldo es **por red**). A 0.02 USDC por step, **cada autorización de desembolso pasa a costar**.

**Paso 6.** `KYC_TRANSPORT=gateway` en **producción**. Observar.

- **Rollback = borrar la env `KYC_TRANSPORT`.** Sin redeploy.
- ⛔ **NUNCA rotar `KYC_DECISION_TOKEN_SECRET`** (`src/infrastructure/kyc/agent-env.ts:27-29`).
- ⚠️ **Bloquea el paso 6** (no F3): la decisión de producto del founder sobre el **precio relativo**
  `remit-kyc-session` vs. `remit-kyc-decision`. El default de este corte es **0.02 USDC las dos**.

---

## W6 — FUERA DE ESTE CORTE (HU de seguimiento, DT-15)

**No se implementa ahora. Se menciona para que nadie lo empiece por error.**

- **Paso 7**: borrar el transporte directo + el guard de residuo de **AC-15 completo**.
- **Paso 8**: deprecar la fila `/invoke` del catálogo.

**Por qué no entra**: el guard de residuo de AC-15 afirma *"no existe `fetch` directo al agente en
producción"*, y **mientras `KYC_TRANSPORT` tenga default `direct` esa afirmación es FALSA POR DISEÑO**.
Mergearlo ahora lo dejaría rojo o —peor— lo obligaría a nacer con una excepción que lo vacía.

**Lo que sí entra ahora** son los candados que **ya pueden ser ciertos**: T-KGS-1/2/3 (W3-C5).

**AC-15 ya está diseñado** (para la HU de seguimiento): guard estático en
`src/composition/kyc-direct-transport-residue.static.test.ts`, molde
`agent-slug-residue.static.test.ts:100-112`, buscando (i) la subcadena del path del agente,
(ii) `kycAgentUrl`, (iii) `resolveKycAgentBaseUrl`. **No puede leerse a sí mismo** porque
`path.resolve(full) !== SELF` lo excluye del conjunto escaneado. Se merguea **el mismo día** que se
borran `agent-kyc-client.ts` y `agent-env.ts`, no antes.

---

## 9. Anti-Hallucination Checklist — específico de esta HU

Marcá cada uno **antes de cerrar la wave que lo contiene**.

### Global

- [ ] Las 3 branches existen, con los nombres exactos de §2.
- [ ] Ningún archivo de las **P-A..P-J** de §0 aparece en `/usr/bin/git diff --stat main` de su repo.
- [ ] `/usr/bin/git diff main -- src/infrastructure/kyc/agent-env.ts` en C sale **vacío**.
- [ ] Ninguna suite corrió en paralelo con otra.
- [ ] Todo símbolo de librería externa que usaste está verificado contra la **versión instalada**
      (Zod en A es **3.25.76**), no contra el `^` del `package.json`.

### Repo A

- [ ] `runKycSession`, `runKycDecision`, `isStatusPayoutAllowed` y `KycSessionInputSchema` tienen
      **cero diff** — sólo se agregaron dos `export const`.
- [ ] `DiditKycProvider` tiene **cero diff**.
- [ ] `/api/agents/remit-kyc-validator/{invoke,session,decision}/route.ts` tienen **cero diff**.
- [ ] `guardInvokeAuth` (`src/auth/invoke-auth.ts:202-214`) tiene **cero diff** — sólo cambió la
      prosa de `:43` (3 → 5).
- [ ] Los dos `manifest/route.ts` nuevos difieren del exemplar **sólo en la línea del `PATH_SLUG`**.
- [ ] Los dos endpoints devuelven **`{ result: … }`**, no el objeto pelado.
- [ ] `input-schema-drift.test.ts` cubre los 2 `pathSlug` nuevos y **pasa** (⇒ la ficha publicada
      coincide con el Zod que el agente ejecuta de verdad).
- [ ] Las citas `archivo:línea` que escribiste en A están **re-derivadas a mano** — este repo **no
      tiene candado de citas** (CD-13).

### Repo B

- [ ] `AUTHORIZATION_CAPABILITIES` contiene **exactamente 2** entradas y **ninguna preexistente**
      (T-B2 lo mide contra la lista literal de 15).
- [ ] `capability-risk.ts` sigue siendo **LEAF** (cero imports de runtime).
- [ ] `compose-step-shape.ts` importa **sólo** de otros leafs.
- [ ] El guard se cablea **dentro de `validateComposeBody`**, no en el route handler
      (T-B8 lo mide con el contador de débito).
- [ ] `capability-resolver.ts`, `discovery.ts` y `services/compose.ts` tienen **cero diff**.
- [ ] Ninguna clave nueva en `ALLOWED_STEP_CONSTRAINTS` ni en `ComposeStepConstraints`.
- [ ] **T-B4 demuestra que el impostor gana el ranking DE VERDAD.** Si diera "no candidates", T-B3
      no vale — parás y avisás.
- [ ] Las citas nuevas pasan `test/cited-lines-guard.test.ts`.

### Repo C

- [ ] Los 3 call sites cambian **sólo el especificador del import**. Las llamadas
      (`session/route.ts:375`, `decision/route.ts:89`, `authority.ts:180`) **no cambian de forma**.
- [ ] Los cuerpos de `createAgentKycSessionDirect` / `readAgentKycDecisionDirect` tienen **cero diff**
      — sólo el nombre del export.
- [ ] El transporte `gateway` emite **`agent`, nunca `capability`**, y **un solo step**.
- [ ] El transporte `gateway` usa **los mismos** `readString`/`readBoolean`/`readRiskLevel` y **los
      mismos** códigos `kyc_agent_bad_response:<rama>:<campo>` que el directo.
- [ ] `identityMatches` se preserva **AUSENTE**. Ningún `?? false` en ninguna línea nueva.
- [ ] `identityRef` / `identityClaim` ausentes ⇒ **la clave se omite** del body. Ningún `?? null`.
- [ ] La escalera de fallo se escribe `if (todo-ok) return ok; return fail;`. **Ningún `default: ok`.**
- [ ] El bloque `agent-slug-residue.static.test.ts:32-63` está **REESCRITO** (no ampliado), con la
      fecha y la HU.
- [ ] La cabecera de `gateway-client.ts:1-6` está **reescrita**: ya no afirma sin excepción que el
      cliente "NO resuelve el agente por nombre".
- [ ] `gateway-kyc-client.ts` **no se importa** desde `src/presentation/**` ni desde `container.ts`
      (CD-20).
- [ ] Los **DOS README** tienen el conteo de archivos de test **medido**, no estimado (G-7).
- [ ] Las citas nuevas están en formato anclado ``(`símbolo`, `ruta/archivo.ts:NN`)`` y pasan
      `src/composition/citas-ancladas.test.ts`.

---

## 10. Done Definition

La HU está **lista para AR** cuando **todo** esto es cierto:

1. **Los 3 gates completos, en su orden real, en verde**, corridos **de a uno** (§2). Con la salida
   citada.
2. **W1 desplegado y verificado**: los dos `/manifest` dan **200**, y `/invoke` del validador viejo
   sigue vivo y sin cambios.
3. **W2 desplegado y verificado**: los dos `GET /discover/<slug>` con el JSON guardado —`invokeUrl`
   a los endpoints nuevos y `inputSchema.required` **sin `legalId`** (evidencia de AC-5).
4. **W3 desplegado con `KYC_TRANSPORT` AUSENTE**, y T-C1/T-C2 demostrando **cero cambio observable**.
5. **W4: `npm run smoke:kyc-gateway` sale 0** contra los servicios desplegados, con el agente en
   `DIDIT_ENV=mock`. La salida completa guardada.
6. **Cada test de las tablas se rompió a propósito una vez**, con su mutante y su rojo citados
   (CD-8). Especialmente **T-B3/T-B4** (sin el control positivo, T-B3 es teatro) y **T-C5** (borrar el
   chequeo de slug tiene que **autorizar un desembolso**).
7. **El presupuesto de diff está MEDIDO** con `/usr/bin/git diff --stat main` en los 3 repos, y
   escrito (CD-16). Un exceso >2x se justifica **por escrito** o se recorta.
   - A: 450–800 · B: 150–400 de código + OPS · C: 800–1400
8. **`auto-blindaje.md`** escrito con los mutantes, los rojos, y **las 8 divergencias de §8** con lo
   que se hizo en cada una.
9. **Todo archivo nuevo tiene `git add`** (CD-17).
10. **W5 y W6 NO se ejecutaron.** W5 es OPS del founder; W6 es otra HU.

---

## 11. Lo que este Story File NO puede afirmar

Escrito para que nadie lo lea como si estuviera cerrado.

1. **Quién compone KYC por capacidad hoy, fuera de este ecosistema.** No es observable desde los
   repos. Por eso `AUTHORIZATION_CAPABILITIES` arranca con **sólo las dos nuevas** (CD-18) y el
   residual **R-1** queda **declarado y NO cerrado**: un tercero que componga
   `capability:'kyc-verification'` sigue expuesto a la suplantación. **Chaski queda protegido** porque
   pinea; **el agujero general no lo cierra esta HU.**
2. **Si la fila viva de `remit-kyc-validator` declara hoy `kyc-hosted-redirect` en el catálogo.** El
   manifiesto de A la declara, pero la fila del Coordinador es **una copia manual** y puede estar
   atrasada (R-6). No afecta el diseño; **W2-OPS tiene que leerlo, no asumirlo.**
3. **Que el pin por slug proteja el GASTO.** N3 es **post-hoc**: el débito ya ocurrió cuando se
   verifica el ejecutor. Protege la **autorización**, no el dinero del step.
4. **Que `payoutAllowed === true` exija una identidad coincidente.** Eso lo sostiene **el agente, en
   otro repo**. `authority.ts:204-209` lo dice textual y va con su advertencia: *"Si el agente
   aflojara ese criterio, acá no se pondría rojo nada y este `return` autorizaría un desembolso sin
   identidad comprobada."* **Esta HU no cambia eso ni lo cierra**, y ⛔ **está prohibido reescribir
   ese párrafo como si la garantía estuviera cerrada de este lado.**
