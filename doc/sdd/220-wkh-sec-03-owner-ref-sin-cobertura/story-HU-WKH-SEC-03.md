# Story File — #220 · WKH-SEC-03: los filtros por dueño que nadie prueba, y el censo de los que no están

> SDD: `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/sdd.md` (766 líneas, SPEC_APPROVED)
> Work item: `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/work-item.md`
> Fecha: 2026-08-05 · Autor: `nexus-architect` (F2.5)
> Worktree: `/home/ferdev/.openclaw/workspace/wt-sec03` · Rama: `feat/220-wkh-sec-03-owner-ref-sin-cobertura`
> **Commit base: `ef384b775ed990d9ad26c3df55a0681ba6d97c14` = HEAD del worktree.** Verificado con
> `git rev-parse HEAD`. Todo `archivo:línea` de este documento está anclado a ese commit.

**Este documento es autosuficiente. No necesitás abrir el SDD para implementar.** Los punteros al
SDD son para contexto, nunca para completar un dato faltante. Si te falta un dato: PARÁ y escalá.

---

## 1. Goal

Tres mediciones, ningún arreglo:

1. **El censo** de consultas sobre tablas con `owner_ref` que **no** filtran por dueño. Nunca se
   corrió: la auditoría A1 borraba líneas existentes, así que por construcción no podía encontrar
   una línea **ausente**.
2. **Un guardián estructural en `npm test`** que deriva las tablas con dueño del archivo de tipos
   y reporta las cadenas sin filtro que no estén en una lista de excepciones escrita a mano.
3. **Los tests de propiedad** de los **11 sitios** de este corte, con evidencia de mutación
   **por línea**.

**Esta HU no arregla ningún filtro. Los 11 están puestos y son correctos. Lo que falta es que
alguien los mida.** Hoy borrás `src/services/receipt.ts:293` y la suite entera queda idéntica.

---

## 2. Los hechos que gobiernan esta HU

Diez. Los siete primeros (H-1..H-7) vienen del SDD, que corrigió al work-item con mediciones; los
tres últimos (H-8..H-10) los medí yo en F2.5 y **no están en el SDD**. Ninguno es opinable: cada
uno tiene el comando que lo reproduce.

### H-1 · El censo ya se corrió dos veces y el número creció: 23 → 55

`101` cadenas `supabase.from(<tabla con dueño>)` en `src/` no-test: **46 con filtro de dueño, 55
sin**. Lo corrí yo de forma independiente en F2.5 y me dio **exactamente lo mismo** que el SDD
(101 / 46 / 55 / 0 argumentos no resolubles).

Desglose por verbo de las 55 SIN dueño, medido:

| Verbo | Cantidad |
|---|---|
| `select` | 37 |
| `update` | 4 |
| `upsert` | 3 |
| `insert` | 11 |
| `delete` | **0** |
| **total** | **55** |

De ahí sale el número que importa: **el alcance del guardián (`select`+`update`+`delete`) son 41
cadenas sin filtro**. Ese es el estado real del árbol y **el guardián nace con ~41 excepciones**.
No es un defecto del guardián ni algo a "limpiar": es la fotografía honesta del repo hoy.

> **Lo que tenés que hacer con esto**: correrlo de nuevo con **tu** escáner. Si tu número no es
> 55 (ni 41 en el alcance del guardián), **ese delta es el hallazgo de la HU, no un ajuste de
> tuning**. Lo escribís en el censo con la explicación de por qué tu instrumento ve algo que el
> mío no (o al revés) — y sólo después decidís cuál de los dos está bien. Un conteo que crece es
> una búsqueda que no cerró. → **CD-11**.

### H-2 · Son 21 tablas con dueño, no 18 y no 4

Derivado de `src/types/database.types.ts`: **62 tablas** en `Database.public.Tables`, **21**
declaran `owner_ref` en su bloque `Row`. Verificado por mí en F2.5 con una sonda propia.

```
a2a_agent_keys · a2a_agent_links · a2a_agents · a2a_arbiter_nonces · a2a_arbitrations ·
a2a_delegations · a2a_fee_splits · a2a_inbound_tasks · a2a_key_deposits ·
a2a_key_dest_spend_ledger · a2a_key_sessions · a2a_key_spend_policies ·
a2a_payment_intent_debit_signatures · a2a_payment_intents · a2a_payment_vouchers · a2a_receipts ·
a2a_refund_applications · a2a_refund_outbox · kite_schema_transforms · registries · tasks
```

Esa lista está acá **para que compares tu derivación contra ella una vez**, no para que la
copies. **CD-4 prohíbe que el guardián lleve una lista de tablas escrita a mano**: el guardián
las deriva del archivo de tipos en cada corrida. El work-item dice 18 y `CLAUDE.md:198-205` dice
4; los dos están mal.

Dos detalles medidos que el diseño tiene que absorber:

- **`kite_schema_transforms` es la única con `owner_ref: string | null`** (`database.types.ts:2303`).
  Las otras 20 son `string`. Una fila con `owner_ref = NULL` no matchea `.eq('owner_ref', X)` para
  ningún `X`: queda invisible para todos. Eso **no** es un IDOR, es un miss de caché permanente.
  El test TR-03 distingue los dos casos.
- **`registries` tiene `owner_ref: string`** (`database.types.ts:2567`), o sea que la fila de
  `CLAUDE.md:205` («`registries` | — (admin global) | N/A») **afirma que la columna no existe y
  la columna existe**. El acceso público sigue siendo correcto por diseño
  (`src/services/registry.ts:165`), pero la tabla del `CLAUDE.md` es falsa a nivel de esquema.

### H-3 · La línea base correcta es `0 failed | 5294 passed | 19 skipped (5313)`

**La medí yo, en este worktree, sobre `ef384b7`, antes de escribir esta línea:**

```
 Test Files  261 passed | 6 skipped (267)
      Tests  5294 passed | 19 skipped (5313)
   Duration  9.89s
```

**La baseline del reporte de auditoría (`1 failed | 5288 passed | 19 skipped`) está mal**: su
laboratorio era una copia con un `git init` fresco, y contra esa copia el guardián
`test/test-files-are-run-in-ci.test.ts` fallaba. **Un mutante medido contra la baseline
equivocada se clasifica al revés.** → **CD-8**: re-medís vos la baseline en el worktree y la
citás con su commit, antes de la primera mutación.

### H-4 · Los rótulos del corte están invertidos: SEC-03 son **11** sitios, SEC-04 son 12

El work-item dice 12 acá y 11 allá. Contando su propia enumeración: SEC-04 = `fee-split×4 +
arbiter×3 + evidence×3 + reconciliation×1 + debit-capture×1` = **12**. 11 + 12 = 23. ✓
**Usá los números y la lista de este documento (§6), no los del work-item.**

### H-5 · Tres sitios de `spend-policy` NO se pueden matar con un fixture realista

`src/services/spend-policy.ts:163` (`list`), `:190` (`delete`), `:219` (`hasAnyPolicy`).

Las tres rutas son `/keys/me/spend-policies` y las tres pasan `callerKey.id` **y**
`callerKey.owner_ref` — **dos campos de la misma fila ya autenticada**
(`src/routes/auth/spend-policy.ts:94-95` y `:125-126`). No hay parámetro de ruta para la key:
**el caller no puede pasar un `keyId` ajeno**. Verificado: `grep -rn 'spendPolicyService\.'
src/routes/` da tres call-sites, todos en `src/routes/auth/spend-policy.ts` (`:53`, `:93`, `:124`).

Consecuencia: como una `key_id` pertenece a exactamente un dueño, en una base **consistente** el
filtro por `key_id` ya acota al dueño, y borrar `.eq('owner_ref', …)` **no cambia ninguna salida**
de ninguna ruta.

**La propiedad que sí sostienen, y que es la única que podés afirmar**: *una fila con `key_id = K`
pero `owner_ref ≠ dueño(K)` no se le entrega al dueño de K.* Ese estado sólo existe si la base
quedó inconsistente o si una key cambió de dueño.

**Se prueba como integridad ante una fila inconsistente, y hay que declararlo así — en el header
del archivo de test y en el log de mutación.** Escribir "estos tres previenen un IDOR" es afirmar
de más, y sacar esa clase de prosa del repo es literalmente para lo que existe esta HU.

### H-6 · Dos sitios sólo mueren con un test de entrelazado, y la receta ya existe

`src/services/agent.ts:715` es el caso canónico: el pre-chequeo en JS de `agent.ts:701`
(`if (existing.owner_ref !== ownerRef)`) lanza **antes** de llegar al DELETE, así que el
cross-tenant simple nunca ejercita el filtro de la escritura.

**La receta es `src/services/task.ownership.test.ts:285-317` (T-OWN-03) — ese es el exemplar. No
inventes otro.** Verificado: existe, lo leí, y el mecanismo es el hook `onUpdateStart`
(`task.ownership.test.ts:128-133`) que corre **dentro** del `update()` del falso, o sea entre el
read previo y la escritura.

⚠️ **La forma de la aserción NO se copia tal cual.** `taskService.updateStatus` **lanza**
(`rejects.toThrow`), pero `agentService.delete` **devuelve un booleano**:

```
src/services/agent.ts:721 →  return Array.isArray(data) && data.length > 0;
```

Con la fila ya pasada a B, el DELETE no matchea nada, `data` es `[]`, y la función devuelve
**`false` sin excepción**. La aserción correcta es: **devolvió `false` Y la fila de B sigue en la
tabla**. Un `rejects.toThrow` acá no se pone rojo nunca — se pone gris.

⚠️ Segunda diferencia con el exemplar: el hook tiene que dispararse en **`delete()`**, no en
`update()`. `agentService.delete` no hace UPDATE.

### H-7 · Ya existe `src/routes/agents.ownership.test.ts`, se titula "anti-IDOR", y su mock no aísla

Verificado por mí, línea por línea:

```
src/routes/agents.ownership.test.ts:48-51   eq: (col, val) => { state.eqCalls.push([col, val]); return builder; }
src/routes/agents.ownership.test.ts:53      maybeSingle: () => Promise.resolve({ data: state.row, error: null }),
src/routes/agents.ownership.test.ts:54      single:      () => Promise.resolve({ data: state.row, error: null }),
```

El mock **registra** los `.eq()` y **no los aplica**: la respuesta la decide `state.row`, sin
importar qué columna ni qué valor se filtró. Puede verificar **que la consulta se escribió**;
nunca **que aisló**.

> Nota de honestidad sobre las citas: el SDD dice `:47-50` vs `:52-54`. Yo medí `:48-51` (el
> bloque de `eq`, con el `push` en `:49`) y `:53-54`. La diferencia es de una línea en el corte
> del bloque; el hecho es idéntico. Usá **mis** números, que son los que verifiqué contra el
> archivo en `ef384b7`.

Sus dos tests cross-tenant (`T-PUB-08` `:116`, `T-PUB-09` `:138`) pasan gracias al **pre-chequeo
en JS**, no al filtro de la consulta — por eso `agent.ts:715` está entre los 23 sitios sin
cobertura. Su `T-143B-06` (`:161`) sí tiene un espía de argumento sobre el UPDATE, y eso explica
por qué la línea del UPDATE **no** está entre los 23.

