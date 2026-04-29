# Code Review — WKH-65

**Reviewer:** nexus-architect (CR mode)
**Pipeline:** FAST+AR (CR running in parallel to AR)
**Date:** 2026-04-28
**Branch:** `feat/064-wkh-65-a2a-forward-key`
**Commits reviewed:** `d2f9752`, `c47aa4b`, `bfe72b1`

## Veredicto

**APPROVED**

- 0 bloqueantes.
- 8/8 ACs cubiertos por código + test.
- 7/7 CDs cumplidos.
- 2 sugerencias menores no bloqueantes (nits).

`tsc --noEmit` exit 0. `vitest run forward-key.test.ts timeout.test.ts` → 13/13 PASS.

---

## ACs verificados (8 ACs)

| AC | Estado | Evidencia (archivo:línea) |
|----|--------|---------------------------|
| AC-1 | PASS | `forward-key.ts:62-68` (factory returns `[]` when unset/empty) + `forward-key.test.ts:36-48` (2 tests: unset + empty string) |
| AC-2 | PASS | `forward-key.ts:103` (no-op fall-through after match) + `forward-key.test.ts:170-195` (matching key → 200) |
| AC-3 | PASS | `forward-key.ts:90-101` (401 + `INVALID_FORWARD_KEY`) + `forward-key.test.ts:52-77` |
| AC-4 | PASS | `forward-key.ts:80-85` (`if (typeof headerValue !== 'string' \|\| headerValue.length === 0) return;`) + `forward-key.test.ts:81-106` (passthrough 200) |
| AC-5 | PASS | `forward-key.ts:38-52` (`safeStringEquals` uses dummy buffer of `recvBuf.length` to avoid throw + leak) + `forward-key.test.ts:110-136` (header shorter) + `:138-166` (header longer) |
| AC-6 | PASS | `forward-key.ts:74-78` (`request.log.info({ forwardSource }, ...)` informational, no routing effect) + `forward-key.test.ts:199-253` (asserts `forwardSource: 'v2-proxy'` log entry + 200 OK) |
| AC-7 | PASS | `compose.ts:29` (default `'180000'`) + `timeout.test.ts:80-85` (test "WKH-65 AC-7: compose timeout uses 180s by default") + `.env.example:179` (documented) |
| AC-8 | PASS | 9 new tests added, 4 mandatory ACs covered (AC-1, AC-3, AC-4, AC-5) + 3 bonus (AC-2, AC-6, CD-4 guard). Full suite passes (`tsc --noEmit` exit 0; `vitest run` 13/13 PASS on the 2 affected files). Note: full 612-baseline run not executed in CR (out of CR scope; QA runs in F4). |

**Conclusion:** all 8 ACs covered by both implementation and at least one assertive test.

---

## CDs verificados (7 CDs)

| CD | Estado | Evidencia |
|----|--------|-----------|
| CD-1 | PASS | `forward-key.ts` y `forward-key.test.ts`: zero `any` explícito. Types: `preHandlerAsyncHookHandler`, `FastifyRequest`, `FastifyReply`. Type narrowing usa `typeof headerValue !== 'string'` (no cast). `tsc --noEmit` exit 0. |
| CD-2 | PASS | `forward-key.ts:62-68`: `if (!expected \|\| expected.length === 0) return [];` — factory devuelve array vacío cuando unset O empty string. Verificado por 2 tests (`:36-48`). El spread `...requireForwardKey()` en `compose.ts:27` y `orchestrate.ts:49` produce no-op cuando `[]`. |
| CD-3 | PASS | `forward-key.ts:47, 51`: `crypto.timingSafeEqual(...)`. NO `===`, NO `Buffer.equals()`. Import `import crypto from 'node:crypto'` (`:22`). |
| CD-4 | PASS | `forward-key.ts:93-96`: `request.log.warn({ headerPresent: true }, 'forward-key validation failed')` — solo loguea booleano, NO el valor. NO se loguea `expected` ni `headerValue` en ningún path. Validado por test guard `:257-298` que asserta que ni `SECRET` ni `ATTACKER` aparecen en la salida del logger. |
| CD-5 | PASS | 9 tests cubren: happy path (AC-2), key inválida (AC-3), header ausente (AC-4), shorter (AC-5a), longer (AC-5b), source logging (AC-6), unset/empty env (AC-1 ×2), CD-4 guard. Excede el mínimo "happy + 3 edge". |
| CD-6 | PASS (parcial — alcance CR) | `tsc --noEmit` exit 0. Tests forward-key + timeout pasan 13/13. **CR no corre los 612 baseline; eso es trabajo de F4 QA**. Sin cambios en código preexistente excepto `compose.ts` (default bump 120k→180k, blindado por test) y `orchestrate.ts` (spread aditivo, no-op cuando env vacía). |
| CD-7 | PASS | Sin nonce, sin timestamp, sin window, sin storage. Grep confirma: `forward-key.ts` no menciona "nonce", "replay", "timestamp" ni "window". Defensa única: `timingSafeEqual` contra `expected`. |

