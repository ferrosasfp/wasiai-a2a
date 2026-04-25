# SDD — WKH-55 Downstream x402 Payment (wasiai-a2a → Fuji USDC)

| Campo | Valor |
|---|---|
| **HU-ID** | WKH-55 |
| **Fecha** | 2026-04-24 |
| **Status** | SPEC IN PROGRESS |
| **Sizing** | QUALITY / L |
| **SDD_MODE** | full |
| **Branch** | `feat/wkh-55-downstream-x402-fuji` |
| **Work Item** | `doc/sdd/054-wkh-55-downstream-x402-fuji/work-item.md` |
| **Pipeline** | F2 (este SDD) → F2.5 (story-WKH-55.md) → F3 → AR → CR → F4 → DONE |
| **Architect** | nexus-architect (one-shot) |

---

## 0. Lección clave heredada

> **AB-WFAC-52-1 (auto-blindaje)**: prohibido codear sin pipeline NexusAgil completo. Este SDD es la pre-condición de F3. Cualquier desvío (ej: el Dev escribe sin Story File, AR omite checks de IDOR, CR no cita archivo:línea) viola la metodología y se documenta en la retro de WKH-55.

> **AB-WKH-53-#2 (auto-blindaje)**: el Architect debe verificar con `Read`/`Grep` cada assert que mencione antes de escribirlo en el Story File. Para WKH-55, **todo path/línea/función citada en este SDD fue verificada en disco**.

> **AB-WKH-44-#2 (auto-blindaje)**: cuando un test mockea Supabase u otro chain builder (`viem.signTypedData`, `fetch`), el mock debe replicar EXACTAMENTE la cadena del impl. WKH-55 lo aplica al mock de viem (DT-K).

---

## 1. Resumen ejecutivo

Cuando `composeService.invokeAgent` invoca un agente del marketplace wasiai-v2 cuya agent card declara un campo `payment` con `method='x402'` y `chain='avalanche'`, **añadir** (de forma aditiva al `x-agent-key`) un pago downstream EIP-3009 sobre USDC canónico de Fuji (`eip155:43113`, 6 decimales). El flujo: pre-flight balance check via viem `readContract(USDC.balanceOf)` → firma EIP-3009 con domain `name='USD Coin', version='2'` → POST `/verify` y `/settle` al `WASIAI_FACILITATOR_URL` ya live → propagar `downstreamTxHash`, `downstreamBlockNumber`, `downstreamSettledAmount` por el `StepResult` y de ahí al body de `/compose` y `/orchestrate`. Todo gateado por `WASIAI_DOWNSTREAM_X402=true`. Si el flag no está presente, el sistema se comporta bit-exact igual al baseline (AC-1, AC-12).

---

## 2. Codebase grounding (archivos verificados)

> Política: cada path siguiente fue abierto con `Read` y la línea citada confirmada visualmente. Nada inventado.

