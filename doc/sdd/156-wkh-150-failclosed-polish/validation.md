# Validation Report — HU WKH-150 [WKH-144b] (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-06

## Runtime checks (dry-run READ-ONLY, evidencia)
- `isMainnetChainKey` (ahora exportado, `settle-verifier.ts:196`) ejecutado en runtime vía `tsx` sobre los 7 `ChainKey`:
  ```
  kite-ozone-testnet -> false   avalanche-fuji -> false   base-sepolia -> false   tempo-testnet -> false
  kite-mainnet       -> true    avalanche-mainnet -> true base-mainnet -> true
  ```
  3 mainnet `true`, 4 testnet `false` — coincide con el invariante documentado en `types.ts:124-131`.
- **Prueba de que el guard no es humo**: se simuló un hipotético `'avalanche-c-chain'` (mainnet real, sin sufijo `-mainnet`) → `isMainnetChainKey === false`. El cross-check `isMainnetChainKey(key) === !chain.testnet` (`settle-verifier.test.ts:530-534`) daría `false === true` → el test FALLA, cazando la regresión (confirmado con evidencia análoga vía `tsc`: un `Record<ChainKey, string>` con un miembro omitido produce `TS2741 Property '"tempo-testnet"' is missing` — el mismo mecanismo de exhaustividad que usa `CHAIN_KEY_TO_VIEM`).
- AC-2c (exhaustividad compile-time) confirmado directamente: `tsc` sobre un `Record<ChainKey, string>` incompleto → `error TS2741: Property '"tempo-testnet"' is missing in type ...` (mismo tipo real `ChainKey`, no simulado).

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1a | PASS | `fee-split.ts:461-466` — `log.warn(..., reVerified.ok ? 'split leg settle re-verify unavailable, trusting facilitator' : 'split leg settle re-verify unavailable — REJECTING facilitator response (fail-closed mainnet)')` |
| AC-1b | PASS | `compose.ts:972-976` — mismo patrón ternario, string "REJECTING facilitator confirmation (fail-closed mainnet)" en `ok:false` |
| AC-1c | PASS | testnet (`ok:true`) branch preserva byte-idéntico: `'split leg settle re-verify unavailable, trusting facilitator'` (fee-split.ts:464) y `` `...trusting facilitator confirmation` `` (compose.ts:974) — mismos strings literales que pre-cambio (confirmado por diff, no se tocó ese branch) |
| AC-2a | PASS | `types.ts:124-133` — JSDoc "⚠️ SECURITY INVARIANT (WKH-150 / WKH-144)" explica el invariante `-mainnet`, la dependencia de `isMainnetChainKey()`, y el riesgo (fail-open con plata real) |
| AC-2b | PASS | `settle-verifier.test.ts:527-534` — `it.each` sobre 7 `ChainKey` cruzando contra `chain.testnet` de objetos viem reales (`avalanche`/`avalancheFuji`/`base`/`baseSepolia` de `viem/chains`, `kiteMainnet`/`kiteTestnet` propios, `tempoTestnet`) — no tautológico (fuente distinta al sufijo). 8 tests nuevos verdes (7 it.each + 1 cross-check `mainnetByGate === mainnetByViem`) |
| AC-2c | PASS | Mecanismo `Record<ChainKey, Chain>` exhaustivo — verificado con `tsc` standalone: omitir un miembro produce `TS2741 Property missing`, no skip silencioso |
| CD-1 | PASS | `if (!reVerified.ok)` intacto en ambos: `fee-split.ts:468` → `markLegFailed(...)`; `compose.ts:979` → `throw new Error(...)`. Diff confirma cero cambio en esos bloques |
| CD-5 | PASS | `npx vitest run src/adapters/settle-verifier.test.ts` → 39/39 pass (31 preexistentes WKH-144 + 8 nuevos), ninguno roto |

## Drift
- Minor: `settle-verifier.ts` fue modificado (no listado literal en Scope IN) para exportar `isMainnetChainKey` — necesario para que el test de AC-2b lo importe. Diff confirma: solo se agregó la keyword `export` + un comentario JSDoc; el body (`return chainKey.endsWith('-mainnet')`) no cambió. No viola CD-1 (cero condicional de negocio tocado). Aceptable.
- `doc/sdd/_INDEX.md` actualizado (administrativo, esperado).
- Resto: ninguno.

## Gates
- `npx tsc --noEmit` → 0 errores
- `npm run lint` (biome check src/) → "Checked 312 files, No fixes applied" (0)
- `npx vitest run` (full suite) → 156 passed | 4 skipped (160 files), **2766 passed | 10 skipped** (2776 tests) — matches baseline
- Consumidores específicos verdes: `fee-split.test.ts` + `compose.test.ts` → 101/101 pass

## AR/CR follow-up
- AR: 0 findings (según contexto del orquestador). CR: 1 NIT cosmético (no bloqueante) — sin impacto en veredicto QA.
- Ningún BLQ pendiente.

**Listo para DONE.**
