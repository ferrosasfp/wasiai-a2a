# SDD — [WKH-62 / SEC-SSRF-1] SSRF Protection for discoveryEndpoint

> Fase: F2 Architecture
> Modo: QUALITY (security path, severidad BLQ-MED)
> Branch: `feat/058-wkh-62-sec-ssrf-1`
> Base: `main` @ `91adc29` (post-WKH-57)
> Estimación F3: **M (3–4h)** — 2 archivos new + 4 archivos modify + 3 suites de tests

---

## 0. Resumen ejecutivo

`src/services/discovery.ts:153,193` y `src/services/discovery.ts:274` ejecutan
`fetch(...)` directamente sobre URLs leídas de la tabla `registries` (campos
`discoveryEndpoint` / `agentEndpoint`) sin validar que el destino sea público.
Un atacante autenticado puede registrar un endpoint que resuelva a
`169.254.169.254` (cloud metadata), `127.0.0.1`, RFC1918 o `fe80::/10` y
forzar al servicio a hacer outbound requests internas (SSRF).

La lógica defensiva ya existe en `src/mcp/url-validator.ts:111–179`
(`validateGatewayUrl`). Esta HU:

1. **Extrae** la lógica core (parseo IPv4/IPv6, blocked literals, allowlist,
   `dns.lookup`) a un módulo neutral `src/lib/url-validator.ts`, expone una
   función pura **`validateOutboundUrl(rawUrl, opts)`** que devuelve un
   `Result<URL, ValidationFailure>` (NO throw).
2. **Adapta** `src/mcp/url-validator.ts` a un thin wrapper que llama
   `validateOutboundUrl` y traduce el `Err` a `MCPToolError(-32602)` —
   `validateGatewayUrl` mantiene su firma pública (CD-3 del work-item).
3. **Expone** un wrapper de dominio `validateRegistryUrl(rawUrl)` que envuelve
   `validateOutboundUrl` y, ante `Err`, lanza `SSRFViolationError` (clase
   propia que extiende `Error`, NO `MCPToolError` — CD-1).
4. **Aplica** el guard:
   - En `discoveryService.queryRegistry` antes del `fetch` (línea 193).
   - En `discoveryService.getAgent` antes del `fetch` (línea 274).
   - En `POST /registries` y `PATCH /registries/:id` antes de delegar al service
     — falla con `422 Unprocessable Entity` y `{ error, field, reason }`.
   - En `registryService.register` y `update` como **defense-in-depth**
     (segunda línea, devuelve `Error` genérico).

Tests nuevos:
- `src/lib/url-validator.test.ts` (NEW) — 18 tests unitarios cubriendo todos
  los attack vectors (incl. `::ffff:169.254.169.254` IPv4-mapped IPv6, DNS
  rebinding awareness, allowlist bypass, etc.).
- `src/services/discovery.ssrf.test.ts` (NEW) — 6 tests sobre
  `queryRegistry`/`getAgent` rechazando endpoints SSRF.
- `src/routes/registries.ssrf.test.ts` (NEW) — 8 tests sobre POST/PATCH /registries
  validando campo + 422 + body shape.

NO se tocan: schema DB, `requirePaymentOrA2AKey`, MCP tools, otros services.

---

## 1. Codebase Grounding — evidencia real

Archivos leídos (Read directo, líneas verificadas):

| Archivo | Línea(s) | Por qué |
|---------|----------|---------|
| `src/mcp/url-validator.ts` | 1–179 | Implementación referencia. Identifica los 5 pasos: parse → protocol → literal → allowlist → DNS resolve. Lo extraemos a `src/lib/`. |
| `src/mcp/url-validator.test.ts` | 1–247 | Pattern de mocking de `node:dns` con `vi.mock(...)` + `mockLookup.mockResolvedValueOnce`. Lo replicamos en `src/lib/url-validator.test.ts`. |
| `src/services/discovery.ts` | 149–215 | Fetch site #1 (`queryRegistry`). `url = new URL(registry.discoveryEndpoint)` línea 153, fetch línea 193 dentro de circuit breaker. |
| `src/services/discovery.ts` | 259–286 | Fetch site #2 (`getAgent`). `fetch(url, ...)` línea 274. **No hay circuit breaker acá** — el guard se aplica antes del fetch. |
| `src/services/registry.ts` | 103–171 | `register` y `update` actuales. NO validan URLs. La defense-in-depth se inserta antes de `supabase.insert/update`. |
| `src/routes/registries.ts` | 60–101 | POST handler. La validación de SSRF va **después** del check de required fields (línea 78–82) y **antes** del `await registryService.register` (línea 84). |
| `src/routes/registries.ts` | 107–132 | PATCH handler. La validación va **antes** de `await registryService.update` (línea 124), iterando los campos `discoveryEndpoint` e `invokeEndpoint` si están presentes en el body. |
| `src/services/discovery.test.ts` | 1–66 | Pattern `vi.mock('./registry.js')` + `vi.stubGlobal('fetch', mockFetch)`. Replicamos en `src/services/discovery.ssrf.test.ts`. |
| `src/routes/registries.test.ts` | 1–152 | Pattern Fastify `inject({ method, url, payload })` + `vi.mock('../services/registry.js')`. Replicamos en `src/routes/registries.ssrf.test.ts`. |
| `src/mcp/types.ts` | 26–37, 165–179 | `MCPToolError` + `MCP_ERRORS.INVALID_PARAMS = -32602`. **NO se importa** desde `src/lib/url-validator.ts` — CD-6 del work-item. |
| `src/lib/circuit-breaker.ts` | 1–50 | Confirmado que circuit breaker es opaque (envuelve un `() => Promise<T>`). Como el guard es **antes** del CB.execute, no interfiere con la lógica de circuit. |
| `doc/sdd/053-wkh-53-rls-ownership/sdd.md` | 1–100 | Patrón de SDD QUALITY security HU previa. Estructura imitada acá. |

