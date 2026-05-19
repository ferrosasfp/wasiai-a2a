# CR Report — WKH-104 (BASE-01) Base Adapter

**Branch**: `feat/wkh-base-port-v1`
**Commits revisados**: `3b4ab0d` (W1), `2a07542` (W2), `f9ce6ce` (W3), `8793306` (W4)
**Reviewer**: nexus-adversary (CR — quality, paralelo con AR)
**Fecha**: 2026-05-19

## 1. Veredicto

**APROBADO**

El adapter Base es un **mirror estructural casi exacto** del exemplar Avalanche, con las divergencias justificadas y documentadas (EIP-712 name por-network, fallback chain de facilitator BASE→CDP→WASIAI). 987/987 tests verde, `npm run build` clean, cero `any`/`as unknown`/`ethers` en `src/adapters/base/`. Trazabilidad AC↔test perfecta (todos los 8 ACs tienen `it('… (AC-N)')`).

Hay **2 observaciones MED** y **3 LOW** — todas mejoras opcionales, ninguna bloquea DONE.

## 2. Quality Observations

| ID | Sev | Archivo:línea | Observación |
|---|---|---|---|
| **CR-MED-1** | MED | `src/adapters/base/payment.ts:98-147` | Duplicación interna en `getUsdcAddress()`. El bloque `if (!env) { … } if (!ADDRESS_RE.test(env)) { … }` repite la misma lógica de warn-once × 2 ramas (mainnet/sepolia) × 2 paths (ausente/inválido) = **4 bloques `console.warn` casi idénticos**. Avalanche tiene el mismo problema. **Sugerencia**: extraer `warnDefaultOnce(network, reason, envValue?)`. **NO bloqueante** — deuda compartida. |
| **CR-MED-2** | MED | `src/adapters/base/payment.ts:323-326` | El branch `settle()` con `!response.ok` devuelve `txHash: result?.transactionHash ?? ''`. Vacío string como txHash es semánticamente débil — callers pueden hacer `if (result.txHash)` y leer string vacío como "no tx". Patrón heredado del exemplar. **NO bloqueante** porque es paridad exacta con Avalanche. |
| **CR-LOW-1** | LOW | `src/adapters/base/payment.ts:27-31` | Comentario IMPORTANTE — BASE-01 caveat (DT-11) mezcla español + inglés. El resto del archivo está en inglés. Inconsistencia menor. |
| **CR-LOW-2** | LOW | `src/adapters/base/payment.ts:64-68` y `:104-147` | `getUsdcEip712Name()` está en su propio bloque al inicio, mientras que `getDefaultUsdcAddress`/`getUsdcAddress` están en otro bloque más abajo. **Orden visual sub-óptimo** — agruparlas en una sección `// ─── USDC config helpers ───` mejoraría legibilidad. |
| **CR-LOW-3** | LOW | `src/adapters/base/gasless.ts:18-23` | El campo `networkTag` discrimina por `chainId === 8453`. Magic number en vez de importar las constantes `BASE_SEPOLIA_CHAIN_ID` / `BASE_MAINNET_CHAIN_ID` de `payment.ts`. Mirror exacto con Avalanche/gasless.ts. |

## 3. Adherence to exemplar pattern (Avalanche)

| Aspecto | Status | Evidencia |
|---|---|---|
| Imports order (viem → types → local chain) | PASS | `base/payment.ts:1-16` ≡ `avalanche/payment.ts:1-16` |
| Module-level constants | PASS | Estructura idéntica salvo divergencias documentadas (NAME_SEPOLIA vs NAME_MAINNET) |
| Lazy wallet-client state | PASS | `base/payment.ts:93-94` mirror exacto |
| Order de métodos del adapter | PASS | Idéntico orden — `base/payment.ts:336-453` ≡ `avalanche/payment.ts:307-421` |
| Same error types and codes | PASS | Strings idénticos modulo prefijo `[base]` / `[avalanche]` |
| EIP-3009 types (`TransferWithAuthorization`) | PASS | Definición byte-idéntica |
| `_resetWalletClient()` TEST-ONLY (CD-17) | PASS | `base/payment.ts:459-464` ≡ `avalanche/payment.ts:427-432` |
| Documented divergence — EIP-712 `name` per network | PASS | `base/payment.ts:54-60` + `:418-421`, doc cruza referencia con `w0-audit.md` |
| Documented divergence — Facilitator URL chain | PASS | `base/payment.ts:70-73` + `:163-170` con DT-3 explícito |
| Factory shape | PASS | `base/index.ts:15-42` ≡ `avalanche/index.ts:19-46` |
| Stub adapters JSDoc + class structure | PASS | `base/attestation.ts:10-28` ≡ `avalanche/attestation.ts:10-30` |
| Identity = `null` | PASS | `base/identity.ts:1-3` ≡ `avalanche/identity.ts:1-3` |
| Chain helper mirror | PASS+ | `base/chain.ts` agrega CD-11 warn-once — **mejora sobre Avalanche** |

