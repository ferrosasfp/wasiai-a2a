#!/usr/bin/env node
/**
 * WKH-318 corte B (HU 218) — aplica a la base de DESARROLLO (bdwv) la migración que
 * declara el techo de `limit` del registro `wasiai`:
 *   20260804000000_wkh318b_registry_max_limit.sql
 *
 * Con la clave puesta, `queryRegistry` manda `min(over-fetch, maxLimit)` en vez del
 * over-fetch pelado. Sin ella, el clamp existe y NO se activa: el límite que sale por
 * la red queda byte-idéntico (verificado por el AR con un diferencial de 126
 * combinaciones, y por sonda contra producción después del merge).
 *
 * ⚠️ AUTORIZACIÓN. El `.sql` lleva en la línea 2 el marcador
 * `-- NO aplicar: la aplica el founder (accion gated, classifier)`. El founder autorizó
 * explícitamente la aplicación el 2026-08-04 ("tu tienes accesos para migrar bd"). El
 * marcador se deja intacto en el `.sql` porque describe la convención del repo, no este
 * permiso puntual.
 *
 * ⚠️ SOLO BDWV. A CALDZ NO SE TOCA: es la base de dinero de producción/archivo. Este
 * script copia las tres guardas de `apply-wkh307-migration.mjs`:
 *   1. HARDCODEA el ref de bdwv y NO lo deriva de `SUPABASE_URL`.
 *   2. ABORTA si el ref resuelto es el de caldz.
 *   3. Identifica las service keys por el claim `ref` del JWT, NUNCA por el nombre de la
 *      variable. El footgun está medido en este repo: en `.env.local` el nombre SIN
 *      sufijo (`SUPABASE_SERVICE_KEY`) apunta a CALDZ, y `.env.local` gana al mergear.
 *      Este script no usa ninguna service key — sólo el PAT del Management API — pero
 *      las reporta para que quede escrito a qué base apunta cada una.
 *
 * ⚠️ PRE-ESTADO OBLIGATORIO (AR MNR-3, y el propio `.sql` lo exige). El `UPDATE`
 * SOBREESCRIBE `maxLimit` si la fila ya tenía uno, y el `_down` **borra** la clave en
 * vez de restaurar el valor viejo: el par up/down NO es reversible si había un valor
 * previo. Por eso este script LEE Y MUESTRA el pre-estado antes de tocar nada, y si
 * encuentra un valor previo distinto de 100 **aborta** en vez de pisarlo en silencio.
 *
 * VERIFICACIÓN DE POST-ESTADO: lee de la base (no del `.sql` del repo) que
 * `schema->'discovery'->'maxLimit'` quedó en 100, que `nextCursorPath` sigue intacto y
 * que la columna `auth` NO cambió (CD-17: borrarla reabre la recursión a2a → v2 → a2a).
 *
 * Uso:  node scripts/apply-wkh318b-migration.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Refs hardcodeados a propósito (ver el bloque de arriba).
const BDWV_REF = 'bdwvrwzvsldephfibmuu'; // desarrollo — el ÚNICO destino permitido
const CALDZ_REF = 'caldzjhjgctpgodldqav'; // PRODUCCIÓN/archivo — PROHIBIDO

const TARGET_REF = BDWV_REF;
const REGISTRY_ID = 'wasiai';
const EXPECTED_MAX_LIMIT = 100;
const DRY_RUN = process.argv.includes('--dry-run');

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

// ── Guard 2: reportar a QUÉ base apunta cada key, por el claim del JWT ──────
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
const ident = await query('SELECT current_database() AS db, current_user AS usr;');
console.log(
  `[target] ref=${TARGET_REF} (HARDCODEADO, no derivado de SUPABASE_URL)`,
);
console.log(`[target] HTTP ${ident.status} ${ident.text.slice(0, 200)}`);
if (!ident.ok) {
  console.error('[ABORT] No se pudo consultar la base destino.');
  process.exit(1);
}

// ── PRE-ESTADO (obligatorio, AR MNR-3) ─────────────────────────────────────
const PRE_SQL = `
SELECT id,
       schema -> 'discovery' -> 'maxLimit'       AS pre_max_limit,
       schema -> 'discovery' -> 'nextCursorPath' AS pre_next_cursor_path,
       (auth IS NOT NULL)                        AS auth_present,
       md5(COALESCE(auth::text, ''))             AS auth_md5
FROM registries WHERE id = '${REGISTRY_ID}';`;

const pre = await query(PRE_SQL);
console.log(`\n[pre-estado] HTTP ${pre.status}`);
console.log(pre.text);
if (!pre.ok) {
  console.error('[ABORT] No se pudo leer el pre-estado.');
  process.exit(1);
}

let preRows;
try {
  preRows = JSON.parse(pre.text);
} catch {
  console.error('[ABORT] Pre-estado no parseable.');
  process.exit(1);
}
if (!Array.isArray(preRows) || preRows.length === 0) {
  console.error(
    `[ABORT] No existe la fila id='${REGISTRY_ID}'. El UPDATE afectaría 0 filas; nada que hacer.`,
  );
  process.exit(2);
}
const preRow = preRows[0];
const preMax = preRow.pre_max_limit;
const authMd5Before = preRow.auth_md5;

// Si YA había un valor propio distinto del esperado, NO lo pisamos en silencio.
if (preMax !== null && preMax !== undefined && Number(preMax) !== EXPECTED_MAX_LIMIT) {
  console.error(
    `[ABORT] La fila ya declara maxLimit=${preMax}. El UPDATE lo sobreescribiría y el _down NO lo restaura.\n` +
      '        Anotá ese valor y decidí a mano. Este script no pisa un techo previo.',
  );
  process.exit(2);
}
if (Number(preMax) === EXPECTED_MAX_LIMIT) {
  console.log(
    `[idempotente] maxLimit ya vale ${EXPECTED_MAX_LIMIT}. El UPDATE es un no-op; se sigue para verificar el post-estado.`,
  );
}

if (DRY_RUN) {
  console.log('\n[dry-run] No se aplicó nada. Pre-estado leído y validado.');
  process.exit(0);
}

// ── APPLY ──────────────────────────────────────────────────────────────────
const MIGRATION = readFileSync(
  `${REPO}/supabase/migrations/20260804000000_wkh318b_registry_max_limit.sql`,
  'utf8',
);
const applied = await query(MIGRATION);
console.log(`\n[apply] HTTP ${applied.status} ${applied.text.slice(0, 300)}`);
if (!applied.ok) {
  console.error('[FAIL] La migración no se aplicó.');
  process.exit(1);
}

// ── POST-ESTADO (se lee de la base, no se asume) ───────────────────────────
const post = await query(PRE_SQL);
console.log(`\n[post-estado] HTTP ${post.status}`);
console.log(post.text);
if (!post.ok) {
  console.error('[FAIL] No se pudo leer el post-estado.');
  process.exit(1);
}
const postRow = JSON.parse(post.text)[0];

const okMax = Number(postRow.pre_max_limit) === EXPECTED_MAX_LIMIT;
const okCursor = postRow.pre_next_cursor_path !== null;
const okAuth = postRow.auth_md5 === authMd5Before;

console.log('\n── VERIFICACIÓN ──');
console.log(`  maxLimit === ${EXPECTED_MAX_LIMIT}          ${okMax ? '✅' : '❌ ' + postRow.pre_max_limit}`);
console.log(`  nextCursorPath sigue presente   ${okCursor ? '✅' : '❌ (corte A se perdió)'}`);
console.log(`  auth NO cambió (CD-17)          ${okAuth ? '✅' : '❌ ⚠️ LA CREDENCIAL CAMBIÓ'}`);

if (!okMax || !okCursor || !okAuth) {
  console.error('\n[FAIL] El post-estado no es el esperado.');
  process.exit(1);
}
console.log('\n[OK] Migración aplicada y verificada contra bdwv.');
