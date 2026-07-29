/**
 * Reconciliation Service — WKH-191c · Motor de reconciliación (Wave 0 del EPIC 191).
 *
 * Resuelve, por-intent y tras RE-VERIFICAR on-chain la realidad del hop 1 (evento
 * `Debited`), EXACTAMENTE UN LADO — nunca ambos, nunca ninguno — de forma idempotente:
 *
 *   - `Debited` confirmed → reintenta el hop 2 al seller (seam `settlePaymentIntentOnChain`
 *     DIRECTO, DT-R2) → `resolved_settled`. NO reembolsa el budget.
 *   - `Debited` not_confirmed → refund BUDGET-ONLY (`refund_a2a_key_spend` DENTRO del RPC
 *     `record_reconciliation_resolution`, sin transfer on-chain, sin tocar escrowBalance) →
 *     `resolved_refunded`. PROHIBIDO cualquier transfer operador→buyer (DT-R4/NC-1).
 *   - `Debited` indeterminate → abort: no mueve dinero, queda pending (CD-3).
 *
 * Idempotencia (CD-2): el estado terminal + el refund del budget se persisten ATÓMICAMENTE
 * dentro del RPC status-gated → un retry ve `resolved_*` → no-op. La idempotencia NO se
 * apoya en el nonce EIP-3009 (aleatorio) sino en el state-machine DB (`resolving_*`→`resolved_*`).
 *
 * Además: detección de drift (SOLO reporte, CD-4) entre `budget` off-chain y `escrowBalance`
 * on-chain. NUNCA sobrescribe el budget.
 *
 * Exemplar: payment-intent.ts (seam / error class) + arbiter.ts (service shape).
 */

import { formatUnits } from 'viem';
import { isEscrowSettleEnabled } from '../adapters/escrow/debit-capture.js';
// AR de HU-202, BLOQUEANTE 3: la liberación del lease reusa el ÚNICO escritor del lease
// (ownership guard + resultado discriminado incluidos). Dos escritores del mismo candado
// divergen.
import { recordDebitSettleStatus } from '../adapters/escrow/debit-executor.js';
import {
  readEscrowBalanceAtomic,
  reverifyDebitedByTxHash,
} from '../adapters/escrow/reconciler-onchain.js';
import { resolveEscrowContract } from '../adapters/escrow-verifier.js';
import { getAdaptersBundle, getDefaultChainKey } from '../adapters/registry.js';
import { verifyDefaultChainSettle } from '../adapters/settle-verifier.js';
import { getLogger } from '../lib/logger.js';
// HU-203: la familia de `event_type` que dejan las retenciones de settle. Se importa
// del MISMO módulo que las escribe para que el productor y el lector no puedan
// divergir en el string.
import { SETTLE_UNKNOWN_EVENT_TYPES } from '../lib/settle-withholding.js';
// HU-306: mismo criterio que arriba — el `event_type` y el lector de `metadata` se
// importan del módulo que los ESCRIBE. El lector es defensivo (CD-12): una fila vieja o
// mal formada devuelve campos vacíos, nunca tira, y por lo tanto no puede vaciar la
// lista entera por la puerta de atrás.
import {
  COMPOSE_STRANDED_PAYMENT_EVENT,
  readStrandedMetadata,
} from '../lib/stranded-payment.js';
import { supabase } from '../lib/supabase.js';
import { settlePaymentIntentOnChain } from './payment-intent.js';

const log = getLogger('reconciliation');

// Estados del ciclo de vida que la reconciliación puede tocar (surface del GET).
const PENDING_STATUSES = [
  'hop1_confirmed',
  'reconciliation_pending',
  'resolving_settle',
  'resolving_refund',
] as const;

// Estados contabilizados en el drift (débito off-chain vigente, no reembolsado).
//
// HU-198: se agrega `resolving_settle`. El criterio de esta lista es "el débito del
// hop 1 ESTÁ VIGENTE y no fue reembolsado", y en `resolving_settle` lo está: los
// fondos del buyer ya salieron del escrow (hop 1 confirmado) y no hay refund. Desde
// esta HU ese estado además es DURADERO — `settleEscrowAware` lo usa para el hop 2 de
// resultado desconocido, no sólo como marca transitoria de un run del reconciliador —
// así que omitirlo hacía que el reporte de drift SUB-DECLARARA el débito acumulado
// justamente en los casos que hay que mirar. Un reporte de drift que se calla un caso
// afirma algo falso.
//
// EXCLUSIONES, LAS TRES (AR MNR-2: la versión anterior decía que `resolving_refund` era
// "la única exclusión", y era una afirmación FALSA de completitud — justo el tipo de
// afirmación que este comentario existe para evitar):
//   · `resolving_refund`  — el débito está en curso de ser REVERTIDO (el crédito vive
//     dentro de `record_reconciliation_resolution`), así que contarlo como vigente
//     sería la sub/sobre-declaración simétrica.
//   · `resolved_refunded` — el débito YA se revirtió. Excluido por el mismo criterio.
//   · `resolved_settled`  — el hop 2 se resolvió y el débito quedó consumido; el
//     `settled` de la lista ya cubre el consumo por la vía normal. Se excluye por
//     coherencia con el par `resolving_settle`→`resolved_settled` (contar los dos
//     duplicaría el mismo débito en la suma).
//
// ⚠️ REGRESIÓN DEL ROLLBACK (AR MNR-2, 2ª mitad): el `_down` de la migración
// 20260728000000 NO revierte esta lista (es código, no SQL), pero SÍ deja de escribirse
// `resolving_settle`, así que las filas que quedaron en ese estado siguen contándose
// mientras el código nuevo esté deployado y dejan de aparecer si se revierte el código.
// O sea: revertir el CÓDIGO de HU-198 devuelve el drift a su sub-declaración anterior
// para esas filas. Está anotado en el `_down`; si se revierte, inventariarlas con la
// query que ese archivo trae.
const DRIFT_ACCOUNTED_STATUSES = [
  'hop1_confirmed',
  'settled',
  'reconciliation_pending',
  'resolving_settle',
] as const;

export type ReconciliationErrorCode =
  | 'INTENT_NOT_FOUND'
  | 'NOT_PENDING'
  | 'FLAG_OFF'
  | 'INDETERMINATE'
  | 'SETTLE_FAILED'
  | 'INTERNAL';

/** Error disclosure-safe (patrón `PaymentIntentError`). El route mapea `code`→HTTP. */
export class ReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;
  constructor(code: ReconciliationErrorCode) {
    super(code);
    this.name = 'ReconciliationError';
    this.code = code;
  }
}

export interface PendingRow {
  intent_id: string;
  key_id: string;
  nonce: string;
  debit_hop1_tx_hash: string | null;
  finalAmountUsd: string;
  owner_ref: string;
  debit_settle_status: string;
  /**
   * HU-202 — CUÁNDO se intentó el hop 2, o `null` si no se intentó nunca.
   *
   * POR QUÉ VIAJA EN LA LISTA (la superficie es parte del fix, no un extra): desde el
   * lease, una fila `resolving_settle` puede ser DOS cosas radicalmente distintas y hasta
   * acá indistinguibles:
   *   · un settle EN VUELO, sano, de hace 2 segundos — no hay nada que hacer;
   *   · un hop 2 de resultado DESCONOCIDO de hace 40 minutos — plata parada que necesita
   *     que un humano vaya a la cadena.
   * Sin este dato las dos se ven igual, la lista se llena de ruido transitorio y deja de
   * mirarse — que es exactamente el modo de falla que HU-201 documentó ("un estado que no
   * auto-actúa y que nadie lista es plata retenida en silencio"), sólo que por saturación
   * en vez de por omisión.
   *
   * `null` con `debit_settle_status='resolving_settle'` es legítimo y significa una fila
   * anterior a HU-202 (o escrita por el RPC viejo): no afirma "no se intentó", afirma
   * "no hay registro". Se distingue por `debit_hop1_tx_hash` + la cadena, no por esta
   * columna.
   */
  hop2_attempted_at: string | null;
}

export type ResolveStatus =
  | 'flag_off'
  | 'indeterminate'
  | 'already_resolved'
  /**
   * AR BLQ-BAJO-1 — HU-198 volvió `resolving_settle` un estado DURABLE, y eso rompió
   * el significado de `already_resolved` para la única herramienta que el humano
   * tiene. El diseño delega en "que una persona lo resuelva", pero
   * `POST /dashboard/api/reconciliation/:id/resolve` contestaba
   * `200 {"status":"already_resolved"}` para una fila que NO está resuelta y que
   * contiene plata posiblemente duplicada: el claim devuelve `claimed=false` (por
   * diseño, para no re-enviar el hop 2 a ciegas) y ese `false` se traducía al mismo
   * "ya está" que una fila terminal.
   *
   * Este estado distingue el caso: el intent está ESPERANDO EVIDENCIA del hop 2
   * (`resolving_settle` + `debit_resolution_tx_hash IS NULL`). No hay nada que el
   * reconciliador automático pueda hacer con él — hay que ir a la cadena, encontrar
   * si el hop 2 pagó, y resolverlo con esa evidencia.
   */
  | 'awaiting_manual_settle_evidence'
  | 'settle_failed'
  | 'settled'
  | 'refunded';

