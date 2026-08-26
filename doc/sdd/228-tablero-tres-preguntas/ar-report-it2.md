# AR — iteración 2 (re-AR del fix-pack) · WKH-365 · Tablero de las tres preguntas

- **Rama / commit**: `feat/228-tablero-tres-preguntas` @ `42fcd31` (árbol limpio al empezar y al terminar).
- **Alcance**: SÓLO el fix-pack post-AR/CR. La iteración 1 (`ar-report.md`, `cr-report.md`) no se
  re-barre; lo que aparece acá o es del fix-pack, o es una consecuencia del diff que la iteración 1
  demostrablemente no miró (y se dice cuál es cuál).
- **Veredicto**: 🔴 **RECHAZADO** — 1 `BLQ-MED`, 2 `BLQ-BAJO`, 2 `MNR`.

> ⚠️ **Nota metodológica que condiciona todo el reporte**: el fix-pack **no tiene commit propio**.
> `42fcd31` es el único commit de la HU (`HEAD~1` es `f391325`, el merge de WKH-225), así que el
> fix-pack quedó aplastado dentro del commit de la implementación. Consecuencia práctica: **el
> reparto «el fix-pack agregó ~411 líneas, ~276 son testigos» no es re-derivable de git**. El total
> sí (ver §5).

---

## Gate del repo — corrido COMPLETO, en orden, una vez, sobre el árbol del índice

`npm run qa` **no existe** en este repo. La secuencia es la de `.github/workflows/ci.yml`:

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | ✅ exit 0 |
| 2 | `npm run lint` | ✅ exit 0 — `Checked 516 files in 176ms. No fixes applied.` |
| 3 | `npm test` | ✅ exit 0 — `Test Files 310 passed \| 6 skipped (316)` · `Tests 6247 passed \| 19 skipped (6266)` |

Los tres números que los README declaran quedan **verificados contra el gate y contra el árbol**:
**316** archivos de test (paso 3), **516** archivos de lint (paso 2) y **192** variables
(`grep -cE '^[A-Z][A-Z0-9_]*=' .env.example` → `192`). `test/readme-numbers.test.ts` los re-deriva y
está verde.

---

## 1 · 🎯 ¿La tarjeta 2 todavía puede mentir? — **SÍ, en otro renglón**

### Lo que el fix-pack SÍ arregló (construido, no leído)

Salida real de `render()` extraído del HTML del repo, con el escenario que el AR-1 midió
(`tasksSettled: 5`, `successCount: 501`):

```html
<h2>2 · La reputación <span class="chip ok">con datos</span></h2>
<div class="motivo">Universo: los agentes con actividad en los últimos 30 días. Los contadores de
cada fila NO se acotan a esa ventana: son el historial completo del agente.</div>
<table><thead><tr><th>agente</th><th>liquidadas (con tope por caller)</th>
<th>ok (histórico)</th><th>fallidas (histórico)</th></tr></thead>
<tbody><tr><td>remit-fx</td><td>5</td><td>501</td><td>0</td></tr></tbody></table>
<div class="motivo">«liquidadas» es el contador anti-Sybil de la reputación: cada caller aporta a
lo sumo un tope fijo de tasks. Por eso puede quedar MUY por debajo de «ok» sin que nada esté roto,
y por eso no es la cuenta de tasks liquidadas. «ok» y «fallidas» no tienen tope.</div>
```

Un operador que lee esto **ya no puede creer que 5 son liquidaciones**: la columna dice que tiene
tope por caller y la nota al pie dice por qué puede quedar muy por debajo de «ok». **El BLOQUEANTE
central del AR-1 está cerrado.**

Contrastado contra el código, no contra la frase:

| Afirmación nueva | Verificada contra | Veredicto |
|---|---|---|
| «Los contadores de cada fila NO se acotan a esa ventana» | `reputation.ts:344-348` — `.from('a2a_events').select(...).in('agent_id', slugs)`, **sin `gte`/`lte` de fecha** | ✅ **CIERTA** |
| «son el historial completo del agente» | ídem: sin filtro de fecha, agrega todo el historial del slug | ✅ **CIERTA** |
| «liquidadas … cada caller aporta a lo sumo un tope fijo» | `reputation.ts:205-210` (`Math.min(n, K)` por caller) + `:49-53` (`K = REPUTATION_MAX_TASKS_PER_CALLER`, default **5**) | ✅ **CIERTA** (matiz sin impacto: «fijo» es fijo *por deployment*, la env lo mueve) |
| ««ok» y «fallidas» no tienen tope» | `reputation.ts:147` y `:162` — incrementos crudos | ✅ **CIERTA** |
| `tablero.ts:164-170`: «una sonda que llama todos los días desde UNA key lo satura en K» | `reputation.ts:149-154` (`settledByCaller`) + `cappedSettled` | ✅ **CIERTA** |

