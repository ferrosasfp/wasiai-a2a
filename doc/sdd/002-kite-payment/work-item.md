# WKH-6 — Kite Service Provider: x402 Payment Middleware + Wallet Identity

**Tipo:** User Story  
**Sprint:** Kite Hackathon  
**Prioridad:** Alta  
**Estimación:** 5 puntos  
**Depende de:** WKH-5 (conceptual, no bloqueante en código — ver sección Dependencias)  
**Branch:** `feat/wkh-6-kite-payment` (base: `main`)

---

## Historia de Usuario

**Como** Service Provider registrado en Kite Agent Passport,  
**quiero** que los endpoints `POST /orchestrate` y `POST /compose` implementen el protocolo x402,  
**para** que agentes equipados con Kite Passport puedan pagar y consumir el servicio de forma autónoma.

---

## Contexto de Negocio

WasiAI actúa como **Service ID** en el ecosistema Kite Agent Passport — uno de los tres tipos de identidad del sistema (User ID, Agent ID, Service ID). Como Service Provider, WasiAI es responsable de:

1. Retornar HTTP 402 con el payload x402 correcto cuando no llega pago
2. Verificar el `X-Payment` header contra el facilitador Pieverse
3. Ejecutar el settle on-chain vía Pieverse cuando la verificación es exitosa
4. Entregar el resultado del servicio (orchestration / compose) después del settle

El flujo completo es:
```
Agent → POST /orchestrate (sin X-Payment)
  ← 402 + payload x402 (WasiAI)
Agent → [Kite MCP: approve_payment]
  ← X-Payment token (firmado por el usuario)
Agent → POST /orchestrate (con X-Payment)
WasiAI → POST /v2/verify (Pieverse)
  ← verification OK
WasiAI → POST /v2/settle (Pieverse)
  ← { txHash, ... }
WasiAI → ejecuta orchestration
  ← 200 { result, kiteTxHash }
```

### Constantes de red (Kite Testnet)

| Parámetro | Valor |
|-----------|-------|
| `scheme` | `gokite-aa` |
| `network` | `kite-testnet` |
| Payment token | `0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63` |
| Facilitador URL | `https://facilitator.pieverse.io` |
| Facilitador address | `0x12343e649e6b2b2b77649DFAb88f103c02F3C78b` |
| `maxAmountRequired` | `1000000000000000000` (1 Test USDT, en wei) |
| `maxTimeoutSeconds` | `300` |

---

## Acceptance Criteria

### AC-1 — 402 sin X-Payment en /orchestrate
```
WHEN  POST /orchestrate se recibe sin header X-Payment
THEN  retorna HTTP 402 con body:
      {
        "error": "X-PAYMENT header is required",
        "accepts": [{
          "scheme": "gokite-aa",
          "network": "kite-testnet",
          "maxAmountRequired": "1000000000000000000",
          "resource": "<URL del endpoint>",
          "description": "WasiAI Orchestration Service",
          "mimeType": "application/json",
          "outputSchema": { "input": {...}, "output": {...} },
          "payTo": "<KITE_WALLET_ADDRESS>",
          "maxTimeoutSeconds": 300,
          "asset": "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
          "extra": null,
          "merchantName": "WasiAI"
        }],
        "x402Version": 1
      }
AND   Content-Type es application/json
```

### AC-2 — Verificación con X-Payment válido en /orchestrate
```
WHEN  POST /orchestrate llega con header X-Payment (base64 JSON)
THEN  el middleware llama POST https://facilitator.pieverse.io/v2/verify
      con body: { authorization, signature, network: "kite-testnet" }
AND   espera respuesta del facilitador antes de continuar
```

### AC-3 — Ejecución de orchestration tras verify OK
```
WHEN  /v2/verify retorna 200 con valid: true
THEN  el middleware llama POST https://facilitator.pieverse.io/v2/settle
      con el mismo payload
AND   si settle es exitoso, se ejecuta el orchestrateService.orchestrate(...)
AND   la respuesta incluye el campo kiteTxHash del settle
```

### AC-4 — kiteTxHash en la respuesta
```
WHEN  settle completa con éxito
THEN  la respuesta HTTP 200 tiene la forma:
      {
        "kiteTxHash": "0x...",
        ...resultado de orchestration...
      }
```

