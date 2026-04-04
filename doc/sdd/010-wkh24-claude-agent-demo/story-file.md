# Story File — WKH-24: Claude Agent Demo Script
**Work Item:** #010  
**Branch:** `feat/wkh-24-claude-agent-demo`  
**Fecha:** 2026-04-04  
**Generado por:** Architect (NexusAgil F2.5)

> **CONTRATO AUTOCONTENIDO PARA DEV**  
> Lee SOLO este archivo. No necesitas leer el SDD ni el codebase completo.  
> Toda la información necesaria está aquí.

---

## 📋 Qué construir

Un script CLI `src/demo.ts` que:
1. Recibe un goal en lenguaje natural como argumento CLI
2. Llama `/discover` para encontrar agentes
3. Firma un pago x402 EIP-712 dirigido al servidor A2A
4. Llama `/compose` con el pago firmado
5. Imprime txHash + output

**ÚNICO archivo a crear:** `src/demo.ts`  
**CERO archivos modificados** en el codebase existente.

---

## ⚠️ CONSTRAINT CRÍTICO — Lee esto primero

```
❌ PROHIBIDO:  demo.ts → agent.invokeUrl  (directo a cada agente)
✅ CORRECTO:   demo.ts → /compose del servidor A2A
```

El demo firma **UN SOLO** pago x402 dirigido al servidor A2A (`KITE_WALLET_ADDRESS`).  
El servidor A2A maneja internamente los pagos a cada agente.  
No firmar pagos por cada agente individual.

---

## 🔧 Env vars necesarias

| Var | Obligatoria | Default | Descripción |
|-----|-------------|---------|-------------|
| `OPERATOR_PRIVATE_KEY` | ✅ SÍ | — | Private key del operador (0x...) |
| `KITE_WALLET_ADDRESS` | ✅ SÍ | — | Wallet del servidor A2A — es el `to` del pago |
| `KITE_RPC_URL` | no | `https://rpc-testnet.gokite.ai/` | Usado internamente por x402-signer |
| `A2A_SERVER_URL` | no | `http://localhost:3001` | URL del servidor A2A |
| `KITE_PAYMENT_AMOUNT` | no | `1000000000000000000` | Monto en wei (1 Test USDT) |

---

## 📦 Imports a usar

```typescript
import { signX402Authorization } from './lib/x402-signer.js'
import type { ComposeStep, ComposeResult } from './types/index.js'
```

Solo estos dos. No importar nada más del codebase. No añadir dependencias npm.  
Usar `globalThis.fetch` (Node 18+) para HTTP. Usar `process.argv` para args CLI.

---

## 🏗️ Implementación — Wave por Wave

### W0: Validación y setup

```typescript
// 1. Leer goal del CLI
const goal = process.argv[2]
if (!goal) {
  console.error('Usage: ts-node src/demo.ts "<goal>"')
  process.exit(1)
}

// 2. Validar env vars obligatorias
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY
const KITE_WALLET_ADDRESS = process.env.KITE_WALLET_ADDRESS as `0x${string}`

if (!OPERATOR_PRIVATE_KEY) {
  console.error('[ERROR] OPERATOR_PRIVATE_KEY is not set. Cannot sign x402 authorization.')
  process.exit(1)
}
if (!KITE_WALLET_ADDRESS) {
  console.error('[ERROR] KITE_WALLET_ADDRESS is not set. Cannot determine payment destination.')
  process.exit(1)
}

const A2A_SERVER_URL = process.env.A2A_SERVER_URL ?? 'http://localhost:3001'
const KITE_PAYMENT_AMOUNT = process.env.KITE_PAYMENT_AMOUNT ?? '1000000000000000000'
```

### W1: Discover agents

```typescript
console.log(`\n🔍 [STEP 1] Discovering agents for goal: "${goal}"`)

const discoverUrl = `${A2A_SERVER_URL}/discover?q=${encodeURIComponent(goal)}&limit=5`
const discoverRes = await fetch(discoverUrl)

if (!discoverRes.ok) {
  console.error(`[ERROR] /discover failed with HTTP ${discoverRes.status}`)
  process.exit(1)
}

const discovery = await discoverRes.json() as { agents: Array<{ id: string; name: string; slug: string; registry: string }> }
const agents = discovery.agents ?? []

if (agents.length === 0) {
  console.error('[ERROR] No agents found for this goal. Cannot proceed.')
  process.exit(1)
}

console.log(`✅ Found ${agents.length} agent(s): ${agents.map(a => a.name).join(', ')}`)
```