### Grep sistemático

```
$ grep -rn "fetch(" src/services/discovery.ts
153: const url = new URL(registry.discoveryEndpoint);  // input para fetch L193
193: return fetch(url.toString(), { ... });            // FETCH SITE #1
274: const response = await fetch(url, { ... });       // FETCH SITE #2
```

```
$ grep -rn "discoveryEndpoint\|invokeEndpoint" src/routes/
src/routes/registries.ts:51:      discoveryEndpoint: string;
src/routes/registries.ts:53:      invokeEndpoint: string;
src/routes/registries.ts:74:        !body.discoveryEndpoint
src/routes/registries.ts:75:        !body.invokeEndpoint
src/routes/registries.ts:87:        discoveryEndpoint: body.discoveryEndpoint,
src/routes/registries.ts:88:        invokeEndpoint: body.invokeEndpoint,
```

**Confirmación**: `invokeEndpoint` también se persiste y eventualmente se usa
para construir URLs de invocación (`src/services/discovery.ts:225–227`,
`mapAgent`). Aunque hoy no se hace `fetch` directo de `invokeEndpoint` en el
gateway (lo hace el caller marketplace), validarlo en POST/PATCH evita que un
atacante registre `invokeEndpoint=http://169.254.169.254/...` y, si en una HU
futura el gateway proxyea invocaciones, herede SSRF. **Defense-in-depth**.

### Auto-Blindajes consultados (HUs previas)

Leí los auto-blindajes de las 3 últimas DONE (057, 056, 055) — patrones
recurrentes aplicables:

- **AB-WKH-57-WAS-V2-3-CLIENT-1** (test isolation): preferir `vi.spyOn()` o
  estructurar `vi.mock()` en describe blocks aislados. El nuevo
  `src/services/discovery.ssrf.test.ts` puede causar conflictos con
  `src/services/discovery.test.ts` si ambos hacen `vi.mock('./registry.js')`
  → archivos separados, vitest los aísla por archivo. **CD-A1** lo formaliza.
- **AB-WKH-53-#2** (read before write): antes de escribir cualquier test,
  leer las primeras 60 líneas del archivo "vecino" (existente) para confirmar
  imports + mocks + patrón. **CD-A2**.
- **AB-WKH-53-#3** (edge case empty strings): tests de parsing deben cubrir
  `''`, `null`, `undefined`. Aplicado a `validateOutboundUrl(' ')`,
  `validateOutboundUrl('')` → reject parse. **Test T-LIB-01..T-LIB-03**.
- **AB-WKH-56-W4** (coverage tooling N/A): no usar `--coverage` flag, validar
  por count + manual review. AC-7 dice ≥480 baseline → contar nuevos tests
  añadidos manualmente.
- **AB-WKH-57-1** (mock chain Supabase): no aplica en esta HU porque NO
  agregamos `.eq()` extra al chain de Supabase — solo agregamos llamada a
  `validateRegistryUrl` ANTES de la query.

---

## 2. Decisiones técnicas (DT)

### DT-A — Ubicación del validator: `src/lib/url-validator.ts` con `validateOutboundUrl`

**Decisión**: extraer la lógica core a `src/lib/url-validator.ts`, exponiendo
**`validateOutboundUrl(rawUrl: string, opts?: ValidateOutboundOpts): Promise<Result<URL, ValidationFailure>>`**
como API pública neutral (no domain-specific). Sobre ella se construyen DOS
adapters thin:

- `src/mcp/url-validator.ts` (`validateGatewayUrl`) → throw `MCPToolError`.
- `src/lib/url-validator.ts` (`validateRegistryUrl`) → throw `SSRFViolationError`
  (mismo módulo, función separada que envuelve y traduce).

**Justificación**:
- **Separación de capas**: `src/services/` no debe importar de `src/mcp/` (CD-1
  del work-item). El paso intermedio neutral en `src/lib/` es la convención
  arquitectónica del proyecto (`src/lib/circuit-breaker.ts`,
  `src/lib/downstream-payment.ts`, `src/lib/supabase.ts` siguen el patrón).
- **Pure return-Result vs throw**: La lógica core devuelve `Result<URL, Failure>`
  (no throw). Cada adapter elige su política de error (MCPToolError, custom).
  Esto facilita unit-testing (no try/catch en cada test) y composición.
