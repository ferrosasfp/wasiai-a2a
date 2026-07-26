# Auto-Blindaje — 189 fix-pack P1

Errores cometidos durante la implementación, su causa raíz y dónde más pueden
volver a pasar. NO es opcional: es lo que protege las HUs siguientes.

---

### [2026-07-26] Wave 2 — Un export nuevo del service rompió 12 tests que lo mockean completo

- **Error**: puse `parseMinReputation` / `InvalidMinReputationError` como exports
  de `src/services/discovery.ts` y los importé desde `src/routes/discover.ts`.
  `tsc --noEmit` pasó en 0, los tests nuevos pasaron, y la suite completa se cayó
  con **12 fallos** en `src/routes/discover.test.ts` (9) y
  `src/__tests__/e2e/e2e.test.ts` (3).
- **Causa raíz**: esos tests hacen
  `vi.mock('../services/discovery.js', () => ({ discoveryService: {...} }))` —
  factory **sin `importOriginal`**. El mock REEMPLAZA el módulo entero, así que
  todo export que no esté en la factory queda `undefined` en el módulo bajo test.
  La ruta llamaba a `parseMinReputation(...)` → `TypeError` en cada request.
  `tsc` no lo ve: los mocks son runtime.
- **Fix**: moví la validación a un módulo **leaf** nuevo,
  `src/lib/discovery-query.ts`, y la ruta la importa de ahí. Los tests que
  mockean el service siguieron funcionando **sin tocarlos**, y el validador ganó
  su propio test unitario (`src/lib/discovery-query.test.ts`). Mismo patrón que
  `payment-spec-reader.ts` (WKH-241).
- **Aplicar en**: **cualquier** HU que agregue un export a un módulo de
  `src/services/` y lo consuma desde `src/routes/`. Antes de hacerlo:
  `grep -rn "vi.mock('.*services/<modulo>.js'" src/` y ver si alguna factory NO
  usa `importOriginal`. Si hay alguna → el export va en un módulo leaf de
  `src/lib/`, no en el service. Regla derivada: **helpers puros (validación,
  parsing, mapeo) van en `src/lib/`; los services quedan para I/O**.
- **Lección de proceso**: `tsc --noEmit` + los tests del archivo nuevo NO son
  suficientes. La suite COMPLETA es el único gate que caza esto.

---

### [2026-07-26] Wave 4 — El MISMO error, otra vez, y 7× más caro

- **Error**: puse `createSkipCapturingLogger` / `toPublicSkipCode` /
  `DownstreamSkipCode` en `src/lib/downstream-payment.ts` y los importé desde
  `src/services/compose.ts`. **84 tests** rotos en `compose.test.ts` (y las mismas
  factories están en `compose.ssrf.test.ts`, `compose.chain-flow.test.ts`,
  `orchestrate.billing.test.ts`, `money-path.resilience.test.ts` y
  `e2e/compose-flow.test.ts` → 6 suites expuestas).
- **Causa raíz**: idéntica a la entrada de la Wave 2. Reincidí a pesar de haberla
  escrito 40 minutos antes.
- **Fix**: módulo leaf `src/lib/downstream-skip-code.ts` con la taxonomía + los
  helpers; `downstream-payment.ts` re-exporta `DownstreamSkipCode` por back-compat
  (mismo patrón que el re-export de `DownstreamLogger` que ya existía) e importa
  `noteSkip` del leaf. Se agregó un comentario ⚠️ en la factory de
  `compose.test.ts:100` para que el próximo lo vea ANTES de tropezar.
- **Aplicar en**: es la MISMA regla, así que el problema no era la regla sino el
  chequeo. **Chequeo mecánico obligatorio** antes de agregar un export a un módulo
  consumido por `src/routes/` o `src/services/`:

  ```
  grep -rn "vi.mock('.*<modulo>.js'" src/ | grep -v importOriginal
  ```

  Si devuelve algo → el export va en un leaf de `src/lib/`. Los dos módulos que
  ya sabemos que están minados: `src/services/discovery.js` y
  `src/lib/downstream-payment.js`.

---

### [2026-07-26] Wave 3 — `toFixed(decimals)` no es una normalización decimal segura

- **Error**: no es un error mío de esta sesión, es el que se está arreglando,
  pero se documenta porque el patrón está copiado en 5 adapters y va a volver.
