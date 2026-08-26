# Code Review — WKH-365 (HU 228, tablero de las tres preguntas)

**Rol**: `nexus-adversary` en modo CR (calidad, patrones, escala).
**Fecha**: 2026-08-25 · **Worktree**: `/home/ferdev/.openclaw/workspace/a2a-tablero`
**Rama**: `feat/228-tablero-tres-preguntas` · **Base**: `origin/main` (`f391325`)
**Contrato**: `doc/sdd/228-tablero-tres-preguntas/story-file.md`

> **Este CR NO ejecutó la suite.** En paralelo corre el AR, que es el dueño de correr
> `npm test` sobre este worktree; dos corridas simultáneas la vuelven flaky. Todo lo de acá
> es **estático**, con `archivo:línea`, más cinco mediciones de árbol que no ejecutan tests
> (`git ls-files`, `git diff --numstat`, `grep -c`, y un `node -e` de tres líneas sobre una
> expresión copiada del HTML). Los `git diff` se corrieron con `/usr/bin/git` (bajo `rtk`
> truncan cortando hunks) y los fuentes se leyeron con el tool `Read`, nunca con `cat`.

---

## Veredicto

## **APROBADO** — 0 BLOQUEANTEs, 6 MENORes.

Ninguno de los 6 hallazgos rompe un AC, expone una vulnerabilidad ni pierde datos, así que
**ninguno bloquea el gate**. Se documentan para que el humano decida si entran en esta HU o
al backlog. El más accionable —y el único que responde de lleno a la pregunta del check 7—
es `MNR-1`: **7 líneas de código que no existirían si las escribiera alguien que ya conoce
las dependencias de este repo**, porque la función ya está importada por el archivo vecino
de la misma carpeta.

---

## Check 7 — la escala del diff (el que más importa)

### 7.1 El reparto declarado por el Dev: **medido, y es exacto**

El Dev afirma en `auto-blindaje.md:134-137` que *"descontando comentarios, `escrow-scan.ts`
son 182 líneas ejecutables sobre 264 y `tablero.ts` 144 sobre 230"*. **Verificado midiendo,
no leyendo** (total − vacías − líneas de bloque `/* * */` − líneas `//`):

| Archivo | Total | Vacías | Bloque | `//` | **Ejecutables** | Dev dijo |
|---|---|---|---|---|---|---|
| `src/adapters/solana/escrow-scan.ts` | 264 | 24 | 52 | 6 | **182** | 182 ✓ |
| `src/services/tablero.ts` | 230 | 19 | 62 | 5 | **144** | 144 ✓ |

Los dos números **coinciden al dígito**. Extendí la misma medición a los dos archivos que el
Dev no desglosó, sobre las líneas `+` del diff:

| Archivo | Añadidas | Prosa+vacías | **Ejecutables** | Presupuesto §10 |
|---|---|---|---|---|
| `src/routes/dashboard.ts` | 119 | 41 | **78** | 70 (1,11x) |
| `src/types/index.ts` | 115 | 67 | **48** | 55 (0,87x) |

**Total de código de producción ejecutable: 452 líneas contra 415 presupuestadas = 1,09x.**
El 1,46x del bloque "Producción + config" es real, pero el 87% del exceso es prosa
(`escrow-scan.ts` +32 de código y +82 de comentario; `tablero.ts` +4 de código y +86 de
comentario). **La afirmación del Dev se sostiene.**

Los otros dos renglones de producción no se dejan medir así y se contrastan aparte:
`.env.example` +35 contra 30 (1,17x, y es **todo** documentación de 3 variables) y el HTML
298 contra 280 (1,06x).

### 7.2 ¿Se materializó el riesgo que anticipaba §10 del Story File?

**No, y lo verifiqué en el árbol, no en el reporte.** §10 avisaba que el exceso vendría de
*"un helper HTTP genérico, un mini-framework de cards, o una interfaz común para las tres
lecturas"*. Barrido:

- **Interfaz común para las tres lecturas**: no existe. `leerCajaDeLaSonda`
  (`tablero.ts:61`), `leerReputacion` (`:115`) y `scanEscrows`
  (`escrow-scan.ts:162`) no comparten firma, ni tipo de retorno concreto, ni clase base, ni
  registro. `snapshot` (`tablero.ts:191-202`) las llama por nombre, una por una.
