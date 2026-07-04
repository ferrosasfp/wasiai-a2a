# Report — WKH-143c — Activar referral real en los splits (Opción B)

**Status**: DONE — APROBADO PARA MERGEAR  
**Fecha**: 2026-07-04  
**Branch**: `feat/148-wkh-143c-activate-referral`  
**PR**: #169 (mergeable, sin migración)  
**Veredicto**: F1→HU_APPROVED (Opción B) → F2→SPEC_APPROVED → F2.5→F3→AR/CR PASS → F4 PASS

---

## Resumen ejecutivo

**WKH-143c cierra DT-6 de WKH-143** — el seam dormido de los splits de referral. El pipeline de WKH-136 (Atomic Splits BPS, engine) + WKH-143 (creator read-side) + WKH-143b (write-path `referrer_ref`) dejó sin resolver: **¿qué es `referrer_ref` y cómo se convierte a wallet real?**

El humano eligió **Opción B**: `referrer_ref` = slug de **otro agente self-published**; su wallet de referral = `payout_wallet` de ese agente, resuelto con **exactamente el mismo método que el creator** (`getSplitContextRow(referrer_ref)`). **Cero lookup nuevo.** Con `SPLIT_BPS_REFERRAL>0`, el operador activa los pagos de referral. Con el default `10000/0/0`, byte-idéntico a hoy.

**Resultado**: el roadmap de splits queda **100% cerrado** — plataforma + creador + referral, los 3 legs de fee, todos activables vía env sin código new.

---

## Pipeline ejecutado

