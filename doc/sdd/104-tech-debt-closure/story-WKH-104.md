# Story File — WKH-104 — Tech Debt Closure (TDs WKH-101/102/103)

> Contrato autocontenido para el Dev (F3). Si algo NO está acá, NO lo hagas.
> Fuente: `doc/sdd/104-tech-debt-closure/sdd.md` (SPEC_APPROVED). Branch: `feat/104-tech-debt-closure`.

---

## 0. Contexto compacto

Cerramos 4 deudas técnicas en una sola HU, **sin diferimiento**:

1. **TD-COMMENT** (trivial): corregir un comentario stale en `orchestrate.ts:81-82`.
2. **TD-DRIFT** (refactor backward-compat CRÍTICO): el path master de
   `requirePaymentOrA2AKey` deja de duplicar el bloque inline de resolución de
   chain y llama al helper `resolveTargetChain` (igual que ya hace el path
   delegación). **Comportamiento observable IDÉNTICO** (CD-1).
3. **TD-SYBIL** (privacidad + anti-sybil): `compose.ts` emite `caller_ref_hash`
   (HMAC-SHA256 del `owner_ref`, NUNCA el raw) en metadata de `compose_step`
   (success Y failed). `reputation.ts` **capea por caller**: cada
   `(agent, caller_ref_hash)` aporta `min(count, K)` tasks; K env-driven.
4. **TD-RACE-TEST** (test honesto): test de atomicidad real del RPC
   `debit_delegation_and_parent` contra Postgres real, gateado por env. Sin
   `INTEGRATION_TEST_DB_URL` → `describe.skipIf` con warn. **No mock-teatro.**

**Decisión humana NC-1:** anti-sybil = **CAP POR CALLER** (NO Opción A). El shape
de `AgentReputation` NO cambia (`tasks_settled` sigue siendo la key; cambia su
valor a "tasks anti-sybil capeadas").

---

## 1. Anti-Hallucination Checklist (LEÉ ANTES DE TOCAR NADA)

- [ ] **DRIFT = diff mínimo (4 líneas).** El `git diff` de `a2a-key.ts` SHALL
      mostrar SOLO: borrar líneas 482-529 (comentario + bloque inline) e insertar
      el patrón de 4 líneas. NO tocás `resolveTargetChain` (CD-2/CD-12). NO tocás
      ninguna otra rama del middleware.
- [ ] **DRIFT = behavior idéntico.** Los tests de `a2a-key.test.ts` que cubren el
      master path (400 `CHAIN_NOT_SUPPORTED`, 500 `REGISTRY_NOT_INITIALIZED`,
      happy) deben quedar **verdes SIN modificarlos**. Si un test cambia → es
      regresión → BLOQUEANTE (CD-1).
- [ ] **HMAC nunca el raw.** `hashCallerRef` es la ÚNICA frontera donde el
      `owner_ref` se transforma. El objeto `metadata` que va a `eventService.track`
      SOLO recibe `caller_ref_hash` (hex o null). El raw `owner_ref` NUNCA entra a
      `metadata` ni a logs (CD-5/CD-6).
- [ ] **Anti-N+1: 1 query por path.** El SELECT de reputación sigue siendo 1
      query (single con `.eq('agent_id', slug)`, batch con `.in('agent_id', slugs)`).
      Solo se agrega `metadata` a la lista de columnas. El cap se aplica 100% en el
      reduce JS in-memory. PROHIBIDO agregar query por caller/agente (CD-10).
- [ ] **Anti-mock-teatro en RACE.** El test real usa cliente Supabase real
      (service_role) y RPC real. Sin env → skip honesto + warn. NUNCA fallback a
      mock que pase verde (CD-3). El mock-only de `delegation.test.ts` se ANOTA
      (no se borra) aclarando que verifica mapeo de errores, no atomicidad (CD-4).
- [ ] **biome-write ANTES de lint.** Carry WKH-101/102/103: correr
      `npx biome check --write src/` ANTES de `npm run lint`. El format gate es
      previo al lint gate.
- [ ] **Arg/campo opcional rompe `toHaveBeenCalledWith` exactos.** Agregar
      `caller_ref_hash` al metadata de `track` y `metadata` a `RepRow`/SELECT
      rompe asserts exactos en `compose.test.ts` y `reputation.test.ts`. Revisá
      TODOS los call-sites de `eventService.track` en los tests de compose y del
      builder de reputación; actualizá los `toHaveBeenCalledWith` / `objectContaining`.
- [ ] **No agregar dependencias.** HMAC vía `node:crypto` (`createHmac`). Cliente
      real vía `@supabase/supabase-js` (ya en `package.json`).
- [ ] **No cambiar el shape público de `AgentReputation`** ni schema de DB ni
      migrar eventos históricos (Scope OUT).
