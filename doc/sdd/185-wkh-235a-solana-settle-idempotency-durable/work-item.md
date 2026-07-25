# Work Item — [WKH-235a] Idempotencia durable del settle Solana (dedup cross-proceso por intentId)

## Resumen
Cierra el follow-up AR-1 declarado en `doc/sdd/182-wkh-234-solana-payment-adapter/auto-blindaje.md:84-87` y `done-report.md:127` de WKH-234, clasificado MENOR solo por ser devnet/USDC-test pero identificado como el follow-up de mayor exposición financiera pendiente. Hoy la deduplicación del settle Solana (`src/adapters/solana/payment.ts`) vive en un `Map` in-memory por proceso, escrito DESPUÉS de `sendAndConfirmTransaction` y consultado ANTES de broadcastear — dos huecos de doble-pago: (1) `sendAndConfirmTransaction` lanza timeout pero la tx igual se confirmó on-chain → nunca se alcanza la línea que persiste en el Map; (2) restart del proceso entre el settle original y un reintento → el Map se pierde. Esta HU: (a) cierra el hueco #1 en la raíz (verificar la tx por firma antes de declarar fallo), (b) persiste la idempotencia en el ledger durable (`a2a_receipts`), y (c) hace que el `intentId` sea determinístico/estable entre ejecuciones cuando el caller lo pide — sin lo cual la persistencia durable no sirve de nada contra el hueco #2.

## Sizing
- SDD_MODE: full
- Estimación: L
- Branch sugerido: `fix/185-wkh-235a-solana-settle-idempotency-durable`

## Hallazgos de F0 (evidencia, no opinión)

1. **`intentId` HOY es `${composeRunId}:${stepIndex}`** (`src/services/compose.ts:116` `const composeRunId = randomUUID();`, generado UNA VEZ por ejecución de `compose()`; usado en `compose.ts:306` para el intento master y `compose.ts:476` para el retry adaptativo PASO-5 — MISMO `composeRunId`, así que **es estable dentro de la MISMA ejecución de `compose()`** entre el intento master y su retry in-process).
   **NO es estable entre ejecuciones**: cada llamada HTTP nueva a `/compose` (o cada invocación de `orchestrateService` que llame a `compose()`) genera un `randomUUID()` nuevo. Verificado que no existe hoy ningún concepto de idempotency-key aceptado del caller: `src/middleware/request-id.ts` (`genReqId = () => crypto.randomUUID()`) SIEMPRE genera, nunca lee un header entrante; no existe `x-idempotency-key` ni equivalente en el repo (`Glob src/**/*idempot*` → 0 resultados).
   **Consecuencia**: aunque persistamos el Map en DB, un reintento que llegue por una NUEVA request HTTP (el escenario "restart del gateway entre el settle original y el retry" del brief) tendrá un `intentId` distinto y el dedup durable NO lo va a encontrar. La persistencia durable por sí sola es necesaria pero INSUFICIENTE — confirma la sospecha del brief.

2. **El `intentId` NO se persiste hoy, solo la firma.** La migración de WKH-234 (`supabase/migrations/20260724000000_wkh234_receipt_solana_caip2.sql`) agregó `settle_caip2` y `settle_signature` a `a2a_receipts`, ambas NULL para EVM. NO existe columna `settle_intent_id`. Sin ella, ningún lookup "¿ya existe una firma confirmada para este intentId?" es posible. **Esta HU debe agregar esa columna** (migración aditiva, mismo patrón que WKH-234).