### `BLQ-MED-1` · El rótulo nuevo afirma un universo COMPLETO que la query no entrega

**Categoría**: Data integrity / prosa falsa en pantalla
**Archivo:línea**: `src/static/dashboard-tres-preguntas.html:247-249` (y su gemelo en
`src/services/tablero.ts:37-43`: *«Acota QUIÉNES entran a la tabla, y NADA más»*)

El fix-pack cambió `Ventana: últimos 30 días` (el rótulo falso del AR-1) por
**`Universo: los agentes con actividad en los últimos 30 días`**. La segunda mitad de esa frase es
cierta; **la primera mitad es una afirmación NUEVA y es falsa**, porque la query no devuelve «los
agentes con actividad en la ventana» sino *hasta 50 slugs distintos, sacados de las 1.000 filas más
recientes de `a2a_events`, sean o no de agentes*:

```
tablero.ts:127-132   .from('a2a_events').select('agent_id')
                     .gte('created_at', desde)
                     .order('created_at', { ascending: false })
                     .limit(EVENTOS_LIMITE)          // EVENTOS_LIMITE = 1000  (tablero.ts:47)
tablero.ts:146       if (slug === null || vistos.has(slug)) continue;   // ← la fila NULL ya gastó
                                                                       //   su lugar de los 1000
tablero.ts:149       if (slugs.length >= SLUGS_LIMITE) break;          // SLUGS_LIMITE = 50 (:49)
```

**Por qué NO es teórico** — el mecanismo lo alimenta la propia sonda que este tablero existe para
vigilar:

- `src/middleware/event-tracking.ts:19-25` + `:133-137`: **toda** request a `/discover`,
  `/orchestrate`, `/compose`, `/auth/agent-signup` o `/gasless/status` inserta una fila en
  `a2a_events`, y esa fila va con **`agent_id = null`** (`services/event.ts:71`,
  `agent_id: input.agentId ?? null`; el hook no pasa `agentId`). El hook está registrado global en
  `src/index.ts:288`.
- La sonda de WKH-364 corre `'7 * * * *'` = **24 corridas/día**, y cada corrida pega a **2** de esos
  prefijos (`GET /discover` + `POST /compose`) ⇒ **48 filas con `agent_id = null` por día**, o sea
  **~1.440 en 30 días**. **La sonda sola desborda el techo de 1.000 en ~21 días**, sin contar el
  tráfico real ni los eventos por step.

**Reproducción ejecutable** (probe temporal contra `leerReputacion` con un falso de Supabase que
**aplica** el `limit`, como PostgREST; el probe se corrió y se borró, árbol limpio verificado):

```
Input : 1000 filas {agent_id: null} más recientes  +  1 fila {agent_id:'remit-corridor-fx-solana'}
        (o sea: el agente SÍ tuvo actividad dentro de los 30 días)
Real  : limit aplicado = 1000
        computeStandingBatch llamado con []      ← el slug nunca llegó al batch
        card = { status:'ok', agentes: [], ventana:'últimos 30 días' }
Control POSITIVO: con 999 filas NULL, el mismo agente SÍ entra.
Tercer caso: 60 slugs distintos ⇒ computeStandingBatch recibe 50 y 'agente-59' queda afuera,
             sin que nada lo diga en pantalla.
```

**Lo que ve el operador** con ese input (render real, chip **VERDE**):

```html
<h2>2 · La reputación <span class="chip ok">con datos</span></h2>
<div class="empty">Sin actividad en los últimos 30 días. Es una respuesta, no una ausencia:
se preguntó y no hubo.</div>
```

**Impacto**: la tarjeta afirma, en verde y con énfasis, *«se preguntó y no hubo»* sobre un universo
en el que **sí hubo**. Es exactamente la confusión «cero» vs «no sé» que esta HU existe para
eliminar, sólo que ahora entra por truncamiento en vez de por rótulo. Un agente ausente de la tabla
se lee como agente sin actividad.

**Atribución honesta**: el copy `Sin actividad … se preguntó y no hubo` viene del Story File
(`story-file.md:168`) y es de la iteración 1. **Lo que el fix-pack agregó es la frase que lo vuelve
una mentira cerrada**: antes el rótulo decía sólo `Ventana: últimos 30 días` (ambiguo); ahora dice
`Universo: los agentes con actividad en …`, que es una afirmación de completitud.