- [ ] **TS strict, sin `any`.** `RepRow.metadata: Record<string, unknown> | null`.
      Extracción del hash con cast estrecho `as string | null | undefined`.

---

## 2. Orden de waves (SERIAL, sin gates humanos entre ellas)

```
W0 (gate serial) → W1 (DRIFT) → W2 (SYBIL emisión) → W3 (SYBIL scoring) → W4 (RACE)
```

W2 antes de W3 porque scoring (reputation.ts) consume el `caller_ref_hash` que
emite compose.ts. W0 primero por el carry-forward (helper + tsc gate).

---

## 3. Constraint Directives resumidas

| CD | Regla |
|----|-------|
| CD-1 | DRIFT: PROHIBIDO cambiar comportamiento observable del master. Regresión = BLOQUEANTE. |
| CD-2 | DRIFT: PROHIBIDO cambiar firma de `resolveTargetChain`. Solo invocarla. |
| CD-3 | RACE: PROHIBIDO pasar verde con mocks. Env ausente → skip. |
| CD-4 | RACE: OBLIGATORIO anotar `delegation.test.ts` (mock = mapeo errores, no atomicidad). |
| CD-5 | SYBIL: PROHIBIDO `owner_ref` crudo en `a2a_events.metadata`. Solo el hash. |
| CD-6 | SYBIL: OBLIGATORIO HMAC (no hash sin key). Secret desde env. |
| CD-7 | SYBIL: cap por caller, cada caller aporta `min(count, K)`. |
| CD-8 | SYBIL: eventos sin hash → bucket anónimo (capeado a K), no error, no colapso a null. |
| CD-9 | GENERAL: 1324 tests verdes tras cada wave. |
| CD-10 | SYBIL: 1 query por path (single+batch). Cap 100% en reduce JS. |
| CD-11 | SYBIL: mismo owner_ref + mismo secret → mismo hash (determinismo). Helper puro. |
| CD-12 | DRIFT: diff de `a2a-key.ts` = SOLO borrar 482-529 + insertar 4 líneas. |
| CD-13 | RACE: cleanup `afterAll` con IDs prefijados (patrón owner_ref-prefix WKH-35). |
| CD-14 | RACE: cliente service_role. Documentar cómo correrlo en el docstring. |
| CD-15 | SYBIL: `RepRow.metadata: Record<string, unknown> \| null`. PROHIBIDO `any`. |

---

## 4. Scope IN (lista exhaustiva de archivos)

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/routes/orchestrate.ts` | Modificar (comentario 81-82) | W0 |
| `src/lib/caller-hash.ts` | **CREAR** (helper HMAC) | W0 |
| `src/lib/caller-hash.test.ts` | **CREAR** (tests del helper) | W0 |
| `src/middleware/a2a-key.ts` | Modificar (refactor master 482-529 → helper) | W1 |
| `src/middleware/a2a-key.test.ts` | Verificar verde SIN cambios (equivalencia) | W1 |
| `src/services/compose.ts` | Modificar (emitir `caller_ref_hash` success+failed) | W2 |
| `src/services/compose.test.ts` | Modificar (assert hash success/failed/null) | W2 |
| `src/services/reputation.ts` | Modificar (cap por caller) | W3 |
| `src/services/reputation.test.ts` | Modificar (tests cap por caller) | W3 |
| `src/__tests__/e2e/delegation-atomicity.real.test.ts` | **CREAR** (test atomicidad real) | W4 |
| `src/services/delegation.test.ts` | Modificar (anotar describe mock-only) | W4 |

**Scope OUT (NO TOCAR):** schema DB, columna `caller_ref_hash`, RLS, shape de
endpoints REST/JSON-RPC, lectura on-chain ReputationRegistry, migración de
eventos históricos, `src/services/delegation.ts` (producción), endpoints de
fondeo / `/auth/deposit-info`.

---

## 5. Env vars

| Env | Default / degradación | Uso |
|-----|----------------------|-----|
| `REPUTATION_MAX_TASKS_PER_CALLER` | `5` si ausente o inválido (`!Number.isFinite \|\| <= 0`) | K del cap por caller (W3). |
| `REPUTATION_CALLER_HMAC_SECRET` | `"wasiai-dev-caller-hmac-v1"` + `console.warn` 1 sola vez | Secret del HMAC (W0/W2). En prod DEBE setearse real. |
| `INTEGRATION_TEST_DB_URL` | ausente → `describe.skipIf` skippea | URL Supabase de la DB de test (W4, solo test). |
| `INTEGRATION_TEST_SERVICE_KEY` | ausente → `describe.skipIf` skippea | service_role key (RPC tiene REVOKE anon/authenticated) (W4, solo test). |

---

## WAVE 0 — Comentario + Helper HMAC (gate serial)

**Objetivo:** corregir el comentario stale y crear el helper HMAC con sus tests.
**Cubre:** AC-1, AC-9, AC-10, AC-12 (parcial: el helper) · DT-1 · CD-5/CD-6/CD-11.

### W0.1 — `src/routes/orchestrate.ts` (AC-1)

Reemplazar el texto EXACTO de las líneas 81-82:

```ts
            // WKH-101 (DT-12, opción B): chainId resuelto, propagado SOLO para
            // que el débito per-step de steps 2..N funcione bajo delegación.
