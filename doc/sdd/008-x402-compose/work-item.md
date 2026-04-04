# SDD-008 — x402 Compose Completo (WKH-9 + WKH-11)

| Campo | Valor |
|-------|-------|
| HU | WKH-9 (fusiona WKH-11) |
| Tipo | feature |
| Mode | QUALITY |
| Branch | `feat/wkh-9-x402-compose` |
| Base | `main` |
| Sizing | **M** (~60 LOC service + ~40 LOC signer + ~20 LOC types + ~80 LOC tests) |
| Riesgo | Medio — integra x402 client-side (nuevo patrón; server-side ya existe) |

---

## Contexto

`compose.ts` tiene 2 TODOs en `invokeAgent()`:
1. `// TODO: Add auth header based on registry config`
2. `// TODO: Add x402 payment header for Kite`

El middleware x402 ya implementa el **server-side** (recibir pagos). Falta el **client-side**: cuando WasiAI invoca agentes que requieren pago x402, debe generar el `X-Payment` header y settle on-chain.

### Patrones existentes relevantes

- **Registry auth**: `RegistryAuth` tiene `type: 'header' | 'query' | 'bearer'`, `key`, `value`. Discovery ya lo usa en `queryRegistry()` (líneas que construyen headers).
- **x402 helpers**: `decodeXPayment`, `verifyPayment`, `settlePayment` en `middleware/x402.ts` — reutilizables para el client-side settle.
- **Agent.priceUsdc**: ya existe y se usa para budget check. Agentes con `priceUsdc > 0` implican pago requerido.
- **Agent.registry**: permite resolver el `RegistryConfig` y su `auth`.

### Flujo propuesto para `invokeAgent`

```
1. Resolver RegistryConfig del agent.registry → obtener auth
2. Construir headers base (Content-Type + auth del registry)
3. Si agent.priceUsdc > 0:
   a. Hacer primera llamada → esperar 402 con accepts[]
   b. Generar X-Payment header (firmar con OPERATOR_PRIVATE_KEY via viem)
   c. Re-invocar con X-Payment header
   d. Settle on-chain via settlePayment()
4. Si priceUsdc === 0: invocar directo sin pago
```

**Alternativa simplificada (recomendada para hackathon):**
```
1. Si agent.priceUsdc > 0, construir X-Payment proactivamente
   (skip el roundtrip 402, asumir accepts[] conocido)
2. Invocar con auth + X-Payment
3. Si 402 → log error, fail step
```

---

## Acceptance Criteria (EARS format)

### AC-1: Auth headers del registry
**WHEN** compose service invoca un agente cuyo registry tiene `auth` configurado,
**THE SYSTEM SHALL** incluir los headers de autenticación correspondientes según `auth.type` (header/bearer/query).

### AC-2: Invocación con x402 payment
**WHEN** compose service invoca un agente con `priceUsdc > 0`,
**THE SYSTEM SHALL** generar un `X-Payment` header firmado con `OPERATOR_PRIVATE_KEY` y enviarlo en la request.

### AC-3: Settle on-chain post-invocación
**WHEN** un agente responde exitosamente (2xx) a una invocación con `X-Payment`,
**THE SYSTEM SHALL** llamar `settlePayment()` via Pieverse facilitador y registrar el `txHash` en el `StepResult`.

### AC-4: Budget check incluye fees x402
**WHEN** el `maxBudget` se valida antes de cada step,
**THE SYSTEM SHALL** usar `agent.priceUsdc` (que ya incluye el costo x402) para la validación.
*(Ya implementado — validar que sigue funcionando.)*

### AC-5: Fallback sin pago
**WHEN** un agente tiene `priceUsdc === 0` o el registry no requiere x402,
**THE SYSTEM SHALL** invocar sin `X-Payment` header (comportamiento actual).

### AC-6: Error handling en pago
**WHEN** la generación del `X-Payment` o el settle fallan,
**THE SYSTEM SHALL** marcar el step como failed con error descriptivo y no continuar el pipeline.

### AC-7: txHash en StepResult
**WHEN** un step completa con pago x402 exitoso,
**THEN** el `StepResult` SHALL incluir `txHash` con el hash de la transacción on-chain.
**WHEN** un step no requiere pago (priceUsdc === 0),
**THEN** `txHash` SHALL ser `undefined`.

---

## Scope

### IN
- `src/services/compose.ts` — refactor `invokeAgent()` para auth + x402
- `src/services/compose.ts` — helper `buildAuthHeaders(registry: RegistryConfig)`
- `src/lib/x402-signer.ts` — **NUEVO**: helper para firmar x402 authorization (EIP-712 con viem `createWalletClient` + `OPERATOR_PRIVATE_KEY`). NO mezclar con kite-client.ts (PublicClient readonly).
- `src/types/index.ts` — agregar `txHash?: string` a `StepResult`
- Tests: `src/services/compose.test.ts` (convención del proyecto: tests junto al source)

