# SDD #220 — [WKH-SEC-03] Los filtros por dueño que nadie prueba, y el censo de los que no están

> F2 · NexusAgil QUALITY · 2026-08-05 · autor: `nexus-architect`
> Insumo: `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/work-item.md` (HU_APPROVED) ·
> `doc/audit/deuda-tecnica-2026-08-06/A1-guards-que-no-discriminan.md`, hallazgo 0.
> Árbol de referencia: worktree `wt-sec03`, rama `feat/220-wkh-sec-03-owner-ref-sin-cobertura`,
> base `ef384b7`. **Todo `archivo:línea` de este documento está anclado a ese commit.**

---

## 1. Resumen

Esta HU no arregla ningún filtro. Hace tres cosas, y las tres son mediciones:

1. **Corre la medición que nunca se corrió** (AC-6): el censo de consultas sobre tablas con
   `owner_ref` que **no** filtran por dueño. El barrido de A1 borra líneas que existen, así que
   por construcción no puede encontrar una línea ausente; que sus 23 hallazgos sean todos
   "el filtro está y ningún test lo prueba" es una propiedad del instrumento. **Ya corrí una
   versión preliminar de ese censo para escribir este SDD: da 55 cadenas** (§4.1). Ninguna de
   las que verifiqué es un IDOR vivo, pero la lista completa hay que clasificarla entrada por
   entrada, y eso es el entregable de W0.
2. **Deja un guardián estructural en `npm test`** (AC-1) que deriva las tablas con dueño de
   `src/types/database.types.ts` en vez de llevarlas a mano, y que **declara por escrito qué no
   mide** (§4.2, CD-5).
3. **Escribe los tests de propiedad** de los 11 sitios de este corte, con una clasificación
   corregida de cuáles se pueden poner en rojo con un fixture realista y cuáles no (§4.4).

### Lo que medí y contradice al work-item

Siete correcciones. Cada una tiene su medición al lado; ninguna cambia el objetivo de la HU,
pero cuatro cambian qué test hay que escribir.

| # | El work-item dice | Lo medido | Dónde |
|---|---|---|---|
| **C-1** | «18 tablas con dueño» (DT-3, §"El mecanismo") | **21** | §3.3 |
| **C-2** | baseline `1 failed \| 5288 passed \| 19 skipped` (AC-5, de A1) | **`0 failed \| 5294 passed \| 19 skipped (5313)`** en un worktree real | §3.4 |
| **C-3** | DT-4: «~87 corridas… el orden de magnitud lo descarta» (tiempo **no** verificado) | la suite tarda **~10 s** de pared. 87 corridas ≈ **22 min**; el barrido acotado a este corte ≈ **3 min** | §3.4, §4.6 |
| **C-4** | «12 sitios» en SEC-03 / «11 restantes» en SEC-04 | están **invertidos**: SEC-03 tiene **11**, SEC-04 tiene **12** | §4.4 |
| **C-5** | `spend-policy.ts:163,190,219` son clase **1a** (aislamiento alcanzable desde ruta autenticada) | **NO**. La ruta es `/keys/me/…`: `keyId` y `ownerRef` salen de la **misma fila** `callerKey`. El caller no puede pasar un `keyId` ajeno ⟹ el filtro de dueño es redundante con el de `key_id` y **no lo mata un fixture realista** | §4.4-C |
| **C-6** | `inbound-task.ts:316,338` son clase **1a** | `:316` (`get`) **no tiene ningún llamador de producción**; `:338` se llama sólo desde `ingest` con un `ownerRef` derivado server-side (`:425`) ⟹ es clase 1c | §4.4-D |
| **C-7** | (no lo menciona) | **ya existe** `src/routes/agents.ownership.test.ts`, titulado *"anti-IDOR integration tests"*, y su mock es **exactamente** el patrón roto de A1 §causa (a): registra los `.eq()` y **no los aplica** | §4.5 |

Y tres Missing Inputs del work-item quedan resueltos (§9).

---

## 2. Work Item

- **HU**: WKH-SEC-03 — probar los filtros por dueño de este corte y dejar el mecanismo que
  impide que la clase reaparezca.
- **Corte**: el mecanismo (guardián + censo + falso compartido) + los **11 sitios de superficie
  de API**. Los **12** de dinero y disputas son WKH-SEC-04.
- **Motivo del corte** (no es urgencia — no hay IDOR vivo): ~3000 líneas de test en una sola
  revisión es donde este repo ya falló. `doc/sdd/_INDEX.md:183` (fila 217, WKH-322) registra
  **4 pasadas de AR**, cada una descubriendo que un mecanismo nuevo declaraba cobertura que no
  tenía. Verificado leyendo la fila.

### Acceptance Criteria — mapeo a waves

| AC | Qué exige | Wave |
|----|-----------|------|
| AC-1 | el guardián estructural falla ante una cadena sin filtro y sin excepción | W1 |
| AC-2 | A no ve por id el recurso de B, en los sitios donde eso es alcanzable | W2 |
| AC-3 | escritura acotada cuando la fila cambia de dueño entre el read y el write | W3 |
| AC-4 | todo fixture con ≥2 `owner_ref` y falso que aplica **sólo** los filtros pedidos | W0 (el falso) + W2/W3 |
| AC-5 | evidencia de mutación **por línea**, con el test nombrado | W2/W3, consolidada en W4 |
| AC-6 | censo completo de filtros ausentes, cada entrada clasificada | **W0** |
| AC-7 | si un test exige tocar producción → parar y escalar | transversal (CD-1) |

**AC-6 es W0 y no un extra.** Es la única pregunta de esta HU cuya respuesta podría ser un IDOR
vivo, y además produce la lista de excepciones sin la cual el guardián de AC-1 no puede nacer
verde.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos, y qué saqué de cada uno

| Archivo | Por qué | Qué extraje |
|---|---|---|
| `src/services/task.ownership.test.ts` (359 líneas) | **el exemplar madre** | el falso PostgREST (`:91-225`), `applyFilters` que aplica *exactamente* los filtros pedidos (`:139-144`), el hook `onUpdateStart` del entrelazado (`:128-133`, `:285-317`), el control de dos direcciones (`:261-264`), la honestidad escrita sobre la carrera no alcanzable (`:277-283`), el backstop estructural en un solo test (`:333-358`), y el argumento propiedad-vs-espía (`:15-46`) |
| `test/test-files-are-run-in-ci.test.ts` (411 líneas) | **el exemplar del guardián estructural** | el escáner como **función pura del texto** para poder testearlo con fixtures (`discoverRunnersFrom(yaml, wf)`, `:220`); el control de armado anti-vacuidad (`:304-322`); la lista explícita de "QUÉ NO CUBRE" en el header (`:41-51`); la regla "si no puedo traducirlo me pongo rojo, no adivino" (`:38-39`); y el aviso de que un guardián que nace rojo se termina exceptuando (`:20-26`) |
| `src/routes/agents.ownership.test.ts` (294 líneas) | colisiona con esta HU | su mock **registra** los `.eq()` (`:47-50`) y **no los aplica** (`:52-54`): es el patrón roto de A1. Su `T-143B-06` (`:161`) sí tiene un espía de argumento sobre el UPDATE — por eso ese sitio no está entre los 23 |
| `src/types/database.types.ts` (3683 líneas) | derivar el conjunto de tablas (DT-3) | estructura estable y parseable: `Tables: {` a 4 espacios (`:16`), `<tabla>: {` a 6, `Row: {` a 8, columnas a 10. `Views:` a 4 cierra el bloque (`:2851`) |
| `.github/workflows/ci.yml` | dónde vive el control | typecheck `:37`, **`npm test` `:43`** — sin `if:` ni `continue-on-error:`, o sea que cuenta como runner obligatorio |
| `CLAUDE.md:198-205` | la tabla que hay que actualizar | lista **4** tablas; dos de sus cuatro filas son falsas hoy (§4.7) |
| `src/services/receipt.ts:286-296` · `inbound-task.ts:308-345` · `agent.ts:540-556`, `:695-725` · `spend-policy.ts:150-226` · `llm/transform.ts:215-282` · `routes/payments.ts:363-400` | los 11 sitios del corte | verificados uno por uno; ver §4.4 |
| `src/routes/receipts.ts:60-115` · `routes/auth/spend-policy.ts:76-135` · `routes/agents.ts:487` | de dónde sale el identificador | **decide si un fixture realista puede matar el mutante** |
| `src/routes/dashboard.ts:100-200`, `:388-440` | el gate de las lecturas cross-tenant | `requireAdminTokenForTrace` es fail-closed y su docblock dice *"una lectura cross-tenant NUEVA sí nace fail-closed"* (`:148-149`) |
| `src/services/reconciliation.ts:875-1140`, `:1440-1449` | Missing Input #1 | resuelto (§9) |
| `src/services/security/errors.ts:460-483` | la segunda palanca del work-item | **14** ops confirmadas; ninguna de `receipt`/`inbound-task`/`arbiter`/`fee-split`/`llm-transform`. Sí hay `spendPolicySet/List/Delete` |
| `doc/sdd/_INDEX.md:183` · `doc/sdd/217-…/auto-blindaje.md` · `218-…/auto-blindaje.md` · `219-…/auto-blindaje.md` | Auto-Blindaje histórico (§3.5) | tres patrones reincidentes que van a CD |

