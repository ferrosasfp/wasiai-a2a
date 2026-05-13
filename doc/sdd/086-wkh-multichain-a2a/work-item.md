# Work Item — [WKH-MULTICHAIN] Multi-chain support en wasiai-a2a

## Resumen

El adapter registry de wasiai-a2a soporta hoy únicamente `kite-ozone-testnet` (hardcoded en `src/adapters/registry.ts:18`). Esta HU expande el gateway para soportar cuatro chains simultáneamente (kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet), preservando 100% de backward-compat con el path existente. Es inversión de infraestructura productiva — no un atajo para el hackathon.

**Para quién:** operadores del gateway (wasiai-a2a prod en Railway) y los callers downstream (wasiai-v2 thin-proxy en producción, Lendable en el sprint siguiente).

**Por qué ahora:** el pre-flight test de 2026-05-13 confirmó que `/compose` falla con `INSUFFICIENT_BUDGET: chain 2368 balance is 0` al targear agentes en Avalanche USDC, bloqueando el track Lendable del hackathon Avalanche LATAM Fintech Build (deadline 15-17 mayo 2026).

---

## Sizing

- **SDD_MODE:** full
- **Estimación:** L
- **Smart Sizing:** QUALITY — rationale:
  - Payment path (categoría de riesgo alto automática en este proyecto)
  - Backward-compat crítica con wasiai-v2 en producción (thin-proxy WKH-66 activo)
  - Cross-cutting: 5+ módulos core (registry, middleware, compose service, discovery, env)
  - Adapter nuevo (`src/adapters/avalanche/`) con múltiples implementaciones
  - Tests cruzados chain-confusion son obligatorios (pérdida de dinero si falla)
  - Implementación multi-day estimada
  - CLAUDE.md del proyecto mandatea QUALITY siempre — confirmado que no hay base para downgrade
- **Branch sugerido:** `feat/086-wkh-multichain-a2a`

---

## Skills Router

- **blockchain-payments** — adapter factory multi-chain, EIP-3009/x402 en Avalanche USDC, chain selection per-request
- **backend-infra** — refactor registry singleton → Map, middleware chain resolver, env contract WASIAI_A2A_CHAINS

---

## Acceptance Criteria (EARS)

### Inicialización del registry

**AC-1:** WHEN `WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji` is set at startup, the system SHALL initialize adapter bundles for both chains without error and log `[Registry] Adapters initialized: kite-ozone-testnet, avalanche-fuji`.

**AC-2:** WHEN `WASIAI_A2A_CHAIN` (singular, legacy) is set and `WASIAI_A2A_CHAINS` is absent, the system SHALL behave identically to the pre-WKH-MULTICHAIN codebase (single-chain init, same log format, same getChainConfig() response).

**AC-3:** WHEN `WASIAI_A2A_CHAINS` lists a chain slug not in the supported set (`kite-ozone-testnet`, `kite-mainnet`, `avalanche-fuji`, `avalanche-mainnet`), the system SHALL throw at startup with message `Unsupported chain '<slug>'. Supported: <csv-list>`.

### Chain selection per-request

**AC-4:** WHEN a `/compose` request carries header `x-payment-chain: 43113`, the system SHALL resolve chain to `avalanche-fuji` (chainId 43113) and debit budget on that chainId.

**AC-5:** WHEN a `/compose` request targets an agent whose manifest declares `payment.chain = "avalanche-testnet"` (or normalized `"avalanche-fuji"`) and no `x-payment-chain` header is present, the system SHALL resolve chain to `avalanche-fuji` and debit budget on chainId 43113.

**AC-6:** WHEN a `/compose` request specifies no chain via header or agent manifest, the system SHALL fallback to the configured default chain (first entry in `WASIAI_A2A_CHAINS`, or `WASIAI_A2A_CHAIN` if legacy) and debit on its chainId.

**AC-7:** WHEN chain resolution produces a chainKey not present in the initialized registry (runtime lookup miss), the system SHALL return HTTP 400 with `error_code: CHAIN_NOT_SUPPORTED` and message including the unresolved chainKey.