export interface ResolveOutcome {
  status: ResolveStatus;
  side?: 'settle' | 'refund';
  txHash?: string | null;
}

/**
 * AR de HU-202, BLOQUEANTE 3 — LA PUERTA DE SALIDA DE UNA FILA LEASEADA.
 *
 * ── EL AGUJERO ──────────────────────────────────────────────────────────────
 *
 * HU-202 cerró el re-envío ciego, pero no le dejó a la fila leaseada ninguna forma
 * soportada de salir: no hay vencimiento, no hay renovación, no hay liberación por caída,
 * y NINGUNA operación del servicio la destraba. El escenario no necesita nada raro: se
 * toma el lease, sale el hop 2, y el proceso se reinicia (un deploy, un restart rotativo).
 * La fila queda `resolving_settle` + estampada + sin `debit_resolution_tx_hash`, o sea que
 * `claim_reconciliation` la rechaza POR DISEÑO — ningún reintento, ningún click y ningún
 * barrido pueden volver a tocarla. El seller no cobra nunca.
 *
 * Peor: `resolveIntent` contesta `awaiting_manual_settle_evidence` con la instrucción
 * "revisá la cadena y resolvé con esa evidencia", y ese verbo NO EXISTÍA. El único remedio
 * real era un `UPDATE` a mano contra producción.
 *
 * ── LAS DOS SALIDAS, Y POR QUÉ SON DOS ──────────────────────────────────────
 *
 * La pregunta que destraba la fila es "¿el hop 2 le pagó al seller?", y tiene dos
 * respuestas con calidades de evidencia OPUESTAS, así que no pueden compartir un verbo:
 *
 *   (1) SÍ, Y ACÁ ESTÁ EL HASH → `resolveWithHop2Evidence`. La afirmación del operador NO
 *       se cree: el hash se VERIFICA on-chain (`verifyDefaultChainSettle`, el mismo lector
 *       que usa el crash-recovery) contra `pay_to` y el monto atómico exacto. Recién si la
 *       cadena confirma, la fila se cierra `resolved_settled` con el hash persistido. Un
 *       hash que no verifica NO cierra nada.
 *
 *   (2) NO HAY DESEMBOLSO EN LA CADENA → `releaseHop2Lease`. Acá no hay hash que
 *       verificar: es la afirmación de un NEGATIVO, y este repo no tiene con qué probarlo
 *       (haría falta el lector de `authorizationState`, TD-201-01, que además no aplica en
 *       `pieverse`). Así que se trata como lo que es: una ATESTACIÓN humana, autenticada,
 *       auditada y con `resolvedBy`+`note` OBLIGATORIOS. Libera el lease bajándolo a
 *       `reconciliation_pending` (que limpia el stamp) ⟹ la fila vuelve a ser
 *       auto-reclamable ⟹ el reconciliador re-envía y el seller cobra.
 *
 * ⚠️ POR QUÉ NO HAY —NI PUEDE HABER— UNA LIBERACIÓN POR TEMPORIZADOR. Un TTL que devuelve
 * la fila al pool sin que nadie mire la cadena reabre EXACTAMENTE el caso (F): el hop 2
 * pudo haber aterrizado y el re-envío paga dos veces. El lease no expira porque el hecho
 * que representa —"se mandó un pago cuyo resultado no conocemos"— tampoco expira. Lo único
 * que puede resolverlo es evidencia, y la evidencia la trae la cadena o una persona.
 */
export interface Hop2EvidenceInput {
  /** Hash del hop 2 a verificar. Se verifica; no se confía. */
  txHash: string;
  /** Quién resuelve. Obligatorio: sin esto la acción no es auditable. */
  resolvedBy: string;
  note?: string | null;
}

export interface ReleaseLeaseInput {
  /** Quién atesta el negativo. Obligatorio. */
  resolvedBy: string;
  /** Qué se miró para concluir que no hubo desembolso. Obligatorio. */
  note: string;
}

export type Hop2EvidenceStatus =
  | 'flag_off'
  /** No hay ninguna fila leaseada sin resolver para este intent. */
  | 'not_leased'
  /** El RPC no pudo decidir (nodo caído) → NO se escribió nada, reintentable. */
  | 'indeterminate'
  /** La cadena NO respalda el hash: no paga a `pay_to` el monto exacto. */
  | 'evidence_rejected'
  /** Verificado on-chain y cerrado `resolved_settled`. */
  | 'settled'
  /** Lease liberado; la fila vuelve al reconciliador. */
  | 'lease_released';

export interface Hop2EvidenceOutcome {
  status: Hop2EvidenceStatus;
  txHash?: string | null;
  reason?: string;
}

export interface DriftRow {
  key_id: string;
  sumDebitedAtomic: string;
  escrowBalanceAtomic: string | null;
  budgetUsd: string | null;
  deltaAtomic: string | null;
  exceedsThreshold: boolean;
}

/**
 * HU-201 (AR BLQ-MEDIO-2) — una fila `failed_ambiguous` del camino NO-ESCROW.
 *
 * POR QUÉ EXISTE ESTE TIPO: HU-201 mandó los HTTP non-2xx del facilitator a
 * `ambiguous` ⟹ `failed_ambiguous` ⟹ **el deposit del buyer NO se reembolsa**. Esa
 * decisión es correcta (un 502 puede llegar después del broadcast) pero tenía un
 * costo que el AR encontró y que invalidaba el fix: en el camino no-escrow —que es el
 * DEFAULT, porque `ESCROW_SETTLE_ENABLED` exige `=== 'true'`— esas filas eran
 * INVISIBLES.
 *
 *   · `listPending()` lee `a2a_payment_intent_debit_signatures`, y sin escrow esa fila
 *     NO EXISTE.
 *   · `resolveIntent()` arranca con `if (!isEscrowSettleEnabled()) return flag_off`.
 *   · Único rastro: `error_message` en texto libre y un `log.warn`.
 *
 * O sea que el fix cambiaba "reembolso indebido RUIDOSO" por "retención SILENCIOSA".
 * Y el modo de falla no es hipotético: ya ocurrió en este repo (el facilitator
 * exigiendo un Bearer que el adapter no mandaba ⟹ 401 en el 100% de los settles).
 * Antes era ruidoso pero AUTO-SANANTE: todos los buyers recuperaban su deposit. Con
 * HU-201 sería el 100% de los deposits retenidos y nadie mirando.
 *
 * ESTA LISTA ES SÓLO LECTURA. No resuelve nada: no hay resolución automática posible
 * sin poder responder "¿el broadcast aterrizó?", y eso se contesta on-chain
 * (`authorizationState(from, nonce)` del token es un `view` público), no por HTTP. Ese
 * lector NO existe hoy en el repo y es una HU propia (TD-201-01). Hasta entonces, la
 * acción es humana y esta lista es el lugar donde se ve.
 */
export interface AmbiguousIntentRow {
  intent_id: string;
  owner_ref: string;
  key_id: string;
  intent_type: string;
  status: string;
  chain_id: number;
  pay_to: string;
  authorizedUsd: string;
  consumedUsd: string;
  settle_outcome: string;
  /**
   * Texto libre — pero es DONDE VIVE EL HASH. Cuando el facilitator contestó
   * `success:false` CON un txHash, `settlePaymentIntentOnChain` lo mete en el mensaje
   * (`settle failed WITH a broadcast hash (0x…)`) porque no hay columna para él. Es la
   * pista con la que un humano cruza contra la cadena. Ver TD-201-02.
   */
  error_message: string | null;
  updated_at: string;
}

/**
 * Resultado de `listAmbiguous`. Trae `total` A PROPÓSITO: la query está acotada por
 * `limit`, y una lista truncada EN SILENCIO sobre plata retenida sería la misma
 * afirmación falsa de completitud que este archivo ya documenta para el drift. Si
 * `total > rows.length`, el consumidor lo ve.
 */
