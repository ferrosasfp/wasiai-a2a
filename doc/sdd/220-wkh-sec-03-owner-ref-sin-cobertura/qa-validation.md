# QA Validation (F4) — WKH-SEC-03

**HEAD** `4c8e833` · **base** `ef384b7` · rama `feat/220-wkh-sec-03-owner-ref-sin-cobertura`
**VEREDICTO: APROBADO PARA DONE** con **1 MENOR nuevo** (cita `archivo:línea` corrida, no
bloqueante, no de seguridad).

> Todo probe se aplicó y se restauró en el MISMO comando. `git status --porcelain` al cierre:
> `?? doc/audit/` (preexistente), y `git rev-parse HEAD` = `4c8e833`. Sin ediciones de esta fase.

## 0. Gates medidos en ESTE HEAD (el CR midió en `16847c3`, 6 commits atrás)

| Gate | Comando | Resultado |
|---|---|---|
| suite | `node ./node_modules/vitest/vitest.mjs run` | `268 passed \| 6 skipped (274)` · **`5330 passed \| 19 skipped (5349)`** |
| typecheck | `npx tsc --noEmit` | exit 0, limpio |
| lint | `npx biome check src/` | exit 0, 467 archivos |
| guardián solo | `... run test/ownership-filter-guard.test.ts` | **`13 passed (13)`** |
| tests de propiedad (7 archivos) | `... run *.ownership.test.ts` | **`32 passed (32)`** |

El conteo subió de 5329 (CR) a 5330: es G-13, el control nuevo (`9d2a1e8`).

---

## 1. Los 7 ACs

