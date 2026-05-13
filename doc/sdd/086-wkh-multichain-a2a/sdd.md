# SDD #086: Multi-chain support en wasiai-a2a (WKH-MULTICHAIN)

> SPEC_APPROVED: no
> Fecha: 2026-05-13
> Tipo: feature
> SDD_MODE: full
> Sizing: QUALITY (payment path, cross-cutting, no downgrade)
> Branch sugerido: `feat/086-wkh-multichain-a2a`
> Artefactos: `doc/sdd/086-wkh-multichain-a2a/`
> Work item: [`work-item.md`](work-item.md)

---

## 1. Resumen ejecutivo

El gateway wasiai-a2a hoy inicializa **una sola chain** (`kite-ozone-testnet`, hardcoded en
`src/adapters/registry.ts:18-35`) y debita el budget del A2A key contra `getChainConfig().chainId`
sin per-request resolution (`src/middleware/a2a-key.ts:180`). Como resultado, llamar `/compose`
contra un agente en Avalanche USDC falla con `INSUFFICIENT_BUDGET: chain 2368 balance is 0`
aunque la key tenga balance en chainId 43113. Este SDD especifica el refactor a un registry
**multi-chain** (`Map<ChainKey, AdaptersBundle>`) inicializado desde CSV `WASIAI_A2A_CHAINS`,
un **chain resolver** per-request en el middleware (header > manifest > default), y un
**adapter Avalanche** (chain + payment + stubs) inspirado en el patrón existente de
`kite-ozone/` y reutilizando la integración con `wasiai-facilitator` self-hosted ya en producción
para downstream (WKH-55). Backward-compat con `WASIAI_A2A_CHAIN` legacy y zero regression sobre
los 379+ tests baseline son no-negociables.

**Resultado esperado**: `/compose` resuelve la chain target del request (header / manifest /
default), debita budget en el `chainId` correcto, devuelve `txHash` cuando settla, y bloquea
con `INSUFFICIENT_BUDGET` o `CHAIN_NOT_SUPPORTED` cuando corresponde. El path Kite existente
permanece byte-idéntico.

---

## 2. Work item (resumen)

| Campo | Valor |
|-------|-------|
| **#** | 086 |
| **Tipo** | feature (infra; payment path) |
| **SDD_MODE** | full |
| **Objetivo** | Soporte simultáneo para `kite-ozone-testnet`, `kite-mainnet`, `avalanche-fuji`, `avalanche-mainnet` en el registry + chain resolver per-request + debit per-chain. |
| **Scope IN** | 16 archivos (ver work-item §Scope IN). 8 nuevos en `src/adapters/avalanche/`, 5 modificados en `src/{adapters,middleware,services}`, 2 tests nuevos, `.env.example`. |
| **Scope OUT** | `src/adapters/kite-ozone/` interno, `wasiai-v2`, `wasiai-facilitator`, `src/middleware/x402.ts`, `src/lib/downstream-payment.ts`, deposit automation, mainnet validation real. |
| **Missing Inputs** | MI-1 (facilitator support Avalanche) → **resuelto §11**; MI-2, MI-3 → ver §11. |

Acceptance Criteria (14, EARS) → ver `work-item.md` §Acceptance Criteria. Se referencian por
identificador (AC-1..AC-14) en §9 Test Plan.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos durante F2

| Archivo | Por qué se leyó | Patrón / hallazgo extraído |
|---------|-----------------|----------------------------|
| `src/adapters/registry.ts` | Punto cero del refactor. Define `SUPPORTED_CHAINS`, getters, lifecycle. | Singleton con 4 nullables + `_initialized`. `initAdapters()` lee `process.env.WASIAI_A2A_CHAIN` y resuelve hardcoded a `kite-ozone-testnet`. Cualquier multi-chain debe preservar las firmas de los getters existentes. |
| `src/adapters/types.ts` | Contratos del adapter. | `PaymentAdapter`, `AttestationAdapter`, `GaslessAdapter`, `IdentityBindingAdapter` ya tienen `readonly chainId: number`. La nueva `AdaptersBundle` agrupa los cuatro + `chainConfig`. |
| `src/adapters/kite-ozone/index.ts` | Exemplar de factory. | `createKiteOzoneAdapters()` retorna `{payment, attestation, gasless, identity, chainConfig}`. Init lazy via `await initClient()` + `await import()` de cada adapter. **Sin parámetros**: lee `KITE_NETWORK` internamente. El nuevo Avalanche replica esta convención. |
| `src/adapters/kite-ozone/chain.ts` | Precedente exacto del patrón multi-network dentro de un mismo adapter. | `kiteTestnet` + `kiteMainnet` con `defineChain()`. Selector `getKiteNetwork()` lee `process.env.KITE_NETWORK`. `getKiteChain()` retorna la chain activa. **Esta convención muere en el contexto multi-chain global**: a partir del W0, la selección por-env-var pasa a ser responsabilidad del registry, no del adapter. Sin embargo, dentro de un adapter compartido (kite-ozone soporta testnet+mainnet), la convención sigue válida internamente. |
| `src/adapters/kite-ozone/payment.ts` | Exemplar para `AvalanchePaymentAdapter`. | Implementa `PaymentAdapter`. Lee `KITE_NETWORK` para network tag (eip155:2368 vs 2366), supportedTokens, EIP-712 domain. Usa `getFacilitatorUrl()` con dos modos (`pieverse` vs `x402`). Lazy `getWalletClient()`. La versión Avalanche es **más simple** porque solo opera en modo `x402` canonical contra `wasiai-facilitator`. |
| `src/adapters/kite-ozone/client.ts` | Patrón de init de viem PublicClient con warn-friendly fallback (RPC ausente → log warn pero permite init). | Lazy init + `getClient()/requireClient()/_resetClient()`. Avalanche puede no inicializar publicClient porque no hay verificaciones onchain en adapter (todas las balance reads están en `downstream-payment.ts`); si se necesita, replicamos el patrón. |
| `src/adapters/kite-ozone/gasless.ts` | Patrón del adapter Gasless (no se replica funcional en Avalanche — stub) | El `GaslessAdapter` interface requiere `status()` que retorna `funding_state`. La versión Avalanche stub devuelve `enabled: false`, `funding_state: 'disabled'`. |
| `src/adapters/kite-ozone/attestation.ts` | Stub mínimo de `AttestationAdapter` (ERC-8004 no implementado todavía). | 17 líneas, devuelve `txHash: '0x0', proofUrl: ''` con `console.warn`. Avalanche replica byte-idéntico, ajustando `chainId`. |
| `src/middleware/a2a-key.ts` (línea 180) | Línea exacta que reemplaza el chain resolver. | `const chainId = getChainConfig().chainId;`. Sus dos call-sites son `budgetService.debit(keyId, chainId, estimatedCostUsd)` y `budgetService.getBalance(keyRow.id, chainId, keyRow.owner_ref)`. Ambos reciben el chainId resuelto del resolver, no del registry global. |
| `src/services/budget.ts` | Confirmar que ya es per-chain. | `getBalance(keyId, chainId, ownerId)`, `debit(keyId, chainId, amountUsd)`, `registerDeposit(keyId, chainId, amountUsd)` todos toman `chainId: number`. El RPC PG `increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` ya es per-chain. **Sin cambios estructurales — only call-site refactor en middleware**. |
| `src/services/discovery.ts` (líneas 56-108) | Normalización de `payment.chain` actual + allowlist. | `ALLOWED_CHAIN_VALUES = ['avalanche', 'avalanche-testnet', 'avalanche-mainnet']`. Normaliza `avalanche-testnet|avalanche-mainnet → avalanche`. Esta normalización es para el **downstream guard** (downstream-payment.ts compara `chain === 'avalanche'`). Para el chain resolver del middleware necesitamos una normalización **separada y más rica** (slug → ChainKey de registry). DT-5 abajo. |
| `src/services/compose.ts` (línea 297) | Confirmar que ya no hay debit duplicado para a2a-key. | Comentario WKH-58: si `a2aKey` está presente, el middleware ya debitó. La sección de x402 inbound + downstream Fuji USDC settle se mantiene intacta. **El compose no toca budget per-chain**: el chainId lo resolvió el middleware antes. |
| `src/lib/downstream-payment.ts` | DT-8: coordinación con la nueva chain selection. | El módulo ya soporta `fuji` y `avalanche-mainnet` via `WASIAI_DOWNSTREAM_NETWORK`. El downstream selecciona chain target del **agente externo** (donde firmamos+envío USDC); no es la chain del **A2A key budget** (que es lo que este SDD agrega). **No se modifica** en este SDD; ambos paths conviven independientemente, ver DT-8 §4. |
| `.env.example` | Inventario de env vars actuales. | Ya tiene `KITE_RPC_URL`, `KITE_MAINNET_RPC_URL`, `KITE_NETWORK`, `FUJI_RPC_URL`, `AVALANCHE_RPC_URL`, `FUJI_USDC_ADDRESS`, `AVALANCHE_USDC_ADDRESS`, `WASIAI_DOWNSTREAM_NETWORK`. Falta: `WASIAI_A2A_CHAINS` (nuevo CSV), `AVALANCHE_FACILITATOR_URL` (opcional, MI-1 resuelta). |
| `src/adapters/__tests__/registry.test.ts` | Tests existentes a actualizar. | Mock de `createKiteOzoneAdapters` retorna el bundle. Tests: default chain, unsupported chain throws, getChainConfig, get*Adapter() not-initialized. Hay que **agregar** tests multi-chain, **mantener** los existentes pasando con la nueva firma. |
| `src/middleware/a2a-key.test.ts` | Tests existentes a actualizar. | Mock de `getChainConfig` retorna `chainId: 2368`. Los tests `expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 1.0)` deben seguir pasando en el path default. Se agregan tests para chain resolver per-request. |

