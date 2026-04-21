# F4 QA Report — WKH-44 · 1% Protocol Fee Real Charge

**Fecha**: 2026-04-21
**Branch**: `feat/044-wkh-44-protocol-fee-real-charge`
**Commits verificados**: 4be2573 (W1), 03795c3 (W2), 5f4b2fe (W3)

---

## Veredicto

**APROBADO PARA DONE** — con observación no bloqueante:
la migration `20260421015829_a2a_protocol_fees.sql` existe y es SQL válido pero
**no fue aplicada al Supabase remoto** (Supabase CLI no disponible en el entorno
dev — documentado en `auto-blindaje.md`). Debe aplicarse antes del deploy. Los
tests pasan porque mockean supabase; la lógica de cobro en producción fallará
con `relation does not exist` hasta que se aplique la migration.

---

## 1. Runtime Checks

### 1.1 Tests

```
npm test → Test Files 41 passed (41) / Tests 379 passed (379) — 0 failing
```

Baseline mantenido (350+). Nuevos tests: 16 en `fee-charge.test.ts` (FT-1..FT-16 +
2 defensivos FT-8b/FT-8c) + 10 en `orchestrate.test.ts` (T-11..T-20) + actualizados
T-2 y T-7. Total 379 > 376 especificado en Story File.

### 1.2 TypeScript

```
npx tsc --noEmit → exit 0, 0 errores
npm run build → exit 0, dist/ generado
```

### 1.3 Migration State — CRITICO

**Estado**: NO APLICADA al remoto.

Evidencia directa (query via Supabase JS client contra dev remoto):
```
supabase.from('a2a_protocol_fees').select('*').limit(1)
→ {"code":"PGRST205","hint":"Perhaps you meant the table 'public.a2a_agent_keys'",
   "message":"Could not find the table 'public.a2a_protocol_fees' in the schema cache"}
```

**Causa**: Supabase CLI no instalado en entorno dev (documentado por el Dev en
`doc/sdd/044-wkh-44-protocol-fee/auto-blindaje.md:8-23`). El archivo SQL
`supabase/migrations/20260421015829_a2a_protocol_fees.sql` existe y es válido.

**SQL validity**: verificado manualmente contra el patrón de
`20260403180000_tasks.sql`:
- `CREATE TABLE IF NOT EXISTS` ✓ (idempotente, CD-I)
- PK `orchestration_id UUID PRIMARY KEY` ✓ (idempotencia DB-level, AC-8)
- CHECK constraint `('pending','charged','failed','skipped')` ✓
- `CREATE INDEX IF NOT EXISTS` x2 ✓
- `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER ... EXECUTE FUNCTION trigger_set_updated_at()` ✓
- `updated_at` trigger reutiliza función ya definida en `20260403180000_tasks.sql:7-13` ✓
- Sin FK a ninguna tabla (CD-J) ✓

**Acción requerida antes del merge**: operador debe ejecutar la migration contra
Railway/Supabase prod. Sin esto `chargeProtocolFee` fallará con
`relation 'a2a_protocol_fees' does not exist` — pero AC-6 (best-effort) garantiza
que `orchestrate` retorna HTTP 200 igual, con `feeChargeError: "DB_ERROR: ..."`.

### 1.4 Smoke Prod (read-only)

```bash
GET https://wasiai-a2a-production.up.railway.app/health
→ 200 {"status":"ok","version":"0.1.0","uptime":17860.73...} ✓

POST https://wasiai-a2a-production.up.railway.app/orchestrate (sin auth)
→ 402 {"error":"payment-signature header is required","accepts":[...]} ✓
```

Producción no rompió con los cambios de la branch anterior (SEC-01 en prod,
WKH-44 no está mergeado aún).

---

## 2. AC Coverage con Evidencia

