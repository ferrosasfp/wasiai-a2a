# Story File — WKH-MULTICHAIN (NNN=086)

> **HU**: Multi-chain support en wasiai-a2a
> **Branch sugerido**: `feat/086-wkh-multichain-a2a`
> **Sizing**: QUALITY (payment path, cross-cutting, no downgrade)
> **SDD_MODE**: full
> **Inputs**: [`work-item.md`](work-item.md) + [`sdd.md`](sdd.md)
> **Gates aprobados**: HU_APPROVED (2026-05-13), SPEC_APPROVED (2026-05-13)
> **Modo**: AUTO — F3 corre sin gate humano. Continúa hasta DONE.

---

## 0. Objetivo del Dev

Implementar el refactor de `src/adapters/registry.ts` de **singleton single-chain** a
`Map<ChainKey, AdaptersBundle>` **multi-chain** (kite-ozone-testnet, kite-mainnet, avalanche-fuji,
avalanche-mainnet), crear el **adapter Avalanche** completo (chain + payment EIP-3009/x402 +
stubs), y wirear el **chain resolver per-request** en `src/middleware/a2a-key.ts:180` para que
`/compose` debite el budget en la chain target del request.

**Resultado esperado al cerrar las 6 waves:**

1. `npm test -- --run` → 379+ tests baseline + ~14 tests nuevos, todos PASS.
2. `npx tsc --noEmit` → 0 errores.
3. Path Kite (`kite-ozone-testnet`) byte-idéntico al pre-WKH-MULTICHAIN — backward-compat 100%.
4. Request con `x-payment-chain: avalanche-fuji` → debit en chainId 43113.
5. Request con chain no inicializada → HTTP 400 `CHAIN_NOT_SUPPORTED` con lista de chains inicializadas.
6. Request con budget cero en chain target → HTTP 403 `INSUFFICIENT_BUDGET: chain <chainId> balance is <balance>`.
7. `.env.example` y `doc/architecture/MULTI-CHAIN.md` documentados.

**NO ejecutar smoke tests contra producción** — eso es F4 (QA).
**NO crear el branch** — el primer commit lo hacés vos en F3.

---

## 1. Acceptance Criteria (14 ACs en EARS — copiados del work-item)

Cada AC debe poder citarse como `AC-N:archivo:línea` al cerrar la wave correspondiente.

### Inicialización del registry

- **AC-1**: WHEN `WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji` is set at startup, the system SHALL initialize adapter bundles for both chains without error and log `[Registry] Adapters initialized: kite-ozone-testnet, avalanche-fuji`.
- **AC-2**: WHEN `WASIAI_A2A_CHAIN` (singular, legacy) is set and `WASIAI_A2A_CHAINS` is absent, the system SHALL behave identically to the pre-WKH-MULTICHAIN codebase (single-chain init, same log format, same getChainConfig() response).
- **AC-3**: WHEN `WASIAI_A2A_CHAINS` lists a chain slug not in the supported set (`kite-ozone-testnet`, `kite-mainnet`, `avalanche-fuji`, `avalanche-mainnet`), the system SHALL throw at startup with message `Unsupported chain '<slug>'. Supported: <csv-list>`.

### Chain selection per-request

- **AC-4**: WHEN a `/compose` request carries header `x-payment-chain: 43113`, the system SHALL resolve chain to `avalanche-fuji` (chainId 43113) and debit budget on that chainId.
- **AC-5**: WHEN a `/compose` request targets an agent whose manifest declares `payment.chain = "avalanche-testnet"` (or normalized `"avalanche-fuji"`) and no `x-payment-chain` header is present, the system SHALL resolve chain to `avalanche-fuji` and debit budget on chainId 43113.
- **AC-6**: WHEN a `/compose` request specifies no chain via header or agent manifest, the system SHALL fallback to the configured default chain (first entry in `WASIAI_A2A_CHAINS`, or `WASIAI_A2A_CHAIN` if legacy) and debit on its chainId.
- **AC-7**: WHEN chain resolution produces a chainKey not present in the initialized registry (runtime lookup miss), the system SHALL return HTTP 400 with `error_code: CHAIN_NOT_SUPPORTED` and message including the unresolved chainKey.

### Budget enforcement

- **AC-8**: WHEN an A2A key has budget on chain X but the resolved chain for the request is chain Y, and chain Y has zero or insufficient budget, the system SHALL return HTTP 403 with `error_code: INSUFFICIENT_BUDGET` and message `chain <chainId> balance is <balance>` (includes target chainId).
- **AC-9**: WHEN multi-chain debit is evaluated within a single `/compose` request, the system SHALL debit only the single resolved chain — never two chains for the same pipeline step.

### Discovery

- **AC-10**: WHEN `/discover` returns agents, the system SHALL include `payment.chain` (chain slug) and `payment.asset` (token symbol) for each agent that declares payment metadata.

### Logging y observabilidad

- **AC-11**: WHEN any debit or getBalance operation executes, the system SHALL emit a structured log entry that includes fields `chainKey`, `chainId`, and `asset_symbol`.

### Test baseline

- **AC-12**: WHEN the full test suite runs (`npm test`), the system SHALL pass 379 or more pre-existing tests PLUS all new tests added for Avalanche adapter and cross-chain confusion scenarios (zero regression).

### Smoke tests (F4 — NO los corre el Dev)

- **AC-13**: WHEN a post-deploy smoke test is run against the existing Kite path (via wasiai-v2 prod → wasiai-a2a), the system SHALL return a response identical in structure to pre-WKH-MULTICHAIN.
- **AC-14**: WHEN a post-deploy smoke test is run against a test agent configured for `avalanche-fuji` with sufficient budget on chainId 43113, the system SHALL complete settlement in Fuji USDC via the facilitator and return `txHash` in the response.

---

## 2. Constraint Directives (19 CDs — 11 heredados + 8 nuevos)

Cada CD es testeable. AR/CR van a verificar uno por uno.

### Heredados del work-item

- **CD-1**: OBLIGATORIO — TypeScript strict, sin `any` explícito, sin `as unknown` en paths nuevos.
- **CD-2**: OBLIGATORIO — Backward-compat 100% para el path `kite-ozone-testnet`. Cualquier test existente que pase hoy debe seguir pasando sin modificación al código del test (solo mocks actualizados si la firma de factory cambia).
- **CD-3**: PROHIBIDO modificar `src/adapters/kite-ozone/` excepto en este caso: si la nueva interface `AdaptersBundle` requiere un campo adicional opcional, `createKiteOzoneAdapters()` puede extenderse de forma additive (no breaking). **El parámetro `opts?: { network?: 'testnet' | 'mainnet' }` cae bajo este permiso (DT-I)**.
- **CD-4**: OBLIGATORIO — 379+ baseline tests pasan + nuevos tests cubren: init multi-chain, init legacy single-chain, chain resolver (header > manifest > default), debit en chain correcta, error INSUFFICIENT_BUDGET con chainId en mensaje, cross-chain confusion.
- **CD-5**: PROHIBIDO debitar en dos chains distintas para el mismo pipeline step. Una sola llamada a `budgetService.debit()` por request.
- **CD-6**: OBLIGATORIO — Chain resolution per-request <50ms overhead. Sin I/O adicional en el hot path.
- **CD-7**: OBLIGATORIO — Logs estructurados incluyen `chainKey` (slug) y `chainId` (number) y `asset_symbol` en cada operación de payment/debit/getBalance. Usar `request.log` (Fastify) en middleware.
- **CD-8**: PROHIBIDO romper wasiai-v2 producción. (Smoke en F4, fuera de tu scope.)
- **CD-9**: OBLIGATORIO — AR (F5) atacará: (a) debit en chain incorrecta, (b) cross-chain confusion por normalización, (c) race condition en init multi-chain, (d) missing chainId en log de INSUFFICIENT_BUDGET, (e) IDOR (ownership check — regla WKH-53).
- **CD-10**: OBLIGATORIO — F2 SDD documenta procedimiento deposit Avalanche manual. (Ya documentado en `sdd.md` §10; W6 crea `doc/architecture/MULTI-CHAIN.md` con extracto.)
- **CD-11**: PROHIBIDO usar `process.env.WASIAI_A2A_CHAIN` directamente en el hot path de middleware. Toda lógica de chain selection pasa por `resolveChainKey()` y `getAdaptersBundle()`.

