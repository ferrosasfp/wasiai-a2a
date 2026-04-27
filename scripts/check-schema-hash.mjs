import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

function readEnv(p) {
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
// Load all wasiai-a2a env files in priority order
const envFiles = [
  '/home/ferdev/.openclaw/workspace/wasiai-a2a/.env',
  '/home/ferdev/.openclaw/workspace/wasiai-a2a/.env.local',
];
const env = {};
for (const f of envFiles) {
  try { Object.assign(env, readEnv(f)); } catch { /* file may not exist */ }
}
const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY;
if (!env.SUPABASE_URL || !key) {
  console.error('Missing SUPABASE_URL or service key in wasiai-a2a/.env*');
  console.error('Found keys:', Object.keys(env).filter(k => k.includes('SUPABASE')).join(','));
  process.exit(3);
}
const supabase = createClient(env.SUPABASE_URL, key);

const { data, error } = await supabase
  .from('kite_schema_transforms')
  .select('source_agent_id,target_agent_id,schema_hash')
  .limit(1);

if (error) {
  console.log('ERROR:', JSON.stringify(error, null, 2));
  if (error.message?.includes('schema_hash') || error.code === '42703') {
    console.log('\n>>> schema_hash column does NOT exist yet — migration NOT applied');
    process.exit(2);
  }
  process.exit(1);
}
console.log('OK: schema_hash column exists. Sample:', JSON.stringify(data));
console.log('\n>>> Migration is APPLIED');