### Budget enforcement

**AC-8:** WHEN an A2A key has budget on chain X but the resolved chain for the request is chain Y, and chain Y has zero or insufficient budget, the system SHALL return HTTP 403 with `error_code: INSUFFICIENT_BUDGET` and message `chain <chainId> balance is <balance>` (includes target chainId).

**AC-9:** WHEN multi-chain debit is evaluated within a single `/compose` request, the system SHALL debit only the single resolved chain — never two chains for the same pipeline step.

### Discovery

**AC-10:** WHEN `/discover` returns agents, the system SHALL include `payment.chain` (chain slug) and `payment.asset` (token symbol) for each agent that declares payment metadata.

### Logging and observability

**AC-11:** WHEN any debit or getBalance operation executes, the system SHALL emit a structured log entry that includes fields `chainKey`, `chainId`, and `asset_symbol`.

### Test baseline

**AC-12:** WHEN the full test suite runs (`npm test`), the system SHALL pass 379 or more pre-existing tests PLUS all new tests added for Avalanche adapter and cross-chain confusion scenarios (zero regression).

### Smoke tests

**AC-13:** WHEN a post-deploy smoke test is run against the existing Kite path (via wasiai-v2 prod → wasiai-a2a), the system SHALL return a response identical in structure to pre-WKH-MULTICHAIN (zero visible regression for Kite callers).

**AC-14:** WHEN a post-deploy smoke test is run against a test agent configured for `avalanche-fuji` with sufficient budget on chainId 43113, the system SHALL complete settlement in Fuji USDC via the facilitator and return `txHash` in the response.

---

## Scope IN

| File / Module | Tipo de cambio |
|---------------|----------------|
| `src/adapters/registry.ts` | Refactor: `SUPPORTED_CHAINS` expandido, singleton → `Map<ChainKey, AdaptersBundle>`, getters opcionales con `chainKey?`, `initAdapters()` itera CSV |
| `src/adapters/types.ts` | Adición: exportar `ChainKey` type alias, `AdaptersBundle` interface |
| `src/adapters/avalanche/chain.ts` | NUEVO: `avalancheFuji` + `avalancheMainnet` defineChain, `getAvalancheNetwork()` |
| `src/adapters/avalanche/payment.ts` | NUEVO: `AvalanchePaymentAdapter` (x402 + EIP-3009 USDC) |
| `src/adapters/avalanche/attestation.ts` | NUEVO: stub/passthrough `AvalancheAttestationAdapter` (ERC-8004 scope [NEEDS CLARIFICATION — ver Missing Inputs]) |
| `src/adapters/avalanche/gasless.ts` | NUEVO: stub deshabilitado (`enabled: false`) — Avalanche gasless fuera de scope MVP |
| `src/adapters/avalanche/identity.ts` | NUEVO: stub `null` — no hay identity binding en Avalanche MVP |
| `src/adapters/avalanche/index.ts` | NUEVO: `createAvalancheAdapters()` factory |
| `src/adapters/__tests__/registry.test.ts` | Update: tests multi-chain init + WASIAI_A2A_CHAINS CSV |
| `src/adapters/__tests__/avalanche.test.ts` | NUEVO: unit tests `createAvalancheAdapters()` |
| `src/middleware/a2a-key.ts` | Cambio: línea 180 reemplaza `getChainConfig().chainId` por chain resolver per-request |
| `src/middleware/a2a-key.test.ts` | Update: tests chain header override + agent manifest fallback + default chain fallback |
| `src/services/budget.ts` | Validación: sin cambios estructurales — ya es per-(keyId, chainId, ownerId). Verificar que `debit()` y `getBalance()` reciben el chainId resuelto desde middleware |
| `src/services/compose.ts` | Cambio: pasar `chainId` resuelto del agente target al debit — no usar getChainConfig() global |
| `src/services/discovery.ts` | Cambio: incluir `payment.chain` y `payment.asset` en resultado de discover por agente |
| `.env.example` | Adición: `WASIAI_A2A_CHAINS=kite-ozone-testnet` (nuevo), `AVALANCHE_FUJI_RPC_URL`, `AVALANCHE_MAINNET_RPC_URL`, `KITE_MAINNET_RPC_URL` (si no existe ya) |

