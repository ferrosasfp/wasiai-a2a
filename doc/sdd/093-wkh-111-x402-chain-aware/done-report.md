# Report — HU [WKH-111] [BASE-06] x402 payment path chain-aware

## Resumen ejecutivo

Se completó el cableado chain-aware del path x402 inbound del gateway. El único archivo de producción modificado fue `src/middleware/x402.ts`: challenge, verify y settle ahora resuelven el adapter correcto a partir del header `x-payment-chain` (Base Sepolia u otras chains inicializadas), manteniendo byte-compatibilidad con el path default Kite. El epic BASE port queda con el verify/settle onchain Base Sepolia operativo; el tx hash real en Basescan se confirma post-merge con el smoke E2E. Suite final: 1048/1048 tests verdes (1039 baseline + 9 nuevos); build exit 0. Veredicto del pipeline: APROBADO PARA DONE.

## Pipeline ejecutado

- F0: Codebase grounding ejecutado 2026-05-27 — 12 hallazgos verificados con archivo:línea (H1..H12), gap confirmado en `x402.ts`, piezas de soporte preexistentes (`resolveChainKey`, `getPaymentAdapter(chainKey?)`, adapter Base) listas.
- F1: work-item.md generado 2026-05-27 — 5 ACs EARS, 12 Constraint Directives, 5 Decisiones Técnicas (DT-1..DT-5), sizing M/QUALITY justificado.
- F1 gate: HU_APPROVED.
- F2: sdd.md generado — decisiones DT-3 (header = fuente de verdad, payload.network ignorado para ruteo), DT-5 (amount de `adapter.quote()`), refactor sync→async de `buildX402Response`, wiring con exemplar `a2a-key.ts:188-224`.
- F2 gate: SPEC_APPROVED.
- F2.5: story-file.md generado — waves W1/W2/W3, anti-hallucination explícito para ripple async (lección WKH-67/072 W4).
- F3: Implementación en 2 commits (2d90fab feat + 6dcf607 test).
  - W1+W2 (commit 2d90fab): `src/middleware/x402.ts` — resolución `x-payment-chain`, propagación `chainKey` a challenge/verify/settle, 400 CHAIN_NOT_SUPPORTED, refactor `buildX402Response` sync→async, amount de `adapter.quote()`.
  - W3 (commit 6dcf607): 9 tests en `x402.chain-aware.test.ts` + ripple fix en 3 mocks legacy.
  - Archivos prod: 1 (`src/middleware/x402.ts`). Archivos test: 4 (`x402.chain-aware.test.ts` nuevo + 3 extensiones de `vi.mock`).
- AR: APROBADO 2026-05-27 — 0 BLOQUEANTES, 1 MENOR (MNR-1: mismatch `payload.network` sin 400 explícito, decisión documentada DT-3/TD-WKH-111-01, fail-seguro vía adapter).
- CR: APROBADO CON OBSERVACIONES 2026-05-27 — 0 BLOQUEANTES, 2 MENOR (MNR-1: edge-case test `REGISTRY_NOT_INITIALIZED` opcional; MNR-2: doble resolución in-memory heredada del exemplar).
- F4: APROBADO PARA DONE 2026-05-27 — 5/5 ACs PASS con evidencia archivo:línea; facilitator prod `eip155:84532` CLOSED confirmado; AC-2 tx live PENDING post-merge.

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (challenge chain-aware) | PASS | Test T-AC1: `src/middleware/x402.chain-aware.test.ts:135-163` — `statusCode=402`, `network='eip155:84532'`, `asset='0x036CbD53842c5426634e7929541eC2318f3dCF7e'`, `maxAmountRequired='1000000'`. Test T-CD9: `:352-379` — afirma `'1000000'` y `!== '1000000000000000000'`. Producción: `src/middleware/x402.ts:64,68`. |
| AC-2 (verify+settle Base) | PASS (unit) / PENDING-RUNTIME (tx live) | Test T-AC2: `src/middleware/x402.chain-aware.test.ts:167-198` — `statusCode=200`, `payment-response='0xbeef'`, `mockBaseVerify` llamado 1x, `mockBaseSettle` llamado 1x. Producción: `src/middleware/x402.ts:200,235`. Tx onchain real: ejecutar `scripts/smoke-base-sepolia.mjs` post-merge/deploy. |
| AC-3 (cero regresión Kite) | PASS | Tests T-AC3a: `:202-226` (Kite, eip155:2368, `'1000000000000000000'`), T-AC3b: `:230-259`. Suite full: 1048/1048 verde (1039 baseline + 9 nuevos = 0 regresiones). |
| AC-4 (chain no inicializada) | PASS | Tests T-AC4a: `:263-288` (slug `'solana'` no reconocido → 400 `CHAIN_NOT_SUPPORTED`), T-AC4b: `:292-317` (slug `'avalanche-fuji'` reconocido pero no inicializado → 400, lista de chains). Producción: `src/middleware/x402.ts:151-174`. |
| AC-5 (coherencia chainKey) | PASS | Test T-AC5: `:321-348` — `mockGetPaymentAdapter.mock.calls.every(c => c[0] === 'base-sepolia')` = true. Producción: `src/middleware/x402.ts:149` (resolución única), `:181,200,235` (mismo `chainKey`). |