### 3.2 Exemplars verificados (existen, los leí)

| Path | Qué se copia | Verificado |
|---|---|---|
| `src/services/task.ownership.test.ts:91-225` | el falso PostgREST completo | SÍ |
| `src/services/task.ownership.test.ts:139-144` | `applyFilters` — «aplica EXACTAMENTE los filtros pedidos. Ni uno más» | SÍ |
| `src/services/task.ownership.test.ts:285-317` | **la receta del entrelazado** (`onUpdateStart`) para AC-3 | SÍ |
| `src/services/task.ownership.test.ts:261-264` | control de dos direcciones (A ve lo suyo **y** no ve lo de B) | SÍ |
| `src/services/task.ownership.test.ts:333-358` | backstop estructural en UN test, que nombra el sitio abierto | SÍ |
| `test/test-files-are-run-in-ci.test.ts:220-274` | escáner como función pura testeada con fixtures | SÍ |
| `test/test-files-are-run-in-ci.test.ts:304-322` | control de armado («si no, el de abajo es vacuo») | SÍ |
| `test/test-files-are-run-in-ci.test.ts:340-360` | «el matcher no es vacuo: reconoce lo cubierto y rechaza lo que no» | SÍ |
| `src/routes/agents.ownership.test.ts:11-77` | montar la ruta real + middleware falso + `app.inject` | SÍ (el patrón de montaje sirve; **su mock de supabase NO**) |

**Anti-patrón nombrado, para que nadie lo copie**: `src/services/fee-split.test.ts:67-73`
(`chain.eq = () => chain`, la respuesta la decide `selectQ.shift()`) y
`src/routes/agents.ownership.test.ts:47-54`. Los dos tiran columna y valor.

### 3.3 Estado derivado de `database.types.ts` — 21 tablas, no 18

Medido con una sonda que parsea el bloque `Row` de cada tabla y se queda con las que declaran
`owner_ref` (la misma regla que va a usar el guardián, DT-3):

```
TOTAL tablas en Database.public.Tables: 62
CON owner_ref (21): a2a_agent_keys · a2a_agent_links · a2a_agents · a2a_arbiter_nonces ·
  a2a_arbitrations · a2a_delegations · a2a_fee_splits · a2a_inbound_tasks · a2a_key_deposits ·
  a2a_key_dest_spend_ledger · a2a_key_sessions · a2a_key_spend_policies ·
  a2a_payment_intent_debit_signatures · a2a_payment_intents · a2a_payment_vouchers ·
  a2a_receipts · a2a_refund_applications · a2a_refund_outbox · kite_schema_transforms ·
  registries · tasks
```

Dos detalles que el diseño tiene que absorber:

- **`kite_schema_transforms` sí está en `Database`** y su columna es `owner_ref: string | null`
  (`src/types/database.types.ts:2303`). Resuelve el Missing Input #3 del work-item. Que sea
  **nullable** importa: una fila con `owner_ref = NULL` no matchea `.eq('owner_ref', X)` para
  ningún `X`, así que queda invisible para todos. Eso no es un IDOR, es un miss de caché
  permanente, y el test tiene que distinguir los dos casos.
- **`registries` tiene `owner_ref: string`** (`:2567`), o sea que `CLAUDE.md:205` («`registries`
  | — (admin global) | N/A») es **falso a nivel de esquema**. La intención de esa fila sigue
  siendo correcta (el catálogo es público, `src/services/registry.ts:165-170`), pero la tabla
  del `CLAUDE.md` afirma que la columna no existe.

### 3.4 Línea base y costo del instrumento — medidos, no citados

Corridos en `wt-sec03` sobre `ef384b7`, con `node_modules` linkeado del árbol principal:

| Corrida | Resultado | Duración |
|---|---|---|
| **baseline** `npx vitest run` | `Test Files 261 passed \| 6 skipped (267)` · **`Tests 5294 passed \| 19 skipped (5313)`** | **10,0 s** |
| borrar `src/services/receipt.ts:293` (`.eq('owner_ref', ownerRef)`) | `Tests 5294 passed \| 19 skipped (5313)` = **baseline exacto** ⟹ **SURVIVED** | 10,0 s |
| borrar `src/services/task.ts:102` (`.eq('owner_ref', ownerRef)`) | `Test Files 1 failed \| 260 passed` · `Tests 2 failed \| 5292 passed` ⟹ **KILLED** | 9,9 s |
| borrar `src/services/task.ts:21` (**un comentario** que menciona `.eq('owner_ref', …)`) | baseline exacto ⟹ SURVIVED, pero es un **falso SURVIVED** | 9,9 s |

Cuatro conclusiones que gobiernan el resto del documento:

1. **El hallazgo 0 de A1 se reproduce**: borrar `receipt.ts:293` deja la suite idéntica. El
   único guard de IDOR de recibos no lo verifica nadie, confirmado de forma independiente.
2. **El baseline del work-item está mal** (C-2). A1 midió `1 failed | 5288 passed` porque su
   laboratorio era una copia con `git init` fresco y el guardián `test-files-are-run-in-ci`
   fallaba contra ella (A1:11 lo dice). En un worktree real el baseline es **`0 failed |
   5294 passed | 19 skipped (5313)`**. Un mutante que se compare contra el baseline equivocado
   se clasifica al revés. → CD-8.
3. **El control negativo funciona**: el instrumento puede producir un rojo. Sin esa corrida,
   "SURVIVED" es indistinguible de "la suite no corrió".
4. **DT-4 se apoyaba en un número no medido** (C-3). La suite tarda ~10 s, no minutos. 87
   corridas ≈ 22 min de pared; el barrido acotado a las ~11 líneas de este corte ≈ **3 min**.
   La conclusión de DT-4 (no meter el barrido completo como control de cada PR) **sobrevive**,
   pero por costo/beneficio, no porque «el orden de magnitud lo descarte». Ver §4.6.

**La trampa de la fila 4 vale por sí sola**: elegí esa línea con `grep -n "eq('owner_ref'" |
head -1`, y `head -1` devolvió el **comentario** de `task.ts:21`, no un filtro. La mutación no
tocó ninguna consulta y el veredicto "SURVIVED" fue correcto y **completamente engañoso**. Es
literalmente el patrón que el Auto-Blindaje de WKH-318-B ya documentó («Un mutante mal
construido acusa a un test que está bien», `doc/sdd/218-…/auto-blindaje.md:27`). → CD-9.

### 3.5 Auto-Blindaje histórico — tres patrones reincidentes

Leí los `auto-blindaje.md` de las tres últimas HUs con status DONE (217/WKH-322, 218/WKH-318-B,
219/HU-323). Tres clases aparecen en ≥2 de ellas y por eso bajan a Constraint Directive:

| Patrón | Dónde reincide | CD |
|---|---|---|
| **Mutante mal construido → veredicto invertido.** «borrar es más fácil que reordenar, y el resultado (rojo) se parece»; «un mutante mal construido acusa a un test que está bien» | `217/auto-blindaje.md:35-47` · `218/auto-blindaje.md:27-39` · `217:155-165` (dos mutantes distintos con la misma firma de muerte) | **CD-9** |
| **Un test que mide una constante contra sí misma.** `T-U7` iteraba la allowlist exportada para afirmar que "todas están permitidas" | `217/auto-blindaje.md:20-31`; y la lección transversal `guards-que-se-comparan-consigo-mismos` | **CD-10** |
| **Un conteo que crece es una búsqueda que no cierra** (4→6→8→10 call-sites, por dos causas distintas) | `217/auto-blindaje.md:68-125`; acá el conteo ya creció **23 → 55** | **CD-11** |

Cuarto, de higiene y también reincidente (`217:51-60`, `218:8-21`): el lint verde caduca en la
edición siguiente ⟹ el orden es `editar → tsc → test → lint → commit`, por wave. → CD-12.

---

## 4. Diseño técnico

### 4.1 AC-6 — el censo de filtros AUSENTES (W0, el corazón de la HU)

**Por qué es una medición distinta.** El barrido de A1 recorre líneas `^\s*\.eq\(` existentes,
las borra de a una y compara contra el baseline (A1:163). Una consulta que **nunca tuvo**
`.eq('owner_ref', …)` no produce ninguna línea de salida: no está en los 87 `SURVIVED` porque no
había nada para borrar. El censo invierte la pregunta: parte del **conjunto de tablas con
dueño** y busca las cadenas que las tocan **sin** filtrar.

**Ya lo corrí en versión preliminar** (sonda de scratchpad, no va al repo) para poder diseñar
sobre datos y no sobre una corazonada. Resultado sobre `ef384b7`:

```
tablas con owner_ref: 21
cadenas supabase.from(<tabla con owner_ref>): 101  →  CON dueño 46 / SIN dueño 55
argumentos de .from() no resolubles: 0
```

**Cinco cosas que ese número enseña y que el guardián tiene que absorber:**

1. **Hay que resolver constantes de módulo.** `fee-split.ts` y `fee-charge.ts` no escriben
   `.from('a2a_fee_splits')`: escriben `.from(SPLITS_TABLE)`, con
   `const SPLITS_TABLE = 'a2a_fee_splits'` en `src/services/fee-split.ts:37` (y
   `FEES_TABLE` en `fee-charge.ts:109`). Un escáner que sólo acepte literales deja **fuera al
   archivo con más sitios de todo el hallazgo 0** y no se entera. → CD-13.
2. **Hay que filtrar por receptor, no por el nombre del método.** `.from(` también es
   `Buffer.from`, `Array.from`, `Uint8Array.from`, `Transaction.from`. Medido en `src/` no-test:
   **123 `supabase.from(`** contra **33** del resto. Sin el filtro de receptor, la lista de "no
   pude resolver el argumento" nace con 44 entradas de ruido y se vuelve inservible; con él,
   nace en **0**.
3. **El escáner tiene que seguir la cadena, no la línea.** Las cadenas cruzan líneas y terminan
   de formas distintas (`.single()`, `.maybeSingle()`, `await`, un `) as { … }` que cierra un
   paréntesis envolvente, como en `fee-split.ts:538`). El escáner consume `.metodo(args)`
   balanceando paréntesis y saltando comentarios y strings, y para cuando el siguiente token no
   es un `.`.
4. **`insert`/`upsert` no se pueden clasificar por presencia de filtro** — un INSERT no filtra,
   estampa. Y la regla alternativa ("que `owner_ref` aparezca en el payload") **no sirve**:
   medido, de los 14 insert/upsert sobre tablas con dueño, **9 darían falso positivo** porque el
   payload es una variable armada antes (p. ej. `src/services/task.ts:74` arma
   `const row: Partial<TaskRow> = { owner_ref: ownerRef }` y `:81` inserta `row`; y ese estampado
   **sí está probado**, por `task.ownership.test.ts:323-331`). Un guardián que nace con 9 rojos
   falsos se termina exceptuando entero, que es justo lo que
   `test/test-files-are-run-in-ci.test.ts:20-26` advierte por escrito. → **el guardián ignora
   `insert`/`upsert` y lo declara como limitación** (§4.3).
5. **Cadenas partidas en una variable son un punto ciego real, y hay 11.** El patrón
   `let q = supabase.from(...); if (cond) q = q.eq(...)` aparece en
   `src/services/discovery.ts:442,449,454,460,468,477,535`, `src/services/task.ts:131,134` y
   `src/routes/mock-registry.ts:74,83`. El escáner ve el `.from(...)` y **no** ve el `.eq()` que
   viene después en otra sentencia. Nota importante: `task.ts:131,134` significa que
   `taskService.list` **le parecería sin filtro al guardián aunque lo tenga** — o sea que el modo
   de falla apunta al lado ruidoso (falso positivo → excepción con motivo), no al silencioso.
   → §4.3 y CD-5.

**La taxonomía del censo.** Cada una de las 55 entradas se clasifica en **exactamente una**
categoría de una unión cerrada, más un motivo escrito a mano. Las categorías salen de leer los
sitios, no de inventarlas:

| Categoría | Qué significa | Ejemplo verificado |
|---|---|---|
| `idor-vivo` | el caller elige el identificador y no hay chequeo de dueño en ningún lado | **0 encontrados hasta ahora**; si aparece uno, **para la HU y escala** (CD-14) |
| `insert-estampa` | INSERT/UPSERT: no filtra, sella el dueño | `task.ts:81`, `identity.ts:75` (14 sitios) |
| `auth-por-hash` | la consulta **decide quién sos**; todavía no hay dueño contra el cual filtrar | `identity.ts:93` (`key_hash`), `delegation.ts:271`, `key-session.ts:266`, `agent-link.ts:243` |
| `alcance-por-fila-del-caller` | filtra por una columna cuyo valor **sale de la fila que el caller ya autenticó**, no del request. **Es un alcance por dueño aunque no diga `owner_ref`** | `key-session.ts:286`, `delegation.ts:293`, `agent-link.ts:265` — los tres con el motivo ya escrito en su docblock, uno de ellos literalmente *«NOTA PARA AR-CR: no es IDOR (key_id proviene del row de la delegación)»* (`delegation.ts:288`) |
| `catalogo-publico` | la tabla se sirve a cualquiera por diseño | `agent.ts:318,343,454,494,527` (`a2a_agents` con `enabled=true`); `registry.ts:174,211,464` (docblock *«List all registries (público)»*, `:165`) |
| `admin-cross-tenant` | lectura global detrás de un gate de admin | `trace.ts:403,523` y `event.ts:120,128`, tras `requireAdminTokenForTrace` / `requireAdminToken` (`routes/dashboard.ts:390`, `:424`). El docblock del gate dice por escrito *«una lectura cross-tenant NUEVA sí nace fail-closed»* (`dashboard.ts:148-149`) |
| `worker-sin-caller` | barrido de fondo; no hay caller cuyo dueño usar | `payment-intent.ts:1635,1653,1667,1682`, `reconciliation.ts:614,655,1349`, `refund-outbox.ts:223,259` |
| `ligadura-de-fila` | compare-and-set o idempotencia sobre un id derivado del servidor | `reconciliation.ts:1129` (§9), `receipt.ts:192` (`inserted.id`), `fee-split.ts:645` |
| `chequeo-en-js` | se lee sin filtro **a propósito**, y el dueño se compara después en JavaScript | `arbiter.ts:594` — su comentario `:591-592` («*Owner-check en app (no owner-guarded SELECT) para preservar `OWNERSHIP_MISMATCH` vs `INTENT_NOT_FOUND`*») y el chequeo real en `:606-608` |
| `punto-ciego-del-escaner` | falso positivo conocido (§4.1 punto 5) | `task.ts` vía `:131,134` |

