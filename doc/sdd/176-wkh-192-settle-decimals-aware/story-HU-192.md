# Story File — [WKH-192] Seam `settlePaymentIntentOnChain` decimals-aware

> F2.5 · Contrato autocontenido para el Dev (F3) · Wave 0 del EPIC WKH-191
> Branch: `fix/192-wkh-192-settle-decimals-aware`
> Fuente única de verdad: este archivo. Si algo no está acá, NO se hace.
> Deriva de: `doc/sdd/176-wkh-192-settle-decimals-aware/sdd.md` (SPEC_APPROVED).

---

## 0. Contexto compacto (qué se construye y por qué)

`settlePaymentIntentOnChain` (`src/services/payment-intent.ts:355-471`, seam auditado WKH-136) firma/settlea
el monto atómico on-chain con `usdToWei(usd)` (`:153-157`), que **hardcodea 18 decimales**
(`BigInt(Math.round(usd*1e6)) * BigInt(1e12)`). Hoy es correcto SOLO porque el default chain es Kite (PYUSD,
18d). Pero `WasiAIEscrow` (WKH-191b) vive en Base Sepolia, cuyo USDC tiene **6 decimales**, y
`base/payment.ts:sign()` toma `value` verbatim como atómico. En `default-chain=base-*` el hop 2 firmaría
**10¹²× el monto** → nunca completa el happy-path (money-safe: cae a `reconciliation-pending`).

Este ticket generaliza el helper a `usdToAtomic(usd, decimals)` derivando los decimals REALES del token del
`PaymentAdapter` resuelto, **byte-idéntico en Kite (18d) por construcción**. Es pre-requisito de código de
WKH-191d (activación). NO activa nada, NO cambia default-chain, NO toca contratos.

---

## 1. Scope IN — lista EXHAUSTIVA de archivos a tocar

| Archivo | Qué se toca | Wave |
|---|---|---|
| `src/services/payment-intent.ts` | Rename/generalizar `usdToWei`→`export usdToAtomic(usd,decimals)` + wiring en `settlePaymentIntentOnChain` (resolver adapter 1 vez, derivar decimals, reusar instancia) | W0 |
| `src/services/payment-intent.test.ts` | Refactor mock `getPaymentAdapter` a `vi.hoisted` seteable + tests T-1..T-6 | W1 |

**NADA MÁS.** Si te ves tocando cualquier otro archivo → STOP, es violación de scope (ver §2 CD-3).

---

## 2. Constraint Directives (heredadas — INVIOLABLES)

- **CD-1** PROHIBIDO modificar `sign()`/`settle()` de CUALQUIER adapter (`kite-ozone/payment.ts`,
  `base/payment.ts`, `avalanche/payment.ts`). Son decimals-agnósticos por diseño (toman `value` verbatim:
  `kite-ozone/payment.ts:408`, `base/payment.ts:464`). El fix es choke-point ÚNICO en `payment-intent.ts`.
- **CD-2** OBLIGATORIO convergencia Kite byte-idéntica: para ≥3 valores de `finalAmountUsd` (incl. ≥1 con
  6 decimales de precisión, p.ej. `0.333333`) el atómico nuevo == string-a-string al legacy. Un dígito de
  diferencia = regresión del path operator-custodial en prod.
- **CD-3** PROHIBIDO tocar: `contracts/`, `src/services/arbiter.ts`,
  `src/adapters/escrow/debit-capture.ts`, `src/adapters/escrow/debit-executor.ts`,
  `src/services/fee-charge.ts` (`feeUsdcToWei`, seam DISTINTO), `src/services/compose.ts`,
  `src/adapters/settle-verifier.ts`. Todos Scope OUT.
- **CD-4** OBLIGATORIO aritmética BigInt entera (`micro × 10^(decimals-6)`), SIN `parseUnits`/`Number.toFixed`.
  Garantiza CD-2 por construcción.
- **CD-5** PROHIBIDO cambiar la firma pública de `settlePaymentIntentOnChain` (seam auditado, 3+ call-sites:
  `closeSession`, `settleUpto`, `settleEscrowAware`). Exportar el helper puro `usdToAtomic` NO es la firma
  del seam → permitido.
- **CD-6** OBLIGATORIO derivar decimals de la MISMA instancia `getPaymentAdapter()` reusada para sign+settle
  (una sola resolución). PROHIBIDA una segunda resolución que pueda divergir.
