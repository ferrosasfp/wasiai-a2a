# SDD #221 — [WKH-SEC-04] Los 12 filtros por dueño del camino del dinero y las disputas

> F2 · NexusAgil QUALITY · 2026-08-06 · autor: `nexus-architect`
> Insumo: `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/` (los 9 artefactos de WKH-SEC-03,
> mergeada) · `doc/audit/deuda-tecnica-2026-08-06/A1-guards-que-no-discriminan.md`, hallazgo 0.
> Árbol de referencia: worktree `wt-sec04`, rama `feat/221-wkh-sec-04-owner-ref-dinero-y-disputas`,
> base **`b7fa4e7`**. **Todo `archivo:línea` de este documento está anclado a ese commit y fue
> abierto con `Read` o con una corrida pegada.**

---

## 1. Resumen

WKH-SEC-03 dejó construido todo el instrumento: el guardián (`test/ownership-filter-guard.test.ts`
+ `.scanner.ts` + `.exceptions.ts`), el falso compartido que **aplica** los filtros
(`src/services/__tests__/owner-scoped-fake.ts`), el censo y `scripts/eq-sweep.mjs`. Esta HU **no
construye instrumento**: escribe los tests de propiedad de los **12 sitios** que SEC-03 declaró
fuera del corte, y produce la medición que sobre esos 12 **nadie corrió** —
`mutation-log.md:216` dice literalmente «Los 12 sitios de WKH-SEC-04. Fuera del corte, sin mutar».

**Los 12 los medí de cero en este F2.** No heredé la línea base de A1 (que el propio SDD de SEC-03
declara equivocada, `sdd.md:494-497`) ni sus veredictos. Los 12 mutantes están corridos, uno por
uno, con la salida pegada en §3.5.

### 1.1 Lo que medí y que contradice a los artefactos de SEC-03

Seis correcciones. Las tres primeras cambian el **método**, no sólo un número, y si el Dev no las
aplica va a escribir un `mutation-log.md` entero con veredictos invertidos.

| # | El artefacto de SEC-03 dice | Lo medido en `b7fa4e7` | Dónde |
|---|---|---|---|
| **C-1** | (implícito en todo el método de SEC-03) borrar un filtro deja la suite en la línea base ⟹ `SURVIVED` | **YA NO.** Con el guardián mergeado, **los 12 mutantes ponen en rojo `G-08` y `G-09`**. Un `KILLED` leído de la salida cruda sería falso para los 12 | §3.4, §3.5 |
| **C-2** | Trampa A: «un mutante grande da un falso KILLED», antídoto `git diff --stat` = `1 file changed, 1 deletion(-)` (`story-HU-WKH-SEC-03.md:268`) | **El antídoto no alcanza en esta HU.** Borrar la línea entera de `fee-split.ts:538` da exactamente `1 file changed, 1 deletion(-)` **y rompe la sintaxis** (`PARSE_ERROR`, 22 archivos de test caídos por import). Hace falta un control de parseo | §3.6 |
| **C-3** | AC-3 de SEC-03 (`work-item.md:172-178`) pone `arbiter.ts:1070` y `:1100` entre los que «sólo se matan con un test de entrelazado» | **NO.** Los dos son métodos del objeto exportado `arbiterService` (`arbiter.ts:576`, `:1064`, `:1090`) y reciben `(intentId, ownerRef)` como argumentos independientes: un fixture de dos dueños sobre una base **consistente** los mata sin ningún hook. El único de este corte que exige entrelazado obligatorio es `fee-split.ts:697`, más `:538` y `:618` por otro motivo | §4.2 |
| **C-4** | los 23 sitios de A1 son todos los `.eq('owner_ref')` sin cobertura | **Hay un 13.º en el mismo archivo del corte**: `src/adapters/escrow/debit-capture.ts:120`. No está entre los 23 porque **muere**, pero muere por un **espía de argumento** (`debit-capture.test.ts:533`: `expect(calls.eq).toContainEqual(['owner_ref', OWNER])`), que es la forma que DT-1 de SEC-03 declara insuficiente | §4.4 |
| **C-5** | (SEC-03 nombró `routes/agents.ownership.test.ts` como el archivo que se titula anti-IDOR y no aísla) | **Hay un segundo, y está adentro de este corte**: `src/services/arbiter/evidence.test.ts`. Su docblock `:4-5` dice «un doble de supabase **fiel** a la semántica de las 3 queries **owner-guarded**» y su doble es `eq: () => b` (`:49`), que tira columna y valor | §4.5 |
| **C-6** | línea base `0 failed \| 5294 passed \| 19 skipped (5313)` en `ef384b7` | **`5330 passed \| 19 skipped (5349)`, `Test Files 268 passed \| 6 skipped (274)`** en `b7fa4e7`, 10,4 s | §3.4 |

Y una aritmética que sí se sostiene: **11 (SEC-03) + 12 (SEC-04) = 23**. La medí contra el código,
no contra los rótulos: los 12 de este corte **existen los 12** y los 12 son consultas, no
comentarios (§3.5).

---

## 2. Work Item

- **HU**: WKH-SEC-04 — probar los 12 filtros por dueño del camino del dinero y de las disputas que
  WKH-SEC-03 dejó explícitamente fuera.
- **Corte**: `fee-split.ts` ×4 · `arbiter.ts` ×3 · `arbiter/evidence.ts` ×3 · `reconciliation.ts`
  ×1 · `adapters/escrow/debit-capture.ts` ×1 = **12**.
- **Esta HU es sólo tests.** Cero líneas de producción (CD-1, heredado).
- **Por qué es más barata que SEC-03**: el guardián, el falso, el censo, las 41 excepciones y el
  guion de barrido ya están mergeados y verificados. Lo que falta es el test de propiedad por
  sitio. El costo real está en **cuatro sitios** (`fee-split` ×3 por el entrelazado, `arbiter:110`
  por la pila de gates de escrow que hay que montar), no en los doce.

### 2.1 Acceptance Criteria

Cada AC nombra el input concreto que lo pone en rojo. Un AC que no se puede poner en rojo es una
frase, no un AC.

- **AC-1**: WHEN el dueño A invoca una función exportada de este corte pasando el identificador de
  un recurso del dueño B, the system SHALL no entregar ni mutar el recurso de B, en
  `arbiterService.revertDisputeToOpen`, `arbiterService.holdArbitration`, `readEvidence`,
  `reconciliationService.readBudgetUsd`, `captureDebitSignature`, `settleArbitrationOnChain` (por
  el nonce) y `chargeLeg` vía `settleFeeSplits`.
  *Input que lo pone en rojo*: quitar `src/services/arbiter/evidence.ts:57`; `readEvidence(<id de
  B>, 'owner-A')` deja de tirar `INTENT_NOT_FOUND` y devuelve el `authorized_usd` de B.

- **AC-2**: WHILE la fila cambia de dueño entre la lectura previa y la escritura, the system SHALL
  no escribir sobre la fila del nuevo dueño en `chargeLeg` (UPDATE `charged`,
  `src/services/fee-split.ts:538`), `markLegFailed` (`:618`) y `reverseFeeSplits` (`:697`).
  *Input que lo pone en rojo*: quitar `src/services/fee-split.ts:697`; con el hook `onUpdateStart`
  cambiando el dueño de la fila, el leg de B pasa a `reversed`.

- **AC-3**: WHERE la propiedad sólo se sostiene sobre una fila que la base consistente no produce
  (`arbiter/evidence.ts:76` y `:96`), the system SHALL declararlo **por escrito en el header del
  archivo de test y en la fila del `mutation-log.md`**, con la forma que ya usa
  `src/services/task.ownership.test.ts:277-283`.
  *Input que lo pone en rojo*: un test de `evidence.ts:76` que se presente como aislamiento entre
  inquilinos sin decir que el estado que arma requiere un voucher cuyo `owner_ref` no coincide con
  el del intent al que apunta su FK.

- **AC-4**: the system SHALL construir cada test sobre un fixture con **al menos dos `owner_ref`
  distintos** y sobre `createOwnerScopedFake`, que aplica **exactamente** los filtros pedidos
  (`src/services/__tests__/owner-scoped-fake.ts:130-135`).
  *Input que lo pone en rojo*: un fixture de un solo dueño — no puede refutar ningún filtro por
  dueño, y el control de las dos direcciones se cae solo.

- **AC-5**: WHEN se cierre la HU, the system SHALL acompañar cada uno de los 12 sitios con la
  evidencia de que **quitar ese filtro** pone en rojo **al menos un test que NO sea `G-08` ni
  `G-09`**, nombrando el test.
  *Input que lo pone en rojo*: una fila del log cuyo único rojo sea
  `test/ownership-filter-guard.test.ts`. Eso es la línea base del mutante hoy (§3.5), o sea el
  punto de partida, no el resultado.

