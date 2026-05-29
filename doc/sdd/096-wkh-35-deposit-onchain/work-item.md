# Work Item — [WKH-35] Fondeo verificado on-chain de agent keys (budget prepago), multi-chain

## Resumen
Re-habilitar `POST /deposit` (hoy HTTP 501 en `src/routes/auth.ts`) para que un caller
fondee su a2a-key con **prueba on-chain real** del depósito, acreditando el saldo al
`budget[chainId]` correcto vía el `registerDeposit()` ya existente. Multi-chain
(Kite / Avalanche / Base), seguro: verificación on-chain, anti-replay por tx, matching
de chain y respeto del Ownership Guard. Para: agentes consumidores que pagan pipelines
con budget prepago (path b). Por qué: hoy NO existe forma de cargar saldo — el endpoint
está apagado por falta de verificación on-chain.

## Sizing
- Metodología: **QUALITY** (toca pago + auth = superficie de seguridad alta; AR + CR + F4 obligatorios).
- SDD_MODE: full
- Estimación: **L** — el "verify on-chain de un depósito" NO existe en el codebase (ver Grounding §2) + anti-replay nuevo (tabla/columna) + multi-chain ×3.
- Branch sugerido: `feat/096-wkh-35-deposit-onchain`

## Grounding (estado real verificado — archivo:línea)
1. **`POST /deposit` deshabilitado** — `src/routes/auth.ts:98-109` retorna `501 deposit_verification_pending`.
   El comentario cita "via PaymentAdapter.verify() (WKH-35)" pero ese verify NO sirve (ver §2).
2. **El `verify()` existente NO verifica depósitos on-chain.** `PaymentAdapter.verify(proof: X402Proof)`
   (`src/adapters/types.ts:83`, impl `src/adapters/kite-ozone/payment.ts:235-280`,
   `src/adapters/base/payment.ts:379-381`) valida una **firma EIP-3009 / autorización x402**
   POSTeándola a un facilitator (`/verify`). NO recibe un `txHash`, NO lee un receipt on-chain,
   NO chequea confirmaciones. Verificar un depósito YA confirmado es una capacidad **nueva**.
3. **No hay lectura on-chain de tx en la app.** Los módulos `chain.ts` y `payment.ts` solo construyen
   `walletClient` (firma); **no existe** `publicClient` / `getTransactionReceipt` en `src/`. El único
   `*deposit*` del repo son internals de viem op-stack (no aplican).
4. **`registerDeposit()` listo y atómico** — `src/services/budget.ts:70-84` → PG function
   `register_a2a_key_deposit` (`supabase/migrations/20260406000000_a2a_agent_keys.sql:126-147`,
   `FOR UPDATE`). **Pero NO es idempotente y NO recibe txHash** → no hay anti-replay hoy.
5. **No hay persistencia anti-replay.** `a2a_agent_keys` (misma migración, líneas 8-38) no tiene
   columna/tabla de tx de depósito consumidas. Scope nuevo (tabla `a2a_key_deposits` o equivalente).
6. **Budget es per-chain** — `budget JSONB {"<chainId>": "<amount>"}` (migración:14-15); el debit
   per-step usa el `chainId` resuelto del bundle (`src/middleware/a2a-key.ts:226-235`). El crédito
   del depósito DEBE ir al mismo `chainId` para ser consistente con el debit.
7. **Ownership Guard activo** — patrón `.eq('owner_ref', ownerId)` (`src/services/budget.ts:24-41`,
   `getBalance` ya lo aplica; CLAUDE.md "Security Conventions"). `registerDeposit()` HOY **no** cruza
   por `owner_ref` (solo `p_key_id`) → gap a cerrar.
8. **Resolución de chain per-request** ya existe — `resolveChainKey({headerOverride})` + `x-payment-chain`
   header + `getAdaptersBundle()` (`src/middleware/a2a-key.ts:188-228`). Reutilizable para el deposit.

