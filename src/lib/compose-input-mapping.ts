/**
 * Compose Input Mapping — WKH-305 · `inputFromPrevious`, PURO.
 *
 * Qué resuelve: un step de `/compose` puede declarar
 * `inputFromPrevious: { claveDestino: claveOrigen }` y el gateway puebla
 * `input[claveDestino]` con `salidaDelStepAnterior[claveOrigen]`. Es plomería
 * determinística: UN lookup de UNA clave de primer nivel por entrada. No hay
 * dot-paths, ni JSONPath, ni expresiones, ni defaults, ni acceso a un step que no
 * sea el INMEDIATAMENTE anterior (CD-1/CD-4).
 *
 * ⚠️ DÓNDE CORRE ESTO Y POR QUÉ IMPORTA — los dos call-sites son PRE-COBRO:
 *   · `lib/compose-step-shape.ts` → `validateComposeBody` → el preHandler
 *     `validateComposeBodyHandler` de `routes/compose.ts`, que corre ANTES de
 *     `resolveComposePriceHandler` y ANTES de `requirePaymentOrA2AKey`. Un body
 *     con un mapeo malformado se rechaza con 400 SIN débito y SIN discovery.
 *   · `services/compose.ts` → `resolveStepInput`, invocado ANTES del bloque de
 *     débito per-step del loop. Un mapeo irresoluble aborta el step SIN cobrarlo.
 * La segunda no es redundante: el schema de `POST /orchestrate/execute` no
 * declara `additionalProperties: false`, así que un `inputFromPrevious`
 * malformado puede llegar al service sin haber pasado nunca por el borde HTTP.
 * Por eso el resolvedor revalida la forma él mismo, fail-closed (R3).
 *
 * Módulo LEAF (sólo `import type`), por el mismo motivo documentado en
 * `lib/compose-limits.ts` y `lib/downstream-skip-code.ts`: media docena de suites
 * mockean los módulos gordos del money-path COMPLETOS con factories sin
 * `importOriginal`, así que una función importada desde uno de ellos llega
 * `undefined` bajo test. Un archivo sin dependencias no lo moquea nadie.
 *
 * Nunca lanza: devuelve `null` o una unión discriminada.
 */

/**
 * Tope de entradas por mapeo. Subirlo agranda la superficie de un body hostil:
 * cada entrada es un lookup más sobre la salida de un tercero y una clave más que
 * el gateway escribe en el body que le manda al agente.
 */
export const MAX_INPUT_MAPPING_ENTRIES = 8;

/**
 * Largo máximo de una clave (destino u origen). Acota el tamaño de los nombres
 * que el gateway copia al body downstream y al mensaje de error público.
 */
export const MAX_INPUT_MAPPING_KEY_LEN = 128;

/**
 * Claves prohibidas como DESTINO y como ORIGEN (CD-6, anti prototype-pollution).
 * Idiom del repo: `adapters/chain-resolver.ts` (lookup con `Object.hasOwn` sobre
 * un record de prototipo nulo).
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Clave destino reservada: la escribe `passOutput` con el objeto ENTERO de la
 * salida anterior. Si el mapeo también pudiera apuntarle, habría dos escritores
 * del mismo campo y el ganador dependería del orden del spread.
 */
const RESERVED_DEST_KEY = 'previousOutput';

