# CR Report — [WKH-192] Seam `settlePaymentIntentOnChain` decimals-aware

> Sección Adversary · Code Review de calidad (post-AR) · Wave 0 del EPIC WKH-191
> Revisor: nexus-adversary · Fecha: 2026-07-13
> Input: `sdd.md` + `story-HU-192.md` + `git diff` (payment-intent.ts + payment-intent.test.ts)

---

## Evidencia de ejecución

| Check | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `biome check` (prod + test) | 0 (Checked 2 files, no fixes) |
| Suite `payment-intent.test.ts` | **55 passed** (0 fail) |
| Suite COMPLETA | **2933 passed / 10 skipped** (161 files passed, 4 skipped) |
| Scope (`git diff --name-only`) | `payment-intent.ts` + `payment-intent.test.ts` + `_INDEX.md` (housekeeping) |
| `grep "getPaymentAdapter()" payment-intent.ts` | 1 hit (`:372`) — resolución única confirmada (CD-6/DoD) |
| `grep "usdToWei" prod` (como símbolo) | 0 hits de función/call-site; 1 hit en JSDoc (`:150`, referencia legacy) |

---

## 1. Fidelidad SDD / Story File — OK

- **Fórmula `usdToAtomic`** (`payment-intent.ts:158-165`) idéntica a DT-2 / story §4: `micro = BigInt(Math.round(usd*1_000_000))`; rama `decimals>=6 ? micro*10n**BigInt(decimals-6) : micro/10n**BigInt(6-decimals)`. BigInt entero puro, sin `parseUnits`/`toFixed` (CD-4). OK.
- **Resolución única del adapter** (`:372`) reusada en `sign` (`:379`) y `settle` (`:401`); dentro del outer `try` (`:371`) → cualquier throw cae a `failed_ambiguous` (CD-7). Coincide con DT-3/CD-6. OK.
- **`?.[0]?.decimals ?? 18`** (`:373`) exactamente como DT-5 (con `?.` sobre el array). OK.
- **`requiredAmountAtomic: BigInt(wei)`** (`:439`) sin cambios — converge por origen (DT-4). OK.
- **Firma del seam** intacta (CD-5); `usdToAtomic` exportada como helper puro (DT-6). OK.

### Sobre la palabra "usdToWei" en el JSDoc (`:150`) — OK, NO es finding
La consulta la planteó como "desviación del dev". No lo es: el JSDoc `` `micro` = micro-USD entero (6 decimales), IDÉNTICO al legacy `usdToWei` `` está prescrito **verbatim** por el Story File §4 (línea 101) y el SDD (línea 150). La función y sus call-sites muertos NO existen (grep confirma 0 hits como símbolo). La mención es una referencia histórica intencional que documenta *por qué* `micro` se computa así (equivalencia byte-a-byte con el helper removido) y el propio texto la marca como "el legacy" (pasado). Pedir quitarla contradiría la spec aprobada y degradaría la trazabilidad. **Aceptable — dejar como está.** (Nota: el otro hit `debit-capture.ts:162` es un comentario preexistente, Scope OUT, no tocado por este diff.)

## 2. Calidad de los 6 tests (T-1..T-6) — OK