**Overall mirror score**: 13/13 PASS.

## 4. Test Quality Assessment

| Categoría | Status | Evidencia |
|---|---|---|
| **Coverage de los 8 ACs** | PASS | AC-1, AC-2 en `registry.test.ts:426-454` + `chain-resolver.test.ts:66-76`; AC-3 en `base.test.ts:206-258`; AC-4 en `base.test.ts:83-87`; AC-5a/b en `base.test.ts:89-111`; AC-6 en `registry.test.ts:500-505`; AC-7 verificado por `npm test` 987/987; AC-8 verificado por build clean. |
| **Happy + edge + error paths** | PASS | Happy + edge (HTTP 5xx, settled:false, mainnet vs testnet) + error (OPERATOR_PRIVATE_KEY missing) + defaults override + env absence — 35 tests cubren los 4 grupos. |
| **Assertions literales** | PASS | `.toBe(84532)`/`.toBe('USDC')`/`.toBe('USD Coin')` — literales explícitos. Zero `.toBeTruthy()` lazy. |
| **Mocks correctos** | PASS | `vi.mock('viem')` preserva `importOriginal()` y solo overridea `createWalletClient`. `mockFetch` por test con `mockResolvedValueOnce`. |
| **Test naming descriptivo** | PASS | Tag AC + DT en título: `'sign() — AC-3 — EIP-712 domain uses chainId 84532 + verifyingContract = USDC Sepolia default'`. |
| **Real EIP-712 signing test** | **PARTIAL** | Test `:206-239` mockea `signTypedData` y luego introspecciona args con `mock.calls[0]?.[0]` para verificar domain. Valida construcción correcta pero NO ejecuta firma real. La validación onchain delega en WKH-105 (cast call en `w0-audit.md`). Aceptable trade-off para MVP. |
| **CD-12 (chainId consistency)** | PASS | `base.test.ts:60-66` y `:68-76` verifican explícitamente. |
| **Independence (no shared state)** | PASS | `beforeEach` llama a `_resetWalletClient()` + `_resetBaseChain()` + `vi.clearAllMocks()` + `delete process.env.*`. |
| **Multi-chain registry coexistence** | PASS | `registry.test.ts:484-498` verifica que `base-sepolia` coexiste con `kite-ozone-testnet` + `avalanche-fuji` sin colisión. |

**Overall**: 8/9 PASS + 1 PARTIAL (real EIP-712 — aceptable por scope).

## 5. TypeScript Hygiene

| Check | Status | Evidencia |
|---|---|---|
| Zero `any` explícito en `src/adapters/base/*.ts` | PASS | grep clean |
| Zero `as unknown` | PASS | grep clean |
| Zero `ethers` import | PASS | grep clean — solo `viem` |
| Casts limitados y justificados | PASS | 5 casts justificados (USDC addresses verified onchain, env validated, OPERATOR key env, nonce hex). |
| Discriminated unions correctos | PASS | `BaseNetwork = 'testnet' \| 'mainnet'`, `BaseNetworkTag = 'eip155:84532' \| 'eip155:8453'`. |
| JSDoc en funciones/clases públicas | PASS | Todos los exports documentados. |
| `tsc -p tsconfig.build.json` clean | PASS | `npm run build` exit 0. |

## 6. Documentation Completeness