3. **El bug de raíz #1 es independiente de todo lo anterior.** `src/adapters/solana/payment.ts:164-174`: `sendAndConfirmTransaction` puede lanzar (p. ej. `TransactionExpiredTimeoutError`) DESPUÉS de que la tx ya fue confirmada on-chain — la firma de una transacción Solana es determinística/derivable ANTES del broadcast (no depende de la confirmación), así que HOY se descarta esa firma y el catch de `settleSolanaLeg` (`src/lib/downstream-payment.ts:188-194`) la traga como `SETTLE_FAILED` silencioso (nunca re-lanza — `signAndSettleDownstream` es NEVER-throws por diseño, CD-7 de WKH-55/234). **Hallazgo importante**: revisando el pipeline de reintentos existente en `compose.ts` (PASO 2-6, `willRetry`/`missingFields`), el retry adaptativo SOLO se dispara cuando `invokeAgent` lanza por un fallo del **upstream HTTP call al agente** (field-errors parseables de un 4xx) — el settle downstream ocurre DESPUÉS de que ese call ya tuvo éxito, y un fallo de `signAndSettleDownstream` NUNCA hace que `invokeAgent` lance (retorna `{output, txHash}` sin `downstream`). **Conclusión: hoy NO existe ningún mecanismo que reintente un settle Solana fallido con el mismo intentId** — el escenario 1 del brief (retry del mismo step/intentId tras un timeout) presupone un mecanismo de reintento de settle que todavía no existe en el código. Esto redefine la prioridad: el fix de más alto valor y menor riesgo es el #1 (resolver el timeout ANTES de declarar fallo, sin re-broadcastear NUNCA), y la persistencia durable + intentId determinístico son la defensa en profundidad para cuando SÍ haya un reintento (interno futuro, o un cliente que reintenta la request completa).

4. **Ownership**: `a2a_receipts` no está en la tabla de "tablas con ownership en app-layer" de `CLAUDE.md` (esa lista cubre `a2a_agent_keys`/`tasks`), pero el propio `src/services/receipt.ts` YA aplica el mismo patrón por convención (`list()` y `getById()` filtran `.eq('owner_ref', ownerRef)`, `receipt.ts:273` y `:293`). El nuevo lookup de dedup DEBE seguir la misma convención (`.eq('settle_intent_id', intentId).eq('owner_ref', ownerRef)`) — si no, un caller podría (en teoría, vía un intentId adivinado/colisionado) leer la firma confirmada de OTRO owner.

5. **`SolanaSettleRequest`** (`src/adapters/types.ts:107-111`) no tiene ningún campo para recibir una firma-candidata desde afuera; el adapter (`src/adapters/solana/payment.ts`) es el ÚNICO lugar donde hoy se decide "hay un settle previo válido, no re-broadcastees" (líneas 118-134, el seam DT-10/AC-7 de W3). `src/adapters/solana/*` NO puede importar services/DB (CD-7, infra pura) — por eso WKH-234 diefirió este fix.

6. **`src/lib/downstream-payment.ts` es la capa de wiring** ("chain-aware thin orchestrator", ver su doc comment) — ya importa de `../adapters/registry.js`/`../adapters/chain-resolver.js`, no importa NADA de `src/services/`. `src/lib/supabase.ts` SÍ vive en `src/lib/` y `src/services/*` importan de `src/lib/*` (no al revés) — inyectar un import de `src/services/receipt.ts` en `downstream-payment.ts` compilaría e no crearía ciclo, pero invertiría la dirección de dependencia típica del repo (lib → services). Se deja como decisión de F2 (ver DT-2) si el lookup vive en `compose.ts` (services, ya importa `receiptService`/`budgetService`) inyectado hacia abajo como dato plano, o si se acepta el import lib→services en `downstream-payment.ts`.

7. **`/orchestrate/execute`** (`src/routes/orchestrate.ts:31-38`) YA exige que el cliente reenvíe un `orchestrationId` estable (two-phase plan→execute, WKH-13/WKH-131) — a diferencia de `/compose` (one-shot, sin esa ancla). Esto es relevante para el DT-4 (intentId determinístico): `/orchestrate` puede reusar `orchestrationId` como semilla de `composeRunId` sin inventar un header nuevo; `/compose` no tiene ningún ancla equivalente hoy.

## Acceptance Criteria (EARS)

