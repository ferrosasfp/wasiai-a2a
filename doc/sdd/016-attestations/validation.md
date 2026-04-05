# Validation Report — #016: Attestations

> Agente: Adversary + QA (AR + CR + F4)
> Fecha: 2026-04-05
> Branch: feat/016-attestations
> Revision: v1

---

## 1. AR — Adversarial Review

### 1.1 Injection

**OK**

Los argumentos enviados a `writeContract` provienen de datos internos del sistema (`orchestrationId` generado por `crypto.randomUUID()`, `agents` extraidos de `pipeline.steps`, `totalCostUsdc` calculado internamente, `resultHash` generado via `keccak256`). No hay inputs de usuario directos que lleguen al contrato sin transformacion. El ABI hardcodeado (`as const`) previene manipulacion de la estructura de la llamada. `contractAddress` se lee de `process.env` que solo el operador configura.

### 1.2 Auth

**OK**

`OPERATOR_PRIVATE_KEY` se lee exclusivamente en `x402-signer.ts:44` via `process.env.OPERATOR_PRIVATE_KEY`. No se logea (comentario explicito en linea 5: "NUNCA logear privateKey ni signature"). `.env` esta en `.gitignore`. `.env.example` contiene solo placeholder `0xYourOperatorPrivateKey`. El servicio `attestation.ts` menciona la key solo en un comentario docstring (linea 9), nunca accede al valor directamente.

### 1.3 Data Leak

**OK**

- `attestation.ts:38` logea solo el tx hash: `[Attestation] tx submitted: ${txHash}` — dato publico on-chain.
- `attestation.ts:42` logea solo `err.message` en caso de error, no stack traces ni datos sensibles.
- `orchestrate.ts` logea `[Orchestrate] attestation failed:` con `err.message` — no leak.
- El `resultHash` es un keccak256 unidireccional; no expone el output original.

### 1.4 Race Conditions / Nonce Collision

**MENOR**

El `WalletClient` singleton comparte la misma cuenta para x402 payments y attestations. Si dos orchestrations concurrentes ejecutan `writeContract` simultaneamente, pueden generar el mismo nonce y una tx seria revertida. Viem maneja nonces secuencialmente por defecto en `writeContract`, pero bajo alta concurrencia el RPC podria devolver el mismo pending nonce a dos requests simultaneas.

**Mitigacion existente:** El `try/catch` en `attestation.ts:30-44` captura el revert y retorna `null` sin bloquear. La attestation fallida queda como `undefined` en la response. Este riesgo esta documentado en el Work Item (R2/R4) y es aceptable para hackathon.

### 1.5 Error Handling

**OK**

Todos los paths de error estan cubiertos:
- `ATTESTATION_CONTRACT_ADDRESS` ausente: retorna `null` + `console.warn` (`attestation.ts:20-22`).
- `getWalletClient()` lanza (OPERATOR_PRIVATE_KEY ausente): capturado por `try/catch` en `attestation.ts:30-44`, retorna `null`.
- `writeContract` falla (revert, red, etc.): capturado por `try/catch`, retorna `null` + log warning.
- Timeout de 15s en `orchestrate.ts`: `Promise.race` resuelve `null`, `clearTimeout` ejecuta.
- Error inesperado en hook de attestation: `try/catch` externo en `orchestrate.ts:199-207`.

### 1.6 Input Validation

**MENOR**

Los datos enviados al contrato no tienen validacion explicita previa al `writeContract`:
- `orchestrationId` es un UUID generado internamente (seguro).
- `agents[]` proviene de `pipeline.steps.map(s => s.agent.slug)` — no validado como non-empty, pero el guard `pipeline.steps.length > 0` lo cubre implicitamente.
- `totalCostUsdc` usa `BigInt(Math.round(pipeline.totalCostUsdc * 1e6))` — si `totalCostUsdc` fuera negativo, `BigInt` de un numero negativo es valido en JS pero revertira en Solidity (uint256). Riesgo teorico, improbable en practica ya que `totalCostUsdc` se acumula desde precios positivos.
- `resultHash` usa `keccak256(toHex(JSON.stringify(pipeline.output ?? null)))` — siempre produce bytes32 valido.

No hay validacion de que `contractAddress` sea una address valida (0x + 40 hex chars). Se castea como `` `0x${string}` `` pero no se valida formato. Una address malformada causaria un revert que seria capturado por el catch.

**Veredicto:** Aceptable para hackathon. La validacion la hace el contrato via revert + el catch lo maneja.

### 1.7 Resource Exhaustion

**OK**

