# Auto-Blindaje — WKH-225 · Corte A

Cada error cometido durante F3, su causa raíz y dónde más puede volver a pasar.
No es una bitácora de progreso: sólo entra lo que se ROMPIÓ.

---

### [2026-08-23 16:40] Wave 0 — El bloque nuevo de `database.types.ts` rompió una cita de `CLAUDE.md`

- **Error**: agregué `a2a_suspended_runs` justo después de `a2a_agent_links`
  (simetría con el exemplar). `npm test` se puso rojo en `G-C5` y `G-C6` de
  `test/cited-lines-guard.test.ts`: `CLAUDE.md` cita
  `src/types/database.types.ts:2567` —el `owner_ref` de `registries`— y mis 95
  líneas la corrieron a `:2662`.
- **Causa raíz**: el Story File enumera las 5 anclas que viven en
  `src/types/index.ts`, `src/services/compose.ts` y `src/routes/compose.ts`, y yo
  leí esa lista como "las citas que puedo romper". Pero el universo del guardián
  son **14 archivos**, y `database.types.ts` es el *target* de una cita que sale
  de `CLAUDE.md`. **El archivo que edito no tiene que estar en `CORTE_A_PATHS`
  para que yo rompa una cita: alcanza con que alguien de esa lista lo apunte.**
- **Fix**: NO actualicé el número. Moví el bloque al FINAL de `Tables`, que es
  línea-neutro para todo lo de arriba, y dejé escrito en el propio archivo por
  qué está ahí y no donde la simetría lo pondría. Cero diff en `CLAUDE.md` —que
  además está fuera del Scope IN— y cero diff en `citations.ts`.
- **Aplicar en**: antes de insertar en CUALQUIER archivo, correr
  `/usr/bin/grep -n "<ruta>" test/cited-lines-guard.citations.ts` para ver si es
  *target* de alguien, no sólo si es *fuente*. Y cuando la elección exista,
  **insertar por debajo del ancla más baja** en vez de re-apuntar la cita:
  re-apuntar es correcto pero mete diff en archivos ajenos a la HU.

---

### [2026-08-23 16:45] Wave 0 — Una línea de PROSA le inventó una columna de dueño a otra tabla

- **Error**: al mover el bloque de tipos al final de `Tables`, dejé arriba un
  docblock que explicaba por qué, y esa explicación nombraba `owner_ref`.
  `npm test` se puso rojo en `G-11` de `test/ownership-filter-guard.test.ts`:
  `soloOraculo: ['webhooks']`. `webhooks` no tiene columna de dueño y nunca la
  tuvo.
- **Causa raíz**: los DOS lectores del archivo de tipos no leen igual. El
  escáner (`deriveTables`) exige `^ {10}owner_ref\??\s*:` — una línea de
  declaración real. El oráculo (`tableBlocks`) corta el archivo por cabeceras y
  después hace `/\bowner_ref\b/` sobre el CUERPO ENTERO del bloque. Todo lo que
  quede entre el `};` de una tabla y la cabecera de la siguiente se le atribuye
  a la **anterior**. Mi comentario cayó ahí.
