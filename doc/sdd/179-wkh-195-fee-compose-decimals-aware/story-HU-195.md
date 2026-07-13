# Story File — HU WKH-195 · Fee-charge + compose decimals-aware

> Contrato autocontenido para el Dev (F3). Fuente única de verdad de esta HU.
> Si algo no está acá, NO se hace. Deriva de `sdd.md` (SPEC_APPROVED) + `work-item.md`.
> Mode: **QUALITY** (money-path, mismo criterio de evidencia que WKH-192, DONE).
> Branch: `fix/179-wkh-195-fee-compose-decimals-aware`. Estimación: S.

---

## 1. Contexto compacto (qué se construye y por qué)

Dos seams **gemelos** siguen escalando USD→atómico con el hardcode `× 1e12`
(asume 18 decimales), el mismo bug que WKH-192 (DONE) ya cerró en
`settlePaymentIntentOnChain` reusando `usdToAtomic(usd, decimals)`:

1. **Seam #1** — `feeUsdcToWei()` en `src/services/fee-charge.ts:164-166`.
   Alimenta el leg de plataforma del protocol fee (`chargeProtocolFee`) **y**
   los legs creator/referral vía import en `fee-split.ts:32` (`settleFeeSplits`).
2. **Seam #2** — el cálculo inline de `valueWei` en `src/services/compose.ts:819-821`
   (pago inbound x402 a un agente: `agent.priceUsdc > 0 && !a2aKey`).

Latente hoy porque la default chain es `kite-ozone-testnet` (PYUSD, 18d → correcto).
Se activa el día que el operador ponga la default chain en Base (USDC 6d): el monto
firmado/settleado sería **10¹²× mayor** → el settle revierte o cobra de más.

**El fix**: aplicar el patrón YA auditado de WKH-192 a ambos seams, **reusando**
`usdToAtomic` de `payment-intent.ts` (DRY), byte-idéntico en Kite 18d por
construcción, sin tocar el seam de WKH-192, sin tocar `fee-split.ts` (hereda por
firma), con fallback `?? 18` sin throw.

---

## 2. Scope IN — archivos exactos a tocar

| # | Archivo | Qué se hace | Wave |
|---|---|---|---|
| 1 | `src/services/fee-charge.ts` | Import `usdToAtomic` + reescribir `feeUsdcToWei` (mantener firma) | W0 |
| 2 | `src/services/compose.ts` | Import `usdToAtomic` + hoist adapter + reemplazar `× 1e12` en branch `:797-825` | W1 |
| 3 | `src/services/fee-charge.test.ts` | Migrar mock a `supportedTokens` mutable + tests T1-A..T1-D | W2 |
| 4 | `src/services/compose.test.ts` | Migrar mock a `supportedTokens` mutable + tests T2-A..T2-D | W2 |
| 5 | `src/services/fee-split.test.ts` | Test de regresión AC-6 (T3) — solo cobertura, NO código de `fee-split.ts` | W2 |

**NO se toca NADA fuera de estas 5 rutas** (salvo `_INDEX.md` bookkeeping que hace
`nexus-docs` en DONE, no vos).

---

## 3. Anti-Hallucination Checklist (verificá ANTES de escribir)

Todas estas anclas fueron confirmadas con Read/Grep por el Architect. Re-confirmalas:

- [ ] `src/services/payment-intent.ts:158` exporta `export function usdToAtomic(usd: number, decimals: number): string` — **YA EXISTE, se IMPORTA, NO se re-declara ni se toca** (CD-3).
  - Impl real: `const micro = BigInt(Math.round(usd * 1_000_000)); return String(decimals >= 6 ? micro * 10n ** BigInt(decimals - 6) : micro / 10n ** BigInt(6 - decimals));`