### Nuevos del SDD

- **CD-12 (AR cross-check)**: OBLIGATORIO — En el middleware refactored, el chainId del `debit()` DEBE provenir del MISMO bundle que el chainId del `getBalance()`. AR/CR verifica con grep que ambos leen `chainId` de la misma variable `bundle.chainConfig.chainId`.
- **CD-13 (Conflict log)**: OBLIGATORIO — Si tanto `WASIAI_A2A_CHAINS` como `WASIAI_A2A_CHAIN` están seteados, loguear `[Registry] WARNING: both WASIAI_A2A_CHAINS and WASIAI_A2A_CHAIN are set. Using WASIAI_A2A_CHAINS=<csv> (singular ignored)`.
- **CD-14 (Header normalization is total)**: OBLIGATORIO — `normalizeChainSlug` retorna `undefined` para cualquier input no reconocido. PROHIBIDO retornar el default chain silenciosamente desde el resolver cuando el header es **presente pero inválido** (eso es 400). Si el header está **ausente** → el resolver retorna el default.
- **CD-15 (Avalanche adapter scope)**: OBLIGATORIO — `AvalanchePaymentAdapter` ataca **solo** el wasiai-facilitator (modo x402 canonical), sin soporte para modo `pieverse`.
- **CD-16 (No discovery in middleware)**: OBLIGATORIO — el middleware NO llama a `discoveryService.getAgent()` ni a `composeService.resolveAgent()`. El manifest fallback se delega al cliente upstream (wasiai-v2 propaga el header).
- **CD-17 (Test isolation)**: OBLIGATORIO — `_resetRegistry()` se invoca en `beforeEach` de los tests del registry. Si se agrega `_setDefaultChainKey()`, debe ser exportado con prefijo `_` y comentado como TEST-ONLY.
- **CD-18 (No mutación de bundle)**: OBLIGATORIO — Los `AdaptersBundle` retornados por `getAdaptersBundle()` son immutable references. PROHIBIDO mutar campos del bundle desde call-sites externos.
- **CD-19 (Anti-prototype-pollution)**: OBLIGATORIO — `chain-resolver.ts` usa `typeof headerOverride === 'string'` antes de `normalizeChainSlug`. PROHIBIDO usar `??` con valores no-string. Aplicar `Object.hasOwn` si se lee un valor de un objeto controlado por caller.

---

## 3. Decisiones Técnicas resueltas (16 DTs)

### Heredadas del work-item

- **DT-1 (Chain selection priority)**: `(1) header x-payment-chain explícito > (2) agent manifest payment.chain normalizado > (3) default histórico`.
- **DT-2 (Registry data structure)**: Singleton → `Map<ChainKey, AdaptersBundle>`. Getters existentes mantienen su firma con parámetro opcional `chainKey?: ChainKey` — sin argumento = default chain. Nuevo getter explícito: `getAdaptersBundle(chainKey: ChainKey): AdaptersBundle | undefined`. Nuevo helper: `getInitializedChainKeys(): ChainKey[]`.
- **DT-3 (Env var contract)**: `WASIAI_A2A_CHAINS=csv` nuevo. `WASIAI_A2A_CHAIN` legacy: si presente y `WASIAI_A2A_CHAINS` ausente, se trata como CSV de un elemento. Si ambos presentes, `WASIAI_A2A_CHAINS` gana y se loguea warn (CD-13). Default chain = primer entry trimeado y lowercased.
- **DT-4 (ChainKey schema)**: `'kite-ozone-testnet' | 'kite-mainnet' | 'avalanche-fuji' | 'avalanche-mainnet'`. Inmutables. El JSONB `budget` está keyed por **chainId stringificado**, no por slug — la conversión slug→chainId ocurre en runtime via `bundle.chainConfig.chainId`.
- **DT-5 (Budget storage)**: Sin cambios. Ya es per-chain.
- **DT-6 (Avalanche payment adapter)**: Mirror del patrón kite-ozone. Usa `wasiai-facilitator` self-hosted (mismo endpoint que `downstream-payment.ts`).
- **DT-7 (Deposit Avalanche manual)**: Procedimiento documentado en `sdd.md` §10 y replicado en `doc/architecture/MULTI-CHAIN.md` (W6).
- **DT-8 (downstream-payment.ts coordination)**: Dos paths independientes. Inbound debit (este SDD) usa header/manifest/default. Downstream (WKH-55) usa `WASIAI_DOWNSTREAM_NETWORK` env. NO se modifica `src/lib/downstream-payment.ts`.

### Nuevas del SDD (énfasis especial — léelas antes de codear)

- **DT-A (Manifest fallback ubicación)**: el fallback de chain por manifest se aplica **fuera del middleware**. Razón: rompe CD-6 <50ms si el middleware tira discovery. wasiai-v2 ya propaga el header `x-payment-chain` según el manifest del agent card. **Para callers que no propagan, se acepta debitar en el default + log warning**. El middleware NO llama a `composeService.resolveAgent()` (CD-16).
- **DT-B (Bundle serialization)**: `AdaptersBundle` no se serializa. PROHIBIDO `JSON.stringify(bundle)`. Adapters son instancias clase con closures.
- **DT-C (Runtime lookup miss)**: Cuando `resolveChainKey()` retorna un slug válido pero `getAdaptersBundle()` retorna undefined → HTTP 400 `CHAIN_NOT_SUPPORTED` con mensaje `Chain '<chainKey>' is not initialized. Initialized: <csv-from-Map.keys()>`. **No silent-fallback al default**.
- **DT-D (Chain resolver utility)**: Crear `src/adapters/chain-resolver.ts` con:
  ```ts
  type ResolveInput = { headerOverride?: string; agentManifestChain?: string };
  export function resolveChainKey(input: ResolveInput): ChainKey | undefined;
  export function normalizeChainSlug(raw: string): ChainKey | undefined;
  ```
  Patrón inspirado en `src/services/discovery.ts:56-101`.
- **DT-E (Header value format — slug o chainId)**: `x-payment-chain` acepta ambos. Normalización completa:
  ```
  '43113' / 'avalanche-fuji' / 'avalanche-testnet' / 'avalanche' / 'fuji' → 'avalanche-fuji'
  '43114' / 'avalanche-mainnet'                                          → 'avalanche-mainnet'
  '2368'  / 'kite-ozone-testnet' / 'kite-testnet'                        → 'kite-ozone-testnet'
  '2366'  / 'kite-mainnet'                                               → 'kite-mainnet'
  cualquier otro                                                          → undefined
  ```
