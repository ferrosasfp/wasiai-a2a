# AR Report — HU 191g · Wire de `arbiter.ts` al contrato `WasiAIEscrow`

> Adversary Review (F3.5) · Epic WKH-191 Wave 1 (HU 7/8) · money-path
> Fecha: 2026-07-13 · Branch: feat/191g-arbiter-onchain-wire
> Gates: `tsc --noEmit` OK · `vitest run` → **2963 passed / 10 skipped / 0 failed** (166 files)

## Veredicto global: APROBADO con MENORs

No hay BLOQUEANTEs. El wire es aditivo, flag-gated (default OFF) e inerte hoy
(sin `ARBITER_PRIVATE_KEY` + `setArbiter()` de 191h y con `arbitrationConsent`=false
para el 100% de keyIds). Con flag OFF el comportamiento es byte-idéntico al actual.
1 MENOR: refina (no contradice) el impacto documentado de R-3.

---

## Foco 1 — FLAG OFF / FALLBACK BYTE-IDÉNTICO → OK

- `settleArbitrationOnChain` (arbiter.ts:111) primer statement: `if (!isEscrowArbiterEnabled()) return settlePaymentIntentOnChain(base)`. `base` = `{intentId, ownerRef, payTo(=row.pay_to), finalAmountUsd(=arbUsd), chainId(=row.chain_id)}` — **exactamente** los mismos 5 campos que la llamada original en el swap (arbiter.ts:728-735). Byte-idéntico.
- Swap único en executeArbitration:728 (antes settlePaymentIntentOnChain). Las ramas settled (737), unequivocal (767) y ambiguous (798) NO cambian de forma (verificado en diff: sólo la línea de la llamada + `keyId: row.key_id`).
- Best-effort `bestEffortLockForDispute` (573) y `bestEffortReleaseDispute` (703): primer statement `if (!isEscrowArbiterEnabled()) return;` → no-op con flag OFF, envuelto en try/catch (no puede lanzar).
- `resolveHold` (WKH-189) delega en executeArbitration (no tocado) → hereda el seam sin cambio.
- Test `WKH-191g wire — flag OFF (default) → byte-idéntico, cero on-chain` (arbiter.test.ts:1358) asserta `executeResolveDispute` NO llamado.

## Foco 2 — TRIPLE GATE → OK (inerte confirmado)

- Cascada en settleArbitrationOnChain: flag (111) → chainKey (115) → escrow (117) → consent (121) → decimals (128). Falta de cualquiera → `settlePaymentIntentOnChain(base)`. Outer `catch` (161-163) → mismo fallback: **cualquier throw en el wire cae al operator-custodial**, jamás rompe el árbitro.
- Mismo gate replicado en ambos best-effort helpers (178-188 / 217-223).
- `readArbitrationConsent` (escrow-verifier.ts:130) devuelve `false` ante contrato-null / client-null / cualquier throw (try/catch total) → CD-7. Hoy `false` para todos → fallback silencioso. Inerte confirmado.

## Foco 3 — NONCE DISJUNTO → OK (mecánica) · ver MNR-1 (impacto R-3)

- `deriveArbiterNonce` (arbiter-executor.ts:72-83): `(1n<<255n) | (keccak(encodePacked(dom,keyIdHash,intentId)) & (2^255-1))`. Bit 255 SIEMPRE seteado → rango `[2^255,2^256)`. Test asserta `>= 2^255` (arbiter-executor.test.ts:507) + determinismo (493).
- Determinista en `(keyIdHash,intentId)` → doble-resolve mismo intent produce mismo nonce → revert `NonceAlreadyUsed` → `not_moved` (exactly-once). Defensa en profundidad sobre el status-gate DB `close_payment_intent_for_arbitration` + el path recovery `arb_closing` (executeArbitration:687) que re-aplica el veredicto persistido SIN re-llamar on-chain (no hay doble resolveDispute).
- R-3 (buyer pre-consume el nonce público/determinista): money-safe en el sentido "nada se dobla ni se mueve mal on-chain". Ver MNR-1 para el matiz de impacto.

## Foco 4 — MAPEO DE DESENLACES → OK

- release/split (arbMicro>0) → `executeResolveDispute` con `seller=payTo(=row.pay_to)`, `sellerAmount=parseUnits(arbUsd.toString(), decimals)`, `nonce=deriveArbiterNonce`. Test 1439 asserta los 3 args exactos + `sellerAmount=parseUnits('10',6)`.
- refund (arbMicro<=0) → `executeReleaseDispute` (no `resolveDispute`); refund off-chain intacto (test 1495 asserta `db.refunds==[10]`).
- lock → `parseUnits(authorized_usd, decimals)` = deposit TOTAL (test 1470). Correcto vs settleUsd.
- Decimals-aware (post WKH-192): `getAdaptersBundle(chainKey).payment.supportedTokens[0].decimals`; USDC=6. Sin decimals → fallback. Destino y monto correctos.

## Foco 5 — KEY DEDICADA → OK

