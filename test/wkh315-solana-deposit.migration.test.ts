/**
 * WKH-315 — tests estructurales de la migración del depósito Solana.
 *
 * 100% mock (`readFileSync` sobre los `.sql`): el repo NO tiene Postgres in-process.
 *
 * ── LA REGLA QUE GOBIERNA ESTE ARCHIVO (heredada de HU-202 / WKH-307) ──────
 *
 * Los predicados NO se re-escriben en JavaScript: se **EXTRAEN del `.sql` y se
 * EVALUAN** (`evalSqlPredicate`, helper compartido). Una tabla de verdad
 * re-implementada en JS es **verdadera por construcción** — se puede borrar el
 * `WHERE` entero de la migración y las aserciones siguen verdes.
 *
 * ── Y TODA AFIRMACION DE CONDUCTA USA `code()` ─────────────────────────────
 *
 * El sql CRUDO incluye la cabecera, y la cabecera DESCRIBE en prosa lo mismo que el
 * cuerpo hace: un match contra el texto completo se satisface con el COMENTARIO.
 * Eso verificaría que la migración se *describa*, no que *haga*. Esta migración
 * tiene una cabecera larga y explícita —"SIN `chain_id`", "DROP FUNCTION", "archiva
 * primero"— así que sin `code()` casi todos estos tests serían vacuos.
 *
 * ── QUE PROPIEDAD CANDA CADA TEST ──────────────────────────────────────────
 *
 * T-315-14   el índice parcial Solana es UNIQUE, sobre (tx_hash) y SIN chain_id
 *            + el DROP de la fn de 6 args PRECEDE al CREATE de la de 7
 * T-315-14b  `UNIQUE (chain_id, tx_hash)` sigue existiendo e INTACTO (CD-1)
 * T-315-14c  el `_down` ARCHIVA antes de destruir y el `up` RE-HIDRATA antes del índice
 * T-315-04b  la unicidad Solana NO depende del sentinel env-driven
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evalSqlPredicate } from './helpers/sql-predicate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');

const UP = resolve(MIGRATIONS, '20260731000000_wkh315_solana_deposit.sql');
const DOWN = resolve(MIGRATIONS, '20260731000000_wkh315_solana_deposit_down.sql');
/** La migración de WKH-35 que creó `UNIQUE (chain_id, tx_hash)`. CD-1: intacta. */
const WKH35 = resolve(MIGRATIONS, '20260529000000_a2a_key_deposits.sql');

const flat = (s: string) => s.replace(/\s+/g, ' ');

/** SQL con los COMENTARIOS QUITADOS. Ver la cabecera: es la diferencia entre
 * verificar que la migración HAGA algo y que lo DESCRIBA. */
const code = (s: string) =>
  flat(
    s
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n'),
  );

const upSql = readFileSync(UP, 'utf8');
const downSql = readFileSync(DOWN, 'utf8');
const wkh35Sql = readFileSync(WKH35, 'utf8');

const upCode = code(upSql);
const downCode = code(downSql);

/**
 * El `CREATE UNIQUE INDEX … ;` cuyo nombre es `name`, tal como está escrito, sin
 * comentarios. TIRA si no está — ese throw es el que caza al mutante que lo borra.
 */
function indexStmt(sql: string, name: string): string {
  const at = sql.indexOf(name);
  if (at === -1) {
    throw new Error(`INDICE AUSENTE en el .sql: ${name}`);
  }
  const start = sql.lastIndexOf('CREATE', at);
  if (start === -1) throw new Error(`no hay CREATE antes de ${name}`);
  const end = sql.indexOf(';', at);
  if (end === -1) throw new Error(`el CREATE INDEX de ${name} no cierra con ;`);
  return sql.slice(start, end);
}

/**
 * El predicado del `WHERE` de un índice parcial, tal como está en el `.sql`.
 * Se EVALUA (no se re-implementa): si alguien lo cambia, la tabla de verdad de
 * abajo se pone roja.
 */
