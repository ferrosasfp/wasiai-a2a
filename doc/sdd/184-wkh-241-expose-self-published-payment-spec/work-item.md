# Work Item — [WKH-241] Exponer el payment spec declarado de los agentes self-published

## Resumen

Los agentes self-published `remit-corridor-fx-solana` y `remit-cashout-payout-solana` (Solana LATAM
Labs, WKH-235/236) ya están registrados en `a2a_agents` con `metadata.payment = {method:'x402',
chain:'solana-devnet', contract:'<base58>', asset:'USDC'}` y `payout_wallet` base58, pero
`/discover` los devuelve con `payment: undefined` porque el mapper de agentes self-published
(`mapRowToAgent`, `src/services/agent.ts:112-131`) nunca setea el campo `Agent.payment` — solo el
mapper de registries externos federados lo hace (`readPayment`, `discovery.ts:71-119`, usado en
`mapAgent:611`). Consecuencia: el fee de estos agentes se cobra hoy por la chain default del
gateway en lugar de Solana devnet. Esta HU cierra ese gap de lectura, reusando la MISMA validación
defensiva de chain que ya protege a los registries externos (WKH-113 SEC-AR BLQ-MED-1), sin
duplicar el validador.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Riesgo: FAST+AR (toca el money-path — decide en qué chain se liquida el fee de un agente — pero
  es un cambio chico, aditivo y de lectura pura)
- Branch sugerido: `feat/184-wkh-241-expose-self-published-payment-spec`

## Contexto verificado (F0)

- `mapRowToAgent` (`src/services/agent.ts:112-131`) construye el `Agent` de los self-published
  SIN el campo `payment` (grep confirmado: `payment` no aparece en `agent.ts`).
- `readPayment` (`src/services/discovery.ts:71-119`) es la ÚNICA función que hoy sabe parsear un
  payment spec de forma segura: valida `method`/`chain`/`contract` presentes, y rechaza cualquier
  `chain` que `normalizeChainSlug` (`src/adapters/chain-resolver.ts`) no reconozca ANTES de
  normalizar (WKH-113 SEC-AR BLQ-MED-1 — defensa contra un registry comprometido que declare una
  chain exótica). Es privada de `discovery.ts`, usada solo en `mapAgent` (external registries,
  `discovery.ts:611`).
- El settle downstream (`signAndSettleDownstream`, `src/lib/downstream-payment.ts:233-298`) SÍ
  está listo para Solana: resuelve `chainKey = normalizeChainSlug(agent.payment.chain)`
  (`:271`), y si `getPaymentAdapterOrUnion(chainKey).vmFamily === 'solana'` (`:290-293`) delega a
  `settleSolanaLeg` (`:124-210`), que valida el `payTo` base58 con `isValidSolanaAddress`
  (`wallet-format.ts:42-63`) y liquida un SPL-transfer real vía el adapter Solana (WKH-234,
  flag `SOLANA_ADAPTER_ENABLED`). **Confirmado: exponer `agent.payment` con
  `chain:'solana-devnet'` es SUFICIENTE para que el fee de estos 2 agentes se enrute al rail
  Solana** — no falta ninguna otra pieza de código en el settle.
- `agent-card.ts` (`buildAgentCard`/`AgentCard`) **NO** serializa `agent.payment` en ningún lado —
  el `payment` solo importa para el `Agent[]` interno que consume `compose.ts` →
  `signAndSettleDownstream`. Confirmado leyendo el archivo completo: cero referencias a
  `.payment`. Scope OUT sin gap.
- `payout_wallet` (columna de `a2a_agents`, WKH-143b/234) es un campo DISTINTO: alimenta el
  creator-split del 1% de protocol fee (`resolveAgentSplitContext` → `fee-split.ts`), NO el payTo
  del downstream x402 del precio COMPLETO del agente. Confundirlos redirigiría todo el fee de
  servicio del agente a una wallet pensada solo para una fracción del 1%. `agent.payment` se
  deriva SOLO de `metadata.payment` explícito (ver DT-2).
