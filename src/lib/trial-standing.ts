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
   */
  anchor: string;
  /**
   * `a2a_agents.created_at`. Ausente para agentes federados (el shape `Agent` no
   * trae `created_at`), en cuyo caso el orden lo decide el `slug` — determinista
   * igual, y su ancla es el `registry_id`, así que sólo compite contra agentes
   * del MISMO registry.
   */
  createdAt?: string | undefined;
}

/**
 * Aplica el cupo `M` por publicador: dentro de cada ancla retienen el estreno los
 * `M` candidatos MÁS ANTIGUOS por `created_at`.
 *
 * ⚠️ DETERMINISTA POR CONTRATO (CD-15). PROHIBIDO resolverlo por el orden del
 * arreglo (que sale de cómo se concatenaron las fuentes en `discovery.ts`) y
 * PROHIBIDO el tiebreak aleatorio de `lib/ranking-tiebreak.ts`.
 *
 * El desempate final por `slug` ascendente NO es decorativo: dos filas pueden
 * tener el MISMO `created_at`, y sin él el orden del arreglo volvería a decidir
 * — exactamente lo que CD-15 prohíbe.
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

  const admitted = new Set<string>();
  for (const group of byAnchor.values()) {
    const ordered = [...group].sort((a, b) => {
      const aCreated = a.createdAt ?? '';
      const bCreated = b.createdAt ?? '';
      if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
      if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
      return 0;
    });
    for (const c of ordered.slice(0, m)) admitted.add(c.slug);
  }
  return admitted;
}