### W2: Build ComposeStep[]

```typescript
console.log(`\n📋 [STEP 2] Building pipeline with ${agents.length} step(s)`)

const MAX_AGENTS = 3
const selectedAgents = agents.slice(0, MAX_AGENTS)

const steps: ComposeStep[] = selectedAgents.map((agent, index) => ({
  agent: agent.slug,
  registry: agent.registry,
  input: { query: goal },
  passOutput: index > 0,   // pasos 2+ encadenan output del anterior
}))
```

### W3: Sign x402 authorization

```typescript
console.log(`\n🔐 [STEP 3] Signing x402 EIP-712 authorization for A2A server...`)

const { xPaymentHeader } = await signX402Authorization({
  to: KITE_WALLET_ADDRESS,
  value: KITE_PAYMENT_AMOUNT,
  timeoutSeconds: 300,
})

console.log(`✅ Payment authorized (KITE_WALLET_ADDRESS: ${KITE_WALLET_ADDRESS})`)
// NO logear xPaymentHeader completo ni la private key
```

### W4: POST /compose

```typescript
console.log(`\n🚀 [STEP 4] Calling ${A2A_SERVER_URL}/compose...`)

const composeRes = await fetch(`${A2A_SERVER_URL}/compose`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Payment': xPaymentHeader,
  },
  body: JSON.stringify({ steps, maxBudget: undefined }),
})

if (!composeRes.ok) {
  const errBody = await composeRes.text()
  console.error(`[ERROR] /compose failed with HTTP ${composeRes.status}: ${errBody}`)
  process.exit(1)
}

const result = await composeRes.json() as { kiteTxHash?: string } & ComposeResult

if (!result.success) {
  console.error(`[ERROR] Compose pipeline failed: ${result.error ?? 'unknown error'}`)
  process.exit(1)
}
```

### W5: Print output

```typescript
console.log(`\n✅ [STEP 5] Done!`)

if (result.kiteTxHash) {
  console.log(`💳 txHash: ${result.kiteTxHash}`)
} else {
  console.log(`⚠️  txHash not available (payment settlement may be pending)`)
}

console.log(`📊 Output:\n${JSON.stringify(result.output, null, 2)}`)
console.log(`💰 Total cost: ${result.totalCostUsdc ?? 0} USDC`)
console.log(`⏱️  Latency: ${result.totalLatencyMs ?? 0}ms`)

process.exit(0)
```

---

## ✅ Acceptance Criteria — Checklist del Dev

Antes de dar por terminada la implementación, verificar:

- [ ] **AC-1:** `ts-node src/demo.ts "goal"` imprime los agentes descubiertos con sus nombres
- [ ] **AC-2:** El demo firma X-Payment EIP-712 via `signX402Authorization()` con `to = KITE_WALLET_ADDRESS` (el servidor A2A) — NO firma por cada agente individual
- [ ] **AC-3:** Cuando /compose responde 2xx, imprime `txHash:` y el output del pipeline
- [ ] **AC-4:** Cuando /discover retorna 0 agentes, imprime error descriptivo y sale con exit code 1
- [ ] **AC-5:** Hay logs en cada paso (🔍, 📋, 🔐, 🚀, ✅)
- [ ] **AC-6:** Cuando `OPERATOR_PRIVATE_KEY` no está definido, imprime error claro y sale con exit code 1
- [ ] **CD-1:** El script NO llama `agent.invokeUrl` directamente — SOLO llama `/compose`
- [ ] **CD-2:** El `OPERATOR_PRIVATE_KEY` y la `signature` NO aparecen en ningún log
- [ ] **CD-4:** No se modificó ningún archivo existente del codebase

---

## 🏃 Cómo ejecutar

```bash
# Setup
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
git checkout feat/wkh-24-claude-agent-demo

# Env vars (shell o .env.demo)
export OPERATOR_PRIVATE_KEY=0x...
export KITE_WALLET_ADDRESS=0x...
export A2A_SERVER_URL=https://your-railway-app.up.railway.app  # o localhost:3001

# Ejecutar
npx ts-node src/demo.ts "find me an agent that can analyze crypto market sentiment"
```

---

## 📁 Estructura final esperada

```
src/
  demo.ts          ← NUEVO (único archivo)
  lib/
    x402-signer.ts  ← NO tocar
  middleware/
    x402.ts         ← NO tocar
  routes/
    discover.ts     ← NO tocar
    compose.ts      ← NO tocar
  types/
    index.ts        ← NO tocar
```
