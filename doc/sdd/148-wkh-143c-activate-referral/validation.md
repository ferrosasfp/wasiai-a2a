# Validation Report — WKH-143c (Activar referral, Opción B) (COMPACT)

**Veredicto**: F4: PASS — APROBADO PARA DONE
**Fecha**: 2026-07-04
**Branch**: `feat/148-wkh-143c-activate-referral` @ `6f20af1` (PR #169)
**Método**: worktree aislado (`git worktree add` @ 6f20af1), sin tocar el árbol principal.

## Runtime checks
- `npx tsc --noEmit` → limpio (0 errores).
- `npm run lint` (biome check src/) → `Checked 300 files. No fixes applied.`
- `npx vitest run` (suite completa, worktree) → `2640 pass / 0 fail` (coincide con lo declarado en el PR body; no hay cr-report.md/ar-report.md en disco para leer — ver nota).
- Migraciones: `git diff main...HEAD -- supabase/migrations/` → vacío. Confirmado sin migración.
- Diff real: `git diff main...HEAD --stat` → exactamente los 4 archivos del Story File §2 (268 insertions / 5 deletions). Cero archivos fuera de scope.
- Engine/call-sites/write-path intactos: `git diff main...HEAD -- src/services/fee-split.ts src/services/fee-charge.ts src/services/orchestrate.ts src/routes/compose.ts src/routes/agents.ts src/services/agent.ts` → vacío (CD-P1/CD-P4 respetados).

## ACs (evidencia archivo:línea, impl + test)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (byte-idéntico + 1 sola query) | PASS | Impl: `src/services/agent-split-context.ts:54-55` (gate `referralActive() && row?.referrerRef` ANTES de la 2ª query). Test: `agent-split-context.test.ts:244-257` (`T-REF-BPS-OFF`) y `:259-273` (`T-REF-NO-REFERRER`) → `expect(mockGetSplitContextRow).toHaveBeenCalledTimes(1)` — ambos verdes. Money-path: `orchestrate.test.ts:540-563` (`T-12`) exact-match `chargeProtocolFee({orchestrationId,feeBaseUsdc,feeRate})` verde sin tocar. |
| AC-2 (referrer inválido→null) | PASS | Impl: `agent-split-context.ts:60-71` (`if (refRow?.payoutWallet)` — ausente → `referral` queda `null`). Test: `T-REF-INVALID` `agent-split-context.test.ts:204-220` verde, `creator` intacto. |
| AC-3 (sin referrer_ref→null) | PASS | Impl: `agent-split-context.ts:55` (`row?.referrerRef` falsy → gate no entra). Test: `T-REF-NO-REFERRER` `:259-273` verde, `toHaveBeenCalledTimes(1)`. |
| AC-4 (anti-leak) | PASS | `grep referrer_ref/referrerRef src/routes/ src/services/agent.ts` → solo write-path (`routes/agents.ts`) y `getSplitContextRow` (server-only, `agent.ts:267-291`); cero ocurrencias en `mapRowToAgent`/`mapRowToRecord` (`agent.ts:108,130`). Mappers no tocados (fuera del diff de 4 archivos). Tests de espejo intactos: `discovery.selfpublished.test.ts` + `agent-card.test.ts` verdes sin cambios (corridos en worktree). |
| AC-5 (throw→null preservando creator) | PASS | Impl: `agent-split-context.ts:56,72-78` (inner try/catch — el `catch` no toca `creator`, ya construido en línea 50-52). Test: `T-REF-THROW` `agent-split-context.test.ts:275-292` verde — `ctx.referral` null, `ctx.creator` = `{wallet:PAYOUT, ownerRef:'owner-A'}` preservado, `logSpy.error` llamado. |
| AC-6 (referrer resuelve+cobra) | PASS | Impl: `agent-split-context.ts:57-70` (`getSplitContextRow(row.referrerRef)` → `referral = {wallet, ownerRef}` si no self-referral). Test: `T-REF-RESOLVE` `:180-202` verde — `ctx.referral = {wallet:W_REF, ownerRef:'owner-B'}`, `getSplitContextRow` llamado con `'A'` y `'B'`. Engine/call-sites que consumen `referral` no tocados (confirmado arriba). |
| AC-7 (self-referral dedup case-insensitive) | PASS | Impl: `agent-split-context.ts:61-64` (`refRow.payoutWallet.toLowerCase() === creatorWallet.toLowerCase()`). Test: `T-REF-SELF-DEDUP` `:222-242` verde — referrer con `PAYOUT.toUpperCase()` (mismo address, casing distinto) → `ctx.referral` null. |
| `referralActive()` gate | PASS | Impl: `src/config/split-config.ts:149-159` (peek no-throw, aditivo, `splitsActive()`/`getSplitConfig()` intactos — `git diff` sobre esas funciones vacío salvo el nuevo export). Test: `T-REFACTIVE` `split-config.test.ts` (6 casos: `'500'`→true, unset/`''`/`'0'`/`'abc'`/`'12.5'`→false) — todos verdes, corridos con reporter verbose. |

## Invariantes money-path

| Invariante | Status | Evidencia |
|---|---|---|
| Byte-idéntico default | PASS | `orchestrate.test.ts:557-561` exact-match verde sin cambios; `T-REF-BPS-OFF`/`T-REF-NO-REFERRER` confirman 1 sola query con config creator-only/default. |
| Dedup case-insensitive | PASS | `agent-split-context.ts:61-64` + `T-REF-SELF-DEDUP` verde. |
| Fail-safe preserva creator | PASS | `agent-split-context.ts:56,72-78` (inner try/catch aislado del `creator` ya construido) + `T-REF-THROW` verde. |
| Engine intacto (fee-split/fee-charge + call-sites + mappers) | PASS | `git diff main...HEAD -- fee-split.ts fee-charge.ts orchestrate.ts compose.ts routes/agents.ts agent.ts` → vacío. |
| No auto-activación | PASS | `referralActive()` exige `SPLIT_BPS_REFERRAL` parseable `>0` (`split-config.ts:149-159`); con env ausente/`0` el gate en `agent-split-context.ts:55` no entra — `T-REF-BPS-OFF` lo confirma con `toHaveBeenCalledTimes(1)`. |

## Drift
- Archivos tocados = exactamente los 4 del Story File §2 (`split-config.ts`, `split-config.test.ts`, `agent-split-context.ts`, `agent-split-context.test.ts`). Ningún archivo fuera de Scope IN.
- Un solo commit (`6f20af1`) — orden de waves no verificable por commit granular, pero el contenido del diff sigue exactamente la secuencia W0→W1→W2→W3 descrita en el Story File (helper aditivo → lógica → tests → verificación).
- Suite existente (T-CTX-*/T-143B-*) intacta y verde, sin modificaciones de asserts — confirmado leyendo el archivo completo.

## Gates
- `tsc --noEmit`: PASS (ejecutado en worktree, ver arriba).
- `lint` (biome): PASS (ejecutado en worktree, ver arriba).
- `vitest run` (suite completa): PASS 2640/2640 (ejecutado en worktree, ver arriba).
- **Nota de proceso**: no se encontró `ar-report.md` ni `cr-report.md` en `doc/sdd/148-wkh-143c-activate-referral/` — el prompt de lanzamiento declara AR/CR aprobados (0 BLQ/0 MENOR) pero no hay artefacto en disco ni PR reviews (`gh pr view 169 --json reviews` → `[]`) para confirmarlo por lectura. Por esto F4 re-ejecutó los 3 gates directamente en worktree aislado (no fue overlap — fue la única forma de confirmar, dado el gap de reportes) en vez de solo leerlos. Resultado real: todos verdes. Se recomienda a `nexus-docs` dejar constancia de este gap de trazabilidad en el reporte final (AR/CR corrieron pero no persistieron su reporte).

**Listo para DONE.**
