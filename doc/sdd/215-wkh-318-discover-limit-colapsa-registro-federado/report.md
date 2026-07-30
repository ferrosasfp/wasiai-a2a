# Report — HU WKH-318 `limit` colapsa el registro federado en `/discover` (y la respuesta lo niega)

## Resumen ejecutivo

Pedíamos 200 agentes, el registro federado cortaba en 100, devolvía HTTP 400, el
fanout se tragaba el error con `.catch(() => [])`, y la respuesta **seguía
afirmando que habíamos consultado los dos registros**. Medido en producción el
2026-07-30 contra `https://wasiai-a2a-production.up.railway.app`:
`/discover?limit=N` devolvía **3 de 23 agentes para cualquier valor de `N`**,
incluso `limit=200`, con `registries: ["WasiAI","self-published"]` mintiendo
sobre las dos fuentes. **Los 3 sobrevivientes eran exactamente los 3 agentes del
pipeline de Chaski** (`remit-kyc-validator`, `remit-corridor-fx-solana`,
`remit-cashout-payout-solana`), porque son los únicos self-published — Chaski
seguía funcionando por coincidencia, no por diseño.

Este corte (**A = W0+W1+W2**) no arregla el fetch federado (eso es el corte B,
W3+W4, no empezado). Arregla que la falla deje de reportarse como éxito:
`registries` pasa a listar sólo las fuentes que efectivamente aportaron filas,
y la respuesta gana `sources[]` + `catalogStatus` como señal explícita y
verificable de degradación. Durante el fix-pack post-AR se descubrió que la
primera implementación cambiaba una mentira por otra (declaraba `complete`
sobre un catálogo truncado sin poder probarlo); la corrección introdujo un
cuarto estado, `unverified`, que se gana por descarte en vez de por evidencia
falsa.

**Status final: DONE (corte A).** AR, CR y F4 aprobados. `tsc --noEmit` limpio,
suite **4342 passed / 0 failed / 19 skipped**, **16/16 mutantes KILLED** con
evidencia en `mutation-log.md`, `biome` limpio en 424 archivos. F4 confirmó
contra la base real (bdwv, lectura, sin tocar la columna `auth`) que la
migración **no está aplicada** — ni `nextCursorPath` ni `maxLimit` existen en el
schema — y que por eso el código cae a `unverified` en vez de mentir: es la
propiedad del corte, verificada contra la realidad, no una promesa de código.

**El corte B (W3+W4, devolver los 20 agentes federados y el rechazo con
dinero) NO se empezó.** No mergear ni pushear ni aplicar migraciones — decisión
del founder.

---

## Pipeline ejecutado

- **F0+F1** (`nexus-analyst`): `work-item.md` — causa raíz medida con 7 eslabones
  archivo:línea, más un hallazgo lateral (techo de 20 agentes por falta de
  paginación `next_cursor`) y el impacto en el money-path de `/compose` y
  `/orchestrate`. Gate confirmado el 2026-07-30.
- **F2** (`nexus-architect`): `sdd.md` — `SPEC_APPROVED: sí — 2026-07-30
  (orquestador, delegado por Fernando)` (`sdd.md:3`). Sizing QUALITY, corte A/B
  explícito.
- **F2.5**: `story-HU-318.md` (2076 líneas) — contrato completo con checklist
  anti-alucinación, 10 CDs propias + 18 heredadas, mapa AC→test, disciplina de
  mutación (§9) y guía de orden de merge contra WKH-313/315 (§10).
- **F3** (`nexus-dev`): 3 waves del corte A (W0 contratos, W1 honestidad del
  fanout federado, W2 detección de truncamiento), más un fix-pack post-AR
  (BLQ-1, BLQ-2) y una tanda de correcciones MENOR (MNR-C/D/E/G, MNR-F). 25
  archivos de producción/test tocados dentro del corte A, +1805/−49 líneas.
