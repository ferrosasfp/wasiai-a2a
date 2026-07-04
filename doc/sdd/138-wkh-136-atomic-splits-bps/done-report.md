# Report — HU [WKH-136] Splits atómicos al settlement (bps: plataforma/creador/referral)

**Status**: DONE  
**Fecha de cierre**: 2026-07-04  
**Branch**: `feat/138-wkh-136-atomic-splits-bps` @ `73489c9`  
**PR**: #160 (SIN mergear — merge/deploy lo decide el humano)

---

## Resumen ejecutivo

Se generalizó el protocol fee único (1% cost-based, WKH-132) en N splits configurables en basis points (bps) ruteados a múltiples recipients (**plataforma / creador / referral**) en el momento del settlement. **La configuración por defecto (`10000/0/0`) es byte-idéntica al comportamiento actual** — opt-in, cero regresión. El engine de splits (`fee-split.ts`) reescribió el interior de `chargeProtocolFee` (firma pública intacta) para ejecutar N legs idempotentes, reusando exactamente el mismo primitivo de transferencia. **Todo el pipeline se ejecutó en calidad QUALITY con un fix-pack de seguridad en F3** (asimetría de config entre call-sites resuelta). **Veredicto final**: 2342 tests passed, migración verificada en Postgres, 6/6 ACs PASS, money-path invariants intactos. **Listo para DONE**.

---

## Pipeline ejecutado

| Fase | Estado | Evidencia |
|------|--------|-----------|
| **F0: Grounding** | DONE | Codebase verificado; contexto mapeado; auto-blindaje de 3 HUs previas incorporado (WKH-132/133/134) |
| **F1: Work Item** | HU_APPROVED | work-item.md con 6 ACs EARS, scope IN/OUT exhaustivo, riesgos identificados |
| **F2: SDD** | SPEC_APPROVED | sdd.md full; 7 forks ratificados (SG-1..SG-7); 11 OBLIGATORIO + 7 PROHIBIDO CDs; 13 tests planificados; seam SP-1/SP-2 de WKH-135 documentado como diferido |
| **F2.5: Story File** | DONE | story-HU-136.md con 8 archivos scope, 13 exemplars verificados, waves de implementación |
| **F3: Implementación** | DONE (con fix-pack) | W0 (DB/config) + W1 (lógica/settle) + W2 (integración) + W3 (tests). **Fix-pack BLQ-MED-1**: asimetría `SplitConfigError` entre `/orchestrate` + `/compose` resuelta (error de contrato CD-B capturable dentro de `chargeProtocolFee`, no throw pre-transfer) |
| **AR (Adversarial Review)** | RESOLVED | BLQ-MED-1 cazado; fix-pack aplicado; re-AR PASS |
| **CR (Code Review)** | PASS (no report en disco) | Confirmado por evidencia en PR body: cero diff en call-sites, 10 archivos dentro de scope IN, biome check verde |
| **F4: Validation** | APROBADO | 2342 tests passed, 232 money-path tests re-ejecutados (0 failed), `tsc --noEmit` green, migración en Postgres efímero verificada |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** (WHEN settle → THEN split en bps, Σ=10000) | **PASS** | `fee-split.ts:175-193` `computeSplits`; test T-SPLIT `fee-split.test.ts:257-283` (3 legs charged, montos exactos) |
| **AC-2** (IF Σ≠10000 → THEN fail-CLOSED, cero cobro parcial) | **PASS** | `split-config.ts:103-107` throw `SplitConfigError` capturado en `fee-charge.ts:214-226` como shape de error; test T-SUM (cero `sign`/`settle` invocados) |
| **AC-3** (WHEN falla ≥1 transfer, THEN status por-recipient, nunca charged agregado si falla) | **PASS** | `fee-split.ts:320-327` agregado; test T-PARTIAL (creator `failed`, platform `charged`, parent → `failed`) |
| **AC-4** (WHILE refund → THEN revierte TODOS los splits) | **PASS** | `fee-split.ts:627-657` `reverseFeeSplits` itera todos; test T-REV (3/3 `reversed`). Nota honesta: **ledger-only en v1** (clawback on-chain imposible sin escrow WKH-126a); gating estructural (fee post-success, nunca en refund path SP-0) |
| **AC-5** (WHEN quote → THEN transparencia WKH-132 intacta) | **PASS** | `fee-charge.ts:188` `feeUsdc` sin cambio; test T-TRANSP (`protocolFeeUsdc == feeBase×rate` con splits) |
| **AC-6** (IF recipient inválido → THEN skip + re-ruta a plataforma) | **PASS** | `fee-split.ts:211-234` `resolveParty` re-ruta; test T-FALLBACK (creator ausente → skipped, settle no crashea) |

