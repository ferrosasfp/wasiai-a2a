# Story File — WKH-SEC-03 · x402 inbound binding (`to` + `value`)

> Contrato autocontenido para el Dev. **Solo leés este archivo.** Si algo no está
> acá, no lo hagas. Branch: `fix/123-wkh-sec-03-x402-binding`.
> Tipo: security CRÍTICO (CRIT-1 auditoría). SPEC_APPROVED: sí.

---

## 1. Contexto compacto (qué construís y por qué)

El middleware x402 inbound (`requirePayment` en `src/middleware/x402.ts`) hoy acepta
**cualquier** pago auto-consistente que firme el caller: decodifica el header,
llama `adapter.verify()` y si la firma es válida hace `settle()` +
`request.paymentVerified = true`. **No valida** que `authorization.to` sea el
wallet de cobro del server ni que `authorization.value` cubra el precio. Un
atacante firma un pago de `1` unidad a **su propia** dirección, la firma es
internamente consistente, `verify()` retorna `valid:true`, y entra a
`/compose` + `/orchestrate` **sin pagarle a WasiAI**. Bypass total, explotable en prod.

Cerrás el bypass en **dos capas**:

- **Capa primaria (W1, middleware — OBLIGATORIA, cierra el bypass por sí sola)**:
  validar `to` + `value` ANTES de `verify()`/`settle()`. Self-contained, no
  depende del facilitator.
- **Capa secundaria (W2, adapters — defensa en profundidad)**: enviar al
  facilitator los `paymentRequirements` del **server**, no los del caller.

El bypass queda cerrado **al terminar W1**, independiente de W2/W3.

---

## 2. Scope IN — archivos exactos a tocar

| Archivo | Wave | Qué |
|---------|------|-----|
| `src/adapters/types.ts` | W0 | `paymentRequirements?` opcional en `X402Proof` + `SettleRequest` |
| `src/middleware/x402.ts` | W1 | helper `resolvePaymentRequirements` + binding check + propagación a verify/settle |
| `src/adapters/kite-ozone/payment.ts` | W2 | Pieverse verify/settle + `buildX402CanonicalBody` usan requirements del server |
| `src/adapters/base/payment.ts` | W2 | `buildX402CanonicalBody` + `verifyX402`/`settleX402` usan requirements del server |
| `src/adapters/avalanche/payment.ts` | W2 | idéntico a base |
| `src/adapters/__tests__/base.test.ts` | W3 | AC-4 base (body server-side) |
| `src/adapters/__tests__/avalanche.test.ts` | W3 | AC-4 avalanche |
| `src/adapters/__tests__/payment.contract.test.ts` (kite) | W3 | AC-4 kite Pieverse + x402 |
| `src/middleware/x402.binding.test.ts` (NUEVO) | W4 | AC-1, AC-2, AC-3, AC-6 |

**Scope OUT (no tocar):** path outbound `sign()`; `buildX402Response` salida
(reusar, no cambiar el JSON que devuelve); `resolveChainKey`/`getDefaultChainKey`;
rutas `/gasless`,`/discover`,`/registries`; contratos/DB.

---

## 3. Anti-Hallucination Checklist (verificado por el Architect contra el código real)

