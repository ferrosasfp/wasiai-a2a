/**
 * SQL-estructural — WKH-225 migración a2a_suspended_runs.
 *
 * 100% mock (readFileSync sobre el .sql): NO se conecta a Supabase real.
 * Verifica que la tabla tenga RLS deny-by-default (ENABLE ROW LEVEL SECURITY,
 * sin CREATE POLICY), el CHECK de los 5 estados, el trigger que escribe
 * `expires_at` del lado de POSTGRES, y la firma exacta de los 2 RPC en el down.
 *
 * NO se agrega `a2a_suspended_runs` al set canónico RLS_TABLES de
 * `verify-rls-enabled.test.ts` (ripplearía el conteo `toHaveLength(10)`, fuera
 * de scope). Este bloque es aislado, igual que el de `agent-links.migration`.
 *
 * ⚠️ LO QUE ESTE ARCHIVO NO PUEDE DECIR. Lee TEXTO, no ejecuta SQL: prueba que
 * el guard está ESCRITO, no que Postgres lo haga cumplir. Que el orden de los
 * guards del claim sea el correcto lo prueba acá la secuencia de literales; que
 * ese orden PRODUZCA un 404 indistinguible lo prueban los tests del service.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', 'supabase', 'migrations');
const UP = resolve(MIGRATIONS, '20260823000000_wkh225_suspended_runs.sql');
const DOWN = resolve(
  MIGRATIONS,
  '20260823000000_wkh225_suspended_runs_down.sql',
);

describe('T-MIG · up migration (a2a_suspended_runs)', () => {
  const sql = readFileSync(UP, 'utf8');

  it('T-MIG-1: RLS deny-by-default, ENABLE ROW LEVEL SECURITY sin CREATE POLICY', () => {
    expect(sql).toMatch(
      /ALTER TABLE a2a_suspended_runs\s+ENABLE ROW LEVEL SECURITY;/,
    );
    expect(sql.toUpperCase()).not.toContain('CREATE POLICY');
    expect(sql).not.toContain('FORCE ROW LEVEL SECURITY');
  });

  it('T-MIG-2: CHECK del status con los 5 estados, `expired` incluido', () => {
    expect(sql).toContain(
      "CHECK (status IN ('suspended','resuming','resumed','failed','expired'))",
    );
  });

  it('T-MIG-3: token_hash UNIQUE (btree O(1), sin índice extra)', () => {
    expect(sql).toMatch(/token_hash\s+TEXT NOT NULL UNIQUE/);
    expect(sql).not.toMatch(
      /CREATE INDEX .* ON a2a_suspended_runs \(token_hash\)/,
    );
  });

  it('T-MIG-4: los 2 RPC son SECURITY DEFINER con FOR UPDATE + hardening', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION claim_suspended_run');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION settle_suspended_run');
    expect((sql.match(/SECURITY DEFINER/g) ?? []).length).toBe(2);
    // 2 SELECT ... FOR UPDATE; REALES (con el terminador `;`): los comentarios
    // mencionan "FOR UPDATE" sin punto y coma, y ésa es la trampa que el
    // exemplar de agent-links documenta.
    expect((sql.match(/FOR UPDATE;/g) ?? []).length).toBe(2);
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });

  it('T-RUN-2 (SQL): el claim levanta el MISMO literal en "no existe" y en "otro dueño"', () => {
    // AC-6: 404 disclosure-safe. Lo que lo hace disclosure-safe DE VERDAD es
    // que los dos caminos griten IDÉNTICO. Si uno dijera OWNERSHIP_MISMATCH, el
    // atacante aprendería que el run existe.
    expect(sql).toContain('v_owner IS DISTINCT FROM p_owner_ref');
    const claim = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION claim_suspended_run'),
      sql.indexOf('CREATE OR REPLACE FUNCTION settle_suspended_run'),
    );
    expect(claim.length).toBeGreaterThan(0);
    // Exactamente DOS raises de "no existe" dentro del claim: el de NOT FOUND y
    // el del dueño ajeno. Y ninguno de OWNERSHIP_MISMATCH.
    expect((claim.match(/RAISE EXCEPTION 'RUN_NOT_FOUND'/g) ?? []).length).toBe(
      2,
    );
    expect(claim).not.toContain('OWNERSHIP_MISMATCH');
    // ⛔ CD-8: el token NUNCA entra a un mensaje de error.
    expect(claim).not.toMatch(/RAISE EXCEPTION '[^']*', p_token_hash/);
  });

  /**
   * 🔴 FIX-PACK AR/BLQ-ALTO-1 — ESTE TEST SE REESCRIBIÓ ENTERO.
   * 🔴 FIX-PACK AR/MNR-9 — Y SU PARSER SE REESCRIBIÓ DE NUEVO. Ver abajo.
   *
   * Antes comparaba POSICIONES DE LITERALES en un string
   * (`marcaExpired > expiredGuard`, `raiseExpired > marcaExpired`): medía el
   * ORDEN DEL TEXTO, no la semántica, así que ninguna mutación transaccional
   * podía ponerlo rojo — y de hecho no lo puso, con el bug adentro.
   *
   * Lo que mide ahora es un INVARIANTE ESTRUCTURAL de PL/pgSQL, no una posición:
   *
   *   > Ninguna región que levante una excepción puede contener una escritura.
   *
   * Es exactamente el defecto: un `RAISE EXCEPTION` sin bloque `EXCEPTION` que
   * lo atrape aborta la transacción entera —y PostgREST corre cada `rpc()` en
   * una transacción propia—, así que toda escritura de esa región se DESCARTA.
   * El `UPDATE … SET status='expired'` que vivía dos líneas arriba del
   * `RAISE 'RUN_EXPIRED'` nunca commiteó ni una vez: verificado ejecutando la
   * migración contra un Postgres 16 real (tres claims seguidos sobre una fila
   * vencida ⇒ `suspended` las tres veces).
   *
   * ── POR QUÉ EL PARSER SE REESCRIBIÓ (AR/MNR-9) ────────────────────────────
   *
   * Acá decía que el control «generaliza: cazaría el mismo error re-introducido
   * en cualquier otra rama». Era FALSO, y el AR lo midió extrayendo el parser a
   * un script: de 4 variantes del `.sql`, DOS pasaban en verde con el defecto
   * adentro. El regex viejo era
   * `/^[ \t]*IF .*?THEN$[\s\S]*?^[ \t]*END IF;$/gm`:
   *
   *  · NO BALANCEABA. Al ser no-greedy, ante un `IF` anidado el bloque externo
   *    terminaba en el `END IF;` INTERNO, y el `RAISE` posterior quedaba afuera
   *    del match. Envolver el `UPDATE` en un `IF TRUE THEN … END IF;` bastaba
   *    para esconder el bug entero. Y el `IF` anidado no es hipotético: este
   *    mismo fix-pack introdujo uno, en `trigger_set_suspended_run_expires_at`.
   *  · SÓLO MIRABA BLOQUES `IF`. Un `UPDATE` + `RAISE` sueltos al nivel del
   *    cuerpo de la función —fuera de todo `IF`— eran invisibles.
   *
   * El parser de hoy (`regionesDe`) balancea `IF`/`END IF;` contando anidamiento
   * línea por línea, parte cada bloque en sus RAMAS reales (`ELSIF` / `ELSE` de
   * primer nivel), y devuelve TAMBIÉN el nivel superior del cuerpo como una
   * región más. Las dos variantes que se le escapaban están construidas abajo
   * como fixtures (`MUT-1`, `MUT-2`) y el test asserta que las MARCA: sin eso,
   * este docblock volvería a envejecer sin que nada se ponga rojo.
   *
   * ── LO QUE ESTE CONTROL SIGUE SIN PODER DECIR ─────────────────────────────
   *
   *  · ES TEXTO, no ejecución. Que la transición durable OCURRA lo mide
   *    `src/services/suspended-run.test.ts` (T-RUN-9), con un doble que descarta
   *    lo que la función escribió antes de levantar. Ninguno solo alcanza.
   *  · MIRA DOS FUNCIONES, las dos `SECURITY DEFINER` del claim/settle. La
   *    función del trigger NO se escanea (no levanta excepciones).
   *  · ES CONSERVADOR CON LO ANIDADO, a propósito: la rama externa incluye el
   *    texto de sus bloques internos, así que un `RAISE` en un `ELSE` anidado
   *    marca una escritura de la rama externa aunque en runtime no la pise. Se
   *    eligió el falso positivo sobre el falso negativo — es la asimetría que
   *    dejó pasar el BLOQUEANTE. Si aparece uno, se declara acá.
   *  · IGNORA LOS COMENTARIOS `--` (se stripean antes de parsear): si no, la
   *    prosa que menciona un `UPDATE` o un `RAISE` movería el veredicto, que es
   *    justo el modo de falla que este archivo persigue.
   *  · `FOR UPDATE` NO ES ESCRITURA: es cláusula de lock del `SELECT`, y se
   *    borra antes de buscar DML. Un `EXECUTE 'UPDATE …'` sí queda cazado.
   */
  it('T-MIG-5: ninguna región que levante una excepción ESCRIBE (lo escrito se rollbackea)', () => {
    const cuerpoDe = (nombre: string): string => {
      const desde = sql.indexOf(`CREATE OR REPLACE FUNCTION ${nombre}`);
      expect(desde).toBeGreaterThan(-1);
      const hasta = sql.indexOf('$$ LANGUAGE plpgsql SECURITY DEFINER;', desde);
      expect(hasta).toBeGreaterThan(desde);
      return sql.slice(desde, hasta);
    };

    /**
     * Parte un cuerpo PL/pgSQL en sus regiones de flujo recto: una por cada
     * RAMA de cada bloque `IF` de primer nivel (el `THEN`, cada `ELSIF` y el
     * `ELSE` son regiones distintas — no comparten destino transaccional), más
     * el nivel superior del cuerpo como una región propia.
     *
     * El anidamiento se CUENTA (`profundidad`), no se adivina: las líneas de un
     * `IF` interno se acumulan dentro de la rama externa que las contiene, que
     * es lo semánticamente correcto —un `RAISE` adentro rollbackea lo que la
     * rama externa escribió antes— y lo que el regex viejo no hacía.
     */
    const regionesDe = (cuerpoCrudo: string): string[] => {
      const cuerpo = cuerpoCrudo.replace(/--[^\n]*/g, '');
      const ABRE = /^[ \t]*IF\b.*\bTHEN[ \t]*$/;
      const CIERRA = /^[ \t]*END IF;/;
      const OTRA_RAMA = /^[ \t]*(ELSIF\b.*\bTHEN|ELSE)[ \t]*$/;

      const regiones: string[] = [];
      const nivelSuperior: string[] = [];
      let rama: string[] = [];
      let profundidad = 0;

      for (const linea of cuerpo.split('\n')) {
        if (ABRE.test(linea)) {
          if (profundidad === 0) rama = [];
          else rama.push(linea);
          profundidad += 1;
          continue;
        }
        if (CIERRA.test(linea)) {
          profundidad -= 1;
          if (profundidad === 0) regiones.push(rama.join('\n'));
          else rama.push(linea);
          continue;
        }
        if (profundidad === 1 && OTRA_RAMA.test(linea)) {
          regiones.push(rama.join('\n'));
          rama = [];
          continue;
        }
        if (profundidad === 0) nivelSuperior.push(linea);
        else rama.push(linea);
      }
      // Si esto falla, el `.sql` tiene un `IF`/`END IF;` desbalanceado o una
      // forma que el parser no reconoce: se ROMPE en vez de quedar vacuo.
      expect(profundidad).toBe(0);
      regiones.push(nivelSuperior.join('\n'));
      return regiones;
    };

    const DML = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/;
    const escribe = (region: string): boolean =>
      DML.test(region.replace(/\bFOR\s+UPDATE\b/g, ''));

    /** Las regiones que levantan Y escriben. Vacío = invariante intacto. */
    const infractoras = (cuerpo: string): string[] =>
      regionesDe(cuerpo).filter(
        (r) => r.includes('RAISE EXCEPTION') && escribe(r),
      );

    for (const nombre of ['claim_suspended_run', 'settle_suspended_run']) {
      const cuerpo = cuerpoDe(nombre);
      const regiones = regionesDe(cuerpo);
      expect(regiones.length).toBeGreaterThan(0);
      // Anti-vacuidad: si un cambio de forma volviera invisibles las regiones
      // que levantan, este control se rompe en vez de aplaudir en silencio.
      const queLevantan = regiones.filter((r) =>
        r.includes('RAISE EXCEPTION'),
      );
      expect(queLevantan.length).toBeGreaterThan(0);
      expect(
        infractoras(cuerpo),
        `${nombre}: una región que hace RAISE tambien ESCRIBE; el RAISE la ` +
          `rollbackea y la escritura no ocurre nunca`,
      ).toEqual([]);
    }

    // ── EL CONTROL DEL CONTROL (AR/MNR-9) ────────────────────────────────
    // Las DOS formas que el parser viejo dejaba pasar en verde, con el mismo
    // defecto adentro. Si alguien vuelve a simplificar `regionesDe`, estas dos
    // se ponen rojas ANTES de que el `.sql` real las necesite.
    const MUT_1 = [
      'BEGIN',
      "  IF v_status = 'suspended' AND NOW() >= v_expires THEN",
      '    IF TRUE THEN',
      "      UPDATE a2a_suspended_runs SET status = 'expired' WHERE id = v_id;",
      '    END IF;',
      "    RAISE EXCEPTION 'RUN_EXPIRED';",
      '  END IF;',
      'END;',
    ].join('\n');
    const MUT_2 = [
      'BEGIN',
      "  UPDATE a2a_suspended_runs SET status = 'expired' WHERE id = v_id;",
      "  RAISE EXCEPTION 'RUN_EXPIRED';",
      'END;',
    ].join('\n');
    expect(infractoras(MUT_1)).toHaveLength(1); // `IF` anidado
    expect(infractoras(MUT_2)).toHaveLength(1); // fuera de todo `IF`
  });

  it('T-MIG-14 (fix-pack AR/BLQ-ALTO-1): el claim NO transiciona a `expired`, y `expired` levanta RUN_EXPIRED', () => {
    const claim = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION claim_suspended_run'),
      sql.indexOf('CREATE OR REPLACE FUNCTION settle_suspended_run'),
    );
    // El ÚNICO escritor de `expired` es el UPDATE condicional del service. Si
    // esta línea vuelve al `.sql`, la transición se vuelve inalcanzable otra vez.
    expect(claim).not.toContain("SET status = 'expired'");
    // Y un run YA registrado como vencido tiene que dar el MISMO desenlace que
    // la primera vez: 410, no un 409 «ya usado».
    expect(claim).toContain("IF v_status = 'expired' THEN");
    expect((claim.match(/RAISE EXCEPTION 'RUN_EXPIRED'/g) ?? []).length).toBe(2);
    // El guard genérico sigue existiendo, y DESPUÉS de los dos de vencimiento.
    expect(claim.indexOf("IF v_status <> 'suspended' THEN")).toBeGreaterThan(
      claim.lastIndexOf("RAISE EXCEPTION 'RUN_EXPIRED'"),
    );
  });

  it('T-MIG-15 (fix-pack AR/MNR-7): el settle no interpola el id del run en su error', () => {
    const settle = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION settle_suspended_run'),
    );
    expect(settle).toContain("RAISE EXCEPTION 'OWNERSHIP_MISMATCH';");
    expect(settle).not.toMatch(/RAISE EXCEPTION '[^']*', p_id/);
  });

  it('T-MIG-16 (fix-pack AR/BLQ-MED-1): la columna del techo del caller existe y viaja en el claim', () => {
    expect(sql).toContain(
      'max_budget_usdc          NUMERIC(20,8) CHECK (max_budget_usdc >= 0)',
    );
    // Nullable a propósito: el caller que no declara techo es el caso normal.
    expect(sql).not.toContain('max_budget_usdc          NUMERIC(20,8) NOT NULL');
    // Y con `::text` (WKH-196), igual que el costo — fix-pack AR/MNR-3.
    expect(sql).toContain('max_budget_usdc    TEXT,');
    expect(sql).toContain('total_cost_usdc    TEXT,');
    expect(sql).toContain('r.total_cost_usdc::text, r.max_budget_usdc::text,');
  });

  /**
   * Fix-pack AR/MNR-4. Verificado ejecutando contra Postgres 16: con
   * `frozen_prices_expires_at = now() - 5 min` y `ttl_seconds = 3600`, el INSERT
   * dejaba `expires_at < created_at` — el caller recibía un 202 con un token
   * irredimible DESPUÉS de que el step ya había cobrado.
   *
   * ⚠️ Esto es TEXTO: lee que el guard esté escrito. Que el trigger produzca
   * `nace_vencido = f` se midió a mano contra Postgres 16; no hay Postgres en
   * esta suite.
   */
  it('T-MIG-17 (fix-pack AR/MNR-4): una fila no puede NACER vencida', () => {
    expect(sql).toContain('IF NEW.frozen_prices_expires_at > now() THEN');
    // La rama del else NO acorta el vencimiento: DESCARTA los precios
    // congelados, porque una garantía ya vencida no puede debitarse (CD-15).
    expect(sql).toContain('NEW.frozen_step_prices       := NULL;');
    expect(sql).toContain('NEW.frozen_prices_expires_at := NULL;');
  });

  it('T-MIG-6: el status-gate exactly-once del settle', () => {
    expect(sql).toContain("IF v_status <> 'resuming' THEN");
  });

  it('T-MIG-7 (CD-19): `expires_at` lo escribe POSTGRES, y `Date.now` no aparece', () => {
    expect(sql).toContain(
      'NEW.expires_at := now() + make_interval(secs => NEW.ttl_seconds)',
    );
    expect(sql).toContain('BEFORE INSERT ON a2a_suspended_runs');
    // La LECTURA compara los dos lados contra el reloj de Postgres.
    expect(sql).toContain('NOW() >= v_expires');
    // Y no hay ni un solo reloj de Node en todo el archivo.
    expect(sql).not.toContain('Date.now');
    expect(sql).not.toContain('new Date(');
  });

  it('T-MIG-8 (CD-15): el LEAST contra el vencimiento del quote se toma en Postgres', () => {
    expect(sql).toContain('frozen_prices_expires_at');
    expect(sql).toContain(
      'NEW.expires_at := LEAST(NEW.expires_at, NEW.frozen_prices_expires_at)',
    );
  });

  it('T-MIG-9 (CD-17): las 3 columnas de la traza anti-bucle existen', () => {
    // Sin ellas la reanudación arrancaría con profundidad 0 y conjunto de
    // identidad vacío, o sea un bypass del guard que esta HU abriría.
    expect(sql).toMatch(/contracting_chain\s+JSONB/);
    expect(sql).toMatch(/contracting_depth\s+INT NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/self_host_hint\s+TEXT/);
  });

  it('T-MIG-10: el rango del TTL lo hace cumplir la BASE', () => {
    expect(sql).toContain('CHECK (ttl_seconds BETWEEN 181 AND 86400)');
  });

  it('T-MIG-11: la fila apunta a una key real y se va con ella', () => {
    expect(sql).toContain(
      'key_id                   UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE',
    );
    expect(sql).toContain(
      "caller_kind              TEXT NOT NULL CHECK (caller_kind IN ('key','session','delegation'))",
    );
  });
});

describe('T-MIG · down migration (a2a_suspended_runs)', () => {
  const sql = readFileSync(DOWN, 'utf8');

  it('T-MIG-12: DROP FUNCTION con tipos exactos + DROP TABLE en BEGIN;…COMMIT;', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS settle_suspended_run(uuid, text, text, text);',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS claim_suspended_run(text, text);',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS trigger_set_suspended_run_expires_at();',
    );
    expect(sql).toContain('DROP TABLE IF EXISTS a2a_suspended_runs;');
  });

  it('T-MIG-13: NO dropea `trigger_set_updated_at`, que es compartida', () => {
    // Es la misma función que usan a2a_agent_links y a2a_payment_intents:
    // dropearla acá se llevaría puesto el `updated_at` de otras dos tablas.
    expect(sql).not.toContain('DROP FUNCTION IF EXISTS trigger_set_updated_at');
  });
});