- **DT-F (Avalanche facilitator URL)**: `AVALANCHE_FACILITATOR_URL` opcional. Si ausente → `WASIAI_FACILITATOR_URL` env. Si también ausente → literal hardcoded `https://wasiai-facilitator-production.up.railway.app`. Sin override per-chain — la misma URL sirve fuji y mainnet; el facilitator routea internamente vía body `network: eip155:43113|43114`.
- **DT-G (Logger structure)**: CD-7 exige `chainKey`, `chainId`, `asset_symbol` en logs de debit/getBalance. Usar `request.log` (Fastify) en middleware. En adapters/budget, `console.log` compat con patrón actual.
- **DT-H (Test framework)**: vitest. Mock `createAvalancheAdapters` igual que `createKiteOzoneAdapters` en `registry.test.ts:10-22`.
- **DT-I (Kite mainnet activation — mutación temporal `process.env.KITE_NETWORK`)**:
  - `createKiteOzoneAdapters()` evoluciona a aceptar `opts?: { network?: 'testnet' | 'mainnet' }` (additive — CD-3 permite).
  - Si `opts?.network === 'mainnet'`, **`initAdapters()` setea `process.env.KITE_NETWORK = 'mainnet'` ANTES del `await import()` del submódulo** (mutación temporal aceptada solo dentro de `initAdapters()`).
  - **Restaurar el valor original al final** si fue mutado, para que el path testnet siga funcionando si el operador activa ambos chains kite simultáneamente.
  - Si en el futuro queremos correr kite-testnet + kite-mainnet en el mismo proceso, este approach NO escala y requiere `TD-NEW-KITE-PARAMS` (HU separada, documentada en `MULTI-CHAIN.md`).
- **DT-J (Asset symbol en logs)**: el `asset_symbol` se lee del **bundle** del middleware (`bundle.payment.supportedTokens[0]?.symbol`), NO se pasa a `budgetService.debit()` (no contaminar dimensión USD del budget).

---