- **Fix**: reescribí el comentario sin nombrar la columna ("la columna de dueño
  de `registries`"), y dejé escrito EN EL PROPIO COMENTARIO por qué no la
  nombra, para que el próximo no lo "arregle" agregándola.
- **Aplicar en**: cualquier comentario que se escriba dentro de
  `src/types/database.types.ts`, y en general en cualquier archivo que un
  guardián lea por bloques con un regex de cuerpo. **Un guardián que compara
  dos lectores con criterios distintos puede ponerse rojo por prosa**, no sólo
  por código. Antes de escribir un comentario ahí: preguntarse a qué bloque lo
  va a atribuir el lector más laxo.

---

### [2026-08-23 17:06] Wave 2 — Insertar en `reconciliation.ts` corrió SEIS excepciones del guardián de dueño

- **Error**: agregué `listSuspendedRuns` y sus tipos a
  `src/services/reconciliation.ts` y `npm test` se puso rojo en `G-08` con
  **6 cadenas "sin filtro y sin motivo escrito"** — las mismas seis de siempre,
  que sí tenían motivo: sus entradas en
  `test/ownership-filter-guard.exceptions.ts` apuntaban a los números viejos.
- **Causa raíz**: esa lista está escrita a mano y su `line` es la del `.from(`.
  Yo agregué líneas en CINCO puntos distintos del archivo, así que el
  desplazamiento **no es uniforme**: +59 para los sitios anteriores al método
  nuevo, +134 para los posteriores. Un "sumale N a todo" habría re-apuntado la
  mitad a la línea equivocada, y el guardián habría quedado verde apuntando a
  otra cadena.
- **Fix**: derivé los números nuevos del propio archivo
  (`grep -n "\.from('a2a_"`) y VERIFIQUÉ uno por uno que la función contenedora
  siguiera siendo la que la excepción nombra (`listPending`, `listAmbiguous`,
  `resolveIntent` ×2, `driftCheck`, el lease del hop 2). Además corrí los cuatro
  `:NNN-NNN` que las propias razones citan hacia docblocks de
  `reconciliation.ts`, y abrí las cuatro para confirmar que el texto sigue
  diciendo lo que la razón afirma.
- **Aplicar en**: cualquier HU que inserte en un archivo con excepciones
  escritas a mano. **Derivar, no sumar**, y cruzar por SÍMBOLO contenedor, no
  por aritmética. Y acordarse de que las razones también citan líneas: el
  guardián no las mira, así que envejecen en silencio.

---

### [2026-08-23 17:14] Wave 2 — Registrar una ruta nueva tumbó TRES suites enteras al arrancar

- **Error**: `POST /compose/resume` usa `requireA2AKey` del middleware de auth.
  Tres suites que ya existían moquean ese módulo con una factory **parcial**
  (sin `importOriginal`) que sólo exporta `extractRawKey` y
  `requirePaymentOrA2AKey`. El resultado no fue un test rojo: fue
  `Failed Suites 3` — el plugin no registra, así que se cayeron los **46 tests**
  de esos archivos, y el resumen los contó como `skipped`.
- **Causa raíz**: un doble parcial de un módulo es un contrato implícito con la
  lista EXACTA de símbolos que el consumidor importa hoy. Agregar un símbolo al
  consumidor rompe el doble desde afuera, en tiempo de registro, no de aserción.
  Y el modo de falla es engañoso: `Tests 6000 passed | 46 skipped` se lee como
  verde si uno mira sólo la línea de tests.
- **Fix**: agregar a las tres factories el `requireA2AKey` que faltaba, con el
  MISMO pass-through que ya tenían para `requirePaymentOrA2AKey`. No se aflojó
  ninguna aserción ni se tocó ningún test: se completó el doble.
  ⚠️ Son tres archivos **fuera del Scope IN del Story File**, y va al reporte
  como ampliación declarada, no aplicada en silencio.
- **Aplicar en**: toda HU que le agregue un `import` a un archivo que ya tiene
  dobles parciales. **Antes de importar un símbolo nuevo en un route/service muy
  moqueado**: `grep -rn "vi.mock('.*<modulo>'" src/` y mirar cuáles usan
  `importOriginal` y cuáles no. Y al leer la salida de `npm test`, mirar
  **`Test Files`**, no sólo `Tests`: una suite que no arranca no falla, desaparece.

---

### [2026-08-23 17:20] Cierre — lo que NO se rompió pero conviene que quede escrito

Tres decisiones que se tomaron por MEDICIÓN y no por preferencia, y que un
lector futuro podría "corregir" hacia atrás:

1. **El `exp` del token NO corta el camino a la base.** Un token vencido igual
   llega a `claim_suspended_run`. Cortar antes ahorraría una consulta y
   perdería el ÚNICO momento en que la fila puede pasar a `expired` y dejar
   constancia del pago varado. Testigo: `T-RES-4b`.
2. **`requireA2AKey` y no `requirePaymentOrA2AKey` en el resume.** Medido en
   `src/lib/step0-debit.ts`: sin `composeEstimatedCostUsd` inyectado, el monto
   cae a `PLACEHOLDER_FEE_USD`. La cadena "igual que /compose menos el
   preHandler de precio" le habría cobrado **un dólar a cada reanudación**.
3. **La bandera NO gatea `POST /compose/resume`.** Apagarla tiene que dejar de
   CREAR runs suspendidos, no dejar varados a los que ya gastaron plata del
   caller.