- **Mini-framework de tarjetas**: lo único compartido es `TableroCard<T>`, y son **3 líneas**
  (`src/types/index.ts:2627`, más el `TableroSinDato` de `:2615-2618`). Es un alias de unión
  discriminada, no un framework.
- **Helper HTTP genérico**: no existe. `escrow-scan.ts:200-205` es un `fetch` literal, con su
  `AbortSignal.timeout` inline; nadie más lo llama.

**El único candidato a abstracción prematura que encontré es `TableroCachedCards`**
(`tablero.ts:176-180`), y lo trato en la sección de desviaciones. No es una interfaz sobre
las tres fuentes: es un parámetro opcional del compositor.

### 7.3 Los tests a 2,17x: dónde está, y si sobreviviría

El renglón que se pasa solo. Medí de qué está hecho antes de opinar:

| Archivo | Total | Arnés/fixtures (líneas) | Casos |
|---|---|---|---|
| `tablero.test.ts` | 572 | 16-124 = **109** (falso de Supabase que APLICA la cadena) + 140-230 = 90 (fixtures/env) | 234-572 |
| `escrow-scan.test.ts` | 494 | 20-134 = **115** (constructor de cuentas byte a byte + expectativas derivadas) + 136-195 = 60 | 197-494 |
| `dashboard.tablero.test.ts` | 397 | 24-128 = **105** (mocks totales de los 6 imports de `dashboard.ts` + env) | 130-397 |
| `render.test.ts` | 380 | 14-121 = **108** (DOM mínimo + `new Function` con `document/window/fetch` por parámetro) | 123-380 |

**~437 de las 1.843 líneas de test son arnés que el presupuesto de §10 no contempló**, y las
cuatro piezas son exigencias escritas del contrato, no adorno:

- el falso que aplica los `.eq` es lo que hace que borrar `.eq('owner_ref', …)` ponga rojo el
  **caso feliz** (`tablero.test.ts:104-118` + el fixture de dos filas con el mismo `id` y
  distinto dueño, `:153-176`). Sin eso, T-CAJA-1 sería un test que aplaude cualquier cadena.
- el constructor byte a byte es literalmente T-ESC-1: *"Rojo con cualquier número
  hardcodeado"* (Story File §6). `esperadoVivos/esperadoUsdcBloqueado/esperadoVencidos`
  (`escrow-scan.test.ts:113-134`) derivan del mismo `ESCENARIO` que se serializa.
- los 105 de mocks de `dashboard.tablero.test.ts` son el precio de que `dashboard.ts` sea un
  plugin gordo con 6 servicios importados; es el patrón exacto del exemplar declarado en el
  Story File (§4 W2).

**Veredicto del check 7**: el exceso de tests es **información, no hallazgo** — está medido,
escrito antes del CR (CD-13) y su causa es un presupuesto que subestimó el arnés en ~40%.
La lección es para el **próximo SDD** (un presupuesto de tests que no separa arnés de casos
va a fallar siempre en la misma dirección), no para el Dev de esta HU. El total, 2.904 sobre
1.575, queda en **1,84x, bajo el techo de 2x (3.150)**, y el `numstat` que lo respalda lo
re-derivé yo: coincide fila por fila con `auto-blindaje.md:104-118`.

---

## 1. SOLID / responsabilidades — **OK, con una nota**

- **SRP**: las tres lecturas viven en tres lugares y ninguno hace el trabajo del otro.
  `escrow-scan.ts` no importa Supabase (verificado: sus imports son `logger`, `types`,
  `base58`, `chain` — `escrow-scan.ts:16-23`); `tablero.ts` no habla JSON-RPC.
- **DIP**: `tablero.ts:22` importa `scanEscrows` por módulo, lo que lo hace mockeable sin
  inyección (`tablero.test.ts:131-132`). Es el patrón del repo, no una desviación.
- **Nota (no finding)**: `tableroTtl(card: { status: 'ok' | 'sin_dato' })`
  (`dashboard.ts:385`) usa un tipo estructural en vez de la unión real. Funciona y es más
  laxo de lo necesario, pero el único caller le pasa tarjetas tipadas (`:504-520`). No lo
  cuento como hallazgo.

## 2. Naming — **1 MENOR**