- **AC-6**: IF la implementación necesita modificar una línea de producción bajo `src/` que no sea
  un archivo de test, THEN the system SHALL detener la HU y escalar.
  *Input que lo pone en rojo*: `git diff --name-only b7fa4e7 -- src` con cualquier archivo que no
  matchee `*.test.ts` ni `src/services/__tests__/`.

- **AC-7**: WHEN se cierre la HU, the system SHALL actualizar el punto 8 del header de
  `test/ownership-filter-guard.test.ts` (`:84-88`), que hoy dice que esos 12 sitios no tienen test
  de propiedad y que «que funcione no lo midió nadie todavía».
  *Input que lo pone en rojo*: `git diff b7fa4e7 -- test/ownership-filter-guard.test.ts` vacío al
  cierre. Es la misma clase de hallazgo que el BLQ-MED-1 del AR de SEC-03 (`adversarial-review.md:23`:
  scope incompleto, el archivo de doctrina sin tocar).

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos, y qué saqué de cada uno

| Archivo | Por qué | Qué extraje |
|---|---|---|
| `src/services/__tests__/owner-scoped-fake.ts` (349 líneas) | **el exemplar madre de esta HU** | `applyFilters` que aplica exactamente los filtros pedidos (`:130-135`); `unknownColumn` → `42703` (`:137-150`), que convierte un nombre de columna mal escrito en rojo ruidoso; `QueryRecord.resolved` (`:86-94`); el hook `onDeleteStart` (`:267-274`); y las **dos ausencias** que esta HU tiene que llenar: **no hay `onUpdateStart`** (declarado en `:54-55`) y **no hay modelo de UNIQUE** |
| `src/services/task.ownership.test.ts:285-317` | la receta del entrelazado | el patrón `onUpdateStart` y, sobre todo, `:277-283`: la declaración escrita de que la carrera no es alcanzable hoy y por qué el test igual vale |
| `test/ownership-filter-guard.test.ts` (header `:1-119`, `G-08` `:579-596`, `G-09` `:598-616`) | **cambia el protocolo de mutación** | `G-08` compara las cadenas sin filtro contra la lista de excepciones; `G-09` exige además `UNFILTERED.length === EXCEPTIONS.length` (`:615`), o sea que **cualquier** cadena nueva sin filtro rompe los dos. Y el punto 8 del header (`:84-88`) es el texto que AC-7 obliga a actualizar |
| `test/ownership-filter-guard.exceptions.ts` | saber qué se mueve al mutar | 11 excepciones viven en archivos de este corte: `arbiter.ts` `594/1178/1237/1270`, `reconciliation.ts` `564/614/655/886/1129/1349`, `fee-split.ts` `645`. **Borrar una línea por encima de esas corre sus números** y pone `G-09` en rojo por un segundo motivo |
| `src/services/fee-split.ts:341-560`, `:628-721`, `:37` | los 4 sitios | `SPLITS_TABLE` es una `const` de módulo (`:37`); `ownerRef` sale de `resolveRecipients` (`:215`, `:224`, `:238`), no del caller; el pre-chequeo en JS de `reverseFeeSplits` está en `:676-683` |
| `supabase/migrations/20260705000000_wkh136_fee_splits.sql:40` | el dato que decide el fixture | `UNIQUE (orchestration_id, recipient_role)` — **sin `owner_ref`**. Es lo que hace que una fila `(orch, role)` de otro dueño sea un estado alcanzable y no una fantasía |
| `src/services/arbiter.ts:100-165`, `:576-734`, `:1004-1120` | los 3 sitios | `getOrCreateArbiterNonce` es **privada**, sólo la llama `settleArbitrationOnChain:208`; `revertDisputeToOpen` (`:1064`) y `holdArbitration` (`:1090`) son **métodos del objeto exportado** `arbiterService` (`:576`); el chequeo en JS del dueño vive en `openDispute`, `:606-608`, en OTRA función |
| `src/routes/payments.ts:325-361` | de dónde sale el identificador | `openDispute(req.params.id, callerKey.owner_ref)`: el `intentId` **sí** lo elige el caller; el `ownerRef` sale de la key autenticada |
| `src/services/arbiter/evidence.ts` (137 líneas) | los 3 sitios | `readEvidence(intentId, ownerRef)` es exportada y sus dos argumentos son independientes; `:57` usa `single()` y mapea `PGRST116 → INTENT_NOT_FOUND` (`:59-62`) |
| `src/services/arbiter/evidence.test.ts` (213 líneas) | **el hallazgo C-5** | doble `eq: () => b` (`:49`) bajo un docblock que lo llama «fiel … owner-guarded» (`:4-5`), y un test titulado «intent inexistente / **de otro owner**» (`:186`) que sólo devuelve un `PGRST116` enlatado |
| `src/services/reconciliation.ts:1344-1454` | el sitio | `readBudgetUsd(keyId, ownerRef, chainId)` es método del objeto exportado; su único llamador de producción es `driftCheck:1402`, que le pasa `g.ownerRef` sacado de la **propia fila** (`:1382`) |
| `src/adapters/escrow/debit-capture.ts:92-145`, `:205-301` | el sitio + el 13.º | `:212` lee `buyer_wallet`; el veredicto observable sale por `p_status`/`p_reason` del RPC (`:275-287`). `:120` es el 13.º sitio (C-4) |
| `src/adapters/escrow/debit-capture.test.ts:79`, `:463`, `:519-533` | el espía de C-4 | `eq: () => builder` en dos dobles, y el único control de `owner_ref` es `expect(calls.eq).toContainEqual(['owner_ref', OWNER])` (`:533`) |
| `src/services/fee-split.test.ts:55-90` | el anti-patrón nombrado | `chain.eq = () => chain` (`:68`, `:83`): la respuesta la decide `mockState.selectQ.shift()`, no la query |
| `src/services/arbiter.test.ts:340-452`, `:1630-1740` | doble parcial + la pila de gates | el `fromImpl` aplica `id` (`:385`) y `status` (`:420`) pero **nunca** `owner_ref`; y `:1664-1740` es el montaje completo que llega al read-first del nonce (`ESCROW_ARBITER_ENABLED`, secreto, `nonceStore`) |
| `src/services/reconciliation.test.ts:17-83` · `src/adapters/escrow/debit-capture.test.ts:21-40` | las cabeceras de `vi.mock` a copiar | son los dos módulos con más dependencias del corte |
| `doc/sdd/220-…/{work-item,sdd,story,mutation-log,adversarial-review,code-review,auto-blindaje}.md` | el método y lo que el AR ataca | ver §3.7 |

### 3.2 Exemplars verificados (existen, los abrí)

| Path | Qué se copia | Verificado |
|---|---|---|
| `src/services/__tests__/owner-scoped-fake.ts:152-348` | el falso completo: `createOwnerScopedFake(spec)` | SÍ |
| `src/services/__tests__/owner-scoped-fake.ts:130-135` | `applyFilters` — «Aplica EXACTAMENTE los filtros pedidos. Ni uno más» | SÍ |
| `src/services/__tests__/owner-scoped-fake.ts:267-274` | `delete()` + `onDeleteStart` — **la forma exacta que hay que replicar para `update()`** | SÍ |
| `src/services/task.ownership.test.ts:285-317` | la receta del entrelazado (T-OWN-03/04) | SÍ |
| `src/services/task.ownership.test.ts:277-283` | la declaración escrita de «esta carrera no es alcanzable hoy, y el test igual vale» | SÍ |
| `src/services/receipt.ownership.test.ts` (4,3 K) | el archivo de propiedad **más chico** de SEC-03: la forma mínima de un `*.ownership.test.ts` | SÍ |
| `src/services/agent.ownership.test.ts` (5,9 K) | el que usa `onDeleteStart`: entrelazado real ya mergeado | SÍ |
| `src/services/llm/transform.ownership.test.ts` (10,8 K) | el que cubre dos sitios en un archivo + el caso `owner_ref = NULL` | SÍ |
| `src/services/reconciliation.test.ts:17-83` | la cabecera de `vi.mock` de `reconciliation.ts` | SÍ |
| `src/services/arbiter.test.ts:1664-1740` | el montaje que llega al nonce del árbitro | SÍ |
| `scripts/eq-sweep.mjs` (11,7 K) | el barrido versionado que dejó SEC-03 | SÍ (existe; **no lo corrí** — ver §3.8) |

**Anti-patrones nombrados, para que nadie los copie** (verificados con
`command grep -n "eq: () => \|chain.eq = "`): `src/services/fee-split.test.ts:68` y `:83`
(`chain.eq = () => chain`), `src/services/arbiter/evidence.test.ts:49` (`eq: () => b`),
`src/adapters/escrow/debit-capture.test.ts:79` y `:463` (`eq: () => builder`). Los cuatro tiran
columna y valor. El quinto que nombró SEC-03, `src/routes/agents.ownership.test.ts`, registra los
`.eq()` en `state.eqCalls` (`:51`) sin aplicarlos; **no lo re-verifiqué línea por línea**, lo cito
del AR de SEC-03.

### 3.3 Los 12 sitios existen y son consultas

