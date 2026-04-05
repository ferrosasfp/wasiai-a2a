# Work Item — #016: Attestations — Contrato Ozone + Registro por Orchestration

> SDD: doc/sdd/016-attestations/
> Fecha: 2026-04-05
> Branch: feat/016-attestations
> HU: WKH-8 — [S4-P3] Attestations
> Revision: v2 — post Adversarial Review

---

## 1. Context Map (Codebase Grounding)

### 1.1 Archivos leidos

| Archivo | Existe | Patron extraido |
|---------|--------|-----------------|
| `src/services/kite-client.ts` | Si | Singleton `PublicClient` via `createPublicClient`, top-level await, `requireKiteClient()` guard. Solo lectura (no WalletClient). |
| `src/services/kite-client.test.ts` | Si | vitest, `vi.mock("viem")`, `vi.resetModules()` para re-importar TLA, `mockGetChainId`. |
| `src/lib/kite-chain.ts` | Si | `defineChain({ id: 2368, ... })`, `kiteTestnet` export. RPC: `https://rpc-testnet.gokite.ai/`. Explorer: `https://testnet.kitescan.ai`. |
| `src/lib/x402-signer.ts` | Si | Lazy singleton `_walletClient` via `createWalletClient` + `privateKeyToAccount(OPERATOR_PRIVATE_KEY)`. Patron: `getWalletClient()` privada con throw si env falta. `_resetWalletClient()` para tests. **El servicio de attestation importara `getWalletClient()` directamente de aqui.** |
| `src/services/orchestrate.ts` | Si | `orchestrateService.orchestrate(request, orchestrationId)` retorna `OrchestrateResult`. Fire-and-forget event tracking. LLM planning + greedy fallback. NO tiene hook de attestation actualmente. |
| `src/types/index.ts` | Si | `OrchestrateResult` ya tiene `attestationTxHash?: string` (preparado en SDD-015). `StepResult` tiene `txHash?: string`. |
| `.env.example` | Si | Tiene `KITE_RPC_URL`, `KITE_WALLET_ADDRESS`. NO tiene `OPERATOR_PRIVATE_KEY` (vive en .env real). NO tiene `ATTESTATION_CONTRACT_ADDRESS`. |
| `package.json` | Si | `viem: ^2.47.6` (soporta `writeContract`, `getContractEvents`). No hay Hardhat/Foundry. |
| `src/routes/orchestrate.ts` | Si | Route genera `orchestrationId = crypto.randomUUID()`, llama service, retorna `{ kiteTxHash, ...result }`. |
| `src/middleware/x402.ts` | Si | Constantes: `KITE_SCHEME`, `KITE_NETWORK`, `KITE_PAYMENT_TOKEN`, `KITE_FACILITATOR_ADDRESS`. Patron de decode + verify + settle. |
| `src/index.ts` | Si | Registro de rutas con `fastify.register(routes, { prefix })`. Importa `kiteClient` para trigger init. |
| `src/services/event.ts` | Si | `eventService.track()` inserta en `a2a_events`. Patron: row -> domain mapper. |
| `src/services/compose.ts` | Si | `invokeAgent` usa `signX402Authorization` + `settlePayment`. Patron escritura on-chain via Pieverse. |

### 1.2 Archivos que NO existen aun

| Archivo esperado (scope HU) | Estado |
|------------------------------|--------|
| `src/services/attestation.ts` | NO EXISTE — se crea en este WI |
| `src/services/attestation.test.ts` | NO EXISTE — se crea en este WI |
| `src/lib/attestation-abi.ts` | NO EXISTE — se crea en este WI |
| `WasiAttestation.sol` | NO EXISTE — deploy externo a este repo |

### 1.3 Patrones del codebase

