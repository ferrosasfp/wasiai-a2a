# Validation Report — WKH-126c (Routing de escrow POR-CADENA) — COMPACT

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-22
**Branch**: `fix/122-wkh-126c-escrow-per-chain-routing`

---

## Runtime checks

- DB state: N/A — HU no toca schema ni SQL (confirmado por AR: Destructive Migrations = N/A).
- Env parity: N/A — HU no introduce nuevas env vars (CD-3). Variables existentes `ESCROW_MODE_ENABLED` y `A2A_ESCROW_CONTRACT_<FAMILY>` ya presentes.
- Migration applied: N/A — sin migration.
- tsc --noEmit: EXIT 0 (ejecutado — 0 errores de tipo).
- auth.escrow.test.ts: PASS 19 / FAIL 0 (ejecutado).
- Suite completa (vitest run): PASS 1628 / FAIL 0 (ejecutado).

---

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1: chainKey CON contrato + flag on → verifyEscrowDeposit, 200 | PASS | `auth.escrow.test.ts:518` "flag on + contrato configurado para la cadena → verifyEscrowDeposit (AC-1)"; asserta `mockVerifyEscrowDeposit toHaveBeenCalledTimes(1)` + `mockVerifyDeposit not.toHaveBeenCalled()` + `res.json().balance` = '10.000000'. Selector en `auth.ts:682`: `escrowEnabledForChain(chainKey)` → true cuando `resolveEscrowContract` retorna dirección válida. |
| AC-2: chainKey SIN contrato + flag on → verifyDeposit (treasury), sin 503 | PASS | `auth.escrow.test.ts:545` "flag on + contrato NO configurado para la cadena → verifyDeposit (treasury), no 503 (AC-2)"; `mockResolveEscrowContract.mockReturnValue(null)` → helper retorna false → `mockVerifyDeposit toHaveBeenCalledTimes(1)` + `mockVerifyEscrowDeposit not.toHaveBeenCalled()` + `res.json().error_code toBeUndefined()`. |
| AC-3: flag off (cualquier valor no-'true') → treasury en TODAS las cadenas | PASS | `auth.escrow.test.ts:572` "flag off + contrato configurado para la cadena → verifyDeposit (treasury) (AC-3/CD-2)"; flag eliminado pero contrato mockeado como ESCROW_CONTRACT_ADDR → `mockVerifyDeposit toHaveBeenCalledTimes(1)` + `mockVerifyEscrowDeposit not.toHaveBeenCalled()`. Demostrado también por los 5 casos `it.each` en `:462` con '1', 'TRUE', 'True', 'yes', '' → treasury. Short-circuit en `auth.ts:142`: `escrowModeEnabled() && ...` garantiza false sin evaluar `resolveEscrowContract`. |
| AC-4: verifyEscrowDeposit ok:true + funding-wallet gate idéntico al path treasury | PASS | Funding-wallet gate: `auth.ts:717-722` (paso 5b), no tocado por el diff (solo import + helper en :141-143 + selector en :682). Gate corre downstream del `result` unificado para ambos verifiers. Evidencia en test `:286` (AC-6 de 126b): escrow path + `from = OTHER_WALLET` → 403 FUNDING_WALLET_MISMATCH + `mockRegisterDeposit not.toHaveBeenCalled()`. Gate opera idénticamente en ambos paths. |
| AC-5: flag on + contrato configurado → 503 en RPC_UNAVAILABLE, 400 en fallo on-chain | PASS | `auth.ts:701-710`: mapeo status sin cambios (RPC_UNAVAILABLE/ESCROW_CONTRACT_NOT_CONFIGURED → 503; resto → 400). Evidencia: `auth.escrow.test.ts:420` (CD-10): escrow + `ESCROW_CONTRACT_NOT_CONFIGURED` → 503. `:441`: escrow + `KEY_ID_MISMATCH` → 400. Lógica de mapeo no fue modificada por esta HU. |
| AC-6: tests auth.escrow.test.ts todos en PASS sin modificar casos existentes | PASS | `npx vitest run src/routes/auth.escrow.test.ts` → PASS 19 / FAIL 0. Los 16 tests de WKH-126b (`:205`–`:513`) no fueron modificados; únicamente se agregaron 3 tests nuevos en `:518`–`:595` (AC-1, AC-2, AC-3 de 126c). Confirmado por diff en CR report: "única línea `-` = import viejo reemplazado por multilínea equivalente" (CR checklist #4). |

---

## Drift

- Scope: solo `src/routes/auth.ts` (import extendido en :26-29 + helper :141-143 + selector :682) y `src/routes/auth.escrow.test.ts` (3 tests adicionales :518-595). Coincide exactamente con Scope IN del work-item.
- Wave drift: N/A — HU mini/S, cambio de 1 línea + helper.
- MNR-1 (CR): test de robustez adicional para AC-2 (ejercitar la rama real que produciría 503). Marcado como opcional/backlog. No bloquea. Aceptado como TD.

---

## Gates (confirmed from CR report + ejecución directa)

- tsc --noEmit: EXIT 0 (confirmado CR + re-ejecutado en F4 → EXIT 0).
- vitest auth.escrow.test.ts: PASS 19 / FAIL 0 (confirmado AR + CR + re-ejecutado en F4 → 19/19).
- vitest suite completa: PASS 1628 / FAIL 0 (ejecutado en F4).
- biome (lint): 0 (confirmado por CR report: "biome 0 (2 files)").

---

## AR/CR follow-up

- AR: APROBADO, 0 BLQ, 0 MNR.
- CR: APROBADO, 0 BLQ, 1 MNR opcional (backlog).
- Sin findings pendientes que bloqueen DONE.

---

**Listo para DONE.**
