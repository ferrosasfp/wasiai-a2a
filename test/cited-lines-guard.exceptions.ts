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
 * hace cumplir en runtime con `citeTargetIfTracked`; `G-C11` prueba la REGLA en
 * las dos direcciones con fixtures en memoria, y `G-C8` prueba su APLICACIÓN al
 * registro real metiendo citas declaradas adentro de su propio barrido y
 * exigiendo que las marque (los dos hacen falta: se midieron dos arreglos
 * truchos que dejaban `G-C11` verde y la aplicación apagada).
 * ⚠️ La regla NO es «ningún token con path», y la diferencia se midió:
 * `https://x.io:8443/y` produce un token P2 CON path (`x.io`) que es ruido
 * legítimo y tiene que poder declararse acá. Lo que lo separa de una cita es
 * que `x.io` no está en el índice de git.
 *
 * 🚧 Y ACOTAR NO ES CERRAR — lo que este candado NO alcanza son DOS salidas,
 * las dos medidas:
 *
 *   (a) UN TOKEN SIN ARCHIVO (P3/P4, un `:N` suelto) se puede seguir moviendo
 *       acá con una excusa, porque nada mecánico distingue un `:336` que cita
 *       una línea de un `:8443` que es un puerto — es la misma razón por la que
 *       el escáner los reporta a propósito.
 *   (b) UN TOKEN QUE SÍ NOMBRA UN ARCHIVO, PERO QUE NO ESTÁ EN EL ÍNDICE DE
 *       GIT. `citeTargetIfTracked` pregunta por el índice, no por el disco: un
 *       archivo que existe en el working tree y que nadie trackeó devuelve
 *       `null` y también se puede declarar ruido. Repro medida: una cita a
 *       `.nexus/project-context.md:6` en un archivo del Corte A, más su entrada
 *       acá, deja el guardián en 12/12 VERDE.
 *       🔴 La asimetría es lo que lo hace un defecto y no una elección: la MISMA
 *       cita declarada en `CITED_LINES` pone el guardián ROJO
 *       (`E-TARGET_MISSING`); declarada ruido acá, pasa en verde.
 *       ⚠️ NO se cierra leyendo el disco, y es a propósito: el índice es lo que
 *       un `checkout` trae, y un guardián que dependa de qué archivos sueltos
 *       tenga cada quien en su working tree da distinto en CI que en local.
 *       Población hoy dentro del Corte A: 0 — es una frase que faltaba, no un
 *       agujero abierto. Queda con nombre: `TD-316-CITAS-PROJECT-CONTEXT`.
 *
 * Cuánto cubre el candado: `CITED_LINES.filter(citeNamesFile).length` sobre
 * `CITED_LINES.length`. Al 2026-08-19 eran 31 de 50, y ese par es una FOTO: no
 * lo cites, derivalo con `citeNamesFile` sobre `CITED_LINES`. Las otras dependen
 * de que quien escriba la excusa la escriba en serio, y de que quien revise la
 * lea. El candado cierra la puerta grande, no todas.
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

/** Un sitio del censo de D5, con el veredicto LEÍDO EN EL SITIO. */
export interface D5Site {
  readonly file: string;
  readonly line: number;
  readonly cite: string;
  /**
   * `AUTO`  — sí apunta a su propio archivo (D5 acertaba).
   * `OTRO`  — apunta a OTRO archivo: D5 habría inventado el destino.
   * `RUIDO` — no es una cita: un slice de Python, un puerto.
   */
  readonly verdict: 'AUTO' | 'OTRO' | 'RUIDO';
  /** El destino REAL cuando `verdict === 'OTRO'`. */
  readonly realTarget?: string;
  readonly reason: string;
}

