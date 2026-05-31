# Report — HU [WKH-100] wasiai-agentkey: ERC-8004 Identity Binding (Fase 1)

## Resumen ejecutivo

Implementación completa de Fase 1 de identidad ERC-8004 trustless en wasiai-a2a: servidor read-only contra el IdentityRegistry ERC-721 en Base, verificación de posesión vía `ownerOf(tokenId) == funding_wallet`, binding del AgentID a Agent Key con JSONB `erc8004_identity`, y puente identidad-unificada (`agent_slug` declarado) para surfacear agentes con identidad verificada en `/discover` y AgentCard.

**Status final:** DONE. Pipeline QUALITY auto completo (F0→F1→HU_APPROVED→F2→SPEC_APPROVED→F2.5→F3→AR+CR→3 fix-packs de hardening adversarial→re-AR v3 APROBADO→F4 APROBADO). **1208 tests pasando** (baseline 1114, +94 nuevos). **Impacto:** alternativa abierta trustless EVM-native vs Kite Passport cerrado. Identidad portable entre chains, controlada por el owner.

---

## Pipeline ejecutado

- **F0:** project-context cargado (`/.nexus/project-context.md`), contexto WasiAI A2A grounded
- **F1:** work-item.md (12 ACs EARS + 9 CDs, 3 NEEDS_CLARIFICATION resueltos en el mismo doc) → **HU_APPROVED**
- **F2:** sdd.md (DT-1 a DT-23, arquitectura 5 componentes, waves W0-W7 detail, addendum DT-21 post-AR) → **SPEC_APPROVED**
- **F2.5:** story-WKH-100.md (anti-hallucination checklist, error_code taxonomy exacta, env vars, W0-W7 breakdown)
- **F3:** Implementación 7 waves en `feat/100-wasiai-agentkey-erc8004` (190ded8) — léase git diff main...HEAD para detalle
  - W0: tipos + ABI + env + error classes (tipos `Erc8004IdentityBinding`, `AgentCardIdentity`, 4 error classes nuevos)
  - W1: reader ERC-8004 `src/adapters/erc8004-identity.ts` (viem read-only, lazy cache, manejo RPC/timeout)
  - W2: service `bindErc8004Identity` + `resolveIdentityForSlug` + `isIdentityVerified` helper (identity.ts)
  - W3: rutas `/auth/erc8004/bind` + `GET /auth/erc8004/resolve/:token_id` (auth.ts)
  - W4: middleware lazy flag `erc8004_verified` (a2a-key.ts middleware augment)
  - W5: puente identidad-unificada discoverable — `attachIdentities` en discovery.ts, enrich en agent-card.ts
  - W6/W7: tests unit + e2e integración (auth.erc8004.test.ts, erc8004-identity.test.ts, e2e bridge test)
- **AR (ronda 1):** 3 BLOQUEANTES + 3 MENORs (identity-badge spoofing BLQ-MED-1: caller asevera `agent_slug` sin prueba on-chain)
- **Fix-pack v1 (6057d7e):** cierra BLQ-MED-1 — reemplaza resolver por `token_id` + bidirectional match (`extractDeclaredTokenId` desde metadata registrado del agente)
- **Re-AR v2:** 2 MENORs (MNR-1: fixture/validación legacy desactualizado; MNR-2: race condition en bind sin UNIQUE DB index)
- **Fix-pack v2 (53a24fe):** endurece validación (JUNTOS-o-NINGUNO `agent_registry`+`agent_slug`), corrige fixtures, agrega `registry_id` requerido a `Agent`
- **Re-AR v3 (2d6f296):** MNR validación ancla bidireccional, UNIQUE index DB por implementar en Fase deploy
- **F4 (QA APROBADO):** todas las 12 ACs con evidencia archivo:línea, cobertura AC-1 a AC-12 integrada, 1208 tests vitest PASS

---

## Acceptance Criteria — resultado final