**Qué hacés con ese archivo: §9. La decisión ya está tomada y tenés que ejecutarla y declararla.**

---

### Los tres hechos que medí yo en F2.5 y que el SDD no tiene

#### H-8 · `test/` NO lo typechequea CI, y `test/` NO lo lintea nadie

Medido, decisivo:

```
node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --listFiles
  → 460 archivos bajo src/   ·   0 archivos bajo test/
```

Causa: `tsconfig.json:19` es `"include": ["src/**/*"]`. El step de typecheck de CI
(`.github/workflows/ci.yml:37`) usa ese `tsconfig.json`. Y `package.json:11` es
`"lint": "biome check src/"` — **`test/` tampoco se lintea**.

Los `*.test.ts` bajo `src/` **sí** se typechequean (confirmado: `task.ownership.test.ts` aparece
en el `--listFiles`).

**Consecuencia que cambia el diseño**: el guardián y su lista de excepciones viven en `test/`
(§7, W1), así que la unión cerrada de `category` y el `reason` no vacío **NO los evalúa nadie en
CI si sólo son tipos de TypeScript**. Por eso **G-10 valida `category` y `reason` en RUNTIME**,
no sólo por tipo. Un `category: 'inventada-por-mi'` compila en tu editor, no rompe CI, y entra al
repo. Con la validación en runtime, `npm test` se pone rojo.

Segunda consecuencia, operativa: CD-12 dice `editar → tsc → test → lint → commit`. Para los
archivos de `test/`, **`tsc` y `lint` no miran nada**. Comprobalos a mano una vez por wave con un
tsconfig ad-hoc en el scratchpad:

```bash
cat > /tmp/tsconfig.tests.json <<'EOF'
{ "extends": "<ruta-absoluta-al-worktree>/tsconfig.json",
  "include": ["<ruta-absoluta-al-worktree>/test/**/*.ts"] }
EOF
node ./node_modules/typescript/bin/tsc -p /tmp/tsconfig.tests.json --noEmit
```

#### H-9 · Un archivo en `src/services/__fixtures__/` SE COMPILA AL BUILD DE PRODUCCIÓN

El work-item y el SDD ubican el falso compartido en `src/services/__fixtures__/owner-scoped-fake.ts`.
Lo probé empíricamente (creé un `_probe.ts` en cada carpeta, corrí `tsc -p tsconfig.build.json
--listFiles`, borré los probes, árbol limpio):

| Ruta | ¿Entra al build de producción? |
|---|---|
| `src/services/__fixtures__/_probe.ts` | **SÍ** |
| `src/services/__tests__/_probe.ts` | **NO** |

Causa: `tsconfig.build.json:3-8` excluye exactamente `src/**/*.test.ts` y `src/**/__tests__/**`.
`__fixtures__` no está en esa lista, así que un doble de test terminaría en `dist/`.

**Decisión (D-1, mía, en F2.5): el falso va a `src/services/__tests__/owner-scoped-fake.ts`.**
Con esa ruta: se typechequea (está bajo `src/`, con `strict` + `exactOptionalPropertyTypes` +
`noUncheckedIndexedAccess`), se lintea (`biome check src/`), y **no** entra al build. Sin tocar
ningún archivo de configuración.

#### H-10 · En este shell, `npx vitest run` NO te muestra la baseline

El hook de `rtk` reescribe la salida de `npx vitest run` a **una sola línea**: `PASS (5294) FAIL (0)`.
Perdés `Test Files`, perdés `skipped`, perdés la duración. Y redirigirla a un archivo guarda esa
línea, no la salida real (medido: el archivo quedó con 2 líneas).

Para la evidencia de AC-5 necesitás el **conteo crudo**. Usá:

```bash
node ./node_modules/vitest/vitest.mjs run
```

Esa invocación devuelve las 4 líneas del summary. Si en algún momento tu log de mutación tiene
`PASS (n) FAIL (0)` en vez de `Tests  n passed | 19 skipped (5313)`, estás midiendo con el
instrumento equivocado y no vas a poder distinguir un `skipped` que se movió.

---

## 3. ⚠️ Las dos trampas de medición. Leelas antes de mutar nada.

Las dos ya pasaron **hoy**, en esta misma HU, con dos personas distintas. No son hipotéticas.

### Trampa A — Un mutante grande da un **falso KILLED**

Le pasó al auditor. Si en vez de borrar **una línea** renombrás la columna en todo el archivo,
o borrás el archivo, o comentás un bloque, **la suite se pone roja por otra razón** (un tipo que
no compila, un test de otra cosa que dependía de esa columna) y anotás `KILLED` para un filtro
que en realidad nadie prueba.

**Antídoto — obligatorio (CD-3):**
- La mutación es **una línea**, borrada. Nunca un archivo, nunca un renombre global, nunca un
  bloque.
- Después de mutar, `git diff --stat` tiene que decir **`1 file changed, 0 insertions(+), 1 deletion(-)`**.
  Si dice otra cosa, la mutación es inválida y el veredicto se descarta.
- Si dos mutaciones distintas matan **exactamente el mismo test con el mismo conteo**, el mutante
  está mal construido: partí el test o rehacé el mutante.

### Trampa B — Elegir la línea con `grep | head -1` da un **falso SURVIVED**

Le pasó al arquitecto en F2, escribiendo el SDD. Buscó la línea con
`grep -n "eq('owner_ref'" src/services/task.ts | head -1`, y `head -1` devolvió
**`src/services/task.ts:21`, que es un COMENTARIO** que menciona `.eq('owner_ref', …)`. Borró un
comentario, la suite quedó idéntica, y anotó `SURVIVED`. El veredicto era **correcto y
completamente engañoso**: no se tocó ninguna consulta.

**Antídoto — obligatorio (CD-9):**
- Antes de borrar: `sed -n '<N>p' <archivo>` y **pegar el texto exacto en el log de mutación**.
- Si la línea empieza con `*`, `//`, `/*`, o es parte de un docblock → **mutación inválida**, no
  se registra veredicto.
- La línea tiene que ser una llamada de consulta real: `.eq('owner_ref', …)` con su punto inicial
  y su paréntesis. Las 11 líneas exactas de este corte están en §6, ya verificadas por mí una por
  una. **Usá esas, no las busques con grep.**

> Las dos trampas comparten la raíz: **el veredicto de una mutación no vale nada hasta que
> mostrás qué mutaste.** Por eso el log de AC-5 lleva el texto borrado, no sólo el número de línea.

---

## 4. Environment Gate (W-1) — antes de tocar código

Correr **en orden** desde `/home/ferdev/.openclaw/workspace/wt-sec03`. Si algo no da lo esperado,
PARÁ y escalá; no implementes sobre un entorno que no coincide con este documento.

