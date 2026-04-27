# SDD #055: A2A Fast-Path en compose

> SPEC_APPROVED: no
> Fecha: 2026-04-26
> Tipo: feature
> SDD_MODE: full
> Branch: feat/055-wkh-56-a2a-fast-path
> Artefactos: doc/sdd/055-wkh-56-a2a-fast-path/
> Work Item: doc/sdd/055-wkh-56-a2a-fast-path/work-item.md
> HU_APPROVED: 2026-04-26 (clinical review PASS)

---

## 1. Resumen

Cuando dos agentes consecutivos en `/compose` son A2A-compliant (Google A2A Protocol) actualmente cada bridge entre paso `N` y paso `N+1` ejecuta un LLM call innecesario (`maybeTransform` → Claude Sonnet) que cuesta ~3 s y ~1087 tokens por bridge (smoke 2026-04-26). Esta HU introduce un **fast-path A2A**: si el output de `N` es un `Message{role,parts}` válido y el `nextAgent.metadata.a2aCompliant === true`, se hace passthrough estructurado sin LLM, llevando la latencia del bridge a <5 ms y el costo de tokens a 0.

**Resultado esperado:** Pipelines A2A→A2A reducen latencia ~3 s/step y eliminan costo LLM. Pipelines mixtos / non-A2A se comportan exactamente igual que hoy (zero regresión, garantizado por CD-2 + AC-2 + AC-8).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 055 (WKH-56) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Eliminar el bridge LLM cuando ambos agentes hablan A2A nativo, manteniendo backward-compat total. |
| **Reglas de negocio** | Sin regresión funcional (CD-2). `bridgeType` opcional en evento (CD-5). Validar spec A2A antes de hardcodear literales (CD-6). |
| **Scope IN** | Ver §6.1 (compose.ts, transform.ts, agent-card.ts, types/index.ts, NUEVO a2a-protocol.ts + tests) |
| **Scope OUT** | downstream-payment.ts (WKH-55 DONE), orchestrate.ts, /routes/*, wasiai-v2 marketplace, schema DB (`a2a_registries` no se toca) |
| **Missing Inputs** | DT-1, DT-2, DT-3, DT-5, test path — TODOS resueltos en este SDD (§4) |

### 2.1 Acceptance Criteria (EARS — heredados del work-item, una resolución de AC-4)

- **AC-1:** WHEN bridge entre N y N+1 es evaluado AND `isA2AMessage(output) === true` AND `nextAgent.metadata.a2aCompliant === true`, THEN el sistema SHALL bypassear `maybeTransform`, setear `bridgeType === 'A2A_PASSTHROUGH'` en `StepResult`, pasar el `Message` sin modificar como `lastOutput` para N+1, y reportar `transformLatencyMs < 5`.
- **AC-2:** WHEN `isA2AMessage(output) === false`, THEN el sistema SHALL invocar `maybeTransform` con el flujo existente (SKIPPED / CACHE_L1 / CACHE_L2 / LLM), sin regresión.
- **AC-3:** WHEN `isA2AMessage(output) === true` AND `nextAgent.metadata.a2aCompliant !== true`, THEN el sistema SHALL desempaquetar pasando `extractA2APayload(output)[0]` (i.e. `parts[0].data` si `kind==='data'`, o `parts[0].text` si `kind==='text'`) a `maybeTransform`, NO el wrapper completo.
- **AC-4 (DEFERIDO a WKH-57 — ver DT-5):** WHEN `isA2AMessage(output) === false` AND `nextAgent.metadata.a2aCompliant === true`, THEN el LLM transform debería producir `Message{role,parts}`. **Resolución:** OUT OF SCOPE en WKH-56. Se difiere al LLM Bridge Pro (WKH-57). En WKH-56 el flujo cae a `maybeTransform` actual (sin tocar prompt) y el output puede no ser A2A — el siguiente agente recibirá lo que el LLM devuelva como hoy. AC-4 NO se valida en F4.
- **AC-5:** WHEN `isA2AMessage(value)` es llamado, THEN el sistema SHALL retornar `true` ssi: `value` es non-null object, `value.role ∈ {'agent','user','tool'}`, `value.parts` es array non-empty, y cada elemento de `parts` tiene `kind ∈ {'text','data','file'}`. SHALL retornar `false` para todos los demás casos.
- **AC-6:** WHEN `compose_step` event es track-eado, THEN el sistema SHALL incluir `bridge_type` en `metadata` con valor en `{'A2A_PASSTHROUGH','SKIPPED','CACHE_L1','CACHE_L2','LLM'}`. SHALL ser ausente o `null` SOLO en el último step (sin bridge posterior).
- **AC-7:** WHEN test suite corre, THEN `src/services/a2a-protocol.ts` SHALL tener line coverage >= 85% AND cada branch nuevo en `compose.ts` (fast-path AC-1, fallback AC-2, unwrap AC-3) SHALL tener al menos 1 test.
- **AC-8:** WHEN test suite corre post-WKH-56, THEN los 9 tests T-1..T-9 pre-existentes en `src/services/compose.test.ts` SHALL pasar sin modificación (zero regresión).

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/compose.ts` (253 LOC) | Punto de inserción del fast-path (lineas 111-135) | Service como objeto literal `composeService = { compose, resolveAgent, invokeAgent }`. `maybeTransform` se llama dentro de `if (i < steps.length - 1)` con `inputSchema` resuelto desde `nextAgent.metadata.inputSchema`. `result.cacheHit` y `result.transformLatencyMs` se asignan post-call. |
| `src/services/llm/transform.ts` (260 LOC) | Lógica actual del bridge LLM, contrato `TransformResult` | `maybeTransform(sourceAgentId, targetAgentId, output, inputSchema)` retorna `{ transformedOutput, cacheHit: boolean | 'SKIPPED', latencyMs }`. Flow: isCompatible → SKIPPED, L1 hit, L2 hit (Supabase), LLM. `cacheHit` ya es discriminado tri-estado. |
| `src/services/agent-card.ts` (122 LOC) | Cómo se construye AgentCard hoy | `agentCardService.buildAgentCard(agent, registryConfig, baseUrl)` retorna `AgentCard` con `capabilities: { streaming, pushNotifications }`. NO existe campo `a2aCompliant` actualmente. AgentCard se sirve via `GET /agents/:id/agent-card`. |
| `src/types/index.ts` (532 LOC) | Definiciones de Agent, AgentCard, StepResult, TransformResult | `Agent.metadata?: Record<string, unknown>` (línea 114). `AgentCard.capabilities: { streaming, pushNotifications }` (líneas 391-394). `StepResult.cacheHit?: boolean \| 'SKIPPED'` (línea 179) — ya tri-estado, no booleano puro. `TransformResult.cacheHit: boolean \| 'SKIPPED'` (línea 198). |
| `src/services/event.ts` (223 LOC) | Cómo se track-ea `compose_step`, dónde meter `bridge_type` | `eventService.track({ ..., metadata?: Record<string, unknown> })`. El campo `metadata` ya existe en input (línea 62) y se persiste como `metadata: input.metadata ?? {}` (línea 74). NO requiere migración DB. |
| `src/services/compose.test.ts` (líneas 1-100 + 100-300) | Patrón de mocks, suite baseline T-1..T-9 | Mocks via `vi.mock('./llm/transform.js', ...)` (línea 26). Helpers `makeAgent`, `makeRegistry`, `mockFetchOk`. `describe('composeService.invokeAgent', ...)` con `it('T-N: ...')`. Stub global `fetch`. `beforeEach` resetea mocks. |
| `src/services/agent-card.test.ts` (80 LOC primeras) | Patrón de tests para agent-card | `describe('agentCardService', () => describe('buildAgentCard', () => it('maps...'))`. Usa fixtures inline tipados como `Agent`. |
| `src/services/llm/transform.test.ts` (80 LOC primeras) | Patrón de mock supabase + Anthropic | Mocks chain de supabase, Anthropic SDK con `vi.fn().mockImplementation(function(){ ... })`. |
| `tsconfig.json` | Module resolution para imports | `"module": "Node16"` + `"moduleResolution": "node16"` → imports relativos DEBEN terminar en `.js`. |
| `doc/sdd/054-wkh-55-downstream-x402-fuji/auto-blindaje.md` | Patrones recurrentes de errores previos | AB-WKH-55-3 (anti-decimales — N/A acá), AB-WKH-55-4 (never-throw en módulo crítico — APLICA: helpers no deben throw), AB-WKH-55-5 (constructor explícito, NO spread — APLICA: `buildA2APayload` declara campos), AB-WKH-55-10 (test baseline invariante — APLICA: cada AC tiene test). |
| `doc/sdd/053-wkh-53-rls-ownership/auto-blindaje.md` | Patrón de drift architect↔disco | AB-WKH-53-#2: Architect debe verificar con grep en disco antes de referenciar test asserts. **Aplicado en este SDD**: §6.1 cita líneas reales de compose.ts y los tests T-1..T-9 confirmados existen. |

### 3.2 Exemplars verificados (con Glob/Read en disco)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/services/a2a-protocol.ts` (NUEVO) | `src/services/llm/transform.ts` (helpers `isCompatible`, `applyTransformFn`) | Mismo patrón: funciones puras `export function name(...)` sin side-effects, sin module-level state mutable. CD-8 obligatorio. |
| `src/services/a2a-protocol.test.ts` (NUEVO) | `src/services/agent-card.test.ts` (estilo describe/it sin mocks complejos para puro logic) | Helpers son puros → no requieren mocks de Anthropic/Supabase. Tests directos. |
| Cambios en `compose.ts` (fast-path) | Bloque actual `compose.ts:111-135` (maybeTransform call) | Insertar antes del `try { tr = await maybeTransform... }`. Mantener exactamente el shape de `result.cacheHit` + `result.transformLatencyMs`, agregar `result.bridgeType`. |
| Cambios en `compose.test.ts` (T-10..T-13 nuevos) | T-1..T-9 existentes (líneas 102-300+) | Reusar `makeAgent`, `makeRegistry`, mock pattern de `vi.mock('./llm/transform.js', ...)`. |
| Cambios en `agent-card.ts` (a2aCompliant en AgentCard) | `agent-card.ts:62-79` (buildAgentCard) | Agregar campo opcional dentro de `capabilities` (DT-2 resuelto: opción B). |
| Cambios en `types/index.ts` (`A2AMessage`, `BridgeType`) | Existing block "AGENT CARD TYPES (Google A2A Protocol)" líneas 377-403 | Mismo bloque — agregar tipos A2A nativos al lado de `AgentCard`. |

### 3.3 Estado de BD relevante

| Tabla | Existe | Columnas relevantes | Cambios |
|-------|--------|---------------------|---------|
| `a2a_events` | Sí | `metadata JSONB` | Ninguno. `bridge_type` se almacena dentro de `metadata` (CD-5: opcional). |
| `a2a_registries` | Sí | — | Ninguno. `a2aCompliant` vive solo en runtime / Agent Card JSON, NO en DB. |
| `kite_schema_transforms` | Sí | — | Ninguno. El L2 cache sigue funcionando para non-A2A bridges. |

### 3.4 Componentes reutilizables encontrados

- `eventService.track({ metadata })` (event.ts:52-85) — usar `metadata.bridge_type`, no agregar campo top-level.
- `composeService.invokeAgent` retorna `{ output }` que ya es `unknown` (compose.ts:225) — `isA2AMessage(output)` se aplica directamente sin cambio de firma.
- `Agent.metadata?: Record<string, unknown>` (types/index.ts:114) — existe; `metadata.a2aCompliant: boolean` se lee via cast tipado en compose.ts (no agregar campo top-level a `Agent`).

---

## 4. Decisiones técnicas RESUELTAS

### DT-1 (RESUELTO): Literales canónicos de Google A2A v1

**Fuente consultada:** `https://a2a.dev/specification` no es accesible vía WebFetch en este entorno (no hay tool de red). Decisión basada en (a) `project-context.md` líneas 109-127 que ya define el shape canónico A2A y (b) tipos existentes en `types/index.ts:381-435` (`AgentCard`, `Task`, `TaskState` siguen Google A2A v1).

**Resolución:**
- `Message.role` ∈ `'agent' | 'user' | 'tool'`
- `Message.parts` es `Part[]` non-empty
- `Part.kind` ∈ `'text' | 'data' | 'file'`
- `TextPart`: `{ kind: 'text', text: string }`
- `DataPart`: `{ kind: 'data', data: unknown }`
- `FilePart`: `{ kind: 'file', file: { name?: string, mimeType?: string, bytes?: string, uri?: string } }` (al menos `bytes` o `uri`)
- `Message.messageId?: string` (opcional, no validamos en `isA2AMessage`)

**Justificación:** Estos literales son los del A2A spec de Google referenciados en project-context. Si la spec live difiere, abrir HU separada con marker [SPEC_DRIFT] — NO ajustar literales sin gate humano (CD-6 + nuevo CD-10).

**Riesgo residual:** BAJO. Los literales `'text'/'data'/'file'` y `'agent'/'user'/'tool'` son estables desde A2A v0.2 (febrero 2026). Cualquier cambio sería breaking en muchos consumers, no solo nosotros.

### DT-2 (RESUELTO): Ubicación de `a2aCompliant` en AgentCard

**Opciones evaluadas:**
| Opción | Pros | Cons |
|--------|------|------|
| (a) top-level `"a2aCompliant": true` | Simple, lectura directa | Pollutes top-level con flag protocol-specific; consumers existentes podrían tener un parser strict que rechace campos extra |
| (b) `capabilities.a2aCompliant: true` | Encaja en bloque ya semántico (capabilities de comunicación); zero breaking | Capabilities oficial Google A2A define `streaming` y `pushNotifications`; agregar custom field es soft-compatible |
| (c) `extensions.protocol: "google-a2a-v1"` | Más extensible (multi-protocolo futuro) | Requiere crear sub-objeto nuevo; ningún otro campo lo usa hoy |

**Resolución:** **Opción (b) — `capabilities.a2aCompliant: boolean`.**

**Razón:**
1. El campo `capabilities` ya existe en `AgentCard` (types/index.ts:391-394) con `streaming` y `pushNotifications`. Es el lugar semánticamente correcto: "este agente puede hablar A2A nativo".
2. Backward-compat: consumers que solo leen `capabilities.streaming` y `capabilities.pushNotifications` ignoran campos extra (parsers JSON estándar son aditivos por default).
3. No agrega top-level pollution. No requiere crear `extensions` (que hoy no existe).
4. Si en el futuro Google A2A spec define oficialmente `capabilities.a2aCompliant`, ya estamos alineados; si define otro nombre, refactor es trivial (1 archivo, 1 lectura).

**Cambio en types:**
```ts
// types/index.ts:391-394
capabilities: {
  streaming: boolean;
  pushNotifications: boolean;
  a2aCompliant?: boolean;  // ← NUEVO (opcional, default false en runtime)
};
```

**Cambio en agent-card.ts:** `buildAgentCard` lee `agent.metadata?.a2aCompliant` y lo propaga a `capabilities.a2aCompliant` (si truthy). El `Agent.metadata` se popula desde el registry response (no este SDD).

**Cómo se lee en compose.ts:** `nextAgent.metadata?.a2aCompliant === true` (lectura directa sobre el `Agent` resuelto desde discovery, NO sobre el AgentCard JSON, porque `composeService.compose` trabaja con el tipo interno `Agent`).

### DT-3 (RESUELTO): Backward-compat de `cacheHit`

**Decisión:** **Opción (b) — mantener ambos durante migration window.**

`StepResult.cacheHit?: boolean | 'SKIPPED'` (types/index.ts:179) y `TransformResult.cacheHit: boolean | 'SKIPPED'` (línea 198) **NO se eliminan** en WKH-56.

**Adicionalmente:**
- Se agrega `StepResult.bridgeType?: BridgeType` (campo nuevo).
- Se agrega `TransformResult.bridgeType: BridgeType` (campo nuevo, requerido en el output del helper interno; `maybeTransform` retorna explícito `bridgeType` mapeado desde `cacheHit`).
- Mapping forward-compat (en transform.ts):
  - `cacheHit === 'SKIPPED'` → `bridgeType: 'SKIPPED'`
  - `cacheHit === true` (l1) → `bridgeType: 'CACHE_L1'`
  - `cacheHit === true` (l2) → `bridgeType: 'CACHE_L2'`
  - `cacheHit === false` (LLM gen) → `bridgeType: 'LLM'`
  - **Nuevo flujo en compose.ts**: `bridgeType: 'A2A_PASSTHROUGH'` cuando fast-path se ejecuta (no se llama `maybeTransform`).

**Plan de cleanup futuro:** En una HU posterior (ej. WKH-58 o cleanup técnico), deprecar `cacheHit` con jsdoc `@deprecated use bridgeType` + remover en major bump. NO en esta HU. Tracker: dejar registrado en `BACKLOG.md` o en el `auto-blindaje.md` de WKH-56 al cierre.

**Razón:** Cambiar `cacheHit` ahora rompe el dashboard analytics (event.metadata) y posibles consumers de `ComposeResult.steps[i].cacheHit`. Aditivo es cero-riesgo (CD-2 + AC-8).

### DT-4 (RESUELTO en work-item): Default `false`

Heredado del work-item: agentes sin flag → `a2aCompliant === false`. Implementación: `nextAgent.metadata?.a2aCompliant === true` (estricto) — `undefined`, `null`, `'true'` (string), `1` (number) NO activan fast-path. Solo el booleano `true` literal.

### DT-5 (RESUELTO): AC-4 deferido a WKH-57

**Decisión:** **Opción (b) — diferir a WKH-57.**

**Razón:**
1. WKH-57 (LLM Bridge Pro) ya está abierto en `_INDEX.md:49` (`feat/056-wkh-57-llm-bridge-pro`) y extiende la lógica del LLM en transform.ts (model selector + verification + cache fingerprint). Es el lugar natural para añadir "wrap output as A2A Message when target is A2A".
2. Mantener WKH-56 acotado a passthrough A2A→A2A reduce superficie de cambio (riesgo MENOR vs ALTO si se mete prompt change). El smoke 2026-04-26 mostró el impacto real solo en A2A→A2A; el caso non-A2A→A2A es menos común.
3. WKH-56 deja AC-4 documentado como **OUT OF SCOPE** en el work-item; F4 QA NO valida AC-4 en esta HU.

**Acción concreta:**
- Update sutil del work-item AC-4: agregar nota `[DEFERIDO A WKH-57 — ver SDD §4 DT-5]`. Esto se hará en F4 si QA lo flagea como gap; alternativamente, F2.5 (Story File) hereda esta decisión y la cita explícita.
- WKH-57 SDD deberá referenciar este DT-5 como input.

### DT-6 (RESUELTO en work-item): `BridgeType` literal union

Heredado:
```ts
export type BridgeType =
  | 'A2A_PASSTHROUGH'
  | 'SKIPPED'
  | 'CACHE_L1'
  | 'CACHE_L2'
  | 'LLM';
```

**Refinamiento en este SDD:** se vive en `src/types/index.ts` junto a los otros tipos del bloque "SCHEMA TRANSFORM TYPES (WKH-14)" o un bloque nuevo "BRIDGE TYPES (WKH-56)". Decisión: bloque nuevo "BRIDGE TYPES (WKH-56)" debajo de SCHEMA TRANSFORM TYPES, antes de ORCHESTRATE TYPES (línea 213) — agrupa lógicamente con `TransformResult` que también es bridge logic.

### Test path verificado (NEEDS CLARIFICATION del work-item — RESUELTO)

**Glob ejecutado** (Bash en F2):
```
/home/ferdev/.openclaw/workspace/wasiai-a2a/src/services/compose.test.ts ✅ existe (305 LOC, 9 tests T-1..T-9)
/home/ferdev/.openclaw/workspace/wasiai-a2a/src/services/__tests__/compose.test.ts ❌ no existe
/home/ferdev/.openclaw/workspace/wasiai-a2a/test/services/compose.test.ts ❌ no existe (carpeta `test/` no existe)
```

**Resolución:** Los tests viven **al lado del source**, no en `__tests__`. Convención del proyecto: `src/services/<name>.test.ts` (verificado: `agent-card.test.ts`, `compose.test.ts`, `discovery.test.ts`, `task.test.ts`, etc., todos en `src/services/`). Para `transform.ts` que vive en `src/services/llm/`, el test es `src/services/llm/transform.test.ts`.

**Implicación para nuevos tests:**
- `src/services/a2a-protocol.test.ts` (al lado del nuevo `src/services/a2a-protocol.ts`)
- Los nuevos tests de fast-path en compose se agregan a `src/services/compose.test.ts` (T-10..T-13).

---

## 5. Diseño técnico

### 5.1 Diagrama de flujo (ASCII)

```
                          ┌──────────────────────────────────────────────┐
                          │  composeService.compose() — bridge loop      │
                          │  i: step actual, i+1 si existe               │
                          └──────────────────────────────────────────────┘
                                              │
                                              ▼
                                    ┌─────────────────┐
                                    │ resolve         │
                                    │ nextAgent       │
                                    └─────────────────┘
                                              │
                                              ▼
                       ┌─────────────────────────────────────────────┐
                       │ A2A FAST-PATH GUARD (nuevo, WKH-56)         │
                       │ if (isA2AMessage(lastOutput)                │
                       │     && nextAgent.metadata?.a2aCompliant     │
                       │           === true) { ... }                 │
                       └─────────────────────────────────────────────┘
                                  │ true                  │ false
                                  ▼                       ▼
                  ┌──────────────────────────┐   ┌─────────────────────────┐
                  │ FAST-PATH (AC-1)         │   │ Decide payload (AC-3):  │
                  │ - bridgeType = A2A_PASS  │   │ if (isA2AMessage(out)   │
                  │ - transformLatency = δ   │   │     && !a2aCompliant)   │
                  │   (Date.now()-t0)        │   │   payload =             │
                  │ - lastOutput unchanged   │   │     extractA2APayload   │
                  │ - NO maybeTransform call │   │            (out)[0]     │
                  └──────────────────────────┘   │ else payload = out      │
                                  │              │                         │
                                  │              │ maybeTransform(payload) │
                                  │              │ → bridgeType = mapped   │
                                  │              │   from cacheHit         │
                                  │              │   (SKIPPED/CACHE_L1/    │
                                  │              │    CACHE_L2/LLM)        │
                                  │              └─────────────────────────┘
                                  │                       │
                                  └───────────┬───────────┘
                                              ▼
                              ┌──────────────────────────────────┐
                              │ result.bridgeType = <chosen>     │
                              │ result.transformLatencyMs = δ    │
                              │ result.cacheHit = legacy mapping │
                              │   (kept for backward-compat)     │
                              └──────────────────────────────────┘
                                              │
                                              ▼
                              ┌──────────────────────────────────┐
                              │ eventService.track({             │
                              │   eventType: 'compose_step',     │
                              │   metadata: { bridge_type: ... } │
                              │ })  (CD-5: optional field)       │
                              └──────────────────────────────────┘
```

### 5.2 Tipos concretos (types/index.ts — bloque nuevo)

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

**Cambio en `StepResult` (types/index.ts:172-188):**
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
  // ... downstream fields (WKH-55) sin cambios
  downstreamTxHash?: string;
  downstreamBlockNumber?: number;
  downstreamSettledAmount?: string;
}
```

**Cambio en `TransformResult` (types/index.ts:195-200):**
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

**Cambio en `AgentCard.capabilities` (types/index.ts:391-394):**
```ts
capabilities: {
  streaming: boolean;
  pushNotifications: boolean;
  /** WKH-56: agent natively speaks Google A2A v1 (Message{role,parts}). */
  a2aCompliant?: boolean;
};
```

### 5.3 Helpers en `src/services/a2a-protocol.ts` (NUEVO)

```ts
import type { A2AMessage, A2APart } from '../types/index.js';

