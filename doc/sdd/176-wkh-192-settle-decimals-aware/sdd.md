# SDD — [WKH-192] Seam `settlePaymentIntentOnChain` decimals-aware

> F2 · SDD_MODE=full (money-path, seam auditado WKH-136) · Estimación S · Wave 0 del EPIC WKH-191
> Branch: `fix/192-wkh-192-settle-decimals-aware`
> Input: `work-item.md` (176) + código verificado abajo.

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo | Líneas leídas | Por qué | Qué extraje |
|---|---|---|---|
| `src/services/payment-intent.ts` | 1-1453 (completo) | Es el ÚNICO archivo a tocar | `usdToWei(usd)` (`:153-157`) hardcodea 18d (`BigInt(Math.round(usd*1e6))*BigInt(1e12)`); ÚNICO call-site en `settlePaymentIntentOnChain` (`:364`); el adapter se resuelve vía `getPaymentAdapter()` (2 llamadas: `:369` sign, `:391` settle); `requiredAmountAtomic: BigInt(wei)` en verify (`:429`); outer try `:363-470` garantiza CD-7 (nunca rechaza) |
| `src/adapters/base/payment.ts` | 440-499 | Confirmar que `sign()` es decimals-agnóstico | `:464` `value: opts.value` VERBATIM; `quote()` usa `parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS)` con `USDC_DECIMALS=6` (`:443-449`). `sign()` NUNCA calcula decimales → confirma DT-1: el bug nunca estuvo acá |
| `src/adapters/kite-ozone/payment.ts` | 390-429 | Confirmar `sign()` Kite agnóstico + 18d | `:408` `value: opts.value` VERBATIM; `quote()` usa `parseUnits(amountUsd.toFixed(18), 18)`, token `decimals: 18` (`:393-394`). Agnóstico por diseño |
| `src/adapters/settle-verifier.ts` | 340-388 | Verificar que `verifyDefaultChainSettle` NO necesita cambios | `:369` `bundle.payment.supportedTokens[0]`, `:384` `tokenAddress: token.address` — deriva token/decimals INDEPENDIENTE del caller; solo compara contra `args.requiredAmountAtomic`. Confirma DT-4: converge solo |
| `src/adapters/registry.ts` | 190-269 | Firma/semántica de `getPaymentAdapter` + `supportedTokens` | `getPaymentAdapter(chainKey?)` (`:198`) → `resolveBundleOrThrow(chainKey).payment` — **THROWS** si el registry no está init (`:193`); default chain cuando `chainKey` omitido. Es el singleton `bundle.payment` (determinístico entre llamadas) |
| `src/adapters/types.ts` | 80-89 | Shape de `supportedTokens` | `PaymentAdapter.supportedTokens: TokenSpec[]` (`:83`), cada `TokenSpec` tiene `decimals` |
| `src/adapters/escrow/debit-capture.ts` | 140-179 | Patrón decimals-aware ya correcto (referencia) | `:162-169` `bundle?.payment.supportedTokens[0]` → `token.decimals`; `:173` `parseUnits(finalAmountUsd.toString(), decimals)` — hop 1 (WKH-191a) YA deriva decimals reales. Confirma Scope OUT: cero cambios acá |
| `src/services/payment-intent.test.ts` | 13-70 (setup de mocks) | Grounding del test-infra | **HALLAZGO CRÍTICO** (ver DT-5): `vi.mock('../adapters/registry.js')` (`:29-33`) mockea `getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle })` — **SIN `supportedTokens`**. Mocks con `vi.hoisted(() => vi.fn())` (`:67+`); `verifyDefaultChainSettle` mockeado (`:44-47`) |
| `doc/sdd/174-.../done-report.md` | R-1/MI-1 (`:50-55`, citado por work-item) | Origen del bloqueante | El hop 2 firmaría 10¹²× en `default-chain=base-*`; money-safe (cae a `reconciliation-pending`) pero el happy-path nunca completa en Base |

**Auto-Blindaje histórico** (últimas 3 HUs DONE: 191a/191b/191c) — patrones recurrentes ≥2 HUs, heredados como CD-AB1/CD-AB2/CD-AB3 (§4).

---

## 2. Decisiones técnicas (DT-N)

### DT-1 — Corte del fix: 100% en `payment-intent.ts`, adapters intactos
Heredada del work-item, re-confirmada por grounding: `base/payment.ts:464` y `kite-ozone/payment.ts:408` hacen `value: opts.value` verbatim. El ÚNICO punto USD→atómico del path de settle es `usdToWei` con un ÚNICO call-site (`:364`). Tocar adapters no resuelve el bug (nunca ven USD) y viola CD-1.

