/**
 * WKH-313 — La POLÍTICA del carril de estreno (*trial standing*), en un solo lugar.
 *
 * Un agente que nunca trabajó no tiene score (`computeFromAccumulator` devuelve
 * `null` con 0 liquidadas), así que el fail-safe del filtro de `minReputation` lo
 * cuenta 0 y lo excluye con cualquier piso > 0. Este módulo define, y define UNA
 * SOLA VEZ (CD-8), bajo qué condiciones ese agente puede ser admitido igual:
 *
 *   · el que consulta lo pidió (`allowTrial` / `constraints.allow_trial`);
 *   · no falló nunca (`failedCount === 0` — CD-14: el primer fallo ANULA el
 *     carril, no lo decrementa);
 *   · todavía está dentro del carril (`tasksSettled < N`);
 *   · el piso pedido no supera el techo (`min <= T`);
 *   · su publicador no agotó su cupo (`M` agentes en estreno por ancla).
 *
 * ⚠️ EL ADMITIDO NO RECIBE SCORE FABRICADO. Conserva su puntaje real (0, o el
 * real bajo) y por eso ordena ÚLTIMO: sólo puede ser elegido cuando NINGÚN
 * agente pasa por mérito. Eso es lo que hace que el carril no sea un atajo.
 *
 * Ese "ordena ÚLTIMO" NO sale gratis y NO vive acá: el ranking lee `verified` y,
 * sin score computado, cae al `reputation` del card — los dos AUTO-REPORTADOS por
 * el agente. `services/discovery.ts` (bloque del badge) los neutraliza para el
 * admitido; sin eso la garantía es falsa para todo agente federado (AR fix-pack
 * BLQ-ALTO-1).
 *
 * Módulo LEAF a propósito (sin imports de `services/` ni de `lib/supabase.js`),
 * por el mismo motivo documentado en `lib/discovery-query.ts:1-10`: los tests de
 * rutas mockean el service completo y cualquier export nuevo que la ruta consuma
 * quedaría `undefined`.
 */

import type {
  AgentStandingBatch,
  AgentStandingCounters,
  AgentStandingKind,
} from '../types/index.js';
// AR fix-pack BLQ-MED-3: el SORTEO del cupo reusa la MISMA fuente inyectable que
// el desempate del ranking (HU-208). Módulo LEAF también, así que no rompe la
// razón por la que este archivo es leaf.
import { assignTiebreaks, compareTiebreak } from './ranking-tiebreak.js';

// ── N, T y M — env con default (DT-8) ───────────────────────────────────
//
// Patrón `resolveScaleFactor` (`services/reputation.ts:36-40`): `parseInt` +
// `Number.isFinite(n) && n > 0 ? n : default`.
//
// ⚠️ DIFERENCIA DELIBERADA con el riesgo que este patrón suele traer: acá el
// default es el valor CONSERVADOR, nunca el permisivo. Una env que falta NO
// apaga el control (si `M` cayera a 0 o `T` a `Infinity` por una env mal
// escrita, el control se desactivaría en silencio).
//
// ⚠️ LOS TRES VALORES SON PROVISORIOS: son la propuesta del SDD §5, marcada
// `[DECIDE FOUNDER]`, y siguen SIN RATIFICAR al 2026-07-29. Ratificarlos es
// cambiar un número de config, no código — por eso son env y no constantes.