- **CD-7** OBLIGATORIO que el fallback (AC-3) NUNCA lance: todo código nuevo vive DENTRO del `try/catch`
  existente (`:363-470`). El `?? 18` + `?.` garantiza no-throw sin token.
- **CD-AB1** (Auto-Blindaje 191a/191b) Correr `./node_modules/.bin/biome check --write` sobre producción
  **Y los tests** antes de dar por hecho. NO usar `npx biome` (no resuelve el bin en este entorno). NO
  pre-envolver a mano llamadas cortas: dejar que biome decida el wrapping.
- **CD-AB2** (Auto-Blindaje 191b/191c) Al refactorizar el mock a `vi.fn`/`vi.hoisted` seteable: TODO símbolo
  consumido por la factory de `vi.mock` va en `vi.hoisted`; tipar params/retornos de los `vi.fn` (evitar
  firma inferida `() => void` que rompe `tsc` con `TS2554`/`TS2556`).
- **CD-AB3** (Auto-Blindaje 191b) PROHIBIDO cerrar cobertura con `expect(true).toBe(true)`. Cada test de
  convergencia asserta igualdad de string EXACTA. Toda cross-reference a otro test se verifica con `grep`.

---

## 3. Anti-Hallucination Checklist (verificá ANTES de escribir código)

- [ ] `usdToWei` está EXACTAMENTE en `src/services/payment-intent.ts:153-157`. Su cuerpo es
      `return String(BigInt(Math.round(usd * 1_000_000)) * BigInt(1_000_000_000_000));`. JSDoc en `:147-152`.
- [ ] El ÚNICO call-site de `usdToWei` es `settlePaymentIntentOnChain` `:364` (`const wei = usdToWei(finalAmountUsd);`).
      Confirmalo con `grep -n "usdToWei" src/services/payment-intent.ts` → debe dar EXACTAMENTE 2 hits
      (definición `:153` + call `:364`). Si hay más, PARÁ y reportá.
- [ ] `getPaymentAdapter()` se llama HOY 2 veces dentro del seam: `:369` (`.sign`) y `:391` (`.settle`).
- [ ] `verifyDefaultChainSettle({ ..., requiredAmountAtomic: BigInt(wei) })` está en `:426-430` — NO se toca.
- [ ] `getPaymentAdapter` viene de `../adapters/registry.js`; su retorno (`PaymentAdapter`) expone
      `supportedTokens?: TokenSpec[]` y `TokenSpec` tiene `decimals: number` (`src/adapters/types.ts`).
- [ ] `base/payment.ts` usa `USDC_DECIMALS = 6` (`:61`); `kite-ozone/payment.ts` expone `decimals: 18` en
      `supportedTokens` (`:265`). NO los toques — son referencia de que 6d/18d son reales.
- [ ] El mock del test en `payment-intent.test.ts:29-33` devuelve `getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle })`
      **SIN `supportedTokens`**. Por eso el optional-chaining DEBE ser `supportedTokens?.[0]?.decimals ?? 18`
      (con `?.` sobre el array), NO `supportedTokens[0]?.decimals ?? 18`. Verificá el mock antes de asumir.
- [ ] NO existe hoy ninguna función llamada `usdToAtomic`. La creás vos. `grep -rn "usdToAtomic" src/` debe
      dar 0 hits antes de empezar.

---

## 4. Waves

### W0 — serial · `src/services/payment-intent.ts` (aritmética + wiring)

**W0.1 — Reemplazar el helper `usdToWei`→`usdToAtomic` (exportada)**

Reemplazá el bloque `:147-157` (JSDoc + función `usdToWei`) por:

```ts
/**
 * USD → unidad atómica del token, decimals-aware (WKH-192).
 *
 * `micro` = micro-USD entero (6 decimales), IDÉNTICO al legacy `usdToWei`.
 * Escala por `10^(decimals-6)` con BigInt entero puro (sin float64 nuevo, sin
 * parseUnits, sin toFixed). Byte-idéntico al legacy cuando `decimals === 18`
 * (mismo `micro`, `10^12`) POR CONSTRUCCIÓN — no por muestreo.
 * Rama `< 6` decimales: floor defensivo, hoy inalcanzable (ningún token < 6d).
 *
 * @internal exported ONLY for byte-identical convergence tests (WKH-192).
 */
export function usdToAtomic(usd: number, decimals: number): string {
  const micro = BigInt(Math.round(usd * 1_000_000));
  return String(
    decimals >= 6
      ? micro * 10n ** BigInt(decimals - 6)
      : micro / 10n ** BigInt(6 - decimals),
  );
}
```

