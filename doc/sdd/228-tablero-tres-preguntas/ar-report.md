# AR — Adversarial Review · WKH-365 (HU 228, tablero de las tres preguntas)

**Fecha**: 2026-08-25 · **Rama**: `feat/228-tablero-tres-preguntas` (worktree `/home/ferdev/.openclaw/workspace/a2a-tablero`) · **Base**: `origin/main` @ `f391325`
**Estado del árbol al revisar**: todo en el índice, nada untracked (`git status --short` sin `??`).

## Veredicto

> ## RECHAZADO — 2 BLOQUEANTEs (1 MEDIO, 1 BAJO) + 4 MENORes
>
> El código **corre, no gasta, no filtra y está bien pinneado** (20/20 mutantes muertos).
> Lo que rompe es la **tarjeta 2**: publica números bajo rótulos que esos números no
> tienen, y los publica con el chip **verde**. La HU existe para que el tablero no
> mienta; la tarjeta 2 miente hoy, en el estado normal del sistema que vigila.

| Orden de ataque del fix-pack | ID | Categoría | Archivo:línea |
|---|---|---|---|
| 1 | `BLQ-MED-1` | Data integrity / veracidad | `src/static/dashboard-tres-preguntas.html:212-219` |
| 2 | `BLQ-BAJO-1` | Error handling / "cero" vs "no sé" | `src/static/dashboard-tres-preguntas.html:197-199` |
| 3 | `MNR-1` | Cache invalidation / performance | `src/routes/dashboard.ts:481-528` |
| 4 | `MNR-2` | Cache invalidation | `src/services/tablero.ts:215` |
| 5 | `MNR-3` | Error handling | `src/adapters/solana/escrow-scan.ts:258` |
| 6 | `MNR-4` | Test coverage (higiene) | `src/services/tablero.test.ts:346-362` |

## Gate del repo — corrido COMPLETO y EN ORDEN por el Adversary, una vez

```
npx tsc -p tsconfig.json --noEmit  → 0
npm run lint                       → 0 · Checked 516 files
npm test                           → Test Files 310 passed | 6 skipped (316)
                                      Tests      6235 passed | 19 skipped (6254)
```

Coincide exactamente con lo declarado por el Dev. Los tres números que los README
publican los **deriví yo del índice**, no los copié:

| Número | Comando | Derivado | README dice | ✅ |
|---|---|---|---|---|
| archivos de test | `git ls-files \| grep -cE '^(src/.*\.test\.ts\|test/.*\.test\.(ts\|mjs))$'` | **316** | `README.md:378` / `README.es.md:412` = 316 | ✅ |
| archivos linteados | `git ls-files \| grep -cE '^src/.*\.ts$'` | **516** | `README.md:383` / `README.es.md:417` = 516 | ✅ |
| variables | `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example` | **192** | `README.md:351` / `README.es.md:385` = 192 | ✅ |

Los 316/516 además **coinciden con lo que el runner contó** (316 archivos de test, 516
linteados), o sea que no hay archivo invisible al índice: el modo de falla recurrente
#1 de este repo (untracked ⇒ gate verde falso) **no ocurrió**.

---

# 1. 🎯 ¿El tablero puede MENTIR? — el ataque central

## `BLQ-MED-1` · La tarjeta 2 publica un contador capeado bajo un rótulo de ventana, en verde

**Categoría**: Data integrity / veracidad (el AC del que cuelga toda la HU)
**Archivo:línea**: `src/static/dashboard-tres-preguntas.html:212-219` (`cuerpoReputacion`) — el dato viene de `src/services/tablero.ts:152-166`, que lo toma de `src/services/reputation.ts:388` (`cappedSettled`).

### Qué está mal

Dos cosas distintas, ambas visibles en el mismo `<table>`:

1. **`tasksSettled` NO es "liquidadas".** Es el contador **anti-Sybil capeado por caller**
   de `reputation.ts:205-210`: `for (const n of acc.settledByCaller.values()) tasksSettled += Math.min(n, K)`,
   con `K = 5` por defecto (`reputation.ts:49-53`, env `REPUTATION_MAX_TASKS_PER_CALLER`).
   El HTML lo publica bajo el encabezado `<th>liquidadas</th>` (`:213`).
