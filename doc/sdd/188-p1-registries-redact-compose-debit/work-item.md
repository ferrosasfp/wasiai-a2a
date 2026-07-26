# Work Item — [188] Dos P1 de la sesión de pruebas profundas (2026-07-26)

Dos hallazgos independientes, en **dos waves con un commit cada una** para poder
revisarlos y revertirlos por separado.

- **W1 / HIGH-1** — `GET /registries` filtraba la credencial outbound en claro.
- **W2 / HIGH-2** — un `/compose` que responde 400 de validación cobra igual.

Branch: `fix/p1-registries-redact-compose-debit` (desde `main` @ `eb24a31`).

---

## WAVE 1 — HIGH-1: `/registries` filtra una credencial en claro

### Problema

`src/routes/registries.ts:53-59` devolvía `registryService.list()` **verbatim**.
`registryService.list()` mapeaba la fila de Postgres con `rowToRegistry`, que copia
`auth` completo — incluido `auth.value`, que es una **credencial outbound viva** usada
para autenticar el fetch a la marketplace remota (`discovery.ts:455-459`).

`GET /registries` es **público** (sin middleware de auth: el comentario del módulo dice
"GET sigue público — no rompe discovery"), así que la credencial salía en el body a
cualquiera. Confirmado en vivo contra producción por la sesión de pruebas profundas.

El mismo defecto estaba en los otros tres paths que devuelven filas de `registries`:
`GET /registries/:id`, y los echo-back de `POST /registries` (201) y
`PATCH /registries/:id` (200) — el PATCH re-emitía la credencial incluso cuando el
caller sólo tocaba `name`.

### Barrido exhaustivo de read-paths

Se buscó `registryService.list` / `.get` / `.getEnabled`, `from('registries')`, y todo
consumidor de `RegistryConfig` en `src/`, `packages/` y `mcp-servers/`:

| Consumidor | Fila con secreto? | Cruza HTTP? | Veredicto |
|---|---|---|---|
| `routes/registries.ts:54` `list()` → `GET /registries` | SÍ | SÍ, público | **LEAK — arreglado** |
| `routes/registries.ts:72` `get()` → `GET /registries/:id` | SÍ | SÍ, público | **LEAK — arreglado** |
| `routes/registries.ts:181` `register()` → `POST` 201 | SÍ | SÍ (autenticado) | **LEAK — arreglado** |
| `routes/registries.ts:263` `update()` → `PATCH` 200 | SÍ | SÍ (autenticado) | **LEAK — arreglado** |
| `services/discovery.ts:170,558` (filtro `query.registry`) | SÍ (lo necesita) | NO — la respuesta es `Agent[]` + `registries: string[]` | OK, migrado a `getWithSecrets` |
| `services/discovery.ts:173,561` `getEnabled()` (fanout) | SÍ (lo necesita) | NO — idem | OK, documentado |
| `routes/discover.ts` GET/POST `/`, GET `/:slug` | — | `DiscoveryResult` | OK — `registries` es `string[]` (`types/index.ts:294`, `discovery.ts:350`) |
| `routes/capabilities.ts:57` | — | reenvía `discover()` | OK por transitividad |
| `routes/agent-card.ts:67` `getEnabled()` | SÍ | sólo vía `resolveAuthSchemes` | OK — `agent-card.ts:83-96` mapea `auth.type` → `['bearer'\|'apiKey']`, nunca el valor |
| `services/compose.ts:826` `getEnabled()` | SÍ | NO — uso interno (pricing / gate `SYSTEM_OWNER_REF`) | OK |
| `routes/auth/identity.ts:84` `get()` | sólo chequea existencia | NO | OK, ahora recibe la versión redactada |
| `services/event.ts:120` `from('registries')` | `count: 'exact', head: true` — sin `data` | — | OK |
| `routes/auth/me.ts:31` `allowed_registries` | otra tabla (`a2a_agent_keys`), lista de nombres | — | fuera de alcance |
| `mcp-servers/` | no referencia `registries` (`mcp-servers/wasiai-x402/` sólo) | — | OK |
| `packages/agent-sdk` | `registries` como nombres en tipos del cliente | — | OK |

### Fix: redacción por construcción