export interface AmbiguousReport {
  rows: AmbiguousIntentRow[];
  total: number;
  truncated: boolean;
  /**
   * HU-203: la MISMA pregunta ("¿qué plata no devolvimos porque el settle pudo haber
   * salido?") sobre el otro modelo de datos. Va ADENTRO de este reporte, y no en una
   * cola aparte, a propósito: dos listas separadas de plata retenida se miran por
   * turnos y una de las dos termina sin mirar.
   */
  settleUnknown: SettleUnknownReport;
  /**
   * HU-306: la TERCERA pregunta del mismo panel — "¿qué pagos ya confirmados quedaron
   * varados porque el pipeline falló después?". Va anidada acá, y no en un endpoint
   * propio, por el MISMO motivo que `settleUnknown`: tres listas de plata en tres
   * pantallas distintas se miran por turnos y siempre hay una que no se mira.
   */
  strandedRuns: StrandedRunsReport;
}

/**
 * HU-203 — una retención de settle del camino de EVENTOS (no de payment intents).
 *
 * POR QUÉ NO ES UNA `AmbiguousIntentRow`: `listAmbiguous` lee
 * `a2a_payment_intents.settle_outcome`, y el camino del budget de la agent key
 * (`compose` / `orchestrate`) NO crea payment intents — debita contra
 * `a2a_agent_keys` y ahí no hay fila de intent donde escribir un veredicto. Meter
 * ambos en el mismo array obligaría a inventarle un `intent_id` a algo que no lo
 * tiene. Sin migración: el registro durable es la fila de `a2a_events` que ya emiten
 * `middleware/x402.ts` (inbound, HU-201) y `services/compose.ts` /
 * `services/orchestrate.ts` (outbound, HU-203).
 *
 * ESTA LISTA ES SÓLO LECTURA, igual que `AmbiguousIntentRow`: no hay resolución
 * automática posible sin poder contestar "¿el broadcast aterrizó?", y eso se contesta
 * on-chain, no por HTTP.
 */