## Hallazgos finales

- BLOQUEANTES: 0 en AR, 0 en CR, 0 en QA.
- MENORs aceptados como deuda técnica:
  - TD-WKH-111-01 (AR MNR-1 / CR MNR-2-equivalent): mismatch `paymentPayload.network` vs `x-payment-chain` no emite 400 explícito. La defensa es indirecta via EIP-712 domain del adapter (fail-seguro: produce `verify.valid=false`). Decisión documentada en SDD §4.3. Reevaluar 400 explícito en HU futura si se quiere UX más clara; sin impacto de seguridad neto.
  - CR MNR-1: no hay test directo para el branch `getDefaultChainKey()→null` (500 `REGISTRY_NOT_INITIALIZED`). Branch defensivo de baja frecuencia. Opcional en backlog.
  - CR MNR-2: doble resolución in-memory (`getAdaptersBundle` + `getPaymentAdapter` internamente). Heredado del exemplar `a2a-key.ts`; micro-optimización no justificada.

## Auto-Blindaje consolidado

### [2026-05-27 13:10] Wave 1 — Ripple effect del refactor sync→async + nueva superficie del registry mock

- **Error**: tras W1, 9 tests legacy rompieron (1039 baseline → 9 fail / 1039 pass). Tres archivos afectados: `src/middleware/x402.passport-shape.test.ts` (4 tests), `src/routes/registries.test.ts` (3 tests), `src/__tests__/e2e/e2e.test.ts` (2 tests).
- **Causa raíz**: `requirePayment` ahora consume `getDefaultChainKey()`, `getAdaptersBundle()` y `getInitializedChainKeys()` del registry. Esos archivos tenían `vi.mock('../adapters/registry.js')` predatando esta HU que solo exportaba `getPaymentAdapter`. Las nuevas funciones devolvían `undefined` → guard `getDefaultChainKey()` null disparaba `REGISTRY_NOT_INITIALIZED` (500) o guard `!bundle` disparaba 400. Exactamente el "ripple effect en async refactor" anticipado en el Story File (lección WKH-67/072 W4).
- **Fix**: extender cada `vi.mock` para exportar `getDefaultChainKey: () => 'kite-ozone-testnet'`, `getAdaptersBundle: () => ({ chainConfig: { chainId: 2368 } })` y `getInitializedChainKeys: () => ['kite-ozone-testnet']`. Reproduce el path default (sin header → Kite) byte-idéntico. NO se tocó código de producción (CD-1 intacto).
- **Aplicar en**: cualquier HU futura que agregue funciones al registry consumidas por un middleware compartido. Antes de mergear, ejecutar `grep -rn "vi.mock('.*adapters/registry" src/` y verificar que TODOS los mocks exporten la nueva función. Un mock incompleto devuelve `undefined` silencioso y rompe el guard fail-loud. Resultado final: 1048 tests verdes.

### [2026-05-27 13:08] Wave 0 — `tsc --noEmit` pelado reporta TS6059 (rootDir) preexistente

- **Error**: `tsc --noEmit` reporta TS6059 sobre `test/fixtures/passport-shape.ts` ("not under rootDir './src'").
- **Causa raíz**: condición de baseline del repo, no regresión de esta HU. El tsconfig por defecto incluye `src/**/*` con `rootDir: ./src`, pero tests preexistentes importan fixtures desde `test/fixtures/` (fuera de rootDir).
- **Fix**: usar `tsc -p tsconfig.build.json --noEmit` como verificación de typecheck de producción. El typecheck autoritativo de producción excluye archivos de test y pasa limpio antes y después de la HU.
- **Aplicar en**: en este repo, el typecheck de CI y pre-merge usa siempre `tsconfig.build.json`. El `tsc --noEmit` pelado mezcla tests + rootDir y produce ruido TS6059 preexistente no accionable a nivel HU.

### CD-DEC-01 dimensional (heredada de WKH-67/072)

