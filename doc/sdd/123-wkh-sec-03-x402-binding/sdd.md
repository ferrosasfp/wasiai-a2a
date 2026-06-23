# SDD #123: [WKH-SEC-03] x402 inbound — ligar recipient (`to`) + amount (`value`) (cerrar bypass CRÍTICO de cobro)

> SPEC_APPROVED: no
> Fecha: 2026-06-23
> Tipo: security (CRÍTICO — CRIT-1 auditoría)
> SDD_MODE: full
> Branch: fix/123-wkh-sec-03-x402-binding
> Artefactos: doc/sdd/123-wkh-sec-03-x402-binding/

---

## 1. Resumen

El middleware x402 inbound (`requirePayment` en `src/middleware/x402.ts`) acepta
**cualquier** pago auto-consistente que firme el caller, sin validar:
1. que `authorization.to` sea el wallet de cobro del server (`payTo`), ni
2. que `authorization.value` cubra el precio del recurso (`maxAmountRequired`).

Hoy el handler decodifica el header, llama `adapter.verify()` y, si la firma es
válida, `adapter.settle()` + `request.paymentVerified = true`. La firma se valida
contra `authorization` (`from/to/value/...`) — un atacante firma un pago de `1`
unidad a **su propia** dirección, `verify()` retorna `valid:true` (la firma es
internamente consistente), y obtiene acceso a `/compose` + `/orchestrate` **sin
pagarle a WasiAI**. Bypass total y explotable en prod.

Agravante (defensa en profundidad): los 3 adapters construyen el body al
facilitator usando los valores del **caller** (`authorization.to`/`.value`) como
`payTo`/`maxAmountRequired`/`amount`, así que el facilitator valida la firma
contra los requirements que el propio atacante eligió → siempre pasa.

Este SDD cierra el bypass con dos capas:
- **Capa primaria (middleware, obligatoria)**: validar `to` + `value` ANTES de
  `verify()`/`settle()`. Self-contained, no depende del facilitator.
- **Capa secundaria (adapters, defensa en profundidad)**: enviar los
  `paymentRequirements` del **server** al facilitator, no los del caller.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 123 |
| **Tipo** | security (CRÍTICO) |
| **SDD_MODE** | full |
| **Objetivo** | Ligar `authorization.to === payTo` (case-insensitive) y `authorization.value >= maxAmountRequired` en el middleware antes del network call; propagar los requirements del server a los 3 adapters. |
| **Scope IN** | `src/middleware/x402.ts`, `src/adapters/types.ts`, `src/adapters/{kite-ozone,base,avalanche}/payment.ts`, tests en `src/middleware/` y `src/adapters/*/`. |
| **Scope OUT** | path outbound (`sign`), `buildX402Response` (no cambia lógica), MED-1/MED-2/BAJO-*, contratos/DB, `resolveChainKey`, rutas `/gasless`,`/discover`,`/registries`. |
| **ACs** | AC-1..AC-6 (ver work-item §Acceptance Criteria). |

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos y patrón extraído

