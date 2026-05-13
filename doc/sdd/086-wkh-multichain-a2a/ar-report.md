# AR Report — WKH-MULTICHAIN (Adversarial Review)

> **HU**: Multi-chain support en wasiai-a2a
> **Branch**: `feat/086-wkh-multichain-a2a` (HEAD `c26a14b`)
> **Fecha**: 2026-05-13
> **Modo**: AUTO (paralelo con CR — foco AR ataques)
> **Reviewer**: `nexus-adversary`

---

## Veredicto

**APROBADO con MENORES**

Se atacaron los 5 vectores explícitos de CD-9 y 8 vectores libres adicionales.
Las defensas core (CD-12 same-bundle chainId, CD-14 total normalization, CD-19
prototype pollution, CD-13 conflict log, CD-17 test isolation) están **bien
implementadas y testeadas**. No se encontraron BLOQUEANTES de seguridad (data
loss, IDOR, signature replay).

Se identifican **3 hallazgos MENORES** + **2 INFORMATIVOS** que documentan
foot-guns operacionales y deuda técnica explícita ya trackeada por el equipo.

---

## Resumen ejecutivo

Atacado: 5 vectores CD-9 + 8 vectores libres (default-chain shift, header
injection, prototype pollution, race init, env mutation reentrancy,
discovery allowlist, EIP-712 domain rotation, facilitator URL fallback).

Hallazgos:

- BLQ: **0**
- MNR: **3** — todos relacionados con foot-guns operacionales o deuda
  documentada (no son vulnerabilidades inmediatas).
- INFO: **2** — observaciones sobre comportamientos by-design que conviene
  monitorear.

Severidad global: **baja-media**. El refactor multi-chain preserva
backward-compat byte-idéntica para el path Kite (verificado en
`registry.test.ts` lines 397–399, `kite-factory.test.ts:62-72`), y los
chainId que se debitan provienen siempre del mismo `bundle.chainConfig.chainId`
del que se lee el balance (CD-12 verificado en `a2a-key.ts:220, 241, 250, 275`).

El único riesgo operacional real es **MIN-1**: el path x402 inbound en
`compose.ts:323,341` y `middleware/x402.ts:49,142,175` sigue usando
`getPaymentAdapter()` sin chainKey explícito → fallback silencioso al default
chain. Este código **es Scope OUT del HU**, pero el HU **amplifica el riesgo**
al permitir que el default ya no sea Kite. No bloquea el merge — debe
trackearse como TD post-merge.

---

## Hallazgos

### MIN-1: x402 inbound usa default-chain silencioso (foot-gun operacional amplificado por la HU)

- **Severidad**: MENOR
- **Vector**: libre — default-chain shift attack
- **Archivos / líneas**:
  - `src/services/compose.ts:323` — `getPaymentAdapter().sign(...)` (sin chainKey)
  - `src/services/compose.ts:341` — `getPaymentAdapter().settle(...)` (sin chainKey)
  - `src/middleware/x402.ts:49` — `getPaymentAdapter()` (sin chainKey, build402Response)
  - `src/middleware/x402.ts:142` — `getPaymentAdapter().verify(...)` (sin chainKey)
  - `src/middleware/x402.ts:175` — `getPaymentAdapter().settle(...)` (sin chainKey)
  - `src/services/fee-charge.ts:250,263` — análogo
  - `src/mcp/tools/pay-x402.ts:162` — análogo

- **Snippet vulnerable**:

```ts
// src/services/compose.ts:323
const result = await getPaymentAdapter().sign({
  to: payTo as `0x${string}`,
  value: valueWei,
});
```

- **PoC del riesgo operacional**:

