# Work Item — [WKH-52] Migrate x402 payment token from KXUSD → PYUSD

## Resumen

Migrar el token de pago por defecto del adaptador x402 de KXUSD (community-made, workaround temporal introducido en WKH-KXUSD commit `874874657a`) a PYUSD (`0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`), el token canónico oficial de la testnet Kite. La migración elimina tech debt y alinea la narrativa del hackathon con los jueces de Kite. El cambio es de configuración + test update; la lógica EIP-712/settle no se modifica.

## Sizing

- **SDD_MODE**: full
- **Estimación**: S
- **Flow**: QUALITY (toca payment path crítico, cambia env vars de producción, requiere AR + CR antes de merge)
- **Branch sugerido**: `feat/052-wkh-52-pyusd-migration`

> Justificación QUALITY: aunque el volumen de cambios es pequeño (4 archivos src + 2 env + 1 doc), el payment path es crítico para el hackathon y el Railway env post-merge requiere un gate humano. Un AR attack surface check es obligatorio para esta clase de cambio.

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `X402_PAYMENT_TOKEN` is not set in env, the system SHALL use `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` as default payment token AND SHALL emit a console.warn containing the text `"defaulting to PYUSD"`.

- **AC-2**: WHEN `X402_TOKEN_SYMBOL` is not set in env, the system SHALL return `"PYUSD"` as the default token symbol for `supportedTokens[0].symbol`.

- **AC-3**: WHEN a client sends `POST /orchestrate` to a service without `X402_PAYMENT_TOKEN` set, the system SHALL respond with HTTP 402 where `accepts[0].asset` equals `"0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9"`.

- **AC-4**: WHEN the test suite runs, the system SHALL pass all tests in `src/adapters/__tests__/payment.contract.test.ts` with assertions updated to expect `PYUSD` symbol and `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` address as defaults (replacing previous KXUSD expectations).

- **AC-5**: WHEN `X402_PAYMENT_TOKEN` env var is set to any valid `0x...` address different from the PYUSD default, the system SHALL use that address as the active payment token (backward-compat env override preserved).

- **AC-6**: WHEN a developer reads `doc/INTEGRATION.md`, the system SHALL present PYUSD as the canonical token in all mentions (L196 asset description, L213 402-response snippet, L235 settle narrative), with no remaining references to KXUSD.

- **AC-7**: WHEN the full test suite runs (`vitest run`), the system SHALL pass all 379 baseline tests with no regression (0 new failures unrelated to the KXUSD→PYUSD rename).

- **AC-8**: IF `X402_PAYMENT_TOKEN` is set to the old KXUSD address in Railway env after merge to main, THEN the system SHALL continue operating with KXUSD (no forced cutover at deploy time), preserving the env-override behavior defined in AC-5.

## Scope IN

| File | Change |
|------|--------|
| `src/adapters/kite-ozone/payment.ts` | `DEFAULT_PAYMENT_TOKEN` → PYUSD address; `DEFAULT_TOKEN_SYMBOL` → `'PYUSD'`; `DEFAULT_EIP712_DOMAIN_NAME` → `'PYUSD'`; warn messages → "defaulting to PYUSD" |
| `src/adapters/__tests__/payment.contract.test.ts` | Rename `KXUSD_DEFAULT` const → `PYUSD_DEFAULT`; update address + symbol assertions to PYUSD values; update warn message assertions |
| `src/services/fee-charge.ts` | L120 comment: "token KXUSD" → "token PYUSD" (1-line comment only) |
| `.env` | `X402_PAYMENT_TOKEN` → `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`; `X402_TOKEN_SYMBOL` → `PYUSD`; header comment updated |
| `.env.example` | Same as `.env` — update token address, symbol, and comments |
| `doc/INTEGRATION.md` | L196, L213, L235 — replace KXUSD address + symbol with PYUSD equivalents |

## Scope OUT

- `src/adapters/kite-ozone/gasless.ts` — already uses PYUSD correctly (FALLBACK_TOKEN L23); DO NOT touch
- `src/adapters/kite-ozone/chain.ts` — chain config, no token refs
- `src/adapters/kite-ozone/payment.ts` — EIP-712 signing logic, settle logic, verify logic — NOT changed
- `doc/sdd/037-x402-v2/*` — historical SDD, DO NOT touch
- `doc/sdd/041-wkh-kxusd/*` — historical SDD (original KXUSD migration), DO NOT touch
- E2E tests against Pieverse (`feat/029-e2e-tests`) — blocked by WKH-45, out of scope
- Railway env vars — human gate post-merge, out of scope for this branch
- Any changes to `PaymentAdapter` interface shape or public method signatures

## Decisiones técnicas

- **DT-A**: Default del código (`DEFAULT_PAYMENT_TOKEN`) pasa a ser PYUSD (`0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`). El env override via `X402_PAYMENT_TOKEN` sigue siendo el mecanismo de runtime, garantizando que la actualización de Railway sea un paso manual post-merge controlado por el humano.

- **DT-B**: `DEFAULT_EIP712_DOMAIN_NAME` pasa de `'Kite X402 USD'` a `'PYUSD'`. Esto es consistente con el valor ya utilizado en `src/adapters/kite-ozone/gasless.ts:23` (FALLBACK_TOKEN domain name confirmado por orquestador), evitando divergencia entre adapters.

- **DT-C**: La interfaz pública de `PaymentAdapter` NO se modifica — sin cambios de firma en `quote()`, `sign()`, `settle()`, `verify()`. Solo cambian los valores de configuración internos.

## Constraint Directives

- **CD-1**: PROHIBIDO `any` explícito — TypeScript strict en todos los archivos tocados.
- **CD-2**: OBLIGATORIO mantener backward-compat via env override — AC-5 y AC-8 son no negociables.
- **CD-3**: PROHIBIDO tocar `src/adapters/kite-ozone/gasless.ts` ni ningún archivo de lógica de settle/verify.
- **CD-4**: OBLIGATORIO que los tests del archivo `payment.contract.test.ts` cubran: (a) default PYUSD sin env, (b) env override con address custom, (c) warn message contiene "PYUSD".
- **CD-5**: OBLIGATORIO baseline 379 tests sin regresión (vitest run al finalizar F3).

## Missing Inputs

Ningún bloqueante. El audit de scope fue completado por el orquestador con valores exactos verificados. Los 4 archivos src, 2 env files y 1 doc file están identificados con referencias línea por línea.

- EIP-712 domain version: `"1"` — confirmado, sin cambio necesario.
- PYUSD decimals: `18` — consistente con `DEFAULT_TOKEN_SYMBOL` lógica actual.
- Railway env update: decisión del humano post-merge (fuera de scope de branch).

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs activas (025, 026, 028, 029, 030-036, 037) — es config/test change aislado.
- NO tiene dependencia de HUs en curso — puede ir en rama independiente.
- WKH-45 (E2E Pieverse) bloquea validación E2E pero NO bloquea esta migración.
- Single wave es viable: los 6 archivos son cambios de valores constantes + test updates. El Architect confirmará en F2 si split de waves es necesario (improbable dado el tamaño).
- Riesgo de merge conflict con feat/037-x402-v2 si ese branch también toca `payment.ts`: **[NEEDS CLARIFICATION en F2]** — el Architect debe verificar estado del branch 037 antes de definir base de la rama.