- **T-1** (`:1809`): `usdToAtomic(usd,18) === legacyWei(usd)` para `{1.5, 0.333333, 100, 0.000001}` — igualdad de STRING exacta contra la fórmula legacy inline independiente (`String(BigInt(round(usd*1e6))*BigInt(1e12))`, `:1805`). Incluye caso 6-decimales de precisión. No aproximada, no tautológica (atraparía exponente/redondeo mal). OK.
- **T-2** (`:1816`): ancla dura `usdToAtomic(1.5,6)==='1500000'` (independiente, falsificable: 18d daría `'1500000000000000000'`) + relación `BigInt(x,6)*10n**12n === BigInt(x,18)`. El ancla dura evita que la relación sea tautológica. OK.
- **T-3** (`:1826`): cubre **ambos** `undefined` y `[]` (loop), asserta `settled` + `mockSign.value === usdToAtomic(usd,18) === legacyWei(usd)`. Nunca throw (CD-7). `vi.clearAllMocks()`+`happySettle()` por iteración re-arma los mocks correctamente. OK.
- **T-4** (`:1851`): Base 6d. Falsificable de forma explícita: `mockSign.value === usdToAtomic(usd,6)` **más** `.not.toBe(usdToAtomic(usd,18))` (`:1868`) — si el wiring firmara 18d, falla. Además `mockVerify.requiredAmountAtomic === BigInt(usdToAtomic(usd,6))` prueba la NO-divergencia sign↔verify (una sola derivación). Es el test clave y está bien construido. OK.
- **T-5** (`:1876`): default 18d (escrow OFF), `mockSign.value === legacyWei(usd)` byte-idéntico. OK.
- **T-6** (`:1892`): two-hop real (`settleEscrowAware` con hop1 mockeado: `debit_amount_atomic = usdToAtomic(3.7,6)='3700000'`). Asserta `settled` + `mockSign.value === atomic6` → hop2 firma == amount registrado por hop1. Verifica la herencia sin líneas nuevas en `settleEscrowAware`. Cleanup defensivo de `mockIsEscrowSettleEnabled` al final. OK.
- **Refactor del mock a `vi.hoisted`** (`:29-38`): `mockSupportedTokens = vi.hoisted(() => ({ current: [...] | undefined }))`; la factory de `vi.mock` lee `.current` en cada invocación de `getPaymentAdapter()` → mutaciones por test tienen efecto. Tipado explícito del array (CD-AB2, evita `TS2554/2556`). `beforeEach` resetea a 18d (`:175`) → suite preexistente byte-idéntica. Sólido. OK.
- **No-tautológico (CD-AB3)**: sin `expect(true).toBe(true)`; cross-refs verificadas. OK.

## 3. Legibilidad / mantenibilidad — OK
Nombre `usdToAtomic` claro; rama defensiva `<6d` comentada y segura (división BigInt trunca, no throw); sin magic numbers opacos (`1_000_000`/`10n`/`6`/`18` semánticos); sin dead code (`usdToWei` eliminado). OK.

## 4. Consistencia — OK
Aritmética BigInt micro-USD espeja `numericToMicro` (`:140`) y la derivación de decimals espeja `debit-capture.ts:162-169` (hop 1, 191a). El mock sigue el patrón `vi.hoisted`/`vi.fn` del archivo. OK.

## 5. Manejo de errores / tipos — OK
`?.[0]?.decimals ?? 18` evita `TypeError` con mock sin `supportedTokens` (probado por T-3). Rama `<6d` inalcanzable pero segura. `BigInt(Math.round(usd*1e6))` con `usd=NaN` lanzaría `RangeError`, pero (a) es comportamiento **idéntico al legacy** (no regresión), (b) `finalAmountUsd` se valida upstream, (c) cae al outer catch → `failed_ambiguous` (money-safe, CD-7). OK.

## 6. Regresión — OK
`beforeEach` resetea a 18d; suite completa 2933 passed. Path operator-custodial Kite byte-idéntico confirmado. OK.

---

## Findings

Ninguno. (0 BLOQUEANTE-ALTO / 0 BLOQUEANTE-MEDIO / 0 BLOQUEANTE-BAJO / 0 MENOR)

---

## VEREDICTO GLOBAL: **APROBADO**

Cambio fiel a la spec, tests falsificables y no-tautológicos (T-4 con `.not.toBe` explícito; T-3 cubre undefined+[]), convergencia Kite byte-idéntica por construcción y verificada, sin scope drift, sin regresión (2933/2943 verde), tsc/biome limpios. La mención de "usdToWei" en el JSDoc es prescrita por el Story File y aceptable. Sin bloqueantes ni menores accionables.
