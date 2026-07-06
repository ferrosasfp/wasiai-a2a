/**
 * Inbound Adapter interface — WKH-115.
 *
 * Source-agnostic adapter contract for ingesting external tasks/bounties into
 * the WasiAI orchestration engine. An adapter's job is to VALIDATE the shape of
 * an untrusted external payload and NORMALIZE it into a `NormalizedInboundTask`
 * (goal + budget + constraints + embedded URLs + escrow flag).
 *
 * CD-9 (CRÍTICO): both `validate` and `normalize` NEVER throw on malformed
 * input — every type is checked before spread/iteration. Defensive guards live
 * INSIDE each function (ref WKH-114#3: `[...criteria]` on a non-iterable drained
 * the money-path).
 */

export interface NormalizedInboundTask {
  /** Normalized goal — non-empty (guaranteed by `validate` ok). */
  goal: string;
  /** Declared amount (finite ≥0) or null if not declared → source default. */
  budgetUsdc: number | null;
  constraints: Record<string, unknown>;
  externalRef: string | null;
  /** URLs to be validated by SSRF before any fetch (AC-7). */
  embeddedUrls: string[];
  /** AC-5: payload carries its own non-a2a payment/escrow → reject. */
  declaresExternalEscrow: boolean;
}

export type AdapterValidateResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface InboundAdapter {
  readonly source: string;
  /** Shape check over untrusted payload. NEVER throws. */
  validate(payload: unknown): AdapterValidateResult;
  /** Normalize AFTER `validate` ok. NEVER throws. */
  normalize(payload: unknown): NormalizedInboundTask;
}
