# Auto-Blindaje — WKH-137 (Invocation Links)

### [2026-07-04] Wave 2 — Fastify route generic con options object
- **Error**: `TS2345: Argument of type ... is not assignable to RouteHandlerMethod`
  al anotar el handler inline (`req: FastifyRequest<{Params; Body}>`) en una ruta
  que tiene un objeto de opciones (`{ config, preHandler }`) como 2º argumento.
- **Causa raíz**: con `exactOptionalPropertyTypes:true`, Fastify infiere
  `RouteGenericInterface` (params/body = `unknown`) desde la firma con options y
  colisiona con la anotación inline del handler (params concretos).
- **Fix**: mover el genérico al call `fastify.post<{ Params; Body }>(path, opts, handler)`
  y dejar el handler sin anotación (`async (req, reply) => ...`). En rutas SIN
  options (mint) la anotación inline funciona.
- **Aplicar en**: cualquier ruta nueva con `preHandler`/`config` + params/body tipados.

### [2026-07-04] FIX-PACK BLQ-1 — redeem público filtraba el saldo del owner (cross-tenant leak)
- **Error**: `agentLinkService.redeem()` devolvía el `OrchestrateResult` COMPLETO
  al redeemer. Como el redeem es público (auth por posesión del token, el redeemer
  es un tercero, NO el owner), ese result exponía `remainingBudgetUsd` (saldo
  prepago del owner, `orchestrate.ts:1001`) + `feeChargeError`/`feeChargeTxHash`/
  `refundError`/`debitFallback` (telemetría de billing del owner) → un tercero
  aprendía el estado financiero de un tenant ajeno (viola AC-7 / IDOR-like).
- **Causa raíz**: reusar el shape interno rico (`OrchestrateResult`) como shape
  de un canal EXTERNO sin filtrar. La firma `redeem(): Promise<OrchestrateResult>`
  arrastraba el leak; el route hacía `...result` spread directo al body.
- **Fix**: nuevo shape público acotado `RedeemResult` (`types/index.ts`) con SOLO
  `orchestrationId` + `answer` + `protocolFeeUsdc` + `pipeline{success,output}`.
  Helper `toRedeemResult()` mapea antes de devolver; firma cambiada a
  `Promise<RedeemResult>`. Test: el body NO contiene `remainingBudgetUsd` ni
  campos de billing del owner.
- **Aplicar en**: TODA respuesta de un endpoint público (auth por posesión de
  token, no por identidad del owner) que reuse un shape interno rico de otro
  service. Regla: shape interno ≠ shape de canal externo; mapear con allow-list
  explícita, nunca `...spread` del result interno.

### [2026-07-04] FIX-PACK MNR-a — execute no-exitoso (sin cargo) quemaba el link
- **Error**: el redeem solo ramificaba en `'__quoteStale' in result`; cualquier
  otro result (incl. `pipeline.success===false` por fondos insuficientes del
  owner, con débito-cero) caía en `settle('redeemed')` terminal + 200 ambiguo con
  `answer:null`. Un link válido se consumía sin ejecución/cobro real.
- **Causa raíz**: no se distinguía "ejecutó y falló CON cargo" de "no ejecutó /
  no cobró". El happy-path asumía que todo result no-`__quoteStale` implicaba un
  débito exitoso.
- **Fix**: guard `pipeline.success===false && (totalCostUsdc ?? 0) === 0` →
  `settle('reopen')` (cero débito garantizado, como `__quoteStale`) + throw
  `AgentLinkExecutionUnavailableError` → 503 `LINK_EXECUTION_UNAVAILABLE`. El link
  vuelve a 'open' (retryable), NO se quema.
- **Aplicar en**: cualquier gate single-use que consuma un recurso tras invocar un
  money-path que puede retornar gracefully sin cobrar (net-zero). Chequear el
  cargo real antes de marcar el recurso como consumido.

### [2026-07-04] FIX-PACK MNR-b — charged-but-502 si el settle falla tras débito OK
- **Error**: el `settle('redeemed')` del happy-path vivía dentro del try; si el
  RPC settle fallaba DESPUÉS de que execute ya debitó, el catch lo trataba como
  fallo → `settle('failed')` + 502. El caller pagó y el agente corrió, pero
  recibía error y el result se descartaba.
- **Causa raíz**: el bookkeeping del settle y la ejecución/débito estaban bajo el
  mismo try; un fallo POST-dinero se confundía con un fallo PRE-dinero.
- **Fix**: `settle('redeemed')` en su propio try/catch; si falla, log de
  reconciliación + devolver el `RedeemResult` igual (el dinero ya se movió; un
  retry cae en `LINK_ALREADY_USED` porque el link quedó en 'redeeming', cero
  doble-cobro). NO degradar a 502.
- **Aplicar en**: todo settle/bookkeeping que corra DESPUÉS de un débito
  irreversible. El fallo del bookkeeping no debe revertir/ocultar el resultado del
  dinero ya movido — loguear para reconciliación y devolver éxito.

### [2026-07-04] FIX-PACK MNR-c (solo mainnet, DOCUMENTADO — sin cambio de lógica)
- **Observación**: el cap-gate del redeem compara `price` (y `price*(1+fee)` en el
  execute) contra `max_price_usdc`, pero el cargo REAL que suma
  `executeApprovedPlan` incluye `gasOverhead` (`getStepGasOverheadUsd`,
  `lib/gas-overhead.ts:362`, `STEP_GAS_OVERHEAD_USD`, default 0). En MAINNET
  (overhead > 0) el owner podría pagar hasta `max_price_usdc + gasOverhead`,
  excediendo el cap nominal del link.
- **Estado**: NO se cambió la lógica ahora — el comportamiento es HEREDADO de
  `executeApprovedPlan` y en testnet/default el overhead es 0 (sin impacto).
- **Aplicar al ir a MAINNET**: el cap-gate del redeem (`agent-link.ts`, tras
  `resolveAgentPriceUsdc`) debe contemplar el gas: comparar
  `price + getStepGasOverheadUsd(link.chain_id)` (y su fee) contra
  `max_price_usdc`, o documentar explícitamente que el cap es pre-gas. Sin esto,
  el owner de un link en mainnet paga por encima del cap que fijó.