export interface SettleUnknownEventRow {
  event_id: string;
  /** `x402_settle_unknown` (inbound) o `compose_settle_unknown` (outbound). */
  event_type: string;
  agent_id: string | null;
  /** La evidencia de broadcast cuando el facilitator nos la dio; `null` si no contestó. */
  tx_hash: string | null;
  /**
   * `a2a_events.cost_usdc` verbatim: el monto que NO se le devolvió al caller en ESE
   * punto. Vale `'0'` en las filas inbound (`x402_settle_unknown`), donde no hubo
   * débito de budget que retener y el monto del cobro vive en `metadata.requiredAmount`
   * en unidades atómicas. `::text` por la convención WKH-196 para columnas NUMERIC.
   */
  costUsdc: string;
  /** Dónde está el resto del contexto (nonce, key_id, owner_ref, chain_id, motivo). */
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Mismo contrato de completitud que `AmbiguousReport` y por el mismo motivo. */
export interface SettleUnknownReport {
  rows: SettleUnknownEventRow[];
  total: number;
  truncated: boolean;
}

/**
 * HU-306 — un step que YA PAGÓ on-chain dentro de un run que después falló.
 *
 * La forma la define el leaf (`lib/stranded-payment.ts`), que es quien la escribe en
 * `metadata.paid_steps[]` y quien la vuelve a leer: una segunda definición acá sería
 * una copia que diverge el día que se agregue un campo, y el que diverja sería
 * justamente el lado que reconcilia dinero.
 */
export type { StrandedPaidStep } from '../lib/stranded-payment.js';

/**
 * HU-306 — un RUN de `/compose` que falló dejando pagos ya confirmados on-chain.
 *
 * POR QUÉ NO ES UNA `SettleUnknownEventRow` (CD-8): son dos preguntas distintas sobre
 * dinero distinto. `compose_settle_unknown` dice "el settle quedó SIN RESOLVER y no
 * devolvimos la plata" — se reconcilia mirando la cadena. Esta fila dice "el settle SE
 * CONFIRMÓ y el pipeline falló DESPUÉS" — no hay nada que reconciliar contra la cadena,
 * la plata se fue y lo que queda es contarla y ver si crece. Mezclarlas en la misma lista
 * obligaría al operador a distinguir a mano dos acciones opuestas.
 *
 * SOLO LECTURA (AC-7): no hay remediación automática posible ni deseable — el pago ya
 * está minado y el destinatario es un tercero.
 */
export interface StrandedRunRow {
  event_id: string;
  /** La evidencia del PRIMER step pagado del run; la lista completa va en `paidSteps`. */
  tx_hash: string | null;
  /**
   * `a2a_events.cost_usdc` verbatim (`::text`, convención WKH-196): el total en USD que
   * el caller pagó por los steps que sí se ejecutaron y ya no vuelve.
   */
  costUsdc: string;
  /** `metadata` VERBATIM: es la fuente para reconciliar y no se recorta al mapear. */
  metadata: Record<string, unknown> | null;
  created_at: string;
  // ── Derivados de `metadata`, leídos con `readStrandedMetadata` (defensivo, CD-12) ──
  /** Id del run; `null` si la fila es vieja o el JSON no lo trae. */
  runId: string | null;
  /** Índice del step que rompió el pipeline; `null` si no se puede leer. */
  failedStepIndex: number | null;
  /** Los steps que pagaron. `[]` ante una forma inesperada — nunca voltea la fila. */
  paidSteps: StrandedPaidStepRow[];
}

/** Alias local del tipo del leaf (evita repetir el import en la firma de arriba). */
type StrandedPaidStepRow =
  import('../lib/stranded-payment.js').StrandedPaidStep;

/** Mismo contrato de completitud que `SettleUnknownReport` y por el mismo motivo. */
export interface StrandedRunsReport {
  rows: StrandedRunRow[];
  total: number;
  truncated: boolean;
}

/** Techo de filas del reporte ambiguo (el `total` exacto viaja igual). */
const AMBIGUOUS_LIST_LIMIT = 500;

// ── Row shapes de las queries (subset tipado a mano) ──────────────

interface IntentEmbed {
  pay_to: string;
  chain_id: number;
  owner_ref: string;
}

/** Fila del SELECT de `resolveIntent` (con el hash de key y el embed del intent). */
interface SigWithIntentRow {
  intent_id: string;
  key_id: string;
  debit_key_id_hash: string;
  debit_nonce: string;
  debit_amount_atomic: string;
  debit_hop1_tx_hash: string | null;
  debit_settle_status: string;
  /**
   * AR BLQ-BAJO-1: se agrega al SELECT porque el `claimed=false` necesita distinguir
   * "ya resuelto" de "esperando evidencia del hop 2" (`resolving_settle` SIN tx). El
   * tipo refleja exactamente las columnas pedidas (misma regla que `PendingSelectRow`),
   * así que agregar el campo acá OBLIGA a agregarlo al select — tsc lo cazó.
   */
  debit_resolution_tx_hash: string | null;
  owner_ref: string;
  a2a_payment_intents: IntentEmbed | IntentEmbed[] | null;
}

/**
 * Fila del SELECT de `listPending` (subset REAL seleccionado — CR MNR-2). NO trae
 * `debit_key_id_hash` ni el join `a2a_payment_intents`; el tipo refleja exactamente las
 * columnas pedidas para no prometer campos ausentes en runtime.
 */
interface PendingSelectRow {
  intent_id: string;
  key_id: string;
  debit_nonce: string;
  debit_amount_atomic: string;
  debit_hop1_tx_hash: string | null;
  debit_settle_status: string;
  owner_ref: string;
  /** HU-202: el stamp del lease del hop 2 (migración 20260729000000). */
  debit_hop2_attempted_at: string | null;
}

/**
 * Fila del SELECT de `listAmbiguous` (subset REAL, misma regla que `PendingSelectRow`).
 * Los NUMERIC vienen con `::text` — convención del repo desde WKH-196: PostgREST los
 * entrega como número JSON y `JSON.parse` redondea, así que el cast es obligatorio en
 * cualquier columna NUMERIC de un money-path.
 */
interface AmbiguousSelectRow {
  id: string;
  owner_ref: string;
  key_id: string;
  intent_type: string;
  status: string;
  chain_id: number;
  pay_to: string;
  authorized_usd: string;
  consumed_usd: string;
  settle_outcome: string;
  error_message: string | null;
  updated_at: string;
}

/**
 * Fila del SELECT de `listSettleUnknown` (subset REAL, misma regla que
 * `PendingSelectRow`). `cost_usdc` es NUMERIC ⟹ `::text` (convención WKH-196).
 */
interface SettleUnknownSelectRow {
  id: string;
  event_type: string;
  agent_id: string | null;
  tx_hash: string | null;
  cost_usdc: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Fila del SELECT de `listStrandedRuns` (HU-306). Misma regla que `PendingSelectRow`: el
 * tipo refleja EXACTAMENTE las columnas pedidas. No trae `event_type` ni `agent_id` — el
 * filtro ya fija el primero y el segundo es NULL a propósito en esta familia de eventos
 * (ver `buildStrandedPaymentEvent`: el agente culpable se recupera por join, no se
 * adivina). `cost_usdc` es NUMERIC ⟹ `::text` (WKH-196).
 */
interface StrandedRunSelectRow {
  id: string;
  tx_hash: string | null;
  cost_usdc: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface DriftSigRow {
  key_id: string;
  debit_key_id_hash: string;
  debit_amount_atomic: string;
  owner_ref: string;
  a2a_payment_intents: { chain_id: number } | { chain_id: number }[] | null;
}

/** Normaliza el embed PostgREST (to-one puede llegar como objeto o array 0-1). */
function firstEmbed<T>(embed: T | T[] | null): T | null {
  if (embed === null) return null;
  return Array.isArray(embed) ? (embed[0] ?? null) : embed;
}

/**
 * AR de HU-202, BLOQUEANTE 3 — lee LA fila que quedó sin puerta de salida: el lease tomado
 * y sin resolver. Compartida por las dos salidas para que no puedan discrepar sobre a qué
 * filas aplican.
 *
 * ⚠️ EL CRITERIO ES `resolving_settle` + SIN `debit_resolution_tx_hash`, Y **NO** INCLUYE
 * `debit_hop2_attempted_at IS NOT NULL` A PROPÓSITO. Una fila escrita antes de la migración
 * 20260729000000 (o por el RPC viejo) puede estar `resolving_settle` con el stamp en NULL, y
 * está IGUAL de trabada: el `WHERE` de `claim_reconciliation` la rechaza por la rama del
 * status. Exigir el stamp dejaría exactamente a esas filas —las más viejas, las que más
 * tiempo llevan paradas— sin salida soportada, que es el bug que esto viene a cerrar.
 *
 * Devuelve `null` si no hay tal fila: el caller contesta `not_leased` y no escribe nada.
 */
async function readLeasedRow(
  intentId: string,
): Promise<{ row: SigWithIntentRow; intent: IntentEmbed } | null> {
  const { data, error } = await supabase
    .from('a2a_payment_intent_debit_signatures')
    .select(
      'intent_id, key_id, debit_key_id_hash, debit_nonce::text, debit_amount_atomic::text, ' +
        'debit_hop1_tx_hash, debit_resolution_tx_hash, debit_settle_status, owner_ref, ' +
        'a2a_payment_intents!inner(pay_to, chain_id, owner_ref)',
    )
    .eq('intent_id', intentId)
    .eq('debit_validation_status', 'valid')
    .eq('debit_settle_status', 'resolving_settle')
    .is('debit_resolution_tx_hash', null)
    .maybeSingle();
  if (error) {
    log.error({ intentId, detail: error.message }, 'readLeasedRow failed');
    throw new ReconciliationError('INTERNAL');
  }
  const row = data as unknown as SigWithIntentRow | null;
  if (!row) return null;
  const intent = firstEmbed(row.a2a_payment_intents);
  if (!intent) return null;
  return { row, intent };
}

/** Umbral atomic del drift (env; default 0 → reporta cualquier delta ≠ 0). */
function getDriftThresholdAtomic(): bigint {
  const raw = process.env.RECONCILE_DRIFT_ALERT_THRESHOLD_ATOMIC;
  if (!raw || raw.trim() === '') return 0n;
  try {
    const n = BigInt(raw.trim());
    return n < 0n ? -n : n;
  } catch {
    return 0n;
  }
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export const reconciliationService = {
  /**
   * AC-1: lista los intents con hop 1 movido/ambiguo pero settle no resuelto (surface
   * read-only del panel admin). Cross-tenant DELIBERADO (patrón `listHolds`): sin filtro
   * `owner_ref`, superficie de ALTO PRIVILEGIO gateada por `requireAdminToken` en la ruta.
   */
  async listPending(): Promise<PendingRow[]> {
    const chainKey = getDefaultChainKey();
    const bundle = chainKey ? getAdaptersBundle(chainKey) : undefined;
    const decimals = bundle?.payment.supportedTokens[0]?.decimals ?? 6;

    const { data, error } = await supabase
      .from('a2a_payment_intent_debit_signatures')
      .select(
        'intent_id, key_id, debit_nonce::text, debit_amount_atomic::text, debit_hop1_tx_hash, ' +
          // HU-202: `debit_hop2_attempted_at` es lo que separa un settle EN VUELO de un
          // hop 2 parado — las dos aparecen como `resolving_settle`.
          'debit_settle_status, debit_hop2_attempted_at, owner_ref',
      )
      .eq('debit_validation_status', 'valid')
      .in('debit_settle_status', [...PENDING_STATUSES]);
    if (error) {
      log.error({ detail: error.message }, 'listPending query failed');
      throw new ReconciliationError('INTERNAL');
    }
    const rows = (data as unknown as PendingSelectRow[] | null) ?? [];
    return rows.map((r) => ({
      intent_id: r.intent_id,
      key_id: r.key_id,
      nonce: r.debit_nonce,
      debit_hop1_tx_hash: r.debit_hop1_tx_hash,
      finalAmountUsd: formatUnits(BigInt(r.debit_amount_atomic), decimals),
      owner_ref: r.owner_ref,
      debit_settle_status: r.debit_settle_status,
      hop2_attempted_at: r.debit_hop2_attempted_at ?? null,
    }));
  },

  /**
   * HU-201 (AR BLQ-MEDIO-2): los intents con veredicto `failed_ambiguous` — el buyer
   * NO fue reembolsado y el resultado del settle es DESCONOCIDO. Ver
   * `AmbiguousIntentRow` para el por qué.
   *
   * NO gateada por `isEscrowSettleEnabled()` A PROPÓSITO, y ése es todo el punto: el
   * camino que produce estas filas es el NO-escrow, o sea justo el que corre con el
   * flag OFF. Gatearla la volvería a dejar vacía exactamente cuando importa.
   *
   * Cross-tenant DELIBERADO (mismo patrón y misma justificación que `listPending`):
   * sin filtro `owner_ref`, superficie de ALTO PRIVILEGIO gateada por
   * `requireAdminToken` en la ruta.
   */
  async listAmbiguous(): Promise<AmbiguousReport> {
    const { data, error, count } = await supabase
      .from('a2a_payment_intents')
      .select(
        'id, owner_ref, key_id, intent_type, status, chain_id, pay_to, ' +
          'authorized_usd::text, consumed_usd::text, settle_outcome, ' +
          'error_message, updated_at',
        { count: 'exact' },
      )
      .eq('settle_outcome', 'failed_ambiguous')
      .order('updated_at', { ascending: false })
      .limit(AMBIGUOUS_LIST_LIMIT);
    if (error) {
      log.error({ detail: error.message }, 'listAmbiguous query failed');
      throw new ReconciliationError('INTERNAL');
    }
    const rows = (data as unknown as AmbiguousSelectRow[] | null) ?? [];
    const total = count ?? rows.length;
    // HU-203: SECUENCIAL a propósito, no `Promise.all`. Con las dos promesas en vuelo,
    // un fallo de la primera deja la segunda como unhandled rejection; en serie, el
    // primer fallo tira y nunca se emite una lista a medias. Es un endpoint admin de
    // sólo lectura: la latencia extra no le cuesta nada a nadie.
    const settleUnknown = await this.listSettleUnknown();
    // HU-306: SECUENCIAL por el mismo motivo que la anterior (un fallo en vuelo dejaría
    // una rejection sin manejar) y SIN `try` alrededor: si esta query falla, el error
    // TIENE que subir. Un `catch` que devolviera la lista a medias diría "no hay pagos
    // varados" cuando la verdad es "no pudimos saberlo" (AC-4).
    const strandedRuns = await this.listStrandedRuns();
    return {
      settleUnknown,
      strandedRuns,
      rows: rows.map((r) => ({
        intent_id: r.id,
        owner_ref: r.owner_ref,
        key_id: r.key_id,
        intent_type: r.intent_type,
        status: r.status,
        chain_id: r.chain_id,
        pay_to: r.pay_to,
        authorizedUsd: r.authorized_usd,
        consumedUsd: r.consumed_usd,
        settle_outcome: r.settle_outcome,
        error_message: r.error_message,
        updated_at: r.updated_at,
      })),
      total,
      truncated: total > rows.length,
    };
  },

  /**
   * HU-203: los settles cuyo resultado quedó SIN RESOLVER y por los que NO se devolvió
   * la plata. Se sirve dentro de `listAmbiguous()` (ver `AmbiguousReport.settleUnknown`).
   *
   * Cubre los DOS lados, y el inbound entra acá porque hasta HU-203 no lo listaba nadie:
   *   · `x402_settle_unknown`    — caller → gateway (`middleware/x402.ts`, HU-201).
   *   · `compose_settle_unknown` — gateway → agente (`services/compose.ts` y
   *     `services/orchestrate.ts`, HU-203), incluido el `refund_withheld:false` del
   *     step 0, que no retiene nada por sí mismo pero deja constancia del settle sin
   *     resolver.
   *
   * Las tres invariantes de `listAmbiguous` valen igual y por los mismos motivos:
   *   1. NO gateada por `isEscrowSettleEnabled()` — los caminos que producen estas
   *      filas no tienen NADA que ver con el escrow y corren siempre;
   *   2. `total` exacto + `truncated` — una lista de plata retenida que se corta en
   *      silencio afirma algo falso sobre su propia completitud;
   *   3. un error de query TIRA en vez de devolver `[]` — una lista vacía por fallo
   *      mentiría "no hay nada retenido", que es la peor respuesta posible acá.
   *
   * Cross-tenant DELIBERADO (mismo patrón que `listPending`/`listAmbiguous`): superficie
   * de ALTO PRIVILEGIO gateada por `requireAdminToken` en la ruta.
   *
   * ⚠️ TD-203-01: `a2a_events` no tiene índice por `event_type` (ver
   * `supabase/migrations/20260404200000_events.sql`), así que este filtro + el
   * `count:'exact'` escanean la tabla de telemetría. Hoy es aceptable —es un endpoint
   * admin, sin rate limit y de baja frecuencia— pero cuando la tabla crezca conviene un
   * índice parcial sobre `event_type IN (...)`. Requiere migración, así que queda fuera
   * de esta HU.
   */
  async listSettleUnknown(): Promise<SettleUnknownReport> {
    const { data, error, count } = await supabase
      .from('a2a_events')
      .select(
        'id, event_type, agent_id, tx_hash, cost_usdc::text, metadata, created_at',
        { count: 'exact' },
      )
      .in('event_type', [...SETTLE_UNKNOWN_EVENT_TYPES])
      .order('created_at', { ascending: false })
      .limit(AMBIGUOUS_LIST_LIMIT);
    if (error) {
      log.error({ detail: error.message }, 'listSettleUnknown query failed');
      throw new ReconciliationError('INTERNAL');
    }
    const rows = (data as unknown as SettleUnknownSelectRow[] | null) ?? [];
    const total = count ?? rows.length;
    return {
      rows: rows.map((r) => ({
        event_id: r.id,
        event_type: r.event_type,
        agent_id: r.agent_id,
        tx_hash: r.tx_hash,
        costUsdc: r.cost_usdc ?? '0',
        metadata: r.metadata,
        created_at: r.created_at,
      })),
      total,
      truncated: total > rows.length,
    };
  },

  /**
   * HU-306 (AC-2/AC-3/AC-4): los runs de `/compose` que fallaron DESPUÉS de que algún
   * step ya había cobrado on-chain. Se sirve dentro de `listAmbiguous()`
   * (`AmbiguousReport.strandedRuns`).
   *
   * ⛔ NO se mezcla con `listSettleUnknown` (CD-8). Filtra por SU PROPIO `event_type` y
   * la otra lista sigue filtrando por los suyos: son dos preguntas con dos acciones
   * humanas opuestas ("reconciliar contra la cadena" vs "esto ya se fue, contalo").
   * Meter este `event_type` en `SETTLE_UNKNOWN_EVENT_TYPES` corrompería la lista de
   * HU-203 con filas que no hay que reconciliar.
   *
   * Hereda las TRES invariantes de `listAmbiguous`/`listSettleUnknown`, y ninguna se
   * puede debilitar:
   *   1. NO gateada por `isEscrowSettleEnabled()` — el camino que produce estas filas es
   *      el no-escrow, o sea justo el que corre con el flag OFF;
   *   2. `total` exacto (`count:'exact'`) + `truncated` — una lista de plata que se
   *      corta en silencio afirma algo falso sobre su propia completitud;
   *   3. un error de query TIRA en vez de devolver `[]` — "no hay nada varado" es la
   *      peor mentira posible en esta superficie.
   *
   * `cost_usdc::text` es obligatorio (WKH-196): PostgREST entrega los NUMERIC como
   * número JSON y `JSON.parse` redondea.
   *
   * ⚠️ TD-203-01 vale igual acá: `a2a_events` no tiene índice por `event_type`.
   */
  async listStrandedRuns(): Promise<StrandedRunsReport> {
    const { data, error, count } = await supabase
      .from('a2a_events')
      .select('id, tx_hash, cost_usdc::text, metadata, created_at', {
        count: 'exact',
      })
      .eq('event_type', COMPOSE_STRANDED_PAYMENT_EVENT)
      .order('created_at', { ascending: false })
      .limit(AMBIGUOUS_LIST_LIMIT);
    if (error) {
      log.error({ detail: error.message }, 'listStrandedRuns query failed');
      throw new ReconciliationError('INTERNAL');
    }
    const rows = (data as unknown as StrandedRunSelectRow[] | null) ?? [];
    const total = count ?? rows.length;
    return {
      rows: rows.map((r) => {
        // Defensivo por fila: una `metadata` inesperada degrada ESA fila, no la lista.
        const parsed = readStrandedMetadata(r.metadata);
        return {
          event_id: r.id,
          tx_hash: r.tx_hash,
          costUsdc: r.cost_usdc ?? '0',
          metadata: r.metadata,
          created_at: r.created_at,
          runId: parsed.runId,
          failedStepIndex: parsed.failedStepIndex,
          paidSteps: parsed.paidSteps,
        };
      }),
      total,
      truncated: total > rows.length,
    };
  },

  /**
   * AC-2..AC-6: resuelve exactly-one-side un intent pending. El gate del flag vive
   * ACÁ (AC-8/CD-6): con `ESCROW_SETTLE_ENABLED` OFF → `flag_off`, cero lectura de dinero.
   */
  async resolveIntent(intentId: string): Promise<ResolveOutcome> {
    // 1. Gate flag (AC-8/CD-6). Cero side-effect ni lectura de dinero.
    if (!isEscrowSettleEnabled()) return { status: 'flag_off' };

    // 2. Leer la fila (firma valid en estado pending + campos del intent).
    const chainKey = getDefaultChainKey();
    const bundle = chainKey ? getAdaptersBundle(chainKey) : undefined;
    const decimals = bundle?.payment.supportedTokens[0]?.decimals ?? 6;
    const escrowContract = chainKey ? resolveEscrowContract(chainKey) : null;

    const { data, error } = await supabase
      .from('a2a_payment_intent_debit_signatures')
      .select(
        'intent_id, key_id, debit_key_id_hash, debit_nonce::text, debit_amount_atomic::text, ' +
          // AR BLQ-BAJO-1: `debit_resolution_tx_hash` es lo que separa "esperando
          // evidencia del hop 2" de "ya resuelto" cuando el claim devuelve false.
          'debit_hop1_tx_hash, debit_resolution_tx_hash, debit_settle_status, owner_ref, ' +
          'a2a_payment_intents!inner(pay_to, chain_id, owner_ref)',
      )
      .eq('intent_id', intentId)
      .eq('debit_validation_status', 'valid')
      .in('debit_settle_status', [...PENDING_STATUSES])
      .maybeSingle();
    if (error) {
      log.error(
        { intentId, detail: error.message },
        'resolveIntent read failed',
      );
      throw new ReconciliationError('INTERNAL');
    }
    const row = data as unknown as SigWithIntentRow | null;
    if (!row) throw new ReconciliationError('NOT_PENDING');
    const intent = firstEmbed(row.a2a_payment_intents);
    if (!intent) throw new ReconciliationError('NOT_PENDING');

    // owner_ref REAL leído del intent (CD-8, nunca asumido por el caller admin).
    const ownerRef = intent.owner_ref;
    const keyId = row.key_id;
    const nonce = row.debit_nonce;
    const payTo = intent.pay_to;
    const chainId = intent.chain_id;
    const finalAmountUsd = Number(
      formatUnits(BigInt(row.debit_amount_atomic), decimals),
    );

    // 3. Re-verificar on-chain ANTES de decidir (CD-3). Sin chainKey/escrow →
    //    no se puede re-verificar → abort money-safe (indeterminate).
    if (!chainKey || !escrowContract) {
      log.warn({ intentId }, 'reconcile: chainKey/escrow no resoluble → abort');
      return { status: 'indeterminate' };
    }
    const verdict = await reverifyDebitedByTxHash({
      chainKey,
      escrowContract,
      txHash: row.debit_hop1_tx_hash,
      keyIdHash: row.debit_key_id_hash,
      nonce: BigInt(nonce),
    });
    if (verdict === 'indeterminate') return { status: 'indeterminate' };
    const side: 'settle' | 'refund' =
      verdict === 'confirmed' ? 'settle' : 'refund';

    // 4. CLAIM atómico gana-uno (transición pending → resolving_*).
    const claimRes = await supabase.rpc('claim_reconciliation', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_key_id: keyId,
      p_nonce: nonce,
      p_side: side,
    });
    if (claimRes.error) this.mapRpcError(claimRes.error, intentId, 'claim');
    const claimRow = (
      claimRes.data as
        | {
            claimed: boolean;
            resolution_tx_hash: string | null;
            amount_atomic: string | null;
          }[]
        | null
    )?.[0];
    if (!claimRow || claimRow.claimed === false) {
      // AR BLQ-BAJO-1: `claimed=false` ya NO significa una sola cosa. Desde HU-198 hay
      // filas que el claim rechaza A PROPÓSITO y que NO están resueltas: el hop 2 quedó
      // de resultado desconocido (`resolving_settle` sin tx) y el reconciliador se
      // niega a re-enviarlo a ciegas. Contestarle `already_resolved` al humano sobre
      // una fila con plata posiblemente duplicada es la peor respuesta posible: lo
      // manda a otra cosa. Se lee el estado REAL de la fila para distinguirlo.
      if (
        row.debit_settle_status === 'resolving_settle' &&
        !row.debit_resolution_tx_hash
      ) {
        log.warn(
          { intentId, keyId, nonce },
          'reconcile: intent awaiting MANUAL hop2 evidence (resolving_settle without tx). The reconciler will NOT resend hop2 blind: check the chain for a hop2 disbursement to the seller before resolving.',
        );
        return { status: 'awaiting_manual_settle_evidence' };
      }
      // Otro run ganó / ya terminal → no-op idempotente (AC-5).
      return { status: 'already_resolved' };
    }

    // Terminal + evidencia a persistir.
    let terminal: 'resolved_settled' | 'resolved_refunded';
    let txHash: string | null;
    let refundAmount: number | null;

    if (side === 'settle') {
      // 5. Crash-recovery: si el claim trae un tx del hop2 previo, re-verificar
      //    ANTES de re-enviar (CD-2, evita double-move).
      let skipResend = false;
      if (claimRow.resolution_tx_hash) {
        const requiredAtomic = BigInt(
          claimRow.amount_atomic ?? row.debit_amount_atomic,
        );
        const verified = await verifyDefaultChainSettle({
          txHash: claimRow.resolution_tx_hash,
          payTo,
          requiredAmountAtomic: requiredAtomic,
        });
        if (verified.warn) {
          // RPC no disponible → NO re-enviar a ciegas → abort (queda resolving_settle).
          log.warn(
            { intentId, reason: verified.reason },
            'reconcile crash-recovery: verify unavailable → abort',
          );
          return { status: 'indeterminate' };
        }
        if (verified.ok) skipResend = true; // la tx previa SÍ movió → flip terminal.
      }

      if (!skipResend) {
        // ⚠️ RE-ENVÍO SIN PRUEBA DURA — ACOTADO POR EL LEASE (HU-202 cierra TD-198-01).
        //
        // Acá se re-envía el hop 2. Desde HU-202 eso ya NO pasa "sin ninguna prueba de que
        // no se pagó": para llegar hasta esta línea, `claim_reconciliation` tuvo que
        // aceptar la fila, y su `WHERE` sólo la acepta por el lado settle si NO hay un hop 2
        // estampado sin resolver (`debit_hop2_attempted_at IS NULL OR
        // debit_resolution_tx_hash IS NOT NULL`). O sea que el hecho que faltaba —"el hop 2
        // se intentó"— ahora existe, se persiste ANTES del intento y gobierna esta decisión.
        //
        // LAS DOS ENTRADAS QUE SIGUEN LLEGANDO ACÁ, y por qué el re-envío es correcto:
        //   (A) el proceso murió DESPUÉS del hop 1 y ANTES de tomar el lease ⟹ el hop 2
        //       nunca se intentó, el seller no cobró y nadie más lo va a pagar. Es la razón
        //       de existir del lado settle del reconciliador.
        //   (D) el hop 2 falló de forma INEQUÍVOCA (`failureKind:'unequivocal'`) y
        //       `settleEscrowAware` LIBERÓ el lease a propósito. Desde HU-201 son dos cosas:
        //         · `adapter.sign()` TIRÓ ⟹ pre-broadcast POR CONSTRUCCIÓN: firmar es local
        //           (`signTypedData`), no hay ningún request al facilitator ni ninguna tx
        //           que pueda existir. Esto sí es una PRUEBA.
        //         · el facilitator contestó 2xx con `settled/success` falso y SIN txHash.
        //           ⚠️ ESTO NO ES UNA PRUEBA: es una INFERENCIA sobre la semántica de un
        //           TERCERO. Se sostiene por tres razones, no porque sea demostrable:
        //             1. es la MISMA respuesta y el MISMO campo cuyo `success:true` ya
        //                tratamos como autoritativo para marcar plata como pagada
        //                (desconfiar sólo de un lado sería incoherente);
        //             2. viene sin txHash — en el momento en que hay hash, HU-201 lo manda
        //                a `ambiguous` y NUNCA llega acá;
        //             3. es la entrada que mantiene vivo el re-envío legítimo; exigir
        //                prueba dura acá dejaría al seller sin cobrar automáticamente en el
        //                rechazo normal del facilitator.
        //           Si un facilitator empezara a contestar `success:false` DESPUÉS de
        //           broadcastear y sin devolver el hash, este re-envío paga dos veces y el
        //           gateway no tiene forma de saberlo. ES EL RESIDUO VIVO — ver TD-201-01.
        //
        // ── LO QUE HU-202 CERRÓ (y cómo, para que no se borre por accidente) ──
        //
        // El agujero era que `record_debit_hop1` escribe `hop1_confirmed` ANTES de que el
        // hop 2 se intente, y la fila se quedaba así durante TODA la ventana del hop 2. El
        // `WHERE` del claim acepta `hop1_confirmed` para el lado settle, así que cuatro
        // entradas distintas llegaban acá siendo INDISTINGUIBLES de (A):
        //   (B) el proceso murió DURANTE el hop 2, después de que el request salió.
        //       ⟹ CERRADO: el lease quedó tomado y sin `debit_resolution_tx_hash`, así que
        //       el claim NO reclama la fila y `resolveIntent` contesta
        //       `awaiting_manual_settle_evidence`.
        //   (C) el hop 2 SETTLEÓ pero el flip a 'settled' falló ⟹ el txHash se perdió.
        //       ⟹ CERRADO por lo mismo: el lease sobrevive al fallo del flip.
        //   (F) NADIE MURIÓ — el peor, y el que no necesitaba que nada se cayera: un click
        //       en el dashboard (o un barrido concurrente) mientras un settle lento estaba
        //       en vuelo re-enviaba y pagaba dos veces, con el proceso vivo y sano.
        //       ⟹ CERRADO: durante TODA la ventana del hop 2 la fila está leaseada, así que
        //       no es auto-reclamable ni clickeable-a-re-envío.
        //   (G) `hop1_confirmed` porque el write de `resolving_settle` falló.
        //       ⟹ CERRADO por el otro lado: si el lease no se persiste,
        //       `settleEscrowAware` NO MANDA el hop 2 (fail-closed). La fila queda como (A)
        //       —nada salió— y este re-envío es correcto.
        //
        // EL COSTO, DECLARADO: el lease convierte en revisión manual la ventana entre que
        // se escribió el lease y que el request del hop 2 salió (armar params +
        // `signTypedData` local + dispatch: milisegundos, sin ninguna E/S de red en el
        // medio). NO convierte (A) entera en manual —lo anterior a la escritura del lease
        // sigue auto-resolviéndose— ni toca (D), que es la entrada legítima que ocurre de
        // verdad y de forma repetida.
        //
        // ⚠️ RESIDUO CONOCIDO: las filas que ya estaban en `hop1_confirmed` cuando se
        // aplicó la migración siguen siendo auto-reclamables. Nadie persistió evidencia de
        // su hop 2 y no se puede inventar retroactivamente.
        //
        // ── LA OTRA OPCIÓN QUE SE DESCARTÓ, Y POR QUÉ ──
        //
        // Nonce DETERMINÍSTICO para el hop 2 (derivado del intentId) en vez de
        // `randomBytes(32)`, para volver el doble pago imposible ON-CHAIN (el token rechaza
        // el segundo uso). ⚠️ EL AGUJERO (a) SIGUE ABIERTO Y ES DECISIVO: en modo `pieverse`
        // —el DEFAULT DE PRODUCCIÓN— la firma es un `Authorization` custom contra
        // `KITE_FACILITATOR_ADDRESS`, no un `TransferWithAuthorization` contra el token, así
        // que "el token rechaza el segundo uso" NO APLICA AL CAMINO VIVO: la unicidad
        // dependería del contrato de un TERCERO. (El agujero (b) —el rechazo del replay
        // llegando como `success:false` ⟹ `unequivocal` ⟹ buyer reembolsado con el seller
        // pagado— sí se cerró en HU-201.) Queda como destino deseable DESPUÉS de resolver la
        // unicidad en pieverse; el lease no depende de ningún tercero.
        //
        // ── DEUDA ABIERTA (sigue vigente) ──
        //
        // TD-201-01 — LECTOR DE `authorizationState(from, nonce)`. La pregunta que todavía
        //   NO se puede contestar —"¿el broadcast aterrizó?"— tiene respuesta ON-CHAIN, no
        //   por HTTP: en EIP-3009 el token expone `authorizationState(authorizer, nonce)`
        //   como `view` público. Con eso, una fila leaseada sin resolver deja de ser
        //   terminal-manual: se resuelve sola. HOY NO EXISTE ese lector en el repo, y
        //   ⚠️ NO sirve tal cual en `pieverse` (el DEFAULT) — es el mismo agujero (a).
        //
        // TD-201-02 — COLUMNA PARA EL HASH DE EVIDENCIA. Cuando el facilitator contesta
        //   `success:false` CON txHash, ese hash es la única pista para cruzar contra la
        //   cadena y hoy sobrevive sólo como PROSA dentro de `error_message`.
        //
        // TD-201-03 — ¿PIEVERSE MANDA HASH EN SUS RECHAZOS NORMALES? Decide si `ambiguous`
        //   es un caso raro o el 100% de los rechazos. Ver `hasBroadcastEvidence`
        //   (`adapters/errors.ts`) y `listAmbiguous()` con tráfico real.
        //
        // NO borrar el lease de `settleEscrowAware` sin re-abrir (B), (C), (F) y (G).
        //
        // 6. hop 2 DIRECTO (seam WKH-136; NO settleEscrowAware, DT-R2).
        const settle = await settlePaymentIntentOnChain({
          intentId,
          ownerRef,
          payTo,
          finalAmountUsd,
          chainId,
        });
        if (settle.status !== 'settled') {
          // abort money-safe: deja resolving_settle, NO flip, NO refund. Sin tx previa
          // persistida (lease), un retry NO re-claima este resolving_settle (el claim
          // exige tx) → NO re-envía a ciegas (MNR-2/AR); queda para revisión en el GET.
          log.warn(
            { intentId, status: settle.status },
            'reconcile settle hop2 no confirmado → settle_failed',
          );
          return { status: 'settle_failed' };
        }
        txHash = settle.txHash;
        // Lease de evidencia (BLQ-ALTO-1/AR): persistir la tx del hop2 en la fila
        // resolving_settle ANTES del flip terminal. Si el proceso muere entre este envío
        // y el `record` de abajo, un retry re-claima ESTA fila (el claim settle exige tx
        // previa) y RE-VERIFICA on-chain ANTES de re-enviar → nunca double-paga.
        if (txHash) {
          const lease = await supabase
            .from('a2a_payment_intent_debit_signatures')
            .update({ debit_resolution_tx_hash: txHash })
            .eq('key_id', keyId)
            .eq('debit_nonce', nonce)
            .eq('debit_settle_status', 'resolving_settle');
          if (lease.error) {
            // No es fatal: el flip terminal de abajo persiste la tx igual (COALESCE). El
            // riesgo residual es el crash en esta ventana mínima (R-3 documentado).
            log.warn(
              { intentId, detail: lease.error.message },
              'reconcile lease persist failed (recovery evidence best-effort)',
            );
          }
        }
      } else {
        txHash = claimRow.resolution_tx_hash;
      }
      terminal = 'resolved_settled';
      refundAmount = null;
    } else {
      // REFUND budget-only: NINGÚN seam on-chain (money-safety crítico, DT-R4/NC-1).
      // El budget se acredita DENTRO del RPC (status-gated, una vez).
      terminal = 'resolved_refunded';
      txHash = null;
      refundAmount = finalAmountUsd;
    }

    // 7. Flip terminal + money-atomic (el refund vive DENTRO del RPC, una vez, CD-2).
    const recRes = await supabase.rpc('record_reconciliation_resolution', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_key_id: keyId,
      p_nonce: nonce,
      p_terminal_status: terminal,
      p_tx_hash: txHash,
      p_chain_id: chainId,
      p_refund_amount_usd: refundAmount,
    });
    if (recRes.error) this.mapRpcError(recRes.error, intentId, 'record');
    // applied===false (ya terminal) → no-op idempotente; igual reportamos el terminal.

    return {
      status: terminal === 'resolved_settled' ? 'settled' : 'refunded',
      side,
      txHash,
    };
  },

