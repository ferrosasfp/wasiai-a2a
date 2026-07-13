# Report — HU [WKH-195] Fee-charge + compose decimals-aware (cierre del hardcode ×1e12 gemelo de WKH-192)

## Resumen ejecutivo

Cierre de la gemela de WKH-192: dos seams (`feeUsdcToWei` en `fee-charge.ts:164-166` + pago inbound x402 inline en `compose.ts:819-821`) que escalaban USD→atómico con el hardcode `× 1e12` (asume 18 decimales). La HU aplicó el patrón ya auditado de WKH-192 a ambos seams, reusando `usdToAtomic` (DRY), byte-idéntico en Kite 18d por construcción, con fallback `?? 18` sin throw. Firma pública de `feeUsdcToWei` mantenida → `fee-split.ts` hereda sin cambio de código (AC-6). Pipeline QUALITY completo (F0→F1→F2→F2.5→F3→AR→CR→F4): tsc 0, 2972 tests verdes, biome limpio, 6/6 ACs PASS, 0 BLQ, 0 MENOR. Byte-idéntico verificado en Kite; Base 6d probado como divergente (falsificable). **DONE**.

---

## Pipeline ejecutado

- **F0** (Analyst): project-context + grounding file:línea confirmado (payment-intent.ts:158-165, fee-charge.ts:164-166/393/448/471, compose.ts:816-825/928, adapters/registry.ts:185-200) — Sin ciclo de imports.
- **F1** (Analyst): `work-item.md` (6 ACs EARS, 8 CDrs, 6 DTrs, Scope IN/OUT explícito, grounding verificado) — **HU_APPROVED** (2026-07-13).
- **F2** (Architect): `sdd.md` (Context Map, DT-1..DT-5, CD-1..CD-9, 4 waves seriales, plan de tests ≥1 por AC, exemplars) — **SPEC_APPROVED** (2026-07-13).
- **F2.5** (Architect): `story-HU-195.md` (contrato del dev, checklist anti-hallucination, waves con archivos exactos, AC-1..AC-6).
- **F3** (Dev): Implementación W0/W1/W2 en 5 archivos exactos:
  - `src/services/fee-charge.ts` — reescribir `feeUsdcToWei(feeUsdc)` (σ:172-178): resolver adapter, derivar decimals `adapter.supportedTokens?.[0]?.decimals ?? 18`, delegar en `usdToAtomic(feeUsdc, decimals)`. Firma pública mantenida.
  - `src/services/compose.ts` — hoist adapter + reemplazar `valueWei` (σ:823-829): misma derivación decimals, usar `usdToAtomic(agent.priceUsdc, decimals)` antes de `adapter.sign()`. Settle de `:932` inalterado (mismo singleton determinístico).
  - `src/services/fee-charge.test.ts` — migrar mock a `supportedTokens` mutable (`vi.hoisted`), agregar tests T1-A..T1-D (convergencia Kite 18d + Base 6d + fallback + leg plataforma).
  - `src/services/compose.test.ts` — idem, tests T2-A..T2-D (convergencia + fallback + settle).
  - `src/services/fee-split.test.ts` — agregar test de regresión AC-6 (T3): `settleFeeSplits` hereda sin cambio de código.
  - Imports: `import { usdToAtomic } from './payment-intent.js'` en fee-charge.ts:41 y compose.ts:43.