| Archivo | Por qué | Hallazgo / patrón |
|---------|---------|-------------------|
| `doc/sdd/123-wkh-sec-03-x402-binding/work-item.md` | Input aprobado | AC-1..6, DT-1..5, CD-1..6, 2 NCs a resolver. |
| `src/middleware/x402.ts:64-91` (`buildX402Response`) | Fuente de `walletAddress`+`amount` | `walletAddress = process.env.PAYMENT_WALLET_ADDRESS \|\| KITE_WALLET_ADDRESS`. `amount = opts.amount ?? (await adapter.quote(1)).amountWei`. Es el `payTo` y `maxAmountRequired` que se anuncian en el challenge 402. **Reutilizar EXACTAMENTE estos dos valores para el binding.** |
| `src/middleware/x402.ts:118-285` (`requirePayment`) | Punto de inserción | Flujo: resolución de chain → lee header → `decodeXPayment` (línea 198) → `verify()` (línea 214) → `settle()` (línea 249). El check va **entre 211 y 212** (tras decode OK, antes de `verify`). Patrón de reject existente: `reply.status(402).send(await buildX402Response(opts, resource, chainKey, <msg>))`. |
| `src/middleware/x402.ts:62,73-74` (`DEFAULT_AMOUNT_USD`, quote) | Resolución del amount esperado | El amount viene del `quote()` del adapter resuelto, en unidades nativas del token (18-dec Kite, 6-dec USDC). NO escalar (DT-2 / AC-5). |
| `src/types/index.ts:503-514` (`X402PaymentRequest.authorization`) | Formato de `to`/`value` | `to: string` (address EVM hex), `value: string` (monto en unidades atómicas/wei como string). EIP-3009: comparar como `BigInt`. |
| `src/adapters/types.ts:11-29,78-91` (`X402Proof`,`SettleRequest`,`PaymentAdapter`) | Firmas a extender | `X402Proof`/`SettleRequest` = `{authorization, signature, network}`. `verify(proof)`/`settle(req)` en la interface. Agregar `paymentRequirements?` opcional (CD-4 backward-compat). |
| `src/adapters/kite-ozone/payment.ts:242-261,289-305,440-461` | Bug Pieverse + x402 | Pieverse: `maxAmountRequired: proof.authorization.value`, `payTo: proof.authorization.to` (líneas 256-257 verify, 300-301 settle). x402 `buildX402CanonicalBody`: `amount: authorization.value`, `payTo: authorization.to` (453-455). **Ambos usan valores del caller — el bug.** |
| `src/adapters/base/payment.ts:236-257,398-404` | Bug x402 Base | `buildX402CanonicalBody` líneas 249 (`amount: authorization.value`) + 251 (`payTo: authorization.to`). `verify`/`settle` (398-404) llaman con `(proof, this.network)`. Solo modo x402 (no Pieverse). |
| `src/adapters/avalanche/payment.ts:211-232,371-377` | Bug x402 Avalanche | Idéntico a Base: `buildX402CanonicalBody` líneas 225-226. Solo modo x402. |
| `src/middleware/x402.chain-aware.test.ts:1-210` | Patrón de test del middleware | Fastify in-memory + `vi.mock('../adapters/registry.js')` con dispatcher por `chainKey` (base 6-dec / kite 18-dec). Mocks `mockBaseVerify`/`mockKiteVerify` espían llamadas. `process.env.KITE_WALLET_ADDRESS='0x...dEaD'` en `beforeEach`. Assertions: `expect(mockX.verify).toHaveBeenCalledTimes(n)`. **Reutilizar esta infra; agregar `expect(mockVerify).not.toHaveBeenCalled()` para el binding-reject (CD-6).** |
| `src/__tests__/fixtures/passport-shape.ts:54-120` | Builder del header de pago | `buildEoaPaymentHeader(opts)` y `buildPassportPaymentHeader(opts)`. Defaults: `to: '0x...dEaD'`, `value: '1000000'`. Acepta override `opts.to`/`opts.value`. **El default `to` coincide con el wallet del test → caso legítimo pasa el binding; override produce los casos negativos de AC-1/AC-2 sin tocar el fixture.** |
| `src/adapters/__tests__/payment.contract.test.ts` (existente) | Patrón test adapters | Mockea `globalThis.fetch`, inspecciona el `body` enviado. **Patrón para AC-4: capturar `fetch.mock.calls`, parsear el body, assert `payTo`/`maxAmountRequired` = server, NO caller.** |
| `doc/sdd/072-wkh-67-balance-gate-decimals/auto-blindaje.md` | Auto-Blindaje histórico (decimales) | Lección CD-DEC-01: PROHIBIDO comparar montos de dimensiones (cadena/token/decimales) distintas. Directamente aplicable a AC-5 → ver CD-7. |

### Verificación de exemplars (paths confirmados con Read)

