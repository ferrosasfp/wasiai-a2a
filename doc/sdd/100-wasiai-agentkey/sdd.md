# SDD — [WKH-100] wasiai-agentkey: ERC-8004 Identity Binding (Fase 1)

> Spec-Driven Design. Input: `work-item.md` (12 ACs EARS + 9 CDs, HU_APPROVED).
> Modo QUALITY. Server **READ-ONLY** contra el IdentityRegistry ERC-8004 en Base.
> El Architect lee código; NO escribe producción. Este documento es el contrato
> técnico que F2.5 convierte en Story File.
>
> **Revisión 2 (humano resolvió DT-12 → in-scope):** AC-8 deja de ser deuda y se
> implementa end-to-end REAL. La tesis "más pro que Kite" = **identidad unificada**:
> la misma AgentID ERC-8004 sirve para *descubrir* (AgentCard en `/discover`) Y para
> *pagar* (Agent Key). Esta revisión diseña el **puente key-row → discovery** con un
> mecanismo grounded en el modelo real (ver DT-12 reescrito + DT-18/DT-19, §1.4 y W5/W7).

---

## 0. Context Map — archivos leídos y patrón extraído

| Archivo (línea clave) | Por qué lo leí | Patrón extraído |
|---|---|---|
| `src/middleware/a2a-key.ts:140-293` | Cómo se resuelve `request.a2aKeyRow`; cómo se augmenta | El row completo (`select('*')`) se asigna a `request.a2aKeyRow` (l.284). `erc8004_identity` ya viaja en ese row. Augmentar `identity_verified` requiere derivarlo del row (no RPC). |
| `src/services/identity.ts:110-138` (`bindFundingWallet`) | Patrón exacto de UPDATE con Ownership Guard | `.update({...}).eq('id', keyId).eq('owner_ref', ownerId).select('id')`; si `data.length === 0` → `logOwnershipMismatch(...)` + `throw new OwnershipMismatchError()`. **Replicar exacto.** Error code `23505` → error de unicidad tipado. |
| `src/services/identity.ts:63-77` (`lookupByHash`) | Cómo se lee un row antes de operar | `select('*').eq('key_hash').single()`; `PGRST116` → `null`. Para la idempotencia AC-5 leeré el row actual (ya disponible en `request.a2aKeyRow`, sin re-query). |
| `src/types/a2a-key.ts:24` | Shape actual de `erc8004_identity` | Hoy `Record<string, unknown> \| null`. DT-4 lo tipa como `Erc8004IdentityBinding \| null`. |
| `src/types/a2a-key.ts:91-95` (`AgentMeResponse.bindings`) | Surfacing en `/me` (AC-7) | `bindings.erc8004_identity` YA se devuelve (auth.ts:351). AC-7 es **no-op de comportamiento**, solo se re-tipa. Verificar que sigue serializando con `verified_at`. |
| `src/adapters/deposit-verifier.ts:124-181` | Patrón viem read-only multichain | `resolveRpcUrl(chainKey)` switch por env (l.124-139); lazy `Map<ChainKey, PublicClient>` (l.163-176); `_resetVerifier()` test-only (l.179); RPC ausente → `{ ok:false, reason:'RPC_UNAVAILABLE' }`. **Replicar este estilo en `erc8004-identity.ts`.** |
| `src/adapters/deposit-verifier.ts:185-310` | Manejo de errores RPC en lecturas | Cada `await client.xxx()` en `try/catch` → reason tipada; `RPC_UNAVAILABLE` cuando el RPC falla. Nunca `throw` hacia arriba; se devuelve resultado tipado. |
| `src/adapters/base/chain.ts:27-47` | Resolución testnet/mainnet | `getBaseNetwork()` lee `BASE_NETWORK` env; `getBaseChain('mainnet'\|'testnet')` → `base`(8453)/`baseSepolia`(84532). Reutilizar. |
| `src/adapters/base/index.ts:35` | Estado actual del bundle Base | `identity: null` en `createBaseAdapters`. Esta HU lo deja en `null` **a propósito** (ver DT-10): el reader ERC-8004 NO entra al `AdaptersBundle` porque es un módulo independiente env-driven, no per-chainKey-bundle. |
| `src/adapters/kite-ozone/gasless.ts:217-230` | Patrón exacto `readContract` + ABI `as const` | ABI inline `[{ name, type:'function', stateMutability:'view', inputs, outputs }] as const`, `functionName`, `args`, todo en `try/catch`. **Plantilla literal para `ownerOf`/`tokenURI`.** |
| `src/adapters/types.ts:104-145` | Interfaz `IdentityBindingAdapter` + `AdaptersBundle` | La firma actual (`bind(keyId, chainAddress, sig)` + `verify(keyId)`) **NO coincide** con Fase 1 (NC-1: read-only, sin sig, sin keyId). Decisión en DT-11: NO mutilo `IdentityBindingAdapter` (lo usan los bundles); creo interfaz nueva `Erc8004IdentityReader`. |
| `src/routes/auth.ts:55-211` | Patrón de ruta autenticada + validación | `resolveCallerKey(req)` (l.57) resuelve por header/Bearer; `!callerKey?.is_active` → 403; validación de input estricta con regex + `error_code`; errores tipados → status code mapeado. **Plantilla literal para `/auth/erc8004/bind`.** El prefix de montaje es `/auth` (index.ts:121). |
| `src/routes/auth.ts:330-357` (`/me`) | AC-7 surfacing | Devuelve `bindings.erc8004_identity` tal cual del row. Confirmar que el re-tipado a `Erc8004IdentityBinding` no rompe el handler (es asignable a JSON). |
| `src/services/agent-card.ts:86-147` (`buildAgentCard`) | Punto de extensión AC-8 (camino `/agents/:id/agent-card`) | `buildAgentCard(agent, registryConfig, baseUrl)` arma la AgentCard. `agent` es un `Agent` de discovery (registry externo), NO trae `A2AAgentKeyRow`. El link NO existe hoy → se construye con un resolver explícito (DT-12 reescrito). |
| `src/services/discovery.ts:113-215` (`discover`) | **Hallazgo crítico para AC-8 vía `/discover`** | `discover()` devuelve `Agent[]` **crudo** (`discovery.ts:210-214`); NO llama `buildAgentCard`. El `Agent` se construye en `mapAgent` (l.298-331) desde la respuesta HTTP del registry externo (`metadata: raw`, l.328). **No hay join a DB.** Por lo tanto AC-8 "surfaced via `/discover`" requiere enriquecer el resultado de `discover()` aparte del `buildAgentCard` (DT-18). |
| `src/services/discovery.ts:298-331` (`mapAgent`) | Cómo nace un `Agent` | Campos derivados del raw upstream: `slug` (l.301), `verified` (l.320), `payment.contract` = payTo wallet (`readPayment`, l.62-111). `metadata: raw` es el payload upstream sin sanitizar. NO hay `owner_ref` ni `erc8004_identity`. |
| `src/routes/discover.ts:21-135` | Endpoints discovery | `GET/POST /discover` → `discover()` → `result` crudo (l.40-53, 94-107). `GET /discover/:slug` → `getAgent` crudo. El enrich de identidad debe ocurrir DENTRO de `discover()`/`getAgent()` o entre service y reply (DT-18). |
| `src/routes/agent-card.ts:19-69` | Cómo se invoca `buildAgentCard` | `discoveryService.getAgent(slug, registry)` → `Agent`; luego `buildAgentCard`. La AgentCard NO tiene acceso a la key row del owner por sí sola → el resolver de identidad (DT-12/DT-19) la inyecta antes. |
| `src/types/index.ts:118-135` (`Agent`) | Shape del agente de discovery | `Agent` tiene `metadata?: Record<string,unknown>`, `verified`, `slug`, `registry` (name), `payment?.contract` (payTo). **NO tiene `erc8004_identity` ni `owner_ref`.** El único identificador estable cross-source es `(registry, slug)`. |
| `src/services/identity.ts:60-77` (`lookupByHash`) + `:26-58` (`createKey`) | Patrón query/insert sobre `a2a_agent_keys` | `createKey` ya persiste `allowed_agent_slugs` (l.41). El reverse-lookup de identidad (DT-12) reusa el cliente `supabase` con `.from('a2a_agent_keys').select(...)`. |
| `src/services/registry.ts:71-72,88` | `owner_ref` en registries (WKH-63) | Las registries tienen `owner_ref`/`ownerRef`. Confirma que el owner-model existe en registries pero **NO se propaga al `Agent` discovered** (el `Agent` viene del HTTP del registry, no del row local). Refuerza por qué el link debe ser explícito en la key row, no inferido. |
| `src/services/agent-card.test.ts:39-60` | Harness de test AgentCard | `Agent`/`RegistryConfig` sintéticos; `buildAgentCard` puro sin red. Se extiende para AC-8 (con/sin `identity` inyectada). |
| `src/types/index.ts:491-526` (`AgentCard`) | Dónde añadir `identity` | Extensión top-level no-breaking (igual que `inputSchema`/`outputSchema`, l.520/525, surfaced con spread condicional `...(x !== undefined && {x})`). |
| `src/services/security/errors.ts:9-74` | Patrón de error classes | `class XError extends Error { readonly code = 'CODE' as const; constructor(){ super(msg); this.name='XError'; } }`. **Plantilla para los nuevos errores ERC-8004.** |
| `src/adapters/registry.ts:42-87` | `buildBundle` dispatcher | `createBaseAdapters({network})` se llama para `base-sepolia`/`base-mainnet`. El reader ERC-8004 NO toca este dispatcher (DT-10). |
| `.env.example:434-465` | Env Base existente | `BASE_NETWORK`, `BASE_TESTNET_RPC_URL`, `BASE_MAINNET_RPC_URL` YA existen. Solo falta `ERC8004_REGISTRY_ADDRESS_*`. |

