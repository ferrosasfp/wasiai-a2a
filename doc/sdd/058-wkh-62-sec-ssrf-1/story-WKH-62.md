# Story File — [WKH-62 / SEC-SSRF-1] SSRF Protection for discoveryEndpoint

> **Fase**: F2.5 (Story File — contrato self-contained para Dev)
> **Modo**: QUALITY (security path, severidad BLQ-MED)
> **Branch**: `feat/058-wkh-62-sec-ssrf-1` (ya creada)
> **Base**: `main` @ `91adc29` (post-WKH-57)
> **Baseline tests**: 480 PASS → Target: ~512 (480 + 32 nuevos)
> **Sizing**: M (3–4h)

---

## 0. Contexto compacto (lo único que el Dev necesita saber)

Hay un bug de SSRF: `src/services/discovery.ts:153,193,274` hace `fetch()` sobre URLs leídas de la tabla `registries` (`discoveryEndpoint`, `agentEndpoint`) sin validar que el destino sea público. Un atacante autenticado puede registrar `http://169.254.169.254/...` (cloud metadata), `http://127.0.0.1/...`, `http://10.0.0.1/...`, `http://[::ffff:169.254.169.254]/...` y forzar al servicio a hacer outbound requests internas.

La defensa **ya existe** en `src/mcp/url-validator.ts:111–179` (`validateGatewayUrl`) — está acoplada al dominio MCP. Esta HU:

1. **Extrae** la lógica core a un módulo neutral `src/lib/url-validator.ts` que expone `validateOutboundUrl()` con **return-Result** (no throw).
2. **Mantiene** `src/mcp/url-validator.ts` como thin adapter (sigue lanzando `MCPToolError(-32602)` con misma firma — backwards compat 100%).
3. **Crea** un wrapper de dominio `validateRegistryUrl()` que lanza una nueva clase `SSRFViolationError`.
4. **Aplica** el guard en 4 puntos: 2 fetch sites + POST/PATCH `/registries` + defense-in-depth en `registryService`.
5. **Cubre** un nuevo vector: IPv6-mapped IPv4 (`::ffff:169.254.169.254`) — bypass que el validator MCP actual NO detecta.

**Decisiones clave (ya tomadas — no re-discutir)**:
- DT-A: lógica core en `src/lib/`, dos adapters thin (MCP + registry).
- DT-B: detectar `::ffff:` IPv4-mapped IPv6 (regex match en `isPrivateIPv6`).
- DT-C: validar `discoveryEndpoint` + `invokeEndpoint`. NO validar `agentEndpoint` en write-time (scope OUT) — solo en runtime en `getAgent`.
- DT-D: env var nueva `DISCOVERY_SSRF_ALLOWLIST` (CSV de hostnames).
- DT-E: clase nueva `SSRFViolationError extends Error` con `field`, `reason`, `category`.
- DT-F: core devuelve `Result<URL, ValidationFailure>` (no throw); wrappers de dominio sí throw.

---

## 1. Scope IN — paths exactos

### Archivos NEW (4)

| Path | Propósito |
|------|-----------|
| `src/lib/url-validator.ts` | Lógica core neutral. Exporta `validateOutboundUrl`, `validateRegistryUrl`, `SSRFViolationError`, types `Result`, `ValidationFailure`, `ValidateOutboundOpts`. |
| `src/lib/url-validator.test.ts` | 18 unit tests del core (W0). |
| `src/services/discovery.ssrf.test.ts` | 6 tests de runtime SSRF guard (W1). |
| `src/routes/registries.ssrf.test.ts` | 8 tests de write-time SSRF guard (W2). |

### Archivos MODIFY (4)

| Path | Cambio |
|------|--------|
| `src/mcp/url-validator.ts` | Refactor a thin adapter: importa `validateOutboundUrl` de `src/lib/`, traduce `Result.Err` → `MCPToolError(-32602)`. Mantiene firma `validateGatewayUrl(rawUrl: string): Promise<URL>` y prefijo de mensajes "gatewayUrl ...". |
| `src/services/discovery.ts` | Inserta `await validateRegistryUrl(registry.discoveryEndpoint)` después de la línea 153 (antes del `cb.execute` con fetch en L193). Inserta `await validateRegistryUrl(url)` con try/continue antes del fetch en L274 (`getAgent`). |
| `src/routes/registries.ts` | POST: validar `discoveryEndpoint` + `invokeEndpoint` antes del `registryService.register` (línea 84). Catch dedicado para `SSRFViolationError` → 422 con `{ error: 'SSRF_BLOCKED', field, reason }`. PATCH: validar campos URL del body (si presentes) antes del `registryService.update` (línea 124). |
| `src/services/registry.ts` | Defense-in-depth: en `register` (L103) y `update` (L131), si `discoveryEndpoint`/`invokeEndpoint` vienen, llamar `validateRegistryUrl`. Lanzar `Error` genérico si falla (no `SSRFViolationError`, para que callers internos vean mensaje consistente). |

### Archivos a tocar opcional (1)

| Path | Cambio |
|------|--------|
| `.env.example` | Documentar nueva env var `DISCOVERY_SSRF_ALLOWLIST` (CSV de hostnames, default unset). Si el archivo no existe, NO crearlo — es opcional. |

### Scope OUT (NO tocar)

- `src/mcp/tools/*.ts` — pasan W0 sin cambios (callers de `validateGatewayUrl`, su firma se preserva).
- `src/middleware/a2a-key.ts` — fuera de scope.
- Schema DB Supabase `registries` — fuera de scope.
- `agentEndpoint` validation en POST/PATCH — fuera de scope (TBD WKH-63 followup). SÍ se valida runtime en `getAgent`.