```

por el texto EXACTO nuevo:

```ts
            // WKH-104 (TD-COMMENT): chainId resuelto y propagado para TODOS los
            // callers (master keys y sesiones delegadas), para que el débito
            // per-step de steps 1..N use el chainId del bundle resuelto en el
            // middleware. Desde WKH-102 ya no es exclusivo de delegación.
```

NO cambiar la línea 83 (`chainId: request.resolvedChainId,`). Sin cambio de
código ejecutable.

### W0.2 — `src/lib/caller-hash.ts` (CREAR) — DT-1, CD-5/6/11

Firma exacta (TS strict, sin `any`):

```ts
import { createHmac } from 'node:crypto';

const DEV_FALLBACK_SECRET = 'wasiai-dev-caller-hmac-v1';
let _warnedMissingSecret = false;

/**
 * Resuelve el secret del HMAC desde REPUTATION_CALLER_HMAC_SECRET. Si ausente,
 * usa un fallback de dev con warn una sola vez (degradación segura para
 * dev/test). En prod DEBE setearse el secret real. Patrón resolveScaleFactor.
 */
function resolveCallerHashSecret(): string {
  const secret = process.env.REPUTATION_CALLER_HMAC_SECRET;
  if (secret && secret.length > 0) return secret;
  if (!_warnedMissingSecret) {
    console.warn(
      '[caller-hash] REPUTATION_CALLER_HMAC_SECRET ausente — usando fallback de dev. Setear el secret real en prod.',
    );
    _warnedMissingSecret = true;
  }
  return DEV_FALLBACK_SECRET;
}

/**
 * HMAC-SHA256 del owner_ref para identificar callers distintos sin exponer la
 * identidad cruda (CD-5/CD-6). Determinista intra-deployment (CD-11).
 * - null/undefined/'' → null (caller anónimo, AC-12).
 * - NUNCA retorna ni loguea el owner_ref crudo.
 */
export function hashCallerRef(ownerRef: string | null | undefined): string | null {
  if (ownerRef == null || ownerRef === '') return null;
  return createHmac('sha256', resolveCallerHashSecret()).update(ownerRef).digest('hex');
}

