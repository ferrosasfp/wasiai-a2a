#!/usr/bin/env node
/**
 * WKH-307 — EJERCITA LAS 4 FUNCIONES `plpgsql` CONTRA POSTGRES DE VERDAD.
 *
 * ── POR QUE EXISTE ─────────────────────────────────────────────────────────
 *
 * Los 31 tests de `test/wkh307-solana-settle-intents.migration.test.ts` **parsean el
 * `.sql` y evaluan predicados en JS**: prueban que el texto de la migracion dice lo que
 * tiene que decir, no que Postgres HAGA lo que dice. Y aplicar la migracion prueba que
 * el DDL es valido, no que las funciones funcionen.
 *
 * Ademas el preflight de esquema hace `RAISE EXCEPTION` como PRIMERA sentencia, o sea
 * que demuestra "la funcion deployada es la nueva" **sin ejercitar una sola linea** del
 * `INSERT ... ON CONFLICT`, del `make_interval(secs => ...)`, del
 * `expired_signatures || ARRAY[...]` ni del patron `RETURNS TABLE` + `RETURN NEXT`.
 *
 * Dicho crudo: sin este guion, **el primer settle Solana real seria la primera
 * ejecucion de ese SQL en la historia**. No es riesgo de dinero (un error de SQL
 * degrada fail-closed), es riesgo de enterarnos en produccion.
 *
 * ── SEGURIDAD (mismos guards que `apply-wkh307-migration.mjs`) ─────────────
 *
 * 1. HARDCODEA el ref de bdwv y NO lo deriva de `SUPABASE_URL`. El footgun esta
 *    documentado en `scripts/apply-prod-migrations.sh`: el `.env` local apunta a otra
 *    base que el gateway de prod.
 * 2. ABORTA si el ref resuelto es el de caldz, por si alguien edita el literal.
 * 3. Las service keys se identifican por el claim `ref` del JWT, NUNCA por el nombre
 *    de la variable (en `.env.local` la variable SIN sufijo apunta a PRODUCCION).
 *    NINGUNA credencial se imprime: solo a que base apunta.
 *
 * ── HIGIENE DE DATOS ───────────────────────────────────────────────────────
 *
 * Todos los intents de prueba llevan el prefijo `wkh307-exercise-<timestamp>:` y se
 * BORRAN al final, contando filas antes y despues para verificar que el borrado
 * ocurrio. Una tabla de desarrollo llena de basura de prueba es deuda que despues
 * alguien confunde con datos.
 *
 * Uso:  node scripts/exercise-wkh307-functions.mjs [--keep] [--state]
 *       `--keep`  deja las filas para inspeccion manual (por defecto limpia)
 *       `--state` solo reporta el estado de la tabla y sale, sin escribir nada
 *       `--cleanup-orphans` borra filas de corridas anteriores (prefijo acotado)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Refs hardcodeados a proposito (ver el bloque de arriba).
const BDWV_REF = 'bdwvrwzvsldephfibmuu'; // desarrollo — el UNICO destino permitido
const CALDZ_REF = 'caldzjhjgctpgodldqav'; // PRODUCCION (dinero real) — PROHIBIDO

const TARGET_REF = BDWV_REF;
const TABLE = 'public.a2a_solana_settle_intents';

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

/** Ref del claim de un JWT de Supabase, o null. NUNCA loguea el token. */
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
    '[ABORT] El destino resuelto es CALDZ (produccion, dinero real). Este guion solo corre contra bdwv.',
  );
  process.exit(3);
}
if (TARGET_REF !== BDWV_REF) {
  console.error(`[ABORT] Destino inesperado ${TARGET_REF}; se esperaba bdwv.`);
  process.exit(3);
}

const env = { ...readEnv(`${REPO}/.env`), ...readEnv(`${REPO}/.env.local`) };

// ── Guard 2: reportar a QUE base apuntan las keys, sin imprimirlas ─────────
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
      ? 'CALDZ (produccion) ⚠️ NO se usa en este guion'
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
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* no-JSON */
  }
  return { ok: res.ok, status: res.status, text, json };
}

