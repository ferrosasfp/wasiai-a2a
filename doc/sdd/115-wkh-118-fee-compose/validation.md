# Validation Report — WKH-118 FEE-COMPOSE (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-20
**Rama**: feat/115-wkh-118-fee-compose (cambios WKH-118 aún uncommitted sobre base WKH-121..125)

---

## Runtime checks

- Migraciones: NO aplica — WKH-118 no agrega migración. Confirmado: `supabase/migrations/` no contiene ningún archivo 118/fee-compose. La tabla `a2a_protocol_fees` con `orchestration_id UUID PRIMARY KEY` ya existe desde `20260421015829_a2a_protocol_fees.sql`.
- Env vars: NO aplica — WKH-118 reutiliza `WASIAI_PROTOCOL_FEE_WALLET` (ya validada en WKH-44). Sin variables nuevas.
- Scope de cambios uncommitted verificado con `git diff HEAD -- src/routes/compose.ts` → +59/-0 líneas: solo imports + bloque fee post-`result.success`. El archivo `src/routes/compose.fee.test.ts` es nuevo (untracked). Exactamente lo declarado en Scope IN.

---

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1: chargeProtocolFee llamado con orchestrationId=request.id, budgetUsdc=result.totalCostUsdc, feeRate=getProtocolFeeRate() | PASS | `compose.ts:249-253` — `orchestrationId: request.id`, `budgetUsdc: result.totalCostUsdc`, `feeRate: getProtocolFeeRate()`. Test: `compose.fee.test.ts:154-165` (T-FEE-1) verifica `objectContaining({ budgetUsdc: 0.5, feeRate: 0.01, orchestrationId: expect.any(String) })` + truthy string. |
| AC-2: best-effort — fallo NO rompe el 200 | PASS | `compose.ts:248-292` — try/catch externo captura throws en `feeChargeError`; `status:'failed'` captura en L254-256. El `return reply.send(...)` en L294-295 es incondicional post-try. Tests: `compose.fee.test.ts:168-201` (T-FEE-2a mockRejectedValueOnce `new Error('boom')` → 200; T-FEE-2b `status:'failed'` → 200). |
| AC-3: already-charged → no-op | PASS | `compose.ts:257-259` — `else if` sobre `'charged' \|\| 'already-charged'`; el recibo solo se emite si `feeResult.status === 'charged'` (L263). `already-charged` entra al branch pero no emite recibo. Test: `compose.fee.test.ts:204-223` (T-FEE-3) → `expect(mockEmit).not.toHaveBeenCalled()`. |
| AC-4: WALLET_UNSET → skipped, sin campo error en response | PASS | `compose.ts:285` (comentario) — `status:'skipped'` cae fuera del `if`/`else if`, ambas variables quedan `undefined`, no se serializa nada. `return reply.send({ kiteTxHash, ...result })` L294-295 es inalterado. Test: `compose.fee.test.ts:226-243` (T-FEE-4) → 200, `not.toHaveProperty('feeChargeError')`, `mockEmit` no llamado. |
| AC-5: success:false → NO se llama chargeProtocolFee | PASS | `compose.ts:224-238` — el branch `!result.success` hace `return reply.status(status).send(...)` antes de llegar al bloque fee en L240. Test: `compose.fee.test.ts:246-266` (T-FEE-5) → `expect(mockChargeFee).not.toHaveBeenCalled()`. |
| AC-6: status:'charged' + owner_ref → emit protocol_fee fire-and-forget | PASS | `compose.ts:263-282` — guard `feeResult.status === 'charged' && request.a2aKeyRow?.owner_ref`; `receiptService.emit({...}).catch(warn)` sin `await`. Tests: `compose.fee.test.ts:269-317` (T-FEE-6a: owner_ref presente → `mockEmit` llamado 1x con `objectContaining({ receiptType: 'protocol_fee', ownerRef: 'o1', agentKeyId: 'k1', amountUsd: 0.005 })`; T-FEE-6b: `nextKeyRow=undefined` → `mockEmit` no llamado). Flush microtasks aplicado. |
| AC-7: concurrencia idempotente vía PK already-charged | PASS | `compose.ts:257-259` — `already-charged` entra al `else if`, pasa sin recibo ni error. Idempotencia real delegada a `a2a_protocol_fees.orchestration_id UUID PK` en fee-charge.ts (ya testeada). Test: `compose.fee.test.ts:321-340` (T-FEE-7, `inProgress: true`) → 200, `mockEmit` no llamado. |