| Patron | Ejemplo | Aplicar en |
|--------|---------|------------|
| **Singleton lazy** | `x402-signer.ts: getWalletClient()` | `attestation.ts` importa `getWalletClient()` directamente de `x402-signer.ts` |
| **Named exports (no default)** en services | `export const eventService = { ... }` | `export const attestationService = { ... }` |
| **Fire-and-forget** | `eventService.track({...}).catch(err => ...)` | `attestationService.write({...})` con `Promise.race` + timeout 15s |
| **Guard function** | `requireKiteClient(): PublicClient` | Feature flag: si `ATTESTATION_CONTRACT_ADDRESS` ausente, skip silencioso |
| **Test pattern** | `vi.mock('viem', ...)`, `describe/it/expect`, mock env vars | Tests de attestation service |
| **Flat services** | `src/services/event.ts`, `src/services/compose.ts` | `src/services/attestation.ts` (flat, NO subdirectorio `kite/`) |
| **Env var pattern** | `.env.example` documenta vars, codigo usa `process.env.VAR` con fallback o guard | `ATTESTATION_CONTRACT_ADDRESS` + `OPERATOR_PRIVATE_KEY` en `.env.example` |

### 1.4 Dependencias existentes relevantes

| Dependencia | Version | Uso para attestations |
|-------------|---------|----------------------|
| `viem` | `^2.47.6` | `writeContract()` (WalletClient) para submit tx. ABI typing con `as const`. |

> **Nota:** Se elimina la dependencia de `@supabase/supabase-js` y `fastify` del scope de attestations. No hay persistencia off-chain ni endpoint GET en esta version (diferido post-hackathon).

---

## 2. Discovery — Analisis Critico de la HU

### 2.1 Desglose del scope pedido vs realidad

| Item del scope HU | Analisis | Veredicto |
|--------------------|----------|-----------|
| **WasiAttestation.sol deployado en Ozone** | No hay tooling Solidity en el proyecto. Deployar requiere toolchain separado. | **SCOPE CREEP para este PR** — contrato pre-deployado externamente |
| **writeAttestation on-chain** | `WalletClient.writeContract()` usando `OPERATOR_PRIVATE_KEY` (ya existe en x402-signer) | **IN SCOPE** |
| **Hook en orchestrateService al finalizar** | Insertar `Promise.race` con timeout post-compose exitoso | **IN SCOPE** |
| **attestationTxHash en response** | Best-effort: si el submit completa dentro del timeout, se incluye | **IN SCOPE** |
| **Ruta GET /attestations/:id** | Valor insuficiente para hackathon; tx hash verificable en Kitescan es suficiente | **DIFERIDO post-hackathon** |
| **Tabla Supabase attestations** | Sin GET endpoint, no hay consumidor de esta tabla | **DIFERIDO post-hackathon** |
| **Verificable en explorer** | `attestationTxHash` en response + Kitescan | **IN SCOPE** (valor de demo) |

### 2.2 Preguntas criticas (resueltas)

| # | Pregunta | Respuesta |
|---|----------|-----------|
| 1 | El contrato se deploya desde este proyecto? | **No.** Deploy externo. Se referencia via `ATTESTATION_CONTRACT_ADDRESS` env var + ABI hardcodeado. |
| 2 | Quien paga gas? | **`OPERATOR_PRIVATE_KEY`** — misma wallet de x402. Necesita KITE tokens. |
| 3 | Que pasa si la tx falla? | **No bloquea orchestrate.** `attestationTxHash` queda `undefined`, se loguea warning. |
| 4 | `attestationTxHash` garantizado o best-effort? | **Best-effort.** Se usa `Promise.race([writeContract(), timeout(15s)])`. Si timeout expira, `attestationTxHash` queda `undefined`. |
| 5 | El ABI se genera o se hardcodea? | **Hardcodeado** en `src/lib/attestation-abi.ts`. Minimo: `attest()` + `getAttestation()` + event `AttestationCreated`. |
| 6 | `writeContract` espera receipt? | **No.** `writeContract` retorna el tx hash inmediatamente (submit). No se llama `waitForTransactionReceipt`. El timeout de 15s aplica solo al submit. |
| 7 | Que se hashea para `resultHash`? | `keccak256(toHex(JSON.stringify(pipeline.output)))` — output completo. |
| 8 | Hace falta tabla Supabase? | **No para hackathon.** Diferido post-hackathon. |
| 9 | Hace falta GET endpoint? | **No para hackathon.** El valor de demo es: `attestationTxHash` en la response + verificable en Kitescan. |
| 10 | Se reutiliza `getWalletClient` de x402-signer? | **Si.** Se exporta `getWalletClient()` (hoy es privada) desde `x402-signer.ts`. El servicio de attestation la importa directamente. |

