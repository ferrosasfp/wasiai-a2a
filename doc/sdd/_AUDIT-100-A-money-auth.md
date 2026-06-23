# AUDITORÍA DE SEGURIDAD PROJECT-WIDE — DIMENSIÓN A: CAMINO DE DINERO Y AUTENTICACIÓN

**Fecha**: 2026-06-23
**Auditor**: nexus-adversary (modo auditoría project-wide, Dimensión A)
**Alcance**: middleware de auth/pago (`a2a-key.ts`, `x402.ts`), servicios de budget/identity/fee/orchestrate/compose/delegation/key-session, rutas `auth/compose/orchestrate/gasless/receipts`, adapters de pago + verifiers de depósito/escrow, y los RPC Postgres del débito/depósito.
**Suite**: `npx vitest run` → **1628 passed | 4 skipped (103 files)**. Baseline verde.
**Método**: lectura archivo:línea + trazado del flujo de dinero end-to-end + lectura de las migraciones SQL de los RPC SECURITY DEFINER.

---

## Resumen ejecutivo

| Severidad | # |
|-----------|---|
| CRÍTICO   | 1 |
| ALTO      | 0 |
| MEDIO     | 2 |
| BAJO      | 2 |
| OK / defendido (con evidencia) | varios |

**Top finding (CRÍTICO):** el flujo x402 **inbound** (`requirePayment`) NO ata el pago al wallet del merchant ni al precio del recurso. El server construye el challenge 402 con su propio `payTo`/`maxAmountRequired`, pero en la verificación del pago entrante envía al facilitator `payTo` y `amount` **tomados de la authorization que firmó el propio caller** (`proof.authorization.to` / `proof.authorization.value`). Un caller puede firmar un pago de `1 wei` a `to = su propia dirección` y `verify()/settle()` devolverán `valid/success` (la firma es válida para esa authorization), obteniendo acceso pago a `/compose` y `/orchestrate` sin pagarle a WasiAI. Self-pay / underpay completo.

El resto del camino de dinero por **agent key / session / delegation** (el path principal del producto) está **bien defendido**: débito atómico `FOR UPDATE`, anti-replay de depósitos por `UNIQUE(chain_id, tx_hash)`, ownership guard DB-level + app-level, cap por destino cerrado en master/session/delegation (WKH-125/125b confirmado), search_path fijo y REVOKE de anon/authenticated en todos los RPC SECURITY DEFINER.

---

## FINDINGS

### CRIT-1 — x402 inbound sin binding de recipient ni amount (self-pay / underpay) [CRÍTICO]

**Categoría**: Security / Data Integrity (under-billing)
**Archivos**:
- `src/middleware/x402.ts:212-281` (verify→settle sin comparar contra el challenge)
- `src/adapters/kite-ozone/payment.ts:256-257` y `:300-301` (Pieverse: `maxAmountRequired: proof.authorization.value`, `payTo: proof.authorization.to`)
- `src/adapters/kite-ozone/payment.ts:453-455` (`buildX402CanonicalBody`: `amount: authorization.value`, `payTo: authorization.to`)
- `src/adapters/kite-ozone/payment.ts:466-497` (`verifyX402` solo chequea `result.verified === true`)
- `src/adapters/base/payment.ts:249-251` (mismo patrón en Base)

**Descripción**: en `requirePayment`, `buildX402Response` arma el challenge con `payTo: walletAddress` (= `PAYMENT_WALLET_ADDRESS`/`KITE_WALLET_ADDRESS`) y `maxAmountRequired: amount`. Pero al recibir el `X-PAYMENT`/`payment-signature` del caller, el middleware llama `getPaymentAdapter(chainKey).verify({ authorization: paymentPayload.authorization, signature, network })` y luego `settle(...)` **sin comparar nunca**:
1. `authorization.to === walletAddress` (recipient binding), ni
2. `BigInt(authorization.value) >= BigInt(amount)` (amount binding).

