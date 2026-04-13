# Work Item — [WKH-KXUSD] Migrate x402 payment token from PYUSD to KXUSD

## Resumen

Migrar el adapter de pago x402 de Kite Ozone (kite-ozone) para usar el token KXUSD
(0x1b7425d288ea676FCBc65c29711fccF0B6D5c293) en lugar de PYUSD, que no funciona en
Kite testnet. El token address, el EIP-712 domain name y version, y la wallet address
de pago dejan de ser hardcodes y pasan a resolverse desde variables de entorno, en
cumplimiento del Golden Path. Scope acotado al adapter x402; el adapter gasless (PYUSD)
no se toca.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Branch sugerido: feat/WKH-KXUSD-token-migration
- Flow: FAST+AR (cambio de config crítica on-chain — requiere Adversarial Review)

## Skills relevantes

- blockchain-evm (EIP-712, EIP-3009, viem)
- backend-ts (env vars, TypeScript strict, Fastify adapter)

---

## Acceptance Criteria (EARS)

- AC-1: WHEN the service starts, the system SHALL read the x402 payment token address
  from `X402_PAYMENT_TOKEN` env var and use it in all x402 payment flows (verify,
  settle, quote, sign), with no hardcoded address in `payment.ts`.

- AC-2: WHEN `X402_PAYMENT_TOKEN` is not set, the system SHALL default to
  `0x1b7425d288ea676FCBc65c29711fccF0B6D5c293` (KXUSD) and log a warning at startup.

- AC-3: WHEN the service starts, the system SHALL read the EIP-712 domain name from
  `X402_EIP712_DOMAIN_NAME` (default: `"Kite X402 USD"`) and version from
  `X402_EIP712_DOMAIN_VERSION` (default: `"1"`), using them when building the
  `signTypedData` domain object.

- AC-4: WHEN generating the 402 Payment Required response, the system SHALL report
  the token symbol as `KXUSD` (or the value of `X402_TOKEN_SYMBOL` if provided) in
  `supportedTokens` and in the `quote()` return value.

- AC-5: WHEN `PAYMENT_WALLET_ADDRESS` or `KITE_WALLET_ADDRESS` is set to a non-empty
  value, the system SHALL use that address in the 402 response `payTo` field (existing
  behavior — not regressed by this change).

- AC-6: IF any of the three new env vars (`X402_PAYMENT_TOKEN`, `X402_EIP712_DOMAIN_NAME`,
  `X402_EIP712_DOMAIN_VERSION`) is absent, THEN the system SHALL fall back to the
  documented default and SHALL NOT throw at startup.

- AC-7: WHEN `.env.example` is read, the system SHALL contain documented entries for
  `X402_PAYMENT_TOKEN`, `X402_EIP712_DOMAIN_NAME`, `X402_EIP712_DOMAIN_VERSION`,
  and `X402_TOKEN_SYMBOL`, with KXUSD values as examples and an explanatory comment.

- AC-8: WHEN `KITE_WALLET_ADDRESS` is documented in `.env.example`, the system SHALL
  show `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` as the example value (replacing
  the generic placeholder).

---

## Scope IN

| File | Change |
|------|--------|
| `src/adapters/kite-ozone/payment.ts` | Remove PYUSD hardcode; resolve token address, EIP-712 domain name/version, and token symbol from env vars with KXUSD defaults |
| `.env.example` | Add `X402_PAYMENT_TOKEN`, `X402_EIP712_DOMAIN_NAME`, `X402_EIP712_DOMAIN_VERSION`, `X402_TOKEN_SYMBOL`; update `KITE_WALLET_ADDRESS` example |

## Scope OUT

- `src/adapters/kite-ozone/gasless.ts` — PYUSD gasless adapter is a separate concern; do NOT modify
- `src/adapters/kite-ozone/index.ts` — factory requires no changes
- `src/middleware/x402.ts` — reads from adapter interface; no changes needed
- `src/types/index.ts` — `GaslessSupportedToken` comment references PYUSD; do NOT change (gasless scope)
- Deposit/bind endpoints — remain 501 Not Implemented; out of scope
- Tests — existing unit tests for payment adapter SHALL be updated to assert env-var-driven behavior (in scope as part of the same wave, not a separate PR)

---

## Decisiones técnicas

- DT-1: Defaults are KXUSD values, not PYUSD. Any operator that has no env var set
  gets a working configuration out of the box for Kite testnet. This is a deliberate
  break from the previous default.

- DT-2: Token address, EIP-712 domain name, and version are read at call time (lazy,
  from `process.env`) rather than at module load time, so the wallet client singleton
  is not affected and tests can override env vars without module reload.

- DT-3: `X402_TOKEN_SYMBOL` is optional. If absent, the symbol defaults to `"KXUSD"`.
  This allows future token migrations without code changes.

- DT-4: The `verifyingContract` field in `EIP712_DOMAIN` remains `KITE_FACILITATOR_ADDRESS`
  (hardcoded). This is intentional: the Pieverse facilitator address is an infrastructure
  constant, not a per-token setting. [NEEDS CLARIFICATION if Pieverse requires a different
  verifyingContract for KXUSD — if yes, add `X402_FACILITATOR_ADDRESS` env var in F2.]

---

## Constraint Directives

- CD-1: PROHIBIDO hardcodear `0x1b7425d288ea676FCBc65c29711fccF0B6D5c293` o cualquier
  contract address en `payment.ts`. Todo contract address va en env var con default documentado.
- CD-2: PROHIBIDO usar `any` o `as unknown` en los cambios. TypeScript strict se mantiene.
- CD-3: PROHIBIDO modificar `gasless.ts`, `gasless/` o cualquier type que sea exclusivo del adapter gasless.
- CD-4: OBLIGATORIO que `.env.example` documente todas las nuevas vars con comentario que explique el propósito y el contrato KXUSD verificado en Kite testnet.
- CD-5: PROHIBIDO modificar la interface `PaymentAdapter` en `src/adapters/types.ts` — el contrato ya es suficiente.

---

## Missing Inputs

- [NEEDS CLARIFICATION] DT-4: ¿El Pieverse facilitator requiere un `verifyingContract` diferente para KXUSD, o el mismo `0x12343e649e6b2b2b77649DFAb88f103c02F3C78b` que se usaba con PYUSD?
  - Si la respuesta llega antes de F3 → resolver en SDD (F2).
  - Si no hay respuesta → asumir mismo facilitator address (safe default, se puede cambiar sin breaking change agregando otra env var).

---

## Análisis de paralelismo

- Esta HU es independiente de todas las HUs `in progress` (025, 026, 028, 029, 030, 031, 032, 033, 034, 035, 036, 037).
- Toca únicamente `payment.ts` y `.env.example`.
- No bloquea ninguna HU conocida.
- Puede ir en paralelo con cualquier HU que no toque `src/adapters/kite-ozone/payment.ts`.
- Riesgo de merge conflict bajo: el archivo `payment.ts` no está siendo modificado por ninguna HU activa (verificado en INDEX).
