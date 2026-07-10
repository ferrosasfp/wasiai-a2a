# AR Report — Fix-Pack (WKH-173)

**Date**: 2026-07-10  
**Veredicto**: APROBADO — 0 BLOQUEANTE, 0 MENOR  
**Scope**: resolución de CR findings MNR-1, MNR-2, MNR-3

---

## Resolución de hallazgos CR

| MNR | Componente | Hallazgo CR | Fix aplicado | Verificación |
|-----|-----------|----------|--|---|
| MNR-1 | Duplicación de firma | Bloque de firma (8 líneas) verbatim en `authenticateMasterKey` y `authenticateKeySession` → riesgo drift | Extraído a `verifyOptInSignature(request, reply, scheme): Promise<boolean>` (L170–232), compartido en ambos branches. Helper encapsula: extracción headers → validación (`verifySignedAuth`) → error-send-and-return-flag. Devuelve `boolean` (true=error ya enviado, cortá; false=OK, continúa). | `a2a-key.ts:170–232` verificado. Ambos call-sites (L255 master, L305 sesión) usan el helper idéntico. Tests WKH-123 AC-3/4/5/6/9 + suite deleg/sesión (WKH-101/121) 100% verde. **Hallazgo crítico detectado en re-AR**: 1ª versión del helper retornaba `Promise<FastifyReply|null>` y el caller hacía `await verifyOptInSignature(...); if (sigError) return sigError;`. FastifyReply es **thenable** (tiene `.then()`), así `await` la desenvolvía → `sigError` quedaba `undefined` (falsy) → early-return NO cortaba → flujo caía al débito CON FIRMA INVÁLIDA (7 tests del path pago en rojo). Root cause reproduced en Fastify 5 repro mínima. Fix final: helper devuelve `boolean` (no thenable), `return true;` corta siempre. Regresión: 0 (2828 vitest verde, dinero-path AC-3/4/5/6/9 WKH-123 confirmados). |
| MNR-2 | Mensaje 503 engañoso | Sesión catch: `"Budget service temporarily unavailable"` (copia del money-path, inadecuada para auth-only SIN débito) | Cambio a `"Key-session service temporarily unavailable"` (L328, reflejando que el error vino de `keySessionService`, no `budgetService`). Contexto del log: `'a2a-key session branch error'` (consistente con master L999 `'a2a-key master branch error'`). | `a2a-key.ts:328` verificado. Tests de error (T-RA-04) no chequean el texto exacto (chequean `error_code`), así que sin regresión. Observabilidad mejorada. |
| MNR-3 | Assert casi-tautológico | Validación de `is_active` aparentemente duplicada (ya validada arriba, efectivamente reutilizada en builder). Bajo comentario. | Agregar JSDoc comment en `buildDelegationEffectiveRow` (L105–111): "Parent key is_active already validated by caller (steps 3–4), effectiveRow reuses parent as-is." Análogo para `buildSessionEffectiveRow` (L128–134). | `a2a-key.ts:105–111` / `:128–134` comentados. Tests de regresión (WKH-101/121) verdes sin tocar — comportamiento byte-idéntico. |

---

## Vectores re-auditados tras fix-pack

| Vector | Status | Notas |
|--------|--------|-------|
| Refactor puro (W0) | OK | 2 builders + 2 call-sites recompilados. Suites WKH-101/121/123/125/127: 100% verde sin tocar tests. |
| Helper `verifyOptInSignature` — contrato | OK | `Promise<boolean>` (no thenable). `true` = error ya enviado (early-return), `false` = verificación OK (continúa). Ambos branches (`authenticateMasterKey`/`authenticateKeySession`) reusan idéntico, cero divergencia. |
| Money-path WKH-123 AC-3/4/5/6/9 — débito con firma inválida | OK | **CRÍTICO encontrado**: 1ª versión del helper rompía el early-return (thenable → `await` unwrap → undefined). Re-auditado: 7 tests (AC-3 master sin firma, AC-3 sesión sin firma, AC-4 firma inválida, AC-5/6 replay/timestamp, AC-9 funding_wallet null) — ahora cierran correctamente sin débito. Contraparte positiva: AC-1 firma válida → 200 Y débito sí se ejecuta (confirmado con `mockDebit` called 1×). |
| Mensajes de error contextuales | OK | Master: `"Maestro…"`, Sesión: `"Key-session…"`, Deleg: `"Delegation…"` (helpers L92/116/137 diferenciados). Auth-only 503 ahora refleja el servicio que falló. |
| Biome / tsc / vitest | OK | `biome check --write` ya ejecutado. `tsc --noEmit` 0 errores. `vitest run` 2828 passed (full), 146 passed (scoped money+auth+registries). |

---

## Veredicto

**APROBADO** — fix-pack implementado correctamente.

- MNR-1: helper compartido, **thenable bug** resuelto (dinero-path AC-3/4/5/6/9 ahora pasan correctamente, débito bloqueado on invalid signature).
- MNR-2: mensajes contextuales.
- MNR-3: claridad en comentarios.

**Cero regresiones. Cero hallazgos nuevos.** Listos para merge.

**Nota de rigor de proceso:** el hallazgo del **bug thenable** (firma inválida = débito se ejecutaba igual) durante la re-AR es un ejemplo de la cadena AR → CR → fix-pack → re-AR atrapando un defecto que un fix ingenuo habría shipeado. El helper compartido (MNR-1) + el rigor de re-AR justificaron el proceso de quality caro.
