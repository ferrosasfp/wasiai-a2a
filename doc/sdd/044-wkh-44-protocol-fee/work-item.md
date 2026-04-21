# Work Item — [WKH-44] 1% Protocol Fee Real Charge

## Resumen

El protocolo calcula `protocolFeeUsdc` en `orchestrate.ts:389–391` pero lo marca explícitamente
como "display only" — el importe no se deduce del budget ni se transfiere a ningún wallet.
Esta HU convierte ese teatro en cobro real: deduce el 1% del budget antes de ejecutar el compose
downstream y dispara una transferencia x402 (EIP-712 sign + settle vía Pieverse) hacia
`WASIAI_PROTOCOL_FEE_WALLET`. Es uno de los 3 must-haves del Epic E8 Kite Integration.

---

## Sizing

- **SDD_MODE**: full
- **Flow**: QUALITY (payment path — toca cobro real on-chain)
- **Estimación**: M
- **Branch sugerida**: `feat/044-wkh-44-protocol-fee-real-charge`

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `POST /orchestrate` recibe `budget=1.00` USDC, THEN the system SHALL pasar
  `maxBudget=0.99` USDC al compose downstream (fee descontado antes de iniciar el pipeline).

- **AC-2**: WHEN el orchestrate completa con éxito (`pipeline.success=true`) Y
  `WASIAI_PROTOCOL_FEE_WALLET` está seteado, THEN the system SHALL ejecutar una transferencia
  de `0.01` USDC (1% del budget) hacia `WASIAI_PROTOCOL_FEE_WALLET` en Kite testnet.
  El fee NO se cobra si `pipeline.success=false`.
  > **Nota**: validación on-chain pendiente de fix Pieverse `/v2/verify` HTTP 500 (WKH-45).
  > F4 documenta esta limitación con evidencia y verifica via mock del paymentAdapter.

- **AC-3**: WHEN el orchestrate completa, THEN `OrchestrateResult.protocolFeeUsdc` SHALL
  reflejar el monto real deducido del budget (no el valor display-only previo basado en
  `pipeline.totalCostUsdc`).

- **AC-4**: WHEN se agregan los nuevos tests, THEN the system SHALL mantener el baseline de
  350/350 tests pasando, más los nuevos tests para el camino fee-charge.

- **AC-5**: IF `WASIAI_PROTOCOL_FEE_WALLET` no está seteado en env, THEN the system SHALL
  omitir silenciosamente el transfer del fee (log `warn` — no lanzar error) y continuar
  el orchestrate normalmente.

- **AC-6**: IF el transfer del fee falla (red, Pieverse error, timeout), THEN the system
  SHALL registrar un `console.error` con el error pero NO lanzar excepción — el orchestrate
  retorna igualmente con `feeChargeError: string` en el resultado.

- **AC-7**: IF `protocolFeeUsdc` calculado > `budget`, THEN the system SHALL lanzar un error
  400 antes de iniciar el compose (safety guard — no puede ocurrir con `PROTOCOL_FEE_RATE=0.01`
  pero la guarda protege contra futuros cambios de rate).

- **AC-8**: IF el mismo `orchestrationId` se usa para un segundo intento (re-invocación),
  THEN the system SHALL NOT volver a cobrar el fee — idempotencia garantizada via registro
  del `orchestrationId` en la primera carga.
  > Mecanismo concreto (Redis TTL vs columna `a2a_tasks`) a definir por el Architect en F2.

- **AC-9**: WHEN el orchestrate calcula el `protocolFeeUsdc`, THEN the system SHALL leer la
  tasa desde la env var `PROTOCOL_FEE_RATE` (formato decimal: `0.01` para 1%). IF la env var
  no está seteada, THEN el system SHALL usar el default `0.01`. IF la env var contiene un valor
  inválido (no parseable como float, NaN, o fuera del rango `[0.0, 0.10]`), THEN el system
  SHALL loguear un `console.error` y usar el default `0.01`.

- **AC-10**: IF el operador actualiza `PROTOCOL_FEE_RATE` en Railway (sin redeploy de código,
  solo restart del servicio), THEN el siguiente orchestrate SHALL usar el nuevo valor — NO debe
  haber cache in-memory que persista el valor viejo más allá de la vida del proceso.

---

## Scope IN

