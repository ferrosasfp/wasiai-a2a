/**
 * Vocabulario de skip-codes del leg downstream + su traducción al contrato
 * PÚBLICO de la respuesta HTTP (fix-pack P1, hallazgo 4).
 *
 * Vive en un módulo LEAF (cero imports de adapters/services/viem) por la misma
 * razón que `discovery-query.ts`: media docena de suites mockean
 * `../lib/downstream-payment.js` COMPLETO con factories sin `importOriginal`
 * (compose.test.ts, compose.ssrf.test.ts, compose.chain-flow.test.ts,
 * orchestrate.billing.test.ts, money-path.resilience.test.ts,
 * e2e/compose-flow.test.ts), así que cualquier export nuevo de ese módulo que
 * `compose.ts` consuma queda `undefined` ahí. Verificado a los golpes: ponerlo
 * en downstream-payment.ts rompió 84 tests de compose.test.ts.
 *
 * Regla derivada: helpers PUROS (mapeo, validación, parsing) van en un leaf; el
 * módulo del money-path queda para I/O.
 */

import type { DownstreamLogger } from '../types/index.js';

/**
 * Códigos que hablan del INTENTO DE PAGO del leg downstream: por qué no se pagó,
 * que no se sabe si se pagó, o qué pre-check del intento no se pudo verificar.
 * Los tres primeros grupos CORTAN el leg (`return null`); los de observabilidad
 * NO cortan (ver el catálogo en el docstring de `signAndSettleDownstream`).
 *
 * ⚠️ NO ES el catálogo completo de valores que salen en un campo `code` de un log
 * de `downstream-payment.ts`. (Esta frase decía justamente eso — "TODO valor que
 * salga en un `code` tiene que estar acá" — y era falsa desde que existe el
 * clasificador de alias.) Los AVISOS que no hablan del intento de pago quedan
 * afuera A PROPÓSITO. Hoy hay exactamente uno:
 *
 *   · `AMBIGUOUS_CHAIN_ALIAS` (`downstream-payment.ts`, paso 4-bis): el agente
 *     nombró la red sin decir su entorno. Se cuenta y el leg SIGUE, y se paga
 *     normal. No dice nada sobre la suerte del pago.
 *
 * POR QUÉ AFUERA Y NO ADENTRO. Entrar a este union obliga (los `Record` de abajo
 * son exhaustivos por tipo) a darle una traducción PÚBLICA y una ACCIÓN de
 * operador, y las dos tablas están escritas para legs que NO se pagaron:
 * `PUBLIC_SKIP_MEANING.NOT_CONFIGURED` dice literalmente "por eso no se movió
 * dinero", y `/dashboard/trace` cuenta acciones de legs sin pagar. Sumar ahí un
 * aviso de un leg que SÍ se pagó vuelve a mezclar dos incidentes que no se deben
 * sumar en el mismo contador — que es exactamente el colapso que la tabla de
 * acciones acaba de terminar de deshacer. La acción real del aviso (que el
 * publicador migre el slug) ya tiene dueño aparte: `chain-resolver.ts:201`.
 *
 * LO QUE ESTE MÓDULO SÍ GARANTIZA, y es mecánico:
 *  1. Todo miembro de este union tiene traducción pública Y acción de operador —
 *     los `Record` exhaustivos: agregar un código sin decidir las dos cosas NO
 *     COMPILA.
 *  2. `createSkipCapturingLogger` sólo captura los `code` que están en este union,
 *     así que un aviso NUNCA se convierte en el motivo de skip de una respuesta
 *     (`steps[].downstreamSettle`) ni en un `downstreamSkipCauses`.
 *
 * Falsable: sería falso si `downstream-payment.ts` emitiera un `code` que no sea
 * ni miembro de este union ni un aviso declarado, o si un aviso llegara a
 * `lastSkipCode()`. Las dos cosas las fija `downstream-skip-code.catalog.test.ts`.
 */
