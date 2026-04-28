# Auto-Blindaje — WKH-59 / SEC-DRAIN-1

Errores cometidos durante la implementación y cómo se corrigieron, para
prevenir su repetición en futuras HUs.

---

### [2026-04-27 21:31] W4 — Inline route handlers sin tipo explícito de FastifyRequest/FastifyReply (TS7006)

- **Error**: Al agregar rutas auxiliares de test (`/test-legacy`,
  `/test-gasless-mw`) en `src/middleware/a2a-key.test.ts`, los handlers
  inline (`async (_req, reply) => ...`) y el preHandler inline
  (`async (req) => { req.gaslessEstimatedCostUsd = 5; }`) generaron 5
  errores TS7006 (implicit any) bajo `tsc --noEmit`. Los tests corrían
  igual (vitest no enforcea strict en runtime), pero el `npx tsc
  --noEmit` rompía → violación de DoD §8.
- **Causa raíz**: Cuando una ruta Fastify se define DENTRO de otro
  `describe` y NO está dentro del flujo de inferencia normal de un
  plugin tipado (`FastifyPluginAsync`), TypeScript no puede inferir los
  tipos de los parámetros del handler/preHandler. `tsconfig.json` tiene
  `strict: true` + `noImplicitAny: true`. La inferencia funcionaba en
  los tests de `gasless.test.ts` porque el plugin `gaslessRoutes` ya
  está tipado como `FastifyPluginAsync`, pero al definir rutas
  directamente sobre `Fastify()` en un test, hay que anotar los params.
- **Fix**: anotar explícitamente cada handler/preHandler inline con
  `(req: FastifyRequest, reply: FastifyReply)` o
  `(req: FastifyRequest)` cuando solo se usa request. Los imports
  `FastifyRequest`/`FastifyReply` ya estaban presentes en el archivo.
- **Aplicar en**: cualquier futuro test que registre rutas Fastify
  directamente con `app.post(url, opts, handler)` fuera de un plugin —
  anotar `req`/`reply` explícitamente. Mismo principio aplica si un
  preHandler array contiene funciones inline.

---

### [2026-04-27 22:15] AB-WKH-59-1 — Helper `pyusdWeiToUsd` reutilizable cross-services

- **Descubrimiento**: Durante la implementación de W1, surgió la idea de
  usar `pyusdWeiToUsd` en otros servicios (X402 pricing, LLM bridge
  budgeting). Pero el helper con token-specific constants (6 decimals
  para PYUSD) acoplado en la función hace difícil la reutilización.
- **Pattern correcto**: Extraer a `src/lib/price.ts` como **pura función**
  con zero side effects. Token-specific constants (decimals, default
  rate) como exports separados. Rate reading en wrapper `getPyusdUsdRate()`
  que accede a env, no dentro del helper.
- **Aplicar en**: Cualquier cálculo financiero/rate que potencialmente
  cruise múltiples servicios (X402, LLM, future gasless variants). Extraer
  a `src/lib/` como función pura + env wrapper separado. Esto permite
  unit testing sin Fastify/DB mocking y reutilización frictionless.

---

### [2026-04-27 22:18] AB-WKH-59-2 — PreHandler chain pattern para inyectar context

- **Descubrimiento**: Diseño inicial intentaba pushear el cómputo de
  costo DENTRO del middleware, pero el middleware es body-agnostic por
  diseño (aplica a todas las rutas). Mezclar lógica route-specific en
  middleware viola Separation of Concerns.
- **Pattern correcto**: Usar **preHandler array** donde stage A (route-specific)
  inyecta context vía request augmentation, y stage B (middleware) lo
  consume con type guard. Middleware nunca lee body, solo campos inyectados.
  Backward-compat: middleware chequea `typeof field === 'number' ? field : fallback`.
- **Implementación en WKH-59**:
  ```
  preHandler: [
    gaslessCostEstimatorPreHandler,  // stage A: parse body, compute, inject
    ...requirePaymentOrA2AKey({...}) // stage B: read optional field
  ]
  ```
- **Aplicar en**: Cualquier futuro HU que agregue endpoint-specific debit
  logic (`/x402/refund`, `/gasless/multi-transfer`). Inyecta via request
  augmentation, no via middleware factory/config. Escalable y testeable.

---

### [2026-04-27 22:22] AB-WKH-59-3 — DT justification verification: "rate=0 misconfig" vs "cap per wei"

- **Descubrimiento durante AR/CR**: SDD DT-A afirmaba "el cap por wei sigue
  protegiendo" si `PYUSD_USD_RATE=0`, pero NO existe cap por wei en el
  código (solo per-USD cap vía `GASLESS_DEFAULT_CAP_USD`). Verificación
  de spec fallida: el lower bound `MIN_PYUSD_RATE=0` es inclusivo, lo que
  permite `rate=0` → todos los transfers cuestan $0 USD → cap pierde utilidad.
- **Root cause**: SDD author conflated transaction amount in wei vs
  USD-equivalent amount. Global cap operates on USD, not wei. La
  justificación original de DT-A es incorrecta en la afirmación del cap
  alternativo.
- **Corrección**: Marcado como MNR-1 en AR+CR report con sugestion para
  future hardening HU: cambiar lower bound a exclusivo (`parsed <= 0 →
  fallback`). Corrección de SDD understanding: "cap limita USD value
  estimado, computado desde wei via rate—si rate=0, cap pierde sentido".
- **Aplicar en**: Antes de marcar SDD como SPEC_APPROVED, spot-check cada
  DT claim: "si X, entonces Y" → encontrar el código que implementa Y y
  verificar que X efectivamente lo triggerea. Watch for off-by-one en
  ranges (inclusive vs exclusive). Incluir verification checklist explícito
  en SDD review: "¿el código implementa la claim en DT-N?"