| Archivo | Líneas | Por qué se leyó | Patrón / hallazgo extraído |
|---|---|---|---|
| `src/adapters/kite-ozone/payment.ts` | 1-457 | Exemplar de signing EIP-3009 en este repo (NO se reusará tal cual — distinta cadena/decimales) | (a) `signTypedData` con domain `{ name, version, chainId, verifyingContract }` y `primaryType='TransferWithAuthorization'` (L296-317). (b) `validBefore = now + 300s` (L287). (c) Nonce = `'0x' + randomBytes(32).toString('hex')` (L281). (d) **Anti-patrón a evitar**: no existe pre-flight balance check; en Fuji sí lo necesitamos (AC-10). (e) `_walletClient` cacheado lazy (L129-145). |
| `src/services/compose.ts` | 1-225 | Punto de inyección del hook downstream | (a) `invokeAgent(agent, input, a2aKey)` (L164) ya hace upstream Kite x402 cuando `agent.priceUsdc > 0` (L182-197). (b) Devuelve `{ output, txHash }` (L223). (c) **Punto exacto de inyección: post `data.json()` y antes del `return`** (L205-223): después de validar `response.ok`, antes del `return`. (d) **Línea 189 contiene la fórmula PYUSD-18**: `BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12)` — esta fórmula es CORRECTA para Kite/PYUSD y NO SE TOCA. La nueva lógica usa fórmula distinta para USDC-Fuji (6 decimales). (e) `StepResult.txHash` ya existe (L77) — añadiremos hermanos `downstreamTxHash`, etc. |
| `src/services/orchestrate.ts` | 1-471 | Cómo se propagan tx hashes por response | (a) `OrchestrateResult` se compone con `pipeline: ComposeResult` (L462), por lo que los `StepResult[]` viajan como `pipeline.steps`. (b) `kiteTxHash` se inyecta en route (no service) — patrón espejo para downstream **NO** se necesita en service: el `downstreamTxHash` vive a nivel `StepResult`, no a nivel orchestrate global. |
| `src/services/registry.ts` | 1-205 | Donde se podría tocar el mapping registry-level | **HALLAZGO clave**: NO contiene `agentMapping`. El mapping de campos vive en `discovery.ts:184-216`. Esta linea del work-item ("añadir `payment` mapping en `services/registry.ts:agentMapping`") está mal — el mapping de agents está en `discovery.ts:mapAgent`, no en `registry.ts`. **DT-L corrige el work-item**. |
| `src/services/discovery.ts` | 1-279 | Donde se transforma raw agent card → tipo Agent | (a) `mapAgent(registry, raw)` L184-216 — usa `getNestedValue(raw, mapping.x ?? 'x')` por cada campo conocido. (b) Devuelve un objeto `Agent` con `metadata: raw` (L214) — el raw agent card completo está accesible bajo `agent.metadata`. (c) **Decisión**: el campo `payment` se mapea AQUÍ, leyendo `raw.payment` directamente (no via `agentMapping` field — pass-through). No se modifica `AgentFieldMapping` (Scope OUT del work-item). |
| `src/types/index.ts` | 1-513 | Tipos a extender | (a) `Agent` interface L89-104 — add `payment?: AgentPaymentSpec`. (b) `StepResult` L159-169 — add `downstreamTxHash?`, `downstreamBlockNumber?`, `downstreamSettledAmount?`. (c) `AgentFieldMapping` L67-77 — **NO se toca** (Scope OUT). (d) `OrchestrateResult` L211-223 — **NO se toca**: los downstream tx viajan dentro de `pipeline.steps[*]`. |
| `src/middleware/a2a-key.ts` | 1-218 | Confirmar Scope OUT | NO se modifica. CD-4 lo prohíbe. Verificado: la lógica de auth inbound es ortogonal al downstream. |
| `src/middleware/x402.ts` | line 20, 177 | Cómo viaja `kiteTxHash` upstream | `request.paymentTxHash` se setea aquí (L177) y se lee en `routes/compose.ts:74` y `routes/orchestrate.ts:80`. **Confirmado**: `kiteTxHash` es upstream-only (cliente paga al gateway), independiente del downstream que añadimos. |
| `src/routes/compose.ts` | 1-81 | Shape de la response de `/compose` | L74-75: `const kiteTxHash = request.paymentTxHash; return reply.send({ kiteTxHash, ...result });`. El body actual es `{ kiteTxHash, success, output, steps[*], totalCostUsdc, totalLatencyMs }`. Cada `steps[i]` es un `StepResult`. **Decisión**: NO añadir un campo top-level `downstreamTxHash` — los downstream hashes son per-step (un compose puede tener N agentes con N pagos distintos). Quedan en `steps[i].downstreamTxHash`. |
| `src/routes/orchestrate.ts` | 1-100 | Shape de la response de `/orchestrate` | L80-81: igual patrón. `pipeline: ComposeResult` → `pipeline.steps[*].downstreamTxHash` ya estará disponible sin tocar el route. **CONCLUSIÓN**: `routes/compose.ts` y `routes/orchestrate.ts` NO requieren cambio alguno. |
| `src/services/compose.test.ts` | 1-80 | Patrón de mocking en tests existentes | Mocks usan `vi.stubGlobal('fetch', mockFetch)` (L26), `vi.mock('../adapters/registry.js')` (L13), `vi.mock('./registry.js')` (L11). Helpers `makeAgent(o)` (L37) y `makeRegistry(o)` (L57). Patrón a seguir para los nuevos tests. |
| `src/lib/` (lista) | — | Confirmar que `downstream-payment.ts` es archivo nuevo | Existen: `circuit-breaker.ts`, `gasless-signer.test.ts`, `supabase.ts`. NO existe `downstream-payment.ts`. ✅ Camino libre. |
| `src/__tests__/unit/` | — | El work-item dice `src/__tests__/unit/downstream-payment.test.ts` | **HALLAZGO**: la carpeta `src/__tests__/unit/` NO EXISTE en este repo. Existen `src/__tests__/cors.test.ts` y `src/__tests__/e2e/`. Los tests unitarios viven CO-LOCATED con el código (`*.test.ts` en la misma carpeta). **DT-M corrige el path**: el test del nuevo módulo va en `src/lib/downstream-payment.test.ts` (co-located, igual que `circuit-breaker.test.ts`). |
| `wasiai-facilitator/src/chains/avalanche.ts` | 1-528 | Adapter Fuji destino — referencia operacional | (a) USDC Fuji `0x5425890298aed601595a70AB815c96711a31Bc65`, decimals=6, eip712Name=`'USD Coin'`, eip712Version=`'2'` (L74-81). (b) `_settleRaw` valida `network==='eip155:43113'`, `asset===token.address`, `validBefore > now`, recover EIP-712, simulate, write, waitReceipt (L368-517). (c) Body esperado por `/verify` y `/settle`: `{ x402Version: 2, accepted: { scheme:'exact', network:'eip155:43113', amount, asset, payTo, maxTimeoutSeconds }, payload: { signature, authorization } }` — mismo shape que `kite-ozone/payment.ts:373-394` (`buildX402CanonicalBody`). |
| `.env.example` | 1-60 | Plantilla pública | NO contiene `WASIAI_DOWNSTREAM_X402` ni `FUJI_*`. Hay que añadir sección nueva (Wave 5). |
| `doc/sdd/053-wkh-53-rls-ownership/auto-blindaje.md` | 1-86 | Auto-blindaje reciente | Lecciones AB-WKH-53-#2 y #4 (verificar asserts en disco antes de mencionarlos en story; QA debe comparar story vs git diff). Aplicado en este SDD (sección §2 grounding y §11 readiness). |
| `doc/sdd/044-wkh-44-protocol-fee/auto-blindaje.md` | 1-49 | Auto-blindaje reciente | Lección AB-WKH-44-#2: el mock debe replicar EXACTAMENTE el chain del impl. Aplicado en DT-K (mocking strategy). |
| `doc/sdd/052-wkh-52-pyusd-migration/sdd.md` | 1-60 | SDD reciente — patrón "warn-once" para defaults | Aplicado en DT-N (warn-once para `FUJI_USDC_ADDRESS` ausente). |

---

## 3. Architecture overview

### 3.1 Diagrama del flujo completo (upstream + downstream)

```
┌──────────────┐     1. POST /compose                  ┌──────────────────────┐
│   Cliente    │ ───── (con header X-Payment Kite ────▶│  WasiAI A2A Gateway  │
│ (paga Kite)  │     ó x-a2a-key) ───────────────────  │  (este repo)         │
└──────────────┘                                       └──────────────────────┘
                                                                   │
              2. middleware/x402.ts:177                             │
              setea request.paymentTxHash = kiteTxHash              │
                                                                   ▼
                                                       ┌──────────────────────┐
                                                       │  composeService      │
                                                       │   .invokeAgent()     │
                                                       └──────────────────────┘
                                                                   │
                              3. fetch(agent.invokeUrl, {           │
                                  headers: { x-a2a-key, ... },     │
                                  body: input })                    │
                                                                   ▼
                                                       ┌──────────────────────┐
              ┌────────────────────────────────────────│  Marketplace agent   │
              │ 4. (NUEVO WKH-55, opt-in flag)         │  (wasiai-v2)         │
              │    si invoke OK + flag + agent.payment │                      │
              │      method='x402' chain='avalanche'   └──────────────────────┘
              ▼
   ┌─────────────────────────┐    5a. readContract(USDC.balanceOf, operator)
   │ src/lib/                │    5b. signTypedData(EIP-3009, USDC-Fuji)
   │   downstream-payment.ts │ ─▶ 5c. POST /verify  ◀──┐
   │   .signAndSettle()      │ ─▶ 5d. POST /settle  ───┤   ┌────────────────────┐
   └─────────────────────────┘                         └──▶│ wasiai-facilitator │
              │                                            │  (Fuji adapter)    │
              │ 6. result: { ok, txHash, blockNumber }    │  ya live           │
              ▼                                            └────────────────────┘
   StepResult.downstreamTxHash = result.txHash                      │
   StepResult.downstreamBlockNumber                                  │
   StepResult.downstreamSettledAmount                                ▼
              │                                          On-chain transfer Fuji USDC:
              ▼                                            from = operator wallet
   ComposeResult.steps[i].downstreamTxHash               ───▶ to = agent.payment.contract
              │
              ▼
   routes/compose.ts:75:    return { kiteTxHash, ...result };
   (kiteTxHash = upstream Kite, steps[i].downstreamTxHash = downstream Fuji)
```