- `buildX402Response` está en `src/middleware/x402.ts:64-91`. `walletAddress = process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS || ''` (línea 71-72). `amount = opts.amount ?? (await adapter.quote(DEFAULT_AMOUNT_USD)).amountWei` (línea 73-74). `DEFAULT_AMOUNT_USD = 1` (línea 62). **NO modificar esta resolución (CD-5).**
- `requirePayment` está en `src/middleware/x402.ts:118+`. El `chainKey` ya está resuelto y validado en la variable `chainKey` (líneas 155-181) antes del punto de inserción. **Reusar esa variable (CD-8), no re-resolver.**
- Punto de inserción del binding: **entre línea 211 (cierre del `catch` del `decodeXPayment`) y línea 212 (`let verifyResult`)**. Tras decode OK, antes del primer `verify()`.
- `decodeXPayment` (líneas 93-116) ya valida que `authorization` sea objeto y `signature` sea string, pero **NO valida `to`/`value`**. La validación defensiva de `to`/`value` la agregás vos (DT-7).
- Tipo de `authorization`: `X402PaymentRequest['authorization']` con `to: string` y `value: string` (string en unidades atómicas del token).
- `X402Proof` está en `src/adapters/types.ts:21-25` (`{authorization, signature, network}`). `SettleRequest` en `:11-15` (idéntica forma). La interface `PaymentAdapter` (`:78-91`) **no cambia** — `verify(proof)`/`settle(req)` ya aceptan el objeto extendido.
- `buildX402CanonicalBody`: kite `:440-461`, base `:236-257`, avalanche `:211-232`. En las TRES, hoy `amount: authorization.value` y `payTo: authorization.to` (los valores del CALLER — el bug).
- kite Pieverse: `verify()` body en `:252-260` (`maxAmountRequired: proof.authorization.value`, `payTo: proof.authorization.to`); `settle()` body en `:296-304` (idéntico con `req.authorization`).
- kite x402: `verifyX402(proof)` `:466`, `settleX402(req)` `:499`, ambos llaman `buildX402CanonicalBody(authorization, signature)` (2 args, sin network).
- base: `verifyX402(proof, network)` `:259`, `settleX402(req, network)` `:304`, llaman `buildX402CanonicalBody(authorization, signature, network)` (3 args). `verify`/`settle` públicos `:398-404` pasan `proof`/`req` + `this.network`.
- avalanche: `verifyX402(proof, network)` `:234`, `settleX402(req, network)` `:279`. `verify`/`settle` públicos `:371-377`. Idéntico a base.
- Fixture: `buildEoaPaymentHeader(opts)` y `buildPassportPaymentHeader(opts)` en `src/__tests__/fixtures/passport-shape.ts:54,101`. Defaults: `to: '0x000000000000000000000000000000000000dEaD'`, `value: '1000000'` (línea 72-73). Acepta override `opts.to`/`opts.value`.
- Test harness middleware: `src/middleware/x402.chain-aware.test.ts`. Mock registry vía `vi.mock('../adapters/registry.js')`. Mocks `mockBaseVerify`/`mockBaseSettle`/`mockKiteVerify`/`mockKiteSettle`. **base quote `amountWei: '1000000'` (6-dec)**, **kite quote `amountWei: '1000000000000000000'` (18-dec)**. `process.env.KITE_WALLET_ADDRESS = '0x000000000000000000000000000000000000dEaD'` en `beforeEach`. `getDefaultChainKey: () => 'kite-ozone-testnet'`.
- Test harness adapters: `src/adapters/__tests__/base.test.ts:262-291` — `vi.stubGlobal('fetch', mockFetch)`, luego `const [url, init] = mockFetch.mock.calls[0]; const body = JSON.parse((init as {body:string}).body)`, assert `body.accepted.*`. **Reusar este patrón para AC-4.**
- `npm test` corre vitest. Lint: `biome check`. Build: `tsc --noEmit` (o `npm run build`).

---

## 4. Waves

### W0 — Tipos (serial, bloquea W1-W3)

**Archivo: `src/adapters/types.ts`**

En `SettleRequest` (líneas 11-15) y `X402Proof` (líneas 21-25), agregar el campo
opcional. El campo ES IDÉNTICO en ambas interfaces:

```ts
export interface SettleRequest {
  authorization: X402PaymentRequest['authorization'];
  signature: string;
  network: string;
  paymentRequirements?: { payTo: string; maxAmountRequired: string };
}
```

```ts
export interface X402Proof {
  authorization: X402PaymentRequest['authorization'];
  signature: string;
  network: string;
  paymentRequirements?: { payTo: string; maxAmountRequired: string };
}
```

**NO** tocar la interface `PaymentAdapter`. El `?` garantiza backward-compat:
`sign()` outbound no lo provee y no se rompe (CD-4).

**Gate W0:** `tsc --noEmit` verde.

---

### W1 — Binding en el middleware (CIERRA EL BYPASS)

**Archivo: `src/middleware/x402.ts`**

**W1.1 — Extraer helper `resolvePaymentRequirements`.**

Encapsula la resolución de `walletAddress` (CD-5: NO cambiar la lógica) + el
`amount` (mismo `opts.amount ?? quote(1).amountWei` de hoy). Una sola fuente de
verdad → evita llamar `quote()` dos veces (DT-5) y evita drift entre challenge y
binding (CD-7). Agregá esta función a nivel de módulo, cerca de `buildX402Response`:

```ts
async function resolvePaymentRequirements(
  opts: PaymentMiddlewareOptions,
  chainKey: ChainKey,
): Promise<{ payTo: string; requiredAmount: string }> {
  const adapter = getPaymentAdapter(chainKey);
  const payTo =
    process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS || '';
  const requiredAmount =
    opts.amount ?? (await adapter.quote(DEFAULT_AMOUNT_USD)).amountWei;
  return { payTo, requiredAmount };
}
```

Refactorizá `buildX402Response` (líneas 70-74) para reusar el helper, SIN cambiar
el JSON que devuelve (CD-5 / T-NOREG byte-idéntico):

```ts
const adapter = getPaymentAdapter(chainKey);
const { payTo: walletAddress, requiredAmount: amount } =
  await resolvePaymentRequirements(opts, chainKey);
```

(El resto del payload sigue usando `walletAddress` y `amount` como hoy.)

**W1.2 — Insertar el binding check entre la línea 211 y la 212.**

Hoy la línea 211 es el cierre `}` del `catch` del `decodeXPayment`, y la 212 es
`let verifyResult: ...`. Insertá EXACTAMENTE acá (después de que
`paymentPayload` está poblado, antes de cualquier `verify`):

```ts
    // ── WKH-SEC-03: binding check (to + value) BEFORE any network call. ──
    // CD-1: reject before verify()/settle(). CD-8: reuse the resolved chainKey.
    const { payTo, requiredAmount } = await resolvePaymentRequirements(
      opts,
      chainKey,
    );
    const auth = paymentPayload.authorization as {
      to?: unknown;
      value?: unknown;
    };
    let bindingOk = true;
    // DT-7: defensive — to/value must be strings, BigInt(value) must not throw.
    if (typeof auth.to !== 'string' || typeof auth.value !== 'string') {
      bindingOk = false;
    } else if (auth.to.toLowerCase() !== payTo.toLowerCase()) {
      // DT-4 / CD-3: case-insensitive recipient comparison.
      bindingOk = false;
    } else {
      try {
        // DT-3 / CD-7: same atomic units as the challenge quote. No scaling.
        if (BigInt(auth.value) < BigInt(requiredAmount)) bindingOk = false;
      } catch {
        bindingOk = false; // unparseable value → mismatch, not crash.
      }
    }
    if (!bindingOk) {
      // AC-6 / DT-6 / CD-2: full detail in the internal log, NOT in the body.
      request.log.warn(
        {
          error_code: 'X402_BINDING_MISMATCH',
          received: {
            to: typeof auth.to === 'string' ? auth.to : null,
            value: typeof auth.value === 'string' ? auth.value : null,
          },
          expected: { payTo, requiredAmount },
        },
        'x402 inbound payment rejected: recipient/amount binding mismatch',
      );
      return reply
        .status(402)
        .send(
          await buildX402Response(
            opts,
            resource,
            chainKey,
            'Payment binding rejected: recipient or amount mismatch',
          ),
        );
    }
```

Notas obligatorias:
- El `errorMessage` que pasás a `buildX402Response` es **genérico** — NO incluye
  el `payTo`/`walletAddress` en claro (CD-2). El `accepts[0].payTo` del challenge
  ya anuncia el wallet correcto vía protocolo; eso es esperado y correcto.
- Usá `>=` semántico (rechazás solo `<`, es decir underpay). **Overpay se acepta**
  (DT-3): el caller paga de más, el server cobra el `value` firmado.
- El check corre SIEMPRE, para las 3 cadenas (CD-8 usa el `chainKey` ya resuelto).

**W1.3 — Propagar `paymentRequirements` a verify/settle.**

En la llamada a `verify(...)` (línea ~214) y a `settle(...)` (línea ~249),
agregá el campo (las dos llamadas pasan el mismo objeto):

```ts
verifyResult = await getPaymentAdapter(chainKey).verify({
  authorization: paymentPayload.authorization,
  signature: paymentPayload.signature,
  network: paymentPayload.network ?? '',
  paymentRequirements: { payTo, maxAmountRequired: requiredAmount },
});
```

```ts
settleResult = await getPaymentAdapter(chainKey).settle({
  authorization: paymentPayload.authorization,
  signature: paymentPayload.signature,
  network: paymentPayload.network ?? '',
  paymentRequirements: { payTo, maxAmountRequired: requiredAmount },
});
```