## Acceptance Criteria (EARS)
- **AC-1 (re-habilitación + verificación on-chain)**: WHEN un caller autenticado (a2a-key) envía
  `POST /deposit` con la prueba de un depósito on-chain para una chain soportada, the system SHALL
  verificar on-chain que el depósito ocurrió (monto, token/asset, recipient esperado y chainId) ANTES
  de acreditar, y SHALL retornar el nuevo balance de esa chain con HTTP 200 solo si la verificación pasa.
- **AC-2 (rechazo si la verificación falla)**: IF la verificación on-chain falla (tx inexistente,
  `status != success`, monto/token/recipient/chain que no coinciden, o confirmaciones insuficientes),
  THEN the system SHALL rechazar el depósito con un error explícito y SHALL NOT llamar `registerDeposit()`
  (cero crédito al budget).
- **AC-3 (anti-replay / idempotencia por tx)**: IF una tx de depósito ya fue acreditada previamente,
  THEN the system SHALL rechazar el reintento sin volver a acreditar, y the system SHALL persistir cada
  tx de depósito consumida de forma única (no se acredita la misma tx dos veces ni bajo concurrencia).
- **AC-4 (matching de chain → budget per-chain)**: WHEN un depósito verificado en chain `C` se acredita,
  the system SHALL incrementar exclusivamente `budget[chainId(C)]` (consistente con el debit per-chain),
  y SHALL rechazar si el chainId declarado por el caller no coincide con el de la tx verificada on-chain.
- **AC-5 (ownership)**: WHILE se acredita un depósito a una key, the system SHALL acreditar únicamente
  la key cuyo `owner_ref` coincide con el del caller autenticado; IF el `keyId` objetivo pertenece a otro
  owner, THEN the system SHALL rechazar con error de ownership y SHALL NOT acreditar (Ownership Guard,
  `register_a2a_key_deposit` debe filtrar por `owner_ref`).
- **AC-6 (multi-chain — Kite / Avalanche / Base)**: WHERE la chain del depósito está inicializada en el
  registry (`getAdaptersBundle`), the system SHALL soportar el fondeo verificado para las 3 chains
  (Kite / Avalanche / Base) reutilizando la resolución per-request existente (`x-payment-chain`); IF la
  chain no está soportada/inicializada, THEN the system SHALL retornar `CHAIN_NOT_SUPPORTED`.

## Scope IN
- `src/routes/auth.ts` — re-habilitar `POST /deposit` (quitar 501), validar input, orquestar verify → anti-replay → registerDeposit, requerir autenticación (a2a-key/Bearer) y `owner_ref`.
- Mecanismo de **verificación on-chain del depósito** — capacidad nueva (decisión DT-1). Probablemente nueva pieza en `src/adapters/*` o `src/lib/*` (p.ej. lectura de receipt via viem publicClient por chain), porque el `verify()` actual NO cubre este caso (Grounding §2/§3).
- `src/services/budget.ts` — `registerDeposit()` debe pasar a recibir/usar `owner_ref` (Ownership Guard) y txHash para idempotencia (firma cambia; ver CD-1/CD-2).
- **Persistencia anti-replay** — nueva tabla/columna (p.ej. `a2a_key_deposits` con UNIQUE(chain_id, tx_hash)) + nueva migración + ajuste de `register_a2a_key_deposit` (idempotente, recibe txHash + owner_ref).
- Tests: unit (verify on-chain ok/fail, anti-replay, chain mismatch, ownership) + e2e del flujo `/deposit` para las 3 chains (mockeando RPC/facilitator como hacen los tests de adapters).

## Scope OUT
- Path x402 per-request (EIP-3009 live) — NO tocar.
- `debit` per-step (`increment_a2a_key_spend`, compose) — NO tocar.
- UI/CLI de fondeo — solo el endpoint/API.
- `POST /bind/:chain` (on-chain identity binding) — fuera, sigue 501 (auth.ts:146-155).
- Despliegue de un contrato escrow nuevo — fuera salvo que F2 confirme que ya existe uno (no se detectó).
- Cambios al `PaymentAdapter.verify()` x402 existente — no se reusa para depósitos (ver DT-1).

