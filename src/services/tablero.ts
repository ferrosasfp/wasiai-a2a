/**
 * WKH-365 — el tablero de las tres preguntas. SOLO LECTURA.
 *
 * Contesta tres cosas que hoy se averiguan a mano: cuánta caja le queda a la
 * key de la sonda del money-path, qué standing tiene cada agente con actividad
 * reciente, y cuánta plata sigue trabada en escrows de Solana devnet.
 *
 * ⛔ NO cotiza y NO compra. La sonda compra; el tablero mira. Un tablero que
 * cotizara duplicaría el gasto y podría dar verde justo cuando la sonda da rojo.
 *
 * ⚠️ POR QUÉ LA CAJA SE LEE EN PROCESO Y NO POR HTTP CONTRA `GET /auth/me`:
 * llamarse a sí mismo por HTTP exigiría tener en el entorno una `A2A_PROBE_KEY`,
 * que es una credencial DE GASTO. Con la fila leída directo, "el tablero no
 * gasta" deja de ser una promesa que sostiene la revisión de código y pasa a ser
 * una CAPACIDAD AUSENTE del entorno: el proceso no tiene con qué gastar aunque
 * alguien escriba el código que lo intente.
 *
 * ⚠️ "No sé" nunca se disfraza de "está bien". Cada tarjeta es una unión
 * discriminada, y la rama sana es inconstruible sin los datos.
 */

import { scanEscrows } from '../adapters/solana/escrow-scan.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import type {
  TableroAgenteStanding,
  TableroCajaCard,
  TableroEscrowsCard,
  TableroReputacionCard,
  TableroSnapshot,
} from '../types/index.js';
import { reputationService } from './reputation.js';

const log = getLogger('tablero');

/**
 * Ventana de actividad de la que sale el UNIVERSO de agentes.
 *
 * ⚠️ La ventana NO acota los contadores de cada fila: los produce
 * `computeStandingBatch`, que mira todo el historial del slug sin filtro de
 * fecha. Rotular la tabla como "ventana: 30 días" —que es lo que la pantalla
 * hacía— presentaba números históricos como actividad reciente.
 *
 * ⚠️ Y la ventana tampoco es lo único que recorta QUIÉNES entran: los dos
 * techos de acá abajo también. Por eso la tarjeta viaja con `agentes_omitidos`
 * y `lectura_truncada` — sin ellos la pantalla no tiene con qué distinguir
 * "esto es todo" de "esto es lo que entró".
 */
const VENTANA_DIAS = 30;
const VENTANA_LABEL = 'últimos 30 días';
/**
 * Techo de filas que se traen de `a2a_events` para derivar el universo.
 *
 * ⛔ Este techo se llenaba de TELEMETRÍA. `middleware/event-tracking.ts` mete
 * una fila por cada request a los prefijos que rastrea (su lista está ahí, y
 * este archivo no puede nombrarlos: hay un test que le prohíbe al tablero
 * nombrar operaciones que gastan), y esa fila va con `agent_id` en
 * NULL. Por eso la query filtra `agent_id not is null`: el techo tiene que
 * gastarse en filas que puedan aportar un agente.
 *
 * Medido contra bdwv el 2026-08-25, ventana de 30 días (FOTO: se re-deriva
 * corriendo las dos cadenas, no se hereda de este párrafo): 2.011 filas con
 * `agent_id` NULL contra 481 con agente. La cadena sin filtro tocaba el techo
 * —leía 1.000 filas y de ahí salían 5 agentes— y dejaba afuera, en silencio, a
 * `remit-kyc-validator`. Con el filtro se leen las 481 filas con agente, salen
 * los 6, y la lectura ni siquiera llega al techo.
 */
const EVENTOS_LIMITE = 1000;
/** Techo de agentes que se le piden al batch de standing. */
const SLUGS_LIMITE = 50;