- **AR** (`nexus-adversary`): **APROBADO tras fix-pack.** Dos BLOQUEANTEs
  encontrados y corregidos (ver "Hallazgos finales"), más hallazgos MENOR
  documentados como precondiciones del corte B (`backlog.md`) y una decisión
  de producto escrita a pedido del revisor (`decisiones.md`, D-1).
- **CR** (`nexus-adversary`): **APROBADO.** Exigió que el contrato escrito
  (story file) dijera lo mismo que el código después del fix-pack — de ahí la
  sección "ENMIENDA DE F3" al tope de `story-HU-318.md` y las correcciones
  in-situ marcadas `ENMIENDA F3` en §2.2, W1.4, W1.6 y TD-318-2.
- **F4** (`nexus-qa`): **APROBADO.** `tsc --noEmit` limpio, `biome` 424
  archivos limpio, suite completa **4342 passed / 0 failed / 19 skipped**,
  **16/16 mutantes KILLED** (`mutation-log.md`), CD-11 verificado como única
  expresión de completitud (`grep -rn "catalogStatus ===\|catalogStatus !=="
  src/` → un solo hit, `lib/discovery-sources.ts:104`), cero drift entre el
  story file y el árbol, y verificación read-only contra bdwv de que la
  migración no está aplicada (consistente con el `unverified` observado).

---

## Acceptance Criteria — resultado final (corte A)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (camino feliz con `limit`) | **PARCIAL — honesto, no completo** | El total sigue en 3 con `limit` (el fetch federado no se arregla en este corte); lo que cambia es que la respuesta deja de mentir sobre por qué. Completar AC-1 de verdad depende de W3 (clamp), no implementado. |
| AC-2 (registro sin `limitParam`) | PASS | Cubierto por el diseño existente de `queryRegistry`; sin cambios de comportamiento en el camino sin `limit` (AC-7). |
| AC-3 (fetch federado que falla) | PASS | `T-SRC-01`, `T-SRC-03`, `T-SRC-04` (4 casos: `timeout`, `circuit_open`, `ssrf_blocked`, `bad_payload`) — `src/services/discovery.sources.test.ts`. Mutantes M1, M2, M3, M4 KILLED. |
| AC-4 (honestidad de `registries`/`excluded`) | PASS | `registries` se calcula desde las fuentes que aportaron filas, no desde la config (`discovery.ts:481-484` post-fix). `T-SRC-02`, `T-SRC-06`, `T-SRC-07` (guard CD-7: no se compara consigo mismo). Mutantes M1, M2b KILLED. |
| AC-5 (pool de `/compose`) | **DIFERIDO a W3** | Test mapeado (`T-CLAMP-04`) no existe todavía — pertenece al corte B. |
| AC-6 (`/orchestrate` mismo defecto) | **DIFERIDO a W3/W4** | Test mapeado (`T-ORCH-RETRY`) no existe todavía. |
| AC-7 (no-regresión sin `limit`) | PASS | `T-TRUNC-05` (corte A) — camino sin `limit` byte-idéntico. `T-CLAMP-02` es del corte B. |
| AC-8 (evidencia contra producción) | PASS | F4 corrió el comando de §8 del story file contra el entorno desplegado y confirmó que sin la migración aplicada el código reporta `unverified` en vez de `complete` — el comportamiento honesto, verificado contra la realidad. |
| AC-9 (rechazo sin débito neto) | **NO IMPLEMENTADO — W4** | Money-path estricto, fuera de este corte. |
| AC-10 (default sirve parcial, sin I/O extra) | **NO IMPLEMENTADO — W4** | Fuera de este corte. |

---

## Hallazgos finales

- **BLOQUEANTES**: 2, ambos **resueltos** en el fix-pack (commit `61a913f`):
  - **BLQ-1**: `state: 'ok'` colapsaba dos semánticas — *"respondió y trajo
    todo"* vs. *"respondió y no hay forma de saber si trajo todo"* — y elegía
    la primera por descarte. Era el caso de producción (el registro real se
    siembra sin `nextCursorPath`). Fix: cuarto estado `unverified`, `ok` se
    gana con evidencia positiva.
  - **BLQ-2**: la fuente local (self-published) seguía degradando a `[]` en el
    `catch` del SELECT y desaparecía de `sources` en vez de reportarse como
    `failed` — el mismo bug que la HU ataca, del lado local, y sobre la fuente
    que carga los tres agentes de Chaski.
