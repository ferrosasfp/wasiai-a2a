# Work Item — [WKH-117] Kite Agent Passport como payer dual en wasiai-a2a (Agent Key O Passport) + e2e dual-auth

## Resumen

Extender el gateway wasiai-a2a para que cualquier caller pueda autenticarse y pagar
indistintamente con WasiAI Agent Key (path existente) o con Kite Agent Passport (x402
nativo). La pieza central es aceptar el header canónico `X-PAYMENT` (estándar x402 /
Kite Passport) como alias de `payment-signature` (header propio actual). Se agrega
detección de origen de pago (`paymentOrigin='passport'`) ya implementada en WKH-69 como
telemetría real, binding opcional Agent Key-Passport en la columna `kite_passport`
existente, y un script e2e dual-auth que valida ambos paths contra staging con el
facilitator mockeado en los tests unitarios.

**Contexto hackathon:** Kite es el anfitrión del hackathon (pitch 2026-06-16, top-10).
Demostrar que wasiai-a2a acepta Agent Passport como payer nativo es el diferenciador
de integración más visible para el jurado.

---

## Sizing

- **SDD_MODE:** full
- **Flow:** QUALITY
- **Estimación:** M (mediana — superficie AUTH+PAGO, zero-regression obligatoria)
- **Justificación QUALITY:** toca la cadena de autenticación y el path de pago
  (`requirePayment` en `src/middleware/x402.ts` y `requirePaymentOrA2AKey` en
  `src/middleware/a2a-key.ts`). Un bug aquí es un outage de pago o un bypass de auth.
  El criterio QUALITY aplica por definición cuando se toca AUTH o PAYMENT.
- **Branch sugerido:** `feat/WKH-117-kite-passport-dual-auth` (ya creado)

---

## Acceptance Criteria (EARS)

### Path Agent Key — zero regression

**AC-1 (Ubiquitous):** The system SHALL continue to authenticate and debit callers
that send `x-a2a-key` or `Authorization: Bearer wasi_a2a_*` headers with unchanged
behavior (priority order, budget debit, `request.a2aKeyRow` augmentation), regardless
of whether `X-PAYMENT` header aliasing is enabled.

**AC-2 (Unwanted):** IF a request carries a valid Agent Key AND an `X-PAYMENT` or
`payment-signature` header simultaneously, THEN the system SHALL honor the Agent Key
path (existing priority: `x-a2a-key` > Bearer > x402) and SHALL NOT attempt to verify
or settle the payment header.

### Header alias X-PAYMENT

**AC-3 (Event-driven):** WHEN an inbound request to any route guarded by `requirePayment`
carries the header `X-PAYMENT` (case-insensitive) but NOT `payment-signature`, the system
SHALL treat the `X-PAYMENT` value as the payment payload, decode it via `decodeXPayment`,
and proceed through the existing verify/settle flow identically to `payment-signature`.

**AC-4 (Event-driven):** WHEN both `X-PAYMENT` and `payment-signature` are present in the
same request, the system SHALL use `X-PAYMENT` as the authoritative payment header
(canonical x402 spec takes precedence over legacy header).

**AC-5 (Unwanted):** IF neither `X-PAYMENT` nor `payment-signature` is present, THEN the
system SHALL respond with HTTP 402 and the standard x402 challenge body
(`{error, accepts, x402Version}`) — identical to the current behavior.

### paymentOrigin telemetry

**AC-6 (Event-driven):** WHEN a payment request arrives with `x-passport-session: true`
AND the payment is processed via the `X-PAYMENT` or `payment-signature` path,
the system SHALL set `request.paymentOrigin = 'passport'` (current WKH-69 behavior
preserved and now also fired for the alias path).

**AC-7 (Ubiquitous):** The system SHALL include `paymentOrigin` in the `a2a_events`
telemetry record for every settled request, with value `'passport'` or `'eoa'` as
appropriate, enabling post-hoc analytics on Passport adoption.

### Binding opcional Agent Key-Passport

**AC-8 (Optional — WHERE `PASSPORT_BINDING_ENABLED=true`):** WHERE the env var
`PASSPORT_BINDING_ENABLED=true` is set, the system SHALL expose a `POST /auth/bind-passport`
endpoint that accepts `{ keyId, passportAddress }` and persists the binding in
`a2a_agent_keys.kite_passport` JSONB column (`{ address, bound_at }`), gated by ownership
(`owner_ref` check — CD-3).

**AC-9 (Ubiquitous):** The `kite_passport` binding SHALL be read-only from the consumer
perspective — it is informational metadata exposed in `GET /auth/keys/:id` and
`request.a2aKeyRow.kite_passport`. It SHALL NOT alter auth priority or debit behavior.

### Tests e integración

