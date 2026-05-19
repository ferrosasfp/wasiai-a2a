# Story File — WKH-104 / BASE-01 · Base chain adapter

> **Dev contract — vinculante.** Este es el único documento que el Dev lee en F3.
> Si algo no está acá, no se hace. Si algo del SDD no está reflejado acá, es
> bug del Story File — pará y avisá al orquestador.
>
> **Lema del proyecto**: *hacemos código para producción, no para hack*.
> Sin shortcuts, sin mocks en prod, sin `any` explícito, sin secrets hardcodeados.

---

## 0. Metadata

| Campo | Valor |
|-------|-------|
| **HU ID** | WKH-104 (BASE-01) |
| **SDD** | `doc/sdd/088-wkh-104-base-adapter/sdd.md` |
| **Work item** | `doc/sdd/088-wkh-104-base-adapter/work-item.md` |
| **Branch destino** | `feat/wkh-base-port-v1` (compartida con WKH-105..108) |
| **PR target** | `main` (NO merge directo — CD-8) |
| **Sizing** | QUALITY · L (24-30h) |
| **Pipeline** | F0 → F1 → F2 → F2.5 → **F3** (vos estás acá) → AR → CR → F4 → DONE |
| **Stack** | TypeScript ^5.4 strict, viem ^2.47.6, vitest ^4.1, Fastify ^5.8, Biome |
| **Deps de F3** | SDD aprobado (sí) + Story File aprobado (este doc) |
| **Output esperado** | 6 archivos nuevos en `src/adapters/base/`, 3 archivos modificados (`types.ts`, `chain-resolver.ts`, `registry.ts`), 1 test nuevo (`base.test.ts`), 2 tests extendidos (`chain-resolver.test.ts`, `registry.test.ts`), `.env.example` extendido. ~1200 LOC. |

---

## 1. Contexto compacto (qué construimos y por qué)

Agregás soporte de **Base mainnet (chainId 8453)** y **Base Sepolia (chainId 84532)** al gateway `wasiai-a2a`. El gateway ya rutea pagos x402 USDC vía EIP-3009 (`TransferWithAuthorization`) en Kite y Avalanche; esta HU lo extiende a Base usando exactamente el mismo patrón que Avalanche.

**Por qué es crítico**:
1. Es la **primera HU del Epic WKH-103 (BASE port)** — las HUs WKH-105..108 dependen de que el adapter esté inicializado.
2. Toca módulos cross-cutting (`chain-resolver.ts`, `types.ts`, `registry.ts`) — un error rompe Kite y Avalanche en prod (3 consumidores live: app.wasiai.io, Cobraya, WasiAgentShop).
3. Suite de tests pre-existente: **≥1660 tests pasando** — cero tolerancia a regresiones.

**El patrón es 1:1 con Avalanche.** Tu trabajo es **clonar** `src/adapters/avalanche/` y ajustar constants para Base. Hay UNA divergencia documentada: el EIP-712 domain `name` de USDC en Base Sepolia es `"USDC"` (no `"USD Coin"`) — verificado onchain por sibling HU WKH-105.

---

## 2. Anti-Hallucination Checklist (LEER ANTES DE CODEAR)

### 2.1 Archivos que DEBÉS leer antes de la línea 1 de código

Estos archivos son tus **exemplars verbatim** — el adapter Base es un mirror byte-a-byte con substituciones. NO escribas código sin haberlos leído.

| # | Archivo | Por qué | Cuándo |
|---|---------|---------|--------|
| 1 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/avalanche/index.ts` | Factory `createBaseAdapters` (W2.6) | Antes de W2.6 |
| 2 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/avalanche/payment.ts` | `BasePaymentAdapter` (W2.5) — 432 LOC ref | Antes de W2.5 |
| 3 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/avalanche/chain.ts` | `getBaseNetwork`, `getBaseChain` (W2.1) | Antes de W2.1 |
| 4 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/avalanche/gasless.ts` | `BaseGaslessAdapter` stub (W2.4) | Antes de W2.4 |
| 5 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/avalanche/attestation.ts` | `BaseAttestationAdapter` stub (W2.3) | Antes de W2.3 |
| 6 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/avalanche/identity.ts` | `baseIdentity = null` (W2.2) | Antes de W2.2 |
| 7 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/__tests__/avalanche.test.ts` | Test estructure para `base.test.ts` (W3.2) | Antes de W3.2 |
| 8 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/__tests__/chain-resolver.test.ts` | Tests existentes que NO podés romper + patrón de extensión (W1.3) | Antes de W1.3 |
| 9 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/__tests__/registry.test.ts` | Patrón mock factories + tests existentes (W3.3) | Antes de W3.3 |
| 10 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/types.ts` | Union `ChainKey` actual + interfaces (W1.1) | Antes de W1.1 |
| 11 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/chain-resolver.ts` | `SLUG_ALIASES` actual (W1.2) | Antes de W1.2 |
| 12 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/adapters/registry.ts` | `SUPPORTED_CHAINS` + `buildBundle()` (W3.1) | Antes de W3.1 |
| 13 | `/home/ferdev/.openclaw/workspace/wasiai-a2a/.env.example` (líneas 155-165 y 350-395) | Patrón de sección Avalanche para mirror Base (W4.1) | Antes de W4.1 |

### 2.2 Reglas de "lo que NO podés inventar"

- **NO inventes APIs / funciones / paths**. Si tenés duda de cómo se llama una función → `Read` el exemplar.
- **NO inventes env vars**. Las únicas env vars válidas son las listadas en §4.7 (`BASE_NETWORK`, `BASE_TESTNET_RPC_URL`, `BASE_MAINNET_RPC_URL`, `BASE_SEPOLIA_USDC_ADDRESS`, `BASE_MAINNET_USDC_ADDRESS`, `BASE_SEPOLIA_USDC_EIP712_VERSION`, `BASE_MAINNET_USDC_EIP712_VERSION`, `BASE_FACILITATOR_URL`, `CDP_FACILITATOR_URL`, `CDP_API_KEY`).
- **NO uses `ethers.js`** — `viem` en todo (CD-7).
- **NO uses `any` explícito ni `as unknown`** (CD-1). Permitido: `as const`, `` as `0x${string}` ``, `as Readonly<...>` ya usados en exemplars.
- **NO toques `src/adapters/avalanche/` ni `src/adapters/kite-ozone/`** (CD-2). Si tu PR tiene un solo cambio acá → BLOQUEANTE en AR.
- **NO usés `viem/chains` `defineChain()`** — `base` (8453) y `baseSepolia` (84532) ya están exportados directamente (DT-4 verificado).
- **NO asumas EIP-712 domain `name` igual en testnet y mainnet** — son DIFERENTES (ver §2.3 abajo).
- **NO modifiques `src/middleware/a2a-key.ts`** — el middleware ya es chain-agnostic (verificado en SDD §3.1).
- **NO ejecutes `npm test` con `OPERATOR_PRIVATE_KEY` real de producción** — usar la wallet test del `.env.local`.

### 2.3 EIP-712 domain — HALLAZGO YA RESUELTO POR SIBLING WKH-105

El Dev de **WKH-105 (BASE-02 facilitator)** ya ejecutó `cast call` onchain durante su F3 (commit `7d86b37` en `wasiai-facilitator` branch `feat/base-support`) y confirmó:

| Network | USDC address | `name()` literal | `version()` | Status |
|---------|--------------|------------------|-------------|--------|
| Base **Sepolia** (84532) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | **`"USDC"`** ⚠️ | `"2"` | **DIFIERE** de Avalanche (`'USD Coin'`) |
| Base **Mainnet** (8453) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `"USD Coin"` | `"2"` | Match Avalanche |

**Implicación obligatoria para tu código** (`src/adapters/base/payment.ts`):

```ts
const USDC_EIP712_NAME_SEPOLIA = 'USDC' as const;      // Base Sepolia (verified onchain 2026-05-19 by WKH-105)
const USDC_EIP712_NAME_MAINNET = 'USD Coin' as const;  // Base Mainnet (verified onchain 2026-05-19 by WKH-105)
const USDC_EIP712_VERSION_DEFAULT = '2' as const;      // Both networks
```

NO uses una sola constante `USDC_EIP712_NAME` como Avalanche — necesitás **per-network** para Base.

### 2.4 Sanity check obligatorio en W0

Aunque la verificación ya fue hecha, en W0 vas a re-ejecutar `cast call` como **paper trail** (no como descubrimiento). Esto cumple CD-3 estricto y queda registrado en `w0-audit.md`. Si por alguna razón el resultado difiere de lo arriba → STOP y avisar al orquestador.

---

## 3. NEVER list (CDs concretos sintetizados)

