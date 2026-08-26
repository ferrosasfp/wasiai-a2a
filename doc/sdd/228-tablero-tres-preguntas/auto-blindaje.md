# Auto-Blindaje — WKH-365 (HU 228, tablero de las tres preguntas)

Errores cometidos durante F3 y cómo se corrigieron. Se escribe cuando ocurren,
no al final.

---

### [2026-08-25] Wave 0 — La rama estaba desactualizada y los números del Story File ya habían envejecido

- **Error**: el Story File publicaba `305` archivos de test y `503` linteados
  como "valor hoy". Derivados del índice al empezar, eran `312` y `510`.
- **Causa raíz**: la HU 225 se mergeó a `main` DESPUÉS de que se escribiera el
  Story File, y la rama de esta HU salía de un commit anterior. Un número copiado
  de un documento envejece sin que nadie lo edite.
- **Fix**: `git fetch origin && git merge origin/main` antes de escribir una sola
  línea, y los tres números se DERIVARON del árbol en la misma corrida en que se
  escribieron:
  ```
  git ls-files | grep -cE '^(src/.*\.test\.ts|test/.*\.test\.(ts|mjs))$'
  git ls-files | grep -cE '^src/.*\.ts$'
  grep -cE '^[A-Z][A-Z0-9_]*=' .env.example
  ```
- **Aplicar en**: cualquier número que un artefacto publique sobre el árbol. El
  Story File no es una fuente de verdad sobre el repo; el índice de git sí.

---

### [2026-08-25] Wave 0 — `src/types/index.ts` está bajo el guardián de citas

- **Error**: casi escribo un `archivo:línea` dentro del bloque nuevo de tipos.
- **Causa raíz**: `src/types/index.ts` es uno de los 14 paths de `CORTE_A_PATHS`
  (`test/cited-lines-guard.citations.ts`), y ahí TODA cita —incluso un `:N`
  suelto, forma P4— tiene que estar declarada a mano en un archivo que NO está en
  el Scope IN de esta HU. Una cita nueva sin declarar pone `npm test` en rojo y
  el arreglo habría exigido tocar un archivo fuera de scope.
- **Fix**: cero tokens `:<dígito>` en el bloque agregado, verificado con
  `sed -n '2584,2700p' src/types/index.ts | grep -E ':[0-9]'` (sin resultados).
  El layout de `EscrowState` se documenta con offsets en columnas, sin dos puntos.
- **Aplicar en**: cualquier edición futura de los 14 paths del Corte A. Antes de
  escribir un comentario con una cita ahí, mirar si el archivo está en la lista.

---

### [2026-08-25] Wave 1c — Un assert de XSS que confundía "escapado" con "ausente"

- **Error**: el test del slug hostil exigía
  `expect(html).not.toContain('onerror=alert')` y se puso rojo con la
  implementación CORRECTA.
- **Causa raíz**: `esc()` escapa los delimitadores (`<`, `>`, `"`, `'`, `&`), no
  borra el texto. Un slug `<img src=x onerror=alert(1)>` escapado SIGUE
  conteniendo la subcadena `onerror=alert` — inerte, porque ya no hay tag que la
  interprete. El assert medía la presencia de una subcadena cuando lo que
  importa es si el navegador ve un tag.
- **Fix**: se afirma lo que sí es falsable — que el slug NO aparece verbatim
  (`not.toContain('<img src=x onerror=alert(1)>')`), que no hay `<img`, y el
  control positivo de que sí aparece `&lt;img src=x onerror=alert(1)&gt;`.
- **Aplicar en**: todo test de escape. La propiedad es "los delimitadores están
  escapados", no "el payload desapareció".

---

### [2026-08-25] Wave 2 — Un cache por tarjeta que se volvía eterno bajo recargas

- **Error**: la primera versión del handler re-escribía las tres entradas de
  cache en cada request, incluidas las que se habían servido DEL cache.
- **Causa raíz**: pisar `expiresAt` con `now + ttl` en una tarjeta que no se
  volvió a leer convierte un TTL de 60 s en "60 s después de la última recarga".
  Con alguien recargando la pantalla cada 30 s, la tarjeta no se refresca nunca y
  el tablero muestra un dato viejo sin decirlo — que es la clase de mentira que
  esta HU existe para evitar.
- **Fix**: sólo se re-datea la entrada cuya lectura efectivamente ocurrió
  (`if (cajaHit === null) { ... }`), y hay un test que hace cuatro recargas dentro
  de la ventana y comprueba que a los 61 s la entrada venció igual
  (`src/routes/dashboard.tablero.test.ts`, «una tarjeta servida del cache NO
  renueva su vencimiento»).
- **Aplicar en**: cualquier cache con TTL que se escriba en el mismo lugar donde
  se lee. La pregunta que lo caza: *¿el vencimiento depende de cuándo se LEYÓ la
  fuente, o de cuándo alguien pidió la página?*

---

### [2026-08-25] Wave 3 — Escribí el presupuesto ANTES de medirlo