Diff conceptual línea por línea:
- BORRA el JSDoc viejo (`:147-152`, el que dice "18 decimals / token del default chain (kite/PYUSD) es 18 decimals").
- BORRA `function usdToWei(usd: number): string { ... }` (`:153-157`) — se elimina, no queda helper muerto.
- AGREGA `export function usdToAtomic(usd: number, decimals: number)` con la fórmula de arriba.
- Nota: `BigInt(Math.round(usd * 1_000_000))` es LITERALMENTE la misma expresión que el legacy → mismo `micro`.
  Con `decimals=18`: `micro * 10n ** 12n` === `micro * 1_000_000_000_000n` === legacy. QED byte-idéntico.

**W0.2 — Wiring en `settlePaymentIntentOnChain` (resolver adapter 1 vez, DT-3/CD-6)**

En `:362-364`, reemplazá:

```ts
  const { intentId, payTo, finalAmountUsd } = params;
  try {
    const wei = usdToWei(finalAmountUsd);
```

por:

```ts
  const { intentId, payTo, finalAmountUsd } = params;
  try {
    const adapter = getPaymentAdapter();
    const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18;
    const wei = usdToAtomic(finalAmountUsd, decimals);
```

Luego, reusá la MISMA instancia `adapter` en los 2 call-sites (NO re-resolver):
- `:369` `signResult = await getPaymentAdapter().sign({` → `signResult = await adapter.sign({`
- `:391` `const settleResult = await getPaymentAdapter().settle({` → `const settleResult = await adapter.settle({`

`requiredAmountAtomic: BigInt(wei)` (`:429`) queda **SIN cambios** — `wei` ya es el atómico correcto en origen,
la comparación converge sola (DT-4). NO toques `verifyDefaultChainSettle`.

Notas críticas de W0.2:
- `const adapter = getPaymentAdapter()` va DENTRO del `try` (`:363`), después de `const { ... } = params`. Esto
  respeta CD-7 (cualquier throw cae al outer catch → `failed_ambiguous`, money-safe). El SDD documenta este
  delta de clasificación (hoist del `getPaymentAdapter` al outer try) como inalcanzable-en-prod y estrictamente
  más seguro — NO intentes "preservar" la clasificación con 2 llamadas separadas (violaría CD-6).
- Debe quedar `supportedTokens?.[0]?.decimals` — con `?.` sobre el array. Si escribís `supportedTokens[0]?.decimals`
  y `supportedTokens` es undefined (como en el mock actual del test) → `TypeError` → rompe TODA la suite del seam.

**Post-W0 (obligatorio CD-AB1):** `grep -n "usdToWei" src/services/payment-intent.ts` → 0 hits.
`./node_modules/.bin/biome check --write src/services/payment-intent.ts`. `tsc --noEmit` → 0 errores.

### W1 — tests · `src/services/payment-intent.test.ts` (T-1..T-6)

**W1.0 — Refactor del mock a `vi.hoisted` seteable (DT-5 + CD-AB2)**

El mock actual (`:20-33`):
```ts
const mockSign = vi.fn();
const mockSettle = vi.fn();
...
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
  getDefaultChainKey: () => mockGetDefaultChainKey(),
  getAdaptersBundle: () => mockGetAdaptersBundle(),
}));
```

Introducí un contenedor mutable hoisted para `supportedTokens` (todo símbolo usado por la factory de
`vi.mock` DEBE estar en `vi.hoisted` — CD-AB2):

```ts
// WKH-192: supportedTokens seteable por test para variar decimals del default chain.
// Default 18d = modela el default chain Kite de HOY → la suite preexistente byte-idéntica.
const mockSupportedTokens = vi.hoisted(
  () =>
    ({
      current: [{ decimals: 18, symbol: 'PYUSD' }] as
        | { decimals: number; symbol: string }[]
        | undefined,
    }),
);
```