Verificado con `command grep -n "owner_ref"` sobre los cinco archivos y `Read` de cada rango.
Ninguno de los 12 es un comentario (el antídoto de la Trampa B de SEC-03), y el mutante de §3.5
pegó el texto de cada línea antes de tocarla.

```
src/services/fee-split.ts:365            .eq('owner_ref', ownerRef)
src/services/fee-split.ts:538            .eq('owner_ref', ownerRef)) as { error: SupabaseError | null };
src/services/fee-split.ts:618            .eq('owner_ref', ownerRef);
src/services/fee-split.ts:697            .eq('owner_ref', ownerRef)) as { error: SupabaseError | null };
src/services/arbiter.ts:110              .eq('owner_ref', ownerRef)
src/services/arbiter.ts:1070             .eq('owner_ref', ownerRef)
src/services/arbiter.ts:1100             .eq('owner_ref', ownerRef)
src/services/arbiter/evidence.ts:57      .eq('owner_ref', ownerRef)
src/services/arbiter/evidence.ts:76      .eq('owner_ref', ownerRef);
src/services/arbiter/evidence.ts:96      .eq('owner_ref', ownerRef);
src/services/reconciliation.ts:1448      .eq('owner_ref', ownerRef)
src/adapters/escrow/debit-capture.ts:212 .eq('owner_ref', ownerRef)
```

**Dos de los doce terminan con una cola de sintaxis** (`)) as { … };`, líneas `538` y `697`).
Ese detalle es lo que produce C-2 y no es cosmético: ver §3.6.

### 3.4 Línea base, medida en este worktree

```
$ node ./node_modules/vitest/vitest.mjs run
 Test Files  268 passed | 6 skipped (274)
      Tests  5330 passed | 19 skipped (5349)
   Duration  10.14s
real 0m10.438s
```

`node_modules` está linkeado del árbol principal (`ln -s`), igual que hizo SEC-03. **`npx vitest
run` no se usa**: colapsa la salida y se pierden `skipped` y `Test Files` (H-10 del Story File de
SEC-03, `story-HU-WKH-SEC-03.md:246`).

### 3.5 Los 12 mutantes, corridos de cero. **Los 12 sobreviven al comportamiento.**

Protocolo usado: pegar la línea → mutar sólo esa línea → **control de parseo con `esbuild`** →
suite completa → `git checkout --` → `git status --short` vacío. El detalle está en §8.

| # | Sitio | Mutación aplicada | Rojos **fuera** del guardián | Veredicto |
|---|---|---|---|---|
| 1 | `fee-split.ts:365` | línea borrada | **ninguno** | **SURVIVED** |
| 2 | `fee-split.ts:538` | `.eq('owner_ref', ownerRef))` → `)` | **ninguno** | **SURVIVED** |
| 3 | `fee-split.ts:618` | `.eq('owner_ref', ownerRef);` → `;` | **ninguno** | **SURVIVED** |
| 4 | `fee-split.ts:697` | `.eq('owner_ref', ownerRef))` → `)` | **ninguno** | **SURVIVED** |
| 5 | `arbiter.ts:110` | línea borrada | **ninguno** | **SURVIVED** |
| 6 | `arbiter.ts:1070` | línea borrada | **ninguno** | **SURVIVED** |
| 7 | `arbiter.ts:1100` | línea borrada | **ninguno** | **SURVIVED** |
| 8 | `evidence.ts:57` | línea borrada | **ninguno** | **SURVIVED** |
| 9 | `evidence.ts:76` | `.eq('owner_ref', ownerRef);` → `;` | **ninguno** | **SURVIVED** |
| 10 | `evidence.ts:96` | `.eq('owner_ref', ownerRef);` → `;` | **ninguno** | **SURVIVED** |
| 11 | `reconciliation.ts:1448` | línea borrada | **ninguno** | **SURVIVED** |
| 12 | `debit-capture.ts:212` | línea borrada | **ninguno** | **SURVIVED** |

Salida cruda de los doce, idéntica en los doce:

```
 FAIL  test/ownership-filter-guard.test.ts > … > ★ G-08: ninguna cadena `select`/`update`/`delete` queda sin filtro y sin excepción
 FAIL  test/ownership-filter-guard.test.ts > … > G-09: ninguna excepción sobrevive a su sitio
 Test Files  1 failed | 267 passed | 6 skipped (274)
      Tests  2 failed | 5328 passed | 19 skipped (5349)
```

**Control negativo del instrumento** (sin él, «SURVIVED» es indistinguible de «la suite no
corrió»): el 13.º sitio del mismo archivo, `src/adapters/escrow/debit-capture.ts:120`, **sí**
produce un rojo de comportamiento:

```
 FAIL  src/adapters/escrow/debit-capture.test.ts > T-7 reader query owner-guarded + most-recent (AC-7/191b) > WHERE valid ORDER BY captured_at DESC LIMIT 1 + eq(owner_ref); amount OK → devuelve la fila
 Test Files  2 failed | 266 passed | 6 skipped (274)
      Tests  3 failed | 5327 passed | 19 skipped (5349)
```

### 3.6 C-1 y C-2 — las dos trampas nuevas, medidas

**C-1 · El guardián mata todos los mutantes, y eso NO es la evidencia que pide AC-5.**
Con SEC-03 mergeada, quitar cualquiera de los 12 filtros crea una cadena sin filtro y sin
excepción, así que `G-08` se pone rojo. Y `G-09` también, por un invariante distinto:
`expect(UNFILTERED.length).toBe(OWNERSHIP_FILTER_EXCEPTIONS.length)`
(`test/ownership-filter-guard.test.ts:615`) pasa de `41 === 41` a `42 !== 41`. Verificado además
que **también** pasa con una mutación que preserva el número de líneas, o sea que no es un efecto
del corrimiento: mutando `arbiter.ts:110` en el sitio, `node ./node_modules/vitest/vitest.mjs run
test/ownership-filter-guard.test.ts` da `Tests 2 failed | 11 passed (13)` con `× G-08` y `× G-09`.

Consecuencia operativa: **`Test Files 1 failed` es la línea base del mutante**, no una muerte. La
regla de esta HU es que un mutante cuenta como `KILLED` sólo si hay un rojo **fuera** de
`test/ownership-filter-guard.test.ts`. Va a CD-16.

Un segundo efecto, para el que borre líneas en vez de reemplazarlas: 11 de las 41 excepciones
viven en archivos de este corte (`arbiter.ts` 594/1178/1237/1270, `reconciliation.ts`
564/614/655/886/1129/1349, `fee-split.ts` 645). Borrar una línea por encima de esas les corre el
número y `G-09` se pone rojo **por un tercer motivo** que no tiene nada que ver con el sitio
mutado. Por eso el protocolo de §8 prefiere el reemplazo sobre el borrado.

**C-2 · Borrar la línea entera de `:538` y `:697` es un mutante inválido, y `git diff --stat` no
lo delata.** Medido:

```
$ python3 mutate.py src/services/fee-split.ts 538 ".eq('owner_ref', ownerRef))"
LINEA src/services/fee-split.ts:538 =       .eq('owner_ref', ownerRef)) as { error: SupabaseError | null };
$ git diff --stat -- src/services/fee-split.ts
 src/services/fee-split.ts | 1 -
 1 file changed, 1 deletion(-)          ← el antídoto de SEC-03 dice "válido"
$ node ./node_modules/vitest/vitest.mjs run src/services/fee-split.test.ts
 FAIL  src/services/fee-split.test.ts [ src/services/fee-split.test.ts ]
 Error: Transform failed with 1 error:
 [PARSE_ERROR] Expected `,` or `)` but found `if`   src/services/fee-split.ts:539:5
```

Sobre la suite completa eso daba `Test Files 22 failed | 246 passed`. Veintidós archivos rojos por
un `PARSE_ERROR`, que leídos sin mirar el detalle son un `KILLED` espectacular y **completamente
falso**: la mutación no quitó ningún filtro, rompió el archivo. El antídoto que sí funciona es un
control de parseo antes de correr la suite:

```bash
./node_modules/.bin/esbuild <archivo> > /dev/null   # exit != 0 ⟹ mutante inválido, se descarta
```

Verificado en las dos direcciones: con el archivo sano da `parse ok`; con la línea borrada tira el
`PARSE_ERROR` de arriba. Va a CD-17.

### 3.7 Lo que el AR va a atacar — leído en el AR y el CR de SEC-03

`adversarial-review.md` de SEC-03 (`VEREDICTO: RECHAZADO`, 1 BLQ-MEDIO + 3 BLQ-BAJOS) y
`code-review.md` (`RECHAZADO`, 2 BLQ-BAJO + 6 MENORes). Los cuatro modos de ataque que se repiten,
con el hallazgo que los produjo:

1. **Scope incompleto en el archivo de doctrina** — `adversarial-review.md:23` (BLQ-MED-1):
   `CLAUDE.md` era el archivo 16 de 17 del Story File y no se tocó. → acá es AC-7 (el punto 8 del
   header del guardián).