export type DownstreamSkipCode =
  | 'FLAG_OFF'
  | 'NO_PAYMENT_FIELD'
  | 'METHOD_NOT_SUPPORTED'
  | 'CHAIN_NOT_SUPPORTED'
  // Slug ↔ destino incoherentes. Código PROPIO (fix-pack CR-MNR-5): antes se
  // logueaba como `MAINNET_NOT_ALLOWED` + `reason:'CHAIN_ENVIRONMENT_DRIFT'`,
  // y eso mezclaba en un mismo código dos incidentes que no tienen nada que ver
  // entre sí — "un agente pidió una mainnet sin opt-in" (esperable, sano) vs
  // "NUESTRA config apunta a un destino que contradice su slug" (bug de
  // operación, incluye el caso declared=mainnet/actual=testnet, donde permitir
  // mainnet no es el tema). Un dashboard que cuente `MAINNET_NOT_ALLOWED` no
  // debe sumar los dos.
  | 'CHAIN_ENVIRONMENT_DRIFT'
  | 'MAINNET_NOT_ALLOWED'
  | 'INVALID_PAY_TO_FORMAT'
  | 'ZERO_PAY_TO'
  | 'INVALID_PRICE'
  | 'INSUFFICIENT_BALANCE'
  | 'BALANCE_READ_FAILED'
  | 'SIGNING_FAILED'
  | 'VERIFY_FAILED'
  | 'SETTLE_FAILED'
  // HU-198: el hop al facilitator NO contestó y el pago PUDO haberse ejecutado
  // igual (`FacilitatorSettleError` con `valueDisposition: 'unknown'` — abortar el
  // HTTP no cancela un broadcast). Código PROPIO y separado de `SETTLE_FAILED` por
  // la misma razón que `CHAIN_ENVIRONMENT_DRIFT` se separó de `MAINNET_NOT_ALLOWED`:
  // son dos incidentes distintos que no se deben sumar en el mismo contador.
  // `SETTLE_FAILED` significa "no se pagó" (el facilitator lo dijo, o no hubo ni
  // request); `SETTLE_UNKNOWN` significa "no sé si se pagó", y ese leg NO se puede
  // reintentar a ciegas ni dar por no pagado.
  | 'SETTLE_UNKNOWN'
  // ── Observabilidad: NO cortan el leg ────────────────────────────────
  // No se pudo leer el balance del operador antes de settlear ⇒ el pre-check se
  // saltea y el settle sigue. SÓLO se emite en dos condiciones:
  //   · EVM: falta la RPC env del rail — paso 9 de `signAndSettleDownstream`,
  //     guard `if (!rpc)`.
  //   · Solana: `getOperatorSplBalance()` tira — catch en `settleSolanaLeg`.
  //
  // ⚠️ NO cubre el caso "falta `OPERATOR_PRIVATE_KEY`" (re-CR MENOR-4: este
  // comentario lo prometía y era falso). Con RPC presente y PK ausente o sin
  // `0x`, el `if (pk?.startsWith('0x'))` del paso 9 NO tiene `else`: el pre-check
  // se saltea **sin emitir ningún código**. Es un hueco de observabilidad, no de
  // dinero — sin PK el `adapter.sign` posterior falla igual (`SIGNING_FAILED`,
  // `avalanche/payment.ts:177-180` y sus pares de kite-ozone/base). Se dejó como
  // hueco a propósito: agregar el log es tocar el money-path que AR+F4+re-CR ya
  // aprobaron en este diff, y sumaría un 3er código de observabilidad por un
  // caso sin impacto práctico.
  | 'BALANCE_PRECHECK_SKIPPED'
  // Replay idempotente Solana con balance por debajo del monto del leg: el
  // intent YA tiene firma, así que NO se corta (FIX 2); el log explica por qué
  // un eventual self-heal re-broadcast fallaría on-chain.
  | 'BALANCE_LOW_ON_IDEMPOTENT_REPLAY'
  // WKH-307 (DT-9): el leg no trae clave de idempotencia. Sin una clave ESTABLE, un
  // retry es indistinguible de un pago nuevo, asi que no se transmite nada.
  | 'MISSING_INTENT_ID'
  // WKH-307 (AC-4): el ledger de settle no contesto. "No se si ya pague" NUNCA
  // autoriza pagar.
  | 'SETTLE_LEDGER_UNAVAILABLE';