/** TEST-ONLY — resetea el flag de warn (patrón _resetReputationCache). */
export function _resetCallerHashWarn(): void {
  _warnedMissingSecret = false;
}
```

**Edge/error:**
- `ownerRef` null/undefined/'' → retorna `null` (NO hashea string vacío).
- secret ausente → fallback dev + warn 1 vez (no throw).
- determinismo: mismo `ownerRef` + mismo secret → mismo hex.

### W0.2 tests — `src/lib/caller-hash.test.ts` (CREAR)

Estructura como cualquier `*.test.ts` con vitest (`describe`/`it`/`expect`,
`beforeEach`/`afterEach` para resetear `process.env.REPUTATION_CALLER_HMAC_SECRET`
y llamar `_resetCallerHashWarn()`).

Tests obligatorios:
1. **determinismo (AC-9/CD-11):** con secret fijo, `hashCallerRef('owner-A')`
   llamado dos veces → mismo hex.
2. **secret distinto → hash distinto (CD-6):** mismo `ownerRef`, dos secrets
   distintos → hashes distintos (prueba que es HMAC, no hash plano).
3. **no-leak (AC-10/CD-5):** el output NO contiene el `ownerRef` raw como
   substring (`expect(hash).not.toContain('owner-A')`); es hex de 64 chars
   (`/^[0-9a-f]{64}$/`).
4. **null passthrough (AC-12):** `hashCallerRef(null)`, `hashCallerRef(undefined)`,
   `hashCallerRef('')` → todos `null`.
5. **fallback warn:** sin env, `console.warn` se llama (spy) 1 sola vez tras
   múltiples invocaciones.

### Gate W0
- `npx tsc --noEmit` → 0 errores.
- `npx biome check --write src/` (format ANTES de lint) → luego `npm run lint`.
- Tests de `caller-hash.test.ts` verdes.

---

## WAVE 1 — TD-DRIFT (backward-compat CRÍTICO, serial)

**Objetivo:** master path llama `resolveTargetChain` en vez de duplicar el bloque.
**Cubre:** AC-2, AC-3, AC-4, AC-5 · CD-1, CD-2, CD-12.

### W1.1 — `src/middleware/a2a-key.ts`

**Borrar VERBATIM las líneas 482-529** (comentario `// 6. Resolve target chain
per-request ...` + el bloque inline completo, hasta e incluyendo
`request.resolvedChainId = chainId;` en 529):

```ts
      // 6. Resolve target chain per-request (WKH-MULTICHAIN W2)
      // Priority: explicit `x-payment-chain` header > registry default.
      // CD-16: NO discovery calls here (manifest fallback is delegated to
      // the upstream caller, wasiai-v2 propagates the header).
      // CD-6: resolver is a pure in-memory function — no I/O.
      const headerRaw = request.headers['x-payment-chain'];
      const headerOverride =
        typeof headerRaw === 'string' ? headerRaw : undefined;
      const defaultChainKey = getDefaultChainKey();

      let chainKey = resolveChainKey({ headerOverride });
      if (!chainKey) {
        if (headerOverride !== undefined) {
          // CD-14: header present but unrecognised → 400, never silent default.
          return reply.status(400).send({
            error_code: 'CHAIN_NOT_SUPPORTED',
            error: `Chain '${headerOverride}' is not a recognized slug or chainId`,
          });
        }
        // Header absent → fall back to registry default.
        chainKey = defaultChainKey ?? undefined;
        if (!chainKey) {
          return reply.status(500).send({
            error_code: 'REGISTRY_NOT_INITIALIZED',
            error: 'No chains initialized in registry',
          });
        }
      }

      const bundle = getAdaptersBundle(chainKey);
      if (!bundle) {
        // DT-C: recognised slug but not present in the initialised registry.
        return reply.status(400).send({
          error_code: 'CHAIN_NOT_SUPPORTED',
          error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
        });
      }

      // CD-12: chainId for debit AND for post-debit getBalance MUST come from
      // the SAME bundle. Do NOT read from getChainConfig() anywhere below.
      const chainId = bundle.chainConfig.chainId;
      const assetSymbol =
        bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN';

      // WKH-59 (real-price-debit) DT-D / CD-12: propagar al route handler para
      // que composeService haga debit per-step (steps 2..N) con el MISMO chainId
      // del bundle. NO re-resolver en el service (race latente).
      request.resolvedChainId = chainId;
```

**Reemplazar por EXACTAMENTE (patrón verbatim del path delegación, líneas
275-278):**

```ts
      // 6. Resolve target chain per-request — REUSO del helper resolveTargetChain
      // (WKH-104 TD-DRIFT: deduplicación del bloque master, behavior idéntico CD-1).
      const chain = resolveTargetChain(request, reply);
      if (!chain) return; // resolveTargetChain ya envió la respuesta de error
      const { chainId, chainKey, assetSymbol } = chain;
      request.resolvedChainId = chainId;
```

**Variables que el master consume DESPUÉS del bloque (deben seguir en scope tras
el destructuring) — verificado en `a2a-key.ts:537-565`:**
- `chainKey` → líneas 540, 563 (logs `a2a-key.debit` / `a2a-key.insufficient-budget`).
- `chainId` → líneas 541, 549, 558, 564 (logs + `budgetService.debit` + `getBalance`).
- `assetSymbol` → líneas 542, 565 (`asset_symbol` en logs).

El destructuring `const { chainId, chainKey, assetSymbol } = chain;` las deja a
las 3 en el mismo scope → backward-compat preservada.

**Por qué es behavior-idéntico (CD-1):** `resolveTargetChain` (140-179) es
réplica verbatim del bloque inline: mismo orden (header → `resolveChainKey` →
default → `getAdaptersBundle`), mismos status/códigos (400 `CHAIN_NOT_SUPPORTED`,
500 `REGISTRY_NOT_INITIALIZED`), mismos campos derivados
(`chainId = bundle.chainConfig.chainId`,
`assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN'`). Único
delta textual: los comentarios (inline tiene CD-14/DT-C, helper no) — los strings
de las respuestas son idénticos.

**PROHIBIDO:** tocar `resolveTargetChain` (140-179), el orden de los pasos 1-8 del
middleware, o cualquier otra rama. CD-12.

### W1.2 — `src/middleware/a2a-key.test.ts`

NO modificar. Confirmar verde los tests del master path:
- 400 `CHAIN_NOT_SUPPORTED` con `x-payment-chain` desconocido (AC-3).
- 500 `REGISTRY_NOT_INITIALIZED` sin chain inicializada (AC-4).
- happy path master (chain válida → `request.resolvedChainId` correcto + debit
  con chainId del bundle) (AC-2).

Si algún test del master cambia para pasar → es regresión → BLOQUEANTE.