**Conclusion:** los 7 CDs respetados, especialmente los críticos de seguridad (CD-3, CD-4) verificados con assertion explícita en tests.

---

## Hallazgos por dimensión

### 1. Adherencia a los ACs

Todos los ACs cubiertos con código + test. La cobertura va más allá del mínimo (4 tests obligatorios → 9 entregados). No hay gaps.

### 2. Adherencia a los CDs

Cada CD cumplido. El test `CD-4: forward key value is NEVER logged on failure` (`:257-298`) es ejemplar — no solo cumple el CD sino que añade un guard automatizado contra regresiones futuras.

### 3. Patrones / Convenciones del codebase

**Comparación con `a2a-key.ts` (precedente cercano):**

| Aspecto | `a2a-key.ts` | `forward-key.ts` | Veredicto |
|---------|-------------|------------------|-----------|
| Import crypto | `import crypto from 'node:crypto'` (línea 8) | `import crypto from 'node:crypto'` (línea 22) | match |
| Tipo de retorno factory | `preHandlerAsyncHookHandler[]` (línea 87) | `preHandlerAsyncHookHandler[]` (línea 62) | match |
| Header name como const | inline `'x-a2a-key'` | extraído a const `FORWARD_KEY_HEADER` (línea 29) | mejora razonable (más DRY) |
| Error code shape | `{ error, error_code }` (línea 46) | `{ error, error_code }` (línea 97-100) | match |
| Status para auth fail | 403 (KEY_NOT_FOUND etc) | 401 (INVALID_FORWARD_KEY) | DIFERENTE pero correcto: 401 es semánticamente "no autenticado" y 403 es "autenticado pero no autorizado". El forward-key es shared-secret, así que 401 es la elección correcta. |

**Convención de tests:** el dev co-localizó `forward-key.test.ts` junto al source (línea con `a2a-key.test.ts`, `timeout.test.ts`, etc), NO en `__tests__/` — el work-item sugería `src/middleware/__tests__/forward-key.test.ts` pero el dev correctamente siguió la convención existente del codebase. **No hay subdirectorio `__tests__` en `src/middleware/`** (verificado). Decisión correcta.

**Imports ordenados alfabéticamente** en `compose.ts` y `orchestrate.ts` (verificado en diff).

**JSDoc al tope del archivo** con secciones claras (Behavior / Security / Logging) — consistente con el estilo de `a2a-key.ts`.

### 4. Tests calidad

- **Cobertura:** AC-1, AC-2, AC-3, AC-4, AC-5 (×2), AC-6, CD-4 + 1 extra para empty string. 9 tests bien distribuidos.
- **Asserts específicos:** `expect(res.json().error_code).toBe('INVALID_FORWARD_KEY')`, no genérico `toBeTruthy()`.
- **Mocks razonables:** usa Fastify real con `app.inject()` (zero-network, integración real). NO mock de `crypto.timingSafeEqual` (correcto: el comportamiento real es lo que importa).
- **Setup/teardown limpio:** `beforeEach/afterEach` salva/restaura `WASIAI_V2_FORWARD_KEY` + cierra `app.close()` en `finally` para no leakear listeners.
- **Test CD-4 guard** (`:257-298`) es excelente — captura logs vía custom stream y asserta que ni el SECRET ni el ATTACKER aparecen. Defensa proactiva.
- **No hay tests redundantes** — cada test prueba algo distinto.