| Archivo | Cambio esperado |
|---------|-----------------|
| `src/services/orchestrate.ts` | Deducir fee de budget antes del compose; disparar fee charge post-compose solo si `pipeline.success=true` (best-effort); actualizar `protocolFeeUsdc` con monto real; safety guard AC-7; leer `PROTOCOL_FEE_RATE` de env var (AC-9/AC-10) |
| `src/types/index.ts` | Añadir campo `feeChargeError?: string` a `OrchestrateResult`; posible nuevo tipo `FeeChargeResult` |
| `.env.example` | Añadir `WASIAI_PROTOCOL_FEE_WALLET=` y `PROTOCOL_FEE_RATE=` con comentarios explicativos (ambos opcionales) |
| `src/services/orchestrate.test.ts` | Tests nuevos para los ACs de fee (mock del paymentAdapter) |
| `src/services/fee-charge.ts` (nuevo, TBD en F2) | Función helper aislada para el transfer del fee; facilita mock en tests |

## Scope OUT

- `src/adapters/kite-ozone/payment.ts` — NO modificar. La interfaz `PaymentAdapter` y sus métodos `sign()` + `settle()` se usan tal cual. El Architect confirma en F2 si se requiere alguna adición (CD-E).
- `src/routes/orchestrate.ts` — El campo `feeChargeError` se expone automáticamente al hacer spread del result; sin cambios al handler salvo que el Architect detecte necesidad en F2.
- `src/adapters/types.ts` — NO modificar la interfaz `PaymentAdapter` (CD-E).
- Cualquier cambio a la lógica de compose, discovery o LLM planning.
- Integración con `POST /compose` (sólo `/orchestrate` en este ticket).
- Validación on-chain con Pieverse live (bloqueado por WKH-45 — fuera de scope).
- DB-backed config de `PROTOCOL_FEE_RATE` (post-MVP, otra HU si hace falta).
- UI admin para editar el rate (cuando haya admin UI — por ahora es solo vía Railway env dashboard).

---

## Decisiones técnicas

- **DT-1 — Momento del cobro**: El fee se cobra **post-compose**, solo si `pipeline.success=true`.
  Razonamiento: no cobrar por servicios que fallaron, alineado con x402 "settle only on success".
  El presupuesto se deduce **antes** del compose (AC-1), pero el transfer de tokens ocurre
  **después** del compose exitoso. Si el compose falla, no se transfiere nada.

- **DT-2 — Mecanismo de transfer**: Usar `paymentAdapter.sign()` + `paymentAdapter.settle()`
  ya existentes en `KiteOzonePaymentAdapter`. El `OPERATOR_PRIVATE_KEY` firma la autorización
  EIP-712 desde el wallet del operador hacia `WASIAI_PROTOCOL_FEE_WALLET`.
  > **[NEEDS CLARIFICATION]** — ¿El wallet del operador tiene saldo de KXUSD suficiente para
  > cubrir el fee transfer? ¿O se asume que el x402 payment del usuario ya liquidó fondos en
  > el wallet del operador antes de que se ejecute el orchestrate? El Architect debe verificar
  > el flujo de fondos en F2.

- **DT-3 — Scope del fee**: El fee se calcula sobre `budget` (input del usuario), no sobre
  `pipeline.totalCostUsdc` (costo real de agentes). `protocolFeeUsdc = budget * PROTOCOL_FEE_RATE`.
  Esto simplifica el cálculo y es predecible para el usuario. Confirmado por el humano (M-1 resuelto).

- **DT-4 — Aislamiento del fee-charge**: Extraer la lógica de cobro en un helper
  `feeChargeService` (o función) separado de `orchestrateService`. Esto permite mockear
  fácilmente en tests sin tocar el paymentAdapter real (CD-A, tests unitarios pasan sin
  credenciales blockchain).

- **DT-5 — Fee rate desde env var**: `PROTOCOL_FEE_RATE` se lee de `process.env` en cada
  request (no como constante en módulo). No se persiste en memoria entre requests. Rango
  válido `[0.0, 0.10]`; fuera de rango → fallback `0.01` con `console.error`.

---

## Constraint Directives

- **CD-1**: PROHIBIDO `any` explícito en TypeScript. Todo tipado estricto (conforme a
  `tsconfig.json` strict mode).

