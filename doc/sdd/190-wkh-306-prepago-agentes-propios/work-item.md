# Work Item — [WKH-306] Acotar y hacer visible el residuo de pipelines que fallan a mitad de camino

> ⚠️ **Pivote de alcance (2026-07-28).** El encargo original de esta HU
> proponía un saldo prepago para agentes propios. El founder lo descartó
> DESPUÉS de F0: nada de saldos, recargas, liquidación diferida ni reversión.
> **Todos los agentes cobran por llamada, incluidos los propios.** Esta
> versión reemplaza esa anterior por completo. El análisis de por qué el pago
> por llamada sostiene la neutralidad del marketplace SE MANTIENE — ya no
> como restricción de una feature descartada, sino como el fundamento de
> DT-1, para que nadie la reintroduzca sin volver a pasar por esta decisión.

## Resumen

Cuando un pipeline de `/compose` falla en el step `i`, el dinero que ya se
pagó ON-CHAIN a los agentes de los steps `0..i-1` (vía
`signAndSettleDownstream`) no vuelve — ni existe hoy dónde verlo agregado
fuera de la respuesta HTTP de esa única request. El founder decidió **asumir
ese riesgo explícitamente en vez de construir un segundo riel de pago** para
evitarlo (prepago habría sido más rápido/barato para agentes propios = ventaja
injusta por el riel, no por calidad — el mismo motivo por el que ya se sacó el
filtro de cadena de discovery). Esta HU convierte "asumir el riesgo" en algo
profesional y no perezoso: **acotar** la exposición máxima con un número
verificable, **hacer visible** cada pipeline con pago stranded reusando la
superficie de reconciliación que ya existe, y **alertar** si el fenómeno
empieza a crecer.

## Sizing

- SDD_MODE: full
- Modo: QUALITY (obligatorio en este repo — CLAUDE.md)
- Estimación: M — es observabilidad + correlación de eventos sobre el
  money-path existente, no un rail de pago nuevo. El trabajo real es (a)
  threadear un identificador de run en los eventos ya trackeados, (b)
  extender ADITIVAMENTE una superficie admin ya candada, (c) documentar/testear
  una fórmula de cota. No hay tabla de saldo, RPC de débito/crédito, ni
  reversión — eso desapareció con el pivote.
- Branch sugerido: `feat/190-wkh-306-visibilidad-pago-stranded`
- Dominio (tags, convención `_INDEX.md`): `feature/billing/observability`

## Contexto verificado (F0)

- **El hueco es real y está confirmado leyendo `src/services/compose.ts`**:
  en el `catch` del loop de steps, `refundStepDebit()` (líneas ~458-523)
  revierte ÚNICAMENTE el débito del CALLER para el step que está fallando
  (`stepDebitedUsd`). Ningún código revierte ni registra en ningún lado
  persistente el settle on-chain que `signAndSettleDownstream` ya ejecutó
  para los steps previos que sí tuvieron éxito. La única traza que existe hoy
  es el `StepResult` (con `downstreamTxHash`/`downstreamSettledAmount`) que
  viaja en la respuesta HTTP de ESA request — se pierde si nadie la
  persiste (`services/compose.ts:857-877`, `services/compose.ts:781-793`).
- **`MAX_COMPOSE_STEPS = 5`** — constante verificable, `src/lib/compose-limits.ts:38`.
  Es la mitad "pasos" de la cota de exposición (AC-1). La mitad "precio por
  paso" NO tiene techo de código confirmado en F0: `ComposeRequest.maxBudget`
  es OPCIONAL (`compose.ts` sólo lo chequea `if (maxBudget && …)`) y no se
  encontró ningún `MAX_AGENT_PRICE` o equivalente. Esto es un
  `[NEEDS CLARIFICATION]` explícito para F2 (ver Missing Inputs).
- **No existe hoy un identificador de pipeline-run persistido en `a2a_events`**.
  `compose.ts` genera `composeRunId = randomUUID()` (línea ~182) y lo usa
  como parte del `intentId` del leg Solana y de las claves de idempotencia de
  refund — pero NUNCA lo pasa a `eventService.track()`
  (`services/event.ts`, `EventRow`/`a2a_events` no tienen columna de
  correlación de run). Sin esto, HOY no se puede reconstruir por query "qué
  steps de qué pipeline pagaron antes de que ese mismo pipeline fallara" —
  es la única pieza de código nueva real de esta HU.
