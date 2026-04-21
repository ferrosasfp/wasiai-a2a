# SDD #043: Security Hardening — HSTS + CORS restrictivo + requireAuth en /registries

> SPEC_APPROVED: no
> Fecha: 2026-04-20
> HU: WKH-SEC-01
> Tipo: security hardening
> SDD_MODE: mini
> Pipeline: QUALITY
> Branch: feat/043-wkh-sec-01-hardening
> Artefactos: doc/sdd/043-wkh-sec-01/
> Estimación: S

---

## 1. Resumen técnico

Auditoría de seguridad del 2026-04-20 detectó tres vulnerabilidades en la superficie HTTP del gateway A2A:

1. **Endpoints de escritura en `/registries` son públicos** — `POST /registries`, `PATCH /registries/:id`, `DELETE /registries/:id` aceptan requests sin credenciales, permitiendo que cualquier actor externo registre, modifique o borre marketplaces. `/compose` y `/orchestrate` ya están protegidos con `requirePaymentOrA2AKey`; aquí se replica el mismo patrón.
2. **CORS wildcard `*` en producción** — `src/index.ts:36` registra `@fastify/cors` con `{ origin: '*' }` sin considerar `NODE_ENV`. En producción esto habilita CSRF asistido por navegador y deja la API abierta a cualquier frontend malicioso.
3. **Ausencia de header HSTS** — el hook `onSend` en `security-headers.ts` emite `X-Content-Type-Options` y `X-Frame-Options` pero no `Strict-Transport-Security`, dejando a los clientes expuestos a downgrade attacks sobre HTTP en la primera conexión.

Esta HU aplica tres fixes quirúrgicos sin refactors. Todos los componentes reutilizados (`requirePaymentOrA2AKey`, hook `onSend`, `@fastify/cors`) ya existen y son estables. El trabajo nuevo es la configuración env-aware de CORS.

Durante F2 se resolvieron dos `[NEEDS CLARIFICATION]` del work-item (ver DT-6 y DT-7):
- **PATCH /registries/:id** se incluye en el scope de auth (nuevo AC-2b).
- **HSTS se emite incondicionalmente** (no condicional por `X-Forwarded-Proto`).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 043 |
| **HU** | WKH-SEC-01 |
| **Tipo** | security hardening |
| **SDD_MODE** | mini |
| **Objetivo** | Cerrar 3 vulnerabilidades: auth en `/registries` (POST/PATCH/DELETE), CORS env-aware, header HSTS |
| **Scope IN** | `src/routes/registries.ts`, `src/index.ts` (línea 36), `src/middleware/security-headers.ts`, `src/middleware/security-headers.test.ts`, `src/routes/registries.test.ts` (nuevo), `src/__tests__/cors.test.ts` (nuevo), `.env.example` |
| **Scope OUT** | `src/middleware/a2a-key.ts` (no modificar firma), `/compose` y `/orchestrate` (ya tienen auth), `src/mcp/`, `GET /registries` y `GET /registries/:id` (lectura pública), timing-safe compare de a2a-key (otra HU), refactor de middlewares, certificados TLS / reverse proxy config |
| **Missing Inputs** | Todos resueltos en F2. Ver §9. |

### Acceptance Criteria (EARS)

Heredados del work-item más AC-2b agregado por F2:

1. **AC-1**: WHEN a `POST /registries` request arrives without a valid `x-a2a-key` header or a valid `Authorization: Bearer wasi_a2a_*` token, the system SHALL respond with HTTP 401 or 403 and reject the request before executing any business logic.
2. **AC-2**: WHEN a `DELETE /registries/:id` request arrives without a valid `x-a2a-key` header or a valid `Authorization: Bearer wasi_a2a_*` token, the system SHALL respond with HTTP 401 or 403 and reject the request before executing any business logic.
3. **AC-2b** *(nuevo en F2)*: WHEN a `PATCH /registries/:id` request arrives without a valid `x-a2a-key` header or a valid `Authorization: Bearer wasi_a2a_*` token, the system SHALL respond with HTTP 401 or 403 and reject the request before executing any business logic.
4. **AC-3**: WHEN the server sends any HTTP response, the system SHALL include the header `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
5. **AC-4**: WHILE `NODE_ENV=production` and `CORS_ALLOWED_ORIGINS` is set, the system SHALL reject CORS preflight and cross-origin requests from origins not listed in `CORS_ALLOWED_ORIGINS` — the `Access-Control-Allow-Origin` header SHALL NOT be set to `*`.
6. **AC-5**: WHILE `NODE_ENV=development` (or `NODE_ENV` is absent), the system SHALL allow all origins (`*`) for CORS to facilitate local development and testing.
7. **AC-6**: WHILE `NODE_ENV=production` and `CORS_ALLOWED_ORIGINS` is not set, the system SHALL default to blocking all cross-origin requests (no wildcard fallback) and log a warning at startup.
8. **AC-7**: IF the total test suite is run after the changes, THEN the system SHALL have all previously passing tests continue to pass, and the new tests covering AC-1..AC-6 SHALL pass.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos durante F2

| Archivo | Líneas | Por qué | Patrón extraído |
|---------|--------|---------|-----------------|
| `src/middleware/a2a-key.ts` | 1-217 | Firma de `requirePaymentOrA2AKey` y comportamiento | Factory `(opts: PaymentMiddlewareOptions) => preHandlerAsyncHookHandler[]` — devuelve array. Debe ser spread en `preHandler`. Internamente delega a `requirePayment(opts)` si no hay `x-a2a-key` ni `Authorization: Bearer wasi_a2a_*`. Responde 403 con `{error, error_code}` en fallo de key; 402 en fallo x402. |
| `src/middleware/x402.ts` | 25-28 | Firma de `PaymentMiddlewareOptions` | `{ description: string; amount?: string }`. Se pasa a `requirePayment` internamente. |
| `src/routes/compose.ts` | 1-81 | Patrón de uso del middleware en ruta existente | En `fastify.post('/', { preHandler: [...requirePaymentOrA2AKey({ description: '...' })] }, handler)`. Importación: `import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js'`. Rate limit + timeout pueden preceder; auth es el último preHandler antes del handler. |
| `src/routes/orchestrate.ts` | 1-99 | Segundo exemplar de uso del middleware | Idéntico patrón que `compose.ts`. Confirma la convención: `...requirePaymentOrA2AKey({ description: 'WasiAI <Service> — <descripción>' })`. |
| `src/middleware/security-headers.ts` | 1-14 | Hook `onSend` existente | `registerSecurityHeaders(fastify)` agrega `fastify.addHook('onSend', async (_request, reply) => { reply.header(...) })`. Para agregar HSTS basta añadir un `reply.header('strict-transport-security', '<valor>')` en el mismo hook. |
| `src/middleware/security-headers.test.ts` | 1-50 | Patrón de test del middleware | Usa `Fastify()` raíz, llama `registerSecurityHeaders(app)`, registra un `GET /health` dummy, `await app.ready()`, luego `app.inject({ method: 'GET', url: '/health' })` y verifica `response.headers[...]`. `describe` + `beforeAll`/`afterAll`. |
| `src/index.ts` | 1-150 | Entry point — ubicación del CORS y orden de hooks | Línea 36: `await fastify.register(cors, { origin: '*' });` se ejecuta ANTES de `registerSecurityHeaders` (línea 40). Refactor: reemplazar `{ origin: '*' }` por objeto computado desde env. `@fastify/cors` v11 acepta `origin: boolean | string | string[] | RegExp | Function`. |
| `src/routes/registries.ts` | 1-153 | Rutas a proteger | 5 handlers: `GET /` (14), `GET /:id` (26-41), `POST /` (47-96), `PATCH /:id` (102-123), `DELETE /:id` (129-150). POST/PATCH/DELETE no usan opciones con `preHandler`. Los 3 deben recibir `{ preHandler: [...requirePaymentOrA2AKey({ description: '...' })] }`. |
| `src/routes/auth.test.ts` | 1-60 | Patrón para tests de rutas con mocks | Mockea `identityService` y `budgetService` con `vi.mock(...)`. Usa `Fastify()`, registra solo las rutas bajo test. Inyecta con `app.inject({ method: 'POST', url: '/...', headers: {...}, payload: {...} })`. |
| `src/middleware/a2a-key.test.ts` | 1-80 | Cómo mockear el middleware para tests de auth 401/403 | Para tests de "sin credenciales", NO se necesita mockear `identity/budget` si se confirma que `runX402Fallback` devuelve 402. Para tests con credencial inválida, mockear `identityService.lookupByHash` para que devuelva `null` (→ 403 `KEY_NOT_FOUND`). |
| `.env.example` | 1-149 | Lugar donde documentar variables | Secciones encabezadas con `# ─────────...` y título. Agregar nueva sección "CORS" con `CORS_ALLOWED_ORIGINS=`. |
| `doc/sdd/037-x402-v2/sdd.md` | 1-120 | Formato de SDD del proyecto | Estructura sección 1 (Resumen), 2 (Work Item), 3 (Context Map), 4 (Diseño Técnico), Waves, DTs, Tests. Seguimos ese template. |
| `doc/sdd/_INDEX.md` | 1-43 | Histórico de HUs y auto-blindaje | No existe archivo `auto-blindaje.md` en HUs DONE previas (039, 040, 041, 042). No hay patrones de error recurrentes documentados — paso salteado silenciosamente. |