### AC-5 — Fallo en verificación o X-Payment inválido
```
IF    X-Payment no puede parsearse (base64 inválido, JSON malformado)
OR    /v2/verify retorna valid: false o error HTTP
THEN  retorna HTTP 402 con:
      {
        "error": "<mensaje descriptivo>",
        "accepts": [...mismo payload x402...],
        "x402Version": 1
      }
AND   NO se ejecuta el servicio ni se llama /v2/settle
```

### AC-6 — Mismo middleware en /compose
```
WHEN  POST /compose se recibe sin X-Payment
THEN  retorna 402 con payload x402 válido (igual al de /orchestrate,
      con resource y description ajustados para compose)
WHEN  POST /compose llega con X-Payment válido
THEN  aplica el mismo flujo verify → settle → execute
AND   respuesta incluye kiteTxHash
```

### AC-7 — Variables de entorno obligatorias
```
IF   KITE_WALLET_ADDRESS no está definida en el entorno
THEN el servidor arranca pero los endpoints /orchestrate y /compose retornan 503
     con body: { "error": "Service payment not configured. Contact administrator." }
AND  loguea error: "[FATAL] KITE_WALLET_ADDRESS not set — payment endpoints disabled"
     (no process.exit — el servidor puede servir /registries y /discover)
IF   KITE_FACILITATOR_URL no está definida
THEN usa "https://facilitator.pieverse.io" como default (no es error)
```

### AC-8 — Tipos TypeScript completos
```
GIVEN  src/types/index.ts
THEN   existen los siguientes tipos exportados:
       - X402PaymentPayload (el objeto dentro de "accepts")
       - X402Response (el body completo del 402)
       - X402PaymentRequest (el X-Payment header decodificado)
       - PieverseVerifyRequest
       - PieverseVerifyResponse
       - PieverseSettleRequest
       - PieverseSettleResult
AND    PaymentAuth existente se mantiene o amplía (no se rompe)
```

---

## Scope IN — Archivos a Modificar / Crear

### NUEVO: `src/middleware/payment.ts`
Hono middleware factory. Retorna un `MiddlewareHandler` que:
- Si no hay `X-Payment` → llama `buildPaymentRequired(c, opts)` y retorna 402
- Si hay `X-Payment` → parsea base64, llama `verifyPayment()`, luego `settlePayment()`
- En error → retorna 402 con descripción del error
- En éxito → setea `c.set('kiteTxHash', txHash)` y llama `next()`

```typescript
// Uso esperado en routes:
import { requirePayment } from '../middleware/payment.js'

app.post('/', requirePayment({ 
  description: 'WasiAI Orchestration Service',
  amount: '1000000000000000000'
}), async (c) => { ... })
```

### NUEVO: `src/services/kite/payment.ts`
Funciones puras para interactuar con Pieverse:
- `verifyPayment(xPaymentHeader: string): Promise<PieverseVerifyResponse>`
- `settlePayment(xPaymentHeader: string): Promise<PieverseSettleResult>`
- `buildPaymentRequired(opts): X402Response`
- `decodeXPayment(header: string): X402PaymentRequest`

**payment.ts NO importa kiteClient. Solo usa globalThis.fetch para llamar a Pieverse. No tiene dependencia de WKH-5.**

### MODIFICAR: `src/types/index.ts`
Añadir al bloque `PAYMENT TYPES (Kite)`:

```typescript
// x402 protocol types
export interface X402PaymentPayload {
  scheme: 'gokite-aa'
  network: 'kite-testnet' | 'kite-mainnet'
  maxAmountRequired: string       // wei string
  resource: string                // URL del endpoint
  description: string
  mimeType: string
  outputSchema?: {
    input?: Record<string, unknown>
    output?: Record<string, unknown>
  }
  payTo: string                   // wallet address del servicio
  maxTimeoutSeconds: number
  asset: string                   // token contract address
  extra: null | Record<string, unknown>
  merchantName: string
}

export interface X402Response {
  error: string
  accepts: X402PaymentPayload[]
  x402Version: 1
}

export interface X402PaymentRequest {
  authorization: {
    from: string
    to: string
    value: string
    validAfter: string
    validBefore: string
    nonce: string
  }
  signature: string
  network?: string
}

export interface PieverseVerifyRequest {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

export interface PieverseVerifyResponse {
  valid: boolean
  error?: string
}

export interface PieverseSettleRequest {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

export interface PieverseSettleResult {
  txHash: string
  success: boolean
  error?: string
}
```

