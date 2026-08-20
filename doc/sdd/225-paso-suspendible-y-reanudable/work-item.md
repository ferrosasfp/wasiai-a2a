# Work Item — [WKH-PENDIENTE] El Coordinador orquesta un paso que espera a una persona: suspender y reanudar

> ⚠️ **CÓMO LEER LAS CITAS DE ESTE DOCUMENTO.** Este F1 corrió **sin shell**: las únicas
> herramientas disponibles fueron `Read`, `Write` y `Glob`. **No se pudo correr `grep`, `git`,
> `rg` ni ninguna suite.** Por lo tanto:
>
> - **[MEDIDO]** = abrí el archivo y leí la línea. Es lo que sostiene la afirmación.
> - **[HEREDADO]** = viene del encargo del orquestador, que lo midió con shell. No lo re-verifiqué.
> - **[NO MEDIDO]** = no pude comprobarlo con las herramientas que tuve. **No lo trates como cierto.**
>
> ⛔ **Todo conteo exhaustivo de este documento es [NO MEDIDO]**: sin `grep` no existe barrido
> exhaustivo, y un conteo hecho leyendo archivos a mano es una cota inferior, nunca un total.
> Donde digo "N consumidores" leelo como **"al menos N, medidos uno por uno"**.

---

## Resumen

Que un paso del pipeline del Coordinador pueda **suspenderse** —devolver un enlace y quedar
esperando a una persona— y **reanudarse después**, en vez de tener que terminar dentro del mismo
pedido HTTP.

