# SDD — [WKH-195] Fee-charge + compose decimals-aware (cierre del hardcode ×1e12 gemelo de WKH-192)

> Fase F2 (Architect). Input: `work-item.md` (esta carpeta). Mode: QUALITY (money-path,
> mismo criterio de evidencia que WKH-192). Estimación: S.
> Branch sugerido: `fix/179-wkh-195-fee-compose-decimals-aware`.

---

## 0. Resumen ejecutivo

Dos seams **gemelos** siguen escalando USD→atómico con el hardcode `× 1e12` (asume 18
decimales), el mismo que WKH-192 (DONE) generalizó a `usdToAtomic(usd, decimals)` en
`settlePaymentIntentOnChain`:

1. `feeUsdcToWei()` en `src/services/fee-charge.ts:164-166` — leg de plataforma del
   protocol fee (`chargeProtocolFee`) **y** legs creator/referral (vía import en
   `fee-split.ts:32`).
2. El cálculo inline de `valueWei` en `src/services/compose.ts:819-821` — pago inbound
   x402 a un agente (`agent.priceUsdc > 0 && !a2aKey`).

Latente hoy (default chain `kite-ozone-testnet` = 18d, correcto); se activa el día que el
operador ponga la default chain en Base (USDC 6d) → el monto firmado sería 10¹²× mayor.

Esta HU aplica el patrón YA auditado de WKH-192 a ambos seams, **reusando** `usdToAtomic`
(DRY, CD-1), byte-idéntico en Kite 18d por construcción (CD-2), sin tocar el seam de
WKH-192, sin tocar `fee-split.ts` (hereda el fix transitivamente, CD-3), con fallback
`?? 18` sin throw (CD-4).

---

## 1. Context Map — archivos leídos (verificados con Read/Grep)

| Archivo:línea | Por qué lo leí | Qué extraje |
|---|---|---|
| `src/services/payment-intent.ts:158-165` | Fuente del helper a reusar (WKH-192) | `usdToAtomic(usd, decimals): string` — **YA EXPORTADO**, BigInt puro (`micro * 10n ** BigInt(decimals-6)`), byte-idéntico en 18d por construcción, rama `<6` floor defensivo. |
| `src/services/payment-intent.ts:370-382` | Wiring de referencia EXACTO (`settlePaymentIntentOnChain`) | Patrón canónico: `const adapter = getPaymentAdapter(); const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; const wei = usdToAtomic(finalAmountUsd, decimals);` seguido de `adapter.sign({ value: wei })`. **Una sola resolución** de adapter reusada para decimals+sign. |
| `src/services/fee-charge.ts:164-166` | Seam #1 a modificar | `feeUsdcToWei(feeUsdc: number): string = String(BigInt(Math.round(feeUsdc*1e6)) * BigInt(1e12))`. Ya importa `getPaymentAdapter` (`:22`). |
| `src/services/fee-charge.ts:393, 448, 471` | Call-site + sign/settle del leg plataforma | `feeUsdcToWei(platformAmount)` en `:393`; `getPaymentAdapter().sign(...)` en `:448` y `.settle(...)` en `:471`, **ambos sin `chainKey`** → default chain. Confirmado: los 3 puntos resuelven el MISMO default-chain adapter. |
| `src/services/fee-split.ts:32, 279-281` | Consumidor transitivo de `feeUsdcToWei` | `import { feeUsdcToWei } from './fee-charge.js'`; `settleFeeSplits` firma cada leg con `getPaymentAdapter().sign(...)` (mock del test `:33-34`, sin `chainKey`) → default chain. **Si mantengo la firma, cero cambio de código acá** (AC-6). |
| `src/services/compose.ts:797-825, 928` | Seam #2 a modificar | Branch `if (agent.priceUsdc > 0 && !a2aKey)`; hardcode `valueWei` en `:819-821`; `getPaymentAdapter().sign(...)` en `:822`; settle en `:928` (fuera del branch, `getPaymentAdapter().settle(...)` sin `chainKey`). Ya importa `getPaymentAdapter` (`:6`). El `chainKey` de `:906-909` (`agent.payment?.chain`) alimenta SOLO telemetría del selector Base (`:910-926`), NUNCA el adapter que firma/settlea. |
| `src/adapters/registry.ts:185-200` | Semántica de `getPaymentAdapter()` | `getPaymentAdapter(chainKey?)` → `resolveBundleOrThrow(chainKey ?? _defaultChainKey).payment`. **Lookup determinístico de un singleton**: sin `chainKey`, toda llamada en el mismo proceso devuelve la MISMA instancia del default-chain adapter (no I/O, no estado por-request). |
| `src/adapters/types.ts:83` | Forma de `supportedTokens` | `PaymentAdapter.supportedTokens: TokenSpec[]` = `{symbol, address, decimals}` — fuente única de decimals reales por chain. |
| `src/services/payment-intent.test.ts:29-44, 1803-1900` | Exemplar de tests de convergencia (WKH-192) | `mockSupportedTokens = vi.hoisted(() => ({ current: [{decimals:18,symbol:'PYUSD'}] }))` + `getPaymentAdapter: () => ({ sign, settle, supportedTokens: mockSupportedTokens.current })`; `legacyWei(usd) = String(BigInt(Math.round(usd*1e6))*BigInt(1e12))`; T-1 convergencia string-exacta Kite 18d (`[1.5, 0.333333, 100, 0.000001]`); T-2 6d = 10¹² menos; T-3 fallback `undefined`/`[]` → 18d sin throw. **Espejo directo** para los tests de esta HU. |
| `src/services/fee-charge.test.ts:25-48` | Mock actual del seam #1 | `getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle })` — **sin `supportedTokens`** → tras el fix caen al fallback `?? 18` → la suite existente sigue byte-idéntica verde (prueba implícita de CD-4). Los tests NUEVOS deben migrar a un mock con `supportedTokens` mutable (patrón WKH-192). |
| `src/services/compose.test.ts:43-47` | Mock actual del seam #2 | Idem: `getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle })` sin `supportedTokens`. Misma implicación. |
| `src/services/fee-split.test.ts:33-34, 264-281` | Mock + uso de `settleFeeSplits` | Idem sin `supportedTokens` → fallback 18d; `settleFeeSplits` asserta `feeUsdcToWei(0.8/0.15/0.05)` en el sign de cada leg. Base para el test de regresión AC-6. |
| `doc/sdd/176-wkh-192-settle-decimals-aware/done-report.md` | Predecesor directo | WKH-192 marcó estos 2 seams como "candidatos a follow-up / Scope OUT explícito". Esta HU es ese follow-up. |