## 4. Scope IN (archivos a crear/modificar) — 17 archivos

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/adapters/types.ts` | Modificar — export `ChainKey`, `AdaptersBundle` | W0 |
| `src/adapters/registry.ts` | Modificar — singleton → Map, getters opcionales, `initAdapters()` itera CSV | W0 + W5 |
| `src/adapters/chain-resolver.ts` | **Crear** — `resolveChainKey()`, `normalizeChainSlug()` | W0 |
| `src/adapters/avalanche/chain.ts` | **Crear** — `avalancheFuji`/`avalancheMainnet` re-export + `getAvalancheNetwork()` | W1 |
| `src/adapters/avalanche/payment.ts` | **Crear** — `AvalanchePaymentAdapter` (~300 líneas) | W1 |
| `src/adapters/avalanche/attestation.ts` | **Crear** — stub mínimo | W1 |
| `src/adapters/avalanche/gasless.ts` | **Crear** — stub disabled | W1 |
| `src/adapters/avalanche/identity.ts` | **Crear** — `export const avalancheIdentity = null` | W1 |
| `src/adapters/avalanche/index.ts` | **Crear** — `createAvalancheAdapters(opts?)` factory | W1 |
| `src/adapters/__tests__/registry.test.ts` | Modificar — tests multi-chain init, legacy, unsupported, conflict log, mainnet wiring | W0 + W5 |
| `src/adapters/__tests__/avalanche.test.ts` | **Crear** — unit tests del factory Avalanche | W1 |
| `src/middleware/a2a-key.ts` | Modificar — línea 180 reemplaza `getChainConfig().chainId` por resolver + bundle lookup + logs estructurados | W2 |
| `src/middleware/a2a-key.test.ts` | Modificar — tests header override, default fallback, chainId numérico, 400 CHAIN_NOT_SUPPORTED, 403 INSUFFICIENT_BUDGET con chainId, cross-chain confusion, single-debit | W2 + W3 |
| `src/services/budget.ts` | **Sin cambios estructurales** — solo verificación (ya per-chain) | W3 (audit) |
| `src/services/compose.ts` | **Sin cambios funcionales** — verificar línea 297 no debita doble | W3 (audit) |
| `src/services/discovery.test.ts` | Modificar — test `payment.chain` y `payment.asset` en output | W4 |
| `.env.example` | Modificar — agregar `WASIAI_A2A_CHAINS`, `AVALANCHE_FACILITATOR_URL`, nota sobre coexistencia con `WASIAI_DOWNSTREAM_NETWORK` | W6 |
| `doc/architecture/MULTI-CHAIN.md` | **Crear** — modelo multi-chain + matriz + procedimiento deposit + cómo agregar chain | W6 |
| `README.md` | Modificar — párrafo "Multi-chain support" con link a `MULTI-CHAIN.md` | W6 |

**Total**: 11 nuevos + 7 modificados + 1 audit-only (budget.ts) + 1 audit-only (compose.ts) = 17 archivos tocados (2 sin cambios reales).

---

## 5. Scope OUT (NO tocar — copia literal del work-item)

- `src/adapters/kite-ozone/` — NO refactorizar internamente. Único cambio permitido: `createKiteOzoneAdapters()` acepta `opts?: { network?: 'testnet' | 'mainnet' }` (additive, CD-3 + DT-I).
- `wasiai-v2` repo — NO tocar.
- `wasiai-facilitator` — NO tocar la interface.
- `wasiai-lendable` repo — fuera de scope.
- Mainnet deploy real contra Avalanche C-Chain — código preparado pero NO validado en este sprint contra mainnet real.
- Deposit automation per-chain — fuera de scope. Manual via `register_a2a_key_deposit` RPC.
- RLS en `tasks` table (`owner_ref`) — WKH-54, fuera de scope.
- `src/middleware/x402.ts` — NO cambiar el path de x402 inbound (Kite).
- `src/lib/downstream-payment.ts` — NO cambiar en esta HU.

---

## 6. Anti-Hallucination Section — archivos a leer ANTES de cada wave

**Regla del Dev**: ANTES de empezar cada wave, leé los archivos listados con `Read`. Si después
de leerlos un detalle de implementación no coincide con lo que dice este Story File, **parar y
reportar**. NO inventar.

**Comando obligatorio antes de empezar cualquier wave**:

```bash
npm test -- --run
```

Captura el conteo baseline (`X passed`). Lo vas a comparar al cerrar la wave.

### W0 — Adapter abstraction lift

- `src/adapters/registry.ts` (completo, 2.5K)
- `src/adapters/types.ts` (completo, 2.8K)
- `src/adapters/__tests__/registry.test.ts` (completo, 2.5K)
- `src/adapters/kite-ozone/index.ts` (factory shape, 1.1K)
- `src/services/discovery.ts:56-108` (normalization pattern para chain-resolver)

### W1 — Avalanche adapter

- `src/adapters/kite-ozone/chain.ts` (1.6K — exemplar para avalanche/chain.ts)
- `src/adapters/kite-ozone/payment.ts` (17.2K — exemplar para avalanche/payment.ts; foco en `PaymentAdapter` shape, `sign()/verify()/settle()`)
- `src/adapters/kite-ozone/attestation.ts` (499B — exemplar idéntico)
- `src/adapters/kite-ozone/gasless.ts` (9.2K — solo el shape de `status()`)
- `src/adapters/kite-ozone/index.ts` (1.1K — factory pattern)
- `src/adapters/kite-ozone/client.ts` (1.1K — patrón viem PublicClient lazy)
- `src/lib/downstream-payment.ts` **líneas 187-192** (URL del facilitator + canonical x402 body) y **líneas 564-584** (EIP-3009 signing pattern)
- `src/adapters/__tests__/payment.contract.test.ts` (7.4K — pattern para `avalanche.test.ts`)

### W2 — Chain resolver middleware

- `src/middleware/a2a-key.ts` (completo, 7.3K — foco línea 180)
- `src/middleware/a2a-key.test.ts` (completo, 17.2K)
- `src/services/budget.ts` (completo, 2.3K — confirmar firmas)

### W3 — Multi-chain budget validation

- `src/services/budget.ts` (re-leer)
- `src/services/compose.ts` línea 297 ± 20 (verificar comentario WKH-58 y que no hay doble debit)
- `grep -rn "budgetService.debit\|budgetService.getBalance" src/` (audit call-sites)

### W4 — Discovery enrichment

- `src/services/discovery.ts` líneas 56-108 (normalization)
- `src/services/discovery.ts` líneas 295-328 (`mapAgent` y `readPayment`)
- `src/services/discovery.test.ts` (completo, 13K — para agregar test sin romper existentes)

### W5 — Mainnet wiring

- `src/adapters/kite-ozone/index.ts` (re-leer para agregar `opts?: { network }`)
- `src/adapters/kite-ozone/chain.ts` (entender cómo `getKiteNetwork()` lee `KITE_NETWORK`)
- `src/adapters/registry.ts` (post-W0; agregar ramas kite-mainnet y avalanche-mainnet)

### W6 — Docs

- `.env.example` (completo — bloques 102-125 KITE_NETWORK + 316-358 WASIAI_DOWNSTREAM_NETWORK como exemplar de estilo)
- `README.md` (sección relevante)
- `doc/architecture/CHAIN-ADAPTIVE.md` (19.1K — único doc en `doc/architecture/`; usar como exemplar de estilo)

---

## 7. Plan de Waves detallado (6 waves, checklist atómico)

### Wave 0 — Adapter abstraction lift (SERIAL, blocking)

**Objetivo**: refactor de `registry.ts` + `types.ts` + crear `chain-resolver.ts` esqueleto, sin cambiar el comportamiento observable del path Kite.

- [ ] **W0.0** Leer archivos del checklist Anti-Hallucination W0. Correr `npm test -- --run`, capturar baseline.
- [ ] **W0.1** Editar `src/adapters/types.ts`:
  - Exportar `type ChainKey = 'kite-ozone-testnet' | 'kite-mainnet' | 'avalanche-fuji' | 'avalanche-mainnet'`.
  - Exportar `interface AdaptersBundle { payment: PaymentAdapter; attestation: AttestationAdapter; gasless: GaslessAdapter; identity: IdentityBindingAdapter | null; chainConfig: { name: string; chainId: number; explorerUrl: string } }`.
- [ ] **W0.2** Editar `src/adapters/registry.ts`:
  - Reemplazar 4 nullables singleton + `_chainConfig` por:
    - `const _bundles = new Map<ChainKey, AdaptersBundle>()`
    - `let _defaultChainKey: ChainKey | null = null`
    - `let _initialized = false`
  - `SUPPORTED_CHAINS` expande a los 4 slugs (`as const`).
  - `initAdapters()`:
    1. Parse: `const raw = process.env.WASIAI_A2A_CHAINS ?? process.env.WASIAI_A2A_CHAIN ?? 'kite-ozone-testnet'`.
    2. Si **ambos** env vars seteados → loguear warn (CD-13).
    3. CSV split + trim + lowercase → array.
    4. Validate cada slug contra `SUPPORTED_CHAINS`. Si invalid → throw `Unsupported chain '<slug>'. Supported: ${SUPPORTED_CHAINS.join(', ')}`.
    5. For each chain → llamar a factory correspondiente → store en `_bundles.set(chainKey, bundle)`.
    6. `_defaultChainKey = chainKeys[0]`.
    7. Log: `[Registry] Adapters initialized: ${chainKeys.join(', ')}`.
  - Getters con `chainKey?: ChainKey` opcional caen a `_defaultChainKey`:
    - `getPaymentAdapter(chainKey?)`, `getAttestationAdapter(chainKey?)`, `getGaslessAdapter(chainKey?)`, `getIdentityBindingAdapter(chainKey?)`, `getChainConfig(chainKey?)`.
    - Si no inicializado → throw `Adapters not initialized. Call initAdapters() first`.
  - Nuevo getter explícito: `getAdaptersBundle(chainKey: ChainKey): AdaptersBundle | undefined` (no throw — devuelve undefined si no está en el Map).
  - Nuevo helper: `getInitializedChainKeys(): ChainKey[]` (retorna `[..._bundles.keys()]`).
  - `_resetRegistry()` para tests limpia `_bundles.clear()` y resetea flags.
  - **NO mutar `process.env.KITE_NETWORK` en W0** — eso es W5.
- [ ] **W0.3** Crear `src/adapters/chain-resolver.ts`:
  - Importar `ChainKey` de `./types`.
  - `const SLUG_ALIASES: Record<string, ChainKey>` con TODOS los aliases de DT-E (10+ entradas).
  - `export function normalizeChainSlug(raw: string): ChainKey | undefined`:
    - Guard: `if (typeof raw !== 'string') return undefined`.
    - `const key = raw.trim().toLowerCase()`.
    - `return Object.hasOwn(SLUG_ALIASES, key) ? SLUG_ALIASES[key] : undefined`. (Object.hasOwn por CD-19.)
  - `export function resolveChainKey(input: { headerOverride?: string; agentManifestChain?: string }): ChainKey | undefined`:
    - Si `typeof input.headerOverride === 'string'` → return `normalizeChainSlug(input.headerOverride)` (puede ser undefined).
    - Si `typeof input.agentManifestChain === 'string'` → return `normalizeChainSlug(input.agentManifestChain)`.
    - Else → return undefined (el middleware decidirá fallback al default).
  - **NO** importa del registry — es módulo pure.
- [ ] **W0.4** Editar `src/adapters/__tests__/registry.test.ts`:
  - Actualizar `vi.mock('../kite-ozone/index.ts', ...)` para retornar el nuevo shape (mismo, pero accedido vía Map).
  - Mantener tests existentes pasando con la nueva firma de getters.
  - Agregar:
    - **AC-1**: `WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji` → init ambos, log esperado, `getInitializedChainKeys()` retorna 2.
    - **AC-2**: solo `WASIAI_A2A_CHAIN=kite-ozone-testnet` → init un solo bundle, default = `kite-ozone-testnet`, `getChainConfig()` retorna shape idéntico al pre-refactor.
    - **AC-3**: `WASIAI_A2A_CHAINS=ethereum-mainnet` → throw con mensaje exacto.
    - **CD-13**: ambos env vars seteados → warn capturado, usa `WASIAI_A2A_CHAINS`.
  - `_resetRegistry()` en `beforeEach`.
- [ ] **W0.5** `npm test -- --run` → `npx tsc --noEmit`.
- [ ] **Gate W0 → W1**: tests PASS sin warnings + tsc clean + log del registry capturado en uno de los tests.

### Wave 1 — Avalanche adapter (PARALELIZABLE post-W0)

- [ ] **W1.0** Leer archivos del checklist Anti-Hallucination W1.
- [ ] **W1.1** Crear `src/adapters/avalanche/chain.ts` (≤40 líneas):
  - `import { avalanche, avalancheFuji } from 'viem/chains'`.
  - Re-export ambos.
  - `export type AvalancheNetwork = 'fuji' | 'mainnet'`.
  - `export function getAvalancheNetwork(opts?: { network?: AvalancheNetwork }): AvalancheNetwork`:
    - Si `opts?.network` → return.
    - Else → `(process.env.AVALANCHE_NETWORK as AvalancheNetwork | undefined) ?? 'fuji'`.
  - `export function getAvalancheChain(network: AvalancheNetwork)`: retorna `network === 'mainnet' ? avalanche : avalancheFuji`.
- [ ] **W1.2** Crear `src/adapters/avalanche/attestation.ts` (≤30 líneas):
  - Mirror **exacto** de `src/adapters/kite-ozone/attestation.ts`.
  - Aceptar `chainId: number` en constructor → 43113 o 43114 según factory.
  - `attest()` retorna `{ txHash: '0x0', proofUrl: '' }` con `console.warn('[avalanche] attestation stub — ERC-8004 not implemented')`.
- [ ] **W1.3** Crear `src/adapters/avalanche/gasless.ts` (≤60 líneas):
  - `class AvalancheGaslessAdapter implements GaslessAdapter`.
  - `chainId` dinámico (43113/43114).
  - `status()` retorna `{ enabled: false, funding_state: 'disabled', ...etc }` — leer la interfaz `GaslessAdapter` en `types.ts` y completar los campos required.
  - `transfer()` throws `Error('Avalanche gasless not implemented (stub)')`.
- [ ] **W1.4** Crear `src/adapters/avalanche/identity.ts` (≤5 líneas):
  - `export const avalancheIdentity = null` (o `export default null`). Comentar `// No identity binding in Avalanche MVP — null per DT (work-item Scope IN)`.
