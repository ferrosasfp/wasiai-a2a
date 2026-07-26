# Auto-Blindaje — [188] P1 registries-redact + compose-debit

Errores cometidos durante la implementación, decisiones y deuda técnica.

---

## WAVE 1 — HIGH-1 (redacción de credenciales de `registries`)

### [2026-07-26 06:12] Wave 1 — El primer barrido de read-paths fue incompleto

- **Error**: el reporte de la sesión de pruebas señalaba sólo `GET /registries`
  (`routes/registries.ts:53-59`). Empezar por ahí habría dejado tres vecinos con el
  mismo leak: `GET /registries/:id` (`:72`), el 201 de `POST /registries` (`:181`) y el
  200 de `PATCH /registries/:id` (`:263`).
- **Causa raíz**: el hallazgo describe el síntoma en un endpoint, no la clase de bug.
  La clase es "cualquier cosa que devuelva una fila de `registries`", y son 4 sitios en
  el mismo archivo más 8 consumidores indirectos.
- **Fix**: barrido por `registryService.list|get|getEnabled`, `from('registries')` y
  `RegistryConfig`/`RegistryAuth` en `src/`, `packages/` y `mcp-servers/` antes de
  escribir código. Tabla completa en `work-item.md`. El PATCH era el peor de los tres
  vecinos: re-emitía la credencial en un request que sólo cambiaba `name`.
- **Aplicar en**: cualquier hallazgo de leak. El patrón de este repo (ver el propio
  `CLAUDE.md`: "fix RLS en bdwv → verificar caldz también") es que un fix parcial deja
  el vecino intacto. Empezar por el grep, no por el archivo señalado.

### [2026-07-26 06:13] Wave 1 — Redactar en la ruta habría sido un fix olvidable

- **Error**: el fix intuitivo es `delete registry.auth.value` (o un `omit`) en cada
  handler. Se descartó.
- **Causa raíz**: `reply.send()` de Fastify acepta `unknown`, así que el compilador no
  ayuda; la redacción en el handler depende de que el autor del próximo endpoint se
  acuerde. Este bug ya sobrevivió a WKH-63 (que endureció los mutations de este mismo
  archivo y no miró los reads) — evidencia de que "acordarse" no funciona acá.
- **Fix**: la redacción vive en el service (`toRegistryPublic`, único productor) y el
  tipo de salida `RegistryPublic` tiene DOS guards estructurales independientes:
  `auth?: never` y `authConfigured` requerido. `RegistryConfig` deja de ser asignable a
  `RegistryPublic`, así que `tsc` rechaza devolver la fila interna. Se comprobó en
  vivo: el primer `tsc --noEmit` tras el cambio falló con
  `TS2379 ... Property 'authConfigured' is missing in type 'RegistryConfig'` en
  `src/__tests__/erc8004-identity-bridge.e2e.test.ts:241` — el guard funciona.
- **Aplicar en**: cualquier separación entre tipo interno y tipo público (PII de
  `a2a_agent_keys`, `funding_wallet`, `kite_passport`, `webhook_secret`). Un tipo
  público que es un subconjunto estructural NO alcanza: TS permite props extra en
  valores no-literales. Hace falta `campo?: never` o un campo requerido nuevo.

### [2026-07-26 06:15] Wave 1 — Un test de redacción puede pasar por vacuidad

- **Error**: la primera versión de las aserciones era `expect(body).not.toContain(SECRET)`
  y nada más. Si el fixture dejara de traer la credencial (o el mock de supabase
  cambiara de shape), todos los tests pasarían sin probar nada.
- **Causa raíz**: una aserción negativa sin contra-prueba es indistinguible de una
  aserción sobre un payload vacío.
- **Fix**: tres capas.
  1. Contra-prueba explícita: T-RRED-06 asserta que el fixture SÍ contiene el secreto;
     T-DRED-03 asserta que el header outbound SÍ lleva `Bearer <secreto>`; T-RED-06/07
     assertan que `getWithSecrets`/`getEnabled` SÍ lo devuelven.
  2. Sanity en el barrido genérico: T-RRED-05 exige `gets.length >= 2` — si el hook
     `onRoute` dejara de capturar rutas, el for-loop vacío pasaría siempre.
  3. Prueba de mutación real: se inyectó un `GET /registries/leak-probe` que devolvía
     `getEnabled()` verbatim y se verificó que T-RRED-05 falla
     (`GET /registries/leak-probe: leaks the credential`). Luego se restauró el archivo.
- **Aplicar en**: todo test cuya aserción principal es negativa (`not.toContain`,
  `not.toHaveBeenCalled`). Sin contra-prueba + mutación, no prueba nada.

### [2026-07-26 06:14] Wave 1 — `get()` redactado habría roto el fetch outbound de discovery

- **Error**: al volver `registryService.get()` redactado, `discovery.ts:170` y `:558`
  (el path con filtro `query.registry`) se quedaban sin `auth.value` y el fetch a la
  marketplace remota habría salido sin autenticar — un 401 silencioso que la suite NO
  habría cazado, porque ningún test ejercitaba ese path filtrado.
