#!/usr/bin/env node
/**
 * HU-198 — aplica `20260728000000_hu198_settle_unknown_status.sql` a la base de
 * DESARROLLO (bdwv) vía Management API. Idempotente (CREATE OR REPLACE).
 *
 * ⚠️ SOLO BDWV. A CALDZ NO SE TOCA: es la base de dinero de PRODUCCIÓN y queda para
 * el pase a mainnet. Por eso este script:
 *   1. HARDCODEA el ref de bdwv y NO lo deriva de `SUPABASE_URL`. El footgun está
 *      documentado en `scripts/apply-prod-migrations.sh`: el `.env` local apunta a
 *      otra base que el gateway de prod. `scripts/apply-security-rpc-migration.mjs`
 *      SÍ lo deriva de `SUPABASE_URL` (su línea 29) — no copiar ese patrón.
 *   2. ABORTA si el ref resuelto es el de caldz, por si alguien edita el literal.
 *   3. Si va a leer una service key, VERIFICA el claim `ref` del JWT en vez de
 *      confiar en el nombre de la variable. Motivo REAL medido en este repo:
 *        · `.env`       → SUPABASE_SERVICE_KEY   = ref bdwv   (dev, inofensiva)
 *        · `.env.local` → SUPABASE_SERVICE_KEY   = ref CALDZ  (¡producción!)
 *        · `.env.local` → SUPABASE_SERVICE_KEY_D = ref bdwv   (dev)
 *      O sea que el nombre SIN sufijo apunta a la peligrosa en `.env.local`, y
 *      `.env.local` gana cuando se mergean los dos. El nombre no es evidencia.
 *      (Este script usa el PAT del Management API, no la service key, así que la
 *      verificación es una red de seguridad, no el camino principal.)
 *
 * VERIFICACIÓN DE POST-ESTADO (no se asume que el apply salió bien): se LLAMA a la
 * función con un intent inexistente y se lee QUÉ error devuelve. Es un sondeo que NO
 * muta nada, porque el guard de `p_status` corre ANTES del lookup del intent:
 *   · error `INVALID_SETTLE_STATUS` con p_status='resolving_settle' ⟹ vieja versión.
 *   · error `INTENT_NOT_FOUND`      con p_status='resolving_settle' ⟹ NUEVA versión
 *     (pasó el guard de status y llegó al lookup).
 *   · error `INVALID_SETTLE_STATUS` con p_status basura ⟹ el guard sigue cerrado.
 *
 * Uso:  node scripts/apply-hu198-migration.mjs [--verify-only]
 */
import { readFileSync } from 'node:fs';

const REPO = '/home/ferdev/.openclaw/workspace/wasiai-a2a';

// Refs hardcodeados a propósito (ver el bloque de arriba).
const BDWV_REF = 'bdwvrwzvsldephfibmuu'; // desarrollo — el ÚNICO destino permitido
const CALDZ_REF = 'caldzjhjgctpgodldqav'; // PRODUCCIÓN (dinero real) — PROHIBIDO

const TARGET_REF = BDWV_REF;

function readEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    /* archivo ausente */
  }
  return out;
}

/** Ref del claim de un JWT de Supabase, o null si no es un JWT. NUNCA loguea el token. */
function jwtRef(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
    );
    return typeof payload.ref === 'string' ? payload.ref : null;
  } catch {
    return null;
  }
}

// ── Guard 1: el destino es bdwv y NO es caldz ──────────────────────────────
if (TARGET_REF === CALDZ_REF) {
  console.error(
    '[ABORT] El destino resuelto es CALDZ (producción, dinero real). Este script solo aplica a bdwv.',
  );
  process.exit(3);
}
if (TARGET_REF !== BDWV_REF) {
  console.error(`[ABORT] Destino inesperado ${TARGET_REF}; se esperaba bdwv.`);
  process.exit(3);
}

const env = { ...readEnv(`${REPO}/.env`), ...readEnv(`${REPO}/.env.local`) };