- **Error**: la tabla de esta sección decía `723 / 1.157 / 1.880` y `1,19x`. Eran
  estimaciones mías, no una medición: al correr
  `git diff --cached --numstat -- src/ .env.example` el total real es **2.904**.
- **Causa raíz**: escribí el renglón "Real" de una tabla llamada *medido* antes
  de correr el comando que lo mide. Es el mismo defecto de clase que las tres
  entradas de arriba, cometido en el documento que las registra.
- **Fix**: los números de abajo salen del `numstat` de la corrida del gate, línea
  por archivo.
- **Aplicar en**: toda tabla cuyo encabezado diga "real", "medido" o "hoy". Si el
  comando no se corrió en esta sesión, la celda va vacía, no estimada.

---

## Presupuesto de diff (CD-13)

Medido con `git diff --cached --numstat` con TODO en el índice y DESPUÉS de correr
el formateador (`biome format --write`, que redistribuyó unas 70 líneas), sin
`doc/` ni los dos README (que sólo cambian tres números). Techo declarado en §10
del Story File: **~1.575 líneas · 2x = 3.150**.

| Archivo | Presupuesto §10 | Medido |
|---|---|---|
| `src/types/index.ts` | 55 | 115 |
| `.env.example` | 30 | 35 |
| `src/adapters/solana/escrow-scan.ts` | 150 | 264 |
| `src/services/tablero.ts` | 140 | 230 |
| `src/routes/dashboard.ts` | 70 | 119 |
| `src/static/dashboard-tres-preguntas.html` | 280 | 298 |
| **Producción + config** | **~725** | **1.061** (1,46x) |
| `src/adapters/solana/escrow-scan.test.ts` | 250 | 494 |
| `src/services/tablero.test.ts` | 280 | 572 |
| `src/routes/dashboard.tablero.test.ts` | 170 | 397 |
| `src/static/…render.test.ts` | 150 | 380 |
| **Tests** | **~850** | **1.843** (2,17x) |
| **TOTAL** | **~1.575** | **2.904** (1,84x) |

**1,84x del presupuesto, bajo el techo de 2x (3.150), así que CD-13 no exige
justificación por exceso.** Se escribe igual dónde está el exceso, porque el CR
lo contrasta (check 7):

- **El riesgo que §10 anticipaba NO se materializó.** No hay interfaz común para
  las tres lecturas, ni mini-framework de tarjetas, ni helper HTTP genérico. Las
  tres fuentes se leen con código propio —un `select` con filtro de ownership,
  otro `select` más el batch de standing, y un decodificador binario sobre
  JSON-RPC crudo— y lo único compartido es el tipo `TableroCard<T>`, que son 3
  líneas.
- **Dónde SÍ está el exceso, y qué parte sobreviviría a alguien que ya conoce
  esto**: la mayor parte del sobrante de producción es prosa —el layout de
  `EscrowState` en tabla, el porqué de no usar `Connection`, el porqué de leer la
  fila en proceso en vez de por HTTP. Descontando comentarios de bloque, de línea
  y renglones vacíos, `escrow-scan.ts` son **182** líneas ejecutables sobre 264
  (presupuesto 150) y `tablero.ts` **144** sobre 230 (presupuesto 140) — o sea
  que `tablero.ts` está prácticamente EN presupuesto de código y su exceso es casi
  todo prosa, y `escrow-scan.ts` se pasa en 32 líneas de código, no en 114.
- **Los tests son el renglón que más se pasó (2,10x)**, por tres causas
  identificables: (a) §6 pide 20 IDs de test y además un control positivo por
  bloque, así que hay ~2 casos por AC; (b) el falso de Supabase de
  `tablero.test.ts` APLICA los filtros de la cadena en vez de ignorarlos —es lo
  que hace que sacar `.eq('owner_ref', …)` ponga rojo el caso FELIZ, y eso cuesta
  unas 60 líneas de constructor; (c) `escrow-scan.test.ts` construye las cuentas
  byte a byte para poder DERIVAR los conteos esperados en vez de escribirlos a
  mano, que era un requisito explícito de T-ESC-1.

---
---

# FIX-PACK post-AR/CR — 2026-08-25

El AR salió **RECHAZADO** (2 BLOQUEANTEs) y el CR **APROBADO con 6 MENORes**. Lo
que sigue son las entradas del fix-pack: qué estaba mal, por qué se escribió así,
y con qué mutante se probó que el arreglo es real.

---

### [2026-08-25] Fix-pack — B-1: la tarjeta 2 mentía EN VERDE, en el estado NORMAL del sistema

- **Error**: dos rótulos falsos en la misma tabla. (a) `tasksSettled` se publicaba
  bajo `<th>liquidadas</th>`, y no es la cuenta de tasks liquidadas: es el
  contador **anti-Sybil capeado por caller** de `reputation.ts`, donde cada caller
  aporta a lo sumo K (default 5). (b) El encabezado decía *"Ventana: últimos 30
  días"* sobre una tabla cuyos tres números **no respetan ninguna ventana**: el
  `gte('created_at', …)` vive sólo en la query del universo; `computeStandingBatch`
  no lleva filtro de fecha.