- **Causa raíz**: `get()` tenía dos consumos con requisitos opuestos: chequeo de
  existencia / ownership (no necesita el secreto) y armado del header outbound (lo
  necesita).
- **Fix**: se separaron. `get()` → redactado (default, HTTP + guards internos);
  `getWithSecrets(id)` → fila completa, con el nombre gritando el riesgo, y sólo dos
  call-sites, ambos en `discovery.ts`. Se agregó `getWithSecrets: vi.fn()` a los tres
  mock factories de `./registry.js` en las suites de discovery (que no lo tenían y
  habrían dado `undefined is not a function` en el primer test futuro del path
  filtrado), y T-DRED-02 cubre ese path por primera vez.
- **Aplicar en**: antes de redactar un getter compartido, enumerar sus call-sites y
  clasificarlos por "¿necesita el secreto?". Si hay de los dos tipos, hacen falta dos
  métodos, no un flag booleano.

---

## Deuda técnica abierta

### TD-188-1 — `auth.key` desapareció del body (breaking, deliberado)

`RegistryPublic` no expone `auth.key` (el nombre del header, p.ej. `x-api-key`), que
técnicamente no es secreto. Se eligió mínimo privilegio: para `bearer` y `query` el
`key` es redundante, y para `header` sólo sirve a quien ya tiene la credencial.

Impacto: un consumidor (dashboard de `wasiai-v2`) que leyera `registries[].auth` recibe
ahora `authType` + `authConfigured`. **No verificado** contra el repo de v2 — está fuera
del working directory de esta HU. Si algo se rompe, la reposición correcta es agregar
`authKey?: string` a `RegistryPublic` y mapearlo en `toRegistryPublic`, NUNCA reponer el
objeto `auth`.

### TD-188-2 — `getEnabled()` sigue con nombre neutro y devuelve el secreto

Se mantuvo el nombre en vez de renombrarlo a `getEnabledWithSecrets` porque cambia ~60
líneas de mocks en 6 suites (`compose.test.ts`, `discovery.test.ts`,
`discovery.ssrf.test.ts`, `discovery.selfpublished.test.ts`, `compose.ssrf.test.ts`,
`agent-card` e2e) — churn mecánico grande dentro de un fix P1. Mitigación: docstring
`⚠️ INTERNO` en `services/registry.ts` + el guard genérico T-RRED-05, que caza el
read-path que lo use (probado por mutación con exactamente ese caso).

### TD-188-3 — La credencial expuesta NO fue rotada

Fuera de alcance por instrucción explícita. El fix cierra el canal; la credencial
filtrada sigue siendo válida hasta que el founder la rote. **Acción del founder**,
no de esta HU.

### TD-188-4 — El guard genérico cubre el plugin de `registries`, no toda la app

T-RRED-05 barre los GET de `routes/registries.ts`. Un read-path nuevo en OTRO plugin
que devuelva `getEnabled()` verbatim no lo caza (lo cazaría `tsc` sólo si el valor pasa
por un slot tipado `RegistryPublic`, que no es el caso de `reply.send()`). Un barrido
app-wide requiere bootear la app completa con envs, que hoy no tiene harness.

---

## WAVE 2 — HIGH-2 (`/compose` cobra en el 400 de validación)

### [2026-07-26 06:26] Wave 2 — Elegir (a) vs (b) por "limpieza" habría dejado al caller x402 sin defensa

- **Error**: la primera lectura del trade-off fue la del enunciado — (a) es más limpia,
  (b) cubre más casos. Con ese encuadre, (b) sola parecía suficiente y más segura
  (menos reordenamiento de preHandlers).
- **Causa raíz**: (b) es *estructuralmente incapaz* de cubrir el path x402. El bloque de
  credit-back está gateado en `request.a2aKeyRow` (`compose.ts:298-305`), y un caller
  x402 settlea su pago **inbound on-chain**: no hay budget en DB que acreditar. Si el
  402 sale primero, el caller paga, y después llega el 400 → esa plata no se puede
  devolver. Eso convierte a (a) en la única opción viable, no en "la más elegante".
- **Fix**: (a) para los tres 400 (`validateComposeBodyHandler` pre-débito, `compose.ts:578`)
  + (b) para los dos 504 que no se pueden adelantar (el timer ya disparó cuando el débito
  ocurrió), reusando el mecanismo de WKH-127 vía `refundComposeStep0` (`compose.ts:294`).
- **Aplicar en**: cualquier decisión "validar antes vs reembolsar después". La pregunta
  correcta no es cuál es más limpia, es **si todos los paths de pago tienen un refund**.
  Un path que cobra on-chain (x402, escrow, gasless) nunca lo tiene → hay que validar
  antes, sin excepción.

### [2026-07-26 06:28] Wave 2 — Adelantar la validación rompió dos tests, y uno era un test mentiroso