- [ ] `src/services/fee-charge.ts:22` ya importa `getPaymentAdapter` de `'../adapters/registry.js'` — **reusar, NO re-importar**.
- [ ] `src/services/fee-charge.ts:164-166` es `feeUsdcToWei` con firma `(feeUsdc: number): string` y cuerpo `return String(BigInt(Math.round(feeUsdc * 1e6)) * BigInt(1e12));`.
- [ ] `src/services/fee-charge.ts:393` es el call-site `const feeWei = feeUsdcToWei(platformAmount);` — **NO se toca**. Sign en `:448`, settle en `:471` (ambos `getPaymentAdapter()` sin `chainKey`) — **NO se tocan**.
- [ ] `src/services/fee-split.ts:32` importa `feeUsdcToWei` de `'./fee-charge.js'`; su call-site real es `:390` (`const wei = feeUsdcToWei(amountUsdc);`), sign `:417`, settle `:432` — **NINGUNA línea de `fee-split.ts` cambia** (hereda por firma, AC-6/CD-3).
- [ ] `src/services/compose.ts:6` ya importa `getPaymentAdapter` — reusar.
- [ ] `src/services/compose.ts:797` abre el branch `if (agent.priceUsdc > 0 && !a2aKey)`; hardcode en `:819-821`; sign en `:822`; comentario a actualizar en `:816-818`.
- [ ] `src/services/compose.ts:928` es `getPaymentAdapter().settle(...)` FUERA del branch — **NO se toca** (mismo default-chain singleton, byte-equivalente).
- [ ] `src/services/compose.ts:906-909` resuelve `chainKey` de `agent.payment?.chain` para **telemetría del selector Base (`:910-926`)** — NUNCA alimenta el adapter que firma/settlea — **NO se toca** (Scope OUT).
- [ ] **NO hay ciclo de imports**: `payment-intent.ts` NO importa `fee-charge.ts` ni `compose.ts`. Verificalo antes del primer `tsc`:
  ```
  grep -nE "from '\./(fee-charge|compose)" src/services/payment-intent.ts
  ```
  Esperado: **0 coincidencias** (la única mención "fee-charge.ts:256-345" es un comentario JSDoc, no un import).
- [ ] `adapter.supportedTokens?.[0]?.decimals ?? 18` es el patrón canónico (verificado en `payment-intent.ts:370-382`). `supportedTokens: TokenSpec[]` = `{symbol, address, decimals}` (`src/adapters/types.ts:83`).

---

## 4. Waves con archivos exactos por wave

### W0 — `fee-charge.ts` decimals-aware (serial, contrato del helper)

**Archivo**: `src/services/fee-charge.ts`

1. Agregar el import (junto al bloque existente, cerca de `:22-33`):
   ```ts
   import { usdToAtomic } from './payment-intent.js';
   ```
2. Reescribir `feeUsdcToWei` (`:164-166`) **manteniendo la firma pública** `(feeUsdc: number): string`:
   ```ts
   export function feeUsdcToWei(feeUsdc: number): string {
     // WKH-195: decimals-aware. getPaymentAdapter() sin chainKey = default-chain
     // singleton determinístico (registry.ts:185-200) → los decimales acá son
     // los MISMOS que usa el sign/settle de chargeProtocolFee (:448/:471), sin drift.
     const adapter = getPaymentAdapter();
     const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; // CD-4
     return usdToAtomic(feeUsdc, decimals); // CD-1 (reuse WKH-192)
   }
   ```
3. Actualizar el JSDoc de `:156-163` (hoy dice "18 decimals" / "1e12 escala a 18")
   para reflejar el patrón decimals-aware y el determinismo del singleton (DT-2).
4. **Diff conceptual** (antes → después):
   ```
   - export function feeUsdcToWei(feeUsdc: number): string {
   -   return String(BigInt(Math.round(feeUsdc * 1e6)) * BigInt(1e12));
   - }
   + export function feeUsdcToWei(feeUsdc: number): string {
   +   const adapter = getPaymentAdapter();
   +   const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; // CD-4
   +   return usdToAtomic(feeUsdc, decimals); // CD-1
   + }
   ```
5. **CERO cambios** en `:393` (call-site), `:448`/`:471` (sign/settle) ni en `fee-split.ts`.
6. **Por qué mantener la firma**: `fee-split.ts:32` importa `feeUsdcToWei` y lo usa en
   `settleFeeSplits` (call-site `:390`), que firma/settlea SIEMPRE con `getPaymentAdapter()`
   sin `chainKey` (mismo default chain). Al derivar los decimales del MISMO default-chain
   adapter dentro de `feeUsdcToWei`, `fee-split.ts` hereda el fix con **cero cambio de código**
   (AC-6). Cambiar la firma a `(feeUsdc, decimals)` obligaría a tocar `fee-split.ts:390` → viola CD-3.