| AC | Descripción | Archivo:línea | Test | Status |
|----|-------------|---------------|------|--------|
| AC-1 | budget=1.00 → compose recibe maxBudget=0.99 | `src/services/orchestrate.ts:405` (`maxBudget: budget - feeUsdc`) | `orchestrate.test.ts:409-421` (T-11) | PASS |
| AC-2 | post-success → transfer 0.01 a fee wallet | `src/services/orchestrate.ts:419-424` (invoca `chargeProtocolFee` cuando `pipeline.success`) + `src/services/fee-charge.ts:248-274` (sign+settle) | `orchestrate.test.ts:423-446` (T-12), `fee-charge.test.ts:226-263` (FT-10) | PASS (mock) / PENDING on-chain (WKH-45) |
| AC-3 | `protocolFeeUsdc` real = `budget * rate` | `src/services/orchestrate.ts:412` (`const protocolFeeUsdc = feeUsdc`) | `orchestrate.test.ts:175-199` (T-2), `orchestrate.test.ts:301-329` (T-7) | PASS |
| AC-4 | suite 350+ pasa | `npm test` → 379/379 PASS | — | PASS |
| AC-5 | wallet unset → skip silencioso | `src/services/fee-charge.ts:169-175` (`if (!walletAddress) return {status:'skipped'...}`) | `fee-charge.test.ts:207-223` (FT-9), `orchestrate.test.ts:467-485` (T-14) | PASS |
| AC-6 | transfer fail → no rompe orchestrate | `src/services/fee-charge.ts:254-258` (sign catch → `return {status:'failed',...}`) + `src/services/orchestrate.ts:417-434` (feeResult.status check, no throw) | `fee-charge.test.ts:311-344` (FT-13), `fee-charge.test.ts:347-370` (FT-14), `orchestrate.test.ts:487-506` (T-15) | PASS |
| AC-7 | feeUsdc > budget → throw 400 antes de discovery | `src/services/orchestrate.ts:246-250` (`if (feeUsdc > budget) throw new ProtocolFeeError(...)`) | `orchestrate.test.ts:508-521` (T-16 — verifica `ProtocolFeeError` + `discover` NOT called) | PASS |
| AC-8 | idempotency same orchestrationId → 1 solo charge | Migration PK `orchestration_id UUID PRIMARY KEY` + `src/services/fee-charge.ts:67` (`PG_UNIQUE_VIOLATION='23505'`) + `fee-charge.ts:229-233` (conflict → `already-charged`) | `fee-charge.test.ts:266-286` (FT-11), `fee-charge.test.ts:289-308` (FT-12), `orchestrate.test.ts:523-552` (T-17) | PASS |
| AC-9 | env var parsing con safety (NaN/rango/default) | `src/services/fee-charge.ts:90-110` (`getProtocolFeeRate()` con `Number.isFinite` guard) | `fee-charge.test.ts:98-178` (FT-1..FT-8c) | PASS |
| AC-10 | restart aplica nuevo valor (sin cache) | `src/services/fee-charge.ts:90-92` (lee `process.env.PROTOCOL_FEE_RATE` cada call, sin variable módulo) + `orchestrate.ts:244` (invoca `getProtocolFeeRate()` por request) | `fee-charge.test.ts:136-145` (FT-6), `orchestrate.test.ts:554-571` (T-18) | PASS |

**AC-2 nota**: La validación on-chain end-to-end NO puede ejecutarse hoy. Pieverse `/v2/verify` está caído (WKH-45 upstream bloqueante). Los tests con mock validan que `sign()` y `settle()` se invocan con los params correctos cuando `pipeline.success=true`. Estado: **PENDING UPSTREAM — validará cuando Pieverse vuelva (WKH-45)**.

---

## 3. Drift Detection

**Archivos modificados en la branch** (`git diff main...feat/... --name-only`):

```
.env.example
doc/sdd/044-wkh-44-protocol-fee/auto-blindaje.md     ← doc, esperado
src/services/fee-charge.test.ts                        ← Scope IN (W1+W2)
src/services/fee-charge.ts                             ← Scope IN (W1+W2)
src/services/orchestrate.test.ts                       ← Scope IN (W3)
src/services/orchestrate.ts                            ← Scope IN (W3)
src/types/index.ts                                     ← Scope IN (W1)
supabase/migrations/20260421015829_a2a_protocol_fees.sql ← Scope IN (W1)
```

**8 archivos** — coincide exactamente con Scope IN del Story File. El archivo de
auto-blindaje es documentación de proceso esperada.

**Scope OUT verificado vacío**:
```
git diff main...feat/... -- src/adapters/ src/middleware/ src/routes/ → (vacío)
```

Ningún archivo prohibido fue tocado.

---

## 4. CD-G Verification

