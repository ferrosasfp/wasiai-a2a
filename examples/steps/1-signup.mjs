// Paso 1 — Crear el Agent Key.  POST /auth/agent-signup (público)
// env: A2A_BASE, OWNER_REF (default wkh35-manual → lo barre el cleanup)
import { api, writeState, A2A_BASE } from './_state.mjs';

const owner_ref = process.env.OWNER_REF ?? 'wkh35-manual';
const { key, key_id } = await api('/auth/agent-signup', {
  body: { owner_ref, display_name: 'manual demo' },
});

writeState({ key, key_id, owner_ref });
console.log(`[1] Agent Key creado en ${A2A_BASE}`);
console.log(`    key_id   = ${key_id}`);
console.log(`    key      = ${key.slice(0, 14)}…  (guardada en /tmp/wasi-run/state.json, se muestra una vez)`);
console.log(`    owner_ref= ${owner_ref}`);
console.log(`→ siguiente: node examples/steps/2-deposit-info.mjs`);