**La categoría `chequeo-en-js` es la que hace que el censo no sea burocracia.** Si el guardián
exigiera `.eq('owner_ref', …)` sin excepciones, el "arreglo" de `arbiter.ts:594` sería una
regresión de comportamiento: se pierde la distinción 403/404 que el código eligió a propósito.

**Entregable de W0**: `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/censo-owner-ref.md`, una
fila por cadena, con `archivo:línea`, tabla, verbo, categoría, motivo, y —cuando el motivo ya
está escrito en el código— el `archivo:línea` del docblock que lo dice. **La clasificación
preliminar de este SDD es un punto de partida, no un resultado: el Dev verifica las 55.**

### 4.2 AC-1 — el guardián estructural

**Archivo**: `test/ownership-filter-guard.test.ts` (nuevo). En `test/`, no en `scripts/`, por
DT-5: `npm test` ya es paso obligatorio de CI (`.github/workflows/ci.yml:43`, sin `if:` ni
`continue-on-error:`) y ya hay dos precedentes de guardián estructural que parsea el árbol
(`test/test-files-are-run-in-ci.test.ts`, `src/routes/charged-routes.meta.test.ts`).

**Forma, copiada de `test-files-are-run-in-ci.test.ts:220`**: el escáner es una **función pura**
`scanSource(src: string, ownerTables: Set<string>): Chain[]`, para poder ejercitarla contra
fixtures en memoria. Si el escáner sólo se pudiera invocar sobre el árbol real, sus propios
tests se convertirían en «lo que el escáner encuentra hoy», que es exactamente la trampa CD-10.

**Regla**: para cada cadena `supabase.from(T)` con `T` ∈ tablas-con-dueño, cuyo verbo sea
`select`, `update` o `delete`, exigir un `.eq('owner_ref', …)` en la misma cadena **o** una
entrada en la lista de excepciones. Falla nombrando `archivo:línea`, tabla y verbo.

**La lista de excepciones**: `test/ownership-filter-guard.exceptions.ts`, con entradas
`{ file, line, table, category, reason }`. Tres reglas de diseño, cada una cerrando un modo de
falla medido:

- **La escribe una persona, una entrada por vez.** Está PROHIBIDO generarla volcando la salida
  del escáner (CD-10): una lista derivada del propio escaneo lo deja verde por construcción y no
  mide nada. Es el bug `T-U7` de WKH-322.
- **Una excepción cuyo sitio ya no existe pone el test en ROJO**, no se ignora en silencio. Sin
  eso la lista se pudre y el guardián va perdiendo alcance sin avisar.
- **El `reason` no puede estar vacío** y la `category` sale de la unión cerrada de §4.1.

**Controles anti-vacuidad obligatorios** (patrón `test-files-are-run-in-ci.test.ts:304-322`,
`:340-360`), cada uno con el input concreto que lo pone en rojo:

| Control | Input que lo pone en rojo |
|---|---|
| el conjunto de tablas derivado no está vacío y tiene ≥15 entradas | romper el parser de `database.types.ts` (devuelve ∅) ⟹ el guardián no encontraría ninguna cadena y pasaría afirmando cobertura total |
| el escáner encuentra ≥90 cadenas sobre tablas con dueño en el árbol | un regex roto que matchee de menos |
| `scanSource` sobre un fixture **con** el filtro → sin hallazgos | un escáner que reporte siempre |
| `scanSource` sobre un fixture **sin** el filtro → 1 hallazgo, con su línea | un escáner que no reporte nunca |
| `scanSource` sobre un fixture con `.from(CONST)` → resuelve la constante | volver a exigir literales (CD-13) |
| `scanSource` sobre `Buffer.from('a2a_receipts')` → **cero** hallazgos | quitar el filtro de receptor |
| `scanSource` sobre una cadena con `.eq('ownerRef', …)` (camelCase) → **1 hallazgo** | comparar el nombre de columna de forma laxa |
| el nombre de la columna que busca el guardián es `owner_ref` exacto | — |
| `.from(<expresión no resoluble>)` sobre receptor `supabase` → va a la lista de "no puedo traducir", que pone el test en rojo | adivinar en vez de fallar (`test-files-are-run-in-ci.test.ts:38-39`) |

### 4.3 Lo que el guardián NO mide — declarado, no arreglado (CD-5)

Esta sección va **también en el header del archivo**, copiando la forma de
`test/test-files-are-run-in-ci.test.ts:41-51`. Un control que no declara su agujero es el
hallazgo 17 de A1 (`verify-rls-enabled.mjs` imprime `[PASS] RLS enabled` sobre una política
`USING (true)`), y no vamos a agregar un segundo.

1. **El VALOR que se le pasa al filtro.** `.eq('owner_ref', otroOwner)` pasa el guardián. Sólo
   lo cazan los tests de propiedad de W2/W3.
2. **Las cadenas partidas en una variable** (11 sitios medidos, §4.1 punto 5). El modo de falla
   es un falso positivo (ruidoso), no un falso negativo.
3. **`insert` / `upsert`** (14 sitios). El estampado del dueño se prueba con el patrón
   `task.ownership.test.ts:323-331`, no acá.
4. **Que la fila TENGA dueño.** `kite_schema_transforms.owner_ref` es `string | null`
   (`database.types.ts:2303`): una fila con `NULL` es invisible para todos, y el guardián no
   opina sobre eso.
5. **Los filtros que no son `.eq`** (`.in`, `.match`, `.or`, `.filter`) sobre `owner_ref`. El
   guardián reconoce `.eq`, `.in` y `.match`; cualquier otra forma de acotar por dueño cae en la
   lista de excepciones. Es el mismo límite que A1 declara en su §"Lo que NO revisé", punto 5.
6. **Que la tabla exista de verdad en la base.** El conjunto sale del archivo de tipos generado;
   si el archivo está desactualizado respecto de la base, el guardián hereda ese desfase.
7. **RLS.** No la mide ni la reemplaza: es WKH-SEC-02 (`CLAUDE.md:207-215`). Y mientras el
   cliente use `SUPABASE_SERVICE_KEY` (BYPASSRLS), RLS **no** vuelve redundante ningún filtro.

Y el límite que hay que escribir en el reporte de cierre (el work-item ya lo pide): **entre el
merge de SEC-03 y el de SEC-04 el guardián va a estar verde con 12 sitios sin test de
propiedad.** El guardián dice "el filtro está", no "el filtro funciona".

### 4.4 Los 11 sitios del corte, reclasificados por «¿lo mata un fixture realista?»

El work-item los agrupa en 1a/1b/1c. Verifiqué de dónde sale el identificador en cada uno —que
es lo que decide el escenario— y el agrupamiento cambia. **Colapsarlos sería escribir tests que
no se pueden poner en rojo.**

**A. Aislamiento real entre inquilinos (5 sitios).** El caller elige el identificador; borrar el
filtro cambia lo que sale por la API. Un fixture de dos dueños los mata.

| Sitio | El identificador viene de | Qué se filtra hoy |
|---|---|---|
| `src/services/receipt.ts:293` | `req.params.id` (`routes/receipts.ts:78`, `:106`) | un recibo ajeno |
| `src/services/agent.ts:549` (`listMine`) | nada — es un listado (`routes/agents.ts:487`) | los agentes de B en la lista de A |
| `src/services/llm/transform.ts:234` | la clave de caché `(source_agent_id, target_agent_id, schema_hash)`, **ortogonal al dueño** | **la función de transformación de B, que después se ejecuta.** Es el de mayor consecuencia de los 11 |
| `src/services/llm/transform.ts:278` | idem | el `hit_count` de la fila de B (fire-and-forget) |
| `src/routes/payments.ts:384` | `req.params.id` | la arbitración de B, **con `settle_usd` y `at_stake_usd` en el cuerpo** |