  /**
   * AR de HU-202, BLOQUEANTE 3 (salida 1) — CIERRA UNA FILA LEASEADA CON EVIDENCIA
   * ON-CHAIN DEL HOP 2.
   *
   * El operador trae un hash; el servicio NO le cree. Lo verifica contra la cadena con el
   * mismo lector del crash-recovery (`verifyDefaultChainSettle`: token correcto,
   * destinatario `pay_to`, monto ≥ el atómico firmado) y sólo cierra si la cadena lo
   * respalda. Un endpoint que aceptara el hash de palabra sería un `UPDATE` a mano con
   * más pasos: convertiría la atestación en un flip terminal sin ninguna prueba.
   *
   * Reusa `record_reconciliation_resolution` (191c) tal cual: es status-gated
   * `resolving_settle → resolved_settled`, persiste el hash con COALESCE y es idempotente.
   * NO hace falta ninguna migración nueva.
   */
  async resolveWithHop2Evidence(
    intentId: string,
    input: Hop2EvidenceInput,
  ): Promise<Hop2EvidenceOutcome> {
    if (!isEscrowSettleEnabled()) return { status: 'flag_off' };

    const leased = await readLeasedRow(intentId);
    if (!leased) return { status: 'not_leased' };
    const { row, intent } = leased;

    // Sin chain/token resolubles no hay verificación posible. Chequeo EXPLÍCITO y previo
    // porque `verifyDefaultChainSettle` devuelve `{ok:true}` pelado cuando no puede
    // resolver el chainKey (settle-verifier.ts, rama de registry sin inicializar): sin
    // este corte, un entorno mal configurado aceptaría cualquier hash como prueba.
    const chainKey = getDefaultChainKey();
    if (!chainKey) {
      log.warn(
        { intentId },
        'hop2 evidence: default chainKey unresolvable → cannot verify → abort',
      );
      return { status: 'indeterminate', reason: 'CHAIN_UNRESOLVABLE' };
    }

    const verified = await verifyDefaultChainSettle({
      txHash: input.txHash,
      payTo: intent.pay_to,
      requiredAmountAtomic: BigInt(row.debit_amount_atomic),
    });

    // ⚠️ EL ÚNICO `ok` QUE VALE ES EL QUE VIENE DE MIRAR LA CADENA. `verifyDefaultChainSettle`
    // devuelve `ok:true` en DOS casos que NO son evidencia y que acá serían un flip terminal
    // sobre plata:
    //   · `reason:'DISABLED'`  — el kill-switch `SETTLE_VERIFY_ONCHAIN` está apagado ⟹ no
    //     miró nada. Aceptar acá volvería el endpoint un rubber-stamp con sólo apagar un env.
    //   · `warn:true`          — "no pude chequear" (RPC caído). En testnet eso es fail-OPEN
    //     y llega como `ok:true`; es una degradación aceptable para DEJAR PASAR un settle que
    //     el facilitator ya broadcasteó, NO para CERRAR una fila cuya pregunta abierta es
    //     justamente si el pago existe.
    // La verificación real devuelve `{ok:true}` SIN `reason` — eso es lo que se exige.
    if (verified.warn === true || verified.reason === 'DISABLED') {
      log.warn(
        { intentId, reason: verified.reason ?? 'RPC_UNAVAILABLE' },
        'hop2 evidence: chain verification unavailable (RPC down or SETTLE_VERIFY_ONCHAIN off) → nothing written, retry later',
      );
      return {
        status: 'indeterminate',
        reason: verified.reason ?? 'RPC_UNAVAILABLE',
      };
    }
    if (!verified.ok || verified.reason !== undefined) {
      log.warn(
        { intentId, reason: verified.reason ?? 'UNVERIFIED' },
        'hop2 evidence REJECTED: the chain does not back this tx as a hop2 disbursement to the seller. The lease is KEPT.',
      );
      return {
        status: 'evidence_rejected',
        reason: verified.reason ?? 'UNVERIFIED',
      };
    }

    const rec = await supabase.rpc('record_reconciliation_resolution', {
      p_intent_id: intentId,
      p_owner_ref: intent.owner_ref,
      p_key_id: row.key_id,
      p_nonce: row.debit_nonce,
      p_terminal_status: 'resolved_settled',
      p_tx_hash: input.txHash,
      p_chain_id: intent.chain_id,
      p_refund_amount_usd: null,
    });
    if (rec.error) this.mapRpcError(rec.error, intentId, 'record');

    log.warn(
      {
        intentId,
        keyId: row.key_id,
        txHash: input.txHash,
        resolvedBy: input.resolvedBy,
        note: input.note ?? null,
        audit: 'ESCROW_HOP2_EVIDENCE_ACCEPTED',
      },
      'hop2 lease CLOSED with on-chain evidence: the tx was verified to pay the seller the signed amount, so the intent is resolved_settled.',
    );
    return { status: 'settled', txHash: input.txHash };
  },