**AC-10 (Ubiquitous):** The system SHALL include vitest unit tests for the header alias
logic in `src/middleware/x402.test.ts` (or `x402.dual-header.test.ts`) covering:
(a) `X-PAYMENT` alone → verify/settle called,
(b) `payment-signature` alone → verify/settle called (regression),
(c) both headers → `X-PAYMENT` wins,
(d) neither → 402 challenge,
(e) `x-passport-session: true` with `X-PAYMENT` → `paymentOrigin='passport'`.
All cases SHALL run with the adapter mocked at `vi.mock('../adapters/registry.js')`.

**AC-11 (Ubiquitous):** The system SHALL include a `scripts/smoke-e2e-dual-auth.mjs`
script that validates both paths against a running instance:
- Path A (Agent Key): sends `x-a2a-key` to a guarded endpoint, expects HTTP 200.
- Path B (Passport/x402): sends `X-PAYMENT` + `x-passport-session: true` with a
  pre-approved kpass session (or skips with exit code 1 if no active session), expects
  HTTP 200 or HTTP 402 challenge when no session.
Exit codes: 0 = both paths passed, 1 = human gate needed (no session), 2 = assertion
failure, 3 = runtime error.

---

## Scope IN

| Artefacto | Cambio |
|-----------|--------|
| `src/middleware/x402.ts` | Alias `X-PAYMENT` → `payment-signature` (header normalization, ~10 LOC) |
| `src/middleware/x402.test.ts` o nuevo `x402.dual-header.test.ts` | Tests AC-10 (a–e) |
| `src/middleware/a2a-key.ts` | Sin cambio en lógica — solo verificar que el priority order no se rompe al coexistir con alias (AC-1, AC-2) |
| `src/middleware/a2a-key.test.ts` | Agregar caso de coexistencia Agent Key + `X-PAYMENT` (AC-2) |
| `src/routes/auth.ts` (o nuevo) | `POST /auth/bind-passport` env-gated (AC-8) |
| `src/services/identity.ts` o nuevo `passport-binding.ts` | `bindPassport(keyId, passportAddress, ownerId)` con ownership check |
| `scripts/smoke-e2e-dual-auth.mjs` | Script e2e dual-path (AC-11) |
| `src/types/a2a-key.ts` | Ya tiene `kite_passport: Record<string, unknown> | null` — solo documentar el sub-schema `{ address, bound_at }` vía JSDoc |
| `.env.example` | Agregar `PASSPORT_BINDING_ENABLED=false` |

---

## Scope OUT

| Item | Razón |
|------|-------|
| Mainnet Kite (chain ID 2366) | TESTNET ONLY en este WKH. Mainnet = release futuro. |
| Modificar el facilitator externo (Pieverse / wasiai-facilitator) | El facilitator ya entiende EIP-3009 x402. No hay cambio en la capa settle. |
| Automatizar passkey / aprobación de sesión Passport | Requiere interacción humana (hardware key). El e2e tiene exit code 1 cuando no hay sesión activa. |
| Lifecycle completo de sesiones Passport en a2a (create/revoke/renew) | Out of scope — Kite gestiona el ciclo de vida via kpass CLI. |
| RLS Postgres para `a2a_agent_keys` | Tracked en WKH-SEC-02. La defensa es app-layer (ownership check). |
| Cambio de `paymentOrigin` de telemetría a signal de auth | `paymentOrigin` permanece TELEMETRÍA ONLY. No se usa como decisor de auth. |
| Agent Passport como auth alternativo a Agent Key (bypass total de x402) | Fuera de scope — Passport paga x402, no reemplaza el budget system. |
| Modificar `wasiai-v2` o cualquier repo externo | Solo `wasiai-a2a`. |

---

## Decisiones técnicas (DT-N)

**DT-1: Alias de header en `x402.ts`, no en `a2a-key.ts`.**
El aliasing es un detalle del protocolo x402 (capa de transporte de pago), no de la
lógica de autenticación. `x402.ts` ya es el dueño de `payment-signature`. La
normalización debe ocurrir en la misma función que lee el header (antes del
`decodeXPayment` call en la línea `177`). Esto preserva el priority order de
`a2a-key.ts` sin tocarlo.

Alternativa descartada: branch nuevo en `a2a-key.ts` — crearía acoplamiento entre
el middleware de identidad y los detalles del protocolo x402.

**DT-2: `X-PAYMENT` gana sobre `payment-signature` cuando ambos están presentes.**
El estándar canónico x402 (y Kite Passport) usa `X-PAYMENT`. `payment-signature` es
el header legado propio de wasiai-a2a. Al encontrar ambos, priorizar el estándar es
la dirección correcta para la interoperabilidad.

**DT-3: Detección de Passport sigue siendo via `x-passport-session: true`.**
No se lee el contenido de `X-PAYMENT` para inferir si es Passport. El header
`x-passport-session` ya está implementado (WKH-69) y es el hint explícito que envía
el caller. No hay ambiguedad.

**DT-4: Binding Passport↔Key es un endpoint REST nuevo `POST /auth/bind-passport`,
env-gated por `PASSPORT_BINDING_ENABLED`.**
El binding es operación administrativa de bajo volumen, no hot-path de pago. REST es
apropiado (sigue el patrón de `/auth/keys`). El env-gate permite deployar sin activar
el endpoint hasta que se valide en staging.