- **CD-2**: OBLIGATORIO que `WASIAI_PROTOCOL_FEE_WALLET` sea **opcional**. Si no está seteado,
  el fee charge se omite silenciosamente (warn log). No romper local dev ni CI sin la var.

- **CD-3**: PROHIBIDO que `protocolFeeUsdc` exceda `budget`. Si `PROTOCOL_FEE_RATE * budget >
  budget` (imposible con rate=0.01 pero la guarda debe existir), lanzar error 400 antes de
  continuar.

- **CD-4**: PROHIBIDO que un fallo en el fee transfer rompa el orchestrate. Best-effort con
  log error. El resultado incluye `feeChargeError` opcional para auditoria, pero el HTTP
  response es 200.

- **CD-5**: PROHIBIDO modificar la firma pública de `PaymentAdapter` en
  `src/adapters/types.ts`. Si se necesita funcionalidad adicional, se implementa en una
  función helper fuera del adapter o mediante composición.

- **CD-6**: OBLIGATORIO implementar idempotencia para evitar double-charge por mismo
  `orchestrationId`. Mecanismo concreto a definir por el Architect en F2 (Redis TTL o
  columna en DB).

- **CD-7**: PROHIBIDO `ethers.js`. Solo `viem` para operaciones blockchain (conforme a
  project-context.md regla #4).

- **CD-8**: OBLIGATORIO agregar `WASIAI_PROTOCOL_FEE_WALLET=` y `PROTOCOL_FEE_RATE=` en
  `.env.example` con comentarios explicativos (ambos opcionales).

- **CD-G**: PROHIBIDO dejar `PROTOCOL_FEE_RATE` como constante literal en el código.
  OBLIGATORIO leer de `process.env.PROTOCOL_FEE_RATE` en cada request (o con cache TTL <30s
  si el Architect define cache). Razón: permitir actualizar la tasa en Railway dashboard sin
  redeploy, mantener el protocolo flexible ante decisiones de pricing.

---

## Missing Inputs

| # | Ítem | Prioridad |
|---|------|-----------|
| M-1 | ¿Fee sobre `budget` (input) o sobre `pipeline.totalCostUsdc` (costo real)? | RESUELTO: sobre `budget`. Razón: predictibilidad para el marketplace, alineado con Stripe/PayPal |
| M-2 | ¿Se cobra el fee si `pipeline.success=false` (compose parcialmente fallido)? | RESUELTO: solo si `pipeline.success=true`. Razón: no cobrar por servicios fallidos, alineado con x402 "settle only on success" |
| M-3 | Mecanismo de idempotencia para AC-8 (Redis TTL vs columna a2a_tasks) | Resuelto en F2 por Architect |
| M-4 | Flujo de fondos: ¿el wallet del operador ya tiene KXUSD cuando se ejecuta el fee transfer? | Resuelto en F2 — verificar con DT-2 |

---

## Análisis de paralelismo

- **Bloquea**: ninguna HU conocida depende de WKH-44 en el backlog actual.
- **Bloqueado por**: WKH-45 (Pieverse `/v2/verify` HTTP 500) para validación on-chain
  del AC-2 — pero NO bloquea la implementación ni los tests unitarios.
- **Puede ir en paralelo con**: WKH-45 (son tickets independientes; WKH-44 implementa,
  WKH-45 repara el facilitador externo).
- **Relación con WKH-42 (MCP Server)**: independiente — el MCP invoca `/orchestrate`
  via HTTP, el fee se cobra transparentemente en el servicio sin cambios al MCP.

---

## Contexto de implementación

- `PROTOCOL_FEE_RATE = 0.01` actualmente como constante en `src/services/orchestrate.ts:26` —
  DEBE migrarse a lectura desde `process.env.PROTOCOL_FEE_RATE` (ver CD-G, AC-9, AC-10).
- El campo `OrchestrateResult.protocolFeeUsdc` ya existe en `src/types/index.ts:217` —
  sólo cambia su semántica de "display-only" a "real charged amount".
- `paymentAdapter.sign()` y `paymentAdapter.settle()` ya funcionales en
  `src/adapters/kite-ozone/payment.ts` — reutilizar directamente.
- Tests baseline: 350/350 en `vitest`. No romper con este ticket.