| Check | Status | Evidencia |
|---|---|---|
| Folder-level JSDoc en `base/` | PASS | Cada archivo tiene JSDoc al tope con referencia a WKH-104 / BASE-01. |
| `.env.example` con cada nueva env var | PASS | `.env.example:395-445` documenta 10 env vars con priority order (DT-3). |
| JSDoc en funciones exportadas | PASS | Cubierto en TS hygiene. |
| Decisiones técnicas DT-N referenciadas inline | PASS | DT-3, DT-4, DT-5, DT-7, DT-11, CD-11, CD-15, CD-17 referenciados en código. **Excelente trazabilidad SDD→código.** |
| Paper trail W0 (cast call outputs) | PASS | `w0-audit.md` (147 LOC) con outputs verbatim confirmando `name()` y `version()` onchain. |

## 7. Production-Grade Checklist

| Check | Status | Evidencia |
|---|---|---|
| Logging adecuado sin verboso | PASS | 6 `console.warn` (warn-once flags) + 1 stub-attestation. Cero `console.log`. |
| Error messages con contexto útil | PASS | `'Facilitator network error: ${err.message}'`, `'OPERATOR_PRIVATE_KEY not set'`, etc. |
| Defaults seguros (testnet por default) | PASS | `getBaseNetwork()` defaults a `'testnet'` (CD-4); registry dispatcher pasa `'testnet'` para `base-sepolia`. |
| Configurability via env vars | PASS | 10 env vars override puntos críticos. Defaults canonical Circle hardcoded como fallback verified onchain. |
| Timeout en HTTP calls al facilitator | PASS | `FACILITATOR_TIMEOUT_MS = 10_000` aplicado en `verify` y `settle`. Mirror de Avalanche SEC-AR. |
| Backward compat (no rompe Avalanche/Kite) | PASS | 987/987 tests verdes. |
| Defense-in-depth (CD-11 warn-once on misconfig) | PASS+ | **Mejora sobre Avalanche** — testeado explícitamente en `base.test.ts:95-111`. |
| Secrets manejo | PASS | `CDP_API_KEY` documentado como "NO ponerlo en logs". `OPERATOR_PRIVATE_KEY` no logueado. |

## 8. Resumen Ejecutivo

WKH-104 / BASE-01 es un **mirror disciplinado del exemplar Avalanche** con 2 divergencias justificadas y documentadas (EIP-712 name per-network verificado onchain por WKH-105; facilitator URL fallback chain extendido con `CDP_FACILITATOR_URL` placeholder). 987/987 tests verde, `npm run build` clean, **cero `any` / `as unknown` / `ethers`** en código nuevo. Trazabilidad AC↔test es **perfecta** con W0 paper trail.

La estructura del adapter es **byte-equivalente** al exemplar — el reviewer puede leer `base/payment.ts` y `avalanche/payment.ts` lado a lado y solo encontrar nombres de red distintos + la divergencia documentada de `name`. Las 5 observaciones (2 MED + 3 LOW) son mejoras de DRY/orden/i18n que **heredan paridad** con Avalanche — refactorearlas en este PR sería out-of-scope.

**Highlights positivos**: (a) `base/chain.ts` introduce CD-11 warn-once que Avalanche no tiene — mejora sobre el exemplar; (b) cada AC tiene `it('… (AC-N)')` taggeado para trazabilidad QA; (c) CD-12 testeado explícitamente; (d) facilitator URL fallback chain con priority documentado para BASE-02 hand-off limpio; (e) `_resetBaseChain()` exportado (CD-17) habilita tests deterministas.

**Recomendación**: **APROBAR** sin gate. Avanzar a F4 (QA).

---

## Notas de deduplicación con AR

- AR-MNR-1 (asimetría `'base'`→mainnet), AR-MNR-2 (footgun EIP-712 version), AR-MNR-3 (PK pública anvil) son security/footgun (AR).
- CR-MED-1 (DRY warn-once), CR-MED-2 (txHash string vacío) son quality/DX (CR).
- Sin overlap real entre AR y CR — ambos cubren ángulos distintos.

## Archivos relevantes

Ver paths absolutos en `ar-report.md` § "Files relevantes".
