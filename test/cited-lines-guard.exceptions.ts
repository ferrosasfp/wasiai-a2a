/**
 * Las EXCEPCIONES del guardián de citas `archivo:línea`.
 *
 * ⛔ NO SE GENERAN VOLCANDO LA SALIDA DEL ESCÁNER. Cada entrada está escrita a
 * mano después de leer el sitio. Un archivo de excusas derivado de la medición
 * que consume deja el control verde por construcción.
 *
 * ── 🔴 EL CANDADO QUE IMPIDE QUE ESTO SEA EL INTERRUPTOR DE APAGADO ────────
 *
 * ⚠️ ACÁ VIVEN TRES LISTAS, Y EL CANDADO TIENE QUE VALER PARA LAS TRES. La
 * primera versión de esta cabecera describía sólo `UNICITY_EXCEPTIONS` —que es
 * la lista más débil— y `SCANNER_FALSE_POSITIVES` quedó exceptuando TODO sin
 * ninguna restricción de forma: medido, mover una cita real, normativa y con
 * path (`CLAUDE.md :: src/types/database.types.ts:2567`) a la lista de falsos
 * positivos, con una excusa plausible de 40 caracteres, dejaba el guardián en
 * **10/10 verde**. O sea: el candado se había construido sobre la lista
 * equivocada. Lo que sigue es el candado de CADA una.
 *
 * 1️⃣ `UNICITY_EXCEPTIONS` ACOTA LA UNICIDAD, Y NADA MÁS. Nunca la existencia
 * del archivo, nunca la existencia de la línea, nunca el match de la conjunción.
 * Una cita exceptuada de la unicidad SIGUE OBLIGADA a que:
 *   · el archivo citado exista y esté trackeado (`E-TARGET_MISSING`),
 *   · la línea citada exista dentro del archivo (`E-LINE_OUT_OF_RANGE`),
 *   · y la conjunción de `mustContain` matchee ESA línea (`E-LINE_MOVED`).
 * Lo ÚNICO que se exceptúa es el `hits === 1`. Y la cita tiene que estar
 * declarada en `CITED_LINES`: exceptuar la unicidad de una cita que no existe
 * en el registro es rojo.
 *
 * 2️⃣ `SCANNER_FALSE_POSITIVES` NO PUEDE NOMBRAR UN ARCHIVO TRACKEADO. Un token
 * que nombra un archivo que EXISTE en el índice de git no es ruido del escáner:
 * es una afirmación sobre el repo, y va a `CITED_LINES` o se corrige. `G-C8` lo
 * hace cumplir en runtime con `citeTargetIfTracked`, y `G-C11` prueba las dos
 * direcciones con fixtures en memoria.
 * ⚠️ La regla NO es «ningún token con path», y la diferencia se midió:
 * `https://x.io:8443/y` produce un token P2 CON path (`x.io`) que es ruido
 * legítimo y tiene que poder declararse acá. Lo que lo separa de una cita es
 * que `x.io` no está en el índice de git.
 *
 * 🚧 Y ACOTAR NO ES CERRAR — lo que este candado NO alcanza, medido: un token
 * SIN archivo (P3/P4, un `:N` suelto) se puede seguir moviendo acá con una
 * excusa, porque nada mecánico distingue un `:336` que cita una línea de un
 * `:8443` que es un puerto — es la misma razón por la que el escáner los reporta
 * a propósito. Del registro de hoy, 31 de las 50 citas declaradas tienen archivo
 * en el token y quedan protegidas; las otras 19 dependen de que quien escriba la
 * excusa la escriba en serio, y de que quien revise la lea. El candado cierra la
 * puerta grande, no todas.
 *
 * 3️⃣ `UNANCHORABLE_PROSE` ES SÓLO PARA PROSA SIN FORMA SINTÁCTICA. Si el
 * `quote` contiene un token que el escáner sabe encontrar, entonces se puede
 * anclar por definición y la entrada es rojo: va a `CITED_LINES`. Lo verifica
 * `G-C8` corriendo el propio `scanSource` sobre el `quote`. (Esta lista no saca
 * nada del universo, así que no puede apagar un rojo; el candado existe para que
 * no se convierta en el lugar donde se archiva lo que da trabajo declarar.)
 *
 * Sin estas tres cláusulas, cualquiera que vea un rojo escribe una excepción y
 * el guardián deja de medir — que es el modo de falla de TODO archivo de
 * excepciones que existe. `G-C8` las hace cumplir en runtime: una entrada de
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
 * ── ⚖️ LA VARA: ¿CUÁNDO UN NÚMERO ADYACENTE ESTÁ MAL Y CUÁNDO NO? ──────────
 *
 * Esta HU aplicó DOS varas distintas a dos citas de la MISMA oración y no dejó
 * escrito el criterio, así que acá está. La regla es:
 *
 *   ✅ La línea citada tiene que contener aquello que la prosa usa como SUJETO
 *      de su afirmación, o la línea que lo DECIDE.
 *   ⛔ No alcanza con que la línea sea «del mismo bloque».
 *
 * Los dos casos medidos, que son el par que fija la vara:
 *   · `fee-split.ts:335 → :336` se CORRIGIÓ: la prosa hablaba de `priorTx` y
 *     `:335` no menciona `priorTx` en ninguna parte. El sujeto no estaba en la
 *     línea: la cita estaba mal.
 *   · `fee-split.ts:316` se DEJÓ: la prosa dice «un leg `failed` corta en el
 *     return temprano», el `return` literal está en `:320` y `:316` es
 *     `const failed = …`, la línea que DECIDE ese return. El sujeto de la
 *     afirmación (`failed`) está en la línea citada.
 *
 * Y el desempate cuando las dos lecturas son defendibles: NO tocar. Corregir un
 * número que no está mal deja una cita con cara de verificada sin que nadie haya
 * verificado nada, y esta HU ya midió el caso extremo de eso — el SDD declaró
 * FALSA una cita (`tsconfig.json:19`) que era CORRECTA, y aplicar esa
 * «corrección» habría metido una cita falsa adentro de la HU que existe para
 * sacarlas. La abstención se ESCRIBE, con la lectura de la línea que la sostiene.
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
 * ⚠️ ESTA CABECERA DECÍA «Nace VACÍO … las 45 citas del Corte A se pudieron
 * anclar con conjunción única», con las entradas escritas 2 líneas más abajo y
 * con el 45 ya desmentido por el propio guardián (el universo es 57). O sea: el
 * archivo cuya regla número uno es «cada entrada está escrita a mano después de
 * leer el sitio» tenía su cabecera describiendo un estado anterior al de su
 * contenido, y nada mecánico lo caza — `G-C8` valida el largo y la unicidad de
 * los motivos, no la cabecera. Es literalmente el defecto que esta HU vigila,
 * adentro de la HU.
 *
 * LO QUE SE SOSTIENE, sin número: la escalera resolvió la abrumadora mayoría de
 * las citas con conjunción única, y lo que queda acá es UNA sola situación real
 * —guards POST/PATCH gemelos byte a byte dentro del mismo símbolo— y no una
 * política. Cada entrada es una afirmación sobre un sitio concreto.
 *
 * Cuántas hay: `UNICITY_EXCEPTIONS.length`, que es la única fuente que no
 * envejece. Al 2026-08-19 eran 3, y ese número es una FOTO: no lo cites, derivalo.
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
 * hay. Cuántos hay es desconocido y no tiene cota superior: por eso el conteo
 * del guardián (`FOUND.length`, cualquiera sea hoy) es un PISO y no un total.
 * (Acá decía «45», que era el número del SDD y ya estaba desmentido por el
 * propio guardián el día que se escribió.)
 *
 * Candado 3️⃣: el `quote` no puede contener un token que el escáner sepa
 * encontrar. Si lo contiene, la cita tiene forma sintáctica, se puede anclar, y
 * va a `CITED_LINES`.
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
 * 🔴 EL CANDADO (2️⃣ de la cabecera): NINGUNA entrada de esta lista puede nombrar
 * un archivo TRACKEADO por git. Ésta es la lista que exceptúa TODO —la clave
 * desaparece del conjunto de huérfanas de `G-C4` y del invariante estricto— así
 * que es la que necesita la restricción de forma más dura. Las 3 entradas de hoy
 * son `:100`, `:1` y `:00`: ninguna nombra archivo, o sea que el candado costó
 * exactamente cero. Un `https://x.io:8443/y` SÍ puede entrar acá, porque `x.io`
 * no está en el índice de git.
 *
 * ⚠️ Este docblock decía «Población hoy en el Corte A: 0» con las 3 entradas
 * escritas 1 línea más abajo. Corregido: la población es `SCANNER_FALSE_POSITIVES.length`,
 * y al 2026-08-19 eran 3 — una FOTO, derivala. Lo que sigue siendo cierto es que
 * este archivo NO afirma que sea > 0: un control que exigiera «al menos una
 * excepción» se pudre solo el día que alguien borre el puerto.
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
