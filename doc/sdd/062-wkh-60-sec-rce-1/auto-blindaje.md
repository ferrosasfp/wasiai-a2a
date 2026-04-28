# Auto-Blindaje WKH-60 / SEC-RCE-1

Errores y aprendizajes durante la implementación. Fuente para futuras HUs.

### [2026-04-27 22:15] Wave W3 — never-cache mode rompía tests existentes

- **Error**: el prompt instruyó "never-cache cuando ownerId === undefined".
  Los tests existentes (`transform.test.ts` T-1/T-2/T-3 y `transform-verification.test.ts`
  T-VER-5/T-VER-7b/T-VER-7c) se escribieron pre-WKH-60 y NO pasaban ownerId.
  Tras el cambio, esos tests dejaron de ejercitar el path L2 (porque ahora el
  service hace bypass) y por lo tanto el assertion `expect(supabase.from).toHaveBeenCalledWith(...)`
  habría fallado, además de la chain de eq() necesitar 4 levels.
- **Causa raíz**: refactor de signature de función pública sin actualizar callers
  legacy en tests. El "never-cache" mode es un comportamiento NUEVO; los tests
  antiguos asumían "cache always", lo cual era el contrato hasta WKH-60.
- **Fix**:
  1. Actualicé los 6 tests legacy para pasar `'tenant-1'` como ownerId,
     manteniendo su intención original (verificar L2 read/write paths).
  2. Extendí los mock chains de Supabase de 3-eq a 4-eq.
  3. Agregué `transform_fn_sig: null` a los hit-mocks para reflejar la
     columna nueva (HMAC degraded mode acepta NULL sig cuando la env var
     no está configurada).
- **Aplicar en**: cualquier futura HU que cambie la signature pública de
  `maybeTransform` o que agregue una nueva columna a `kite_schema_transforms`.
  Verificar TODOS los tests legacy (`transform.test.ts` y
  `__tests__/transform-verification.test.ts`) y los mock chains
  `setupSupabase*` antes de mergear.

### [2026-04-27 22:18] Wave W4 — TransformExecutionError importado pero no usado tras format

- **Error**: el linter/formatter (biome) re-formateó imports y dejó
  `TransformExecutionError` importado en `transform.ts` aunque solo se
  re-exporta. TypeScript con `--strict` no lo flagged porque está en el
  `export { ... }` final, pero un análisis aislado lo vería como unused.
- **Causa raíz**: el plan de re-exportar las custom errors para uso del
  caller (compose.ts puede mapear errores específicos a telemetría) requiere
  que el módulo las tenga en scope. La línea de re-export las usa.
- **Fix**: dejar el import + re-export como están; tsc no se queja.
  Documentar la razón del re-export con comentario inline.
- **Aplicar en**: cualquier servicio que decida re-exportar tipos/errors de
  un helper. Mantener el patrón `import { X } from 'helper'; ... export { X };`
  con comentario sobre el motivo.

### [2026-04-27 22:30] Story File ausente — interpretación de instrucciones

- **Error**: `doc/sdd/062-wkh-60-sec-rce-1/story-WKH-60.md` no existía en
  disco al iniciar la fase F3. El protocolo exige "Story File self-contained"
  como input.
- **Causa raíz**: F2.5 (architect) no escribió el archivo, o se perdió en
  un commit no propagado.
- **Fix**: el orquestador me pasó las instrucciones detalladas en el prompt
  (5 waves, archivos exactos, tests count, scope IN/OUT). Tomé esas
  instrucciones como Story File de facto y procedí. Documento aquí la
  desviación de proceso para que QA / Adversary lo registren.
- **Aplicar en**: cuando un Story File falte pero el orquestador adjunte el
  detalle equivalente en el prompt, ese prompt es el contrato. No inventar
  más allá de lo escrito.
