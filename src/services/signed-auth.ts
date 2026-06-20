/**
 * Signed Auth Service — WKH-123 (per-request signature, opt-in)
 *
 * Capa de autenticación POR REQUEST sobre los bearer tokens existentes. Es
 * opt-in (`require_signature`) y back-compat absoluta (CD-1): si el flag es
 * false/null el middleware NUNCA invoca este service.
 *
 * Dos esquemas, mismo conjunto lógico de campos firmados
 * (`token_hash, method, path, nonce, timestamp`):
 *   - master keys (`wasi_a2a_*`): EIP-712, ancla = `funding_wallet`. El SERVER
 *     reconstruye el typed-data desde el lookup + headers (CD-9); el caller
 *     manda SOLO la firma. Recover con viem `recoverTypedDataAddress`.
 *   - session keys (`wasi_a2a_sess_*`): HMAC-SHA256, ancla = `signing_secret`.
 *     `key = SHA-256(secret) === signing_secret_hash`. Comparación en tiempo
 *     constante con `crypto.timingSafeEqual` (CD-10).
 *
 * Anti-replay (CD-3): INSERT en `a2a_signed_auth_nonces` (UNIQUE(token_hash,
 * nonce)); 23505 → replay. Orden de verificación: timestamp → firma → nonce.
 *
 * Las funciones reciben PRIMITIVOS (no `request` de Fastify) — el middleware
 * extrae method/path/headers y se los pasa.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { recoverTypedDataAddress } from 'viem';
import { supabase } from '../lib/supabase.js';
import type {
  RequestEip712Domain,
  SignedAuthHeaders,
  SignedAuthResult,
} from '../types/index.js';

// ── Constantes / defaults fail-safe ────────────────────────────

const SIGNED_AUTH_DEFAULT_SECONDS = 300;

/** bytes32 hex (`0x` + 64 hex). */
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
/** HMAC hex de 64 chars lowercase/uppercase. */
const HMAC_HEX_RE = /^[0-9a-fA-F]{64}$/;

// ── EIP-712 (master keys) ──────────────────────────────────────

// Replica `delegation.ts` con env propias (REQUEST_EIP712_*). `verifyingContract`
// se omite a propósito (paridad con el domain de delegación). Distinto domain
// (`WasiAI-a2a Request`) para evitar cross-protocol signature reuse.
const REQUEST_TYPES = {
  Request: [
    { name: 'token_hash', type: 'bytes32' },
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'timestamp', type: 'uint64' },
  ],
} as const;

/** Domain del server, leído de env con default (CD-6). */
export function buildRequestDomain(): RequestEip712Domain {
  return {
    name: process.env.REQUEST_EIP712_NAME ?? 'WasiAI-a2a Request',
    version: process.env.REQUEST_EIP712_VERSION ?? '1',
    chainId: Number(process.env.KITE_CHAIN_ID),
  };
}

// ── Env fail-safe getters ──────────────────────────────────────

