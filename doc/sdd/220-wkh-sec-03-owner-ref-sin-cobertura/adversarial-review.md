# Adversarial Review — WKH-SEC-03

**HEAD revisado**: `6c9ad1a` · **base**: `ef384b7` · **VEREDICTO: RECHAZADO** (1 BLQ-MEDIO, 3 BLQ-BAJOS)

> Persistido por el orquestador desde el reporte del agente adversario, que por configuracion no
> puede emitir archivos. Arbol verificado restaurado al terminar: `git status --porcelain` = solo
> `?? doc/audit/`, `git diff HEAD` vacio.

## Las 41 excepciones, una por una

Revisadas **las 41 contra el codigo**. **1 mal justificada** (BLQ-BAJO-2, replicada en 2 entradas).
Las otras 40 se sostienen. Se verificaron: los callers (`getKeyById`/`getParentKey` reciben
`claim.key_id`/`delegation.key_id`/`session.key_id`, **nunca** el request), los gates
(`requireAdminToken` opt-in vs `Strict` vs `ForTrace`, los tres con test de 401/503 preexistente),
las proyecciones (`registry.list()` devuelve `RegistryPublic` redactado; `identity.ts:421/471` traen
solo `erc8004_identity`) y los chequeos en JS (`agent.ts:580/701`, `arbiter.ts:606-608`,
`fee-split.ts:676` + UPDATE con `owner_ref` en `:697`).

**Cero IDOR vivos.** Ninguna clasificacion del censo esconde uno.

---

## BLQ-MED-1 · Scope incompleto (no drift)

`CLAUDE.md` es el archivo 16 de 17 de la tabla §5 del Story File (wave W4.3) y **no se toco**.

**Input**: `git diff --name-only ef384b7 | grep -i claude` -> vacio.

**Consecuencia**: `CLAUDE.md:205` sigue afirmando `registries | — (admin global) | N/A`, que el propio
censo midio **falso** (`database.types.ts:2567` = `owner_ref: string`). Y la tabla normativa que guia
a AR y CR sigue listando **4 tablas de 21**. Es la regla que se violo 23 veces; dejarla vieja es dejar
la causa.

`_INDEX-row.md` tampoco se actualizo (W4.4): sigue diciendo `in progress (F1 hecho)` y `18 tablas`.

## BLQ-BAJO-1 · Hay otra forma de cegar al guardian que deja los 4 controles verdes

Ataque directo a la defensa de M-G3. **Reproducido ejecutando**, no razonado:

1. En `test/ownership-filter-guard.scanner.ts:268-270` se condiciono el `withOwner.add(table)` para
   excluir `a2a_arbiter_nonces`, `a2a_inbound_tasks`, `a2a_key_spend_policies` y
   `a2a_payment_vouchers` — cuatro tablas cuyas cadenas estan **todas filtradas hoy**, asi que el
   conteo `UNFILTERED` se queda en 41 y nada se mueve. Resultado: `Tests 10 passed (10)`.
2. Con el mutante puesto, se agrego a `src/services/spend-policy.ts` una cadena real sin filtro:
   `supabase.from('a2a_key_spend_policies').select('*').eq('key_id','x')`. Resultado: **10/10 verde
   igual**. El guardian quedo ciego a una tabla de politica de gasto.
3. **Control**: con el scanner sano, esa misma cadena pone rojo `G-08`
   (`src/services/spend-policy.ts:230 · a2a_key_spend_policies · select`) y `G-09`.

**La causa**: los pisos de G-01 (`>= 50` / `>= 15`) y G-02 (`>= 90` / `>= 60`) tienen holgura de sobra
para absorber una degradacion **parcial** de la derivacion, que es el modo de falla mas probable de un
parser que "casi funciona". El control de armado protege contra el conjunto vacio, no contra el
conjunto sesgado.

**Sugerencia del revisor** (no implementada): fijar el conjunto esperado con un numero exacto
revisable, o exigir que **toda tabla nombrada por una cadena resuelta** este en `OWNER_TABLES`.

## BLQ-BAJO-2 · Una excepcion mal justificada, y el puntero es AUTO-CONFIRMANTE

`test/ownership-filter-guard.exceptions.ts:274` y `:284` (sitios `arbiter.ts:1237` y `arbiter.ts:1270`,
`resolveHold`) citan **`dashboard.ts:630`** como su gate.

Esa linea es el `preHandler` de `POST /api/reconciliation/:intentId/resolve` — llama a
`reconciliationService.resolveIntent` en `dashboard.ts:633`. **No** es la ruta de arbitraje, que vive
en `dashboard.ts:515-517`.

**Por que es peor que un typo**: el puntero es auto-confirmante. Quien vaya a verificarlo encuentra
`requireAdminTokenStrict` en `:630`, ve lo que esperaba ver, y estampa OK **sin haber mirado nunca la
ruta real**. La conclusion de seguridad igual se sostiene (la ruta de arbitraje tambien es `Strict`,
`:517`), pero la evidencia que la respalda apunta a otro lado.

El mismo error esta en `censo-owner-ref.md:173`.

**Convencion confirmada por contraste**: las otras 11 entradas `admin-cross-tenant` citan
correctamente la linea del `preHandler` (`:477`, `:598`, `:680`, `:742`, `:424`, `:390`).

## BLQ-BAJO-3 · La correccion de N-2 no es exacta, y sobrevive en dos archivos que SI se mergean