- [ ] **W1.5** Crear `src/adapters/avalanche/payment.ts` (~300 líneas):
  - `class AvalanchePaymentAdapter implements PaymentAdapter`.
  - Constructor recibe `{ network: AvalancheNetwork }`.
  - Campos:
    - `readonly name = 'avalanche'`
    - `readonly chainId` (43113 o 43114 según network)
    - `readonly supportedTokens` — array con UN entry: `{ symbol: 'USDC', address: <USDC_FUJI o USDC_MAINNET>, decimals: 6 }` (lee de `process.env.FUJI_USDC_ADDRESS` / `AVALANCHE_USDC_ADDRESS` con fallback hardcoded canonical Circle).
  - Métodos (mirror del kite-ozone payment):
    - `getScheme()` → `'exact'`.
    - `getNetwork()` → `network === 'mainnet' ? 'eip155:43114' : 'eip155:43113'`.
    - `getToken()` → primer USDC.
    - `getMaxTimeoutSeconds()` → 60.
    - `getMerchantName()` → `process.env.WASIAI_MERCHANT_NAME ?? 'WasiAI'`.
    - `getFacilitatorUrl()` → `process.env.AVALANCHE_FACILITATOR_URL ?? process.env.WASIAI_FACILITATOR_URL ?? 'https://wasiai-facilitator-production.up.railway.app'` (DT-F).
    - `sign(payload)` → EIP-3009 TransferWithAuthorization usando viem walletClient. **Mirror exact del flow en `src/lib/downstream-payment.ts` líneas 564-584**. Lazy walletClient via `getWalletClient()`.
    - `verify(payload)` → POST `${facilitatorUrl}/verify` con body x402 canonical.
    - `settle(payload)` → POST `${facilitatorUrl}/settle` con body x402 canonical.
  - Lazy clients (privateKeyToAccount, walletClient) — replicar patrón `kite-ozone/client.ts`.
  - Export `_resetWalletClient()` para tests (CD-17).
  - **PROHIBIDO modo `pieverse`** (CD-15) — sólo canonical x402.
- [ ] **W1.6** Crear `src/adapters/avalanche/index.ts`:
  - `export async function createAvalancheAdapters(opts?: { network?: AvalancheNetwork }): Promise<AdaptersBundle>`.
  - Resuelve `network = opts?.network ?? getAvalancheNetwork()`.
  - Instancia `payment`, `attestation`, `gasless`, `identity = null`.
  - `chainConfig`: `{ name: network === 'mainnet' ? 'Avalanche' : 'Avalanche Fuji', chainId: 43113|43114, explorerUrl: network === 'mainnet' ? 'https://snowtrace.io' : 'https://testnet.snowtrace.io' }`.
  - Retorna `AdaptersBundle`.
- [ ] **W1.7** Crear `src/adapters/__tests__/avalanche.test.ts`:
  - Mock viem clients (privateKeyToAccount, createWalletClient).
  - Tests:
    - Default network → bundle con chainId 43113, payment.supportedTokens[0].symbol === 'USDC'.
    - `createAvalancheAdapters({ network: 'mainnet' })` → bundle con chainId 43114.
    - `bundle.gasless.status()` retorna `enabled: false`.
    - `bundle.identity === null`.
    - `payment.getScheme() === 'exact'`, `payment.getNetwork() === 'eip155:43113'`.
- [ ] **W1.8** En `src/adapters/registry.ts` (recién editado en W0), agregar las ramas en el factory dispatcher:
  - `'avalanche-fuji'` → `await createAvalancheAdapters({ network: 'fuji' })`.
  - `'avalanche-mainnet'` → `await createAvalancheAdapters({ network: 'mainnet' })`.
- [ ] **W1.9** `npm test -- --run` + `npx tsc --noEmit`.
- [ ] **Gate W1 → W2**: avalanche tests green + registry tests green con avalanche-fuji.

### Wave 2 — Chain resolver middleware (depende de W0+W1)

- [ ] **W2.0** Leer archivos del checklist Anti-Hallucination W2.
- [ ] **W2.1** Editar `src/middleware/a2a-key.ts` línea 180:
  - Importar `resolveChainKey` de `../adapters/chain-resolver`.
  - Importar `getAdaptersBundle, getInitializedChainKeys` de `../adapters/registry`.
  - Reemplazar `const chainId = getChainConfig().chainId;` por:
    ```ts
    const headerRaw = request.headers['x-payment-chain'];
    const headerOverride = typeof headerRaw === 'string' ? headerRaw : undefined;

    let chainKey = resolveChainKey({ headerOverride });
    if (!chainKey) {
      if (headerOverride !== undefined) {
        return reply.status(400).send({
          error_code: 'CHAIN_NOT_SUPPORTED',
          message: `Chain '${headerOverride}' is not a recognized slug`,
        });
      }
      // Sin header → default (CD-14: undefined puede significar "no header", entonces default)
      chainKey = getInitializedChainKeys()[0];
      if (!chainKey) {
        return reply.status(500).send({
          error_code: 'REGISTRY_NOT_INITIALIZED',
          message: 'No chains initialized in registry',
        });
      }
    }

    const bundle = getAdaptersBundle(chainKey);
    if (!bundle) {
      return reply.status(400).send({
        error_code: 'CHAIN_NOT_SUPPORTED',
        message: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
      });
    }

    const chainId = bundle.chainConfig.chainId;
    const assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN';
    ```
  - Logs estructurados (CD-7):
    ```ts
    request.log.info(
      { chainKey, chainId, asset_symbol: assetSymbol, keyId: keyRow.id, amountUsd: estimatedCostUsd },
      'a2a-key.debit',
    );
    ```
  - Error path enriquecido (AC-8):
    ```ts
    if (!debitResult.success) {
      const balance = await budgetService
        .getBalance(keyRow.id, chainId, keyRow.owner_ref)
        .catch(() => '0');
      request.log.warn(
        { chainKey, chainId, asset_symbol: assetSymbol, keyId: keyRow.id, balance },
        'a2a-key.insufficient-budget',
      );
      return reply.status(403).send({
        error_code: 'INSUFFICIENT_BUDGET',
        message: `chain ${chainId} balance is ${balance}`,
      });
    }
    ```
  - **CD-12**: el `chainId` que se pasa a `debit()` Y a `getBalance()` DEBE leerse de **la misma variable** `bundle.chainConfig.chainId`. NO leer de `getChainConfig().chainId` en ningún call-site del middleware.
