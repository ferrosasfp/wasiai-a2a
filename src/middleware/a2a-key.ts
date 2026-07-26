/**
 * A2A Key Middleware — Fastify preHandler hook
 * WKH-34-W4: Agentic Economy L3
 *
 * When x-a2a-key header is present: hash -> lookup -> validate -> debit -> execute.
 * When absent: delegate to existing x402 requirePayment() flow.
 */
import crypto from 'node:crypto';
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { resolveChainKey } from '../adapters/chain-resolver.js';
import {
  getAdaptersBundle,
  getDefaultChainKey,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import type { ChainKey } from '../adapters/types.js';
import { getLogger } from '../lib/logger.js';
import { PLACEHOLDER_FEE_USD } from '../lib/pricing-constants.js';
import { budgetService } from '../services/budget.js';
import {
  delegationService,
  exceedsPerTxLimit,
} from '../services/delegation.js';
import { identityService, isIdentityVerified } from '../services/identity.js';
import { keySessionService } from '../services/key-session.js';
import { receiptService } from '../services/receipt.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DelegationExpiredError,
  DelegationNotFoundError,
  DelegationRevokedError,
  DelegationTotalLimitExceededError,
  DestCapExceededError,
  OwnershipMismatchError,
  SessionBudgetExhaustedError,
  SessionExpiredError,
  SessionTokenInvalidError,
} from '../services/security/errors.js';
import { verifySignedAuth } from '../services/signed-auth.js';
import type {
  A2AAgentKeyRow,
  DelegationDebitContext,
  DelegationRow,
  KeySessionDebitContext,
  KeySessionRow,
  SignedAuthErrorCode,
  SignedAuthHeaders,
} from '../types/index.js';
import {
  type PaymentMiddlewareOptions,
  requirePayment,
  warnDefaultChainApplied,
  X_A2A_PAYMENT_CHAIN_HEADER,
} from './x402.js';

const log = getLogger('a2a-key');

// ── Fastify augmentation (CD-2: no any) ────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;
    gaslessEstimatedCostUsd?: number; // WKH-59
    gaslessChainKey?: ChainKey; // WKH-138 (gasless multichain) — resuelto una vez en preHandler A

    composeEstimatedCostUsd?: number; // WKH-59 (real-price-debit) — CD-9
    composeDestination?: string | undefined; // WKH-125 (cap por destino del step 0)
    resolvedChainId?: number; // WKH-59 (real-price-debit) DT-D
    delegationRow?: DelegationRow; // WKH-101
    delegationContext?: DelegationDebitContext; // WKH-101 DT-11 (débito per-step)
    keySessionRow?: KeySessionRow; // WKH-121
    keySessionContext?: KeySessionDebitContext; // WKH-121 (débito per-step)
    skipMiddlewareDebit?: boolean; // WKH-127: orchestrate debita post-plan en el service
  }
}

// ── Error codes for 403 responses ──────────────────────────

type A2AKeyMiddlewareErrorCode =
  | 'KEY_NOT_FOUND'
  | 'KEY_INACTIVE'
  | 'DAILY_LIMIT'
  | 'INSUFFICIENT_BUDGET'
  | 'PER_CALL_LIMIT'
  | 'CHAIN_NOT_SUPPORTED';
// TD-sprint-security WKH-61 MNR-2: 'SCOPE_DENIED' removed from this union.
// Scope enforcement moved to composeService.compose post-resolveAgent
// (see doc/sdd/059-wkh-61-sec-scope-1/); the middleware never emits it.

function send403(
  reply: FastifyReply,
  code: A2AKeyMiddlewareErrorCode,
  message: string,
) {
  return reply.status(403).send({ error: message, error_code: code });
}

// ── WKH-101: delegation 403/401 error codes (branch session) ───

type DelegationMiddlewareErrorCode =
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_TX_LIMIT_EXCEEDED'
  | 'DELEGATION_TOTAL_LIMIT_EXCEEDED'
  | 'AGENT_KEY_BUDGET_EXHAUSTED'
  | 'DELEGATION_CHAIN_NOT_ALLOWED'
  | 'OWNERSHIP_MISMATCH'
  | 'KEY_INACTIVE'
  // AR-MNR-1: límites del parent RPC bajo delegación (antes caían en 503).
  | 'DAILY_LIMIT'
  | 'KEY_NOT_FOUND'
  | 'DELEGATION_NOT_FOUND';

function send403delegation(
  reply: FastifyReply,
  code: DelegationMiddlewareErrorCode,
  message: string,
) {
  return reply.status(403).send({ error: message, error_code: code });
}

// ── WKH-121: key-session 403 error codes (branch sess) ─────────

type KeySessionMiddlewareErrorCode =
  | 'SESSION_EXPIRED'
  | 'KEY_INACTIVE'
  | 'SESSION_BUDGET_EXHAUSTED'
  | 'AGENT_KEY_BUDGET_EXHAUSTED'
  | 'OWNERSHIP_MISMATCH'
  | 'SESSION_TOKEN_INVALID'
  // prefijos del parent RPC bajo sesión (increment_a2a_key_spend).
  | 'DAILY_LIMIT'
  | 'KEY_NOT_FOUND';

function send403session(
  reply: FastifyReply,
  code: KeySessionMiddlewareErrorCode,
  message: string,
) {
  return reply.status(403).send({ error: message, error_code: code });
}

// ── WKH-123: signed-auth helpers (per-request signature, opt-in) ─

/**
 * Mapea un `SignedAuthErrorCode` al HTTP correcto: 403 para
 * `FUNDING_WALLET_NOT_BOUND` (AC-9), 401 para el resto (AC-3..AC-6).
 */
function sendSignedAuthError(
  reply: FastifyReply,
  code: SignedAuthErrorCode,
): FastifyReply {
  const status = code === 'FUNDING_WALLET_NOT_BOUND' ? 403 : 401;
  return reply.status(status).send({ error_code: code });
}

/**
 * Extrae los 3 headers de firma del request. NUNCA loguea sus valores (CD-5).
 * Ausencia → campos undefined (back-compat bearer si require_signature:false).
 */
function extractSignedHeaders(request: FastifyRequest): SignedAuthHeaders {
  const pick = (h: string | string[] | undefined): string | undefined =>
    typeof h === 'string' ? h : undefined;
  return {
    signature: pick(request.headers['x-a2a-signature']),
    nonce: pick(request.headers['x-a2a-nonce']),
    timestamp: pick(request.headers['x-a2a-timestamp']),
  };
}

/**
 * WKH-173 (MNR-1): fuente única de la verificación de firma opt-in. Reemplaza
 * el bloque duplicado verbatim en los 4 call-sites (master/session ×
 * pago/auth-only). Encapsula: si `require` → extractSignedHeaders → falta firma
 * `401 SIGNATURE_REQUIRED` → verifySignedAuth → mapeo del SignedAuthErrorCode
 * vía sendSignedAuthError. Comportamiento byte-idéntico al inline previo (mismos
 * status/códigos, mismo orden).
 *
 * Devuelve `true` sii YA envió una respuesta de error (el caller DEBE cortar con
 * `return`), `false` para continuar. NO devuelve el FastifyReply: `reply` es
 * thenable, así que `await` sobre un valor-reply lo desenvuelve a `undefined`
 * (falsy) y el early-return del caller se pierde → seguía debitando (bug del
 * fix-pack, ver auto-blindaje). El boolean es a prueba de ese footgun.
 */