- AC-1: WHEN `sendAndConfirmTransaction` lanza una excepción (p. ej. timeout) Y la transacción de todas formas se confirma on-chain (verificable por firma vía `getSignatureStatus`/`getParsedTransaction`), the system SHALL retornar `{success:true, txHash:<firma confirmada>}` en vez de propagar el error / declarar `SETTLE_FAILED`.
- AC-2: IF `sendAndConfirmTransaction` lanza Y la transacción NO se confirma on-chain (fallo real), THEN the system SHALL seguir retornando el error tal como hoy (sin regresión del camino de fallo genuino).
- AC-3: WHEN existe un registro durable (`a2a_receipts.settle_intent_id`) con una firma para el `intentId` del leg actual, the system SHALL re-verificar esa firma on-chain (`adapter.verify`) y, si es válida, retornar esa firma SIN re-broadcastear un nuevo SPL-transfer.
- AC-4: WHILE el `intentId` de un leg es nuevo (sin registro previo, durable ni in-memory) Y los datos de settle son válidos, the system SHALL ejecutar el settle Solana normalmente (broadcast + confirm), sin falso-positivo de dedup.
- AC-5: WHILE el intento master y el retry adaptativo PASO-5 de `compose.ts` ocurren dentro de la MISMA ejecución de `compose()` (mismo `composeRunId`), the system SHALL seguir deduplicando el settle Solana por intentId al menos tan bien como hoy (sin regresión del seam DT-10/AC-7 de WKH-234).
- AC-6: WHERE el caller de `POST /compose` envía el header `x-idempotency-key` (no vacío), the system SHALL derivar `composeRunId` de ese valor (determinístico) en vez de `randomUUID()`, de forma que reenviar la MISMA request con la MISMA key produzca el MISMO `intentId` por step.
- AC-7: WHERE el caller de `POST /compose` NO envía `x-idempotency-key`, the system SHALL derivar `composeRunId` exactamente como hoy (`randomUUID()`) — comportamiento byte-idéntico para callers existentes (Chaski, remit-agents, tests).
- AC-8: THE system SHALL persistir `settle_intent_id` junto con `settle_signature`/`settle_caip2` en `a2a_receipts` para todo settle Solana confirmado (aditivo, NULL para legs EVM — sin cambio de columna existente).
- AC-9: WHEN el wiring hace el lookup de dedup durable, the system SHALL filtrar por `settle_intent_id` Y `owner_ref` del caller autenticado (ownership guard) — nunca por `settle_intent_id` solo.
- AC-10: IF el settle Solana es re-invocado con un `intentId` cuyo lookup durable falla (error de DB, timeout, etc.), THEN the system SHALL degradar de forma fail-safe según lo que decida F2 (ver DT-5 — [NEEDS CLARIFICATION]: fail-open a un settle fresco como hoy, vs. fail-closed devolviendo `SETTLE_FAILED` para no arriesgar un doble-pago silencioso — el patrón mainnet fail-closed de WKH-144/150 es el precedente más cercano).
- AC-11: THE path EVM (Avalanche/Base/Kite — `signAndSettleDownstream` líneas 294-509 de `downstream-payment.ts`) SHALL permanecer byte-idéntico: ningún parámetro/columna nuevo lo afecta, ningún test EVM existente cambia de comportamiento.
- AC-12: THE ownership guard existente (`.eq('owner_ref', ...)` en `budgetService`/`receiptService`) SHALL permanecer intacto — ninguna query nueva sobre `a2a_agent_keys` se introduce en esta HU (el lookup nuevo es sobre `a2a_receipts`, no sobre `a2a_agent_keys`).

## Scope IN
- `src/adapters/solana/payment.ts` — self-heal del timeout de `sendAndConfirmTransaction` (AC-1/AC-2); extender `settle()` para considerar una firma-candidata inyectada (hint) además del Map in-memory, reusando el bloque verify-before-trust ya existente (líneas 118-134).
- `src/adapters/types.ts` — `SolanaSettleRequest` += campo opcional para la firma-candidata (dato plano, sin tipos de DB — CD-7).
- `src/lib/downstream-payment.ts` — `settleSolanaLeg` / `signAndSettleDownstream`: threadear el nuevo parámetro hacia el adapter (decisión final del punto de wiring en DT-2).
- `src/services/compose.ts` — `composeRunId` derivado de `x-idempotency-key` cuando está presente (AC-6/AC-7); lookup de dedup durable antes de cada intento de settle (master y retry PASO-5); disparar la persistencia del `intentId`+firma tan pronto como se conoce (no diferido al post-procesamiento best-effort actual de `recordSolanaLegIfAny`).
- `src/services/receipt.ts` — nuevo método de lectura (p. ej. `findConfirmedSolanaSettle(ownerRef, intentId)`) con ownership guard (AC-9); `emit`/`recordSolanaSettleReceipt` extendido para escribir `settle_intent_id`.
- `src/types/receipt.ts` — `EmitReceiptInput`/`ReceiptRow` += `settleIntentId?` / `settle_intent_id`.
- `src/types/index.ts` — `ComposeRequest` += `idempotencyKey?: string` (o equivalente).
- `src/routes/compose.ts` — leer header `x-idempotency-key`, threadear a `composeService.compose()`.
- `supabase/migrations/<timestamp>_wkh235a_receipt_settle_intent_id.sql` (+ `_down.sql`) — columna aditiva `settle_intent_id text NULL` en `a2a_receipts`, índice para el lookup (por `owner_ref` + `settle_intent_id`).
- Tests: `src/adapters/solana/payment.test.ts`, `src/lib/downstream-payment.test.ts`, `src/services/compose.test.ts`, `src/services/receipt.test.ts`, `src/routes/compose.test.ts` (todos ya existen — extender, no crear módulos de test nuevos salvo que F2 lo justifique).