### MODIFICAR: `src/routes/orchestrate.ts`
Añadir `requirePayment` middleware antes del handler:

```typescript
import { requirePayment } from '../middleware/payment.js'

app.post('/', requirePayment({
  description: 'WasiAI Orchestration Service — Goal-based AI agent orchestration',
  amount: '1000000000000000000',
  method: 'POST',
}), async (c) => {
  // ... handler existente ...
  
  // Añadir kiteTxHash a la respuesta:
  const kiteTxHash = c.get('kiteTxHash')
  return c.json({ kiteTxHash, ...result })
})
```

### NUEVO: `src/middleware/payment.test.ts`
Tests unitarios con Vitest: 8 tests cubriendo los ACs 1-6 + error paths

### MODIFICAR: `src/routes/compose.ts`
Idéntico al cambio de orchestrate.ts:

```typescript
import { requirePayment } from '../middleware/payment.js'

app.post('/', requirePayment({
  description: 'WasiAI Compose Service — Multi-agent pipeline execution',
  amount: '1000000000000000000',
  method: 'POST',
}), async (c) => {
  // ... handler existente ...
  const kiteTxHash = c.get('kiteTxHash')
  return c.json({ ...result, kiteTxHash })
})
```

### MODIFICAR: `.env.example`
Añadir sección Kite Service Provider:

```bash
# ─── Kite Service Provider (x402) ───────────────────────────────────────────
# Wallet address on Kite testnet that receives payments
KITE_WALLET_ADDRESS=0xYourServiceWalletAddress

# Pieverse facilitator URL (default: https://facilitator.pieverse.io)
KITE_FACILITATOR_URL=https://facilitator.pieverse.io

# Payment amount in wei (1 Test USDT = 1000000000000000000)
KITE_PAYMENT_AMOUNT=1000000000000000000

# Merchant name shown to users
KITE_MERCHANT_NAME=WasiAI
```

---

## Scope OUT (explícito)

- NO modificar `/registries` ni `/discover` — no tienen lógica de pago
- NO implementar Kite SDK Mode 2/3 (coming soon, no disponible en testnet)
- NO integrar con `GokiteAccount.sol` directamente — el settle lo hace Pieverse
- NO persistir transacciones en Supabase (fuera de scope de esta HU)
- NO implementar webhook de notificación de pago
- NO añadir UI/dashboard de pagos recibidos

---

## Diseño Técnico

### Estructura de Archivos

```
src/
├── middleware/
│   └── payment.ts          ← NUEVO (Hono MiddlewareHandler)
├── services/
│   ├── kite/
│   │   └── payment.ts      ← NUEVO (verifyPayment, settlePayment)
│   ├── kite-client.ts      ← existente (WKH-5, import lazy)
│   ├── orchestrate.ts      ← no modificar
│   └── compose.ts          ← no modificar
├── routes/
│   ├── orchestrate.ts      ← MODIFICAR (añadir middleware)
│   └── compose.ts          ← MODIFICAR (añadir middleware)
└── types/
    └── index.ts            ← MODIFICAR (nuevos tipos x402)
```

### Hono Context Variables

El middleware setea variables en el contexto Hono:
- `c.set('kiteTxHash', string)` — hash de la tx on-chain del settle
- `c.set('kitePaymentVerified', true)` — flag de pago verificado

Cada route que use requirePayment define su propio tipo Variables en su Hono app local:
```typescript
// En src/routes/orchestrate.ts y compose.ts:
type Variables = { kiteTxHash: string; kitePaymentVerified: boolean }
const app = new Hono<{ Variables: Variables }>()
```
src/index.ts no se modifica.

### Flujo de Error

```
X-Payment ausente
  → 402 con payload x402 completo

X-Payment presente pero base64 inválido
  → 402 con error: "Invalid X-Payment format: <detail>"

/v2/verify retorna valid: false
  → 402 con error: "Payment verification failed: <facilitator error>"

/v2/verify falla con HTTP error
  → 402 con error: "Facilitator unavailable: <status>"

/v2/settle falla
  → 402 con error: "Payment settlement failed: <detail>"
  → NO ejecutar el servicio (fondos potencialmente no transferidos)
```

### Formato X-Payment Header

