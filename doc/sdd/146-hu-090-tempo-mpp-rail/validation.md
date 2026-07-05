# Validation Report — HU-090 / WKH-090 (rail Tempo/MPP)

**Veredicto**: F4: PASS — APROBADO PARA DONE
**Fecha**: 2026-07-04
**Branch**: `feat/146-hu-090-tempo-mpp-rail` @ `e16e44e` (PR #167)
**Modo**: money-path, QUALITY, ship flag OFF, sin migración.

## Runtime checks (worktree aislado, NO main tree)

- Worktree: `/tmp/.../scratchpad/wt-hu090` @ `e16e44e`, `npm ci` limpio.
- `npx tsc --noEmit` → **PASS** (0 errores).
- `npm run lint` (`biome check src/`) → **PASS** ("Checked 298 files... No fixes applied").
- `npm test` (vitest) → **PASS** — `149 passed | 4 skipped (153)` files, `2615 passed | 10 skipped (2625)` tests, 0 FAIL.
- Subset dirigido (`tempo.payment.contract`, `registry`, `chain-resolver`, `avalanche`, `base`, `payment.contract`, `kite-factory`, `gasless.contract`) → **PASS (247) FAIL (0)**.
- Migraciones: `git diff --name-only be09a29 e16e44e -- supabase/migrations/` → **vacío**. Confirmado: no hay migración en esta HU.
- Worktree eliminado post-verificación (`git worktree remove --force`).

## ACs — evidencia archivo:línea

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (flag ON → bundle Tempo completo, otros rails intactos) | PASS | `src/adapters/__tests__/registry.test.ts` → `'AC-1 — flag ON + WASIAI_A2A_CHAINS includes tempo-testnet → full bundle'` (asserta `payment/attestation/gasless.name==='tempo'`, `chainConfig.chainId===42429`, y `base-sepolia` bundle intacto); `'AC-1 — registry passes opts.network=testnet to createTempoAdapters'`. Impl: `src/adapters/registry.ts:79-82` (branch `buildBundle`), `src/adapters/tempo/index.ts:14-33` (`createTempoAdapters`). |
| AC-2 (flag OFF byte-idéntico, `createTempoAdapters` no invocado) | PASS | `registry.test.ts` → `'AC-2 — flag OFF: 6-rail CSV initializes identical to baseline; no tempo bundle'` (6 keys exactos, `getAdaptersBundle('tempo-testnet')` undefined); `'AC-2 — flag OFF: createTempoAdapters is never invoked'` (spy `not.toHaveBeenCalled()`). Impl: `registry.ts:43-48` (`getSupportedChains()` retorna los 6 slugs const si `!isTempoEnabled()`). |
| AC-3 (Challenge/Credential/Receipt→x402, envelope v2 canónico, quote USD real) | PASS | `tempo.payment.contract.test.ts`: `'settle() maps the Credential to SettleRequest...'` (asserta `body.x402Version===2`, `accepted.extra.assetTransferMethod==='eip3009'`); `'verify() returns VerifyResult...'`; `'quote(1) → 1e6 atomic... NOT a hardcode'` + `'quote(0.001) → 1e3 atomic, distinto de quote(1)'` (confirma no-hardcode, money-path MNR-1); `'attest() maps the MPP Receipt...'` (Receipt→`TempoAttestationAdapter.attest()`). Impl: `src/adapters/tempo/payment.ts:190-198` (`buildX402CanonicalBody`), `:333-344` (`quote()` con `parseUnits(amountUsd.toFixed(decimals),...)`), `src/adapters/tempo/attestation.ts:20-27`. |
| AC-4 (resolución header>manifest, aliases 42429/tempo/tempo-testnet) | PASS | `chain-resolver.test.ts`: `'maps tempo aliases (tempo-testnet, tempo)...'`, `'maps Tempo numeric chainId 42429...'`, `'lowercases and trims Tempo input'`, `'header tempo-testnet resolves...'` (prioridad header>manifest), `'manifest tempo alias resolves...'`. Impl: `src/adapters/chain-resolver.ts:56-60` (`SLUG_ALIASES`: `'42429'`, `'tempo-testnet'`, `'tempo'` → `'tempo-testnet'`), resolver puro sin lectura de flag (CD-7 respetado). |
| AC-5 (`CHAIN_NOT_SUPPORTED` double-guard flag OFF, error lista solo 6 rails) | PASS | `registry.test.ts`: `'AC-5 — flag OFF + tempo-testnet in CSV → fail-fast boot'` (`Unsupported chain 'tempo-testnet'`); `'AC-5 — flag OFF: getAdaptersBundle(tempo-testnet) is undefined (guard 2)'`; `'AC-5 — flag OFF error message lists exactly the 6 baseline rails'` (string exacto asserted: `kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet`). Impl: `registry.ts:86-88` (mensaje de error usa `getSupportedChains()`). |
| AC-6 (sin auto-routing) | PASS | `chain-resolver.test.ts` → `'AC-6 — no auto-routing: without an explicit slug, resolver returns undefined'`. Inspección de `resolveChainKey()` (`chain-resolver.ts:80-90`): solo header>manifest, cero branch por costo/latencia/geografía. |
| AC-7 (params [VERIFY-AT-IMPL] overrideables + documentados) | PASS (documental, no testeable por código, consistente con SDD §7) | Grep en worktree: `TEMPO_TESTNET_RPC_URL`, `TEMPO_TESTNET_USD_ADDRESS`, `TEMPO_TESTNET_USD_EIP712_NAME/VERSION`, `TEMPO_FACILITATOR_URL`, `TEMPO_NETWORK` — todos con fallback documentado + warn-once (`src/adapters/tempo/payment.ts:88-135`, `src/adapters/tempo/chain.ts:24-26,55-70`). V1(chainId)/V2(RPC)/V5(explorer) resueltos con research web (`chain.ts:16-19`); V3/V4/V6/V7/V8 marcados `[VERIFY-AT-IMPL]` explícito, no bloquean (rail OFF, tests mockean fetch). |

## Invariantes clave

| Invariante | Status | Evidencia |
|---|---|---|
| Byte-idéntico flag OFF (`getSupportedChains()`=6 slugs, no-regresión kite/avax/base) | PASS | `registry.ts:43-48` retorna la const `SUPPORTED_CHAINS` (6 slugs) sin flag; test `AC-2` arriba; suite completa (`avalanche.test.ts`, `base.test.ts`, `payment.contract.test.ts`, `kite-factory.test.ts`) verde en la misma corrida (2615/2615 no-skip pasan). |
| Módulo tempo/ NO en el hot path con flag OFF | **PASS con matiz documentado** | `registry.ts` solo importa `./tempo/index.js` dinámicamente dentro del branch `chainKey==='tempo-testnet'` de `buildBundle` (nunca alcanzado con flag OFF, dado que `getSupportedChains()` no lo incluye) — esto es correcto y es el choke-point real (CD-7). **Matiz**: `src/adapters/deposit-verifier.ts:23` SÍ tiene un **import estático** `import { getTempoChain } from './tempo/chain.js'` (no dynamic), usado en el `switch(resolveChainObject)` exhaustivo. Esto significa que `tempo/chain.ts` (solo `defineChain()`, cero I/O, cero red, cero mutación de estado compartido) se carga en memoria siempre que se cargue `deposit-verifier.ts` (rutas `/auth/deposit`, escrow/settle-verifier), independientemente del flag. **Esto NO es nuevo de esta HU**: `deposit-verifier.ts` ya importaba estáticamente `kite-ozone/chain.ts`, `avalanche/chain.ts`, `base/chain.ts` de la misma forma para los 3 rails existentes — es el patrón preexistente del archivo, no un desvío introducido por Tempo. Efecto runtime: cero (objeto `Chain` puro, sin side-effects observables, sin afectar otros rails) → el comportamiento **funcional** sigue siendo byte-idéntico (mismo criterio que ya aplicaba a los 3 rails previos). Se documenta por precisión, no se marca como hallazgo bloqueante. |
| 2 archivos extra (`downstream-payment.ts`, `deposit-verifier.ts`) dead-code / extensión mecánica | PASS | `git diff be09a29 e16e44e` → ambos son extensiones de un `switch`/`Record<ChainKey,...>` exhaustivo forzado por TS al extender la unión `ChainKey` (`deposit-verifier.ts` +15/-1: `ChainFamily` union + 4 `case 'tempo-testnet'` branches; `downstream-payment.ts` +4: una entrada de `Record`). Comentario explícito "dead code con el flag OFF" en `downstream-payment.ts:50-53`. Cero cambio de comportamiento en los 3 rails existentes (mismos `case` intactos). |
| Gasless stub no-null (501, no relay real) | PASS | `src/adapters/tempo/gasless.ts:22-30` — `transfer()` lanza `GaslessNotSupportedError` (501 vía `errors.ts`); `status()` → `enabled:false/funding_state:'disabled'`. `AdaptersBundle.gasless: GaslessAdapter` (no-nullable, `types.ts:141`) — Tempo SIEMPRE provee instancia, nunca `null`. Test: `tempo.payment.contract.test.ts` → `'transfer() rejects with GaslessNotSupportedError'`. |
| Reuso x402 sin tipo paralelo | PASS | `tempo/payment.ts` importa `SettleRequest`/`SettleResult`/`X402Proof`/`VerifyResult`/`QuoteResult` de `../types.js` (línea 6-16) — cero interface nueva de proof. `types.ts` sin diff salvo `ChainKey += 'tempo-testnet'` (1 línea, `git diff` confirma `+3 -1` total en el archivo, todo en el union type). |

## Drift Detection

- Archivos modificados = exactamente Scope IN del Story File + los 2 archivos extra justificados (exhaustividad TS): `types.ts`, `chain-resolver.ts`, `registry.ts`, `tempo/{chain,payment,attestation,gasless,index}.ts`, tests (`tempo.payment.contract.test.ts` nuevo, `chain-resolver.test.ts`/`registry.test.ts` modificados), `deposit-verifier.ts`, `downstream-payment.ts`. Cero archivos fuera de este set (`git diff --stat be09a29 e16e44e`).
- Waves: commit único `e16e44e` (squash) — no violan orden W0→W1→W2→W3 en el contenido (tipos primero, luego adapter, luego wiring, luego tests, consistente con el diff).
- Untracked ajenos en el árbol principal (validation.md de otras HUs, audit-delta) — **no relacionados a esta HU**, pre-existentes de sesiones previas, no tocados.
- Settle de otros rails: verificado por no-regresión de suite completa + tests explícitos de `base-sepolia`/`kite`/`avalanche` intactos en `registry.test.ts` AC-1/AC-2.
- Gap menor (no bloqueante): `.env.example` no fue actualizado con `TEMPO_ADAPTER_ENABLED`/`TEMPO_*` (precedente mixto: WKH-133 sí lo hizo, WKH-141 no). Sugerido para WKH-090b o un follow-up cosmético.

## Gates (confirmados en worktree — CR no dejó cr-report.md en disco para esta HU, así que se ejecutaron directamente per instrucción de la tarea)

- `tsc --noEmit`: PASS
- `biome check` (lint): PASS
- `vitest` (suite completa): PASS (2615/2615 no-skip)
- Build: no ejecutado (no requerido por la tarea; CI del PR #167 — check `build-test`, `coverage`, `light-smoke` — todos `SUCCESS` según `gh pr view 167`).

## AR/CR follow-up

- Según el encargo del orquestador: AR + CR ya aprobaron (0 BLQ; 1 MNR — decimales sin override, diferido explícitamente a WKH-090b, no bloquea DONE). No se encontraron `ar-report.md`/`cr-report.md` en disco para esta HU; el veredicto se toma del brief del orquestador + evidencia CI del PR (`gh pr view 167` → 0 reviews bloqueantes, todos los checks SUCCESS).

**Listo para DONE.**
