import { createHmac } from 'node:crypto';

const DEV_FALLBACK_SECRET = 'wasiai-dev-caller-hmac-v1';
let _warnedMissingSecret = false;

/**
 * Resuelve el secret del HMAC desde REPUTATION_CALLER_HMAC_SECRET. Si ausente,
 * usa un fallback de dev con warn una sola vez (degradación segura para
 * dev/test). En prod DEBE setearse el secret real. Patrón resolveScaleFactor.
 */
function resolveCallerHashSecret(): string {
  const secret = process.env.REPUTATION_CALLER_HMAC_SECRET;
  if (secret && secret.length > 0) return secret;
  if (!_warnedMissingSecret) {
    console.warn(
      '[caller-hash] REPUTATION_CALLER_HMAC_SECRET ausente — usando fallback de dev. Setear el secret real en prod.',
    );
    _warnedMissingSecret = true;
  }
  return DEV_FALLBACK_SECRET;
}

/**
 * HMAC-SHA256 del owner_ref para identificar callers distintos sin exponer la
 * identidad cruda (CD-5/CD-6). Determinista intra-deployment (CD-11).
 * - null/undefined/'' → null (caller anónimo, AC-12).
 * - NUNCA retorna ni loguea el owner_ref crudo.
 */
export function hashCallerRef(
  ownerRef: string | null | undefined,
): string | null {
  if (ownerRef == null || ownerRef === '') return null;
  return createHmac('sha256', resolveCallerHashSecret())
    .update(ownerRef)
    .digest('hex');
}

/** TEST-ONLY — resetea el flag de warn (patrón _resetReputationCache). */
export function _resetCallerHashWarn(): void {
  _warnedMissingSecret = false;
}
