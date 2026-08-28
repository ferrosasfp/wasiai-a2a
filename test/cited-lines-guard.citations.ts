/**
 * El REGISTRO de citas `archivo:línea` del Corte A, escrito a mano.
 *
 * ⛔ NO SE GENERA VOLCANDO LA SALIDA DEL ESCÁNER. Cada `mustContain` y cada
 * `symbolPath` salió de ABRIR la línea citada y leerla. La razón no es
 * ceremonia: un registro derivado de la misma medición que consume deja el
 * control verde **por construcción** y no mide nada — es el mismo argumento que
 * `test/ownership-filter-guard.exceptions.ts` desarrolla en su cabecera. La
 * salida del escáner sirve como CHECKLIST de qué abrir; lo prohibido es que un
 * `mustContain` salga de un `console.log`, de un documento, o del número que el
 * propio guardián sugiere en su mensaje de `E-LINE_MOVED`.
 *
 * ── 🎯 EL INVARIANTE: ACÁ NO HAY `fromLine` ────────────────────────────────
 *
 * La clave de una entrada es `{from, cite}` — el archivo citador y el TOKEN
 * literal. La línea del citador NO se guarda: se DERIVA en cada corrida.
 *
 * Guardar `fromLine` sería construir, DENTRO del arreglo, el defecto que este
 * guardián arregla: un registro cuyas claves son números de línea del citador se
 * rompe con cualquier inserción en el citador, y esta HU existe precisamente
 * porque los números de línea no sobreviven a las ediciones — ni a las propias.
 *
 * Lo que se pierde a propósito: el «candado de largo» sobre los citadores (con
 * `fromLine`, toda inserción daba rojo). Ese rojo no señala nada falso, y su
 * fricción es lo que termina con alguien borrando el guardián.
 *
 * ⚠️ ACÁ HABÍA UNA PRECONDICIÓN FALSA Y UN ROJO PROMETIDO QUE NO OCURRE. Decía:
 * «hoy no hay dos tokens `cite` IGUALES dentro de un mismo citador del Corte A»
 * y «si mañana aparece un duplicado, `G-C4` se pone rojo y pide un campo `nth`».
 * Las dos mitades son falsas, y las dos se midieron sobre el commit que las
 * escribió: hay claves con más de una ocurrencia HOY, y duplicar un token a
 * propósito deja el guardián en verde. Es la clase de defecto que esta HU existe
 * para sacar, escrita adentro de la HU.
 *
 * LO QUE PASA DE VERDAD, que es una DECISIÓN y no un accidente: `{from, cite}`
 * es la clave, y UNA declaración cubre TODAS las ocurrencias de ese token en ese
 * citador — son la misma afirmación repetida (mismo archivo, misma línea, mismo
 * `mustContain`). `OCCURRENCES` agrupa por clave, así que un duplicado no mueve
 * el `size` ni pone nada rojo. El campo `nth` NO se implementa a propósito: un
 * índice posicional es la misma clase de dato frágil que este guardián existe
 * para no volver a guardar. Está desarrollado en el ítem 13 de la no-cobertura
 * del guardián, que es lo que hay que leer antes de apoyarse en esta clave.
 *
 * Cuántas claves tienen hoy más de una ocurrencia: al 2026-08-19 eran 3 (y esas
 * 4 ocurrencias de más son exactamente la diferencia entre los 57 tokens y las
 * 53 claves). ⚠️ ESE NÚMERO ES UNA FOTO y nada lo verifica: derivalo agrupando
 * `FOUND` por `{file, cite}` y contando los grupos de tamaño > 1. Si este
 * párrafo y esa derivación no coinciden, la que tiene razón es la derivación.
 *
 * Este archivo no lo typechequea nadie (`tsconfig.json:19` es
 * `include: ["src/**\/*"]`) ni lo lintea nadie (`package.json:11` es
 * `"lint": "biome check src/"`), así que la forma de cada entrada se valida en
 * RUNTIME, en `G-C8`.
 */

/** Una cita `archivo:línea` declarada, con lo que esa línea tiene que decir. */
export interface CitedLine {
  /** Archivo CITADOR (path relativo a la raíz, trackeado por git). */
  readonly from: string;
  /** El token literal, tal como está escrito. Ej: 'compose.ts:130' | '`:777`' | ':208'. */
  readonly cite: string;
  /** Path relativo del archivo apuntado, RESUELTO A MANO (DT-11). */
  readonly target: string;
  /** Línea 1-based dentro de `target`. Si el token es un rango A-B, esto es A. */
  readonly line: number;
  /** Fin del rango, si el token era `A-B`. `undefined` = cita de una línea. */
  readonly endLine?: number;
  /** Textos que la línea DEBE contener. CONJUNCIÓN. A mano, leyendo el código. */
  readonly mustContain: readonly string[];
  /** Camino de símbolos contenedor, de afuera hacia adentro (subsecuencia ordenada).
   *  `[]` SÓLO si el resolver no devuelve nada (target sin símbolos, o docblock de
   *  cabecera). El guard NO le cree al autor: lo compara contra el resolver. */
  readonly symbolPath: readonly string[];
  /** OBLIGATORIO cuando el token no nombra archivo (P3/P4) y `target` no es `from`. */
  readonly targetReason?: string;
}

