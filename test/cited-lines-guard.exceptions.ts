/**
 * Las EXCEPCIONES del guardián de citas `archivo:línea`.
 *
 * ⛔ NO SE GENERAN VOLCANDO LA SALIDA DEL ESCÁNER. Cada entrada está escrita a
 * mano después de leer el sitio. Un archivo de excusas derivado de la medición
 * que consume deja el control verde por construcción.
 *
 * ── 🔴 EL CANDADO QUE IMPIDE QUE ESTO SEA EL INTERRUPTOR DE APAGADO ────────
 *
 * Una excepción de acá ACOTA LA UNICIDAD, y NADA MÁS. Nunca la existencia del
 * archivo, nunca la existencia de la línea, nunca el match de la conjunción.
 *
 * Una cita exceptuada de la unicidad SIGUE OBLIGADA a que:
 *   · el archivo citado exista y esté trackeado (`E-TARGET_MISSING`),
 *   · la línea citada exista dentro del archivo (`E-LINE_OUT_OF_RANGE`),
 *   · y la conjunción de `mustContain` matchee ESA línea (`E-LINE_MOVED`).
 *
 * Lo ÚNICO que se exceptúa es el `hits === 1`.
 *
 * Sin esta cláusula, cualquiera que vea un rojo escribe una excepción y el
 * guardián deja de medir — que es el modo de falla de TODO archivo de
 * excepciones que existe. `G-C8` la hace cumplir en runtime: una entrada de
 * `UNICITY_EXCEPTIONS` cuyo sitio tiene 1 solo hit se pone roja igual, porque
 * una excusa que ya no hace falta es un permiso que nadie revisa.
 *
 * ── ANTES DE ESCRIBIR UNA EXCEPCIÓN, LA ESCALERA DE 3 PASOS ────────────────
 *
 *  1. ALARGAR LA CONJUNCIÓN. Medido: `mapOwnershipError` solo da 4 hits en
 *     `src/routes/registries.ts`; `['async function ', 'mapOwnershipError(']`
 *     da 1. Casi siempre alcanza con esto.
 *  2. Si la línea es INTRÍNSECAMENTE no identificable (`});`, `}`, un cierre de
 *     bloque de comentario): la
 *     cita está mal y se RE-APUNTA a la línea de la FIRMA del símbolo que la
 *     contiene. NO es una excepción: es corregir el comentario. Precedente vivo:
 *     `src/lib/downstream-payment.ts:247` es `async function settleSolanaLeg(`.
 *  3. SÓLO si 1 y 2 son imposibles (target sin símbolos y línea genuinamente
 *     repetida) → entrada acá, con motivo de >= 40 caracteres y no duplicado
 *     palabra por palabra con ninguna otra.
 *
 * Este archivo no lo typechequea nadie (`tsconfig.json:19` es
 * `include: ["src/**\/*"]`) ni lo lintea nadie (`package.json:11` es
 * `"lint": "biome check src/"`): la forma se valida en RUNTIME, en `G-C8`.
 */

/** Una cita que no puede declarar un `mustContain` único, con el motivo. */
export interface UnicityException {
  /** Archivo CITADOR. Misma clave que el registro: `{from, cite}`. */
  readonly from: string;
  /** El token literal, tal como está escrito. */
  readonly cite: string;
  /** Por qué ESE sitio no puede tener una conjunción única. >= 40 chars. */
  readonly reason: string;
}

/**
 * Citas cuya conjunción matchea más de una línea y no se puede alargar más.
 *
 * Nace VACÍO, y eso es el resultado de la escalera, no un descuido: las 45 citas
 * del Corte A se pudieron anclar con conjunción única. Si esta lista crece, cada
 * entrada es una afirmación sobre un sitio concreto, no una política.
 */
