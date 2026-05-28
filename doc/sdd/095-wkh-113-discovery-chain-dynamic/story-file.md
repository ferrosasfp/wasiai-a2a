# Story File — WKH-113 [BASE-08] discovery chain validation dinámica + compose chain-flow

> Contrato F2.5 autocontenido para el Dev (F3). El Dev SOLO lee este archivo.
> Si algo no está acá, NO se hace.
> SDD fuente: `doc/sdd/095-wkh-113-discovery-chain-dynamic/sdd.md` (SPEC_APPROVED).
> Branch: `feat/095-wkh-113-discovery-chain-dynamic`.
> Modo: QUALITY. Framework de test: vitest (`npm test` = `vitest run`).

---

## 0. Contexto compacto (qué se construye y por qué)

Hoy el gateway COBRA inbound en 3 chains (WKH-111 DONE) y el settle outbound interno
ya es chain-aware (WKH-112 DONE, `downstream-payment.ts`), pero el outbound real a
sub-agentes en Base/Kite/Fuji **sigue roto** porque dos gates upstream borran/sobrescriben
la chain antes de que llegue al settle:

- **GATE 1** (`discovery.ts`): `readPayment` rechaza con `undefined` toda chain fuera del
  `Set` literal `ALLOWED_CHAIN_VALUES` → `base-sepolia`/`avalanche-fuji` quedan fuera →
  `agent.payment = undefined` → downstream skip `NO_PAYMENT_FIELD`.
- **GATE 2** (`compose.ts`): `resolveAgent` resuelve primero vía `getAgent` (endpoint v2
  `agents/{slug}` que hardcodea `chain: avalanche`), no vía `discover()`/capabilities (que
  SÍ trae la chain real per-row).

Esta HU hace **wiring a2a-only** (sin tocar wasiai-v2, CD-6):

1. **W1 — Discovery**: `readPayment` reemplaza la allowlist hardcodeada por validación
   derivada de `normalizeChainSlug` (resolver puro), **preservando el shape de salida
   actual** (`avalanche-testnet`/`-mainnet` → `'avalanche'`; resto pass-through) → CERO
   regresión observable.
2. **W2 — Compose**: `resolveAgent` hidrata `payment` desde el path con la chain real
   (`discover()`/capabilities) cuando difiere de lo que trajo `getAgent`. No-op para
   Avalanche/Kite. Sin cambiar la firma.

