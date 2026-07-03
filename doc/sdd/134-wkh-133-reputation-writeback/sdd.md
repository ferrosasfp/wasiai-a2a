# SDD — [WKH-133] Reputation write-back on-chain a ERC-8004

> Fase F2 (Architect). Input: `work-item.md` (misma carpeta) + `doc/competitive/okx-ai-analysis-2026-07.md` + `.nexus/project-context.md` + `CLAUDE.md`.
> Mode: **QUALITY / full**. Money-adjacent + on-chain write + operator key → rigor máximo (idempotencia, no doble-gasto de gas, fail-open, cero exposición de material de firma).
> Alcance CERRADO por el orquestador (no re-abrir): **forward-only**, **Base-only v1**, feature-flag `ERC8004_REPUTATION_WRITEBACK_ENABLED` **default OFF**, reusar `OPERATOR_PRIVATE_KEY`.

---

## 0. Resumen ejecutivo

Hoy el código ERC-8004 es 100% read-only: `src/adapters/erc8004-reputation.ts::read()` invoca `getSummary` (view). Esta HU agrega el **write path**: tras un evento settleado con éxito (`a2a_events.status='success' AND cost_usdc>0`), el sistema firma y envía **best-effort, async, idempotente** una `giveFeedback(...)` al `ReputationRegistry` ERC-8004 en Base, sin tocar el hot-path de `/compose`/`/orchestrate`/`/a2a`.

**ABI de escritura RESUELTO en F2** (no queda `[VERIFY-AT-IMPL]` abierto — ver §2 DT-ABI): verificado contra el ABI oficial `abis/ReputationRegistry.json` del repo `erc-8004/erc-8004-contracts@main` (misma fuente ya citada para `getSummary` en `erc8004-reputation.ts:24-25`), leído en vivo el 2026-07-03. La función de escritura es:

```
giveFeedback(
  uint256 agentId,
  int128  value,
  uint8   valueDecimals,
  string  tag1,
  string  tag2,
  string  endpoint,
  string  feedbackURI,
  bytes32 feedbackHash
)  // nonpayable → emite event NewFeedback
```

Es **simétrica** con las salidas de `getSummary → (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)`: cada feedback aporta un `(value, valueDecimals)` que el contrato agrega. El contrato está ligado a un `IdentityRegistry` (`getIdentityRegistry()`), por lo que `agentId` DEBE ser un token ERC-8004 ya registrado — esto ancla naturalmente el scope a agentes con identidad ERC-8004 bindeada (ver DT-6).

---

## 1. Context Map — archivos leídos y patrón extraído