- **Causa raíz**: tomé el nombre del campo del contrato de `reputation.ts` como si
  fuera su significado, y puse la etiqueta de ventana donde quedaba linda en vez de
  donde aplica. **Un nombre de campo no es su semántica**, y una etiqueta que está
  arriba de una tabla afirma algo sobre esa tabla.
- **Por qué es BLOQUEANTE y no cosmético**: la sonda de WKH-364 llama 24 veces por
  día desde UNA sola key, así que el cap satura en la primera semana y queda
  clavado mientras `successCount` sube. O sea que el estado **estacionario** del
  sistema que este tablero vigila muestra `liquidadas 5 · ok 501` con el chip
  **verde**. Un tablero que miente en verde es peor que no tener tablero — es el AC
  central de esta HU, invertido.
- **Fix**: el arreglo NO fue cambiar el número (`reputation.ts` es Scope OUT y su
  semántica es la correcta). Fue que la columna diga lo que el número es
  (`liquidadas (con tope por caller)` + una nota al pie que explica el anti-Sybil y
  que por eso puede quedar muy por debajo de `ok`), y que la ventana diga lo único
  que acota: `Universo: los agentes con actividad en los últimos 30 días. Los
  contadores de cada fila NO se acotan a esa ventana: son el historial completo del
  agente.` Más el docblock de `VENTANA_DIAS` y el del push de `agentes` en
  `tablero.ts`, para que el próximo que lea el service no repita la lectura.
- **Medido**: 3 mutantes, 3 muertos. `MB1a` (volver a `<th>liquidadas</th>`) →
  KILLED por `expected … not to contain '<th>liquidadas</th>'`. `MB1b` (volver
  SÓLO el rótulo de ventana, dejando la columna arreglada) → KILLED por
  `not to contain 'Ventana: últimos 30 días'`. `MB1c` (borrar la nota al pie) →
  KILLED por `to contain 'anti-Sybil'`. Los tres testigos son casos nuevos de
  `dashboard-tres-preguntas.render.test.ts` que renderizan el escenario real
  (`tasksSettled: 5`, `successCount: 501`) con el `render()` extraído del HTML.
- **Aplicar en**: toda pantalla que publique un contador ajeno. La pregunta que lo
  caza: *¿este rótulo sigue siendo cierto si el número satura, o si la fuente que
  lo produce no comparte el filtro que la etiqueta promete?* Y para las etiquetas
  de alcance (ventanas, filtros, "últimos N"): **¿de qué query salió ese filtro, y
  produce ESA query los números que estoy rotulando?**

---

### [2026-08-25] Fix-pack — B-2: la caja salía VERDE con las celdas en blanco

- **Error**: `daily_spent_usd`, `daily_limit_usd`, `daily_reset_at` e `is_active`
  son nullables en la base, y el render los pasaba por `esc()`, que mapea
  `null → ''`. Resultado: tarjeta verde con tres celdas **vacías**. Y `is_active:
  null` no disparaba el aviso porque la guarda era `=== false`, así que una key que
  nadie afirmó que esté activa se presentaba como activa.
- **Causa raíz**: usé el **escapador** como **formateador**. `esc()` mapear null a
  vacío es correcto para escapar y es lo peor posible para mostrar; que las dos
  cosas vivieran en una sola función hizo que la decisión de presentación se
  tomara sola, en el lugar equivocado.
- **Fix**: `valorDeFila()` separa la presentación del escape (`null|undefined →
  'sin dato · la fila viene en NULL'`), y `kv()` la usa antes de `esc()`. Más una
  tercera rama para `is_active`: `false` avisa DESACTIVADA, `true` no avisa nada, y
  cualquier otra cosa (`null`/ausente) avisa que la fila no lo dice. `esc()` quedó
  intacto, que es lo que corresponde: sigue siendo el escapador.
- **Medido**: 3 mutantes, 3 muertos. `MB2a` (que `kv` vuelva a `esc(valor)`) →
  KILLED por `not to contain '<span></span>'`. `MB2b` (que `valorDeFila` deje pasar
  el null, o sea el mismo agujero en el otro sitio) → KILLED por el mismo assert.
  `MB2c` (borrar la rama de `is_active` no-booleano) → KILLED por
  `to contain 'no dice si la key está activa'`. Hay además un test que fija la
  discriminación que importa: **0 y NULL producen HTML distinto**.
- **Aplicar en**: cualquier celda que venga de una columna nullable. El assert que
  lo caza barato es `not.toContain('<span></span>')`, y **su alcance es exactamente
  las celdas que emite `kv()`** — no las columnas: una columna nueva que pase por
  `kv()` queda cubierta sin tocar el test, y una que NO pase, no. ⚠️ Acá decía que
  «no envejece», y es falso: medido, `reputacion.agentes[].tasksSettled: null` sale
  `<td></td>` y `escrows.usdc_bloqueado: null` sale `<div class="big"> USDC</div>`
  —la cifra más grande de la pantalla, vacía, en verde— y el assert no ve ninguno
  de los dos, porque ninguno pasa por `kv()`. Hoy los dos son inconstruibles por
  tipos (`TableroAgenteStanding` exige `number`, `TableroEscrowsBase` exige
  `string`); lo que estaba mal era la afirmación sobre el testigo, no la pantalla.

