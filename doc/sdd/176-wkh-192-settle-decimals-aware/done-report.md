# Done Report — [WKH-192] Seam `settlePaymentIntentOnChain` decimals-aware

**Veredicto**: DONE — Pipeline QUALITY completo, ready para deployar en Railway.

**Fecha**: 2026-07-13

---

## Resumen ejecutivo

Generalización del helper `usdToWei()` (hardcodeado 18 decimales) a `usdToAtomic(usd, decimals)` derivando los decimales REALES del token de la chain desde `PaymentAdapter`. Byte-idéntico en Kite (18d) por construcción; Base (6d) firma el atómico correcto. Desbloquea el hop 2 del two-hop de WKH-191b para la activación en Base (WKH-191d). No flag-gated: es una corrección de correctness del seam auditado (WKH-136); el comportamiento en Kite es exactamente igual al de hoy.

**Entregables**:
- `src/services/payment-intent.ts` — función `usdToAtomic` exportada, wiring en `settlePaymentIntentOnChain` resuelve adapter una vez
- `src/services/payment-intent.test.ts` — tests T-1..T-6 (convergencia, fallback, verify, two-hop, regresión, herencia)
- Cero cambios en adapters, contracts, arbiter, settle-verifier, fee-charge, compose, debit-capture/executor

**Archivos modificados** (scope limpio):
- `src/services/payment-intent.ts` (+19/-9 líneas, :158-165 función nueva, :372-401 wiring)
- `src/services/payment-intent.test.ts` (tests T-1..T-6 + refactor mock a `vi.hoisted` seteable)
- `doc/sdd/_INDEX.md` (fila 176 bookkeeping, cierra en nexus-docs)

---

## Pipeline ejecutado

| Fase | Status | Verificado |
|------|--------|-----------|
| **F0** — Codebase Grounding | COMPLETO | `usdToWei` `:153-157`, call-site único `:364`, adapters agnósticos (`:408`/`:464`), verify independiente, test infra sin `supportedTokens` en mock |
| **F1** — Work Item + ACs EARS | APROBADO | 6 ACs (AC-1..AC-6), constraint directives, tecnicalidad: BigInt puro, una sola resolución de adapter, fallback `?? 18` con `?.` sobre array |
| **F2** — SDD + Decisiones | SPEC_APPROVED | DT-1..DT-6 (corte fix, aritmética, fuente decimals, convergencia, optional-chaining, exportar helper); CD-AB1/AB2/AB3 heredadas |
| **F2.5** — Story File | GENERADO | Waves W0 (producción) + W1 (tests), anti-hallucination checklist, Done Definition |
| **F3** — Implementación | DONE | `usdToAtomic` función pura, wiring en settlePaymentIntentOnChain, tests T-1..T-6 mapeados a ACs |
| **AR** — Adversarial Review | APROBADO | 0 BLOQUEANTE, 1 MENOR (MNR-1: `_INDEX.md` housekeeping, no-bloqueante). Fuzz 200k+ valores, 0 divergencias Kite 18d. Fórmula por construcción. |
| **CR** — Code Review | APROBADO | 0 BLOQUEANTE, 0 MENOR. Fidelidad SDD/Story, tests falsificables (T-4 `.not.toBe` explícito), T-3 cubre undefined+[], T-1/T-2 string exacta no-tautológica. |
| **F4** — Validación QA | APROBADO | 6/6 ACs PASS, tsc 0, vitest 2933 passed / 10 skipped (161 files), biome 0, build exit 0. Scope exacto (2+1 archivos), 9 Scope OUT archivos = 0 drift. |

---

## Acceptance Criteria — Resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** Derivar decimals reales del token, nunca literal 18 | **PASS** | `payment-intent.ts:372-374` — `const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18`. Tests T-2 (unit `usdToAtomic(1.5,6)==='1500000'`), T-4 (seam Base 6d, falsificable `.not.toBe(usdToAtomic(usd,18))`) |
| **AC-2** Kite 18d byte-idéntico al `usdToWei` legacy sin drift en prod | **PASS** | Fórmula `micro * 10n**12n` idéntica a legacy por construcción (mismo `micro`, mismo exponente 12). Test T-1 (4 valores ≥1 con 6 decimales precision) compara string-a-string contra fórmula legacy inline. T-5 via seam completo. AR fuzz 200k+ → 0 divergencias. |
| **AC-3** Fallback 18d sin token, nunca throw | **PASS** | `?.[0]?.decimals ?? 18` dentro del outer `try` (CD-7). Test T-3 cubre `undefined` y `[]`, asserta `status==='settled'` sin throw. |
| **AC-4** `verifyDefaultChainSettle` recibe MISMO atómico corregido, sin segunda derivación | **PASS** | `payment-intent.ts:439` `requiredAmountAtomic: BigInt(wei)`, sin cambios (converge por origen). `settle-verifier.ts` NO tocado (git diff = vacío). Test T-4 asserta `mockVerify.requiredAmountAtomic === BigInt(usdToAtomic(usd,6))` sin divergencia sign↔verify. |
| **AC-5** `settleEscrowAware` hereda fix sin cambios de código, transparente (191b) | **PASS** | Bloque `settleEscrowAware` (`:486-628`) NO aparece en git diff. Test T-6 end-to-end: hop1 mockeado (`debit_amount_atomic = usdToAtomic(3.7,6) = '3700000'`), hop2 firma el mismo atómico (`mockSign.value === atomic6`), convergen. |
| **AC-6** Tests de convergencia Kite ≥3 valores + Base | **PASS** | T-1 (4 valores Kite ≥1 con 6-decimales precision). T-2 (`usdToAtomic(1.5,6)==='1500000'` dura + relación `×10^12` para 5 valores). Ambos string/bigint exacta, no aproximada. |