| AC | Status | Evidencia |
|---|---|---|
| AC-1 | **PASS** | Repro del input-rojo textual del AC: agregué `await supabase.from('a2a_receipts').select('*').eq('id', id).single()` al final de `src/services/receipt.ts` → **`2 failed \| 11 passed (13)`**, G-08 nombrando `src/services/receipt.ts:307 · a2a_receipts · select` y G-09 en colateral. Restaurado con `git checkout --`. |
| AC-2 | **PASS PARCIAL — partición declarada** | 8 de las 12 superficies que el AC enumera están cubiertas en este corte (`receiptService.getById`, `inboundTaskService.get`, `.getByExternalRef`, `agentService.listMine`, `spendPolicyService.list`/`.delete`/`.hasAnyPolicy`, bloque L2 de `llm/transform.ts`, `GET /session/:id/dispute`). **Faltan 4**: `readEvidence` (3 consultas), `getOrCreateArbiterNonce`, `reconciliationService.readBudgetUsd`, y las de `fee-split`. Están en **WKH-SEC-04**, y la partición 11/12 está declarada y contada en `sdd.md:401-403`. Spot-check ejecutado: borrando `src/services/receipt.ts:293` (`.eq('owner_ref', ownerRef)`) → `R-01 [receipt.ts:293]` en rojo, `1 failed \| 1 passed (2)`. |
| AC-3 | **PASS PARCIAL — partición declarada** | 1 de los 4 sitios que el AC enumera. El único del corte es `agent.ts:715`, y es el input-rojo que el AC nombra: borrando esa línea → `AG-02 [agent.ts:715]: si la fila pasa a ser de B entre el pre-chequeo y el DELETE, el DELETE no la toca` en rojo, `1 failed \| 2 passed (3)`. `fee-split.ts:697`, `arbiter.ts:1070` y `:1100` son de SEC-04 y **acá no se midió nada sobre ellos**. El hook `onDeleteStart` (`src/services/__tests__/owner-scoped-fake.ts:115-121` (declaración) y `:167`) es lo que hace comprobable el entrelazado. |
| AC-4 | **PASS** | El falso aplica los filtros de verdad: `owner-scoped-fake.ts:130-134` (`applyFilters` = `filters.every(([column, value]) => row[column] === value)`), y NO tiene el dueño hardcodeado (`:22-29` lo declara (§«LA TRAMPA QUE ESTE FALSO EVITA»)). Los 6 archivos nuevos declaran `OWNER_A`/`OWNER_B` distintos (`receipt:36-37`, `inbound-task:41-42`, `agent:54-55`, `spend-policy:67-68`, `transform:72-73`, `payments.dispute:69-70`). **Input-rojo del AC ejecutado**: puse `OWNER_B = OWNER_A` en `receipt.ownership.test.ts:37` → `R-01` en rojo, `1 failed \| 1 passed (2)`. Restaurado. Anti-vacuidad presente en los 6 (`transform` lo llama `TR-00 (control de armado)`, `:159`). |
| AC-5 | **PASS PARCIAL — declarado, y el docblock ahora lo dice** | 11 de los 23 sitios con evidencia por línea y test nombrado (`mutation-log.md:70-87`, tabla de 11 filas, **11/11 KILLED** con el test del sitio como asesino, no sólo G-08/G-09). Los 12 de SEC-04 **no se mutaron acá** (`mutation-log.md:216`). Verifiqué 2 de los 11 por mi cuenta (M-01 y M-03, arriba) y coinciden con lo que el log declara; los otros 9 los leí del log y **no los re-corrí** (fuera de mandato). |
| AC-6 | **PASS** | El input-rojo del AC está en la lista: `censo-owner-ref.md:201` (entrada 37) es `src/services/reconciliation.ts:1129 · a2a_payment_intent_debit_signatures · update`, dentro del rango `1128-1133` que el AC exige, con motivo escrito; y tiene su entrada operativa en `test/ownership-filter-guard.exceptions.ts:458-459`. La lista completa: **41 excepciones** (`grep -c "^    file:"` = 41), clasificadas en la unión cerrada de `exceptions.ts:33-56` — conteo por categoría: `admin-cross-tenant` 12, `catalogo-publico` 9, `worker-sin-caller` 6, `auth-por-hash` 4, `alcance-por-fila-del-caller` 3, `chequeo-en-js` 3, `ligadura-de-fila` 2, `probe-de-esquema` 1, `unicidad-global` 1 = 41. **`idor-vivo` = 0.** El censo cubre las 55 sin filtro (41 en alcance del guardián), `censo:22-38`. |
| AC-7 | **PASS** | `git diff --name-status ef384b7 4c8e833 -- src` da 9 archivos y **ninguno es producción**: 6 `*.ownership.test.ts` nuevos, 1 `__tests__/owner-scoped-fake.ts`, y 2 preexistentes (`src/routes/agents.ownership.test.ts`, `src/services/inbound-task.test.ts`) con **0 líneas borradas** (`git diff ... \| grep -c "^-[^-]"` = **0**): sólo comentarios agregados. El único archivo de `src/` que no es `*.test.ts` es el falso, y su ubicación en `__tests__/` está declarada y medida (`story:227-241`); verificado: `tsconfig.build.json:6` excluye `src/**/__tests__/**` y **no** excluye `__fixtures__`. |

**Ningún AC pasa por un doble incapaz de fallar.** El falso compartido aplica los filtros pedidos
(`owner-scoped-fake.ts:130-134`), y los dos sitios que spot-chequeé mueren al borrar la línea.

---

## 2. G-13 — el control que nadie había revisado

### 2.1 Mata el mutante que el fix-pack declara (medido por mí)

Mutante aplicado: `src/types/database.types.ts:664`, `      a2a_key_spend_policies: {` →
`      "a2a_key_spend_policies": {`, **sin tocar la indentación**.

```
× G-13: ninguna cabecera de tabla del archivo de tipos quedó SIN PARSEAR
AssertionError: Hay líneas a 6 espacios dentro de `Tables:` que NO son una cabecera...
+   "database.types.ts:664 → \"a2a_key_spend_policies\": {"
Tests  1 failed | 12 passed (13)
```

**Mata, y nombra archivo, línea y texto literal.** Es exactamente lo que el fix-pack declara.
Restaurado en el mismo comando (`git status --porcelain` = `?? doc/audit/`).

### 2.2 El mutante que el fix-pack declara **NO CORRIDO** — lo corrí: también muere

Transformación aplicada: duplicar la indentación de toda línea del archivo de tipos (simula un
`supabase gen types` / prettier con otro ancho de indentación). Efecto medido: `Tables:` queda a 8
espacios, las cabeceras a 12, y el regex `^ {4}(\w+): {` de `lineasA6Espacios` nunca matchea, así
que **las tres cajas de G-13 quedan vacías** — el escenario exacto que el fix-pack no había medido.