### 3.2 Componentes reutilizados SIN modificación

- **`requirePaymentOrA2AKey`** — `src/middleware/a2a-key.ts:83`. Se importa y se usa; su firma interna y comportamiento NO cambian (CD-1).
- **`PaymentMiddlewareOptions`** — `src/middleware/x402.ts:25`. Shape `{ description: string; amount?: string }`. Solo pasamos `description`.
- **Hook `onSend`** en `registerSecurityHeaders` — `src/middleware/security-headers.ts:9-14`. Se agrega una línea `reply.header(...)` al hook existente.
- **`@fastify/cors` v11** — ya instalado (`package.json:17`). La API acepta `origin` como `boolean | string | string[] | RegExp | OriginFunction`.

### 3.3 Archivos que se crean

- `src/routes/registries.test.ts` — nuevo archivo de tests para AC-1, AC-2, AC-2b.
- `src/__tests__/cors.test.ts` — nuevo archivo de tests para AC-4, AC-5, AC-6.

### 3.4 Auto-Blindaje histórico

Se inspeccionó `doc/sdd/_INDEX.md` y las últimas 4 HUs DONE (042, 041, 040, 039). Ninguna tiene archivo `auto-blindaje.md`. No hay patrones de error recurrentes para heredar como Constraint Directives adicionales. Paso salteado según la regla del skill.

---

## 4. Diseño técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/routes/registries.ts` | Modificar | Agregar `{ preHandler: [...requirePaymentOrA2AKey({ description: 'WasiAI Registry Management — <METHOD>' })] }` como segundo argumento en `fastify.post('/', ...)`, `fastify.patch('/:id', ...)` y `fastify.delete('/:id', ...)`. Importar `requirePaymentOrA2AKey` de `../middleware/a2a-key.js`. NO tocar `GET /` ni `GET /:id`. | `src/routes/compose.ts:18-32` |
| `src/index.ts` | Modificar | Línea 36: reemplazar `await fastify.register(cors, { origin: '*' });` por el bloque descrito en §4.2. Agregar import de nueva función `buildCorsOptions` o computar inline (decisión en §4.2). | — |
| `src/middleware/security-headers.ts` | Modificar | En el hook `onSend`, agregar tercera línea: `reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');`. Constante string, sin env var (DT-2 heredada). | `src/middleware/security-headers.ts:10-14` |
| `src/middleware/security-headers.test.ts` | Modificar | Agregar test unitario: `it('AC-3: response includes Strict-Transport-Security header', ...)`. Patrón idéntico a los tests existentes AC-1/AC-2. | Tests existentes en el mismo archivo (líneas 23-49) |
| `src/routes/registries.test.ts` | Crear | 3 tests: AC-1 (POST sin header → 401/403), AC-2 (DELETE sin header → 401/403), AC-2b (PATCH sin header → 401/403). Mockear `registryService` para evitar dependencia de Supabase. Mockear `identityService.lookupByHash` → `null` para el camino "key inválida". Para el camino "sin header", no requiere mocks de identity/budget porque delega a x402 que responde 402 (equivale a "rechaza antes del business logic"). | `src/routes/auth.test.ts` para patrón de mocks; `src/routes/agent-card.test.ts` para patrón de inject |
| `src/__tests__/cors.test.ts` | Crear | 3 tests: AC-4 (prod + origins configurados → rechaza origin no-listado, headers no incluyen `*`), AC-5 (dev → `Access-Control-Allow-Origin: *`), AC-6 (prod sin `CORS_ALLOWED_ORIGINS` → rechaza todo + logs warning). Usar `Fastify()` con reconstrucción manual del registro de cors según env mockeado. | Estructura de `src/middleware/security-headers.test.ts` (inject pattern) |
| `.env.example` | Modificar | Agregar sección `# ─── CORS ─────...` con `CORS_ALLOWED_ORIGINS=` y comentario explicativo: "CSV de origins permitidos en producción. En development se ignora (se permite `*`). Ejemplo: `https://app.wasiai.io,https://wasiai.io`. En producción, si queda vacío, TODOS los origins cross-site son rechazados." | Convención del propio `.env.example` |

