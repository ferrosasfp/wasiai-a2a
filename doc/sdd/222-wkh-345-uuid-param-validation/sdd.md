# SDD #222 — [WKH-345] Un `:id` mal formado en cuatro superficies devuelve 500 en vez de 400/422

> Producto de F2 (nexus-architect), sobre `work-item.md` aprobado con `HU_APPROVED`
> el 2026-08-10. Todo número de este documento se midió en el árbol al commit
> **`2745bb2`** y lleva ese commit en la misma línea que la afirmación, o dice
> explícitamente que no lo medí.
>
> Contexto del encargo: **David**, mentor de la incubadora Solana LATAM Labs, va a
> revisar este repo y su API pública. El criterio no es "funciona": es que lo
> primero que él toque no parezca descuidado.

---

## 1. Resumen

`:id` mal formado llega sin validar hasta una columna `uuid` de Postgres, que
responde `22P02 invalid input syntax for type uuid`. Ninguna de las cuatro
superficies traduce ese error a un 4xx, así que el caller recibe un `500`.

Esta HU **desvía el camino malformado antes de la capa de datos** en cinco
archivos de ruta, reusando el predicado que `src/routes/tasks.ts:91-95` ya tiene
—y que hoy es privado de ese módulo—, extraído a `src/lib/uuid.ts`.

⚠️ **No digo "elimina el 500".** La línea que lo restaura, en las cinco
superficies a la vez, es una sola: en `src/lib/uuid.ts`, `return UUID_RE.test(id)`
→ `return true`. Por eso el módulo lleva su propio test unitario (W0) además de
los tests de ruta: si el único candado fuera de integración, ese mutante de una
línea podría sobrevivir donde los fixtures no lo miren. Ver §7 (T-U1) y §9 (M-1).

**Lo que este SDD agrega sobre el work-item, y es lo que cambia el plan:**

1. **CD-3 queda cerrado acá, no en F3.** El censo completo de `req.params` en
   `src/routes/` da **16 archivos** (`2745bb2`); los **4** que nadie había leído
   (`inbound.ts`, `auth/require-signature.ts`, `auth/identity.ts`,
   `auth/spend-policy.ts`) los revisé uno por uno: **ninguno es bug**, con el
   motivo verificado en código para cada uno. No hay 5ª ruta. §3.3.
2. **Hallazgo que el work-item no vio: 20 fixtures de URL en 5 archivos de test
   usan ids que NO tienen forma de UUID** (`sess-1`, `del-1`, `i1`, `rcpt-1`,
   `other-owner-rcpt`) — `2745bb2`. Agregar el guard los pone rojos. O sea: **el
   camino "feliz" de esas suites viajaba por el mismo agujero que esta HU
   arregla**, y ninguna de ellas prueba hoy que la ruta funcione con un id que la
   base aceptaría. Eso obliga a un protocolo de dos pasos para poder afirmar AC-5
   con evidencia en vez de con una promesa. §3.5 y §4 DT-12.
3. **DT-2 del work-item parte de una premisa falsa** para dos de los tres
   archivos: `key-session.ts` y `delegation.ts` **sí** tienen un código previo de
   "forma inválida" (`400 { error_code: 'INVALID_INPUT' }`, `key-session.ts:59`
   y `:177`; `delegation.ts:74`, `:78`, `:81`, `:87` — `2745bb2`). El único
   archivo sin precedente es `receipts.ts`. §4 DT-5.
4. **DT-3 del work-item ("el guard antes de auth") lo corrijo.** Antes de auth
   rompe gates existentes con consecuencia verificable: pondría rojo
   `auth.key-session.test.ts:161` (T-SUBSESSION) y cambiaría el `404` de
   `ARBITER_ENABLED` off a `422`. El guard va **después de todo gate existente y
   antes del primer uso del `:id`**. §4 DT-6.

**Sin cambio de esquema. Sin migración. Sin cambio en ninguna cadena de
`owner_ref`** (§8). Cinco archivos de `src/routes/` + un módulo nuevo en
`src/lib/`.

---

## 2. Work Item — qué hereda este SDD

| Del work-item | Estado en este SDD |
|---|---|
| AC-1 … AC-6 | Heredados sin cambio de texto. Un test como mínimo por AC (§7). |
| DT-1 (extraer el regex TAL CUAL) | **Confirmado**, y reforzado: §4 DT-10 explica por qué tocarlo es una trampa. |
| DT-2 (cada archivo usa su propio código) | **Corregido en su premisa**, confirmado en su conclusión. §4 DT-5. |
| DT-3 (guard antes de auth) | **Corregido**: después de los gates, antes del primer uso del `:id`. §4 DT-6. |
| CD-1 (no tocar el camino del id válido) | Heredado → CD-1. Protocolo de evidencia en DT-12. |
| CD-2 (un solo regex) | Heredado → CD-2, con el matiz de que se comparte el **predicado**, no el respondedor (DT-7). |
| CD-3 (correr el barrido real) | **CERRADO acá** (§3.3). Sigue vivo como CD-3' (re-correr el censo al cierre). |
| CD-4 (no tocar `registries.ts`) | Heredado → CD-4. Re-verificado (§3.4). |
| CD-5 (money-path: no mover plata) | Heredado → CD-5, con el mecanismo verificado (§3.2). |
| Scope OUT (`dashboard.ts` `:intentId`) | **Re-verificado**: los 4 sitios están tras `requireAdminTokenStrict` (§3.4). |

---

## 3. Context Map (Codebase Grounding)

Todo path de esta sección se verificó con `Glob`/`Read`/`grep` en `2745bb2`.
Las líneas citadas de archivos que **esta HU modifica** hay que re-verificarlas
al cierre de F3 (CD-9 — es un error reincidente del repo, §3.6).

### 3.1 El exemplar — `src/routes/tasks.ts`

| Sitio | Qué extraje |
|---|---|
| `src/routes/tasks.ts:90-95` | El bloque a extraer: `const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;` (`:91-92`) + `function isValidUUID(id: string): boolean { return UUID_RE.test(id); }` (`:93-95`). Privado del módulo: no lleva `export`. |
| `src/routes/tasks.ts:127-133` | El **patrón de uso**: `validateTaskId(params)` es una función de forma **pura y síncrona** que devuelve `RejectionBody \| null`, no toca `reply`. El rechazo es `{ error: 'Invalid UUID format' }` (`:130`) — sin `error_code`. |
| `src/routes/tasks.ts:166`, `:307`, `:344`, `:412` | Los 4 call-sites de `validateTaskId`: uno en la cadena pre-cobro (`:166`) y tres defense-in-depth dentro de los handlers. **Ninguno se toca.** |
| `src/routes/tasks.no-charge-before-validating.test.ts:519`, `:536` | Las dos aserciones que **pinean el string exacto**: `expect(res.json().error).toBe('Invalid UUID format')`. Cambiar ese body es un cambio de contrato con dos testigos. |
| `src/routes/tasks.no-charge-before-validating.test.ts:322` | `const UUID = '11111111-2222-4333-8444-555555555555'` — el fixture válido de tasks. Relevante en §4 DT-10: **es conforme a v4**, así que endurecer el regex a v4 dejaría la suite verde. |

### 3.2 El mecanismo del bug, verificado en el esquema y en el mapeo de errores

Las cuatro columnas destino son `uuid` de verdad, no texto (`2745bb2`):

