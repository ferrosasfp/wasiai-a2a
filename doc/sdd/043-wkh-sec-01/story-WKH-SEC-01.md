# Story File — WKH-SEC-01: Security Hardening (HSTS + CORS restrictivo + requireAuth en /registries)

> **HU**: WKH-SEC-01
> **SDD**: `doc/sdd/043-wkh-sec-01/sdd.md` (SPEC_APPROVED)
> **Work item**: `doc/sdd/043-wkh-sec-01/work-item.md`
> **Branch**: `feat/043-wkh-sec-01-hardening` (crear desde `main`)
> **Sizing**: S — SDD_MODE `mini`
> **Pipeline**: QUALITY (1 wave, sin sub-waves paralelas)
> **Fecha**: 2026-04-20
> **Agente**: nexus-dev (F3) — este Story File es tu ÚNICA fuente de verdad

---

## 0. Cómo leer este documento

- Los **snippets** son de REFERENCIA (shape / forma esperada). No son copy-paste literal: tu trabajo es escribir el código final respetando el shape y las firmas reales del codebase.
- **Antes de editar cualquier archivo listado, abrilo con `Read`** para confirmar su contenido actual. La sección §6 te dice exactamente qué verificar.
- Si algo de este Story File contradice el código real del repo → PARÁ. Reportá el drift al orquestador. NO improvises.

---

## 1. Objetivo

Cerrar tres vulnerabilidades detectadas en la auditoría del 2026-04-20:

1. Proteger los endpoints de **escritura** de `/registries` (POST, PATCH, DELETE) con el middleware `requirePaymentOrA2AKey` ya existente.
2. Reemplazar el CORS wildcard `{ origin: '*' }` por una configuración **env-aware** que en producción solo permita los origins declarados en `CORS_ALLOWED_ORIGINS` (fail-secure si no está set).
3. Agregar el header `Strict-Transport-Security` al hook `onSend` ya existente en `security-headers.ts`.

Superficie total esperada: ~10 líneas de código productivo + 3 archivos de tests (2 nuevos, 1 ampliado).

---

## 2. Pre-requisitos de ambiente

| Requisito | Comando de verificación | Esperado |
|-----------|-------------------------|----------|
| Node 20+ | `node --version` | `v20.x` o superior |
| Dependencias instaladas | `npm install` | sin errores |
| Branch limpio | `git status` | working tree clean en `main` |
| Tests base pasan | `npm test` antes de tocar nada | 276+ tests PASS (baseline) |
| TypeScript compila | `npm run build` | OK |

> ⚠️ Si el baseline de tests NO pasa en `main`, PARÁ y reportá al orquestador: no arranques wave con red baseline.

---

## 3. Scope IN / OUT

### Scope IN (archivos a tocar)

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `src/middleware/security-headers.ts` | Modificar — agregar 1 `reply.header(...)` en el hook `onSend` existente |
| 2 | `src/middleware/security-headers.test.ts` | Modificar — agregar 1 test AC-3 |
| 3 | `src/routes/registries.ts` | Modificar — agregar `{ preHandler: [...] }` a POST/PATCH/DELETE + 1 import |
| 4 | `src/routes/registries.test.ts` | Crear — 3 tests AC-1/AC-2/AC-2b |
| 5 | `src/index.ts` (línea 36) | Modificar — reemplazar `{ origin: '*' }` por lógica env-aware |
| 6 | `src/__tests__/cors.test.ts` | Crear — 3 tests AC-4/AC-5/AC-6 |
| 7 | `.env.example` | Modificar — documentar `CORS_ALLOWED_ORIGINS` |

### Scope OUT (PROHIBIDO tocar)

- `src/middleware/a2a-key.ts` — firma del middleware se usa tal cual (CD-1).
- `src/middleware/x402.ts` — se importa vía `requirePaymentOrA2AKey`, no tocar.
- `src/routes/compose.ts`, `src/routes/orchestrate.ts` — ya tienen auth, no tocar.
- `src/mcp/` — fuera de scope.
- `GET /registries` y `GET /registries/:id` — deben quedar **públicos** (CD-2).
- Refactor de middlewares existentes.
- Archivo separado para config CORS (CD-7) — todo inline en `src/index.ts`.
- Configuración de TLS / reverse proxy.

---

## 4. Wave 1 — pasos atómicos ordenados