### DT-2 — Aritmética: `usdToWei(usd)` → `usdToAtomic(usd, decimals)` con BigInt entero puro

Fórmula EXACTA (sin `parseUnits`, sin `Number.toFixed`, sin float64 nuevo):

```ts
function usdToAtomic(usd: number, decimals: number): string {
  const micro = BigInt(Math.round(usd * 1_000_000)); // micro-USD entero (6 dec) — IDÉNTICO al legacy
  return String(
    decimals >= 6
      ? micro * 10n ** BigInt(decimals - 6)   // escalar hacia arriba (18d→×10^12, 6d→×1)
      : micro / 10n ** BigInt(6 - decimals),  // defensivo (<6d): floor, hoy inalcanzable
  );
}
```

**Prueba de convergencia byte-a-byte en Kite (18d), POR CONSTRUCCIÓN — no por muestreo:**

- Legacy (`:154-155`): `BigInt(Math.round(usd*1_000_000)) * BigInt(1_000_000_000_000)`.
- Nuevo con `decimals=18`: `micro * 10n ** BigInt(18-6)` = `micro * 10n ** 12n` = `micro * 10¹²`.
- `Math.round(usd * 1_000_000)` es la **misma expresión** en ambos → mismo `micro` para todo `usd` (mismo redondeo float64, sin fuente de drift nueva).
- `10n ** 12n` === `1_000_000_000_000n` === `BigInt(1_000_000_000_000)` — mismo entero exacto.
- Producto BigInt de dos enteros idénticos → **string de salida idéntico byte-a-byte para TODO `usd`**. QED.

Para `decimals=6` (Base USDC): `10n ** BigInt(6-6)` = `10n ** 0n` = `1n` → `micro * 1n` = `micro`. Ej: `usd=1.50` → `micro = round(1_500_000) = 1_500_000n` → `"1500000"` (atómico USDC 6d correcto). Es **exactamente 10¹² menos** que el 18d (misma `micro`, exponente 12 vs 0). Precisión de 6 decimales (`usd=0.333333` → `round(333_333)=333_333n`) preservada idéntica en ambas ramas.

RECHAZADO: `parseUnits(usd.toFixed(decimals), decimals)` — introduce round-trip `toFixed`/parse-string que converge en la práctica pero NO es byte-idéntico *por construcción* al legacy; violaría el espíritu de CD-2 (probar por construcción, no por muestreo de floats) y CD-4 (sin float/parseUnits). El idiom `parseUnits` es correcto para montos firmados por el CLIENTE (`debit-capture.ts:173`, `base/payment.ts:quote`) pero acá el objetivo primario es la equivalencia byte-a-byte con el legacy Kite.

### DT-3 — Fuente de decimales: la MISMA instancia de `getPaymentAdapter()` (una sola resolución)
Resolver el adapter UNA vez al tope del `try` y reusarlo para decimals + sign + settle:

```ts
const { intentId, payTo, finalAmountUsd } = params;
try {
  const adapter = getPaymentAdapter();                                   // ← una sola resolución
  const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18;         // ← DT-5: ?. sobre el array
  const wei = usdToAtomic(finalAmountUsd, decimals);
  // ...
  signResult = await adapter.sign({ to: payTo as `0x${string}`, value: wei });
  // ...
  const settleResult = await adapter.settle({ ... });
```

Esto satisface CD-6 (una única resolución del registry, imposible que el "qué chain firmó" diverja del "qué decimals se usaron"). `getPaymentAdapter()` es determinístico (devuelve el singleton `bundle.payment`), así que reusar la instancia NO cambia el resultado vs. las 2 llamadas actuales, pero elimina toda superficie de drift.