`tableroService`, `escrow-scan`, `TableroCard`, `TableroVencidos` dicen lo que hacen y no
chocan con vocabulario del repo (barrido: `AgentCard`/`AgentCardIdentity` en
`types/index.ts:2137`/`:581` son del protocolo A2A y no comparten prefijo ni semántica con
`Tablero*Card`). Las funciones en español (`leerCajaDeLaSonda`, `leerReputacion`) son las dos
únicas de `src/` con esa forma, pero el archivo entero es de dominio en español y son
internas de su módulo: coherencia local antes que global. No es hallazgo.

### `MNR-1` — `SinDatoReason` es el único de los 11 exports nuevos sin prefijo
**Categoría**: naming · **Archivo**: `src/types/index.ts:2597`
Los otros diez exports nuevos son `TableroSinDato` (`:2615`), `TableroCard` (`:2627`),
`TableroCajaOk` (`:2630`), `TableroCajaCard` (`:2643`), `TableroAgenteStanding` (`:2646`),
`TableroReputacionOk` (`:2653`), `TableroReputacionCard` (`:2660`), `TableroVencidos`
(`:2670`), `TableroEscrowsBase` (`:2674`), `TableroEscrowsOk` (`:2683`),
`TableroEscrowsCard` (`:2685`), `TableroSnapshot` (`:2694`). `SinDatoReason` es el único que
entra al barrel global de 2.715 líneas sin decir de qué feature es.
**Impacto**: la próxima pantalla que necesite su propio vocabulario de "no sé" no tiene dónde
ponerlo sin colisionar o sin renombrar éste. Hoy no rompe nada.
**Sugerencia**: `TableroSinDatoReason`, o dejarlo y anotarlo en backlog. Es un rename de una
línea más 2 imports (`escrow-scan.ts:17`).

## 3. DRY — **1 MENOR, y es el hallazgo principal del CR**

### `MNR-2` — `formatUnits` privado que duplica el de `viem`, con OTRO formato de salida
**Categoría**: DRY / consistencia de producto
**Archivo**: `src/adapters/solana/escrow-scan.ts:76-83` (usado en `:249`)

`formatUnits(value: bigint, decimals: number)` está reimplementado a mano. La misma función
**ya está importada desde `viem` por el archivo vecino de la misma carpeta**:
`src/adapters/solana/deposit-verifier.ts:48` (`import { formatUnits, parseUnits } from 'viem'`),
y por cinco módulos de producción más: `src/adapters/escrow-verifier.ts:258`,
`src/adapters/deposit-verifier.ts:399`, `src/services/reconciliation.ts:709` y `:1103`,
`src/lib/downstream-payment.ts:536`. `viem` es dependencia directa del repo.

**Y no producen lo mismo.** Verificado contra la versión **instalada** (`viem@2.53.1`,
`node_modules/viem/_esm/utils/unit/formatUnits.js:12-23`, que hace
`fraction.replace(/(0+)$/, '')`):

| input | copia privada (`escrow-scan.ts:77`) | `viem@2.53.1` |
|---|---|---|
| `12_000_000n, 6` | `"12.000000"` | `"12"` |
| `0n, 6` | `"0.000000"` | `"0"` |
| `12_500_000n, 6` | `"12.500000"` | `"12.5"` |

**Reproducción**: el propio test lo fija. `escrow-scan.test.ts:284-290` afirma
`usdc_bloqueado: '0.000000'` para el caso de cero escrows; con la función que usa el resto
del producto sería `'0'`.
**Impacto**: la pantalla imprime `12.000000 USDC` (`dashboard-tres-preguntas.html:223`)
donde toda otra superficie de este servicio imprime `12`. No es un número equivocado —es el
mismo número con una convención que sólo existe acá—, y son 7 líneas de código que un dev
que ya conoce este repo no habría escrito. **Ésta es la respuesta concreta a la pregunta del
check 7.**
**Agravante menor**: la expectativa del test no es independiente. `esperadoUsdcBloqueado()`
(`escrow-scan.test.ts:121-130`) **reimplementa el mismo `padStart(decimals,'0')`** que la
implementación, así que cambiar la convención en los dos lados a la vez sigue dando verde.
El único ancla independiente es el literal `'0.000000'` de `:287`.
**Sugerencia**: importar `formatUnits` de `viem` (como hace el vecino `deposit-verifier.ts`)
y ajustar el literal de `:287`; o, si se decide a propósito mostrar los 6 decimales fijos
para que la columna no baile, escribir esa razón en el docblock y decir que se aparta de la
convención del repo. Hoy el docblock (`:76`) sólo dice *qué* hace, no *por qué* no reusa.