### OUT
- Cambios al middleware server-side (`requirePayment`) — ya funciona
- Cambios a discovery o registry — solo se lee config existente
- UI o dashboards de pagos
- Retry automático en 402 (simplificación hackathon)
- Multi-token support (solo Test USDT por ahora)

---

## DoR (Definition of Ready)

| Check | Status |
|-------|--------|
| AC definidos en EARS | ✅ |
| Tipos existentes revisados | ✅ |
| Dependencias identificadas (viem, Pieverse) | ✅ |
| Branch definido | ✅ |
| Env vars documentadas (`OPERATOR_PRIVATE_KEY`, `KITE_WALLET_ADDRESS`) | ✅ Ya en project-context |
| Patrón de auth del registry entendido | ✅ De discovery.ts |

---

## Waves

### Wave 1 — Auth headers (AC-1, AC-5)
- Refactor `invokeAgent` para recibir/resolver `RegistryConfig`
- Construir auth headers usando el mismo patrón que `discovery.ts:queryRegistry()`
- Test: mock registry con auth bearer → verifica header presente

### Wave 2 — x402 client-side (AC-2, AC-3, AC-6)
- Helper en `lib/viem.ts`: `signX402Authorization(agent, amount)` → base64 X-Payment
- En `invokeAgent`: si `priceUsdc > 0`, generar X-Payment y adjuntar
- Post-response: `settlePayment()` y capturar txHash
- Agregar `txHash` a `StepResult`
- Test: mock agent que requiere pago → verifica X-Payment header + settle call

### Wave 3 — Integration (AC-4)
- Verificar budget check end-to-end con costos reales
- Test de pipeline 2-step: step1 free + step2 paid → budget respetado

---

## Decisiones técnicas

1. **Proactive X-Payment** (no roundtrip 402): Para hackathon, generar X-Payment basándose en `agent.priceUsdc` sin esperar el 402. Reduce latencia 50%.
2. **EIP-712 via viem**: Usar `signTypedData` de viem con el schema x402 de Kite (ver schema abajo).
3. **Settle post-response**: Solo settle si el agente respondió 2xx. Si falla el agente, no settle (no se consumió el servicio).
4. **Resolver RegistryConfig en compose**: `Agent.registry` almacena el **name** (no id). Resolver con: `const registries = await registryService.getEnabled(); const config = registries.find(r => r.name === agent.registry)`. Mismo patrón que WKH-15 (CD-9).

---

## EIP-712 Schema para firma x402 (extraído de x402.ts types)

```typescript
// Domain — adaptado para Kite Testnet
const domain = {
  name: 'Kite x402',
  version: '1',
  chainId: 2368,  // Kite Testnet (env: KITE_CHAIN_ID)
  verifyingContract: '0x12343e649e6b2b2b77649DFAb88f103c02F3C78b' as `0x${string}`,  // KITE_FACILITATOR_ADDRESS
} as const

// Types — mapeo directo de X402PaymentRequest.authorization
const types = {
  Authorization: [
    { name: 'from', type: 'address' },      // Operator wallet
    { name: 'to', type: 'address' },        // Service provider (payTo)
    { name: 'value', type: 'uint256' },     // Amount in wei
    { name: 'validAfter', type: 'uint256' }, // 0 = immediate
    { name: 'validBefore', type: 'uint256' },// Deadline unix timestamp
    { name: 'nonce', type: 'bytes32' },      // Unique per authorization
  ],
} as const

const primaryType = 'Authorization' as const
```

**Fuente:** `src/types/index.ts` → `X402PaymentRequest.authorization` + `src/middleware/x402.ts` → `KITE_FACILITATOR_ADDRESS`

---

## Constraint Directives

| # | Constraint |
|---|-----------|
| CD-1 | **NUNCA logear** `OPERATOR_PRIVATE_KEY`, X-Payment header decodificado, ni signature raw. Solo logear txHash post-settle. |
| CD-2 | Resolver RegistryConfig via `registryService.getEnabled().find(r => r.name === agent.registry)` — NO usar `.get(agent.registry)` (registry es name, no id) |
| CD-3 | x402 signer en `src/lib/x402-signer.ts` — NO mezclar con `kite-client.ts` (PublicClient readonly) |
| CD-4 | TypeScript strict, sin `any` |
| CD-5 | Solo settle si agent respondió 2xx |

---

## Archivos a modificar

| Archivo | Cambio |
|---------|--------|
| `src/services/compose.ts` | Core: auth headers + x402 payment en `invokeAgent`, resolver RegistryConfig |
| `src/types/index.ts` | `StepResult.txHash?: string` |
| `src/lib/x402-signer.ts` | **NUEVO**: `signX402Authorization()` helper con `createWalletClient` + EIP-712 |
| `src/services/compose.test.ts` | Tests nuevos (convención del proyecto) |

---

*Generado: 2026-04-03 | Analyst+Architect F0+F1*