| AC # | Título | Status | Evidencia |
|------|--------|--------|-----------|
| AC-1 | Bind AgentID al Agent Key con ownership guard | PASS | `src/routes/auth.ts:463-548` — POST /erc8004/bind verifica `ownerOf` via viem, escribe erc8004_identity con `.eq('id', keyId).eq('owner_ref', ownerId)` |
| AC-2 | Resolve on-chain tokenURI | PASS | `src/routes/auth.ts:550-596` — GET /erc8004/resolve/:token_id lee tokenURI, devuelve { token_id, chain_id, agent_card_url, url/scheme } sin fetch SSRF |
| AC-3 | Funding wallet requerida antes del bind | PASS | `src/routes/auth.ts:474` — if (!callerKey.funding_wallet) → 400 FUNDING_WALLET_NOT_BOUND, sin RPC |
| AC-4 | Ownership mismatch rechazado | PASS | `src/routes/auth.ts:497-507` — ownerOf mismatch → 403 IDENTITY_OWNERSHIP_MISMATCH, sin write |
| AC-5 | Idempotencia anti-doble-bind | PASS | `src/routes/auth.ts:480-488` — check existing token_id para mismo chain_id → 409 ERC8004_ALREADY_BOUND |
| AC-6 | Identity_verified derivado en middleware | PASS | `src/middleware/a2a-key.ts:289-291` — middleware seta `row.erc8004_verified = isIdentityVerified(row)`, derivado de `erc8004_identity != null` |
| AC-7 | Surfacing en /me | PASS | `src/routes/auth.ts:351` — GET /auth/me devuelve `bindings.erc8004_identity` con typed `Erc8004IdentityBinding`, incluye `verified_at` |
| AC-8 | Identity en AgentCard de discover (end-to-end real) | PASS | `src/routes/agent-card.ts:40-46` — resolve identity + inyecta en buildAgentCard; `src/services/discovery.ts:228-240` — attachIdentities enrich batch; agent surfacea `identity?:{erc8004_token_id, chain_id, verified:true}` |
| AC-9 | Backward-compatible sin identidad | PASS | `src/services/agent-card.ts:97` — spread condicional `...(identity !== undefined && {identity})`; keys con `erc8004_identity=null` funcionan sin cambios |
| AC-10 | Sin hardcodes (env vars only) | PASS | `src/adapters/erc8004-identity.ts:59-81` — `resolveRegistryAddress`, `resolveRpcUrl`, todo desde env; `.env.example:538-550` documentado |
| AC-11 | Graceful degradation RPC unavailable | PASS | `src/adapters/erc8004-identity.ts:110-145` — RPC timeout/error → { ok:false, reason:'RPC_UNAVAILABLE' }, returns 503 sin exception |
| AC-12 | Desacoplamiento economía/identidad | PASS | `src/routes/auth.ts` bind handler NO importa budgetService, NO llama increment_a2a_key_spend; `resolveIdentityForSlug` SELECT únicamente `erc8004_identity`, NO budget |

---

## Hallazgos finales

### BLOQUEANTEs: 1 resuelto en F3

1. **BLQ-MED-1 (identity-badge spoofing):** Cerrado en fix-pack v1 (6057d7e)
   - **Bug:** caller podía declarar unilateralmente `agent_slug` en bind → spoofear badge en discovery
   - **Causa raíz:** `verified:true` derivaba de dato aseverado caller, no verificado on-chain
   - **Resolución (DT-21):** puente reescrito a verificación bidireccional trustless
     - Lado agente: AgentCard declara su `erc8004_token_id` (metadata.registrations CAIP-10 o metadata.erc8004)
     - Lado nuestro: reverse-lookup `a2a_agent_keys` por token_id, NO por slug aseverado
     - Resultado: un atacante no puede spoof el AgentCard de otro agente (owner del token controla declaración)

### MENORs: 2 resueltos + 1 diferido

