/**
 * Contratos de la superficie de trace operativo (WKH-191x).
 *
 * READ-ONLY sobre tráfico REAL ya ocurrido: nada de esto dispara una llamada ni
 * mueve dinero. Los montos viajan como STRING de punta a punta (convención post
 * WKH-196): se leen con `::text` de Postgres y llegan así al DOM, sin pasar por
 * `Number` en ningún punto del camino.
 */

import type { PublicDownstreamSkipCode } from '../lib/downstream-skip-code.js';

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
   * `false` = ningún evento de la ventana trae la señal de skips (el gateway que
   * generó ese tráfico es anterior a esta pantalla). Evita leer un 0 como
   * "cero skips" cuando en realidad es "sin datos".
   */
  skipSignalPresent: boolean;
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