1. **`types/index.ts` — `RegistryPublic`**: proyección HTTP-safe. Dos guards de
   compilación independientes hacen que `RegistryConfig` **no sea asignable**:
   - `auth?: never` (su `auth?: RegistryAuth | undefined` no entra en `never`);
   - `authConfigured: boolean` **requerido** (falta en `RegistryConfig`).

   No es un `delete row.auth.value`: el tipo que sale por HTTP no puede contener el
   secreto, así que el próximo endpoint no lo puede olvidar. Verificado: el primer
   `tsc --noEmit` tras el cambio falló con
   `TS2379 ... Property 'authConfigured' is missing in type 'RegistryConfig'` en el
   único sitio que pasaba la fila interna a un slot público.

2. **`services/registry.ts` — `toRegistryPublic()`**: único productor de
   `RegistryPublic`. Expone `authType` (esquema declarado) y `authConfigured`
   (¿hay credencial guardada?). **Nunca** prefijo, sufijo, largo ni hash del valor:
   todo eso acota el brute-force o permite confirmar un candidato offline.

3. **Nomenclatura del escape hatch**: los métodos que sí devuelven la credencial
   llevan el sufijo `WithSecrets` (`getWithSecrets`). `getEnabled()` conserva el
   nombre (blast radius de ~60 líneas de mocks en 6 suites) pero queda documentado
   como interno y cubierto por el guard genérico de tests.

| Método | Devuelve | Uso |
|---|---|---|
| `list()` | `RegistryPublic[]` | HTTP |
| `get(id)` | `RegistryPublic \| undefined` | HTTP y checks de existencia |
| `register()` / `update()` | `RegistryPublic` | HTTP |
| `getWithSecrets(id)` | `RegistryConfig \| undefined` | `discovery` (header outbound) + los guards de ownership internos, que leen `ownerRef` (MNR-5) |
| `getEnabled()` | `RegistryConfig[]` | sólo fanout outbound + `resolveAuthSchemes` |

### Cambio de contrato (breaking, deliberado)

El campo `auth` desaparece del body de los 4 endpoints. Un consumidor que leía
`auth.key` (nombre del header, no secreto) pierde ese dato. Se eligió **no** exponerlo:
mínimo privilegio, y para `bearer`/`query` es redundante. Ver TD-188-1.

**MNR-5 (post-AR):** también desaparece `ownerRef`. `GET /registries` es público sin
auth y la convención del propio repo lo prohíbe explícitamente (`types/index.ts:982-984`,
WKH-141/CD-6: "SOLO campos no sensibles — NUNCA ownerRef/..."): enumerar `owner_ref`
mapea qué tenant registró qué marketplace. Era pre-existente (`list()` ya lo devolvía),
pero acuñar el tipo público era el momento de dropearlo. Consumidores internos que lo
necesitaban: los guards de ownership de `registryService.update`/`delete`, migrados a
`getWithSecrets(id)` — misma query, resultado que nunca cruza HTTP (`services/registry.ts:319,416`).
Ningún route handler leía `registry.ownerRef` (barrido con grep sobre `src/`).

### Tests (23 nuevos)

- `src/services/registry.redaction.test.ts` (12) — T-RED-01..11: un test por read-path
  del service; `getWithSecrets`/`getEnabled` SÍ traen el secreto (documenta que el
  escape hatch es deliberado, y evita que los demás pasen por vacuidad); allowlist
  cerrado de claves de salida; **canario de compilación** con `@ts-expect-error` que
  falla el `tsc` si alguien relaja `RegistryPublic`.
- `src/routes/registries.redaction.test.ts` (6) — T-RRED-01..06: service REAL, sólo
  `lib/supabase.js` moqueado con una fila que trae la credencial. Un test por read-path
  HTTP **más el guard genérico T-RRED-05**, que recorre todos los GET que el plugin
  registra (hook `onRoute`, no una lista hardcodeada) y falla si cualquiera devuelve
  material del secreto. **Probado por mutación**: se inyectó un
  `GET /registries/leak-probe` que devolvía `getEnabled()` verbatim y T-RRED-05 falló
  con `GET /registries/leak-probe: leaks the credential`.