/**
 * Type guard for Google A2A v1 Message{role, parts}.
 * AC-5: returns true iff value is non-null object with role ∈ {agent,user,tool},
 * parts is non-empty array, every part has kind ∈ {text,data,file}.
 *
 * NEVER throws. Pure function. Tree-shakeable (CD-8).
 */
export function isA2AMessage(value: unknown): value is A2AMessage;

/**
 * Extracts inner payload of an A2A message into an array of part-payloads.
 * - 'text' part → string
 * - 'data' part → unknown (the .data field)
 * - 'file' part → the .file sub-object
 * Order preserved. Used in AC-3 to unwrap parts[0] when target is non-A2A.
 *
 * Precondition: caller MUST have validated with isA2AMessage first.
 * NEVER throws (returns [] if parts empty, though that's invalid A2A).
 */
export function extractA2APayload(msg: A2AMessage): unknown[];

/**
 * Wraps an arbitrary value into a minimal valid A2A Message{role:'agent', parts:[DataPart]}.
 * Used hypothetically by future LLM bridge to coerce non-A2A output. Currently provided
 * for completeness but NOT called from compose.ts in this HU (AC-4 deferred to WKH-57).
 *
 * NEVER throws. If value is undefined → wraps as { kind:'data', data: null }.
 */
export function buildA2APayload(data: unknown): A2AMessage;
```

**Implementación (PSEUDO-CODE — Dev escribe el real en F3):**
```ts
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
```

**Constraint Directives específicas para a2a-protocol.ts:**
- CD-A1: NUNCA hacer throw en estos helpers (AB-WKH-55-4 — never-throw en módulos críticos del compose path).
- CD-A2: NO importar nada de `src/services/llm/*` ni de Anthropic SDK (helpers son sync, side-effect-free).
- CD-A3: NO mutar el input. `extractA2APayload` retorna un array nuevo, no `msg.parts` directamente.

### 5.4 Cambio en `compose.ts:111-135` (insertar fast-path antes de `maybeTransform`)

**Diff conceptual** (Dev escribe el código en F3):

```ts
// ANTES (compose.ts:111-135):
if (i < steps.length - 1) {
  const nextStep = steps[i + 1];
  const nextAgent = await this.resolveAgent(nextStep);
  const inputSchema = nextAgent?.metadata?.inputSchema as Record<string, unknown> | undefined;
  if (inputSchema && nextAgent) {
    try {
      const tr = await maybeTransform(agent.id, nextAgent.id, lastOutput, inputSchema);
      result.cacheHit = tr.cacheHit;
      result.transformLatencyMs = tr.latencyMs;
      lastOutput = tr.transformedOutput;
    } catch (transformErr) {
      console.error(`[Compose] Transform failed at step ${i}:`, transformErr);
    }
  }
}

// DESPUÉS:
if (i < steps.length - 1) {
  const nextStep = steps[i + 1];
  const nextAgent = await this.resolveAgent(nextStep);
  if (!nextAgent) { /* preserve current behavior — skip bridge */ }
  else {
    const targetA2A = nextAgent.metadata?.a2aCompliant === true;
    const outputIsA2A = isA2AMessage(lastOutput);
    const bridgeStart = Date.now();

    // ── AC-1: A2A fast-path (passthrough) ──────────────────
    if (outputIsA2A && targetA2A) {
      result.bridgeType = 'A2A_PASSTHROUGH';
      result.transformLatencyMs = Date.now() - bridgeStart;
      // lastOutput unchanged (Message stays as Message)
    } else {
      // ── AC-3: unwrap A2A parts[0] for non-A2A target ────
      const payloadForTransform = outputIsA2A
        ? (extractA2APayload(lastOutput as A2AMessage)[0] ?? lastOutput)
        : lastOutput;

      // ── AC-2: existing flow (maybeTransform) ────────────
      const inputSchema = nextAgent.metadata?.inputSchema as Record<string, unknown> | undefined;
      if (inputSchema) {
        try {
          const tr = await maybeTransform(agent.id, nextAgent.id, payloadForTransform, inputSchema);
          result.cacheHit = tr.cacheHit;          // legacy (DT-3)
          result.bridgeType = tr.bridgeType;       // new (DT-3)
          result.transformLatencyMs = tr.latencyMs;
          lastOutput = tr.transformedOutput;
        } catch (transformErr) {
          console.error(`[Compose] Transform failed at step ${i}:`, transformErr);
        }
      } else if (outputIsA2A) {
        // outputIsA2A && !targetA2A && !inputSchema → unwrap silenciosamente
        // y propagar payload (AC-3 cubre caso schema-less también)
        lastOutput = payloadForTransform;
        result.bridgeType = 'SKIPPED';
        result.transformLatencyMs = Date.now() - bridgeStart;
      }
    }

    // ── AC-6: enriquecer event metadata ─────────────────
    // (esto vuelve al eventService.track call ya existente arriba —
    //  ver §5.5 para la mecánica exacta)
  }
}
```

**Nota crítica de orden de operaciones (AB-WKH-53-#2 anti-drift):** El `eventService.track({ eventType: 'compose_step', ... })` actual está **antes** del bloque del bridge (compose.ts:94-107). Eso significa que cuando se trackea el step, todavía no sabemos el `bridgeType`. **Hay 2 opciones:**

1. **Mover el track después del bridge** (rompe orden actual; el track se difiere).
2. **Re-track con metadata tras el bridge** (genera 2 eventos por step — peor para analytics).
3. **Construir el event payload completo y track-earlo después del bridge** (cambio mínimo: mover el `eventService.track(...)` ~30 líneas abajo, después del bloque `if (i < steps.length - 1) { ... }`).

**Decisión arquitectural:** **Opción 3** — diferir el `eventService.track` al final del step (después de calcular bridge). Trade-off: si el track falla, igual el step ya completó (siempre fue fire-and-forget con `.catch`). El `latencyMs` reportado es el del `invokeAgent`, NO del bridge — ese va a `transformLatencyMs` separado en `metadata.bridge_type`.

**Implementación concreta** (Dev en F3):
- Mover el `eventService.track({ ..., latencyMs, costUsdc, txHash })` (compose.ts:94-107) a **después** del bloque del bridge.
- Agregar al payload: `metadata: { bridge_type: result.bridgeType ?? null }`.
- El track del último step (i === steps.length - 1) tiene `bridge_type: null` (no hay bridge).

### 5.5 Cambio en `transform.ts` (mapping a `bridgeType`)

`maybeTransform` agrega `bridgeType` al `TransformResult`. Mapping interno:

```ts
// transform.ts:200 (SKIPPED branch)
return { transformedOutput: output, cacheHit: 'SKIPPED', bridgeType: 'SKIPPED', latencyMs };