### 3.2 Punto exacto de inyección del hook (post-invoke success)

En `src/services/compose.ts:invokeAgent` el código actual termina así:

```ts
// L198-223 (snippet conceptual, NO copiar tal cual)
const response = await fetch(agent.invokeUrl, { ... });
if (!response.ok) throw new Error(...);
const data = (await response.json()) as Record<string, unknown>;
const output = data.result ?? data;
let txHash: string | undefined;        // upstream Kite settle (existente)
if (paymentRequest) { ... settle Kite ... }
return { output, txHash };             // ← aquí termina hoy
```

El hook nuevo se inyecta **entre el settle Kite (L208-222) y el `return` de la línea 223**:

```ts
// PSEUDOCÓDIGO — el código real lo escribe el Dev en F3 según story.
let downstream: DownstreamResult | null = null;
if (DOWNSTREAM_FLAG_ON && agent.payment?.method === 'x402' && agent.payment.chain === 'avalanche') {
  downstream = await signAndSettleDownstream(agent, request.log);
  // signAndSettleDownstream NUNCA throw (CD-6, AC-4)
  // En error o saldo insuficiente devuelve null
}
return { output, txHash, downstream };
```

Y en el caller de `invokeAgent` (`composeService.compose`, L70-78), se mergea `downstream` al `StepResult`:

```ts
const { output, txHash, downstream } = await this.invokeAgent(agent, input, a2aKey);
const result: StepResult = {
  agent, output, costUsdc: agent.priceUsdc, latencyMs, txHash,
  ...(downstream && {
    downstreamTxHash: downstream.txHash,
    downstreamBlockNumber: downstream.blockNumber,
    downstreamSettledAmount: downstream.settledAmount,
  }),
};
```

### 3.3 Cómo se propaga `downstreamTxHash` por todos los layers

| Layer | Mecanismo | Archivo |
|---|---|---|
| Service interno | `invokeAgent` retorna `{ output, txHash, downstream }` | `src/services/compose.ts` |
| Service externo | `composeService.compose` lo mete en `StepResult` (spread condicional) | `src/services/compose.ts` |
| Service orchestrate | `OrchestrateResult.pipeline.steps[i]` ya incluye `StepResult` (sin cambio en orchestrate) | `src/services/orchestrate.ts` (NO se modifica) |
| Route compose | `reply.send({ kiteTxHash, ...result })` — `result.steps[i]` ya tiene `downstreamTxHash` | `src/routes/compose.ts` (NO se modifica) |
| Route orchestrate | Análogo — `pipeline.steps[i]` ya lo lleva | `src/routes/orchestrate.ts` (NO se modifica) |

**Decisión clave**: `routes/compose.ts` y `routes/orchestrate.ts` NO se modifican. La propagación sale gratis del shape ya existente. Esto reduce superficie de cambio y aleja regresiones.

---

## 4. Resoluciones de Missing Inputs y DTs pendientes del work-item

### 4.1 DT-E (timing) — DECISIÓN: **POST-invoke**

**Recomendación**: el downstream payment se ejecuta **después** del invoke al agente, sólo si el invoke devolvió `response.ok`. Razón:

1. **Pay-on-delivery semántico**: si el agente devuelve 5xx o lanza, el upstream invoke (cliente paga al gateway en Kite) **ya cobró por el orquestador** — el orquestador no debe pagar al merchant si el merchant falló.
2. **Alineamiento con AC-4**: AC-4 dice que el downstream failure no bloquea al caller. Esto solo tiene sentido si el invoke ya completó (su valor de retorno es lo que el cliente espera). Si el orden fuera "settle primero, invoke después", un settle exitoso seguido de invoke fallido produciría un cobro sin entrega — peor que no cobrar.
3. **Retry-friendly futuro**: si en V2 se añade reintento del settle (V2 backlog), poder reintentar después del invoke OK es trivial; antes del invoke acoplaría retry semántico al lifecycle del request HTTP.

**Trade-off documentado**: el merchant (marketplace wasiai-v2) acepta que el pago llegue "tardío" (después de servir) en lugar de "no llegar" (antes de fallar). El Architect considera este trade-off aceptable para V1 hackathon. Una arquitectura full-escrow (commit→deliver→settle con liquidación on-chain de un contrato) es V3 y queda en backlog (WKH-56+).

### 4.2 MI-1 — agent.payment expuesto en wasiai-v2 capabilities

**Resolución (asunción documentada para V1)**: wasiai-v2 expone `payment: { method, asset, chain, contract }` en cada agent card devuelto por `GET /api/v1/capabilities`. El audit del work-item dice que esto está **parcialmente** implementado (capabilities/route.ts:95-100). Para WKH-55:

- El gateway de a2a NO depende de que esto esté ya en producción: si el agent card no expone `payment` (campo ausente o null), AC-5/AC-6 hacen skip graceful. Bit-exact compatibility con baseline.
- **Acción para QA en F4**: ejecutar un curl runtime contra `https://wasiai-v2-production.<dominio>/api/v1/capabilities` y verificar que al menos 1 agente expone el campo `payment`. Si NO lo expone, el feature está deployado pero "dormido" hasta que WAS-V2-1 (paralelo) lo encienda.
- **No bloqueante para merge** de WKH-55: la HU es aditiva con flag off por default.

### 4.3 MI-2 — agentMapping en Supabase

