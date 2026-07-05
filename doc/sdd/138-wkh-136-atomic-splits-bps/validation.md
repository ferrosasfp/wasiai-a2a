# Validation Report — HU WKH-136 (Splits atómicos bps) — COMPACT

**Veredicto**: F4: PASS — APROBADO PARA DONE
**Fecha**: 2026-07-04
**PR**: #160 (`feat/138-wkh-136-atomic-splits-bps` @ `73489c9`)

## Runtime checks
- `npm test` (full suite): **2342 passed / 10 skipped / 0 failed** (136 files, matches PR claim).
- Targeted money-path re-run (`fee-split.test.ts`, `split-config.test.ts`, `fee-charge.test.ts`,
  `orchestrate.billing.test.ts`, `compose.test.ts`, `money-path.concurrency.test.ts`,
  `money-path.resilience.test.ts`, `orchestrate.test.ts`): **232/232 passed, 0 failed**.
- `npx tsc --noEmit`: exit 0, "TypeScript compilation completed".
- Migration `20260705000000_wkh136_fee_splits.sql` applied on ephemeral Postgres 15 (Docker,
  NOT prod) after replaying prior chain up to WKH-134: `a2a_fee_splits` created with all 12
  columns matching SDD §4.2 exactly (`orchestration_id UUID NOT NULL`, `bps INT CHECK[0,10000]`,
  `amount_usdc NUMERIC(18,6) CHECK>=0`, `status CHECK IN(...)`, `UNIQUE(orchestration_id,
  recipient_role)`), 3 indexes (`idx_a2a_fee_splits_{orch,owner,status}`), trigger
  `set_updated_at`, `relrowsecurity=t` (RLS enabled, no FORCE — deny-by-default per design).
  `a2a_agents.payout_wallet`/`referrer_ref` added nullable. Down-migration drops table +
  columns cleanly; re-applying up twice is idempotent (`NOTICE: already exists, skipping`,
  no errors). Container removed after check.

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (split en bps, Σ=10000) | PASS | `fee-split.ts:175-193` `computeSplits`; test `fee-split.test.ts:257-283` T-SPLIT (3 legs charged a 3 wallets, montos exactos) |
| AC-2 (Σ≠10000 fail-CLOSED) | PASS | `split-config.ts:103-107` throw `SplitConfigError`; test `split-config.test.ts:100-105` + `fee-split.test.ts:197-220` T-SUM (cero `sign`/`settle` invocados) |
| AC-3 (status por-recipient, nunca charged agregado con falla) | PASS | `fee-split.ts:320-327` agregado; test `fee-split.test.ts:287-309` T-PARTIAL (creator failed, platform charged, parent `failed`) |
| AC-4 (refund revierte TODOS los splits) | PASS | `fee-split.ts:627-657` `reverseFeeSplits` itera todos los `charged`; test `fee-split.test.ts:434-446` T-REV (3/3 reversed, 3 UPDATEs, no solo el primero) + ownership mismatch test (L448-455). Nota honesta: ledger-only (no clawback on-chain), documentado SG-7/§4.7 del SDD — v1 no se cablea a orchestrate/compose porque el fee se cobra post-success (mutuamente excluyente con refund, gating estructural en `orchestrate.ts:1064/1114`) |
| AC-5 (transparencia WKH-132 intacta) | PASS | `fee-charge.ts:188` `feeUsdc` sin cambio pre-splits; test `fee-split.test.ts:314-336` T-TRANSP (`feeUsdc` == `feeBase×rate` con splits activos) |
| AC-6 / SG-6 (recipient inválido → skip + reroute a platform) | PASS | `fee-split.ts:211-234` `resolveParty` reroutea bps a platform; test `fee-split.test.ts:341-385` T-FALLBACK (creator ausente → skipped, Σ==fee, settle no crashea) |

## BLQ-MED-1 (config asimetría entre call-sites)
**CERRADO** — confirmado en código y test:
- `fee-charge.ts:214-226`: `getSplitConfig()` envuelto en `try/catch`; `SplitConfigError` →
  `return {status:'failed', feeUsdc, error}` (NO throw). `ProtocolFeeError` (feeUsdc>budget)
  sigue siendo el único throw deliberado, documentado como excepción explícita.
