# Story File — WKH-56: A2A Fast-Path en compose

> Self-contained contract para nexus-dev (F3). Lee SOLO este archivo + el SDD si necesitas más contexto.

---

## 0. Header

| Campo | Valor |
|-------|-------|
| **HU ID** | WKH-56 |
| **Branch** | `feat/055-wkh-56-a2a-fast-path` |
| **Branch base** | `main` (commit `88010a4` — `chore(WKH-55 TD-LIGHT): close 7 of 8 cosmetic MNRs from AR + CR`) |
| **Pipeline** | QUALITY |
| **SDD source** | `doc/sdd/055-wkh-56-a2a-fast-path/sdd.md` (SPEC_APPROVED 2026-04-26) |
| **Work Item** | `doc/sdd/055-wkh-56-a2a-fast-path/work-item.md` (HU_APPROVED 2026-04-26) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Estimación** | L (5 waves, ~280-350 LOC nuevas, 20 tests nuevos) |

### Acceptance Criteria (resumen — ver SDD §2.1 para EARS completo)

| AC | Resumen | Status WKH-56 |
|----|---------|---------------|
| AC-1 | A2A→A2A passthrough: bypass `maybeTransform`, set `bridgeType='A2A_PASSTHROUGH'`, `transformLatencyMs<5` | IN SCOPE |
| AC-2 | non-A2A output → `maybeTransform` flujo actual sin regresión | IN SCOPE |
| AC-3 | A2A output + non-A2A target → unwrap `parts[0]` antes de `maybeTransform` | IN SCOPE |
| AC-4 | non-A2A output + A2A target → LLM produce A2A Message | **OUT OF SCOPE** — DEFERIDO a WKH-57 (DT-5). NO se implementa, NO se testea, NO se valida en F4. |
| AC-5 | `isA2AMessage(value)` retorna `true` ssi role∈{agent,user,tool}, parts non-empty, kind∈{text,data,file} | IN SCOPE |
| AC-6 | `compose_step` event tiene `metadata.bridge_type` ∈ {A2A_PASSTHROUGH, SKIPPED, CACHE_L1, CACHE_L2, LLM} (null/absent solo en último step) | IN SCOPE |
| AC-7 | `src/services/a2a-protocol.ts` line coverage ≥85% + cada branch nuevo de compose.ts cubierto | IN SCOPE |
| AC-8 | T-1..T-9 baseline de `compose.test.ts` siguen pasando sin modificación (zero regresión) | IN SCOPE |

---

## 1. Anti-Hallucination Protocol

> **Estas reglas son INVIOLABLES. Cualquier violación cancela el wave y obliga a abrir auto-blindaje.**