**Resolución**: NO se requiere cambio de schema. Razón (verificada en codebase grounding §2):

- `discovery.ts:mapAgent` (L184-216) usa `mapping.<field> ?? '<field>'` — si el `AgentFieldMapping` del registry NO declara el path, cae al default literal. Para `payment` el default sería simplemente `raw.payment`.
- Como el `payment` es un objeto (no un string scalar) y queremos pass-through completo del shape, **NO** se mapea via `getNestedValue` con un path string. Se lee `raw.payment` y se valida con un type guard.
- **Por lo tanto**: NO se añade `payment?: string` a `AgentFieldMapping` (Scope OUT del work-item §123). El campo `Agent.payment` se setea en `mapAgent` con un bloque dedicado (DT-O).

### 4.4 MI-3 — DECISIÓN: post-invoke (resuelto en §4.1)

### 4.5 MI-4 — `payment.contract` semántica

**Resolución (asunción documentada)**: el `payment.contract` declarado en el agent card de wasiai-v2 es **la dirección on-chain en Fuji que recibirá la USDC** (operator wallet del marketplace o contrato escrow del marketplace). El gateway lo USA TAL CUAL como campo `to` del `TransferWithAuthorization` (AC-8). Validaciones runtime mínimas:

1. Validar formato `0x[0-9a-fA-F]{40}` con regex (mismo patrón que `payment.ts:77`). Si no matchea → skip + log warn `INVALID_PAY_TO_FORMAT` (extiende AC-4/AC-6 sin nuevo AC).
2. Validar que NO sea zero-address `0x0000...0000`. Si lo es → skip + log warn `ZERO_PAY_TO`.
3. NO se hace checksum-verify on-chain (R-1 en work-item) — eso requeriría un read additional. V2.

### 4.6 Resolución consolidada de [NEEDS CLARIFICATION]

| MI | Estado |
|---|---|
| MI-1 | RESUELTO §4.2 — pass-through, no bloquea |
| MI-2 | RESUELTO §4.3 — no requiere migration de schema |
| MI-3 | RESUELTO §4.1 — post-invoke |
| MI-4 | RESUELTO §4.5 — pass-through con validación format/zero |

**Cero `[NEEDS CLARIFICATION]` quedan abiertos** después de este SDD. El Readiness Check (§11) lo verifica explícitamente.

---

## 5. Decisiones técnicas (heredadas + nuevas)

### Heredadas del work-item (DT-A..DT-F)

| # | Resumen | Estado |
|---|---|---|
| DT-A | Feature flag booleano `WASIAI_DOWNSTREAM_X402='true'` — read once a module load | Heredada |
| DT-B | Downstream es ADITIVO al `x-agent-key`, NO reemplaza | Heredada |
| DT-C | Operator wallet `OPERATOR_PRIVATE_KEY` reusada multi-chain (Kite + Fuji) | Heredada — V1 acepta el riesgo (sin var separada). V2 backlog: `FUJI_OPERATOR_PRIVATE_KEY` opcional. |
| DT-D | Mismo `WASIAI_FACILITATOR_URL` con `network: 'eip155:43113'` | Heredada |
| DT-E | Timing post-invoke | RESUELTA §4.1 |
| DT-F | 6 decimales para USDC Fuji, NO 18 | Heredada |

### Nuevas (DT-G..DT-O) — nivel implementación

#### DT-G — Módulo nuevo `src/lib/downstream-payment.ts`

API pública (la única función exportada):

```ts
export interface DownstreamResult {
  txHash: `0x${string}`;
  blockNumber: number;
  settledAmount: string; // atomic units (string, 6-dec USDC)
}

export interface DownstreamSkipReason {
  code:
    | 'FLAG_OFF'
    | 'NO_PAYMENT_FIELD'
    | 'METHOD_NOT_SUPPORTED'
    | 'CHAIN_NOT_SUPPORTED'
    | 'INVALID_PAY_TO_FORMAT'
    | 'ZERO_PAY_TO'
    | 'INSUFFICIENT_BALANCE'
    | 'BALANCE_READ_FAILED'
    | 'SIGNING_FAILED'
    | 'VERIFY_FAILED'
    | 'SETTLE_FAILED'
    | 'NETWORK_ERROR';
  detail?: string;
}

/**
 * Sign EIP-3009 + POST /verify + POST /settle. NEVER throws.
 * Returns null on any skip or failure (logs warn). Returns { ok:true, ... }
 * only when the facilitator confirmed `settled: true`.
 */
export async function signAndSettleDownstream(
  agent: Agent,
  logger: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void },
): Promise<DownstreamResult | null>;
```

**Por qué módulo nuevo y no extender `kite-ozone/payment.ts`**: CD-NEW-SDD-1 — desacoplar; el adapter de Kite tiene su propia interface (`PaymentAdapter`) y mezclar Fuji ahí rompería el principio "1 adapter por chain" (ver `doc/architecture/CHAIN-ADAPTIVE.md` mencionado en types).

#### DT-H — Pre-flight balance check ANTES de firmar

Implementación: viem `readContract({ address: FUJI_USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [operator.address] })`. Si `balance < requiredAtomicValue`, return `null` con log warn `INSUFFICIENT_BALANCE` (AC-10). No se firma ni se llama al facilitator.

**Trade-off latencia**: añade 1 RPC roundtrip (~150-400ms) en el camino crítico. Aceptado para V1 — la pérdida de gas + USDC por intentar settle sin saldo es peor.

#### DT-I — `validBefore = now + 300s`

Mismo valor que `kite-ozone/payment.ts:287`. Razón: el facilitator Fuji valida `validBefore > now` (`avalanche.ts:251` en wasiai-facilitator). 300s da margen para round-trips.

#### DT-J — Nonce único 32 bytes random

```ts
const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
```

Mismo patrón que `payment.ts:281`. NO usar `keccak256(slug + Date.now())` — predictable, mala práctica para nonces criptográficos. **Corrige el prompt del orquestador** (que sugería keccak con timestamp).

#### DT-K — Estrategia de mocking en tests