## Decisiones técnicas (DT-N) — iniciales, a confirmar/ampliar por Architect en F2
- **DT-1 (mecanismo de verificación) [NEEDS CLARIFICATION]**: el `verify()` actual NO verifica un
  depósito on-chain. Dos caminos posibles: (a) **txHash + receipt** — caller manda `txHash`; el gateway
  lee el receipt on-chain (viem `getTransactionReceipt` con un `publicClient` nuevo por chain) y valida
  monto/token/recipient/chainId/confirmaciones; (b) **firma EIP-3009 → settle** — caller manda una
  autorización firmada y el gateway la liquida via `PaymentAdapter.settle()`, acreditando el txHash
  resultante (reusa path x402). Recomendación conservadora del Analyst: **(a) txHash + receipt** porque
  el depósito es un evento que YA ocurrió on-chain y necesita prueba de finalidad — pero lo decide F2.
- **DT-2 (recipient esperado) [NEEDS CLARIFICATION]**: el destinatario validado debe ser el
  treasury/operator de cada chain (por env, sin hardcode — ver CD-3). No se detectó contrato escrow en el
  codebase; asumir transfer directo a treasury salvo que F2 confirme escrow.
- **DT-3 (finalidad/confirmaciones) [NEEDS CLARIFICATION]**: política de confirmaciones mínimas antes de
  acreditar (fija "1/mined+success" vs configurable por chain). Conservador: configurable por env por chain,
  default seguro. Lo define F2.
- **DT-4 (anti-replay storage)**: tabla nueva `a2a_key_deposits` con `UNIQUE(chain_id, tx_hash)` (o columna
  jsonb de tx consumidas en `a2a_agent_keys`). Preferencia: tabla dedicada (auditable, no infla el row de la
  key). El INSERT del tx + el crédito deben ser **atómicos** (misma transacción PG que `register_a2a_key_deposit`)
  para cerrar la race de doble crédito bajo concurrencia. Confirma F2.
- **DT-5 (resolución de chain)**: reutilizar `resolveChainKey({headerOverride})` + `x-payment-chain` +
  `getAdaptersBundle()` del middleware (`src/middleware/a2a-key.ts:188-228`); el `chainId` para el crédito
  sale del **bundle** (no de un valor del caller sin verificar). El chainId de la tx verificada debe coincidir
  (AC-4).
