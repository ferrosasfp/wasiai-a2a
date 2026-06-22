# Validation Report — WKH-SEC-02b (DENSE)

**HU**: #119 — WKH-SEC-02b: Ownership Guard DB-level en `increment_a2a_key_spend`
**Branch**: `feat/119-wkh-sec-02b-owner-ref-rpc` (working tree, no commit yet — archivos en disco verificados)
**Reviewer**: nexus-qa F4
**Fecha**: 2026-06-22
**Veredicto**: APROBADO PARA DONE
**Resumen**: 6/6 ACs PASS. 0 hallazgos runtime críticos. 2 MNR cosméticos AR/CR aceptados como TD.

---

## Runtime Checks

### R-1 — Guard posición en la migración UP (CD-5)

Archivo: `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql`

Verificado por inspección directa de la migración:

- L40-42: `IF NOT FOUND THEN RAISE EXCEPTION 'KEY_NOT_FOUND...' END IF;`
- L47-49: guard insertado DESPUÉS del IF NOT FOUND y ANTES del `IF NOT v_row.is_active`:
  ```sql
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;
  ```
- L51: `IF NOT v_row.is_active THEN ...`

Posición conforme a DT-2/CD-5. Guard bajo lock FOR UPDATE (L35-38). RAISE EXCEPTION hace rollback de la tx (no hay UPDATE si falla).

### R-2 — DROP de 3-param precede al CREATE de 4-param (CD-1 / BLQ-MED-1)

`supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql:15`:
```sql
DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric);
```
`...:20`: `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(... p_owner_ref TEXT ...)`

El DROP de la firma de 3 params está en L15, el CREATE de 4 params en L20. Orden correcto. No queda sobrecarga 3-arg sin guard.

### R-3 — Dispatch 125b preservado en debit_delegation_and_parent (CRÍTICO)

`supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql:307-312`:
```sql
  -- CD-10: dispatch 125b PRESERVADO. Solo el branch ELSE pasa p_owner_ref al PERFORM.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;
```

Branch IF (debit_with_dest_policy con p_destination) intacto. SOLO el ELSE agregó `p_owner_ref` a increment. El bypass de 125b NO se reintroduce.

Idéntico patrón en `debit_session_and_parent` L235-239:
```sql
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;
```

### R-4 — Los 3 PERFORM pasan p_owner_ref