---

## Scope OUT

- `src/adapters/kite-ozone/` — NO refactorizar internamente. Cambio máximo permitido: ajuste de firma en `createKiteOzoneAdapters()` si el nuevo `AdaptersBundle` interface requiere campo adicional (solo additive, never breaking).
- `wasiai-v2` repo — NO tocar. Las rutas thin-proxy deben continuar sin cambio.
- `wasiai-facilitator` — NO tocar la interface del facilitador. Es source-of-truth de settlement.
- `wasiai-lendable` repo — fuera de scope. HU separada post-merge.
- Mainnet deploy real contra Avalanche C-Chain — código preparado pero NO validado en este sprint contra mainnet real (test flag).
- Deposit automation per-chain — fuera de scope. El fondeo de wallets Avalanche es manual en este sprint.
- RLS en `tasks` table (`owner_ref`) — WKH-54, pendiente, no relacionado con esta HU.
- `src/middleware/x402.ts` — NO cambiar el path de x402 inbound (Kite). Esta HU es sobre debit de budget per-chain, no sobre inbound x402 settlement.
- `src/lib/downstream-payment.ts` — NO cambiar en esta HU. El downstream USDC ya corre via `WASIAI_DOWNSTREAM_NETWORK`. La coordinación entre chain-selection nueva y downstream-payment existente es responsabilidad del Architect en F2.

---

## Decisiones Técnicas

**DT-1 (Chain selection priority):** `(1) header x-payment-chain explícito > (2) agent manifest payment.chain normalizado > (3) default histórico (primer entry de WASIAI_A2A_CHAINS o WASIAI_A2A_CHAIN legacy)`. El header da control al caller. El manifest da control al agente. El default garantiza backward-compat.

**DT-2 (Adapter registry data structure):** El singleton actual (`_payment`, `_attestation`, etc.) se reemplaza por `Map<ChainKey, AdaptersBundle>`. Los getters existentes (`getPaymentAdapter()`, `getChainConfig()`, etc.) se mantienen con firma `(chainKey?: ChainKey)` — sin argumento = default chain = backward-compat. El Architect define en F2 si los getters devuelven el bundle del default o si `chainKey` es requerido en los nuevos call-sites.

**DT-3 (Env var contract):** `WASIAI_A2A_CHAINS=csv` es el nuevo contrato. `WASIAI_A2A_CHAIN` (singular) es legacy y sigue funcionando. Si ambos están presentes, `WASIAI_A2A_CHAINS` tiene precedencia. Default chain = primer item del CSV resuelto.

**DT-4 (ChainKey schema):** Slugs estables lowercase-kebab: `'kite-ozone-testnet'`, `'kite-mainnet'`, `'avalanche-fuji'`, `'avalanche-mainnet'`. Inmutables una vez publicados — son claves de Budget JSONB en Supabase (cambiarlos rompe el historial de balance).

**DT-5 (Budget storage):** Sin cambios. El campo `budget` JSONB en `a2a_agent_keys` ya es `Record<string(chainId), balance>`. El RPC `increment_a2a_key_spend` ya acepta `p_chain_id`. Validado en `src/services/budget.ts`.

**DT-6 (Avalanche payment adapter):** Mirror del patrón kite-ozone. Usa `FUJI_RPC_URL` / `AVALANCHE_RPC_URL` ya presentes en `.env.example` (WKH-55 los agregó). El facilitador (`KITE_FACILITATOR_URL` actual) puede ser reutilizable si soporta Avalanche — el Architect debe confirmar en F2 o indicar si se necesita `AVALANCHE_FACILITATOR_URL` separado. [NEEDS CLARIFICATION — ver Missing Inputs MI-1]

