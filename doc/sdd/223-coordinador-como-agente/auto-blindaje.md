# Auto-Blindaje — WKH-360 / `223-coordinador-como-agente` (F3)

> Cada error MÍO de esta sesión, con causa raíz y dónde más puede volver. No es un
> changelog: es el archivo que protege a la próxima HU del mismo error.
>
> Base: `3823580`. Rama: `feat/223-wkh-360-coordinador-agente`.

---

### [2026-08-17 15:26] Wave 0 — El techo `>=` hizo que mi test midiera el paso 6 en vez del paso 4

- **Error**: `T-U-DEPTH-2` afirmaba cubrir "el rango completo del regex" con
  `read(undefined, '999', ['gw.example.com'], 999)` y esperaba `ok: true`. Dio
  `ok: false`.
- **Causa raíz**: pasé el MISMO número como valor y como techo. El corte del paso 6
  es `depth >= depthMax`, así que `999 >= 999` rechaza. El `it` decía estar midiendo
  el PARSEO (paso 4) y en realidad estaba midiendo el TECHO (paso 6). Si lo hubiera
  "arreglado" cambiando el `expect` a `false`, habría quedado un test verde que
  dice cubrir el parseo de 3 dígitos y no lo cubre — un testigo apagado.
- **Fix**: `depthMax = 1000`, con el motivo escrito en el propio test (dos líneas de
  comentario explicando por qué no puede ser 999).
- **Aplicar en**: todo test de un guard con comparación NO estricta. Si el valor de
  entrada y el umbral son el mismo número, el test no puede distinguir qué cláusula
  lo rechazó. Vale para `MUT-10` (`>` vs `>=`): si el input de `T-DEPTH-1` fuese
  `depth == depthMax + 1` en vez de `== depthMax`, `MUT-10` **sobreviviría** y el
  mutante quedaría mintiendo.

---

### [2026-08-17 15:26] Wave 0 — Confundí el camino de la ENV con el del HEADER en la lectura de la profundidad

- **Error**: `T-U-MAX-3` metió `' 2'` en la lista de valores que
  `isContractingDepthMaxMisconfigured()` tiene que marcar `true`. Dio `false`.
- **Causa raíz**: apliqué CD-14 ("ni `parseInt` ni `Number`") a los DOS caminos como
  si fueran uno. No lo son, y la diferencia es **quién controla el valor**:
  - la **profundidad del HEADER** la controla un **tercero**, y ahí `' 2'` leído
    como `2` es el ataque (`parseInt(' 2',10) === 2`, medido). Se RECHAZA;
  - el **techo de la ENV** lo escribe el **operador** en un panel de Railway, y ahí
    `' 2'` es un espacio de más. Se trimea y se lee 2; cualquier cosa que no sean
    dígitos cae igual al default del código.
- **Fix**: saqué `' 2'` de esa lista y escribí un `it` NUEVO (`T-U-MAX-7`) que
  asserta la **asimetría** con el mismo string en los dos caminos, más el párrafo
  "ASIMETRÍA DELIBERADA … NO se unifican" en el docblock de
  `resolveContractingDepthMax`. Sin ese texto, el próximo que lea CD-14 "unifica
  por consistencia" y rompe uno de los dos.
- **Aplicar en**: cualquier regla de parseo estricto. Antes de aplicarla, preguntar
  **quién escribe ese valor**. Una regla anti-adversario aplicada a config de
  operador genera fricción sin cerrar nada; la inversa (leniencia de operador
  aplicada a input de tercero) es el agujero.

---

### [2026-08-17 15:29] Wave 0 — Agregué 2 env vars y dejé en falso un número publicado en los DOS README

- **Error**: la suite completa pasó de verde a `2 failed`:
  `test/readme-numbers.test.ts` → `expected 181 to be 183`, en `README.md` y en
  `README.es.md`.
- **Causa raíz**: `.env.example` tiene un número publicado en prosa
  (*"documents **181 variables**"*) y hay un guardián que lo **re-deriva** en cada
  `npm test` con `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example`. Agregar
  `A2A_SELF_HOSTS` y `A2A_CONTRACTING_DEPTH_MAX` movió la cuenta a 183. No lo
  previne porque leí el Scope IN (`.env.example`) sin preguntarme **quién más
  afirma algo sobre ese archivo**.
- **Fix**: 181 → 183 en los dos README, con la cuenta **derivada**
  (`/usr/bin/grep -cE '^[A-Z][A-Z0-9_]*=' .env.example` → `183`), no incrementada a
  mano. Son 2 archivos que el Scope IN de §14 no lista: entran por **CD-21**
  ("reescribir, en el mismo commit, las prosas que esta HU vuelve falsas"), y la
  edición es de UN número por archivo, línea-neutra.
- **Aplicar en**: **este guardián funcionó y por eso el error costó 3 minutos.** La
  lección no es "acordate del README": es que tocar un archivo con un conteo
  publicado obliga a buscar al productor de ese conteo ANTES de editar
  (`/usr/bin/grep -rln "\.env\.example" test/`). Los candidatos vivos en este repo
  son `ENV_VARS`, `TEST_FILES` y `LINTED_FILES` de `test/readme-numbers.test.ts`:
  **agregar un archivo `.test.ts` o un archivo lintables tiene el mismo efecto** —
  y esta HU agrega al menos tres archivos nuevos, así que va a volver a morder en
  W2 y en W3.

---

### [2026-08-17 15:32] Wave 0 — Mi propia aritmética de desplazamiento (CD-11) ubicó mal una cita

- **Error**: al derivar el mapa de citas desplazadas de `src/types/index.ts` le
  asigné a `AgentCard` un delta de **+65** (⇒ `:1744`). El real es **+94**
  (⇒ `:1773`).
- **Causa raíz**: los deltas son **acumulados por posición**, y yo reusé el delta
  del tramo anterior. La inserción de `AgentSkill` (`@@ -1676,0 +1742,29 @@`, +29
  líneas) está **ARRIBA** de `AgentCard` (old `:1679`), así que le suma. El número
  +65 lo había verificado con un `grep` corrido **antes** de esa inserción, o sea
  que era cierto cuando lo medí y dejó de serlo por mi propia edición posterior —
  exactamente la clase "las citas que rompés vos al arreglar otra cosa".
- **Fix**: verificar **por CONTENIDO** y no por aritmética. El control que lo cazó
  compara `HOY[n]` contra `BASE[n − delta]` línea por línea; los dos "DRIFT" que
  reportó eran mi tabla, no el archivo. Mapa corregido y re-verificado:
  `374→374`, `989→989`, `1027→1027`, `1091→1128-1133` (1 línea pasó a 6),
  `1144→1186`, `1398→1463`, `1673→1738`, `1679→**1773**`, fin `2107→2220`.
- **Aplicar en**: W1/W2/W4, que tocan `src/services/compose.ts` (1571),
  `src/routes/compose.ts` (1132) y `src/services/orchestrate.ts` (1540) en
  **varios puntos de inserción por archivo**. Con más de una inserción, el delta de
  una cita **no** es el delta de la última hunk: hay que sumar todas las hunks que
  estén por encima. Y una verificación hecha entre dos ediciones de la misma wave
  **caduca**: se re-corre después de la ÚLTIMA edición.

---