2. **La ventana rotula números que no están en la ventana.** El `gte('created_at', ahora-30d)`
   vive **sólo** en la query del universo (`tablero.ts:120-125`). La query que produce los
   contadores (`reputation.ts:345-348`) **no lleva ningún filtro de fecha**. El HTML pone
   `Ventana: últimos 30 días` (`:212`) como encabezado de la tabla de contadores.

### Reproducción — ejecutada, no razonada

Probe con el `leerReputacion` **real** (sólo `../lib/supabase.js` doblado) y el `render()`
**real extraído del HTML del repo**. Input: 1 evento del agente dentro de la ventana; 501
eventos `status:'success'` liquidados, todos del mismo caller.

Instrumentación del doble (medido):

```
universo.gte = ["created_at","2026-07-27T04:08:20.318Z"]   ← la ventana está acá
standing.gte = null                                        ← y NO está acá
```

JSON que devuelve el service:

```json
{"status":"ok","agentes":[{"slug":"remit-fx","tasksSettled":5,"successCount":501,"failedCount":0}],"ventana":"últimos 30 días"}
```

HTML **literal** que produce `render()` y que ve el operador:

```html
<h2>2 · La reputación <span class="chip ok">con datos</span></h2>
<div class="motivo">Ventana: últimos 30 días</div>
<table><thead><tr><th>agente</th><th>liquidadas</th><th>ok</th><th>fallidas</th></tr></thead>
<tbody><tr><td>remit-fx</td><td>5</td><td>501</td><td>0</td></tr></tbody></table>
```

**Esperado**: un tablero que no miente.
**Real**: `liquidadas = 5` y `ok = 501` en la misma fila — **el subconjunto es 100 veces
más chico que el conjunto**, con chip verde `con datos`, bajo un encabezado que declara
una ventana de 30 días que ninguno de los tres números respeta.

### Por qué NO es un edge case raro

Es el **estado estacionario del sistema que este tablero vigila**. La sonda de WKH-364
llama al agente **24 veces por día desde UNA sola key** (`'7 * * * *'`). `settledByCaller`
para ese caller satura en `K=5` al sexto día-hora y **no se mueve nunca más**, mientras
`successCount` sigue subiendo. O sea: la primera semana de operación el tablero ya entra
en el estado que acabo de reproducir, y se queda ahí.

### Impacto

Un operador que abre el tablero para decidir si el camino del dinero está sano lee
"5 liquidadas / 501 ok" y concluye o bien que el tablero está roto, o bien —peor— alguna
de las dos cifras. El rótulo de ventana lo empuja a leer los tres números como actividad
reciente cuando son históricos completos. Es exactamente la clase de defecto que CD-10
prohíbe (una frase que afirma un mecanismo que el código no tiene), sólo que en la UI en
vez de en un docblock.

### Sugerencia (no la implemento)