**DT-7 (Deposit Avalanche — manual MVP):** El humano deposita manualmente USDC Fuji en el operator wallet. El `budgetService.registerDeposit(keyId, 43113, amount)` ya existe. El F2 SDD debe documentar el procedimiento exacto (qué wallet, qué token, qué amount) para que el operador pueda fondear antes del hackathon.

**DT-8 (downstream-payment.ts coordination):** El path de downstream USDC outbound (WKH-55, `src/lib/downstream-payment.ts`) ya corre independientemente via `WASIAI_DOWNSTREAM_NETWORK`. Esta HU añade chain selection para el **debit de budget inbound** (A2A key). La coordinación entre ambos paths (misma chain o distinta) es una decisión arquitectónica para F2.

---

## Constraint Directives

**CD-1:** OBLIGATORIO — TypeScript strict, sin `any` explícito, sin `as unknown` en paths nuevos.

**CD-2:** OBLIGATORIO — Backward-compat 100% para el path `kite-ozone-testnet`. Cualquier test existente que pase hoy debe seguir pasando sin modificación al código del test (solo mocks actualizados si la firma de factory cambia).

**CD-3:** PROHIBIDO modificar `src/adapters/kite-ozone/` excepto en este caso: si la nueva interface `AdaptersBundle` requiere un campo adicional opcional, `createKiteOzoneAdapters()` puede extenderse de forma additive (no breaking).

**CD-4:** OBLIGATORIO — 379+ baseline tests pasan + nuevos tests cubren: init multi-chain, init legacy single-chain, chain resolver (header > manifest > default), debit en chain correcta, error INSUFFICIENT_BUDGET con chainId en mensaje, cross-chain confusion (intentar debitar chain no inicializada).

**CD-5:** PROHIBIDO debitar en dos chains distintas para el mismo pipeline step. La atomicidad es: una chain resuelta por request/step, una sola llamada a `budgetService.debit()`.

**CD-6:** OBLIGATORIO — Chain resolution per-request no debe agregar overhead >50ms (medido en F4). El resolver debe usar el `Map<ChainKey, AdaptersBundle>` ya en memoria — sin I/O adicional en el hot path.

**CD-7:** OBLIGATORIO — Logs estructurados incluyen `chainKey` (slug) y `chainId` (number) en cada operación de payment/debit/getBalance. Usar el logger de Fastify (`request.log` o `fastify.log`).

**CD-8:** PROHIBIDO romper wasiai-v2 producción. Smoke test post-deploy contra wasiai-v2 → wasiai-a2a path es obligatorio antes del merge. El CI debe poder ejecutarlo contra staging.

**CD-9:** OBLIGATORIO — AR (Adversarial Review, F5) DEBE atacar específicamente: (a) debit en chain incorrecta, (b) cross-chain confusion por normalización de manifest chains, (c) race condition en init multi-chain, (d) missing chainId en log de INSUFFICIENT_BUDGET, (e) IDOR (ownership check en getBalance — regla WKH-53 aplica).

**CD-10:** OBLIGATORIO — El F2 SDD documenta el procedimiento de deposit Avalanche manual (wallet, token address, amount mínimo, pasos) para que el operador pueda fondear antes del hackathon.

**CD-11:** PROHIBIDO usar `process.env.WASIAI_A2A_CHAIN` directamente en el hot path de middleware. Toda la lógica de chain selection debe pasar por el resolver centralizado (evitar el mismo error de acoplamiento que tiene la línea 180 actual).

---

## Missing Inputs

