# Auto-Blindaje — Audit B1b: activar `exactOptionalPropertyTypes` (F3)

### [2026-06-24 23:18] `outputSchema: undefined` explícito rompía con `RequestInit`/payload literal (x402)
- **Error**: en `middleware/x402.ts` el literal `X402PaymentPayload` seteaba
  `outputSchema: undefined` explícito. Con `exactOptionalPropertyTypes`, `outputSchema?: {...}`
  YA no admite el valor `undefined` asignado a mano (TS2375). El mismo patrón apareció en
  `mcp/tools/pay-x402.ts` con `body: cond ? JSON.stringify(...) : undefined` contra
  `RequestInit.body` (que es `BodyInit | null`, NO opcional → no se puede pasar `undefined`).
- **Causa raíz**: confundir "prop opcional ausente" con "prop presente con valor `undefined`".
  El consumidor (JSON.stringify del response 402, fetch del body) trata ausente ≡ undefined,
  pero el TIPO destino no lo admite con el flag activo.
- **Fix**: estrategia **conditional spread / omitir la prop** en vez de setearla undefined:
  - x402.ts: borré la línea `outputSchema: undefined` (JSON output idéntico — undefined props
    se descartan en `JSON.stringify`).
  - pay-x402.ts: `...(input.payload !== undefined ? { body: JSON.stringify(...) } : {})`.
  Comportamiento on-the-wire idéntico; solo cambia el shape del literal.
- **Aplicar en**: cualquier literal que setee `prop: undefined` o `prop: cond ? x : undefined`
  contra un tipo `{ prop?: T }` (interno) o `{ prop: T | null }` (lib como `RequestInit`). Para
  tipos de **lib** no se puede ampliar → SIEMPRE conditional-spread. Para tipos internos donde
  el consumidor hace `if ('prop' in obj)` → conditional-spread; donde hace `?.`/`??`/`!obj.prop`
  → ampliar a `| undefined` es más simple y seguro.

### [2026-06-24 23:20] Biome cuenta "format" como error → 2 archivos editados quedaron sin reflow
- **Error**: tras tsc-limpio + 2000 tests verdes, `biome check src` reportó "Found 2 errors".
  No eran lint: el reporter `--reporter=github` mostró `title=format` (no `lint/style/...`) en
  `middleware/x402.ts` y `services/task.ts` — los dos archivos donde amplié anotaciones de tipo
  inline a `| undefined`, que excedieron el line-width de biome.
- **Causa raíz**: ampliar un tipo inline `{ a?: T; b?: U }` a `{ a?: T | undefined; b?: U | undefined }`
  alarga la línea; si pasa el ancho máximo, biome exige reflow multilínea y lo cuenta como ERROR
  (no warning). El diff de diagnósticos lint era vacío (0 nuevos lint), lo que despistó: el error
  era de **formato**, invisible en el grep de líneas `lint/style`.
- **Fix**: `biome format --write` SOLO sobre los 2 archivos tocados. El reflow es puramente
  cosmético (parte la anotación de tipo en varias líneas) — verificado con `git diff`: no cambia
  runtime. tsc + suite re-verificados verdes.
- **Aplicar en**: después de ampliar tipos inline para `exactOptionalPropertyTypes`, correr
  `biome check src` y distinguir errores de **format** (rule `format`, contados como error) de los
  warnings `noNonNullAssertion` preexistentes. Si hay format-error, `biome format --write` sobre
  los archivos editados y re-verificar tsc + tests. No confiar solo en el diff de líneas `lint/`.

### [2026-06-24 23:22] Distinguir "ampliar tipo" vs "conditional spread" por cómo lee el consumidor
- **Error potencial evitado**: la mayoría de los ~51 hits eran tipos request/result internos
  (DiscoveryQuery, ComposeRequest, OrchestrateRequest, CreateKeyInput, AuthzTarget, SignedAuthHeaders,
  VerifyResult/SettleResult de los adapters de pago, el input de `eventService.track`, etc.).
  Tentación: ampliar TODO a `| undefined` por uniformidad.
- **Causa raíz**: ampliar un tipo donde el consumidor hace `'prop' in obj` (patrón CD-17 "omit, do
  not set null") rompería el contrato — `in` distingue ausente de undefined, ampliar el tipo
  permitiría colar `undefined` y cambiar el resultado del check.
- **Fix**: verifiqué consumidor por tipo antes de elegir. **Ampliar a `| undefined`** SOLO donde el
  consumidor usa `?.`, `?? fallback`, `if (!obj.prop)` o `if (obj.prop !== undefined)` (undefined ≡
  ausente — caso de TODOS los tipos internos de este audit, incl. money-path: `VerifyResult.error` /
  `SettleResult.error` se leen con `?? 'unknown'`). Para `invokeAgent`'s `downstream` (que se setea
  con `...(downstream && { downstream })`, semántica `in`) NO amplié — dejé `downstream?` y solo
  amplié `txHash?` que se retorna directo. En money-path NO cambié montos, payloads on-chain ni
  qué se settlea: solo el shape de tipos de los results.
- **Aplicar en**: ante un hit de `exactOptionalPropertyTypes`, leer el/los consumidor(es) del campo
  ANTES de ampliar. `'x' in obj` o spread condicional → omitir/spread; `?.`/`??`/`!`/`!== undefined`
  → ampliar. Nunca ampliar por defecto sin mirar al consumidor.
