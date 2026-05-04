# QA Report — WKH-69 Kite Passport Hybrid

**QA Agent**: nexus-qa (F4) | **Date**: 2026-05-04 | **Branch**: feat/084-wkh-69-passport-hybrid-inbound @ 6679215 (post fix-pack iter 1)

## Veredicto
**APROBADO PARA DONE**

## Runtime checks
- 810/810 tests PASS (vitest 4.1.5, 63 files, 2.12s)
- DB state: N/A (payment_origin → existing JSONB column)
- Env parity: `PASSPORT_REQUIRE_INBOUND=` documented in `.env.example:65`, intentionally unset (CD-WKH69-1)
- requirePassport NOT mounted: `grep` en src/index.ts/app.ts/routes/ → 0 matches ✅

## AC Verification

| AC | Status | Evidencia archivo:línea |
|----|--------|---------|
| AC-1 (Passport sig zero-changes) | ✅ PASS | T-AC1-1 `:62` + T-AC1-2 `:73` (`x402.passport-shape.test.ts`); verify+settle `x402.ts:142-205` untouched |
| AC-2 (USDC mainnet asset) | ✅ PASS | `payment.ts:90-91` DEFAULT_PAYMENT_TOKEN_MAINNET (W0 verified, file untouched) |
| AC-3 (EIP-712 'USDC' domain) | ✅ PASS | `payment.ts:93` DEFAULT_EIP712_DOMAIN_NAME_MAINNET (W0 verified) |
| AC-4 (payment_origin metadata) | ✅ PASS | `event-tracking.ts:77-79` spread-conditional; T-AC4-1/2/3 `event-tracking.test.ts:232,264,293` |
| AC-5 (passport-onboarding.md) | ✅ PASS | 277 líneas, todas las secciones presentes incluido Security caveat `:124` |
| AC-6 (mock fixture Passport-shape) | ✅ PASS | `test/fixtures/passport-shape.ts:4-22` PASSPORT-MOCK-SHAPE block; T-AC6-1 `:106` round-trip |
| AC-7 (794+ baseline preserved) | ✅ PASS | 810/810, 0 fail (baseline 794 + 16 new) |
| AC-8 (backward-compat EOA) | ✅ PASS | T-AC8-1 `:142`, T-AC8-2 `:173`; `kite-ozone/` git diff empty |
| AC-9 (OPERATOR_PRIVATE_KEY untouched) | ✅ PASS | `git diff main..HEAD downstream-payment.ts cron/ kv.ts` → empty |
| AC-10 (requirePassport factory) | ✅ PASS at factory level | T-AC10-1..6c (8 tests `passport.test.ts:35-153`); NOT mounted (CD-WKH69-1) |

## Drift detection

- 14 archivos modificados, todos en Scope IN
- Order commits: W1 → W2 → W3 → W4 → fix-pack iter 1
- Zero archivos fuera de Scope IN

## Backward-compat audit

- `git diff main..HEAD` empty para: `downstream-payment.ts`, `kite-ozone/`, `cron/`, `kv.ts`, `services/event.ts`, `package.json`, `package-lock.json` ✅

## Gates

- Typecheck: tsconfig.build.json excluye *.test.ts → prod build clean
- Tests: 810/810 ✅ verified independent
- AR + CR + fix-pack iter 1: APROBADO

## Fix-pack iter 1 status

- ✅ AR MNR-1 (security caveat): doc + JSDoc agregados
- ✅ CR MNR-4 (header const): X_PASSPORT_SESSION_HEADER exportado, usado en fixture
- ✅ CR MNR-6 (doc anchors): line refs reemplazados por section anchors
- 📋 9 MNRs deferred a TD/follow-up backlog

## Smoke Test Procedure (gate humano post-merge)

Para ejecutar cuando user fondee Passport prod wallet `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3` con ~$5 USDC en chain 2366:

```bash
# 1. Verify kpass auth
kpass agent:session list --output json

# 2. Create session (max $1/tx, max $5 total, 30min TTL)
kpass agent:session create \
  --task-summary 'WKH-69 smoke test' \
  --max-amount-per-tx 1 --max-total-amount 5 --ttl 30m --assets USDC --output json
# → click approval_url, approve via passkey

# 3. Execute against prod
kpass agent:session execute \
  --url https://wasiai-a2a.up.railway.app/orchestrate \
  --method POST --body '{"goal":"echo","input":"smoke"}' --output json

# 4. Verify expected:
#    - HTTP 200 with orchestrate response
#    - Supabase: SELECT metadata->>'payment_origin' FROM a2a_events ORDER BY created_at DESC LIMIT 1
#      → 'passport'
```

Si HTTP 402: signature shape mismatch — capturar `payment-signature` base64, decodificar, abrir WKH-XX follow-up.
Si payment_origin='eoa': kpass CLI no inyectó `x-passport-session: true` header — abrir follow-up.

## Recomendación

**APROBADO → DONE**. 10/10 ACs PASS con evidencia archivo:línea. 0 drift. 810/810 tests. AR + CR + fix-pack iter 1 todos resueltos. Production-ready arquitecturalmente — smoke test E2E con fondos reales es gate humano post-merge.
