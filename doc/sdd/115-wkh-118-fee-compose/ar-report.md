# AR Report — WKH-118 (FEE-COMPOSE)

> Veredicto: **APROBADO** (0 BLOQUEANTEs, 0 MENORs). Persistido por el orquestador desde la salida del AR (el sub-agente lo devolvió en mensaje sin escribirlo a disco).

**Branch**: feat/115-wkh-118-fee-compose · **Scope**: `src/routes/compose.ts` (+59/-0) + `src/routes/compose.fee.test.ts` (nuevo).

## Ejecución
- `vitest run` → 1564 passed | 3 skipped. `compose.fee.test.ts` 10/10. `tsc --noEmit` 0 errores. `biome` limpio. compose.ts diff = +59/-0 (solo inserción).

## Ataques dirigidos (todos OK)
1. **Best-effort no rompe el 200 (CD-1)** — OK. Bloque en try/catch (compose.ts:248-292); throw/reject de chargeProtocolFee → catch + console.error, continúa al send. Recibo fire-and-forget `.catch` sin await. T-FEE-2a/2b.
2. **Idempotencia / doble cobro** — OK. `orchestrationId: request.id` único; bloque corre una vez; already-charged = no-op (no recibo, no error). PK `a2a_protocol_fees.orchestration_id` resuelve concurrencia. T-FEE-3/7.
3. **Monto correcto** — OK. `budgetUsdc: result.totalCostUsdc` (no maxBudget); number no-opcional; NaN blindado por try/catch. T-FEE-1.
4. **Success-only (CD-4)** — OK. `!result.success` hace return antes del bloque. T-FEE-5.
5. **x402 vs agent-key** — OK. Cobro owner-agnóstico (desde paymentAdapter); recibo solo si `a2aKeyRow?.owner_ref`. T-FEE-6b (x402 sin recibo, sin crash).
6. **No regresión** — OK. Response `{kiteTxHash, ...result}` idéntico; orchestrate/compose-service/fee-charge/types intactos. T-FEE-8.
7. **a2aKeyRow vs scopingKeyRow** — OK. Usa `request.a2aKeyRow` con optional chaining; sin acceso a undefined.
8. **Leak** — OK. console.error logea mensajes de error/fee, sin secrets ni firmas.

## 8 categorías AR
Security OK · Error Handling OK · Data Integrity OK · Performance OK (latencia idéntica a orchestrate, recibo fire-and-forget) · Integration OK (response back-compat) · Type Safety OK (0 any, discriminated union) · Test Coverage OK (≥1 por AC + negativos) · Scope Drift OK (+59/-0, sin refactor adyacente). Categorías 9-11 (migraciones destructivas / RPC SECURITY DEFINER / cache): N/A.

## Observaciones no-finding (calibración)
- Latencia del success path (`await chargeProtocolFee` antes del send): idéntica a orchestrate, mirror documentado.
- `request.id` no estable entre retries HTTP: idéntico a orchestrate, semántica documentada (idempotencia por request).

## Veredicto: APROBADO — sin findings. Avanzar a F4.