- **AR** (Adversary): Byte-identidad Kite verificada (T1-A/T2-A/T3 string-exacta), fee-split no se rompe (código inalterado, herencia verificada), decimals del adapter correcto (sin drift, singleton determinístico), compose settle/chainKey intactos, fallback sin throw, 5 rutas exactas tocadas, **0 BLQ, 0 MENOR**. Gates: tsc 0, vitest 2972/2982 (9 nuevos), biome 0.
- **CR** (Adversary/QA): Fidelidad Story File 100%, 9 tests no-tautológicos (falsificables bajo mutación), convergencia Kite string-exacta (`[1.5, 0.333333, 100, 0.000001]`), Base 6d divergente probado, fallback definido, tests refactor `vi.hoisted` sólido (rest param `(..._a: unknown[])` evita TS2554/TS2556), **0 BLQ, 0 MENOR**. tsc 0, biome limpio.
- **F4** (QA): 6/6 ACs PASS (AC-1..AC-6). Verificación manual de gates (tsc/vitest/biome), drift análisis (5 rutas exactas, Scope OUT intacto), no-regresión (2963+ preexistentes verdes byte-idénticas). **APROBADO PARA DONE**.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `fee-charge.ts:172-178` — `feeUsdcToWei(feeUsdc)` resuelve `getPaymentAdapter()`, deriva `decimals = adapter.supportedTokens?.[0]?.decimals ?? 18`, delega en `usdToAtomic(feeUsdc, decimals)`. Test convergencia: `fee-charge.test.ts:T1-A` (Kite 18d byte-idéntico para `[1.5, 0.333333, 100, 0.000001]`). |
| AC-2 | PASS | `compose.ts:823-829` — hoistea `const adapter = getPaymentAdapter()`, deriva `decimals`, firma con `usdToAtomic(agent.priceUsdc, decimals)` en `adapter.sign({...})`. Test convergencia: `compose.test.ts:T2-A` (Kite 18d para 4 precios). |
| AC-3 | PASS | Byte-identidad Kite 18d verificada por construcción: `usdToAtomic(usd,18)` = `micro * 10n**12n` = `BigInt(Math.round(usd*1e6)) * BigInt(1e12)` exacto en float64. Confirmado por `.toBe` string-exacto en T1-A/T2-A (no aproximado). |
| AC-4 | PASS | `fee-charge.ts:174` y `compose.ts:824` — `?.[0]?.decimals ?? 18` sin throw nuevo. Tests `T1-C`/`T2-C` (loop `[undefined, []]` → no-throw + valor legacy). Preserva `chargeProtocolFee` never-reject + `compose.callAgent` sin modo de fallo nuevo. |
| AC-5 | PASS | `import { usdToAtomic } from './payment-intent.js'` en fee-charge.ts:41 y compose.ts:43. Grep fórmula BigInt duplicada → 0 coincidencias en ambos seams. Único choke-point: `payment-intent.ts:158-165`. Sin ciclo: `grep` en payment-intent.ts para imports de fee-charge/compose → 0. |
| AC-6 | PASS | `git diff HEAD -- src/services/fee-split.ts` → **0 líneas** (código sin tocar). `fee-split.ts:32` sigue importando `feeUsdcToWei` sin cambios. Test regresión `fee-split.test.ts:T3` — ejercita `settleFeeSplits` real con config default (10000/0/0), asserta `signArg.value === feeUsdcToWei(amount) === legacyWei(amount)` en Kite 18d. PASS. |

---

## Hallazgos finales

**BLOQUEANTEs**: Ninguno. AR y CR reportaron 0 BLQ.

**MENORs**: Ninguno. AR y CR reportaron 0 MENOR.

**Lecciones del Auto-Blindaje incorporadas (CD-6..CD-9)**:
- CD-6: Mocks `vi.fn` tipados con rest param `(..._a: unknown[])` evita TS2554/TS2556. Implementado en fee-charge.test.ts, compose.test.ts, fee-split.test.ts.
- CD-7: Símbolos consumidos por `vi.mock` factory (incl. `mockSupportedTokens`) van en `vi.hoisted` — reutilización directa del patrón `payment-intent.test.ts`.
- CD-8: Tests falsificables bajo mutación (string-exacta `.toBe`, `.not.toBe`, cross-check invariantes). No tautológicos (`expect(true).toBe(true)` prohibido).
- CD-9: Uso de `./node_modules/.bin/biome` en lugar de `npx biome`.

---

## Auto-Blindaje consolidado

(Heredado de WKH-192, actualizado para WKH-195)