/**
 * Los 14 archivos del Corte A. El universo es EXPLÍCITO a propósito: un archivo
 * nuevo no entra solo, y mientras no se amplíe esta lista el silencio sobre él
 * es real (ítem 10 de la no-cobertura).
 *
 * `src/lib/payment-spec-writer.ts` entra con CERO citas a propósito: es presión
 * hacia adelante a costo cero sobre el módulo de los 7 guards del bloque de pago
 * — la primera cita que alguien escriba ahí nace declarada o nace roja.
 */
export const CORTE_A_PATHS: readonly string[] = [
  'src/types/index.ts',
  'src/routes/agents.ts',
  'src/services/agent.ts',
  'src/services/agent.payment.test.ts',
  'src/routes/agents.publish.test.ts',
  'src/routes/agents.ownership.test.ts',
  'src/lib/operator-address.ts',
  'src/lib/payment-spec-writer.ts',
  'src/lib/payment-spec-reader.ts',
  'src/services/compose.ts',
  'src/services/fee-split.ts',
  'test/payment-guards-live-in-one-place.test.ts',
  'test/sdd-index-matches-folders.exceptions.ts',
  'CLAUDE.md',
];

/**
 * Un target cuyas citas ya tienen dueño en OTRO guardián.
 *
 * 🔴 EL DUEÑO NO ES PROSA: SE VERIFICA. `ownedBy` es la frase legible, y sola no
 * alcanza — una entrada con `ownedBy: 'NADIE'` y un motivo largo sacaba N citas
 * del universo con el guardián en 10/10 verde, porque `G-C9` sólo miraba que el
 * `target` estuviera trackeado y que el motivo tuviera 40 caracteres. Los campos
 * `ownerFiles` y `ownerControls` existen para que `G-C9` pueda ABRIR al dueño y
 * comprobar que existe, que sus controles siguen vivos, y que declara ESTE
 * target. Una delegación es la excusa MÁS BARATA de escribir y la que más citas
 * saca de una sola vez (medido: un `target` puede cubrir 4 claves), así que es
 * la que más tiene que costar.
 */
export interface DelegatedTarget {
  readonly target: string;
  /** El guardián que ya las verifica, con el archivo donde vive. Tiene que
   *  NOMBRAR al menos uno de los `ownerFiles`: prosa y máquina de acuerdo. */
  readonly ownedBy: string;
  /** Los archivos del guardián dueño, trackeados. Al menos uno `*.test.ts`, o
   *  sea un archivo que vitest CORRE — un dueño que no corre no es un dueño. */
  readonly ownerFiles: readonly string[];
  /** Literales que prueban que los controles dueños siguen existiendo. Cada uno
   *  tiene que aparecer en alguno de los `ownerFiles`. */
  readonly ownerControls: readonly string[];
  readonly reason: string;
}

/**
 * Targets que este guardián NO verifica porque ya los verifica otro.
 *
 * No es un hueco: es una DELEGACIÓN, y se declara para que no se lea igual. La
 * población de citas delegadas hoy es 0 (el Corte A no tiene ninguna cita a
 * `_INDEX.md`), y `G-C9` NO afirma que sea > 0 — eso sería un candado que se
 * pudre solo. Lo que `G-C9` afirma es que el DUEÑO sigue vivo y que es el dueño
 * de ESTE target: si alguien borra `G-F2`, las citas a `_INDEX.md` quedarían sin
 * dueño y `G-C4` las descartaría en silencio.
 */
export const DELEGATED_TARGETS: readonly DelegatedTarget[] = [
  {
    target: 'doc/sdd/_INDEX.md',
    ownedBy:
      'G-F1/G-F2 en test/sdd-index-matches-folders.test.ts, con el registro ' +
      'CITED_INDEX_LINES en test/sdd-index-matches-folders.exceptions.ts',
    ownerFiles: [
      'test/sdd-index-matches-folders.test.ts',
      'test/sdd-index-matches-folders.exceptions.ts',
    ],
    ownerControls: ["it('G-F1", "it('G-F2", 'export const CITED_INDEX_LINES'],
    reason:
      'Las citas `doc/sdd/_INDEX.md:N` ya tienen testigo con precisión de línea: ' +
      '`CITED_INDEX_LINES` en `test/sdd-index-matches-folders.exceptions.ts` declara el ' +
      '`mustContain` de cada una, `G-F1` verifica que la línea siga diciéndolo y `G-F2` ' +
      'deriva el universo de citas de `src/` y se pone rojo ante una sin declarar. ' +
      'Re-verificarlas acá sería el duplicado exacto que ' +
      '`test/payment-guards-live-in-one-place.test.ts` existe para prevenir: dos criterios ' +
      'que coinciden el día que se escriben y divergen en la próxima corrección de borde.',
  },
];

