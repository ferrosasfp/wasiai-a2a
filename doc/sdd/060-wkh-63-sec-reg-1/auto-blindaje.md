# Auto-Blindaje — WKH-63 / SEC-REG-1

Errores corregidos durante F3 y patrones a aplicar en futuras HUs.

---

### [2026-04-27 21:45] Wave 0 — Story File ausente al iniciar F3
- **Error**: `doc/sdd/060-wkh-63-sec-reg-1/story-WKH-63.md` no existe en disco al lanzar `nexus-dev`. El directorio `060-wkh-63-sec-reg-1` tampoco existía.
- **Causa raíz**: F2.5 no fue ejecutada (o fue saltada) y la rama `feat/060-wkh-63-sec-reg-1` se creó sin el artefacto Story File. El orquestador pasó el detalle de las waves directamente en el prompt como sustituto.
- **Fix**: Procedo con el prompt del orquestador como Story File substitute, basándome en exemplares ya en repo (WKH-53 ownership pattern, WKH-61 scope check, WKH-62 SSRF guard) que sí están en `doc/sdd/`. Documento la ausencia para que QA lo detecte.
- **Aplicar en**: cualquier HU futura — antes de lanzar `nexus-dev`, verificar `ls doc/sdd/NNN-titulo/story-*.md` retorna match. Si falla, lanzar primero `/nexus-p3-f2-5 WKH-XX`.

---

### [2026-04-27 22:00] Fix-pack post-AR — BLQ-ALTO-1 sentinel compartido = cross-tenant IDOR
- **Error**: el route handler caía a `request.a2aKeyRow?.owner_ref ?? 'x402-anonymous'` cuando el caller llegaba vía x402 puro (sin a2a-key). El sentinel `'x402-anonymous'` se almacenaba en `registries.owner_ref`, así que cualquier payer x402 (atacante con $1 USDC) pasaba el ownership guard contra registries creados por otros payers x402 → modificación/borrado cross-tenant.
- **Causa raíz**: pensé que el x402 anonymous "no tenía tenant" y le inventé un sentinel para no romper la creación. Error: un sentinel compartido NO es identidad — colapsa a todos los anónimos en un mismo "tenant", lo que es exactamente lo opuesto a lo que un ownership guard necesita.
- **Fix**: rechazar POST/PATCH/DELETE (`403 A2A_KEY_REQUIRED`) cuando `request.a2aKeyRow` es undefined. El path x402 puro queda read-only para registries (GET sigue público). El guard corta antes de llegar al service. Test integration `T-OWN-11` cubre los 3 verbos. T-OWN-02 actualizado al nuevo contrato.
- **Aplicar en**: cualquier ownership column en futuras tablas (`tasks` en WKH-54, etc.). Regla: **nunca usar sentinels compartidos como ownerRef**. Si no hay tenant identity verificable (a2a-key o equivalente con propiedad criptográfica/exclusiva), la mutación debe rechazarse — no normalizarse a un sentinel.

---

### [2026-04-27 22:00] Fix-pack post-AR — MNR-1 logOwnershipMismatch para registries
- **Error**: los 5 paths de `OwnershipMismatchError` en `src/services/registry.ts` (3 en update, 2 en delete) se lanzaban silenciosamente, sin telemetría. Los paths equivalentes en `budget.ts`/`identity.ts` sí logueaban (WKH-53), así que el gap era un drift de patrón.
- **Causa raíz**: la función `logOwnershipMismatch` original tenía `op: 'getBalance' | 'deactivate'` hardcoded en el tipo. No se extendió cuando WKH-63 agregó la 4ta tabla con ownership.
- **Fix**: extendí `OwnershipOp` a `'getBalance' | 'deactivate' | 'registryUpdate' | 'registryDelete'`. Agregué overload con forma objeto `{op, resourceId, callerOwnerRef, actualOwnerRef?}` que hashea `actualOwnerRef` cuando se puede comparar con la fila pre-fetch — útil para diagnóstico de cross-tenant attacks. Mantuve la forma posicional legacy para no tocar `budget.ts`/`identity.ts` (out-of-scope del fix-pack).
- **Aplicar en**: cuando se agregue ownership a una tabla nueva, extender `OwnershipOp` con un literal nuevo y llamar `logOwnershipMismatch({...})` en TODOS los paths que tiren `OwnershipMismatchError`. AR/CR debe verificar paridad logging en cada PR de ownership.

---

### [2026-04-27 22:00] Fix-pack post-AR — MNR-2 migration sin transacción
- **Error**: `20260427210000_registries_owner_ref.sql` corría `ALTER TABLE` + `CREATE INDEX` sin `BEGIN/COMMIT`. Si el `CREATE INDEX` fallaba (e.g. lock timeout), la columna quedaba agregada sin índice → estado parcial difícil de auditar y la siguiente corrida saltaría el ALTER (por `IF NOT EXISTS`) sin recrear el índice de la misma sesión.
- **Causa raíz**: mecánica DDL sin pensar en atomicity. PostgreSQL soporta DDL transaccional (a diferencia de MySQL), así que envolver con `BEGIN/COMMIT` es trivial y casi gratis.
- **Fix**: wrap del SQL operativo entre `BEGIN;` y `COMMIT;`, dentro del bloque después del header de comentarios. Idempotencia preservada por los `IF NOT EXISTS`.
- **Aplicar en**: TODA migration `.sql` futura — open con `BEGIN;`, close con `COMMIT;`. El template de migration debería traerlo por default. Para DDL no-transaccional (CREATE INDEX CONCURRENTLY), separar en migration aparte sin transaction.

---
