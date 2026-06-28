# Auto-Blindaje — x402 challenge real amount (money-path fix)

### [2026-06-28 13:28] Wave 2 — Augmentation broke "resolveAgentPriceUsdc called once" assertion
- **Error**: tras agregar `augmentX402ChallengeAmount`, el test E2E pre-existente
  `T-E2E-PRICE-1` falló: esperaba `resolveAgentPriceUsdc` llamado 1 vez, pero la
  augmentación lo re-llamaba para CADA step (incluido el step-0 ya resuelto por
  el preHandler), dando 2 llamadas en un pipeline de 1 step.
- **Causa raíz**: la primera versión del helper resolvía el precio de TODOS los
  steps desde cero, duplicando la resolución del step-0 que el preHandler ya
  había hecho (`price`).
- **Fix**: el helper ahora recibe `step0Usd` ya resuelto y solo resuelve los
  steps `1..N` (`for (let i = 1; ...)`). Un pipeline de 1 step no hace llamadas
  extra → preserva el contrato de resolución única + es más eficiente.
- **Aplicar en**: cualquier augmentación que se monte sobre un preHandler que ya
  resolvió datos del registry — reusar el valor ya resuelto en vez de re-fetch,
  y respetar las aserciones de conteo de llamadas de los tests existentes.

### [2026-06-28 13:38] Fix-pack AR — Early-return en step malformado colapsaba el challenge a 1 USD (BLQ-MEDIO-1)
- **Error**: en `augmentX402ChallengeAmount`, un step `i>=1` con `agent` no-string
  hacía `return;` SIN setear `request.x402ChallengeAmountUsd`. El middleware caía
  al default `quote(1) = 1 USDC`. Pero `composeService.compose` settlea el prefijo
  `0..i-1` downstream antes de fallar en el step inválido, y el path x402 NO tiene
  refund inbound (el bloque de refund está gateado por `request.a2aKeyRow`). Neto:
  caller paga 1 USDC inbound, gateway paga `sum(prefix prices)` downstream →
  pérdida del gateway + rompe la invariante never-undercharge.
- **Causa raíz**: el helper "no adivinaba" ante input malformado dejando el
  default, pero ese default (1 USD) es exactamente el under-estimate peligroso. La
  ruta sólo validaba el step-0 (vía el price preHandler), no los steps `1..N`.
- **Fix** (defensa en profundidad, 2 capas):
  1. El helper ya NO hace early-return: trata el step malformado como
     `PLACEHOLDER_FEE_USD` (mismo over-estimate que precios not-found) y sigue
     sumando → el challenge SOBRE-estima en vez de sub-estimar.
  2. El route handler ahora rechaza con 400 (`VALIDATION_ERROR`) cualquier body
     donde ALGÚN step carezca de `agent` string (antes sólo el step-0) → un
     pipeline malformado NUNCA settlea un prefijo parcial.
- **Aplicar en**: cualquier path donde un default "seguro" sea en realidad un
  under-estimate en money-path. Ante input que no se puede resolver limpio, el
  fallback debe SIEMPRE over-estimar (o rechazar up-front), nunca caer a un valor
  menor que el costo real. Validar TODOS los items de un array, no sólo el primero.

### [2026-06-28 13:38] Fix-pack AR — quote() crasheaba con notación científica (MNR-1)
- **Error**: `parseUnits(String(amountUsd), ...)` — `String(1e-7) === '1e-7'`, que
  `parseUnits` rechaza (no es decimal plano) → throw.
- **Causa raíz**: `String(n)` de un número muy chico emite notación científica.
- **Fix**: normalizar con `amountUsd.toFixed(DECIMALS)` ANTES de `parseUnits` en
  los 3 adapters (base/avax 6 dec, kite 18 dec). `toFixed` siempre emite decimal
  plano y aplana al grid del token.
- **Aplicar en**: cualquier `parseUnits`/`parseEther` que reciba un `number` —
  normalizar SIEMPRE con `.toFixed(decimals)`, nunca `String(n)`.

### [2026-06-28 13:38] Fix-pack AR — Total sub-microdólar redondeaba el challenge a 0 atómico (MNR-2)
- **Error**: el guard era `if (pipelineUsd <= 0) return;`, pero `total` (tras
  `.toFixed(6)`) puede redondear a 0 a 6 decimales aun con `pipelineUsd > 0`,
  advertibiendo un challenge de 0.
- **Causa raíz**: el guard estaba sobre el valor PRE-redondeo, no sobre el valor
  final que se advierte.
- **Fix**: guard sobre `total`; cuando `total <= 0` pero `pipelineUsd > 0`, piso
  el challenge a `0.000001` (>= 1 unidad atómica) — nunca advierte 0.
- **Aplicar en**: cualquier redondeo a N decimales en money-path — el guard debe
  estar sobre el valor FINAL post-redondeo y pisar a >= 1 unidad atómica si el
  valor real es > 0 pero redondea a 0.