```yaml
# .env operator (escenario realista)
WASIAI_A2A_CHAINS=avalanche-fuji,kite-ozone-testnet  # avalanche-fuji default

# Request entrante: x402 path (no a2a-key), agente Kite con priceUsdc > 0
# Llega a compose.ts:301 → if (agent.priceUsdc > 0 && !a2aKey)
# Llega a compose.ts:323 → getPaymentAdapter().sign(...)  ← Avalanche, no Kite
# El sign() firma un EIP-3009 sobre USDC Avalanche para un agente Kite.
# El facilitator Pieverse (Kite) rechaza o ignora; o (peor) settla en chain incorrecta.
```

- **Impacto**:
  - **Antes del HU**: imposible — había un solo chain inicializado (Kite),
    default siempre Kite. El bug latente nunca se manifestaba.
  - **Después del HU**: cualquier operator que ponga Avalanche primero en
    el CSV → todo x402 inbound firma con chain incorrecta.
  - El a2a-key path NO está afectado (el middleware refactored W2 resuelve
    chain per-request — verificado en `a2a-key.ts:185-216`).
  - El x402 inbound flow está documentado como path legacy "Pieverse
    /v2/settle HTTP 500 since 2026-04-13" (comentario `compose.ts:296-301`).
    En la práctica este path está degradado, lo cual reduce el impacto.

- **Por qué es MENOR y no BLQ**:
  1. **Scope OUT explícito** (`src/middleware/x402.ts`, work-item Scope OUT).
  2. El path x402 inbound está deprecated (Pieverse 500 desde 2026-04-13).
  3. La defensa correcta requiere refactor coordinado (resolver per-request
     en x402.ts), que es una HU separada.
  4. El default actual de `.env.example:153` sigue siendo `kite-ozone-testnet`
     → operators con config default no están expuestos.

- **Fix sugerido**:
  - Documentar en `doc/architecture/MULTI-CHAIN.md` §6 explícitamente: "el
    operator NO debe poner avalanche-fuji como primer entry del CSV hasta
    que x402.ts soporte chain resolver per-request (TD-X402-MULTICHAIN)".
  - Crear TD-X402-MULTICHAIN: replicar el patrón de chain resolver del
    a2a-key middleware en `x402.ts` y `compose.ts` x402 path.
  - Alternativa: forzar `getPaymentAdapter()` sin chainKey a `throw` cuando
    hay más de un chain inicializado (fail-loud en lugar de fail-silent).

---

### MIN-2: Discovery allowlist excluye `avalanche-fuji` canonical y `kite-ozone-testnet` (AC-10 partial gap)

- **Severidad**: MENOR
- **Vector**: CD-9(b) — normalización confusion
- **Archivos / líneas**:
  - `src/services/discovery.ts:56-60` — `ALLOWED_CHAIN_VALUES = ['avalanche', 'avalanche-testnet', 'avalanche-mainnet']`
  - `src/services/discovery.ts:90` — `if (!ALLOWED_CHAIN_VALUES.has(chainRaw)) return undefined;`

- **Snippet vulnerable**:

```ts
const ALLOWED_CHAIN_VALUES = new Set([
  'avalanche',          // canonical
  'avalanche-testnet',
  'avalanche-mainnet',
]);
// NO incluye: 'avalanche-fuji', 'kite-ozone-testnet', 'kite-mainnet'

function readPayment(raw: Record<string, unknown>): AgentPaymentSpec | undefined {
  // ...
  if (!ALLOWED_CHAIN_VALUES.has(chainRaw)) {
    return undefined;  // ← drop payment metadata silently
  }
}
```

- **PoC reproducible** (ya documentado en test `discovery.test.ts:278-305`):

```ts
// Caso 1: agente con chain="avalanche-fuji" (canonical post-HU)
const agent = { payment: { method: 'x402', chain: 'avalanche-fuji', asset: 'USDC', ... } };
// → readPayment retorna undefined porque 'avalanche-fuji' ∉ ALLOWED_CHAIN_VALUES
// → result.agents[0].payment === undefined  ← AC-10 falla

// Caso 2: agente con chain="kite-ozone-testnet"
// → mismo resultado: payment metadata dropped
```