Fuera de esto, la duplicación es aceptable: `isRecord` (`escrow-scan.ts:91`) tiene un gemelo
en `src/mcp/router.ts:66`, pero son 3 líneas en dos capas sin nada en común — extraerlo a un
`lib/` compartido costaría más de lo que ahorra.

## 4. Cohesión y acoplamiento — **OK**

Contesto la pregunta que trae el encargo: **¿hay una función que hace las tres lecturas?**
No. `snapshot` (`tablero.ts:191-229`) sólo compone: un `Promise.allSettled` de tres
expresiones y un mapeo de rechazos a la rama `sin_dato` de cada tarjeta (`:216-228`). No
decodifica bytes, no arma queries, no habla HTTP.

El acoplamiento entre capas es el correcto y el corte está donde tiene que estar: el
adaptador (`escrow-scan.ts`) es el único que sabe de offsets, base58 y JSON-RPC; el servicio
es el único que sabe de Supabase; la ruta es la única que sabe de cache, HTTP y del gate. La
excepción a esa limpieza es el parámetro `cached`, que trato abajo.

## 5. Las dos desviaciones declaradas

### 5.1 `snapshot(cached?)` — **endurecimiento, con un costo real que vale nombrar**

**Veredicto: no abre superficie.** `TableroCachedCards` (`tablero.ts:176-180`) es un tipo de
sólo lectura con tres campos opcionales, todos del mismo tipo que la función devolvería; un
caller hostil no puede inyectar nada que no pudiera devolver la fuente, y el único caller es
`dashboard.ts:494`. La ruta no expone el parámetro (el handler no lee nada del `request` para
construirlo, `:483-499`). Y el endurecimiento que buscaba es real y está probado:
`tablero.test.ts:515-529` demuestra que una tarjeta cacheada **no vuelve a golpear su
fuente** (`expect(scanEscrows).not.toHaveBeenCalled()`), que es el punto entero contra un RPC
en 429.

**El costo**: mueve la conciencia del cache adentro del servicio. La alternativa —que la ruta
llame a los tres readers exportados sólo para los misses— borraría `TableroCachedCards`, los
tres ternarios de `tablero.ts:193-201` y los tres spreads condicionales de
`dashboard.ts:495-498`, a cambio de duplicar el `allSettled`. Es un empate defendible, y la
versión elegida tiene la ventaja de que **hay un solo lugar donde se arma un
`TableroSnapshot`**. Lo dejo como decisión aceptada, no como hallazgo — pero es la causa
directa de `MNR-3`.

### 5.2 `vencidos` como unión discriminada (`TableroVencidos`) — **endurecimiento neto**

**Veredicto: sí endurece, y es el mejor tipo del diff.** `src/types/index.ts:2670-2672` hace
literalmente imposible escribir `vencidos: null` sin motivo, y —lo que importa más— imposible
escribir `vencidos: 0` cuando lo que pasó es que no se pudo comparar: son ramas distintas de
la unión, no un campo nullable con un comentario pidiendo disciplina. Es la traducción exacta
de CD-8 a algo que verifica el compilador. `escrow-scan.ts:256-263` es la única construcción
y respeta las dos ramas. El test que lo prueba de verdad es
`escrow-scan.test.ts:447-468`: mismo set de cuentas, dos relojes distintos, dos veredictos
distintos — con `Date.now()` los dos casos darían el mismo número.

Una imprecisión, abajo (`MNR-4`).

## 6. Prosa que afirma de más (CD-10) — **1 MENOR**

Barrí las afirmaciones absolutas sobre terceros. La mayoría **son falsables y ciertas**, y
conviene decirlo porque es el defecto recurrente de las últimas tres HUs:

- `escrow-scan.ts:8-13` ("`Connection` reintenta ante 429 y no admite timeout por llamada")
  — es la razón de CD-7, heredada del SDD, y el código hace lo que la frase promete: `fetch`
  crudo con `AbortSignal` (`:200-205`), probado en `escrow-scan.test.ts:325-333`.
- `tablero.ts:11-16` ("capacidad ausente del entorno") — falsable: el módulo no importa nada
  que gaste, y hay un guard estructural sobre el propio fuente (`tablero.test.ts:364-379`).
