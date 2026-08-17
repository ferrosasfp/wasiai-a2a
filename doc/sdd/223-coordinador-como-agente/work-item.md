> Producto de F0+F1 (`nexus-analyst`), 2026-08-17. Encargo del founder, textual:
> *"hazte la HU para convertirlo al 100% en agente"*. La tesis ya está desplegada en
> el deck: *"el coordinador es, a su vez, un agente A2A: cualquier plataforma puede
> contratar el pipeline completo como un solo agente, con una sola solicitud."*
> Hoy eso es verdad a nivel de carta y de API. Esta HU la vuelve verdad completa y
> segura.
>
> **Todo `archivo:línea` de este documento fue abierto y leído en esta sesión.** Donde
> no pude medir, dice `[NEEDS CLARIFICATION]` y no una afirmación.

# Work Item — [WKH-360] El coordinador es un agente: descubrible, contratable y a prueba de contratarse a sí mismo

## Resumen

El gateway ya publica su propia Agent Card A2A en el path estándar
(`GET /.well-known/agent.json`, `src/routes/well-known.ts:9-17`) y la embebe en
`/capabilities` (`src/routes/capabilities.ts:33`). Lo que falta para que la frase del
deck sea cierta de punta a punta son tres cosas medidas, y **una de ellas es del camino
del dinero**:

1. **La carta existe y no la descubre nadie**: no hay ningún camino por el que el
   gateway se publique en un catálogo, ni propio ni ajeno, y la carta que sirve no
   declara ni precio ni esquema de autenticación (`authentication.schemes: []`,
   `src/services/agent-card.ts:228-230`), así que un integrador que la lee no sabe
   cuánto cuesta ni cómo pagar.
2. **No existe ningún guard anti-bucle.** El único control sobre el destino de una
   invocación es el guard SSRF, que clasifica **rangos de IP**
   (`isBlockedAddress`, `src/lib/ssrf-dispatcher.ts:99`; revalidación previa al fetch en
   `src/services/compose.ts:1489-1503`). La URL pública del propio gateway resuelve a
   una IP pública, así que contratarse a sí mismo —directo, o transitivo A→B→A— **pasa
   ese guard sin tocarlo**. Y el invoke outbound **no emite ningún header de
   profundidad ni de cadena de contratación** (`src/services/compose.ts:1424-1431`,
   `:1446-1448`): la información con la que un guard transitivo podría decidir hoy
   no existe, hay que crearla.
3. **El fee en cascada es invisible.** Cuando un coordinador contrata a otro hay fee
   sobre fee, y eso es legítimo, pero el caller no puede verlo: `/compose` **no
   serializa ningún campo de fee** (dicho por el propio código,
   `src/routes/compose.ts:1050-1053`; la respuesta es `reply.send({ kiteTxHash, ...result })`,
   `:1127`), mientras que `/orchestrate/plan` sí declara `protocolFeeUsdc` y
   `feeRatePercent` (`src/routes/orchestrate.ts:439-440`). Dos superficies, dos puntos
   de partida distintos.

Esta HU cierra los tres, y **decide y escribe el porqué** de la pregunta de neutralidad
que el encargo dejó abierta (¿el catálogo se lista a sí mismo?): la respuesta es **no**,
y no sólo por neutralidad — ver DT-1.

## Sizing

