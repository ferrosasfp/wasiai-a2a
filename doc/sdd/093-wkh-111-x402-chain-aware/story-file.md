# Story File — #093: [WKH-111] [BASE-06] x402 payment path chain-aware

> SDD: doc/sdd/093-wkh-111-x402-chain-aware/sdd.md
> Fecha: 2026-05-27
> Branch: feat/093-wkh-111-x402-chain-aware
> Tipo: feature (evolutivo sobre superficie crítica de pagos)

---

## Goal

Hacer **chain-aware** el path x402 inbound del gateway (`src/middleware/x402.ts`).
Hoy `buildX402Response` (challenge 402), `verify` y `settle` llaman
`getPaymentAdapter()` **sin `chainKey`**, así que siempre resuelven el bundle
DEFAULT (Kite, `eip155:2368`, 18 decimales, amount fallback `1e18`). El header
`x-payment-chain: base-sepolia` se ignora en la rama sin a2a-key. Esta HU es
**wiring (no rewrite)**: `requirePayment` resuelve `x-payment-chain` con
`resolveChainKey` (mismo patrón ya implementado en `a2a-key.ts`), valida con un
**400 `CHAIN_NOT_SUPPORTED`** fail-loud, y propaga un único `chainKey: ChainKey`
a challenge/verify/settle. **CERO regresión** para el path Kite default: sin
header, el comportamiento es byte-idéntico al actual.

---

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado. QA los verifica en F4.

- **AC-1** (challenge chain-aware): WHEN un request a `/compose` trae
  `x-payment-chain: base-sepolia` sin `x-a2a-key` ni `payment-signature`, THEN
  the system SHALL responder **402** con `accepts[0].network = 'eip155:84532'`,
  `accepts[0].asset =` la dirección USDC de Base Sepolia, y
  `accepts[0].maxAmountRequired` expresado en 6 decimales (NO el default `1e18` de Kite).

- **AC-2** (verify+settle ruteado a Base): WHEN se reenvía un `payment-signature`
  EIP-3009 válido con `x-payment-chain: base-sepolia`, THEN the system SHALL
  ejecutar `verify` y `settle` contra el adapter de Base (`network = 'eip155:84532'`)
  y, ante settle exitoso, retornar **HTTP 200** con header `payment-response`
  conteniendo el tx hash.

- **AC-3** (CERO regresión Kite default): WHEN un request NO envía `x-payment-chain`,
  THEN the system SHALL comportarse byte-idéntico al path actual (bundle default
  Kite, challenge `eip155:2368`, fallback amount `'1000000000000000000'`) y los
  tests existentes (baseline registrado en W0.1) SHALL permanecer verdes.

- **AC-4** (chain no inicializada / no reconocida): IF `x-payment-chain` trae un
  slug/chainId que NO está inicializado en el registry (o no reconocido), THEN
  the system SHALL retornar **HTTP 400** con `error_code: 'CHAIN_NOT_SUPPORTED'`
  y un mensaje que incluya la lista de chains inicializadas
  (`getInitializedChainKeys()`), sin caer silenciosamente al default.

- **AC-5** (coherencia del settle con el challenge): WHILE el request declara una
  chain via header, the system SHALL usar el MISMO `chainKey` resuelto para el
  challenge, el `verify` y el `settle` (no mezclar el `network` del payload del
  cliente con un bundle distinto al anunciado).

---

## Anti-Hallucination Checklist (símbolos VERIFICADOS — usar EXACTAMENTE estos)

> Todo lo de abajo fue verificado con Read/Grep en el codebase el 2026-05-27.
> NO inventar firmas ni paths. Si algo no coincide con lo que ves → PARAR y escalar.

### Imports a agregar en `src/middleware/x402.ts`

El archivo HOY importa solo `getPaymentAdapter`:
```ts
import { getPaymentAdapter } from '../adapters/registry.js';
```

Reemplazar/ampliar por (mismo patrón que `a2a-key.ts:14-19`):
```ts
import { resolveChainKey } from '../adapters/chain-resolver.js';
import {
  getAdaptersBundle,
  getDefaultChainKey,
  getInitializedChainKeys,
  getPaymentAdapter,
} from '../adapters/registry.js';
import type { ChainKey } from '../adapters/types.js';
```

### Firmas EXACTAS (verificadas)