- **Error**: al adelantar la validación cayeron `AC-19` (e2e) y `T-ROUTE-X402-AMT-5`.
  El reflejo fue "el fix rompió algo, revisar el fix".
- **Causa raíz**: los dos tests dependían del **orden relativo** de dos guards distintos,
  no del comportamiento que declaraban probar.
  - `AC-19` ("POST /compose sin auth → 402") mandaba
    `{ steps: [{ agentSlug: 'test' }] }` — **`agentSlug`, no `agent`**. O sea un body
    MALFORMADO. Obtenía el 402 porque el gate de auth corría antes que cualquier
    validación de shape. El test nunca probó el gate de auth con un body válido.
  - `T-ROUTE-X402-AMT-5` manejaba un body malformado a través del preHandler de precio
    para ejercitar el guard de layer 1 de `augmentX402ChallengeAmount`. Con layer 0
    (mismo predicado: `!step || typeof step.agent !== 'string'`) ese path quedó
    inalcanzable vía HTTP **por construcción**.
- **Fix**: `AC-19` pasa a un body bien formado + un `getAgent` que resuelve, así prueba
  el gate de auth de verdad; se agregó `AC-19b` para el comportamiento nuevo
  (malformado + sin auth → 400 pre-pago). `T-ROUTE-X402-AMT-5` se re-apunta a la
  garantía MÁS FUERTE que ahora existe (el body malformado ni se cotiza → ningún caller
  puede pagarlo) y el guard de layer 1 se conserva con un comentario que explica que hoy
  es inalcanzable pero sigue siendo el fallback seguro si se reordenan los preHandlers.
- **Aplicar en**: cuando un fix de ordenamiento rompe un test, revisar si el test
  dependía del orden **incidentalmente**. Un test cuyo payload no matchea su nombre
  (`agentSlug` en un test de auth) está probando otra cosa. Arreglar el test, no
  ablandar el fix — y dejar un test nuevo que documente el comportamiento cambiado en
  vez de esconderlo.

### [2026-07-26 06:31] Wave 2 — El test del 504 dio falso negativo porque `inject` no espera al handler

- **Error**: T-NOCHARGE-11 falló con `creditMock` llamado 0 veces, aunque el credit-back
  estaba implementado. La primera hipótesis fue que el guard `if (reply.sent)` no veía
  el flag.
- **Causa raíz**: el 504 lo envía el **timer** de `createTimeoutHandler`, no el handler.
  `app.inject` resuelve cuando la respuesta se ENVÍA, así que volvía a los ~4ms mientras
  el handler seguía corriendo (compose tardaba 60ms) — que es exactamente el escenario
  bajo prueba. Los asserts medían un estado intermedio.
- **Fix**: el mock de compose expone una promesa `done` que se resuelve cuando el
  pipeline termina; el test hace `await done` + un drenado de microtasks/immediates
  (`flush()`) antes de asertar. Sin sleeps arbitrarios.
- **Aplicar en**: todo test de un side-effect que ocurre DESPUÉS de que la respuesta se
  envió (refunds, recibos, telemetría fire-and-forget, outbox). `await app.inject(...)`
  NO es una barrera para esos efectos.

### [2026-07-26 06:24] Wave 2 — El 5xx post-débito era un tercer sitio con el mismo bug, en otro archivo

- **Error**: el barrido inicial de "qué status cobra" se hizo sólo sobre
  `routes/compose.ts`. El middleware quedaba fuera.
- **Causa raíz**: el hallazgo habla de `/compose`, pero el débito no vive en la ruta:
  vive en `middleware/a2a-key.ts`, y ahí el read del header `x-a2a-remaining-budget`
  corre **después** de un débito exitoso, dentro del `try` cuyo `catch` devuelve
  **503 SERVICE_ERROR**. Un fallo de ese read (un `getBalance` a Postgres) cobraba al
  caller y no ejecutaba nada — por un header de conveniencia. Y estaba **triplicado**:
  path master (`:1231`), delegación (`:772`) y sesión (`:993`).
- **Fix**: el read pasó a best-effort en los tres branches: si falla, el header se omite,
  se loguea `a2a-key.remaining-budget-header.skip` y el request sigue. El que pagó recibe
  la ejecución que pagó. Se eligió esto en vez de "refundear antes del 503" porque
  refundear en ese `catch` habría requerido un flag para distinguir errores pre-débito de
  post-débito — y acreditar por un error pre-débito **infla el budget**, un bug peor que
  el que se arregla. Los otros 503 de ese `catch` (`lookupByHash` / `debit` que tiran,
  ambos sin cobro) quedan intactos, verificado por los tests BLQ-3 existentes.
- **Aplicar en**: al mapear "qué status cobra", seguir el **débito**, no la ruta. Y
  cuando se agregue un refund en un `catch` amplio, verificar primero que el débito
  realmente ocurrió: un credit sin débito previo es inflación de budget.

---

