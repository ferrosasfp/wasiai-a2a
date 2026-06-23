# Final Report — WKH-SEC-03: x402 inbound binding (CRÍTICO — cierre del bypass de cobro)

> Status: DONE · 2026-06-23 · Branch: fix/123-wkh-sec-03-x402-binding · Modo: QUALITY AUTO · F4: APROBADO PARA DONE (6/6 ACs)

## Resumen
Cierra el hallazgo CRÍTICO de la auditoría project-wide (CRIT-1): x402 inbound aceptaba pagos sin comparar `authorization.to` vs el wallet de cobro del server ni `value` vs el monto requerido → un caller firmaba un auto-pago de 1 wei a su propia dirección y obtenía acceso pago a /compose+/orchestrate SIN pagarle a WasiAI (bypass total del cobro = el modelo de negocio). Fix en 2 capas: binding check en `src/middleware/x402.ts` (to===payTo + value>=requiredAmount) ANTES de verify/settle, y propagación de los `paymentRequirements` del server a los 3 adapters (defensa en profundidad — el body al facilitator usa payTo/amount del server, no del caller).

## Pipeline (QUALITY AUTO)
HU_APPROVED + SPEC_APPROVED self-aprobados → F2.5 → F3 → AR (APROBADO, 0 BLQ, 1 MNR cosmético) + CR (APROBADO, 0/0) → F4 (APROBADO PARA DONE, 6/6 ACs).

## AC results: 6/6 PASS (ver validation.md)
to-mismatch→402 sin verify/settle · underpay→402 · pago correcto+overpay→pasa · 3 cadenas (kite 18-dec, base/avax 6-dec) · body server-side en adapters · log X402_BINDING_MISMATCH sin exponer wallet.

## Gates: tsc 0 · biome 0 · vitest 1656/0 (suite completa). Suites x402 legacy verdes.

## Archivos
`src/middleware/x402.ts` (resolvePaymentRequirements + binding check), `src/adapters/types.ts` (paymentRequirements? opcional), `src/adapters/{base,avalanche,kite-ozone}/payment.ts` (body server-side) + tests (x402.binding.test.ts nuevo + base/avalanche/payment.contract AC-4 + 2 legacy ajustados).

## NC resueltos: NC-1 (el facilitator NO enforce requirements → validación en middleware OBLIGATORIA, self-contained) · NC-2 (sin caso legítimo to!=payTo en inbound, lockeado).

## TD: MNR-1 (AR, cosmético): test del caso authorization.to/value no-string (se rechaza correcto, sin assert). Backlog.

## Deploy: code-only, sin migración. Merge a main → Railway auto-deploy → el cobro x402 inbound empieza a enforzarse correctamente (cierra el bypass en prod).