| Símbolo | Path | Firma real (verificada) |
|---------|------|--------------------------|
| `resolveChainKey` | `../adapters/chain-resolver.js` | `resolveChainKey(input: { headerOverride?: string; agentManifestChain?: string }): ChainKey \| undefined` — pura, nunca throw. `'base-sepolia'`/`'84532'`/`'base-testnet'` → `'base-sepolia'`. Input desconocido → `undefined`. **Usar SOLO con `{ headerOverride }`.** (chain-resolver.ts:77-88) |
| `getPaymentAdapter` | `../adapters/registry.js` | `getPaymentAdapter(chainKey?: ChainKey): PaymentAdapter` — ya acepta el arg; resuelve el bundle vía `resolveBundleOrThrow`. Sin arg → bundle default. (registry.ts:172-174) |
| `getAdaptersBundle` | `../adapters/registry.js` | `getAdaptersBundle(chainKey?: ChainKey): AdaptersBundle \| undefined` — no-throw; `undefined` si el chainKey NO está inicializado o el registry no se inicializó. (registry.ts:213-220) |
| `getInitializedChainKeys` | `../adapters/registry.js` | `getInitializedChainKeys(): ChainKey[]` — lista de chains inicializadas en orden CSV. (registry.ts:226-228) |
| `getDefaultChainKey` | `../adapters/registry.js` | `getDefaultChainKey(): ChainKey \| null` — `null` si el registry no se inicializó. (registry.ts:234-236) |
| `ChainKey` | `../adapters/types.js` | `type ChainKey = 'kite-ozone-testnet' \| 'kite-mainnet' \| 'avalanche-fuji' \| 'avalanche-mainnet' \| 'base-sepolia' \| 'base-mainnet'`. (types.ts:122-128) |
| `adapter.quote` | (instancia de `getPaymentAdapter(chainKey)`) | `quote(amountUsd: number): Promise<QuoteResult>` — **ASYNC**. `QuoteResult = { amountWei: string; token: TokenSpec; facilitatorUrl: string }`. Base → `amountWei: '1000000'` (6-dec, base/payment.ts:387-399). Kite → `amountWei: '1000000000000000000'` (18-dec, kite-ozone/payment.ts:330-337). **El arg `amountUsd` se ignora en ambos adapters actuales (devuelven constantes).** |
| `adapter.getNetwork` | (instancia) | `getNetwork(): string`. Base → `'eip155:84532'` (base/payment.ts:363-365). Kite → `'eip155:2368'`. |
| `adapter.getToken` | (instancia) | `getToken(): \`0x${string}\``. Base → `'0x036CbD53842c5426634e7929541eC2318f3dCF7e'` (USDC Base Sepolia, base/payment.ts:50, :367-369). |
| `adapter.getMaxTimeoutSeconds` | (instancia) | `getMaxTimeoutSeconds(): number`. Base → `60` (base/payment.ts:371-373). Kite → `300`. |
| `adapter.verify` / `adapter.settle` | (instancia) | Async. `verify(...): Promise<{ valid: boolean; error?: string }>`, `settle(...): Promise<{ txHash: string; success: boolean; error?: string }>`. Firma de args idéntica a la actual (`{ authorization, signature, network }`). |

### Patrón de resolución + 400 a REPLICAR — fuente: `a2a-key.ts:188-224` (VERBATIM, sin el budget/debit)

```ts
// 6. Resolve target chain per-request (WKH-MULTICHAIN W2)
const headerRaw = request.headers['x-payment-chain'];
const headerOverride =
  typeof headerRaw === 'string' ? headerRaw : undefined;
const defaultChainKey = getDefaultChainKey();

let chainKey = resolveChainKey({ headerOverride });
if (!chainKey) {
  if (headerOverride !== undefined) {
    // CD-14: header present but unrecognised → 400, never silent default.
    return reply.status(400).send({
      error_code: 'CHAIN_NOT_SUPPORTED',
      error: `Chain '${headerOverride}' is not a recognized slug or chainId`,
    });
  }
  // Header absent → fall back to registry default.
  chainKey = defaultChainKey ?? undefined;
  if (!chainKey) {
    return reply.status(500).send({
      error_code: 'REGISTRY_NOT_INITIALIZED',
      error: 'No chains initialized in registry',
    });
  }
}

const bundle = getAdaptersBundle(chainKey);
if (!bundle) {
  // recognised slug but not present in the initialised registry.
  return reply.status(400).send({
    error_code: 'CHAIN_NOT_SUPPORTED',
    error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
  });
}
```