- `tablero.ts:52-56` ("si no casan, PostgREST devuelve cero filas") — falsable, y el test lo
  ejercita con dos filas del mismo `id` (`tablero.test.ts:274-281`).
- `dashboard-tres-preguntas.html:117` (`// misma clave que /dashboard`) — **verificado**:
  `src/static/dashboard.html:286` usa `wasiai_admin_token`, la misma. La frase es cierta.
- `src/types/index.ts:2591-2595` ("los siete motivos no se comparten entre las tres fuentes")
  — la barrí sitio por sitio y **es cierta hoy**: caja usa los tres primeros
  (`tablero.ts:65,79,85,88,219`), reputación sólo el cuarto (`:132,149,223`), escrows los
  tres últimos (`escrow-scan.ts:165,212,221,226,230,235,238,244` y `tablero.ts:227`).

### `MNR-3` — un comentario afirma una alineación que los números desmienten
**Categoría**: prosa (CD-10) · **Archivo**: `src/routes/dashboard.ts:376`

```ts
/** Alineado con `STATS_CACHE_TTL_MS`, más largo porque nada de esto cambia rápido. */
const TABLERO_TTL_OK_MS = 60_000;
```

**Reproducción**: `STATS_CACHE_TTL_MS = 30_000` (`dashboard.ts:539`). 60.000 no está
"alineado con" 30.000: es el doble, cosa que la propia frase admite dos palabras después
("más largo"). Además el símbolo citado está declarado **dentro** del plugin
(`:539`, scope local) y el comentario vive 163 líneas antes, en scope de módulo: no es
alcanzable desde ahí. El origen es el Story File §5.4, que ya traía la afirmación errada
("TTL_OK = 60_000 (alineado con STATS_CACHE_TTL_MS)"); el Dev la copió y le pegó el parche.
**Impacto**: nulo en runtime. Es exactamente la clase de frase que CD-10 prohíbe, y la que
seis meses después hace que alguien "alinee" los dos valores creyendo que estaban iguales.
**Sugerencia**: decir el número y la razón sin invocar el otro símbolo — *"60 s; el doble del
cache de `/api/stats`, porque ninguna de las tres fuentes cambia en menos de un minuto"*.

## 7. El HTML — **legible, y el escape está en UN solo lugar. 1 MENOR**

**¿Es un `innerHTML` gigante?** No. Hay exactamente **un** sitio que asigna `innerHTML`
(`dashboard-tres-preguntas.html:182`, dentro de `pintar`), y recibe la salida de funciones
chicas y nombradas: `encabezado` (`:161`), `kv` (`:167`), `sinDatoCuerpo` (`:171`),
`cuerpoCaja` (`:186`), `cuerpoReputacion` (`:206`), `cuerpoEscrows` (`:222`). Ninguna pasa de
20 líneas. El resto del DOM se toca con `textContent` (`setEstado`, `:243-245`), que es
inmune por construcción.

**¿El escape está en un solo lugar?** Sí, y lo verifiqué interpolación por interpolación:
`esc()` (`:123-131`) es la única función de escape, y **toda** cadena que llega a `innerHTML`
pasa por ella — incluyendo las dos que vienen de datos ajenos: el slug del agente
(`:216-217`) y **las claves del jsonb `budget`** (`:194`, `kv('saldo en la red ' + redes[i],
budget[redes[i]])`, donde `redes[i]` es una clave de base y termina escapada dentro de `kv`).
El orden es el correcto (`&` primero, `:126`) y escapa comillas, que es lo que el `esc()` de
`dashboard.html` no hace. Está bien elegido y bien advertido en `:119-122`.

### `MNR-4` — `MOTIVOS[reason] ||` resuelve contra `Object.prototype` y esquiva su propio fallback
**Categoría**: legibilidad/robustez del HTML
**Archivo**: `src/static/dashboard-tres-preguntas.html:143-145`

```js
function motivoTexto(reason) {
  return MOTIVOS[reason] || 'motivo desconocido';
}
```

**Reproducción** (corrida con `node -e` sobre la expresión copiada del archivo):

| `reason` | esperado | real |
|---|---|---|
| `'constructor'` | `motivo desconocido` | `function Object() { [native code] }` |
| `'toString'` | `motivo desconocido` | `function toString() { [native code] }` |
| `'__proto__'` | `motivo desconocido` | `[object Object]` |