Ejecutá los pasos **en este orden**. Cada paso es atómico: después de cada uno podés correr `npm run build` o `npm test` si querés confirmar que no rompiste nada.

### Paso 1.1 — Crear branch

```bash
git checkout main
git pull --ff-only origin main
git checkout -b feat/043-wkh-sec-01-hardening
```

Verificación: `git branch --show-current` debe imprimir `feat/043-wkh-sec-01-hardening`.

---

### Paso 1.2 — HSTS header (AC-3)

**Archivo productivo**: `src/middleware/security-headers.ts`

1. `Read` el archivo actual (tiene ~14 líneas).
2. Declarar la constante **por encima** de la función `registerSecurityHeaders`:

   ```ts
   // Shape de referencia — el valor literal es obligatorio por AC-3
   const HSTS_VALUE = 'max-age=31536000; includeSubDomains; preload';
   ```

3. Dentro del hook `onSend` existente (ya tiene 2 `reply.header(...)`), agregar una tercera línea:

   ```ts
   // Shape de referencia — nombre del header EN MINÚSCULAS (CD-10)
   reply.header('strict-transport-security', HSTS_VALUE);
   ```

**Archivo de test**: `src/middleware/security-headers.test.ts`

4. `Read` el archivo actual. Ya tiene 3 tests (AC-1/AC-2 y un combinado "AC-3" que valida ambos headers existentes — ese test es legacy de otra HU y NO coincide con AC-3 de WKH-SEC-01).
5. **Importante**: el `it('AC-3: ...')` existente en ese archivo valida los dos headers antiguos; DEJALO tal cual. Agregá un NUEVO test con un nombre inequívoco para la HU actual:

   ```ts
   // Shape de referencia
   it('WKH-SEC-01 AC-3: response includes Strict-Transport-Security header', async () => {
     const response = await app.inject({ method: 'GET', url: '/health' });
     expect(response.headers['strict-transport-security']).toBe(
       'max-age=31536000; includeSubDomains; preload',
     );
   });
   ```

6. Correr `npm test -- security-headers` y confirmar que los 3 tests previos + el nuevo pasan (total 4).

---

### Paso 1.3 — Auth en `/registries` (AC-1, AC-2, AC-2b)

**Archivo productivo**: `src/routes/registries.ts`

1. `Read` el archivo. Confirmá que:
   - `POST /` está en líneas ~47-96 y NO tiene opciones con `preHandler`.
   - `PATCH /:id` está en líneas ~102-123 y NO tiene `preHandler`.
   - `DELETE /:id` está en líneas ~129-150 y NO tiene `preHandler`.
   - `GET /` y `GET /:id` NO se tocan (CD-2).
2. Agregar el import al tope del archivo (respetando el orden alfabético existente):

   ```ts
   // Import exacto — sufijo .js obligatorio por ESM compilado
   import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
   ```

3. Agregar el objeto de opciones con `preHandler` como **segundo argumento** de `fastify.post`, `fastify.patch` y `fastify.delete`. Patrón de referencia ya presente en `src/routes/compose.ts:19-32`:

   ```ts
   // Shape de referencia — spread del array que devuelve el factory
   fastify.post(
     '/',
     {
       preHandler: [
         ...requirePaymentOrA2AKey({
           description: 'WasiAI Registry Management — Register marketplace',
         }),
       ],
     },
     async (request, reply) => { /* handler existente, sin cambios */ },
   );
   ```

4. Para PATCH y DELETE, reproducí el mismo patrón con `description` **únicos** (CD-11):

   | Handler | `description` obligatorio |
   |---------|----------------------------|
   | POST `/` | `'WasiAI Registry Management — Register marketplace'` |
   | PATCH `/:id` | `'WasiAI Registry Management — Update marketplace'` |
   | DELETE `/:id` | `'WasiAI Registry Management — Delete marketplace'` |

5. **NO modifiques el body de los handlers**. Solo agregás el objeto `{ preHandler: [...] }` como segundo argumento antes del handler.

**Archivo de test**: crear `src/routes/registries.test.ts`