/**
 * 🔴 EL CENSO QUE DEGRADÓ A D5 (WKH-371, CD-19).
 *
 * D5 era la regla de la AUTO-CITA: «el párrafo no nombra ningún archivo y el
 * `:N` cae dentro del rango de líneas del propio citador ⇒ es una cita a sí
 * mismo». Es la única regla de la cascada que afirma un destino SIN ninguna
 * evidencia en el párrafo, así que su verificación no podía ser un muestreo:
 * es un CENSO. Estos son TODOS los sitios del perímetro que llegaban a D5,
 * abiertos y leídos uno por uno.
 *
 * ⛔ EL UMBRAL SE ESCRIBIÓ ANTES DE MEDIR, y sin eso cualquier resultado se
 * narra como éxito: «más de 20 destinos equivocados sobre 94 ⇒ D5 se degrada a
 * `INDECIDIBLE` y se re-publica todo».
 *
 * Resultado: **19 `AUTO`, 13 `OTRO`, 4 `RUIDO`** ⇒ 17 equivocados sobre 36.
 * Las dos lecturas del umbral, escritas las dos porque elegir la cómoda en
 * silencio es el defecto que esta HU persigue:
 *   · absoluta («más de 20») → 17 ≤ 20 ⇒ D5 pasaría;
 *   · como tasa («20 sobre 94» = 21 %) → 17/36 = 47 % ⇒ D5 NO pasa.
 * Manda la tasa: el «20» sólo significa algo contra el denominador para el que
 * se escribió, y el denominador real salió 2,6 veces más chico.
 *
 * ⚠️ LO QUE ESTE CENSO **NO** DICE: que la auto-cita sea rara. Es la forma
 * principal —19 de 36 sitios lo son, y los 5 falsos negativos que el F1 midió
 * contra las entradas ya etiquetadas son 5 de 5 auto-citas—. Lo que dice es que
 * «el número cae dentro del rango de líneas del propio archivo» NO ALCANZA para
 * reconocerla: en un archivo de 2000 líneas casi cualquier número cae adentro,
 * así que la condición no discrimina nada. Queda ABIERTO como
 * `TD-371-AUTOCITA`: hace falta una señal de verdad (proximidad del contexto,
 * «este archivo» escrito con todas las letras, o cruzar el `mustContain`), no
 * una cota que casi siempre se cumple.
 *
 * ⛔ NO SE GENERÓ VOLCANDO LA SALIDA DEL CLASIFICADOR (CD-11): el clasificador
 * dio la LISTA de sitios que llegan a D5, y cada `verdict`, cada `realTarget` y
 * cada `reason` salió de abrir el sitio y leer la oración.
 *
 * FOTO del 2026-08-28, contra el commit `19405ba`. El número se deriva
 * corriendo `G-C17c`, no se lee de este párrafo.
 */
