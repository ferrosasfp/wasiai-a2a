#!/usr/bin/env node
/**
 * Smoke E2E — prueba en vivo del control-plane de E16 (Agent Key robustness).
 * Verificable y repetible. Dos modos:
 *
 *   MONEY-FREE (default): crea una key vía /agent-signup y prueba lo que NO
 *     necesita budget — políticas de gasto, recibos, el scope-guard del cap,
 *     y el rechazo de tokens inválidos. NO mueve plata.
 *
 *   FULL (E16_MASTER_KEY=wasi_a2a_... con budget): corre el ciclo completo de
 *     sesión — crear → listar → activar firma → revocar → token revocado rechazado.
 *     (Una sesión no puede tener cap mayor que el budget del padre, por diseño,
 *     así que el ciclo completo necesita una key con saldo testnet.)
 *
 * Uso:
 *   node scripts/smoke-e16-agent-key.mjs [BASE_URL]
 *   E16_MASTER_KEY=wasi_a2a_xxx node scripts/smoke-e16-agent-key.mjs
 *
 * Cubre: WKH-121 · WKH-122 · WKH-123 · WKH-124 · WKH-125
 */
const BASE = process.argv[2] || 'https://wasiai-a2a-production.up.railway.app';
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  cond ? pass++ : fail++;
};
const req = async (method, path, { key, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-a2a-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
};

const main = async () => {
  console.log(`\n🔬 Smoke E16 (Agent Key) contra ${BASE}\n`);
  let master = process.env.E16_MASTER_KEY;
  const funded = !!master;

  if (!funded) {
    const owner = `e16-smoke-${Date.now()}`;
    const signup = await req('POST', '/auth/agent-signup', { body: { owner_ref: owner, display_name: 'E16 smoke' } });
    master = signup.json?.key;
    ok('Base · crear master key (POST /auth/agent-signup)', signup.status === 201 && !!master, `id=${signup.json?.key_id}`);
    if (!master) { console.log('\n  ⛔ sin master key, abortando.\n'); process.exit(1); }
    console.log('  (modo MONEY-FREE: key sin budget; el ciclo de sesión se prueba como guard)\n');
  } else {
    console.log('  (modo FULL: usando E16_MASTER_KEY fondeada)\n');
  }

  // WKH-125 — política de gasto por destino (no necesita budget)
  const pol = await req('PUT', '/auth/keys/me/spend-policies', { key: master, body: { destination: 'wasiai/test-agent', max_usd: '5.00', window_type: 'rolling', window_secs: 86400 } });
  ok('WKH-125 · cap por destino (PUT /auth/keys/me/spend-policies)', pol.status === 200 || pol.status === 201, 'dest=wasiai/test-agent cap=$5/24h');
  const polList = await req('GET', '/auth/keys/me/spend-policies', { key: master });
  const polArr = Array.isArray(polList.json) ? polList.json : polList.json?.spend_policies;
  ok('WKH-125 · listar políticas (GET)', polList.status === 200 && Array.isArray(polArr) && polArr.length >= 1, `n=${Array.isArray(polArr) ? polArr.length : '?'}`);

  // WKH-124 — endpoint de recibos (ownership-scoped)
  const rc = await req('GET', '/receipts', { key: master });
  ok('WKH-124 · endpoint de recibos (GET /receipts)', rc.status === 200 && Array.isArray(rc.json?.receipts), `n=${rc.json?.receipts?.length ?? '?'}`);

  // WKH-122 — un token inválido es rechazado por el middleware
  const bad = await req('GET', '/receipts', { key: 'wasi_a2a_sess_invalid_token_xyz' });
  ok('WKH-122/auth · token de sesión inválido rechazado', bad.status === 401 || bad.status === 403, `HTTP ${bad.status}`);

  // Ciclo de sesión (WKH-121/122/123)
  const sess = await req('POST', '/auth/key-session', { key: master, body: { ttl_seconds: 3600, max_budget_usd: '0.50' } });
  if (sess.status === 201 && sess.json?.session_token) {
    const sid = sess.json.session_id, stok = sess.json.session_token;
    ok('WKH-121 · session key efímera (POST /auth/key-session)', stok.startsWith('wasi_a2a_sess_'), `id=${sid} ttl=3600 cap=$0.50`);
    const l1 = await req('GET', '/auth/key-session', { key: master });
    ok('WKH-121 · listar (status=active)', (l1.json || []).some((s) => s.session_id === sid && s.status === 'active'));
    const sig = await req('PATCH', `/auth/key-session/${sid}/require-signature`, { key: master, body: { require_signature: true } });
    ok('WKH-123 · activar auth por firma', sig.status === 200);
    const rev = await req('DELETE', `/auth/key-session/${sid}`, { key: master });
    ok('WKH-122 · revocar sesión (DELETE)', rev.status === 200 && rev.json?.revoked === true);
    const l2 = await req('GET', '/auth/key-session', { key: master });
    ok('WKH-122 · figura como revocada', (l2.json || []).some((s) => s.session_id === sid && s.status === 'revoked'));
    const used = await req('GET', '/receipts', { key: stok });
    ok('WKH-122 · token revocado rechazado (efecto inmediato)', used.status === 401 || used.status === 403, `HTTP ${used.status}`);
  } else {
    // money-free: la sesión no puede exceder el budget del padre → el guard responde
    ok('WKH-121/125 · scope-guard del cap (sesión > budget del padre → rechazo)', sess.json?.error_code === 'SCOPE_EXCEEDS_PARENT', `${sess.json?.error_code} (esperado sin budget)`);
    console.log('  ℹ️  El ciclo completo de sesión (crear→revocar→firma) necesita una key con budget testnet.');
    console.log('     Corré con E16_MASTER_KEY=<key fondeada> para el flujo end-to-end.');
  }

  console.log(`\n  Resultado: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail === 0 ? 0 : 1);
};
main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
