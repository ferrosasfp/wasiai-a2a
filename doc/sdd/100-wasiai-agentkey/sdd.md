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

## 3.bis ADDENDUM POST-AR — DT-21 (cierra BLQ-MED-1: identity-badge spoofing)

> Origen: Adversarial Review marcó **BLQ-MED-1 (BLOQUEANTE)**. Este addendum
> reescribe el mecanismo del puente identidad→discovery. **Reemplaza** la
> resolución por `agent_slug` caller-aseverado descrita en §1.4 / DT-12 / DT-18
> (parcialmente) por una resolución **por `token_id` declarado on-chain por el
> propio agente** (vínculo bidireccional trustless). DT-12/DT-18/DT-19/DT-20
> quedan **supersedidos** en todo lo que contradiga DT-21.

### DT-21.0 — El bug exacto (grounded, archivo:línea)

- `src/routes/auth.ts:463-474` (`POST /erc8004/bind`): `agent_slug` se toma del
  **body del caller**, validado solo por `SLUG_RE` (forma). **NUNCA** se prueba
  que el caller controle ese slug.
- `src/routes/auth.ts:545`: el binding persiste `agent_slug` tal cual.
- `src/services/identity.ts:206-229` (`resolveIdentityForSlug`): empareja por
  `b.agent_slug === slug` (l.221). El `verified:true` (l.224) sale de un dato
  **aseverado por el caller**, no de un vínculo verificable.
- `src/services/discovery.ts:228-240` (`attachIdentities`) +
  `:398-402` (`getAgent`): para cada agente del registry hacen
  `resolveIdentityForSlug(agent.slug)`. El `agent.slug` viene del payload del
  registry externo (`mapAgent`, `discovery.ts:326`).

**Ataque:** el atacante bindea SU token (`ownerOf == su funding_wallet` ✓) pero
declara `agent_slug` de OTRO agente (slug público, enumerable vía `/discover`).
`resolveIdentityForSlug('acme')` encuentra la key del atacante (su binding tiene
`agent_slug:'acme'`) → `/discover` y el agent-card de **Acme** surfacean
`identity:{verified:true}` con el **token del atacante**. Además, sin unicidad de
slug, varias keys pueden reclamar el mismo slug (poisoning). **Rompe AC-8.**

### DT-21.1 — Causa raíz y principio del fix

El `verified:true` nacía de un **string aseverado unilateralmente por el caller**.
La confianza debe nacer de un **vínculo bidireccional**:
- **Lado del agente (declaración on-chain):** el AgentCard que el agente publica
  en su registry —y que `/discover` lee crudo en `agent.metadata`
  (`discovery.ts:353`)— **declara su propia identidad ERC-8004 (token_id en
  Base)**. Esa declaración la controla el agente, NO el caller del bind.
- **Lado nuestro (verificación local):** surfaceamos `verified:true` SOLO cuando
  ESE token declarado por el agente está **bindeado + `ownerOf`-verificado** en
  nuestra DB (el verify ya ocurrió en el bind, `auth.ts:497-532`).

Resolución **por `token_id`**, no por slug aseverado. Un atacante no puede hacer
que el AgentCard de Acme declare el token del atacante → spoofing cerrado de raíz.

### DT-21.2 — Campo de declaración on-chain en el AgentCard del agente — convención + DEFAULT SEGURO

[VERIFY-AT-IMPL — NO bloqueante] El estándar A2A + ERC-8004 ("Trustless Agents")
define en el AgentCard un campo **`registrations`**: array de
`{ agentId, agentRegistry, signature? }`, donde `agentId` referencia la identidad
on-chain (estilo CAIP-10 / `eip155:<chainId>:<registry>/<tokenId>`). **El
codebase HOY no tiene NINGUNA referencia a `registrations`/`trustModels`/CAIP-10**
(grep: 0 ocurrencias en `src/`), y **no puedo confirmar con certeza** que los
registries que consumimos pueblen ese campo. Por la regla anti-alucinación:

**NO invento el estándar. Defino el campo que esperamos + comportamiento seguro
por defecto.** Un helper `extractDeclaredTokenId(agent): { tokenId, chainId } |
null` lee, en orden de preferencia, desde `agent.metadata` (= payload crudo del
registry, `discovery.ts:353`):

1. **`metadata.registrations`** (estándar A2A/ERC-8004): array; por cada entry,
   parsear `agentId` CAIP-10-like `eip155:<chainId>:<registry>/<tokenId>` (o el
   par `{ chainId/chain_id, tokenId/token_id }` si el registry lo expone
   desestructurado). Tomar la PRIMERA cuyo `chainId ∈ {8453, 84532}` y coincida
   con `getBaseNetwork()`.
2. **Fallback explícito** (compat con registries no-estándar): `metadata.erc8004`
   = `{ token_id, chain_id }`, o top-level `metadata.erc8004_token_id` +
   `metadata.erc8004_chain_id`.
3. **DEFAULT SEGURO:** si nada de lo anterior produce un `{ tokenId, chainId }`
   válido y parseable → **`null` → SIN badge** (la página de discover NO surfacea
   `identity` para ese agente). **Sin vínculo verificable, sin verified.**

El helper NO hace fetch ni RPC (CD-13 / CD-8): solo lee el objeto `metadata` ya
presente en memoria. `token_id` se maneja como **string decimal** (CD-11, sin
`Number()`); el parser CAIP-10 valida `^[0-9]+$` sobre el segmento de tokenId.

> Nota de seguridad: que el agente *declare* un token NO le otorga el badge. El
> badge solo aparece si ESE token está bindeado+verificado en NUESTRA DB. La
> declaración del registry es spoofable (CD-7), pero por sí sola es inerte: sin el
> bind `ownerOf`-verificado local, no hay `verified:true`. El cruce de ambos lados
> (declaración del agente ∧ bind verificado local del **mismo token**) es lo que
> hace el vínculo trustless.