---

## 2. Decisiones técnicas (DT-N)

### DT-1 — `usdToAtomic` reusado por import cruzado, NO duplicado (CD-1)
Ambos seams importan `usdToAtomic` de `src/services/payment-intent.ts` (`import { usdToAtomic } from './payment-intent.js'`). Es un único choke-point de conversión decimals-aware en todo el codebase. Cero ciclo de imports (`payment-intent.ts` no importa `fee-charge.ts` ni `compose.ts` — confirmar en Readiness). La función ya está exportada, es pura y sin side-effects; el JSDoc "exported ONLY for tests" es aspiracional, no un guard de código.
- **Descartado**: mover `usdToAtomic` a un `lib/decimals.ts` compartido. Sería un refactor cosmético que ensancha el blast radius (tocaría `payment-intent.ts`, prohibido por CD-3) sin beneficio de correctness. La higiene de capas (`services/`←`services/`) se deja como TD opcional futuro, fuera de esta HU.

### DT-2 — `feeUsdcToWei`: MANTENER la firma pública, derivar decimals ADENTRO (opción a)
`feeUsdcToWei(feeUsdc: number): string` conserva su firma. Internamente:
```
export function feeUsdcToWei(feeUsdc: number): string {
  const adapter = getPaymentAdapter();                              // default chain (sin chainKey)
  const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18;    // CD-4 fallback
  return usdToAtomic(feeUsdc, decimals);
}
```
- **Por qué opción (a) y no cambiar la firma**: `fee-split.ts:32` importa `feeUsdcToWei` y lo usa en `settleFeeSplits` para los legs creator/referral. `settleFeeSplits` firma/settlea SIEMPRE con `getPaymentAdapter()` sin `chainKey` (mismo default chain). Al derivar los decimales del MISMO default-chain adapter dentro de `feeUsdcToWei`, los legs de `fee-split.ts` heredan el fix con **cero cambio de código** (AC-6, CD-3). Cambiar la firma a `feeUsdcToWei(feeUsdc, decimals)` obligaría a tocar `fee-split.ts:279-281`, ampliando el Scope y violando CD-3.
- **Sobre DT-2-de-WKH-192 ("una sola resolución de adapter para evitar drift")**: se satisface por construcción. `getPaymentAdapter()` es un lookup determinístico de un singleton (registry.ts:185-200): sin `chainKey`, toda llamada en el proceso devuelve la MISMA instancia del default-chain adapter, sin I/O ni estado por-request. Por lo tanto los decimales que `feeUsdcToWei` deriva son **garantizadamente los mismos** que los del adapter que firma en `chargeProtocolFee` (`:448`) y settlea (`:471`) — no hay ventana de drift aunque haya 3 llamadas nominales a `getPaymentAdapter()`. NO se hoistea/pasa un `adapter` a `feeUsdcToWei` (rompería la firma). Documentar este razonamiento inline con un comentario que apunte a registry.ts.

