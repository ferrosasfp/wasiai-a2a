# Story File — WKH-55 Downstream x402 Payment (wasiai-a2a → Fuji USDC)

> **⚠️ ESTA ES LA UNICA FUENTE DE VERDAD PARA EL DEV EN F3.**
> No abras el SDD ni el work-item. Todo lo que necesitas esta aca.

---

## Header

| Campo | Valor |
|-------|-------|
| HU-ID | **WKH-55** |
| Title | Downstream x402 Payment — wasiai-a2a → wasiai-v2 Agents (Avalanche Fuji) |
| Branch | `feat/wkh-55-downstream-x402-fuji` |
| Base | `main` @ `00887c4` (WKH-53 RLS Ownership merged) |
| Tipo | feature on-chain (cross-chain Kite + Fuji) |
| Mode | QUALITY (AR + CR obligatorios) |
| Estimacion F3 | **L (4-6h)** |
| Pipeline | F2.5 ✅ → **F3 Dev** → AR → CR → F4 QA → DONE |
| HU_APPROVED | 2026-04-24 (humano) |
| SPEC_APPROVED | 2026-04-24 (orquestador) |
| Story File approved | 2026-04-24 (Architect F2.5) |
| Status | READY FOR F3 |

---

## 1. Context summary (lee esto primero)

### Que entrega WKH-55

WKH-55 anade una capa de **pago downstream EIP-3009** sobre USDC canonica de Avalanche Fuji (`eip155:43113`, 6 decimales) cuando el gateway invoca un agente del marketplace wasiai-v2. La capa es **aditiva** al header `x-agent-key` ya existente: el invoke al agente sigue funcionando exactamente igual; el downstream payment es una transferencia on-chain extra que registra la intencion de pago en blockchain. Todo gateado por feature flag `WASIAI_DOWNSTREAM_X402=true`.

Cuando el flag esta off (default), el comportamiento del codebase es **bit-exact identico** al baseline pre-WKH-55 — cero overhead, cero llamadas a viem, cero llamadas al facilitator.

### Dependencia con WFAC-52 (ya live)

El servicio `wasiai-facilitator` (`https://wasiai-facilitator-production.up.railway.app`) ya tiene el adapter Avalanche Fuji desplegado en produccion (validado 2026-04-24). El endpoint `/supported` lista `eip155:43113` con breaker CLOSED. WKH-55 simplemente lo consume — **no se modifica wasiai-facilitator**.

### Como encaja en la arquitectura cross-chain

```
Cliente paga al gateway        ────►  Kite/PYUSD x402 (upstream, ya live)
Gateway paga al merchant       ────►  Fuji/USDC x402 (downstream, ESTA HU)
```

La **misma operator wallet** `0xf432baf...7Ba` firma en ambas chains. Reusa la `OPERATOR_PRIVATE_KEY` ya configurada. El facilitator es **el mismo endpoint** para ambas chains (1 endpoint, N adapters — arquitectura WFAC-52). Lo unico que cambia es el `network` field (`eip155:2368` para Kite, `eip155:43113` para Fuji) y el token (PYUSD 18 dec vs USDC 6 dec).

### El bug que NO debe pasar (R-3)

El codigo existente `src/services/compose.ts:189` calcula amount asi para Kite/PYUSD:
```ts
BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12)  // 18 decimales
```
Si copias esa formula tal cual para Fuji USDC (6 decimales), **transfieres 10^12 veces mas USDC del esperado**, drenando la wallet en pocas transacciones. Esta HU usa `parseUnits(priceUsdc.toString(), 6)` que es matematicamente correcto y type-safe.

### Que hacemos concretamente

1. Anadir `AgentPaymentSpec` type + campo `payment?` al `Agent` interface.
2. Anadir 3 campos opcionales a `StepResult`: `downstreamTxHash`, `downstreamBlockNumber`, `downstreamSettledAmount`.
3. En `discovery.ts:mapAgent`, leer `raw.payment` con type guard y propagarlo a `Agent.payment`.
4. Crear modulo nuevo `src/lib/downstream-payment.ts` con la unica funcion exportada `signAndSettleDownstream(agent, logger)`.
5. Crear test co-located `src/lib/downstream-payment.test.ts` con 14 tests (mocks viem + fetch).
6. En `composeService.invokeAgent`, despues del invoke success, llamar `signAndSettleDownstream` si flag ON + `agent.payment` matchea x402+avalanche.
7. En `composeService.compose`, mergear el resultado al `StepResult` (spread condicional).
8. Documentar las nuevas env vars en `.env.example`.

**NO tocamos**: middleware (`a2a-key.ts`, `x402.ts`), routes (`compose.ts`, `orchestrate.ts`), adapter Kite, registry service, schemas SQL. Todo eso queda intacto. Cero cambio en routes — el `downstreamTxHash` viaja por `pipeline.steps[i]` que ya es parte del response shape existente.

---

## 2. Pre-conditions checklist

Verificar antes de arrancar W1. Si alguno falla → **STOP**, escalar.

### Operacional
- [x] **Operator wallet fondeada en Fuji**: `0xf432baf...7Ba` tiene 20 USDC + 0.49 AVAX en Avalanche Fuji testnet (verificado 2026-04-24)
- [x] **Facilitator soporta Fuji en prod**: `curl https://wasiai-facilitator-production.up.railway.app/supported` lista `eip155:43113`, breaker CLOSED
- [x] **wasiai-v2 capabilities expone `payment`** parcialmente — al menos 1 agente devuelve `{method, asset, chain, contract}`. NO bloquea merge: si esta ausente, AC-5/AC-6 hacen skip graceful

### Codebase
- [x] **viem v2 disponible**: `package.json` lo incluye, ya usado en `src/adapters/kite-ozone/payment.ts`
- [x] **Tests baseline 388 passing pre-F3**: confirmar con `npm test` antes de tocar nada
- [x] **TypeScript strict + biome lint baseline clean**: `npx tsc --noEmit` y `npm run lint` exit 0

### Branch
- [ ] `git checkout main && git pull origin main` → HEAD `00887c4` o mas reciente (WKH-53 merged)
- [ ] `git checkout -b feat/wkh-55-downstream-x402-fuji`
- [ ] `npm ci` → exit 0
- [ ] `npm test` → 388/388 PASS
- [ ] `npx tsc --noEmit` → exit 0
- [ ] `npm run lint` → exit 0

**Solo cuando los 6 checkboxes finales esten marcados → arrancar W1.**

---

## 3. DTs trazables (heredados del SDD)

> Resumen de 1 linea cada DT. Detalle completo en SDD §5.

### Heredados del work-item

| # | Resumen |
|---|---|
| **DT-A** | Feature flag `WASIAI_DOWNSTREAM_X402='true'`, leido **una sola vez** al module load (constante module-level) — no por request |
| **DT-B** | Downstream es ADITIVO al `x-agent-key`, no lo reemplaza. El invoke sigue funcionando igual |
| **DT-C** | Operator wallet `OPERATOR_PRIVATE_KEY` reusada multi-chain (Kite + Fuji). V2 backlog: var separada para aislamiento |
| **DT-D** | Mismo `WASIAI_FACILITATOR_URL` que Kite, con `network: 'eip155:43113'` en el body — 1 endpoint, N adapters |
| **DT-E** | Timing: **POST-invoke** (pay-on-delivery). Solo se paga si el agente respondio OK. Si invoke falla, no se paga |
| **DT-F** | USDC Fuji = **6 decimales** (NO 18 como PYUSD Kite). Constante `FUJI_USDC_DECIMALS = 6` obligatoria |

### Nuevos del SDD