---

## 2. Acceptance Criteria con test plan inline

### AC-1 — Runtime SSRF guard en `queryRegistry`
> WHEN `discoveryService.queryRegistry` ejecuta `fetch` sobre `registry.discoveryEndpoint`, the system SHALL primero resolver la URL contra `src/lib/url-validator.ts` y, si falla, rechazar con `SSRFViolationError` sin enviar request.

**Tests**:
- `T-DISC-01` en `src/services/discovery.ssrf.test.ts` — `queryRegistry` con `discoveryEndpoint='http://169.254.169.254/agents'` (mocked dns.lookup → `169.254.169.254`) → `await expect(...).rejects.toThrow(SSRFViolationError)` + `expect(mockFetch).not.toHaveBeenCalled()`.
- `T-DISC-02` (positive) — `discoveryEndpoint='https://example.com/agents'` (mocked dns → `93.184.216.34`) → `expect(mockFetch).toHaveBeenCalled()` + retorna agents.
- `T-DISC-03` (resilience) — `discover()` con un registry SSRF + un registry público en lista → `result.agents.length` igual a los del registry público (el SSRF se descarta vía catch en L70 de `discover`).

### AC-2 — Write-time SSRF guard en POST `/registries`
> WHEN `POST /registries` recibe body con `discoveryEndpoint` o `invokeEndpoint`, the system SHALL llamar `validateRegistryUrl` antes de persistir y responder `422` con `{ error: 'SSRF_BLOCKED', field, reason }` si falla.

**Tests** en `src/routes/registries.ssrf.test.ts`:
- `T-REG-01` — POST con `discoveryEndpoint='http://169.254.169.254/discover'` → `expect(res.statusCode).toBe(422)` + `expect(res.json()).toEqual({ error: 'SSRF_BLOCKED', field: 'discoveryEndpoint', reason: expect.stringContaining('169.254.169.254') })` + `expect(registryService.register).not.toHaveBeenCalled()`.
- `T-REG-02` — POST con `discoveryEndpoint` válido + `invokeEndpoint='http://10.0.0.1/invoke'` → 422 + `field: 'invokeEndpoint'`.
- `T-REG-03` (positive) — ambos endpoints públicos → 201 + `registryService.register` SÍ llamado.
- `T-REG-04` — `discoveryEndpoint='file:///etc/passwd'` → 422 + `field: 'discoveryEndpoint'` + `reason` referencia "protocol".

### AC-3 — Write-time SSRF guard en PATCH `/registries/:id`
> WHEN `PATCH /registries/:id` recibe body con `discoveryEndpoint` o `invokeEndpoint`, the system SHALL aplicar la misma validación que AC-2 antes de `registryService.update`.

**Tests** en `src/routes/registries.ssrf.test.ts`:
- `T-REG-05` — PATCH con `discoveryEndpoint='http://localhost'` → 422 + `field: 'discoveryEndpoint'` + `expect(registryService.update).not.toHaveBeenCalled()`.
- `T-REG-06` (positive sin URLs) — PATCH con solo `name='new'` → 200 (validación no aplica).
- `T-REG-07` (positive con URL) — PATCH con `invokeEndpoint='https://valid.com'` (mocked dns público) → 200 + `update` llamado.

### AC-4 — Allowlist bypass via env var
> WHILE `DISCOVERY_SSRF_ALLOWLIST` (CSV) está configurada y el hostname figura en ella, the system SHALL omitir la comprobación de rangos privados manteniendo el bloqueo de literal `localhost` / `*.local`.

**Tests**:
- `T-LIB-15` en `src/lib/url-validator.test.ts` — `process.env.DISCOVERY_SSRF_ALLOWLIST='example.com'` + `validateOutboundUrl('https://example.com', { allowlistEnvVar: 'DISCOVERY_SSRF_ALLOWLIST' })` con dns mocked a `127.0.0.1` → `result.ok === true` (private check bypassed).
- `T-LIB-16` — `DISCOVERY_SSRF_ALLOWLIST='localhost'` + `validateOutboundUrl('http://localhost')` → `result.ok === false` con `category: 'blocked-literal'` (literal NO bypassable).
- `T-DISC-06` en `discovery.ssrf.test.ts` — `DISCOVERY_SSRF_ALLOWLIST='internal.test'` + dns mocked a `192.168.1.1` para `internal.test` → fetch SÍ se llama (allowlist permite).

### AC-5 — Error tipado con IP identificada
> IF `validateRegistryUrl` recibe URL cuyo hostname resuelve a IP privada/loopback/link-local/`169.254.169.254`, THEN SHALL lanzar `SSRFViolationError` con mensaje que identifique la IP, sin exponer stack al cliente.

**Tests**:
- `T-LIB-04..T-LIB-13` cubren todos los vectores: `file://`, `data:`, `javascript:`, `ftp:`, `localhost`, `*.local`, `0.0.0.0`, `10.0.0.1`, `::ffff:169.254.169.254` (dotted), `::ffff:a9fe:a9fe` (hex compressed).
- `T-LIB-18` — `validateRegistryUrl('http://10.0.0.1')` (mocked dns) lanza `SSRFViolationError` con `category === 'private-ip'` y `reason` incluye `'10.0.0.1'`.
- `T-REG-01` body NO contiene campo `stack` (CD-2 verificado).