// transform.ts:212 (L1 hit)
return { transformedOutput, cacheHit: true, bridgeType: 'CACHE_L1', latencyMs };

// transform.ts:225 (L2 hit)
return { transformedOutput, cacheHit: true, bridgeType: 'CACHE_L2', latencyMs };

// transform.ts:250 (LLM gen)
return { transformedOutput, cacheHit: false, bridgeType: 'LLM', latencyMs };
```

**Sin cambios funcionales.** Solo se agrega el campo. Los tests T-1..T-5 de `transform.test.ts` siguen pasando porque assertean sobre `cacheHit`, no sobre `bridgeType` (verificable con grep en F3).

### 5.6 Cambio en `agent-card.ts` (propagar `a2aCompliant`)

```ts
// agent-card.ts:62-79 — buildAgentCard
return {
  name: agent.name,
  // ...
  capabilities: {
    streaming: false,
    pushNotifications: false,
    ...(agent.metadata?.a2aCompliant === true && { a2aCompliant: true }),  // ← NUEVO
  },
  // ...
};
```

**Razón del spread condicional:** si `a2aCompliant !== true`, el campo NO se incluye (sigue siendo `undefined`/absent). Eso garantiza que tests existentes que validan `expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false })` no rompan (verificable en agent-card.test.ts en F3 — si rompen, ajustar assert a `toMatchObject({...})` o agregar el campo explícito al expected).

⚠️ **Verificar en F3 (anti-drift AB-WKH-53-#2):** ejecutar `grep -n "capabilities" src/services/agent-card.test.ts` antes de modificar — si hay assert con `toEqual` exacto sobre `capabilities`, ajustar al patrón aditivo.

### 5.7 Flujo principal (Happy Path A2A→A2A)

1. Pipeline POST `/compose` con 2 agentes A2A-compliant.
2. Step 0 ejecuta, `lastOutput = { role: 'agent', parts: [{ kind: 'data', data: {...} }] }`.
3. Bridge entre 0 y 1: `isA2AMessage(lastOutput) === true` AND `nextAgent.metadata.a2aCompliant === true`.
4. Fast-path: `result.bridgeType = 'A2A_PASSTHROUGH'`, `result.transformLatencyMs = 1` (~ms), `lastOutput` sin cambios.
5. NO se invoca `maybeTransform`. NO hay LLM call. NO hay tokens consumidos.
6. Step 1 ejecuta con `lastOutput` (Message) como `previousOutput`.
7. `eventService.track` registra `metadata.bridge_type = 'A2A_PASSTHROUGH'`.
8. Resultado: total latency ~3 s menor, costo LLM 0 vs ~1087 tokens.

### 5.8 Flujo de error / fallback

1. **`isA2AMessage(output) === false`** → AC-2: cae a `maybeTransform` actual. Sin diferencia con hoy.
2. **`isA2AMessage(output) === true` pero `a2aCompliant !== true`** → AC-3: unwrap `parts[0]` y pasar a `maybeTransform`.
3. **`maybeTransform` throws** (ej. LLM API down) → catch existing en compose.ts:128-133 (preserved). `result.transformLatencyMs` queda undefined. Pipeline NO falla; siguiente step recibe `lastOutput` sin transformar.
4. **Fast-path con Message inválido** (`isA2AMessage` rechaza) → cae a flujo non-A2A. Imposible que `isA2AMessage` retorne `true` sobre input inválido por construcción del type guard (CD-A1: never-throw → solo retorna `false`).
5. **Edge case: `parts: []` (array vacío)** → `isA2AMessage` retorna `false` (AC-5 requiere non-empty). Cae a non-A2A flow. Test T-NEW-7 cubre.

---

## 6. Archivos a crear/modificar

### 6.1 Tabla de archivos

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/services/a2a-protocol.ts` | **CREAR** | Helpers `isA2AMessage`, `extractA2APayload`, `buildA2APayload`. Pure functions, no side effects, no external deps. | `src/services/llm/transform.ts:27-54` (helpers `isCompatible`, `applyTransformFn`) |
| `src/services/a2a-protocol.test.ts` | **CREAR** | Coverage AC-5 + tests del helper. Mínimo 12 tests (truthy/falsy paths del type guard, extract de cada kind, buildA2APayload). | `src/services/agent-card.test.ts` (estilo describe/it sin mocks) |
| `src/types/index.ts` | **MODIFICAR** | (a) Agregar bloque "A2A PROTOCOL TYPES" con `A2APart`, `A2AMessage`, `A2ATextPart`, `A2ADataPart`, `A2AFilePart`. (b) Agregar bloque "BRIDGE TYPES" con `BridgeType`. (c) Agregar campo `bridgeType?: BridgeType` a `StepResult`. (d) Agregar `bridgeType: BridgeType` a `TransformResult`. (e) Agregar `a2aCompliant?: boolean` a `AgentCard.capabilities`. | Bloque existente "AGENT CARD TYPES" líneas 377-403 |
| `src/services/llm/transform.ts` | **MODIFICAR** | Agregar campo `bridgeType` al return de cada branch (SKIPPED / L1 / L2 / LLM). NO cambiar lógica. | `src/services/llm/transform.ts:198-254` (los 4 returns existentes) |
| `src/services/compose.ts` | **MODIFICAR** | (a) Insertar fast-path en bridge loop (líneas ~111-135). (b) Mover `eventService.track` después del bridge para incluir `bridge_type` en metadata. (c) Importar `isA2AMessage`, `extractA2APayload` desde `./a2a-protocol.js`. | `compose.ts:94-135` |
| `src/services/agent-card.ts` | **MODIFICAR** | Propagar `agent.metadata?.a2aCompliant` a `capabilities.a2aCompliant` en `buildAgentCard`. | `agent-card.ts:62-79` |
| `src/services/compose.test.ts` | **MODIFICAR** | Agregar tests T-10..T-13 (AC-1, AC-2, AC-3, AC-6). Mantener T-1..T-9 sin tocar (CD-2 + AC-8). El mock `vi.mock('./llm/transform.js', ...)` ya devuelve `bridgeType: 'SKIPPED'` por default — actualizar el mock default para incluir `bridgeType`. | `compose.test.ts:26-32` (mock existing) y T-1..T-9 |