  /**
   * AR de HU-202, BLOQUEANTE 3 (salida 2) — LIBERA EL LEASE CON UNA ATESTACIÓN AUDITADA
   * DE QUE NO HUBO DESEMBOLSO AL SELLER.
   *
   * ⚠️ ESTA ES LA ÚNICA OPERACIÓN DEL REPO QUE MUEVE UNA FILA A UN ESTADO PAGABLE SIN
   * PRUEBA. Existe porque la alternativa es peor —una fila que nadie puede tocar y un
   * seller que no cobra nunca— pero su seguridad NO viene del código: viene de que sea un
   * acto humano, autenticado (`requireAdminTokenStrict`), deliberado y con nombre. Por eso
   * `resolvedBy` y `note` son OBLIGATORIOS y viajan al log de auditoría: si el re-envío
   * termina en un doble pago, tiene que existir el registro de quién dijo que no lo habría.
   *
   * NO ES —Y NO PUEDE SER— UN TEMPORIZADOR. Liberar por edad devuelve la fila al pool sin
   * que nadie haya mirado la cadena, que es exactamente el caso (F) que HU-202 cerró.
   *
   * Efecto: `reconciliation_pending` vía `record_debit_settle_status`, que además LIMPIA
   * `debit_hop2_attempted_at` (migración 20260729000000) ⟹ la fila vuelve a ser
   * auto-reclamable ⟹ el reconciliador re-envía el hop 2 y el seller cobra. Reusa el ÚNICO
   * escritor del lease a propósito: dos escritores del mismo candado divergen.
   */
  async releaseHop2Lease(
    intentId: string,
    input: ReleaseLeaseInput,
  ): Promise<Hop2EvidenceOutcome> {
    if (!isEscrowSettleEnabled()) return { status: 'flag_off' };

    const leased = await readLeasedRow(intentId);
    if (!leased) return { status: 'not_leased' };
    const { row, intent } = leased;

    const released = await recordDebitSettleStatus({
      intentId,
      ownerRef: intent.owner_ref,
      keyId: row.key_id,
      nonce: row.debit_nonce,
      status: 'reconciliation_pending',
    });
    if (released.outcome !== 'applied') {
      log.error(
        {
          intentId,
          keyId: row.key_id,
          resolvedBy: input.resolvedBy,
          outcome: released.outcome,
        },
        'hop2 lease release did NOT apply: the row was not moved back to reconciliation_pending, so it is still stuck. Re-check its current status before retrying.',
      );
      return { status: 'indeterminate', reason: released.outcome };
    }

    log.warn(
      {
        intentId,
        keyId: row.key_id,
        hop1TxHash: row.debit_hop1_tx_hash,
        resolvedBy: input.resolvedBy,
        note: input.note,
        audit: 'ESCROW_HOP2_LEASE_RELEASED_BY_ATTESTATION',
      },
      'hop2 lease RELEASED on a human attestation that no disbursement to the seller exists on-chain. The row is auto-claimable again and the reconciler WILL resend hop2. If the attestation was wrong, this is where the double payment started.',
    );
    return { status: 'lease_released' };
  },