export const D5_CENSUS: readonly D5Site[] = [
  {
    file: 'scripts/doctor-deps.sh',
    line: 60,
    cite: ':5',
    verdict: 'RUIDO',
    reason: 'Es un slice de Python dentro de un heredoc: `for f in found[:5]:`. El `[` anterior no es un identificador, así que D1 no lo ve.',
  },
  {
    file: 'scripts/doctor-deps.sh',
    line: 90,
    cite: ':8',
    verdict: 'RUIDO',
    reason: 'Mismo caso: `for pkg, info in list(d.items())[:8]:`, un slice en el Python embebido del script.',
  },
  {
    file: 'scripts/eq-sweep.mjs',
    line: 64,
    cite: '`:241-257`',
    verdict: 'AUTO',
    reason: '«El porqué completo … está sobre `cederElTurno` (`:241-257`)», y `cederElTurno` es una función de este mismo script.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 33,
    cite: '`:199-202`',
    verdict: 'AUTO',
    reason: 'Lo dice con todas las letras: «`mockRpc.mockResolvedValue(...)` de ESTE archivo, `:199-202`».',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 155,
    cite: '`:139`',
    verdict: 'OTRO',
    realTarget: 'src/adapters/escrow/debit-capture.ts',
    reason: '«Un deadline dentro de la ventana `[now, now + 3600]` de `:139`…»: abierto el destino, `debit-capture.ts:139` es `if (now > dl || dl > now + MAX_DEADLINE_TTL_SECONDS)`. La 139 de ESTE archivo es un docblock de columnas.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 155,
    cite: '`:230-235`',
    verdict: 'OTRO',
    realTarget: 'src/adapters/escrow/debit-capture.ts',
    reason: 'La otra mitad de la misma oración: `debit-capture.ts:230-235` es el bloque `DEADLINE_EXPIRED` / `DEADLINE_TOO_FAR`.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 254,
    cite: '`:236-249`',
    verdict: 'OTRO',
    realTarget: 'src/adapters/escrow/debit-capture.ts',
    reason: '«La decisión es del código (`:236-249`), no del doble»: «el código» es el de producción, y la frase entera existe para separarlo de este archivo.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 255,
    cite: '`:275-287`',
    verdict: 'OTRO',
    realTarget: 'src/adapters/escrow/debit-capture.ts',
    reason: '«se lee en los argumentos con los que llamó al RPC (`:275-287`)»: la llamada al RPC está en el código de producción; acá sólo se leen sus argumentos.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ts',
    line: 130,
    cite: ':88-89',
    verdict: 'AUTO',
    reason: '«espejo EXACTO de captureDebitSignature (:88-89)», y `captureDebitSignature` está en este mismo archivo.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ts',
    line: 136,
    cite: ':141-149',
    verdict: 'AUTO',
    reason: '«espejo de captureDebitSignature (:141-149)», misma función del mismo archivo.',
  },
  {
    file: 'src/adapters/solana/facilitator-settle.ts',
    line: 416,
    cite: '`:360`',
    verdict: 'AUTO',
    reason: '«Arriba se aplica dos veces … al CUERPO (`:360`)», y «arriba» es este archivo.',
  },
  {
    file: 'src/adapters/solana/facilitator-settle.ts',
    line: 417,
    cite: '`:372`',
    verdict: 'AUTO',
    reason: 'La otra mitad de la misma oración: «y al CAMPO (`:372`)».',
  },
  {
    file: 'src/adapters/solana/facilitator-settle.ts',
    line: 523,
    cite: '`:203-209`',
    verdict: 'AUTO',
    reason: 'El ARCHIVO es correcto —`payoutViaFacilitator` vive acá, y su corte con `\'not-sent\'` está en `:633`— pero la LÍNEA está podrida: `:203-209` es hoy el docblock de `PAYOUT_ROUTE_PROBE_TIMEOUT_MS`. La propia frase dice «del original». Lo que el clasificador decide es el archivo; la línea la cruza el registro.',
  },
  {
    file: 'src/lib/capability-risk.ts',
    line: 162,
    cite: '`:176-178`',
    verdict: 'AUTO',
    reason: '«el MISMO `normalize` que `classifyCapability` (`:176-178`)», y `classifyCapability` es de este archivo.',
  },
  {
    file: 'src/lib/ssrf-dispatcher.ts',
    line: 342,
    cite: ':80',
    verdict: 'RUIDO',
    reason: 'Es un PUERTO en la prosa: «the scheme\'s own default-port shift (http :80 → https :443)». El carácter anterior es un espacio, así que D1 no lo alcanza.',
  },
  {
    file: 'src/lib/ssrf-dispatcher.ts',
    line: 343,
    cite: ':443',
    verdict: 'RUIDO',
    reason: 'El otro puerto de la misma oración. Los dos son la prueba de que ni el rango ni los backticks separan un puerto de una línea.',
  },
  {
    file: 'src/middleware/x402.ts',
    line: 518,
    cite: '`:514`',
    verdict: 'AUTO',
    reason: '«ni una línea de `:514` en adelante se ejecuta para Solana»: habla del código que sigue en este mismo archivo.',
  },
  {
    file: 'src/routes/agents.ownership.test.ts',
    line: 13,
    cite: '`:72`',
    verdict: 'AUTO',
    reason: '«el mock registra los `.eq()` en `:72`»: el mock es el de este archivo. Ya estaba declarado así a mano en `CITED_LINES`.',
  },
  {
    file: 'src/routes/agents.ownership.test.ts',
    line: 13,
    cite: '`:76-77`',
    verdict: 'AUTO',
    reason: 'Ídem, misma oración: «`maybeSingle`/`single` (`:76-77`) devuelven `state.row`». También declarada a mano.',
  },
  {
    file: 'src/routes/capabilities.ts',
    line: 78,
    cite: ':41-43',
    verdict: 'AUTO',
    reason: 'Lo dice explícito: «mismo patrón que HU-204 en este archivo (:41-43)».',
  },
  {
    file: 'src/routes/payments.dispute-ownership.test.ts',
    line: 22,
    cite: '`:72`',
    verdict: 'OTRO',
    realTarget: 'src/routes/agents.ownership.test.ts',
    reason: 'El título de la sección, CUATRO líneas más arriba, dice «POR QUÉ NO SE COPIA EL MOCK DE `agents.ownership.test.ts`»: el `:72` es de AQUEL mock. Queda fuera del párrafo porque una línea ` *` vacía corta.',
  },
  {
    file: 'src/routes/payments.dispute-ownership.test.ts',
    line: 22,
    cite: '`:76-77`',
    verdict: 'OTRO',
    realTarget: 'src/routes/agents.ownership.test.ts',
    reason: 'La otra mitad de la misma oración, sobre el mismo mock ajeno.',
  },
  {
    file: 'src/services/agent.ownership.test.ts',
    line: 13,
    cite: '`:49`',
    verdict: 'OTRO',
    realTarget: 'src/routes/agents.ownership.test.ts',
    reason: '«Ese archivo … su mock registra los `.eq()` (`:49`)», y «ese archivo» es el que titula la sección: `src/routes/agents.ownership.test.ts`.',
  },
  {
    file: 'src/services/agent.ownership.test.ts',
    line: 13,
    cite: '`:53-54`',
    verdict: 'OTRO',
    realTarget: 'src/routes/agents.ownership.test.ts',
    reason: 'Misma oración, mismo archivo ajeno: «`maybeSingle`/`single` (`:53-54`)».',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 362,
    cite: '`:212-219`',
    verdict: 'OTRO',
    realTarget: 'src/services/arbiter.ts',
    reason: '«El `nonce` con el que el código llamó a `executeResolveDispute` (`:212-219`)»: abierto el destino, `arbiter.ts:212-219` ES esa llamada.',
  },
  {
    file: 'src/services/arbiter/evidence.ownership.test.ts',
    line: 45,
    cite: '`:112`',
    verdict: 'OTRO',
    realTarget: 'src/services/arbiter/evidence.ts',
    reason: '«`readEvidence` llama `receiptService.verify` una vez por recibo (`:112`)», y `readEvidence` es de `evidence.ts`, no de este test.',
  },
  {
    file: 'src/services/compose.ts',
    line: 751,
    cite: ':634',
    verdict: 'AUTO',
    reason: '«guard `i > 0` de :634»: el guard es de este archivo. Ya estaba declarada a mano en `CITED_LINES`.',
  },
  {
    file: 'src/services/discovery.ts',
    line: 664,
    cite: ':293',
    verdict: 'AUTO',
    reason: '«Es GLOBAL sobre la concatenación de todas las fuentes (:293)»: el `slice` y la concatenación son de este archivo.',
  },
  {
    file: 'src/services/fee-settle-broadcast-evidence.hu201.test.ts',
    line: 355,
    cite: ':316',
    verdict: 'OTRO',
    realTarget: 'src/services/fee-split.ts',
    reason: '«`settleFeeSplits` corta en el return temprano del `failed` (:316)», y `settleFeeSplits` vive en `fee-split.ts`. El propio `fee-split.ts:494` escribe las mismas dos líneas.',
  },
  {
    file: 'src/services/fee-settle-broadcast-evidence.hu201.test.ts',
    line: 356,
    cite: ':335',
    verdict: 'OTRO',
    realTarget: 'src/services/fee-split.ts',
    reason: 'El `priorTx` de la misma oración, también de `fee-split.ts`. ⚠️ Y el número no coincide con el que declara `fee-split.ts:494` para lo mismo (`:336`): uno de los dos está corrido, y nada lo cruza.',
  },
  {
    file: 'src/services/fee-split.ts',
    line: 494,
    cite: ':316',
    verdict: 'AUTO',
    reason: 'El return temprano de `settleFeeSplits`, en este mismo archivo. Ya declarada a mano en `CITED_LINES`.',
  },
  {
    file: 'src/services/fee-split.ts',
    line: 494,
    cite: ':336',
    verdict: 'AUTO',
    reason: 'El `priorTx` del mismo archivo. También declarada a mano.',
  },
  {
    file: 'src/services/llm/transform.ownership.test.ts',
    line: 10,
    cite: '`:234`',
    verdict: 'OTRO',
    realTarget: 'src/services/llm/transform.ts',
    reason: 'El párrafo de arriba lo dice entero —«`src/services/llm/transform.ts:234` es el `.eq(\'owner_ref\', ownerId)`»— pero queda del otro lado de una línea ` *` vacía, y el párrafo de `:234` no nombra nada.',
  },
  {
    file: 'src/services/orchestrate.test.ts',
    line: 3949,
    cite: ':557',
    verdict: 'AUTO',
    reason: '«el shape de pipeline.success NO cambian (regresión :557)»: abierta la 557 de este archivo, es `it(\'T-12: chargeProtocolFee invoked when pipeline.success=true\')`.',
  },
  {
    file: 'src/services/reputation.ts',
    line: 90,
    cite: '`:182-183`',
    verdict: 'AUTO',
    reason: '«acá `\'__anon__\'` se EXCLUYE (ver `:182-183`, CR MNR-2)»: el bucketing es de este archivo.',
  },
  {
    file: 'src/types/index.ts',
    line: 288,
    cite: '`:203-225`',
    verdict: 'AUTO',
    reason: '«están en el docblock de `AgentPaymentSpec.contract` (`:203-225`)», y ese tipo es de este archivo. Ya declarada a mano en `CITED_LINES`.',
  },
];
