#!/usr/bin/env -S npx tsx
/**
 * WKH-307 — ¿EL MARCADOR DEL PROBE LLEGA A `error.message` POR EL CANAL REAL?
 *
 * ── EL SUPUESTO QUE ESTE GUION ELIMINA ─────────────────────────────────────
 *
 * `scripts/exercise-wkh307-functions.mjs` manda **SQL crudo por la Management API** y
 * demostro que Postgres levanta `WKH307_PROBE_OK`. Eso NO es lo que el gate necesita.
 * El gate necesita que **`supabase.rpc('claim_solana_settle_intent', { p_probe: true })`
 * deposite esa cadena en `error.message`**, porque de ahi cuelga todo:
 *
 *     const message = rpc.error?.message ?? '';
 *     if (message.includes(PROBE_OK_MARKER)) return { probe: 'ok' };
 *
 * Si PostgREST no expusiera el texto ahi, `probeSettleLedger` devolveria `rpc_missing`,
 * `ensureSolanaSchemaReady` daria `ok:false` y **`settle()` rechazaria TODOS los pagos
 * Solana** — con una alarma que dice "aplica la migracion" sobre una base donde la
 * migracion esta perfectamente aplicada. Fail-closed, si, pero el leg entero apagado
 * por una diferencia de TRANSPORTE, y con un diagnostico que manda a arreglar lo que no
 * esta roto.
 *
 * ── POR QUE ES SEGURO CORRERLO CONTRA DESARROLLO ───────────────────────────
 *
 * El caso C7b del ejercicio ya demostro que el `RAISE` ocurre ANTES de cualquier
 * escritura: llamar al probe por el cliente real **no escribe una fila**. Este guion lo
 * RE-VERIFICA contando filas antes y despues.
 *
 * ── QUE EJERCITA (la cadena completa, sin re-implementar nada) ─────────────
 *
 *   1. el `supabase.rpc(...)` crudo, para IMPRIMIR el `error.message` literal;
 *   2. `probeSettleLedger()` — la funcion de PRODUCCION;
 *   3. `ensureSolanaSchemaReady()` — el gate que consume `settle()`.
 *
 * ── SEGURIDAD ──────────────────────────────────────────────────────────────
 *
 * Mismos guards que el applier: ref de bdwv HARDCODEADO, aborta si resuelve al de
 * produccion, y la service key se elige por el claim `ref` del JWT — NUNCA por el
 * nombre de la variable (en `.env.local` la variable SIN sufijo apunta a PRODUCCION).
 * La URL se DERIVA del ref hardcodeado, no se lee de `SUPABASE_URL`, justamente para
 * que un `.env` apuntando a otra base no pueda desviar la corrida. Ninguna credencial
 * se imprime.
 *
 * Uso:  npx tsx scripts/probe-wkh307-preflight.mts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BDWV_REF = 'bdwvrwzvsldephfibmuu'; // desarrollo — el UNICO destino permitido
const CALDZ_REF = 'caldzjhjgctpgodldqav'; // PRODUCCION (dinero real) — PROHIBIDO
const TARGET_REF = BDWV_REF;

function readEnv(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m?.[1]) continue;
      let v = m[2] ?? '';
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
function jwtRef(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return typeof payload.ref === 'string' ? payload.ref : null;
  } catch {
    return null;
  }
}

// ── Guard 1: el destino es bdwv y NO es caldz ──────────────────────────────
if (TARGET_REF === CALDZ_REF) {
  console.error('[ABORT] El destino resuelto es CALDZ (produccion).');
  process.exit(3);
}
if (TARGET_REF !== BDWV_REF) {
  console.error(`[ABORT] Destino inesperado ${TARGET_REF}.`);
  process.exit(3);
}

const env = { ...readEnv(`${REPO}/.env`), ...readEnv(`${REPO}/.env.local`) };

// ── Guard 2: la key se ELIGE por el claim del JWT, no por el nombre ────────
let serviceKey: string | null = null;
for (const name of [
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SERVICE_KEY_D',
  'SUPABASE_SERVICE_ROLE_KEY',
]) {
  const val = env[name];
  if (!val) continue;
  const ref = jwtRef(val);
  const tag =
    ref === CALDZ_REF
      ? 'CALDZ (produccion) ⚠️ DESCARTADA'
      : ref === BDWV_REF
        ? 'bdwv (desarrollo) ← elegible'
        : `desconocido (${ref ?? 'no-jwt'}) — descartada`;
  console.log(`[env] ${name} → ${tag}`);
  if (ref === BDWV_REF && !serviceKey) serviceKey = val;
}
if (!serviceKey) {
  console.error(
    '[ABORT] No hay ninguna service key cuyo claim `ref` sea el de bdwv.',
  );
  process.exit(3);
}

// ── La URL se DERIVA del ref hardcodeado, no se lee del entorno ────────────
process.env.SUPABASE_URL = `https://${TARGET_REF}.supabase.co`;
process.env.SUPABASE_SERVICE_KEY = serviceKey;
console.log(`[target] ${process.env.SUPABASE_URL} (derivada del ref HARDCODEADO)`);

// Import DINAMICO: el cliente se construye al importar, asi que el entorno tiene que
// estar seteado ANTES.
const { supabase } = await import('../src/lib/supabase.js');
const { probeSettleLedger, PROBE_OK_MARKER } = await import(
  '../src/adapters/solana/settle-ledger.js'
);
const { ensureSolanaSchemaReady, _resetSolanaSchemaPreflight } = await import(
  '../src/adapters/solana/schema-preflight.js'
);

const TABLE = 'a2a_solana_settle_intents';
const countRows = async (): Promise<number> => {
  const { count, error } = await supabase
    .from(TABLE)
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`no se pudo contar: ${error.message}`);
  return count ?? -1;
};

const results: { id: string; what: string; ok: boolean; detail: string }[] = [];
function check(id: string, what: string, ok: boolean, detail: string) {
  results.push({ id, what, ok, detail });
  console.log(`[${ok ? '  OK  ' : ' FAIL '}] ${id} · ${what}`);
  console.log(`         ${detail}`);
}

const before = await countRows();
console.log(`\n[tabla] filas antes: ${before}\n`);

// ══════════════════════════════════════════════════════════════
// 1 · El rpc CRUDO por el cliente real: ¿que llega en error.message?
// ══════════════════════════════════════════════════════════════
const probeIntent = `wkh307-preflight-probe-${Date.now()}`;
const raw = await supabase.rpc('claim_solana_settle_intent', {
  p_intent_id: probeIntent,
  p_caip2: 'probe',
  p_pay_to: 'probe',
  p_amount_atomic: '0',
  p_mint: 'probe',
  p_lease_ms: 1,
  p_probe: true,
});

console.log('─── lo que devuelve supabase-js ───');
console.log(`  error.message : ${JSON.stringify(raw.error?.message ?? null)}`);
console.log(`  error.code    : ${JSON.stringify(raw.error?.code ?? null)}`);
console.log(`  error.details : ${JSON.stringify(raw.error?.details ?? null)}`);
console.log(`  error.hint    : ${JSON.stringify(raw.error?.hint ?? null)}`);
console.log(`  data          : ${JSON.stringify(raw.data ?? null)}\n`);

check(
  'P1',
  '`error.message` de supabase.rpc CONTIENE el marcador del probe',
  (raw.error?.message ?? '').includes(PROBE_OK_MARKER),
  `esperado que incluya ${PROBE_OK_MARKER} · obtenido: ${JSON.stringify(raw.error?.message ?? null)}`,
);

// ══════════════════════════════════════════════════════════════
// 2 · La funcion de PRODUCCION
// ══════════════════════════════════════════════════════════════
const probeResult = await probeSettleLedger();
check(
  'P2',
  '`probeSettleLedger()` (produccion) da veredicto `ok`',
  probeResult.probe === 'ok',
  `obtenido: ${JSON.stringify(probeResult)}`,
);

// ══════════════════════════════════════════════════════════════
// 3 · El gate que consume settle()
// ══════════════════════════════════════════════════════════════
_resetSolanaSchemaPreflight();
const verdict = await ensureSolanaSchemaReady();
check(
  'P3',
  '`ensureSolanaSchemaReady()` da `ok:true` (el leg Solana NO queda apagado)',
  verdict.ok === true,
  `obtenido: ${JSON.stringify(verdict)}`,
);

// ══════════════════════════════════════════════════════════════
// 4 · El probe NO escribe (re-verificacion del caso C7b)
// ══════════════════════════════════════════════════════════════
const after = await countRows();
check(
  'P4',
  'ninguna de las tres llamadas escribio una fila',
  after === before,
  `antes=${before} despues=${after}`,
);
const leftover = await supabase
  .from(TABLE)
  .select('intent_id')
  .like('intent_id', 'wkh307-preflight-probe-%');
check(
  'P5',
  'no quedo ninguna fila con el intent del probe',
  (leftover.data?.length ?? 0) === 0,
  `filas con prefijo del probe: ${leftover.data?.length ?? 'error'}`,
);

// ── Reporte ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n[resumen] ${results.length - failed.length}/${results.length} OK`);
if (failed.length > 0) {
  console.error(
    '\n[FAIL] el gate del preflight NO se comporta como el codigo asume:',
  );
  for (const f of failed) console.error(`  · ${f.id} — ${f.what}: ${f.detail}`);
  process.exit(1);
}
console.log(
  '[OK] el marcador del probe viaja por el canal REAL (supabase-js → PostgREST → plpgsql) y el gate abre.',
);