/** Literal SQL de texto, escapando comillas. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── Guard 3: confirmar contra la base que estamos donde creemos ────────────
const ident = await query('SELECT current_database() AS db;');
console.log(
  `[target] ref=${TARGET_REF} (HARDCODEADO, no derivado de SUPABASE_URL)`,
);
console.log(`[target] HTTP ${ident.status} ${ident.text.slice(0, 120)}`);
if (!ident.ok) {
  console.error('[ABORT] No se pudo consultar la base destino.');
  process.exit(1);
}

// ── `--state`: solo reporta el estado de la tabla y sale (no escribe nada) ──
if (process.argv.includes('--state')) {
  const st = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE intent_id LIKE 'wkh307-exercise-%')::int AS basura_de_prueba,
            count(*) FILTER (WHERE status <> 'confirmed')::int AS sin_confirmar
       FROM ${TABLE};`,
  );
  console.log(`[state] ${st.text}`);
  const rows = await query(
    `SELECT intent_id, status, attempts, claimed_at::text
       FROM ${TABLE} WHERE intent_id LIKE 'wkh307-exercise-%' ORDER BY claimed_at;`,
  );
  console.log(`[state] filas de prueba residuales: ${rows.text}`);
  process.exit(0);
}

// ── `--cleanup-orphans`: borra filas de CORRIDAS ANTERIORES de este guion ──
//
// ⚠️ POR QUE HACE FALTA: si la salida del guion se pipea a `head`/`tail`, el pipe se
// cierra, node recibe EPIPE y MUERE antes del bloque de limpieza — dejando filas
// colgadas. Le paso una vez de verdad. El borrado esta acotado al prefijo
// `wkh307-exercise-%`, que solo produce este archivo: NUNCA toca datos reales.
if (process.argv.includes('--cleanup-orphans')) {
  // `row0` se define mas abajo: aca se parsea inline para no depender del orden.
  const n1 = async (sql) => {
    const r = await query(sql);
    return Array.isArray(r.json) ? (r.json[0]?.n ?? -1) : -1;
  };
  const before = await n1(
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE intent_id LIKE 'wkh307-exercise-%';`,
  );
  await query(
    `DELETE FROM ${TABLE} WHERE intent_id LIKE 'wkh307-exercise-%';`,
  );
  const after = await n1(
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE intent_id LIKE 'wkh307-exercise-%';`,
  );
  const total = await n1(`SELECT count(*)::int AS n FROM ${TABLE};`);
  console.log(
    `[cleanup-orphans] antes=${before} despues=${after} · total en la tabla=${total}`,
  );
  process.exit(after === 0 ? 0 : 1);
}

// ── El escenario ───────────────────────────────────────────────────────────
const RUN = `wkh307-exercise-${Date.now()}`;
const P = (name) => `${RUN}:${name}`;
const CAIP2 = 'solana:devnet-exercise';
const PAY_A = 'PayToAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAY_B = 'PayToBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MINT = 'MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const AMT = '3000000';
/**
 * ⚠️ FIRMAS CON ALCANCE DE CORRIDA. El indice UNIQUE sobre `settle_signature` es
 * GLOBAL, asi que constantes fijas hacen que dos corridas de este guion choquen entre
 * si (la segunda recibe 23505 donde espera exito). Medido: paso de verdad.
 */
const SIG_A = `SigA-${RUN}`;
const SIG_B = `SigB-${RUN}`;
/**
 * 2^53 + 1: POR ENCIMA del entero seguro de JS (o sea que prueba de verdad lo que a
 * WKH-196 le importa — `JSON.parse` redondearia este numero) y COMODAMENTE dentro de
 * `BIGINT` con signo (max 9223372036854775807).
 *
 * ⚠️ NO se usa uint64 max aca: `last_valid_block_height` es `BIGINT`, no `TEXT`, y ese
 * valor lo hace tirar `22003 out of range`. Un slot de Solana real ronda 3.5e8, o sea
 * diez ordenes de magnitud por debajo del techo — pero el limite ahora esta MEDIDO en
 * vez de supuesto (caso B1 de abajo).
 */