**DT-5: `scripts/smoke-e2e-dual-auth.mjs` reutiliza el patrón de
`smoke-passport-autonomous.mjs` para el path Passport.**
El script existente ya maneja la semántica `exit 1 = human gate needed`. La estructura
es idéntica; se agrega el path Agent Key como un caso paralelo dentro del mismo script.

**DT-6: NO se agrega DB migration en esta HU.**
La columna `kite_passport` JSONB ya existe en `a2a_agent_keys` (WKH-69). Solo se
documenta el sub-schema `{ address, bound_at }` via JSDoc. Si se necesita un índice
en el futuro, es una HU separada.

---

## Constraint Directives (CD-N)

**CD-1: ZERO REGRESSION en el path Agent Key.**
PROHIBIDO alterar la lógica de `requirePaymentOrA2AKey` en `a2a-key.ts` de forma que
modifique el priority order (`x-a2a-key` > Bearer `wasi_a2a_*` > x402 fallback).
Los 2199+ tests existentes deben pasar en verde. El Adversary Review tiene instrucción
explícita de bloquear cualquier cambio que toque el priority order sin un AC explícito
que lo autorice.

**CD-2: TESTNET ONLY — sin hardcodes de mainnet.**
PROHIBIDO hardcodear chain ID 2366 (Kite mainnet) o cualquier mainnet address en el
código nuevo. OBLIGATORIO leer network desde `KITE_NETWORK` / `KITE_CHAIN_ID` env vars
(patrón existente en `src/adapters/kite-ozone/chain.ts`).

**CD-3: OWNERSHIP GUARD obligatorio en toda query sobre `a2a_agent_keys`.**
OBLIGATORIO filtrar por `owner_ref` en cualquier nueva query a `a2a_agent_keys`
(incluyendo la lógica de `bindPassport`). Patrón:
`.eq('id', keyId).eq('owner_ref', ownerId)`.
Sin `.eq('owner_ref', ...)` = BLOQUEANTE en AR (IDOR, mismo criterio que WKH-53).
El `ownerId` se obtiene de `request.a2aKeyRow.owner_ref` en rutas autenticadas.

**CD-4: PROHIBIDO usar el valor de `paymentOrigin` como decisor de autenticación.**
`paymentOrigin` es TELEMETRÍA ONLY. No puede usarse como condición de acceso, bypass
de budget, ni como input a ninguna decisión de autorización. Su único consumidor
legítimo es `requirePassport()` (opt-in, env-gated) y `event-tracking`.

**CD-5: PROHIBIDO ethers.js.** Toda interacción con contratos o wallets usa viem v2.

**CD-6: Sin secrets en código.** Toda key, URL de facilitator, y address de wallet
desde env vars. No hay excepciones para "test-only configs" en producción.

---

## Missing Inputs

| Item | Estado |
|------|--------|
| Header exacto que envía `kpass agent:session execute` (`X-PAYMENT` vs otro) | [ASUMIDO: `X-PAYMENT` basado en el estándar x402 canonical descrito en el recon. Confirmación definitiva via smoke test en Wave 2.] |
| ¿El Kite Passport también envía `x-passport-session: true` automáticamente? | [ASUMIDO: NO, es un header de hint que el caller debe enviar explícitamente. Si el comportamiento real difiere, el AC-6 se ajusta en F4.] |
| ¿`POST /auth/bind-passport` requiere JWT del usuario o Agent Key como auth? | [ASUMIDO: Agent Key (Bearer `wasi_a2a_*`) — sigue el patrón de `/auth/keys` existente. Si se necesita JWT de usuario, se escala en F2.] |

---

## Análisis de paralelismo

- **Esta HU NO bloquea otras HUs activas** — es un feature aditivo en una branch separada.
- **Puede correr en paralelo** con cualquier HU que no toque `src/middleware/x402.ts`
  o `src/middleware/a2a-key.ts`.
- **Conflicto potencial:** si hay una HU abierta que modifique `x402.ts` en paralelo,
  habrá merge conflict en las líneas 177-197. Coordinar con el orquestador.
- **Waves sugeridas:**
  - **Wave 1:** Header alias `X-PAYMENT` en `x402.ts` + tests AC-10 (a–e). Cobertura
    del critical path. Autocontenida.
  - **Wave 2:** Script `smoke-e2e-dual-auth.mjs` (AC-11) + smoke manual con `kpass`
    real en staging. Valida el wire shape de Passport end-to-end.
  - **Wave 3 (opcional, env-gated):** Endpoint `POST /auth/bind-passport` (AC-8, AC-9)
    + `.env.example` update. Si el tiempo del hackathon no alcanza, se puede omitir sin
    afectar el demo — el alias de header es la pieza visible.

---

## Skills relevantes

- `x402-execute` — ejecución de pagos x402 via Passport (smoke e2e)
- `request-session` — gestión de sesiones Passport (bootstrap del e2e)
