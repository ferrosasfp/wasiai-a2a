/**
 * QUÉ CAPACIDADES DESEMBOLSAN — la clasificación, en UN solo lugar.
 *
 * Existe por `doc/sdd/211-wkh-313-primer-trabajo-agentes-sin-historial/residuales.md:18-23`
 * (R-4): «si no se puede garantizar el mismo agente en los dos legs, la regla es
 * `M = 1` para capacidades de desembolso». Esa regla estaba ESCRITA y nadie la
 * hacía cumplir: `TRIAL_MAX_AGENTS_PER_PUBLISHER` es un cupo por publicador
 * GLOBAL, sin distinguir qué hace el agente.
 *
 * ⚠️ ESTE ARCHIVO ES LA ÚNICA COPIA. Si mañana se publica una capacidad que
 * entrega valor a una persona, se agrega ACÁ y en ningún otro lado. Una segunda
 * lista en otro módulo es el bug garantizado: el día que se agregue la tercera
 * capacidad se va a agregar en una sola de las dos (es, textualmente, el defecto
 * de clase que `lib/trial-standing.ts:153-159` documenta para el predicado de
 * admisión, y el que el auto-blindaje de HU-208 pagó con el refund del step-0).
 *
 * Módulo LEAF a propósito (cero imports de runtime), por el mismo motivo que
 * `lib/agent-category.ts:1-22` y `lib/trial-standing.ts:27-31`: lo consume
 * `lib/trial-standing.ts`, que a su vez es leaf porque media docena de suites
 * mockean `services/discovery.js` COMPLETO.
 *
 * ── POR QUÉ IMPORTA (medido, no inferido) ──────────────────────────────────
 * En el carril de estreno, cuando NINGÚN candidato pasa por mérito, los
 * admitidos empatan todos en score 0 y el desempate es un SORTEO por request
 * (`lib/trial-standing.ts:286-322`). El ganador de un step de payout es quien
 * devuelve el `depositAddress` contra el que una persona firma el principal de
 * su remesa. `residuales.md:42-50` midió que, con 20 de 22 candidatos, un sybil
 * se queda los dos cupos en ~82% de las requests. Con el cupo de desembolso en
 * 1, el mismo ataque cuesta N identidades registradas en vez de 1.
 */

/**
 * Las tres respuestas posibles, y la tercera NO es la segunda.
 *
 * `'unclassified'` es "no sé qué hace este agente", que es un estado DISTINTO de
 * "sé que no mueve plata". La doctrina del repo para el tercer valor está escrita
 * en `lib/trial-standing.ts:178` (CD-7: "no pude preguntar por el historial NO es
 * no tiene historial") y en `memory/no-pude-preguntar-no-es-no.md`.
 */
export type CapabilityRisk =
  | 'disbursement'
  | 'no-disbursement'
  | 'unclassified';

/**
 * Capacidades que ENTREGAN VALOR a una persona: el agente que las sirve es el que
 * devuelve el `depositAddress` / ejecuta el desembolso.
 *
 * Enumeradas CON EVIDENCIA, no de memoria — son las cuatro que publica
 * `remit-cashout-payout` en su registro de producción
 * (`doc/sdd/170-wkh-172-remit-cashout-payout/done-report.md:202`, idéntico en
 * `sdd.md:434` y `story-file.md:620`). Su gemelo Solana
 * `remit-cashout-payout-solana` sirve la misma `remittance-payout`
 * (`doc/roadmap/2026-08-incubadora-solana-checklist.md:48-53`).
 *
 * Todo en minúsculas: el lookup normaliza (ver `classifyCapability`), así que acá
 * NO se escriben variantes de mayúsculas.
 */
export const DISBURSEMENT_CAPABILITIES: ReadonlySet<string> = new Set([
  'remittance-payout',
  'cashout',
  'value-delivery',
  'fiat-disbursement',
]);