async function verifyOptInSignature(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: {
    require: boolean;
    tokenHashHex: string;
    scheme:
      | { kind: 'eip712'; fundingWallet: string | null }
      | { kind: 'hmac'; signingSecretHash: string | null };
  },
): Promise<boolean> {
  if (opts.require !== true) {
    return false;
  }
  const headers = extractSignedHeaders(request);
  if (typeof headers.signature !== 'string' || headers.signature.length === 0) {
    reply.status(401).send({ error_code: 'SIGNATURE_REQUIRED' });
    return true;
  }
  const signedResult = await verifySignedAuth({
    tokenHashHex: opts.tokenHashHex,
    method: request.method.toUpperCase(),
    path: request.url.split('?')[0] ?? request.url,
    headers,
    scheme: opts.scheme,
  });
  if (!signedResult.ok) {
    sendSignedAuthError(reply, signedResult.code);
    return true;
  }
  return false;
}

// ── WKH-173: shared effectiveRow builders (DT-B) ───────────────

/**
 * WKH-173 (DT-B): builder puro del effectiveRow de delegación. Fuente única
 * compartida por resolveDelegationAuth (path pago) y authenticateDelegation
 * (auth-only). Réplica EXACTA de a2a-key.ts:503-513 (sin erc8004_verified, que
 * se setea en el call-site). Behavior-preserving (cubierto por la suite WKH-101).
 */
export function buildDelegationEffectiveRow(
  parentKey: A2AAgentKeyRow,
  delegation: DelegationRow,
): A2AAgentKeyRow {
  return {
    ...parentKey,
    allowed_registries:
      delegation.policy.allowed_registries.length > 0
        ? delegation.policy.allowed_registries
        : null,
    allowed_agent_slugs:
      delegation.policy.allowed_agent_slugs.length > 0
        ? delegation.policy.allowed_agent_slugs
        : null,
  };
}

/**
 * WKH-173 (DT-B): builder puro del effectiveRow de key-session. Fuente única
 * compartida por resolveKeySessionAuth (path pago) y authenticateKeySession
 * (auth-only). Réplica EXACTA de a2a-key.ts:740-754 (sin erc8004_verified).
 * Behavior-preserving (cubierto por la suite WKH-121).
 */
export function buildSessionEffectiveRow(
  parentKey: A2AAgentKeyRow,
  session: KeySessionRow,
): A2AAgentKeyRow {
  return {
    ...parentKey,
    allowed_registries:
      session.allowed_registries === null
        ? parentKey.allowed_registries
        : session.allowed_registries,
    allowed_agent_slugs:
      session.allowed_agent_slugs === null
        ? parentKey.allowed_agent_slugs
        : session.allowed_agent_slugs,
    allowed_categories:
      session.allowed_categories === null
        ? parentKey.allowed_categories
        : session.allowed_categories,
  };
}

// ── x402 delegation helper ─────────────────────────────────

async function runX402Fallback(
  x402Handlers: ReturnType<typeof requirePayment>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  for (const h of x402Handlers) {
    // x402 handlers are typed as sync (preHandlerHookHandler) but implemented
    // as async. We call them with a done callback AND await the potential promise.
    await new Promise<void>((resolve, reject) => {
      try {
        // Cast to extract the actual return value, which may be a Promise
        const maybePromise = h.call(
          request.server,
          request,
          reply,
          (err?: Error) => {
            if (err) reject(err);
            else resolve();
          },
        ) as unknown;
        // If the handler is actually async, it returns a Promise
        if (maybePromise instanceof Promise) {
          maybePromise.then(() => resolve(), reject);
        }
      } catch (err) {
        reject(err);
      }
    });
    if (reply.sent) return;
  }
}

// ── WKH-101: chain resolution helper (branch session) ─────────
// Replica EXACTA del bloque master (a2a-key.ts §6). Se mantiene en sync con
// ese bloque (no se refactoriza el master para no arriesgar CD-5 backward-compat).
// Devuelve null si ya envió una respuesta de error (reply.sent).
//
// WKH-175 (aditivo): cuando el header `x-payment-chain` está AUSENTE y la chain
// se resuelve por el default del registry, (a) se avisa vía
// `warnDefaultChainApplied` (warn deduplicado + debug per-request) en lugar de
// aplicarlo en silencio, y (b) se devuelve `defaultApplied` para que el 403
// INSUFFICIENT_BUDGET pueda explicar la CAUSA al caller. La resolución en sí
// NO cambia (mismo default, sigue siendo opcional) y el path
// "header presente pero desconocido" (400 CHAIN_NOT_SUPPORTED) queda intacto.
//
// `callerKeyId` (fix-pack MNR-1): id interno de la key del caller, usado SOLO
// como clave del dedup del warn y como field del log (observabilidad
// server-side). NO cambia nada de lo que se le devuelve al caller — el
// enriquecimiento del 403 sigue siendo exclusivo del branch master, donde el
// keyRow ES la credencial presentada (ver buildInsufficientBudgetMessage).
function resolveTargetChain(
  request: FastifyRequest,
  reply: FastifyReply,
  callerKeyId: string | null,
): {
  chainId: number;
  chainKey: string;
  assetSymbol: string;
  defaultApplied: boolean;
} | null {
  const headerRaw = request.headers['x-payment-chain'];
  const headerOverride = typeof headerRaw === 'string' ? headerRaw : undefined;
  const defaultChainKey = getDefaultChainKey();

  let chainKey = resolveChainKey({ headerOverride });
  let defaultApplied = false;
  if (!chainKey) {
    if (headerOverride !== undefined) {
      reply.status(400).send({
        error_code: 'CHAIN_NOT_SUPPORTED',
        error: `Chain '${headerOverride}' is not a recognized slug or chainId`,
      });
      return null;
    }
    chainKey = defaultChainKey ?? undefined;
    if (!chainKey) {
      reply.status(500).send({
        error_code: 'REGISTRY_NOT_INITIALIZED',
        error: 'No chains initialized in registry',
      });
      return null;
    }
    defaultApplied = true;
    // WKH-175 (+ fix-pack MNR-1: dedup por caller, no por slug).
    warnDefaultChainApplied(request, chainKey, callerKeyId);
  }

  const bundle = getAdaptersBundle(chainKey);
  if (!bundle) {
    reply.status(400).send({
      error_code: 'CHAIN_NOT_SUPPORTED',
      error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
    });
    return null;
  }

  // WKH-175: eco de la chain efectivamente usada. Choke-point único → cubre los
  // 3 branches (master / delegación / key-session) y también las salidas de
  // error posteriores (p.ej. el 403 INSUFFICIENT_BUDGET), que es justo donde el
  // caller necesita saber en qué red se intentó cobrar.
  //
  // MNR-2 (AR, documentado NO implementado): legible SOLO por callers
  // server-side — el CORS de src/index.ts no declara `exposedHeaders`, así que
  // un browser no puede leerlo (gap preexistente, compartido con
  // `x-a2a-remaining-budget`). Ver la nota extendida en middleware/x402.ts,
  // junto al otro `reply.header(X_A2A_PAYMENT_CHAIN_HEADER, ...)`.
  reply.header(X_A2A_PAYMENT_CHAIN_HEADER, chainKey);

  const chainId = bundle.chainConfig.chainId;
  const assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN';
  return { chainId, chainKey, assetSymbol, defaultApplied };
}

// ── WKH-175: mensaje accionable del 403 INSUFFICIENT_BUDGET ───────────

/**
 * Lista legible de las chains donde la key SÍ tiene saldo, derivada del jsonb
 * `budget` que YA viene en el row (identityService.lookupByHash hace
 * `select('*')`) — CERO queries extra a la DB y CERO datos de otros owners: son
 * los saldos de la propia key del caller (Ownership Guard intacto, no se toca
 * ninguna query sobre `a2a_agent_keys`).
 *
 * El slug se deriva del registry EN MEMORIA (`getInitializedChainKeys` +
 * `getAdaptersBundle`). Un chainId con saldo que no esté inicializado en este
 * proceso se muestra como `chain <id>` en vez de inventar un slug.
 *
 * `excludeChainId` (MNR-3 del CR): la chain TARGET queda fuera de la lista. Es
 * la que acaba de rechazar el cobro, así que ofrecerla como alternativa
 * ("chains with balance: <la misma>") invalida el mensaje: pasaba con
 * `budget={"2368":"0.5"}` y precio $1 — saldo > 0 pero insuficiente. Este helper
 * NO conoce el precio (sólo el jsonb `budget`), así que no puede decidir
 * "suficiente vs insuficiente"; lo honesto es excluirla y dejar que el PRIMER
 * segmento del mensaje reporte su saldo (que además viene de una lectura fresca
 * vía `budgetService.getBalance`, no del row cacheado).
 *
 * ⚠️ INVARIANTE DE SEGURIDAD: NO invocar desde los branches de delegación ni de
 * key-session. Ahí el `keyRow` es la PARENT KEY, no la credencial que presentó
 * el caller → devolver sus saldos sería una fuga cross-owner. Exclusivo del
 * branch master (ver también el header de `resolveTargetChain`).
 */
