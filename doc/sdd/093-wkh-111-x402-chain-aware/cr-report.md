# Code Review (CR) — Adversary — #093 [WKH-111] [BASE-06] x402 payment path chain-aware

> Reviewer: nexus-adversary (CR mode)
> Fecha: 2026-05-27
> Branch revisada: feat/093-wkh-111-x402-chain-aware (commits 2d90fab, 6dcf607)
> Diff base: main..feat/093-wkh-111-x402-chain-aware
> Alcance: calidad/patrones de código (CR). Findings de security/integrity → AR.

---

## 1. Tabla de hallazgos

| ID | Severidad | Categoría | Observación | Evidencia (archivo:línea) | Sugerencia |
|----|-----------|-----------|-------------|---------------------------|------------|
| OK-1 | OK | CD-1 byte-compat Kite | Path sin `x-payment-chain`: `getPaymentAdapter(chainKey)` con `chainKey` default = `kite-ozone-testnet`; amount fallback = `(await adapter.quote(1)).amountWei` y el `quote()` de Kite devuelve **exactamente** `'1000000000000000000'` (literal legacy). Byte-idéntico. Test T-AC3a lo afirma. | `src/middleware/x402.ts:67-68`; `src/adapters/kite-ozone/payment.ts:330-337`; `src/middleware/x402.chain-aware.test.ts:219-222` | — |
| OK-2 | OK | CD-3 sin any/as unknown + ChainKey | `grep "any\|as unknown"` en x402.ts → 0 matches en producción. `chainKey` tipado como `ChainKey` (no `string`) en firma y propagación. | `src/middleware/x402.ts:18,61`; grep prod = 0 | — |
| OK-3 | OK | CD-4 sin hardcodes de Base | No hay addresses/chainIds/decimales/network-tags de Base en x402.ts. Todo viene de `getPaymentAdapter(chainKey)` (`getNetwork/getToken/getMaxTimeoutSeconds/quote`). Único literal nuevo: `DEFAULT_AMOUNT_USD = 1` (arg de quote, documentado). | `src/middleware/x402.ts:56,64-83` | — |
| OK-4 | OK | CD-7 resolver puro | Usa `resolveChainKey({ headerOverride })` de chain-resolver.js. No hay tabla de aliases inline ni `if (header === 'base-sepolia')`. | `src/middleware/x402.ts:11,149` | — |
| OK-5 | OK | CD-8 no toca Out-of-Scope | `git diff --stat` no incluye `a2a-key.ts`, `registry.ts`, `chain-resolver.ts`, adapters, ni `smoke-base-sepolia.mjs`. Solo x402.ts + tests. | `git diff --name-only` | — |
| OK-6 | OK | CD-9 amount dimensional | `grep "1000000000000000000"` en x402.ts → 0 matches (literal eliminado del fallback). Fallback = `adapter.quote(...).amountWei`. T-CD9 afirma Base=`'1000000'` y `!== '1000000000000000000'`. | `src/middleware/x402.ts:67-68`; test `:352-379` | — |
| OK-7 | OK | CD-10 orden de resolución | Resolución del chainKey ocurre tras `paymentOrigin`/`resource` (:136-137) y **antes** de leer `payment-signature` (:177). El challenge sin signature ya es chain-aware. | `src/middleware/x402.ts:139-177` | — |
| OK-8 | OK | CD-11 solo headers | El resolver lee `request.headers['x-payment-chain']`. No hay acceso a `request.body` para inferir chain. | `src/middleware/x402.ts:144` | — |
| OK-9 | OK | Refactor sync→async correcto | Los 6 call-sites de `buildX402Response` están todos con `await` dentro del `.send(...)`. No quedó ninguno sync. `buildX402Response` es la única productora y es `async`; único consumidor es `requirePayment` (handler async). | `src/middleware/x402.ts:181,190,213,226,246,259`; grep call-sites = 6 awaited | — |
| OK-10 | OK | reply.sent bien manejado | Guards `if (reply.sent) return;` preservados antes de cada `reply.send` post-await (verify/settle catch + post-await). Patrón intacto vs main. | `src/middleware/x402.ts:208,221,241,254,268` | — |
| OK-11 | OK | Wiring fiel al exemplar | El bloque de resolución + 400 replica `a2a-key.ts:188-224` verbatim (sin budget/debit). Mismo error_code, mismo mensaje, mismo shape del 400, mismo orden de guards. DRY: no duplica la tabla de aliases (delega a resolveChainKey). | `src/middleware/x402.ts:144-175` vs `src/middleware/a2a-key.ts:188-224` | — |
| OK-12 | OK | Cobertura de tests | 9 tests cubren AC-1 (T-AC1,T-CD9), AC-2 (T-AC2), AC-3 (T-AC3a,T-AC3b), AC-4 (T-AC4a,T-AC4b), AC-5 (T-AC5) + override (T-OPTS-AMOUNT). Asserts concretos (statusCode + network + asset + maxAmountRequired + spies). `resolveChainKey` se deja REAL → ejercita el alias real. No hay asserts vacíos. | `src/middleware/x402.chain-aware.test.ts:112-433` | — |
| OK-13 | OK | Ripple fix de mocks legítimo | Los 3 test-mock files extendidos solo agregan `getDefaultChainKey/getAdaptersBundle/getInitializedChainKeys` retornando el default Kite. Reproduce el path default byte-idéntico (no oculta regresión real): registries.test.ts sigue afirmando `[401,402,403]` (auth required), no un 500 enmascarado. | `src/__tests__/e2e/setup.ts:172-176`; `src/middleware/x402.passport-shape.test.ts:36-42`; `src/routes/registries.test.ts:76-80`; assert auth en `registries.test.ts:133,143,154` | — |
| OK-14 | OK | Legibilidad/mantenibilidad | Comentarios citan los CD relevantes (CD-5/6/10/11). `DEFAULT_AMOUNT_USD` documentado con JSDoc explicando que NO es wei. Naming consistente con a2a-key.ts (`headerRaw`/`headerOverride`/`chainKey`/`bundle`). | `src/middleware/x402.ts:51-56,139-143` | — |
| MNR-1 | MENOR | Test coverage (edge) | El mensaje del 400 "not initialized" (T-AC4b) usa `avalanche-fuji`, que `resolveChainKey` SÍ reconoce como slug válido pero `getAdaptersBundle` mock devuelve undefined. Correcto. No hay test que cubra el branch `getDefaultChainKey()` null → 500 `REGISTRY_NOT_INITIALIZED` (`x402.ts:160-164`). Es un branch defensivo de baja frecuencia. No bloquea. | `src/middleware/x402.ts:160-164` (sin test directo) | Opcional: agregar 1 test que mockee `getDefaultChainKey()→null` sin header y afirme 500. Backlog. |
| MNR-2 | MENOR | Mantenibilidad (deuda conocida) | El `bundle` resuelto (`x402.ts:168`) solo se usa para el guard `if (!bundle)`; el `chainKey` ya basta para `getPaymentAdapter(chainKey)`. Hay una doble resolución implícita (getAdaptersBundle + getPaymentAdapter resuelven el bundle internamente dos veces). Es el patrón del exemplar a2a-key.ts y no afecta correctitud ni perf (in-memory). Documentado como aceptable. | `src/middleware/x402.ts:168-175,200,235` | Sin acción. Coherente con exemplar; micro-optimización no justificada. |