- No existe hoy un write-path API (`POST`/`PATCH /agents`) que acepte un campo `payment` genérico
  — `buildMetadata`/`update()` (`agent.ts:159-171`, `:538-553`) solo mergean
  `inputSchema`/`outputSchema`/`discoverable`. Los 2 agentes target ya tienen `metadata.payment`
  seedeado por otra vía (fuera de este repo/HU). Ver Missing Inputs.
- `validatePayTo` (EVM, `downstream-payment.ts:98-110`) e `isValidSolanaAddress` (Solana,
  `settleSolanaLeg:131-138`) YA rechazan un `payTo` con formato inválido en settle-time con
  skip-codes (`INVALID_PAY_TO_FORMAT`/`ZERO_PAY_TO`), SIN mover fondos. Este guard es preexistente
  y no requiere cambios.

## Acceptance Criteria (EARS)

- AC-1: WHEN un agente self-published tiene `metadata.payment` con `method`/`chain`/`contract`
  presentes y `chain` resuelve a una `ChainKey` conocida vía `normalizeChainSlug` (p.ej.
  `solana-devnet`), the system SHALL exponer `Agent.payment` en la respuesta de `/discover` y de
  `getAgent` con el mismo shape `AgentPaymentSpec` (`method`, `chain`, `contract`, `asset?`) que
  hoy exponen los registries federados.
- AC-2: WHILE un agente self-published NO declara `metadata.payment` (el caso de la inmensa
  mayoría hoy), the system SHALL mantener `Agent.payment` ausente, produciendo un `/discover`
  byte-idéntico al comportamiento actual — CERO regresión.
- AC-3: IF `metadata.payment.chain` no resuelve a una `ChainKey` conocida (chain exótica o
  desconocida), THEN the system SHALL omitir `Agent.payment` para ese agente por completo, SIN
  fallback silencioso a la chain default del gateway — mismo criterio defensivo que WKH-113
  SEC-AR BLQ-MED-1.
- AC-4: the system SHALL derivar `Agent.payment` (tanto para registries externos como para
  self-published) desde UNA SOLA función compartida — prohibido un segundo validador paralelo de
  chain (mismo criterio que `wallet-format.ts:8-12` aplica al formato EVM/Solana).
- AC-5: IF `payment.contract` declarado tiene formato inválido para su familia (EVM `0x`+40-hex,
  Solana base58 de 32 bytes), THEN el downstream settle SHALL seguir rechazándolo con el
  skip-code existente (`INVALID_PAY_TO_FORMAT`/`ZERO_PAY_TO`, `downstream-payment.ts`) sin mover
  fondos — comportamiento YA existente, preservado sin cambios de código en esta HU (ver DT-3).
- AC-6: the system SHALL mantener el settle de los agentes EVM existentes (remit-* Fuji,
  self-published sin `metadata.payment`) exactamente igual a hoy — `agent.payment` ausente ⇒
  fee cobrado por la chain default del gateway, sin cambios de comportamiento.

## Scope IN

- `src/lib/payment-spec-reader.ts` — **NUEVO** módulo leaf puro. Extrae `readPayment` de
  `discovery.ts` (renombrado `readPaymentSpec` o mantiene el nombre, a decidir en F2), sin
  cambios de comportamiento. Depende SOLO de `normalizeChainSlug`
  (`../adapters/chain-resolver.js`, ya puro) — cero imports de servicios (evita el ciclo
  agent.ts↔discovery.ts, ver DT-1).
- `src/services/discovery.ts` — `readPayment` (líneas 71-119) se reemplaza por un import del
  módulo nuevo; `mapAgent:611` sin cambio de comportamiento observable.
- `src/services/agent.ts` — `mapRowToAgent` (líneas 112-131) agrega
  `payment: readPaymentSpec(readMetadataObject(row.metadata))`.
