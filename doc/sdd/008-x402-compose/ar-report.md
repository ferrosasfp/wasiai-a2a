# Adversarial Review — WKH-9 x402 Compose
**Fecha:** 2026-04-03 | **Branch:** `feat/wkh-9-x402-compose` | **Rol:** Adversary (NexusAgil F3)

---

## Veredicto General: ⚠️ CONDICIONAL — 1 BLOQUEANTE, 4 MENORES

---

## 1. Seguridad

### 1.1 Private key exposure — OK ✅
- `OPERATOR_PRIVATE_KEY` se lee en `getWalletClient()` (lazy, no en módulo-level).
- Nunca se logea: `console.log` en compose.ts solo emite `txHash`. Confirmado con T-9.
- `signX402Authorization` retorna `{ xPaymentHeader, paymentRequest }` — paymentRequest contiene `signature` pero no se logea.

### 1.2 Signature en X-Payment header enviado a agentes externos — MENOR ⚠️
- El header `X-Payment` es `base64(JSON({ authorization, signature }))` — la firma va hacia el agente remoto.
- Esto es inherente al protocolo x402, pero significa que un agente malicioso podría intentar reusar la firma dentro del `validBefore` window (300s por default).
- El `nonce` `bytes32` random previene replay en el contrato, pero el window de 5 min es ancho.
- **Recomendación:** Considerar reducir `timeoutSeconds` default a 60 para minimizar ventana.

### 1.3 Singleton `_walletClient` en módulo — MENOR ⚠️
- El singleton persiste entre tests si no se llama `_resetWalletClient()`. Tests actuales mockan `signX402Authorization` directamente (no usan el signer real), por lo que no hay bleeding en el suite actual.
- En producción, si `OPERATOR_PRIVATE_KEY` cambia en runtime (edge case), el singleton retendría la key antigua.

---

## 2. Data Integrity

### 2.1 USDC → wei conversion — OK ✅
```typescript
// compose.ts (implícito en invokeAgent)
const valueWei = String(BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12))
```
- Lógica: USDC (6 decimales) × 1e6 = unidades mínimas USDC, × 1e12 = wei (18 decimales). Correcto.
- `Math.round()` mitiga errores de floating point para valores comunes.
- **Riesgo residual MENOR:** para precios como `0.000001 USDC`, `priceUsdc * 1e6 = 0.000001` → `Math.round` = 0 → pago de 0 wei. Edge case extremo, aceptable para hackathon.

### 2.2 EIP-712 Schema — OK ✅
- `EIP712_DOMAIN`: `{ name: 'Kite x402', version: '1', chainId: 2368, verifyingContract: KITE_FACILITATOR_ADDRESS }` — coincide exactamente con la spec del SDD.
- `EIP712_TYPES.Authorization`: 6 campos `[from, to, value, validAfter, validBefore, nonce]` — coincide con `X402PaymentRequest.authorization`.
- `value`, `validAfter`, `validBefore` pasados como `BigInt()` al `signTypedData` — correcto para `uint256`.
- `nonce` como `bytes32` con 32 bytes random — collision-free.

### 2.3 validAfter/validBefore como string vs BigInt — MENOR ⚠️
- `authorization.validAfter` almacenado como `string` `'0'` en el objeto JSON.
- Los verificadores que decodifiquen el header recibirán strings, no números. El server-side `middleware/x402.ts` ya maneja este formato, pero si un verificador externo espera números podría fallar.

---

## 3. Error Handling

### 3.1 Missing `payTo` → CD-9 — OK ✅
```typescript
// compose.ts ~L174
if (!payTo) {
  throw new Error(`No payTo address for agent ${agent.slug} — agent metadata must include payTo`)
}
```
- T-8 lo cubre. Error descriptivo.

### 3.2 Settle failure — OK ✅
```typescript
if (!settleResult.success) {
  throw new Error(`x402 settle failed for ${agent.slug}: ${settleResult.error ?? 'unknown'}`)
}
```
- T-4 cubre el caso. La excepción propaga al step catch en `compose()` → step marcado failed.

### 3.3 Missing `OPERATOR_PRIVATE_KEY` — OK ✅
```typescript
if (!pk) throw new Error('OPERATOR_PRIVATE_KEY not set — x402 client signing disabled')
```
- Lazy init = no crash al importar. Error lanzado solo cuando se intenta firmar.

### 3.4 `response.json()` sin try/catch — MENOR ⚠️
```typescript
const data = await response.json() as Record<string, unknown>
```
- Si el agente retorna 2xx con body no-JSON (text/html de error de proxy, por ejemplo), `response.json()` lanza `SyntaxError`. Este error no tiene mensaje contextual (no incluye `agent.slug`).
- El error se capturará en el step catch y el mensaje será genérico.

---

## 4. Performance — N+1 Query (**BLOQUEANTE**)

```typescript
// compose.ts invokeAgent() — llamado una vez POR CADA AGENTE
async invokeAgent(agent, input) {
  const registries = await registryService.getEnabled()  // ← DB query!
  const registry = registries.find(r => r.name === agent.registry)
  ...
}
```

