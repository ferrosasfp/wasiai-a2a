# Final Report — WKH-126c: Routing de escrow POR-CADENA

> **Status**: ✅ DONE · **Fecha**: 2026-06-22 · **Branch**: `fix/122-wkh-126c-escrow-per-chain-routing` · **Modo**: FAST+AR AUTO
> Veredicto F4: APROBADO PARA DONE (6/6 ACs PASS).

## 1. Resumen ejecutivo

El flag `ESCROW_MODE_ENABLED` era global, pero el contrato escrow es per-cadena (`A2A_ESCROW_CONTRACT_<FAMILY>`). Activarlo con solo Base configurado rompía Kite/Avalanche (503 `ESCROW_CONTRACT_NOT_CONFIGURED`). Esta HU agrega el helper `escrowEnabledForChain(chainKey) = escrowModeEnabled() && resolveEscrowContract(chainKey) !== null` y lo usa en el selector del paso 5 de `POST /auth/deposit`: el escrow se usa **solo en cadenas con contrato configurado**, fallback a treasury en las demás. Desbloquea activar Base sin tocar Kite/Avalanche. Flag off → treasury en todas (cero regresión, AC-8 de 126b intacto).

## 2. Pipeline (FAST+AR AUTO, 2026-06-22)

HU_APPROVED self-aprobado (override mini→FAST+AR por tocar el path de depósito) → F3 → AR (APROBADO, 0 BLQ) + CR (APROBADO, 0 BLQ, 1 MNR opcional) → F4 (APROBADO PARA DONE, 6/6 ACs PASS).

## 3. AC results (6/6 PASS — ver validation.md)

AC-1 contrato+flag on→escrow · AC-2 sin contrato+flag on→treasury (no 503) · AC-3 flag off→treasury en todas (CD-2 short-circuit) · AC-4 funding-wallet gate idéntico · AC-5 RPC_UNAVAILABLE→503/fallo→400 preservados · AC-6 16 tests de 126b intactos + 3 nuevos = 19/19.

## 4. Archivos

**Modificados**: `src/routes/auth.ts` (import + helper `:141-143` + 1 línea selector `:682`), `src/routes/auth.escrow.test.ts` (3 tests aditivos). Scope mínimo, sin tocar verifyDeposit/verifyEscrowDeposit ni el funding-wallet gate.

## 5. Gates

tsc 0 · biome 0 · vitest 1628/0 · auth.escrow 19/19.

## 6. TD

MNR-1 (CR): test de robustez opcional (confirmar que un verifier escrow con ESCROW_CONTRACT_NOT_CONFIGURED no se alcanza con resolveEscrowContract→null). Backlog.

## 7. Desbloquea

Activar Base escrow en prod: `A2A_ESCROW_CONTRACT_BASE=0x31C4...` + `ESCROW_MODE_ENABLED=true` → Base usa escrow, Kite/Avalanche siguen en treasury sin romperse.