```bash
# 1. Estás en el commit correcto
git rev-parse HEAD        # → ef384b775ed990d9ad26c3df55a0681ba6d97c14
git status --short        # → sólo untracked: doc/audit/ y doc/sdd/220-.../

# 2. La baseline. CON EL BINARIO DIRECTO (H-10), no con `npx vitest run`.
node ./node_modules/vitest/vitest.mjs run
#   → Test Files  261 passed | 6 skipped (267)
#   →      Tests  5294 passed | 19 skipped (5313)
#   Si NO da esto: PARÁ. Toda la evidencia de AC-5 se compara contra este número (CD-8).

# 3. Los 11 sitios existen y son consultas, no comentarios (antídoto de la Trampa B)
sed -n '293p'      src/services/receipt.ts
sed -n '549p;715p' src/services/agent.ts
sed -n '234p;278p' src/services/llm/transform.ts
sed -n '384p'      src/routes/payments.ts
sed -n '163p;190p;219p' src/services/spend-policy.ts
sed -n '316p;338p' src/services/inbound-task.ts
#   Las 11 tienen que empezar con `.eq('owner_ref'` o `.eq('owner_ref',`. Ninguna es comentario.

# 4. Los exemplars existen
wc -l src/services/task.ownership.test.ts   # → 359
wc -l test/test-files-are-run-in-ci.test.ts # → 411
wc -l src/routes/agents.ownership.test.ts   # → 294

# 5. El control negativo del instrumento: la suite PUEDE ponerse roja
sed -n '102p' src/services/task.ts          # → .eq('owner_ref', ownerRef)
sed -i '102d' src/services/task.ts
git diff --stat                             # → 1 file changed, 1 deletion(-)
node ./node_modules/vitest/vitest.mjs run   # → 2 failed  ⟹ KILLED
git checkout -- src/services/task.ts
git status --short                          # → limpio otra vez
#   Sin este paso, un "SURVIVED" es indistinguible de "la suite no corrió".

# 6. Reproducir el hallazgo que origina la HU
sed -n '293p' src/services/receipt.ts       # → .eq('owner_ref', ownerRef)
sed -i '293d' src/services/receipt.ts
node ./node_modules/vitest/vitest.mjs run   # → = baseline exacto ⟹ SURVIVED
git checkout -- src/services/receipt.ts
```

Los pasos 5 y 6 no son ceremonia: son la **primera fila** de tu `mutation-log.md`.

---

## 5. Archivos — crear y modificar

| # | Archivo | Acción | Wave | Qué |
|---|---|---|---|---|
| 1 | `test/ownership-filter-guard.scanner.ts` | Crear | W0 | `deriveOwnerTables(src)` + `scanSource(src, tables)`, **funciones puras** |
| 2 | `src/services/__tests__/owner-scoped-fake.ts` | Crear | W0 | el falso PostgREST de dos dueños (§8.W0.2). **`__tests__`, NO `__fixtures__`** (H-9) |
| 3 | `test/ownership-filter-guard.exceptions.ts` | Crear | W0 | ~41 entradas, **escritas a mano** (CD-10) |
| 4 | `doc/sdd/220-…/censo-owner-ref.md` | Crear | W0 | **AC-6**: las 55 cadenas clasificadas |
| 5 | `test/ownership-filter-guard.test.ts` | Crear | W1 | **AC-1**: el guardián + G-01..G-10 + el header con los 7 agujeros |
| 6 | `src/services/receipt.ownership.test.ts` | Crear | W2 | R-01, R-02 |
| 7 | `src/services/agent.ownership.test.ts` | Crear | W2/W3 | AG-01 (W2), AG-02 (W3) |
| 8 | `src/services/llm/transform.ownership.test.ts` | Crear | W2 | TR-01, TR-02, TR-03 |
| 9 | `src/routes/payments.dispute-ownership.test.ts` | Crear | W2 | PD-01, PD-02 |
| 10 | `src/services/spend-policy.ownership.test.ts` | Crear | W3 | SP-01..03 |
| 11 | `src/services/inbound-task.ownership.test.ts` | Crear | W3 | IT-01, IT-02 |
| 12 | `src/routes/agents.ownership.test.ts` | **Modificar — SÓLO comentarios** | W3 | §9 |
| 13 | `src/services/inbound-task.test.ts` | **Modificar — SÓLO comentarios** | W3 | §9 |
| 14 | `scripts/eq-sweep.mjs` | Crear | W4 | el barrido versionado, `--all` / `--paths` |
| 15 | `doc/sdd/220-…/mutation-log.md` | Crear | W4 | **AC-5**: una fila por línea mutada |
| 16 | `CLAUDE.md` (§"Tablas con ownership", `:198-205`) | Modificar | W4 | §8.W4.3 |
| 17 | `doc/sdd/220-…/_INDEX-row.md` | Modificar | W4 | la fila para `_INDEX.md`, staged |

**Nada más. Si necesitás tocar un archivo que no está acá → PARÁ y escalá.**
En particular: **cero líneas de producción bajo `src/` que no sean `*.test.ts`** (CD-1, AC-7).
El control es `git diff --stat` sobre `src/**/*.ts` no-test: tiene que estar **vacío**.

---

## 6. Los 11 sitios — verificados uno por uno en `ef384b7`

Leí las 11 líneas. Ninguna es un comentario. Este es el input canónico de la mutación (§10).

### Grupo A — aislamiento real entre inquilinos (5 sitios). Un fixture de dos dueños los mata.

| Sitio | Línea exacta | El identificador viene de | Qué sale si borrás la línea |
|---|---|---|---|
| `src/services/receipt.ts:293` | `.eq('owner_ref', ownerRef)` | `req.params.id` (`src/routes/receipts.ts:78-80`) | el recibo de B por la API de A |
| `src/services/agent.ts:549` | `.eq('owner_ref', ownerRef)` | nada, es un listado: `publishedAgentService.listMine(keyRow.owner_ref)` en `src/routes/agents.ts:487` | los agentes de B en la lista de A |
| `src/services/llm/transform.ts:234` | `.eq('owner_ref', ownerId)` | la clave de caché `(source, target, schema_hash)`, **ortogonal al dueño** | **la función de transformación de B, que después se EJECUTA sobre datos de A.** El de mayor consecuencia de los 11 |
| `src/services/llm/transform.ts:278` | `.eq('owner_ref', ownerId)` | ídem | el `hit_count` de la fila de B (fire-and-forget) |
| `src/routes/payments.ts:384` | `.eq('owner_ref', callerKey.owner_ref)` | `req.params.id` | la arbitración de B **con `settle_usd` y `at_stake_usd` en el cuerpo** |

Firmas verificadas:
- `receiptService.getById(id: string, ownerRef: string)` — `src/services/receipt.ts:286`. **Ojo
  al orden: id primero.**
- `agentService.listMine(ownerRef: string)` — `src/services/agent.ts:545`.
- Ruta del dispute: `fastify.get('/session/:id/dispute', …)` — `src/routes/payments.ts:364-365`.
  Auth vía `resolveCallerKey` importado de `./auth/parsers.js` (`src/routes/payments.ts:31`),
  usado en `:373`.

### Grupo B — defensa en profundidad detrás de un pre-chequeo en JS (1 sitio)

| Sitio | Línea | Por qué no muere con un cross-tenant simple |
|---|---|---|
| `src/services/agent.ts:715` | `.eq('owner_ref', ownerRef)` | `agent.ts:701` (`if (existing.owner_ref !== ownerRef)`) lanza antes |

Firma: `agentService.delete(slug: string, ownerRef: string): Promise<boolean>` — `src/services/agent.ts:691`.
Hace `this.getRow(slug)` **sin filtro de dueño** (`:692`), compara en JS (`:701`), y recién
después el DELETE (`:712-716`). Ver H-6 para la forma de la aserción.

### Grupo C — redundante con el alcance por `key_id` del caller (3 sitios). **NO son aislamiento.**

| Sitio | Función | Línea |
|---|---|---|
| `src/services/spend-policy.ts:163` | `list(keyId, ownerId)` | `.eq('owner_ref', ownerId)` |
| `src/services/spend-policy.ts:190` | `delete(keyId, ownerId, destination)` | `.eq('owner_ref', ownerId)` |
| `src/services/spend-policy.ts:219` | `hasAnyPolicy(keyId, ownerId)` | `.eq('owner_ref', ownerId)` |

Ver H-5. **La declaración de que esto es integridad y no aislamiento es obligatoria** en el header
del archivo de test y en el log de mutación.

### Grupo D — ligadura de fila y código sin llamador de producción (2 sitios)

| Sitio | Función | Línea | El hecho medido |
|---|---|---|---|
| `src/services/inbound-task.ts:316` | `get(ownerRef, id)` | `.eq('owner_ref', ownerRef)` | **no tiene ningún llamador de producción.** `grep -rn 'inboundTaskService' src/` da un solo call-site fuera de tests: `src/routes/inbound.ts:89`, que llama `ingest`. Se prueba a nivel de servicio y se declara que la única superficie que lo ejercita es el test |
| `src/services/inbound-task.ts:338` | `getByExternalRef(ownerRef, source, externalRef)` | `.eq('owner_ref', ownerRef)` | el `ownerRef` sale de `keyRow.owner_ref` server-side. Es la primera pata de la clave de dedup `(owner_ref, source, external_ref)`: sin él, el `external_ref` de un dueño dedupea contra el de otro. **Es idempotencia, no aislamiento** |

**5 + 1 + 3 + 2 = 11.** ✓

---

## 7. Exemplars — verificados, existen, los leí

### E-1 · `src/services/task.ownership.test.ts` (359 líneas) — **el exemplar madre**

Es de dónde sale todo lo de W0.2, W2 y W3.

| Fragmento | Qué copiar |
|---|---|
| `:1-46` | el header: qué hueco cierra, y el argumento **propiedad vs. espía de llamada** |
| `:91-225` | el falso PostgREST completo — tabla en memoria, `Builder`, shapes de PostgREST |
| `:139-144` | `applyFilters`: *«Aplica EXACTAMENTE los filtros pedidos. Ni uno más.»* ← **el corazón** |
| `:146-150` | `NO_ROWS` con `code: 'PGRST116'`, el shape real cuando `single()` no matchea |
| `:128-133` + `:170-176` | el hook `onUpdateStart`, que corre **dentro** del `update()` del falso |
| `:243-252` | T-OWN-01: A pide por id lo de B → `undefined`, **y se afirma que el id EXISTE en la tabla** |
| `:254-264` | T-OWN-02: **las dos direcciones** — `expect(ids).toEqual([TASK_A])` **y** `.not.toContain(TASK_B)` |
| `:266-283` | la **honestidad escrita** sobre por qué el cross-tenant simple no alcanza y sobre que la carrera no es alcanzable hoy |
| `:285-317` | **la receta del entrelazado** (T-OWN-03/04) para AC-3 |
| `:323-331` | T-OWN-05: el insert **estampa** el dueño |
| `:333-358` | T-OWN-06: el **backstop estructural en UN solo test**, mapeando a `'select:scoped'` / `'UNSCOPED'` |

**La trampa que el exemplar declara en `:35-41` y que vos NO podés repetir**: el falso **no filtra
por dueño de oficio**. Si le hardcodeás "devolvé sólo las filas del dueño", el test pasa igual sin
el filtro en el servicio y volvés al punto de partida. → **CD-2**.

### E-1b · `src/services/identity.require-signature.ownership.test.ts` (316 líneas) — **el segundo, y tiene algo que el primero no**

**El SDD no lo menciona. Lo encontré yo en F2.5.** Es una segunda implementación independiente
del mismo falso, hecha para `identityService`, y confirma qué vale la pena extraer al módulo
compartido. Su header (`:40-60`) reproduce el mismo argumento propiedad-vs-espía y nombra el
anti-patrón (`identity.test.ts:29`, `eq: vi.fn().mockReturnThis()`).

| Fragmento | Qué copiar |
|---|---|
| `:148-153` | `applyFilters` — idéntico a `task.ownership.test.ts:139-144`. **Que dos implementaciones independientes hayan convergido en la misma función es la señal de qué extraer** |
| `:155-157` | **`unknownColumn(filters)`** — algo que `task.ownership.test.ts` NO tiene |

**`unknownColumn` es la mejora que el falso compartido tiene que heredar.** El falso **falla
ruidoso** ante un filtro sobre una columna inexistente (emitiendo el `42703` de Postgres), en vez
de degradar a "no matcheó nada". Sin eso, un `.eq('ownerRef', …)` en camelCase se lee como
"no encontró la fila" y **el test cross-tenant pasa por la razón equivocada**. Con eso, el test
que afirma que A ve lo suyo explota con un error que se entiende.

**Metelo en `owner-scoped-fake.ts` (W0.2).** Es el equivalente de G-07 a nivel de fixture.

### E-2 · `test/test-files-are-run-in-ci.test.ts` (411 líneas) — **el exemplar del guardián**

| Fragmento | Qué copiar |
|---|---|
| `:1-53` | el header: el bug medido que cierra, **cómo decide**, y la sección **«QUÉ NO CUBRE (declarado, no arreglado)»** con 5 ítems |
| `:20-26` | el aviso escrito: *«un guardián que nace rojo se termina exceptuando»*. Por eso el tuyo nace **verde con ~41 excepciones** |
| `:38-39` | *«Si no puede traducir un runner, NO adivina: se pone rojo»* ← la regla para los `.from()` no resolubles |
| `:203-274` | el escáner como **función pura del texto** (`discoverRunnersFrom(yaml, wf)`), para poder testearlo con fixtures |
| `:304-322` | el **control de armado**: *«si no, el de abajo es vacuo»* — listas no vacías + umbrales mínimos |
| `:323-338` | el test ★ principal, con mensaje de error que **nombra los hallazgos y dice cómo arreglarlos, NO cómo exceptuarlos** |
| `:340-360` | *«el matcher no es vacuo: reconoce lo cubierto y rechaza lo que no»* — 3 positivos y 3 negativos |

### E-3 · `src/routes/agents.ownership.test.ts:11-77` — montaje de ruta real

Sirve **sólo el patrón de montaje** para PD-01/PD-02: `Fastify()` + registrar la ruta real +
mockear el middleware de auth + `app.inject`. **Su mock de supabase NO se copia** (H-7).

### Anti-patrones nombrados — que nadie los copie

| Archivo:línea | Qué está mal |
|---|---|
| `src/routes/agents.ownership.test.ts:48-54` | registra los `.eq()` y devuelve `state.row` sin filtrar |
| `src/services/inbound-task.test.ts:94-106` | `eq` guarda en `ctx.eqs`; `maybeSingle` devuelve `getSingle` sin filtrar |
| `src/services/fee-split.test.ts:67-73` | `chain.eq = () => chain`; la respuesta la decide `selectQ.shift()` |
| `src/services/registry.ownership.test.ts:84` | `eq: vi.fn().mockReturnThis()` — ignora columna y valor |
| `src/services/security/ownership.test.ts:30` | `eq: vi.fn().mockReturnThis()` — ídem |
| `src/services/identity.test.ts:29` | `eq: vi.fn().mockReturnThis()` — el que su propio sucesor nombra por escrito |

**Todos tiran columna y valor.** Es el patrón que hace que 23 filtros hayan quedado sin medir.

### El mapa completo de archivos `*ownership*` que ya existen — para que no te sorprendan

Los busqué. Son **seis**, con tres garantías distintas:

| Archivo | Qué es | ¿Aplica los filtros? |
|---|---|---|
| `src/services/task.ownership.test.ts` | **exemplar E-1** | **SÍ** (`applyFilters`, `:139-144`) |
| `src/services/identity.require-signature.ownership.test.ts` | **exemplar E-1b** | **SÍ** (`applyFilters` `:148-153` + `unknownColumn` `:155-157`) |
| `src/routes/agents.ownership.test.ts` | anti-patrón · §9.1 | **NO** (`:53-54`) |
| `src/services/registry.ownership.test.ts` | anti-patrón | **NO** (`:84`) |
| `src/services/security/ownership.test.ts` | anti-patrón | **NO** (`:30`) |
| `src/routes/registries.ownership.test.ts` | **otro nivel**: mockea el *service* (`:36`), no supabase. Prueba autorización de ruta, no filtros de consulta | N/A |

Los tres anti-patrones **NO se arreglan en esta HU** (CD-15: ninguno de sus sitios está entre los
11 de este corte). Sólo `agents.ownership.test.ts` recibe una declaración escrita (§9.1), porque
es el único que colisiona directamente con un archivo nuevo de esta HU.

---

## 8. Waves

**W0 es serial y bloquea todo.** Sin la lista de excepciones el guardián de W1 no puede nacer
verde, y sin el falso los tests de W2/W3 se copian y pegan cinco veces.

**CD-12 · el orden por wave**: `editar → tsc → test → lint → commit`. Para archivos de `test/`,
`tsc` y `lint` no miran nada (H-8): usá el tsconfig ad-hoc de H-8 una vez por wave.

---

### Wave 0 — serial · el instrumento y la medición

#### W0.1 — El escáner, como función pura

**Archivo**: `test/ownership-filter-guard.scanner.ts` (nuevo)
**Exemplar**: `test/test-files-are-run-in-ci.test.ts:203-274`

Dos funciones exportadas, **puras sobre texto**:

```
deriveOwnerTables(typesSrc: string): Set<string>
scanSource(src: string, ownerTables: Set<string>, filePath: string): Chain[]
```

**Por qué puras**: si el escáner sólo se pudiera invocar sobre el árbol real, sus propios tests
serían «lo que el escáner encuentra hoy» — que es exactamente la trampa CD-10 (un guardián que
se compara consigo mismo y aplaude cualquier cosa).

**`deriveOwnerTables` — el formato real de `src/types/database.types.ts`**, verificado:

| Elemento | Indentación | Ejemplo |
|---|---|---|
| `Tables: {` | 4 espacios | `database.types.ts:16` |
| `<tabla>: {` | 6 espacios | |
| `Row: {` | 8 espacios | |
| columna | 10 espacios | `          owner_ref: string;` |
| `Views: {` a 4 espacios | **cierra el bloque `Tables`** | `database.types.ts:2851` |

Criterio: la tabla entra si su bloque `Row` declara una columna llamada `owner_ref` (con o sin
`?`, cualquiera sea el tipo — `kite_schema_transforms` es `string | null` y **cuenta**).
Contra el árbol real esto tiene que dar **62 tablas totales / 21 con dueño** (H-2).

**`scanSource` — cinco reglas, cada una cerrando un modo de falla medido:**

1. **Filtrar por RECEPTOR, no por el nombre del método.** Se escanea `supabase.from(` — no
   `.from(` a secas. **Medido por mí en `src/` no-test: 159 `.from(` en total, de los cuales
   123 son `supabase.from(` y 36 son otros receptores** (`Buffer.from`, `Array.from`,
   `Uint8Array.from`, `Transaction.from`). *(El SDD dice 33; yo medí 36. Usá tu propia medición y
   anotá la diferencia.)* Sin este filtro, la
   lista de "no pude resolver el argumento" nace con decenas de entradas de ruido y el guardián se
   vuelve inservible. Con él, nace en **0**. → **CD-13**.
2. **Resolver constantes de módulo.** `fee-split.ts` no escribe `.from('a2a_fee_splits')`: escribe
   `.from(SPLITS_TABLE)`, con `const SPLITS_TABLE = 'a2a_fee_splits'` en
   **`src/services/fee-split.ts:37`** (verificado). Un escáner que sólo acepte literales **deja
   fuera al archivo con más sitios de todo el hallazgo y no se entera**. → **CD-13**.

   > ⚠️ **Corrección a lo que dice el SDD §4.1 punto 1.** El SDD suma a `fee-charge.ts:109` como
   > segundo caso. Lo verifiqué y ahí la constante es **`const FEES_TABLE = 'a2a_protocol_fees'`**
   > — y `a2a_protocol_fees` **no tiene `owner_ref`** y está explícitamente fuera de alcance. O sea
   > que resolver esa constante sirve para **excluirla bien**, no para incluirla. La única
   > constante que suma cadenas al censo es `SPLITS_TABLE`.
3. **Seguir la CADENA, no la línea.** Las cadenas cruzan líneas y terminan de formas distintas
   (`.single()`, `.maybeSingle()`, `await`, un `) as { … }` que cierra un paréntesis envolvente
   como en `fee-split.ts:538`). Consumí `.metodo(args)` **balanceando paréntesis**, saltando
   comentarios y strings, y pará cuando el siguiente token no es un `.`.
4. **`insert` / `upsert` quedan FUERA del alcance del guardián.** Un INSERT no filtra, estampa. Y
   la regla alternativa ("que `owner_ref` aparezca en el payload") **no sirve**: de los 14
   insert/upsert sobre tablas con dueño, **9 darían falso positivo** porque el payload es una
   variable armada antes — p. ej. `src/services/task.ts:74` arma
   `const row: Partial<TaskRow> = { owner_ref: ownerRef }` y `:81` inserta `row`; y ese estampado
   **sí está probado**, por `task.ownership.test.ts:323-331`. Un guardián que nace con 9 rojos
   falsos se termina exceptuando entero (`test-files-are-run-in-ci.test.ts:20-26`). **Se declara
   como limitación, no se arregla.**
5. **Si no podés resolver el argumento de `.from()`, NO adivines: eso va a una lista de "no puedo
   traducir" que pone el test en ROJO** (`test-files-are-run-in-ci.test.ts:38-39`). Hoy esa lista
   nace en 0; si crece, alguien introdujo una forma nueva y hay que mirarla.

**Filtros que cuentan como "acota por dueño"**: `.eq('owner_ref', …)`, `.in('owner_ref', …)`,
`.match({ owner_ref: … })`. El nombre de la columna se compara **exacto**: `'ownerRef'` en
camelCase **NO** cuenta (G-07). Cualquier otra forma de acotar (`.or`, `.filter`) cae en la lista
de excepciones con su motivo.

**Punto ciego conocido y NO arreglado — las cadenas partidas en una variable.** El patrón
`let q = supabase.from(...); if (cond) q = q.eq(...)` aparece en 11 sitios:
`src/services/discovery.ts:442,449,454,460,468,477,535`, `src/services/task.ts:131,134`,
`src/routes/mock-registry.ts:74,83`. El escáner ve el `.from(...)` y **no** ve el `.eq()` que
viene después en otra sentencia. **El modo de falla apunta al lado ruidoso**: `taskService.list`
le va a parecer sin filtro al guardián aunque lo tenga, o sea falso positivo → excepción con
motivo, no falso negativo silencioso. Va declarado en el header (§8.W1).

**Criterio de salida de W0.1**: `deriveOwnerTables` sobre `src/types/database.types.ts` devuelve
21; `scanSource` sobre todo `src/` no-test devuelve **101** cadenas sobre tablas con dueño, con
**0** argumentos no resolubles.

#### W0.2 — El falso compartido

**Archivo**: `src/services/__tests__/owner-scoped-fake.ts` (nuevo)
**⚠️ `__tests__`, NO `__fixtures__`** — H-9: `__fixtures__` se compila al build de producción.
**Exemplars**: `src/services/task.ownership.test.ts:91-225` (E-1) **y**
`src/services/identity.require-signature.ownership.test.ts:140-215` (E-1b), extraídos a un módulo
reusable. Son dos implementaciones independientes del mismo falso; **lo que ambas tienen es lo que
se extrae**, y lo que sólo tiene una hay que decidirlo caso por caso.

Lo que se extrae tal cual: la tabla en memoria, `applyFilters` (`task…:139-144` ≡
`identity…:148-153`), los shapes de PostgREST (`single` / `maybeSingle` / thenable, con `PGRST116`
en `task…:146-150`), el registro de queries para el backstop estructural, y el hook de entrelazado.

**Lo que sólo tiene E-1b y hay que heredar: `unknownColumn`** (`identity…:155-157`) — el falso
**falla ruidoso** (`42703`, como Postgres) ante un filtro sobre una columna que no existe, en vez
de degradar a "no matcheó nada". Sin eso, un `.eq('ownerRef', …)` mal escrito se lee como "no
encontró la fila" y el test cross-tenant **pasa por la razón equivocada**.

**Extras que este corte necesita y el exemplar no tiene:**

| Extra | Lo pide |
|---|---|
| `delete()` | `agent.ts:715`, `spend-policy.ts:190` |
| `upsert()` | cadenas de `insert-estampa` que quieras cubrir |
| `not()` / `in()` / `limit()` | para que las cadenas reales no exploten (`spend-policy.ts:219` usa `.limit(1)`) |
| `order()` | `agent.ts:550`, `spend-policy.ts:164` |
| `.select()` **después** de `delete()` | `agent.ts:716` es `.delete().eq().eq().select()` |
| soporte de **varias tablas a la vez** | `agent.ts` y los montajes de ruta tocan más de una |
| hook **`onDeleteStart`**, no sólo `onUpdateStart` | `agentService.delete` no hace UPDATE (H-6) |

**Lo que NO se parametriza (CD-2)**: "si filtra por dueño". El falso **nunca** filtra de oficio;
aplica exactamente los `.eq(col, val)` que el servicio le pide, sobre la tabla en memoria.

**Criterio de salida de W0.2**: importa desde un test tonto y funciona; `git diff` no toca ningún
`.ts` de producción; y confirmás con `node ./node_modules/typescript/bin/tsc -p
tsconfig.build.json --noEmit --listFiles` que el archivo **NO** aparece en la salida.

#### W0.3 — El censo (AC-6). **El corazón de la HU.**

**Archivo**: `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/censo-owner-ref.md` (nuevo)

Corré tu escáner sobre todo `src/` no-test y clasificá **las 55 cadenas sin filtro, una por una**.
Una fila por cadena, con: `archivo:línea` · tabla · verbo · categoría · motivo escrito a mano · y
—cuando el motivo ya está en el código— el `archivo:línea` del docblock que lo dice.

**Categorías: unión CERRADA.** Cada entrada va en **exactamente una**. Salen de leer los sitios,
no de inventarlas:

| Categoría | Qué significa | Ejemplo verificado |
|---|---|---|
| `idor-vivo` | el caller elige el identificador y no hay chequeo de dueño **en ningún lado** | **0 hasta ahora.** Si aparece uno → **CD-14: PARÁ Y ESCALÁ** |
| `insert-estampa` | INSERT/UPSERT: no filtra, sella el dueño | `task.ts:81`, `identity.ts:75` (14 sitios) |
| `auth-por-hash` | la consulta **decide quién sos**; todavía no hay dueño contra el cual filtrar | `identity.ts:93` (`key_hash`), `delegation.ts:271`, `key-session.ts:266`, `agent-link.ts:243` |
| `alcance-por-fila-del-caller` | filtra por una columna cuyo valor **sale de la fila que el caller ya autenticó**, no del request. Es alcance por dueño aunque no diga `owner_ref` | `key-session.ts:286`, `delegation.ts:293`, `agent-link.ts:265` — los tres con el motivo ya escrito en su docblock; `delegation.ts:288` dice literalmente *«NOTA PARA AR-CR: no es IDOR (key_id proviene del row de la delegación)»* |
| `catalogo-publico` | la tabla se sirve a cualquiera **por diseño** | `agent.ts:318,343,454,494,527` (`a2a_agents` con `enabled=true`); `registry.ts:174,211,464` (docblock *«List all registries (público)»*, `:165`) |
| `admin-cross-tenant` | lectura global detrás de un gate de admin | `trace.ts:403,523`, `event.ts:120,128`, tras `requireAdminTokenForTrace` / `requireAdminToken` (`src/routes/dashboard.ts:390`, `:424`). El docblock del gate dice *«una lectura cross-tenant NUEVA sí nace fail-closed»* (`dashboard.ts:148-149`) |
| `worker-sin-caller` | barrido de fondo; no hay caller cuyo dueño usar | `payment-intent.ts:1635,1653,1667,1682`, `reconciliation.ts:614,655,1349`, `refund-outbox.ts:223,259` |
| `ligadura-de-fila` | compare-and-set o idempotencia sobre un id derivado del servidor | `reconciliation.ts:1129`, `receipt.ts:192` (`inserted.id`), `fee-split.ts:645` |
| `chequeo-en-js` | se lee sin filtro **a propósito**, y el dueño se compara después en JavaScript | `arbiter.ts:594`, con su comentario en `:591-592` (*«Owner-check en app (no owner-guarded SELECT) para preservar `OWNERSHIP_MISMATCH` vs `INTENT_NOT_FOUND`»*) y el chequeo real en `:606-608` |
| `punto-ciego-del-escaner` | falso positivo conocido por cadena partida en variable | `task.ts` vía `:131,134` |

> **`chequeo-en-js` es la categoría que hace que el censo no sea burocracia.** Si el guardián
> exigiera `.eq('owner_ref', …)` sin excepciones, "arreglar" `arbiter.ts:594` sería una regresión
> de comportamiento: se pierde la distinción 403/404 que el código eligió a propósito.

**La clasificación preliminar del SDD es un punto de partida, no un resultado.** El arquitecto
verificó con `Read` unas ~15 de las 55; las otras ~40 salieron de la salida del escáner sin leer
el código. **Vos verificás las 55.**

**Criterio de salida de W0.3 (CD-11 — el censo cierra por construcción, no por grep):**

```
cadenas totales sobre tablas con dueño = con-dueño + sin-dueño          (101 = 46 + 55)
sin-dueño = Σ de todas las categorías                                    (55)
argumentos .from() no resolubles = 0
entradas idor-vivo = 0     ← si no, CD-14: PARÁ Y ESCALÁ
```

Si tu total no es 101/46/55 → **eso es el hallazgo**. Escribilo, explicá la diferencia contra la
medición del SDD y contra la mía, y recién después decidí cuál instrumento está bien.

#### W0.4 — La lista de excepciones

**Archivo**: `test/ownership-filter-guard.exceptions.ts` (nuevo)

Entradas `{ file, line, table, verb, category, reason }`. **Nacen ~41** (las 55 sin dueño menos
las 14 de `insert`/`upsert`, que quedan fuera del alcance del guardián). Medido por mí en F2.5:
`select` sin dueño 37 + `update` sin dueño 4 = **41**, `delete` sin dueño 0.

**⛔ CD-10 — PROHIBIDO generar esta lista volcando la salida del escáner.** Es exactamente como
este guardián se vuelve vacuo: una lista derivada de la misma medición que consume lo deja verde
**por construcción** y no mide nada. Es el bug `T-U7` de WKH-322, donde un test iteraba la
allowlist exportada para afirmar que "todas están permitidas".

**La escribís a mano, una entrada por vez, leyendo el sitio.** Sí podés usar la salida del escáner
como **checklist de qué mirar** — lo que está prohibido es que el `category` y el `reason` salgan
de un `console.log`.

Tres reglas de diseño, cada una cerrando un modo de falla:

| Regla | Sin ella |
|---|---|
| Una excepción cuyo sitio **ya no existe** pone el test en **ROJO** | la lista se pudre y el guardián va perdiendo alcance sin avisar |
| El `reason` **no puede estar vacío**, validado en **RUNTIME** (H-8: `test/` no lo typechequea CI) | entra una excepción sin motivo y nadie se entera |
| La `category` sale de la **unión cerrada** de W0.3, validada en **RUNTIME** por la misma razón | entra `category: 'porque-si'` y compila |

**Criterio de salida de W0.4**: el guardián de W1 corre y da **0 hallazgos no exceptuados**, con
~41 excepciones, todas con `reason` no vacío y `category` de la unión.

---

### Wave 1 — el guardián (AC-1)

**Archivo**: `test/ownership-filter-guard.test.ts` (nuevo)
**Exemplar**: `test/test-files-are-run-in-ci.test.ts`

Vive en `test/`, no en `scripts/`, porque `npm test` ya es paso obligatorio de CI
(`.github/workflows/ci.yml:43`, **sin `if:` ni `continue-on-error:`** — verificado) y ya hay dos
precedentes de guardián estructural que parsea el árbol (`test/test-files-are-run-in-ci.test.ts`,
`src/routes/charged-routes.meta.test.ts`).

**La regla**: para cada cadena `supabase.from(T)` con `T` ∈ tablas-con-dueño, cuyo verbo sea
`select`, `update` o `delete`, tiene que haber un filtro por `owner_ref` en la misma cadena **o**
una entrada en la lista de excepciones. El fallo nombra `archivo:línea`, tabla y verbo.

**El mensaje de error dice cómo ARREGLARLO, no cómo exceptuarlo** (patrón
`test-files-are-run-in-ci.test.ts:328-337`, que escribe *«NO exceptuarlos acá»*).

#### Los 10 controles. Cada uno con el input concreto que lo pone en ROJO.

| ID | Qué afirma | Input que lo pone en rojo |
|---|---|---|
| **G-01** | el conjunto derivado tiene **≥15** tablas y contiene `a2a_receipts` | romper el parser de `database.types.ts` → devuelve ∅ → el guardián no encontraría ninguna cadena y **pasaría afirmando cobertura total** |
| **G-02** | el árbol tiene **≥90** cadenas sobre tablas con dueño, y **0** argumentos no resolubles | un regex roto que matchee de menos |
| **G-03** | `scanSource` sobre un fixture **con** el filtro → **0** hallazgos | un escáner que reporte siempre |
| **G-04** | `scanSource` sobre un fixture **sin** el filtro → **1** hallazgo, con su número de línea | un escáner que no reporte nunca |
| **G-05** | `scanSource` sobre `.from(CONST)` con `const CONST = 'a2a_receipts'` → lo resuelve | volver a exigir literales (CD-13) |
| **G-06** | `scanSource` sobre `Buffer.from('a2a_receipts')` → **0** hallazgos | quitar el filtro de receptor `supabase` |
| **G-07** | `scanSource` sobre una cadena con `.eq('ownerRef', …)` en camelCase → **1** hallazgo | comparar el nombre de columna de forma laxa |
| **G-08** | ★ **cero** cadenas sin filtro y sin excepción en el árbol real, nombrando `archivo:línea` | agregar a cualquier service `supabase.from('a2a_receipts').select('*').eq('id', id).single()` — **este es el input literal de AC-1** |
| **G-09** | una excepción cuyo sitio ya no existe → **ROJO** | borrar una consulta del árbol y dejar su excepción |
| **G-10** | toda excepción tiene `category` de la unión cerrada y `reason` no vacío — **validado en runtime** | una excepción con `reason: ''` o `category: 'inventada'` |

**G-01 y G-02 son el control de armado** (`test-files-are-run-in-ci.test.ts:304-322`): sin ellos,
un parser roto deja las listas vacías y **G-08 pasa en verde sin verificar nada** — la falla
silenciosa de siempre, dentro del guardián que existe para cazar una falla silenciosa.

**G-03..G-07 son los fixtures en memoria**: son la razón por la que el escáner es una función pura
(W0.1). Sin ellos, el único test del escáner sería "lo que el escáner encuentra hoy" = CD-10.

#### El header del archivo — **los siete agujeros, declarados ahí, no sólo en el SDD**

Copiá la forma de `test/test-files-are-run-in-ci.test.ts:41-51` (*«QUÉ NO CUBRE (declarado, no
arreglado — medir antes de creerle a esta lista)»*). **El que abra este archivo dentro de seis
meses no va a abrir el SDD.**

1. **El VALOR que se le pasa al filtro.** `.eq('owner_ref', otroOwner)` pasa el guardián sin
   chistar. Sólo lo cazan los tests de propiedad de W2/W3.
2. **Las cadenas partidas en una variable** (11 sitios medidos: `discovery.ts:442,449,454,460,468,477,535`,
   `task.ts:131,134`, `mock-registry.ts:74,83`). El modo de falla es **falso positivo** (ruidoso),
   no falso negativo.
3. **`insert` / `upsert`** (14 sitios) están fuera del alcance. El estampado del dueño se prueba
   con el patrón `task.ownership.test.ts:323-331`, no acá.
4. **Que la fila TENGA dueño.** `kite_schema_transforms.owner_ref` es `string | null`
   (`database.types.ts:2303`): una fila con `NULL` es invisible para todos, y el guardián no opina.
5. **Los filtros que no son `.eq`/`.in`/`.match`** sobre `owner_ref` (`.or`, `.filter`). Caen en la
   lista de excepciones.
6. **Que la tabla exista de verdad en la base.** El conjunto sale del archivo de tipos **generado**;
   si está desactualizado respecto de la base, el guardián hereda ese desfase sin avisar.
7. **RLS.** No la mide ni la reemplaza: es WKH-SEC-02 (`CLAUDE.md:207-215`). Y mientras el cliente
   use `SUPABASE_SERVICE_KEY` (BYPASSRLS), **RLS no vuelve redundante ningún filtro de aplicación**.

**Y el octavo, que es del estado del corte, no del instrumento** — va en el header **y** en el
reporte de cierre: *entre el merge de SEC-03 y el de SEC-04, este guardián va a estar verde con
**12 sitios sin test de propiedad**. Dice «el filtro está», no «el filtro funciona».*

⛔ **CD-7 — PROHIBIDO escribir que el guardián «impide», «previene», «garantiza» o «asegura»
nada.** Cada afirmación va con el input concreto que la pone en rojo, y al lado el input que se le
escapa. La forma correcta está en la tabla de arriba.

**Criterio de salida de W1**: los 10 controles pasan; el guardián da 0 hallazgos no exceptuados;
y la mutación M-G3 de §10 (hacer que `deriveOwnerTables` devuelva `∅`) pone en rojo a **G-01** y
deja a **G-08 en verde** — si G-08 se pusiera rojo también, tu control de armado está mal armado.

---

### Wave 2 — tests de propiedad · los 5 sitios de aislamiento real (AC-2)

Los cuatro archivos son independientes entre sí. **Paralelizables** una vez cerrada W0.
Todos usan `src/services/__tests__/owner-scoped-fake.ts` y el patrón de `task.ownership.test.ts`.

**Regla común a los 4 (CD-6, anti-vacuidad): las dos direcciones en cada archivo.** A ve lo suyo
**Y** no ve lo de B (`task.ownership.test.ts:261-264`). Sin la primera dirección, un filtro con la
columna mal escrita —`.eq('ownerRef', …)`— pasaría el test cross-tenant perfectamente y dejaría al
dueño sin ver sus propias cosas.

**Regla común 2**: en el test cross-tenant, afirmá que **el id EXISTE en la tabla**
(`expect(db.some(r => r.id === X)).toBe(true)`, `task.ownership.test.ts:250`). Sin eso, un
`undefined` puede venir de que la fila nunca se insertó.

#### W2.1 — `src/services/receipt.ownership.test.ts`

| ID | Afirma | Se pone rojo si borrás |
|---|---|---|
| R-01 | A pide por id el recibo de B → `null`, **y el id existe en la tabla** | `src/services/receipt.ts:293` |
| R-02 | A pide **el suyo** → lo obtiene | (anti-vacuidad: si el falso filtrara de más) |

Firma: `receiptService.getById(id, ownerRef)` — **id primero** (`src/services/receipt.ts:286`).
La cadena real es `.from('a2a_receipts').select(<13 columnas>).eq('id', id).eq('owner_ref', ownerRef).single()`
y devuelve `PGRST116` cuando no matchea: usá el `NO_ROWS` del falso.

#### W2.2 — `src/services/agent.ownership.test.ts` (parte AG-01; AG-02 en W3)

| ID | Afirma | Se pone rojo si borrás |
|---|---|---|
| AG-01 | `listMine(A)` devuelve **exactamente** los slugs de A, y `.not.toContain` el de B | `src/services/agent.ts:549` |

Firma: `agentService.listMine(ownerRef)` (`src/services/agent.ts:545`). La cadena termina en
`.order('created_at', { ascending: true })` y se resuelve por thenable — el falso necesita `order()`.

#### W2.3 — `src/services/llm/transform.ownership.test.ts`

**⚠️ Tres gotchas que medí y que deciden si estos tests pueden ponerse rojos.**

**(a) `getFromL2` NO está exportado.** Los únicos exports de `src/services/llm/transform.ts` son
`_resetHmacWarn` (`:60`), `maybeTransform` (`:366`), `TransformExecutionError`/`TransformTimeoutError`
(`:522`) y `_clearL1Cache` (`:525`). **El punto de entrada de estos tests es `maybeTransform`.**

Firma verificada:
```
maybeTransform(sourceAgentId, targetAgentId, output, inputSchema, ownerId?)  → src/services/llm/transform.ts:366
```

**(b) La caché L1 puede tapar la consulta entera.** `maybeTransform:392-402` consulta L1 **antes**
de L2. Su clave ya incluye el dueño (`:390`: `${source}:${target}:${hash}:${ownerId ?? '__anon__'}`),
así que L1 no mezcla inquilinos — pero si L1 tiene la entrada, **la consulta a supabase nunca
ocurre** y el test pasa sin ejercitar el filtro. **`_clearL1Cache()` en `beforeEach`, obligatorio.**

**(c) El HMAC puede hacer que el test pase por la razón equivocada.** `getFromL2:245-264`: si
`process.env.SCHEMA_TRANSFORM_HMAC_KEY` está seteado, una fila sin `transform_fn_sig` válido se
trata como **miss** y devuelve `null`. O sea: TR-01 daría "A no obtuvo la función de B" **por la
firma, no por el filtro de dueño**. Controlá el env var explícitamente en el test (dejalo sin
setear, o seteálo y firmá el fixture con `signTransformFn` de `./transform-hmac.js`) y **decí en
el header cuál de los dos modos elegiste**.

> El chequeo HMAC verifica que **el servidor firmó** la función, **no** que sea del caller. El
> filtro de dueño es lo único que separa los espacios de caché de dos inquilinos.

| ID | Afirma | Se pone rojo si borrás |
|---|---|---|
| TR-01 | con la MISMA clave de caché `(source, target, schema_hash)` y dos dueños, A obtiene **su** función y **nunca** la de B | `src/services/llm/transform.ts:234` |
| TR-02 | el `hit_count` que sube es el de la fila de **A** | `src/services/llm/transform.ts:278` |
| TR-03 | una fila con `owner_ref = NULL` **no se le entrega a nadie** | tratar `NULL` como comodín (agujero #4 del header del guardián) |

TR-02: el UPDATE de `hit_count` es **fire-and-forget** (`void supabase…`, `transform.ts:268`).
No hay `await`: el test tiene que darle un tick al event loop antes de afirmar sobre la fila.

**Control de armado de este archivo**: un test que verifica que A **sí** obtiene su función por
L2 (`bridgeType: 'CACHE_L2'`). Si ese no pasa, tus fixtures no están llegando a L2 y TR-01/TR-02
están verdes por no ejecutarse.

#### W2.4 — `src/routes/payments.dispute-ownership.test.ts` (nivel HTTP)

**Exemplar de montaje**: `src/routes/agents.ownership.test.ts:11-77` (**el montaje sí, el mock de
supabase NO** — H-7). Mockeá `resolveCallerKey` de `./auth/parsers.js` (importado en
`src/routes/payments.ts:31`) y usá el falso de W0.2 para supabase.

Ruta: `GET /session/:id/dispute` (`src/routes/payments.ts:364-365`).

| ID | Afirma | Se pone rojo si borrás |
|---|---|---|
| PD-01 | con el id de B → **404**, y **el cuerpo no trae `settleUsd` ni `atStakeUsd`** | `src/routes/payments.ts:384` |
| PD-02 | con **su** id → 200 con el cuerpo | (anti-vacuidad) |

PD-01 afirma **dos cosas**: el status y la ausencia de los montos. El 404 solo no alcanza — la
consecuencia de este sitio es que se filtran cifras de dinero de otro inquilino.

**Criterio de salida de W2**: los 4 archivos verdes; `git diff --stat` sobre `src/**/*.ts` no-test
**vacío**; y las 5 mutaciones de W2 (§10, M-01..M-05) dan **KILLED** con el test nombrado.

---

### Wave 3 — entrelazado, defensa en profundidad, y las declaraciones (AC-3)

**Esta wave es donde se afirma de menos a propósito.** Los 6 sitios de acá **no** previenen un
IDOR alcanzable hoy. Escribirlo como si lo previnieran sería la misma prosa que esta HU existe
para sacar del repo.

#### W3.1 — `src/services/agent.ownership.test.ts` (completar con AG-02)

**Exemplar**: `src/services/task.ownership.test.ts:285-317`. Ver H-6 por las **dos** diferencias.

| ID | Afirma | Se pone rojo si borrás |
|---|---|---|
| AG-02 | la fila pasa a ser de B **entre el pre-chequeo y el DELETE** → `delete()` devuelve **`false`** y la fila de B **sigue en la tabla** | `src/services/agent.ts:715` |

Secuencia: `agentService.delete(slug, ownerRef)` (`:691`) → `this.getRow(slug)` (`:692`, **sin
filtro de dueño**) → pre-chequeo en JS (`:701`) → DELETE (`:711-716`) →
`return Array.isArray(data) && data.length > 0` (`:721`).
El hook `onDeleteStart` del falso cambia `row.owner_ref = OWNER_B` justo dentro de `.delete()`.

**Declaración obligatoria en el header** (patrón `task.ownership.test.ts:277-283`): *hoy ninguna
operación de este repo cambia el `owner_ref` de un agente, así que la carrera exacta que se simula
no es alcanzable en producción. Eso es lo que significa defensa en profundidad: el filtro está para
que la escritura siga acotada si mañana el read previo se refactoriza, se saltea, o devuelve un
dato viejo. Sin test, ese filtro es decoración: se puede borrar y la suite queda verde.*

#### W3.2 — `src/services/spend-policy.ownership.test.ts`

| ID | Afirma | Se pone rojo si borrás |
|---|---|---|
| SP-01 | `list(K, dueño(K))` no devuelve la fila con `key_id = K` / `owner_ref = B` | `src/services/spend-policy.ts:163` |
| SP-02 | `delete(K, dueño(K), dest)` no borra esa fila y lanza `OwnershipMismatchError` | `src/services/spend-policy.ts:190` |
| SP-03 | `hasAnyPolicy(K, dueño(K))` devuelve `false` si la única fila con `key_id = K` es de B | `src/services/spend-policy.ts:219` |

**Declaración obligatoria en el header — literal, no parafraseada:**

> Estos tres filtros **no previenen un IDOR**. Las tres rutas son `/keys/me/spend-policies`
> (`src/routes/auth/spend-policy.ts:79` es el `fastify.get`, `:106` el `fastify.delete`) y las tres
> pasan `callerKey.id` **y** `callerKey.owner_ref`, dos campos de la **misma fila autenticada**
> (`:94-95`, `:125-126`). No hay
> parámetro de ruta para la key: el caller no puede pasar un `keyId` ajeno. Como una `key_id`
> pertenece a exactamente un dueño, en una base **consistente** el filtro por `key_id` ya acota al
> dueño, y borrar `.eq('owner_ref', …)` **no cambia ninguna salida de ninguna ruta**.
> Lo que estos tests afirman es **integridad ante una fila inconsistente**: una fila con
> `key_id = K` pero `owner_ref ≠ dueño(K)` no se le entrega al dueño de K. Ese estado sólo existe
> si la base quedó inconsistente o si una key cambió de dueño.
> **El fixture es deliberadamente inconsistente. No es un escenario de ataque.**

`spendPolicyService.delete` lanza `OwnershipMismatchError` cuando el DELETE devuelve 0 filas
(`src/services/spend-policy.ts:198-205`) y llama a `logOwnershipMismatch` con
`op: 'spendPolicyDelete'`. `hasAnyPolicy` usa `.limit(1)` (`:220`).

#### W3.3 — `src/services/inbound-task.ownership.test.ts`

| ID | Afirma | Se pone rojo si borrás |
|---|---|---|
| IT-01 | `get(A, idDeB)` → `undefined`, **con el id presente en la tabla** | `src/services/inbound-task.ts:316` |
| IT-02 | dos dueños con el MISMO `(source, external_ref)` **no dedupean entre sí** | `src/services/inbound-task.ts:338` |

**Declaraciones obligatorias en el header:**

- `:316` (`get`) **no tiene ningún llamador de producción.** `grep -rn 'inboundTaskService' src/`
  da un solo call-site fuera de tests: `src/routes/inbound.ts:89`, que llama `ingest`. Dentro del
  propio archivo, `get` no se auto-llama. **La única superficie que ejercita este filtro es este
  test.**
- `:338` (`getByExternalRef`) recibe un `ownerRef` derivado server-side de `keyRow.owner_ref`
  (`src/services/inbound-task.ts:425`). El caller **no lo elige**. Su filtro es la primera pata de
  la clave de dedup `(owner_ref, source, external_ref)`. **Es una aserción de idempotencia, no de
  aislamiento.**

#### W3.4 — Las declaraciones sobre los tests preexistentes que afirman de más

Ver **§9**. Sólo comentarios, cero cambios de lógica.

**Criterio de salida de W3**: los 3 archivos verdes; las 6 mutaciones (M-06..M-11) dan KILLED con
su nota de escenario; y las declaraciones de §9 están escritas.

---

### Wave 4 — evidencia y doctrina

#### W4.1 — `scripts/eq-sweep.mjs` (nuevo)

El barrido de mutación, versionado, con dos modos: `--all` y `--paths <glob>`. Aplica el
protocolo de §10 (línea por línea, mostrando el texto borrado).

**Costos medidos**, para que quede escrito por qué esto no entra a CI: la suite tarda **~10 s**
de pared. El barrido completo son ~87 líneas × ~15 s ≈ **22 min**. El acotado a las 11 líneas de
este corte ≈ **3 min**.

**La decisión de DT-4 no cambia, pero el motivo sí**: el barrido **no** entra como control de cada
PR porque un control que tarda 22 min compite con el ciclo de trabajo y se termina desactivando,
**no** porque «el orden de magnitud lo descarte» (ese argumento del work-item nunca se midió y es
falso). El control de PR sigue siendo AC-1, que es estático y corre en ~nada.

**Nota de honestidad que va en el header del guion**: que sea barato de correr no lo convierte en
un control que alguien vaya a mirar. Es una herramienta de quien cierra una HU de seguridad, no
un guardián.

#### W4.2 — `doc/sdd/220-…/mutation-log.md` (nuevo) — **AC-5**

Una fila por línea mutada. **16 filas**: 11 de producción + 5 del guardián. Ver §10 para el
protocolo y las columnas obligatorias.

#### W4.3 — `CLAUDE.md` §"Tablas con ownership en app-layer (hoy)" (`:198-205`)

Hoy la sección es una tabla de **4 filas** escrita a mano. Dos de esas cuatro son medibles y
falsas o incompletas hoy:

| Fila actual | Lo medido |
|---|---|
| `registries` \| — (admin global) \| N/A | **tiene `owner_ref: string`** (`database.types.ts:2567`). El acceso es público por diseño (`registry.ts:165`), pero la columna existe |
| (sólo 4 tablas listadas) | **21** tablas declaran `owner_ref` |
| `a2a_agent_keys` \| SI (WKH-53) | la columna está; el guard app-layer de `reconciliation.ts:1448` **no lo prueba ningún test** |
| `a2a_events` \| — \| N/A | correcto (no tiene `owner_ref`) |

**El cambio**: reemplazar la tabla enumerada a mano por
(a) **el criterio**: *«toda tabla cuyo `Row` declare `owner_ref` en `src/types/database.types.ts`;
    hoy son 21»*;
(b) un puntero a `test/ownership-filter-guard.test.ts` como la **fuente mecánica**;
(c) un puntero a `test/ownership-filter-guard.exceptions.ts` como el lugar donde vive el motivo de
    cada omisión;
(d) la frase que falta y que es la que se violó 23 veces: **el guardián verifica PRESENCIA, no
    VALOR** — un filtro presente con el valor equivocado pasa, y eso lo cubren los
    `*.ownership.test.ts`.

⛔ **El número 21 NO se escribe como una lista de nombres.** Sería la misma lista a mano que
envejeció, con otra ropa.

#### W4.4 — `doc/sdd/220-…/_INDEX-row.md`

Actualizá la fila (ya existe el archivo) y dejala **staged**, sin editar `doc/sdd/_INDEX.md`
directamente. Es la convención de las HUs 212/214/217 y evita el conflicto de merge con las HUs en
vuelo.

---

## 9. Decisión sobre los tests preexistentes que afirman de más

El work-item no lo menciona. El SDD encontró uno. **Yo encontré tres.** Los tres tienen el mismo
mock roto y los tres se leen como si midieran aislamiento.

### 9.1 · `src/routes/agents.ownership.test.ts` — **NO se toca el mock. Se declara su límite.**

Las tres opciones eran: arreglar el mock, reemplazar el archivo, o dejarlo declarando su límite.

**La decisión es la tercera, y estas son las razones medidas:**

- Arreglar el mock cambia el contrato de `state.eqCalls` y `state.row`, del que dependen los
  **4 tests preexistentes** del archivo (`T-PUB-08` `:116`, `T-PUB-09` `:138`, `T-143B-06` `:161`,
  y el resto del `describe` de `:92`). Esta HU no está para reescribir tests ajenos con la excusa
  de rozarlos.
- `T-143B-06` (`:161`) **depende deliberadamente** del espía de argumento sobre el UPDATE: es lo
  que explica por qué la línea del UPDATE de `agent.ts` **no** está entre los 23 sitios sin
  cobertura. Romperlo abriría un sitio que hoy está cubierto.
- El sitio que le falta (`agent.ts:715`) se cubre desde un archivo **nuevo**
  (`src/services/agent.ownership.test.ts`, W3.1), a nivel de servicio, con el falso de
  comportamiento. Esa es la cobertura real; la declaración es para que nadie confunda los dos
  archivos.

**Lo que SÍ hacés — un bloque de comentario en el header, sin tocar una sola línea de lógica:**

> Este archivo verifica que **la consulta se escribió** (el mock registra los `.eq()` en `:49`),
> **no que aisló**: `maybeSingle`/`single` (`:53-54`) devuelven `state.row` sin importar qué
> columna ni qué valor se filtró. `T-PUB-08` y `T-PUB-09` pasan por el **pre-chequeo en JS** de
> `src/services/agent.ts:701`, no por el filtro de la consulta.
> El aislamiento por filtro de `agentService` se prueba en **`src/services/agent.ownership.test.ts`**,
> con un falso que aplica los filtros pedidos.
> `T-143B-06` (`:161`) sí es un espía de argumento sobre el UPDATE, y ese sitio no necesita más.

**Antes de escribir ese bloque, verificalo**: mutá `src/services/agent.ts:715` y confirmá que este
archivo queda **verde**. Si se pone rojo, mi afirmación es falsa y **decilo en el mutation-log**
en vez de escribir el comentario.

### 9.2 · `src/services/inbound-task.test.ts` — dos declaraciones más. **Lo encontré yo en F2.5.**

Mismo patrón, y el dev lo va a encontrar y va a pensar "esto ya está cubierto":

- **`:302`** — `it('get cross-tenant → undefined')`. Setea `getSingle = { data: null, error: null }`
  y afirma `undefined`. El mock (`:94-97` registra los `.eq()` en `ctx.eqs`; `:103-106`
  `maybeSingle` devuelve `getSingle`) **no aplica ningún filtro**. Lo que este test afirma es *«si
  la DB devuelve null, el servicio devuelve undefined»* — no dice nada del filtro por dueño.
- **`:315`** — `it('toda query filtra por owner_ref')`. **El título afirma de más**: el cuerpo
  recorre `updates` (los UPDATE) y el `inserts[0]`. **No mira ninguno de los dos SELECT** de
  `get` (`:316`) ni de `getByExternalRef` (`:338`), que son justamente los dos sitios de este corte.

**Lo que hacés**: una línea de comentario arriba de cada uno diciendo qué afirma de verdad y
apuntando a `src/services/inbound-task.ownership.test.ts`. **Cero cambios de lógica, cero renames**
(renombrar el `it` cambia el nombre del test en cualquier reporte y no aporta a esta HU).

**Antes de escribirlo, verificalo**: mutá `src/services/inbound-task.ts:316` y confirmá que ambos
tests quedan **verdes**. Si alguno se pone rojo, mi afirmación es falsa: decilo.

### 9.3 · Lo que queda como deuda técnica, para el reporte de cierre

Dos archivos con "ownership" en el nombre para agentes (`src/routes/agents.ownership.test.ts` y
`src/services/agent.ownership.test.ts`) **con garantías distintas** es la próxima confusión. Que
`nexus-docs` lo registre como TD con esta explicación, no con un "revisar".

---

## 10. Protocolo de mutación — por línea (AC-5, CD-3, CD-8, CD-9)

**Leé §3 antes de esto.** Las dos trampas ya pasaron hoy.

### El protocolo, por entrada

```
1. Árbol limpio: `git status --short` sin cambios en src/.
   Baseline confirmada: `node ./node_modules/vitest/vitest.mjs run`
     → Tests  5294 passed | 19 skipped (5313)          ← CD-8

2. `sed -n '<N>p' <archivo>`  y PEGAR EL TEXTO EN EL LOG.               ← CD-9
   Si es comentario / docblock / no es una llamada `.eq(...)`:
     mutación INVÁLIDA, no se registra veredicto. Volvé a elegir la línea.

3. `sed -i '<N>d' <archivo>`
   `git diff --stat`  →  DEBE decir  `1 file changed, 1 deletion(-)`.    ← Trampa A
   Si dice otra cosa: mutación inválida.

4. `node ./node_modules/vitest/vitest.mjs run`  →  registrar el CONTEO CRUDO.
   (NO `npx vitest run`: en este shell devuelve una sola línea — H-10.)

5. `git checkout -- <archivo>`  ·  `git status --short` vacío.

6. Fila del log: archivo:línea · texto exacto borrado · veredicto ·
   EL TEST NOMBRADO que se puso rojo · conteo crudo · nota de escenario si aplica.
```

**Dos firmas de muerte idénticas = un mutante mal construido.** Si dos mutaciones distintas matan
exactamente el mismo test con el mismo conteo, partí el test o rehacé el mutante.

### Las 11 mutaciones de producción

| ID | Línea | Veredicto esperado | Test que debe morir | Nota obligatoria en el log |
|---|---|---|---|---|
| M-01 | `src/services/receipt.ts:293` | KILLED | R-01 | — |
| M-02 | `src/services/agent.ts:549` | KILLED | AG-01 | — |
| M-03 | `src/services/agent.ts:715` | KILLED | AG-02 | *escenario de entrelazado; la carrera no es alcanzable en producción hoy* |
| M-04 | `src/services/llm/transform.ts:234` | KILLED | TR-01 | — |
| M-05 | `src/services/llm/transform.ts:278` | KILLED | TR-02 | — |
| M-06 | `src/routes/payments.ts:384` | KILLED | PD-01 | — |
| M-07 | `src/services/spend-policy.ts:163` | KILLED | SP-01 | **`KILLED (escenario de integridad ante fila inconsistente, no alcanzable desde ruta autenticada — ver H-5)`** |
| M-08 | `src/services/spend-policy.ts:190` | KILLED | SP-02 | ídem |
| M-09 | `src/services/spend-policy.ts:219` | KILLED | SP-03 | ídem |
| M-10 | `src/services/inbound-task.ts:316` | KILLED | IT-01 | **`KILLED (la función no tiene llamador de producción — el único ejercitador es el test)`** |
| M-11 | `src/services/inbound-task.ts:338` | KILLED | IT-02 | **`KILLED (idempotencia, no aislamiento — el ownerRef es server-side)`** |

⛔ **Un `KILLED` a secas en M-07..M-11 sería exactamente la prosa que afirma de más que esta HU
existe para sacar del repo.** La nota no es decoración: es el entregable.

### Las 5 mutaciones del guardián

**Un guardián sin mutación es literalmente el hallazgo que esta HU existe para cerrar.**

| ID | Mutación | Veredicto esperado | Qué prueba |
|---|---|---|---|
| M-G1 | plantar una cadena **sintética** sin filtro en un fixture del escáner | KILLED por G-04 (y por G-08 si la plantás en el árbol) | que el guardián **reporta** |
| M-G2 | borrar **UNA** entrada de la lista de excepciones | KILLED por G-08 | que la lista es **portante**, no decorado |
| M-G3 | hacer que `deriveOwnerTables` devuelva `∅` | KILLED por **G-01**, y **G-08 queda VERDE** | el modo de falla **silencioso** |
| M-G4 | que el guardián busque `ownerRef` en vez de `owner_ref` | KILLED por G-07 | comparación **estricta** del nombre |
| M-G5 | quitar la resolución de constantes (`.from(SPLITS_TABLE)` deja de verse) | KILLED por G-05 | CD-13 |

**M-G3 es el más importante de los cinco.** Si al vaciar el conjunto de tablas **G-08 también se
pone rojo**, tu control de armado está mal armado; y si **G-01 queda verde**, el guardián puede
degradarse a "no encuentro nada" y pasar afirmando cobertura total. Ese es el modo de falla que
mató a los 23 filtros.

---

## 11. Constraint Directives

### PROHIBIDO

- **CD-1** — modificar **cualquier línea de producción** bajo `src/` que no sea `*.test.ts`.
  Control: `git diff --stat` sobre `src/**/*.ts` no-test = **vacío**. Si un test no se puede poner
  en rojo sin tocar producción → **PARÁ y escalá** (AC-7).
- **CD-3** — evidencia de mutación que no sea **por línea**. Renombrar la columna en todo el
  archivo da un **KILLED falso**.
- **CD-4** — que el guardián lleve una **lista de tablas escrita a mano**. Las deriva de
  `src/types/database.types.ts` en cada corrida.
- **CD-5** — presentar el guardián como suficiente. Verifica **presencia textual**: no detecta el
  valor equivocado ni las cadenas partidas en variable. Los 7 agujeros van **en el header del
  archivo**, no sólo en el SDD.
- **CD-7** — afirmar que el mecanismo «impide», «previene», «garantiza» o «asegura» algo. Cada
  afirmación va con el input concreto que la pone en rojo y el input que se le escapa.
- **CD-10** — que la lista de excepciones se genere **volcando la salida del escáner**. Un
  artefacto derivado de la misma medición que consume deja el control verde **por construcción**.
  Reincidente: WKH-322 (`T-U7` iteraba la allowlist para afirmar que todas estaban permitidas).
- **CD-15** — ampliar el corte. Ver §12.

### OBLIGATORIO

- **CD-2** — todo fixture de ownership tiene **dos `owner_ref` distintos**, y el falso **no filtra
  por dueño de oficio**.
- **CD-6** — un control anti-vacuidad por test nuevo: **las dos direcciones** (A ve lo suyo **y**
  no ve lo de B).
- **CD-8** — **re-medir la baseline en el worktree** antes de la primera mutación, y citarla con
  su commit. La del reporte de auditoría (`1 failed | 5288`) es de una copia con `git init` fresco
  y **clasifica los mutantes al revés**.
- **CD-9** — **verificar la mutación antes de creerle al veredicto**: mostrar la línea borrada y
  confirmar que es una consulta y no un comentario. Reincidente en WKH-322 y WKH-318-B, y le pasó
  al arquitecto en F2.
- **CD-11** — el censo **cierra por construcción, no por grep**: `cadenas = con-dueño + sin-dueño`
  y `sin-dueño = Σ categorías`. El conteo ya creció 23 → 55; que crezca otra vez significa que la
  búsqueda no cerró.
- **CD-12** — el orden `editar → tsc → test → lint → commit`, **por wave**. Para `test/`, `tsc` y
  `lint` no miran nada (H-8): usá el tsconfig ad-hoc.
- **CD-13** — el escáner **resuelve constantes de módulo** y **filtra por receptor `supabase`**.
- **CD-14** — si el censo encuentra una entrada `idor-vivo`: **PARAR Y ESCALAR**. No se arregla acá
  (CD-1 lo prohíbe) y **no se degrada a excepción**. Sale como hallazgo con su propia HU.

---

## 12. Out of Scope — no toques nada de esto

- **Arreglar cualquier filtro.** Los 11 están puestos y son correctos. Esta HU los mide.
- **Los 12 sitios de WKH-SEC-04**: `fee-split` ×4, `arbiter` ×3, `evidence` ×3, `reconciliation`
  ×1, `debit-capture` ×1. Si uno aparece "de paso" en el censo → **se anota y no se toca**.
- **Los otros 64 filtros** (`.eq` que no son `owner_ref`): otra HU, otra clase de escenario.
- **RLS real en Postgres**: es WKH-SEC-02 / TD-SEC-01 (`CLAUDE.md:207-215`).
- **Los repos** `chaski-v3`, `wasiai-facilitator`, `solana-programs`, `wasiai-remittance-agents`.
- **`m5-keys/`** — carpeta prohibida. **Desplegar** cualquier cosa. **La base `caldz`.**
- **Los reportes A2..A6** de la misma auditoría.
- **Mutación automatizada en CI** (el guion queda versionado, no cableado a CI — W4.1).
- **`a2a_protocol_fees`**: no tiene dueño, no hay nada que filtrar.
- **No "mejorar" código adyacente. No renombrar tests existentes. No arreglar los mocks rotos de
  §9** — se declaran, no se arreglan.

---

## 13. Anti-Hallucination Checklist

Marcá cada uno **con el comando que lo comprueba**, no de memoria.

- [ ] `git rev-parse HEAD` = `ef384b775ed990d9ad26c3df55a0681ba6d97c14`
- [ ] La baseline la medí **yo** con `node ./node_modules/vitest/vitest.mjs run` y es
      `5294 passed | 19 skipped (5313)` — no la copié de ningún reporte (CD-8)
- [ ] Las 11 líneas de §6 las vi con `sed -n '<N>p'` y **ninguna es un comentario** (CD-9)
- [ ] Cada `import` de mis tests apunta a un módulo que existe. En particular:
      `getFromL2` **NO está exportado** de `src/services/llm/transform.ts`; el punto de entrada es
      `maybeTransform` (`:366`)
- [ ] El falso está en `src/services/__tests__/`, **no** en `__fixtures__`, y verifiqué con
      `tsc -p tsconfig.build.json --listFiles` que **no aparece** (H-9)
- [ ] El conjunto de tablas del guardián está **derivado**, no escrito a mano (CD-4), y da **21**
- [ ] La lista de excepciones la escribí **a mano**, entrada por entrada (CD-10). Nace con ~41
- [ ] `category` y `reason` se validan en **runtime**, no sólo por tipo (H-8: CI no typechequea `test/`)
- [ ] El censo **cuadra**: `101 = 46 + 55` y `55 = Σ categorías` (CD-11)
- [ ] **0** entradas `idor-vivo`. Si hay una → paré y escalé (CD-14)
- [ ] Cada test nuevo tiene su **control anti-vacuidad**: A ve lo suyo **y** no ve lo de B (CD-6)
- [ ] Cada test cross-tenant afirma que **el id EXISTE en la tabla**
- [ ] El falso hereda `unknownColumn` de E-1b: un filtro sobre una columna inexistente **falla
      ruidoso** (`42703`), no devuelve "0 filas"
- [ ] `transform.ownership.test.ts` llama `_clearL1Cache()` en `beforeEach` y **declara** en qué
      modo de HMAC corre
- [ ] AG-02 afirma **`false` + fila intacta**, NO `rejects.toThrow` (H-6)
- [ ] Los headers de `spend-policy.ownership.test.ts` e `inbound-task.ownership.test.ts` **declaran
      que no prueban aislamiento** (H-5, §6-D)
- [ ] El header del guardián tiene **los 7 agujeros + el octavo** (los 12 sitios de SEC-04)
- [ ] **Ninguna** frase de mis archivos dice que algo «impide» / «previene» / «garantiza» (CD-7)
- [ ] Las 16 filas del `mutation-log.md` tienen **el texto exacto borrado**, no sólo la línea
- [ ] M-07..M-11 llevan su **nota de escenario**; ningún `KILLED` a secas ahí
- [ ] M-G3 pone rojo a **G-01** y deja **G-08 verde**
- [ ] `git diff --stat` sobre `src/**/*.ts` **no-test** está **vacío** (CD-1 / AC-7)
- [ ] Las únicas modificaciones a archivos preexistentes son **comentarios** en
      `src/routes/agents.ownership.test.ts` y `src/services/inbound-task.test.ts`, y **verifiqué
      por mutación** que lo que afirman esos comentarios es cierto (§9)
- [ ] `CLAUDE.md` **no** quedó con una lista de 21 nombres escrita a mano (W4.3)

---

## 14. Escalation Rule

**Si algo no está en este Story File, PARÁ y preguntá. No inventes, no asumas, no improvises.**

Escalá **sí o sí** en estos casos:

| Situación | Por qué es escalación y no decisión tuya |
|---|---|
| El censo encuentra una entrada **`idor-vivo`** | CD-14. Es un hallazgo de seguridad con su propia HU. No se arregla acá y no se degrada a excepción |
| Un test **no se puede poner en rojo sin tocar producción** | AC-7 / CD-1. La HU no arregla filtros |
| Tu censo **no da 101 / 46 / 55** | Es el hallazgo, no un ajuste. Documentá la diferencia **antes** de decidir cuál instrumento está bien |
| La baseline **no da** `5294 passed \| 19 skipped (5313)` | Toda la evidencia de AC-5 se compara contra ese número. Sin él no hay veredictos válidos |
| Una de las 11 líneas de §6 **no es lo que dice acá** | El árbol se movió; los `archivo:línea` de este documento dejaron de valer |
| Una mutación esperada como KILLED da **SURVIVED** después de verificar la línea | O el test está mal, o el sitio no es alcanzable como creímos. Las dos cosas son hallazgos |
| Necesitás tocar un archivo **fuera de la tabla de §5** | Incluye cualquier `tsconfig*.json`, `vitest.config.ts` y `package.json` |
| Encontrás un archivo de test con el mock roto **que no esté en la tabla de §7** | Los seis `*ownership*` y los tres anti-patrones adicionales ya están mapeados ahí. Uno nuevo amplía el corte |

---

*Story File generado por NexusAgil — F2.5 · `nexus-architect`*