- **Renombre semántico**: `validateGatewayUrl` quedó atado al dominio MCP
  ("gateway" se refiere al gateway x402). El nombre neutral `validateOutboundUrl`
  describe la intención: "URL hacia la red externa". `validateRegistryUrl` es
  un alias de dominio para el caller registry.

**Alternativa descartada**: dejar todo en `src/mcp/url-validator.ts` y exportar
`validateGatewayUrl` desde services. Violaría CD-1 (services no importan de
`src/mcp/`) y acopla MCP errors al flujo de discovery. Rechazado.

### DT-B — IPv6-mapped IPv4 (`::ffff:169.254.169.254`)

**Decisión**: agregar detección explícita en `isPrivateIPv6` para el prefijo
**`::ffff:`** (RFC 4291 § 2.5.5.2) — extrae los últimos 4 octetos IPv4 y los
pasa por `isPrivateIPv4`. Cubre AMBOS:
- `::ffff:169.254.169.254` (canonical IPv4-mapped form)
- `::ffff:a9fe:a9fe` (compressed hex form, mismo IP)

**Justificación**:
- En Node.js, `dns.lookup(host, { family: 0 })` puede devolver IPv6-mapped
  cuando el OS está dual-stack. El validator actual NO lo detecta — un
  atacante que controla DNS puede devolver `::ffff:169.254.169.254` y bypassar
  el check.
- `URL` parser de Node NO normaliza la IPv4-mapped form. El check debe ser
  explícito en el lado del validator.
- NO forzamos `family: 4` en `dns.lookup` porque romperíamos hostnames legítimos
  IPv6-only. La defensa correcta es **detectar el mapping** en el validator.

**Implementación esperada** en `src/lib/url-validator.ts`:

```ts
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ... checks existentes (::1, fc00::/7, fe80::/10, ::) ...

  // RFC 4291: IPv4-mapped IPv6 — ::ffff:a.b.c.d  ó  ::ffff:abcd:efgh
  // Caso A: dotted form
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted && isPrivateIPv4(dotted[1])) return true;

  // Caso B: hex form ::ffff:abcd:efgh  (cada hex pair = 2 octetos IPv4)
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isPrivateIPv4(ipv4)) return true;
  }
  return false;
}
```

**Tests asociados**: T-LIB-12, T-LIB-13.

### DT-C — Cobertura de `agentEndpoint` y `invokeEndpoint`

**Decisión**: validar **`discoveryEndpoint`** + **`invokeEndpoint`** en
POST/PATCH (AC-2, AC-3). NO validar `agentEndpoint` en esta HU.

**Justificación**:
- `discoveryEndpoint`: fetched en `discoveryService.queryRegistry` línea 193 —
  vector activo.
- `invokeEndpoint`: NO fetched server-side hoy, pero se persiste y se inyecta
  en `Agent.invokeUrl` que el cliente consume (`mapAgent` línea 225–227). Si
  un cliente honra esa URL sin re-validar, el SSRF se propaga downstream. El
  marketplace consumidor (wasiai-v2) ya tiene su propia capa, pero el
  principio "no persistir URLs no validadas" es defensa-en-depth.
- `agentEndpoint`: el work-item ya lo marca como `[NEEDS CLARIFICATION]` en
  Missing Inputs y Scope OUT explícitamente lo excluye. Respetamos scope.
  → trackear en TD-LIGHT WKH-63-followup.