const LVBH = '9007199254740993';
/** Fuera de rango para BIGINT: se usa para MEDIR el techo, no como caso normal. */
const LVBH_OVERFLOW = '18446744073709551615';

function claimSql(intent, { payTo = PAY_A, amount = AMT, mint = MINT, lease = 120000, probe = false } = {}) {
  return `SELECT * FROM public.claim_solana_settle_intent(${lit(intent)}, ${lit(CAIP2)}, ${lit(payTo)}, ${lit(amount)}, ${lit(mint)}, ${lease}, ${probe});`;
}
const signedSql = (intent, sig, lvbh = LVBH) =>
  `SELECT * FROM public.record_solana_settle_signed(${lit(intent)}, ${lit(sig)}, ${lit(lvbh)});`;
const confirmedSql = (intent, sig) =>
  `SELECT * FROM public.record_solana_settle_confirmed(${lit(intent)}, ${lit(sig)});`;
const reclaimSql = (intent, sig) =>
  `SELECT * FROM public.reclaim_solana_settle_intent(${lit(intent)}, ${lit(sig)});`;

const results = [];
function check(id, what, expected, actual, ok, note = '') {
  results.push({ id, what, expected, actual, ok, note });
  const mark = ok ? '  OK  ' : ' FAIL ';
  console.log(`[${mark}] ${id} · ${what}`);
  console.log(`         esperado: ${expected}`);
  console.log(`         obtenido: ${actual}${note ? `  (${note})` : ''}`);
}

/** Primera fila de un SELECT, o null. */
const row0 = (r) => (Array.isArray(r.json) ? (r.json[0] ?? null) : null);
const fmt = (o) => (o === null ? 'null' : JSON.stringify(o));
/**
 * Igual que `fmt`, pero cuando NO hubo fila muestra el ERROR CRUDO de Postgres.
 * Un `null` pelado no dice si la funcion devolvio vacio o si tiro — y esa diferencia
 * es justo la que hace falta para diagnosticar.
 */