// ─── Fix-pack P1 (hallazgo 4): señal de skip en la respuesta HTTP ──────
//
// Cuando un leg downstream se saltea, el motivo quedaba SÓLO en los logs: la
// respuesta de /compose no lo decía. Se surfacea en
// `steps[].downstreamSettle = "skipped:<code>"`.
//
// ⚠️ Los `DownstreamSkipCode` se diseñaron para LOGS DE OPERADOR (audiencia
// interna). Serializarlos crudos al caller filtra estado interno, así que hay un
// vocabulario público aparte. Criterio:
//
//   Se expone VERBATIM lo que describe la DECLARACIÓN DEL PROPIO AGENTE (dato
//   que el caller ya ve en /discover) o un RESULTADO TERMINAL de pago.
//   Se GENERICIZA lo que describe la config del gateway, el wallet del operador
//   o sus claves.

/** Vocabulario PÚBLICO de skip. Es contrato de API — ver el mapeo abajo. */
export type PublicDownstreamSkipCode =
  // Declaración del agente (el caller ya la ve en /discover).
  | 'NO_PAYMENT_FIELD'
  | 'METHOD_NOT_SUPPORTED'
  | 'CHAIN_NOT_SUPPORTED'
  | 'INVALID_PAY_TO_FORMAT'
  | 'ZERO_PAY_TO'
  | 'INVALID_PRICE'
  // Resultado terminal: el leg no se pagó.
  | 'SETTLE_FAILED'
  // HU-198. Resultado NO terminal: el pago quedó en estado desconocido. Se expone
  // en vez de colapsarlo en `SETTLE_FAILED` porque las dos frases que el caller
  // necesita son opuestas ("no se pagó" vs "puede haberse pagado") y porque
  // `SETTLE_FAILED` afirma además que al caller no se le cobra por el leg, que acá
  // no está establecido. NO revela config nuestra: dice el estado del pago, no qué
  // hop ni qué facilitator ni qué env var.
  | 'SETTLE_UNKNOWN'
  // El gateway no está configurado para settlear este leg (flag/allow-list/drift
  // de config). NO se dice cuál: nombrar la env var o el destino configurado es
  // exactamente la fuga que este mapeo evita.
  | 'NOT_CONFIGURED'
  // El gateway no pudo settlear por su propio estado (fondos del operador,
  // claves, lectura de balance). NO se dice cuál.
  | 'UNAVAILABLE';

/**
 * Mapeo interno → público. **EXHAUSTIVO POR TIPO** a propósito: agregar un
 * `DownstreamSkipCode` nuevo sin decidir su visibilidad NO COMPILA. Ese es el
 * guard que evita que la fuga entre por olvido en la HU siguiente.
 *
 * Justificación de cada genericización:
 *  · `FLAG_OFF`               revela el estado de un feature flag del gateway.
 *  · `CHAIN_ENVIRONMENT_DRIFT` es, por definición, un bug de config NUESTRO (ver
 *    la nota del código arriba): revela que el destino configurado contradice la
 *    red declarada — o sea si el gateway apunta a testnet publicando mainnet.
 *  · `MAINNET_NOT_ALLOWED`    revela la allow-list de mainnets
 *    (`WASIAI_DOWNSTREAM_MAINNET_ALLOW`); sondeando se podría enumerar.
 *  · `INSUFFICIENT_BALANCE`   revela que la hot wallet del operador está seca en
 *    ese rail: inteligencia operativa directa para cronometrar un abuso.
 *  · `BALANCE_READ_FAILED` / `BALANCE_PRECHECK_SKIPPED` /
 *    `BALANCE_LOW_ON_IDEMPOTENT_REPLAY` — estado del RPC/wallet del operador.
 *  · `SIGNING_FAILED`         falla firmando con `OPERATOR_PRIVATE_KEY` → revela
 *    que la clave del operador falta o es inválida.
 *  · `VERIFY_FAILED`          el facilitator rechazó NUESTRA firma: detalle
 *    interno. Para el caller es indistinguible de "no se pagó".
 */
