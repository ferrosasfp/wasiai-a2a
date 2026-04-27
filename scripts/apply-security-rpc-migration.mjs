#!/usr/bin/env node
/**
 * Aplica la migration security RPC search_path a Supabase dev (bdwvrwzvsldephfibmuu)
 * via Management API (PAT).
 * Idempotente.
 */
import { readFileSync } from 'node:fs';

function readEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* ignore */ }
  return out;
}

const env = {
  ...readEnv('/home/ferdev/.openclaw/workspace/wasiai-a2a/.env'),
  ...readEnv('/home/ferdev/.openclaw/workspace/wasiai-a2a/.env.local'),
};

const PAT = env.SUPABASE_ACCESS_TOKEN;
const refMatch = (env.SUPABASE_URL ?? '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
if (!PAT || !refMatch) { console.error('Missing PAT or URL'); process.exit(3); }
const PROJECT_REF = refMatch[1];

const sql = readFileSync('/home/ferdev/.openclaw/workspace/wasiai-a2a/supabase/migrations/20260427160000_secure_rpc_search_path.sql', 'utf8');
console.log(`Applying RPC security migration to ${PROJECT_REF}...`);

const startedAt = Date.now();
const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
console.log(`HTTP ${res.status} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
console.log(await res.text());
process.exit(res.ok ? 0 : 1);