| Símbolo / archivo | Confirmado |
|-------------------|-----------|
| `buildX402Response`, `requirePayment`, `decodeXPayment` en `src/middleware/x402.ts` | ✓ |
| `X402Proof`, `SettleRequest`, `PaymentAdapter` en `src/adapters/types.ts` | ✓ |
| `buildX402CanonicalBody` en los 3 adapters | ✓ (kite:440, base:236, avalanche:211) |
| `PieverseVerifyRequest.paymentRequirements{payTo,maxAmountRequired}` `src/types/index.ts:531-540` | ✓ |
| `buildEoaPaymentHeader`/`buildPassportPaymentHeader` `src/__tests__/fixtures/passport-shape.ts` | ✓ |
| Test infra `src/middleware/x402.chain-aware.test.ts` | ✓ |

---

## 4. Resolución de Missing Inputs (NCs)

### NC-1 — ¿El facilitator valida `payTo`/`amount` o solo la firma? → RESUELTO

**Grounding**: inspeccioné los 3 adapters.
- **kite-ozone (Pieverse)** `payment.ts:252-260,296-304`: el body `paymentRequirements`
  que se manda al facilitator deriva `maxAmountRequired`/`payTo` de
  `proof.authorization.value`/`.to` — los valores del **caller**. El facilitator
  Pieverse valida la firma contra esos requirements → un pago de 1 wei a la
  dirección del atacante **pasa** porque los requirements son los del atacante.
- **kite-ozone (x402)** `buildX402CanonicalBody:453-455`, **base** `:249-251`,
  **avalanche** `:225-226`: idéntico — `accepted.amount`/`payTo` = caller.

**Conclusión (DT-1 confirmada)**: el código de wasiai-a2a NO puede asumir que el
facilitator self-hosted enforce los requirements del server, porque hoy ni
siquiera se los manda. La **validación en el MIDDLEWARE es la línea de defensa
OBLIGATORIA**, no opcional. Decisión:
- **Middleware valida SIEMPRE** (`to` + `value`) antes de cualquier network call.
  Self-contained, sin dependencia del facilitator. (Cierra el bypass por sí solo.)
- **Adapters reciben `paymentRequirements` del server** y los usan en lugar de
  los del caller → defensa en profundidad. Si el facilitator algún día sí
  enforce, ahora recibirá los datos correctos.

El `[NEEDS CLARIFICATION]` del operador (¿wasiai-facilitator enforce `accepted.payTo`?)
**NO bloquea**: el fix de middleware es suficiente independientemente de la
respuesta. El fix de adapters es correcto en cualquier caso. **NC-1 cerrado.**

### NC-2 — ¿Caso legítimo con `authorization.to != walletAddress`? → RESUELTO: NO

En el path inbound de cobro (`/compose`, `/orchestrate` vía `requirePayment`) el
pago va **al server**. No existe escrow no-custodial ni multi-hop en este path:
- `sign()` (outbound) es Scope OUT y usa su propio `opts.to` (sub-agente) — no
  pasa por `requirePayment`.
- El escrow no-custodial (WKH-126) vive en `/deposit`, NO en `requirePayment`.

**Conclusión (lock)**: para `requirePayment`, `authorization.to` SHALL ser
**siempre** el `walletAddress` del server. No hay excepción. Si en el futuro
aparece un path multi-hop, requerirá un middleware distinto y su propia HU.
**NC-2 cerrado — sin ambigüedad pendiente.**

---

## 5. Decisiones Técnicas (DT-N)

- **DT-1 — Middleware es la defensa primaria (obligatoria), adapters defensa en profundidad.** (Ver NC-1.) El check en `requirePayment` corre SIEMPRE, antes del network call. La propagación de requirements a los adapters es complementaria.