```
× G-01  × G-02  × G-11  × G-12  × G-13  × G-09
Tests  6 failed | 7 passed (13)
```

**El respaldo alcanza.** Lo que salva a G-13 con las tres cajas vacías es su propio anti-vacuidad,
`test/ownership-filter-guard.test.ts:451-452`: `cabeceras.length >= 50` y `comentarios.length >= 1`.
Con las cajas vacías, `desconocidas` es `[]` (pasa) y los dos invariantes relativos comparan 0 con 0
(pasan) — el piso es lo único que dispara, y dispara. Vaciar G-13 en silencio **no se logró con este
input**. No se probó ninguna otra forma de vaciarlo.

### 2.3 La corrección del número del CR — verificada con instrumento propio

El CR (`code-review.md:135`) declara «125 líneas a 6 espacios, **62 cabeceras, 63 `};`**». El
fix-pack (`auto-blindaje.md`, entrada `[2026-08-06 01:52]`) dice que la partición real es
**62 + 62 + 1 apertura de comentario**. **El fix-pack tiene razón**, medido dos veces con
instrumentos distintos:

1. Probe JS propio sobre el bloque `Tables:` → `total=125 cabeceras=62 cierres=62 comentarios=1 otras=0`.
2. `awk` crudo sobre `NR>16 && NR<2851` (las fronteras reales: `Tables: {` en `:16`, `Views: {` en
   `:2851`): 125 líneas a 6 espacios; 62 terminan en `{`; `uniq -c` muestra `      };` exactamente
   **62** veces; `      /*` exactamente **1** vez (`database.types.ts:1054`).

**Y la consecuencia que el fix-pack declara es real, medida**: quité la caja `comentarios` del
clasificador (probe temporal en `lineasA6Espacios`, restaurado) y G-13 **nace en rojo**:

```
× G-13 ... : expected [ 'database.types.ts:1054 → /**' ] to deeply equal []
Tests  1 failed | 12 passed (13)
```

Copiar el `63` del CR habría dado un control roto el día uno. **La corrección es correcta y era
necesaria**, y es la clase de error que se propaga hacia abajo: un revisor confiable, un total que
cierra (62+63=125), y una partición equivocada.

---

## 3. Cierre de los hallazgos del CR — verificado con evidencia, no con la afirmación del fix-pack