- **SDD_MODE: full** (QUALITY — regla del repo, `CLAUDE.md`: *"WasiAI A2A es siempre
  modo QUALITY"*; además esta HU es money-path, que no admite otra cosa).
- **Estimación: L.** Toca los dos archivos más cargados del camino del dinero
  (`src/services/compose.ts`, `src/routes/compose.ts`), agrega un módulo leaf nuevo, un
  contrato de header outbound y campos aditivos en dos respuestas públicas. Sin
  migración y sin tabla nueva (ver DT-7).
- **Branch sugerido**: `feat/223-wkh-360-coordinador-agente`
- **Olas propuestas** (el Architect las confirma o las reordena en F2; el orden importa
  porque W1 es el único que cierra un agujero de dinero por sí solo):

  | Ola | Qué entra | Por qué en ese orden |
  |-----|-----------|----------------------|
  | **W1** | Identidad propia resuelta una sola vez + **guard de bucle DIRECTO** (fail-closed, sin cooperación de nadie) + tests | Es el único corte que no depende de que la contraparte colabore. Si la HU se cortara acá, ya cierra el caso peor barato. |
  | **W2** | Headers de **cadena de contratación** (profundidad + traza) en el invoke outbound, y su verificación en el inbound → **bucle TRANSITIVO** | Requiere W1 (la identidad propia es lo que se compara contra la traza). Es best-effort por diseño: ver DT-4 y CD-6. |
  | **W3** | Completitud de la carta propia (precio, esquema de auth, endpoints) + decisión de descubribilidad escrita | Independiente de W1/W2, pero se hace después para que lo que se publique ya sea seguro de contratar. |
  | **W4** | **Visibilidad del fee en cascada** en `/compose` y `/orchestrate` (aditivo) | Depende de W2: el dato de "cuánto de esto es orquestación ajena" viaja por el mismo canal que la traza. |

## Acceptance Criteria (EARS)

### Descubribilidad y contratabilidad de la carta

- **AC-1**: WHEN un cliente hace `GET /.well-known/agent.json`, the system SHALL
  devolver una carta que declare, además de lo que ya declara hoy
  (`src/services/agent-card.ts:197-245`): (a) el **precio** de cada skill contratable
  o la forma de obtenerlo, (b) el o los **esquemas de autenticación/pago** aceptados
  —hoy es un array vacío, `:228-230`— y (c) el **endpoint concreto** al que se manda
  cada skill. La respuesta SHALL seguir siendo gratuita y exenta de rate-limit
  (`src/routes/well-known.ts:11`, `config: { rateLimit: false }`).
- **AC-2** (ubiquitous): the system SHALL construir esa carta desde **una sola**
  función (`buildSelfAgentCard`), y `GET /capabilities` SHALL seguir derivando de ella
  (`src/routes/capabilities.ts:33`, `:64-72`) sin una segunda expresión de los mismos
  datos.
- **AC-3** (unwanted): IF alguno de los datos nuevos de la carta (precio, esquema de
  pago) no puede resolverse en runtime, THEN the system SHALL **omitir el campo**
  —nunca emitir `0`, `null` ni un placeholder—, siguiendo el patrón que ya usa el
  propio archivo para `identity` / `computedReputation` / `paymentIntents`
  (`src/services/agent-card.ts:174-190`). Un precio `0` fabricado es una oferta.

### Guard anti-bucle (money-path)

- **AC-4** (bucle DIRECTO): WHEN `/compose` o `/orchestrate` está por invocar un step
  cuyo destino resuelto pertenece a la **identidad pública del propio gateway**, the
  system SHALL rechazar ese step **antes** del débito del caller
  (`src/services/compose.ts:545-573`) y **antes** de cualquier settle downstream
  (`:1555`), con un `errorCode` propio y estable, y SHALL NOT emitir la petición HTTP
  saliente (`:1516`).
- **AC-5** (bucle TRANSITIVO): WHILE una petición entrante trae una cadena de
  contratación que **ya contiene la identidad de este gateway**, the system SHALL
  rechazarla con el mismo `errorCode` de AC-4, antes de cobrar nada.
- **AC-6** (profundidad): IF una petición entrante declara una profundidad de
  contratación mayor o igual al techo configurado, THEN the system SHALL rechazarla
  antes de cobrar. WHERE el techo no está configurado o su valor es ilegible, the
  system SHALL usar el default del código y SHALL NOT interpretar "ilegible" como
  "sin techo" (fail-closed).
- **AC-7** (propagación): WHEN el gateway invoca un agente cualquiera, the system SHALL
  emitir en esa petición la cadena de contratación y la profundidad incrementada. Hoy
  el invoke sólo emite `Content-Type`, las credenciales del registry / del mapa
  self-published y, condicionalmente, `x-a2a-key`
  (`src/services/compose.ts:1424-1431`, `:1446-1448`): **estos headers son nuevos**.
- **AC-8** (el caso legítimo intacto — invariante): WHILE la cadena de contratación
  entrante NO contiene la identidad de este gateway y la profundidad está por debajo
  del techo, the system SHALL comportarse **exactamente como hoy**: mismo status, mismo
  body, mismo cobro, misma cantidad de settles. Esto cubre los dos casos que no se
  pueden romper: (a) un coordinador **externo** contratándonos, y (b) nosotros
  contratando agentes normales, incluido un pipeline de `MAX_COMPOSE_STEPS`
  (`src/lib/compose-limits.ts`) sin ninguna recursión.
- **AC-9** (no auto-inmunidad): the system SHALL aplicar AC-4/AC-5/AC-6 **sin** exigir
  que la contraparte colabore para el caso directo. La cooperación (los headers de
  AC-7) SHALL ser necesaria **sólo** para el caso transitivo, y esa limitación SHALL
  quedar escrita en el propio código y en la respuesta de error, no sólo en el SDD.

### Fee en cascada

- **AC-10**: WHEN `/compose` responde `200`, the system SHALL declarar de forma
  aditiva el fee de protocolo cobrado por **este** gateway. Hoy `/compose` no serializa
  ningún campo de fee (`src/routes/compose.ts:1050-1053`, `:1127`), a diferencia de
  `/orchestrate/plan` (`src/routes/orchestrate.ts:439-440`).
- **AC-11**: WHEN un step del pipeline fue ejecutado por un agente que **declara** ser
  un coordinador y reporta su propio fee de orquestación, the system SHALL exponer ese
  monto por separado del costo del servicio, de modo que el caller pueda leer cuánto
  del total es orquestación ajena. IF ese agente no lo declara, THEN the system SHALL
  marcar ese tramo como **no declarado** y SHALL NOT reportarlo como `0`
  ("no pude preguntar" no es "no pasó").
- **AC-12** (no romper contrato): the system SHALL agregar los campos de AC-10/AC-11 de
  forma **estrictamente aditiva**, dejando todos los campos actuales de las dos
  respuestas con el mismo nombre y el mismo valor — el patrón que este repo ya aplicó
  dos veces sobre respuestas públicas (`src/routes/capabilities.ts:41-43` y `:77-86`).

## Scope IN

- `src/services/agent-card.ts` — `buildSelfAgentCard` (`:197-245`): precio, esquema de
  auth y endpoints por skill (W3).
- **Módulo leaf nuevo** (nombre a definir por el Architect, p. ej.
  `src/lib/contracting-chain.ts`): resolución de la identidad pública propia,
  parseo/serialización de la cadena de contratación, techo de profundidad y el
  predicado `esYoMismo(url)`. **Leaf a propósito**, por el motivo que este repo ya
  documentó tres veces (`src/lib/compose-input-mapping.ts`,
  `src/lib/downstream-skip-code.ts`, `src/lib/discovery-fetch-limit.ts`): media docena
  de suites mockea los módulos gordos del money-path completos, y un símbolo importado
  desde ahí llega `undefined` bajo test.
- `src/services/compose.ts` — el guard directo antes del débito (`:545-573`) y antes
  del fetch (`:1516`); la emisión de los headers nuevos (`:1424-1431`).
- `src/routes/compose.ts` — mapeo del `errorCode` nuevo a HTTP (junto a los ya
  existentes, `:1026-1031`) y los campos de fee (`:1127`).
- `src/routes/orchestrate.ts` — mismo guard en el camino `plan`/`execute` y el campo de
  fee en cascada (respuesta en `:433-447`).
- `src/lib/downstream-payment.ts` — **sólo si** el Architect determina que el guard debe
  además cortar el leg de salida. [NEEDS CLARIFICATION — no lo pude determinar leyendo:
  ver Missing Inputs #3.]
- Tests: bucle directo, bucle transitivo, caso legítimo entrante, caso legítimo
  saliente, techo de profundidad, valor de techo ilegible, y **el anti-vacuidad de cada
  uno** (el gemelo positivo que prueba que el test podía fallar).
- Documentación de la decisión de descubribilidad (DT-1) en `doc/` y el procedimiento
  de registro en catálogos externos (DT-2).

## Scope OUT

- **Publicar el gateway en su propio `/discover`.** Es la decisión DT-1, y es un "no"
  con motivo mecánico además del de neutralidad.
- **Un cliente automático de auto-registro en catálogos externos.** No existe hoy
  ningún camino outbound de publicación en `src/` (la tabla `registries` describe a
  quién **consultamos**, `src/services/registry.ts:172-184`), así que construirlo es una
  HU propia. Acá se entrega la carta lista para que la registren y el procedimiento
  escrito. Ver DT-2 y Missing Inputs #1.
- **Cambiar el modelo de fees.** El fee sobre fee es legítimo y no se toca: esta HU lo
  hace **visible**, no lo elimina ni lo reduce. Fuente de verdad del modelo:
  `doc/architecture/FEE-MODEL.md`.
- **`chaski-v3` y `wasiai-facilitator`.** Ni un archivo.
- **El bucle de DISCOVERY** (registrar como `registry` el propio `/discover` del
  gateway y que el fanout se llame a sí mismo). Es un vector real y contiguo —
  `POST /registries` valida forma y SSRF y nada más
  (`src/routes/registries.ts:181-224`), no hay ningún control de identidad propia—
  pero **no mueve plata** (`/discover` es gratis, `.nexus/project-context.md:445-447`)
  y tiene un circuit-breaker por registry en el camino
  (`src/lib/circuit-breaker.ts`, importado en `src/services/discovery.ts:8`). Se
  declara acá para que no se pierda; candidato a **WKH-361**, prioridad menor.
- **RLS a nivel Postgres** (WKH-SEC-02 / TD-SEC-01). No entra.
- Cualquier rediseño del shape de error global o de los `errorCode` existentes de
  `/compose` más allá de agregar uno.

## Decisiones técnicas (DT-N)

- **DT-1 — El gateway NO se publica en su propio catálogo. Motivo mecánico primero,
  neutralidad segundo.**
  La razón de peso no es de imagen: si el gateway fuera una fila más del catálogo,
  `/compose` podría **seleccionarlo como `steps[0]` por ranking** y `/orchestrate`
  podría **elegirlo desde el planner LLM**, o sea que el catálogo propio *fabricaría*
  el bucle directo que esta misma HU viene a cortar, y lo haría por el camino más
  difícil de auditar (una elección automática, no una URL que alguien escribió). El
  argumento de neutralidad —el operador del catálogo listándose como proveedor
  compitiendo con los agentes que cataloga— es real y va escrito, pero es el segundo.
  La descubribilidad se resuelve por el camino estándar de A2A, que es el que los
  consumidores de protocolo esperan: la carta en `/.well-known/agent.json` (ya
  servida) más el registro en catálogos **externos**.
- **DT-2 — El registro en catálogos externos es procedimiento + carta completa, no
  código, en esta HU.** Medido: no hay productor outbound de publicación en `src/`. Y
  cuáles catálogos externos aceptan hoy una publicación abierta es algo que **no pude
  verificar desde el repo** (Missing Inputs #1). Construir el publicador sin saber
  contra qué se publica es inventar un requirement.
- **DT-3 — La identidad propia se resuelve UNA vez y desde una sola función.** El repo
  ya tiene el resolvedor de la URL pública (`resolveBaseUrl`,
  `src/services/agent-card.ts:67-76`: `BASE_URL` > `x-forwarded-proto` + hostname >
  protocolo + hostname). El conjunto de identidad propia se deriva de ahí más una lista
  de alias por env (el gateway vive detrás de Railway y puede tener más de un nombre).
  **Dos lectores distintos de "quién soy" es exactamente la forma en que este repo ya
  se rompió** (ver `src/lib/agent-category.ts`, extraído por HU-208 justo por eso).
- **DT-4 — El guard es de DOS capas, y sólo una no depende de nadie.**
  - *Capa 1, bucle directo*: comparar el destino resuelto contra la identidad propia,
    antes del débito y antes del fetch. **No requiere que la contraparte coopere** y por
    eso es la que cierra el caso peor. Cierra el hueco de que el guard SSRF sólo mira
    rangos de IP (`src/lib/ssrf-dispatcher.ts:99`).
  - *Capa 2, bucle transitivo*: cadena de contratación + profundidad en headers
    (AC-5/AC-6/AC-7). **Requiere cooperación**: un intermediario que no reenvíe los
    headers rompe el rastro. Es defensa real contra el caso normal (dos coordinadores
    que hablan el mismo protocolo) y **no** contra un adversario que borra headers a
    propósito. Eso se declara (CD-6) en vez de dejar creer que el bucle está cerrado.
- **DT-5 — Identidad de la cadena, no URL.** La traza lleva un identificador estable del
  gateway, no su URL, porque la URL cambia por deploy/alias y una traza que se compara
  por string de URL da falsos negativos justo cuando más importa. Qué se usa como
  identificador estable lo define el Architect en F2 (candidato natural: el `name` de
  la carta más el host canónico de `BASE_URL`).
- **DT-6 — Rechazar es NO COBRAR, no cobrar y reembolsar.** El guard corre antes del
  `budgetService.debit` per-step (`src/services/compose.ts:545-553`) y antes del
  `signAndSettleDownstream` (`:1555`). Motivo: el reembolso de este repo es
  best-effort (`refundStepDebit`, `:704-730`) y el step-0 lo debita el middleware
  aparte; un guard que corta después deja residuo por diseño.
- **DT-7 — Sin tabla nueva y sin migración.** Todo el estado del guard viaja en la
  petición. Si el Architect decidiera persistir la traza (para telemetría), entra al
  régimen del ownership guard de `CLAUDE.md` y hay que declararlo explícitamente en el
  SDD — **hoy la HU está diseñada para no necesitarlo**.
- **DT-8 — El fee ajeno se LEE, no se estima.** El monto de orquestación ajena sale de
  lo que el sub-coordinador declare en su respuesta. No se deriva de un porcentaje
  asumido: un número calculado por nosotros sobre el fee de otro es una invención con
  aspecto de dato. GOTCHA del repo que aplica acá: `fee_usdc` es la pata
  **plataforma**, no el total (`doc/architecture/FEE-MODEL.md`).

## Constraint Directives (CD-N)

- **CD-1 — PROHIBIDO que la Capa 1 del guard quede detrás de una bandera con default
  OFF.** La convención del repo es `=== 'true'` estricto y default OFF
  (`.nexus/project-context.md:252-268`), y **aplicada acá sin pensar shippea el guard
  apagado**. La única bandera admisible es una **allow-list de auto-contratación
  legítima, vacía por default = denegar**; si se agrega, se lee con el `=== 'true'` /
  CSV estricto de la convención.
- **CD-2 — PROHIBIDO cambiar el comportamiento del caso legítimo (AC-8).** Ni status,
  ni body, ni monto cobrado, ni cantidad de settles. El control es un test que corre el
  pipeline completo sin recursión y compara contra la línea base.
- **CD-3 — OBLIGATORIO que el corte ocurra antes de cualquier movimiento de plata**
  (DT-6). Un AR que encuentre el guard después del `debit` o después del
  `signAndSettleDownstream` marca **BLOQUEANTE**.
- **CD-4 — PROHIBIDO sacar, debilitar o mover el guard SSRF existente**
  (`src/services/compose.ts:1489-1503`, `src/lib/ssrf-dispatcher.ts`). El guard nuevo es
  **aditivo y ortogonal**: uno mira rangos de IP, el otro mira identidad. Colapsarlos en
  uno solo reabre el que ya está cerrado.
- **CD-5 — PROHIBIDO emitir `0` donde el dato no se pudo obtener** (AC-3, AC-11). Ni en
  la carta, ni en el fee en cascada. Tercer valor explícito o campo omitido.
- **CD-6 — OBLIGATORIO declarar por escrito, en el código y en el mensaje de error, que
  la Capa 2 es best-effort** y por qué (DT-4). Este repo tiene medido que la prosa que
  afirma de más apaga las revisiones siguientes; "bucle transitivo cerrado" a secas
  sería exactamente eso.
- **CD-7 — OBLIGATORIO que cada AC de corte tenga su gemelo positivo anti-vacuidad.**
  Un test que verifica que algo se rechaza, sin su par que verifica que lo legítimo
  pasa, no distingue "el guard funciona" de "rompí el endpoint".
- **CD-8 — OBLIGATORIO: si la HU termina tocando alguna query de `src/services/` sobre
  una tabla con `owner_ref`, el filtro va** (`CLAUDE.md` → Ownership Guard; el criterio
  lo deriva `deriveTables()` en `test/ownership-filter-guard.scanner.ts` y el guardián
  corre en cada `npm test`). El diseño de DT-7 es no tocar ninguna; si eso cambia, la
  regla aplica sin excepción.
- **CD-9 — Sin hardcodes** (Golden Path): ni la URL propia, ni los alias, ni el techo de
  profundidad, ni ningún identificador de gateway. Todo por env, con default en el
  código y fail-closed ante valor ilegible (AC-6).
- **CD-10 — TypeScript strict, sin `any` explícito**, y los campos nuevos de respuesta
  se agregan con el patrón de omisión (`...(x !== undefined && { x })`) que el repo ya
  usa, para no violar `exactOptionalPropertyTypes` (activo, `tsconfig.json:11`).

## Missing Inputs

1. **[no bloqueante — condiciona sólo el alcance de DT-2]** *¿Qué catálogos A2A
   externos aceptan hoy una publicación abierta?* No lo pude verificar desde el repo.
   Lo que sí está medido: Kite figura como `a2aSupport: none (hoy)` y su discovery está
   bloqueado por falta de API (`.nexus/project-context.md:470-475`, deuda técnica #1);
   los registries activos en prod son `WasiAI` y `self-published`
   (`:478-479`); y ERC-8004 sobre Base (`src/adapters/erc8004-identity.ts:76-86`) es un
   registro de **identidad**, no un catálogo de agentes. Por eso DT-2 entrega
   procedimiento y no publicador. Si el founder tiene un catálogo concreto en mente,
   entra como input de F2 sin cambiar el resto de la HU.
2. **[no bloqueante — resuelto en F2]** *¿Qué identificador estable usa la cadena de
   contratación?* Decidido el criterio (DT-5), no el valor. Es una decisión de diseño
   pequeña que el SDD cierra.
3. **[no bloqueante — resuelto en F2]** *¿El guard tiene que cortar además el leg de
   salida en `src/lib/downstream-payment.ts`?* No lo pude determinar leyendo: el leg
   de salida se decide dentro de `signAndSettleDownstream`, que tiene 25 caminos de
   `return null` (`src/services/compose.ts:1550-1554`), y no leí ese archivo completo
   en esta sesión. Si el corte de DT-6 ocurre antes del invoke, el leg **no debería**
   llegar a ejecutarse nunca; el Architect lo confirma o agrega el archivo al Scope IN.
4. **[declarado — límite de esta sesión]** Esta F1 tuvo **`Read` / `Write` / `Glob`
   únicamente**: sin `Bash`, sin `Grep`, sin red y sin DB. En consecuencia:
   - la afirmación *"no existe ningún guard anti-bucle"* se sostiene sobre la lectura
     directa del camino de invocación (`src/services/compose.ts:1380-1571`), del
     dispatcher SSRF completo (`src/lib/ssrf-dispatcher.ts:1-501`) y de las rutas
     `well-known` / `capabilities` / `registries`, **no** sobre un barrido exhaustivo
     de `src/`. F2 debería confirmarlo con
     `grep -rn "resolveBaseUrl\|BASE_URL" src/` y un barrido de headers emitidos.
   - **corrección de una cita del encargo**: el guard SSRF citado como `compose.ts:1485`
     es `src/services/compose.ts` (el *service*, no el route: `src/routes/compose.ts`
     tiene 1133 líneas y no llega a la 1485), y la línea real del guard es el bloque
     `:1489-1503`; `:1485` cae dentro del comentario que lo precede. El predicado que
     hace el trabajo vive en `src/lib/ssrf-dispatcher.ts:99`.
5. **[acción para el orquestador — no pude ejecutarla]** Sin `Edit`/`Bash` no inserté la
   fila en `doc/sdd/_INDEX.md` (300+ líneas, con celdas de más de 5000 caracteres cuya
   reescritura completa vía `Write` arriesga corromper contenido que no puedo releer
   byte a byte). La fila lista para pegar va en el resumen ejecutivo.
   **Y un hallazgo colateral que conviene mirar ya**: la tabla termina en la fila `221`
   (`doc/sdd/_INDEX.md:214`) y **la carpeta `222-wkh-345-uuid-param-validation/` no
   tiene fila**, estando trackeada en git. Según lo que el propio `_INDEX.md` declara
   (`:230-234`), el guardián `test/sdd-index-matches-folders.test.ts` exige una fila por
   carpeta y pone `npm test` en rojo si falta — o sea que **la suite podría estar roja
   antes de que esta HU empiece**. No lo pude ejecutar; hay que medirlo antes de F3,
   porque si no, el primer `npm test` de esta HU va a parecer culpa de esta HU.

## Análisis de paralelismo

- **Esta HU bloquea la promesa del deck**, no otra HU. Mientras no esté, la frase *"el
  coordinador es, a su vez, un agente A2A"* es cierta a medias y sin guard de bucle.
- **Riesgo de conflicto ALTO con cualquier HU que toque `src/services/compose.ts` o
  `src/routes/compose.ts`.** Son los archivos más disputados del repo. Antes de abrir la
  rama hay que verificar que no haya otra HU en vuelo sobre el camino de compose (el
  procedimiento está escrito en `doc/sdd/_INDEX.md:280-287`: `git branch -a`,
  `git merge-base --is-ancestor`, `git rev-list --count main..<rama>`). **No lo pude
  correr en esta sesión** (Missing Inputs #4).
- **Sin conflicto** con las HUs Solana en vuelo (WKH-314/315: `middleware/x402.ts`,
  `adapters/registry.ts`, `adapters/solana/*`) ni con WKH-345
  (`receipts.ts`/`auth/*`/`payments.ts`/`tasks.ts`/`lib/uuid.ts`): ningún archivo
  compartido con este Scope IN.
- **W3 (la carta) puede ir en paralelo real** con W1/W2 en otro worktree: toca
  `src/services/agent-card.ts` y nada del camino de dinero. W4 no: depende de W2.
- Si sale **WKH-361** (bucle de discovery, ver Scope OUT), comparte el módulo leaf de
  identidad propia de DT-3 y por lo tanto **conviene después**, no en paralelo.

---

## Nota de cierre: qué NO afirma este work-item

Dos cosas que sería cómodo escribir y serían falsas:

1. **No afirmo que hoy haya un drenaje de fondos en curso.** Lo medido es que el guard
   de identidad **no existe** y que la ruta al bucle está abierta. Lo que hoy frena el
   caso directo es **accidental, no un guard**: `/compose` y `/orchestrate` cobran, y el
   invoke outbound **no reenvía la credencial del caller** salvo que el registry sea
   de confianza del sistema (`src/services/compose.ts:1445-1448`, `ownerRef === SYSTEM_OWNER_REF`).
   Ese freno desaparece en tres escenarios concretos, y el tercero es justamente el que
   la tesis nueva del deck invita: (a) el bucle pasa por un registry `system`, donde el
   bearer **sí** se reenvía; (b) el destino está en el mapa host→secreto de
   `resolveSelfPublishedAuthHeaders` (`:1420-1423`); (c) **la contraparte tiene su
   propia agent key fondeada contra nosotros y nosotros contra ella** — que es el
   caso "otra plataforma contrata el pipeline completo", y ahí cada vuelta del bucle
   paga de los dos lados. Además, aun sin credenciales, un step que falla **ya fue
   debitado** antes del invoke (`:545-573`) y su reembolso es best-effort (`:704-730`):
   el bucle es como mínimo un amplificador de trabajo no pagado. *Acotar no es cerrar.*
2. **No afirmo que la Capa 2 cierre el bucle transitivo contra un adversario.** Cierra
   el caso cooperativo, que es el caso normal entre coordinadores que hablan el mismo
   protocolo. Contra alguien que borra headers a propósito, lo que queda en pie es la
   Capa 1 y los techos de exposición que ya existen (`resolveEffectivePipelineBudgetUsd`,
   `src/services/compose.ts:446-461`, y `MAX_COMPOSE_STEPS`). Está en CD-6 para que el
   AR lo ataque en vez de darlo por bueno.