**Sugerencia** (sin escribir el código): que el rótulo declare los dos techos que la query aplica —
por ejemplo «hasta N agentes, tomados de los últimos M eventos registrados dentro de la ventana» — y
que el caso `agentes: []` deje de afirmar «no hubo» cuando el barrido se truncó. Los dos números ya
son constantes con nombre (`EVENTOS_LIMITE`, `SLUGS_LIMITE`), así que el rótulo puede derivarlos en
vez de repetirlos a mano. La pregunta que lo caza es la que el propio `auto-blindaje.md:195-196`
escribió: *¿de qué query salió ese filtro, y produce ESA query lo que estoy rotulando?*

---

## 2 · ¿La caja todavía puede salir verde sin datos? — **No por las columnas que el fix-pack cubrió**

`valorDeFila()` (`html:181-183`) atacado con 15 entradas hostiles, celda por celda vía `kv()`:

| Entrada | Celda renderizada | ¿Indistinguible de un valor real? |
|---|---|---|
| `undefined` | `sin dato · la fila viene en NULL` | no |
| `null` | `sin dato · la fila viene en NULL` | no |
| `0` / `-0` | `0` | no (y **es** un valor real) |
| `NaN` | `NaN` | no |
| `false` / `true` | `false` / `true` | no |
| `{a:1}` | `[object Object]` | no |
| `[1,2]` | `1,2` | no |
| `Infinity` | `Infinity` | no |
| `1n` | `1` | no |
| `''` | **(celda vacía)** | **sí** → ver `MNR-1` |
| `[]` | **(celda vacía)** | **sí** → ver `MNR-1` |

Las cuatro columnas son efectivamente nullables (`src/types/database.types.ts`, `Row` de
`a2a_agent_keys`: `daily_limit_usd: number | null`, `daily_reset_at: string | null`,
`daily_spent_usd: number | null`, `is_active: boolean | null`), o sea que la premisa de `B-2` era
correcta. Las tres ramas de `is_active` (`html:219-225`) están y la de NULL no cae al lado
optimista. Chip verde con celdas en blanco: **ya no se puede construir por esa vía**.

### `MNR-1` · El assert que el fix-pack declaró «que no envejece» sólo cubre las celdas que pasan por `kv()`

**Categoría**: Test coverage / prosa que afirma de más
**Archivo:línea**: `doc/sdd/228-tablero-tres-preguntas/auto-blindaje.md:222-224` contra
`src/static/dashboard-tres-preguntas.html:254-255` y `:265`

`auto-blindaje.md:223-224` afirma: *«El assert que lo caza barato y no envejece es
`not.toContain('<span></span>')`: no nombra ninguna columna, así que sigue valiendo cuando se
agregue la próxima.»* **Medido: es falso.** Ese assert sólo ve las celdas que se generan con `kv()`
(que emite `<span>…</span>`). Las otras dos superficies de valor de la pantalla **no pasan por `kv()`
ni por `valorDeFila()`**:

```
Input : reputacion.agentes = [{ slug:'remit-fx', tasksSettled:null, successCount:undefined, failedCount:null }]
Real  : class="panel ok"   →  <tr><td>remit-fx</td><td></td><td></td><td></td></tr>
        html.includes('<span></span>') === false      ← el assert NO lo ve

Input : escrows.usdc_bloqueado = null
Real  : class="panel ok"   →  <div class="big"> USDC</div>       ← la cifra MÁS GRANDE de la pantalla, vacía
        html.includes('<span></span>') === false      ← el assert NO lo ve
```

**Por qué es MENOR y no BLOQUEANTE**: hoy no es alcanzable. `TableroEscrowsCard`/`TableroAgenteStanding`
exigen `string`/`number` en la rama `ok`, el payload lo produce este mismo proceso tipado, y
`usdc_bloqueado` siempre sale de `formatUnits(...)`. Lo falso es **la afirmación sobre la durabilidad
del testigo**, no el comportamiento de hoy. Idem `''` y `[]` de la tabla de arriba: sólo llegarían
por un valor del jsonb `budget`, que no tiene restricción de esquema.

### `MNR-2` · Mutante SOBREVIVIENTE: `valorDeFila` sin la guarda de `undefined`

**Categoría**: Test coverage
**Archivo:línea**: `src/static/dashboard-tres-preguntas.html:182`

```
Mutante : return valor === null ? SIN_DATO_EN_LA_FILA : valor;     (se cae `|| valor === undefined`)
Suite   : npx vitest run src/static/dashboard-tres-preguntas.render.test.ts
Real    : PASS (28) FAIL (0)   ← SOBREVIVE
```