### AC-6 — Backwards compat MCP
> WHEN `src/mcp/url-validator.ts` importa la lógica, the system SHALL seguir funcionando sin breaking change — `validateGatewayUrl` mantiene firma, lanza `MCPToolError(-32602)`, suite MCP existente PASS.

**Tests**:
- `src/mcp/url-validator.test.ts` (existente, 17 tests) sigue PASS sin modificación. Los `expect(msg).toContain('gatewayUrl ...')` deben seguir matcheando — el adapter preserva el prefijo "gatewayUrl" en los mensajes traducidos.
- `npm test src/mcp/url-validator.test.ts` PASS al final de W0.

### AC-7 — Test count baseline
> WHEN test runner corre la suite completa, the system SHALL mantener mínimo 480 tests pasando, con nuevos tests unitarios cubriendo: IPv4 privado, IPv6 loopback, `169.254.169.254`, `localhost`, URL inválida, URL pública, allowlist bypass.

**Tests**:
- 18 nuevos en `src/lib/url-validator.test.ts` + 6 en `src/services/discovery.ssrf.test.ts` + 8 en `src/routes/registries.ssrf.test.ts` = **32 nuevos**.
- `npm test` total: ≥ 480 + 32 = **512 tests verde**.
- `npm run typecheck` clean.
- `npm run lint` clean.

---

## 3. Waves de implementación

### W0 — Extraer y refactor (standalone-mergeable)

**Pre-condiciones**:
- Branch `feat/058-wkh-62-sec-ssrf-1` checked out.
- `npm install` ejecutado (no faltan deps).
- `npm test` baseline corre verde (~480 tests).

**Acciones (en orden)**:

1. **Crear `src/lib/url-validator.ts`** copiando la lógica de `src/mcp/url-validator.ts:1–179`, generalizando:
   - Renombrar `validateGatewayUrl` → `validateOutboundUrl` con firma:
     ```ts
     export async function validateOutboundUrl(
       rawUrl: string,
       opts?: ValidateOutboundOpts,
     ): Promise<Result<URL, ValidationFailure>>;
     ```
   - Convertir todos los `throw new MCPToolError(...)` a `return { ok: false, error: { category, reason } }`.
   - **Eliminar** todos los `import` de `'../mcp/types.js'` o `'./types.js'` — el módulo `src/lib/` NO importa de `src/mcp/` (CD-6).
   - Cambiar `loadAllowlist()` para que tome `envVarName: string | undefined` como parámetro (o use `opts.allowlistEnvVar`).
   - **Agregar** detección IPv6-mapped IPv4 en `isPrivateIPv6` (DT-B):
     ```ts
     // Caso A: ::ffff:a.b.c.d (dotted form)
     const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
     if (dotted && isPrivateIPv4(dotted[1])) return true;
     // Caso B: ::ffff:abcd:efgh (hex compressed form)
     const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
     if (hex) {
       const hi = parseInt(hex[1], 16);
       const lo = parseInt(hex[2], 16);
       const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
       if (isPrivateIPv4(ipv4)) return true;
     }
     ```
   - Exportar también:
     ```ts
     export class SSRFViolationError extends Error {
       public readonly field?: string;
       public readonly reason: string;
       public readonly category:
         'invalid-url' | 'invalid-protocol' | 'blocked-literal' |
         'allowlist' | 'private-ip' | 'dns-lookup-failed';
       constructor(reason: string, category: SSRFViolationError['category'], field?: string) {
         super(reason);
         this.name = 'SSRFViolationError';
         this.reason = reason;
         this.category = category;
         this.field = field;
       }
     }

     export async function validateRegistryUrl(rawUrl: string): Promise<URL> {
       const result = await validateOutboundUrl(rawUrl, {
         allowlistEnvVar: 'DISCOVERY_SSRF_ALLOWLIST',
       });
       if (!result.ok) {
         throw new SSRFViolationError(result.error.reason, result.error.category);
       }
       return result.value;
     }

     export type Result<T, E> =
       | { ok: true; value: T }
       | { ok: false; error: E };

     export interface ValidationFailure {
       category: SSRFViolationError['category'];
       reason: string;
     }

     export interface ValidateOutboundOpts {
       allowlistEnvVar?: string;
     }
     ```

2. **Refactor `src/mcp/url-validator.ts`** a thin adapter:
   ```ts
   import { validateOutboundUrl, type ValidationFailure } from '../lib/url-validator.js';
   import { MCP_ERRORS, MCPToolError } from './types.js';

   function mapMcpMessage(failure: ValidationFailure): string {
     switch (failure.category) {
       case 'invalid-url':       return 'gatewayUrl is not a valid URL';
       case 'invalid-protocol':  return `gatewayUrl protocol not allowed: ${extractProtocol(failure.reason)}`;
       case 'blocked-literal':   return `gatewayUrl hostname not allowed: ${extractHost(failure.reason)}`;
       case 'allowlist':         return `gatewayUrl host not in MCP_GATEWAY_ALLOWLIST: ${extractHost(failure.reason)}`;
       case 'private-ip':        return failure.reason.replace(/^URL/, 'gatewayUrl');
       case 'dns-lookup-failed': return `gatewayUrl DNS lookup failed: ${failure.reason}`;
     }
   }

   export async function validateGatewayUrl(rawUrl: string): Promise<URL> {
     const result = await validateOutboundUrl(rawUrl, {
       allowlistEnvVar: 'MCP_GATEWAY_ALLOWLIST',
     });
     if (!result.ok) {
       throw new MCPToolError(MCP_ERRORS.INVALID_PARAMS, mapMcpMessage(result.error));
     }
     return result.value;
   }
   ```
   **CRÍTICO**: los mensajes de error de `validateGatewayUrl` deben **mantener el prefijo "gatewayUrl"** y los strings exactos que esperan los `expect().toContain(...)` en `src/mcp/url-validator.test.ts`. Si rompés alguno, la suite MCP cae y bloquea el merge (CD-3, CD-5).

   **Estrategia recomendada**: en `validateOutboundUrl`, los `reason` deben ser **datos** (ej: `reason: '169.254.169.254'` o `'http: not allowed'`), y el adapter MCP construye el string final. Esto desacopla los mensajes y evita string-coupling.

