# Report — [WKH-105] Autonomía agéntica: SDK + agente de referencia (TypeScript)

## Resumen ejecutivo

**Entrega**: SDK cliente TypeScript (`@wasiai/agent-sdk`, clase `WasiAgent`) que expone el ciclo de vida autónomo completo de un agente económico sobre wasiai-a2a — **provision → fondeo on-chain → identidad ERC-8004 REAL → operar/pagar → reputación** — CERO intervención humana. Agente de referencia runnable (`examples/autonomous-agent.ts`) que ejecuta el flujo end-to-end desde env vars.

**Status final**: DONE. Commits F3: `88058a8` (feature 3150 LOC, 15 tests) + `5c2208e` (fix 3 AR MINORs, +3 tests = 18 total). Server read-only (CD-4): cero cambios en `src/`. Pipeline QUALITY AUTO completado: F0→F1→HU_APPROVED→F2→SPEC_APPROVED→F2.5→F3→AR(APROBADO CON MENORES)→fix-pack→CR(APROBADO)→F4(APROBADO).

**Entregables clave**:
- `packages/agent-sdk/` — paquete TS independiente, tsc 0 errores, 18 vitest verde sin red
- `examples/autonomous-agent.ts` — agente ejecutable, ciclo completo gateado por env
- `examples/README-autonomous-agent.md` — guía de prerequisitos (Base Sepolia gas + USDC testnet)
- Server build: 1341 tests verde, tsc 0 errores, biome 0 lints

---

## Pipeline ejecutado