/** Lee un env entero positivo; ausente/NaN/<=0 → default. Patrón key-session.ts:66-69. */
function positiveEnvSeconds(raw: string | undefined, fallback: number): number {
  const v = Number(raw ?? fallback);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Ventana de tolerancia del timestamp (segundos). */
export function clockSkewSeconds(): number {
  return positiveEnvSeconds(
    process.env.SIGNED_AUTH_CLOCK_SKEW_SECONDS,
    SIGNED_AUTH_DEFAULT_SECONDS,
  );
}

/** TTL del nonce (segundos) = max(ttl, skew) para no expirar antes que la ventana. */
export function nonceTtlSeconds(): number {
  const ttl = positiveEnvSeconds(
    process.env.SIGNED_AUTH_NONCE_TTL_SECONDS,
    SIGNED_AUTH_DEFAULT_SECONDS,
  );
  return Math.max(ttl, clockSkewSeconds());
}

// ── Timestamp ──────────────────────────────────────────────────

/**
 * `true` si `timestampRaw` (epoch seconds, string) está dentro de
 * `±clockSkewSeconds` respecto de ahora. NaN / no-entero → false (expirado).
 */
export function checkTimestamp(timestampRaw: string): boolean {
  const ts = Number(timestampRaw);
  if (!Number.isInteger(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.abs(nowSec - ts) <= clockSkewSeconds();
}

// ── Firma EIP-712 (master) ─────────────────────────────────────

/**
 * Verifica la firma EIP-712 de un request (master keys). El server reconstruye
 * el typed-data desde el lookup + headers; el caller manda solo `signature`.
 * Devuelve `true` sii el firmante recuperado == `fundingWallet` (case-insensitive).
 * Cualquier throw (firma malformada, recover falla) → `false` (NUNCA throw).
 *
 * @param tokenHashHex  SHA-256 del bearer en hex SIN `0x` (el lookup ya lo tiene).
 */
export async function verifyEip712RequestSignature(params: {
  tokenHashHex: string;
  method: string;
  path: string;
  nonce: string;
  timestamp: string;
  signature: string;
  fundingWallet: string;
}): Promise<boolean> {
  const { tokenHashHex, method, path, nonce, timestamp, signature } = params;

  // nonce debe ser bytes32 (el type EIP-712 es bytes32); si no → inválida.
  if (!BYTES32_RE.test(nonce)) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return false;

  try {
    const domain = buildRequestDomain();
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
      },
      types: REQUEST_TYPES,
      primaryType: 'Request',
      message: {
        token_hash: `0x${tokenHashHex}` as `0x${string}`,
        method,
        path,
        nonce: nonce as `0x${string}`,
        timestamp: BigInt(ts),
      },
      signature: signature as `0x${string}`,
    });
    return recovered.toLowerCase() === params.fundingWallet.toLowerCase();
  } catch {
    return false;
  }
}

// ── Firma HMAC-SHA256 (session) ────────────────────────────────

/**
 * Verifica la firma HMAC-SHA256 de un request (session keys). La clave HMAC es
 * `signingSecretHash` (= `SHA-256(secret)` = lo que el server tiene en DB). El
 * caller deriva la misma clave del secret plano. Comparación en tiempo constante
 * (CD-10). Firma malformada (no hex 64-char) → `false` sin throw.
 *
 * @param tokenHashHex      SHA-256 del bearer en hex SIN `0x`.
 * @param signingSecretHash hex de 64 chars (32 bytes) — la HMAC key.
 */