2. **Una cita `archivo:línea` que apunta al sujeto equivocado y muestra lo esperado** —
   `adversarial-review.md:58` (BLQ-BAJO-2): la excepción citaba `dashboard.ts:630` (la ruta de
   reconciliación) como gate de la ruta de **arbitraje**, que vive en `:515-517`. El revisor
   encuentra `requireAdminTokenStrict` en `:630`, ve lo que esperaba, y estampa OK sin haber
   mirado nunca la ruta real. **Evidencia auto-confirmante.** → CD-19.
3. **Una afirmación que fue verdad y dejó de serlo, sobreviviendo textual en archivos que sí se
   mergean** — `adversarial-review.md:77` (BLQ-BAJO-3): «se pueden borrar hoy y la suite entera
   queda verde» quedó escrito en `spend-policy.ownership.test.ts:24-25` y en
   `ownership-filter-guard.test.ts:10`. **Es exactamente la frase que C-1 vuelve falsa para los 12
   de esta HU.** → CD-18.
4. **La calidad de los motivos, uno por uno** — `adversarial-review.md:9`: las 41 excepciones se
   revisaron contra el código, una por una, y se verificaron los callers, los gates, las
   proyecciones y los chequeos en JS. Acá el equivalente es: **de dónde sale cada identificador**.
   §4 lo tiene por sitio, y el Dev tiene que poder defenderlo sitio por sitio.

### 3.8 Auto-Blindaje histórico

`doc/sdd/220-…/auto-blindaje.md` es el más reciente y sus tres entradas son de esta misma familia
de trabajo. Las tres bajan a CD porque las tres son reincidentes con `217/auto-blindaje.md` y
`218/auto-blindaje.md` (las leyó y las citó el SDD de SEC-03, §3.5):

| Patrón | Dónde | CD |
|---|---|---|
| **Pegar un `archivo:línea` que no salió de una salida capturada.** «filtré la salida por comodidad y después escribí de memoria lo que tenía que haber salido» | `220/auto-blindaje.md:9-23` | **CD-20** |
| **Una cita a un archivo que la misma tarea edita queda apuntando a otra línea.** El docblock citaba `mutation-log.md:212`; tras agregar 4 líneas la real pasó a ser `:216` | `220/auto-blindaje.md:25-36` | **CD-21** |
| **Copiar un número de un artefacto de revisión sin re-medirlo.** El CR decía «62 cabeceras, 63 cierres»; medido eran 62 + 62 + 1 comentario, y el control se habría roto | `220/auto-blindaje.md:38-48` | **CD-22** |

**Y una cuarta, de este F2, que ninguna HU previa documentó**: `perl` con `\Q…\E` **interpola
`${…}` igual**, así que un patrón de mutación con plantilla no matchea, el archivo queda intacto,
el proceso sale con `0` y la suite verde se lee como «el mutante sobrevive». Todas las mutaciones
de este SDD se hicieron con `python3` y `assert <patrón> in <línea>`. → CD-23.

**No corrí `scripts/eq-sweep.mjs`.** Existe (11,7 K) y SEC-03 lo dejó versionado, pero mi barrido
lo hice con un guion propio en scratchpad porque necesitaba el control de parseo de C-2 y el
descuento del guardián de C-1, que ese guion no tiene. Si `eq-sweep.mjs` los tiene, **no se pudo
verificar**: no lo leí.

---

## 4. Diseño técnico

### 4.1 La pregunta que decide cada test: ¿de dónde sale el identificador?

Es la misma pregunta que SEC-03 usó para partir sus 11 en cuatro grupos, y la que el AR revisó
excepción por excepción. Verificada sitio por sitio con `Read` del llamador.

### 4.2 Los 12, clasificados

**Grupo A — argumentos cruzados sobre una base CONSISTENTE (7 sitios).**
La función es exportada y recibe `(<identificador>, ownerRef)` como argumentos independientes. El
fixture es una base perfectamente consistente (cada fila con su dueño real) y lo que se cruza es
el **par de argumentos**. Un fixture de dos dueños los mata sin ningún hook.

| Sitio | Función exportada | Qué pasa sin el filtro |
|---|---|---|
| `arbiter.ts:1070` | `arbiterService.revertDisputeToOpen(intentId, ownerRef)` (`:1064`) | el intent `disputed` de B pasa a `open`. Es una transición de estado del camino de disputas, disparada por otro dueño |
| `arbiter.ts:1100` | `arbiterService.holdArbitration(intentId, ownerRef, meta)` (`:1090`) | el intent `disputed` de B pasa a `arb_hold` (terminal), y además se emite un recibo y se persiste una fila de arbitraje con el `ownerRef` de A (`:1106-1118`) |
| `evidence.ts:57` | `readEvidence(intentId, ownerRef)` (`:48`) | **el único de los 12 donde «A ve los datos de B» es literal**: `authorized_usd`, `consumed_usd`, `pay_to` y `seller_ref` del intent ajeno, en vez de `INTENT_NOT_FOUND` |
| `reconciliation.ts:1448` | `reconciliationService.readBudgetUsd(keyId, ownerRef, chainId)` (`:1439`) | devuelve el `budget` de la key de B en vez de `null` |
| `debit-capture.ts:212` | `captureDebitSignature({ intentId, ownerRef, … })` (`:152`) | lee el `buyer_wallet` del intent de B; si la firma recupera esa wallet, el veredicto pasa de `SIGNER_MISMATCH` a **`valid`** y se persiste una firma de débito `valid` contra el intent de otro dueño (`p_status`, `:285`) |
| `arbiter.ts:110` | `settleArbitrationOnChain({ intentId, ownerRef, … })` (`:175`) → `getOrCreateArbiterNonce:208` | `intent_id` es **PK** de `a2a_arbiter_nonces` (`supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql:6`, `database.types.ts:44-49` con `isOneToOne: true`), así que sin el filtro el read-first devuelve el nonce **de B** y A lo reusa en el `resolveDispute` on-chain en vez de derivar el suyo |
| `fee-split.ts:365` | `settleFeeSplits({ orchestrationId, recipients })` (`:287`) → `chargeLeg:344` | con una fila `(orch, role)` de otro dueño ya `charged`, sin el filtro el leg vuelve `already-charged` **con el `tx_hash` de esa fila**: el fee se da por cobrado y no se paga. El estado es alcanzable porque el UNIQUE es `(orchestration_id, recipient_role)` **sin `owner_ref`** (`…wkh136_fee_splits.sql:40`) |

⚠️ **Lo que hay que declarar y no inflar en el Grupo A**: ninguno de los 7 es un IDOR alcanzable
desde una ruta autenticada hoy.
- Para los cuatro de `arbiter`/`evidence` el camino de producción es `POST /session/:id/dispute`
  (`routes/payments.ts:339`), y `openDispute` compara el dueño **en JavaScript** antes de seguir
  (`arbiter.ts:606-608`), así que un `intentId` ajeno se rechaza con `OWNERSHIP_MISMATCH` antes de
  llegar a estas cuatro consultas.
- `readBudgetUsd` tiene **un solo llamador de producción**, `driftCheck:1402`, que le pasa el
  `ownerRef` sacado de la propia fila (`:1382`), y `driftCheck` está detrás del gate de admin.
- `fee-split.ts:365` recibe un `ownerRef` que **no viene del caller**: sale de `resolveRecipients`
  (`:215`, `:224`, `:238`), server-side por CD-6 del propio módulo (`:11-13`).
La propiedad que sí se prueba es **la de la función**: dado un par `(id, ownerRef)` que no se
corresponde, no entrega ni muta. Es defensa en profundidad con superficie de servicio, y decir que
previene un IDOR sería afirmar de más. Es la misma honestidad que SEC-03 le exigió a sus tres
sitios de `spend-policy` (`sdd.md:368-384`).

**Grupo B — fila inconsistente (2 sitios).**
Acá el filtro por dueño **no** es redundante con otro filtro, pero el estado que lo revela requiere
una fila cuyo dueño no coincide con el del recurso al que apunta su clave foránea. Ninguna
restricción de base lo impide (verificado: no hay CHECK ni FK compuesta que ligue los dos
`owner_ref`), pero la aplicación no lo produce.

| Sitio | Filtros de la cadena | Qué se necesita para matarlo |
|---|---|---|
| `evidence.ts:76` | `intent_id`, `owner_ref` sobre `a2a_payment_vouchers` | un voucher con `intent_id` del intent de A y `owner_ref` de B. Sin el filtro entra en `voucherCount` y en `vouchersTotalUsd` (`:85-89`), que son entradas de `classify` → **cambia el veredicto de la disputa** |
| `evidence.ts:96` | `session_id`, `owner_ref` sobre `a2a_receipts` | un recibo con `session_id` del intent de A y `owner_ref` de B. Sin el filtro entra en `receiptSettleTotalUsd` (`:116-119`), otra entrada del veredicto |