| # | NUNCA hacer | Origen | Si lo hacés |
|---|-------------|--------|------------|
| 1 | Editar archivos en `src/adapters/avalanche/` | CD-2 | BLOQUEANTE en AR |
| 2 | Editar archivos en `src/adapters/kite-ozone/` | CD-2 | BLOQUEANTE en AR |
| 3 | Usar `any` explícito o `as unknown` | CD-1 | BLOQUEANTE en CR |
| 4 | Hardcodear secrets / private keys / RPC URLs sin env override | CD-6 | BLOQUEANTE en AR |
| 5 | Importar `ethers` o `ethers/...` | CD-7 | BLOQUEANTE en CR |
| 6 | `git push origin main` directo | CD-8 | Process violation — retro |
| 7 | Asumir EIP-712 name `'USD Coin'` en Base Sepolia | CD-3 + §2.3 | Firma inválida en BASE-04 smoke E2E |
| 8 | Defaultear silenciosamente `BASE_NETWORK='devnet'` a testnet sin `console.warn` | CD-11 | BLOQUEANTE en CR |
| 9 | Saltarse `_resetWalletClient()` entre tests (cache contamination) | CD-17 / DT-8 | Tests flakean |
| 10 | Definir tests fuera de `src/adapters/__tests__/` | CD-10 | TS6059 cross-rootDir |
| 11 | Inventar `BASE_RPC_URL` o `BASE_USDC_ADDRESS` (sin `_TESTNET` / `_MAINNET` / `_SEPOLIA`) | §4.7 | Confusión de network — BLOQUEANTE en CR |
| 12 | Crear `src/adapters/base/payment.ts` SIN constants per-network para `USDC_EIP712_NAME` | §2.3 | Firma inválida en mainnet → BLOQUEANTE en AR |

---

## 4. Waves de ejecución (W0 → W4)

> Cada wave debe completarse en orden. **No** saltar waves. Si un step falla, pará y documentá en `auto-blindaje.md`.

---

### Wave W0 — Pre-flight + onchain sanity check (paper trail)

**Goal**: confirmar que el entorno está listo, leer exemplars, ejecutar `cast call` como sanity (no como descubrimiento), y crear `w0-audit.md`.

#### W0.1 — Verificar versión viem

```bash
npm ls viem
```

**Esperado**: `viem@2.47.x` (o superior). Si NO está → STOP.

#### W0.2 — Confirmar `base` + `baseSepolia` exportados

```bash
grep "base\|baseSepolia" node_modules/viem/chains/index.ts
```

**Esperado**: 2 líneas:
```
export { base, basePreconf } from './definitions/base.js'
export { baseSepolia, baseSepoliaPreconf } from './definitions/baseSepolia.js'
```

#### W0.3 — Baseline tests verdes en branch limpia

```bash
git checkout feat/wkh-base-port-v1
git pull origin feat/wkh-base-port-v1
npm test 2>&1 | tail -20
```

**Esperado**: `≥1660 passed / 0 failed`. Si hay fallas → NO codear, parar y avisar al orquestador.

#### W0.4..W0.6 — Sanity check `cast call` onchain (paper trail)

Verificación ya hecha por WKH-105 (ver §2.3). Acá la re-ejecutás como evidencia auditable.

```bash
# Sepolia name + version
cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "name()(string)" --rpc-url https://sepolia.base.org
cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "version()(string)" --rpc-url https://sepolia.base.org

# Mainnet name + version
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)" --rpc-url https://mainnet.base.org
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "version()(string)" --rpc-url https://mainnet.base.org
```

**Esperado** (matching §2.3):
- Sepolia `name` → `"USDC"`
- Sepolia `version` → `"2"`
- Mainnet `name` → `"USD Coin"`
- Mainnet `version` → `"2"`

Si NO `cast` disponible (no instalaste foundry), usar alternativa con viem en un script efímero (`scripts/w0-audit.ts` que tirás después) — pero registrá la fuente del output en `w0-audit.md`.

#### W0.7 — Re-validar callsites `ChainKey`

```bash
grep -rn "switch.*ChainKey\|: ChainKey)" src --include="*.ts"
```

**Esperado** (idem SDD §16.4): solo `registry.ts:40, 149, 162, 172` (etc, sólo `registry.ts`). Si aparecen nuevos callsites → STOP, avisar Architect.

#### W0.8 — Crear `w0-audit.md`

Path: `doc/sdd/088-wkh-104-base-adapter/w0-audit.md`

Estructura mínima:

```markdown
# W0 Audit — WKH-104 (BASE-01)

> Pre-flight verification + EIP-712 domain paper trail.
> Date: <YYYY-MM-DD>
> Operator: <git user>

## viem version
$ npm ls viem
<verbatim output>

## viem/chains exports
$ grep "base\|baseSepolia" node_modules/viem/chains/index.ts
<verbatim output>

## Baseline tests
$ npm test 2>&1 | tail -5
<verbatim output: X passed / 0 failed>

## EIP-712 domain — onchain sanity check

### Base Sepolia (USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e)
$ cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "name()(string)" --rpc-url https://sepolia.base.org
<verbatim output: "USDC">

$ cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "version()(string)" --rpc-url https://sepolia.base.org
<verbatim output: "2">

### Base Mainnet (USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
$ cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)" --rpc-url https://mainnet.base.org
<verbatim output: "USD Coin">

$ cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "version()(string)" --rpc-url https://mainnet.base.org
<verbatim output: "2">

## Resultado vs hipótesis
- Sepolia name DIFIERE de Avalanche (`USDC` vs `USD Coin`) — implementar per-network constants (§2.3)
- Mainnet name MATCH Avalanche — OK

## ChainKey callsites grep
<verbatim output>

## Status
- [x] viem 2.47+ ✓
- [x] base + baseSepolia exportados ✓
- [x] Baseline tests verdes ✓
- [x] EIP-712 sanity OK ✓
- [x] ChainKey callsites confirmed (only registry.ts) ✓

→ Listo para W1.
```

**Output obligatorio de W0**: `w0-audit.md` commiteado al folder SDD (no es código fuente).

---

### Wave W1 — Cross-cutting (types + chain-resolver + tests)

**Goal**: extender la union `ChainKey`, agregar 6 aliases al `chain-resolver`, y cubrirlos con tests. Después de W1, el codebase compila (los archivos de `src/adapters/base/` no existen aún, pero `types.ts` + `chain-resolver.ts` + tests sí).

#### W1.1 — `src/adapters/types.ts`

**Acción**: extender la union `ChainKey` (líneas 122-126 del archivo).

**Antes** (verbatim del archivo actual, líneas 122-126):
```ts
export type ChainKey =
  | 'kite-ozone-testnet'
  | 'kite-mainnet'
  | 'avalanche-fuji'
  | 'avalanche-mainnet';
```

**Después**:
```ts
export type ChainKey =
  | 'kite-ozone-testnet'
  | 'kite-mainnet'
  | 'avalanche-fuji'
  | 'avalanche-mainnet'
  | 'base-sepolia'
  | 'base-mainnet';
```

**Validación**:
```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```
Esperado: nuevos errores **sólo** en `chain-resolver.ts` (porque el alias `satisfies Record<string, ChainKey>` se actualiza recién en W1.2). Eso es OK — la cadena de W1 los cierra.

#### W1.2 — `src/adapters/chain-resolver.ts`

**Acción**: agregar 6 aliases nuevos en `SLUG_ALIASES` después de la sección kite-mainnet (después de línea 41).

**Antes** (verbatim de líneas 39-43):
```ts
    // kite-mainnet aliases
    '2366': 'kite-mainnet',
    'kite-mainnet': 'kite-mainnet',
  } satisfies Record<string, ChainKey>,
);
```

**Después**:
```ts
    // kite-mainnet aliases
    '2366': 'kite-mainnet',
    'kite-mainnet': 'kite-mainnet',

    // base-mainnet aliases (DT-7: 'base' alone → mainnet, convención comunidad)
    '8453': 'base-mainnet',
    'base-mainnet': 'base-mainnet',
    base: 'base-mainnet',

    // base-sepolia aliases
    '84532': 'base-sepolia',
    'base-sepolia': 'base-sepolia',
    'base-testnet': 'base-sepolia',
  } satisfies Record<string, ChainKey>,
);
```

**NO modifiques** `normalizeChainSlug()` ni `resolveChainKey()` — solo `SLUG_ALIASES`. CD-19 anti-prototype-pollution se preserva automáticamente.

#### W1.3 — `src/adapters/__tests__/chain-resolver.test.ts`

**Acción**: agregar un nuevo bloque `describe('base aliases', ...)` después del bloque `'CD-19 — does not return values...'` (después de línea 64).

**Patrón de extensión** (mirror del bloque avalanche existente, líneas 32-36):

```ts
  it('maps base aliases (base, base-testnet) per DT-7 convention', () => {
    expect(normalizeChainSlug('base')).toBe('base-mainnet');
    expect(normalizeChainSlug('base-mainnet')).toBe('base-mainnet');
    expect(normalizeChainSlug('base-sepolia')).toBe('base-sepolia');
    expect(normalizeChainSlug('base-testnet')).toBe('base-sepolia');
  });

  it('maps Base numeric chainIds to canonical slugs', () => {
    expect(normalizeChainSlug('8453')).toBe('base-mainnet');
    expect(normalizeChainSlug('84532')).toBe('base-sepolia');
  });

  it('lowercases and trims Base input', () => {
    expect(normalizeChainSlug('  Base-Sepolia  ')).toBe('base-sepolia');
    expect(normalizeChainSlug('BASE-MAINNET')).toBe('base-mainnet');
  });
```

Y dentro de `describe('resolveChainKey', ...)` agregá:

```ts
  it('header chainId 84532 numeric resolves to base-sepolia', () => {
    expect(resolveChainKey({ headerOverride: '84532' })).toBe('base-sepolia');
  });

  it('header chainId 8453 numeric resolves to base-mainnet', () => {
    expect(resolveChainKey({ headerOverride: '8453' })).toBe('base-mainnet');
  });
```

**NO toques** los tests existentes (1-13). El bloque `CD-19 — Object.prototype keys` debe seguir verde.

#### W1.4 — Validar W1