- `src/services/discovery.redaction.test.ts` (5) — T-DRED-01..05: `/discover` (con y
  sin filtro), `getAgent`, y `buildAgentCard`. Incluye contra-prueba T-DRED-03: el
  header outbound **sí** lleva `Bearer <secreto>`, así que las otras aserciones no
  pasan por vacuidad.

Los fixtures usan un valor **inventado** (`wasi_a2a_THIS_IS_A_FAKE_TEST_TOKEN_…`).
Ninguna credencial real aparece en código, test ni log.

### Fuera de alcance (explícito)

**NO** se rotó ni se tocó ninguna credencial, ni prod, ni envs. La credencial expuesta
sigue siendo válida hasta que el founder la rote: este fix sólo cierra el canal.

---

## WAVE 2 — HIGH-2: un `/compose` que responde 400 cobra igual

### Problema

El débito ocurre dentro de `requirePaymentOrA2AKey` (`middleware/a2a-key.ts:1106-1124`
en el path master; equivalentes en los branches de delegación y sesión), que es un
**preHandler**. Los tres checks de shape vivían SOLO en el **route handler**, que corre
después. El comentario original de `badStepIndex` lo admitía textualmente: *"This runs
AFTER the payment middleware, but a 400 here is the failure mode we want"*.

El credit-back que SÍ existía (AUDIT A1) estaba dentro de `if (!result.success)`, o sea
sólo para fallos del pipeline — un 400 de validación nunca llegaba ahí.

El peor caso: con `steps: []` el preHandler de precio no inyecta
`composeEstimatedCostUsd`, así que `resolveEstimatedCostUsd`
(`middleware/a2a-key.ts:534-540`) cae en `PLACEHOLDER_FEE_USD` y el caller pagaba
**$1 flat** por un body vacío. Medido: el test T-NOCHARGE-01 sobre el código pre-fix
falla con `expected 9 to be 10`.

### Decisión: (a) para la validación + (b) para lo que no se puede adelantar

**(a) — adelantar la validación al débito. Elegida para los tres 400.**

Justificación:

1. **Ninguna de las tres validaciones depende de nada que produzca el middleware.**
   Se verificó una por una: no leen `request.a2aKeyRow`, ni `resolvedChainId`, ni
   `composeEstimatedCostUsd`, ni `delegationContext`/`keySessionContext`. Son funciones
   puras del body. La objeción de la vía (a) no aplica acá.
2. **(b) NO puede cubrir al caller x402.** El bloque de credit-back está gateado en
   `request.a2aKeyRow` (`compose.ts:298-305`), así que un caller x402 — que settlea su
   pago inbound on-chain — **no tiene refund posible**. Si se emitiera el 402, el caller
   pagara y después llegara el 400, esa plata no se puede devolver. La única defensa
   para ese path es rechazar ANTES de cobrar. Esto es lo que decide la elección: (a) no
   es sólo "más limpio", es la única que cubre los dos paths de pago.
3. Sin ventana en la que el balance baja y sube, y sin la llamada de discovery del
   step-0 para un body que se va a rechazar.

Implementación: `validateComposeBody()` (función pura, `compose.ts:123-150`) +
`validateComposeBodyHandler` (`compose.ts:160-169`), registrado en la cadena de
preHandlers en `compose.ts:578`, ANTES de `resolveComposePriceHandler` y de
`requirePaymentOrA2AKey`. El handler sigue llamando la MISMA función pura
(`compose.ts:666`) como defense-in-depth, para que un reordenamiento futuro de la
cadena no reabra el agujero de input no validado que cerró BLQ-MEDIO-1.

**(b) — credit-back para los caminos post-débito que no se pueden adelantar.**

Se reusa el mecanismo de **WKH-127** (`doc/sdd/125-wkh-127-orchestrate-billing/`):
`budgetService.credit` / `creditWithDest` / `creditDelegation` / `creditSession`
(`services/budget.ts:445,495,556,...`) + encolado en `refundOutbox` cuando el refund no
revirtió nada. NO se inventó un mecanismo nuevo: el bloque inline de AUDIT A1 se extrajo
a `refundComposeStep0()` (`compose.ts:294`) **sin cambiar la matemática ni los `reason`
del outbox**, y se llama desde tres sitios: `!result.success` (`compose.ts:703`), el 504
DURANTE compose (`compose.ts:683`) y el **débito huérfano**, que NO vive en el route
handler (ver abajo).