- En `discoveryService.getAgent` (fetch site #2, línea 274), la URL viene de
  `registry.agentEndpoint`. Como no validamos `agentEndpoint` en POST/PATCH,
  ese fetch site **debe validarse en runtime** con `validateRegistryUrl`. Esto
  cubre el vector aún sin tocar el endpoint en write.

**Resumen de cobertura**:

| Campo | Write-time guard (POST/PATCH) | Runtime guard (pre-fetch) |
|-------|-------------------------------|---------------------------|
| `discoveryEndpoint` | SÍ (AC-2, AC-3) | SÍ (AC-1, en `queryRegistry`) |
| `invokeEndpoint` | SÍ (AC-2, AC-3) | N/A (no fetched server-side) |
| `agentEndpoint` | NO (scope OUT) | **SÍ** (en `getAgent`, defensa única) |

### DT-D — Allowlist via `DISCOVERY_SSRF_ALLOWLIST`

**Decisión**: usar la env var **`DISCOVERY_SSRF_ALLOWLIST`** (CSV de hostnames)
como en el work-item DT-2. Cuando el hostname figura en la lista,
`validateOutboundUrl` **omite** el check de IP privada para ese hostname pero
**mantiene** el check de literal `localhost` / `*.local`.

**Justificación**:
- Los tests usan `vi.stubGlobal('fetch', mockFetch)` y NUNCA hacen fetch real,
  así que NO necesitan allowlist. Si un developer corre `npm test` sin mock
  contra `localhost:3001`, ese test es mal-diseñado y debe usar mock.
- Para staging/canary que necesite probar contra un host interno controlado,
  se pone el hostname (NO la IP) en la env var. El check de literal sigue
  bloqueando `localhost`/`*.local` (medida anti-typo).
- NO se hardcodea ningún host (CD-4 del work-item).

**Implementación** (en `validateOutboundUrl`, opt-driven):

```ts
interface ValidateOutboundOpts {
  /** Env var name to read CSV allowlist from. Default: undefined → no allowlist. */
  allowlistEnvVar?: string;
}

// Usage:
validateOutboundUrl(url, { allowlistEnvVar: 'MCP_GATEWAY_ALLOWLIST' });   // MCP
validateOutboundUrl(url, { allowlistEnvVar: 'DISCOVERY_SSRF_ALLOWLIST' });// registry
```

Cada adapter pasa la env var de su dominio. Esto evita acoplar el módulo
`src/lib/` a una env var específica.

### DT-E — Tipo de error en discovery: `SSRFViolationError extends Error`

**Decisión**: clase nueva en `src/lib/url-validator.ts`:

```ts
export class SSRFViolationError extends Error {
  public readonly field?: string;   // 'discoveryEndpoint' | 'invokeEndpoint' | undefined
  public readonly reason: string;   // human-readable
  public readonly category:         // discriminator
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
```

**Justificación**:
- NO extends `MCPToolError` — services no deben acoplar a tipos MCP (CD-1).
- `category` discriminado permite handlers granulares en el futuro sin
  string-matching del `message`.
- En route handlers (POST/PATCH), `err.field` y `err.reason` se mapean a
  `{ error: 'SSRF_BLOCKED', field, reason }` con HTTP 422.
- En `discovery.ts`, el error se loguea (`console.error`) con el `category` y
  se propaga al circuit breaker, que lo cuenta como un fallo del registry.

### DT-F — Result-style en core (no throw)

**Decisión**: `validateOutboundUrl` devuelve un `Result` discriminado, NO
throw. Los wrappers de dominio (`validateRegistryUrl`,`validateGatewayUrl`)
SÍ throw.

```ts
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface ValidationFailure {
  category: 'invalid-url' | 'invalid-protocol' | 'blocked-literal' |
            'allowlist' | 'private-ip' | 'dns-lookup-failed';
  reason: string;
}

export async function validateOutboundUrl(
  rawUrl: string,
  opts?: ValidateOutboundOpts,
): Promise<Result<URL, ValidationFailure>>;
```

**Justificación**:
- Tests más limpios — no try/catch por test, solo `expect(result.ok).toBe(false)`
  + `expect(result.error.category).toBe('private-ip')`.
- Composabilidad — el mismo result se traduce a 3 dominios distintos sin
  re-throw.
- Performance — no se construye stack trace en validation failure (en hot
  path de `queryRegistry`).

**CD nuevo**: `validateOutboundUrl` **NUNCA** debe lanzar excepciones. Si una
excepción no esperada ocurre (ej. `dns.lookup` rechaza), debe ser capturada y
traducida a `Result.Err({ category: 'dns-lookup-failed', reason })`.

---

## 3. Constraint Directives (CD)

Heredados del work-item:

- **CD-1**: PROHIBIDO que `src/services/` importe de `src/mcp/`. Dependencia
  va `src/mcp/` → `src/lib/`.
- **CD-2**: PROHIBIDO exponer stack trace de `SSRFViolationError` al cliente
  HTTP. Solo `{ error, field, reason }`.
- **CD-3**: OBLIGATORIO `validateGatewayUrl` mantiene firma
  `(rawUrl: string) => Promise<URL>` y sigue lanzando `MCPToolError(-32602)`.
- **CD-4**: OBLIGATORIO env var `DISCOVERY_SSRF_ALLOWLIST` (no hardcode).
- **CD-5**: OBLIGATORIO baseline ≥480 tests verde.
- **CD-6**: PROHIBIDO `src/lib/url-validator.ts` importe de `src/mcp/types.ts`
  (evitar circularidad).

Nuevos del SDD:

- **CD-A1**: `validateOutboundUrl` (función core en `src/lib/url-validator.ts`)
  **NUNCA** debe lanzar — siempre devuelve `Result`. Si una excepción inesperada
  surge dentro (ej. `dns.lookup` rechaza con error no-`Error`), capturarla y
  traducir a `Result.Err({ category: 'dns-lookup-failed', reason: err.message })`.
- **CD-A2**: Los tests nuevos de SSRF deben **mockear `node:dns` con
  `vi.mock('node:dns', () => ({ promises: { lookup: ... } }))`** — mismo patrón
  que `src/mcp/url-validator.test.ts:9–15`. NO usar `vi.spyOn(dns, 'lookup')`
  (no funciona con default-imported `promises`).
- **CD-A3**: En `src/services/discovery.ts`, el guard `await
  validateRegistryUrl(...)` se inserta **antes** del `cb.execute(...)` y
  **antes** del `await fetch(...)` en `getAgent`. NO debe estar dentro del
  callback de `cb.execute` (de lo contrario, el rechazo SSRF cuenta como un
  "fallo del registry" en circuit breaker stats — evitar contaminación
  estadística).
- **CD-A4** (Auto-Blindaje recurrente, ref. AB-WKH-53-#3): Tests del validator
  deben cubrir explícitamente: `''`, `' '`, `null` (cast), `undefined` (cast),
  `'http://'` (URL parse válida pero sin host), `'http://[invalid'` (parse
  falla). NO confiar en que el guard implícito los cubre.
- **CD-A5**: El guard de routes (POST/PATCH) debe validar **TODOS** los campos
  outbound del body **antes** de llamar al service (no validar uno, llamar
  service, fallar, validar otro). Esto evita writes parciales / race conditions
  y simplifica mensajes 422 (un solo campo reportado por request).
- **CD-A6** (test isolation, ref. AB-WKH-57-1): Los nuevos archivos de test
  (`src/lib/url-validator.test.ts`, `src/services/discovery.ssrf.test.ts`,
  `src/routes/registries.ssrf.test.ts`) deben ser archivos **separados** de
  los existentes para evitar contaminación de `vi.mock('node:dns')` con
  otros suites que NO mockean dns.
- **CD-A7**: PROHIBIDO usar `dns.resolve()` o `dns.resolve4()` en lugar de
  `dns.lookup()`. `lookup` aplica `/etc/hosts` y NSS — comportamiento
  consistente con el `fetch` real. `resolve` ignora `/etc/hosts` y se
  desincroniza del path real de la request.

---

## 4. Waves de implementación

Sizing: **M (3–4h)**. 3 waves bien diferenciadas, W0 standalone-mergeable.

### W0 — Extraer y refactor (standalone-mergeable)

**Goal**: `src/lib/url-validator.ts` existe con `validateOutboundUrl` +
`validateRegistryUrl` + `SSRFViolationError`. `src/mcp/url-validator.ts`
re-exporta o wrappea sin breaking change. Suite MCP existente PASS.

**Archivos**:
- `src/lib/url-validator.ts` (NEW) — copia y generaliza la lógica de
  `src/mcp/url-validator.ts`. Exporta:
  - `validateOutboundUrl(rawUrl, opts?): Promise<Result<URL, ValidationFailure>>`
  - `validateRegistryUrl(rawUrl): Promise<URL>` (throws `SSRFViolationError`)
  - `SSRFViolationError`
  - `Result`, `ValidationFailure`, `ValidateOutboundOpts` (types)
- `src/mcp/url-validator.ts` (MODIFY) — refactor a thin adapter:
  ```ts
  import { validateOutboundUrl } from '../lib/url-validator.js';
  import { MCP_ERRORS, MCPToolError } from './types.js';

  export async function validateGatewayUrl(rawUrl: string): Promise<URL> {
    const result = await validateOutboundUrl(rawUrl, {
      allowlistEnvVar: 'MCP_GATEWAY_ALLOWLIST',
    });
    if (!result.ok) {
      // Traducir mensajes para mantener exact-match con tests existentes
      throw new MCPToolError(MCP_ERRORS.INVALID_PARAMS, mapMcpMessage(result.error));
    }
    return result.value;
  }
  ```
  `mapMcpMessage` produce strings compatibles con los `expect().toContain()`
  de los tests existentes (`'gatewayUrl is not a valid URL'`,
  `'gatewayUrl protocol not allowed'`, etc. — preservar prefijo "gatewayUrl").
- `src/lib/url-validator.test.ts` (NEW) — 18 tests (ver §6.1).

**Done W0**:
- `npm run typecheck` clean.
- `npm test src/mcp/url-validator.test.ts` PASS (no breaking change).
- `npm test src/lib/url-validator.test.ts` PASS (nuevos tests).
- W0 puede mergearse a `main` de forma aislada: el sistema sigue funcionando
  exactamente igual que antes, con la lógica relocalizada.

### W1 — Aplicar guard en discovery service (runtime)

**Goal**: `queryRegistry` y `getAgent` rechazan endpoints SSRF **antes** del
fetch.

**Archivos**:
- `src/services/discovery.ts` (MODIFY):
  - Línea 153, **inmediatamente después** del `new URL(...)`:
    ```ts
    await validateRegistryUrl(registry.discoveryEndpoint);
    // si throw → propaga al .catch() del Promise.all en discover() L70
    ```
    NOTA: el guard se aplica sobre el string original (`registry.discoveryEndpoint`),
    NO sobre `url.toString()` (que ya tiene query params añadidos). Eso es importante
    porque la validación es del HOST, y mantener el contrato que Storage Layer
    debió haber validado en write-time.
  - Línea 274 (`getAgent`), antes del `fetch`:
    ```ts
    try {
      await validateRegistryUrl(url);
    } catch {
      continue;  // skip this registry, try next (matching empty-catch pattern existing)
    }
    ```
- `src/services/discovery.ssrf.test.ts` (NEW) — 6 tests (ver §6.2).

**Done W1**:
- `npm test src/services/discovery.ssrf.test.ts` PASS.
- `npm test src/services/discovery.test.ts` PASS (suite WKH-DISCOVER-VERIFIED y
  WKH-57 fallback no afectada).

### W2 — Aplicar guard en routes + service (write-time)

**Goal**: POST/PATCH `/registries` rechazan body con URLs SSRF antes del DB
write. Y `registryService.register` / `update` agregan defense-in-depth.

**Archivos**:
- `src/routes/registries.ts` (MODIFY):
  - POST `/`: después del check de required fields (línea 78–82), antes de
    `registryService.register`, validar `discoveryEndpoint` y `invokeEndpoint`.
    En caso de fallo:
    ```ts
    return reply.status(422).send({
      error: 'SSRF_BLOCKED',
      field: err.field,
      reason: err.reason,
    });
    ```
  - PATCH `/:id`: antes de `registryService.update`, iterar sobre los campos
    del body que sean `discoveryEndpoint` / `invokeEndpoint` y validar. Mismo
    422.
- `src/services/registry.ts` (MODIFY): defense-in-depth en `register` y
  `update`. Si las routes validan correctamente, este guard nunca dispara —
  pero protege futuros callers internos del service.
- `src/routes/registries.ssrf.test.ts` (NEW) — 8 tests (ver §6.3).

**Done W2**:
- `npm test src/routes/registries.ssrf.test.ts` PASS.
- `npm test src/routes/registries.test.ts` PASS (auth tests WKH-SEC-01 no
  afectados).
- `npm test` global PASS con **≥480 + ~32 nuevos = ≥512 tests** verde.

---

## 5. Exemplars verificados

| Exemplar | Path:línea | Patrón a replicar |
|----------|------------|-------------------|
| Validator core | `src/mcp/url-validator.ts:111–179` | Estructura `parse → protocol → literal → allowlist → DNS resolve`. |
| DNS mock pattern | `src/mcp/url-validator.test.ts:9–15` | `vi.mock('node:dns', () => ({ promises: { lookup: (...args) => mockLookup(...args) } }))`. |
| Lookup mock setup | `src/mcp/url-validator.test.ts:32–47` | `mockLookup.mockResolvedValueOnce([{ address, family }])`. |
| Discovery test mock | `src/services/discovery.test.ts:7–30` | `vi.mock('./registry.js')` + `vi.stubGlobal('fetch', mockFetch)`. |
| Fastify route test | `src/routes/registries.test.ts:25–80` | `vi.mock('../services/registry.js')` + `Fastify().register()` + `app.inject(...)`. |
| Auth required test | `src/routes/registries.test.ts:116–151` | Pattern POST/PATCH/DELETE con `app.inject` + status code assertion. |
| Result-style return | `src/services/discovery.ts:331–342` (`parsePriceSafe`) | Pure function que NO throw, devuelve safe default — paralelo conceptual al `Result.Err` de validator. |

---

## 6. Plan de tests detallado

### 6.1 `src/lib/url-validator.test.ts` (NEW)

| ID | Test | AC |
|----|------|----|
| T-LIB-01 | `''` (empty string) → Err `invalid-url` | AC-7 (edge) |
| T-LIB-02 | `' '` (whitespace) → Err `invalid-url` | AC-7 (edge) |
| T-LIB-03 | `'not a url'` → Err `invalid-url` | AC-7 |
| T-LIB-04 | `'file:///etc/passwd'` → Err `invalid-protocol` | AC-5 (file://) |
| T-LIB-05 | `'data:text/html,<script>alert(1)</script>'` → Err `invalid-protocol` | AC-5 |
| T-LIB-06 | `'javascript:alert(1)'` → Err `invalid-protocol` | AC-5 |
| T-LIB-07 | `'ftp://example.com'` → Err `invalid-protocol` | AC-5 |
| T-LIB-08 | `'http://localhost:8080'` → Err `blocked-literal` | AC-5 |
| T-LIB-09 | `'https://printer.local'` → Err `blocked-literal` | AC-5 |
| T-LIB-10 | `'http://0.0.0.0'` (DNS resolve to 0.0.0.0) → Err `private-ip` | AC-5 |
| T-LIB-11 | `'http://10.0.0.1'` (DNS resolve to 10.0.0.1) → Err `private-ip` | AC-5 |
| T-LIB-12 | `'http://[::ffff:169.254.169.254]'` (IPv4-mapped IPv6 dotted) → Err `private-ip` | AC-5 (DT-B) |
| T-LIB-13 | `'http://[::ffff:a9fe:a9fe]'` (IPv4-mapped hex form) → Err `private-ip` | AC-5 (DT-B) |
| T-LIB-14 | `'https://example.com'` resolve to `93.184.216.34` → Ok with URL | AC-7 |
| T-LIB-15 | `'https://example.com'` con `DISCOVERY_SSRF_ALLOWLIST=example.com`, resolve to `127.0.0.1` → **Ok** (private check bypassed) | AC-4 |
| T-LIB-16 | `'http://localhost'` con `DISCOVERY_SSRF_ALLOWLIST=localhost` → Err `blocked-literal` (literal NO bypassable) | AC-4 |
| T-LIB-17 | dns.lookup rejects → Err `dns-lookup-failed` (NO throw) | AC-7 (CD-A1) |
| T-LIB-18 | `validateRegistryUrl` (wrapper) throws `SSRFViolationError` con `category='private-ip'` para `'http://10.0.0.1'` | AC-1, AC-5 |

### 6.2 `src/services/discovery.ssrf.test.ts` (NEW)

| ID | Test | AC |
|----|------|----|
| T-DISC-01 | `queryRegistry` con `discoveryEndpoint='http://169.254.169.254/agents'` (resolve to 169.254.169.254) → throws SSRFViolationError, fetch NO se llama | AC-1 |
| T-DISC-02 | `queryRegistry` con `discoveryEndpoint='https://example.com/agents'` (resolve to public IP) → fetch SÍ se llama, retorna agents | AC-1 (positive) |
| T-DISC-03 | `discover()` con un registry SSRF en lista → ese registry contribuye 0 agents (catch en L70 captura el error), otros registries siguen funcionando | AC-1 (resilience) |
| T-DISC-04 | `getAgent` con `agentEndpoint='http://127.0.0.1/agent/{slug}'` → continue (skip), retorna null si no hay otros registries | AC-1 (extension to getAgent) |
| T-DISC-05 | `queryRegistry` el guard se llama ANTES del circuit breaker (no contamina stats) | CD-A3 |
| T-DISC-06 | `DISCOVERY_SSRF_ALLOWLIST=internal.test` permite fetch a hostname interno | AC-4 |

### 6.3 `src/routes/registries.ssrf.test.ts` (NEW)

| ID | Test | AC |
|----|------|----|
| T-REG-01 | POST `/registries` con `discoveryEndpoint='http://169.254.169.254/discover'` → 422 + `{ error: 'SSRF_BLOCKED', field: 'discoveryEndpoint', reason: ... }`, `registryService.register` NOT called | AC-2 |
| T-REG-02 | POST `/registries` con `discoveryEndpoint` válido + `invokeEndpoint='http://10.0.0.1/invoke'` → 422 con `field: 'invokeEndpoint'` | AC-2 |
| T-REG-03 | POST `/registries` con ambos endpoints válidos → 201 + registry creado | AC-2 (positive) |
| T-REG-04 | POST `/registries` con `discoveryEndpoint='file:///etc/passwd'` → 422 + `field: 'discoveryEndpoint'` | AC-2 |
| T-REG-05 | PATCH `/registries/:id` con `discoveryEndpoint='http://localhost'` → 422 + `field: 'discoveryEndpoint'`, `registryService.update` NOT called | AC-3 |
| T-REG-06 | PATCH `/registries/:id` con solo `name='new'` (sin URLs) → 200 (validation no aplica) | AC-3 (positive) |
| T-REG-07 | PATCH `/registries/:id` con `invokeEndpoint='https://valid.com'` → 200 | AC-3 (positive) |
| T-REG-08 | POST `/registries` con `discoveryEndpoint='http://[invalid'` (URL parse falla) → 422 + `category: 'invalid-url'` mapped to reason | AC-7 (edge) |

### 6.4 Suites existentes que deben seguir verde

- `src/mcp/url-validator.test.ts` — 17 tests existentes (CD-3, CD-5).
- `src/services/discovery.test.ts` — suite WKH-DISCOVER-VERIFIED + WKH-57 fallback.
- `src/routes/registries.test.ts` — suite WKH-SEC-01.
- TODOS los tests del repo: ≥480 baseline → ~512 con la HU.

---

## 7. Estructura de errores HTTP (route handlers)

Para CD-2 (no exponer stack trace):

```ts
// POST /registries — bloque catch DEDICADO para SSRFViolationError
try {
  for (const field of ['discoveryEndpoint', 'invokeEndpoint'] as const) {
    await validateRegistryUrl(body[field]).catch((err) => {
      if (err instanceof SSRFViolationError) {
        // Re-throw con field annotation para el outer catch
        err.field = field;
        throw err;
      }
      throw err;
    });
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

Estructura final del 422:
```json
{
  "error": "SSRF_BLOCKED",
  "field": "discoveryEndpoint",
  "reason": "URL resolves to non-public IPv4: 169.254.169.254"
}
```

NO incluir `stack`, NO incluir `category` en el body (es interno — solo en
log). Tests T-REG-01..T-REG-08 verifican exactamente estos 3 campos.

---

## 8. Variables de entorno

| Variable | Tipo | Descripción | Default |
|----------|------|-------------|---------|
| `DISCOVERY_SSRF_ALLOWLIST` | CSV (string) | Hostnames permitidos en discovery (bypassan check de IP privada). Literal `localhost`/`*.local` siguen bloqueados. | unset (sin allowlist) |
| `MCP_GATEWAY_ALLOWLIST` | CSV (string) | Existente — allowlist para MCP gateway. NO modificada en esta HU. | unset |

Documentar en `.env.example` (W2 task).

---

## 9. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|-----------|
| DNS rebinding (atacante devuelve IP pública en first lookup, IP privada en segundo) | BAJA en hackathon, MEDIA prod | ALTO | El guard hace `dns.lookup` ANTES del fetch, pero el `fetch` hace su propio lookup. **Mitigation parcial**: el primer lookup detecta la mayoría de casos. **Mitigación total**: usar `agent.lookup` custom que cachee la IP del primer lookup y la reuse en el fetch real. Tracked en TD-LIGHT-WKH-62-followup, fuera de scope. Tests T-LIB-* documentan que validamos el momento del check. |
| Test contamination con `vi.mock('node:dns')` | MEDIA | MEDIA | CD-A6: archivos de test SEPARADOS. Vitest aísla mocks por archivo. Validar con `npm test -- --reporter=verbose --seed=random`. |
| Breaking change en `validateGatewayUrl` (mensajes distintos) | MEDIA | MEDIA | CD-3 + tests existentes (`expect().toContain()` con strings exactos). El refactor en W0 mantiene `'gatewayUrl ...'` prefix. Validar con suite MCP en W0. |
| Defense-in-depth en `registryService` introduce duplicación | BAJA | BAJA | Aceptado — es defensa explícita. El service throw `Error` genérico (no `SSRFViolationError`) para que rutas que no validen previamente reciban un 400 con mensaje claro. |
| Performance: `dns.lookup` en cada `queryRegistry` (cada 30s en compose) | BAJA | BAJA | DNS lookup local es ~1ms. Node OS-level cache (`getaddrinfo`) lo memoiza. Si emerge como hotspot, agregar cache LRU en TD posterior. |

---

## 10. Análisis de impacto

**Archivos modificados**: 4 (`src/mcp/url-validator.ts`, `src/services/discovery.ts`,
`src/routes/registries.ts`, `src/services/registry.ts`).

**Archivos nuevos**: 4 (`src/lib/url-validator.ts`, +3 test files).

**Líneas estimadas**: ~250 src + ~400 test = ~650 LOC.

**Callers afectados** (grep `validateGatewayUrl`):
- `src/mcp/tools/pay-x402.ts` — usa `validateGatewayUrl` para `gatewayUrl`.
- `src/mcp/tools/get-payment-quote.ts` — usa `validateGatewayUrl`.
- Ninguno cambia su firma. Pasan W0 sin tocar.

**Schema DB**: NO cambia. CD del work-item.

**Backwards compat**: 100%. Routes nuevas devuelven 422 (no 4xx del path
anterior). MCP tools sin cambio.

---

## 11. Done definition

Una vez completadas las 3 waves, esta HU se considera DONE cuando:

- [x] `src/lib/url-validator.ts` existe y exporta los símbolos nuevos.
- [x] `src/mcp/url-validator.ts` re-implementado como adapter — suite MCP
      existente sigue verde sin modificar tests.
- [x] `src/services/discovery.ts` valida `discoveryEndpoint` antes del fetch
      en `queryRegistry` (línea 153) y `agentEndpoint` en `getAgent` (línea 274).
- [x] `src/routes/registries.ts` valida `discoveryEndpoint` + `invokeEndpoint`
      en POST y PATCH, devuelve 422 con shape exacto.
- [x] `src/services/registry.ts` agrega defense-in-depth en `register` y
      `update`.
- [x] 3 nuevas suites de tests (`src/lib/url-validator.test.ts`,
      `src/services/discovery.ssrf.test.ts`,
      `src/routes/registries.ssrf.test.ts`) — total ~32 tests nuevos.
- [x] `npm test` global ≥512 tests verde (480 baseline + 32 nuevos).
- [x] `npm run typecheck` clean.
- [x] `npm run lint` clean.
- [x] `.env.example` documenta `DISCOVERY_SSRF_ALLOWLIST`.

---

## 12. Readiness Check

- [x] Work item HU_APPROVED.
- [x] Codebase grounding: 8 archivos leídos con líneas verificadas.
- [x] Exemplars: `src/mcp/url-validator.ts:111–179`,
      `src/mcp/url-validator.test.ts:9–15` confirmados con Read.
- [x] DTs OPEN del work item resueltos: DT-A (extracción), DT-B (IPv6-mapped),
      DT-C (campos cubiertos), DT-D (allowlist).
- [x] DTs nuevos del SDD: DT-E (SSRFViolationError shape), DT-F (Result vs throw).
- [x] CDs heredados (CD-1..CD-6) + nuevos (CD-A1..CD-A7).
- [x] Waves W0/W1/W2 con archivos exactos por wave. W0 standalone-mergeable.
- [x] Test plan ≥1 test por AC + 18 + 6 + 8 = 32 tests SSRF-específicos.
- [x] Auto-Blindajes consultados: 057, 056, 055 — patrones aplicados (CD-A1..A7).
- [x] Sin `[NEEDS CLARIFICATION]` pendientes en SDD.
- [x] Risk analysis con mitigaciones explícitas.

**Veredicto**: SDD listo para `SPEC_APPROVED`. F2.5 (Story File) puede generarse
inmediatamente tras la aprobación humana.

---

> Generado: 2026-04-27
> Architect: nexus-architect
> Próximo gate humano: `SPEC_APPROVED` → habilita F2.5 (story-file.md)