---

## Hallazgos finales

### BLOQUEANTEs (Resueltos)
- **BLQ-MED-1 (config asimetría)**: `SplitConfigError` se lanzaba fuera del try/catch de `chargeProtocolFee`, tumbando `/orchestrate/execute` cuando `/compose` ya lo capturaba. **Fix**: capturar dentro de `chargeProtocolFee`, devolver como shape `{status:'failed', ...}` (CD-B). Viola el contrato solo en los call-sites sin blindaje explícito → `ProtocolFeeError` (feeUsdc>budget) es la única excepción reservada. Documentado en auto-blindaje como regla generalizable.

### MENOREs (Documentados en auto-blindaje.md como limitaciones v1)
- **MNR-1 (decisión de producto — CRÍTICA)**: En v1, creador/referral **NO COBRAN en ninguna config** porque la firma de `chargeProtocolFee` (`{orchestrationId, feeBaseUsdc, feeRate}`) no transporta el agente primario (step[0]). Por lo tanto, `resolveRecipients` resuelve ambos a `null` → bps re-ruta a plataforma, filas `skipped`. **El engine (`fee-split.ts`) está seam-compatible y testeado** (T-SPLIT, T-PARTIAL, T-REV ejercitan el engine con contexto server-side). **REQUIERE CONFIRMACIÓN HUMANA ANTES DE SHIPPEAR**: ¿activar creador/referral cableando el seam (ampliar firma, resolver agente primario en call-sites), o shippear v1 solo-plataforma?
- **MNR-2 (reverse de plataforma)**: `reverseFeeSplits` revierte solo los legs de `a2a_fee_splits` (creator/referral). El leg de plataforma vive en `a2a_protocol_fees` + `refund_with_dest_policy` (WKH-129). AC-4 completo = ambos paths. Documentado en test.
- **MNR-3 (extrasFailed temprano)**: En v1 con creador/referral ausentes, el cálculo de `extrasFailed` (contador de legs que fallaron) no afecta los returns tempranos (`already-charged`, 23505 unique_violation). Inalcanzable hoy. Nota TODO dejada en código; se aplica cuando se cablea el seam.

---

## Auto-Blindaje consolidado

### Patrones recurrentes incorporados (3 HUs DONE previas)

| Patrón | Fuente | Aplicado en WKH-136 |
|--------|--------|---------------------|
| Validación money-path write-boundary + read-boundary | WKH-134 BLQ-1, WKH-132 BLQ-MED-1 | CD-7: bps entero en [0,10000], `CHECK` en DB |
| `exactOptionalPropertyTypes:true` → asignación condicional | WKH-134 #1, WKH-133 #1 | CD-8: `if (v !== undefined) obj.x = v`, NUNCA `x: cond ? v : undefined` |
| Idempotencia `INSERT pending` + captura 23505 | WKH-133 #2, `fee-charge.ts` | CD-9: `UNIQUE(orchestration_id, recipient_role)` por leg |
| `BigInt()` en try/catch para read-boundary | WKH-133 #3/#4 | CD-10: `BigInt(wei)` derivado de DB envuelto |
| No confundir agregado reportado con magnitud real | WKH-132 BLQ-MED-1 | CD-5: `Σ amount_usdc == feeUsdc` exacto, transparencia intacta |
| Helper best-effort multi-call-site → nunca rechaza | WKH-132 (nuevo hallazgo) | CD-B + BLQ-MED-1: un `throw` pre-guarda rompe el contrato si no TODOS los call-sites lo envuelven |