- Test `fee-split.test.ts:197-220` (T-SUM): Σ≠10000 → `result.status==='failed'`, `mockSign`/
  `mockSettle` NUNCA llamados (fail-CLOSED intacto), simétrico con el try/catch de `/compose`
  (`compose.ts:611`). Un flujo estilo `/orchestrate/execute` (sin try/catch propio) ahora recibe
  el shape `failed` en vez de una excepción no capturada — no tumba una orquestación exitosa ya
  debitada.
- `auto-blindaje.md` documenta causa raíz + fix + regla generalizable.

## Money-path invariants
| Invariante | Status | Evidencia |
|---|---|---|
| Σbps==10000 fail-CLOSED | PASS | `split-config.ts:103-107`; T-SUM/T-WRITE (8 tests) |
| Dust → plataforma, Σ legs==fee exacto | PASS | `fee-split.ts:179-192` micro-USD entero; T-DUST (`fee-split.test.ts:237-252`) |
| Byte-idéntico con default (10000/0/0) | PASS | `fee-charge.ts:258` `settleFeeSplits` sólo se invoca si `extraRecipients.length>0 \|\| skipped.length>0`; con default ambos son 0 ⇒ cero invocación ⇒ cero writes a `a2a_fee_splits`. Confirmado indirectamente por `fee-charge.test.ts` (mocks `mockImplementationOnce` estrictos: 20/20 verde SIN tocar el archivo, CD-P7) + `resolveRecipients` unit test (`fee-split.test.ts:561-572`, 1 leg, 0 skipped) |
| Cero doble-cobro (a2a_protocol_fees + a2a_fee_splits) | PASS | Diseño híbrido documentado en `auto-blindaje.md` (2026-07-03): leg plataforma SIEMPRE por `a2a_protocol_fees` (PK única, sin cambios); legs adicionales por `a2a_fee_splits` con `UNIQUE(orchestration_id, recipient_role)` — CD-2 respetado, ninguna tabla reusa la PK de la otra |
| WKH-132 intacto | PASS | `orchestrate.billing.test.ts` + `fee-charge.test.ts` (suites de no-regresión existentes) verdes sin cambios de código, T-TRANSP arriba |
| Ownership Guard (owner_ref) | PASS | Toda query sobre `a2a_fee_splits` en `fee-split.ts` (`chargeLeg` L369-371/483-485, `markLegFailed` L555-557, `reverseFeeSplits` L615/636) filtra `owner_ref` |
| CD-6 (recipients server-side, no del body) | PASS | Test T-CD6 `fee-split.test.ts:459-478` — `referralWallet`/`splits` inyectados en el body son ignorados, transfer va a la wallet de env |

## Drift
- `git diff --name-only main...HEAD`: 10 archivos, TODOS dentro de Scope IN del Story File
  (migración up/down, `split-config.ts`+test, `fee-split.ts`+test, `fee-charge.ts`,
  `database.types.ts`, `.env.example`, `auto-blindaje.md`).
- Cero diff en call-sites (`src/routes/orchestrate.ts`, `src/services/orchestrate.ts`,
  `src/routes/compose.ts`, `src/services/compose.ts`) — confirmado (`git diff --stat` vacío).
- 2 commits, orden correcto (feature → fix-pack BLQ), sin reordering de waves.
- Limitación v1 (creador/referral → plataforma por firma sin agente primario) + MNR-2
  (`reverseFeeSplits` no cubre el leg de plataforma, vive en `a2a_protocol_fees`/WKH-129) +
  MNR-3 (`extrasFailed` no consultado en returns tempranos, inalcanzable en v1) documentadas
  en `auto-blindaje.md` con causa raíz y regla generalizable.

## Gates (CR / commit)
- `tsc --noEmit`: PASS (re-confirmado, ver Runtime checks).
- `npm test`: PASS 2342/2342 (re-confirmado — CR report no estaba en disco para esta HU; se
  ejecutó como evidencia primaria, ver Paso 4 excepción).
- `biome check` sobre archivos tocados: claimed verde en PR body; no re-ejecutado (no
  disponible AR/CR report en disco para esta HU al momento de F4 — ver nota abajo).

## Nota de proceso
No se encontraron `ar-report.md`/`cr-report.md` en `doc/sdd/138-wkh-136-atomic-splits-bps/`
al momento de F4. La evidencia de gates de este reporte se generó corriendo `tsc`/`vitest`
directamente (excepción del Paso 4: gate no confirmado por un CR report en disco). El
contenido del PR body describe los mismos números (2342 passed, tsc/biome verde),
consistente con lo re-verificado acá.

**Listo para DONE.**
