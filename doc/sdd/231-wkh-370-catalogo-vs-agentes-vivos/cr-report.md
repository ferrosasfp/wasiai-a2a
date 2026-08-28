# CR — WKH-370 · El vigilante del catálogo

Rama `feat/231-wkh-370-catalogo-vs-agentes-vivos` @ `20b3102` · base `091db28` · 2026-08-27
Ángulo: **calidad, citas, escala y contratos.** El AR corre en paralelo sobre seguridad y falsabilidad.

> Materializado por el orquestador desde el reporte inline del `nexus-adversary` (su harness le
> impide escribir archivos). Contenido íntegro.

## Veredicto: ❌ RECHAZADO — 2 BLOQUEANTES

Fix-pack: `BLQ-MED-1` → `BLQ-BAJO-1` → los 5 MENOR.

**Tokens de cita verificados abriendo la línea: 23. Fallaron: 4** — los 4 en la superficie que
esta HU editó, **ninguno cubierto por guardián** (`cited-lines-guard.test.ts` punto 14: sus
propios 4 archivos no están en `CORTE_A_PATHS`).

## El gate — corrido completo, en orden, árbol limpio

```
git status --porcelain              → (vacío)
npx tsc -p tsconfig.json --noEmit   → exit 0
npm run lint                        → Checked 520 files. No fixes applied.   exit 0
npm test                            → Test Files 314 passed | 6 skipped (320)
                                       Tests    6345 passed | 19 skipped (6364)   exit 0
```
Base `519 · 312/318 · 6310/6329`. **El `git ls-files` corrió contra un índice sin untracked: el
verde es real, no el falso de hace dos HUs.** Los 33 IDs de §8 existen los 33.

---

## 🔴 BLQ-MED-1 — Las dos citas de la prosa del guard de ownership apuntan a otra cosa

`test/ownership-filter-guard.exceptions.ts:507` (entrada `chequeo-en-js` de `agent.ts:417`):

> *"El dueño se compara en JS en `:697` (update) y `:872` (delete)"*

| Cita | Qué hay ahí | Qué debería anclar |
|---|---|---|
| `:697` | `async update(` — la **firma**, no una comparación | **`:711`** `if (existing.owner_ref !== ownerRef)` |
| `:872` | `/**` — apertura de docblock; `delete` arranca en `:876` | **`:886`** `if (existing.owner_ref !== ownerRef)` |

`grep -n "existing.owner_ref !== ownerRef"` → **711** y **886**, las dos únicas.

**Cómo nació** — y es el mecanismo, no el descuido: los valores viejos (`:633`/`:808`) eran
**correctos** en `091db28`. El desplazamiento real de esa región es **+78**; a esos dos se les
aplicó **+64**, el delta de la *primera* pasada, antes del fix del `typeof`. **La re-derivación de
la tercera vuelta llegó a `citations.ts` y no a `exceptions.ts`.**

**Impacto**: es el archivo que justifica **por qué una query NO lleva filtro de ownership** — el
artefacto que la sección *Security Conventions* de `CLAUDE.md` manda auditar. Un revisor que siga
`:872` cae en un comentario, no encuentra el chequeo, y no puede validar la excepción.
**Ningún guardián lo mira** y `npm test` verde no habla de esto.

---

## 🔴 BLQ-BAJO-1 — La mitad que el Dev declaró «sigue siendo cierta» es FALSA para una de las tres columnas

`src/services/agent.ts:434-437`:

> *"La primera mitad sigue siendo cierta: `AgentRow` no las tipa, y por eso `mapRowToAgent` —el
> mapper del catálogo ANÓNIMO— no puede verlas."*

El antecedente de «esas columnas» está dos renglones arriba: `owner_ref, payout_wallet, referrer_ref`.

**Reproducción**: `AgentRow` **sí tipa `owner_ref`** (`agent.ts:62`), y lo tipaba igual en
`091db28`. ⇒ `mapRowToAgent(row: AgentRow)` **puede** verla: `row.owner_ref` ahí adentro compila hoy.

Lo que sí es cierto —y es la protección real— es que `mapRowToAgent` **no la emite** (`:197-227`,
verificado campo por campo, y `T-B2` lo fija sobre el objeto producido). Pero **eso es una barrera
de VALOR, no de TIPO**, y el párrafo la vende como de tipo.

**Impacto**: CD-23 es un ⛔ cuyo entregable es *un párrafo verdadero*. El párrafo corregido repite,
para `owner_ref`, **exactamente el defecto que se corrigió para `payout_wallet`**. El Dev incluso
singulariza bien a `referrer_ref` cuatro renglones más abajo; el que quedó tapado es `owner_ref`.

**Por qué la suite no lo caza**: `T-S5` verifica que el párrafo **se editó** (`toContain(...)`,
`not.toMatch(...)`). Verifica **presencia de la edición, nunca la verdad de la frase
superviviente** — la misma clase de guardián-que-mira-la-columna-y-no-el-valor que `CLAUDE.md`
describe para `ownership-filter-guard`.