El adapter, a su vez, construye los `paymentRequirements`/cuerpo canónico para el facilitator con `payTo`/`amount` **derivados de la propia authorization del caller** (no del wallet/precio esperado del server). El facilitator solo valida que la firma EIP-3009 sea consistente con esa authorization. Por lo tanto cualquier authorization auto-consistente pasa.

**Reproducción**:
1. `GET`/`POST /compose` sin key → 402 con `accepts[0].payTo = <wallet del merchant>`, `maxAmountRequired = 1e18`.
2. El caller firma una `TransferWithAuthorization` EIP-3009 con `to = <su propia EOA>`, `value = "1"` (1 wei), `validBefore` futuro, `nonce` random — firma con SU clave (es `from`).
3. Envía `X-PAYMENT: base64(JSON{authorization, signature})`.
4. `verify()` → el facilitator confirma firma válida para esa authorization → `valid:true`. `settle()` → transfiere 1 wei del caller a su propia dirección → `success:true`, `txHash` real.
5. El middleware setea `paymentVerified=true` y deja correr `/compose` → ejecución multi-agente pagada **sin pagarle a WasiAI**.

Esperado: el middleware debe rechazar (402) si `authorization.to !== walletAddress` o `value < maxAmountRequired`. Real: acepta cualquier `to`/`value`.

**Impacto**: bypass total del cobro x402 inbound (revenue = 0 para el path x402); acceso gratuito a orchestrate/compose, que a su vez pueden gatillar settles downstream y fee transfers con fondos del operador. Es el path de "money in" para callers anónimos.

**Sugerencia (NO implementar)**: en `requirePayment`, tras `decodeXPayment`, validar antes de `verify`: (a) `paymentPayload.authorization.to.toLowerCase() === walletAddress.toLowerCase()`; (b) `BigInt(paymentPayload.authorization.value) >= BigInt(amount)`. Alternativamente, que cada adapter construya `paymentRequirements.payTo`/`maxAmountRequired` desde el wallet/precio del **server** (no desde `proof.authorization`) y que el facilitator rechace el mismatch. Defensa en profundidad: hacer ambas.

> Nota: si el facilitator self-hosted (modo `x402`) YA valida `payTo`/`amount` contra una política propia, la severidad baja; pero el código del server **no puede asumirlo** y hoy le pasa al facilitator los valores del atacante, así que el server no tiene binding propio. Tratar como CRÍTICO hasta probar binding server-side.

---

### MED-1 — `bindPassport` / `bindErc8004` no es money-path pero comparte el wallet-binding sin proof-of-control reusado [MEDIO → reclasificado a OK, ver abajo]

(Descartado tras revisión — ver sección OK/defendido. No es finding.)

### MED-1 (real) — Discovery `maxPrice` vs costo real per-step: under-billing de pasos LLM de transform [MEDIO]

**Categoría**: Data Integrity (under-billing) / Integration
**Archivos**: `src/services/compose.ts:160-167` + `src/services/orchestrate.ts:406-425`
**Descripción**: el débito per-step (`i>0`) cobra `agent.priceUsdc` (o `$1` fallback), pero el costo del **bridge LLM** (`maybeTransform`, compose.ts:251-266) que puede invocar Anthropic NO se debita al budget de la key — se reporta en telemetría (`transformLLM.costUsd`) pero nunca se cobra. Un caller con pipelines que fuerzan transforms LLM costosos consume cómputo del operador (API key de Anthropic) sin que se debite de su budget.
**Reproducción**: pipeline de 2 steps con schemas incompatibles que fuerzan `bridgeType='LLM'`; el `costUsd` del LLM aparece en `metadata.bridge_cost_usd` del evento pero `budgetService.debit` solo recibió `agent.priceUsdc`. El balance de la key baja únicamente por el precio del agente, no por el LLM.
**Impacto**: drain acotado del costo LLM del operador (no del budget on-chain del caller). No es robo de fondos del caller; es costo de cómputo no facturado. Acotado por `LLM_TIMEOUT_MS` y `max_tokens:1024`.
**Sugerencia**: incluir `tr.llm.costUsd` en el débito per-step, o documentar explícitamente como DT (costo de transform absorbido por el protocolo).

