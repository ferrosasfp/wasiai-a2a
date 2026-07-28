#!/usr/bin/env node
/**
 * HU-198 — aplica LAS DOS migraciones de la HU, EN ORDEN, a la base de DESARROLLO
 * (bdwv) vía Management API:
 *   1. 20260728000000_hu198_settle_unknown_status.sql   (`resolving_settle` escribible)
 *   2. 20260728010000_hu198_settle_status_applied.sql   (`applied` + MNR-4 + MNR-3)
 *   3. 20260728020000_hu198_settle_status_current.sql   (`current_status`, AR#2 BLQ-BAJO-1)
 * Idempotente (CREATE OR REPLACE; la 2ª hace DROP+CREATE dentro de su transacción).
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
 * VERIFICACIÓN DE POST-ESTADO (no se asume que el apply salió bien) — 4 chequeos, todos
 * LEYENDO DE LA BASE y sin mutar nada:
 *   (a) se LLAMA a la función con un intent inexistente y se lee QUÉ error devuelve. El
 *       guard de `p_status` corre ANTES del lookup del intent, así que:
 *         · `INVALID_SETTLE_STATUS` con p_status='resolving_settle' ⟹ vieja versión.
 *         · `INTENT_NOT_FOUND`      con p_status='resolving_settle' ⟹ NUEVA versión.
 *         · `INVALID_SETTLE_STATUS` con p_status basura ⟹ el guard sigue cerrado.
 *   (b) `pg_get_function_result` de `record_debit_settle_status` ⟹ confirma el
 *       `RETURNS TABLE(applied boolean)` de la 2ª migración. La sonda (a) no lo puede
 *       ver, porque con un intent inexistente la función siempre RAISEa antes de
 *       devolver.
 *   (c) `pg_get_functiondef` de `claim_reconciliation` ⟹ confirma la rama refund de
 *       MNR-4 en la función DEPLOYADA (no en el .sql del repo).
 *
 * Uso:  node scripts/apply-hu198-migration.mjs [--verify-only]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// AR MNR-6: la raíz del repo se DERIVA de la ubicación del script. Antes era un path
// absoluto de la máquina del autor commiteado, que rompe para cualquier otro checkout
// (y filtra el layout local).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * Lee el estado REAL de las dos migraciones. Tres sondas, ninguna muta nada:
 *   (a) COMPORTAMIENTO de `p_status` (el guard corre ANTES del lookup del intent).
 *   (b) TIPO DE RETORNO de `record_debit_settle_status` leído del catálogo — así se
 *       verifica el `RETURNS TABLE(applied boolean)` de la 2ª migración, que la sonda
 *       de comportamiento no puede ver (con un intent inexistente siempre RAISEa).
 *   (c) el cuerpo DEPLOYADO de `claim_reconciliation` (`pg_get_functiondef`) para la
 *       rama refund de MNR-4. Se chequea la función que está EN LA BASE, no el .sql.
 */