### 4.2 Lógica nueva: configuración CORS env-aware

**Ubicación**: `src/index.ts`, inline donde hoy está la línea 36. Sin archivo de config separado (DT-5 heredada).

**Algoritmo** (pseudocódigo, no es el código final):

```
isProduction = process.env.NODE_ENV === 'production'
originsEnv = process.env.CORS_ALLOWED_ORIGINS  // string CSV | undefined

if NOT isProduction:
    corsOptions = { origin: '*' }               // AC-5
else if originsEnv is set and non-empty:
    origins = originsEnv.split(',').map(s => s.trim()).filter(s => s.length > 0)
    corsOptions = { origin: origins }            // AC-4 — @fastify/cors v11 acepta string[]
else:
    fastify.log.warn('CORS_ALLOWED_ORIGINS not set in production — blocking all cross-origin requests')
    corsOptions = { origin: false }              // AC-6 — @fastify/cors v11: false ⇒ no CORS header, rechaza cross-origin

await fastify.register(cors, corsOptions)
```

**Notas técnicas**:
- `@fastify/cors` v11 con `origin: false` ⇒ no emite `Access-Control-Allow-Origin`, así que cross-origin queda efectivamente bloqueado en navegador. Cumple AC-6 "blocking all cross-origin requests".
- Con `origin: string[]` v11 hace match exacto case-sensitive contra el header `Origin` del request y solo responde `Access-Control-Allow-Origin: <origin>` si coincide. Cumple AC-4 (no wildcard, solo allowlist).
- Same-origin requests (sin header `Origin`) nunca son afectados por CORS — el servidor sigue respondiendo normal.
- `fastify.log` está disponible porque `registerCorsOptions` se computa antes del `register(cors)` pero el logger ya existe (se configuró en `Fastify({ logger: true })` línea 33).

### 4.3 Modelo de datos

N/A — no hay cambios de DB.

### 4.4 Componentes / servicios nuevos

- Ninguno. Solo wiring de componentes existentes (`requirePaymentOrA2AKey`, `@fastify/cors`, `onSend` hook).

### 4.5 Valor constante HSTS

Se declara como string literal en `src/middleware/security-headers.ts`:

```
const HSTS_VALUE = 'max-age=31536000; includeSubDomains; preload';
```

Sin env var (DT-2 heredada). Valor estándar de producción: 1 año, incluye subdominios, elegible para la preload list de navegadores.

---

## 5. Decisiones técnicas (DTs)

DTs heredadas del work-item (vigentes):

- **DT-1**: Reutilizar `requirePaymentOrA2AKey` sin modificar. Patrón idéntico al de `/compose` y `/orchestrate`.
- **DT-2**: HSTS declarado como constante string, no env var. `max-age=31536000; includeSubDomains; preload` no tiene variantes legítimas por entorno.
- **DT-3**: `CORS_ALLOWED_ORIGINS` es string CSV. Split por coma + trim + filter vacíos.
- **DT-4**: Fail-secure: en producción sin `CORS_ALLOWED_ORIGINS` se rechaza todo + warn log.
- **DT-5**: Configuración CORS inline en `src/index.ts`, sin archivo de config separado. Scope de cambio mínimo.

DTs nuevas decididas en F2:

- **DT-6** *(nueva)*: `PATCH /registries/:id` SE PROTEGE con el mismo `requirePaymentOrA2AKey`. Razón: el endpoint muta estado persistente (misma superficie de ataque que POST/DELETE). Mantenerlo público es inconsistente con el modelo de amenaza que motivó la HU. Se agrega AC-2b.
- **DT-7** *(nueva)*: HSTS se emite **incondicionalmente** (no condicional por `X-Forwarded-Proto`). Razones:
  1. Railway/reverse proxy termina TLS en producción — todo el tráfico que llega al servicio HTTP se origina de cliente HTTPS.
  2. El spec [RFC 6797 §7.2](https://www.rfc-editor.org/rfc/rfc6797#section-7.2) obliga a los navegadores a **ignorar** el header `Strict-Transport-Security` si la conexión fue HTTP — emitirlo "de más" es inocuo.
  3. Simplifica el código (sin branching) y elimina una fuente de bugs por confianza errónea en `X-Forwarded-Proto`.
  Esta DT cierra el `[NEEDS CLARIFICATION]` de CD-6 del work-item.
- **DT-8** *(nueva)*: Los tests de AC-1/AC-2/AC-2b validan la ruta "sin header de auth" inyectando requests SIN mockear el stack de identity/budget. El middleware delega a `requirePayment` → responde HTTP 402 con `x402Version: 2`. Aceptamos 401/402/403 como equivalente de "rechazó antes del business logic" porque el AC EARS permite "HTTP 401 or 403" y además el behavior real es 402 (Payment Required) que es estrictamente más restrictivo — el Dev debe aceptar 401, 402 o 403 en el expect. Justificación: el middleware es el **mismo** ya verificado en compose/orchestrate; probar su unidad es out of scope de esta HU, lo que probamos aquí es el **wiring** (que efectivamente se ejecuta antes del handler).

---

## 6. Constraint Directives

Heredadas del work-item (vigentes):

- **CD-1**: PROHIBIDO modificar la firma de `requirePaymentOrA2AKey` ni su comportamiento interno. Se usa como import read-only.
- **CD-2**: OBLIGATORIO mantener `GET /registries` y `GET /registries/:id` sin autenticación — son endpoints de lectura pública.
- **CD-3**: PROHIBIDO hardcodear origins CORS. OBLIGATORIO leerlos desde `CORS_ALLOWED_ORIGINS` env var.
- **CD-4**: OBLIGATORIO que los tests existentes pasen sin modificación. Si algún test asume que POST/PATCH/DELETE de `/registries` son sin auth, el Dev DEBE actualizar esos tests (mockeando `identityService.lookupByHash` o usando header válido).
- **CD-5**: PROHIBIDO usar `any` explícito en TypeScript en el código nuevo.
- **CD-6**: PROHIBIDO hacer HSTS condicional por transport. Emisión incondicional (DT-7 lo resuelve).

Nuevas agregadas por F2:

- **CD-7** *(nueva)*: PROHIBIDO mover la configuración CORS a un archivo separado en esta HU. Debe permanecer inline en `src/index.ts` para preservar scope mínimo (DT-5). Si a futuro se quiere factorizar, es otra HU.
- **CD-8** *(nueva)*: PROHIBIDO usar `OriginFunction` (callback) de `@fastify/cors`. El tipo esperado para la env `string[]` es suficiente y más auditable. Callbacks complican tests y debugging.
- **CD-9** *(nueva)*: OBLIGATORIO que el warn log de AC-6 use `fastify.log.warn(...)` (no `console.warn`) para coherencia con el logger estructurado del servicio.
- **CD-10** *(nueva)*: OBLIGATORIO que el header HSTS se escriba en minúsculas (`strict-transport-security`) para coherencia con los headers existentes en `security-headers.ts:11-12` (`x-content-type-options`, `x-frame-options`). Los tests deben leerlo en minúsculas — Fastify normaliza a lowercase en `response.headers`.
- **CD-11** *(nueva)*: OBLIGATORIO que el `description` pasado a `requirePaymentOrA2AKey` en `/registries` sea único y descriptivo por método (p. ej. `'WasiAI Registry Management — Register marketplace'` para POST, `'WasiAI Registry Management — Update marketplace'` para PATCH, `'WasiAI Registry Management — Delete marketplace'` para DELETE) para que la respuesta 402 identifique correctamente el servicio.

---

## 7. Waves de implementación

### 7.1 Decisión: 1 wave

Los tres fixes tocan archivos distintos y son independientes (ver análisis de paralelismo en work-item §Análisis). Dado que:
- SDD_MODE es `mini` (overhead de 3 waves no se justifica).
- Estimación es S.
- Los 3 fixes son mutuamente independientes (no hay orden requerido).
- La superficie total es ~10 líneas de código productivo + 3 archivos de tests.

Se implementa en **1 sola wave**. El Dev puede avanzar fix por fix en el orden que quiera dentro de la wave.

### 7.2 Wave 1 — Hardening completo

**Archivos**:
1. `src/middleware/security-headers.ts` — agregar HSTS.
2. `src/middleware/security-headers.test.ts` — test AC-3.
3. `src/routes/registries.ts` — agregar `preHandler` a POST/PATCH/DELETE.
4. `src/routes/registries.test.ts` — crear, tests AC-1/AC-2/AC-2b.
5. `src/index.ts` — reemplazar CORS wildcard por lógica env-aware (§4.2).
6. `src/__tests__/cors.test.ts` — crear, tests AC-4/AC-5/AC-6.
7. `.env.example` — documentar `CORS_ALLOWED_ORIGINS`.

**Gates internos (el Dev debe validar antes de cerrar W1)**:
- `npm run lint` pasa sin warnings nuevos (CD-5: no `any`).
- `npm test` pasa el suite completo (CD-4: 276+ tests existentes + los nuevos).
- `npm run build` (tsc) compila sin errores.
- Verificación manual: servidor en dev levanta y responde `*` en CORS; servidor en prod con `CORS_ALLOWED_ORIGINS` setteado responde solo para origins listados.

---

## 8. Plan de tests

### 8.1 Mapa AC → test

| AC | Archivo de test | Nombre del test | Enfoque |
|----|-----------------|-----------------|---------|
| AC-1 | `src/routes/registries.test.ts` | `AC-1: POST /registries without auth header returns 401/402/403` | `inject({ method: 'POST', url: '/', payload: {...} })` SIN `x-a2a-key` ni `Authorization`. Expect `[401, 402, 403].includes(response.statusCode)` y `registryService.register` NO haber sido llamado. |
| AC-2 | `src/routes/registries.test.ts` | `AC-2: DELETE /registries/:id without auth header returns 401/402/403` | Idéntico patrón a AC-1 con `method: 'DELETE'`, `url: '/abc-123'`. Verificar `registryService.delete` no se llamó. |
| AC-2b | `src/routes/registries.test.ts` | `AC-2b: PATCH /registries/:id without auth header returns 401/402/403` | Idéntico patrón con `method: 'PATCH'`, `url: '/abc-123'`, `payload: { name: 'new' }`. Verificar `registryService.update` no se llamó. |
| AC-3 | `src/middleware/security-headers.test.ts` | `AC-3: response includes Strict-Transport-Security header` | Inject cualquier GET, expect `response.headers['strict-transport-security']` === `'max-age=31536000; includeSubDomains; preload'`. |
| AC-4 | `src/__tests__/cors.test.ts` | `AC-4: in production with CORS_ALLOWED_ORIGINS set, disallowed origin is rejected` | Setear `NODE_ENV='production'` y `CORS_ALLOWED_ORIGINS='https://app.wasiai.io'`, construir Fastify con la misma lógica de §4.2, inyectar OPTIONS preflight con `origin: 'https://evil.com'`, expect `response.headers['access-control-allow-origin']` undefined o != `'*'`. Luego inyectar con `origin: 'https://app.wasiai.io'`, expect `response.headers['access-control-allow-origin']` === `'https://app.wasiai.io'`. |
| AC-5 | `src/__tests__/cors.test.ts` | `AC-5: in development, all origins are allowed (wildcard)` | Setear `NODE_ENV='development'`, expect `response.headers['access-control-allow-origin']` === `'*'` para cualquier origin. |
| AC-6 | `src/__tests__/cors.test.ts` | `AC-6: in production without CORS_ALLOWED_ORIGINS, all cross-origin is blocked and warn is logged` | Setear `NODE_ENV='production'` y deletear `CORS_ALLOWED_ORIGINS`. Spy en `fastify.log.warn`. Inyectar preflight; expect no `Access-Control-Allow-Origin`; expect `warn` llamado con mensaje que contenga `'CORS_ALLOWED_ORIGINS'`. |
| AC-7 | suite completa | `npm test` | Se cumple implícitamente: si los 276+ tests existentes + los 7 nuevos pasan, AC-7 pasa. |

### 8.2 Cobertura adicional (no AC, pero recomendada)

- **Regresión GET `/registries`**: si no existe ya, agregar test que confirme que `GET /` y `GET /:id` siguen respondiendo 200 SIN header de auth (CD-2). Si ya existe en `tasks.test.ts`/`agent-card.test.ts` algo análogo, no duplicar.
- **Happy path con `x-a2a-key` válido** en `registries.test.ts`: 1 test que mockee `identityService.lookupByHash` con keyRow válido y verifique que POST/PATCH/DELETE proceden (201/200/200). Opcional pero útil para confirmar que el wiring no está roto.

### 8.3 Mocks requeridos

En `src/routes/registries.test.ts`:

```
vi.mock('../services/registry.js', () => ({
  registryService: {
    list: vi.fn(),
    get: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
```

Para el camino "sin auth", NO se necesitan mocks de `identityService` o `budgetService` — el middleware va por el branch `rawKey === undefined` y delega a `runX402Fallback(x402Handlers, ...)`, que responde 402 sin tocar Supabase.

Para el camino happy path (opcional, §8.2):

```
vi.mock('../services/identity.js', () => ({ identityService: { lookupByHash: vi.fn() } }));
vi.mock('../services/budget.js', () => ({ budgetService: { debit: vi.fn(), getBalance: vi.fn() } }));
vi.mock('../adapters/registry.js', () => ({ ... /* patrón de a2a-key.test.ts:39-68 */ }));
```

En `src/__tests__/cors.test.ts`:
- No necesita mocks de servicios. Solo manipula `process.env.NODE_ENV` y `process.env.CORS_ALLOWED_ORIGINS`.
- Restaurar envs en `afterEach` para no contaminar otros tests.

### 8.4 Tests a NO romper (CD-4)

Hay 276+ tests existentes. Riesgos identificados:

- **`src/routes/auth.test.ts`** — no toca `/registries`, sin riesgo.
- **`src/routes/agent-card.test.ts`** — no toca `/registries`, sin riesgo.
- **`src/routes/tasks.test.ts`** — no toca `/registries`, sin riesgo.
- **`src/__tests__/e2e/e2e.test.ts`** — POSIBLE RIESGO: si hace `POST /registries` sin credenciales para poblar data de test, ahora fallará. El Dev debe inspeccionar este archivo y, si hay calls sin auth, agregar `x-a2a-key` mockeado o skip del test con razón documentada.
- **`src/middleware/security-headers.test.ts`** — los 3 tests existentes deben seguir pasando porque solo agregamos un `reply.header` más, no tocamos los dos existentes.

El Dev DEBE correr `npm test` después de cada fix para localizar regresiones tempranamente.

---

## 9. Missing Inputs / Resolved

Todos los `[NEEDS CLARIFICATION]` del work-item fueron resueltos en F2:

| Origen | Item | Resolución |
|--------|------|------------|
| Work-item §Scope OUT | `PATCH /registries/:id` — ¿requiere auth? | **Sí, se protege**. Agregado como AC-2b y DT-6. |
| Work-item CD-6 | ¿HSTS condicional por `X-Forwarded-Proto` o siempre? | **Siempre**. DT-7 con 3 razones documentadas. |
| Work-item | `PaymentMiddlewareOptions` exacto para registries | Se pasa `{ description: 'WasiAI Registry Management — <acción>' }` por método (CD-11). No hay amount custom; el middleware cae en el default (1 ETH nativo) si llegara al flow x402, pero en la práctica la protección es vía `x-a2a-key` con budget propio. |

Sin `[NEEDS CLARIFICATION]` pendientes.

---

## 10. Exemplars verificados

| Exemplar | Path | Verificado con |
|----------|------|----------------|
| Patrón de uso del middleware `requirePaymentOrA2AKey` | `src/routes/compose.ts:18-32` | Read |
| Segundo exemplar del mismo middleware | `src/routes/orchestrate.ts:24-54` | Read |
| Firma y comportamiento del middleware | `src/middleware/a2a-key.ts:83-217` | Read |
| Shape de `PaymentMiddlewareOptions` | `src/middleware/x402.ts:25-28` | Read |
| Hook `onSend` para modificar headers | `src/middleware/security-headers.ts:9-14` | Read |
| Patrón de test del middleware con `inject` | `src/middleware/security-headers.test.ts:12-49` | Read |
| Patrón de tests con mocks de servicios | `src/routes/auth.test.ts:20-68` | Read |
| Línea exacta del CORS wildcard a refactorizar | `src/index.ts:36` | Read |
| Existencia de `@fastify/cors` v11 | `package.json:17` | Grep |
| Existencia de `src/__tests__/` folder | `src/__tests__/e2e/` | Bash ls |
| Formato de SDD del proyecto | `doc/sdd/037-x402-v2/sdd.md` | Read |

Todos los paths fueron verificados con herramientas (Read/Glob/Grep). Cero alucinaciones.

---

## 11. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|------------|
| Tests E2E asumen POST /registries sin auth y rompen | Media | Alto (bloquea AC-7) | Dev debe inspeccionar `src/__tests__/e2e/e2e.test.ts` antes de cerrar W1 y actualizar calls con mock de `identityService.lookupByHash` o agregar `x-a2a-key` válido. |
| `@fastify/cors` v11 con `origin: false` no bloquea como esperamos | Baja | Medio | Test AC-6 valida empíricamente que `access-control-allow-origin` no aparece. Si falla, fallback a `origin: []` (array vacío) que también rechaza todo en v11. |
| HSTS provoca lock-out si el dominio pierde su certificado TLS | Baja | Alto (1 año de HSTS es mucho) | Aceptamos el riesgo: el valor es estándar de producción y Railway maneja TLS automáticamente. Alternativa (no implementada en esta HU): emitir solo `max-age=600` en primera release de cambio — descartada porque el humano pidió el valor completo y DT-2 lo ratifica. |
| Marketplaces existentes que hoy usan POST /registries sin credenciales dejan de funcionar | Alta (por diseño) | Medio | Es la intención de la HU. Documentar en release notes: "Breaking change: /registries write endpoints require `x-a2a-key` header from 2026-04-20 onward." |
| `fastify.log.warn` no disponible en el momento del `register(cors)` | Baja | Bajo | Verificado: `Fastify({ logger: true })` en `src/index.ts:33` expone `.log` inmediatamente. Si fallara, usar `console.warn` es aceptable fallback (no viola CD-9 si se documenta). |

---

## 12. Readiness Check (interno F2)

Checklist de verificación antes de solicitar SPEC_APPROVED:

- [x] Todos los ACs están numerados y en formato EARS.
- [x] Hay ≥1 test plan entry por cada AC (AC-1, AC-2, AC-2b, AC-3, AC-4, AC-5, AC-6, AC-7).
- [x] Todos los exemplars están verificados con Read/Grep (§10).
- [x] Todos los paths referenciados existen en el repo (verificados).
- [x] Las DTs resuelven los `[NEEDS CLARIFICATION]` del work-item.
- [x] Las CDs del work-item están heredadas + nuevas CDs de F2 agregadas.
- [x] El stack propuesto (Fastify, @fastify/cors, vitest) coincide con project-context.md.
- [x] No hay código productivo escrito en esta fase (solo especificación).
- [x] Waves definidas y justificadas (1 wave, §7).
- [x] Scope IN y OUT explícitos.
- [x] Riesgos identificados con mitigación (§11).
- [x] No hay `any` propuesto en el diseño (CD-5).
- [x] No hay hardcodes de origins (CD-3 respetado en §4.2).
- [x] Auto-Blindaje histórico inspeccionado (no existen archivos previos — paso salteado).
- [x] Test strategy cubre happy path opcional + regresión (§8.2, §8.4).

**Veredicto F2**: SDD listo para SPEC_APPROVED. Sin bloqueantes.

---

*Generado por nexus-architect | 2026-04-20 | WKH-SEC-01 | F2*
