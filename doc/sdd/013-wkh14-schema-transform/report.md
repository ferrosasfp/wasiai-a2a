# Report #013 — WKH-14 Schema Transform

**Fecha:** 2026-04-04  
**Status:** DONE  
**Branch:** feat/wkh-14-schema-transform  

---

## Resumen

Implementada la capa de transformación de schemas entre agentes en el pipeline `compose`. Claude Sonnet genera una función JS que mapea el output de step N al inputSchema esperado por step N+1. La transformación se cachea en dos niveles: L1 (in-memory Map) y L2 (Supabase `kite_schema_transforms`).

## Archivos creados/modificados

| Archivo | Acción | Líneas |
|---------|--------|--------|
| `src/services/llm/transform.ts` | CREADO | ~260 |
| `src/services/llm/transform.test.ts` | CREADO | ~195 |
| `supabase/migrations/kite_schema_transforms.sql` | CREADO | 14 |
| `src/types/index.ts` | MODIFICADO | +25 |
| `src/services/compose.ts` | MODIFICADO | +25 |
| `src/services/compose.test.ts` | MODIFICADO | +12 |

## AC Status

| AC | Status |
|----|--------|
| AC1: LLM genera transformFn | PASS |
| AC2: cache hit <50ms | PASS |
| AC3: persist en kite_schema_transforms | PASS |
| AC4: schemas compatibles → SKIPPED | PASS |
| AC5: cacheHit en StepResult | PASS |
| AC6: LLM error propagates | PASS |

## Quality Gates

- Build: PASS (tsc strict)
- Tests: 93/93 PASS
- No deps nuevas

## AR/CR Summary

- BLOQUEANTE: 0
- MENOR: 3 (new Function risk aceptable para hackathon, upsert race, isCompatible heuristic)
- CR: APPROVED

## Auto-Blindaje

| Wave | Error | Fix | Aplicar en |
|------|-------|-----|-----------|
| W2.tests | compose.test.ts importaba transform → process.exit por SUPABASE_URL | Agregar mock `./llm/transform.js` en compose.test.ts | Cualquier servicio que importe supabase transitivamente |
| W2.tests | Supabase mock chain con 2x .eq() no manejaba correctamente | Construir chain explícita: eq1 → {eq: eq2}, eq2 → {single} | Mocks con chains largas de Supabase |
| W2.tests | T-7 compose: resolveAgent llamado 3 veces (loop + transform check + budget) | Agregar tercer mockResolvedValueOnce | Recordar que transform check hace resolveAgent del siguiente step |