- **Lección heredada**: el fallback amount hardcodeado `'1000000000000000000'` (1e18, Kite 18-dec) nunca debe transferirse literalmente a otra chain con decimales distintos (Base USDC = 6-dec). La fuente del amount por chain debe ser siempre `adapter.quote()` del adapter seleccionado, no un literal de otra chain.
- **Aplicado en esta HU**: `DEFAULT_AMOUNT_USD = 1` pasado a `adapter.quote()` que devuelve el `amountWei` correcto por chain (Base: `'1000000'`; Kite: `'1000000000000000000'`). Literal `1e18` eliminado del fallback de `x402.ts`. Test T-CD9 lo blinda.

## Archivos modificados

**Produccion (1 archivo):**
- `src/middleware/x402.ts` — chain-aware wiring: resolución `x-payment-chain`, propagación `chainKey` a `buildX402Response`/`verify`/`settle`, 400 `CHAIN_NOT_SUPPORTED`, refactor `buildX402Response` sync→async, amount desde `adapter.quote()`.

**Tests (4 archivos):**
- `src/middleware/x402.chain-aware.test.ts` — nuevo, 9 tests (T-AC1..T-AC5, T-AC3a/b, T-AC4a/b, T-CD9, T-OPTS-AMOUNT).
- `src/__tests__/e2e/setup.ts` — extensión de `vi.mock` registry (ripple fix: +3 funciones → default Kite).
- `src/middleware/x402.passport-shape.test.ts` — extensión de `vi.mock` registry (ripple fix).
- `src/routes/registries.test.ts` — extensión de `vi.mock` registry (ripple fix).

**Docs (1 archivo):**
- `doc/sdd/093-wkh-111-x402-chain-aware/auto-blindaje.md` — registro de ripple effect y TS6059.

## Decisiones diferidas a backlog

- **TD-WKH-111-01** — 400 explícito por mismatch `paymentPayload.network` vs `x-payment-chain` header: la defensa actual es indirecta (fail-seguro EIP-712). Reevaluar UX más clara en HU futura si el escenario de mismatch se vuelve frecuente.
- **BASE-07 (candidata)** — outbound downstream chain-aware (`src/lib/downstream-payment.ts`): hardcode `avalanche-mainnet`/`avalanche-fuji` explícito en líneas 38, 57-58, 113, 457-467. Desbloqueable ahora que el inbound Base está operativo. Scope independiente (no comparte archivos con esta HU).
- **CR MNR-1 (backlog opcional)** — test directo para branch `getDefaultChainKey()→null` (500 `REGISTRY_NOT_INITIALIZED`).

## Pendiente post-merge (no bloquea DONE)

Tras merge de `feat/093-wkh-111-x402-chain-aware` a main y deploy a prod (Railway), correr:

```
node scripts/smoke-base-sepolia.mjs
```

Esto cierra:
- AC-2 tx live (tx hash verificable en Basescan).
- "Run 4" del epic BASE port — primer settle onchain verificado en Base Sepolia con el path chain-aware.

El facilitator de prod ya confirma `eip155:84532` con `breakerState: CLOSED` (evidencia QA F4).

## Lecciones para proximas HUs

1. **Ripple de mocks en refactor sync→async**: cuando un middleware compartido (`x402.ts`, `a2a-key.ts`) consume funciones nuevas del registry, todos los `vi.mock` de ese middleware en archivos legacy deben extenderse. Protocolo: `grep -rn "vi.mock('.*adapters/registry" src/` antes de la PR review.
2. **Typecheck autoritativo**: en este repo, `tsc -p tsconfig.build.json --noEmit` es el gate; el `tsc --noEmit` pelado mezcla rootDir con fixtures de test y produce ruido TS6059 preexistente no accionable.
3. **Amount dimensional por chain**: nunca copiar el literal amount de otra chain. El patrón canonico es `adapter.quote(DEFAULT_AMOUNT_USD).amountWei`, donde el adapter seleccionado por `chainKey` devuelve el valor correcto en los decimales de su token (6-dec USDC para Base; 18-dec KXUSD para Kite).
4. **Fuente de verdad en conciliacion header vs payload**: en un flujo multi-chain inbound, el header de la request (`x-payment-chain`) es la fuente de verdad para seleccionar el adapter/bundle. El `network` del payload del cliente no elige adapter; si miente, el EIP-712 domain del adapter correcto produce `verify.valid=false` (fail-seguro sin 400 explícito). Documentar siempre en SDD si esta eleccion es intencional (TD-WKH-111-01).

## Commits

| Hash | Tipo | Descripcion |
|------|------|-------------|
| `2d90fab` | feat | chain-aware x402 inbound path: resolve x-payment-chain header, propagate chainKey to challenge/verify/settle, 400 CHAIN_NOT_SUPPORTED, buildX402Response refactor sync→async, amount from adapter.quote() |
| `6dcf607` | test | 9 chain-aware unit tests (T-AC1..T-AC5) + ripple fix for registry mock extensions in 3 legacy test files |