  /**
   * AC-7/CD-4: reporta el drift entre el débito off-chain acumulado y el `escrowBalance`
   * on-chain, por key. SOLO reporte — NUNCA corrige el budget agregado.
   */
  async driftCheck(): Promise<DriftRow[]> {
    const chainKey = getDefaultChainKey();
    const escrowContract = chainKey ? resolveEscrowContract(chainKey) : null;

    const { data, error } = await supabase
      .from('a2a_payment_intent_debit_signatures')
      .select(
        'key_id, debit_key_id_hash, debit_amount_atomic::text, owner_ref, ' +
          'a2a_payment_intents!inner(chain_id)',
      )
      .eq('debit_validation_status', 'valid')
      .in('debit_settle_status', [...DRIFT_ACCOUNTED_STATUSES]);
    if (error) {
      log.error({ detail: error.message }, 'driftCheck query failed');
      throw new ReconciliationError('INTERNAL');
    }
    const rows = (data as unknown as DriftSigRow[] | null) ?? [];

    // Agrupar por key_id (suma atomic del débito vigente).
    interface Group {
      keyId: string;
      keyIdHash: string;
      ownerRef: string;
      chainId: number;
      sum: bigint;
    }
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const intent = firstEmbed(r.a2a_payment_intents);
      const chainId = intent?.chain_id ?? 0;
      const g = groups.get(r.key_id);
      const amount = BigInt(r.debit_amount_atomic);
      if (g) {
        g.sum += amount;
      } else {
        groups.set(r.key_id, {
          keyId: r.key_id,
          keyIdHash: r.debit_key_id_hash,
          ownerRef: r.owner_ref,
          chainId,
          sum: amount,
        });
      }
    }