- Tests: casos AC-1..AC-3, AC-4, AC-6 en `test/services/agent.test.ts` (o
  `discovery.test.ts` si se testea vía el pipeline completo) — incluye el caso de no-regresión
  (agente sin `metadata.payment` ⇒ JSON idéntico a hoy) y el caso de chain desconocida.

## Scope OUT

- Write-path API (`POST`/`PATCH /agents` aceptando un campo `payment`/`metadata.payment`
  arbitrario) — los 2 agentes target ya tienen el campo seedeado por otra vía. Follow-up sugerido
  (WKH-241 o similar) si se necesita que futuros agentes Solana self-published lo declaren vía
  API en vez de una escritura directa en DB.
- Activar `SOLANA_ADAPTER_ENABLED=true` y `WASIAI_DOWNSTREAM_X402=true` en el gateway deployado
  (Railway) — es CONFIG/OPS founder-gated, no código (ver sección final).
- Cambios en `downstream-payment.ts`, `wallet-format.ts`, `chain-resolver.ts`, `adapters/registry.ts`
  — ya completos (WKH-234/WKH-113), sin cambios necesarios.
- `agent-card.ts` / `AgentCard` — confirmado en F0 que no serializa `payment`; no hay gap.
- Cualquier validación NUEVA de formato de `payment.contract` en discovery-read-time (más allá de
  la que ya existe en settle-time) — ver DT-3, se prefiere no duplicar el guard existente.

## Decisiones técnicas (DT-N)

- **DT-1**: extraer `readPayment` a un módulo leaf nuevo (`src/lib/payment-spec-reader.ts`) en
  vez de exportarlo directamente desde `discovery.ts` para que `agent.ts` lo importe. Razón:
  `discovery.ts` ya importa `publishedAgentService` de `agent.ts` (`discovery.ts:23`) — si
  `agent.ts` importara de vuelta desde `discovery.ts` se crearía un ciclo de módulos. Un módulo
  leaf nuevo (mismo patrón que `wallet-format.ts`/`chain-resolver.ts`/`price.ts`) resuelve esto
  sin duplicar lógica.
- **DT-2**: `Agent.payment` se deriva EXCLUSIVAMENTE de `metadata.payment` explícito — NUNCA se
  auto-deriva de las columnas `payout_wallet`/`payout_chain`. Son campos semánticamente distintos
  (creator-split del 1% vs. payTo del precio completo del agente); conflacionarlos sería un bug
  de money-path (redirigiría el fee completo del agente a una wallet pensada para una fracción
  del 1%). Elección conservadora: sin fallback implícito.
- **DT-3**: NO se agrega validación de formato de `payment.contract` en discovery-read-time. El
  guard existente en settle-time (`validatePayTo`/`isValidSolanaAddress`,
  `downstream-payment.ts`) ya rechaza un `payTo` malformado con skip-code, sin mover fondos —
  agregar un segundo guard en discovery duplicaría la validación sin beneficio de seguridad
  adicional (AC-5 ya cubierto por el código existente). Si el Architect prefiere fail-fast en
  discovery (ocultar el `payment` en vez de exponerlo-y-luego-skipear en settle), es una decisión
  de F2, no bloqueante para el work-item.
- **DT-4** *(NEEDS CLARIFICATION menor, no bloqueante)*: nombre final del export
  (`readPaymentSpec` vs. mantener `readPayment`) y ubicación exacta del archivo — el Architect
  puede ajustar el nombre en F2 sin impacto en el diseño.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO introducir un segundo validador de chain/formato paralelo a
  `normalizeChainSlug`/`readPaymentSpec` — un solo choke-point compartido entre el mapper de
  registries externos y el de self-published (AC-4).
- CD-2: OBLIGATORIO preservar byte-idéntico el comportamiento de `/discover` para (a) agentes
  self-published sin `metadata.payment` (AC-2) y (b) el settle de agentes EVM existentes (AC-6).
  Ningún test existente debe cambiar de expectativa salvo los que testean el nuevo campo.
- CD-3: PROHIBIDO derivar `payment` desde `payout_wallet`/`payout_chain` (DT-2) — son campos de
  money-path con semántica distinta; mezclarlos es un bug de fondos, no una optimización de código.