/**
 * Capacidades VERIFICADAS que no entregan valor: cotizan, validan o describen,
 * pero ninguna termina con plata en manos de una persona.
 *
 * Esta lista NO es "todo lo demás" — es lo que se pudo comprobar. Cada entrada
 * tiene su fuente:
 *
 *   · `remittance-fx-quote`, `usdc-to-pen`, `corridor-pricing` — el agente de FX
 *     (`doc/sdd/167-wkh-171-remit-corridor-fx/done-report.md:177`). Cotiza; el
 *     desembolso es otro agente.
 *   · `kyc-verification`, `aml-screening`, `travel-rule`,
 *     `remittance-compliance` — el validador de KYC
 *     (`doc/sdd/169-wkh-170-remit-kyc-validator/done-report.md:190`). Autoriza o
 *     rechaza; no paga.
 *   · `remit.corridor-discovery`, `kyc-check` — los nombres exactos publicados en
 *     bdwv (`doc/sdd/_INDEX.md:144`).
 *
 * ⚠️ `cashout-match` aparece en esa misma línea del `_INDEX.md` y se deja
 * DELIBERADAMENTE afuera: nombra un cashout y no se pudo verificar que no
 * entregue valor. Un "probablemente no" no entra a una lista cuyo efecto es
 * AFLOJAR un cupo del camino del dinero.
 */
export const NON_DISBURSEMENT_CAPABILITIES: ReadonlySet<string> = new Set([
  'remittance-fx-quote',
  'usdc-to-pen',
  'corridor-pricing',
  'kyc-verification',
  'aml-screening',
  'travel-rule',
  'remittance-compliance',
  'remit.corridor-discovery',
  'kyc-check',
]);

/**
 * Normaliza como YA lo hace el filtro de capabilities de discovery
 * (`services/discovery.ts:445-450`: `.toLowerCase()` en los dos lados). Sin esto,
 * publicar `Remittance-Payout` esquivaría la clasificación con un cambio de
 * mayúsculas — un bypass de una línea.
 */
function normalize(capability: string): string {
  return capability.trim().toLowerCase();
}

/** Clasifica UNA capacidad. Lo que no está en ninguna lista es `'unclassified'`. */
export function classifyCapability(capability: string): CapabilityRisk {
  const key = normalize(capability);
  if (DISBURSEMENT_CAPABILITIES.has(key)) return 'disbursement';
  if (NON_DISBURSEMENT_CAPABILITIES.has(key)) return 'no-disbursement';
  return 'unclassified';
}

/**
 * Clasifica el conjunto de capacidades DECLARADAS por un agente.
 *
 * `'no-disbursement'` es una AFIRMACIÓN, y por eso es el caso más caro de
 * alcanzar: hace falta que el agente declare al menos una capacidad y que TODAS
 * estén verificadas como inocuas. Cualquier otra cosa cae del lado restrictivo:
 *
 *   · una sola capacidad de desembolso ⟹ `'disbursement'` (un agente que además
 *     cotiza sigue siendo el que paga);
 *   · una sola capacidad que no se pudo clasificar ⟹ `'unclassified'`;
 *   · lista vacía, ausente, o con entradas que no son strings ⟹ `'unclassified'`
 *     — "el agente no dice qué hace" no es "el agente no mueve plata".
 *
 * El parámetro se tipa `readonly unknown[]` a propósito: `Agent.capabilities` es
 * `string[]` en el tipo, pero para un agente FEDERADO lo construye `toArray` sobre
 * un JSON ajeno (`services/discovery.ts:1279-1281, 1410-1414`), o sea que el tipo
 * es una promesa de nuestro mapper sobre datos de un tercero. Acá no se confía.
 */
export function classifyCapabilities(
  capabilities: readonly unknown[] | undefined | null,
): CapabilityRisk {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return 'unclassified';
  }
  let sawUnclassified = false;
  for (const raw of capabilities) {
    if (typeof raw !== 'string') {
      sawUnclassified = true;
      continue;
    }
    const risk = classifyCapability(raw);
    if (risk === 'disbursement') return 'disbursement';
    if (risk === 'unclassified') sawUnclassified = true;
  }
  return sawUnclassified ? 'unclassified' : 'no-disbursement';
}

/**
 * ¿Este agente entra al cupo ESTRECHO?
 *
 * Sí para `'disbursement'` y para `'unclassified'`. Es la decisión explícita que
 * pide el lado seguro: una capacidad nueva que mueva plata y que nadie haya
 * agregado a `DISBURSEMENT_CAPABILITIES` recibe igual el cupo más restrictivo. El
 * costo de equivocarse en esta dirección es que un agente inocuo comparta un cupo
 * de 1 con sus hermanos del mismo publicador; el costo de equivocarse en la otra
 * es el `depositAddress` de una remesa. No son simétricos.
 */
export function needsTightTrialQuota(
  capabilities: readonly unknown[] | undefined | null,
): boolean {
  return classifyCapabilities(capabilities) !== 'no-disbursement';
}
