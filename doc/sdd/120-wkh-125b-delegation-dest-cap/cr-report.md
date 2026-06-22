# CR Report — WKH-125b (delegation dest-cap) — sección Adversary

> Modo: CR (Code Review). Foco: calidad, adherencia a patrones, mantenibilidad, cobertura.
> Branch: `fix/120-wkh-125b-delegation-dest-cap`. Exemplar maestro: fix de session key WKH-125.
> Cada hallazgo cita archivo:línea. Gates corridos localmente (conteo real abajo).

---

## Resumen ejecutivo

| Métrica | Valor |
|---------|-------|
| BLOQUEANTES | **0** |
| MENORES | **1** |
| Veredicto | **APROBADO con MENORs** |

Gates reales (corridos en esta sesión):
- `npx tsc --noEmit` → **0 errores** (`TSC_EXIT=0`)
- `biome check` scoped (7 archivos de la HU) → **0 errores** (`BIOME_EXIT=0`)
- `npm run lint` global → **1 info FIXABLE pre-existente** en `src/services/reputation.ts:116` (`lint/complexity/useLiteralKeys`), ajena a la HU (`git diff origin/main -- src/services/reputation.ts` vacío). Confirmado el claim del Dev.
- `npx vitest run` → **PASS (1622) FAIL (0)** (`VITEST_EXIT=0`). Coincide con el conteo declarado por el Dev.

---

## Checklist CR — punto por punto

### 1. Espejo del exemplar — OK
La migración up es espejo fiel del bloque `debit_session_and_parent` (`20260606000000_a2a_key_spend_policies.sql:157-232`):
- `DROP FUNCTION IF EXISTS ...(uuid, text, uuid, integer, numeric)` antes del CREATE → `...:17` vs exemplar `:157`.
- Dispatch condicional idéntico: `...:74-78` (`IF p_destination IS NOT NULL AND p_destination <> '' THEN PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination); ELSE PERFORM increment_a2a_key_spend(...)`) vs exemplar `:213-217`. Byte-idéntico salvo nombre de tabla/columna (`a2a_delegations`/`total_spent` vs `a2a_key_sessions`/`spent_usd`).
- Hardening de 6 params: `...:88-93` vs exemplar `:227-232`.
- TS service: `delegation.ts` agrega `destination?: string` (`:381`) y `p_destination: destination ?? null` (`:389`) + mapeo `DEST_CAP_EXCEEDED → DestCapExceededError` ANTES de los prefijos propios (`:392-396`) → espejo exacto de `key-session.ts:446/454/461-463`.
- Middleware: `a2a-key.ts:383-400` (forwarding condicional) + `:404-408` (402 mapping) son espejo near-byte-idéntico del branch session `a2a-key.ts:615-632` / `:637-639`.

Sin divergencias funcionales.

### 2. DRY / consistencia — OK
El dispatch condicional NO duplica lógica: reusa `debit_with_dest_policy` (intacto, CD-4) e `increment_a2a_key_spend` (intacto) vía `PERFORM`. El manejo de error en `budget.ts:191-194` sigue el mismo patrón que la rama session (`budget.ts:116-117`): primer branch `if (err instanceof DestCapExceededError) return { success:false, error:'DEST_CAP_EXCEEDED' }`. Consistente.

### 3. TS strict — OK
- Sin `any` en código nuevo. Los `as never` en los tests (`delegation.test.ts:452`, etc.) son el patrón del archivo para tipar el mock de `supabase.rpc`, idéntico a los tests pre-existentes — no es drift.
- Firma `destination?: string` correcta y opcional (`delegation.ts:381`) → las llamadas de 5 args siguen compilando (verificado: `tsc` 0).
- Import `DestCapExceededError` agregado en orden alfabético (`delegation.ts:41`). Imports en tests verificados: `budget.test.ts:63`, `a2a-key.test.ts:212`.
- Sin casts ocultos. `destination ?? null` correcto.

### 4. Migración — OK (con MNR-1 sobre comentarios, ver abajo)
- SQL legible, DROP+CREATE correcto, hardening presente (6 params en up, 5 en down).
- Down completo y simétrico: DROP-6 (`_down.sql:5`) → CREATE-5 (`:8-53`) → hardening-5 (`:56-61`). Reversible.
- **Rama ELSE (back-compat, CD-3)**: la LÓGICA EJECUTABLE es byte-idéntica al original (`20260601000000:95` → `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)`). El orden de pasos 1→2→3→4→5→6, los `RAISE EXCEPTION`, el `SELECT ... FOR UPDATE`, el `UPDATE total_spent` y el `RETURN` son idénticos. **No hay drift sutil en la lógica.**

### 5. Naming/consistencia — OK
`p_destination` (SQL), `DEST_CAP_EXCEEDED` (error_code), `DestCapExceededError` (error class) coherentes con WKH-125 en los 3 call-sites (service/budget/middleware) y en los tests.