6. Patrón de mocks tomado de `src/routes/auth.test.ts:22-36`. Shape de referencia:

   ```ts
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

7. Cada test:
   - `beforeAll`: construir `Fastify()`, registrar `registriesRoutes` con `{ prefix: '/registries' }` o sin prefix si inyectás con url `/`.
   - inyectar request SIN header `x-a2a-key` ni `Authorization`.
   - Expect: `[401, 402, 403].includes(response.statusCode) === true` (DT-8: el middleware delega a x402 → 402 en el path "sin credencial"; aceptamos 401/402/403 como "rechazó antes del handler").
   - Expect: el mock `registryService.register` / `.update` / `.delete` NO fue llamado.

8. Tests a crear (nombres exactos, los usa F4 para citar evidencia):

   | Test | Método | URL | Payload | Mock a verificar no-llamado |
   |------|--------|-----|---------|------------------------------|
   | `AC-1: POST /registries without auth header returns 401/402/403` | POST | `/` | `{ name: 'x', discoveryEndpoint: 'https://a', invokeEndpoint: 'https://b', schema: {} }` | `registryService.register` |
   | `AC-2: DELETE /registries/:id without auth header returns 401/402/403` | DELETE | `/abc-123` | (ninguno) | `registryService.delete` |
   | `AC-2b: PATCH /registries/:id without auth header returns 401/402/403` | PATCH | `/abc-123` | `{ name: 'new' }` | `registryService.update` |

9. Correr `npm test -- registries` y confirmar 3/3 PASS.

---

### Paso 1.4 — CORS env-aware (AC-4, AC-5, AC-6)

**Archivo productivo**: `src/index.ts` (línea 36)

1. `Read` líneas 1-60 y confirmar que:
   - Import `cors from '@fastify/cors'` está en línea 8.
   - La línea a reemplazar es la **36**: `await fastify.register(cors, { origin: '*' });`.
   - Hay un `Fastify({ logger: true, ... })` en línea 33 (⇒ `fastify.log` está disponible).
2. Reemplazar la línea 36 por el bloque env-aware. Algoritmo (pseudocódigo del SDD §4.2):

   ```
   isProduction = process.env.NODE_ENV === 'production'
   originsEnv   = process.env.CORS_ALLOWED_ORIGINS  // CSV | undefined

   if NOT isProduction:
       corsOptions = { origin: '*' }                               // AC-5
   else if originsEnv is non-empty (tras split/trim/filter):
       corsOptions = { origin: <array de origins parseado> }       // AC-4
   else:
       fastify.log.warn('CORS_ALLOWED_ORIGINS not set in production — blocking all cross-origin requests')
       corsOptions = { origin: false }                             // AC-6

   await fastify.register(cors, corsOptions)
   ```

3. **Tipado obligatorio** (CD-5: sin `any`): el tipo de `corsOptions` es `Parameters<typeof cors>[1]` o importar el tipo desde `@fastify/cors` (e.g. `FastifyCorsOptions`). Si TS no infiere bien, declarar explícitamente.
4. **PROHIBIDO** usar `OriginFunction` / callback (CD-8). Solo literales: `'*' | string[] | false`.
5. El warn log debe salir por `fastify.log.warn(...)` (CD-9), NO por `console.warn`.

**Archivo de test**: crear `src/__tests__/cors.test.ts`

6. Estructura del archivo:
   - `beforeEach`: guardar `process.env.NODE_ENV` y `process.env.CORS_ALLOWED_ORIGINS` originales.
   - `afterEach`: restaurar envs originales (no contaminar otros tests).
   - Por cada test: setear envs → construir un `Fastify()` nuevo → aplicar la **misma lógica de cálculo de `corsOptions`** que en `src/index.ts` → `app.register(cors, corsOptions)` → registrar un dummy `GET /health` → `inject`.

   > 💡 Si ves que la lógica se duplica entre producción y tests, esto es esperado en esta HU (CD-7 prohíbe factorizar). Si sentís la urgencia de extraer la función — NO lo hagas; es otra HU.

7. Tests a crear (nombres exactos):

   | Test | NODE_ENV | CORS_ALLOWED_ORIGINS | Origin del request | Expect |
   |------|----------|-----------------------|---------------------|--------|
   | `AC-4: in production with CORS_ALLOWED_ORIGINS set, disallowed origin is rejected` | `'production'` | `'https://app.wasiai.io'` | `'https://evil.com'` | `response.headers['access-control-allow-origin']` undefined (o distinto de `'*'` y distinto del evil origin) |
   | `AC-4 (bis): allowed origin passes` (en el mismo `it` si querés) | `'production'` | `'https://app.wasiai.io'` | `'https://app.wasiai.io'` | `response.headers['access-control-allow-origin']` === `'https://app.wasiai.io'` |
   | `AC-5: in development, all origins are allowed (wildcard)` | `'development'` | (delete / unset) | `'https://anything.com'` | `response.headers['access-control-allow-origin']` === `'*'` |
   | `AC-6: in production without CORS_ALLOWED_ORIGINS, all cross-origin is blocked and warn is logged` | `'production'` | (delete / unset) | `'https://evil.com'` | no header `access-control-allow-origin` + `fastify.log.warn` fue llamado con mensaje que incluya `'CORS_ALLOWED_ORIGINS'` |

8. Spy en `fastify.log.warn` (AC-6): usar `vi.spyOn(app.log, 'warn')` **antes** de `register(cors, ...)`. Alternativa: inyectar un logger custom al construir `Fastify({ logger: ... })`.

9. Correr `npm test -- cors` y confirmar los 3 tests PASS.

---

### Paso 1.5 — Documentar `CORS_ALLOWED_ORIGINS`

**Archivo**: `.env.example`

1. `Read` el archivo (~149 líneas). Notar el estilo de secciones: `# ─────────...` + título.
2. Agregar una sección nueva "CORS" (ubicación sugerida: después de la sección `Server` para mantener agrupado lo relativo al gateway HTTP). Shape de referencia:

   ```
   # ─────────────────────────────────────────────────────────────
   # CORS — Cross-Origin Resource Sharing
   # En development (NODE_ENV=development o ausente) se permite * (todos los origins).
   # En production esta var es OBLIGATORIA: CSV de origins permitidos.
   # Si queda vacía en production, TODOS los cross-origin requests son bloqueados
   # (fail-secure) y el servidor loguea un warning al startup.
   # Ejemplo: CORS_ALLOWED_ORIGINS=https://app.wasiai.io,https://wasiai.io
   # ─────────────────────────────────────────────────────────────
   CORS_ALLOWED_ORIGINS=
   ```