Nota sobre `transform.ts:234`: el chequeo HMAC de `:245-265` verifica que el servidor firmó la
función, **no** que sea del caller. O sea que el filtro de dueño es lo único que separa los
espacios de caché.

**B. Defensa en profundidad detrás de un pre-chequeo en JS (1 sitio).** `src/services/agent.ts:715`.
El pre-chequeo de `:701-709` compara `existing.owner_ref !== ownerRef` y lanza antes. Sólo muere
con un test de entrelazado (`task.ownership.test.ts:285-317`).
⚠️ **La forma de la aserción NO se copia tal cual**: `taskService.updateStatus` **lanza**, pero
`agentService.delete` devuelve `Array.isArray(data) && data.length > 0` (`agent.ts:721`), o sea
**`false`**, sin excepción. La aserción es «devolvió `false` **y** la fila de B sigue en la
tabla», no `rejects.toThrow`.

**C. Redundante con el alcance por `key_id` del propio caller (3 sitios) — corrección C-5.**
`spend-policy.ts:163`, `:190`, `:219`. Las tres rutas son `/keys/me/spend-policies`
(`routes/auth/spend-policy.ts:34`, `:80`, `:107`) y las tres pasan `callerKey.id` **y**
`callerKey.owner_ref`, o sea **dos campos de la misma fila autenticada** (`:93-96`, `:124-127`).
El caller **no puede** pasar un `keyId` ajeno: no hay parámetro de ruta para la key. Verificado
con `grep -rn 'spendPolicyService\.' src/routes/` — no hay otro llamador.

Consecuencia: como una `key_id` pertenece a exactamente un dueño, en una base **consistente** el
filtro por `key_id` ya acota al dueño y borrar `.eq('owner_ref', …)` **no cambia ninguna salida**.
Un fixture de dos dueños con datos realistas no puede matar estos tres mutantes.

La propiedad que el filtro **sí** sostiene, y que es la que hay que afirmar: *una fila con
`key_id = K` pero `owner_ref ≠ dueño(K)` no se le entrega al dueño de K.* Ese estado sólo existe
si la base quedó inconsistente o si una key cambió de dueño. Es defensa en profundidad legítima
y se prueba con el escenario de entrelazado, **declarándolo como tal** — igual que
`task.ownership.test.ts:277-283` declara que su carrera no es alcanzable hoy en producción.
Decir que estos tres previenen un IDOR sería afirmar de más.

**D. Ligadura de fila y código sin llamador (2 sitios) — corrección C-6.**

- `src/services/inbound-task.ts:316` (`get(ownerRef, id)`): **no tiene ningún llamador de
  producción**. `grep -rn 'inboundTaskService' src/` da un solo call-site fuera de tests
  (`routes/inbound.ts:89`, que llama `ingest`), y dentro del propio archivo `get` no se usa (los
  auto-llamados de `ingest` son `getByExternalRef`, `create`, `updateStatus`,
  `inbound-task.ts:434,448,459,473,484,498,520,542,547`). Su filtro no es alcanzable desde
  ninguna ruta. **Se prueba igual, a nivel de servicio**, y se declara que la única superficie
  que lo ejercita es el test.
- `src/services/inbound-task.ts:338` (`getByExternalRef`): el `ownerRef` sale de
  `keyRow.owner_ref` (`:425`), resuelto server-side. El caller no lo elige. Su filtro es la
  primera pata de la clave de dedup `(owner_ref, source, external_ref)`: sin él, el
  `external_ref` de un dueño dedupea contra el de otro. Es una aserción de idempotencia, no un
  IDOR — la misma clase 1c que el work-item reconoce para `fee-split.ts:365/538/618`.

**Recuento**: 5 (A) + 1 (B) + 3 (C) + 2 (D) = **11**. El work-item dice 12 acá y 11 en SEC-04;
contando su propia enumeración, SEC-04 tiene `fee-split×4 + arbiter×3 + evidence×3 +
reconciliation×1 + debit-capture×1` = **12**. Los rótulos están invertidos (C-4). 11 + 12 = 23. ✓

### 4.5 El falso compartido, y qué hacer con `agents.ownership.test.ts`

**`src/services/__fixtures__/owner-scoped-fake.ts`** (nuevo): extrae `task.ownership.test.ts:91-225`
a un módulo reusable — tabla en memoria, `applyFilters` que aplica **exactamente** los filtros
pedidos, `single`/`maybeSingle`/thenable con los mismos shapes de PostgREST (incluido `PGRST116`,
`:146-150`), registro de queries para el backstop estructural, y el hook `onUpdateStart` para el
entrelazado. Se parametriza por forma de fila; **no** se parametriza "si filtra por dueño": el
falso nunca filtra de oficio (CD-2, es la trampa que `task.ownership.test.ts:35-41` declara).

Extras que el corte necesita y el exemplar no tiene: `delete()` (lo pide `agent.ts:715` y
`spend-policy.ts:190`), `upsert()`, `not()`/`in()`/`limit()` para que las cadenas reales no
exploten, y soporte de **varias tablas a la vez** (`transform.ts` y `payments.ts` tocan una sola,
pero `agent.ts` y el montaje de rutas tocan más de una).

**`src/routes/agents.ownership.test.ts` no se puede ignorar (C-7).** Existe, se llama "anti-IDOR",
y su mock registra los `.eq()` sin aplicarlos (`:47-50` vs `:52-54`): la respuesta la decide
`state.row`, no la query. Sus dos tests cross-tenant (`T-PUB-08` `:116`, `T-PUB-09` `:138`) pasan
gracias al **pre-chequeo en JS**, no al filtro — y por eso `agent.ts:715` está entre los 23. Su
`T-143B-06` (`:161`) sí tiene un espía de argumento sobre el UPDATE, y eso explica por qué la
línea del UPDATE **no** está entre los 23.

**Decisión (DT-6)**: **no se toca**, y el sitio se cubre desde un archivo nuevo,
`src/services/agent.ownership.test.ts`, a nivel de servicio con el falso de comportamiento.
Motivo: reemplazar su mock cambia el contrato de `state.eqCalls` del que dependen 4 tests
preexistentes, y esta HU no está para arreglar tests ajenos con la excusa de rozarlos. Lo que sí
se hace es **una línea de comentario** en su header que apunte al archivo nuevo y diga qué
verifica cada uno — porque dos archivos con "ownership" en el nombre y garantías distintas es la
próxima confusión. Eso lo registra el reporte de cierre como TD.

### 4.6 El barrido de mutación como guion versionado (DT-4 corregido)

DT-4 rechazaba la mutación en CI con un argumento de orden de magnitud **no medido**. Medido
(§3.4): el barrido completo son ~87 × ~15 s ≈ **22 min**; el barrido acotado a las líneas
`.eq('owner_ref', …)` de este corte son ~11 × ~15 s ≈ **3 min**.

**La decisión no cambia, pero el motivo sí**: el barrido **no** entra como control de cada PR
—porque un control que tarda 22 min compite con el ciclo de trabajo y se termina desactivando,
no porque sea imposible— y queda como **`scripts/eq-sweep.mjs`, versionado**, con dos modos:
`--all` y `--paths <glob>`. El acotado es lo que produce la evidencia de AC-5.
**Nota honesta**: A1:163 dice que su `eqsweep.py` vivía en un scratchpad. Este guion es código
nuevo; que sea barato de correr no lo convierte en un control que alguien vaya a mirar (A1 §17
documenta qué pasa con los guiones que nadie mira). Por eso el control de PR sigue siendo AC-1,
que es estático, y el guion es una herramienta de la persona que cierra una HU de seguridad.

### 4.7 `CLAUDE.md` — la regla que se violó 23 veces

`CLAUDE.md:198-205` lista **4** tablas. Dos de sus cuatro filas son medibles y falsas hoy:

| Fila actual | Medido |
|---|---|
| `registries` \| — (admin global) \| N/A | **tiene `owner_ref: string`** (`database.types.ts:2567`). El acceso es público por diseño (`registry.ts:165`), pero la columna existe |
| (sólo 4 tablas listadas) | **21** tablas declaran `owner_ref` (§3.3) |
| `a2a_agent_keys` \| SI (WKH-53) | la columna está; **el guard app-layer no lo prueba ningún test** en `reconciliation.ts:1448` (A1) |
| `a2a_events` \| — \| N/A | correcto (no tiene `owner_ref`) |

**Cambio**: la tabla enumerada a mano se reemplaza por (a) el criterio (*«toda tabla cuyo `Row`
declare `owner_ref` en `src/types/database.types.ts`; hoy 21»*), (b) un puntero a
`test/ownership-filter-guard.test.ts` como la fuente mecánica, (c) un puntero a la lista de
excepciones como el lugar donde vive el motivo de cada omisión, y (d) la frase que falta y que es
la que se violó: **el guardián verifica presencia, no valor** — un filtro presente con el valor
equivocado pasa, y eso lo cubren los `*.ownership.test.ts`.
**El número 21 NO se escribe como una lista** de nombres: sería la misma lista a mano que
envejeció, con otra ropa.

---

## 5. Constraint Directives

### Heredadas del work-item (íntegras)

- **CD-1 — PROHIBIDO** modificar cualquier línea de producción bajo `src/` que no sea test. Si un
  test no puede ponerse en rojo sin tocar producción, se documenta y se escala (AC-7).
- **CD-2 — OBLIGATORIO** que todo fixture de ownership tenga dos `owner_ref` distintos, y que el
  falso **no filtre por dueño de oficio**.
- **CD-3 — OBLIGATORIO** que la evidencia de AC-5 sea **por línea**. Renombrar la columna en todo
  el archivo da un KILLED falso (A1:159).
- **CD-4 — PROHIBIDO** que el guardián lleve una lista de tablas escrita a mano.
- **CD-5 — PROHIBIDO** presentar el guardián como suficiente. Verifica **presencia textual**: no
  detecta el valor equivocado ni las cadenas partidas en variable. §4.3 va en el header del
  archivo.
- **CD-6 — OBLIGATORIO** un control anti-vacuidad por test nuevo (las dos direcciones:
  A ve lo suyo **y** no ve lo de B, `task.ownership.test.ts:261-264`).

### Nuevas de este SDD

- **CD-7 — PROHIBIDO afirmar que el mecanismo «impide» algo.** Cada afirmación va con el input
  concreto que la pone en rojo, y al lado el input que se le escapa. Es la lección medida de
  WKH-315 (`_INDEX.md:180`: cinco vueltas porque cada iteración escribía una propiedad universal
  que la fórmula no sostenía).
- **CD-8 — OBLIGATORIO re-medir el baseline en el worktree antes de la primera mutación**, y
  citarlo con su commit. El baseline de A1 (`1 failed | 5288 passed`) **no** es el de un worktree
  real (`0 failed | 5294 passed | 19 skipped (5313)` en `ef384b7`). Un mutante comparado contra
  el baseline equivocado se clasifica al revés.
- **CD-9 — OBLIGATORIO verificar la mutación antes de creerle al veredicto.** Antes de escribir
  `SURVIVED`/`KILLED`, mostrar la línea que se borró y confirmar que es una cadena de consulta y
  no un comentario. Medido en este F2: `grep … | head -1` seleccionó `task.ts:21`, un comentario,
  y produjo un SURVIVED correcto y engañoso (§3.4). Reincidente: `218/auto-blindaje.md:27-39`,
  `217/auto-blindaje.md:35-47`.
- **CD-10 — PROHIBIDO que la lista de excepciones se genere volcando la salida del escáner.**
  Un artefacto derivado de la misma medición que consume deja el control verde por construcción.
  Reincidente: `217/auto-blindaje.md:20-31` (`T-U7` iteraba la allowlist para afirmar que todas
  estaban permitidas). Control: un test que planta una violación **sintética** y exige que el
  escáner la reporte.
- **CD-11 — OBLIGATORIO que el censo cierre por construcción, no por grep.** El conteo ya creció
  23 → 55; que crezca otra vez significa que la búsqueda no cerró. El censo parte del **conjunto
  derivado de tablas** y recorre **todas** las cadenas, y su total tiene que cuadrar:
  `cadenas = con-dueño + sin-dueño`, `sin-dueño = Σ categorías`. Reincidente:
  `217/auto-blindaje.md:68-125`.
- **CD-12 — OBLIGATORIO** el orden `editar → tsc → test → lint → commit` **por wave**. Reincidente
  en dos HUs (`217:51-60`, `218:8-21`).
- **CD-13 — OBLIGATORIO** que el escáner resuelva constantes de módulo (`.from(SPLITS_TABLE)`) y
  filtre por receptor `supabase`. Sin lo primero, `fee-split.ts` (el archivo con más sitios del
  hallazgo 0) queda fuera y nadie se entera; sin lo segundo, 33 `Buffer.from`/`Array.from` entran
  como ruido.
- **CD-14 — Si el censo encuentra una entrada `idor-vivo`, PARAR y escalar.** No se arregla en
  esta HU (CD-1 lo prohíbe) y no se degrada a excepción. Sale como hallazgo con su propia HU.
- **CD-15 — PROHIBIDO ampliar el corte.** Los 12 sitios de SEC-04, los otros 64 `.eq` no-owner,
  `chaski-v3`/`wasiai-facilitator`/`solana-programs`/`wasiai-remittance-agents`, `m5-keys/`, la
  base `caldz` y desplegar están **fuera**. Un sitio de SEC-04 que aparezca «de paso» se anota en
  el censo y no se toca.

---

## 6. Waves

**W0 es serial y bloquea todo**: produce el conjunto de tablas, el censo, la lista de excepciones
y el falso compartido. Sin la lista de excepciones el guardián de W1 no puede nacer verde, y sin
el falso los tests de W2/W3 se copian y pegan cuatro veces.

### Wave 0 — serial · el instrumento y la medición

| Archivo | Acción |
|---|---|
| `test/ownership-filter-guard.scanner.ts` (o el escáner exportado desde el propio test) | `deriveOwnerTables(src)` + `scanSource(src, tables)`, **funciones puras** |
| `src/services/__fixtures__/owner-scoped-fake.ts` | el falso de dos dueños (§4.5) |
| `test/ownership-filter-guard.exceptions.ts` | la lista, **escrita a mano** (CD-10) |
| `doc/sdd/220-…/censo-owner-ref.md` | **AC-6**: las 55 entradas clasificadas |

Salida verificable de W0: el censo cuadra (CD-11) y **cero** entradas `idor-vivo` (si hay una →
CD-14).

### Wave 1 — el guardián (AC-1)

`test/ownership-filter-guard.test.ts`: el guardián + sus 9 controles anti-vacuidad de §4.2 + el
header con §4.3. Paralelizable con W2 sólo si W0 cerró.

### Wave 2 — tests de propiedad, los 5 sitios de aislamiento real (AC-2)

| Archivo nuevo | Cubre |
|---|---|
| `src/services/receipt.ownership.test.ts` | `receipt.ts:293` |
| `src/services/agent.ownership.test.ts` | `agent.ts:549` (+ `:715` en W3) |
| `src/services/llm/transform.ownership.test.ts` | `transform.ts:234`, `:278` |
| `src/routes/payments.dispute-ownership.test.ts` | `routes/payments.ts:384` (nivel HTTP, montaje tipo `agents.ownership.test.ts:96-97`) |

### Wave 3 — entrelazado y defensa en profundidad (AC-3)

| Archivo | Cubre | Declaración obligatoria |
|---|---|---|
| `src/services/agent.ownership.test.ts` | `agent.ts:715` | la carrera no es alcanzable hoy; la aserción es `false` + fila intacta, **no** `rejects.toThrow` (§4.4-B) |
| `src/services/spend-policy.ownership.test.ts` | `spend-policy.ts:163,190,219` | **no previenen un IDOR** (C-5): `keyId` y `ownerRef` salen de la misma fila del caller. Es integridad ante una fila inconsistente |
| `src/services/inbound-task.ownership.test.ts` | `inbound-task.ts:316,338` | `:316` no tiene llamador de producción; `:338` es idempotencia, no aislamiento (C-6) |