/** `N` — liquidadas pagas que dura el estreno. Default **3** (PROVISORIO). */
export function resolveTrialMaxSettledTasks(): number {
  const raw = process.env.TRIAL_MAX_SETTLED_TASKS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/** `T` — piso máximo bajo el cual aplica el estreno. Default **10** (PROVISORIO). */
export function resolveTrialMaxMinReputation(): number {
  const raw = process.env.TRIAL_MAX_MIN_REPUTATION;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** `M` — agentes en estreno por publicador. Default **2** (PROVISORIO). */
export function resolveTrialMaxAgentsPerPublisher(): number {
  const raw = process.env.TRIAL_MAX_AGENTS_PER_PUBLISHER;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 2;
}

// ── Clasificación (pura) ────────────────────────────────────────────────

/**
 * Clasifica un standing a partir de sus contadores. Función PURA.
 *
 *   `scored`    ⟺ `tasksSettled >= N`  → fuera del carril, mérito puro
 *   `penalized` ⟺ `failedCount >= 1` y `tasksSettled < N`  → carril ANULADO
 *   `newcomer`  ⟺ `failedCount === 0` y `tasksSettled < N` → elegible
 *
 * El orden importa: `scored` se evalúa PRIMERO porque un agente que ya salió del
 * carril por éxito no vuelve a entrar por haber tenido un fallo — su historial ya
 * lo juzga su score real, que es el comportamiento de hoy y no se toca.
 *
 * "Sin historial" y "mal historial" son estados DISTINTOS (CD-14): el que arrancó
 * y entregó mal ya tuvo su oportunidad.
 */
export function classifyStanding(
  c: AgentStandingCounters,
  n: number = resolveTrialMaxSettledTasks(),
): AgentStandingKind {
  if (c.tasksSettled >= n) return 'scored';
  if (c.failedCount >= 1) return 'penalized';
  return 'newcomer';
}

/**
 * EL ÚNICO predicado de admisión al carril (CD-8). Lo usan los CUATRO
 * consumidores: el filtro de `minReputation`, el contador `trialAvailable`, el
 * badge `trial` y la preselección del cupo. Si alguno escribiera su propia
 * versión, divergirían sin que nadie se enterara — que es exactamente el bug que
 * el auto-blindaje de HU-208 documenta (el refund del step-0 que calculaba el
 * débito por su cuenta).
 *
 * Acepta `'unknown'` a propósito (concreción sobre la firma del Story File §3.3,
 * marcada para AR): así el caso FAIL-CLOSED de CD-7 vive DENTRO del único
 * predicado y ningún call-site puede olvidarse de consultarlo. Si `'unknown'`
 * quedara afuera, los cuatro consumidores tendrían que repetir
 * `st !== 'unknown' && …`, o sea cuatro copias parciales del predicado.
 *
 * `min > T` ⟹ `false`: el que pide un piso alto está pidiendo un agente probado
 * (con `K = 5`, un solo cliente no lleva a nadie más allá de 10), y el carril no
 * lo finge.
 */
export function isTrialEligible(
  c: AgentStandingCounters | 'unknown',
  min: number,
  n: number = resolveTrialMaxSettledTasks(),
  t: number = resolveTrialMaxMinReputation(),
): boolean {
  // CD-7: "no pude preguntar por el historial" NO es "no tiene historial".
  if (c === 'unknown') return false;
  if (min > t) return false;
  return classifyStanding(c, n) === 'newcomer';
}

/**
 * Lee el standing de un slug del batch, con la distinción que CD-7 exige y que
 * un `standings.get(slug)` crudo PIERDE:
 *
 *   · `degraded === true`  ⟹ `'unknown'`  — la lectura falló. No autoriza nada,
 *     ni para este slug ni para ninguno.
 *   · `degraded === false` y el slug NO está en el Map ⟹ contadores en CERO. Un
 *     agente sin ninguna fila en `a2a_events` es un `newcomer` LEGÍTIMO.
 *
 * La regla se escribe UNA vez, acá. PROHIBIDO leer `batch.standings.get(slug)`
 * crudo en el filtro (o en cualquier consumidor de la política): ese es
 * literalmente el defecto de clase que HU-307 pagó siete veces.
 */
export function standingFor(
  slug: string,
  batch: AgentStandingBatch,
): AgentStandingCounters | 'unknown' {
  if (batch.degraded) return 'unknown';
  return (
    batch.standings.get(slug) ?? {
      tasksSettled: 0,
      successCount: 0,
      failedCount: 0,
      reputation: null,
    }
  );
}

// ── Cupo M por publicador (determinista — CD-15) ────────────────────────

/** Candidato al cupo. El `anchor` es el ancla de publicación, NUNCA se surfacea. */
export interface TrialCandidate {
  slug: string;
  /**
   * Ancla de publicación: `a2a_agents.owner_ref` para self-published,
   * `registry_id` para federados. Se usa para CONTAR, no para publicar (CD-10).
   *
   * ⚠️ ASIMETRÍA REAL, y hay que decirla (AR fix-pack BLQ-MED-3): para un agente
   * federado NO TENEMOS al publicador. El catálogo remoto no expone quién subió
   * cada card, así que el ancla más fina disponible es el registry ENTERO. Un
   * registry con 10 publicadores honestos reparte `M` cupos entre los 10, o sea que
   * el control sub-admite. Se elige esa dirección a propósito: la alternativa
   * (ancla por card, o sin cupo para federados) le devolvería a un sybil la
   * capacidad de inundar el carril publicando en un registry federado, que es
   * justamente el ataque que el cupo existe para frenar. Residual documentado.
   */
  anchor: string;
  /**
   * `a2a_agents.created_at`. Ausente para agentes federados (el shape `Agent` no
   * trae `created_at`): ahí el orden dentro del ancla lo decide el SORTEO por
   * request, NUNCA el `slug` (ver `selectTrialAdmitted`).
   */
  createdAt?: string | undefined;
}

/**
 * Aplica el cupo `M` por publicador: dentro de cada ancla retienen el estreno los
 * `M` candidatos más antiguos por `created_at`, y cuando no hay `created_at`
 * comparable, los `M` que salgan sorteados en ESTA request.
 *
 * ── Orden dentro de un ancla ────────────────────────────────────────────────
 *   1. `created_at` ascendente, cuando LOS DOS lo tienen (self-published: el dato
 *      sale de nuestra propia tabla y "el que llegó primero" es una política
 *      legítima de reparto);
 *   2. el que TIENE fecha antes que el que no la tiene;
 *   3. SORTEO (`lib/ranking-tiebreak.ts`, fuente inyectable), asignado UNA vez por
 *      candidato ANTES de ordenar;
 *   4. `slug` ascendente como último recurso, sólo para que la relación de orden
 *      sea TOTAL si dos sorteos empatan exactamente (inalcanzable en la práctica
 *      con `Math.random`; un comparador que devuelve 0 dejaría decidir al orden del
 *      arreglo, que es lo que CD-15 prohíbe).
 *
 * ⚠️ POR QUÉ EL SORTEO REEMPLAZA AL `slug` (AR fix-pack BLQ-MED-3). El SDD escribió
 * "PROHIBIDO el tiebreak aleatorio" pensando en el orden del ARREGLO; el efecto real
 * fue peor. Todo agente federado entra sin `created_at`, así que el desempate caía
 * SIEMPRE en `slug` ascendente: un registry con 20 agentes nuevos de 10 publicadores
 * distintos repartía 2 cupos, y se los llevaban de forma PERMANENTE los dos slugs
 * lexicográficamente menores. Bastaba llamarse `aaa-payout-1` para quedarse con el
 * carril, y a los otros 18 no les quedaba ninguna corrida en la que entrar: un
 * bloqueo barato y permanente justo del caso que motiva la HU (oferta nueva llegando
 * por el marketplace federado).
 *
 * Un desempate FIJO cualquiera (hash del slug incluido) tiene el mismo defecto: es
 * una permutación estable, o sea que se puede moler el nombre hasta caer arriba y el
 * que cae abajo no entra nunca. Lo que hay que romper no es el criterio, es su
 * PERMANENCIA. El sorteo le da a cada elegible del ancla la misma chance en cada
 * request, que es exactamente el argumento con el que HU-208 sacó el sesgo
 * posicional del ranking ("dos agentes empatados merecen la misma chance").
 *
 * Sigue siendo DETERMINISTA donde CD-15 lo necesitaba: el valor se asigna una sola
 * vez por candidato y antes de ordenar, así que el orden es total y estable DENTRO de
 * la request (dos steps de la misma capability resuelven al mismo agente), y el orden
 * del arreglo no decide nada. Lo que cambia entre requests distintas es QUIÉN de los
 * empatados entra, que es la propiedad que se busca.
 *
 * Por qué el cupo existe: hoy `remittance-payout` no tiene NINGÚN agente con
 * score, así que dos candidatos en estreno empatan en 0 y el desempate del sort
 * es ALEATORIO. Un sybil que publique la misma capability tendría ~50% de
 * quedarse con el `depositAddress` contra el que el usuario firma el principal de
 * la remesa. Sin cupo, la ventana de robo sale más barata que la remesa que roba.
 */
export function selectTrialAdmitted(
  cands: TrialCandidate[],
  m: number = resolveTrialMaxAgentsPerPublisher(),
): Set<string> {
  const byAnchor = new Map<string, TrialCandidate[]>();
  for (const c of cands) {
    let group = byAnchor.get(c.anchor);
    if (!group) {
      group = [];
      byAnchor.set(c.anchor, group);
    }
    group.push(c);
  }

  // UNA sola asignación para todos los candidatos, antes de cualquier `sort`.
  const draw = assignTiebreaks(cands);

  const admitted = new Set<string>();
  for (const group of byAnchor.values()) {
    const ordered = [...group].sort((a, b) => {
      const aCreated = a.createdAt;
      const bCreated = b.createdAt;
      if (aCreated !== undefined && bCreated !== undefined) {
        if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
      } else if (aCreated !== undefined) {
        return -1;
      } else if (bCreated !== undefined) {
        return 1;
      }
      const drawn = compareTiebreak(draw, a, b);
      if (drawn !== 0) return drawn;
      if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
      return 0;
    });
    for (const c of ordered.slice(0, m)) admitted.add(c.slug);
  }
  return admitted;
}