```bash
npm run lint
npx vitest run src/adapters/__tests__/chain-resolver.test.ts 2>&1 | tail -10
```

**Esperado**: 0 errores Biome + 16 tests existentes verdes + 5 nuevos tests verdes = 21 total.

---

### Wave W2 — Adapter Base (6 archivos en `src/adapters/base/`)

**Goal**: crear el directorio `src/adapters/base/` con los 6 archivos, todos mirror del adapter Avalanche con substituciones documentadas. **No hay tests acá** — los tests los wireamos en W3.

```bash
mkdir -p src/adapters/base
```

#### W2.1 — `src/adapters/base/chain.ts`

**Exemplar**: `src/adapters/avalanche/chain.ts` (33 LOC).

**Snippet a escribir** (verbatim, listo para copy):

```ts
import { base, baseSepolia } from 'viem/chains';

/**
 * Base chain registration (WKH-104 / BASE-01).
 *
 * Re-export the viem-defined chains directly — Base (8453) and Base Sepolia
 * (84532) are first-class viem entries since viem ^2.47.6 (DT-4 RESUELTO).
 */
export { base, baseSepolia };

export type BaseNetwork = 'testnet' | 'mainnet';

/**
 * Resolve the active Base network for call-sites outside the registry
 * factory (the factory itself always passes `network` explicitly).
 *
 * Priority:
 *   1. Explicit `opts.network` argument.
 *   2. `BASE_NETWORK` env var ('mainnet' activa mainnet, anything else → testnet).
 *   3. Fallback to 'testnet' (Base Sepolia) — conservador (CD-4).
 *
 * CD-11 (defense-in-depth, Auto-Blindaje WKH-59): si `BASE_NETWORK` tiene un
 * valor que no es 'mainnet'/'testnet'/vacío, emit `console.warn` ONCE por
 * proceso explicando el fallback. Previene silent misconfig.
 */
let _warnedBaseNetwork = false;
export function getBaseNetwork(opts?: { network?: BaseNetwork }): BaseNetwork {
  if (opts?.network) return opts.network;
  const env = process.env.BASE_NETWORK;
  if (env === 'mainnet') return 'mainnet';
  if (env !== undefined && env !== '' && env !== 'testnet' && !_warnedBaseNetwork) {
    _warnedBaseNetwork = true;
    console.warn(
      `[base] BASE_NETWORK="${env}" is not 'mainnet' or 'testnet' — defaulting to 'testnet'`,
    );
  }
  return 'testnet';
}

export function getBaseChain(network: BaseNetwork) {
  return network === 'mainnet' ? base : baseSepolia;
}

/** TEST-ONLY — reset warn-once flag (CD-17). */
export function _resetBaseChain(): void {
  _warnedBaseNetwork = false;
}
```

**Diff vs Avalanche** (para tu sanity):
- `import { avalanche, avalancheFuji } from 'viem/chains'` → `import { base, baseSepolia } from 'viem/chains'`
- `type AvalancheNetwork = 'fuji' | 'mainnet'` → `type BaseNetwork = 'testnet' | 'mainnet'` (testnet en vez de fuji)
- `env === 'mainnet' ? 'mainnet' : 'fuji'` → lógica reescrita con warn-once (defense-in-depth)
- `getAvalancheChain` → `getBaseChain`
- Agrega `_resetBaseChain` TEST-ONLY (avalanche NO lo tiene porque su warn-once vive en payment.ts) — útil para tests CD-11.

#### W2.2 — `src/adapters/base/identity.ts`

**Exemplar**: `src/adapters/avalanche/identity.ts` (3 LOC).

```ts
// No identity binding in Base MVP — null per DT-5 (work-item Scope IN).
// WKH-104 / BASE-01.
export const baseIdentity = null;
```

#### W2.3 — `src/adapters/base/attestation.ts`

**Exemplar**: `src/adapters/avalanche/attestation.ts` (30 LOC).

```ts
import type { AttestationAdapter, AttestEvent, AttestRef } from '../types.js';

/**
 * Base attestation stub (WKH-104 / BASE-01).
 *
 * Mirror of `AvalancheAttestationAdapter`. ERC-8004 attestation on Base is
 * out of scope for MVP (placeholder — future HU may wire EAS or similar).
 * Returns a stub txHash so downstream consumers don't break.
 */
export class BaseAttestationAdapter implements AttestationAdapter {
  readonly name = 'base';
  readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async attest(
    _event: AttestEvent,
  ): Promise<{ txHash: string; proofUrl: string }> {
    console.warn(
      '[base] attestation stub — ERC-8004 not implemented',
    );
    return { txHash: '0x0', proofUrl: '' };
  }

  async verify(_ref: AttestRef): Promise<boolean> {
    return true;
  }
}
```

**Diff vs Avalanche**: `avalanche` → `base` en `name` y warn message.

#### W2.4 — `src/adapters/base/gasless.ts`

**Exemplar**: `src/adapters/avalanche/gasless.ts` (44 LOC).

```ts
import type {
  GaslessAdapter,
  GaslessAdapterResult,
  GaslessAdapterStatus,
  GaslessTransferAdapterRequest,
} from '../types.js';

/**
 * Base gasless stub (WKH-104 / BASE-01).
 *
 * Base MVP does NOT implement gasless transfers — pending CDP Paymaster
 * integration (deferred to WKH-105 / BASE-02). `status()` reports disabled;
 * `transfer()` throws. Documented in DT-11 (facilitator caveat).
 */
export class BaseGaslessAdapter implements GaslessAdapter {
  readonly name = 'base';
  readonly chainId: number;
  private readonly networkTag: 'base-sepolia' | 'base-mainnet';

  constructor(chainId: number) {
    this.chainId = chainId;
    this.networkTag =
      chainId === 8453 ? 'base-mainnet' : 'base-sepolia';
  }

  async transfer(
    _req: GaslessTransferAdapterRequest,
  ): Promise<GaslessAdapterResult> {
    throw new Error(
      'Base gasless not implemented — pending CDP paymaster (WKH-105)',
    );
  }

  async status(): Promise<GaslessAdapterStatus> {
    return {
      enabled: false,
      network: this.networkTag,
      chain_id: this.chainId,
      supportedToken: null,
      operatorAddress: null,
      funding_state: 'disabled',
      documentation:
        'https://github.com/ferrosasfp/wasiai-a2a/blob/main/doc/architecture/CHAIN-ADAPTIVE.md',
    };
  }
}
```

**Diff vs Avalanche**:
- `avalanche` → `base` en `name`.
- `43114 → avalanche-mainnet : avalanche-fuji` → `8453 → base-mainnet : base-sepolia`.
- Error message más explícito sobre WKH-105.

#### W2.5 — `src/adapters/base/payment.ts` (CRÍTICO — ~432 LOC mirror)

**Exemplar**: `src/adapters/avalanche/payment.ts` (432 LOC). **Léelo entero antes de empezar.**

Este es el archivo más complejo. El patrón general es **clonar Avalanche** con estas substituciones:

##### Substituciones literales (find/replace, en orden)

| Find (Avalanche) | Replace (Base) | Contexto |
|------------------|----------------|----------|
| `AvalancheNetwork` | `BaseNetwork` | type import + parámetros |
| `getAvalancheChain` | `getBaseChain` | import |
| `AVALANCHE_SCHEME` | `BASE_SCHEME` | const |
| `FUJI_CHAIN_ID = 43113` | `BASE_SEPOLIA_CHAIN_ID = 84532` | const |
| `AVALANCHE_CHAIN_ID = 43114` | `BASE_MAINNET_CHAIN_ID = 8453` | const |
| `FUJI_NETWORK_TAG = 'eip155:43113'` | `BASE_SEPOLIA_NETWORK_TAG = 'eip155:84532'` | const |
| `AVALANCHE_NETWORK_TAG = 'eip155:43114'` | `BASE_MAINNET_NETWORK_TAG = 'eip155:8453'` | const |
| `AvalancheNetworkTag` | `BaseNetworkTag` | type |
| `AVALANCHE_MAX_TIMEOUT_SECONDS` | `BASE_MAX_TIMEOUT_SECONDS` (sigue siendo 60) | const |
| `DEFAULT_FUJI_USDC = '0x5425...Bc65'` | `DEFAULT_BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'` | const |
| `DEFAULT_AVALANCHE_USDC = '0xB97E...8a6E'` | `DEFAULT_BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'` | const |
| `_walletClientFuji` | `_walletClientSepolia` | module state |
| `_walletClientMainnet` | (sin cambios — sigue `_walletClientMainnet`) | module state |
| `_warnedDefaultTokenFuji` | `_warnedDefaultTokenSepolia` | module state |
| `_warnedDefaultTokenMainnet` | (sin cambios — sigue `_warnedDefaultTokenMainnet`) | module state |
| `FUJI_USDC_ADDRESS` (env) | `BASE_SEPOLIA_USDC_ADDRESS` (env) | env var reads |
| `AVALANCHE_USDC_ADDRESS` (env) | `BASE_MAINNET_USDC_ADDRESS` (env) | env var reads |
| `FUJI_USDC_EIP712_VERSION` (env) | `BASE_SEPOLIA_USDC_EIP712_VERSION` (env) | env var reads |
| `AVALANCHE_USDC_EIP712_VERSION` (env) | `BASE_MAINNET_USDC_EIP712_VERSION` (env) | env var reads |
| `FUJI_RPC_URL` (env) | `BASE_TESTNET_RPC_URL` (env) | env var reads |
| `AVALANCHE_RPC_URL` (env) | `BASE_MAINNET_RPC_URL` (env) | env var reads |
| `AVALANCHE_FACILITATOR_URL` (env) | `BASE_FACILITATOR_URL` (env) | env var reads |
| `'avalanche'` (en log/warn prefixes y `this.name`) | `'base'` | strings |
| `AvalanchePaymentAdapter` | `BasePaymentAdapter` | class name |
| `(network === 'mainnet' ? AVALANCHE_CHAIN_ID : FUJI_CHAIN_ID)` | `(network === 'mainnet' ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID)` | constructor |
| `(network === 'mainnet' ? avalanche : avalancheFuji)` (via `getAvalancheChain`) | `(network === 'mainnet' ? base : baseSepolia)` (via `getBaseChain`) | wallet client |