### 2.3 Dependencias bloqueantes

| Dependencia | Tipo | Estado | Impacto |
|-------------|------|--------|---------|
| Contrato WasiAttestation.sol deployado en Ozone | Externa | **PENDIENTE** | Sin contrato, writeContract falla. Feature flag via env var. Desarrollo con mocks. |
| `OPERATOR_PRIVATE_KEY` con KITE balance | Operacional | Probable OK (ya se usa para x402) | Sin balance, tx reverts. Faucet: `https://faucet.gokite.ai` |
| `KITE_RPC_URL` configurado | Operacional | OK (ya existe en `.env.example`) | Ya funciona para kite-client |

### 2.4 Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigacion |
|---|--------|-------------|---------|------------|
| R1 | Contrato no deployado al merge | Alta | Codigo inactivo hasta deploy | Feature flag: si `ATTESTATION_CONTRACT_ADDRESS` ausente, skip silencioso. Attestation es opt-in. |
| R2 | Gas insuficiente en OPERATOR wallet | Media | Tx falla silenciosamente | Log warning, no bloquear orchestrate. Documentar necesidad de faucet. |
| R3 | ABI hardcodeado no matchea contrato real | Media | writeContract reverts | ABI minimo validado post-deploy. Tests con mocks. |
| R4 | RPC lento/inestable | Media | Attestation timeout | `Promise.race` con timeout 15s. No bloquea response. |

---

## 3. Work Item Normalizado

### 3.1 Metadata

| Campo | Valor |
|-------|-------|
| **#** | 016 |
| **Titulo** | Attestations — Contrato Ozone + Registro por Orchestration |
| **Tipo** | feature |
| **HU** | WKH-8 |
| **Branch** | `feat/016-attestations` |
| **SDD_MODE** | full |
| **Objetivo** | Al completar una orchestration exitosa con al menos un agente invocado, escribir una attestation on-chain en Ozone (Kite Testnet) y retornar el tx hash en la response para verificacion en Kitescan. |

### 3.2 Acceptance Criteria (EARS)

| AC | Criterio |
|----|----------|
| AC-1 | WHEN orchestration completa exitosamente (`pipeline.success === true`) AND al menos un agente fue invocado (`pipeline.steps.length > 0`), THEN el gateway SHALL invocar `writeContract` en el contrato WasiAttestation en Ozone con: `orchestrationId`, lista de agent slugs (`pipeline.steps.map(s => s.agent.slug)`), costo total USDC como BigInt (`BigInt(Math.round(pipeline.totalCostUsdc * 1e6))`), timestamp, y `keccak256` hash del resultado. |
| AC-2 | WHEN attestation tx se submite exitosamente dentro del timeout (15s), THEN `attestationTxHash` se incluye en la response (`OrchestrateResult`). IF el timeout expira, THEN `attestationTxHash` queda `undefined`. Implementacion: `Promise.race([writeContract(), timeout(15s)])`. |
| AC-3 | WHEN la attestation tx falla o el contrato no esta configurado (`ATTESTATION_CONTRACT_ADDRESS` ausente), THEN el orchestrate SHALL completar normalmente con `attestationTxHash: undefined` y loguear warning. |
| AC-4 | WHEN el servicio de attestation se importa, THEN SHALL usar `getWalletClient()` exportado desde `src/lib/x402-signer.ts` (reutilizar la misma instancia lazy singleton, misma `OPERATOR_PRIVATE_KEY`). |
| AC-5 | WHILE orchestrate esta ejecutando, IF attestation submit toma mas de 15 segundos, THEN SHALL abortar el write (timeout) sin bloquear la respuesta de orchestrate. Nota: `writeContract` retorna tx hash inmediatamente (solo submit, sin `waitForTransactionReceipt`). El timeout de 15s aplica unicamente al submit. |
| AC-6 | WHEN la attestation se escribe, THEN el tx hash SHALL ser verificable en el explorer de Ozone (`https://testnet.kitescan.ai/tx/{hash}`). |

### 3.3 Scope IN