### Auto-Blindaje histórico consultado (últimas DONE)

- **WKH-35 (096)** `auto-blindaje.md`: (a) tipar dispatchers de `chain` de viem como `Chain` base, NO union de `ReturnType`; (b) comparar montos on-chain en `bigint`/atómico, NUNCA `Number()` (no aplica acá, no hay montos); (c) `grep 501 src/__tests__` antes de cerrar cuando se re-habilita un endpoint; (d) FIX-1 (treasury compartido → exigir `from`): **paralelo conceptual** — acá la prueba de posesión es `ownerOf == funding_wallet`, ya cubierta por AC-4. → **CD-10, CD-11**.
- **WKH-AUDIT (097)** `auto-blindaje.md`: `npm run format` toca archivos fuera de scope; `format ≠ lint` (organizeImports). → **CD-12** (usar `biome check --write <file>` scoped). Lint clean solo sobre archivos in-scope.

---

## 1. Arquitectura

### 1.1 Componente nuevo — `src/adapters/erc8004-identity.ts` (lectura on-chain)

Módulo **independiente** (NO entra al `AdaptersBundle`; ver DT-10), estilo
calcado de `deposit-verifier.ts`. Read-only, env-driven, sin estado mutable.

```
Erc8004IdentityReader (interfaz nueva — DT-11)
├─ verifyOwnership({ tokenId, expectedOwner }) → Erc8004VerifyResult
│     reads ownerOf(tokenId) → compara lowercase contra expectedOwner
└─ resolve({ tokenId }) → Erc8004ResolveResult
      reads tokenURI(tokenId) → { ok, agentCardUrl, raw? } | { ok:false, reason }
```

- **publicClient**: `Map<'base-mainnet'|'base-sepolia', PublicClient>` lazy
  (cache propio, NO compartido con el deposit-verifier — DT-7). Init vía
  `createPublicClient({ chain: getBaseChain(network), transport: http(rpcUrl) })`.
- **Registry address**: `resolveRegistryAddress(network)` — env
  `ERC8004_REGISTRY_ADDRESS_BASE_MAINNET` / `ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA`,
  fallback a `ERC8004_REGISTRY_ADDRESS` (global). Validado contra `ADDRESS_RE`.
  Ausente/ inválido → `REGISTRY_NOT_CONFIGURED` (fail-loud, sin RPC). **CD-1/CD-4.**
- **RPC URL**: `resolveRpcUrl(network)` → `BASE_MAINNET_RPC_URL` / `BASE_TESTNET_RPC_URL`
  (mismas vars que el deposit-verifier l.135-137). Ausente → `RPC_UNAVAILABLE`.
- **Network**: `getBaseNetwork()` de `base/chain.ts` (env `BASE_NETWORK`).
- **ABI** `as const`, mínimo ERC-721 (DT-3):
  ```
  [
    { name:'ownerOf',  type:'function', stateMutability:'view',
      inputs:[{name:'tokenId',type:'uint256'}], outputs:[{name:'',type:'address'}] },
    { name:'tokenURI', type:'function', stateMutability:'view',
      inputs:[{name:'tokenId',type:'uint256'}], outputs:[{name:'',type:'string'}] },
  ] as const
  ```
- **Timeout**: `http(rpcUrl, { timeout: <ms> })` con
  `ERC8004_RPC_TIMEOUT_MS` env (fallback 8000). RPC colgado → la promesa rechaza →
  `try/catch` → `RPC_UNAVAILABLE` (AC-11). **CD-8: jamás `WalletClient`/`writeContract`.**
- **Errores**: NUNCA `throw` hacia el handler para fallos esperados; devolver
  result tipado `{ ok:false, reason }`. `ownerOf` de un tokenId inexistente
  revierte → se mapea a `TOKEN_NOT_FOUND` (no `RPC_UNAVAILABLE`): distinguir
  revert (ContractFunctionExecutionError de viem) de error de transporte.
- `_resetErc8004Reader()` test-only (patrón `_resetVerifier`).

```ts
// firma del result (definida en src/adapters/erc8004-identity.ts)
type Erc8004ReadReason =
  | 'RPC_UNAVAILABLE'        // transporte caído / timeout
  | 'REGISTRY_NOT_CONFIGURED'// address de registry ausente o inválida
  | 'TOKEN_NOT_FOUND'        // ownerOf/tokenURI revierte (token inexistente)
  | 'CHAIN_MISMATCH';        // getChainId() != chainId esperado de la red
interface Erc8004VerifyResult {
  ok: boolean;
  reason?: Erc8004ReadReason;
  owner?: `0x${string}`;       // ownerOf(tokenId), lowercase normalizado en el service
  matches?: boolean;           // owner.toLowerCase() === expectedOwner.toLowerCase()
  chainId?: number;
}
interface Erc8004ResolveResult {
  ok: boolean;
  reason?: Erc8004ReadReason;
  tokenUri?: string;           // tokenURI crudo (ipfs:// | https:// | data:)
  chainId?: number;
}
```

### 1.2 Service — `identityService.bindErc8004Identity(...)` (`src/services/identity.ts`)

Método nuevo, calcado de `bindFundingWallet` (l.110-138). NO hace RPC (el RPC
ya lo hizo el handler vía el reader); solo persiste con Ownership Guard.