### DT-21.3 — `resolveIdentityForSlug` → `resolveIdentityForToken` (reverse-lookup por token_id)

`resolveIdentityForSlug` (identity.ts:206-229) se **reemplaza** por
`resolveIdentityForToken(tokenId: string, chainId: number)`:

```ts
// Reverse-lookup PÚBLICO por token_id (dato verificable on-chain por cualquiera).
// NO Ownership Guard (DT-19 sigue aplicando: no es IDOR — no hay keyId del caller,
// solo se expone {token_id, chain_id, verified}, NUNCA budget/funding_wallet/PII).
// Igualdad indexable por token_id (cierra MNR-1: no full-table scan por agente).
async resolveIdentityForToken(
  tokenId: string,
  chainId: number,
): Promise<AgentCardIdentity | null> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('erc8004_identity')          // SOLO esta columna (CD-2/DT-19)
    .eq('is_active', true)
    .not('erc8004_identity', 'is', null);
  if (error || !data) return null;
  for (const row of data as Array<{ erc8004_identity: Erc8004IdentityBinding | null }>) {
    const b = row.erc8004_identity;
    if (!b) continue;
    // Cruce por token_id + chain_id (NO por agent_slug aseverado). El binding fue
    // ownerOf-verificado al bindear (auth.ts:497-532) → verified:true honesto.
    if (b.token_id === tokenId && b.chain_id === chainId) {
      return { erc8004_token_id: b.token_id, chain_id: b.chain_id, verified: true };
    }
  }
  return null;
}
```

- **[VERIFY-AT-IMPL] filtro JSONB indexable:** el Dev DEBE intentar primero el
  filtro server-side por igualdad `('erc8004_identity->>token_id', tokenId)` +
  `('erc8004_identity->>chain_id', String(chainId))` para que sea **una query por
  igualdad indexable** (MNR-1). Fallback determinista: traer candidatas activas
  con identity no-null y filtrar en JS por `token_id`+`chain_id` (la defensa de
  shape ya cubre el match). Igual que el fallback documentado en §1.4.1.
- **MNR-1 (perf) — RESUELTA:** la igualdad por `token_id` es indexable
  (TD-ERC8004-03 cambia el índice funcional sugerido a
  `((erc8004_identity->>'token_id'))`). En `attachIdentities` (batch de discover),
  se resuelve sobre los tokens **declarados** de la página limitada: agentes sin
  declaración válida (`extractDeclaredTokenId === null`) NO generan query (skip)
  → menos round-trips que el esquema viejo (que consultaba por cada slug).

### DT-21.4 — `discovery.ts`: usar el token declarado, NO el slug

- `attachIdentities(agents)` (discovery.ts:228-240): por cada agente,
  `const decl = extractDeclaredTokenId(a)`; si `decl === null` → **skip (sin
  badge)**; si no, `resolveIdentityForToken(decl.tokenId, decl.chainId)` y setear
  `a.identity` solo si hay match. Mantiene `Promise.all` + degradación graciosa
  (falla DB → ese agente sin identity, no rompe discover).
- `getAgent(slug)` (discovery.ts:398-402): idéntico — usa
  `extractDeclaredTokenId(agent)`, no `agent.slug`.
- `extractDeclaredTokenId` vive en `discovery.ts` (helper local, junto a
  `readPayment`/`mapAgent`) o en un util compartido; lee solo `agent.metadata`.

### DT-21.5 — `agent-card.ts` / route: idem por token declarado

`buildAgentCard` mantiene su firma (recibe `identity?` ya resuelto). El route
`src/routes/agent-card.ts` resuelve `extractDeclaredTokenId(agent)` →
`resolveIdentityForToken(...)` antes de `buildAgentCard` (en vez de
`resolveIdentityForSlug(agent.slug)`).

### DT-21.6 — Unicidad token_id ↔ una sola key activa (defensa en profundidad)

PROHIBIDO que dos keys activas distintas reclamen el mismo `token_id`+`chain_id`
(evita ambigüedad de cuál surfacea + poisoning residual). En
`bindErc8004Identity` (o como pre-check en el handler, antes del UPDATE):

- **Pre-check app-layer (obligatorio Fase 1):** antes de persistir, consultar si
  existe OTRA key activa (`id != keyId`) con `erc8004_identity.token_id == tokenId
  && chain_id == chainId`. Si existe → lanzar `Erc8004TokenAlreadyBoundError` →
  handler responde **409 `ERC8004_TOKEN_ALREADY_BOUND`** (sin write). El re-bind
  del MISMO owner sobre su MISMA key (idempotencia AC-5) NO colisiona (mismo `id`).
- **Hardening real (backlog TD-ERC8004-01 ampliado):** índice parcial UNIQUE
  `((erc8004_identity->>'token_id'), (erc8004_identity->>'chain_id')) WHERE
  is_active` — si el Dev lo agrega, el código DEBE mapear el error `23505` a
  `Erc8004TokenAlreadyBoundError` (igual que `bindFundingWallet` mapea `23505`,
  identity.ts:142). El pre-check app-layer queda igual (defensa en profundidad).

### DT-21.7 — `agent_slug` deja de ser fuente de trust

DT-20 (opt-in por `agent_slug`) queda **supersedido**. El `verified` ya NO depende
de `agent_slug`. Decisión: **mantener `agent_slug?` en el shape JSONB como hint
sin efecto en `verified`** (backward-compat con bindings ya escritos; el Dev NO
debe migrar datos — AC-9/CD-9). El handler de bind PUEDE seguir aceptándolo y
persistiéndolo, pero `resolveIdentityForToken` lo IGNORA por completo. Se documenta
en el shape que `agent_slug` es un hint informativo no usado para el badge.
`resolveIdentityForSlug` se elimina (o queda como deprecated sin uso) — el Dev DEBE
actualizar todos los callers + mocks (auto-blindaje: grep `resolveIdentityForSlug`
en tests antes de eliminar el export, igual que la lección de Wave 4).