- CD-4: Sin hardcodes de chain/contract — el `payment.contract`/`chain` es 100% pass-through de
  lo que el agente declaró en `metadata.payment`, con la única validación dinámica de
  `normalizeChainSlug` (heredada de WKH-113, sin allowlist estática nueva).
- CD-5: Ownership guard — revisado en F0: este cambio es de LECTURA sobre `a2a_agents` vía
  `listAsAgents()`/`getBySlugAsAgent()`, que son la vista PÚBLICA descubrible (por diseño, WKH-134,
  no filtran por `owner_ref`). No se tocan mutaciones ni queries que requieran
  `.eq('owner_ref', ...)` — no aplica el patrón de `CLAUDE.md` "Security Conventions — Ownership
  Guard" a este cambio (documentado explícitamente para que AR no lo marque como omisión).

## Missing Inputs

- **[resuelto en F0, no bloqueante]** ¿Cómo llegó `metadata.payment` a los 2 agentes target si no
  existe write-path API? Asumido: escritura directa en DB (SQL/migración) fuera de este repo,
  consistente con el enunciado del hallazgo del orquestador. Si en cambio se espera que esta HU
  también agregue el write-path API, es scope adicional — [NEEDS CLARIFICATION] para el humano en
  el gate `HU_APPROVED` si el Analyst se equivocó en esta lectura.
- **[no bloqueante]** Nombre final del módulo/función extraída (DT-4) — decisión de F2.

## Análisis de paralelismo

- No bloquea ni es bloqueada por HUs `in progress` actuales (WKH-157/152/158/159/160, filas
  159-163 de `_INDEX.md`) — toca archivos distintos (`agent.ts`, `discovery.ts` en una zona no
  tocada por esas HUs de relevancia del planner).
- Depende de código YA mergeado: WKH-234 (fila 182, PaymentAdapter Solana) y WKH-113 (fila 95,
  chain validation dinámica). Ambos DONE en `main`.
- Puede ir en paralelo con cualquier HU que no toque `src/services/agent.ts` o
  `src/services/discovery.ts:mapAgent/readPayment`.
- Es un pre-requisito de CÓDIGO para que WKH-235/236 (Solana LATAM Labs, fee real de los 2
  agentes remit-*-solana) cierre end-to-end — pero NO es suficiente por sí sola (ver siguiente
  sección).

## ¿Esta HU cierra WKH-235/236 end-to-end?

**NO por sí sola — es CÓDIGO necesario pero no suficiente.** Distinción CÓDIGO vs CONFIG/OPS:

| Pieza | Estado | Tipo |
|-------|--------|------|
| `mapRowToAgent` expone `Agent.payment` para self-published | Esta HU (WKH-241) | CÓDIGO |
| `signAndSettleDownstream` rutea a Solana por `agent.payment.chain` | YA existe (WKH-234) | CÓDIGO — sin cambios |
| Validación base58 + adapter Solana (settle SPL real) | YA existe (WKH-234) | CÓDIGO — sin cambios |
| `SOLANA_ADAPTER_ENABLED=true` en Railway | Pendiente | **CONFIG/OPS, founder-gated** |
| `WASIAI_DOWNSTREAM_X402=true` en Railway | Pendiente (a confirmar si ya está ON) | **CONFIG/OPS, founder-gated** |
| Los 2 agentes remit-*-solana con `metadata.payment`/`payout_wallet` correctos en bdwv | YA confirmado por el orquestador | DATA — ya hecho |

Una vez mergeado y deployado el código de esta HU, el AC de WKH-235/236 ("el fee del agente
Solana se liquida en USDC sobre Solana devnet") queda **code-complete** pero requiere el flip de
los 2 flags en Railway (founder-gated, mismo patrón que WKH-234/WKH-191 en `_INDEX.md`: "DONE
(código) · PENDING-DEPLOY/ACTIVATION-PENDING") antes de ser real end-to-end.
