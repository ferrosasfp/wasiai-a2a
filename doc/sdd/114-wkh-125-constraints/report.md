# Final Report — WKH-125: Constraints programables por destino + ventana (KEY-CONSTRAINTS)

> **Status**: ✅ DONE · **Fecha**: 2026-06-19 · **Branch**: `feat/114-wkh-125-constraints`
> **Épica**: E16 (Agent Key robustness vs Kite Passport) — **ÚLTIMA HU, EPIC COMPLETO** · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (7/7 ACs PASS).

## 1. Resumen ejecutivo
WKH-125 agrega **caps de gasto programables por destino/vendor** con **ventanas de tiempo configurables** (rolling N segundos o total de por vida). Cierra exactamente el gap del Kite Passport ("no gastar más de $50 con vendor Y"): `PUT /auth/keys/me/spend-policies { destination, max_usd, window_type, window_secs }`. El cap se evalúa atómicamente con el débito. Con esto la épica **E16 queda COMPLETA**.

## 2. Pipeline (QUALITY AUTO, 2026-06-19)
HU_APPROVED + SPEC_APPROVED self-aprobados. F2.5 → F3 → **AR (RECHAZADO, 2 BLQ)** + CR (APROBADO) → **fix-pack** → **RE-AR (APROBADO)** → F4 (APROBADO PARA DONE).

## 3. AC results (7/7 PASS — ver validation.md)
AC-1 set-policy (PUT persiste) · AC-2 cap-reject → 402 DEST_CAP_EXCEEDED sin decrementar budget · AC-3 rolling window (SUM filtra por debited_at) · AC-4 atomic-debit concurrencia (solo 1 pasa) · AC-5 back-compat (sin política → increment_a2a_key_spend directo) · AC-6 session hereda parent · AC-7 ownership guard. Gates: tsc 0 · 1554 tests · lint 0.

## 4. Hallazgos — el AR justificó su existencia (2 BLQ reales en la ruta de dinero, RESUELTOS)
- **BLQ-ALTO-1 (cap bypass)**: el destino de step-0 se derivaba del **body crudo** del caller (registry opcional) mientras el per-step del **agente resuelto**. En un compose de 1 step, omitir `registry` → el destino no matcheaba la policy → degradaba a `increment_a2a_key_spend` → **cap nunca evaluado, gasto ilimitado**. **Fix**: nuevo `resolveAgentDestination` (agent-price.ts) deriva el destino del agente RESUELTO vía discovery (mismo string canónico que el per-step). Test reproduce el bypass y verifica el cierre.
- **BLQ-MED-1 (overload SQL)**: `CREATE OR REPLACE debit_session_and_parent` con +1 param crea una **sobrecarga** (no reemplaza); un caller de 5-arg da "function not unique". **Fix**: `DROP FUNCTION IF EXISTS debit_session_and_parent(uuid,text,uuid,integer,numeric)` antes del CREATE. Verificado en prod: queda `debit_session_and_parent/6` única.
- CR APROBADO sin blockers. Deuda (Scope OUT): override per-session real, cap en delegations EIP-712, purga del ledger, RLS → WKH-SEC-02.

## 5. Decisiones clave
- **RPC atómico `debit_with_dest_policy`**: FOR UPDATE key + policy → SUM del ledger en ventana → check cap → RAISE DEST_CAP_EXCEEDED → PERFORM `increment_a2a_key_spend` (reusa daily/budget, CD-2 intacto) → INSERT ledger.
- **2 tablas**: `a2a_key_spend_policies` (regla por destino) + `a2a_key_dest_spend_ledger` (cada débito, para el SUM rolling).
- **Destino canónico** del agente resuelto (no body); `normalizeDestination` (trim+lowercase) consistente en set-policy y debit.
- `destination?` opcional al final de `debit()` (15 aserciones de aridad actualizadas con valores reales). AC-6 herencia automática; override per-session → futuro.

## 6. Archivos
**Nuevos**: `src/services/spend-policy.ts` (+test), `src/services/agent-price.ts` cambios + test, migración `20260606000000_a2a_key_spend_policies.sql` (+down). **Modificados**: `src/types/a2a-key.ts`, `src/types/index.ts` (ComposeResult.errorCode aditivo), `src/services/security/errors.ts`, `src/services/budget.ts`, `src/services/compose.ts`, `src/services/key-session.ts`, `src/middleware/a2a-key.ts`, `src/routes/compose.ts`, `src/routes/auth.ts`, tests de aridad (compose/orchestrate.billing/budget).

## 7. Deploy
- Migración `20260606000000_a2a_key_spend_policies.sql` **aplicada a prod** (caldzjhjgctpgodldqav): 2 tablas + RPC `debit_with_dest_policy/5` + `debit_session_and_parent/6` (overload eliminado). HTTP 201.

## 8. 🏁 Cierre de Épica E16 — "Agent Key mejor que Kite Passport"
| HU | Entregable | Status |
|----|-----------|--------|
| WKH-121 | Session keys server-side sin EIP-712 | DONE (prod) |
| WKH-122 | Revocación granular por sesión | DONE (prod) |
| WKH-123 | Auth por firma EIP-712 + HMAC | DONE (prod) |
| WKH-124 | Recibos inmutables proof-chain | DONE (prod) |
| **WKH-125** | **Constraints por destino + ventana** | **DONE (prod)** |

**Paridad de seguridad con el Passport** (sesiones acotadas, revocación, firma, proof-chain, caps por vendor) **+ ventajas propias** (cross-chain Kite/Avalanche/Base, identidad trustless ERC-8004, agnóstico — no atado a la L1 de Kite) = **estrictamente mejor**.

## 9. Lección
El AR adversarial es **esencial en la ruta de dinero**: encontró un cap bypass que la suite verde no detectaba (solo emergía con variación del body) y un overload de RPC (CREATE OR REPLACE con +1 param NO reemplaza en Postgres). Regla: derivar identidad/destino SIEMPRE del servidor (discovery/DB), nunca del body del caller.