- **Causa raíz**: `Number.prototype.toFixed(n)` con `n` grande **no** emite el
  decimal que el double representa: emite su **expansión binaria**. Con `n = 18`
  (tokens de 18 decimales) eso mete el error de representación completo en el
  monto atómico: `(0.03).toFixed(18)` = `'0.029999999999999999'`. El comentario
  original decía «parseUnits scales the USD figure to atomic units **exactly**»,
  y era falso para 18 decimales.
- **Por qué el `toFixed` estaba ahí y NO se puede borrar sin reemplazo**:
  `parseUnits` **lanza** con notación científica
  (`parseUnits('1e-7', 6)` → `Number "1e-7" is not a valid decimal number`), y
  `String(1e-7)` es `'1e-7'`. El `toFixed` evitaba ese throw. Cualquier fix tiene
  que seguir garantizando salida decimal plana.
- **Fix**: helper compartido `src/lib/atomic-amount.ts` que expande la notación
  científica a decimal plano a partir de la representación decimal MÁS CORTA
  (`String(n)`), y recién ahí llama a `parseUnits`.
- **Aplicar en**: todo lugar que convierta un `number` de USD a unidades
  atómicas. `grep -rn "toFixed(" src/` antes de agregar un rail nuevo. Regla:
  **nunca `toFixed(d)` con `d > 6` sobre un double para derivar un monto
  on-chain**.

---

### [2026-07-26] Wave 4 — Exponer un enum interno en la respuesta HTTP es una decisión de seguridad, no de tipado

- **Error**: el impulso obvio era serializar el `DownstreamSkipCode` crudo en
  `steps[].downstreamSettle`. Auditados uno por uno, **6 de los 16 códigos filtran
  estado interno** al caller: `INSUFFICIENT_BALANCE` revela que la hot wallet del
  operador está seca en ese rail; `CHAIN_ENVIRONMENT_DRIFT` es por definición un
  bug de config nuestro (si el gateway apunta a testnet mientras publica
  mainnet); `MAINNET_NOT_ALLOWED` permite enumerar la allow-list de
  `WASIAI_DOWNSTREAM_MAINNET_ALLOW`; `SIGNING_FAILED` revela que
  `OPERATOR_PRIVATE_KEY` falta o es inválida.
- **Causa raíz**: los skip-codes se diseñaron para **logs de operador**
  (audiencia interna). Reusar ese vocabulario como contrato público hereda la
  audiencia equivocada.
- **Fix**: mapeo explícito `Record<DownstreamSkipCode, PublicDownstreamSkipCode>`
  **exhaustivo por tipo** en `src/lib/downstream-payment.ts`. Los códigos de
  config del gateway → `NOT_CONFIGURED`; los de wallet/claves del operador →
  `UNAVAILABLE`; sólo se expone verbatim lo que describe la declaración del
  propio agente (dato que el caller ya ve en `/discover`) o un resultado terminal
  de pago.
- **Aplicar en**: cualquier enum interno que se quiera surfacear en una
  respuesta. El guard que hay que copiar es el `Record<...>` exhaustivo: agregar
  un código nuevo sin decidir su visibilidad **no compila**. Sin eso, la fuga
  llega por olvido en la HU siguiente, no en esta.

---

### [2026-07-26] Wave 5 — Un cap duro sobre un Map de idempotencia de dinero puede pagar dos veces

- **Error**: la implementación intuitiva de «cap + TTL» es un LRU con desalojo
  duro. Sobre `_intentSignatures` eso es un bug de dinero: ese Map es lo único
  que hace idempotente el settle de un leg Solana
  (`src/adapters/solana/payment.ts:197-218`). Si la entrada desaparece mientras
  el intent sigue vivo, un retry re-broadcastea la transferencia → **doble pago**.
- **Causa raíz**: un cap duro **tiene** que desalojar algo cuando se llena, así
  que tarde o temprano desaloja una entrada viva. La presión de memoria y la
  corrección de dinero apuntan en direcciones opuestas.
- **Fix**: cap **soft** con **ventana protegida**. Se barre lo expirado; si aún se
  supera el cap se desaloja lo más viejo, pero **nunca** una entrada más joven que
  `TIMEOUT_COMPOSE_MS × 2`. Si todas están protegidas, no se desaloja nada y se
  emite un `warn` (el Map excede el cap a propósito). Ante la duda: **conservar**.
  El override de TTL además tiene **piso** `TIMEOUT_COMPOSE_MS × 2`, para que un
  operador no pueda configurar un TTL que expire dentro de la ventana viva.