Mocks (siguiendo AB-WKH-44-#2):

- `vi.mock('viem', async (orig) => { ... signTypedData mock, readContract mock ... })` — mockear sólo las funciones usadas, dejar el resto pasar.
- `vi.stubGlobal('fetch', mockFetch)` — para `/verify` y `/settle`.
- `vi.mock('viem/accounts', () => ({ privateKeyToAccount: vi.fn().mockReturnValue({ address: '0xOPERATOR...', signTypedData: vi.fn() }) }))`.
- **Regla AB-WKH-44-#2**: el chain de `fetch` mock debe replicar EXACTAMENTE lo que el impl espera (`response.ok`, `response.json()`).

#### DT-L — El mapping de `payment` se hace en `discovery.ts:mapAgent`, NO en `registry.ts`

Corrección al prompt orquestador. `registry.ts` gestiona la tabla `registries` (CRUD de marketplaces); el mapping de campos de cada agent card vive en `discovery.ts:mapAgent` (L184-216).

#### DT-M — Tests del nuevo módulo en `src/lib/downstream-payment.test.ts` (co-located)

Corrección al work-item §105. La carpeta `src/__tests__/unit/` no existe en este repo — los tests unitarios están co-locados con el código (`circuit-breaker.test.ts` junto a `circuit-breaker.ts`). Por lo tanto:

| Work-item dice | Realidad |
|---|---|
| `src/__tests__/unit/downstream-payment.test.ts` | `src/lib/downstream-payment.test.ts` |
| `src/__tests__/unit/compose.test.ts` (actualizar) | `src/services/compose.test.ts` (actualizar) |

#### DT-N — Constantes Fuji con env override y warn-once

Patrón heredado de `payment.ts:78-101` (warn-once flag). Defaults code-level:

```ts
const DEFAULT_FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65' as `0x${string}`;
const FUJI_CHAIN_ID = 43113 as const;
const FUJI_NETWORK = 'eip155:43113' as const;
const FUJI_USDC_DECIMALS = 6 as const; // CD-NEW-SDD-5: NUNCA literal 6 disperso por código
const FUJI_USDC_EIP712_NAME = 'USD Coin' as const;
const FUJI_USDC_EIP712_VERSION = '2' as const;
const VALID_BEFORE_SECONDS = 300 as const;
```

Env vars (Wave 5 los documenta):

| Env | Default | Descripción |
|---|---|---|
| `WASIAI_DOWNSTREAM_X402` | unset | `'true'` enables; cualquier otro valor desactiva |
| `FUJI_RPC_URL` | unset → throw if flag enabled | RPC público viable: `https://api.avax-test.network/ext/bc/C/rpc` |
| `FUJI_USDC_ADDRESS` | `DEFAULT_FUJI_USDC` (warn-once) | Override del token |
| `FUJI_USDC_EIP712_VERSION` | `'2'` | Override raro |
| `WASIAI_FACILITATOR_URL` | `https://wasiai-facilitator-production.up.railway.app` | YA existe en codebase (kite-ozone) — reuso |

#### DT-O — Type guard para `agent.payment` en `discovery.ts`

```ts
function readPayment(raw: Record<string, unknown>): AgentPaymentSpec | undefined {
  const p = raw.payment;
  if (!p || typeof p !== 'object') return undefined;
  const obj = p as Record<string, unknown>;
  if (typeof obj.method !== 'string' || typeof obj.chain !== 'string' || typeof obj.contract !== 'string') {
    return undefined;
  }
  // Pass-through: NO normalizar `chain`/`method` a lowercase aquí — preservar shape.
  return {
    method: obj.method,
    chain: obj.chain,
    contract: obj.contract as `0x${string}`,
    asset: typeof obj.asset === 'string' ? obj.asset : undefined,
  };
}
```

Llamado dentro de `mapAgent`:

```ts
return {
  ...campos existentes...,
  payment: readPayment(raw),  // undefined si raw.payment ausente o malformado
};
```

---

## 6. Constraint Directives (heredadas + nuevas)

### Heredadas del work-item (CD-1..CD-10)

CD-1 a CD-10 quedan **vigentes sin cambios** — ver work-item §160-173.

### Nuevas (CD-NEW-SDD-1..CD-NEW-SDD-7)

| # | Directiva | Razón |
|---|---|---|
| **CD-NEW-SDD-1** | **PROHIBIDO** que `src/lib/downstream-payment.ts` importe **algo** de `src/adapters/kite-ozone/*`. El nuevo módulo es independiente y NO se acopla a Kite. | Aislamiento de dominios. Si en el futuro se quita Kite, downstream no se rompe. |
| **CD-NEW-SDD-2** | **OBLIGATORIO** que `Agent.payment` y `AgentPaymentSpec` sean OPTIONAL (`payment?: AgentPaymentSpec | undefined`). Backward-compat con registries pre-WKH-55 que no exponen el campo. | Zero-regresión (CD-2). |
| **CD-NEW-SDD-3** | **OBLIGATORIO** lectura del flag `WASIAI_DOWNSTREAM_X402` UNA SOLA VEZ al module load (constante `DOWNSTREAM_FLAG`), no por request. | Performance + previsibilidad (DT-A). |
| **CD-NEW-SDD-4** | **PROHIBIDO** `console.log` en producción. Logs via `request.log` (pino) en `compose.ts` (`request` está en scope al inyectar el hook), o via parámetro `logger` recibido en `signAndSettleDownstream`. **Excepción aceptable**: el `console.warn` de warn-once (heredado de `payment.ts`). | Stack pino estructurado existente. |
| **CD-NEW-SDD-5** | **PROHIBIDO** literal `6` para decimales en código de cómputo. Usar la constante `FUJI_USDC_DECIMALS`. Para amount: `parseUnits(agent.priceUsdc.toString(), FUJI_USDC_DECIMALS)`. **PROHIBIDO** `BigInt(Math.round(x * 1_000_000))` aunque sea matemáticamente equivalente — `parseUnits` valida formato y maneja edge cases (ver R-3 work-item). | Anti-bug raíz `1e12` AB en work-item. |
| **CD-NEW-SDD-6** | **OBLIGATORIO** `signAndSettleDownstream` retorna `Promise<DownstreamResult \| null>` y NUNCA hace `throw`. Errores capturados internamente, logueados con `logger.warn({ code, agentSlug, detail })`. | CD-6 expandido a nivel firma. |
| **CD-NEW-SDD-7** | **OBLIGATORIO** que el test `WASIAI_DOWNSTREAM_X402` undefined → ZERO calls a `viem.signTypedData`, `viem.readContract`, `fetch` (verificable con `expect(mockSign).not.toHaveBeenCalled()`). Cubre AC-1 explícitamente. | Bit-exact regresión. |

---

## 7. Wave decomposition

> Cada wave especifica: archivos exactos a tocar, dependencias entre waves, y cantidad/tipo de tests añadidos.

### W0 — Codebase grounding (YA HECHO en F0/F2)

- Lectura de los 16 archivos del Context Map §2.
- Sin cambios en repo.

### W1 — Type extension + discovery mapping (serial, ~30 LOC)

**Objetivo**: introducir `AgentPaymentSpec`, extender `Agent`, extender `StepResult`, añadir lectura de `raw.payment` en `discovery.ts`.

**Files**:
- `src/types/index.ts` (modificar):
  - Añadir interface `AgentPaymentSpec` después de `AgentStatus` (post L65).
  - Extender `Agent` con `payment?: AgentPaymentSpec`.
  - Extender `StepResult` con `downstreamTxHash?`, `downstreamBlockNumber?`, `downstreamSettledAmount?`.
- `src/services/discovery.ts` (modificar):
  - Añadir helper `readPayment(raw)` (DT-O).
  - Llamarlo dentro de `mapAgent` (línea ~214).
- `src/services/discovery.test.ts` (modificar):
  - 2 tests nuevos: T-W1-1 mapAgent con `raw.payment` válido → `agent.payment` set; T-W1-2 mapAgent sin `raw.payment` → `agent.payment === undefined`.

**Tests**: 2 nuevos. Suite total esperada: 388 + 2 = 390.

### W2 — Módulo `downstream-payment.ts` (serial, ~150-200 LOC)

**Objetivo**: implementar `signAndSettleDownstream` aislado. Cubre AC-2, AC-5..AC-10.

**Files**:
- `src/lib/downstream-payment.ts` (NUEVO):
  - Constantes (DT-N).
  - Lazy-init wallet client + public client viem (mismo patrón que `payment.ts:131-145`).
  - Helper `readPayment` ya en discovery — aquí NO se duplica.
  - Helper `validatePayTo(addr): { ok: true, addr } | { ok: false, code }`.
  - Helper `computeAtomicValue(priceUsdc): bigint` con `parseUnits` (CD-NEW-SDD-5).
  - Helper `readBalance(operator): Promise<bigint>` con error handling (BALANCE_READ_FAILED).
  - Helper `signAuthorization(authorization): Promise<0x...>`.
  - Helper `postFacilitator(path, body): Promise<X402SettleResponse | null>`.
  - Función exportada `signAndSettleDownstream(agent, logger): Promise<DownstreamResult | null>` que orquesta todo.
- `src/lib/downstream-payment.test.ts` (NUEVO):
  - T-W2-01: flag off → returns null sin tocar viem/fetch (CD-NEW-SDD-7, AC-1 unit-level).
  - T-W2-02: agent.payment undefined → returns null, log info (AC-5 caso ausente).
  - T-W2-03: agent.payment.method='blockchain-direct' → returns null, log info (AC-5).
  - T-W2-04: agent.payment.chain='polygon' → returns null, log info (AC-6).
  - T-W2-05: agent.payment.contract='0xZZZ...' (formato inválido) → returns null, log warn `INVALID_PAY_TO_FORMAT` (§4.5).
  - T-W2-06: agent.payment.contract=`0x0000...0000` → returns null, log warn `ZERO_PAY_TO`.
  - T-W2-07: balance < value → returns null, log warn `INSUFFICIENT_BALANCE` (AC-10).
  - T-W2-08: balance read RPC throws → returns null, log warn `BALANCE_READ_FAILED`.
  - T-W2-09: signTypedData throws → returns null, log warn `SIGNING_FAILED`.
  - T-W2-10: facilitator `/verify` retorna `{ verified: false }` → returns null, log warn `VERIFY_FAILED`.
  - T-W2-11: facilitator `/settle` retorna 500 → returns null, log warn `SETTLE_FAILED` (AC-4).
  - T-W2-12: facilitator settled OK → returns `{ txHash, blockNumber, settledAmount }` (AC-3 unit-level).
  - T-W2-13: domain EIP-712 verification → assert el body firmado con `name='USD Coin'`, `version='2'`, `chainId=43113`, `verifyingContract=FUJI_USDC` (CD-8, AC-2).
  - T-W2-14: amount calculation con priceUsdc=0.5 → atomicValue=`500000n` (NO `500000000000000000n`) — guardia anti-R-3 (AC-9).

**Tests**: 14 nuevos.

### W3 — Hook en `composeService.invokeAgent` (serial, ~30 LOC)

**Objetivo**: integrar el módulo W2 en el flujo del compose. Cubre AC-3, AC-4 a nivel integración.

**Files**:
- `src/services/compose.ts` (modificar):
  - Import: `import { signAndSettleDownstream } from '../lib/downstream-payment.js';`
  - Lectura del flag (constante module-level): `const DOWNSTREAM_FLAG = process.env.WASIAI_DOWNSTREAM_X402 === 'true';` (CD-NEW-SDD-3).
  - En `invokeAgent` (post L222), añadir el hook (ver §3.2).
  - **Cambiar firma de `invokeAgent`**: hoy `Promise<{ output: unknown; txHash?: string }>` — pasa a `Promise<{ output: unknown; txHash?: string; downstream?: DownstreamResult }>` (la firma queda backward-compat, `downstream` es optional).
  - **CRÍTICO**: el hook necesita un `logger`. `composeService.invokeAgent` actualmente NO recibe `request.log`. Decisión: pasar un `logger` parameter optional con default fallback a `console`. Firma: `invokeAgent(agent, input, a2aKey, logger?)`. En `composeService.compose`, `logger` también se propaga si está disponible. Para tests, se mockea fácil con `{ warn: vi.fn(), info: vi.fn() }`.
  - En `composeService.compose` (L70), capturar `downstream` y mergearlo al `StepResult` (spread condicional).
- `src/services/compose.test.ts` (modificar):
  - T-W3-01: flag undefined + agent sin `payment` → `signAndSettleDownstream` NUNCA llamada; `StepResult.downstreamTxHash === undefined` (AC-1, AC-12 a nivel compose).
  - T-W3-02: flag on + agent con `payment.method='x402', chain='avalanche'` + mock downstream returns `{ txHash: '0xabc', blockNumber: 1, settledAmount: '500000' }` → `StepResult.downstreamTxHash === '0xabc'` (AC-3 a nivel compose).
  - T-W3-03: flag on + downstream returns null → `StepResult.downstreamTxHash === undefined`, response del invoke se devuelve normal, no excepción (AC-4 a nivel compose).
  - T-W3-04: snapshot regression test — flag undefined → fetch al marketplace recibe body bit-exact al baseline (AC-12). Captura `mockFetch.mock.calls[0][1]` y compara con snapshot.

**Tests**: 4 nuevos.

### W4 — Verificación de propagación a routes (NO HAY CÓDIGO QUE TOCAR)

**Objetivo**: confirmar que `routes/compose.ts` y `routes/orchestrate.ts` exponen `downstreamTxHash` por step en el response sin cambio de código.

**Files**:
- NINGUNO. Esta wave es **solo verificación**.
- (Opcional) `src/routes/compose.test.ts` (modificar) o test e2e si conviene: 1 test integrado que arme un POST /compose con mocks completos y verifique que `body.steps[0].downstreamTxHash === '0xabc'`. Si esto añade complejidad, aceptable saltarlo: T-W3-02 ya cubre el paso del valor por el StepResult.

**Decisión**: **W4 es opcional, no bloquea**. Si el Dev tiene tiempo, añade 1 test de integración en routes; si no, los tests de compose.test.ts ya garantizan el shape.

**Tests**: 0-1 nuevos.

### W5 — Documentación + env (serial, ~20 LOC en docs)

**Objetivo**: documentar las nuevas env vars.

**Files**:
- `.env.example` (modificar):
  - Añadir sección "Downstream x402 — Avalanche Fuji (WKH-55)" con:
    ```
    # WASIAI_DOWNSTREAM_X402=true habilita pago downstream USDC Fuji al
    # invocar agentes wasiai-v2. Default: ausente (skip).
    WASIAI_DOWNSTREAM_X402=
    # RPC público Fuji testnet
    FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
    # Override del token USDC en Fuji (default canonical Circle USDC)
    FUJI_USDC_ADDRESS=
    # EIP-712 version override (default '2' para USDC canónica)
    FUJI_USDC_EIP712_VERSION=
    ```
- `README.md` (opcional, modificar): 1-2 líneas en sección "Env vars" si existe.

**Tests**: 0.

### Resumen de waves

| Wave | Tipo | Files modificados | Files nuevos | Tests nuevos | Bloqueante |
|---|---|---|---|---|---|
| W0 | Grounding | 0 | 0 | 0 | — |
| W1 | Types + mapping | 2 | 0 | 2 | Sí — sin tipos no compilan W2/W3 |
| W2 | Lib | 0 | 1 + 1 test | 14 | Sí — W3 lo importa |
| W3 | Hook | 1 + 1 test | 0 | 4 | No (puede ir paralelo a W4-W5) |
| W4 | Verif routes | 0 (-1 opcional) | 0 | 0-1 | No |
| W5 | Docs/env | 1-2 | 0 | 0 | No |
| **Total** | | **4-5** | **2** | **20-21** | |

Suite total esperada después de WKH-55: **388 + 20 ≈ 408 tests**.

---

## 8. Test plan — mapeo AC → tests

| AC | Test(s) que lo cubre | Wave |
|---|---|---|
| AC-1 — Zero-regresión cuando flag ausente | T-W3-01 (compose) + T-W3-04 (snapshot fetch body) + T-W2-01 (lib level) | W2 + W3 |
| AC-2 — Firma EIP-3009 correcta sobre USDC Fuji | T-W2-13 (domain assertion) | W2 |
| AC-3 — `downstreamTxHash` propagado en respuesta | T-W2-12 (lib) + T-W3-02 (compose) | W2 + W3 |
| AC-4 — Downstream failure no bloquea invoke | T-W2-08, T-W2-09, T-W2-10, T-W2-11 (lib) + T-W3-03 (compose) | W2 + W3 |
| AC-5 — Method no x402 → skip | T-W2-02, T-W2-03 | W2 |
| AC-6 — Chain no avalanche → skip | T-W2-04 | W2 |
| AC-7 — `agentMapping` propaga `payment` | T-W1-1, T-W1-2 | W1 |
| AC-8 — `payTo` del downstream es `agent.payment.contract` | T-W2-13 (verifica `to` del authorization) | W2 |
| AC-9 — Conversión decimales correcta | T-W2-14 | W2 |
| AC-10 — Pre-flight balance check | T-W2-07 | W2 |
| AC-11 — Tests unitarios por AC con mocks | TODA la suite W1+W2+W3 | W1+W2+W3 |
| AC-12 — Snapshot regresión body invoke | T-W3-04 | W3 |

**Cobertura completa**: 12/12 ACs cubiertos por al menos 1 test. CI **PROHIBIDO** correr E2E contra Fuji (CD-7).

---

## 9. Exemplars verificados (paths)

> Cada uno verificado con Read en §2.

| Exemplar | Path | Para qué |
|---|---|---|
| EIP-3009 signing reference | `src/adapters/kite-ozone/payment.ts:276-344` | Estructura del `signTypedData` block |
| EIP-3009 facilitator HTTP body | `src/adapters/kite-ozone/payment.ts:373-394` (`buildX402CanonicalBody`) | Shape de `/verify` y `/settle` |
| Lazy wallet client init | `src/adapters/kite-ozone/payment.ts:129-145` | Patrón `_walletClient` cacheado |
| Warn-once env-default | `src/adapters/kite-ozone/payment.ts:78-101` (`getPaymentToken` + `_warnedDefaultToken`) | Patrón para `FUJI_USDC_ADDRESS` ausente |
| Compose hook insertion site | `src/services/compose.ts:198-224` (función `invokeAgent`) | Lugar exacto del hook |
| StepResult propagation | `src/services/compose.ts:71-78` | Patrón spread para añadir `downstream*` fields |
| mapAgent pattern | `src/services/discovery.ts:184-216` | Cómo añadir el mapping de `payment` |
| Test mocking patrón | `src/services/compose.test.ts:1-80` | `vi.stubGlobal('fetch')`, `vi.mock(...)`, `makeAgent(o)` |
| Avalanche Fuji adapter (referencia receptor) | `wasiai-facilitator/src/chains/avalanche.ts:74-81` | USDC Fuji constants `name='USD Coin'`, `version='2'`, decimals=6 |

---

## 10. Riesgos residuales (heredados + nuevos)

### Heredados del work-item (R-1..R-4)

| # | Riesgo | Mitigación SDD |
|---|---|---|
| R-1 | `payment.contract` apunta a contrato wrong | §4.5 + DT-O: validación format + zero-address. Checksum on-chain queda V2. |
| R-2 | Operator wallet sin saldo USDC | DT-H pre-flight + AC-10 — log warn `INSUFFICIENT_BALANCE`, no bloquea. |
| R-3 | Drift decimales Kite vs Fuji | CD-NEW-SDD-5 (constante `FUJI_USDC_DECIMALS` + `parseUnits`) + CD-5 (no copiar de payment.ts) + T-W2-14 (test guardia). |
| R-4 | Facilitator pierde adapter Fuji | AC-4 cubre — log warn, skip, continue. |

### Nuevos (R-NEW-1..R-NEW-3)

| # | Riesgo | Mitigación |
|---|---|---|
| R-NEW-1 | `request.log` no disponible al hook (caller `composeService.compose` no recibe `request`) | DT-K: `invokeAgent` recibe `logger` opcional con fallback a `console.warn/info` para warn-once consistency. Tests inyectan `{warn: vi.fn(), info: vi.fn()}`. |
| R-NEW-2 | Race condition: 2 invokes paralelos del mismo agente reusan el mismo nonce | DT-J — nonce es `randomBytes(32)` cripto-seguro. Colisión P ≈ 2^-256 → 0. |
| R-NEW-3 | Mock test de viem rompe en upgrade de viem 2.x | T-W2-13 verifica el shape del `domain` PASADO a `signTypedData`, no el shape interno de viem. Robusto a upgrades minor. |

---

## 11. Readiness Check (F2 → SPEC_APPROVED)

| Check | Estado | Evidencia |
|---|---|---|
| **Operator wallet fondeada en Fuji** | [x] | Prompt orquestador: 20 USDC + 0.49 AVAX en `0xf432baf...7Ba`. |
| **Facilitator soporta Fuji (`/supported`)** | [x] | `https://wasiai-facilitator-production.up.railway.app/supported` lista `eip155:43113`, breaker CLOSED (verificación 2026-04-24). |
| **`agent.payment` expuesto en wasiai-v2 capabilities** | [~] PARCIAL | Audit del prompt: capabilities/route.ts:95-100 ya devuelve `{method, asset, chain, contract}`. **Pendiente runtime curl-test en F4**. NO bloquea merge porque AC-5/AC-6 hacen skip graceful. |
| **viem disponible en wasiai-a2a** | [x] | `package.json`: viem v2 ya instalado y usado en `kite-ozone/payment.ts`. |
| **Stack TypeScript + vitest + biome verificado** | [x] | `project-context.md` §Backend confirma Fastify + TypeScript strict + vitest + biome. |
| **Cero `[NEEDS CLARIFICATION]` abiertos** | [x] | §4.6 — los 4 MIs resueltos. |
| **Cada AC mapeado a ≥1 test** | [x] | §8, 12/12. |
| **Cada CD heredado preservado** | [x] | §6, CD-1..CD-10 vigentes. |
| **CDs SDD-level añadidos para gaps detectados** | [x] | §6, CD-NEW-SDD-1..CD-NEW-SDD-7. |
| **Auto-blindajes históricos consultados** | [x] | AB-WKH-53 (verificar disco antes de afirmar), AB-WKH-44 (mocks deben replicar chain), AB-WKH-52 (warn-once pattern). Aplicados en DT-K, DT-N, §2 grounding. |
| **Ningún path/función citado sin verificar** | [x] | Todos los archivos del Context Map (§2) abiertos con Read. Hallazgos: registry.ts NO tiene agentMapping (DT-L); src/__tests__/unit/ no existe (DT-M). |
| **Plan de waves con dependencies claras** | [x] | §7. W1 → W2 → W3 secuencial; W4-W5 opcionalmente paralelos. |

**SDD READY**: ✅ — el siguiente paso es F2.5 (story-WKH-55.md). Auto-mode debe lanzarlo después de SPEC_APPROVED humano.

---

## 12. Resumen ejecutivo

WKH-55 añade pago downstream EIP-3009 sobre USDC Fuji al hook `composeService.invokeAgent`, gateado por flag `WASIAI_DOWNSTREAM_X402=true`. **Decisión clave**: timing **post-invoke** (pay-on-delivery) — solo se paga al merchant si el agente respondió OK (DT-E §4.1). Plan de **5 waves** (W0 grounding hecho, W1 types+mapping, W2 nuevo módulo `src/lib/downstream-payment.ts`, W3 hook en compose, W4 verificación routes (no-op), W5 docs/.env). **2 archivos nuevos** (`downstream-payment.ts` + test co-located), **4-5 modificados** (types, discovery, compose, .env.example, opcional README). **20-21 tests nuevos** mapeados 1:1 a 12 ACs (§8). **DTs nuevos**: DT-G (módulo aislado), DT-H (pre-flight balance), DT-K (mocks replican chain — AB-WKH-44), DT-L (mapping en discovery.ts no registry.ts — corrige work-item), DT-M (tests co-located, NO en `__tests__/unit/` — corrige work-item), DT-N (warn-once para FUJI_USDC_ADDRESS), DT-O (type guard payment). **CDs nuevos**: CD-NEW-SDD-1..7 (no acoplar a kite-ozone, optional types, flag-load-once, no console.log, no literal 6 — `parseUnits(.., FUJI_USDC_DECIMALS)`, never throw, AC-1 zero-call assertion). Todos los `[NEEDS CLARIFICATION]` resueltos. Ningún mainnet, ningún ethers.js, ningún E2E contra RPC Fuji. **Cero regresión esperada** vs baseline 388 tests.