3. **Crear `src/lib/url-validator.test.ts`** con 18 tests (ver §2 AC-1..AC-7 y T-LIB-01..T-LIB-18 abajo).

4. **Validation gate W0**:
   - `npm run typecheck` → clean (sin errores TS).
   - `npm test src/lib/url-validator.test.ts` → 18 PASS.
   - `npm test src/mcp/url-validator.test.ts` → 17 PASS (sin modificar el archivo de test).
   - `npm test` total → ≥ 498 (480 + 18 nuevos del lib).
   - `git status` → solo W0 files modificados/creados.

   **Si W0 rompe alguno → STOP. NO avances a W1**. Volvé a leer `src/mcp/url-validator.test.ts` línea por línea, comparar mensajes exactos esperados vs producidos.

### W1 — Aplicar guard en discovery service (runtime)

**Pre-condiciones**:
- W0 completo (validation gate W0 PASS).
- `src/lib/url-validator.ts` exporta `validateRegistryUrl` y `SSRFViolationError`.

**Acciones (en orden)**:

1. **Modificar `src/services/discovery.ts`**:
   - Agregar import al top del archivo:
     ```ts
     import { validateRegistryUrl, SSRFViolationError } from '../lib/url-validator.js';
     ```
   - **Línea 153** (en `queryRegistry`), inmediatamente DESPUÉS del `const url = new URL(registry.discoveryEndpoint);` y ANTES de cualquier código que llame `cb.execute`:
     ```ts
     // SSRF guard — validate before any fetch (CD-A3: outside circuit breaker scope)
     await validateRegistryUrl(registry.discoveryEndpoint);
     ```
     **NOTA**: validar el string original (`registry.discoveryEndpoint`), NO `url.toString()` (que ya tiene query params añadidos posteriormente).
   - **Línea 274** (en `getAgent`), inmediatamente ANTES del `const response = await fetch(url, ...)`:
     ```ts
     try {
       await validateRegistryUrl(url);
     } catch (err) {
       if (err instanceof SSRFViolationError) continue;
       throw err;
     }
     ```
     Esto preserva el patrón del catch vacío existente en L282 (skip registry fallido, intentar siguiente).

2. **Crear `src/services/discovery.ssrf.test.ts`** con 6 tests (T-DISC-01..T-DISC-06 — ver §6 abajo). Replicar el pattern de `src/services/discovery.test.ts:1–66`:
   - `vi.mock('node:dns', () => ({ promises: { lookup: (...args) => mockLookup(...args) } }))` ANTES de imports.
   - `vi.mock('./registry.js', ...)`, `vi.mock('../lib/circuit-breaker.js', ...)`.
   - `vi.stubGlobal('fetch', mockFetch)`.

3. **Validation gate W1**:
   - `npm run typecheck` → clean.
   - `npm test src/services/discovery.ssrf.test.ts` → 6 PASS.
   - `npm test src/services/discovery.test.ts` → suite WKH-DISCOVER-VERIFIED + WKH-57 fallback PASS sin modificación.
   - `npm test` total → ≥ 504 (480 + 18 + 6).

### W2 — Aplicar guard en routes + service (write-time)

**Pre-condiciones**: W1 completo.

**Acciones (en orden)**:

1. **Modificar `src/routes/registries.ts`**:
   - Agregar import al top:
     ```ts
     import { validateRegistryUrl, SSRFViolationError } from '../lib/url-validator.js';
     ```
   - **POST `/registries`** (handler en líneas 67–101), después del check de required fields (L78–82) y ANTES del `await registryService.register` (L84):
     ```ts
     // SSRF guard — validate ALL outbound URLs before persisting (CD-A5)
     try {
       for (const field of ['discoveryEndpoint', 'invokeEndpoint'] as const) {
         try {
           await validateRegistryUrl(body[field]);
         } catch (err) {
           if (err instanceof SSRFViolationError) {
             err.field = field; // annotate field for the outer handler
             throw err;
           }
           throw err;
         }
       }
     } catch (err) {
       if (err instanceof SSRFViolationError) {
         request.log.warn({ field: err.field, category: err.category }, 'SSRF blocked');
         return reply.status(422).send({
           error: 'SSRF_BLOCKED',
           field: err.field,
           reason: err.reason,
         });
       }
       throw err;
     }
     ```
   - **PATCH `/registries/:id`** (handler en L119–131), ANTES del `await registryService.update` (L124):
     ```ts
     try {
       for (const field of ['discoveryEndpoint', 'invokeEndpoint'] as const) {
         const value = body[field];
         if (typeof value !== 'string') continue; // skip if not present in PATCH body
         try {
           await validateRegistryUrl(value);
         } catch (err) {
           if (err instanceof SSRFViolationError) {
             err.field = field;
             throw err;
           }
           throw err;
         }
       }
     } catch (err) {
       if (err instanceof SSRFViolationError) {
         request.log.warn({ field: err.field, category: err.category }, 'SSRF blocked');
         return reply.status(422).send({
           error: 'SSRF_BLOCKED',
           field: err.field,
           reason: err.reason,
         });
       }
       throw err;
     }
     ```
   - **CRÍTICO CD-2**: NUNCA agregar `stack: err.stack` al body. Solo `error`, `field`, `reason`.