| Archivo | Accion | Descripcion |
|---------|--------|-------------|
| `src/lib/attestation-abi.ts` | **Crear** | ABI minimo del contrato WasiAttestation (hardcodeado, `as const`). Incluye `attest()`, `getAttestation()`, y event `AttestationCreated`. |
| `src/services/attestation.ts` | **Crear** | Servicio con `attestationService.write()`. Importa `getWalletClient()` de `x402-signer.ts`. Guard: si `ATTESTATION_CONTRACT_ADDRESS` no esta, retorna `null` sin error. |
| `src/services/attestation.test.ts` | **Crear** | Tests unitarios con mocks de viem. Happy path, sin env var, tx failure, timeout. |
| `src/services/orchestrate.ts` | **Modificar** | Agregar hook post-compose exitoso. `Promise.race` con timeout 15s. Asignar `attestationTxHash` al resultado. |
| `src/lib/x402-signer.ts` | **Modificar** | Exportar `getWalletClient()` (actualmente es funcion privada). Sin cambios de logica. |
| `.env.example` | **Modificar** | Agregar `ATTESTATION_CONTRACT_ADDRESS=0xYourDeployedContractAddress` y `OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey`. |

### 3.4 Scope OUT

- Desarrollo o deploy del contrato Solidity `WasiAttestation.sol` (externo a este repo)
- Tooling Solidity (Hardhat, Foundry) en este proyecto
- `GET /attestations/:orchestrationId` endpoint (diferido post-hackathon)
- Tabla Supabase `attestations` + migracion SQL (diferido post-hackathon)
- Ruta `src/routes/attestations.ts` + tests de ruta (diferido post-hackathon)
- Registro de ruta en `src/index.ts` (diferido, no hay ruta que registrar)
- Modificar `src/types/index.ts` (`OrchestrateResult.attestationTxHash` ya existe desde SDD-015)
- Retry logic para tx fallidas
- Queue/worker para attestations asincronas
- `waitForTransactionReceipt` (solo submit, sin esperar receipt)
- Gas estimation o gas price oracle
- Attestation para orchestrations fallidas (solo exitosas con steps)
- UI para visualizar attestations
- Streaming del tx hash durante orchestration

---

## 4. Propuesta de Waves

### Wave 0: Types + ABI (~30 min)

| Task | Archivo | Accion | Descripcion |
|------|---------|--------|-------------|
| W0.1 | `src/lib/attestation-abi.ts` | Crear | ABI minimo: `function attest(...)`, `function getAttestation(...)`, `event AttestationCreated(string indexed orchestrationId, bytes32 resultHash)`. Exportar como `export const ATTESTATION_ABI = [...] as const`. |
| W0.2 | `.env.example` | Modificar | Agregar `ATTESTATION_CONTRACT_ADDRESS=0xYourDeployedContractAddress` y `OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey`. |
| W0.3 | `src/lib/x402-signer.ts` | Modificar | Exportar `getWalletClient()` — cambiar de funcion privada a export. Sin cambios de logica interna. |

**Verificacion W0:** `tsc --noEmit` pasa.

### Wave 1: Attestation Service + Tests (~45 min, test-first)

| Task | Archivo | Accion | Descripcion | Exemplar |
|------|---------|--------|-------------|----------|
| W1.1 | `src/services/attestation.test.ts` | Crear | Tests: (T1) write happy path retorna txHash, (T2) write sin `ATTESTATION_CONTRACT_ADDRESS` retorna null, (T3) write con tx failure retorna null + log warning, (T4) write con timeout retorna null. | `src/services/kite-client.test.ts` |
| W1.2 | `src/services/attestation.ts` | Crear | `attestationService.write(data): Promise<string \| null>`. Importa `getWalletClient()` de `x402-signer`. Llama `writeContract` con ABI de `attestation-abi.ts`. Guard: si `ATTESTATION_CONTRACT_ADDRESS` no esta, retorna `null`. NO llama `waitForTransactionReceipt`. Parametros del write: `agents: pipeline.steps.map(s => s.agent.slug)`, `totalCostUsdc: BigInt(Math.round(pipeline.totalCostUsdc * 1e6))`. | `src/services/event.ts` + `src/lib/x402-signer.ts` |