**(b2) — BLQ-MED-1 del AR: el credit-back del 504 post-débito NO puede vivir en el
route handler.**

Primera versión de este fix-pack: `if (reply.sent) { refundComposeStep0(request, 0) }`
como primera línea del handler. Era **código inalcanzable** — el AR lo probó con
coverage v8 sobre las 3197 pruebas (0 hits) y con dos repros con latencia inyectada
(`debit=1 credit=0`, balance 10 → 9.5). Causa raíz: cuando el timer de
`createTimeoutHandler` (`middleware/timeout.ts:12-20`) manda el 504 desde FUERA del
lifecycle, Fastify **no invoca el handler** (`fastify/lib/handle-request.js:132`
`preHandlerCallback` → `if (reply.sent) return`) ni los preHandlers que falten
(`fastify/lib/hooks.js:407` `hookIterator`).

Vía elegida: **(a) del AR** — el refund se dispara DENTRO del middleware, en el único
punto donde el débito está confirmado aplicado y todavía es reversible. Para no
cablear lógica de `/compose` en un middleware compartido, la ruta le PASA el
credit-back: `requirePaymentOrA2AKey(x402Opts, { onDebitOrphaned })`
(`routes/compose.ts:596-613`), y el middleware lo invoca vía `refundIfDebitOrphaned`
(`middleware/a2a-key.ts:583-591`) al final de los **tres** branches que debitan:
master (`a2a-key.ts:1316`), delegación (`:839`) y sesión (`:1065`).

Por qué (a) y no (b) (hook `onResponse` + flag `composeExecuted`):

1. **(b) tiene una carrera que puede INFLAR el budget.** El 504 puede salir mientras
   el RPC de débito está en vuelo (es exactamente el repro AR-P3). Un hook de
   respuesta acreditaría ANTES de que el débito aterrice; si ese débito después falla
   (`INSUFFICIENT_BUDGET`, `DEST_CAP_EXCEEDED` → rollback), el credit queda sin débito
   que revertir. Inflar el budget es peor que el bug original.
2. **(a) no agrega estado nuevo** — ni flag que alguien pueda olvidar de setear (el bug
   espejo que el AR marcó para (b)), ni request-decorator nuevo.
3. **El hook está gateado por construcción a `/compose`**: sin `onDebitOrphaned`,
   `refundIfDebitOrphaned` es un no-op. **Alcance de esta afirmación (corregido, re-AR
   MENOR-2): vale para el delta `1d90929..1b4a92d` (el hook), NO para `main...HEAD`.**
   El OTRO cambio de este branch en el mismo middleware —`getBalance` pasó a
   best-effort (`.then/.catch`) en `a2a-key.ts:826`, `:1049`, `:1286`— **sí** cambia el
   comportamiento de las otras **12 rutas** que usan `requirePaymentOrA2AKey`
   (`/gasless/transfer`, los tres `/orchestrate*`, las tres mutaciones de `/registries`
   y las cinco de `/tasks`): ver "Cambio de contrato" abajo. `/gasless/transfer`
   (MNR-1, HU aparte) no gana ni pierde credit-back; `/orchestrate*` tampoco (setean
   `skipMiddlewareDebit`, así que este middleware no debita).

4. **No hay doble refund**: (b2) sólo corre si `reply.sent` era true al terminar el
   middleware, y en ese caso Fastify saltea el handler → los otros dos call-sites no
   pueden ejecutarse. Son mutuamente excluyentes por el mismo `reply.sent`.

Ventana cubierta: desde el inicio del débito hasta el final del middleware (incluye el
read del header `x-a2a-remaining-budget`, que es el último I/O real). Entre ese punto y
el handler Fastify sólo corre microtasks (`hookRunner` → `handleResolve` → `next()`), y
una microtask no le da lugar al event loop para disparar un `setTimeout`: no queda
ventana descubierta. El `if (reply.sent)` que quedaba inalcanzable se **borró**
(`compose.ts:632-640` documenta por qué, en vez de dejar una falsa protección).

