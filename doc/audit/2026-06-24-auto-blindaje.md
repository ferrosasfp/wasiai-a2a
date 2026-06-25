# Auto-Blindaje — Fix-pack auditoría 2026-06-24

Errores detectados durante la implementación del fix-pack y cómo se cerraron.
Origen: `doc/audit/2026-06-24-auditoria-profunda.md`.

### [2026-06-24] A1 — /compose no reembolsaba el step-0 pre-debitado en fallo
- **Error**: la rama `!result.success` de `src/routes/compose.ts` devolvía el
  error sin reembolsar el pre-débito del step-0 que cobró el middleware
  (`request.composeEstimatedCostUsd`, path a2a-key). El refund per-step del
  service es no-op para `i===0` (`compose.ts:142` guard `i > 0`). Cobro sin
  contraprestación; asimetría con `orchestrate.ts:644` que sí reembolsa.
- **Causa raíz**: el step-0 lo debita el middleware, no el service; ninguna capa
  cubría el reembolso del step-0 en el path compose.
- **Fix**: mirror exacto de `orchestrate.ts:644` — antes del `return reply.status`,
  `refundUsd = Math.max(0, composeEstimatedCostUsd - result.totalCostUsdc)`,
  best-effort (nunca cambia el status code ni tira). Reusa el destino canónico
  exacto del débito (`request.composeDestination`) vía `creditWithDest`; sin
  destino fiable cae a `credit` (sin dest-policy) para no romper el dest-cap.
- **Aplicar en**: cualquier ruta que pre-debite vía middleware y delegue la
  ejecución a un service (patrón orchestrate/compose). El destino del refund
  DEBE matchear el del débito (hallazgo M3) — nunca re-derivar uno nuevo.

### [2026-06-24] A3 — `Number(bal) <= 0` dejaba pasar un balance corrupto (NaN)
- **Error**: en `src/services/orchestrate.ts:283`, un `budget` JSONB no-numérico
  daba `NaN`, y `NaN <= 0 === false` → el early-fail "sin fondos" NO disparaba
  (un balance corrupto se trataba como con fondos).
- **Causa raíz**: comparación numérica sin guard de finitud sobre un valor que
  puede no ser numérico (proviene de JSONB).
- **Fix**: `const n = Number(bal); if (!Number.isFinite(n) || n <= 0) { ...fail... }`.
- **Aplicar en**: toda comparación `Number(x) <op> k` sobre valores que vienen de
  JSONB/strings externas — usar `Number.isFinite` antes de comparar.

### [2026-06-24] B11 — `vi.mock` duplicado dentro de función async
- **Error**: `src/services/kite-client.test.ts` tenía un `vi.mock('viem', ...)`
  duplicado dentro de `importKiteClient()` además del top-level — generaba un
  warning de vitest (vi.mock es hoisted; el inline es redundante).
- **Fix**: eliminado el `vi.mock` duplicado interno; se conserva el top-level.
- **Aplicar en**: `vi.mock` es hoisted al top del módulo — nunca duplicarlo dentro
  de funciones; el de top-level ya cubre todas las importaciones.

### [2026-06-24] M5 — tests existentes esperaban el leak del msg PG crudo
- **Error**: al sanitizar la ruta master de `debit()` a `DEBIT_FAILED`, dos tests
  (`budget.test.ts` AC-9 DAILY_LIMIT / INSUFFICIENT_BUDGET) fallaron porque
  asertaban el mensaje crudo de Postgres como `error` — exactamente el leak que
  M5 corrige.
- **Causa raíz**: la ruta master sólo mapeaba `OWNERSHIP_MISMATCH` y devolvía
  `error.message` para todo lo demás (incluidos códigos de negocio conocidos).
  Los tests congelaron ese comportamiento defectuoso.
- **Fix**: la ruta master ahora espeja el mapeo de la ruta dest-policy
  (INSUFFICIENT_BUDGET→AGENT_KEY_BUDGET_EXHAUSTED, DAILY_LIMIT, KEY_INACTIVE,
  KEY_NOT_FOUND) y sólo cae a `DEBIT_FAILED` (+ `console.error`) para PG errors
  inesperados. Los dos tests se actualizaron a los códigos estables.
- **Aplicar en**: cuando sanitizás un leak, revisá que los tests no estén
  congelando el comportamiento defectuoso — actualizalos al contrato correcto.

### [2026-06-24] B8 — `err as Record<string, unknown>` no compila sobre Error
- **Error**: al reemplazar el double-cast `as unknown as AppError`, intenté
  `(err as Record<string, unknown>)[key]` directo sobre un `Error` → TS2352
  (Error y Record no se solapan, falta index signature).
- **Causa raíz**: `Error` es un tipo nominal sin index signature; castear a
  `Record` directo lo rechaza el compilador (a diferencia de `object`).
- **Fix**: narrowing por `key in obj` con helpers tipados `(obj: object, ...)`;
  dentro del guard `(obj as Record<string, unknown>)[key]` SÍ es legal (object
  sí se solapa con Record). Sin `as unknown as`.
- **Aplicar en**: para leer props arbitrarias de un `Error`/clase nominal, usar
  `'k' in obj` + cast desde `object` (no desde el tipo nominal).

### [2026-06-24] B1 — `noImplicitOverride` exige `override` en `cause`
- **Error**: activar `noImplicitOverride` rompió `vm-runner.ts:92` — la propiedad
  `cause` de `TransformExecutionError` redeclara `Error.cause` sin `override`.
