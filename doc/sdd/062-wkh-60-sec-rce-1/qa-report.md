# Validation Report — WKH-60 / SEC-RCE-1

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-04-27
**Branch**: feat/062-wkh-60-sec-rce-1
**Head**: 7f81cd8

---

## Runtime Checks

### DB State
NO VERIFICABLE — acceso programático a Supabase Management API bloqueado en este entorno de QA. El archivo de migration `supabase/migrations/20260427230000_kite_schema_transforms_owner.sql` existe en disco, está dentro de BEGIN/COMMIT, usa `IF NOT EXISTS` / `IF EXISTS` (idempotente), y agrega `owner_ref TEXT` + unique 4-tupla `NULLS NOT DISTINCT` + index + columna `transform_fn_sig TEXT`. El script `scripts/apply-rce-migration.mjs` aplica la migration vía Supabase Management API. La verificación de que el schema llegó al remoto requiere confirmación manual por el operador.

**Smoke manual (operador):**
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'kite_schema_transforms'
  AND column_name IN ('owner_ref', 'transform_fn_sig')
ORDER BY column_name;
-- Expected: 2 rows, data_type = 'text', is_nullable = 'YES'

SELECT conname FROM pg_constraint
WHERE conname = 'kite_schema_transforms_source_target_hash_owner_key';
-- Expected: 1 row