### DT-21.8 — CDs preservados (verificación AR/CR)

| CD | Cómo lo preserva DT-21 |
|---|---|
| **CD-13** anti-SSRF | `extractDeclaredTokenId` lee `metadata` en memoria; NO fetch del tokenURI ni de URLs del registry en serve-time |
| **CD-2** sin budget | `resolveIdentityForToken` hace `.select('erc8004_identity')` only; pre-check de unicidad también |
| **CD-8** read-only | sin RPC al servir discovery; sin write en el resolve |
| **CD-3** Ownership Guard | `bindErc8004Identity` mantiene `.eq('id').eq('owner_ref')` intacto; el pre-check de unicidad es lectura adicional, no relaja el Guard de la mutación |
| **CD-7** sin trust del registry | la declaración del registry es inerte sin el bind verificado local del MISMO token; el `verified` nace del `ownerOf` local, NUNCA del payload externo |
| **AC-9 / CD-9** backward-compat | sin migration; agente sin declaración válida O sin token bindeado → `identity` ausente (no `null`) |

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
| AC-8 (unit resolver — DT-21) | `resolveIdentityForToken(tokenId, chainId)` → row activo con binding `token_id===tokenId && chain_id===chainId` → `{erc8004_token_id,chain_id,verified:true}`; sin match / inactive / chainId distinto → null; **assert SELECT solo trae `erc8004_identity` (no budget)** | `discovery.test.ts` o `identity.test.ts` | supabase mock |
| AC-8 (unit extractDeclaredTokenId — DT-21) | `metadata.registrations` CAIP-10 válido → `{tokenId, chainId}`; fallback `metadata.erc8004`; metadata vacío / token no numérico / chainId fuera de {8453,84532} → `null` (default seguro, sin badge) | `discovery.test.ts` | Agent sintético con varios `metadata` |
| AC-8 (unit discover enrich — DT-21) | `discover()`/`getAgent()` setean `Agent.identity` SOLO cuando el token **declarado** por el agente está bindeado+verificado; sin declaración válida → skip (sin query, sin badge); falla DB → ese agent sin identity, discover NO rompe | `discovery.test.ts` | mock fetch + supabase |
| **AC-8 (integración e2e — DT-21)** | agente cuyo card declara token T (en `metadata.registrations`) + T bindeado+verificado → `identity:{erc8004_token_id:T,chain_id,verified:true}` en `GET /agents/:slug/agent-card` **y** en `GET`+`POST /discover`. Agente sin declaración / sin bind → sin campo (AC-9) | `erc8004-identity-bridge.e2e.test.ts` | mock RPC (ownerOf=funding_wallet) + supabase row real-shape + registry mock con `metadata.registrations` |
| **SEC anti-spoof BLQ-MED-1 (DT-21)** | atacante bindea token T (ownerOf==su wallet ✓); el AgentCard de la víctima declara token V≠T → `/discover` + agent-card de la víctima **NO** surfacean badge. Solo el agente cuyo card declara T (el del atacante) lo surfacea. **El ataque ya NO funciona.** | `auth.erc8004.test.ts` o e2e | dos bindings + dos cards con tokens declarados distintos |
| **SEC unicidad token (DT-21.6)** | bind de token T a key A (ok); 2º bind de MISMO T+chainId a key B distinta activa → **409 `ERC8004_TOKEN_ALREADY_BOUND`**, sin write. Re-bind de A sobre su misma key (idempotencia AC-5) NO colisiona | `auth.erc8004.test.ts` | row de otra key activa con T |
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
- **Anti-spoof de identidad en discovery (CD-7 — REFORZADO por DT-21):** el
  `verified:true` NUNCA viene del payload del registry externo (spoofable); proviene
  SOLO del binding `ownerOf`-verificado en la key row local. **Vínculo bidireccional
  (DT-21):** la resolución es por `token_id` **declarado on-chain por el propio
  agente** (en su AgentCard/`metadata`), NO por `agent_slug` aseverado por el caller
  del bind. Un atacante no puede hacer que el card de otro agente declare su token →
  BLQ-MED-1 (spoofing por slug) cerrado. La declaración del agente es inerte sin el
  bind verificado local del MISMO token. Unicidad `token_id↔key activa` (DT-21.6)
  cierra el poisoning. El `agent_slug` deja de tener efecto en `verified` (DT-21.7).

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

---

## 10. Addendum Readiness POST-AR (DT-21 — cierre BLQ-MED-1)

| Ítem | Estado |
|---|---|
| BLQ-MED-1 (spoofing por `agent_slug` aseverado) — causa raíz identificada archivo:línea | ✅ (auth.ts:463-474/545; identity.ts:206-229; discovery.ts:228-240/398-402) |
| Mecanismo bidireccional: resolución por `token_id` declarado on-chain por el agente | ✅ (DT-21.1/21.3/21.4) |
| Campo de declaración en AgentCard — estándar `registrations` (A2A/ERC-8004) **no confirmable** → default seguro definido | ✅ (DT-21.2: sin vínculo verificable → SIN badge) |
| `resolveIdentityForSlug` → `resolveIdentityForToken(tokenId, chainId)` | ✅ (DT-21.3) |
| MNR-1 (perf): igualdad indexable por `token_id`, sin full-table scan, skip si no hay declaración | ✅ (DT-21.3, TD-ERC8004-03 reapuntado) |
| Unicidad `token_id ↔ una key activa` (pre-check app-layer + índice backlog) → 409 `ERC8004_TOKEN_ALREADY_BOUND` | ✅ (DT-21.6) |
| `agent_slug` sin efecto en `verified` (hint informativo; sin migration) | ✅ (DT-21.7, AC-9/CD-9) |
| CD-13/CD-2/CD-8/CD-3/CD-7/AC-9 preservados | ✅ (DT-21.8) |
| Test anti-spoof explícito (el ataque ya NO funciona) + test de unicidad | ✅ (Test Plan §6, filas SEC) |
| Auto-blindaje aplicado: grep `resolveIdentityForSlug` en tests/mocks antes de eliminar el export | ✅ (DT-21.7, lección Wave 4) |
| Nuevo error class `Erc8004TokenAlreadyBoundError` + `error_code` mapeado | ✅ (DT-21.6) |
| `[NEEDS CLARIFICATION]` sin resolver | NINGUNO (`registrations` marcado [VERIFY-AT-IMPL] con default seguro, no bloqueante) |