**Impacto**: bajo y acotado. **No es XSS**: la salida se interpola siempre a través de `esc()`
(`:155`, `:174`, `:228`), y el panel sigue pintándose gris —el `default` del `switch`
(`:156-157`) no depende de esto—. Lo que se rompe es la garantía escrita en `:147-148`: el
operador ve basura de runtime en vez de "motivo desconocido", y para llegar acá hace falta
que el servidor mande un `reason` fuera de la unión, o sea justo el caso que este fallback
existe para narrar. El test que cubre los siete motivos (`render.test.ts:163-186`) no lo
alcanza porque sólo prueba los válidos.
**Sugerencia**: `Object.prototype.hasOwnProperty.call(MOTIVOS, reason) ? MOTIVOS[reason] :
'motivo desconocido'`, o `Object.create(null)` para `MOTIVOS`. Una línea, y un caso más en
el bucle de `render.test.ts:163`.

**Nota de legibilidad a seis meses**: el HTML pasa la prueba. 85 líneas de CSS con variables
nombradas, un `<body>` de 24 líneas que se lee de un vistazo, y el comentario de cabecera
(`:7-22`) explica las tres decisiones que un lector futuro se preguntaría (por qué no hay
refresco automático, por qué no hay botón de disparo, por qué es un cascarón). No es prosa
repetida: cada afirmación aparece una vez.

## 8. Dos MENORes de semántica

### `MNR-5` — `generatedAt` se estampa al serializar, no al leer
**Categoría**: semántica del contrato · **Archivos**: `src/services/tablero.ts:215` +
`src/routes/dashboard.ts:483-499`

`generatedAt: new Date().toISOString()` se calcula siempre en el momento de armar la
respuesta, **incluso cuando las tres tarjetas vinieron del cache**.
**Reproducción**: request en T=0 (frío) → se leen las tres fuentes. Request en T=59 s → las
tres tarjetas se sirven del cache y son idénticas byte a byte a las de T=0
(`dashboard.tablero.test.ts:302-328` prueba exactamente ese paso: la segunda llamada recibe
las tres cacheadas), pero el `generatedAt` del body dice **T+59 s**. El único timestamp del
payload nombra el momento del render, no el de la lectura.
**Impacto**: acotado hoy —la pantalla ni siquiera lo muestra (barrido: `snap.generatedAt` no
aparece en el HTML)—, pero es un campo del contrato JSON que afirma una frescura que el
diseño no garantiza, en una HU cuyo eje es *"un dato viejo mostrado sin decirlo es la mentira
que esto viene a evitar"* (`auto-blindaje.md:62-78`, la entrada del cache eterno). Es la
misma familia de defecto que esa entrada cazó, un nivel más arriba.
**Sugerencia**: o `readAt` por tarjeta (la ruta ya tiene el dato: `expiresAt − ttl`), o
renombrar a `servedAt` y decir en el docblock que las tarjetas pueden tener hasta 60 s. Lo
segundo es una línea.

### `MNR-6` — `vencidos_reason` colapsa `respuesta_invalida` dentro de `rpc_error`
**Categoría**: precisión del motivo · **Archivo**: `src/adapters/solana/escrow-scan.ts:140-152`
y `:256-259`

`clockUnixTimestamp` devuelve `null` por **dos causas distintas**: el sobre del Clock trajo un
`error` JSON-RPC (`:143`), o el sobre no tiene la forma esperada / falta del batch
(`:145-149`). Las dos salen reportadas como `vencidos_reason: 'rpc_error'` (`:258`).
**Reproducción**: el propio test lo fija. `escrow-scan.test.ts:404-427` alimenta
`{ id: 2, result: { context:{slot:1}, value: null } }` —un problema de **forma**, no un error
del RPC— y afirma `vencidos_reason === 'rpc_error'` (`:426`). El motivo correcto según el
vocabulario de la propia HU sería `respuesta_invalida`, que existe y está a mano.
**Impacto**: bajo, pero va en contra de la razón por la que `reason` es obligatorio, escrita
en `src/types/index.ts:2603-2605`: *"una tarjeta que dice sin dato sin decir por qué no se
puede distinguir de un bug del tablero"*. Acá el operador no puede distinguir "el RPC falló"
de "no sé decodificar el Clock", que es exactamente esa frontera.
**Sugerencia**: que `clockUnixTimestamp` devuelva el motivo en vez de `null` a secas (un
`SinDatoReason | bigint`, o `{ ts } | { reason }`), y propagarlo en `:258`. Ajusta el assert
de `escrow-scan.test.ts:426` y suma un caso.