### DT-3 — `compose.ts`: hoistear UNA resolución de adapter en el branch inbound, reusar para decimals+sign
Dentro del branch `if (agent.priceUsdc > 0 && !a2aKey)` (`:797`), justo antes del cálculo de `valueWei`:
```
const adapter = getPaymentAdapter();
const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18;
const valueWei = usdToAtomic(agent.priceUsdc, decimals);
const result = await adapter.sign({ to: payTo as `0x${string}`, value: valueWei });
```
- El `getPaymentAdapter().sign(...)` de `:822` pasa a `adapter.sign(...)` reusando la instancia hoisteada (DT-2 de WKH-192: decimals y sign comparten UN adapter → cero drift).
- El `getPaymentAdapter().settle(...)` de `:928` queda **sin tocar**: está fuera del scope del `adapter` const (fuera del `if`), y resuelve el MISMO default-chain singleton determinístico (byte-equivalente). Tocarlo solo para reusar la variable ampliaría el diff sin ganancia de correctness — se deja como está (menor blast radius). Documentar por qué es seguro.

### DT-4 — Byte-idéntico en Kite 18d por CONSTRUCCIÓN, no por muestreo
`usdToAtomic(usd, 18) === String(BigInt(Math.round(usd*1e6)) * BigInt(1e12))` para todo `usd` (mismo `micro`, mismo `10^12`), demostrado ya en WKH-192 (T-1). Los tests de convergencia de esta HU son string-exacta (`.toBe`, NUNCA `toBeCloseTo`), espejo de T-1/T-2/T-3 de `payment-intent.test.ts`.

### DT-5 — Los tests nuevos migran a un mock de `supportedTokens` mutable (patrón WKH-192)
Los mocks actuales de `fee-charge.test.ts` / `compose.test.ts` / `fee-split.test.ts` NO declaran `supportedTokens` → tras el fix caen al fallback `?? 18` y la suite preexistente sigue byte-idéntica verde (esto es deseable: prueba pasiva de CD-4 y de no-regresión). Los tests NUEVOS de convergencia agregan un `mockSupportedTokens = vi.hoisted(() => ({ current: [...] }))` y exponen `supportedTokens: mockSupportedTokens.current` en la factory de `vi.mock('../adapters/registry.js', ...)`, igual que `payment-intent.test.ts:31-44`.

---

## 3. Constraint Directives (CD-N)

Heredados del work-item (CD-1..CD-5) + específicos de F2 (CD-6..CD-9 del histórico Auto-Blindaje).