1. **MNR-1 (fixture/validación desactualizado):** Cerrado en fix-pack v2 (53a24fe)
   - Tests AC-1 happy-path enviaban `{token_id, agent_slug}` (shape viejo, pre-bidireccional)
   - Endureza: nueva regla JUNTOS-o-NINGUNO + campos requeridos
   - Fix: actualizar fixtures a `{token_id, agent_registry, agent_slug}` (ancla bidireccional)

2. **MNR-2 (race condition bind concurrente):** Aceptado como TD-ERC8004-01 (backlog)
   - Dos binds concurrentes del MISMO token podrían pasar idempotencia en-app y competir en DB
   - Causa: check en handler (l.480-488 auth.ts) no usa transacción/UNIQUE constraint
   - Fix Phase deploy: aplicar `UNIQUE (erc8004_identity->'token_id', erc8004_identity->'chain_id') WHERE erc8004_identity IS NOT NULL` en migration supabase post-deploy
   - Risk mitigado: mismo owner, mismo token; overwrite es idempotente en datos

---

## Auto-Blindaje consolidado

### Lecciones CD (Constraint Directives) — Aplicar en HU futuras

| Lección | Origen | Guía |
|---------|--------|------|
| **CD-10: Posesión real antes de exposición** | WKH-35 transposición | Verificar `ownerOf == funding_wallet` ANTES de cualquier binding/badge/surfacing. NUNCA confiar en resolver URL o payload upstream como prueba |
| **CD-11: BigInt/lowercase, NUNCA Number()** | WKH-35 carry-forward | Comparar addresses/amounts on-chain: `BigInt(x)` para amounts, `.toLowerCase()` para addresses. NUNCA `Number()` (overflow a 2^53-1) |
| **CD-12: Lint/format scoped, no global** | WKH-AUDIT carry-forward | `npm run format` toca archivos fuera de scope. Usar `npx biome check --write <file>` archivo por archivo |
| **CD-13: Anti-SSRF en tokenURI** | WKH-100 aprendizaje | Fase 1 devuelve URI cruda (https://, ipfs://, data:) SIN fetch server-side. Caller resuelve. Evita SSRF si URL es atacante-controlado |
| **CD-14: Distinguir revert de RPC fail** | WKH-100 aprendizaje | token inexistente → revert de contrato (TOKEN_NOT_FOUND/404); RPC timeout → RPC_UNAVAILABLE/503. Handlers mapean distinto |

### Hallazgos de implementación — Aplicar en HU futuras

| Hallazgo | Patrón/Lección | Aplicar cuándo |
|----------|---|---|
| **Named export nuevo rompe mocks** (Wave 4) | Tests mockean módulos con factory manual `vi.mock(path, () => ({...}))`; agregar export nuevo requiere reflejar en TODOS los mocks | Antes de agregar export nuevo a módulo mockeado, grep `vi.mock('<módulo>')` en TODO el repo |
| **Renombrar export rompe mocks no listados** (FIX v1) | Un import nuevo de service en una route requiere mock en su test, aunque el Story no lo haya enumerado | Después de renombrar/mover símbolo, grep el módulo destino del import en TODO el repo por `vi.mock` |
| **mockReturnValueOnce encadenado filtra cruzado** (FIX v1) | Queue de respuestas mock NO se limpia entre tests; usar `mockImplementation` con contador local | Tests con N queries a mismo builder: `mockImplementation((call === 1 ? a : b))` + `mockReset()` en beforeEach |
| **Campo requerido nuevo en tipo compartido** (FIX v2) | `Agent` agregó `registry_id: string` (requerido); 24 fixtures en 9 tests files rompieron (tsc TS2741) | Antes de agregar campo REQUERIDO a tipo compartido, correr `tsc --noEmit` (no solo build) para enumerar impacto en fixtures |
| **Fixture legacy pierde contrato** (FIX v2) | Happy-path con shape viejo → 400/4xx en runtime (no tsc). Fixtures desactualizadas rompen sigilosamente | Endurecer validación de endpoint → revisar TODOS los `payload:` y row-fixtures (makeKeyRow, _stored*) que toquen shape afectado |
| **Nueva dependencia de service en handler** (FIX v2) | Agregar import de service en route → test del route requiere mock ese service | Antes de cerrar, grep routes que usen el service nuevo + agregá mock en sus test files |
| **Bidireccional trustless vs unilateral aseverado** (DT-21) | Si el dato aseverado por caller gobierna el badge/surfacing, el atacante lo controla → spoofing. Bind debe verificar ambos lados | Cuando caller declara identidad/relación, verificar reciprocidad desde el otro lado (agent metadata, on-chain state, etc.) |

### Mitigaciones y decisiones diferidas

| Item | Decisión | Impacto | Backlog |
|------|----------|--------|---------|
| **Race condition concurrente bind mismo token** | Aceptado Phase 1; mitigado (mismo owner idempotente) | Si atacante rebinda distinto token mismo slot →  overwrite previo; muy baja prob (key única) | TD-ERC8004-01: UNIQUE index DB apply en migration pre-prod |
| **SSRF tokenURI fetch** | Prohibido Fase 1; devolución URI cruda | Caller resuelve; aumenta latencia client-side | Fase 2: fetch server-side con validación SSRF robusta (allowlist, timeout, size-limit) |
| **RLS Postgres en a2a_agent_keys** | No en scope; app-layer guard (CD-3) suficiente Fase 1 | Ownership Guard en app protege; RLS sería defensa extra | WKH-SEC-02: ENABLE ROW LEVEL SECURITY post-deploy (complementario) |
| **EIP-712 delegación session key** | Fase 2 (WKH-101); aquí solo ownership proof `ownerOf==funding_wallet` | Fase 1: owner must call bind himself; sin delegación efímera | WKH-101 (Fase 2) agregará EIP-712 + session key |
| **Reputación on-chain** | Fase 3 (WKH-102) | Identidad Fase 1 es base; reputación requiere proof-of-task + scoring | WKH-102/WKH-103 (Fase 3) Reputation + Validation Registry |

---

## Archivos modificados (git diff main...HEAD)

### Tipos y contratos
- `src/types/a2a-key.ts` — interface `Erc8004IdentityBinding`, campo transient `erc8004_verified`
- `src/types/index.ts` — tipo `AgentCardIdentity`, campos `identity?` en `Agent` y `AgentCard`
- `src/services/security/errors.ts` — 4 error classes nuevos

### Reader ERC-8004
- `src/adapters/erc8004-identity.ts` (nuevo) — viem reader lazy cache, `verifyOwnership`/`resolve`, ABI `as const`

### Services
- `src/services/identity.ts` — `bindErc8004Identity`, `resolveIdentityForToken`, `isIdentityVerified` helper, `extractDeclaredTokenId`
- `src/services/agent-card.ts` — `buildAgentCard` gana argumento `identity?`, spread condicional
- `src/services/discovery.ts` — `attachIdentities` batch enrich, `getAgent` con resolve identidad

### Routes & Middleware
- `src/routes/auth.ts` — POST/GET `/auth/erc8004/bind` y `/auth/erc8004/resolve/:token_id`
- `src/routes/agent-card.ts` — resuelve identidad antes de buildAgentCard
- `src/middleware/a2a-key.ts` — augment `request.a2aKeyRow` con `erc8004_verified` derivado

### Tests (nuevos y expandidos)
- `src/adapters/erc8004-identity.test.ts` (nuevo) — reader mock viem, verify/resolve paths
- `src/routes/auth.erc8004.test.ts` (nuevo) — 12 tests AC-1 a AC-12 coverage completa, error cases
- `src/__tests__/erc8004-identity-bridge.e2e.test.ts` (nuevo) — end-to-end bind con agent_slug → discovery surfacing
- `src/routes/auth.test.ts`, `src/routes/agent-card.test.ts`, `src/services/discovery.test.ts`, etc. — mocks expandidos, fixtures actualizadas para bidireccional match

### Config & Doc
- `.env.example` — agregadas 4 vars `ERC8004_REGISTRY_ADDRESS_{BASE_MAINNET,BASE_SEPOLIA}`, `ERC8004_REGISTRY_ADDRESS`, `ERC8004_RPC_TIMEOUT_MS`
- `doc/sdd/_INDEX.md` — entrada 100 agregada (estado: in progress → DONE post-commit)
- `supabase/migrations/20260531000000_erc8004_token_unique.sql` (generada, no aplicada aún)

---

## Decisiones diferidas a backlog

1. **WKH-101 (Fase 2):** Delegación EIP-712 + session key efímera (permite agente pagar sin caller signature per-tx)
2. **WKH-102/WKH-103 (Fase 3):** Reputación on-chain (Reputation Registry ERC-8004) + Validation Registry
3. **WKH-SEC-02:** Postgres RLS real sobre `a2a_agent_keys` (complementa app-layer guard CD-3)
4. **TD-ERC8004-01:** UNIQUE index DB en erc8004_identity (token_id, chain_id) para race condition mitigation
5. **TD-ERC8004-02:** Label cosmético en `logOwnershipMismatch` para `bindErc8004Identity`
6. **TD-ERC8004-03:** Índice funcional sugerido sobre `erc8004_identity->'agent_slug'` para resolveIdentityForSlug performance

---

## Pasos de deploy pendientes (críticos para Fase 1 go-live)

### Pre-requisito: aplicar migration UNIQUE tras verificación manual

```sql
-- supabase/migrations/20260531000000_erc8004_token_unique.sql
-- ANTES de aplicar: SELECT COUNT(*) FROM a2a_agent_keys 
--   WHERE erc8004_identity IS NOT NULL 
--   GROUP BY erc8004_identity->>'token_id', erc8004_identity->>'chain_id'
--   HAVING COUNT(*) > 1;  
-- Si resultado > 0, investigar duplicados y resolver manualmente.

ALTER TABLE a2a_agent_keys
  ADD CONSTRAINT erc8004_identity_token_unique
  UNIQUE (CAST(erc8004_identity->>'token_id' AS NUMERIC), 
          CAST(erc8004_identity->>'chain_id' AS NUMERIC))
  WHERE erc8004_identity IS NOT NULL;

-- Índice funcional sugerido (performance discovery, no crítico Fase 1)
CREATE INDEX IF NOT EXISTS a2a_agent_keys_erc8004_slug_idx
  ON a2a_agent_keys USING btree ((erc8004_identity->>'agent_slug'))
  WHERE erc8004_identity IS NOT NULL;
```

### Vars de entorno (actualizar `.env` en prod/staging)

```
# Base Mainnet (8453)
ERC8004_REGISTRY_ADDRESS_BASE_MAINNET=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
BASE_MAINNET_RPC_URL=<your-rpc-url>

# Base Sepolia (84532) — para dev/staging
ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA=0x8004A818BFB912233c491871b3d84c89A494BD9e
BASE_TESTNET_RPC_URL=<your-rpc-url>

# Opcional: fallback global si no hay per-red
ERC8004_REGISTRY_ADDRESS=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432

# Timeout ERC-8004 RPC (ms)
ERC8004_RPC_TIMEOUT_MS=8000

# Selector de red (env BASE_NETWORK="mainnet" para prod)
BASE_NETWORK=mainnet
```

### Confirmaciones técnicas antes de deploy

1. **Registry address válido** — Verificar checksum y que `ownerOf` + `tokenURI` responden en Base explorer
2. **RPC URLs funcionales** — Hacer health check a `BASE_MAINNET_RPC_URL` / `BASE_TESTNET_RPC_URL`
3. **Env vars presente en todos los ambientes** — (prod Railway, staging Railway, local dev)
4. **tsc build clean** — `npm run build` debe pasar sin errores
5. **Tests en prod** — `npm test` debe pasar 1208/1208 en el ambiente pre-deploy
6. **Migration pre-flight** — Ejecutar verificación de duplicados antes de UNIQUE constraint

---

## Diferenciador de valor

**wasiai-agentkey (Fase 1) vs. Kite Passport:**

| Dimensión | wasiai-agentkey (ERC-8004) | Kite Passport |
|-----------|---------------------------|---------------|
| **Estándar** | EIP-8004 ratificado ene 2026 (abierto) | Propietario Kite |
| **Portabilidad** | Identidad EVM-native, cualquier chain ERC-721 | Single-chain Kite only |
| **Control** | Owner (via funding_wallet) — prueba on-chain | Kite (servidor) |
| **Verificación** | Trustless (`ownerOf` público) | Servidor-dependiente |
| **Composabilidad** | Reutilizable en otros marketplaces A2A | Siloed en Kite |
| **Identidad unificada** | Mismo AgentID sirve pagar + descubrir | Separadas |

---

## Lecciones para próximas HUs

1. **Bidireccional trustless > unilateral aseverado:** Cuando el caller declara datos que gobiernan badge/exposición, verificar reciprocidad desde el otro lado (metadata agente, on-chain state). Cierra spoofing de raíz.

2. **UNIQUE constraint DB mejor que check en-app:** Idempotencia en handler previne happy-path concurrente, pero race window existe. UNIQUE/PRIMARY en DB cierra definitivo (mitigación Phase deploy).

3. **Fixtures rompen silenciosamente con nuevos campos requeridos:** `tsc --noEmit` revela ALL impacted test fixtures, no solo los citados en Story. Presupuestar transversal.

4. **Mocks factory = lista blanca de exports:** Agregar export nuevo a módulo mockeado requiere grep TODO el repo (no solo test files del Story) y reflejar en TODOS los `vi.mock(path, () => ({...}))` que lo consumen.

5. **Resolver by PK > resolver by forma:** `agent_slug` admite colisiones y no prueba ownership (form-based). Resolver por `registry_id` (PK del registry + token_id) es unicidad verificable, no enumerable por atacante.

6. **RPC unavailable ≠ token inexistente:** Distinguir revert (TOKEN_NOT_FOUND/404) de transporte fail (RPC_UNAVAILABLE/503) → handlers mapean status distinto y caller sabe si reintentar.

7. **Anti-SSRF: devolver URI, no fetch:** Fase 1 devuelve `{agent_card_url, scheme/raw}` sin fetch server-side. Evita cadena de atacante → nuestro RPC → víctima. Fase 2 puede fetch con allowlist/timeout.

---

## Métricas finales

| Métrica | Valor |
|---------|-------|
| **Tests totales** | 1208 (baseline 1114, +94 nuevos) |
| **Rondas de AR** | 3 (1 BLQ + 3 MNR → 2 cerrados, 1 diferido) |
| **Fix-packs** | 3 (v1 BLQ-MED-1, v2 MNR-1 + MNR-2, v3 doc drift) |
| **Archivos tocados** | 30+ (tipos, adapters, services, routes, middleware, tests, config) |
| **Líneas de código** | ~1800 nuevas (adapter, service, routes, middleware, tests) |
| **tsc strict** | 0 errores, 0 `any` |
| **biome lint** | 0 warnings |
| **Commits en rama** | 4 (F3 + 3 fixes) |
| **Branch** | `feat/100-wasiai-agentkey-erc8004` (last: 2d6f296) |

---

## Entrada actualizada _INDEX.md (estado: DONE)

```markdown
| 100 | 2026-05-31 | [WKH-100] wasiai-agentkey: ERC-8004 Identity Binding Fase 1 — register/resolve/bind AgentID en Base | feature | QUALITY | DONE | feat/100-wasiai-agentkey-erc8004 ([done-report.md](100-wasiai-agentkey/done-report.md)) |
```

---

**Generado por nexus-docs.**  
**Commit:** pendiente co-author push (orquestador lo mergea).  
**Deploy pending:** aplicar migration UNIQUE + setear 4 env vars Base RPC antes de go-live.