```ts
async bindErc8004Identity(
  keyId: string,
  ownerId: string,
  binding: Erc8004IdentityBinding,   // ya validado por el handler
): Promise<Erc8004IdentityBinding> {
  // 1. UPDATE con Ownership Guard COMPLETO (CD-3). NO toca budget (CD-2).
  //    Se escribe el objeto JSONB completo en la columna erc8004_identity.
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .update({ erc8004_identity: binding })
    .eq('id', keyId)
    .eq('owner_ref', ownerId)
    .select('id');
  if (error) throw new Error(`Failed to bind erc8004 identity: ${error.message}`);
  if (!data || data.length === 0) {
    logOwnershipMismatch('deactivate', keyId, ownerId); // ver DT-13 (label backlog)
    throw new OwnershipMismatchError();
  }
  return binding;
}
```

- La **idempotencia AC-5** se decide en el handler ANTES de llamar al service,
  leyendo `request.a2aKeyRow.erc8004_identity` (DT-8). El service no re-consulta.
- El service NO menciona `budget`, `increment_a2a_key_spend` ni
  `register_a2a_key_deposit` (CD-2 / AC-12).

### 1.3 Rutas — `src/routes/auth.ts` (montadas bajo prefix `/auth`)

**`POST /auth/erc8004/bind`** (AC-1, AC-3, AC-4, AC-5, AC-11)
```
1. callerKey = resolveCallerKey(req); if (!callerKey?.is_active) → 403
2. body.token_id válido (string|number → uint256). Inválido → 400 INVALID_INPUT (DT-14)
2b. body.agent_slug OPCIONAL (AC-8 puente). Si presente: string no vacío, trim,
    regex slug `^[a-z0-9][a-z0-9-]{0,127}$` (mismo estilo permisivo que slugs de
    discovery). Inválido → 400 INVALID_INPUT. Ausente → binding sin `agent_slug`
    (la key NO surfacea en discovery; opt-in — DT-20).
3. if (!callerKey.funding_wallet) → 400 FUNDING_WALLET_NOT_BOUND (AC-3, sin RPC)
4. IDEMPOTENCIA (AC-5/DT-8): network → chainId esperado;
   if (existing erc8004_identity?.token_id === token_id && existing.chain_id === chainId)
      → 409 ERC8004_ALREADY_BOUND (sin RPC, sin overwrite)
5. reader.verifyOwnership({ tokenId, expectedOwner: callerKey.funding_wallet })
   - !ok && reason RPC_UNAVAILABLE → 503 { ok:false, reason:'RPC_UNAVAILABLE' } (AC-11)
   - !ok && reason REGISTRY_NOT_CONFIGURED → 503 (misconfig, fail-loud)
   - !ok && reason TOKEN_NOT_FOUND → 404 ERC8004_TOKEN_NOT_FOUND
   - !ok && reason CHAIN_MISMATCH → 502 ERC8004_CHAIN_MISMATCH
   - ok && !matches → 403 IDENTITY_OWNERSHIP_MISMATCH (AC-4, sin write)
6. reader.resolve({ tokenId }) → agent_card_url (tokenURI). resolve falla:
   - bind NO debe quedar bloqueado por un tokenURI vacío → guardar agent_card_url:''
     si resolve no-ok (DT-15). El binding principal es ownerOf-verified.
7. binding = { token_id, chain_id, agent_card_url, owner_address: funding_wallet.toLowerCase(),
               verified_at: new Date().toISOString(),
               ...(agent_slug && { agent_slug }) }   // AC-8 puente, opt-in (DT-20)
8. identityService.bindErc8004Identity(callerKey.id, callerKey.owner_ref, binding)
   - OwnershipMismatchError → 403 OWNERSHIP_MISMATCH
9. 200 { erc8004_identity: binding }
```
- CD-2/AC-12: este handler NUNCA llama budget. Sin debit, sin credit.

**`GET /auth/erc8004/resolve/:token_id`** (AC-2, AC-11)
```
1. params.token_id válido uint256 → si no → 400 INVALID_INPUT
2. reader.resolve({ tokenId })
   - RPC_UNAVAILABLE → 503 { ok:false, reason:'RPC_UNAVAILABLE' }
   - REGISTRY_NOT_CONFIGURED → 503
   - TOKEN_NOT_FOUND → 404 ERC8004_TOKEN_NOT_FOUND
3. tokenUri:
   - https?:// → 200 { token_id, chain_id, agent_card_url, url, raw:null } (DT-16: NO fetch
     ciego al URL — SSRF; se devuelve la url para que el caller resuelva)
   - ipfs:// / data: / otro → 200 { token_id, chain_id, agent_card_url, scheme } sin fetch
   AC-2 dice "AgentCard JSON or { url, raw }". DT-16 resuelve: por seguridad SSRF
   NO se hace fetch server-side en Fase 1; se devuelve la URI cruda y su scheme.
```
- **Auth**: `GET /resolve` es lectura pública on-chain → NO requiere auth
  (consistente con `GET /deposit-info`, auth.ts:371). Rate-limit global aplica.

### 1.4 Puente identidad-unificada key-row → discovery (AC-8, end-to-end REAL)

**El problema real (grounded):** el `Agent` de discovery se construye en
`mapAgent` (`discovery.ts:298-331`) desde la respuesta HTTP de un registry
externo (`metadata: raw`, l.328). NO tiene `owner_ref`, NO trae `A2AAgentKeyRow`,
y `discover()` (l.210-214) devuelve `Agent[]` crudo sin pasar por `buildAgentCard`.
El único identificador estable cross-source es **`(registry, slug)`** (l.301, 324).

**Mecanismo de link elegido (DT-12 reescrito): referencia explícita owner-declarada
+ reverse-lookup verificado.** Se evaluaron 3 opciones (detalle y descarte en DT-12):

1. ❌ **Vía `owner_ref` compartido** — el `Agent` discovered NO tiene `owner_ref`
   (`src/types/index.ts:118-135`); derivarlo del payload del registry exigiría
   confiar en un campo provisto por un registry potencialmente comprometido →
   viola CD-7 (sin backend propietario de identidad) y es spoofable. **Descartado.**
2. ❌ **Vía `allowed_agent_slugs`** — esa columna es *caller-scoping* (qué slugs
   puede pagar una key), semántica equivocada: N keys pueden listar el mismo slug.
   No expresa "yo SOY este agente". **Descartado.**
3. ✅ **Referencia explícita en la key row (elegido).** Al bindear, el owner
   declara el `agent_slug` (+ `registry` opcional) que esta AgentID representa. Se
   persiste DENTRO del JSONB `erc8004_identity` (NO columna nueva → backward-compat
   AC-9/CD-9, sin migration). Al servir discovery, un resolver hace **reverse-lookup**
   `a2a_agent_keys WHERE erc8004_identity->>'agent_slug' = :slug` y surfacea
   `identity` SOLO si hay match. El `verified:true` es **honesto** porque el
   binding fue `ownerOf`-verificado on-chain al bindear (CD-10). El source of truth
   es literalmente "la Agent Key row del agente", **exactamente como dice AC-8**.

**Por qué es el más limpio y mínimo:** sin columna nueva, sin migration, sin
confiar en el registry, sin acoplar discovery a budget (CD-2), sin RPC al servir
(el verify ya ocurrió al bindear — read-only en discovery, CD-8). Una sola query
JSONB indexable. El owner controla explícitamente el link (no inferencia frágil).

#### 1.4.1 Nuevo resolver — `identityService.resolveIdentityForSlug(slug)` (`src/services/identity.ts`)