Todos los fixtures del fix-pack usan `null`, ninguno `undefined`. La rama `undefined` no es
decorativa: `reply.send()` serializa a JSON y **`JSON.stringify` borra las propiedades
`undefined`**, así que una clave ausente en el payload llega al browser como `undefined`. Hoy los
tipos impiden construirla; el testigo, sin embargo, no la fija. (Restaurado por `cp` + `md5sum`
verificado.)

---

## 3 · Los mutantes declarados muertos — muestra reproducida + los que el Dev no probó

⛔ Arnés: copia previa en directorio propio, restauración por `cp`, `md5sum -c` verificado después de
cada corrida. **Nunca `git checkout --`.** Árbol final: `git status --porcelain` vacío, `md5sum -c`
OK en los 4 archivos, `HEAD` = `42fcd31`.

| # | Mutante | Origen | Suite | Resultado |
|---|---|---|---|---|
| MB1b | Revertir **sólo** el rótulo de ventana (`Universo: …` → `Ventana: <ventana>`), dejando la columna arreglada | declarado por el Dev | `render.test.ts` | ✅ **KILLED** — `expected … not to contain 'Ventana: últimos 30 días'` (`:331`). PASS 27 / FAIL 1 |
| MM3a | Colapsar los 3 `respuesta_invalida` de `clockUnixTimestamp` en `rpc_error` (el bug original) | declarado | `escrow-scan.test.ts` | ✅ **KILLED** — 2 tests, `expected 'rpc_error' to be 'respuesta_invalida'` (`:485`) |
| MM3b | Colapsar el `rpc_error` del `envelope.error` en `respuesta_invalida` (la dirección opuesta) | declarado | `escrow-scan.test.ts` | ✅ **KILLED** — `expected 'respuesta_invalida' to be 'rpc_error'` (`:508`) |
| **N-1** | `finally { tableroEnVuelo = null }` → limpieza **sólo en el camino feliz** | **nuevo, mío** | `dashboard.tablero.test.ts` | ✅ **KILLED** — `expected 500 to be 200` (`:425`) |
| **N-2** | `valorDeFila` sin la guarda de `undefined` | **nuevo, mío** | `render.test.ts` | ❌ **SOBREVIVE** → `MNR-2` |

**Los ataques nuevos que NO produjeron mutante porque el código aguanta:**

- **`hasOwnProperty` con claves heredadas**: `motivoTexto` probado con `hasOwnProperty`,
  `constructor`, `__proto__`, `toString`, `valueOf`, `propertyIsEnumerable`, `isPrototypeOf`, `''`,
  `null`, `undefined`, `0`, `{}`, `[]` → **los 13 devuelven `'motivo desconocido'`**, ninguno lanza.
  Control positivo: `motivoTexto('rpc_error') === 'el RPC no contestó'`. Y los 7 `SinDatoReason` del
  tipo (`types/index.ts`) están los 7 en `MOTIVOS` (`html:133-141`): ningún motivo válido cae al
  fallback.
- **`formatUnits` contra la versión INSTALADA** (`node_modules/viem/package.json` → **2.53.1**, no el
  `^` del `package.json`): `0n → "0"`, `1n → "0.000001"`, `1000000n → "1"`, `12000000n → "12"`
  (la ancla literal del fix-pack), `2n**64n-1n → "18446744073709.551615"`,
  `123456789012345678901234567890n → "123456789012345678901234.56789"`. Sin pérdida de precisión
  (BigInt) y sin `padStart`. El único input que produciría basura (`decimals = NaN` → `"0.12"`) es
  **inconstruible**: `getSolanaUsdcDecimals()` (`adapters/solana/chain.ts`) filtra con
  `Number.isFinite(parsed) && parsed >= 0` y cae al default.

---

## 4 · El single-flight — **aguanta los cuatro ataques**

Probe propio con Fastify real y el service doblado (creado, corrido y borrado):

| Ataque | Resultado |
|---|---|
| **A** — 8 requests simultáneas | ✅ **1** sola lectura en vuelo, `snapshot` llamado **1** vez, 8×200. **El número del Dev se reproduce.** |
| **B** — la promesa compartida **RECHAZA** con 8 colgados | ✅ 8×**500**, ninguno filtra el mensaje interno (`boom-compartido` no aparece en ningún body), **cero `unhandledRejection`** capturados con un listener propio, y la request siguiente da **200**: el `finally` limpió. |
| **C** — el rechazo **no se cachea** | ✅ tras el 500, la 2ª pasada llega con `{}` (nada quedó cacheado) y recién la 3ª trae las tres tarjetas. Un fallo no envenena el cache. |
| **D** — dos plugins (dos apps) | ✅ no comparten ni vuelo ni cache: la 2ª app llega con `{}`. El estado vive en el closure del plugin, no en un global. |