**Verificacion W1:** `tsc --noEmit` + `vitest run src/services/attestation.test.ts` pasan.

### Wave 2: Orchestrate Hook + Verificacion (~45 min)

| Task | Archivo | Accion | Descripcion | Exemplar |
|------|---------|--------|-------------|----------|
| W2.1 | `src/services/orchestrate.ts` | Modificar | Post-compose exitoso, SI `pipeline.steps.length > 0`: construir datos de attestation (`agents: pipeline.steps.map(s => s.agent.slug)`, `totalCostUsdc: BigInt(Math.round(pipeline.totalCostUsdc * 1e6))`, `resultHash: keccak256(toHex(JSON.stringify(pipeline.output)))`). Ejecutar `Promise.race([attestationService.write(data), timeout(15_000)])`. Asignar resultado a `result.attestationTxHash`. Catch: log warning, continuar sin hash. | `eventService.track({...}).catch(...)` |
| W2.2 | Verificacion final | - | `npm run lint && npm run test && npm run build`. Server arranca sin errores. Verificar que orchestrate sin `ATTESTATION_CONTRACT_ADDRESS` funciona igual que antes. |

**Verificacion W2:** Full QA — lint + tests + build + manual sanity check.

### Grafo de dependencias

```
Wave 0 (foundation, ~30 min)
  W0.1 attestation-abi.ts ──┐
  W0.2 .env.example ────────┤
  W0.3 x402-signer export ──┘
                             │
                             v
Wave 1 (service, test-first, ~45 min)
  W1.1 attestation.test.ts ──> W1.2 attestation.ts
                                │
                                v
Wave 2 (integration, ~45 min)
  W2.1 orchestrate hook
  W2.2 full QA
```

---

## 5. Dependencias y Riesgos (resumen ejecutivo)

### Dependencias

| Dep | Tipo | Bloqueante para | Mitigacion |
|-----|------|-----------------|------------|
| Contrato `WasiAttestation.sol` deployado | Externa | Integration testing, DoD "verificable en explorer" | Feature flag via env var. Desarrollo con mocks. |
| OPERATOR wallet con KITE balance | Operacional | Tx on-chain | Ya se usa para x402, validar balance. Faucet disponible. |
| viem `writeContract` API | Tecnica | Core functionality | viem `^2.47.6` soporta writeContract. Verificado. |

### Riesgos top 3

1. **R1 (Alto):** Contrato no deployado al merge — Mitigacion: feature flag, attestation es opt-in via env var.
2. **R3 (Medio):** ABI mismatch — Mitigacion: ABI minimo, validar post-deploy, tests con mocks.
3. **R4 (Medio):** RPC lento — Mitigacion: `Promise.race` con timeout 15s, no bloquea response.

---

## 6. Smart Sizing

| Dimension | Valor | Justificacion |
|-----------|-------|---------------|
| **Archivos nuevos** | 3 | `attestation-abi.ts`, `attestation.ts`, `attestation.test.ts` |
| **Archivos modificados** | 3 | `orchestrate.ts` (hook), `x402-signer.ts` (export), `.env.example` (env vars) |
| **Complejidad tecnica** | Media | Primera interaccion write on-chain a contrato custom, pero patron WalletClient ya existe en x402-signer. |
| **Riesgo integracion** | Medio | Depende de contrato externo, pero feature flag mitiga. |
| **Tests requeridos** | ~4-5 | 4 unit (service) + verificacion hook en orchestrate |
| **Estimacion** | **3 SP (S/M)** | ~2h de desarrollo en 3 waves |

### Breakdown de esfuerzo

| Wave | Esfuerzo estimado | Notas |
|------|-------------------|-------|
| W0 | 30 min | ABI, env vars, export getWalletClient |
| W1 | 45 min | Service + tests (core logic) |
| W2 | 45 min | Hook en orchestrate + QA |
| **Total** | **~2 h** | Sin contar deploy del contrato (out of scope) |

---

## 7. Contrato de Integracion — ABI Propuesto

> Este ABI es el contrato de integracion entre el codigo TS y el contrato Solidity.
> El contrato Solidity DEBE implementar estas funciones y events exactos.

### Solidity Interface (referencia)

