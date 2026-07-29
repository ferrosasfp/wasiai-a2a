/**
 * Compose Step Shape — HU-208 · validación PURA de un step de `/compose`.
 *
 * Módulo LEAF (sólo `import type`) por el patrón ya establecido en este repo:
 * lo consume `routes/compose.ts` desde un preHandler que corre ANTES del débito,
 * y las suites de esa ruta mockean servicios completos.
 *
 * ⚠️ DÓNDE CORRE ESTO Y POR QUÉ IMPORTA: lo llama `validateComposeBody`, que
 * `routes/compose.ts` ejecuta en `validateComposeBodyHandler`, o sea ANTES de
 * `resolveComposePriceHandler` y ANTES de `requirePaymentOrA2AKey`. Un body que
 * falle acá se rechaza SIN débito y SIN discovery (HIGH-2, 2026-07-26: los
 * mismos checks vivían en el route handler, que corre DESPUÉS del débito, así que
 * un 400 igual se cobraba). Cualquier check que se agregue a este archivo hereda
 * esa propiedad; cualquier check que se agregue al route handler NO.
 */

// WKH-305: el único import de este módulo, y es a otro LEAF (cero imports de
// runtime), así que la propiedad de "no lo moquea nadie" se conserva.
import { validateInputMappingShape } from './compose-input-mapping.js';

/** Body del error de validación de shape (sin `requestId`, que agrega el caller). */
export type ComposeStepShapeError = {
  error: string;
  /**
   * HU-208: `ambiguous_step` es el código EXACTO que pide WAS-187 AC-3.
   *
   * En wasiai-v2 ese AC quedó INCUMPLIDO: `validateSteps()` devolvía el mensaje
   * correcto pero con `code: 'validation_error'`, así que un cliente que
   * discriminara por código nunca podía distinguir "mandaste las dos cosas" de
   * cualquier otro 400 (documentado en la verificación de ACs del S5 review).
   * Acá se emite el código real — es lo único que hace la condición accionable
   * desde el cliente.
   */
  code: 'VALIDATION_ERROR' | 'ambiguous_step';
  /** Índice del step que falló. Ausente en errores a nivel pipeline. */
  step?: number;
};

/** Lo mínimo que este validador necesita ver de un step (evita acoplarse al tipo completo). */
type RawStep = {
  agent?: unknown;
  capability?: unknown;
  constraints?: unknown;
};

/**
 * HU-208: las restricciones numéricas se validan como FINITAS, no sólo como
 * "number". Port del defecto WAS-187-01 (`security-review.md`) COMO ARREGLO, no
 * como bug: allá el guard era `!== undefined`, así que un `NaN` pasaba, viajaba a
 * PostgREST como `null` y producía una query silenciosamente incorrecta.
 *
 * Acá el equivalente sería peor de rastrear: los filtros de discovery comparan
 * con `<=` / `>=`, y TODA comparación con `NaN` es `false` — el conjunto de
 * candidatos quedaría vacío y el llamador recibiría un `no_agent_match` que
 * culpa al catálogo cuando el problema era su propio parámetro. Rechazar de
 * entrada convierte un misterio en un mensaje.
 */
function validateNumericConstraint(
  value: unknown,
  field: string,
  stepIndex: number,
): ComposeStepShapeError | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      error: `Step ${stepIndex}: constraints.${field} must be a finite number`,
      code: 'VALIDATION_ERROR',
      step: stepIndex,
    };
  }
  if (value < 0) {
    return {
      error: `Step ${stepIndex}: constraints.${field} must not be negative`,
      code: 'VALIDATION_ERROR',
      step: stepIndex,
    };
  }
  return null;
}

/**
 * Valida el shape de UN step. Devuelve `null` si está bien.
 *
 * Contrato (HU-208): un step trae `agent` (como siempre) O `capability` (nuevo),
 * EXACTAMENTE UNO de los dos.
 * - los dos    → 400 `ambiguous_step` (WAS-187 AC-3)
 * - ninguno    → 400 `VALIDATION_ERROR`. Se conserva ESE código, y no uno nuevo,
 *                porque es literalmente el caso que ya devolvía 400 antes de esta
 *                HU (step sin `agent` string): cambiarlo rompería a cualquiera
 *                que hoy discrimine por él.
 */
