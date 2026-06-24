# Auto-Blindaje — WKH-130 (Adaptive Input-Retry)

### [2026-06-24 14:25] Wave 2 — vi.mock factory con `class`/`const` top-level no hoisteado
- **Error**: el test `input-retry.test.ts` falló al cargar con `[vitest] There was an error when mocking a module ... vi.mock factory ... no top level variables inside, since this call is hoisted`. La factory de `vi.mock('../../lib/circuit-breaker.js')` referenciaba una `class CircuitOpenError` y un `const mockExecute` declarados a nivel de módulo.
- **Causa raíz**: `vi.mock(...)` se hoistea al tope del archivo; cualquier identificador del scope de módulo que use la factory debe estar también hoisteado, o vitest lo ve como `undefined` en el momento de evaluar la factory. El patrón `const mockCreate = vi.fn()` de `transform.test.ts` funciona porque `mockCreate` solo se referencia dentro de un closure que corre después; una `class` declaration NO.
- **Fix**: envolver las dependencias de la factory en `vi.hoisted(() => { class ...; const mockExecute = ...; return { mockExecute, CircuitOpenError }; })`.
- **Aplicar en**: cualquier test futuro que mockee un módulo cuya factory devuelva valores construidos en el archivo de test (clases de error custom, instancias de mock con estado). Usar `vi.hoisted` para todo lo que la factory necesite.

### [2026-06-24 14:31] Wave 4 — biome formatter sobre el código nuevo
- **Error**: `biome check` reportó 2-3 "Formatter would have printed..." en compose.ts (el `if` multi-condición del retry) y en los tests (call args).
- **Causa raíz**: el código escrito a mano excedía el ancho de línea / estilo de wrap que biome impone; no es un error de lógica.
- **Fix**: `biome check --write` sobre los archivos tocados. Re-verificado: tests y tsc siguen verdes tras el reformat.
- **Aplicar en**: correr `biome check --write` sobre los archivos nuevos ANTES del check final en cada wave, para no acumular ruido de formato.
