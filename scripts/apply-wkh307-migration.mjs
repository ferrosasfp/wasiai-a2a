#!/usr/bin/env node
/**
 * WKH-307 — aplica la migración del LEDGER DURABLE DEL SETTLE SOLANA a la base de
 * DESARROLLO (bdwv) vía Management API:
 *   20260730000000_wkh307_solana_settle_intents.sql
 *     (1) tabla `a2a_solana_settle_intents` (máquina claimed → signed → confirmed)
 *     (2) índice **UNIQUE PARCIAL** sobre `settle_signature`
 *     (3) las 4 funciones de transición (escritura condicional atómica, reloj de Postgres)
 * Idempotente: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` +
 * `CREATE OR REPLACE FUNCTION` (sin DROP, así que re-correrla no puede fallar con
 * `42P13 cannot change return type` como pasó en HU-198).
 *
 * ⚠️ SOLO BDWV. A CALDZ NO SE TOCA: es la base de dinero de PRODUCCIÓN y queda para
 * WKH-307b (founder-gated). Por eso este script:
 *   1. HARDCODEA el ref de bdwv y NO lo deriva de `SUPABASE_URL`. El footgun está
 *      documentado en `scripts/apply-prod-migrations.sh`: el `.env` local apunta a otra
 *      base que el gateway de prod.
 *   2. ABORTA si el ref resuelto es el de caldz, por si alguien edita el literal.
 *   3. Si hay service keys en el entorno, las identifica por el claim `ref` del JWT,
 *      NUNCA por el nombre de la variable. Motivo REAL medido en este repo:
 *        · `.env`       → SUPABASE_SERVICE_KEY   = ref bdwv   (dev, inofensiva)
 *        · `.env.local` → SUPABASE_SERVICE_KEY   = ref CALDZ  (¡producción!)
 *        · `.env.local` → SUPABASE_SERVICE_KEY_D = ref bdwv   (dev)
 *      O sea que el nombre SIN sufijo apunta a la peligrosa en `.env.local`, y
 *      `.env.local` GANA al mergear. El nombre no es evidencia.
 *
 * ⚠️ ORDEN DE RELEASE: esta migración va ANTES de deployar el código de WKH-307. El
 * orden correcto no tiene ventana (la tabla nace vacía y nadie la lee todavía). El
 * orden inverso deja el leg Solana fail-closed hasta aplicarla: degradación ruidosa y
 * recuperable, NO un doble pago.
 *
 * VERIFICACIÓN DE POST-ESTADO (no se asume que el apply salió bien) — todos los
 * chequeos LEEN DE LA BASE (catálogo + cuerpos DEPLOYADOS de las funciones, no el .sql
 * del repo) y ninguno muta nada:
 *   (a) `information_schema.columns` ⟹ la tabla existe y `amount_atomic` es TEXT
 *       (NUNCA numeric: convención WKH-196, la precisión de uint256/uint64).
 *   (b) `pg_indexes` ⟹ el índice de `settle_signature` existe **y es UNIQUE y PARCIAL**.
 *       Es la reposición de la protección que se pierde al dejar
 *       `sendAndConfirmTransaction`: sin UNIQUE, la HU deja el sistema PEOR.
 *   (c) `pg_get_functiondef` de las 4 ⟹ existen y están deployadas.
 *   (d) el functiondef del reclamo ⟹ el predicado del LEASE usa `now()` de POSTGRES
 *       (no un umbral del cliente) y los 3 términos del intent están en el WHERE.
 *   (e) el functiondef del reclamo ⟹ el `RAISE WKH307_PROBE_OK` del preflight está.
 *
 * Uso:  node scripts/apply-wkh307-migration.mjs [--verify-only]
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

const MIGRATION = '20260730000000_wkh307_solana_settle_intents.sql';
const TABLE = 'a2a_solana_settle_intents';
const FUNCTIONS = [
  'claim_solana_settle_intent',
  'record_solana_settle_signed',
  'record_solana_settle_confirmed',
  'reclaim_solana_settle_intent',
];

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
 * Lee el estado REAL de la migración. Ninguna sonda muta nada: catálogo de columnas,
 * `pg_indexes` y los cuerpos DEPLOYADOS de las funciones.
 */