| Archivo (verificado con Read/Glob) | Por qué | Patrón extraído |
|---|---|---|
| `src/adapters/erc8004-reputation.ts` | Sibling directo del writer; fuente del ABI + addresses + resolvers env + lazy client cache | `resolveReputationRegistryAddress(network)`, `resolveRpcUrl`, `resolveTimeoutMs`, `expectedChainIdFor`, `getBaseChain/getBaseNetwork`, cache `Map` propio, `_reset*()` test-only, resultado tipado `{ok,reason}` sin throw, `classifyReadError` (revert vs transporte) |
| `src/adapters/erc8004-identity.ts` | Patrón de adapter ERC-8004 read-only + `resolveContext` + chain-mismatch defensivo + comparación lowercase | `resolveContext(network)` con guard `getChainId()`; ABI inline `as const`; JSDoc "NEVER writes" (invertimos para el writer) |
| `src/lib/gasless-signer.ts` (`src/adapters/kite-ozone/gasless.ts`) | ÚNICO patrón real de firma con `OPERATOR_PRIVATE_KEY` en el repo | `privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as 0x...)`, `createWalletClient({account,chain,transport:http(rpc)})`, wallet client lazy-cacheado module-level, throw si falta pk |
| `src/services/reputation.ts` | Fórmula anti-sybil off-chain que debemos espejar (paridad AC-5) | Predicado `status==='success' && Number(cost_usdc)>0` == `tasks_settled`; graceful CD-18 (log server-side, nunca `error.message` al caller); cache `Map`; `_reset*()` |
| `src/services/event.ts` | Punto de disparo (hook) — `track()` fire-and-forget, retorna la fila insertada (con `id`) | `insert(row).select().single()` → `data.id`; JSDoc "fire-and-forget: caller uses .catch()"; narrowing `metadata` jsonb |
| `src/services/compose.ts:680-702` | Call-site real de `track()` con `status:'success'`, `costUsdc:agent.priceUsdc`, `metadata.caller_ref_hash` | El evento settleado nace acá; el hook NO debe vivir en cada call-site sino DENTRO de `track()` (single point) |
| `src/routes/agent-card.ts:83-109` | Cómo se resuelve HOY el `agentId` on-chain (para el reader) | Usa `extractDeclaredTokenId(agent).tokenId` (declarado en la AgentCard). El write path NO tiene ese objeto → resuelve slug→tokenId vía binding (DT-6) |
| `src/services/identity.ts:351-388` | Binding `a2a_agent_keys.erc8004_identity` `{token_id, chain_id, agent_registry, agent_slug}` + patrón "SOLO columnas públicas, NUNCA budget (CD-2)" | Base para el nuevo helper `resolveErc8004AgentId(slug, chainId)` (reverse lookup slug→token_id) |
| `src/types/database.types.ts:145-189` | Shape real de `a2a_events` (`id, agent_id, status, cost_usdc, metadata, registry, tx_hash`) | Confirma columnas disponibles en el hook; el marcador de idempotencia va en tabla dedicada (DT-4), NO en esta tabla de telemetría caliente |
| `supabase/migrations/20260628000000_wkh54_tasks_owner_ref.sql` | Formato de migración del repo (header, `IF NOT EXISTS`, índice, RLS) | Plantilla para la migración de la tabla de idempotencia + su `_down.sql` |
| `src/adapters/erc8004-reputation.test.ts` | Espejo de test obligatorio (Scope IN) | Mock de `viem` preservando `ContractFunctionExecutionError`/`http` reales; env set/clear por test; `_reset*()`; source-scan anti-hardcode |
| `doc/sdd/128-orchestrate-plan-execute/auto-blindaje.md` | Auto-Blindaje histórico (única HU DONE reciente con registro) | Aprendizajes → CD-11/CD-12/CD-13 (ver §3) |
| Fuente externa: `erc-8004/erc-8004-contracts@main/abis/ReputationRegistry.json` | ABI de escritura (resuelve el Missing Input bloqueante) | `giveFeedback(...)` §0 + eventos `NewFeedback`/`FeedbackRevoked`; funciones `getLastIndex`, `readFeedback`, `getClients` disponibles (no usadas en v1) |

**Verificación de exemplars (Glob/Read confirmados, paths reales):**
`src/adapters/erc8004-reputation.ts` ✔ · `src/adapters/erc8004-identity.ts` ✔ · `src/adapters/base/chain.ts` ✔ · `src/adapters/kite-ozone/gasless.ts` ✔ · `src/services/event.ts` ✔ · `src/services/reputation.ts` ✔ · `src/services/identity.ts` ✔ · `src/routes/agent-card.ts` ✔ · `src/types/database.types.ts` ✔ · `supabase/migrations/` ✔ · `src/adapters/erc8004-reputation.test.ts` ✔. **NO se referencia ningún path/función/lib sin verificar.**

**Drift detectado (reportar al humano, no bloqueante):** `project-context.md:61` lista "Redis + BullMQ" en el stack, pero **no hay uso de BullMQ en `src/`** (grep: solo una mención en `llm/vm-runner.ts`, sin `new Queue`/`new Worker`) y `reputation.ts:56` documenta explícitamente "NO hay Redis en el repo (AH-4)". → El trigger se implementa **fire-and-forget in-process** (DT-2), NO con BullMQ (evita introducir infra nueva en una HU money-adjacent). Ver DT-2.

---

## 2. Decisiones técnicas (DT-N)