```ts
// Reverse-lookup read-only. NO Ownership Guard (es lectura PÚBLICA de un dato
// públicamente verificable on-chain; NO expone budget ni datos sensibles).
// Devuelve SOLO los 3 campos públicos del AgentCard (CD-2: jamás budget).
async resolveIdentityForSlug(
  slug: string,
): Promise<AgentCardIdentity | null> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('erc8004_identity')
    .eq('erc8004_identity->>agent_slug', slug)  // JSONB key filter
    .not('erc8004_identity', 'is', null)
    .eq('is_active', true)                       // solo keys activas surfacean
    .limit(1)
    .maybeSingle();
  if (error || !data?.erc8004_identity) return null;
  const b = data.erc8004_identity as Erc8004IdentityBinding;
  if (!b.agent_slug || b.agent_slug !== slug) return null; // defensa shape
  return { erc8004_token_id: b.token_id, chain_id: b.chain_id, verified: true };
}
```
- **[VERIFY-AT-IMPL] Sintaxis del filtro JSONB.** El codebase HOY no usa filtros
  JSONB `->>` ni `.not()`/`maybeSingle` en `src/services/` (grep: 0 ocurrencias).
  El Dev DEBE confirmar contra la versión instalada de `@supabase/supabase-js` la
  forma exacta del filtro por clave JSONB. Dos formas válidas según versión:
  `.eq('erc8004_identity->>agent_slug', slug)` o
  `.filter('erc8004_identity->>agent_slug', 'eq', slug)`. Si ninguna funciona como
  espera PostgREST, fallback robusto: traer candidatas activas con
  `.not('erc8004_identity', 'is', null).eq('is_active', true)` y filtrar
  `agent_slug` en JS (la defensa de shape `b.agent_slug === slug` ya está en el
  código). NO es bloqueante para el SDD (la lógica es correcta); es verificación
  física de sintaxis en F3.
- **Seguridad del reverse-lookup:** este SELECT NO filtra por `owner_ref` **a
  propósito** (DT-19): a diferencia del Ownership Guard (que protege mutaciones y
  lecturas de datos privados como budget), acá se expone únicamente
  `{ token_id, chain_id, verified }` — datos públicamente verificables en la
  blockchain por cualquiera. NO se selecciona `budget`, `funding_wallet` ni nada
  sensible (`.select('erc8004_identity')` only). **No es un IDOR**: no hay
  `keyId` del caller, no hay dato privado. Documentado en DT-19 + §7 para que
  AR/CR no lo marquen falso-positivo contra la regla de CLAUDE.md.
- Sin `agent_slug` declarado en el binding → la key NO aparece en discovery
  (opt-in: el owner elige exponer la identidad en discovery declarando el slug).

#### 1.4.2 `buildAgentCard` — surfacing en `/agents/:id/agent-card` (AC-8)

`buildAgentCard` gana un 3er-input opcional `identity?: AgentCardIdentity`
(resuelto por el route ANTES de llamar, igual que `registryConfig`/`baseUrl`):

```ts
buildAgentCard(agent, registryConfig, baseUrl, identity?) {
  ...
  ...(identity !== undefined && { identity }),  // spread condicional, no-breaking
}
```
El route `agent-card.ts` resuelve la identidad y la inyecta:
```ts
const agent = await discoveryService.getAgent(slug, registry);
...
const identity = await identityService.resolveIdentityForSlug(agent.slug);
const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl,
  identity ?? undefined);
```

#### 1.4.3 `/discover` enrich — `discover()` y `getAgent()` (AC-8 "surfaced via /discover")

Como `discover()` devuelve `Agent[]` crudo (no AgentCard), el `identity` se
inyecta **en el propio `Agent`** vía un nuevo campo opcional `Agent.identity?`.
Decisión DT-18: el enrich vive en el **service** `discoveryService`, batch, tras
el merge/sort/limit, para no romper el flujo de filtros:
```ts
// discovery.ts, al final de discover(), sobre `limited` (post-limit, mínimas queries):
const enriched = await this.attachIdentities(limited);
// attachIdentities: para cada agent, resolveIdentityForSlug(agent.slug);
//   set agent.identity si !null. Lecturas en paralelo (Promise.all). Sin RPC.
//   Falla de DB en una query → ese agent queda sin identity (no rompe discover).
```
- `getAgent(slug)` (usado por `/discover/:slug` y por `agent-card.ts`) también
  setea `agent.identity` antes de devolver (un solo lookup).
- **Performance (DT-18):** se resuelve solo sobre la página ya limitada
  (`limited`, discovery.ts:208), no sobre `allAgents`. Query indexable (índice
  funcional sugerido, ver §8 TD-ERC8004-03; no bloqueante en Fase 1).
- **Backward-compat (AC-9/CD-9):** agentes sin key con identidad → `identity`
  ausente (omitido, no `null`). El shape de `Agent`/`DiscoveryResult` no cambia
  para consumidores que no lo leen.

#### 1.4.4 Tipos (W0)

- `src/types/index.ts`: `AgentCard.identity?: AgentCardIdentity` (top-level,
  opcional) y `Agent.identity?: AgentCardIdentity`. Nuevo tipo compartido:
  ```ts
  export interface AgentCardIdentity {
    erc8004_token_id: string;  // = token_id del binding
    chain_id: number;          // 8453 | 84532
    verified: true;            // literal: solo se surfacea si verificado on-chain
  }
  ```
- DT-6/CD-9: top-level, opcional, omitido cuando ausente. No rompe parsers.

### 1.5 Middleware — `identity_verified` derivado (AC-6)

`requirePaymentOrA2AKey` (a2a-key.ts) y `resolveCallerKey` (auth.ts) ya cargan
el row completo. AC-6 pide exponer `identity_verified: true` en
`request.a2aKeyRow` **sin RPC nuevo**. DT-17: se NO muta la fila de DB; se expone
un campo derivado. Dos opciones evaluadas → elegida la (b):
- (a) augmentar `request` con `identity_verified` → requiere declaration merge nuevo.
- (b) **helper puro** `isIdentityVerified(row): boolean = row.erc8004_identity != null`
  exportado desde `src/services/identity.ts`, y augmentar
  `request.a2aKeyRow` NO se modifica (el row ya tiene `erc8004_identity`; cualquier
  handler deriva el flag con el helper). Se añade además, por literalidad del AC-6
  ("expose `identity_verified: true` on `request.a2aKeyRow`"), el set
  `request.a2aKeyRow.erc8004_verified = isIdentityVerified(keyRow)` como campo
  in-memory (NO persistido), tipado en `A2AAgentKeyRow` como
  `erc8004_verified?: boolean` (transient). Se setea en a2a-key.ts (tras l.284) y
  en `resolveCallerKey`. Sin RPC. **CD-2: no toca budget.**

---

## 2. Waves de implementación

> W0 serial (contratos/tipos/env/ABI). W1+ dependen de W0. Tests al final de cada
> wave de lógica + suite dedicada en W6.