### MED-2 — `getProtocolFeeRate` se relee por request pero el fee se calcula sobre `budget` del caller en orchestrate y sobre `totalCostUsdc` en compose: base inconsistente, fee evadible bajando totalCost [MEDIO]

**Categoría**: Data Integrity (fee evasion parcial)
**Archivos**: `src/services/orchestrate.ts:246` (`feeUsdc = budget * feeRate`) vs `src/routes/compose.ts:251` (`budgetUsdc: result.totalCostUsdc`).
**Descripción**: en `/orchestrate` el fee se cobra sobre el `budget` declarado por el caller (input controlado). Un caller puede declarar `budget` mínimo (apenas cubre los agentes que quiere) → fee proporcionalmente mínimo, aunque el valor real movido downstream sea mayor vía transforms/downstream settles. En `/compose` el fee se cobra sobre `totalCostUsdc` (suma de `priceUsdc`), que NO incluye downstream settle amounts ni LLM. En ambos casos la base del 1% es subdeclarable/incompleta.
**Reproducción**: `/orchestrate` con `budget=0.01` y agentes de precio 0 (registry-miss → fallback $1 per-step debit pero fee = `0.01*0.01`). El fee cobrado (`0.0001`) es trivial frente al cómputo real.
**Impacto**: el 1% protocol fee es evadible/minimizable. Best-effort por diseño (CD-B: nunca rompe), así que no bloquea el request; el impacto es revenue, no seguridad de fondos del caller.
**Sugerencia**: documentar la base de cálculo del fee como decisión explícita, o cobrar sobre `max(budget, totalCostUsdc + downstream + llm)`.

### BAJO-1 — `parentAvailableBalance` (early-fail de creación de session) puede sobre/sub-estimar con multi-chain budget [BAJO]

**Categoría**: Data Integrity (edge case, no explotable)
**Archivo**: `src/services/key-session.ts:109-121`
**Descripción**: si la parent key tiene >1 chain fondeado, el guard cae al `defaultChainId`; si ese chain tiene 0 pero otro tiene fondos, una sesión con `max_budget_usd` legítimo puede ser rechazada (`ScopeExceedsParentError`) — o, a la inversa, una sesión puede crearse con `max_budget` > balance de la chain que realmente se usará. NO es un bypass de gasto: el cap duro lo impone el RPC `debit_session_and_parent` per-chain bajo lock. Solo afecta el early-fail de creación.
**Impacto**: UX / falso negativo en creación. Sin pérdida de fondos (el RPC corta).
**Sugerencia**: documentar que el guard es heurístico (ya está comentado como tal).

### BAJO-2 — `feeUsdcToWei` y `valueWei` asumen token de 18 decimales (PYUSD) en todas las chains [BAJO]

**Categoría**: Type Safety / Integration
**Archivos**: `src/services/fee-charge.ts:122-124`, `src/services/compose.ts:418-420`
**Descripción**: `BigInt(Math.round(usdc*1e6)) * BigInt(1e12)` escala a 18 decimales fijo. En chains cuyo token de pago es de 6 decimales (USDC nativo en Base/Avalanche mainnet) esto sobre-escala 1e12, enviando un `value` 1e12 veces mayor. El fee/settle usa `getPaymentAdapter()` (default chain) por lo que en el deploy actual (Kite/PYUSD 18-dec) es correcto, pero es un hardcode de decimales frágil ante multichain real.
**Impacto**: latente; en deploy actual no se dispara. Riesgo de over-transfer si se habilita fee/compose-sign sobre un token 6-dec.
**Sugerencia**: derivar decimales del `supportedTokens[0].decimals` del bundle (como ya hace deposit-verifier), no hardcodear 1e12.