El header `X-Payment` es un JSON base64-encoded:
```json
{
  "authorization": {
    "from": "0x<usuario>",
    "to": "0x<servicio>",
    "value": "1000000000000000000",
    "validAfter": "0",
    "validBefore": "1234567890",
    "nonce": "0x..."
  },
  "signature": "0x...",
  "network": "kite-testnet"
}
```

Decodificar con: `JSON.parse(Buffer.from(header, 'base64').toString('utf8'))`

### Pieverse API — Contratos de Integración

**POST /v2/verify**
```
Request:  { authorization, signature, network: "kite-testnet" }
Response: { valid: boolean, error?: string }
```

**POST /v2/settle**
```
Request:  { authorization, signature, network: "kite-testnet" }
Response: { txHash: string, success: boolean, error?: string }
```

Ambos endpoints esperan `Content-Type: application/json`.

---

## Dependencias

### WKH-5 (Kite Chain + kiteClient)
- **Estado en main:** No mergeado (está en PR feat/wkh-5-kite-chain)
- **Impacto en WKH-6:** `src/index.ts` ya importa `kiteClient` directamente
- **Mitigación:** `payment.ts` NO importa kiteClient — solo usa globalThis.fetch para Pieverse. Sin dependencia directa en código.
- **En producción (ambas HUs mergeadas):** Sin cambios necesarios en payment.ts.

### Dependencias externas nuevas
- **Ninguna nueva librería npm requerida.** El middleware usa:
  - `hono` (ya en dependencies)
  - `node fetch` / `globalThis.fetch` (Node ≥18, ya requerido)
  - `Buffer` (Node built-in)

---

## Testing

### Unit Tests (`src/middleware/payment.test.ts`)
- [ ] `buildPaymentRequired()` genera payload x402 válido con todos los campos requeridos
- [ ] `decodeXPayment()` parsea base64 correctamente
- [ ] `decodeXPayment()` lanza error descriptivo con base64 inválido
- [ ] Middleware retorna 402 cuando no hay X-Payment header
- [ ] Middleware llama verifyPayment con el header correcto
- [ ] Middleware retorna 402 cuando verifyPayment retorna `valid: false`
- [ ] Middleware setea `kiteTxHash` en contexto cuando settle OK
- [ ] Middleware llama `next()` después de settle exitoso

### Integration Tests (manual con curl)
```bash
# AC-1: Sin X-Payment → 402
curl -s -X POST http://localhost:3001/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"goal":"test","budget":1}' | jq .

# AC-5: X-Payment inválido → 402 descriptivo
curl -s -X POST http://localhost:3001/orchestrate \
  -H "Content-Type: application/json" \
  -H "X-Payment: invalido" \
  -d '{"goal":"test","budget":1}' | jq .

# AC-2+3: Con X-Payment válido → verifica y settle
# (requiere X-Payment real del portal Kite)
```

---

## Definición de Done

- [ ] `src/middleware/payment.ts` creado y tipado
- [ ] `src/services/kite/payment.ts` creado con verifyPayment + settlePayment
- [ ] `src/types/index.ts` actualizado con todos los tipos x402
- [ ] `src/routes/orchestrate.ts` usa `requirePayment` middleware
- [ ] `src/routes/compose.ts` usa `requirePayment` middleware
- [ ] `.env.example` tiene KITE_WALLET_ADDRESS, KITE_FACILITATOR_URL, etc.
- [ ] Tests unitarios del middleware pasan (`vitest run`)
- [ ] `curl` sin X-Payment retorna 402 con estructura x402 válida
- [ ] `curl` con X-Payment inválido retorna 402 con error descriptivo
- [ ] TypeScript compila sin errores (`tsc --noEmit`)
- [ ] Linter sin errores (`eslint src/`)
- [ ] PR creado con descripción del flujo x402 implementado

---

## Referencias

- [Service Provider Guide](https://docs.gokite.ai/kite-agent-passport/service-provider-guide)
- [x402 Protocol Spec](https://docs.x402.org/introduction)
- [Pieverse Facilitator](https://facilitator.pieverse.io/)
- [Weather Service Demo](https://x402.dev.gokite.ai/api/weather)
- [Kite x402 Reference](https://github.com/gokite-ai/x402)
- [Spike WKH-19](../../../doc/spikes/kite-ozone.md) — Network info, contracts, ABIs

---

F1_COMPLETE_V2 — 4 correcciones aplicadas por Requirements Reviewer