- **MENORes**: resueltos los de forma (MNR-C/D/E/G — commit `ac90288`; MNR-F —
  la evidencia de mutación pasa a vivir en el repo, commit `c81e790`). Los de
  fondo quedan **aceptados como deuda, en `backlog.md`**, marcados
  explícitamente como **precondiciones del corte B**: B-5 (la fuente local
  nunca puede reportar truncamiento — argumento de construcción en comentario,
  no evidencia), B-1 (`?registry=` sin match devuelve `complete` vacío), B-6
  (la evidencia de completitud la auto-declara el registro que se está
  midiendo). Detalle completo abajo.

---

## Auto-Blindaje consolidado

*(copiado íntegro de `auto-blindaje.md`, 10 entradas, sin resumir)*

**[Wave 0] El worktree no tenía `node_modules`.** `npx tsc --noEmit` resolvía
un `tsc` externo al worktree y devolvía 53 `TS2307` que parecían baseline rota.
Causa real: `wt-318` es un `git worktree` nuevo, no comparte `node_modules`.
Fix: `npm ci` en el worktree. Aplicar en cualquier HU que arranque en worktree
nuevo (`wt-313`, `wt-315`, `wt-319` con el mismo riesgo): verificar que
`node_modules/` existe antes de leer una baseline como evidencia de nada.

**[Wave 0] El criterio de terminado de W0 era inalcanzable como estaba
escrito.** Hacer `sources`/`catalogStatus` requeridos rompía dos constructores
de producción (no sólo fixtures). Fix: el early-return se implementó con su
forma FINAL de W1.4 desde W0; el `return` del pipeline se dejó **rojo a
propósito** en vez de rellenarlo con un valor inventado (`catalogStatus:
'complete'` habría sido la mentira exacta que la HU existe para matar). W0 se
commiteó con 1 error de `tsc` declarado en el mensaje del commit.

**[Wave 0] El parcheador mecánico no distingue test de producción.** El script
que insertaba los literales de `DiscoveryResult` se manejó por las posiciones
que reporta `tsc`, que también apunta a producción, y parchó
`src/services/discovery.ts` con el mismo valor plano que los fixtures. Se
revirtió a mano tras revisar el `git diff` antes de cerrar la wave. Aplicar:
todo refactor mecánico masivo se revisa por diff, con más cuidado en `src/`
que en `*.test.ts`.

**[Wave 1] El mock de DNS desactivaba el guard que el test decía probar.**
`T-SRC-04/ssrf_blocked` daba `'unknown'`. El mock resolvía TODO host
(incluido un IPv4 literal) a una IP pública, así que `127.0.0.1` pasaba el
bloqueo y el fallo terminaba siendo un `Error` genérico del propio helper de
fetch — el test pasaba por el camino equivocado y habría dado verde a un
clasificador roto. Fix: el mock replica la semántica real de `dns.lookup`.

**[Wave 1] `tsc` no atrapó todos los call-sites del tipo que cambié.** Cambiar
`queryRegistry` de `Promise<Agent[]>` a `Promise<RegistryFetchOutcome>` rompió
dos tests; `tsc` marcó uno solo. El otro usaba `toEqual`, que acepta `any` y no
propaga el tipo del sujeto — lo cazó la suite, no el compilador. Aplicar:
migrar el tipo de retorno de una función exportada se verifica con `grep` del
nombre, no con la lista de errores de `tsc`; la wave cierra con `tsc` limpio
**y** suite verde (precedente inverso: WKH-196).