---

### [2026-08-25] Fix-pack — M-1: reimplementé `formatUnits` teniendo el del vecino a la vista

- **Error**: `escrow-scan.ts` traía una copia privada de `formatUnits` (7 líneas
  con `padStart`) mientras el archivo **vecino de la misma carpeta**
  (`solana/deposit-verifier.ts`) ya importa el de `viem`, igual que otros cuatro
  módulos de producción. Y no dan lo mismo: la copia imprime `12.000000` donde
  `viem` imprime `12`. La pantalla mostraba los 6 decimales que ninguna otra
  superficie del producto muestra.
- **Causa raíz**: escribí la función antes de preguntarme si existía. Es
  exactamente la respuesta a la pregunta del check 7 del CR: *¿qué parte de esto
  seguiría existiendo si lo escribiera alguien que ya conoce esta librería?*
- **Fix**: `import { formatUnits } from 'viem'` (verificado contra la versión
  **instalada**, `viem@2.53.1`, leyendo `node_modules/viem/_esm/utils/unit/
  formatUnits.js`, que hace `fraction.replace(/(0+)$/, '')`; medido:
  `formatUnits(12000000n, 6) === "12"`).
- **El agravante, que era el hallazgo de verdad**: la expectativa del test
  **reimplementaba el mismo `padStart`** que la implementación, así que las dos
  podían cambiar juntas y quedar verdes. Ahora `esperadoUsdcBloqueado()` deriva
  QUÉ se suma del escenario y CÓMO se imprime de `viem`, más dos anclas literales
  a mano (`'12'` y `'0'`). `MM1` (restaurar la copia privada tal cual estaba) →
  **KILLED por 4 tests**, incluido `expected '12.000000' to be '12'` en la
  expectativa derivada: es el detector independiente que antes no existía.
- **Aplicar en**: antes de escribir un helper de formateo/parseo, `grep` del nombre
  en `src/` — el vecino de carpeta es el primer lugar a mirar. Y: **una expectativa
  que reimplementa la implementación no es una expectativa**, es la misma función
  escrita dos veces.

---

### [2026-08-25] Fix-pack — M-2: `generatedAt` se refrescaba sobre tarjetas cacheadas

- **Error**: `generatedAt: new Date().toISOString()` se estampaba siempre, incluso
  cuando las tres tarjetas venían del cache. Con las tres cacheadas, el único
  timestamp del payload decía "ahora" sobre datos de hasta 60 s antes.
- **Causa raíz**: el nombre se eligió cuando el service era el único que armaba el
  snapshot; cuando entró el parámetro `cached`, el nombre dejó de ser cierto y
  nadie lo revisó. **Es la misma familia del bug del cache eterno de W2**, un nivel
  más arriba: un dato viejo presentado sin decirlo.
- **Fix**: `servedAt`, con el docblock diciendo qué es y qué no, y una línea en la
  pantalla que ahora dice *"Pedido a las HH:MM · cada tarjeta puede venir de un
  cache reciente del gateway"* en vez de *"Actualizado HH:MM"*. **No** se puso el
  número del TTL en el HTML: sería un hardcode que se despega de
  `TABLERO_TTL_OK_MS` sin que nada lo note.
- **Lo que NO se hizo, con su costo**: la edad REAL por tarjeta (`readAt` derivado
  de `expiresAt − ttl`, que la ruta ya tiene). Es el arreglo fuerte y cuesta tocar
  los tres tipos de tarjeta más el serializador; el rename cuesta 1 campo y elimina
  la afirmación falsa, que es lo que el hallazgo pedía. Queda anotado acá para
  cuando alguien necesite la edad en pantalla.
- **Medido**: `MM2` (volver a `generatedAt`) → KILLED.

---

### [2026-08-25] Fix-pack — M-3: `vencidos_reason` decía "el RPC no contestó" sobre un RPC que contestó

- **Error**: `clockUnixTimestamp` devolvía `null` por cuatro causas y las cuatro
  salían como `'rpc_error'`, que el HTML traduce a *«el RPC no contestó»*. Una de
  ellas es un 200 con envelope válido y `value: null` — o sea un problema de
  **forma**, para el que la HU tiene un motivo tipado exacto (`respuesta_invalida`)
  y a mano.
- **Causa raíz**: el tipo de retorno (`bigint | null`) no tenía dónde llevar el
  motivo, así que el motivo se eligió en el call-site, una sola vez, para los
  cuatro casos. **El tipo hizo imposible decir la verdad**, y el default fue el
  motivo más alarmante.
