# AR Report — [WKH-192] Seam `settlePaymentIntentOnChain` decimals-aware

> Adversarial Review · Wave 0 del EPIC WKH-191 · money-path (seam auditado WKH-136)
> Input: `story-HU-192.md` + `sdd.md` + `git diff` (payment-intent.ts + payment-intent.test.ts)
> Ejecución verificada: `tsc --noEmit` 0 · suite completa 2933 pass / 10 skip · biome 0 · fuzz byte-idéntico 200k+ valores

---

## Veredicto global: APROBADO

Sin BLOQUEANTEs (ALTO/MEDIO/BAJO). 1 MENOR no-bloqueante (scope de doc index). El fix es un choke-point
único, byte-idéntico en Kite por construcción (verificado empíricamente sobre 200k valores aleatorios + edge
cases), y respeta todas las Constraint Directives heredadas.

---

## Evidencia ejecutable

| Check | Comando | Resultado |
|---|---|---|
| Typecheck | `./node_modules/.bin/tsc --noEmit` | **0 errores** |
| Suite seam | `vitest run payment-intent.test.ts` | **55/55 pass** |
| Suite completa | `vitest run` | **2933 pass / 10 skip** (161 files) |
| Biome | `biome check payment-intent.ts payment-intent.test.ts` | **0** |
| Convergencia Kite 18d | fuzz node 200k random + 14 edge (0, 1e-6, 0.333333, 999999.999999…) | **0 divergencias** |
| `BigInt(1e12) === 10n**12n` | node | **true** |
| Scope | `git diff --name-only` | payment-intent.ts + .test.ts + _INDEX.md |

---

## Ataque por punto crítico (money-path)

### 1. KITE BYTE-IDÉNTICO — OK
`usdToAtomic(usd,18)` = `micro * 10n**BigInt(18-6)` = `micro * 10n**12n`, con `micro = BigInt(Math.round(usd*1_000_000))`.
Legacy = `BigInt(Math.round(usd*1_000_000)) * BigInt(1_000_000_000_000)`.
- `micro` es la MISMA expresión (mismo redondeo float64, cero fuente de drift nueva).
- `10n**12n === BigInt(1e12) === 1000000000000n` (verificado, `true`).
- Producto BigInt de enteros idénticos → string idéntico byte-a-byte **por construcción**.
- **Verificación empírica adversarial** (más allá del test): fuzz de 200.000 valores aleatorios en [0,10000] +
  edge cases (0, 0.000001, 0.0000005, 0.333333, 1.005, 2.675, 999999.999999, negativos-no-aplican) →
  `usdToAtomic(usd,18) === legacy(usd)` en el 100%. **0 divergencias.**
- `usd=0` → `"0"` en ambos. No hay caso de redondeo/precisión donde diverja.
El path operator-custodial en prod (Kite 18d) queda EXACTO. Evidencia: `payment-intent.ts:158-165`, test T-1/T-5.

### 2. BASE 6d CORRECTO — OK
`usdToAtomic(usd,6)` = `micro * 10n**0n` = `micro` = el atómico USDC 6d exacto (`1.50 → "1500000"`, `0.333333 → "333333"`).
Convergencia hop1↔hop2 verificada: T-6 firma el mismo `atomic6` que `debit_amount_atomic` del hop 1
(`payment-intent.test.ts` T-6, pass). Relación `BigInt(6d)*10n**12n === BigInt(18d)` verificada (T-2 + fuzz).
Evidencia: `payment-intent.ts:160-164`.

### 3. RESOLUCIÓN DEL ADAPTER (una sola vez) — OK
`const adapter = getPaymentAdapter()` se resuelve UNA vez (`:372`) y se reusa para decimals (`:373`), sign
(`:379`) y settle (`:401`). `grep -c "getPaymentAdapter()"` en el seam = **1**. Imposible drift entre "qué
decimals" y "qué adapter firmó" (CD-6 satisfecho).
- **Delta de clasificación (money-safe):** el hoist de `getPaymentAdapter()` al outer `try` cambia un throw de
  registry-no-init de `unequivocal`→`ambiguous`. Analizado: `ambiguous` NUNCA refunda ni dobla-paga (deja fondos
  reconciliables), es ESTRICTAMENTE más conservador. Inalcanzable en prod (registry siempre init antes de servir).
  Documentado en SDD DT-3. **No es finding** (decisión documentada + money-safe + unreachable).

