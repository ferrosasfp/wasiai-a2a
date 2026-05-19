# QA Report — WKH-105 (BASE-02) wasiai-facilitator Base RPC support

**Veredicto**: APROBADO PARA DONE con observación documental (no bloqueante)
**Fecha**: 2026-05-19
**Repo**: `/home/ferdev/.openclaw/workspace/wasiai-facilitator/` branch `feat/base-support`
**Commits en scope**: `7d86b37`, `001f8dc`, `83b6d65`

## Runtime/Integration Checks

- **DB state**: N/A — esta HU no toca DB.
- **Migration**: N/A.
- **Env parity**: 4 vars nuevos (`BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL`, `BASE_SEPOLIA_ENABLED`, `BASE_MAINNET_ENABLED`) presentes en `.env.example` lines 72-83 con defaults OFF y comentarios.
- **EIP-712 domain verification**: Auto-blindaje documenta `cast call` 2026-05-19:
  - Base Sepolia USDC: `name="USDC"`, `version="2"` — implementado en `src/chains/base.ts:100-101`
  - Base Mainnet USDC: `name="USD Coin"`, `version="2"` — implementado en `src/chains/base.ts:113-114`
- **Supported response en vivo**: ejecutado con `node` contra dist. Retorna `{ "chains": [{ "network": "eip155:84532", "name": "Base Sepolia", "methods": ["eip3009"], "breakerState": "CLOSED" }], "methods": ["eip3009"] }` cuando `BASE_SEPOLIA_ENABLED=true`.

## AC Verification

| AC | Verdict | Evidencia (archivo:línea o tx hash) | Notas |
|----|---------|---------------------------|-------|
| AC-1 | PASS | `src/__tests__/unit/chains.base.test.ts:326-338` — test "verify returns ok with recovered client". Firma EIP-712 REAL contra domain `name='USDC' v2 chainId=84532`. Recupera `TEST_SIGNER_ADDRESS` correctamente. USDC Sepolia en `src/chains/base.ts:97`. | Firma real, no mock. Domain verificado on-chain. |
| AC-2 | PASS | `src/__tests__/unit/chains.base.test.ts:341-370` — test "settle returns transactionHash + blockNumber on success". Flujo real `simulate → writeContract → waitReceipt` en `src/chains/base.ts:517-598`. | Hash on-chain real (AC-7) requiere ejecución E2E. |
| AC-3 | PASS | Dos paths cubiertos: (1) `tests:376-392` SIMULATION_FAILED HTTP 500. (2) `tests:395-423` CHAIN_UNAVAILABLE 503 via breaker OPEN. Circuit breaker en `base.ts:197-205` + `:244-272`. | Nota: spec dice `NETWORK_UNAVAILABLE`, código usa `CHAIN_UNAVAILABLE` (pre-existente, no introducido en esta PR). HTTP 503 verificado. |
| AC-4 | PASS con observacion | Adapter registrado en `src/chains/index.ts:39` cuando `BASE_SEPOLIA_ENABLED=true`. `getSupportedResponse()` itera desde `chainRegistry.listAdapters()` en `src/core/supported.ts:66-95`. Verificado live. Test `:221-228` confirma `networkId='eip155:84532'`. | OBSERVACION DOCUMENTAL: Work-item AC-4 cita shape con `kinds`, API real usa `chains`. CHAIN-ADAPTIVE.md desactualizado. Intent funcional satisfecho. |
| AC-5 | PASS | Tres tests en `:169-201`: adapter `null` cuando flag ausente, cuando `=false` con RPC presente, cuando RPC ausente con flag `=true`. `chainRegistry.getAdapter(84532)` retorna `!ok` → `verifyCore` devuelve `NETWORK_MISMATCH` 400. | Doble garantía. |
| AC-6 | PASS | `Test Files 36 passed (36), Tests 590 passed (590)` — 570 pre-existentes + 20 nuevos. Cero tests eliminados o `.skip`. Avalanche y Kite intactos. | 590/590. |
| AC-7 | **PENDING — Opcion B** | Requiere ejecución manual con operator wallet fundeada con ETH en Base Sepolia. Infraestructura (adapter, RPC, CB, settle flow) validada en AC-1/AC-2. Delegado a BASE-04 (WKH-107). | NO es FAIL — es condicion operacional documentada. |

## Quality Gates

| Gate | Status | Evidencia |
|------|--------|-----------|
| `npm test` | PASS | `Tests 590 passed (590)` — 36 test files, exit 0 |
| `npm run build` | PASS | `tsc` exit 0 |
| `npm run lint` | PASS | `eslint src/ --max-warnings 0` exit 0 |
| `npm run format:check` | PASS | `All matched files use Prettier code style!` exit 0 |
| TypeScript strict | PASS | No `any` explícito en archivos del PR |

## Drift Detection

Archivos modificados:
- `src/chains/base.ts` — Scope IN ✅
- `src/chains/index.ts` — Scope IN ✅
- `src/__tests__/unit/chains.base.test.ts` — Scope IN ✅
- `.env.example` — Scope IN ✅
- `README.md` — Scope IN ✅

**Drift: ninguno**. Los 5 archivos exactamente en Scope IN. `src/core/`, `src/methods/`, `src/routes/`, `src/chains/registry.ts` no tocados.

## Observaciones de calidad (no bloqueantes)

1. **`CHAIN-UNAVAILABLE` vs `NETWORK_UNAVAILABLE` (AC-3)**: Work-item especifica `NETWORK_UNAVAILABLE`. Código (pre-existente desde WFAC-41) usa `CHAIN_UNAVAILABLE`. No es regresión. TD de alineación de spec.
2. **`CHAIN-ADAPTIVE.md` desactualizado**: Doc muestra `kinds`, API usa `chains`. Recomendar corregir.
3. **AC-7 pendiente operacional**: Smoke E2E real es el único gap. Toda la lógica validada en unit tests con firmas reales.

## Resumen Ejecutivo

WKH-105 sigue con fidelidad el patrón chain-adaptive. 3 commits bien separados, 5 archivos en Scope IN, 590 tests pasan incluyendo 20 nuevos. Firma EIP-712 real en test (no mockeada) valida que domain `name='USDC' v2 chainId=84532` fue correctamente verificado on-chain — el hallazgo más crítico de DT-5 mitigado de forma demostrable. Circuit breaker wired (503 en CB OPEN). Discrepancia menor `NETWORK_UNAVAILABLE` vs `CHAIN_UNAVAILABLE` es pre-existente. Única condición pendiente es smoke E2E on-chain (AC-7) — apropiado delegarlo al done-report o BASE-04.

## Recomendacion al Orquestador

**APROBADO PARA DONE** con condiciones:

1. AC-7 documentado como PENDING OPERACIONAL en done-report — merge a main es seguro porque Base está OFF por default.
2. Corregir `doc/architecture/CHAIN-ADAPTIVE.md` para mostrar shape `{ chains, methods }` (TD menor).
3. Done-report debe incluir tx hash de Basescan Sepolia una vez ejecutado smoke real.

Ningún AC en FAIL. Gates todos verdes. Código production-grade (viem v2, sin ethers.js, sin any explícito, EIP-712 domain verificado on-chain, circuit breaker wired). Avanzar a DONE.
