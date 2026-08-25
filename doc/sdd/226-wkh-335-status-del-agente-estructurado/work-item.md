# Work Item — [WKH-335] El Coordinador tiene el status HTTP del agente y no lo dice

## ⚠️ HU CROSS-REPO — DOS WAVES, ORDEN OBLIGATORIO

| Wave | Repo | Worktree | Rama | Va |
|------|------|----------|------|-----|
| 1 | `wasiai-a2a` (este repo) | `/home/ferdev/.openclaw/workspace/a2a-wkh362` | `feat/wkh-335-status-estructurado` | **PRIMERO** |
| 2 | `chaski-v3` | `/home/ferdev/.openclaw/workspace/chaski-wkh362` | `feat/wkh-335-error-no-opaco` | Después, y sólo tiene sentido con Wave 1 en prod |

Issues de referencia (medición original): `ferrosasfp/chaski-v3#5` (la HU completa),
`ferrosasfp/wasiai-a2a#177` (Wave 1).

Este artefacto es el ÚNICO work-item de la HU y vive en `wasiai-a2a` porque el 226 es el
siguiente número libre de este índice (verificado: la última fila de
`doc/sdd/_INDEX.md` es la `225`, `2026-08-19`). El `_INDEX.md` de `chaski-v3` recibe
sólo una fila-puntero (ver abajo, "`_INDEX.md` actualizados") — en ese repo `doc/` está
gitignoreado ENTERO (`chaski-v3/.gitignore:36`, `doc/`), así que esa fila vive en el
disco del autor y no en un clon, igual que otras filas ya declaradas así en este mismo
índice (`074-wkh-80-operator-identities-runbook`, `149-wkh-71-operator-wallet-alert`).

## Resumen

El Coordinador (`wasiai-a2a`) SÍ tiene el status HTTP que devolvió el agente invocado
por `/compose` — lo lee (`compose.ts:1743`, `response.status`) y lo mete en un string de
prosa (`compose.ts:1757`: `` `Agent ${slug} returned ${status}...` ``). Ese string es lo
único que sale en el sobre de fallo (`error`). Chaski (`chaski-v3`) es quien decide, en
las dos rutas que mueven la remesa, si le dice a la persona "algo salió mal, probá de
nuevo" — y hoy NO puede distinguir "tu input está mal, reintentar no sirve" (4xx) de "el
agente se cayó, reintentar puede servir" (5xx), porque el único campo legible por
máquina del sobre es `error` (prosa, server-only por contrato — `gateway-client.ts:343`
prohíbe parsearlo). Wave 1 agrega un campo estructurado, aditivo, al sobre de `/compose`.
Wave 2 lo lee y lo mapea a un enum propio en LOS DOS legs de dinero de Chaski
(cotización y desembolso), sin romper ningún candado existente.

## Sizing

- SDD_MODE: full (cross-repo, dos servicios de producción, money-path del lado Chaski)
- Estimación: M (Wave 1) + M (Wave 2) — ninguna de las dos toca schema de DB ni cambia
  el criterio de status HTTP que ya existe hoy
- Modo evaluado: QUALITY (no heredado). Señales propias: toca el sobre público de
  `/compose`, que consume gente fuera de este repo (CD-2 de Wave 1); Wave 2 toca el
  camino que decide "a dónde va la plata" (`payout/prepare`)
- Branch Wave 1: `feat/wkh-335-status-estructurado` (worktree `a2a-wkh362`)
- Branch Wave 2: `feat/wkh-335-error-no-opaco` (worktree `chaski-wkh362`)

## Causa raíz — medida el 2026-08-25, con evidencia archivo:línea

Todo lo que sigue está VERIFICADO leyendo el código en los worktrees indicados, no
heredado del encargo:

- `wasiai-a2a/src/services/compose.ts:1738-1743` — `invokeAgent` llama `ssrfFetch` al
  agente y evalúa `if (!response.ok)`. `response.status` está disponible ACÁ, en una
  variable tipada, con el status real.
- `wasiai-a2a/src/services/compose.ts:1744-1758` — el `throw new Error(...)` arma el
  string `` `Agent ${agent.slug} returned ${response.status}${detail...}` ``. Es el ÚNICO
  lugar donde `response.status` se usa: después de esta línea, el número vive SÓLO
  dentro de un string, no en un campo estructurado.