- Timeout de 15s via `Promise.race` en `orchestrate.ts:190-196` previene bloqueos.
- `clearTimeout(attestationTimeoutId!)` en linea 198 limpia el timer.
- `writeContract` es un submit (no espera receipt), por lo que el timeout de 15s es mas que suficiente para el roundtrip al RPC.
- No hay loops, retry logic, ni allocaciones crecientes.

### 1.8 Test Coverage

**OK**

Los 4 tests cubren los ACs directamente:
- **T1** (happy path) -> AC-1, AC-2 (tx hash retornado).
- **T2** (feature flag OFF) -> AC-3 (retorna null cuando falta env var).
- **T3** (writeContract failure) -> AC-3 (retorna null + warning en error).
- **T4** (getWalletClient throws) -> AC-4 (error de OPERATOR_PRIVATE_KEY manejado).

No hay test explicito para el timeout de 15s (AC-5), pero este vive en `orchestrate.ts` y el test de attestation service cubre el contrato del servicio. Los tests de `orchestrate.test.ts` existentes pasan correctamente con el hook (stderr muestra `[Attestation] ATTESTATION_CONTRACT_ADDRESS not set — skipping`).

### Resumen AR

| Categoria | Veredicto |
|-----------|-----------|
| Injection | OK |
| Auth | OK |
| Data Leak | OK |
| Race Conditions | MENOR — nonce collision bajo concurrencia alta; mitigado por catch |
| Error Handling | OK |
| Input Validation | MENOR — sin validacion de contractAddress format; mitigado por revert + catch |
| Resource Exhaustion | OK |
| Test Coverage | OK |

**Hallazgos BLOQUEANTES: 0**
**Hallazgos MENORES: 2**

---

## 2. CR — Code Review

### 2.1 Code Style

**PASS**

- `attestation-abi.ts`: Export constante con `as const`, comentarios descriptivos. Consistente con patron del proyecto (named exports, no default exports).
- `attestation.ts`: Named export `export const attestationService = { ... }` — sigue patron de `eventService`, `composeService`.
- `attestation.test.ts`: Patron `vi.mock` antes de imports, `describe/it/expect`, `beforeEach/afterEach` para env vars. Consistente con `kite-client.test.ts`.
- `orchestrate.ts`: Hook insertado entre `protocolFeeUsdc` y `totalLatencyMs`. Patron `try/catch` con `console.warn` consistente con `eventService.track().catch()`.
- `.env.example`: Seccion con header comentado, consistente con secciones existentes.
- `x402-signer.ts`: Solo cambio de visibilidad (`export`), sin cambios de logica.

### 2.2 Type Safety

**PASS**

- No hay uso de `any` en ningun archivo nuevo o modificado.
- `AttestationWriteData` es una interface interna bien tipada con `bigint`, template literal `` `0x${string}` ``.
- `ATTESTATION_ABI` usa `as const` para inferencia de tipos en viem.
- `attestationTxHash` en `OrchestrateResult` (`types/index.ts:204`) es `string | undefined` — correcto.
- `client.account!` en `attestation.ts:45` usa non-null assertion — aceptable porque `getWalletClient()` siempre crea el client con `account` via `privateKeyToAccount`. Si `account` fuera null, `writeContract` fallaria y seria capturado por catch.

### 2.3 Error Handling

**PASS**

- Ningun error es swallowed silenciosamente sin log.
- `attestation.ts`: catch logea `[Attestation] write failed:` + mensaje.
- `orchestrate.ts`: catch externo logea `[Orchestrate] attestation failed:` + mensaje.
- Feature flag OFF logea `[Attestation] ATTESTATION_CONTRACT_ADDRESS not set — skipping`.
- Todos los paths de error retornan `null` (servicio) o dejan `attestationTxHash` como `undefined` (hook).

### 2.4 Performance

**PASS**

- No hay allocaciones innecesarias.
- `getWalletClient()` es singleton lazy — no se recrea en cada llamada.
- `ATTESTATION_ABI` es constante estatica.
- `Promise.race` con timeout evita bloqueos.
- No se llama `waitForTransactionReceipt` — solo submit.
- `JSON.stringify(pipeline.output ?? null)` se ejecuta una sola vez.

### 2.5 Maintainability

**PASS**

- Funciones claras con responsabilidad unica: `attestationService.write()` solo hace submit.
- Separacion limpia: ABI en su propio archivo, servicio separado, hook en orchestrate.
- Comentarios descriptivos en cabeceras y secciones.
- Tests bien nombrados y organizados en bloques logicos (T1-T4).
- Feature flag via env var permite activar/desactivar sin cambios de codigo.

### 2.6 Dead Code

**PASS**