## Deuda técnica abierta (wave 2)

### TD-188-5 — La validación corre antes de la autenticación

Consecuencia aceptada de la dirección (a): un request no autenticado con body malformado
recibe 400 en vez de 402, y un caller anónimo puede aprender el límite de 5 steps. Es
validación de shape pura — sin DB, sin discovery, sin amplificación — y el gate de auth
sigue intacto para bodies bien formados (`AC-19`). Alternativa descartada: partir
`requirePaymentOrA2AKey` en dos preHandlers (auth | débito) para meter la validación en
el medio. Es el diseño correcto a futuro pero es un refactor del middleware que atiende
a `/compose`, `/gasless` y `/orchestrate*` — desproporcionado para un fix P1.

### TD-188-6 — El 500 por un throw de `composeService.compose` sigue cobrando el step-0, y está BIEN

Analizado explícitamente, no omitido. `compose()` envuelve el invoke de cada step en
try/catch y devuelve `{success:false}`, pero la sección **pre-invoke** de cada iteración
(`resolveAgent`, `getStepGasOverheadUsd` con su fail-closed de mainnet,
`normalizeDestination`) puede tirar y escapar → 500 sin refund.

No se agregó un credit-back ahí, por dos razones:

1. Para el **step 0** esas tres precondiciones ya se evalúan ANTES del débito, en
   `resolveComposePriceHandler` (`resolveAgentPriceUsdc`/`resolveAgentDestination` → 404,
   `resolveStep0GasOverheadUsd` → 503). O sea que un throw del step 0 es una race muy
   angosta (el agente desaparece entre el preHandler y `compose()`).
2. Para **i > 0** el throw ocurre después de que los steps 0..i-1 se invocaron y
   settlearon: el débito del step-0 **está ganado**. Reembolsarlo a ciegas sería
   sobre-reembolsar y rompería la invariante "lo que ejecuta se cobra igual" — un revenue
   leak, o sea el bug espejo.

Un refund correcto necesitaría el `totalCostUsdc` parcial, que un throw no trae. El fix
de raíz es que `composeService.compose` **nunca tire** y devuelva
`{success:false, totalCostUsdc}` también en el error inesperado. Es un cambio de contrato
del service, fuera del alcance de un fix P1 de ruta.

### TD-188-7 — El 504 puede dejar el refund del step-0 en carrera con el per-step del service

En el camino `reply.sent` post-compose, `refundComposeStep0` reembolsa el step-0 mientras
el propio `composeService` ya hizo sus refunds per-step. Los montos no se solapan (el
step-0 lo debita el middleware; el guard `i > 0` de `compose.ts:208` es la única defensa
contra el double-debit, y sigue en pie), así que no hay doble refund. Queda anotado
porque es el punto exacto donde un cambio futuro en el billing per-step podría
introducirlo, y la fórmula `max(0, debitado − totalCostUsdc)` es lo único que lo evita.

---

## FIX-PACK POST-AR (2026-07-26) — errores propios encontrados por el AR

### [2026-07-26 07:00] Wave 2 — BLQ-MED-1: puse el credit-back en un lugar donde Fastify nunca lo ejecuta

- **Error**: el credit-back del "504 post-débito" lo escribí como primera línea del route
  handler de `/compose` (`if (reply.sent) { await refundComposeStep0(request, 0); return; }`).
  **Nunca se ejecutó**: coverage v8 sobre las 3197 pruebas dio 0 hits en esas líneas, y
  con latencia inyectada en el RPC de débito el balance bajaba 10 → 9.5 sin refund. Peor:
  documenté ese caso como "DESPUÉS: NO cobra (credit-back completo)" en el mapa de status
  del work-item. Declaré resuelto algo que seguía roto.
- **Causa raíz**: asumí que el route handler corre siempre. **No corre si la reply ya
  fue enviada**: `fastify/lib/handle-request.js:132` (`preHandlerCallback` →
  `if (reply.sent) return`) y `fastify/lib/hooks.js:407` (`hookIterator`, que también
  saltea los preHandlers que falten). Y el 504 lo manda el timer de
  `middleware/timeout.ts:12-20` desde FUERA del lifecycle, justo cuando el débito ya
  ocurrió. O sea: **el único caso que el guard tenía que cubrir es exactamente el caso en
  el que el guard no corre.** El otro `if (reply.sent)` (post-`compose()`) sí funciona,
  pero por un motivo distinto: ahí el handler ya estaba en ejecución.
- **Fix**: mover el refund al middleware, donde el débito ocurrió. La ruta le pasa el
  credit-back como hook (`requirePaymentOrA2AKey(x402Opts, { onDebitOrphaned })`,
  `routes/compose.ts:596-613`) y el middleware lo invoca en `refundIfDebitOrphaned`
  (`middleware/a2a-key.ts:583-591`) al final de los tres branches que debitan (master
  `:1316`, delegación `:839`, sesión `:1065`), después del último I/O real. El bloque
  inalcanzable se **borró** (`compose.ts:632-640` explica por qué, para que nadie lo lea
  como protección). Tests T-NOCHARGE-13/14 con latencia inyectada; mutación (quitar el
  call del branch master) → fallan con `balance=9.5, debits=1, credits=0`.
