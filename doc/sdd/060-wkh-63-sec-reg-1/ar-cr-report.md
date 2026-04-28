# AR/CR Report — WKH-63 / SEC-REG-1

**Phase**: Adversarial Review (AR) + Code Review (CR) combined
**Veredicto**: APROBADO CON CORRECCIONES
**Commits en scope**: W0–W5 (W0–W4 original + e2b8699 fix-pack para BLQ-ALTO-1)
**Testeado**: 577/577 tests pass (576 original + T-OWN-11 agregado en fix-pack)

---

## Hallazgos durante AR

### BLQ-ALTO-1: Cross-tenant IDOR via sentinel `'x402-anonymous'`

**Severidad**: BLOQUEANTE — violación de ownership guard

**Descripción del defecto**:
En el W3 original (`117acf1`), el route handler `/registries` mapeaba:
```ts
const ownerRef = request.a2aKeyRow?.owner_ref ?? 'x402-anonymous';
```

Cuando un caller llegaba **vía x402 puro** (sin a2a-key) intentando POST/PATCH/DELETE, caía al sentinel `'x402-anonymous'`. Este valor se almacenaba en la DB, así que:
1. Cualquier payer x402 A creaba registries con `owner_ref='x402-anonymous'`
2. Cualquier payer x402 B podía actualizar/borrar los registries de A porque ambos caían al **mismo sentinel**
3. El ownership guard en `registryService.update(id, ownerRef)` pasaba (`'x402-anonymous' === 'x402-anonymous'` → true)

**Causa raíz**: confusión sobre identidad. Un sentinel compartido no es una identidad — es un colapso a todos los anónimos en un mismo "tenant", lo opuesto a lo que un ownership guard necesita.

**Impacto**: ANY unauthenticated x402 payer podría modificar ANY registry de otro x402 payer (cross-tenant takeover del discovery surface).

**Fix (commit e2b8699)**:
- Rechazar POST/PATCH/DELETE con `403 A2A_KEY_REQUIRED` cuando `request.a2aKeyRow` es undefined
- El path x402 puro queda read-only para registries (GET sigue público)
- El guard corta ANTES de llegar al service, no necesita fallar en la service layer
- Test integration `T-OWN-11` verifica los 3 verbos (`POST`, `PATCH`, `DELETE`)

**Status**: ✅ RESUELTO en e2b8699

---

### MNR-1: Telemetría incompleta en ownership mismatch

**Severidad**: MENOR — drift de patrón

**Descripción del defecto**:
Los 5 paths donde `registryService` lanzaba `OwnershipMismatchError` (3 en `update`, 2 en `delete`) NO logueaban. Comparar con:
- `budgetService.getBalance()` (WKH-53): logea con `logOwnershipMismatch('getBalance', ...)`
- `identityService.deactivate()` (WKH-53): logea con `logOwnershipMismatch('deactivate', ...)`
- Nuevas: `registryService.update/delete` (WKH-63): silencioso ❌

**Causa raíz**: la función `logOwnershipMismatch(op: string, ...)` en `src/services/security/errors.ts` tenía tipos hardcodeados a `'getBalance' | 'deactivate'`. No se extendió cuando WKH-63 agregó la 4ta tabla con ownership.

**Fix (commit e2b8699)**:
- Extender `OwnershipOp` a `'getBalance' | 'deactivate' | 'registryUpdate' | 'registryDelete'`
- Agregar overload con forma objeto `logOwnershipMismatch({op, resourceId, callerOwnerRef, actualOwnerRef?})`
- Instrumentar los 5 paths en `src/services/registry.ts` (líneas 214, 225, 276, 303, 314)
- Hashear `actualOwnerRef` cuando se puede comparar con la fila pre-fetch para diagnóstico de cross-tenant attacks

**Status**: ✅ RESUELTO en e2b8699

---

### MNR-2: Migration DDL sin transacción

**Severidad**: MENOR — robustez DDL

**Descripción del defecto**:
`supabase/migrations/20260427210000_registries_owner_ref.sql` corría:
```sql
ALTER TABLE registries ADD COLUMN IF NOT EXISTS owner_ref TEXT NOT NULL DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_registries_owner_ref ON registries (owner_ref);
```

Sin `BEGIN/COMMIT`. Si el `CREATE INDEX` fallaba (timeout, lock), la columna quedaba sin índice → estado parcial difícil de auditar. La siguiente corrida saltaría el ALTER (por `IF NOT EXISTS`) sin recrear el índice.

**Causa raíz**: mecánica DDL sin considerar atomicity. PostgreSQL soporta DDL transaccional (a diferencia de MySQL), así que es una oportunidad perdida.

**Fix (commit e2b8699)**:
- Wrap DDL entre `BEGIN;` (línea 31) y `COMMIT;` (línea 41)
- Idempotencia preservada por `IF NOT EXISTS` clauses

**Status**: ✅ RESUELTO en e2b8699

---

## CR Veredicto

| Aspecto | Status | Evidencia |
|--------|--------|-----------|
| **Ownership guard correctness** | PASS | `src/services/registry.ts:214-315` — 5 paths todos filtran `(id, owner_ref)` antes de mutar. Ej: `.eq('owner_ref', ownerRef).eq('id', id)` en línea 226. |
| **System registry immutability** | PASS | `src/services/registry.ts:206-210` — check `if (ownerRef === SYSTEM_OWNER_REF)` lanza `SystemRegistryImmutableError`. Test `T-SVC-03` (l.165), `T-SVC-08` (l.257). |
| **Route handler wiring** | PASS | `src/routes/registries.ts:76-104` — mapea `OwnershipMismatchError` → 404 (disclosure-safe), `SystemRegistryImmutableError` → 403. A2A_KEY guard antes de service layer. |
| **Test coverage (ownership)** | PASS | 20 new tests en W4: `src/services/registry.ownership.test.ts`, `src/routes/registries.ownership.test.ts`. T-OWN-02, T-OWN-11 específicamente para fix-pack. |
| **Type consistency** | PASS | `src/types/index.ts:52` — `RegistryConfig.ownerRef: string` agregado. Fixtures en tests (`agent-card.test.ts`, etc.) actualizadas con `ownerRef: 'system'`. Cero hardcodes. |
| **Lint/Format** | PASS | Biome formatting aplicado. No hay warnings. |
| **TypeScript strict** | PASS | `tsc --noEmit` exit 0. Cero `any` explícito. |

---

## Patrón emergente (Lección para futuras HUs)

**Regla**: **Nunca usar sentinels compartidos como ownerRef**

Cuando se agrega ownership a una tabla nueva:
1. Si no hay identity verificable (a2a-key, signed message, etc.) con propiedad criptográfica/exclusiva → rechazar la mutación (`403`) en lugar de normalizar a un sentinel
2. Un sentinel compartido colapsa múltiples tenants en uno → violación directa de ownership guard
3. La defensa debe estar en el **route handler** (antes del service) para cut early

Aplicar en: `tasks` (WKH-54), cualquier tabla futura con `owner_ref`.

---

## Follow-up (pendiente de operador)

1. Verificar que la migration fue aplicada al Supabase remoto (query en qa-report.md sección 1.1)
2. No es bloqueante para merge — la SQL es correcta y el apply script está en disco

---

**Conclusión**: Todos los hallazgos AR resueltos. BLQ-ALTO-1 cerrado. Patrón ownership reforzado. Listo para QA.
