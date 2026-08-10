/**
 * Las EXCEPCIONES del guardián `doc/sdd/_INDEX.md` ↔ `doc/sdd/NNN-…`.
 *
 * ⛔ NO SE GENERAN VOLCANDO LA SALIDA DEL GUARDIÁN. Cada entrada está escrita a mano
 * después de leer la fila y de medir por qué no tiene carpeta (o por qué el archivo que
 * linkea no está en git). Es la misma disciplina que
 * `test/ownership-filter-guard.exceptions.ts` explica en su header, y por el mismo motivo:
 * un artefacto derivado de la medición que consume deja el control verde **por
 * construcción**.
 *
 * El universo (qué carpetas existen, qué filas hay) NO se declara acá: se DERIVA de git y
 * del archivo. Lo único que se escribe a mano es la EXCUSA de un caso puntual, así que una
 * carpeta nueva o una fila nueva no puede quedar excusada sin que alguien lo escriba.
 *
 * Este archivo no lo typechequea nadie (`tsconfig.json:19` es `include: ["src/**\/*"]`) ni
 * lo lintea nadie (`package.json`: `biome check src/`), así que la forma de cada entrada se
 * valida en RUNTIME, en el control G-B3.
 */

export interface RowWithoutFolder {
  /** El valor exacto de la primera celda (`#`) de la fila. */
  readonly key: string;
  /** Por qué esa fila no tiene —y no debería tener— carpeta en `doc/sdd/`. */
  readonly reason: string;
}

/**
 * Filas de la tabla que NO apuntan a ninguna carpeta de `doc/sdd/`, con el motivo.
 *
 * Ojo con la asimetría, que es deliberada: el guardián exige que **cada entrada de acá se
 * use** (control G-B2). Si una de estas filas gana carpeta, o si desaparece, el guardián se
 * pone rojo y hay que borrar la entrada. Una lista de excusas que se pudre va perdiendo
 * alcance sin avisar.
 */
export const ROWS_WITHOUT_FOLDER: readonly RowWithoutFolder[] = [
  {
    key: '011',
    reason:
      'HU de abril 2026 (WKH-10, LLM planning) sin carpeta: medido con ' +
      '`git log --all --diff-filter=A -- "doc/sdd/011-*"`, que da 0 commits, o sea que la ' +
      'carpeta no existe hoy NI existió nunca en ninguna rama. La fila conserva su rama, ' +
      '`feat/wkh-10-llm-planner`.',
  },
  {
    key: '012',
    reason:
      'WKH-13 (`POST /orchestrate` completo), abril 2026: 0 commits agregando `doc/sdd/012-*` en ' +
      'todo el historial. Su evolutivo posterior SÍ tiene carpeta y es la fila `015` ' +
      '(`015-orchestrate-llm-planning`).',
  },
  {
    key: '016',
    reason:
      'Patch en modo FAST directo sobre `main` (`5a14ab8`, copiar `src/static/*` a `dist/static`); ' +
      'la evidencia del trabajo es ese commit. Verificado que la carpeta no existió nunca: ' +
      '`git log --all --diff-filter=A -- "doc/sdd/016-*"` da 0 commits. ' +
      '(Ojo: NO es que "el modo FAST no genera carpeta" — las filas `030` y `031` son FAST y sí ' +
      'la tienen. Lo que se afirma acá es sólo lo medido para esta fila.)',
  },
  {
    key: '020',
    reason:
      'Patch FAST sobre `main` (doc de contratos Kite + banner DEPRECATED en el spike). Carpeta ' +
      'inexistente en todo el historial: `git log --all --diff-filter=A -- "doc/sdd/020-*"` da 0.',
  },
  {
    key: '021',
    reason:
      'Patch FAST sobre `main` + repo `wasiai-landing` (pitch Fase 0): la mitad del trabajo no ' +
      'vive en este repo. Carpeta inexistente en todo el historial ' +
      '(`git log --all --diff-filter=A -- "doc/sdd/021-*"` da 0).',
  },
  {
    key: '136',
    reason:
      'Estado BACKLOG deliberado: WKH-142 nunca se ejecutó bajo este número. Su ejecución es ' +
      'la fila `143` (`143-wkh-142-negative-amount-guard`), que sí tiene carpeta. La fila `136` ' +
      'se conserva porque documenta el ticket y a dónde fue a parar.',
  },
  {
    key: '186',
    reason:
      'La propia celda lo declara: "Sin `doc/sdd/` propio: subset acotado de un ticket ya ' +
      'analizado, el registro vive en Jira" (WKH-175, merge `5a8fafa`).',
  },
  {
    key: '074',
    reason:
      'La carpeta `074-wkh-80-operator-identities-runbook/` EXISTE en el disco del autor pero ' +
      'su único archivo (`done-report.md`) está en el `.gitignore:172`: es un runbook de ' +
      'identidades de operador. En un clon la carpeta no existe, así que el universo derivado ' +
      'de git no la tiene. La fila se queda: la HU pasó.',
  },
  {
    key: '149',
    reason:
      'Mismo caso que `074`: los 4 archivos de `149-wkh-71-operator-wallet-alert/` están ' +
      'listados uno por uno en `.gitignore:177-180`, así que la carpeta no existe en un clon.',
  },
];