Existe porque hoy hay **una excepción viva a la arquitectura del founder** (*"El Coordinador debe
ser el que descubre, orquesta y paga los agentes"*): Chaski le habla **directo** al agente de
identidad, salteándose al Coordinador, porque el manifiesto de ese agente publica
`kyc-hosted-redirect` — un flujo con redirección del navegador y una persona en el medio — y el
modelo de pedido-respuesta de `/compose` no lo expresa. **Consecuencia de negocio, no técnica: ese
agente se consume GRATIS**, fuera del carril de pago, y por lo tanto la frase del pitch
("descubre, orquesta **y paga**") lleva hoy un asterisco.

⛔ **Lo que esta HU NO puede decir, y se escribe para que nadie lo escriba después:**
**PROHIBIDO afirmar que "esto ya funciona porque el pipeline existe".** Lo que existe es todo
**menos** el estado suspendido. Ese estado es el trabajo.

---

## Sizing

- **SDD_MODE: `full`**
- **Modo del pipeline propuesto: QUALITY — y NO por herencia.** El CLAUDE.md dice que este repo es
  siempre QUALITY; igual lo evalué contra el trabajo concreto y **coincide**, por tres señales que
  no dependen de la regla del repo:
  1. **Toca el camino del dinero.** El desenlace nuevo se decide en el mismo bucle que hace el
     débito per-step (`src/services/compose.ts:571-655`) y a milímetros del guard `i > 0`, que es
     *"la ÚNICA defensa contra double-debit del step 0"* (`compose.ts:546-550`, CD-11 de WKH-59).
  2. **Introduce estado durable nuevo** en una base que **también sirve producción**
     (`.nexus/project-context.md:97-110`: bdwv es "dev" y "prod" a la vez).
  3. **Introduce una credencial reanudable.** Un token de reanudación mal hecho = ejecutar el
     pipeline de otro, o ejecutar dos veces el mismo (dos débitos reales).
- **Variante propuesta sobre QUALITY (no es el QUALITY genérico):** el AR tiene **dos focos
  obligatorios declarados desde ya**, porque son los dos vectores que este diseño estrena:
  **(a) doble ejecución por replay del token de reanudación**; **(b) el reloj** — ver DT-6.
- **Estimación: L.** Y **PARTIDA en dos cortes**, ver "Cortes".
- **Branch sugerido: `feat/225-paso-suspendible-y-reanudable`**
  🔴 **[NO MEDIDO]** — no pude correr `git rev-parse --abbrev-ref HEAD` ni `git branch`. **El
  nombre es una propuesta, no una rama verificada.** El F2/F3 la crea y la confirma. (Este repo ya
  tiene el antecedente de una fila del índice que nombró una rama existente-pero-vacía y quien
  verificaba confirmó la mentira; ver `doc/sdd/224-.../_INDEX-row.md`.)

### Cortes

| Corte | Ítems del checklist | Repos | Por qué corta acá |
|---|---|---|---|
| **A** | 1, 2, 3, 4, 5 (+ 6 parcial: la clasificación en código) | `wasiai-a2a` únicamente | Es el estado nuevo, y es autocontenido: se puede probar de punta a punta contra el agente sin tocar Chaski. |
| **B** | 6 (la acción de OPS), 7, 8 | `chaski-v3` + `wasiai-remittance-agents` + republicación en bdwv | Es la **consecuencia**, y tiene un bloqueante propio que hoy NO está resuelto (ver "Bloqueante del corte B"). |

⚠️ **El corte A no hace verdadera la frase del pitch por sí solo.** Entrega la capacidad; la frase
la hace verdadera el corte B. Decirlo al revés sería exactamente la prosa que afirma de más.

---

## Veredicto sobre los 8 ítems del checklist del founder

| # | Ítem | Veredicto | Evidencia |
|---|---|---|---|
| 1 | Desenlace `suspendido` de un paso | **CHICO en el service, MEDIANO en el contrato** | El punto donde se decide es UNO (el `try` de `compose.ts:698-733`). Lo que no es chico es el TIPO: `ComposeResult.success` es un **`boolean`** (`src/types/index.ts:1181`), no un enum de 3 estados, y `errorCode` es una unión CERRADA de 5 strings (`:1207-1212`). |
| 2 | Endpoint de reanudación | **CHICO** | Es una ruta nueva. El patrón de "el cliente vuelve con un artefacto firmado" ya está construido y probado: `POST /orchestrate/execute` con `quote` (`src/routes/orchestrate.ts:60-65`, `services/orchestrate-quote.ts`). |
| 3 | Estado del pipeline entre llamadas | **MEDIANO — y es el corazón** | Hoy TODO el estado vive en variables locales de `executePipeline` (ver "Dónde vive hoy el estado"). No hay Redis en este servicio (`project-context.md:86-87`, `:597`). ⇒ tabla nueva en **bdwv**. |
| 4 | Firmar lo que el cliente devuelve | **CHICO — hay exemplar completo** | `services/orchestrate-quote.ts` es HMAC-SHA256, binding a la credencial EXACTA, orden de validación load-bearing (firma ANTES de leer el payload, `:331-343`), `timingSafeEqual`, fail-closed sin secreto. **PERO no se copia tal cual**: ver DT-4 (el quote es multi-redimible A PROPÓSITO; un resume NO puede serlo). |
| 5 | Vencimiento + qué pasa con lo cobrado | **MEDIANO, y con un techo que NO es libre** | `lib/stranded-payment.ts` ya modela el residuo, pero el TTL choca contra una cota ya derivada del repo. Ver DT-6, que es el hallazgo más caro de este F1. |
| 6 | Que el Coordinador entienda `kyc-hosted-redirect` | **CHICO en código, con una ACCIÓN DE OPS que se olvida sola** | La ficha del catálogo del gateway es una **COPIA MANUAL** del manifiesto del agente y **nada la sincroniza** (`wasiai-remittance-agents/src/manifest/registry.ts:36-42`, textual). Sin republicar en bdwv, `/discover` **no ve** la capacidad. |
| 7 | Que Chaski deje de llamar directo | **GRANDE, y NO es una sola llamada** | Son **tres** momentos distintos, y sólo dos son "un paso del pipeline". El tercero (`resolvePayoutAuthority`) corre en OTRO request, mucho después, sin pipeline. Ver "Ítem 7 en detalle". |
| 8 | Que el agente cobre por ese paso | **BLOQUEADO por el corte B, y no por falta de ganas** | El único endpoint del agente alcanzable por `/compose` es el `POST /invoke` **DEPRECADO**, que *"MANDA EL DOCUMENTO (legalId) POR LA RED en cada llamada"* (`registry.ts:63-64`, textual). Cobrar por ahí sería cobrar por el camino que el hosted-redirect existe para eliminar. |

**Resumen del veredicto:** los ítems **1, 2, 4 y 6-código son chicos**; **3 y 5 son medianos y
son el corazón**; **7 y 8 son grandes y arrastran un bloqueante que hay que decidir antes de
empezarlos**.

---

## Lo que YA existe (verificado por mí, salvo lo marcado)

| Hecho | Cita | Estado |
|---|---|---|
| `MAX_COMPOSE_STEPS = 5` | `src/lib/compose-limits.ts:38` | **[MEDIDO]** |
| Ese 5 está **derivado**, no repetido: alimenta el factor de wall-clock del dedup de settles Solana | `compose-limits.ts:11-27` y `:32-37` (docblock: *"`MAX × 300 s`"*) | **[MEDIDO]** (el docblock; el literal en `adapters/solana/payment.ts` es **[NO MEDIDO]**) |
| `/orchestrate` YA es de dos fases con cotización firmada que el cliente reenvía | `src/routes/orchestrate.ts:46-65`; `services/orchestrate-quote.ts` completo | **[MEDIDO]** |
| Ya se razona sobre pagos varados a mitad de pipeline | `src/lib/stranded-payment.ts` completo; `MAX_STRANDABLE_STEPS` en `:58` | **[MEDIDO]** |
| Existe un exemplar de **estado durable con máquina de estados, token hasheado, vencimiento y claim atómico por RPC** | `AgentLinkRow` en `src/types/index.ts:1610-1627` (`status: 'open'\|'redeeming'\|'redeemed'\|'failed'`, `token_hash`, `owner_ref`, `expires_at`); `AgentLinkClaim` en `:1671-1679` (*"Fila del link devuelta por el RPC `claim_agent_link` (open→redeeming)"*) | **[MEDIDO]** — 🎯 **este es el hallazgo que abarata el ítem 3+4** |
| El estándar A2A ya nombra este estado: `input-required` (human-in-the-loop) | `.nexus/project-context.md:369-371` | **[MEDIDO]** (en el doc; los miembros exactos de `TaskState` en código son **[NO MEDIDO]**) |
| `tasks` tiene `owner_ref` NOT NULL + RLS en prod | `src/services/task.ts:19-22` + `CLAUDE.md` | **[MEDIDO]** en código. ⚠️ Contradice una nota de memoria del proyecto (`tasks-owner-ref-missing.md`). **Yo no consulté la base.** |
| NO existe ningún concepto de paso suspendible (cero `resume`/`pending`/`redirect`/`continuation`), con control positivo de 50 sobre `steps` | barrido del orquestador | **[HEREDADO]** — pero **corroborado indirectamente**: leí `ComposeResult` (`types/index.ts:1180-1263`) y `StepResult` (`:1265-1358`) **completos** y **ninguno tiene un campo de suspensión, pendiente ni continuación**. |
| El agente publica los dos modos | `wasiai-remittance-agents/src/manifest/registry.ts:65-78` (`kyc-hosted-redirect` y `legacy-single-shot-kyc`) | **[MEDIDO]** |

---

## Dónde vive HOY el estado de un pipeline en vuelo

**[MEDIDO] leyendo `src/services/compose.ts:205-243` y `:313-372`.** Vive **entero en memoria,
dentro del scope de una función, durante un único request HTTP**. Nada es durable:

| Qué | Dónde vive hoy | Cita |
|---|---|---|
| id del run | `const composeRunId = randomUUID()` — variable local de `compose()` | `compose.ts:216` |
| resultados de los steps ya completados | `const results: StepResult[] = []` — declarado por la envoltura y **PRESTADO** al pipeline | `compose.ts:227` + `:313-320` |
| costo y latencia acumulados | `let totalCost = 0; let totalLatency = 0` | `compose.ts:368-369` |
| **la salida del step anterior** (lo que el siguiente step necesita) | `let lastOutput: unknown = null` | `compose.ts:370` |
| pool de agentes descubierto | `const discoverCache = createDiscoverCache()` | `compose.ts:372` |
| identidad propia del gateway (anti-bucle) | `const selfIdentity = resolveSelfHosts(selfHostHint)` | `compose.ts:358` |
| precios congelados del quote | `frozenStepPricesUsd`, desestructurado del `request` | `compose.ts:335` |

**Lo único que sobrevive al request son EVENTOS de telemetría** (`a2a_events` vía
`eventService.track`), y son **fire-and-forget por diseño**: `compose.ts:250-253` dice textual que
si `track` rechaza *"el caller recibe EL MISMO `ComposeResult`"*. ⛔ **PROHIBIDO usar `a2a_events`
como almacén de reanudación**: es una superficie que se declara best-effort en tres docblocks
distintos, y reanudar desde algo best-effort es perder pipelines en silencio.

**Qué haría falta para persistirlo:** una tabla nueva. Este servicio **no tiene Redis ni BullMQ**
(`project-context.md:86-87`; *"`REDIS_URL` no se lee en ningún archivo de `src/`"*, `:597`), y el
repo ya rechazó por escrito la alternativa en memoria: `orchestrate-quote.ts:23-24` dice
🔴 *"PROHIBIDO 'mitigar un poco' con un anti-replay en memoria del proceso: sería estado no
durable, inconsistente entre instancias e invisible en el contrato"*.

⚠️ **Hay un antecedente que documenta este mismo callejón y cómo se salió de él:**
`routes/compose.ts:236-238` dice que congelar el precio *"requiere almacenamiento durable entre
requests […] así que está pendiente de una decisión de storage"* — y WKH-303 lo resolvió **sin
storage**, con un token HMAC autocontenido. **Ese truco NO se puede repetir acá** y el motivo es
DT-4: un quote se puede redimir N veces sin daño; un resume, no.

🔴 **La tabla va a bdwv. ⛔ NUNCA a caldz (mainnet, congelada).** Regla del founder, textual:
*"la migracion aun no debe hacerse a caldz, siempre a bdwv"* (`project-context.md:100`).

---

## ¿El pago de un paso suspendido es un caso de `stranded-payment` o uno nuevo?

**Es LAS DOS COSAS, en dos momentos distintos, y confundirlas rompe una métrica de producción.**

1. **Mientras está suspendido: NO es stranded.** `stranded-payment.ts:1-10` define el residuo como
   *"el pipeline falló a mitad de camino y la plata que YA salió no vuelve"*, y `:50-51` aclara que
   ahí sólo entran *"los steps que completaron"* de un pipeline **fallido**. Un pipeline suspendido
   **no falló**: está esperando. La plata de los steps 0..i-1 está gastada pero **el caller todavía
   va a recibir el pipeline que pagó**.

2. **Si nadie vuelve y el run vence: SÍ es exactamente un stranded.** Los steps 0..i-1 se pagaron
   on-chain, el pipeline no va a entregar, y la tx está minada. Es la definición literal.

🔴 **Y de acá sale un BLOQUEANTE de diseño, medido:**
`compose.ts:230` hace `if (!result.success) this.recordStrandedRunIfAny(composeRunId, result)`.
⇒ **si la suspensión se modela como `success: false`, CADA suspensión emite un evento
`compose_stranded_payment`**. Consecuencias medidas, no hipotéticas:

- `services/stranded-alert.ts:229-259` suma esos eventos en una ventana de 60 min y, al pasar el
  umbral, publica `strandedExposureBreached` en `/health` — que el health-monitor lee como
  `degradedPath` (`stranded-alert.ts:5-9`).
- ⇒ un flujo de KYC **funcionando normalmente** haría sonar la alerta de "plata varada creciendo".
  El canal de alerta se vuelve ruido, que es el daño que ese mismo archivo declara combatir
  (`:288-290`: *"un canal que grita siempre es un canal que se aprende a ignorar"*).

**⇒ CD-2 (abajo) no es preferencia de estilo: es la protección de una alerta de producción.**

---

## Ítem 7 en detalle — qué se saca y qué NO se puede perder

WKH-233 (desplegada, con AR pasado) hizo que Chaski le hable **directo** al agente de identidad.
Leí sus tres archivos centrales. **No es una llamada: son tres momentos**, y sólo dos son "un paso
de pipeline".

| # | Momento | Dónde | ¿Es un step del pipeline? |
|---|---|---|---|
| 1 | `POST /session` → devuelve `sessionId`, `url` (la pantalla del proveedor) y `decisionToken` | `chaski-v3/src/infrastructure/kyc/agent-kyc-client.ts:103-145` | **SÍ** — es exactamente el paso que suspende |
| 2 | `GET /decision` → el veredicto | `agent-kyc-client.ts:158-210` | **SÍ** — es exactamente la reanudación |
| 3 | **Re-consulta EN EL MOMENTO DEL DINERO** | `chaski-v3/src/infrastructure/payout/authority.ts:73-208`, llamada desde `app/api/payout/prepare/route.ts` | 🔴 **NO.** Otro request, mucho después, sin pipeline |

### 🔴 Bloqueante del corte B (hay que decidirlo ANTES de empezar el ítem 7)

`resolvePayoutAuthority` **Guard 3** (`authority.ts:117-161`) exige una fila de
`kyc_session_tokens` para conseguir el `decisionToken`, y esa tabla la puebla **únicamente**
`app/api/kyc/session/route.ts` cuando Chaski crea la sesión **contra el agente**
(`chaski-v3/supabase/migrations/20260819T000000_add_kyc_session_tokens.sql:44-50`).

⇒ **si el `POST /session` pasa a hacerlo el Coordinador, el `decisionToken` se lo devuelve el
agente AL COORDINADOR, y Chaski se queda sin fila** ⇒ `kyc_ownership_mismatch` ⇒
`payout_not_authorized`/403 **en todos los desembolsos**. La misma migración documenta que ni
siquiera hay rescate: *"No hay rescate automatico. Hay que re-verificarse."* (`:55`).

**Dos salidas, y el F2 tiene que elegir una explícitamente:**
- **(a)** el artefacto de suspensión que el Coordinador le devuelve a Chaski **incluye** el
  `decisionToken`, y Chaski escribe su fila como hoy ⇒ `authority.ts` y `prepare/route.ts` quedan
  con **cero diff**, y los 7 controles de abajo se preservan tal cual. **Costo declarado:** el
  Coordinador se vuelve punto de tránsito de una credencial bearer del money-path.
- **(b)** el Coordinador guarda el token y expone la re-autorización ⇒ es **el momento 3**, o sea
  el que este work-item deja fuera de alcance. **No se elige por default.**

### ⛔ Los 7 controles de WKH-233 que NO se pueden perder (PROHIBIDO negociarlos)

Todos **[MEDIDO]**:

1. **`decisionToken` sólo en la cabecera `x-kyc-decision-token`** — nunca en URL, query ni log
   (`agent-kyc-client.ts:150-153`, CD-4). El query string queda en el access log del hosting.
2. **`x-kyc-token` (HMAC de sesión de Chaski)** — es OTRO secreto, de OTRO repo, y `:25-27` prohíbe
   explícitamente confundirlos (`kyc-auth.ts:20-33`, `timingSafeEqual`, longitud primero).
3. **Filtrado por dueño en el money-path: `getForOwner`, JAMÁS `readForVerifiedSession`**
   (`authority.ts:31-34`, CD-19; candado mecánico G-5 en
   `src/composition/kyc-provider-residue.static.test.ts`).
4. **`owner_address` NULLABLE que REFUERZA el guard**: un `.eq` nunca matchea un NULL ⇒ una sesión
   sin atar jamás autoriza un desembolso, por construcción de la query
   (`…add_kyc_session_tokens.sql:114-124`). ⛔ *"NO lo 'arregles' poniendolo NOT NULL"*.
5. **El gate es `payoutAllowed === true` ESTRICTO y nada más** (`authority.ts:180-185`).
   ⛔ Textual: *"PROHIBIDO agregarle un `|| esDemo()`, un `?? true`, o una recomposición con
   `approved && identityMatches`"*. Y `!== true` estricto porque el string `"true"` es truthy.
6. **`identityMatches` se preserva AUSENTE** cuando no se preguntó
   (`agent-kyc-client.ts:203-208`). ⛔ *"PROHIBIDO `identityMatches: raw.identityMatches ?? false`"*:
   ausente = defecto nuestro; `false` = una acusación sobre la persona.
7. **Logs value-free y frontera server-only** (`agent-kyc-client.ts:1-12`, CD-10/CD-15): sólo la
   etiqueta de rama, el `err.name` y el status. ⛔ Nunca el `message` (trae la URL, que trae el
   `sessionId`).

⛔ **PROHIBIDO proponer que se pierda cualquiera de los 7 para simplificar el camino.** Si el
diseño del F2 no puede preservarlos todos, el veredicto correcto es **no hacer el ítem 7 todavía**,
no aflojar uno.

---

## Acceptance Criteria (EARS)

**AC-1** — WHEN el agente de un step devuelve el desenlace de suspensión, the system SHALL detener
el pipeline **sin** marcar `ComposeResult.success = false` y **sin** emitir ningún evento
`compose_stranded_payment`.

**AC-2** — WHEN un pipeline se suspende, the system SHALL persistir en **bdwv** el estado mínimo
para reanudar (índice del step, `composeRunId`, la salida del step anterior, los `StepResult` ya
completados, el `owner_ref` del caller, la credencial exacta a la que queda atado, los precios ya
debitados y el `expires_at`) y SHALL devolver al caller el artefacto del agente (la URL) más un
identificador de reanudación.

**AC-3** — WHILE un pipeline está suspendido, the system SHALL NOT debitar, settlear, reembolsar ni
invocar nada correspondiente a los steps posteriores al suspendido.

**AC-4** — WHEN llega un pedido de reanudación, the system SHALL verificar la firma HMAC **antes**
de leer cualquier campo del payload, y SHALL rechazar con `RESUME_INVALID` sin tocar la base cuando
la firma no verifique. *(Orden load-bearing, exemplar `orchestrate-quote.ts:331-343`.)*

**AC-5** — IF el identificador de reanudación ya fue redimido, THEN the system SHALL responder
`RESUME_ALREADY_USED` y SHALL NOT ejecutar ningún step ni mover un centavo. *(La redención es
**single-use** y su atomicidad vive en la base, no en el proceso — DT-4.)*

**AC-6** — IF el `owner_ref` del caller que reanuda no es el del run suspendido, THEN the system
SHALL responder **404** (no 403): tratar el cross-owner como "no encontrado" es el patrón ya
escrito de este repo (`types/index.ts:392-394`, *"404 disclosure-safe"*).

**AC-7** — IF el run suspendido está vencido, THEN the system SHALL responder `RESUME_EXPIRED`, SHALL
dejar el run en un estado terminal, y —**sólo si algún step ya dejó evidencia de pago on-chain**—
SHALL emitir **exactamente un** evento `compose_stranded_payment` con los steps 0..i-1.

**AC-8** — WHEN la reanudación es válida, the system SHALL continuar desde el step siguiente usando
las salidas persistidas, SHALL NOT re-invocar ni re-debitar ningún step 0..i, y SHALL devolver un
`ComposeResult` cuyos `steps` incluyan los completados antes de la suspensión.

**AC-9** — WHERE la bandera de la feature esté ausente, vacía o distinta del literal `'true'`, the
system SHALL comportarse **exactamente como hoy**: cero filas nuevas, cero queries nuevas, cero
claves nuevas en la respuesta. *(Convención obligatoria del repo: `project-context.md:252-268`.)*

**AC-10** — the system SHALL clasificar explícitamente `kyc-hosted-redirect` y
`legacy-single-shot-kyc` en `src/lib/capability-risk.ts`. *(Ver DT-7: hoy caen en
`'unclassified'` y eso **cambia el cupo del carril de estreno** del agente de KYC.)*

**AC-11** — the system SHALL exponer el run suspendido y el run vencido en la superficie de
reconciliación existente, **sin** mezclarlos con la cola `compose_settle_unknown`.
*(`stranded-payment.ts:34-43`, CD-8: son preguntas distintas y mezclarlas corrompe la lista.)*

**AC-12** — WHEN se reanuda un pipeline, the system SHALL aplicar el mismo guard anti-bucle de
contratación sobre los steps restantes que aplica hoy. *(`compose.ts:434-437` dice textual que el
guard es autoritativo **aunque los sitios previos ya hayan pasado**, porque el catálogo cambia entre
el preflight y la ejecución. Una suspensión de horas hace que ese razonamiento sea **más** cierto,
no menos.)*

---

## Scope IN — por repo

### `wasiai-a2a` (corte A)
- `src/services/compose.ts` — el desenlace nuevo en el bucle de steps; la envoltura `compose()`.
- `src/types/index.ts` — `ComposeResult` / `StepResult`; el vocabulario del desenlace.
- `src/routes/compose.ts` — el mapeo del desenlace a HTTP y la interacción con el refund del step-0.
- **Ruta de reanudación nueva** (nombre a decidir en F2).
- **Módulo LEAF nuevo** para firmar/verificar el identificador de reanudación (mismo criterio que
  `orchestrate-quote.ts:26-27`: sólo `node:crypto`).
- **Migración nueva a bdwv** + su `_down.sql` (convención: `project-context.md:403`).
- `src/lib/capability-risk.ts` — AC-10.
- `test/` — incluido lo que exija `test/ownership-filter-guard.test.ts` para la tabla nueva.

### `wasiai-remittance-agents` (corte B)
- Exponer el flujo hosted-redirect por una superficie que el Coordinador pueda invocar.
  ⛔ **NO** reutilizar el `POST /invoke` deprecado (CD-10).

### `chaski-v3` (corte B)
- Reemplazar los momentos 1 y 2 por llamadas al Coordinador.

### Fuera de código
- **Republicar la ficha del agente en bdwv** para que `capabilities` incluya `kyc-hosted-redirect`.
  Es acción de **OPS** y **nada la hace sola**: `registry.ts:36-42` (textual).

---

## Scope OUT — explícito

- ⛔ **El momento 3** (`resolvePayoutAuthority` / `app/api/payout/prepare`). **Cero diff.** Es una
  re-autorización en el instante del dinero, sin pipeline; meterla acá sería mover una credencial
  bearer del money-path de repo en la misma HU que estrena el estado suspendido.
- ⛔ **Subir `MAX_COMPOSE_STEPS`.** `compose-limits.ts:32-37` avisa que subirlo obliga a re-revisar
  la cota de wall-clock.
- ⛔ **Redis / cola / worker.** Este servicio no los tiene y esta HU no los estrena.
- ⛔ **Suspensión en `/orchestrate`.** El corte A la implementa en `/compose`; `/orchestrate` llama a
  `composeService.compose()` directo (`stranded-payment.ts:63-68`) y hereda el comportamiento, pero
  **su superficie de dos fases no se rediseña acá**.
- ⛔ **Retirar el `POST /invoke` del agente.** Tiene consumidores que no controlamos
  (`registry.ts:61-62`).
- ⛔ **Cualquier migración a `caldz`.**
- ⛔ **Mainnet y plata real** (`project-context.md:270-287`).
- ⛔ **La HU que documenta la excepción actual** (decisión del founder: es otra HU).

---

## Decisiones técnicas (DT-N)

**DT-1 — El desenlace suspendido NO es `success: false`.** Es un tercer valor explícito en el
contrato de `ComposeResult`. Alternativa rechazada: `success:false` + `errorCode` nuevo — rechazada
porque dispara `recordStrandedRunIfAny` (`compose.ts:230`) y contamina la alerta de `/health` (ver
la sección del stranded). Alternativa rechazada: un booleano `suspended` al lado de `success` —
rechazada porque deja representable el estado imposible `{success:true, suspended:true}`.

**DT-2 — El nombre del estado se toma del estándar A2A: `input-required`.** No se inventa
vocabulario: `project-context.md:369-371` ya lo lista como el estado human-in-the-loop del
protocolo. **[NEEDS CLARIFICATION en F2]**: si además conviene *reusar la tabla `tasks`* (que ya
tiene `owner_ref` NOT NULL + RLS, `services/task.ts:19-22`) o crear tabla propia. Mi inclinación es
**tabla propia**, porque `tasks` modela el ciclo de vida A2A público y el estado de reanudación
lleva material interno de billing.

**DT-3 — El exemplar del ítem 3 no es el quote: es `a2a_agent_links` (WKH-137).** Ya resuelve, en
producción, exactamente esta forma: fila durable + `token_hash` (nunca el token) + `owner_ref` +
`expires_at` + máquina de estados + **claim atómico por RPC** `claim_agent_link` (open→redeeming)
(`types/index.ts:1610-1627`, `:1671-1679`). El single-use de AC-5 sale de ahí, no de código nuevo.

**DT-4 — El identificador de reanudación se firma como el quote, pero NO se redime como el quote.**
`orchestrate-quote.ts:13-24` acepta A PROPÓSITO que un quote se redima **más de una vez** dentro de
sus 10 minutos, y explica por qué es inofensivo: *"cada redención ejecuta el pipeline de verdad y
debita su propio importe"*. 🔴 **Ese razonamiento NO se transfiere.** Un resume redimido dos veces
ejecuta **dos veces la cola del pipeline** de un caller que pagó una — dos settles reales al agente.
⇒ **se reusa el mecanismo de firma y binding (`computeQuoteBinding`, `resolveQuoteCaller`, el orden
de validación) y se AGREGA el single-use durable de DT-3.** El propio archivo del quote nombra la
salida: *"la forma natural sería la tabla de nonces que ya existe para signed-auth"* (`:21-22`).

**DT-5 — Secreto HMAC propio, sin fallback a ningún otro.** Espeja `CD-5` de WKH-303
(`orchestrate-quote.ts:117-120`): reusar otro secreto acopla dos subsistemas y una filtración de
cualquiera permite forjar los dos. Fail-closed si está ausente.

**DT-6 — 🔴 EL TTL DE LA SUSPENSIÓN NO ES UNA VARIABLE LIBRE. Es el hallazgo más caro de este F1.**
`compose-limits.ts:11-27` documenta que `MAX_COMPOSE_STEPS` alimenta
`ESTIMATED_MAX_RUN_WALL_CLOCK_MS` en `adapters/solana/payment.ts` como `MAX × 300 s`, y que de esa
cota salen **la ventana protegida y el TTL del Map de idempotencia de settles**. El docblock dice
textual el modo de falla: *"una entrada de idempotencia podía expirar mientras su run seguía vivo,
que es exactamente el estado del que ese Map protege"*.
⇒ con `MAX = 5`, la cota estimada de un run es **25 minutos** (`5 × 300 s`) **[derivación MEDIDA
del docblock; el literal en `payment.ts` es NO MEDIDO]**. **Una persona escaneando un documento
tarda más que eso.** Tres caminos, y el F2 elige uno con evidencia:
 - (a) TTL de suspensión que quepa dentro de la cota ⇒ inaceptable para el caso de uso;
 - (b) el reloj **se pausa** mientras el run está suspendido (el run suspendido no cuenta wall-clock);
 - (c) apoyarse en el **ledger durable** `a2a_solana_settle_intents` (WKH-307), que `compose.ts:213`
   ya nombra como *"el almacén real de idempotencia"* — el Map sería sólo una capa rápida.
⛔ **PROHIBIDO elegir un TTL sin medir esto primero.**

**DT-7 — Republicar la ficha del agente CAMBIA su clasificación de riesgo, y hacia el lado
estricto.** `src/lib/capability-risk.ts:89-99` no contiene `kyc-hosted-redirect` ni
`legacy-single-shot-kyc` ⇒ `classifyCapabilities` devolvería `'unclassified'`
(`:143-153`) ⇒ `needsTightTrialQuota` pasa a `true` (`:166-170`) para `remit-kyc-validator`, que
hoy —con sus 4 capacidades viejas— clasifica `'no-disbursement'`. **La dirección es la segura**
(cupo más estrecho), pero es un cambio de comportamiento del carril de estreno que aparecería
*solo*, el día de la republicación, sin que nadie lo pida. AC-10 lo hace explícito. **[MEDIDO]**

**DT-8 — El artefacto que se le devuelve al caller es opaco y no se interpreta.** El Coordinador
devuelve la URL del agente tal cual. ⛔ No la reescribe, no le agrega parámetros, no la valida
contra una allowlist propia (el agente ya tiene la suya, `agent-kyc-client.ts:99-101`).

---

## Constraint Directives (CD-N)

- **CD-1** — ⛔ **PROHIBIDO que el estado del pipeline suspendido viva en Chaski.** Si el
  Coordinador orquesta, el estado es suyo; si no, volvemos al problema que esta HU cierra.
- **CD-2** — ⛔ **PROHIBIDO representar la suspensión como `success: false`.** Protege la alerta
  `strandedExposureBreached` de `/health`.
- **CD-3** — ⛔ **PROHIBIDO un anti-replay en memoria del proceso.** Textual de
  `orchestrate-quote.ts:23-24`.
- **CD-4** — **OBLIGATORIO** que toda query/mutación sobre la tabla nueva cruce el `id` con
  `.eq('owner_ref', <owner del caller>)`. El cliente usa `SUPABASE_SERVICE_KEY` (BYPASSRLS): el
  guard real es app-layer (`CLAUDE.md` → Ownership Guard). Toda tabla con `owner_ref` entra al
  universo de `test/ownership-filter-guard.test.ts` **automáticamente**.
- **CD-5** — ⛔ **PROHIBIDO migrar a `caldz`.** Toda migración a **bdwv**, con su `_down.sql`.
- **CD-6** — **OBLIGATORIO** bandera nueva con comparación `=== 'true'` estricta y **default OFF**.
- **CD-7** — ⛔ **PROHIBIDO tocar el guard `i > 0`** de `compose.ts:571`, ni su comentario CD-11.
  Es la única defensa contra el doble débito del step 0. **El AR debe verificar que sobrevive.**
- **CD-8** — ⛔ **PROHIBIDO que el identificador de reanudación viaje en query string, en una URL,
  en un log o en un mensaje de error.** Mismo criterio que `agent-kyc-client.ts:150-153`.
- **CD-9** — ⛔ **PROHIBIDO debilitar cualquiera de los 7 controles de WKH-233** enumerados arriba.
- **CD-10** — ⛔ **PROHIBIDO alcanzar el flujo hosted-redirect a través del `POST /invoke`
  deprecado**, que manda el documento por la red en cada llamada (`registry.ts:63-64`).
- **CD-11** — ⛔ **PROHIBIDO subir `MAX_COMPOSE_STEPS`** en esta HU.
- **CD-12** — ⛔ **PROHIBIDO agregar `compose_suspended` (o como se llame) a
  `SETTLE_UNKNOWN_EVENT_TYPES`.** Espeja CD-8 de HU-306 (`stranded-payment.ts:34-43`).
- **CD-13** — **OBLIGATORIO** que el módulo de firma sea **LEAF** (sólo `node:crypto`), por el
  motivo escrito en `orchestrate-quote.ts:26-27` y `compose-limits.ts:3-9`: media docena de suites
  mockean los módulos gordos del money-path completos y un export traído de ahí llega `undefined`.
- **CD-14** — **OBLIGATORIO** que el `_INDEX.md` reciba la fila de esta HU **antes** del primer
  commit que trackee la carpeta. Ver "Riesgo de proceso".

---

## Missing Inputs

| # | Qué falta | Estado |
|---|---|---|
| MI-1 | **El número `WKH-`.** No lo asigno yo (instrucción explícita). | `[WKH-PENDIENTE]` |
| MI-2 | 🔴 **La decisión (a)/(b) del `decisionToken`** (bloqueante del corte B). | **BLOQUEANTE del corte B.** No bloquea el corte A. |
| MI-3 | 🔴 **El TTL de la suspensión**, que depende de DT-6. | **BLOQUEANTE del corte A** — a resolver en F2 **con medición**, no por elección. |
| MI-4 | **Cómo vuelve el caller**: ¿el navegador redirige a Chaski y Chaski llama a reanudar, o Chaski pollea? Cambia si la reanudación es idempotente-en-lectura o sólo de escritura. | `[NEEDS CLARIFICATION]` — resolver en F2 |
| MI-5 | **Barrido exhaustivo de consumidores del desenlace de un paso.** Sin `grep` no pude hacerlo. Medí **6 uno por uno** (ver abajo); **el total es [NO MEDIDO]**. | **F2 lo mide con shell.** ⚠️ No arrancar el F3 sin ese barrido. |
| MI-6 | **`tasks` en la base real**: el código y `CLAUDE.md` dicen que tiene `owner_ref`; una nota de memoria dice que no. No consulté la base. | `[NEEDS CLARIFICATION]` — sólo importa si DT-2 elige reusar `tasks` |

### Consumidores del desenlace medidos uno por uno (cota inferior, NO un total)

1. `src/routes/compose.ts:1092` — `if (!result.success)` ⇒ refund del step-0 + mapeo 400/402/403.
2. `src/routes/compose.ts:1087` — `if (reply.sent)` (timeout) ⇒ refund con la misma fórmula.
3. `src/services/compose.ts:230` — `if (!result.success)` ⇒ `recordStrandedRunIfAny`.
4. `src/services/compose.ts:237-241` — el camino del **throw**, que también registra el residuo.
5. `src/services/orchestrate.ts` — decide sobre el débito del step-0 leyendo el resultado, incluido
   `settleRefundWithheld` (**[MEDIDO indirectamente]**: `types/index.ts:1244-1252` lo dice textual;
   no abrí el archivo).
6. `src/mcp/tools/orchestrate.ts` — un mapper (**[NO MEDIDO]**: nombrado en
   `types/index.ts:1290-1291`; no abrí el archivo).

⚠️ Además hay **consumidores fuera de este repo**: `types/index.ts:1290-1291` dice textual que
`StepResult.txHash` *"lo leen consumidores fuera de este repo"*. Un tercer estado en el desenlace es
un **cambio de contrato público** y tiene que ser **aditivo**.

---

## Análisis de paralelismo

- **Esta HU BLOQUEA la HU de "documentar la excepción"** sólo en el sentido de que esa HU describe
  un estado que ésta viene a eliminar. Se pueden escribir en paralelo si la de documentación
  registra la excepción **con fecha** y no como estado permanente.
- **Corte A y corte B NO son paralelos.** B consume el contrato que A define. Empezar B antes de que
  A tenga el desenlace estabilizado es garantizar un rework de tres repos.
- **Conflicto de archivos con WKH-360 (`doc/sdd/223-coordinador-como-agente/`)**: esa HU tocó
  `compose.ts` en el mismo bucle de steps (SITIOS 3 y 4 del guard anti-bucle, `compose.ts:416-458`)
  y `ComposeResult.errorCode` (`types/index.ts:1195-1212`). **Si 223 no está mergeada a `main`, hay
  colisión directa.** 🔴 **[NO MEDIDO]** — no pude correr `git merge-base --is-ancestor`. **Verificar
  antes de crear la rama**, y ⚠️ recordar que `git log` bajo el hook de `rtk` **borra los commits de
  merge** y contesta "no está en main" cuando sí está: usar `rev-parse` / `merge-base`.
- **Paralelizable de verdad dentro del corte A:** la migración + el módulo LEAF de firma (dos
  archivos nuevos, cero conflicto) contra el cambio del desenlace en `compose.ts` (un archivo muy
  disputado). Son dos olas naturales.
- **Depende de una acción de OPS** (republicar la ficha en bdwv) que **no la hace ningún código** y
  que hay que poner en el reporte de cierre, no descubrirla después.

---

## Riesgo de proceso (leer antes del primer `git add`)

🔴 **Crear esta carpeta y commitearla SIN su fila en `_INDEX.md` pone `npm test` en ROJO.**
`test/sdd-index-matches-folders.test.ts` deriva el universo de **`git ls-files -- doc/sdd`** (`:152`)
y el control **G-A2** (`:268`) exige **exactamente una fila por carpeta de HU**. Hoy la carpeta está
untracked y por eso el guardián sigue verde: **el rojo llega con el `git add`, no con la creación.**

⚠️ Y la fila va **AL FINAL de la tabla**, nunca por encima: el control **G-F1** (`:398`) verifica
líneas citadas desde `src/` — en particular `src/lib/capability-risk.ts` cita `doc/sdd/_INDEX.md:144`
(`capability-risk.ts:81-82`) — y **insertar cualquier línea por encima de la 144 corre la tabla y
rompe una cita del camino del dinero**. La fila lista para pegar está en `index-row.md`, en esta
misma carpeta.

---

## Fecha

2026-08-19