> **Diferencia clave vs a2a-key.ts**: en `x402.ts` NO hay debit ni budget. Solo se
> necesita el `chainKey: ChainKey` resuelto para pasarlo a las 3 llamadas. NO
> necesitás `bundle.chainConfig.chainId` ni `bundle.payment.supportedTokens` (eso
> es de la rama a2a-key). El `bundle` solo se usa para el guard `if (!bundle)`.
> Después de ese guard, `chainKey` es de tipo `ChainKey` (no `undefined`).

### Patrón de TEST a REPLICAR — fuente: `x402.passport-shape.test.ts`

El exemplar mockea el registry con **un solo `getPaymentAdapter`** arg-less. Esta HU
introduce `getAdaptersBundle`/`getInitializedChainKeys`/`getDefaultChainKey`/`resolveChainKey`,
así que el `vi.mock` debe cubrirlos. Estructura confirmada del exemplar:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the adapter registry BEFORE importing the middleware.
const mockVerify = vi.fn().mockResolvedValue({ valid: true });
const mockSettle = vi.fn().mockResolvedValue({ txHash: '0xdeadbeef', success: true });
const mockAdapter = {
  verify: (...args: unknown[]) => mockVerify(...args),
  settle: (...args: unknown[]) => mockSettle(...args),
  getToken: vi.fn().mockReturnValue('0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e'),
  getNetwork: vi.fn().mockReturnValue('kite-mainnet'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(30),
};

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => mockAdapter,
}));

import { decodeXPayment, requirePayment } from './x402.js';
```

- **Fastify in-memory + `app.inject`** (NO levantar servidor real). Patrón:
  `const app = Fastify(); app.post('/test', { preHandler: requirePayment({ description: 'test' }) }, handler); await app.ready(); ... await app.inject({ method, url, headers, payload }); ... await app.close();`
- **Guarda/restaura env** en `beforeEach`/`afterEach`:
  ```ts
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KITE_WALLET_ADDRESS = '0x000000000000000000000000000000000000dEaD';
  });
  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) delete process.env.KITE_WALLET_ADDRESS;
    else process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
  });
  ```
- **Fixtures de payment-signature** (verificadas en `test/fixtures/passport-shape.ts`):
  `buildEoaPaymentHeader(opts?)` y `buildPassportPaymentHeader(opts?)` →
  `{ headers, paymentRequest }`. Import:
  `import { buildEoaPaymentHeader } from '../../test/fixtures/passport-shape.js';`
  El `opts.network` por defecto es `'kite-mainnet'`; `opts.value` por defecto `'1000000'`.
  Para tests con header de chain, agregá `'x-payment-chain'` al objeto `headers` que
  spreadeás en `app.inject` (NO modifiqués la fixture).

### Mock del registry para esta HU (patrón ampliado — Dev lo construye)

El `vi.mock('../adapters/registry.js', ...)` debe exportar **un dispatcher por chainKey**.
Estructura sugerida (Dev la implementa siguiendo el exemplar; los símbolos existen):

```ts
const baseAdapter = {
  verify: (...a: unknown[]) => mockBaseVerify(...a),
  settle: (...a: unknown[]) => mockBaseSettle(...a),
  getToken: vi.fn().mockReturnValue('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  getNetwork: vi.fn().mockReturnValue('eip155:84532'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(60),
  quote: vi.fn().mockResolvedValue({ amountWei: '1000000', token: { symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 }, facilitatorUrl: 'http://mock' }),
};
const kiteAdapter = {
  verify: (...a: unknown[]) => mockKiteVerify(...a),
  settle: (...a: unknown[]) => mockKiteSettle(...a),
  getToken: vi.fn().mockReturnValue('0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e'),
  getNetwork: vi.fn().mockReturnValue('eip155:2368'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(300),
  quote: vi.fn().mockResolvedValue({ amountWei: '1000000000000000000', token: { symbol: 'KITE', address: '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e', decimals: 18 }, facilitatorUrl: 'http://mock' }),
};

const mockGetPaymentAdapter = vi.fn((chainKey?: string) =>
  chainKey === 'base-sepolia' ? baseAdapter : kiteAdapter,
);

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (chainKey?: string) => mockGetPaymentAdapter(chainKey),
  getAdaptersBundle: (chainKey?: string) => {
    // simular registry con kite-ozone-testnet + base-sepolia inicializadas
    if (chainKey === undefined) return { chainConfig: { chainId: 2368 } }; // default
    if (chainKey === 'base-sepolia') return { chainConfig: { chainId: 84532 } };
    if (chainKey === 'kite-ozone-testnet') return { chainConfig: { chainId: 2368 } };
    return undefined; // p.ej. avalanche-fuji → no inicializada → 400
  },
  getInitializedChainKeys: () => ['kite-ozone-testnet', 'base-sepolia'],
  getDefaultChainKey: () => 'kite-ozone-testnet',
}));
```

> NO se mockea `resolveChainKey` (es pura, se deja real — así el test ejercita el
> mapeo de alias real `base-sepolia` → `'base-sepolia'` y `solana` → `undefined`).
> Por tanto NO agregar `resolveChainKey` al `vi.mock` del registry; importar la
> real desde `../adapters/chain-resolver.js` (no requiere mock).

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/middleware/x402.ts` | Modificar | (a) ampliar imports. (b) `buildX402Response` → `async`, acepta `chainKey: ChainKey` como 3er param, `errorMessage` pasa a 4to; usa `getPaymentAdapter(chainKey)`; amount default = `opts.amount ?? (await adapter.quote(DEFAULT_AMOUNT_USD)).amountWei`. (c) `verify`/`settle` usan `getPaymentAdapter(chainKey)`. (d) `requirePayment` resuelve `chainKey` una vez (ANTES de leer `payment-signature`), 400 `CHAIN_NOT_SUPPORTED`, y `await`-ea TODOS los `buildX402Response(...)` pasando el `chainKey`. | `a2a-key.ts:188-224` |
| 2 | `src/middleware/x402.chain-aware.test.ts` | Crear | 9 tests unitarios (AC-1..AC-5 + guards). Mock registry dispatcher por chainKey + Fastify inject. | `x402.passport-shape.test.ts` |
| 3 | `scripts/smoke-base-sepolia.mjs` | **NO modificar** | Oráculo E2E read-only. Pasa a verde como evidencia de AC-1/AC-2 (W2). | — |
| 4 | `src/middleware/a2a-key.ts` | **NO modificar** | El wiring del fallback NO requiere tocarlo (CD-8). Si creés que sí → PARAR y escalar. | — |