- **Por qué NO un hook `onResponse`/`onSend`** (la otra vía que sugirió el AR): esos
  corren cuando la respuesta sale, y la respuesta puede salir **mientras el RPC de débito
  está en vuelo**. Acreditar ahí es una carrera: se acredita antes de que el débito
  aterrice y, si ese débito termina fallando (rollback por `INSUFFICIENT_BUDGET` /
  `DEST_CAP_EXCEEDED`), queda un credit sin débito → **budget inflado**, que es peor que
  el bug original. Además exigía un flag (`composeExecuted`) que alguien puede olvidar de
  setear: el bug espejo. La vía elegida no agrega estado y sólo corre con el débito ya
  confirmado. T-NOCHARGE-15 fija la contra-prueba: 504 **pre**-débito → `debit=0 credit=0`.
- **Aplicar en**: CUALQUIER lógica compensatoria (refund, credit, unlock, rollback,
  liberar reserva) que se escriba dentro de un route handler cuando el cobro ocurre en un
  preHandler. Regla operativa: **la compensación vive en la misma capa que el efecto que
  compensa.** Y verificación mínima obligatoria: si escribís una rama que sólo corre en
  una condición de carrera, medí su coverage — 0 hits sobre la suite completa significa
  que no existe. `/gasless/transfer` (MNR-1) y los `if (reply.sent) return;` de
  `routes/orchestrate.ts:98,124,205,221,358,430` son los próximos candidatos a revisar
  con esta lente — **ya dimensionados por el re-AR: impacto monetario CERO salvo un
  residual acotado, ver la entrada `[07:55]` al final de este archivo. No es un "cobra
  sin ejecutar".**

### [2026-07-26 07:05] Wave 2 — Corregí el mapa de status en las DOS direcciones

- **Error**: la fila "504 timeout antes de compose | ANTES: cobra, sin refund" era falsa
  para el caso **pre**-débito (ahí Fastify saltea el middleware de pago entero, así que
  nunca hubo cobro: AR-P1 midió balance 10 → 10) y ocultaba el caso **post**-débito, que
  sí cobraba y seguía cobrando.
- **Causa raíz**: metí dos ventanas distintas (pre y post débito) en una sola fila, y
  llené el "ANTES" por razonamiento sobre el código en vez de medirlo.
- **Fix**: dos filas separadas en el mapa (`work-item.md`), cada una con su test
  (T-NOCHARGE-15 para la pre-débito, T-NOCHARGE-13/14 para la post-débito) y una nota
  explícita de la corrección.
- **Aplicar en**: cualquier tabla "antes/después" de money-path. Cada fila necesita un
  test que la sostenga; si no hay test, la fila dice "no medido", no "no cobra".

### [2026-07-26 07:10] Wave 2 — MNR-2: al adelantar la validación dejé el guard de layer 1 sin ninguna prueba

- **Error**: `validateComposeBodyHandler` (layer 0) volvió inalcanzable vía HTTP la rama
  "step malformado" de `augmentX402ChallengeAmount`, y al reescribir
  `T-ROUTE-X402-AMT-5` perdí la única prueba que la tocaba. Quedó 0% de cobertura en un
  guard que mi propio comentario declara conservar como defense-in-depth.
- **Causa raíz**: cuando adelantás una validación, los guards de más abajo dejan de
  recibir tráfico. La prueba vía HTTP muere con ellos, y "el comentario dice que sirve" no
  es una verificación.
- **Fix**: `export` de la función (sólo para test) + T-ROUTE-X402-AMT-7/8 en unit, que
  llaman la función directo con un step malformado y con un pipeline de costo 0.
  Verificado por coverage: las líneas 245/246/256 de `routes/compose.ts` ya no figuran
  como no cubiertas.
- **Aplicar en**: cada vez que un fix vuelva inalcanzable un guard existente, decidir
  explícitamente: o se borra (como el `if (reply.sent)` de BLQ-MED-1), o se prueba en
  unit. No hay tercera opción: un guard defensivo sin test se rompe en silencio.

### [2026-07-26 07:15] Wave 1 — MNR-3: mi aserción de "no filtra el largo" era un falso positivo esperando ocurrir

- **Error**: `expect(body).not.toContain(String(FAKE_SECRET.length))`, o sea "el body no
  contiene la cadena `51`". Cualquier campo futuro con un 51 (un precio, un id, un
  timestamp) rompía el test con el mensaje engañoso `leaks the credential length`.
- **Causa raíz**: chequeé una propiedad de un CAMPO (¿algún campo revela el largo?)
  buscando substring en el body serializado.