- **DT-2 — Resolución eager de `walletAddress` + `requiredAmount` al inicio del handler.** Hoy `buildX402Response` resuelve ambos (incluyendo `await adapter.quote(1)` cuando `opts.amount` es undefined). Para no llamar `quote()` dos veces (DT-5 del work-item), el handler resuelve `walletAddress` y `requiredAmount` UNA vez tras tener `chainKey`, los guarda en variables locales, y los reutiliza para: (a) el binding check, (b) construir el body de error vía `buildX402Response` (que se mantiene; recibe `opts` + `resource` + `chainKey` y reusa su propia resolución para el challenge — coherente). Alternativa más limpia: extraer un helper `resolvePaymentRequirements(opts, chainKey): Promise<{payTo, requiredAmount}>` reutilizado por `buildX402Response` y por el binding. **Elegida**: el helper, para una sola fuente de verdad y evitar drift entre challenge y binding (la dimensión DEBE ser la misma — CD-7).

- **DT-3 — Comparación `value`: BigInt, mismas unidades.** `BigInt(authorization.value) >= BigInt(requiredAmount)`. Ambos en unidades nativas del token de la cadena resuelta (el mismo string que `quote().amountWei` u `opts.amount`). NO escalar por decimales (AC-5). `>=` (no `===`) — un overpay es aceptable (el caller paga de más, el server cobra el `value` firmado; rechazar solo underpay).

- **DT-4 — Comparación `to`: case-insensitive.** `authorization.to.toLowerCase() === walletAddress.toLowerCase()` (CD-3). Addresses EVM son hex case-insensitive (EIP-55 checksum es solo display).

- **DT-5 — `paymentRequirements?` opcional en `X402Proof`/`SettleRequest`.** Campo `paymentRequirements?: { payTo: string; maxAmountRequired: string }`. Backward-compat: outbound (`sign`) no lo provee. Los adapters: si `paymentRequirements` está presente → usarlo; si no → fallback al valor actual (`authorization.*`) para no romper callers existentes. El middleware (post-fix) SIEMPRE lo pasa.

- **DT-6 — Error code estructurado.** AC-6: log con `error_code: 'X402_BINDING_MISMATCH'` + valores recibidos (to/value) y esperados (payTo/requiredAmount). El body 402 al caller NO expone el `walletAddress` completo (CD-2): se usa el body estándar de `buildX402Response` con un `errorMessage` genérico tipo `Payment binding rejected: recipient or amount mismatch` (el challenge en `accepts[0]` ya anuncia el `payTo` correcto vía protocolo, pero el mensaje de error no lo enuncia en claro como "esperaba X"). El log interno (`request.log.warn`) sí lleva todo para auditoría.

- **DT-7 — Validación de formato defensiva.** `decodeXPayment` ya valida que `authorization` exista (objeto) y `signature` sea string, pero NO valida `to`/`value`. Antes de comparar: si `authorization.to`/`.value` faltan o no son strings → tratar como binding-mismatch (reject 402), NO crash. `BigInt(value)` puede lanzar si `value` no es numérico → envolver en try/catch y rechazar como mismatch.

---

## 6. Constraint Directives (CD-N)

Heredados del work-item (CD-1..CD-6) + nuevos del SDD (CD-7..CD-10):