**Readiness DT-21: PASS.** BLQ-MED-1 cerrado de raíz. Listo para fix-pack del Dev.

---

## 11. ADDENDUM POST-re-AR (FIX v2) — DT-22 (cierra MNR-1 + MNR-2)

> Origen: re-Adversarial Review del fix-pack v1 (commit `6057d7e`) quedó
> **APROBADO CON MENORES**. El humano decidió cerrar los 2 MENORES ahora (badge
> trustless de verdad, "más pro que Kite"). Este addendum **refuerza** DT-21:
> hace el vínculo identidad↔agente **bidireccional** (MNR-1) y agrega **unicidad
> a nivel DB** (MNR-2). DT-21 NO se revierte; se completa. Donde DT-22 contradiga
> a DT-21, **manda DT-22**.

### DT-22.0 — Los 2 MENORES (grounded, archivo:línea)

**MNR-1 (vector inverso — el importante).** El badge v1 surfacea `verified:true`
en un agente A cuando: (a) el AgentCard de A declara token X
(`extractDeclaredTokenId`, `src/services/discovery.ts:135-169`) **Y** (b) X está
bindeado + `ownerOf`-verificado en nuestra DB (`resolveIdentityForToken`,
`src/services/identity.ts:244-271`). **Falta probar que el operador de A sea el
dueño de X.** Hoy `resolveIdentityForToken` cruza SOLO por `token_id`+`chain_id`
(identity.ts:262) — NO mira a qué agente pertenece el binding. El bind escribe el
binding en la key del owner que probó `ownerOf==funding_wallet`
(`src/routes/auth.ts:498-547`), pero NO registra QUÉ agente opera ese owner.

> **Ataque (vector inverso):** el atacante NO controla token alguno de la víctima.
> Crea un agente A' en un registry (`metadata.registrations` declara el token V de
> la víctima, que sí está bindeado por la víctima). `extractDeclaredTokenId(A')`
> devuelve V; `resolveIdentityForToken(V, chainId)` encuentra el binding de la
> víctima (porque cruza solo por token) → A' surfacea `verified:true` con la
> identidad on-chain ajena. El AgentCard de A' es controlado por el atacante (su
> registry); el token V es público y enumerable. **Rompe el contrato del badge.**

**MNR-2 (race de unicidad).** La unicidad token↔key activa (DT-21.6) hoy es SOLO
un pre-check app-layer (`src/services/identity.ts:182-198`): `SELECT id WHERE
is_active AND token_id=X AND chain_id=C AND id != keyId` y, si hay fila, lanza
`Erc8004TokenAlreadyBoundError`. Es check-then-write: dos binds concurrentes del
mismo token a dos keys distintas pueden pasar ambos el pre-check antes de que
cualquiera escriba → doble bind. Falta la barrera atómica a nivel DB.

### DT-22.1 — Principio del fix MNR-1: MATCH BIDIRECCIONAL

El badge debe exigir **AMBOS lados anclados**, donde el atacante **no controla
ninguno del lado de la víctima**:

1. **Lado agente (ya existe, DT-21):** el AgentCard del agente A declara token X
   (`extractDeclaredTokenId(A)`). Controlado por el registry/agente.
2. **Lado binder (NUEVO):** al bindear el token X, el owner declara **QUÉ agente
   opera** — su identificador estable de discovery. Se guarda DENTRO del JSONB
   `erc8004_identity`. Controlado por el owner que probó `ownerOf(X)==funding_wallet`.
3. **Regla del badge:** surfacear `verified:true` en el agente A **solo si** A
   declara token X **Y** el binding de X declara operar A (match del identificador
   estable). Si no matchean → **SIN badge**.

**El identificador estable de un `Agent` (grounded):** `mapAgent`
(`src/services/discovery.ts:435-468`) deriva del payload del registry:
`registry: registry.name` (l.461) y `slug` (l.438, `mapping.slug ?? 'slug' ?? raw.id`).
NO existe un campo de URL canónica estable en `Agent` (`invokeUrl`, l.439-442/462,
es un template `{slug}`/`{agentId}` derivado, NO un identificador de identidad).
`Agent.id` (l.444) es el `id` crudo del registry (puede colisionar entre
registries). El par **`(registry, slug)`** es el único identificador estable
cross-source (confirmado en Context Map §0 l.38 y DT-12). Por eso el binder declara
`(agent_registry, agent_slug)`, no solo `agent_slug` (resuelve colisiones de slug
entre registries: dos registries pueden tener `slug:"acme"`).

> **Match normalizado.** Tanto `registry` como `slug` se comparan
> **case-insensitive y trimmed** (`registry.name` puede variar en casing; `slug`
> ya viene lowercase de `SLUG_RE`, pero normalizamos defensivamente). El match es
> `decl.token == binding.token && decl.chain == binding.chain &&
> norm(binding.agent_registry) == norm(agent.registry) &&
> norm(binding.agent_slug) == norm(agent.slug)`.

### DT-22.2 — Análisis de cierre de AMBOS vectores (obligatorio)