function describeFundedChains(
  budget: A2AAgentKeyRow['budget'],
  excludeChainId: number,
): string[] {
  const slugByChainId = new Map<number, string>();
  for (const key of getInitializedChainKeys()) {
    const chainId = getAdaptersBundle(key)?.chainConfig.chainId;
    if (typeof chainId === 'number') slugByChainId.set(chainId, key);
  }
  return (
    Object.entries(budget ?? {})
      .map(([chainIdRaw, amount]) => ({
        chainIdRaw,
        chainId: Number.parseInt(chainIdRaw, 10),
        amount: String(amount),
      }))
      .filter((entry) => Number.parseFloat(entry.amount) > 0)
      // MNR-3: fuera la chain que acaba de fallar (nunca es una "alternativa").
      .filter((entry) => entry.chainId !== excludeChainId)
      // Orden determinístico por chainId (los no-numéricos van al final).
      // MNR-3 (fix-pack AR): con Number.POSITIVE_INFINITY, dos claves no
      // numéricas daban `Infinity - Infinity = NaN` → orden
      // implementation-defined. MAX_SAFE_INTEGER + desempate por la clave cruda
      // → orden SIEMPRE determinístico (no alcanzable hoy, pero es un one-liner).
      .sort((a, b) => {
        const ai = Number.isFinite(a.chainId)
          ? a.chainId
          : Number.MAX_SAFE_INTEGER;
        const bi = Number.isFinite(b.chainId)
          ? b.chainId
          : Number.MAX_SAFE_INTEGER;
        return ai !== bi ? ai - bi : a.chainIdRaw.localeCompare(b.chainIdRaw);
      })
      .map(
        (entry) =>
          `${slugByChainId.get(entry.chainId) ?? `chain ${entry.chainIdRaw}`} (${entry.amount})`,
      )
  );
}

/**
 * WKH-175: el 403 INSUFFICIENT_BUDGET pasa de `chain 2368 balance is 0` (solo
 * el chainId numérico) a un mensaje accionable: slug de la chain, la CAUSA
 * cuando la chain vino del default por falta de header, y las OTRAS chains donde
 * la key sí tiene saldo. `status` (403) y `error_code` (INSUFFICIENT_BUDGET) NO
 * cambian — el enriquecimiento es sólo del texto de `error`.
 *
 * `fundedChains` llega YA computado (MNR-4 del CR): el call site lo necesita
 * también para el field `fundedChains` del log, y calcularlo dos veces abría la
 * puerta a que log y response divergieran si alguien toca una sola llamada.
 * Viene de `describeFundedChains(budget, chainId)` → NO incluye la chain target.
 *
 * ⚠️ INVARIANTE DE SEGURIDAD: NO invocar desde los branches de delegación ni de
 * key-session. Ahí el `keyRow` es la PARENT KEY, no la credencial que presentó
 * el caller → el mensaje filtraría saldos cross-owner. Exclusivo del branch
 * master (ver también el header de `resolveTargetChain`).
 */
function buildInsufficientBudgetMessage(args: {
  chainId: number;
  chainKey: string;
  balance: string;
  defaultApplied: boolean;
  fundedChains: string[];
}): string {
  const parts = [
    `chain ${args.chainId} (${args.chainKey}) balance is ${args.balance}`,
  ];
  if (args.defaultApplied) {
    parts.push(
      `no x-payment-chain header sent, used default '${args.chainKey}'`,
    );
  }
  parts.push(
    args.fundedChains.length > 0
      ? `chains with balance: ${args.fundedChains.join(', ')}`
      : // "OTHER": la chain target está excluida por diseño (MNR-3), así que
        // "no chain has balance" sería falso cuando la target tiene saldo
        // insuficiente-pero-no-cero.
        'no other chain has balance',
  );
  return parts.join('; ');
}

// ── Auth credential extraction ──────────────────────────────
// DT-2 (WKH-BEARER-AUTH): Priority order: x-a2a-key > Bearer wasi_a2a_* > x402.
// Devuelve el raw token a2a o undefined (→ fallback x402). Sin side effects.
// C2 (audit 2026-07-01): exported so route handlers derive the a2a credential
// with the SAME logic the auth middleware uses (x-a2a-key OR Bearer
// wasi_a2a_*). Reading only `x-a2a-key` at the route made a Bearer-authenticated
// caller look un-keyed to compose (a2aKey=undefined), wrongly triggering the
// operator-signed EIP-3009 branch (C2 operator-wallet drain).
export function extractRawKey(request: FastifyRequest): string | undefined {
  const headerKey = request.headers['x-a2a-key'];
  if (headerKey && typeof headerKey === 'string') {
    return headerKey;
  }
  // Check Authorization: Bearer wasi_a2a_* (DT-1/DT-3: case-insensitive scheme, case-sensitive prefix)
  const authHeader = request.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(authHeader);
    if (match?.[1]?.startsWith('wasi_a2a_')) {
      return match[1];
    }
  }
  return undefined;
}

// WKH-59: rutas que mueven valor on-chain (POST /gasless/transfer) inyectan
// el costo real vía request.gaslessEstimatedCostUsd desde un preHandler
// upstream. WKH-59 (real-price-debit): /compose inyecta el precio real del
// primer step vía request.composeEstimatedCostUsd. El resto de las rutas
// siguen con $1 placeholder (backward-compat).
// CD-7: el middleware NO lee request.body — solo campos augmentados.
// CD-9: composeEstimatedCostUsd y gaslessEstimatedCostUsd son distintos.
// DT-F: orden compose-first (rutas mutuamente excluyentes, sin colisión real).
function resolveEstimatedCostUsd(request: FastifyRequest): number {
  return typeof request.composeEstimatedCostUsd === 'number'
    ? request.composeEstimatedCostUsd
    : typeof request.gaslessEstimatedCostUsd === 'number'
      ? request.gaslessEstimatedCostUsd
      : PLACEHOLDER_FEE_USD;
}

/**
 * BLQ-MED-1 (AR HIGH-2, 2026-07-26): callback de "débito huérfano".
 *
 * Lo provee la RUTA (hoy sólo `/compose`) y el middleware lo invoca cuando el
 * débito step-0 YA se aplicó pero la respuesta al caller YA salió — o sea que la
 * ruta no va a ejecutar nada por lo que se cobró.
 *
 * POR QUÉ ACÁ Y NO EN EL ROUTE HANDLER: cuando el timer de `createTimeoutHandler`
 * manda el 504 desde FUERA del lifecycle, Fastify NO invoca el handler
 * (`fastify/lib/handle-request.js:132` `preHandlerCallback` → `if (reply.sent)
 * return`) ni los preHandlers restantes (`fastify/lib/hooks.js:407`
 * `hookIterator`). El credit-back que vivía en el handler era CÓDIGO INALCANZABLE
 * para la ventana "504 durante/después del débito", que es justamente la única en
 * la que el caller quedaba cobrado sin ejecución.
 *
 * POR QUÉ NO UN HOOK `onSend`/`onResponse`: esos corren en el momento en que la
 * respuesta sale, y el 504 puede salir MIENTRAS el RPC de débito está en vuelo.
 * Refundear ahí es una carrera: se acreditaría ANTES de que el débito aterrice y,
 * si el débito después falla (budget insuficiente, cap por destino), el refund
 * quedaría sin débito que revertir → INFLA el budget. Acá se llama sólo cuando el
 * débito YA está confirmado aplicado, así que no puede reembolsar de más.
 */