/** Problema de FORMA, sin índice de step (lo agrega el caller). */
export type MappingShapeProblem = {
  /** Texto sin prefijo de step, p. ej. "'inputFromPrevious' must be an object". */
  detail: string;
  /** Clave destino que disparó el problema, si aplica. */
  field?: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reglas S2..S7 sobre un `inputFromPrevious` crudo + el `input` del step.
 * `undefined` (S1) → `null` (forma válida: no declara mapeo).
 *
 * ÚNICA definición de las reglas de forma. La llaman los DOS call-sites.
 *
 * `stepInput` sólo se usa para S7 (colisión del destino con una clave que el
 * llamador ya puso). Se salta si no es un objeto plano — es decir, pasarle
 * `undefined` evalúa S2..S6 y omite S7. Eso es lo que hace `applyMappingTo` en el
 * retry adaptativo, donde la base NO es el input declarado por el llamador sino
 * uno regenerado que YA lleva el campo mapeado y cuya sobreescritura es el punto.
 */
export function checkMappingShape(
  mapping: unknown,
  stepInput: unknown,
): MappingShapeProblem | null {
  // S1: ausente → no activa ninguna lógica nueva.
  if (mapping === undefined) return null;

  // S2: objeto no nulo y NO array (un array no puede expresar destino→origen).
  if (!isPlainObject(mapping)) {
    return { detail: `'inputFromPrevious' must be a non-array object` };
  }

  const keys = Object.keys(mapping);

  // S3: `{}` se RECHAZA. Un mapeo que no mapea nada es un error del llamador, no
  // un no-op — mismo criterio que `constraints` en `compose-step-shape.ts`: un
  // parámetro que el que pide cree tener y el servidor descarta en silencio.
  if (keys.length === 0) {
    return {
      detail: `'inputFromPrevious' must declare at least one field mapping`,
    };
  }
  if (keys.length > MAX_INPUT_MAPPING_ENTRIES) {
    return {
      detail: `'inputFromPrevious' accepts at most ${MAX_INPUT_MAPPING_ENTRIES} entries`,
    };
  }

  for (const dest of keys) {
    const source = mapping[dest];

    // S4: clave y valor strings no vacíos y acotados.
    if (
      dest.length === 0 ||
      dest.length > MAX_INPUT_MAPPING_KEY_LEN ||
      typeof source !== 'string' ||
      source.length === 0 ||
      source.length > MAX_INPUT_MAPPING_KEY_LEN
    ) {
      return {
        detail: `'inputFromPrevious' keys and values must be non-empty strings of at most ${MAX_INPUT_MAPPING_KEY_LEN} characters`,
        field: dest,
      };
    }

    // S5: ni destino ni origen pueden ser `__proto__`/`constructor`/`prototype`.
    if (FORBIDDEN_KEYS.has(dest) || FORBIDDEN_KEYS.has(source)) {
      return {
        detail: `'inputFromPrevious' must not use a reserved property name ('__proto__', 'constructor', 'prototype')`,
        field: dest,
      };
    }

    // S6: `previousOutput` es de `passOutput`. Los dos coexisten; pisarse, no.
    if (dest === RESERVED_DEST_KEY) {
      return {
        detail: `'inputFromPrevious' cannot target '${RESERVED_DEST_KEY}' (reserved by 'passOutput')`,
        field: dest,
      };
    }

    // S7: el destino no puede existir ya en el input del step. Pisar en silencio
    // un valor que el llamador cree haber puesto es exactamente la clase de bug
    // que `compose-step-shape.ts` existe para no cometer.
    if (isPlainObject(stepInput) && Object.hasOwn(stepInput, dest)) {
      return {
        detail: `'inputFromPrevious' target '${dest}' is already present in this step's 'input'`,
        field: dest,
      };
    }
  }

  return null;
}

/**
 * Envoltorio para el borde HTTP: agrega S8 (mapeo en el step 0) y devuelve el
 * mensaje SIN prefijo de step. Lo consume `lib/compose-step-shape.ts`, que es
 * quien antepone `Step N:` (igual que hace con todos sus otros errores).
 */
export function validateInputMappingShape(
  step: unknown,
  stepIndex: number,
): { message: string; field?: string } | null {
  if (!isPlainObject(step)) return null;
  const mapping = step.inputFromPrevious;
  // S1: sin mapeo declarado no hay nada que validar.
  if (mapping === undefined) return null;

  // S8: el step 0 no tiene step anterior. Es detectable en el body ⇒ se rechaza
  // pre-cobro, en vez de dejarlo morir mid-pipeline con el step 0 ya cobrado.
  if (stepIndex === 0) {
    return {
      message: `'inputFromPrevious' is not allowed on step 0 (there is no previous step)`,
    };
  }

  const problem = checkMappingShape(mapping, step.input);
  if (!problem) return null;
  return {
    message: problem.detail,
    ...(problem.field !== undefined && { field: problem.field }),
  };
}

/**
 * ¿Alguno de los campos que el agente marcó como problemáticos es una clave
 * DESTINO del mapeo declarado? (CR MNR-2)
 *
 * ⚠️ ESTO ES UN GUARD DE DINERO, no una optimización.
 *
 * El retry adaptativo (WKH-130) le pide a un LLM que regenere el input y vuelve
 * a invocar al agente. Pero desde WKH-305 el mapeo se RE-APLICA sobre ese input
 * (AC-7), o sea que **pisa** el campo mapeado con el mismo valor de siempre — el
 * de la salida del step anterior. Si el campo que el agente rechazó es
 * justamente ése (p. ej. un `quoteId` VENCIDO), el re-invoke va a mandar el
 * valor que el agente acaba de rechazar: **el reintento está garantizado a
 * fallar antes de empezar**.
 *
 * Y no sale gratis: el débito del caller se reembolsa, pero el pago DOWNSTREAM
 * al agente ya salió y no se revierte. Cada reintento condenado quema un settle
 * real más una llamada al LLM.
 *
 * Es la intersección de dos conjuntos, evaluada ANTES de regenerar: los campos
 * que el agente señaló contra las claves destino del mapeo. Si se tocan, no hay
 * retry — se cae al error normal, que es exactamente el mismo que el caller
 * habría recibido después de pagar el segundo intento.
 *
 * `Object.hasOwn` y no `in` (CD-6): un campo llamado `constructor` no puede
 * hacer que esto devuelva `true` por herencia del prototipo.
 *
 * Comparación EXACTA, sin normalizar mayúsculas ni alias: los nombres los
 * declaró el caller y los reporta el agente; inventar una semántica de matcheo
 * saltearía retries legítimos.
 */
export function mappingOwnsAnyField(
  mapping: Record<string, string> | undefined,
  fields: readonly string[] | null | undefined,
): boolean {
  if (mapping === undefined || !fields || fields.length === 0) return false;
  return fields.some((f) => Object.hasOwn(mapping, f));
}

export type InputMappingFailure = {
  reason:
    | 'INVALID_MAPPING_SHAPE'
    | 'PREVIOUS_OUTPUT_NOT_OBJECT'
    | 'SOURCE_FIELD_MISSING';
  /** Mensaje para el caller, sin prefijo de step. */
  message: string;
  field?: string;
  source?: string;
};

export type StepInputResolution =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; failure: InputMappingFailure };

