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
| `get(id)` | `RegistryPublic \| undefined` | HTTP, checks de existencia, guards de ownership internos (leen `ownerRef`) |
| `register()` / `update()` | `RegistryPublic` | HTTP |
| `getWithSecrets(id)` | `RegistryConfig \| undefined` | sólo `discovery` (header outbound) |
| `getEnabled()` | `RegistryConfig[]` | sólo fanout outbound + `resolveAuthSchemes` |

### Cambio de contrato (breaking, deliberado)

El campo `auth` desaparece del body de los 4 endpoints. Un consumidor que leía
`auth.key` (nombre del header, no secreto) pierde ese dato. Se eligió **no** exponerlo:
mínimo privilegio, y para `bearer`/`query` es redundante. Ver TD-188-1.

### Tests (22 nuevos)

- `src/services/registry.redaction.test.ts` (11) — T-RED-01..10: un test por read-path
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
del outbox**, y se llama desde tres sitios (`compose.ts:610,655,674`).

### Mapa completo: qué status cobra, antes y después

Path prepago a2a-key, `/compose`. "Cobra" = el balance del caller queda decrementado al
terminar el request.

| Status | Causa | Dónde se decide | ANTES | DESPUÉS |
|---|---|---|---|---|
| **400** `steps` vacío/ausente | shape | handler → ahora preHandler `compose.ts:578` | **COBRA $1** (placeholder) | **NO cobra** |
| **400** >5 steps | shape | idem | **COBRA** precio step-0 | **NO cobra** |
| **400** step con `agent` no-string | shape | idem | **COBRA** precio step-0 | **NO cobra** |
| **504** timeout antes de compose | timer | `compose.ts:609` | **COBRA**, sin refund | **NO cobra** (credit-back completo) |
| **504** timeout durante compose | timer | `compose.ts:654` | **COBRA**, sin refund | **cobra sólo lo settleado** (`max(0, debitado − totalCostUsdc)`) |
| **503** `SERVICE_ERROR` por el read del header `x-a2a-remaining-budget` post-débito | `middleware/a2a-key.ts:1231` (y `772`, `993`) | **COBRA**, sin refund, sin ejecutar | **no aplica**: el read pasó a best-effort → el header se omite y el pipeline corre (el que pagó recibe lo que pagó) |
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

### Tests (13 nuevos)

`src/routes/compose.no-charge-on-validation-error.test.ts` (12) —
T-NOCHARGE-01..12, con el middleware de pago REAL y un balance en memoria (mismo
scaffold que `compose.no-debit-on-abort.test.ts`, porque `compose.test.ts` moquea el
middleware con un pass-through que nunca debita y por eso jamás pudo observar un cobro).
**Toda aserción de dinero compara el balance antes y después.**
Más `AC-19b` en `src/__tests__/e2e/e2e.test.ts`.

Verificado por mutación (tres, cada una restaurada):
- quitar `validateComposeBodyHandler` de la cadena → T-NOCHARGE-01..05 fallan;
  la de 01 falla con `expected 9 to be 10`, o sea señala directo el cobro de $1;
- quitar el credit-back del 504 post-compose → T-NOCHARGE-11 falla;
- volver el read del header a fatal → T-NOCHARGE-10 falla con `expected 503 to be 200`.

### Cambio de comportamiento a revisar

La validación ahora corre **antes de la autenticación/pago**, así que un request
**no autenticado con body malformado** devuelve **400** en vez de **402**. Era
inevitable: el caller x402 no tiene refund inbound (punto 2 de la justificación). El
gate de auth queda intacto para bodies bien formados. `AC-19` usaba `agentSlug` (¡no
`agent`!), o sea un body malformado, y obtenía el 402 por accidente: se corrigió el
payload para que pruebe lo que dice probar, y se agregó `AC-19b` para el nuevo
comportamiento. Detalle en `auto-blindaje.md`.