export type OrphanedDebitHandler = (request: FastifyRequest) => Promise<void>;

/**
 * BLQ-MED-1: se llama al FINAL de cada branch que debitó (master, delegación,
 * sesión), DESPUÉS del read del header de budget — el último `await` de I/O real
 * antes del handler. Entre este punto y el handler Fastify sólo corre microtasks
 * (`hookRunner` → `handleResolve` → `next()`), y una microtask no le da lugar al
 * event loop para disparar un `setTimeout`: no queda ventana descubierta.
 *
 * Fail-safe por construcción:
 *   - `skipMiddlewareDebit` (rutas `/orchestrate*`) ⟹ este middleware NO debitó
 *     ⟹ no hay nada que devolver;
 *   - sin callback (cualquier ruta que no lo pasa, p.ej. `/gasless`) ⟹ no-op:
 *     esta HU no cambia el comportamiento de ninguna otra ruta;
 *   - `!reply.sent` (el 99.99% de los requests) ⟹ no-op: el handler va a correr
 *     y sus propios credit-backs siguen siendo los únicos que aplican, así que
 *     no hay doble refund posible (son mutuamente excluyentes por el propio
 *     `reply.sent`).
 */
async function refundIfDebitOrphaned(
  request: FastifyRequest,
  reply: FastifyReply,
  onDebitOrphaned: OrphanedDebitHandler | undefined,
): Promise<void> {
  if (!onDebitOrphaned || request.skipMiddlewareDebit || !reply.sent) return;
  request.log.warn(
    { requestId: request.id },
    'a2a-key.debit-orphaned.refunding',
  );
  await onDebitOrphaned(request);
}

// ── BRANCH DELEGACIÓN (WKH-101) ──────────────────────────────
// El regex Bearer YA captura wasi_a2a_session_* (empieza con wasi_a2a_).
// El branch va DESPUÉS de extraer rawKey + estimatedCostUsd y ANTES de la
// resolución master-key. El path master (CD-5) queda intacto.
// Self-terminating: siempre responde o augmenta request + return (void).
async function resolveDelegationAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
  estimatedCostUsd: number,
  onDebitOrphaned?: OrphanedDebitHandler,
): Promise<unknown> {
  try {
    // 1. lookup por hash (AC-5)
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const delegation = await delegationService.lookupByTokenHash(hash);
    if (!delegation) {
      return reply.status(401).send({
        error: 'Session token not found',
        error_code: 'INVALID_SESSION_TOKEN',
      });
    }

    // 2. revoked / expired (AC-6) — pre-debit (re-chequeado bajo lock, CD-10)
    if (delegation.revoked_at !== null) {
      return send403delegation(
        reply,
        'DELEGATION_REVOKED',
        'Delegation has been revoked',
      );
    }
    if (Date.now() >= new Date(delegation.expires_at).getTime()) {
      return send403delegation(
        reply,
        'DELEGATION_EXPIRED',
        'Delegation has expired',
      );
    }

    // 3. cargar parent key (DT-9)
    const parentKey = await delegationService.getParentKey(delegation.key_id);
    if (!parentKey?.is_active) {
      return send403delegation(
        reply,
        'KEY_INACTIVE',
        'Parent agent key is inactive',
      );
    }

    // 4. resolver chain/bundle → chainId (REUSO del bloque master).
    // `delegation.key_id` = id de la parent key que paga (solo para el dedup +
    // log del warn del default; NO habilita ningún enriquecimiento de respuesta).
    const chain = resolveTargetChain(request, reply, delegation.key_id);
    if (!chain) return; // resolveTargetChain ya envió la respuesta de error
    const { chainId, chainKey, assetSymbol } = chain;
    request.resolvedChainId = chainId;

    // 5. DT-3 allowed_chains: vacío = SIN restricción (paridad master keys).
    //    Solo restringe si tiene elementos Y el chainId resuelto NO está.
    if (
      delegation.policy.allowed_chains.length > 0 &&
      !delegation.policy.allowed_chains.includes(chainId)
    ) {
      return send403delegation(
        reply,
        'DELEGATION_CHAIN_NOT_ALLOWED',
        `chain ${chainId} not in delegation allowed_chains`,
      );
    }

    // H1 (audit 2026-07-01): respect `skipMiddlewareDebit` exactly like the
    // master path (resolveMasterAuth §7). Routes that bill the REAL cost
    // post-plan in the service (all `/orchestrate*` routes set the flag) MUST
    // NOT be charged the flat `PLACEHOLDER_FEE_USD` ($1) step-0 debit here.
    // Before this fix, delegation callers were debited $1 unconditionally on
    // EVERY `/orchestrate`, `/orchestrate/plan` (a documented zero-debit quote)
    // and `/orchestrate/execute` and NEVER refunded on `no_agents` /
    // `no_relevant_agent` / `insufficient_funds` / pipeline failure — a
    // guaranteed, repeatable $1/call drain of the parent budget + delegation
    // `total_spent`.
    //
    // TRADE-OFF (documented for review): with the flag set, the delegation
    // step-0 is not billed by ANY layer for `/orchestrate*` (the service's
    // post-plan debit is gated on `billingKeyRow`, which excludes
    // delegation/session), so orchestrate step-0 becomes non-billed for
    // delegation callers (steps 1..N are still billed by compose via
    // `delegationContext`). This fails SAFE (never over-charges) and mirrors the
    // `/orchestrate/plan` zero-debit contract. Extending the service to bill
    // delegation/session step-0 post-plan is left as a follow-up. On `/compose`
    // (flag unset) the real-price step-0 debit + refund path is unchanged.
    if (!request.skipMiddlewareDebit) {
      // 6. AC-7 per-tx del STEP 0 (antes de debitar).
      if (
        exceedsPerTxLimit(delegation.policy.max_amount_per_tx, estimatedCostUsd)
      ) {
        return send403delegation(
          reply,
          'DELEGATION_TX_LIMIT_EXCEEDED',
          'Estimated cost exceeds per-transaction limit',
        );
      }

      // 7. AC-8/AC-9 débito ATÓMICO del STEP 0 (CD-12).
      request.log.info(
        { delegationId: delegation.id, chainKey, chainId, assetSymbol },
        'a2a-key.delegation.debit',
      );
      try {
        // WKH-125b: la delegación hereda el cap por destino de la parent key. El
        // step-0 de un compose bajo delegación DEBE propagar `composeDestination`
        // (canonicalizado por routes/compose.ts:resolveComposePriceHandler) al RPC
        // debit_delegation_and_parent → debit_with_dest_policy. Sin esto el RPC
        // recibía p_destination=NULL y el cap por destino se evadía (bypass).
        // CONDICIONAL (espeja el branch session, CD-7): sólo con composeDestination
        // pasamos el 6º arg; si no, la llamada de 5 args queda INTACTA (back-compat).
        if (request.composeDestination) {
          await delegationService.debitDelegationAndParent(
            delegation.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
            request.composeDestination,
          );
        } else {
          await delegationService.debitDelegationAndParent(
            delegation.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
          );
        }
      } catch (debitErr) {
        // WKH-125b: cap por destino excedido bajo delegación → HTTP 402 (no 403),
        // espejando el branch session. El budget NO se decrementó (rollback de la tx).
        if (debitErr instanceof DestCapExceededError) {
          return reply.status(402).send({
            error: `chain ${chainId} destination cap exceeded`,
            error_code: 'DEST_CAP_EXCEEDED',
          });
        }
        if (debitErr instanceof DelegationTotalLimitExceededError) {
          return send403delegation(
            reply,
            'DELEGATION_TOTAL_LIMIT_EXCEEDED',
            'Total delegation budget exceeded',
          );
        }
        if (debitErr instanceof AgentKeyBudgetExhaustedError) {
          return send403delegation(
            reply,
            'AGENT_KEY_BUDGET_EXHAUSTED',
            'Parent agent key budget exhausted',
          );
        }
        if (debitErr instanceof DelegationRevokedError) {
          return send403delegation(
            reply,
            'DELEGATION_REVOKED',
            'Delegation has been revoked',
          );
        }
        if (debitErr instanceof DelegationExpiredError) {
          return send403delegation(
            reply,
            'DELEGATION_EXPIRED',
            'Delegation has expired',
          );
        }
        // AR-MNR-1: límites de la parent key bajo delegación → 403 semántico
        // (antes caían en `throw debitErr` → outer catch → 503 + leak PG).
        if (debitErr instanceof DailyLimitExceededError) {
          return send403delegation(
            reply,
            'DAILY_LIMIT',
            'Daily spending limit exceeded',
          );
        }
        if (debitErr instanceof AgentKeyInactiveError) {
          return send403delegation(
            reply,
            'KEY_INACTIVE',
            'Parent agent key is inactive',
          );
        }
        if (debitErr instanceof AgentKeyNotFoundError) {
          return send403delegation(
            reply,
            'KEY_NOT_FOUND',
            'Parent agent key not found',
          );
        }
        if (debitErr instanceof DelegationNotFoundError) {
          return send403delegation(
            reply,
            'DELEGATION_NOT_FOUND',
            'Delegation not found',
          );
        }
        if (debitErr instanceof OwnershipMismatchError) {
          return send403delegation(
            reply,
            'OWNERSHIP_MISMATCH',
            'Delegation ownership mismatch',
          );
        }
        throw debitErr; // unexpected → outer catch → 503
      }
    }

    // 8. augment + SET delegationContext para los steps 2..N (DT-11/DT-7).
    //    effectiveRow inyecta el scoping de la policy (allowed_*) para que
    //    composeService.compose aplique checkScoping sin tocar compose/authz.
    const effectiveRow = buildDelegationEffectiveRow(parentKey, delegation);
    effectiveRow.erc8004_verified = isIdentityVerified(parentKey);
    request.a2aKeyRow = effectiveRow;
    request.delegationRow = delegation;
    request.delegationContext = {
      delegationId: delegation.id,
      ownerRef: parentKey.owner_ref,
      keyId: parentKey.id,
      maxAmountPerTx: delegation.policy.max_amount_per_tx,
    };

    // 9. remaining budget header (CD-12: mismo chainId del bundle).
    // HIGH-2 (2026-07-26): best-effort — ver el racional en el path master. Un
    // fallo de este read post-débito devolvía 503 con el débito ya aplicado.
    await budgetService
      .getBalance(parentKey.id, chainId, parentKey.owner_ref)
      .then((remaining) => {
        reply.header('x-a2a-remaining-budget', remaining);
      })
      .catch((balanceErr) => {
        request.log.warn(
          { err: balanceErr instanceof Error ? balanceErr.message : 'unknown' },
          'a2a-key.remaining-budget-header.skip',
        );
      });

    // BLQ-MED-1: el débito dual-ledger de la delegación ya está aplicado. Si el
    // 504 del timer salió mientras corría (o mientras corría el read de arriba),
    // el route handler NUNCA va a correr → devolver el step-0 acá.
    await refundIfDebitOrphaned(request, reply, onDebitOrphaned);
    return; // fin del branch — NO seguir al flujo master key
  } catch (err) {
    // log SIN token; 503 service error (igual que el catch master).
    request.log.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'a2a-key delegation branch error',
    );
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Delegation service temporarily unavailable',
    });
  }
}