---

## Los checks que pasaron

**2 · Escala — OK, y ahora MEDIDA.** Total fuera de `doc/`: **1766/1140 = 1,55x**, bajo el 2x.
El `3,54x` de `agent.ts` se explica con el desglose que el Dev no puso y el CR sí midió:

```
total agregado: 85 · comentario/docblock: 76 (89%) · código: 9
```
Las 9 líneas de código son el tipo, el campo, la firma, la expresión y los 3 casts. **Ésa es la
parte que escribiría alguien que ya conoce el repo.** Las 76 restantes son el precio de I-2 +
CD-23, **ambos obligatorios por contrato**. El exceso está justificado y ahora medido: no es
silencioso.

**3 · Contrato público — OK.** `GET /agents` **no declara response schema** (verificado: cero
`schema:` en la ruta), así que ningún serializador descarta el campo nuevo. La doctrina de
opcionales **se respeta y no se inventa**: `hasPayoutWallet: boolean` requerido sigue la familia
de `enabled`/`discoverable` (siempre derivable), no la de `payment?`/`inputSchema?` (pueden no
existir), con el motivo escrito en el sitio.

**4 · La abstracción de I-2 — mínima, OK.** `OwnedAgentRow` tipando sólo el mapper del dueño es la
forma más chica de darle la columna al dueño sin dársela al anónimo. **El Dev descartó la
alternativa por el motivo correcto**: cablear `getSplitContextRow` convertiría `listMine` en N+1 y
volvería asíncrono un mapper puro.

**5 · Tipos y errores — OK.** Cero `any`. Los 3 casts son la **continuación** de un patrón
pre-existente. El fix del `typeof` es el correcto: `!== null` habría dejado pasar `undefined` al
`trim` — los 23 rojos de W4.2. **El cast no esconde otros campos ausentes**: de los 10 que lee el
mapper, los 9 primeros llegan por `select('*')`; **el único que podía faltar era `payout_wallet`,
y es el único que se protegió.**

**6 · Prosa — 8 afirmaciones falseadas con un input concreto, todas resistieron**, incluida la
declaración de vacuidad de CD-17 (*"esta rama NO se evalúa nunca"*), que es correcta y está dicha
en voz alta. Lo que no resistió está en `BLQ-BAJO-1` y `MNR-1`.

**7 · Alcance — los 4 desvíos declarados, ninguno evitable, cero TD de contrabando.** Verificado
que las 3 citas que CD-9 manda dejar podridas **siguen podridas**.

---

## MENORes

**MNR-1** · El docblock se contradice a sí mismo: `agent.ts:95` dice *"los **cuatro** llamadores"*
y `:88`, nueve renglones antes, dice *"sus **tres** llamadores"*. Medido: **son tres**
(`:576`, `:685`, `:869`). El *claim* es correcto; sólo el número es falso.
⚠️ Para el fix: *"las cuatro lecturas y las dos escrituras"* (`:90-91`) **SÍ es cierta** — no tocar.

**MNR-2** · `citations.ts:617` conserva los números viejos (`:633`/`:808`) mientras el `line:` de
la entrada de al lado ya dice `886`. **Mismo mecanismo que BLQ-MED-1, en el archivo donde esa
lección está escrita.**

**MNR-3** · Atribución falsa en `TD-370-CITAS-FUERA-DEL-CORTE`: dice que la inserción *"corrió
estas dos"*, y **las tres estaban podridas en `091db28`** (reproducido). La conclusión es correcta
y valiosa; lo que hay que corregir es la **provenance**. Y omite que `agent.ownership.test.ts`
tiene **5 tokens** podridos, no uno.

**MNR-4** · Los dos npm scripts tienen **cuerpo idéntico** y no fijan `CHECK_MODE` ⇒ correrlos a
mano da `CONFIG(3)`. El workflow sí lo fija por `env:`, así que CI funciona.
⚠️ **`T-S4` clava el cuerpo duplicado** (`toBe('node scripts/check-catalog-vs-live.mjs')`): poner
`CHECK_MODE=deriva node …` lo pone rojo. **El verde de hoy no valida los scripts: los congela.**

**MNR-5** · `GET /agents` no está en la tabla de endpoints de `doc/INTEGRATION.md` — hueco
**pre-existente**, fuera de Scope IN. Consecuencia: `hasPayoutWallet` nace sin sitio canónico.

---

## El hallazgo del CR

> Los dos BLOQUEANTES son de la **misma familia**: una afirmación escrita que **dejó de ser cierta
> cuando el propio cambio movió el terreno**. Y **ninguno de los dos lo ve `npm test`**: uno vive
> fuera de `CORTE_A_PATHS`, al otro lo cubre un test que verifica **que la edición ocurrió**, no
> que la frase sea verdadera.
>
> La HU construyó un chequeo excelente para que el catálogo no mienta sobre los agentes, y se le
> colaron dos sitios donde **el código miente sobre sí mismo**.