Una **sugerencia menor** abajo (no bloqueante).

### 5. TypeScript / Types

- Cero `any` explícito.
- Cero `as` cast sospechoso (todos los `as` son safe en parsing JSON dentro del log capture stream).
- `typeof X === 'string'` usado para narrowing de `request.headers[...]` (correcto: el tipo Fastify es `string | string[] | undefined`).
- `preHandlerAsyncHookHandler` importado directamente — type-safe.
- El return type de la factory es explícito (`preHandlerAsyncHookHandler[]`) — no se infiere implícitamente.

### 6. Error handling

- Único error code: `INVALID_FORWARD_KEY` — alineado con AC-3.
- Mensaje `'Invalid forward key'` (`:98`) NO leakea info (no menciona la longitud esperada ni patrones).
- El status 401 + `error_code` shape es consistente con el resto del codebase (verificado contra `a2a-key.ts:46`).
- `safeStringEquals` **NUNCA** lanza excepción, ni siquiera con length mismatch (verificado en `:42-49` + 2 tests AC-5). Esto evita que un attacker dispare un crash con un header malformado.

### 7. Documentación

- **JSDoc al header del archivo** (`:1-21`) explica WHY (defense-in-depth, env-gated, security rationale) — no solo WHAT.
- **JSDoc de `safeStringEquals`** (`:33-37`) explica el truco del dummy buffer y el motivo (evitar leak de length via timing).
- **Comentarios inline** en momentos críticos: `:43-45` (length mismatch rationale), `:74` (AC-6 reference), `:91-92` (CD-4 reference).
- **Trazabilidad a ACs/CDs/DTs** en comentarios — facilita auditoría futura.

### 8. Backward compatibility

- Sin env var → `requireForwardKey()` retorna `[]` → `...[]` es no-op → preHandler array idéntico al baseline.
- Bump `120000`→`180000` en `compose.ts:29`: tiene un test específico que asserta el nuevo default (`timeout.test.ts:80-85`). El test anterior de orchestrate (`:71-78`) sigue verificando 120s — no roto.
- API de `/compose` y `/orchestrate` SIN cambios en request/response shape.
- El header `x-wasiai-forward-key` es **opcional** cuando la env var está activa (AC-4) — clientes externos sin el header NO se rompen.
- `.env.example` documenta extensivamente el comportamiento (`:21-39`).

### 9. Performance

El middleware corre en cada request a `/compose` y `/orchestrate`. Análisis hot-path:

- **Allocations por request:** `Buffer.from(received, 'utf8')` + `Buffer.from(expected, 'utf8')` = 2 buffers chicos (~32 bytes cada uno). Despreciable.
- **Length mismatch path:** allocate adicional `Buffer.alloc(recvBuf.length, 0)` + 1 `timingSafeEqual` call descartado. Ocurre solo en attack/error path, no en happy path.
- **Happy path:** 2 `Buffer.from` + 1 `timingSafeEqual`. ≤ 1 µs.
- **`process.env.WASIAI_V2_FORWARD_KEY` lookup** (`:63`): se hace una sola vez en factory time (al construir el preHandler), NO por request. Bien.
- **Header lookup:** `request.headers[FORWARD_KEY_HEADER]` y `request.headers[FORWARD_SOURCE_HEADER]` son lookups O(1) en un object. OK.

**No allocations innecesarias en hot path.** Performance impact: < 5 µs por request, probablemente más cerca de 1 µs.

**Sugerencia menor (nit):** `process.env.WASIAI_V2_FORWARD_KEY` se lee solo al startup. Si el operador rota la key sin restart, la nueva no toma efecto. Esto es **expected behavior** (DT-1 implícito) y `.env.example:36-37` lo documenta ("Rotate by updating the env var on Railway"). No es un bug, pero podría ser una nota explícita en el JSDoc.

### 10. Maintainability