- **Fix**: `expectNoSecretLength` recorre los escalares del payload con su path y compara
  por campo: ningún número igual al largo, ningún string igual a `"51"`, ningún string con
  exactamente el largo del secreto (caza una máscara tipo `'*'.repeat(len)`).
  **Empíricamente probado en las dos direcciones**: con un `agent_endpoint`
  `https://example.com/agents/51/{slug}` la aserción vieja falla (`not to contain '51'`) y
  la nueva pasa; con un campo `authMasked: '*'.repeat(51)` inyectado en
  `toRegistryPublic`, la nueva falla con
  `$.registries[0].authMasked: has exactly the credential length (mask?)`.
- **Aplicar en**: cualquier aserción de "no filtra X" sobre un body serializado. Buscar
  substring en el JSON entero sirve para el secreto literal y sus derivaciones largas
  (prefijo, sufijo, hash) — NO para valores cortos (largos, contadores, ids), que hay que
  comparar campo por campo.

### [2026-07-26 07:20] Wave 1 — MNR-4: afirmé una garantía de compilación que el compilador no da

- **Error**: el docstring de `RegistryPublic` decía *"it is what makes the compiler reject
  `reply.send(internalRegistryRow)`"*. Es falso: `reply.send` está tipado
  `send(payload?: unknown)`, así que `reply.send(await registryService.getEnabled())`
  compila sin chistar. El AR lo verificó.
- **Causa raíz**: extrapolé el resultado real (el `tsc` falló cuando pasé la fila interna
  a un slot **tipado** `RegistryPublic`) a un sink que no está tipado. Peor: mi propio
  TD-188-4 ya lo decía bien — el comentario del código contradecía la deuda documentada.
- **Fix**: el docstring ahora enumera dónde SÍ muerde el guard (slot tipado → TS2741,
  `RegistryPublic[]` → TS2741, retorno `Promise<RegistryPublic[]>` → TS2322, spread →
  TS2375 por `auth?: never`) y dónde NO (`reply.send`, que acepta `unknown`), y remite al
  guard runtime `T-RRED-05` como la defensa real en el sink.
- **Aplicar en**: nunca escribir "el compilador rechaza X" sin haber compilado X. Un
  comentario que promete una garantía inexistente es peor que no tener comentario: el
  próximo dev se apoya en ella.

### [2026-07-26 07:50] Wave 2 — MNR-4b (re-AR MENOR-2): la afirmación de alcance era MÁS CHICA que el barrido real, por tercera vez

- **Error**: `work-item.md:214-216` decía *"sin `onDebitOrphaned` el middleware se
  comporta byte-idéntico a antes, así que `/gasless/transfer` y `/orchestrate*` no
  cambian"*. Es cierto **sólo** para el delta `1d90929..1b4a92d` (el commit del hook).
  Para `main...HEAD` es **falso**: el otro cambio del branch en el mismo middleware
  —`getBalance` pasó a best-effort `.then/.catch` en `a2a-key.ts:826` (delegación),
  `:1049` (sesión) y `:1286` (master)— **sí** cambia el comportamiento de
  `/gasless/transfer`, los tres `/orchestrate*`, las tres mutaciones de `/registries` y
  `/tasks`: un fallo de ese read antes devolvía **503 `SERVICE_ERROR`** y mataba el
  request; ahora omite el header `x-a2a-remaining-budget` y el request sigue.
- **Causa raíz**: escribí la afirmación mirando el diff del commit que estaba haciendo,
  no el diff del branch. Es el MISMO patrón que MNR-4 (afirmar una garantía sin
  ejecutarla) y que el primer error de la Wave 1 (barrido incompleto): **la tercera vez
  en la sesión que una afirmación de alcance sale más angosta que el barrido real**.
- **Fix**: la afirmación quedó acotada al delta del commit y al lado, en el mismo lugar,
  el alcance NO cubierto: sección **"Cambio de contrato (no-`/compose`)"** en
  `work-item.md`, que enumera las **12 rutas** afectadas, aclara que el cambio **falla
  seguro** (el header es informativo, se emite DESPUÉS del débito, no se saltea ningún
  check de auth/scoping/budget), que **ningún test asertaba el 503 viejo** (la suite
  quedó verde sin tocar esas suites) y que un consumidor del header **debe tolerar su
  ausencia** (no verificado contra `wasiai-v2`, fuera del working directory). La fila
  503 del mapa de status también dejó de citar líneas viejas (`1231/772/993`) y ahora
  dice explícitamente que el cambio no es sólo de `/compose`.
- **Aplicar en**: toda frase de la forma "X queda intacto". Regla operativa: **el
  alcance se afirma contra el diff del BRANCH (`git diff main...HEAD`), no contra el del
  commit**, y se escribe con el alcance no cubierto declarado al lado (misma sección,
  misma tabla). Si sólo se verificó el commit, la frase lleva el rango pegado
  ("vale para `a..b`"), porque un revisor futuro que lea "intacto" NO va a auditar ese
  delta — que es exactamente lo que pasó acá.

