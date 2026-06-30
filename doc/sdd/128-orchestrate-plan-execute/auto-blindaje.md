# Auto-Blindaje — HU-128 / WKH-131 (Dev F3)

Registro de errores cometidos durante la implementación y su fix, para blindar futuras HUs.

### [2026-06-30] Wave 1 — Tests del atómico fallaban por mock de discovery incompleto
- **Error**: tras extraer `planOrchestration`, los 44 tests del atómico en `orchestrate.test.ts` fallaban con `discoveryService.getAgent is not a function`.
- **Causa raíz**: el nuevo `planOrchestration` resuelve `costPerStep` + `maxQuotedCostUsdc` server-side vía `resolveAgentPriceUsdc` → `discoveryService.getAgent`, llamada que el atómico original NO hacía. El mock de `./discovery.js` en `orchestrate.test.ts` solo exponía `discover`, no `getAgent`.
- **Fix**: agregué `getAgent: vi.fn()` al mock + un default en `beforeEach` que resuelve por slug contra `mockAgents`, + `_resetAgentPriceCache()` en `beforeEach` (el cache de `agent-price.ts` es module-level → bleed entre tests). NO toqué ninguna aserción de comportamiento del atómico (CD-4 intacto). Esto fue un cambio de SETUP de mock, no de aserción.
- **Aplicar en**: cualquier extracción que mueva un consumo de `resolveAgentPriceUsdc` a un path que antes no lo invocaba → revisar que los mocks de borde (`discovery.getAgent`) y el reset de cache estén presentes.

### [2026-06-30] Wave 3 — T-EXEC-4 cobraba todos los steps al mismo precio
- **Error**: el invariante de débitos disjuntos daba 0.03 en vez de 0.06 (compose resolvía a2/a3 con el precio de a1).
- **Causa raíz**: usé `discoveryService.getAgent.mockResolvedValue(a1)` (devuelve a1 para CUALQUIER slug). Compose resuelve cada step per-slug → todos quedaban a 0.01.
- **Fix**: helper `getAgentBySlug(agents)` que mockea `getAgent` con `mockImplementation` resolviendo por slug. Aplica en cualquier test multi-step con compose real.
- **Aplicar en**: tests de compose real con >1 step → `getAgent` SIEMPRE por slug, nunca `mockResolvedValue` de un único agente.

### [2026-06-30] Wave 3 — T-EXEC-5 no forzaba fallo total del pipeline
- **Error**: `mockFetch` (reject) no producía `pipeline.success:false`; el step priced corría sign/settle + retry y "tenía éxito".
- **Causa raíz**: para un agente con `priceUsdc>0` el invoke firma x402 + tiene retry adaptativo (compose.ts:435), así que un solo `mockRejectedValueOnce` no garantiza fallo total y arrastra maquinaria de refund per-step (creditWithDest no mockeado).
- **Fix**: `invokeUrl: 'http://127.0.0.1:9/...'` → el SSRF guard de compose bloquea el step-0 (i=0, sin débito per-step ni retry) ANTES de settlear → `pipeline.success:false, totalCostUsdc:0` limpio → el credit-back del step-0 lo hace la capa orchestrate (lo que el test valida).
- **Aplicar en**: para probar fallo TOTAL del pipeline con compose real, usar un invokeUrl SSRF-bloqueado en el step-0 en vez de manipular `mockFetch` (evita la maquinaria de retry/refund per-step).

### [2026-06-30] Wave 3 (W3.4) — biome dejó un non-null assertion a medias
- **Error**: `biome check --write` (fixes seguros) convirtió `steps[0]!.registry` → `steps[0]?.registry` pero dejó `steps[0]!.agent` (fix "unsafe" skipeado) → mezcla inconsistente.
- **Causa raíz**: el codebase prohíbe non-null assertions (`lint/style/noNonNullAssertion`); biome no aplica el fix unsafe automáticamente.
- **Fix**: reemplacé los `steps[0]!` por un guard explícito `const step0 = steps[0]; step0 ? ... : null` (el schema garantiza `minItems:1`, pero el guard sigue la convención del codebase sin assertions).
- **Aplicar en**: nunca dejar que biome resuelva non-null assertions a medias; resolverlas con guard explícito en el código de la HU.

### [2026-06-30] FIX-PACK (AR) — BLQ-MED-1: replay del orchestrationId de cliente cobra fee 1 sola vez
- **Error**: `/execute` (`routes/orchestrate.ts:309`) tomaba el `orchestrationId` del cliente (`request.body.orchestrationId`, schema solo `minLength:1`) y lo usaba como clave de idempotencia del protocol fee (`fee-charge.ts` keya por `orchestration_id`). Reusando un id ya `charged`, el step-0 + compose se re-ejecutaban (mueven fondos reales) pero `chargeProtocolFee` devolvía `already-charged` → el gateway cobraba 0% fee en la 2da+ ejecución (revenue leak).
- **Causa raíz**: la idempotencia del fee/billing dependía de un valor controlable e inforjeable POR el cliente. El atómico (`L90`) y `/plan` (`L197`) ya generan el id server-side con `crypto.randomUUID()`; `/execute` era la única ruta que lo tomaba del body.
- **Fix**: en `/execute` el `orchestrationId` interno (clave de fee/débito/telemetría) se genera server-side con `crypto.randomUUID()` (igual que el atómico y `/plan`) y es el que se pasa a `executeApprovedPlan` (3er arg) y a `plan.orchestrationId`. El id del cliente se conserva SOLO como correlación (`planId` en los log lines de info/error). El schema del body sigue aceptando `orchestrationId` del cliente (contrato intacto) pero NO se usa para billing. El service quedó intacto (es genérico: usa el id que recibe). Test anti-regresión T-EXEC-9 en `routes/orchestrate.test.ts`: 2 `/execute` con el MISMO id de cliente → 2 execution-ids server-side DISTINTOS pasados a `executeApprovedPlan` (falla contra el código viejo donde ambos = id del cliente, pasa con el fix).
- **Aplicar en**: NUNCA usar un valor controlado por el cliente como clave de idempotencia de un cobro/movimiento de fondos. Las claves de billing/fee/débito se generan server-side. Revisar cualquier ruta nueva que reciba un id del body y lo propague a `chargeProtocolFee` / `budgetService.debit` / telemetría de costo.