**Conteo**: 0 BLOQUEANTES, 0 MED, 0 LOW, 2 MENOR, 14 OK.

---

## 2. Resultado de gates

| Gate | Comando | Resultado |
|------|---------|-----------|
| Build | `npm run build` (`tsc -p tsconfig.build.json` + copy static) | **exit 0** — limpio |
| Tests | `npm test` (vitest run) | **1048 passed (1048)** en 72 test files — 0 fallos. Coincide con baseline 1039 + 9 nuevos. |

> Nota: `tsc --noEmit` pelado reporta TS6059 (rootDir) preexistente sobre fixtures de test — documentado en auto-blindaje, NO es regresión de esta HU. El typecheck autoritativo de producción es `tsconfig.build.json`, que pasa limpio.

---

## 3. Veredicto

**APROBADO CON OBSERVACIONES** — 0 BLOQUEANTES.

Las 2 observaciones son MENORes (edge-case test opcional + deuda de patrón heredada del exemplar), no bloquean DONE. El gate binario pasa: cero findings BLOQUEANTE/MED/LOW.

---

## 4. Resumen al orquestador

CR de WKH-111 (x402 chain-aware) completado sobre `src/middleware/x402.ts` + el test nuevo + 3 ripple-fix de mocks. Los 11 puntos del checklist verifican OK con evidencia archivo:línea: byte-compat Kite (CD-1) confirmada porque `quote()` de Kite devuelve exactamente el literal legacy `'1000000000000000000'`; CD-3 (sin any/as unknown, `chainKey: ChainKey`), CD-4/CD-9 (cero hardcodes de Base, literal 1e18 eliminado del fallback), CD-7/CD-10/CD-11 todos cumplidos; el wiring replica fielmente `a2a-key.ts:188-224`. El refactor sync→async está completo: los 6 call-sites de `buildX402Response` están awaited y los guards `reply.sent` preservados. Los 9 tests cubren AC-1..AC-5 + guard dimensional + override con asserts concretos (no vacíos) y dejan `resolveChainKey` real. Los 3 ripple-fix de mocks son legítimos (extienden la superficie del registry al default Kite) y NO ocultan regresión: registries.test.ts sigue afirmando auth `[401,402,403]`. Gates: `npm test` 1048/1048 verdes, `npm run build` exit 0. Veredicto: **APROBADO CON OBSERVACIONES** (2 MENOR, 0 BLOQUEANTES). Listo para F4 (QA).