- **Impacto**:
  - **AC-10 literal**: "SHALL include payment.chain ... for each agent that
    declares payment metadata" — viola si la chain es kite-ozone-testnet o
    el slug canonical avalanche-fuji.
  - **Realidad operacional**: wasiai-v2 emite `chain: 'avalanche-testnet'`
    (no `avalanche-fuji`), por lo que en producción funciona. Pero si
    cualquier registry nuevo adopta el slug canonical post-HU
    (`avalanche-fuji`), su payment se cae silenciosamente.
  - **No es vulnerabilidad** — es un drift entre la normalización de
    discovery (defense-in-depth contra downstream-payment SEC-AR-2026-04-28)
    y la normalización del chain resolver del middleware
    (`chain-resolver.ts:23-42`). Los dos normalizadores son inconsistentes:
    el chain resolver acepta `avalanche-fuji` como canonical; discovery
    no.

- **Por qué es MENOR**:
  1. El team lo documentó explícitamente en el test (`discovery.test.ts:278-305`):
     "Kite chain not in discovery's allowlist → payment dropped (defense-in-depth)".
  2. AC-10 funcionalmente está cubierto para el caso real
     (`avalanche-testnet`) que es lo que wasiai-v2 emite hoy.
  3. La inconsistencia entre las dos normalizaciones está documentada en
     `discovery.test.ts:271-272` y `sdd.md §R-8`.

- **Fix sugerido**:
  - Expandir `ALLOWED_CHAIN_VALUES` para incluir `'avalanche-fuji'` y
    `'kite-ozone-testnet'`, normalizando hacia los mismos canonicals que
    usa el middleware chain resolver (DT-E).
  - O documentar en el SDD un AC-10-bis aclarando: AC-10 aplica solo a
    agentes con chain en `ALLOWED_CHAIN_VALUES`. El gap se trackea como
    TD-DISCOVERY-MULTICHAIN-ALLOWLIST.

---

### MIN-3: `_resetWalletClient()` no resetea el cache de viem `privateKeyToAccount`

- **Severidad**: MENOR (test pollution risk)
- **Vector**: CD-9(c) — race condition / test isolation
- **Archivo / línea**: `src/adapters/avalanche/payment.ts:427-432`

- **Snippet**:

```ts
export function _resetWalletClient(): void {
  _walletClientFuji = null;
  _walletClientMainnet = null;
  _warnedDefaultTokenFuji = false;
  _warnedDefaultTokenMainnet = false;
}
```

- **PoC potencial**:

```ts
// Test A
process.env.OPERATOR_PRIVATE_KEY = '0xAAA...';
new AvalanchePaymentAdapter({ network: 'fuji' }).sign({ to: '0x...', value: '1' });
// _walletClientFuji caches a client bound to 0xAAA account

// Test B (luego de _resetWalletClient + cambio de OPERATOR_PRIVATE_KEY)
process.env.OPERATOR_PRIVATE_KEY = '0xBBB...';
_resetWalletClient();
new AvalanchePaymentAdapter({ network: 'fuji' }).sign({ to: '0x...', value: '1' });
// Funciona OK porque _walletClientFuji es null y se reinicializa con la nueva PK.
// ← No es bug actualmente, pero el cache de viem `privateKeyToAccount`
// (interno a viem) podría pollutearse en futuras versiones.
```

- **Impacto real hoy**: ninguno verificable — viem no tiene caches
  agresivos a nivel de `privateKeyToAccount`. Los tests pasan.

- **Por qué es MENOR**:
  - Es preventivo. Si viem cambia internals, los tests podrían empezar a
    inter-contaminarse.

- **Fix sugerido**:
  - Documentar la expectativa en JSDoc de `_resetWalletClient`: "Asume
    viem no cachea `privateKeyToAccount` internamente. Si cambia, agregar
    `vi.resetModules()` o equivalente."
  - Considerar moverse a `import.meta.glob` o reset de viem module cache
    si surge flakiness.