**Verificación CD-4 (response inalterado):** `compose.ts:294-295` — `return reply.send({ kiteTxHash, ...result })` idéntico al pre-WKH-118. `feeChargeError` y `feeResult` son variables locales, no aparecen en el spread. Test: `compose.fee.test.ts:343-365` (T-FEE-8) → triple `not.toHaveProperty('feeChargeError' | 'feeChargeTxHash' | 'protocolFeeUsdc')` + `body.totalCostUsdc === 0.05`.

**Verificaciones extra de constraints críticos:**
- CD-B (`orchestrationId: request.id`): `compose.ts:250` — confirmado, NO `crypto.randomUUID()`.
- CD-C (`budgetUsdc: result.totalCostUsdc`): `compose.ts:251` — confirmado, NO `body.maxBudget`.
- CD-5 (`request.a2aKeyRow`, no `scopingKeyRow`): `compose.ts:263,266,267` — confirmado `request.a2aKeyRow?.owner_ref` y `request.a2aKeyRow.id`.
- CD-E/CD-7 (recibo fire-and-forget, no await): `compose.ts:264-282` — `receiptService.emit({...}).catch(...)` sin `await`.
- R-1 (try/catch blindaje): `compose.ts:248,286-292` — try/catch externo cubre el bloque completo.

---

## Drift

- Scope: NONE. Git status muestra solo `src/routes/compose.ts` (+59/-0) y `src/routes/compose.fee.test.ts` (nuevo) como cambios WKH-118. Archivos Scope OUT (`compose.ts service`, `fee-charge.ts`, `orchestrate.ts`, `receipt.ts`, `types/`, `migrations/`) verificados con `git diff HEAD` — zero cambios.
- Wave drift: NONE. W1 (compose.ts) → W2 (test) → W3 (format/lint/tsc/test) respetado.
- Spec drift: NONE. El bloque insertado en L240-292 es el "BLOQUE EXACTO" del story-file §Exemplar 1, con la única variación documentada y aprobada en CR: `feeChargeTxHash` no declarado (biome `noUnusedVariables` — justificado en `compose.ts:243-246`).
- Test drift: NONE. 10 tests en compose.fee.test.ts cubren T-FEE-1..T-FEE-8 (T-FEE-2 tiene 2 variantes a/b, T-FEE-6 tiene 2 variantes a/b → 10 total). Todos los ACs + CD-4 cubiertos.

---

## Gates

- **tsc --noEmit**: PASS (exit 0, cero errores). Ejecutado en esta sesión F4.
- **vitest run (completo)**: PASS — 1564 passed | 3 skipped | 0 failed. Ejecutado en esta sesión F4.
- **vitest run compose.fee.test.ts**: PASS — 10/10. Ejecutado en esta sesión F4 y confirmado por CR report.
- **biome lint**: PASS — 0 errores en archivos WKH-118. La info de `reputation.ts:116` es preexistente, no introducida por WKH-118.

---

## AR/CR follow-up

- AR: APROBADO sin bloqueantes ni menores (reportado en mensaje, ar-report.md no en disco — no bloqueante per instrucción).
- CR: APROBADO, 0 findings. Ver `cr-report.md` — gates ejecutados: vitest 10/0, tsc OK, biome lint OK.
- Única nota de CR aceptada (no-finding): `feeChargeError` write-only para el response (solo alimenta `console.error`) — deliberado, consistente con orchestrate, biome no lo marca porque se "lee" en el log.

---

**Listo para DONE.**
