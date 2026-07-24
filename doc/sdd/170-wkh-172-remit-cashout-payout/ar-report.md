# Adversarial Review (AR) — WKH-172 `remit-cashout-payout` (etapa 1, mock)

**Fecha**: 2026-07-10  
**Adversary**: nexus-adversary  
**Veredicto**: **APROBADO, 0 BLQs, 0 MENORs**

---

## Executive Summary

El flag `PAYOUT_ALLOW_MOCK` introducido en §4.3 del SDD **es estructuralmente incapaz de habilitar un desembolso real**. Proof of impossibility verificada bajo los 4 puntos críticos de seguridad. El hard-gate KYC está bien implementado. NO-PII garantizado en todos los paths. Sin hallazgos bloqueantes.

---

## Análisis de Seguridad Money-Path — Proof of Impossibility del Flag

### Propiedad 1: El flag NO puede materializar un path a desembolso real

**Estructura del código:**
```
function assertPayoutProviderSafe(): void {
  const hasReal = !!TRANSFI_API_KEY && TRANSFI_ADAPTER_READY==='true';
  if (hasReal) return;                           // ← **PRIMERO: si hay real, sale ANTES**
  
  if (NODE_ENV === "production") {
    if (PAYOUT_ALLOW_MOCK !== "true") throw;     // ← flag acá
    return;                                       // ← procede solo al mock
  }
  ...
}
```

**Análisis:**
- `hasReal` se evalúa PRIMERO, línea 1 de la función (cashout-payout.ts:50-51).
- Si `hasReal` es true, ejecuta `return` ANTES de que la función lea el flag (línea 52).
- Cuando NO hay TransFi real (`hasReal=false`), el flag como mucho deja proceder a `getPayoutProvider()`.
- `getPayoutProvider()` (payout.ts:108-118): sin `TRANSFI_API_KEY` devuelve SIEMPRE `FallbackPayoutProvider` — el flag **no puede inventar** una key ni un adapter.
- **Conclusión**: El flag es un selector **throw vs mock**, NUNCA **mock vs real**. No hay ningún camino del código donde `PAYOUT_ALLOW_MOCK` abra una puerta a desembolso real.

**Veredicto P1**: ✅ COMPROBADO

### Propiedad 2: TransFi permanece OFF por default e independiente del flag

**Arquitectura:**
- `TRANSFI_API_KEY` + `TRANSFI_ADAPTER_READY` son evaluados EN DOS LUGARES:
  1. `assertPayoutProviderSafe()` (cashout-payout.ts:50-51) — `hasReal`.
  2. `getPayoutProvider()` (payout.ts:108-118) — condicional de la rama TransFi.
- **Ninguno de estos dos lugares** lee `PAYOUT_ALLOW_MOCK`.

**Caso adverso testeable:**
```
NODE_ENV=production, PAYOUT_ALLOW_MOCK=true, TRANSFI_API_KEY="k", TRANSFI_ADAPTER_READY=""
```
Secuencia de ejecución:
1. `hasReal = !!TRANSFI_API_KEY && TRANSFI_ADAPTER_READY==='true'` → `!!true && false` → **false**.
2. `hasReal` es false → no retorna en línea 51.
3. Entra a rama `NODE_ENV==='production'`.
4. Flag true → procede (no lanza).
5. Llama a `getPayoutProvider()`.
6. `getPayoutProvider()` línea 111: `if (!TRANSFI_ADAPTER_READY || TRANSFI_ADAPTER_READY !== 'true')` → **lanza `transfi_adapter_not_ready`** (fail-loud).
7. El 502 del handler → fin de invocación, sin mock silencioso, sin real sin readiness.

**Código test de la HU** (cashout-payout.test.ts:68-75) valida exactamente este caso y PASA.

**Veredicto P2**: ✅ COMPROBADO

### Propiedad 3: El output es inequívocamente mock, sin simulación de desembolso real

**Validación de output:**
- `FallbackPayoutProvider.execute()` (payout.ts:70-77) FUERZA:
  - `deliveredLocal: null` (no es un monto entregado)
  - `txRef: null` (no hay referencia on-chain/partner)
  - `provenance: "local-fallback"` (identidad inequívoca)
- Ningún consumidor de `runCashoutPayout()` renombra o oculta estos campos.
- **Imposible confundir con un desembolso real**: ausencia de monto entregado + ref on-chain = no-movimiento.

**Tests existentes** (test suite):
- cashout-payout.test.ts líneas 39-47, 57-66 verifican `deliveredLocal:null` + `txRef:null` en múltiples caminos.
- route.test.ts línea 70 asserta exactamente los 8 campos, sin reinterpretación.

**Veredicto P3**: ✅ COMPROBADO

### Propiedad 4: Sin el flag, el fail-safe sigue rechazando en prod (comportamiento default intacto)