- `wasiai-a2a/src/services/compose.ts:1178-1190` — camino DIRECTO (sin retry): el
  `return { success:false, ..., error: `Step ${i} failed: ${firstError}` }` no lleva
  ningún campo nuevo con el status. `firstError` es el `.message` del Error de arriba.
- `wasiai-a2a/src/services/compose.ts:1146-1159` — camino CON RETRY: el
  `return { success:false, ..., error: `Step ${i} failed after retry: ${firstError} |
  retry: ${retryError}` }` tiene el MISMO problema, y es un sitio DISTINTO del anterior
  (no comparten el `return`).
- `wasiai-a2a/src/lib/field-error-parser.ts:24-31` — pieza de evidencia adicional que
  el encargo original no citaba: `parseFieldErrors` YA extrae el status vía
  `/returned (\d{3})/.exec(errorMessage)` para decidir si el pipeline reintenta
  (`compose.ts:920`, `isMasterPath ? parseFieldErrors(firstError) : null`). O sea que el
  Coordinador YA depende, internamente, de recuperar el status re-parseando el string
  que él mismo armó — la prueba de que el dato existe y de que hoy sólo es accesible por
  un mecanismo frágil (regex sobre prosa), server-side, para una decisión interna
  distinta (reintentar), no para informar al caller.
- `chaski-v3/src/infrastructure/a2a/gateway-client.ts:230-249` — `readFailureFields`
  busca `body.code`, `body.error_code`, `body.reason`, `body.error`. Contra el sobre de
  hoy sólo encuentra `error` (la prosa), que `gateway-client.ts:155` declara
  SERVER-ONLY, prohibido de ecoar y de loguear.
- `chaski-v3/src/infrastructure/a2a/gateway-client.ts:343` — comentario que fija la
  prohibición: `PROHIBIDO parsear el texto "Step 2 failed: ..."` (CD-8/CD-9 del propio
  archivo). Directiva VIGENTE, esta HU no la levanta.
- `chaski-v3/app/api/a2a/quote/route.ts:170` — `if (!r.ok) { ... return
  NextResponse.json({ error: "a2a_unavailable" }, { status: 502 }); }` es el catch-all
  que colapsa CUALQUIER `step_failed` (incluido un 4xx del agente) al mismo mensaje que
  una caída real.
- `chaski-v3/app/api/payout/prepare/route.ts:391-427` — MISMO patrón, en el leg que
  decide a dónde va la plata: `prepare_upstream_error` con 502.

Medición que fija el síntoma extremo a extremo (`/compose` con Agent Key de producción,
`payoutMethod: "bank"` inválido): HTTP 400,
`"error":"Step 0 failed: Agent remit-corridor-fx-solana returned 400:
{\"error\":\"invalid_input\",\"details\":{\"fieldErrors\":{\"payoutMethod\":[\"Invalid
enum value. Expected 'yape' | 'plin' | 'bank_cci', received 'bank'\"]}}}"`. Con un valor
válido la MISMA llamada da 200 con tasa real: el pipeline está sano, lo único roto es
que el fallo por input no se distingue del fallo por caída.

### Por qué se cierra ahora (criterio del founder), y las tres clases

Instrucción explícita: **"no quiero deuda técnica en esta HU"**. El work-item no puede
dejar diferido nada que sea causa raíz. Clasificación de todo lo que este F1 encontró:

1. **Hay que cerrarla YA** (causa raíz de un defecto que ya volvió — tercera vez que un
   error opaco del money-path se presenta como falla de infra): TODO el alcance descrito
   abajo — el campo estructurado en `wasiai-a2a` (Wave 1, los DOS caminos), y el mapeo en
   `chaski-v3` (Wave 2, los DOS legs). Nada de esto se difiere.
2. **Diferida con razón medida** (acotamiento, no cierre, con disparador observable):
   `TD-362-STATUS-ORCHESTRATE` — `services/orchestrate.ts:1226` embebe el
   `ComposeResult` completo como `pipeline` dentro de `OrchestrateResult`
   (`types/index.ts:1493`, `pipeline: ComposeResult`); como el campo nuevo es ADITIVO al
   tipo `ComposeResult`, **`/orchestrate` lo hereda automáticamente sin código nuevo**,
   sólo por el spread. No es un gap: es una consecuencia verificada del diseño aditivo.
   Disparador para revisar: si algún consumidor de `/orchestrate` (dashboard, MCP tool)
   reporta la MISMA opacidad que esta HU mide en Chaski, es señal de que ese consumidor
   necesita su propio mapeo — no reabre esta HU, abre una nueva con su propio F1.