**Nuance de clasificación (money-safe, documentada para AR):** hoy `getPaymentAdapter()` se invoca DENTRO del inner `try` de sign (`:368-372`); si lanzara (registry no init) → `failed_unequivocal`. Con el hoist al outer `try` (`:363`), un throw de `getPaymentAdapter()` cae al outer catch (`:454`) → `failed_ambiguous`. Este delta:
- Es **inalcanzable en producción** (el registry SIEMPRE está init antes de servir requests) → **cero drift en prod** (CD-2 satisfecho: "sin drift en el path operator-custodial en producción").
- En el caso teórico, `ambiguous` es ESTRICTAMENTE MÁS SEGURO que `unequivocal` (ambiguous NUNCA reembolsa; nunca puede doble-pagar). Un registry-not-init significa que NO hubo sign → refundar sería seguro, pero no-refundar solo deja fondos trabados, jamás dobla-paga.
- Alternativa considerada y rechazada: mantener 2 llamadas `getPaymentAdapter()` separadas para preservar la clasificación exacta — viola CD-6 ("PROHIBIDO segunda resolución que pueda divergir") y agrega superficie sin beneficio en prod.

### DT-4 — Convergencia end-to-end sin tocar `settle-verifier.ts`
`verifyDefaultChainSettle` (`:426-430`) recibe `requiredAmountAtomic: BigInt(wei)`. Al corregir `wei` en origen, ese valor ya es el atómico correcto → la comparación converge automáticamente. `settle-verifier.ts:369` deriva `token.address`/decimals INDEPENDIENTE (`bundle.payment.supportedTokens[0]`) → CERO cambios (Scope OUT confirmado). Cadena de convergencia tras el fix (Base 6d): hop1 `debit_amount_atomic` (191a, `parseUnits(...,6)`) == hop2 atómico firmado (`usdToAtomic(usd,6)`) == transfer on-chain USDC 6d == re-verificación (6d derivado indep.). Los 4 puntos en la MISMA unidad.

### DT-5 — Optional-chaining defensivo `supportedTokens?.[0]?.decimals ?? 18` (NO `supportedTokens[0]?.decimals`)
**HALLAZGO CRÍTICO de grounding del test-infra.** El mock actual (`payment-intent.test.ts:30`) devuelve `{ sign, settle }` SIN `supportedTokens`. Con `supportedTokens[0]?.decimals` (sin `?.` sobre el array), `undefined[0]` lanzaría `TypeError` → outer catch → `failed_ambiguous` → **rompería TODA la suite del seam** (esperan `settled`). Con `supportedTokens?.[0]?.decimals ?? 18`:
- `supportedTokens` undefined → `undefined ?? 18` → 18 → byte-idéntico al legacy (AC-2/AC-3 fallback).
- Cubre exactamente AC-3 (registry mal init / bundle sin token → fallback 18, nunca throw).
El work-item DT-3 escribe `supportedTokens[0]?.decimals ?? 18`; el SDD lo **corrige a `supportedTokens?.[0]?.decimals ?? 18`** por esta razón. El Dev DEBE usar el `?.` sobre el array.

### DT-6 — Exportar `usdToAtomic` para el test de convergencia byte-idéntica
Para probar AC-2/AC-6 por unidad (comparación string-a-string contra la fórmula legacy, sin mocks ni floats), `usdToAtomic` debe ser importable desde el test. Se **exporta** `usdToAtomic` (helper puro, JSDoc `@internal — exported for byte-identical convergence tests`). NO viola CD-5 (esa CD protege la firma de `settlePaymentIntentOnChain`, no la de los helpers). `usdToWei` se ELIMINA (single call-site migrado); no queda helper muerto.

---

## 3. Waves de implementación

### W0 — serial (contrato/aritmética + wiring) · `src/services/payment-intent.ts`
- **W0.1** Reemplazar `usdToWei(usd)` (`:153-157`) por `export function usdToAtomic(usd: number, decimals: number): string` (fórmula DT-2). Actualizar el JSDoc (`:147-152`): quitar el supuesto "18 decimals / token del default chain (kite/PYUSD) es 18 decimals"; documentar `micro × 10^(decimals-6)`, byte-idéntico en 18d por construcción, rama defensiva `<6d`.
- **W0.2** En `settlePaymentIntentOnChain` (`:362-364`): resolver `const adapter = getPaymentAdapter()` una vez; `const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18` (DT-5); `const wei = usdToAtomic(finalAmountUsd, decimals)`. Reemplazar las 2 llamadas `getPaymentAdapter().sign(...)` (`:369`) y `getPaymentAdapter().settle(...)` (`:391`) por `adapter.sign(...)` / `adapter.settle(...)` (DT-3). `requiredAmountAtomic: BigInt(wei)` (`:429`) SIN cambios (converge, DT-4).

### W1 — paralelizable (tests) · `src/services/payment-intent.test.ts`
Refactor mínimo del mock del registry para permitir override de `supportedTokens` por test (DT-5 + CD-AB2) + los tests T-1..T-6 (§5).