### [2026-07-26 07:25] Wave 1 — MNR-5: acuñé un tipo "HTTP-safe" que seguía exponiendo el tenant

- **Error**: `RegistryPublic` incluía `ownerRef`, y `GET /registries` es público sin auth.
  La convención del propio repo lo prohíbe explícitamente (`types/index.ts:982-984`,
  WKH-141/CD-6: "SOLO campos no sensibles — NUNCA ownerRef/...").
- **Causa raíz**: al portar el tipo copié los campos de `RegistryConfig` uno a uno y
  revisé sólo el campo que estaba cazando (`auth.value`). Un tipo que se llama "Public"
  merece un pase por TODOS sus campos contra la convención, no sólo por el del hallazgo.
- **Fix**: `ownerRef` fuera de `toRegistryPublic` (`services/registry.ts:123-139`); los
  dos consumidores internos que lo necesitaban (los guards de ownership de `update` y
  `delete`) pasaron a `getWithSecrets(id)` — misma query, resultado que nunca cruza HTTP.
  Tests: T-RRED-01 (el body de `GET /registries` no contiene `tenant-A`), T-RED-02,
  T-RED-09b (allowlist cerrado) y la contra-prueba T-RED-11 (la fila interna SÍ trae
  `ownerRef`, así que los asserts no pasan por vacuidad).
- **Aplicar en**: cuando definís una proyección pública, revisá campo por campo contra la
  lista de campos prohibidos del repo. "Es pre-existente" no es defensa: el momento de
  dropearlo es cuando estás escribiendo el tipo que decide qué sale.

### [2026-07-26 07:30] Hallazgo derivado (NO tocado): `/gasless/transfer` cobra sin transferir

- **Qué**: `routes/gasless.ts:181-189` y `:214-223` corren DESPUÉS del débito del
  middleware y devuelven error con **cero refunds**. Es MNR-1 del AR: **pre-existente y
  con HU propia abierta**, deliberadamente NO tocado en este fix-pack.
- **Dos lecciones que ese fix debería heredar**:
  1. **Helper de refund reusable.** `refundComposeStep0` ya resuelve lo difícil (routing
     al ledger correcto según master/delegación/sesión, `owner_ref` en las 4 variantes de
     credit, encolado en `refundOutbox` cuando el credit no revirtió nada, best-effort que
     nunca rompe el response). Duplicarlo a mano para gasless es garantía de que a alguna
     variante le va a faltar el `owner_ref` o el outbox.
  2. **La trampa de BLQ-MED-1.** Si ese refund se escribe en el route handler de gasless,
     no va a correr para el 504 post-débito — igual que acá. `/gasless/transfer` usa el
     MISMO `createTimeoutHandler` + el MISMO débito en preHandler, así que hereda la misma
     ventana. El hook `onDebitOrphaned` de `requirePaymentOrA2AKey` ya está disponible
     para pasarle su propio credit-back (`gaslessEstimatedCostUsd`).

---

## FIX-PACK 2 POST-re-AR (2026-07-26) — los 2 MENORes del re-AR aprobado

### [2026-07-26 07:45] Wave 2 — MENOR-1: cubrí con tests el branch que ya conocía y dejé los otros dos sin red

- **Error**: el fix de BLQ-MED-1 tiene **tres** call-sites (`a2a-key.ts:1316` master,
  `:839` delegación, `:1065` sesión) y escribí tests (T-NOCHARGE-13/14) sólo para el
  master. El re-AR lo probó por mutación: **reemplazó las líneas `:839` y `:1065` por un
  comentario y la suite completa quedó VERDE** (`3203 passed | 11 skipped`). Correlato en
  coverage: las ramas `creditDelegation` (`compose.ts:343`) y `creditSession` (`:352`) de
  `refundComposeStep0` tenían **0 hits de branch** (v8 `branchMap` ids 20 y 21, counts
  `[0,7]`). O sea: dos de los tres branches del money-path sin ninguna protección.
- **Causa raíz**: asumí que los tres call-sites son "el mismo código llamado tres veces".
  No lo son: cada branch **debita por un RPC distinto** (`debitDelegationAndParent` /
  `debitSessionAndParent`, dual-ledger) y **reembolsa por una rama distinta** del
  ternario de `refundComposeStep0`. Un test del master no ejercita ni el débito ni el
  refund de los otros dos. Y el bug que este fix-pack corrige (BLQ-MED-1) existió
  **precisamente** porque nadie miró la cobertura del fix: repetir la omisión en el
  mismo fix es el error espejo.
