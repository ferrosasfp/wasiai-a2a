# AR Report — WKH-167 (fee_total_usdc)

**Fecha:** 2026-07-09 · **Modo:** AR adversarial, READ-ONLY, money-path · **Branch:** `feat/166-wkh-167-fee-total-usdc`

## Ronda 1: RECHAZADO — 1 BLOQUEANTE (BLQ-MED-1, Data Integrity)
El backfill de la migración filtraba `AND fs.status='charged'` → subcontaba filas históricas con un leg `failed`/`reversed` (que tienen `amount_usdc` no-cero pero no se cobraron) → `fee_total ≠ budget×rate` → violaba AC-4 y reintroducía el mismatch de auditoría que la HU debía cerrar. Repro: budget $1, fee $0.01, platform $0.008 + creator $0.0015 (charged) + referral $0.0005 (failed) → backfill charged-only = 0.0095 ≠ 0.01. Money-safe (telemetría, sin pérdida real), solo filas históricas → MEDIO.
+ MNR-1 (Type Safety): database.types.ts no incluía fee_total_usdc.

## Vectores confirmados OK (ronda 1)
- #1 MONEY/aditividad: el monto on-chain sale de `feeUsdcToWei(platformAmount)` (fee-charge.ts:393), NO de fee_total_usdc. `fee_usdc=platformAmount` (:398) y el cálculo del fee (:202) intactos. El único cambio runtime es 1 campo en el INSERT (:402). Money-safe.
- #2 valor: `fee_total_usdc=feeUsdc` = fee total (budget×rate = protocolFeeUsdc del quote), no la pata plataforma. Confirmado por T-FEE-TOTAL (0.01 vs 0.008).
- #4 migración aditiva: `ADD COLUMN IF NOT EXISTS NUMERIC(18,6)` nullable; sin SELECT * → no rompe. Down-migration OK.
- #5 .env.example: prod 8000/1500/500 documentado, default 10000/0/0 sin cambio.

## Ronda 2 (re-AR post fix-pack): APROBADO
BLQ-MED-1 RESUELTO: el backfill ahora es `round(budget_usdc * fee_rate, 6) WHERE fee_total_usdc IS NULL` — incondicional respecto al status de los splits (inmune a failed/skipped), idempotente, transaccional. Exactitud: `budget_usdc=feeBaseUsdc` + `fee_rate=feeRate` en el INSERT (:396-397) → reproduce byte-a-byte el forward-write (:202,:402). MNR-1 resuelto (database.types.ts tipa fee_total_usdc). Money-path byte-idéntico. tsc 0, 2806 passed.

## Veredicto final: APROBADO (post fix-pack + re-AR)