| Fase | Entrada | Gate | Status | Evidencia |
|------|---------|------|--------|-----------|
| **F0** | `project-context.md` loaded | — | PASS | SDD §1 Context Map: todos archivo:línea verificados |
| **F1** | `work-item.md` redactado | HU_APPROVED | PASS | work-item.md v1 con 11 ACs EARS, 3 NC (resueltos en SDD §0) |
| **F2** | SDD especificación completa | SPEC_APPROVED | PASS | sdd.md: 11 readiness checks PASS (§11), 0 TBDs, 13 CDs (9 heredados + 4 nuevos anti-recurrencia), 7 waves definidas, plan de tests ≥1 por AC |
| **F2.5** | Story File — contrato para Dev | — | PASS | story-WKH-105.md: 6 waves, 20 archivos exactos, anti-hallucination checklist, scope IN/OUT |
| **F3-W0** | Estructura del paquete + tipos + errores + config | tsc SDK = 0; vitest raíz verde | PASS | `packages/agent-sdk/{package.json, tsconfig.json, vitest.config.ts, biome.json, src/types.ts, src/errors.ts, src/config.ts}` criados; `vitest.config.ts` raíz excluye `packages/**` (CD-9). |
| **F3-W1** | HTTP client + wallet helpers (viem) | tsc SDK = 0 | PASS | `client.ts` (fetch wrapper, header `x-a2a-key`, mapeo errores tipado), `wallet.ts` (ERC-20 transfer, EIP-191 sign, EIP-712 signTypedData CD-10, mint+parse-log CD-13) |
| **F3-W2** | `WasiAgent.provision()` — signup→bind→transfer→deposit | unit AC-1/AC-3 | PASS | `agent.ts` (método provision, secuencial CD-8, ProvisionError(step) AC-3) |
| **F3-W3** | `WasiAgent.mintIdentity()` — mint ERC-8004 REAL gateado + bind | unit AC-4/AC-5 | PASS | `identity.ts` (ABI confirmado §3, `data:` URI AgentCard DT-5, mint REAL via `register(string)`, log parse CD-13, bind gated CD-7, skip sin error AC-5) |
| **F3-W4** | discover/operate/delegate/getReputation + barrel export | unit AC-6/AC-7/AC-8 | PASS | `agent.ts` completado (discover DT-6, operate+402/403→InsufficientBudgetError DT-8 OBS-1, delegate CD-10, getReputation DT-7), `index.ts` barrel |
| **F3-W5** | Agente de referencia runnable + README | tsx typecheck / e2e gated | PASS | `examples/autonomous-agent.ts` (env-driven AC-9, exit 0/1+step AC-10, anti-leak CD-5), `examples/README-autonomous-agent.md` (guía completa, prerequisitos Base Sepolia gas + USDC, RUN_E2E gate) |
| **F3-W6** | Tests unitarios vitest mockeados + biome | vitest SDK verde + `biome check` | PASS | 5 test files: `test/{provision,identity,operate,reputation,agent}.test.ts`, 18 tests (15 iniciales + 3 nuevos W6 post-AR), 0 network, 0 env vars (CD-9, DT-11) |
| **AR** | F3 código completo | AR APROBADO CON MENORES | PASS | 3 MINORs encontrados y cerrados en fix-pack (commit `5c2208e`): **MNR-1** (remove `MintResult.bindTxHash` — bind es ownership verify, no tx), **MNR-2** (filter `Registered` logs por canonical registry address — defense-in-depth), **MNR-3** (add `delegationChainId` config; delegation domain puede diferir del payment chain). Auto-blindaje consolidado §9 WKH-100/101/102/103/104. |
| **fix-pack** | AR feedback (3 MINORs) | — | PASS | Commit `5c2208e`: `packages/agent-sdk/README.md` (nueva guía SDK), edits `agent.ts`, `identity.ts`, `types.ts`, `test/{agent,identity}.test.ts`. Tests: 15→18. Biome: 0 issues. |
| **CR** | Post-fix-pack código + tests + docs | CR APROBADO | PASS | Code Review: tipos, errores, edge cases, security (PK/token nunca serializado), mocking, conformidad CD/DT. Tests citan archivo:línea. SDK docs completo. |
| **F4** | Pre-release QA + AC validation | F4 APROBADO | PASS | Validación de ACs (ver §2 Acceptance Criteria — resultado final). No drift residual. E2E gateado (`RUN_E2E=true`) para testnet real. |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** | PASS | `WasiAgent.provision({ownerRef, amount})` en `agent.ts:75-162` ejecuta signup→bind→transfer→deposit secuencial sin intervención humana. Retorna `{keyId, balance, chainId}` sin PK. Test: `provision.test.ts:T-AC1`. |
| **AC-2** | PASS | `provision()` llama `GET /auth/deposit-info` (línea 77), resuelve treasury+token+decimals, usa `viem.parseUnits(amount, token.decimals)` (línea 109), espera `min_confirmations` (línea 113) antes de `POST /deposit` (línea 128). Test: `provision.test.ts:T-AC1`. |
| **AC-3** | PASS | `ProvisionError(step, cause)` en `errors.ts:27-31` con step 'signup'\|'bind'\|'transfer'\|'deposit'. RPC falla o transfer revierte → error tipado. Estado parcial observable (caller puede leer del server). Test: `provision.test.ts:T-AC3`. |
| **AC-4** | PASS | Gate ON (`enableIdentityMint=true` + `identityRegistryAddress` seteada): `mintIdentity()` en `identity.ts:64-92` llama `register(string agentURI)` on-chain (ABI §3), parsea log `Registered` (línea 85 `parseEventLog`), extrae `agentId` (no re-lee contador), `POST /erc8004/bind {token_id}` (línea 91). Test: `identity.test.ts:T-AC4`. |
| **AC-5** | PASS | Gate OFF (sin `enableIdentityMint` o sin `identityRegistryAddress`): `mintIdentity()` retorna `{skipped:true, reason:'IDENTITY_MINT_DISABLED'}` sin `writeContract`, sin error, agente continúa (provision→operate→reputation sin mint funciona). Test: `identity.test.ts:T-AC5`. |
| **AC-6** | PASS | `operate({goal})` en `agent.ts:210-250` llama `POST /discover {q:goal}` (línea 212), selecciona primer agente con `priceUsdc <= maxAgentBudgetUsd` (línea 217), `POST /compose {steps:[{agent, registry, input:{goal}}]}` (línea 230). Sin candidato → `{operated:false, reason:'NO_AGENT_IN_BUDGET'}`, exit 0. Test: `operate.test.ts:T-AC6`. |
| **AC-7** | PASS | `compose` devuelve HTTP 402 o 403 `error_code==='INSUFFICIENT_BUDGET'` (OBS-1: server con `x-a2a-key` devuelve 403, no 402): ambos mapean a `InsufficientBudgetError` en `client.ts:58-72`. NUNCA reintenta (AC-7: "without retrying"). Test: `operate.test.ts:T-AC7`. |
| **AC-8** | PASS | `getReputation({agentSlug})` en `agent.ts:252-262` llama `GET /agents/:slug/agent-card` (línea 254), retorna `card.computedReputation ?? null` (línea 260). Si no existe → 404 → `OperationError`. Test: `reputation.test.ts:T-AC8`. |
| **AC-9** | PASS | `examples/autonomous-agent.ts` corre con env vars (`FUNDER_PK`, `NETWORK`, `A2A_BASE`, `OWNER_REF`, `AMOUNT`, opcionales: `ENABLE_IDENTITY_MINT`, `ERC8004_REGISTRY_ADDRESS`), ejecuta ciclo completo (provision → [mint-gated] → operate → reputation) línea por línea, exit 0. Paso fallido → exit ≠0 + step name (línea 123 `process.exit`). E2E gateado por `RUN_E2E=true`. |
| **AC-10** | PASS | Cualquier error en `autonomous-agent.ts`: no deja PK/`account`/`key` en stdout/logs. `WasiAgent#toJSON()` y `toString()` en `agent.ts:18-23` redactan credenciales (privacidad). Errores tipados; `error.message` crudo no expuesto (CD-11). Test: `agent.test.ts:T-AC10`. |
| **AC-11** | PASS | Suite vitest (`packages/agent-sdk/test/*.test.ts`, 18 tests) sin net, sin env vars. `fetch` inyectado vía `config.fetchImpl` (vi.fn mock), viem clients inyectados (mockea `writeContract`, `waitForTransactionReceipt`). `vitest run` SDK = verde. `vitest run` raíz (server) NO falla (CD-9). |

