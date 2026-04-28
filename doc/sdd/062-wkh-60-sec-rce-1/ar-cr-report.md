# Adversarial Review + Code Review — WKH-60 / SEC-RCE-1

## Resumen ejecutivo

AR identificó 3 BLQ-ALTOs (prototype chain escape, microtask leak, IIFE breakout) en commit W4; fix-pack (commit 7f81cd8) resolvió todos vía worker_threads + vm sandbox. CR validó ownership checks, HMAC integrity, arquitectura de isolation. Veredicto: **APROBADO tras fix-pack**.

---

## Adversarial Review — Hallazgos

### BLQ-ALTO-1: Prototype Chain Escape via `output.constructor.constructor`

**Descubrimiento**: Post-W4, el código parseaba `output` en el contexto del *caller*, no del sandbox. El prototype chain del output object cruza al realm del caller.

**Repro real**:
```javascript
// Attacker input
const maliciousTransform = `
  const leak = output.constructor.constructor('return process.env.HOME')();
  return leak;
`;
// result = '/home/ferdev' (process env del host)
```

**Archivo afectado**: `src/services/llm/vm-runner.ts` (pre-fix-pack, línea ~150)

**Raíz**: `JSON.parse(vm.runInContext(...))` ejecutaba en el vm context pero JSON.stringify/parse del output se hacía en el caller realm.

**Fix (commit 7f81cd8)**:
- Líneas 153-165: `JSON.parse` movido **adentro** del vm context (el string se pasa como argumento)
- `codeGeneration: { strings: false, wasm: false }` bloquea `Function` constructor
- Test T-VER-RCE-13 verifica que constructor escapes rejectan

**Severidad**: CRÍTICA (RCE multi-tenant, exfiltración de env vars)

---

### BLQ-ALTO-2: Microtask Escape via `Promise.then` Sobrevive Timeout

**Descubrimiento**: El timeout de `vm.runInContext` es sincrónico. Una Promise con `.then` registra un microtask en el event loop global, el cual **sobrevive** al retorno de vm.runInContext.

**Repro real**:
```javascript
const maliciousTransform = `
  Promise.resolve().then(() => {
    output.exfiltrate = process.env.SECRET;
  });
  return {}; // retorna inmediatamente, ignorando microtask
`;
// Después de ~10ms: output.exfiltrate contiene el secret del caller
```

**Archivo afectado**: `src/services/llm/vm-runner.ts` (pre-fix-pack, línea ~260)

**Raíz**: `vm.runInContext` con `timeout` solo mata CPU sync. Microtasks y timers en el mismo event loop escapan.

**Fix (commit 7f81cd8)**:
- Líneas 256-267: Refactor a `worker_threads.Worker` con inline script CommonJS
- `worker.terminate()` mata el event loop completo, incluyendo microtasks pendientes
- `resourceLimits` (64 MB old gen, 16 MB young gen) evita OOM attacks
- Test T-VER-RCE-14 espera 200ms post-ejecución y verifica `microtaskFired === false`

**Severidad**: CRÍTICA (async RCE, estado compartido con caller)

---

### BLQ-ALTO-3: IIFE Wrapper Breakout via Concatenación Maliciosa

**Descubrimiento**: El código generaba un IIFE: `(function(o){ <userBody> })(output)`. Un attacker puede inyectar `})(output); ATTACK; (function(o){` para escapar el wrapper.

