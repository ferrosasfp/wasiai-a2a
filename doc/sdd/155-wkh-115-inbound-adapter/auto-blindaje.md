# Auto-Blindaje — WKH-115 (Inbound Adapter)

Errores cometidos durante F3 y sus fixes, para blindar futuras HUs.

### [2026-07-06 17:12] Wave 2 — Header docblock duplicado en inbound-task.ts
- **Error**: el archivo `src/services/inbound-task.ts` quedó con el bloque de
  comentario de cabecera repetido dos veces (líneas 1-22 y 24-45).
- **Causa raíz**: artefacto de escritura al generar el archivo; no lo detecté
  hasta que biome reportó warnings y releí el top del archivo.
- **Fix**: eliminé el segundo bloque duplicado en el mismo `Edit` que quitó el
  import no usado.
- **Aplicar en**: releer el top de cada archivo nuevo tras el primer gate de
  biome/tsc; no asumir que el `Write` quedó limpio solo porque tsc pasa (un
  comment duplicado no rompe tsc).

### [2026-07-06 17:13] Wave 2 — Import no usado + useOptionalChain (CD-11)
- **Error**: `import type { A2AAgentKeyRow }` quedó sin uso; y
  `if (!keyRow || !keyRow.is_active)` violaba `useOptionalChain`.
- **Causa raíz**: `keyRow` se infiere de `lookupByHash`, no necesitaba anotación
  explícita; y el guard clásico no usaba optional-chaining.
- **Fix**: quité el import; reemplacé por `if (!keyRow?.is_active)`.
- **Aplicar en**: correr `biome check --write` por archivo ANTES del gate; para
  narrowing de nullable usar siempre `x?.prop` (patrón recurrente WKH-114/144).

### [2026-07-06 17:22] Wave 3 — Param `any` implícito en test route de control
- **Error**: `app.post('/ctrl', async (req) => ...)` → `tsc` TS7006 (`req`
  implicit any), aunque los tests corrían verdes en vitest.
- **Causa raíz**: el handler ad-hoc de la ruta de control (no tipada por un
  generic de Fastify) no infiere `FastifyRequest`.
- **Fix**: anoté `req: FastifyRequest` e importé el tipo desde `fastify`.
- **Aplicar en**: el gate no es solo vitest verde — `tsc --noEmit` debe pasar
  también sobre los `.test.ts`. Correr ambos en cada wave.

### [2026-07-06 — FIX-PACK post-AR/CR] MNR-2 — replay/doble-cobro en money-path por firma
- **Error**: en un endpoint money-path autenticado por firma HMAC, la ventana
  anti-replay (300s) era el ÚNICO anti-replay. Un request firmado capturado y
  re-enviado dentro de la ventana → `orchestrate` corría de nuevo → re-debitaba
  la agent key de la fuente (doble-cobro).
- **Causa raíz**: la ventana de tolerancia HMAC no es una idempotency key. Firma
  válida + timestamp fresco = request "legítimo" aunque sea un replay.
- **Fix**: idempotency por `(owner_ref, source, external_ref)`. Pre-check
  app-layer (`getByExternalRef`, ownership-scoped) ANTES de `create`: si existe →
  replay de la tarea existente sin re-crear ni re-orquestar. Backstop: índice
  `UNIQUE` parcial `WHERE external_ref IS NOT NULL` — la race de dos requests
  concurrentes idénticos → uno gana el insert, el otro captura `23505`
  (`InboundDuplicateError`), re-lee y hace el mismo replay.
- **Aplicar en**: TODO endpoint que mueva dinero y autentique por firma/HMAC
  necesita una idempotency key explícita del caller (aquí `external_ref`), no
  solo la ventana de replay. Persistir un identificador único + índice UNIQUE +
  manejar la violación como "ya procesado", nunca como error al caller.

### [2026-07-06 — FIX-PACK] MNR-1 — timing side-channel de enumeración de fuentes
- **Error**: una fuente NO configurada retornaba en `loadSourceConfig` null ANTES
  de computar HMAC → tiempo de respuesta distinto de una fuente configurada con
  firma inválida. Un atacante podía enumerar qué fuentes existen por timing.
- **Fix**: en `verifySourceAuth`, cuando `loadSourceConfig` da null, computar un
  HMAC dummy (key constante, mismo shape de trabajo) y descartarlo antes de
  retornar null. Iguala el costo sin cambiar la decisión (sigue → 401).
- **Aplicar en**: cualquier gate de auth que resuelva "existe/no existe" antes de
  un cómputo costoso → equalizar el trabajo en ambas ramas (mismo patrón que la
  comparación en tiempo constante, extendido a la rama de "no encontrado").

### [2026-07-06 — FIX-PACK] NIT-ts — timestamp permisivo por `Number()`
- **Error**: `Number(timestamp)` aceptaba `1e10`, `0x10`, `12.3`, whitespace →
  `Number.isFinite` los dejaba pasar al chequeo de ventana (parsing side-channel).
- **Fix**: guard `^\d+$` (solo dígitos) ANTES de `Number(...)`; se mantiene
  `Number.isFinite` + ventana.
- **Aplicar en**: validación de inputs numéricos que vienen como string de red —
  no confiar en `Number()`/`parseInt` para rechazar formatos; validar la forma
  explícitamente primero.

### Deferrals conscientes (FIX-PACK — NO se tocaron, documentados como aceptables)
- **Hex mayúscula en la regex de firma**: `^[0-9a-f]{64}$` sólo acepta minúscula.
  El digest de Node es minúscula y el doc lo especifica ("hex minúscula") →
  aceptable, no se amplía la regex.
- **JSON malformado → 400 antes del auth**: el content-type parser de Fastify
  rechaza el body inválido antes de llegar al gate HMAC. Comportamiento estándar
  sin impacto de seguridad (no filtra config de la fuente) → aceptable.
- **Cast inline de `rawBody`** (`req as FastifyRequest & { rawBody?: Buffer }`):
  cosmético; no se refactoriza para no ampliar scope.

### Notas VERIFY-AT-IMPL (resueltos, no fueron errores)
- **Cap del budget**: `OrchestrateRequest` NO declara `maxQuotedCostUsdc`; pasar
  esa prop rompería el excess-property check de tsc strict. El cap efectivo se
  pasa como `budget: budgetUsdc`. Confirmado por tsc + test (assert
  `'maxQuotedCostUsdc' in req === false`).
- **Parser raw-body**: `addContentTypeParser('application/json', ...)` DENTRO del
  plugin `inbound.ts` (sin `fastify-plugin`) queda encapsulado. Verificado con un
  test: una ruta de control sibling parsea JSON normal y NO tiene `req.rawBody`
  seteado (`hasRawBody === false`). No hubo que recurrir al fallback `preParsing`.
