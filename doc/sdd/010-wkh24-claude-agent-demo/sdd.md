# SDD — WKH-24: Claude Agent Demo Script
**Work Item:** #010  
**Branch:** `feat/wkh-24-claude-agent-demo`  
**Fecha:** 2026-04-04  
**Autor:** Architect (NexusAgil F2)  
**Status:** PENDING SPEC_APPROVED

---

## 1. Context Map (Codebase Grounding)

### Archivos leídos como exemplars

| Archivo | Rol en el demo |
|---------|---------------|
| `src/lib/x402-signer.ts` | **Exemplar primario** — exporta `signX402Authorization({ to, value, timeoutSeconds })` → `{ xPaymentHeader, paymentRequest }` |
| `src/middleware/x402.ts` | **Fuente de verdad** — `KITE_WALLET_ADDRESS` env var = wallet del servidor A2A = `to` del pago |
| `src/routes/discover.ts` | **API contract** — GET /discover?q=&capabilities=&limit= → `DiscoveryResult` |
| `src/routes/compose.ts` | **API contract** — POST /compose + header `X-Payment` + body `{ steps: ComposeStep[], maxBudget? }` → `{ kiteTxHash, ...ComposeResult }` |
| `src/types/index.ts` | **Tipos** — `ComposeStep`, `ComposeResult`, `StepResult`, `X402PaymentRequest`, `DiscoveryResult`, `Agent` |

### Archivos nuevos a crear

| Archivo | Propósito |
|---------|-----------|
| `src/demo.ts` | Script autocontenido del demo |

### Archivos NO tocados
Todo lo demás del codebase queda intacto. Zero side effects.

---

## 2. Diseño Técnico de `src/demo.ts`

### 2.1 Flujo de ejecución

```
ts-node src/demo.ts "analiza el sentimiento de mercado de BTC"
         │
         ▼
[STEP 0] Validar env vars (OPERATOR_PRIVATE_KEY, KITE_WALLET_ADDRESS) → abort si faltan
         │
         ▼
[STEP 1] GET {A2A_SERVER_URL}/discover?q={goal}&limit=5
         │  Log: "🔍 Discovering agents for goal: {goal}"
         │  Log: "✅ Found {n} agents: {names}"
         │  Si n=0 → Log error + exit(1)
         ▼
[STEP 2] Seleccionar agentes → construir ComposeStep[]
         │  Log: "📋 Building pipeline with {n} steps"
         ▼
[STEP 3] signX402Authorization({ to: KITE_WALLET_ADDRESS, value, timeoutSeconds })
         │  Log: "🔐 Signing x402 EIP-712 authorization for A2A server..."
         │  Log: "✅ Payment authorized (validBefore: {timestamp})"
         ▼
[STEP 4] POST {A2A_SERVER_URL}/compose
         │  headers: { 'X-Payment': xPaymentHeader, 'Content-Type': 'application/json' }
         │  body: { steps: ComposeStep[], maxBudget? }
         │  Log: "🚀 Calling /compose..."
         ▼
[STEP 5] Imprimir resultado
         │  Log: "✅ txHash: {kiteTxHash}"
         │  Log: "📊 Output: {JSON output}"
         │  Log: "💰 Total cost: {totalCostUsdc} USDC in {totalLatencyMs}ms"
         ▼
        exit(0)
```

### 2.2 Selección de agentes

El demo toma los primeros `MAX_AGENTS` (default: 3) agentes retornados por /discover.
Cada agente se convierte en un `ComposeStep`:
```ts
{
  agent: agent.slug,      // slug del agente
  registry: agent.registry,
  input: { query: goal }, // input por defecto = el goal original
  passOutput: index > 0,  // los pasos 2+ reciben output del anterior
}
```

### 2.3 Configuración por env vars

| Var | Required | Default | Descripción |
|-----|----------|---------|-------------|
| `OPERATOR_PRIVATE_KEY` | ✅ YES | — | Private key del operador para firma EIP-712 |
| `KITE_WALLET_ADDRESS` | ✅ YES | — | Wallet del servidor A2A (destino del pago) |
| `A2A_SERVER_URL` | NO | `http://localhost:3001` | URL base del servidor A2A |
| `KITE_PAYMENT_AMOUNT` | NO | `1000000000000000000` | Monto en wei |
| `KITE_RPC_URL` | NO | `https://rpc-testnet.gokite.ai/` | RPC Kite testnet |

### 2.4 Imports reales del demo.ts