- **DT-6 (amount → USD)**: el budget es USD (`NUMERIC(18,6)`), las stablecoins son ~1:1 USD pero con decimales
  distintos por chain (PYUSD 18 dec en Kite testnet, USDC 6 dec en Base/Avalanche — ver `payment.ts`
  `decimals`). La conversión monto-atómico-on-chain → USD debe usar los `decimals` del `supportedTokens` del
  adapter, NO un literal. (Carry-forward del decimals-drift de WKH-67, _INDEX #072.) Confirma F2.

## Constraint Directives (CD-N) — iniciales (Architect amplía en F2)
- **CD-1 (Ownership Guard — OBLIGATORIO)**: toda mutación/lectura sobre `a2a_agent_keys` en el flujo de
  deposit DEBE filtrar por `owner_ref` además del `id` (CLAUDE.md Security Conventions). `register_a2a_key_deposit`
  y/o `budgetService.registerDeposit()` DEBEN recibir `ownerId: string` (no `string | undefined`) y cruzar por
  él antes de acreditar. PROHIBIDO acreditar una key sin verificar `owner_ref` del caller.
- **CD-2 (anti-replay — OBLIGATORIO)**: PROHIBIDO acreditar la misma tx de depósito más de una vez. La
  unicidad debe garantizarse a nivel DB (UNIQUE constraint), no solo a nivel app, y el check + crédito deben
  ser atómicos (resistente a requests concurrentes con el mismo txHash).
- **CD-3 (sin hardcodes — OBLIGATORIO)**: PROHIBIDO hardcodear treasury/recipient addresses, RPC URLs,
  token addresses o confirmaciones en la lógica. Todo desde env / config por chain (Golden Path + CLAUDE.md).
- **CD-4 (verify-before-credit — OBLIGATORIO)**: PROHIBIDO llamar `registerDeposit()` antes de que la
  verificación on-chain haya pasado. Cero crédito optimista en el fondeo (a diferencia del debit, que sí es
  optimista). El fondeo acredita SOLO con prueba on-chain confirmada.
- **CD-5 (chain match — OBLIGATORIO)**: el `chainId` que se acredita DEBE ser el del bundle resuelto/verificado
  on-chain, NUNCA un valor arbitrario del caller. PROHIBIDO acreditar `budget[chainId]` de una chain distinta a
  la de la tx verificada.
- **CD-6 (sin ethers.js, TS strict — OBLIGATORIO)**: cualquier lectura on-chain usa **viem** (Golden Path:
  prohibido ethers.js); sin `any` explícito ni `as unknown`.
- **CD-7 (no romper paths live — OBLIGATORIO)**: PROHIBIDO modificar el comportamiento del x402 per-request,
  del debit per-step o de `increment_a2a_key_spend`. El cambio de firma de `registerDeposit()` no debe afectar
  otros call-sites (verificar que `registerDeposit` no se invoca desde producción hoy — el endpoint está 501).

## Missing Inputs (a resolver en F2 / gate humano)
- **[NEEDS CLARIFICATION] Mecanismo de verificación (DT-1)**: ¿txHash + receipt (capacidad nueva, viem
  publicClient) o firma EIP-3009 → settle (reusa x402)? Bloqueante de diseño para F2.
- **[NEEDS CLARIFICATION] Recipient esperado (DT-2)**: ¿transfer directo a treasury/operator por chain, o
  contrato escrow? No se detectó escrow en el codebase.
- **[NEEDS CLARIFICATION] Confirmaciones/finalidad (DT-3)**: ¿1 confirmación (mined+success) o N configurable
  por chain?
- **[resuelto en F2] Forma del payload de `/deposit`**: campos exactos (txHash, chain, keyId/derivado del auth,
  amount declarado vs derivado on-chain) — los define el Architect según DT-1.
- **[resuelto en F2] Esquema anti-replay**: tabla vs columna, índices, atomicidad con el crédito (DT-4).
- *Nota: AskUserQuestion no está disponible en este subagente; estas 3 preguntas (DT-1/2/3) deben presentarse
  al humano en el gate HU_APPROVED o resolverse por el Architect en F2.*

## Análisis de paralelismo
- **Bloquea**: cualquier HU futura que dependa de "cargar saldo prepago real" (demos E2E de budget,
  settlement del 1% fee sobre budget prepago). Hoy nadie puede fondear, así que esta HU desbloquea el path (b).
- **No bloqueada por**: el debit per-step, x402 y multi-chain ya están DONE (_INDEX #086/#087/#093-095).
- **Paralelizable con**: trabajo de docs/observabilidad. NO paralelizar con otra HU que toque
  `a2a_agent_keys` schema, `budget.ts` o `auth.ts` (riesgo de colisión de migración + firma de servicio).
- **Dependencia externa**: si DT-1 elige txHash+receipt, depende de RPC confiable por chain (Kite/Avalanche/Base)
  — los RPC URLs ya existen en env (project-context + adapters). Si elige settle, depende del facilitator.

## Notas de contexto
- [SIN PRODUCT CONTEXT]: NO — `.nexus/product-context.md` existe y fue leído. El flujo "Identidad y créditos
  (economía agentica)" §3 confirma "Deposita créditos (pre-pago)… cobro antes de ejecución, refund si falla";
  esta HU implementa la parte de **depósito** que hoy falta. El principio "cobro antes de ejecución" aplica al
  debit, NO al fondeo (el fondeo acredita post-verificación — CD-4).
- project-context.md está desactualizado (fechado 2026-03-31, solo menciona Kite) pero el codebase es multi-chain
  (Kite/Avalanche/Base). NO se reescribe en esta HU (fuera de scope y riesgoso); se deja nota para una HU de docs.