export function verifyHmacRequestSignature(params: {
  tokenHashHex: string;
  method: string;
  path: string;
  nonce: string;
  timestamp: string;
  signature: string;
  signingSecretHash: string;
}): boolean {
  const { tokenHashHex, method, path, nonce, timestamp, signature } = params;

  // Rechazar firmas malformadas ANTES de Buffer.from (patrón transform-hmac.ts).
  if (!HMAC_HEX_RE.test(signature)) return false;
  if (!HMAC_HEX_RE.test(params.signingSecretHash)) return false;

  const canonical = `${tokenHashHex}\n${method}\n${path}\n${nonce}\n${timestamp}`;
  const key = Buffer.from(params.signingSecretHash, 'hex'); // 32 bytes
  const expected = createHmac('sha256', key).update(canonical).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  // Check de longitud ANTES de timingSafeEqual (evita throw por longitud).
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

// ── Anti-replay ────────────────────────────────────────────────

/**
 * Registra el nonce para `tokenHash`. UNIQUE(token_hash, nonce) garantiza
 * atomicidad: 23505 → ya visto (replay) → devuelve `false`. Sin error → registró
 * (no replay) → `true`. Cualquier otro error de DB → throw (→ 503 en middleware).
 *
 * El TTL solo informa `expires_at` para housekeeping; la garantía dura es el
 * UNIQUE (las filas expiradas no se limpian en el hot path — MVP).
 */
export async function checkAndRecordNonce(
  tokenHash: string,
  nonce: string,
): Promise<boolean> {
  const expiresAt = new Date(
    Date.now() + nonceTtlSeconds() * 1000,
  ).toISOString();

  const { error } = await supabase
    .from('a2a_signed_auth_nonces')
    .insert({ token_hash: tokenHash, nonce, expires_at: expiresAt });

  if (error) {
    if (error.code === '23505') return false; // replay
    throw new Error(`Failed to record signed-auth nonce: ${error.message}`);
  }
  return true;
}

// ── Orquestador ────────────────────────────────────────────────

/**
 * Verifica la firma de un request completo (master O session) y registra el
 * nonce. Orden CD-3/CD-11: timestamp → firma → nonce. Devuelve un resultado
 * discriminado; el middleware mapea `code` a HTTP. NUNCA loguea firma/nonce/
 * secret/bearer (responsabilidad del caller).
 *
 * - Falta `signature` → `SIGNATURE_REQUIRED` (lo decide el caller; acá se valida
 *   por completitud).
 * - `master.fundingWallet` ausente → `FUNDING_WALLET_NOT_BOUND`.
 * - timestamp fuera de ventana → `TIMESTAMP_EXPIRED`.
 * - firma no verifica → `SIGNATURE_INVALID`.
 * - nonce repetido → `NONCE_REPLAY`.
 *
 * @param tokenHashHex  SHA-256 del bearer en hex SIN `0x` (var del lookup).
 */
export async function verifySignedAuth(params: {
  tokenHashHex: string;
  method: string;
  path: string;
  headers: SignedAuthHeaders;
  scheme:
    | { kind: 'eip712'; fundingWallet: string | null }
    | { kind: 'hmac'; signingSecretHash: string | null };
}): Promise<SignedAuthResult> {
  const { tokenHashHex, method, path, headers, scheme } = params;
  const { signature, nonce, timestamp } = headers;

  // Completitud de headers (AC-3 — el caller normalmente ya cortó antes).
  if (
    typeof signature !== 'string' ||
    signature.length === 0 ||
    typeof nonce !== 'string' ||
    nonce.length === 0 ||
    typeof timestamp !== 'string' ||
    timestamp.length === 0
  ) {
    return { ok: false, code: 'SIGNATURE_REQUIRED' };
  }

  // No-funding-wallet (AC-9): master con require_signature pero sin ancla.
  if (scheme.kind === 'eip712' && !scheme.fundingWallet) {
    return { ok: false, code: 'FUNDING_WALLET_NOT_BOUND' };
  }

  // 1. timestamp (AC-6) — ANTES de la firma.
  if (!checkTimestamp(timestamp)) {
    return { ok: false, code: 'TIMESTAMP_EXPIRED' };
  }

  // 2. firma (AC-4).
  let signatureOk: boolean;
  if (scheme.kind === 'eip712') {
    signatureOk = await verifyEip712RequestSignature({
      tokenHashHex,
      method,
      path,
      nonce,
      timestamp,
      signature,
      fundingWallet: scheme.fundingWallet as string, // garantizado no-null arriba
    });
  } else {
    if (!scheme.signingSecretHash) {
      // sesión sin secret pero require_signature:true → no puede verificar.
      return { ok: false, code: 'SIGNATURE_INVALID' };
    }
    signatureOk = verifyHmacRequestSignature({
      tokenHashHex,
      method,
      path,
      nonce,
      timestamp,
      signature,
      signingSecretHash: scheme.signingSecretHash,
    });
  }
  if (!signatureOk) {
    return { ok: false, code: 'SIGNATURE_INVALID' };
  }

  // 3. nonce (AC-5) — DESPUÉS de validar firma+timestamp. Registra antes de éxito.
  const fresh = await checkAndRecordNonce(tokenHashHex, nonce);
  if (!fresh) {
    return { ok: false, code: 'NONCE_REPLAY' };
  }

  return { ok: true };
}
