# AR Report — WKH-SEC-03 x402 inbound binding (CRIT-1) — 2026-06-23
Veredicto: APROBADO — 0 BLQ, 1 MNR. **Bypass de cobro x402 inbound CERRADO en las 3 cadenas.** Tests 131/131 (binding+legacy+adapters), tsc 0, biome 0.
- Bypass cerrado: binding check (x402.ts:229-277) corre ENTRE decode y el primer verify() (:280). to!=payTo → 402 sin verify/settle (T-AC1); value<required (1 wei) → 402 (T-AC2). Auto-pago de 1 wei rechazado (T-3CHAINS).
- payTo/required de fuente confiable: resolvePaymentRequirements (x402.ts:71-81) = PAYMENT_WALLET_ADDRESS||KITE_WALLET_ADDRESS + opts.amount??quote — misma que buildX402Response. Atacante no influye.
- Comparación robusta: to case-insensitive (CD-3), value BigInt atómico sin escalar (CD-7, 6-dec base/avax vs 18-dec kite controlado), parse-error→reject, type-guard string.
- 3 cadenas + ambos modos kite (Pieverse + x402): adapters arman body con payTo/amount del SERVER (no del caller). AC-4 non-tautológico.
- No regresión: challenge 402 intacto (T-NOREG), suites legacy verdes, pago legítimo pasa (T-AC3). Disclosure: body de reject genérico, detalle solo al log (X402_BINDING_MISMATCH).
- MNR-1 (cosmético): falta test del caso authorization.to/value no-string (se rechaza correcto pero sin assert). Backlog.
