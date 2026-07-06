/**
 * Inbound Task Service — WKH-115.
 *
 * Ingesta push/webhook de tareas externas → normalización → ruteo in-process a
 * `orchestrateService`. Autentica la fuente vía HMAC-SHA256 sobre el body crudo,
 * trackea el lifecycle (ingested → routed → settled | rejected | failed) en
 * `a2a_inbound_tasks` con ownership isolation, capa el budget y rechaza escrows
 * externos.
 *
 * Patrones: `task.ts` (CRUD ownership-scoped), `agent-link.ts` (ruteo
 * in-process + reconciliación MNR-b), `signed-auth.ts` (HMAC never-throws),
 * `url-validator.ts` (SSRF Result-style).
 *
 * Constraint Directives clave:
 *  - CD-OBL-1: ruteo in-process vía `orchestrateService.orchestrate` (NO fetch).
 *  - CD-OBL-2: `.eq('owner_ref', ownerRef)` en TODA query; cross-tenant=not-found.
 *  - CD-OBL-3: reuso de `validateOutboundUrl` para toda URL embebida.
 *  - CD-OBL-4: HMAC sobre body CRUDO; hex-check + length-check antes de compare.
 *  - CD-OBL-5: secretos/keys/budgets/chain por fuente SOLO desde env.
 *  - CD-2: budget SIEMPRE capado; escrow externo → rejected sin acreditar.
 *  - CD-10: fail-closed — toda salida ≠ `pipeline.success===true` ⇒ 'failed'.
 */

import crypto, { createHmac, timingSafeEqual } from 'node:crypto';
import { getInboundAdapter } from '../adapters/inbound/generic-webhook.js';
import type { NormalizedInboundTask } from '../adapters/inbound/types.js';
import { getAdaptersBundle } from '../adapters/registry.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { validateOutboundUrl } from '../lib/url-validator.js';
import type { Database } from '../types/database.types.js';
import type { OrchestrateRequest } from '../types/index.js';
import { identityService } from './identity.js';
import { orchestrateService } from './orchestrate.js';

const log = getLogger('inbound-task');

// Firma HMAC en hex de 64 chars (32 bytes SHA-256). Rechazo ANTES de Buffer.from
// (patrón signed-auth.ts:178). Solo hex minúscula (digest de Node es minúscula).
const INBOUND_HMAC_HEX_RE = /^[0-9a-f]{64}$/;
// Timestamp estricto (NIT-ts): SOLO dígitos. Rechaza whitespace / `1e10` / `0x10`
// / `12.3` ANTES de `Number(...)` (Number aceptaría esos y abriría un
// side-channel de parsing). El chequeo de ventana sigue después.
const INBOUND_TS_RE = /^\d+$/;
const DEFAULT_HMAC_TOLERANCE_SEC = 300;

export type InboundStatus =
  | 'ingested'
  | 'routed'
  | 'settled'
  | 'rejected'
  | 'failed';

export interface SourceConfig {
  /** Fuente sanitizada (uppercase, [A-Z0-9_]). */
  source: string;
  /** Secreto HMAC en UTF-8 (no un hash previo). */
  secret: string;
  /** Raw a2a key pagadora (se hashea para resolver el key row). */
  a2aKeyRaw: string;
  /** Cap por tarea (finito >0). */
  maxBudgetUsdc: number;
  /** Budget default cuando el payload no declara monto (finito ≥0). */
  defaultBudgetUsdc: number;
  /** Chain del ruteo. */
  chainId: number;
}

export type IngestResult =
  | { status: 'settled'; orchestrationId: string; answer: unknown }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; reason: string }
  // MNR-2: replay idempotente de una tarea aún en vuelo (ingested/routed). Se
  // devuelve el status actual sin re-invocar orchestrate ni crear una 2ª row.
  | {
      status: 'ingested' | 'routed';
      orchestrationId: string | null;
      idempotent: true;
    };

// ── Tipo interno para filas de Supabase (patrón task.ts) ────────

interface InboundTaskRow {
  id: string;
  owner_ref: string;
  source: string;
  external_ref: string | null;
  status: InboundStatus;
  goal: string;
  budget_usdc: number | null;
  constraints: Record<string, unknown>;
  orchestration_id: string | null;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
}

// ── Env helpers (CD-OBL-5) ──────────────────────────────────────