Cortar la ambigüedad en el rótulo, no en la lógica de reputación (que es Scope OUT y
está bien): renombrar la columna a algo que diga lo que el número es (p. ej. "liquidadas
(capeadas por caller)"), y mover la etiqueta de ventana de encabezado de la tabla a donde
efectivamente aplica: el universo de agentes ("agentes con actividad en los últimos 30
días; los contadores son históricos completos"). El test que lo fija: una tarjeta con
`tasksSettled < successCount` renderizada, y un assert de que el HTML NO presenta la
ventana como alcance de los contadores.

---

## `BLQ-BAJO-1` · La caja sale verde con las celdas EN BLANCO cuando las columnas vienen NULL

**Categoría**: Error handling / "cero" vs "no sé"
**Archivo:línea**: `src/static/dashboard-tres-preguntas.html:197-199` (`cuerpoCaja`), habilitado por `esc()` en `:124` (`null|undefined → ''`).

### Qué está mal

`daily_spent_usd`, `daily_limit_usd`, `daily_reset_at` e `is_active` son **todas
nullables** en la base (`src/types/database.types.ts:201-215`), y el tipo del Dev lo
modela bien (`src/types/index.ts` — `number | null`). Pero el render las pasa por `esc()`,
que mapea `null → ''`. Resultado: una tarjeta **verde** con tres celdas **vacías**.

### Reproducción — ejecutada

Input (una fila legítima de `a2a_agent_keys`; una key sin techo diario o que todavía no
gastó hoy tiene exactamente esta forma):

```js
render({ caja: { status:'ok', budget:{}, daily_limit_usd:null, daily_spent_usd:null,
                 daily_reset_at:null, is_active:null } })
```

Salida real:

```html
class = panel ok
<h2>1 · La caja de la sonda <span class="chip ok">con datos</span></h2>
<div class="empty">La key no tiene saldo en ninguna red.</div>
<div class="kv"><span>gastado hoy</span><span></span></div>
<div class="kv"><span>techo diario</span><span></span></div>
<div class="kv"><span>el contador diario se reinicia</span><span></span></div>
```

**Esperado**: "gastado hoy" muestra un número, o dice que no hay dato.
**Real**: no muestra nada. El operador no puede distinguir **0**, **sin configurar** y
**el render se rompió** — que son las tres cosas que esta HU se propuso separar
(«"No sé" ≠ "está bien"», Story File §1).

Sub-caso del mismo render: `is_active: null` **no** dispara el aviso, porque la guarda es
`card.is_active === false` (`:200`). Una key con `is_active` NULL se presenta como activa
sin que nadie lo haya afirmado.

### Impacto

Acotado (la tarjeta no afirma "está bien", sólo omite), pero rompe la propiedad que la
propia HU declara: cada celda tiene que ser legible como dato o como ausencia, nunca como
nada. Y a diferencia de `BLQ-MED-1` no hay chip que lo advierta.

### Sugerencia

Un helper de presentación distinto de `esc()` para valores de dato (`esc()` es para
escapar, no para formatear ausencias): `null|undefined → '—  (sin dato en la fila)'`.
Test que lo fija: la misma tarjeta de arriba, assert de que ninguna `<span>` de valor sale
vacía. Y decidir explícitamente qué significa `is_active: null` en vez de dejarlo caer al
lado optimista.

---

## Lo que ataqué y NO cayó (medido, no supuesto)

| Ataque | Resultado |
|---|---|
| **¿Verde por ausencia?** Un `status` desconocido (`'todo-bien'`, `'flamante'`), `null`, `undefined`, `{}`, `42`, `'ok'` como string, `['ok']` | **Gris en los 7 casos.** Medido con el `render()` real: `caja class=panel sin-dato`, `rep class=panel sin-dato`, `escrows class=panel sin-dato`. Mutante `M21` (el `default` devuelve verde) → **KILLED**. |
| **¿El saldo de OTRO dueño?** | Mutante `M1` (borrar `.eq('owner_ref', ownerRef)`) → **KILLED**. Mutante `M2` (borrar `.eq('id', keyId)`) → **KILLED**. El falso de `tablero.test.ts:153-176` siembra DOS filas con el mismo `id` y distinto dueño y **aplica** los `.eq` de la cadena, así que sacar cualquiera de los dos filtros deja 2 filas ⇒ `PGRST116` ⇒ el **caso feliz** se pone rojo. Es un detector real, no decorativo. |
| **¿"cero" colapsa con "no sé"?** | No. `M3` (ignorar `degraded`) → **KILLED**. Y verifiqué la fuente: `computeStandingBatch([])` devuelve `{degraded:false, standings:vacío}` **sin tocar la DB** (`reputation.ts:336-340`), o sea que el mock de `tablero.test.ts` **no miente** sobre el caso de 0 slugs. `M16` (chequear sólo `keyId` y no `ownerRef` para `no_configurado`) → **KILLED**. |
| **CD-5 (no exponer la credencial)** | El `select` (`tablero.ts:70-72`) no pide `id` ni `key_hash`; `T-CD5-1` lo barre en 4 estados distintos. Se cumple **en la query**. |

---

# 2. ¿Compra? — la prohibición central

**OK.** Verificado por cuatro vías independientes:

1. `src/services/tablero.ts` importa exactamente: `scanEscrows`, `getLogger`, `supabase`,
   tipos, `reputationService`. **Ningún `fetch`, ningún `composeService`, ningún
   `orchestrate`.**
2. **El camino indirecto**: leí `computeStandingBatch` entero (`reputation.ts:336-397`) —
   es un `select` a `a2a_events` y un reduce en JS. Cero red saliente, cero débito.
3. **El único `fetch` del árbol nuevo** es el POST JSON-RPC de `escrow-scan.ts:200-205`,
   que manda `getProgramAccounts` + `getAccountInfo` (dos **lecturas**). No firma, no manda
   transacción, no toca el `Keypair` del operator. Un `getProgramAccounts` consume cuota
   del proveedor de RPC, **no fondos on-chain**.
4. **Métodos**: el diff de `dashboard.ts` agrega exactamente `fastify.get(` ×2 y nada más
   (barrido del diff staged). `T-RO-1` confirma 404 para POST/PUT/PATCH/DELETE en las dos
   rutas, y corrió en mi gate.

El argumento del Dev en el docblock (`tablero.ts:11-16`) —que sin `A2A_PROBE_KEY` en el
proceso "no gastar" pasa de promesa a **capacidad ausente del entorno**— es correcto y
está aprobado en el SDD (DT-3, con refinamiento explícito de AC-1 en `sdd.md:63`). **No es
drift.**

---

# 3. Las dos desviaciones declaradas — veredicto

### `snapshot(cached)` en vez de `snapshot()` — **SE SOSTIENE, no abre agujero**

El argumento del Dev es correcto y lo medí: con la firma sin argumentos, el cache del
plugin sería **decorativo** — la ruta no tendría cómo decirle al service "esta tarjeta no
la vuelvas a leer", y cada request golpearía el RPC. Probe ejecutada: **8 recargas
secuenciales dentro del TTL ⇒ 0 lecturas del RPC**. Sin el parámetro serían 8.

¿Vía para inyectar tarjetas falsas desde la ruta? **No hoy**: `tableroService.snapshot` tiene
**un solo call-site** en todo `src/` (`dashboard.ts:494`, barrido con grep), y los valores
que le pasa salen de un `snapshot()` anterior del mismo proceso. El parámetro ensancha el
contrato del service (cualquier caller futuro podría pasar tarjetas arbitrarias) pero eso
es una superficie interna sin caller hostil alcanzable, no un finding.

### `vencidos: null` inconstruible sin motivo — **ES endurecimiento real**

`TableroVencidos = { vencidos: number } | { vencidos: null; vencidos_reason: SinDatoReason }`
(`src/types/index.ts`). El compilador rechaza `{ vencidos: null }` a secas, así que
CD-8 («nunca `0` por no haber podido leer, nunca sin motivo») deja de depender de la
disciplina. Verificado además por mutación: `M8` (usar `Date.now()` en vez del reloj del
cluster) → **KILLED**; `M17` (offset del Clock 32→24) → **KILLED**.

---

# 4. El cache

### El bug que el Dev declara haber corregido: **está, y lo maté con un mutante**

`M10` — cambiar `if (cajaHit === null) {` por `if (true) {`, o sea volver a re-datear una
tarjeta servida DEL cache → **KILLED**. `M10b` — lo mismo en las tres entradas a la vez →
**KILLED**. El testigo es `dashboard.tablero.test.ts:362-396` (4 recargas dentro de la
ventana + assert a los 61 s). El arreglo es real, no declarativo.

### `TTL_SIN_DATO` (15 s) < `TTL_OK` (60 s): **se respeta**

`M14` (subir `TTL_SIN_DATO` a 60 s) → **KILLED**. `M20` (que `tableroTtl` devuelva siempre
`TTL_OK`) → **KILLED**.

### `MNR-1` · Estampida: N requests **simultáneas** ⇒ N lecturas del RPC

**Categoría**: Cache invalidation / performance · **Archivo:línea**: `src/routes/dashboard.ts:481-528`

El cache se escribe **después** del `await`, así que no hay dedupe de peticiones en vuelo.
Probe ejecutada contra la app Fastify real, con el service tardando 300 ms (un RPC en 429
con backoff del proveedor):

```
8 requests SIMULTANEAS  -> lecturas del RPC: 8
8 requests SECUENCIALES -> lecturas del RPC: 0
```

El objetivo escrito en DT-6 («un reload en bucle martille justo al RPC que ya está en
429») **sí se cumple** para el bucle secuencial, que es el caso que el SDD describe. Lo que
no cubre es varias pestañas/operadores abriendo a la vez — y el endpoint tiene
`rateLimit: false`. Es MENOR y no BLOQUEANTE porque exige token de admin y porque el caso
del SDD está cubierto. Fix si se decide: guardar la *promesa* en el cache, no el valor
(single-flight).

### `MNR-2` · `generatedAt` se refresca aunque las tres tarjetas salgan del cache

**Archivo:línea**: `src/services/tablero.ts:215` (`generatedAt: new Date().toISOString()`)

Con las tres tarjetas en cache, la respuesta trae un `generatedAt` **de ahora** sobre datos
de hasta 60 s atrás, y el HTML pinta `Actualizado <hora>` con el reloj del **browser**
(`:275`), no con `generatedAt`. Nada en la pantalla expone la edad real de cada tarjeta.
La ventana es acotada y el TTL está especificado, así que es MENOR — pero es la misma
familia del bug que el Dev registró en su auto-blindaje («un dato viejo sin decirlo»),
sólo que topeada a 60 s. Fix barato: un `readAt` por tarjeta, o que `generatedAt` sea el
mínimo de los tres.

### Cache key sin `user_id` — **OK, y por qué**

No aplica el criterio de multi-tenant: las tres tarjetas son **globales por construcción**
(una key fijada por env, eventos sin `owner_ref`, escrows de un program id), el endpoint es
admin-only y el payload es cross-tenant **a propósito**. El contenido cacheado no varía por
caller, así que una key sin `user_id` es correcta acá, no un `BLQ-ALTO`.

---

# 5. Los escrows — layout y reloj

**El decodificador está pinneado byte a byte. 9 mutantes, 9 muertos.**

| Mutante | Qué cambia | Resultado |
|---|---|---|
| `M4` | `OFFSET_MINT` 104 → 105 | **KILLED** |
| `M5` | `OFFSET_AMOUNT` 136 → 137 | **KILLED** |
| `M6` | `OFFSET_DEADLINE` 144 → 145 | **KILLED** |
| `M7` | `OFFSET_STATUS` 152 → 153 | **KILLED** |
| `M17` | `OFFSET_CLOCK_UNIX_TIMESTAMP` 32 → 24 | **KILLED** |
| `M8` | el reloj pasa a ser `Date.now()` en vez del sysvar Clock | **KILLED** |
| `M9` | `deadline < now` → `deadline > now` | **KILLED** |
| `M15` | borrar el filtro `status !== Deposited` (contar liberadas como vivas) | **KILLED** |
| `M18` | `mint === usdcMint` → `true` (sumar peras con manzanas) | **KILLED** |

El test del reloj que el Dev declara existe y funciona (`escrow-scan.test.ts:447-468`):
mismo set de cuentas, dos relojes distintos ⇒ `vencidos` 0 y 2. Con `Date.now()` los dos
casos darían lo mismo — y `M8` lo confirma.

**¿Se come un escrow o inventa uno?** No encontré ninguno:
- `base58Encode` (`base58.ts:27-52`) indexa `bytes[i]` de forma **relativa**, así que el
  `subarray(104,136)` de `tally` (`escrow-scan.ts:127`) se codifica bien aunque tenga
  `byteOffset ≠ 0` — este era el candidato más jugoso (mint mal decodificado ⇒ todo USDC
  contado como "otro mint" ⇒ `usdc_bloqueado = 0.000000` con plata trabada de verdad) y
  **no ocurre**.
- `new Uint8Array(Buffer.from(b64,'base64'))` copia a un `ArrayBuffer` propio con offset 0,
  así que el `DataView` de `:126` no puede leer bytes de una cuenta vecina.
- Cualquier cuenta de tamaño ≠ 154 **tira la tarjeta entera** a `respuesta_invalida`
  (`:123`) en vez de decodificar a medias. Conservador y correcto.

### `MNR-3` · `vencidos_reason` es siempre `'rpc_error'`, aunque el RPC haya contestado

**Archivo:línea**: `src/adapters/solana/escrow-scan.ts:258`

`clockUnixTimestamp()` devuelve `null` por cuatro causas distintas (`:143-152`): sobre
ausente, error JSON-RPC, `result` que no es objeto, y **bytes de largo inválido /
`value: null`**. Las cuatro salen como `'rpc_error'`, que el HTML traduce a **«el RPC no
contestó»** (`:139`). En el caso de un Clock con shape inválido el RPC **sí contestó**, y
la HU tiene un motivo tipado exacto para eso: `'respuesta_invalida'`.

Repro: el propio test del Dev, `escrow-scan.test.ts:404-427`, manda
`{id:2, result:{context:{slot:1}, value:null}}` (el RPC respondió 200 con un envelope
válido) y afirma `vencidos_reason === 'rpc_error'`. La pantalla dirá que el RPC no
contestó cuando contestó. Es MENOR (una tarjeta que degrada bien, con el motivo torcido),
pero colapsa dos causas que el resto de la HU se esfuerza en mantener separadas.

---

# 6. Seguridad, con el repo público

**OK.** Sin hallazgos.

- **Gate**: usa `requireAdminTokenForTrace` (`dashboard.ts:320-337`), el **fail-closed**, no
  el opt-in grandfathered `requireAdminToken`. 503 en dev **y** en prod sin
  `DASHBOARD_ADMIN_TOKEN`, 401 con token incorrecto, comparación con
  `adminTokenMatches`. `T-GATE-1`/`T-GATE-2` cubren las dos longitudes de token y verifican
  que el service **no se llamó**. La regresión de que `/api/stats` sigue siendo opt-in
  también está (`dashboard.tablero.test.ts:161-169`) — nadie endureció ni aflojó el gate viejo.
- **¿El shell filtra algo?** No. `GET /dashboard/tres-preguntas` sirve un string leído al
  arranque; barrí el cuerpo del HTML servido y no hay un solo valor de tenant. El único
  `fetch` de la página es el GET del tablero (`HTML.match(/fetch\s*\(/g)` = 1, verificado).
- **XSS**: `esc()` (`:123-131`) escapa `& < > " '` **con el `&` primero**, y **todas** las
  interpolaciones pasan por él (`encabezado`, `kv`, `sinDatoCuerpo`, los tres cuerpos).
  `setEstado` usa `textContent`. Mutación: `M22` (sacar el escape de `"`) → **KILLED**;
  `M23` (mover el `&` al final, o sea doble-escape de las entidades propias) → **KILLED**.
- **El assert de XSS que el Dev dice haber corregido: el arreglo es real.**
  `render.test.ts:313-315` afirma tres cosas falsables: el slug **no** aparece verbatim,
  **no** hay `<img`, y —control positivo— **sí** aparece `&lt;img src=x onerror=alert(1)&gt;`.
  Eso mide *"los delimitadores están escapados"*, que es la propiedad. El assert viejo
  (`not.toContain('onerror=alert')`) medía la desaparición de una subcadena, que la
  implementación correcta **no** produce. Corrección bien diagnosticada.
- **Logs**: `tablero.ts:81-84` y `:128-131` loguean sólo `error.code`; `:205-211` loguean
  objeto vacío. `escrow-scan.ts:208-211` loguea `err.name`, `:217-220` el `httpStatus`.
  **En ningún log entra el `rpcUrl`** (que suele llevar la API key del proveedor), ni un
  saldo, ni el UUID de la key. El 500 de la ruta (`dashboard.ts:519-525`) loguea
  `err.message` server-side y devuelve un mensaje estático — `dashboard.tablero.test.ts:247-260`
  lo fija con un detalle secreto.
- **`localStorage`**: `TOKEN_KEY = 'wasiai_admin_token'` con el comentario "misma clave que
  /dashboard". **Verifiqué que la afirmación es cierta**: `dashboard.html:286` y
  `dashboard-trace.html:173` usan exactamente esa clave. No estrena una persistencia de
  secreto: hereda la que ya existe en dos pantallas.
- **Ownership guard**: `test/ownership-filter-guard.exceptions.ts` **sin tocar** y el
  guardián verde sin excepciones nuevas — el `.eq('owner_ref', …)` de `tablero.ts:74` es lo
  que lo mantiene así.

---

# 7. El árbol y los guards derivados de `git ls-files`

**OK.** Corrí el gate con **todo en el índice** (`git status --short` sin ningún `??`), y
los tres números derivados coinciden con los publicados y con lo que el runner contó (ver
tabla del encabezado). Ningún archivo nuevo quedó invisible a las 7 familias de guards.

---

# 8. Las 11 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | **Security** | **OK** — gate fail-closed correcto, XSS cubierto y mutado, cero secretos en logs, ownership filtrado y mutado, shell sin datos. |
| 2 | **Error Handling** | **`BLQ-BAJO-1`** (celdas en blanco con chip verde) + **`MNR-3`** (motivo del reloj colapsado). El resto correcto: `allSettled`, 200 con tres `sin_dato`, 500 con mensaje estático. |
| 3 | **Data Integrity** | **`BLQ-MED-1`** — los números de la tarjeta 2 no significan lo que su rótulo dice. Lo demás (derivación de conteos, suma sólo del mint configurado, reloj del cluster) está pinneado por mutación. |
| 4 | **Performance** | **`MNR-1`** (estampida concurrente). Sin N+1: 2 selects + 1 POST JSON-RPC batcheado de 2 elementos, con `AbortSignal.timeout(8000)`, sin reintento y sin fallback. |
| 5 | **Integration** | **OK** — sólo se agregan dos rutas GET nuevas bajo un plugin ya registrado; `reputation.ts`, la sonda y el guard de ownership sin tocar; `/api/stats` con su comportamiento viejo verificado por test. Cero breaking changes. |
| 6 | **Type Safety** | **OK** — `tsc --noEmit` limpio, cero `any` explícito. El único cast (`data.budget as Record<string,string>`, `tablero.ts:94`) es el patrón M9 del repo, y **verifiqué que el patrón existe de verdad**: `budget.ts:114` hace exactamente lo mismo sobre la misma columna `Json`. Las uniones discriminadas hacen `ok` inconstruible sin datos. |
| 7 | **Test Coverage** | **OK con `MNR-4`.** 20 mutantes aplicados, **20 muertos**, incluidos los 4 que el encargo pedía medir explícitamente. Cada bloque tiene control positivo. |
| 8 | **Scope Drift** | **OK** — ningún archivo de `src/` fuera de la lista de 13. Ver la observación sobre `_INDEX.md` abajo (no es finding). |
| 9 | **Destructive Migrations** | **N/A** — cero `.sql`, cero migrations en el diff. La HU sólo **lee**. |
| 10 | **RPC con SECURITY DEFINER** | **N/A** — cero `supabase.rpc(...)` en los tres archivos nuevos/editados de `src/`. El "RPC" de la tarjeta 3 es JSON-RPC de Solana sobre HTTP, no una función de Postgres. |
| 11 | **Cache Invalidation** | **`MNR-1`** + **`MNR-2`**. El bug de vencimiento eterno está corregido y **mutado**; el `TTL_SIN_DATO < TTL_OK` se respeta y está **mutado**; la key sin `user_id` es correcta acá (payload global admin-only). |

### `MNR-4` · Un `vi.unstubAllGlobals()` dentro del cuerpo del test

**Archivo:línea**: `src/services/tablero.test.ts:346-362` (T-REP-1)

`vi.stubGlobal('fetch', fetchSpy)` en `:348` y `vi.unstubAllGlobals()` en `:361`, **dentro
del `it`**. Si cualquier `expect` de `:357-360` falla, el `unstub` no corre y `fetch` queda
doblado para el resto del archivo — un fallo se propaga como fallos en cascada y esconde su
propia causa. `escrow-scan.test.ts` lo hace bien (`afterEach`, `:185`). Es higiene, no
corrección: hoy la suite pasa. Fix: mover a `afterEach`.

---

# 9. Observaciones que NO son findings

- **`doc/sdd/_INDEX.md` está modificado y figura en Scope OUT** (Story File §2 y §11: «la
  fila 228 ya existe»). Medido: en `origin/main` **no existía**, así que la premisa del
  Story File era falsa y agregarla es correcto. Además el texto de la fila dice
  *"in progress (F1 escrito — esperando `HU_APPROVED`)"*, o sea que lo escribió el Analyst
  en F1, no el Dev en F3. **No lo cuento contra el Dev.** Sí conviene que `nexus-docs`
  actualice esa celda al cerrar, porque hoy miente sobre el estado de la HU.
- **AC-1 dice `GET /auth/me` y el código lee la fila en proceso.** **No es drift**: está
  aprobado en `sdd.md:43-63` (DT-3), con el refinamiento explícito de AC-1 escrito para que
  F4 no lo lea como desviación. Lo anoto para que QA no lo re-abra.
- **Un `{status:'ok'}` sin payload se pinta verde con celdas vacías** (medido). Es
  **inconstruible desde el servidor** (lo impide `TableroCard<T>`), y el servidor es la
  única fuente de ese JSON. Queda como **sospecha sin camino de explotación**, no como
  finding — pero es el mismo síntoma que `BLQ-BAJO-1`, así que el fix de aquél lo cubre.
- **Presupuesto de diff**: el Dev declara 2.904 líneas contra un techo de 3.150 (1,84x). No
  lo re-derivé (es check 7 del CR, no del AR), pero la justificación de `auto-blindaje.md`
  es contrastable y el riesgo que §10 anticipaba (una abstracción común para las tres
  lecturas) **no se materializó**: leí los tres módulos y no comparten más que el tipo
  `TableroCard<T>`.

---

# 10. Metodología — cómo se produjeron estos números

- **Gate completo, en orden, una vez**: `tsc` → `lint` → `npm test`. `npm run qa` **no
  existe** en este repo (verificado en `package.json`).
- **20 mutantes**, aplicados de a uno con `perl -0777 -pi`, corridos contra el archivo de
  test pertinente (más `test/ownership-filter-guard.test.ts` para los de `tablero.ts`), y
  **restaurados por `cp` desde una copia previa**, no con `git checkout` — que sobre un
  árbol con todo staged habría funcionado igual, pero el modo de falla conocido es que
  borre justo lo que se está midiendo. Cada mutante verifica que la mutación **aplicó**
  (`cmp` contra el original antes de correr) para que un no-op no se reporte como KILLED.
- **4 probes ejecutables** (semántica de la ventana, render de la tarjeta 2 con el HTML
  real, casos límite del render, estampida concurrente contra la app Fastify real),
  escritas como archivos temporales en el repo, corridas, **borradas**, con
  `git status --porcelain` verificado limpio después de cada una.
- **Integridad final**: `md5sum -c` de los 4 archivos mutados → **OK los 4**; `git diff`
  (working tree vs índice) → **vacío**. El árbol quedó byte a byte como lo dejó el Dev.

---

## Qué tiene que hacer el Dev (fix-pack, en este orden)

1. **`BLQ-MED-1`** — rotular la tarjeta 2 con la semántica real de sus números (cap por
   caller) y sacar la ventana de donde no aplica. Testigo: una tarjeta con
   `tasksSettled < successCount` renderizada.
2. **`BLQ-BAJO-1`** — formatear las ausencias como ausencias en `cuerpoCaja` (no con
   `esc()`), y decidir qué significa `is_active: null`.
3. **`MNR-1` / `MNR-2` / `MNR-3` / `MNR-4`** — se documentan; el humano decide si entran en
   este fix-pack o al backlog. Ninguno bloquea el gate.

**Los dos BLOQUEANTEs bloquean el gate. NO se avanza a CR/F4 sin fix-pack.**