3. **No la puede cerrar un agente** (precondición del founder): el ORDEN de despliegue.
   Ver CD-final y "Precondición del founder" más abajo.

## Acceptance Criteria (EARS)

### Wave 1 — `wasiai-a2a`

- **AC-1** (camino directo). WHEN un agente invocado por un step de `/compose` responde
  con un status HTTP 4xx o 5xx y el pipeline falla SIN reintento
  (`compose.ts:1178-1190`), the system SHALL incluir en el `ComposeResult` devuelto un
  campo nuevo, aditivo y opcional, que permita a un consumidor distinguir un rechazo por
  input (4xx: reintentar con el MISMO input no sirve) de una falla de infraestructura
  (5xx / red: reintentar puede servir), SIN alterar el campo `error` existente.

- **AC-2** (camino con retry). WHEN la misma clase de fallo ocurre DESPUÉS del retry
  adaptativo (`compose.ts:1146-1159`), the system SHALL incluir el MISMO campo nuevo,
  reflejando el desenlace del intento cuyo error se reporta (el del retry), en el mismo
  `return` — este es un sitio de código DISTINTO del de AC-1 y los dos tienen que quedar
  cubiertos, no sólo uno.

- **AC-3** (no leak). THE campo nuevo SHALL NOT incluir el `invokeUrl` del agente ni su
  cuerpo de respuesta crudo. Es una clasificación acotada derivada del status HTTP, no un
  eco de lo que el agente devolvió (mismo criterio que `toPublicSkipCode` ya aplica en
  este archivo para no filtrar detalle interno del agente/gateway).

- **AC-4** (aditivo / back-compat). WHEN un consumidor existente lee sólo `error` (el
  100% del tráfico de hoy), the system SHALL producir un comportamiento byte-idéntico al
  actual. Ningún campo existente del sobre de `/compose` (`error`, `errorCode`,
  `success`, `steps`, `totalCostUsdc`, etc.) SHALL ser renombrado ni quitado.

- **AC-5** (el control que impide que la HU nazca con la deuda adentro). THE test que
  cierra Wave 1 SHALL ejercitar la respuesta PROPIA de `/compose` de `wasiai-a2a` (no un
  doble de Chaski) contra un agente invocado que responde 4xx, y SHALL quedar como
  evidencia que ese test estuvo en ROJO ANTES del fix (corriéndolo contra el código sin
  el campo nuevo) y en VERDE después. Un test que pasa con y sin el arreglo no cuenta
  como evidencia de AC-1/AC-2.

### Wave 2 — `chaski-v3`

- **AC-6** (leg de cotización). WHEN `runViaGateway` (invocado desde
  `app/api/a2a/quote/route.ts:136`) recibe del gateway un fallo cuyo campo nuevo indica
  un rechazo por input (4xx) del agente de FX, DISTINTO de `no_agent_match` /
  `payment_required` / `unavailable` (que siguen colapsados por CD-8 preexistente), the
  system SHALL mapearlo a un enum propio de Chaski, DISTINTO del genérico
  `a2a_unavailable`, siguiendo el patrón ya abierto para `no_agent_match`
  (`quote/route.ts:153-169`, WKH-332/AC-13): palabra propia, nunca eco del `message` del
  gateway.

- **AC-7** (leg de desembolso — la pata de dinero, prioridad de la HU). WHEN
  `app/api/payout/prepare/route.ts:391` recibe la MISMA clase de fallo del leg de
  payout, the system SHALL aplicar el MISMO mapeo que AC-6. Arreglar sólo AC-6 y dejar
  este leg opaco NO satisface la HU: es el camino que decide a dónde va la plata.

- **AC-8** (candados preservados). WHEN cualquiera de las dos rutas responde con el
  código nuevo, the system SHALL mantener el body de respuesta con EXACTAMENTE una
  clave (`error`), sin el `message` crudo del gateway, sin la URL del agente y sin PII
  — mismo invariante que ya clava `route.test.ts` (`Object.keys(json)` === `["error"]`,
  citado en `quote/route.ts:149-150`).