### 3.2 Auto-Blindaje histórico (últimas HUs DONE)

| HU | Auto-Blindaje relevante para este SDD |
|----|---------------------------------------|
| **WKH-69** (084) | "Cross-rootDir imports": tests en `src/` que importan fixtures fuera de `src/` rompen `tsc --noEmit` por `TS6059`. **Aplica a este SDD**: si se usan fixtures cross-chain, mantenerlas en `src/adapters/__tests__/fixtures/` (dentro de rootDir). |
| **WKH-67** (072) | "Decimals separation across guards": prohibir reutilizar un argumento posicional/named en dos checks que operen en chains/tokens con decimales distintos. **Aplica a este SDD**: `budget.debit(keyId, chainId, amountUsd)` toma `amountUsd: number` en USD (no en wei) — el debit es **chain-agnostic dimensionalmente**. Sin embargo, el AR debe verificar que el chainId del debit y el chainId del balance read coinciden con el chain resuelto del request. Ver CD-12 abajo. |
| **WKH-67** (072) "Prototype pollution": usar `Object.hasOwn()` antes de leer propiedades de payloads externos. **Aplica al chain resolver**: si leemos `agent.payment.chain` o `agent.metadata.chain`, usar `Object.hasOwn` en el path donde corresponda. |
| **WKH-86** (082) | "Test mock obsoleto al ampliar manifest": ampliar `SUPPORTED_CHAINS` rompe tests que mockean el set actual. **Aplica a este SDD**: el array `SUPPORTED_CHAINS` pasa de 1 a 4 entries. Los tests del registry deben actualizarse a la nueva firma. |

### 3.3 Estado de BD relevante

| Tabla | Existe | Columnas relevantes | Cambios en este SDD |
|-------|--------|---------------------|---------------------|
| `a2a_agent_keys` | sí | `budget JSONB` (`Record<string(chainId), balance>`), `owner_ref`, `daily_*`, `max_spend_per_call_usd` | **Ninguno**. El JSONB ya es per-chain. |
| RPC `increment_a2a_key_spend` | sí | `(p_key_id, p_chain_id, p_amount_usd)` | **Ninguno**. Ya acepta chainId. |
| RPC `register_a2a_key_deposit` | sí | `(p_key_id, p_chain_id, p_amount_usd)` | **Ninguno**. Sirve para deposit Avalanche manual (CD-10). |

### 3.4 Componentes reutilizables encontrados

- **`createKiteOzoneAdapters()`** → exemplar para `createAvalancheAdapters()`.
- **`kiteTestnet`/`kiteMainnet`** patrón `defineChain` → exemplar para `avalancheFuji`/`avalancheMainnet` (aunque viem ya exporta ambos en `viem/chains`, los re-exportamos via wrapper para ser consistentes con el resto del codebase y centralizar tweaks futuros).
- **`signAndSettleDownstream`** en `src/lib/downstream-payment.ts` → fuente de verdad del flow EIP-3009 contra `wasiai-facilitator`. El nuevo `AvalanchePaymentAdapter` reutiliza la **misma URL del facilitator** y el **mismo body x402 canonical**. No reusamos el módulo directamente (es Scope OUT y opera en otro path), pero el patrón de signing + verify + settle se mimetiza.
- **`KiteOzoneAttestationAdapter`** stub → exemplar para `AvalancheAttestationAdapter`.

---

## 4. Diseño técnico

### 4.1 Arquitectura propuesta

```
┌────────────────────────────────────────────────────────────────────┐
│                        WASIAI_A2A_CHAINS=                          │
│        "kite-ozone-testnet,avalanche-fuji,kite-mainnet"            │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                  ┌──────────────────────────────────┐
                  │      initAdapters() — startup    │
                  │                                  │
                  │  1. parse CSV → ChainKey[]       │
                  │  2. validate vs SUPPORTED_CHAINS │
                  │  3. for each → factory()         │
                  │  4. store in Map<ChainKey,Bundle>│
                  │  5. _defaultChainKey = first     │
                  └──────────────────────────────────┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │            Map<ChainKey, AdaptersBundle>                     │
   │  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────┐  │
   │  │kite-ozone-testnet│  │ avalanche-fuji  │  │ kite-mainnet│  │
   │  │  payment: KO     │  │  payment: Aval  │  │  payment: KO│  │
   │  │  attestation: KO │  │  attestation: A │  │  attest: KO │  │
   │  │  gasless: KO     │  │  gasless: A-stub│  │  gasless: KO│  │
   │  │  identity: null  │  │  identity: null │  │  identity:n │  │
   │  │  chainConfig:2368│  │  chainConfig:43113  │ chainConf:2366│
   │  └─────────────────┘  └──────────────────┘  └─────────────┘  │
   └──────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
   Request: POST /compose                                              
        │                                                              
        ▼                                                              
   ┌───────────────────────────────────────────────────────────────┐  
   │   middleware/a2a-key.ts (refactored)                          │  
   │                                                               │  
   │   chainKey = resolveChainKey({                                │  
   │     headerOverride: req.headers['x-payment-chain'],           │  
   │     agentManifestChain: undefined, // not available here      │  
   │     default: _defaultChainKey,                                │  
   │   })                                                          │  
   │                                                               │  
   │   bundle = registry.getBundle(chainKey)  ← lookup miss → 400  │  
   │                                                               │  
   │   chainId = bundle.chainConfig.chainId                        │  
   │   budgetService.debit(keyRow.id, chainId, $)                  │  
   │   budgetService.getBalance(keyRow.id, chainId, owner)         │  
   │                                                               │  
   │   log: { chainKey, chainId, asset_symbol, ... }               │  
   └───────────────────────────────────────────────────────────────┘  
                                  │
                                  ▼
   ┌───────────────────────────────────────────────────────────────┐
   │   compose.ts                                                  │
   │                                                               │
   │   For each step:                                              │
   │     agent = resolveAgent(step)                                │
   │     // chain ya fue resuelto y debitado en middleware         │
   │     // OPCIONAL FALLBACK (AC-5): si el header NO estuvo y     │
   │     // el agente declara payment.chain, podríamos haber       │
   │     // querido debitar en otra chain.                         │
   │     //                                                        │
   │     // DT-1 (decisión cerrada): el middleware corre ANTES     │
   │     // de resolveAgent. El chain manifest fallback se         │
   │     // computa en el middleware leyendo el agent slug del     │
   │     // body — pero requiere acceso a discoveryService. Para  │
   │     // mantener el middleware liviano (CD-6 <50ms), el        │
   │     // manifest fallback se aplica via header propagation     │
   │     // PRE-middleware desde el cliente (wasiai-v2). Si el     │
   │     // header no llega, el default cubre el caso (AC-6).      │
   └───────────────────────────────────────────────────────────────┘
```

### 4.2 DT — Decisiones técnicas (ratificadas del work-item + nuevas del SDD)

#### Heredadas del work-item

**DT-1 (Chain selection priority)** — RATIFICADO con clarificación.

Orden: `(1) header x-payment-chain explícito > (2) agent manifest payment.chain normalizado > (3) default`.

**Clarificación crítica (nuevo DT-A)**: el **middleware** corre antes de `resolveAgent()`. Por
tanto, el manifest fallback **NO se puede computar en el middleware** sin tirar discovery dentro
del hot path (rompe CD-6 <50ms). El path práctico:

- (1) Header `x-payment-chain` (slug o chainId) → resuelto en middleware. Caso primario en
  producción wasiai-v2 thin-proxy: el v2 sabe la chain del agente target ANTES de mandar el
  request a wasiai-a2a, y propaga el header.
- (2) Manifest fallback → aplicado **fuera del middleware**, en `compose.ts` post-`resolveAgent`,
  **solo cuando el middleware no debitó** (path x402 sin a2a-key). Para a2a-key path, si
  el header no llegó, se debita en el default (3) y se loguea un warning si el agente declara
  una chain distinta. Esto se documenta como expected behaviour para v2.
- (3) Default → primer entry de `WASIAI_A2A_CHAINS` o el legacy `WASIAI_A2A_CHAIN`.

> AC-5 se cumple porque wasiai-v2 propaga el header. Si en el futuro otro caller no propaga,
> el log explícito + el AC-7 (`CHAIN_NOT_SUPPORTED`) le da la pista.