```bash
grep -nE "^const\s+PROTOCOL_FEE_RATE\s*=" src/services/orchestrate.ts → (vacío)
```

El literal `const PROTOCOL_FEE_RATE = 0.01` fue eliminado. El único uso de
`PROTOCOL_FEE_RATE` en `orchestrate.ts` es un comentario explicativo en L31-32
(`// WKH-44 (CD-G): el PROTOCOL_FEE_RATE literal fue eliminado...`). CD-G: PASS.

---

## 5. Gates (confirmados del CR report — no re-ejecutados)

Los gates CR/AR fueron aprobados por nexus-adversary antes de F4. F4 confirma:
- `npm test` → 379/379 PASS (ejecutado en F4 para verificar regresión)
- `npx tsc --noEmit` → 0 errores (ejecutado en F4)
- `npm run build` → exit 0 (ejecutado en F4)
- lint: confirmado verde por CR (biome check — no re-ejecutado)

---

## 6. AC-2 Status Final

| Capa | Estado | Evidencia |
|------|--------|-----------|
| Mock validation (sign+settle invocados) | PASS | `fee-charge.test.ts:FT-10`, `orchestrate.test.ts:T-12` |
| On-chain validation live | PENDING | Pieverse `/v2/verify` down (WKH-45) |

---

## 7. Observaciones Post-QA (MENORes AR+CR — no bloqueantes)

Los siguientes MENORes fueron documentados por nexus-adversary y son
**observaciones para el backlog post-merge**. Ninguno bloquea DONE:

1. **MNR-7 (AR)**: Migration no aplicada al remoto antes del merge — operador
   debe ejecutar `supabase db push` o SQL manual antes del primer deploy con
   esta feature. Sin esto, `chargeProtocolFee` falla gracefully (AC-6) pero no
   cobra.
2. **MNR-1 (AR)**: Falta test para `status='pending'` en idempotency query
   (cubierto solo `charged` y conflict race).
3. **MNR-2 (AR)**: `feeChargeTxHash` ausente del `OrchestrateResult` type en
   early-return paths (no es bug, es por diseño — DC-D).
4. **MNR-3 (AR)**: `markFailed` no testea el path de "UPDATE falla" — best-effort
   implícito no cubierto en tests.
5. **MNR-4 (AR)**: No hay alerting cuando `feeChargeError` persiste — post-MVP.
6. **MNR-5 (AR)**: `status='skipped'` no se inserta en DB — por diseño (CD-2),
   pero no documentado explícitamente en SDD.
7. **MNR-6 (AR)**: Rate window `[0.0, 0.10]` hardcodeado en `fee-charge.ts:64-65`
   — sería mejor en constante nombrada (ya está como `MAX_FEE_RATE`).
8. **MNR-8 (AR)**: Falta test de `status='failed'` en idempotency retry path.
9. **MNR-1 (CR)**: `truncateError` no tiene test.
10. **MNR-2 (CR)**: Comentario en L305 `orchestrate.ts` menciona "AC8" pero se
    refiere al AC8 de otra HU (WKH-13), no al AC-8 de WKH-44.
11. **MNR-3 (CR)**: `feeUsdcToWei` podría tener un test unitario explícito
    (cubierto implícitamente por FT-16).

---

## 8. Acción Requerida Pre-Deploy

**BLOQUEANTE para producción** (no para el merge):

Aplicar la migration antes de activar `WASIAI_PROTOCOL_FEE_WALLET` en Railway:

```sql
-- Ejecutar en Supabase SQL Editor o via supabase db push
-- Archivo: supabase/migrations/20260421015829_a2a_protocol_fees.sql
```

Hasta que la migration se aplique, el feature funciona en modo "wallet unset"
(skip silencioso) — no hay regresión. El cobro real empieza únicamente cuando
el operador setee `WASIAI_PROTOCOL_FEE_WALLET` + aplique la migration.

---

## Veredicto Final

**APROBADO PARA DONE.**

Todos los ACs tienen evidencia de archivo:línea. 379/379 tests pasan. Build y tsc
clean. Scope OUT intacto. CD-G verificado. La migration no aplicada es
**no bloqueante para el merge** (los tests la mockean; AC-6 garantiza graceful
degradation en prod). El operador debe aplicarla antes de setear
`WASIAI_PROTOCOL_FEE_WALLET` en Railway.