## Scope OUT
- Mainnet Solana (sigue devnet-only, CD-4 heredado de WKH-234 — `ChainKey` no gana ningún sufijo `-mainnet` en esta HU).
- Cambios al path EVM (Avalanche/Base/Kite) — cero nuevo comportamiento, cero nuevos parámetros que lo alcancen.
- `POST /orchestrate` / `/orchestrate/execute`: NO se agrega `x-idempotency-key` ahí en esta HU. F0 encontró que `/orchestrate/execute` YA tiene una ancla estable reusable (`orchestrationId` reenviado por el cliente, `routes/orchestrate.ts:31-38`) — evaluar en una HU separada si conviene reusarla como semilla de `composeRunId` cuando `orchestrateService` llama a `compose()` internamente. Mezclar ambos rutas en esta HU expande el blast radius sin necesidad.
- Balance pre-check Solana (el otro deferral de WKH-234, distinto de este) — Scope OUT explícito, HU propia.
- Cualquier mecanismo NUEVO de reintento automático de un settle Solana fallido (p. ej. un "settle reconciliation engine" al estilo WKH-191c) — el hallazgo #3 de F0 muestra que HOY no existe ninguno; esta HU deja el sistema LISTO para que uno futuro sea seguro (durable + dedup), pero construir ese reintentador es una HU aparte.
- Migrar el `intentId` fallback de `settleSolanaLeg` (`${agent.slug}:${payTo}`, `downstream-payment.ts:178`, usado solo cuando el caller no pasa `intentId` — hoy `compose.ts` SIEMPRE lo pasa, así que es dead-path en producción) — no se toca salvo que F2 detecte que interfiere.

## Decisiones técnicas (DT-N)