**Gate W1:** `tsc --noEmit` verde. El bypass queda cerrado acá.

---

### W2 — Propagar requirements en los adapters (defensa en profundidad)

Patrón común para los 3: `buildX402CanonicalBody` acepta un nuevo param
`requirements?: { payTo: string; maxAmountRequired: string }` y usa
`requirements?.maxAmountRequired ?? authorization.value` para `amount` y
`requirements?.payTo ?? authorization.to` para `payTo` (fallback = comportamiento
actual, CD-4). `verifyX402`/`settleX402` reenvían `proof.paymentRequirements` /
`req.paymentRequirements`.

**W2.1 — `src/adapters/base/payment.ts`**

`buildX402CanonicalBody` (líneas 236-257): agregar 4º param y cambiar líneas 249/251:

```ts
function buildX402CanonicalBody(
  authorization: X402PaymentRequest['authorization'],
  signature: string,
  network: BaseNetwork,
  requirements?: { payTo: string; maxAmountRequired: string },
): unknown {
  return {
    x402Version: 2,
    resource: { url: process.env.X402_RESOURCE_URL ?? 'https://wasiai.ai/pay' },
    accepted: {
      scheme: BASE_SCHEME,
      network: getNetworkTag(network),
      amount: requirements?.maxAmountRequired ?? authorization.value,
      asset: getUsdcAddress(network),
      payTo: requirements?.payTo ?? authorization.to,
      maxTimeoutSeconds: BASE_MAX_TIMEOUT_SECONDS,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: { signature, authorization },
  };
}
```

En `verifyX402` (línea 264) y `settleX402` (línea 309) reenviar:
```ts
const body = buildX402CanonicalBody(
  proof.authorization, proof.signature, network, proof.paymentRequirements,
);
// settleX402: req.authorization, req.signature, network, req.paymentRequirements
```
`verify`/`settle` públicos (398-404) ya pasan `proof`/`req` completos — sin cambio.

**W2.2 — `src/adapters/avalanche/payment.ts`**

Idéntico a base: `buildX402CanonicalBody` (211-232) agrega 4º param, líneas 224/226
con fallback; `verifyX402` (línea 239) y `settleX402` (línea 284) reenvían
`proof.paymentRequirements` / `req.paymentRequirements`.

**W2.3 — `src/adapters/kite-ozone/payment.ts`** (DOS modos: Pieverse + x402)

- **Pieverse verify** (líneas 252-260): cambiar el `paymentRequirements` del body
  Pieverse:
  ```ts
  maxAmountRequired: proof.paymentRequirements?.maxAmountRequired ?? proof.authorization.value,
  payTo: proof.paymentRequirements?.payTo ?? proof.authorization.to,
  ```
- **Pieverse settle** (líneas 296-304): idéntico con `req.paymentRequirements`.
- **x402 `buildX402CanonicalBody`** (440-461): agregar param
  `requirements?: { payTo: string; maxAmountRequired: string }` (firma actual son
  2 args: `authorization, signature` — sin network) y cambiar líneas 453/455 con
  fallback.
- `verifyX402(proof)` (línea 466) y `settleX402(req)` (línea 499): reenviar
  `proof.paymentRequirements` / `req.paymentRequirements` como 3er arg de
  `buildX402CanonicalBody`.

**Gate W2:** `tsc --noEmit` verde.

---

### W3 — Tests de adapters (AC-4: body server-side, NO caller)

Patrón (ver `base.test.ts:262-291`): `mockFetch.mockResolvedValueOnce({ok:true,status:200,json:async()=>({verified:true})})`,
llamar `adapter.verify({...})` con `paymentRequirements` del server y `authorization`
del atacante, luego `const body = JSON.parse((mockFetch.mock.calls[0][1] as {body:string}).body)`.

- **`src/adapters/__tests__/base.test.ts`** — nuevo test:
  ```ts
  await adapter.verify({
    authorization: { from:'0x11..', to:'0xATTACKER...', value:'1', validAfter:'0', validBefore:'9999999999', nonce:`0x${'a'.repeat(64)}` },
    signature: '0xSIG',
    network: 'eip155:84532',
    paymentRequirements: { payTo:'0xSERVER...', maxAmountRequired:'1000000' },
  });
  // body.accepted.payTo === '0xSERVER...'  (NOT '0xATTACKER...')
  // body.accepted.amount === '1000000'     (NOT '1')
  ```
