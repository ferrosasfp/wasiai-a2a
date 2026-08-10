# Auto-Blindaje — WKH-345 (F3)

> Mis propios errores durante la implementación, no hallazgos sobre el código.
> Todo número de acá lo medí yo, con el commit al lado.

---

### [2026-08-10] Wave 0 — Copié a un docblock una afirmación del Story File que no medí, y era falsa

- **Error**: escribí en `src/lib/uuid.ts` que endurecer el regex a v4 dejaba a
  "la suite completa CIEGA", y en `src/lib/uuid.test.ts` que T-U2 era "el ÚNICO
  testigo de ese mutante en todo el repo". Las dos frases venían del Story File
  (§8, M-2) y las puse como si las hubiera verificado.
- **Cómo se cayó**: al correr M-2 de verdad (`062d6ff2…`, contra mi línea base
  `2d8168c`), el resultado fue **13 rojos**, de los cuales **11 están fuera de
  `uuid.test.ts`**. La premisa del Story File era "todos los ids del repo salen
  de `gen_random_uuid()`, que ya es v4" — cierto para los ids que genera la
  **base**, falso para los **fixtures escritos a mano**:
  `src/routes/tasks.test.ts:95` es `'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'`, que
  no tiene forma de v4. Bonus del mismo error: T-U4 también muere con M-2
  (`'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'` tampoco es v4), y eso tampoco estaba
  previsto.
- **Causa raíz**: traté una afirmación *falsable* de un documento de entrada como
  si fuera parte del contrato. El contrato del Story File son las decisiones
  (D-1..D-4) y las prohibiciones; sus **mediciones** son de otro commit y de otro
  autor, y P-14 lo dice explícitamente. Un docblock es código: cuando afirma un
  número, quien lo lee no tiene forma de saber que fue copiado.
- **Fix**: medí M-2 sobre la suite completa y reescribí las dos prosas con el
  número real, el commit, y la consecuencia que de verdad importa — que los 11
  rojos señalan "el fixture no es v4" y **no** "el contrato no debe pedir v4", así
  que la lectura natural del rojo es arreglar los fixtures y estrechar el
  contrato con la suite en verde. Ése sí es el valor de T-U2.
- **Aplicar en**: cualquier comentario que describa **qué hace un mutante**. Si
  la frase es falsable con un comando, o la corro, o no la escribo. Vale igual
  para "el resto de la suite no ve X": es una afirmación sobre 5400 tests y no se
  deduce leyendo uno.

---

### [2026-08-10] Wave 2 — Corrí sólo los archivos que toqué y canté "verde" con 2 rojos en el árbol

- **Error**: al cerrar W2 corrí `vitest run` sobre los 8 archivos de test del
  Scope IN, vi `PASS (90) FAIL (0)` y lo leí como "W2 verde". Commiteé
  (`2d8168c`) sobre esa lectura. El árbol tenía **2 tests rojos** que ese comando
  no podía ver: `src/services/arbiter.test.ts:991` y `:1010` inyectan
  `POST /payments/session/i1/dispute` y esperan 200 y 409; con el guard nuevo,
  `i1` no tiene forma de UUID → 422.
- **Cómo lo encontré**: por casualidad, y por el lado equivocado. Aparecieron en
  la lista de rojos de **M-2**, mezclados con los colaterales del mutante. Recién
  ahí corrí la suite completa sin mutar y confirmé que eran preexistentes a
  cualquier mutante. Si M-2 hubiera sido opcional y lo hubiera salteado, esto se
  iba a AR.
- **Causa raíz**: dos capas del mismo error. (a) Sustituí la suite completa por
  una corrida dirigida porque **supuse** que el radio de impacto de los guards
  era local a `src/routes/`. (b) Ese supuesto lo heredé del censo del Story File
  (§5), que enumera 20 fixtures en 5 archivos y **todos** están bajo
  `src/routes/`. Confié en el alcance de un documento en lugar de medir el radio
  yo: el archivo que **inyecta** en una ruta no tiene por qué vivir al lado de la
  ruta, y acá vive en `src/services/`.
- **Fix**: (1) suite completa como única fuente del veredicto de wave — la
  corrida dirigida sirve para iterar rápido, nunca para cerrar; (2) me escribí un
  censo propio que busca, en **`src/` y `test/` enteros**, todo string que apunte
  a una de las 9 superficies con guard y cuyo `:id` no tenga forma de UUID. Ese
  censo devuelve 10 sitios: 6 son mis tests negativos nuevos (a propósito) y 4
  son los de `arbiter.test.ts`.
- **Aplicar en**: toda HU que cambie **la respuesta de una ruta compartida**. El
  censo tiene que ser por *superficie HTTP* (la URL), no por *directorio*. Y si un
  documento de entrada trae una lista de sitios, la lista es una pista, no el
  perímetro: el perímetro se mide.

---

### [2026-08-10] Wave 2 — T-5, tal como está especificado, no puede matar al mutante que dice matar

- **Qué pasó**: §7 especifica T-5 como `DELETE /auth/key-session/<uuid-válido>`
  con un `SESSION_TOKEN`, esperando `403` + `lookupByHash` no llamado, y le
  asigna el mutante "mover el guard antes del gate de prefijo". Con un `:id` de
  forma **válida** ese mutante es invisible: el guard lo deja pasar y el gate de
  prefijo sigue devolviendo `403`. El test queda verde y el mutante sobrevive.
- **Por qué el Story File llegó ahí**: en `2745bb2` el testigo de ese orden era
  T-SUBSESSION (`auth.key-session.test.ts:161`), que usaba `sess-1`
  —**malformado**— y por eso sí moría. W1 refixtureó ese mismo `url:` a un UUID
  válido, y con eso apagó la propiedad que hacía a T-SUBSESSION un testigo. Los
  dos pasos son correctos por separado; juntos se anulan.
- **No lo resolví argumentando: lo medí.** Apliqué un cuarto mutante (M-4:
  mover el bloque del guard arriba del gate de prefijo en `DELETE
  /key-session/:id`; `sha256sum` `29770366…` → `7472834d…`). Resultado:
  **T-5 rojo** (`400` donde espera `403`), **T-SUBSESSION verde**.
- **Fix**: T-5 va con `:id` **malformado**, que es la única forma en que puede
  morir. T-SUBSESSION queda como está (con UUID válido): prueba lo
  complementario, que el guard nuevo no rompió el gate para ids bien formados.
  Los dos hacen falta y el comentario de T-5 dice por qué.
- **Desvío declarado**: es un apartamiento de la letra de §7. No cambia ninguna
  decisión (D-3 se refuerza, no se re-abre) ni sale del Scope IN. Queda acá y en
  el reporte para que AR lo juzgue.
- **Aplicar en**: cuando una wave de fixtures y una wave de tests toquen el mismo
  `url:`, preguntarse **qué propiedad del fixture viejo era la que medía**. Un
  refixture puede desarmar un testigo sin poner nada en rojo. Y el control es el
  de siempre: si un test dice qué mutante lo mata, aplicalo.
