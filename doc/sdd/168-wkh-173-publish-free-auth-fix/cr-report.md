# CR Report — WKH-173 (`requireA2AKey()` auth-only)

**Date**: 2026-07-10  
**Veredicto**: APPROVED — 0 BLOQUEANTE, **3 MENOR** (todos resolvibles, no bloqueantes)  
**Scope**: code quality, maintainability, observability

---

## Hallazgos

| ID | Severidad | Componente | Hallazgo | Fix recomendado |
|----|-----------|-----------|----------|---|
| MNR-1 | MENOR | `authenticateMasterKey` + `authenticateKeySession` | Bloque de verificación de firma (8 líneas) **duplicado verbatim** en ambos resolvers (`authenticateMasterKey` L~248–255, `authenticateKeySession` L~301–308). EIP-712 vs HMAC son semánticamente distintos, pero la estructura `if (!signature) { 401 } verifySignedAuth() { if (!ok) sendSignedAuthError() }` es **100% duplicada**. Riesgo: si algún detalle de error handling cambia (ej: mensaje, campo adicional), el drift afectará uno u otro o ambos. Anti-drift: extraer a `verifyOptInSignature(request, reply, scheme): Promise<boolean>` compartido, que retorna early-return flag. | Extraer helper compartido `verifyOptInSignature(...)` que encapsule la lógica de extracción/validación/error-send, devolviendo `boolean` (true=error enviado, corta; false=OK, continúa). Reusar en ambos branches (master + sesión). |
| MNR-2 | MENOR | `authenticateKeySession` catch block | Mensaje `503 SERVICE_ERROR` dice "Budget service temporarily unavailable", copia del path pago (`resolveMasterAuth` L994). Acá NO hay `budgetService` (auth-only SIN débito) — el mensaje es **engañoso**. En realidad el error vino de `keySessionService.lookupByTokenHash()` o `.getParentKey()`, no de budget. | Cambiar catch block a mensaje neutral: `"Key-session service temporarily unavailable"` (ya existe helper en L777 que dice `'a2a-key session branch error'` — usar ese contexto en el log). |
| MNR-3 | MENOR | `authenticateMasterKey` / `buildDelegationEffectiveRow` | Line `if (!keyRow.is_active) return send403(reply, 'KEY_INACTIVE', ...)` en master (L~230), equivalente en deleg/sesión. El mismo assert `!keyRow?.is_active` vuelve a correr en `buildDelegationEffectiveRow` implícitamente cuando se hace `.spread(...parentKey)` (el builder NO chequea `is_active` explícitamente, pero si el parent estuviera inactivo, se habría capturado líneas arriba en el check de L~242 "Parent key is inactive"). La lógica de seguridad es **correcta**, pero el assert casi-tautológico (ya validamos arriba) hace sospechar al lector que falta un control. No es bug, pero **observabilidad baja**. | Agregar comment: `// Parent key is_active already validated above (§3), effectiveRow reuses it as-is.` Confirmación: los tests de regresión deleg/sesión (WKH-101/121) siguen 100% verde porque la validación PRE-EXISTE. |

---

## Veredicto

**APPROVED** — código es funcionalmente correcto; los 3 MENORs son de calidad/mantenibilidad, no de seguridad.

**Recomendación**: resolver los 3 MENORs en un fix-pack ANTES de merge (no son bloqueantes, pero sí mejoras de higiene que justifican la inversión, especialmente MNR-1 y MNR-2 por cambio de contexto: auth-only vs money-path usan diferentes servicios → mensajes y helpers deben reflejar eso).

**Reporte de fix-pack esperado**: `ar-report-fixpack.md` (re-AR post-fixes) debe certificar 0 fallos y comportamiento byte-idéntico en los tests afectados.
