/**
 * Contratos de la superficie de trace operativo (WKH-191x).
 *
 * READ-ONLY sobre tráfico REAL ya ocurrido: nada de esto dispara una llamada ni
 * mueve dinero. Los montos viajan como STRING de punta a punta (convención post
 * WKH-196): se leen con `::text` de Postgres y llegan así al DOM, sin pasar por
 * `Number` en ningún punto del camino.
 */

import type {
  DownstreamSkipAction,
  DownstreamSkipCode,
  PublicDownstreamSkipCode,
} from '../lib/downstream-skip-code.js';

/** Red mostrada en la UI (proyección de `lib/chain-display.ChainDisplay`). */
export interface TraceNetwork {
  key: string | null;
  label: string;
}

/** Chain registrada en el registry de adapters (misma fuente que /capabilities). */
export interface TraceChain extends TraceNetwork {
  chainId: number;
  isDefault: boolean;
}

/** Conteo de un skip-code PÚBLICO en la ventana consultada. */
export interface TraceSkipCount {
  code: PublicDownstreamSkipCode;
  count: number;
  /** Explicación de una línea, para leer la pantalla sin leer el código. */
  meaning: string;
}

/**
 * Conteo por ACCIÓN de los legs que no se pagaron: qué hay que hacer y quién.
 *
 * POR QUÉ EXISTE APARTE DE `TraceSkipCount`. El código PÚBLICO colapsa cuatro
 * causas en `NOT_CONFIGURED` (y seis en `UNAVAILABLE`), y ese colapso es correcto
 * para el caller —las cuatro lo dejan en el mismo lugar— pero deja al operador
 * mirando un número que no distingue "no pasa nada" de "hay un deploy roto". Esta
 * lista es el mismo tráfico agrupado por la ACCIÓN que provoca.
 *
 * Es ADMIN-ONLY: `/dashboard/trace` está detrás de un gate fail-closed. El
 * `code` interno NUNCA sale por la respuesta de `/compose` ni `/orchestrate`.
 */
export interface TraceSkipActionCount {
  action: DownstreamSkipAction;
  count: number;
  /** Quién tiene que actuar. */
  owner: string;
  /** Qué hay que hacer, en una línea. */
  next: string;
  /**
   * Códigos internos que cayeron en esta acción, con su conteo. Se muestra para
   * que el operador no tenga que abrir el fuente para saber cuál de las causas
   * agrupadas fue.
   */
  codes: Array<{ code: DownstreamSkipCode; count: number }>;
}

/** Último settle cross-chain exitoso: el pulso del rail. */
export interface TraceLastCrossChainSettle {
  at: string;
  ageSeconds: number;
  paidOn: TraceNetwork;
  collectedOn: TraceNetwork;
  signature: string | null;
  explorerTxUrl: string | null;
  amountUsd: string;
}

export interface TraceHealth {
  chains: TraceChain[];
  defaultChain: string | null;
  /** `null` = no hay ningún settle cross-chain registrado todavía. */
  lastCrossChainSettle: TraceLastCrossChainSettle | null;
  skipWindowHours: number;
  skips: TraceSkipCount[];
  skipsTotal: number;
  /**
   * Los MISMOS legs de `skips`, agrupados por la ACCIÓN que provocan. Es lo que
   * hace accionable la pantalla: `skips` dice `NOT_CONFIGURED × 47` y esto dice
   * si esos 47 son "el pago está apagado a propósito" o "hay una config rota".
   */
  skipActions: TraceSkipActionCount[];
  /**
   * `false` = ningún evento de la ventana trae la señal de skips (el gateway que
   * generó ese tráfico es anterior a esta pantalla). Evita leer un 0 como
   * "cero skips" cuando en realidad es "sin datos".
   */
  skipSignalPresent: boolean;
  /**
   * `false` = ningún evento de la ventana trae el motivo INTERNO (tráfico previo
   * a este canal, o generado por una ruta que no lo reporta). TERCER VALOR
   * explícito: distinto de `skipActions: []`, que significa "se leyó y no hubo
   * ninguno". Sin esto, un gateway viejo se leería como "cero problemas".
   */
  skipCauseSignalPresent: boolean;
  /**
   * Techo de eventos que el conteo revisa (query acotada). Viaja en el payload
   * para que la pantalla pueda decir el número real en vez de tenerlo escrito a
   * mano y desincronizarse.
   */
  skipScanLimit: number;
  /**
   * `true` = la ventana tiene MÁS eventos que el techo, así que el conteo cubre
   * los `skipScanLimit` más recientes y NO la ventana entera (AR BLQ-BAJO-1b).
   * Con esto en `true` la pantalla no puede afirmar "cero skips en la ventana":
   * lo que no se leyó no se sabe.
   */
  skipScanTruncated: boolean;
}

/** Un movimiento de dinero (una fila de `a2a_receipts`). */
export interface TraceMoneyLeg {
  receiptId: string;
  at: string;
  receiptType: string;
  /** NUMERIC como string: nunca se parsea a float. */
  amountUsd: string;
  ownerRef: string;
  /** Red del budget del caller (`chain_id`). */
  paidOn: TraceNetwork;
  /** Red donde cobró el agente (`settle_caip2`), o `null` si fue el mismo rail. */
  collectedOn: TraceNetwork | null;
  crossChain: boolean;
  /** `tx_hash` EVM o firma base58 Solana (`settle_signature`). */
  txHash: string | null;
  explorerTxUrl: string | null;
  /** `true` = débito al caller; `false` = settle al agente / fee de plataforma. */
  isCallerDebit: boolean;
}

/** Fee de plataforma de la llamada (`a2a_protocol_fees`). */
export interface TraceFee {
  /** `fee_total_usdc` (WKH-167). `null` si la fila es previa a esa columna. */
  totalUsd: string | null;
  /** `fee_usdc`: SÓLO la pata plataforma del split, NO el total. */
  platformUsd: string;
  status: string;
  txHash: string | null;
  explorerTxUrl: string | null;
}

/**
 * De dónde salió el grupo:
 *  - `full`       evento + dinero correlacionados por id.
 *  - `call-only`  hay evento (endpoint/latencia) y ningún recibo con ese id.
 *  - `money-only` hay recibos y ningún evento con ese id (ver H-1/H-2 del work-item).
 */
export type TraceCorrelation = 'full' | 'call-only' | 'money-only';

export interface TraceCall {
  /** Clave de correlación: `requestId` / `orchestration_id` / `receipt:<id>`. */
  id: string;
  at: string;
  correlation: TraceCorrelation;
  endpoint: string | null;
  method: string | null;
  status: 'success' | 'failed' | null;
  httpStatus: number | null;
  latencyMs: number | null;
  /** `owner_ref` del caller. `null` cuando el grupo sólo tiene evento. */
  ownerRef: string | null;
  legs: TraceMoneyLeg[];
  skips: TraceSkipCount[];
  /** `true` = alguna pata cruzó de red. Es la tesis del producto. */
  crossChain: boolean;
  fee: TraceFee | null;
}

export interface TracePayload {
  generatedAt: string;
  limit: number;
  health: TraceHealth;
  calls: TraceCall[];
}