- **AC-9** (sin levantar la prohibición de parsear prosa). THE mapeo SHALL leer
  ÚNICAMENTE el/los campo(s) estructurado(s) nuevo(s) que expone `readFailureFields`
  (`gateway-client.ts:230-249`, extendido para leer el campo que agrega Wave 1) —
  `gateway-client.ts:343` (PROHIBIDO parsear `"Step N failed: ..."`, CD-8/CD-9) sigue
  intacto y vigente.

### Cierre (los dos repos)

- **AC-10** (orden de despliegue, precondición del founder — Clase 1, no la ejecuta un
  agente). IF Vercel (chaski-v3) se despliega ANTES que Railway (wasiai-a2a), THEN
  Chaski mapea un campo que todavía no existe en prod y el fix no cambia nada
  observable — el work-item declara el orden explícitamente para que el gate de cierre
  lo verifique, no lo asuma.

## Scope IN

### Wave 1 (`wasiai-a2a`)

- `src/services/compose.ts:1178-1190` — el `return` del camino directo.
- `src/services/compose.ts:1146-1159` — el `return` del camino con retry.
- `src/services/compose.ts:1738-1758` — `invokeAgent`, donde `response.status` está
  disponible y hoy se pierde al armar sólo el string del `Error`. El punto donde F2
  decide CÓMO estructurar la propagación del status hasta los dos `return` de arriba
  (custom Error con propiedad, side-channel, o reusar/reemplazar el regex de
  `parseFieldErrors` — decisión de Architect, no de este F1).
- `src/types/index.ts:1180-1263` (`ComposeResult`) — declarar el campo nuevo, tipado,
  opcional, documentado con el mismo estilo de comentario (`WKH-335 (AC-N): ...`) que ya
  usa el resto del archivo para campos aditivos (`settleRefundWithheld`, `errorCode`).
- Un test nuevo que corra sobre la respuesta PROPIA de `/compose` (AC-5), con evidencia
  de haber estado en rojo antes del fix.

### Wave 2 (`chaski-v3`)

- `src/infrastructure/a2a/gateway-client.ts:230-249` (`readFailureFields`) — leer el
  campo nuevo del body y exponerlo en `GatewayFailure`.
- `src/infrastructure/a2a/gateway-client.ts:120-131` (`GatewayFailCode`) — posible valor
  nuevo del enum, siguiendo el patrón `no_agent_match`.
- `app/api/a2a/quote/route.ts:158-171` (la rama `!r.ok`) — nueva rama ANTES del
  catch-all `502 a2a_unavailable`.
- `app/api/payout/prepare/route.ts:400-427` (la rama `!r.ok`) — mismo tratamiento.
- `src/application/agent-rejections.ts` (o el módulo equivalente) — posible constante
  nueva para el mensaje, mismo patrón que `QUOTE_NO_AGENT_FOR_CAPABILITY` /
  `PREPARE_NO_AGENT_FOR_CAPABILITY`.
- `app/api/a2a/quote/route.test.ts` y `app/api/payout/prepare/route.test.ts` — casos
  nuevos + preservar el candado de una sola clave.

## Scope OUT

### Wave 1

- Tocar `errorCode` (unión cerrada existente: `SCOPE_DENIED` / `DEST_CAP_EXCEEDED` /
  `INPUT_MAPPING_FAILED` / `CONTRACTING_LOOP_DETECTED` / `CONTRACTING_DEPTH_EXCEEDED`,
  `types/index.ts:1207-1212`) ni sus consumidores de status (`routes/compose.ts:1112-1117`).
  El campo nuevo NO reemplaza ni reutiliza ese enum (ver DT-1).
- Cambiar el criterio de status HTTP que YA devuelve `/compose` (400/402/403) para sus
  propios rechazos (`SCOPE_DENIED`→403, `DEST_CAP_EXCEEDED`→402, default 400).
- `services/orchestrate.ts` — queda cubierto de forma ADITIVA sin cambio de código
  (ver Clase 2, `TD-362-STATUS-ORCHESTRATE`).
- Tocar `wasiai-facilitator` ni `wasiai-remittance-agents`.