2. **Modificar `src/services/registry.ts`** (defense-in-depth):
   - Agregar import:
     ```ts
     import { validateRegistryUrl, SSRFViolationError } from '../lib/url-validator.js';
     ```
   - En `register` (L103–125), ANTES del `supabase.from('registries').insert(row)` (L110):
     ```ts
     // Defense-in-depth: validate URLs even if route handler missed them
     for (const field of ['discoveryEndpoint', 'invokeEndpoint'] as const) {
       try {
         await validateRegistryUrl(config[field]);
       } catch (err) {
         if (err instanceof SSRFViolationError) {
           throw new Error(`Invalid ${field}: ${err.reason}`);
         }
         throw err;
       }
     }
     ```
   - En `update` (L131–171), ANTES de construir `updateRow` (L141), o intercalado con la validación de `updates`:
     ```ts
     for (const field of ['discoveryEndpoint', 'invokeEndpoint'] as const) {
       const value = updates[field];
       if (typeof value !== 'string') continue;
       try {
         await validateRegistryUrl(value);
       } catch (err) {
         if (err instanceof SSRFViolationError) {
           throw new Error(`Invalid ${field}: ${err.reason}`);
         }
         throw err;
       }
     }
     ```
   - **NOTA**: el service throw `Error` genérico (no `SSRFViolationError`) para que la respuesta al caller del service sea consistente con el resto de errores del service (que ya hacen `throw new Error(...)`). El route handler tiene su propio guard (más específico) que captura `SSRFViolationError` antes de llegar acá.

3. **Crear `src/routes/registries.ssrf.test.ts`** con 8 tests (T-REG-01..T-REG-08 — ver §6 abajo). Replicar pattern de `src/routes/registries.test.ts:1–80`:
   - `vi.mock('node:dns', ...)` con `mockLookup`.
   - `vi.mock('../services/registry.js', ...)` (mismos mocks que el test existente).
   - `vi.mock('../middleware/a2a-key.js', ...)` para evitar el flow x402 — devolver un middleware noop que adjunte `request.a2aKeyRow` mock.
   - Fastify().register(registriesRoutes) + `app.inject({ method: 'POST', url: '/', payload: {...} })`.

4. **Documentar `.env.example`** (si existe el archivo):
   ```
   # SSRF protection — comma-separated hostnames bypassed from private-IP check.
   # Literal `localhost` and `*.local` are NEVER bypassed.
   # Default: unset (no allowlist; all private IPs blocked).
   DISCOVERY_SSRF_ALLOWLIST=
   ```
   Si `.env.example` no existe, omitir este paso.

5. **Validation gate W2 (final)**:
   - `npm run typecheck` → clean.
   - `npm run lint` → clean.
   - `npm test src/routes/registries.ssrf.test.ts` → 8 PASS.
   - `npm test src/routes/registries.test.ts` → suite WKH-SEC-01 PASS sin modificación.
   - `npm test` total → ≥ **512 (480 + 32 nuevos)**, todos verde.
   - `git status` → todo en scope, no archivos rogue fuera de la lista §1.

---

## 4. Anti-Hallucination Rules consolidadas

### AB heredados de auto-blindajes pasados

| Rule | Origen | Aplicación en WKH-62 |
|------|--------|---------------------|
| **AB-WKH-53-#2** — read-before-write | WKH-53 RLS Ownership | ANTES de escribir `src/services/discovery.ssrf.test.ts`, leé las primeras 60 líneas de `src/services/discovery.test.ts`. ANTES de `src/routes/registries.ssrf.test.ts`, leé `src/routes/registries.test.ts:1–80`. ANTES de `src/lib/url-validator.test.ts`, leé `src/mcp/url-validator.test.ts:1–80`. NO inventar mocks ni patterns. |
| **AB-WKH-53-#3** — edge case empty strings | WKH-53 | Tests deben cubrir explícitamente: `''`, `' '`, `null` cast a string, `undefined` cast a string, `'http://'` (URL parse OK pero hostname vacío), `'http://[invalid'` (URL parse falla). Cubierto en T-LIB-01..T-LIB-03 + T-REG-08. |
| **AB-WKH-55** — auth tests con middleware fallback | WKH-55 downstream payment | En `registries.ssrf.test.ts`, mockear `requirePaymentOrA2AKey` para evitar ejecutar el flow x402 real. Replicar el pattern del test existente `src/routes/registries.test.ts` que ya maneja este middleware. |
| **AB-WKH-56-W4** — coverage tooling N/A | WKH-56 A2A fast-path | NO usar `npm test -- --coverage`. Validar por count manual: `npm test 2>&1 | grep -E "Tests:.*passed"` y comparar con baseline 480. |
| **AB-WKH-57-1** — vi.mock isolation por archivo | WKH-57 LLM bridge | Los 3 archivos de test nuevos son **separados** de los existentes. Vitest aísla `vi.mock('node:dns', ...)` por archivo — NO hace falta cleanup entre suites. PERO: dentro del mismo archivo, hacer `mockLookup.mockReset()` en `beforeEach`. |
| **AB-WKH-57-2** — no agregar `.eq()` a Supabase chain | WKH-57 | NO aplica directamente: esta HU NO modifica chains de Supabase, solo agrega validaciones ANTES de las queries. |

