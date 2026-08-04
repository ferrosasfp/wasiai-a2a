# Auto-blindaje — WKH-318 corte B (F3 / Dev)

Rama `feat/218-wkh-318-corte-b-maxlimit-clamp`. Errores cometidos durante la
implementación y lo que los corta la próxima vez.

---

### [2026-08-04] W1 — El lint verde caducó en la edición siguiente

- **Error**: corrí `npm run lint` verde al cerrar W0, edité
  `src/services/discovery.ts` en W1, y el `if` multilínea del segundo `warn` que
  escribí a mano no era el formato de biome. El lint salió rojo **después** de
  que ya daba por buena la wave.
- **Causa raíz**: tratar "lint verde" como un estado del repo cuando es una
  medición de un instante. Cualquier edición posterior lo invalida.
- **Fix**: correr `npm run lint` **inmediatamente antes** del `git commit` de cada
  wave, no al principio ni al medio. En W3 volvió a pasar exactamente igual (dos
  `mockResolvedValue` de una línea que biome quería partir en tres), lo que
  confirma que no fue casualidad: es reincidencia, ya anotada en `main` con el
  commit `34e1f2b`.
- **Aplicar en**: toda wave. El orden es `editar → tsc → test → lint → commit`, y
  si el lint toca un archivo hay que **volver a correr el test de ese archivo**
  antes de commitear (lo hice: `discovery.truncation.test.ts` siguió 11/11).

---

### [2026-08-04] Mutantes — Un mutante mal construido acusa a un test que está bien

- **Error**: mi primera versión de **M5** ("mover el clamp fuera del gate") sólo
  sacaba `query.limit` de la condición. Con eso, T-CLAMP-02c (registry **sin**
  `limitParam`) **seguía verde**, y por un momento lo leí como "el test no sirve".
- **Causa raíz**: sin `schema.limitParam` no hay nombre de parámetro que escribir,
  así que `url.searchParams.set(undefined, ...)` no produce ningún `?limit=` y el
  helper del test seguía leyendo `null`. O sea: el mutante **no cambiaba la
  conducta observable** de esa rama. Un mutante que no cambia conducta no prueba
  nada sobre el test — no es que el test sea débil, es que la mutación no llegó.
- **Fix**: la mutación final agrega el fallback `?? 'limit'` además de sacar
  `query.limit`. Recién ahí T-CLAMP-02c muere.
- **Aplicar en**: toda campaña de mutación. Antes de escribir "sobrevive",
  verificar que el mutante **efectivamente cambia la salida observable** del caso
  que el test mide. Si no la cambia, el hallazgo es sobre la mutación, no sobre el
  test. Corolario operativo: el script de mutación debe fallar si el patrón no
  aparece **exactamente una vez** (`mut318b.py` lo hace), porque una mutación
  aplicada a medias produce el mismo falso "sobrevive".

---

### [2026-08-04] W0 — `unknown` obliga a un cast que no estaba en el contrato

- **Error**: el story file fija `isUsableRegistryMaxLimit(declared: unknown):
  boolean` y `clampToRegistryMaxLimit` con `Math.min(fetchLimit, declared)`. Eso
  **no compila**: un `boolean` no propaga narrowing, así que `declared` sigue
  siendo `unknown` en la línea siguiente.
- **Causa raíz**: la firma pedida (`: boolean`) y el cuerpo pedido (`Math.min`
  directo) son incompatibles bajo `strict`. Un type predicate
  (`declared is number`) los reconciliaría, pero cambiaría la firma que el
  contrato fija.
- **Fix**: respeté la firma del story file y puse `declared as number` con un
  comentario **pegado** que dice qué línea lo cubre. No inventé una firma nueva.
- **Aplicar en**: cuando un contrato pide una firma que fuerza un cast, el cast va
  con el puntero al guard que lo justifica, en la línea de al lado. Un `as` sin
  esa vecindad es exactamente lo que un revisor futuro borra o replica mal.
  Alternativa a evaluar en CR: convertir el guard en type predicate y sacar el
  cast (es estrictamente mejor, pero es cambio de contrato, no decisión del Dev).

---

### [2026-08-04] Fix-pack — Corrí la campaña que me pidieron, no la que cubría mi cambio

- **Error**: cerré la campaña con **"10/10 muertos"** y ninguno de los 10 mutantes
  tocaba el guard de W1.3 (`discovery.ts:1106`). Sus **dos** mitades sobrevivían a
  la suite COMPLETA — lo encontraron el AR (`BLQ-BAJO-2`, 5014 tests en verde) y
  el CR (`M-1`, 4996) por separado, el mismo día. Y la mitad `sentLimit <
  unclamped` **sí cambia la conducta observable**, que es exactamente la vara que
  yo mismo había fijado en la nota de M5 de este mismo fix.