y en la factory:
```ts
getPaymentAdapter: () => ({
  sign: mockSign,
  settle: mockSettle,
  supportedTokens: mockSupportedTokens.current,
}),
```

Agregá en el `beforeEach` (o creá uno si el bloque del seam no lo tiene) el reset:
```ts
mockSupportedTokens.current = [{ decimals: 18, symbol: 'PYUSD' }];
```
Esto garantiza que la suite preexistente corra en 18d (byte-idéntica). NOTA: `mockGetAdaptersBundle` (`:26-28`,
usado por el path real de captura 191a con `decimals: 6`) NO se toca — es un mock DISTINTO (`getAdaptersBundle`,
no `getPaymentAdapter`).

**W1.1 — Tests T-1..T-6** (agrupá en un `describe('WKH-192 settle decimals-aware', ...)`):

| Test | AC | Setup | Assert clave (string EXACTA — CD-AB3) |
|---|---|---|---|
| **T-1** convergencia byte-idéntica Kite 18d | AC-2, AC-6, CD-2 | unit, import `usdToAtomic`, sin mocks. `usd ∈ {1.50, 0.333333, 100, 0.000001}` | `expect(usdToAtomic(usd,18)).toBe(String(BigInt(Math.round(usd*1_000_000))*BigInt(1_000_000_000_000)))` para cada valor (fórmula legacy inline) |
| **T-2** Base 6d atómico correcto | AC-1, AC-6 | unit `usdToAtomic` decimals=6 | `expect(usdToAtomic(1.50,6)).toBe("1500000")`; y para varios `x`: `expect(BigInt(usdToAtomic(x,6))*10n**12n).toBe(BigInt(usdToAtomic(x,18)))` (exactamente 10¹² menos que 18d) |
| **T-3** fallback `?? 18` sin token | AC-3, CD-7 | seam: `mockSupportedTokens.current = undefined` (y un caso `= []`). Correr `settlePaymentIntentOnChain` con `finalAmountUsd` conocido, `mockSign`/`mockSettle` resolviendo OK, `mockVerify` ok:true | `mockSign` invocado con `value === usdToAtomic(usd,18)` (== legacy); outcome `status:'settled'`. NUNCA throw/`failed` por decimals |
| **T-4** wiring decimals-aware + convergencia verify (Base 6d) | AC-1, AC-4 | seam: `mockSupportedTokens.current = [{decimals:6, symbol:'USDC'}]` | `mockSign` llamado con `value === usdToAtomic(usd,6)`; `mockVerify` llamado con `requiredAmountAtomic === BigInt(usdToAtomic(usd,6))` (misma derivación, no diverge) |
| **T-5** operator-custodial Kite 18d intacto | AC-2 | seam: default 18d (flag escrow OFF, path directo) | `mockSign` recibe `value` byte-idéntico al legacy; outcome `settled`. Refuerzo: la suite completa preexistente en verde = regresión byte-idéntica |
| **T-6** herencia transparente two-hop (191b) | AC-5 | `ESCROW_SETTLE_ENABLED` ON + firma `valid` mockeada + `current=[{decimals:6}]` (seguí el patrón de mock del two-hop existente en el archivo — `debit-capture.js` partial mock, `settleEscrowAware`) | el hop 2 (`settleEscrowAware`→`settlePaymentIntentOnChain`, SIN líneas nuevas) firma el mismo atómico 6d que `row.debit_amount_atomic` del hop 1 → convergen. Verificá que `settleEscrowAware` NO cambió (`grep`) |

Notas de W1:
- Para T-3/T-4/T-5/T-6, seguí el patrón de invocación del seam que YA existe en el archivo (los tests
  T-VERIFY/T-8/191b). NO inventes un harness nuevo: leé cómo la suite arma `settlePaymentIntentOnChain` /
  `settleEscrowAware` y mockea supabase/verify antes de escribir.
- T-1/T-2 son UNIT puros (import directo de `usdToAtomic`) — no dependen de mocks del seam.
- No-tautológico (CD-AB3): T-1/T-2 comparan strings exactos; T-4 es falsificable (si hardcodearas `decimals=18`
  en el wiring, T-4 fallaría en el `value` esperado 6d).