---

## Constraint Directives

### OBLIGATORIO

- **CD-1** (cero regresión Kite default): el path SIN `x-payment-chain` DEBE ser
  byte-idéntico al actual (bundle default Kite, challenge `eip155:2368`, amount
  `'1000000000000000000'`). Los tests del baseline (W0.1) DEBEN seguir verdes.
  Cualquier diff observable en el path default es **BLOQUEANTE**.
- **CD-3** (TypeScript strict): PROHIBIDO `any` explícito y `as unknown` en código
  de producción. El `chainKey` propagado DEBE tiparse como `ChainKey` (importado de
  `../adapters/types.js`), NO `string`. (En tests, el `as unknown` del exemplar para
  args de mocks está tolerado porque sigue el patrón existente.)
- **CD-5** (fail-loud en chain no soportada): PROHIBIDO caer al default cuando el
  header está presente pero es desconocido/no inicializado. DEBE **400**
  `CHAIN_NOT_SUPPORTED`. No silent fallback.
- **CD-6** (coherencia de chain): challenge, verify y settle de un mismo request
  DEBEN usar el MISMO `chainKey`. La resolución ocurre UNA sola vez al inicio del
  handler de `requirePayment`.
- **CD-7** (reutilizar el resolver puro): usar `resolveChainKey` de
  `chain-resolver.js`. PROHIBIDO inline una tabla de aliases o un
  `if (header === 'base-sepolia')`.
- **CD-9** (amount dimensional por chain — hereda CD-DEC-01 de WKH-67/072): el
  `maxAmountRequired` del challenge DEBE derivar de `adapter.quote()` de la chain
  resuelta. PROHIBIDO reusar el literal `'1000000000000000000'` para Base (sería
  10^12 USDC). El default amount viene SIEMPRE del adapter, nunca de un literal
  18-dec compartido.
