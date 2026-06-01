# Work Item — [WKH-DEPOSIT-INFO] GET /auth/deposit-info

## Resumen

Agregar un endpoint público y read-only `GET /auth/deposit-info` en `src/routes/auth.ts`
que devuelva, para cada chain inicializada en el registry, la información que un dev
necesita para fondear su Agent Key: treasury address, token (symbol/address/decimals) y
mínimo de confirmaciones. Elimina la necesidad de entregar esa info out-of-band (Slack,
docs manuales). El endpoint no expone ningún secret.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Mode: FAST+AR
- Branch sugerido: `feat/099-deposit-info`

## Acceptance Criteria (EARS)

- AC-1: WHEN `GET /auth/deposit-info` is called (no auth required), the system SHALL
  return HTTP 200 with a JSON body `{ "networks": [...] }` containing one entry per
  chain currently initialized in the registry (`getInitializedChainKeys()`).

- AC-2: WHEN the registry has at least one initialized chain, each entry in `networks`
  SHALL contain exactly: `chain_id` (number), `slug` (ChainKey string), `family`
  (one of `"KITE" | "AVALANCHE" | "BASE"`), `treasury` (0x address string or `null`
  when no treasury is resolvable), `token` (`{ symbol: string, address: string,
  decimals: number }` from `bundle.payment.supportedTokens[0]`), and
  `min_confirmations` (positive integer).

- AC-3: WHILE the registry has zero initialized chains (edge case), the system SHALL
  return HTTP 200 with `{ "networks": [] }` — not a 500.

- AC-4: IF `resolveTreasury(chainKey)` returns `null` for a chain, THEN the system
  SHALL include that chain's entry with `"treasury": null` — it SHALL NOT omit the
  entry or return an error.

- AC-5: the system SHALL NOT include `OPERATOR_PRIVATE_KEY`, any raw private key, any
  `SUPABASE_*` value, or any other secret/env var in the response body.

- AC-6: WHEN `GET /auth/deposit-info` is called, the system SHALL respond using the
  global rate limit (default 60/min via `RATE_LIMIT_MAX`) — it SHALL NOT be exempt
  (`rateLimit: false`) but also SHALL NOT use a stricter per-route override.

- AC-7: the system SHALL reuse `resolveMinConfirmations` and `resolveTreasury` from
  `src/adapters/deposit-verifier.ts` without duplicating their env-resolution logic.

## Scope IN

- `src/routes/auth.ts` — add `GET /deposit-info` handler (no auth middleware)
- `src/adapters/deposit-verifier.ts` — export `resolveMinConfirmations`,
  `resolveTreasury`, and `resolveChainFamilyEnvSuffix` (currently unexported
  private functions at lines 67, 86, 103)
- `src/adapters/registry.ts` — no changes needed; `getInitializedChainKeys()` and
  `getAdaptersBundle()` are already exported

## Scope OUT

- No changes to auth middleware (`requirePaymentOrA2AKey`)
- No new DB queries or Supabase calls
- No new env vars (reuses existing `A2A_DEPOSIT_TREASURY_<FAMILY>`,
  `A2A_DEPOSIT_MIN_CONFIRMATIONS_<FAMILY>`, `A2A_DEPOSIT_MIN_CONFIRMATIONS`,
  `OPERATOR_PRIVATE_KEY`)
- No RPC calls (no on-chain reads — purely env/registry data)
- No OpenAPI/schema generation changes
- No changes to `_INDEX.md` beyond this entry
- No new rate-limit tier for this endpoint

## Decisiones técnicas (DT-N)

- DT-1: `resolveChainFamilyEnvSuffix`, `resolveMinConfirmations`, and
  `resolveTreasury` SHALL be exported from `deposit-verifier.ts` by adding the
  `export` keyword. No function relocation, no wrapper — minimal diff, DRY preserved.
  Rationale: the handler in `auth.ts` needs the same resolution logic; duplicating
  it would violate the DRY directive and risk future drift.

- DT-2: The handler iterates `getInitializedChainKeys()` and for each key calls
  `getAdaptersBundle(chainKey)` to get `chainConfig.chainId` and
  `payment.supportedTokens[0]`. The `slug` field in the response is the `chainKey`
  string itself (that is the canonical slug — no separate field exists on
  `AdaptersBundle.chainConfig`).

- DT-3: `treasury: null` is a valid response value (not an error). Devs must handle
  it — indicates the chain is initialized but the operator has not configured a
  treasury env var and `OPERATOR_PRIVATE_KEY` is absent.

- DT-4: The endpoint is registered inside the `authRoutes: FastifyPluginAsync`
  plugin (prefix `/auth` in `index.ts`), resulting in path `GET /auth/deposit-info`.
  No separate router or plugin is needed.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO duplicar la lógica de resolución de treasury o confirmaciones.
  La única fuente de verdad es `deposit-verifier.ts`. Si la lógica cambia ahí,
  el endpoint debe reflejar el cambio automáticamente sin tocar `auth.ts`.

- CD-2: PROHIBIDO exponer `OPERATOR_PRIVATE_KEY` o cualquier valor de env cuyo
  nombre contenga `KEY`, `SECRET`, `TOKEN` (excepto el símbolo del token ERC-20)
  o `SUPABASE` en el cuerpo de la respuesta. El AR debe verificar esto.

- CD-3: OBLIGATORIO que el handler tolere `bundle.payment.supportedTokens` vacío sin
  crashear. Si `supportedTokens[0]` es `undefined`, la entry SHALL ser omitida o
  incluir `token: null` — [NEEDS CLARIFICATION: decidir en F2 si omitir la entry
  o incluir `token: null`; en la práctica los bundles actuales siempre tienen al
  menos un token].

- CD-4: PROHIBIDO hacer RPC calls (ningún `publicClient.get*`) en este handler.
  El endpoint es puramente configuracional — lee env vars y datos en memoria.

## Test Plan

1. Unit (vitest inject): `GET /auth/deposit-info` con registry inicializado con
   `avalanche-fuji` → 200, `networks[0]` contiene `chain_id: 43113`, `slug:
   "avalanche-fuji"`, `family: "AVALANCHE"`, `treasury: <valor de env o null>`,
   `token: { symbol: "USDC", address: "0x…", decimals: 6 }`, `min_confirmations >= 1`.

2. Unit (vitest inject): registry vacío (sin chains) → 200, `{ networks: [] }`.

3. Unit (vitest inject): env var `A2A_DEPOSIT_TREASURY_AVALANCHE` seteada → treasury
   !== null. Env var ausente + sin `OPERATOR_PRIVATE_KEY` → treasury === null.

4. Unit (vitest inject): response body keys no incluyen `OPERATOR_PRIVATE_KEY` ni
   ningún string con "SECRET", "KEY" (excluido "symbol"), "SUPABASE".

5. No auth header → 200 (no 401/403). Confirma endpoint público.

## Missing Inputs

- [resuelto en F2] Comportamiento exacto cuando `supportedTokens[0]` es undefined:
  omitir entry o incluir `token: null` (CD-3). En la práctica no ocurre hoy.

## Análisis de paralelismo

- Esta HU no bloquea otras HUs activas.
- Puede ejecutarse en paralelo con cualquier HU de docs o tooling.
- Depende de: `getInitializedChainKeys` (registry.ts:222), `getAdaptersBundle`
  (registry.ts:209), `resolveMinConfirmations` (deposit-verifier.ts:86),
  `resolveTreasury` (deposit-verifier.ts:103), `resolveChainFamilyEnvSuffix`
  (deposit-verifier.ts:67) — todos ya existentes, solo requieren ser exportados.