##### Cambios NO triviales (NO usar find/replace — pensá)

1. **`USDC_EIP712_NAME` per-network** (§2.3 — divergencia confirmada onchain):

   **Avalanche** (líneas 49-52 de `payment.ts`):
   ```ts
   const USDC_DECIMALS = 6 as const;
   const USDC_EIP712_NAME = 'USD Coin' as const;
   const USDC_EIP712_VERSION_DEFAULT = '2' as const;
   const USDC_SYMBOL = 'USDC' as const;
   ```

   **Base** (debes escribir):
   ```ts
   const USDC_DECIMALS = 6 as const;
   // EIP-712 domain `name` differs per network — verified onchain by WKH-105
   // sibling Dev (see w0-audit.md and Story File §2.3).
   const USDC_EIP712_NAME_SEPOLIA = 'USDC' as const;
   const USDC_EIP712_NAME_MAINNET = 'USD Coin' as const;
   const USDC_EIP712_VERSION_DEFAULT = '2' as const;
   const USDC_SYMBOL = 'USDC' as const;

   function getUsdcEip712Name(network: BaseNetwork): string {
     return network === 'mainnet' ? USDC_EIP712_NAME_MAINNET : USDC_EIP712_NAME_SEPOLIA;
   }
   ```

   En el método `sign()` reemplazar el uso de `USDC_EIP712_NAME` por la llamada a `getUsdcEip712Name(this.network)`:

   **Avalanche** (líneas 391-398 de `payment.ts`):
   ```ts
   const signature = await client.signTypedData({
     account,
     domain: {
       name: USDC_EIP712_NAME,
       version: getUsdcEip712Version(this.network),
       chainId: this.chainId,
       verifyingContract: token,
     },
   ```

   **Base** (debes escribir):
   ```ts
   const signature = await client.signTypedData({
     account,
     domain: {
       name: getUsdcEip712Name(this.network),
       version: getUsdcEip712Version(this.network),
       chainId: this.chainId,
       verifyingContract: token,
     },
   ```

2. **`getFacilitatorUrl()` chain extendida** (DT-3):

   **Avalanche** (líneas 143-149):
   ```ts
   function getFacilitatorUrl(): string {
     return (
       process.env.AVALANCHE_FACILITATOR_URL ??
       process.env.WASIAI_FACILITATOR_URL ??
       WASIAI_FACILITATOR_DEFAULT_URL
     );
   }
   ```

   **Base**:
   ```ts
   function getFacilitatorUrl(): string {
     return (
       process.env.BASE_FACILITATOR_URL ??
       process.env.CDP_FACILITATOR_URL ??
       process.env.WASIAI_FACILITATOR_URL ??
       WASIAI_FACILITATOR_DEFAULT_URL
     );
   }
   ```

   Tres niveles: `BASE_FACILITATOR_URL` (override absoluto, testing) → `CDP_FACILITATOR_URL` (placeholder BASE-01, real en BASE-02) → `WASIAI_FACILITATOR_URL` (shared) → default hardcoded.

3. **`getNetworkTag()` mapeo** — substituí `FUJI_NETWORK_TAG`/`AVALANCHE_NETWORK_TAG` por `BASE_SEPOLIA_NETWORK_TAG`/`BASE_MAINNET_NETWORK_TAG`:

   **Avalanche** (líneas 198-200):
   ```ts
   function getNetworkTag(network: AvalancheNetwork): AvalancheNetworkTag {
     return network === 'mainnet' ? AVALANCHE_NETWORK_TAG : FUJI_NETWORK_TAG;
   }
   ```

   **Base**:
   ```ts
   function getNetworkTag(network: BaseNetwork): BaseNetworkTag {
     return network === 'mainnet' ? BASE_MAINNET_NETWORK_TAG : BASE_SEPOLIA_NETWORK_TAG;
   }
   ```

4. **`_resetWalletClient()` TEST-ONLY** (líneas 427-432) — actualizar nombres de las module vars:

   ```ts
   export function _resetWalletClient(): void {
     _walletClientSepolia = null;
     _walletClientMainnet = null;
     _warnedDefaultTokenSepolia = false;
     _warnedDefaultTokenMainnet = false;
   }
   ```

5. **JSDoc top-of-file** (DT-11 caveat):
   ```ts
   /**
    * Base x402 payment adapter (WKH-104 / BASE-01).
    *
    * MIRROR EXACTO of `AvalanchePaymentAdapter` restricted to canonical x402
    * mode (CD-15 inherited from WKH-MULTICHAIN). Signs EIP-3009
    * `TransferWithAuthorization` against Circle USDC on Base (mainnet 8453 +
    * Sepolia testnet 84532) and POSTs canonical x402 v2 envelopes to the
    * facilitator.
    *
    * IMPORTANTE — BASE-01 caveat (DT-11): el facilitator actual (WasiAI o CDP)
    * NO soporta Base RPC en esta fase. WKH-105 (BASE-02) wirea el facilitator
    * real. Los tests de este archivo mockean `fetch`. Smoke real es WKH-107
    * (BASE-04). En BASE-01, una respuesta 4xx del facilitator es esperada y
    * NO falla el build.
    *
    * EIP-712 domain `name` difiere por network — verified onchain por WKH-105
    * (Sepolia="USDC", Mainnet="USD Coin"). Ver `w0-audit.md`.
    */
   ```

##### Estructura final de `base/payment.ts`

Misma estructura que Avalanche:
1. Imports (incluir `from './chain.js'` para `BaseNetwork`, `getBaseChain`)
2. Constants per-network + per-network helpers (`getDefaultUsdcAddress`, `getUsdcAddress`, `getUsdcEip712Version`, **NUEVO**: `getUsdcEip712Name`, `getRpcUrl`, `getFacilitatorUrl`, `getWalletClient`)
3. Module-level lazy state (`_walletClientSepolia`, `_walletClientMainnet`, warn-once flags)
4. `X402VerifyResponse` + `X402SettleResponse` interfaces (idénticas)
5. `getNetworkTag`, `buildX402CanonicalBody`, `verifyX402`, `settleX402` helpers (idénticos pattern)
6. `EIP3009_TYPES` const (idéntico — los tipos EIP-712 son standard)
7. `BasePaymentAdapter implements PaymentAdapter` class
8. `_resetWalletClient()` TEST-ONLY export

#### W2.6 — `src/adapters/base/index.ts`

**Exemplar**: `src/adapters/avalanche/index.ts` (47 LOC).

```ts
import type { AdaptersBundle } from '../types.js';
import {
  type BaseNetwork,
  getBaseChain,
  getBaseNetwork,
} from './chain.js';

/**
 * Base adapter factory (WKH-104 / BASE-01).
 *
 * Returns an `AdaptersBundle` ready to be inserted into the multi-chain
 * registry `Map<ChainKey, AdaptersBundle>`. Network is determined by
 * `opts.network` (preferred) or `BASE_NETWORK` env (standalone / tools).
 *
 * The registry dispatcher (`buildBundle()` in `registry.ts`) always passes
 * `network` explicitly — 'testnet' for `base-sepolia`, 'mainnet' for
 * `base-mainnet`.
 */
export async function createBaseAdapters(opts?: {
  network?: BaseNetwork;
}): Promise<AdaptersBundle> {
  const network = getBaseNetwork(opts);
  const { BasePaymentAdapter } = await import('./payment.js');
  const { BaseAttestationAdapter } = await import('./attestation.js');
  const { BaseGaslessAdapter } = await import('./gasless.js');

  const chain = getBaseChain(network);
  const chainId = chain.id;
  const explorerUrl =
    network === 'mainnet'
      ? 'https://basescan.org'
      : 'https://sepolia.basescan.org';
  const name = network === 'mainnet' ? 'Base' : 'Base Sepolia';

  return {
    payment: new BasePaymentAdapter({ network }),
    attestation: new BaseAttestationAdapter(chainId),
    gasless: new BaseGaslessAdapter(chainId),
    identity: null,
    chainConfig: {
      name,
      chainId,
      explorerUrl,
    },
  };
}
```

**Diff vs Avalanche**:
- `AvalancheNetwork` → `BaseNetwork`
- `getAvalancheChain`/`getAvalancheNetwork` → `getBaseChain`/`getBaseNetwork`
- `Avalanche*Adapter` → `Base*Adapter`
- `'https://snowtrace.io'` / `'https://testnet.snowtrace.io'` → `'https://basescan.org'` / `'https://sepolia.basescan.org'`
- `'Avalanche'` / `'Avalanche Fuji'` → `'Base'` / `'Base Sepolia'`

#### W2.7 — Validar W2