- **CD-10** (orden de resolución antes del challenge): la resolución del `chainKey`
  DEBE ocurrir ANTES de la rama `if (!xPaymentHeader)` (línea actual :123) para que
  el challenge 402 sin payment-signature también sea chain-aware. La resolución va
  DESPUÉS del guard de wallet (:103-113) y DESPUÉS del set de `paymentOrigin`
  (:114-120), pero ANTES de leer `payment-signature` (:122).
- **CD-11** (no leer `request.body`): el resolver lee SOLO
  `request.headers['x-payment-chain']`. PROHIBIDO leer `request.body`.

### PROHIBIDO

- NO modificar `src/middleware/a2a-key.ts` (CD-8). Si el Dev cree que lo necesita → **PARAR y escalar**.
- NO modificar `src/adapters/registry.ts`, `src/adapters/chain-resolver.ts`, ni ningún adapter (`base/payment.ts`, `kite-ozone/payment.ts`). `getPaymentAdapter(chainKey?)` ya soporta el arg.
- NO modificar `scripts/smoke-base-sepolia.mjs` (oráculo read-only).
- NO hardcodear chainIds, addresses, network tags ni decimales de Base en `x402.ts`. El ÚNICO literal nuevo tolerado es `DEFAULT_AMOUNT_USD = 1` (arg de `quote()`, no un monto en wei) — CD-4.
- NO agregar dependencias nuevas (ninguna).
- NO usar `any` / `as unknown` en producción (CD-3).
- NO intentar inferir la chain desde `paymentPayload.network` (DT-3: el header es la única fuente de verdad para seleccionar el adapter; `paymentPayload.network` se sigue pasando como arg a `verify`/`settle` igual que hoy, líneas :145/:178).
- NO resolver la chain dos veces (CD-6). UNA sola resolución al inicio del handler.

---

## Test Expectations

> Framework: **vitest**. Estrategia: `vi.mock('../adapters/registry.js')` con
> dispatcher por chainKey (Base mock 6-dec + Kite mock 18-dec) + Fastify in-memory
> `app.inject`. `resolveChainKey` se deja REAL (no se mockea). NO se mockea viem ni
> el facilitator. Test-first: SÍ (lógica de negocio sobre superficie de pagos).

| Test | ACs que cubre | Qué prueba / qué mockear |
|------|--------------|--------------------------|
| **T-AC1: challenge Base 6-dec** | AC-1 | Request con `'x-payment-chain': 'base-sepolia'`, SIN `payment-signature`. Afirma 402 + `body.accepts[0].network === 'eip155:84532'` + `body.accepts[0].asset === '0x036CbD53842c5426634e7929541eC2318f3dCF7e'` + `body.accepts[0].maxAmountRequired === '1000000'` (6-dec). |
| **T-AC2: verify+settle ruteado a Base** | AC-2 | `baseAdapter.verify→{valid:true}`, `settle→{txHash:'0xbeef',success:true}`. Request con `payment-signature` válido (`buildEoaPaymentHeader()`) + `'x-payment-chain':'base-sepolia'`. Afirma 200 + header `payment-response === '0xbeef'` + `mockGetPaymentAdapter` invocado con `'base-sepolia'` (NO sin arg / NO con default). |
| **T-AC3a: cero regresión challenge Kite** | AC-3/CD-1 | SIN `x-payment-chain`, SIN `payment-signature`. Afirma 402 + `accepts[0].network === 'eip155:2368'` + `accepts[0].maxAmountRequired === '1000000000000000000'` (18-dec, byte-idéntico). |
| **T-AC3b: cero regresión verify+settle Kite** | AC-3/CD-1 | SIN header, `buildEoaPaymentHeader()` válido. Afirma 200 + que el adapter resuelto fue el default (`mockGetPaymentAdapter` invocado con `undefined` o `'kite-ozone-testnet'` según resolución — verificar que NO es `'base-sepolia'`). |
| **T-AC4a: 400 chain no reconocida** | AC-4/CD-5 | `'x-payment-chain':'solana'`. Afirma 400 + `body.error_code === 'CHAIN_NOT_SUPPORTED'` + `body.error` incluye `"not a recognized slug or chainId"`. (resolveChainKey real devuelve undefined para `solana`.) |
| **T-AC4b: 400 chain reconocida no inicializada** | AC-4/CD-5 | `'x-payment-chain':'avalanche-fuji'` con `getAdaptersBundle('avalanche-fuji')→undefined` (mock). Afirma 400 + `error_code === 'CHAIN_NOT_SUPPORTED'` + `body.error` incluye `"Initialized: kite-ozone-testnet, base-sepolia"`. |
| **T-AC5: coherencia mismo chainKey challenge↔verify↔settle** | AC-5/CD-6 | `'x-payment-chain':'base-sepolia'` + `payment-signature` válido. Afirma que TODAS las invocaciones de `mockGetPaymentAdapter` fueron con `'base-sepolia'` (`mockGetPaymentAdapter.mock.calls.every(c => c[0] === 'base-sepolia')`), nunca con un chainKey distinto. |
| **T-CD9: amount default Base ≠ literal 18-dec** | CD-9 | Reafirma T-AC1: con Base y SIN `opts.amount`, `maxAmountRequired === '1000000'` y `!== '1000000000000000000'`. Guard explícito contra el bug dimensional (auto-blindaje WKH-67/072). |
| **T-OPTS-AMOUNT: `opts.amount` override respeta el override** | AC-1/CD-1 | Montar `requirePayment({ description: 'test', amount: '7777777' })`. Challenge usa `'7777777'` (no el quote), tanto con header Base como sin header. |