export interface UntrackedFolder {
  readonly folder: string;
  readonly reason: string;
}

/**
 * Carpetas que están en el disco y NO en git, permitidas.
 *
 * ⚠️ Asimetría deliberada y distinta de la de arriba: acá **no** se exige que la entrada se
 * use. Es la única lista del guardián cuyo estado depende del entorno — en CI
 * (`actions/checkout`) los archivos gitignoreados no se materializan, así que estas carpetas
 * no existen y la entrada queda sin usar. Exigir que se usen pondría el guardián rojo en CI
 * y verde local, que es exactamente la divergencia que no queremos.
 */
export const FOLDERS_UNTRACKED_BY_DESIGN: readonly UntrackedFolder[] = [
  {
    folder: '074-wkh-80-operator-identities-runbook',
    reason: 'Su único archivo está gitignoreado (`.gitignore:172`): runbook de identidades de operador.',
  },
  {
    folder: '149-wkh-71-operator-wallet-alert',
    reason: 'Sus 4 archivos están gitignoreados (`.gitignore:177-180`).',
  },
];

export interface UntrackedLink {
  readonly target: string;
  readonly reason: string;
}

/**
 * Links de la tabla cuyo destino existe en el disco del autor pero NO en git, permitidos.
 *
 * Son punteros que en un clon no resuelven. Se declaran uno por uno —y no con un patrón—
 * para que un link roto NUEVO siga poniendo el guardián rojo. Es DEUDA VISIBLE: si la lista
 * se encoge, mejor.
 */
export const LINKS_KNOWN_UNTRACKED: readonly UntrackedLink[] = [
  {
    target: '074-wkh-80-operator-identities-runbook/done-report.md',
    reason: '`.gitignore:172`. Ver la excepción de la fila `074`.',
  },
  {
    target: '084-wkh-69-passport-hybrid-inbound/done-report.md',
    reason: '`.gitignore:173`. La carpeta sí está en git por sus otros archivos.',
  },
  {
    target: '149-wkh-71-operator-wallet-alert/report.md',
    reason: '`.gitignore:178`. Ver la excepción de la fila `149`.',
  },
  {
    target: 'spike-kite-passport/poc-results.md',
    reason:
      '`.gitignore:184`. Ya está declarado como puntero roto pendiente de decisión en ' +
      '`test/docs-referenced-by-code-exist.test.ts` (`KNOWN_BROKEN_PENDING_DECISION`).',
  },
];

export interface CitedIndexLine {
  /** Archivo de `src/` que cita una línea de `_INDEX.md`. */
  readonly from: string;
  /** El número de línea citado. */
  readonly line: number;
  /** Textos que ESA línea tiene que seguir conteniendo para que la cita signifique algo. */
  readonly mustContain: readonly string[];
}

/**
 * Citas `doc/sdd/_INDEX.md:N` hechas desde `src/`, con lo que la línea tiene que decir.
 *
 * ⚠️ ESTO SE ESCRIBE A MANO A PROPÓSITO: es una afirmación sobre el mundo, no una lectura
 * del mundo. Derivar `mustContain` del contenido actual de la línea daría verde siempre,
 * incluso después de que un `git insert` corriera la tabla y la cita pasara a apuntar a
 * otra HU (que es justo el accidente que este control existe para cazar; ver
 * "Por qué la fila `023` está fuera de orden numérico" en `_INDEX.md`).
 *
 * El universo de citas, en cambio, SÍ se deriva: el guardián grepea `src/` y exige que toda
 * cita que encuentre esté declarada acá (control G-F2). Una cita nueva sin declarar = rojo.
 */
export const CITED_INDEX_LINES: readonly CitedIndexLine[] = [
  {
    from: 'src/lib/capability-risk.ts',
    line: 144,
    mustContain: ['remit.corridor-discovery', 'kyc-check', 'cashout-match'],
  },
  {
    from: 'src/lib/capability-risk.test.ts',
    line: 144,
    mustContain: ['remit.corridor-discovery', 'kyc-check', 'cashout-match'],
  },
];