| Caller | Línea en up migration | PERFORM |
|--------|----------------------|---------|
| debit_with_dest_policy (#4) | L167 | `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);` |
| debit_session_and_parent (#3) | L238 | `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);` |
| debit_delegation_and_parent (#2) | L311 | `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);` |

Los 3 callers SQL pasan su propio `p_owner_ref` (ya validado contra la entidad padre en cada caso). No hay cross-tenant.

### R-5 — CD-5 byte-idéntico: cuerpo de increment salvo el guard

Cuerpo de `increment_a2a_key_spend` 4-param (up L25-93) vs original `20260406000000_a2a_agent_keys.sql`:

- DECLARE idéntico (mismas 6 variables)
- SELECT * FOR UPDATE: idéntico
- IF NOT FOUND: idéntico
- **Guard owner_ref: NUEVO (3 líneas L47-49)**
- IF NOT is_active: idéntico
- daily reset loop: idéntico (L55-62)
- daily limit check: idéntico (L64-71)
- chain budget check: idéntico (L73-80)
- Debit UPDATE: idéntico (L82-91)
- LANGUAGE plpgsql SECURITY DEFINER: idéntico

Ninguna validación existente fue tocada. Puramente aditivo.

### R-6 — Down reversible

`supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc_down.sql`:

- L9: `DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric, text);` — DROP de la firma 4-param
- L11-70: CREATE OR REPLACE de la firma 3-param (cuerpo literal, sin owner guard, sin hardening — CD-6 correcto)
- L71: `-- (sin hardening: la firma original de 3 params nunca lo tuvo — CD-6.)` — comentado explícitamente
- L74-146: `debit_with_dest_policy` restaura PERFORM 3-arg (L132: `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);`)
- L149-211: `debit_session_and_parent` restaura PERFORM 3-arg en branch ELSE (L197), dispatch preservado
- L214-278: `debit_delegation_and_parent` restaura PERFORM 3-arg en branch ELSE (L264), dispatch 125b preservado

Rollback atómico reversible. Los 3 RPCs restauran hardening 6-param. El down no rompe 125b.

### R-7 — Hardening de la nueva firma 4-param (CD-6)

`supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql:95-101`:
```sql
ALTER FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;
```

Hardening completo. Los 3 RPCs dependientes también re-hardenizados (L176-181, L247-252, L320-325).

### R-8 — Gates (confirmados del CR report, no re-ejecutados)

CR report (`cr-report.md:5`): "Gates reales: tsc 0 · biome 0 (archivos tocados) · vitest 1625 passed / 4 skipped (101 files)."

- tsc: exit 0 (AR report L8: "npx tsc --noEmit → exit 0")
- biome: 0 errores en archivos tocados
- vitest: 1625 passed / 4 skipped / 0 failed

Gates: PASS (confirmados por CR report + AR report con evidencia ejecutada).

### R-9 — Drift de scope

`git status` en los 4 archivos de Scope IN:
- `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql`: untracked (nuevo, correcto)
- `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc_down.sql`: untracked (nuevo, correcto)
- `src/services/budget.ts`: modified (correcto)
- `src/services/budget.test.ts`: modified (correcto)

Los archivos Scope OUT (`delegation.ts`, `key-session.ts`, `compose.ts`, `a2a-key.ts`, `src/routes/`) no tienen modificaciones en el working tree de esta HU. Drift: none.

---

## AC Verification

### AC-1 — Guard de ownership en RPC (PASS)

**Texto EARS**: WHEN `increment_a2a_key_spend` se ejecuta con un `p_owner_ref` que NO coincide con el `owner_ref` registrado en `a2a_agent_keys` para `p_key_id`, the system SHALL lanzar `RAISE EXCEPTION 'OWNERSHIP_MISMATCH: ...'` y hacer ROLLBACK de la transacción completa.

**Status**: PASS

**Evidencia**:
1. Inspección SQL — `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql:47-49`:
   ```sql
   IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
     RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
   END IF;
   ```
   Guard NULL-safe (`IS DISTINCT FROM`). RAISE EXCEPTION en plpgsql hace rollback automático de la transacción (la fila está bajo FOR UPDATE pero no se emite UPDATE).

2. Test automatizado — `src/services/budget.test.ts:511-521` (`'WKH-SEC-02b master: OWNERSHIP_MISMATCH mapea a code estable (AC-1/AC-6)'`): el RPC devuelve `{ error: { message: 'OWNERSHIP_MISMATCH: key x not owned by caller' } }` y el resultado es `{ success: false, error: 'OWNERSHIP_MISMATCH' }`. Confirma que el mensaje de error sube correctamente y es procesado. Test passing en suite de 1625 (CR vitest).

**Nota**: el guard para el caller TS directo (#1) es tautológico en la práctica (V6 del AR, documentado en DT-4 del SDD). El valor real del guard está en los 3 PERFORM SQL (callers #2/#3/#4) donde `p_owner_ref` proviene de una entidad padre distinta. Esto es decisión documentada, no defecto.

---

### AC-2 — Callers TS actualizados (PASS)

**Texto EARS**: WHEN `budgetService.debit` ejecuta la ruta master key sin destino (caller #1), the system SHALL pasar `p_owner_ref` a `increment_a2a_key_spend` y el servicio SHALL continuar debitando correctamente para un owner válido.

**Status**: PASS

**Evidencia**:
1. Implementación TS — `src/services/budget.ts:300-315`: SELECT cold-path de `owner_ref` (L300-308) seguido de `rpc('increment_a2a_key_spend', { p_key_id, p_chain_id, p_amount_usd, p_owner_ref: ownerRef })` (L310-315).

2. Test automatizado (happy path) — `src/services/budget.test.ts:496-509` (`'WKH-SEC-02b master: válido pasa p_owner_ref al RPC (AC-2)'`):
   ```
   mockOwnerSelect('user-1') → mockRpc.mockResolvedValue(null, null)
   → expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend',
     { p_key_id: 'key-1', p_chain_id: 2368, p_amount_usd: 1.5, p_owner_ref: 'user-1' })
   → expect(result).toEqual({ success: true })
   ```

3. Test del borde KEY_NOT_FOUND — `src/services/budget.test.ts:523-530` (`'WKH-SEC-02b master: KEY_NOT_FOUND en SELECT cold-path no llama al RPC (AC-2)'`):
   `mockOwnerSelect(null)` → `{ success: false, error: 'KEY_NOT_FOUND' }` y `expect(mockRpc).not.toHaveBeenCalled()`.

4. Tests de regresión 3-arg actualizados — `budget.test.ts:180-193` (`'calls supabase.rpc with correct params'`) y `:233-247` (`'T14 master key path uses increment_a2a_key_spend'`): ambos ahora incluyen `p_owner_ref: 'user-1'` en la aserción toHaveBeenCalledWith. PASS en la suite de 1625.

---

### AC-3 — Callers SQL (PERFORM) actualizados (PASS)

**Texto EARS**: WHEN `debit_delegation_and_parent`, `debit_session_and_parent` o `debit_with_dest_policy` ejecutan `PERFORM increment_a2a_key_spend(...)`, the system SHALL incluir el parámetro `p_owner_ref` en cada PERFORM.

**Status**: PASS

**Evidencia** (inspección SQL — justificada en story §8 y CD-7; no hay infra de test SQL estructural para esta migración):

| RPC | Línea up migration | PERFORM |
|-----|--------------------|---------|
| `debit_with_dest_policy` | `20260609000000_wkh_sec02b_owner_ref_rpc.sql:167` | `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);` |
| `debit_session_and_parent` | `20260609000000_wkh_sec02b_owner_ref_rpc.sql:238` | `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);` |
| `debit_delegation_and_parent` | `20260609000000_wkh_sec02b_owner_ref_rpc.sql:311` | `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);` |

Dispatch condicional `IF p_destination ... THEN debit_with_dest_policy ELSE increment` preservado en los 3 RPCs. El branch IF no fue modificado. Solo el branch ELSE agregó `p_owner_ref`.

Los tests de spend-policy existentes (`spend-policy.test.ts:378,399`) usan prefix-match `indexOf('PERFORM increment_a2a_key_spend(')` y siguen pasando con el 4-arg (confirmado por AR report L71 y CR report §3 Cobertura).

---

### AC-4 — Migración reversible (down script) (PASS)

**Texto EARS**: WHEN el down script de esta HU se aplica, the system SHALL restaurar `increment_a2a_key_spend` a su firma de 3 parámetros (sin `p_owner_ref`) y los RPCs dependientes a sus versiones previas, sin pérdida de datos.

**Status**: PASS

**Evidencia** (inspección SQL — decisión documentada en story §8):

`supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc_down.sql`:

- L9: `DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric, text);` — elimina la firma 4-param
- L11-70: CREATE OR REPLACE de la firma 3-param original, cuerpo sin guard de ownership, sin hardening (CD-6 correcto — la original `20260406000000` nunca tuvo hardening)
- L71: `-- (sin hardening: la firma original de 3 params nunca lo tuvo — CD-6.)`
- debit_with_dest_policy restaurado con PERFORM 3-arg en L132: `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);`
- debit_session_and_parent restaurado con PERFORM 3-arg en L197, dispatch preservado
- debit_delegation_and_parent restaurado con PERFORM 3-arg en L264, dispatch 125b preservado

El down NO borra datos de `a2a_agent_keys` (solo redefine funciones). Los 3 RPCs restauran hardening 6-param (correcto — ellos sí lo tenían en sus migraciones origen).

**MNR-1 del CR confirmado**: el `increment` 3-param del down omite 6 comentarios vs el original `20260406000000`. SQL ejecutable idéntico → rollback funcional correcto. La divergencia es cosmética (CR MNR-1, aceptada como TD).

---

### AC-5 — Cero regresión funcional (PASS)

**Texto EARS**: WHILE el servicio está en producción post-migración, the system SHALL mantener todos los tests existentes en verde (tsc 0 errores, biome 0 errores, suite de tests actual PASS).

**Status**: PASS

**Evidencia**:
- vitest: 1625 passed / 4 skipped / 0 failed — CR report `cr-report.md:5`
- tsc: exit 0 — AR report `ar-report.md:8`; CR report `cr-report.md:5`
- biome: 0 errores en archivos tocados (`budget.ts`, `budget.test.ts`) — CR report `cr-report.md:5`
- Tests de regresión DAILY_LIMIT/INSUFFICIENT_BUDGET en `budget.test.ts:195-227`: el branch genérico `return { success: false, error: error.message }` se mantiene para todo error que no sea OWNERSHIP_MISMATCH (`budget.ts:322`). Estos tests siguen pasando (incluidos en la suite de 1625).

---

### AC-6 — Error mapping en app layer (PASS)

**Texto EARS**: IF `increment_a2a_key_spend` lanza `OWNERSHIP_MISMATCH` vía la ruta del caller #1, THEN the system SHALL mapear el error a `{ success: false, error: 'OWNERSHIP_MISMATCH' }` sin propagar el mensaje crudo de Postgres al cliente.

**Status**: PASS

**Evidencia**:
1. Implementación — `src/services/budget.ts:317-321`:
   ```ts
   if (error) {
     if (error.message.includes('OWNERSHIP_MISMATCH')) {
       return { success: false, error: 'OWNERSHIP_MISMATCH' };
     }
     return { success: false, error: error.message };
   }
   ```
   El mensaje crudo `'OWNERSHIP_MISMATCH: key % not owned by caller'` nunca llega al cliente. Solo llega el code estable `'OWNERSHIP_MISMATCH'`.

2. Test automatizado — `src/services/budget.test.ts:511-521` (`'WKH-SEC-02b master: OWNERSHIP_MISMATCH mapea a code estable (AC-1/AC-6)'`):
   - Input: `mockRpc` devuelve `{ error: { message: 'OWNERSHIP_MISMATCH: key x not owned by caller' } }`
   - Expected: `{ success: false, error: 'OWNERSHIP_MISMATCH' }`
   - Passing en suite de 1625.

---

## Drift Detection

- **Scope drift**: los 4 archivos modificados son exactamente los del Scope IN (2 nuevas migraciones + `budget.ts` + `budget.test.ts`). Los archivos del Scope OUT (`delegation.ts`, `key-session.ts`, `a2a-key.ts`, `compose.ts`, `src/routes/`) no tienen modificaciones en el working tree de esta HU. `git status` confirma solo los 4 Scope IN.
- **Wave drift**: W0 (SQL up+down) → W1 (budget.ts) → W2 (budget.test.ts) → W3 (verificación). Orden respetado en el working tree.
- **Spec drift**: la implementación es byte-fiel al SDD §4.3/§4.4/§4.5 y al Story File §4/§6. El guard en L47-49 espeja el wording canónico del SDD `4.3`. Los PERFORM espajan la tabla del SDD `4.4`. El SELECT cold-path y el mapeo en `budget.ts` espejan literalmente el Story File §6.
- **Test drift**: todos los tests del Story File §8 existen y están en `budget.test.ts` en el `describe('debit')` tal como se especificó (AC-2 L496, AC-1/AC-6 L511, AC-2 borde L523). Los tests de los §7 (3 aserciones 3-arg actualizadas) están en L180, L233, L534.

Drift: none.

---

## AR/CR Follow-up

| Finding | Categoría | Estado |
|---------|-----------|--------|
| AR MNR-1 (race teórica caller #1) | Data Integrity cosmético | Aceptado como TD. Documentado en DT-4 del SDD. No bloquea. |
| AR MNR-2 (fallback ruta master-no-dest propaga error.message) | Error Handling preexistente | Aceptado como TD. Comportamiento preexistente al PR, no introducido por esta HU. No bloquea. |
| CR MNR-1 (down.sql omite 6 comentarios vs original) | Cosmético | Aceptado como TD. SQL ejecutable idéntico; rollback correcto. No bloquea. |
| CR MNR-2 (mockOwnerSelect declarado en L480 vs primer uso en L181) | Test cosmético | Aceptado como TD. Funciona por function declaration hoisting. No bloquea. |

0 BLQ en AR. 0 BLQ en CR. Los 4 MNR son cosméticos/preexistentes, no bloquean DONE.

---

## Veredicto Final

**6/6 ACs PASS. Gates PASS (1625/0 vitest, tsc 0, biome 0). Drift: none. 0 BLQ. 4 MNR aceptados como TD.**

**APROBADO PARA DONE.**