```bash
npm run lint
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

**Esperado**: 0 errores Biome, 0 errores TS. (Aún no hay tests Base, los lanzamos en W3.)

**NO ejecutar `npm test`** acá — los tests Base no existen y `registry.test.ts` no tiene el mock Base aún (lo agregás en W3).

---

### Wave W3 — Registry wiring + test suites

**Goal**: registrar Base en el registry, crear `base.test.ts`, extender `registry.test.ts`. Después de W3, **TODOS los tests** deben pasar.

#### W3.1 — `src/adapters/registry.ts`

**Acción A**: extender `SUPPORTED_CHAINS` (líneas 25-30 del archivo actual).

**Antes**:
```ts
const SUPPORTED_CHAINS = [
  'kite-ozone-testnet',
  'kite-mainnet',
  'avalanche-fuji',
  'avalanche-mainnet',
] as const satisfies readonly ChainKey[];
```

**Después**:
```ts
const SUPPORTED_CHAINS = [
  'kite-ozone-testnet',
  'kite-mainnet',
  'avalanche-fuji',
  'avalanche-mainnet',
  'base-sepolia',
  'base-mainnet',
] as const satisfies readonly ChainKey[];
```

**Acción B**: agregar 2 ramas a `buildBundle()` (después de la rama `avalanche-mainnet`, antes del `throw` final — alrededor de línea 73).

**Después de la línea 73** insertá:
```ts
  if (chainKey === 'base-sepolia') {
    const { createBaseAdapters } = await import('./base/index.js');
    return createBaseAdapters({ network: 'testnet' });
  }
  if (chainKey === 'base-mainnet') {
    const { createBaseAdapters } = await import('./base/index.js');
    return createBaseAdapters({ network: 'mainnet' });
  }