| Wave | Objetivo | Archivos | Depende |
|---|---|---|---|
| **W0** | Tipos + ABI + env + errores (contratos) | `src/types/a2a-key.ts` (interface `Erc8004IdentityBinding` + `agent_slug?`, `erc8004_verified?`), `src/types/index.ts` (`AgentCardIdentity`, `AgentCard.identity?`, `Agent.identity?`), `src/services/security/errors.ts` (4 error classes), `.env.example` (vars) | — |
| **W1** | Reader on-chain read-only | `src/adapters/erc8004-identity.ts` (nuevo): ABI `as const`, lazy clients, `resolveRegistryAddress`, `resolveRpcUrl`, `verifyOwnership`, `resolve`, `_resetErc8004Reader` | W0 |
| **W2** | Service bind + reverse-lookup | `src/services/identity.ts` (`bindErc8004Identity`, `resolveIdentityForSlug`) | W0 |
| **W3** | Rutas | `src/routes/auth.ts` (`POST /erc8004/bind` con `agent_slug` opt-in, `GET /erc8004/resolve/:token_id`) | W1, W2 |
| **W4** | Middleware lazy flag (AC-6) | `src/middleware/a2a-key.ts`, `src/routes/auth.ts` (`resolveCallerKey`), `src/services/identity.ts` (`isIdentityVerified`) | W0 |
| **W5** | **Puente identidad → discovery (AC-8 end-to-end)** | `src/services/agent-card.ts` (`buildAgentCard` gana arg `identity?`), `src/routes/agent-card.ts` (resuelve+inyecta identity), `src/services/discovery.ts` (`discover`/`getAgent` setean `Agent.identity` vía `attachIdentities`→`resolveIdentityForSlug`), `src/types/index.ts` (ya en W0) | W0, W2 |
| **W6** | Tests unit (≥1 por AC) | `src/adapters/erc8004-identity.test.ts`, `src/routes/auth.erc8004.test.ts`, `src/services/agent-card.test.ts` (extensión), `src/services/discovery.test.ts` (extensión: enrich identity) | W1-W5 |
| **W7** | **Test integración end-to-end identidad-unificada (AC-8)** | `src/__tests__/erc8004-identity-bridge.e2e.test.ts` (nuevo): bind identity con `agent_slug` → assert `identity:{erc8004_token_id, chain_id, verified:true}` aparece en (a) `GET /agents/:slug/agent-card` y (b) el `Agent` servido por `GET`/`POST /discover`. Mock RPC + supabase row real-shape. | W1-W5 |

Nota: `src/adapters/base/identity.ts`, `src/adapters/base/index.ts`,
`src/adapters/registry.ts`, `src/adapters/types.ts` **NO se tocan** (ver DT-10/DT-11) —
desviación consciente del Scope IN literal del work-item, justificada abajo.

---

## 3. Decisiones Técnicas (DT-N)

**DT-1 — Chain canónica.** Base mainnet (8453) prod, Base Sepolia (84532) dev.
`getBaseNetwork()` (env `BASE_NETWORK`) resuelve. Registry address por red (DT-3).

**DT-2 — Read-only (NC-1).** Sin `WalletClient`, sin `writeContract`, sin
`OPERATOR_PRIVATE_KEY`. Solo `publicClient.readContract`. Incondicional (CD-8).

**DT-3 — ABI mínimo verificado.** Solo `ownerOf(uint256)→address` y
`tokenURI(uint256)→string` — ambas **estándar ERC-721** (ERC-8004 = ERC-721 +
URIStorage). El ABI se expresa inline `as const` (patrón gasless.ts:219-227). NO
se importa ABI de `mint`. **[VERIFY-AT-IMPL]**: F3 confirma en
`github.com/erc-8004/erc-8004-contracts` o en el explorer de Base que estas dos
firmas son idénticas a ERC-721 antes de codear (no son funciones no-estándar).
Si difieren → escalar al humano antes de proceder. No es bloqueante para el SDD
(son funciones estándar), pero la verificación física es obligatoria en F3.

**DT-4 — Shape JSONB `Erc8004IdentityBinding`** (en `src/types/a2a-key.ts`,
reemplaza `Record<string, unknown>`):
```ts
export interface Erc8004IdentityBinding {
  token_id: string;        // uint256 serializado como string decimal (sin pérdida)
  chain_id: number;        // 8453 | 84532
  agent_card_url: string;  // tokenURI resuelto; '' si resolve falló al bindear (DT-15)
  owner_address: string;   // lowercase (== funding_wallet al momento del bind)
  verified_at: string;     // ISO 8601 del verify server-side
  agent_slug?: string;     // AC-8 puente identidad-unificada. Opt-in: si el owner
                           // lo declara, la AgentID surfacea en /discover para ese slug
                           // (reverse-lookup DT-12). Ausente → no surfacea (DT-20).
}
```
`A2AAgentKeyRow.erc8004_identity: Erc8004IdentityBinding | null`. Se añade también
el campo transient `erc8004_verified?: boolean` (DT-17, NO columna DB). El
`agent_slug` vive DENTRO del JSONB existente → **sin columna nueva, sin migration**
(AC-9/CD-9). Nuevo tipo `AgentCardIdentity` (§1.4.4) en `src/types/index.ts`.

**DT-5 — Prueba de posesión `funding_wallet == ownerOf` (NC-2).** Comparación
`ownerOf(tokenId).toLowerCase() === funding_wallet.toLowerCase()`. Sin firma nueva.
`funding_wallet` ya probado on-chain en WKH-35.

**DT-6 — `identity` top-level en AgentCard.** No anidado en `capabilities`.
Opcional, omitido cuando ausente (spread condicional). No-breaking (DT-6 wk-item).

**DT-7 — Lazy cache propio.** `Map<'base-mainnet'|'base-sepolia', PublicClient>`
independiente del deposit-verifier. `_resetErc8004Reader()` test-only.

**DT-8 — Idempotencia en el handler, no en el service.** El handler lee
`callerKey.erc8004_identity` (ya en `request.a2aKeyRow`/`resolveCallerKey`). Si
`token_id` coincide para el mismo `chain_id` → 409 `ERC8004_ALREADY_BOUND` ANTES
de cualquier RPC o UPDATE. El service no re-consulta (evita doble round-trip).
**Race:** dos binds concurrentes podrían pasar el check; el segundo UPDATE
sobreescribiría. Mitigación Fase 1: aceptable (mismo owner, mismo token; el
overwrite es idempotente en datos). Hardening real (UNIQUE parcial / check
en SQL) → backlog TD-ERC8004-01 (ver §8).

**DT-9 — Backward-compat (NC-3).** `erc8004_identity = null` válido y permanente.
Sin migration job. Opt-in. Todas las rutas existentes intactas (AC-9 / CD-9).

**DT-10 — El reader NO entra al `AdaptersBundle`.** Justificación: el bundle es
per-`ChainKey` (kite/avalanche/base × testnet/mainnet) y se construye solo si la
chain está en `WASIAI_A2A_CHAINS`. La identidad ERC-8004 es siempre Base y debe
estar disponible aunque Base no esté en el set de chains de pago. Por eso el
reader es un módulo singleton env-driven (como el deposit-verifier, que tampoco
es un método del bundle). Consecuencia: `src/adapters/base/identity.ts`,
`base/index.ts:35` (`identity:null`) y `registry.ts` quedan **sin cambios**.
**Desviación del Scope IN** (work-item lista "Activar baseIdentity"): se documenta
y es técnicamente superior (no acopla identidad a la config de pago). El
orquestador la valida en SPEC_APPROVED.

**DT-11 — Interfaz nueva `Erc8004IdentityReader`, NO mutar `IdentityBindingAdapter`.**
La firma existente (`bind(keyId, chainAddress, sig)` + `verify(keyId)`) modela un
flujo write/sig que NC-1/NC-2 descartan. Mutarla rompería su contrato y obligaría
a tocar los bundles. Se crea `Erc8004IdentityReader` (en `erc8004-identity.ts`),
dejando `IdentityBindingAdapter` y `AdaptersBundle.identity` intactos. **Desviación
del Scope IN** ("ajustar IdentityBindingAdapter"): justificada por NC-1/NC-2.

**DT-12 — AC-8 end-to-end REAL: puente identidad-unificada por referencia
explícita + reverse-lookup verificado (humano resolvió → in-scope).**

*Modelo real (grounded, archivo:línea):* el `Agent` de discovery se construye en
`discovery.ts:298-331` (`mapAgent`) desde la respuesta HTTP de un registry externo;
`metadata: raw` (l.328) es el payload upstream; NO tiene `owner_ref` ni
`erc8004_identity` (`src/types/index.ts:118-135`). `discover()` devuelve `Agent[]`
crudo (l.210-214) — **no pasa por `buildAgentCard`**. El único id estable
cross-source es `(registry, slug)` (l.301).