- **Fix**: T-NOCHARGE-16 (delegación, `x-a2a-key: wasi_a2a_session_*`) y T-NOCHARGE-17
  (key-session, `wasi_a2a_sess_*`) en
  `src/routes/compose.no-charge-on-validation-error.test.ts`, espejo de T-NOCHARGE-13:
  `TIMEOUT_COMPOSE_MS=1` + 40ms de latencia inyectada en el RPC dual-ledger de cada
  service → el 504 sale con el débito en vuelo. Assertan **balance antes/después** (no el
  status), que `composeService.compose` **nunca** se llamó, que el refund fue al MISMO
  ledger que debitó (`creditDelegation`/`creditSession`, NO `credit` master: un credit
  master dejaría `total_spent`/`spent_usd` inflado → self-DoS de la credencial, el M1 de
  la auditoría) y el `owner_ref` en la posición 2 (ownership guard, CLAUDE.md). Los mocks
  de `creditDelegation`/`creditSession` pasaron de `mockResolvedValue({success:true})` a
  mover el balance de verdad: si no, "cobró y reembolsó" sería indistinguible de "cobró y
  se lo quedó".
- **Verificado por mutación (los dos, uno por vez)**:
  - comentando `a2a-key.ts:839` → **sólo** T-NOCHARGE-16 rojo:
    `waitFor timeout: ... (branch delegación) (balance=9.5, ..., delegationDebits=1,
    delegationCredits=0)`. T-NOCHARGE-17 siguió verde ⟹ el test apunta a SU línea.
  - comentando `a2a-key.ts:1065` → **sólo** T-NOCHARGE-17 rojo:
    `(balance=9.5, ..., sessionDebits=1, sessionCredits=0)`.
  El mensaje de `waitFor` se extendió con los contadores de los tres ledgers: con sólo
  los del master reportaba `debits=0 credits=0` y parecía "no se cobró nada" cuando el
  balance ya estaba en 9.5 — un diagnóstico engañoso en el fallo.
- **Aplicar en**: cuando un fix se aplica en N call-sites, **N tests y N mutaciones**. La
  pregunta no es "¿el mecanismo funciona?" sino "¿qué línea exacta pongo en rojo?". Si
  borrar una línea del fix no rompe ningún test, esa línea está indefensa ante la próxima
  refactorización. Vale especialmente para los branches delegación/sesión: son la copia
  menos ejercitada del money-path y ya acumulan historial (H1 del audit 2026-07-01,
  WKH-125/125b, M1 del refund dual-ledger).

### [2026-07-26 07:55] Wave 2 — Dimensión correcta del hallazgo de `orchestrate.ts` (anotado, NO arreglado)

Lo midió el re-AR y **bajó la severidad**: es **BLQ-BAJO/MENOR**, no ALTO. Queda anotado
acá para que nadie lo lea como "otro `/compose`":

- `:98`, `:205`, `:358` — inalcanzables (mismo motivo que BLQ-MED-1: Fastify no invoca el
  handler si `reply.sent`) pero de **impacto monetario CERO**: las tres rutas
  `/orchestrate*` setean `skipMiddlewareDebit`, así que a esa altura **este middleware no
  debitó nada**. El débito real ocurre después, DENTRO del service
  (`services/orchestrate.ts:1138`).
- `:221` — contrato de cero débito (`/orchestrate/plan` es una cotización).
- `:124` y `:430` — **alcanzables** y retornan sin refund, pero el service ya corre su
  propio credit-back para `!pipeline.success` (`services/orchestrate.ts:1304-1355`).
- **Residual real**: 504 con **pipeline exitoso**. Y ahí el pipeline **sí corrió y
  settleó downstream**, o sea que **no es "cobra sin ejecutar"**: es "cobra, ejecuta, y el
  caller no puede recuperar el output". El delta contra `/compose` es el sobrante del
  estimate + el gas overhead. No se toca en este fix-pack (HU propia).

### [2026-07-26 07:56] Wave 2 — Residual MNR-3 del re-AR: la ventana entre el débito y `refundIfDebitOrphaned`

Anotado por completitud, **hoy inalcanzable**: si algo tirara entre el débito exitoso y
la llamada a `refundIfDebitOrphaned`, el refund no correría (el `throw` iría al `catch`
del branch → 503, con el débito aplicado y sin credit-back). Hoy no puede pasar — lo que
hay entre esos dos puntos es, verificado línea por línea:

- `receiptService.emit(...)` (sólo path master, `a2a-key.ts:1256-1274`):
  **fire-and-forget** — NO se `await`ea y tiene `.catch`, así que no puede escapar.
- `isIdentityVerified` + los `buildDelegationEffectiveRow`/`buildSessionEffectiveRow` y
  las asignaciones a `request.*`: síncronos y puros (sin I/O).
- `budgetService.getBalance(...)` (los tres branches, `:826`, `:1049`, `:1286`): el único
  `await` de I/O, y desde este fix-pack tiene `.then/.catch` (best-effort) — un rechazo
  se traga en el `.catch`, y `getBalance` no puede tirar sincrónicamente (es `async`).

Se documenta porque es el punto exacto donde un `await` nuevo SIN `.catch`
reintroduciría el bug de BLQ-MED-1: **cualquier I/O que se agregue entre el débito y
`refundIfDebitOrphaned` debe ser best-effort**, o el refund tiene que moverse a un
`finally`.