---

## Hallazgos informativos (no requieren acción)

### INFO-1: CD-13 conflict warning case-sensitive a "set but non-empty"

- **Archivo**: `src/adapters/registry.ts:84-92`
- **Observación**: El warning solo dispara cuando AMBAS env vars son
  strings no vacíos. Si un operator hace
  `WASIAI_A2A_CHAINS= WASIAI_A2A_CHAIN=kite-ozone-testnet` (CSV vacío,
  legacy seteado), el warning NO dispara y se usa el legacy silenciosamente.
- **Impacto**: cero — es exactamente el comportamiento esperado por CD-13.
- **No-finding**: documentado correctamente. INFO solo para que CR lo
  confirme en su review.

### INFO-2: `getPaymentAdapter(chainKey)` con chainKey conocido pero no inicializado

- **Archivo**: `src/adapters/registry.ts:149-160`
- **Observación**: Si un caller llama `getPaymentAdapter('avalanche-mainnet')`
  pero el operator solo inicializó `avalanche-fuji`, la función **throws**
  con `'Adapters not initialized. Call initAdapters() first.'`. El
  mensaje es engañoso — el problema real es "chain X no está inicializada",
  no "registry no inicializado".
- **Impacto**: cero funcional, solo DX/operability. El call-site del
  middleware (línea 209) usa `getAdaptersBundle()` (no-throw) que sí
  devuelve `undefined` correctamente para este caso, y genera el error
  correcto (DT-C / `CHAIN_NOT_SUPPORTED`).
- **No-finding**: el código que importa funcionalmente está OK
  (`getAdaptersBundle` distingue los dos casos).
- **Sugerencia opcional**: en `resolveBundleOrThrow`, diferenciar
  `'Adapters not initialized'` (init never ran) vs `'Chain X not
  initialized'` (init ran pero la chain no está).

---

## Vectores atacados (matriz CD-9)

| Vector CD-9 | Status | Notas |
|-------------|--------|-------|
| (a) Cross-chain debit | **DEFENDIDO** | CD-12 verificado: `a2a-key.ts:220` (chainId from bundle), líneas 241/250/275 todas leen del mismo `bundle.chainConfig.chainId`. Test `a2a-key.test.ts:807-841` (AC-8 cross-chain) confirma debit+balance read con misma chainId. |
| (b) Normalización confusion | **DEFENDIDO / parcial** | `chain-resolver.ts` y `discovery.ts` tienen normalizaciones **separadas e inconsistentes** (MIN-2). El path del middleware (debit) es total y rechaza unknowns (CD-14). El path de discovery silencia metadata para slugs no-allowlisted (drift documentado). |
| (c) Race condition en init | **DEFENDIDO** | `_initialized = true` se setea AL FINAL (`registry.ts:136`); `getAdaptersBundle` chequea `_initialized` antes de leer `_bundles` (línea 206). Mientras init corre, todos los lookups retornan `undefined`. Multi-process Railway: cada proceso corre su propio init aislado. |
| (d) Missing chainId en log INSUFFICIENT_BUDGET | **DEFENDIDO** | `a2a-key.ts:252-261` (warn log con `chainKey, chainId, asset_symbol, balance`) y 262-266 (response con `chain ${chainId} balance is ${balance}`). Test `a2a-key.test.ts:809-841` valida exactamente este shape. |
| (e) IDOR (cross-chain ownership) | **DEFENDIDO** | `a2a-key.ts:250` y `:274` pasan `keyRow.owner_ref` a `getBalance`. `budget.ts:28` aplica `.eq('owner_ref', ownerId)` (WKH-53 regla). No hay path que evite el ownership check. |

---

## Vectores adicionales explorados (libres)