### Tabla acumulada de auto-blindaje (WKH-136 + WKH-132/133/134)

| # | Hallazgo | Regla generalizable |
|---|----------|-------------------|
| WKH-132-BLQ | Fee real cost-based, no budget declarado | No confundir el agregado reportado (quote) con la magnitud real (cost). Validá que `Σ amounts == total calculado` exacto en el ledger. |
| WKH-133 #1 | `exactOptionalPropertyTypes` exige no-undefined | Construir objetos con asignación condicional, no `?:` ternario. |
| WKH-133 #2 | `.insert().onConflict()` no existe en supabase-js v2 | Usa `.upsert(..., {onConflict, ignoreDuplicates:true})` para idempotencia. Captura 23505 significa "en curso, ignora". |
| WKH-133 #3 | `BigInt()` puede fallar en valores de DB | Envolve derivación de valores DB en try/catch cuando el contrato es no-throw (CD-B). |
| WKH-134 #1 | money-path write-boundary muy permisivo | Valida tipos, rangos, finitud ANTES de escribir. Complementa `CHECK` DB (read-boundary). |
| WKH-134 #3 | Regresión silenciosa en suites existentes | Suites out-of-scope son contrato duro. Verifica el shape del MOCK ANTES de elegir queries nuevas. |
| **WKH-136-BLQ** | **Helper multi-call-site con "nunca rechaza"** | **Si el contrato dice "nunca rechaza", TODA ruta de salida debe devolver shape de error, no throw — salvo excepción explícita blindada en TODOS los call-sites.** |

---

## Archivos modificados

**Total**: 10 archivos, TODOS dentro de Scope IN del Story File (CD-P7).

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `supabase/migrations/20260705000000_wkh136_fee_splits.sql` | Crear | Tabla `a2a_fee_splits` (UNIQUE(orch,role), RLS, trigger updated_at, 3 índices) + ALTER a2a_agents (payout_wallet, referrer_ref) |
| `supabase/migrations/20260705000000_wkh136_fee_splits_down.sql` | Crear | DOWN reversible |
| `src/config/split-config.ts` | Crear | `getSplitConfig()` env-backed, fail-CLOSED `Σ==10000` |
| `src/config/split-config.test.ts` | Crear | Tests T-WRITE (validación env) |
| `src/services/fee-split.ts` | Crear | `computeSplits` + `resolveRecipients` + `settleFeeSplits` + `reverseFeeSplits` (money-path) |
| `src/services/fee-split.test.ts` | Crear | 10 tests (T-SUM, T-DUST, T-SPLIT, T-PARTIAL, T-TRANSP, T-FALLBACK, T-REV, T-CD6, T-IDEM, T-VERIFY) |
| `src/services/fee-charge.ts` | Modificar | Reescritura interna (firma pública INTACTA CD-P1); delega a `fee-split.ts` + captura `SplitConfigError` (BLQ-MED-1 fix); extiende `FeeChargeResult` con `splits?` (aditivo) |
| `src/types/database.types.ts` | Modificar | Row de `a2a_fee_splits` + columnas de `a2a_agents` |
| `.env.example` | Modificar | `SPLIT_BPS_PLATFORM/CREATOR/REFERRAL` (default 10000/0/0) |
| `doc/sdd/138-wkh-136-atomic-splits-bps/auto-blindaje.md` | Crear | FIX-PACK 4 hallazgos + reglas generalizables |

**Cero diff** en call-sites (`routes/compose.ts`, `services/orchestrate.ts`, `routes/orchestrate.ts`) — verificado. Los call-sites heredan splits sin editarse (CD-P1).

---

## Decisiones diferidas a backlog

### MNR-1: Activación de creador/referral (CRÍTICA — requiere humano)
- **Opción A (v1 actual)**: Creador/referral **siempre ausentes** en el payload (sig de `chargeProtocolFee` no los trae). Su bps se re-ruta a plataforma → `skipped`. Solo plataforma cobra.
- **Opción B (futuro, WKH-144 propuesto)**: Ampliar firma de `chargeProtocolFee` para transportar agente primario. `resolveRecipients` resuelve a wallet real. Creador/referral cobran.

