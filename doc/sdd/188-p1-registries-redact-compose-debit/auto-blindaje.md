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

_(se completa al cerrar la wave 2)_