| Vector | Status | Notas |
|--------|--------|-------|
| Default-chain shift attack | **MIN-1** | x402 inbound path (compose.ts:323,341 + x402.ts) usa `getPaymentAdapter()` no-arg → default chain silencioso. Out of scope HU pero amplificado por el refactor. |
| Header injection (`x-payment-chain`) | **DEFENDIDO** | `normalizeChainSlug` aplica `trim().toLowerCase()` y `Object.hasOwn` (CD-19). Headers con coma, newlines, null bytes, prototype names (`__proto__`, `constructor`) → undefined → 400. Tests `chain-resolver.test.ts:58-75`. |
| Prototype pollution | **DEFENDIDO** | `SLUG_ALIASES` se construye con `Object.assign(Object.create(null), {...})` (`chain-resolver.ts:20-43`) y `Object.hasOwn` se usa (línea 55). Tests CD-19 (`chain-resolver.test.ts:58-64`) cubren `toString`, `__proto__`, `hasOwnProperty`. |
| DT-I env mutation reentrancy | **DEFENDIDO** | `kite-ozone/index.ts:38-78` usa `try/finally` con `hadPrevNetwork` flag — restaura `delete` vs assignment correctamente. Tests `kite-factory.test.ts:94-118` (incluyendo 2 calls secuenciales). En un mismo proceso Node, `initAdapters` corre el loop secuencialmente con `await`, no concurrente. Multi-process: cada proceso aislado. |
| Discovery allowlist drift | **MIN-2** | Ver MIN-2. `discovery.ts:56-60` no incluye `avalanche-fuji` ni `kite-ozone-testnet` canonical. |
| EIP-712 domain (replay fuji→mainnet) | **DEFENDIDO** | `avalanche/payment.ts:391-409` incluye `chainId: this.chainId` y `verifyingContract: token` (USDC address) en el domain. Token y chainId son **inmutables** por instancia (constructor), no leen env en runtime. Fuji USDC (`0x5425...`) ≠ Mainnet USDC (`0xB97E...`), bloqueando replay. |
| Facilitator URL fallback chain (DT-F) | **DEFENDIDO** | `avalanche/payment.ts:143-149`: `AVALANCHE_FACILITATOR_URL > WASIAI_FACILITATOR_URL > hardcoded`. La URL hardcoded es Railway https-only — no hay path de spoof via plaintext. Tests `avalanche.test.ts:305-350` cubren ambos overrides. |
| `getAdaptersBundle` returns undefined on miss | **DEFENDIDO** | Único call-site que asume el bundle (`a2a-key.ts:209`) chequea con `if (!bundle)` (línea 210) → 400 `CHAIN_NOT_SUPPORTED`. No hay NPE. `getPaymentAdapter` no-arg variants en `x402.ts`/`compose.ts` siempre tienen el default disponible (init obligatorio antes de listen — `index.ts:31`). |

---

## CDs verificados (cobertura test)

| CD | Verificado en | Status |
|----|---------------|--------|
| CD-1 (TS strict, no `any`) | `tsc --noEmit` clean (Dev confirmó) | OK |
| CD-2 (backward-compat byte-idéntico Kite) | `kite-factory.test.ts:52-83`, `registry.test.ts:397-399` | OK |
| CD-3 (`kite-ozone/` solo additive) | `kite-ozone/index.ts:38` cambio additive (`opts?`), interno sin tocar | OK |
| CD-5 (single debit per request) | `a2a-key.test.ts:765-805` | OK |
| CD-6 (<50ms hot path) | Resolver es pure module sin I/O — `chain-resolver.ts` | OK (no medido en F3, F4 lo valida) |
| CD-7 (logs estructurados chainKey/chainId/asset_symbol) | `a2a-key.test.ts:711-761` | OK |
| CD-12 (debit & getBalance same bundle chainId) | `a2a-key.ts:220, 241, 250, 275` (grep manual) + `a2a-key.test.ts:834-840` | OK |
| CD-13 (conflict warning) | `registry.test.ts:207-220` | OK |
| CD-14 (header invalid → undefined, no silent default) | `chain-resolver.test.ts:100-108` + `a2a-key.test.ts:657-677` | OK |
| CD-15 (canonical x402 only, no Pieverse) | `avalanche/payment.ts` no menciona `pieverse` | OK |
| CD-16 (no discovery calls en middleware) | `a2a-key.ts:90-296` (grep: 0 `discoveryService` imports) | OK |
| CD-17 (test isolation: `_resetRegistry`, `_resetWalletClient`) | `registry.test.ts:80`, `avalanche.test.ts:45,96` | OK |
| CD-18 (bundle immutable) | Solo lectura — no se observó mutación en call-sites | OK |
| CD-19 (anti-prototype-pollution) | `chain-resolver.ts:20-43,55` + `chain-resolver.test.ts:58-64` | OK |