- **`src/adapters/__tests__/avalanche.test.ts`** — idéntico (network `eip155:43113`).
- **kite (`payment.contract.test.ts`)** — cubrir AMBOS modos:
  - Pieverse: `body.paymentRequirements.payTo === server` ∧ `body.paymentRequirements.maxAmountRequired === required`.
  - x402: `body.accepted.payTo === server` ∧ `body.accepted.amount === required`.
- Direcciones: usar 40 hex chars completos (no abreviar en el código real).

**Gate W3:** los 4+ tests AC-4 verdes.

---

### W4 — Tests del middleware (AC-1, AC-2, AC-3, AC-6)

**Archivo NUEVO: `src/middleware/x402.binding.test.ts`.** Cloná el harness de
`x402.chain-aware.test.ts` (mock registry kite 18-dec + base 6-dec; `mockKiteVerify`/
`mockKiteSettle`/`mockBaseVerify`/`mockBaseSettle`; `process.env.KITE_WALLET_ADDRESS = '0x000000000000000000000000000000000000dEaD'` en `beforeEach`).
Fixture: `buildEoaPaymentHeader(opts)`. Registrá una ruta de prueba con
`requirePayment({})` como `preHandler` y un handler que devuelva
`{ paid: request.paymentVerified }`.

| Test | AC | Setup | Assert clave |
|------|-----|-------|--------------|
| `T-AC1: to-mismatch → 402 sin verify/settle` | AC-1, CD-1 | `buildEoaPaymentHeader({ to:'0x000000000000000000000000000000000000beef', value:'1000000' })` + `x-payment-chain: base-sepolia` (base req=`1000000`) | `statusCode===402` ∧ `mockBaseVerify` NOT called ∧ `mockBaseSettle` NOT called |
| `T-AC2: underpay → 402 sin verify/settle` | AC-2, CD-1 | `buildEoaPaymentHeader({ to:'0x..dEaD', value:'1' })` + `x-payment-chain: base-sepolia` (req=`1000000`) | `statusCode===402` ∧ `mockBaseVerify` NOT called |
| `T-AC3: pago correcto → verify+settle, paymentVerified` | AC-3 | `buildEoaPaymentHeader({ to:'0x..dEaD', value:'1000000' })` + `x-payment-chain: base-sepolia` | `statusCode===200`, body `paid===true`; `mockBaseVerify`/`mockBaseSettle` called 1× |
| `T-AC3-overpay: value > required → acepta` | AC-3, DT-3 | mismo con `value:'2000000'` (> base `1000000`) | acepta (settle called) |
| `T-AC6: log estructurado en reject` | AC-6, CD-2 | spy `request.log.warn` (o `app.log`); reject por to-mismatch | warn con `error_code:'X402_BINDING_MISMATCH'`; body 402 NO contiene `'dEaD'` en claro |
| `T-3CHAINS: binding aplica en kite/base/avalanche` | AC-1/2 ×3 | parametrizado por `x-payment-chain`. **Para kite** required=`10^18` → caso correcto usa `value:'1000000000000000000'`; caso malo `value:'1'`. **Para base/avalanche** required=`1000000`. | reject con to/value malos en las 3; acepta con valores correctos por cadena |
| `T-NOREG: challenge 402 sin header` | no-reg | sin `payment-signature` | `accepts[0]` byte-idéntico (`payTo`, `maxAmountRequired`) — el helper no cambió la salida |

> ⚠️ **TRAMPA DIMENSIONAL DEL HARNESS (CD-7/CD-8 — leer antes de codear los tests):**
> El fixture default usa `value:'1000000'` (6-dec), pero el mock **kite** declara
> `quote().amountWei = '1000000000000000000'` (18-dec). Contra el mock kite por
> defecto, `1000000 < 10^18` → el caso "pago correcto" **fallaría como underpay**.
> Esto NO es un bug: es la separación dimensional de CD-7.
> **Regla para el Dev:** en cada test, alineá el `value` del fixture con el `quote`
> del mock de la cadena bajo prueba:
> - base / avalanche (6-dec) → required `'1000000'` → usá `value:'1000000'`.
> - kite (18-dec) → required `'1000000000000000000'` → usá `value:'1000000000000000000'`.
> NUNCA escales `value` por decimales. Para los tests "pago correcto" preferí
> enrutar a `base-sepolia` (alineado con el default `'1000000'`) o pasar el
> `value` 18-dec explícito para kite.