| ID | Descripción | Bloqueante | Resuelto en |
|----|-------------|-----------|-------------|
| MI-1 | El facilitador actual (`KITE_FACILITATOR_URL`, Pieverse) — ¿soporta Avalanche Fuji? ¿O se necesita `AVALANCHE_FACILITATOR_URL` separado apuntando al wasiai-facilitator self-hosted? Impacta si `AvalanchePaymentAdapter` reutiliza el mismo facilitator client o necesita uno nuevo. | SI (bloqueante para `payment.ts` Avalanche) | F2 — Architect consulta doc del facilitador o prueba endpoint |
| MI-2 | `attestation.ts` Avalanche — ¿se necesita ERC-8004 compatible en MVP, o stub vacío es aceptable? El humano no especificó. | NO — default: stub vacío | F2 — Architect decide interfaz |
| MI-3 | Normalización de `payment.chain` en agent manifests — wasiai-v2 expone `"avalanche-testnet"` (string). El resolver debe mapear esto a `'avalanche-fuji'` (ChainKey). ¿Hay otros valores conocidos que necesiten normalización (ej: `"avalanche"`, `"fuji"`)? | NO — se puede arrancar con `avalanche-testnet → avalanche-fuji` y `avalanche → avalanche-fuji` como el guard existente en `src/services/discovery.ts:40-50` | F2 — Architect define normalización completa |
| MI-4 | [SIN PRODUCT CONTEXT] No existe `product-context.md`. Esta HU es infra pura. No impacta. | NO | — |

---

## Análisis de paralelismo

- **Esta HU bloquea:** WKH-LENDABLE (Lendable repo multi-chain), cualquier HU que asuma single-chain en el gateway.
- **Esta HU NO bloquea:** WKH-54 (ownership en `tasks`), WKH-SEC-02 (RLS Postgres), documentación, ops runbooks.
- **Puede ir en paralelo con:** doc HUs, tooling HUs.
- **Conflicto potencial:** Si alguna HU in-progress toca `src/middleware/a2a-key.ts` (verificar `_INDEX.md`: WKH-25 "in progress", WKH-37 "in progress") — el Architect debe revisar posibles conflictos de merge antes de F3.

---

## Contexto adicional para el Architect (F2)

### Estado real del código — hallazgos del audit

**Confirmados leyendo los archivos:**

- `src/adapters/registry.ts:18` — `const SUPPORTED_CHAINS = ['kite-ozone-testnet'] as const` — confirmado single-chain.
- `src/adapters/registry.ts:20` — `process.env.WASIAI_A2A_CHAIN ?? 'kite-ozone-testnet'` — confirmado single-value.
- `src/middleware/a2a-key.ts:180` — `const chainId = getChainConfig().chainId;` — confirmado acoplamiento al chain de init.
- `src/services/budget.ts:47-63` — `debit(keyId, chainId, amountUsd)` — ya es per-chain. `p_chain_id` pasado al RPC. Sin cambios necesarios.
- `src/services/budget.ts:19-41` — `getBalance(keyId, chainId, ownerId)` — ya es per-chain con ownership check (WKH-53). Sin cambios.
- `src/adapters/kite-ozone/chain.ts:24-36` — `kiteMainnet` ya definido (chainId 2366). La lógica `getKiteNetwork()` separa testnet/mainnet.
- `src/adapters/kite-ozone/index.ts:22-29` — `createKiteOzoneAdapters()` usa hardcoded `kiteTestnet`. Para soportar `kite-mainnet` necesita aceptar parámetro de red — BUT este cambio está en kite-ozone scope, a evaluar por Architect.
- `src/adapters/__tests__/registry.test.ts` — tests del registry serán impactados por el cambio de `SUPPORTED_CHAINS`. Los tests actuales son los candidatos a actualizar (no reescribir).
- `.env.example` — ya contiene `FUJI_RPC_URL`, `AVALANCHE_RPC_URL`, `FUJI_USDC_ADDRESS`, `AVALANCHE_USDC_ADDRESS` del WKH-55. El scope es agregar `WASIAI_A2A_CHAINS` y documentar el nuevo contrato.
- `src/adapters/types.ts` — `PaymentAdapter` interface ya tiene `readonly chainId: number` — buena base para el bundle.
- `src/services/discovery.ts:30-50` — ya existe normalización `avalanche-testnet → avalanche` con allowlist explícita para SEC-AR-2026-04-28. El Architect debe evaluar si esta normalización debe extenderse al chain resolver del middleware o mantenerse separada.

### Test count actual

La suite tiene 60+ archivos de test. El número 379 del AC-12 es el baseline reportado por el humano. F4 (QA) debe correr `npm test` y contar el total antes del merge.