| Hallazgo | Estado | Evidencia que lo prueba |
|---|---|---|
| **BLQ-BAJO-1** — el docblock cuenta como medido un método aplicado a 11 de 23 | **CERRADO** | `test/ownership-filter-guard.test.ts:10-31` ahora parte en dos: «**De esos 23 se mutaron uno por uno los 11 de este corte; los otros 12 son de WKH-SEC-04 y acá NO se mutaron**», con `· MEDIDO ACÁ` (11, 8 sin espía + 3 con espía en `spend-policy.test.ts:292/311/344`) y `· HEREDADO, NO RE-MEDIDO` (12, apuntando a `mutation-log.md:216`, que verifiqué dice literalmente «Los 12 sitios de WKH-SEC-04. Fuera del corte, sin mutar»). Las tres citas de espía son exactas: `spend-policy.test.ts:292,311,344` son los tres `expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1')`. |
| **BLQ-BAJO-2** — «las tres rutas», la tercera no existe | **CERRADO** | `src/services/spend-policy.ownership.test.ts:6-8`: «**no son tres rutas: son DOS rutas y una función sin llamador. La versión anterior de este bloque decía «las tres rutas» y citaba dos**». Re-medí el grep que cita (`:18-24`): `grep -rn "hasAnyPolicy" src --include=*.ts` da **exactamente** definición `spend-policy.ts:214`, usos de test `spend-policy.test.ts:341,353`, mock `routes/auth.spend-policies.test.ts:54` y este archivo. **Cero llamadores de producción.** Y `spend-policy.ts:209-212` dice lo que el docblock le atribuye, palabra por palabra. |
| **MNR-1** — el agujero compartido de G-11/G-12, con cierre barato no implementado | **CERRADO** | G-13 (§2.1). El cierre barato del CR era «exigir que toda cabecera a 6 espacios que no sea `};` haya parseado»; lo entregado es más ancho (tres cajas + `desconocidas`) y con la partición corregida. |
| **MNR-2** — `deriveOwnerTables` importado y nunca invocado | **CERRADO** | `grep -rn "deriveOwnerTables" test/ src/` devuelve **una sola línea**, y es un comentario: `test/ownership-filter-guard.scanner.ts:238`. La función y su import ya no existen (`59274e3`). |
| **MNR-3** — `_INDEX-row.md:24` reinvertía los rótulos 11/12 | **CERRADO** | `_INDEX-row.md:24` ahora dice «**SEC-03 = mecanismo + 11 sitios** de superficie de API; **WKH-SEC-04 = los 12** de dinero y disputas (`fee-split`×4, `arbiter`×3, `arbiter/evidence`×3, `reconciliation`×1, `debit-capture`×1 = 12; 11 + 12 = 23)». Coincide con `sdd.md:401-403` y con el docblock del guardián. |
| **MNR-4** — el guardián lee el índice de git, y no estaba en «QUÉ NO CUBRE» | **CERRADO** | Es el punto **10** de la lista, `test/ownership-filter-guard.test.ts:106-118`, con la medición pegada (`13 passed (13)` sin `git add`; `2 failed \| 11 passed (13)` con `git add -N`) y con la delimitación honesta: «**No es un agujero de CI** [...] sino de la vuelta local». |
| **MNR-5** — `CLAUDE.md` decía «el número no se escribe a mano» y lo escribía 4 veces | **CERRADO** | La sección se reescribió de lista a criterio. `CLAUDE.md` ahora dice «**El criterio es la regla. El número es una foto y envejece**», enumera por qué nada lo fija (`G-01` son pisos `>=50`/`>=15`, `G-09` es `>=35`, `G-11/G-12/G-13` son relativos), pega la medición del CR («agregando una 22ª tabla el guardián sigue dando `13 passed (13)` y este renglón queda viejo en silencio») y cierra con «**no te apoyes en el número de acá: derivalo**». Los dos casos que la lista vieja mezclaba (`registries` **tiene** `owner_ref`; `a2a_events` no) están desarmados con cita, y las dos citas son correctas: `database.types.ts:2567` = `owner_ref: string`, `:2303` = `owner_ref: string \| null`. |
| **MNR-6** — `eq-sweep.mjs` atribuía al handler reponer el archivo | **CERRADO** | `scripts/eq-sweep.mjs:56-58`: «**Quien lo repone NO es el handler de señal**: para cuando el handler llega a correr, el archivo ya está restaurado. Lo que hace el trabajo es DÓNDE está el `await`». Ya no se contradice con el docblock de `:241-257`. |

**8 de 8 cerrados** (2 BLQ + 6 MNR).

---

## 4. Hallazgo NUEVO de esta fase

### MNR-QA-1 · `test/ownership-filter-guard.test.ts:81` cita un rango de `CLAUDE.md` que ya no es esa sección

El punto 7 de «QUÉ NO CUBRE» dice:

```
 *  7. RLS. No la mide ni la reemplaza: es WKH-SEC-02 (`CLAUDE.md:247-255`).
```

**Medido**: `CLAUDE.md:247-255` es el bloque «Dos casos que la lista vieja mezclaba y conviene tener
claros» (`registries` / `a2a_events`) — **otro tema**. La sección real es `### RLS real
(Postgres-level)` en **`CLAUDE.md:256`**, y `WKH-SEC-02` se nombra en **`:259`**. El archivo tiene
264 líneas.

**Causa**: el mismo PR reescribió `CLAUDE.md` alargando esa sección, y la cita quedó apuntando 9
líneas antes. Es **exactamente** el modo de falla que el propio fix-pack documentó y declaró barrido
en `auto-blindaje.md`, entrada `[2026-08-06 01:59]` («toda cita `archivo:línea` a un archivo que la
misma tarea modifica hay que re-verificarla al cierre»). El barrido no llegó a ésta.

**Severidad: MENOR.** No es de seguridad ni cambia ningún veredicto. Es una cita rota en el archivo
que esta HU deja como doctrina, o sea el lugar donde más caro sale.