CDs **no verificables en AR** (requieren F4 QA con runtime real):

- CD-4 (baseline 379+ tests): Dev reporta 908/908. F4 confirma.
- CD-6 (<50ms): requiere medición. F4 mide.
- CD-8 (no romper wasiai-v2 prod): smoke F4.
- CD-10 (deposit Avalanche procedure documentado): F4 lee `MULTI-CHAIN.md`.

---

## Recomendaciones para CR (al code-review paralelo)

1. **CR debería confirmar el grep `getPaymentAdapter()` no-arg vs default chain shift**
   — verificar si todos los call-sites en `compose.ts`, `x402.ts`,
   `fee-charge.ts`, `mcp/tools/pay-x402.ts` están documentados como
   "default-chain expected" o si alguno debería tener chainKey explícito
   (MIN-1).

2. **CR debería revisar el drift de normalización entre
   `chain-resolver.ts` (DT-E aliases) y `discovery.ts:56-60`
   (ALLOWED_CHAIN_VALUES)** — son módulos disjuntos con reglas distintas
   sobre los mismos slugs. La inconsistencia está documentada pero
   merece un TD explícito (MIN-2).

3. **CR debería verificar la calidad de los JSDoc / comentarios in-line
   en `kite-ozone/index.ts:38-78`** — el `try/finally` con DT-I es el
   patrón más sutil del refactor. Está bien documentado pero confirmar
   que el README/MULTI-CHAIN.md §8 trackea TD-NEW-KITE-PARAMS.

4. **CR debería confirmar que `_resetWalletClient` y `_resetRegistry`
   están en `beforeEach` de TODOS los tests que tocan el registry o
   adapters Avalanche** — un test que olvide el reset puede contaminar
   los subsiguientes (CD-17). Yo verifiqué `registry.test.ts:80`,
   `avalanche.test.ts:45,96`, `kite-factory.test.ts:44-50` — todos OK.

5. **CR debería revisar el flow del `assetSymbol` fallback `?? 'UNKNOWN'`
   en `a2a-key.ts:221`** — defensivo pero unreachable en práctica (todos
   los `supportedTokens` arrays tienen >= 1 entry hoy). No es un bug,
   pero el código muerto puede ocultar regresiones futuras si
   `supportedTokens` se vuelve dinámico.

---

## Confianza del veredicto

**Alta** — los 5 vectores CD-9 explícitos están **defendidos con tests
concretos** que pude validar leyendo archivo:línea. Los hallazgos MENORES
son foot-guns operacionales o gaps de documentación, no vulnerabilidades.
El refactor preserva backward-compat y los chainId nunca se cruzan entre
operaciones (CD-12).

**Riesgo residual** asociado al merge: bajo. MIN-1 es real pero solo se
activa si un operator cambia el orden del CSV (config error, no exploit
externo). MIN-2 ya está testeada como "by design".

---

*AR Report generado por `nexus-adversary` (F5) — 2026-05-13.*
*HU: WKH-MULTICHAIN. NNN: 086. Branch: `feat/086-wkh-multichain-a2a` @ `c26a14b`.*