**DT-2 (Adapter registry data structure)** — RATIFICADO + clarificado.

Reemplazar singleton por `Map<ChainKey, AdaptersBundle>`. Getters existentes mantienen su firma
**con parámetro opcional**:

```
getPaymentAdapter(chainKey?: ChainKey): PaymentAdapter
getChainConfig(chainKey?: ChainKey): { name; chainId; explorerUrl }
// idem para getAttestationAdapter, getGaslessAdapter, getIdentityBindingAdapter
```

Sin parámetro → retornar el bundle del **default chain**. **Backward compat 100%** para los
~30 call-sites actuales (verificar con grep en F3 W0).

Nuevo getter explícito: `getAdaptersBundle(chainKey: ChainKey): AdaptersBundle` para call-sites
que necesitan trabajar con un chain específico (middleware resolver).

**DT-3 (Env var contract)** — RATIFICADO.

```
WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji,kite-mainnet
```

`WASIAI_A2A_CHAIN` (singular) legacy: si presente y `WASIAI_A2A_CHAINS` ausente, se trata como
CSV de un elemento. Si ambos presentes, `WASIAI_A2A_CHAINS` gana y se loguea un `warn` al
startup (CD-13 nuevo). Default chain = primer entry, trimeado y lowercased.

**DT-4 (ChainKey schema)** — RATIFICADO.

```ts
type ChainKey =
  | 'kite-ozone-testnet'  // chainId 2368
  | 'kite-mainnet'        // chainId 2366
  | 'avalanche-fuji'      // chainId 43113
  | 'avalanche-mainnet';  // chainId 43114
```

Inmutables. Son claves del JSONB `budget` en Supabase. **Pero**: el JSONB está keyed por
**chainId** (string), no por slug. Confirmado en `budget.getBalance()`:
`budget[chainId.toString()]`. Por tanto, la migración de slug a chainId ocurre en runtime
en el resolver — los slugs son solo las **etiquetas** del registry y los headers.

**DT-5 (Budget storage)** — RATIFICADO sin cambios.

**DT-6 (Avalanche payment adapter)** — RATIFICADO + expandido.

Ver §11 (MI-1 resuelto): el `AvalanchePaymentAdapter` apunta al **wasiai-facilitator** ya en
producción (`https://wasiai-facilitator-production.up.railway.app`), reusando el mismo path
canonical x402 v2 que `downstream-payment.ts`. Variable nueva: `AVALANCHE_FACILITATOR_URL`
(opcional, default `WASIAI_FACILITATOR_URL ?? URL hardcoded de wasiai-facilitator`).

**DT-7 (Deposit Avalanche manual)** — RATIFICADO + procedimiento documentado §10.

**DT-8 (downstream-payment.ts coordination)** — RATIFICADO + clarificado.

Los dos paths conviven independientemente y operan sobre dimensiones disjuntas:

| Path | Direction | Chain selection | Budget impact |
|------|-----------|-----------------|---------------|
| **Inbound debit** (este SDD) | A2A key → wasiai-a2a internal budget | Header `x-payment-chain` / manifest / default | Sí — debit a `a2a_agent_keys.budget[chainId]` |
| **Downstream payment** (WKH-55, ya en prod) | wasiai-a2a operator wallet → external agent | `WASIAI_DOWNSTREAM_NETWORK` env var | No — gasta del operator wallet, on-chain |

Riesgo de confusión cross-path: un caller podría asumir que `x-payment-chain: 43113` también
mueve el downstream a fuji. **NO lo hace**: el downstream se controla por env var process-wide.
Esta separación se documenta explícitamente en `.env.example` + `INTEGRATION.md` (W6).

#### Nuevas decisiones técnicas del SDD

**DT-A (Manifest fallback ubicación)** — Aplicar el fallback de chain por manifest **fuera del
middleware**. Razón: rompe CD-6 <50ms si el middleware tira discovery. wasiai-v2 ya propaga
el header (`x-payment-chain`) según el manifest del agent card. Para callers que no propagan,
se acepta debitar en el default + log warning.

**DT-B (Bundle serialization)** — `AdaptersBundle` es un objeto en memoria, **no se serializa**.
Map keys son strings (slugs). No usar `JSON.stringify(bundle)` ni persistir. Los adapters son
instancias clase con closures sobre wallet clients lazy.

**DT-C (Runtime lookup miss handling)** — Cuando el resolver produce un `chainKey` no presente
en el Map (caller mandó `x-payment-chain: avalanche-mainnet` pero el operador no inicializó
mainnet), retornar HTTP 400 `CHAIN_NOT_SUPPORTED` con mensaje
`Chain '<chainKey>' is not initialized. Initialized: <csv-from-Map.keys()>`. **No silent-fallback**
al default — el caller pidió algo explícito y debemos honrarlo o rechazar.

**DT-D (Chain resolver utility location)** — Crear `src/adapters/chain-resolver.ts` (nuevo
archivo, no listado explícitamente en Scope IN del work-item pero **scope-extension permitido
sin breaking**: el utility es parte del refactor de registry). Función:

```ts
type ResolveInput = {
  headerOverride?: string;     // x-payment-chain raw header
  agentManifestChain?: string; // post-discovery, optional
};
export function resolveChainKey(input: ResolveInput): ChainKey;
export function normalizeChainSlug(raw: string): ChainKey | undefined;
```

**Decisión de scope**: el archivo `src/adapters/chain-resolver.ts` se agrega al Scope IN
implícitamente. F3 Story File lo incluye explícitamente.

**DT-E (Header value format — slug o chainId)** — `x-payment-chain` acepta **ambos**:

- Slug: `avalanche-fuji`, `kite-mainnet`, etc. (canonical, recomendado).
- chainId numérico: `43113`, `2368`, etc. (legacy, soporte por backward-compat con clientes
  que envían el chainId directamente — ver work-item AC-4).

El resolver normaliza con `normalizeChainSlug()`:

```
'43113' → 'avalanche-fuji'
'avalanche-fuji' → 'avalanche-fuji'
'avalanche-testnet' → 'avalanche-fuji'   (alias compat con discovery normalization)
'avalanche' → 'avalanche-fuji'           (alias compat con discovery normalization)
'fuji' → 'avalanche-fuji'                (alias amigable)
'avalanche-mainnet' → 'avalanche-mainnet'
'43114' → 'avalanche-mainnet'
'2368' → 'kite-ozone-testnet'
'kite-testnet' → 'kite-ozone-testnet'    (alias amigable)
'2366' → 'kite-mainnet'
```

Cualquier valor fuera del set conocido → `undefined` → el middleware retorna
`CHAIN_NOT_SUPPORTED` (DT-C).

**DT-F (Avalanche facilitator URL)** — `AVALANCHE_FACILITATOR_URL` opcional. Si ausente, usar
`WASIAI_FACILITATOR_URL` (env existente) o el default literal hardcoded
`https://wasiai-facilitator-production.up.railway.app`. Sin override por chain — la misma URL
sirve fuji y mainnet, el body x402 canonical incluye `network: eip155:43113` o
`network: eip155:43114` y el facilitator routea internamente (confirmado por funcionamiento de
`downstream-payment.ts` en producción).

**DT-G (Logger structure)** — CD-7 del work-item exige `chainKey` (slug) y `chainId` (number)
en logs de debit/getBalance. Usar `request.log` (Fastify) en el middleware. En adapters y
budget service, usar `console.log` o equivalente — el codebase no usa structured logging
global, sólo en Fastify hooks. Compat con el patrón actual.

**DT-H (Test framework)** — vitest. Mockear `createAvalancheAdapters` igual que se mockea
`createKiteOzoneAdapters` en `registry.test.ts:10-22`. Nuevo archivo
`src/adapters/__tests__/avalanche.test.ts` para tests unitarios del adapter Avalanche aislado.

**DT-I (Kite mainnet activation)** — El work-item lista `kite-mainnet` como chain soportada.
Hoy `createKiteOzoneAdapters()` no acepta parámetros y resuelve mainnet vía `KITE_NETWORK` env.
**Decisión**: para integrar al multi-chain registry, evolucionar `createKiteOzoneAdapters` para
aceptar un parámetro opcional `network?: 'testnet' | 'mainnet'`. Si presente, override
`KITE_NETWORK` durante la creación del bundle (sin escribir al `process.env`). Si ausente,
mantener el comportamiento legacy (lee `KITE_NETWORK`).

```ts
export async function createKiteOzoneAdapters(
  opts?: { network?: 'testnet' | 'mainnet' }
): Promise<KiteOzoneAdapters>
```

**CD-3 del work-item permite este cambio** ("additive, never breaking"). Sin parámetro, la
función se comporta igual que hoy. Internamente, los adapters siguen leyendo `KITE_NETWORK` —
pero el registry, antes de invocar `createKiteOzoneAdapters({ network: 'mainnet' })`, **debe
asegurar que `process.env.KITE_NETWORK = 'mainnet'` para esa rama del init**. Esto introduce
acoplamiento entre registry y env, **aceptable solo dentro de `initAdapters()`** (no en hot
path).