const PUBLIC_SKIP_CODE: Record<DownstreamSkipCode, PublicDownstreamSkipCode> = {
  // Verbatim — declaración del agente.
  NO_PAYMENT_FIELD: 'NO_PAYMENT_FIELD',
  METHOD_NOT_SUPPORTED: 'METHOD_NOT_SUPPORTED',
  CHAIN_NOT_SUPPORTED: 'CHAIN_NOT_SUPPORTED',
  INVALID_PAY_TO_FORMAT: 'INVALID_PAY_TO_FORMAT',
  ZERO_PAY_TO: 'ZERO_PAY_TO',
  INVALID_PRICE: 'INVALID_PRICE',
  // Verbatim — resultado terminal.
  SETTLE_FAILED: 'SETTLE_FAILED',
  // Verbatim — resultado NO terminal (HU-198). NO se colapsa en `SETTLE_FAILED`:
  // eso volvería a afirmarle al caller que el leg no se pagó, que es justo lo que
  // no sabemos.
  SETTLE_UNKNOWN: 'SETTLE_UNKNOWN',
  // Genericizados — config del gateway.
  FLAG_OFF: 'NOT_CONFIGURED',
  CHAIN_ENVIRONMENT_DRIFT: 'NOT_CONFIGURED',
  MAINNET_NOT_ALLOWED: 'NOT_CONFIGURED',
  // Genericizados — wallet / claves / RPC del operador.
  INSUFFICIENT_BALANCE: 'UNAVAILABLE',
  BALANCE_READ_FAILED: 'UNAVAILABLE',
  BALANCE_PRECHECK_SKIPPED: 'UNAVAILABLE',
  BALANCE_LOW_ON_IDEMPOTENT_REPLAY: 'UNAVAILABLE',
  // WKH-307: los dos mapean a codigos publicos QUE YA EXISTEN, a proposito. No se
  // agrega vocabulario publico nuevo y `PUBLIC_SKIP_MEANING` no cambia ⟹ cero cambio
  // del contrato de API. `MISSING_INTENT_ID` es config del gateway (el caller no puede
  // hacer nada con el detalle) y `SETTLE_LEDGER_UNAVAILABLE` es un estado transitorio
  // de infraestructura, que es exactamente lo que `UNAVAILABLE` significa.
  MISSING_INTENT_ID: 'NOT_CONFIGURED',
  SETTLE_LEDGER_UNAVAILABLE: 'UNAVAILABLE',
  SIGNING_FAILED: 'UNAVAILABLE',
  // Genericizado — detalle del facilitator.
  VERIFY_FAILED: 'SETTLE_FAILED',
};

/** Traduce un skip-code interno al vocabulario público de la respuesta HTTP. */
export function toPublicSkipCode(
  code: DownstreamSkipCode,
): PublicDownstreamSkipCode {
  return PUBLIC_SKIP_CODE[code];
}

/**
 * Type-guard runtime del vocabulario INTERNO. Igual que `isPublicSkipCode`, pero
 * para el otro lado del mapeo: valida strings que vuelven de
 * `a2a_events.metadata` (jsonb, sin garantía de tipo) antes de clasificarlos.
 */
export function isDownstreamSkipCode(
  value: unknown,
): value is DownstreamSkipCode {
  // `hasOwn` (no `in`) por la misma razón que en `isPublicSkipCode`: un
  // `constructor` heredado del prototipo no es un skip-code.
  return typeof value === 'string' && Object.hasOwn(PUBLIC_SKIP_CODE, value);
}

// ─── Clasificación por ACCIÓN (canal de OPERADOR) ──────────────────────
//
// EL PROBLEMA QUE RESUELVE. El vocabulario PÚBLICO de arriba colapsa CUATRO
// causas internas en `NOT_CONFIGURED` — `FLAG_OFF`, `CHAIN_ENVIRONMENT_DRIFT`,
// `MAINNET_NOT_ALLOWED` y `MISSING_INTENT_ID` — y otras SEIS en `UNAVAILABLE`.
// Para el CALLER ese colapso es CORRECTO y se mantiene: las cuatro lo dejan en el
// mismo lugar ("el gateway no pagó ese leg, no es algo que yo pueda arreglar"), o
// sea que la acción del caller es la misma en las cuatro, y separarlas sólo le
// filtraría estado nuestro (qué flag, qué allow-list, qué config está rota).
//
// Para el OPERADOR el colapso es un agujero: las cuatro llevan a CUATRO personas
// distintas haciendo CUATRO cosas distintas, y la pantalla de telemetría las
// cuenta como un solo número. `NOT_CONFIGURED × 47` no dice si alguien tiene que
// levantarse a arreglar un deploy o si no pasa nada.
//
// EL CRITERIO DE ESTA TABLA. Se separa por la ACCIÓN QUE PROVOCA, no por dónde
// está el código. Dos códigos internos que llevan a la misma persona a hacer lo
// mismo comparten acción a propósito (p. ej. los seis códigos que describen una
// agent card mal publicada). Dos códigos que están pegados en el fuente pero
// llevan a acciones distintas NO se comparten (p. ej. "la wallet está seca" vs
// "no pude leer el balance").
//
// ⚠️ ESTE VOCABULARIO NO SALE POR HTTP AL CALLER. Viaja por el canal de operador
// (`a2a_events.metadata.downstreamSkipCauses` → `/dashboard/trace`, admin-only y
// fail-closed). El contrato público no cambia ni un byte.