---

## Hallazgos finales

### No hay BLOQUEANTEs (ALTO/MEDIO/BAJO)

1. **AR Veredicto**: APROBADO. Punto crítico "Kite byte-idéntico" verified por construcción AND empíricamente (200k+ fuzz, 0 divergencias). Nuance de clasificación money-safe documentada (hoist del `getPaymentAdapter()` al outer `try` = inalcanzable en prod, estrictamente más conservador). MNR-1 es housekeeping de `_INDEX.md`, no accionable sobre el código.

2. **CR Veredicto**: APROBADO. Código fiel a SDD/Story, tests falsificables (T-4 con `.not.toBe` explícito), regresión byte-idéntica via suite verde (2933/2943 tests), tsc/biome limpios.

3. **F4 QA Veredicto**: APROBADO. 6/6 ACs PASS, 0 drift, gates ejecutados en vivo (tsc/vitest/biome/build), scope exacto (2 archivos producción + 1 housekeeping), 9 Scope OUT archivos confirmados vacíos.

### Candidatos a follow-up (documentados, no bloqueantes)

- **`src/services/fee-charge.ts`** (`feeUsdcToWei`, `:164-166`): mismo patrón hardcodeado 18d pero es un seam DISTINTO (protocol-fee-wallet transfer, tabla `a2a_protocol_fees`). Si algún día el default-chain del fee protocolario cambia a Base, tendría el MISMO bug. No tocado en esta HU (Scope OUT explícito WKH-192), candidato a HU separada si el fee elige base-*.

- **`src/services/compose.ts`** (`:188-190`): mismo patrón de protocol-fee, misma razón de exclusión.

---

## Impacto en el EPIC WKH-191

**WKH-191d (activación end-to-end del escrow no-custodial)** estaba bloqueada por R-1/MI-1 de WKH-191b: en `default-chain=base-*` (USDC 6d), el hop 2 firmaría 10¹²× el monto → happy-path nunca completa (money-safe, `reconciliation_pending`, pero no-operacional).

**Este fix (WKH-192) desbloquea WKH-191d**: `settlePaymentIntentOnChain` ahora deriva decimals correctos del token, el hop 2 firma el monto correcto en Base, y la cadena de convergencia se cierra (hop1 `debit_amount_atomic` Kite-6d == hop2 atómico firmado 6d == transfer on-chain USDC 6d == re-verificación 6d independiente).

**Nota**: WKH-191a/191b/191c (captura → wiring → reconciliación) YA tienen decimals-aware en el hop 1 (WKH-191a: `debit-capture.ts:162-169` usa `parseUnits(..., decimals)` derivado del bundle). El hop 2 (operador→seller) ahora también lo es con este fix.

---

## Auto-Blindaje consolidado

### De sesiones previas (heredadas, 191a/191b/191c)

| Lección | Categoría | Aplicado aquí |
|---------|-----------|---------------|
| CD-AB1: `./node_modules/.bin/biome check --write` (NO `npx biome`) sobre producción Y tests | Linter | Ejecutado, 0 findings |
| CD-AB2: `vi.hoisted()` para TODO símbolo de factory `vi.mock`, tipar `vi.fn` params/retornos | Testing | Refactor mock a `mockSupportedTokens = vi.hoisted(...)`, tipado explícito (evita TS2554/2556) |
| CD-AB3: Sin `expect(true).toBe(true)`, cada test asserta igualdad EXACTA, cross-refs verificadas con `grep` | Testing | T-1/T-2 string exacta, T-4 falsificable, T-3 cubre ambos undefined+[], no tautología |

### Nuevas de esta HU (WKH-192)

