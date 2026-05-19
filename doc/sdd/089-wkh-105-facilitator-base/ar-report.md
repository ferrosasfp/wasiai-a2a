# AR Report — WKH-105 (BASE-02) wasiai-facilitator Base Adapter

**Target**: `/home/ferdev/.openclaw/workspace/wasiai-facilitator/` branch `feat/base-support`
**Commits**: `7d86b37`, `001f8dc`, `83b6d65`
**Reviewer**: nexus-adversary (AUTO FAST+AR)
**Date**: 2026-05-19

## VEREDICTO: APROBADO (sin BLOQUEANTEs)

Implementación de calidad de producción. Mirror disciplinado de `avalanche.ts` con desvíos justificados y verificados (EIP-712 domain divergence Sepolia vs Mainnet, ETH como native currency L2). Cero regresiones (590/590 tests pass). Scope estricto, sin `ethers`, sin `any`, sin TODOs, sin `--no-verify`.

## 1. BLOQUEANTEs encontrados

**Ninguno (0).**

## 2. MENORes

| ID | Severidad | Archivo:línea | Descripción | Sugerencia |
|----|-----------|---------------|-------------|------------|
| **MNR-1** | INFO | `src/chains/base.ts:329-339` | El adapter NO valida `validAfter > now` antes de simular (sólo `validBefore`). Rechazo temprano sería `EXPIRED_AUTHORIZATION`/`NOT_YET_VALID` HTTP 400. **NO es regression**: parity exacto con `avalanche.ts:319-329` y `kite.ts`. Deuda técnica compartida. | Aplicar mejora **transversal** a los 3 adapters en HU separada. NO arreglar sólo en base — rompe parity. |
| **MNR-2** | INFO | `src/__tests__/unit/chains.base.test.ts:255-260` y `:474-478` | Tests "exposes circuit breaker" sólo verifican estado inicial. No verifican transición CLOSED → OPEN para Base Mainnet específicamente. | Considerar duplicar test "CB OPEN → CHAIN_UNAVAILABLE" para mainnet también si Mainnet entra en uso. |
| **MNR-3** | INFO | `src/chains/base.ts:606-621` y `:629-644` | Cuando `BaseAdapter.constructor` throws `ChainAdapterInitError`, el IIFE `catch {}` silencia el error sin loggear. | Considerar `logger.warn` opcional. El test `:187-201` cubre el caso. Aceptable. |
| **MNR-4** | INFO | `src/chains/base.ts:357` | Cast `this.metadata.chainId as number` strip-brand. Mismo patrón en `avalanche.ts:345`. | No action — parity. |
| **MNR-5** | OBSERVACIÓN | AC-7 work-item | `transactionHash` verificable en Basescan Sepolia (AC-7) NO está aún ejecutado. AR no puede verificar AC-7 sin red real. | Validar en F4 QA / BASE-04. |

## 3. Production-grade audit checklist (30 categorías)

Todos PASS. Highlights:
- Signature malleability defense via `normalizeSignature()` (low-s, reject r=0/s=0)
- Replay attacks: nonce gestionado on-chain por contrato USDC
- Chain ID confusion: domain embebe chainId 84532/8453 correctamente
- **EIP-712 domain Sepolia="USDC" Mainnet="USD Coin" — Dev verificó on-chain y embebe correcto. Si hubiera codeado contra DT-5 hipótesis, todo Sepolia habría fallado silenciosamente.**
- Env var leakage: 0 console/logger statements
- Default OFF: IIFE retorna `null` por default
- Fail mode RPC failure: 503 graceful via CB
- Zero regression Avalanche/Kite: 590/590 tests pass
- Envelope x402 v2 compat: ningún cambio en `src/core/`, `src/methods/`, `src/routes/`
- Circuit breaker isolation per-chain
- Type Safety: sin `any`, single `as never` en parity con avalanche
- Test Coverage: 20 tests, asserts reales no snapshots
- Scope Drift: 5 archivos en scope, 0 ethers, 0 --no-verify
- Co-Authored-By Claude en los 3 commits
- Sin TODO/FIXME/HACK
- Sin mock data en prod path
- Native currency correcto (ETH, no AVAX)

## 4. Verificación de los 11 vectores específicos del orquestador

| Vector | Resultado |
|---|---|
| Signature malleability EIP-3009 | OK |
| Replay attacks | OK |
| Chain ID confusion | OK |
| **EIP-712 domain Sepolia="USDC" Mainnet="USD Coin"** | **OK** — Dev verificó on-chain y descubrió la divergencia |
| Env var leakage logs | OK |
| Default OFF | OK |
| Fail mode RPC failure → 503 | OK |
| Zero regression Avalanche/Kite | OK |
| Envelope x402 v2 compat | OK |
| Circuit breaker integration | OK |
| Scope conformance | OK |

## 5. Resumen ejecutivo

El Dev entregó un mirror disciplinado de `src/chains/avalanche.ts` para Base. **El descubrimiento crítico fue verificar on-chain el EIP-712 `name` del contrato USDC** antes de codear — descubrió que Base Sepolia usa el literal `"USDC"` (no `"USD Coin"` como asumía DT-5 del work-item). Si hubiera codeado contra la hipótesis del work-item, **el verify habría fallado silenciosamente en Sepolia**.

Implementación byte-identical-compatible con deployments existentes: ambos Base adapters son opt-in. Default OFF. Cero archivos fuera de scope. Cero `ethers`. Cero `any`. Cero TODOs. 20 tests nuevos, 590 totales pass. typecheck + lint + test clean.

**Recomendación**: avanzar a F4 (QA). AC-7 (smoke E2E tx hash en Basescan) queda para validación QA — fuera del alcance de AR.

**Veredicto final: APROBADO. Avanzar a F4 (QA).**