- **CD-1** (heredado): PROHIBIDO duplicar la fórmula usd→atómico en `fee-charge.ts` y/o `compose.ts` — OBLIGATORIO `import { usdToAtomic } from './payment-intent.js'` (DRY, un solo choke-point).
- **CD-2** (heredado): OBLIGATORIO byte-idéntico en la default chain `kite-ozone-testnet` (18d) para AMBOS seams — cualquier drift en el valor firmado/settleado en Kite es **BLOQUEANTE** (piedra angular, espejo AC-2 de WKH-192).
- **CD-3** (heredado): PROHIBIDO tocar `payment-intent.ts` (incl. `usdToAtomic` en sí), `fee-split.ts` (código de negocio), `arbiter.ts`, `contracts/`, `escrow-verifier.ts`, `settle-verifier.ts`. Solo se IMPORTA `usdToAtomic`.
- **CD-4** (heredado): OBLIGATORIO fallback `?? 18` sin `throw` cuando `supportedTokens` es vacío/undefined — preserva CD-B de `chargeProtocolFee` (JAMÁS rechaza la promise) y no introduce un nuevo modo de fallo en `compose.callAgent`.
- **CD-5** (heredado): OBLIGATORIO test de convergencia string-exacta (NO `toBeCloseTo`) para AMBOS seams: ≥3 valores Kite 18d idénticos al legado + ≥1 valor Base 6d DIVERGENTE (falsificable, `.not.toBe(...)`).
- **CD-6** (Auto-Blindaje, ≥3 HUs — 191b/191c/191g): en los `vi.mock` factory que reexponen un `vi.fn` hoisted vía spread, tipar el `vi.fn` con parámetros explícitos o rest param (`vi.fn((..._a: unknown[]): T => ...)`), NUNCA firma inferida de 0 args → evita `tsc` TS2556/TS2554. Reusar directamente el patrón `vi.hoisted` del exemplar `payment-intent.test.ts` minimiza este riesgo.
- **CD-7** (Auto-Blindaje 191c): todo símbolo consumido por una factory `vi.mock` (incl. `mockSupportedTokens`, error classes) va en `vi.hoisted` — `vi.mock` es hoisted; un `const`/`class` top-level normal es `undefined` al momento del mock.
- **CD-8** (Auto-Blindaje 191b fix-pack): PROHIBIDO cerrar cobertura con `expect(true).toBe(true)` tautológico. Todo test debe fallar bajo mutación del código bajo prueba. Toda cross-reference a otro test se verifica con `grep` antes de commitear.
- **CD-9** (Auto-Blindaje 191b): al correr el gate de lint usar `./node_modules/.bin/biome`, NO `npx biome` (no resuelve el ejecutable en este entorno).

---

## 4. Waves de implementación

### W0 — Seam #1: `fee-charge.ts` decimals-aware (serial, contrato del helper)
- Agregar `import { usdToAtomic } from './payment-intent.js';` (junto al bloque de imports existente `:33`).
- Reescribir `feeUsdcToWei` (`:164-166`) según DT-2: resolver `getPaymentAdapter()` (ya importado `:22`), derivar `decimals = adapter.supportedTokens?.[0]?.decimals ?? 18`, `return usdToAtomic(feeUsdc, decimals);`. Actualizar el JSDoc (`:156-163`) para reflejar el patrón decimals-aware y el razonamiento de determinismo del singleton (DT-2).
- **Cero cambios** en `:393` (call-site), `:448`/`:471` (sign/settle) ni en `fee-split.ts` (hereda por firma).
- **Verificación de wave**: `tsc --noEmit` 0 errores; `./node_modules/.bin/biome check src/services/fee-charge.ts`.

### W1 — Seam #2: `compose.ts` inbound x402 decimals-aware
- Agregar `import { usdToAtomic } from './payment-intent.js';` al bloque de imports de `compose.ts` (junto a `:5-7`).
- En el branch `:797-825` (DT-3): hoistear `const adapter = getPaymentAdapter();` + `const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18;`, reemplazar `valueWei` (`:819-821`) por `usdToAtomic(agent.priceUsdc, decimals)`, y cambiar `getPaymentAdapter().sign(...)` (`:822`) por `adapter.sign(...)`. Actualizar el comentario `:816-818` (que hoy dice "scale ... by 1e12") al patrón decimals-aware.
- **Cero cambios** en `:928` (settle — mismo singleton, DT-3) ni en la telemetría del selector Base (`:906-926`).
- **Verificación de wave**: `tsc --noEmit`; `biome`.