**Alcance de mi barrido de citas** (todas las load-bearing del PR, verificadas una por una y
**correctas** salvo la de arriba): `mutation-log.md:70` y `:216`; `sdd.md:146-147` y `:494-497`;
`database.types.ts:2567` y `:2303`; `spend-policy.test.ts:292/311/344`; `spend-policy.ts:209-212` y
`:214`; `task.ownership.test.ts:139-144` (`applyFilters`) y `:323-331` (`T-OWN-05`, el estampado);
`tsconfig.json:19` (`include: ["src/**/*"]`); `package.json:11` (`biome check src/`);
`ci.yml:43` (`run: npm test`); `registry.ts:172,174`; `tsconfig.build.json:3-8`.

---

## 5. Drift

**Ninguno sin declarar.** Contados los archivos fuera del *Scope IN* literal del work-item, y los 5
están enumerados en el SDD o el Story File, que son posteriores:

| Fuera del Scope IN del work-item | Dónde se declara |
|---|---|
| Guardián partido en 3 archivos y renombrado (`ownership-guard-coverage.test.ts` → `ownership-filter-guard.{test,scanner,exceptions}.ts`) | `sdd.md:271, 538, 540, 548` |
| `scripts/eq-sweep.mjs` (nuevo) | `sdd.md:442, 572` · `story:371` (ítem 14, W4) · `story:985` |
| `src/routes/agents.ownership.test.ts` (modificado, sólo comentarios) | `sdd.md:41` (C-7), `:84`, `:107`, `:111`, §4.5 `:405, 419` |
| `src/services/inbound-task.test.ts` (modificado, sólo comentarios) | `story:370` (ítem 13, «Modificar — SÓLO comentarios», W3), `:502`, `:1078` |
| Falso en `src/services/__tests__/` y no en `__fixtures__/` | `story:227-241` (H-9 + D-1), con la medición `tsc -p tsconfig.build.json --listFiles` que la causó — verificada por mí en `tsconfig.build.json:6` |

Hook `onUpdateStart` → `onDeleteStart`: declarado en `owner-scoped-fake.ts:54-55`, y el motivo es
correcto (el único entrelazado del corte es sobre un DELETE, `agent.ts:715`).

**Test drift**: los 23 `it(` de los 6 archivos nuevos coinciden con lo que declara `_INDEX-row.md:24`
(conteo: receipt 2, inbound-task 4, agent 3, spend-policy 6, transform 6, payments.dispute 2 = 23).

**Wave drift**: los 15 commits van `a5bc8a9` (censo) → tests → fix-pack AR → fix-pack CR → auto-blindaje.
Orden coherente con W0..W4 del Story File. No se auditó commit por commit contra su wave.

---

## 6. Limitaciones — cuáles caducaron y cuáles siguen vigentes

### Caducadas por el trabajo de esta HU (ganancia directa)

1. **El agujero compartido de G-11/G-12 por la FORMA de la cabecera.** Era la limitación declarada
   más grande del guardián: los dos lectores compartían la suposición `^ {6}<ident>: {`, y una clave
   quoteada cegaba una tabla por vez con los 12 controles en verde. **Caducó**: G-13 la mata (§2.1),
   medido por mí.
2. **La variante por INDENTACIÓN del mismo agujero**, que el fix-pack dejó declarada como no
   corrida. **Caducó**: medida en §2.2, muere por el piso de G-13 (`test:451-452`), y de paso por
   G-01/G-02/G-11/G-12/G-09.
3. **`CLAUDE.md` como lista de 4 nombres que envejeció mal.** Caducó: ahora es criterio derivado, y
   la afirmación falsa sobre `registries` está desarmada con la cita correcta.
4. **La ausencia del modo de falla del índice de git en «QUÉ NO CUBRE»** (MNR-4). Caducó como
   omisión: ahora está declarado y medido. *El comportamiento sigue igual* — lo que caducó es que
   fuera invisible.

### Vigentes, sin cambio