- `getArbiterWalletClient` (arbiter-executor.ts:110) lee `process.env.ARBITER_PRIVATE_KEY`, NUNCA `OPERATOR_PRIVATE_KEY`. Cache propio (`_arbiterWalletClients`/`_arbiterPublicClients`, Maps nuevos).
- `null` NO se cachea (return antes del `.set` cuando falta pk/rpc) → una env seteada tarde funciona sin restart. Test `con solo OPERATOR seteado → not_moved` (arbiter-executor.test.ts:325).

## Foco 6 — BEST-EFFORT / NO ROMPER / DOUBLE-MOVE → OK

- 3 executors NUNCA lanzan: sin wallet/rpc → not_moved; write throw → not_moved(WRITE_FAILED); receipt timeout → ambiguous(RECEIPT_TIMEOUT, txHash); status!=success → not_moved(REVERTED); receipt-success-sin-evento → ambiguous. Cubierto por 18 tests del executor.
- lock/release best-effort: try/catch + log, no abortan la resolución. Test CD-6 (1517): lock throw + release not_moved → resolución idéntica al happy off-chain (`db.refunds==[10]`).
- No double-move dentro de una ejecución: `finalizePaymentIntent` se llama una vez; el seam devuelve el mismo `SettleOutcome`. Ambiguous → NO asume movido, NO refunda (RECONCILE, test 1563). Retry sobre `arb_closing` no re-emite on-chain.

## Categorías no-money-path

- **Security / RBAC**: OK. Sin query nueva sobre `a2a_agent_keys`; keyId = row.key_id de intent ya owner-verificado. Wallet arbiter dedicada.
- **Error handling**: OK. try/catch total en seam + helpers + view.
- **Type safety**: OK. `tsc --noEmit` limpio; sin `any` injustificado; casts `0x${string}` acotados.
- **Test coverage**: OK. 18 tests executor + wire tests con asserts de args concretos (no tautológicos, CD-AB-4 respetado).
- **Scope drift**: OK. Sólo Scope IN: abi.ts, escrow-verifier.ts, arbiter.ts, arbiter-executor.ts(+test), arbiter.test.ts. `contracts/**` intacto.
- **Destructive migrations**: N/A — sin SQL/migraciones (telemetría = logging).
- **RPC SECURITY DEFINER**: N/A — `close_payment_intent_for_arbitration` (pre-existente) NO modificado; sin funciones pg nuevas.
- **Cache invalidation**: N/A — sin capa de cache nueva (los Maps son client-cache per-ChainKey, no data cache multi-tenant).
- **Integration / backwards-compat**: OK. ABI aditivo (byte-a-byte con IWasiAIEscrow.sol:24-28,84-94, verificado); flag default OFF.

---

## Hallazgos

### MNR-1 (Data Integrity / Nonce) — refina impacto de R-3
- **Archivo**: src/services/arbiter.ts:144-151 (rama `not_moved` → `failureKind:'unequivocal'`) + executeArbitration:767-795.
- **Descripción**: R-3 (documentado) califica el pre-consumo del nonce derivado como "money-SAFE (nada se mueve mal)". El repro real es más asimétrico: cuando el árbitro falla `release`/`split` a favor del **seller** y el **buyer** ha pre-consumido el nonce determinista (público) vía `debit()` con su firma, `resolveDispute` revierte `NonceAlreadyUsed` → `not_moved` → rama `unequivocal` → **refund del deposit COMPLETO al buyer** (residual = deposit, executeArbitration:788-795), dejando al seller ganador con **cero**. Confirmado por el propio test AC-6 (arbiter.test.ts:1538 → `db.row.status=='refunded'`, `db.refunds==[10]`).
- **Reproducción (cuando 191h + consent estén activos)**: buyer firma un `debit(keyId, ~0, deadline, deriveArbiterNonce(keyIdHash,intentId), sig)` y lo submitea → `_usedNonces[keyId][nonce]=true` → arbiter `resolveDispute` revierte → buyer recupera el 100% aunque perdió la disputa.
- **Impacto**: cuando el flag se active, un buyer perdedor puede **evadir el pago al seller adjudicado** (denegación de valor, no sólo griefing). Off-chain el buyer queda whole; el seller no cobra. HOY inerte (consent=false, arbiter no seteado, testnet-only).
- **Sugerencia**: no bloquea 191g. En la HU de follow-up (contra-medida de R-3) evaluar: (a) que la rama `unequivocal` distinga `NonceAlreadyUsed` (nonce ya consumido por el buyer) de otros reverts y NO conceda refund completo automático → HOLD/RECONCILE en su lugar; o (b) enforcement on-chain del namespace de nonce (bit 255 reservado) en el contrato. Actualizar la caracterización "money-safe" de R-3 a "buyer puede forzar full-refund y denegar al seller".
- **Severidad**: MENOR (documentado en SDD §5/R-3 con tradeoff explícito exactly-once > anti-griefing; inerte; testnet-only).

---

## Resumen para el orquestador

- **Veredicto**: APROBADO con MENORs → **pasa el gate** (0 BLOQUEANTEs).
- `tsc` OK · suite completa **2963 passed / 0 failed**.
- Focos 1 y 6 (byte-idéntico + no-romper/no-double-move): **OK verificados**.
- MNR-1 no bloquea; es material para la HU de contra-medida de R-3 (post-191h).

*AR generado por NexusAgil — Adversary F3.5.*