const fmtOr = (r, o) => (o === null ? `sin fila · ${r.text.slice(0, 200)}` : JSON.stringify(o));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n[run] prefijo de intents de prueba: ${RUN}:*\n`);

// Conteo ANTES (para verificar la limpieza al final).
const beforeCount = await query(
  `SELECT count(*)::int AS n FROM ${TABLE} WHERE intent_id LIKE ${lit(`${RUN}:%`)};`,
);
const nBefore = row0(beforeCount)?.n ?? -1;

// ══════════════════════════════════════════════════════════════
// 1 · claim_solana_settle_intent
// ══════════════════════════════════════════════════════════════
console.log('── claim_solana_settle_intent ──────────────────────────────');

{
  const r = await query(claimSql(P('a')));
  const x = row0(r);
  check(
    'C1',
    'reclamo LIMPIO de un intent nuevo',
    "applied=true outcome=claimed status=claimed sig=null attempts=1",
    fmt(x),
    x?.applied === true &&
      x?.outcome === 'claimed' &&
      x?.status === 'claimed' &&
      x?.settle_signature === null &&
      x?.attempts === 1,
  );
  check(
    'C1b',
    'la fila RETURNS TABLE trae las 6 columnas y lvbh es TEXT',
    'applied,outcome,status,settle_signature,last_valid_block_height,attempts',
    x ? Object.keys(x).join(',') : 'null',
    x !== null &&
      ['applied', 'outcome', 'status', 'settle_signature', 'last_valid_block_height', 'attempts'].every(
        (k) => k in x,
      ),
  );
}

{
  const r = await query(claimSql(P('a')));
  const x = row0(r);
  check(
    'C2',
    'mismo intent, MISMOS terminos, DENTRO del lease',
    'applied=false outcome=in_progress',
    fmt(x),
    x?.applied === false && x?.outcome === 'in_progress',
  );
}

{
  const r = await query(claimSql(P('a'), { payTo: PAY_B }));
  const x = row0(r);
  check(
    'C3',
    'mismo intent, OTRO payTo (AC-8)',
    'applied=false outcome=terms_conflict',
    fmt(x),
    x?.applied === false && x?.outcome === 'terms_conflict',
  );
}
{
  const r = await query(claimSql(P('a'), { amount: '999' }));
  const x = row0(r);
  check(
    'C3b',
    'mismo intent, OTRO monto (AC-8)',
    'applied=false outcome=terms_conflict',
    fmt(x),
    x?.applied === false && x?.outcome === 'terms_conflict',
  );
}
{
  const r = await query(claimSql(P('a'), { mint: 'OtroMint' }));
  const x = row0(r);
  check(
    'C3c',
    'mismo intent, OTRO mint (AC-8)',
    'applied=false outcome=terms_conflict',
    fmt(x),
    x?.applied === false && x?.outcome === 'terms_conflict',
  );
}

// ── EL LEASE: make_interval + now() de POSTGRES, en las dos direcciones ──
{
  await sleep(1100); // que pase >1s de reloj del SERVIDOR
  const r = await query(claimSql(P('a'), { lease: 1000 }));
  const x = row0(r);
  check(
    'C4',
    'lease VENCIDO (1000 ms, la fila es mas vieja) ⟹ se roba el reclamo',
    'applied=true outcome=claimed attempts=2',
    fmt(x),
    x?.applied === true && x?.outcome === 'claimed' && x?.attempts === 2,
    'ejercita make_interval(secs => ...) y now() del servidor',
  );
}
{
  const r = await query(claimSql(P('a'), { lease: 3600000 }));
  const x = row0(r);
  check(
    'C5',
    'lease VIVO (3600000 ms) sobre la misma fila ⟹ NO se roba',
    'applied=false outcome=in_progress',
    fmt(x),
    x?.applied === false && x?.outcome === 'in_progress',
    'la otra direccion del mismo predicado',
  );
}

// ── Concurrencia: dos reclamos en paralelo, UN solo ganador ──
{
  const intent = P('concurrent');
  const [r1, r2] = await Promise.all([
    query(claimSql(intent)),
    query(claimSql(intent)),
  ]);
  const outs = [row0(r1), row0(r2)];
  const winners = outs.filter((o) => o?.applied === true && o?.outcome === 'claimed');
  check(
    'C6',
    'DOS reclamos en PARALELO sobre el mismo intent',
    'exactamente 1 ganador (applied=true)',
    `${winners.length} ganador(es): ${outs.map(fmt).join(' | ')}`,
    winners.length === 1,
    'la PK es lo que lo decide, no el codigo',
  );
}

// ── El probe: RAISE como primera sentencia, sin escribir ──
{
  const intent = P('probe');
  const r = await query(claimSql(intent, { probe: true }));
  const raised = r.text.includes('WKH307_PROBE_OK');
  check(
    'C7',
    'p_probe=true levanta WKH307_PROBE_OK',
    'error con la marca WKH307_PROBE_OK',
    r.text.slice(0, 160),
    raised,
  );
  const after = await query(
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE intent_id = ${lit(intent)};`,
  );
  check(
    'C7b',
    'el probe NO escribio ninguna fila',
    'n=0',
    fmt(row0(after)),
    row0(after)?.n === 0,
  );
}

// ══════════════════════════════════════════════════════════════
// 2 · record_solana_settle_signed
// ══════════════════════════════════════════════════════════════
console.log('\n── record_solana_settle_signed ─────────────────────────────');

{
  const r = await query(signedSql(P('a'), SIG_A));
  const x = row0(r);
  check(
    'S1',
    'sobre una fila `claimed` ⟹ aplica',
    `applied=true outcome=applied status=signed sig=${SIG_A} lvbh=${LVBH}`,
    fmtOr(r, x),
    x?.applied === true &&
      x?.outcome === 'applied' &&
      x?.status === 'signed' &&
      x?.settle_signature === SIG_A &&
      x?.last_valid_block_height === LVBH,
    'lvbh por encima de 2^53 viaja como TEXT sin perder digitos',
  );
}
{
  const r = await query(signedSql(P('a'), SIG_B));
  const x = row0(r);
  check(
    'S2',
    'sobre una fila YA `signed` ⟹ NO aplica (SEGUNDO CANDADO)',
    'applied=false outcome=not_claimed',
    fmt(x),
    x?.applied === false && x?.outcome === 'not_claimed',
    'es lo que frena al perdedor de la carrera del lease',
  );
}
{
  const r = await query(signedSql(P('inexistente'), SIG_B));
  const x = row0(r);
  check(
    'S3',
    'sobre un intent inexistente ⟹ NO aplica',
    'applied=false outcome=not_claimed',
    fmt(x),
    x?.applied === false && x?.outcome === 'not_claimed',
  );
}