**AC-3 obliga a declarar esto por escrito** en el header del archivo y en el log, con la forma de
`task.ownership.test.ts:277-283`. Un test de estos dos presentado como aislamiento entre
inquilinos es exactamente la prosa que afirma de más que estas dos HUs existen para sacar del repo.

**Grupo C — entrelazado obligatorio (3 sitios).**
Los tres son escrituras de `fee-split.ts` cuya fila objetivo ya está determinada por
`(orchestration_id, recipient_role)`, que es el UNIQUE. En una sola pasada, con o sin el filtro por
dueño, la escritura toca **la misma fila**. Sólo se separan si la fila cambia de dueño entre la
lectura previa y la escritura.

| Sitio | Qué hay antes | Qué se afirma |
|---|---|---|
| `fee-split.ts:538` (UPDATE `charged` + `tx_hash`) | el SELECT de idempotencia (`:360-366`) y el INSERT (`:393`) | si la fila cambió de dueño después del INSERT, el `charged` con el `tx_hash` de A **no** se estampa sobre la fila de B |
| `fee-split.ts:618` (`markLegFailed`, UPDATE `failed`) | lo mismo, por la rama de error | ídem, con `status: 'failed'` y el `error_message` de A |
| `fee-split.ts:697` (`reverseFeeSplits`, UPDATE `reversed`) | **un pre-chequeo en JavaScript**: `:676-683` filtra `rows` por dueño en memoria y devuelve `ownership_mismatch` si no queda ninguna | si la fila cambia de dueño entre el SELECT de `:644` y el UPDATE de `:692`, el leg de B **no** pasa a `reversed` |

`reverseFeeSplits` **no tiene llamador de producción** — resuelto en el SDD de SEC-03, MI-2
(`sdd.md:669-673`), y coherente con su propio docblock («v1: NO se cablea a orchestrate/compose»,
`fee-split.ts:636`). Su test sigue valiendo como defensa en profundidad declarada, y baja de
prioridad dentro de la wave.

**Recuento: 7 (A) + 2 (B) + 3 (C) = 12.** ✓ Y 11 (SEC-03) + 12 = 23.

### 4.3 Las dos cosas que le faltan al falso compartido

`src/services/__tests__/owner-scoped-fake.ts` cubre todos los métodos que las 12 cadenas usan
(`select`, `insert`, `update`, `delete`, `eq`, `order`, `limit`, `single`, `maybeSingle`, el
thenable) — verificado cadena por cadena, incluida la de `debit-capture.ts:114-124`, que es la
única con `order` + `limit`. Le faltan dos cosas, las dos **aditivas**:

**(a) `onUpdateStart`.** El falso tiene `onDeleteStart` (`:267-274`) porque el único entrelazado de
SEC-03 era sobre un DELETE, y su propio docblock lo dice (`:54-55`). El Grupo C necesita el gemelo
sobre `update()` (`:247-252`), con la misma forma: correr el hook **después** de fijar el verbo y
**antes** de que se apliquen los filtros. Es el mismo patrón que ya está mergeado, no un
mecanismo nuevo.

**(b) Un modelo de UNIQUE para `a2a_fee_splits`.** El falso hoy hace `insert` empujando la fila sin
mirar nada (`:292-296`, `:335-339`). El sitio 1 (`fee-split.ts:365`) necesita que un INSERT sobre
un `(orchestration_id, recipient_role)` ya ocupado devuelva `{ code: '23505' }`, porque:
- **con** el filtro, el camino real es SELECT→null → INSERT→23505 → `in-progress` (`:404-407`);
- **sin** el modelo de UNIQUE, ese mismo camino sigue hasta `sign()`/`settle()` y hay que mockear
  el adapter de pagos para un test que no es sobre pagos.
Propuesta: un campo opcional `unique?: string[][]` en `TableSpec` (`:97-105`). Si el Dev decide
**no** agregarlo, tiene que declarar en el header que el fixture ejercita un camino que la base
real corta con un 23505, y mockear el adapter. Las dos salidas son aceptables; **lo que no es
aceptable es no decir cuál se eligió**.

⚠️ `owner-scoped-fake.ts` lo usan los 6 archivos de propiedad de SEC-03. Toda modificación es
**aditiva y con default inerte**: `onUpdateStart` arranca en `null` y `unique` en `undefined`, así
que ningún test existente cambia de comportamiento. El control es la suite completa verde antes y
después.

### 4.4 El 13.º sitio: `debit-capture.ts:120`

Está **fuera del corte** (el corte son 12 y CD-15 de SEC-03 prohíbe ampliarlo), pero es un
hallazgo de esta HU y va reportado, no corregido de callado:

- No figura entre los 23 de A1 porque **muere**: mutándolo, `debit-capture.test.ts` se pone rojo
  (§3.5, control negativo).
- Lo que lo mata es `expect(calls.eq).toContainEqual(['owner_ref', OWNER])`
  (`debit-capture.test.ts:533`): un **espía de argumento**. DT-1 de SEC-03 (`work-item.md:239-245`)
  dice por qué eso no alcanza: un espía pasa aunque el nombre de columna esté mal escrito, y ese
  error deja al dueño sin ver sus propias filas. Los dos dobles del archivo son `eq: () => builder`
  (`:79`, `:463`), o sea que **no** aplican el filtro.
- **Recomendación**: cubrirlo con el mismo fixture del sitio 12, en el mismo archivo nuevo, y
  anotar en el log que **no** forma parte de los 12 ni de la aritmética `11 + 12 = 23`. Es una
  línea de test más sobre un fixture que ya hay que montar; no cambia el corte.
- **Lo que NO hay que hacer**: tocar `debit-capture.test.ts`. Reemplazar su doble cambia el
  contrato de `calls.eq` del que dependen otros tests. Precedente: DT-6 de SEC-03
  (`sdd.md:426-432`) resolvió lo mismo con `agents.ownership.test.ts` dejándolo intacto.

### 4.5 `arbiter/evidence.test.ts` — el segundo archivo que se titula como lo que no mide

- `:4-5` (docblock): «Cubre la lógica determinística de readEvidence con **un doble de supabase
  fiel a la semántica de las 3 queries owner-guarded** (intent / vouchers / receipts)».
- `:44-45` (comentario): «Doble encadenable **fiel**».
- `:49`: `eq: () => b`. El doble **no aplica ningún filtro**; la respuesta la decide el `table` en
  `wireTables` (`:62-67`).
- `:186`: el test se titula «intent inexistente / **de otro owner** (PGRST116) → ArbiterError
  INTENT_NOT_FOUND» y lo que hace es devolver un `{ code: 'PGRST116' }` enlatado (`:188`). El
  fixture **no tiene dos dueños**: `OWNER` es la única constante de dueño del archivo (`:36`). Un
  fixture con un solo actor no puede refutar ningún filtro por dueño.

Es el mismo defecto que el AR de SEC-03 encontró en `routes/agents.ownership.test.ts`, y es lo que
explica por qué los tres sitios de `evidence.ts` sobreviven teniendo un archivo de test propio.

**Decisión (DT-1)**: **no se toca** `evidence.test.ts`. Los tres sitios se cubren desde
`src/services/arbiter/evidence.ownership.test.ts`, nuevo, con el falso compartido. Lo que sí se
hace es **una línea de comentario cruzada** en el header de los dos archivos diciendo qué verifica
cada uno — porque dos archivos de test del mismo módulo con garantías distintas es la próxima
confusión, y es el riesgo R-4 que SEC-03 ya registró. Corregir la prosa de `:4-5` y `:44-45`, que
afirma de más, queda como **TD del reporte de cierre**: es una edición sobre un archivo ajeno a
esta HU y hacerla acá amplía el corte.

### 4.6 Decisiones técnicas

- **DT-1 — No se tocan los tests preexistentes que afirman de más** (`evidence.test.ts`,
  `debit-capture.test.ts`, `fee-split.test.ts`, `arbiter.test.ts`). Archivo nuevo por módulo.
  Motivo medido: sus dobles exponen contratos (`calls.eq`, `mockState.selectQ`, `db.fromImpl`) de
  los que dependen decenas de tests. Precedente idéntico: DT-6 de SEC-03 (`sdd.md:426-432`).
- **DT-2 — Test de propiedad, no espía de llamada.** Se afirma «A no obtiene ni muta lo de B», no
  `expect(eq).toHaveBeenCalledWith('owner_ref', …)`. El espía queda como **backstop estructural en
  un solo test por archivo**, con el patrón `task.ownership.test.ts:333-358`, y sirve para
  **ubicar** cuál de N sitios se abrió, no para afirmar qué datos salieron. Motivo: DT-1 de SEC-03,
  y el 13.º sitio de §4.4 es la demostración viva de a qué se parece un sitio «cubierto» por un
  espía.
- **DT-3 — El falso se extiende, no se clona.** `onUpdateStart` y `unique` van a
  `owner-scoped-fake.ts`, aditivos y con default inerte (§4.3). Un segundo falso local en el
  archivo de fee-split es lo que la partición de SEC-03/SEC-04 existía para evitar
  (`sdd.md:707-708`).