Sea V la víctima (agente `(regV, slugV)`, dueña del token V) y X el atacante
(agente `(regX, slugX)`, dueño del token X, con `regX≠regV ∨ slugX≠slugV`).

**Vector original (slug spoofing — ya cerrado por DT-21, re-verificado):** el
atacante quiere que SU agente `(regX, slugX)` muestre la identidad de la víctima.
Para surfacear badge en `(regX, slugX)`, el card de ese agente debe declarar un
token T tal que el binding de T declare operar `(regX, slugX)`. El atacante puede
declarar cualquier token en el card que controla (su registry), pero el binding de
la víctima declara operar `(regV, slugV)≠(regX, slugX)` → no matchea. Y el atacante
no puede crear un binding ownerOf-verificado del token de la víctima (no es dueño).
→ **sin badge en el agente del atacante. Cerrado.**

**Vector inverso (declarar token ajeno — el que cierra DT-22):** el atacante crea
un agente A' cuyo card declara el token V de la víctima (V es público, ya bindeado
por la víctima). `extractDeclaredTokenId(A')={tokenId:V, chainId:C}`.
`resolveIdentityForToken(V, C, A'.registry, A'.slug)` busca un binding con
`token_id=V ∧ chain_id=C ∧ agent_registry=A'.registry ∧ agent_slug=A'.slug`. El
único binding de V es el de la víctima, que declara operar `(regV, slugV)`. Como
`(A'.registry, A'.slug)=(regX, slugX)≠(regV, slugV)` → **no matchea → sin badge en
A'. Cerrado.** El atacante no controla NINGUNO de los dos anclajes del lado de la
víctima: ni el `ownerOf` on-chain (no es dueño de V), ni el `(agent_registry,
agent_slug)` declarado por el binder (lo declaró la víctima al bindear).

**Caso legítimo (debe seguir funcionando):** la víctima declara en el card de
`(regV, slugV)` su token V; al bindear V declaró operar `(regV, slugV)`. Ambos
lados anclados y matcheados → **badge en `(regV, slugV)`. OK.**

**Binding viejo sin `agent_registry`/`agent_slug` (backward-compat AC-9):** un
binding escrito por v1 puede no tener los nuevos campos. **DEFAULT SEGURO:** si el
binding NO declara `(agent_registry, agent_slug)` → **NO matchea ningún agente →
sin badge** (el badge nuevo es estricto). El binding sigue siendo válido como
identidad (`/me`, `funding_wallet`-verified) y la key NO se degrada (autentica y
debita igual — AC-9). Solo deja de surfacear el badge en discovery hasta que el
owner re-bindee declarando su agente. Esto es **más seguro** que el v1 (que
surfaceaba con cruce unilateral). Se documenta como cambio de comportamiento
intencional del badge (AC-8 ajustado, ver §11.7).

### DT-22.3 — Shape nuevo de `erc8004_identity` (qué declara el binder)

`Erc8004IdentityBinding` (en `src/types/a2a-key.ts:12-24`) gana DOS campos
opcionales que juntos forman el ancla del lado-binder:

```ts
export interface Erc8004IdentityBinding {
  token_id: string;
  chain_id: number;
  agent_card_url: string;
  owner_address: string;
  verified_at: string;
  // DT-22 (MNR-1) — ancla del LADO BINDER del match bidireccional. El owner
  // declara QUÉ agente de discovery opera esta identidad. Identificador estable
  // = (registry, slug) (discovery.ts mapAgent: registry.name + slug). El badge
  // se surfacea SOLO si el agente A declara este token Y este binding declara
  // operar (A.registry, A.slug). PROMOCIÓN de agent_slug: ahora es ancla de
  // trust (cruzado con el token on-chain-poseído), ya NO un hint informativo.
  agent_registry?: string;   // == Agent.registry (registry.name). Match case-insensitive.
  agent_slug?: string;       // == Agent.slug. Match case-insensitive. Reusa SLUG_RE.
}
```

- `agent_slug` **deja de ser** el "hint informativo sin efecto" de DT-21.7 y
  **pasa a ser** el identificador del agente declarado por el binder, ahora SÍ
  sólido **porque está cruzado con el token on-chain-poseído** (el binding solo
  existe tras `ownerOf==funding_wallet`). Se añade `agent_registry` para resolver
  colisiones de slug entre registries (DT-22.1).
- **Sin columna nueva, sin migration de datos:** ambos campos viven en el JSONB
  existente (AC-9/CD-9). Bindings v1 sin estos campos → sin badge (DEFAULT SEGURO,
  DT-22.2).
- **Backward-compat de bindings v1:** NO se migran datos. El owner re-bindea
  (idempotente) declarando su agente para recuperar el badge.

### DT-22.4 — Contrato del badge `verified:true` (documentar en `AgentCardIdentity`)

En `src/types/index.ts:148-152` (comentario de `AgentCardIdentity`) se documenta
QUÉ atesta exactamente `verified:true` para el consumidor:

> `verified:true` atesta un **vínculo bidireccional probado**, NO la mera
> existencia de un token:
> 1. el AgentCard de este agente declara la identidad ERC-8004 `erc8004_token_id`
>    en `chain_id` (lado agente, on-chain-referenciado);
> 2. ese MISMO token está bindeado en una Agent Key cuyo `funding_wallet`
>    coincide con `ownerOf(token_id)` on-chain (posesión probada, lado on-chain);
> 3. ese binding declara operar ESTE agente `(registry, slug)` (lado binder).
>
> Los 3 anclajes deben coincidir. Si el card declara un token ajeno, o el binding
> declara operar otro agente, o el token no está bindeado/poseído → el campo
> `identity` se OMITE (no `verified:false`). El consumidor puede confiar en que
> `verified:true` ⇒ el operador del agente es el dueño on-chain de la AgentID.

### DT-22.5 — `resolveIdentityForToken` → `resolveIdentityForAgent` (match bidireccional)