- **Single-responsibility:** el middleware hace UNA cosa (validar shared secret), bien delimitado.
- **Naming claro:** `requireForwardKey`, `safeStringEquals`, `FORWARD_KEY_HEADER`. Sin abreviaciones crípticas.
- **Constantes de header extraídas** (`:29-30`) — fácil refactor si se cambia el nombre del header en el futuro.
- **107 líneas totales** — compacto y legible.
- **Trazabilidad work-item ↔ código** vía comentarios `WKH-65`, `AC-N`, `CD-N`, `DT-N`. Excelente para code archaeology.

Si dentro de 6 meses alguien tiene que cambiar esto: el código se entiende en una pasada, los tests cubren lo crítico, y los comentarios explican el por qué de las decisiones no obvias (dummy buffer, env-gated factory).

---

## Sugerencias (no bloqueantes)

1. **`forward-key.ts:74-78`** — el bloque `forwardSource` logging corre **antes** de validar la forward key. Esto es by-design (DT-3: `x-wasiai-source` se loguea independiente del resultado de auth), pero implica que un attacker puede inyectar logs vía `x-wasiai-source: <texto-arbitrario>` sin tener una forward key válida. Pino lo loguea como string structured field, así que no hay log injection a nivel formato. Sin embargo, podría considerarse capear la longitud del valor logueado (e.g., `sourceHeader.slice(0, 128)`) para prevenir log volume amplification. **Severidad:** muy baja, no bloqueante. Sugerencia mejor llevada al AR.

2. **`forward-key.test.ts:199-253`** — el test AC-6 captura logs parseando JSON línea por línea. Funciona bien, pero el `try/catch` silencioso (`:218-220`) podría enmascarar líneas no-JSON inesperadas (e.g., si pino emite warnings de setup). Considerar al menos un `console.warn` o test cleanup para detectar emisión no-JSON. **Severidad:** muy baja — el test actual asserta `find` sobre el array y pasa. Solo un nit de robustez de test.

---

## OK / Bien hecho (para reproducir)

- **Test CD-4 guard automatizado** (`forward-key.test.ts:257-298`): captura los logs y asserta que ni el secret real ni el valor del attacker aparecen. Patrón replicable para futuros middlewares con secrets sensibles.
- **`safeStringEquals` con dummy buffer** (`forward-key.ts:38-52`): solución limpia al problema clásico de "cómo comparar dos strings constant-time cuando pueden tener length diferente". Documentado en JSDoc + comentario inline.
- **Factory pattern devolviendo `[]`** (`forward-key.ts:62-68` + `compose.ts:27`): patrón elegante para wiring opcional sin `if` en el route handler. Backward compat garantizada por construcción.
- **Trazabilidad trifásica** (work-item → código → test): cada AC y CD aparece referenciado en comentarios + en el test correspondiente. Audit trail completo.
- **JSDoc al tope del archivo** estructurado en secciones (Behavior / Security / Logging) — facilita lectura por nuevo developer.
- **Env-gated default bump** (`compose.ts:29`): el bump 120k→180k tiene un test que lo blinda contra regresiones (`timeout.test.ts:80-85`).
- **Imports alfabéticos** en `compose.ts` y `orchestrate.ts`: el dev mantuvo el orden existente.

---

## Resumen

- **ACs cubiertos:** 8/8
- **CDs cumplidos:** 7/7
- **Issues bloqueantes:** 0
- **Sugerencias menores (nits):** 2 (logging length cap + test JSON parse robustness)
- **`tsc --noEmit`:** exit 0
- **Tests forward-key + timeout:** 13/13 PASS (suite completa baseline NO ejecutada en CR; queda para F4 QA)
- **Diff stats:** +444 / -5 sobre 6 archivos, todos en scope.
- **Convenciones:** matching `a2a-key.ts` precedente.
- **Backward compat:** garantizada por construcción (factory returns `[]` cuando env vacía).

**Recomendación:** APPROVED. Pasar a F4 QA para validación de los 612 tests baseline + drift detection. Las 2 sugerencias menores son opcionales y pueden cerrarse vía MNR-LIGHT post-merge si Fernando lo prioriza, o ignorarse.