```

**NO modifiques** las ramas existentes (`kite-*`, `avalanche-*`). NO modifiques `initAdapters()`, `assertInitialized()`, `resolveBundleOrThrow()` ni los getters.

#### W3.2 — `src/adapters/__tests__/base.test.ts` (NUEVO — ~430 LOC)

**Exemplar**: `src/adapters/__tests__/avalanche.test.ts` (427 LOC). **Léelo entero antes de escribir.**

**Estructura obligatoria** (mirror del exemplar):

```ts
/**
 * Base adapter tests (WKH-104 / BASE-01).
 *
 * Covers:
 *   - Factory shape — testnet default + mainnet wiring + BASE_NETWORK env.
 *   - PaymentAdapter contract — chainId, scheme, network tag, USDC, decimals.
 *   - Env override for USDC address (BASE_SEPOLIA_USDC_ADDRESS / BASE_MAINNET_USDC_ADDRESS).
 *   - EIP-712 domain name per-network (Sepolia="USDC" vs Mainnet="USD Coin" — verified onchain).
 *   - Facilitator URL fallback chain (BASE > CDP > WASIAI > default).
 *   - Gasless status — disabled stub.
 *   - Attestation stub — warn + zero txHash.
 *   - Identity binding — null.
 *   - CD-11 — warn-once on invalid BASE_NETWORK.
 *   - CD-12 — chainId consistency across bundle members.
 *
 * Mocks viem walletClient + global fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      account: { address: '0x1234567890123456789012345678901234567890' },
      signTypedData: vi.fn().mockResolvedValue(`0x${'ab'.repeat(65)}`),
    })),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  _resetWalletClient,
  BasePaymentAdapter,
} from '../base/payment.js';
import { _resetBaseChain } from '../base/chain.js';
import { createBaseAdapters } from '../base/index.js';

const BASE_SEPOLIA_USDC_DEFAULT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_MAINNET_USDC_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('Base adapter — factory shape', () => {
  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.BASE_NETWORK;
    delete process.env.BASE_SEPOLIA_USDC_ADDRESS;
    delete process.env.BASE_MAINNET_USDC_ADDRESS;
  });

  it('default network → testnet bundle (chainId 84532)', async () => {
    const bundle = await createBaseAdapters();
    expect(bundle.chainConfig.chainId).toBe(84532);
    expect(bundle.chainConfig.name).toBe('Base Sepolia');
    expect(bundle.chainConfig.explorerUrl).toBe('https://sepolia.basescan.org');
  });

  it('explicit testnet → chainId 84532 + CD-12 consistency', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    expect(bundle.chainConfig.chainId).toBe(84532);
    expect(bundle.payment.chainId).toBe(84532);
    expect(bundle.attestation.chainId).toBe(84532);
    expect(bundle.gasless.chainId).toBe(84532);
  });

  it('explicit mainnet → chainId 8453 + name "Base" + CD-12 consistency', async () => {
    const bundle = await createBaseAdapters({ network: 'mainnet' });
    expect(bundle.chainConfig.chainId).toBe(8453);
    expect(bundle.chainConfig.name).toBe('Base');
    expect(bundle.chainConfig.explorerUrl).toBe('https://basescan.org');
    expect(bundle.payment.chainId).toBe(8453);
    expect(bundle.attestation.chainId).toBe(8453);
    expect(bundle.gasless.chainId).toBe(8453);
  });

  it('identity is null (no identity binding in Base MVP)', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    expect(bundle.identity).toBeNull();
  });

  it('BASE_NETWORK env=mainnet picks mainnet when opts.network absent (AC-4)', async () => {
    process.env.BASE_NETWORK = 'mainnet';
    const bundle = await createBaseAdapters();
    expect(bundle.chainConfig.chainId).toBe(8453);
  });

  it('BASE_NETWORK absent → testnet bundle (chainId 84532) (AC-5a)', async () => {
    delete process.env.BASE_NETWORK;
    const bundle = await createBaseAdapters();
    expect(bundle.chainConfig.chainId).toBe(84532);
  });

  it("CD-11 — BASE_NETWORK='devnet' → testnet + console.warn called once (AC-5b)", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BASE_NETWORK = 'devnet';

    const b1 = await createBaseAdapters();
    expect(b1.chainConfig.chainId).toBe(84532);

    // Second call should NOT re-warn (warn-once semantics)
    const b2 = await createBaseAdapters();
    expect(b2.chainConfig.chainId).toBe(84532);

    const baseWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('BASE_NETWORK'),
    );
    expect(baseWarns.length).toBe(1);
    expect(String(baseWarns[0][0])).toContain('devnet');
  });
});

describe('Base payment adapter — contract', () => {
  let adapter: BasePaymentAdapter;

  beforeEach(() => {
    _resetWalletClient();
    _resetBaseChain();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.BASE_SEPOLIA_USDC_ADDRESS;
    delete process.env.BASE_MAINNET_USDC_ADDRESS;
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    adapter = new BasePaymentAdapter({ network: 'testnet' });
  });

  afterEach(() => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.WASIAI_MERCHANT_NAME;
    delete process.env.BASE_FACILITATOR_URL;
    delete process.env.CDP_FACILITATOR_URL;
    delete process.env.WASIAI_FACILITATOR_URL;
  });

  it('name is "base"', () => {
    expect(adapter.name).toBe('base');
  });

  it('testnet adapter → chainId 84532', () => {
    expect(adapter.chainId).toBe(84532);
  });

  it('mainnet adapter → chainId 8453', () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    expect(m.chainId).toBe(8453);
  });

  it('getScheme() returns "exact"', () => {
    expect(adapter.getScheme()).toBe('exact');
  });

  it('getNetwork() testnet → "eip155:84532"', () => {
    expect(adapter.getNetwork()).toBe('eip155:84532');
  });

  it('getNetwork() mainnet → "eip155:8453"', () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    expect(m.getNetwork()).toBe('eip155:8453');
  });

  it('supportedTokens[0] → USDC, 6 decimals, Base Sepolia default address', () => {
    expect(adapter.supportedTokens).toHaveLength(1);
    expect(adapter.supportedTokens[0].symbol).toBe('USDC');
    expect(adapter.supportedTokens[0].decimals).toBe(6);
    expect(adapter.supportedTokens[0].address.toLowerCase()).toBe(
      BASE_SEPOLIA_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('supportedTokens mainnet → Base Mainnet USDC default', () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    expect(m.supportedTokens[0].address.toLowerCase()).toBe(
      BASE_MAINNET_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('getToken() respects BASE_SEPOLIA_USDC_ADDRESS env override', () => {
    const customToken = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.BASE_SEPOLIA_USDC_ADDRESS = customToken;
    expect(adapter.getToken().toLowerCase()).toBe(customToken.toLowerCase());
  });

  it('getToken() respects BASE_MAINNET_USDC_ADDRESS env override (mainnet)', () => {
    const customToken = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    process.env.BASE_MAINNET_USDC_ADDRESS = customToken;
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    expect(m.getToken().toLowerCase()).toBe(customToken.toLowerCase());
  });

  it('getMaxTimeoutSeconds() returns 60', () => {
    expect(adapter.getMaxTimeoutSeconds()).toBe(60);
  });

  it('sign() — AC-3 — EIP-712 domain uses chainId 84532 + verifyingContract = USDC Sepolia default', async () => {
    const result = await adapter.sign({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: '1000000',
    });
    expect(result).toHaveProperty('xPaymentHeader');
    expect(result).toHaveProperty('paymentRequest');
    expect(result.paymentRequest.network).toBe('eip155:84532');
    expect(result.paymentRequest.authorization.to).toBe(
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(result.paymentRequest.authorization.value).toBe('1000000');

    // Inspect the mocked signTypedData call to assert domain shape.
    const viem = await import('viem');
    const cwc = (viem.createWalletClient as ReturnType<typeof vi.fn>);
    const clientInstance = cwc.mock.results[0]?.value as {
      signTypedData: ReturnType<typeof vi.fn>;
    };
    const callArgs = clientInstance.signTypedData.mock.calls[0]?.[0] as {
      domain: { name: string; version: string; chainId: number; verifyingContract: string };
    };
    expect(callArgs.domain.chainId).toBe(84532);
    expect(callArgs.domain.name).toBe('USDC'); // Base Sepolia uses 'USDC', NOT 'USD Coin' (§2.3)
    expect(callArgs.domain.version).toBe('2');
    expect(callArgs.domain.verifyingContract.toLowerCase()).toBe(
      BASE_SEPOLIA_USDC_DEFAULT.toLowerCase(),
    );
  });

  it('sign() mainnet uses EIP-712 name "USD Coin" (Base Mainnet)', async () => {
    const m = new BasePaymentAdapter({ network: 'mainnet' });
    await m.sign({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: '1000000',
    });
    const viem = await import('viem');
    const cwc = (viem.createWalletClient as ReturnType<typeof vi.fn>);
    const callArgs = (
      cwc.mock.results.at(-1)?.value as {
        signTypedData: ReturnType<typeof vi.fn>;
      }
    ).signTypedData.mock.calls.at(-1)?.[0] as {
      domain: { name: string; chainId: number };
    };
    expect(callArgs.domain.name).toBe('USD Coin'); // Base Mainnet
    expect(callArgs.domain.chainId).toBe(8453);
  });

  // verify() / settle() — patrón mirror EXACTO de avalanche.test.ts líneas 197-303.
  // Asserts: x402Version=2, scheme='exact', network='eip155:84532', maxTimeoutSeconds=60,
  // extra.assetTransferMethod='eip3009'.
  it('verify() POSTs canonical x402 body and returns valid=true on facilitator OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    const result = await adapter.verify({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '1000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x' + 'a'.repeat(64),
      },
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    expect(result.valid).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/\/verify$/);
    const body = JSON.parse((init as { body: string }).body);
    expect(body.x402Version).toBe(2);
    expect(body.accepted.scheme).toBe('exact');
    expect(body.accepted.network).toBe('eip155:84532');
    expect(body.accepted.maxTimeoutSeconds).toBe(60);
    expect(body.accepted.extra.assetTransferMethod).toBe('eip3009');
  });

  // (replicate verify 500, settle success, settle failure tests from avalanche.test.ts
  // with chainId/network tag adjustments)

  it('uses BASE_FACILITATOR_URL when set (priority 1)', async () => {
    process.env.BASE_FACILITATOR_URL = 'https://base-facilitator.test';
    process.env.CDP_FACILITATOR_URL = 'https://cdp.test';
    process.env.WASIAI_FACILITATOR_URL = 'https://wasiai.test';
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ verified: true }) });
    await adapter.verify({
      authorization: { from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', value: '1000000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + 'a'.repeat(64) },
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    expect(mockFetch.mock.calls[0][0]).toBe('https://base-facilitator.test/verify');
  });

  it('falls back to CDP_FACILITATOR_URL when BASE_FACILITATOR_URL absent (priority 2)', async () => {
    delete process.env.BASE_FACILITATOR_URL;
    process.env.CDP_FACILITATOR_URL = 'https://cdp-facilitator.test';
    process.env.WASIAI_FACILITATOR_URL = 'https://wasiai.test';
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ verified: true }) });
    await adapter.verify({
      authorization: { from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', value: '1000000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + 'a'.repeat(64) },
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    expect(mockFetch.mock.calls[0][0]).toBe('https://cdp-facilitator.test/verify');
  });

  it('falls back to WASIAI_FACILITATOR_URL when BASE+CDP absent (priority 3)', async () => {
    delete process.env.BASE_FACILITATOR_URL;
    delete process.env.CDP_FACILITATOR_URL;
    process.env.WASIAI_FACILITATOR_URL = 'https://shared-facilitator.test';
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ verified: true }) });
    await adapter.verify({
      authorization: { from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', value: '1000000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + 'a'.repeat(64) },
      signature: '0xSIG',
      network: 'eip155:84532',
    });
    expect(mockFetch.mock.calls[0][0]).toBe('https://shared-facilitator.test/verify');
  });

  it('quote() returns QuoteResult with USDC token (6 decimals)', async () => {
    const result = await adapter.quote(1.0);
    expect(result.token.symbol).toBe('USDC');
    expect(result.token.decimals).toBe(6);
    expect(result.token.address.toLowerCase()).toBe(
      BASE_SEPOLIA_USDC_DEFAULT.toLowerCase(),
    );
  });
});

describe('Base gasless adapter — stub', () => {
  beforeEach(() => {
    _resetWalletClient();
    vi.clearAllMocks();
  });

  it('status() returns disabled on testnet', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    const status = await bundle.gasless.status();
    expect(status.enabled).toBe(false);
    expect(status.funding_state).toBe('disabled');
    expect(status.network).toBe('base-sepolia');
    expect(status.chain_id).toBe(84532);
    expect(status.supportedToken).toBeNull();
    expect(status.operatorAddress).toBeNull();
  });

  it('status() returns disabled on mainnet', async () => {
    const bundle = await createBaseAdapters({ network: 'mainnet' });
    const status = await bundle.gasless.status();
    expect(status.enabled).toBe(false);
    expect(status.network).toBe('base-mainnet');
    expect(status.chain_id).toBe(8453);
  });

  it('transfer() throws (not implemented — pending CDP)', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    await expect(
      bundle.gasless.transfer({
        to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
        value: 1000000n,
      }),
    ).rejects.toThrow('Base gasless not implemented');
  });
});

describe('Base attestation adapter — stub', () => {
  it('attest() returns stub txHash + proofUrl and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = await createBaseAdapters({ network: 'testnet' });
    const result = await bundle.attestation.attest({
      type: 'unit-test',
      payload: { foo: 'bar' },
    });
    expect(result.txHash).toBe('0x0');
    expect(result.proofUrl).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('attestation stub'),
    );
    warnSpy.mockRestore();
  });

  it('verify() returns true (stub)', async () => {
    const bundle = await createBaseAdapters({ network: 'testnet' });
    expect(await bundle.attestation.verify({ txHash: '0xDEADBEEF' })).toBe(true);
  });
});
```

**Cobertura mínima de tests** (deben estar todos):
- Factory shape: 7 tests (default testnet, explicit testnet, explicit mainnet, identity null, BASE_NETWORK=mainnet, BASE_NETWORK absent, BASE_NETWORK='devnet' warn-once)
- Payment contract: ~18 tests (name, chainIds testnet/mainnet, scheme, network tag testnet/mainnet, supportedTokens testnet/mainnet, env overrides testnet/mainnet, maxTimeout, **sign EIP-712 domain testnet**, **sign EIP-712 domain mainnet** (name="USD Coin"), verify success/failure, settle success/failure, **facilitator URL priority chain** 3 tests, quote)
- Gasless stub: 3 tests
- Attestation stub: 2 tests

**Total**: ~30 tests.

#### W3.3 — `src/adapters/__tests__/registry.test.ts`

**Acciones**:

**A.** Agregar mock factory para Base después del mock Avalanche (después de línea 63 del archivo actual):

```ts
// Mock the base factory — returns a testnet or mainnet bundle stub depending
// on `opts.network`. Real adapters covered by base.test.ts.
vi.mock('../base/index.js', () => ({
  createBaseAdapters: vi.fn(
    async (opts?: { network?: 'testnet' | 'mainnet' }) => {
      const network = opts?.network ?? 'testnet';
      const chainId = network === 'mainnet' ? 8453 : 84532;
      const name = network === 'mainnet' ? 'Base' : 'Base Sepolia';
      const explorerUrl =
        network === 'mainnet'
          ? 'https://basescan.org'
          : 'https://sepolia.basescan.org';
      return {
        payment: { name: 'base', chainId },
        attestation: { name: 'base', chainId },
        gasless: { name: 'base', chainId },
        identity: null,
        chainConfig: { name, chainId, explorerUrl },
      };
    },
  ),
}));
```

**B.** Actualizar mensaje esperado en los tests existentes que listan supported chains. Hay 2 tests actuales (líneas 96-102 y 198-204):

**Antes** (línea 100):
```ts
"Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet",
```

**Después**:
```ts
"Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet",
```

Aplicar **el mismo cambio** a la línea 201 (otro test que valida el mensaje completo).

**C.** Agregar nuevos tests dentro del último `describe` (al final del archivo, antes del cierre `});`):

```ts
  // ─── WKH-104 / BASE-01: base-sepolia + base-mainnet factory dispatch ───
  describe('WKH-104 — Base factory dispatch', () => {
    it('AC-1 — WASIAI_A2A_CHAINS=base-sepolia → initialized with chainId 84532', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['base-sepolia']);
      expect(getDefaultChainKey()).toBe('base-sepolia');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'Base Sepolia',
        chainId: 84532,
        explorerUrl: 'https://sepolia.basescan.org',
      });
    });

    it('AC-2 — WASIAI_A2A_CHAINS=base-mainnet → initialized with chainId 8453', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-mainnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['base-mainnet']);
      expect(getDefaultChainKey()).toBe('base-mainnet');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'Base',
        chainId: 8453,
        explorerUrl: 'https://basescan.org',
      });
    });

    it('registry passes opts.network=testnet to createBaseAdapters for base-sepolia', async () => {
      const factoryModule = await import('../base/index.js');
      const factorySpy = factoryModule.createBaseAdapters as ReturnType<typeof vi.fn>;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'testnet' });
    });

    it('registry passes opts.network=mainnet to createBaseAdapters for base-mainnet', async () => {
      const factoryModule = await import('../base/index.js');
      const factorySpy = factoryModule.createBaseAdapters as ReturnType<typeof vi.fn>;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-mainnet';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'mainnet' });
    });

    it('CSV multi-chain con base-sepolia coexiste con kite + avalanche', async () => {
      process.env.WASIAI_A2A_CHAINS =
        'kite-ozone-testnet,avalanche-fuji,base-sepolia';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'kite-ozone-testnet',
        'avalanche-fuji',
        'base-sepolia',
      ]);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');

      const base = getAdaptersBundle('base-sepolia');
      expect(base?.chainConfig.chainId).toBe(84532);
    });

    it('AC-6 — unsupported slug "base-typo" throws with Base in supported list', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-typo';
      await expect(initAdapters()).rejects.toThrow(
        /Supported:.*base-sepolia, base-mainnet/,
      );
    });
  });
```

#### W3.4 — Reconfirmar W1.3 tests verdes

```bash
npx vitest run src/adapters/__tests__/chain-resolver.test.ts
```

Esperado: todos verdes (no se rompieron por la extensión Base).

#### W3.5 — Validar W3 completo

```bash
npm run lint
npm test 2>&1 | tail -15
```

**Esperado**:
- Biome 0 errores.
- Tests: `≥1690 passed / 0 failed`. (1660 baseline + ~30 nuevos en `base.test.ts` + ~5 nuevos en `chain-resolver.test.ts` + ~6 nuevos en `registry.test.ts`.)
- **Cero regresiones en avalanche.test.ts, kite-ozone tests, payment.contract.test.ts.**

Si hay regresión → STOP, leer error, NO continuar a W4.

---

### Wave W4 — `.env.example` + build + smoke local

**Goal**: documentar las nuevas env vars, validar `npm run build` con strict, y hacer un smoke local mínimo (sin facilitator real).

#### W4.1 — Extender `.env.example`

**Acción**: agregar la sección Base **después** de la sección Avalanche (después de la línea ~393 del archivo).

Buscar el final de la sección Avalanche con:
```bash
grep -n "Downstream x402 — Avalanche\|^# ============================================================" .env.example | head -10
```

Insertar después de la última línea Avalanche y antes de la siguiente sección:

```env
# ============================================================
# Base — inbound x402 path (WKH-104 / BASE-01)
# ============================================================
# Habilita el adapter Base (chainId 8453 mainnet, 84532 sepolia testnet)
# para inbound x402 USDC EIP-3009 sobre wasiai-a2a. Para activarlo, agregar
# 'base-sepolia' o 'base-mainnet' al CSV WASIAI_A2A_CHAINS arriba.
# Default conservador (CD-4): testnet.

# Selecciona la red Base activa para el adapter (standalone/factory).
# Valores: 'mainnet' | 'testnet' (default 'testnet'). Cualquier otro valor
# es ignorado con console.warn y defaultea a 'testnet'.
BASE_NETWORK=testnet

# RPC público Base Sepolia (chainId 84532) — testnet, default
# https://sepolia.base.org. Override si usás un provider dedicado (Alchemy,
# Infura, QuickNode).
BASE_TESTNET_RPC_URL=https://sepolia.base.org

# RPC público Base Mainnet (chainId 8453) — sólo se lee cuando
# BASE_NETWORK=mainnet. Default https://mainnet.base.org.
BASE_MAINNET_RPC_URL=https://mainnet.base.org

# Dirección USDC en Base Sepolia (default canonical Circle USDC test).
# Si ausente, usa 0x036CbD53842c5426634e7929541eC2318f3dCF7e con warn-once.
BASE_SEPOLIA_USDC_ADDRESS=

# Dirección USDC en Base Mainnet (default canonical Circle USDC).
# Si ausente, usa 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 con warn-once.
BASE_MAINNET_USDC_ADDRESS=

# EIP-712 version override para USDC en Base. Default '2' en ambas redes
# (verified onchain by WKH-105 sibling Dev, 2026-05-19). Sólo setear si
# alguna deployment futura cambia la version. Per-network porque la
# deployment puede diferir (CD-3 escape hatch).
BASE_SEPOLIA_USDC_EIP712_VERSION=
BASE_MAINNET_USDC_EIP712_VERSION=

# Facilitator URL override para Base (verify/settle). Resolución (DT-3):
#   1. BASE_FACILITATOR_URL (esta var — override absoluto, testing)
#   2. CDP_FACILITATOR_URL (placeholder BASE-01, real en BASE-02)
#   3. WASIAI_FACILITATOR_URL (compartido con Avalanche)
#   4. hardcoded https://wasiai-facilitator-production.up.railway.app
BASE_FACILITATOR_URL=

# Placeholder CDP facilitator URL (BASE-02 lo cablea a la URL real cuando
# wasiai-facilitator soporte Base RPC). Dejar vacío en BASE-01.
CDP_FACILITATOR_URL=

# Placeholder CDP API key — sin uso real en BASE-01, reservado para
# integraciones futuras (Paymaster, OnchainKit). NO ponerlo en logs.
CDP_API_KEY=
```

#### W4.2 — `npm run build` verde

```bash
npm run build
```

**Esperado**: `tsc -p tsconfig.build.json` con 0 errores. Si hay errores TS strict → fix antes de continuar.

Verificar zero `any` introducido por la HU:
```bash
grep -rn ": any\b" src/adapters/base/ || echo "OK: no any in src/adapters/base/"
grep -rn "as unknown\b" src/adapters/base/ || echo "OK: no as unknown in src/adapters/base/"
```

**Esperado**: `OK:` en ambos. Si aparece algo → fix.

#### W4.3 — Smoke local Base Sepolia (opcional pero recomendado)

**Pre-req**: `.env.local` con `OPERATOR_PRIVATE_KEY` (test wallet, NO producción).

```bash
# En .env.local:
# WASIAI_A2A_CHAINS=base-sepolia
# BASE_NETWORK=testnet
# OPERATOR_PRIVATE_KEY=0x<test-wallet>

npm run dev &
sleep 3
curl -s http://localhost:3001/.well-known/agent.json | jq .name
# Esperado: el name de tu service

# Smoke request básico — esperamos 402 (Payment Required) con headers x402 v2:
curl -i -X POST http://localhost:3001/compose \
  -H "x-payment-chain: base-sepolia" \
  -H "Content-Type: application/json" \
  -d '{}' | head -30
# Esperado: HTTP/1.1 402 Payment Required (o similar) — NO 500

# Cleanup
pkill -f "npm run dev"
```

**Output**: documentar en `w0-audit.md` § "Smoke local W4.3" con los HTTP status codes literales.

Si recibís 500 → STOP, leer logs, debuggear. Si recibís 402/400 con razón clara → OK (esperado para BASE-01 sin facilitator real).

#### W4.4 — Test suite final

```bash
npm test 2>&1 | tail -5
```

**Esperado**: `≥1690 passed / 0 failed`.

#### W4.5 — Commit + push a branch (NO main)

```bash
git status
git diff --stat
git add src/adapters/base/ src/adapters/types.ts src/adapters/chain-resolver.ts src/adapters/registry.ts src/adapters/__tests__/base.test.ts src/adapters/__tests__/chain-resolver.test.ts src/adapters/__tests__/registry.test.ts .env.example doc/sdd/088-wkh-104-base-adapter/w0-audit.md
git commit -m "$(cat <<'EOF'
feat(WKH-104): BASE-01 adapter (Base Sepolia 84532 + Mainnet 8453)

- 6 new files in src/adapters/base/ (mirror Avalanche pattern)
- Extends ChainKey union, chain-resolver aliases, registry SUPPORTED_CHAINS
- EIP-712 domain name per-network: Sepolia='USDC', Mainnet='USD Coin'
  (verified onchain by sibling WKH-105 — see w0-audit.md)
- ~30 new tests in base.test.ts + extensions in chain-resolver + registry
- Zero regressions: all 1660+ existing tests pass

Refs: doc/sdd/088-wkh-104-base-adapter/
EOF
)"

# NO PUSH a main — push a feat/wkh-base-port-v1:
git push origin feat/wkh-base-port-v1
```

**NO** abrir PR todavía (queda en draft hasta que WKH-105 + WKH-107 estén verdes — estrategia BASE port Fase 1).

---

## 5. Files-to-touch checklist

| # | Path | Acción | Wave | LOC ~ |
|---|------|--------|------|-------|
| 1 | `src/adapters/types.ts` | MODIFY (extender `ChainKey`) | W1.1 | +2 |
| 2 | `src/adapters/chain-resolver.ts` | MODIFY (agregar 6 aliases) | W1.2 | +9 |
| 3 | `src/adapters/__tests__/chain-resolver.test.ts` | EXTEND (nuevos tests Base) | W1.3 | +25 |
| 4 | `src/adapters/base/chain.ts` | CREATE | W2.1 | ~50 |
| 5 | `src/adapters/base/identity.ts` | CREATE | W2.2 | 3 |
| 6 | `src/adapters/base/attestation.ts` | CREATE | W2.3 | ~32 |
| 7 | `src/adapters/base/gasless.ts` | CREATE | W2.4 | ~46 |
| 8 | `src/adapters/base/payment.ts` | CREATE | W2.5 | ~440 |
| 9 | `src/adapters/base/index.ts` | CREATE | W2.6 | ~50 |
| 10 | `src/adapters/registry.ts` | MODIFY (`SUPPORTED_CHAINS` + 2 branches) | W3.1 | +12 |
| 11 | `src/adapters/__tests__/base.test.ts` | CREATE | W3.2 | ~430 |
| 12 | `src/adapters/__tests__/registry.test.ts` | EXTEND (mock Base + tests) | W3.3 | +80 |
| 13 | `.env.example` | EXTEND (nueva sección Base) | W4.1 | +43 |
| 14 | `doc/sdd/088-wkh-104-base-adapter/w0-audit.md` | CREATE (paper trail) | W0.8 | ~50 |

**Total**: ~1273 LOC nuevas, 0 LOC borradas.

### READ-ONLY (NO TOCAR — CD-2)

- `src/adapters/avalanche/**`
- `src/adapters/kite-ozone/**`
- `src/middleware/a2a-key.ts` (chain-agnostic ya — sin cambios)
- Cualquier archivo en `src/routes/`, `src/services/`, `src/types/` (alcance multi-chain ya cubierto)

---

## 6. Test plan detallado — AC → file → test name

> Cada AC debe tener al menos un test ejecutable con `it()` clause exacto.

| AC | Condición | Test file | Test `it()` clause | Wave |
|----|-----------|-----------|---------------------|------|
| **AC-1** | header `base-sepolia` → `'base-sepolia'` | `chain-resolver.test.ts` | `maps base aliases (base, base-testnet) per DT-7 convention` | W1 |
| AC-1 | header `84532` → `'base-sepolia'` | `chain-resolver.test.ts` | `maps Base numeric chainIds to canonical slugs` | W1 |
| AC-1 | registry resuelve bundle | `registry.test.ts` | `AC-1 — WASIAI_A2A_CHAINS=base-sepolia → initialized with chainId 84532` | W3 |
| **AC-2** | header `base-mainnet`/`8453` → `'base-mainnet'` | `chain-resolver.test.ts` | mismos 2 tests arriba | W1 |
| AC-2 | registry resuelve bundle mainnet | `registry.test.ts` | `AC-2 — WASIAI_A2A_CHAINS=base-mainnet → initialized with chainId 8453` | W3 |
| **AC-3** | `sign()` EIP-712 con chainId=84532 + USDC Sepolia | `base.test.ts` | `sign() — AC-3 — EIP-712 domain uses chainId 84532 + verifyingContract = USDC Sepolia default` | W3 |
| AC-3 | name=`'USDC'` Sepolia (verified onchain) | `base.test.ts` | mismo test arriba (assert `domain.name === 'USDC'`) | W3 |
| AC-3 | name=`'USD Coin'` Mainnet (verified onchain) | `base.test.ts` | `sign() mainnet uses EIP-712 name "USD Coin" (Base Mainnet)` | W3 |
| **AC-4** | `BASE_NETWORK=mainnet` → USDC mainnet + `BASE_MAINNET_RPC_URL` | `base.test.ts` | `BASE_NETWORK env=mainnet picks mainnet when opts.network absent (AC-4)` | W3 |
| **AC-5a** | `BASE_NETWORK` absent → testnet | `base.test.ts` | `BASE_NETWORK absent → testnet bundle (chainId 84532) (AC-5a)` | W3 |
| **AC-5b** | `BASE_NETWORK='devnet'` → testnet + warn-once | `base.test.ts` | `CD-11 — BASE_NETWORK='devnet' → testnet + console.warn called once (AC-5b)` | W3 |
| **AC-6** | `WASIAI_A2A_CHAINS` con slug Base inválido → throw con lista supported | `registry.test.ts` | `AC-6 — unsupported slug "base-typo" throws with Base in supported list` | W3 |
| AC-6 | mensaje lista incluye `base-sepolia`, `base-mainnet` | `registry.test.ts` | actualizar test existente `unsupported chain throws...` para incluir el listado completo | W3 |
| **AC-7** | `npm test` ≥1690 passing / 0 failing | manual + CI | comando: `npm test 2>&1 \| tail -5` | W4.4 |
| **AC-8** | `npm run build` 0 errores strict + 0 `any` nuevo | manual | comandos: `npm run build` + `grep ': any' src/adapters/base/` | W4.2 |

### Tests adicionales (no atados directamente a AC pero requeridos por CDs)

| CD | Test | Wave |
|----|------|------|
| CD-12 (consistency) | `explicit testnet → chainId 84532 + CD-12 consistency` y mainnet equivalente | W3 |
| DT-7 (alias 'base') | `maps base aliases ... DT-7 convention` | W1 |
| Facilitator priority | 3 tests `uses BASE_FACILITATOR_URL` / `falls back to CDP_FACILITATOR_URL` / `falls back to WASIAI_FACILITATOR_URL` | W3 |
| Mock factory wiring | `registry passes opts.network=testnet to createBaseAdapters` + mainnet equivalente | W3 |

---

## 7. Completion criteria (cuándo declarás F3 done)

Marcá cada uno antes de pasar al gate AR:

- [ ] W0 ejecutado y `w0-audit.md` commiteado con outputs verbatim de `cast call`
- [ ] W1 ejecutado: `types.ts` + `chain-resolver.ts` extendidos, tests verdes
- [ ] W2 ejecutado: los 6 archivos en `src/adapters/base/` creados, `npm run lint` + `tsc --noEmit` verdes
- [ ] W3 ejecutado: `registry.ts` extendido, `base.test.ts` creado, `registry.test.ts` extendido, `npm test` con ≥1690 passing / 0 failing
- [ ] W4 ejecutado: `.env.example` extendido, `npm run build` verde, smoke local OK (o documentado por qué no se hizo)
- [ ] Commit en branch `feat/wkh-base-port-v1` (no `main`)
- [ ] Cero archivos modificados en `src/adapters/avalanche/` o `src/adapters/kite-ozone/`
- [ ] Cero `any` explícito o `as unknown` en `src/adapters/base/`
- [ ] Cero import de `ethers`
- [ ] `w0-audit.md` final completo + (si corresponde) `auto-blindaje.md` con errores encontrados durante implementación
- [ ] Reporte al orquestador: paths de los archivos modificados/creados, output de `npm test` final, output de `npm run build` final

---

## 8. Auto-Blindaje protocol

Si durante F3 te topás con un error/hallazgo que **el SDD no había anticipado**, documentalo inmediatamente en:

```
doc/sdd/088-wkh-104-base-adapter/auto-blindaje.md
```

Formato sugerido:

```markdown
# Auto-Blindaje — WKH-104

## Bug-N · <Título corto>
- **Fecha**: <YYYY-MM-DD HH:MM>
- **Wave/Step**: W<N>.<step>
- **Síntoma**: <output literal del error>
- **Root cause**: <una línea>
- **Fix aplicado**: <archivo:línea + cambio>
- **Lección transferible**: <qué evitaría que pase de nuevo en futuras HUs>
```

Ejemplos de cosas que SÍ van a `auto-blindaje.md`:
- Un test que asumiste verde y rompió por una interacción imprevista con otro mock
- Una propiedad de viem que no estaba en los exemplars Avalanche pero apareció en Base
- Un fallo de TS strict en un cast que era seguro en Avalanche pero no en Base
- Un comportamiento inesperado del facilitator local durante el smoke W4.3
- Cualquier inconsistencia entre el SDD y el código real que tuviste que resolver

**No** vayan acá:
- Decisiones del SDD (van al SDD, no acá)
- Errores triviales de typo que corregís en el momento

Este artefacto alimenta el **Auto-Blindaje** que va a leer el próximo Architect en F2 para HUs futuras (skill aprendizaje cross-HU).

---

## 9. Resumen ejecutivo (TL;DR para el Dev)

1. **Leé los 13 exemplars listados en §2.1** antes de codear.
2. **Clonás Avalanche → Base** con las substituciones de §4.5 (W2.5).
3. **UNA divergencia crítica**: EIP-712 `name` per-network (Sepolia=`'USDC'`, Mainnet=`'USD Coin'`). Verificado onchain por sibling WKH-105 (§2.3).
4. **CDs no negociables**:
   - CD-2: no tocar Avalanche/Kite
   - CD-1: TS strict, sin `any`
   - CD-7: viem only
   - CD-8: branch `feat/wkh-base-port-v1`, no `main`
5. **Validación final**: `npm test` ≥1690 passing / 0 failing + `npm run build` verde.
6. **Si algo no está en este Story File → STOP, avisar orquestador.** No improvisar.

---

## 10. Referencias

- SDD: `doc/sdd/088-wkh-104-base-adapter/sdd.md`
- Work item: `doc/sdd/088-wkh-104-base-adapter/work-item.md`
- Auto-Blindaje histórico aplicado: `doc/sdd/084-wkh-69-passport-hybrid-inbound/auto-blindaje.md` (CD-10), `doc/sdd/087-wkh-59-real-agent-price-debit/auto-blindaje.md` (CD-11), SDD-086 lessons (CD-12)
- Sibling HU (EIP-712 verification source): `wasiai-facilitator` branch `feat/base-support` commit `7d86b37`
- Exemplar adapter completo: `src/adapters/avalanche/` (6 archivos)
- Exemplar test: `src/adapters/__tests__/avalanche.test.ts` (427 LOC)