/** Lo mínimo que el resolvedor necesita ver de un step. */
type MappableStep = {
  input: Record<string, unknown>;
  passOutput?: boolean | undefined;
  inputFromPrevious?: Record<string, string> | undefined;
};

function shapeFailure(problem: MappingShapeProblem): StepInputResolution {
  return {
    ok: false,
    failure: {
      reason: 'INVALID_MAPPING_SHAPE',
      message: problem.detail,
      ...(problem.field !== undefined && { field: problem.field }),
    },
  };
}

/**
 * R1 (base) + R2..R6 (mapeo). Es la función que llama el happy-path del loop.
 *
 * ⚠️ NO recibe `results` ni el índice del step, A PROPÓSITO: así CD-4 la hace
 * cumplir la FIRMA y no la disciplina. Leer `results[i-2]` es imposible sin
 * cambiar este tipo. (Mismo espíritu que `ResolvedComposeStep`, que convierte la
 * resolución tardía en un error de compilación.)
 */
export function resolveStepInput(
  step: MappableStep,
  lastOutput: unknown,
): StepInputResolution {
  // R3 COMPLETO (S2..S7) contra el input DECLARADO del step. Acá sí se evalúa
  // S7, porque `step.input` es lo que escribió el llamador. Fail-closed: cubre el
  // camino `/orchestrate/execute`, que nunca pasa por `validateComposeBody`.
  const problem = checkMappingShape(step.inputFromPrevious, step.input);
  if (problem) return shapeFailure(problem);

  // R1: IDÉNTICA, carácter por carácter, a la expresión que vivía en
  // `services/compose.ts` antes de WKH-305. No se "mejora" el truthiness de
  // `lastOutput` ni se le agrega un `?? {}`: eso cambiaría el body downstream de
  // pipelines que hoy funcionan.
  const base =
    step.passOutput && lastOutput
      ? { ...step.input, previousOutput: lastOutput }
      : step.input;

  return applyMappingTo(base, step.inputFromPrevious, lastOutput);
}