- **DT-1 (arquitectura — opción elegida):** el fix respeta CD-7 (adapters `src/adapters/solana/*` sin DB/services) inyectando la firma-candidata como un **dato plano** (`priorSignatureHint?: string`) en `SolanaSettleRequest`, en vez de una interfaz Port/DI completa (opción (b) del brief). El adapter reusa su bloque verify-before-trust EXISTENTE (líneas 118-134 de `payment.ts`, seam DT-10/AC-7 de WKH-234) para decidir si la firma-hint sigue siendo válida — cero lógica nueva de confianza, solo una segunda fuente de "prior" además del Map in-memory. Minimiza superficie: NO se crea ningún módulo `domain/ports` nuevo, NO se cambia la forma en que se construyen los `AdaptersBundle` en el registry. Rechazada la opción (b) completa por sobre-ingeniería para el mismo resultado.
- **DT-2 (punto de wiring del lookup — abierto para F2):** el lookup durable (`receiptService.findConfirmedSolanaSettle`) debe vivir en una capa que YA tenga `ownerRef`/`chainId` (services). Dos alternativas equivalentes en seguridad, distintas en layering: (a) `compose.ts` hace el lookup y pasa el resultado como dato plano hacia abajo (`invokeAgent` → `signAndSettleDownstream` → `settleSolanaLeg` → `adapter.settle`) — mantiene `src/lib/downstream-payment.ts` con CERO imports de `services/`; (b) `downstream-payment.ts` importa `receiptService` directamente — compila sin ciclo (`receipt.ts` no importa `downstream-payment.ts`) pero invierte la dirección típica lib→services del repo. Recomendación: (a), por consistencia con el resto del código (`downstream-payment.ts` se autodescribe como "thin orchestrator" sin estado ni I/O propio más allá del adapter). Architect debe confirmar en F2.
- **DT-3 (persist-before-return, estilo WKH-191b):** la escritura del `intentId`+firma en `a2a_receipts` debe dispararse tan pronto como la firma es conocida como confirmada (dentro de `settleSolanaLeg`/inmediatamente después, NO diferida al `recordSolanaLegIfAny` best-effort actual de `compose.ts:288-299`, que corre recién después de `finishSuccessfulStep`). Si la escritura sigue siendo estrictamente fire-and-forget (no-await), existe una ventana en la que un segundo intento concurrente/rápido con el mismo intentId no encuentre el registro aún — F2 debe decidir si esta escritura específica de dedup se AWAITEA (aceptando latencia extra en el settle) o se acepta la ventana como riesgo residual documentado (defensa en profundidad, no la única barrera — AC-1 ya cierra la causa más probable en la raíz).
- **DT-4 (intentId determinístico — el cambio de fondo):** `composeRunId` pasa a derivarse de un `x-idempotency-key` opcional del caller cuando está presente (AC-6), preservando `randomUUID()` como default (AC-7). Se descarta derivar el intentId de forma puramente content-based (hash de owner+agente+monto+step, sin nonce del caller) porque colisionaría dos cargos LEGÍTIMOS y consecutivos al mismo agente por el mismo monto, negando el segundo pago silenciosamente — un idempotency-key opt-in (patrón estándar tipo Stripe) es la única forma honesta de distinguir "reintento de la misma operación" de "operación nueva idéntica" sin inventar contexto que el caller no proveyó.
- **DT-5 [NEEDS CLARIFICATION]:** comportamiento fail-open vs. fail-closed cuando el lookup durable de dedup falla (DB caída/timeout) — ver AC-10. No hay evidencia suficiente en F0 para decidir sin involucrar al Architect/Adversary (mismo tipo de decisión que motivó el fail-closed mainnet de WKH-144/150).

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO que `src/adapters/solana/*` importe cualquier símbolo de `src/services/*` o `src/lib/supabase.ts` — el fix vive en dato plano inyectado (DT-1), NUNCA en un import de DB dentro del adapter.
- CD-2: OBLIGATORIO que el path EVM (`signAndSettleDownstream` ramas no-Solana, todos los adapters EVM) quede byte-idéntico — cualquier diff de comportamiento/output en tests EVM existentes es BLOQUEANTE en AR/CR.
- CD-3: OBLIGATORIO ownership guard en el nuevo lookup durable: toda query sobre `a2a_receipts` para dedup DEBE filtrar por `owner_ref` del caller autenticado además de `settle_intent_id` (AC-9) — mismo patrón que `receiptService.list()`/`getById()`.
- CD-4: PROHIBIDO hardcodear el `x-idempotency-key` o cualquier semilla del `composeRunId` — el valor viene 100% del header del caller o de `randomUUID()`, sin defaults mágicos ni valores fijos de test filtrados a producción.
- CD-5: OBLIGATORIO que la migración SQL sea aditiva (`ADD COLUMN IF NOT EXISTS ... NULL`), reversible (`_down.sql`), y NO toque `insert_receipt`/`debit_with_dest_policy` ni ninguna otra RPC del money-path existente — mismo patrón que la migración de WKH-234.
- CD-6: PROHIBIDO expandir esta HU a mainnet Solana o a `/orchestrate` — cualquier tentación de "ya que estamos" se marca como follow-up, no se implementa acá (Scope OUT explícito).

## Missing Inputs
- [resuelto en F2] DT-2 — punto exacto de wiring del lookup (compose.ts vs. downstream-payment.ts).
- [resuelto en F2] DT-3 — awaited vs. fire-and-forget de la escritura de dedup.
- [bloqueante, requiere Architect/Adversary] DT-5 — fail-open vs. fail-closed del lookup durable ante fallo de DB (AC-10).
- [resuelto en F2] Nombre exacto del método nuevo de `receiptService` y de la columna del índice (`settle_intent_id` + `owner_ref` compuesto vs. solo `settle_intent_id` con filtro app-layer).