- **DT-4 — Nivel de servicio, no de ruta.** Los 12 se prueban invocando la función exportada. Sólo
  `arbiter` tiene una ruta HTTP (`POST /session/:id/dispute`), y por su pre-chequeo en JS
  (`:606-608`) un test HTTP **no puede** poner en rojo ninguno de los 12: siempre corta antes. Un
  test HTTP acá sería un test que pasa por la razón equivocada.
- **DT-5 — El veredicto de mutación descuenta `G-08`/`G-09`.** §3.6, CD-16. Es la diferencia entre
  medir el comportamiento y medir la presencia textual del filtro, que es lo único que el guardián
  sabe hacer (su propio header lo declara, `:55-58`).
- **DT-6 — El 13.º sitio se cubre pero no entra al corte.** §4.4.

---

## 5. Constraint Directives

### Heredadas de WKH-SEC-03 (íntegras, y siguen aplicando)

- **CD-1 — PROHIBIDO** modificar cualquier línea de producción bajo `src/` que no sea un archivo de
  test. Si un test no puede ponerse en rojo sin tocar producción, se documenta y se escala (AC-6).
- **CD-2 — OBLIGATORIO** que todo fixture tenga dos `owner_ref` distintos, y que el falso **no
  filtre por dueño de oficio**. Es lo que `owner-scoped-fake.ts:22-29` declara por escrito.
- **CD-3 — OBLIGATORIO** que la evidencia de AC-5 sea **por sitio y por línea**. Una mutación más
  grande (renombrar la columna, borrar el bloque) da un KILLED falso.
- **CD-5 — PROHIBIDO** presentar el guardián como suficiente: verifica presencia textual, no el
  valor del filtro.
- **CD-6 — OBLIGATORIO** un control anti-vacuidad por test nuevo, en las dos direcciones: A obtiene
  **lo suyo** y **no** obtiene lo de B (`task.ownership.test.ts:261-264`). Un test que sólo afirma
  el `null` pasa igual si el fixture está vacío.
- **CD-7 — PROHIBIDO afirmar que un guard «impide» algo.** Cada afirmación va con el input concreto
  que la pone en rojo, y al lado el input que se le escapa.
- **CD-8 — OBLIGATORIO re-medir la línea base en el worktree antes de la primera mutación**, y
  citarla con su commit. La de esta HU es `5330 passed | 19 skipped (5349)` en `b7fa4e7`, y **no**
  es la de SEC-03.
- **CD-9 — OBLIGATORIO verificar la mutación antes de creerle al veredicto**: pegar la línea antes
  de tocarla y confirmar que es una consulta y no un comentario. **PROHIBIDO** elegir la línea con
  `grep … | head -1`.
- **CD-12 — OBLIGATORIO** el orden `editar → tsc → test → lint → commit`, **por wave**.
- **CD-15 — PROHIBIDO ampliar el corte.** Los 12 y nada más. Lo que aparezca «de paso» se anota
  como hallazgo (§4.4) y no se toca.

### Nuevas de este SDD, cada una con su medición

- **CD-16 — Un mutante cuyo único rojo sea `test/ownership-filter-guard.test.ts` cuenta como
  SURVIVED.** El guardián se pone rojo con los 12 mutantes **hoy, sin escribir un solo test**
  (§3.5): es el punto de partida, no el resultado. La fila del log tiene que nombrar el test de
  comportamiento que se puso rojo, y `G-08`/`G-09` se anotan aparte como colateral esperado.
- **CD-17 — OBLIGATORIO un control de parseo después de mutar y ANTES de correr la suite**
  (`./node_modules/.bin/esbuild <archivo> > /dev/null`). Medido en §3.6: borrar la línea entera de
  `fee-split.ts:538` da `1 file changed, 1 deletion(-)` —el antídoto que SEC-03 declaró
  suficiente— y rompe la sintaxis, tirando 22 archivos de test que se leen como un KILLED.
  **Preferir el reemplazo al borrado** cuando la línea lleva cola de sintaxis o cuando hay
  excepciones registradas más abajo en el mismo archivo.
- **CD-18 — PROHIBIDO escribir en cualquier archivo que se mergea la frase «se puede borrar y la
  suite queda verde»** para estos 12 sitios. Es **falsa** desde que SEC-03 se mergeó (C-1). La
  frase correcta es «quitándolo, el único rojo es el del guardián: ningún test de comportamiento se
  entera». Reincidente: `adversarial-review.md:77` (BLQ-BAJO-3) encontró esa misma frase sobrevivida
  en dos archivos de SEC-03.
- **CD-19 — PROHIBIDA la evidencia auto-confirmante.** Toda cita `archivo:línea` tiene que apuntar
  al **sujeto** de la afirmación. Reincidente: `adversarial-review.md:58` (BLQ-BAJO-2), donde la
  excepción citaba el `preHandler` de la ruta de reconciliación como gate de la ruta de arbitraje:
  quien lo verificaba encontraba `requireAdminTokenStrict` y estampaba OK sin haber mirado nunca la
  ruta real.
- **CD-20 — PROHIBIDO escribir un `archivo:línea` en el log que no haya salido de una salida
  capturada.** Si no está en una salida pegada, se dice de qué corrida salió o no se escribe.
  Reincidente: `220/auto-blindaje.md:9-23`.
- **CD-21 — OBLIGATORIO re-verificar al cierre toda cita a un archivo que la propia HU edita.**
  Reincidente: `220/auto-blindaje.md:25-36` (una nota de 4 líneas corrió la cita de `:212` a
  `:216`). Aplica en particular al header del guardián (AC-7) y al propio `mutation-log.md`.
- **CD-22 — PROHIBIDO apoyar un control en un número copiado de otro artefacto sin re-medirlo.**
  Reincidente: `220/auto-blindaje.md:38-48`. Incluye los números de este SDD: la línea base, los 41
  de la lista de excepciones y los 12 sitios se re-miden en el Environment Gate.
- **CD-23 — PROHIBIDO mutar con `perl`/`sed` sobre un patrón con plantilla.** `perl` con `\Q…\E`
  **interpola `${…}` igual**: el patrón no matchea, el archivo queda intacto, el proceso sale con
  `0` y la suite verde se lee como «el mutante sobrevive». Se muta con `python3` y
  `assert <patrón> in <línea>`.
- **CD-24 — OBLIGATORIO que toda modificación a `owner-scoped-fake.ts` sea aditiva y con default
  inerte**, y que la suite completa quede en la línea base exacta antes de escribir el primer test
  nuevo. Lo usan los 6 archivos de propiedad de SEC-03.
- **CD-25 — PROHIBIDO un fixture con un solo `owner_ref`**, y prohibido un test cuyo aserto sea
  sólo `toBeNull()`/`rejects` sin su gemelo positivo (CD-6). El caso vivo de por qué:
  `arbiter/evidence.test.ts:186` se titula «de otro owner» sobre un fixture de un solo dueño
  (`:36`) y un `PGRST116` enlatado (§4.5).

---

## 6. Waves

**W0 es serial y bloquea todo**: sin el falso extendido y sin la línea base re-medida, los tests de
W1..W3 no se pueden poner en rojo por el motivo correcto.

### Wave 0 — serial · el instrumento (aditivo) y la línea base

| Archivo | Acción |
|---|---|
| — | Environment Gate: línea base, existencia y texto de los 12 sitios, control negativo del instrumento (§8) |
| `src/services/__tests__/owner-scoped-fake.ts` | **aditivo**: `onUpdateStart` (gemelo de `onDeleteStart:267-274`) y `unique?: string[][]` en `TableSpec` → `23505` (§4.3). Default inerte (CD-24) |

Salida verificable de W0: la suite completa da **exactamente** `5330 passed | 19 skipped (5349)`.
Si cambia un número, el falso dejó de ser inerte y hay que volver atrás.

### Wave 1 — Grupo A, los 5 sitios baratos (AC-1) — paralelizable entre sí

| Archivo nuevo | Cubre |
|---|---|
| `src/services/arbiter/evidence.ownership.test.ts` | `evidence.ts:57` (Grupo A) |
| `src/services/arbiter.ownership.test.ts` | `arbiter.ts:1070`, `:1100` |
| `src/services/reconciliation.ownership.test.ts` | `reconciliation.ts:1448` |
| `src/adapters/escrow/debit-capture.ownership.test.ts` | `debit-capture.ts:212` (+ `:120` como extra declarado, §4.4) |

### Wave 2 — Grupo A caro + Grupo B (AC-1, AC-3)