**[Fix-pack AR, BLQ-1] Maté el colapso de tres valores y dejé vivo el de dos.**
Escribí la detección de truncamiento como "buscar evidencia de que falta algo,
y si no la encuentro, está completo" — un default que es una afirmación
disfrazada de ausencia. Además falsifiqué una afirmación propia en un commit
("el código falla en la dirección segura" — la inercia era cierta, la
dirección no: fallaba sobre-declarando completitud). Fix: invertir la carga de
la prueba, `ok` exige evidencia positiva. Aplicar: cuando un tipo tenga un
valor "todo bien", preguntar qué lo prueba; si la respuesta es "que no
encontré nada malo", hay un estado escondido sin respaldo.

**[Fix-pack AR, BLQ-2] Apliqué la regla nueva a las fuentes remotas y me
olvidé de la local.** El `catch` del SELECT de self-published seguía
degradando a `[]`, indistinguible de "no hay agentes". Causa: tratar "el
fanout federado" como el único lugar del problema porque ahí estaba el
`.catch` que el work-item nombraba; la fuente local entra por otro `try/catch`
250 líneas más arriba. Aplicar: cuando una HU introduce una regla general,
enumerar TODAS las fuentes por las que entran datos, no sólo la que el bug
original nombraba.

**[Post-fix-pack] La misma regla se me escapó TRES veces, cada vez en un borde
distinto.** La regla "toda fuente declara cómo le fue" se aplicó al fanout
federado (W1), no llegó a la fuente local (BLQ-2), y una vez arreglada esa
fuente, no llegó a su *completitud* (B-5, hallazgo posterior del AR: la fuente
local declara `ok` incondicionalmente, justificado por un comentario en vez de
evidencia — y si PostgREST aplica `db-max-rows`, ese `ok` sería falso en
silencio; grep en todo el árbol de `max_rows|max-rows|Content-Range|.range(`:
cero hits). No se arregló en el corte A (toca 7 tests), queda como **B-5** en
`backlog.md`. Aplicar: enumerar las instancias de una regla nueva ANTES de
implementarla, y desconfiar de todo `state`/`status` asignado
incondicionalmente.

**[Waves 1-2] Dos nominaciones de mutante del story file no se sostenían.**
M2b estaba nominado a `T-SRC-05`, que no lo mata (los que lo matan de verdad
son `T-SRC-02`, `T-SRC-01`/`T-SRC-07`); `T-SRC-06` decía "11 campos previos"
cuando lo medido son 12. Corregido con evidencia medida, no inferida del
diseño. Aplicar: una tabla "mutante → test que lo mata" escrita junto al
diseño es una hipótesis, no una medición.

**[Wave 0, calibración] El número de fixtures estimado no era el medido.** El
story file estimaba ~61 sitios en 17 archivos; lo medido con `tsc` fue 51
sitios en 12 archivos (`setup.ts` no aparece — su literal no se
type-checkea). Aplicar: medir con el compilador antes de presupuestar,
reportar el número medido, no repetir el estimado como si se hubiera
verificado.

---

## Archivos modificados (corte A, `main...HEAD`)

**Producción**
- `src/types/index.ts` (+173) — `DiscoverySourceState`, `CatalogStatus`
  (4 valores c/u), extensión de `DiscoveryResult`, `RegistrySchema.discovery`.
- `src/lib/discovery-sources.ts` (**NUEVO**, +128) — módulo leaf,
  `isCatalogComplete()` (CD-11, único punto de verdad).
- `src/services/discovery.ts` (+280/−~30) — fanout federado, fuente local,
  `queryRegistry`, cálculo de `registries`, detección de truncamiento.
- `src/routes/discover.ts` (+24, sólo JSDoc) — contrato público documentado.
- `src/routes/capabilities.ts` (+12) — campos aditivos en el payload.

**Migraciones (bdwv, NO aplicadas)**
- `supabase/migrations/20260730010000_wkh318_registry_next_cursor_path.sql` (+19)
- `supabase/migrations/20260730010000_wkh318_registry_next_cursor_path_down.sql` (+18)