| Aspecto | Descubrimiento | Acción / Resolución | Estado |
|---------|---|---|---|
| Hardcode 18d — `× 1e12` en 3+ seams | WKH-192 corrigió `settlePaymentIntentOnChain`; WKH-195 corrige los 2 seams gemelos (`fee-charge`/`compose`) | Patrón `usdToAtomic(usd, decimals)` reutilizado; fallback `?? 18` sin throw | DONE |
| Byte-identidad en Kite verificada | Mismo `micro * 10n**12n` que legado; string-exacta no aproximada | T1-A/T2-A/T3 con múltiples valores; test suite 2972/2982 verde | DONE |
| Fee-split herencia transitiva | Cambio de firma de `feeUsdcToWei` podría romper `fee-split.ts:32` | Firma mantenida, decimals derivados dentro → `fee-split.ts` intacto, AC-6 verificado | DONE |
| Drift de adapter entre decimals y sign/settle | Tres resoluciones nominales de `getPaymentAdapter()` en seams distintos | Singleton determinístico de `registry.ts:185-200` garantiza MISMA instancia; DT-2/DT-3 documentan el razonamiento | DONE |
| Fallback `supportedTokens undefined/[]` | Preservar `chargeProtocolFee` never-reject y `compose.callAgent` sin modo de fallo nuevo | `?? 18` sin throw; T1-C/T2-C verifican comportamiento | DONE |
| Ciclo de imports no introducido | `payment-intent.ts` → fee-charge/compose OK; inverso verificado = 0 | Grep precomit confirmado | DONE |
| Tests no-tautológicos | Mutación bajo `.toBe` string-exacta vs `.not.toBe` Base | 9 nuevos tests (T1-A..D, T2-A..D, T3) falsificables; grep confirma referencias | DONE |
| Mock `vi.fn` tipado con rest param | TS2554/TS2556 en factory hoisted si falta tipado | Patrón `(..._a: unknown[])` replicado de payment-intent.test.ts | DONE |
| Simbolo `mockSupportedTokens` en `vi.hoisted` | `vi.mock` es hoisted; un `const` top-level normal es `undefined` al mock | `vi.hoisted(() => ({ current: [...] }))` consumido en factory | DONE |
| Biome check con `./node_modules/.bin/biome` | `npx biome` no resuelve en este entorno | Usado `./node_modules/.bin/biome check` en verificación | DONE |

---

## Archivos modificados

### Implementación (5 archivos)

1. **src/services/fee-charge.ts**
   - `:41` → agregar `import { usdToAtomic } from './payment-intent.js';`
   - `:156-178` → reescribir `feeUsdcToWei(feeUsdc: number): string` con JSDoc actualizado, resolver adapter, derivar decimals, delegar en `usdToAtomic`.

2. **src/services/compose.ts**
   - `:43` → agregar `import { usdToAtomic } from './payment-intent.js';`
   - `:817-829` → actualizar comentario MONEY-PATH, hoist adapter, derivar decimals, reemplazar `valueWei` por `usdToAtomic(agent.priceUsdc, decimals)`, usar `adapter.sign()`.

3. **src/services/fee-charge.test.ts**
   - `:29-33` → migrar mock a `mockSupportedTokens = vi.hoisted(() => ({ current: [{decimals:18, symbol:'PYUSD'}] }))`.
   - Agregar bloque describe `describe('WKH-195 fee-charge decimals-aware', () => { ... })` con tests T1-A..T1-D.

4. **src/services/compose.test.ts**
   - `:46-50` → migrar mock a `mockSupportedTokens` mutable.
   - Agregar bloque describe `describe('WKH-195 compose inbound decimals-aware', () => { ... })` con tests T2-A..T2-D.

5. **src/services/fee-split.test.ts**
   - `:34-38` → migrar mock a `mockSupportedTokens` mutable (herencia del patrón).
   - Agregar test T3 de regresión (`settleFeeSplits` con config default, verifica AC-6).

### Documentación

- `doc/sdd/179-wkh-195-fee-compose-decimals-aware/work-item.md` → inmutable (input de F0).
- `doc/sdd/179-wkh-195-fee-compose-decimals-aware/sdd.md` → inmutable (SPEC_APPROVED).
- `doc/sdd/179-wkh-195-fee-compose-decimals-aware/story-HU-195.md` → inmutable (contrato F3).
- `doc/sdd/179-wkh-195-fee-compose-decimals-aware/ar-report.md` → inmutable (AR veredicto).
- `doc/sdd/179-wkh-195-fee-compose-decimals-aware/cr-report.md` → inmutable (CR veredicto).
- `doc/sdd/179-wkh-195-fee-compose-decimals-aware/f4-report.md` → inmutable (F4 veredicto).
- `doc/sdd/179-wkh-195-fee-compose-decimals-aware/done-report.md` → esta fila (DONE).

