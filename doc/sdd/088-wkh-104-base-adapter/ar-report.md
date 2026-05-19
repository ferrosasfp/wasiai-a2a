# AR Report — WKH-104 (BASE-01) Base Adapter

**Branch**: `feat/wkh-base-port-v1`
**Commits audited**: `3b4ab0d`, `2a07542`, `f9ce6ce`, `8793306`
**Date**: 2026-05-19
**Reviewer**: nexus-adversary (AUTO QUALITY)

---

## Veredicto: **APROBADO** (sin BLOQUEANTEs; 3 MENORes documentados)

- `npm test` PASS (987/987 — baseline 941 + 46 nuevos)
- `npm run build` PASS (clean tsc + static copy)
- Zero `any` / `as any` / `as unknown` introducidos en `src/adapters/base/**`
- Zero imports de `ethers` introducidos
- Zero TODO/FIXME introducidos
- Zero `--no-verify` en commits (todos llevan `Co-Authored-By: Claude Opus 4.7`)
- Regresion guard: `git diff main feat/wkh-base-port-v1 -- src/adapters/avalanche/ src/adapters/kite-ozone/` retorna empty (CD-2 honored)
- EIP-712 domain verified on-chain (W0 audit): Sepolia `name="USDC"` v2, Mainnet `name="USD Coin"` v2 — implementación matches en `src/adapters/base/payment.ts:59-67`

---

## 1. Tabla de BLOQUEANTEs

**Ninguno.**

Las 11 categorías de ataque fueron revisadas; ninguna produjo evidencia ejecutable de BLOQUEANTE contra el código nuevo.

---

## 2. Tabla de MENORes