### W2 — Tests de convergencia + regresión (paralelizable tras W0/W1)
- `fee-charge.test.ts`: migrar el mock de `registry.js` a `supportedTokens` mutable (`vi.hoisted`, CD-6/CD-7) + tests T-1..T-4 (ver §5).
- `compose.test.ts`: idem, tests de convergencia del seam inbound.
- Regresión AC-6: test en `fee-split.test.ts` (o `fee-charge.test.ts`) que ejercite `settleFeeSplits`/`feeUsdcToWei` con config default y confirme monto firmado invariante en Kite 18d.
- **Verificación de wave**: `vitest run` suite completa verde (incl. las 2963+ preexistentes sin regresión); `tsc`; `biome`.

**Serialización**: W0 → W1 son independientes entre sí (archivos distintos) pero ambos dependen del contrato de `usdToAtomic` (ya existente, WKH-192). W2 depende de W0+W1. Sugerido: W0, luego W1, luego W2.

---

## 5. Plan de tests (≥1 por AC)

Exemplar directo: `src/services/payment-intent.test.ts:1803-1900` (bloque "WKH-192 settle decimals-aware"). Helper legado inline por seam:
`const legacyWei = (usd: number): string => String(BigInt(Math.round(usd * 1_000_000)) * BigInt(1_000_000_000_000));`

### Seam #1 — `fee-charge.test.ts` (nuevo describe `WKH-195 fee-charge decimals-aware`)
| Test | Cubre | Aserción |
|---|---|---|
| T1-A: convergencia Kite 18d | AC-1, AC-3, CD-2 | Para `usd ∈ [1.5, 0.333333, 100, 0.000001]` (≥3), con `supportedTokens=[{decimals:18}]`: `feeUsdcToWei(usd)` === `legacyWei(usd)` (string-exacta `.toBe`). |
| T1-B: Base 6d divergente (falsificable) | AC-1, CD-5 | Con `supportedTokens=[{decimals:6}]`: `feeUsdcToWei(1.5)` === `'1500000'` **y** `.not.toBe(legacyWei(1.5))`; además `BigInt(feeUsdcToWei(x,6d)) * 10n**12n === BigInt(legacy)`. |
| T1-C: fallback `undefined`/`[]` | AC-4, CD-4 | Con `supportedTokens = undefined` y `= []` (loop): `feeUsdcToWei(usd)` === `legacyWei(usd)` sin throw (18d). |
| T1-D: leg plataforma no se rompe | AC-1, AC-4 | `chargeProtocolFee(...)` (happy path, `supportedTokens=[{18}]`) → `mockSign` recibe `value === legacyWei(platformAmount)`; status `charged`; NUNCA rechaza la promise. |

### Seam #2 — `compose.test.ts` (nuevo describe `WKH-195 compose inbound decimals-aware`)
| Test | Cubre | Aserción |
|---|---|---|
| T2-A: convergencia Kite 18d | AC-2, AC-3, CD-2 | Agente `priceUsdc=X` sin `a2aKey`, `supportedTokens=[{18}]`, para ≥3 valores de `priceUsdc`: `mockSign.mock.calls[0][0].value` === `legacyWei(priceUsdc)` (string-exacta). |
| T2-B: Base 6d divergente | AC-2, CD-5 | `supportedTokens=[{6}]`: el `value` firmado === `usdToAtomic(priceUsdc,6)` **y** `.not.toBe(legacyWei(priceUsdc))`. |
| T2-C: fallback sin token | AC-4, CD-4 | `supportedTokens = undefined`/`[]`: `value` firmado === `legacyWei(priceUsdc)`; el step no falla por ESTE cambio (sigue fallando solo por las causas de hoy). |
| T2-D: settle sigue corriendo | AC-2 | Tras sign, `mockSettle` es llamado y el step completa (no se rompe el settle path de `:928`). |

### Regresión — AC-6 (`fee-split.test.ts` o `fee-charge.test.ts`)
| Test | Cubre | Aserción |
|---|---|---|
| T3: `settleFeeSplits` invariante en Kite | AC-6, CD-3 | Config default (10000/0/0 → plataforma) con `supportedTokens=[{18}]` (o fallback): el `value` firmado de cada leg === `feeUsdcToWei(amount)` === `legacyWei(amount)`. Confirma que `fee-split.ts` (sin cambios de código) hereda el fix sin drift en Kite. |

**Nota de no-regresión pasiva**: las suites preexistentes de los 3 archivos (que NO declaran `supportedTokens`) deben seguir verdes byte-idénticas tras el fix (fallback 18d) — evidencia adicional de CD-2/CD-4. No borrar ni relajar esos tests.