| Archivo | Cubre | Declaración obligatoria |
|---|---|---|
| `src/services/arbiter.ownership.test.ts` | `arbiter.ts:110` | requiere montar la pila de `settleArbitrationOnChain` (`ESCROW_ARBITER_ENABLED`, chainKey, escrow, consent, decimals, secreto del nonce). Exemplar: `arbiter.test.ts:1664-1740` |
| `src/services/arbiter/evidence.ownership.test.ts` | `evidence.ts:76`, `:96` | **Grupo B**: el estado que los mata requiere una fila cuyo `owner_ref` no coincide con el del intent al que apunta. Va en el header, con la forma de `task.ownership.test.ts:277-283` |
| `src/services/fee-split.ownership.test.ts` | `fee-split.ts:365` | qué se eligió: `unique` en el falso, o mockear el adapter y declarar el camino no realista (§4.3b) |

### Wave 3 — Grupo C, el entrelazado (AC-2)

| Archivo | Cubre | Declaración obligatoria |
|---|---|---|
| `src/services/fee-split.ownership.test.ts` | `fee-split.ts:538`, `:618`, `:697` | la carrera no es alcanzable hoy en producción; y `reverseFeeSplits` (`:697`) **no tiene llamador de producción** (`fee-split.ts:636`, SEC-03 MI-2) |

### Wave 4 — evidencia y doctrina

| Archivo | Acción |
|---|---|
| `doc/sdd/221-…/mutation-log.md` | **AC-5**: una fila por sitio, con la línea pegada, el control de parseo, el rojo de comportamiento nombrado y `G-08`/`G-09` anotados aparte (CD-16) |
| `test/ownership-filter-guard.test.ts` (header, `:84-88`) | **AC-7**: el punto 8 hoy dice que estos 12 no tienen test de propiedad. Se reescribe con lo medido, **sin** afirmar de más y **sin** la frase prohibida por CD-18 |
| `src/services/arbiter/evidence.test.ts` (header, 1 línea) · `src/adapters/escrow/debit-capture.test.ts` (header, 1 línea) | el comentario cruzado de DT-1/§4.5 |
| `doc/sdd/221-…/_INDEX-row.md` | la fila, staged (convención de las HUs 212/214/217/220) |

---

## 7. Plan de tests

Cada test nombra el input que lo pone en rojo. Un test cuyo rojo no se pueda nombrar no entra.
El «input que lo pone en rojo» es siempre **quitar el filtro del sitio**, salvo donde se diga otra
cosa.

| ID | Archivo | Qué afirma | Grupo |
|---|---|---|---|
| **EV-01** | `evidence.ownership.test.ts` | `readEvidence(<intent de B>, 'owner-A')` tira `ArbiterError('INTENT_NOT_FOUND')`, con el intent **presente** en la tabla | A |
| **EV-02** | ídem | `readEvidence(<intent de A>, 'owner-A')` devuelve los valores de A (anti-vacuidad, CD-6) | A |
| **EV-03** | ídem | con un voucher `(intent de A, owner B)` en la tabla, `voucherCount` y `vouchersTotalUsd` cuentan **sólo** los de A | B |
| **EV-04** | ídem | con un recibo `(session = intent de A, owner B)`, `receiptSettleTotalUsd` no lo suma | B |
| **AR-01** | `arbiter.ownership.test.ts` | `revertDisputeToOpen(<intent de B>, 'owner-A')` deja la fila de B en `disputed` | A |
| **AR-02** | ídem | `revertDisputeToOpen(<intent de A>, 'owner-A')` la pasa a `open` (anti-vacuidad) | A |
| **AR-03** | ídem | `holdArbitration(<intent de B>, 'owner-A', meta)` deja la fila de B en `disputed` | A |
| **AR-04** | ídem | `holdArbitration(<intent de A>, 'owner-A', meta)` la pasa a `arb_hold` (anti-vacuidad) | A |
| **AR-05** | ídem | `settleArbitrationOnChain({ intentId: <de B>, ownerRef: 'owner-A', … })` **no** reusa el nonce persistido de B | A |
| **RC-01** | `reconciliation.ownership.test.ts` | `readBudgetUsd(<key de B>, 'owner-A', chain)` → `null`, con la key **presente** | A |
| **RC-02** | ídem | `readBudgetUsd(<key de A>, 'owner-A', chain)` → el budget de A (anti-vacuidad) | A |
| **DC-01** | `debit-capture.ownership.test.ts` | `captureDebitSignature({ intentId: <de B>, ownerRef: 'owner-A', … })` con una firma que recupera la `buyer_wallet` **de B** persiste `p_status: 'invalid'` / `p_reason: 'SIGNER_MISMATCH'` | A |
| **DC-02** | ídem | el mismo caso con el intent **de A** persiste `p_status: 'valid'` (anti-vacuidad) | A |
| **DC-03** | ídem | `readValidDebitSignature({ intentId: <de B>, ownerRef: 'owner-A', … })` → `null` con la firma presente. **Extra declarado, sitio 13.º, fuera de los 12** (§4.4) | — |
| **FS-01** | `fee-split.ownership.test.ts` | con una fila `(orch, 'creator')` de otro dueño en `charged` con `tx_hash '0xBBB'`, el leg de A **no** vuelve `already-charged` ni trae `0xBBB` | A |
| **FS-02** | ídem | entrelazado: la fila cambia de dueño entre el INSERT y el UPDATE `charged` → la fila de B **no** queda `charged` con el `tx_hash` de A | C |
| **FS-03** | ídem | entrelazado sobre la rama de fallo (`markLegFailed`) → la fila de B no queda `failed` con el `error_message` de A | C |
| **FS-04** | ídem | entrelazado en `reverseFeeSplits` → el leg de B no pasa a `reversed` | C |
| **BS-01..05** | uno por archivo nuevo | **backstop estructural**: mapear `fake.resolved()` a `scoped`/`UNSCOPED` y nombrar el sitio abierto. Ubica, no afirma qué datos salieron (DT-2, patrón `task.ownership.test.ts:333-358`) | — |

**Control anti-vacuidad transversal (CD-6)**: cada archivo tiene al menos un par «A obtiene lo
suyo» / «A no obtiene lo de B». Un archivo con sólo la mitad negativa pasa igual con la tabla
vacía.

---

## 8. Protocolo de mutación (AC-5, CD-3, CD-8, CD-9, CD-16, CD-17, CD-23)

**Por entrada, y en este orden:**

1. Árbol limpio (`git status --short` vacío) y línea base confirmada:
   `node ./node_modules/vitest/vitest.mjs run` → `5330 passed | 19 skipped (5349)`.
   **No** `npx vitest run`.
2. Pegar la línea **antes** de tocarla, y confirmar que es una consulta:
   ```python
   target = open(path).readlines()[N-1]
   print(target)
   assert ".eq('owner_ref'" in target
   assert not target.lstrip().startswith(('*', '//'))
   ```
   `python3`, no `perl` (CD-23), no `grep | head -1` (CD-9).
3. Mutar **por reemplazo** (preferido) o por borrado. Reemplazo obligatorio si la línea lleva cola
   de sintaxis (`fee-split.ts:538`, `:697`) o si hay excepciones registradas más abajo en el mismo
   archivo (`arbiter.ts`, `reconciliation.ts`, `fee-split.ts` — §3.6).
4. `git diff --stat -- <archivo>` → una sola línea tocada.
5. **Control de parseo (CD-17)**: `./node_modules/.bin/esbuild <archivo> > /dev/null`.
   Exit ≠ 0 ⟹ **mutante inválido**, se descarta y se rehace. Sin este paso, `:538` y `:697` dan un
   KILLED falso de 22 archivos.
6. Suite completa. Registrar el conteo crudo **y la lista de archivos rojos**.
7. **Descontar el guardián (CD-16)**: `G-08` y `G-09` van a fallar siempre. El veredicto sale de
   los rojos que **no** son `test/ownership-filter-guard.test.ts`. Cero rojos fuera del guardián ⟹
   **SURVIVED**.
8. `git checkout -- <archivo>` · `git status --short` vacío.
9. Fila del log: `archivo:línea` · texto exacto · mutación aplicada · `parse ok` · rojos de
   comportamiento (nombre completo del test) · rojos del guardián (aparte) · conteo crudo.

**Estado esperado al cierre**: los 12 pasan de `SURVIVED` (§3.5) a `KILLED por <test>`, con el
colateral del guardián anotado y no contado.

**Dos firmas de muerte idénticas = un mutante mal construido** (`217/auto-blindaje.md:155-165`). En
esta HU eso es más probable que de costumbre, porque `G-08`+`G-09`+`Test Files 1 failed` es la
firma común de los doce: la comparación tiene que hacerse **sobre los rojos de comportamiento**,
que son los únicos que distinguen un sitio de otro.

---

## 9. Missing Inputs

- **[resuelto]** ¿La lista de 12 es correcta? **Sí, medida contra el código** (§3.3, §3.5). Los
  rótulos «11/12» del work-item de SEC-03 estaban invertidos respecto de sus propias enumeraciones,
  y el SDD de SEC-03 ya lo corrigió (`sdd.md:401-403`). 11 + 12 = 23.