### Reglas hardcoded de esta HU

1. **NO** inventes paths. Todos los archivos referenciados en §1 fueron verificados con Read. Si descubrís que un path no existe → STOP, releé este Story File. NO crees archivos en paths que no estén en §1.
2. **NO** importes desde `src/services/` hacia `src/mcp/` (CD-1). El flujo es siempre `src/mcp/` → `src/lib/` y `src/services/` → `src/lib/`.
3. **NO** importes `MCPToolError` desde `src/lib/url-validator.ts` (CD-6). Si te encontrás escribiendo `import { MCPToolError } from '../mcp/types.js'` en `src/lib/url-validator.ts` → STOP, eso es violación. La traducción a `MCPToolError` la hace `src/mcp/url-validator.ts`.
4. **NO** uses `dns.resolve()` o `dns.resolve4()` en lugar de `dns.lookup()` (CD-A7). `lookup` aplica `/etc/hosts` y NSS; `resolve` no. Mantener consistencia con el `fetch` real.
5. **NO** agregues `stack: err.stack` o `err.message` plain al body 422. Solo `error`, `field`, `reason` (CD-2). Si agregás `category` también es NO — `category` es interno (solo log).
6. **NO** lances `SSRFViolationError` desde `validateOutboundUrl` (función core, CD-A1). El core SIEMPRE devuelve `Result`. Solo `validateRegistryUrl` y `validateGatewayUrl` lanzan.
7. **NO** muevas el guard de `discovery.ts:153` dentro del `cb.execute(() => ...)` callback (CD-A3). Si lo hacés, el SSRF se cuenta como fallo del registry en circuit breaker stats — contamina métricas.
8. **NO** modifiques `src/mcp/url-validator.test.ts` para acomodar nuevos mensajes. Si los tests existentes rompen, la solución es ajustar `mapMcpMessage` en `src/mcp/url-validator.ts` para que los strings finales sean idénticos a los esperados (CD-3, CD-5).
9. **NO** hardcodees IPs ni hostnames en código (CD-4). Toda configuración va vía env var.
10. **NO** valides `agentEndpoint` en POST/PATCH (scope OUT). SÍ se valida runtime en `getAgent` línea 274.

### Verificación pre-test

Antes de correr `npm test`, validá que estos paths existen (deben existir post-implementación):

```
src/lib/url-validator.ts                      ← W0
src/lib/url-validator.test.ts                 ← W0
src/services/discovery.ssrf.test.ts           ← W1
src/routes/registries.ssrf.test.ts            ← W2
```

Y estos paths fueron MODIFY (deben tener cambios diff > 0):

```
src/mcp/url-validator.ts                      ← W0 refactor
src/services/discovery.ts                     ← W1 (líneas 153, 274)
src/routes/registries.ts                      ← W2 (POST L84, PATCH L124)
src/services/registry.ts                      ← W2 (L103, L131)
```

---

## 5. Constraint Directives (12 totales — 5 work-item heredados + 7 SDD)

### Heredados del work-item (5)

- **CD-1**: PROHIBIDO que `src/services/` importe de `src/mcp/`. Dependencia siempre `src/mcp/` → `src/lib/`.
- **CD-2**: PROHIBIDO exponer stack trace de `SSRFViolationError` al cliente HTTP. Solo `{ error, field, reason }`.
- **CD-3**: OBLIGATORIO `validateGatewayUrl` mantiene firma `(rawUrl: string) => Promise<URL>` y sigue lanzando `MCPToolError(-32602)` con prefijo "gatewayUrl" en mensajes.
- **CD-4**: OBLIGATORIO env var `DISCOVERY_SSRF_ALLOWLIST` (no hardcode de IPs/hostnames).
- **CD-5**: OBLIGATORIO baseline ≥480 tests verde. Cualquier test existente que rompa por esta HU es BLOQUEANTE en AR.
- **CD-6**: PROHIBIDO `src/lib/url-validator.ts` importe de `src/mcp/types.ts` (evitar circularidad).

### Nuevos del SDD (7)

