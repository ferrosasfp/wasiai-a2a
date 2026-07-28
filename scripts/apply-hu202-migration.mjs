#!/usr/bin/env node
/**
 * HU-202 — aplica la migración del LEASE DEL HOP 2 a la base de DESARROLLO (bdwv) vía
 * Management API:
 *   20260729000000_hu202_hop2_lease.sql
 *     (1) columna `debit_hop2_attempted_at`
 *     (2) `record_debit_settle_status` estampa / limpia el lease
 *     (3) `claim_reconciliation` no reclama por el lado settle una fila estampada sin
 *         `debit_resolution_tx_hash` (y estampa al reclamar)
 * Idempotente: `ADD COLUMN IF NOT EXISTS` + `CREATE OR REPLACE` (sin DROP, así que
 * re-correrla no puede fallar con `42P13 cannot change return type` como pasó en HU-198).
 *
 * ⚠️ SOLO BDWV. A CALDZ NO SE TOCA: es la base de dinero de PRODUCCIÓN y queda para el
 * pase a mainnet. Por eso este script:
 *   1. HARDCODEA el ref de bdwv y NO lo deriva de `SUPABASE_URL`. El footgun está
 *      documentado en `scripts/apply-prod-migrations.sh`: el `.env` local apunta a otra
 *      base que el gateway de prod.
 *   2. ABORTA si el ref resuelto es el de caldz, por si alguien edita el literal.
 *   3. Si hay service keys en el entorno, las identifica por el claim `ref` del JWT, NUNCA
 *      por el nombre de la variable. Motivo REAL medido en este repo:
 *        · `.env`       → SUPABASE_SERVICE_KEY   = ref bdwv   (dev, inofensiva)
 *        · `.env.local` → SUPABASE_SERVICE_KEY   = ref CALDZ  (¡producción!)
 *        · `.env.local` → SUPABASE_SERVICE_KEY_D = ref bdwv   (dev)
 *      O sea que el nombre SIN sufijo apunta a la peligrosa en `.env.local`, y `.env.local`
 *      GANA cuando se mergean los dos. El nombre no es evidencia.
 *
 * ⚠️ ORDEN DE RELEASE: esta migración va ANTES de deployar el código de HU-202. El orden
 * correcto no tiene ventana (sin código nadie estampa ⟹ la rama nueva del claim no excluye
 * ninguna fila ⟹ comportamiento de dinero idéntico). Ver el header del .sql.
 *
 * VERIFICACIÓN DE POST-ESTADO (no se asume que el apply salió bien) — 4 chequeos, todos
 * LEYENDO DE LA BASE y sin mutar nada:
 *   (a) `information_schema.columns` ⟹ la columna existe y es `timestamp with time zone`.
 *   (b) `pg_get_functiondef(record_debit_settle_status)` ⟹ el stamp Y su limpieza están en
 *       la función DEPLOYADA (no en el .sql del repo). Las dos por separado: sin la
 *       limpieza, el caso (D) deja al seller sin cobrar.
 *   (c) `pg_get_functiondef(claim_reconciliation)` ⟹ el guard del lease del lado settle.
 *   (d) el mismo `functiondef` ⟹ la rama refund de MNR-4 (HU-198) SOBREVIVIÓ a la
 *       reescritura. Es la no-regresión que más caro sale perder en silencio.
 *
 * Uso:  node scripts/apply-hu202-migration.mjs [--verify-only]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// La raíz del repo se DERIVA de la ubicación del script (nunca un path absoluto de la
// máquina del autor: rompe para cualquier otro checkout y filtra el layout local).
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Refs hardcodeados a propósito (ver el bloque de arriba).
const BDWV_REF = 'bdwvrwzvsldephfibmuu'; // desarrollo — el ÚNICO destino permitido
const CALDZ_REF = 'caldzjhjgctpgodldqav'; // PRODUCCIÓN (dinero real) — PROHIBIDO

const TARGET_REF = BDWV_REF;

const MIGRATION = '20260729000000_hu202_hop2_lease.sql';

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
console.log(
  `[target] ref=${TARGET_REF} (HARDCODEADO, no derivado de SUPABASE_URL)`,
);
console.log(`[target] HTTP ${ident.status} ${ident.text.slice(0, 200)}`);
if (!ident.ok) {
  console.error('[ABORT] No se pudo consultar la base destino.');
  process.exit(1);
}

/**
 * Lee el estado REAL de la migración. Ninguna sonda muta nada: se leen el catálogo de
 * columnas y los cuerpos DEPLOYADOS de las dos funciones (no el .sql del repo).
 */