- [ ] **W2.2** Editar `src/middleware/a2a-key.test.ts`:
  - Update mock de `../adapters/registry.js` para incluir `getAdaptersBundle` y `getInitializedChainKeys`.
  - Update mock de `../adapters/chain-resolver.js` (real, sin mock; es pure).
  - Mantener: AC-1 happy path (debit con default chain).
  - Agregar:
    - Header `x-payment-chain: avalanche-fuji` → debit con chainId 43113.
    - Header `x-payment-chain: 43113` → resuelve avalanche-fuji → debit chainId 43113 (AC-4).
    - Header `x-payment-chain: ethereum-mainnet` (slug inválido) → 400 `CHAIN_NOT_SUPPORTED` mensaje `Chain 'ethereum-mainnet' is not a recognized slug` (AC-7).
    - Header `x-payment-chain: avalanche-mainnet` con registry init solo fuji → 400 `CHAIN_NOT_SUPPORTED` mensaje incluye `Initialized: kite-ozone-testnet, avalanche-fuji` (AC-7-bis).
    - Header ausente → debit en default chain (AC-5/AC-6).
    - **AC-11**: spy en `request.log.info`, verificar shape `{ chainKey, chainId, asset_symbol, keyId, amountUsd }`.
- [ ] **W2.3** `npm test -- --run` + `npx tsc --noEmit`.
- [ ] **Gate W2 → W3**: tests middleware green + ACs 4, 5, 6, 7, 11 cubiertos.

### Wave 3 — Multi-chain budget validation + cross-chain tests (depende de W2)

- [ ] **W3.0** Leer archivos del checklist Anti-Hallucination W3.
- [ ] **W3.1** Auditoría con grep:
  ```bash
  grep -rn "budgetService.debit\|budgetService.getBalance" src/
  grep -rn "getChainConfig()" src/
  ```
  - Verificar que el único call-site que lee `chainId` para debit/getBalance es el middleware refactored.
  - `compose.ts:297` (WKH-58 ya marca que no debita doble) — confirmar comentario sigue allí.
  - `services/budget.ts` — confirmar que `debit(keyId, chainId, amountUsd)` y `getBalance(keyId, chainId, ownerId)` tienen las firmas correctas.
  - Si encontrás un call-site que lee `getChainConfig().chainId` fuera del default-acceptable, **REPORTAR**, no modificar silenciosamente.
- [ ] **W3.2** Test cross-chain confusion en `src/middleware/a2a-key.test.ts`:
  ```ts
  it('returns 403 INSUFFICIENT_BUDGET with target chainId when budget exists only on different chain', async () => {
    // Key budget: { '2368': '10.000000', '43113': '0' }
    // Request: x-payment-chain: avalanche-fuji
    // mockDebit configured to fail on chainId 43113
    // Expect: 403, error_code INSUFFICIENT_BUDGET, message 'chain 43113 balance is 0'
  });
  ```
- [ ] **W3.3** Test "double debit prevention" (AC-9, CD-5):
  ```ts
  it('debits exactly once per compose request even with multiple steps', async () => {
    // Compose request con dos pasos
    // expect(mockDebit).toHaveBeenCalledTimes(1)
  });
  ```
- [ ] **W3.4** `npm test -- --run` + `npx tsc --noEmit`.
- [ ] **Gate W3 → W4**: ACs 8, 9 cubiertos + auditoría limpia (sin call-sites huérfanos de `getChainConfig().chainId`).

### Wave 4 — Discovery enrichment (AC-10)

- [ ] **W4.0** Leer archivos del checklist Anti-Hallucination W4.
- [ ] **W4.1** Auditar `src/services/discovery.ts:295-328` `mapAgent()` + `readPayment()`. **Confirmar** que `agent.payment.chain` y `agent.payment.asset` ya están en el output via `readPayment(raw)` línea 327. **Si SÍ**: no hay cambios en `discovery.ts`, solo agregás test. **Si NO**: agregás el campo `chain` y `asset` al return de `readPayment()` (normalizado via la allowlist existente en líneas 56-101) — pero **no cambies la normalización**; reutilizala.
- [ ] **W4.2** Agregar test en `src/services/discovery.test.ts`:
  ```ts
  it('includes payment.chain and payment.asset in agent output (AC-10)', async () => {
    // Mock registry response con un agent que declara:
    //   payment: { method: 'x402', chain: 'avalanche-testnet', asset: 'USDC', contract: '0x...' }
    // discoveryService.discover({})
    // Esperar result.agents[0].payment.chain === 'avalanche' (normalizado por discovery)
    // Esperar result.agents[0].payment.asset === 'USDC'
  });
  ```
- [ ] **W4.3** `npm test -- --run` + `npx tsc --noEmit`.
- [ ] **Gate W4 → W5**: AC-10 cubierto.

### Wave 5 — Mainnet support wiring (kite-mainnet + avalanche-mainnet)

- [ ] **W5.0** Leer archivos del checklist Anti-Hallucination W5.
- [ ] **W5.1** Editar `src/adapters/kite-ozone/index.ts` — agregar parámetro opcional (DT-I + CD-3 additive):
  ```ts
  export async function createKiteOzoneAdapters(
    opts?: { network?: 'testnet' | 'mainnet' },
  ): Promise<KiteOzoneAdapters> {
    const prevNetwork = process.env.KITE_NETWORK;
    if (opts?.network) {
      process.env.KITE_NETWORK = opts.network;
    }
    try {
      // ... existing init ...
    } finally {
      if (opts?.network && prevNetwork !== undefined) {
        process.env.KITE_NETWORK = prevNetwork;
      } else if (opts?.network && prevNetwork === undefined) {
        delete process.env.KITE_NETWORK;
      }
    }
  }
  ```
  **Comentar in-line**: `// DT-I: temporary mutation of KITE_NETWORK confined to initAdapters(). TD-NEW-KITE-PARAMS tracks cleanup.`