- **[resuelto]** ¿Cuáles necesitan entrelazado? **Tres**, los tres de `fee-split`: `:538`, `:618`,
  `:697`. **No** `arbiter.ts:1070`/`:1100`, contra lo que dice el AC-3 de SEC-03 (C-3, §4.2).
- **[resuelto]** ¿El falso tiene los hooks? Tiene `onDeleteStart` (`:267-274`); **`onUpdateStart`
  no existe** y su ausencia está declarada en `:54-55`. Hay que agregarlo (§4.3a).
- **[resuelto]** ¿`reverseFeeSplits` tiene llamador de producción? **No** (SEC-03 MI-2,
  `sdd.md:669-673`, coherente con `fee-split.ts:636`). Verificado de nuevo acá:
  `command grep -rn "reverseFeeSplits" src/ --include=*.ts` sin `*.test.ts` da sólo el propio
  `fee-split.ts` y una mención en un comentario de `fee-charge.ts:677`.
- **[no bloqueante]** **No se pudo verificar** si `scripts/eq-sweep.mjs` implementa el descuento del
  guardián (CD-16) y el control de parseo (CD-17). No lo leí; usé un guion propio. Si el Dev lo usa,
  tiene que confirmar las dos cosas **antes** de creerle un veredicto.
- **[no bloqueante]** **No se pudo verificar** que los 12 filtros funcionen contra Postgres real. El
  falso aplica los `.eq()` que el servicio pide; que PostgREST con `SUPABASE_SERVICE_KEY` haga lo
  mismo es una suposición del método. Es la misma limitación que SEC-03 declaró
  (`mutation-log.md:211-213`).
- **[no bloqueante]** Número de HU/directorio: **221**, el siguiente libre (`doc/sdd/220-…` es el
  máximo). Hay ramas sin mergear (WKH-325, WKH-326) que podrían haber tomado el número en sus
  propios worktrees; `_INDEX.md:195-206` documenta que las colisiones ya pasaron y se toleran.

---

## 10. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| **R-1** | **El Dev lee `Test Files 1 failed` como KILLED y cierra la HU sin escribir nada.** Es el riesgo mayor: los 12 mutantes ya «mueren» hoy | CD-16 + el protocolo de §8 paso 7 + la tabla de §3.5, que es literalmente el estado de partida con la salida pegada |
| **R-2** | El Dev borra la línea entera de `:538`/`:697`, ve 22 archivos rojos y escribe KILLED | CD-17 (control de parseo) + §3.6 con la salida del `PARSE_ERROR` pegada |
| **R-3** | Un test de Grupo B se presenta como aislamiento entre inquilinos | AC-3 + CD-25 + la declaración obligatoria en el header, con el exemplar `task.ownership.test.ts:277-283` |
| **R-4** | Se rompen los 6 archivos de propiedad de SEC-03 al extender el falso | CD-24: cambios aditivos con default inerte + la salida de W0 es la línea base exacta |
| **R-5** | `arbiter.ts:110` sale caro (pila de gates de escrow) y se cubre con un espía «para salir del paso» | DT-2 + está solo en W2, no bloquea el resto. Exemplar del montaje: `arbiter.test.ts:1664-1740` |
| **R-6** | Se toca `evidence.test.ts` / `debit-capture.test.ts` / `fee-split.test.ts` para «arreglar el mock» y se rompen tests ajenos | DT-1 + CD-15. La corrección de su prosa va como TD del cierre |
| **R-7** | Sobrevive en un archivo mergeado la frase «se puede borrar y la suite queda verde» | CD-18. Es el BLQ-BAJO-3 del AR de SEC-03, repetido |
| **R-8** | Conflicto de merge con las HUs en vuelo | Esta HU no toca `src/` de producción (CD-1). Superficie compartida: `test/ownership-filter-guard.test.ts` (sólo el header), `src/services/__tests__/owner-scoped-fake.ts` (aditivo) y `doc/sdd/_INDEX.md` (por eso la fila va en `_INDEX-row.md`) |
| **R-9** | El guardián queda verde y alguien lee eso como «los 23 cerrados» | El punto 8 del header (AC-7) es exactamente ese texto y hay que reescribirlo con lo medido — sin reemplazar una afirmación de más por otra |

## 11. Dependencias

- **Depende de**: WKH-SEC-03, **mergeada** (`b7fa4e7`). Sin el falso compartido y el guardián esta
  HU no existe.
- **Roce con WKH-SEC-02 (RLS real)**: ninguno de código. Y el argumento que **no** hay que hacer:
  RLS no vuelve redundantes estos filtros mientras el cliente use `SUPABASE_SERVICE_KEY`
  (BYPASSRLS), `CLAUDE.md:256-264`.
- **Fuera**: los 42 `supabase.rpc()` (declarados en el punto 9 del header del guardián, `:89-105`),
  otros repos, `m5-keys/`, desplegar, la base `caldz`.

---

## 12. Implementation Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Worktree creado desde `b7fa4e7`, rama propia | ✅ `wt-sec04`, `feat/221-wkh-sec-04-owner-ref-dinero-y-disputas` |
| 2 | Todos los `archivo:línea` citados abiertos con `Read` o salidos de una corrida pegada | ✅ |
| 3 | Exemplars verificados (existen, los leí) | ✅ §3.2, 11 de 11 |
| 4 | Línea base **medida** en el worktree, no citada | ✅ `5330 passed \| 19 skipped (5349)`, 10,4 s |
| 5 | Los 12 sitios verificados: existen, son consultas, ninguno comentario | ✅ §3.3 |
| 6 | Los 12 mutados de cero, con la salida pegada | ✅ §3.5 — **los 12 SURVIVED** al comportamiento |
| 7 | Control negativo del instrumento (puede producir un rojo de comportamiento) | ✅ `debit-capture.ts:120` §3.5 |
| 8 | Cada sitio clasificado por **qué escenario lo mata**, con la procedencia del identificador | ✅ §4.2 — 7 A / 2 B / 3 C |
| 9 | Las carencias del falso compartido identificadas | ✅ §4.3 — `onUpdateStart` y `unique` |
| 10 | Contradicciones con los artefactos de SEC-03, con su medición | ✅ 6, §1.1 |
| 11 | Lo que el AR de SEC-03 atacó, leído y traducido a CD | ✅ §3.7 → CD-18, CD-19 |
| 12 | Auto-Blindaje histórico leído y bajado a CD | ✅ §3.8 → CD-20, CD-21, CD-22 |
| 13 | CDs del work-item/SDD de SEC-03 heredados | ✅ CD-1..CD-15 relevantes |
| 14 | Cada AC con el input concreto que lo pone en rojo | ✅ §2.1, §7 |
| 15 | Protocolo de mutación con los dos antídotos nuevos | ✅ §8 (CD-16, CD-17) |
| 16 | `[NEEDS CLARIFICATION]` pendientes | **0** |

**Dos ítems que NO están verdes y se declaran**:
- **No se pudo verificar** si `scripts/eq-sweep.mjs` sirve para esta campaña (§9). No lo leí.
- **No se pudo verificar** el comportamiento contra Postgres real: toda la evidencia es contra el
  falso (§9). Es la misma limitación que SEC-03 declaró y no la resuelve esta HU.

**Veredicto: LISTO PARA F2.5 (Story File).**

---

## Anexo — comandos de reproducción

```bash
cd /home/ferdev/.openclaw/workspace/wt-sec04

# línea base (NO usar `npx vitest run`: colapsa la salida)
node ./node_modules/vitest/vitest.mjs run
#  Test Files  268 passed | 6 skipped (274)
#       Tests  5330 passed | 19 skipped (5349)

# un mutante, con los dos antídotos (CD-17 y CD-23)
python3 - <<'PY'
p, n, old = 'src/services/arbiter/evidence.ts', 57, ".eq('owner_ref', ownerRef)"
ls = open(p).readlines()
print(ls[n-1])                      # pegar ANTES de tocar (CD-9)
assert old in ls[n-1]               # python3, no perl (CD-23)
del ls[n-1]
open(p,'w').writelines(ls)
PY
git diff --stat -- src/services/arbiter/evidence.ts     # 1 file changed, 1 deletion(-)
./node_modules/.bin/esbuild src/services/arbiter/evidence.ts > /dev/null   # CD-17
node ./node_modules/vitest/vitest.mjs run
#  hoy: los ÚNICOS rojos son G-08 y G-09  ⟹  SURVIVED (CD-16)
git checkout -- src/services/arbiter/evidence.ts && git status --short

# control negativo: el instrumento SÍ puede producir un rojo de comportamiento
# (sitio 13.º, fuera del corte)
#   src/adapters/escrow/debit-capture.ts:120  →  debit-capture.test.ts T-7 rojo
```

⚠️ **No borrar la línea entera de `fee-split.ts:538` ni `:697`**: `git diff --stat` dice
`1 file changed, 1 deletion(-)` y el archivo deja de parsear (`PARSE_ERROR`, 22 archivos de test
caídos). Se reemplaza `.eq('owner_ref', ownerRef))` por `)` (§3.6).