### 6. Cobertura de tests — OK
Los 5 ACs tienen cobertura no-trivial:
- **AC-1**: `delegation.test.ts:448-463` (RPC → `DestCapExceededError`), `budget.test.ts` (success:false + NO receipt, `mockReceiptEmit` not called), `a2a-key.test.ts:1536-1577` (402 + 6º arg forwarded, `mockDebit` not called).
- **AC-2**: `delegation.test.ts:305` (fix aridad → `p_destination: null`), `a2a-key.test.ts:1580-1612` (sin `composeDestination` → exactamente 5 args).
- **AC-3**: `delegation.test.ts` (`expect.objectContaining({ p_destination: 'kite/translator' })`).
- **AC-4 (atomicidad e2e)**: `delegation-atomicity.real.test.ts:181-228` — débito real vía RPC que excede el cap → asserta ROLLBACK en parent budget, `total_spent` Y `a2a_key_dest_spend_ledger` (sin INSERT). Gateado por `INTEGRATION_TEST_DB_URL`. Test REAL, no mock. Columnas del INSERT de policy (`max_usd`, `window_type`, `window_secs`) verificadas contra el schema (`20260606000000:15-17`).
- **AC-5**: `delegation.test.ts:465-486` (`.message` NO contiene `'accum'`/`'cap 1'`).
- **Ambos call-sites testeados**: `budget.test.ts` (rama service) + `a2a-key.test.ts` (rama middleware step-0). 
- **Fixes de aridad**: `budget.test.ts:269` agrega `undefined` como 6º arg; `delegation.test.ts:305` agrega `p_destination: null`. Las aserciones de comportamiento NO se relajaron — siguen siendo `toHaveBeenCalledWith` posicional/objeto estricto. **Sin pérdida de cobertura.**

### 7. Segundo call-site (a2a-key.ts) — OK
- Forwarding condicional limpio (`:383-400`), espejo del branch session.
- TODO eliminado: el `TODO(WKH-125b)` original (era `a2a-key.ts:376-378`) fue reemplazado por el comentario que documenta el fix (`:375-382`). `grep TODO.*125b` → 0 hits.
- No rompe otros usuarios del step-0: el cambio está acotado a la rama `delegation` del middleware (post `mockLookupToken` → delegationRow). Las rutas master/session/x402/compose no se tocan. Suite verde lo confirma (1622 pass).

### 8. Gates declarados — CONFIRMADOS
Ver tabla de resumen. tsc 0, lint scoped 0, 1 lint pre-existente ajeno (reputation.ts), 1622 passed. **Todos coinciden con lo declarado por el Dev.**

---

## Hallazgos

### MNR-1 — Comment drift: el cuerpo del RPC perdió las referencias inline CD/AC del original
- **Severidad**: MENOR
- **Categoría**: Mantenibilidad / consistencia de documentación
- **Archivo:línea**: `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql:48-95` vs original `supabase/migrations/20260601000000_a2a_delegations.sql:69,78,86,92-94`
- **Descripción**: El cuerpo del RPC reescrito en la nueva migración limpió varios comentarios que el RPC original tenía inline, p.ej.:
  - original `:69` `-- 2. Ownership Guard a nivel DB (CD-2 — service usa SERVICE_ROLE).` → nuevo `:48` `-- 2. Ownership Guard a nivel DB.`
  - original `:78` `-- 3. ... (TOCTOU-safe, CD-10).` → nuevo `:56` `-- 3. ... (TOCTOU-safe).`
  - original `:86` `-- 4. Check del total acumulado (AC-8/CD-12) ...` → nuevo `:64` `-- 4. Check del total acumulado ...`
  La **lógica ejecutable es byte-idéntica** (verificado paso por paso); sólo se perdieron las referencias a CD/AC de la HU original (WKH-101/125) en los comentarios. El down migration (`_down.sql:23-51`) también usa la versión "limpia" de comentarios en lugar de copiar literal los del original.
- **Reproducción**: `diff <(sed -n '56,98p' 20260601000000_a2a_delegations.sql) <(sed -n '35,84p' 20260608000000_wkh125b_delegation_dest_cap.sql)` → las únicas diferencias son comentarios (refs CD/AC) + el dispatch del paso 5 (intencional). Cero diferencias de código ejecutable.
- **Impacto**: Bajo. No afecta runtime ni back-compat. Leve pérdida de trazabilidad: un futuro lector del RPC ya no ve a qué CD/AC responde cada guard. El Story File pedía "copia literal" del cuerpo (`story:84-85`, `:207`), y esto es una copia *funcionalmente* literal pero no *textualmente* literal en los comentarios.
- **Sugerencia**: opcional — restaurar las anotaciones `(CD-N/AC-N)` en los comentarios de los guards para preservar la trazabilidad histórica, o aceptarlo como deuda cosmética. NO bloquea: la semántica es correcta y la simetría con el exemplar de session (que también usa comentarios "limpios") es razonable. Si se acepta, documentarlo como decisión consciente.

---

## Veredicto final

**APROBADO con MENORs.**

- 0 BLOQUEANTES. La implementación es un espejo fiel del fix de session key WKH-125, cierra el bypass en AMBOS call-sites (service `budget.ts` + middleware step-0 `a2a-key.ts`), preserva back-compat byte-idéntico en la rama ELSE, y mapea el error sin filtrar el mensaje crudo de PG.
- 1 MENOR (MNR-1): comment drift en los comentarios del cuerpo del RPC (lógica intacta). No bloquea DONE; se decide ahora o backlog.
- Gates reales: tsc 0, lint scoped 0 (1 pre-existente ajeno en reputation.ts), vitest 1622 pass / 0 fail — todos confirmados.

El gate de CR PASA. Apto para avanzar a F4 (QA).