*Opciones evaluadas:*
- (a) `owner_ref` compartido → el Agent no tiene `owner_ref`; derivarlo del registry
  = confiar en fuente spoofable (viola CD-7). **Descartado.**
- (b) `allowed_agent_slugs` → semántica de caller-scoping, no de identidad propia;
  N keys pueden listar el mismo slug. **Descartado.**
- (c) **referencia explícita owner-declarada `agent_slug` en el JSONB
  `erc8004_identity` + reverse-lookup `resolveIdentityForSlug` (ELEGIDO).**

*Por qué (c):* (1) source of truth = la key row, literal a AC-8; (2) sin columna
nueva ni migration (vive en el JSONB existente → AC-9/CD-9); (3) no confía en el
registry (CD-7); (4) `verified:true` honesto = el `ownerOf` ya se verificó al
bindear (CD-10); (5) sin RPC al servir discovery (CD-8 read-only); (6) opt-in
explícito del owner (no inferencia frágil); (7) desacoplado del budget (CD-2 —
el SELECT solo trae `erc8004_identity`). Implementación en §1.4, W5/W7.

**DT-18 — Enrich de `/discover` en el service, batch, post-limit.** `discover()`
(`discovery.ts:113-215`) devuelve `Agent[]` crudo. El surfacing de AC-8 vía
`/discover` se hace inyectando `Agent.identity?` dentro de `discover()` y
`getAgent()`, sobre la página ya limitada (`limited`, l.208) para minimizar
queries. Lecturas en `Promise.all`; falla de DB de una query → ese agente queda
sin `identity` (degradación graciosa, no rompe discovery — patrón consistente con
el `.catch(() => [])` por-registry de l.131-147). Sin RPC. Sin tocar filtros/sort.

**DT-19 — El reverse-lookup `resolveIdentityForSlug` NO lleva Ownership Guard (y
por qué NO es un IDOR).** La regla de CLAUDE.md exige `.eq('owner_ref', ownerId)`
en queries sobre `a2a_agent_keys` desde `src/services/`. Esa regla protege
*mutaciones y lecturas de datos privados* (budget, etc.) accesibles por `keyId` del
caller. `resolveIdentityForSlug` es distinto: (1) es una lectura PÚBLICA por
`agent_slug` (no por `keyId` del caller), (2) devuelve SOLO
`{ token_id, chain_id, verified }` — datos públicamente verificables on-chain por
cualquiera (`ownerOf`/`tokenURI` son lecturas públicas), (3) `.select('erc8004_identity')`
NUNCA trae `budget`/`funding_wallet`/PII. No hay objeto privado al que se acceda
sin autorización → **no es IDOR**. Documentado aquí + §7 para que AR/CR no lo marque
falso-positivo. La función `bindErc8004Identity` (mutación) SÍ lleva Guard completo
(CD-3, intacto).

**DT-20 — `agent_slug` es opt-in.** El bind sin `agent_slug` produce un binding
válido (AC-1/AC-4 intactos) que simplemente NO surfacea en discovery. El owner
decide exponer la AgentID en discovery declarando el slug que su Agent Key
representa. Esto evita surfacing accidental y mantiene el control en el owner.

**DT-13 — Label de `logOwnershipMismatch`.** El union `OwnershipOp`
(errors.ts:81-85) no incluye `'bindErc8004Identity'`. Para no expandir scope a
`errors.ts` con una firma nueva, se reusa `'deactivate'` (igual que
`bindFundingWallet` hoy, identity.ts:133). Cosmético; backlog TD-ERC8004-02 (igual
que el backlog MNR-2 de WKH-35).

**DT-14 — Validación `token_id` (uint256).** Regex `^[0-9]+$` sobre el string (o
`number` finito no-negativo entero → `String()`). Se convierte a `BigInt(token_id)`
para `readContract`; si `BigInt()` lanza o el valor excede `2^256-1` → 400
`INVALID_INPUT`. Se almacena como string decimal (DT-4). Sin pérdida de precisión
(lección WKH-35: nunca `Number()` para valores on-chain). El `token_id` SIEMPRE
sale del body/params, NUNCA se infiere.

**DT-15 — `tokenURI` no resoluble en bind.** Si `reader.resolve` falla durante el
bind (RPC parcial, token sin URI), el bind procede con `agent_card_url: ''` porque
la prueba de posesión (ownerOf) ya pasó. El binding es válido aunque el AgentCard
URL no esté disponible. El owner puede re-bindear luego (idempotente). NO se aborta
el bind por un tokenURI faltante.