Resultado: para un agente `chain=base-sepolia`, `agent.payment.chain` llega como
`base-sepolia` a `signAndSettleDownstream`. Avalanche/Kite quedan byte-idénticos.

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/services/discovery.ts` | Modificar `readPayment` + borrar `ALLOWED_CHAIN_VALUES` + import + JSDoc | W1.1 |
| `src/services/discovery.test.ts` | Extender (tests `readPayment`/`mapAgent`/`discover`) | W1.2 |
| `src/services/compose.ts` | Modificar `resolveAgent` (hidratación de chain real) | W2.1 |
| `src/services/compose.chain-flow.test.ts` | **CREAR** (integración discovery→compose) | W2.2 |

**PROHIBIDO tocar cualquier otro archivo** (ver §2 reglas NEVER).

---

## 2. Reglas NEVER (Constraint Directives — INVIOLABLES)

> Heredadas del work-item + SDD §6. Cualquier violación es **BLOQUEANTE** en AR/CR.

- **CD-1 / CD-9 — NEVER reintroducir un `Set`/array literal de slugs de chain** como fuente
  de verdad. PROHIBIDO `ALLOWED_CHAIN_VALUES`, `if (chain === 'base-sepolia')`, o acoplar
  discovery a `getInitializedChainKeys()`. La validación DEBE usar `normalizeChainSlug`
  (de `../adapters/chain-resolver.js`). Los aliases dentro de `chain-resolver.ts` NO son
  hardcode de esta HU (mapeo canónico reutilizado) y NO se modifican.
- **CD-2 — NEVER regresar Avalanche/Kite.** El `agent.payment` para agentes
  Avalanche/Kite DEBE ser idéntico al actual (misma `chain` normalizada, mismo
  `contract`/`asset`/`method`). Suite existente verde. Cualquier diff observable es
  **BLOQUEANTE**.
- **CD-7 — NEVER devolver el `ChainKey` de `normalizeChainSlug` como `chain` de salida.**
  `readPayment` DEBE seguir devolviendo el string legacy: `avalanche-testnet`/
  `avalanche-mainnet` → `'avalanche'`; resto pass-through. (Devolver el `ChainKey`
  cambiaría `'avalanche'` → `'avalanche-fuji'` y rompería CD-2 + tests `:179/221/273`.)
  La validación usa `normalizeChainSlug` SOLO para decidir aceptar/rechazar.
- **CD-8 — NEVER cambiar el agente resuelto cuando getAgent y discover concuerdan.** La
  hidratación en `resolveAgent` DEBE ser no-op observable para Avalanche/Kite (sin diff
  de chain). Test-afirmado (T-CD8a/b).
- **CD-10 / CD-5 — NEVER silent cross-chain.** La hidratación SOLO corrige `payment` desde
  el path con la chain real (`discover()`/capabilities). PROHIBIDO inferir la chain de
  otra fuente, hardcodear Base, o asumir una chain cuando `discover()` no trae el agente.
  Si la chain real no se puede determinar → conservar el `payment` de getAgent (fail-soft,
  comportamiento actual).
- **CD-11 — NEVER dejar un mock de `discovery.js` consumido por compose sin `discover`.**
  Tras los cambios correr el grep de W2.3. El mock de `compose.test.ts:29-31` YA exporta
  `getAgent` + `discover` (verificado). NO romperlo.
- **CD-4 — NEVER usar `any` explícito ni `as unknown`.** TS strict.
- **CD-3 — NEVER introducir ethers.js.** (No aplica directo; esta HU no toca firma onchain.)
- **CD-6 — NEVER tocar wasiai-v2.** Si el Dev cree que necesita tocar v2 → STOP, escalá.

### PROHIBIDO tocar (archivos fuera de scope)

- `src/adapters/chain-resolver.ts` — resolver puro, solo se importa.
- `src/adapters/registry.ts` ni ningún adapter.
- `src/lib/downstream-payment.ts` — WKH-112 DONE, solo recibe la chain correcta.
- `src/middleware/x402.ts` / `a2a-key.ts` — inbound, WKH-111 DONE.
- La firma pública de `resolveAgent` (`(step: ComposeStep) => Promise<Agent | null>`) ni
  de `signAndSettleDownstream`.

---

## 3. Anti-Hallucination Checklist (símbolos/firmas EXACTOS verificados)

> Todos verificados con Read/Grep en este repo el 2026-05-27. Paths absolutos al repo.

### 3.1 `normalizeChainSlug` — `src/adapters/chain-resolver.ts:61-66`

```ts
export function normalizeChainSlug(raw: string): ChainKey | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return undefined;
  return Object.hasOwn(SLUG_ALIASES, key) ? SLUG_ALIASES[key] : undefined;
}
```

- **Firma**: `(raw: string) => ChainKey | undefined`. **Puro, total, never-throw** (doc
  `:55-60`: "Total — never throws, never returns the default silently"). Trim + lowercase.
- **Módulo desacoplado**: `chain-resolver.ts` NO importa `./registry` (doc `:1-16`).
- **`SLUG_ALIASES`** (`:20-53`) acepta, entre otros: `avalanche`/`avalanche-testnet`/`fuji`/
  `43113`/`avalanche-fuji` → `'avalanche-fuji'`; `avalanche-mainnet`/`43114` →
  `'avalanche-mainnet'`; `kite-ozone-testnet`/`kite-testnet`/`2368` → `'kite-ozone-testnet'`;
  `kite-mainnet`/`2366` → `'kite-mainnet'`; `base-sepolia`/`base-testnet`/`84532` →
  `'base-sepolia'`; `base`/`base-mainnet`/`8453` → `'base-mainnet'`. Slug desconocido
  (`polygon`/`solana`) → `undefined`.
- ⚠️ **CRÍTICO CD-7**: `normalizeChainSlug('avalanche')` → `'avalanche-fuji'` (NO
  `'avalanche'`). Por eso NO se puede usar su retorno como `chain` de salida.

### 3.2 `readPayment` actual — `src/services/discovery.ts:65-111`

Estructura actual (la que se modifica en W1.1):

- `:56-63` — `const ALLOWED_CHAIN_VALUES = new Set([...])` → **BORRAR**.
- `:65-90` — armado de `methodRaw`/`chainRaw`/check de campos críticos →
  **CONSERVAR INTACTO** (incluye el fallback `obj.chain ?? raw.chain` y el guard
  `if (!methodRaw || !chainRaw || typeof obj.contract !== 'string') return undefined;`).
- `:92-95` — el check a reemplazar:
  ```ts
  // SEC-AR BLQ-MED-1: reject chain outside allowlist BEFORE normalization
  if (!ALLOWED_CHAIN_VALUES.has(chainRaw)) {
    return undefined;
  }
  ```
- `:97-103` — la normalización de salida a **CONSERVAR INTACTA** (CD-7):
  ```ts
  const chain =
    chainRaw === 'avalanche-testnet' || chainRaw === 'avalanche-mainnet'
      ? 'avalanche'
      : chainRaw;
  ```
- `:105-110` — el return a **CONSERVAR INTACTO**: `{ method: methodRaw, chain, contract:
  obj.contract as \`0x${string}\`, asset: typeof obj.asset === 'string' ? obj.asset : undefined }`.

### 3.3 `resolveAgent` — `src/services/compose.ts:328-337`

```ts
async resolveAgent(step: ComposeStep): Promise<Agent | null> {
  // Try with registry hint first, then without (LLM may pass wrong case)
  const agent = await discoveryService.getAgent(step.agent, step.registry);
  if (agent) return agent;
  const agentNoRegistry = await discoveryService.getAgent(step.agent);
  if (agentNoRegistry) return agentNoRegistry;
  // Fallback: fetch all agents and match by slug directly
  const result = await discoveryService.discover({ limit: 50 });
  return result.agents.find((a) => a.slug === step.agent) ?? null;
}
```

- **Firma a preservar**: `(step: ComposeStep) => Promise<Agent | null>`. NO cambiar.
- `ComposeStep` (`src/types/index.ts:162-171`) tiene `{ agent: string; registry?: string;
  input; passOutput? }`. El slug del agente es `step.agent`.
- `discoveryService.discover({ limit: 50 })` retorna `Promise<DiscoveryResult>`.

### 3.4 `discoveryService.discover` — shape de retorno CONFIRMADO

- Firma: `discover(query: DiscoveryQuery): Promise<DiscoveryResult>` (`discovery.ts:117`).
- `DiscoveryResult` (`src/types/index.ts:152-156`):
  ```ts
  export interface DiscoveryResult {
    agents: Agent[];
    total: number;
    registries: string[];
  }
  ```
- ✅ **Es `{ agents: Agent[]; total; registries }` — NO un array pelado.** Se accede como
  `(await discoveryService.discover({ limit: 50 })).agents.find(a => a.slug === ...)`
  (idéntico a como `resolveAgent:335-336` ya lo hace hoy).

### 3.5 `AgentPaymentSpec` — `src/types/index.ts:89-94`

```ts
export interface AgentPaymentSpec {
  method: string;          // e.g. 'x402'
  chain: string;           // e.g. 'avalanche'  ← string pass-through, NO ChainKey
  contract: `0x${string}`; // payTo on-chain address
  asset?: string;          // e.g. 'USDC' (opcional, pass-through)
}
```

- `chain` es `string` (pass-through). `Agent.payment?: AgentPaymentSpec` (`:134`).
- Doc `:87`: "Pass-through del raw response — no se normaliza chain/method (preservar shape)".

### 3.6 Mock de `discovery.js` en compose — `src/services/compose.test.ts:29-31`

```ts
vi.mock('./discovery.js', () => ({
  discoveryService: { getAgent: vi.fn(), discover: vi.fn() },
}));
```

- ✅ **Exporta `discover`** (además de `getAgent`). CD-11 satisfecho. NO romper.
- `beforeEach` (`compose.test.ts:136-141`) ya da defaults: `getAgent → null`,
  `discover → { agents: [], total: 0, registries: [] }`.
- El mock de downstream (`compose.test.ts:46-48`): `vi.mock('../lib/downstream-payment.js',
  () => ({ signAndSettleDownstream: vi.fn().mockResolvedValue(null) }))` — signature-agnóstico.
  Se importa como `mockDownstream = vi.mocked(signAndSettleDownstream)` (`:50,58`).

### 3.7 Fixture de `discovery.test.ts:46-67`

- `makeRawAgent(o = {}): Record<string, unknown>` (`:46-59`) — base raw agent; spread `o`
  para inyectar `slug`/`status`/`payment`/`chain`.
- `setupRegistryResponse(rawAgents)` (`:61-67`) — mockea `registryService.getEnabled` →
  `[makeRegistry()]` y `fetch` → `{ ok: true, json: () => Promise.resolve(rawAgents) }`.
- `makeRegistry(o = {})` (`:32-44`) — `discoveryEndpoint: 'https://example.com/agents'`.
- Mocks de archivo: `registry.js` (`:8-13`), circuit-breaker (`:16-20`), `fetch` global
  (`:22-23`). Imports: `discoveryService`, `_resetFallbackWarnDedup`, `parsePriceSafe`
  (`:25-29`).
- ✅ `mapAgent` se invoca como `discoveryService.mapAgent(registry, raw)` (usado en tests
  `:175,195,217,243`) — método público del objeto `discoveryService` (`discovery.ts:298`).

### 3.8 `mapAgent` / `getAgent` — `src/services/discovery.ts`

- `mapAgent(registry: RegistryConfig, raw: Record<string, unknown>): Agent` (`:298`),
  llama `payment: readPayment(raw)` (`:329`).
- `getAgent(slug: string, registryId?: string): Promise<Agent | null>` (`:336`), pega al
  `agentEndpoint` y mapea con `this.mapAgent` (`:369`). **MISMO** `mapAgent`/`readPayment`
  que `discover()` — la única diferencia es la fuente de datos (qué chain trae cada endpoint).

---

## 4. Waves de implementación (pasos EXACTOS por archivo)

> **REGLA tsc**: el typecheck autoritativo es
> `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit`
> (NO el `tsc --noEmit` pelado — reporta TS6059 preexistente; lección WKH-111/093).
> `tsconfig.build.json` excluye `*.test.ts`, así que valida solo producción.
> **REGLA npx**: usá siempre el path absoluto
> `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx`.

### Wave 0 — Serial Gate (baseline, NO toca código)

- [ ] **W0.1** — Correr `npm test` y registrar el **número exacto de tests verdes** ANTES
  de tocar nada (línea base de CD-2; al final W2 ese número debe ser ≥ baseline + nuevos).
- [ ] **W0.2** — Correr
  `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit`
  y confirmar baseline limpio (0 errores).
- [ ] **W0.3** — (opcional de confirmación, se materializa como T-AC1-discover en W1.2):
  con una fixture cuyo registry devuelve un raw con `payment.chain = 'base-sepolia'`,
  confirmar mentalmente que `discoveryService.discover()` produce
  `agents[0].payment.chain === 'base-sepolia'` (el path capabilities es la fuente correcta).
  Hoy daría `undefined` por GATE 1 → ese test PASA recién tras W1.1.

### Wave 1 — Discovery: validación dinámica (`src/services/discovery.ts`)

- [ ] **W1.1 — Modificar `readPayment` + borrar el `Set` + import + JSDoc**:
  1. **Importar** `normalizeChainSlug`. Agregar al bloque de imports de `discovery.ts`:
     ```ts
     import { normalizeChainSlug } from '../adapters/chain-resolver.js';
     ```
     (Verificar que el `.js` extension esté presente — convención ESM del repo.)
  2. **Borrar** `const ALLOWED_CHAIN_VALUES = new Set([...]);` (`:56-63`) completo (CD-1/CD-9).
  3. **Reemplazar** el check `:92-95`:
     ```ts
     // SEC-AR BLQ-MED-1: reject chain outside allowlist BEFORE normalization
     if (!ALLOWED_CHAIN_VALUES.has(chainRaw)) {
       return undefined;
     }
     ```
     por (DT-4/DT-5/AC-1/AC-5):
     ```ts
     // SEC-AR BLQ-MED-1 (WKH-113 DT-5): reject any chain the resolver does not
     // know BEFORE normalization. Dynamic validation derived from the pure
     // chain-resolver (no hardcoded slug allowlist — CD-1/CD-9). Unknown slug
     // (registry comprometido / chain exótica) → undefined, defensa preservada.
     if (normalizeChainSlug(chainRaw) === undefined) {
       return undefined;
     }
     ```
  4. **CONSERVAR INTACTA** la normalización de salida `:97-103` (CD-7):
     `avalanche-testnet`/`avalanche-mainnet` → `'avalanche'`; resto pass-through. ⚠️ NO
     reemplazar `chain` por el `ChainKey` de `normalizeChainSlug`. El valor de salida sigue
     siendo el string legacy.
  5. **CONSERVAR INTACTO** el return `:105-110`.
  6. **Actualizar el JSDoc** del bloque SEC-AR (`:30-54`): reemplazar la descripción de la
     "Allowlist actual" por la nueva semántica de validación dinámica vía `normalizeChainSlug`
     (acepta toda chain con adapter conocido; rechaza desconocidas; preserva el string de
     salida legacy). Mencionar WKH-113 + CD-1/CD-7/DT-4/DT-5.

- [ ] **W1.2 — Extender `src/services/discovery.test.ts`** (ver §5 Test Plan, tests
  T-AC1a, T-AC1b, T-AC2a, T-AC2b, T-AC5, T-AC1-discover, T-AC7). Usar `makeRawAgent` +
  `setupRegistryResponse` + `discoveryService.mapAgent(makeRegistry(), raw)` /
  `discoveryService.discover({})`. **NO regresar** los asserts existentes (`:179,221,273`
  → `'avalanche'`; `:301` → `'kite-ozone-testnet'`; `:244` → `undefined`).

- [ ] **W1.3 (verif)**:
  `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit`
  + `npm test` → suite completa verde (incl. nuevos discovery).

### Wave 2 — Compose: merge selectivo de chain real (`src/services/compose.ts`)

- [ ] **W2.1 — Modificar `resolveAgent` (`:328-337`)** con el algoritmo §4.3 del SDD
  (opción b, merge selectivo). **Sin cambiar la firma.** Algoritmo EXACTO:

  1. Resolver el agente como hoy (sin cambios en la cadena). Capturar **si vino del
     fallback discover** para reusar ese resultado y evitar la doble llamada:
     ```ts
     async resolveAgent(step: ComposeStep): Promise<Agent | null> {
       // Try with registry hint first, then without (LLM may pass wrong case)
       let agent = await discoveryService.getAgent(step.agent, step.registry);
       if (!agent) agent = await discoveryService.getAgent(step.agent);

       // WKH-113 (BASE-08): the real per-chain payment lives in the
       // capabilities/discover path (getAgent v2 hardcodes chain=avalanche, H14;
       // capabilities emits a.chain per-row, H15). Hydrate payment from discover
       // so the real ChainKey survives to signAndSettleDownstream (CD-5/CD-10).
       let discovered: Agent[] | undefined;
       if (!agent) {
         // Fallback: fetch all agents and match by slug directly.
         const result = await discoveryService.discover({ limit: 50 });
         discovered = result.agents;
         const fromDiscover = discovered.find((a) => a.slug === step.agent) ?? null;
         // Resolved via discover → ya tiene la chain real. No re-consultar.
         return fromDiscover;
       }

       // Resolved via getAgent → hydrate payment.chain from the path with the
       // real chain (only when it differs — no-op for Avalanche/Kite, CD-8).
       const real = (await discoveryService.discover({ limit: 50 })).agents.find(
         (a) => a.slug === agent.slug,
       );
       if (
         real?.payment?.chain &&
         real.payment.chain !== agent.payment?.chain
       ) {
         agent.payment = real.payment; // adopt the full payment of the real-chain path
       }
       return agent;
     }
     ```
  - **Detalle clave (CD-8 no-op)**: si `real.payment.chain === agent.payment?.chain`
    (Avalanche/Kite, ambos endpoints concuerdan) → NO se cambia `agent.payment` → no-op
    observable. También cubre el caso "ambos avalanche" tras el colapso de salida de W1.
  - **Detalle clave (GATE 1 ausente)**: si `agent.payment` está `undefined` (getAgent v2
    emitió avalanche pero, por algún path, no pobló payment) y `real.payment` existe →
    la condición `real.payment.chain !== agent.payment?.chain` es `true` (porque
    `agent.payment?.chain` es `undefined`) → se adopta `real.payment`. Cubierto.
  - **Detalle clave (CD-10 fail-soft)**: si `real` es `undefined` (agente fuera del top-50
    de discover o discover vacío) → `real?.payment?.chain` es falsy → NO se cambia nada →
    se conserva el `payment` de getAgent (comportamiento actual, no se asume Base).
  - **Detalle clave (anti doble llamada)**: si el agente se resolvió por el fallback
    `discover()` (rama `if (!agent)`), ese resultado YA tiene la chain real → se retorna
    directo sin re-consultar discover (mitigación del SDD §4.3 / Riesgo latencia).
  - ⚠️ TS strict (CD-4): NO usar `any`/`as unknown`. `agent` reasignable → `let agent`.
    `real.payment` es `AgentPaymentSpec | undefined`; el guard `real?.payment?.chain`
    estrecha el tipo. La asignación `agent.payment = real.payment` requiere que `real`
    esté narrowed a definido — usar `if (real?.payment?.chain && ...)` garantiza
    `real.payment` definido dentro del bloque.

  > NO tocar `invokeAgent` ni `signAndSettleDownstream`. El selector Base (`:416-420`) y el
  > downstream consumen `agent.payment.chain` ya corregido — una sola fuente (CD-5/AC-6).

- [ ] **W2.2 — Crear `src/services/compose.chain-flow.test.ts`** (ver §5 Test Plan, tests
  T-AC3-flow, T-CD8a, T-CD8b, T-CD10). **Estrategia (lección WKH-112): NO mockear
  `agent.payment` directo como output prefabricado de resolveAgent.** En su lugar simular
  la divergencia real getAgent↔discover:
  - Mockear `discoveryService.getAgent` → devuelve el agente con `payment.chain='avalanche'`
    (lo que el endpoint v2 hardcodea) — usar `mapAgent` real o un `Agent` construido con
    `makeAgent`, pero el `payment` debe venir de la fuente getAgent (avalanche), no del
    valor esperado base-sepolia.
  - Mockear `discoveryService.discover` → devuelve `{ agents: [<agente con
    payment.chain='base-sepolia'>], total, registries }` (lo que capabilities emite).
  - Llamar `composeService.resolveAgent({ agent: 'base-pay-agent', input: {} })` y afirmar
    que el `agent.payment.chain === 'base-sepolia'`.
  - Para el flujo extremo a borde-del-settle (AC-3/AC-6): correr `composeService.invokeAgent`
    o `compose` con el mock de `signAndSettleDownstream` (ya en el patrón de `compose.test.ts`)
    y capturar el `agent` que llega vía `mockDownstream.mock.calls[0][0]`; afirmar
    `payment.chain === 'base-sepolia'`.
  - Reusar el setup de mocks de `compose.test.ts` (encabezado `:14-58`): `registry.js`,
    `budget.js`, `adapters/registry.js`, `discovery.js` (ya exporta `getAgent`+`discover`),
    `event.js`, `fetch` global, `llm/transform.js`, `downstream-payment.js`. **CD-11**:
    el `vi.mock('./discovery.js')` del nuevo archivo DEBE exportar `getAgent` **y** `discover`.

- [ ] **W2.3 (verif)**:
  1. `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit`.
  2. `npm test` → suite completa verde (≥ baseline W0.1 + nuevos tests).
  3. **CD-11 grep**:
     ```bash
     grep -rn "vi.mock('./discovery" src/ ; grep -rn "vi.mock('../services/discovery" src/ ; grep -rn "vi.mock('../../services/discovery" src/
     grep -rn "vi.mock.*chain-resolver" src/
     ```
     Verificar: **todo mock de `discovery.js` que sea consumido por el path real de
     `compose.resolveAgent` DEBE exportar `discover`** (no solo `getAgent`).
     - `compose.test.ts:29-31` → exporta ambos ✅ (no romper).
     - `compose.chain-flow.test.ts` (nuevo) → DEBE exportar ambos.
     - ⚠️ `orchestrate.test.ts:22-25` exporta solo `discover` PERO mockea `./compose.js`
       entero (`:28`) → NO ejercita el `resolveAgent` real → NO es break point. Confirmar
       que sigue verde; si fallara, es señal de que algo más cambió.
     - `agent-price.test.ts:8-11` exporta solo `getAgent` → NO consume `compose.resolveAgent`
       → fuera de alcance. Confirmar que sigue verde.

### Wave 3 — Validación E2E (la corre el humano/QA, fuera del pipeline Dev)

- [ ] **W3.1** — Evidencia onchain outbound en las 3 chains vía `/compose` contra gateway
  con las 3 testnets + facilitator + operator funded (requiere agente invocable
  `base-sepolia` — NCL-OPS-1, no bloquea el código). Avalanche/Kite = regresión (tx hash
  status 0x1); base-sepolia = nuevo (tx hash en `sepolia.basescan.org`, AC-4).
- [ ] **W3.2** — Confirmar suite completa verde, cero regresión Avalanche/Kite (AC-2/CD-2).

---

## 5. Tests requeridos (Test Plan — mapeo 1-a-1, ~11 unit/integration + 1 smoke)

> Framework: vitest. ≥1 test por AC.

| Test | AC/CD | Wave | Archivo | Qué prueba / qué se mockea |
|------|-------|------|---------|----------------------------|
| **T-AC1a** acepta base-sepolia | AC-1/CD-1 | W1.2 | discovery.test.ts | `mapAgent`/`discover` con `payment.chain='base-sepolia'` → `payment.chain === 'base-sepolia'` (antes daba `undefined`). |
| **T-AC1b** acepta avalanche-fuji + chainId | AC-1/AC-7 | W1.2 | discovery.test.ts | `chain='avalanche-fuji'` → `'avalanche-fuji'` (pass-through); `chain='84532'` → `'84532'` (aceptado, pass-through). |
| **T-AC2a** regresión avalanche normalizado ⚠️ | AC-2/CD-2/CD-7 | W1.2 | discovery.test.ts | `chain='avalanche'` → `'avalanche'`; `chain='avalanche-testnet'` → `'avalanche'`; `chain='avalanche-mainnet'` → `'avalanche'`. **AFIRMAR explícitamente NO `'avalanche-fuji'`** (este es el invariante CD-7 que evita el bug silencioso). |
| **T-AC2b** regresión kite pass-through | AC-2/CD-2/CD-7 | W1.2 | discovery.test.ts | `chain='kite-ozone-testnet'` → `'kite-ozone-testnet'` (pass-through, sin cambio). |
| **T-AC5** chain desconocida → undefined | AC-5/DT-5 | W1.2 | discovery.test.ts | `chain='polygon'` y `chain='solana'` → `readPayment` undefined → `agent.payment` undefined (defensa SEC-AR preservada). |
| **T-AC1-discover** discover expone base-sepolia | AC-1/AC-3 | W1.2 | discovery.test.ts | `discover({})` con fixture `chain='base-sepolia'` → `agents[0].payment.chain === 'base-sepolia'`. |
| **T-AC7** avalanche-fuji habilitado | AC-7 | W1.2 | discovery.test.ts | Agente `chain='avalanche-fuji'` (hoy `payment=null`) → ahora `payment` poblado con `chain='avalanche-fuji'`. |
| **T-AC3-flow** chain real Base sobrevive discovery→compose ⚠️ | AC-3/AC-6/CD-5/CD-10 | W2.2 | compose.chain-flow.test.ts | `getAgent` mock → `payment.chain='avalanche'` (hardcode v2); `discover` mock → `payment.chain='base-sepolia'` (real). `resolveAgent('base-pay-agent')` → `agent.payment.chain === 'base-sepolia'`. Vía `invokeAgent`/`compose` + mock `downstream`, capturar `mockDownstream.mock.calls[0][0].payment.chain === 'base-sepolia'`. **NO mockea `agent.payment` directo como output prefabricado.** |
| **T-CD8a** merge no-op avalanche | AC-2/CD-8 | W2.2 | compose.chain-flow.test.ts | `getAgent` → avalanche + `discover` → avalanche (mismo `payment`). `resolveAgent` → `payment` idéntico al de getAgent. Sin cross-chain. |
| **T-CD8b** merge no-op kite | AC-2/CD-8 | W2.2 | compose.chain-flow.test.ts | `getAgent` → kite-ozone-testnet + `discover` → kite-ozone-testnet. `payment` final == getAgent. |
| **T-CD10** chain real no encontrada → fail-soft | CD-5/CD-10 | W2.2 | compose.chain-flow.test.ts | `getAgent` → avalanche; `discover` → `{ agents: [] }` (no trae el agente). `resolveAgent` conserva el `payment` de getAgent (no asume Base, no cross-chain). |
| **smoke outbound** (E2E) | AC-4/AC-2 | W3.1 | (humano/QA) | tx hash en Basescan (base-sepolia) + status 0x1 Avalanche/Kite. Fuera del pipeline Dev. |

**Cobertura AC**: AC-1 (T-AC1a/b, T-AC1-discover), AC-2 (T-AC2a/b, T-CD8a/b), AC-3
(T-AC3-flow), AC-4 (smoke), AC-5 (T-AC5), AC-6 (T-AC3-flow), AC-7 (T-AC1b, T-AC7).

---

## 6. Patrones a seguir (exemplars verificados)

- **Validación dinámica en `readPayment`** → patrón `normalizeChainSlug`
  (`src/adapters/chain-resolver.ts:61-66`): puro, never-throw, slug desconocido →
  `undefined`. Ya usado inbound (WKH-111) y downstream (WKH-112). Reutilizar, no duplicar.
- **Merge selectivo en `resolveAgent`** → reusar la cadena existente
  (`compose.ts:328-337`) + el patrón de acceso `result.agents.find(a => a.slug === ...)`.
- **Tests discovery** → fixture `discovery.test.ts:46-67` (`makeRawAgent` +
  `setupRegistryResponse`) y asserts `:157-304` (`mapAgent`/`discover` → `payment.chain`).
- **Tests compose** → encabezado de mocks `compose.test.ts:14-58` + helpers `makeAgent`
  (`:61-77`), `makeRegistry` (`:78-90`), `mockFetchOk` (`:119-125`), `mockDownstream`
  (`:50,58`). Patrón de captura del arg a downstream: `mockDownstream.mock.calls[0][0]`.

---

## 7. Done Definition

- [ ] `ALLOWED_CHAIN_VALUES` borrado; `readPayment` valida con `normalizeChainSlug`
      (CD-1/CD-9) y preserva el string de salida legacy (CD-7).
- [ ] `resolveAgent` hidrata `payment` desde `discover()`/capabilities cuando difiere; no-op
      para Avalanche/Kite (CD-8); fail-soft si discover no trae el agente (CD-10); sin
      cambiar la firma; sin doble llamada a discover cuando se resolvió por el fallback.
- [ ] `discovery.test.ts` extendido (T-AC1a/b, T-AC2a/b, T-AC5, T-AC1-discover, T-AC7) sin
      regresar asserts existentes.
- [ ] `compose.chain-flow.test.ts` creado (T-AC3-flow, T-CD8a/b, T-CD10) sin mockear
      `agent.payment` directo como output prefabricado.
- [ ] `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit`
      limpio (0 errores).
- [ ] `npm test` → suite completa verde, ≥ baseline W0.1 + nuevos tests. Cero regresión.
- [ ] CD-11 grep ejecutado: todo mock de `discovery.js` consumido por `compose.resolveAgent`
      exporta `discover`.
- [ ] CERO archivos tocados fuera de los 4 del Scope IN. No `any`/`as unknown`. No ethers.
      No wasiai-v2. No `downstream-payment.ts`/adapters/chain-resolver.

> **No bloquea el código** (operacional, lo escala el orquestador al humano): NCL-OPS-1 —
> agente invocable `base-sepolia` para la evidencia onchain de AC-4 (W3). El flujo se valida
> con T-AC3-flow (integración con fixture).

---

*Story File generado por NexusAgil — F2.5 — WKH-113 (BASE-08)*