- **Fix**: `public override readonly cause?: unknown;`.
- **Aplicar en**: cualquier subclase de `Error` (u otra base) que redeclare un
  miembro de la base necesita el modificador `override` bajo este flag.

### [2026-06-24 WAVE 2a] M2 — `dispatcher` no existe en el tipo `RequestInit` (DOM lib)

- **Error**: pasar `dispatcher: getSsrfDispatcher()` inline en cada `fetch(...)`
  rompió `tsc` con TS2769 ("Object literal may only specify known properties,
  and 'dispatcher' does not exist in type 'RequestInit'") en los 3 call-sites
  (`discovery.ts` ×2, `compose.ts` ×1).
- **Causa raíz**: el `fetch` global de Node 22 ACEPTA `dispatcher` en runtime
  (undici-backed), pero la firma de tipo viene de la DOM lib (`RequestInit`),
  que no declara `dispatcher`. El cast era inevitable.
- **Fix**: centralicé el único cast necesario en un wrapper `ssrfFetch(input,
  init)` en `ssrf-dispatcher.ts` (`{ ...init, dispatcher } as RequestInit`), y
  los 3 call-sites llaman `ssrfFetch` en vez de `fetch` + `dispatcher` inline.
  Cero casts dispersos, call-sites limpios y type-safe.
- **Aplicar en**: cualquier opción de fetch específica de Node/undici
  (`dispatcher`, `duplex` en algunos casos) que la DOM lib no declare → envolver
  en UN helper con el cast, nunca esparcir `as` por los call-sites.

### [2026-06-24 WAVE 2a] M2 — tests de integración del dispatcher flakey por timeout/close race

- **Error**: dos tests de integración del SSRF dispatcher (uno apuntando a una IP
  pública-pero-unroutable `192.0.2.1`, otro a loopback con `AbortSignal.timeout`)
  colgaban ~10s ("Hook timed out in 10000ms" en `afterEach`) o fallaban con
  `ClientClosedError: The client is closed` — el `cachedDispatcher.close()` en
  el reset bloqueaba esperando un socket pendiente, y el abort racing con el
  close cerraba el agent antes de que el bloqueo SSRF se reportara.
- **Causa raíz**: (1) `Agent.close()` espera el drain de conexiones in-flight; un
  connect a un destino unroutable nunca dren­a. (2) `AbortSignal.timeout` corto
  + close en `afterEach` competían con el reporte del error de connect.
- **Fix**: (a) `_resetSsrfDispatcher` usa `destroy().catch(()=>{})` (inmediato, no
  espera in-flight) en vez de `close()`. (b) Reemplacé los 2 tests frágiles por:
  un bloqueo a loopback SÍNCRONO (sin timeout — el connector rechaza antes de
  abrir socket, rápido y determinista) + un test de wiring que stubbea
  `globalThis.fetch` y asserta que `ssrfFetch` adjunta el dispatcher y retorna la
  Response. La lógica ALLOW/BLOCK de IPs se cubre exhaustivamente en los unit
  tests de `ssrfLookup`.
- **Aplicar en**: tests que crean un `undici.Agent` real → tear-down con
  `destroy()` (no `close()`), y NO dependas de connects a IPs unroutable con
  timeouts cortos; preferí asserts síncronos en el connector + stubs del fetch
  global para el happy-path.

### [2026-06-24 WAVE 2a] M3 — destino canónico re-derivado en 3 capas (riesgo de cap leak)

- **Error/Hallazgo**: en `compose.ts` el destino `normalizeDestination(
  ${agent.registry}/${agent.slug})` se re-derivaba 3 veces por step (débito
  per-step, refund best-effort, re-débito del retry adaptativo). Aunque hoy
  coincidían (mismo `agent`), eran 3 fuentes independientes: si una divergiera
  (refactor futuro, cambio de capa), el credit compensatorio del dest-cap se
  insertaría en otro destino y el cap del destino real nunca se liberaría.
- **Causa raíz**: falta de una única fuente de verdad para el destino del step.
- **Fix**: `const stepDestination = normalizeDestination(...)` UNA vez por
  iteración (tras resolver el agente) y propagado a los 3 usos. El refund dejó de
  usar el ternario `destination ? creditWithDest : credit` (muerto:
  `normalizeDestination` nunca devuelve falsy, throwea en vacío) y usa siempre
  `creditWithDest(stepDestination)`. Fórmula de montos y semántica de cobro
  intactas; guard `i>0` (CD-11) intacto.
- **Aplicar en**: cualquier valor que deba coincidir byte-a-byte entre un débito y
  su reverso (destino, monto, owner) → resolvé UNA vez y propagá; nunca
  re-derives en cada capa.

### [2026-06-24] B1 — `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` diferidos
- **Hallazgo**: `noUncheckedIndexedAccess` generó 232 errores (162×TS2532 acceso
  indexado, 43×TS18048, + mismatches en arrays de tests/adapters) y
  `exactOptionalPropertyTypes` generó 52 (mayormente TS2375 en adapters de pago).
  Ambos exceden el umbral seguro del wave y requieren cambios de tipos/lógica de
  riesgo no acotado.
- **Decisión**: REVERTIDOS. Quedaron activos sólo `noFallthroughCasesInSwitch` y
  `noImplicitOverride` (low-noise, 1 hit arreglado). Los otros dos quedan como
  deuda técnica para un wave dedicado con su propio SDD.
