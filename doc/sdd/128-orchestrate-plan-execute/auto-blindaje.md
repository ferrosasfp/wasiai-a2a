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