| ID | Categoría | Archivo:línea | Descripción | Impacto | Sugerencia |
|----|-----------|---------------|-------------|---------|------------|
| **MNR-1** | Security (defense-in-depth) | `src/adapters/chain-resolver.ts:46` | El alias `'base'` (sin sufijo) resuelve a `'base-mainnet'` (mainnet, dinero real) por DT-7, mientras que `'avalanche'` → `'avalanche-fuji'` (testnet). Asimetría documentada y aceptada en SDD §6.2 con compensating control en `src/middleware/a2a-key.ts:217-223` (400 `CHAIN_NOT_SUPPORTED` cuando el slug no esté inicializado en el registry). | Bajo: el middleware filtra por `getAdaptersBundle(chainKey)` antes de cobrar, así que un caller que pasa `'base'` accidentalmente con un deployment que solo tiene `base-sepolia` recibe 400, no un debit en mainnet. | Mantener tal cual (decisión documentada). NO bloqueante. |
| **MNR-2** | Production-grade / Footgun | `src/adapters/base/payment.ts:149-155` | `getUsdcEip712Version()` lee `BASE_SEPOLIA_USDC_EIP712_VERSION` / `BASE_MAINNET_USDC_EIP712_VERSION` sin validar contra `{'1','2'}`. Si un operador pone `BASE_MAINNET_USDC_EIP712_VERSION=3` por error de copy/paste, las signatures resultantes serán EIP-712 inválidas onchain (el facilitator/Circle USDC rechaza `verify()`). | Bajo: signature falla, settle reporta error — no se pierden fondos. Misma anomalía existe en `avalanche/payment.ts:131-135`, así que es deuda compartida, no regresión introducida. | Agregar validación allowlist `if (env && !['1','2'].includes(env)) { warn + fallback }`. Si se acepta como deuda existente, NO bloquea. |
| **MNR-3** | Production-grade / Test hygiene | `src/adapters/__tests__/base.test.ts:124-125` | El test hardcodea `OPERATOR_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'` (la PK pública conocida de la dirección anvil/foundry account #0). No es un secreto real, pero queda en el repo bajo `git grep`. | Muy bajo: la PK es pública y la wallet client es mockeada (`vi.mock('viem')`) — no hay firma real. | Considerar reemplazar por un placeholder más obvio (`0x' + '11'.repeat(32)`) o `randomBytes(32)` en `beforeEach`. NO bloqueante. |

---

## 3. Production-grade audit checklist

| Categoría | Estado | Evidencia |
|-----------|--------|-----------|
| TypeScript strict (sin `any`) | **PASS** | `grep ": any\b\|as any\b\|<any>" src/adapters/base/` → 0 hits |
| Sin `as unknown` injustificado | **PASS** | `grep "as unknown" src/adapters/base/` → 0 hits |
| Sin `ethers.js` (solo viem) | **PASS** | `grep -ri "ethers" src/adapters/base/` → 0 hits |
| Error handling con `throw new Error(...)` clases | **PASS** | 6 throw sites en `payment.ts`; `gasless.ts:28` |
| Tests reales (no snapshot fake) | **PASS** | `base.test.ts` (525 LOC, 35 tests) asserts sobre `domain.chainId`, `domain.name`, `domain.version`, `verifyingContract`, fetch body shape |
| Co-Authored-By Claude en commits | **PASS** | Todos los 4 commits incluyen `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` |
| Env vars documentadas en `.env.example` | **PASS** | `.env.example:395-445` documenta `BASE_NETWORK`, `BASE_*_RPC_URL`, `BASE_*_USDC_ADDRESS`, `BASE_*_USDC_EIP712_VERSION`, `BASE_FACILITATOR_URL`, `CDP_FACILITATOR_URL`, `CDP_API_KEY` con resolución (DT-3) explicada |
| `.env.example` sin secrets reales | **PASS** | Solo addresses USDC canónicas Circle, RPC URLs públicos, placeholder vacíos para keys |
| Sin `console.log` leak de privkeys/signatures | **PASS** | Solo `console.warn` para diagnostics (no leakea secretos — ver `payment.ts:114-141`) |
| Sin TODO/FIXME sin ticket | **PASS** | `grep "TODO\|FIXME\|XXX" src/adapters/base/` → 0 hits |
| Sin `.skip` / `xit` en tests | **PASS** | grep clean |
| `--no-verify` en commits | **PASS** | `git log --format='%B'` revisado — no aparece flag de skip hooks |

---

## 4. 11 Categorías de Ataque — análisis

| # | Categoría | Veredicto | Notas |
|---|-----------|-----------|-------|
| 1 | **Security** | **OK** | Sin SQL/XSS (adapter EVM puro). `OPERATOR_PRIVATE_KEY` solo lectura lazy, no loggea. Chain ID 84532/8453 embebidos correctamente. EIP-712 domain `name` per-network confirmed onchain. Default OFF testnet (CD-11). Replay attacks: nonce `randomBytes(32)` per-sign. Cross-chain header confusion: middleware `a2a-key.ts:217-223` retorna 400 si chainKey no inicializado. |
| 2 | **Error Handling** | **OK** | Try/catch en fetch + `response.json().catch()` defensive; HTTP-5xx mapeado a `valid: false`; `signTypedData` propaga errores; `AbortSignal.timeout(10_000)`. |
| 3 | **Data Integrity** | **OK** | Sin race conditions: walletClient cacheado per-network module-level. `randomBytes(32)` por sign garantiza nonces únicos. Idempotencia delegada al facilitator. |
| 4 | **Performance** | **OK** | Sin loops costosos; sin N+1. WalletClient cacheado. Timeout 10s. |
| 5 | **Integration** | **OK** | Backwards-compat 100%. Avalanche/Kite diff = 0 bytes. Middleware sin cambios. |
| 6 | **Type Safety** | **OK** | 0 `any`, 0 `as unknown`. `ChainKey` extension additive. Casts justificados. Build PASS. |
| 7 | **Test Coverage** | **OK** | 46 tests nuevos cubriendo factory shape, payment contract, gasless stub, attestation stub, chain-resolver, registry dispatch. AC-3, AC-4, AC-5b explícitos. |
| 8 | **Scope Drift** | **OK** | 17 archivos modificados — todos dentro del Story File §5. Read-only files intactos. |
| 9 | **Destructive Migrations** | **N/A** | No hay migraciones SQL. |
| 10 | **RPC con SECURITY DEFINER** | **N/A** | No hay funciones Postgres/Supabase nuevas. |
| 11 | **Cache Invalidation Logic** | **N/A** | Solo cache module-level singleton operator-wallet. `_resetWalletClient()` para tests (CD-17). |

---

## 5. Verificación de regression (CD-2)

| Check | Resultado |
|-------|-----------|
| `git diff main feat/wkh-base-port-v1 -- src/adapters/avalanche/` | empty |
| `git diff main feat/wkh-base-port-v1 -- src/adapters/kite-ozone/` | empty |
| `npm test` | 987/987 PASS (baseline 941 + 46 new) |
| `npm run build` | PASS |
| Tests de Avalanche/Kite eliminados o `.skip` | NO |
| Lint baseline ruido | 10 format errors — TODOS pre-existentes en `main`. WKH-104 NO introduce nuevos. |
| TypeScript baseline ruido | 1 error pre-existente (`x402.passport-shape.test.ts:39`), no relacionado. Build `tsconfig.build.json` PASS. |

---

## 6. Resumen ejecutivo

WKH-104 (BASE-01) entrega un adapter Base USDC EIP-3009 que es un **mirror exacto** del adapter Avalanche existente, con la única divergencia justificada onchain (verified via `cast call` en W0): EIP-712 domain `name` difiere — Sepolia usa `"USDC"`, Mainnet usa `"USD Coin"`. La implementación maneja esto correctamente en `payment.ts:64-68` (función `getUsdcEip712Name` per-network).

El branch respeta CD-2: regression diff vacío, 987/987 tests verdes. Scope conforme al Story File §5. Cero `any`, cero `ethers`, cero TODOs nuevos, cero `console.log` leaky. Todos los commits llevan `Co-Authored-By: Claude Opus 4.7`. Cross-chain header confusion cubierta por la lógica middleware existente.

3 MENORes identificados (asimetría DT-7 `'base'`→mainnet aceptada en SDD, footgun EIP-712 version sin allowlist heredado de Avalanche, test hardcoded PK pública anvil) — ninguno bloquea merge.

**No hay BLOQUEANTEs.** Adapter listo para F4 QA.

---

## Files relevantes (paths absolutos)

- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/base/payment.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/base/chain.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/base/index.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/base/gasless.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/base/attestation.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/base/identity.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/__tests__/base.test.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/registry.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/chain-resolver.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/types.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/.env.example`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/sdd/088-wkh-104-base-adapter/w0-audit.md`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/sdd/088-wkh-104-base-adapter/story-file.md`