- **Fix**: `ClockLectura = { ts: bigint } | { reason: SinDatoReason }`, con el mismo
  corte que ya usaba el resto del archivo: `error` JSON-RPC → `rpc_error`, problema
  de forma → `respuesta_invalida`. Es el mismo patrón que `TableroVencidos`, que el
  AR y el CR marcaron como el mejor tipo del diff: si el motivo tiene que viajar,
  viaja en el tipo.
- **Medido**: 2 mutantes en las DOS direcciones, 2 muertos. `MM3a` (colapsar todo
  en `rpc_error`, o sea el bug original) → KILLED. `MM3b` (colapsar todo en
  `respuesta_invalida`) → KILLED por el control positivo del error JSON-RPC. Un
  solo mutante habría dejado pasar un fix que arregla un caso rompiendo el otro.
- **Aplicar en**: toda función que devuelva `X | null` donde el `null` tenga más de
  una causa y alguien vaya a narrarla.

---

### [2026-08-25] Fix-pack — M-4: un comentario afirmaba una alineación que los números desmienten

- **Error**: `/** Alineado con STATS_CACHE_TTL_MS, más largo … */` sobre
  `TABLERO_TTL_OK_MS = 60_000`, cuando `STATS_CACHE_TTL_MS = 30_000`. No está
  "alineado": es el doble, cosa que la propia frase admitía dos palabras después.
  Encima el símbolo citado vive dentro del plugin y no es alcanzable desde ese
  scope.
- **Causa raíz**: **lo copié del Story File §5.4, que ya lo traía mal.** Una frase
  falsa en el contrato se propaga al código sin que nadie la mida, porque el
  contrato es justo lo que uno no vuelve a cuestionar.
- **Fix**: decir el número y la razón sin invocar el otro símbolo. Impacto en
  runtime: cero. Impacto a seis meses: es la frase que hace que alguien "alinee"
  los dos valores creyendo que estaban iguales.
- **Aplicar en**: toda prosa que diga "igual que X" / "alineado con X". Se verifica
  abriendo X. Si no se abre, no se escribe.

---

### [2026-08-25] Fix-pack — M-5: `MOTIVOS[reason] ||` esquivaba su propio fallback

- **Error**: con `reason = 'constructor'` devolvía `function Object() { [native
  code] }`; con `'__proto__'`, `[object Object]`. La cadena de prototipos gana
  antes de que el `||` llegue al fallback.
- **Causa raíz**: un objeto literal usado como diccionario hereda de
  `Object.prototype`, y el `||` sólo cubre falsy, no "no es propia".
- **Por qué importa aunque no sea XSS**: la salida pasa por `esc()` y el panel
  sigue gris, así que no hay ejecución. Lo que se rompe es la **garantía escrita
  dos renglones más arriba**, y justo en el caso que el fallback existe para
  narrar: un `reason` fuera de la unión. El test que barre los siete motivos no lo
  alcanzaba porque sólo probaba los válidos — **un test que sólo recorre el
  dominio legal no puede ver el borde**.
- **Fix**: `Object.prototype.hasOwnProperty.call(MOTIVOS, reason)`.
- **Medido**: `MM5` (volver al `||`) → KILLED por 2 tests: el unitario sobre
  `motivoTexto` con 5 claves heredadas, y el de render (`not to contain 'native
  code'`).

---

### [2026-08-25] Fix-pack — M-6: 8 requests simultáneas eran 8 lecturas del RPC

- **Error**: el cache por tarjeta se escribe **después** del `await`, así que no
  dedupe nada en vuelo. El AR lo midió contra la app real: **8 simultáneas → 8
  lecturas del RPC; 8 secuenciales → 0.**
- **Causa raíz**: escribí el cache pensando en el bucle de recargas (el caso del
  SDD, que sí queda cubierto) y no en varias pestañas abriendo a la vez. Un cache
  responde *"¿ya lo leí?"*; no responde *"¿lo estoy leyendo ahora mismo?"*.
- **Fix**: single-flight — se comparte la **promesa**, no el valor. El `finally`
  limpia siempre, así que un rechazo no deja una promesa muerta cacheada
  devolviendo 500 para siempre.
- **Medido**: 2 mutantes, 2 muertos, y el testigo dice el NÚMERO. `MM6` (sacar el
  dedupe) → KILLED por `expected 8 to be 1`, que es exactamente lo que el AR midió.
  `MM6b` (olvidarse de limpiar la promesa en vuelo) → KILLED por 3 tests. El test
  junta **todos** los resolvers a propósito: con uno solo, el mutante moría por
  **timeout**, que es rojo pero no dice cuántas lecturas hubo — *un rojo por
  timeout no es una medición*.

---

### [2026-08-25] Fix-pack — Lo que se decidió NO hacer, y por qué

Se documenta acá para que la próxima revisión no lo lea como omisión:

| ID | Hallazgo | Por qué no entra |
|---|---|---|
| `MNR-1` (CR) | `SinDatoReason` es el único de los 11 exports nuevos sin prefijo `Tablero` | Es un rename de una línea más 2 imports, **sin ningún comportamiento detrás**: ningún mutante puede distinguir el antes del después, así que entraría sin testigo. Y toca `src/types/index.ts`, que está bajo el guardián de citas. El costo real es el riesgo de colisión el día que otra pantalla estrene su vocabulario de "no sé", y ese día el rename es igual de barato. **Backlog.** |
| `MNR-4` (AR) | `vi.unstubAllGlobals()` dentro del `it` en `tablero.test.ts` (T-REP-1) | Higiene de tests, no corrección: hoy la suite pasa. El modo de falla es de segundo orden (si un `expect` de ese bloque falla, el `unstub` no corre y el fallo se propaga en cascada por el resto del archivo, escondiendo su causa). **No se toca en un fix-pack de veracidad**, para no mezclar cambios de testigo con cambios de conducta. **Backlog.** |

Y el `readAt` por tarjeta de `M-2`, que está anotado en su propia entrada con el
costo que tiene.

---

### [2026-08-25] Fix-pack — El presupuesto de diff se pasó del techo de 2x, y no se pasa en silencio

- **Medido, no estimado** (`git diff --cached --numstat HEAD` sobre
  `src/ .env.example README.md README.es.md`): **+3.315** líneas de
  producción + config + README, contra el presupuesto de 1.575 del SDD §10 y su
  techo de 2x = **3.150**. Son **165 líneas por encima del techo** (2,10x). El
  árbol que el AR y el CR midieron estaba en 2.904 (1,84x), **bajo** el techo: el
  fix-pack agregó ~411 líneas y ésas son las que lo cruzan.
- **Dónde están las ~411**: **~276 son tests** (los testigos de los dos
  BLOQUEANTEs y de los cuatro MENORes con conducta: el escenario `5 contra 501`,
  la caja con las cuatro columnas en NULL, el discriminador `0` vs `NULL`, las
  cinco claves heredadas de `Object.prototype`, los dos motivos del reloj en las
  dos direcciones, y las 8 requests simultáneas). Las **~135 de producción** se
  reparten en: el single-flight de `M-6` (~35 líneas, el único cambio de conducta
  del fix-pack que no es un rótulo), `ClockLectura` de `M-3` (~12), `valorDeFila`
  + la rama de `is_active` de `B-2` (~12), los rótulos de `B-1` (~14), y el resto
  es **prosa**: los porqués que el AR y el CR pidieron por escrito.
- **Por qué no se recorta**: el exceso es la respuesta a un AR **RECHAZADO**. El
  presupuesto de §10 se escribió para construir la HU, no para repararla, y un
  fix-pack sin testigos es un fix-pack que hay que creer. La alternativa —arreglar
  los dos BLOQUEANTEs sin los mutantes ni los casos que los fijan— habría entrado
  cómoda bajo el techo y habría dejado la HU exactamente donde el AR la encontró:
  con afirmaciones que nadie mide.
- **Lo que sí se recortó**: el `readAt` por tarjeta de `M-2` (se hizo el rename,
  que cuesta 1 campo) y los dos hallazgos sin conducta detrás (`MNR-1` del CR y
  `MNR-4` del AR), que están en la tabla de arriba con su razón.
- **La lección es para el próximo SDD, no para este fix-pack**: un presupuesto de
  diff que no reserva nada para el fix-pack post-AR va a fallar siempre en la
  misma dirección, igual que el presupuesto de tests que no separaba arnés de
  casos (§7.3 del CR). Las dos veces el número estaba bien calculado para un
  mundo en el que nada sale mal.

---

## Fix-pack 2 — el re-AR (`ar-report-it2.md`) rechazó con 3 bloqueantes

### [2026-08-25] Fix-pack 2 — B-1: el rótulo nuevo prometía un universo que la query no entrega

- **Error**: el fix-pack 1 cambió `Ventana: últimos 30 días` (falso) por
  `Universo: LOS agentes con actividad en los últimos 30 días` (también falso). La
  query trae hasta 1.000 filas de `a2a_events` y hasta 50 slugs, así que «los» es
  una promesa de completitud que la lectura no puede sostener. Y el techo de 1.000
  se lo comía la telemetría: `middleware/event-tracking.ts` inserta una fila por
  request rastreada, con `agent_id` en NULL.
- **Causa raíz**: **cambié una frase falsa por otra frase falsa** — el mismo patrón
  que este archivo ya documenta dos veces (`M-4`, y el rótulo de ventana original).
  El defecto de método es escribir el reemplazo sin preguntarse *¿con qué input
  concreto pongo esta frase en falso?*. Para «los agentes» el input era trivial:
  el agente 51.
- **Fix**, dos partes, y la segunda es la que cierra el agujero de verdad:
  1. la query filtra `.not('agent_id', 'is', null)` — el techo se gasta en filas
     que pueden aportar un agente;
  2. los dos techos **se ven**. La tarjeta viaja con `agentes_omitidos` (conteo
     EXACTO de agentes que la lectura vio y la tabla no muestra) y
     `lectura_truncada` (la lectura se cortó en su techo de eventos; desde ahí no
     se sabe cuántos agentes faltan, así que no se dice). El rótulo perdió el
     artículo, y **la lista vacía ya no puede decir «se preguntó y no hubo» si
     algún techo se tocó**: esa rama del render está condicionada al aviso.
  Son dos campos y no uno a propósito: uno afirma un número y el otro afirma una
  ignorancia, y colapsarlos obligaría a inventar el número o a callar el corte.