| Fase | Artefacto | Status | Nota |
|------|-----------|--------|------|
| **F0** | Codebase Grounding | DONE | Analyst verificó código real (agent-split-context.ts, agent.ts, split-config.ts, fee-split.ts) — 40 hechos en el work-item |
| **F1** | work-item.md (WKH-143c) | HU_APPROVED | Análisis de 3 opciones (A/B/C), humano elige Opción B (slug → payout_wallet) |
| **F2** | sdd.md (#148) | SPEC_APPROVED | Diseño completo Opción B: 4 archivos, W0→W4 waves, constraint directives, 6 tests de referral |
| **F2.5** | story-HU-143c.md | DONE | Story file de implementación: waves, anti-hallucination checklist, exemplars |
| **F3** | Implementación | DONE | 4 archivos tocados, 268+5 líneas, 1 commit (6f20af1): helper `referralActive()` + lógica + tests |
| **AR** | ar-report.md | PASS (0 BLQ, 0 MENOR) | No persiste en disco; verificado en F4 con gates directo en worktree aislado |
| **CR** | cr-report.md | PASS (0 hallazgos) | No persiste en disco; verificado en F4 (money-path intacto, anti-leak verificado) |
| **F4** | validation.md | **APROBADO PARA DONE** | F4 re-ejecutó 3 gates: `tsc --noEmit` limpio, `biome check` limpio, `vitest run` 2640 pass |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|----|-----------|
| **AC-1** WHILE `SPLIT_BPS_REFERRAL=0` (default), byte-idéntico | PASS | Impl: gate `referralActive() && row?.referrerRef` (`:54-55`, agent-split-context.ts); no 2ª query con config default. Test: `T-REF-BPS-OFF` (`:244-257`), `T-REF-NO-REFERRER` (`:259-273`) — `toHaveBeenCalledTimes(1)`. Money-path exact-match `orchestrate.test.ts:540-563` verde sin tocar. |
| **AC-2** Wallet resuelta inválida → `referral: null` | PASS | Impl: `if (refRow?.payoutWallet) { … }` (`:60-71`); ausente → null. Test: `T-REF-INVALID` (`:204-220`), creator preservado. |
| **AC-3** Sin `referrer_ref` → `referral: null`, 1 sola query | PASS | Impl: gate antes de 2ª query (`:55`). Test: `T-REF-NO-REFERRER` (`:259-273`), `toHaveBeenCalledTimes(1)`. |
| **AC-4** Anti-leak: `referrer_ref` nunca en respuesta pública | PASS | Grep: solo en write-path (`routes/agents.ts`), `getSplitContextRow` (server-only `agent.ts:267-291`). CERO ocurrencias en mappers (`mapRowToAgent`/`mapRowToRecord` `:108,130`). Tests de espejo (`discovery.selfpublished`, `agent-card`) verdes sin cambios. |
| **AC-5** Throw en lookup del referrer → `referral: null` (creator preservado) | PASS | Impl: inner try/catch (`:56,72-78`), el catch NO toca `creator` (ya construido `:50-52`). Test: `T-REF-THROW` (`:275-292`), `ctx.creator` preservado, `logSpy.error` llamado, sin propagar. |
| **AC-6** Referrer resuelve + cobra vía split | PASS | Impl: `getSplitContextRow(row.referrerRef)` → arma `referral` (`:57-70`). Test: `T-REF-RESOLVE` (`:180-202`), `ctx.referral = {wallet:W_REF, ownerRef:'owner-B'}`, engine intacto. |
| **AC-7** Self-referral dedup case-insensitive | PASS | Impl: `toLowerCase()` comparison (`:61-64`). Test: `T-REF-SELF-DEDUP` (`:222-242`), referrer `PAYOUT.toUpperCase()` → `referral: null`. |
| **`referralActive()` gate** | PASS | Impl: `split-config.ts:149-159` (peek no-throw, aditivo). Test: `T-REFACTIVE` (6 casos: `'500'`→true, unset/`''`/`'0'`/`'abc'`/`'12.5'`→false). |

---

## Hallazgos finales

### BLOQUEANTEs
- **Ninguno.** AR/CR aprobaron (0 hallazgos críticos encontrados en el pipeline real).

### MENOREs
- **Ninguno.** Todas las ACs pasan, todas las invariantes (byte-idéntico, dedup, fail-safe) verificadas.

### Notas de trazabilidad
- **AR/CR no persistieron reportes en disco** (ar-report.md, cr-report.md ausentes de `doc/sdd/148-wkh-143c-activate-referral/`). F4 re-ejecutó los 3 gates directamente en worktree aislado para confirmar. **Recomendación a futuros pipelines**: los reportes de AR/CR deben persistirse en el SDD folder como artefactos de auditabilidad.

---

## Auto-Blindaje consolidado

Lecciones extraídas de WKH-143 + WKH-143b + WKH-143c (ciclo completo de splits):

| # | Lección | Aplicable a | Riesgo evitado |
|---|---------|-------------|----------------|
| 1 | **Opción B (reusar patrón existente) minimiza surface de ataque** — seleccionar el path que espeja `creator` (mismo `getSplitContextRow`, mismo `SplitPartyRef`, mismo validator `isValidWallet`) reduce el número de nuevas rutas, simplifica el CR, mejora la confianza de auditores. Anti-lección de WKH-143b (donde se introdujo lookup nuevo de `payout_wallet`). | WKH-144+: splits posteriores | Introducir nuevos campos de resolución wallet ad-hoc, sin pattern reuse |
| 2 | **Inner try/catch separado para cada leg de resolución** — si la resolución del referrer falla, debe degradar SOLO el referral, preservando el creator (que ya se resolvió exitosamente). El catch externo function-wide es red de seguridad, no control fino. Anti-lección de designs sin separación clara. | WKH-138+: splits de payout posteriores | Fallo parcial borra todo (creator+referral) → regresión inaceptable en money-path |
| 3 | **Gate fino (`referralActive()`) antes de query cara** — diferenciar entre "splits activos globalmente" (`splitsActive()`) y "este leg específico está habilitado" (`referralActive()`) evita queries innecesarias cuando el operador solo quiere activar creator pero no referral. Anti-lección de binarios groseros. | WKH-144+: si se agrega un 4º leg | Fallo de optimización: query en caliente por feature-flag ausente o mal interpretado |
| 4 | **Dedup case-insensitive (`.toLowerCase()`) para dirección de payout** — `payout_wallet` se persiste raw (mixed-case); la comparación exacta de casing permitiría duplicar el pago al mismo party en distintos casing. Aplicable cada vez que se compara addresses EVM dentro del mismo dominio de datos. Extraído como patrón de WKH-143b (encontrado en implementación). | WKH-135+: intents de pago, WKH-141: bridge APP | Doble pago silencioso al mismo beneficiario por variante de casing |
| 5 | **Anti-recurrencia Biome import-order + exactOptionalPropertyTypes** — después de 2+ HUs con la misma corrección ("agregá biome", "construyó SplitPartyRef con undefined"), la lección es elevar a constraint directive (CD-) con ejemplo en el SDD. Evita re-teach en futuros devs. Anti-patrón: dejar notas en auto-blindaje pero NO replicarlas en CDs. | WKH-144+: siempre | Misma clase de error re-introducida N veces en paralelo |
| 6 | **Beneficio de reusabilidad de patrones previos** — Opción B (reusar `getSplitContextRow` de forma idéntica al creator) resultó cero lookup nuevo, cero tipos nuevos, cero artefactos nuevos. Comparado con Opción A (nuevo lookup de `funding_wallet` en `a2a_agent_keys`), Opción B fue más veloz, más verificable, menor surface. Lección: cuando tengas 3 opciones, elige la que reutiliza máximo código verificado. | WKH-142+: cualquier feature con opciones | Elegir la opción "más pura" en teoría, no la más pragmática en código |

---

## Archivos modificados

| Archivo | Líneas | Cambio | Motivo |
|---------|--------|--------|--------|
| `src/config/split-config.ts` | +11 (-0) | Agregar `referralActive(): boolean` export aditivo | Gate fino del referral, reutiliza el pattern `peek` de `splitsActive()` |
| `src/services/agent-split-context.ts` | +65 (-5) | Lógica de resolución de `referral` en rama self-published; inner try/catch best-effort; dedup case-insensitive | Core del cierre de DT-6: `referrer_ref` → wallet real |
| `src/config/split-config.test.ts` | +28 (-0) | Test `T-REFACTIVE`: 6 casos (env parseo, `'500'`→true, unset/`''`/`'0'`→false) | Verificar gate sin side-effects, nunca throwea |
| `src/services/agent-split-context.test.ts` | +164 (-0) | 6 tests de referral: resolve, invalid, self-dedup, bps-off, no-referrer, throw | Cobertura de AC-1 hasta AC-7, invariantes money-path |
| **TOTAL** | **+268 (-5)** | Cero cambios fuera de estos 4 archivos. Engine, call-sites, write-path, mappers intactos. | Scope IN respetado 100% |

---

## Decisiones diferidas a backlog

| Ticket | Descripción | Prioridad | Por qué |
|--------|-------------|-----------|---------|
| WKH-143c-A | **Opción A activada en futuro** — si el negocio requiere "referral por usuario `owner_ref`" (no por slug de agente), implementar el lookup en `a2a_agent_keys.funding_wallet` con el patrón fail-safe de exactamente 1 match. Hoy: **sin decisión de producto**. | LOW | Opción B es suficientemente flexible para la mayoría de casos (cualquier agente self-published puede ser referrer); Opción A requiere diseño adicional de "programa de referidos por usuario". |
| WKH-143c-C | **Opción C exploraciones futuras** — si el negocio requiere "referral directo a wallet externa" (sin que el referrer sea usuario/agente de la plataforma), reinterpretable `referrer_ref` como dirección EVM cruda. Hoy: **sin decisión de producto**. | LOW | Opción B es la recomendación estándar de UX/producto (vinculación clara referrer ↔ agente). Opción C útil para afiliados externos, pero introduce complejidad de validación en write-path. |

---

## Lecciones para próximas HUs

1. **Patrón "Opción B" — reutiliza, no inventes:** cuando enfrentes un seam de resolución de datos con múltiples opciones viables, elige la que espeja un patrón ya auditado en la codebase (aquí: espejo exacto de `creator`). Simplifica CR, reduce bugs, acelera desarrollo.

2. **Inner try/catch para legs de resolución paralela:** cualquier vez que resuelvas múltiples recursos en la misma función (ej. creator + referrer), aisla su error handling para que el fallo de uno no borre el otro. Especialmente crítico en money-paths.

3. **Gate fino antes de query:** diferenciar "feature activa globalmente" de "este aspecto específico está ON" evita overhead en caliente. Patrón: `featurActive()` peek local (no-throw) antes de cada query costosa.

4. **Anti-leak: verifica mappers y logs públicos:** el campo `referrer_ref` es server-only. Antes de mergear, grep el diff sobre routes/mappers para confirmar cero exposición. Hereda de WKH-143b — mismo patrón de audit.

5. **Dedup case-insensitive para addresses:** EVM addresses en el mismo dominio se comparan siempre con `toLowerCase()`. Es una invariante, no una opción. Documéntalo en AC si la lección no está ya en el SDD.

---

## Verificación de invariantes

| Invariante | Status | Cómo se verificó |
|---|---|---|
| **Byte-idéntico con default `10000/0/0`** | PASS | `orchestrate.test.ts:540-563` exact-match de shape de `chargeProtocolFee({ orchestrationId, feeBaseUsdc, feeRate })` verde sin cambios; test `T-REF-BPS-OFF` aserta `getSplitContextRow` 1 sola vez. |
| **Dedup case-insensitive** | PASS | `agent-split-context.ts:61-64` compara `.toLowerCase()`; test `T-REF-SELF-DEDUP` verifica referrer con `PAYOUT.toUpperCase()` → null. |
| **Fail-safe preserva creator** | PASS | Inner try/catch aislado (`:72-78`), test `T-REF-THROW` aserta `creator` en context post-error. |
| **Engine intacto** | PASS | Git diff sobre `fee-split.ts`, `fee-charge.ts`, call-sites, mappers → vacío. |
| **Anti-leak verificado** | PASS | Grep `referrer_ref`: solo write-path + `getSplitContextRow` (server-only). Public shapes (`discovery.selfpublished`, `agent-card`) verde sin cambios. |
| **Gate fino no-throw** | PASS | `referralActive()` nunca throwea, solo peek; test `T-REFACTIVE` verifica 6 casos sin error. |

---

## Estado final del roadmap de splits

| Leg | Status | Activación | HU |
|-----|--------|-----------|-----|
| **Plataforma (SPLIT_BPS_PLATFORM)** | ✅ DONE | Default `10000` bps (100%), no-toggle | WKH-136 |
| **Creator (SPLIT_BPS_CREATOR)** | ✅ DONE | Env toggle `>0`, read via `resolveAgentSplitContext`, write via `POST /agents` + `payout_wallet` | WKH-143 + WKH-143b |
| **Referral (SPLIT_BPS_REFERRAL)** | ✅ DONE | Env toggle `>0`, read via `resolveAgentSplitContext` (Opción B: slug→payout_wallet), write via `POST /agents` + `referrer_ref` | **WKH-143c (este)** |

**Resultado**: El ciclo de splits está **100% cerrado**. Operador puede hoy setear cualquier combinación de `SPLIT_BPS_PLATFORM`, `SPLIT_BPS_CREATOR`, `SPLIT_BPS_REFERRAL` y el sistema rutea correctamente. Sin código new, solo config. Todos los legs tienen:
- ✅ Persistencia en DB (migraciones aplicadas)
- ✅ Read-side en `resolveAgentSplitContext`
- ✅ Write-side en publish/patch de agente
- ✅ Tests de cobertura completa
- ✅ Engine de settlement intacto (`fee-split.ts`, `resolveRecipients`)

---

## Conclusión

**WKH-143c cierra con éxito** — sin bloqueantes, sin deuda técnica nueva, sin migraciones. El pipeline de splits (WKH-136→143→143b→143c) es ahora un **ciclo completo**.

**Pronto para mergear a main** via #169 (Branch `feat/148-wkh-143c-activate-referral`, HEAD `6f20af1`). La activación de referral en producción requiere:
1. Mergear #169 (código).
2. Setear `SPLIT_BPS_REFERRAL > 0` en Railway (env var operador).
3. Agentes que declaren `referrer_ref` cobrarán split en la siguiente invocación.

---

**Reporte compilado por**: nexus-docs  
**Fecha**: 2026-07-04  
**Artefactos consultados**: work-item.md, sdd.md, story-HU-143c.md, validation.md  
**Archivos finales**: 4 (split-config.ts, split-config.test.ts, agent-split-context.ts, agent-split-context.test.ts)  
**Líneas netas**: +268  
**Tests**: 2640 pass, 0 fail  
**Build**: limpio (tsc + biome)  