## ¿Se puede completar y testear 100% con mocks (sin devnet real ni credenciales)?
**Sí, el código y TODOS los tests automatizados son 100% mockeables.** Evidencia: `src/adapters/solana/payment.test.ts` y `src/lib/downstream-payment.test.ts` ya existen y mockean `@solana/web3.js` (Connection/sendAndConfirmTransaction/getParsedTransaction) sin tocar devnet real (mismo patrón que WKH-234 W3). `src/services/compose.test.ts`/`receipt.test.ts`/`routes/compose.test.ts` mockean el cliente Supabase (mismo patrón usado en todo `budget.test.ts`/`receipt.test.ts` existentes) — no requieren una DB real para el unit-test suite. El único paso que SÍ requiere credenciales/infra real es **aplicar la migración SQL contra la DB dev (bdwv)**, exactamente el mismo paso "PENDING-DEPLOY" que todas las HUs de la Wave 0/1 de WKH-191 y WKH-234 ya dejaron pendiente — es un paso operacional post-merge, no un bloqueante de desarrollo/test. No se necesita nada del founder para completar F3/AR/CR/F4 de esta HU.

## Análisis de paralelismo
- No bloquea ni es bloqueada por WKH-237 (fila 183, ERC-8004 Avalanche) ni WKH-241 (fila 184, expose payment spec) — archivos disjuntos.
- Comparte archivos con el resto de la línea Solana WKH-234 (`payment.ts`, `downstream-payment.ts`, `compose.ts`, `types.ts`) pero WKH-234 ya está DONE (merged 8da3560) — sin conflicto de rama activo.
- Toca `a2a_receipts` (tabla compartida con el sistema de recibos WKH-124 y el leg Solana WKH-234) de forma puramente aditiva — no compite con ninguna HU en curso sobre esa tabla al momento de este work-item.
- Puede ir en paralelo con cualquier HU que NO toque `src/adapters/solana/*`, `src/lib/downstream-payment.ts`, `src/services/compose.ts`, `src/services/receipt.ts` o `a2a_receipts`.
- Depende operacionalmente (no de código) de que la migración de WKH-234 (`settle_caip2`/`settle_signature`) ya esté aplicada en el entorno destino antes de aplicar la nueva — según _INDEX.md fila 182, ya está aplicada en bdwv.

---

## RE-SCOPE del orquestador (2026-07-25)

Decisión del orquestador ANTES de F3: se implementa un subconjunto acotado de este work-item. La razón es el propio **hallazgo #3 de F0**: hoy **ningún mecanismo reintenta un settle Solana fallido con el mismo `intentId`** (el retry adaptativo de `compose.ts` sólo se dispara por fallos del *upstream call al agente*, nunca del settle downstream), y el `intentId` (`compose.ts:116`, `randomUUID()` por ejecución) es estable sólo dentro de la misma ejecución de `compose()`. Es decir: el escenario "doble pago por dedup in-memory perdido tras restart" **no es alcanzable automáticamente hoy**. Construir dedup durable + `x-idempotency-key` + migración SQL ahora agrega superficie grande (10 archivos, DB, ruta HTTP, tipos) para mitigar un riesgo que ningún camino de código puede disparar todavía.

### IN (implementado en F3 — branch `fix/185-solana-settle-signature-recovery`)

1. **Recuperación de la firma tras fallo de confirmación** (`src/adapters/solana/payment.ts`) — el bug real y presente: `sendAndConfirmTransaction` puede lanzar (timeout / blockhash expirado) **con la tx YA confirmada on-chain**; hoy el gateway declara `SETTLE_FAILED` y pierde la firma de un pago que ocurrió (fee pagado on-chain, sistema cree que no → bug de contabilidad, sin recibo, `intentId` sin firma). Ahora: al fallar, se deriva la firma-candidata (campo `signature` de los `TransactionExpired*Error` de `@solana/web3.js`, o el Buffer `Transaction.signature` de la tx firmada in-place) y se re-verifica on-chain **reusando el `verify()` existente** (monto/mint/destino — sin duplicar validación). Si es válida → settle exitoso con esa firma + registro en `_intentSignatures`. Si no → se propaga el error original, sin regresión. NUNCA re-broadcastea.
2. **Observabilidad del skip `FLAG_OFF`** (`src/lib/downstream-payment.ts`) — hallazgo de F4 de WKH-241: con `WASIAI_DOWNSTREAM_X402` apagada la función retornaba `null` sin ningún log (única de las 4 piezas del checklist de activación Solana que fallaba sin rastro). Ahora emite un `logger.info({ code:'FLAG_OFF' })` **warn-once por proceso** (el flag se lee una vez al cargar el módulo; mismo patrón que `avalanche/payment.ts` / `discovery.ts`). Comportamiento idéntico: sigue devolviendo `null` sin resolver adapters.