/**
 * Qué hay que hacer con un leg que no se pagó, y quién lo hace.
 *
 * ⚠️ DOS DE ESTAS ACCIONES SON EL TERCER VALOR, y existen para que "no pude
 * determinarlo" no se reparta entre "sí" y "no":
 *  · `OPERATOR_BALANCE_UNKNOWN` — no se pudo LEER el balance del operador. NO es
 *    "la wallet está seca": recargar no es la acción, averiguar sí lo es.
 *  · `RECONCILE_ON_CHAIN`       — no se sabe si el pago salió. NO es "no se pagó":
 *    la acción es mirar la cadena, y NUNCA reintentar a ciegas.
 */
export type DownstreamSkipAction =
  /** Nadie actúa: el pago downstream está apagado por configuración, a propósito. */
  | 'NONE_SETTLE_DISABLED'
  /** Operador: la config del deploy es incoherente. Es un incidente. */
  | 'OPERATOR_FIX_CONFIG'
  /** Operador: decisión de DINERO — sumar esa mainnet al opt-in, o no. */
  | 'OPERATOR_DECIDE_MAINNET_OPT_IN'
  /** Dev del gateway: un call-site nuestro no pasó lo que debía. Es un bug de código. */
  | 'OPERATOR_FIX_CODE'
  /** Operador: conectar ese rail, o pedirle al agente que publique en uno soportado. */
  | 'OPERATOR_CONNECT_CHAIN'
  /** Publicador del agente: su agent card está mal. El gateway no tiene nada que arreglar. */
  | 'PUBLISHER_FIX_LISTING'
  /** Operador: recargar la hot wallet de ese rail. */
  | 'OPERATOR_FUND_WALLET'
  /** TERCER VALOR: no se pudo leer el balance. Averiguar, no recargar. */
  | 'OPERATOR_BALANCE_UNKNOWN'
  /** Operador: la clave del operador falta o es inválida. */
  | 'OPERATOR_FIX_KEY'
  /** Operador: el pago fue RECHAZADO. No salió plata; investigar el facilitator. */
  | 'INVESTIGATE_PAYMENT_REJECTED'
  /** TERCER VALOR: puede haberse pagado. Mirar la cadena; NO reintentar. */
  | 'RECONCILE_ON_CHAIN';

/**
 * Mapeo interno → ACCIÓN. **EXHAUSTIVO POR TIPO**, por la misma razón que
 * `PUBLIC_SKIP_CODE`: un `DownstreamSkipCode` nuevo sin decidir a quién despierta
 * NO COMPILA. Sin esto, la HU siguiente agrega un código y cae por descarte en
 * cualquier balde, que es exactamente cómo se armó el `NOT_CONFIGURED` de hoy.
 */
