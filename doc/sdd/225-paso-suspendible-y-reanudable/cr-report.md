# Code Review — WKH-225 · un paso de `/compose` que espera a una persona (corte A)

- **Revisor**: `nexus-architect` (fase CR)
- **Fecha**: 2026-08-23
- **Worktree**: `/home/ferdev/.openclaw/workspace/wt-225` · rama `feat/225-paso-suspendible-y-reanudable`
- **HEAD**: `d11b014` · **Base**: `5578998`
- **Alcance**: calidad, patrones y escala. **NO** se re-audita seguridad ni corrección: eso lo cerró
  el AR en dos iteraciones (`ar-report.md`, `ar-report-it2.md`).

---

## VEREDICTO: **CHANGES_REQUESTED**

**Ningún hallazgo es BLOQUEANTE. No hay bug de corrección, no hay plata perdida ni cobrada de más,
y el gate está verde.** Los cuatro puntos de abajo son de calidad y de deuda no declarada; los tres
primeros se cierran en menos de una hora y el cuarto es mecánico.

El motivo de no firmar `APPROVED` directamente es **CR-2**: el camino de reanudación cobra el fee
de protocolo **sin repartirlo** y **sin emitir el recibo**, mientras `/compose` hace las dos cosas.
No lo pedía el SDD ni el Story File, no lo detecta ningún test, y **ningún artefacto de esta HU lo
menciona**. Esta HU ya demostró que sabe declarar lo que difiere (`TD-225-02`, `routes/compose.ts:1057-1061`);
esto quedó afuera de esa disciplina, en el camino del dinero.

| Severidad | # | Hallazgo |
|---|---|---|
| BLOQUEANTE | 0 | — |
| MENOR | 4 | CR-1 docblock huérfano · CR-2 fee sin splits ni recibo en `/compose/resume` · CR-3 el espejo no tiene candado · CR-4 identificadores en castellano |
| OBSERVACIÓN | 2 | OBS-1 la producción está en 2,03× de SU presupuesto (el diff entero, 1,78×) · OBS-2 corrección aritmética al dato de escala del AR |

---

## GATE — corrido una vez, en orden

| Paso | Comando | Exit | Salida |
|---|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | **0** | `TypeScript compilation completed` |
| 2 | `npm run lint` | **0** | `biome check src/` → `Checked 508 files in 265ms. No fixes applied.` |
| 3 | `npm test` | **0** | `Test Files 303 passed \| 6 skipped (309)` · `Tests 6051 passed \| 19 skipped (6070)` |

`npm run qa` no existe en este repo (confirmado en `package.json`); el gate real es esta terna.

---

## CHECK 1 — Patrones: ¿se siguieron los exemplars que el Story File citó?

**PASS.**

### 1.a · `wkh137_agent_links.sql` para el claim

Comparación estructural, sitio por sitio:

| Elemento | Exemplar `supabase/migrations/20260706000000_wkh137_agent_links.sql` | Esta HU `supabase/migrations/20260823000000_wkh225_suspended_runs.sql` |
|---|---|---|
| Encabezado con el patrón citado | `:14-15` | `:19-20` (cita el exemplar por nombre) |
| `CREATE TABLE IF NOT EXISTS` | `:19` | `:38` |
| Índices `idx_a2a_<tabla>_<cols>` | `:38-40` (`key_owner`, `owner`, `status`) | `:105-108` (los mismos tres + `expires`) |
| RLS sin `CREATE POLICY` (deny-by-default) | `:44` | `:113` |
| Trigger `set_a2a_<tabla>_updated_at` | `:48` | `:164` |
| RPC claim con `FOR UPDATE` | `:87` | `:248` |
| `RAISE EXCEPTION` por desenlace | `:89`, `:94`, `:99` | `:251`, `:256`, `:264`, `:274`, `:309` |
| `SECURITY DEFINER` + `SET search_path` + `REVOKE`/`GRANT` | `:115-121`, `:177-183` | `:325-331`, `:397-403` |
| RPC settle status-gated | `:133-177` | `:352-397` |

