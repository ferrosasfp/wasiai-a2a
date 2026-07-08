# Done Report — WKH-167 `a2a_protocol_fees.fee_total_usdc`

**Fecha cierre:** 2026-07-09 · **Commit:** 2b13d04 · **Status:** DONE

## Resumen ejecutivo

Agregada columna `fee_total_usdc` a `a2a_protocol_fees` para resolver ambigüedad de telemetría. La columna `fee_usdc` es SOLO la pata de plataforma post-splits (WKH-136); la nueva `fee_total_usdc` es el fee TOTAL del protocolo = `budget×rate` (la semántica que originó una auditoría falsa). Cambio aditivo: una línea en el INSERT de `fee-charge.ts:402`, una migración nullable. AR/CR rechazaron 1 BLQ en ronda 1 (backfill filtraba por `status='charged'`); fix-pack resolvió con `round(budget_usdc * fee_rate, 6)` incondicional. F4 QA: 5/5 ACs PASS. Migración aplicada a ambas DBs (bdwv+caldz) con validación 0-mismatched.

## Pipeline ejecutado

| Fase | Veredicto | Evidencia |
|------|-----------|-----------|
| **F0** | project-context cargado ✓ | `/home/ferdev/.openclaw/workspace/wasiai-a2a/.nexus/project-context.md` |
| **F1** | HU_APPROVED ✓ | `work-item.md` (scope, ACs EARS, DTs, CDs) |
| **F2** | SPEC_APPROVED ✓ | (no sdd.md; mini-HU por complejidad técnica baja) |
| **F2.5** | story-file ✓ | (integrado en work-item.md — grounding archivo:línea completo) |
| **F3** | Implementación ✓ | `src/services/fee-charge.ts:402` + migración `20260709*_wkh167_fee_total_usdc.sql` + `database.types.ts` tipado |
| **AR Ronda 1** | RECHAZADO (1 BLQ) | `ar-report.md:5-7`: backfill filtraba `status='charged'` → subcontaba filas con legs `failed` (amount_usdc≠0) → violaba AC-4 |
| **Fix-pack** | Resuelto | Backfill reemplazado por `round(budget_usdc * fee_rate, 6) WHERE fee_total_usdc IS NULL` (incondicional) |
| **AR Ronda 2** | APROBADO ✓ | `ar-report.md:15-18`: BLQ-MED-1 cerrado; MNR-1 (database.types.ts) cerrado; tsc 0, 2806 passed |
| **CR Ronda 1** | RECHAZADO (1 BLQ) | `cr-report.md:5-6`: mismo BLQ que AR (backfill charged-only) |
| **CR Ronda 2** | APROBADO ✓ | `cr-report.md:15-16`: post fix-pack; veredicto final APROBADO |
| **F4 QA** | APROBADO ✓ | 5/5 ACs PASS; migración verificada en bdwv+caldz; 0 null-mismatches; 2806 tests |

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `fee_total_usdc` insertado en `chargeProtocolFee` = `feeUsdc` (línea 202: `feeBaseUsdc × feeRate`, 6 decimales). Verificado en logs: insert payload contiene `fee_total_usdc` con valor esperado. |
| AC-2 | PASS | `fee_usdc` persistido como `platformAmount` (pata plataforma post-split, WKH-136). Sin cambios semánticos. Verificado: el money-path (`feeUsdcToWei(platformAmount)`) sigue siendo idéntico. |
| AC-3 | PASS | Migración `ADD COLUMN IF NOT EXISTS fee_total_usdc NUMERIC(18,6)` aplicada a ambas DBs. Cero regresión: no hay `SELECT *` sobre la tabla en el codebase; consultas existentes usan proyecciones explícitas. Filas viejas NULL hasta backfill. |
| AC-4 | PASS | Reconciliación `fee_usdc + Σ(a2a_fee_splits.amount_usdc) = fee_total_usdc` validada en bdwv+caldz post-backfill: 0 mismatches (34 filas bdwv + 124 filas caldz). |
| AC-5 | PASS | Cálculo del fee (`feeUsdc`, `getProtocolFeeRate`), splits (`computeSplits`/`resolveRecipients`/`settleFeeSplits`), y shape público `FeeChargeResult` intactos. Cambio estrictamente field adicional. |

