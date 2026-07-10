# AR Report — WKH-173 (`requireA2AKey()` auth-only)

**Date**: 2026-07-10  
**Veredicto**: APROBADO — 0 BLOQUEANTE, 0 MENOR  
**Scope**: refactor puro (W0 builders) + nueva función `requireA2AKey()` (W1) + tests (W2)

---

## Hallazgos por vector

| Vector | Status | Notas |
|--------|--------|-------|
| Refactor puro (W0 builders byte-idéntico) | OK | `buildDelegationEffectiveRow` / `buildSessionEffectiveRow` — literal extraído de las líneas 503–513 y 740–754 de `a2a-key.ts`, copiado verbatim. Suite deleg/sesión (WKH-101/121) 100% verde sin tocar tests → refactor comportamiento-preserving confirmado. |
| Auth-only NO invoca x402 (CD-2) | OK | Lectura directa `a2a-key.ts:1241–1261`: `requireA2AKey` — sin import de `requirePayment`, sin `runX402Fallback`, sin `getPaymentAdapter`. Dispatcher redirige a 3 branches (master/deleg/sesión), ninguno toca x402. Test T-RT-01 (ruta real `/agents` con `x-payment` + sin a2a-key → 403 `A2A_KEY_REQUIRED`, x402 nunca invocado) cubre integración. |
| Auth-only NO debita (DT-C) | OK | Cero calls a `budgetService.debit`, `debitDelegationAndParent`, `debitSessionAndParent` dentro de `requireA2AKey` o sus 3 resolvers privados. Tests T-RA-01/02/03 verifican `mockDebit`/`mockDebitDelegation`/`mockSessionDebit` not called. |
| Spend-limits saltados (DT-C ratificado) | OK | Bloque de `daily_limit_usd`/`max_spend_per_call_usd` checks **intencionalmente ausente** del path auth-only (líneas 811–840 del master resolver pago copiadas, pero sus checks skipped en auth-only). Test T-RA-08: key con limit agotado → 200, sin débito (cambio de comportamiento intencional, documentado). |
| Error codes idénticos (AC-2/CD-7) | OK | Master: `send403 KEY_NOT_FOUND`, `send403 KEY_INACTIVE` — mismo helper que el path pago (L92). Deleg: `send403delegation DELEGATION_REVOKED/EXPIRED/KEY_INACTIVE` (L116). Sesión: `send403session SESSION_TOKEN_INVALID/SESSION_EXPIRED/KEY_INACTIVE` (L137). Firma: `sendSignedAuthError` (L151) en ambos paths. Cero códigos nuevos inventados. |
| Firma (`require_signature`) enforced (AC-7/CD-3) | OK | Master: EIP-712 validation de L848–866 copiada al helper `authenticateMasterKey`; sin firma → 401 `SIGNATURE_REQUIRED` idéntico. Sesión: HMAC validation de L594–615 copiada; mismo resultado. Tests T-RA-07a/07b/07c verdes. |
| Routes swapped correctamente (W1) | OK | `agents.ts` L102–106 (POST), L277–281 (PATCH), L408–412 (DELETE), L453–457 (GET): el preHandler ahora es `[...requireA2AKey()]` en lugar de `[...requirePaymentOrA2AKey({...})]`. Guard interno `a2aKeyRequired` intacto. |
| Scope IN vs Scope OUT | OK | Solo archivos tocados: `a2a-key.ts`, `agents.ts`, tests. Intactos: `compose.ts`, `orchestrate.ts`, `gasless.ts`, `registries.ts`, `x402.ts`, `resolveTargetChain`, `resolveEstimatedCostUsd`. CD-1 / CD-5 satisfied. |
| Regresión money-path | OK | Suite de `resolveMasterAuth`/`resolveDelegationAuth`/`resolveKeySessionAuth` con débito (WKH-101/121/123/125/127) verificadas: 100% verde post-refactor. Débito byte-idéntico (único cambio: literal `effectiveRow` → builder call, permitido por CD-1). |

---

## Veredicto

**APROBADO** para proceder a CR.

- Refactor puro verificado (gate W0 passed).
- Nueva función `requireA2AKey()` implement-ready: contrato explícito (3 branches, error codes idénticos, sin x402/débito/limits).
- Rutas swapped sin modificar guardia interna ni scoping.
- Cero regressions en money-path.

**Cero hallazgos bloqueantes. Cero hallazgos menores.**