### Wave 4 — evidencia y doctrina

| Archivo | Acción |
|---|---|
| `scripts/eq-sweep.mjs` | el barrido versionado, modos `--all` / `--paths` (§4.6) |
| `doc/sdd/220-…/mutation-log.md` | **AC-5**: una fila por línea mutada |
| `CLAUDE.md:198-205` | §4.7 |
| `doc/sdd/220-…/_INDEX-row.md` | la fila, staged (convención de las HUs 212/214/217) |

---

## 7. Plan de tests

Cada test nombra el input que lo pone en rojo. Un test cuyo rojo no se pueda nombrar no entra.

| ID | Archivo | Qué afirma | Input que lo pone en rojo |
|---|---|---|---|
| **G-01** | `ownership-filter-guard.test.ts` | el conjunto derivado tiene ≥15 tablas y contiene `a2a_receipts` | romper el parser de `database.types.ts` |
| **G-02** | ídem | el árbol tiene ≥90 cadenas sobre tablas con dueño | un regex que matchee de menos |
| **G-03** | ídem | fixture **con** filtro → 0 hallazgos | escáner que reporte siempre |
| **G-04** | ídem | fixture **sin** filtro → 1 hallazgo con su línea | escáner que no reporte nunca |
| **G-05** | ídem | `.from(CONST)` se resuelve | volver a exigir literales |
| **G-06** | ídem | `Buffer.from('a2a_receipts')` → 0 hallazgos | quitar el filtro de receptor |
| **G-07** | ídem | `.eq('ownerRef', …)` (camelCase) → **1 hallazgo** | comparar el nombre de columna de forma laxa |
| **G-08** | ídem | ★ cero cadenas sin filtro y sin excepción, nombrando `archivo:línea` | agregar a un service `supabase.from('a2a_receipts').select('*').eq('id', id).single()` (AC-1) |
| **G-09** | ídem | una excepción cuyo sitio ya no existe → ROJO | borrar una consulta y dejar su excepción |
| **G-10** | ídem | toda excepción tiene `category` de la unión y `reason` no vacío | una excepción con `reason: ''` |
| **R-01** | `receipt.ownership.test.ts` | A pide por id el recibo de B → `null`, y el id **existe** en la tabla | borrar `receipt.ts:293` |
| **R-02** | ídem | A pide **el suyo** → lo obtiene (anti-vacuidad, CD-6) | que el falso filtre de más |
| **AG-01** | `agent.ownership.test.ts` | `listMine(A)` devuelve exactamente los slugs de A | borrar `agent.ts:549` |
| **AG-02** | ídem | entrelazado: la fila pasa a B entre el pre-chequeo y el DELETE → devuelve `false` y la fila de B sigue | borrar `agent.ts:715` |
| **TR-01** | `llm/transform.ownership.test.ts` | con la MISMA clave de caché `(source,target,hash)` y dos dueños, A obtiene **su** función y nunca la de B | borrar `transform.ts:234` |
| **TR-02** | ídem | el `hit_count` que sube es el de la fila de A | borrar `transform.ts:278` |
| **TR-03** | ídem | una fila con `owner_ref = NULL` no se le entrega a nadie (§4.3 punto 4) | tratar `NULL` como comodín |
| **PD-01** | `payments.dispute-ownership.test.ts` | `GET /session/:id/dispute` con el id de B → **404**, y el cuerpo no trae `settleUsd` | borrar `routes/payments.ts:384` |
| **PD-02** | ídem | con **su** id → 200 con el cuerpo (anti-vacuidad) | que el falso filtre de más |
| **SP-01..03** | `spend-policy.ownership.test.ts` | fila `key_id = K` / `owner_ref = B` no se le entrega al dueño de K, en `list`/`delete`/`hasAnyPolicy` | borrar `spend-policy.ts:163` / `:190` / `:219` |
| **IT-01** | `inbound-task.ownership.test.ts` | `get(A, idDeB)` → `undefined` con el id presente | borrar `inbound-task.ts:316` |
| **IT-02** | ídem | dos dueños con el MISMO `(source, external_ref)` no dedupean entre sí | borrar `inbound-task.ts:338` |

**Backstop estructural**: **un** test por archivo nuevo, con el patrón
`task.ownership.test.ts:333-358` (mapear las queries registradas a `scoped`/`UNSCOPED`). Sirve
para **ubicar** cuál sitio se abrió, no para afirmar qué datos salen (DT-1).

## 8. Plan de mutación — por línea (AC-5, CD-3, CD-8, CD-9)

**Protocolo por entrada** (una línea, no un archivo, no un renombre):

1. `git stash`/árbol limpio · confirmar baseline `0 failed | 5294 passed | 19 skipped (5313)`.
2. `sed -n '<N>p' <archivo>` y **pegar la línea en el log** — si es un comentario, la mutación es
   inválida (CD-9).
3. Borrar sólo esa línea · `npx vitest run` · registrar el conteo crudo.
4. `git checkout -- <archivo>` · `git status --short` vacío.
5. Fila del log: `archivo:línea` · texto exacto borrado · veredicto · **el test nombrado que se
   puso rojo** · conteo crudo.

**Mutantes obligatorios — producción (11):**

| Línea | Veredicto esperado | Test que debe morir |
|---|---|---|
| `src/services/receipt.ts:293` | KILLED | R-01 |
| `src/services/agent.ts:549` | KILLED | AG-01 |
| `src/services/agent.ts:715` | KILLED | AG-02 |
| `src/services/llm/transform.ts:234` | KILLED | TR-01 |
| `src/services/llm/transform.ts:278` | KILLED | TR-02 |
| `src/routes/payments.ts:384` | KILLED | PD-01 |
| `src/services/spend-policy.ts:163` / `:190` / `:219` | KILLED | SP-01 / SP-02 / SP-03 |
| `src/services/inbound-task.ts:316` / `:338` | KILLED | IT-01 / IT-02 |

**Mutantes obligatorios — el guardián (5). Un guardián sin mutación es exactamente el hallazgo
que esta HU existe para cerrar:**

| Mutación | Veredicto esperado | Control |
|---|---|---|
| plantar una cadena sintética sin filtro en un fixture del escáner | KILLED por G-04/G-08 | prueba que el guardián reporta |
| borrar UNA entrada de la lista de excepciones | KILLED por G-08 | prueba que la lista es portante y no decorado |
| `deriveOwnerTables` devuelve `∅` | KILLED por **G-01** (no por G-08, que quedaría verde) | el modo de falla silencioso |
| el guardián busca `ownerRef` en vez de `owner_ref` | KILLED por G-07 | comparación estricta del nombre |
| quitar la resolución de constantes (`.from(SPLITS_TABLE)` deja de verse) | KILLED por G-05 | CD-13 |

**Dos firmas de muerte idénticas = un mutante mal construido** (`217/auto-blindaje.md:155-165`):
si dos mutaciones distintas matan exactamente el mismo test con el mismo conteo, hay que partir
el test o rehacer el mutante.

**Sitios cuya mutación tiene un veredicto que hay que escribir con cuidado**: los tres de
`spend-policy` y los dos de `inbound-task` mueren por un test que arma un estado **que la
producción no alcanza hoy** (§4.4-C, §4.4-D). El log dice `KILLED (escenario de integridad, no
alcanzable desde ruta autenticada — ver SDD §4.4)`. Un `KILLED` a secas ahí sería la misma prosa
que afirma de más que esta HU está tratando de sacar del repo.

---

## 9. Missing Inputs del work-item — resueltos