---

## Decisiones diferidas a backlog

Ninguna. Esta HU cierra completamente el hardcode ×1e12 gemelo de WKH-192. No hay spinoffs abiertos.

---

## Lecciones para próximas HUs

1. **Reutilización de patrones auditados** — La HU WKH-192 ya había resuelto y auditado la conversión decimals-aware; WKH-195 reutilizó el MISMO patrón (`usdToAtomic`, fallback `?? 18`, singleton determinístico) en dos seams distintos SIN reabrir el análisis técnico. El Auto-Blindaje documentó el razonamiento, facilitando la réplica. Lección: cuando dos seams comparten el MISMO bug y el mismo patrón de fix es auditado, la gem de replicación es mínima si se mantienen invariantes (firma pública, DRY en choke-point, tests falsificables).

2. **Herencia transitiva por firma invariante** — Cambiar una firma pública `feeUsdcToWei(x)` obligaría a tocar `fee-split.ts` (3+ líneas de código). La decisión F2 de derivar decimals DENTRO de `feeUsdcToWei` (vs. pasar como parámetro) permitió que `fee-split.ts` heredara el fix sin toque. Lección: evaluar siempre si una función auxiliar puede absorber la complejidad (opcionales, lookups determinísticos) antes de ampliar su contrato.

3. **Singleton determinístico como fundamento** — `getPaymentAdapter()` sin `chainKey` devuelve SIEMPRE la misma instancia del default-chain. Esto garantizó que los decimals derivados fueran idénticos a los del adapter que firma/settlea, sin necesidad de pasar la instancia como parámetro (DRY en resolución, no en cada call-site). Lección: documentar el determinismo de los singletons para justificar decisiones de arquitectura que parecen "3 llamadas distintas".

4. **Fallback defensivo sin silenciar errores reales** — `?? 18` es un fallback solo cuando `supportedTokens` no existe; si un adapter NO tiene tokens soportados de verdad, eso es un error de configuración que el resto del pipeline va a revelar de todas formas (sign/settle fallarán o comportamiento incorrecto). El fallback es una defensa contra `undefined`/`[]` (casos patológicos), no una "segunda oportunidad" para ignorar un bug. Lección: fallbacks defensivos son OK si el código downstream sigue detectando errores reales; diferente de silenciar exceptions activamente.

---

## Gates finales

| Gate | Resultado | Evidencia |
|------|-----------|-----------|
| `./node_modules/.bin/tsc --noEmit` | ✅ exit 0, 0 errores | Corrido por QA, re-verificado. |
| `./node_modules/.bin/vitest run` | ✅ 2972 passed / 10 skipped (2982 total) | +9 nuevos (T1-A..D, T2-A..D, T3), 0 regresiones. |
| `./node_modules/.bin/biome check src/` | ✅ 323 files checked, 0 fixes | Limpio. |
| `npm run build` | ✅ exit 0, sin errores | tsc -p tsconfig.build.json OK. |
| Byte-identidad Kite 18d | ✅ Verificada por construcción + tests string-exacta | T1-A/T2-A/T3 con múltiples valores. |
| Convergencia Base 6d (falsificable) | ✅ `.not.toBe(legacyWei)` + invariante `×10^12` | T1-B/T2-B probadas. |
| Fallback `supportedTokens undefined/[]` | ✅ Sin throw, valor byte-idéntico legacy | T1-C/T2-C probadas. |
| Regresión AC-6 (`fee-split` sin cambio) | ✅ `git diff HEAD -- src/services/fee-split.ts` = 0 líneas de código | Código intacto, solo test agregado. |

**Veredicto: APROBADO PARA DONE. Pipeline QUALITY completo. Listos para merge a main y deploy Railway.**

---

## Referencias

- **WKH-192 (fila 176)** — Seam `settlePaymentIntentOnChain` decimals-aware (predecesor directo).
- **WKH-192 done-report** — Documentó explícitamente los 2 seams gemelos como Scope OUT y candidatos a follow-up.
- **payment-intent.test.ts:1803-1900** — Exemplar de tests de convergencia (WKH-192), usado como template.
- **DT-2 de WKH-192** — "Una sola resolución de adapter" — reutilizado en DT-2/DT-3 de esta HU.