// ── El TECHO de la columna, medido en vez de supuesto ──
{
  const intent = P('overflow');
  await query(claimSql(intent));
  const r = await query(signedSql(intent, `SigOverflow-${RUN}`, LVBH_OVERFLOW));
  const outOfRange = /22003|out of range/i.test(r.text);
  check(
    'B1',
    'un last_valid_block_height > BIGINT max ⟹ la funcion TIRA (no trunca)',
    'error 22003 out of range',
    r.text.slice(0, 140),
    outOfRange,
    'tirar es lo correcto: el seam lo traduce a store_unavailable y NO se transmite',
  );
  const row = row0(
    await query(
      `SELECT status, settle_signature FROM ${TABLE} WHERE intent_id = ${lit(intent)};`,
    ),
  );
  check(
    'B2',
    'y la fila NO queda con una altura truncada',
    'status=claimed sig=null',
    fmt(row),
    row?.status === 'claimed' && row?.settle_signature === null,
    'fail-closed: mejor no firmar que firmar con un dato corrompido',
  );
}

// ── INDICE UNIQUE PARCIAL ──
{
  const intent = P('dup-sig');
  await query(claimSql(intent));
  const r = await query(signedSql(intent, SIG_A)); // SIG_A ya esta en P('a')
  const is23505 =
    r.text.includes('23505') ||
    /duplicate key|unique constraint/i.test(r.text);
  check(
    'U1',
    'DOS intents con la MISMA firma ⟹ viola el UNIQUE parcial',
    'error 23505 / duplicate key',
    r.text.slice(0, 180),
    is23505,
    'es la proteccion que repone lo que se pierde al dejar sendAndConfirmTransaction',
  );
}
{
  const r = await query(
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE intent_id LIKE ${lit(`${RUN}:%`)} AND settle_signature IS NULL;`,
  );
  const n = row0(r)?.n ?? -1;
  check(
    'U2',
    'varias filas `claimed` con firma NULL CONVIVEN (el indice es PARCIAL)',
    'n >= 2',
    `n=${n}`,
    n >= 2,
    'sin el WHERE settle_signature IS NOT NULL, la 2a fila reclamada fallaria',
  );
}

// ══════════════════════════════════════════════════════════════
// 3 · record_solana_settle_confirmed
// ══════════════════════════════════════════════════════════════
console.log('\n── record_solana_settle_confirmed ──────────────────────────');

{
  const r = await query(confirmedSql(P('a'), SIG_B));
  const x = row0(r);
  check(
    'F1',
    'con una firma DISTINTA de la persistida ⟹ no aplica',
    'applied=false outcome=signature_mismatch',
    fmt(x),
    x?.applied === false && x?.outcome === 'signature_mismatch',
  );
}
{
  const r = await query(confirmedSql(P('a'), SIG_A));
  const x = row0(r);
  check(
    'F2',
    'con la firma CORRECTA ⟹ aplica y pasa a confirmed',
    'applied=true outcome=applied status=confirmed',
    fmt(x),
    x?.applied === true && x?.outcome === 'applied' && x?.status === 'confirmed',
  );
}
{
  const r = await query(confirmedSql(P('a'), SIG_A));
  const x = row0(r);
  check(
    'F3',
    're-confirmar la MISMA firma es idempotente',
    'applied=true (status IN (signed,confirmed))',
    fmt(x),
    x?.applied === true,
  );
}

// ══════════════════════════════════════════════════════════════
// 4 · reclaim_solana_settle_intent
// ══════════════════════════════════════════════════════════════
console.log('\n── reclaim_solana_settle_intent ────────────────────────────');

{
  const intent = P('reclaim');
  await query(claimSql(intent));
  await query(signedSql(intent, SIG_B));
  const before = row0(
    await query(
      `SELECT claimed_at::text AS claimed_at FROM ${TABLE} WHERE intent_id = ${lit(intent)};`,
    ),
  );
  await sleep(1100);
  const r = await query(reclaimSql(intent, SIG_B));
  const x = row0(r);
  check(
    'R1',
    'sobre una fila `signed` con SU firma ⟹ vuelve a claimed',
    'applied=true outcome=applied status=claimed sig=null lvbh=null attempts=2',
    fmt(x),
    x?.applied === true &&
      x?.outcome === 'applied' &&
      x?.status === 'claimed' &&
      x?.settle_signature === null &&
      x?.last_valid_block_height === null &&
      x?.attempts === 2,
  );

  const after = row0(
    await query(
      `SELECT expired_signatures, claimed_at::text AS claimed_at FROM ${TABLE} WHERE intent_id = ${lit(intent)};`,
    ),
  );
  const archived = Array.isArray(after?.expired_signatures)
    ? after.expired_signatures
    : [];
  check(
    'R2',
    'la firma vieja queda ARCHIVADA en expired_signatures (`|| ARRAY[...]`)',
    `[${SIG_B}]`,
    fmt(after?.expired_signatures),
    archived.length === 1 && archived[0] === SIG_B,
    'este operador nunca habia corrido',
  );
  check(
    'R3',
    'claimed_at se RENUEVA (el lease arranca de cero)',
    `> ${before?.claimed_at}`,
    String(after?.claimed_at),
    Boolean(before?.claimed_at && after?.claimed_at) &&
      new Date(after.claimed_at).getTime() > new Date(before.claimed_at).getTime(),
  );
}
{
  const r = await query(reclaimSql(P('a'), SIG_A)); // P('a') esta `confirmed`
  const x = row0(r);
  check(
    'R4',
    'sobre una fila que NO esta `signed` ⟹ no aplica',
    'applied=false outcome=not_signed',
    fmt(x),
    x?.applied === false && x?.outcome === 'not_signed',
  );
}
{
  const intent = P('reclaim');
  const r = await query(reclaimSql(intent, 'FirmaQueNoEsLaSuya'));
  const x = row0(r);
  check(
    'R5',
    'con una firma que no es la de la fila ⟹ no aplica',
    'applied=false outcome=not_signed',
    fmt(x),
    x?.applied === false && x?.outcome === 'not_signed',
  );
}

// ══════════════════════════════════════════════════════════════
// Limpieza — y VERIFICADA
// ══════════════════════════════════════════════════════════════
console.log('\n── limpieza ────────────────────────────────────────────────');

const mid = row0(
  await query(
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE intent_id LIKE ${lit(`${RUN}:%`)};`,
  ),
);
console.log(`[cleanup] filas de prueba creadas: ${mid?.n ?? '?'} (antes: ${nBefore})`);

if (process.argv.includes('--keep')) {
  console.log('[cleanup] --keep: las filas se dejan para inspeccion manual.');
} else {
  await query(
    `DELETE FROM ${TABLE} WHERE intent_id LIKE ${lit(`${RUN}:%`)};`,
  );
  const after = row0(
    await query(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE intent_id LIKE ${lit(`${RUN}:%`)};`,
    ),
  );
  check(
    'Z1',
    'la limpieza BORRO todas las filas de prueba',
    'n=0',
    fmt(after),
    after?.n === 0,
  );
}

// ── Reporte ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(
  `\n[resumen] ${results.length - failed.length}/${results.length} casos OK`,
);
if (failed.length > 0) {
  console.error('\n[FAIL] casos que NO coinciden con lo que el test en JS afirma:');
  for (const f of failed) {
    console.error(`  · ${f.id} — ${f.what}`);
    console.error(`      esperado: ${f.expected}`);
    console.error(`      obtenido: ${f.actual}`);
  }
  process.exit(1);
}
console.log('[OK] las 4 funciones se comportan como los tests en JS afirman.');