const SKIP_ACTION: Record<DownstreamSkipCode, DownstreamSkipAction> = {
  // ── Los CUATRO que el vocabulario público colapsa en `NOT_CONFIGURED`.
  //    Cuatro acciones distintas, cuatro dueños distintos. Es el motivo de esta tabla.
  FLAG_OFF: 'NONE_SETTLE_DISABLED',
  CHAIN_ENVIRONMENT_DRIFT: 'OPERATOR_FIX_CONFIG',
  MAINNET_NOT_ALLOWED: 'OPERATOR_DECIDE_MAINNET_OPT_IN',
  MISSING_INTENT_ID: 'OPERATOR_FIX_CODE',

  // ── Declaración del agente. Los SEIS comparten acción A PROPÓSITO: en los seis
  //    el gateway está sano y el que corrige es el publicador, editando su card.
  //    El detalle de QUÉ campo está mal ya viaja verbatim en el código público.
  NO_PAYMENT_FIELD: 'PUBLISHER_FIX_LISTING',
  METHOD_NOT_SUPPORTED: 'PUBLISHER_FIX_LISTING',
  INVALID_PAY_TO_FORMAT: 'PUBLISHER_FIX_LISTING',
  ZERO_PAY_TO: 'PUBLISHER_FIX_LISTING',
  INVALID_PRICE: 'PUBLISHER_FIX_LISTING',
  // NO va con los de arriba: acá el que puede resolver es el OPERADOR (conectando
  // el rail). Los otros cinco el operador no los puede arreglar ni queriendo.
  CHAIN_NOT_SUPPORTED: 'OPERATOR_CONNECT_CHAIN',

  // ── Wallet del operador. `INSUFFICIENT_BALANCE` es un HECHO medido (la wallet
  //    está seca ⇒ recargar). Los dos de lectura fallida NO: ahí no se sabe cuánto
  //    hay, y tratarlos como "seca" haría recargar por las dudas cada vez que un
  //    RPC parpadea, además de esconder el RPC caído.
  INSUFFICIENT_BALANCE: 'OPERATOR_FUND_WALLET',
  BALANCE_LOW_ON_IDEMPOTENT_REPLAY: 'OPERATOR_FUND_WALLET',
  BALANCE_READ_FAILED: 'OPERATOR_BALANCE_UNKNOWN',
  BALANCE_PRECHECK_SKIPPED: 'OPERATOR_BALANCE_UNKNOWN',

  SIGNING_FAILED: 'OPERATOR_FIX_KEY',

  // ── Resultado del pago. `SETTLE_FAILED`/`VERIFY_FAILED` afirman que NO se pagó.
  VERIFY_FAILED: 'INVESTIGATE_PAYMENT_REJECTED',
  SETTLE_FAILED: 'INVESTIGATE_PAYMENT_REJECTED',
  // …y estos dos afirman que NO SE SABE, que es una acción opuesta. `SETTLE_UNKNOWN`
  // ya tiene código público propio por esto mismo; `SETTLE_LEDGER_UNAVAILABLE` no lo
  // tiene (se genericiza a `UNAVAILABLE`), y acá recupera su acción real: en los dos
  // casos el leg puede estar pagado y lo que corresponde es mirar la cadena.
  SETTLE_UNKNOWN: 'RECONCILE_ON_CHAIN',
  SETTLE_LEDGER_UNAVAILABLE: 'RECONCILE_ON_CHAIN',
};

/** Clasifica un skip-code interno por la acción que provoca. */
export function toSkipAction(code: DownstreamSkipCode): DownstreamSkipAction {
  return SKIP_ACTION[code];
}

/**
 * Quién actúa y qué hace, en una línea. **EXHAUSTIVO POR TIPO**: una acción nueva
 * sin dueño escrito NO COMPILA. Es el único texto que la pantalla muestra.
 */
const SKIP_ACTION_MEANING: Record<
  DownstreamSkipAction,
  { owner: string; next: string }
> = {
  NONE_SETTLE_DISABLED: {
    owner: 'nadie',
    next: 'El pago downstream está apagado por configuración. Es un estado deliberado, no una falla: si se esperaba que pagara, encender la feature; si no, no hay nada que hacer.',
  },
  OPERATOR_FIX_CONFIG: {
    owner: 'operador (incidente)',
    next: 'La config del deploy se contradice a sí misma: el rail declara un entorno y apunta a otro. Corregir la config del deploy antes de que alguien la opte-in.',
  },
  OPERATOR_DECIDE_MAINNET_OPT_IN: {
    owner: 'operador (decisión de dinero)',
    next: 'Un agente pide cobrar en una mainnet sin opt-in. Es un rechazo SANO, no una falla: decidir si esa red se habilita (plata real) o si el agente publica en otra.',
  },
  OPERATOR_FIX_CODE: {
    owner: 'dev del gateway',
    next: 'Un call-site nuestro invocó el leg sin lo que el leg exige. Es un bug de código, no de config: arreglar el call-site.',
  },
  OPERATOR_CONNECT_CHAIN: {
    owner: 'operador',
    next: 'El agente cobra en una red que este gateway no tiene conectada. Conectar el rail, o pedirle al agente que publique en uno soportado.',
  },
  PUBLISHER_FIX_LISTING: {
    owner: 'publicador del agente',
    next: 'La agent card no dice cómo cobrar, o lo dice mal. El gateway está sano: lo corrige quien publicó el agente.',
  },
  OPERATOR_FUND_WALLET: {
    owner: 'operador',
    next: 'La hot wallet de ese rail no alcanza para el leg. Recargarla.',
  },
  OPERATOR_BALANCE_UNKNOWN: {
    owner: 'operador',
    next: 'NO se pudo leer el balance del operador, así que no se sabe si había fondos. Averiguar por qué no se pudo leer (RPC/env del rail); recargar a ciegas no es la respuesta.',
  },
  OPERATOR_FIX_KEY: {
    owner: 'operador',
    next: 'La firma del operador falló: la clave falta o es inválida en ese rail. Revisar la credencial del deploy.',
  },
  INVESTIGATE_PAYMENT_REJECTED: {
    owner: 'operador',
    next: 'El pago se intentó y fue rechazado: NO salió plata. Investigar el facilitator o el rail.',
  },
  RECONCILE_ON_CHAIN: {
    owner: 'operador (money-path)',
    next: 'NO se sabe si el leg se pagó. Mirar la cadena antes de cualquier otra cosa, y NO reintentar a ciegas.',
  },
};

