# Censo · consultas sobre tablas con `owner_ref` que NO filtran por dueño

> HU **WKH-SEC-03** · AC-6 · commit base `ef384b775ed990d9ad26c3df55a0681ba6d97c14`
> Instrumento: `test/ownership-filter-guard.scanner.ts` (`deriveTables` + `scanSource`)
> Fecha de la corrida: 2026-08-05

Este censo **no arregla nada**. Mide. Cada fila dice por qué ese sitio concreto no lleva
`.eq('owner_ref', …)`, leída del código, no inferida de la salida del escáner.

---

## 1. Cómo cierra el conteo

El censo cierra **por construcción**, no por `grep`:

```
tablas en Database.public.Tables ............................. 62
tablas cuyo Row declara owner_ref ............................ 21

cadenas supabase.from(<tabla con dueño>) en src/ no-test .... 101
  con filtro de dueño ........................................ 46
  SIN filtro de dueño ........................................ 55      ← este censo
argumentos de .from() no resolubles ........................... 0

55 = Σ de todas las categorías ................................ ✓
entradas `idor-vivo` .......................................... 0      ← CD-14 no se dispara
```

Desglose por verbo de las 55 sin dueño:

| Verbo | Cantidad | ¿En el alcance del guardián? |
|---|---|---|
| `select` | 37 | sí |
| `update` | 4 | sí |
| `delete` | **0** | sí (no hay ninguno) |
| `insert` | 11 | no |
| `upsert` | 3 | no |
| **total** | **55** | **41 en alcance** |

**Mi medición coincide exactamente con la del Story File** (101 / 46 / 55 / 0, y 62 / 21 tablas),
con un escáner escrito de forma independiente. Son tres instrumentos distintos convergiendo en el
mismo número, así que el conteo dejó de crecer: 23 → 55 → **55**.

---

## 2. Las categorías

Unión **cerrada**. Cada entrada va en exactamente una. `test/ownership-filter-guard.exceptions.ts`
valida en **runtime** que ninguna excepción use una categoría fuera de esta lista.

| Categoría | Qué significa | Entradas |
|---|---|---|
| `idor-vivo` | el caller elige el identificador y no hay chequeo de dueño **en ningún lado** | **0** |
| `insert-estampa` | INSERT/UPSERT: no filtra, sella el dueño | 14 |
| `auth-por-hash` | la consulta **decide quién sos**; todavía no hay dueño contra el cual filtrar | 4 |
| `alcance-por-fila-del-caller` | filtra por una columna cuyo valor sale de la fila que el caller **ya autenticó**, no del request | 3 |
| `catalogo-publico` | la tabla es un catálogo compartido: se consulta igual para todos **por diseño** | 9 |
| `admin-cross-tenant` | lectura/escritura global detrás de un gate de admin | 12 |
| `worker-sin-caller` | barrido de fondo; no hay caller cuyo dueño usar | 6 |
| `ligadura-de-fila` | compare-and-set o idempotencia sobre un id derivado del servidor | 2 |
| `chequeo-en-js` | se lee sin filtro **a propósito**, y el dueño se compara después en JavaScript | 3 |
| `unicidad-global` | pre-chequeo de unicidad que **por definición** cruza inquilinos | 1 |
| `probe-de-esquema` | la consulta no lee datos: sólo comprueba que la columna/tabla resuelva | 1 |
| `punto-ciego-del-escaner` | falso positivo por cadena partida en variable | **0** |
| | | **55** |

### 2.1 · Dos categorías que agregué, y por qué

El Story File trae una unión de 10. Leyendo los 55 sitios uno por uno aparecieron **dos que no
entran en ninguna**, y meterlos con calzador en la más parecida hubiera sido escribir un motivo
falso:

- **`unicidad-global`** — `src/services/identity.ts:330`. `bindErc8004Identity` pregunta si existe
  **otra key activa, de cualquier dueño**, con el mismo `token_id + chain`. Un pre-chequeo de
  unicidad que se filtrara por dueño no sería un pre-chequeo de unicidad: dejaría entrar el
  duplicado del vecino. Selecciona **sólo `id`** (`:331`, con el comentario
  *«SOLO id — NUNCA budget/funding_wallet (CD-2)»`*), así que no devuelve datos de nadie.
- **`probe-de-esquema`** — `src/adapters/escrow/schema-preflight.ts:142`. No lee filas: hace
  `.select('debit_hop2_attempted_at').limit(1)` y mira **únicamente `col.error`**, para saber si
  PostgREST resuelve la columna. Filtrar por dueño no cambiaría nada de lo que la función observa.

`chequeo-en-js` es la categoría que hace que esto no sea burocracia: si el guardián exigiera
`.eq('owner_ref', …)` sin excepciones, «arreglar» `src/services/arbiter.ts:594` sería una regresión
de comportamiento — se pierde la distinción 403/404 que el código eligió a propósito
(`arbiter.ts:591-592`).

### 2.2 · `punto-ciego-del-escaner` quedó en CERO, y eso corrige al Story File

El Story File (§8.W1, agujero 2) declara **11 sitios** de cadena partida en variable:
`src/services/discovery.ts:442,449,454,460,468,477,535`, `src/services/task.ts:131,134`,
`src/routes/mock-registry.ts:74,83`. **Medido: ninguno de los 11 es una cadena de PostgREST.**

```
grep -c supabase src/services/discovery.ts    → 0
grep -c supabase src/routes/mock-registry.ts  → 0
sed -n '442p' src/services/discovery.ts       → "      allAgents = allAgents.filter("
sed -n '74p'   src/routes/mock-registry.ts    → "      agents = agents.filter("
```

Son reasignaciones de **arrays en memoria** (`allAgents = allAgents.filter(...)`), no query
builders. Esos dos archivos no importan `supabase` en absoluto. Quien los midió buscó la *forma*
`x = x.metodo(...)` sin mirar el **receptor** — que es exactamente el modo de falla contra el que
el propio Story File advierte en CD-13, regla 1.

El único sitio real de cadena partida sobre una tabla con dueño es **`src/services/task.ts:124`**
(`taskService.list`), y **no produce falso positivo**: el `.eq('owner_ref', ownerRef)` está en
`:126`, o sea **antes** de la partición (`:131` y `:134` agregan `status` y `context_id`). El
escáner lo ve entero y lo cuenta entre las 46 **con** filtro.

La clase de punto ciego es real y la categoría se queda en la unión: una cadena futura que ponga el
filtro de dueño **después** del `if` caería ahí. Hoy la población medida es **0**.

---

## 3. Las 41 cadenas en el alcance del guardián (`select` / `update` / `delete`)

Cada una tiene su entrada gemela en `test/ownership-filter-guard.exceptions.ts`.
La columna «motivo en el código» apunta al docblock que ya lo explica, cuando existe.

### `probe-de-esquema` (1)

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 1 | `src/adapters/escrow/schema-preflight.ts:142` | `a2a_payment_intent_debit_signatures` | select | Probe de esquema: sólo mira `col.error` para saber si PostgREST resuelve la columna `debit_hop2_attempted_at`. Nunca lee la fila que trae. | `:138-139` |

### `auth-por-hash` (4)

La consulta es la que **decide quién sos**. Filtrar por dueño requeriría conocer el dueño, que es
justamente lo que esta consulta averigua. Los cuatro sitios lo dicen en su propio docblock.

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 2 | `src/services/agent-link.ts:243` | `a2a_agent_links` | select | `lookupByTokenHash`: el caller se autentica CON el token; el dueño se deriva del row encontrado. | `:236-239` |
| 3 | `src/services/delegation.ts:271` | `a2a_delegations` | select | `lookupByTokenHash`: ídem, por `session_token_hash`. | `:266-268` |
| 4 | `src/services/identity.ts:93` | `a2a_agent_keys` | select | `lookupByHash`: resuelve la agent key desde el SHA-256 de la credencial presentada. Es el origen de todo `owner_ref` del sistema. | `:88-90` |
| 5 | `src/services/key-session.ts:266` | `a2a_key_sessions` | select | `lookupByTokenHash`: ídem, por `session_token_hash`. | `:259-262` |

### `alcance-por-fila-del-caller` (3)

El identificador **no sale del request**: sale de la fila que el caller ya autenticó. Es alcance por
dueño aunque la cadena no nombre `owner_ref`.

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 6 | `src/services/agent-link.ts:265` | `a2a_agent_keys` | select | `getKeyById`: el `keyId` sale del row del link que autenticó con el token, no del request. | `:258-261` |
| 7 | `src/services/delegation.ts:293` | `a2a_agent_keys` | select | `getParentKey`: el `keyId` proviene del row de la delegación. El docblock lo dice literal: *«NOTA PARA AR-CR: no es IDOR (key_id proviene del row de la delegación)»*. | `:288` |
| 8 | `src/services/key-session.ts:286` | `a2a_agent_keys` | select | `getParentKey`: el `keyId` sale del row de la sesión que autenticó con su token. | `:279-282` |

### `catalogo-publico` (9)

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 9 | `src/services/agent.ts:343` | `a2a_agents` | select | `getSplitContextRow(slug)`: busca al dueño de un agente de un **tercero** para resolver su pata de creator en los splits. `owner_ref` es la columna que se **lee**, no por la que se filtra; el resultado es server-side exclusivo y nunca entra a un shape público. | `:330-335` |
| 10 | `src/services/agent.ts:454` | `a2a_agents` | select | `listAsAgents`: la vista pública descubrible, acotada por `enabled = true`. | `:449-450` |
| 11 | `src/services/agent.ts:494` | `a2a_agents` | select | Anclas de discovery por lista de slugs, acotada por `enabled = true`. El caller pide slugs del catálogo público. | — |
| 12 | `src/services/agent.ts:527` | `a2a_agents` | select | `getBySlugAsAgent`: resolución pública de un agente por slug, acotada por `enabled = true`. | `:521-523` |
| 13 | `src/services/identity.ts:421` | `a2a_agent_keys` | select | `resolveIdentityForAgent`: trae **sólo** `erc8004_identity` de keys activas, para la ficha pública de un agente. Ninguna columna de dinero ni PII. | `:422` |
| 14 | `src/services/identity.ts:471` | `a2a_agent_keys` | select | `resolveErc8004AgentId`: ídem. *«NO es lectura por keyId del caller ni expone nada por ruta HTTP; NO es IDOR»*. | `:462-464` |
| 15 | `src/services/registry.ts:174` | `registries` | select | `list()`: catálogo compartido de registries, público por diseño y ya redactado (`RegistryPublic`, sin `auth.value`). | `:165-170` |
| 16 | `src/services/registry.ts:211` | `registries` | select | `getWithSecrets(id)`: lectura **interna** del mismo catálogo compartido para armar los headers de un fetch outbound. El resultado nunca cruza HTTP. | `:201-207` |
| 17 | `src/services/registry.ts:464` | `registries` | select | `getEnabled()`: ídem, para el fanout outbound. | `:454-460` |

> ⚠️ Nota de esquema: `registries` **sí tiene** `owner_ref: string`
> (`src/types/database.types.ts:2567`). La fila de `CLAUDE.md:205` que dice «`registries` | — (admin
> global) | N/A» afirma que la columna no existe. El acceso compartido sigue siendo correcto por
> diseño; lo falso es la tabla del `CLAUDE.md`. Se corrige en W4.3.

### `admin-cross-tenant` (12)

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 18 | `src/services/arbiter.ts:1178` | `a2a_payment_intents` | select | `listHolds`: *«cross-tenant DELIBERADO … superficie de ALTO PRIVILEGIO gateada SÓLO por `requireAdminToken`»*. Ruta `src/routes/dashboard.ts:477`. | `:1171-1174` |
| 19 | `src/services/arbiter.ts:1237` | `a2a_payment_intents` | select | `resolveHold`: override humano admin-gated; lee el row real para tomar `owner_ref` como dato autoritativo. Ruta `POST /api/arbitrations/:intentId/resolve` = `dashboard.ts:515-516`, gate `requireAdminTokenStrict` en `:517` (fail-closed en dev Y prod). ⚠️ **Acá decía `dashboard.ts:630`, y era un puntero AUTO-CONFIRMANTE**: esa línea también es un `requireAdminTokenStrict`, pero de `POST /api/reconciliation/:intentId/resolve`, que llama a `reconciliationService.resolveIntent` (`:633`). Quien fuera a verificarlo encontraba el gate que esperaba encontrar y estampaba OK sin haber mirado nunca la ruta de arbitraje. La conclusión no cambia; la evidencia sí. | `:1233-1235` |
| 20 | `src/services/arbiter.ts:1270` | `a2a_arbitrations` | select | `resolveHold`: lectura best-effort de la evidencia del hold. Misma ruta y mismo gate que la #19: `dashboard.ts:515-517`. (Mismo puntero corregido.) | `:1265-1266` |
| 21 | `src/services/event.ts:120` | `registries` | select | `stats()`: contador global del panel. Ruta `dashboard.ts:424`, gate `requireAdminToken` (opt-in: **503 en producción** si `DASHBOARD_ADMIN_TOKEN` no está, passthrough en dev). | `:113-115` |
| 22 | `src/services/event.ts:128` | `tasks` | select | `stats()`: agregado de tasks por status, mismo gate. Sólo lee la columna `status`. | `:126` |
| 23 | `src/services/reconciliation.ts:564` | `a2a_payment_intent_debit_signatures` | select | `readLeasedRow(intentId)`: el intent lo elige el operador del panel. Ruta `dashboard.ts:680` / `:742`, gate `requireAdminTokenStrict` (fail-closed). | `:552-558` |
| 24 | `src/services/reconciliation.ts:614` | `a2a_payment_intent_debit_signatures` | select | `listPending`: *«cross-tenant DELIBERADO (patrón `listHolds`)»*. Ruta `dashboard.ts:598`. | `:604-606` |
| 25 | `src/services/reconciliation.ts:655` | `a2a_payment_intents` | select | `listAmbiguous`: *«cross-tenant DELIBERADO … misma justificación que `listPending`»*. | `:649-651` |
| 26 | `src/services/reconciliation.ts:886` | `a2a_payment_intent_debit_signatures` | select | `resolveIntent(intentId)`: el intent lo elige el operador. Gate `requireAdminTokenStrict`. | `:879` |
| 27 | `src/services/reconciliation.ts:1349` | `a2a_payment_intent_debit_signatures` | select | `driftCheck`: reporte global de drift por key, sólo lectura. Ruta `dashboard.ts:598`. | `:1340-1342` |
| 28 | `src/services/trace.ts:403` | `a2a_receipts` | select | `lastCrossChainSettle`: indicador de vida del rail. Ruta `dashboard.ts:390`, gate `requireAdminTokenForTrace` (**fail-closed en dev Y prod**). | `:397-399` |
| 29 | `src/services/trace.ts:523` | `a2a_receipts` | select | `recentCalls`: traza operativa global, mismo gate fail-closed. | `:511-512` |

### `worker-sin-caller` (6)

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 30 | `src/services/payment-intent.ts:1635` | `a2a_payment_intents` | select | `expireStale` (cron): *«barrido de sistema … el owner guard usa el `owner_ref` de la propia fila — NO es IDOR»*. Intents `open` vencidos. | `:1625-1629` |
| 31 | `src/services/payment-intent.ts:1653` | `a2a_payment_intents` | select | `expireStale`: intents `closing` huérfanos. | `:1645-1648` |
| 32 | `src/services/payment-intent.ts:1667` | `a2a_payment_intents` | select | `expireStale`: intents `arb_closing` huérfanos. | `:1663-1665` |
| 33 | `src/services/payment-intent.ts:1682` | `a2a_payment_intents` | select | `expireStale`: intents `disputed` huérfanos. | `:1677-1680` |
| 34 | `src/services/refund-outbox.ts:223` | `a2a_refund_outbox` | update | `markDone(id)`: el worker de outbox marca aplicado el entry que él mismo tomó. El `id` no viene de ningún request. | `:219` |
| 35 | `src/services/refund-outbox.ts:259` | `a2a_refund_outbox` | update | `bumpAttempt(row)`: el worker reencola o sepulta la fila que ya tiene en la mano. | `:247-250` |

### `ligadura-de-fila` (2)

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 36 | `src/services/receipt.ts:192` | `a2a_receipts` | update | UPDATE-once del `receipt_hash` sobre la fila **recién insertada por este mismo proceso** (`.eq('id', inserted.id)`), con compare-and-set `.eq('receipt_hash', '')`. El id no lo eligió nadie: lo devolvió el INSERT. | `:183-185` |
| 37 | `src/services/reconciliation.ts:1129` | `a2a_payment_intent_debit_signatures` | update | Lease de evidencia: compare-and-set sobre `(key_id, debit_nonce, debit_settle_status='resolving_settle')`, los tres derivados de la fila ya leída y claimeada. | `:1123-1126` |

### `chequeo-en-js` (3)

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 38 | `src/services/agent.ts:318` | `a2a_agents` | select | `getRow(slug)`: pre-fetch deliberadamente **sin** filtro, para poder distinguir «no existe» de «no es tuyo». El dueño se compara en JS en `:580` (update) y `:701` (delete), que lanzan `OwnershipMismatchError`. También se usa como pre-check de colisión de slug en `:407`, donde no hay dueño que comparar. | `:313-314` |
| 39 | `src/services/arbiter.ts:594` | `a2a_payment_intents` | select | *«Owner-check en app (no owner-guarded SELECT) para preservar `OWNERSHIP_MISMATCH` vs `INTENT_NOT_FOUND`»*. El chequeo real está en `:606-608`. Filtrarlo colapsaría 403 y 404 en uno solo. | `:591-592` |
| 40 | `src/services/fee-split.ts:645` | `a2a_fee_splits` | select | `reverseFeeSplits`: lee TODAS las patas de la orquestación y filtra por dueño en JS en `:676` (`rows.filter(r => r.owner_ref === ownerRef)`), devolviendo `ownership_mismatch` si ninguna es del caller. El UPDATE que sigue (`:697`) **sí** lleva `.eq('owner_ref', ownerRef)`. | `:675-681` |

### `unicidad-global` (1)

| # | Sitio | Tabla | Verbo | Motivo | Motivo en el código |
|---|---|---|---|---|---|
| 41 | `src/services/identity.ts:330` | `a2a_agent_keys` | select | Pre-chequeo de unicidad de `erc8004_identity` (token+chain) entre **todas** las keys activas. Acotarlo por dueño lo volvería inútil: dejaría entrar el duplicado de otro inquilino. Devuelve **sólo `id`**. | `:320-322`, `:331` |

---

## 4. Las 14 cadenas `insert` / `upsert` (fuera del alcance del guardián)

Todas son `insert-estampa`: un INSERT no filtra, **sella**. Verifiqué en las 14 que el payload lleva
`owner_ref`.

| # | Sitio | Tabla | Verbo | De dónde sale el `owner_ref` estampado |
|---|---|---|---|---|
| 1 | `src/services/agent-link.ts:217` | `a2a_agent_links` | insert | `minterKey.owner_ref` (`:208`) |
| 2 | `src/services/agent.ts:433` | `a2a_agents` | insert | el `row` armado con el `ownerRef` del caller |
| 3 | `src/services/arbiter.ts:520` | `a2a_arbitrations` | upsert | parámetro `ownerRef` (`:523`) |
| 4 | `src/services/delegation.ts:241` | `a2a_delegations` | insert | el `row` de la delegación |
| 5 | `src/services/fee-split.ts:393` | `a2a_fee_splits` | insert | parámetro `ownerRef` (`:397`) |
| 6 | `src/services/fee-split.ts:570` | `a2a_fee_splits` | insert | `s.ownerRef` (`:574`) |
| 7 | `src/services/identity.ts:75` | `a2a_agent_keys` | insert | `input.owner_ref` (`:65`) |
| 8 | `src/services/inbound-task.ts:288` | `a2a_inbound_tasks` | insert | parámetro `ownerRef` (`:280`) |
| 9 | `src/services/key-session.ts:231` | `a2a_key_sessions` | insert | el `row` de la sesión |
| 10 | `src/services/llm/transform.ts:301` | `kite_schema_transforms` | upsert | parámetro `ownerId` |
| 11 | `src/services/refund-outbox.ts:94` | `a2a_refund_outbox` | insert | `entry.ownerRef` (`:98`) |
| 12 | `src/services/registry.ts:274` | `registries` | insert | `registryToRow({ …config, ownerRef })` (`:271`) |
| 13 | `src/services/spend-policy.ts:135` | `a2a_key_spend_policies` | upsert | el `upsertRow` armado con el dueño del caller |
| 14 | `src/services/task.ts:81` | `tasks` | insert | `const row = { owner_ref: ownerRef }` (`:74`) |

**Por qué el guardián no los mira.** La regla alternativa («que `owner_ref` aparezca en el payload»)
no sirve: en 9 de los 14 el payload es una variable armada antes (`row`, `upsertRow`, `entry`), así
que un guardián textual daría 9 rojos falsos. Un guardián que nace con 9 rojos falsos se termina
exceptuando entero. El estampado se prueba con tests de propiedad, no con un escáner de texto: el
patrón es `src/services/task.ownership.test.ts:323-331`.

---

## 5. Lo que este censo NO dice

- **No dice que los 46 filtros presentes funcionen.** Dice que están escritos. El valor que se les
  pasa no lo mira nadie acá: `.eq('owner_ref', otroOwner)` cuenta como «con filtro».
- **No dice que las 55 sin filtro estén bien.** Dice por qué cada una está así **hoy**, con la
  evidencia que encontré leyéndola. Si un motivo es falso, es falso en esta tabla y se puede
  discutir fila por fila — que es exactamente lo que antes no se podía hacer.
- **No mide RLS.** Mientras el cliente use `SUPABASE_SERVICE_KEY` (BYPASSRLS), RLS no vuelve
  redundante ningún filtro de aplicación. Es WKH-SEC-02.
- **No cubre las tablas sin `owner_ref`.** 41 de las 62 tablas quedan fuera por construcción.

---

## 6. Hallazgos que salieron de hacer el censo

1. **`punto-ciego-del-escaner` es 0, no 11.** Los 11 sitios citados por el Story File son
   reasignaciones de arrays en JavaScript, no cadenas de PostgREST. Ver §2.2.
2. **`registries` tiene `owner_ref`** y `CLAUDE.md:205` dice que no. Ver §3, nota de esquema.
3. **`reverseFeeSplits` (`src/services/fee-split.ts:640`) no tiene ningún llamador de producción.**
   `grep -rn 'reverseFeeSplits' src --include=*.ts` fuera de tests devuelve sólo su propia
   definición y dos comentarios. Es de SEC-04, se anota y no se toca.
4. **El UPDATE de `hit_count` de `src/services/llm/transform.ts:269-278` nunca se ejecuta.** Está
   escrito como `void supabase.from(...).update(...).eq(...)`, sin `await` ni `.then()`. En
   `@supabase/postgrest-js@2.101.1` el request sale **dentro de `then()`**
   (`dist/index.mjs:104`, único call-site de `fetch` de la librería), así que una cadena que nadie
   resuelve no llega nunca a la base. Ver `src/services/llm/transform.ownership.test.ts`, que lo
   fija con un test. Arreglarlo está fuera del alcance de esta HU (CD-1: cero líneas de producción).