### DIFERIDO (NO implementado en F3)

- **Dedup durable cross-proceso** en `a2a_receipts` (`settle_intent_id` + lookup con ownership guard) y su **migración SQL** (+`_down.sql`).
- **`intentId` determinístico** derivado de un `x-idempotency-key` opcional en `POST /compose` (`routes/compose.ts`, `types/index.ts`, `services/compose.ts`).
- Los cambios asociados en `src/services/receipt.ts`, `src/types/receipt.ts`, `src/adapters/types.ts` (`priorSignatureHint`) y `src/lib/downstream-payment.ts` (threading del hint).

**Condición de reactivación (no es "nunca", es "todavía no"):** implementar esto **antes de mainnet / dinero real**, o **en cuanto exista un reintentador de settles** (p. ej. un reconciliation engine estilo WKH-191c, un retry de settle downstream en `compose.ts`, o un cliente que reintente la request completa con una idempotency-key). Mientras el settle Solana sea devnet/USDC-test y no exista ningún reintentador, la defensa que importa es la de la raíz (AC-1/AC-2), ya cubierta.

### Cobertura de los ACs originales

| AC | Estado tras F3 | Nota |
|----|----------------|------|
| AC-1 | **CUBIERTO** | recuperación de la firma confirmada tras el throw (`payment.ts`, `recoverConfirmedSettle`) |
| AC-2 | **CUBIERTO** | tx no confirmada / inválida / sin firma derivable → se propaga el error como hoy |
| AC-3 | DIFERIDO | requiere el registro durable en `a2a_receipts` |
| AC-4 | **CUBIERTO (sin cambios)** | intentId nuevo → settle normal; ningún falso-positivo de dedup introducido |
| AC-5 | **CUBIERTO (sin regresión)** | el seam in-memory DT-10/AC-7 de WKH-234 sigue intacto y ahora también se pobla en el camino recuperado |
| AC-6 | DIFERIDO | `x-idempotency-key` en `/compose` |
| AC-7 | **CUBIERTO por construcción** | `composeRunId` sigue siendo `randomUUID()` — cero cambios para callers existentes |
| AC-8 | DIFERIDO | columna `settle_intent_id` (migración) |
| AC-9 | DIFERIDO (N/A hoy) | no se agrega ninguna query nueva sobre `a2a_receipts` |
| AC-10 | DIFERIDO (DT-5 sigue abierto) | no hay lookup durable que pueda fallar |
| AC-11 | **CUBIERTO** | path EVM byte-idéntico: el único cambio compartido es el log warn-once del skip `FLAG_OFF` (pre-adapter, sin efecto en el settle EVM) |
| AC-12 | **CUBIERTO** | cero queries nuevas sobre `a2a_agent_keys` |

**Nuevo AC implícito de F3 (observabilidad):** WHEN `WASIAI_DOWNSTREAM_X402` no está en `'true'`, the system SHALL loguear el skip `FLAG_OFF` (una vez por proceso) y SHALL seguir retornando `null` sin resolver ningún adapter.

Constraint Directives respetadas tal cual: **CD-1** (el adapter no importa `services/*` ni `lib/supabase.ts` — el fix vive 100% dentro de `src/adapters/solana/payment.ts`), **CD-2** (EVM byte-idéntico), **CD-6** (nada de mainnet ni `/orchestrate`). CD-3/CD-4/CD-5 no aplican al scope reducido (no hay query nueva, ni header nuevo, ni migración).