/** Acciones como lista runtime, derivada de la tabla (sin segunda lista que desincronizar). */
export const DOWNSTREAM_SKIP_ACTIONS = Object.keys(
  SKIP_ACTION_MEANING,
) as DownstreamSkipAction[];

/** Type-guard runtime de la acción (para strings que vuelven de jsonb). */
export function isDownstreamSkipAction(
  value: unknown,
): value is DownstreamSkipAction {
  return typeof value === 'string' && Object.hasOwn(SKIP_ACTION_MEANING, value);
}

/** Quién tiene que actuar ante esta acción (string vacío si no es válida). */
export function describeSkipActionOwner(value: unknown): string {
  return isDownstreamSkipAction(value) ? SKIP_ACTION_MEANING[value].owner : '';
}

/** Qué hay que hacer (string vacío si no es válida). */
export function describeSkipActionNext(value: unknown): string {
  return isDownstreamSkipAction(value) ? SKIP_ACTION_MEANING[value].next : '';
}

/**
 * Significado de cada código PÚBLICO, en una línea, escrito para alguien que
 * conoce el negocio y no el código (WKH-191x, pantalla `/dashboard/trace`).
 *
 * **EXHAUSTIVO POR TIPO** por la misma razón que `PUBLIC_SKIP_CODE`: un código
 * público nuevo sin explicación NO COMPILA. Y es el ÚNICO texto que la pantalla
 * muestra: nunca se serializa un `DownstreamSkipCode` interno, porque varios
 * revelan estado nuestro (fondos del operador, allow-list de mainnet, flags).
 */
const PUBLIC_SKIP_MEANING: Record<PublicDownstreamSkipCode, string> = {
  NO_PAYMENT_FIELD:
    'El agente no declara cómo cobrar, así que no había a dónde pagarle.',
  METHOD_NOT_SUPPORTED:
    'El agente pide un método de pago que este gateway todavía no habla.',
  CHAIN_NOT_SUPPORTED:
    'El agente cobra en una red que este gateway todavía no tiene conectada.',
  INVALID_PAY_TO_FORMAT:
    'La dirección de cobro que publica el agente no tiene un formato válido.',
  ZERO_PAY_TO:
    'El agente publica una dirección de cobro vacía (dirección cero).',
  INVALID_PRICE: 'El precio que publica el agente no es un monto válido.',
  SETTLE_FAILED:
    'Se intentó pagarle al agente y el pago no se pudo confirmar (al caller no se le cobra por este leg).',
  SETTLE_UNKNOWN:
    'Se intentó pagarle al agente y no llegó respuesta a tiempo: el pago puede haberse hecho o no. Queda marcado para revisión y NO se reintenta solo.',
  NOT_CONFIGURED:
    'El gateway no está configurado para pagar ese leg (por eso no se movió dinero).',
  UNAVAILABLE:
    'El gateway no pudo pagar por su propio estado en ese momento; se reintenta en la llamada siguiente.',
};