- [ ] **W5.2** En `src/adapters/registry.ts`, rama `'kite-mainnet'` → `await createKiteOzoneAdapters({ network: 'mainnet' })`. Rama `'avalanche-mainnet'` ya wireada en W1.8 → `await createAvalancheAdapters({ network: 'mainnet' })`.
- [ ] **W5.3** Agregar tests en `src/adapters/__tests__/registry.test.ts`:
  - `WASIAI_A2A_CHAINS=kite-mainnet,avalanche-mainnet` → init both, default = `kite-mainnet`.
  - `getAdaptersBundle('kite-mainnet')?.chainConfig.chainId === 2366`.
  - `getAdaptersBundle('avalanche-mainnet')?.chainConfig.chainId === 43114`.
  - `createKiteOzoneAdapters({ network: 'mainnet' })` no contamina `process.env.KITE_NETWORK` después del retorno (restored).
- [ ] **W5.4** `npm test -- --run` + `npx tsc --noEmit`.
- [ ] **Gate W5 → W6**: 4 chains soportadas en tests. AC-12 (baseline + new) acercándose al objetivo.

### Wave 6 — Documentation

- [ ] **W6.0** Leer archivos del checklist Anti-Hallucination W6.
- [ ] **W6.1** Editar `.env.example`. Agregar bloque después del bloque KITE_NETWORK:
  ```
  # ─── Multi-chain registry (WKH-MULTICHAIN / 086) ────────────────────────
  # CSV de chains a inicializar al startup. Default = primer entry del CSV.
  # Slugs soportados: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet.
  # Backward-compat: si ausente, se lee WASIAI_A2A_CHAIN (legacy single).
  # Si ambas están presentes, WASIAI_A2A_CHAINS gana y se loguea WARNING.
  WASIAI_A2A_CHAINS=kite-ozone-testnet

  # Facilitator URL para Avalanche (chainId 43113 y 43114).
  # Si ausente, fallback a WASIAI_FACILITATOR_URL, y luego a la URL hardcoded del wasiai-facilitator self-hosted.
  # AVALANCHE_FACILITATOR_URL=https://wasiai-facilitator-production.up.railway.app

  # NOTA: WASIAI_DOWNSTREAM_NETWORK controla la chain del downstream USDC outbound (WKH-55).
  #       Es INDEPENDIENTE de WASIAI_A2A_CHAINS (que controla la chain del inbound debit del A2A key).
  ```
- [ ] **W6.2** Crear `doc/architecture/MULTI-CHAIN.md` (~200-400 líneas):
  - **§1 Modelo**: explicación del Map + registry + resolver. Diagrama ASCII (heredado del SDD §4.1).
  - **§2 Matriz de chains**: tabla con columnas `ChainKey | chainId | RPC env var | USDC address | facilitator URL`.
  - **§3 Chain selection priority**: header > manifest (delegado al cliente) > default. Cita el SDD §4.2 DT-1+DT-A.
  - **§4 Deposit Avalanche manual** (CD-10): copia literal del SDD §10 (pasos 1-5 con curl + SQL).
  - **§5 Activar mainnet**: pasos para kite-mainnet y avalanche-mainnet.
  - **§6 Coexistencia con downstream-payment.ts** (DT-8): tabla inbound vs downstream + warning.
  - **§7 Cómo agregar una chain nueva**: checklist post-merge (5-10 pasos).
  - **§8 Open items**: TD-NEW-KITE-PARAMS (refactor de kite-ozone/chain.ts para no leer env).
- [ ] **W6.3** Editar `README.md`: agregar un párrafo "Multi-chain support" con link a `doc/architecture/MULTI-CHAIN.md`. Sin reescribir nada — un párrafo + link.
- [ ] **W6.4** `npm test -- --run` (sanity final) + `npx tsc --noEmit`.
- [ ] **Gate W6 → DONE**: docs commit-ready. Total tests >= 379 + ~14 nuevos.

---

## 8. Test Plan por AC (mapping completo)

| AC | Test name | Wave | Archivo | Cubre |
|----|-----------|------|---------|-------|
| AC-1 | `init multi-chain CSV — both bundles present` | W0 | `registry.test.ts` | Init con CSV de dos chains, log esperado, ambos bundles accesibles. |
| AC-2 | `init legacy WASIAI_A2A_CHAIN — single bundle present` | W0 | `registry.test.ts` | Init solo con var singular, default es esa chain, getChainConfig() identical. |
| AC-3 | `init throws on unsupported chain — message lists all` | W0 | `registry.test.ts` | `WASIAI_A2A_CHAINS=ethereum-mainnet` → throw con mensaje exacto. |
| AC-4 | `middleware header x-payment-chain: 43113 → debit on chain 43113` | W2 | `a2a-key.test.ts` | ChainId numérico, resolver mapea, debit con chainId 43113. |
| AC-5 | `middleware default fallback when no header — debit on default chain` | W2 | `a2a-key.test.ts` | Sin header → debit en default. Manifest fallback delegado al cliente. |
| AC-6 | `middleware no chain → default fallback (first CSV entry)` | W2 | `a2a-key.test.ts` | Default es primer entry del CSV. |
| AC-7 | `middleware unknown chainKey → 400 CHAIN_NOT_SUPPORTED` | W2 | `a2a-key.test.ts` | Header inválido → 400 + body con error_code. |
| AC-7-bis | `middleware initialized chain miss → 400 with Initialized list` | W2 | `a2a-key.test.ts` | Header `avalanche-mainnet`, registry init solo fuji → 400 + lista. |
| AC-8 | `INSUFFICIENT_BUDGET error message includes chainId` | W3 | `a2a-key.test.ts` | mockDebit falla chainId 43113 → `chain 43113 balance is 0`. |
| AC-9 | `single compose request → single debit call` | W3 | `a2a-key.test.ts` | `mockDebit.toHaveBeenCalledTimes(1)`. |
| AC-10 | `discover returns payment.chain and payment.asset` | W4 | `discovery.test.ts` | Mock registry → `result.agents[0].payment` populated. |
| AC-11 | `structured log includes chainKey, chainId, asset_symbol` | W2 | `a2a-key.test.ts` | Spy en `request.log.info`, esperar shape. |
| AC-12 | `npm test full suite — 379+ tests + new passes` | W6 | `package.json` test | Run `npm test`, count >= 379 + ~14. **F4 captura conteo exacto** (no tu scope). |
| AC-13 | `smoke wasiai-v2 prod path Kite — unchanged response shape` | F4 (post-deploy) | manual | **NO es tu scope**. |
| AC-14 | `smoke Avalanche Fuji — txHash returned` | F4 (post-deploy) | manual | **NO es tu scope**. |

**Tests adicionales requeridos por CDs:**

| Test | CD | Wave | Archivo |
|------|----|------|---------|
| Avalanche payment adapter — chainId, scheme, network | DT-6 | W1 | `avalanche.test.ts` |
| Avalanche factory — bundle shape, USDC asset | DT-6 | W1 | `avalanche.test.ts` |
| Avalanche mainnet wiring | W5 | W5 | `registry.test.ts` |
| Kite mainnet wiring (network=mainnet, env restore) | DT-I | W5 | `registry.test.ts` |
| Conflict log when both env vars set | CD-13 | W0 | `registry.test.ts` |
| Cross-chain confusion (key 2368, request 43113 → 403) | CD-9, R-3 | W3 | `a2a-key.test.ts` |
| Resolver: chainId numeric '43113' → avalanche-fuji | DT-E | W2 | `a2a-key.test.ts` (inline) |
| Resolver: alias 'fuji'/'avalanche-testnet' → avalanche-fuji | DT-E | W2 | `a2a-key.test.ts` (inline) |