1. **NO inventés APIs que no existan en el codebase.** Validá con `Glob`/`Read` antes de usar cualquier path, función, import, módulo. Si dudás, `grep -rn "<symbol>" src/`.
2. **NO modifiqués archivos fuera del Scope IN.** Lista exhaustiva en §1.1 abajo.
3. **NO cambiés scope.** Si necesitás un archivo nuevo o una API nueva no listada en el SDD, **STOP** y reportá al orquestador en el resumen final. NO improvises.
4. **Cada commit cierra una wave.** NO mezclar waves en un solo commit. Mensaje exacto definido en §3 (Waves).
5. **Imports relativos terminan en `.js`** (Node16/NodeNext ESM, verificado en `tsconfig.json`). Ejemplo: `import { isA2AMessage } from './a2a-protocol.js';` — NO `'./a2a-protocol'` ni `'./a2a-protocol.ts'`.
6. **NO usar `any` explícito** (CD-1, CD-16). Type guards usan narrowing real (`value is A2AMessage`). Si necesitás flexibilidad, usá `unknown` + narrowing.
7. **NO `throw` en helpers de `a2a-protocol.ts`** (CD-12, AB-WKH-55-4). Retorná valor seguro: `false`, `[]`, o Message mínimo válido.
8. **NO mutar inputs** (CD-15). `extractA2APayload` retorna array nuevo, NO `msg.parts` directo.
9. **NO usar spread del input en `buildA2APayload`** (CD-13, AB-WKH-55-5). Constructor explícito: `return { role: 'agent', parts: [{ kind: 'data', data: data ?? null }] }`.
10. **CD-11 (anti-drift, AB-WKH-53-#2):** ANTES de modificar cualquier test pre-existente, ejecutá `grep -n "<assert pattern>" <file>` para confirmar que el assert existe en disco. Si no existe como esperabas, **NO inventés** — reportá drift.

### 1.1 Scope IN (archivos que TENÉS PERMITIDO tocar)

| Archivo | Acción | Existe hoy |
|---------|--------|------------|
| `src/services/a2a-protocol.ts` | **CREAR** | NO (verificado con `ls`) |
| `src/services/a2a-protocol.test.ts` | **CREAR** | NO |
| `src/types/index.ts` | **MODIFICAR** | SI (532 LOC) |
| `src/services/llm/transform.ts` | **MODIFICAR** | SI (260 LOC) |
| `src/services/compose.ts` | **MODIFICAR** | SI (8379 bytes) |
| `src/services/agent-card.ts` | **MODIFICAR** | SI (3345 bytes) |
| `src/services/compose.test.ts` | **MODIFICAR** | SI (13468 bytes, 9 tests T-1..T-9) |
| `src/services/agent-card.test.ts` | **MODIFICAR (opcional W4.3)** | SI (5947 bytes) |
| `src/services/llm/transform.test.ts` | **MODIFICAR (solo si CD-11 detecta drift)** | SI (7633 bytes) |

### 1.2 Scope OUT (PROHIBIDO tocar)

| Path | Razón |
|------|-------|
| `src/lib/downstream-payment.ts` | WKH-55 DONE (CD-3) |
| `src/services/orchestrate.ts` | Scope distinto (CD-4) |
| `src/routes/*` | Fast-path es interno al compose service, no expone endpoints nuevos |
| `src/middleware/*` | No aplica |
| `src/db/*` | No hay cambios DB (CD del work-item §Scope OUT) |
| `doc/sdd/053-*`, `doc/sdd/054-*` | DONE, NO reabrir |
| `wasiai-v2` (otro repo) | Otro proyecto |
| `package.json` | NO agregar dependencias (SDD §12) |
| `tsconfig.json` | NO modificar config TS |
| `.env*`, `vitest.config.*` | NO requerido |

---

## 2. Pre-implementation checklist (CONFIRMAR ANTES DE EMPEZAR W0)

> Marcar `[X]` en el resumen final por cada item. Si saltás esto, el architect rechaza el AR.

- [ ] Read `.nexus/project-context.md` (skim, 5 min) — entender stack y reglas
- [ ] Read `doc/sdd/055-wkh-56-a2a-fast-path/sdd.md` completo (15-20 min)
- [ ] Read `src/services/compose.ts` lineas 80-150 (current bridge logic, 5 min) — entender dónde va el fast-path
- [ ] Read `src/services/llm/transform.ts` entero (10 min) — entender `maybeTransform` y los 4 returns (SKIPPED/L1/L2/LLM)
- [ ] Read `src/services/agent-card.ts` entero (5 min) — entender `buildAgentCard`
- [ ] Read `src/services/event.ts` lineas 50-90 (5 min) — confirmar que `metadata` ya existe en input de `track`
- [ ] Read `src/types/index.ts` lineas 110-205 (Agent + StepResult + TransformResult, 5 min) y 380-410 (AgentCard.capabilities, 2 min)
- [ ] Read `src/services/compose.test.ts` lineas 1-100 (mocks + helpers + T-1, 10 min) — para entender pattern de tests
- [ ] Read `src/services/agent-card.test.ts` lineas 1-80 (5 min) — para entender pattern de tests sin mocks complejos
- [ ] Read `doc/sdd/053-wkh-53-rls-ownership/auto-blindaje.md` (5 min) — internalizar AB-WKH-53-#2 (anti-drift)
- [ ] Read `doc/sdd/054-wkh-55-downstream-x402-fuji/auto-blindaje.md` (5 min) — internalizar AB-WKH-55-4 (never-throw) y AB-WKH-55-5 (constructor explícito)
- [ ] Verificar git branch actual con `git branch --show-current` y crear `feat/055-wkh-56-a2a-fast-path` desde `main` (ver §9)

---

## 3. Waves de implementación

> Orden estricto: W0 → W1 → W2 → W3 → W4. W4 puede correr en paralelo a W2/W3 (toca archivo distinto), pero por simplicidad implementala secuencial.

### Wave 0 — Tipos + helpers `a2a-protocol.ts` (standalone-mergeable, CD-9)

**Objetivo:** Tipos + helpers puros. Mergeable independiente sin breaking nada.

**Archivos:**
1. **CREAR** `src/services/a2a-protocol.ts` con 3 funciones puras:
   - `isA2AMessage(value: unknown): value is A2AMessage` — type guard
   - `extractA2APayload(msg: A2AMessage): unknown[]` — extrae payloads de `parts`
   - `buildA2APayload(data: unknown): A2AMessage` — wrap mínimo
2. **CREAR** `src/services/a2a-protocol.test.ts` con 16 tests (T-A2A-1..T-A2A-16) — ver §6 Test Plan.
3. **MODIFICAR** `src/types/index.ts`:
   - Agregar bloque `// === A2A PROTOCOL TYPES (Google A2A v1 — WKH-56) ===` con `A2APart`, `A2ATextPart`, `A2ADataPart`, `A2AFilePart`, `A2AMessage`.
   - Agregar bloque `// === BRIDGE TYPES (WKH-56) ===` con `BridgeType`.
   - Agregar `bridgeType?: BridgeType` a `StepResult` (después de `transformLatencyMs?`).
   - Agregar `bridgeType: BridgeType` a `TransformResult` (campo requerido nuevo).
   - Agregar `a2aCompliant?: boolean` a `AgentCard.capabilities`.

**Validación al cerrar W0:**
```bash
npx tsc --noEmit
npx vitest run src/services/a2a-protocol.test.ts
```
- `tsc --noEmit` debe terminar sin errores.
- `vitest` debe correr 16 tests, todos PASS.
- Coverage objetivo: 100% líneas de `a2a-protocol.ts` (>= AC-7 que pide 85%).
- NO tocar `compose.ts`, `transform.ts`, `agent-card.ts` en este wave.

**Commit:**
```
feat(WKH-56-W0): A2A protocol helpers + types
```

---

### Wave 1 — `bridgeType` en `TransformResult` y `StepResult`

**Objetivo:** `maybeTransform` retorna `bridgeType` mapeado desde `cacheHit`. Sin cambiar lógica de cache.

**Archivos:**
1. **MODIFICAR** `src/services/llm/transform.ts`:
   - En cada uno de los 4 returns de `maybeTransform`, agregar `bridgeType` derivado:
     - SKIPPED branch (incompatible): `{ ..., cacheHit: 'SKIPPED', bridgeType: 'SKIPPED', ... }`
     - L1 hit (memoria): `{ ..., cacheHit: true, bridgeType: 'CACHE_L1', ... }`
     - L2 hit (Supabase): `{ ..., cacheHit: true, bridgeType: 'CACHE_L2', ... }`
     - LLM gen (no hit): `{ ..., cacheHit: false, bridgeType: 'LLM', ... }`
   - **NO cambiar la lógica** del cache. Solo agregar el campo nuevo al return.
2. **MODIFICAR** `src/services/compose.test.ts` lineas ~26-32 (mock de `vi.mock('./llm/transform.js', ...)`):
   - Actualizar el `mockResolvedValue` default para incluir `bridgeType: 'SKIPPED'`.
3. **VERIFICAR (CD-11 anti-drift)** — ANTES de modificar `transform.test.ts`:
   ```bash
   grep -n "cacheHit" src/services/llm/transform.test.ts
   grep -n "toEqual" src/services/llm/transform.test.ts
   ```
   - Si hay un `toEqual({ transformedOutput, cacheHit, latencyMs })` exacto, agregar `bridgeType` al expected.
   - Si solo hay asserts sobre `cacheHit` (no shape exacto), NO tocar (campo aditivo es invisible).

**Validación al cerrar W1:**
```bash
npx tsc --noEmit
npx vitest run src/services/llm/transform.test.ts
npx vitest run src/services/compose.test.ts
```
- `tsc --noEmit` clean.
- T-1..T-5 de `transform.test.ts` siguen PASS.
- T-1..T-9 de `compose.test.ts` siguen PASS (mock default actualizado no rompe nada porque consumers aún no leen `bridgeType`).

**Commit:**
```
feat(WKH-56-W1): bridgeType en TransformResult/StepResult
```

---

### Wave 2 — Fast-path en `compose.ts` (AC-1, AC-2, AC-3)

**Objetivo:** Insertar fast-path en bridge loop de `composeService.compose()`.

**Archivos:**
1. **MODIFICAR** `src/services/compose.ts`:
   - Agregar imports al top:
     ```ts
     import { isA2AMessage, extractA2APayload } from './a2a-protocol.js';
     import type { A2AMessage, BridgeType } from '../types/index.js';
     ```
   - Reemplazar bloque del bridge (líneas ~111-135 — donde hoy está el `if (i < steps.length - 1) { ... maybeTransform ... }`) con la lógica del SDD §5.4:
     - Resolver `nextAgent` (preserve current).
     - Calcular `targetA2A = nextAgent.metadata?.a2aCompliant === true` (estricto, solo `true` literal — DT-4).
     - Calcular `outputIsA2A = isA2AMessage(lastOutput)`.
     - Marcar `bridgeStart = Date.now()`.
     - **AC-1 fast-path:** if `outputIsA2A && targetA2A` → `result.bridgeType = 'A2A_PASSTHROUGH'`, `result.transformLatencyMs = Date.now() - bridgeStart`, `lastOutput` UNCHANGED, NO llamar `maybeTransform`.
     - **AC-3 unwrap:** if `outputIsA2A && !targetA2A` → `payloadForTransform = extractA2APayload(lastOutput as A2AMessage)[0] ?? lastOutput`.
     - **AC-2 fallback:** else → `payloadForTransform = lastOutput`.
     - Si hay `inputSchema` → llamar `maybeTransform(agent.id, nextAgent.id, payloadForTransform, inputSchema)` y propagar:
       - `result.cacheHit = tr.cacheHit;` (legacy, DT-3)
       - `result.bridgeType = tr.bridgeType;` (nuevo, DT-3)
       - `result.transformLatencyMs = tr.latencyMs;`
       - `lastOutput = tr.transformedOutput;`
     - Si NO hay inputSchema pero `outputIsA2A && !targetA2A` (caso schema-less + A2A) → `lastOutput = payloadForTransform` y `result.bridgeType = 'SKIPPED'`.
     - **NO mover `eventService.track` todavía** — eso es W3.
   - Preservar el `try/catch` existente con `console.error('[Compose] Transform failed at step ${i}:', transformErr)`.
2. **MODIFICAR** `src/services/compose.test.ts`:
   - Agregar T-10, T-11, T-12 (ver §6 Test Plan para pseudo-código).
   - Mantener T-1..T-9 sin tocar (CD-2 + AC-8). Si rompen, NO ajustar — diagnosticar regresión.

**Validación al cerrar W2:**
```bash
npx tsc --noEmit
npx vitest run src/services/compose.test.ts
```
- T-1..T-9 siguen PASS (zero regresión, AC-8).
- T-10, T-11, T-12 PASS (cubren AC-1, AC-2, AC-3).
- `tsc --noEmit` clean.

**Commit:**
```
feat(WKH-56-W2): fast-path A2A en compose.ts
```

---

### Wave 3 — `eventService` event metadata.bridge_type (AC-6)

**Objetivo:** Mover `eventService.track` al final del step + agregar `metadata.bridge_type`.

**Archivos:**
1. **MODIFICAR** `src/services/compose.ts`:
   - Localizar el `eventService.track({ eventType: 'compose_step', ... })` actual (estaba en líneas ~94-107 según SDD §3.1, **verificá con `grep -n "eventService.track" src/services/compose.ts` antes de mover**).
   - Mover el bloque del track a **después** del bloque del bridge (después del `if (i < steps.length - 1) { ... }`).
   - Agregar al payload del track: `metadata: { bridge_type: result.bridgeType ?? null }`.
   - Para el último step (`i === steps.length - 1`) NO hay bridge, entonces `result.bridgeType` queda `undefined` → `metadata.bridge_type` será `null` (CD-5: opcional, no required).
2. **NO modificar** `src/services/event.ts`. SDD §3.4 confirmó que `eventService.track` ya acepta `metadata?: Record<string, unknown>` y lo persiste como `metadata: input.metadata ?? {}`. Si necesitás un cambio en `event.ts`, **STOP** — fuera de scope.
3. **MODIFICAR** `src/services/compose.test.ts`:
   - Agregar T-13 (ver §6 Test Plan).
   - T-13 verifica:
     - En pipeline A2A→A2A, `metadata.bridge_type === 'A2A_PASSTHROUGH'`.
     - En el último step, `metadata.bridge_type === null` (o absent).

**Validación al cerrar W3:**
```bash
npx tsc --noEmit
npx vitest run src/services/compose.test.ts
```
- T-1..T-13 PASS.
- `tsc --noEmit` clean.

**Commit:**
```
feat(WKH-56-W3): emit bridge_type en compose_step event
```

---

### Wave 4 — `a2aCompliant` en `AgentCard.capabilities` (DT-2)

**Objetivo:** Propagar `agent.metadata.a2aCompliant` a `capabilities.a2aCompliant` en el JSON output del Agent Card.

**Archivos:**
1. **MODIFICAR** `src/services/agent-card.ts` (líneas ~62-79, función `buildAgentCard`):
   - En el objeto retornado, dentro de `capabilities`, agregar spread condicional:
     ```ts
     capabilities: {
       streaming: false,
       pushNotifications: false,
       ...(agent.metadata?.a2aCompliant === true && { a2aCompliant: true }),
     }
     ```
   - **NO** asignar `a2aCompliant: false` cuando es falso/ausente — se omite el campo (preserva backward-compat con consumers que validan shape exacto).
2. **VERIFICAR (CD-11 anti-drift)** ANTES de modificar `agent-card.test.ts`:
   ```bash
   grep -n "capabilities" src/services/agent-card.test.ts
   grep -n "toEqual" src/services/agent-card.test.ts
   ```
   - Si hay assert con `toEqual({ streaming: false, pushNotifications: false })` exacto sobre `capabilities`, ajustá:
     - Para tests donde `agent.metadata.a2aCompliant !== true`: NO tocar (campo se omite, assert sigue válido).
     - Para tests donde se quiera verificar nuevo comportamiento: usar `toMatchObject({...})` o agregar el campo al expected.
3. **(Opcional, recomendado)** **MODIFICAR** `src/services/agent-card.test.ts`:
   - Agregar 1-2 tests:
     - Test A: `agent.metadata.a2aCompliant = true` → `card.capabilities.a2aCompliant === true`.
     - Test B: `agent.metadata = {}` (sin flag) → `card.capabilities.a2aCompliant` es `undefined` (campo absent).

**Validación al cerrar W4:**
```bash
npx tsc --noEmit
npx vitest run src/services/agent-card.test.ts
npx vitest run                       # full suite, ver §7
npx vitest run --coverage src/services/a2a-protocol.ts
```
- Tests de `agent-card.test.ts` PASS (existentes + nuevos).
- Full suite PASS (T-1..T-13 + 16 tests a2a-protocol + agent-card + transform + lo demás).
- Coverage `a2a-protocol.ts` ≥85% (AC-7).
- `tsc --noEmit` clean.

**Commit:**
```
feat(WKH-56-W4): a2aCompliant flag en AgentCard.capabilities
```

---

## 4. Tipos exactos (copiar literalmente del SDD §5.2 + §5.3)

### 4.1 En `src/types/index.ts` (bloque NUEVO)

```ts
// ============================================================
// A2A PROTOCOL TYPES (Google A2A v1 — WKH-56)
// ============================================================

/** Discriminated union por kind. Google A2A v1. */
export type A2APart = A2ATextPart | A2ADataPart | A2AFilePart;

export interface A2ATextPart {
  kind: 'text';
  text: string;
}

export interface A2ADataPart {
  kind: 'data';
  data: unknown;
}

export interface A2AFilePart {
  kind: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string;  // base64
    uri?: string;
  };
}

export interface A2AMessage {
  /** Optional client-side correlator. NO se valida en isA2AMessage. */
  messageId?: string;
  role: 'agent' | 'user' | 'tool';
  parts: A2APart[];  // non-empty (validado en isA2AMessage)
}

// ============================================================
// BRIDGE TYPES (WKH-56)
// ============================================================

export type BridgeType =
  | 'A2A_PASSTHROUGH'
  | 'SKIPPED'
  | 'CACHE_L1'
  | 'CACHE_L2'
  | 'LLM';
```

### 4.2 Cambio en `StepResult` (en types/index.ts ~línea 172-188)

Agregar el campo `bridgeType?: BridgeType` (después de `transformLatencyMs?`). Mantener `cacheHit` con jsdoc `@deprecated`.

```ts
export interface StepResult {
  agent: Agent;
  output: unknown;
  costUsdc: number;
  latencyMs: number;
  txHash?: string;
  /** @deprecated Use bridgeType. Kept for backward-compat (WKH-56 DT-3). */
  cacheHit?: boolean | 'SKIPPED';
  /** Latency of bridge resolution (ms). Includes A2A fast-path or maybeTransform. */
  transformLatencyMs?: number;
  /** Bridge type for the transition step→step+1. WKH-56. */
  bridgeType?: BridgeType;
  // ── downstream fields (WKH-55) — sin cambios ──
  downstreamTxHash?: string;
  downstreamBlockNumber?: number;
  downstreamSettledAmount?: string;
}
```

### 4.3 Cambio en `TransformResult` (~línea 195-200)

```ts
export interface TransformResult {
  transformedOutput: unknown;
  /** @deprecated Use bridgeType. */
  cacheHit: boolean | 'SKIPPED';
  /** WKH-56: explicit bridge type derived from cache layer used. */
  bridgeType: BridgeType;  // 'SKIPPED' | 'CACHE_L1' | 'CACHE_L2' | 'LLM'
  latencyMs: number;
}
```

### 4.4 Cambio en `AgentCard.capabilities` (~línea 391-394)

```ts
capabilities: {
  streaming: boolean;
  pushNotifications: boolean;
  /** WKH-56: agent natively speaks Google A2A v1 (Message{role,parts}). */
  a2aCompliant?: boolean;
};
```

### 4.5 Signaturas de helpers en `src/services/a2a-protocol.ts`

```ts
import type { A2AMessage, A2APart } from '../types/index.js';

/**
 * Type guard for Google A2A v1 Message{role, parts}.
 * AC-5: returns true iff value is non-null object with role ∈ {agent,user,tool},
 * parts is non-empty array, every part has kind ∈ {text,data,file}.
 *
 * NEVER throws. Pure function. Tree-shakeable (CD-8, CD-12).
 */
export function isA2AMessage(value: unknown): value is A2AMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.role !== 'agent' && v.role !== 'user' && v.role !== 'tool') return false;
  if (!Array.isArray(v.parts) || v.parts.length === 0) return false;
  for (const p of v.parts) {
    if (typeof p !== 'object' || p === null) return false;
    const part = p as Record<string, unknown>;
    if (part.kind !== 'text' && part.kind !== 'data' && part.kind !== 'file') return false;
  }
  return true;
}

/**
 * Extracts inner payload of an A2A message into an array of part-payloads.
 * - 'text' part → string (the .text field)
 * - 'data' part → unknown (the .data field)
 * - 'file' part → the .file sub-object
 * Order preserved. Used in AC-3 to unwrap parts[0] when target is non-A2A.
 *
 * Returns a NEW array (CD-15: anti-mutation). NEVER throws (CD-12).
 */
export function extractA2APayload(msg: A2AMessage): unknown[];

/**
 * Wraps an arbitrary value into a minimal valid A2A Message.
 * Constructor explícito (CD-13, AB-WKH-55-5):
 *   { role: 'agent', parts: [{ kind: 'data', data: data ?? null }] }
 *
 * NEVER throws (CD-12). Provided for completeness; NOT called from compose.ts in WKH-56.
 */
export function buildA2APayload(data: unknown): A2AMessage;
```

---

## 5. Patrones obligatorios (heredados de auto-blindajes y SDD §11)

1. **Imports relativos terminan en `.js`** (Node16 ESM):
   ```ts
   import { isA2AMessage } from './a2a-protocol.js';      // OK
   import { isA2AMessage } from './a2a-protocol';          // MAL
   import { isA2AMessage } from './a2a-protocol.ts';       // MAL
   ```
2. **Helpers son puros, sin throw** (CD-12, AB-WKH-55-4):
   ```ts
   // OK
   export function isA2AMessage(value: unknown): value is A2AMessage {
     if (typeof value !== 'object' || value === null) return false;
     // ...
     return true;
   }
   // MAL
   export function isA2AMessage(value: unknown): value is A2AMessage {
     if (!value) throw new Error('null input');  // NUNCA
   }
   ```
3. **Constructor explícito, NO spread en builders** (CD-13, AB-WKH-55-5):
   ```ts
   // OK
   export function buildA2APayload(data: unknown): A2AMessage {
     return { role: 'agent', parts: [{ kind: 'data', data: data ?? null }] };
   }
   // MAL
   export function buildA2APayload(data: any): A2AMessage {
     return { ...defaultA2A, parts: [...defaultA2A.parts, { kind: 'data', data }] };
   }
   ```
4. **Type guards usan narrowing real** (CD-16):
   ```ts
   // OK: guard return type es `value is A2AMessage`
   export function isA2AMessage(value: unknown): value is A2AMessage { ... }
   // MAL
   export function isA2AMessage(value: any): boolean { ... }
   ```
5. **Tests con pattern `T-NN: <descripción> (AC-NN)`** en describe/it:
   ```ts
   describe('composeService.compose', () => {
     it('T-10: A2A_PASSTHROUGH bypasses maybeTransform when output is Message + target a2aCompliant (AC-1)', async () => {
       // ...
     });
   });
   ```
6. **Servicios como objeto literal** (NO clases): `composeService = { compose, invokeAgent, resolveAgent }`. Helpers como funciones top-level (`export function isA2AMessage(...)`).
7. **Mocks via `vi.mock('./path/module.js', () => ({ ... }))`** — pattern existente en compose.test.ts:26.
8. **Reusar helpers existentes**: `makeAgent`, `makeRegistry`, `mockFetchOk` ya están en `compose.test.ts`. NO duplicar.
9. **Logging via `console.error('[Compose] ...', err)` o `console.log`** — NO pino, NO logger custom (no precedente).
10. **`Agent.metadata: Record<string, unknown>`** ya existe (línea 114). Leer `a2aCompliant` via cast tipado: `nextAgent.metadata?.a2aCompliant === true`. NO agregar campo top-level a `Agent`.

---

## 6. Test Plan

### 6.1 Mapping AC → Test → archivo

| AC | Test ID | Archivo | Wave |
|----|---------|---------|------|
| AC-1 | T-10 | `src/services/compose.test.ts` (append post T-9) | W2 |
| AC-2 | T-11 | `src/services/compose.test.ts` | W2 |
| AC-3 | T-12 | `src/services/compose.test.ts` | W2 |
| AC-4 | **DEFERIDO a WKH-57** (DT-5). NO test en WKH-56. NO se valida en F4. | — | — |
| AC-5 | T-A2A-1..T-A2A-12 (12 tests del type guard) + T-A2A-13..T-A2A-16 (extract + build) = **16 tests total** | `src/services/a2a-protocol.test.ts` (NUEVO) | W0 |
| AC-6 | T-13 | `src/services/compose.test.ts` | W3 |
| AC-7 | Coverage check `npx vitest run --coverage src/services/a2a-protocol.ts` ≥ 85% (objetivo: 100%) | — | W4 (final) |
| AC-8 | T-1..T-9 baseline siguen PASS sin modificación | `src/services/compose.test.ts` | W2/W3/W4 (regression) |

### 6.2 Tests nuevos en `a2a-protocol.test.ts` (16 tests, W0)

| Test ID | Input | Expected |
|---------|-------|----------|
| T-A2A-1 | `{ role: 'agent', parts: [{ kind: 'text', text: 'hi' }] }` | `true` |
| T-A2A-2 | `{ role: 'user', parts: [{ kind: 'data', data: { x: 1 } }] }` | `true` |
| T-A2A-3 | `{ role: 'tool', parts: [{ kind: 'file', file: { uri: 'x' } }] }` | `true` |
| T-A2A-4 | `{ role: 'agent', parts: [{ kind: 'text', text: 'a' }, { kind: 'data', data: 1 }] }` (mixed) | `true` |
| T-A2A-5 | `null` | `false` |
| T-A2A-6 | `undefined` | `false` |
| T-A2A-7 | `{ role: 'admin', parts: [{ kind: 'text', text: '' }] }` (rol inválido) | `false` |
| T-A2A-8 | `{ role: 'agent', parts: [] }` (parts vacío) | `false` |
| T-A2A-9 | `{ role: 'agent' }` (sin parts) | `false` |
| T-A2A-10 | `{ role: 'agent', parts: 'not-array' }` | `false` |
| T-A2A-11 | `{ role: 'agent', parts: [{ kind: 'video', data: {} }] }` (kind inválido) | `false` |
| T-A2A-12 | `42` (primitive) | `false` |
| T-A2A-13 (extract) | `extractA2APayload({ role:'agent', parts:[{kind:'text',text:'hi'},{kind:'data',data:{x:1}}] })` | `['hi', { x: 1 }]` |
| T-A2A-14 (extract file) | `extractA2APayload({ role:'agent', parts:[{kind:'file',file:{uri:'u'}}] })` | `[{ uri: 'u' }]` |
| T-A2A-15 (build) | `buildA2APayload({ x: 1 })` | `{ role:'agent', parts:[{kind:'data', data:{x:1}}] }` |
| T-A2A-16 (build undefined) | `buildA2APayload(undefined)` | `{ role:'agent', parts:[{kind:'data', data:null}] }` |

**Estructura del archivo:**
```ts
import { describe, it, expect } from 'vitest';
import { isA2AMessage, extractA2APayload, buildA2APayload } from './a2a-protocol.js';

describe('a2a-protocol', () => {
  describe('isA2AMessage (AC-5)', () => {
    it('T-A2A-1: returns true for valid agent + text part', () => {
      expect(isA2AMessage({ role: 'agent', parts: [{ kind: 'text', text: 'hi' }] })).toBe(true);
    });
    // ... T-A2A-2..T-A2A-12
  });

  describe('extractA2APayload', () => {
    it('T-A2A-13: extracts text and data parts in order', () => {
      const msg = { role: 'agent' as const, parts: [{ kind: 'text' as const, text: 'hi' }, { kind: 'data' as const, data: { x: 1 } }] };
      expect(extractA2APayload(msg)).toEqual(['hi', { x: 1 }]);
    });
    // T-A2A-14
  });

  describe('buildA2APayload (CD-13)', () => {
    it('T-A2A-15: wraps object as data part', () => {
      expect(buildA2APayload({ x: 1 })).toEqual({ role: 'agent', parts: [{ kind: 'data', data: { x: 1 } }] });
    });
    // T-A2A-16
  });
});
```

### 6.3 Tests nuevos en `compose.test.ts` (T-10..T-13, W2 + W3)

**Mock update (líneas ~26-32, en W1):**
```ts
vi.mock('./llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',  // ← NUEVO en W1
    latencyMs: 0,
  }),
}));
```

**T-10 (AC-1, W2):** A2A_PASSTHROUGH cuando ambos son A2A
```ts
it('T-10: A2A_PASSTHROUGH bypasses maybeTransform when output is Message + target a2aCompliant (AC-1)', async () => {
  // Setup: agent1 + agent2 both with metadata.a2aCompliant = true
  // Mock fetch agent1 to return: { role: 'agent', parts: [{ kind: 'data', data: { x: 1 } }] }
  // Run composeService.compose({ steps: [agent1Step, agent2Step] })
  const transformMock = vi.mocked(maybeTransform);
  // Assertions:
  expect(transformMock).not.toHaveBeenCalled();           // CD-7: NO LLM call
  expect(result.steps[0].bridgeType).toBe('A2A_PASSTHROUGH');
  expect(result.steps[0].transformLatencyMs).toBeLessThan(5);
});
```

**T-11 (AC-2, W2):** non-A2A → maybeTransform actual
```ts
it('T-11: falls back to maybeTransform when isA2AMessage returns false (AC-2)', async () => {
  // Mock fetch agent1 to return: { result: 'plain string' }  (NOT a Message)
  // agent2.metadata.a2aCompliant = true (irrelevante porque output es non-A2A)
  // agent2.metadata.inputSchema = { ... } (para que maybeTransform se llame)
  const transformMock = vi.mocked(maybeTransform);
  expect(transformMock).toHaveBeenCalledTimes(1);
  expect(result.steps[0].bridgeType).toBe('SKIPPED');  // del mock default
});
```

**T-12 (AC-3, W2):** A2A output + non-A2A target → unwrap parts[0]
```ts
it('T-12: unwraps parts[0] when output is A2A but target is non-a2aCompliant (AC-3)', async () => {
  // Mock fetch agent1 to return: { role: 'agent', parts: [{ kind: 'data', data: { x: 1 } }] }
  // agent2.metadata.a2aCompliant = false (or absent)
  // agent2.metadata.inputSchema = { type: 'object', required: ['x'] }
  const transformMock = vi.mocked(maybeTransform);
  expect(transformMock).toHaveBeenCalledTimes(1);
  // Verificar que el 3er argumento (output) es { x: 1 } NO el wrapper completo
  const callArgs = transformMock.mock.calls[0];
  expect(callArgs[2]).toEqual({ x: 1 });
});
```

**T-13 (AC-6, W3):** event metadata.bridge_type
```ts
it('T-13: emits compose_step event with metadata.bridge_type (AC-6)', async () => {
  const trackSpy = vi.mocked(eventService.track);
  // Setup: pipeline A2A → A2A
  await composeService.compose({ steps: [...] });
  // Assert: el evento del primer step tiene bridge_type = 'A2A_PASSTHROUGH'
  expect(trackSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: 'compose_step',
      metadata: expect.objectContaining({ bridge_type: 'A2A_PASSTHROUGH' }),
    }),
  );
  // Assert: el evento del último step tiene bridge_type = null
  const lastCall = trackSpy.mock.calls[trackSpy.mock.calls.length - 1];
  expect(lastCall[0].metadata?.bridge_type).toBeNull();
});
```

### 6.4 Coverage AC-7

```bash
npx vitest run --coverage src/services/a2a-protocol.ts
```
- Line coverage ≥ 85% (objetivo: 100%, los 16 tests cubren todos los branches).
- Si vitest config no soporta `--coverage` aislado por archivo, correr suite completa con coverage y verificar el reporte para `a2a-protocol.ts`:
  ```bash
  npx vitest run --coverage
  ```

### 6.5 AC-8 zero regresión

Los 9 tests pre-existentes T-1..T-9 de `compose.test.ts` deben pasar sin modificación. Lista (verificada por SDD §3.1):
- T-1: includes Bearer auth header from registry
- T-2..T-9: (resto del baseline — ver `compose.test.ts:102-300+`)

Si alguno rompe → STOP. Diagnosticar regresión, NO ajustar el test. Reportar al architect.

---

## 7. Validation per wave (commands exactos)

```bash
# === Per wave (smoke rápido) ===
npx tsc --noEmit                                          # type check completo (siempre clean)
npx vitest run src/services/<test-file>.test.ts           # tests específicos del wave

# === Final (post-W4, antes de declarar DONE) ===
npx tsc --noEmit                                          # full type check
npx vitest run                                            # full test suite (sin filtro)
npx vitest run --coverage                                 # coverage AC-7
npm run lint                                              # si existe lint config (verificar package.json)
```

**Criterios de OK por wave:**
- `tsc --noEmit` exit 0, ningún error.
- `vitest` 100% PASS en los tests del wave.
- Tests baseline (T-1..T-9) siempre PASS (CD-2 + AC-8).

---

## 8. Final acceptance (post-W4)

Al cerrar W4, antes de reportar DONE al orquestador, verificá:

- [ ] T-1..T-9 (baseline `compose.test.ts`) — PASS sin modificación (AC-8)
- [ ] T-10, T-11, T-12, T-13 (`compose.test.ts`) — PASS (AC-1, AC-2, AC-3, AC-6)
- [ ] T-A2A-1..T-A2A-16 (`a2a-protocol.test.ts`) — PASS (AC-5)
- [ ] Tests `agent-card.test.ts` — PASS (existentes + opcional W4.3)
- [ ] Tests `transform.test.ts` — PASS (T-1..T-5)
- [ ] Coverage `a2a-protocol.ts` ≥85% (AC-7)
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` full suite verde
- [ ] AC-4 NO se implementa, NO se testea (deferido WKH-57 — DT-5)
- [ ] AC-7 verificado con coverage report
- [ ] CD-1..CD-16 respetados (revisar §1 + SDD §7)
- [ ] 4 commits exactos (W0, W1, W2, W3, W4 — uno por wave)
- [ ] Branch `feat/055-wkh-56-a2a-fast-path` con todos los commits

**Resumen al orquestador (formato sugerido):**
- Tests delta: was 9 (compose) + N (otros) = X total. Now: X + 16 (a2a-protocol) + 4 (T-10..T-13) = X + 20.
- Files created: 2 (`a2a-protocol.ts`, `a2a-protocol.test.ts`).
- Files modified: 5 (`types/index.ts`, `transform.ts`, `compose.ts`, `agent-card.ts`, `compose.test.ts`) + opcional 1 (`agent-card.test.ts`) + opcional 1 (`transform.test.ts` por CD-11).
- LOC delta estimado: ~280-350 nuevas (helpers ~80 + tests ~150 + types ~40 + compose changes ~60).
- Validation: 5 commits, tsc --noEmit clean en cada wave, full suite verde post-W4.

---

## 9. Branch creation steps (paso a paso)

```bash
# Verificá branch actual
git branch --show-current

# Si no estás en main, switch
git checkout main

# Pull latest
git pull origin main

# Verificá que estás en commit base 88010a4 o más reciente
git log -1 --oneline

# Crear branch nuevo desde main
git checkout -b feat/055-wkh-56-a2a-fast-path

# Confirmá
git branch --show-current   # debe imprimir: feat/055-wkh-56-a2a-fast-path
```

**Importante:** NO hacer push del branch hasta que el orquestador (post-DONE) lo indique. El push lo dispara `nexus-docs` después del F4 PASS.

---

## 10. Done Definition

WKH-56 está DONE para entrega a F4 (Adversarial Review) cuando:

1. Todos los items de §8 (Final acceptance) están marcados `[X]`.
2. 5 commits existen en el branch (W0, W1, W2, W3, W4) con los mensajes exactos de §3.
3. `git status` está limpio (no working changes uncommitted).
4. NO se modificaron archivos fuera del Scope IN (§1.1).
5. NO se introdujeron `any` explícitos (CD-1, CD-16).
6. NO se introdujeron `throw` en `a2a-protocol.ts` (CD-12).
7. NO se modificaron `package.json`, `tsconfig.json`, ni `.env*`.
8. Resumen al orquestador entregado con: tests delta, files changed, LOC delta, validation strategy.

**El AR (Adversarial Review) que sigue va a buscar:**
- Bugs en condicionales fast-path (AC-1 vs AC-3 vs AC-2 — boundary cases).
- Side effects en `a2a-protocol.ts` (CD-8: tree-shakeable).
- Throws olvidados (CD-12).
- Mutación de input en `extractA2APayload` (CD-15).
- `any` explícito (CD-1).
- Drift architect↔disco (CD-11): si Dev modificó tests sin grep previo.
- Regresión funcional en T-1..T-9 (AC-8).
- Cobertura <85% en `a2a-protocol.ts` (AC-7).

Si encontrás cualquiera de estos en review propio antes de entregar, fixá y re-commit en el wave correspondiente.

---

*Story File generado por NexusAgil — Architect (F2.5) — 2026-04-26 — WKH-56 — branch: feat/055-wkh-56-a2a-fast-path*
*Source SDD: doc/sdd/055-wkh-56-a2a-fast-path/sdd.md (SPEC_APPROVED)*