- **La superficie a reusar YA EXISTE y está fuertemente candada**:
  `src/services/reconciliation.ts` expone `listPending()` (ambigüedad
  hop1/hop2 del escrow non-custodial, WKH-191) y `listAmbiguous()` →
  `AmbiguousReport { rows, total, truncated, settleUnknown: SettleUnknownReport }`
  (WKH-201/203), servida por `GET /dashboard/api/reconciliation`
  (`src/routes/dashboard.ts`, admin-gated con `requireAdminToken`/
  `DASHBOARD_ADMIN_TOKEN`). El propio archivo declara EXPLÍCITAMENTE el
  contrato que hay que heredar: `total` exacto vía `{count:'exact'}`,
  `truncated: total > rows.length`, y un error de query TIRA en vez de
  devolver `[]` — "una lista de plata retenida que se corta en silencio
  afirma algo falso" (comentario textual de `listSettleUnknown`,
  `reconciliation.ts:626-629`). Ninguna de las dos listas existentes cubre el
  caso de esta HU (settle CONFIRMADO exitoso + pipeline fallado después no es
  lo mismo que "resultado del settle desconocido") — se necesita un campo
  nuevo ADITIVO dentro de la MISMA superficie, no una tercera cola/endpoint
  independiente.
- **Trípode de observabilidad ya activo** (memoria del repo: gas WKH-71,
  health WKH-77, synthetic WKH-74) — candidato natural para el canal de
  alerta de AC-5, en vez de inventar un cuarto mecanismo.
- **Dependencia declarada, no resuelta acá**: otra HU del mismo batch
  (WKH-305) encontró que el débito de un step ocurre ANTES de construir su
  input — un step con input inválido cobra igual. Arreglar ESE orden elimina
  de raíz la familia de fallos "por entrada mala" y reduce el residuo real a
  fallos genuinos de ejecución (agente caído, timeout, proveedor que responde
  mal). Esta HU NO toca ese código; sólo declara la dependencia para el
  dimensionamiento.

## Fundamento (por qué NO hay un segundo riel de pago)

El pago por llamada es lo que permite que **cualquier agente entre al
marketplace sin que WasiAI lo conozca de antemano**: no requiere una relación
previa, un saldo fondeado, ni un proceso de onboarding financiero — eso *es*
la neutralidad. Un mecanismo de saldo prepago rompe esa simetría por
construcción: sólo puede existir para quien YA tiene una relación previa con
el operador del gateway, y hoy esa relación previa la tiene únicamente
WasiAI con sus propios agentes (`remit-*`, `agentshop-*`). Si el prepago fuera
estructuralmente más rápido o más barato que pagar por llamada (sin gas por
llamada, sin ronda de settle), los agentes propios ganarían pipelines por el
RIEL y no por la calidad del servicio — una ventaja injusta metida por la
puerta de atrás, simétrica a por qué `agent.payment.chain` no se usa como
señal de ranking en discovery. El founder priorizó la neutralidad absoluta
por sobre optimizar un costo que, al precio real de mercado (~USD 0,03 por
agente), es marginal frente al costo de mantener DOS modelos de cobro para
siempre. **Este fundamento queda escrito acá a propósito**: es el motivo por
el que reintroducir prepago en el futuro no debería ser una optimización
silenciosa, sino una decisión que vuelva a pasar por este mismo argumento.

## Acceptance Criteria (EARS)

- **AC-1** — the system SHALL exponer una cota máxima de exposición económica
  por pipeline que sea VERIFICABLE por código (derivada de `MAX_COMPOSE_STEPS`
  y el precio máximo real/vigente por agente en el catálogo, o el techo de
  precio que F2 determine), no un número estimado a mano en un documento que
  se desactualiza.

- **AC-2** — WHEN un pipeline de `/compose` falla en el step `i > 0` DESPUÉS
  de que al menos un step previo del MISMO run completó su settle downstream
  on-chain (evidencia: `downstream.txHash` presente en ese `StepResult`),
  THEN the system SHALL registrar ese pipeline como "pago stranded" en la
  superficie de reconciliación existente, correlacionando los steps del
  mismo run.

- **AC-3** — the system SHALL exponer, para cada pipeline con pago stranded,
  como mínimo: identificador del run, el o los steps que efectivamente
  pagaron on-chain (agente, monto, txHash) y el step que falló — reusando el
  MISMO contrato de completitud ya candado en `AmbiguousReport`/
  `SettleUnknownReport` (`total` exacto, `truncated`, sin lista nueva
  independiente).