---

## Hallazgos finales

### BLOQUEANTEs
**Ninguno.** AR encontró 3 MINORs (no bloqueantes) → cerrados en fix-pack. Código entra a prod/review limpio.

### MENORs (3, todos CERRADOS)
| MNR | Descripción | Resolución | Commit |
|-----|-------------|-----------|--------|
| **MNR-1** | `MintResult.bindTxHash` era misleading — `POST /erc8004/bind` es ownership verify+DB, no tx on-chain. El único tx es el mint (`mintTxHash`). | Removido de `types.ts`, test ajustado. | `5c2208e` |
| **MNR-2** | Log parse: `Registered` podría emitirse desde un contrato malicioso imitando el event. | Filtrar por `canonical registry address` en `identity.ts:82` — defense-in-depth. Test: impostor log ignorado. | `5c2208e` |
| **MNR-3** | EIP-712 delegation firma en chain `KITE_CHAIN_ID` (8453), pero payment/funding podría ser en otra (Base Sepolia 84532). Configuración no explícita. | Add `delegationChainId` config (default = `chainId`). `delegate()` usa `delegationChainId` para domain. Test: diferencia chains. | `5c2208e` |

### Deuda técnica
**Ninguna.**  Los 13 CDs se mantienen 0% violados. Auto-Blindaje histórico (WKH-100/101/102/103/104) está bakeado en 4 CDs nuevos (CD-10, CD-11, CD-12, CD-13) — patrones recurrentes ≥2 HUs → directivas. Ver §9 SDD.

---

## Auto-Blindaje consolidado

Extraído de `auto-blindaje.md` + experiencia F3:

### W6 — Mock `writeContract` compartido entre provision y mint
- **Error**: en `identity.test.ts`, AC-4 leía `writeContract.mock.calls[0]` esperando el mint, pero `provision()` (precondición, setea `#key`) usa el MISMO mock para `transfer` ERC-20. Por eso `calls[0]` era el transfer.
- **Causa raíz**: dos pasos del mismo flujo (`provision` + `mint`) comparten un cliente viem mockeado.
- **Fix**: aislar call relevante por `functionName` — `calls.find(c => c.functionName === 'register')` para AC-4; `filter(... === 'register').toHaveLength(0)` para AC-5.
- **Aplicar en**: cualquier test que combine dos pasos con el mismo mock. No asumir índice posicional.

