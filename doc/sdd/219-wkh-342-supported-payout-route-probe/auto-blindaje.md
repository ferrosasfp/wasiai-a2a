# Auto-Blindaje — WKH-342

Errores propios cometidos durante F3, con el fix y dónde más aplica.

---

### [2026-08-09] Wave 0 (repo A) — `**/*.test.ts` dentro de un docblock CIERRA el comentario

- **Error**: escribí `` porque `tsconfig.json` excluye `**/*.test.ts`. `` dentro de un
  bloque `/** … */` en `src/core/supported.ts`. `tsc` tiró 40+ errores de sintaxis
  arrancando en `supported.ts(190,66)` — `TS1109 Expression expected` seguido de
  `TS1443 Module declaration names…` y `TS1160 Unterminated template literal`.
- **Causa raíz**: el glob `**/` contiene la secuencia `*/`, que es el terminador del
  bloque de comentario. El comentario se cerró en medio de la frase y el resto del
  archivo se lexeó como código. Ni los backticks ni estar dentro de un `/** */`
  protegen: el lexer busca `*/` antes que cualquier otra cosa.
- **Fix**: reescribir la frase sin el glob — "el `exclude` de `tsconfig.json` deja afuera
  todo archivo `.test.ts`" (`wasiai-facilitator/src/core/supported.ts:189-190`).
- **Aplicar en**: cualquier docblock que quiera citar un glob de `tsconfig`/`vitest.config`
  (`**/*.test.ts`, `src/**/*`, `dist/**`). Los `//` de una sola línea NO tienen el
  problema. Síntoma que lo delata: el PRIMER error de `tsc` cae en una línea de
  comentario y los siguientes en código preexistente que no tocaste — leer sólo el
  `tail` de la salida manda a depurar el archivo equivocado (me pasó: los primeros 5
  errores que vi eran de líneas 226-260, todas preexistentes).

---

### [2026-08-09] Wave 2 (repo A) — T-A3 medía el candado en el único contexto donde el mutante NO se ve

