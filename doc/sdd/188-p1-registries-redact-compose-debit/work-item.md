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

Ver `auto-blindaje.md` (decisión (a)/(b) y racional) y la sección "mapa de status" de
este documento, completada al cerrar la wave 2.