---

## Las 5 entradas del `auto-blindaje.md`, contrastadas

Las contrasté una por una porque el encargo las marca como interesantes. **Las cinco
conclusiones se sostienen**; dos las verifiqué con medición propia.

| # | Entrada | Verificación | Veredicto |
|---|---|---|---|
| 1 | Números del Story File envejecidos (305/503 → 312/510) | Derivé los tres del índice **ahora**: `316` test / `516` lint / `192` vars. Es exactamente lo que quedó publicado en `README.md:378`/`:383`/`:351` y `README.es.md:412`/`:417`/`:385`. | **Cierta y aplicada.** |
| 2 | `src/types/index.ts` está bajo el guardián de citas | `test/cited-lines-guard.citations.ts:87-102`: `CORTE_A_PATHS` son 14 paths y `src/types/index.ts` es el **primero**. Y el bloque nuevo (líneas 2584-2700) no tiene **ni un** token `:<dígito>` — lo verifiqué con el mismo `grep` que declara. | **Cierta y verificada.** |
| 3 | El assert de XSS confundía "escapado" con "ausente" | El razonamiento es correcto y el arreglo también: `render.test.ts:313-315` afirma las tres cosas falsables (no aparece verbatim, no hay `<img`, y el control positivo de que **sí** aparece `&lt;img …&gt;`). Es la propiedad correcta: los delimitadores están escapados, no el payload borrado. | **Cierta, y el fix es mejor que el assert original.** |
| 4 | El cache que se volvía eterno | Confirmado en el código: sólo se re-datea la entrada cuya lectura ocurrió (`dashboard.ts:503-520`, los tres `if (…Hit === null)`), y el test que lo prueba existe y hace lo que la entrada dice — 4 recargas dentro de la ventana y vencimiento igual a los 61 s (`dashboard.tablero.test.ts:362-396`). **La pregunta que propone —¿el vencimiento depende de cuándo se leyó la fuente o de cuándo alguien pidió la página?— es reutilizable y correcta.** | **Cierta, y es la entrada más valiosa de las cinco.** |
| 5 | Escribió la tabla del presupuesto ANTES de medirla | La tabla corregida (`auto-blindaje.md:104-118`) coincide fila por fila con el `numstat` que corrí yo, y el desglose ejecutable/prosa que agrega (`:134-137`) da **exacto** (182/264 y 144/230). O sea: la corrección no sólo se declaró, se hizo bien. | **Cierta.** |

Un apunte sobre la #5, que es la que más dice: la entrada admite haber cometido, en el
documento que registra defectos de medición, el mismo defecto de clase que registra. Ese
nivel de honestidad es lo que hace que las otras cuatro sean creíbles sin re-verificarlas —
igual las re-verifiqué, y aguantaron.

---

## Scope — **OK, sin drift**

`/usr/bin/git diff --cached origin/main --stat` da 17 archivos. Los 13 del Scope IN (§2 del
Story File) están todos y **ninguno de `src/` está fuera de esa lista**:

- Los 6 de producción/config: `src/types/index.ts`, `.env.example`,
  `src/adapters/solana/escrow-scan.ts`, `src/services/tablero.ts`,
  `src/static/dashboard-tres-preguntas.html`, `src/routes/dashboard.ts`.
- Los 4 de test: `escrow-scan.test.ts`, `tablero.test.ts`, `dashboard.tablero.test.ts`,
  `dashboard-tres-preguntas.render.test.ts`.
- Los 3 de cierre: `README.md`, `README.es.md`, `auto-blindaje.md`.

Los 4 restantes son artefactos de fases previas que la rama arrastra, no del Dev:
`work-item.md`, `sdd.md`, `story-file.md` (F1/F2/F2.5) y la fila `228` de
`doc/sdd/_INDEX.md`. **Scope OUT respetado**: `src/services/reputation.ts`,
`scripts/probe-money-path.mjs`, `.github/workflows/probe-money-path.yml`,
`test/ownership-filter-guard.exceptions.ts`, `test/ownership-filter-guard.test.ts` y
`src/index.ts` no aparecen en el diff. Cero repos vecinos tocados.