**Tests**
- `src/lib/discovery-sources.test.ts` (**NUEVO**, +141)
- `src/services/discovery.sources.test.ts` (**NUEVO**, +504)
- `src/services/discovery.truncation.test.ts` (**NUEVO**, +273)
- `src/services/discovery.ssrf.test.ts` (+22), `src/services/orchestrate.test.ts` (+86),
  `src/routes/capabilities.inbound-chains.test.ts` (+97), `src/routes/discover.test.ts` (+12),
  `src/routes/discover.minreputation.test.ts` (+8), `src/__tests__/e2e/setup.ts` (+25),
  y 8 archivos más con ajustes de fixtures (`+1..+4` líneas cada uno):
  `src/__tests__/e2e/compose-flow.test.ts`, `src/mcp/tools/discover-agents.test.ts`,
  `src/services/compose.chain-flow.test.ts`, `src/services/compose.field-mapping.test.ts`,
  `src/services/compose.stranded.test.ts`, `src/services/compose.test.ts`,
  `src/services/money-path.resilience.test.ts`, `src/services/orchestrate.billing.test.ts`,
  `src/services/orchestrate.quote-billing.test.ts`.

**Total medido**: 25 archivos de código/test/migración, **+1805/−49** líneas
(`git diff --stat main...HEAD`, excluyendo `doc/sdd/`). Suma completa del
worktree incluyendo documentación: 32 archivos, +5408/−49.

---

## Decisiones diferidas a backlog

Tres precondiciones del corte B, todas caminos por los que `catalogStatus`
termina en `complete` **sin evidencia positiva** — con el corte B les monta
encima un rechazo con dinero (`requireCompleteCatalog: true` ⇒ 503 +
reembolso), así que dejarlas sin resolver ahí sí mueve plata sobre una
afirmación sin respaldo:

- **B-5** — la fuente local (self-published) declara `state: 'ok'`
  incondicionalmente, justificada por un comentario ("es un SELECT sin
  `limit`") en vez de por evidencia en la respuesta. Repro del AR: 5000 filas
  ⇒ `complete`, mientras el mismo volumen por el camino federado da
  `unverified`. Sin lectura de `Content-Range`/`count` ni pineo de
  `db-max-rows`, un tope de PostgREST haría ese `ok` falso en silencio.
- **B-1** — `?registry=` filtra por `id` pero la respuesta publica `name`; un
  caller que reusa `registries[0]` de la propia respuesta de la API cae en un
  agujero que devuelve `{"total":0,"catalogStatus":"complete"}` con HTTP 200.
- **B-6** — las dos evidencias de completitud (`next_cursor` vacío, página no
  llena) las controla el propio registro que se está midiendo; un registro
  hostil puede devolver página llena + `next_cursor: null` y blindarse contra
  la heurística. El propio código ya tenía el argumento escrito, un nivel más
  arriba: *"un filtro de calidad cuyo valor lo controla la parte que se está
  filtrando no filtra nada"* (`discovery.ts:510-518`).

Además: **B-2** (nota de seguridad sobre `nextCursorPath`, corregida — el
techo del vector es el mismo que el de un registro hostil común, no es la vía
que importa), **B-3** (clamp silencioso del upstream, lo cierra W3 por
construcción), **B-4** (la migración de `nextCursorPath` es precondición de
*deploy* del corte B, no del A — el corte A es desplegable sin ella y
simplemente reporta `unverified`), y **D-1** (decisión ya tomada, no backlog:
`sources[].failure` se publica en `/discover` anónimo — ver `decisiones.md`).

**No se creó ningún ticket WKH nuevo.** Los hallazgos B-1/B-5/B-6 quedan
atados al corte B de esta misma HU (W3/W4), no a HUs separadas.

---

## Lo que queda abierto, con su nombre

- **W3 y W4 no se empezaron**, por decisión de corte. No es trabajo
  incompleto: es el alcance declarado del corte A desde el work-item (DT-1).
- **Lo que el corte A NO cierra**: `/orchestrate` sigue diciendo "ningún
  agente cumple esta capacidad" cuando el catálogo pudo venir incompleto — es
  W4 (money-path estricto), está declarado en `story-HU-318.md` §11
  (TD-318-1, TD-318-2, TD-318-3), y esta HU no lo empeoró.
- **La incógnita sin cerrar**: si bdwv aplica un tope de filas por
  configuración (`db-max-rows`) sobre el SELECT de la fuente local. Grep en
  todo el árbol de `max_rows|max-rows|Content-Range|.range(`: cero rastros —
  ni se lee el header ni está pineado el valor. Parte de B-5.
- **D-1** (publicar `sources[].failure` en `/discover`, endpoint sin auth):
  costo aceptado por escrito en `decisiones.md`, con gatillos de revisión
  explícitos (si `/discover` gana niveles de auth, si el enum de `failure`
  crece, o si una auditoría lo levanta con evidencia de impacto real).

---

## Orden de merge

- **Sin roce con WKH-315** (cero archivos en común, verificado con
  `git diff --stat`).
- **Roce con WKH-313** en `src/types/index.ts` y `src/services/discovery.ts`
  (separables por línea, merge limpio esperado) y **conflicto textual casi
  seguro** en el JSDoc de `src/routes/discover.ts` (313 edita el mismo
  docstring en `69-77`/`76-78`) — **sólo documentación, cero lógica en
  juego**. Este corte toca únicamente el JSDoc de `71-77` en ese archivo.
- **Aviso para quien mergee segundo**: `queryRegistry` ya no devuelve
  `Agent[]` sino `Promise<RegistryFetchOutcome>` (`results` pasó a llamarse
  `outcomes`). Hay call-sites que compilan contra la forma nueva pero afirman
  sobre la vieja usando `toEqual`/`toMatchObject` — el compilador no los caza
  (ver auto-blindaje, Wave 1). Guía completa de re-anclaje línea por línea en
  `story-HU-318.md` §10.
- **Recomendación del story file**: mergear el corte A de 318 primero (cambio
  más chico, no toca el money-path), o dejar 313 primero y re-anclar 318 con
  la guía de §10. La decisión es del orquestador/founder.

---

## Lecciones para próximas HUs

1. **Un default silencioso es una afirmación disfrazada de ausencia.** Todo
   valor "todo bien" de un tipo tiene que ganarse con evidencia positiva; si
   la única prueba disponible es "no encontré nada malo", hay un estado
   escondido sin respaldo — es la lección central de BLQ-1, y ya es la tercera
   vez que este patrón aparece en el proyecto en distintas superficies.
2. **Una regla nueva no llega sola a todos los bordes.** Enumerar las
   instancias de una regla general ANTES de implementarla (no arreglar los
   sitios a medida que el AR los encuentra) habría evitado que la misma regla
   se aplicara de menos tres veces seguidas (W1 → BLQ-2 → B-5) en esta única
   HU.
3. **Un commit rojo declarado es mejor que un verde inventado.** Cuando un
   tipo compartido se vuelve requerido y no hay un valor VERDADERO disponible
   todavía en esa wave, dejar `tsc` roto con la razón en el mensaje del commit
   es más barato que tapar el hueco con un literal plausible — sobre todo
   cuando ese literal sería exactamente la mentira que la HU existe para
   matar. Vale también para parches mecánicos: revisar el diff generado antes
   de confiar en que sólo tocó fixtures.
4. **`tsc` limpio no prueba que todos los call-sites migraron.** Las
   aserciones de test (`toEqual`, `toMatchObject`) no propagan el tipo del
   sujeto; migrar un tipo de retorno exportado se verifica con `grep` del
   nombre de la función, y la wave cierra con `tsc` limpio Y suite verde, no
   con uno solo de los dos.
5. **Una tabla de mutantes es evidencia sólo si se corrió, no si se heredó.**
   Tras el fix-pack, los 11 mutantes originales se re-corrieron enteros (no se
   copiaron sus hashes) porque el archivo había cambiado — "un hash que no
   corresponde al árbol es peor que ninguno". Y un mutante que no compila no
   cuenta como KILLED, aunque los tests fallen.
