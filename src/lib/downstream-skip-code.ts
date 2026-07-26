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
 * Códigos de skip/observabilidad del leg downstream. TODO valor que salga en el
 * campo `code` de un log de este módulo tiene que estar acá (fix-pack CR-MNR-5:
 * faltaban los tres últimos, que sí se emitían — un tipo incompleto hace que un
 * consumidor de logs crea que la taxonomía está cerrada cuando no lo está).
 *
 * Los tres primeros grupos CORTAN el leg (`return null`); los de observabilidad
 * NO cortan (ver el catálogo en el docstring de `signAndSettleDownstream`).
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
  | 'BALANCE_LOW_ON_IDEMPOTENT_REPLAY';

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
  // Genericizados — config del gateway.
  FLAG_OFF: 'NOT_CONFIGURED',
  CHAIN_ENVIRONMENT_DRIFT: 'NOT_CONFIGURED',
  MAINNET_NOT_ALLOWED: 'NOT_CONFIGURED',
  // Genericizados — wallet / claves / RPC del operador.
  INSUFFICIENT_BALANCE: 'UNAVAILABLE',
  BALANCE_READ_FAILED: 'UNAVAILABLE',
  BALANCE_PRECHECK_SKIPPED: 'UNAVAILABLE',
  BALANCE_LOW_ON_IDEMPOTENT_REPLAY: 'UNAVAILABLE',
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