**Repro real**:
```javascript
const maliciousBody = `
  return 1
})(output);
const leak = output.constructor.constructor('return process.env.SECRET')();
process.exit(1); // o cualquier código malicioso
(function(o){
  return 1
`;
// El cierre prematuro + reapertura permite código libre sin parámetro 'o'
```

**Archivo afectado**: `src/services/llm/vm-runner.ts` (pre-fix-pack, línea ~225)

**Raíz**: IIFE body concatenado sin escaping. Aunque sea escapado, el wrapper es vulnerable si el body contiene `})`.

**Fix (commit 7f81cd8)**:
- Línea 225: Cambio a `vm.compileFunction` con `body` como string directo, sin concatenación
- Wrapper ya no existe; el body se compila como función con parámetros explícitos
- Test T-VER-RCE-15 verifica que inyección de `}` y `(` causa SyntaxError

**Severidad**: CRÍTICA (RCE directa, combinable con BLQ-ALTO-1)

---

## Code Review — Validaciones de Arquitectura

### Ownership Checks — Multi-tenant Isolation

**Archivo**: `src/services/llm/transform.ts` (lines 208-212, 379)

**Validación**: L2 cache read incluye 4ta eq en chain:
```typescript
const cached = await getFromL2Cache(
  ...
  .eq('owner_ref', ownerId)  // ← imprescindible
  .single();
```

**Never-cache mode** (línea 379): `if (ownerId !== undefined)` — si el caller no proporciona owner, bypass L2 read/write completamente.

**CR Result**: PASS — cross-tenant poisoning bloqueado, anon never-cache fallback seguro.

**Evidencia**: `transform-rce.test.ts` T-VER-RCE-7 (anon bypass), T-VER-RCE-8 (tenant-1 vs tenant-2 separate caches)

---

### HMAC Signature & Integrity Verification

**Archivo**: `src/services/llm/transform-hmac.ts` (lines 34, 53)

**Validaciones**:
1. `signTransformFn` usa `SCHEMA_TRANSFORM_HMAC_KEY` (env var, degraded mode: undefined → skip signing)
2. `verifyTransformFn` usa `timingSafeEqual` para comparación (timing-attack safe)
3. L2 read (línea 231-233): Si sig está presente pero inválida, retorna `null` (cache miss)

**CR Result**: PASS — HMAC constant-time, degraded mode documentado, no RCE por timing leaks.

**Evidencia**: `transform-hmac.test.ts` T-HM-1..T-HM-8 (sign/verify/degraded), `transform-rce.test.ts` T-VER-RCE-10/11 (tampered fn → miss)

---

### Propagation en Orchestration Layer

**Archivo**: `src/services/compose.ts` (lines 172-178)

**Validación**: `maybeTransform` recibe `scopingKeyRow?.owner_ref` desde el orchestrator, lo pasa como `ownerId` al service.

**CR Result**: PASS — ownership boundary respetada en capa de orquestación.

**Nota**: No hay E2E test de compose para esta HU (suficiente: tests de transform service). Compose solo actúa como courier del ownerId.

---

### Worker Threads Resource Isolation

**Archivo**: `src/services/llm/vm-runner.ts` (lines 256-267)

**Validaciones**:
1. `resourceLimits`: old gen 64 MB, young gen 16 MB — evita OOM denial-of-service
2. `worker.terminate()` en timeout — mata event loop (microtasks, timers, promises)
3. JSON.parse adentro worker → no prototype chain leaks

**CR Result**: PASS — aislamiento real del event loop, recursos limitados, serialización segura.

**Evidencia**: `vm-runner.test.ts` T-VM-8 (timeout + terminate), `transform-rce.test.ts` T-VER-RCE-14 (microtask killed)

---

## MENORs Cerrados

| ID | Descripción | Fix | Status |
|----|-------------|-----|--------|
| MNR-1 | `SCHEMA_TRANSFORM_HMAC_KEY` no en `.env.example` | TD menor: agregar con comentario | Documentado en qa-report.md |
| MNR-2 | Story File ausente en disco | De facto en prompts | Documentado en auto-blindaje.md |
| MNR-3 | Transform.test.ts legacy mock chain refactor | Actualizar 6 tests + 4-eq | Done en W3 |
| MNR-4 | TransformExecutionError re-export clarification | Comentario inline | Done en W4 |

---

## Gates Post-Fix-Pack

- **tsc**: exit 0 (0 errors)
- **vitest**: 612 passed
- **AR**: 3 BLQ-ALTOs cerrados + verdicto APROBADO
- **CR**: Ownership, HMAC, isolation — PASS

---

## Veredicto

**APROBADO** — fix-pack cierra todos los BLQ-ALTOs de forma arquitectónicamente sólida. La combinación worker_threads + vm.createContext + JSON serialization elimina los 3 vectores RCE. Ownership checks multi-tenant implementados correctamente. HMAC integrity verificado con constant-time compare. Ready para DONE.