**Verificación de wave**: `./node_modules/.bin/tsc --noEmit` 0 errores + `./node_modules/.bin/biome check src/services/fee-charge.ts`.

### W1 — `compose.ts` inbound x402 decimals-aware

**Archivo**: `src/services/compose.ts`

1. Agregar el import (junto al bloque `:5-7`):
   ```ts
   import { usdToAtomic } from './payment-intent.js';
   ```
2. En el branch `:816-825`: hoistear UNA resolución de adapter, derivar decimals,
   reemplazar el `× 1e12`, y reusar `adapter.sign`:
   ```
   - // MONEY-PATH: scale priceUsdc (USDC, 6 decimals) up to an 18-decimal wei
   - // value. Round-to-nearest onto the 6-decimal USDC grid, then scale by 1e12.
   - // Matches fee-charge.ts:feeUsdcToWei (same Math.round convention).
   - const valueWei = String(
   -   BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12),
   - );
   - const result = await getPaymentAdapter().sign({
   + // WKH-195: decimals-aware (default-chain adapter). Una sola resolución
   + // reusada para decimals+sign (DT-2 WKH-192); el settle de :928 resuelve el
   + // mismo singleton determinístico → byte-equivalente, no se toca.
   + const adapter = getPaymentAdapter();
   + const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; // CD-4
   + const valueWei = usdToAtomic(agent.priceUsdc, decimals); // CD-1
   + const result = await adapter.sign({
       to: payTo as `0x${string}`,
       value: valueWei,
     });
   ```
3. **CERO cambios** en `:928` (settle — mismo singleton determinístico) ni en la
   telemetría del selector Base (`:906-926`). El `const adapter` vive dentro del `if`;
   el settle de `:928` está fuera de ese scope y resuelve el MISMO default-chain
   singleton — dejarlo tal cual reduce el blast radius sin perder correctness.

**Verificación de wave**: `tsc --noEmit` + `biome check src/services/compose.ts`.

### W2 — Tests de convergencia + regresión (tras W0+W1)

Exemplar directo a copiar: `src/services/payment-intent.test.ts:29-44` (mock) y
`:1803-1900` (bloque "WKH-192 settle decimals-aware"). Helper legado inline **por seam**:
```ts
const legacyWei = (usd: number): string =>
  String(BigInt(Math.round(usd * 1_000_000)) * BigInt(1_000_000_000_000));
```

**Refactor de mocks (CD-6/CD-7)** — los 3 archivos de test hoy tienen
`getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle })` **sin** `supportedTokens`.
Migrar a un `supportedTokens` mutable seteable (espejo WKH-192 / patrón WKH-192):
```ts
const mockSupportedTokens = vi.hoisted(
  () => ({ current: [{ symbol: 'PYUSD', address: '0x0', decimals: 18 }] as
    | { symbol: string; address: string; decimals: number }[]
    | undefined }),
);
// dentro de vi.mock('../adapters/registry.js', ...):
getPaymentAdapter: (..._a: unknown[]) => ({
  sign: mockSign,
  settle: mockSettle,
  supportedTokens: mockSupportedTokens.current,
}),
```
- **CD-7**: `mockSupportedTokens` va en `vi.hoisted` (la factory de `vi.mock` es hoisted).
- **CD-6**: si tipás algún `vi.fn` reexpuesto, usar rest param `(..._a: unknown[])`, nunca firma de 0 args → evita `tsc` TS2554/TS2556.
- Setear `mockSupportedTokens.current` por test (`beforeEach` reset a 18d; el test de 6d o fallback lo sobreescribe).

