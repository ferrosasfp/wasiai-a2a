# Auto-Blindaje — WKH-65 (a2a-forward-key)

Registro de errores y correcciones detectados durante la implementación
y los fix-packs posteriores. Se documentan para que futuras HUs no caigan
en la misma trampa.

## Sesión: FIX-PACK AR + CR menores (post-merge follow-up)

### [2026-04-28 20:53] Wave única — Test fixture rompe MNR-2 floor de 16 chars
- **Error**: tras agregar el threshold `length < FORWARD_KEY_MIN_LENGTH (16)`
  en `requireForwardKey()` (MNR-2), el test `AC-5: header longer than expected`
  seguía usando `WASIAI_V2_FORWARD_KEY = 'short-expected'` (14 chars), lo que
  hacía que el factory devolviera `[]` (middleware no montado) y el test
  recibiera 200 en vez de 401.
- **Causa raíz**: cuando se introduce un guard de validación de env en runtime,
  hay que auditar TODOS los fixtures de tests que setean esa env, no solo el
  caso explícito que se está testeando. El test name "longer than expected"
  empuja a usar una key corta para hacer obvio el contraste, pero el contraste
  ahora colisiona con el guard.
- **Fix**: bump del fixture a `'short-expected-aa'` (17 chars). Sigue siendo
  mucho más corto que el header attacker (`'an-extremely-long-attacker-...'`),
  preservando el sentido del test (header > expected).
- **Aplicar en**: cualquier futura HU que introduzca un nuevo `MIN_LENGTH` /
  threshold sobre una env var → grep TODOS los `process.env.<VAR> = ...` en
  tests existentes y verificar que cumplen el nuevo floor antes de mergear.

### [2026-04-28 20:53] Wave única — vitest no exporta `fail` global
- **Error**: el patch inicial de CR-NIT-2 propuesto por el orquestador usaba
  `fail(\`unparsable log line: ...\`)` pero vitest (a diferencia de Jest 27-)
  NO expone `fail` como global, lo que rompería el test al ejecutarse.
- **Causa raíz**: copia de patrón Jest sin verificar la API de vitest.
- **Fix**: reemplazo por `expect.fail(...)` que sí está disponible en vitest
  4.x (https://vitest.dev/api/expect.html#fail).
- **Aplicar en**: cualquier helper o assertion que provenga de Jest debe
  re-validarse contra vitest antes de copiar el snippet 1:1. Lista de gotchas
  conocidas: `fail` → `expect.fail`, `jest.fn()` → `vi.fn()`, `jest.mock()` →
  `vi.mock()`, `jest.spyOn()` → `vi.spyOn()`.