#### Cambio de contrato (no-`/compose`): `x-a2a-remaining-budget` puede faltar

Alcance NO cubierto por la afirmación del punto 3, declarado acá al lado (re-AR
MENOR-2). Antes, si el read post-débito del header fallaba, el `catch` del branch
devolvía **503 `SERVICE_ERROR`** y el request moría (con el débito ya aplicado en
`/compose`, o sin débito en las rutas con `skipMiddlewareDebit`). Ahora el header se
**omite**, se loguea `a2a-key.remaining-budget-header.skip` y el request **sigue**:

- **`/compose`** — la corrección buscada (fila 503 del mapa de abajo): el que pagó
  recibe la ejecución que pagó.
- **Las otras 12 rutas que usan el middleware** (`POST /gasless/transfer`;
  `/orchestrate`, `/orchestrate/plan`, `/orchestrate/execute`; `POST /registries`,
  `PATCH /registries/:id`, `DELETE /registries/:id`; y las 5 de `/tasks` — `POST /`,
  `GET /`, `GET /:id` y los dos `PATCH`) — efecto colateral **deliberado y fail-safe**:
  un caller que antes recibía 503 ahora recibe su respuesta normal **sin** el header
  `x-a2a-remaining-budget`. No se saltea ningún check de auth, de scoping ni de budget
  (el header es informativo y se emite DESPUÉS del débito). **Ningún test asertaba el
  503 viejo** (la suite quedó verde sin tocar esas suites), así que no hay contrato de
  test roto — pero un consumidor que lea el header **debe tolerar su ausencia**. No
  verificado contra `wasiai-v2` (fuera del working directory de esta HU).

### Mapa completo: qué status cobra, antes y después

Path prepago a2a-key, `/compose`. "Cobra" = el balance del caller queda decrementado al
terminar el request.

> **Corrección post-AR (2026-07-26).** La versión anterior de esta tabla tenía UNA fila
> para "504 antes de compose" y estaba mal **en las dos direcciones**: metía en la misma
> bolsa el 504 **pre-débito** (que nunca cobró, ni antes ni después) y el 504
> **post-débito** (que cobraba y, con el fix inicial, SEGUÍA cobrando porque el
> credit-back estaba en código inalcanzable). Ahora son dos filas, cada una con su
> test. Un mapa que declara resuelto algo que no lo está es peor que no tener mapa.