5. El guardián verifica **presencia textual**, no el **valor** del filtro (`test:55-58`).
6. Las **cadenas partidas en variable** (`test:59-66`). Población medida hoy: 0.
7. **`insert`/`upsert`** (14 sitios) fuera de alcance (`test:67-71`).
8. Filas con `owner_ref` NULL (`kite_schema_transforms`) (`test:72-75`).
9. Filtros que no son `.eq`/`.in`/`.match` (`test:76-77`).
10. Desfase entre el archivo de tipos generado y la base real (`test:78-80`).
11. **RLS**: no se mide ni se reemplaza. Sigue siendo WKH-SEC-02 / TD-SEC-01.
12. **Los 12 sitios de SEC-04**: el guardián está verde con 12 sitios sin test de propiedad
    (`test:84-88`). De ésos, lo único que se sabe es que el filtro está escrito.
13. **Los 42 `supabase.rpc(...)` en 13 archivos**, incluido el camino del dinero: el guardián no dice
    nada sobre ellos (`test:89-105`).
14. El índice de git (punto 10). Vigente como comportamiento, ya no como omisión.

---

## 7. Lo que NO se pudo verificar en esta fase — sin suavizar

1. **Que ninguno de estos filtros aísle contra un Postgres real.** El falso es un doble en memoria.
   Ningún test de esta HU habla con una base. Esta HU **no toca DB**, así que no corresponde
   verificación de esquema/migración/env — pero tampoco corresponde leer su verde como evidencia de
   comportamiento en producción.
2. **9 de las 11 mutaciones de producción.** Verifiqué M-01 (`receipt.ts:293`) y M-03
   (`agent.ts:715`) ejecutando; las otras 9 las leí de `mutation-log.md:70-87` y **no las re-corrí**
   (fuera de mandato explícito). Si el log estuviera equivocado en alguna de esas 9, esta validación
   no lo detectaría.
3. **Los 12 sitios de WKH-SEC-04.** Acá no se midió nada sobre ellos, y esta fase tampoco. Su única
   evidencia sigue siendo un barrido cuya línea base este mismo SDD declara equivocada.
4. **Los 42 `supabase.rpc(...)`.** Ni el guardián ni esta validación dicen nada de ellos. El
   acotamiento por dueño vive dentro de la función SQL, que nadie leyó en esta HU.
5. **Las 41 excepciones una por una.** El AR las revisó; yo no las re-abrí (fuera de mandato). Lo que
   sí medí es que son 41, que suman por categoría, que ninguna es `idor-vivo`, y que G-10 cruza
   `table`/`verb` contra la cadena real.
6. **Otras formas de vaciar o cegar a G-13** además de las dos que corrí. Probé la clave quoteada y
   la re-indentación global. No probé, por ejemplo, un `owner_ref` declarado fuera del bloque `Row:`
   con otra indentación, ni un archivo de tipos con `Tables:` duplicado.
7. **El orden commit-por-commit contra las waves** del Story File. Miré la secuencia, no la
   correspondencia archivo↔wave de cada commit.
8. **Que `dist/` no contenga el falso.** Verifiqué la causa (`tsconfig.build.json:6` excluye
   `src/**/__tests__/**`) y que `dist/services/__tests__` no existe hoy, pero `dist/` puede estar
   viejo: no corrí `npm run build` en esta fase.

---

## 8. Veredicto

**APROBADO PARA DONE.**

Los 7 ACs tienen evidencia ejecutada. AC-2, AC-3 y AC-5 son **parciales por partición declarada**
(11 sitios acá, 12 en WKH-SEC-04, contado en `sdd.md:401-403`), no por incumplimiento. Los 2
bloqueantes y los 6 menores del CR están cerrados con evidencia propia, no con la afirmación del
fix-pack. G-13 mata su mutante de verdad y nombra `archivo:línea`; el mutante que el fix-pack dejó
declarado sin correr también muere. La corrección del número del CR (62+62+1, no 62+63) es correcta
y era necesaria: con dos cajas, G-13 nace en rojo.

Queda **MNR-QA-1** (cita `CLAUDE.md:247-255` corrida 9 líneas) como MENOR abierto. No bloquea el
merge; conviene corregirlo antes de que el docblock circule como doctrina.

**Estado del árbol al cerrar**: `4c8e833`, `git status --porcelain` = `?? doc/audit/`, sin ediciones
de QA.
