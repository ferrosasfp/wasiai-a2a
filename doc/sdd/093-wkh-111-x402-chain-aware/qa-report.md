# QA Validation Report — [WKH-111] [BASE-06] x402 payment path chain-aware (COMPACT)

> QA: nexus-qa (F4)
> Fecha: 2026-05-27
> Branch: feat/093-wkh-111-x402-chain-aware (commits 2d90fab, 6dcf607)
> AR: APROBADO 0 BLOQUEANTES | CR: APROBADO CON OBSERVACIONES 0 BLOQUEANTES

---

## Runtime Checks

| Check | Resultado | Evidencia |
|-------|-----------|-----------|
| `npm test` (full suite) | 1048 passed / 0 fail — 72 test files | Ejecutado en sesión F4 (salida: "Test Files 72 passed (72) / Tests 1048 passed (1048)") |
| `npm run build` | exit 0 | tsc -p tsconfig.build.json + copy static — limpio |
| Facilitator prod `/supported` | eip155:84532 presente, breakerState: CLOSED | `rtk proxy curl https://wasiai-facilitator-production.up.railway.app/supported` → `{"network":"eip155:84532","name":"Base Sepolia","methods":["eip3009"],"breakerState":"CLOSED"}` |
| AC-2 tx live (Basescan) | PENDING-RUNTIME | Branch no mergeada/deployada aún; tx real = post-merge. Ver nota AC-2 abajo. |

---

## AC Verification

| AC | Texto (EARS) | Status | Evidencia archivo:línea |
|----|-------------|--------|------------------------|
| AC-1 | WHEN request trae `x-payment-chain: base-sepolia` sin key ni signature THEN 402 con `accepts[0].network=eip155:84532`, asset USDC Base, `maxAmountRequired` en 6-dec (`'1000000'`) | PASS | Test T-AC1: `src/middleware/x402.chain-aware.test.ts:135-163` — afirma `statusCode=402`, `network='eip155:84532'`, `asset='0x036CbD53842c5426634e7929541eC2318f3dCF7e'`, `maxAmountRequired='1000000'`. Test T-CD9: `:352-379` — afirma `'1000000'` y `!== '1000000000000000000'`. Producción: `src/middleware/x402.ts:64,68` (`getPaymentAdapter(chainKey)` → `adapter.getNetwork()/getToken()/quote().amountWei`). |
| AC-2 | WHEN signature EIP-3009 válido + `x-payment-chain: base-sepolia` THEN verify/settle contra adapter Base (eip155:84532) → 200 + tx hash Basescan | PASS (unit) / PENDING-RUNTIME (tx live) | Test T-AC2: `src/middleware/x402.chain-aware.test.ts:167-198` — afirma `statusCode=200`, `payment-response='0xbeef'`, `mockBaseVerify` llamado 1 vez, `mockBaseSettle` llamado 1 vez, ninguna llamada con arg `undefined`. Producción: `src/middleware/x402.ts:200,235` (`getPaymentAdapter(chainKey).verify/settle`). Tx onchain real: NO ejecutable pre-merge (branch no deployada). Pending: orquestador corre `scripts/smoke-base-sepolia.mjs` tras merge a prod. |
| AC-3 | WHEN request NO envía `x-payment-chain` THEN comportamiento byte-idéntico (Kite, eip155:2368, 1e18); 1039 baseline verdes | PASS | Tests T-AC3a: `src/middleware/x402.chain-aware.test.ts:202-226` — afirma `statusCode=402`, `network='eip155:2368'`, `maxAmountRequired='1000000000000000000'`. T-AC3b: `:230-259` — afirma `mockKiteVerify` llamado, ninguna llamada a base-sepolia. Suite full: 1048/1048 verde (1039 baseline + 9 nuevos = 0 regresiones). |
| AC-4 | IF `x-payment-chain` trae slug no inicializado/no reconocido THEN 400 con `error_code: CHAIN_NOT_SUPPORTED` + lista de chains inicializadas, sin silent fallback | PASS | Test T-AC4a: `src/middleware/x402.chain-aware.test.ts:263-288` — slug `'solana'` (no reconocido) → `statusCode=400`, `error_code='CHAIN_NOT_SUPPORTED'`, mensaje contiene `'not a recognized slug or chainId'`. Test T-AC4b: `:292-317` — slug `'avalanche-fuji'` (reconocido, no inicializado) → `statusCode=400`, `error_code='CHAIN_NOT_SUPPORTED'`, mensaje contiene `'Initialized: kite-ozone-testnet, base-sepolia'`. Producción: `src/middleware/x402.ts:151-174` (guards 400 previos al branch payment-signature `:177`). |
| AC-5 | WHILE request declara chain vía header, usar el MISMO chainKey en challenge/verify/settle (no mezclar fuentes) | PASS | Test T-AC5: `src/middleware/x402.chain-aware.test.ts:321-348` — `mockGetPaymentAdapter.mock.calls.every(c => c[0] === 'base-sepolia')` = true. Producción: `src/middleware/x402.ts:149` (resolución única `resolveChainKey`); `:181,200,235` (mismo `chainKey` propagado a buildX402Response, verify, settle). |

---

## Drift Detection

Archivos modificados (`git diff --name-only main..feat/093-wkh-111-x402-chain-aware`):

```
doc/sdd/093-wkh-111-x402-chain-aware/auto-blindaje.md  (doc — esperado)
src/__tests__/e2e/setup.ts                              (ripple mock — esperado, documentado en auto-blindaje.md)
src/middleware/x402.chain-aware.test.ts                 (test nuevo — Scope IN)
src/middleware/x402.passport-shape.test.ts              (ripple mock — esperado)
src/middleware/x402.ts                                  (prod — Scope IN)
src/routes/registries.test.ts                           (ripple mock — esperado)
```

- Scope drift: NINGUNO. Solo `src/middleware/x402.ts` como prod file. Los 3 archivos de test extra son ripple-fix documentados (extensiones de vi.mock; sin código de producción).
- Confirmado: NO se tocó `a2a-key.ts`, `registry.ts`, `chain-resolver.ts`, adapters, ni `smoke-base-sepolia.mjs` (CD-8).
- Wave drift: N/A (branch con 2 commits, ordenados correctamente).

---

## Gates (confirmado de CR report, no re-ejecutados)

- `npm test` → 1048/1048 — PASS (confirmado CR report + re-verificado en sesión F4)
- `npm run build` → exit 0 — PASS (confirmado CR report + re-verificado en sesión F4)
- typecheck (`tsc -p tsconfig.build.json`) → exit 0 — PASS (confirmado AR + CR reports)

---

## AR/CR Follow-up

- AR: 0 BLOQUEANTES. MNR-1 (mismatch payload.network sin 400 explícito) aceptado como TD-WKH-111-01 (decisión documentada, fail-seguro vía adapter).
- CR: 0 BLOQUEANTES. MNR-1 (edge-case test `REGISTRY_NOT_INITIALIZED`) + MNR-2 (doble resolución in-memory) aceptados como deuda técnica.

---

## Veredicto

**APROBADO PARA DONE**

Todos los ACs tienen evidencia archivo:línea. Gates verdes (1048/1048 + build exit 0). Facilitator de prod confirma `eip155:84532` `CLOSED`. Drift: ninguno. 0 BLOQUEANTES en AR y CR.

**Pendiente post-merge (no bloquea DONE):** AC-2 tx live — correr `scripts/smoke-base-sepolia.mjs` contra prod tras merge/deploy para cerrar la "Run 4" del epic con tx hash Basescan real. Es evidencia de integración E2E, no un fallo de esta HU.