---

## VECTORES REVISADOS — DEFENDIDOS (con evidencia)

- **Bypass de auth con key inválida/inactiva**: `a2a-key.ts:758-765` (KEY_NOT_FOUND/KEY_INACTIVE) y `identity.ts:89-103` (PGRST116→null). El lookup es por SHA-256 del token (`a2a-key.ts:754`); no hay comparación de strings timing-sensible sobre el secreto (se hashea y se busca por índice). **OK**.
- **Débito atómico / race condition**: `increment_a2a_key_spend` con `SELECT ... FOR UPDATE` (mig `20260609...:35-38`); debit-before-execute (`a2a-key.ts:831-861`, Stripe-style). **OK**.
- **Anti-replay de depósitos**: `UNIQUE(chain_id, tx_hash)` + INSERT-then-credit en una tx (`20260529000000:17,74-79`); front-run del txHash ajeno bloqueado por gate `Transfer.from == funding_wallet` (`auth.ts:717-722`, `deposit-verifier.ts:262-269`). **OK**.
- **Cap por destino (WKH-125/125b)**: confirmado cerrado en master (`a2a-key.ts:852-861`), session (`a2a-key.ts:615-632`) y delegation (`a2a-key.ts:383-400`); step-0 deriva destino del agente RESUELTO (`routes/compose.ts:34-43,97-103`), per-step idem (`compose.ts:166`). El RPC `debit_with_dest_policy` chequea cap bajo `FOR UPDATE` ANTES del debit y hace rollback total (`20260606000000:69-129`). **OK** — el bypass de E16 (BLQ-MED-1) está corregido.
- **RPC SECURITY DEFINER**: TODOS con `SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` (mig `20260427160000`, `20260529000000:96-103`, `20260606000000:134-139,227-232`, `20260609000000` los 4). Sin SQL dinámico (`EXECUTE format`) → sin injection. Ownership guard DB-level dentro de cada uno. **OK**.
- **Ownership guard app-layer**: `budget.getBalance/.debit`, `identity.*`, `spend-policy.*`, `key-session.*`, `delegation.*` filtran por `owner_ref` o derivan el owner del row autenticado (lookups por token-hash documentados como no-IDOR). **OK**.
- **Sub-delegación / sub-sesión prohibida**: gates de prefijo ANTES de `resolveCallerKey` en `/delegation`, `/key-session`, revokes y require-signature (`auth.ts:1102-1105,1246-1252,1322-1326,1494-1500`). **OK**.
- **EIP-712 delegation**: domain binding pre-recover (`delegation.ts:133-140`), signer == funding_wallet (`:200-202`), policy firmada == policy del request (`policiesEqual`, `:206-208`), anti-replay `UNIQUE(key_id, nonce)` (`:242-244`). **OK**.
- **Disclosure de errores**: los RPC nunca propagan el msg crudo de PG al cliente (mapeo a error_code estable en budget/session/delegation services); rutas loguean solo `errorClass`. **OK**.
- **Gasless drain**: cap global pre-debit (`gasless.ts:53-67`), debit-before-transfer, auth requerida (WKH-54). Avalanche/Base gasless = stub disabled. **OK**.
- **Fee idempotencia**: PK `orchestration_id` + INSERT pending + unique_violation→already-charged; `request.id` server-generado (no header-controlable, confirmado en audit E16). **OK**.

---

## VEREDICTO

**RECHAZADO — 1 CRÍTICO activo (CRIT-1: x402 inbound sin binding de recipient/amount).**

El path principal (agent key / session / delegation / deposit) está sólido. El hueco está en el path x402 inbound, que es exactamente "money in" para callers anónimos y hoy es evadible al 100% server-side. Recomendación: tratar CRIT-1 como HU de hot-fix (binding de `to`/`value` en `requirePayment` + adapters), y evaluar MED-1/MED-2 (revenue) como backlog. BAJO-1/BAJO-2 son latentes/documentables.