| Status | Causa | Dónde se decide | ANTES | DESPUÉS |
|---|---|---|---|---|
| **400** `steps` vacío/ausente | shape | handler → ahora preHandler `compose.ts:578` | **COBRA $1** (placeholder) | **NO cobra** |
| **400** >5 steps | shape | idem | **COBRA** precio step-0 | **NO cobra** |
| **400** step con `agent` no-string | shape | idem | **COBRA** precio step-0 | **NO cobra** |
| **504** timeout **PRE-débito** (durante validación/precio) | timer | Fastify saltea el middleware de pago entero (`hooks.js:407`) | **NO cobra** (nunca cobró: la fila vieja que decía "COBRA" era FALSA — refutado por el AR con AR-P1) | igual — fijado ahora por T-NOCHARGE-15 |
| **504** timeout **DURANTE el débito** (o durante el read del header post-débito) | timer | `middleware/a2a-key.ts:1316` (`:839` deleg, `:1065` sesión) vía `onDebitOrphaned` | **COBRA, sin refund** — y el fix inicial NO lo arreglaba: su credit-back vivía en el route handler, que Fastify no invoca (0 hits en coverage) | **NO cobra** (credit-back completo desde el middleware) — T-NOCHARGE-13/14, probado por mutación |
| **504** timeout durante compose | timer | `compose.ts:683` | **COBRA**, sin refund | **cobra sólo lo settleado** (`max(0, debitado − totalCostUsdc)`) |
| **503** `SERVICE_ERROR` por el read del header `x-a2a-remaining-budget` post-débito | `middleware/a2a-key.ts:1286` (y `:826` deleg, `:1049` sesión) | **COBRA**, sin refund, sin ejecutar | **no aplica**: el read pasó a best-effort → el header se omite y el pipeline corre (el que pagó recibe lo que pagó). **Este cambio NO es sólo de `/compose`**: aplica a las 5 rutas que usan el middleware → ver "Cambio de contrato" arriba |
| 400 fallo de pipeline | `composeService` | `compose.ts:679` | cobra y **reembolsa** (AUDIT A1) | igual (byte-idéntico) |
| 402 `DEST_CAP_EXCEEDED` mid-pipeline | cap por destino | `compose.ts:683` | cobra y **reembolsa** | igual |
| 403 `SCOPE_DENIED` | scoping per-step | `compose.ts:681` | cobra y **reembolsa** | igual |
| 402 `DEST_CAP_EXCEEDED` en el débito | cap | `middleware/a2a-key.ts:1128` | **no cobra** (rollback del RPC) | igual |
| 403 `INSUFFICIENT_BUDGET` | débito falló | `middleware/a2a-key.ts:1161` | **no cobra** | igual |
| 404 `AGENT_NOT_FOUND` | agente inexistente | `compose.ts:440` (pre-débito) | **no cobra** | igual |
| 404 `AGENT_NOT_FOUND` (ghost, precio 0) | agente fantasma | `compose.ts:477` (pre-débito) | **no cobra** | igual |
| 503 `REGISTRY_UNAVAILABLE` | discovery tiró | `compose.ts:554` (pre-débito) | **no cobra** | igual |
| 403 `KEY_NOT_FOUND` / `KEY_INACTIVE` / 401 token inválido | auth | pre-débito | **no cobra** | igual |
| 503 por `lookupByHash` o `debit` que tiran | infra | `middleware/a2a-key.ts:1252` | **no cobra** (el débito no se aplicó) | igual |
| 422 | — | no existe en `/compose` (sólo en `/registries` y `/agents`) | n/a | n/a |
| **500** uncaught de `composeService.compose` | ver TD-188-6 | error boundary de Fastify | cobra el step-0 | **igual, y es CORRECTO** — ver TD-188-6 |
| 200 | happy path | `compose.ts:749` | cobra step-0 + per-step | **igual (invariante)** |

### Invariante verificado

"Un `/compose` que SÍ ejecuta cobra exactamente lo mismo que antes":
T-NOCHARGE-06 (1 step), T-NOCHARGE-07 (5 steps, el borde inclusive),
T-NOCHARGE-08 (fallo → reembolsa igual) y T-NOCHARGE-09 (fallo parcial → NO
sobre-reembolsa) assertan el monto exacto del débito y el balance final. No se tocó
ningún cálculo de precio: `resolveComposePriceHandler`,
`augmentX402ChallengeAmount`, `resolveStep0GasOverheadUsd` y la fórmula del refund
quedaron intactos.

### Tests (16 nuevos)

`src/routes/compose.no-charge-on-validation-error.test.ts` (15) —
T-NOCHARGE-01..15, con el middleware de pago REAL y un balance en memoria (mismo
scaffold que `compose.no-debit-on-abort.test.ts`, porque `compose.test.ts` moquea el
middleware con un pass-through que nunca debita y por eso jamás pudo observar un cobro).
**Toda aserción de dinero compara el balance antes y después.**
Más `AC-19b` en `src/__tests__/e2e/e2e.test.ts`.

Los tres de BLQ-MED-1 usan latencia inyectada en los mocks de datos para abrir la
ventana real (no simulan `reply.sent`):
- **T-NOCHARGE-13** — 40ms en el RPC de `debit` con `TIMEOUT_COMPOSE_MS=1` (repro AR-P3):
  504, débito aplicado, `composeService` NUNCA llamado, y el balance vuelve a 10.
- **T-NOCHARGE-14** — 40ms en el `getBalance` del header post-débito (repro AR-P2).
- **T-NOCHARGE-15** — contra-prueba anti-doble-refund: 40ms en el preHandler de precio →
  504 **pre**-débito → `debit=0 credit=0`, balance 10 → 10. Fija que el fix no acredita
  cuando no hubo cobro (el riesgo de "refundear de más" que tenía la vía (b)).

Verificado por mutación (cuatro, cada una restaurada):
- quitar `validateComposeBodyHandler` de la cadena → T-NOCHARGE-01..05 fallan;
  la de 01 falla con `expected 9 to be 10`, o sea señala directo el cobro de $1;