`resolveIdentityForToken(tokenId, chainId)` (`src/services/identity.ts:244-271`)
se **reemplaza** por una firma que también recibe el identificador del agente que
declara el token, para cruzar el lado-binder:

```ts
// Reverse-lookup PÚBLICO con MATCH BIDIRECCIONAL (DT-22.5). NO Ownership Guard
// (DT-19 sigue: no es IDOR — sin keyId del caller; expone SOLO
// {token_id, chain_id, verified}; .select('erc8004_identity') NUNCA budget/PII).
// El badge requiere: el binding tiene este token+chain (lado on-chain/agente)
// Y declara operar (agentRegistry, agentSlug) (lado binder). MNR-1 cerrado.
async resolveIdentityForAgent(
  tokenId: string,
  chainId: number,
  agentRegistry: string,
  agentSlug: string,
): Promise<AgentCardIdentity | null> {
  // [VERIFY-AT-IMPL] preferir filtro server-side por igualdad indexable:
  //   .eq('erc8004_identity->>token_id', tokenId)
  //   .eq('erc8004_identity->>chain_id', String(chainId))
  //   .eq('is_active', true)
  // fallback JS (abajo) si PostgREST no lo soporta como se espera. El match de
  // agent_registry/agent_slug se hace SIEMPRE en JS (normalizado case-insensitive).
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('erc8004_identity')        // SOLO esta columna (CD-2/DT-19)
    .eq('is_active', true)
    .not('erc8004_identity', 'is', null);
  if (error || !data) return null;
  const nReg = agentRegistry.trim().toLowerCase();
  const nSlug = agentSlug.trim().toLowerCase();
  for (const row of data as Array<{ erc8004_identity: Erc8004IdentityBinding | null }>) {
    const b = row.erc8004_identity;
    if (!b) continue;
    if (b.token_id !== tokenId || b.chain_id !== chainId) continue;  // lado token
    // Lado binder (DT-22): el binding DEBE declarar operar ESTE agente.
    if (!b.agent_registry || !b.agent_slug) continue;                // sin ancla → sin badge
    if (b.agent_registry.trim().toLowerCase() !== nReg) continue;     // registry match
    if (b.agent_slug.trim().toLowerCase() !== nSlug) continue;        // slug match
    return { erc8004_token_id: b.token_id, chain_id: b.chain_id, verified: true };
  }
  return null;
}
```

- **MNR-1 (perf) preservado:** el cruce sigue siendo por igualdad de `token_id`
  (indexable, sin full-table scan por agente). El match de `(registry, slug)` es
  un filtro adicional en JS sobre el (típicamente único) binding del token. Skip
  si no hay declaración (`attachIdentities` no llama si `extractDeclaredTokenId`
  devuelve null).
- `resolveIdentityForToken` se elimina (o queda deprecated sin uso). **AUTO-BLINDAJE
  (recurrente — 3 entradas en `auto-blindaje.md`):** renombrar/eliminar un export
  rompe factory-mocks silenciosamente (TypeError en runtime, no en `tsc`). El Dev
  DEBE `grep -rn "resolveIdentityForToken" src/` (callers + `vi.mock('../services/identity.js'`)
  ANTES de renombrar, y actualizar TODOS los mocks. Ver §11.8 / CD-15.

### DT-22.6 — Callers de discovery pasan `(registry, slug)` del agente

- `attachIdentities` (`src/services/discovery.ts:335-352`): por cada agente,
  `const decl = extractDeclaredTokenId(a)`; si `!decl` → skip; si no,
  `resolveIdentityForAgent(decl.tokenId, decl.chainId, a.registry, a.slug)`. El
  `a.registry`/`a.slug` ya están en el `Agent` (mapAgent l.461/446). Mantiene
  `Promise.all` + degradación graciosa.
- `getAgent` (`src/services/discovery.ts:507-519`): idéntico —
  `resolveIdentityForAgent(decl.tokenId, decl.chainId, agent.registry, agent.slug)`.
- `src/routes/agent-card.ts`: idem — resuelve `extractDeclaredTokenId(agent)` y
  llama `resolveIdentityForAgent(decl.tokenId, decl.chainId, agent.registry,
  agent.slug)` antes de `buildAgentCard` (firma de `buildAgentCard` NO cambia).

### DT-22.7 — Bind: el handler persiste `(agent_registry, agent_slug)`

`POST /auth/erc8004/bind` (`src/routes/auth.ts:464-547`):
- `agent_slug` ya se valida (l.464-475, `SLUG_RE`). **NUEVO:** validar
  `agent_registry` OPCIONAL del body con el mismo estilo: `string`, trim, no
  vacío, longitud razonable (reusar un regex permisivo tipo
  `^[\w][\w .:/-]{0,127}$` — el Dev confirma con los `registry.name` reales del
  repo; default seguro: si inválido → 400 `INVALID_INPUT`).
- **Regla de coherencia (DT-22):** para que el bind sea utilizable como ancla del
  badge, el binder declara AMBOS `(agent_registry, agent_slug)` juntos. Si declara
  uno sin el otro → **400 `INVALID_INPUT`** (un ancla incompleta no surfacea badge
  y es señal de error del caller). Si NO declara ninguno → bind válido SIN ancla
  de badge (backward-compat con flujo "solo identidad", DEFAULT SEGURO — no
  surfacea en discovery). El binding sigue ownerOf-verified.
- El binding (auth.ts:540-547) incluye `...(agentRegistry && agentSlug && {
  agent_registry: agentRegistry, agent_slug: agentSlug })`.
- El handler de error (auth.ts:556-573) ya mapea `Erc8004TokenAlreadyBoundError` →
  409; **se mantiene** (cubre MNR-2 a nivel app + el `23505` del índice).