| Tabla | Declaración |
|---|---|
| `a2a_receipts.id` | `supabase/migrations/20260605000000_a2a_receipts.sql:7` — `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| `a2a_key_sessions.id` | `supabase/migrations/20260603000000_a2a_key_sessions.sql:2` — idem |
| `a2a_delegations.id` | `supabase/migrations/20260601000000_a2a_delegations.sql:12` — idem |
| `a2a_payment_intents.id` | `supabase/migrations/20260704000000_wkh135_payment_intents.sql:21` — idem |

Y el camino del error, extremo a extremo:

- **`receipts.ts`**: `receiptService.getById` (`src/services/receipt.ts:286-302`) hace
  `.eq('id', id).eq('owner_ref', ownerRef).single()` (`:292-294`); trata sólo
  `PGRST116` como "0 filas" (`:297`) y para cualquier otro error hace
  `throw new Error(...)` (`:298`). El route **no tiene try/catch**, así que sube al
  error boundary, que responde `error.statusCode ?? 500`
  (`src/middleware/error-boundary.ts:123`) → **500**. AC-1 confirmado.
- **`key-session.ts` / `delegation.ts`**: el error de Postgres no es
  `SessionNotFoundError` / `OwnershipMismatchError`, así que cae al `catch`
  genérico → `500 KEY_SESSION_REVOKE_FAILED` (`key-session.ts:143-145`),
  `500 REQUIRE_SIGNATURE_FAILED` (`:203-205`), `500 DELEGATION_REVOKE_FAILED`
  (`delegation.ts:152-154`). AC-2/AC-3 confirmados.
- **`payments.ts`**: `addVoucher` invoca el RPC `accumulate_payment_voucher`
  (`src/services/payment-intent.ts:1003-1008`) y ante `error` llama
  `mapPgError` (`:1009`). `mapPgError` (`:194-225`) compara el **mensaje** contra
  6 patrones conocidos; `invalid input syntax for type uuid` no matchea ninguno,
  así que cae en `throw new PaymentIntentError('INTERNAL')` (`:224`), y
  `sendPaymentError` mapea el default a **`500 PAYMENT_INTENT_FAILED`**
  (`src/routes/payments.ts:97-98`). Para `openDispute`, `sendArbiterError` mapea su
  default a **`500 ARBITER_FAILED`** (`:124-125`). AC-4 confirmado.

**Dos consecuencias medidas que conviene tener presentes:**

1. `mapPgError:223` hace `log.error({ ctx, detail: msg }, ...)` **antes** de tirar
   `INTERNAL`. O sea que hoy un error de tipeo del cliente escribe un
   `payment intent RPC error` en el log de errores del servicio. El guard mueve
   ese rechazo a antes del RPC, así que ese renglón deja de escribirse **para el
   caso malformado**; no digo que el renglón desaparezca (cualquier otro error de
   RPC lo sigue produciendo, que es su trabajo).
2. **CD-5, el mecanismo, no la promesa.** El valor malformado falla en la
   **coerción del argumento** del RPC (`p_intent_id uuid`), antes de que el cuerpo
   de la función se ejecute, y el `SELECT ... FROM rpc()` es **una sola
   sentencia**, así que aborta atómicamente: ninguna fila cambia de estado.
   Por eso el guard **sólo cambia el status HTTP**, no si se movió plata.
   Qué falsaría esto: un `POST /payments/session/<id-malformado>/close` que hoy
   devuelva `500` y deje el intent en `closing`. Si eso ocurriera, el bug sería
   otro y más grave que esta HU. **No lo probé contra una base** (§10 MI-2).

### 3.3 CD-3 CERRADO — el censo completo de `req.params` en `src/routes/`

Comando y resultado (`2745bb2`):

```
$ command grep -rl "\.params" src/routes/ | sort     # → 16 archivos
```

De los 16, **1 es un archivo de test** (`payments.dispute-ownership.test.ts`), así
que la población de producción es **15**. El veredicto de cada uno:

| Archivo | Param | ¿A dónde llega? | Veredicto |
|---|---|---|---|
| `tasks.ts` | `:id` | Validado en `:129` antes de todo | **Ya correcto** — sólo se refactoriza el import |
| `receipts.ts` | `:id` (`:79`, `:107`, `:115`) | `a2a_receipts.id` (uuid) | **BUG — Scope IN** |
| `auth/key-session.ts` | `:id` (`:131`, `:183`) | `a2a_key_sessions.id` (uuid) | **BUG — Scope IN** |
| `auth/delegation.ts` | `:id` (`:140`) | `a2a_delegations.id` (uuid) | **BUG — Scope IN** |
| `payments.ts` | `:id` (`:264`, `:299`, `:340`, `:494`) | `a2a_payment_intents.id` (uuid), vía RPC | **BUG — Scope IN** |
| `payments.ts` | `:id` (`:383`, `GET .../dispute`) | `a2a_arbitrations.intent_id` (uuid) | **NO es bug** — ver §4 DT-11 |
| `dashboard.ts` | `:intentId` (`:537`, `:634`, `:693`, `:760`/`:769`/`:779`) | uuid, mismo agujero | **Bug, pero Scope OUT** — ver §3.4 |
| `registries.ts` | `:id` (`:134`, `:307`, `:399`) | `registries.id` es slug TEXT | **NO es bug** — CD-4 |
| `agent-card.ts` | `:slug` (`:40`) | slug TEXT | **NO es bug** |
| `agents.ts` | `:slug` (`:299`, `:441`) | slug TEXT | **NO es bug** |
| `discover.ts` | `:slug` (`:334`) | slug TEXT | **NO es bug** |
| `agent-links.ts` | `:slug` (`:109`), `:token` (`:158`) | `.eq('token_hash', hash)` (`src/services/agent-link.ts:245`) — hasheado, TEXT | **NO es bug** |
| `inbound.ts` | `:source` | ver abajo | **NO es bug** |
| `auth/require-signature.ts` | `:id` | ver abajo | **NO es bug** |
| `auth/identity.ts` | `:token_id` | ver abajo | **NO es bug** |
| `auth/spend-policy.ts` | `:destination` | ver abajo | **NO es bug** |

#### Los 4 que nadie había mirado — uno por uno

**1. `src/routes/inbound.ts` — `POST /inbound/:source/tasks` — NO es bug.**
`:source` no es un id, es el **nombre de una fuente** que se usa como sufijo de
variable de entorno. Se sanea a `[A-Z0-9_]` mayúsculas antes de cualquier uso
(`src/services/inbound-task.ts:100-103`, `sanitizeSource`), y `loadSourceConfig`
(`:153`) devuelve `null` si el saneado queda vacío (`:155`) o si falta
`INBOUND_SOURCE_SECRET_<S>` (`:158`). El route traduce ese `null` a
**`401 UNAUTHORIZED`** (`src/routes/inbound.ts:84-86`). En la base sólo se usa como
parte de `(owner_ref, source, external_ref)` — columnas TEXT. Un `:source`
malformado nunca alcanza una columna `uuid` y nunca produce 500. **No entra.**

**2. `src/routes/auth/require-signature.ts` — `PATCH /auth/agent-key/:id/require-signature` — NO es bug.**
El `:id` **no viaja a ninguna query**: se compara en memoria contra la key ya
autenticada, `if (req.params.id !== callerKey.id)` → `403 OWNERSHIP_MISMATCH`
(`:47-49`). Un valor malformado no es igual a ningún UUID, así que sale por ese
403 y las llamadas al service (`:65-69`) reciben `callerKey.id`/`callerKey.owner_ref`,
nunca el param. Agregarle un guard de formato cambiaría ese `403` por un `400`
—un cambio de contrato sin bug detrás— y encima daría feedback de forma a alguien
que todavía no probó ser el dueño. **No entra.**

**3. `src/routes/auth/identity.ts` — `GET /auth/erc8004/resolve/:token_id` — NO es bug.**
El param **no es un UUID**: es un token id de ERC-8004 (numérico), y el archivo
**ya hace exactamente lo que esta HU viene a hacer**: `parseTokenId(req.params.token_id)`
y, si da `null`, `400 { error_code: 'INVALID_INPUT' }` (`:219-222`) **antes** del
único acceso externo, `getErc8004Reader().resolve({ tokenId })` (`:224`). Es un
tercer exemplar del patrón, no un sitio a arreglar.

Sobre la advertencia de `CLAUDE.md` acerca del filtro por dueño de este archivo:
el `:token_id` es de una ruta **pública y de sólo lectura** (`:209-211`: "No auth
(on-chain read)"), no toca Supabase, y su camino no cruza ningún
`.eq('owner_ref', …)`. **Esta HU no modifica `auth/identity.ts`** (no está en el
Scope IN, §6), así que no hay filtro de propiedad que mover ni relajar. CD-7 lo
deja escrito como prohibición explícita por si F3 se tienta.

**4. `src/routes/auth/spend-policy.ts` — `DELETE /auth/keys/me/spend-policies/:destination` — NO es bug.**
`:destination` es una **dirección de destino**, columna TEXT:
`a2a_key_spend_policies.destination` es `string` en
`src/types/database.types.ts:667` (bloque `Row`, `:665-675`). El service normaliza
(`src/services/spend-policy.ts:184`) y filtra
`.eq('key_id', …).eq('owner_ref', …).eq('destination', normalized)` (`:189-191`).
Los dos ids uuid de esa cadena (`key_id`, `owner_ref`) vienen de `callerKey`
—ya autenticado— y no del path (`src/routes/auth/spend-policy.ts:124-128`). Un
destino inexistente sale por `404 SPEND_POLICY_NOT_FOUND` disclosure-safe
(`:134-138`). **No entra.**

> **Conclusión de CD-3**: no hay 5ª ruta. La lista de 4 archivos del work-item es
> completa **para la definición del bug** (param con forma de UUID que llega a una
> columna/RPC `uuid` sin validar), con la única excepción conocida y declarada de
> `dashboard.ts`, que el work-item ya había puesto fuera de alcance y que
> re-verifiqué (§3.4).

### 3.4 Lo que ya estaba bien, o queda afuera — re-verificado, no heredado

- **`registries.ts` (CD-4)**: el lookup por id hace
  `.from('registries').eq('id', id).maybeSingle()`
  (`src/services/registry.ts:211-214`, y el mismo patrón en `:376-378` y
  `:439-441`), donde `id` es un slug TEXT server-derivado. Un valor malformado no
  matchea y `maybeSingle()` da `null`, sin error de Postgres. Además hay **3**
  sitios con `:id` en el route (`:134`, `:307`, `:399`), no uno — el work-item
  citaba sólo el `GET`. Ninguno se toca.
- **`dashboard.ts` `:intentId` (Scope OUT)**: los **4** routes con `:intentId`
  están tras `requireAdminTokenStrict`, verificado sitio por sitio en `2745bb2`:
  `:515`→`:517`, `:628`→`:630`, `:675`→`:680`, `:735`→`:742`
  (`[requireAdminTokenStrict, requireReleaseLeaseToken]`). Ese gate es fail-closed
  (declarado en `:151`, con su docblock en `:125-150`: "SIEMPRE exige el token: si
  `DASHBOARD_ADMIN_TOKEN` no está configurado responde 503 en dev Y prod"). Es la
  misma clase de bug pero no es la superficie anónima que un
  revisor externo toca primero. Queda como fast-follow; **no lo abre esta HU**.
- **`test/ownership-filter-guard.test.ts`**: leí su docblock completo. Es
  relevante porque cuatro de los cinco archivos que toco están aguas arriba de
  cadenas con `.eq('owner_ref', …)`. Lo que ese guardián verifica es **presencia
  textual del filtro, no su valor** (punto 1 de su lista de "qué no cubre"), y
  **los `supabase.rpc(...)` quedan enteros afuera** — que es justo la forma que usa
  `payments.ts`. Consecuencia para esta HU: su verde **no** es evidencia de que no
  rompí nada de propiedad; la evidencia es que **no modifico ninguna cadena de
  Supabase** (§8).

### 3.5 El hallazgo que cambia el plan — 20 fixtures de test viajan por el agujero

Medido con `command grep -n` sobre `src/routes/*.test.ts` en `2745bb2`:

| Archivo de test | Líneas | Valor del id | Endpoint |
|---|---|---|---|
| `src/routes/receipts.test.ts` | `:152`, `:173` | `rcpt-1` | `GET /receipts/:id/verify` |
| `src/routes/receipts.test.ts` | `:189`, `:203` | `other-owner-rcpt` | `GET /receipts/:id` y `/verify` |
| `src/routes/auth.key-session.test.ts` | `:122`, `:152`, `:164` | `sess-1` | `DELETE /auth/key-session/:id` |
| `src/routes/auth.key-session.test.ts` | `:137` | `sess-999` | idem |
| `src/routes/auth.signed-auth.test.ts` | `:236`, `:267`, `:281` | `sess-1` | `PATCH /auth/key-session/:id/require-signature` |
| `src/routes/auth.signed-auth.test.ts` | `:252` | `sess-x` | idem |
| `src/routes/auth.delegation.test.ts` | `:310` | `del-1` | `DELETE /auth/delegation/:id` |
| `src/routes/auth.delegation.test.ts` | `:325` | `del-999` | idem |
| `src/routes/payments.test.ts` | `:153`, `:169`, `:203`, `:281`, `:304`, `:342` | `i1` | los 4 handlers de AC-4 |

**Total: 20 fixtures en 5 archivos** (`2745bb2`). Ninguno tiene forma de UUID.

Tres cosas se siguen de esto, y las tres importan:

1. **Agregar el guard los pone rojos.** No es un efecto colateral evitable: es la
   consecuencia correcta. F3 tiene que reemplazar los 20 valores por ids con forma
   de UUID **y** las aserciones que nombran el mismo string:
   `expect(mockRevoke).toHaveBeenCalledWith('sess-1', 'user-1')`
   (`auth.key-session.test.ts:128` y `:158`),
   `expect(mockRevoke).toHaveBeenCalledWith('del-1', 'user-1')`
   (`auth.delegation.test.ts:316`),
   `expect(mockSessionSetReqSig).toHaveBeenCalledWith('sess-1', 'user-1', true)`
   (`auth.signed-auth.test.ts:243`) — `2745bb2`.

   ⚠️ **Y NO con un find/replace ciego de `'sess-1'`**: en
   `auth.signed-auth.test.ts:296` y `:352` ese mismo string es un **campo de body**
   (`session_id: 'sess-1'`), no un path param. No lo alcanza el guard y cambiarlo
   sólo agrega ruido al diff. El reemplazo se hace sitio por sitio, mirando si el
   string está en una `url:` o en un payload.
2. **Hoy ninguna de esas suites prueba la ruta con un id que la base aceptaría.**
   El caso "feliz" viajaba por el mismo camino malformado que esta HU arregla —
   el patrón `el-test-del-camino-feliz-ejercitaba-el-agujero`. Que las cuatro
   superficies queden ejercitadas con un id válido es un efecto de esta HU, no un
   objetivo declarado del work-item.
3. **Por eso AC-5 necesita un protocolo, no una afirmación.** Si F3 cambia
   fixtures y agrega el guard en el mismo paso, el verde final no distingue "el
   comportamiento del id válido no cambió" de "cambié el fixture hasta que pasó".
   El protocolo de dos pasos está en §4 DT-12 y es obligatorio (CD-8).

### 3.6 Auto-Blindaje histórico — los patrones que se repiten en este repo

Leí los tres `auto-blindaje.md` más recientes. Cuatro patrones aparecen en ≥2 HUs
y los tres primeros aplican de lleno a esta:

| Patrón | Evidencia | Se convierte en |
|---|---|---|
| Mis propias ediciones corren las líneas que yo mismo cito | `doc/sdd/220-…/auto-blindaje.md:25-34` y `doc/sdd/221-…/auto-blindaje.md:36-59` (que se declara reincidente del anterior, y admite que el fix se equivocó una segunda vez dentro de su propia corrección) | **CD-9** |
| Pegar un `archivo:línea` que no leí | `doc/sdd/220-…/auto-blindaje.md:9-22` | **CD-10** |
| Copiar un número de otro artefacto sin re-medirlo | `doc/sdd/220-…/auto-blindaje.md:38-47` | **CD-11** |
| Un test del caso positivo cuyo fixture desactiva el mecanismo que mide | `doc/sdd/219-wkh-342-…/auto-blindaje.md`, Wave 2 | **CD-8** + el control positivo de §7 |

Un cuarto, de `doc/sdd/221-…/auto-blindaje.md:9-35`: un comentario de código que
cita un `doc/…` sin `git add` de la carpeta pone en rojo
`test/docs-referenced-by-code-exist.test.ts`. Esta HU **no** cita documentos desde
código (los comentarios nombran `WKH-345` y archivos de `src/`), así que no
aplica — pero si F3 decide citar este SDD desde un docblock, la carpeta
`doc/sdd/222-…/` tiene que estar staged.

### 3.7 Infraestructura de tests y tipos — verificado

| Hecho | Dónde | Por qué importa |
|---|---|---|
| `vitest.config.ts:5` incluye `src/**/*.test.ts` y `test/**/*.test.ts` | — | Un test nuevo en `src/lib/uuid.test.ts` lo corre `npm test` sin tocar config. `test/test-files-are-run-in-ci.test.ts` no necesita excepción. |
| `tsconfig.json:19` → `"include": ["src/**/*"]` | — | `npx tsc --noEmit` **sí** tipa los `src/**/*.test.ts`. |
| `tsconfig.build.json:6` excluye `src/**/*.test.ts` | — | `npm run build` **no** los tipa. Un error de tipos en un test nuevo pasa el build y lo caza sólo `npx tsc --noEmit`. |
| `package.json:13` → `"test": "vitest run"`; `:11` → `"lint": "biome check src/"` | — | Los tres comandos del cierre. No hay script `typecheck`. |
| `src/lib/` es hoja: cero imports desde `src/routes/` | `command grep -rn "from '\.\./routes" src/lib/` → sin resultados (`2745bb2`) | Sostiene la decisión de ubicación (§4 DT-4). |
| No hay `ajv-formats` en `package.json` | `command grep -n "ajv" package.json` → sin resultados (`2745bb2`) | Sostiene el descarte del schema de Fastify (§4 DT-9). |
| Patrón de test de ruta: Fastify in-process + `vi.mock` del service | `src/routes/receipts.test.ts:26-49` | Permite afirmar `expect(mockGetById).not.toHaveBeenCalled()` — la mitad mecánica de AC-1. |

---

## 4. Diseño técnico

### DT-1 — El regex se extrae TAL CUAL (heredado, confirmado)

`src/lib/uuid.ts` contiene, byte a byte, el patrón de `src/routes/tasks.ts:91-92`:

```ts
/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
```

Cero cambio de semántica. `tasks.ts` pasa a importarlo y borra su copia local.

### DT-2 — El módulo exporta el predicado y el regex, y nada más

```ts
export const UUID_RE: RegExp;
export function isValidUUID(id: string): boolean;
```

`isValidUUID` es lo que consumen los cinco routes. `UUID_RE` se exporta porque
AC-6 lo nombra y porque lo consume el test de flags (§7 T-U3) — no queda superficie
muerta. Nada más se exporta: en particular, **ningún respondedor** (DT-7).

### DT-3 — Ubicación: `src/lib/uuid.ts` (decisión delegada #1)

**Elegido**: `src/lib/uuid.ts` + `src/lib/uuid.test.ts`.

Verificado antes de elegir (`2745bb2`):

- **No existe `src/utils/`**. Los directorios de primer nivel de `src/` son
  `__tests__ adapters config lib mcp middleware routes services static types`.
- `src/lib/` es un directorio **plano de módulos hoja con test colocado**, y ya
  tiene el precedente exacto de un validador puro: `src/lib/url-validator.ts` +
  `src/lib/url-validator.test.ts`. También `caller-hash.ts`, `ed25519.ts`,
  `atomic-amount.ts`.
- `src/lib/` **no importa nada de `src/routes/`** (§3.7), así que `routes → lib`
  no crea ciclo.
- Existe el precedente de exportar una constante regex desde un módulo
  compartido: `export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/`
  (`src/routes/auth/parsers.ts:28`).

**Descartado — `src/routes/auth/parsers.ts`**, que es donde vive hoy lo compartido
entre rutas (`ADDRESS_RE`, `parseSpendPolicyInput`, `resolveCallerKey`): obligaría a
`src/routes/receipts.ts`, `src/routes/payments.ts` y `src/routes/tasks.ts` a
importar desde `src/routes/auth/`, o sea `routes → routes/auth`. Es la dirección
equivocada para tres archivos que no tienen nada que ver con auth. **Descartado —
`src/types/`**: ahí no vive lógica.

Convención de import (ESM NodeNext, con extensión `.js`, como todo el repo):
`../lib/uuid.js` desde `src/routes/*.ts`, `../../lib/uuid.js` desde
`src/routes/auth/*.ts`.

### DT-4 — El regex NO valida versión ni variant, y ahí hay una trampa

El patrón acepta **cualquier** hex con forma 8-4-4-4-12: acepta el nil UUID
`00000000-0000-0000-0000-000000000000`, acepta un v1, acepta un dígito de versión
`9`. **No es "valida UUID v4"** — describirlo así afirma de más. La forma correcta
de nombrarlo, y la que va en el docblock y en el nombre conceptual, es
**"forma de UUID (8-4-4-4-12 hex, case-insensitive)"**.

Por qué **no** hay que endurecerlo a v4 en esta HU, con el mutante nombrado:

- El mutante es de una línea: `[0-9a-f]{4}-[0-9a-f]{4}-` → `4[0-9a-f]{3}-[89ab][0-9a-f]{3}-`.
- **Ese mutante deja la suite verde.** El fixture válido de tasks,
  `'11111111-2222-4333-8444-555555555555'`
  (`tasks.no-charge-before-validating.test.ts:322`), **ya es conforme a v4**, y los
  ids de las cuatro tablas vienen de `gen_random_uuid()` (§3.2), que también es v4.
- O sea que sería un **estrechamiento de contrato cuyo radio de impacto la suite no
  puede mostrar**: un id con forma válida que Postgres aceptaría empezaría a recibir
  `400`, violando CD-1/AC-5, y ningún test se enteraría. Es exactamente la clase
  "un guard que se compara consigo mismo": el instrumento no puede ver el daño.

Por eso CD-2 prohíbe tocar el patrón, y el test T-U2 (§7) fija explícitamente que
el nil UUID **pasa** el predicado — un candado escrito para que ese mutante muera.

### DT-5 — Shape del error, archivo por archivo (decisión delegada #2)

Primero el dato que corrige la premisa de DT-2 del work-item. Medido en `2745bb2`:

- `error_code: 'INVALID_INPUT'` aparece **37 veces en 10 archivos de ruta de
  producción** (`agent-links.ts`, `auth/delegation.ts`, `auth/deposit.ts`,
  `auth/funding-wallet.ts`, `auth/identity.ts`, `auth/key-session.ts`,
  `auth/require-signature.ts`, `auth/spend-policy.ts`, `dashboard.ts`,
  `payments.ts`).
- `'Invalid UUID format'` aparece **4 veces en todo `src/` + `test/`**: la única
  de producción es `tasks.ts:130`, más un comentario en `tasks.ts:306` y las dos
  aserciones de `tasks.no-charge-before-validating.test.ts:519`/`:536`.

Con eso, **dos de los tres archivos que DT-2 daba por sin precedente sí lo
tienen**: `key-session.ts:59` y `:177`, y `delegation.ts:74`/`:78`/`:81`/`:87`, ya
responden `400 { error_code: 'INVALID_INPUT' }` a un **body** mal formado. El único
sin precedente propio es `receipts.ts`, cuyos 4xx son el `403` de auth
(`:57`, `:75`, `:101`) y el `404 RECEIPT_NOT_FOUND` (`:83`, `:111`).

**Decisión:**

| Archivo | Respuesta al `:id` malformado | Por qué |
|---|---|---|
| `src/routes/tasks.ts` | **`400 { error: 'Invalid UUID format' }` — SIN CAMBIO** | Es contrato con dos testigos (`:519`, `:536`). Uniformarlo sería un cambio de contrato gratis. |
| `src/routes/auth/key-session.ts` | `400 { error_code: 'INVALID_INPUT' }` | **El código que el archivo YA emite** para forma inválida (`:59`, `:177`). Cero códigos nuevos. |
| `src/routes/auth/delegation.ts` | `400 { error_code: 'INVALID_INPUT' }` | Idem (`:74`, `:78`, `:81`, `:87`). Cero códigos nuevos. |
| `src/routes/payments.ts` | `422 { error_code: 'INVALID_INPUT' }` | AC-4. Es el status+código que el archivo usa para toda otra forma inválida (`:204`, `:259`, `:430`, `:488`). |
| `src/routes/receipts.ts` | `400 { error_code: 'INVALID_INPUT' }` | El único que elige de cero. Razones abajo. |

`receipts.ts` — por qué `400 { error_code: 'INVALID_INPUT' }` y no el shape de
`tasks.ts`:

1. **Prevalencia medida**: 37 ocurrencias en 10 archivos contra 4 en uno
   (`2745bb2`). `'Invalid UUID format'` es una forma de un módulo, no una convención.
2. **Consistencia intra-archivo**: los rechazos no-auth de `receipts.ts` ya usan
   `error_code` (`RECEIPT_NOT_FOUND`, `:83`/`:111`). Un `{ error: '…' }` no-auth
   sería el primero del archivo. (El `403` sí usa `{ error }`; el criterio es
   "no-auth".)
3. **Utilidad para el integrador**: un cliente obtiene **un** código,
   `INVALID_INPUT`, para "tu input está mal formado" en `/receipts`, `/auth/*` y
   `/payments/*`. `tasks.ts` sigue distinto porque cambiarlo cuesta contrato.

**Lo que esta decisión NO hace, dicho en voz alta**: el resultado **no es
uniforme**. Quedan tres formas — `400 { error }` en tasks, `400 { error_code }` en
tres archivos, `422 { error_code }` en payments. Esa falta de uniformidad es
deliberada y es el precio de no cambiar ni un contrato existente. Uniformar sería
más lindo de leer en un documento y sería un cambio de contrato en superficies que
hoy responden distinto, sin ninguna AC que lo pida.

### DT-6 — Orden del guard: DESPUÉS de todo gate existente, ANTES del primer uso del `:id` (corrige DT-3 del work-item)

DT-3 del work-item pedía el guard "antes de cualquier lookup/auth", copiando el
lugar relativo de `tasks.ts:127-133`. Ese lugar es correcto **en `tasks.ts`**,
porque ahí el guard tiene que estar antes del cobro (`:166`, cadena pre-cobro):
su razón es el dinero, no la forma. Ninguna de las cinco superficies de esta HU
cobra en el handler, así que la razón no se transfiere.

**Regla de esta HU**: el guard se inserta **después del último gate que ya existe**
(flag de feature → prefijo de autenticador prohibido → auth) y **antes de la
primera expresión que pasa el `:id`** a un service, RPC o query.

Dos consecuencias verificables de hacerlo al revés:

- Antes del gate de sub-sesión: `auth.key-session.test.ts:161` (T-SUBSESSION)
  inyecta `DELETE /auth/key-session/sess-1` con un token de sesión y espera
  `403 SESSION_NOT_ALLOWED` + `expect(mockLookupByHash).not.toHaveBeenCalled()`
  (`:172`). Con el guard primero, ese test devuelve `400` y **se pone rojo**. Y el
  cambio de fondo es peor que el test: daría feedback de forma a un autenticador
  explícitamente prohibido.
- Antes del gate de flag en `POST /payments/session/:id/dispute`: hoy con
  `ARBITER_ENABLED` apagado la ruta responde `404 { error_code: 'NOT_FOUND' }` y
  el comentario `src/routes/payments.ts:322-324` dice que el gate es lo PRIMERO a
  propósito, byte-idéntico a "no existe" (AC-7 de WKH-139). Con el guard antes, un
  `:id` malformado con el flag apagado devolvería `422` y **anunciaría que la ruta
  existe**. Eso es una regresión de disclosure, no un detalle de orden.

Puntos de inserción exactos (línea del árbol `2745bb2`; **re-verificar en F3**,
CD-9, porque son archivos que la propia HU edita):

| Archivo | Va después de | Va antes de |
|---|---|---|
| `receipts.ts` `GET /:id` | el `403` de auth (`:74-76`) | `receiptService.getById` (`:78`) |
| `receipts.ts` `GET /:id/verify` | el `403` de auth (`:100-102`) | `receiptService.getById` (`:106`) |
| `key-session.ts` `DELETE /:id` | el `403` de auth (`:126-128`) | el `try` de `revoke` (`:130-131`) |
| `key-session.ts` `PATCH /:id/require-signature` | la validación de body (`:175-178`) | el `try` de `setRequireSignature` (`:181-183`) |
| `delegation.ts` `DELETE /:id` | el `403` de auth (`:135-137`) | el `try` de `revoke` (`:139-140`) |
| `payments.ts` `POST /session/:id/voucher` | el `403` de auth (`:253-255`) | la validación de body (`:258`) |
| `payments.ts` `POST /session/:id/close` | el `403` de auth (`:290-292`) | `extractDebitCapture` (`:295`) |
| `payments.ts` `POST /session/:id/dispute` | el `403` de auth (`:335-337`), que a su vez va después del gate `isArbiterEnabled()` (`:331-333`) | el `try` de `openDispute` (`:338-340`) |
| `payments.ts` `POST /upto/:id/settle` | el `403` de auth (`:482-484`) | la validación de body (`:487`) |

Nota sobre los tres de `payments.ts` donde el guard queda **antes** de la
validación de body: el orden entre los dos es **inobservable**, porque ambos
responden el mismo `422 { error_code: 'INVALID_INPUT' }`. No hay decisión de
contrato escondida ahí. En `key-session.ts` `PATCH` sí lo puse **después** del body,
porque ese archivo responde `400 INVALID_INPUT` al body y `400 FUNDING_WALLET_NOT_BOUND`
más abajo: mantener el body primero preserva el orden actual sin pensar en cuál gana.

### DT-7 — Se comparte el predicado, NUNCA el respondedor

CD-2 obliga a un solo regex. **No** obliga a un solo `reply.status(...).send(...)`,
y compartirlo sería el mecanismo exacto por el que los cuatro contratos de DT-5
derivan hacia uno solo: un helper `rejectInvalidUUID(reply, id)` necesitaría
parámetros de status y de body, y el próximo que lo lea va a "simplificar" los
parámetros. Cada route escribe sus 3 líneas con su propio status y su propio body.
Tres líneas repetidas cinco veces es más barato que un contrato uniformado por
accidente.

Forma canónica (esto es especificación, no el código final):

```ts
// WKH-345: forma del `:id` ANTES de la capa de datos. Sin esto, el valor llega
// a una columna `uuid` y Postgres responde 22P02 → 500.
if (!isValidUUID(req.params.id)) {
  return reply.status(400).send({ error_code: 'INVALID_INPUT' });
}
```

### DT-8 — `UUID_RE` no lleva flag `g` ni `y`, y eso es un invariante con test

Con flags `i` solamente, el regex **no** tiene estado: `RegExp.prototype.test`
sobre un patrón no-global no mueve `lastIndex`, así que una única instancia
compartida por cinco routes es segura entre requests concurrentes.

Agregar `g` (mutante de un carácter) convierte `UUID_RE` en **stateful**:
`.test()` empezaría a avanzar `lastIndex` y una misma instancia compartida
devolvería resultados que dependen del orden de las llamadas — un rechazo
intermitente de ids válidos bajo concurrencia, que es el peor modo de falla
posible para un guard. **CD-6** lo prohíbe y **T-U3** (§7) lo fija con
`expect(UUID_RE.flags).toBe('i')`.

### DT-9 — Descartado: `schema: { params: { format: 'uuid' } }` de Fastify

Sería la opción idiomática si el repo tuviera la infraestructura. No la tiene, y
el modo de falla es silencioso:

1. **`ajv-formats` no está en `package.json`** (`2745bb2`). Sin ese plugin, Ajv
   **ignora** `format` en vez de fallar: el guard se leería presente en el código y
   no validaría nada. Es el patrón "un default que degrada en silencio", aplicado a
   un guard de seguridad de borde.
2. El repo usa `schema:` de Fastify en muy pocos lugares: **4 ocurrencias** en
   `src/routes/`, y `agent-card.ts:60` no es siquiera un schema de ruta (es un
   campo del payload) — quedan 3, todas en `orchestrate.ts` (`2745bb2`). No es la
   convención del repo.
3. El error de un schema de Fastify sale por el error boundary con **otro shape**
   (`{ statusCode, error, message }`), lo que contradice DT-5 y CD-1.

### DT-10 — `GET /payments/session/:id/dispute` queda AFUERA, y por qué

Es el 5º sitio con `:id` de `payments.ts` (`:383`). El work-item lo marcó "ya
seguro" y sugirió agregarle el guard "por consistencia, a criterio del Architect".
**Decisión: no se le agrega.**

Verificado (`2745bb2`): la cadena es
`.from('a2a_arbitrations').select(...).eq('intent_id', req.params.id).eq('owner_ref', callerKey.owner_ref).maybeSingle()`
(`:378-385`), y el route trata cualquier `error` como no-encontrado:
`if (error || !data) return reply.status(404)` (`:387-388`). Un `:id` malformado
sale por **404**, no por 500.

Tres razones para dejarlo:

1. **No hay bug**: ninguna AC lo cubre y no produce 500.
2. Agregarle el guard cambiaría `404 → 422` para un id malformado: un cambio de
   contrato en un endpoint que hoy funciona, sin AC que lo pida.
3. El `404` está ahí a propósito para **colapsar** "no existe" con "no es tuyo"
   (`:386`, "no revela existencia ajena"). Partirlo en dos códigos es discutible y
   no es la discusión de esta HU.

**Residuo declarado** (§9 R-2): ese `if (error || !data)` **silencia todo error de
Postgres como 404**, incluido uno que no sea de forma. Eso no lo arregla ni lo
empeora esta HU.

### DT-11 — Sin cambios en `owner_ref`, dicho como propiedad y no como intención

Esta HU **no agrega, mueve, borra ni reordena ninguna llamada a `supabase`**.
Los cinco archivos que edita son routes: llaman services. Las cadenas relevantes
—`src/services/receipt.ts:292-294`, `src/services/key-session.ts:369-370` y
`:404-405`, `src/services/spend-policy.ts:188-191`— quedan **sin tocar**. Ver §8
para la declaración completa y para qué **no** verifica el guardián mecánico.

### DT-12 — Protocolo de dos pasos para AC-5 (obligatorio, CD-8)

Consecuencia directa de §3.5. F3 hace dos corridas de suite y registra las dos,
con el commit al lado:

- **Paso A — sólo fixtures, sin guard.** Cambiar los 20 valores de `:id` de §3.5
  por ids con forma de UUID (y las aserciones que nombran el mismo string). **No**
  agregar el guard. `npm test` → **tiene que quedar verde**. Ese verde es la
  evidencia de AC-5: las cuatro superficies se comportan igual con un id que la
  base aceptaría, **con el código de antes**.
- **Paso B — agregar el guard.** `npm test` → verde otra vez, más los tests
  nuevos. La diferencia entre A y B es exactamente el camino malformado.

Si el Paso A saliera rojo, hay un supuesto equivocado en algún mock y **AC-5 no
está probado** — hay que resolverlo antes de seguir, no adaptar el fixture hasta
que pase. Sin este orden, el verde final no distingue "no cambié el camino válido"
de "moví el fixture hasta que dio verde".

---

## 5. Constraint Directives

**Heredados del work-item:**

- **CD-1** (heredado): PROHIBIDO cambiar el comportamiento para un `:id` con
  **forma** válida — exista o no, sea del `owner_ref` que llama o de otro. Mismo
  status, mismo body, mismo `error_code`. Evidencia: el Paso A de DT-12.
- **CD-2** (heredado, endurecido): PROHIBIDO duplicar el patrón de UUID. Un solo
  `UUID_RE`, en `src/lib/uuid.ts`. Y PROHIBIDO **modificar el patrón** al
  extraerlo — en particular endurecerlo a v4 (DT-4): ese mutante deja la suite
  verde y estrecha el contrato sin testigo.
- **CD-3'** (heredado, ya cerrado en §3.3): el censo de `req.params` se **re-corre
  al cierre de F3** con `command grep -rl "\.params" src/routes/` y el resultado se
  compara contra los 16 archivos de `2745bb2`. Si aparece un archivo nuevo (otra HU
  en vuelo lo agregó), se evalúa con el criterio de §3.3 y **se declara el
  veredicto**, aunque sea "no es bug".
- **CD-4** (heredado): PROHIBIDO tocar `src/routes/registries.ts`. Sus 3 `:id`
  (`:134`, `:307`, `:399`) son slugs TEXT.
- **CD-5** (heredado, money-path): PROHIBIDO que el guard introduzca o modifique
  cualquier cobro, débito, settle o refund. Sólo adelanta el rechazo de forma a
  antes del primer `await` que toca `supabase`/`adapter`. Falsador: cualquier
  diferencia en un test de `payments.test.ts` que **no** sea un `:id` malformado.

**Nuevos de este SDD:**

- **CD-6**: PROHIBIDO que `UUID_RE` lleve flag `g` o `y`. Con `g`, `.test()` muta
  `lastIndex` y la instancia compartida rechaza ids válidos según el orden de las
  llamadas (DT-8). Candado: T-U3.
- **CD-7**: PROHIBIDO tocar `src/routes/auth/identity.ts`, `src/routes/inbound.ts`,
  `src/routes/auth/require-signature.ts` y `src/routes/auth/spend-policy.ts`.
  Los cuatro se revisaron y **no son bug** (§3.3). En particular: PROHIBIDO
  relajar, mover o reescribir cualquier filtro por dueño de esos archivos. Si F3
  cree que uno **sí** es bug, para y lo escala; no lo arregla de paso.
- **CD-8**: OBLIGATORIO el protocolo de dos pasos de DT-12. Los dos resultados de
  `npm test` se registran, con su commit en la misma línea. Un solo verde final no
  es evidencia de AC-5.
- **CD-9**: OBLIGATORIO re-verificar con `command grep -n`, **después de la última
  edición**, toda cita `archivo:línea` a un archivo que esta HU modifica
  (`tasks.ts`, `receipts.ts`, `auth/key-session.ts`, `auth/delegation.ts`,
  `payments.ts` y los 5 archivos de test de §3.5). Es error reincidente del repo:
  `doc/sdd/220-…/auto-blindaje.md:25-34` y `doc/sdd/221-…/auto-blindaje.md:38-60`,
  donde el fix se equivocó una segunda vez dentro de su propia corrección. El
  agravante de esta HU: `tasks.ts` **pierde** 6 líneas al borrar `:90-95`, así que
  **todas** las citas a `tasks.ts` por debajo de `:95` se corren −6.
- **CD-10**: PROHIBIDO escribir un `archivo:línea` en el `auto-blindaje.md`, el
  `story-file.md` o un comentario de código sin haber leído esa línea. Si no la
  leíste, no la cites.
- **CD-11**: PROHIBIDO copiar un número de este SDD, del work-item o de otra HU
  como si lo hubieras medido. Los números de acá se midieron en `2745bb2`; si F3
  los repite en su reporte, los re-mide y pone **su** commit. En particular:
  **este SDD no midió la línea base de la suite** (§10 MI-1) — no hay número que
  copiar.
- **CD-12**: PROHIBIDO describir el regex como "valida UUID v4". No valida versión
  ni variant (DT-4). En docblocks y en prosa: "forma de UUID (8-4-4-4-12 hex,
  case-insensitive)".
- **CD-13**: PROHIBIDO agregar un respondedor compartido de error (DT-7). El módulo
  compartido exporta `isValidUUID` y `UUID_RE`, nada que toque `reply`.
- **CD-14**: PROHIBIDO agregar `ajv-formats` o un `schema.params` para resolver
  esto (DT-9).

---

## 6. Waves

### W0 — serial, bloquea todo lo demás

| Archivo | Acción |
|---|---|
| `src/lib/uuid.ts` | **NUEVO**. Exporta `UUID_RE` (idéntico a `tasks.ts:91-92`) e `isValidUUID`. Docblock: qué valida (forma 8-4-4-4-12), **qué NO valida** (versión, variant), de dónde salió, por qué no lleva flag `g` (CD-6) y por qué no exporta un respondedor (CD-13). |
| `src/lib/uuid.test.ts` | **NUEVO**. T-U1..T-U4 (§7). |

### W1 — serial, inmediatamente después de W0: el Paso A de DT-12

| Archivo | Acción |
|---|---|
| `src/routes/receipts.test.ts` | Fixtures `:152`, `:173`, `:189`, `:203` → ids con forma de UUID. |
| `src/routes/auth.key-session.test.ts` | Fixtures `:122`, `:137`, `:152`, `:164` + aserciones `:128`, `:158`. |
| `src/routes/auth.signed-auth.test.ts` | Fixtures `:236`, `:252`, `:267`, `:281` + aserción `:243`. **NO** tocar `:296` ni `:352` (ahí `'sess-1'` es un campo de body, §3.5). |
| `src/routes/auth.delegation.test.ts` | Fixtures `:310`, `:325` + aserción `:316`. |
| `src/routes/payments.test.ts` | Fixtures `:153`, `:169`, `:203`, `:281`, `:304`, `:342` + las aserciones que nombren `'i1'`. |

**Cierre de W1**: `npm test` completo, **verde**, con el conteo y el commit
registrados. Ninguna línea de `src/routes/*.ts` (producción) cambió todavía.
Este verde es la evidencia de AC-5 (CD-8).

⚠️ W1 no se puede paralelizar con W2: es una **medición**, y sólo mide si el árbol
de producción está intacto.

### W2 — paralelizable: 5 archivos independientes

| Sub-wave | Archivo de producción | Test |
|---|---|---|
| W2a | `src/routes/tasks.ts` — borrar `:90-95`, agregar `import { isValidUUID } from '../lib/uuid.js'`. Sin tocar `validateTaskId` ni los 4 call-sites. | `tasks.no-charge-before-validating.test.ts` sin cambios (es el pin de AC-6/byte-identidad) |
| W2b | `src/routes/receipts.ts` — guard ×2 (DT-6), `400 { error_code: 'INVALID_INPUT' }` | `src/routes/receipts.test.ts` (+ T-1a, T-1b) |
| W2c | `src/routes/auth/key-session.ts` — guard ×2, `400 { error_code: 'INVALID_INPUT' }` | `auth.key-session.test.ts` (+ T-2a), `auth.signed-auth.test.ts` (+ T-2b) |
| W2d | `src/routes/auth/delegation.ts` — guard ×1, `400 { error_code: 'INVALID_INPUT' }` | `auth.delegation.test.ts` (+ T-3) |
| W2e | `src/routes/payments.ts` — guard ×4, `422 { error_code: 'INVALID_INPUT' }` | `src/routes/payments.test.ts` (+ T-4a..T-4d, T-4e) |

### W3 — serial, cierre

1. `npm test` completo → verde. Es el **Paso B** de DT-12. Registrar conteo +
   commit.
2. `npx tsc --noEmit` (usa `tsconfig.json`, que **sí** incluye los `*.test.ts` de
   `src/` — §3.7).
3. `npm run lint` (`biome check src/`).
4. **CD-3'**: re-correr `command grep -rl "\.params" src/routes/` y comparar contra
   los 16 de `2745bb2`.
5. **CD-9**: re-verificar con `command grep -n` toda cita `archivo:línea` a los 10
   archivos que la HU modifica. Recordar el −6 de `tasks.ts`.
6. `auto-blindaje.md` con los errores propios de F3.

---

## 7. Plan de tests — al menos uno por AC

Cada fila dice **qué mutante de una línea la pone roja**. Un test que no puede
nombrar el suyo no está midiendo nada.

### Unitarios — `src/lib/uuid.test.ts` (W0)

| ID | Afirma | Mutante que lo mata | AC |
|---|---|---|---|
| **T-U1** | `isValidUUID('not-a-uuid')`, `isValidUUID('')`, `isValidUUID('sess-1')`, `isValidUUID('i1')` → `false`; y un UUID con forma válida → `true` | `return UUID_RE.test(id)` → `return true` | AC-6 |
| **T-U2** | `isValidUUID('00000000-0000-0000-0000-000000000000')` → `true` (el nil UUID pasa: el predicado es de FORMA, no de versión) | endurecer el patrón a v4 (`4[0-9a-f]{3}-[89ab][0-9a-f]{3}`) — el mutante que la suite de rutas **no** ve, §DT-4 | AC-6, CD-2, CD-12 |
| **T-U3** | `UUID_RE.flags === 'i'` | agregar `g` a los flags → instancia compartida con estado (DT-8) | CD-6 |
| **T-U4** | `isValidUUID('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')` → `true` (case-insensitive) | borrar el flag `i` | AC-1..AC-4, CD-2 |

### De ruta — un test por endpoint, más el control de orden

Todos siguen el patrón verificado de `src/routes/receipts.test.ts:26-49`: Fastify
in-process + `vi.mock` del service. Los dos asertos son **status** y
**`expect(mockX).not.toHaveBeenCalled()`** — el segundo es lo que hace que el
mutante "mover el guard adentro del `try`" muera.

| ID | Endpoint | Espera | Mutante que lo mata | AC |
|---|---|---|---|---|
| **T-1a** | `GET /receipts/not-a-uuid` | `400 { error_code: 'INVALID_INPUT' }` **y** `mockGetById` no llamado | borrar el guard; o moverlo después de `getById` | AC-1 |
| **T-1b** | `GET /receipts/not-a-uuid/verify` | idem, **y** `mockVerify` no llamado | idem | AC-1 |
| **T-2a** | `DELETE /auth/key-session/not-a-uuid` | `400 { error_code: 'INVALID_INPUT' }` **y** `mockRevoke` no llamado | idem | AC-2 |
| **T-2b** | `PATCH /auth/key-session/not-a-uuid/require-signature` (body válido) | `400 { error_code: 'INVALID_INPUT' }` **y** `mockSetRequireSignature` no llamado | idem | AC-2 |
| **T-3** | `DELETE /auth/delegation/not-a-uuid` | `400 { error_code: 'INVALID_INPUT' }` **y** `revoke` no llamado | idem | AC-3 |
| **T-4a** | `POST /payments/session/not-a-uuid/voucher` (body válido) | `422 { error_code: 'INVALID_INPUT' }` **y** `addVoucher` no llamado | idem | AC-4 |
| **T-4b** | `POST /payments/session/not-a-uuid/close` | `422` **y** `closeSession` no llamado | idem | AC-4, CD-5 |
| **T-4c** | `POST /payments/session/not-a-uuid/dispute` (`ARBITER_ENABLED` **on**) | `422` **y** `openDispute` no llamado | idem | AC-4 |
| **T-4d** | `POST /payments/upto/not-a-uuid/settle` (body válido) | `422` **y** `settleUpto` no llamado | idem | AC-4, CD-5 |
| **T-4e** | `POST /payments/session/not-a-uuid/dispute` con `ARBITER_ENABLED` **off** | **`404 { error_code: 'NOT_FOUND' }`**, no `422` | mover el guard antes de `isArbiterEnabled()` (`:331`) | DT-6, CD-1 |
| **T-5** | `DELETE /auth/key-session/<uuid-válido>` con un token de sesión como autenticador | `403 SESSION_NOT_ALLOWED` **y** `mockLookupByHash` no llamado | mover el guard antes del gate de prefijo | DT-6 |

**AC-5 no se prueba con un test nuevo: se prueba con el Paso A de DT-12** (W1
verde con el árbol de producción intacto). Un test nuevo que afirme "el id válido
se comporta igual" sería un guard que se compara consigo mismo — escrito después
del cambio, sólo puede confirmar lo que el cambio hizo.

**AC-6** lo cubren T-U1..T-U4 más una verificación mecánica en W3:
`command grep -rn "0-9a-f]{8}-" src/` tiene que devolver **una sola** ocurrencia de
producción, en `src/lib/uuid.ts` (`src/__tests__/e2e/e2e.test.ts:30` tiene su
**propio** regex, distinto y más estricto — ver §9 R-3).

### El control positivo obligatorio (CD-8, patrón de `doc/sdd/219-wkh-342-…/auto-blindaje.md`)

Los 11 tests de arriba afirman **ausencias** (`not.toHaveBeenCalled`). Una ausencia
sobre un mock que **nunca se llama en ese fixture** aplaude cualquier
implementación. Por eso cada archivo de test debe conservar (o tener) su caso
positivo con un id **con forma de UUID** que sí llegue al mock — los tests
refixtureados de W1 son exactamente eso, y son el control. Si al borrar el guard
sólo se pone rojo el test negativo y el positivo sigue verde, el par funciona; si
**ninguno** se mueve, el fixture está vacío y el candado no mide nada.

---

## 8. Ownership Guard — declaración

Regla del repo: toda query sobre una tabla que declare `owner_ref` en
`src/types/database.types.ts` filtra por `owner_ref` además del `id`, porque el
cliente usa `SUPABASE_SERVICE_KEY` y bypassea RLS.

**Esta HU no modifica ninguna cadena de Supabase.** Los cinco archivos editados
son routes; todas las cadenas viven en `src/services/`, que esta HU no toca. Las
que quedan aguas abajo de los guards, verificadas en `2745bb2` y **sin cambio**:

| Cadena | Filtro por dueño |
|---|---|
| `src/services/receipt.ts:292-294` (`a2a_receipts`) | `.eq('id', id).eq('owner_ref', ownerRef).single()` |
| `src/services/key-session.ts:369-370` (`a2a_key_sessions`, UPDATE revoke) | `.eq('id', sessionId).eq('owner_ref', ownerId)` |
| `src/services/key-session.ts:404-405` (`a2a_key_sessions`, UPDATE require_signature) | `.eq('id', sessionId).eq('owner_ref', ownerRef)` |
| `src/routes/payments.ts:383-384` (`a2a_arbitrations`, el único `.from()` en un route del Scope IN) | `.eq('intent_id', …).eq('owner_ref', …)` — **no se toca** (DT-10) |
| `payments.ts` (los 4 del Scope IN) | van por `supabase.rpc(...)`, que recibe `p_owner_ref` explícito (`src/services/payment-intent.ts:1004-1005`, `:1032`) |

**Qué NO puedo apoyar en el verde de `test/ownership-filter-guard.test.ts`**, leído
su docblock: verifica **presencia textual** del filtro, no su **valor** (punto 1 de
su lista), y **los `supabase.rpc(...)` quedan enteros afuera** — que es la forma que
usa `payments.ts`. Su verde en esta HU dice "no agregué una cadena sin filtro". No
dice nada sobre valores, y no mira el camino de `payments.ts`. La evidencia real de
que no rompí propiedad es que el diff de `src/services/` es **vacío**, y eso lo
verifica `git diff --stat` en W3, no el guardián.

---

## 9. Riesgos y residuos declarados

| ID | Qué | Severidad | Mitigación / estado |
|---|---|---|---|
| **M-1** | El guard entero se anula con **una línea**: `src/lib/uuid.ts` → `return true`. Anula las 5 superficies a la vez. | Media | T-U1 lo mata en el nivel unitario, y los 10 tests de ruta también. Es la razón de tener las dos capas: si sólo hubiera tests de integración, el mutante podría sobrevivir donde un fixture no lo mire. |
| **M-2** | Endurecer el regex a v4 estrecha el contrato y **deja la suite verde** (DT-4). | Media | T-U2 + CD-2 + CD-12. |
| **M-3** | Los 20 fixtures de §3.5 tienen aserciones que repiten el mismo string (`toHaveBeenCalledWith('sess-1', …)`). Cambiar la URL y olvidar la aserción da un rojo confuso. | Baja | El Paso A de DT-12 los saca a la luz **antes** de tocar producción, cuando el único cambio posible es el fixture. |
| **M-4** | El borrado de `tasks.ts:90-95` corre −6 todas las citas por debajo. | Baja | CD-9, con el −6 escrito explícito. |
| **R-1** (residuo) | `src/routes/dashboard.ts` `:intentId`, 4 sitios, mismo bug estructural. Tras `requireAdminTokenStrict` (verificado, §3.4). | — | Fuera de alcance por decisión del work-item. Fast-follow, no founder-gated. Con `src/lib/uuid.ts` ya en su lugar, el fix pasa a ser 4 guards y ningún módulo nuevo. |
| **R-2** (residuo) | `src/routes/payments.ts:387` colapsa **todo** error de Postgres en `404` (`if (error \|\| !data)`), no sólo el de forma. Un error de conexión también se lee "no existe". | — | Preexistente. Esta HU no lo toca ni lo empeora. Candidato a HU propia. |
| **R-3** (residuo) | `src/__tests__/e2e/e2e.test.ts:30` tiene **su propio** regex de UUID, y es **distinto**: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` — ése **sí** valida v4. Lo usa para afirmar sobre un `request-id` generado por el servicio (`:93`), no para validar un param. | — | No es una duplicación del guard de borde: valida otra cosa con otra regla. **No se unifica** en esta HU: unificarlo hacia el regex laxo debilitaría un aserto sobre un id que el servicio genera él mismo y que sí debería ser v4. Declarado para que CD-2 no se lea como violado. |
| **R-4** (residuo) | La no-uniformidad de DT-5 (tres shapes: `400 {error}`, `400 {error_code}`, `422 {error_code}`) sobrevive a esta HU a propósito. | — | Decisión, no deuda. Uniformar es un cambio de contrato y necesita su propia HU y su propia aprobación. |

---

## 10. Missing Inputs — lo que este SDD NO midió

- **MI-1 [no bloqueante, y explícitamente sin número]**: **no corrí `npm test`**.
  No hay línea base de la suite en este documento, a propósito: copiar el
  `5330 passed | 19 skipped (5349)` de `doc/sdd/221-…/sdd.md:188` (repetido en
  `:788`, dentro de su anexo) como si fuera de hoy es el patrón que CD-11 prohíbe.
  Ese número es de `b7fa4e7`, no de hoy. F3 la mide como primer acto, antes de editar
  nada, y la registra con su commit.
- **MI-2 [no bloqueante, declarado]**: el mecanismo de CD-5 (§3.2, punto 2 — la
  coerción del argumento del RPC aborta antes del cuerpo, así que ninguna fila se
  mueve) lo derivé del código y de la semántica de Postgres, **no** lo reproduje
  contra una base. Lo que sí está verificado end-to-end en el código es el
  **status**: `22P02` → `mapPgError` sin match → `INTERNAL` →
  `500 PAYMENT_INTENT_FAILED`. Reproducirlo contra una base requeriría una
  Supabase de test y está fuera del alcance de F2. **`caldz` es PROHIBIDA (mainnet)
  y no se usa para esto en ningún caso.**
- **MI-3 [no bloqueante]**: el censo de §3.3 cubre `src/routes/`. **No** barrí
  `src/middleware/`, `src/mcp/` ni `mcp-servers/` buscando `req.params`. Los
  middlewares corren antes del binding de params de una ruta con `:id` y no fueron
  reportados por el encargo; si aparece algo ahí, es HU nueva, no una 5ª ruta de
  ésta.
- **MI-4 [resuelto]**: la fila de `_INDEX.md` (Missing Input #4 del work-item) ya
  la insertó el orquestador (fila 222). Cerrado.

---

## 11. Implementation Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todo path referenciado existe (verificado con `Glob`/`Read`/`grep` en `2745bb2`) | ✅ |
| 2 | El exemplar principal existe y lo leí completo: `src/routes/tasks.ts:90-95` y `:127-133` | ✅ |
| 3 | Cada AC (1..6) tiene al menos un test asignado en §7 | ✅ AC-1: T-1a/T-1b · AC-2: T-2a/T-2b · AC-3: T-3 · AC-4: T-4a..T-4d · AC-5: Paso A de DT-12 · AC-6: T-U1..T-U4 + grep de W3 |
| 4 | Cada test nombra el mutante de una línea que lo pone rojo | ✅ §7 |
| 5 | Los CD del work-item están heredados (CD-1..CD-5) | ✅ §5 |
| 6 | **Decisión delegada #1** — ubicación del helper | ✅ `src/lib/uuid.ts`, con las 4 alternativas descartadas y su razón (DT-3) |
| 7 | **Decisión delegada #2** — `error_code` de los tres 400 | ✅ DT-5, con la premisa del work-item corregida y la no-uniformidad declarada |
| 8 | **CD-3 cerrado** — los 4 archivos sin revisar, con veredicto individual | ✅ §3.3: ninguno es bug; no hay 5ª ruta |
| 9 | Cadenas de `owner_ref` declaradas, y declarado qué **no** verifica el guardián | ✅ §8 |
| 10 | El regex descrito por lo que hace, no como "v4" | ✅ DT-4 + CD-12 |
| 11 | Ninguna frase dice "elimina"/"cierra" sin nombrar su mutante de una línea | ✅ §1, M-1, §7 |
| 12 | Todo número medido lleva su commit en la misma línea | ✅ `2745bb2` |
| 13 | Lo no medido está declarado como no medido | ✅ §10 (MI-1 sin número a propósito) |
| 14 | Auto-Blindaje histórico leído y convertido en CD | ✅ §3.6 → CD-8, CD-9, CD-10, CD-11 |
| 15 | Waves con archivos exactos, y la dependencia serial justificada | ✅ §6 (W1 es una medición: no se paraleliza con W2) |
| 16 | Cero `[NEEDS CLARIFICATION]` | ✅ |
| 17 | Sin cambios de esquema, migración ni env nueva | ✅ |

**Veredicto: listo para `SPEC_APPROVED`.**

---

## Anexo — comandos de reproducción

```bash
# ── Línea base (PRIMER acto de F3, antes de editar nada). Registrar con su commit.
#    NO copiar ningún número de este SDD: acá no hay línea base medida (MI-1, CD-11).
npm test

# ── El censo de CD-3', para comparar contra los 16 archivos de 2745bb2
command grep -rl "\.params" src/routes/ | sort | wc -l

# ── AC-6: una sola ocurrencia de producción del patrón, en src/lib/uuid.ts.
#    src/__tests__/e2e/e2e.test.ts:30 es OTRO regex, más estricto (residuo R-3).
command grep -rn "0-9a-f]{8}-" src/

# ── Las prevalencias de error_code medidas en 2745bb2 (37 y 4)
command grep -rn "error_code: 'INVALID_INPUT'" src/routes/ --include=*.ts \
  | command grep -v "\.test\." | wc -l          # 37 en 2745bb2
command grep -rn "Invalid UUID format" src/ test/ | wc -l   # 4 en 2745bb2

# ── Los 20 fixtures no-UUID de §3.5
command grep -rn "url: '/auth/key-session/\|url: '/auth/delegation/\|url: '/receipts/\|url: '/payments/session/\|url: '/payments/upto/" src/routes/

# ── Que el diff de services quede VACÍO (la evidencia real de §8)
git diff --stat -- src/services/

# ── Puertas del cierre (W3)
npm test
npx tsc --noEmit      # usa tsconfig.json → SÍ tipa los src/**/*.test.ts
npm run lint          # biome check src/

# ── El mutante de M-1, para confirmar que los candados existen:
#    en src/lib/uuid.ts, `return UUID_RE.test(id)` → `return true`
#    Esperado: T-U1 rojo + los 10 tests de ruta rojos. Si algún grupo queda verde,
#    ese grupo no estaba midiendo el guard.
```

> ⛔ Ninguno de estos comandos toca `caldz` (mainnet, PROHIBIDA), abre `m5-keys/`,
> imprime un secreto, despliega ni firma nada on-chain.