**Gate W4:** AC-1/2/3/6 verdes; la suite legacy (`x402.chain-aware.test.ts`,
`x402.dual-header.test.ts`, `x402.passport-shape.test.ts`) sigue verde sin
cambios (CD-10 — el fixture default `to:'0x..dEaD'` = `KITE_WALLET_ADDRESS`
del test ya pasa el binding cuando el `value` está alineado a la cadena).

---

### W5 — Verificación final

1. `tsc --noEmit` → 0 errores.
2. `biome check` sobre los archivos tocados → 0 hallazgos (CD-9). Escribí las
   aserciones largas ya en multilínea; no asumas auto-format.
3. `npm test` completo → suite verde (no-regresión, CD-10). Si un test legacy
   usa un `to` distinto del wallet y rompe, adaptalo en este mismo PR y
   documentalo en el auto-blindaje.

---

## 5. Constraint Directives (INVIOLABLES)

- **CD-1**: PROHIBIDO `verify()`/`settle()` si el binding falla. Reject antes del network call.
- **CD-2**: PROHIBIDO exponer el `walletAddress` completo en el body 402. Log interno sí, response body genérico.
- **CD-3**: OBLIGATORIO comparar `to` case-insensitive (`.toLowerCase()` ambos lados).
- **CD-4**: OBLIGATORIO `paymentRequirements` opcional + fallback al valor actual (`authorization.*`). Outbound `sign()` no se rompe.
- **CD-5**: PROHIBIDO modificar la resolución de `walletAddress` (`PAYMENT_WALLET_ADDRESS || KITE_WALLET_ADDRESS`). Reutilizar.
- **CD-6**: OBLIGATORIO tests con mocks de fetch/adapter (no network real) + test que verifica que verify/settle NO se llaman cuando el binding falla.
- **CD-7** (WKH-67 / CD-DEC-01): PROHIBIDO comparar `value` contra un `requiredAmount` de dimensión distinta. `requiredAmount` SHALL venir de la MISMA fuente que el challenge (`quote().amountWei` u `opts.amount`) de la MISMA `chainKey`. `value` está en **unidades atómicas del token** (6-dec USDC Base/Avalanche, 18-dec Kite). NUNCA escalar, NUNCA mezclar 18-dec con 6-dec.
- **CD-8**: OBLIGATORIO usar el `chainKey` YA resuelto en el handler (no re-resolver). Coherencia challenge↔binding↔verify.
- **CD-9** (WKH-125b): OBLIGATORIO `biome check` sobre los archivos tocados antes de cerrar cada wave de tests; aserciones largas en multilínea.
- **CD-10**: PROHIBIDO romper `x402.chain-aware.test.ts`, `x402.dual-header.test.ts`, `x402.passport-shape.test.ts`.

---

## 6. Definition of Done

- [ ] W0-W5 completas en orden (W0 bloquea W1-W3; W1 cierra el bypass).
- [ ] `tsc --noEmit` → **0 errores**.
- [ ] `biome check` → **0 hallazgos** en archivos tocados (CD-9).
- [ ] `npm test` → **suite completa verde** (incluye los 3 tests legacy de CD-10).
- [ ] **≥1 test por AC**: AC-1 (T-AC1), AC-2 (T-AC2), AC-3 (T-AC3 + T-AC3-overpay), AC-4 (W3 base/avalanche/kite-pieverse/kite-x402), AC-5 (cubierto por T-3CHAINS dimensional), AC-6 (T-AC6).
- [ ] Binding corre ANTES de `verify()`/`settle()` (CD-1) y para las 3 cadenas (CD-8).
- [ ] Body 402 de reject NO expone el wallet (CD-2); log interno lleva `error_code:'X402_BINDING_MISMATCH'` con received/expected (AC-6).
- [ ] `paymentRequirements?` opcional, fallback intacto, outbound no roto (CD-4).
- [ ] `resolvePaymentRequirements` es la única fuente de `payTo`/`requiredAmount` (challenge + binding), sin doble `quote()` (DT-5) ni drift dimensional (CD-7).