---

## 4. Constraint Directives (CD-N)

Heredadas del work-item (CD-1..CD-7) + derivadas de Auto-Blindaje (CD-AB1..CD-AB3):

- **CD-1** PROHIBIDO modificar `sign()`/`settle()` de CUALQUIER adapter (`kite-ozone`, `base`, `avalanche`). Fix único en `payment-intent.ts`.
- **CD-2** OBLIGATORIO convergencia Kite byte-idéntica: para ≥3 valores de `finalAmountUsd` (incl. ≥1 con 6 decimales de precisión), el atómico nuevo == string-a-string al legacy. Un dígito de diferencia = regresión del path operator-custodial en prod.
- **CD-3** PROHIBIDO tocar `contracts/`, `arbiter.ts`, `escrow/debit-capture.ts`, `escrow/debit-executor.ts`, `fee-charge.ts` (`feeUsdcToWei`, seam DISTINTO), `compose.ts`, `settle-verifier.ts`. Todos Scope OUT.
- **CD-4** OBLIGATORIO aritmética BigInt entera (`micro × 10^(decimals-6)`), SIN `parseUnits`/`Number.toFixed`. Garantiza AC-2 por construcción.
- **CD-5** PROHIBIDO cambiar la firma pública de `settlePaymentIntentOnChain` (seam auditado, 3+ call-sites: `closeSession`, `settleUpto`, `settleEscrowAware`). (Exportar el helper puro `usdToAtomic` NO es la firma del seam — permitido, DT-6.)
- **CD-6** OBLIGATORIO derivar decimals de la MISMA instancia `getPaymentAdapter()` reusada para sign/settle (una sola resolución, DT-3). PROHIBIDA una segunda resolución divergente.
- **CD-7** OBLIGATORIO que el fallback (AC-3) NUNCA lance: todo código nuevo vive dentro del `try/catch` existente (`:363-470`). El `?? 18` + `?.` (DT-5) garantiza no-throw sin token.
- **CD-AB1** (Auto-Blindaje 191a#1/#4, 191b#1 — recurrente ≥2 HUs) Correr `./node_modules/.bin/biome check --write` sobre el código de producción **Y los tests** antes del gate (NO `npx biome` — no resuelve el bin en este entorno). NO pre-envolver a mano llamadas cortas; dejar que biome decida el wrapping.
- **CD-AB2** (Auto-Blindaje 191b#2/#3, 191c#1 — recurrente ≥2 HUs) Al refactorizar el mock de `getPaymentAdapter` a un `vi.fn` seteable: todo símbolo consumido por la factory de `vi.mock` va en `vi.hoisted`; tipar params/retornos de los `vi.fn` (evitar firma inferida `() => void` que rompe `tsc` sobre los tests con `TS2554`/`TS2556`).
- **CD-AB3** (Auto-Blindaje 191b fix-pack) PROHIBIDO cerrar cobertura con `expect(true).toBe(true)`. Cada test de convergencia asserta igualdad de string EXACTA. Toda cross-reference a otro test se verifica con `grep` antes de dar por hecha.

---

## 5. Plan de tests (≥1 por AC) · `src/services/payment-intent.test.ts`

Refactor de infra (CD-AB2): convertir el mock `getPaymentAdapter` a un `vi.hoisted` seteable, p.ej.
`const mockSupportedTokens = vi.hoisted(() => ({ current: [{ decimals: 18, symbol: 'PYUSD' }] as { decimals: number; symbol: string }[] | undefined }));`
y `getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle, supportedTokens: mockSupportedTokens.current })`. Default 18d (modela el default chain Kite de HOY → suite existente byte-idéntica). `beforeEach` resetea a 18d.

| Test | AC | Qué cubre | Assert clave |
|---|---|---|---|
| **T-1** convergencia byte-idéntica Kite 18d | AC-2, AC-6, CD-2 | `usdToAtomic(usd, 18)` (unit, sin mocks) para `usd ∈ {1.50, 0.333333, 100, 0.000001}` | `usdToAtomic(usd,18) === String(BigInt(Math.round(usd*1e6))*BigInt(1e12))` (fórmula legacy inline) — string-a-string |
| **T-2** Base 6d atómico correcto | AC-1, AC-6 | `usdToAtomic` con decimals=6 (unit) | `usdToAtomic(1.50,6) === "1500000"`; y `BigInt(usdToAtomic(x,6)) * 10n**12n === BigInt(usdToAtomic(x,18))` para varios `x` (10¹² menos que 18d) |
| **T-3** fallback `?? 18` sin token | AC-3, CD-7 | seam con `mockSupportedTokens.current = undefined` (y `= []`) → `settlePaymentIntentOnChain` con `finalAmountUsd` conocido | `mockSign` invocado con `value === usdToAtomic(usd,18)` (== legacy); resultado `status:'settled'` (NUNCA throw/failed por decimals) |
| **T-4** wiring decimals-aware + convergencia verify (Base 6d) | AC-1, AC-4 | seam con `current=[{decimals:6}]` | `mockSign` llamado con `value` = atómico 6d; `mockVerify` llamado con `requiredAmountAtomic === BigInt(<mismo 6d>)` (una sola derivación, no diverge) |
| **T-5** operator-custodial Kite 18d intacto | AC-2 | seam con default 18d (flag escrow OFF) | `mockSign.value` byte-idéntico al legacy; path `settled` sin cambios. (Refuerzo: la suite completa preexistente pasa en verde = prueba de regresión byte-idéntica) |
| **T-6** herencia transparente two-hop (191b) | AC-5 | `ESCROW_SETTLE_ENABLED` ON + firma `valid` mockeada + `current=[{decimals:6}]` | el hop 2 (`settleEscrowAware`→`settlePaymentIntentOnChain`, SIN líneas nuevas) firma el mismo atómico 6d que `row.debit_amount_atomic` del hop 1 → convergen. Cero cambios en `settleEscrowAware` |

**Regresión obligatoria:** suite `payment-intent.test.ts` completa (todos los T-* del seam preexistentes) verde con default 18d → evidencia byte-idéntica del path operator-custodial (CD-2). `tsc --noEmit` 0, `./node_modules/.bin/biome check` 0.

**No-tautológico (CD-AB3):** T-1/T-2 comparan strings exactos; T-4 verificable por mutación temporal (hardcodear `decimals=18` en el wiring → T-4 falla en el `value` esperado 6d).

---

## 6. Exemplars verificados (paths confirmados)

- Patrón decimals-aware correcto a imitar conceptualmente: `src/adapters/escrow/debit-capture.ts:162-173` (deriva `token.decimals` del bundle; NUNCA literal 18) — VERIFICADO (Read).
- `value` verbatim (agnóstico): `src/adapters/kite-ozone/payment.ts:408`, `src/adapters/base/payment.ts:464` — VERIFICADO.
- Verify independiente: `src/adapters/settle-verifier.ts:369,384` — VERIFICADO.
- Mock infra base: `src/services/payment-intent.test.ts:20-33,67` (`vi.hoisted`, `vi.mock` registry) — VERIFICADO.
- Legacy a preservar: `src/services/payment-intent.ts:153-157` (`usdToWei`), call-site `:364`, verify `:429` — VERIFICADO.

---

## 7. Readiness Check

- [x] Alcance = 1 archivo de producción (`payment-intent.ts`) + 1 de test (`payment-intent.test.ts`). Sin migración, sin contrato, sin cambio de firma del seam (CD-5).
- [x] Fórmula `usdToAtomic` definida y probada byte-idéntica en 18d POR CONSTRUCCIÓN (DT-2), no por muestreo.
- [x] Fuente de decimales = una sola resolución `getPaymentAdapter()` (DT-3, CD-6); nuance de clasificación money-safe documentada para AR.
- [x] Optional-chaining corregido a `supportedTokens?.[0]?.decimals ?? 18` (DT-5) — no rompe la suite existente y cubre AC-3.
- [x] `verifyDefaultChainSettle` confirmado sin cambios (DT-4); converge por origen.
- [x] Kite (18d) y path operator-custodial preservados EXACTO en prod; delta solo en path inalcanzable-en-prod y hacia mayor seguridad.
- [x] Test plan ≥1 por AC (AC-1..AC-6 mapeados) + regresión byte-idéntica + no-tautológico.
- [x] CDs heredadas (1-7) + Auto-Blindaje (AB1 biome, AB2 vitest typing, AB3 no-tautológico) integradas.
- [x] Scope OUT explícito: `fee-charge.ts`/`compose.ts` (seam distinto), adapters, contracts, arbiter, settle-verifier, debit-capture/executor.
- [x] Sin `[NEEDS CLARIFICATION]` pendientes.

**Estado: LISTO para `SPEC_APPROVED`.**