### 4. FALLBACK `?? 18` — OK
`adapter.supportedTokens?.[0]?.decimals ?? 18` (`:373`). Verificado que NO lanza en los 3 casos: `undefined`,
`[]`, y sin `supportedTokens` en el mock (T-3 pass con ambos `undefined` y `[]`). El `?.` sobre el array es el
correcto (no `supportedTokens[0]?.` que haría `TypeError`). El `?? 18` solo se activa con ausencia total de token
(registry mal init / bundle sin token) — inalcanzable en prod; si se activara, firma 18d = byte-idéntico al legacy
(comportamiento actual, no regresión). Un adapter 6d SIN `supportedTokens` es imposible en prod (los bundles reales
declaran sus tokens). Nota: `decimals=0` legítimo se preserva (`??` no dispara en 0) — correcto. Evidencia: T-3.

### 5. VERIFY converge — OK
`requiredAmountAtomic: BigInt(wei)` (`:439`) sin cambios; `wei` ya es el atómico corregido en origen.
`verifyDefaultChainSettle` deriva token/decimals INDEPENDIENTE (settle-verifier no tocado). En Base 6d, sign y
verify reciben la MISMA derivación (T-4 asserta `mockVerify.requiredAmountAtomic === BigInt(usdToAtomic(usd,6))`
y `mockSign.value === usdToAtomic(usd,6)` y `!== usdToAtomic(usd,18)`). Antes fallaría por 10¹²; ahora converge.
Test falsificable genuino (si el wiring hardcodeara 18, T-4 rompe). Evidencia: `payment-intent.ts:436-440`, T-4.

### 6. SCOPE — OK (1 MENOR)
`git diff --name-only` → `payment-intent.ts` + `payment-intent.test.ts` + `_INDEX.md`. NO se tocó `contracts/`,
`fee-charge.ts`, `compose.ts`, `arbiter.ts`, `settle-verifier.ts`, `debit-capture.ts`, `debit-executor.ts`,
ni ningún `sign()`/`settle()` de adapter (CD-1/CD-3 respetados). `fee-charge.ts:feeUsdcToWei` conserva su propio
hardcode 18d — explícitamente Scope OUT, follow-up separado documentado. Ver MNR-1 por `_INDEX.md`.

---

## Las 11 categorías de ataque

| # | Categoría | Resultado |
|---|---|---|
| 1 | Security | **OK** — helper puro aritmético; sin input externo, sin injection, sin secrets. `payTo` cast preexistente (no tocado). |
| 2 | Error Handling | **OK** — todo el código nuevo vive dentro del outer `try/catch` (`:371-480`); CD-7 satisfecho; delta de clasificación money-safe (ver punto 3). |
| 3 | Data Integrity | **OK** — byte-idéntico en Kite (0 drift prod); convergencia hop1↔hop2↔verify en 6d; una sola resolución de adapter (sin double-pay/refund erróneo). |
| 4 | Performance | **OK** — reduce de 2 a 1 la resolución de `getPaymentAdapter()`; aritmética BigInt O(1). |
| 5 | Integration | **OK** — firma pública del seam intacta (CD-5); adapters agnósticos sin cambios; `fee-charge`/`compose` Scope OUT sin romper. |
| 6 | Type Safety | **OK** — sin `any`; `decimals: number`; `?.`/`??` correctos; `tsc` 0; sin NaN nuevo (misma expr. que legacy). |
| 7 | Test Coverage | **OK** — T-1..T-6 mapean AC-1..AC-6; asserts de string exacta (no tautológicos); T-4 falsificable; regresión byte-idéntica vía suite completa verde. |
| 8 | Scope Drift | **MENOR** — solo `_INDEX.md` fuera de los 2 archivos de §1 (doc, no código). Ver MNR-1. |
| 9 | Destructive Migrations | **N/A** — sin migraciones/SQL en esta HU. |
| 10 | RPC SECURITY DEFINER | **N/A** — sin funciones postgres nuevas. |
| 11 | Cache Invalidation | **N/A** — sin capa de cache introducida. |

---

## Findings

### MNR-1 (Scope Drift) — `doc/sdd/_INDEX.md`
- **Descripción:** el Dev agregó la fila 176 a `_INDEX.md` con status `in progress`. La Done Definition de la
  story (§7) exige `git diff --name-only == exactamente los 2 archivos de §1`. `_INDEX.md` es un 3º archivo.
- **Impacto:** nulo sobre el money-path o el código. Es bookkeeping de doc; `_INDEX.md` normalmente lo cierra
  `nexus-docs` en DONE (ahí la fila pasará a `DONE`).
- **Repro:** `git diff --name-only` → 3 archivos vs 2 esperados.
- **Sugerencia:** no-bloqueante. Dejar que `nexus-docs` consolide la fila al cierre; sin acción del Dev requerida
  salvo que el proceso exija diff limpio de los 2 archivos.
- **Severidad:** MENOR (no rompe nada).

---

## Cierre
Sin BLOQUEANTEs. El punto 1 (Kite byte-idéntico) — foco del review — quedó verificado por construcción Y
empíricamente (200k+ fuzz, 0 divergencias). El operator-custodial en prod no se mueve. **APROBADO con MENORs.**