> Cobertura: AC-1 (T-AC1, T-CD9), AC-2 (T-AC2), AC-3 (T-AC3a, T-AC3b), AC-4 (T-AC4a,
> T-AC4b), AC-5 (T-AC5). **Total: 9 unit tests** + 1 smoke E2E (W2.1, read-only).

### Lecciones de auto-blindaje aplicadas (PREVENCIÓN OBLIGATORIA)

- **WKH-67/072 — "params shared across guards must have same unit/decimals"**: el
  `amount` del challenge es dimensional (6-dec Base vs 18-dec Kite). T-CD9 es el guard
  de regresión. PROHIBIDO el literal `1e18` como fallback para Base (CD-9).
- **WKH-67/072 W4 — ripple effect en async refactor**: convertir `buildX402Response`
  a `async` es un cambio amplio. Si tras W1 algún test legacy que llama
  `buildX402Response` DIRECTO y SYNC se rompe (>5 tests rotos = BLOCKER ripple),
  adaptarlo en el MISMO PR. Verificar con `grep -rn "buildX402Response" src/` que no
  haya call-sites sync fuera de `requirePayment` (hoy NO los hay — está exportada pero
  el único consumidor es `requirePayment` y los tests vía `app.inject`).

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN existen:
ls src/middleware/x402.ts src/middleware/a2a-key.ts \
   src/adapters/registry.ts src/adapters/chain-resolver.ts \
   src/adapters/types.ts src/adapters/base/payment.ts \
   src/adapters/kite-ozone/payment.ts \
   src/middleware/x402.passport-shape.test.ts \
   test/fixtures/passport-shape.ts \
   scripts/smoke-base-sepolia.mjs 2>/dev/null || echo "FALTA archivo base"
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.

### Wave 0 (Serial Gate — baseline ANTES de tocar código)

- [ ] **W0.1**: Registrar baseline de tests. Correr:
  ```bash
  cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npm test 2>&1 | tail -20
  ```
  **Anotar el número EXACTO de tests verdes** (el SDD/work-item dicen ~1039 — registrar el real). Es la línea base de CD-1.
- [ ] **W0.2**: Confirmar que `base-sepolia` resuelve en el registry (sanity). No requiere modificar código; basta con confirmar que el adapter Base expone `getNetwork() === 'eip155:84532'` (verificado en `base/payment.ts:363-365`) y que `'base-sepolia'` es un `ChainKey` válido (verificado en `types.ts:127`). NO es bloqueante para los unit tests (que mockean el registry).
- [ ] **W0.3**: Typecheck baseline limpio:
  ```bash
  /home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc --noEmit
  ```
  Debe terminar sin errores ANTES de empezar W1.

**Verificación W0**: baseline `npm test` registrado (N verde) + `tsc --noEmit` limpio.

### Wave 1 (Wiring de resolución + propagación + tests)