Nota sobre la categoría **Cache invalidation**: la clave de cache **no necesita `user_id`** porque
esta superficie no es multi-tenant por caller — es una lectura cross-tenant única detrás de
`requireAdminTokenForTrace` (fail-closed en dev y prod), y todos los operadores autorizados ven
exactamente el mismo payload. No hay fuga posible entre usuarios. Efecto colateral aceptado y no
reportado: un caller que se cuelga de un vuelo largo puede recibir una tarjeta cuyo `expiresAt` ya
venció (el `now` se toma al inicio de la lectura, `dashboard.ts:489`), lo cual **acorta** la vida del
cache, nunca la alarga.

---

## 5 · El presupuesto — el total cierra; el reparto del fix-pack no es re-derivable

**Medido** (`git diff --numstat f391325 HEAD` sobre `src/`, `.env.example`, `README.md`,
`README.es.md`, con `/usr/bin/git`):

| Concepto | Líneas |
|---|---|
| Tests (`escrow-scan.test.ts` 558 + `dashboard.tablero.test.ts` 465 + `tablero.test.ts` 575 + `render.test.ts` 521) | **2.119** |
| Producción + config + README (`escrow-scan.ts` 276 + `dashboard.ts` 160 + `tablero.ts` 249 + `html` 346 + `types/index.ts` 124 + `.env.example` 35 + READMEs 6) | **1.196** |
| **TOTAL** | **3.315** |
| Presupuesto SDD §10 / techo 2x | 1.575 / **3.150** |
| Ratio | **2,105x** — **165 líneas por encima del techo** |

✅ Los tres números que el fix-pack declara (**3.315**, **2,10x**, **165 por encima**) **son exactos**.

⚠️ **Lo que NO se puede verificar**: «el árbol que el AR y el CR midieron estaba en 2.904 y el
fix-pack agregó ~411, de las cuales ~276 son testigos». No hay commit pre-fix-pack (§nota inicial),
así que el reparto es **aritméticamente consistente pero no re-derivable**. Lo que sí pude contar a
mano, bloque por bloque, sobre los testigos que el propio `auto-blindaje.md` enumera:
`render.test.ts:189-219` + `:247-299` + `:309-353` ≈ 129, `dashboard.tablero.test.ts:362-401` +
`:403-428` ≈ 66, `escrow-scan.test.ts:271-287` + `:468-510` + el helper derivado `:138-139` ≈ 75 →
**≈ 270**, contra las ~276 declaradas. **Consistente.**

**¿Está justificado el exceso? Sí, y no propongo recortes.** Los 165 son consecuencia directa de un
AR **RECHAZADO**: quitar los testigos de los dos BLOQUEANTEs devolvería la HU al estado en que el
AR-1 la encontró. Lo único recortable que veo es prosa —y es prosa que el AR-1 y el CR-1 pidieron
por escrito—, así que recortarla cambiaría un hallazgo por otro. **La lección que el fix-pack escribe
(§«un presupuesto que no reserva nada para el fix-pack post-AR va a fallar siempre en la misma
dirección») es la corrección correcta y va al próximo SDD, no a éste.**

---

## 6 · Daño colateral

`git diff --numstat f391325 HEAD` (`/usr/bin/git`, nunca bajo `rtk`): 19 archivos, **0 borrados** en
todos ellos salvo los 3+3 de los READMEs. **Ningún archivo preexistente perdió líneas.**

Insertos que NO desplazan nada: `src/types/index.ts` (+124 **al final**, desde `@@ -2582,3`) y
`.env.example` (+35 **al final**, desde `@@ -1580,3`). **El único archivo preexistente que se
desplaza es `src/routes/dashboard.ts`: 792 → 952 líneas (+160).**

### `BLQ-BAJO-2` · 11 citas `dashboard.ts:N` del guard de ownership quedaron apuntando a código ajeno

**Categoría**: Integration / evidencia falsa en un documento de seguridad
**Archivo:línea**: `test/ownership-filter-guard.exceptions.ts:264, 275, 285, 286, 297, 317, 338, 347, 358, 384, 386`

Ese archivo es, por el docblock del propio guard, *«el motivo de CADA omisión, sitio por sitio»* del
filtro `owner_ref`. Sus citas eran **exactas** antes de esta HU y ahora apuntan a otra cosa:

