# AR Report — WKH-125b (delegation dest-cap)

> **nexus-adversary · AR · 2026-06-22** · Branch `fix/120-wkh-125b-delegation-dest-cap` (working tree)
> **Veredicto: APROBADO** — 0 BLOQUEANTE, 0 MENOR. tsc 0 errores, 145 tests PASS (suites de la HU).
> _Persistido por el orquestador (el system prompt del agente AR le impide escribir .md; contenido íntegro suyo)._

## Evidencia por vector de ataque

**V1 — Bypass cerrado en AMBOS call-sites + ¿tercer path?** OK.
- Per-step: `src/services/compose.ts:160-167` pasa `normalizeDestination(\`${agent.registry}/${agent.slug}\`)` como 6º arg con `delegationContext` → rama delegación de `budget.ts:154-167` ahora forwardea `destination`.
- Step-0: `src/middleware/a2a-key.ts:383-400`, forwarding condicional simétrico al branch session.
- `grep debitDelegationAndParent` → solo `budget.ts:161` y `a2a-key.ts:384/393`. No queda path de delegación sin destination.

**V2 — Overload del RPC (BLQ-MED-1 repetido):** OK. `..._dest_cap.sql:17` `DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric)` ANTES del CREATE de 6 params (L19-24). No queda sobrecarga.

**V3 — Atomicidad (CD-1):** OK. Paso 5 `PERFORM debit_with_dest_policy(...)` (`.sql:73`) → lock + cap check + increment + INSERT ledger en UNA tx con `RAISE DEST_CAP_EXCEEDED` → ROLLBACK. `UPDATE total_spent` en la misma tx. Cero split app-layer.

**V4 — Back-compat (CD-3):** OK. Rama `ELSE` (`.sql:76`) byte-idéntica al original `20260601000000:95`. Guard `p_destination IS NOT NULL AND <> ''` evita ledger en delegaciones sin destino. Tests de aridad confirman.

**V5 — No tocar increment/debit_with_dest_policy (CD-4):** OK. Solo PERFORM; `git diff` no toca esas defs.

**V6 — Leak de error (CD-5) + 402:** OK. `delegation.ts:393` `DEST_CAP_EXCEEDED`→`DestCapExceededError` (antes de prefijos propios); `budget.ts:195`→`{success:false,error:'DEST_CAP_EXCEEDED'}`; `a2a-key.ts:404-408`→HTTP 402. Test AC-5 asserta no-leak de `accum`/`cap`.

**V7 — Hardening (CD-6):** OK. `.sql:88-94` `search_path=public,pg_temp` + `REVOKE FROM PUBLIC,anon,authenticated` + `GRANT TO service_role` sobre la firma nueva de 6 params. SECURITY DEFINER con search_path fijado.

**V8 — Down reversible:** OK. DROP-6 → CREATE-5 (cuerpo original) → hardening-5. No dropea `debit_with_dest_policy` ni tablas.

**V9 — Aridad / call-sites:** OK. Fixes aditivos, reflejan back-compat real. Sin callers fuera de los 2 contemplados.

**V10 — Destino canónico (CD-7):** OK. Step-0 `request.composeDestination` vía `deriveComposeDestination(resolved)` (agente resuelto por discovery, no body crudo) → `normalizeDestination()` (`trim().toLowerCase()`). Mismo normalizador que persiste la policy → no se evade con `Kite/Translator` vs `kite/translator`.

## Categorías
Security OK · Error Handling OK · Data Integrity OK (atomicidad, FOR UPDATE, rollback) · Performance OK · Integration OK (back-compat byte-idéntico) · Type Safety OK (tsc 0) · Test Coverage OK (AC-1/2/3/5 mocks no-vacuos, AC-4 e2e DB-gated) · Scope Drift OK (7 archivos) · Destructive Migrations OK (DROP de función, reversible) · RPC SECURITY DEFINER OK (search_path fijado, ownership interno, REVOKE+GRANT) · Cache N/A.

## Observación informativa (NO finding)
La migración up no está envuelta en `BEGIN/COMMIT`; es el patrón establecido (WKH-125 `20260606000000` tampoco lo está — el runner envuelve cada archivo en su tx). Mismo perfil de riesgo que el exemplar aprobado.

## Veredicto
**APROBADO** — 0 BLOQUEANTE, 0 MENOR. El bypass del cap por destino vía delegación EIP-712 quedó cerrado simétrico al fix de session keys, en ambos call-sites. Evidencia: tsc 0; vitest 145 PASS/0 FAIL en las suites de la HU.
