/**
 * Generic Webhook Inbound Adapter — WKH-115 (reference adapter, AC-8).
 *
 * Source-agnostic HTTP webhook adapter. NO coupling to any 3rd-party platform
 * (CD-1) — the payload schema is a neutral generic contract.
 *
 * Payload → NormalizedInboundTask mapping (SDD §4.6):
 *   | Field           | Type    | Maps to                | Rule                                             |
 *   |-----------------|---------|------------------------|--------------------------------------------------|
 *   | goal            | string  | goal                   | REQUIRED, non-empty after trim. Else validate !ok |
 *   | id              | string  | externalRef            | Optional. Non-string → null.                     |
 *   | budget_usdc     | number  | budgetUsdc             | Optional. Finite ≥0; present-but-invalid → !ok.  |
 *   | constraints     | object  | constraints            | Optional. Non-plain-object → {}.                 |
 *   | callback_url    | string  | embeddedUrls[]         | Optional. Non-string ignored. Validated by SSRF. |
 *   | artifact_url    | string  | embeddedUrls[]         | Optional. Non-string ignored. Validated by SSRF. |
 *   | payment/escrow  | present | declaresExternalEscrow | Any non-null value present ⇒ external escrow.    |
 *
 * CD-9 (CRÍTICO): `validate`/`normalize` NEVER throw on malformed input. Every
 * type is checked before use; no spread/iteration over unverified values.
 */

import type {
  AdapterValidateResult,
  InboundAdapter,
  NormalizedInboundTask,
} from './types.js';

const GENERIC_SOURCE = 'generic-webhook';

/**
 * True iff `v` is a plain JSON object (not null, not an array). Guards every
 * spread / property access over untrusted payload (CD-9).
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const genericWebhookAdapter: InboundAdapter = {
  source: GENERIC_SOURCE,

  validate(payload: unknown): AdapterValidateResult {
    // CD-9: guard the top-level shape BEFORE any property access.
    if (!isPlainObject(payload)) {
      return { ok: false, reason: 'payload must be a json object' };
    }
    const b = payload;

    // goal: required, non-empty after trim.
    if (typeof b.goal !== 'string' || b.goal.trim().length === 0) {
      return {
        ok: false,
        reason: 'goal is required and must be a non-empty string',
      };
    }

    // budget_usdc: optional; if present must be a finite number ≥0.
    if (b.budget_usdc !== undefined && b.budget_usdc !== null) {
      if (
        typeof b.budget_usdc !== 'number' ||
        !Number.isFinite(b.budget_usdc) ||
        b.budget_usdc < 0
      ) {
        return {
          ok: false,
          reason: 'budget_usdc must be a finite number >= 0 when present',
        };
      }
    }

    return { ok: true };
  },

  normalize(payload: unknown): NormalizedInboundTask {
    // `normalize` runs after `validate` ok, but stays fully defensive (CD-9):
    // it NEVER throws even on garbage.
    const base: NormalizedInboundTask = {
      goal: '',
      budgetUsdc: null,
      constraints: {},
      externalRef: null,
      embeddedUrls: [],
      declaresExternalEscrow: false,
    };
    if (!isPlainObject(payload)) return base;
    const b = payload;

    // goal (verified string; trimmed).
    if (typeof b.goal === 'string') {
      base.goal = b.goal.trim();
    }

    // externalRef ← id (string only).
    if (typeof b.id === 'string') {
      base.externalRef = b.id;
    }

    // budgetUsdc ← budget_usdc (finite ≥0 only; else null → source default).
    if (
      typeof b.budget_usdc === 'number' &&
      Number.isFinite(b.budget_usdc) &&
      b.budget_usdc >= 0
    ) {
      base.budgetUsdc = b.budget_usdc;
    }

    // constraints (plain object only; never iterate unverified value).
    if (isPlainObject(b.constraints)) {
      base.constraints = b.constraints;
    }

    // embeddedUrls ← callback_url / artifact_url (string only).
    if (typeof b.callback_url === 'string') {
      base.embeddedUrls.push(b.callback_url);
    }
    if (typeof b.artifact_url === 'string') {
      base.embeddedUrls.push(b.artifact_url);
    }

    // AC-5: mere presence of a non-null payment/escrow ⇒ external escrow.
    if (
      (b.payment !== undefined && b.payment !== null) ||
      (b.escrow !== undefined && b.escrow !== null)
    ) {
      base.declaresExternalEscrow = true;
    }

    return base;
  },
};

/**
 * Adapter registry (static, DT-9). v1 has a single generic reference adapter;
 * an unknown `source` still resolves to the generic adapter — differentiation
 * is by env config/secret (per-source), not by adapter type.
 */
export function getInboundAdapter(_source: string): InboundAdapter {
  return genericWebhookAdapter;
}

export { genericWebhookAdapter };