    const threshold = getDriftThresholdAtomic();
    const out: DriftRow[] = [];
    for (const g of groups.values()) {
      const escrowBalanceAtomic =
        escrowContract && chainKey
          ? await readEscrowBalanceAtomic({
              chainKey,
              escrowContract,
              keyIdHash: g.keyIdHash as `0x${string}`,
            })
          : null;

      // Budget off-chain (SOLO reporte). Owner-guarded (WKH-53): owner_ref REAL del row.
      const budgetUsd = await this.readBudgetUsd(
        g.keyId,
        g.ownerRef,
        g.chainId,
      );

      const deltaAtomic =
        escrowBalanceAtomic !== null ? escrowBalanceAtomic - g.sum : null;
      const exceedsThreshold =
        deltaAtomic !== null && absBig(deltaAtomic) > threshold;
      if (exceedsThreshold) {
        log.warn(
          {
            keyId: g.keyId,
            sumDebitedAtomic: g.sum.toString(),
            escrowBalanceAtomic: escrowBalanceAtomic?.toString() ?? null,
            deltaAtomic: deltaAtomic?.toString() ?? null,
          },
          'reconcile drift exceeds threshold (report-only, no auto-correct)',
        );
      }
      out.push({
        key_id: g.keyId,
        sumDebitedAtomic: g.sum.toString(),
        escrowBalanceAtomic: escrowBalanceAtomic?.toString() ?? null,
        budgetUsd,
        deltaAtomic: deltaAtomic?.toString() ?? null,
        exceedsThreshold,
      });
    }
    return out;
  },

  /**
   * Lee el budget off-chain de una key para la chain (SOLO reporte del drift). Owner-guarded
   * (WKH-53): filtra por el `owner_ref` REAL de la fila. Fallo/no-existe → null.
   */
  async readBudgetUsd(
    keyId: string,
    ownerRef: string,
    chainId: number,
  ): Promise<string | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('budget')
      .eq('id', keyId)
      .eq('owner_ref', ownerRef)
      .maybeSingle();
    if (error || !data) return null;
    const budget = (data as { budget: Record<string, string> | null }).budget;
    if (!budget) return null;
    return budget[String(chainId)] ?? null;
  },

  /** Mapea el error crudo de un RPC a un ReconciliationError estable (disclosure-safe). */
  mapRpcError(
    error: { message?: string },
    intentId: string,
    ctx: string,
  ): never {
    const msg = error.message ?? '';
    if (msg.includes('INTENT_NOT_FOUND')) {
      throw new ReconciliationError('INTENT_NOT_FOUND');
    }
    log.error({ intentId, ctx, detail: msg }, 'reconciliation RPC error');
    throw new ReconciliationError('INTERNAL');
  },
};