function envValue(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Tarjeta 1 — la caja de la sonda, leída de `a2a_agent_keys`.
 *
 * ⛔ El filtro por `owner_ref` NO es opcional (regla de ownership del
 * CLAUDE.md): el cliente de Supabase usa la service key y bypassea RLS. El par
 * id + owner_ref además se auto-chequea — si no casan, PostgREST devuelve cero
 * filas (`PGRST116`) y la tarjeta sale "no encontrada", nunca el saldo de otro
 * dueño.
 *
 * ⛔ El `select` NO pide `id` ni `key_hash`: la prohibición de exponer un
 * identificador de la credencial se cumple en la query, no en el serializador.
 */
export async function leerCajaDeLaSonda(): Promise<TableroCajaCard> {
  const keyId = envValue('A2A_PROBE_KEY_ID');
  const ownerRef = envValue('A2A_PROBE_KEY_OWNER_REF');
  if (keyId === null || ownerRef === null) {
    return { status: 'sin_dato', reason: 'no_configurado' };
  }

  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select(
      'budget, daily_limit_usd, daily_spent_usd, daily_reset_at, is_active',
    )
    .eq('id', keyId)
    .eq('owner_ref', ownerRef)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return { status: 'sin_dato', reason: 'no_encontrada' };
    }
    log.error(
      { code: error.code },
      'tablero: la caja de la sonda no se pudo leer',
    );
    return { status: 'sin_dato', reason: 'error_db' };
  }
  if (data === null) {
    return { status: 'sin_dato', reason: 'no_encontrada' };
  }

  return {
    status: 'ok',
    // M9 (patrón del repo): narrowing acotado SOLO al campo jsonb.
    budget: (data.budget ?? {}) as Record<string, string>,
    daily_limit_usd: data.daily_limit_usd,
    daily_spent_usd: data.daily_spent_usd,
    daily_reset_at: data.daily_reset_at,
    // `false` es un DATO (key desactivada con saldo), no una ausencia.
    is_active: data.is_active,
  };
}

/**
 * Tarjeta 2 — el standing de los agentes con actividad reciente.
 *
 * Cero lógica de reputación nueva: el universo sale de `a2a_events` y los
 * contadores de `reputationService.computeStandingBatch`, que YA distingue
 * `degraded` ("no pude preguntar por el historial") de "cero historial". Ése ES
 * el "sin dato" de esta tarjeta.
 *
 * El universo se deriva de `a2a_events` y no del discovery a propósito: el
 * discovery puede salir a registries remotos, y esta pantalla no hace red
 * saliente.
 */