### Gate W1
- Suite completa verde (foco: middleware + 400/500 master).
- `git diff src/middleware/a2a-key.ts` muestra SOLO la sustitución de las ~48
  líneas inline por las 6 líneas del patrón. Nada más.

---

## WAVE 2 — TD-SYBIL emisión (`compose.ts`)

**Objetivo:** emitir `caller_ref_hash` en metadata de `compose_step` (success Y
failed). **Cubre:** AC-9, AC-10, AC-12 (emisión) · CD-5.

### W2.1 — `src/services/compose.ts`

1. Import del helper (junto a los otros imports):
   ```ts
   import { hashCallerRef } from '../lib/caller-hash.js';
   ```
2. Computar el hash una vez por step. El `ownerRef` ya se lee en línea 238
   dentro del `if (inputSchema && nextAgent)`. Para garantizar que esté
   disponible en AMBOS bloques `track` (success ~285 y failed catch ~298),
   computar **al inicio del loop del step** (antes del `try`), o reutilizar
   `scopingKeyRow?.owner_ref` directamente en cada `track`:
   ```ts
   const callerRefHash = hashCallerRef(scopingKeyRow?.owner_ref);
   ```
   (`scopingKeyRow` se desestructura del input de `compose()` — línea 62 — y está
   en scope todo el cuerpo del loop. NO depende del `ownerRef` local del bloque
   transform.)
3. **Success** (metadata, líneas 285-292): agregar la key `caller_ref_hash` al
   objeto metadata existente. Resultado EXACTO:
   ```ts
            metadata: {
              bridge_type: result.bridgeType ?? null,
              bridge_latency_ms: result.transformLatencyMs ?? null,
              bridge_cost_usd: llm?.costUsd ?? null,
              llm_model: llm?.model ?? null,
              llm_tokens_in: llm?.tokensIn ?? null,
              llm_tokens_out: llm?.tokensOut ?? null,
              caller_ref_hash: callerRefHash,
            },
   ```
4. **Failed** (catch, líneas 298-307): el `track` actual NO pasa `metadata`.
   Agregar la prop `metadata`. Resultado EXACTO:
   ```ts
        eventService
          .track({
            eventType: 'compose_step',
            agentId: agent?.slug,
            agentName: agent?.name,
            registry: agent?.registry,
            status: 'failed',
            latencyMs: Date.now() - startTime,
            costUsdc: 0,
            metadata: { caller_ref_hash: callerRefHash },
          })
   ```

**Privacidad (AC-10/CD-5):** `callerRefHash` es hex o `null`. El `owner_ref` crudo
NUNCA entra al objeto `metadata`.

**Edge:** sin `scopingKeyRow` (x402 anónimo) → `hashCallerRef(undefined)` → `null`
→ `caller_ref_hash: null` (AC-12).

### W2.2 — `src/services/compose.test.ts`

- Revisar TODOS los call-sites del assert de `eventService.track` (los
  `toHaveBeenCalledWith` que comparan el objeto metadata exacto). El nuevo campo
  `caller_ref_hash` rompe asserts exactos → actualizarlos (carry WKH-101).
- Test **emit success (AC-9):** con `scopingKeyRow.owner_ref` presente, el
  `compose_step` success → `metadata.caller_ref_hash` === HMAC del owner_ref
  (computar el esperado con `hashCallerRef` o `createHmac` con el mismo secret de
  test, o assert `expect.stringMatching(/^[0-9a-f]{64}$/)`).
- Test **emit failed (AC-9):** forzar fallo en un step → `compose_step` failed →
  `metadata.caller_ref_hash` presente (mismo hash).
- Test **anónimo (AC-12/AC-10):** sin `scopingKeyRow` → `caller_ref_hash: null`;
  el `owner_ref` raw nunca aparece en el metadata emitido.

### Gate W2
- `npx tsc --noEmit` 0 errores + biome write + lint.
- Suite completa verde (foco: compose).

---

## WAVE 3 — TD-SYBIL scoring (cap por caller)

**Objetivo:** `reputation.ts` capea tasks por caller. **Cubre:** AC-11, AC-12
(scoring) · CD-7, CD-8, CD-10, CD-15.

### W3.1 — `src/services/reputation.ts`

1. **Env-resolver** (junto a `resolveScaleFactor`, ~línea 27):
   ```ts
   function resolveMaxTasksPerCaller(): number {
     const raw = process.env.REPUTATION_MAX_TASKS_PER_CALLER;
     const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
     return Number.isFinite(n) && n > 0 ? n : 5;
   }
   ```
2. **`RepRow`** (líneas 59-65): agregar `metadata` (CD-15, sin `any`):
   ```ts
   interface RepRow {
     agent_id: string | null;
     status: string;
     cost_usdc: number | string | null;
     latency_ms: number | null;
     metadata: Record<string, unknown> | null;
   }
   ```