- **Error**: escribí T-A3 ("el cambio es ADITIVO: `methods` no gana ningún string de
  payout") usando el helper `buildAppWithAdapters`. Apliqué el mutante que el Story File
  describe —volcar `dedicatedRoutes` dentro de la unión `methods` en
  `core/supported.ts`— y la suite dio **`28 passed`, T-A3 VERDE**.
- **Causa raíz**: con ese helper **ninguna de las tres rutas dedicadas está registrada**,
  así que `dedicatedRoutes` sale `[]` y volcar `[]` en una unión no cambia nada. El
  fixture del caso POSITIVO no tenía nada que se pudiera filtrar. Es exactamente
  `el-test-del-camino-feliz-ejercitaba-el-agujero`: el test afirmaba sobre un mecanismo
  que su propio input desactivaba.
- **Fix**: T-A3 ahora construye la app con el **gate de payout ON** (`buildRealEnvApp` +
  `wkh342EnablePayout`) y agrega el control positivo
  `expect(body.dedicatedRoutes).toEqual(['POST /solana/payout'])` — si esa línea cae, el
  punto 3 dejó de medir algo. Re-medido con el mismo mutante: **T-A3 rojo, y sólo T-A3**
  (`1 failed | 27 passed`).
- **Aplicar en**: todo test que afirme "X NO se filtró a Y". Antes de darlo por bueno,
  verificar que en ese fixture **X existe y es no vacío**. Un candado sobre un conjunto
  vacío aplaude cualquier implementación. Control barato y obligatorio: una aserción que
  falle si el input del caso positivo quedó vacío.

---

### [2026-08-09] Wave 5 (repo B) — un `Response` se lee UNA vez, y el sondeo agrega un segundo `fetch`

- **Error**: escribí T-B8c con `fetchSpy.mockResolvedValue(jsonResponse(200, {…}))` y
  falló con `FacilitatorSettleError: Facilitator returned HTTP 200 on /solana/payout (no
  JSON body)`.
- **Causa raíz**: `mockResolvedValue` evalúa el argumento UNA vez y devuelve **el mismo
  objeto `Response`** en cada llamada. El cuerpo de un `Response` es un stream de un solo
  uso: el sondeo (`GET /supported`) lo consume y el POST recibe un cuerpo vacío. No es un
  bug del código: en producción cada request trae su propio `Response`.
- **Fix**: `fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(…)))` en todo
  caso donde haya más de un `fetch`.
- **Aplicar en**: cualquier HU que agregue un request HTTP a un camino que ya tenía uno.
  El síntoma es un error de "cuerpo ilegible" en el SEGUNDO request, que se lee como si
  el código estuviera mal parseando. Y ojo con el primo del bug: los dobles que hacen
  `fetchSpy.mock.calls[0]` para leer el POST pasan a leer el sondeo.

---

### [2026-08-09] Ronda AR — declaré "deuda heredada" sin medir la BASE

- **Error**: encontré que `payment.flag.test.ts` quedaba acoplado por orden, y lo declaré
  como hallazgo para el AR en vez de arreglarlo, argumentando que tocar una suite no-touch
  del money-path era decisión del Architect.
- **Causa raíz**: **nunca medí el estado de la base.** Asumí que la fragilidad preexistía y
  que WKH-342 sólo la exponía. El AR midió `568cf40` y era **order-independent**: el
  acoplamiento lo introdujo mi commit. Con esa premisa, "no es mi decisión" se cae — una
  regresión propia se arregla, no se declara.
- **Fix**: `_resetPayoutRoutePreflight()` en el `beforeEach` + `mockImplementation` en los 6
  sitios + `postCalls()` por verbo en lugar de `mock.calls[0]`. Los 18 tests del archivo
  pasan aislados.
- **Aplicar en**: cualquier vez que vaya a escribir "esto ya estaba así" / "deuda heredada"
  / "fuera de mi alcance". Es una afirmación sobre el PASADO y se mide con un comando en la
  base (`git show <base>:<archivo>` o correr la suite en un worktree de la base). Sin esa
  medición, "ya estaba roto" y "lo rompí yo" se leen idénticos — y el segundo caso es el
  único que importa. Es el mismo error que la lección
  `medir-la-precondicion-antes-de-afirmar`, aplicado al eje temporal.

---

### [2026-08-09] Ronda AR — la disciplina correcta aplicada UN NIVEL menos de lo necesario

- **Error**: en `probePayoutRoute` apliqué "forma que no entiendo ⟹ `unaskable`" al CUERPO
  (¿es objeto?) y al CAMPO (¿es array?), y **no a los ELEMENTOS**. Con
  `{"dedicatedRoutes":[{"id":"POST /solana/payout"}]}` el veredicto era `route_absent` y el
  leg moría `'not-sent'` **sin un solo POST**, con la ruta servida del otro lado.
- **Causa raíz**: validé la forma del contenedor y usé el contenido directamente
  (`includes`). `includes` sobre elementos de otro tipo devuelve `false` en silencio, y ese
  `false` era indistinguible del `false` legítimo que significa "el facilitator no la tiene"
  — o sea, el mismo defecto que esta HU vino a arreglar, un nivel más adentro.
- **Fix**: `routes.every(r => typeof r === 'string')` como **precondición del desenlace que
  corta**; si falla, `body_unreadable`. Más comparación normalizada, porque un casing
  distinto tampoco es evidencia de ausencia.
- **Aplicar en**: todo parseo defensivo de una respuesta ajena que alimente una decisión
  fail-closed. La regla operativa: **la validación de forma tiene que bajar hasta el valor
  que la decisión LEE**, no hasta el contenedor. Y el test que lo fija se escribe con el
  elemento del tipo equivocado, no sólo con el campo ausente.

---

### [2026-08-09] Ronda AR — mi HARNESS de medición fabricó 8 fallos que no existían

- **Error**: para verificar que los 18 tests pasaban aislados, corrí
  `vitest run <archivo> -t "<nombre completo>"` en un loop y reporté **8 "NO-AISLABLE"**.
  Ninguno era real.
- **Causa raíz**: `-t` es una **regex**, y los nombres de estos tests traen `(`, `)`, `§`,
  backticks y `⟹`. Con paréntesis sin escapar el patrón no matchea nada, vitest corre **0
  tests**, y mi condición (`grep -c "1 passed"`) daba 0 → lo clasifiqué como fallo. Los 6
  que sí verifiqué antes pasaron sólo porque usé subcadenas sin metacaracteres.
- **Fix**: escapar el nombre antes de pasarlo (`sed -e 's/[][(){}.*+?^$|\\]/\\&/g'`) y
  además distinguir los tres resultados posibles —`1 passed` / `1 failed` / **`0 tests`**—
  en vez de tratar "no pasó" como "falló".
- **Aplicar en**: cualquier loop de verificación con `-t`, `--grep`, `--filter` o
  `--testNamePattern`. Y el control general, que es el mismo de
  `no-pude-preguntar-no-es-no`: **"el test no reportó éxito" tiene TRES valores**, y el
  tercero ("no corrió") se lee igual que el segundo si el harness sólo pregunta por el
  primero. Un loop de medición necesita su propio control positivo: si ningún caso puede
  dar `0 tests`, no sé si estoy midiendo.

---

### [2026-08-09] Ronda CR — "no quedó residuo" sin buscarle el mutante

- **Error**: cerré BLQ-BAJO-2 escribiendo **"No quedó residuo: la derivación fue posible sin
  refactor"**. Era falso. Había hecho que `T-O6` derivara el eje de las **claves** y me
  detuve ahí; el `items` del array (`type` + `enum`) seguía escrito a mano en el yaml, así
  que el spec podía divergir del código un nivel más abajo. Dos mutantes de una línea lo
  dejaban en **14 passed** con `tsc` en 0 y `ajv` rechazando el cuerpo real.
- **Causa raíz**: apliqué la regla del reporte ("nombrá el mutante que refutaría la frase")
  **sólo a las frases sobre el defecto original**, no a la frase sobre **mi propio
  arreglo**. Nunca me pregunté "¿qué cambio de una línea vuelve a divergir el spec?" — si me
  lo hubiera preguntado, la respuesta (`items.type`, `enum`) aparecía en diez segundos.
  Y es la MISMA forma que el defecto que yo mismo había documentado en esta HU: disciplina
  correcta aplicada un nivel menos de lo necesario.
- **Fix**: invertir tipo↔valor. `DEDICATED_ROUTE_IDS` es una tupla `as const` y
  `DedicatedRouteId = (typeof …)[number]`; la tabla de sondeos pasó a
  `Record<DedicatedRouteId, …>` (exhaustivo); `T-O6` compara el `enum` contra la tupla y
  deriva `items.type` del `typeof` real.
- **Aplicar en**: toda frase de cierre que yo escriba, **incluidas las que describen mis
  propios fixes**. El control no es opcional y es barato: antes de escribir "cerrado" /
  "eliminado" / "no quedó residuo", **escribir el mutante de una línea que la refutaría**. Si
  aparece uno, la frase se reescribe con el alcance real. Corolario específico: cuando un
  guard compara dos estructuras, **preguntar hasta qué PROFUNDIDAD compara** — claves, tipos,
  valores, `items` de un array, `enum`. "Deriva del tipo" sin decir de qué nivel es una
  media verdad.

---

### [2026-08-09] Ronda CR — un `assert` que falló en silencio me hizo leer "mutante sobrevive"

- **Error**: al reproducir el mutante `items.type: string → integer` usé un script con
  `assert s.count(old)==1`. El patrón `items:\n type: string` aparece **dos** veces en
  `SupportedResponse` (también bajo `methods`), el assert tiró, **el archivo no se modificó**,
  y el `vitest` que corrió después dio `14 passed` — que leí como "el mutante sobrevive"
  cuando en realidad **no había mutante**.
- **Causa raíz**: encadené `python3 ... ; vitest ...` con `;`, así que el fallo del primero no
  frenó al segundo. El resultado del test era del árbol LIMPIO. Lo cacé sólo porque el
  traceback quedó visible en la misma salida.
- **Fix**: patrón único (incluyendo las líneas de `enum:`), y **verificar que el mutante está
  aplicado** antes de creerle al test. Ahora uso la herramienta de edición (que falla ruidoso
  si el string no es único) o `sha256sum` para confirmar que el archivo CAMBIÓ.
- **Aplicar en**: todo ciclo mutá-medí-revertí. **Un mutante no aplicado y un mutante que
  sobrevive producen la MISMA salida verde**, y la conclusión es opuesta. El control es
  encadenar con `&&` y/o exigir que el `sha256sum` del archivo **difiera** del baseline antes
  de correr la suite. Es el mismo modo de falla que
  `herramienta-de-medicion-fabrico-un-bug`, y la segunda vez que me pasa en esta HU
  (la primera fue el `-t` sin escapar).