/** Sanitiza el `:source` del path a `[A-Z0-9_]` uppercased (env-key safe). */
function sanitizeSource(source: string): string {
  return source.toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

/** Parsea un env a number finito. Devuelve null si ausente/inválido. */
function parseFiniteEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mapea una tarea inbound YA existente a un `IngestResult` para el replay
 * idempotente (MNR-2). Los estados terminales reusan sus variantes; los
 * en-vuelo (ingested/routed) devuelven el status con `idempotent:true`. El
 * `answer` original NO se persiste, así que un replay `settled` responde
 * `answer:null` (el request original ya recibió la respuesta; el replay es un
 * duplicado que la fuente no debió reenviar).
 */
function replayResult(row: InboundTaskRow): IngestResult {
  switch (row.status) {
    case 'settled':
      return {
        status: 'settled',
        orchestrationId: row.orchestration_id ?? '',
        answer: null,
      };
    case 'rejected':
      return { status: 'rejected', reason: row.error_reason ?? 'rejected' };
    case 'failed':
      return { status: 'failed', reason: row.error_reason ?? 'failed' };
    default:
      // ingested | routed (aún en vuelo por una request concurrente).
      return {
        status: row.status,
        orchestrationId: row.orchestration_id,
        idempotent: true,
      };
  }
}

// ── Service ─────────────────────────────────────────────────────

export const inboundTaskService = {
  /**
   * Carga la config de una fuente desde env (CD-OBL-5). Requeridos:
   * `INBOUND_SOURCE_SECRET_<S>`, `INBOUND_SOURCE_A2A_KEY_<S>`,
   * `INBOUND_SOURCE_MAX_BUDGET_<S>` (finito >0). Opcionales:
   * `INBOUND_SOURCE_DEFAULT_BUDGET_<S>` (finito ≥0, default 0),
   * `INBOUND_SOURCE_CHAIN_<S>` (default = chain del adapters bundle).
   * Cualquier requerido inválido → null.
   */
  loadSourceConfig(source: string): SourceConfig | null {
    const s = sanitizeSource(source);
    if (s.length === 0) return null;

    const secret = process.env[`INBOUND_SOURCE_SECRET_${s}`];
    if (!secret) return null;

    const a2aKeyRaw = process.env[`INBOUND_SOURCE_A2A_KEY_${s}`];
    if (!a2aKeyRaw) return null;

    const maxBudgetUsdc = parseFiniteEnv(
      process.env[`INBOUND_SOURCE_MAX_BUDGET_${s}`],
    );
    if (maxBudgetUsdc === null || maxBudgetUsdc <= 0) return null;

    // Default budget: opcional; present-e-inválido (<0 o no-finito) → misconfig.
    const defaultRaw = process.env[`INBOUND_SOURCE_DEFAULT_BUDGET_${s}`];
    let defaultBudgetUsdc = 0;
    if (defaultRaw !== undefined && defaultRaw.trim().length > 0) {
      const parsed = parseFiniteEnv(defaultRaw);
      if (parsed === null || parsed < 0) return null;
      defaultBudgetUsdc = parsed;
    }

    // Chain: opcional → default del adapters bundle (patrón agent-links.ts:99).
    const chainRaw = process.env[`INBOUND_SOURCE_CHAIN_${s}`];
    let chainId: number | undefined;
    if (chainRaw !== undefined && chainRaw.trim().length > 0) {
      const parsed = parseFiniteEnv(chainRaw);
      if (parsed === null) return null;
      chainId = parsed;
    } else {
      chainId = getAdaptersBundle()?.chainConfig.chainId;
    }
    if (chainId === undefined) return null;

    return {
      source: s,
      secret,
      a2aKeyRaw,
      maxBudgetUsdc,
      defaultBudgetUsdc,
      chainId,
    };
  },

  /**
   * HMAC gate (CD-OBL-4). Devuelve la `SourceConfig` si la firma es válida y el
   * timestamp cae en la ventana; `null` en cualquier otro caso (route → 401).
   * NUNCA throws. El HMAC se calcula sobre los bytes CRUDOS del body.
   */
  verifySourceAuth(
    source: string,
    rawBody: Buffer | string,
    timestamp: string,
    signature: string,
  ): SourceConfig | null {
    const cfg = this.loadSourceConfig(source);
    if (!cfg) {
      // MNR-1: cerrar el timing side-channel de enumeración de fuentes. Una
      // fuente NO configurada retornaría acá SIN computar HMAC → tiempo distinto
      // de una configurada-con-sig-inválida. Computamos un HMAC dummy (key
      // constante, mismo shape de trabajo) y descartamos el resultado, para
      // igualar el costo antes de retornar null. NO cambia la decisión (→ 401).
      const dummy = createHmac('sha256', Buffer.from('\0', 'utf8'));
      dummy.update(`${timestamp}.`);
      dummy.update(rawBody);
      dummy.digest();
      return null;
    }

    // Rechazar hex malformado ANTES de Buffer.from (patrón signed-auth.ts:178).
    if (!INBOUND_HMAC_HEX_RE.test(signature)) return null;

    // Ventana anti-replay: timestamp estricto (NIT-ts, solo dígitos) + finito +
    // dentro de tolerancia. El guard `^\d+$` rechaza whitespace/`1e10`/`0x10`.
    if (!INBOUND_TS_RE.test(timestamp)) return null;
    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum)) return null;
    const tolEnv = parseFiniteEnv(process.env.INBOUND_HMAC_TOLERANCE_SEC);
    const tolerance =
      tolEnv !== null && tolEnv > 0 ? tolEnv : DEFAULT_HMAC_TOLERANCE_SEC;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - tsNum) > tolerance) return null;

    // Canonical = "<timestamp>.<rawBody>" sobre los bytes exactos del body.
    const hmac = createHmac('sha256', Buffer.from(cfg.secret, 'utf8'));
    hmac.update(`${timestamp}.`);
    hmac.update(rawBody);
    const expected = hmac.digest();

    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'hex');
    } catch {
      return null;
    }
    // Length-check ANTES de timingSafeEqual (evita throw por longitud).
    if (provided.length !== expected.length) return null;
    return timingSafeEqual(expected, provided) ? cfg : null;
  },

  /**
   * Cap del budget (AC-6/CD-2). Sin monto declarado → default de la fuente; con
   * monto declarado → mínimo(declarado, cap de la fuente). NUNCA confía en el
   * monto externo crudo.
   */
  capBudget(declared: number | null, cfg: SourceConfig): number {
    return declared === null
      ? cfg.defaultBudgetUsdc
      : Math.min(declared, cfg.maxBudgetUsdc);
  },

  /**
   * Crea el row de ingesta (status='ingested' por default). `ownerRef` sella el
   * row para el filtrado de ownership subsiguiente.
   */
  async create(
    ownerRef: string,
    input: {
      source: string;
      externalRef: string | null;
      goal: string;
      constraints: Record<string, unknown>;
    },
  ): Promise<InboundTaskRow> {
    const row = {
      owner_ref: ownerRef,
      source: input.source,
      external_ref: input.externalRef,
      goal: input.goal,
      constraints: input.constraints,
      status: 'ingested' as InboundStatus,
    };
    const { data, error } = await supabase
      .from('a2a_inbound_tasks')
      // jsonb narrowing: `constraints` es `Json` en el schema generado pero
      // `Record<string,unknown>` en InboundTaskRow; cast acotado al Insert real.
      .insert(
        row as Database['public']['Tables']['a2a_inbound_tasks']['Insert'],
      )
      .select()
      .single();

    if (error) {
      // MNR-2: violación del índice UNIQUE parcial (owner_ref, source,
      // external_ref) → dos ingestas idénticas concurrentes. Se señala como
      // duplicado para que `ingest` haga replay idempotente (sin re-orchestrate).
      if (error.code === '23505') throw new InboundDuplicateError();
      throw new Error(`Failed to create inbound task: ${error.message}`);
    }
    return data as unknown as InboundTaskRow;
  },

  /**
   * Lee un row scoped a `ownerRef`. Cross-tenant = undefined (AC-9/CD-OBL-2 —
   * no filtra existencia a otros tenants).
   */
  async get(ownerRef: string, id: string): Promise<InboundTaskRow | undefined> {
    const { data, error } = await supabase
      .from('a2a_inbound_tasks')
      .select('*')
      .eq('id', id)
      .eq('owner_ref', ownerRef)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to get inbound task '${id}': ${error.message}`);
    }
    return data ? (data as unknown as InboundTaskRow) : undefined;
  },

  /**
   * MNR-2: lee la tarea existente por `(owner_ref, source, external_ref)` para el
   * pre-check de idempotencia. Ownership-scoped (CD-OBL-2). El índice UNIQUE
   * parcial garantiza a lo sumo una fila. Cross-tenant / inexistente → undefined.
   */
  async getByExternalRef(
    ownerRef: string,
    source: string,
    externalRef: string,
  ): Promise<InboundTaskRow | undefined> {
    const { data, error } = await supabase
      .from('a2a_inbound_tasks')
      .select('*')
      .eq('owner_ref', ownerRef)
      .eq('source', source)
      .eq('external_ref', externalRef)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Failed to get inbound task by external_ref: ${error.message}`,
      );
    }
    return data ? (data as unknown as InboundTaskRow) : undefined;
  },

  /**
   * Actualiza el status + patch de un row scoped a `ownerRef`. Cross-tenant /
   * inexistente → `InboundTaskNotFoundError` (existencia no filtrada, AC-9).
   */
  async updateStatus(
    ownerRef: string,
    id: string,
    status: InboundStatus,
    patch?: {
      budgetUsdc?: number;
      orchestrationId?: string;
      errorReason?: string;
    },
  ): Promise<InboundTaskRow> {
    const update: Database['public']['Tables']['a2a_inbound_tasks']['Update'] =
      {
        status,
      };
    if (patch?.budgetUsdc !== undefined) update.budget_usdc = patch.budgetUsdc;
    if (patch?.orchestrationId !== undefined) {
      update.orchestration_id = patch.orchestrationId;
    }
    if (patch?.errorReason !== undefined) {
      update.error_reason = patch.errorReason;
    }

    const { data, error } = await supabase
      .from('a2a_inbound_tasks')
      .update(update)
      .eq('id', id)
      .eq('owner_ref', ownerRef)
      .select()
      .single();

    if (error) {
      // PGRST116 = no rows (cross-tenant o inexistente) → not-found.
      if (error.code === 'PGRST116') throw new InboundTaskNotFoundError(id);
      throw new Error(`Failed to update inbound task: ${error.message}`);
    }
    return data as unknown as InboundTaskRow;
  },

  /**
   * Orquesta el lifecycle de una tarea inbound (SDD §4.4, 13 pasos). Asume que
   * la auth de la fuente YA fue verificada (el route pasó `cfg`).
   *
   * @throws InvalidInboundPayloadError    payload shape inválido (route → 400).
   * @throws InboundSourceMisconfiguredError  key pagadora inexistente/inactiva
   *                                          (firma FUE válida; route → 500).
   */
  async ingest(
    source: string,
    cfg: SourceConfig,
    payload: unknown,
  ): Promise<IngestResult> {
    // Paso 4: validate (never-throws) → !ok → 400 INVALID_PAYLOAD, sin row.
    const adapter = getInboundAdapter(source);
    const validation = adapter.validate(payload);
    if (!validation.ok) {
      throw new InvalidInboundPayloadError(validation.reason);
    }

    // Paso 5: normalize (never-throws).
    const normalized: NormalizedInboundTask = adapter.normalize(payload);

    // Paso 6: resolver key pagadora (Exemplar 6) → ownerRef.
    const keyHash = crypto
      .createHash('sha256')
      .update(cfg.a2aKeyRaw)
      .digest('hex');
    const keyRow = await identityService.lookupByHash(keyHash);
    if (!keyRow?.is_active) {
      throw new InboundSourceMisconfiguredError();
    }
    const ownerRef = keyRow.owner_ref;

    // Paso 6.5 (MNR-2): idempotencia por (owner_ref, source, external_ref). En un
    // endpoint money-path con auth por firma, la ventana de replay (300s) NO
    // alcanza: un request firmado re-enviado dentro de la ventana re-debitaría la
    // key. Si la fuente envió un `external_ref` y ya existe la tarea → replay
    // idempotente (NO se crea 2ª row, NO se re-invoca orchestrate → sin
    // doble-cobro). Sin external_ref el anti-replay es solo la ventana.
    if (normalized.externalRef !== null) {
      const existing = await this.getByExternalRef(
        ownerRef,
        cfg.source,
        normalized.externalRef,
      );
      if (existing) return replayResult(existing);
    }

    // Paso 7: crear row ingested (AC-1). El índice UNIQUE parcial (owner_ref,
    // source, external_ref) es el backstop de la race concurrente: si dos
    // ingestas idénticas pasan el pre-check a la vez, una gana el insert y la otra
    // recibe 23505 → se re-lee y se hace el mismo replay idempotente.
    let created: InboundTaskRow;
    try {
      created = await this.create(ownerRef, {
        source: cfg.source,
        externalRef: normalized.externalRef,
        goal: normalized.goal,
        constraints: normalized.constraints,
      });
    } catch (err) {
      if (
        err instanceof InboundDuplicateError &&
        normalized.externalRef !== null
      ) {
        const existing = await this.getByExternalRef(
          ownerRef,
          cfg.source,
          normalized.externalRef,
        );
        if (existing) return replayResult(existing);
      }
      throw err;
    }
    const id = created.id;

    // Paso 8: escrow gate (AC-5/CD-2) — NUNCA acreditar budget externo.
    if (normalized.declaresExternalEscrow) {
      const reason = 'external escrow/payment not honored (a2a-only)';
      await this.updateStatus(ownerRef, id, 'rejected', {
        errorReason: reason,
      });
      return { status: 'rejected', reason };
    }

    // Paso 9: SSRF gate (AC-7/CD-OBL-3) — validar ANTES de cualquier fetch.
    for (const url of normalized.embeddedUrls) {
      const r = await validateOutboundUrl(url);
      if (!r.ok) {
        const reason = `ssrf: ${r.error.reason}`;
        await this.updateStatus(ownerRef, id, 'rejected', {
          errorReason: reason,
        });
        return { status: 'rejected', reason };
      }
    }

    // Paso 10: cap del budget (AC-6/CD-2).
    const budgetUsdc = this.capBudget(normalized.budgetUsdc, cfg);

    // Pasos 11-13 + flujo de error (CD-10 fail-closed).
    const orchestrationId = crypto.randomUUID();
    try {
      // Paso 11: routed ANTES de invocar (AC-4).
      await this.updateStatus(ownerRef, id, 'routed', {
        budgetUsdc,
        orchestrationId,
      });

      // Paso 12: ruteo in-process (AC-4/CD-OBL-1). El `budget` es el cap
      // efectivo del path atómico (VERIFY-AT-IMPL: OrchestrateRequest NO declara
      // `maxQuotedCostUsdc`; el cap real es `budget` + el prepago de la key).
      const request: OrchestrateRequest = {
        goal: normalized.goal,
        budget: budgetUsdc,
        scopingKeyRow: keyRow,
        chainId: cfg.chainId,
      };
      const result = await orchestrateService.orchestrate(
        request,
        orchestrationId,
      );

      // Paso 13: éxito SOLO si pipeline.success===true (CD-10).
      if (result.pipeline.success === true) {
        try {
          await this.updateStatus(ownerRef, id, 'settled');
        } catch (settleErr) {
          // MNR-b: orchestrate ya debitó (money moved). Loguear para
          // reconciliación y devolver el resultado igual; NO degradar a un error
          // que sugiera "no se cobró", NO re-invocar orchestrate.
          log.error(
            {
              inboundTaskId: id,
              orchestrationId,
              errorClass:
                settleErr instanceof Error
                  ? settleErr.constructor.name
                  : 'unknown',
            },
            'inbound settled update failed after debit (reconcile)',
          );
        }
        return { status: 'settled', orchestrationId, answer: result.answer };
      }

      // Fail-closed: pipeline.success !== true ⇒ failed (CD-10).
      const reason = result.pipeline.error ?? 'orchestration not successful';
      await this.safeMarkFailed(ownerRef, id, reason);
      return { status: 'failed', reason };
    } catch (err) {
      // Fail-closed: throw / orchestrate no-ready ⇒ failed (CD-10).
      const reason = err instanceof Error ? err.message : 'orchestration error';
      await this.safeMarkFailed(ownerRef, id, reason);
      return { status: 'failed', reason };
    }
  },

  /**
   * Marca 'failed' best-effort. NUNCA throws (no debe enmascarar el fail-closed
   * ni proponer un éxito falso). Si el update falla, se loguea y se sigue.
   */
  async safeMarkFailed(
    ownerRef: string,
    id: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.updateStatus(ownerRef, id, 'failed', { errorReason: reason });
    } catch (err) {
      log.error(
        {
          inboundTaskId: id,
          errorClass: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'inbound failed-status update errored',
      );
    }
  },
};

// ── Custom Errors ───────────────────────────────────────────────

export class InboundTaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Inbound task '${id}' not found`);
    this.name = 'InboundTaskNotFoundError';
  }
}

export class InvalidInboundPayloadError extends Error {
  constructor(reason: string) {
    super(`Invalid inbound payload: ${reason}`);
    this.name = 'InvalidInboundPayloadError';
  }
}

/**
 * MNR-2: violación del índice UNIQUE parcial (owner_ref, source, external_ref)
 * al insertar. No es un error del caller: señala una ingesta duplicada
 * concurrente que `ingest` resuelve como replay idempotente.
 */
export class InboundDuplicateError extends Error {
  constructor() {
    super('Duplicate inbound task (owner_ref, source, external_ref)');
    this.name = 'InboundDuplicateError';
  }
}

export class InboundSourceMisconfiguredError extends Error {
  constructor() {
    super('Inbound source misconfigured (payer key inactive/missing)');
    this.name = 'InboundSourceMisconfiguredError';
  }
}