export function validateComposeStepShape(
  step: unknown,
  stepIndex: number,
): ComposeStepShapeError | null {
  if (!step || typeof step !== 'object') {
    return {
      error: `Step ${stepIndex} is missing a string 'agent' or 'capability' field`,
      code: 'VALIDATION_ERROR',
      step: stepIndex,
    };
  }

  const s = step as RawStep;
  const hasAgent = typeof s.agent === 'string' && s.agent.length > 0;
  const hasCapability =
    typeof s.capability === 'string' && s.capability.length > 0;

  if (hasAgent && hasCapability) {
    return {
      error: `Step ${stepIndex}: 'agent' and 'capability' are mutually exclusive`,
      code: 'ambiguous_step',
      step: stepIndex,
    };
  }

  if (!hasAgent && !hasCapability) {
    // Mensaje deliberadamente cercano al histórico ("is missing a string 'agent'
    // field") para no romper asserts existentes más de lo necesario, ampliado
    // para nombrar la alternativa nueva.
    return {
      error: `Step ${stepIndex} is missing a string 'agent' or 'capability' field`,
      code: 'VALIDATION_ERROR',
      step: stepIndex,
    };
  }

  // `constraints` sólo tiene sentido junto a `capability`: sobre un `agent`
  // nombrado no hay conjunto de candidatos que filtrar. Se rechaza en vez de
  // ignorarse — un filtro que el llamador cree haber puesto y el servidor
  // descarta en silencio es la misma clase de bug que el `NaN` de arriba.
  if (s.constraints !== undefined) {
    if (hasAgent) {
      return {
        error: `Step ${stepIndex}: 'constraints' only applies to a 'capability' step`,
        code: 'VALIDATION_ERROR',
        step: stepIndex,
      };
    }
    if (typeof s.constraints !== 'object' || Array.isArray(s.constraints)) {
      return {
        error: `Step ${stepIndex}: 'constraints' must be an object`,
        code: 'VALIDATION_ERROR',
        step: stepIndex,
      };
    }
    const c = s.constraints as Record<string, unknown>;
    // Clave NO soportada → 400, nunca ignorarla en silencio.
    //
    // Importa especialmente por `chain`: se evaluó como restricción y se RECHAZÓ
    // (forzar el rail es hacerle trampa al ranking verified → reputación →
    // precio). Sin este check, un llamador que mande `constraints.chain` creería
    // haber fijado el rail y el servidor elegiría por su cuenta — la misma clase
    // de bug que el `NaN`: un filtro que el que pide cree tener y no tiene.
    // Decirle que no se soporta es honesto; ignorarlo, no.
    const allowed = new Set(['max_price_usdc', 'min_reputation']);
    const unknownKey = Object.keys(c).find((k) => !allowed.has(k));
    if (unknownKey !== undefined) {
      return {
        error: `Step ${stepIndex}: unsupported constraint '${unknownKey}'`,
        code: 'VALIDATION_ERROR',
        step: stepIndex,
      };
    }
    const priceErr = validateNumericConstraint(
      c.max_price_usdc,
      'max_price_usdc',
      stepIndex,
    );
    if (priceErr) return priceErr;
    const repErr = validateNumericConstraint(
      c.min_reputation,
      'min_reputation',
      stepIndex,
    );
    if (repErr) return repErr;
  }

  // WKH-305: forma de `inputFromPrevious`. Las reglas viven UNA sola vez, en
  // `lib/compose-input-mapping.ts` (el resolvedor del service llama a la MISMA
  // función); acá sólo se traduce el fallo al shape que este módulo ya emite.
  // Está en este archivo, y no en el route handler, precisamente por lo que dice
  // el docstring de cabecera: lo que se rechaza acá se rechaza SIN débito.
  const mappingErr = validateInputMappingShape(step, stepIndex);
  if (mappingErr) {
    return {
      error: `Step ${stepIndex}: ${mappingErr.message}`,
      code: 'VALIDATION_ERROR',
      step: stepIndex,
    };
  }

  return null;
}