- **Una frase de este mismo fix se cazó al escribir el reporte**: el aviso decía
  «la lectura se cortó en su tope: NO se leyó toda la actividad de la ventana», y
  eso es falso en el borde — con exactamente 1.000 filas en la ventana la lectura
  sí vio todo. Quedó «PUEDE haber quedado actividad sin mirar», que es el estado
  epistémico real. **Es la tercera vez en esta HU que el reemplazo de una frase
  falsa nace falso**, y la única que se cazó antes de que la mirara un AR: la
  pregunta que la cazó es la misma de siempre, aplicada a lo que uno acaba de
  escribir en vez de a lo que encontró.
- **Medido contra la base real** (bdwv, 2026-08-25, sonda de sólo lectura corrida
  y borrada; ventana de 30 días): **2.011** filas con `agent_id` NULL contra
  **481** con agente (2.513 NULL en toda la tabla). La cadena vieja **tocaba el
  techo**: leía 1.000 filas y publicaba **5** agentes. La nueva lee 481 y publica
  **6**. ⚠️ El agente que falta hoy en producción es `remit-kyc-validator`, y nada
  en la pantalla lo decía. **Ojo con la versión más dramática de este hallazgo**:
  «las 1.000 más recientes son todas telemetría ⇒ el batch se llama con `[]` ⇒ la
  pantalla sale verde diciendo "no hubo"» es **construible y está en un test**,
  pero **NO es lo que la base muestra hoy** — hoy el daño es un agente invisible,
  no la tarjeta vacía. Los números son una FOTO: se re-derivan corriendo las dos
  cadenas.
- **Mutantes**: 6 aplicados, **6 muertos**. `M-B1a` (se cae el `.not`) → KILLED por
  el testigo de las 2.513 filas. `M-B1b` (vuelve el `break`, o sea los agentes de
  más no se cuentan) → `expected +0 to be 10`. `M-B1c` (`lecturaTruncada = false`)
  → `expected false to be true`. `M-B1d` (vuelve `Universo: los agentes`) →
  `not to contain 'Universo: los agentes'`. `M-B1e` (el caso vacío vuelve a afirmar
  siempre «se preguntó y no hubo») → `not to contain 'se preguntó y no hubo'`.
  `M-B1f` (se borra el aviso del cuerpo con tabla) → 2 tests.
- **Aplicar en**: toda pantalla que publique una lista derivada de una query con
  `limit`. Dos preguntas, y la segunda es la que faltó las dos veces: *¿qué input
  concreto pone esta frase en falso?* y *si la lectura toca su techo, ¿la pantalla
  puede decirlo, o trunca en silencio?* Un tablero que trunca en silencio miente
  igual que uno que rotula mal.

### [2026-08-25] Fix-pack 2 — B-2: la razón del TTL era otra frase falsa

- **Error**: al sacar el «alineado con `STATS_CACHE_TTL_MS`» escribí en su lugar
  *«porque ninguna de las tres fuentes de este tablero cambia en menos de un
  minuto»*. `a2a_events` gana una fila por cada request rastreada: dos llamadas en
  el mismo segundo cambian esa fuente en el mismo segundo.
- **Causa raíz**: la misma de B-1, en la misma línea que ya había corregido una
  vez. Al reemplazar una razón falsa se siente que hay que poner OTRA razón, y la
  razón nueva no pasa por ninguna medición porque el error que se estaba
  arreglando era el otro.
- **Fix**: **el número no lleva una razón sobre la volatilidad de las fuentes**. El
  docblock ahora dice que acá NO se afirma cada cuánto cambian, dice que
  `a2a_events` puede cambiar en el mismo segundo, y deja el 60 como lo que es: una
  tolerancia elegida. Lo único que afirma de otro archivo —«que el dato puede ser
  anterior al pedido se lo dice la pantalla al operador»— se verifica abriendo el
  `setEstado` del HTML.
- **Aplicar en**: cuando saques una frase falsa, la opción por defecto es **borrar
  o acotar**, no reemplazar. Una constante con un número puede no tener ninguna
  justificación escrita; lo que no puede tener es una falsa.

### [2026-08-25] Fix-pack 2 — B-3: 11 citas que rompí sin tocar el archivo donde viven

- **Error**: `dashboard.ts` pasó de 791 a 957 líneas, y las 11 citas
  `dashboard.ts:N` de `test/ownership-filter-guard.exceptions.ts` —que eran
  exactas en `f391325`— quedaron apuntando a código ajeno. `:515-517` era el
  handler de arbitrations y pasó a ser el cache del tablero.
- **Causa raíz**: los barridos miran lo que ESCRIBISTE, no lo que DESPLAZASTE. El
  AR de la iteración 1 verificó que el archivo de excepciones **no estuviera
  modificado**, que es otra pregunta: un archivo intacto con citas rotas pasa ese
  control con 10/10.
