# Work Item — [WKH-SEC-03] x402 inbound: ligar recipient + amount (cerrar bypass de cobro CRÍTICO)

## Resumen

El middleware x402 inbound (`requirePayment`) acepta cualquier pago auto-consistente que firme el caller sin validar que el destinatario sea el wallet del server ni que el monto cubra el precio del recurso. Un atacante puede firmar un pago de 1 wei a su propia dirección, pasarlo a `verify()`/`settle()` y obtener `paymentVerified=true` sin pagarle a WasiAI. Este work item cierra ese bypass añadiendo binding `to` + `value` en el middleware (antes de llamar al adapter) y corrigiendo la construcción del body canónico en los 3 adapters (kite-ozone, base, avalanche) para usar los `paymentRequirements` del server en lugar de los valores del caller.

## Sizing

- SDD_MODE: full
- Estimación: M
- Branch sugerido: `fix/123-wkh-sec-03-x402-binding`

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `requirePayment` recibe un `X-PAYMENT`/`payment-signature` cuya `authorization.to` (normalizado lowercase) no es igual al `walletAddress` del server para esa cadena, THEN the system SHALL rechazar con HTTP 402 y el body de `buildX402Response`, sin llamar a `verify()` ni `settle()`.

- **AC-2**: WHEN `requirePayment` recibe un `X-PAYMENT`/`payment-signature` cuya `authorization.value` (parseado como `BigInt`) es menor que el `maxAmountRequired` calculado para ese recurso/cadena, THEN the system SHALL rechazar con HTTP 402 y el body de `buildX402Response`, sin llamar a `verify()` ni `settle()`.

- **AC-3**: WHEN `requirePayment` recibe un `X-PAYMENT`/`payment-signature` con `authorization.to === walletAddress` (case-insensitive) y `authorization.value >= maxAmountRequired` y la firma es válida según el facilitator, THEN the system SHALL llamar a `settle()` y setear `request.paymentVerified = true` (flujo legítimo intacto).

- **AC-4**: WHEN el adapter (kite-ozone, base o avalanche) construye el cuerpo del request al facilitator para `verify()` o `settle()`, THEN the system SHALL usar el `payTo` y `maxAmountRequired` provistos por el server (no los valores de `authorization.to`/`authorization.value` del caller) en el campo `paymentRequirements` / `accepted`.

- **AC-5**: WHEN `requirePayment` valida el binding `to`/`value` para una cadena cuyo token tiene decimales distintos de 18 (ej. USDC 6 decimales en Base/Avalanche), THEN the system SHALL comparar `authorization.value` contra el `maxAmountRequired` en las unidades nativas de esa cadena (el mismo string que el adapter devuelve por `quote()` o el que se le pasó como `opts.amount`), sin escalar artificialmente.

- **AC-6**: WHEN el flujo de pago x402 inbound es rechazado por binding `to` o `value`, THEN the system SHALL emitir un log estructurado con `error_code: 'X402_BINDING_MISMATCH'`, los valores recibidos (to/value) y los esperados (payTo/requiredAmount) para auditoría, sin exponer el `walletAddress` completo al caller en el body de error 402.

## Scope IN

- `src/middleware/x402.ts` — añadir validación `to`/`value` en `requirePayment` entre `decodeXPayment` y la llamada a `verify()` (líneas ~212-218); la función `buildX402Response` ya resuelve correctamente `walletAddress` y `amount`, reutilizar esos valores para la comparación.
- `src/adapters/kite-ozone/payment.ts` — extender la firma de `verify()`/`settle()` (y los helpers internos `buildX402CanonicalBody`, Pieverse body builder) para recibir `paymentRequirements: { payTo, maxAmountRequired }` y usarlos en lugar de `proof.authorization.to`/`.value`. Afecta las líneas 244-260 (verify Pieverse) y 290-304 (settle Pieverse) y 450-456 (buildX402CanonicalBody x402 mode).
- `src/adapters/base/payment.ts` — mismo cambio en `buildX402CanonicalBody` (líneas 248-251) y los llamadores `verifyX402`/`settleX402`.
- `src/adapters/avalanche/payment.ts` — mismo cambio en `buildX402CanonicalBody` (líneas ~221-228) y los llamadores.
- `src/adapters/types.ts` — extender `X402Proof` y `SettleRequest` con campo opcional `paymentRequirements?: { payTo: string; maxAmountRequired: string }` (backward compatible — los adapters en modo outbound no lo necesitan).
- Tests nuevos en `src/middleware/` cubriendo AC-1, AC-2, AC-3, AC-6 con mocks de adapter.
- Tests nuevos o actualizados en `src/adapters/*/payment.test.ts` cubriendo AC-4 (que el body enviado al facilitator usa el `payTo` del server).

## Scope OUT

- El path outbound (`sign()` / downstream-payment) — no se toca. Solo inbound.
- La función `buildX402Response` — ya es correcta, no cambia.
- Los otros findings de la auditoría (MED-1 LLM cost billing, MED-2 fee base, BAJO-1/BAJO-2) — HUs separadas.
- Contratos Solidity, migración de DB.
- La lógica de resolución de chain (`resolveChainKey`, `getDefaultChainKey`) — no cambia.
- Rutas `/gasless`, `/discover`, `/registries` — no se tocan.

## Decisiones técnicas (DT-N)