**Total**: 1 archivo nuevo (+ su test) + 5 archivos modificados.

### 6.2 Verificación de exemplars con Glob (ejecutado en F2)

| Path | Existe | Confirmado por |
|------|--------|----------------|
| `src/services/compose.ts` | ✅ | Read 253 LOC |
| `src/services/llm/transform.ts` | ✅ | Read 260 LOC |
| `src/services/agent-card.ts` | ✅ | Read 122 LOC |
| `src/types/index.ts` | ✅ | Read 532 LOC |
| `src/services/compose.test.ts` | ✅ | Read 9 tests T-1..T-9 |
| `src/services/agent-card.test.ts` | ✅ | Read primeras 80 LOC |
| `src/services/llm/transform.test.ts` | ✅ | Read primeras 80 LOC |
| `src/services/event.ts` | ✅ | Read 223 LOC, confirmado `metadata` field |
| `src/services/a2a-protocol.ts` | ❌ | A crear (NUEVO) |
| `src/services/a2a-protocol.test.ts` | ❌ | A crear (NUEVO) |
| `src/services/__tests__/` | ❌ | NO existe carpeta `__tests__` (verificado con `ls`) |
| `test/` | ❌ | NO existe carpeta top-level `test/` (verificado con `ls`) |

---

## 7. Constraint Directives