`mutation-log.md` §N-2 corrigio la afirmacion "borras la linea y la suite queda identica" para los
tres sitios de `spend-policy`. Pero la misma frase falsa quedo textual en:

- `src/services/spend-policy.ownership.test.ts:24-25` — *"`spend-policy.ts:163`, `:190` y `:219` se
  pueden borrar hoy y la suite entera queda verde (medido en `ef384b7`)"*
- `test/ownership-filter-guard.test.ts:10` — *"Habia 23 de esos filtros que NINGUN test miraba"*.
  Son **20**: tres ya tenian espia.

**Repro**: `git show ef384b7:src/services/spend-policy.test.ts` ya contiene los espias en `:266/292`,
`:299/311`, `:332/344`. Borrando `spend-policy.ts:163` hoy, `spend-policy.test.ts` da
`1 failed | 17 passed` con `× AC-7: filters by key_id and owner_ref`.

Es el defecto exacto que esta HU existe para sacar del repo, escrito en el archivo del guardian.

---

## Lo que se verifico del equipo y SE SOSTIENE

1. **M-G3 reproducido**: `G-08` queda verde al vaciar el conjunto, y lo cazan G-01+G-02+G-09. El log
   lo declara bien.
2. **N-2 es exacta** en cuanto a que test preexistente muere (medido).
3. **Ningun mutante tenia a G-08/G-09 como unico asesino.** Se corrieron las 11 mutaciones de
   produccion una por una ejecutando **solo el test de su propio sitio**, sin el guardian: las 11
   mueren ahi (`receipt` 1/2 · `agent:549` y `:715` 1/3 c/u · `transform:234` 6/6 · `:278` 1/6 ·
   `payments:384` 1/2 · `spend-policy` x3 · `inbound-task:316` 1/4 · `:338` 2/4), con
   `1 file changed, 1 deletion(-)` en cada una y las 11 lineas verificadas antes de borrar.
4. **El falso compartido APLICA los filtros**, no los registra: `owner-scoped-fake.ts:131-135`,
   `filters.every(([c,v]) => row[c] === v)`. Y `unknownColumn` hace ruidoso el `42703`.
5. **Cero produccion tocada**: `git diff ef384b7 -- src/` da 9 archivos, todos `*.test.ts` o
   `__tests__`, y los 2 preexistentes modificados son **solo comentarios**.
6. **El censo reproducido con instrumento propio**: 101 cadenas / 46 con filtro / 55 sin / 0 no
   resolubles. **Coincide exacto.**
7. `biome check src/` limpio · `tsc --noEmit` y `tsc -p tsconfig.build.json` limpios · `--listFiles`
   confirma que el falso **no** entra a `dist/` · suite `268 passed | 6 skipped (274)` ·
   `5327 passed | 19 skipped (5346)`.

## MENORes

- **MNR-1 · el noveno agujero, no declarado.** `supabase.rpc(...)` esta **entero** fuera del universo
  del guardian, con **30+ call sites sobre el camino del dinero** (`budget.ts` x6,
  `payment-intent.ts` x7, `arbiter.ts` x6, `reconciliation.ts` x3, `refund-outbox.ts`...). Y las
  tablas con dueño **transitivo por FK sin columna propia** (`a2a_solana_settle_intents`, 2 cadenas,
  `intent_id` sin filtro) tampoco entran. Ninguna de las dos clases figura en la lista "QUE NO
  CUBRE". **Ningun IDOR vivo ahi hoy**: `readSettleIntent` solo lo llama `payment.ts:372`, interno.
- **MNR-2** · G-10 no valida `table`/`verb` de la excepcion contra la cadena real. **Repro**: se puso
  `table:'registries', verb:'delete'` en la entrada de `receipt.ts:192` -> `10 passed (10)`. La clave
  del match es solo `file:line`.
- **MNR-3** · `scripts/eq-sweep.mjs:177-199` muta produccion in-place sin `try/finally` ni handler de
  `SIGINT`. Un Ctrl-C durante el barrido de ~22 min deja un `.eq('owner_ref', ...)` borrado en el
  arbol. Mitigado: G-08 lo caza en el siguiente `npm test`.
- **MNR-4** · punteros cerca-pero-no-exactos dentro de razones: `agent.ts:318` cita `:571` para la
  comparacion, que esta en `:580`; `fee-split.ts:645` cita `:675`/`:691`, reales `:676`/`:697`. No
  cambian ninguna conclusion.
- **MNR-5** · el docblock de `maskNonCode` (`scanner.ts:26-28`) dice que la heuristica incluye
  `return`, y `regexCanStart()` (`:96-97`) no lo incluye. Poblacion hoy 0: no hay `return /` en
  `src/` no-test.

## Categorias

| Eje | Veredicto |
|---|---|
| Security | BLQ-BAJO-2 |
| Test Coverage | BLQ-BAJO-1, BLQ-BAJO-3, MNR-2 |
| Scope | BLQ-MED-1 (incompleto, no drift) |
| Error Handling · Data Integrity · Performance · Integration · Type Safety | OK |
| Destructive Migrations · Cache Invalidation | N/A |
| RPC SECURITY DEFINER | N/A en el diff — ver MNR-1 |

**Orden del fix-pack**: BLQ-MED-1 -> BLQ-BAJO-1 -> BLQ-BAJO-2 -> BLQ-BAJO-3.