- **DT-1 — Validación en middleware (app-layer) vs en adapter vs en facilitator**: la validación se hace en `requirePayment` ANTES de llamar al adapter. Es la defensa primaria. Adicionalmente el adapter debe enviar los requirements del server al facilitator (no los del caller). Esto da defensa en profundidad: (a) el middleware rechaza antes de network call, (b) el facilitator recibe los requirements correctos. El facilitator self-hosted (wasiai-facilitator) puede hacer su propia validación pero el server no puede asumirlo — la defensa primaria siempre es app-layer. Aplica a los 3 adapters en paralelo.

- **DT-2 — Comparación de `value` en unidades nativas**: `maxAmountRequired` en `buildX402Response` ya viene del `adapter.quote()` o de `opts.amount` — es un string en unidades nativas del token de esa cadena. La comparación `BigInt(authorization.value) >= BigInt(maxAmountRequired)` es directa si ambos están en la misma unidad. El middleware DEBE tener el `amount` resuelto antes de comparar; actualmente `buildX402Response` lo calcula (await async). Se debe extraer la resolución del `amount` + `walletAddress` al inicio del handler para poder reutilizarlos en la comparación sin llamar `quote()` dos veces.

- **DT-3 — Cambio de firma de `verify()`/`settle()` en los adapters**: el `PaymentAdapter` interface en `types.ts` define `verify(proof: X402Proof)` y `settle(req: SettleRequest)`. Agregar `paymentRequirements` como campo opcional en `X402Proof` y `SettleRequest` es backward-compatible y no rompe los adapters de modo outbound (que no lo proveen). Alternativa (NO elegida): crear un nuevo método `verifyWithRequirements()` — agrega complejidad innecesaria.

- **DT-4 — ¿El facilitator (Pieverse / wasiai-facilitator) valida `payTo`/`maxAmountRequired` hoy?**: el facilitator self-hosted (`wasiai-facilitator-production.up.railway.app`) NO es auditado en este work item — el código en wasiai-a2a no puede asumir que lo haga. En modo Pieverse (kite-ozone), el body ya incluye `paymentRequirements.payTo`/`maxAmountRequired` derivados de `authorization.to`/`.value` del caller (el bug), así que Pieverse recibe el `payTo` del atacante y lo valida contra sí mismo — siempre pasa. Después del fix, Pieverse recibirá el `payTo` del server, que es la validación correcta. Si el facilitator rechaza por mismatch, es un resultado correcto. [NEEDS CLARIFICATION: confirmar con el operador si el facilitator wasiai self-hosted valida `accepted.payTo` contra el `payTo` real del server, o solo valida la firma EIP-3009 — esto determina si la defensa en profundidad en el adapter es suficiente o si es únicamente el middleware quien debe actuar como primera línea].

- **DT-5 — Caso borde: `opts.amount` no se pasa al middleware (es opcional)**: cuando `opts.amount` es undefined, `buildX402Response` hace `await adapter.quote(1)` para obtener `amountWei`. El handler en `requirePayment` debe hacer esa misma resolución eager al inicio y conservar el resultado para la comparación posterior — evitar doble `quote()`.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO llamar `adapter.verify()` o `adapter.settle()` si la validación de `authorization.to` o `authorization.value` falla. El reject debe ser antes del network call al facilitator.
- **CD-2**: PROHIBIDO exponer el `walletAddress` completo del server en el body de error 402 al caller. El log interno puede tenerlo, el response body no.
- **CD-3**: OBLIGATORIO que la comparación `authorization.to === walletAddress` sea case-insensitive (`.toLowerCase()` en ambos lados). Las direcciones EVM son hex case-insensitive.
- **CD-4**: OBLIGATORIO mantener backward compatibility en el `PaymentAdapter` interface — el campo `paymentRequirements` en `X402Proof`/`SettleRequest` debe ser `optional`. Los adapters outbound (sign path) no lo proveen y no deben romperse.
- **CD-5**: PROHIBIDO modificar la lógica de resolución de `walletAddress` existente en `buildX402Response`. Reutilizar `process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS` tal cual.
- **CD-6**: OBLIGATORIO que los tests nuevos usen mocks de `fetch`/adapter (no network real) y que los mocks de verify/settle incluyan un test que verifica que el mock NO es llamado cuando el binding falla.

## Missing Inputs

- [NEEDS CLARIFICATION] DT-4: ¿el wasiai-facilitator self-hosted valida `accepted.payTo`/`amount` contra una política propia, o solo valida la firma EIP-3009? Si lo valida, la corrección en el adapter es redundante pero recomendada. Si no lo valida, el adapter es la única defensa a nivel network. Esto no bloquea F2 — el fix en middleware es suficiente sin importar la respuesta; el fix en adapters es defensa en profundidad. Se puede resolver en F2 inspeccionando el repo del facilitator si está disponible.
- [NEEDS CLARIFICATION] ¿Hay algún caso de uso legítimo donde `authorization.to !== walletAddress` sea intencional (ej. pagos multi-hop, escrow no-custodial)? Si existe, necesita una excepción explícita documentada. Por ahora asumimos que no existe en el path inbound de `/compose`/`/orchestrate`. Resolver en F2.

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs activas. El fix es contenido en middleware + adapters, sin cambios de DB ni contratos.
- Puede ir en paralelo con cualquier HU de feature nueva. No hay conflicto con `fix/117-session-dest-cap` (branch activo) ya que toca archivos distintos.
- Es bloqueante para cualquier go-live de `/compose`/`/orchestrate` con callers x402 no autenticados con agent key — el bypass es total y hoy explotable en producción.