- **CD-1** (heredado): PROHIBIDO llamar `adapter.verify()`/`settle()` si el binding `to`/`value` falla. Reject antes del network call.
- **CD-2** (heredado): PROHIBIDO exponer el `walletAddress` completo en el body 402 al caller. Log interno sí, response body no.
- **CD-3** (heredado): OBLIGATORIO comparar `to` case-insensitive (`.toLowerCase()` ambos lados).
- **CD-4** (heredado): OBLIGATORIO `paymentRequirements` opcional en `X402Proof`/`SettleRequest` (outbound no se rompe).
- **CD-5** (heredado): PROHIBIDO modificar la resolución de `walletAddress` (`PAYMENT_WALLET_ADDRESS \|\| KITE_WALLET_ADDRESS`). Reutilizar tal cual.
- **CD-6** (heredado): OBLIGATORIO tests con mocks de fetch/adapter (no network real) + un test que verifica que verify/settle NO se llaman cuando el binding falla.
- **CD-7** (nuevo, deriva de Auto-Blindaje WKH-67 / CD-DEC-01): PROHIBIDO comparar `value` contra un `requiredAmount` de dimensión distinta. El `requiredAmount` SHALL provenir de la MISMA fuente que el challenge 402 (`quote().amountWei` u `opts.amount`) de la MISMA `chainKey` resuelta. NUNCA escalar, NUNCA mezclar 18-dec con 6-dec. AR/CR DEBE verificar que `requiredAmount` y `authorization.value` corresponden al mismo token/cadena. — referencia: WKH-67 auto-blindaje §CD-DEC-01.
- **CD-8** (nuevo): OBLIGATORIO que el binding use el `chainKey` YA resuelto en el handler (no re-resolver). El `walletAddress`/`requiredAmount` deben ser los de esa cadena (coherencia challenge↔binding↔verify, como T-AC5 de WKH-111).
- **CD-9** (nuevo, deriva de Auto-Blindaje WKH-126b): OBLIGATORIO correr `biome check` sobre los archivos tocados antes de cerrar cada wave de tests; escribir aserciones largas ya multilínea. No asumir auto-format. — referencia: WKH-125b auto-blindaje.
- **CD-10** (nuevo): PROHIBIDO romper los tests existentes `src/middleware/x402.chain-aware.test.ts`, `x402.dual-header.test.ts`, `x402.passport-shape.test.ts`. El fixture default (`to:'0x...dEaD'` = `KITE_WALLET_ADDRESS` del test) debe seguir pasando el binding. Si un test legacy usa un `to` distinto del wallet, adaptarlo en el mismo PR (documentar en auto-blindaje).

---

## 7. Waves de Implementación

### W0 — Contratos / tipos (serial, bloquea W1-W3)

- **W0.1** `src/adapters/types.ts`: agregar `paymentRequirements?: { payTo: string; maxAmountRequired: string }` a `X402Proof` (línea 21-25) y a `SettleRequest` (línea 11-15). Sin cambios en la interface `PaymentAdapter` (las firmas `verify(proof)`/`settle(req)` ya aceptan el objeto extendido).
- Gate W0: `tsc --noEmit` verde con el campo opcional.

### W1 — Binding en el middleware (defensa primaria — cierra el bypass)

- **W1.1** `src/middleware/x402.ts`: extraer `resolvePaymentRequirements(opts, chainKey): Promise<{ payTo: string; requiredAmount: string }>` (DT-2) — encapsula `walletAddress` (CD-5) + `amount = opts.amount ?? (await quote(1)).amountWei`. Refactor `buildX402Response` para reusarlo (sin cambiar su salida — CD-5; verificar byte-identical en T-NOREG).
- **W1.2** En `requirePayment`, tras `decodeXPayment` OK (entre línea 211 y 212), antes de `verify()`:
  1. resolver `{ payTo, requiredAmount }` una vez.
  2. leer `auth = paymentPayload.authorization`. Validación defensiva (DT-7): si `typeof auth.to !== 'string'` o `typeof auth.value !== 'string'` → binding-reject.
  3. `to` check (DT-4, CD-3): `auth.to.toLowerCase() !== payTo.toLowerCase()` → reject.
  4. `value` check (DT-3, CD-7): `try { BigInt(auth.value) < BigInt(requiredAmount) } catch → reject` → reject si underpay o parse error.
  5. En reject: `request.log.warn({ error_code:'X402_BINDING_MISMATCH', received:{to,value}, expected:{payTo, requiredAmount} })` (DT-6, AC-6, CD-2) + `return reply.status(402).send(await buildX402Response(opts, resource, chainKey, 'Payment binding rejected: recipient or amount mismatch'))`. **Antes de cualquier `verify()`** (CD-1).