```solidity
// SPDX-License-Identifier: MIT
// WasiAttestation.sol — Interface minima

struct AttestationData {
    string orchestrationId;
    string[] agents;         // agent slugs
    uint256 totalCostUsdc;   // 6 decimals (e.g., 1500000 = 1.5 USDC)
    uint256 timestamp;       // Unix timestamp (seconds)
    bytes32 resultHash;      // keccak256 del output
}

event AttestationCreated(
    string indexed orchestrationId,
    bytes32 resultHash
);

// Write — emite AttestationCreated
function attest(
    string calldata orchestrationId,
    string[] calldata agents,
    uint256 totalCostUsdc,
    uint256 timestamp,
    bytes32 resultHash
) external;

// Read
function getAttestation(
    string calldata orchestrationId
) external view returns (
    string[] memory agents,
    uint256 totalCostUsdc,
    uint256 timestamp,
    bytes32 resultHash,
    bool exists
);
```

### TypeScript ABI (para `src/lib/attestation-abi.ts`)

```typescript
export const ATTESTATION_ABI = [
  {
    name: 'attest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orchestrationId', type: 'string' },
      { name: 'agents', type: 'string[]' },
      { name: 'totalCostUsdc', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'resultHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'getAttestation',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'orchestrationId', type: 'string' },
    ],
    outputs: [
      { name: 'agents', type: 'string[]' },
      { name: 'totalCostUsdc', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'resultHash', type: 'bytes32' },
      { name: 'exists', type: 'bool' },
    ],
  },
  {
    name: 'AttestationCreated',
    type: 'event',
    inputs: [
      { name: 'orchestrationId', type: 'string', indexed: true },
      { name: 'resultHash', type: 'bytes32', indexed: false },
    ],
  },
] as const
```

---

## 8. Decisiones del Adversarial Review

> Registro de decisiones tomadas durante el Adversarial Review para trazabilidad.

| # | Hallazgo AR | Correccion aplicada |
|---|-------------|---------------------|
| #1 | `getWalletClient` no exportada en `x402-signer.ts` | Agregado `src/lib/x402-signer.ts` al Scope IN. Modificacion: exportar `getWalletClient()`. El servicio de attestation la importa directamente. |
| #2 | AC-2 vs AC-7 contradiccion (garantizado vs timeout) | AC-2 reescrito como best-effort: si submit completa dentro del timeout, se incluye; si no, queda `undefined`. Implementacion: `Promise.race([writeContract(), timeout(15s)])`. |
| #4 | Subdirectorio `src/services/kite/` no sigue patron flat | Cambiado a `src/services/attestation.ts` (flat, como `event.ts`, `compose.ts`). |
| #5+#8+#12 | Supabase + GET endpoint innecesarios para hackathon | Eliminados AC-4 (GET endpoint), AC-5 (tabla Supabase), migracion SQL, ruta, tests de ruta. Diferidos post-hackathon. Valor demo: `attestationTxHash` en response + Kitescan. |
| #7 | Sin event en ABI propuesto | Agregado `event AttestationCreated(string indexed orchestrationId, bytes32 resultHash)` al ABI. |
| #14 | Atestar orchestrations sin agentes invocados | Corregido AC-1: guard `pipeline.steps.length > 0`. Solo atestar si al menos un agente fue invocado. |
| #15 | Falta especificar que son agent slugs | Documentado en AC-1 y waves: `agents: pipeline.steps.map(s => s.agent.slug)`. |
| #16 | Float a BigInt para totalCostUsdc | Documentado en AC-1 y waves: `totalCostUsdc: BigInt(Math.round(pipeline.totalCostUsdc * 1e6))`. |
| #19 | `writeContract` espera receipt innecesariamente | Documentado en AC-5: solo submit, sin `waitForTransactionReceipt`. `writeContract` retorna tx hash inmediatamente. Timeout de 15s aplica solo al submit. |

---

## 9. Escalation Rule

> Si algo no esta en este Work Item, Dev PARA y pregunta a Architect.
> No inventar. No asumir. No improvisar.

---

*Work Item generado por NexusAgil — F0 + F1 (Analyst + Architect)*
*Fecha: 2026-04-05*
*Revision: v2 — post Adversarial Review*