3. NO tocar otras secciones del `.env.example`.

---

### Paso 1.6 — Validaciones locales

Correr **en este orden** (cualquier fallo ⇒ parar y corregir antes de continuar):

```bash
npm run lint         # sin warnings NUEVOS (CD-5: cero 'any' introducidos)
npm run build        # tsc compila OK, sin errores de tipo
npm test             # 276+ existentes + 7 nuevos → todos PASS (CD-4, AC-7)
```

Checklist de regresión manual (verificar con `grep`/`Read`):

- [ ] `src/__tests__/e2e/e2e.test.ts` — si hace `POST /registries` o `DELETE /registries/:id` sin header `x-a2a-key`, actualizarlo para que incluya credencial válida (mock de `identityService.lookupByHash`) o skipearlo con razón documentada en comentario (§SDD 11 riesgo #1).
- [ ] Cualquier otro test que llame a `registryService.register/update/delete` → debería seguir pasando porque los tests unitarios de servicio no pasan por la ruta HTTP.

---

### Paso 1.7 — Commit

```bash
git add \
  src/middleware/security-headers.ts \
  src/middleware/security-headers.test.ts \
  src/routes/registries.ts \
  src/routes/registries.test.ts \
  src/index.ts \
  src/__tests__/cors.test.ts \
  .env.example
git status   # confirmar que SOLO estos 7 archivos están staged
git commit -m "$(cat <<'EOF'
feat(WKH-SEC-01): security hardening — HSTS + CORS restrictivo + requireAuth en /registries

- HSTS: add Strict-Transport-Security header (max-age=1y, includeSubDomains, preload)
- CORS: env-aware config — prod restringido via CORS_ALLOWED_ORIGINS, fail-secure si no está set
- /registries POST/PATCH/DELETE: protected with requirePaymentOrA2AKey middleware
- Tests: +7 (AC-1 a AC-6 + regression)

Closes WKH-SEC-01
EOF
)"
```

> 🚫 NO hacer `git push` en F3. Eso es responsabilidad del orquestador tras el cierre del pipeline (F4 → DONE).

---

## 5. Snippets de referencia (shape, no literal)

### Import del middleware (Paso 1.3)

```ts
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
```

### Shape del preHandler (Paso 1.3 — los 3 descriptions únicos por CD-11)

```ts
// POST /
{ preHandler: [...requirePaymentOrA2AKey({ description: 'WasiAI Registry Management — Register marketplace' })] }

// PATCH /:id
{ preHandler: [...requirePaymentOrA2AKey({ description: 'WasiAI Registry Management — Update marketplace' })] }

// DELETE /:id
{ preHandler: [...requirePaymentOrA2AKey({ description: 'WasiAI Registry Management — Delete marketplace' })] }
```

### Constante HSTS (Paso 1.2)

```ts
const HSTS_VALUE = 'max-age=31536000; includeSubDomains; preload';
```

### Header en minúsculas (Paso 1.2 — CD-10)

```ts
reply.header('strict-transport-security', HSTS_VALUE);
```

### Algoritmo CORS (Paso 1.4 — pseudocódigo del SDD §4.2)

```
const isProduction = process.env.NODE_ENV === 'production';
const originsEnv   = process.env.CORS_ALLOWED_ORIGINS;

let corsOptions;
if (!isProduction) {
  corsOptions = { origin: '*' };                                   // AC-5
} else {
  const origins = (originsEnv ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (origins.length > 0) {
    corsOptions = { origin: origins };                             // AC-4
  } else {
    fastify.log.warn(
      'CORS_ALLOWED_ORIGINS not set in production — blocking all cross-origin requests'
    );
    corsOptions = { origin: false };                               // AC-6
  }
}

await fastify.register(cors, corsOptions);
```

---

## 6. Tests a agregar — resumen por archivo

| Archivo | Tests nuevos | Nombre exacto |
|---------|--------------|---------------|
| `src/middleware/security-headers.test.ts` | 1 | `WKH-SEC-01 AC-3: response includes Strict-Transport-Security header` |
| `src/routes/registries.test.ts` | 3 | `AC-1: POST /registries without auth header returns 401/402/403` · `AC-2: DELETE /registries/:id without auth header returns 401/402/403` · `AC-2b: PATCH /registries/:id without auth header returns 401/402/403` |
| `src/__tests__/cors.test.ts` | 3 | `AC-4: in production with CORS_ALLOWED_ORIGINS set, disallowed origin is rejected` · `AC-5: in development, all origins are allowed (wildcard)` · `AC-6: in production without CORS_ALLOWED_ORIGINS, all cross-origin is blocked and warn is logged` |

**Total: 7 tests nuevos**. AC-7 se cumple implícitamente si `npm test` pasa completo.

---

## 7. Anti-alucinación checklist

Antes de escribir una línea, ejecutá esta verificación:

- [ ] `Read` `src/routes/registries.ts` → confirmar que POST/PATCH/DELETE **no** tienen `{ preHandler: ... }` hoy.
- [ ] `Read` `src/routes/compose.ts` líneas 18-32 → usar ese shape **exacto** para el objeto de opciones con `preHandler`.
- [ ] `Read` `src/middleware/a2a-key.ts` alrededor de la export `requirePaymentOrA2AKey` → confirmar que la firma es `(opts: PaymentMiddlewareOptions) => preHandlerAsyncHookHandler[]` y que devuelve un **array** (por eso se spread con `...`).
- [ ] `Read` `src/middleware/x402.ts` líneas ~25 → confirmar que `PaymentMiddlewareOptions` tiene `description: string` (y opcional `amount`). NO pasés campos que no existan.
- [ ] `Read` `src/middleware/security-headers.ts` → confirmar que hay un único hook `onSend` y que los dos headers existentes se emiten en minúsculas.
- [ ] `Read` `src/middleware/security-headers.test.ts` → confirmar los 3 tests existentes para no pisarlos; el nombre del nuevo test debe empezar con `WKH-SEC-01 AC-3:` para que no colisione con el `AC-3:` legacy.
- [ ] `Read` `src/index.ts` líneas 1-60 → confirmar que la línea 36 es exactamente `await fastify.register(cors, { origin: '*' });` y que `fastify.log` existe (Fastify fue construido con `logger: true` en línea 33).
- [ ] `Read` `.env.example` → confirmar el estilo de comentarios y secciones.
- [ ] `Read` `src/routes/auth.test.ts` líneas 20-36 → copiar el **shape** de `vi.mock` (no el contenido) para `registryService`.
- [ ] `ls src/__tests__/` → confirmar que el directorio existe (hoy solo contiene `e2e/`). El archivo `cors.test.ts` va a nivel raíz de `__tests__/`.

PROHIBIDO:
- Inventar métodos de `@fastify/cors` que no estén en su API pública v11.
- Inventar APIs de `fastify.log` — usar solo `warn(msg)` / `info(msg)` / `error(msg)`.
- Pasar a `requirePaymentOrA2AKey` un campo que no exista en `PaymentMiddlewareOptions`.
- Cambiar la firma del handler existente (solo se agrega el **segundo argumento** antes del handler).
- Mover la lógica CORS a un archivo nuevo (CD-7).

---

## 8. Constraint Directives activas (checklist)

Todas heredadas del SDD §6:

- [ ] **CD-1**: No modificar firma ni comportamiento interno de `requirePaymentOrA2AKey`.
- [ ] **CD-2**: `GET /registries` y `GET /registries/:id` siguen públicos (sin `preHandler` de auth).
- [ ] **CD-3**: Origins CORS SOLO vienen de `CORS_ALLOWED_ORIGINS` — cero hardcodes.
- [ ] **CD-4**: Los 276+ tests existentes pasan sin modificación (salvo e2e que requiera credenciales nuevas — ver Paso 1.6).
- [ ] **CD-5**: Cero `any` explícito en código nuevo. Tipar `corsOptions` con el tipo público de `@fastify/cors`.
- [ ] **CD-6**: HSTS emitido **incondicionalmente**. NO condicionar por `X-Forwarded-Proto` (DT-7 lo ratifica).
- [ ] **CD-7**: CORS config permanece **inline** en `src/index.ts`. Nada de archivos `config/cors.ts`.
- [ ] **CD-8**: PROHIBIDO `origin: (origin, cb) => ...` (callback). Solo literales `'*' | string[] | false`.
- [ ] **CD-9**: El warn de AC-6 usa `fastify.log.warn(...)`, NO `console.warn`.
- [ ] **CD-10**: Header HSTS en minúsculas: `'strict-transport-security'`.
- [ ] **CD-11**: Cada uso de `requirePaymentOrA2AKey` en `/registries` tiene un `description` distinto y descriptivo (ver tabla del Paso 1.3).

---

## 9. Criterios de hecho (Definition of Done — F3)

- [ ] Branch `feat/043-wkh-sec-01-hardening` creado desde `main` y check-outed.
- [ ] 276+ tests existentes pasan (`npm test` — verificar conteo).
- [ ] 7 tests nuevos pasan (1 AC-3 + 3 registries + 3 cors).
- [ ] `npm run lint` sin warnings NUEVOS respecto al baseline de `main`.
- [ ] `npm run build` (tsc strict) OK sin errores.
- [ ] Verificación manual de regresión en `src/__tests__/e2e/e2e.test.ts` completada (ajustar calls sin auth si existen).
- [ ] Commit convencional creado en la branch con el mensaje del Paso 1.7.
- [ ] Solo los 7 archivos del Scope IN están modificados en el commit (verificar con `git show --stat HEAD`).
- [ ] README / CHANGELOG NO actualizados (eso lo maneja `nexus-docs` en fase DONE).
- [ ] NO se hizo `git push`.

---

## 10. Mensaje de commit sugerido (ya listo para usar)

```
feat(WKH-SEC-01): security hardening — HSTS + CORS restrictivo + requireAuth en /registries

- HSTS: add Strict-Transport-Security header (max-age=1y, includeSubDomains, preload)
- CORS: env-aware config — prod restringido via CORS_ALLOWED_ORIGINS, fail-secure si no está set
- /registries POST/PATCH/DELETE: protected with requirePaymentOrA2AKey middleware
- Tests: +7 (AC-1 a AC-6 + regression)

Closes WKH-SEC-01
```

---

## 11. Handoff

Cuando termines F3:

1. Reportá al orquestador: rama, archivos tocados, conteo de tests (antes / después), resultado de `lint` y `build`, hash del commit.
2. NO avances a F4 ni a AR — lo hace el orquestador lanzando `nexus-adversary`.
3. Si encontraste drift entre el Story File y el código real (archivo no está, línea no coincide, API de librería distinta) — reportalo explícitamente al orquestador con el detalle exacto. NO improvises.

---

*Generado por nexus-architect | 2026-04-20 | WKH-SEC-01 | F2.5*