### DT-22.8 — MNR-2: índice UNIQUE parcial en DB (migration aditiva)

Migration **aditiva, NO destructiva** siguiendo la convención del repo
(`supabase/migrations/`, ver `20260529000001_a2a_key_funding_wallet.sql`:
`BEGIN`/`COMMIT`, `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE`, + `_down.sql`
companion con `DROP INDEX IF EXISTS`):

**Archivos (convención `YYYYMMDDHHMMSS_nombre.sql` + `_down.sql`):**
- `supabase/migrations/20260531000000_erc8004_token_unique.sql`
- `supabase/migrations/20260531000000_erc8004_token_unique_down.sql`

**UP:**
```sql
BEGIN;
-- WKH-100 FIX v2 (MNR-2): a lo sumo UNA key activa puede reclamar un mismo
-- (token_id, chain_id) ERC-8004. Cierra la race del pre-check app-layer
-- (check-then-write). Parcial: solo aplica a keys activas con identity bindeada.
-- El código ya mapea 23505 → Erc8004TokenAlreadyBoundError (identity.ts:209).
-- Aditivo + idempotente (IF NOT EXISTS). NO migra datos (AC-9/CD-9).
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_agent_keys_erc8004_token
  ON a2a_agent_keys (
    (erc8004_identity->>'token_id'),
    (erc8004_identity->>'chain_id')
  )
  WHERE is_active AND erc8004_identity IS NOT NULL;
COMMIT;
```
**DOWN:**
```sql
BEGIN;
DROP INDEX IF EXISTS uq_a2a_agent_keys_erc8004_token;
COMMIT;
```

- **Doble función:** (1) MNR-2 — barrera atómica contra doble bind concurrente; el
  2º `UPDATE` que intente escribir el mismo token a otra key activa falla con
  `23505` → `Erc8004TokenAlreadyBoundError` → 409. (2) MNR-1 perf — el índice
  funcional sobre `(token_id)` acelera el reverse-lookup (cubre TD-ERC8004-03).
- **[VERIFY-AT-IMPL] Riesgo de datos existentes:** si en prod/dev ya hay ≥2 keys
  activas con el mismo `token_id`+`chain_id` (posible por la race v1), el `CREATE
  UNIQUE INDEX` falla. El Dev DEBE verificar con un `SELECT` previo (en el
  comentario de la migration o como nota de deploy) que no hay duplicados; si los
  hay, desactivar/limpiar las keys duplicadas ANTES de aplicar (el pre-check
  app-layer minimiza esto, pero la migration debe documentarlo). No es bloqueante
  para el diseño; es nota de operación.
- El pre-check app-layer (identity.ts:182-198) **queda** como defensa en
  profundidad (devuelve 409 sin tocar DB en el caso común, da error semántico
  antes del `23505`).

### DT-22.9 — CDs preservados (verificación AR/CR)

| CD | Cómo lo preserva DT-22 |
|---|---|
| **CD-13** anti-SSRF | `extractDeclaredTokenId` sigue leyendo `metadata` en memoria; el match de `(registry, slug)` usa campos ya presentes en el `Agent`; sin fetch serve-time |
| **CD-2** sin budget | `resolveIdentityForAgent` y el pre-check de unicidad hacen `.select('erc8004_identity')`/`.select('id')`; NUNCA budget |
| **CD-8** read-only on-chain | sin RPC al servir discovery ni en el resolve; el match es 100% DB+memoria |
| **CD-3** Ownership Guard | `bindErc8004Identity` mantiene `.eq('id').eq('owner_ref')` intacto; los campos nuevos van DENTRO del binding persistido, no relajan el Guard |
| **AC-9 / CD-9** backward-compat | sin migration de datos; binding v1 sin `(agent_registry, agent_slug)` → sin badge (DEFAULT SEGURO) pero la key NO se degrada (autentica/debita igual); índice es aditivo |
| **CD-6** sin `any` | firmas tipadas; `Erc8004IdentityBinding` extendido; sin `any` |
| **CD-15 (nuevo)** | grep de exports antes de renombrar `resolveIdentityForToken` → `resolveIdentityForAgent` (auto-blindaje recurrente, §11.8) |

### CD nuevo detectado por el Architect (v2)

- **CD-15 — Renombrar/eliminar export consumido por factory-mocks.** OBLIGATORIO
  `grep -rn "<símbolo viejo>" src/` (callers) **y** `grep -rn "vi.mock('<módulo>'"
  src/` (factory-mocks que reemplazan el módulo entero) ANTES de renombrar o
  eliminar un export. Los mocks factory rompen en runtime (TypeError), NO en
  `tsc`. *Referencia: WKH-100 auto-blindaje (Wave 4 + 2 entradas del FIX-PACK
  BLQ-MED-1).* Aplica a `resolveIdentityForToken` → `resolveIdentityForAgent`.

### 11.7 — AC-8 ajustado al match bidireccional

> **AC-8 (v2):** WHEN un agente A es servido por `/discover`, `/discover/:slug` o
> `GET /agents/:slug/agent-card`, THE system SHALL surfacear
> `identity:{erc8004_token_id, chain_id, verified:true}` **si y solo si**: (i) el
> AgentCard de A declara una identidad ERC-8004 `(token_id, chain_id)` con
> `chain_id ∈ {8453, 84532}` (`extractDeclaredTokenId`), **(ii)** ese token está
> bindeado + `ownerOf`-verificado en una Agent Key activa, **Y (iii)** ese binding
> declara operar A vía `(agent_registry, agent_slug)` (match case-insensitive con
> `A.registry`/`A.slug`). Si falta cualquiera de los 3 → el campo `identity` se
> OMITE (no `verified:false`). Bindings v1 sin `(agent_registry, agent_slug)` →
> sin badge (DEFAULT SEGURO), la key NO se degrada (AC-9 intacto).

### 11.8 — Test Plan v2 (tests de seguridad nuevos)