/**
 * El registro. Una entrada por cita del Corte A.
 *
 * Orden: por archivo citador, en el orden de `CORTE_A_PATHS`.
 */
export const CITED_LINES: readonly CitedLine[] = [
  // ── src/types/index.ts ───────────────────────────────────────────────────
  {
    from: 'src/types/index.ts',
    cite: 'downstream-payment.ts:772',
    target: 'src/lib/downstream-payment.ts',
    line: 772,
    mustContain: ['const payToCheck', 'validatePayTo(agent.payment.contract)'],
    symbolPath: ['signAndSettleDownstream'],
  },
  {
    // 🔴 CORREGIDA en esta HU: decía `:777`, y `:777` es
    // `contract: agent.payment.contract,` dentro del objeto de un `logger.warn`
    // — o sea NO es «lo firma como `to`». El ancla real es `:922`.
    from: 'src/types/index.ts',
    cite: '`:922`',
    target: 'src/lib/downstream-payment.ts',
    line: 922,
    mustContain: ['to: payToCheck.addr'],
    symbolPath: ['signAndSettleDownstream'],
    targetReason:
      'El token es un `:N` suelto; el archivo lo nombra la MISMA oración, una frase antes: ' +
      '«`downstream-payment.ts:772` lo pasa por `validatePayTo` y `:922` lo firma como `to`».',
  },
  {
    from: 'src/types/index.ts',
    cite: 'downstream-payment.ts:711-735',
    target: 'src/lib/downstream-payment.ts',
    line: 711,
    endLine: 735,
    mustContain: ['findChainEnvironmentDrift({ chainKey, destination })'],
    symbolPath: ['signAndSettleDownstream'],
  },
  {
    from: 'src/types/index.ts',
    cite: 'lib/payment-spec-reader.ts:212-213',
    target: 'src/lib/payment-spec-reader.ts',
    line: 212,
    endLine: 213,
    mustContain: ["network: isMainnetChainKey(chainKey)"],
    symbolPath: ['readPaymentSpec'],
  },
  {
    // AUTO-CITA, y el rango CONTIENE la línea 207 que esta misma HU editó. Es
    // la víctima concreta de la regla de neutralidad: una línea de más en `:207`
    // corre el final del rango y esta entrada se pone roja sola.
    //
    // El `symbolPath` NO es decoración acá: `EL NOMBRE MIENTE` aparece DOS veces
    // en este archivo (`:204` y `:286`), y lo que las separa es el tipo
    // contenedor — `AgentPaymentSpec` vs `AgentPaymentSpecInput`. Sin ámbito,
    // esta cita sería indeclarable.
    from: 'src/types/index.ts',
    cite: '`:203-225`',
    target: 'src/types/index.ts',
    line: 203,
    endLine: 225,
    mustContain: ['EL NOMBRE MIENTE'],
    symbolPath: ['AgentPaymentSpec', 'contract'],
  },
  {
    from: 'src/types/index.ts',
    cite: 'services/agent.ts:481',
    target: 'src/services/agent.ts',
    line: 481,
    mustContain: ['Defense-in-depth (CD-1)', 're-validar la URL'],
    symbolPath: ['publishedAgentService', 'publish'],
  },
  {
    // 🔴 CORREGIDA en esta HU: decía `reputation.ts:182-183`, y `:182` es la
    // COLA de un comentario («del atacante en 2 identidades reales…»), no el
    // guard. El ancla real es `:189`, que es donde se excluye el bucket.
    from: 'src/types/index.ts',
    cite: 'reputation.ts:189',
    target: 'src/services/reputation.ts',
    line: 189,
    mustContain: ['ANON_CALLER_BUCKET', 'failedCallers.add'],
    symbolPath: ['accumulateRow'],
  },
  {
    from: 'src/types/index.ts',
    cite: '20260401000000_kite_registries.sql:44-66',
    target: 'supabase/migrations/20260401000000_kite_registries.sql',
    line: 44,
    endLine: 66,
    mustContain: ['"reputation": "erc8004.reputation_score"'],
    symbolPath: [],
  },
  {
    // 🔴 CORREGIDA en esta HU, y el ARCHIVO también estaba mal: decía
    // `compose.ts:130`. Hay DOS `compose.ts` en el índice de git;
    // `src/routes/compose.ts:130` es `/**` y `src/services/compose.ts:130` es
    // prosa sobre el over-fetch. El guard anti-doble-débito vive en
    // `src/services/compose.ts:634` (era `:571` hasta WKH-335, que insertó un
    // import y un helper por encima). Es el caso que `E-WRONG_FILE` existe para
    // explicar: buscar `i > 0` en `src/routes/compose.ts` da CERO.
    //
    // ⚠️ RE-APUNTADA TRES veces sin que el guard se moviera NUNCA: `:602` →
    // `:616` en el fix-pack AR de WKH-225, y `:616` → `:634` al MERGEAR la 225
    // sobre main. Lo corrieron, en ese orden, las 14 líneas de comentario del
    // `preSpentUsd` que se agregaron al guard de presupuesto DOCE líneas más
    // arriba en la misma función, y después los cambios de WKH-335/WKH-364 que
    // main traía por encima. La línea sigue byte-idéntica a `5578998:571`.
    //
    // 🎯 EL MERGE ES EL CASO MÁS FILOSO DE ESTA CLASE, y por qué: las dos ramas
    // movieron `src/services/compose.ts` y cada una re-apuntó esta cita a SU
    // propio número (main `:589`, la rama de la 225 `:616`). En el árbol
    // mergeado, que tiene los DOS conjuntos de cambios, NINGUNO de los dos
    // lados es correcto: el ancla cae en una tercera línea que no existe en
    // ninguna de las dos ramas por separado. O sea que resolver el conflicto
    // eligiendo un lado —lo que uno hace por default, y compila igual— deja una
    // cita que MIENTE, con el merge reportado como limpio. El `:634` se DERIVÓ
    // buscando `if (i > 0 && scopingKeyRow` en el archivo YA mergeado; no se
    // eligió ningún lado. Es el caso del auto-blindaje "las citas que rompés
    // vos al arreglar otra cosa", acá sin que nadie edite la cita.
    from: 'src/types/index.ts',
    cite: 'src/services/compose.ts:634',
    target: 'src/services/compose.ts',
    line: 634,
    mustContain: ['if (i > 0 &&', 'scopingKeyRow'],
    symbolPath: ['composeService', 'executePipeline'],
  },

  // ── src/routes/agents.ts ─────────────────────────────────────────────────
  {
    // 🔴 CORREGIDA en esta HU: decía `registries.ts:35`, que es
    // `requireA2AKeyPresence,` — un SPECIFIER DE IMPORT, no un helper. El
    // resolver devuelve `null` ahí y `mapOwnershipError` en el ancla real `:94`:
    // el camino de símbolos no sólo discrimina, además dice por qué.
    // ⚠️ RE-APUNTADA el 2026-08-26 (WKH-366 fix-pack): `94` → `114`. NO la movió
    // una edición sobre `mapOwnershipError` —su cuerpo no cambió un byte— sino la
    // reserva de namespace que entró 20 líneas ARRIBA, en `validateRegisterBody`.
    // Verificado ABRIENDO `src/routes/registries.ts:114`, no copiando el número
    // que sugirió el guard.
    from: 'src/routes/agents.ts',
    cite: 'registries.ts:114',
    target: 'src/routes/registries.ts',
    line: 114,
    mustContain: ['async function ', 'mapOwnershipError('],
    symbolPath: ['mapOwnershipError'],
  },
  {
    from: 'src/routes/agents.ts',
    cite: 'src/lib/discovery-query.ts:219-229',
    target: 'src/lib/discovery-query.ts',
    line: 219,
    endLine: 229,
    mustContain: ['hacia la respuesta'],
    symbolPath: [],
  },

  // ── src/services/compose.ts ──────────────────────────────────────────────
  {
    from: 'src/services/compose.ts',
    cite: 'src/routes/compose.ts:90-104',
    target: 'src/routes/compose.ts',
    line: 90,
    endLine: 104,
    mustContain: ['function deriveComposeDestination(resolved'],
    symbolPath: ['deriveComposeDestination'],
  },
  {
    // 🔴 CORREGIDA en esta HU: decía `:208`, que es prosa sobre el `intentId`
    // del leg Solana. Es la cita del guard anti-doble-débito del camino del
    // dinero, y es INVISIBLE a las tres formas del criterio original porque se
    // escribe sin backticks. Apareció sólo al agregar la cuarta forma.
    //
    // ⚠️ La afirmación de fondo de la prosa era CORRECTA: `stepDebitedUsd` vale
    // 0 para `i === 0`. Lo único falso era el número — que es exactamente el
    // modo de falla que hace que «abrir y comparar» confirme la mentira.
    //
    // ⚠️ RE-APUNTADA de `:602` a `:616` en el fix-pack AR de WKH-225, y de
    // `:616` a `:634` al mergear la 225 sobre main (donde esta misma cita decía
    // `:589`), por el mismo desplazamiento que la entrada de arriba y con la
    // misma derivación contra `if (i > 0 && scopingKeyRow` en el árbol ya
    // mergeado. El guard no se tocó en ninguna de las tres.
    from: 'src/services/compose.ts',
    cite: ':634',
    target: 'src/services/compose.ts',
    line: 634,
    mustContain: ['if (i > 0 &&', 'scopingKeyRow'],
    symbolPath: ['composeService', 'executePipeline'],
  },
  {
    // Cita ENTRANTE a `src/types/index.ts`, y la SEGUNDA víctima de la
    // neutralidad: `:207` (editada en esta HU) está ANTES de `:217-218`, así que
    // una línea de más allá corre este target.
    from: 'src/services/compose.ts',
    cite: 'types/index.ts:217-218',
    target: 'src/types/index.ts',
    line: 217,
    endLine: 218,
    mustContain: ['cambio de contrato con costo para terceros'],
    symbolPath: ['AgentPaymentSpec', 'contract'],
  },
  {
    from: 'src/services/compose.ts',
    cite: 'adapters/kite-ozone/payment.ts:279',
    target: 'src/adapters/kite-ozone/payment.ts',
    line: 279,
    mustContain: ['const pk = process.env.OPERATOR_PRIVATE_KEY'],
    symbolPath: ['getWalletClient'],
  },
  {
    from: 'src/services/compose.ts',
    cite: 'discovery.ts:529',
    target: 'src/services/discovery.ts',
    line: 529,
    mustContain: ['max_spend_per_call_usd', 'rama 4 de checkScoping'],
    symbolPath: ['discoveryService', 'runDiscoveryPipeline'],
  },

  // ── src/services/agent.payment.test.ts ───────────────────────────────────
  {
    // La cita ideal (DT-3): la línea citada ES la FIRMA de la función. Una firma
    // no se puede confundir con otra línea del archivo y sobrevive a cualquier
    // edición del cuerpo. Es el precedente del paso 2 de la escalera.
    from: 'src/services/agent.payment.test.ts',
    cite: 'downstream-payment.ts:247',
    target: 'src/lib/downstream-payment.ts',
    line: 247,
    mustContain: ['async function settleSolanaLeg('],
    symbolPath: ['settleSolanaLeg'],
  },

  // ── test/sdd-index-matches-folders.exceptions.ts ─────────────────────────
  {
    // ✅ CORRECTA — NO SE TOCA. El SDD de esta HU la declaró falsa (decía que
    // `:19` era `"sourceMap": true` y que el `include` estaba en `:20`) y las
    // dos afirmaciones son falsas: `:17` es `"sourceMap"` y `:20` es
    // `"exclude"`. Aplicar esa «corrección» habría metido una cita FALSA dentro
    // de la HU que existe para sacarlas. Medido con cuatro instrumentos, uno de
    // ellos `git show HEAD:tsconfig.json` con `git status --porcelain` vacío.
    //
    // Y de paso es el mejor caso del camino `symbolPath: []`: target `.json`,
    // sin símbolos TS, con una needle que es única por sí sola.
    from: 'test/sdd-index-matches-folders.exceptions.ts',
    cite: 'tsconfig.json:19',
    target: 'tsconfig.json',
    line: 19,
    mustContain: ['"include"'],
    symbolPath: [],
  },
  {
    // 🔴 CORREGIDA: decía `.gitignore:172`, que es
    // `/doc/investors/30-60-90-traction-plan.md` — nada que ver con un runbook
    // de identidades de operador. Las CINCO citas a `.gitignore` de este archivo
    // estaban corridas exactamente +13 líneas: una inserción de bloque las
    // invalidó a todas de una vez, y ningún instrumento del repo podía verlas
    // porque `.gitignore` es un dotfile y los escáneres previos exigían un
    // nombre antes del punto de la extensión.
    from: 'test/sdd-index-matches-folders.exceptions.ts',
    cite: '.gitignore:185',
    target: '.gitignore',
    line: 185,
    mustContain: ['/doc/sdd/074-wkh-80-operator-identities-runbook/done-report.md'],
    symbolPath: [],
  },
  {
    from: 'test/sdd-index-matches-folders.exceptions.ts',
    cite: '.gitignore:186',
    target: '.gitignore',
    line: 186,
    mustContain: ['/doc/sdd/084-wkh-69-passport-hybrid-inbound/done-report.md'],
    symbolPath: [],
  },
  {
    from: 'test/sdd-index-matches-folders.exceptions.ts',
    cite: '.gitignore:190-193',
    target: '.gitignore',
    line: 190,
    endLine: 193,
    mustContain: ['/doc/sdd/149-wkh-71-operator-wallet-alert/auto-blindaje.md'],
    symbolPath: [],
  },
  {
    from: 'test/sdd-index-matches-folders.exceptions.ts',
    cite: '.gitignore:191',
    target: '.gitignore',
    line: 191,
    mustContain: ['/doc/sdd/149-wkh-71-operator-wallet-alert/report.md'],
    symbolPath: [],
  },
  {
    from: 'test/sdd-index-matches-folders.exceptions.ts',
    cite: '.gitignore:197',
    target: '.gitignore',
    line: 197,
    mustContain: ['/doc/sdd/spike-kite-passport/poc-results.md'],
    symbolPath: [],
  },

  // ── src/lib/operator-address.ts ──────────────────────────────────────────
  {
    from: 'src/lib/operator-address.ts',
    cite: '`:1-16`',
    target: 'src/adapters/registry.ts',
    line: 1,
    endLine: 16,
    mustContain: ["import { getLogger } from '../lib/logger.js';"],
    symbolPath: [],
    targetReason:
      'El archivo lo nombra la MISMA oración, dos palabras antes: «es exactamente lo que ' +
      'evita `src/adapters/registry.ts`, cuyos imports de top-level (`:1-16`)».',
  },
  {
    from: 'src/lib/operator-address.ts',
    cite: '../adapters/solana/chain.ts:84',
    target: 'src/adapters/solana/chain.ts',
    line: 84,
    mustContain: ['export function getSolanaOperatorKeypair(): Keypair'],
    symbolPath: ['getSolanaOperatorKeypair'],
  },
  {
    from: 'src/lib/operator-address.ts',
    cite: '`:95`',
    target: 'src/adapters/solana/chain.ts',
    line: 95,
    mustContain: ["'solana operator loaded'"],
    symbolPath: ['getSolanaOperatorKeypair'],
    targetReason:
      'El archivo lo nombra la línea inmediatamente anterior del mismo docblock ' +
      '(`getSolanaOperatorKeypair()` (`../adapters/solana/chain.ts:84`)), y las tres citas ' +
      'de esa oración —`:84`, `:95`, `:137-149`— hablan del mismo archivo.',
  },
  {
    from: 'src/lib/operator-address.ts',
    cite: '`:137-149`',
    target: 'src/adapters/solana/chain.ts',
    line: 137,
    endLine: 149,
    mustContain: ['is not the solana operator pubkey'],
    symbolPath: ['getSolanaOperatorKeypair'],
    targetReason:
      'Misma oración que `:95`: el sujeto es `getSolanaOperatorKeypair()`, nombrado con su ' +
      'archivo dos líneas antes. Ancla la aserción de coherencia depósito↔operador que LANZA, ' +
      'que es justamente lo que el docblock del citador promete atrapar.',
  },
  {
    from: 'src/lib/operator-address.ts',
    cite: '../adapters/deposit-verifier.ts:167-175',
    target: 'src/adapters/deposit-verifier.ts',
    line: 167,
    endLine: 175,
    mustContain: ['const pk = process.env.OPERATOR_PRIVATE_KEY'],
    symbolPath: ['resolveTreasury'],
  },
  {
    from: 'src/lib/operator-address.ts',
    cite: '../adapters/solana/chain.ts:81-82',
    target: 'src/adapters/solana/chain.ts',
    line: 81,
    endLine: 82,
    mustContain: ['NUNCA loguea el secret'],
    symbolPath: ['getSolanaOperatorKeypair'],
  },

  // ── src/routes/agents.publish.test.ts ────────────────────────────────────
  //
  // Los tres primeros llevan excepción de UNICIDAD, y el motivo está escrito en
  // `cited-lines-guard.exceptions.ts`: la línea del guard del POST es IDÉNTICA
  // byte a byte a la del guard del PATCH. Las citas NO están mal —`:220` ES
  // `{ field: 'priceUsdc' }` y ES el guard del POST—, así que «corregirlas» sería
  // meter una cita falsa para que la herramienta quede contenta.
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: '`:220`',
    target: 'src/routes/agents.ts',
    line: 220,
    mustContain: ["{ field: 'priceUsdc' }"],
    symbolPath: ['agentsRoutes'],
    targetReason:
      'El archivo lo nombra la misma oración: «Los 5 guards hermanos de `routes/agents.ts` ' +
      '(`priceUsdc` `:220`, `payoutWallet` `:237`, …)».',
  },
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: '`:237`',
    target: 'src/routes/agents.ts',
    line: 237,
    mustContain: ["{ field: 'payoutWallet' }"],
    symbolPath: ['agentsRoutes'],
    targetReason:
      'Segundo de los 5 guards hermanos enumerados en esa oración, que nombra ' +
      '`routes/agents.ts` una vez para los cinco.',
  },
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: '`:252`',
    target: 'src/routes/agents.ts',
    line: 252,
    mustContain: ["{ field: 'referrerRef' }"],
    symbolPath: ['agentsRoutes'],
    targetReason:
      'Tercero de los 5 guards hermanos de la misma enumeración; el archivo se nombra una ' +
      'sola vez, al principio de la lista.',
  },
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: '`:459`',
    target: 'src/routes/agents.ts',
    line: 459,
    mustContain: ["{ field: 'enabled' }"],
    symbolPath: ['agentsRoutes'],
    targetReason:
      'Cuarto de los 5 guards hermanos. A diferencia de los tres primeros, este `field` ' +
      'aparece UNA sola vez en el archivo, así que no necesita excepción de unicidad.',
  },
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: '`:475`',
    target: 'src/routes/agents.ts',
    line: 475,
    mustContain: ["{ field: 'capabilities' }"],
    symbolPath: ['agentsRoutes'],
    targetReason:
      'Quinto y último de los guards hermanos enumerados en esa oración. También único en ' +
      'el archivo.',
  },
  {
    from: 'src/routes/agents.publish.test.ts',
    cite: 'src/middleware/forward-key.test.ts:204-232',
    target: 'src/middleware/forward-key.test.ts',
    line: 204,
    endLine: 232,
    mustContain: ['const logs: Array<{ forwardSource'],
    symbolPath: ['AC-6: x-wasiai-source logged via pino, no routing effect'],
  },

  // ── src/routes/agents.ownership.test.ts (las tres son AUTO-CITAS) ────────
  {
    from: 'src/routes/agents.ownership.test.ts',
    cite: '`:72`',
    target: 'src/routes/agents.ownership.test.ts',
    line: 72,
    mustContain: ['state.eqCalls.push([col, val])'],
    symbolPath: ['eq'],
  },
  {
    from: 'src/routes/agents.ownership.test.ts',
    cite: '`:76-77`',
    target: 'src/routes/agents.ownership.test.ts',
    line: 76,
    endLine: 77,
    mustContain: ['maybeSingle: () => Promise.resolve({ data: state.row'],
    symbolPath: ['maybeSingle'],
  },
  {
    from: 'src/routes/agents.ownership.test.ts',
    cite: 'src/services/agent.ts:890',
    target: 'src/services/agent.ts',
    line: 890,
    // `if (existing.owner_ref !== ownerRef)` aparece DOS veces (`:715` y `:890`).
    // Lo que las separa es el método contenedor: `update` vs `delete`. Otro caso
    // donde el camino de símbolos es lo que hace la unicidad satisfacible.
    // ⚠️ Los dos números de arriba son PROSA y ningún guardián los mira: eran `:633`
    // y `:808`, correctos hasta que esta misma HU desplazó la región DOS veces. Se re-derivan
    // abriendo la línea, nunca sumándole el delta de una pasada anterior.
    mustContain: ['if (existing.owner_ref !== ownerRef)'],
    symbolPath: ['publishedAgentService', 'delete'],
  },
  {
    from: 'src/routes/agents.ownership.test.ts',
    cite: 'src/services/agent.ts:904',
    target: 'src/services/agent.ts',
    line: 904,
    // `.eq('owner_ref', ownerRef)` aparece CINCO veces en el archivo; dentro de
    // `delete` una sola.
    mustContain: [".eq('owner_ref', ownerRef)"],
    symbolPath: ['publishedAgentService', 'delete'],
  },
  {
    from: 'src/routes/agents.ownership.test.ts',
    cite: '`:211`',
    target: 'src/routes/agents.ownership.test.ts',
    line: 211,
    mustContain: ['T-143B-06: owner PATCH own slug with payoutWallet'],
    // El bloque `describe`, no el `it`: el segmento del `it` que el resolver
    // devuelve es el nombre COMPLETO del test, y la comparación de subsecuencia
    // es por IGUALDAD de segmento — un prefijo no matchea. Declarar el
    // `describe` además aporta información INDEPENDIENTE de la needle, que ya es
    // el nombre del test.
    symbolPath: ['agents routes \u2014 ownership / anti-IDOR (WKH-134)'],
  },

  // ── src/lib/payment-spec-reader.ts ───────────────────────────────────────
  {
    // 🔴 CORREGIDA en esta HU: decía `discovery.ts:23`, que es un `import {`
    // abriendo el import de `../lib/discovery-sources.js` — NO el de
    // `publishedAgentService`, que está en `:63`. La afirmación de fondo (que
    // `discovery.ts` importa `publishedAgentService` de `agent.ts`, y que por eso
    // exportar el lector desde ahí habría creado un ciclo) es CORRECTA.
    from: 'src/lib/payment-spec-reader.ts',
    cite: 'discovery.ts:63',
    target: 'src/services/discovery.ts',
    line: 63,
    mustContain: ["import { publishedAgentService } from './agent.js';"],
    symbolPath: [],
  },
  {
    from: 'src/lib/payment-spec-reader.ts',
    cite: 'downstream-payment.ts:772-777',
    target: 'src/lib/downstream-payment.ts',
    line: 772,
    endLine: 777,
    mustContain: ['const payToCheck', 'validatePayTo(agent.payment.contract)'],
    symbolPath: ['signAndSettleDownstream'],
  },

  // ── src/services/fee-split.ts (las dos son AUTO-CITAS) ───────────────────
  {
    from: 'src/services/fee-split.ts',
    cite: ':316',
    target: 'src/services/fee-split.ts',
    line: 316,
    mustContain: ['const failed = chargeable.find'],
    symbolPath: ['settleFeeSplits'],
  },
  {
    // 🔴 CORREGIDA en esta HU: decía `:335`, que es
    // `if (inProgress) settlement.inProgress = true;` — no menciona `priorTx`.
    // `priorTx` se declara en `:336`. La conclusión de la prosa (que un leg
    // `failed` corta antes y nunca llega ahí) sigue siendo cierta: el return
    // temprano está en `:320`.
    from: 'src/services/fee-split.ts',
    cite: ':336',
    target: 'src/services/fee-split.ts',
    line: 336,
    mustContain: ['const priorTx = chargeable.find'],
    symbolPath: ['settleFeeSplits'],
  },

  // ── test/payment-guards-live-in-one-place.test.ts ────────────────────────
  // ⚠️ Se DECLARAN sus dos citas; NO se toca un solo assert de ese archivo. Es
  // el guardián cuyo `codeOnly` crea el agujero que éste cierra, y romperlo
  // cambiaría un agujero de documentación por uno en un guard del camino del
  // dinero.
  {
    from: 'test/payment-guards-live-in-one-place.test.ts',
    cite: '`:66`',
    target: 'src/routes/agents.ts',
    line: 66,
    mustContain: ['The x402 anonymous path cannot publish'],
    symbolPath: ['a2aKeyRequired'],
    targetReason:
      'El archivo lo nombra la misma oración: «`routes/agents.ts` menciona `x402` en un ' +
      'mensaje de error de auth (`:66`) y `getInitializedChainKeys()` en un comentario (`:124`)».',
  },
  {
    from: 'test/payment-guards-live-in-one-place.test.ts',
    cite: '`:124`',
    target: 'src/routes/agents.ts',
    line: 124,
    mustContain: ['getInitializedChainKeys()'],
    symbolPath: ['paymentRejectionBody'],
    targetReason:
      'Segunda cita de esa misma oración, que nombra `routes/agents.ts` una vez para las ' +
      'dos. Ancla el comentario que obliga a `codeOnly` a existir.',
  },

  // ── src/services/agent.ts ────────────────────────────────────────────────
  {
    from: 'src/services/agent.ts',
    cite: 'discovery.ts:449',
    target: 'src/services/discovery.ts',
    line: 449,
    mustContain: ["allAgents.filter((a) => a.status === 'active')"],
    symbolPath: ['discoveryService', 'runDiscoveryPipeline'],
  },

  // ── CLAUDE.md ────────────────────────────────────────────────────────────
  {
    // EL CASO QUE FUERZA EL `symbolPath`: `owner_ref: string;` aparece 66 veces
    // en el archivo de tipos generado. Sin ámbito, esta cita —correcta,
    // normativa, y del criterio de seguridad del repo— sería INDECLARABLE.
    from: 'CLAUDE.md',
    cite: 'src/types/database.types.ts:2567',
    target: 'src/types/database.types.ts',
    line: 2567,
    mustContain: ['owner_ref: string;'],
    symbolPath: ['registries', 'Row', 'owner_ref'],
  },
  {
    // ⚠️ RE-APUNTADAS el 2026-08-26 (WKH-366 fix-pack): `172`→`225` y `174`→`227`.
    // `registryService.list` no cambió una línea; lo que la corrió es el bloque
    // `RESERVED_REGISTRY_IDS`, 53 líneas más arriba en el mismo archivo. Es la
    // trampa que este guard existe para cazar: la cita la rompe la edición que
    // DESPLAZA, no la que toca el sitio citado. Verificado abriendo `:225`/`:227`.
    from: 'CLAUDE.md',
    cite: 'src/services/registry.ts:225',
    target: 'src/services/registry.ts',
    line: 225,
    mustContain: ['async list(): Promise<RegistryPublic[]>'],
    symbolPath: ['registryService', 'list'],
  },
  {
    from: 'CLAUDE.md',
    cite: '`:227`',
    target: 'src/services/registry.ts',
    line: 227,
    // `.from('registries')` aparece 6 veces; dentro de `list` una sola.
    mustContain: [".from('registries')"],
    symbolPath: ['registryService', 'list'],
    targetReason:
      'El archivo lo nombra la misma oración, una cláusula antes: «(`registryService.list`, ' +
      '`src/services/registry.ts:225`, cadena en `:227`)».',
  },
];