- **Fix**: los 11 números re-anclados **derivando** el mapa `vieja→nueva` de
  `/usr/bin/git diff -U1000000 f391325`, y cada destino verificado contra su
  **símbolo contenedor** (la ruta que la excepción nombra), no contra un parecido
  de texto — hay 6 líneas cuyo contenido es literalmente el mismo
  (`preHandler: requireAdminToken`), así que el texto no distingue.
- **La edición es LÍNEA-NEUTRA a propósito** (`--numstat` = `12 12`): los números
  viejos y los nuevos tienen la misma cantidad de dígitos, así que nada se
  reenvuelve y las citas que apuntan *hacia adentro* de `exceptions.ts` (`:24`,
  `:108-117`, `:359-374`, `:458-459`, repartidas en 5 documentos) siguen valiendo.
  Arreglar una cita desplazando otras es la corrección que empeora el repo.
- **Lo que NO se hizo, y hay que decirlo**: estas 11 citas **siguen sin tener
  guardián**. `test/cited-lines-guard` sólo cubre los 14 citadores de
  `CORTE_A_PATHS`, y `ownership-filter-guard.exceptions.ts` no está en esa lista.
  Meterlo es una HU, no un fix-pack: el registro exige `mustContain` y `symbolPath`
  leídos a mano para cada cita. Hasta entonces, el silencio sobre estos 11 números
  es real.

### [2026-08-25] Fix-pack 2 — MNR-1 y MNR-2

- **MNR-1**: `auto-blindaje.md` afirmaba que `not.toContain('<span></span>')` «no
  envejece». **Medido con una sonda propia** (corrida y borrada): con
  `tasksSettled: null` la tabla de la tarjeta 2 sale
  `<tr><td>remit-fx</td><td></td><td></td><td></td></tr>` y con
  `usdc_bloqueado: null` la tarjeta 3 sale `<div class="big"> USDC</div>` —las dos
  en `class="panel ok"`— y el assert **no ve ninguna de las dos**, porque ninguna
  pasa por `kv()`. Corregido a lo que el assert cubre de verdad: las celdas que
  emite `kv()`. Los dos casos son inconstruibles hoy por tipos; lo falso era la
  afirmación sobre el testigo.
- **MNR-2**: el mutante que el re-AR encontró vivo (quitar `|| valor === undefined`
  de `valorDeFila`) ahora **muere**: `not to contain '<span></span>'`. El testigo
  renderiza una `caja` sin las cuatro columnas, que es lo que llega al browser
  cuando `JSON.stringify` borra una clave `undefined` — todos los fixtures previos
  usaban `null`.

### [2026-08-25] Fix-pack 2 — el presupuesto, re-medido (el número de arriba envejeció)

- **Medido** con el mismo comando que el re-AR (`git diff --cached --numstat
  f391325 -- src/ .env.example README.md README.es.md`, con todo en el índice):
  **+3.630 / −6**, contra los **3.315** que este archivo declaraba antes de este
  fix-pack. Techo de 2x del SDD §10: **3.150** ⇒ **2,30x**, **480 líneas por
  encima**. El renglón anterior no estaba mal: **envejeció**, y no había nada que
  lo pusiera rojo al envejecer.
- **De dónde sale lo que agregó este fix-pack** (`--numstat` contra `42fcd31`,
  sólo los archivos que entran al presupuesto): **+332 / −17**, o sea las **+315**
  netas que explican la diferencia con los 3.315. De esas 332 agregadas, **216 son
  tests** (`tablero.test.ts` 119 + `render.test.ts` 97: los 6 mutantes de B-1 y el
  testigo de MNR-2 necesitan sus casos, y el falso de Supabase ahora aplica el
  `.not` y el `limit` como PostgREST) y **116 son producción**: 23 del contrato
  (los dos campos nuevos con su porqué), 48 del service (el filtro, el conteo sin
  `break` y el docblock con la medición contra bdwv), 36 del render
  (`avisoDeTope` y la rama vacía condicionada) y 9 del docblock del TTL.

  ⚠️ Estos números se re-midieron DESPUÉS de la última edición de prosa: la
  primera versión de este renglón decía `+325 / 109` y quedó vieja en el mismo
  commit, por siete líneas de comentario. Un número sobre el diff envejece con la
  edición siguiente, incluso con la de uno mismo.
- **Justificación**, y es la misma que la vez pasada agravada: es el **segundo**
  fix-pack de un AR rechazado. Recortar acá es recortar testigos de bloqueantes de
  *data integrity*. Lo único que se podría recortar es prosa, y la prosa es
  exactamente lo que los dos AR pidieron por escrito. **La lección sigue siendo
  para el próximo SDD**: un presupuesto que no reserva nada para el post-AR falla
  siempre en la misma dirección, y acá falló dos veces seguidas.
- **Fuera del presupuesto** (`test/`, que §10 no mide): las 12 líneas
  línea-neutras de `ownership-filter-guard.exceptions.ts`.