function partialIndexWhere(stmt: string): string {
  const at = stmt.indexOf('WHERE');
  if (at === -1) {
    throw new Error(
      `INDICE NO PARCIAL: sin WHERE, el UNIQUE aplicaría a las filas EVM también (rompería CD-1)`,
    );
  }
  return stmt.slice(at + 'WHERE'.length).trim();
}

describe('WKH-315 — migración del depósito Solana (estructural sobre el .sql)', () => {
  // ── T-315-14 / T-315-04b: el candado del anti-replay ──────────────────────
  describe('T-315-14 / T-315-04b: el índice parcial Solana', () => {
    const stmt = () => indexStmt(upCode, 'uq_a2a_key_deposits_solana_sig');

    it('T-315-14: es UNIQUE (un índice no-UNIQUE no impide NADA)', () => {
      expect(stmt()).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    });

    it('T-315-14: es sobre a2a_key_deposits y su columna indexada es SOLO (tx_hash)', () => {
      const s = stmt();
      expect(s).toMatch(/ON\s+a2a_key_deposits\s*\(\s*tx_hash\s*\)/i);
      // La lista de columnas, extraída, tiene EXACTAMENTE un término.
      const cols = /ON\s+a2a_key_deposits\s*\(([^)]*)\)/i.exec(s)?.[1] ?? '';
      expect(cols.split(',').map((c) => c.trim())).toEqual(['tx_hash']);
    });

    it('T-315-04b: la lista de columnas NO menciona chain_id — el sentinel es env-driven y CAMBIABLE EN CALIENTE', () => {
      // ⚠️ ESTE ES EL TEST DEL FOOTGUN. `SOLANA_SYNTHETIC_CHAIN_ID` se lee de env
      // (`chain.ts`), así que si la unicidad Solana dependiera de `chain_id`, un
      // cambio de esa variable re-abriría para re-crédito TODOS los depósitos
      // Solana pasados: misma firma + otro chain_id = otra fila, sin colisión.
      const cols = /ON\s+a2a_key_deposits\s*\(([^)]*)\)/i.exec(stmt())?.[1] ?? '';
      expect(cols).not.toMatch(/chain_id/i);
    });

    it('T-315-14: su WHERE, EXTRAIDO DEL .SQL Y EVALUADO, cubre las filas solana y NO las evm', () => {
      const where = partialIndexWhere(stmt());
      // No re-implementado: se evalúa la expresión tal como está escrita.
      expect(evalSqlPredicate(where, { vm_family: 'solana' })).toBe(true);
      expect(evalSqlPredicate(where, { vm_family: 'evm' })).toBe(false);
    });

    it('T-315-14: sin `lower()` sobre tx_hash — bajar a minúsculas una firma base58 la DESTRUYE', () => {
      expect(stmt()).not.toMatch(/lower\s*\(/i);
    });
  });

  // ── T-315-14b: CD-1 — la clave EVM queda intacta ──────────────────────────
  describe('T-315-14b: `UNIQUE (chain_id, tx_hash)` sigue vivo (CD-1)', () => {
    it('T-315-14b: la constraint original sigue declarada en la migración de WKH-35', () => {
      expect(code(wkh35Sql)).toMatch(
        /CONSTRAINT\s+uq_a2a_key_deposits_chain_tx\s+UNIQUE\s*\(\s*chain_id\s*,\s*tx_hash\s*\)/i,
      );
    });

    it('T-315-14b: la migración de WKH-315 NO la dropea ni la altera', () => {
      expect(upCode).not.toMatch(/DROP\s+CONSTRAINT\s+.*uq_a2a_key_deposits_chain_tx/i);
      expect(upCode).not.toMatch(/uq_a2a_key_deposits_chain_tx/i);
    });

    it('T-315-14b: `vm_family` entra con DEFAULT \'evm\' — toda fila histórica queda FUERA del índice parcial', () => {
      // Sin el DEFAULT, `NOT NULL` sobre una tabla con filas falla; y si el default
      // fuera 'solana', todas las filas EVM entrarían al índice nuevo y un
      // (chain_id distinto, mismo tx_hash) legítimo de EVM pasaría a colisionar.
      expect(upCode).toMatch(
        /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+vm_family\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'evm'/i,
      );
    });
  });

  // ── T-315-14 (2ª parte) / M13: el DROP de la sobrecarga ───────────────────
  describe('T-315-14: el DROP de la fn de 6 args PRECEDE al CREATE de la de 7 (M13)', () => {
    const SIX = "DROP FUNCTION IF EXISTS register_a2a_key_deposit(uuid, integer, numeric, text, text, text);";

    it('T-315-14: el DROP de la firma de 6 params existe', () => {
      // Sin él, `CREATE OR REPLACE` con otra lista de tipos de entrada NO
      // reemplaza: crea una SOBRECARGA, y el caller recibe
      // `function ... is not unique`. El fondeo entero se cae.
      expect(upCode).toContain(flat(SIX));
    });

    it('T-315-14: el DROP va ANTES del CREATE OR REPLACE (el orden ES la propiedad)', () => {
      const dropAt = upCode.indexOf(flat(SIX));
      const createAt = upCode.search(
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+register_a2a_key_deposit/i,
      );
      expect(dropAt).toBeGreaterThanOrEqual(0);
      expect(createAt).toBeGreaterThanOrEqual(0);
      expect(dropAt).toBeLessThan(createAt);
    });

    it('T-315-14: la fn nueva declara 7 params y `p_vm_family` con DEFAULT \'evm\' (M12)', () => {
      // El DEFAULT es lo que mantiene VALIDA la llamada de 6 args de la rama EVM.
      // Sin él, `supabase.rpc` con args nombrados no resuelve y el fondeo EVM muere.
      expect(upCode).toMatch(/p_vm_family\s+TEXT\s+DEFAULT\s+'evm'/i);
      // Y el INSERT tiene que ESCRIBIRLA (declararla sin usarla no hace nada).
      expect(upCode).toMatch(
        /INSERT\s+INTO\s+a2a_key_deposits\s*\([^)]*vm_family[^)]*\)/i,
      );
      expect(upCode).toMatch(/VALUES\s*\([^)]*p_vm_family[^)]*\)/i);
    });

    it('T-315-14: el hardening (search_path/REVOKE/GRANT) apunta a la firma de SIETE tipos', () => {
      const seven = /\(uuid,\s*integer,\s*numeric,\s*text,\s*text,\s*text,\s*text\)/i;
      const searchPath = /ALTER\s+FUNCTION\s+public\.register_a2a_key_deposit\s*\(uuid,\s*integer,\s*numeric,\s*text,\s*text,\s*text,\s*text\)\s*SET\s+search_path\s*=\s*public,\s*pg_temp/i;
      expect(upCode).toMatch(searchPath);
      const revoke = /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.register_a2a_key_deposit\s*\(uuid,\s*integer,\s*numeric,\s*text,\s*text,\s*text,\s*text\)\s*FROM\s+PUBLIC,\s*anon,\s*authenticated/i;
      expect(upCode).toMatch(revoke);
      const grant = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.register_a2a_key_deposit\s*\(uuid,\s*integer,\s*numeric,\s*text,\s*text,\s*text,\s*text\)\s*TO\s+service_role/i;
      expect(upCode).toMatch(grant);
      expect(seven.test(upCode)).toBe(true);
    });

    it('T-315-14: el CHECK acota vm_family a (evm, solana) y su predicado, EVALUADO, rechaza otro valor', () => {
      const m = /CHECK\s*\((\s*vm_family\s+IN\s*\([^)]*\)\s*)\)/i.exec(upCode);
      expect(m).not.toBeNull();
      const pred = (m?.[1] ?? '').trim();
      expect(evalSqlPredicate(pred, { vm_family: 'evm' })).toBe(true);
      expect(evalSqlPredicate(pred, { vm_family: 'solana' })).toBe(true);
      expect(evalSqlPredicate(pred, { vm_family: 'kite' })).toBe(false);
    });
  });

  // ── La otra columna: funding_wallet_solana ────────────────────────────────
  describe('funding_wallet_solana: UNIQUE parcial, case-SENSITIVE (AC-8 / CD-6)', () => {
    it('la columna se agrega como TEXT nullable', () => {
      expect(upCode).toMatch(
        /ALTER\s+TABLE\s+a2a_agent_keys\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+funding_wallet_solana\s+TEXT/i,
      );
    });

    it('su UNIQUE es sobre la columna CRUDA — PROHIBIDO lower() (bajar de caja una pubkey base58 la destruye)', () => {
      const stmt = indexStmt(upCode, 'uq_a2a_agent_keys_funding_wallet_solana');
      expect(stmt).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
      expect(stmt).toMatch(
        /ON\s+a2a_agent_keys\s*\(\s*funding_wallet_solana\s*\)/i,
      );
      expect(stmt).not.toMatch(/lower\s*\(/i);
      // Parcial: los NULL (sin bindear) no colisionan entre sí.
      const where = partialIndexWhere(stmt);
      expect(evalSqlPredicate(where, { funding_wallet_solana: 'Abc' })).toBe(
        true,
      );
      expect(evalSqlPredicate(where, { funding_wallet_solana: null })).toBe(
        false,
      );
    });

    it('NO se toca `funding_wallet` (el contrato lowercase de EVM es de otra HU — CD-1)', () => {
      expect(upCode).not.toMatch(/\bfunding_wallet\b(?!_solana)/);
    });
  });

  // ── T-315-14c: el `_down` es la MITAD DE UN CICLO (CD-17) ─────────────────
  describe('T-315-14c: el `_down` archiva y el `up` re-hidrata (CD-17)', () => {
    const BACKUP = 'a2a_key_deposits_solana_backup_wkh315';

    it('T-315-14c: el `_down` CREA la tabla de backup con las firmas Solana', () => {
      expect(downCode).toMatch(
        new RegExp(
          `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${BACKUP}\\s+AS\\s+SELECT\\s+id,\\s*tx_hash\\s+FROM\\s+a2a_key_deposits\\s+WHERE\\s+vm_family\\s*=\\s*'solana'`,
          'i',
        ),
      );
    });

    it('T-315-14c: el backup va ANTES del DROP COLUMN vm_family (el orden ES la propiedad)', () => {
      // ⚠️ Si el DROP fuera primero, el SELECT del backup no tendría de dónde leer:
      // la columna que discrimina las filas Solana ya no existiría. Archivaría cero
      // filas, en silencio, con exit 0.
      const backupAt = downCode.indexOf(`CREATE TABLE IF NOT EXISTS ${BACKUP}`);
      const dropAt = downCode.search(
        /ALTER\s+TABLE\s+a2a_key_deposits\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+vm_family/i,
      );
      expect(backupAt).toBeGreaterThanOrEqual(0);
      expect(dropAt).toBeGreaterThanOrEqual(0);
      expect(backupAt).toBeLessThan(dropAt);
    });

    it('T-315-14c: el `_down` RESTAURA la fn de 6 params (sin eso el fondeo EVM queda muerto tras el rollback)', () => {
      expect(downCode).toMatch(
        /DROP\s+FUNCTION\s+IF\s+EXISTS\s+register_a2a_key_deposit\(uuid,\s*integer,\s*numeric,\s*text,\s*text,\s*text,\s*text\)/i,
      );
      expect(downCode).toMatch(
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+register_a2a_key_deposit/i,
      );
      // La restaurada NO puede tener el 7º param.
      expect(downCode).not.toMatch(/p_vm_family/i);
    });

    it('T-315-14c: el `up` RE-HIDRATA vm_family=\'solana\' desde el backup', () => {
      // Sin esto, un ciclo down→up deja todas las filas Solana en 'evm' ⇒ afuera
      // del índice parcial ⇒ su unicidad vuelve a depender del sentinel ⇒ se
      // RE-ABREN PARA RE-CREDITO. El rollback sería el exploit.
      expect(upCode).toContain(BACKUP);
      expect(upCode).toMatch(
        /UPDATE\s+a2a_key_deposits\s+d\s+SET\s+vm_family\s*=\s*'solana'/i,
      );
      expect(upCode).toMatch(new RegExp(`FROM\\s+${BACKUP}\\s+b`, 'i'));
      expect(upCode).toMatch(/WHERE\s+d\.id\s*=\s*b\.id/i);
    });

    it('T-315-14c: la re-hidratación va ANTES de crear el índice parcial (el orden ES la propiedad)', () => {
      const rehydrateAt = upCode.search(
        /UPDATE\s+a2a_key_deposits\s+d\s+SET\s+vm_family\s*=\s*'solana'/i,
      );
      const indexAt = upCode.indexOf('uq_a2a_key_deposits_solana_sig');
      expect(rehydrateAt).toBeGreaterThanOrEqual(0);
      expect(indexAt).toBeGreaterThanOrEqual(0);
      expect(rehydrateAt).toBeLessThan(indexAt);
    });

    it('T-315-14c: el `_down` NUNCA dropea la tabla de backup (borrarla es decisión humana)', () => {
      expect(downCode).not.toMatch(
        new RegExp(`DROP\\s+TABLE[^;]*${BACKUP}`, 'i'),
      );
      expect(upCode).not.toMatch(
        new RegExp(`DROP\\s+TABLE[^;]*${BACKUP}`, 'i'),
      );
    });
  });

  // ── BLQ-MED-2: la ventana del schema-cache de PostgREST ───────────────────
  describe('BLQ-MED-2: las DOS migraciones recargan el schema-cache de PostgREST', () => {
    // ⚠️ POR QUE ES UN TEST Y NO UNA REVISION. Las dos migraciones hacen un SWAP de
    // firma sobre una función QUE ESTA EN USO (`register_a2a_key_deposit`, la que
    // llama `budgetService.registerDeposit`). Sin el `NOTIFY`, PostgREST sigue
    // resolviendo contra la firma vieja y `POST /auth/deposit` del camino **EVM**
    // contesta 500 — la regresión que CD-1 prohíbe, causada por la migración que
    // promete no tener ventana.
    const NOTIFY = /NOTIFY\s+pgrst\s*,\s*'reload schema'\s*;/i;

    it("BLQ-MED-2: el `up` emite NOTIFY pgrst, 'reload schema'", () => {
      expect(upCode).toMatch(NOTIFY);
    });

    it("BLQ-MED-2: el `_down` también (su swap es inverso y tiene la misma ventana)", () => {
      expect(downCode).toMatch(NOTIFY);
    });

    it('BLQ-MED-2: el NOTIFY va DESPUES del swap de firmas (avisar antes no avisa de nada)', () => {
      for (const [name, sql] of [
        ['up', upCode],
        ['down', downCode],
      ] as const) {
        const createAt = sql.search(
          /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+register_a2a_key_deposit/i,
        );
        const notifyAt = sql.search(NOTIFY);
        expect(createAt, name).toBeGreaterThanOrEqual(0);
        expect(notifyAt, name).toBeGreaterThan(createAt);
      }
    });
  });

  // ── Higiene: transaccional y sin secretos ─────────────────────────────────
  it('las dos migraciones son transaccionales (BEGIN/COMMIT) y no nombran ninguna credencial', () => {
    for (const [name, sql] of [
      ['up', upSql],
      ['down', downSql],
    ] as const) {
      expect(sql, name).toMatch(/^BEGIN;/m);
      expect(sql, name).toMatch(/^COMMIT;/m);
      expect(sql, name).not.toMatch(/PRIVATE_KEY|SERVICE_KEY|SUPABASE_/i);
    }
  });
});