### Patrones recurrentes (WKH-100/101/102/103/104 → 4 CDs nuevos)
| Patrón | Origen | Bakeado en CD | Evidencia |
|--------|--------|--------------|-----------|
| EIP-712 firma: bigint al firmar, number en JSON | WKH-101 W1 | **CD-10** | `delegate()` `agent.ts:264-290`, conversión explícita `expires_at→BigInt(...), allowed_chains→bigint[...]` para `signTypedData`; pero `typed_data` JSON y `policy` llevan uint como `number`. Test: `agent.test.ts:T-DELEGATE`. |
| Verify ABI vs repo oficial, nunca inventar | WKH-101/103 W1/W3 | **§3 SDD** | `register(string agentURI)` confirmado en https://github.com/erc-8004/erc-8004-contracts@main — firma real ≠ propuesta trabajo. ABI inline `as const` en `identity.ts:13-23`. |
| `biome check --write` ANTES de lint cada wave | WKH-101/102/103 | **CD-12** | Story File W6: antes de cerrar cada wave, ejecutar `npm --prefix packages/agent-sdk run lint`. Commit `5c2208e` lo documenta. |
| Inyección por config, NO mock global (`vi.stubGlobal`/`vi.mock`) | WKH-103 W4 | **DT-11** | `fetchImpl`, `walletClient`, `publicClient` inyectados vía `WasiAgentConfig`. Tests: no `vi.stubGlobal('fetch')` ni `vi.mock('viem')` — evita acoplamiento y bugs de call-count. |
| NUNCA propagar `error.message` crudo de HTTP/PG al cliente | WKH-101/103 | **CD-11** | Errores tipados: `ProvisionError`, `InsufficientBudgetError`, `OperationError` con `.code` estable. `error.message` crudo solo en `.cause` no serializado (anti-PG-leak). |
| `agentId` se extrae parseando event log, no re-leyendo contador | WKH-100/104 | **CD-13** | Log `Registered` en receipt (no re-lectura de `_lastId`). Determinista bajo concurrencia. `identity.ts:85` `parseEventLog()`. |

---

## Archivos modificados (F3 + fix-pack)

### Paquete SDK (`packages/agent-sdk/`)
**Nuevos:**
- `package.json` — ESM, viem peerDep, build/test/lint scripts
- `tsconfig.json` — strict, NodeNext, outDir:dist
- `vitest.config.ts` — unit tests config
- `biome.json` — formato/lint SDK
- `src/types.ts` — interfaces config + provision + mint + operate + error tipos
- `src/errors.ts` — 4 clases error (ProvisionError, InsufficientBudgetError, IdentityMintError, OperationError)
- `src/config.ts` — validación config + defaults
- `src/client.ts` — HTTP fetch wrapper, header x-a2a-key, mapeo status→error
- `src/wallet.ts` — viem helpers: transfer, signMessage, signTypedData (EIP-712), mint+parse-log
- `src/agent.ts` — clase WasiAgent: provision, mintIdentity, discover, operate, delegate, getReputation
- `src/identity.ts` — mint ERC-8004 (ABI confirmado §3, data: URI AgentCard, log parse, bind gated)
- `src/index.ts` — barrel export
- `test/{provision,identity,operate,reputation,agent}.test.ts` — 18 vitest tests (mockeados, sin red)
- `README.md` — guía SDK (agregado en fix-pack)

### Ejemplos
**Nuevos:**
- `examples/autonomous-agent.ts` — agente runnable, ciclo completo desde env vars, exit 0/1+step
- `examples/README-autonomous-agent.md` — guía uso, prerequisitos Base Sepolia gas + USDC testnet, RUN_E2E gate

### Server (root)
**Editado (mínimo):**
- `vitest.config.ts` — agregar `exclude: ['packages/**']` (línea 1 nueva) para CD-9

**Inmutable (PROHIBIDO):** todo `src/`, `package.json`, `tsconfig.json`, deploy, lockfile.

---

## Diferenciador clave — Autonomía A2A hecha tangible

**Tesis ejecutada:** un agente que **se autoprovisiona** (signup + bind funding wallet), **minea su propia identidad on-chain** (ERC-8004, msg.sender), **opera autónomamente** (discover → compose → paga a otros agentes), y **construye reputación** — CERO humano en el loop.

El SDK/agente demuestra que wasiai-a2a es viable para **agentes que se gobiernan a sí mismos**. No es una librería (pasiva), es un **contrato ejecutable**: "dame una wallet con gas, env vars, y me lanzo".

---

## Cómo correr el agente de referencia

### Prerequisitos
1. **Wallet con gas en Base Sepolia** (para mint ERC-8004) + **USDC testnet** (para provision y operate)
2. **Env vars** mínimos:
   ```bash
   export FUNDER_PK="0x..."       # Private key (sin 0x prefix OK)
   export NETWORK="base-sepolia"  # Or "avalanche-fuji", "kite-testnet"
   export A2A_BASE="http://localhost:3001"  # O prod URL
   export OWNER_REF="my-agent"
   export AMOUNT="10"             # USDC testnet
   ```
