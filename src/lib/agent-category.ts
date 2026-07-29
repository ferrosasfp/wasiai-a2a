/**
 * Agent Category Reader — HU-208 · fuente única de "la categoría de un agente".
 *
 * Módulo LEAF (sólo un `import type`, borrado en runtime), por el mismo motivo
 * que `discovery-fetch-limit.ts` / `downstream-skip-code.ts`: lo consumen a la vez
 * `services/discovery.ts` y `services/compose.ts`, y media docena de suites
 * mockean `../services/discovery.js` COMPLETO con factories sin `importOriginal`
 * — un export nuevo colgado de ese service quedaría `undefined` bajo test.
 *
 * POR QUÉ EXISTE (y por qué no puede haber una segunda copia): la función vivía
 * privada en `services/compose.ts` (`readCategory`), donde alimenta el target de
 * `authzService.checkScoping` que HACE CUMPLIR el alcance de la credencial. Desde
 * HU-208 el mismo dato decide qué agentes son CANDIDATOS al resolver un step por
 * capacidad. Si el selector y el ejecutor leyeran la categoría distinto, el
 * selector elegiría un agente que el ejecutor después rechaza con 403 — sobre un
 * agente que el llamador nunca nombró, así que ni siquiera podría entender el
 * error. Un solo lector hace que ese desacuerdo sea imposible por construcción.
 *
 * Se movió TAL CUAL desde `services/compose.ts` (mismo type-guard, mismo
 * `undefined` de salida): CERO cambio de comportamiento para el path de scoping
 * que ya existía.
 */

import type { Agent } from '../types/index.js';

/**
 * WKH-61: lee `category` del `Agent.metadata` con type-guard.
 *
 * Retorna `undefined` si `metadata.category` no es un string (registries que no
 * exponen category). NO usar `agent.capabilities[0]` como proxy (CD-8): la
 * categoría es un eje de autorización y derivarla de otro campo haría que una
 * credencial restringida por categoría autorizara cosas que nadie declaró.
 */
export function readAgentCategory(agent: Agent): string | undefined {
  const meta = agent.metadata as Record<string, unknown> | undefined;
  const cat = meta?.category;
  return typeof cat === 'string' ? cat : undefined;
}