### Wave 2

- Cambiar el criterio de colapso de `payment_required` (402) / `unavailable` — CD-8
  preexistente de `quote/route.ts:146-151` se mantiene: son estado operativo NUESTRO
  (saldo, red), no del pedido de quien llama.
- Tocar `no_agent_match` (ya resuelto, WKH-332/AC-13).
- Levantar la prohibición de parsear prosa (`gateway-client.ts:343`).
- Setear variables de entorno o desplegar — eso es del founder (ver Precondición).

## Decisiones técnicas (DT-N)

- **DT-1**: el campo nuevo NO reutiliza `errorCode`. `errorCode` es la unión cerrada de
  motivos por los que el GATEWAY MISMO rechaza un pipeline (scope, cap de destino,
  bucle de contratación); el campo nuevo describe qué devolvió el AGENTE INVOCADO. Son
  dos preguntas distintas y mezclarlas en un solo enum le pediría a un consumidor
  ramificar sobre valores de dos orígenes distintos con el mismo campo. F2 decide el
  nombre y el shape exacto; el requisito de este F1 es: aditivo, no HTTP-status crudo
  re-expuesto sin clasificar, y suficiente para separar "4xx del agente → no reintentar
  con el mismo input" de "5xx / infra → reintentar puede servir".

- **DT-2**: `parseFieldErrors` (`field-error-parser.ts:27`) ya extrae el status vía
  regex de `Error.message`, server-side, para decidir si reintentar. F2 tiene que
  decidir explícitamente si el campo nuevo se deriva REUSANDO esa función (menos código
  nuevo, pero acopla un mecanismo de decisión interna a un contrato público) o si
  conviene capturar `response.status` en el origen (`compose.ts:1743`) y propagarlo
  estructuralmente hasta los dos `return`, sin depender de re-parsear el string que el
  propio código arma un renglón más abajo. Esta HU no prejuzga la respuesta; la deja
  explícita para que no se decida por default.

- **DT-3**: el único precedente de un enum público abierto en Chaski para un motivo
  granular del gateway es `no_agent_match` (WKH-332/AC-13,
  `quote/route.ts:153-169` y `payout/prepare/route.ts:406-422`). Wave 2 sigue ESE
  patrón: enum propio, nunca eco del `message`/`reason` del gateway al body de
  respuesta, `reason` (cuando exista) usado sólo para ramificar server-side.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO ecoar el `invokeUrl` del agente invocado o su cuerpo de respuesta
  crudo — ni en el campo nuevo de `wasiai-a2a`, ni en el body HTTP de `chaski-v3`
  (candado ya vigente, `route.test.ts`: el body de fallo tiene exactamente una clave).
- **CD-2**: PROHIBIDO en `chaski-v3` parsear el string de prosa `"Step N failed: ..."`
  (CD-8/CD-9 vigentes de `gateway-client.ts:343`) — esta HU levanta la opacidad
  AGREGANDO un campo estructurado, nunca permitiendo el parseo que hoy está prohibido.
- **CD-3**: PROHIBIDO renombrar o quitar cualquier campo existente del sobre de
  `/compose` (`error`, `errorCode`, `success`, `steps`, `totalCostUsdc`,
  `totalLatencyMs`, etc.). El campo nuevo es estrictamente aditivo.
- **CD-4**: OBLIGATORIO que el test de AC-5 corra sobre la respuesta PROPIA de
  `/compose` (nunca contra un doble de Chaski) y que quede registrada la evidencia de
  que estuvo en rojo antes del fix. Un doble que ya declare el campo nuevo esconde
  exactamente el desajuste que esta HU existe para cerrar.
- **CD-5**: PROHIBIDO cambiar el criterio de colapso de `payment_required` /
  `unavailable` en Chaski — siguen siendo estado operativo nuestro, no del pedido de
  quien llama (CD-8 preexistente de `quote/route.ts`).
- **CD-6**: OBLIGATORIO cubrir AMBOS caminos del Coordinador — directo
  (`compose.ts:1178-1190`) y con reintento (`compose.ts:1146-1159`). Cerrar sólo uno dejaría
  la mitad de los fallos igual de opacos.