```ts
import { signX402Authorization } from './lib/x402-signer.js'
import type { ComposeStep, ComposeResult } from './types/index.js'
```

No hay imports nuevos de npm. Usa `node:process` para args y `globalThis.fetch` (Node 18+).

### 2.5 Manejo de errores

| Condición | Comportamiento |
|-----------|---------------|
| `OPERATOR_PRIVATE_KEY` no definido | `console.error` + `process.exit(1)` |
| `KITE_WALLET_ADDRESS` no definido | `console.error` + `process.exit(1)` |
| Sin argumento goal | `console.error("Usage: ts-node src/demo.ts <goal>")` + `process.exit(1)` |
| /discover retorna 0 agentes | `console.error` + `process.exit(1)` — AC-4 |
| /compose retorna error HTTP | `console.error` con status + body + `process.exit(1)` |
| /compose retorna 2xx pero `result.success === false` | `console.error` con error + `process.exit(1)` |
| `kiteTxHash` viene `undefined` | Log: "⚠️ txHash not available (payment may not have settled)" — no es error fatal |

### 2.6 Edge cases documentados (post Spec Review)
- **1 solo agente:** `passOutput: false` — correcto, el input del step se pasa directamente.
- **`A2A_SERVER_URL`:** Es una var de entorno solo para el demo, no forma parte del servidor. No va en `.env.example` del servidor. El dev la setea en su shell o en un `.env.demo` local.
- **`kiteTxHash` undefined:** El middleware settle puede fallar silenciosamente en edge cases de red. El demo loguea warning pero no falla — el output de /compose puede ser válido aunque no haya txHash.

---

## 3. ⚠️ Constraint Directives

### CD-1: Flujo de Pago Correcto (CRÍTICO)

> **El demo.ts NO llama directamente los `invokeUrl` de los agentes.**

```
PROHIBIDO:  demo.ts → agent.invokeUrl (Avalanche/USDC)
CORRECTO:   demo.ts → /compose del servidor A2A (Railway/Kite)
```

El demo.ts firma UN SOLO pago x402 EIP-712 dirigido al servidor A2A (`KITE_WALLET_ADDRESS`).
El servidor A2A internamente orquesta y llama a los agentes individuales.
**Firmar pagos por cada `agent.invokeUrl` es un error de arquitectura.**

### CD-2: No logear secretos

El `OPERATOR_PRIVATE_KEY` y la `signature` nunca deben aparecer en logs.
(Ya documentado en `x402-signer.ts` línea 1: `NUNCA logear privateKey ni signature`)

### CD-3: Imports vivos solamente

El demo usa SOLO imports confirmados como existentes:
- `./lib/x402-signer.js` — verificado existente
- `./types/index.js` — verificado existente

### CD-4: Zero side effects en codebase

El demo es un script standalone. No modifica ningún archivo existente del servidor.
No añade rutas, no toca `server.ts`, no modifica `package.json` (solo añade `ts-node` si no está).

### CD-5: `to` del pago = `KITE_WALLET_ADDRESS`

La variable de entorno `KITE_WALLET_ADDRESS` es el wallet del servidor A2A.
Esto se verifica en `src/middleware/x402.ts` → `buildX402Response` → `payTo: process.env.KITE_WALLET_ADDRESS`.
El demo usa exactamente la misma var para el argumento `to` de `signX402Authorization`.

---

## 4. Readiness Check

| Criterio | Estado |
|----------|--------|
| Archivos exemplar leídos y verificados existentes | ✅ |
| `signX402Authorization` API confirmada | ✅ |
| `/discover` query params confirmados | ✅ |
| `/compose` body shape + header confirmados | ✅ |
| `ComposeStep` tipo confirmado | ✅ |
| Response shape con `kiteTxHash` confirmado (en compose.ts handler) | ✅ |
| Constraint de flujo de pago documentado explícitamente | ✅ |
| Env vars mapeadas y validadas | ✅ |
| No hay `[NEEDS CLARIFICATION]` pendientes | ✅ |
| Zero dependencias npm nuevas | ✅ |

**SDD listo para Story File (F2.5).**

---

## 5. Plan de Waves

### W0 — Validación y descubrimiento
- Validar env vars
- Llamar /discover
- Log de agentes encontrados

### W1 — Firma x402 y compose
- Construir ComposeStep[]
- Firmar autorización EIP-712 via `signX402Authorization`
- POST /compose con header X-Payment

### W2 — Output
- Imprimir txHash + output + cost
- Exit codes correctos

**No hay dependencias externas entre waves. Es un script lineal.**