**Dos observaciones para el orquestador, no findings:**
1. El Story File §2 afirma que la fila `228` de `_INDEX.md` "ya existe" y la pone en Scope
   OUT; el diff muestra que **la agrega esta rama** (`doc/sdd/_INDEX.md:108`, +1 línea). Fue
   el F1, no el Dev — que la respetó y no la tocó. Sin consecuencia.
2. Esa fila sigue diciendo `in progress (F1 escrito — esperando HU_APPROVED)`. Es trabajo del
   cierre (`nexus-docs`), y `test/sdd-index-matches-folders.test.ts:30-33` documenta
   explícitamente que **no** valida el contenido del estado, así que no pone nada en rojo.

---

## Resumen de hallazgos

| ID | Sev | Categoría | Archivo:línea | Una línea |
|---|---|---|---|---|
| `MNR-1` | MENOR | Naming | `src/types/index.ts:2597` | `SinDatoReason` es el único de 11 exports nuevos sin prefijo `Tablero` |
| `MNR-2` | MENOR | DRY | `src/adapters/solana/escrow-scan.ts:76-83` | `formatUnits` privado duplica el de `viem` que ya importa el archivo vecino, y da `"12.000000"` donde el resto del producto da `"12"` |
| `MNR-3` | MENOR | Prosa (CD-10) | `src/routes/dashboard.ts:376` | "Alineado con `STATS_CACHE_TTL_MS`" — es el doble (60.000 vs 30.000) y el símbolo está en otro scope |
| `MNR-4` | MENOR | HTML | `src/static/dashboard-tres-preguntas.html:143-145` | `MOTIVOS[reason] \|\|` resuelve contra `Object.prototype`: `'constructor'` devuelve una función en vez de "motivo desconocido" |
| `MNR-5` | MENOR | Semántica | `src/services/tablero.ts:215` | `generatedAt` se estampa al serializar aunque las tres tarjetas vengan de un cache de hasta 60 s |
| `MNR-6` | MENOR | Semántica | `src/adapters/solana/escrow-scan.ts:140-152` | `vencidos_reason` reporta `rpc_error` también cuando el motivo real es `respuesta_invalida` |

**BLOQUEANTEs: 0.** Ninguno de los seis rompe un AC, expone una vulnerabilidad ni pierde
datos. Si se decide fixear en esta HU, el orden por relación valor/costo es
`MNR-2` (el del check 7) → `MNR-4` (una línea, y arregla una garantía escrita) →
`MNR-3` (una línea de comentario) → `MNR-5` → `MNR-6` → `MNR-1`.

---

## Qué leí para aprobar

Fuentes completas con el tool `Read`: `story-file.md` (367 líneas), `auto-blindaje.md`,
`src/adapters/solana/escrow-scan.ts`, `src/services/tablero.ts`,
`src/static/dashboard-tres-preguntas.html`, `src/services/tablero.test.ts`,
`src/adapters/solana/escrow-scan.test.ts`, `src/routes/dashboard.tablero.test.ts`,
`src/static/dashboard-tres-preguntas.render.test.ts`, y el diff completo (39,6 KB, sin
truncar) de `src/types/index.ts`, `src/routes/dashboard.ts`, `.env.example`, los dos README y
`doc/sdd/_INDEX.md`. Lecturas parciales: `src/routes/dashboard.ts:300-345` (el guard reusado),
`test/cited-lines-guard.citations.ts:87-102`, `test/sdd-index-matches-folders.test.ts:1-60`,
`node_modules/viem/_esm/utils/unit/formatUnits.js`, `src/static/dashboard.html:285-293`,
`work-item.md:62-89` (los 9 ACs).

Mediciones propias que no ejecutan la suite: conteo ejecutable/prosa de los 4 archivos de
producción; `git diff --cached origin/main --numstat`; derivación de los 3 números de los
README desde `git ls-files` y `grep -c` sobre `.env.example`; barrido de colisiones de
nombres sobre `src/`; barrido de `formatUnits` sobre `src/`; y un `node -e` de tres líneas
sobre la expresión `MOTIVOS[reason] ||` copiada del HTML.

**Lo que este CR NO verificó** (leelo antes de apoyarte en su verde): que la suite pase, que
`tsc --noEmit` esté limpio, que `npm run lint` esté limpio, y que los tests que leí
efectivamente estén en verde. Nada de eso se ejecutó acá **a propósito** — es del AR que
corre en paralelo y del F4. Todo lo de arriba es lectura de código y medición de árbol.