- **CD-7**: OBLIGATORIO en Wave 2 arreglar LOS DOS legs de dinero —
  `app/api/a2a/quote/route.ts` y `app/api/payout/prepare/route.ts`. Arreglar sólo la
  cotización deja opaco el camino que decide a dónde va la plata.
- **CD-8**: OBLIGATORIO el orden de despliegue: Railway (`wasiai-a2a`) primero, Vercel
  (`chaski-v3`) después. Ver Precondición del founder.

## Missing Inputs

- [resuelto en F2] Nombre exacto y shape del campo nuevo en `ComposeResult` (DT-1/DT-2
  dan el criterio, no el nombre literal).
- [resuelto en F2] Si `chaski-v3` necesita UN enum compartido para los dos legs o dos
  enums distintos (la UI de cotización y la de desembolso pueden necesitar mensajes
  distintos aunque el mecanismo de mapeo sea el mismo).
- [resuelto en F2] Si el campo nuevo se puebla también para fallos NO originados en un
  status HTTP del agente (p.ej. `CONTRACTING_LOOP_DETECTED`, que no tiene un status de
  agente real) — el criterio por defecto es que quede AUSENTE, no un valor inventado,
  pero la decisión formal es de Architect.
- [bloqueante, Clase 1 — founder] Orden de despliegue: Railway ANTES que Vercel. Ningún
  agente ejecuta esto (ver CD-8 / Precondición).
- [NEEDS CLARIFICATION] cómo clasificar un 429 (rate-limit) del AGENTE invocado (no del
  gateway): a diferencia de un 400 genuino, un 429 sí podría ameritar reintento con el
  MISMO input tras esperar. No hay evidencia medida hoy de que algún agente en el
  catálogo devuelva 429 — se marca para que F2 decida el criterio (todo 4xx = no
  reintentar salvo 408/429, o el criterio más simple "todo 4xx = no reintentar" con
  justificación escrita) sin bloquear el resto de la HU.

## Análisis de paralelismo

- **Wave 1 bloquea Wave 2 en el sentido que importa**: Wave 2 puede desarrollarse y
  testear en paralelo contra un doble propio que YA declare el campo nuevo (así es como
  se prueban las rutas de Chaski hoy), pero por CD-4/AC-5 el ÚNICO candado que certifica
  que el campo existe de verdad vive del lado de `wasiai-a2a`. Wave 2 no se puede dar
  por DONE (en el sentido de "cierra el defecto medido") hasta que Wave 1 esté
  MERGEADA — no sólo con tests verdes en su propia rama.
- **Dentro de Wave 1**: AC-1 y AC-2 tocan el mismo archivo (`compose.ts`) en dos
  `return` distintos que comparten el mismo tipo de campo — conviene un solo PR/wave de
  implementación en vez de partirlos, para no divergir el shape entre los dos sitios.
- **No bloquea ni es bloqueada** por la fila `225` (`WKH-PENDIENTE`, paso suspendible y
  reanudable, F1 escrito, esperando `HU_APPROVED`) ni por la fila `223` (WKH-360, ya
  DONE/mergeada): las tres tocan `compose.ts`, pero en zonas distintas (guard
  anti-bucle, estado suspendido, envelope de error). Riesgo real: si `225` avanza a F3
  en simultáneo con esta HU, hay conflicto de merge textual en `compose.ts` — no de
  diseño. Recomendación al orquestador: coordinar orden de merge si corren en paralelo,
  no bloquear el arranque de ninguna de las dos.
- **La precondición de despliegue (CD-8/AC-10) es un gate DESPUÉS de que las dos waves
  estén DONE en código**: no bloquea el desarrollo de ninguna de las dos, sí bloquea que
  el cierre se declare completo en producción.

## Cómo se verifica el control anti-doble (recordatorio para F3/F4)

El riesgo específico que este work-item nombra por instrucción del encargo: los tests
de `chaski-v3` DOBLAN al gateway, y un doble que emita el campo nuevo hace pasar el test
de Wave 2 aunque el Coordinador real NUNCA lo emita. El candado que lo impide es AC-5 /
CD-4: un test sobre la respuesta REAL de `/compose`, del lado de `wasiai-a2a`, que se
pone rojo si el campo deja de emitirse. F4 tiene que poder citar ese test por nombre y
la corrida en rojo-antes / verde-después como evidencia, no inferirlo de que los tests
de Chaski pasan.
