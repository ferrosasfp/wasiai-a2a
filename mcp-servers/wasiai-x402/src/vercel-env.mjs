// SPDX-License-Identifier: MIT
// vercel-env.mjs — thin wrapper over the Vercel REST API (WKH-75 W0).
//
// Used by:
//   - scripts/rotate-bearer.mjs (headless mode)            → W2
//   - api/cron/rotate-bearer.mjs                            → W3
//   - api/cron/invalidate-prev-bearer.mjs                   → W3
//
// Invariants (per SDD §3 DT-1, §4 DT-B, CDs 5/9/13/17):
//   - CD-5: every fetch carries a 10s timeout via AbortController.
//   - CD-13 (auto-blindaje WKH-66): `clearTimeout(t)` is invoked from inside
//     the abort listener AND in every return/throw branch — orphan timers
//     keep the event loop alive across tests and Vercel functions.
//   - CD-9: NEVER include the token, the env value, or the response body in
//     thrown error messages or log lines. We surface only `{status, opName}`.
//   - CD-17: when callers log around this module, they must assert against
//     `new URL(call.url).host === 'api.vercel.com'`, not the full URL — the
//     querystring may carry a teamId scope.
//   - redirect:'error' (CD-18 herencia WKH-66) — Vercel API never redirects;
//     a 3xx is a sign of misrouting and must surface as an error.
//
// Endpoints (DT-1):
//   GET    /v10/projects/{id}/env?decrypt=true
//   POST   /v10/projects/{id}/env
//   PATCH  /v10/projects/{id}/env/{envId}
//   DELETE /v10/projects/{id}/env/{envId}
//   POST   /v13/deployments
// Team scoping (?teamId=<id>) is appended via querystring, NOT path.

const VERCEL_API_BASE = 'https://api.vercel.com';
const DEFAULT_TIMEOUT_MS = 10_000;

export class VercelEnvError extends Error {
  /**
   * @param {string} message — short literal, NEVER includes token/value/body.
   * @param {{status: number, opName: string}} meta
   */
  constructor(message, { status, opName } = {}) {
    super(message);
    this.name = 'VercelEnvError';
    this.status = status;
    this.opName = opName;
  }
}

/**
 * Append `?teamId=<id>` (or `&teamId=<id>` if path already has a `?`) when
 * teamId is truthy. Path returned otherwise unchanged.
 */