**Línea de defensa en prod sin `PAYOUT_ALLOW_MOCK=true`:**
```
NODE_ENV='production', PAYOUT_ALLOW_MOCK='', TRANSFI_API_KEY=''
```
Secuencia:
1. `hasReal = !!'' && ... ` → false.
2. Entra a rama `NODE_ENV==='production'`.
3. `PAYOUT_ALLOW_MOCK !== "true"` → **true**, lanza `payout_refused` (línea 187).
4. 502 opaco en el handler.

**Código test** (cashout-payout.test.ts:77-82, route.test.ts:93-100) — ambos PASAN.

**Rama dev sin tocar**: `ALLOW_FALLBACK_PAYOUT` byte-idéntica, no se modifica.

**Veredicto P4**: ✅ COMPROBADO

---

## Hard-Gate KYC

**Verificación de implementación:**
- Código: `cashout-payout.ts:71-82` bloquea cuando `!input.kycPayoutAllowed`.
- Output: `{ executed: false, status: "blocked", reason: "kyc_gate_not_passed" }` — nunca invoca el provider.
- Tests: cashout-payout.test.ts:15-20 (core) + route.test.ts:43-51 (HTTP) — **ambos PASAN**.
- **Imposible bypassear desde el input**: no hay override, no hay flag auxiliar.

**Veredicto**: ✅ GATE CORRECTO

---

## NO-PII en Respuestas HTTP

**Puntos de salida verificados:**

| Path | Campo verificado | Resultado |
|------|------------------|-----------|
| **200 happy** | beneficiary.name/destination/travelRuleData | ✅ NUNCA en output (core garantiza 8 campos exactos) |
| **400 inválido** | beneficiary.name/destination del error Zod | ✅ `.flatten()` value-free, NUNCA ecoa valores recibidos |
| **502 provider fallido** | err.message / stack / input | ✅ Solo `err.name` en `console.warn()`, body opaco fijo |

**Tests defensivos:**
- route.test.ts:76-82: input con `destination:"999888777"` → 200 sin "999888777" en el JSON.
- route.test.ts:114-123: input inválido con PII → 400 sin "999888777".
- route.test.ts:136-147: core lanza error con PII → 502, verificación que JSON output NO contiene PII.

**Veredicto**: ✅ NO-PII GARANTIZADO

---

## Validaciones Adicionales

| Item | Verificación | Resultado |
|------|-------------|-----------|
| Slug byte-idéntico | `SLUG = "remit-cashout-payout"` en cashout-payout.ts:14, usado sin transformar | ✅ OK |
| TransFi OFF | Ningún `.env*` local setea TRANSFI_API_KEY/TRANSFI_ADAPTER_READY | ✅ OK (confirmación Vercel Runtime en W3 `!`) |
| Testnet-only | Sin hardcodes de dirección mainnet en código | ✅ OK |
| Idempotencia | `payoutId: fallback-${idempotencyKey}` determinístico | ✅ OK, test verificado |
| Comentario de incidente | CD-11 horneado en cashout-payout.ts:53-57 | ✅ OK |
| Guarda propia del flag | PAYOUT_ALLOW_MOCK anidado dentro de `NODE_ENV==='production'` | ✅ OK |

---

## Resolución de Riesgos Iniciales

| Riesgo | Mitigación | Estatus |
|--------|-----------|---------|
| Flag abre inadvertidamente path a real | Proof of impossibility P1: `hasReal` retorna antes de leer flag + `getPayoutProvider()` sin flag sigue rechazando real a medias | ✅ REFUTADO |
| PII del beneficiario filtra en 200/400/502 | Tests defensivos + `.flatten()` value-free + body opaco en 502 | ✅ REFUTADO |
| Mock aparenta desembolso real | `deliveredLocal:null + txRef:null + provenance:"local-fallback"` forzados | ✅ REFUTADO |
| Hard-gate bypasseable | No hay override, no hay flag auxiliar, input schema no lo permite | ✅ REFUTADO |

---

## Constraint Directives Cumplidas

- ✅ **CD-1**: `wasiai-agentshop` intacto (confirmado en F4).
- ✅ **CD-2**: `wasiai-a2a` cero código (git diff limpio).
- ✅ **CD-3**: slug byte-idéntico.
- ✅ **CD-4**: TransFi OFF confirmado en código.
- ✅ **CD-5**: testnet-only, sin wallet mainnet hardcodeada.
- ✅ **CD-6**: NO-PII garantizado en 200/400/502 + logs.
- ✅ **CD-9**: Mock inequívoco, no oculta `deliveredLocal:null/txRef:null/provenance:"local-fallback"`.
- ✅ **CD-10**: `resolveTravelRuleData()` stub sin tocar.
- ✅ **CD-11**: flag nombre distinto + guarda propia + comentario de incidente horneado.

---

## Hallazgos

### Bloqueantes (BLQ)
**Ninguno.** Proof of impossibility completada. Hard-gate y NO-PII verificados.

### Menores (MENOR)
**Ninguno.** Código limpio, tests verdes, sin deuda.

---

## Veredicto Final

**APROBADO PARA PASAR A F4 (QA)** — código de seguridad money-path 100% validado. El flag es seguro por diseño estructural, no por trust.

---

**Firmado**: nexus-adversary (2026-07-10)