| Lección | Categoría | Para próximas |
|---------|-----------|---------------|
| **DT-2 by Construction**: BigInt puro sin `parseUnits`/`Number.toFixed` garantiza equivalencia byte-idéntica — NO depender de muestreo de floats | Aritmética | Usar en cualquier conversión decimals que requiera regresión exacta. `parseUnits` es correcto para inputs del CLIENTE (firma EIP-712), pero para server-side USD→atomic donde se requiere convergencia garantizada, BigInt es la rama más segura. |
| **DT-3 una Sola Resolución**: reusando `getPaymentAdapter()` UNA vez para decimals+sign+settle elimina toda superficie de drift entre "qué decimals se usaron" y "qué adapter realmente firmó" | Architecture | Critical cuando la fuente del parámetro es el mismo registro/singleton (`bundle.payment`). Dos llamadas separadas a `getPaymentAdapter()` = riesgo de interleaving/inconsistencia. |
| **DT-5 Optional-Chaining Defensivo**: `supportedTokens?.[0]?.decimals ?? 18` con `?.` sobre el array, NO `supportedTokens[0]?.decimals` | Type Safety | Cualquier mock/test que produzca `{ sign, settle }` sin `supportedTokens` se rompe con la forma corta. La forma larga es compatible con undefined/null/[]. Documentar acá. |
| **AC-2 = Piedra Angular**: La equivalencia byte-idéntica en Kite es el gate de cualquier cambio en `payment-intent.ts` → SIEMPRE test de regresión string-exact contra fórmula legacy, SIEMPRE considerando 6+ decimales de precisión | Testing | Si alguien toca `usdToWei`/`usdToAtomic` de nuevo (migraciones, optimizaciones), test-first de AC-2. Un dígito de drift = pedir re-auditoría/revert. |

---

## Lecciones para próximas HUs

1. **Hardcodes de cadena (decimals, valores por defecto, paths moneda) son vectores de bug cuando se soportan múltiples chains**. Esta HU expuso que `usdToWei` era un hardcode latente invisible bajo la suposición "default chain = siempre Kite". El grounding de nuevo debe incluir: "¿este parámetro es chain-dependent?". Si sí, derivarlo (DT-3 one-shot), jamás hardcodearlo.

2. **Optional-chaining en cascada (`?.`) es defensivo pero también puede ser tácito**. El `supportedTokens?.[0]?.decimals` es correcto, pero un desarrollo futuro podría escribir `supportedTokens[0]?.decimals` confiando en que la cadena es "suficientemente null-safe" porque hay un `?.` al final. Documentar la cadena completa en el JSDoc, no confiar en la forma corta.

3. **Convergencia multi-punto (hop1 ← → hop2 ← → settle ← → verify) requiere una sola fuente de verdad para el parámetro de conversión**. En WKH-191b (two-hop), el hop 1 usaba `parseUnits(..., decimals)`, el hop 2 (este fix) usaba `usdToWei(usd)` (hardcode 18), el verify usaba su propia derivación de decimals — tres caminos, ninguno converge. La solución no fue hacer que todos usen `parseUnits` (interfiere con byte-idéntico), sino que TODOS deriven de la MISMA resolución de registry (`bundle.payment.supportedTokens[0]`). Patrón a repetir.

4. **Auto-Blindaje biome/vitest/TypeScript no es suficiente — requiere adversarial attack específico del dominio**. El AR de esta HU corrió fuzz de 200k+ valores porque la sospecha era "¿el redondeo float64 podría introducir drift?". Tests verdes != certeza. El adversary debe preguntar "¿cuáles son los casos donde un error aquí cuesta dinero?" (respuesta: hop 2 en Base) y diseñar el ataque alrededor de eso.

---

## Decisiones diferidas a backlog

Ninguna. El trabajo de WKH-192 es completo y está ready para deployar en Railway.

La activación end-to-end de WKH-191d (cambiar `default-chain` a Base, activar `ESCROW_SETTLE_ENABLED`) queda diferida al orquestador + deployment operacional (Railway env vars, base de datos).

---

## Cierre

- ✅ **tsc --noEmit**: 0 errores
- ✅ **vitest run**: 2933 passed / 10 skipped (161 files)
- ✅ **biome check**: 0 findings (src + test)
- ✅ **npm run build**: exit 0
- ✅ **Scope**: exacto (2 archivos src + 1 index bookkeeping; 9 Scope OUT archivos = 0 drift)
- ✅ **Todas las ACs PASS**: 6/6
- ✅ **Convergencia byte-idéntica Kite**: verificada por construcción + empíricamente (200k+ fuzz)
- ✅ **Regresión de código preexistente**: suite completa verde

**Estado: LISTO PARA MERGEAR → RAILWAY DEPLOY → WKH-191d ACTIVACIÓN**