- **W1.3** Pasar `paymentRequirements: { payTo, maxAmountRequired: requiredAmount }` en las llamadas a `verify({...})` (línea 214) y `settle({...})` (línea 249).
- Gate W1: AC-1, AC-2, AC-3, AC-6 cubiertos por tests de middleware (W4). El bypass queda cerrado **al terminar W1** (independiente de W2/W3).

### W2 — Propagar requirements en los adapters (defensa en profundidad) — paralelizable por adapter

- **W2.1** `src/adapters/kite-ozone/payment.ts`:
  - `verify()` Pieverse (líneas 256-257): `maxAmountRequired: proof.paymentRequirements?.maxAmountRequired ?? proof.authorization.value`, `payTo: proof.paymentRequirements?.payTo ?? proof.authorization.to`.
  - `settle()` Pieverse (líneas 300-301): idéntico con `req.paymentRequirements`.
  - `buildX402CanonicalBody` (440-461): aceptar param `requirements?: {payTo,maxAmountRequired}` → `amount: requirements?.maxAmountRequired ?? authorization.value`, `payTo: requirements?.payTo ?? authorization.to`. `verifyX402`/`settleX402` reenvían `proof.paymentRequirements`/`req.paymentRequirements`.
- **W2.2** `src/adapters/base/payment.ts`: `buildX402CanonicalBody` (236-257) acepta `requirements?` → líneas 249/251 con fallback. `verifyX402`/`settleX402` (259/304) reenvían `proof.paymentRequirements`/`req.paymentRequirements`. `verify`/`settle` (398/402) ya pasan `proof`/`req` completos.
- **W2.3** `src/adapters/avalanche/payment.ts`: idéntico a Base — `buildX402CanonicalBody` (211-232) líneas 225/226 con fallback; `verifyX402`/`settleX402` (234/279) reenvían.
- Gate W2: AC-4 cubierto por tests de adapter (W3).

### W3 — Tests de adapters (AC-4)

- En `src/adapters/base/__tests__/` (o el archivo `base.test.ts` existente) + avalanche + kite: mockear `globalThis.fetch`, llamar `verify({authorization:{to:'0xATTACKER',value:'1'}, signature, network, paymentRequirements:{payTo:'0xSERVER', maxAmountRequired:'1000000'}})`, parsear el body enviado y assert `accepted.payTo==='0xSERVER'` / `accepted.amount==='1000000'` (NO `'0xATTACKER'`/`'1'`). Para kite: cubrir AMBOS modos (Pieverse `paymentRequirements.payTo`/`maxAmountRequired` + x402 `accepted.payTo`/`amount`).

### W4 — Tests del middleware (AC-1, AC-2, AC-3, AC-6) — depende de W1

- Nuevo archivo `src/middleware/x402.binding.test.ts` (espejo de `x402.chain-aware.test.ts`: Fastify in-memory + `vi.mock('../adapters/registry.js')`).

### W5 — Verificación final

- `tsc --noEmit` + `biome check` (CD-9) + `npm test` completo (no-regresión, CD-10).

---

## 8. Plan de Tests (≥1 por AC)

Archivo nuevo: `src/middleware/x402.binding.test.ts`. Infra: clonar el harness de
`x402.chain-aware.test.ts` (mock registry kite 18-dec + base 6-dec, `KITE_WALLET_ADDRESS='0x...dEaD'` en `beforeEach`). Fixture: `buildEoaPaymentHeader(opts)`.