- **Causa raíz**: tomé la lista de mutantes del story file como si fuera la
  definición de cobertura. El story file enumera los mutantes que el Architect
  imaginó **antes** de que el código existiera; la línea que más argumenté en el
  diff (tres lugares de prosa defendiéndola, con su input falsificador) nació
  después y por eso no estaba en la lista. El número "10/10" leía como cobertura
  completa del cambio y era cobertura completa de **una lista**.
- **Fix**: MA1 y MA2 agregados al `mutation-log.md`, con las dos aserciones
  negativas que los matan (T-CLAMP-02 4º sub-caso y T-CLAMP-01). Reproduje primero
  que sobrevivían (56/56 en verde con cada mutante aplicado) y recién después
  escribí los tests. Y el título del log ahora dice de dónde salen los 12.
- **Aplicar en**: toda campaña de mutación. La lista del contrato es el **piso**,
  no el techo. Antes de escribir "N/N muertos", recorrer el `git diff` línea por
  línea y preguntar por cada condición nueva: *¿qué mutación la borra y qué test
  se pone rojo?* Señal de alarma específica: **una condición que necesitó un
  párrafo de prosa para defenderse casi nunca tiene test** — la prosa se escribió
  justo porque no había nada mecánico que la sostuviera.

---

### [2026-08-04] Fix-pack — Un nombre que afirma la causa invita a borrar el guard

- **Error**: llamé al helper `clampFallsBelowComposePoolFloor(sent)` cuando su
  cuerpo es `sent < 50`. Recibe **un** número: no puede saber si hubo clamp.
- **Causa raíz**: nombré la función por el **caso de uso del único call-site**, no
  por lo que la función decide. Con ese nombre, el `sentLimit < unclamped &&` de
  al lado se lee como redundante — y era justo la mitad sin test (mutante MA1).
  Las dos cosas juntas son la receta para que el próximo lector la borre con la
  suite aplaudiendo.
- **Fix**: renombrado a `isBelowComposePoolFloor`. Es una desviación deliberada
  del nombre que fija el story file en W0.3, pedida por el CR (M-2) y anotada acá
  para que no se lea como drift.
- **Aplicar en**: nombrar por lo que la firma puede decidir. Si el nombre contiene
  una causa (`clampFalls…`, `userDeleted…`, `retryFailed…`) que no está en los
  parámetros, es una afirmación que la función no puede sostener.

---

### [2026-08-04] W2 — El marcador de línea 2 parte la frase del título

- **Error**: en el primer intento escribí el título de la migración repartido
  entre la línea 1 y las líneas 3-4, con el marcador obligatorio en el medio. El
  archivo leía *"declarar el techo de limit que acepta el registro / NO aplicar:
  ... / `wasiai`, para que..."*. Cumplía la letra (marcador en línea 2) y rompía
  la prosa. El `_down.sql` salió con el mismo defecto.
- **Causa raíz**: tratar "línea 2 = marcador" como una inserción en un texto ya
  escrito, en vez de como una restricción sobre cómo se escribe la línea 1.
- **Fix**: la línea 1 tiene que ser un título **autocontenido** que termine en
  punto. El resto del comentario arranca en la línea 3.
- **Aplicar en**: cualquier convención de "línea N fija". El marcador se pone
  primero y el texto se escribe alrededor, no al revés.

---

### [2026-08-04] Harness — Dos trampas que el story file ya traía resueltas

No son errores míos: las evité porque el story file las traía medidas. Se anotan
para que la próxima HU que toque estos archivos no las redescubra.

- `serveByHost` (`discovery.sources.test.ts`) rutea por **hostname** y su función
  de ruta **no recibe la URL**, así que no puede decidir según el `?limit=`. Un
  mimic de techo necesita un helper local sobre
  `mockFetch.mockImplementation((url) => ...)`. `serveByHost` **no se toca**: lo
  usan T-SRC-01..13.
- El body de un `400` **nunca se lee**: `discovery.ts:1115-1117` lanza
  `RegistryHttpError` antes del `await response.json()` de `:1119`. Un mimic puede
  devolver `{ ok: false, status: 400 }` pelado, y **no** se puede afirmar nada
  sobre el mensaje de error del registry porque no llega a `sources[]`.
- El mock de logger inline (`getLogger: () => ({ warn: vi.fn() })`) crea un objeto
  **nuevo por llamada**, así que el `vi.fn()` que el módulo capturó al importar es
  inalcanzable desde el test. Cualquier aserción sobre logs necesita el patrón
  `vi.hoisted` (exemplar `compose.test.ts:17-23`).

---

### [2026-08-04] Lo que esta HU NO hace — para que el próximo no lo lea de más

`/discover?limit=50` sigue devolviendo 3 de 23 agentes con este código
desplegado, porque ninguna fila de `registries` declara `maxLimit` todavía y el
clamp es estrictamente aditivo: sin declaración, el `limitParam` que sale por la
red es byte-idéntico al de antes. **El clamp existe y funciona; se activa cuando
la fila de `registries` declare su techo**, y esa migración la aplica el founder.
