#!/usr/bin/env node
/**
 * Aplica la migration kite_schema_transforms_schema_hash a Supabase dev (bdwvrwzvsldephfibmuu)
 * usando el SUPABASE_ACCESS_TOKEN (PAT) via Management API.
 *
 * La migration es idempotente (IF NOT EXISTS) y aditiva — safe to re-run.
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
if (!PAT) {
  console.error('Missing SUPABASE_ACCESS_TOKEN in wasiai-a2a/.env*');
  process.exit(3);
}

// Extract project ref from URL
const url = env.SUPABASE_URL ?? '';
const refMatch = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
if (!refMatch) {
  console.error('Could not extract project ref from SUPABASE_URL:', url);
  process.exit(3);
}
const PROJECT_REF = refMatch[1];

const migrationPath = '/home/ferdev/.openclaw/workspace/wasiai-a2a/supabase/migrations/20260426120000_kite_schema_transforms_schema_hash.sql';
const sql = readFileSync(migrationPath, 'utf8');

console.log('=== Apply migration ===');
console.log(`  Project ref: ${PROJECT_REF}`);
console.log(`  Migration:   ${migrationPath.split('/').pop()}`);
console.log(`  Size:        ${sql.length} chars\n`);

const apiUrl = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const startedAt = Date.now();
const res = await fetch(apiUrl, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${PAT}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const text = await res.text();
console.log(`HTTP ${res.status} (${elapsed}s)`);
console.log('Response:', text.slice(0, 1000));

if (!res.ok) process.exit(1);
console.log('\n✓ Migration applied. Verifying column exists...');