**Alternativa rechazada**: refactor de `kite-ozone/chain.ts` para aceptar parámetro de red
explícito en lugar de leer env. **Razón del rechazo**: CD-3 lo bloquea ("NO refactorizar
internamente"). Se acepta la mutación temporal de `process.env.KITE_NETWORK` en
`initAdapters()` con la siguiente nota: la mutación se hace antes del `await import()` del
adapter, por lo que cuando los módulos se cargan ya ven el valor correcto. Si en el futuro
queremos correr testnet+mainnet del MISMO adapter simultáneamente, este approach NO escala
y requiere W1-followup (TD-NEW-KITE-PARAMS).

**TD-NEW-KITE-PARAMS** (documentado pero no implementado): refactor de `kite-ozone/chain.ts`
para que las funciones reciban el network explícito en lugar de leer env. Trackear como
HU separada después del merge.

**DT-J (Asset symbol en logs)** — CD-7 del work-item exige `asset_symbol` en cada log de
debit/getBalance. El budget service hoy no conoce el asset. El middleware sí (post-resolver
tiene el bundle, `bundle.payment.supportedTokens[0].symbol`). Pasamos el `assetSymbol` al
log entry directamente desde el middleware, NO modificamos `budget.ts` para que tome un
parámetro de asset (sería contaminación dimensional — el budget es en USD-equivalente, no en
asset native). Ver AC-11.

### 4.3 CDs — Constraint Directives (ratificadas + nuevas)

#### Heredadas del work-item

**CD-1** OBLIGATORIO TypeScript strict sin `any`/`as unknown` en paths nuevos. RATIFICADO.

**CD-2** OBLIGATORIO backward-compat 100% Kite path. RATIFICADO. F3 W0 audit: correr `npm test`
después del refactor del registry y antes de tocar middleware. Cualquier test que falle es
violación de CD-2.

**CD-3** PROHIBIDO modificar `src/adapters/kite-ozone/` salvo additive en `createKiteOzoneAdapters`.
RATIFICADO + extensión: el cambio del signature es additive (parámetro opcional). Aceptado por
DT-I.

**CD-4** OBLIGATORIO baseline 379+ + nuevos tests cubren: init multi-chain, init legacy
single-chain, chain resolver (header > manifest > default), debit en chain correcta,
INSUFFICIENT_BUDGET con chainId, cross-chain confusion (intentar debitar chain no inicializada).
RATIFICADO. Ver §9 Test Plan.

**CD-5** PROHIBIDO doble debit en mismo step. RATIFICADO. El middleware debita **una vez**
por request; compose nunca llama a `budget.debit` directamente para a2a-key path (se delega
todo al middleware). Para x402 path, sigue sin tocar budget.

**CD-6** OBLIGATORIO chain resolution <50ms overhead. RATIFICADO. Implementación: el resolver
opera **sólo sobre primitives** (string compare contra Set, no I/O). El registry está en
memoria (Map). Sin cache adicional necesario.

**CD-7** OBLIGATORIO logs estructurados `chainKey`, `chainId`, `asset_symbol`. RATIFICADO.
Estructura mínima:

```json
{
  "msg": "a2a-key.debit",
  "chainKey": "avalanche-fuji",
  "chainId": 43113,
  "asset_symbol": "USDC",
  "keyId": "...",
  "amountUsd": 1.0
}
```

**CD-8** PROHIBIDO romper wasiai-v2 producción. RATIFICADO. F4 ejecuta smoke test contra wasiai-v2
prod → wasiai-a2a path.

**CD-9** OBLIGATORIO AR ataque específico cross-chain. RATIFICADO. Ver §7 Riesgos para vectors.

**CD-10** OBLIGATORIO documentar deposit Avalanche manual. RATIFICADO + procedimiento §10.

**CD-11** PROHIBIDO usar `process.env.WASIAI_A2A_CHAIN` directamente en hot path. RATIFICADO.
Todo va por `resolveChainKey()` y `getAdaptersBundle()`.

#### Nuevas del SDD

**CD-12 (AR cross-check)** OBLIGATORIO — En el middleware refactored, el chainId del `debit()`
DEBE provenir del MISMO bundle que el chainId del `getBalance()`. AR/CR verifica con `grep`
que ambos lectura el `chainId` de la misma variable `bundle.chainConfig.chainId` (no de dos
fuentes distintas). Inspirado en auto-blindaje WKH-67 "decimals separation".

**CD-13 (Conflict log)** OBLIGATORIO — Si tanto `WASIAI_A2A_CHAINS` como `WASIAI_A2A_CHAIN`
están seteados al startup, loguear:
`[Registry] WARNING: both WASIAI_A2A_CHAINS and WASIAI_A2A_CHAIN are set. Using WASIAI_A2A_CHAINS=<csv> (singular ignored)`.

**CD-14 (Header normalization is total)** OBLIGATORIO — `normalizeChainSlug` retorna `undefined`
para cualquier input no reconocido. **PROHIBIDO retornar el default chain silenciosamente**.
El caller (middleware) decide qué hacer con `undefined` (en el path `header → undefined`
significa el header tenía un valor, pero no reconocido → 400 `CHAIN_NOT_SUPPORTED`). Si el
header está **ausente** (`undefined` antes de pasar al resolver), el resolver retorna el
default.

**CD-15 (Avalanche adapter scope)** OBLIGATORIO — `AvalanchePaymentAdapter.sign()/verify()/settle()`
ataca **solo** el wasiai-facilitator (modo x402 canonical), sin soporte para modo `pieverse`.
Razón: Pieverse no soporta Avalanche (MI-1 resuelto). `getFacilitatorMode()` no aplica acá.

**CD-16 (No discovery in middleware)** OBLIGATORIO — el middleware NO llama a
`discoveryService.getAgent()` ni a `composeService.resolveAgent()`. El manifest fallback se
delega al cliente upstream (wasiai-v2 propaga el header). CD-6 (<50ms overhead) ya bloquea esto.

**CD-17 (Test isolation)** OBLIGATORIO — `_resetRegistry()` se invoca en `beforeEach` de los
tests del registry. Si se agrega un `_setDefaultChainKey()` test helper, debe ser exportado con
prefijo `_` y documentado como TEST-ONLY.

**CD-18 (No mutación de bundle)** OBLIGATORIO — Los `AdaptersBundle` retornados por
`getAdaptersBundle()` son **immutable references**. PROHIBIDO mutar campos del bundle desde
call-sites externos. Si en el futuro se necesita rotar runtime, debe ser via `_resetRegistry()`
+ `initAdapters()` completo.

**CD-19 (Anti-prototype-pollution)** OBLIGATORIO — Cuando `chain-resolver.ts` lee
`headerOverride` del request, usar `typeof headerOverride === 'string'` antes de
`normalizeChainSlug`. NO usar `??` con valores no-string. Aplicar `Object.hasOwn` si se lee
un valor de un objeto controlado por caller (manifest fallback fuera del middleware).
Lección WKH-67.

### 4.4 Flujo principal (Happy Path) — `/compose` con a2a-key

1. wasiai-v2 thin-proxy detecta que el agente target está en chainId 43113. Set
   `x-payment-chain: avalanche-fuji` en el header del request a wasiai-a2a.
2. Request llega a wasiai-a2a `/compose` con `x-a2a-key: wasi_a2a_xyz`.
3. Middleware `requirePaymentOrA2AKey`:
   - Hash de la key → lookup → keyRow.
   - Validate `is_active`, `daily_limit`, `per_call_limit`.
   - `chainKey = resolveChainKey({ headerOverride: 'avalanche-fuji' })` → `'avalanche-fuji'`.
   - `bundle = registry.getAdaptersBundle('avalanche-fuji')` → existe.
   - `chainId = bundle.chainConfig.chainId` → `43113`.
   - `budgetService.debit(keyRow.id, 43113, 1.0)` → success.
   - `budgetService.getBalance(keyRow.id, 43113, keyRow.owner_ref)` → "X.YZ".
   - Set `x-a2a-remaining-budget: X.YZ`.
   - Log: `{ chainKey: 'avalanche-fuji', chainId: 43113, asset_symbol: 'USDC', keyId, amountUsd }`.
4. Compose flow continúa (resolveAgent, invokeAgent, downstream settle via WKH-55).
5. Response 200 con `txHash` del downstream.

### 4.5 Flujo de error

**E1 — Chain no soportada en header**:

- `x-payment-chain: ethereum-mainnet` → `normalizeChainSlug` → `undefined` → middleware
  responde 400 `CHAIN_NOT_SUPPORTED: Chain 'ethereum-mainnet' is not a recognized slug`.

**E2 — Chain reconocida pero no inicializada en runtime**:

- Operator inicializó `WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji`. Caller envía
  `x-payment-chain: avalanche-mainnet`. `normalizeChainSlug` → `'avalanche-mainnet'` (válido).
  `registry.getAdaptersBundle('avalanche-mainnet')` → undefined. Middleware responde 400
  `CHAIN_NOT_SUPPORTED: Chain 'avalanche-mainnet' is not initialized. Initialized: kite-ozone-testnet, avalanche-fuji`.

**E3 — Budget insuficiente en chain target**:

- A2A key tiene `budget = { '2368': '10.000000', '43113': '0' }`. Caller pide chain 43113.
  `budget.debit(keyId, 43113, 1.0)` → falla → middleware responde 403
  `INSUFFICIENT_BUDGET: chain 43113 balance is 0`.

**E4 — Init startup con CSV inválido**:

- `WASIAI_A2A_CHAINS=kite-ozone-testnet,ethereum-mainnet`. `initAdapters()` throws al startup:
  `Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet`.
  Railway log captura, deploy fail. AC-3.

**E5 — Lookup miss runtime + race condition**:

- Inicialización paralela (race) o reset durante request. `getAdaptersBundle(chainKey)` retorna
  undefined. Middleware responde 400 `CHAIN_NOT_SUPPORTED`. **No 500**: explicit error per CD-7.

---

## 5. Archivos a crear/modificar (consolidado)

| Archivo | Acción | Descripción | Exemplar / referencia |
|---------|--------|-------------|-----------------------|
| `src/adapters/registry.ts` | Modificar | Singleton → `Map<ChainKey, AdaptersBundle>`. Getters con `chainKey?`. `initAdapters()` itera CSV. Mantener firmas para back-compat. | Self-refactor; comparar contra el state anterior. |
| `src/adapters/types.ts` | Modificar | Export `ChainKey`, `AdaptersBundle`. | `src/adapters/kite-ozone/index.ts:10-16` (KiteOzoneAdapters shape). |
| `src/adapters/chain-resolver.ts` | **Crear (DT-D)** | `resolveChainKey()`, `normalizeChainSlug()`. | `src/services/discovery.ts:56-101` (allowlist + normalization pattern). |
| `src/adapters/avalanche/chain.ts` | Crear | `avalancheFuji`/`avalancheMainnet` re-exports + `getAvalancheNetwork()`. | `src/adapters/kite-ozone/chain.ts`. |
| `src/adapters/avalanche/payment.ts` | Crear | `AvalanchePaymentAdapter` (x402 canonical, EIP-3009 USDC). | `src/adapters/kite-ozone/payment.ts` + `src/lib/downstream-payment.ts`. |
| `src/adapters/avalanche/attestation.ts` | Crear | Stub `AvalancheAttestationAdapter`. | `src/adapters/kite-ozone/attestation.ts` (idéntico, swap chainId). |
| `src/adapters/avalanche/gasless.ts` | Crear | Stub `enabled: false`. | `src/adapters/kite-ozone/gasless.ts` (versión minimal — solo `status()`). |
| `src/adapters/avalanche/identity.ts` | Crear | Export `null` (no identity in MVP). | (none — minimal file con un export literal `null`). |
| `src/adapters/avalanche/index.ts` | Crear | `createAvalancheAdapters(opts?)` factory. | `src/adapters/kite-ozone/index.ts:18-34`. |
| `src/adapters/__tests__/registry.test.ts` | Modificar | Update mock + add multi-chain tests + legacy single-chain test + unsupported throws. | Tests existentes en el mismo archivo. |
| `src/adapters/__tests__/avalanche.test.ts` | Crear | Unit tests del factory Avalanche (mock viem clients, validate bundle shape). | `src/adapters/__tests__/payment.contract.test.ts` (pattern existente). |
| `src/middleware/a2a-key.ts` | Modificar | Línea 180: reemplazar `getChainConfig().chainId` por `resolveChainKey` + `getAdaptersBundle`. Logs estructurados (CD-7). | Self-refactor. |
| `src/middleware/a2a-key.test.ts` | Modificar | Tests para header override, default fallback, lookup miss → 400, INSUFFICIENT_BUDGET con chainId. | Tests existentes. |
| `src/services/budget.ts` | **Sin cambios estructurales** | Verificar que el call site del middleware le pasa el chainId resuelto. Solo verification, no edits. | — |
| `src/services/compose.ts` | **Sin cambios funcionales** | El `getPaymentAdapter()` en compose.ts:323 sigue retornando el default (path x402 inbound legacy). Si el caller usa header, el middleware ya debitó; compose no toca budget. Verificar que no hay regresión. | — |
| `src/services/discovery.ts` | Modificar | Asegurar que `payment.chain` y `payment.asset` aparecen en el agent output (AC-10). El `readPayment()` actual ya devuelve estos campos — verificar que el AC se cumple sin cambio o agregar coverage. | Self-check. |
| `.env.example` | Modificar | Agregar `WASIAI_A2A_CHAINS`, `AVALANCHE_FACILITATOR_URL` (opcional), documentar coexistencia con `WASIAI_DOWNSTREAM_NETWORK`. | — |
| `doc/architecture/MULTI-CHAIN.md` | **Crear (W6)** | Documentación del modelo multi-chain + procedimiento deposit + matriz de chains/tokens/facilitators. | (none — nueva doc). |

**Total archivos**: 11 nuevos + 6 modificados = 17 archivos. El work-item listaba 16; agregamos
`src/adapters/chain-resolver.ts` (DT-D) y `doc/architecture/MULTI-CHAIN.md` (CD-10).

---

## 6. Waves de implementación (F3 plan)

### Wave 0 — Adapter abstraction lift (SERIAL, blocking)

**Objetivo**: refactorizar `registry.ts` + `types.ts` para soportar `Map<ChainKey, AdaptersBundle>`
**sin cambiar el comportamiento observable** del path Kite. Después de W0, los tests baseline
deben pasar 100% (CD-2). El path Kite sigue corriendo idéntico.

- [ ] W0.1: Editar `src/adapters/types.ts`: export `ChainKey` type alias + `AdaptersBundle`
  interface.
- [ ] W0.2: Editar `src/adapters/registry.ts`:
  - Reemplazar 4 nullables singleton + `_chainConfig` por `Map<ChainKey, AdaptersBundle>` +
    `_defaultChainKey: ChainKey | null`.
  - `initAdapters()`: parse CSV (`WASIAI_A2A_CHAINS ?? WASIAI_A2A_CHAIN`), iterate, populate Map.
  - Getters mantienen firma + parámetro opcional `chainKey?` que cae al `_defaultChainKey`.
  - Log: `[Registry] Adapters initialized: <comma-separated slugs>` (AC-1).
  - Mensaje de error de unsupported chain: heredar formato actual (AC-3).
  - Conflict warning si ambos env vars presentes (CD-13).
- [ ] W0.3: Crear `src/adapters/chain-resolver.ts` con `resolveChainKey()` + `normalizeChainSlug()`
  (DT-D, DT-E). **No usado todavía en este wave**.
- [ ] W0.4: Editar `src/adapters/__tests__/registry.test.ts`:
  - Actualizar `vi.mock` con el shape nuevo del bundle (mismo shape, accedido vía Map).
  - Tests existentes: garantizar pasen (legacy single-chain path).
  - Agregar: AC-1 (CSV con dos chains), AC-3 (unsupported chain throws con lista completa),
    AC-2 (legacy `WASIAI_A2A_CHAIN` solo).
- [ ] W0.5: `npm test` → expected 379+ passing, 0 fail, los tests del registry expandidos.
- [ ] **Gate W0 → W1**: `npm test` PASS sin warnings, `tsc --noEmit` clean.

### Wave 1 — Avalanche adapter (PARALELIZABLE post-W0)

- [ ] W1.1: Crear `src/adapters/avalanche/chain.ts` (≤30 líneas). Re-export viem `avalanche`,
  `avalancheFuji`. Export `getAvalancheNetwork()` (lee `process.env.AVALANCHE_NETWORK ?? 'fuji'`
  pero el registry pasa el network explícito al factory). Export `AvalancheNetwork` type.
- [ ] W1.2: Crear `src/adapters/avalanche/attestation.ts` (≤25 líneas). Stub con
  `chainId: 43113` (default fuji) o `chainId: 43114` (mainnet) según parámetro. Mismo shape
  que `kite-ozone/attestation.ts`.
- [ ] W1.3: Crear `src/adapters/avalanche/gasless.ts` (≤80 líneas). Solo implementa `status()`
  con `enabled: false, funding_state: 'disabled'`. `transfer()` throws
  `Error('Avalanche gasless not implemented')` (sin uso esperado en este sprint).
- [ ] W1.4: Crear `src/adapters/avalanche/identity.ts` (≤5 líneas). Export literal `null`.
- [ ] W1.5: Crear `src/adapters/avalanche/payment.ts` (~300 líneas). `AvalanchePaymentAdapter`
  implementa `PaymentAdapter`:
  - `name = 'avalanche'`
  - `chainId` dinámico según network (43113/43114).
  - `supportedTokens` → USDC + decimals 6 + address per network.
  - `getScheme()` → `'exact'`. `getNetwork()` → `eip155:43113` o `eip155:43114`.
  - `getToken()` → USDC address (canonical Circle o override env).
  - `getMaxTimeoutSeconds()` → 60.
  - `getMerchantName()` → `WASIAI_MERCHANT_NAME ?? 'WasiAI'`.
  - `sign()` → EIP-3009 TransferWithAuthorization signing usando viem walletClient
    (mirror exact de `downstream-payment.ts` líneas 564-584).
  - `verify()` / `settle()` → POST al wasiai-facilitator canonical x402 v2.
  - Lazy wallet client + lazy public client (replicar patrón).
  - `_resetWalletClient()` export para tests.
- [ ] W1.6: Crear `src/adapters/avalanche/index.ts`. `createAvalancheAdapters(opts?)`
  factory que retorna `AdaptersBundle` con los 4 adapters + chainConfig (`name: 'Avalanche Fuji'`
  o `'Avalanche Mainnet'`, `chainId`, `explorerUrl: 'https://testnet.snowtrace.io'` o
  `'https://snowtrace.io'`).
- [ ] W1.7: Crear `src/adapters/__tests__/avalanche.test.ts`. Tests del factory:
  - Default chain → adapters con chainId 43113.
  - Network override mainnet → adapters con chainId 43114.
  - `payment.supportedTokens[0]` tiene symbol USDC, decimals 6.
  - `gasless.status()` retorna `enabled: false`.
  - `identity` es `null`.
- [ ] W1.8: **Conectar el factory al registry**. En `registry.ts`, la rama para
  `'avalanche-fuji'` y `'avalanche-mainnet'` llama a `createAvalancheAdapters({ network })`.
- [ ] W1.9: `npm test` → 379+ baseline + nuevos tests Avalanche PASS.
- [ ] **Gate W1 → W2**: avalanche tests green, registry tests green.

### Wave 2 — Chain resolver middleware (depende de W0+W1)

- [ ] W2.1: Editar `src/middleware/a2a-key.ts` línea 180:
  - Reemplazar `const chainId = getChainConfig().chainId;` por:
    ```
    const chainKey = resolveChainKey({
      headerOverride: typeof request.headers['x-payment-chain'] === 'string'
        ? request.headers['x-payment-chain']
        : undefined,
    });
    if (!chainKey) {
      return reply.status(400).send({
        error_code: 'CHAIN_NOT_SUPPORTED',
        message: `Chain '${request.headers['x-payment-chain']}' is not a recognized slug`,
      });
    }
    const bundle = registry.getAdaptersBundle(chainKey);
    if (!bundle) {
      return reply.status(400).send({
        error_code: 'CHAIN_NOT_SUPPORTED',
        message: `Chain '${chainKey}' is not initialized. Initialized: ${registry.getInitializedChainKeys().join(', ')}`,
      });
    }
    const chainId = bundle.chainConfig.chainId;
    const assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN';
    ```
  - Update logs: `request.log.info({ chainKey, chainId, asset_symbol: assetSymbol, keyId: keyRow.id, amountUsd: estimatedCostUsd }, 'a2a-key.debit')`.
  - Update INSUFFICIENT_BUDGET error message to include chainId: `chain <chainId> balance is <balance>`. Actualmente, `debit()` retorna `{ success, error }` con el mensaje genérico del PG. **Sugerencia**: enriquecer el mensaje a nivel middleware:
    ```
    if (!debitResult.success) {
      // AC-8 + CD-7: include chainId in user-facing error
      const balance = await budgetService.getBalance(keyRow.id, chainId, keyRow.owner_ref).catch(() => '0');
      return send403(reply, 'INSUFFICIENT_BUDGET', `chain ${chainId} balance is ${balance}`);
    }
    ```
  - **Cuidado**: el path actual lee balance DESPUÉS del debit success para reply header. Acá leemos ANTES (en el error path) para enriquecer. Es una llamada extra solo en el error path (cold), no degrada el happy path.
- [ ] W2.2: Editar `src/middleware/a2a-key.test.ts`:
  - Update mock de `registry.js` para exportar el nuevo `getAdaptersBundle` + `getInitializedChainKeys`.
  - Mantener: AC-1 happy path (debit con chainId 2368 — el default).
  - Agregar: header `x-payment-chain: avalanche-fuji` → debit en chainId 43113.
  - Agregar: header `x-payment-chain: ethereum-mainnet` → 400 `CHAIN_NOT_SUPPORTED`.
  - Agregar: header `x-payment-chain: avalanche-mainnet` con registry initialized solo
    para fuji → 400 `CHAIN_NOT_SUPPORTED` con mensaje `Initialized: kite-ozone-testnet, avalanche-fuji`.
  - Agregar: header ausente → debit en default chain.
  - Agregar: chainId numérico en header (`x-payment-chain: 43113`) → resuelve a avalanche-fuji.
- [ ] W2.3: `npm test` → all PASS.

### Wave 3 — Multi-chain budget validation + cross-chain tests (depende de W2)

- [ ] W3.1: Auditar `src/services/budget.ts` y todos los call-sites con `grep -n "budgetService.debit\|budgetService.getBalance"`. Verificar que el chainId pasado es el resuelto del request, **no** un valor del registry global.
- [ ] W3.2: Agregar test cross-chain confusion en `src/middleware/a2a-key.test.ts`:
  - Key con budget en chain 2368 únicamente. Request con `x-payment-chain: avalanche-fuji`.
    `mockDebit` configurado para failar en chain 43113. Esperar 403 INSUFFICIENT_BUDGET
    con mensaje `chain 43113 balance is 0` (AC-8).
- [ ] W3.3: Agregar test "double debit prevention" — request única con dos pasos en compose →
  middleware debita UNA vez. Verificar con `expect(mockDebit).toHaveBeenCalledTimes(1)`.
  (CD-5)
- [ ] W3.4: `npm test` → all PASS.

### Wave 4 — Discovery enrichment (AC-10)

- [ ] W4.1: Auditar `src/services/discovery.ts:295-328` `mapAgent()`. **Confirmar** que
  `agent.payment` ya está en el output (vía `readPayment(raw)` línea 327). Si sí, **no hay
  cambios**, solo agregar coverage en test.
- [ ] W4.2: Agregar test en `src/services/discovery.test.ts` (existente):
  - Mock registry response con `payment: { method: 'x402', chain: 'avalanche-testnet', contract: '0x...', asset: 'USDC' }`.
  - Llamar a `discoveryService.discover({})`.
  - Esperar `result.agents[0].payment` populated con chain normalized a `'avalanche'` y
    asset `'USDC'`.
- [ ] W4.3: `npm test` → PASS.

### Wave 5 — Mainnet support wiring (kite-mainnet + avalanche-mainnet)

- [ ] W5.1: Editar `src/adapters/kite-ozone/index.ts`: agregar `opts?: { network?: 'testnet' | 'mainnet' }` a `createKiteOzoneAdapters`. Si `opts?.network === 'mainnet'`, `process.env.KITE_NETWORK = 'mainnet'` ANTES del `await import()` de cada submódulo (DT-I).

  **Importante**: mutar `process.env.KITE_NETWORK` solo si NO está ya seteado al valor correcto, para evitar contention en testing. Documentar la mutación in-line.
- [ ] W5.2: En `src/adapters/registry.ts`, rama `'kite-mainnet'` llama a `createKiteOzoneAdapters({ network: 'mainnet' })`. Rama `'avalanche-mainnet'` llama a `createAvalancheAdapters({ network: 'mainnet' })`.
- [ ] W5.3: Agregar tests en `registry.test.ts`:
  - `WASIAI_A2A_CHAINS=kite-mainnet,avalanche-mainnet` → init both, default = `kite-mainnet`.
  - `getAdaptersBundle('kite-mainnet').chainConfig.chainId === 2366`.
  - `getAdaptersBundle('avalanche-mainnet').chainConfig.chainId === 43114`.
- [ ] W5.4: `npm test` → PASS. **No se valida contra mainnet real** (Scope OUT).

### Wave 6 — Documentation

- [ ] W6.1: Editar `.env.example`:
  - Agregar bloque `WASIAI_A2A_CHAINS`:
    ```
    # ─── Multi-chain registry (WKH-MULTICHAIN / 086) ──────────────
    # CSV de chains a inicializar al startup. Default = primer entry.
    # Slugs soportados: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet.
    # Backward-compat: si esta var está ausente, se usa WASIAI_A2A_CHAIN (legacy single).
    WASIAI_A2A_CHAINS=kite-ozone-testnet
    ```
  - Agregar `AVALANCHE_FACILITATOR_URL=` (opcional, default = `WASIAI_FACILITATOR_URL` ?? hardcoded URL prod).
  - Agregar nota explícita sobre coexistencia con `WASIAI_DOWNSTREAM_NETWORK`.
- [ ] W6.2: Crear `doc/architecture/MULTI-CHAIN.md` con:
  - Modelo multi-chain (Map + registry + resolver).
  - Matriz: ChainKey | chainId | RPC env var | USDC address | facilitator URL.
  - Procedimiento deposit Avalanche manual (CD-10) — ver §10 del SDD.
  - Procedimiento de activación mainnet (Kite y Avalanche).
  - Cómo agregar una nueva chain (checklist post-merge).
- [ ] W6.3: Actualizar `README.md` brevemente (no exhaustivo): un párrafo "Multi-chain support" con link a `MULTI-CHAIN.md`.

---

## 7. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| **R-1: Regresión en path Kite** (CD-2 violation) | M | A (rompe wasiai-v2 prod) | F3 W0 gate: `npm test` 100% green antes de W1. F4 smoke test contra wasiai-v2 prod path. |
| **R-2: Race condition init multi-chain** | M | M | `initAdapters()` es serial (await por chain). Cualquier init failure tira el startup completo (Railway re-deploy). No hay path lazy de init runtime (todo al boot). |
| **R-3: Cross-chain confusion (debit en chain Y, balance en chain X)** | A | A (pérdida silenciosa de dinero) | CD-12 (mismo bundle source para debit y getBalance) + AR explícito CD-9(a) + test cross-chain confusion (W3.2). |
| **R-4: Mutación env `KITE_NETWORK` en init** | M | M | DT-I documentado. Solo se muta dentro de `initAdapters()` y antes del lazy import. F3 verifica que el comportamiento del registry es determinístico. TD-NEW-KITE-PARAMS trackea cleanup futuro. |
| **R-5: Facilitator no soporta Avalanche** | B | A | **Resuelto MI-1 §11**: `wasiai-facilitator` ya soporta avalanche-fuji y avalanche-mainnet (downstream-payment.ts en prod desde WKH-55). |
| **R-6: Header `x-payment-chain` con chainId numérico colisiona con slug** | B | B | `normalizeChainSlug` mapea ambos (DT-E). Test explícito en W2.2. |
| **R-7: Default chain change breaking** | M | M | Default = primer entry del CSV. Si el operador cambia el orden, default cambia. Documentar en `.env.example` y `MULTI-CHAIN.md`. |
| **R-8: Discovery normalization conflict** | B | M | El resolver de discovery (`discovery.ts:56-101`) y el resolver del middleware (`chain-resolver.ts`) son **independientes**. Discovery normaliza a `'avalanche'` para downstream guard; middleware normaliza a `ChainKey`. Documentar la dualidad. |
| **R-9: Vector de ataque IDOR cross-chain** | B | A | `getBalance` ya valida `owner_ref` (WKH-53). El middleware sigue pasando `keyRow.owner_ref`. AR-CD-9(e) confirma. |
| **R-10: Operator wallet sin USDC Fuji en hackathon** | M | A | CD-10 + §10 documenta procedimiento deposit. Smoke test pre-demo. |

---

## 8. Dependencias

- **wasiai-facilitator** en `wasiai-facilitator-production.up.railway.app` debe estar UP (CHECK pre-merge).
- **Operator wallet** (`OPERATOR_PRIVATE_KEY`) con USDC en Fuji para smoke test (deposit manual, §10).
- **wasiai-v2 thin-proxy** debe propagar `x-payment-chain` header al targear agentes Avalanche. Si no lo hace, debito cae al default (kite-ozone-testnet) — comportamiento esperado, no bug, pero documentado en `MULTI-CHAIN.md`.
- **Supabase RPC** `increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` y `register_a2a_key_deposit` (verificados existen, sin migración nueva).

---

## 9. Test Plan (mínimo 1 test por AC)

| AC | Test name | Wave | Archivo | Cubre |
|----|-----------|------|---------|-------|
| AC-1 | `init multi-chain CSV — both bundles present` | W0 | `registry.test.ts` | Init con CSV de dos chains, log esperado, ambos bundles accesibles. |
| AC-2 | `init legacy WASIAI_A2A_CHAIN — single bundle present` | W0 | `registry.test.ts` | Init solo con var singular, default es esa chain, getChainConfig() identical a pre-WKH-MULTICHAIN. |
| AC-3 | `init throws on unsupported chain — message lists all` | W0 | `registry.test.ts` | `WASIAI_A2A_CHAINS=ethereum-mainnet` → throw con mensaje exacto. |
| AC-4 | `middleware header x-payment-chain: 43113 → debit on chain 43113` | W2 | `a2a-key.test.ts` | Header chainId numérico, resolver mapea, debit con chainId 43113. |
| AC-5 | `middleware default fallback when no header — debit on default chain` | W2 | `a2a-key.test.ts` | Sin header → debit en default = primer chain del CSV. (Nota: el fallback manifest se delega al cliente; el AC-5 se cumple via header propagation desde wasiai-v2). |
| AC-6 | `middleware no chain → default fallback` | W2 | `a2a-key.test.ts` | Misma cobertura que AC-5; test específico AC-6 valida default es primer entry. |
| AC-7 | `middleware unknown chainKey → 400 CHAIN_NOT_SUPPORTED` | W2 | `a2a-key.test.ts` | Header con slug inválido → 400 + body con error_code. |
| AC-7-bis | `middleware initialized chain miss → 400 with Initialized list` | W2 | `a2a-key.test.ts` | Header `avalanche-mainnet`, registry init solo fuji → 400 + lista de chains iniciadas. |
| AC-8 | `INSUFFICIENT_BUDGET error message includes chainId` | W3 | `a2a-key.test.ts` | `mockDebit` falla con chainId 43113 → error message `chain 43113 balance is 0`. |
| AC-9 | `single compose request → single debit call (no double charge)` | W3 | `a2a-key.test.ts` | Asserts `mockDebit.toHaveBeenCalledTimes(1)`. |
| AC-10 | `discover returns payment.chain and payment.asset` | W4 | `discovery.test.ts` | Mock registry response → result.agents[i].payment populated. |
| AC-11 | `structured log includes chainKey, chainId, asset_symbol` | W2 | `a2a-key.test.ts` | Spy en `request.log.info`, esperar shape del log entry. |
| AC-12 | `npm test full suite — 379+ tests + new passes` | W5/W6 | `package.json` test | Run `npm test`, count >= 379 + new. F4 captura conteo exacto. |
| AC-13 | `smoke wasiai-v2 prod path Kite — unchanged response shape` | F4 (post-deploy) | manual + scripted | F4 corre `bash scripts/smoke-prod-kite.sh` (existe via WKH-77/82). |
| AC-14 | `smoke Avalanche Fuji — txHash returned` | F4 (post-deploy) | manual | F4 corre compose contra test agent en Fuji con USDC depositado. |

**Tests adicionales (no mapped a AC pero requeridos por CDs):**

| Test | CD | Wave | Archivo |
|------|----|------|---------|
| `Avalanche payment adapter — chainId, scheme, network` | DT-6 | W1 | `avalanche.test.ts` |
| `Avalanche factory — bundle shape, USDC asset` | W1 | W1 | `avalanche.test.ts` |
| `Avalanche mainnet wiring` | W5 | W5 | `registry.test.ts` |
| `Kite mainnet wiring (createKiteOzoneAdapters with network=mainnet)` | DT-I | W5 | `registry.test.ts` |
| `Conflict log when both env vars set` | CD-13 | W0 | `registry.test.ts` |
| `Cross-chain confusion: key budget on 2368, request on 43113 → 403` | CD-9, R-3 | W3 | `a2a-key.test.ts` |
| `Resolver: chainId numeric '43113' → avalanche-fuji` | DT-E | W2 | `chain-resolver.test.ts` (NEW) o inline en `a2a-key.test.ts` |
| `Resolver: alias 'fuji'/'avalanche-testnet' → avalanche-fuji` | DT-E | W2 | idem |

**Test count delta**: ~14 nuevos tests mínimo. Baseline 379 + 14 = 393+ esperado al final F3.

---

## 10. Procedimiento Deposit Avalanche manual (CD-10)

Para fondear una A2A key con USDC Fuji antes del hackathon (smoke test AC-14):

**Pre-requisitos:**
- Wallet con USDC Fuji (faucet: https://faucet.circle.com/ — selecciona Avalanche Fuji).
- `OPERATOR_PRIVATE_KEY` del wasiai-a2a operator (Railway env).
- `WASIAI_A2A_KEY_ID` del key target (UUID de `a2a_agent_keys.id`).

**Procedimiento:**

1. **Confirmar registry inicializado**: deploy de wasiai-a2a con
   `WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji`. Verificar log de startup
   `[Registry] Adapters initialized: kite-ozone-testnet, avalanche-fuji`.

2. **Verificar operator wallet en Fuji**: tx scanner snowtrace.io/<operator_address>. Operator
   debe tener USDC Fuji para downstream (separate concern; el deposit del A2A key budget es
   una operación de BD, no on-chain).

3. **Insertar deposit en BD**:
   ```sql
   -- via Supabase SQL editor, dev project bdwvrwzvsldephfibmuu
   SELECT register_a2a_key_deposit(
     '<KEY_ID_UUID>'::uuid,  -- p_key_id
     43113,                   -- p_chain_id (Fuji)
     10.0                     -- p_amount_usd (10 USDC equivalent)
   );
   ```
   Retorna el nuevo balance JSONB.

4. **Verificar via API**:
   ```bash
   curl -X POST https://wasiai-a2a-production.up.railway.app/auth/budget \
     -H "x-a2a-key: <THE_KEY>" \
     -H "x-payment-chain: avalanche-fuji"
   # Esperar: { "chainId": 43113, "balance": "10.000000" }
   ```

5. **Smoke test compose contra Fuji agent**:
   ```bash
   curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
     -H "x-a2a-key: <THE_KEY>" \
     -H "x-payment-chain: avalanche-fuji" \
     -d '{"steps": [{"agent": "<fuji-agent-slug>", "input": {...}}]}'
   # Esperar: response con txHash del downstream USDC settle.
   ```

**Para mainnet (smoke post-merge, fuera del hackathon)**:
- USDC mainnet (chainId 43114, contrato `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`).
- `register_a2a_key_deposit(<KEY_ID>, 43114, <amount>)`.
- Operator wallet con USDC en C-Chain mainnet (snowtrace.io).
- `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` o que el agente declare chain
  `avalanche-mainnet`.

**Para Kite mainnet (post-merge)**:
- Operator wallet con USDC.e en Kite mainnet (`0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`).
- `register_a2a_key_deposit(<KEY_ID>, 2366, <amount>)`.
- `KITE_NETWORK=mainnet` (legacy var) + `KITE_MAINNET_RPC_URL=https://rpc.gokite.ai/`.

---

## 11. Missing Inputs — Resolución

### MI-1 — Facilitator support Avalanche **RESUELTO**

**Pregunta original (work-item)**: el facilitator actual (`KITE_FACILITATOR_URL`, Pieverse)
¿soporta Avalanche Fuji? ¿O se necesita `AVALANCHE_FACILITATOR_URL` separado?

**Análisis** (lectura de `src/lib/downstream-payment.ts` líneas 187-192 + producción WKH-55):

- El módulo `signAndSettleDownstream` (en producción desde WKH-55, 2026-04-24) hace
  POST a `${WASIAI_FACILITATOR_URL}/verify` y `/settle` (default
  `https://wasiai-facilitator-production.up.railway.app`) para chains **fuji** Y
  **avalanche-mainnet** indistintamente. El facilitator detecta la chain via el body
  canonical x402 v2 (`accepted.network: 'eip155:43113'` o `'eip155:43114'`).
- Pieverse facilitator (`KITE_FACILITATOR_DEFAULT_URL = 'https://facilitator.pieverse.io'`)
  **NO** se usa para Avalanche; es exclusivo del path Kite (`KITE_FACILITATOR_MODE=pieverse`).
- Conclusión: el `AvalanchePaymentAdapter` usa el **wasiai-facilitator** self-hosted (mismo
  endpoint que `downstream-payment.ts`). La integración ya está probada en producción para
  ambos chains.

**Decisión arquitectónica**:

- **DT-F**: Nueva env var `AVALANCHE_FACILITATOR_URL` (opcional). Si ausente, fallback a
  `WASIAI_FACILITATOR_URL` (env existente usado por downstream). Si también ausente, fallback
  a hardcoded literal `https://wasiai-facilitator-production.up.railway.app`. Sin variantes
  per-chain (fuji vs mainnet): la misma URL sirve ambas; el routing lo hace el facilitator.

**Status**: MI-1 **resuelto**. Sin NEEDS CLARIFICATION pendiente.

### MI-2 — Attestation Avalanche ERC-8004 **RESUELTO**

**Decisión**: stub minimal (`AvalancheAttestationAdapter` retorna `txHash: '0x0'`, `proofUrl: ''`
con `console.warn`). Same shape que `KiteOzoneAttestationAdapter`. ERC-8004 fuera de scope MVP.

### MI-3 — Normalización de `payment.chain` **RESUELTO en DT-E**

**Decisión**: el resolver acepta los siguientes aliases para `avalanche-fuji`:
`avalanche-fuji`, `avalanche-testnet`, `avalanche`, `fuji`, `43113`.

Para `avalanche-mainnet`: `avalanche-mainnet`, `43114`.

Para `kite-ozone-testnet`: `kite-ozone-testnet`, `kite-testnet`, `2368`.

Para `kite-mainnet`: `kite-mainnet`, `2366`.

Cualquier otro valor → undefined → 400 CHAIN_NOT_SUPPORTED.

### MI-4 — Product context **N/A**

No hay product-context.md. Esta HU es infra pura.

---

## 12. Exemplars verificados (con paths reales — confirmados con Glob/Read)

| Para crear/modificar | Seguir patrón de | Verificado | Razón |
|---------------------|------------------|------------|-------|
| `src/adapters/avalanche/chain.ts` | `src/adapters/kite-ozone/chain.ts` | sí (Read) | `defineChain` + selector function pattern. |
| `src/adapters/avalanche/payment.ts` | `src/adapters/kite-ozone/payment.ts` + `src/lib/downstream-payment.ts` | sí (Read both) | PaymentAdapter shape de kite + EIP-3009 sign + facilitator interaction de downstream. |
| `src/adapters/avalanche/attestation.ts` | `src/adapters/kite-ozone/attestation.ts` | sí (Read) | Stub mínimo. |
| `src/adapters/avalanche/gasless.ts` | `src/adapters/kite-ozone/gasless.ts` | sí (Read) | Pero solo el shape de `status()` — el `transfer()` se throws Error. |
| `src/adapters/avalanche/index.ts` | `src/adapters/kite-ozone/index.ts` | sí (Read) | Factory pattern. |
| `src/adapters/chain-resolver.ts` (nuevo) | `src/services/discovery.ts:56-101` (normalization pattern) | sí (Read) | Allowlist + normalization total. |
| `src/adapters/registry.ts` refactor | self (state actual) + `src/adapters/kite-ozone/index.ts` (KiteOzoneAdapters interface shape como base para AdaptersBundle) | sí | — |
| `src/adapters/__tests__/avalanche.test.ts` (nuevo) | `src/adapters/__tests__/registry.test.ts` + `src/adapters/__tests__/payment.contract.test.ts` | sí (Read registry.test) | vi.mock pattern + describe/it organization. |
| `.env.example` block | self (existing blocks 102-125 KITE_NETWORK + 316-358 WASIAI_DOWNSTREAM_NETWORK) | sí (Read) | Comment style + section headers. |
| `doc/architecture/MULTI-CHAIN.md` (nuevo) | `doc/architecture/` (existing docs no leídos en este SDD; F3 elige exemplar) | parcial | F3 puede consultar otros docs en architecture/. |

**Imports verificados**:

- `viem` → ya en `package.json` (usado en kite-ozone/payment.ts y downstream-payment.ts).
- `viem/chains` → `avalanche`, `avalancheFuji` ya importados en `downstream-payment.ts:19`.
- `viem/accounts` → `privateKeyToAccount` ya usado en payment.ts:18.
- `Fastify` ya en uso.
- `vitest` ya en uso (registry.test.ts).

---

## 13. Readiness Check

```
READINESS CHECK — F2 SDD WKH-MULTICHAIN
[x] Cada AC tiene al menos 1 archivo asociado en §5 y test en §9
[x] Cada archivo en §5 tiene un Exemplar verificado (§12)
[x] No hay [NEEDS CLARIFICATION] pendientes (MI-1, MI-2, MI-3 resueltos en §11)
[x] Constraint Directives incluyen al menos 3 PROHIBIDO (CD-1, CD-3, CD-5, CD-11, CD-14, CD-15,
    CD-16, CD-18, CD-19 = 9 PROHIBIDO + 10 OBLIGATORIO)
[x] Context Map tiene al menos 2 archivos leídos (§3.1: 17 archivos)
[x] Scope IN y OUT son explícitos (work-item §Scope IN/OUT + §5 SDD)
[x] Tablas verificadas que existen (§3.3: a2a_agent_keys, RPCs)
[x] Flujo principal (§4.4) completo
[x] Flujo de error (§4.5) cubre 5 casos (E1-E5)
[x] Plan de Waves (§6) tiene Gate por wave
[x] MI-1 resuelto explícitamente (§11)
[x] Procedimiento deposit Avalanche documentado (§10)
[x] Coordinación con downstream-payment.ts documentada (DT-8 §4.2)
[x] Auto-Blindaje histórico revisado y aplicado (§3.2: WKH-67, WKH-69, WKH-86)
[x] AR ataques cross-chain documentados (CD-9 work-item + §7 R-3)
[x] CD-12 (debit/getBalance same bundle source) cubierto
```

**Status**: READY FOR F2.5 STORY FILE GENERATION.

---

## 14. Próximos pasos (orquestador)

1. **Gate SPEC_APPROVED** (humano): aprobar este SDD vía orquestador.
2. **F2.5**: `nexus-architect` lanza `/nexus-p3-f2-5 WKH-MULTICHAIN` para generar
   `doc/sdd/086-wkh-multichain-a2a/story-file.md`. El story file convierte las 6 waves en
   pasos atómicos para el Dev.
3. **F3**: Una vez story file listo, lanzar `nexus-dev`.

---

*SDD generado por `nexus-architect` — FULL — 2026-05-13.*
*Branch sugerido: `feat/086-wkh-multichain-a2a`.*