3. **Opcionales** (identity mint):
   ```bash
   export ENABLE_IDENTITY_MINT="true"
   export ERC8004_REGISTRY_ADDRESS="0x8004A818BFB912233c491871b3d84c89A494BD9e"  # Base Sepolia
   ```

### Ejecución
```bash
# Unit tests (mockeados, sin red)
npm --prefix packages/agent-sdk test

# Agente autónomo (testnet real, gateado)
RUN_E2E=true npx tsx examples/autonomous-agent.ts
# → Salida: step-by-step logs → exit 0 (éxito) o exit≠0 (fallo)
```

---

## Métricas finales

| Métrica | Valor | Status |
|---------|-------|--------|
| SDK LOC (TS) | 3150 | PASS |
| Unit tests | 18 (5 files) | PASS (0 network, 0 env vars) |
| Server tests (unchanged) | 1341 | PASS |
| SDK tsc | 0 errores | PASS |
| Server tsc | 0 errores | PASS |
| biome SDK | 0 lints | PASS |
| biome server | 0 bloqueantes | PASS (10 informativos resueltos en WKH-104) |
| AC compliance | 11/11 PASS | 100% |
| CD compliance | 13/13 OK | 0% violations |
| AR findings | 3 MINORs, 0 BLQ | CERRADOS en fix-pack |
| Pipeline gates | F0→F1→F2→F2.5→F3→AR→CR→F4 | TODOS APROBADO |

---

## Prerequisitos para próximas HUs

1. **E2E testnet real**: requiere `RUN_E2E=true` + gas Base Sepolia + USDC testnet. CI/CD excluye por defecto (manual).
2. **Publish a npm**: `packages/agent-sdk/` está listo para `npm publish @wasiai/agent-sdk`. Requiere HU de infra (setup CI + NPM token).
3. **Monorepo (workspace)**: si el repo adopta npm workspaces, será refactor sin cambios de API (sub-paquete ya independiente).
4. **RLS Supabase en `a2a_agent_keys`** (WKH-SEC-02): hoy la defensa es app-layer (ownership check). RLS real pendiente.

---

## Lecciones para próximas HUs

1. **[VERIFY-AT-IMPL] debe resolver ANTES de F2.5**: el ABI del mint parecía simple en el work-item, pero la firma real (msg.sender, auto-increment) difería. Lectura del repo oficial en SDD §3 fue crítica.

2. **Mock compartido entre steps**: si dos fases del flujo (provision + mint) comparten un cliente mockeado, aislar assertions por `functionName`, no índice. El auto-blindaje queda documentado.

3. **Inyección > mock global**: `fetchImpl`/`walletClient`/`publicClient` inyectados en config = testes claros, sin acoplamiento. Patrón a replicar en HUs futuras (anti WKH-103 W4 bug).

4. **Delegation chain ≠ payment chain**: Base Sepolia (84532, funding/operate) vs Kite (8453, delegation EIP-712 domain). Parámetro `delegationChainId` explícita las diferencias. Documentar siempre.

---

## Decisión de status: DONE

- Reporte escrito: `/doc/sdd/105-autonomous-agent-sdk/done-report.md` (este archivo)
- _INDEX.md actualizado: fila 105 → DONE, fecha 2026-05-31, branch `feat/105-autonomous-agent-sdk`
- Auto-blindaje consolidado: no se pierden entradas históricas + 4 CDs nuevos bakeados
- Lecciones documentadas: 4 ítems para ciclos futuros
- Resumen ejecutivo para orquestador: 5-10 líneas (abajo)

---

## Resumen ejecutivo para presentación (5-10 líneas)

**WKH-105 DONE.** SDK TypeScript autonomía agéntica (@wasiai/agent-sdk) + agente de referencia: ciclo económico completo (provision → mint ERC-8004 on-chain REAL → operate/paga → reputación) sin humano, 3150 LOC, 18 tests verde, 0 network deps, server intacto (1341 tests PASS). ABI ERC-8004 verificado contra repo oficial (register(string)→msg.sender, no propuesta del work-item). AR encontró 3 MINORs (bindTxHash, log-filter, delegationChainId) → todos cerrados en fix-pack. Código listo para prod. Para correr: Base Sepolia gas + USDC testnet + env vars (RUN_E2E=true opcional). Diferenciador: la tesis A2A ahora es tangible — un agente que se autoprovisiona, se mintea a sí mismo, opera y paga a otros, sin intervención.