| Cita | `f391325` (antes) | `42fcd31` (ahora) |
|---|---|---|
| `dashboard.ts:515-517` (`readLeasedRow`, «gate `requireAdminTokenStrict` en `:517`») | `fastify.post('/api/arbitrations/:intentId/resolve', { …preHandler: requireAdminTokenStrict })` | `reputacionCache = { value: snapshot.reputacion, expiresAt: … }` — **el cache del tablero** |
| `dashboard.ts:630` (`resolveIntent`) | `{ config:{rateLimit:false}, preHandler: requireAdminTokenStrict }` | un comentario: `* GET /dashboard/api/arbitrations/holds` |
| `dashboard.ts:598` (`listPending` / `driftCheck`) | `{ …preHandler: requireAdminToken }` de `/api/reconciliation` | `'dashboard stats failed',` |
| `dashboard.ts:300-309` (docblock cross-tenant del trace) | el docblock de `requireAdminTokenForTrace` | mitad de `requireReleaseLeaseToken` |
| `:264 (:477)`, `:297 (:424)`, `:317 (:680)`, `:384 (:390)` | todas resolvían a la línea `preHandler` de su ruta | todas caen en código no relacionado |

**Reproducción**: `git show f391325:src/routes/dashboard.ts` vs el árbol de HEAD, imprimiendo las
líneas citadas (hecho arriba, con contexto).

**Por qué la suite no lo ve**: `test/cited-lines-guard.*` es una lista **curada** —está verde y sus
citas curadas siguen bien—, y esos 11 números viven en prosa libre dentro del `exceptions.ts`, que
nada verifica. Y el AR-1 miró la pregunta equivocada: `ar-report.md:385` dice
*«`test/ownership-filter-guard.exceptions.ts` **sin tocar**»* — verificó que no se **modificó**, no
que sus citas siguieran resolviendo. Es literalmente *«los barridos miran lo que ESCRIBISTE, no lo
que DESPLAZASTE»*.

**Atribución honesta**: de las +160 líneas de `dashboard.ts`, el fix-pack aporta ~43 (el
single-flight `:530-556` y el docblock del TTL `:377-392`); las otras ~117 son de la iteración 1.
**No es una regresión introducida por el fix-pack**, pero la rama todavía no está mergeada y quien
la cierra hereda 11 punteros falsos en un archivo de seguridad. Por eso lo marco bloqueante-BAJO y no
menor: el costo de arreglarlo son 11 números, y el costo de no hacerlo es mandar a `main` a un
revisor de ownership al renglón que no es, durante una auditoría.

**Sugerencia**: re-anclar los 11 contra el árbol de la rama (todos siguen existiendo, sólo se
corrieron), o cambiarlos por el nombre del símbolo, que no se desplaza.

---

## 7 · La afirmación nueva que sí introdujo el fix-pack en el código

### `BLQ-BAJO-1` · El docblock del TTL cambió una razón falsa por otra razón falsa

**Categoría**: Prosa falsa / cache
**Archivo:línea**: `src/routes/dashboard.ts:377-386`

El fix `M-4` corrigió bien lo que el CR pedía: la frase ya no dice «alineado con
`STATS_CACHE_TTL_MS`». Lo verifiqué en las dos direcciones y **las dos correcciones son ciertas**:
`STATS_CACHE_TTL_MS = 30_000` está en `dashboard.ts:580`, **dentro** del plugin (que abre en `:398`),
y `TABLERO_TTL_OK_MS` está en `:386`, en scope de módulo ⇒ efectivamente **no es alcanzable** desde
ahí, y 60.000 es efectivamente el doble de 30.000.

**Pero la razón que se puso en su lugar es falsa**:

> `60 s: el DOBLE del cache de /api/stats (que son 30 s), porque ninguna de las tres fuentes de este
> tablero cambia en menos de un minuto.`

`a2a_events` —la fuente de la tarjeta 2, tanto para el universo (`tablero.ts:128`) como para los
contadores (`reputation.ts:346`)— **gana una fila por cada request rastreada**
(`middleware/event-tracking.ts:19-25`, `:133-137`). Dos `/compose` en el mismo segundo cambian esa
fuente en el mismo segundo. Y `computeStandingBatch` **no tiene cache propio** (el `_cache` de
`reputation.ts` sólo lo usa `computeReputationForAgent`), así que sin el TTL de 60 s el tablero
reflejaría el cambio de inmediato. Lo mismo, con menos frecuencia, para `a2a_agent_keys.daily_spent_usd`
(cambia en cada débito) y para los escrows (un depósito on-chain no espera un minuto).

**Impacto**: ninguno en runtime — el TTL de 60 s sigue siendo una elección razonable. El daño es el
que el propio `auto-blindaje.md:318-319` describe: *«toda prosa que diga "igual que X" se verifica
abriendo X. Si no se abre, no se escribe»*. Acá la frase que sostiene el número es falsable con un
input concreto y nadie la abrió, y es **la misma línea** que el fix-pack reescribió para sacar una
frase falsa. **La decisión es buena y la razón es falsa**, que es el patrón que se caza preguntando
*¿qué input hace falsa esta oración?*