#### `fee-charge.test.ts` — describe `WKH-195 fee-charge decimals-aware`
| Test | Cubre | Aserción (falsificable, `.toBe` string-exacta — NO `toBeCloseTo`) |
|---|---|---|
| **T1-A** convergencia Kite 18d | AC-1, AC-3, CD-2 | Para `usd ∈ [1.5, 0.333333, 100, 0.000001]` (≥3, incluye precisión 6d), con `supportedTokens=[{decimals:18}]`: `feeUsdcToWei(usd)` === `legacyWei(usd)`. |
| **T1-B** Base 6d divergente | AC-1, CD-5 | Con `supportedTokens=[{decimals:6}]`: `feeUsdcToWei(1.5)` === `'1500000'` **Y** `.not.toBe(legacyWei(1.5))`; además `BigInt(feeUsdcToWei(x)) * 10n**12n === BigInt(legacyWei(x))`. |
| **T1-C** fallback `undefined`/`[]` | AC-4, CD-4 | Con `supportedTokens = undefined` y `= []` (loop): `feeUsdcToWei(usd)` === `legacyWei(usd)`, **sin throw** (cae a 18d). |
| **T1-D** leg plataforma no se rompe | AC-1, AC-4 | `chargeProtocolFee(...)` happy path (`supportedTokens=[{18}]`) → `mockSign` recibe `value === legacyWei(platformAmount)`; status `charged`; la promise NUNCA se rechaza. |

#### `compose.test.ts` — describe `WKH-195 compose inbound decimals-aware`
| Test | Cubre | Aserción |
|---|---|---|
| **T2-A** convergencia Kite 18d | AC-2, AC-3, CD-2 | Agente `priceUsdc=X` sin `a2aKey`, `supportedTokens=[{18}]`, ≥3 valores: `mockSign.mock.calls[0][0].value` === `legacyWei(priceUsdc)`. |
| **T2-B** Base 6d divergente | AC-2, CD-5 | `supportedTokens=[{6}]`: el `value` firmado === `usdToAtomic(priceUsdc,6)` **Y** `.not.toBe(legacyWei(priceUsdc))`. |
| **T2-C** fallback sin token | AC-4, CD-4 | `supportedTokens = undefined`/`[]`: `value` firmado === `legacyWei(priceUsdc)`; el step NO falla por ESTE cambio (sigue fallando solo por sus causas de hoy). |
| **T2-D** settle sigue corriendo | AC-2 | Tras sign, `mockSettle` es invocado y el step completa — el path de `:928` no se rompe. |

#### Regresión AC-6 — `fee-split.test.ts`, describe `WKH-195 fee-split hereda el fix`
| Test | Cubre | Aserción |
|---|---|---|
| **T3** `settleFeeSplits` invariante en Kite | AC-6, CD-3 | Config default (10000/0/0 → plataforma) con `supportedTokens=[{18}]` (o fallback): el `value` firmado de cada leg === `feeUsdcToWei(amount)` === `legacyWei(amount)`. Confirma que `fee-split.ts` (SIN cambios de código) hereda el fix sin drift en Kite. |

**No-regresión pasiva (obligatorio)**: los tests preexistentes de los 3 archivos que
NO declaran `supportedTokens` deben seguir verdes byte-idénticos tras el fix (caen a
fallback 18d). **NO borrar, NO relajar** esos tests — son evidencia pasiva de CD-2/CD-4.

**Verificación de wave**: `./node_modules/.bin/vitest run` suite completa verde
(incl. las ~2963+ preexistentes, sin regresión) + `tsc --noEmit` + `biome`.

**Serialización**: W0 y W1 son independientes (archivos distintos), ambos dependen
solo del contrato ya existente de `usdToAtomic`. W2 depende de W0+W1. Orden sugerido: W0 → W1 → W2.

---

## 5. Patrones a seguir (exemplars verificados)

| Patrón | Path:línea (verificado) | Uso |
|---|---|---|
| Helper a reusar (NO re-declarar) | `src/services/payment-intent.ts:158-165` | `import { usdToAtomic } from './payment-intent.js'` (CD-1). |
| Wiring canónico adapter→decimals→usdToAtomic→sign | `src/services/payment-intent.ts:370-382` | Patrón EXACTO a replicar en ambos seams. |
| Tests de convergencia (`legacyWei`, T-1/T-2/T-3) | `src/services/payment-intent.test.ts:1803-1900` | Estructura de los tests de esta HU. |
| Mock `supportedTokens` mutable con `vi.hoisted` | `src/services/payment-intent.test.ts:29-44` | Factory de `vi.mock('../adapters/registry.js')` (CD-6/CD-7). |
| Semántica singleton determinístico del adapter | `src/adapters/registry.ts:185-200` | Justifica que decimals derivados == decimals del sign/settle (DT-2, sin drift). |