export async function leerReputacion(): Promise<TableroReputacionCard> {
  const desde = new Date(
    Date.now() - VENTANA_DIAS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from('a2a_events')
    .select('agent_id')
    // ⛔ NO es cosmético: sin este filtro el techo se lo come la telemetría sin
    // agente (ver el docblock de EVENTOS_LIMITE).
    .not('agent_id', 'is', null)
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .limit(EVENTOS_LIMITE);

  if (error) {
    log.error(
      { code: error.code },
      'tablero: el universo de agentes no se pudo leer',
    );
    return { status: 'sin_dato', reason: 'historial_ilegible' };
  }

  const filas = data ?? [];
  // Se leyeron TODAS las filas que había, o se cortó en el techo. En el segundo
  // caso no se sabe si quedó actividad afuera: lo único afirmable es el corte.
  const lecturaTruncada = filas.length >= EVENTOS_LIMITE;

  const slugs: string[] = [];
  const vistos = new Set<string>();
  for (const row of filas) {
    const slug = row.agent_id;
    if (slug === null || vistos.has(slug)) continue;
    vistos.add(slug);
    // Sin `break`: los slugs que no entran igual se CUENTAN. Cortar el barrido
    // acá era lo que hacía indistinguible "50 y no hay más" de "50 de 300".
    if (slugs.length < SLUGS_LIMITE) slugs.push(slug);
  }

  const { degraded, standings } =
    await reputationService.computeStandingBatch(slugs);
  if (degraded) {
    // "No pude preguntar" NO es "cero reputación".
    return { status: 'sin_dato', reason: 'historial_ilegible' };
  }

  const agentes: TableroAgenteStanding[] = [];
  for (const slug of slugs) {
    const counters = standings.get(slug);
    if (counters === undefined) continue;
    agentes.push({
      // ⚠️ `tasksSettled` es el contador anti-Sybil CAPEADO POR CALLER, no la
      // cuenta de tasks liquidadas: cada caller aporta a lo sumo K. Una sonda
      // que llama todos los días desde UNA key lo satura en K y lo deja clavado
      // mientras `successCount` sigue subiendo. Se publica con ese nombre
      // porque es el nombre del contador de `reputation.ts` (Scope OUT, y su
      // semántica es la correcta); quien rotula la columna es la pantalla, y
      // tiene que decir el tope.
      slug,
      tasksSettled: counters.tasksSettled,
      successCount: counters.successCount,
      failedCount: counters.failedCount,
    });
  }

  // Lista vacía con `degraded: false` es una RESPUESTA ("no hubo actividad en la
  // ventana"), y por eso sale `ok`. No colapsa con el caso de arriba.
  return {
    status: 'ok',
    agentes,
    ventana: VENTANA_LABEL,
    // Contra `agentes.length` y no contra `slugs.length`: acá se cuenta lo que
    // la pantalla NO muestra, y un slug que el batch no devolvió tampoco se
    // muestra.
    agentes_omitidos: vistos.size - agentes.length,
    lectura_truncada: lecturaTruncada,
  };
}

/**
 * Tarjetas que el caller ya tiene frescas y NO quiere volver a leer.
 *
 * Existe por la tarjeta 3: si el RPC de Solana viene devolviendo 429, volver a
 * consultarlo en cada request es carga sobre lo que ya está saturado. El cache
 * vive en el caller (el plugin de rutas); acá sólo se respeta lo que trae.
 */
export interface TableroCachedCards {
  caja?: TableroCajaCard;
  reputacion?: TableroReputacionCard;
  escrows?: TableroEscrowsCard;
}

export const tableroService = {
  /**
   * Las tres preguntas juntas.
   *
   * `Promise.allSettled` y no `Promise.all`: una fuente caída no puede llevarse
   * puestas las otras dos. Un rechazo se traduce a la rama "sin dato" de esa
   * tarjeta con el motivo más cercano, así que la respuesta HTTP sigue siendo
   * 200 con las tres tarjetas presentes.
   */
  async snapshot(cached: TableroCachedCards = {}): Promise<TableroSnapshot> {
    const [caja, reputacion, escrows] = await Promise.allSettled([
      cached.caja === undefined
        ? leerCajaDeLaSonda()
        : Promise.resolve(cached.caja),
      cached.reputacion === undefined
        ? leerReputacion()
        : Promise.resolve(cached.reputacion),
      cached.escrows === undefined
        ? scanEscrows()
        : Promise.resolve(cached.escrows),
    ]);

    if (caja.status === 'rejected') {
      log.error({}, 'tablero: la lectura de la caja lanzó');
    }
    if (reputacion.status === 'rejected') {
      log.error({}, 'tablero: la lectura de reputación lanzó');
    }
    if (escrows.status === 'rejected') {
      log.error({}, 'tablero: el barrido de escrows lanzó');
    }

    return {
      // ⚠️ `servedAt`, NO `generatedAt`: es el momento en que se armó ESTA
      // respuesta, y las tarjetas que llegaron por `cached` no se leyeron acá.
      // Con las tres en cache el sello decía "ahora" sobre datos de hasta un
      // TTL de antigüedad — un dato viejo presentado como fresco, que es la
      // clase de mentira que esta HU existe para evitar.
      servedAt: new Date().toISOString(),
      caja:
        caja.status === 'fulfilled'
          ? caja.value
          : { status: 'sin_dato', reason: 'error_db' },
      reputacion:
        reputacion.status === 'fulfilled'
          ? reputacion.value
          : { status: 'sin_dato', reason: 'historial_ilegible' },
      escrows:
        escrows.status === 'fulfilled'
          ? escrows.value
          : { status: 'sin_dato', reason: 'rpc_error' },
    };
  },
};