**Sugerencia**: decir por qué 60 s es aceptable (cuánta desactualización tolera el operador, o el
costo de la fuente que se protege) en vez de afirmar una tasa de cambio de las fuentes que el
tráfico desmiente.

---

## 8 · Las 11 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | **Security** | ✅ **OK.** El fix-pack no toca gates. `requireAdminTokenForTrace` intacto (503 dev **y** prod, 401 con header incorrecto) — re-verificado con mi probe D. El HTML sigue siendo cascarón (`fetch(` ×1, sin `setInterval`/`setTimeout`, sin `/compose`·`/orchestrate`·`/settle`·`/payments`). `esc()` no se tocó y sigue escapando `& < > " '` con el `&` primero. El único cambio con superficie —`motivoTexto`— **cierra** un camino de prototipo, no lo abre: 13 claves hostiles, 13 al fallback. |
| 2 | **Error handling** | ✅ **OK.** `ClockLectura` separa las dos causas del `null` y **las dos direcciones tienen testigo** (MM3a/MM3b reproducidos). El `catch` de la ruta sigue con mensaje estático (mi probe B verificó que ni con 8 colgados se filtra el detalle). |
| 3 | **Data integrity** | 🔴 **`BLQ-MED-1`.** La ventana rotula un universo completo que la query trunca por dos techos. |
| 4 | **Performance** | ✅ **OK.** El single-flight es real y medido (8 → 1), no introduce fuga (probes B/C/D) y reduce carga sobre el RPC con cuota, que era el objetivo. |
| 5 | **Integration** | 🔴 **`BLQ-BAJO-2`.** Ningún contrato roto ni cambio incompatible (todo lo nuevo es aditivo; el rename `generatedAt`→`servedAt` es de un campo que nace en esta HU y no tiene consumidor externo), pero el desplazamiento de `dashboard.ts` dejó 11 citas falsas en el guard de ownership. |
| 6 | **Type safety** | ✅ **OK.** `ClockLectura` es una unión discriminada real, `tsc --noEmit` limpio, ningún `any` nuevo, `formatUnits` verificado contra **viem 2.53.1 instalado** (no contra el `^` del `package.json`). |
| 7 | **Test coverage** | ⚠️ **OK con `MNR-1` y `MNR-2`.** 5 mutantes corridos (3 declarados + 2 nuevos): **4 muertos, 1 sobreviviente**. |
| 8 | **Scope drift** | ✅ **OK.** El fix-pack no agrega archivos: los 19 del diff son los mismos 13 de `src/` que el AR-1 ya validó, más los 6 docs/config. `reputation.ts` sigue **sin tocar** (Scope OUT respetado: el arreglo fue el rótulo, no el número). |
| 9 | **Destructive migrations** | **N/A** — el diff no contiene ni un `.sql`, ni `ALTER`, ni `DROP`, ni `UPDATE`. La HU es 100 % de lectura. |
| 10 | **RPC con SECURITY DEFINER** | **N/A** — cero `supabase.rpc(...)` en el diff; el acceso a datos es `select` vía PostgREST, con `.eq('owner_ref', …)` presente en la única query de `a2a_agent_keys` (`tablero.ts:80-81`) y `a2a_events` sin columna de dueño (telemetría global). |
| 11 | **Cache invalidation** | ⚠️ **`BLQ-BAJO-1`** (la razón del TTL). El mecanismo en sí está bien: TTL por tarjeta, el fallo se cachea **menos** (15 s vs 60 s), una tarjeta servida del cache **no** renueva su vencimiento, y la clave no necesita `user_id` porque la superficie es un admin único cross-tenant detrás de un gate fail-closed. |

---

## Lo que ataqué y NO cayó

| Ataque | Resultado |
|---|---|
| 15 entradas hostiles contra `valorDeFila()` por `kv()` | sólo `''` y `[]` salen vacías, y ninguna de las dos es construible desde las columnas tipadas |
| 13 claves hostiles contra `motivoTexto` (incluida `'hasOwnProperty'`) | las 13 al fallback, ninguna lanza, control positivo verde |
| Los 7 `SinDatoReason` del tipo contra las 7 claves de `MOTIVOS` | cobertura completa: ningún motivo válido cae al fallback |
| `formatUnits` con `0n`, `2^64-1`, y un entero de 30 dígitos (viem 2.53.1 instalado) | correcto en los 3, sin pérdida de precisión; el único input tóxico (`decimals` NaN) es inconstruible por `chain.ts` |
| Promesa compartida que rechaza con 8 colgados + listener de `unhandledRejection` | 8×500, 0 unhandled, recupera a 200 |
| ¿El rechazo envenena el cache? | no: nada queda cacheado tras un fallo |
| ¿Dos instancias del plugin comparten vuelo/cache? | no |
| «los contadores son el historial completo» contra `reputation.ts:344-348` | **cierta** |
| «cada caller aporta a lo sumo un tope» contra `cappedSettled` (`reputation.ts:205-210`, K=5) | **cierta** |
| «`STATS_CACHE_TTL_MS` no es alcanzable desde ese scope» | **cierta** (`:580` dentro del plugin que abre en `:398`; el comentario está en `:377-386`, módulo) |
| ¿`src/types/index.ts` o `.env.example` desplazaron citas? | no: los dos son append puro al final |
| Los 3 números de los README (316 / 516 / 192) | los 3 coinciden con lo derivado del árbol y del gate |