**Post-W1 (obligatorio):** `./node_modules/.bin/biome check --write src/services/payment-intent.test.ts`;
`tsc --noEmit` → 0; suite `payment-intent.test.ts` COMPLETA en verde (los T-* preexistentes = regresión
byte-idéntica del path operator-custodial, CD-2).

---

## 5. Patrones a seguir (exemplars verificados)

- **Decimals-aware correcto (conceptual)**: `src/adapters/escrow/debit-capture.ts:162-173` deriva
  `token.decimals` del bundle, NUNCA literal 18. (No lo copiés literal — usa `parseUnits`; nosotros usamos
  BigInt puro por CD-4. Es referencia de "derivar decimals, no hardcodear".)
- **`value` verbatim (agnóstico, NO tocar)**: `kite-ozone/payment.ts:408`, `base/payment.ts:464`.
- **Verify independiente (NO tocar)**: `src/adapters/settle-verifier.ts:369,384`.
- **Mock infra base del test**: `payment-intent.test.ts:12-33,67-78` (`vi.hoisted`, `vi.mock` de registry
  con las 3 exports). Extendé este patrón, no lo reemplaces.
- **Legacy a preservar byte-a-byte**: `payment-intent.ts:153-157` (`usdToWei`).

---

## 6. Tests requeridos (mapeo AC → test)

| AC | Test(s) |
|---|---|
| AC-1 (decimals reales, nunca literal 18) | T-2, T-4 |
| AC-2 (Kite 18d byte-idéntico, sin drift prod) | T-1, T-5 |
| AC-3 (fallback 18d sin token, nunca throw) | T-3 |
| AC-4 (mismo atómico a `verifyDefaultChainSettle`) | T-4 |
| AC-5 (herencia transparente two-hop 191b) | T-6 |
| AC-6 (tests de convergencia por chain) | T-1, T-2 |

---

## 7. Done Definition (F3 termina cuando)

- [ ] `usdToWei` eliminada; `export function usdToAtomic(usd, decimals)` presente con la fórmula de §4.
      `grep -n "usdToWei" src/services/payment-intent.ts` → 0 hits.
- [ ] `settlePaymentIntentOnChain` resuelve `const adapter = getPaymentAdapter()` UNA vez, deriva
      `decimals = adapter.supportedTokens?.[0]?.decimals ?? 18`, y usa `adapter.sign`/`adapter.settle`
      (no `getPaymentAdapter().sign/settle`). `grep -c "getPaymentAdapter()" src/services/payment-intent.ts`
      dentro del seam → 1 (solo la resolución del tope).
- [ ] `requiredAmountAtomic: BigInt(wei)` sin cambios; `settle-verifier.ts` sin tocar.
- [ ] Firma pública de `settlePaymentIntentOnChain` intacta (CD-5).
- [ ] Ningún archivo de §2 CD-3 modificado (`git diff --name-only` == exactamente los 2 de §1).
- [ ] T-1..T-6 implementados; mock refactorizado a `vi.hoisted` seteable con reset a 18d en `beforeEach`.
- [ ] `./node_modules/.bin/biome check` → 0 (producción Y test); `tsc --noEmit` → 0.
- [ ] Suite `payment-intent.test.ts` COMPLETA en verde (nuevos + preexistentes = regresión byte-idéntica).

---

## 8. Anclas de línea verificadas (F2.5, sobre HEAD actual)

- `usdToWei` def: `payment-intent.ts:153-157` · JSDoc: `:147-152` — VERIFICADO (Read).
- Call-site único: `:364` (`const wei = usdToWei(finalAmountUsd)`) — VERIFICADO.
- `getPaymentAdapter().sign`: `:369` · `getPaymentAdapter().settle`: `:391` — VERIFICADO.
- `verifyDefaultChainSettle({ requiredAmountAtomic: BigInt(wei) })`: `:426-430` — VERIFICADO.
- outer try/catch (CD-7): `:363-470` — VERIFICADO.
- Test mock registry (SIN `supportedTokens`): `payment-intent.test.ts:29-33` — VERIFICADO.
- `mockGetAdaptersBundle` con `decimals:6` (mock DISTINTO, no tocar): `:26-28` — VERIFICADO.
- `base/payment.ts` `USDC_DECIMALS = 6`: `:61` · `kite-ozone/payment.ts` `decimals: 18`: `:265` — VERIFICADO.

**Estado: READY FOR F3.**