// ── Guard 2: si hay service keys en el entorno, reportar a QUÉ base apuntan ──
// No se usan para aplicar, pero si alguna apunta a caldz hay que verlo explícito.
for (const name of [
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SERVICE_KEY_D',
  'SUPABASE_ANON_KEY',
]) {
  const val = env[name];
  if (!val) continue;
  const ref = jwtRef(val);
  const tag =
    ref === CALDZ_REF
      ? 'CALDZ (producción) ⚠️ NO se usa en este script'
      : ref === BDWV_REF
        ? 'bdwv (desarrollo)'
        : `desconocido (${ref ?? 'no-jwt'})`;
  console.log(`[env] ${name} → ${tag}`);
}

const PAT = env.SUPABASE_ACCESS_TOKEN;
if (!PAT) {
  console.error('[ABORT] Falta SUPABASE_ACCESS_TOKEN (PAT del Management API).');
  process.exit(3);
}

const API = `https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`;

async function query(sql) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

// ── Guard 3: confirmar contra la base que estamos donde creemos ────────────
const ident = await query(
  'SELECT current_database() AS db, current_user AS usr;',
);
console.log(`[target] ref=${TARGET_REF} (HARDCODEADO, no derivado de SUPABASE_URL)`);
console.log(`[target] HTTP ${ident.status} ${ident.text.slice(0, 200)}`);
if (!ident.ok) {
  console.error('[ABORT] No se pudo consultar la base destino.');
  process.exit(1);
}

const PROBE_UUID = '00000000-0000-0000-0000-000000000000';
const probe = (status) =>
  `SELECT record_debit_settle_status('${PROBE_UUID}'::uuid, 'hu198-probe-owner', '${PROBE_UUID}'::uuid, 0::numeric, '${status}');`;

/** Lee el estado REAL de la función por su comportamiento. No muta nada. */
async function readPostState(label) {
  const newValue = await query(probe('resolving_settle'));
  const bogus = await query(probe('definitely_not_a_status'));
  const accepts = newValue.text.includes('INTENT_NOT_FOUND');
  const rejectsNew = newValue.text.includes('INVALID_SETTLE_STATUS');
  const rejectsBogus = bogus.text.includes('INVALID_SETTLE_STATUS');
  console.log(`\n[post-state:${label}]`);
  console.log(
    `  p_status='resolving_settle'          → ${accepts ? 'PASA el guard (INTENT_NOT_FOUND) ⇒ migración APLICADA' : rejectsNew ? 'RECHAZADO (INVALID_SETTLE_STATUS) ⇒ migración NO aplicada' : `inesperado: ${newValue.text.slice(0, 200)}`}`,
  );
  console.log(
    `  p_status='definitely_not_a_status'   → ${rejectsBogus ? 'RECHAZADO (INVALID_SETTLE_STATUS) ⇒ el guard sigue cerrado' : `inesperado: ${bogus.text.slice(0, 200)}`}`,
  );
  return { accepts, rejectsBogus };
}

const verifyOnly = process.argv.includes('--verify-only');

if (!verifyOnly) {
  const before = await readPostState('ANTES');
  if (before.accepts) {
    console.log(
      '\n[info] La función YA acepta resolving_settle (re-run idempotente).',
    );
  }

  const sqlPath = `${REPO}/supabase/migrations/20260728000000_hu198_settle_unknown_status.sql`;
  const sql = readFileSync(sqlPath, 'utf8');
  console.log(`\n[apply] ${sqlPath.split('/').pop()} → ${TARGET_REF}`);
  const started = Date.now();
  const res = await query(sql);
  console.log(
    `[apply] HTTP ${res.status} (${((Date.now() - started) / 1000).toFixed(1)}s) ${res.text.slice(0, 300)}`,
  );
  if (!res.ok) {
    console.error('[FAIL] El apply falló. NO se asume nada: ver el error arriba.');
    process.exit(1);
  }
}

const after = await readPostState('DESPUÉS');
if (!after.accepts) {
  console.error(
    '\n[FAIL] post-estado: la función NO acepta resolving_settle. La migración no quedó aplicada.',
  );
  process.exit(1);
}
if (!after.rejectsBogus) {
  console.error(
    '\n[FAIL] post-estado: la función acepta un status basura. El guard quedó abierto.',
  );
  process.exit(1);
}
console.log('\n[OK] Post-estado verificado LEYENDO DE LA BASE: acepta resolving_settle y sigue rechazando lo demás.');