---

## Resumen de hallazgos — ordenados para el fix-pack

| # | ID | Sev | Categoría | Archivo:línea | Una línea |
|---|---|---|---|---|---|
| 1 | `BLQ-MED-1` | 🔴 MEDIO | Data integrity | `html:247-249` (+ `tablero.ts:37-43`) | «Universo: los agentes con actividad en los últimos 30 días» es falso: `limit(1000)` sobre filas que en su mayoría van con `agent_id NULL`, más un tope de 50 slugs. La sonda sola desborda el techo en ~21 días, y el caso vacío afirma «se preguntó y no hubo». |
| 2 | `BLQ-BAJO-1` | 🟠 BAJO | Prosa / cache | `dashboard.ts:377-386` | «ninguna de las tres fuentes cambia en menos de un minuto»: `a2a_events` gana una fila por request rastreada. Razón falsa bajo una decisión buena. |
| 3 | `BLQ-BAJO-2` | 🟠 BAJO | Integration | `test/ownership-filter-guard.exceptions.ts:264,275,285,286,297,317,338,347,358,384,386` | 11 citas `dashboard.ts:N` que eran exactas en `f391325` ahora apuntan a código ajeno (+160 líneas). Nada las verifica. |
| 4 | `MNR-1` | 🟡 MENOR | Test coverage | `auto-blindaje.md:222-224` vs `html:254-255`, `:265` | El assert `not.toContain('<span></span>')` no cubre los `<td>` de la tarjeta 2 ni el `<div class="big">` de la 3: la afirmación «no envejece» es falsa. |
| 5 | `MNR-2` | 🟡 MENOR | Test coverage | `html:182` | Mutante sobreviviente: quitar la guarda de `undefined` de `valorDeFila` pasa los 28 tests. |

---

## Veredicto

🔴 **RECHAZADO.**

El fix-pack **cerró el BLOQUEANTE central del AR-1**: la tarjeta 2 ya no publica un contador capeado
bajo un rótulo que promete liquidaciones, y la caja ya no sale verde con las celdas en blanco. Los
tres mutantes que reproduje de los 13 declarados murieron, el single-flight aguantó los cuatro
ataques de concurrencia que le tiré, y el gate completo del repo está verde en orden.

Lo que lo rechaza es lo que la consigna mandó buscar: **el arreglo introdujo dos afirmaciones nuevas
que son falsas**, una en la pantalla (`BLQ-MED-1`) y una en el código (`BLQ-BAJO-1`), las dos en las
mismas líneas que el fix-pack reescribió para sacar una afirmación falsa. Más 11 citas que el diff
desplazó y nadie volvió a mirar (`BLQ-BAJO-2`).

**Orden sugerido para el próximo fix-pack**: `BLQ-MED-1` primero (es el único que le miente al
operador), después `BLQ-BAJO-2` (son 11 números y la rama no está mergeada), después `BLQ-BAJO-1`.
Los dos `MNR` son de testigo, no de conducta: entran si el Dev ya está en el archivo.

---

### Anexo · higiene del arnés

- Mutantes aplicados por reemplazo exacto de ancla (base64 para no pasar por el quoting del shell),
  restaurados por `cp` desde copia previa en directorio propio. **Nunca `git checkout --`**.
- `md5sum -c` verificado después de **cada** restauración: los 4 archivos OK.
- Los 2 archivos de probe (`src/services/__ar-it2-probe.test.ts`, `src/routes/__ar-it2-sf.test.ts`)
  se crearon, se corrieron y se borraron.
- Estado final: `git status --porcelain` **vacío** (antes de escribir este reporte), `HEAD` =
  `42fcd31`.
- Todo `git` se corrió con **`/usr/bin/git`** (bajo `rtk` el diff trunca cortando hunks con exit 0) y
  ninguna fuente se leyó con `cat`.