async function readPostState(label) {
  const col = await query(
    "SELECT data_type FROM information_schema.columns WHERE table_name = 'a2a_payment_intent_debit_signatures' AND column_name = 'debit_hop2_attempted_at';",
  );
  const recDef = await query(
    "SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'record_debit_settle_status';",
  );
  const claimDef = await query(
    "SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'claim_reconciliation';",
  );

  const hasColumn = /timestamp with time zone/i.test(col.text);
  const stamps =
    /p_status\s*=\s*'resolving_settle'\s+THEN\s+now\(\)/i.test(recDef.text);
  const clears =
    /p_status\s*=\s*'reconciliation_pending'\s+THEN\s+NULL/i.test(recDef.text);
  const settleGuard =
    /debit_hop2_attempted_at\s+IS\s+NULL/i.test(claimDef.text) &&
    /debit_resolution_tx_hash\s+IS\s+NOT\s+NULL/i.test(claimDef.text);
  const refundCanClaimResolvingSettle =
    /p_side\s*=\s*'refund'\s+AND\s+debit_settle_status\s*=\s*'resolving_settle'/i.test(
      claimDef.text,
    );

  console.log(`\n[post-state:${label}]`);
  console.log(
    `  (a) columna debit_hop2_attempted_at   → ${hasColumn ? 'EXISTE (timestamptz)' : `AUSENTE (${col.text.slice(0, 160)})`}`,
  );
  console.log(
    `  (b) record_debit_settle_status stamp  → ${stamps ? 'PRESENTE (toma el lease)' : 'AUSENTE ⇒ no hay hecho persistido'}`,
  );
  console.log(
    `  (b) record_debit_settle_status clear  → ${clears ? 'PRESENTE (libera el lease)' : 'AUSENTE ⇒ el caso D deja al seller sin cobrar'}`,
  );
  console.log(
    `  (c) claim_reconciliation lease guard  → ${settleGuard ? 'PRESENTE ⇒ el lado settle no re-envía a ciegas' : 'AUSENTE ⇒ el re-envío ciego sigue abierto'}`,
  );
  console.log(
    `  (d) claim_reconciliation refund/MNR-4 → ${refundCanClaimResolvingSettle ? 'PRESENTE ⇒ el refund del buyer sigue alcanzable' : 'AUSENTE ⇒ REGRESIÓN de HU-198'}`,
  );
  return { hasColumn, stamps, clears, settleGuard, refundCanClaimResolvingSettle };
}

const verifyOnly = process.argv.includes('--verify-only');

if (!verifyOnly) {
  await readPostState('ANTES');
  const sql = readFileSync(
    resolve(REPO, 'supabase', 'migrations', MIGRATION),
    'utf8',
  );
  console.log(`\n[apply] ${MIGRATION} → ${TARGET_REF}`);
  const started = Date.now();
  const res = await query(sql);
  console.log(
    `[apply] HTTP ${res.status} (${((Date.now() - started) / 1000).toFixed(1)}s) ${res.text.slice(0, 300)}`,
  );
  if (!res.ok) {
    console.error(
      '[FAIL] El apply falló. NO se asume nada: ver el error arriba.',
    );
    process.exit(1);
  }
}

const after = await readPostState('DESPUÉS');
const checks = [
  [after.hasColumn, 'falta la columna debit_hop2_attempted_at'],
  [after.stamps, 'record_debit_settle_status NO estampa el intento de hop 2'],
  [after.clears, 'record_debit_settle_status NO limpia el stamp (el caso D queda sin re-envío automático)'],
  [after.settleGuard, 'claim_reconciliation NO tiene el guard del lease (re-envío ciego abierto)'],
  [
    after.refundCanClaimResolvingSettle,
    'claim_reconciliation perdió la rama refund de MNR-4 (regresión de HU-198)',
  ],
];
const failed = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
if (failed.length > 0) {
  console.error('\n[FAIL] post-estado:');
  for (const f of failed) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(
  '\n[OK] Post-estado verificado LEYENDO DE LA BASE: los 5 chequeos pasan.',
);