/**
 * R2..R6 sobre una base ARBITRARIA. Existe para el retry adaptativo (AC-7), que
 * necesita re-aplicar el mapeo sobre el input regenerado por el LLM y no sobre
 * `step.input`. `resolveStepInput` = calcular la base (R1) + llamar a ésta.
 *
 * Sin mapeo declarado devuelve `base` POR LA MISMA REFERENCIA (R2) ⇒ el camino
 * sin mapeo no alloca nada nuevo y queda byte-idéntico (CD-3).
 *
 * S7 NO se evalúa sobre `base` acá: en el retry la base es el input que devolvió
 * el LLM, que YA lleva el campo mapeado — pisarlo es precisamente el objetivo
 * (el modelo puede haberlo borrado, renombrado o inventado). S7 protege el input
 * DECLARADO por el llamador, y eso lo cubre `resolveStepInput` + el borde HTTP.
 */
export function applyMappingTo(
  base: Record<string, unknown>,
  mapping: Record<string, string> | undefined,
  lastOutput: unknown,
): StepInputResolution {
  // R2: sin mapeo, la MISMA referencia. Sin copia, sin allocación.
  if (mapping === undefined) return { ok: true, input: base };

  // R3 (S2..S6): la forma se revalida acá aunque la ruta ya la haya visto.
  const problem = checkMappingShape(mapping, undefined);
  if (problem) return shapeFailure(problem);

  // R4: la salida anterior tiene que ser un objeto plano. Cubre `null`,
  // `undefined`, arrays y primitivos sin ramas especiales por tipo de payload.
  if (!isPlainObject(lastOutput)) {
    return {
      ok: false,
      failure: {
        reason: 'PREVIOUS_OUTPUT_NOT_OBJECT',
        message: `previous step output is not a plain object`,
      },
    };
  }

  // Destino de prototipo NULO: ni siquiera un `__proto__` que se colara por S5
  // podría alcanzar el prototipo del objeto final.
  const mapped = Object.create(null) as Record<string, unknown>;
  for (const [dest, source] of Object.entries(mapping)) {
    // R5: `Object.hasOwn`, NUNCA `in` (que caminaría el prototipo). Y un
    // `undefined` presente cuenta como AUSENTE: JSON nunca lo produce, así que
    // sólo puede venir de un objeto JS interno, y mandarlo igual metería una
    // clave fantasma en el body del agente.
    if (
      !Object.hasOwn(lastOutput, source) ||
      lastOutput[source] === undefined
    ) {
      return {
        ok: false,
        failure: {
          reason: 'SOURCE_FIELD_MISSING',
          message: `field '${source}' is not present in the previous step output`,
          field: dest,
          source,
        },
      };
    }
    // R6: verbatim. Misma referencia, sin clonar, sin coercionar, sin
    // stringificar. `null` es un valor PRESENTE y se mapea: la clave existe y el
    // gateway no inventa la semántica "null no cuenta" sobre datos de un tercero.
    mapped[dest] = lastOutput[source];
  }

  // R6: objeto NUEVO. Nunca se muta `base` ni `lastOutput` (CD-5).
  return { ok: true, input: { ...base, ...mapped } };
}