// ── KEY-SESSION (WKH-121) ────────────────────────────────────
// Server-side session keys (SIN EIP-712). Va DESPUÉS del branch WKH-101
// (wasi_a2a_session_*) y ANTES del path master. Los prefijos son mutuamente
// exclusivos: 'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_') === false.
// Self-terminating: siempre responde o augmenta request + return (void).
async function resolveKeySessionAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
  estimatedCostUsd: number,
  onDebitOrphaned?: OrphanedDebitHandler,
): Promise<unknown> {
  try {
    // 1. lookup por hash O(1) (AC-4/AC-5).
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const session = await keySessionService.lookupByTokenHash(hash);
    if (!session) {
      return reply.status(401).send({
        error: 'Session token not found',
        error_code: 'SESSION_TOKEN_INVALID',
      });
    }

    // 2. revoked / expired (AC-6) — pre-debit (re-chequeado bajo lock, DT-3).
    if (session.revoked_at !== null) {
      return send403session(
        reply,
        'SESSION_TOKEN_INVALID',
        'Session token has been revoked',
      );
    }
    if (Date.now() >= new Date(session.expires_at).getTime()) {
      return send403session(reply, 'SESSION_EXPIRED', 'Session has expired');
    }

    // 3. cargar parent key y verificar is_active (AC-7).
    const parentKey = await keySessionService.getParentKey(session.key_id);
    if (!parentKey?.is_active) {
      return send403session(
        reply,
        'KEY_INACTIVE',
        'Parent agent key is inactive',
      );
    }

    // 3b. WKH-123 (AC-2): per-request signature opt-in (HMAC-SHA256). Va
    //     DESPUÉS del lookup+is_active y ANTES del debit (CD-11). Si la
    //     sesión NO exige firma → flujo bearer idéntico al pre-WKH-123
    //     (headers de firma ignorados, CD-1/AC-7). El `hash` (L~470) es el
    //     token_hash; HMAC lo usa hex SIN 0x.
    const sigHandled = await verifyOptInSignature(request, reply, {
      require: session.require_signature === true,
      tokenHashHex: hash,
      scheme: { kind: 'hmac', signingSecretHash: session.signing_secret_hash },
    });
    if (sigHandled) {
      return;
    }

    // 4. resolver chain/bundle → chainId (REUSO del bloque master).
    // `session.key_id` = id de la parent key que paga (solo dedup + log, ver
    // resolveTargetChain).
    const chain = resolveTargetChain(request, reply, session.key_id);
    if (!chain) return; // resolveTargetChain ya envió la respuesta de error
    const { chainId, chainKey, assetSymbol } = chain;
    request.resolvedChainId = chainId;

    // 5. AC-8/AC-9 débito ATÓMICO del STEP 0 (sesión + parent).
    // H1 (audit 2026-07-01): respect `skipMiddlewareDebit` like resolveMasterAuth
    // §7. `/orchestrate*` routes bill the real cost post-plan in the service, so
    // the flat $1 placeholder step-0 debit here must be skipped — otherwise a
    // key-session caller was charged $1 on every orchestrate call (including the
    // zero-debit `/orchestrate/plan` quote) and never refunded. Same documented
    // trade-off as the delegation branch (orchestrate step-0 becomes non-billed
    // for session callers; steps 1..N still billed by compose via
    // `keySessionContext`; `/compose` real-price debit+refund unchanged).
    if (!request.skipMiddlewareDebit) {
      request.log.info(
        { sessionId: session.id, chainKey, chainId, assetSymbol },
        'a2a-key.session.debit',
      );
      try {
        // WKH-125 (AC-6 fix): la sesión hereda el cap por destino de la parent
        // key. El step-0 de un compose DEBE propagar `composeDestination`
        // (augmentado por routes/compose.ts:resolveComposePriceHandler) al RPC
        // `debit_session_and_parent` → `debit_with_dest_policy`. Sin esto el RPC
        // recibía `p_destination=NULL`, caía a `increment_a2a_key_spend` y el cap
        // por destino se evadía por completo (bypass del cap con session key).
        // CONDICIONAL (espeja el branch master, CD-8b): sólo cuando hay
        // `composeDestination` pasamos el 6º arg destino; si no, la llamada de
        // 5 args queda INTACTA (back-compat para callers sin destino/política,
        // el RPC se comporta idéntico al pre-fix, AC-5).
        if (request.composeDestination) {
          await keySessionService.debitSessionAndParent(
            session.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
            request.composeDestination,
          );
        } else {
          await keySessionService.debitSessionAndParent(
            session.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
          );
        }
      } catch (debitErr) {
        // WKH-125 (AC-2/AC-6): cap por destino excedido bajo session key → HTTP
        // 402 (no 403), espejando el branch master. El budget NO se decrementó
        // (rollback de la tx en el RPC).
        if (debitErr instanceof DestCapExceededError) {
          return reply.status(402).send({
            error: `chain ${chainId} destination cap exceeded`,
            error_code: 'DEST_CAP_EXCEEDED',
          });
        }
        if (debitErr instanceof SessionBudgetExhaustedError) {
          return send403session(
            reply,
            'SESSION_BUDGET_EXHAUSTED',
            'Session budget exhausted',
          );
        }
        if (debitErr instanceof SessionExpiredError) {
          return send403session(
            reply,
            'SESSION_EXPIRED',
            'Session has expired',
          );
        }
        if (debitErr instanceof SessionTokenInvalidError) {
          return send403session(
            reply,
            'SESSION_TOKEN_INVALID',
            'Session token has been revoked',
          );
        }
        if (debitErr instanceof AgentKeyBudgetExhaustedError) {
          return send403session(
            reply,
            'AGENT_KEY_BUDGET_EXHAUSTED',
            'Parent agent key budget exhausted',
          );
        }
        if (debitErr instanceof DailyLimitExceededError) {
          return send403session(
            reply,
            'DAILY_LIMIT',
            'Daily spending limit exceeded',
          );
        }
        if (debitErr instanceof AgentKeyInactiveError) {
          return send403session(
            reply,
            'KEY_INACTIVE',
            'Parent agent key is inactive',
          );
        }
        if (debitErr instanceof AgentKeyNotFoundError) {
          return send403session(
            reply,
            'KEY_NOT_FOUND',
            'Parent agent key not found',
          );
        }
        if (debitErr instanceof OwnershipMismatchError) {
          return send403session(
            reply,
            'OWNERSHIP_MISMATCH',
            'Session ownership mismatch',
          );
        }
        throw debitErr; // unexpected → outer catch → 503
      }
    }

    // 6. augment + SET keySessionContext (AC-4/AC-10/DT-4). effectiveRow
    //    inyecta el scope efectivo de la sesión (intersección): por dimensión
    //    `effective = (session === null) ? parent : session`. La sesión ya fue
    //    validada ⊆ padre en creación (CD-4).
    const effectiveRow = buildSessionEffectiveRow(parentKey, session);
    effectiveRow.erc8004_verified = isIdentityVerified(parentKey);
    request.a2aKeyRow = effectiveRow;
    request.keySessionRow = session;
    request.keySessionContext = {
      sessionId: session.id,
      ownerRef: parentKey.owner_ref,
      keyId: parentKey.id,
    };

    // 7. remaining budget header (mismo chainId del bundle).
    // HIGH-2 (2026-07-26): best-effort — ver el racional en el path master. Un
    // fallo de este read post-débito devolvía 503 con el débito ya aplicado.
    await budgetService
      .getBalance(parentKey.id, chainId, parentKey.owner_ref)
      .then((remaining) => {
        reply.header('x-a2a-remaining-budget', remaining);
      })
      .catch((balanceErr) => {
        request.log.warn(
          { err: balanceErr instanceof Error ? balanceErr.message : 'unknown' },
          'a2a-key.remaining-budget-header.skip',
        );
      });

    // BLQ-MED-1: espejo del branch delegación — el débito dual-ledger de la
    // sesión ya está aplicado; si la respuesta ya salió, el handler no corre.
    await refundIfDebitOrphaned(request, reply, onDebitOrphaned);
    return; // fin del branch — NO seguir al flujo master key
  } catch (err) {
    request.log.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'a2a-key session branch error',
    );
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Key-session service temporarily unavailable',
    });
  }
}

