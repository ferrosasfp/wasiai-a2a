#!/usr/bin/env node
/**
 * WKH-SEC-02 — Verifica que ROW LEVEL SECURITY esté habilitada en las 7 tablas
 * con owner_ref, consultando `pg_class.relrowsecurity` via Management API (PAT).
 *
 * Read-only. exit 0 si las 7 tablas existen y todas con rls_enabled === true.
 * exit 1 si alguna está en false o falta. exit 3 si falta PAT/ref (config).
 *
 * Uso:
 *   node scripts/verify-rls-enabled.mjs <project_ref>
 *   PROJECT_REF=<ref> node scripts/verify-rls-enabled.mjs
 *   node scripts/verify-rls-enabled.mjs            # deriva ref de SUPABASE_URL
 *
 * Refs conocidas: dev bdwvrwzvsldephfibmuu, prod caldzjhjgctpgodldqav.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Las 7 tablas EXACTAS con owner_ref (set canónico, WKH-SEC-02). Definidas una
// sola vez y reusadas para construir el query y para validar el resultado.
export const RLS_TABLES = [
  'a2a_agent_keys',
  'a2a_key_sessions',
  'a2a_delegations',
  'a2a_key_deposits',
  'a2a_receipts',
  'a2a_key_spend_policies',
  'a2a_key_dest_spend_ledger',
];

/**
 * Parsea un archivo `.env` simple (KEY=value, con manejo de comillas). Ignora
 * errores (archivo ausente). Mismo patrón que apply-security-rpc-migration.mjs.
 * @param {string} p
 * @returns {Record<string, string>}
 */
export function readEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Construye el SELECT read-only sobre pg_class.relrowsecurity para las 7 tablas.
 * `information_schema` NO expone el flag RLS — por eso pg_class (DT-5).
 * @returns {string}
 */
export function buildRlsQuery() {
  const inList = RLS_TABLES.map((t) => `'${t}'`).join(',');
  return [
    'SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled',
    'FROM pg_class c',
    'JOIN pg_namespace n ON n.oid = c.relnamespace',
    "WHERE n.nspname = 'public'",
    `  AND c.relname IN (${inList})`,
    'ORDER BY c.relname;',
  ].join('\n');
}

/**
 * Evalúa las filas devueltas por el query. Función pura (sin I/O).
 * @param {Array<{ table_name: string, rls_enabled: boolean }>} rows
 * @returns {{ ok: boolean, missing: string[], disabled: string[], unexpected: string[] }}
 */
export function evaluateRlsRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byName = new Map(list.map((r) => [r.table_name, r.rls_enabled]));

  const missing = RLS_TABLES.filter((t) => !byName.has(t));
  const disabled = RLS_TABLES.filter((t) => byName.has(t) && byName.get(t) !== true);
  const expected = new Set(RLS_TABLES);
  const unexpected = list.map((r) => r.table_name).filter((t) => !expected.has(t));

  const ok = missing.length === 0 && disabled.length === 0 && unexpected.length === 0;
  return { ok, missing, disabled, unexpected };
}

/**
 * Resuelve el project ref: arg CLI > env PROJECT_REF > derivar de SUPABASE_URL.
 * @param {string[]} argv
 * @param {Record<string, string>} env
 * @returns {string | null}
 */
export function resolveProjectRef(argv, env) {
  const arg = argv.slice(2).find((a) => !a.startsWith('--'));
  if (arg) return arg;
  if (env.PROJECT_REF) return env.PROJECT_REF;
  const refMatch = (env.SUPABASE_URL ?? '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return refMatch ? refMatch[1] : null;
}

/**
 * Orquesta la verificación. Dependencias inyectables para testabilidad.
 * @param {{
 *   fetch?: typeof fetch,
 *   env?: Record<string, string>,
 *   argv?: string[],
 *   log?: (msg: string) => void,
 *   error?: (msg: string) => void,
 *   exit?: (code: number) => void,
 * }} [deps]
 */
export async function main(deps = {}) {
  const log = deps.log ?? ((m) => console.log(m));
  const errlog = deps.error ?? ((m) => console.error(m));
  const exit = deps.exit ?? ((c) => process.exit(c));
  const doFetch = deps.fetch ?? fetch;
  const argv = deps.argv ?? process.argv;
  const env =
    deps.env ?? {
      ...readEnv('/home/ferdev/.openclaw/workspace/wasiai-a2a/.env'),
      ...readEnv('/home/ferdev/.openclaw/workspace/wasiai-a2a/.env.local'),
    };

  const PAT = env.SUPABASE_ACCESS_TOKEN;
  const PROJECT_REF = resolveProjectRef(argv, env);
  if (!PAT || !PROJECT_REF) {
    errlog('Missing SUPABASE_ACCESS_TOKEN (PAT) or project ref (arg/PROJECT_REF/SUPABASE_URL)');
    return exit(3);
  }

  const query = buildRlsQuery();
  log(`Verifying RLS on ${RLS_TABLES.length} tables in ${PROJECT_REF}...`);

  const res = await doFetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    },
  );

  if (!res.ok) {
    errlog(`HTTP ${res.status} from Management API: ${await res.text()}`);
    return exit(1);
  }

  const rows = await res.json();
  const result = evaluateRlsRows(rows);

  if (result.ok) {
    log(`[PASS] RLS enabled on all ${RLS_TABLES.length} tables.`);
    return exit(0);
  }

  if (result.missing.length) errlog(`[FAIL] Missing tables (no row returned): ${result.missing.join(', ')}`);
  if (result.disabled.length) errlog(`[FAIL] RLS disabled on: ${result.disabled.join(', ')}`);
  if (result.unexpected.length) errlog(`[FAIL] Unexpected tables in result: ${result.unexpected.join(', ')}`);
  return exit(1);
}

// Entrypoint — solo corre en invocación directa, no cuando un test lo importa.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === (process.argv[1] ?? '');
if (isDirectInvocation) {
  main({ argv: process.argv });
}