function _withTeamScope(path, teamId) {
  if (!teamId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}teamId=${encodeURIComponent(teamId)}`;
}

/**
 * Internal request helper. Wraps fetch with a 10s timeout (CD-5) and orphan-
 * timer guard (CD-13). NEVER reads the response body on error to avoid leak
 * (CD-9).
 *
 * @returns {Promise<any>} parsed JSON body when `res.ok`. For 204 / empty
 *   responses returns null.
 * @throws {VercelEnvError} on non-2xx, network error, or timeout.
 */
async function _request({ method, path, token, teamId, body, opName, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = `${VERCEL_API_BASE}${_withTeamScope(path, teamId)}`;
  const controller = new AbortController();
  // CD-13: declare `t` before the listener so `clearTimeout` always has the
  // handle in scope. The abort listener clears the timer to avoid leaks if
  // the abort was triggered by something other than the timeout itself.
  let t;
  const onAbort = () => { if (t) clearTimeout(t); };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  t = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (err) {
    // CD-13: clear the timer in the failure path before re-throwing.
    if (t) clearTimeout(t);
    controller.signal.removeEventListener('abort', onAbort);
    // CD-9: log only the error class/name, never the URL (querystring carries
    // teamId; body is not logged either way).
    if (err?.name === 'AbortError') {
      throw new VercelEnvError('vercel api request timed out', { status: 0, opName });
    }
    throw new VercelEnvError('vercel api network error', { status: 0, opName });
  } finally {
    // Defensive: also clear here. clearTimeout on an already-cleared handle
    // is a no-op so this is safe to call twice.
    if (t) clearTimeout(t);
    controller.signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    // CD-9: NEVER read res.text() into the error message — the response body
    // can echo the env value we sent (Vercel returns the env record on 4xx
    // sometimes). Status + opName is enough for the caller.
    throw new VercelEnvError('vercel api error', { status: res.status, opName });
  }

  if (res.status === 204) return null;
  // Some endpoints (DELETE) return 200 with empty body; guard against that.
  const txt = await res.text();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    // Empty / non-JSON body on 2xx is treated as null — caller decides.
    return null;
  }
}

/**
 * GET /v10/projects/{projectId}/env?decrypt=true
 * Returns the array of env records (id, key, value, target, type).
 */
export async function listEnvs({ projectId, token, teamId } = {}) {
  if (!projectId) throw new VercelEnvError('projectId required', { status: 0, opName: 'listEnvs' });
  if (!token) throw new VercelEnvError('token required', { status: 0, opName: 'listEnvs' });
  const path = `/v10/projects/${encodeURIComponent(projectId)}/env?decrypt=true`;
  const data = await _request({ method: 'GET', path, token, teamId, opName: 'listEnvs' });
  // Vercel returns either { envs: [...] } or { ...arrayShape }. Normalize.
  if (data && Array.isArray(data.envs)) return data.envs;
  if (Array.isArray(data)) return data;
  return [];
}

/**
 * POST /v10/projects/{projectId}/env — create a new env var.
 *
 * @returns {Promise<{id: string}>} the created env record (caller cares
 *   about `id` for later updates).
 */
export async function createEnv({ projectId, token, teamId, key, value, target = 'production' } = {}) {
  if (!projectId) throw new VercelEnvError('projectId required', { status: 0, opName: 'createEnv' });
  if (!token) throw new VercelEnvError('token required', { status: 0, opName: 'createEnv' });
  if (!key) throw new VercelEnvError('key required', { status: 0, opName: 'createEnv' });
  if (typeof value !== 'string') {
    throw new VercelEnvError('value must be string', { status: 0, opName: 'createEnv' });
  }
  const path = `/v10/projects/${encodeURIComponent(projectId)}/env`;
  const body = {
    key,
    value,
    target: Array.isArray(target) ? target : [target],
    type: 'encrypted',
  };
  const data = await _request({ method: 'POST', path, token, teamId, body, opName: 'createEnv' });
  // Vercel returns either the created record or `{ created: {...} }`.
  if (data?.created?.id) return { id: data.created.id };
  if (data?.id) return { id: data.id };
  return { id: undefined };
}

/**
 * PATCH /v10/projects/{projectId}/env/{envId} — update an existing env value.
 *
 * @returns {Promise<{id: string}>}
 */
export async function updateEnv({ projectId, token, teamId, envId, value } = {}) {
  if (!projectId) throw new VercelEnvError('projectId required', { status: 0, opName: 'updateEnv' });
  if (!token) throw new VercelEnvError('token required', { status: 0, opName: 'updateEnv' });
  if (!envId) throw new VercelEnvError('envId required', { status: 0, opName: 'updateEnv' });
  if (typeof value !== 'string') {
    throw new VercelEnvError('value must be string', { status: 0, opName: 'updateEnv' });
  }
  const path = `/v10/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`;
  const data = await _request({
    method: 'PATCH', path, token, teamId,
    body: { value },
    opName: 'updateEnv',
  });
  return { id: data?.id ?? envId };
}

/**
 * DELETE /v10/projects/{projectId}/env/{envId}
 *
 * Idempotent: a 404 (env already missing) resolves successfully — callers
 * can invoke deleteEnv without first checking existence.
 */
export async function deleteEnv({ projectId, token, teamId, envId } = {}) {
  if (!projectId) throw new VercelEnvError('projectId required', { status: 0, opName: 'deleteEnv' });
  if (!token) throw new VercelEnvError('token required', { status: 0, opName: 'deleteEnv' });
  if (!envId) throw new VercelEnvError('envId required', { status: 0, opName: 'deleteEnv' });
  const path = `/v10/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`;
  try {
    await _request({ method: 'DELETE', path, token, teamId, opName: 'deleteEnv' });
  } catch (err) {
    if (err instanceof VercelEnvError && err.status === 404) {
      return; // idempotent
    }
    throw err;
  }
}

/**
 * POST /v13/deployments — trigger a redeploy.
 *
 * Best-effort optimization (DT-5/DT-6): failure here does NOT block rotation
 * success because Vercel re-injects env vars on next worker cold start.
 *
 * @returns {Promise<{id?: string, url?: string}>}
 */
export async function triggerRedeploy({ projectId, token, teamId, target = 'production' } = {}) {
  if (!projectId) throw new VercelEnvError('projectId required', { status: 0, opName: 'triggerRedeploy' });
  if (!token) throw new VercelEnvError('token required', { status: 0, opName: 'triggerRedeploy' });
  const path = '/v13/deployments';
  const body = {
    name: projectId,
    target,
    gitSource: { type: 'github', ref: 'main' },
  };
  const data = await _request({ method: 'POST', path, token, teamId, body, opName: 'triggerRedeploy' });
  return { id: data?.id, url: data?.url };
}