async function readPostState(label) {
  const newValue = await query(probe('resolving_settle'));
  const bogus = await query(probe('definitely_not_a_status'));
  const retType = await query(
    "SELECT pg_get_function_result(oid) AS r FROM pg_proc WHERE proname = 'record_debit_settle_status';",
  );
  const claimDef = await query(
    "SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'claim_reconciliation';",
  );

  const accepts = newValue.text.includes('INTENT_NOT_FOUND');
  const rejectsNew = newValue.text.includes('INVALID_SETTLE_STATUS');
  const rejectsBogus = bogus.text.includes('INVALID_SETTLE_STATUS');
  // La #2 dejó `TABLE(applied boolean)`; la #3 le suma `current_status`.
  const returnsApplied = /TABLE\(applied boolean/i.test(retType.text);
  const returnsCurrentStatus = /current_status text/i.test(retType.text);
  // La rama de MNR-4, tal cual quedó en la función deployada.
  const refundCanClaimResolvingSettle =
    /p_side\s*=\s*'refund'\s+AND\s+debit_settle_status\s*=\s*'resolving_settle'/i.test(
      claimDef.text,
    );

  console.log(`\n[post-state:${label}]`);
  console.log(
    `  (a) p_status='resolving_settle'        → ${accepts ? 'PASA el guard (INTENT_NOT_FOUND) ⇒ 20260728000000 APLICADA' : rejectsNew ? 'RECHAZADO (INVALID_SETTLE_STATUS) ⇒ NO aplicada' : `inesperado: ${newValue.text.slice(0, 200)}`}`,
  );
  console.log(
    `  (a) p_status='definitely_not_a_status' → ${rejectsBogus ? 'RECHAZADO ⇒ el guard sigue cerrado' : `inesperado: ${bogus.text.slice(0, 200)}`}`,
  );
  console.log(
    `  (b) record_debit_settle_status returns → ${retType.text.slice(0, 140)}`,
  );
  console.log(
    `      applied ⇒ ${returnsApplied ? '20260728010000 APLICADA' : 'NO aplicada'} · current_status ⇒ ${returnsCurrentStatus ? '20260728020000 APLICADA' : 'NO aplicada'}`,
  );
  console.log(
    `  (c) claim_reconciliation refund/resolving_settle → ${refundCanClaimResolvingSettle ? 'PRESENTE en la función deployada ⇒ MNR-4 cerrado' : 'AUSENTE ⇒ el refund del buyer sigue inalcanzable'}`,
  );
  return {
    accepts,
    rejectsBogus,
    returnsApplied,
    returnsCurrentStatus,
    refundCanClaimResolvingSettle,
  };
}

// Las dos migraciones de HU-198, EN ORDEN (la 2ª asume el guard de la 1ª).
/**
 * Las tres migraciones de HU-198, EN ORDEN, con la condición que decide si HAY QUE
 * aplicarlas.
 *
 * ⚠️ POR QUÉ HAY CONDICIONES Y NO SE RE-APLICA TODO (descubierto ejecutando): la #1 usa
 * `CREATE OR REPLACE ... RETURNS void`, así que sobre una base que YA tiene la #2 falla
 * con `42P13: cannot change return type of existing function`. O sea que la #1 NO es
 * re-ejecutable después de la #2.
 *
 * Eso es el lado SEGURO —falla ruidosa en vez de degradar la función en silencio— pero
 * significa que un applier que re-corre todo a ciegas se rompe en la 2ª pasada. Un
 * runner de migraciones real lleva registro de lo aplicado; acá el "registro" se deriva
 * del ESTADO REAL de la base (las mismas sondas del post-estado), que es más honesto que
 * una tabla de control que puede desincronizarse.
 */
const MIGRATIONS = [
  {
    file: '20260728000000_hu198_settle_unknown_status.sql',
    // Sólo si falta el `IN` ampliado Y la función todavía es `void` (si ya la
    // reescribió la #2/#3, este archivo no puede correr: ver el ⚠️ de arriba).
    needed: (st) => !st.accepts && !st.returnsApplied,
  },
  {
    file: '20260728010000_hu198_settle_status_applied.sql',
    needed: (st) => !st.returnsApplied || !st.refundCanClaimResolvingSettle,
  },
  {
    file: '20260728020000_hu198_settle_status_current.sql',
    needed: (st) => !st.returnsCurrentStatus,
  },
];

const verifyOnly = process.argv.includes('--verify-only');

if (!verifyOnly) {
  const before = await readPostState('ANTES');
  for (const { file, needed } of MIGRATIONS) {
    if (!needed(before)) {
      console.log(`\n[skip]  ${file} → su efecto YA está en la base`);
      continue;
    }
    const sql = readFileSync(resolve(REPO, 'supabase', 'migrations', file), 'utf8');
    console.log(`\n[apply] ${file} → ${TARGET_REF}`);
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
}

const after = await readPostState('DESPUÉS');
const checks = [
  [after.accepts, 'la función NO acepta resolving_settle (20260728000000)'],
  [after.rejectsBogus, 'la función acepta un status basura (guard abierto)'],
  [
    after.returnsApplied,
    'record_debit_settle_status NO devuelve applied (20260728010000)',
  ],
  [
    after.returnsCurrentStatus,
    'record_debit_settle_status NO devuelve current_status (20260728020000)',
  ],
  [
    after.refundCanClaimResolvingSettle,
    'claim_reconciliation NO deja al refund reclamar resolving_settle (MNR-4)',
  ],
];
const failed = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
if (failed.length > 0) {
  console.error('\n[FAIL] post-estado:');
  for (const f of failed) console.error(`  · ${f}`);
  process.exit(1);
}
console.log('\n[OK] Post-estado verificado LEYENDO DE LA BASE: los 5 chequeos pasan.');