/**
 * Vocabulario público como lista runtime. Derivado de `PUBLIC_SKIP_MEANING`
 * (keys) para que no exista una segunda lista que se pueda desincronizar.
 */
export const PUBLIC_SKIP_CODES = Object.keys(
  PUBLIC_SKIP_MEANING,
) as PublicDownstreamSkipCode[];

/**
 * Type-guard runtime del vocabulario PÚBLICO. Se usa para validar strings que
 * vienen de `a2a_events.metadata` (jsonb, sin garantía de tipo): un código
 * interno o basura NO pasa, así que no puede llegar a la pantalla.
 */
export function isPublicSkipCode(
  value: unknown,
): value is PublicDownstreamSkipCode {
  // `hasOwn` (no `in`) para que un `constructor` / `toString` heredado del
  // prototipo NO se valide como código.
  return typeof value === 'string' && Object.hasOwn(PUBLIC_SKIP_MEANING, value);
}

/** Explicación de una línea del código público (string vacío si no es válido). */
export function describePublicSkipCode(value: unknown): string {
  return isPublicSkipCode(value) ? PUBLIC_SKIP_MEANING[value] : '';
}

/**
 * Extrae el código PÚBLICO de un `StepResult.downstreamSettle`
 * (`skipped:<PUBLIC_CODE>`), o `null` si el string no tiene esa forma.
 *
 * Vive acá y no en el route para que el prefijo `skipped:` tenga un solo dueño:
 * lo escribe `compose.ts` y lo lee la telemetría del dashboard.
 */
export function parseSkippedMarker(
  value: unknown,
): PublicDownstreamSkipCode | null {
  if (typeof value !== 'string') return null;
  const PREFIX = 'skipped:';
  if (!value.startsWith(PREFIX)) return null;
  const code = value.slice(PREFIX.length);
  return isPublicSkipCode(code) ? code : null;
}

/**
 * Logger que además RETIENE el skip-code. `signAndSettleDownstream` ya loguea
 * `{ code }` en los 25 sitios que devuelven `null`, así que decorar el logger
 * captura el motivo SIN tocar la lógica de decisión de dinero (0 ediciones en
 * los caminos de `return null`).
 */
export interface SkipCodeSink {
  noteSkipCode(code: DownstreamSkipCode): void;
}

/**
 * Registra un skip-code en el sink si el logger es uno capturador; no-op si no.
 *
 * Existe para el ÚNICO sitio que no puede depender del log: `FLAG_OFF` se
 * loguea **una vez por proceso** (dedup WKH-235a), así que a partir del 2º
 * request el decorador no vería nada y la respuesta perdería la señal.
 */
export function noteSkip(
  logger: DownstreamLogger,
  code: DownstreamSkipCode,
): void {
  const sink = logger as Partial<SkipCodeSink>;
  if (typeof sink.noteSkipCode === 'function') sink.noteSkipCode(code);
}

/**
 * Decora un `DownstreamLogger` para capturar el ÚLTIMO skip-code logueado.
 *
 * "Último" es lo correcto: los dos códigos de sólo-observabilidad
 * (`BALANCE_PRECHECK_SKIPPED`, `BALANCE_LOW_ON_IDEMPOTENT_REPLAY`) NO cortan el
 * leg, así que si después el settle falla el terminal los sobreescribe, y si el
 * settle sale bien el caller no consulta el código (sólo lo usa cuando
 * `signAndSettleDownstream` devolvió `null`).
 */
export function createSkipCapturingLogger(
  inner: DownstreamLogger,
): DownstreamLogger &
  SkipCodeSink & { lastSkipCode(): DownstreamSkipCode | undefined } {
  let last: DownstreamSkipCode | undefined;
  const capture = (obj: unknown): void => {
    if (obj && typeof obj === 'object') {
      const code = (obj as { code?: unknown }).code;
      if (typeof code === 'string' && code in PUBLIC_SKIP_CODE) {
        last = code as DownstreamSkipCode;
      }
    }
  };
  return {
    warn: (obj: unknown, msg?: string) => {
      capture(obj);
      inner.warn(obj, msg);
    },
    info: (obj: unknown, msg?: string) => {
      capture(obj);
      inner.info(obj, msg);
    },
    noteSkipCode: (code: DownstreamSkipCode) => {
      last = code;
    },
    lastSkipCode: () => last,
  };
}