**Y hay una divergencia que MEJORA el exemplar, verificada:** el exemplar interpola la credencial
en el mensaje de error (`RAISE EXCEPTION 'LINK_NOT_FOUND: %', p_token_hash` — `agent_links.sql:89`;
`'OWNERSHIP_MISMATCH: link % not owned by caller'` — `:154`). Esta HU levanta el literal pelado
(`suspended_runs.sql:251`, `:256`, `:377`) y lo dice en `:250` (*"El token NO entra al mensaje
(CD-8): es la credencial"*). Correcto, y es el criterio disclosure-safe que AC-6 pide.

Los dos estados nuevos frente al exemplar (`expired` en el CHECK de `:85`, trigger de `expires_at`
en `:125-158`) son los que el SDD §5 anunció.

### 1.b · El patrón LEAF de `orchestrate-quote.ts` / `compose-limits.ts`

`src/lib/resume-token.ts` copia `verifyQuote` paso por paso. Verificado línea a línea contra
`src/services/orchestrate-quote.ts:345-406`:

| Paso | Exemplar | `resume-token.ts` |
|---|---|---|
| 1 forma+tamaño | `:350-356` | `:414-419` |
| 2 secreto fail-closed | `:358-362` | `:421-424` |
| 3 estructura (3 partes, prefijo, hex64) | `:364-370` | `:426-433` |
| 4 HMAC sobre el crudo + `timingSafeEqual` | `:372-374` | `:435-438` |
| 5 recién ahí decodificar y parsear | `:376-385` | `:440-447` |
| 6 `exp` + `iat` con skew | `:387-394` | `:449-455` |
| 7 binding a la credencial | `:396-401` | `:457-461` |

Las dos divergencias están escritas y son correctas: dominio de firma propio
(`resume-token.ts:38-46`) y **dos** códigos en vez de tres (`:137-147`, con el motivo: un
`CALLER_MISMATCH` propio anularía el 404 disclosure-safe del claim).

**La propiedad LEAF está verificada por un control que NO es vacuo** —
`src/lib/resume-token.test.ts:338-350` lee **el fuente del módulo** (`SELF`), no el del test, y
además cierra `import(` y `require(` dinámicos. El comentario `:340-342` explica exactamente por qué
no se lee a sí mismo. Es la lección `controles-que-se-leen-a-si-mismos` aplicada bien.

`src/services/suspended-run.ts:1-39` hereda por escrito las tres reglas de
`adapters/solana/settle-ledger.ts`, y las cumple: ninguna de las cuatro funciones exportadas
devuelve `boolean` (`:124-150` son tres uniones discriminadas), y toda cadena lleva su `ownerId`
no-opcional. El `*.ownership.test.ts` que `CLAUDE.md` exige existe y mide **aislamiento**, no
presencia: `src/services/suspended-run.ownership.test.ts:162`, `:171`, `:181`, `:193`.

---

## CHECK 2 — Naming

**PASS con MENOR (CR-4).**

Lo que está bien: interfaces `PascalCase` (`ComposeSuspension`, `SuspendedRunClaim`,
`OpenSuspendedRunResult`), funciones `camelCase`, constantes `SCREAMING_SNAKE`
(`RESUME_MAX_TOKEN_CHARS`, `SUSPEND_MIN_TTL_SECONDS`), columnas `snake_case`, familia de códigos
`RUN_*` / `RESUME_*` calcada de la familia `LINK_*` del exemplar, índices
`idx_a2a_suspended_runs_*` idénticos en forma a `idx_a2a_agent_links_*`.

### 🟡 CR-4 (MENOR) — ocho identificadores en castellano, y son los únicos del repo

Este repo escribe **comentarios en castellano e identificadores en inglés**. Medido con
`grep -E "\b(const|let)\s+(filas|fila|costoPrevio|…)"` sobre `src/` excluyendo tests: los ocho
identificadores en castellano de todo `src/` no-test **son los ocho que agrega esta HU**.

| Sitio | Identificador | Vecino inglés en el mismo bloque |
|---|---|---|
| `src/services/suspended-run.ts:364` | `filas` | `rows` (mismo archivo, `:281`) |
| `src/services/suspended-run.ts:370` | `fila` | `run` (`:282`) |
| `src/routes/compose.ts:1714` | `stepsPrevios` | `remaining` (`:1711`) |
| `src/routes/compose.ts:1717` | `costoPrevio` | `downstreamSkipCauses` (`:1735`) |
| `src/routes/compose.ts:1718` | `latenciaPrevia` | `step0` (`:1741`) |
| `src/routes/compose.ts:1724` | `techoDelCaller` | `keyRow`, `claimed`, `verified` |
| `src/routes/compose.ts:1729` | `preciosCongelados` | idem |
| `src/routes/compose.ts:1874` | `stepsCompletos` | `totalCostUsdc` (`:1875`), `totalLatencyMs` (`:1876`) |

`src/routes/compose.ts:1874-1876` es el caso más visible: tres constantes contiguas, la primera en
castellano y las dos siguientes en inglés. `stepsPrevios` además es híbrido.

No cambia ningún comportamiento y `tsc`/`biome` no lo miran. Se pide el rename por consistencia:
`priorSteps` / `priorCostUsd` / `priorLatencyMs` / `callerCeiling` / `frozenPrices` / `allSteps` /
`rows` / `row`.

---

## CHECK 3 — Complejidad

**PASS.**

### `debitResumedFirstStep` (`src/routes/compose.ts:1063-1145`)

83 líneas de cuerpo (≈55 ejecutables), 6 salidas tempranas, un `try/catch`, cero anidamiento
por encima de 2. **Es menos de la mitad de su hermana del mismo archivo**,
`resolveComposePriceHandler` (`:726-926`, 201 líneas), y tiene una única responsabilidad enunciable:
*cotizar y debitar el primer step del tramo restante, y dejar sentado qué habría que reembolsar.*

Cotizar y debitar no se pueden separar acá, y el motivo está escrito y es correcto
(`:1140-1143`): los tres campos que `refundComposeStep0` lee (`request.resolvedChainId`,
`composeEstimatedCostUsd`, `composeDestination`) se setean **después** del débito exitoso a
propósito, para que un débito fallido no habilite el reembolso de plata que nunca salió. Partirla en
`quote()` + `debit()` obligaría a que el llamador respete ese orden por convención en vez de por
construcción. **No se pide partirla.**

### El resto

- `suspendIfEnvelope` (`src/services/compose.ts:1331`) — **extraída, no copiada**, y se la llama
  desde los dos sitios que la necesitan: happy-path (`:780`) y retry-ok (`:1158`). El comentario de
  `:1153-1157` da el caso concreto que la segunda llamada cubre (un step que falla, reintenta y
  recién entonces pide esperar). Bien resuelto: es la anti-duplicación hecha en el sitio correcto.
- `readsAsSuspension` (`src/services/compose.ts` — helper puro) — total, sin efectos, comparación
  estricta contra `true`.
- El handler de `/compose/resume` (`src/routes/compose.ts:1660-1951`, 292 líneas) es **más corto**
  que el de `/compose` (`:1218-1615`, ≈398). Dentro de la distribución del archivo.
- `resume-token.ts`: la función más grande es `verifyResumeToken` con 56 líneas y una sola
  responsabilidad; el resto son helpers de ≤20.

### 🟡 CR-1 (MENOR) — un docblock quedó huérfano a 166 líneas de lo que documenta

`src/routes/compose.ts:969-981` es un bloque JSDoc que documenta **`RESUME_CLAIM_HTTP`** (el mapeo
claim→HTTP, con la explicación de por qué el body del `not_found` es byte-idéntico — AC-6).
Pero `RESUME_CLAIM_HTTP` se declara en **`:1147`**, y entre medio el fix-pack insertó
`ResumeStep0Debit` + `debitResumedFirstStep`.

Resultado, verificable abriendo el archivo:

```
 969  /**
 970   * WKH-225 — el mapeo del desenlace del claim a HTTP.      ← documenta :1147
 ...
 981   */
 982  /**
 983   * 🔴 FIX-PACK AR/BLQ-ALTO-2 — EL DÉBITO DEL PRIMER STEP…   ← documenta :1063
 ...
1145  }
1146
1147  const RESUME_CLAIM_HTTP: Record<                            ← SIN docblock
```

Dos JSDoc apilados: TypeScript y cualquier IDE atan **el último** al símbolo siguiente, así que
`:969-981` no lo lee nadie al inspeccionar `debitResumedFirstStep`, y `RESUME_CLAIM_HTTP` queda sin
documentar. La explicación de AC-6 —que es la parte que importa— quedó fuera de foco.

Es el patrón `citas-rotas-por-tu-propia-edicion`: no lo rompió lo que se escribió, lo rompió lo que
se **desplazó**. **Arreglo: mover `:969-981` a inmediatamente arriba de `:1147`.** Cero riesgo.

---

## CHECK 4 — Duplicación: el espejo de `debitResumedFirstStep`

### ¿Deberían ser una sola función? **No, y con motivo.**

`resolveComposePriceHandler` (`:726-926`) y `debitResumedFirstStep` (`:1063-1145`) comparten un
núcleo de ~15 líneas ejecutables (resolver precio → resolver destino → derivar destino → gas
overhead → fallback `PLACEHOLDER_FEE_USD` → `amountUsd`), pero **no son la misma función y no pueden
serlo**:

| | `resolveComposePriceHandler` | `debitResumedFirstStep` |
|---|---|---|
| Qué es | `preHandler` de Fastify | función del handler |
| Quién debita | **no debita** — inyecta `composeEstimatedCostUsd` y debita `requirePaymentOrA2AKey` después | **llama a `budgetService.debit` ella misma** (`:1121`) |
| Responde HTTP | sí: 404 `AGENT_NOT_FOUND` (`:756`, `:843`), 400 loop (`:797`), 503 (`:921`) | no: devuelve una unión y decide el llamador |
| Necesita `owner_ref` del caller | no | **sí** (`:1128`) — y ese dato sólo existe después del claim |
| Efectos laterales extra | header `x-debit-fallback` (`:864`), `augmentX402ChallengeAmount` (`:876`, `:903`), guard anti-bucle capa 1 (`:797`) | ninguno |

El argumento decisivo está escrito en `:998-1006` y lo verifiqué: para saber **cuál** es el primer
step restante hay que claimear el run, y el claim necesita el `owner_ref` del caller autenticado,
que puebla el middleware de auth. Un preHandler de precio tendría que consultar la base **antes de
saber quién pregunta**. `/compose` puede hacerlo porque su step 0 viene en el body. **El espejo es
la respuesta correcta.**

### 🟡 CR-3 (MENOR) — y no hay nada que evite que diverjan mañana

A la pregunta *"si se quedan separadas, ¿qué evita que diverjan?"*: **hoy, nada.**

Lo único que las ata es prosa: el inventario de cinco viñetas de `src/routes/compose.ts:1013-1029`
(*"LO QUE SE ESPEJA DE `/compose`, LÍNEA POR LÍNEA"*). Ese inventario es correcto hoy y **se pudre
en silencio** el día que cualquiera de los dos lados cambie. Busqué un control que lo detecte:
`grep -rn "debitResumedFirstStep\|resolveComposePriceHandler"` sobre `src/routes/compose.resume.test.ts`,
`src/routes/compose.fee.test.ts` y `test/*.ts` devuelve **cero**; y ninguno de los 36 tests de
`compose.resume.test.ts` compara los dos caminos entre sí.

**Este repo ya resolvió exactamente este problema, y con el mismo diagnóstico.**
`test/payment-guards-live-in-one-place.test.ts:92-131` (T-316-24 / CD-9) es un guardián a nivel
fuente que verifica que cinco criterios del camino del dinero **no estén re-implementados** en los
consumidores, con un **control de vacuidad** por cada uno (`:109-116`) y un control de que los
consumidores efectivamente llamen al validador compartido (`:119-131`). Su mensaje de fallo dice la
frase que aplica acá textualmente (`:101-103`):

> *"dos criterios que nada obliga a moverse juntos divergen en la próxima corrección de borde, y el
> desacuerdo sale como un rechazo inexplicable en un camino de dinero."*

**Se pide**: un test de paridad que convierta las cinco viñetas de `:1013-1029` en cinco
aserciones. La forma barata y suficiente: extraer el núcleo compartido a un helper puro
(`quoteStep0(slug, registry, chainId, frozen) → {amountUsd, destination, fallback}`) y verificar
que los **dos** call-sites lo llaman —el patrón exacto de `payment-guards-live-in-one-place.test.ts:119-131`.
La alternativa mínima es un test que ejercite ambos caminos con la misma entrada y compare
`amountUsd` y `destination`.

### 🟡 CR-2 (MENOR) — el espejo del **fee** perdió dos comportamientos, y nadie lo declara

Éste no lo miró el AR. El bloque de fee de `/compose/resume` (`:1914-1938`) es una copia
**simplificada** del de `/compose` (`:1496-1575`), y la simplificación se comió dos cosas:

**1. El reparto del fee (`splitsActive` / `resolveAgentSplitContext`).**

```
/compose        :1509  if (splitsActive()) { const splitCtx = await resolveAgentSplitContext(...) }
                :1522  if (creator)  feeParams.creator  = creator;
                :1523  if (referral) feeParams.referral = referral;
/compose/resume :1917  await chargeProtocolFee({ orchestrationId, feeBaseUsdc, feeRate })  ← sin creator ni referral
```

Verificado que la ausencia **no es inocua**: `src/services/fee-charge.ts:263-269` dice que si el
call-site no pasa el contexto, *"creator/referral quedan ausentes → su bps se re-ruta a plataforma
(fila `skipped`, SG-6)"*. Con la config de splits activa
(`src/config/split-config.ts:126-136`, `splitsActive()` es `true` con `SPLIT_BPS_CREATOR>0` o
`SPLIT_BPS_REFERRAL>0`), un run reanudado le paga **el 100 % del fee a la plataforma** y deja filas
`skipped` en `a2a_fee_splits`, mientras el mismo pipeline sin suspensión lo reparte. Confirmado que
no hay ninguna aparición de `splitsActive` entre `:1647` y `:1955`.

**2. El recibo `protocol_fee`.**

`/compose:1546-1566` emite `receiptService.emit({ receiptType: 'protocol_fee', … })` cuando el fee
se cobró y hay `owner_ref`. El camino de resume no lo hace: `grep receiptService` entre `:1647` y
`:1955` da cero. El dueño de la key ve el débito y no ve el recibo.

**Por qué es MENOR y no BLOQUEANTE:** el **monto total** que paga el caller es idéntico, no hay
doble cobro ni pérdida; la feature está detrás de `COMPOSE_SUSPEND_ENABLED=false`; y ni el SDD
(§`CD-18`, `sdd.md:729-732`) ni el Story File (`story-file.md:1038-1042`) pidieron splits ni recibo
—el Dev cumplió el contrato que recibió.

**Por qué igual se pide una acción:** es una divergencia de comportamiento en el camino del dinero
que **ningún artefacto de esta HU nombra** y **ningún test detecta**, y el comentario que la cubre
(`:1912-1913`, *"Best-effort, igual que en `/compose`"*) invita a leer paridad donde no la hay.
Esta misma HU sabe hacerlo bien: `TD-225-02` está declarada por escrito en `:1057-1061` para una
deferencia comparable. **Se pide lo mismo acá**: o se agregan las dos cosas, o queda una `TD-225-03`
escrita en el docblock del bloque de fee del resume diciendo qué NO hace y por qué se difiere.

### Duplicación restante — menor y aceptable

`src/services/compose.ts:780-793` y `:1158-1171` pasan un objeto literal de 12 propiedades
idéntico a `suspendIfEnvelope`. Son ~14 líneas repetidas dos veces, en closures distintas del mismo
bucle. Colapsarlo obligaría a construir el objeto antes del `try`, donde `output` todavía no existe.
**Se acepta como está**; se anota para que no crezca a un tercer sitio.

---

## CHECK 5 — Imports y dependencias

**PASS, medido.**

- `git diff 5578998 HEAD -- package.json package-lock.json` ⇒ **0 líneas**. No se agregó, quitó ni
  movió ninguna dependencia. Es exactamente lo que el SDD §8.1 declaró.
- `@supabase/supabase-js` **instalado**: `node_modules/@supabase/supabase-js/package.json` →
  `"version": "2.101.1"`, la versión que el SDD fijó. (Verificado contra el paquete instalado, no
  contra el rango de `package.json` — regla 8 del `CLAUDE.md`.)
- Los dos módulos nuevos importan **sólo** cosas internas y de Node:
  - `src/lib/resume-token.ts`: `node:crypto` y nada más (`:33`), verificado además por el control
    `T-TOK-LEAF`.
  - `src/services/suspended-run.ts`: `node:crypto`, `../lib/logger.js`, `../lib/resume-token.js`,
    `../lib/stranded-payment.js`, `../lib/supabase.js`, `../types/*`, `./event.js`.
- Los imports nuevos de `src/routes/compose.ts` son todos internos (`../lib/resume-token.js`,
  `../services/suspended-run.js`, `requireA2AKey`).
- `src/services/reconciliation.ts:39` importa `isComposeSuspendEnabled` **del módulo que define la
  bandera**, con el motivo escrito (`:36-38`): que lector y productor no puedan divergir en el
  string ni en el `=== 'true'`. Es la convención de `project-context.md:252-268`, cumplida.

---

## CHECK 6 — Límites de líneas

**PASS.** No hay límite de líneas por archivo definido en este repo: `biome.json` no tiene
`noExcessiveLinesPerFunction` ni `max-lines` (linter con `recommended: true` + `noExplicitAny`),
y `.nexus/project-context.md` no fija ninguno. El contraste válido es la distribución real:

| Archivo | Base | HEAD | Δ | Contexto |
|---|---|---|---|---|
| `src/types/database.types.ts` | 3738 | 3900 | +162 | generado; ya era el más grande |
| `src/types/index.ts` | 2321 | 2523 | +202 | ya era el 2º |
| `src/services/compose.ts` | 1804 | 2032 | +228 | pasa a 3º |
| `src/routes/compose.ts` | 1282 | 1955 | +673 | pasa de 12º a 4º |
| `src/services/reconciliation.ts` | 1473 | 1655 | +182 | — |
| `src/services/suspended-run.ts` | — | 442 | nuevo | por debajo de `agent-link.ts` (544) |
| `src/lib/resume-token.ts` | — | 464 | nuevo | por debajo de `orchestrate-quote.ts` (406)… +58 |

Ninguno supera el máximo preexistente del repo (3900). `src/routes/compose.ts` crece 53 % y es el
único que cambia de tramo en la distribución; queda dentro del rango de los archivos gordos que ya
existían (`payment-intent.ts` 1753, `orchestrate.ts` 1705, `a2a-key.ts` 1674). **Sin acción**, pero
es el archivo a vigilar en la próxima HU que lo toque.

---

## CHECK 7 🔴 — ESCALA

### Los números, medidos de nuevo

Presupuesto del SDD (`sdd.md:617-624`): **≈3680**. Umbral de justificación: **>7360 (2×)**.

```
diff sin doc/     :  +6550 / −33   en 27 archivos   ⇒  1,78×   ← BAJO el umbral
```

Desagregado, y contra el presupuesto **por categoría** que el propio SDD publicó:

| Categoría | Presupuesto SDD | Real | Ratio |
|---|---|---|---|
| Producción (`src/` no-test) + `supabase/` | 1140 + 237 = **1377** | **+2801 / −5** | **2,03×** |
| Tests (`src/**.test.ts` + `test/`) | **2160** | **+3697 / −22** | **1,71×** |
| Config + README | **143** | **+52 / −6** | **0,36×** |
| **Total** | **3680** | **+6550** | **1,78×** |

### OBS-1 — el exceso está concentrado en producción, y es atribuible

La producción está en **2,03× de su propia categoría** aunque el diff entero esté en 1,78×. Medido
de dónde sale:

```
base → 87134bf (W0+W1+W2, antes del fix-pack)   producción  +2335 / −4   ⇒ 1,70× del presupuesto
87134bf → HEAD (fix-pack AR)                    producción   +466        ⇒ el 0,33× restante
```

Y dentro de eso, el archivo que se desborda es **`src/routes/compose.ts`: presupuesto +195, real
+673 (3,45×)** — `+398` de las waves planificadas y `+282` del fix-pack. El fix-pack de ese archivo
es, casi entero, `ResumeStep0Debit` + `debitResumedFirstStep` (`:1052-1145`), que **no existía en el
SDD**: el SDD daba por sentado que el middleware de pago cubría el step 0 del tramo reanudado, y el
AR midió que no (BLQ-ALTO-2, `ar-report.md`). **El exceso es el hallazgo del AR materializándose en
código.** Es exceso justificado y queda nombrado acá, que es lo que la regla 10 pide.

### OBS-2 — corrección al dato de escala del AR

`ar-report-it2.md:209` dice: *"1030 líneas para 24 tests"* ⇒ ~43 líneas por test, y lo deja como
dato inquietante para el CR. **Ese número mezcla bruto con neto.** Medido:

```
fix-pack, archivos de test:   +1027 / −141 líneas ;  +33 / −9 it()
   bruto/bruto:  1027 / 33 = 31
   neto /neto :   886 / 24 = 37
   AR         :  1030 / 24 = 43     ← numerador BRUTO, denominador NETO
```

Y lo que importa no es el fix-pack sino la HU entera, contada con el **mismo método** que la línea
de base:

```
HU 225,  archivos de test:  +3381 líneas  /  127 it() nuevos   =  26,6 líneas por test
repo en 5578998          : 143252 líneas  / 5357 it()          =  26,7 líneas por test
```

**26,6 contra 26,7.** Los tests de esta HU tienen exactamente la densidad del repo. Por archivo,
contra sus propios exemplars:

| Archivo | líneas/test | | Exemplar | líneas/test |
|---|---|---|---|---|
| `src/lib/resume-token.test.ts` | 19 | vs | `src/services/orchestrate-quote.test.ts` | 30 |
| `test/wkh225-suspended-runs.migration.test.ts` | 21 | vs | `test/agent-links.migration.test.ts` | 15 |
| `src/routes/compose.resume.test.ts` | 21 | vs | `src/routes/agent-links.test.ts` | 27 |
| `src/services/suspended-run.test.ts` | 37 | vs | `src/services/agent-link.test.ts` | 29 |
| `src/services/compose.suspend.test.ts` | 39 | vs | — | — |

**No hay inflación de tests.** El dato del AR era un artefacto aritmético.

### La densidad de comentario, medida en las dos direcciones

```
HU 225, producción (src/ no-test + supabase/):  +2671  ⇒  1350 comentario (50%) · 130 vacías · 1191 ejecutables
   idem, sin database.types.ts (generado)    :  +2509  ⇒  1317 comentario (52%) · 1062 ejecutables
```

Contra la línea de base **en el commit base**, no de memoria:

| Archivo (en `5578998`) | Total | Comentario | % |
|---|---|---|---|
| `src/lib/compose-limits.ts` | 38 | 36 | **94 %** |
| `src/lib/step0-debit.ts` | 34 | 23 | **67 %** |
| `src/lib/stranded-payment.ts` | 373 | 198 | **53 %** |
| **`src/routes/compose.ts`** | 1282 | 648 | **50 %** |
| **`src/services/compose.ts`** | 1804 | 793 | **43 %** |
| `src/services/orchestrate-quote.ts` | 406 | 127 | 31 % |
| `src/services/agent-link.ts` | 544 | 134 | 24 % |

**El 50 % de esta HU es la mediana de los archivos del camino del dinero que toca.** Los dos
archivos que concentran el diff ya estaban en 50 % y 43 % antes de que nadie tocara nada. El 47 %
que reportó el AR y este 50 % describen lo mismo: **densidad normal para este repo, no bloat.**

El `67 %` del fix-pack tampoco es anómalo: son 377 líneas de comentario en valor absoluto, y su
contenido es la explicación de cinco BLOQUEANTEs reproducidos — el material que más caro sale
perder.

---

### La pregunta que decide

> *¿Qué parte de esto seguiría existiendo si lo escribiera alguien que ya conoce esta librería y
> este repo?*

**Veredicto: el volumen está justificado.** La aplico en las dos direcciones, con citas.

#### Sobrevive — información que el próximo lector no puede derivar del código

1. **`supabase/migrations/20260823000000_wkh225_suspended_runs.sql:185-207`** (23 líneas).
   *"Un `RAISE EXCEPTION` sin bloque `EXCEPTION` aborta la transacción entera, y PostgREST corre cada
   `rpc()` en una transacción propia: ese UPDATE se descartaba siempre. Medido contra Postgres 16 —
   tres claims seguidos sobre una fila vencida dejaban el status en `suspended` las tres veces."*
   Alguien que sabe plpgsql sabe que un RAISE hace rollback. **Lo que no puede derivar es que en
   ESTE esquema eso volvía `expired` inalcanzable y dejaba emitir el residuo sin techo.** Es una
   medición, y borrarla es invitar a que alguien reponga el UPDATE adentro del RPC. **Se queda.**

2. **`src/routes/compose.ts:1052-1061`** (`ResumeStep0Debit.rejected`, ~28 líneas).
   *"En las CUATRO rutas de `budgetService.debit` el fallo sale por un canal que mezcla el rechazo
   con el no-sé … Un rechazo por saldo y un timeout POSTERIOR al commit de la RPC producen el MISMO
   valor."* Eso **no está en el tipo** de `budgetService.debit`, y para descubrirlo hay que leer las
   cuatro rutas. Y cierra con `TD-225-02` declarada. Es el ejemplo de lo que un docblock debe
   contener. **Se queda.**

3. **`.env.example:1539-1549`** — el orden de activación de tres pasos (migración → secreto →
   bandera) y qué rompe cada inversión. Información puramente operativa, cero derivabilidad. Y está
   **por debajo** de la densidad local: el bloque inmediatamente anterior
   (`PIPELINE_EXPOSURE_CEILING_USD`, `:1487-1536`) gasta ~50 líneas en **una** variable; esta HU
   gasta 46 en **tres**. **Se queda.**

4. **`src/lib/resume-token.ts:25-30`** — *"LO QUE NO SE COPIA DEL EXEMPLAR"*: por qué el
   razonamiento de `orchestrate-quote.ts` para aceptar multi-redención **no transfiere** acá.
   Es exactamente la pregunta que se hace quien conoce el exemplar. **Se queda.**

5. **`src/services/reconciliation.ts:482-491`** (`queried: boolean`) — *"`false` significa 'la
   feature está apagada y esta lista no se consultó', que NO es lo mismo que `rows: []` con
   `queried: true`"*. Es la doctrina `no-pude-preguntar-no-es-no` aplicada a un campo nuevo, y sin
   el docblock el campo se lee como redundante y alguien lo borra. **Se queda.**

#### No sobrevive — andamiaje que se recorta, o que se convierte

6. **`src/routes/compose.ts:1013-1029`** — el inventario de cinco viñetas *"LO QUE SE ESPEJA DE
   `/compose`, LÍNEA POR LÍNEA"* (18 líneas). **No pido borrarlo: pido convertirlo.** Es una lista
   mantenida a mano que hoy es cierta y que **se vuelve falsa sin que nadie la edite** en cuanto
   cambie cualquiera de los dos lados — el patrón `candados-que-se-pudren-solos`. Cinco viñetas que
   afirman una correspondencia son cinco aserciones sin escribir. Es CR-3.

7. **`src/routes/compose.ts:969-981`** — 13 líneas que **hoy no las lee nadie** porque quedaron
   huérfanas del símbolo que documentan. Es CR-1: no se borran, se mueven.

8. **`src/services/suspended-run.ts:64-72`** — 9 líneas de docblock para un cuerpo de 1
   (`return (value ?? null) as JsonColumn`). La mitad explica qué hace
   `exactOptionalPropertyTypes` —conocimiento de TypeScript, no de este repo—; la otra mitad
   (*"lo que queremos decir es que la columna es NULA"*) es la decisión y vale. **Recortable a ~3
   líneas.** Es el único bloque del diff que encontré donde la prosa explica la herramienta en vez
   de la decisión, y son 6 líneas: lo anoto por honestidad del método, no porque mueva la aguja.

**Conclusión de escala:** 1,78× del presupuesto, bajo el umbral de 2×; el sobrante concentrado en
producción está atribuido al hallazgo BLQ-ALTO-2 del AR; los tests están **exactamente** en la
densidad del repo (26,6 vs 26,7); y el 50 % de comentario es la mediana medida de los archivos que
la HU toca, no una desviación. **Este diff no tiene bloat que recortar. Tiene un espejo sin candado
(CR-3) y seis líneas de prosa sobre TypeScript.**

---

## Resumen de acciones pedidas

| # | Sev | Acción | Sitio | Costo |
|---|---|---|---|---|
| CR-1 | MENOR | Mover el docblock a inmediatamente arriba de `RESUME_CLAIM_HTTP` | `src/routes/compose.ts:969-981` → `:1147` | 2 min |
| CR-2 | MENOR | O agregar splits + recibo al fee del resume, o declarar `TD-225-03` en el docblock diciendo qué no hace y por qué | `src/routes/compose.ts:1912-1938` | 10 min (TD) |
| CR-3 | MENOR | Candado de paridad del espejo, patrón `test/payment-guards-live-in-one-place.test.ts:92-131` (con control de vacuidad) | test nuevo + opcionalmente helper `quoteStep0` | ~40 min |
| CR-4 | MENOR | Renombrar los 8 identificadores en castellano | `suspended-run.ts:364,370` · `routes/compose.ts:1714,1717,1718,1724,1729,1874` | 10 min |
| — | opcional | Recortar el docblock de `asJsonColumn` a ~3 líneas | `src/services/suspended-run.ts:64-72` | 2 min |

**Nada de esto toca `src/services/compose.ts:616` (CD-7): el guard `i > 0` sigue byte-idéntico a
`5578998:571` y así debe quedar.** Verificado también que `test/cited-lines-guard.citations.ts`
re-apuntó las dos citas de `:571` a `:616` explicando que el guard no se movió sino que lo
desplazaron 14 líneas de comentario insertadas más arriba.

Al cerrar los cuatro puntos, esta HU es **APPROVED** sin más revisión: los checks 1, 2 (salvo el
rename), 3, 5, 6 y 7 ya están en PASS con evidencia, y el gate corrió verde en los tres pasos.
