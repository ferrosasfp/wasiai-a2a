# Auto-Blindaje — WKH-67 — Balance-gate decimals separation

Errores cometidos durante F3 y cómo se corrigieron. Documentado para que
futuras HUs no repitan el mismo error.

---

### [2026-04-29 14:00] Wave 2 — Prototype-pollution bypass del balance-gate

- **Error**: la primera versión del check `payload?.maxBudget` aceptaba
  valores heredados via prototipo. Un caller hostil podía construir
  `Object.create({ maxBudget: 0.5 })` y bypassear V9 en el Story File.
  Test T-FIX-12 (sub-caso prototype pollution) detectó el bypass.
- **Causa raíz**: `payload?.maxBudget` lee la cadena de prototipos en JS.
  CD-22 valida tipo y rango, pero no exige propiedad propia.
- **Fix**: usar `Object.hasOwn(payload, 'maxBudget')` antes de leer el
  valor. Defense-in-depth alineado con V9.
- **Aplicar en**: cualquier validación de input de payload que reciba un
  objeto controlado por el caller. Si la app extrae propiedades por nombre
  string desde un objeto sin `Object.hasOwn`, hay riesgo de prototype
  pollution.

---

### [2026-04-29 14:30] Wave 4 — Ripple effect en tools.test.mjs (15 tests rotos)

- **Error**: la primera ejecución de `npm test` tras W3 reportó 17 tests
  baseline rotos. El Story File §15 marca >5 como [BLOCKER ripple effect].
- **Causa raíz**: insertar el balance-gate INSIDE `payX402Handler` cambia
  el contrato del handler — ahora requiere KV configurado + `payload.maxBudget`
  + RPC reachable. Tests pre-existentes en `tools.test.mjs` y `http.test.mjs`
  llamaban al handler sin esos pre-requisitos. El Story File §3 lista
  `tests/tools.test.mjs` en Scope OUT pero no marca explícitamente que se
  espera ripple ahí — es un gap del SDD.
- **Fix**: adaptación mínima `tools.test.mjs`:
  - `beforeEach` setea env vars de balance-gate + KV mock + reset avax-client.
  - `makeFetchFake` intercepta `avax.network` URLs sin contarlas en el
    array `calls[]` (assertions legacy esperan probe + settle).
  - 14 call-sites de `payX402Handler` reciben `payload: { maxBudget: 0.1 }`.
  - 3 tests con custom fetchFn (Bonus V7.1, T-X11, T-X14) reciben un guard
    explícito `if (u.includes('avax.network')) return <hex>`.
  - Tests que rechazan en validación pre-probe (T-X1..T-X8, T-X12 probe
    302) se dejan intactos: nunca llegan al balance-gate.
  - Tests que reciben input adversarial específico (T34 forbidden keys,
    Bonus AC-10) reciben `payload.maxBudget: 0.1` adicional sin alterar la
    intención original.
- **Aplicar en**: cualquier refactor que mueva lógica externa (wrapper) a
  inside-handler en una pieza con tests legacy que la llamaban directo. La
  norma debe ser **escribir un wrapper test-friendly** o **actualizar el
  exemplar de tests legacy en el mismo PR**. Story Files futuros que
  inserten lógica obligatoria post-probe deben listar explícitamente el
  test surface a adaptar.

---

### [2026-04-29 14:45] Wave 4 — RPC mock: viem usa globalThis.fetch

- **Error**: tentativa inicial de mockear el balance read con un mock
  `publicClient` injectable. El handler usa `getAvaxClient(rpcUrl)` que
  llama a `createPublicClient` de viem; el cliente ya está hardcoded
  internamente.
- **Causa raíz**: `getAvaxClient` es un singleton sin override público.
  No expone `.readContract` para mocking por inyección.
- **Fix**: la convención del repo (heredada de WKH-66 T-HTTP-14) es
  interceptar `globalThis.fetch` para URLs que contengan `avax.network` y
  responder con el hex eth_call esperado. Más entre `_resetAvaxClient()`
  resetea el singleton entre tests para que cada uno arranque con un
  cliente nuevo bound al fetch override del momento.
- **Aplicar en**: cualquier test que ejercite código que pase por `viem`
  o cualquier librería HTTP que use `globalThis.fetch` por defecto. El
  patrón "intercept-by-URL-substring" es la única forma sin tocar el
  módulo singleton.
