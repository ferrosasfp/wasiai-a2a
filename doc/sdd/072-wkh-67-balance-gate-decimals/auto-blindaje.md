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

---

### [2026-04-30 — F4 QA] Lección arquitectónica — Decimals separation (AC-14, CD-25)

> **Aplicado por**: QA F4. Esta lección no fue producida en F3 porque
> el bug raíz ocurrió en WKH-66, no durante la implementación de WKH-67.
> CD-25 delega explícitamente este cierre a F4.

#### El error que origina esta HU (WKH-66 → WKH-67)

WKH-66 montó el balance-gate del operator wallet en `api/mcp.mjs::runWithBalanceGate`
reutilizando el argumento `args.maxAmountWei` como `requestedWei` del claim
atómico. Pero `args.maxAmountWei` fue introducido en WKH-64 AC-11 para el
**sign guard INBOUND PYUSD** (Kite testnet, 18 decimales). La reutilización
silenciosa del mismo arg en dos guards con dimensiones radicalmente distintas
(10^18 vs 10^6) produjo un bug matemáticamente irresoluble: no existe ningún
valor numérico que satisfaga ambos checks.

Resultado: 100% de los `pay_x402` calls rebotaban con `stage:'balance-gate'`
en mainnet, deploy funcionalmente broken, rollback manual, cron-job.org
disabled.

#### Regla (para futuros SDDs y ARs)

**"Params shared across guards must have same unit/decimals — distinct concerns
get distinct args."**

Concretamente:

- Un argumento de entrada que representa un monto tiene una **dimensión**:
  (cadena, token, decimales). Ejemplo: `maxAmountWei` es PYUSD-18d-Kite.
- Si el mismo handler ejecuta DOS guards sobre dos cadenas/tokens con decimales
  distintos, cada guard DEBE tener su propio argumento — o derivar su input
  de una fuente dimensional correcta.
- PROHIBIDO reutilizar el mismo argumento posicional/named como input de dos
  guards que operen en dimensiones distintas (CD-20).

#### Patrón AR/CR para detectar esta clase de bug

Cuando un PR toca payment guards en `src/handlers.mjs` o `api/mcp.mjs`:

1. **Grep `args.maxAmountWei`** — verificar que SÓLO aparece en el cap guard
   PYUSD (sección `[2]` del handler). Si aparece en el balance-gate, BLOQUEANTE.
2. **Grep `payload.maxBudget`** — verificar que SÓLO aparece en el balance-gate
   (sección `[1.5]`). Si aparece en el sign/settle, BLOQUEANTE.
3. **Grep cualquier argumento de tipo `wei`** que se pase a DOS llamadas de
   check distintas. Buscar `checkBalanceWithClaim` y el cap guard, verificar
   que sus inputs provienen de fuentes distintas.
4. **Preguntar en cada guard**: ¿el input viene de la cadena correcta? ¿los
   decimales coinciden con el contrato del módulo receptor?

#### CD para futuros SDDs

> **CD-DEC-01 (para propagar a SDDs futuros)**: PROHIBIDO usar el mismo
> argumento (named param o positional) como input de dos guards/checks que
> operen en cadenas, tokens o decimales distintos. Cada guard SHALL recibir
> su input desde una source-of-truth dimensional consistente y DIFERENTE.
> AR/CR DEBE grep cada guard y cruzar la fuente de su input con la dimensión
> documentada del contrato receptor. Si hay cross-uso, el finding es
> BLOQUEANTE.

#### Cómo WKH-67 lo resuelve

Approach A (cementado en F1): cada guard usa su propia dimensión:

| Guard | Input | Fuente | Cadena | Decimales |
|-------|-------|--------|--------|-----------|
| Balance-gate [1.5] | `requestedWei` | `usdcToWei(payload.maxBudget)` | Avalanche C-Chain mainnet | USDC 6d |
| Sign guard [2] | `guard` | `resolveMaxAmountGuard(maxAmountWei, ...)` | Kite testnet | PYUSD 18d |

Grep de ambos en el PR confirma zero cross-uso (handlers.mjs verificado en
F4 QA).
