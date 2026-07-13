# AR Report — WKH-195 · Fee-charge + compose decimals-aware

> Adversary Review (F3 → AR) del mismo ciclo activo. Money-path.
> Gates ejecutados: `tsc --noEmit` (0 err), `vitest run` (2972 passed / 10 skipped),
> `biome check` sobre los 5 archivos (limpio), tests WKH-195 targeted (9 passed, 0 skip).

## Veredicto global: **APROBADO**

Cero BLOQUEANTEs. Cero MENORs. Los dos focos críticos (byte-identidad Kite + fee-split
hereda sin romperse) están probados por construcción **y** por test string-exacto.

---

## Focos del encargo (money-path)

### 1. Byte-identidad Kite 18d — **OK (crítico verificado)**
`feeUsdcToWei` (fee-charge.ts:172-176) y el `valueWei` de compose (compose.ts:823-825)
delegan en `usdToAtomic(usd, 18)` = `BigInt(Math.round(usd*1e6)) * 10n**12n`.
Legado = `BigInt(Math.round(usd*1e6)) * BigInt(1e12)`. `1e6 === 1_000_000`,
`10n**12n === BigInt(1e12) === 1000000000000n` (1e12 exacto en float64), mismo
`Math.round` → **byte-idéntico para todo usd** (redondeo, 0, precisión 6d 0.000001).
No es muestreo: es igualdad estructural. Confirmado además por T1-A y T2-A con
`.toBe` string-exacto sobre `[1.5, 0.333333, 100, 0.000001]` (payment-intent.ts:158-165).

### 2. Fee-split no se rompe — **OK (crítico verificado)**
`fee-split.ts` (código) **inalterado** (git diff --name-only lo confirma). Firma de
`feeUsdcToWei(feeUsdc: number): string` mantenida → `fee-split.ts:32` hereda por firma.
Regresión AC-6 (fee-split.test.ts, T3) es genuina: ejercita `settleFeeSplits` real,
config default 10000/0/0, y asserta `mockSign.value === feeUsdcToWei(amount) === legacyWei(amount)`
en Kite 18d. Falla bajo mutación (no tautológico).

### 3. Decimals del adapter correcto (sin drift) — **OK**
`feeUsdcToWei` resuelve `getPaymentAdapter()` sin `chainKey`; el sign (:458) y settle
(:481) de `chargeProtocolFee` también resuelven `getPaymentAdapter()` sin `chainKey`.
`getPaymentAdapter()` es lookup determinístico de singleton default-chain
(registry.ts:185-200) → decimales derivados == decimales del adapter que firma/settlea.
Idem compose: `adapter` hoisteado (compose.ts:822) firma con `adapter.sign`; settle
(:932) resuelve el MISMO singleton. Sin ventana de drift.

### 4. Compose — settle/chainKey intactos, Base 6d correcto — **OK**
Settle sigue en `getPaymentAdapter().settle` (compose.ts:932, sólo se desplazó nº de
línea por los comentarios). Telemetría del selector Base (`chainKey` de agent.payment.chain,
:910-928) inalterada — nunca alimentó el adapter que firma. Base 6d probado por T2-B:
`value === atomic6(price)` y `BigInt(signed)*10n**12n === BigInt(legacyWei)` (10^12 menos).

### 5. Fallback ?? 18 sin throw — **OK**
T1-C/T2-C prueban `supportedTokens = undefined` y `[]` → cae a 18d, sin throw, value
byte-idéntico al legado. Preserva CD-4/CD-B (chargeProtocolFee jamás rechaza la promise;
compose.callAgent no gana un modo de fallo nuevo). Decisión documentada (CD-4) — no finding.

### 6. Scope — **OK**
Sólo 5 rutas src tocadas (fee-charge.ts, compose.ts + sus 3 tests). `payment-intent.ts`
(usdToAtomic), `fee-split.ts` (código), settle path, contracts/, árbitro, escrow/settle-verifier:
**inalterados** (verificado con git diff --name-only). Sin ciclo de imports
(`grep` en payment-intent.ts → 0). Call-sites :403/:458/:481 no tocados.

---

## 11 Categorías de ataque

| # | Categoría | Resultado |
|---|---|---|
| 1 | Security | **OK** — sin secrets, sin injection; ownership guard N/A (no toca a2a_agent_keys queries). |
| 2 | Error Handling | **OK** — fallback ?? 18 sin throw preserva la garantía never-reject; sin catch nuevos que silencien. |
| 3 | Data Integrity | **OK** — money-path byte-idéntico Kite (T1-A/T2-A/T3); sin race/idempotencia nueva. |
| 4 | Performance | **OK** — una sola resolución de adapter hoisteada; usdToAtomic es BigInt puro sin I/O. |
| 5 | Integration | **OK** — firma pública de feeUsdcToWei mantenida; fee-split hereda sin cambios (backwards-compat). |
| 6 | Type Safety | **OK** — sin `any`; tsc 0 errores; mocks tipados con rest param (`..._a: unknown[]`, CD-6). |
| 7 | Test Coverage | **OK** — 9 tests nuevos falsificables (string-exacto `.toBe`, `.not.toBe`, no tautológicos); happy+divergente+fallback+regresión. |
| 8 | Scope Drift | **OK** — 5 rutas exactas del Story File; nada fuera de Scope IN. |
| 9 | Destructive Migrations | **N/A** — la HU no incluye SQL/migrations. |
| 10 | RPC SECURITY DEFINER | **N/A** — no hay funciones postgres/RPC nuevas. |
| 11 | Cache Invalidation | **N/A** — no se introduce capa de cache. |

---

## Gates ejecutados (evidencia)
- `./node_modules/.bin/tsc --noEmit` → exit 0.
- `./node_modules/.bin/vitest run` → **2972 passed | 10 skipped** (162 files passed | 4 skipped).
- `./node_modules/.bin/vitest run -t "WKH-195"` → **9 passed | 0 failed** (T1-A..D, T2-A..D, T3).
- `./node_modules/.bin/biome check` (5 archivos) → limpio, 0 fixes.

## Findings: **ninguno**