### DT-ABI — Firma de escritura RESUELTA (cierra el Missing Input bloqueante)
`giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)`. Verificada contra `abis/ReputationRegistry.json` del repo oficial `erc-8004/erc-8004-contracts@main` (2026-07-03), misma fuente citada para `getSummary`. El ABI del writer se declara como constante `as const` local en `erc8004-reputation-writer.ts` (SOLO esa función, patrón `ERC8004_REPUTATION_ABI` de `erc8004-reputation.ts:63`).
- **Punto exacto de re-verificación en impl (W0):** el Dev DEBE re-confirmar la firma re-leyendo `abis/ReputationRegistry.json` de `erc-8004/erc-8004-contracts@main` y dejar el comentario `[VERIFY-AT-IMPL resuelto: ...]` citando el repo (igual que `erc8004-reputation.ts:22-29`). Si la address desplegada en la env de Base apunta a un ReputationRegistry con ABI distinto → el `writeContract` fallará limpio → fail-open (no rompe nada). El adapter NO asume nada más allá de esta firma.

### DT-1 — Firma con `OPERATOR_PRIVATE_KEY` (heredado del work-item; sin secret nuevo)
Wallet client viem construido con `privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY)` (patrón `gasless.ts:52-64`), lazy-cacheado por red. **Riesgo aceptado y documentado (memoria `kite-relayer-gas-drain.md`):** el gas de `giveFeedback` sale del mismo wallet operador compartido. Mitigación: flag default OFF + Base-only + 1 tx por evento settleado. El monitoreo de balance del operador debe contemplar esta nueva fuente (nota para ops en el done-report).

### DT-2 — Trigger fire-and-forget in-process (NO BullMQ)
El hook vive **dentro de `eventService.track()`, DESPUÉS del `insert().select().single()` exitoso**, como llamada NO awaited a un nuevo servicio: `void reputationWritebackService.onSettledEvent(mappedEvent).catch(() => {})`. Razones:
- No hay BullMQ real en el repo (§1 Drift). Introducir una cola en una HU money-adjacent expande superficie de riesgo (dead-letter, worker lifecycle) contra el sizing conservador.
- `track()` es el **single point** por el que pasan TODOS los eventos settleados (compose/orchestrate/middleware) → un solo hook cubre AC-1 sin tocar N call-sites.
- Al NO awaitear la llamada, `track()` retorna apenas termina el insert, **aunque un caller haga `await track()`** → CD-1/AC-7 garantizados estructuralmente (la latencia de p95 no puede aumentar: el write-back corre detached).
- AC-4 "queda marcado para un intento posterior": el estado `failed`/ausente en la tabla de idempotencia ES el marcador de "pendiente"; el **sweeper de reintento es una HU futura fuera de scope** (documentado en Scope OUT del SDD).

### DT-3 — Adapter puro de escritura (`erc8004-reputation-writer.ts`), sibling del reader
Responsabilidad ÚNICA: firmar + enviar `giveFeedback` + esperar receipt, devolviendo un resultado tipado `{ ok:true, txHash } | { ok:false, reason }` **sin throw**. NO lee DB, NO decide idempotencia, NO conoce `a2a_events`. Construye `WalletClient` (firmar/enviar) + `PublicClient` (esperar receipt), ambos lazy-cacheados por red. Guard `getChainId()` defensivo antes de escribir (patrón `resolveContext`, evita escribir a la red equivocada). `classifyWriteError` (revert `ContractFunctionExecutionError` → `REVERTED`; resto → `RPC_UNAVAILABLE`; timeout de receipt → `RECEIPT_TIMEOUT`).

### DT-4 — Idempotencia: tabla dedicada `a2a_reputation_writebacks` (NO columnas en `a2a_events`)
Nueva tabla con `UNIQUE(event_id)`:

```sql
a2a_reputation_writebacks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL UNIQUE,          -- FK lógica a a2a_events.id (clave de idempotencia)
  agent_slug     TEXT NOT NULL,                 -- para observabilidad / sweeper futuro
  onchain_agent_id TEXT NOT NULL,               -- token_id ERC-8004 (string, anti-precision-loss)
  chain_id       INTEGER NOT NULL,
  status         TEXT NOT NULL,                 -- 'pending' | 'confirmed' | 'failed'
  tx_hash        TEXT,                          -- solo cuando status='confirmed'
  error_code     TEXT,                          -- código corto (NUNCA error.message crudo — CD-6/CD-3)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

- Elegida sobre columnas en `a2a_events` porque: (a) `a2a_events` es telemetría de alto volumen y no debe cargar estado de write-back; (b) la tabla dedicada modela estados `pending/confirmed/failed` + `error_code` para un sweeper futuro sin polución.
- **Sin `owner_ref`**: es estado de sistema/telemetría global (como `a2a_events` y `registries` en la tabla de CLAUDE.md "Tablas con ownership"). Solo el service (SERVICE_KEY) escribe/lee; ninguna ruta la expone al caller → **no aplica Ownership Guard**. Se declara RLS `ENABLE` deny-by-default (defensa en profundidad, patrón WKH-SEC-02 / `wkh54` migration). **Nota explícita para AR:** la ausencia de `owner_ref` es intencional y correcta aquí; no es una violación del guard de CLAUDE.md.
- Migración + `_down.sql` reversible (patrón repo). `database.types.ts` se regenera o se extiende con el tipo de la nueva tabla (W0).

### DT-5 — Protocolo de idempotencia at-most-once (secuencia exacta)
Dentro de `reputationWritebackService.onSettledEvent(event)`:
1. **Gate**: si flag OFF → return (skip). Si `resolveReputationRegistryAddress(network)` null O rpc null → return (skip, AC-2). Si `event.status!=='success' || event.costUsdc<=0` → return (AC-5).
2. **Resolver `agentId`** vía `identityService.resolveErc8004AgentId(slug, expectedChainId)` (DT-6). Si null → return (skip: agente sin identidad ERC-8004; nada que attestar).
3. **Claim** (idempotencia persistida, AC-3/CD-2): `INSERT (event_id, agent_slug, onchain_agent_id, chain_id, status='pending') ON CONFLICT (event_id) DO NOTHING`. Si **0 filas insertadas** → ya existe un intento para ese `event_id` → **return sin enviar tx** (nunca doble-write / doble-gasto). Esto es la barrera dura anti-doble-gasto.
4. **Enviar tx**: `erc8004ReputationWriter.giveFeedback({ agentId, value, valueDecimals, tag1, tag2 })` (adapter espera el receipt con timeout).
5. **Persistir resultado**: éxito → `UPDATE status='confirmed', tx_hash=...`; fallo → `UPDATE status='failed', error_code=<código corto>` + log server-side (CD-3). NO se reintenta sincrónicamente (AC-4).
- La clave de idempotencia es `event_id` = **UUID server-generado** por Postgres/Supabase, **jamás controlado por el caller** (aprendizaje auto-blindaje WKH-131, ver CD-12).

### DT-6 — Resolución slug → `agentId` (token ERC-8004) vía binding
Nuevo helper `identityService.resolveErc8004AgentId(slug: string, chainId: number): Promise<bigint | null>`. Query a `a2a_agent_keys` (SOLO `erc8004_identity`, NUNCA `budget` — patrón CD-2 de `resolveIdentityForAgent`), filtrando `is_active=true`, `erc8004_identity` not null, matcheando en JS `normalizeSlug(b.agent_slug)===normalizeSlug(slug)` **y** `b.chain_id===chainId`. Retorna el `BigInt(token_id)` si hay **exactamente un** match; si **0 o >1** → `null` (skip, fail-safe: nunca escribir feedback al agente equivocado).
- **Limitación conocida documentada:** el `a2a_events.registry` es el nombre del registry (string), pero el binding ancla `agent_registry` = PK. Para v1 conservador matcheamos SOLO por `slug`+`chainId`; una colisión de slug entre registries → `>1` match → skip (no se escribe). Aceptable (fail-safe) y acotado a Base. Mejorar el anclaje por registry es HU futura.

### DT-7 — Mapping determinista off-chain → on-chain (cierra el Missing Input de mapping)
Cada evento settleado con éxito es **un** `giveFeedback` con:
- `value = 100` (`int128`, i.e. `100n`), `valueDecimals = 0` → señal positiva máxima por una task pagada completada. El contrato agrega los per-feedback en `getSummary`; no replicamos el score 0-100 agregado off-chain por-feedback (eso lo computa el contrato). Honesto y determinista.
- **Paridad anti-sybil (AC-5):** solo se emite si `status==='success' && costUsdc>0` — el MISMO predicado que `tasks_settled` en `reputation.ts:114`. Un evento `failed` o `cost<=0` NUNCA produce feedback.
- `tag1 = "wasiai"`, `tag2 = event.eventType` (p.ej. `"compose_step"` / `"orchestrate"`), ambos ASCII-bounded. `endpoint = ""`, `feedbackURI = ""`, `feedbackHash = zeroHash` (viem `zeroHash`, `bytes32` de ceros). Los valores son constantes del módulo (documentados), no env (no aportan a hardcode-sensible; no son address/rpc/secret).
- **Nota para AR:** el valor/decimales es una decisión de producto v1 (no un ABI a verificar). Si el negocio quiere modular el `value` por calidad, es evolución posterior.

### DT-8 — Env vars (reutilizar + 1 flag + 1 timeout nuevo)
- Reutiliza: `ERC8004_REPUTATION_REGISTRY_ADDRESS[_BASE_MAINNET|_BASE_SEPOLIA]`, `BASE_MAINNET_RPC_URL`/`BASE_TESTNET_RPC_URL`, `BASE_NETWORK`, `OPERATOR_PRIVATE_KEY`.
- Nuevo flag: `ERC8004_REPUTATION_WRITEBACK_ENABLED` (default `false`; se considera ON solo con `'true'` exacto). Resolver dedicado `isWritebackEnabled()`.
- Nuevo timeout de receipt: `ERC8004_REPUTATION_WRITE_RECEIPT_TIMEOUT_MS` (default `90000`; la confirmación de tx es más lenta que un read). Resolver dedicado, patrón `resolveTimeoutMs`.
- Actualizar `.env.example` (y `src/lib/env.ts` si lista optionals) — el Dev lo confirma en W0.

### DT-9 — TypeScript strict, viem v2, sin `any` (Golden Path)
Resultados tipados con unions discriminadas; `agentId` como `bigint`; on-chain ids como string (anti-precision-loss, patrón reader `count:value:decimals`). PROHIBIDO `ethers`.

---

## 3. Constraint Directives (CD-N)

**Heredados del work-item (vigentes tal cual):**
- **CD-1**: PROHIBIDO bloquear la respuesta de `/compose`/`/orchestrate`/`/a2a` esperando la tx. SIEMPRE async/best-effort (garantizado por DT-2: llamada NO awaited dentro de `track()`).
- **CD-2**: PROHIBIDO doble-write para el mismo evento. OBLIGATORIO el claim `INSERT ... ON CONFLICT (event_id) DO NOTHING` ANTES de emitir la tx (DT-5 paso 3). Ante fallo, PROHIBIDO reintento sincrónico en el mismo request.
- **CD-3**: OBLIGATORIO fail-open. Todo error RPC/contrato/gas se loguea server-side (código corto, NUNCA `error.message` crudo a ningún caller — patrón CD-18 `reputation.ts`) y NUNCA marca el evento/task subyacente como `failed`.
- **CD-4**: PROHIBIDO hardcodear registry address / RPC URL / chain params. Todo desde env (resolvers existentes).
- **CD-5**: OBLIGATORIO gate detrás de `ERC8004_REPUTATION_WRITEBACK_ENABLED` default OFF. Sin configurar → comportamiento idéntico a hoy (100% read-only, cero tx).
- **CD-6**: PROHIBIDO exponer el operator private key o cualquier material de firma en logs, respuestas HTTP o metadata persistida. SOLO `txHash` puede loguearse/persistirse. El resultado del writer NUNCA incluye la pk ni el account.

**Nuevos del SDD:**
- **CD-7**: El adapter `erc8004-reputation-writer.ts` es el ÚNICO módulo autorizado a `createWalletClient`/`writeContract` para reputación. `erc8004-reputation.ts` (reader) y `erc8004-identity.ts` PERMANECEN read-only — PROHIBIDO agregarles escritura.
- **CD-8**: OBLIGATORIO guard `getChainId()` antes de `writeContract` (evita firmar/gastar gas contra la red equivocada → `CHAIN_MISMATCH` sin tx).
- **CD-9**: El `agentId` on-chain se resuelve SOLO vía binding verificado (DT-6). PROHIBIDO escribir feedback para un slug sin identidad ERC-8004 o con resolución ambigua (0/>1 match) → skip.
- **CD-10**: La nueva tabla `a2a_reputation_writebacks` NO lleva `owner_ref` (estado de sistema global, DT-4). PROHIBIDO que cualquier ruta HTTP la exponga al caller. RLS `ENABLE` deny-by-default.

**Derivados del Auto-Blindaje histórico (obligatorios — prevención de errores documentados):**
- **CD-11**: PROHIBIDO dejar non-null assertions (`x!.y`) — el codebase los prohíbe (`lint/style/noNonNullAssertion`) y biome no los arregla en modo unsafe. Usar guard explícito. *(ref: WKH-131 auto-blindaje §W3.4)*
- **CD-12**: PROHIBIDO usar cualquier valor controlado por el caller como clave de idempotencia de un movimiento/gasto (aquí: gas). La clave DEBE ser server-generada. En esta HU la clave es `a2a_events.id` = UUID Postgres (nunca del body). *(ref: WKH-131 auto-blindaje FIX-PACK BLQ-MED-1)*
- **CD-13**: En los tests, resetear TODO cache module-level en `beforeEach` (`_resetErc8004ReputationWriter()`, `_resetReputationWriteback...` si aplica) y mockear `getAgent`/bindings por-slug con `mockImplementation`, nunca `mockResolvedValue` de un único objeto para escenarios multi-agente. *(ref: WKH-131 auto-blindaje W1/W3)*

---

## 4. Waves de implementación

**W0 — Serial (contratos, tipos, migración, ABI, env). Bloquea a W1+.**
- W0.1 Migración `supabase/migrations/2026XXXX_wkh133_reputation_writebacks.sql` + `_down.sql` (tabla DT-4 + `UNIQUE(event_id)` + índice + RLS enable). Formato = `wkh54` migration.
- W0.2 Extender/regenerar `src/types/database.types.ts` con la tabla `a2a_reputation_writebacks` (Row/Insert/Update).
- W0.3 En `erc8004-reputation-writer.ts`: constante ABI `GIVE_FEEDBACK_ABI` (`as const`, solo `giveFeedback`) + comentario `[VERIFY-AT-IMPL resuelto]` citando `erc-8004/erc-8004-contracts@main/abis/ReputationRegistry.json` (re-verificar en impl).
- W0.4 Resolvers env nuevos: `isWritebackEnabled()`, `resolveWriteReceiptTimeoutMs()` + reuso de `resolveReputationRegistryAddress`/`resolveRpcUrl`/`expectedChainIdFor`/`getBaseNetwork`. Tipos de resultado (`Erc8004WriteResult`, `Erc8004WriteReason`).
- W0.5 `.env.example` (+ `src/lib/env.ts` optionals si corresponde): `ERC8004_REPUTATION_WRITEBACK_ENABLED`, `ERC8004_REPUTATION_WRITE_RECEIPT_TIMEOUT_MS`.

**W1 — Adapter de escritura (paralelo a W2). Depende de W0.**
- `src/adapters/erc8004-reputation-writer.ts`: `giveFeedback({agentId, value, valueDecimals, tag1, tag2})` → WalletClient (firmar/enviar) + PublicClient (receipt con timeout) + guard `getChainId()` (CD-8) + `classifyWriteError` → `{ok,txHash} | {ok:false,reason}` sin throw. Lazy cache propio + `_resetErc8004ReputationWriter()`. NUNCA loguea pk (CD-6).
- Test: `src/adapters/erc8004-reputation-writer.test.ts` (mock viem preservando `ContractFunctionExecutionError`/`http`, patrón `erc8004-reputation.test.ts`).

**W2 — Helper de resolución de identidad (paralelo a W1). Depende de W0.**
- `identityService.resolveErc8004AgentId(slug, chainId)` en `src/services/identity.ts` (DT-6). Test en el archivo de test de identity existente (o nuevo).

**W3 — Servicio de write-back (orquestador). Depende de W1 + W2.**
- `src/services/reputation-writeback.ts`: `reputationWritebackService.onSettledEvent(event)` implementa la secuencia DT-5 (gate → resolve → claim → tx → persist). Mapping DT-7. Fail-open CD-3. Nunca throw.
- Test: `src/services/reputation-writeback.test.ts` — cubre AC-1..AC-6 (mock del writer + del helper + de supabase).

**W4 — Hook en el punto de disparo. Depende de W3.**
- En `src/services/event.ts::track()`, tras el `insert().select().single()` exitoso: bloque gated `if (isWritebackEnabled())` → `void reputationWritebackService.onSettledEvent(mapEventForWriteback(data)).catch(()=>{})`. NO awaited. NO altera el return `A2AEvent`. NO throw nuevo.
- Test: extender `src/services/event.test.ts` (o crear) — `track()` retorna la fila aunque el write-back rechace/cuelgue (AC-7); con flag OFF el service NO se invoca.

Orden: **W0 → (W1 ∥ W2) → W3 → W4.**

---

## 5. Exemplars verificados (paths reales para el Story File)

| Objetivo | Exemplar (verificado) |
|---|---|
| Estructura adapter ERC-8004 + resolvers env + cache + result tipado | `src/adapters/erc8004-reputation.ts` |
| Chain-mismatch guard + `resolveContext` + `classifyError` | `src/adapters/erc8004-identity.ts:139-163` |
| Firma con `OPERATOR_PRIVATE_KEY` (`privateKeyToAccount` + `createWalletClient`) | `src/adapters/kite-ozone/gasless.ts:52-64` |
| Predicado anti-sybil settleado | `src/services/reputation.ts:106-131` |
| Hook post-insert en `track()` | `src/services/event.ts:79-89` |
| Reverse-lookup de binding sin exponer budget | `src/services/identity.ts:351-388` |
| Formato de migración + down + RLS | `supabase/migrations/20260628000000_wkh54_tasks_owner_ref.sql` |
| Test adapter (mock viem, env por test, source-scan) | `src/adapters/erc8004-reputation.test.ts` |

---

## 6. Plan de tests (≥1 por AC)

Todos CI-deterministas, sin red real (mock `viem` + mock `supabase` + mock del adapter/helper). Env set/clear por test + `_reset*()` (CD-13).

| Test id | AC / CD | Archivo | Qué verifica |
|---|---|---|---|
| T-AC1 | AC-1 | `reputation-writeback.test.ts` | evento `status='success', costUsdc>0` con identidad resuelta → `writer.giveFeedback` invocado 1 vez con `agentId` correcto |
| T-AC2-flag | AC-2/CD-5 | `event.test.ts` + `reputation-writeback.test.ts` | flag OFF → `onSettledEvent`/writer NUNCA invocado; `track()` retorna normal |
| T-AC2-cfg | AC-2 | `reputation-writeback.test.ts` | registry/rpc no configurado → skip silencioso, writer NO invocado, sin throw |
| T-AC3 | AC-3/CD-2 | `reputation-writeback.test.ts` | claim `ON CONFLICT DO NOTHING` retorna 0 filas (evento ya attestado) → writer NO invocado (idempotencia, no doble-gasto) |
| T-AC4 | AC-4/CD-3 | `reputation-writeback.test.ts` | writer devuelve `{ok:false,reason:'REVERTED'|'RPC_UNAVAILABLE'}` → row `status='failed'` + log server-side, sin throw, sin reintento sync, evento NO marcado failed |
| T-AC5-failed | AC-5 | `reputation-writeback.test.ts` | evento `status='failed'` → writer NO invocado |
| T-AC5-zerocost | AC-5 | `reputation-writeback.test.ts` | evento `cost_usdc<=0` → writer NO invocado (paridad `tasks_settled`) |
| T-AC6-sign | AC-6/CD-6 | `erc8004-reputation-writer.test.ts` | adapter construye account desde `OPERATOR_PRIVATE_KEY`; con pk ausente → `{ok:false}` sin throw; resultado serializado NUNCA contiene la pk |
| T-AC7 | AC-7/CD-1 | `event.test.ts` | `track()` resuelve/retorna la fila aunque `onSettledEvent` cuelgue o rechace (fire-and-forget, no await) |
| T-CD8 | CD-8 | `erc8004-reputation-writer.test.ts` | `getChainId()` != esperado → `CHAIN_MISMATCH` y `writeContract` NUNCA llamado |
| T-CD9 | CD-9 | `identity.test.ts` + `reputation-writeback.test.ts` | slug sin binding → `resolveErc8004AgentId` null → skip; >1 match → null → skip |
| T-SCAN | CD-4/CD-6 | `erc8004-reputation-writer.test.ts` | source-scan (patrón `erc8004-reputation.test.ts:153-179`): sin address hex-40 hardcodeada; lee `process.env.ERC8004_REPUTATION_...`; cita `erc-8004/erc-8004-contracts`; el CÓDIGO no contiene la string del pk |
| T-DT7 | DT-7 | `erc8004-reputation-writer.test.ts` | `giveFeedback` recibe `value=100n, valueDecimals=0, tag1='wasiai', tag2=eventType, feedbackHash=zeroHash` |

---

## 7. Riesgos para el AR (Adversary Review)

1. **Doble-gasto de gas / doble-write** → mitigado por el claim `UNIQUE(event_id) ON CONFLICT DO NOTHING` ANTES de la tx (DT-5). AR debe verificar que NO exista ningún path que envíe `giveFeedback` sin haber ganado el claim.
2. **Bloqueo del hot-path** → la llamada dentro de `track()` es NO awaited (DT-2). AR: confirmar que no hay `await` sobre `onSettledEvent` y que ningún throw se propaga.
3. **Exposición de la pk** (CD-6) → source-scan test + revisión de que el `Erc8004WriteResult` no incluya account/pk y que ningún `log.*` reciba la pk.
4. **Escritura a la red/agente equivocado** → guard `getChainId()` (CD-8) + resolución de `agentId` fail-safe con skip ante ambigüedad (CD-9).
5. **Fail-open real** → todo error termina en `status='failed'` + log de código corto; el evento/settlement subyacente jamás se marca `failed` ni cambia (CD-3).
6. **Ownership** → `a2a_reputation_writebacks` sin `owner_ref` es correcto (estado global de sistema); AR NO debe marcarlo IDOR (justificado en DT-4/CD-10). Ninguna ruta la expone.
7. **Gas drain del operador compartido** (DT-1) → riesgo operacional aceptado; flag OFF por default; nota de monitoreo para ops.

---

## 8. Readiness Check

- [x] Work-item leído completo (Scope IN/OUT, ACs, DT, CD, Missing Inputs).
- [x] `project-context.md` + `CLAUDE.md` (Security Conventions) leídos; drift BullMQ/Redis reportado (§1).
- [x] **Missing Input bloqueante RESUELTO**: ABI de escritura `giveFeedback(...)` verificado contra la fuente oficial en vivo (§0/DT-ABI). Punto de re-verificación en impl definido.
- [x] Missing Input mapping RESUELTO: fórmula DT-7 (value=100/decimals=0, tags, paridad anti-sybil).
- [x] Missing Input trigger RESUELTO: fire-and-forget in-process, no BullMQ (DT-2, con justificación por ausencia real de la infra).
- [x] Decisiones cerradas por el orquestador respetadas: forward-only, Base-only, flag default OFF, reusar `OPERATOR_PRIVATE_KEY`.
- [x] Exemplars verificados con Glob/Read (paths reales, §1/§5). Cero paths/funciones/libs inventados.
- [x] CD del work-item heredados + nuevos + derivados del Auto-Blindaje (§3).
- [x] Waves W0→(W1∥W2)→W3→W4 con archivos exactos por wave (§4).
- [x] Plan de tests ≥1 por AC + CDs críticos (§6).
- [x] Sin `[NEEDS CLARIFICATION]` abiertos. El único `[VERIFY-AT-IMPL]` (re-lectura del ABI en impl) tiene punto exacto y fallback fail-open.
- [x] Rigor de seguridad money-path documentado (§7).

**Estado: LISTO para SPEC_APPROVED.**