- quitar el credit-back del 504 post-compose → T-NOCHARGE-11 falla;
- volver el read del header a fatal → T-NOCHARGE-10 falla con `expected 503 to be 200`;
- quitar `refundIfDebitOrphaned` del branch master → T-NOCHARGE-13 y 14 fallan con
  `balance=9.5, debits=1, credits=0` (los MISMOS números que midió el AR).

### Cambio de comportamiento a revisar

La validación ahora corre **antes de la autenticación/pago**, así que un request
**no autenticado con body malformado** devuelve **400** en vez de **402**. Era
inevitable: el caller x402 no tiene refund inbound (punto 2 de la justificación). El
gate de auth queda intacto para bodies bien formados. `AC-19` usaba `agentSlug` (¡no
`agent`!), o sea un body malformado, y obtenía el 402 por accidente: se corrigió el
payload para que pruebe lo que dice probar, y se agregó `AC-19b` para el nuevo
comportamiento. Detalle en `auto-blindaje.md`.

---

## FIX-PACK POST-AR (2026-07-26) — 1 BLOQUEANTE + 4 MENORes

El AR **RECHAZÓ** el pase anterior. Wave 1 quedó verificada como cerrada (barrido
independiente de los read-paths, `getWithSecrets` y el canal de logs/telemetría: sin
leak). Todo lo de este fix-pack es Wave 2 + calidad de los guards.

| ID | Qué | Dónde quedó |
|---|---|---|
| **BLQ-MED-1** | El credit-back del 504 post-débito era código inalcanzable (Fastify no invoca el handler con la reply ya enviada) | `middleware/a2a-key.ts:545-591` + los 3 call-sites (`:839`, `:1065`, `:1316`) + `routes/compose.ts:596-613`; el bloque muerto borrado (`compose.ts:632-640`); T-NOCHARGE-13/14/15 |
| **MNR-2** | El guard de layer 1 de `augmentX402ChallengeAmount` quedó con 0% de cobertura al adelantarse la validación | función exportada SOLO para test (`compose.ts:208-215`) + T-ROUTE-X402-AMT-7/8 (unit) en `compose.test.ts` |
| **MNR-3** | `not.toContain(String(FAKE_SECRET.length))` = falso positivo esperando ocurrir (cualquier "51" futuro) | `expectNoSecretLength` compara CAMPO por campo (`routes/registries.redaction.test.ts:126-158`, `services/registry.redaction.test.ts:118-176`) |
| **MNR-4** | El docstring afirmaba que el tipo hace fallar `reply.send(row)` — es falso (`send` acepta `unknown`) | `types/index.ts:74-86` describe el alcance REAL (slots tipados / spread) y remite al guard runtime T-RRED-05 |
| **MNR-5** | `RegistryPublic` exponía `ownerRef` en un endpoint público | dropeado de `toRegistryPublic` (`services/registry.ts`), guards internos a `getWithSecrets`, + tests de que no sale (T-RRED-01, T-RED-02, T-RED-09b) y contra-prueba T-RED-11 |

**MNR-1 (fuera de alcance, no se tocó):** `/gasless/transfer` cobra sin transferir
(`routes/gasless.ts:181-189` y `:214-223` corren post-débito con 0 refunds). Es
pre-existente y tiene HU propia. Anotado como hallazgo derivado en `auto-blindaje.md`
con las dos lecciones que ese fix debería heredar: helper de refund reusable y la trampa
de BLQ-MED-1 (un refund en el route handler puede no correr nunca).

### Gates del fix-pack

- `tsc --noEmit`: 0 errores.
- `vitest run`: **3203 passed | 11 skipped** (baseline 3197 + 6: T-NOCHARGE-13/14/15,
  T-ROUTE-X402-AMT-7/8, T-RED-11).
- `biome check src/`: 0.
- Coverage v8 sobre `routes/compose.ts` + `middleware/a2a-key.ts`: las líneas que el AR
  reportó con 0 hits (el guard de `augmentX402ChallengeAmount`, el `pipelineUsd <= 0`)
  quedaron cubiertas; los 3 call-sites nuevos de `refundIfDebitOrphaned` también.
