# Validation Report — WKH-143 v1 (Activar splits creator/referral)

**Veredicto**: APROBADO PARA DONE (con 1 nota de proceso, no bloqueante)
**Fecha**: 2026-07-04
**Branch/PR**: `feat/144-wkh-143-activate-creator-referral-splits` @ `003667b` (PR #165)

## Nota de proceso (no bloqueante)
No se encontró `ar-report.md` ni `cr-report.md` en disco, ni reviews en el PR
(`gh pr view 165 --json reviews` → `[]`). Por lo tanto **no hubo AR/CR
documentado** antes de F4, en violación de la Regla de proceso #3/#5 de
CLAUDE.md ("CR siempre cita archivo:línea", "sub-agentes son obligatorios").
Ante la ausencia, QA ejecutó los 3 gates (tsc/vitest/biome) de cero en un
worktree aislado (excepción explícita de la regla "no re-ejecutar gates") y
además hizo el spot-check de invariantes money-path que normalmente cubre CR
(CD-9 no-throw-in-callsite, CD-5 no-leak). Todos verdes — ver evidencia abajo.
**Se recomienda al orquestador correr AR+CR retroactivamente antes del merge**,
aunque el código en sí no muestra hallazgos.

## Runtime checks (worktree aislado, sin tocar el working tree principal)
- `npx tsc --noEmit` → `TypeScript compilation completed`, exit 0.
- `npx vitest run` (suite completa) → `PASS (2539) FAIL (0)`.
- `npm run lint` (biome check src/) → `Checked 284 files in 89ms. No fixes applied.` ✅ (el gate que rompió en WKH-142 — confirmado verde acá).
- No aplica DB/migration check: esta HU no agrega migraciones (`git diff main...branch --name-only` sin `supabase/migrations/`).

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (resolver primario ambos call-sites) | ✅ | `src/services/orchestrate.ts:1079-1085` (`if (splitsActive())` → `resolveAgentSplitContext(pipeline.steps[0]?.agent)`); `src/routes/compose.ts:584-590` (`resolveAgentSplitContext(result.steps[0]?.agent)`). |
| AC-2 (registry externo → payTo cobra) | ✅ impl: `src/services/agent-split-context.ts:51-68` (payTo canónico → fallback `payment.contract`, `ownerRef=agent.slug`). Test: `src/services/agent-split-context.test.ts:56-73` (T-CTX-REG, 2 casos: payTo + fallback). |
| AC-3 (self-published → payout_wallet) | ✅ impl: `src/services/agent-split-context.ts:43-48` + `src/services/agent.ts:241-261` (`getSplitContextRow`). Test: `src/services/agent-split-context.test.ts:85-97` (T-CTX-SELF, `ownerRef=row.owner_ref`). |
| AC-4 (sin wallet → SG-6 a plataforma) | ✅ impl: `agent-split-context.ts` retorna `creator:null` en ambas ramas sin wallet. Test: `agent-split-context.test.ts:76-119` (T-CTX-MISS ×3: registry sin payTo, self-published payout_wallet null, row no encontrada) + `src/services/fee-charge-splits.test.ts:223-242` (T-FALLBACK-SG6: fila `skipped`, `platformLeg.amountUsdc===feeUsdc`, `status:'charged'` — cobro NO aborta). |
| AC-5 (byte-idéntico default) | ✅ Estructural: `orchestrate.test.ts:557-561` (T-12, exact-match `toHaveBeenCalledWith({orchestrationId, feeBaseUsdc, feeRate})`, sin editar el archivo) verde tras el cambio. `fee-charge-splits.test.ts:312-...` (T-BYTEID: default 10000/0/0 → 1 leg plataforma, cero writes a `a2a_fee_splits`). Suites no tocadas: confirmado `git diff main...branch --name-only` NO incluye `orchestrate.test.ts`/`orchestrate.billing.test.ts`/`compose.fee.test.ts`/`fee-split.test.ts`/`fee-charge.test.ts`. |
| AC-6 (MNR-3, extrasFailed en 3 returns tempranos) | ✅ impl: `src/services/fee-charge.ts:344-357` (`existing.status==='charged'`), `:365-375` (`'pending'`), `:402-413` (`23505`) — los 3 chequean `extrasFailed !== undefined` antes del `already-charged`. Tests: `fee-charge-splits.test.ts:245-266` (T-MNR3-CHARGED), `:269-287` (T-MNR3-PENDING), `:290-310` (T-MNR3-23505) — los 3 `expect(result.status).toBe('failed')`. |
| AC-7 (steps vacío → sin contexto) | ✅ impl: `agent-split-context.ts:40` (`if (!agent) return {creator:null, referral:null}`). Test: `agent-split-context.test.ts:49-53` (T-CTX-NOAGENT) + verifica que `getSplitContextRow` NO se llama. |

## Invariantes money-path

| Invariante | Status | Evidencia |
|---|---|---|
| Byte-idéntico con default `10000/0/0` | ✅ | Gate estructural `splitsActive()` (`src/config/split-config.ts:126-136`) — con default, helper no corre → `feeParams` queda exactamente `{orchestrationId, feeBaseUsdc, feeRate}` (`orchestrate.ts:1087-1093`, `compose.ts:592-598`, asignación condicional CD-8). Confirmado por T-12 exact-match (arriba) + T-BYTEID (cero writes a `a2a_fee_splits`). |
| CD-9 (sin `getSplitConfig()` en call-site) | ✅ | `grep getSplitConfig src/services/orchestrate.ts src/routes/compose.ts` → 0 matches. Solo se usa el peek NO-throw `splitsActive()`. No reintroduce BLQ-MED-1. |
| CD-5 (payout_wallet/referrer_ref no expuestos) | ✅ | `grep -rn payout_wallet\|referrer_ref src/` (excl. tests) → solo aparece en `agent-split-context.ts` (comentarios/uso interno) y `agent.ts:236-261` (`getSplitContextRow`, select acotado a 3 columnas). `AgentRow` interno (`agent.ts:42-53`) sigue SIN esas columnas; `mapRowToAgent`/`mapRowToRecord` (`agent.ts:107-148`) no las serializan. |
| Σbps fail-closed intacto | ✅ | `getSplitConfig()` (`split-config.ts:86-110`) sin modificar — sigue viviendo únicamente dentro de `fee-charge.ts:227-239` (try/catch → `SplitConfigError` → `{status:'failed'}`, nunca throw fuera). |
| CD-6 (`fee-split.ts` intacto) | ✅ | `git diff main...branch --name-only` NO incluye `fee-split.ts`. |

## Drift
- Archivos modificados = exactamente los 9 de la tabla "Files to Modify/Create" del Story File + `auto-blindaje.md` (artefacto de proceso esperado). Sin archivos fuera de Scope IN.
- Sin migraciones SQL (`supabase/migrations/` no aparece en el diff) — confirma "sin migración" del enunciado.
- "Creator self-published nunca cobra" y "referral inactivo" están documentados como comportamiento esperado v2/Scope OUT (DT-4/DT-6 del work-item y SDD) — no es regresión, coincide con lo verificado en código (payout_wallet/referrer_ref sin write-path, `referral` siempre `null` en `agent-split-context.ts:69`).
- Waves respetadas: commit único `003667b` pero el diff interno sigue el orden W0→W1→W2→W3 documentado en el Story File.

## Gates
- typecheck: ✅ (ejecutado por QA en worktree — sin CR report que confirmar).
- tests: ✅ 2539 passed / 0 failed (full suite) + 160 passed en el subset de archivos de esta HU + no-regresión.
- lint (biome): ✅ 284 files, sin fixes — gate que había fallado en WKH-142, confirmado verde acá.
- build: no ejecutado (no aplica cambio de build config; tsc --noEmit ya cubre compilación de tipos del código fuente).

## AR/CR follow-up
- No hay `ar-report.md`/`cr-report.md` — ver "Nota de proceso" arriba. Ningún BLQ/MNR pendiente que QA haya podido leer porque no existen; QA no encontró hallazgos propios al revisar CD-9/CD-5/CD-6 directamente.

**Listo para DONE** (recomendar al orquestador dejar constancia del gap de AR/CR en el done-report).