> Todas las tareas de W1 son sobre `src/middleware/x402.ts` (#1) y
> `src/middleware/x402.chain-aware.test.ts` (#2). Son SECUENCIALES (mismo archivo prod).

- [ ] **W1.1**: Ampliar imports en `x402.ts` (ver Anti-Hallucination § "Imports a agregar").
  Agregar `resolveChainKey`, `getAdaptersBundle`, `getDefaultChainKey`,
  `getInitializedChainKeys` y `import type { ChainKey }`. → Exemplar `a2a-key.ts:14-19`.

- [ ] **W1.2**: Definir constante module-level `const DEFAULT_AMOUNT_USD = 1;` (arg de
  `quote()`, NO un monto en wei — CD-4).

- [ ] **W1.3**: Refactor `buildX402Response` (`x402.ts:44-69`):
  - Cambiar firma a `async` y agregar `chainKey: ChainKey` como **3er parámetro**,
    moviendo `errorMessage` a **4to** con el mismo default:
    ```ts
    export async function buildX402Response(
      opts: PaymentMiddlewareOptions,
      resource: string,
      chainKey: ChainKey,
      errorMessage: string = 'payment-signature header is required',
    ): Promise<X402Response> {
      const adapter = getPaymentAdapter(chainKey);
      const walletAddress =
        process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS || '';
      const amount = opts.amount ?? (await adapter.quote(DEFAULT_AMOUNT_USD)).amountWei;
      // ... resto idéntico (merchantName, payload, return) ...
    }
    ```
  - El resto del body (`merchantName`, `payload`, `return`) queda igual. `adapter` ahora
    viene de `getPaymentAdapter(chainKey)` (línea actual :49).
  - **CD-9**: PROHIBIDO dejar el literal `'1000000000000000000'`; el fallback DEBE ser
    `(await adapter.quote(DEFAULT_AMOUNT_USD)).amountWei`.

- [ ] **W1.4**: En `requirePayment` (`x402.ts:96-209`), insertar la resolución de chain
  **JUSTO DESPUÉS** del set de `request.paymentOrigin` (línea actual :120) y del
  `const resource = ...` (línea actual :121), y **ANTES** de
  `const xPaymentHeader = request.headers['payment-signature'];` (línea actual :122).
  Replicar el bloque de Anti-Hallucination § "Patrón de resolución + 400" (sin budget).
  Tras el guard `if (!bundle)`, `chainKey` es de tipo `ChainKey`.

- [ ] **W1.5**: Convertir TODOS los call-sites de `buildX402Response(...)` a
  `await buildX402Response(..., chainKey, ...)`. **LISTADO EXHAUSTIVO (6 call-sites)** —
  numeración de líneas del archivo ACTUAL:
  1. **:124** — challenge sin payment-signature:
     `return reply.status(402).send(await buildX402Response(opts, resource, chainKey));`
  2. **:133-138** — `Invalid payment-signature format`:
     `await buildX402Response(opts, resource, chainKey, \`Invalid payment-signature format: ${detail}\`)`
  3. **:155-160** — `Facilitator unavailable`:
     `await buildX402Response(opts, resource, chainKey, \`Facilitator unavailable: ${detail}\`)`
  4. **:167-172** — `Payment verification failed`:
     `await buildX402Response(opts, resource, chainKey, \`Payment verification failed: ${verifyResult.error ?? 'unknown reason'}\`)`
  5. **:186-192** — `Payment settlement failed` (catch del settle):
     `await buildX402Response(opts, resource, chainKey, \`Payment settlement failed: ${detail}\`)`
  6. **:198-203** — `Payment settlement failed` (`!settleResult.success`):
     `await buildX402Response(opts, resource, chainKey, \`Payment settlement failed: ${settleResult.error ?? 'unknown reason'}\`)`
  > Como ahora son `await` dentro de `reply.status(402).send(...)`, asegurarse de que el
  > `await` esté DENTRO del `.send(...)` (el handler ya es `async`). Patrón:
  > `return reply.status(402).send(await buildX402Response(opts, resource, chainKey, msg));`

- [ ] **W1.6**: `verify` (`x402.ts:142`) → `getPaymentAdapter(chainKey).verify({ ... })`.
  `settle` (`x402.ts:175`) → `getPaymentAdapter(chainKey).settle({ ... })`. Los args
  (`{ authorization, signature, network: paymentPayload.network ?? '' }`) quedan IGUAL
  (DT-3: `paymentPayload.network` se sigue pasando, el ruteo lo fija `chainKey`).

- [ ] **W1.7**: Crear `src/middleware/x402.chain-aware.test.ts` con los **9 tests** del
  Test Expectations. Seguir el exemplar `x402.passport-shape.test.ts` + el mock
  dispatcher de la Anti-Hallucination § "Mock del registry para esta HU". `resolveChainKey`
  se importa REAL.

- [ ] **W1.8 (verif)**:
  ```bash
  cd /home/ferdev/.openclaw/workspace/wasiai-a2a && /home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc --noEmit && npm test 2>&1 | tail -20
  ```
  **PASS**: `tsc --noEmit` sin errores + suite completa verde (baseline W0.1 + 9 nuevos,
  cero regresión Kite — CD-1).

**Verificación W1**: `tsc --noEmit` limpio + `npm test` verde (N+9). Si >5 tests legacy
rotos → ripple effect (auto-blindaje WKH-67/072 W4): adaptar en el mismo PR o escalar.

### Wave 2 (Validación E2E + cierre)

- [ ] **W2.1**: Correr el smoke (READ-ONLY, NO modificar el script):
  ```bash
  cd /home/ferdev/.openclaw/workspace/wasiai-a2a && node scripts/smoke-base-sepolia.mjs
  ```
  Requiere un gateway corriendo con `WASIAI_A2A_CHAINS` incluyendo `base-sepolia`
  (e.g. `kite-ozone-testnet,base-sepolia`) + facilitator Base alcanzable + operator
  wallet con fondos USDC. **Evidencia esperada**: HTTP 402 con `network=eip155:84532`
  + HTTP 200 con tx hash verificable en Basescan (AC-1/AC-2).
  > Si el entorno de smoke NO está disponible (sin gateway / sin fondos), registrar
  > como "pendiente de runtime" y NO bloquear — los unit tests cubren la lógica.
  > Escalar al orquestador que el smoke E2E necesita el runtime configurado.

- [ ] **W2.2**: Confirmar suite completa verde una última vez (baseline + 9, cero
  regresión Kite — AC-3):
  ```bash
  cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npm test 2>&1 | tail -20
  ```

**Verificación W2**: smoke E2E verde (tx hash Basescan) cuando el runtime esté disponible
+ full suite verde.

### Verificación Incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | baseline `npm test` (N verde, registrado) + `tsc --noEmit` limpio |
| W1 | `tsc --noEmit` + `npm test` suite completa verde (N+9, cero regresión Kite) |
| W2 | smoke E2E verde (tx hash Basescan) + full suite verde |

---

## Out of Scope

> Lo que Dev NO debe tocar bajo ninguna circunstancia.

- `src/middleware/a2a-key.ts` — NO modificar (CD-8). El fallback NO requiere pasar el chainKey.
- `src/adapters/registry.ts`, `src/adapters/chain-resolver.ts`, `src/adapters/base/payment.ts`, `src/adapters/kite-ozone/payment.ts`, `src/adapters/types.ts` — NO modificar (ya soportan todo).
- `scripts/smoke-base-sepolia.mjs` — NO modificar (oráculo read-only).
- `src/lib/downstream-payment.ts` (outbound) — fuera de scope (BASE-07).
- Base Mainnet — solo Base Sepolia validado.
- Multi-`accepts` (challenge anuncia UNA chain).
- Modelo a2a-key / budget — sin cambios.
- 400 explícito por mismatch `paymentPayload.network` vs header — TD-WKH-111-01, NO se implementa en esta HU (el adapter ata la firma al domain → fail seguro).
- NO "mejorar" código adyacente. NO refactors no solicitados.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.**
> No inventar. No asumir. No improvisar.

Situaciones de escalation:
- Si tras W1 hay >5 tests legacy rotos por el cambio sync→async (ripple effect).
- Si el Dev cree que necesita modificar `a2a-key.ts` (CD-8) → STOP.
- Si `getPaymentAdapter(chainKey)` o `adapter.quote()` no tienen la firma documentada.
- Si algún call-site de `buildX402Response` aparece FUERA de los 6 listados en W1.5.
- Si el baseline W0.1 NO da verde antes de tocar nada (entorno roto).
- Cualquier ambigüedad en un AC o en el manejo de `paymentPayload.network`.

---

*Story File generado por NexusAgil — F2.5 — WKH-111 (BASE-06)*