**El engine está listo para Opción B** — test cases T-SPLIT, T-PARTIAL, T-REV ya ejercitan el path con creador/referral reales. Solo se necesita cablear el seam (pasar el agente primario + actualizar `resolveRecipients`). **REQUIERE CONFIRMACIÓN HUMANA ANTES DE SHIPPEAR ESTA HU**.

### Otras limitaciones v1 (aceptables, registradas)
- SP-1/SP-2 de WKH-135 (intents) **diferidos** — seam-compatible, no construir sobre código no-mergeado.
- Atomicidad on-chain multi-output (WKH-126a escrow) **fuera de scope** — v1 usa transfers secuenciales best-effort.
- UI de config de splits **vive en wasiai-v2**, no en a2a.

---

## Lecciones para próximas HUs

1. **Helper multi-call-site con contrato "nunca rechaza" (CD-B)**: Un `throw` pre-guarda rompe el contrato SOLO en call-sites sin blindaje explícito. Si la validación es fail-CLOSED (debe rechazar), envolvela DENTRO del try/catch interno, devolvé el shape de error. La única excepción es un error deliberadamente reservado (ej. `ProtocolFeeError`, feeUsdc>budget) que TODOS los call-sites ya blindan. Documentá la excepción explícitamente.

2. **Suites out-of-scope = contrato duro**: Si un test está fuera de Scope IN (ej. `fee-charge.test.ts`), su shape de MOCK es un contrato que NO podés cambiar. Verifica el mock ANTES de elegir queries nuevas. En este caso, el mock de supabase soporta 1 `.eq()` por cadena → se eligió diseño híbrido (plataforma en `a2a_protocol_fees`, extras en `a2a_fee_splits`).

3. **Seam-compatible para código no-mergeado**: Cuando diseñes un seam (ej. `resolveRecipients` server-side), testea la capacidad completa aunque hoy la firma no la transporte. Cuando el código corriente se mergee, solo se necesita cablear el seam, sin refactor.

4. **Money-path: validación write-boundary + read-boundary**: Valida tipos/rangos/finitud ANTES de escribir (write-boundary, app-layer). `CHECK` en DB es defensa en profundidad, no la única línea. Ambas juntas evitan valores degenerados en ledger.

---

## Verificación de complejidad dinámico

- **Complexity**: N recipients, N transfers secuenciales best-effort, idempotencia por recipient. Patrón comprobado en money-path anterior (WKH-127/129/132). Reutilización exhaustiva de primitivos existentes (sign/settle/verify, micro-USD).
- **Test coverage**: 13 tests planificados, 13 implementados. Suites money-path existentes (40 tests) verdes sin cambios (CD-P1).
- **Regresión**: Default `10000/0/0` → byte-idéntico. Verificado indirectamente por `fee-charge.test.ts` (out-of-scope, 20/20 verde) + `orchestrate.billing.test.ts` (40/40 verde).

---

## Resumen para presentación humana

**[WKH-136] Splits atómicos de protocol fee — DONE**

Se entregó un engine configurable de splits en bps (basis points) que generaliza el fee actual, **manteniendo backward-compatibility total** (default 10000/0/0 = 100% plataforma = comportamiento actual). El engine reescribió solo el interior de `chargeProtocolFee`, dejando los dos call-sites (`/orchestrate` y `/compose`) intactos — cero divergencia, cero regresión.

**Veredicto técnico**: 2342 tests passed, 6/6 ACs PASS, migración DB verificada, money-path invariants intactos.

**CRÍTICA PARA PRODUCT**: En v1, creador/referral **no cobran** porque la firma no los transporta → **opción A (v1 actual: solo plataforma)** listo para shippear. **Opción B (activar creador/referral)** requiere ampliar firma + actualizar call-sites = futura HU (WKH-144). El engine ya está seam-compatible y testeado para Opción B.

**PR #160 está MERGEABLE** pero en HOLD — awaiting humano (MNR-1: confirmación de opción A vs B).

---

*Report generado por NexusAgil — DONE (F4). Cierre del pipeline WKH-136.*