- **Aplicar en**: todo cache/dedup in-process que participe del money-path. La
  pregunta de diseño es «¿qué pasa si esta entrada desaparece ANTES de tiempo?».
  Si la respuesta es "se paga dos veces", el cap va soft. Si es "se recomputa",
  puede ir duro.

---

### [2026-07-26] Transversal — verificar el hallazgo antes de arreglarlo (se cumplió, y valió)

- **Qué pasó**: los 5 hallazgos se reprodujeron antes de tocar código. **Dos
  tenían el mapa mal**:
  - H1 afirmaba que «`total` no coincide con lo que se devuelve» como parte del
    bug. Falso: `total !== agents.length` es el contrato correcto de paginación.
    De haberlo "arreglado" según el reporte (`total = agents.length`) se habría
    **destruido** la capacidad de paginar del cliente. El bug real era la
    magnitud (2 en vez de 7), no la semántica.
  - H3 apuntaba a `src/middleware/x402.ts` / `augmentX402ChallengeAmount` y a
    «una conversión que pasa por `Number`». La causa está en los 5
    `src/adapters/*/payment.ts` (`quote()`), no hay ningún `Number(...)`
    involucrado, y el drift no es de 1 wei: va de **−107 a +89** y **cambia de
    signo**. Buscar el `Number` reportado habría sido buscar algo que no existe.
- **Aplicar en**: siempre. Un hallazgo es una **hipótesis con evidencia parcial**,
  no un diagnóstico. El paso 0 es un test que falla reproduciendo el síntoma
  medido; si no se puede escribir, el hallazgo no está entendido todavía.

---

### [2026-07-26] Wave 3 — `quote()` de Solana estaba en 0% de cobertura

- **Error**: apliqué el fix del monto atómico a los 5 adapters, la suite pasó, y
  `--coverage.include='src/adapters/**/payment.ts'` mostró que el call site de
  `usdToAtomicUnits` en `solana/payment.ts` tenía **0 hits**. El fix estaba en
  código que la suite nunca ejecuta: indistinguible de un fix que nunca corre.
- **Causa raíz**: `payment.test.ts` de Solana cubría `settle`/`verify`/el seam de
  idempotencia, pero nadie había testeado `quote()` — y `quote()` es justamente
  el productor del monto del challenge 402.
- **Fix**: 3 tests de `quote()` en `src/adapters/solana/payment.test.ts`,
  incluyendo un mint de **9 decimales** (donde el artefacto de `toFixed` SÍ
  aparece, a diferencia de los 6 del default). Los otros 4 adapters ya tenían
  13/16/16/3 hits.
- **Aplicar en**: **todo fix del money-path se cierra con
  `--coverage.include=<archivo>` y se verifica hit-por-línea**, no con "la suite
  pasa". Un `expect` que nunca corre y un fix que nunca corre son el mismo
  artefacto desde afuera.

---

### [2026-07-26] Wave 4 — Un decorador de logs es tan bueno como el log que decora

- **Error**: el diseño para capturar el skip-code era decorar el
  `DownstreamLogger` y leer el `{ code }` que los 25 caminos de `return null` ya
  loguean. Al auditar los 25 sitios apareció que **`FLAG_OFF` se loguea una vez
  por proceso** (dedup WKH-235a, `_warnedFlagOff`): del 2º request en adelante el
  decorador no habría visto NADA y la señal nueva habría estado ausente en
  producción con el flag apagado — o sea justo en el caso más común.
- **Causa raíz**: asumir que "todos los sitios loguean el código" implica "el log
  ocurre en cada invocación". Un dedup warn-once rompe ese puente y no se ve
  leyendo el `return null`: hay que mirar el `if` que envuelve el log.
- **Fix**: `noteSkip(logger, 'FLAG_OFF')` explícito en ese branch (1 línea, el
  comportamiento del log no cambia) + un test que verifica la señal
  **específicamente en el 2º leg**, cuando el log ya no se emite.
- **Aplicar en**: cualquier mecanismo que derive estado observando logs. Antes de
  confiar en un log como canal de datos:
  `grep -n "_warned\|once per process\|dedup" <modulo>`. Si hay dedup, ese log NO
  es un canal confiable.