async function readPostState(label) {
  const cols = await query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${TABLE}';`,
  );
  const idx = await query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '${TABLE}';`,
  );
  const defs = await query(
    `SELECT proname, pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname IN (${FUNCTIONS.map((f) => `'${f}'`).join(', ')});`,
  );

  const hasTable = /"?intent_id"?/i.test(cols.text) && cols.text.includes('caip2');
  // WKH-196: si `amount_atomic` saliera NUMERIC, PostgREST lo devolvería como número
  // JSON y JSON.parse redondearía por encima de 2^53.
  const amountIsText = /amount_atomic[^}]*?"data_type"\s*:\s*"text"/i.test(
    cols.text.replace(/\s+/g, ' '),
  );
  // (b) EL UNIQUE ES OBLIGATORIO. Sin él, dos legs al mismo agente por el mismo monto
  // bajo el mismo blockhash producen la MISMA firma ⟹ una sola transferencia
  // contabilizada como dos pagos.
  const sigIndexUnique =
    /CREATE UNIQUE INDEX[^"]*ux_a2a_solana_settle_intents_signature/i.test(idx.text);
  const sigIndexPartial =
    /ux_a2a_solana_settle_intents_signature[\s\S]*?WHERE\s+\(?settle_signature\s+IS\s+NOT\s+NULL/i.test(
      idx.text,
    );
  const allFunctions = FUNCTIONS.every((f) => defs.text.includes(f));
  // (d) el lease con el reloj del SERVIDOR: un umbral calculado en el cliente permite
  // que dos instancias con skew se roben un lease vivo ⟹ dos broadcasts.
  const leaseUsesServerClock =
    /claimed_at\s*<\s*now\(\)\s*-\s*make_interval/i.test(defs.text);
  const guardsTerms =
    /pay_to\s*=\s*excluded\.pay_to/i.test(defs.text) &&
    /amount_atomic\s*=\s*excluded\.amount_atomic/i.test(defs.text) &&
    /mint\s*=\s*excluded\.mint/i.test(defs.text);
  const hasProbe = /WKH307_PROBE_OK/i.test(defs.text);

  console.log(`\n[post-state:${label}]`);
  console.log(
    `  (a) tabla ${TABLE}         → ${hasTable ? 'EXISTE' : `AUSENTE (${cols.text.slice(0, 160)})`}`,
  );
  console.log(
    `  (a) amount_atomic es TEXT                    → ${amountIsText ? 'SÍ (WKH-196 ok)' : 'NO ⇒ riesgo de precisión uint64'}`,
  );
  console.log(
    `  (b) índice de settle_signature es UNIQUE     → ${sigIndexUnique ? 'SÍ' : 'NO ⇒ AC-9 ausente: el sistema queda PEOR que antes'}`,
  );
  console.log(
    `  (b) …y PARCIAL (WHERE settle_signature NOT NULL) → ${sigIndexPartial ? 'SÍ' : 'NO ⇒ las filas claimed (firma NULL) chocarían entre sí'}`,
  );
  console.log(
    `  (c) las 4 funciones deployadas               → ${allFunctions ? 'SÍ' : `NO (${defs.text.slice(0, 160)})`}`,
  );
  console.log(
    `  (d) el lease usa now() de POSTGRES           → ${leaseUsesServerClock ? 'SÍ' : 'NO ⇒ reloj del cliente: skew ⇒ lease robado ⇒ 2 broadcasts'}`,
  );
  console.log(
    `  (d) el reclamo exige los 3 términos          → ${guardsTerms ? 'SÍ' : 'NO ⇒ AC-8 ausente'}`,
  );
  console.log(
    `  (e) RAISE WKH307_PROBE_OK (preflight)        → ${hasProbe ? 'SÍ' : 'NO ⇒ el preflight no puede probar el esquema'}`,
  );
  return {
    hasTable,
    amountIsText,
    sigIndexUnique,
    sigIndexPartial,
    allFunctions,
    leaseUsesServerClock,
    guardsTerms,
    hasProbe,
  };
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
  [after.hasTable, `falta la tabla ${TABLE}`],
  [after.amountIsText, 'amount_atomic NO es TEXT (riesgo de precisión, WKH-196)'],
  [
    after.sigIndexUnique,
    'el índice de settle_signature NO es UNIQUE ⇒ AC-9 ausente: dos legs idénticos bajo el mismo blockhash pagarían una sola vez y contarían dos',
  ],
  [
    after.sigIndexPartial,
    'el índice de settle_signature NO es PARCIAL ⇒ las filas claimed (firma NULL) chocarían entre sí',
  ],
  [after.allFunctions, 'faltan funciones de transición deployadas'],
  [
    after.leaseUsesServerClock,
    'el lease NO usa now() de Postgres ⇒ con skew entre instancias se roba un lease vivo (2 broadcasts)',
  ],
  [after.guardsTerms, 'el reclamo NO exige los 3 términos del intent ⇒ AC-8 ausente'],
  [after.hasProbe, 'falta el RAISE WKH307_PROBE_OK ⇒ el preflight no puede probar nada'],
];
const failed = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
if (failed.length > 0) {
  console.error('\n[FAIL] post-estado:');
  for (const f of failed) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(
  `\n[OK] Post-estado verificado LEYENDO DE LA BASE: los ${checks.length} chequeos pasan.`,
);