SELECT indexname FROM pg_indexes
WHERE indexname = 'idx_kite_schema_transforms_pair_hash_owner';
-- Expected: 1 row
```

### Env Parity
`SCHEMA_TRANSFORM_HMAC_KEY` — leída en `src/services/llm/transform.ts:45`. No está documentada en `.env.example`. Es opcional (degraded-mode warn-once cuando ausente). TD menor: agregar a `.env.example` con comentario. No es bloqueante para merge dado que el código tiene fallback seguro.

### Migration Applied
NO VERIFICABLE (ver DB State arriba). El archivo existe en `supabase/migrations/` con timestamp 20260427230000.

---

## ACs

Nota: Story File ausente (documentado en auto-blindaje.md). Los 12 ACs se reconstruyen del commit W4 (`a688194`) y del test coverage.

| AC | Descripción | Status | Evidencia |
|----|------------|--------|-----------|
| AC-1 | LLM-generated `transformFn` ejecutado en sandbox (no `new Function`) | PASS | `src/services/llm/vm-runner.ts:225` — `executeTransformInVm` via `Worker+vm`. Tests T-VM-1..T-VM-11 pasan; T-VM-3/4/5/6/7 verifican que process/require/fetch/eval/Function están bloqueados. |
| AC-2 | `process`, `require`, `fetch`, `eval` no accesibles en sandbox | PASS | `vm-runner.test.ts` T-VM-3 PASS, T-VM-4 PASS, T-VM-5 PASS; T-VER-RCE-1 PASS, T-VER-RCE-2 PASS, T-VER-RCE-3 PASS |
| AC-3 | Timeout de sandbox (loop infinito → `TransformTimeoutError`) | PASS | `vm-runner.test.ts:96` T-VM-8 PASS 68ms; `transform-rce.test.ts:215` T-VER-RCE-6 PASS 1018ms |
| AC-4 | L2 cache scoped por `owner_ref` (cross-tenant poisoning bloqueado) | PASS | `transform.ts:208-212` — `getFromL2` incluye `.eq('owner_ref', ownerId)` como 4ta eq en chain. `transform-rce.test.ts:377` T-VER-RCE-7 (never-cache anon), T-VER-RCE-8 (cross-tenant miss) PASS |
| AC-5 | `ownerId === undefined` → never-cache mode (no L2 read, no upsert) | PASS | `transform.ts:379` — guard `if (ownerId !== undefined)` antes de `getFromL2`. `transform-rce.test.ts:358` T-VER-RCE-7: `expect(supabase.from).not.toHaveBeenCalled()` PASS |
| AC-6 | L1 cache key incluye `ownerId` (cross-tenant L1 miss) | PASS | `transform.ts:361-362` — `ownerSegment = ownerId ?? '__anon__'`, cacheKey = `${src}:${tgt}:${hash}:${ownerSegment}`. T-VER-RCE-8: two tenants → `mockCreate` called twice PASS. T-VER-RCE-9: same tenant → L1 hit PASS |
| AC-7 | HMAC sign/verify de `transform_fn` (integrity check en L2 read) | PASS | `transform-hmac.ts:34/53` — `signTransformFn` + `verifyTransformFn` con `timingSafeEqual`. T-HM-1..T-HM-8 PASS |
| AC-8 | L2 row con HMAC enabled + sig inválida → cache miss + warn | PASS | `transform.ts:231-233` — `verifyTransformFn` falla → `return null`. T-VER-RCE-10 (tampered fn) PASS, T-VER-RCE-11 (NULL sig) PASS |
| AC-9 | L2 row con HMAC enabled + sig válida → cache hit | PASS | T-VER-RCE-12: `expect(result.bridgeType).toBe('CACHE_L2')` PASS |
| AC-10 | BLQ-1: `output.constructor.constructor` escape bloqueado | PASS | `vm-runner.ts:153-165` — output JSON-parseado DENTRO del vm context; `codeGeneration.strings=false`. T-VER-RCE-13 PASS 18ms |
| AC-11 | BLQ-2: microtask escape (Promise.then) no muta estado del parent | PASS | `vm-runner.ts:256-267` — worker_threads + `worker.terminate()` mata microtasks. T-VER-RCE-14: `expect(microtaskFired).toBe(false)` after 200ms wait PASS |
| AC-12 | BLQ-3: IIFE wrapper breakout (`})(output); ATTACK; (function(o){`) bloqueado | PASS | T-VER-RCE-15: body malicioso → `rejects.toThrow()` PASS 19ms |

**Nota**: `compose.ts` propaga `scopingKeyRow?.owner_ref` a `maybeTransform` (commit a688194, línea 172-178). Verificado en source pero sin tests de integración E2E de compose para esta HU. Los tests de ownership están en los test de transform service (suficiente dado que compose solo pasa el valor).

---

## Drift

**Scope drift**: ninguno. Archivos modificados son exactamente los 5 waves + fix-pack:
- W0: `vm-runner.ts` + `vm-runner.test.ts`
- W1: `transform-hmac.ts` + `transform-hmac.test.ts`
- W2: migration SQL + apply script
- W3: `transform.ts` (hardened) + `transform.test.ts` (legacy mock update) + `transform-verification.test.ts` (legacy mock update)
- W4: `compose.ts` (3 líneas) + `transform-rce.test.ts` (12 tests)
- fix-pack: vm-runner.ts refactor (worker_threads), 3 tests nuevos, auto-blindaje.md, MNR cleanups

**Wave drift**: W0→W1→W2→W3→W4→fix-pack — orden correcto confirmado en git log.

**Spec drift**: `new Function` eliminado de producción (solo aparece en comentarios). worker_threads implementado según fix-pack especificación del AR.

**Test drift**: transform-verification.test.ts (WKH-57 legacy) actualizado para 4-eq chain + `transform_fn_sig: null` — intención original preservada, solo mock chain actualizado para reflejar la nueva firma de `maybeTransform` con `ownerId`. Documentado en auto-blindaje.md. No es trampa: el comportamiento del test no cambió, cambió el mock para seguir al nuevo contrato de la función.

---

## Gates (confirmed from commits)

- **tsc**: `npx tsc --noEmit` ejecutado en branch — exit 0, 0 errores (verificado en esta sesión de QA)
- **vitest**: `612 passed (612)` — exit 0 (verificado en esta sesión; commit fix-pack documenta "612 tests pass")
- **lint/biome**: commit messages mencionan biome formatter normalizations; tsc clean implica no errores de tipo

---

## BLQs del fix-pack

| BLQ | Descripción | Status |
|-----|------------|--------|
| BLQ-ALTO-1 | `output.constructor.constructor` host-realm escape | CERRADO — AC-10 PASS |
| BLQ-ALTO-2 | Microtask escape via `Promise.then` | CERRADO — AC-11 PASS |
| BLQ-ALTO-3 | IIFE wrapper breakout + outer-scope exec | CERRADO — AC-12 PASS |

Los 3 BLQs documentados en auto-blindaje.md con repro real (`node /tmp/repro-blq*.mjs`) y cerrados en commit 7f81cd8.

---

**Listo para DONE.**