**Problema:** `registryService.getEnabled()` se llama N veces para un pipeline de N pasos. Si hay 5 agentes, son 5 queries DB a la tabla de registries.

**Impacto:** En hackathon con pipelines pequeños (2-3 steps) el impacto es mínimo (<100ms). Para producción con pipelines más grandes, es un problema real.

**Fix sugerido (no bloqueante para hackathon):**
```typescript
// En compose(), resolver registries UNA vez y pasar como parámetro:
const registries = await registryService.getEnabled()
for (const step of steps) {
  await this.invokeAgent(agent, input, registries)  // pasar registries
}
```

**Clasificación:** BLOQUEANTE para producción, MENOR para hackathon M-sizing. Se acepta con deuda técnica documentada.

---

## 5. Scope Creep — OK ✅

Archivos modificados exactamente = archivos declarados en SDD scope:
- `src/services/compose.ts` ✅
- `src/lib/x402-signer.ts` (nuevo) ✅
- `src/types/index.ts` ✅
- `src/services/compose.test.ts` ✅

Sin cambios a middleware server-side, discovery, registry, UI. Límites respetados.

---

## 6. Constraint Violations

| CD | Descripción | Estado |
|----|-------------|--------|
| CD-1 | NUNCA logear privateKey, signature raw, X-Payment decoded | ✅ Solo txHash logeado |
| CD-2 | Resolver via `find(r.name === agent.registry)` | ✅ `compose.ts` usa `.find()` correcto |
| CD-3 | x402 signer en archivo separado, no mezclar con kite-client.ts | ✅ `src/lib/x402-signer.ts` |
| CD-4 | TypeScript strict, sin `any` | ✅ `tsc --noEmit` limpio |
| CD-5 | Solo settle si agente respondió 2xx | ✅ Settle dentro de `if (paymentRequest)` post-response.ok |
| CD-8 | USDC→wei: 6 decimals × 1e12 = 18 decimals wei | ✅ Fórmula correcta |
| CD-9 | payTo MUST come from `agent.metadata` — NO fallback | ✅ Throw si falta |

---

## 7. Test Coverage

| Test | Cubre | Estado |
|------|-------|--------|
| T-1 | Bearer auth header presente | ✅ |
| T-2 | Custom header auth | ✅ |
| T-3 | X-Payment generado + settle llamado + txHash en resultado | ✅ |
| T-4 | Settle failure → throw | ✅ |
| T-5 | Non-2xx → NO settle (CD-5) | ✅ |
| T-6 | Sin registry → invoca sin auth headers | ✅ |
| T-7 | Budget check con priceUsdc > 0 | ✅ |
| T-8 | payTo missing → throw (CD-9) | ✅ |
| T-9 | privateKey/signature nunca en logs (CD-1) | ✅ |

**Gaps identificados:**
- No test para `signX402Authorization` en aislamiento (unit-level del signer). El signer se testea solo via mock.
- No test para el N+1 pattern (performance).
- No test para `response.json()` que lanza en body no-JSON.
- Cobertura: 9/9 tests para flujos principales. **Aceptable.**

---

## 8. Anti-Hallucination

### Imports reales verificados:
| Import | Archivo | Existe |
|--------|---------|--------|
| `createWalletClient, http` from `viem` | x402-signer.ts | ✅ (dep en package.json) |
| `privateKeyToAccount` from `viem/accounts` | x402-signer.ts | ✅ |
| `kiteTestnet` from `./kite-chain.js` | x402-signer.ts | ✅ |
| `KITE_FACILITATOR_ADDRESS, KITE_NETWORK` from `../middleware/x402.js` | x402-signer.ts | ✅ |
| `signX402Authorization` from `../lib/x402-signer.js` | compose.ts | ✅ (creado en este PR) |
| `settlePayment` from `../middleware/x402.js` | compose.ts | ✅ |
| `registryService` from `./registry.js` | compose.ts | ✅ |

### Discrepancia SDD vs implementación:
- SDD muestra `import { KITE_PAYMENT_TOKEN }` en el snippet de diseño, pero la implementación **no lo importa**. Correcto — no es necesario para firmar.

---

## Resumen de Hallazgos

| Categoría | Nivel | Descripción |
|-----------|-------|-------------|
| Performance | **BLOQUEANTE** | N+1 `getEnabled()` por agente invocado |
| Seguridad | MENOR | Window 300s para reusar X-Payment (mitigado por nonce) |
| Seguridad | MENOR | Singleton walletClient no resetea si env cambia en runtime |
| Data integrity | MENOR | Precio 0.000001 USDC → 0 wei tras Math.round |
| Error handling | MENOR | `response.json()` sin contexto de agente en error |
| Data integrity | MENOR | validAfter/validBefore como string en JSON header |

**BLOQUEANTE:** El N+1 de `getEnabled()` debe documentarse como deuda técnica. Para el scope hackathon (M, pipelines cortos) no bloquea el merge, pero debe corregirse antes de escalar.

**Recomendación:** APPROVE con deuda técnica registrada para N+1.