---

## 6. Exemplars verificados (paths reales)

| Exemplar | Path:línea | Uso |
|---|---|---|
| Helper a reusar | `src/services/payment-intent.ts:158-165` | `usdToAtomic` — import, no re-declarar (CD-1). |
| Wiring canónico (adapter→decimals→usdToAtomic→sign) | `src/services/payment-intent.ts:370-382` | Patrón EXACTO a replicar en ambos seams. |
| Tests de convergencia | `src/services/payment-intent.test.ts:1803-1900` | Estructura T-1/T-2/T-3, `legacyWei`, mock `supportedTokens` mutable. |
| Mock `supportedTokens` mutable | `src/services/payment-intent.test.ts:31-44` | `vi.hoisted` + factory de `vi.mock('../adapters/registry.js')` (CD-6/CD-7). |
| Semántica singleton del adapter | `src/adapters/registry.ts:185-200` | Justifica DT-2 (determinismo sin drift). |

---

## 7. Readiness Check

- [x] `usdToAtomic` está EXPORTADO y es puro (`payment-intent.ts:158`, verificado con Read).
- [x] Sin ciclo de imports: `payment-intent.ts` NO importa `fee-charge.ts` ni `compose.ts` — **verificar en F3 con `grep -n "fee-charge\|compose\|from './compose\|from './fee-charge" src/services/payment-intent.ts`** antes del primer `tsc` (esperado: 0 coincidencias). F0 lo afirma; el Dev lo re-confirma.
- [x] `feeUsdcToWei` mantiene la firma → `fee-split.ts` intacto (AC-6, CD-3). Verificado que `fee-split.ts:32` es el único import externo + `:279-281` el uso.
- [x] Ambos seams operan sobre el default-chain adapter (sin `chainKey`) — verificado en `fee-charge.ts:448/471` y `compose.ts:822/928`.
- [x] El `chainKey` de `compose.ts:906-909` es SOLO telemetría — no se toca (Scope OUT del work-item).
- [x] Mocks actuales sin `supportedTokens` → suites preexistentes byte-idénticas verdes tras el fix (fallback 18d). No requieren cambio salvo los describe nuevos.
- [x] Byte-idéntico Kite 18d por construcción (DT-4), probado con string-exacta (CD-5).
- [x] CDs de Auto-Blindaje incorporados (CD-6..CD-9): mocks `vi.fn` tipados, `vi.hoisted`, no-tautológico, `./node_modules/.bin/biome`.
- [x] Sin `[NEEDS CLARIFICATION]` pendientes. Missing Inputs del work-item: ninguno bloqueante.

**Veredicto: LISTO para SPEC_APPROVED.**

---

## Anexo — Diff conceptual (no es código de producción, solo guía para F2.5/F3)

**`fee-charge.ts:164-166` (antes → después):**
```
- export function feeUsdcToWei(feeUsdc: number): string {
-   return String(BigInt(Math.round(feeUsdc * 1e6)) * BigInt(1e12));
- }
+ export function feeUsdcToWei(feeUsdc: number): string {
+   // WKH-195: decimals-aware. getPaymentAdapter() sin chainKey = default-chain
+   // singleton determinístico (registry.ts:185-200) → los decimales acá son
+   // los MISMOS que usa el sign/settle de chargeProtocolFee (:448/:471), sin drift.
+   const adapter = getPaymentAdapter();
+   const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; // CD-4
+   return usdToAtomic(feeUsdc, decimals); // CD-1 (reuse WKH-192)
+ }
```

**`compose.ts:819-822` (antes → después):**
```
- const valueWei = String(
-   BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12),
- );
- const result = await getPaymentAdapter().sign({
+ // WKH-195: decimals-aware (default-chain adapter). Una sola resolución
+ // reusada para decimals+sign (DT-2 WKH-192); el settle de :928 resuelve el
+ // mismo singleton determinístico.
+ const adapter = getPaymentAdapter();
+ const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; // CD-4
+ const valueWei = usdToAtomic(agent.priceUsdc, decimals); // CD-1
+ const result = await adapter.sign({
    to: payTo as `0x${string}`,
    value: valueWei,
  });
```