**Test count delta esperado**: ~14 nuevos. Baseline 379 + 14 ≈ 393 al cerrar F3.

---

## 9. Exemplars verificados (paths reales)

| Para crear/modificar | Seguir patrón de | Qué imitar |
|----------------------|------------------|-----------|
| `src/adapters/avalanche/chain.ts` | `src/adapters/kite-ozone/chain.ts` (1.6K) | `defineChain` + selector function (`getKiteNetwork`) |
| `src/adapters/avalanche/payment.ts` | `src/adapters/kite-ozone/payment.ts` (17.2K) + `src/lib/downstream-payment.ts` líneas 187-192 (facilitator URL) + 564-584 (EIP-3009 sign) | `PaymentAdapter` interface completo + sign/verify/settle x402 canonical |
| `src/adapters/avalanche/attestation.ts` | `src/adapters/kite-ozone/attestation.ts` (499B) | Stub minimal idéntico, swap chainId |
| `src/adapters/avalanche/gasless.ts` | `src/adapters/kite-ozone/gasless.ts` (9.2K) — solo el shape de `status()` | `status()` retorna disabled; `transfer()` throws |
| `src/adapters/avalanche/index.ts` | `src/adapters/kite-ozone/index.ts` (1.1K) | Factory async + `await import()` pattern |
| `src/adapters/chain-resolver.ts` | `src/services/discovery.ts:56-101` | Allowlist + normalization total |
| `src/adapters/__tests__/avalanche.test.ts` | `src/adapters/__tests__/registry.test.ts` (2.5K) + `src/adapters/__tests__/payment.contract.test.ts` (7.4K) | `vi.mock` pattern + describe/it organization |
| `doc/architecture/MULTI-CHAIN.md` | `doc/architecture/CHAIN-ADAPTIVE.md` (19.1K, único doc en esa carpeta) | Estructura de secciones + tone |
| `.env.example` bloque WASIAI_A2A_CHAINS | bloques existentes (KITE_NETWORK + WASIAI_DOWNSTREAM_NETWORK) | Comment style + section headers |

**Imports verificados (ya en `package.json`)**:
- `viem` (kite-ozone/payment.ts, downstream-payment.ts)
- `viem/chains` → `avalanche`, `avalancheFuji` ya importados en `downstream-payment.ts:19`
- `viem/accounts` → `privateKeyToAccount` ya usado
- `vitest` ya en uso

---

## 10. Quality Gates (al cerrar cada wave)

Antes de pasar a la wave siguiente, **TODO** debe pasar:

1. `npm test -- --run` → **0 failures**. Conteo no debe disminuir respecto al baseline.
2. `npx tsc --noEmit` → **0 errores**.
3. Los ACs cubiertos por esa wave tienen test que pasa con cita `archivo:línea`.
4. Cualquier nuevo CD violation detectada → parar y reportar.

Si algún gate falla:
- Reportá el error específico (archivo, línea, output del test).
- NO sigas a la wave siguiente.
- NO comentes el test que falla.
- NO uses `any` o `as unknown` para sortear (CD-1).

---

## 11. Commit guidance (sugerido por wave)

Patrón histórico del proyecto (revisar `git log --oneline -20`):
```
feat(adapters): multi-chain registry refactor (WKH-MULTICHAIN W0)
feat(adapters): Avalanche adapter (chain + payment + stubs) (WKH-MULTICHAIN W1)
feat(middleware): chain resolver per-request (WKH-MULTICHAIN W2)
test(middleware): cross-chain confusion + single-debit (WKH-MULTICHAIN W3)
feat(discovery): expose payment.chain and payment.asset (WKH-MULTICHAIN W4)
feat(adapters): kite-mainnet + avalanche-mainnet wiring (WKH-MULTICHAIN W5)
docs(architecture): multi-chain support (WKH-MULTICHAIN W6)
```

**Sugerencia**: 1 commit por wave para facilitar AR/CR. F3 cierra con un commit final si quedan ajustes post-AR.

**NO hacer push** hasta que F4 (QA) apruebe.

---

## 12. Missing Inputs — Resolución (no son blockers)

| ID | Descripción | Resolución final |
|----|-------------|------------------|
| **MI-1** | Facilitator support Avalanche | **RESUELTO**: `wasiai-facilitator` self-hosted ya soporta avalanche-fuji y avalanche-mainnet (probado en producción vía WKH-55). `AvalanchePaymentAdapter` usa la misma URL (`AVALANCHE_FACILITATOR_URL` ?? `WASIAI_FACILITATOR_URL` ?? hardcoded). |
| **MI-2** | Attestation Avalanche ERC-8004 | **RESUELTO**: stub minimal (mirror exact del kite attestation, swap chainId). ERC-8004 fuera de scope MVP. |
| **MI-3** | Normalización `payment.chain` | **RESUELTO en DT-E**: aliases completos definidos. |
| **MI-4** | Product context | **N/A**: HU infra pura. |

---

## 13. Auto-Blindaje histórico — patrones a NO repetir

(Heredado del SDD §3.2)

- **WKH-69**: Cross-rootDir imports. Mantener fixtures dentro de `src/`.
- **WKH-67** "Decimals separation": `budget.debit(keyId, chainId, amountUsd)` es chain-agnostic dimensionalmente (USD). PERO verificar que el `chainId` del debit y del balance read coinciden con el chain resuelto (CD-12).
- **WKH-67** "Prototype pollution": usar `Object.hasOwn()` antes de leer propiedades de payloads externos (CD-19).
- **WKH-86**: Test mock obsoleto al ampliar manifest — actualizar mocks del registry al expandir `SUPPORTED_CHAINS`.

---

## 14. Done Definition

F3 cierra cuando **TODOS** los siguientes son verdaderos:

- [ ] Las 6 waves completadas con sus gates verdes.
- [ ] `npm test -- --run` → 0 failures, ~14 tests nuevos sumados al baseline.
- [ ] `npx tsc --noEmit` → 0 errores.
- [ ] Los 14 ACs tienen al menos 1 test que pasa (AC-13/AC-14 son F4-only, marcalos como `[ARCHIVADO PARA F4]`).
- [ ] Los 19 CDs respetados (verificable por AR/CR via grep + lectura).
- [ ] Los 17 archivos del Scope IN tocados (o auditados con justificación si no cambian).
- [ ] No hay `any` ni `as unknown` en código nuevo.
- [ ] No hay TODO/FIXME nuevos en código de producción (sí pueden estar en `MULTI-CHAIN.md` §8 Open items).
- [ ] No se modificaron archivos fuera del Scope IN.
- [ ] Commits por wave hechos (sin push).

Reportá al orquestador:
- Path final de los archivos modificados/creados.
- Output de `npm test -- --run` (resumen: X passed, 0 failed).
- Output de `npx tsc --noEmit` (vacío si OK).
- Conteo de tests nuevos agregados.
- Cualquier desviación del Story File con justificación.

**NO ejecutes AR ni CR ni F4**: el orquestador lanza esos sub-agentes.

---

*Story File generado por `nexus-architect` (F2.5) — 2026-05-13.*
*HU: WKH-MULTICHAIN. NNN: 086. Branch sugerido: `feat/086-wkh-multichain-a2a`.*