// ── MASTER KEY (CD-5) ────────────────────────────────────────
// Path por defecto: rawKey sin prefijo session/sess. Lookup → validar →
// debitar (salvo skipMiddlewareDebit) → augmentar request.
// Self-terminating: responde error o augmenta request + cae al final (void).
async function resolveMasterAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
  estimatedCostUsd: number,
  onDebitOrphaned?: OrphanedDebitHandler,
): Promise<unknown> {
  let keyRow: A2AAgentKeyRow | null = null;

  try {
    // 1. Hash the key
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // 2. Look up the row
    keyRow = await identityService.lookupByHash(keyHash);
    if (!keyRow) {
      return send403(reply, 'KEY_NOT_FOUND', 'A2A key not found');
    }

    // 3. Validate is_active
    if (!keyRow.is_active) {
      return send403(reply, 'KEY_INACTIVE', 'A2A key is inactive');
    }

    // 4. Check daily limit with lazy reset
    if (keyRow.daily_limit_usd !== null) {
      const now = new Date();
      const resetAt = new Date(keyRow.daily_reset_at);
      let dailySpent = parseFloat(keyRow.daily_spent_usd);

      // Lazy reset: if past reset time, treat spent as 0
      if (now >= resetAt) {
        dailySpent = 0;
      }

      if (dailySpent >= parseFloat(keyRow.daily_limit_usd)) {
        return send403(reply, 'DAILY_LIMIT', 'Daily spending limit exceeded');
      }
    }

    // 5. Check per_call_limit
    // WKH-61: scoping check removed from middleware (it ran with empty target
    // and 403'd ALL keys with allowed_*). Scope is now enforced per-step in
    // composeService.compose, post-resolveAgent, where the real Agent target
    // is known. See doc/sdd/059-wkh-61-sec-scope-1/.
    if (keyRow.max_spend_per_call_usd !== null) {
      if (estimatedCostUsd > parseFloat(keyRow.max_spend_per_call_usd)) {
        return send403(
          reply,
          'PER_CALL_LIMIT',
          'Estimated cost exceeds per-call limit',
        );
      }
    }

    // 5b. WKH-123 (AC-1): per-request signature opt-in (EIP-712). Va DESPUÉS
    //     del lookup+is_active+limites y ANTES del debit (CD-11). Si la key NO
    //     exige firma → flujo bearer idéntico al pre-WKH-123 (headers de firma
    //     ignorados, CD-1/AC-7). El `keyHash` (L~636) es el token_hash; EIP-712
    //     lo usa como `0x${keyHash}` (lo agrega el service). El server
    //     reconstruye el typed-data; el caller manda SOLO la firma (CD-9).
    const sigHandled = await verifyOptInSignature(request, reply, {
      require: keyRow.require_signature === true,
      tokenHashHex: keyHash,
      scheme: { kind: 'eip712', fundingWallet: keyRow.funding_wallet },
    });
    if (sigHandled) {
      return;
    }

    // 6. Resolve target chain per-request — REUSO del helper resolveTargetChain
    // (WKH-104 TD-DRIFT: deduplicación del bloque master, behavior idéntico CD-1).
    const chain = resolveTargetChain(request, reply, keyRow.id);
    if (!chain) return; // resolveTargetChain ya envió la respuesta de error
    const { chainId, chainKey, assetSymbol, defaultApplied } = chain;
    request.resolvedChainId = chainId;

    // 7. Optimistic debit BEFORE execution (BLQ-1/2/3/4 fix)
    // Like Stripe/AWS: charge first, deliver after.
    // The PG function increment_a2a_key_spend is atomic with FOR UPDATE,
    // so this eliminates the race condition (BLQ-4) and ensures failed
    // requests are charged (BLQ-1), debit failures are surfaced (BLQ-2),
    // and service errors return 503 (BLQ-3).
    // WKH-127 (CD-9/CD-11): el débito step-0 master se salta cuando orchestrate
    // marcó `skipMiddlewareDebit` — el service debita el costo real post-plan
    // (Opción B). El flag aplica SOLO a este path master; los branches
    // deleg/session retornaron antes y lo IGNORAN.
    if (!request.skipMiddlewareDebit) {
      request.log.info(
        {
          keyId: keyRow.id,
          chainKey,
          chainId,
          asset_symbol: assetSymbol,
          amountUsd: estimatedCostUsd,
        },
        'a2a-key.debit',
      );
      // WKH-125: la llamada step-0 es compartida por master/gasless/x402/compose.
      // CONDICIONAL (CD-8b): sólo cuando hay `composeDestination` (augmentado por
      // routes/compose.ts:resolveComposePriceHandler) pasamos el 6º arg destino;
      // si no, la llamada de 3 args queda INTACTA (no rompe las aserciones de
      // 3-arg de master/gasless/x402, AC-5).
      const debitResult = request.composeDestination
        ? await budgetService.debit(
            keyRow.id,
            chainId,
            estimatedCostUsd,
            undefined,
            undefined,
            request.composeDestination,
            keyRow.owner_ref, // F-04 (audit): owner_ref del caller autenticado
          )
        : await budgetService.debit(
            keyRow.id,
            chainId,
            estimatedCostUsd,
            undefined,
            undefined,
            undefined,
            keyRow.owner_ref, // F-04 (audit): owner_ref del caller autenticado
          );
      if (!debitResult.success) {
        // WKH-125 (AC-2): cap por destino excedido → HTTP 402 (no 403/400). El
        // budget NO se decrementó (rollback de la tx en el RPC).
        if (debitResult.error === 'DEST_CAP_EXCEEDED') {
          return reply.status(402).send({
            error: `chain ${chainId} destination cap exceeded`,
            error_code: 'DEST_CAP_EXCEEDED',
          });
        }
        // AC-8: error message MUST include the target chainId so callers can
        // distinguish cross-chain confusion from generic insufficient-budget.
        // Cold path: extra getBalance call is acceptable (CD-6 only constrains
        // the happy path).
        const balance = await budgetService
          .getBalance(keyRow.id, chainId, keyRow.owner_ref)
          .catch(() => '0');
        // WKH-175: el mensaje pasa a ser accionable (slug + causa del default +
        // OTRAS chains con saldo). Los datos extra salen del `budget` jsonb que
        // YA está en memoria (`keyRow`), sin ninguna query adicional.
        // MNR-4 (CR): se computa UNA vez y se comparte entre el log y la
        // response — antes cada uno lo calculaba por separado y podían divergir.
        // MNR-3 (CR): `chainId` es el target → queda FUERA de la lista (la chain
        // que rechazó el cobro no es una alternativa que sugerirle al caller).
        const fundedChains = describeFundedChains(keyRow.budget, chainId);
        request.log.warn(
          {
            keyId: keyRow.id,
            chainKey,
            chainId,
            asset_symbol: assetSymbol,
            balance,
            defaultApplied, // WKH-175: ¿la chain vino del default por falta de header?
            fundedChains, // WKH-175: dónde MÁS tiene saldo (sin la chain target)
          },
          'a2a-key.insufficient-budget',
        );
        return send403(
          reply,
          'INSUFFICIENT_BUDGET',
          buildInsufficientBudgetMessage({
            chainId,
            chainKey,
            balance,
            defaultApplied,
            fundedChains,
          }),
        );
      }

      // WKH-124: emit budget_debit receipt for the MASTER debit (best-effort,
      // fire-and-forget CD-B). A failure here NEVER interrupts the request (CD-1).
      receiptService
        .emit({
          ownerRef: keyRow.owner_ref,
          agentKeyId: keyRow.id,
          sessionId: null,
          delegationId: null,
          receiptType: 'budget_debit',
          amountUsd: estimatedCostUsd,
          chainId,
          txHash: null,
          counterparty: null,
          orchestrationId: null,
        })
        .catch((e) =>
          log.warn(
            { detail: e instanceof Error ? e.message : e },
            '[receipts] emit failed',
          ),
        );
    }

    // 8. Augment request (AC-4)
    keyRow.erc8004_verified = isIdentityVerified(keyRow); // WKH-100 AC-6, derivado, sin RPC (DT-17)
    request.a2aKeyRow = keyRow;

    // 9. Set remaining budget header (AC-1) — read balance AFTER debit
    // CD-12: uses the SAME chainId resolved from the bundle above.
    // WKH-127: bajo `skipMiddlewareDebit` el middleware NO debitó, así que leer
    // el balance acá daría un valor no-debitado; el route handler setea este
    // header con el saldo post-débito real que expone el service.
    if (!request.skipMiddlewareDebit) {
      // HIGH-2 (2026-07-26): best-effort. Este read es SOLO para un header de
      // conveniencia y corre DESPUÉS de un débito exitoso; cuando fallaba, el
      // catch de abajo devolvía 503 SERVICE_ERROR con el débito ya aplicado y sin
      // ejecutar nada — cobro sin contraprestación por un header. Ahora el header
      // se omite y el request sigue: el caller que pagó recibe la ejecución que
      // pagó. Los otros 503 de este catch (lookup/debit que tiran ANTES o
      // DURANTE el débito, sin cobro) quedan intactos.
      await budgetService
        .getBalance(keyRow.id, chainId, keyRow.owner_ref)
        .then((postDebitBalance) => {
          reply.header('x-a2a-remaining-budget', postDebitBalance);
        })
        .catch((balanceErr) => {
          request.log.warn(
            {
              err: balanceErr instanceof Error ? balanceErr.message : 'unknown',
              keyId: keyRow?.id,
            },
            'a2a-key.remaining-budget-header.skip',
          );
        });
    }

    // BLQ-MED-1 (AR HIGH-2): el débito step-0 ya está aplicado. Si el 504 del
    // `createTimeoutHandler` salió mientras el débito (o el read del header de
    // arriba) estaba en vuelo, Fastify NO va a invocar el route handler, así que
    // el credit-back que vivía allá era inalcanzable y el caller quedaba cobrado
    // por un pipeline que nunca corrió. Único punto donde el débito está
    // confirmado aplicado Y todavía se puede revertir.
    await refundIfDebitOrphaned(request, reply, onDebitOrphaned);
  } catch (err) {
    request.log.error(
      {
        err: err instanceof Error ? err.message : 'unknown',
        keyId: keyRow?.id,
      },
      'a2a-key middleware error',
    );
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Budget service temporarily unavailable',
    });
  }
}