export const UNICITY_EXCEPTIONS: readonly UnicityException[] = [
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: '`:220`',
    reason:
      'La línea `{ field: \'priceUsdc\' },` de `src/routes/agents.ts:220` (guard del POST) es ' +
      'IDÉNTICA BYTE A BYTE —indentación incluida— a la de `:412` (guard del PATCH), y las dos ' +
      'caen dentro del mismo símbolo, `agentsRoutes`, así que ni alargar la conjunción ni el ' +
      'camino de símbolos pueden separarlas. Lo único que las distingue está en la línea ' +
      'SIGUIENTE (`agent publish rejected` vs `agent update rejected`), y `locate` es por ' +
      'línea. La cita NO está mal: `:220` es esa línea y es el guard del POST. Re-apuntarla ' +
      'para que la herramienta quede contenta sería introducir una cita falsa.',
  },
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: '`:237`',
    reason:
      'Mismo caso estructural que `:220` pero sobre otro campo: `{ field: \'payoutWallet\' },` ' +
      'está literalmente repetida en `src/routes/agents.ts:237` (POST) y `:430` (PATCH). Los ' +
      'dos guards son deliberadamente gemelos —ése es el punto del test que los cita, que ' +
      'afirma que los 5 hermanos loguean sólo el `field`—, así que la repetición no es un ' +
      'descuido que se pueda arreglar renombrando algo.',
  },
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: '`:252`',
    reason:
      'Tercero del mismo par POST/PATCH: `{ field: \'referrerRef\' },` vive en ' +
      '`src/routes/agents.ts:252` y en `:444` con el mismo texto exacto. Los otros dos guards ' +
      'que el test enumera (`enabled` `:459` y `capabilities` `:475`) NO necesitan excepción ' +
      'porque sus campos aparecen una sola vez — o sea que esta lista tiene exactamente el ' +
      'tamaño del problema real, no uno redondeado hacia arriba.',
  },
];

/** Una cita en prosa suelta que ningún patrón sintáctico puede anclar. */
export interface UnanchorableProse {
  readonly from: string;
  /** El texto tal como está escrito. Ej: "la línea 95", "el guard de más abajo". */
  readonly quote: string;
  readonly reason: string;
}

/**
 * AC-9. Citas escritas en prosa, sin forma sintáctica: «la línea 95», «el guard
 * de más abajo», «el docblock de arriba».
 *
 * Nace VACÍO y NO se afirma que tenga que crecer. Es el registro de los casos
 * que alguien LEYÓ y decidió que no se podían anclar — no la medida de cuántos
 * hay. Cuántos hay es desconocido y no tiene cota superior: por eso 45 es un
 * PISO y no un total.
 */
export const UNANCHORABLE_PROSE: readonly UnanchorableProse[] = [];

/** Un `:N` que el escáner reporta y que no es una cita. */
export interface ScannerFalsePositive {
  readonly from: string;
  readonly cite: string;
  readonly reason: string;
}

/**
 * Los `:N` que el escáner reporta a propósito aunque no sean citas: puertos
 * (`:8443`, `:443`, `:80`) y offsets (`:0`).
 *
 * NO se descartan en el escáner por rango: una heurística «los números chicos no
 * son líneas» se come mañana una cita real a la línea 80. El ruido cae del lado
 * RUIDOSO —se escribe una excusa— y no del silencioso, que es el criterio
 * correcto cuando hay que elegir.
 *
 * Población hoy en el Corte A: 0. Y este archivo NO afirma que sea > 0 — un
 * control que exigiera «al menos una excepción» se pudre solo el día que alguien
 * borre el puerto.
 */
export const SCANNER_FALSE_POSITIVES: readonly ScannerFalsePositive[] = [
  {
    from: 'src/types/index.ts',
    cite: ':100',
    reason:
      'No es una cita: es el VALOR de una propiedad en un objeto JS escrito dentro de la ' +
      'prosa de un docblock. La línea dice «que un federado que declarara ' +
      '`{reputation:100, verified:true}` ordenaba», o sea que el `:100` es el valor del ' +
      'campo `reputation`. Se reporta a propósito en vez de descartarlo por rango: una ' +
      'heurística «los números chicos no son líneas» se come mañana una cita real.',
  },
  {
    from: 'src/types/index.ts',
    cite: ':1',
    reason:
      'Mismo caso que el anterior pero con otro campo: la línea escribe el esquema JSON ' +
      '`{type:\'string\', minLength:1}` dentro de un comentario, y el `:1` es el valor de ' +
      '`minLength`. Ninguna regla sintáctica separa esto de una cita a la línea 1 sin ' +
      'mirar el nombre de la propiedad de la izquierda, y esa clase de heurística es lo ' +
      'que este repo prefiere NO tener adentro del escáner.',
  },
  {
    from: 'src/services/agent.payment.test.ts',
    cite: ':00',
    reason:
      'Los dos `:00` de un timestamp ISO 8601: la línea construye ' +
      '`new Date(\'2026-01-01T00:00:00.000Z\')`. Aparece DOS veces en la misma línea, y esta ' +
      'única entrada cubre las dos ocurrencias — son el mismo token, del mismo citador, ' +
      'sin ninguna afirmación detrás. Descartarlo en el escáner exigiría reconocer ' +
      'formatos de fecha, que es una heurística que envejece peor que esta excusa.',
  },
];