| ID | Test | Archivo | Aserción |
|---|---|---|---|
| **SEC-INV** (MNR-1, vector inverso) | atacante declara token ajeno → SIN badge | `auth.erc8004.test.ts` / `discovery.test.ts` | víctima bindea V declarando `(regV, slugV)`; agente del atacante `(regX, slugX)` declara token V en su card → `resolveIdentityForAgent(V, C, regX, slugX)` → `null`; `/discover`+agent-card del atacante **SIN** `identity`. **El vector inverso falla.** |
| **SEC-MATCH** (match correcto) | binder declara A + A declara token → badge | `discovery.test.ts` / e2e | binding de token T declara `(regA, slugA)`; agente `(regA, slugA)` declara T en su card → `resolveIdentityForAgent(T, C, regA, slugA)` → `{verified:true}`; badge presente |
| **SEC-NOMATCH** (token en otro agente) | binder declara A, token aparece en card de B → sin badge en B | `discovery.test.ts` | binding de T declara `(regA, slugA)`; agente B `(regB, slugB)` declara T → `resolveIdentityForAgent(T, C, regB, slugB)` → `null`; B sin badge |
| **SEC-ORIG** (vector original, re-verificado) | slug spoof clásico sigue cerrado | `auth.erc8004.test.ts` | atacante bindea su token X declarando `(regX, slugX)`; intenta que su agente muestre identidad de la víctima declarando token V → token de V no está bindeado por el atacante; binding de V declara `(regV, slugV)` → sin badge en el agente del atacante |
| **SEC-LEGACY** (backward-compat) | binding v1 sin ancla → sin badge, key OK | `discovery.test.ts` / `auth.test.ts` | binding sin `agent_registry`/`agent_slug` → `resolveIdentityForAgent` → `null` (sin badge); la key autentica + debita igual (AC-9) |
| **SEC-UNIQUE-DB** (MNR-2) | índice UNIQUE rechaza doble bind | `auth.erc8004.test.ts` (mock `23505`) o migration test | bind de T a key A OK; 2º bind del MISMO T+chain a key B activa → el `UPDATE` devuelve `error.code==='23505'` → `Erc8004TokenAlreadyBoundError` → **409 `ERC8004_TOKEN_ALREADY_BOUND`**, sin write. Re-bind de A sobre su misma key (AC-5) → OK |
| **unit resolver v2** | `resolveIdentityForAgent` cruza 4 campos | `identity.test.ts` / `discovery.test.ts` | match SOLO si `token_id`+`chain_id`+`agent_registry`(ci)+`agent_slug`(ci); falta cualquiera → null; **SELECT solo `erc8004_identity`** (no budget) |
| **mocks actualizados** (CD-15) | factory-mocks reflejan `resolveIdentityForAgent` | `auth.test.ts`, `a2a-key.test.ts`, `agent-card.test.ts`, e2e | grep `resolveIdentityForToken`/`resolveIdentityForSlug` en TODO el repo; reemplazar en cada `vi.mock` factory |

> **AUTO-BLINDAJE supabase multi-query mock (recurrente):** el pre-check de unicidad
> + el UPDATE de `bindErc8004Identity` hacen 2 llamadas a `supabase.from`. Mockear
> con `mockImplementation` + contador local (NO `mockReturnValueOnce` encadenado) y
> castear builders `as unknown as ReturnType<typeof supabase.from>`. Ref:
> `auto-blindaje.md` entrada del 2026-05-31.

### 11.9 — Readiness Check (FIX v2 / DT-22)

| Ítem | Estado |
|---|---|
| MNR-1 (vector inverso) — causa raíz grounded archivo:línea | OK (`identity.ts:244-271` cruza solo token; bind no registra agente — `auth.ts:464-547`) |
| Identificador estable del `Agent` confirmado: `(registry, slug)` | OK (`discovery.ts:435-468` mapAgent l.461/446; no hay URL canónica estable) |
| Match bidireccional diseñado: lado agente (`extractDeclaredTokenId`) + lado binder (`agent_registry`+`agent_slug` en JSONB) | OK (DT-22.1/22.3/22.5) |
| Análisis de cierre de AMBOS vectores (original + inverso) + caso legítimo + legacy | OK (DT-22.2) |
| `resolveIdentityForToken` → `resolveIdentityForAgent` (4 args), callers actualizados | OK (DT-22.5/22.6) |
| `agent_slug` promovido a ancla de trust (cruzado con token poseído) + `agent_registry` para colisión de slug | OK (DT-22.1/22.3) |
| Contrato del badge documentado en `AgentCardIdentity` | OK (DT-22.4) |
| MNR-2 — migration UNIQUE parcial aditiva + `_down`, convención del repo, idempotente | OK (DT-22.8) |
| Mapeo `23505` → `Erc8004TokenAlreadyBoundError` ya existe (identity.ts:209) | OK |
| Resolución por igualdad indexable preservada (no full-table scan) | OK (DT-22.5, índice funcional cubre TD-ERC8004-03) |
| CD-13/CD-2/CD-8/CD-3/CD-6/AC-9 preservados | OK (DT-22.9) |
| CD-15 nuevo (grep exports antes de renombrar) + supabase multi-query mock | OK (§11.8, auto-blindaje recurrente) |
| Tests SEC nuevos: inverso, match, no-match, original, legacy, unique-db, unit resolver | OK (§11.8) |
| `[NEEDS CLARIFICATION]` sin resolver | NINGUNO (`agent_registry` regex marcado [VERIFY-AT-IMPL] con default seguro 400; migration con nota de duplicados pre-existentes, no bloqueante) |

**Readiness DT-22: PASS.** MNR-1 (vector inverso) cerrado por match bidireccional;
MNR-2 cerrado por índice UNIQUE parcial. Listo para fix-pack v2 del Dev.