// ── WKH-173: auth-only resolvers (publish/patch/delete/list) ───
// Autentican la a2a-key y setean request.a2aKeyRow SIN chain/débito/limits/x402
// (CD-2/DT-C/DT-G). Cada código + helper es EL MISMO que emite el resolver pago
// en su paso de auth; la única diferencia es que estos NO ejecutan
// chain/limits/débito.

// Master key (auth-only). Subconjunto de resolveMasterAuth: hash → lookup →
// is_active → firma opt-in → augment. SIN limits/chain/débito/budget header.
async function authenticateMasterKey(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
): Promise<unknown> {
  let keyRow: A2AAgentKeyRow | null = null;

  try {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    keyRow = await identityService.lookupByHash(keyHash);
    if (!keyRow) {
      return send403(reply, 'KEY_NOT_FOUND', 'A2A key not found');
    }

    if (!keyRow.is_active) {
      return send403(reply, 'KEY_INACTIVE', 'A2A key is inactive');
    }

    const sigHandled = await verifyOptInSignature(request, reply, {
      require: keyRow.require_signature === true,
      tokenHashHex: keyHash,
      scheme: { kind: 'eip712', fundingWallet: keyRow.funding_wallet },
    });
    if (sigHandled) {
      return;
    }

    keyRow.erc8004_verified = isIdentityVerified(keyRow);
    request.a2aKeyRow = keyRow;
  } catch (err) {
    request.log.error(
      {
        err: err instanceof Error ? err.message : 'unknown',
        keyId: keyRow?.id,
      },
      'a2a-key middleware error',
    );
    // MNR-2 (WKH-173 CR): auth-only NO toca el budget service; el mensaje
    // preciso es de autenticación (el path pago conserva su mensaje de budget).
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Authentication service temporarily unavailable',
    });
  }
}