- **AC-4** — IF la consulta que arma este listado falla (error de base de
  datos), THEN the system SHALL propagar el error (throw) en vez de devolver
  una lista vacía — mismo invariante que `listAmbiguous`/`listSettleUnknown`
  ya imponen y que esta HU NO puede debilitar.

- **AC-5** — WHEN la cantidad de pipelines con pago stranded en una ventana de
  tiempo supera un umbral documentado y fundamentado, THEN the system SHALL
  emitir una señal observable (alerta/log estructurado) reusando un canal de
  observabilidad ya activo del repo.

- **AC-6** — the system SHALL preservar el pago por llamada como el ÚNICO
  método de cobro para TODOS los agentes, propios y de terceros, sin
  distinción — esta HU no introduce ningún saldo, crédito, recarga ni
  liquidación diferida.

- **AC-7** — the system SHALL tratar esta superficie como de SOLO LECTURA —
  ningún pago stranded se reembolsa, reclama o compensa automáticamente como
  parte de esta HU (mismo principio ya declarado para `listAmbiguous`/
  `listSettleUnknown`: sin poder responder "¿el broadcast aterrizó?" con
  certeza adicional a la que ya hay, no hay resolución automática posible).

## Scope IN

- `wasiai-a2a`: threadear un identificador de run (`composeRunId` u
  equivalente) en los eventos que `compose.ts` ya trackea vía
  `eventService.track()`, de forma ADITIVA (sin cambiar la forma actual para
  ningún consumidor existente de `a2a_events`).
- `wasiai-a2a`: extensión ADITIVA de `reconciliationService.listAmbiguous()`
  (o el service/endpoint admin equivalente que Architect determine) con un
  campo nuevo que liste los pipelines con pago stranded, heredando el
  contrato de completitud ya candado.
- `wasiai-a2a`: documentación + verificación (test o script re-ejecutable) de
  la fórmula de cota máxima de exposición (AC-1).
- `wasiai-a2a`: umbral de alerta (AC-5) — definición fundamentada del número +
  el mecanismo de disparo, reusando el trípode de observabilidad existente.
- `wasiai-a2a`: guard/test que confirme que el pago por llamada sigue siendo
  el único método de cobro (AC-6) — regresión explícita contra el pivote de
  esta misma HU.

## Scope OUT

- Resolver WKH-305 (orden débito/construcción de input) — se declara como
  dependencia de dimensionamiento, no se toca su código en esta HU.
- Cualquier forma de saldo prepago, crédito, recarga o liquidación diferida —
  descartado explícitamente por el founder, ver "Fundamento" arriba.
- Remediación automática del pago stranded (reembolso, reclamo, compensación) —
  esta HU es de SOLO LECTURA (AC-7).
- `wasiai-facilitator`: ningún cambio — esta HU no mueve dinero, sólo lo
  observa. Lectura ya hecha en F0, no hace falta más.
- Un endpoint/tabla/cola de admin nueva e independiente — DEBE extender la
  superficie existente (CD-2).
- UI/dashboard visual nuevo más allá de lo que el panel admin ya existente
  requiera para exponer el campo nuevo (a decidir en F2 si aplica).
- Migrar o cambiar el comportamiento de pago de `remit-*`/`agentshop-*` — ya
  cobran por llamada y así se quedan.

## Decisiones técnicas (DT-N)

- **DT-1** (fundamento, ver sección dedicada arriba): el pago por llamada es
  estructural a la neutralidad del marketplace — cualquier riel alternativo
  que sea más rápido/barato reintroduce una ventaja por acceso y no por
  calidad. No se re-abre sin pasar de nuevo por esta decisión.

- **DT-2**: la exposición económica de un pipeline fallido es dinero ya
  gastado que no vuelve — se ASUME explícitamente en vez de evitarse con
  arquitectura nueva. Gestión profesional de ese riesgo = acotarlo (AC-1) +
  hacerlo visible (AC-2/AC-3) + alertar si crece (AC-5). Eso es el contenido
  íntegro de esta HU.

- **DT-3**: la superficie de visibilidad reusa
  `reconciliationService`/`GET /dashboard/api/reconciliation` — el MISMO
  endpoint admin que ya sirve `AmbiguousReport` + `SettleUnknownReport`. No
  se crea una tercera cola independiente (CD-2). El contrato de completitud
  ya escrito en ese archivo (total exacto, `truncated`, throw-on-query-error)
  es obligatorio de heredar tal cual.