- `attestation-abi.ts`: Incluye `getAttestation` y `AttestationCreated` que no se usan actualmente en el codigo TS. Sin embargo, son parte del ABI del contrato y seran necesarios para futuros features (GET endpoint, event listening). Su inclusion es intencional y documentada en el Story File.
- No hay imports sin usar en ningun archivo.
- No hay variables declaradas sin usar.

### Resumen CR

| Check | Veredicto |
|-------|-----------|
| Code Style | PASS |
| Type Safety | PASS |
| Error Handling | PASS |
| Performance | PASS |
| Maintainability | PASS |
| Dead Code | PASS |

**FAIL: 0 | WARN: 0 | PASS: 6**

---

## 3. F4 — QA Validation

### 3.1 AC Verification

| AC | Veredicto | Evidencia |
|----|-----------|-----------|
| AC-1 | **PASS** | `orchestrate.ts:181-188` construye `attestationData` con `orchestrationId`, `agents: pipeline.steps.map(s => s.agent.slug)`, `totalCostUsdc: BigInt(Math.round(pipeline.totalCostUsdc * 1e6))`, `resultHash: keccak256(toHex(JSON.stringify(pipeline.output ?? null)))`. Guard en linea 179: `if (pipeline.success && pipeline.steps.length > 0)`. `attestation.ts:35` agrega `BigInt(Math.floor(Date.now() / 1000))` como timestamp. `writeContract` invocado en `attestation.ts:29-39` con `functionName: 'attest'`. |
| AC-2 | **PASS** | `orchestrate.ts:190-198` implementa `Promise.race([attestationService.write(attestationData), timeoutPromise])` con timeout de 15s. Si txHash existe, se asigna a `attestationTxHash` (linea 200). El return en linea 223 incluye `attestationTxHash`. Si timeout expira, `timeoutPromise` resuelve `null` y `attestationTxHash` queda `undefined`. |
| AC-3 | **PASS** | `attestation.ts:19-22`: si `ATTESTATION_CONTRACT_ADDRESS` no esta, `console.warn` + return `null`. `attestation.ts:40-44`: si `writeContract` falla, `console.warn` + return `null`. `orchestrate.ts:203-207`: catch externo logea warning. En todos los casos, `attestationTxHash` queda `undefined` y orchestrate continua normalmente. Tests T2 y T3 verifican esto. |
| AC-4 | **PASS** | `attestation.ts:10` importa `getWalletClient` de `../lib/x402-signer.js`. `x402-signer.ts:41` exporta `getWalletClient()` (modificado de privada a export). La funcion retorna el singleton `_walletClient` que usa `OPERATOR_PRIVATE_KEY`. Test T4 verifica el caso de error. |
| AC-5 | **PASS** | `orchestrate.ts:190-196`: `Promise.race` con `setTimeout(() => resolve(null), 15_000)`. Si attestation toma mas de 15s, `timeoutPromise` gana la race y retorna `null`. `clearTimeout` en linea 198 limpia el timer. `writeContract` es solo submit (no `waitForTransactionReceipt`), confirmado en `attestation.ts` (no hay llamada a `waitForTransactionReceipt`). |
| AC-6 | **PASS** | `attestation.ts:37` retorna el txHash de `writeContract`. El txHash es un hash de transaccion estandar de Ethereum, verificable en `https://testnet.kitescan.ai/tx/{hash}`. El hash se propaga via `orchestrate.ts:200,223` al `OrchestrateResult.attestationTxHash`. No hay transformacion del hash entre submit y response. |

**ACs: 6/6 PASS**

### 3.2 Drift Detection

#### Archivos planificados vs implementados

| # | Archivo (Story File) | Accion planificada | Estado real |
|---|---------------------|--------------------|-------------|
| 1 | `src/lib/attestation-abi.ts` | CREAR | Creado — contenido identico al Story File |
| 2 | `.env.example` | MODIFICAR | Modificado — seccion Attestation agregada, contenido identico |
| 3 | `src/lib/x402-signer.ts` | MODIFICAR (export) | Modificado — `export function getWalletClient()` confirmado |
| 4 | `src/services/attestation.test.ts` | CREAR | Creado — contenido identico al Story File |
| 5 | `src/services/attestation.ts` | CREAR | Creado — con 2 lineas adicionales (ver abajo) |
| 6 | `src/services/orchestrate.ts` | MODIFICAR (hook) | Modificado — hook correcto, imports correctos, return correcto |

#### Diferencias detectadas respecto al Story File

**Diferencia 1 (attestation.ts — MENOR, ACEPTABLE):**

El archivo implementado incluye `chain: client.chain` y `account: client.account!` en la llamada a `writeContract` (lineas 44-45), mientras que el Story File no los incluye:

```typescript
// Implementacion real (attestation.ts:42-47)
const txHash = await client.writeContract({
  chain: client.chain,        // NO en Story File
  account: client.account!,   // NO en Story File
  address: contractAddress as `0x${string}`,
  abi: ATTESTATION_ABI,
  functionName: 'attest',
  args: [...]
})
```

**Analisis:** Estas propiedades son necesarias para que viem `writeContract` funcione correctamente cuando el WalletClient se usa con una chain especifica. Sin `chain` y `account`, viem podria lanzar errores de tipo o de ejecucion. Esta adicion es correcta y necesaria. El Story File tenia un defecto menor en su template de codigo. `tsc --noEmit` pasa sin errores, confirmando que los tipos son correctos.

**Diferencia 2: Ninguna otra diferencia significativa detectada.**

#### Archivos fuera de scope

No se modificaron archivos fuera del scope definido en el Work Item. `git status` confirma:
- Modificados: `.env.example`, `src/lib/x402-signer.ts`, `src/services/orchestrate.ts` (los 3 planificados).
- Nuevos: `src/lib/attestation-abi.ts`, `src/services/attestation.ts`, `src/services/attestation.test.ts` (los 3 planificados).
- `supabase/.temp/` aparece como untracked pero no esta relacionado con este feature.

**Drift: MINIMO — 1 diferencia menor aceptable (chain/account en writeContract)**

### 3.3 Test Results

```
 RUN  v1.6.1 /home/ferdev/.openclaw/workspace/wasiai-a2a

 ✓ src/services/agent-card.test.ts  (17 tests) 4ms
 ✓ src/services/attestation.test.ts  (4 tests) 5ms
 ✓ src/services/llm/transform.test.ts  (5 tests) 6ms
 ✓ src/services/compose.test.ts  (9 tests) 13ms
 ✓ src/services/task.test.ts  (21 tests) 13ms
 ✓ src/services/kite-client.test.ts  (8 tests) 49ms
 ✓ src/routes/agent-card.test.ts  (4 tests) 17ms
 ✓ src/services/mock-registry.test.ts  (9 tests) 20ms
 ✓ src/routes/tasks.test.ts  (20 tests) 32ms
 ✓ src/services/orchestrate.test.ts  (10 tests) 18ms

 Test Files  10 passed (10)
      Tests  107 passed (107)
   Duration  890ms
```

- **attestation.test.ts: 4/4 PASS** (T1 happy path, T2 feature flag OFF, T3 writeContract failure, T4 getWalletClient throws).
- **orchestrate.test.ts: 10/10 PASS** — tests existentes no se rompieron. Logs stderr muestran `[Attestation] ATTESTATION_CONTRACT_ADDRESS not set — skipping` en cada test, confirmando que el hook se ejecuta y el feature flag funciona correctamente.
- **Todos los demas test files: PASS** — 0 regresiones.
- **tsc --noEmit: PASS** — sin errores de tipos.
- **tsc (build): PASS** — build exitoso.
- **eslint: N/A** — no hay `eslint.config.js` configurado en el proyecto (ESLint v10 requiere flat config). No es un problema introducido por este feature.

### 3.4 Checklist Pre-PR (del Story File seccion 9)

| Check | Resultado |
|-------|-----------|
| `npx tsc --noEmit` pasa | PASS |
| `npx vitest run src/services/attestation.test.ts` — 4 tests | PASS (4/4) |
| `npm run test` — todos los tests pasan | PASS (107/107, 10 files) |
| `npm run lint` — sin errores | N/A (ESLint no configurado en proyecto) |
| `npm run build` — build exitoso | PASS |
| Sin ATTESTATION_CONTRACT_ADDRESS: no crash | PASS (confirmado via stderr en orchestrate tests) |
| No se modificaron archivos fuera del scope | PASS (git status confirma) |
| attestationTxHash en response | PASS (orchestrate.ts:223, types/index.ts:204) |
| No se commiteo .env con valores reales | PASS (.gitignore incluye .env) |

---

## 4. Resumen Ejecutivo

| Seccion | Resultado |
|---------|-----------|
| **AR (Adversarial Review)** | 0 BLOQUEANTES, 2 MENORES (nonce collision, contractAddress format) |
| **CR (Code Review)** | 6/6 PASS |
| **F4 (QA Validation)** | 6/6 ACs PASS, drift minimo, 107/107 tests PASS |

### Veredicto Final

**APROBADO** — La implementacion es correcta, segura para el contexto de hackathon, y cumple todos los Acceptance Criteria. Los 2 hallazgos menores del AR son riesgos conocidos y aceptados, mitigados por el manejo de errores existente. No hay hallazgos bloqueantes.

---

*Validation Report generado por NexusAgil — Adversary + QA Agent (AR + CR + F4)*
*Fecha: 2026-04-05*