// Delegación (auth-only). Subconjunto de resolveDelegationAuth: lookup →
// revoked/expired → parent is_active → effectiveRow. SIN chain/allowed_chains/
// per-tx/débito/context/budget header.
async function authenticateDelegation(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
): Promise<unknown> {
  try {
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const delegation = await delegationService.lookupByTokenHash(hash);
    if (!delegation) {
      return reply.status(401).send({
        error: 'Session token not found',
        error_code: 'INVALID_SESSION_TOKEN',
      });
    }

    if (delegation.revoked_at !== null) {
      return send403delegation(
        reply,
        'DELEGATION_REVOKED',
        'Delegation has been revoked',
      );
    }
    if (Date.now() >= new Date(delegation.expires_at).getTime()) {
      return send403delegation(
        reply,
        'DELEGATION_EXPIRED',
        'Delegation has expired',
      );
    }

    const parentKey = await delegationService.getParentKey(delegation.key_id);
    if (!parentKey?.is_active) {
      return send403delegation(
        reply,
        'KEY_INACTIVE',
        'Parent agent key is inactive',
      );
    }

    const effectiveRow = buildDelegationEffectiveRow(parentKey, delegation);
    effectiveRow.erc8004_verified = isIdentityVerified(parentKey);
    request.a2aKeyRow = effectiveRow;
    request.delegationRow = delegation;
  } catch (err) {
    request.log.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'a2a-key delegation branch error',
    );
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Delegation service temporarily unavailable',
    });
  }
}

// Key-session (auth-only). Subconjunto de resolveKeySessionAuth: lookup →
// revoked/expired → parent is_active → firma HMAC opt-in → effectiveRow. SIN
// chain/débito/context/budget header.
async function authenticateKeySession(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
): Promise<unknown> {
  try {
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const session = await keySessionService.lookupByTokenHash(hash);
    if (!session) {
      return reply.status(401).send({
        error: 'Session token not found',
        error_code: 'SESSION_TOKEN_INVALID',
      });
    }

    if (session.revoked_at !== null) {
      return send403session(
        reply,
        'SESSION_TOKEN_INVALID',
        'Session token has been revoked',
      );
    }
    if (Date.now() >= new Date(session.expires_at).getTime()) {
      return send403session(reply, 'SESSION_EXPIRED', 'Session has expired');
    }

    const parentKey = await keySessionService.getParentKey(session.key_id);
    if (!parentKey?.is_active) {
      return send403session(
        reply,
        'KEY_INACTIVE',
        'Parent agent key is inactive',
      );
    }

    const sigHandled = await verifyOptInSignature(request, reply, {
      require: session.require_signature === true,
      tokenHashHex: hash,
      scheme: { kind: 'hmac', signingSecretHash: session.signing_secret_hash },
    });
    if (sigHandled) {
      return;
    }

    const effectiveRow = buildSessionEffectiveRow(parentKey, session);
    effectiveRow.erc8004_verified = isIdentityVerified(parentKey);
    request.a2aKeyRow = effectiveRow;
    request.keySessionRow = session;
  } catch (err) {
    request.log.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'a2a-key session branch error',
    );
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Key-session service temporarily unavailable',
    });
  }
}

/**
 * WKH-173: middleware auth-only para publish/patch/delete/list de agentes.
 * Autentica la a2a-key (master/delegación/sesión) y setea request.a2aKeyRow
 * SIN chain-resolution, SIN débito, SIN spend-limits, SIN x402 (CD-2/DT-C/DT-G).
 * Ausencia de credencial → 403 A2A_KEY_REQUIRED directo (AC-3).
 * Devuelve un array de 1 handler para preservar la ergonomía `...requireA2AKey()`.
 */
export function requireA2AKey(): preHandlerAsyncHookHandler[] {
  const handler: preHandlerAsyncHookHandler = async (request, reply) => {
    const rawKey = extractRawKey(request);
    if (!rawKey) {
      return reply.status(403).send({
        error: 'a2a-key required',
        error_code: 'A2A_KEY_REQUIRED',
        message:
          'Publishing requires an authenticated a2a-key. The x402 anonymous path cannot publish (no tenant identity).',
      });
    }
    if (rawKey.startsWith('wasi_a2a_session_')) {
      return authenticateDelegation(request, reply, rawKey);
    }
    if (rawKey.startsWith('wasi_a2a_sess_')) {
      return authenticateKeySession(request, reply, rawKey);
    }
    return authenticateMasterKey(request, reply, rawKey);
  };
  return [handler];
}

// ── Middleware factory (dispatcher) ──────────────────────────
// Detecta el tipo de credencial y delega al resolver correcto, preservando
// el orden y los early-returns originales: x-a2a-key/Bearer → (session > sess
// > master) ; ausencia → x402 fallback.

/**
 * BLQ-MED-1: hooks OPCIONALES de la ruta. `onDebitOrphaned` es el credit-back
 * que la ruta quiere que se ejecute si el débito step-0 se aplicó pero la
 * respuesta ya salió (típicamente el 504 del timeout) — ver
 * `refundIfDebitOrphaned`. Segundo parámetro (no un campo de
 * `PaymentMiddlewareOptions`) para que ninguna ruta existente cambie de
 * comportamiento: sin este hook el middleware se comporta exactamente igual que
 * antes. Hoy sólo `/compose` lo pasa; `/gasless/transfer` tiene su propio
 * agujero pre-existente (HU aparte) y NO se toca acá.
 */
export interface PaymentRouteHooks {
  onDebitOrphaned?: OrphanedDebitHandler;
}

export function requirePaymentOrA2AKey(
  x402Opts: PaymentMiddlewareOptions,
  hooks?: PaymentRouteHooks,
): preHandlerAsyncHookHandler[] {
  const x402Handlers = requirePayment(x402Opts);
  const onDebitOrphaned = hooks?.onDebitOrphaned;

  const handler: preHandlerAsyncHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const rawKey = extractRawKey(request);

    if (!rawKey) {
      // No a2a key -- delegate to x402 flow
      await runX402Fallback(x402Handlers, request, reply);
      return;
    }

    const estimatedCostUsd = resolveEstimatedCostUsd(request);

    // El regex Bearer YA captura wasi_a2a_session_* (empieza con wasi_a2a_).
    // El branch va DESPUÉS de extraer rawKey + estimatedCostUsd y ANTES de la
    // resolución master-key. El path master (CD-5) queda intacto.
    if (rawKey.startsWith('wasi_a2a_session_')) {
      return resolveDelegationAuth(
        request,
        reply,
        rawKey,
        estimatedCostUsd,
        onDebitOrphaned,
      );
    }

    // Server-side session keys (SIN EIP-712). Va DESPUÉS del branch WKH-101
    // (wasi_a2a_session_*) y ANTES del path master. Los prefijos son mutuamente
    // exclusivos: 'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_') === false.
    if (rawKey.startsWith('wasi_a2a_sess_')) {
      return resolveKeySessionAuth(
        request,
        reply,
        rawKey,
        estimatedCostUsd,
        onDebitOrphaned,
      );
    }

    return resolveMasterAuth(
      request,
      reply,
      rawKey,
      estimatedCostUsd,
      onDebitOrphaned,
    );
  };

  return [handler];
}