3. **SELECT** en AMBOS paths — agregar `metadata` a la lista de columnas. Sigue
   siendo 1 query (CD-10):
   - single (línea 160): `.select('agent_id, status, cost_usdc, latency_ms, metadata')`
   - batch (línea 194): `.select('agent_id, status, cost_usdc, latency_ms, metadata')`
4. **`RepAccumulator`** (líneas 50-57): reemplazar `settledCount: number` por un
   Map por caller:
   ```ts
   interface RepAccumulator {
     settledByCaller: Map<string, number>; // key = caller_ref_hash | '__anon__'
     settledVolume: number;
     settledLatencySum: number;
     settledLatencyCount: number;
     successCount: number;
     failedCount: number;
   }
   ```
   `emptyAccumulator()` → `settledByCaller: new Map<string, number>()`.
5. **`accumulateRow`** (líneas 79-98): cuando la fila es `success AND cost>0`, en
   lugar de `acc.settledCount++`:
   ```ts
   const hash =
     (row.metadata?.['caller_ref_hash'] as string | null | undefined) ??
     '__anon__';
   acc.settledByCaller.set(hash, (acc.settledByCaller.get(hash) ?? 0) + 1);
   ```
   `settledVolume`, `settledLatencySum`, `settledLatencyCount`, `successCount`,
   `failedCount` se siguen acumulando crudos (sin cap) — el volumen y el
   `success_rate` NO se capean (OBS-1).
6. **`computeFromAccumulator`** (líneas 105-131): el `tasksSettled` deja de ser
   `acc.settledCount`:
   ```ts
   const K = resolveMaxTasksPerCaller();
   let tasksSettled = 0;
   for (const n of acc.settledByCaller.values()) tasksSettled += Math.min(n, K);
   if (tasksSettled === 0) return null;
   ```
   El resto NO cambia: `raw = min(tasksSettled / resolveScaleFactor(), 1)`,
   `score = round(raw * 100 * successRate)`, mismo shape `AgentReputation`
   (`tasks_settled: tasksSettled`, ahora capeado).
7. **JSDoc**: actualizar el comentario del módulo / `computeFromAccumulator` para
   documentar el cap anti-sybil por caller (CD-7) y el efecto en históricos
   (CD-8): eventos sin `caller_ref_hash` caen en `__anon__`, capeado a K → puede
   BAJAR scores inflados existentes (comportamiento esperado, no bug).

**Determinismo + anti-N+1:** 1 query por path. El cap es 100% reduce JS
in-memory. Batch mantiene `accBySlug: Map<slug, RepAccumulator>` y cada acc tiene
su `settledByCaller`.

### W3.2 — `src/services/reputation.test.ts`

- Revisar asserts existentes que esperan `tasks_settled = settledCount` plano →
  actualizar (los eventos de test sin `metadata.caller_ref_hash` caen en
  `__anon__`, capeado a K; si N>K el valor cambia). Carry WKH-101.
- Si hay tests que cuentan llamadas a `supabase`/`fetch`, mockear el
  service/`supabase.js` donde aplique (carry WKH-103 W4: el fetch interno de
  PostgREST infla call-counts).
- Tests obligatorios (cada uno setea `process.env.REPUTATION_MAX_TASKS_PER_CALLER`
  conocido, ej. K=5, y `metadata.caller_ref_hash` en las filas mock):
  1. **cap mismo caller (AC-11/CD-7 — autopago no infla):** 1 caller × N tasks
     success (N>K, ej. N=10, K=5) → `tasks_settled === 5`.
  2. **callers distintos suman (AC-11):** M callers distintos × 1 task c/u →
     `tasks_settled === M`.
  3. **cap mixto (AC-11):** caller A con N>K + caller B con 1 →
     `tasks_settled === K + 1`.
  4. **bucket null/anónimo (AC-12/CD-8):** eventos sin `caller_ref_hash` (o
     `metadata: null`) → caen en `__anon__`, capeado a K; score NO colapsa a
     null (≥1 task → score > 0).
  5. **histórico sin hash + caller con hash:** mezcla de filas legacy (sin
     metadata) y nuevas (con hash) → legacy en `__anon__` capeado a K, las nuevas
     por su hash → suma correcta.
  6. **determinismo del cap:** mismo input → mismo `tasks_settled` (función pura).
  7. **1 query (CD-10):** el batch sigue llamando `.in('agent_id', slugs)` 1 sola
     vez (assert call-count del builder mock).

### Gate W3
- `npx tsc --noEmit` 0 errores + biome write + lint.
- Suite completa verde (foco: reputation).

---

## WAVE 4 — TD-RACE-TEST (atomicidad real)

**Objetivo:** test de atomicidad real del RPC contra Postgres, gateado por env.
**Cubre:** AC-6, AC-7, AC-8 · CD-3, CD-4, CD-13, CD-14.