| Test | AC | Estrategia | Assert clave |
|------|-----|-----------|--------------|
| `T-AC1: to-mismatch → 402, sin verify/settle` | AC-1, CD-1 | `buildEoaPaymentHeader({ to:'0x00..beef', value:'1000000' })` (to ≠ wallet) | `statusCode===402` ∧ `mockKiteVerify` NOT called ∧ `mockKiteSettle` NOT called |
| `T-AC2: underpay (value < required) → 402, sin verify/settle` | AC-2, CD-1 | `buildEoaPaymentHeader({ to:'0x...dEaD', value:'1' })` (kite required = 10^18) | `statusCode===402` ∧ `mockKiteVerify` NOT called |
| `T-AC3: pago correcto (to=wallet, value>=required) → verify+settle, paymentVerified` | AC-3 | `buildEoaPaymentHeader()` (default to=wallet, value=10^6 vs kite 10^18 → ⚠ ver nota) | handler de prueba lee `request.paymentVerified===true`; `mockKiteVerify`/`mockKiteSettle` called 1× |
| `T-AC3-overpay: value > required → acepta` | AC-3, DT-3 | `value:'2000000000000000000'` (> 10^18) | acepta (settle called) |
| `T-AC4-kite-pieverse` | AC-4 | adapter test: body Pieverse usa `paymentRequirements.payTo` del server | `body.paymentRequirements.payTo===server` |
| `T-AC4-kite-x402 / base / avalanche` | AC-4 | adapter test: `accepted.payTo`/`amount` = server | `body.accepted.payTo===server` ∧ `amount===required` |
| `T-AC6: log estructurado en reject` | AC-6, CD-2 | spy en `request.log.warn`; reject por to-mismatch | warn llamado con `error_code:'X402_BINDING_MISMATCH'`; body 402 NO contiene el wallet completo |
| `T-3CHAINS: binding aplica en kite/base/avalanche` | AC-1/2 las 3 | mismo test parametrizado por `x-payment-chain` | reject en las 3 con to/value malos |
| `T-NOREG: challenge 402 sin header` | no-regresión | sin `x-payment` | `accepts[0]` byte-idéntico al actual (T-AC3a WKH-111) |
| `T-NOREG-legacy` | CD-10 | correr suite `x402.chain-aware/dual-header/passport-shape` | verde sin cambios |

> **Nota crítica del test harness (CD-7/CD-8 — para Dev y QA)**: el fixture
> default usa `value:'1000000'` (6-dec), pero el mock **kite** declara
> `quote().amountWei='1000000000000000000'` (18-dec). Por tanto, contra el mock
> kite por defecto, `1000000 < 10^18` → el caso "correcto" debe enrutarse a
> **base** (`x-payment-chain:base-sepolia`, required `'1000000'`, value `'1000000'`
> → pasa) o pasar `value:'1000000000000000000'` explícito para kite. Esto NO es
> un bug — es exactamente la separación dimensional de CD-7. El Dev debe alinear
> `value` del fixture con el `quote` del mock de la cadena bajo prueba en cada
> test, NO escalar.

---

## 9. Readiness Check

| Ítem | Estado |
|------|--------|
| Work-item leído (ACs, DTs, CDs, NCs) | ✓ |
| `project-context.md` / stack (TS strict, viem, Fastify, JSON-RPC) respetado | ✓ |
| Exemplars verificados con Read (middleware, 3 adapters, types, fixture, tests) | ✓ paths reales |
| NC-1 resuelto (middleware = defensa obligatoria; facilitator no enforce hoy) | ✓ |
| NC-2 resuelto (no hay caso legítimo `to != wallet` en inbound; lockeado) | ✓ |
| Auto-Blindaje histórico aplicado (WKH-67 decimals → CD-7; WKH-125b biome → CD-9) | ✓ |
| Punto de inserción del check identificado (entre x402.ts:211 y :212) | ✓ |
| Fuente de `payTo`/`requiredAmount` identificada (reuso de `buildX402Response`) | ✓ |
| Comparación definida (BigInt `>=`, `to` toLowerCase) | ✓ |
| Backward-compat de adapters (`paymentRequirements?` opcional + fallback) | ✓ |
| Test plan ≥1 por AC (AC-1..AC-6) + no-regresión | ✓ |
| Sin `[NEEDS CLARIFICATION]` abiertos | ✓ |
| Stack no negociable (no se introduce lib nueva) | ✓ |

**SDD listo para SPEC_APPROVED.** No hay TBDs ni ambigüedades pendientes.