- **CD-A1**: `validateOutboundUrl` (función core en `src/lib/url-validator.ts`) **NUNCA** debe lanzar — siempre devuelve `Result`. Si una excepción inesperada surge dentro (ej. `dns.lookup` rechaza con error no-`Error`), capturarla y traducir a `Result.Err({ category: 'dns-lookup-failed', reason: err.message })`.
- **CD-A2**: Tests SSRF deben **mockear `node:dns` con `vi.mock('node:dns', () => ({ promises: { lookup: ... } }))`** — mismo patrón que `src/mcp/url-validator.test.ts:9–15`. NO usar `vi.spyOn(dns, 'lookup')`.
- **CD-A3**: En `src/services/discovery.ts`, el guard `await validateRegistryUrl(...)` se inserta **antes** del `cb.execute(...)` y **antes** del `await fetch(...)` en `getAgent`. NO debe estar dentro del callback de `cb.execute`.
- **CD-A4** (Auto-Blindaje recurrente AB-WKH-53-#3): Tests del validator deben cubrir explícitamente: `''`, `' '`, `null`, `undefined`, `'http://'`, `'http://[invalid'`.
- **CD-A5**: El guard de routes (POST/PATCH) debe validar **TODOS** los campos outbound del body **antes** de llamar al service (no validar uno, llamar service, fallar, validar otro). Loop con early-throw + outer catch.
- **CD-A6** (test isolation, AB-WKH-57-1): Los 3 archivos de test nuevos son **separados** de los existentes. NO consolidar en un solo archivo gigante.
- **CD-A7**: PROHIBIDO usar `dns.resolve()` o `dns.resolve4()` en lugar de `dns.lookup()`. `lookup` aplica `/etc/hosts` y NSS — comportamiento consistente con el `fetch` real.

---

## 6. Exemplars verificados (file:line)

| Exemplar | Path:línea | Patrón a replicar |
|----------|------------|-------------------|
| **Validator core completo** | `src/mcp/url-validator.ts:1–179` | Estructura `parse → protocol → literal → allowlist → DNS resolve`. **5 etapas** preservar. |
| **isPrivateIPv4** | `src/mcp/url-validator.ts:40–57` | Octets check para `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `0/8`. Replicar idéntico. |
| **isPrivateIPv6 (extender)** | `src/mcp/url-validator.ts:63–77` | Base: `::1`, `fc00::/7`, `fe80::/10`. **Extender con DT-B**: agregar `::ffff:` IPv4-mapped checks. |
| **isBlockedHostnameLiteral** | `src/mcp/url-validator.ts:82–88` | `localhost`, `*.local`, `*.localhost`. Replicar idéntico. |
| **DNS lookup pattern** | `src/mcp/url-validator.ts:152–161` | `dns.lookup(hostname, { all: true })` + try/catch. Replicar idéntico (CD-A7). |
| **DNS mock test setup** | `src/mcp/url-validator.test.ts:9–15` | `vi.mock('node:dns', () => ({ promises: { lookup: (...args) => mockLookup(...args) } }))`. **Replicar exacto** en los 3 archivos de test nuevos. |
| **Lookup mock per-test** | `src/mcp/url-validator.test.ts:32–47` | `mockLookup.mockResolvedValueOnce([{ address, family }])`. Patrón por test. |
| **Discovery test scaffold** | `src/services/discovery.test.ts:1–66` | `vi.mock('./registry.js')` + `vi.mock('../lib/circuit-breaker.js')` + `vi.stubGlobal('fetch', mockFetch)` + `makeRegistry()` factory. |
| **Fastify route test** | `src/routes/registries.test.ts:1–80` | `vi.mock('../services/registry.js')` + `Fastify().register(registriesRoutes)` + `app.inject({ method, url, payload })`. |
| **Result-style return precedent** | `src/services/discovery.ts:289–300+` (`parsePriceSafe`) | Pure function que NO throw, devuelve safe default — paralelo conceptual al `Result.Err` del validator. |
| **Empty-catch pattern (skip & continue)** | `src/services/discovery.ts:282` (`} catch {}`) | Pattern para `getAgent` — el W1 lo ajusta a `if (err instanceof SSRFViolationError) continue; throw err;`. |
| **Service guard pattern** | `src/services/registry.ts:137–139` (guard `id === 'wasiai'`) | Defense-in-depth precedent — validación in-service ANTES de Supabase write. |

---

## 7. Pre-implementation checklist (Dev)

Antes de empezar W0, confirma:

- [ ] Estás en branch `feat/058-wkh-62-sec-ssrf-1` (ya creada). Verificar con `git branch --show-current`.
- [ ] Leíste este Story File COMPLETO. Especialmente §4 (Anti-Hallucination) y §5 (CDs).
- [ ] Leíste `src/mcp/url-validator.ts` línea 1–179 completo. Sabés qué función hace cada etapa.
- [ ] Leíste `src/mcp/url-validator.test.ts:1–80`. Sabés qué prefijo "gatewayUrl ..." espera cada test (para `mapMcpMessage`).
- [ ] Leíste `src/services/discovery.ts:140–290`. Identificaste los 2 fetch sites (L193 y L274).
- [ ] Leíste `src/routes/registries.ts:60–135`. Identificaste POST handler L67–101 y PATCH handler L119–131.
- [ ] Leíste `src/services/registry.ts:90–172`. Identificaste `register` L103 y `update` L131.
- [ ] `npm test` corre verde antes de cualquier cambio (baseline 480).
- [ ] Auto-mode activo (continuous execution).

Si algún punto es NO → arreglarlo antes de avanzar. NO empieces a codear si la lista está incompleta.

---

## 8. Definition of Done (final)

La HU se considera DONE cuando TODO lo siguiente es verdadero:

- [ ] **§1 Scope IN cumplido**: 4 archivos nuevos creados, 4 archivos modificados.
- [ ] **§2 ACs cubiertos**: AC-1 a AC-7 con tests verdes que evidencian comportamiento.
- [ ] **§3 Waves**: W0/W1/W2 completos en orden secuencial. W0 standalone-mergeable (sistema funciona igual con solo W0).
- [ ] **§4 Anti-Hallucination**: ningún path inventado, ningún import prohibido (CD-1, CD-6).
- [ ] **§5 CDs**: 12 CDs cumplidos. Verificar especialmente:
  - CD-2: body 422 NO contiene `stack`.
  - CD-3: `npm test src/mcp/url-validator.test.ts` 17/17 PASS sin modificar el archivo de test.
  - CD-A1: `validateOutboundUrl` NUNCA throw (grep `throw` en `src/lib/url-validator.ts` → solo en `validateRegistryUrl` y en `SSRFViolationError` constructor).
- [ ] **`npm run typecheck`** clean.
- [ ] **`npm run lint`** clean.
- [ ] **`npm test`** total ≥ 512 PASS (480 baseline + 32 nuevos).
- [ ] **Tests por archivo nuevo**:
  - `src/lib/url-validator.test.ts` → 18 PASS.
  - `src/services/discovery.ssrf.test.ts` → 6 PASS.
  - `src/routes/registries.ssrf.test.ts` → 8 PASS.
- [ ] **Tests existentes intactos**:
  - `src/mcp/url-validator.test.ts` → 17 PASS sin modificación.
  - `src/services/discovery.test.ts` → suite WKH-DISCOVER-VERIFIED + WKH-57 fallback PASS sin modificación.
  - `src/routes/registries.test.ts` → suite WKH-SEC-01 PASS sin modificación.
- [ ] **Done report**: `git diff main` muestra solo archivos en §1. Sin archivos rogue.
- [ ] **Branch listo**: commits limpios, mensaje descriptivo. NO hacer push aún (eso lo gestiona Docs en p8).

---

## 9. Notas para el Dev

### Auto-mode active
El humano activó auto-mode. Procedé sin preguntar en decisiones rutinarias. Solo parar si:
- Encontrás un path inventado (no en §1).
- Un test existente rompe y no podés diagnosticar la causa después de leer el archivo.
- `npm install` falla (env problem).
- Un CD entra en conflicto con la realidad del código (escalá al humano con archivo:línea exacto).

### Branch & commits
- Branch: `feat/058-wkh-62-sec-ssrf-1` (ya creada — verificar con `git branch --show-current`).
- **NO hacer push hasta que F4 (QA) y Docs (p8) lo indiquen**. El push del PR lo dispara `nexus-docs` en la fase final.
- Commits sugeridos (uno por wave, conventional):
  - `feat(WKH-62): W0 — extract URL validator core to src/lib/`
  - `feat(WKH-62): W1 — apply SSRF guard in discovery service runtime`
  - `feat(WKH-62): W2 — apply SSRF guard in registries routes + service`
- Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### Baseline & target
- **Baseline**: 480 tests PASS (post-WKH-57).
- **Target**: ~512 tests PASS (480 + 18 + 6 + 8 = 512).
- Si `npm test` cae bajo 480, **PARAR** — algo se rompió. Investigá con `npm test -- --reporter=verbose` y diff vs baseline.

### Cómo verificar el count exacto
```bash
npm test 2>&1 | tail -20
# Buscar línea: "Tests  XYZ passed (XYZ)"
```

### Si te trabás con `mapMcpMessage`
La parte más delicada de W0 es preservar los strings exactos del test MCP existente. Estrategia:

1. Abrí `src/mcp/url-validator.test.ts` y mirá CADA `expect(...).toContain(...)` y `expect(err.message).toBe(...)`.
2. Listá los strings esperados, ej:
   - `'gatewayUrl is not a valid URL'`
   - `'gatewayUrl protocol not allowed: file:'`
   - `'gatewayUrl hostname not allowed: localhost'`
   - `'gatewayUrl host not in MCP_GATEWAY_ALLOWLIST: example.com'`
   - `'gatewayUrl resolves to non-public IPv4: 127.0.0.1'`
   - `'gatewayUrl DNS lookup failed: ENOTFOUND'`
3. En `validateOutboundUrl`, devolvé en `failure.reason` el **dato puro** (ej. `'127.0.0.1'`, `'file:'`, `'localhost'`).
4. En `mapMcpMessage`, reconstruí el string exacto que el test espera, usando `failure.category` como discriminador.

Alternativa pragmática: dejá que `validateOutboundUrl` devuelva `reason` con un formato genérico (ej. `'URL resolves to non-public IPv4: 127.0.0.1'`) y en `mapMcpMessage` hacé un `reason.replace(/^URL/, 'gatewayUrl')`. Funciona si los tests no son string-exact (`toContain` permite substrings).

### Cómo correr tests granular
```bash
# Solo lib/
npm test src/lib/url-validator.test.ts