**DT-16 — `resolve`: scheme handling sin fetch (anti-SSRF).** `tokenURI` puede ser
`https://`, `ipfs://`, `data:` o arbitrario. Fase 1 NO hace fetch server-side del
URL (riesgo SSRF — el URL lo controla el minter, atacante potencial). Se devuelve
la URI cruda + su scheme; el caller resuelve el contenido. AC-2 ("AgentCard JSON or
{ url, raw }") se cumple devolviendo `{ agent_card_url, url, raw:null }` para
`http(s)` y `{ agent_card_url, scheme }` para el resto.

**DT-17 — `identity_verified` derivado sin RPC (AC-6).** Helper puro
`isIdentityVerified(row)` + campo transient `erc8004_verified?: boolean` seteado
en el row in-memory tras la resolución del middleware/`resolveCallerKey`. NO
columna DB, NO RPC por request. Derivado de `erc8004_identity != null`.

---

## 4. Constraint Directives — coverage

| CD (work-item) | Cómo lo garantiza el SDD | Verificación AR/CR |
|---|---|---|
| **CD-1** Registry canónico, address por env | `resolveRegistryAddress(network)` env-only; `REGISTRY_NOT_CONFIGURED` si ausente | grep: no hex `0x8004...` literal en `src/` |
| **CD-2** Identidad desacoplada del budget | Service y handlers NO importan `budgetService`; sin `increment_a2a_key_spend`/`register_a2a_key_deposit`. `resolveIdentityForSlug` hace `.select('erc8004_identity')` — NUNCA `budget` | grep en bind handler + service + resolver |
| **CD-3** Ownership Guard | `bindErc8004Identity` UPDATE `.eq('id').eq('owner_ref')`; `data.length===0`→`OwnershipMismatchError` | leer identity.ts diff |
| **CD-4** Sin hardcodes | address/rpc/chainId/timeout todo por env | grep literales |
| **CD-5** viem only | `createPublicClient`/`readContract` viem v2; cero `ethers` | grep `ethers` |
| **CD-6** TS strict sin `any` | ABI `as const`; results tipados; `BigInt` no `any` | `tsc -p tsconfig.build.json` |
| **CD-7** Sin backend propietario de identidad | Solo on-chain reads; sin servicios externos. El `verified:true` de discovery viene del binding `ownerOf`-verificado local, NUNCA del payload del registry externo (anti-spoof, DT-12/§7) | review imports + test enrich |
| **CD-8** Server NUNCA mintea/firma | Sin `WalletClient`/`writeContract`/`privateKeyToAccount` en `erc8004-identity.ts` | grep en el adapter |
| **CD-9** Backward-compat, opt-in, sin migration job | Sin script bulk; `null` válido; rutas existentes intactas | test AC-9 |

### CDs nuevos detectados por el Architect

- **CD-10 — Posesión por owner real, no solo existencia del token.** OBLIGATORIO
  comparar `ownerOf == funding_wallet`; PROHIBIDO bindear con solo `tokenURI`
  resoluble. (Paralelo a WKH-35 FIX-1: probar quién posee, no solo que existe.)
- **CD-11 — Comparaciones de valores on-chain sin pérdida.** PROHIBIDO `Number()`
  sobre `token_id`/addresses; usar `BigInt`/string + comparación lowercase.
  *Referencia: WKH-35 auto-blindaje FIX-3.*
- **CD-12 — Lint/format scoped.** PROHIBIDO `npm run format` global (toca archivos
  fuera de scope). OBLIGATORIO `biome check --write <archivo-in-scope>` por archivo.
  *Referencia: WKH-AUDIT (097) auto-blindaje.*
- **CD-13 — Anti-SSRF en resolve.** PROHIBIDO `fetch`/HTTP request server-side al
  `tokenURI` en Fase 1. Devolver la URI cruda; el caller resuelve. (DT-16.)
- **CD-14 — Distinguir revert de transporte.** `ownerOf` de token inexistente
  revierte (esperado, `TOKEN_NOT_FOUND`); fallo de RPC es `RPC_UNAVAILABLE`. NO
  colapsar ambos en un genérico — afecta status code (404 vs 503).

---

## 5. Exemplars verificados (Glob/Read confirmados)

| Path | Existe | Uso como patrón |
|---|---|---|
| `src/adapters/deposit-verifier.ts` | ✅ (310 l.) | lazy clients + reasons tipados + RPC handling |
| `src/adapters/kite-ozone/gasless.ts:217-230` | ✅ | `readContract` + ABI `as const` literal |
| `src/adapters/base/chain.ts:27-47` | ✅ | `getBaseNetwork`/`getBaseChain` |
| `src/services/identity.ts:110-138` | ✅ | Ownership Guard UPDATE |
| `src/routes/auth.ts:140-211` | ✅ | ruta autenticada + validación + error_code |
| `src/services/security/errors.ts:9-74` | ✅ | error class pattern |
| `src/services/agent-card.ts:86-147` | ✅ | spread condicional no-breaking |
| `src/services/discovery.ts:113-215,298-331` | ✅ | `discover()` crudo + `mapAgent` (sin owner_ref); punto de enrich AC-8 (DT-18) |
| `src/routes/discover.ts:21-135` | ✅ | endpoints `/discover` GET/POST/:slug |
| `src/routes/agent-card.ts:19-69` | ✅ | inyección de `identity` antes de `buildAgentCard` |
| `src/services/identity.ts:26-58,60-77` | ✅ | patrón query/insert sobre `a2a_agent_keys` (reverse-lookup) |
| `src/services/agent-card.test.ts:39-60` | ✅ | harness Agent/RegistryConfig sintético |
| `src/adapters/deposit-verifier.test.ts` | ✅ | mock viem (publicClient) en tests |

ABI/funciones inventadas: ninguna. `ownerOf`/`tokenURI` son ERC-721 estándar
(verificación física obligatoria en F3 — DT-3 [VERIFY-AT-IMPL]).

---

## 6. Test Plan (≥1 test por AC — 12 ACs)

Mock: `publicClient` (viem `readContract`/`getChainId`) y `supabase` (mismo estilo
que `deposit-verifier.test.ts`). NO red real (CI determinista).

| AC | Test | Archivo | Mock / caso |
|---|---|---|---|
| AC-1 | bind OK → 200, escribe `erc8004_identity` con shape exacto | `auth.erc8004.test.ts` | `ownerOf`→funding_wallet; supabase update→1 row |
| AC-2 | resolve → `tokenURI` https → `{ url, raw:null }`; ipfs → `{ scheme }` | `auth.erc8004.test.ts` + `erc8004-identity.test.ts` | `tokenURI`→ varias URIs |
| AC-3 | `funding_wallet` null → 400 `FUNDING_WALLET_NOT_BOUND`, **sin RPC** | `auth.erc8004.test.ts` | spy: reader NO invocado |
| AC-4 | `ownerOf != funding_wallet` → 403 `IDENTITY_OWNERSHIP_MISMATCH`, sin write | `auth.erc8004.test.ts` | `ownerOf`→otra address; supabase update NO llamado |
| AC-5 | mismo `token_id`+`chain_id` ya bound → 409 `ERC8004_ALREADY_BOUND`, sin RPC ni overwrite | `auth.erc8004.test.ts` | row con identity existente |
| AC-6 | row con `erc8004_identity != null` → `isIdentityVerified` true / `erc8004_verified` true; null → false | `erc8004-identity.test.ts` (helper) | row sintético |
| AC-7 | `/me` devuelve `bindings.erc8004_identity` con `verified_at` | `auth.erc8004.test.ts` | row con binding |
| AC-8 (unit card) | `buildAgentCard(agent, cfg, url, identity)` → emite `identity:{...}`; sin arg → sin campo | `agent-card.test.ts` | identity sintética con/sin |
| AC-8 (unit resolver) | `resolveIdentityForSlug(slug)` → row con `erc8004_identity.agent_slug===slug` & `is_active` → `{erc8004_token_id,chain_id,verified:true}`; sin match / inactive / sin `agent_slug` → null; **assert SELECT solo trae `erc8004_identity` (no budget)** | `discovery.test.ts` o `identity.test.ts` | supabase mock |
| AC-8 (unit discover enrich) | `discover()`/`getAgent()` setean `Agent.identity` cuando hay match; sin match → campo ausente; falla DB en un lookup → ese agent sin identity, discover NO rompe | `discovery.test.ts` | mock fetch + supabase |
| **AC-8 (integración e2e)** | bind con `agent_slug` → `identity:{erc8004_token_id,chain_id,verified:true}` aparece en `GET /agents/:slug/agent-card` **y** en el `Agent` de `GET`+`POST /discover`. Agente sin key-identity → sin campo (AC-9) | `erc8004-identity-bridge.e2e.test.ts` | mock RPC (ownerOf=funding_wallet) + supabase row real-shape + registry mock |
| AC-9 | key con `erc8004_identity=null` autentica + debita igual; sin degradación | `auth.erc8004.test.ts` / reuso suite middleware | row sin identity |
| AC-10 | sin env `ERC8004_REGISTRY_ADDRESS*` → `REGISTRY_NOT_CONFIGURED` (no hardcode) | `erc8004-identity.test.ts` | unset env → reason |
| AC-11 | RPC down (transport throw) en bind y resolve → 503 `RPC_UNAVAILABLE`, sin throw, sin budget | `auth.erc8004.test.ts` + adapter test | `readContract` rejects |
| AC-12 | bind NO llama `budgetService`/`increment_a2a_key_spend`/`register_a2a_key_deposit` | `auth.erc8004.test.ts` | spies sobre budgetService → 0 calls |

Casos de error adicionales (QUALITY, "cubra todo"):
- `token_id` no numérico / negativo / vacío / > uint256 max → 400 `INVALID_INPUT` (DT-14).
- `ownerOf` revert (token inexistente) → 404 `ERC8004_TOKEN_NOT_FOUND` (no 503).
- `getChainId()` != red esperada → 502 `ERC8004_CHAIN_MISMATCH`.
- `tokenURI` falla al bindear pero `ownerOf` OK → bind con `agent_card_url:''` (DT-15).
- Ownership Guard: UPDATE 0 rows → 403 `OWNERSHIP_MISMATCH` (CD-3).
- Address case-insensitive: `ownerOf` checksummed vs `funding_wallet` lowercase → match (DT-5).
- `_resetErc8004Reader()` limpia cache entre tests.

---

## 7. Seguridad

- **Ownership Guard (CD-3):** todo UPDATE `.eq('id').eq('owner_ref')`; 0 rows →
  `OwnershipMismatchError` + log PII-safe. `keyId`/`ownerRef` SIEMPRE del caller
  autenticado, NUNCA del body (igual que `funding-wallet`/`deposit`).
- **Read-only (CD-8):** sin `WalletClient`, sin `writeContract`, sin
  `OPERATOR_PRIVATE_KEY`, sin gas. Imposible drenar.
- **Sin leak de secrets:** el adapter solo serializa addresses/URIs públicas. NUNCA
  RPC URL con API key embebida ni private keys en respuestas (igual que
  `/deposit-info` que solo expone treasury address).
- **Validación estricta `token_id` (DT-14):** uint256 numérico; rechazo temprano.
- **Anti-SSRF (CD-13):** sin fetch del `tokenURI`.
- **Anti-abuse:** reusa el rate-limit global del server; `/bind` requiere auth;
  `/resolve` público pero solo lectura on-chain idempotente.
- **Posesión real (CD-10):** `ownerOf == funding_wallet`, no solo existencia.
- **Reverse-lookup de discovery NO es IDOR (DT-19):** `resolveIdentityForSlug`
  lee por `agent_slug` (público), devuelve SOLO `{token_id, chain_id, verified}`
  (datos públicamente verificables on-chain), `.select('erc8004_identity')` NUNCA
  trae budget/funding_wallet/PII. Sin `keyId` del caller, sin dato privado →
  NO aplica la regla de Ownership Guard de CLAUDE.md (esa protege mutaciones y
  lecturas privadas por `keyId`). La mutación `bindErc8004Identity` SÍ lleva Guard
  completo (CD-3). **Nota para AR/CR:** no marcar el SELECT sin `.eq('owner_ref')`
  como falso-positivo; ver DT-19.
- **Anti-spoof de identidad en discovery (CD-7):** el `verified:true` NUNCA viene
  del payload del registry externo (spoofable); proviene SOLO del binding
  `ownerOf`-verificado en la key row local. El registry no puede inyectar identidad.

---

## 8. Deuda técnica registrada

- **TD-ERC8004-01** — Idempotencia bind sin protección de concurrencia (DT-8). Dos
  binds concurrentes del mismo owner podrían pasar el check-then-update. Hardening:
  constraint SQL o `WHERE erc8004_identity IS NULL` en el UPDATE. Bajo riesgo (mismo
  owner/token, overwrite idempotente).
- **TD-ERC8004-02** — Label `logOwnershipMismatch('deactivate', ...)` en
  `bindErc8004Identity` (DT-13). Cosmético; agregar `'bindErc8004Identity'` al union
  `OwnershipOp`. Igual que el backlog MNR-2 de WKH-35.
- **TD-ERC8004-03 — Índice funcional para el reverse-lookup.** `resolveIdentityForSlug`
  filtra por `erc8004_identity->>'agent_slug'`. Para escala se sugiere
  `CREATE INDEX ON a2a_agent_keys ((erc8004_identity->>'agent_slug')) WHERE is_active`.
  NO bloqueante en Fase 1 (volumen bajo, query sobre página limitada — DT-18). El
  índice NO es una migration de datos (AC-9/CD-9 intactos: solo acelera lecturas).
- **AC-8 propagación — RESUELTA en Fase 1 (ya NO es deuda).** El puente
  key-row → discovery se implementa end-to-end vía `agent_slug` opt-in en el JSONB
  + `resolveIdentityForSlug` + enrich de `discover()`/`buildAgentCard` (DT-12/DT-18).
  Cubierto por test e2e (W7). Backward-compat preservado (DT-20/AC-9).

---

## 9. Readiness Check (F2)

| Ítem | Estado |
|---|---|
| Todos los exemplars verificados con Read/Glob (paths reales) | ✅ |
| ABI: solo funciones ERC-721 estándar (`ownerOf`/`tokenURI`), sin inventar | ✅ (verificación física en F3 — DT-3 [VERIFY-AT-IMPL]) |
| Shape JSONB definido exacto (DT-4) | ✅ |
| Taxonomía de error_code completa | ✅ (`FUNDING_WALLET_NOT_BOUND`, `IDENTITY_OWNERSHIP_MISMATCH`, `ERC8004_ALREADY_BOUND`, `ERC8004_TOKEN_NOT_FOUND`, `ERC8004_CHAIN_MISMATCH`, `INVALID_INPUT`, `RPC_UNAVAILABLE`, `REGISTRY_NOT_CONFIGURED`, `OWNERSHIP_MISMATCH`) |
| Idempotencia AC-5 resuelta (DT-8) | ✅ |
| Lazy `identity_verified` AC-6 resuelto (DT-17, sin RPC) | ✅ |
| `tokenURI` ipfs vs https resuelto (DT-16, anti-SSRF) | ✅ |
| Normalización case-insensitive addresses (DT-5) | ✅ |
| **AC-8 end-to-end REAL** — puente key-row→discovery diseñado y grounded (DT-12 reescrito) | ✅ (mecanismo: `agent_slug` opt-in en JSONB + `resolveIdentityForSlug` + enrich `discover()`/`buildAgentCard`) |
| **AC-8 vía `/discover`** — gap detectado (`discover()` no usa `buildAgentCard`) y resuelto (DT-18, `Agent.identity?`) | ✅ |
| **Reverse-lookup NO es IDOR** — justificado vs regla CLAUDE.md (DT-19, nota para AR/CR) | ✅ |
| **Test integración e2e AC-8** (bind→discover→agent-card) añadido (W7) | ✅ |
| 9 CDs del work-item mapeados + 5 nuevos (CD-10..CD-14) | ✅ |
| ≥1 test por AC (12) + sub-tests AC-8 (card/resolver/enrich/e2e) + casos de error | ✅ |
| Ownership Guard + read-only + sin leak + validación token_id | ✅ |
| Waves ordenadas, W0 primero | ✅ |
| Auto-Blindaje histórico aplicado (WKH-35, WKH-AUDIT) | ✅ → CD-11, CD-12 |
| `[NEEDS CLARIFICATION]` sin resolver | NINGUNO |

**Desviaciones del Scope IN literal que el orquestador debe validar en SPEC_APPROVED:**
1. **DT-10** — el reader NO entra al `AdaptersBundle`; `base/identity.ts`,
   `base/index.ts`, `registry.ts`, `types.ts` quedan sin cambios. (Técnicamente
   superior: identidad no se acopla a la config de chains de pago.)
2. **DT-11** — NO se muta `IdentityBindingAdapter`; se crea `Erc8004IdentityReader`.
   (NC-1/NC-2 hacen incompatible la firma write/sig actual.)
3. **DT-12 (reescrito) / DT-18 / DT-19 / DT-20** — AC-8 implementado **end-to-end
   REAL**: puente key-row → discovery vía `agent_slug` opt-in dentro del JSONB
   `erc8004_identity` + `resolveIdentityForSlug` (reverse-lookup) + enrich de
   `discover()`/`getAgent()`/`buildAgentCard`. **Sin columna nueva ni migration**
   (vive en el JSONB existente → AC-9/CD-9). **Sin confiar en el registry** (CD-7).
   El reverse-lookup NO lleva Ownership Guard a propósito (DT-19: lectura pública
   de dato on-chain-verificable, no IDOR — nota explícita para AR/CR).

**Readiness: PASS** — DT-12 ya NO es deuda: AC-8 es end-to-end real con su test de
integración (W7). Persisten 2 desviaciones de scope-de-implementación documentadas
(DT-10 reader fuera del bundle, DT-11 interfaz nueva en vez de mutar
`IdentityBindingAdapter`) — no cambian el QUÉ ni los ACs. Sin clarifications
pendientes. Listo para clinical review SPEC_APPROVED.