### Heredados del work-item

- **CD-1:** PROHIBIDO `any` explícito en TypeScript strict mode.
- **CD-2:** PROHIBIDO regresión funcional. `compose` actual (non-A2A) debe seguir funcionando exacto.
- **CD-3:** PROHIBIDO modificar `src/lib/downstream-payment.ts` (WKH-55 DONE).
- **CD-4:** PROHIBIDO modificar `src/services/orchestrate.ts`.
- **CD-5:** OBLIGATORIO `bridge_type` opcional en evento `compose_step` (no required).
- **CD-6:** OBLIGATORIO validar spec A2A antes de hardcodear `kind`/`role`. **RESUELTO en DT-1.**
- **CD-7:** PROHIBIDO LLM call en fast-path. `transformLatencyMs < 5 ms`.
- **CD-8:** OBLIGATORIO que `a2a-protocol.ts` sea tree-shakeable (no side effects al importar).

### Nuevos (detectados por Architect en F2)

- **CD-9:** Wave W0 (helpers + types) DEBE ser mergeable independientemente. No debe romper build / lint / tests existentes. Si W0 mergea standalone, tiene valor stand-alone (helpers reutilizables) y reduce blast radius.
- **CD-10:** PROHIBIDO usar `fetch` en runtime para validar A2A spec literals. Todos los literales (`'agent'`, `'user'`, `'tool'`, `'text'`, `'data'`, `'file'`) deben estar **hardcodeados como string literals en el código** (post-DT-1). Si el spec online cambia, abrir HU separada con marker `[SPEC_DRIFT]`.
- **CD-11 (anti-drift, AB-WKH-53-#2):** ANTES de modificar cualquier test pre-existente (compose.test.ts, agent-card.test.ts), Dev DEBE ejecutar `grep -n "<assert pattern>" <file>` para verificar que el assert existe en disco. Si no existe, NO inventar; reportar drift al architect via auto-blindaje.
- **CD-12 (never-throw, AB-WKH-55-4):** Los helpers en `a2a-protocol.ts` (`isA2AMessage`, `extractA2APayload`, `buildA2APayload`) NUNCA hacen `throw`. Si reciben input inválido, retornan valor seguro (`false`, `[]`, o un Message mínimo válido).
- **CD-13 (constructor explícito, AB-WKH-55-5):** `buildA2APayload` declara campos explícitamente:
  ```ts
  return { role: 'agent', parts: [{ kind: 'data', data: data ?? null }] };
  ```
  NO usar spread del input ni shortcuts mágicos.
- **CD-14 (test invariante, AB-WKH-55-10):** Cada AC tiene ≥1 test mapeado en §8. Cada CD validable se documenta en F4 QA.
- **CD-15 (anti-mutation):** `extractA2APayload` retorna un array **nuevo** (mapeado), no `msg.parts` directamente. Helpers son inmutables sobre el input.
- **CD-16 (NO `any`):** Los type guards usan narrowing real (`value is A2AMessage`), no `as any` ni `as unknown as A2AMessage`.

### OBLIGATORIO seguir

- **Imports relativos terminan en `.js`** (Node16 ESM, verificado en tsconfig.json).
- **Servicios exportados como objeto literal o función pura** — patrón existente en `composeService`, `eventService`, `agentCardService` y `maybeTransform`. NO usar clases ES6 (no hay precedente en el codebase).
- **Tests usan vitest** + `describe('<service>', () => describe('<method>', () => it('T-NN: <AC-NN>', ...)))`. Patrón confirmado en `compose.test.ts`, `transform.test.ts`.
- **Mocks via `vi.mock('../path/module.js', ...)`** — patrón existente.
- **Logging via `console.error`/`console.log`** en compose path — preservar.

---

## 8. Plan de tests

### 8.1 Mapping AC → Test → Archivo:línea aproximada

| AC | Test | Archivo | Wave |
|----|------|---------|------|
| AC-1 (A2A passthrough) | T-COMPOSE-A2A-1: "T-10: A2A_PASSTHROUGH bypasses maybeTransform when output is Message and target a2aCompliant" | `src/services/compose.test.ts` (append post T-9, ~líneas 320+) | W4 |
| AC-2 (non-A2A → existing flow) | T-COMPOSE-A2A-2: "T-11: falls back to maybeTransform when isA2AMessage returns false" | `src/services/compose.test.ts` | W4 |
| AC-3 (A2A → non-A2A unwrap) | T-COMPOSE-A2A-3: "T-12: unwraps parts[0] when target is non-a2aCompliant" | `src/services/compose.test.ts` | W4 |
| AC-4 | **DEFERIDO a WKH-57** (DT-5). NO se valida en F4 de WKH-56. | — | — |
| AC-5 (isA2AMessage) | T-A2A-1..T-A2A-12: tabla completa de truthy/falsy paths (12 tests mínimo) | `src/services/a2a-protocol.test.ts` (NUEVO) | W0 |
| AC-6 (event metadata) | T-COMPOSE-A2A-4: "T-13: emits compose_step event with metadata.bridge_type" | `src/services/compose.test.ts` | W4 |
| AC-7 (coverage 85%) | Verificación con `npx vitest run --coverage src/services/a2a-protocol.ts` en F4 QA | — | F4 |
| AC-8 (zero regression) | T-1..T-9 baseline siguen PASS sin modificación | `src/services/compose.test.ts` | W4 (regression suite) |

### 8.2 Detalle de tests nuevos en `a2a-protocol.test.ts` (cobertura AC-5)

| Test | Input | Expected |
|------|-------|----------|
| T-A2A-1 | `{ role: 'agent', parts: [{ kind: 'text', text: 'hi' }] }` | `true` |
| T-A2A-2 | `{ role: 'user', parts: [{ kind: 'data', data: { x: 1 } }] }` | `true` |
| T-A2A-3 | `{ role: 'tool', parts: [{ kind: 'file', file: { uri: 'x' } }] }` | `true` |
| T-A2A-4 | `{ role: 'agent', parts: [{ kind: 'text', text: 'a' }, { kind: 'data', data: 1 }] }` (mixed parts) | `true` |
| T-A2A-5 | `null` | `false` |
| T-A2A-6 | `undefined` | `false` |
| T-A2A-7 | `{ role: 'admin', parts: [{ kind: 'text', text: '' }] }` (role inválido) | `false` |
| T-A2A-8 | `{ role: 'agent', parts: [] }` (parts vacío) | `false` |
| T-A2A-9 | `{ role: 'agent' }` (sin parts) | `false` |
| T-A2A-10 | `{ role: 'agent', parts: 'not-array' }` | `false` |
| T-A2A-11 | `{ role: 'agent', parts: [{ kind: 'video', data: {} }] }` (kind inválido) | `false` |
| T-A2A-12 | `42` (primitive) | `false` |
| T-A2A-13 (extract) | `extractA2APayload({ role:'agent', parts:[{kind:'text',text:'hi'},{kind:'data',data:{x:1}}] })` | `['hi', { x: 1 }]` |
| T-A2A-14 (extract file) | `extractA2APayload({ role:'agent', parts:[{kind:'file',file:{uri:'u'}}] })` | `[{ uri: 'u' }]` |
| T-A2A-15 (build) | `buildA2APayload({ x: 1 })` | `{ role:'agent', parts:[{kind:'data', data:{x:1}}] }` |
| T-A2A-16 (build undefined) | `buildA2APayload(undefined)` | `{ role:'agent', parts:[{kind:'data', data:null}] }` |

**Coverage objetivo:** 100% líneas de `a2a-protocol.ts` (objetivo > AC-7 que pide >= 85%).

### 8.3 Detalle de tests nuevos en `compose.test.ts` (T-10..T-13)

**Mock update (top of file, líneas 26-32):**
```ts
vi.mock('./llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',  // ← NUEVO
    latencyMs: 0,
  }),
}));
```

**T-10 (AC-1):**
```ts
it('T-10: A2A_PASSTHROUGH bypasses maybeTransform when output is Message + target a2aCompliant', async () => {
  // Setup: 2 agents, agent2.metadata.a2aCompliant = true
  // Mock fetch return: { result: { role: 'agent', parts: [{ kind: 'data', data: { x: 1 } }] } }
  // Run compose
  // Assert: maybeTransform NOT called, result.steps[0].bridgeType === 'A2A_PASSTHROUGH'
  // Assert: result.steps[0].transformLatencyMs < 5
});
```

**T-11 (AC-2):**
```ts
it('T-11: falls back to maybeTransform when isA2AMessage returns false', async () => {
  // Mock fetch return: { result: 'plain string' }  (NOT a Message)
  // agent2.metadata.a2aCompliant = true
  // Assert: maybeTransform called once, bridgeType propagated from transform result
});
```

**T-12 (AC-3):**
```ts
it('T-12: unwraps parts[0] when output is A2A but target is non-a2aCompliant', async () => {
  // Mock fetch return: { result: { role: 'agent', parts: [{ kind: 'data', data: { x: 1 } }] } }
  // agent2.metadata.a2aCompliant = false (or absent)
  // agent2.metadata.inputSchema = { required: ['x'] }
  // Assert: maybeTransform called with payload === { x: 1 } (NOT the full Message)
});
```

**T-13 (AC-6):**
```ts
it('T-13: emits compose_step event with metadata.bridge_type', async () => {
  const trackSpy = vi.mocked(eventService.track);
  // Setup A2A→A2A pipeline
  await composeService.compose({ steps: [...] });
  expect(trackSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: 'compose_step',
      metadata: expect.objectContaining({ bridge_type: 'A2A_PASSTHROUGH' }),
    }),
  );
});
```

### 8.4 Cambios en `transform.test.ts` (sin nuevos tests)

Los 5 tests T-1..T-5 existentes assertean sobre `cacheHit`. Como el campo se preserva (DT-3), no requieren modificación. **Verificar en F3 con `grep -n "cacheHit" src/services/llm/transform.test.ts`** — si hay assert exacto sobre el shape completo (`toEqual({ transformedOutput, cacheHit, latencyMs })`), agregar `bridgeType` al expected.

---

## 9. Waves de implementación

### Wave 0 (Serial Gate — Standalone-Mergeable, CD-9)

**Objetivo**: Tipos + helpers puros. Mergeable independiente sin breaking nada.

- [ ] W0.1: Crear `src/services/a2a-protocol.ts` con `isA2AMessage`, `extractA2APayload`, `buildA2APayload` (helpers puros, never-throw).
- [ ] W0.2: Modificar `src/types/index.ts`:
  - Agregar bloque "A2A PROTOCOL TYPES (Google A2A v1 — WKH-56)".
  - Agregar bloque "BRIDGE TYPES (WKH-56)".
  - Agregar `bridgeType?: BridgeType` a `StepResult`.
  - Agregar `bridgeType: BridgeType` a `TransformResult`.
  - Agregar `a2aCompliant?: boolean` a `AgentCard.capabilities`.
- [ ] W0.3: Crear `src/services/a2a-protocol.test.ts` con T-A2A-1..T-A2A-16 (cubre AC-5 y helpers).
- [ ] W0.4: Verificar — `npm run typecheck && npm run test src/services/a2a-protocol.test.ts && npm run lint` → all green.

**Verificación al cerrar W0:** typecheck + tests del helper + lint. Sin tocar compose.ts ni transform.ts. Mergeable solo.

### Wave 1 (Bridge LLM Integration — CACHE_L1/L2/LLM/SKIPPED → bridgeType)

**Objetivo**: `maybeTransform` retorna `bridgeType` sin cambiar lógica.

- [ ] W1.1: Modificar `src/services/llm/transform.ts` agregando `bridgeType` a los 4 returns (SKIPPED / L1 / L2 / LLM). NO cambiar lógica de cache.
- [ ] W1.2: Verificar T-1..T-5 de `transform.test.ts` siguen PASS. Si rompen por shape strict, ajustar expected (anti-drift CD-11).
- [ ] W1.3: Actualizar mock default en `compose.test.ts:26-32` para incluir `bridgeType: 'SKIPPED'`.

**Verificación al cerrar W1:** typecheck + tests transform y compose siguen PASS sin nuevos.

### Wave 2 (Compose Fast-Path — AC-1, AC-2, AC-3)

**Objetivo**: Insertar fast-path en compose.ts.

- [ ] W2.1: Modificar `src/services/compose.ts`:
  - Importar `isA2AMessage`, `extractA2APayload` desde `./a2a-protocol.js`.
  - Reemplazar bloque líneas 111-135 con la lógica del §5.4 (fast-path + AC-3 unwrap).
  - **NO mover `eventService.track` todavía** — eso es W3.
- [ ] W2.2: Agregar T-10, T-11, T-12 a `compose.test.ts` (AC-1, AC-2, AC-3).
- [ ] W2.3: Verificar — `npm run test src/services/compose.test.ts` → T-1..T-9 + T-10..T-12 todos PASS.

**Verificación al cerrar W2:** zero regresión (CD-2 + AC-8) + 3 tests nuevos PASS.

### Wave 3 (Event Metadata — AC-6)

**Objetivo**: Mover `eventService.track` al final del step + agregar `metadata.bridge_type`.

- [ ] W3.1: Modificar `compose.ts` para mover el `eventService.track` después del bloque del bridge.
- [ ] W3.2: Agregar `metadata: { bridge_type: result.bridgeType ?? null }` al payload del track.
- [ ] W3.3: Agregar T-13 (AC-6) a `compose.test.ts`.
- [ ] W3.4: Verificar — `npm run test src/services/compose.test.ts` → all PASS.

**Verificación al cerrar W3:** zero regresión + AC-6 covered.

### Wave 4 (Agent Card Propagation)

**Objetivo**: Propagar `a2aCompliant` desde Agent → AgentCard JSON output.

- [ ] W4.1: Modificar `src/services/agent-card.ts:62-79` con spread condicional (§5.6).
- [ ] W4.2: Verificar tests existentes en `agent-card.test.ts` siguen PASS (CD-11 grep antes de tocar).
- [ ] W4.3: (Opcional) Agregar 1-2 tests para confirmar `capabilities.a2aCompliant` se incluye sí y solo sí `agent.metadata.a2aCompliant === true`.

**Verificación al cerrar W4:** typecheck + tests agent-card PASS.

### Wave 5 (Integration smoke — opcional pero recomendada)

**Objetivo**: Smoke test E2E con 2 agentes mock A2A→A2A.

- [ ] W5.1: Si existe `test/e2e/` o `scripts/smoke.sh`, agregar caso A2A→A2A passthrough. Si no existe, skip (no abrir scope).
- [ ] W5.2: Verificación final — `npm run typecheck && npm run lint && npm run test` → all green.

**Verificación al cerrar W5:** suite completa verde.

### 9.1 Dependencias entre waves

| Wave | Depende de | Razón |
|------|-----------|-------|
| W1 | W0 | Necesita el type `BridgeType` definido |
| W2 | W0, W1 | Importa `isA2AMessage` (W0) y consume `tr.bridgeType` (W1) |
| W3 | W2 | Mueve el track post-bridge; W2 establece dónde está el bridge |
| W4 | W0 | Necesita el campo `a2aCompliant` en `AgentCard.capabilities` (types) |
| W5 | W2, W3, W4 | Smoke E2E |

**W4 puede correr en paralelo a W2/W3** (toca un archivo distinto, agent-card.ts). En cambio, W2 y W3 son secuenciales sobre compose.ts.

---

## 10. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| Regresión en path crítico de billing | BAJA | ALTO | CD-2 + AC-8 + T-1..T-9 invariantes; W2 ejecuta tests en cada modificación |
| Schema drift A2A spec divergente | BAJA | MEDIO | DT-1 hardcodea literales conservadoramente; CD-10 marca `[SPEC_DRIFT]` si la spec live cambia |
| Bug en condicional fast-path (AC-1 vs AC-3 vs AC-2) | MEDIA | ALTO | Tests T-10/T-11/T-12 cubren los 3 paths explícitamente; AR phase cubre adversarial |
| Coverage gap en `isA2AMessage` edge cases | BAJA | BAJO | T-A2A-1..T-A2A-16 (16 tests, 100% line coverage objetivo) |
| Mover `eventService.track` rompe orden de logs | BAJA | BAJO | Track siempre fue fire-and-forget con `.catch`; el orden no es contractual |
| Drift entre architect (este SDD) y disco real | MEDIA | MEDIO | CD-11 + verificación grep en F3 antes de modificar tests/asserts (heredado de AB-WKH-53-#2) |

**Categoría global: ALTA — Adversarial Review obligatoria post-F3** (heredado del work-item).

---

## 11. Patrones detectados en el codebase a respetar

1. **Servicios como objeto literal** (`composeService = { compose(), invokeAgent() }`) — NO clases ES6. Confirmado en `compose.ts`, `agent-card.ts`, `event.ts`, `discoveryService`, `registryService`.
2. **Helpers puros como funciones top-level** (no clases ni servicios) — confirmado en `transform.ts:isCompatible`, `transform.ts:applyTransformFn`, `agent-card.ts:resolveBaseUrl`.
3. **Tests siguen pattern `T-NN: <AC>`** en `it()` de vitest — confirmado en `compose.test.ts:102` ("T-1: includes Bearer auth header from registry").
4. **Imports relativos terminan en `.js`** (Node16 ESM) — confirmado en todos los archivos leídos.
5. **Mocks via `vi.mock('../path/module.js', () => ({ fn: vi.fn() }))`** — confirmado en compose.test.ts, transform.test.ts.
6. **Fixtures con helpers `makeAgent`, `makeRegistry`** en compose.test.ts — REUSAR, no duplicar.
7. **`Agent.metadata: Record<string, unknown>` para campos custom** — patrón existente para `payTo`, `inputSchema`, `payment`. Agregar `a2aCompliant` aquí mismo (NO en top-level del `Agent`).
8. **Constraint Directives en SDD se enumeran como CD-N** (heredado de WKH-55).
9. **Auto-blindaje al cierre de la HU** (heredado de project culture). WKH-56 deberá generar su propio `auto-blindaje.md` en F4.
10. **Logging via `console.error('[Compose] ...', err)` o `console.log`** — patrón existente. NO usar pino o logger custom (no precedente).

---

## 12. Dependencias

- **No requiere migraciones DB.** `bridge_type` vive en `metadata: JSONB` ya existente (event.ts:74).
- **No requiere nuevas variables de entorno.** Fast-path es 100% in-process.
- **No requiere nuevas dependencias npm.** Solo TypeScript + vitest existentes.
- **Compatible con WKH-55** (downstream payment) — el campo `downstream*` en StepResult sigue intacto, fast-path no toca esa lógica.
- **Bloquea WKH-57** (LLM Bridge Pro) parcialmente: WKH-57 depende del `BridgeType` enum y del helper `isA2AMessage` que produce esta HU.

---

## 13. Missing Inputs / Uncertainty Markers

**Estado: TODOS RESUELTOS.**

| Marker original (work-item) | Estado | Resolución |
|-----------------------------|--------|------------|
| DT-1 OPEN: Google A2A v1 spec | ✅ RESUELTO | §4 DT-1 — literales hardcodeados, fuente: project-context.md + types existentes |
| DT-2 OPEN: ubicación de `a2aCompliant` | ✅ RESUELTO | §4 DT-2 — opción (b): `capabilities.a2aCompliant` |
| DT-3 OPEN: backward-compat de `cacheHit` | ✅ RESUELTO | §4 DT-3 — opción (b): mantener ambos, agregar `bridgeType` aditivo |
| DT-5 OPEN / AC-4: LLM prompt update | ✅ RESUELTO | §4 DT-5 — opción (b): deferir a WKH-57; AC-4 OUT OF SCOPE |
| Test path NEEDS CLARIFICATION | ✅ RESUELTO | §4.5 — `src/services/compose.test.ts` (al lado del source, NO en `__tests__/`) |
| Schema DB persistir `a2aCompliant` | ✅ RESUELTO (WORK-ITEM) | Heredado: `a2aCompliant` solo en runtime/Agent Card JSON; NO se persiste en `a2a_registries` |

**Sin `[NEEDS CLARIFICATION]` pendientes.** Sin `[TBD]` bloqueantes.

---

## 14. Readiness Check (Architect self-check)

```
READINESS CHECK — WKH-56 SDD #055
[X] DT-1 resuelto (literales role/kind hardcoded en §5.2)
[X] DT-2 resuelto (capabilities.a2aCompliant — opción b — §4 DT-2)
[X] DT-3 resuelto (cacheHit mantenido + bridgeType aditivo — §4 DT-3)
[X] DT-5 resuelto (AC-4 deferido a WKH-57 — §4 DT-5)
[X] Test path verificado con Glob (src/services/compose.test.ts, NO __tests__/)
[X] Waves orden lógico (W0 standalone → W1 transform → W2 compose → W3 event → W4 agent-card)
[X] Cada AC tiene ≥1 archivo asociado (§6.1)
[X] Cada archivo nuevo tiene Exemplar verificado (§6.2)
[X] No hay [NEEDS CLARIFICATION] pendientes (§13)
[X] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1, CD-3, CD-4, CD-7, CD-10, CD-11, CD-12, CD-13, CD-15, CD-16)
[X] Context Map tiene ≥2 archivos leídos (§3.1 — 11 archivos leídos)
[X] Scope IN y OUT son explícitos (§2 + work-item §Scope)
[X] BD: tablas verificadas (§3.3 — sin cambios)
[X] Flujo principal Happy Path completo (§5.7)
[X] Flujo de error definido (§5.8 — 5 casos)
[X] Auto-Blindaje histórico consultado (AB-WKH-53-#2, AB-WKH-55-4, AB-WKH-55-5, AB-WKH-55-10)
[X] CDs nuevos derivados de patrones recurrentes (CD-11 anti-drift, CD-12 never-throw, CD-13 explicit, CD-14 test invariante)
```

**Resultado: READY para SPEC_APPROVED.** Sin blockers para F2.5.

---

## 15. Estimación

- **Archivos nuevos:** 2 (`a2a-protocol.ts`, `a2a-protocol.test.ts`)
- **Archivos modificados:** 5 (`compose.ts`, `transform.ts`, `agent-card.ts`, `types/index.ts`, `compose.test.ts`)
- **Tests nuevos:** ~20 (16 en a2a-protocol.test.ts + 4 en compose.test.ts T-10..T-13)
- **Tests modificados:** 1 (mock default en compose.test.ts:26-32)
- **Líneas estimadas:** ~280-350 LOC nuevas (helpers ~80 + tests ~150 + types ~40 + compose changes ~60)
- **Esfuerzo:** L (size del work-item) — 5 waves, paralelismo W4∥W2/W3.

---

*SDD generado por NexusAgil — Architect (F2) — 2026-04-26 — WKH-56 — branch: feat/055-wkh-56-a2a-fast-path*