- **DT-4**: detectar "pipeline falló después de pagar" requiere correlacionar
  los steps de UN MISMO run — hoy `a2a_events` no persiste ningún
  identificador de run. Threadear ese id en los eventos ya trackeados es la
  única pieza de código nueva no-trivial de esta HU; debe ser aditivo y no
  cambiar la forma actual de `a2a_events` para ningún consumidor existente
  (dashboard analytics, reputation-writeback, etc.).

- **DT-5** (recomendación a ratificar en F2): el umbral de AC-5 se ancla al
  mismo trípode de observabilidad ya activo (gas WKH-71, health WKH-77,
  synthetic WKH-74) en vez de crear un cuarto canal de alerta. Architect
  decide el mecanismo exacto (query periódica vs trigger en el momento del
  evento) en F2.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO introducir cualquier mecanismo de saldo prepago,
  crédito, recarga o liquidación diferida para NINGÚN agente, propio o
  tercero. El pago por llamada es el ÚNICO método de cobro, sin excepción.
  (Esta directiva anula y reemplaza el encargo original de esta HU.)

- **CD-2**: PROHIBIDO crear un endpoint, tabla o "cola" de admin nueva e
  independiente para este listado — DEBE extender aditivamente la superficie
  ya existente (`reconciliationService`/`GET /dashboard/api/reconciliation`).

- **CD-3**: OBLIGATORIO que cualquier query nueva de este listado propague el
  error (throw) en vez de devolver `[]` silenciosamente ante un fallo de
  base de datos — mismo invariante que `listAmbiguous`/`listSettleUnknown`
  ya imponen (AC-4).

- **CD-4**: PROHIBIDO que esta HU implemente remediación automática (reembolso,
  reclamo, compensación) del pago stranded — superficie de SOLO LECTURA
  (AC-7).

- **CD-5**: PROHIBIDO resolver WKH-305 (orden débito/construcción de input)
  dentro de esta HU — se declara como dependencia de dimensionamiento, no se
  toca ese código.

- **CD-6**: OBLIGATORIO que la fórmula de exposición máxima (AC-1) sea
  RE-COMPUTABLE por código (test o script), no un número fijado a mano en
  prosa.

## Missing Inputs

- `[bloqueante F2]` ¿Existe o debe crearse un techo de `agent.priceUsdc` para
  que la cota de exposición (AC-1) sea una GARANTÍA de código y no sólo un
  número observado hoy? F0 confirmó `MAX_COMPOSE_STEPS=5`
  (`src/lib/compose-limits.ts:38`) pero NO encontró techo de precio por
  agente — `ComposeRequest.maxBudget` es opcional. Escalado a Architect.
- `[bloqueante F2]` Mecanismo exacto de correlación de run (campo nuevo en
  `metadata` de `a2a_events` vs otra estrategia) — Architect decide en F2.
- `[NEEDS CLARIFICATION]` El umbral numérico concreto de AC-5 no lo definió
  el founder en el encargo — se propone en F2 con fundamento (ej. tasa
  histórica `compose_step failed` vs `success` en `a2a_events`, o un
  porcentaje fijo) y se ratifica en `SPEC_APPROVED`.
- `[dependencia, no bloqueante]` WKH-305 reduce el volumen real de este
  residuo una vez mergeada (elimina los fallos por input inválido, que
  hoy también cobran). No bloquea el desarrollo de esta HU, pero el
  dimensionamiento final de "qué tan grave es el problema" debería
  re-evaluarse después de que 305 esté DONE.

## Análisis de paralelismo

- **Depende conceptualmente de WKH-305** (dimensionamiento del residuo, NO
  bloqueo de código) — declarada como dependencia (CD-5), no se resuelve acá.
- **Riesgo de merge, no de diseño**: ambas HUs (esta y WKH-305) tocan
  `src/services/compose.ts` — WKH-305 en el orden débito/construcción-de-input
  ANTES del `try`, esta HU en la rama de error/`catch` y en
  `reconciliation.ts`/`event.ts`. Verificar en F2 si las líneas se solapan;
  si no, pueden desarrollarse en paralelo, pero SECUENCIAR el merge (la que
  termine primero, va primero) para evitar un conflicto grande sobre el
  mismo archivo central del money-path.
- **No bloquea** ninguna otra HU en curso (fila 189, P1-FIX-PACK, toca
  `discovery.ts`/`discovery-query.ts`/`downstream-skip-code.ts` — sin
  overlap de archivos).
- **Insumos ya existentes, no bloqueantes**: el trípode de observabilidad
  (WKH-71/74/77) y el panel admin de reconciliación (WKH-191c/201/203) — se
  REUSAN, no se re-diseñan.