- **MI-1 · procedencia del `keyId` en `reconciliation.ts:1128-1133` → RESUELTO. No es IDOR.**
  El `keyId` sale de `const keyId = row.key_id` (`reconciliation.ts:912`), donde `row` es el
  resultado del SELECT de `:886-897` filtrado por `intent_id`. O sea que lo determina la **fila**
  que el worker está resolviendo, no el request. Además `resolveIntent` es camino de admin
  (`routes/dashboard.ts`, gate `requireAdminTokenStrict`, fail-closed en dev y prod, `:151-176`).
  Clasificación en el censo: `ligadura-de-fila`. Las tres `.eq` de `:1131-1133` sí importan como
  compare-and-set (A1 hallazgo 8), pero eso es otra HU (el work-item lo pone en «los otros 64»).
- **MI-2 · ¿`reverseFeeSplits` tiene llamador de producción? → RESUELTO: NO.**
  `grep -rn 'reverseFeeSplits' src/` da 8 ocurrencias: 5 en `fee-split.test.ts`, 3 en el propio
  `fee-split.ts` (docblock `:18`, banner `:628`, definición `:640`) y una mención en un comentario
  de `fee-charge.ts:677`. Ningún call-site de producción, coherente con su docblock («v1: NO se
  cablea a orchestrate/compose», `:636`). Es de SEC-04, así que sólo baja su prioridad allá.
- **MI-3 · ¿`kite_schema_transforms` está en `Database` y tiene `owner_ref`? → RESUELTO: SÍ**,
  `database.types.ts:2298` (bloque) / `:2303` (columna), tipada `string | null`. La nulabilidad
  es un caso de test propio (TR-03), no un bloqueo.
- **MI-4 · número de HU/directorio → RESUELTO: 220.** El máximo en `doc/sdd/` es
  `219-hu-323-discover-default-fetch-y-total`; `220-…` está libre y ya es el directorio del
  work-item. Rama creada: `feat/220-wkh-sec-03-owner-ref-sin-cobertura` desde `ef384b7`.
- **MI-5 · worktree → RESUELTO**: `wt-sec03`, creado desde `ef384b7`.

### Nuevo Missing Input, no bloqueante

- **MI-6 · el conteo de la suite no coincide entre fuentes.** A1 reporta 5308 casos, la fila 217
  del `_INDEX` reporta 5006 «raíz + mcp + agent-sdk», y yo medí **5313** con `npx vitest run` en
  la raíz. Las tres son mediciones de cosas distintas (copia con `git init` / tres runners / un
  runner) y **no se pudo verificar** cuál corresponde a cuál sin re-correr las tres.
  Impacto: ninguno para esta HU **si** se aplica CD-8 (re-medir en el worktree antes de mutar).

---

## 10. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R-1 | **El guardián nace con ~41 excepciones** y el próximo lector aprende «se agrega una excepción y listo». | La `category` es una unión cerrada y `reason` es obligatorio (G-10); la distribución por categoría queda en el censo, así que una excepción en la categoría equivocada es visible en el diff. **No se puede eliminar el riesgo**: 41 es el estado real del árbol. |
| R-2 | La lista de excepciones se genera volcando el escáner y el control queda vacuo. | CD-10 + G-04/G-08 con violación sintética. Es el modo de falla ya medido en WKH-322. |
| R-3 | Un test de W3 arma un estado que la base nunca tiene y se lee como prueba de aislamiento. | §4.4-C/D + la declaración obligatoria en el log de mutación y en el header del archivo (patrón `task.ownership.test.ts:277-283`). |
| R-4 | Dos archivos con «ownership» en el nombre para agentes (`routes/agents.ownership.test.ts` y `services/agent.ownership.test.ts`) con garantías distintas. | DT-6: comentario cruzado en los dos headers + TD en el reporte de cierre. |
| R-5 | El punto ciego de las cadenas partidas (11 sitios) se lee como «cubierto». | §4.3 punto 2, en el header del archivo. El modo de falla es falso positivo, no falso negativo. |
| R-6 | Conflicto de merge con las HUs en vuelo. | Esta HU **no toca `src/` de producción** (CD-1). Superficie compartida: `CLAUDE.md` y `doc/sdd/_INDEX.md` (por eso la fila va en `_INDEX-row.md`). Y `src/services/__fixtures__/` es directorio nuevo. |
| R-7 | Aparece un `idor-vivo` en el censo y la HU se desvía a arreglarlo. | CD-14: se para y se escala; no se arregla acá. |

## 11. Dependencias

- **Depende de**: nada. Se puede empezar.
- **Bloquea a WKH-SEC-04**: comparte el falso (`owner-scoped-fake.ts`), la lista de excepciones y
  el guion `eq-sweep.mjs`. Arrancarlas en paralelo garantiza dos falsos distintos.
- **Roce con WKH-SEC-02 (RLS real)**: ninguno de código. Y el argumento que **no** hay que hacer:
  RLS no vuelve redundantes estos filtros mientras el cliente use `SUPABASE_SERVICE_KEY`
  (BYPASSRLS), `CLAUDE.md:207-215`.

---

## 12. Implementation Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todos los `archivo:línea` citados verificados con `Read`/`grep` sobre `ef384b7` | ✅ |
| 2 | Exemplars verificados (existen y los leí) | ✅ §3.2 |
| 3 | Baseline de la suite **medido en el worktree**, no citado | ✅ `0 failed \| 5294 passed \| 19 skipped (5313)`, 10,0 s |
| 4 | El hallazgo que origina la HU **reproducido** (`receipt.ts:293` → SURVIVED) | ✅ §3.4 |
| 5 | Control negativo del instrumento de mutación (`task.ts:102` → KILLED) | ✅ §3.4 |
| 6 | Conjunto de tablas con dueño **derivado**, no escrito a mano | ✅ 21, §3.3 |
| 7 | Censo de ausentes con una corrida preliminar y taxonomía cerrada | ✅ 55 cadenas, §4.1 |
| 8 | Missing Inputs del work-item resueltos | ✅ 5 de 5, §9 |
| 9 | Limitaciones del guardián declaradas (§4.3), y con destino al header del archivo | ✅ 7 ítems |
| 10 | Cada AC tiene el input concreto que lo pone en rojo | ✅ §7 |
| 11 | Plan de mutación **por línea**, con veredicto esperado y test nombrado | ✅ §8, 11 + 5 mutantes |
| 12 | Constraint Directives del work-item heredadas íntegras | ✅ CD-1..CD-6 |
| 13 | CDs nuevos anclados en Auto-Blindaje reincidente (≥2 HUs) | ✅ CD-9/10/11/12, §3.5 |
| 14 | Contradicciones con el work-item declaradas, con su medición | ✅ 7, §1 |
| 15 | `[NEEDS CLARIFICATION]` pendientes | **0** |
| 16 | Alcance: mecanismo + 11 sitios; SEC-04 fuera | ✅ CD-15 |

**Un ítem que NO está verde y se declara**: la clasificación de las 55 entradas del censo está
**preliminar** — verifiqué ~15 con `Read` (las de §4.1 con `archivo:línea` citado) y las otras 40
salen de la salida del escáner, sin lectura del código. Completarlas es el entregable de W0, no
un pendiente de F2: es literalmente lo que AC-6 pide producir.

**Veredicto: LISTO PARA F2.5 (Story File).**

---

## Anexo — comandos de reproducción

```bash
# baseline (worktree wt-sec03, base ef384b7)
npx vitest run                       # 5294 passed | 19 skipped (5313), ~10 s

# reproducir el hallazgo 0 sobre un sitio
sed -n '293p' src/services/receipt.ts   # confirmar que es .eq('owner_ref', ownerRef)
sed -i '293d' src/services/receipt.ts
npx vitest run                          # = baseline  ⟹ SURVIVED
git checkout -- src/services/receipt.ts

# control negativo (el instrumento puede producir un rojo)
sed -n '102p' src/services/task.ts
sed -i '102d' src/services/task.ts
npx vitest run                          # 2 failed  ⟹ KILLED
git checkout -- src/services/task.ts
```

⚠️ **No elegir la línea con `grep … | head -1`**: en `task.ts` devuelve la línea 21, que es un
comentario. La mutación resultante no toca ninguna consulta y su «SURVIVED» no dice nada del
código (CD-9).