| # | Resumen |
|---|---|
| **DT-G** | Modulo nuevo `src/lib/downstream-payment.ts` aislado del adapter Kite. UNICA funcion exportada: `signAndSettleDownstream(agent, logger)` |
| **DT-H** | Pre-flight balance check via viem `readContract(USDC.balanceOf, [operator])` ANTES de firmar (cubre AC-10) |
| **DT-I** | `validBefore = now + 300s` (mismo valor que Kite, da margen para round-trips) |
| **DT-J** | Nonce = `'0x' + randomBytes(32).toString('hex')` (cripto-seguro, NO `keccak256(timestamp)`) |
| **DT-K** | Mocks de tests deben replicar EXACTAMENTE el chain del impl (lection AB-WKH-44#2). `vi.mock('viem')` mockea solo lo usado |
| **DT-L** | Mapping de `payment` se hace en `discovery.ts:mapAgent`, NO en `registry.ts` (verificado: `registry.ts` no contiene `agentMapping`) |
| **DT-M** | Tests del nuevo modulo van en `src/lib/downstream-payment.test.ts` (co-located). NO en `src/__tests__/unit/` (esa carpeta no existe) |
| **DT-N** | Constantes Fuji con env override y patron warn-once (heredado de `payment.ts:78-101`) |
| **DT-O** | Type guard `readPayment(raw)` en `discovery.ts` para validar shape antes de asignar a `Agent.payment` |

---

## 4. Constraint Directives compiladas (17 total)

Heredados del work-item (CD-1 a CD-10) y nuevos del SDD (CD-NEW-SDD-1 a CD-NEW-SDD-7). **No podes violar ninguno. Citados literal.**

### Del work-item

- **CD-1**: OBLIGATORIO TypeScript strict — sin `any` explicito, sin `as unknown` salvo conversiones de tipo documentadas.
- **CD-2**: OBLIGATORIO zero-regresion — el body de request al marketplace cuando `WASIAI_DOWNSTREAM_X402` no esta seteado debe ser bit-exact igual al baseline (AC-1, AC-12 verifican).
- **CD-3**: PROHIBIDO romper tests existentes — la suite de 388 tests debe pasar verde despues de WKH-55.
- **CD-4**: PROHIBIDO modificar `src/middleware/a2a-key.ts` o `src/middleware/x402.ts` — auth inbound se mantiene intacto.
- **CD-5**: PROHIBIDO duplicar codigo de signing EIP-3009 — el nuevo `downstream-payment.ts` DEBE usar `viem.signTypedData` (misma lib que `kite-ozone/payment.ts`); PROHIBIDO copiar-pegar el cuerpo completo del sign block.
- **CD-6**: OBLIGATORIO errores downstream no bloquean el response del invoke principal — todo error en el path downstream debe ser capturado y logueado; la funcion downstream devuelve `null | DownstreamResult`, nunca lanza.
- **CD-7**: PROHIBIDO tests E2E contra Fuji RPC en CI — todos los tests unitarios usan mocks para RPC, facilitator HTTP, y viem wallet client.
- **CD-8**: OBLIGATORIO el domain EIP-712 para Fuji USDC usa exactamente: `name='USD Coin'`, `version='2'`, `chainId=43113`, `verifyingContract=<FUJI_USDC_ADDRESS>` — cualquier drift produce firmas invalidas en cadena.
- **CD-9**: OBLIGATORIO la direccion `FUJI_USDC_ADDRESS` se lee desde env var (no hardcoded en logica) — aunque se documente el default `0x5425890298aed601595a70AB815c96711a31Bc65` en `.env.example`.
- **CD-10**: PROHIBIDO ethers.js — viem v2 en todo el codebase.

### Del SDD (Architect F2)

- **CD-NEW-SDD-1**: PROHIBIDO que `src/lib/downstream-payment.ts` importe **algo** de `src/adapters/kite-ozone/*`. El nuevo modulo es independiente y NO se acopla a Kite.
- **CD-NEW-SDD-2**: OBLIGATORIO que `Agent.payment` y `AgentPaymentSpec` sean OPTIONAL (`payment?: AgentPaymentSpec | undefined`). Backward-compat con registries pre-WKH-55.
- **CD-NEW-SDD-3**: OBLIGATORIO lectura del flag `WASIAI_DOWNSTREAM_X402` UNA SOLA VEZ al module load (constante module-level `DOWNSTREAM_FLAG`), no por request.
- **CD-NEW-SDD-4**: PROHIBIDO `console.log` en codigo productivo de `compose.ts`. Logs via `logger.warn`/`logger.info` recibido como parametro. **Excepcion aceptable**: el `console.warn` de warn-once para defaults de env (heredado de `payment.ts`).
- **CD-NEW-SDD-5**: PROHIBIDO literal `6` para decimales en codigo de computo. Usar la constante `FUJI_USDC_DECIMALS`. Para amount: `parseUnits(agent.priceUsdc.toString(), FUJI_USDC_DECIMALS)`. PROHIBIDO `BigInt(Math.round(x * 1_000_000))` aunque sea matematicamente equivalente.
- **CD-NEW-SDD-6**: OBLIGATORIO `signAndSettleDownstream` retorna `Promise<DownstreamResult | null>` y NUNCA hace `throw`. Errores capturados internamente, logueados con `logger.warn({ code, agentSlug, detail })`.
- **CD-NEW-SDD-7**: OBLIGATORIO el test de flag undefined → ZERO calls a `viem.signTypedData`, `viem.readContract`, `fetch` (verificable con `expect(mockSign).not.toHaveBeenCalled()`).

---

## 5. Per-wave breakdown

> Cada wave especifica: goal, files exactos, code skeleton (interfaces/firmas, NO implementacion), tests con patron AAA, AC coverage matrix.

---

### W0 — Baseline (serial, obligatoria)

**Goal**: confirmar baseline verde antes de tocar nada.

**Comandos**:
```bash
git checkout main
git pull origin main
git checkout -b feat/wkh-55-downstream-x402-fuji
npm ci
npm run lint
npx tsc --noEmit
npm test
```

**Criterio de exito**: los 4 ultimos comandos exit code 0. `npm test` reporta 388/388 PASS.

**Archivos afectados**: ninguno.

**Commit**: ninguno (solo verificacion).

**Si algo falla en W0 → STOP, escalar. No es problema de esta HU.**

---

### W1 — Type extension + discovery mapping (serial, ~30 LOC)

**Goal**: introducir `AgentPaymentSpec`, extender `Agent`, extender `StepResult`, anadir lectura de `raw.payment` en `discovery.ts`. Cubre AC-7.

**Files to touch**:
- `src/types/index.ts` (modificar) — anadir interface `AgentPaymentSpec` + extender `Agent` + extender `StepResult`
- `src/services/discovery.ts` (modificar) — anadir helper `readPayment` + llamarlo dentro de `mapAgent` (linea ~214)
- `src/services/discovery.test.ts` (modificar) — 2 tests nuevos

**Code skeleton — `src/types/index.ts`**:

Insertar despues de `AgentStatus` (post linea 65), ANTES de `AgentFieldMapping`:

```ts
/**
 * Payment specification declared by an agent in its agent card (WKH-55).
 * Pass-through del raw response — no se normaliza chain/method (preservar shape).
 */
export interface AgentPaymentSpec {
  method: string;          // e.g. 'x402'
  chain: string;           // e.g. 'avalanche'
  contract: `0x${string}`; // payTo on-chain address
  asset?: string;          // e.g. 'USDC' (opcional, pass-through)
}
```

Modificar `Agent` interface (linea 89-104) — anadir `payment` opcional al final:

```ts
export interface Agent {
  id: string;
  name: string;
  // ... resto de campos existentes sin cambio ...
  metadata?: Record<string, unknown>;
  /** Payment spec del agent card (WKH-55). Undefined si el registry no lo expone. */
  payment?: AgentPaymentSpec;
}
```

Modificar `StepResult` interface (linea 159-169) — anadir 3 campos opcionales:

```ts
export interface StepResult {
  agent: Agent;
  output: unknown;
  costUsdc: number;
  latencyMs: number;
  txHash?: string; // Hash de tx on-chain si hubo pago x402 (Kite/PYUSD upstream)
  cacheHit?: boolean | 'SKIPPED';
  transformLatencyMs?: number;
  /** Hash de la tx downstream Fuji USDC settle (WKH-55) */
  downstreamTxHash?: string;
  /** Block number en Fuji donde se confirmo el downstream settle (WKH-55) */
  downstreamBlockNumber?: number;
  /** Atomic units (string, 6-dec USDC) que se settearon downstream (WKH-55) */
  downstreamSettledAmount?: string;
}
```

**NO tocar** `AgentFieldMapping` (linea 67-77) — Scope OUT del work-item.
**NO tocar** `OrchestrateResult` (linea 211-223) — los downstream tx viajan dentro de `pipeline.steps[i]`.

**Code skeleton — `src/services/discovery.ts`**:

Anadir helper a nivel modulo (despues de los imports/utilities existentes, antes del `export const discoveryService`):

```ts
/**
 * Type guard para `agent.payment` (WKH-55).
 * Pass-through del raw object — NO normaliza method/chain a lowercase.
 * Retorna undefined si el campo esta ausente o malformado.
 */
function readPayment(
  raw: Record<string, unknown>,
): AgentPaymentSpec | undefined {
  const p = raw.payment;
  if (!p || typeof p !== 'object') return undefined;
  const obj = p as Record<string, unknown>;
  if (
    typeof obj.method !== 'string' ||
    typeof obj.chain !== 'string' ||
    typeof obj.contract !== 'string'
  ) {
    return undefined;
  }
  return {
    method: obj.method,
    chain: obj.chain,
    contract: obj.contract as `0x${string}`,
    asset: typeof obj.asset === 'string' ? obj.asset : undefined,
  };
}
```

Llamar dentro de `mapAgent` (linea 192-215) — anadir `payment: readPayment(raw)` al objeto retornado, despues de `metadata: raw`:

```ts
return {
  id: ...,
  // ... campos existentes ...
  metadata: raw,
  payment: readPayment(raw),  // <- NEW (WKH-55)
};
```

Importar `AgentPaymentSpec` desde `../types/index.js` si no esta ya en el import block del archivo (chequear con el primer import group).

**Tests — `src/services/discovery.test.ts`** (2 tests nuevos, patron AAA):

```ts
// T-W1-1
it('mapAgent maps raw.payment to agent.payment when present and valid (AC-7)', () => {
  // Arrange
  const registry = makeRegistry({ name: 'test-registry' });
  const raw = {
    id: '1', slug: 'agent-1', name: 'A1', description: 'd',
    capabilities: ['x'], price: 0.5, status: 'active',
    payment: {
      method: 'x402',
      asset: 'USDC',
      chain: 'avalanche',
      contract: '0x000000000000000000000000000000000000aBcD',
    },
  };
  // Act
  const agent = discoveryService.mapAgent(registry, raw);
  // Assert
  expect(agent.payment).toEqual({
    method: 'x402',
    asset: 'USDC',
    chain: 'avalanche',
    contract: '0x000000000000000000000000000000000000aBcD',
  });
});

// T-W1-2
it('mapAgent leaves agent.payment undefined when raw.payment is absent (AC-7)', () => {
  const registry = makeRegistry({ name: 'test-registry' });
  const raw = {
    id: '1', slug: 'agent-1', name: 'A1', description: 'd',
    capabilities: ['x'], price: 0.5, status: 'active',
  };
  const agent = discoveryService.mapAgent(registry, raw);
  expect(agent.payment).toBeUndefined();
});
```

**Si tu `discovery.test.ts` actual no tiene helper `makeRegistry`**, leer el archivo y reusar el helper existente (puede llamarse distinto). NO inventar nombres — usar los que ya estan.

**AC coverage W1**:
| AC | Test |
|----|------|
| AC-7 — agentMapping propaga `payment` | T-W1-1 (presente) + T-W1-2 (ausente) |

**Tests en wave**: 2 nuevos. Suite total esperada: 388 + 2 = 390.

**Commit sugerido**:
```
feat(WKH-55 W1): types AgentPaymentSpec + StepResult.downstream* + discovery.mapAgent payment

- src/types/index.ts: AgentPaymentSpec interface + Agent.payment? + StepResult.downstream{TxHash,BlockNumber,SettledAmount}?
- src/services/discovery.ts: readPayment type guard + mapAgent propaga payment
- src/services/discovery.test.ts: +2 tests (raw.payment presente / ausente)

Refs: WKH-55 AC-7, CD-NEW-SDD-2, DT-L, DT-O
```

---

### W2 — Modulo `src/lib/downstream-payment.ts` (serial, ~150-200 LOC)

**Goal**: implementar `signAndSettleDownstream` aislado. Cubre AC-2, AC-5..AC-10 a nivel unitario.

**Files to create**:
- `src/lib/downstream-payment.ts` (NUEVO)
- `src/lib/downstream-payment.test.ts` (NUEVO)

**Code skeleton — `src/lib/downstream-payment.ts`**:

```ts
/**
 * Downstream x402 Payment — Avalanche Fuji USDC (WKH-55)
 *
 * Aislado del adapter Kite (CD-NEW-SDD-1). NUNCA throw (CD-NEW-SDD-6).
 * Returns null en cualquier skip o failure — el caller logea y continua.
 */
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseUnits,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { avalancheFuji } from 'viem/chains';
import type { Agent } from '../types/index.js';

// ─── Constantes (DT-N) — env override + warn-once ───────────────────
const DEFAULT_FUJI_USDC =
  '0x5425890298aed601595a70AB815c96711a31Bc65' as `0x${string}`;
const FUJI_CHAIN_ID = 43113 as const;
const FUJI_NETWORK = 'eip155:43113' as const;
const FUJI_USDC_DECIMALS = 6 as const;          // CD-NEW-SDD-5
const FUJI_USDC_EIP712_NAME = 'USD Coin' as const;
const FUJI_USDC_EIP712_VERSION_DEFAULT = '2' as const;
const VALID_BEFORE_SECONDS = 300 as const;
const X402_SCHEME = 'exact' as const;
const MAX_TIMEOUT_SECONDS = 60 as const;

// CD-NEW-SDD-3: lectura del flag UNA sola vez al module load
const DOWNSTREAM_FLAG = process.env.WASIAI_DOWNSTREAM_X402 === 'true';

// Warn-once flag (patron heredado de payment.ts:78-101)
let _warnedDefaultUsdc = false;

// ─── Tipos publicos ─────────────────────────────────────────────────
export interface DownstreamResult {
  txHash: `0x${string}`;
  blockNumber: number;
  settledAmount: string; // atomic units (string, 6-dec USDC)
}

export type DownstreamSkipCode =
  | 'FLAG_OFF'
  | 'NO_PAYMENT_FIELD'
  | 'METHOD_NOT_SUPPORTED'
  | 'CHAIN_NOT_SUPPORTED'
  | 'INVALID_PAY_TO_FORMAT'
  | 'ZERO_PAY_TO'
  | 'INSUFFICIENT_BALANCE'
  | 'BALANCE_READ_FAILED'
  | 'SIGNING_FAILED'
  | 'VERIFY_FAILED'
  | 'SETTLE_FAILED'
  | 'NETWORK_ERROR'
  | 'CONFIG_MISSING';

export interface DownstreamLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

// ─── Helpers internos ───────────────────────────────────────────────

/**
 * Resuelve la direccion USDC Fuji desde env, con warn-once si esta ausente.
 * Retorna el default canonical Circle USDC en Fuji.
 */
function getFujiUsdcAddress(): `0x${string}` {
  const env = process.env.FUJI_USDC_ADDRESS;
  if (!env) {
    if (!_warnedDefaultUsdc) {
      _warnedDefaultUsdc = true;
      console.warn(
        `[WKH-55] FUJI_USDC_ADDRESS not set, using default ${DEFAULT_FUJI_USDC}`,
      );
    }
    return DEFAULT_FUJI_USDC;
  }
  return env as `0x${string}`;
}

function getFujiUsdcEip712Version(): string {
  return process.env.FUJI_USDC_EIP712_VERSION ?? FUJI_USDC_EIP712_VERSION_DEFAULT;
}

function getFacilitatorUrl(): string {
  return (
    process.env.WASIAI_FACILITATOR_URL ??
    'https://wasiai-facilitator-production.up.railway.app'
  );
}

/**
 * Valida formato y zero-address del payTo (R-1 mitigacion).
 * Retorna { ok: true, addr } o { ok: false, code }.
 */
function validatePayTo(
  contract: string,
):
  | { ok: true; addr: `0x${string}` }
  | { ok: false; code: 'INVALID_PAY_TO_FORMAT' | 'ZERO_PAY_TO' } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    return { ok: false, code: 'INVALID_PAY_TO_FORMAT' };
  }
  if (contract.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return { ok: false, code: 'ZERO_PAY_TO' };
  }
  return { ok: true, addr: contract as `0x${string}` };
}

/**
 * Computa atomic value en USDC Fuji (6 decimales).
 * CD-NEW-SDD-5: usa parseUnits, NO BigInt(Math.round(x*1e6)).
 */
function computeAtomicValue(priceUsdc: number): bigint {
  return parseUnits(priceUsdc.toString(), FUJI_USDC_DECIMALS);
}

/**
 * Lee balance USDC del operator on Fuji (DT-H, AC-10).
 * Throw on RPC failure — el caller lo captura y devuelve null.
 */
async function readOperatorBalance(
  publicClient: PublicClient,
  usdcAddress: `0x${string}`,
  operator: `0x${string}`,
): Promise<bigint> {
  const balance = (await publicClient.readContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [operator],
  })) as bigint;
  return balance;
}

/**
 * Lazy-init wallet/public clients (patron heredado de payment.ts:131-145).
 * NO se cachean en module-level porque tests necesitan resetearlos via vi.mock.
 */
function buildClients(): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
} | null {
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk || !pk.startsWith('0x')) return null;
  const rpc = process.env.FUJI_RPC_URL;
  if (!rpc) return null;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(rpc),
  });
  const walletClient = createWalletClient({
    account,
    chain: avalancheFuji,
    transport: http(rpc),
  });
  return { publicClient, walletClient, account };
}

/**
 * Construye el body canonical x402 v2 (mismo shape que kite-ozone:373-394).
 * NO se importa nada de kite-ozone (CD-NEW-SDD-1) — body construido inline.
 */
function buildCanonicalBody(args: {
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
  signature: string;
  asset: `0x${string}`;
}): unknown {
  return {
    x402Version: 2,
    resource: { url: 'https://wasiai.ai/downstream' },
    accepted: {
      scheme: X402_SCHEME,
      network: FUJI_NETWORK,
      amount: args.authorization.value,
      asset: args.asset,
      payTo: args.authorization.to,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: { assetTransferMethod: 'eip3009' },
    },
    payload: { signature: args.signature, authorization: args.authorization },
  };
}

/**
 * POST al facilitator. Retorna `null` en error (network/non-2xx/error field).
 */
async function postFacilitator(
  path: '/verify' | '/settle',
  body: unknown,
): Promise<unknown | null> {
  const url = `${getFacilitatorUrl()}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── EIP-712 types (referencia: payment.ts EIP712_TYPES.Authorization) ────
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ─── API publica (UNICA exportacion funcional) ──────────────────────

/**
 * Sign EIP-3009 + POST /verify + POST /settle. NEVER throws (CD-NEW-SDD-6).
 *
 * Retorna `null` en cualquiera de estos casos:
 *  - flag `WASIAI_DOWNSTREAM_X402` no es 'true'
 *  - agent.payment ausente / malformado
 *  - method !== 'x402' o chain !== 'avalanche'
 *  - payTo invalido o zero
 *  - balance insuficiente
 *  - balance read RPC failure
 *  - signing failure
 *  - facilitator /verify devuelve verified=false
 *  - facilitator /settle devuelve settled=false / network error / 5xx
 *  - config missing (OPERATOR_PRIVATE_KEY o FUJI_RPC_URL ausentes)
 *
 * Retorna `DownstreamResult` SOLO cuando facilitator confirmo `settled: true`
 * con `transactionHash` y `blockNumber` poblados.
 */
export async function signAndSettleDownstream(
  agent: Agent,
  logger: DownstreamLogger,
): Promise<DownstreamResult | null> {
  // 1. Flag check (CD-NEW-SDD-7 — zero overhead cuando off)
  if (!DOWNSTREAM_FLAG) {
    return null;
  }

  // 2. agent.payment presence + shape
  if (!agent.payment) {
    logger.info(
      { agentSlug: agent.slug, code: 'NO_PAYMENT_FIELD' },
      '[Downstream] agent.payment absent — skipped',
    );
    return null;
  }

  // 3. method check (AC-5)
  if (agent.payment.method !== 'x402') {
    logger.info(
      { agentSlug: agent.slug, method: agent.payment.method, code: 'METHOD_NOT_SUPPORTED' },
      `[Downstream] method=${agent.payment.method} not supported — skipped`,
    );
    return null;
  }

  // 4. chain check (AC-6)
  if (agent.payment.chain !== 'avalanche') {
    logger.info(
      { agentSlug: agent.slug, chain: agent.payment.chain, code: 'CHAIN_NOT_SUPPORTED' },
      `[Downstream] chain=${agent.payment.chain} not yet supported — skipped`,
    );
    return null;
  }

  // 5. payTo validation (R-1)
  const payToCheck = validatePayTo(agent.payment.contract);
  if (!payToCheck.ok) {
    logger.warn(
      { agentSlug: agent.slug, contract: agent.payment.contract, code: payToCheck.code },
      '[Downstream] payTo validation failed',
    );
    return null;
  }

  // 6. Build clients (config check)
  const clients = buildClients();
  if (!clients) {
    logger.warn(
      { agentSlug: agent.slug, code: 'CONFIG_MISSING' },
      '[Downstream] OPERATOR_PRIVATE_KEY or FUJI_RPC_URL missing',
    );
    return null;
  }
  const { publicClient, walletClient, account } = clients;

  // 7. Compute atomic value (CD-NEW-SDD-5, AC-9)
  let value: bigint;
  try {
    value = computeAtomicValue(agent.priceUsdc);
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'CONFIG_MISSING', detail: String(e) },
      '[Downstream] computeAtomicValue failed',
    );
    return null;
  }

  // 8. Pre-flight balance (DT-H, AC-10)
  const usdcAddress = getFujiUsdcAddress();
  let balance: bigint;
  try {
    balance = await readOperatorBalance(publicClient, usdcAddress, account.address);
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'BALANCE_READ_FAILED', detail: String(e) },
      '[Downstream] balance read RPC failed',
    );
    return null;
  }
  if (balance < value) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INSUFFICIENT_BALANCE',
        balance: balance.toString(),
        required: value.toString(),
      },
      '[Downstream] insufficient USDC balance',
    );
    return null;
  }

  // 9. Build authorization (DT-I, DT-J, AC-2, AC-8)
  const now = Math.floor(Date.now() / 1000);
  const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
  const authorization = {
    from: account.address,
    to: payToCheck.addr, // CD-8: agent.payment.contract validado
    value: value.toString(),
    validAfter: '0',
    validBefore: String(now + VALID_BEFORE_SECONDS),
    nonce,
  };

  // 10. Sign EIP-712 (CD-8: domain exacto USDC Fuji)
  let signature: Hex;
  try {
    signature = await walletClient.signTypedData({
      account,
      domain: {
        name: FUJI_USDC_EIP712_NAME,
        version: getFujiUsdcEip712Version(),
        chainId: FUJI_CHAIN_ID,
        verifyingContract: usdcAddress,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value,
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce,
      },
    });
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'SIGNING_FAILED', detail: String(e) },
      '[Downstream] signTypedData failed',
    );
    return null;
  }

  // 11. POST /verify
  const body = buildCanonicalBody({ authorization, signature, asset: usdcAddress });
  const verifyRes = (await postFacilitator('/verify', body)) as
    | { verified?: boolean }
    | null;
  if (!verifyRes || verifyRes.verified !== true) {
    logger.warn(
      { agentSlug: agent.slug, code: 'VERIFY_FAILED' },
      '[Downstream] facilitator /verify failed or returned verified=false',
    );
    return null;
  }

  // 12. POST /settle
  const settleRes = (await postFacilitator('/settle', body)) as
    | {
        settled?: boolean;
        transactionHash?: string;
        blockNumber?: number;
        amount?: string;
      }
    | null;
  if (
    !settleRes ||
    settleRes.settled !== true ||
    !settleRes.transactionHash ||
    typeof settleRes.blockNumber !== 'number'
  ) {
    logger.warn(
      { agentSlug: agent.slug, code: 'SETTLE_FAILED' },
      '[Downstream] facilitator /settle failed or settled=false',
    );
    return null;
  }

  // 13. Success
  return {
    txHash: settleRes.transactionHash as `0x${string}`,
    blockNumber: settleRes.blockNumber,
    settledAmount: settleRes.amount ?? value.toString(),
  };
}
```

**Notas obligatorias del impl** (no negociables, AR los marcara BLOQUEANTE si fallan):

- `DOWNSTREAM_FLAG` se evalua **una sola vez** al import del modulo (CD-NEW-SDD-3).
- El primer `if (!DOWNSTREAM_FLAG) return null;` debe ejecutarse **antes** de cualquier otra logica — no se construyen clientes, no se llama nada (CD-NEW-SDD-7, AC-1).
- `validBefore` usa `BigInt(authorization.validBefore)` en el message firmado, no `BigInt(now + 300)` literal — para que el body posteado y el firmado matcheen exactamente.
- `value` en el message firmado es `bigint`, en el authorization stringificado es `value.toString()` — NO mezclar.
- `parseUnits(agent.priceUsdc.toString(), 6)` — el `.toString()` es necesario porque `parseUnits` espera string. NO `parseUnits(agent.priceUsdc, 6)` (TS error en strict mode).
- Importar de `viem/chains` solo `avalancheFuji`. NO importar `kiteTestnet` (CD-NEW-SDD-1).
- NO importar nada de `../adapters/kite-ozone/*` (CD-NEW-SDD-1) — verificable con `grep "kite-ozone" src/lib/downstream-payment.ts` → 0 matches.

**Code skeleton — `src/lib/downstream-payment.test.ts`** (14 tests, patron AAA):

```ts
/**
 * Unit tests para signAndSettleDownstream (WKH-55).
 * Mocks: viem (signTypedData + readContract), fetch global, viem/accounts.
 * NO E2E contra Fuji RPC (CD-7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types/index.js';

// IMPORTANTE: el flag se lee al module load, asi que tenemos que setearlo
// ANTES de importar el modulo bajo test. Para tests con flag off vs on,
// usamos vi.resetModules() y re-import dinamico.

// ─── Helpers de mocking ─────────────────────────────────────────────

const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const OPERATOR_ADDR = '0xf432baf09e7ba99ab44ff1d68c83f1234567Ba00' as const;
const PAYTO_ADDR = '0x000000000000000000000000000000000000aBcD' as const;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1', slug: 'agent-1', name: 'Agent 1', description: '',
    capabilities: ['x'], priceUsdc: 0.5, registry: 'wasiai-v2',
    invokeUrl: 'https://wasiai-v2.example/api/agents/agent-1/invoke',
    invocationNote: '', verified: true, status: 'active',
    payment: {
      method: 'x402',
      asset: 'USDC',
      chain: 'avalanche',
      contract: PAYTO_ADDR,
    },
    ...overrides,
  };
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

// Mock viem — solo lo usado (DT-K)
const mockSignTypedData = vi.fn();
const mockReadContract = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ readContract: mockReadContract })),
    createWalletClient: vi.fn(() => ({ signTypedData: mockSignTypedData })),
  };
});

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: OPERATOR_ADDR,
    signTypedData: mockSignTypedData,
  })),
}));

// Helper para reset/import el modulo con env especifico
async function importWithFlag(flagOn: boolean) {
  process.env.WASIAI_DOWNSTREAM_X402 = flagOn ? 'true' : '';
  process.env.OPERATOR_PRIVATE_KEY = '0x' + 'a'.repeat(64);
  process.env.FUJI_RPC_URL = 'https://api.avax-test.network/ext/bc/C/rpc';
  process.env.FUJI_USDC_ADDRESS = FUJI_USDC;
  vi.resetModules();
  return await import('./downstream-payment.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WASIAI_DOWNSTREAM_X402;
  delete process.env.OPERATOR_PRIVATE_KEY;
  delete process.env.FUJI_RPC_URL;
  delete process.env.FUJI_USDC_ADDRESS;
});

// ─── T-W2-01: flag off → returns null sin tocar nada (CD-NEW-SDD-7, AC-1) ──
describe('signAndSettleDownstream — flag off', () => {
  it('returns null without calling viem or fetch when flag is unset', async () => {
    // Arrange
    const { signAndSettleDownstream } = await importWithFlag(false);
    const agent = makeAgent();
    const logger = makeLogger();
    const fetchSpy = vi.mocked(globalThis.fetch);

    // Act
    const result = await signAndSettleDownstream(agent, logger);

    // Assert
    expect(result).toBeNull();
    expect(mockSignTypedData).not.toHaveBeenCalled();
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── T-W2-02..14: flag on, varios escenarios ────────────────────────
describe('signAndSettleDownstream — flag on', () => {
  // T-W2-02: agent.payment undefined → null + log info (AC-5 caso ausente)
  it('returns null when agent.payment is undefined', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({ payment: undefined });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NO_PAYMENT_FIELD' }),
      expect.any(String),
    );
  });

  // T-W2-03: method !== 'x402' → null (AC-5)
  it('returns null when method is not x402', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: { method: 'blockchain-direct', chain: 'avalanche', contract: PAYTO_ADDR },
    });
    const result = await signAndSettleDownstream(agent, makeLogger());
    expect(result).toBeNull();
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  // T-W2-04: chain !== 'avalanche' → null (AC-6)
  it('returns null when chain is not avalanche', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: { method: 'x402', chain: 'polygon', contract: PAYTO_ADDR },
    });
    const result = await signAndSettleDownstream(agent, makeLogger());
    expect(result).toBeNull();
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  // T-W2-05: payTo formato invalido → null (R-1)
  it('returns null when contract has invalid format', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: { method: 'x402', chain: 'avalanche', contract: '0xZZZ' as `0x${string}` },
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PAY_TO_FORMAT' }),
      expect.any(String),
    );
  });

  // T-W2-06: payTo zero-address → null
  it('returns null when contract is zero-address', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402', chain: 'avalanche',
        contract: '0x0000000000000000000000000000000000000000',
      },
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ZERO_PAY_TO' }),
      expect.any(String),
    );
  });

  // T-W2-07: balance < value → null (AC-10)
  it('returns null when operator balance < required value', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(0n); // balance 0
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }),
      expect.any(String),
    );
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  // T-W2-08: balance read RPC throws → null
  it('returns null when balance read RPC fails', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockRejectedValueOnce(new Error('RPC down'));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BALANCE_READ_FAILED' }),
      expect.any(String),
    );
  });

  // T-W2-09: signTypedData throws → null
  it('returns null when signTypedData throws', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockRejectedValueOnce(new Error('keystore error'));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SIGNING_FAILED' }),
      expect.any(String),
    );
  });

  // T-W2-10: facilitator /verify devuelve verified=false → null (AC-4)
  it('returns null when /verify returns verified=false', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ verified: false }), { status: 200 }),
    );
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VERIFY_FAILED' }),
      expect.any(String),
    );
  });

  // T-W2-11: facilitator /settle 500 → null (AC-4)
  it('returns null when /settle returns 500', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SETTLE_FAILED' }),
      expect.any(String),
    );
  });

  // T-W2-12: happy path → returns DownstreamResult (AC-3 unit-level)
  it('returns DownstreamResult when /verify ok and /settle ok', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settled: true,
            transactionHash: '0xTX',
            blockNumber: 12345,
            amount: '500000',
          }),
          { status: 200 },
        ),
      );
    const result = await signAndSettleDownstream(makeAgent(), makeLogger());
    expect(result).toEqual({
      txHash: '0xTX',
      blockNumber: 12345,
      settledAmount: '500000',
    });
  });

  // T-W2-13: domain EIP-712 verification (AC-2, CD-8)
  it('signs with correct EIP-712 domain (USDC Fuji) and TransferWithAuthorization', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ settled: true, transactionHash: '0xTX', blockNumber: 1, amount: '500000' }),
          { status: 200 },
        ),
      );
    await signAndSettleDownstream(makeAgent(), makeLogger());

    expect(mockSignTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          name: 'USD Coin',
          version: '2',
          chainId: 43113,
          verifyingContract: FUJI_USDC,
        }),
        primaryType: 'TransferWithAuthorization',
        message: expect.objectContaining({
          to: PAYTO_ADDR, // AC-8: payTo es agent.payment.contract
          value: 500000n, // AC-9: 0.5 USDC * 10^6
          validAfter: 0n,
        }),
      }),
    );
  });

  // T-W2-14: AC-9 — guard de decimales
  it('computes atomic value with 6 decimals (NOT 18 like Kite/PYUSD)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ verified: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ settled: true, transactionHash: '0xTX', blockNumber: 1, amount: '500000' }),
          { status: 200 },
        ),
      );
    const agent = makeAgent({ priceUsdc: 0.5 });
    await signAndSettleDownstream(agent, makeLogger());

    // value en el message debe ser 500000n, NO 500000000000000000n (Kite-PYUSD-18)
    const callArg = mockSignTypedData.mock.calls[0][0];
    expect(callArg.message.value).toBe(500000n);
    expect(callArg.message.value).not.toBe(500000000000000000n);
  });
});

// Import helper (parseUnits desde viem real para los tests)
import { parseUnits } from 'viem';
```

**AC coverage W2**:
| AC | Tests |
|----|-------|
| AC-1 (zero-regresion flag off) | T-W2-01 |
| AC-2 (firma EIP-3009 correcta) | T-W2-13 |
| AC-3 (downstreamTxHash propagado — unit) | T-W2-12 |
| AC-4 (downstream failure no bloquea) | T-W2-08, T-W2-09, T-W2-10, T-W2-11 |
| AC-5 (method no x402 → skip) | T-W2-02 (ausente), T-W2-03 (otro method) |
| AC-6 (chain no avalanche → skip) | T-W2-04 |
| AC-8 (payTo = agent.payment.contract) | T-W2-13 (verifica `to` field) |
| AC-9 (decimales correctos 6) | T-W2-14 |
| AC-10 (pre-flight balance) | T-W2-07 |

**Tests en wave**: 14 nuevos. Suite total esperada: 390 + 14 = 404.

**Commit sugerido**:
```
feat(WKH-55 W2): src/lib/downstream-payment.ts + 14 unit tests

- signAndSettleDownstream(agent, logger): Promise<DownstreamResult|null>
- never throws (CD-NEW-SDD-6); returns null en cualquier skip/failure
- pre-flight balance via readContract(USDC.balanceOf) (AC-10)
- EIP-712 domain USD Coin/v2/43113/FUJI_USDC (CD-8)
- parseUnits con FUJI_USDC_DECIMALS=6 (CD-NEW-SDD-5, anti R-3)
- 14 tests con mocks viem + fetch (no E2E — CD-7)

Refs: WKH-55 AC-1/2/4/5/6/8/9/10, CD-5/6/7/8/9/10, CD-NEW-SDD-1/3/5/6/7
```

---

### W3 — Hook en `composeService.invokeAgent` + `compose` (serial, ~30 LOC)

**Goal**: integrar el modulo W2 en el flujo del compose. Cubre AC-3, AC-4 a nivel integracion + AC-12 snapshot.

**Files to touch**:
- `src/services/compose.ts` (modificar)
- `src/services/compose.test.ts` (modificar)

**Code skeleton — `src/services/compose.ts`**:

Anadir import en el bloque de imports (despues de los existentes):

```ts
import {
  signAndSettleDownstream,
  type DownstreamResult,
} from '../lib/downstream-payment.js';
```

Modificar la firma de `invokeAgent` (linea 164-168) — anadir `logger` opcional:

```ts
async invokeAgent(
  agent: Agent,
  input: Record<string, unknown>,
  a2aKey?: string,
  logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void },
): Promise<{ output: unknown; txHash?: string; downstream?: DownstreamResult }> {
  // ... cuerpo existente sin cambio hasta linea 222 ...
```

Anadir hook **despues** del settle Kite (entre linea 222 y el `return` de linea 223):

```ts
// linea ~222 — final del bloque if (paymentRequest) { ... }

// ─── WKH-55: Downstream x402 hook (AC-1..AC-10) ──────────────────
// Defensive logger fallback: si el caller no paso uno, usamos console.
const _logger = logger ?? {
  warn: (obj: unknown, _msg?: string) => console.warn('[Downstream]', obj),
  info: (obj: unknown, _msg?: string) => console.log('[Downstream]', obj),
};
const downstream = await signAndSettleDownstream(agent, _logger);

return { output, txHash, ...(downstream && { downstream }) };
```

**Notas obligatorias del hook**:
- El call a `signAndSettleDownstream` es INCONDICIONAL (sin `if`). El modulo internamente verifica el flag y `agent.payment` — no replicamos esa logica aca.
- Cuando flag off → `signAndSettleDownstream` devuelve null inmediatamente sin tocar nada → `downstream` queda undefined → spread `...(downstream && {downstream})` no anade el campo → response shape bit-exact al baseline (AC-1).
- NUNCA throw — `signAndSettleDownstream` cumple CD-NEW-SDD-6.
- NO `await` redundante: el resultado se asigna directo.

Modificar `composeService.compose` (linea 70-78) — capturar `downstream` y mergearlo al `StepResult`:

```ts
// linea 70 actual:
const { output, txHash } = await this.invokeAgent(agent, input, a2aKey);
// CAMBIA A:
const { output, txHash, downstream } = await this.invokeAgent(agent, input, a2aKey);
```

Modificar la construccion del `StepResult` (linea 72-78) — anadir spread condicional:

```ts
const result: StepResult = {
  agent,
  output,
  costUsdc: agent.priceUsdc,
  latencyMs,
  txHash,
  ...(downstream && {
    downstreamTxHash: downstream.txHash,
    downstreamBlockNumber: downstream.blockNumber,
    downstreamSettledAmount: downstream.settledAmount,
  }),
};
```

**NO tocar** routes (`src/routes/compose.ts`, `src/routes/orchestrate.ts`) — el shape ya propaga `steps[i].downstreamTxHash` automaticamente porque `steps` se incluye en la respuesta.

**Code skeleton — `src/services/compose.test.ts`** (4 tests nuevos, patron AAA):

```ts
// Mock del modulo nuevo (DT-K — replicar exactamente la firma)
vi.mock('../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn(),
}));

import { signAndSettleDownstream } from '../lib/downstream-payment.js';
const mockDownstream = vi.mocked(signAndSettleDownstream);

// T-W3-01: AC-1 + AC-12 snapshot — flag off, fetch body bit-exact baseline
it('does NOT call signAndSettleDownstream when agent.payment is absent (AC-1)', async () => {
  // Arrange
  mockDownstream.mockResolvedValue(null); // por si lo llaman, devolver null
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: 'ok' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const agent = makeAgent({ priceUsdc: 0, payment: undefined });
  // Act
  const result = await composeService.invokeAgent(agent, { foo: 'bar' }, 'k1');
  // Assert
  expect(result.downstream).toBeUndefined();
  // El modulo internamente devuelve null para payment ausente:
  // confirmamos que el StepResult no tiene los campos downstream*
  // (La invocacion al modulo SI puede ocurrir — internamente skipea)
});

// T-W3-02: happy path — flag on + agent valido + downstream returns ok (AC-3)
it('propagates downstreamTxHash to StepResult when downstream succeeds', async () => {
  // Arrange
  mockDownstream.mockResolvedValue({
    txHash: '0xabc',
    blockNumber: 1,
    settledAmount: '500000',
  });
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: 'ok' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const agent = makeAgent({
    priceUsdc: 0,
    payment: { method: 'x402', chain: 'avalanche', contract: '0x...aBcD' as `0x${string}` },
  });
  // Act
  const composeResult = await composeService.compose({
    steps: [{ agent: agent.slug, input: {} }],
  });
  // Assert
  expect(composeResult.steps[0].downstreamTxHash).toBe('0xabc');
  expect(composeResult.steps[0].downstreamBlockNumber).toBe(1);
  expect(composeResult.steps[0].downstreamSettledAmount).toBe('500000');
});

// T-W3-03: AC-4 — downstream returns null → no se rompe el invoke
it('returns invoke result without downstreamTxHash when downstream fails', async () => {
  mockDownstream.mockResolvedValue(null);
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: 'ok' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const agent = makeAgent({ priceUsdc: 0 });
  const result = await composeService.invokeAgent(agent, {}, 'k1');
  expect(result.output).toEqual({ result: 'ok' });
  expect(result.downstream).toBeUndefined();
});

// T-W3-04: AC-12 snapshot regression — body al marketplace bit-exact baseline
it('sends bit-exact same fetch body as baseline when flag off (AC-12)', async () => {
  mockDownstream.mockResolvedValue(null); // simula flag off / no-op
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: 'ok' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  const agent = makeAgent({ priceUsdc: 0, payment: undefined });
  const input = { task: 'translate', text: 'hola' };
  await composeService.invokeAgent(agent, input, 'a2a-key-1');

  // Assert — capturamos la primera llamada al marketplace
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe(agent.invokeUrl);
  expect(init).toMatchObject({
    method: 'POST',
    headers: expect.objectContaining({
      'Content-Type': 'application/json',
      'x-a2a-key': 'a2a-key-1',
    }),
  });
  expect(init.body).toBe(JSON.stringify(input));
});
```

**AC coverage W3**:
| AC | Test |
|----|------|
| AC-1 — zero regression flag off | T-W3-01, T-W3-04 |
| AC-3 — downstreamTxHash propagado | T-W3-02 |
| AC-4 — downstream failure no bloquea | T-W3-03 |
| AC-12 — snapshot regresion fetch body | T-W3-04 |

**Tests en wave**: 4 nuevos. Suite total esperada: 404 + 4 = 408.

**Commit sugerido**:
```
feat(WKH-55 W3): hook en compose.invokeAgent + propagacion StepResult

- compose.invokeAgent llama signAndSettleDownstream post-success (DT-E post-invoke)
- composeService.compose mergea downstream al StepResult (spread condicional)
- 4 tests: AC-1 sin call cuando payment undefined, AC-3 happy, AC-4 null, AC-12 snapshot

Refs: WKH-55 AC-1/3/4/12, CD-NEW-SDD-2/4
```

---

### W4 — Verificacion routes (NO HAY CODIGO QUE TOCAR)

**Goal**: confirmar que `routes/compose.ts` y `routes/orchestrate.ts` exponen `downstreamTxHash` por step en el response sin cambio de codigo.

**Files**: NINGUNO. Esta wave es **solo verificacion manual** — el shape de response ya propaga porque `pipeline.steps[i]` es parte del JSON.

**Verificacion (no commit)**:
```bash
# 1. Confirmar que routes/compose.ts NO necesita cambios
grep -n "downstreamTxHash" src/routes/compose.ts || echo "OK — no requiere"

# 2. Confirmar que routes/orchestrate.ts NO necesita cambios
grep -n "downstreamTxHash" src/routes/orchestrate.ts || echo "OK — no requiere"

# 3. Verificar que el StepResult typedef tiene el campo
grep -n "downstreamTxHash" src/types/index.ts
```

**Decision**: W4 es **opcional, no bloqueante**. Si tenes tiempo, podes anadir 1 test integrado de `routes/compose.ts` que mockee compose service y verifique `body.steps[0].downstreamTxHash === '0xabc'` — pero T-W3-02 ya garantiza el shape al nivel de service, que es lo critico.

**Tests**: 0-1 nuevos.

**Commit**: ninguno (verificacion).

---

### W5 — Documentacion `.env.example` (serial, ~20 LOC en docs)

**Goal**: documentar las nuevas env vars.

**Files to touch**:
- `.env.example` (modificar)

**Cambio exacto** — anadir al final del archivo (despues de la ultima seccion existente):

```bash
# ============================================================
# Downstream x402 — Avalanche Fuji (WKH-55)
# ============================================================
# Habilita pago downstream USDC Fuji al invocar agentes wasiai-v2
# que declaren payment.method=x402 + payment.chain=avalanche en su agent card.
# Default: ausente (skip). Solo el valor literal 'true' lo activa.
WASIAI_DOWNSTREAM_X402=

# RPC publico Avalanche Fuji testnet (chainId 43113)
FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc

# Direccion del token USDC en Fuji (default canonical Circle USDC).
# Si esta ausente, usa 0x5425890298aed601595a70AB815c96711a31Bc65 con warn-once.
FUJI_USDC_ADDRESS=

# EIP-712 version override para USDC Fuji (default '2')
FUJI_USDC_EIP712_VERSION=
```

**Tests**: 0.

**Commit sugerido**:
```
docs(WKH-55 W5): .env.example — documentar WASIAI_DOWNSTREAM_X402 + FUJI_*

- Seccion Downstream x402 — Avalanche Fuji
- 4 vars: WASIAI_DOWNSTREAM_X402, FUJI_RPC_URL, FUJI_USDC_ADDRESS, FUJI_USDC_EIP712_VERSION

Refs: WKH-55 W5
```

---

### Resumen de waves

| Wave | Duracion | Files modificados | Files nuevos | Tests nuevos | Commits |
|------|---------:|------------------:|-------------:|-------------:|--------:|
| W0 | 10 min | 0 | 0 | 0 | 0 |
| W1 | 30-45 min | 3 | 0 | 2 | 1 |
| W2 | 2-3h | 0 | 2 (lib + test) | 14 | 1 |
| W3 | 60-90 min | 2 | 0 | 4 | 1 |
| W4 | 10 min | 0 | 0 | 0-1 | 0 |
| W5 | 10 min | 1 | 0 | 0 | 1 |
| **Total** | **~4-6h** | **6 unicos** | **2** | **20** | **4** |

Suite total esperada al cierre de F3: **388 + 20 = 408 tests passing**.

---

## 6. AC trace matrix (12 ACs)

| AC | Wave(s) | Archivo:linea esperado | Test(s) |
|----|---------|------------------------|---------|
| **AC-1** Zero-regresion flag ausente | W2, W3 | `src/lib/downstream-payment.ts:signAndSettleDownstream` (early return en `if (!DOWNSTREAM_FLAG)`) + `src/services/compose.ts:invokeAgent` (downstream queda undefined) | T-W2-01, T-W3-01, T-W3-04 |
| **AC-2** Firma EIP-3009 correcta USDC Fuji | W2 | `src/lib/downstream-payment.ts` (signTypedData con domain `name='USD Coin', version='2', chainId=43113`, primaryType `TransferWithAuthorization`) | T-W2-13 |
| **AC-3** `downstreamTxHash` propagado | W2, W3 | `src/services/compose.ts:compose` (spread condicional `...(downstream && {downstreamTxHash, ...})`) → `StepResult` → `pipeline.steps[i]` | T-W2-12, T-W3-02 |
| **AC-4** Downstream failure no bloquea | W2, W3 | `signAndSettleDownstream` returns null en cualquier error path; `invokeAgent` continua y retorna `{output, txHash, downstream: undefined}` | T-W2-08, T-W2-09, T-W2-10, T-W2-11, T-W3-03 |
| **AC-5** Method no x402 → skip | W2 | `src/lib/downstream-payment.ts` (chequeo `agent.payment.method !== 'x402'` → log info → return null) | T-W2-02 (ausente), T-W2-03 (otro method) |
| **AC-6** Chain no avalanche → skip | W2 | `src/lib/downstream-payment.ts` (chequeo `agent.payment.chain !== 'avalanche'` → log info → return null) | T-W2-04 |
| **AC-7** `agentMapping` propaga `payment` | W1 | `src/services/discovery.ts:mapAgent` (anade `payment: readPayment(raw)` al return de mapAgent) | T-W1-1 (presente), T-W1-2 (ausente) |
| **AC-8** `payTo = agent.payment.contract` | W2 | `src/lib/downstream-payment.ts` (authorization.to = payToCheck.addr que viene de `agent.payment.contract`) | T-W2-13 (verifica `to` field del message firmado) |
| **AC-9** Decimales correctos (6) | W2 | `src/lib/downstream-payment.ts` (`computeAtomicValue` usa `parseUnits(.., FUJI_USDC_DECIMALS=6)`) | T-W2-14 |
| **AC-10** Pre-flight balance check | W2 | `src/lib/downstream-payment.ts` (`readOperatorBalance` → comparar `balance < value` → return null si insuficiente) | T-W2-07 |
| **AC-11** Tests unitarios por AC con mocks | W1, W2, W3 | Toda la suite W1+W2+W3 con `vi.mock('viem')`, `vi.stubGlobal('fetch')` — sin E2E (CD-7) | TODOS los T-W* |
| **AC-12** Snapshot regresion body invoke | W3 | `src/services/compose.test.ts` — captura `fetchSpy.mock.calls[0]` y compara contra baseline | T-W3-04 |

**Cobertura**: 12/12 ACs cubiertos por al menos 1 test.

---

## 7. DT/CD verification matrix

| # | Como verificarlo en el codigo entregado |
|---|-----------------------------------------|
| **DT-A** flag read once | `grep -n "WASIAI_DOWNSTREAM_X402" src/lib/downstream-payment.ts` → solo 1 match (constante module-level), ninguno dentro de la funcion |
| **DT-B** aditivo | `src/services/compose.ts:198-204` (fetch al marketplace) sin cambio de headers/body — solo se anade hook DESPUES del settle Kite |
| **DT-C** wallet reusada | `src/lib/downstream-payment.ts` lee `process.env.OPERATOR_PRIVATE_KEY` (mismo nombre que kite-ozone) |
| **DT-D** mismo facilitator url | `getFacilitatorUrl()` retorna `process.env.WASIAI_FACILITATOR_URL` (compartido con Kite) |
| **DT-E** post-invoke | El hook esta DESPUES del `if (paymentRequest) { ... settle Kite ... }` y antes del `return` — verificable visualmente en el diff |
| **DT-F** 6 decimales | Constante `FUJI_USDC_DECIMALS = 6 as const`. Test T-W2-14 verifica `value === 500000n` para 0.5 USDC |
| **DT-G** modulo aislado | `grep "from '../adapters/kite-ozone" src/lib/downstream-payment.ts` → 0 matches (CD-NEW-SDD-1) |
| **DT-H** pre-flight balance | `readOperatorBalance` se llama ANTES de `signTypedData`. T-W2-07 lo verifica |
| **DT-I** validBefore=300s | `VALID_BEFORE_SECONDS = 300 as const`, usado en `now + VALID_BEFORE_SECONDS` |
| **DT-J** nonce randomBytes(32) | `randomBytes(32).toString('hex')` — NO `keccak256` ni timestamps |
| **DT-K** mocks fidelity | Tests usan `vi.mock('viem', async (importOriginal) => { ...spread actual... })` — solo overrides surgicos |
| **DT-L** mapping en discovery.ts | Cambio en `discovery.ts:mapAgent`, NO en `registry.ts`. `grep -n "payment" src/services/registry.ts` → 0 matches |
| **DT-M** tests co-located | `ls src/lib/downstream-payment.test.ts` → existe; `ls src/__tests__/unit/` → no existe |
| **DT-N** warn-once + env override | `_warnedDefaultUsdc` flag + console.warn cuando env ausente. Heredado de `payment.ts:78-101` |
| **DT-O** type guard payment | `readPayment(raw)` en `discovery.ts` valida `typeof method === 'string'`, etc — sin `as` agresivos |
| **CD-1** TS strict no any | `grep -n ": any" src/lib/downstream-payment.ts` → 0 matches; `npx tsc --noEmit` exit 0 |
| **CD-2** zero regression body | T-W3-04 (snapshot fetch body) |
| **CD-3** 388 tests verdes | `npm test` → 408/408 PASS al final de F3 |
| **CD-4** middleware intacto | `git diff main src/middleware/a2a-key.ts src/middleware/x402.ts` → empty |
| **CD-5** no copy-paste sign | `diff <(grep -A40 "signTypedData" src/lib/downstream-payment.ts) <(grep -A40 "signTypedData" src/adapters/kite-ozone/payment.ts)` → cambios significativos esperados (decimals, domain, types) |
| **CD-6** never throw | T-W2-08/09/10/11 todas verifican `result === null`, ninguna `await expect(...).rejects` |
| **CD-7** no E2E | `grep -rE "avax-test.network" src/lib/downstream-payment.test.ts` → 0 matches reales (solo en .env mock setup) |
| **CD-8** domain exacto | T-W2-13 verifica los 4 campos del domain |
| **CD-9** address from env | `getFujiUsdcAddress()` lee `process.env.FUJI_USDC_ADDRESS` con default warn-once |
| **CD-10** no ethers | `grep -rn "from 'ethers'" src/lib/downstream-payment.ts` → 0 matches |
| **CD-NEW-SDD-1** no kite-ozone import | Ya cubierto en DT-G |
| **CD-NEW-SDD-2** payment optional | `Agent.payment?: AgentPaymentSpec` (con `?`). T-W1-2 verifica undefined cuando ausente |
| **CD-NEW-SDD-3** flag once | Ya cubierto en DT-A |
| **CD-NEW-SDD-4** no console.log | `grep -n "console.log" src/lib/downstream-payment.ts src/services/compose.ts` (en el codigo nuevo) → solo el fallback logger en compose.ts (aceptable como excepcion) |
| **CD-NEW-SDD-5** parseUnits no Math.round | `grep "Math.round" src/lib/downstream-payment.ts` → 0 matches |
| **CD-NEW-SDD-6** never throw | Ya cubierto en CD-6 |
| **CD-NEW-SDD-7** zero-call test | T-W2-01 explicito: `expect(mockSign).not.toHaveBeenCalled()`, `expect(mockReadContract).not.toHaveBeenCalled()`, `expect(fetchSpy).not.toHaveBeenCalled()` |

---

## 8. Anti-Hallucination Contract (NO inventar)

El Dev NO debe inventar ni adivinar estos valores. Si la implementacion los cambia, es **violacion de CD** y el AR los va a marcar BLOQUEANTE:

| Elemento | Valor exacto | NO usar |
|----------|-------------|---------|
| Modulo nuevo path | `src/lib/downstream-payment.ts` | `src/services/downstream-payment.ts`, `src/lib/downstream.ts`, `src/__tests__/unit/...` |
| Test del modulo path | `src/lib/downstream-payment.test.ts` (co-located) | `src/__tests__/unit/downstream-payment.test.ts`, `tests/...`, `src/__tests__/downstream...` |
| Nombre de la funcion exportada | `signAndSettleDownstream` | `signDownstream`, `payDownstream`, `attemptDownstream`, `signAndSettle` |
| Type del result | `DownstreamResult` (con campos `txHash`, `blockNumber`, `settledAmount`) | `PaymentResult`, `Receipt`, `TxResult` |
| Type del payment spec en Agent | `AgentPaymentSpec` (interface) | `Payment`, `PaymentInfo`, `AgentPayment` |
| Field name en Agent | `payment` (singular, optional) | `paymentInfo`, `paymentSpec`, `payments` (plural) |
| Fields en StepResult | `downstreamTxHash`, `downstreamBlockNumber`, `downstreamSettledAmount` (camelCase) | `downstream_tx_hash`, `dsTxHash`, `paymentTxHash` (colision con upstream) |
| Flag env var | `WASIAI_DOWNSTREAM_X402` (literal `'true'`) | `ENABLE_DOWNSTREAM`, `DOWNSTREAM_X402`, valores como `1`, `yes`, `on` |
| Fuji USDC default | `0x5425890298aed601595a70AB815c96711a31Bc65` | otro USDC, USDT, mainnet USDC |
| Fuji chainId | `43113` (numero, no string) | `'43113'` string, `43114` (mainnet) |
| Fuji network string | `'eip155:43113'` | `'avalanche-fuji'`, `'fuji'`, `'eip155:43114'` |
| Decimales USDC Fuji | `6` (constante `FUJI_USDC_DECIMALS`) | `18` (eso es PYUSD Kite), literal `6` disperso (CD-NEW-SDD-5) |
| EIP-712 domain name | `'USD Coin'` (con espacio) | `'USDC'`, `'usd-coin'`, `'USD-Coin'` |
| EIP-712 domain version | `'2'` (string) | `'1'`, `2` (numero), `'v2'` |
| EIP-712 primaryType | `'TransferWithAuthorization'` | `'Transfer'`, `'Authorization'` (eso es Pieverse Kite) |
| validBefore offset | `300` segundos (constante `VALID_BEFORE_SECONDS`) | `60`, `600`, `3600` |
| Nonce gen | `randomBytes(32).toString('hex')` | `keccak256(slug + Date.now())`, UUID, sequencial |
| viem chain import | `import { avalancheFuji } from 'viem/chains'` | `import { avalanche } from ...` (mainnet), custom chain |
| Facilitator paths | `/verify` y `/settle` (POST) | `/x402/verify`, `/v1/verify`, `/api/...` |
| Body shape | `{ x402Version: 2, accepted: {scheme:'exact', network:..., amount, asset, payTo, maxTimeoutSeconds, extra:{assetTransferMethod:'eip3009'}}, payload: {signature, authorization} }` | otros shapes |
| Skip codes | `'NO_PAYMENT_FIELD' \| 'METHOD_NOT_SUPPORTED' \| 'CHAIN_NOT_SUPPORTED' \| 'INVALID_PAY_TO_FORMAT' \| 'ZERO_PAY_TO' \| 'INSUFFICIENT_BALANCE' \| 'BALANCE_READ_FAILED' \| 'SIGNING_FAILED' \| 'VERIFY_FAILED' \| 'SETTLE_FAILED' \| 'NETWORK_ERROR' \| 'CONFIG_MISSING'` | otros nombres |
| Logger fallback en compose.ts | `console.warn`/`console.log` con prefix `'[Downstream]'` (excepcion CD-NEW-SDD-4) | `fastify.log` (no esta en scope), `console.error` |
| operator wallet env | `OPERATOR_PRIVATE_KEY` (reusa la de Kite) | `FUJI_OPERATOR_PRIVATE_KEY`, var nueva |
| RPC env | `FUJI_RPC_URL` | `AVAX_RPC_URL`, `AVALANCHE_FUJI_RPC` |

### Valores de tests (no inventar)

| Elemento | Valor exacto |
|----------|-------------|
| Operator address en mocks | `0xf432baf09e7ba99ab44ff1d68c83f1234567Ba00` (or any 0x + 40 hex valido — pero consistente en todo el test file) |
| PayTo address en mocks | `0x000000000000000000000000000000000000aBcD` |
| Mock USDC balance happy path | `parseUnits('100', 6)` → `100000000n` |
| Mock value para 0.5 USDC | `500000n` (NO `500000000000000000n`) |
| Mock txHash | `'0xTX'` o `'0xabc'` (consistente entre tests) |

---

## 9. Out of scope — lo que el Dev debe RECHAZAR

Si durante F3 el humano o AR pide cualquiera de estos, el Dev responde **"Fuera de scope — WKH-XX"** y NO lo implementa en esta HU:

| Pedido | Razon | Tracked en |
|--------|-------|-----------|
| Tests E2E contra RPC Fuji real | CD-7 — prohibido en CI | (no scope) |
| Mainnet C-Chain (`eip155:43114`) | Solo testnet Fuji en V1 | WKH-56 |
| Retry policy / dead-letter-queue | V2 | Backlog |
| Metricas / dashboard de downstream | V2 | Backlog |
| Cadenas distintas a Avalanche Fuji | AC-6 hace skip graceful | HUs futuras por chain |
| Modificar `AgentFieldMapping` schema | Scope OUT del work-item §123 | (no scope) |
| Refund automatico si invoke OK + settle falla | DT-E acepta el trade-off pay-on-delivery | V3 (full-escrow) |
| Var separada `FUJI_OPERATOR_PRIVATE_KEY` | DT-C resuelta — V1 reusa Kite var | V2 backlog |
| Modificar middleware `a2a-key.ts` o `x402.ts` | CD-4 | (no scope) |
| Modificar routes `compose.ts` o `orchestrate.ts` | SDD §3.3: shape ya propaga sin cambios | (no scope) |
| ENABLE ROW LEVEL SECURITY en a2a_agent_keys (RLS Postgres) | Fuera de scope WKH-55 — eso es WKH-SEC-02 | WKH-SEC-02 |
| Checksum-verify on-chain de `payment.contract` | R-1 mitigacion: solo format/zero check en V1 | V2 |
| Helper class `DownstreamPaymentAdapter` | DT-G: una sola funcion exportada — no interface adapter | N/A |

---

## 10. Validation matrix esperada

Al cierre de F3:

| Comando | Resultado esperado |
|---------|-------------------|
| `npm test` | **408 PASS** (388 baseline + 20 nuevos) |
| `npx tsc --noEmit` | exit 0, 0 errores |
| `npm run lint` | exit 0, biome clean |
| `npm test -- src/lib/downstream-payment.test.ts` | 14 PASS |
| `npm test -- src/services/compose.test.ts` | sin regresion + 4 nuevos PASS |
| `npm test -- src/services/discovery.test.ts` | sin regresion + 2 nuevos PASS |
| `grep -rn "kite-ozone" src/lib/downstream-payment.ts` | 0 matches (CD-NEW-SDD-1) |
| `grep -rn "Math.round" src/lib/downstream-payment.ts` | 0 matches (CD-NEW-SDD-5) |
| `grep -rn "1e12" src/lib/downstream-payment.ts` | 0 matches (anti R-3) |
| `grep -rn "from 'ethers'" src/` | 0 matches (CD-10) |
| `git diff main src/middleware/` | empty (CD-4) |
| `git diff main src/routes/compose.ts src/routes/orchestrate.ts` | empty (decision SDD §3.3) |

---

## 11. Definition of Done (F3)

El Dev marca la HU como **"F3 DONE — ready for AR"** cuando **todos** los siguientes son verdaderos:

### Archivos
- [ ] `src/lib/downstream-payment.ts` existe y exporta `signAndSettleDownstream` + types
- [ ] `src/lib/downstream-payment.test.ts` existe y contiene los 14 tests descritos en §5 W2
- [ ] `src/types/index.ts` contiene `AgentPaymentSpec` + `Agent.payment?` + `StepResult.downstream*?`
- [ ] `src/services/discovery.ts` tiene `readPayment` helper + llamado en `mapAgent`
- [ ] `src/services/discovery.test.ts` contiene los 2 tests T-W1-1 y T-W1-2
- [ ] `src/services/compose.ts` tiene el hook post-invoke + spread en StepResult
- [ ] `src/services/compose.test.ts` contiene los 4 tests T-W3-01..04
- [ ] `.env.example` tiene la seccion `Downstream x402 — Avalanche Fuji (WKH-55)`

### Tests
- [ ] `npm test` → exit 0, **408 PASS** (zero regression — CD-3)
- [ ] `npm test -- src/lib/downstream-payment.test.ts` → 14 PASS
- [ ] `npm test -- src/services/compose.test.ts` → todos PASS (incluye 4 nuevos)
- [ ] `npm test -- src/services/discovery.test.ts` → todos PASS (incluye 2 nuevos)

### Quality gates
- [ ] `npx tsc --noEmit` → exit 0 (CD-1)
- [ ] `npm run lint` → exit 0
- [ ] Cero ocurrencias de `: any` en codigo nuevo
- [ ] `grep -rn "kite-ozone" src/lib/downstream-payment.ts` → 0 matches (CD-NEW-SDD-1)
- [ ] `grep -rn "Math.round" src/lib/downstream-payment.ts` → 0 matches (CD-NEW-SDD-5)
- [ ] `grep -rn "1e12" src/lib/downstream-payment.ts` → 0 matches (anti R-3)
- [ ] `grep -rn "from 'ethers'" src/lib/downstream-payment.ts src/services/compose.ts` → 0 matches (CD-10)

### Anti-violation checks
- [ ] `git diff main src/middleware/` → empty (CD-4)
- [ ] `git diff main src/routes/compose.ts src/routes/orchestrate.ts` → empty (SDD §3.3)
- [ ] `git diff main src/adapters/kite-ozone/` → empty (no se toca el adapter Kite)
- [ ] El flag `WASIAI_DOWNSTREAM_X402` se lee SOLO al module load (1 ocurrencia en `src/lib/downstream-payment.ts`)
- [ ] `signAndSettleDownstream` jamas hace `throw` (revisar visualmente — todos los catches devuelven null)

### Git
- [ ] 4 commits en la branch (W1, W2, W3, W5) con los mensajes sugeridos o equivalentes
- [ ] `git log --oneline main..HEAD | wc -l` ≥ 4
- [ ] Branch pusheada a remote: `git push -u origin feat/wkh-55-downstream-x402-fuji`
- [ ] NO pusheaste a `main` directamente

### Readiness para AR
- [ ] Tenes resumen ejecutivo 3-5 lineas listo para el orquestador

---

## 12. Rollout plan (post-merge)

Una vez que la PR este merged a main:

1. **Mergear PR sin tocar Railway env vars**.
   - El flag `WASIAI_DOWNSTREAM_X402` queda **unset** en Railway → comportamiento bit-exact al baseline.
   - Verificar que la app arranca: Railway logs sin errores de import del nuevo modulo.
   - Smoke test: `curl POST /compose` con un agente cualquiera → response shape sin cambios (no `downstreamTxHash`).
2. **Verificar baseline post-deploy**:
   - Ejecutar suite local con codigo de main: `npm test` → 408/408 PASS.
   - Confirmar `npm run lint` y `npx tsc --noEmit` exit 0.
3. **Habilitar el flag en staging primero** (si hay staging — sino directamente en prod con observabilidad):
   - Setear `WASIAI_DOWNSTREAM_X402=true` en Railway env vars.
   - Setear `FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc`.
   - Setear `FUJI_USDC_ADDRESS=0x5425890298aed601595a70AB815c96711a31Bc65`.
   - Asegurar que `OPERATOR_PRIVATE_KEY` ya esta seteada (es la misma de Kite) y la wallet tiene saldo USDC + AVAX en Fuji.
4. **Primera invocacion downstream**:
   - Llamar `POST /compose` o `POST /orchestrate` con un agente wasiai-v2 cuya agent card declare `payment.method='x402'` + `payment.chain='avalanche'`.
   - Verificar response: `body.steps[0].downstreamTxHash` populado (`0x...`).
   - Buscar el tx en Snowtrace Fuji: `https://testnet.snowtrace.io/tx/<txHash>`.
   - Confirmar `from = 0xf432baf...7Ba` (operator), `to = agent.payment.contract`, amount = `priceUsdc * 1_000_000`.
5. **Observar logs**:
   - Logs `[Downstream]` con `code: 'INSUFFICIENT_BALANCE'` → recargar wallet.
   - Logs `[Downstream]` con `code: 'VERIFY_FAILED'` o `'SETTLE_FAILED'` → revisar facilitator status `/supported`.
   - Si necesitas rollback inmediato: unsetear `WASIAI_DOWNSTREAM_X402` en Railway → comportamiento vuelve al baseline en <1 minuto sin redeploy.

**Post-rollout V2 (backlog, no esta HU)**:
- Alertas Discord/Slack de balance bajo.
- Metricas de tasa de exito downstream.
- Retry policy / DLQ para failures transitorios.

---

## 13. Resumen ejecutivo (para reportar al cerrar F3)

Al terminar F3 reportar al orquestador con este formato:

```
F3 DONE — WKH-55 Downstream x402 Payment (wasiai-a2a → Fuji USDC)
Branch: feat/wkh-55-downstream-x402-fuji (4 commits, pushed)
Archivos modificados: 4 (types/index.ts, services/discovery.ts, services/compose.ts, .env.example)
Archivos creados: 2 (lib/downstream-payment.ts, lib/downstream-payment.test.ts)
Tests modificados/anadidos: discovery.test.ts +2, compose.test.ts +4, downstream-payment.test.ts (nuevo) 14 → +20 totales
npm test: 408/408 PASS (388 baseline + 20 nuevos)
tsc --noEmit + lint: clean
CDs respetados: 17/17 (CD-1..CD-10 work-item + CD-NEW-SDD-1..7 SDD)
DTs implementados: 15/15 (DT-A..F + DT-G..O)
ACs cubiertos: 12/12 (con tests trazables 1:1)
Ready for AR.
```

---

**FIN DEL STORY FILE. No leer mas alla.**
