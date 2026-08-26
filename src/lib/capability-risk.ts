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
 * (`doc/sdd/217-wkh-322-discover-min-reputation-param-naming/sdd.md:41`: es el
 * ÚNICO agente del catálogo con esa capacidad).
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
 *   · `kyc-hosted-redirect`, `legacy-single-shot-kyc` — el MISMO validador de
 *     KYC, declaradas en `wasiai-remittance-agents/src/manifest/registry.ts:76`
 *     y `:77`. Su docblock (`:71-75`) dice que son ADITIVAS a las cuatro de
 *     arriba y que declaran POR QUÉ CAMINO se hace el trabajo (rol vs camino),
 *     no un trabajo nuevo: una es el flujo hospedado donde el documento lo
 *     escanea la persona en la pantalla del proveedor, la otra es la marca del
 *     `/invoke` viejo. Ninguna nombra un desembolso, y de ese mismo agente ya
 *     está escrito acá arriba que "autoriza o rechaza; no paga".
 *
 *     Sin estas dos entradas, el día que la ficha se republique con ellas el
 *     conjunto declarado pasa a tener capacidades sin clasificar, la
 *     clasificación cae a `'unclassified'` y el agente recibe el cupo ESTRECHO
 *     — o sea que publicar el camino más seguro lo penalizaría.
 *
 *   · `kyc-session-create`, `kyc-decision-read` — WKH-366. Son del MISMO
 *     validador de KYC, partido en los dos pasos del dialecto compose y
 *     declaradas en `wasiai-remittance-agents/src/manifest/registry.ts:275` y
 *     `:300`. Vale palabra por palabra el argumento de las dos de arriba: de ese
 *     agente ya está escrito acá que «autoriza o rechaza; no paga», y ninguna de
 *     las dos nombra un desembolso — una crea la pantalla hospedada donde la
 *     persona escanea su documento, la otra LEE el veredicto de esa sesión.
 *
 *     Sin estas dos entradas, `classifyCapability` cae a `'unclassified'` y el
 *     agente recibiría el cupo ESTRECHO: publicar el camino más seguro —el que
 *     NO manda el documento por la red— lo penalizaría. Es el mismo argumento
 *     del párrafo anterior, y por eso van juntas.
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
  'kyc-hosted-redirect',
  'legacy-single-shot-kyc',
  'kyc-session-create',
  'kyc-decision-read',
]);

/**
 * Capacidades cuyo OUTPUT ES UN VEREDICTO DE AUTORIZACIÓN DE DINERO. Un step que
 * las declara NO puede resolverse por ranking: quién contesta cambia qué se
 * autoriza.
 *
 * 🔴 CONTIENE EXACTAMENTE LAS DOS CAPACIDADES NUEVAS, Y NINGUNA PREEXISTENTE. Es
 * una decisión de alcance deliberada, no una lista a medio hacer:
 *
 *  · Meter `kyc-verification`, `kyc-check`, `kyc-hosted-redirect` o cualquier
 *    otra ROMPERÍA CON 400 a cualquier consumidor externo que hoy componga un
 *    step de KYC por capacidad. Desde este repo NO se puede medir quién hace eso
 *    (`/orchestrate` no emite steps por capacidad, y chaski-v3 sólo usa
 *    `remittance-fx-quote` / `remittance-payout`), y "no lo veo desde acá" NO es
 *    "no existe".
 *  · Las dos de acá tienen, por construcción, CERO consumidores el día que se
 *    publican. El guard es fail-closed sobre superficie NUEVA y cero regresión
 *    sobre la vieja.
 *
 * ⛔ AGREGAR UNA CAPACIDAD PREEXISTENTE A ESTE SET ES UN CAMBIO DE CONTRATO PARA
 * TERCEROS, no una línea más en un `Set`. Cerrarlo requiere medir el tráfico vivo
 * primero (residual R-1 de WKH-366).
 */
export const AUTHORIZATION_CAPABILITIES: ReadonlySet<string> = new Set([
  'kyc-session-create',
  'kyc-decision-read',
]);

/**
 * ¿Esta capacidad exige que el caller nombre al agente en vez de delegar la
 * elección al ranking?
 *
 * Normaliza con el MISMO `normalize` que `classifyCapability` (`:176-178`):
 * sin eso, mandar `KYC-Decision-Read` esquivaría el guard con un cambio de
 * mayúsculas — un bypass de una línea.
 */
export function requiresPinnedAgent(capability: string): boolean {
  return AUTHORIZATION_CAPABILITIES.has(normalize(capability));
}

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