# Solo discovery SSRF
npm test src/services/discovery.ssrf.test.ts

# Solo registries SSRF
npm test src/routes/registries.ssrf.test.ts

# Solo MCP (verificar no breakage)
npm test src/mcp/url-validator.test.ts

# Suite completa
npm test
```

### Workflow recomendado
1. Leé este Story File entero. NO empieces si te falta contexto.
2. Pre-implementation checklist (§7).
3. Implementá W0. Validation gate W0. Commit W0.
4. Implementá W1. Validation gate W1. Commit W1.
5. Implementá W2. Validation gate W2 (final). Commit W2.
6. Done definition (§8) full pass.
7. Reportá al orquestador con: paths modificados, count de tests, gates pasados.
8. Esperá la fase AR (`nexus-adversary` p5).

### Recordatorios finales

- **NO hagas push**. El push lo gestiona Docs en p8.
- **NO modifiques tests existentes** para acomodar tu refactor. Los tests son la spec — si rompen, ajustá tu código.
- **NO inventes archivos** fuera de §1.
- **NO importes `MCPToolError`** desde `src/lib/url-validator.ts` (CD-6).
- **NO uses `dns.resolve()`** — solo `dns.lookup()` (CD-A7).
- **NO expongas stack traces** al body 422 (CD-2).
- **NO valides `agentEndpoint`** en write-time (scope OUT) — solo runtime en `getAgent`.

---

> Generado: 2026-04-27
> Architect: nexus-architect
> Próximo gate: F3 (Dev). Auto-mode → lanzar `nexus-dev` automáticamente con este Story File.