## Hallazgos finales

**BLOQUEANTEs (AR Ronda 1):**
- BLQ-MED-1: Backfill filtraba `status='charged'` → subcontaba legs `failed`. RESUELTO en fix-pack.

**MENOREs:**
- MNR-1: `database.types.ts` no incluía `fee_total_usdc`. RESUELTO en fix-pack.

**Dinero-Seguro:**
- El monto on-chain sale de `feeUsdcToWei(platformAmount)` (línea 393), invariante a `fee_total_usdc`. La nueva columna es puramente observacional, sin cambio de path de cálculo/cobro.
- Reconciliación verificada: 158 filas (bdwv+caldz) en post-backfill sin drift.

## Migración verificada (Data Integrity)

```
bdwv:  34 filas actualizadas
  - 0 filas con fee_total_usdc aún NULL
  - 0 filas con fee_total_usdc ≠ round(budget_usdc * fee_rate, 6)
  
caldz: 124 filas actualizadas
  - 0 filas con fee_total_usdc aún NULL
  - 0 filas con fee_total_usdc ≠ round(budget_usdc * fee_rate, 6)

Total: 158 filas validadas sin drift.
```

## Archivos modificados

| Archivo | Cambio | Status |
|---------|--------|--------|
| `src/services/fee-charge.ts` | `:402` agregar `fee_total_usdc: feeUsdc` al INSERT | DONE |
| `supabase/migrations/20260709*_wkh167_fee_total_usdc.sql` | `ALTER TABLE a2a_protocol_fees ADD COLUMN fee_total_usdc NUMERIC(18,6)` + backfill | DONE |
| `supabase/migrations/20260709*_wkh167_fee_total_usdc_down.sql` | Reverso (DROP COLUMN) | DONE |
| `src/lib/database.types.ts` | Tipado `fee_total_usdc?: number` | DONE |
| `.env.example` | Doc: splits prod reales 8000/1500/500 (vs default 10000/0/0) | DONE |

## Decisiones diferidas a backlog

Ninguna. Las 2 preguntas del work-item (`[NEEDS CLARIFICATION]`) sobre backfill histórico y timing de aplicación a `caldz` fueron resueltas por el orquestador: SÍ backfill, SÍ aplicar ahora en ambas DBs. ✓

## Lecciones para próximas HUs

1. **Backfill condicional vs incondicional**: Al derivar un campo histórico, evitar filtros por status/estado de filas dependientes — si esa lógica cambia después, el backfill queda desincronizado. Usar fórmulas determinísticas (`budget×rate`) para reproducibilidad byte-a-byte.

2. **Ambigüedad de nombres en telemetría**: Los nombres de columna de dinero (`fee_usdc` vs `fee_total_usdc`) generan falsos positivos en auditorías si no hay reconciliación explícita documentada. En futuras HUs de dinero, incluir un diagrama de "money-path" (cómo fluye X desde el budget Y a través de splits/fees) en el work-item.

3. **Drift DB dev/prod**: La recomendación de aplicar migraciones en AMBAS DBs (`bdwv` + `caldz`) simultáneamente ahorra deuda técnica post-hoc. Precedente: WKH-155→164 (RLS leak) fue aplicado solo en bdwv al inicio; caldz quedó abierto meses.

4. **Fix-pack post-AR rechazado**: Un BLQ que toca el SQL de backfill requiere re-AR +1 (no IR directo a CR). El ciclo AR→fix→re-AR+CR en paralelo fue el camino correcto.

## Artifacts inmutables

- `work-item.md` — grounding F0, ACs EARS, DTs/CDs, SDD mini-mode confirmado, no-bloqueantes resueltos.
- `ar-report.md` — vectores money-path, aditividad, migración confirmada OK post fix-pack.
- `cr-report.md` — revisión arquitectónica, tests, env.example, scope, veredicto APROBADO.

---

**Cierre:** 2b13d04 mergeado a `main`. Migración aplicada a bdwv+caldz con validación cero-mismatches. Telemetría de fee ahora unívoca. Listo para producción.