---

## 6. Constraint Directives (inline — heredan del SDD/work-item)

- **CD-1**: PROHIBIDO duplicar la fórmula usd→atómico en `fee-charge.ts`/`compose.ts` — OBLIGATORIO `import { usdToAtomic } from './payment-intent.js'` (DRY, un solo choke-point).
- **CD-2**: OBLIGATORIO byte-idéntico en Kite `kite-ozone-testnet` (18d) para AMBOS seams — cualquier drift en el valor firmado/settleado en Kite es **BLOQUEANTE** (piedra angular).
- **CD-3**: PROHIBIDO tocar `payment-intent.ts` (incl. `usdToAtomic`), `fee-split.ts` (código de negocio), `arbiter.ts`, `contracts/`, `escrow-verifier.ts`, `settle-verifier.ts`. Solo se IMPORTA `usdToAtomic`; `fee-split.ts` solo suma cobertura de test.
- **CD-4**: OBLIGATORIO fallback `?? 18` **sin `throw`** cuando `supportedTokens` es vacío/undefined — preserva CD-B de `chargeProtocolFee` (JAMÁS rechaza la promise) y no agrega un modo de fallo en `compose.callAgent`.
- **CD-5**: OBLIGATORIO test de convergencia string-exacta (NO `toBeCloseTo`) para AMBOS seams: ≥3 valores Kite 18d idénticos al legado + ≥1 valor Base 6d DIVERGENTE (`.not.toBe(...)`).
- **CD-6** (Auto-Blindaje 191b/c/g): `vi.fn`/factory reexpuestos con rest param `(..._a: unknown[])`, nunca firma de 0 args → evita `tsc` TS2554/TS2556.
- **CD-7** (Auto-Blindaje 191c): todo símbolo consumido por una factory `vi.mock` (incl. `mockSupportedTokens`) va en `vi.hoisted`.
- **CD-8** (Auto-Blindaje 191b): PROHIBIDO `expect(true).toBe(true)` tautológico. Todo test debe fallar bajo mutación del código bajo prueba. Cross-references a otros tests se verifican con `grep` antes de commitear.
- **CD-9** (Auto-Blindaje 191b): usar `./node_modules/.bin/biome`, NO `npx biome` (no resuelve el ejecutable en este entorno).
- **CD-extra (sin ciclo de import)**: verificar con grep que `payment-intent.ts` no importa `fee-charge.ts`/`compose.ts` antes del primer `tsc`.

---

## 7. Done Definition

- [ ] W0: `feeUsdcToWei` mantiene firma `(feeUsdc: number): string`, deriva decimals del adapter y delega en `usdToAtomic`; JSDoc actualizado. Import agregado.
- [ ] W1: branch `compose.ts:797-825` hoistea `const adapter = getPaymentAdapter()`, deriva decimals, usa `usdToAtomic(agent.priceUsdc, decimals)`, reusa `adapter.sign`. Import agregado. Comentario `:816-818` actualizado.
- [ ] `fee-split.ts`, `payment-intent.ts`, `compose.ts:928`, `compose.ts:906-926`, `fee-charge.ts:393/448/471` — **inalterados** (verificado con `git diff`).
- [ ] W2: tests T1-A..T1-D, T2-A..T2-D, T3 escritos y verdes; mocks migrados a `supportedTokens` mutable con `vi.hoisted`. Convergencia Kite 18d string-exacta (≥3 valores/seam), Base 6d falsificable (`.not.toBe`), fallback sin throw.
- [ ] Suites preexistentes de los 3 archivos siguen verdes byte-idénticas (no-regresión pasiva).
- [ ] `grep -nE "from '\./(fee-charge|compose)" src/services/payment-intent.ts` → 0 coincidencias (sin ciclo).
- [ ] `./node_modules/.bin/tsc --noEmit` → 0 errores.
- [ ] `./node_modules/.bin/biome check` sobre los archivos tocados → limpio.
- [ ] `./node_modules/.bin/vitest run` → suite completa verde, sin regresión.

**El Dev SOLO lee este Story File. Todo lo necesario está acá.**