### W4.1 — `src/__tests__/e2e/delegation-atomicity.real.test.ts` (CREAR)

**Estructura:**
```ts
/**
 * Atomicidad real de debit_delegation_and_parent (WKH-104 TD-RACE-TEST).
 *
 * Ejercita Postgres REAL — NO mocks (CD-3/CD-4). Verifica que dos débitos
 * concurrentes contra la misma delegación, individualmente válidos pero juntos
 * excediendo max_total_amount, resulten en EXACTAMENTE uno OK y uno rechazado
 * con DELEGATION_TOTAL_LIMIT_EXCEEDED, y que total_spent quede en M (no 2M).
 * Esto prueba el FOR UPDATE (no-double-spend) que un mock jamás verifica.
 *
 * CÓMO CORRERLO (manual / CI-integración) — CD-14:
 *   INTEGRATION_TEST_DB_URL=<supabase-url> \
 *   INTEGRATION_TEST_SERVICE_KEY=<service_role_key> \
 *   npx vitest run src/__tests__/e2e/delegation-atomicity.real.test.ts
 *
 * El RPC tiene REVOKE EXECUTE FROM anon/authenticated → REQUIERE service_role.
 * Sin INTEGRATION_TEST_DB_URL → todo el describe se skippea con warn (AC-8).
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env.INTEGRATION_TEST_DB_URL;
const SERVICE_KEY = process.env.INTEGRATION_TEST_SERVICE_KEY;
const ENABLED = !!DB_URL && !!SERVICE_KEY;

if (!ENABLED) {
  console.warn(
    '[delegation-atomicity.real] SKIP — requiere Postgres real. Setear ' +
      'INTEGRATION_TEST_DB_URL + INTEGRATION_TEST_SERVICE_KEY para ejecutarlo.',
  );
}

describe.skipIf(!ENABLED)('debit_delegation_and_parent — atomicidad real', () => {
  // ... seed + asserts + cleanup
});
```

**Setup (`beforeAll`):**
- Cliente real:
  ```ts
  const supabase = createClient(DB_URL!, SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  ```
- Prefijo de test para cleanup seguro (patrón owner_ref-prefix WKH-35, commit
  d6b99f1):
  ```ts
  const TEST_PREFIX = `wkh104-race-${Date.now()}`;
  const ownerRef = `${TEST_PREFIX}-owner`;
  ```
- Insertar `a2a_agent_keys` (columnas requeridas: `owner_ref`, `key_hash` UNIQUE
  NOT NULL; `budget` JSONB per-chain con saldo suficiente en el chainId de
  prueba). Ej:
  ```ts
  const chainId = 84532; // chainId de prueba (no limitante)
  const { data: keyRow } = await supabase
    .from('a2a_agent_keys')
    .insert({
      owner_ref: ownerRef,
      key_hash: `${TEST_PREFIX}-keyhash`,
      budget: { [String(chainId)]: '100.0' }, // budget holgado, no es el límite
      is_active: true,
    })
    .select('id')
    .single();
  keyId = keyRow!.id;
  ```
- Insertar `a2a_delegations` (columnas NOT NULL: `key_id`, `owner_ref`,
  `session_key_address`, `session_token_hash` UNIQUE, `policy` JSONB,
  `typed_data_raw` JSONB, `nonce`; `total_spent` default 0; `expires_at` futuro;
  `revoked_at` null). El límite del test vive en `policy.max_total_amount`:
  ```ts
  const M = 1.0;          // monto de cada débito
  const MAX_TOTAL = 1.5;  // 1.0 pasa; 1.0 + 1.0 = 2.0 > 1.5 → el 2º viola
  const { data: delRow } = await supabase
    .from('a2a_delegations')
    .insert({
      key_id: keyId,
      owner_ref: ownerRef,
      session_key_address: `0x${TEST_PREFIX.replace(/[^0-9a-f]/gi, '0').slice(0, 40).padEnd(40, '0')}`,
      session_token_hash: `${TEST_PREFIX}-tokenhash`,
      policy: { max_total_amount: MAX_TOTAL, allowed_chains: [], max_amount_per_tx: M, max_calls: null },
      total_spent: 0,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      typed_data_raw: { test: true },
      nonce: `0x${TEST_PREFIX.replace(/[^0-9a-f]/gi, '0').slice(0, 64).padEnd(64, '0')}`,
    })
    .select('id')
    .single();
  delegationId = delRow!.id;
  ```
  > NOTA: validar el shape de `policy` contra lo que lee el RPC — el RPC SOLO usa
  > `policy->>'max_total_amount'`. Los otros campos de `policy` son tolerados.
  > Verificar `session_key_address`/`nonce` cumplan formato si hay CHECK
  > constraints (si el insert falla por constraint, ajustar a hex válido).

**Acto concurrente (AC-6):**
```ts
const debit = () =>
  supabase.rpc('debit_delegation_and_parent', {
    p_delegation_id: delegationId,
    p_owner_ref: ownerRef,
    p_key_id: keyId,
    p_chain_id: chainId,
    p_amount_usd: M,
  });
const [r1, r2] = await Promise.allSettled([debit(), debit()]);
```
> Concurrencia real contra el lock FOR UPDATE — NO `await` secuencial. Cada
> `supabase.rpc` resuelve con `{ data, error }`; el "error" de límite llega como
> `result.value.error` (no como rejection). Manejar AMBAS formas: tratar como
> "rechazado" si `status === 'rejected'` O si `value.error != null`.

**Aserciones:**
```ts
const outcomes = [r1, r2].map((r) =>
  r.status === 'fulfilled' && r.value.error == null
    ? { ok: true, total: r.value.data }
    : {
        ok: false,
        msg:
          r.status === 'fulfilled'
            ? String(r.value.error?.message ?? '')
            : String((r.reason as Error)?.message ?? ''),
      },
);
const okCount = outcomes.filter((o) => o.ok).length;
const failOutcome = outcomes.find((o) => !o.ok);

expect(okCount).toBe(1); // exactamente uno gana
expect(failOutcome).toBeDefined();
expect(failOutcome!.msg).toContain('DELEGATION_TOTAL_LIMIT_EXCEEDED');

// no-double-spend: re-leer total_spent bajo la realidad post-tx
const { data: after } = await supabase
  .from('a2a_delegations')
  .select('total_spent')
  .eq('id', delegationId)
  .single();
expect(Number(after!.total_spent)).toBe(M); // M, NO 2M (el 2º hizo ROLLBACK)
```

**Cleanup (`afterAll`) — CD-13:**
```ts
await supabase.from('a2a_delegations').delete().eq('id', delegationId);
await supabase.from('a2a_agent_keys').delete().eq('id', keyId);
```
(O por `owner_ref` con el prefijo de test si hay filas extra. NO dejar basura en
la DB compartida con wasiai-v2.)

### W4.2 — `src/services/delegation.test.ts` (anotar, CD-4)

Agregar un comentario al `describe('debitDelegationAndParent')` (línea 284):

```ts
// WKH-104 (CD-4): estos tests verifican el MAPEO de errores RPC → error classes
// (DELEGATION_TOTAL_LIMIT_EXCEEDED, INSUFFICIENT_BUDGET, DELEGATION_REVOKED,
// DELEGATION_EXPIRED, DAILY_LIMIT, KEY_INACTIVE, etc.), NO la atomicidad
// FOR UPDATE de Postgres. La atomicidad real (no-double-spend bajo concurrencia)
// se cubre en src/__tests__/e2e/delegation-atomicity.real.test.ts, gateado por
// INTEGRATION_TEST_DB_URL. Son complementarios — NO borrar estos mocks.
describe('debitDelegationAndParent', () => {
```

NO borrar ningún test mock. NO cambiar sus asserts.

### Gate W4
- Sin `INTEGRATION_TEST_DB_URL` → el describe se skippea con warn; suite verde
  (1324 + nuevos unit de W0/W2/W3).
- Con env (paso manual de QA): el test real corre contra PG y pasa (1 ok + 1
  `DELEGATION_TOTAL_LIMIT_EXCEEDED`; `total_spent = M`).

---

## 6. Done Definition (toda la HU)

- [ ] AC-1..AC-12 implementados; cada uno con ≥1 test asociado.
- [ ] `npx tsc --noEmit` → 0 errores.
- [ ] `npx biome check --write src/` → luego `npm run lint` → limpio.
- [ ] Suite completa verde: 1324 tests existentes + nuevos unit de
      `caller-hash.test.ts`, `compose.test.ts`, `reputation.test.ts`. Sin
      regresiones (CD-9).
- [ ] El RACE test (`delegation-atomicity.real.test.ts`) se skippea sin env (warn
      claro) y, ejecutado manualmente con DB real, pasa.
- [ ] `git diff src/middleware/a2a-key.ts` = SOLO sustitución del bloque inline
      por el patrón de 6 líneas (CD-12).
- [ ] Ningún `owner_ref` crudo en `a2a_events.metadata` ni en logs (CD-5).
- [ ] Scoring sigue siendo 1 query por path (CD-10).
- [ ] Sin nuevas dependencias; sin cambios de schema; sin cambio del shape de
      `AgentReputation` ni de endpoints (Scope OUT respetado).
- [ ] `delegation.test.ts` anotado (CD-4); mocks intactos.

---

*Story File generado por NexusAgil — WKH-104 — F2.5. El Dev SOLO lee este archivo.*
