# Auto-Blindaje — WKH-371 (F3)

Cada entrada es un error que cometí durante la implementación y corregí. No es un registro de
incidencias: es lo que protege a la próxima HU del mismo error.

---

### [2026-08-28 09:05] W0 — El comando del typecheck de DT-12 no corre en este árbol

- **Error**: el Story File declara que el typecheck de `test/` sale «exit 0» con
  `npx tsc --noEmit --strict … test/cited-lines-guard.*.ts`. Corriéndolo, **exit 1**.
- **Causa raíz**: la versión instalada es **TypeScript 6.0.3**, que convirtió en ERROR el caso «lista
  de archivos en la línea de comandos con un `tsconfig.json` presente» (`TS5112`). Con
  `--ignoreConfig` se pierden `types`/`typeRoots` y aparecen 4 × `TS2591` («Cannot find name
  `node:fs`»). **Y el origen probable del «exit 0» del Story File está medido**: bajo `rtk`, `tsc`
  imprime `TypeScript compilation completed` y el exit code queda tapado. Es el patrón «afirmaciones
  de instrumento se propagan sin verificarse».
- **Fix**: un `tsconfig` desechable en el scratchpad que clona los `compilerOptions` del repo, agrega
  `noEmit` + `typeRoots`/`types` absolutos, e incluye sólo los 5 archivos del guardián. ⛔ Sin tocar
  `tsconfig.json`, que está prohibido. Exit 0 en todas las waves.
- **Aplicar en**: cualquier comando de una sola línea heredado de un documento. **El exit code se
  lee, no se supone** — y bajo `rtk` hay que usar `rtk proxy` o `${PIPESTATUS[0]}` para verlo.

---

### [2026-08-28 10:40] W2 — Mi resolvedor daba AMBIGUO sobre un path que no tiene nada de ambiguo

- **Error**: `mentionCandidates` resolvía `src/index.ts` a **dos** candidatos, así que un párrafo que
  nombra `src/index.ts` con todas las letras salía `INDECIDIBLE`. Tres citas reales perdidas.
- **Causa raíz**: heredé de `citeMatchesTarget` la regla del sufijo alineado por segmento
  (`f.endsWith('/' + raw)`), que existe para que `lib/payment-spec-reader.ts` matchee
  `src/lib/payment-spec-reader.ts`. Pero `packages/agent-sdk/src/index.ts` **también** termina en
  `/src/index.ts`. La regla es correcta para VERIFICAR un target ya decidido por un humano, y
  equivocada para RESOLVER uno que nadie decidió.
- **Fix**: el path exacto gana — `if (tracked.has(raw)) return [raw];` antes del filtro de sufijo.
- **🔴 Y lo que el fix reveló, que vale más que el fix**: arreglarlo **bajó** el recall contra el
  oráculo. El defecto estaba *compensando* una limitación de D6: había entradas que resolvían bien
  porque el segundo archivo del párrafo se tragaba en silencio. **Estaban bien por la razón
  equivocada.**
- **⚠️ CORRECCIÓN DEL FIX-PACK 1 — el «17/19 → 12/19» NO REPRODUCE.** Los dos números son de un
  estado intermedio del árbol que ya no existe (D5 todavía estaba encendida). Re-medido con el
  mutante «revertir `if (tracked.has(raw)) return [raw];`» sobre el árbol entregado:
  **con el arreglo `CITA=6 TP=6 INVENTADOS=0`; sin el arreglo `CITA=6 TP=5 INVENTADOS=1`**
  (`src/lib/operator-address.ts` `` `:1-16` `` → resuelve `src/routes/agents.ts` en vez de
  `src/adapters/registry.ts`). ⇒ **La dirección se sostiene y es más fuerte que el número: revertir
  el arreglo no recupera recall, FABRICA un destino inventado.** La lección de abajo queda entera;
  la cifra que la ilustraba, no. **Y ése es el punto: una lección verdadera puede venir con un
  número falso, y el número se propaga solo.**
- **Aplicar en**: toda vez que una métrica **empeore** al arreglar un bug. La reacción correcta no es
  revertir: es preguntar **qué otro defecto estaba compensando**. Y: la misma pregunta con dos usos
  (verificar vs resolver) no admite la misma respuesta — sólo uno de los dos puede darse el lujo de
  quedarse con el primer candidato.

---

### [2026-08-28 11:15] W2 — Ubiqué el token con `indexOf` y clasifiqué el equivocado

- **Error**: `classifyBareCite` buscaba la posición del token con `linea.indexOf(token)`.
- **Causa raíz**: `indexOf` devuelve la primera aparición del **substring**, no la del **token**.
  Medido en `src/lib/url-validator.ts:129`, cuya línea escribe dos direcciones IPv6: el token real es
  el `:1` final (carácter previo `0` ⇒ `RUIDO` por D1), pero `indexOf(':1')` caía dentro del `` `::1` ``
  anterior (carácter previo `:`), D1 no disparaba, y el token terminaba clasificado **`CITA` a la
  línea 1 de su propio archivo**.
- **Fix**: agregar la columna real (`col`) a `FoundCite`, producida por `scanSource`, y usarla.
- **Aplicar en**: cualquier análisis que re-busque en el texto algo que el escáner ya encontró.
  **Si el escáner sabe dónde está, que lo diga; re-buscarlo es una segunda implementación con sus
  propios bordes.** Y el modo de falla no fue un error: fue **una respuesta plausible**.

---

### [2026-08-28 12:30] W2 — El fixture del control no reproducía el defecto que decía cubrir

- **Error**: `G-C16` demostraba «un archivo auto-referente se lee a sí mismo» con un fixture que
  imitaba una entrada de `CITED_LINES` (`cite: ':20'` con el `target:` dos líneas abajo). El control
  fallaba: el fixture **no** reproducía el defecto.
- **Causa raíz**: en un `cite: ':20'` el carácter anterior al token es una **comilla**, así que lo
  caza D2 y nunca llega a mirar el contexto. El mecanismo real por el que estos archivos se leen a sí
  mismos es otro: el `` `:20` `` **backtickeado dentro de la prosa de un `reason:`**, que sí llega al
  contexto y encuentra el destino escrito dos líneas más abajo.
- **Fix**: el fixture usa la forma que sí reproduce el defecto, y el docblock dice cuál es la que
  **no** lo reproduce y por qué.
- **Aplicar en**: todo control cuyo fixture «demuestra» un defecto. **Un fixture positivo que no
  reproduce el defecto deja el control decorativo y verde.** El único modo de saberlo es exigirle al
  fixture que falle *sin* el arreglo — que es lo que este control hace ahora explícitamente.

---

### [2026-08-28 13:05] W2 — Inventé dos rutas de documento en un fixture, y el comentario que lo explicaba las volvió a inventar

- **Error**: el fixture de homónimos de `G-C15` usaba dos rutas inventadas bajo `doc/sdd/`. El gate
  se puso rojo, pero **no** en mi guardián: en `test/docs-referenced-by-code-exist.test.ts`, que
  verifica que todo path con forma de documento nombrado por el código EXISTA.
- **Causa raíz**: elegí el nombre del fixture por realismo (el basename de los documentos de HU es el
  caso real de homonimia en este repo) sin preguntarme quién más mira ese texto.
- **🔴 Y el segundo error, que es el interesante**: al arreglarlo, escribí un comentario explicando
  el arreglo **que citaba las dos rutas inventadas**. El guardián es **textual**: no le importa que
  sean un ejemplo. Volvió a ponerse rojo por la misma causa, dentro del arreglo de la misma causa.
- **Fix**: el fixture usa un basename `.ts` con dos candidatos —misma propiedad, otro nombre— y el
  comentario describe el caso **sin escribir las rutas**.
- **Aplicar en**: cualquier fixture que contenga un path, una URL o un identificador con forma
  «real». Y sobre todo: **la prosa que explica un arreglo está sujeta a los mismos guardianes que el
  arreglo.** Un ejemplo escrito en un comentario no es un ejemplo para un guardián textual.

---

### [2026-08-28 14:10] W2.4 — El umbral pre-registrado admitía dos lecturas opuestas

- **Error**: CD-19 decía «más de 20 FP sobre 94 ⇒ D5 se degrada». Mi censo midió **17 FP sobre 36**.
  Leído como número absoluto, 17 ≤ 20 ⇒ D5 pasa. Leído como tasa, 47 % ≫ 21 % ⇒ D5 no pasa.
- **Causa raíz**: el umbral se escribió contra una población **esperada** de 94, y la real salió 2,6
  veces más chica. Un umbral absoluto sobre un denominador que encogió deja de ser un umbral.
- **Fix**: **se escribieron las dos lecturas** —en el censo, en el docblock de `classifyBareCite` y
  en el de `D5_CENSUS`— y se aplicó la de la tasa, con el motivo. D5 quedó degradada a
  `INDECIDIBLE`, y `G-C17c` impide re-encenderla sin re-hacer el censo.
- **Aplicar en**: todo criterio pre-registrado que mezcle un número absoluto con un denominador
  esperado. **Escribilo como tasa.** Y si aparece ambiguo cuando ya tenés el resultado: publicá las
  dos lecturas antes de elegir. Elegir la cómoda en silencio es exactamente el defecto que un umbral
  pre-registrado existe para impedir.

---

### [2026-08-28 15:20] W4 — El mutante obvio habría dado un FALSO KILLED

- **Error potencial (evitado, no cometido)**: para probar `G-C18` el reflejo es mutar el `target` de
  una entrada P3/P4 y ver el gate en rojo.
- **Causa raíz**: ese mutante **ya muere hoy**, por `G-C5`/`E-ANCHOR_GONE`/`E-LINE_MOVED`, que cruzan
  `mustContain` contra `target:line`. Verificado corriéndolo: mutando `line: 634` → `line: 640` sale
  `× G-C5 … E-LINE_MOVED` y **`G-C18` queda verde**. Quien lo usara concluiría que el control nuevo
  funciona cuando podría estar vacuo.
- **Fix**: el mutante correcto muta **el párrafo del citador**, dejando `target`, `line`,
  `mustContain` y `symbolPath` intactos ⇒ `G-C5`/`G-C6`/`G-C7` siguen verdes y el único que puede
  ponerse rojo es el control nuevo. Además el nombre inyectado debe tener **exactamente 1 candidato
  por basename** (`chain-resolver.ts`): con uno de 2 candidatos el veredicto sería `AMBIGUOUS` y **no
  habría rojo en absoluto**.
- **Aplicar en**: cada mutante, sin excepción. **Un rojo no se confirma por su color: se confirma por
  su MOTIVO LITERAL**, y antes de correrlo hay que preguntarse *¿qué OTRO control podría estar
  matándolo?* Si el mutante muere por un vecino, el resultado no vale.

---

### [2026-08-28 15:45] W2 — El mutante que no se aplicó (CD-18 funcionando)

- **Error**: el script del mutante de `G-C17b` buscaba un bloque de texto que **biome había
  reformateado** (el `reason:` multilínea pasó a una sola línea). El `replace` no matcheó.
- **Causa raíz**: escribí el patrón del mutante mirando el texto que yo había tipeado, no el que
  quedó en disco después del formateador.
- **Fix**: el arnés de mutación **verifica que el mutante esté en el archivo** (`grep` del marcador)
  **antes** de correr la suite, y aborta si no está. Abortó, y por eso no reporté un falso verde.
- **Aplicar en**: todo barrido de mutación. **Un mutante que no se aplicó y una suite verde son
  indistinguibles de un control que funciona.** El marcador explícito es más barato que la duda.

---

## FIX-PACK 1 (2026-08-28) — AR y CR, los dos RECHAZADO

> Los seis bloqueantes son **de prosa y de números publicados**. Ninguno de runtime. En una HU cuyo
> entregable ES la honestidad de la medición, eso es lo que bloquea.

### [2026-08-28 17:10] FP1 — Publiqué un número medido ANTES del cambio que lo invalidó, en el MISMO commit

- **Error**: `censo.md` publicaba «Recall 12/19 (63 %)» en cinco sitios. El medido es **6/19 (32 %)**.
  El mismo defecto en §10.2 («12 de las 19 pasan a tener testigo»: son 6).
- **Causa raíz**: el 12 es el recall **con D5 encendida**, y **D5 se degradó en el mismo commit que
  introdujo el censo**. Medí, cambié la cascada, y publiqué la medición de antes. Verificado mutando
  D5 para que vuelva a emitir `CITA`: da exactamente 12.
- **Fix**: re-derivado en la corrida y re-publicado en los 5 sitios + `auto-blindaje.md`, diciendo en
  la misma frase que el 12 era el número con D5 activa y por qué envejeció.
- **Aplicar en**: **todo número medido antes de un cambio de comportamiento del mismo commit.** El
  antídoto no es acordarse: es que el número tenga un testigo que lo RE-DERIVE en la corrida que lo
  publica. Los números de §7.2 tenían `G-C17b` y salieron exactos en las dos re-derivaciones
  independientes; los que fallaron son exactamente los seis que no tenían testigo. **La regla que
  sale de acá: si un número del documento no tiene una función que lo recalcule, va con fecha y con
  la palabra «foto», o no va.**

### [2026-08-28 17:20] FP1 — Publiqué TRES falsos positivos y sólo UNO existe

- **Error**: §7.4 declaraba `FP-1`, `FP-2` y `FP-3`. Re-derivados, `FP-2` y `FP-3` dan
  `INDECIDIBLE [D6]` e `INDECIDIBLE [RESIDUO]`, **y la muestra los etiqueta `INDECIDIBLE` a mano** ⇒
  son ACIERTOS. La afirmación estaba además copiada en dos docblocks del código entregado y era la
  justificación escrita de dos de los cinco cambios de `src/`.
- **Causa raíz**: **describí el modo de falla que el código PODRÍA producir y lo escribí como si lo
  hubiera producido.** El modo es real (un `:N` cross-repo con un solo archivo local en el párrafo
  resolvería al local), pero los dos sitios que elegí como ejemplo nombran DOS archivos locales, así
  que D6 dispara antes que D3a. La descripción corresponde a una definición de párrafo más angosta
  que la que el código implementa. Y AC-1 pedía ≥3 FP, o sea que **había una presión numérica hacia
  el error**.
- **Fix**: barrido completo del perímetro buscando el modo — **13 tokens con un repo ajeno en el
  párrafo, 0 con veredicto `CITA`, sobre 1152**. Publicado como **modo previsto sin instancia
  medida**, y declarado que **AC-1 no se cumple con FPs medidos: hay 1**. Las dos ediciones de `src/`
  se mantienen con su motivo verdadero (el destino no lo puede verificar nadie desde este índice),
  que es distinto del que decía.
- **Aplicar en**: cada vez que un AC pide **N ejemplos**. La pregunta de control:
  *¿este ejemplo lo corrí, o lo deduje de cómo creo que funciona el código?* Un ejemplo deducido y un
  ejemplo medido se escriben igual. **Y cuando el número no alcanza, se declara que no alcanza —
  llegar a N inventando el que falta es la misma clase de defecto que un destino inventado.**

### [2026-08-28 17:30] FP1 — Un «falso negativo» que era un acierto, porque la tabla no se re-derivó tras el fix

- **Error**: `FN-1` de §7.5 describía `facilitator-settle.ts:583` `` `:338` `` como perdido por D7.
  Re-derivado da `CITA [D3b] target=src/index.ts`, y el oráculo lo etiqueta igual ⇒ **true positive**.
- **Causa raíz**: es **literalmente el sitio que el arreglo «el path exacto gana» recuperó**. Escribí
  la tabla antes del arreglo y no la volví a correr después. Mismo mecanismo que el 12/19.
- **Fix**: reemplazado por uno de los 45 reales, con el reparto por regla re-derivado
  (D6 21 · D7 9 · D5 7 · RESIDUO 7 · D3a 1).
- **Aplicar en**: **toda tabla de ejemplos es una medición, no una ilustración.** Después de tocar el
  clasificador hay que re-correr los ejemplos, no sólo los agregados. Los agregados tenían testigo y
  sobrevivieron; los ejemplos no lo tenían y se pudrieron.

### [2026-08-28 17:40] FP1 — El mecanismo anti-cherry-pick era código muerto, y el AR lo falsificó

- **Error**: `sampleFrame`, `drawReservedSample`, `xorshift32`, `seedFrom`, `SAMPLE_SEED` y
  `STRATUM_N` estaban exportados, documentados y **sin un solo llamador**. El AR cambió una etiqueta
  de `CITA` a `RUIDO` y ajustó el tuple publicado de `fn:44` a `fn:43`: **20 tests verdes**. Un falso
  negativo desapareció del registro y ningún control se enteró.
- **Causa raíz**: escribí la maquinaria del sorteo para PRODUCIR la muestra, y una vez producida la
  dejé de invocar. La propiedad «nadie elige qué se etiqueta» quedó garantizada por el orden de los
  commits, que es prosa que hay que auditar a mano. **Un artefacto sin llamador no es una defensa.**
- **Fix**: `G-C17d` (~40 líneas con funciones que ya existían) re-deriva el marco desde
  `SAMPLE_BASE_COMMIT` con un solo `git cat-file --batch` (611 blobs, ~350 ms) y compara los 120
  `siteKey` contra `RESERVED_SAMPLE` en las dos direcciones.
  **Mutante M1**: sustituir un sitio de la muestra por otro del marco
  (`scripts/smoke-base-sepolia.mjs:21` → `scripts/doctor-dast.js:6`, mismo `cite`, misma forma, misma
  etiqueta) ⇒ **rojo SÓLO en `G-C17d`**, con los dos `siteKey` al lado.
  ⚠️ **El mutante OBVIO es un falso KILLED**: cambiar `file`+`line` sin cambiar `cite` produce un
  sitio inexistente y muere también por `G-C17b` (`ausentes`), o sea que no prueba nada sobre el
  control nuevo.
- **Aplicar en**: **buscá los `export` sin llamador de tu propio entregable antes de entregarlo.** Si
  una propiedad del AC descansa en una función, alguien la tiene que invocar en cada corrida. Y la
  pregunta que lo detecta: *¿qué edición hace falsa esta propiedad, y qué se pone rojo?*

### [2026-08-28 17:50] FP1 — Una definición más angosta que su regla: `DATO` acertaba 0 de 25

- **Error**: `BareLabel` definía `DATO` como «el VALOR de un campo `cite:`/`quote:`, la cita de OTRO
  archivo transcripta como dato». D2 dispara con «el carácter anterior al `:` es una comilla».
  Censo de los 25: **los 25 son valores dentro de un literal JSON o de un string de shell, ninguno
  es la cita de otro archivo.** Y de los 120 sitios etiquetados a mano hay **0 `DATO`**.
- **Causa raíz**: escribí la definición pensando en el caso que me motivó la regla y la regla
  cubriendo un superconjunto mucho más grande. **Y el scoring binario (`pred = label === 'CITA'`) lo
  volvía invisible**: colapsa las otras tres clases, así que las 6 discrepancias de la muestra no
  aparecían en ningún número publicado.
- **Fix**: se ENSANCHÓ la definición a lo que la regla hace, con el solapamiento con `RUIDO` escrito,
  y se publicó la **matriz 4×4** (§7.2). ⛔ No se angostó la regla: distinguir «literal de string» de
  «campo `cite:`» exige mirar el nombre de la clave, o sea una heurística nueva. Y queda declarado
  que **la precisión publicada es la de la clase `CITA` y sólo ésa**.
- **Aplicar en**: toda unión de clases con una cascada de reglas. **Leé la definición y la regla una
  al lado de la otra y preguntá cuál es más ancha.** Y: una métrica binaria sobre un contrato de N
  clases **no mide N−1 de ellas** — si el contrato tiene 4 clases, la matriz es 4×4 o no hay medición.

### [2026-08-28 18:00] FP1 — Una sección que se mide a sí misma excluyéndose, con dos instrumentos

- **Error**: §12 publicaba «3249 inserciones, factor 1,56×». El total salía del `numstat` del
  **commit anterior** (sin la propia §12 ni `auto-blindaje.md`) y las filas de un
  `grep '^+[^+]'` **que no ve las líneas en blanco**, así que **la tabla no sumaba su propio total**.
- **Causa raíz**: **una sección que mide el diff en el que vive no se puede medir antes de
  escribirse**, y yo la medí antes y no la volví a medir. Encima con dos instrumentos distintos para
  el total y para las filas.
- **Fix**: re-medido **después de todas las ediciones**, con **un solo instrumento**
  (`git diff --numstat`) para el total y para cada fila. El veredicto de la regla 10 no cambia.
- **Aplicar en**: toda métrica autorreferente (líneas del diff, tokens del propio archivo, artefactos
  que mencionan una palabra que el artefacto contiene — el «5 de 1085» de §3 es el mismo bug). **Se
  mide en la última pasada, y con un instrumento único. Dos instrumentos para el total y las partes
  es una tabla que no cierra y nadie suma.**

### [2026-08-28 18:10] FP1 — El gate del repo no mira una sola línea de lo que entregué

- **Error**: publiqué `tsc 0 · lint 520` como evidencia de la HU. `tsconfig.json` incluye
  `["src/**/*"]` y `npm run lint` corre `biome check src/`: de las ~3400 líneas nuevas, **todas en
  `test/` y `doc/`**, los dos sub-gates miran **cero**.
- **Causa raíz**: **leí el verde del gate como si hablara de mi entregable.** El verde era verdadero;
  el sujeto de la frase, no. Es la versión de tipos del «correr las partes de un gate no es correr el
  gate»: acá el gate corrió entero y aun así no tocó el trabajo.
- **Fix**: `tsconfig.guards.json` (aditivo, no toca `tsconfig.json` ni `lint`) + **`G-C19`**, que lo
  corre en cada `npm test` con el **binario directo** (`node ./node_modules/typescript/bin/tsc`,
  porque bajo el hook `npx tsc` tapa el exit code). **Mutante M4**: `const x: BareLabel =
  'NO_EXISTE';` ⇒ `tsc -p tsconfig.json` **exit 0**, `G-C19` **rojo con TS2322**. Declarado
  `TD-371-TYPECHECK-TEST` con su número: `test/**/*.ts` completo da **12 errores en 3 archivos**.
- **Aplicar en**: **antes de citar un gate como evidencia, verificá que su `include` alcance lo que
  escribiste.** Un gate verde sobre un conjunto que no te contiene es indistinguible de un gate verde
  que te aprueba.

### [2026-08-28 18:20] FP1 — Elegí el piso nuevo a ojo, y un mutante lo tumbó en la primera pasada

- **Error**: al arreglar el «piso clavado sobre el valor medido» puse **4** (medición 6, «margen 2»),
  razonando que *una edición de prosa mueve el número de a uno*. **Escribí «está medido» sin haberlo
  medido.**
- **Causa raíz**: el clasificador decide **por PÁRRAFO**, no por token. Los 6 aciertos salen de **4
  párrafos** (1 · **2** · **2** · 1), así que una sola mención de paso en el párrafo equivocado
  cuesta **2**. Medido con un mutante: agregando `src/services/budget.ts` al párrafo de
  `src/lib/operator-address.ts`, el recall cae **de 6 a 4** — o sea que el piso 4 volvía a tener
  margen CERO, el mismo defecto que estaba arreglando, un paso más abajo.
- **Fix**: piso **2**, derivado del reparto por párrafos (aguanta perder los dos más grandes), con la
  medición y el mutante escritos al lado en `G-C17` y en §7.3.
- **Aplicar en**: **todo umbral nuevo se elige midiendo el tamaño del salto más chico que el sistema
  puede dar, no el de la unidad en que se cuenta.** Y la trampa que casi paso de largo: al corregir
  un «número sin medición» es facilísimo poner OTRO número sin medición, porque el que corrige se
  siente del lado bueno. La frase «está medido» es una afirmación falsable: si la escribís, tenés que
  poder pegar la corrida.

### [2026-08-28 22:10] FP2 — Declaré «cerrado» un candado que dos ediciones abrían con el gate en verde

- **Error**: §7.1 afirmaba que AC-2 «queda cerrado» en sus dos mitades —muestra y momento— cuando la
  segunda no tenía guardián. El re-AR lo falsificó con dos ataques de dos ediciones cada uno: (A)
  pasar un `label` de `CITA` a `RUIDO` borrando su `target` y bajar en uno el falso negativo
  publicado; (B) mover el `target` del único FP medido hasta lo que el clasificador contesta y
  ajustar el tuple, con lo que **la precisión publicada saltaba a 14 de 14**. Los dos: `tsc`, `tsc`
  de guards, `lint` y los ~6360 tests **en verde**.
- **Causa raíz**: `G-C17d` guarda los SITIOS y lo dice con precisión en su docblock; yo leí esa
  precisión como si cubriera también las ETIQUETAS. **Un control honesto sobre lo que cubre no vuelve
  verdadera la frase del documento que lo cita.** Y `G-C17b` no ayuda: compara la derivación contra
  un literal que el mismo atacante edita.
- **Fix**: `G-C17e` — las líneas de campo (`file`, `line`, `cite`, `form`, `nth`, `label`, `target`)
  de la muestra se congelan contra el blob de `SAMPLE_BLIND_COMMIT` (el commit ciego) derivándolas de
  `git diff`, con control positivo del instrumento (120 `label:` encontrados) para que no dé verde
  por vacío. **Los dos ataques reproducidos: 22 verdes y 1 rojo cada uno, y el rojo es `G-C17e` en
  los dos** — ningún falso KILLED.
- **Aplicar en**: **una propiedad se declara cerrada por el guardián que la mata, no por el que está
  al lado.** Antes de escribir «queda cerrado», escribí la edición de dos líneas que lo violaría y
  corré el gate: si queda verde, la frase es falsa.

### [2026-08-28 22:20] FP2 — Un número con su perímetro y SIN su patrón admite cuatro lecturas

- **Error**: el «13 tokens con un repo ajeno en el párrafo» publicaba su perímetro (1152, commit
  base) pero no qué contaba como «ajeno». Reproduce exacto, y aun así el re-AR tuvo que **adivinarlo
  probando cuatro definiciones**. La lectura natural del docblock —el único repo que nombraba— da
  **4**.
- **Causa raíz**: al escribirlo, la definición estaba en mi cabeza y en el script que se tiró a la
  basura; CD-1 pide las dos cosas, y yo verifiqué que el número REPRODUCE sin verificar que sea
  DERIVABLE. Son distintas: reproduce el que ya sabe el patrón.
- **Fix**: los cinco nombres escritos como patrón (`wasiai-remittance-agents`, `wasiai-v2`,
  `wasiai-facilitator`, `wasiai-agentkey`, `chaski-v3`, como substring del párrafo) en el docblock de
  `classifyBareCite`, en el del guardián y en §7.4, con las cuatro definiciones y sus cuatro números
  re-derivados sobre el mismo perímetro: **4 · 6 · 13 · 6**.
- **Aplicar en**: **la prueba de que un número tiene su patrón no es re-correrlo: es que otro lo
  re-derive leyendo sólo lo publicado.** Si hay que preguntar, falta el patrón.

### [2026-08-28 22:30] FP2 — Decisión correcta, motivo falso: «no los hay» contra un censo de 17

- **Error**: AC-1 pide ≥3 falsos positivos citados; se declaró incumplido con **1** —lo cual está
  bien y no cambia— pero el motivo escrito era *«no hay tres errores que citar porque no los hay»*.
  El SDD §8.6 había designado OTRO instrumento para cazarlos («el censo COMPLETO de la clase más
  riesgosa, no por muestreo») y ese censo entregó **17 de 36 equivocados**, con testigo mecánico.
- **Causa raíz**: escribí el motivo mirando el instrumento que tenía a mano (la muestra reservada) en
  vez del que el SDD designó. Un motivo que afirma una AUSENCIA es la clase de frase que hay que
  cruzar con el instrumento designado antes de escribirla.
- **Fix**: motivo reescrito —«después de degradar D5, no quedan tres en el clasificador que se
  entrega»— con la cita de §8.6, el `D5_CENSUS` al lado, y **los dos caminos en una tabla para que el
  AC lo resuelva QA**, que es quien decide alcance.
- **Aplicar en**: **cuando una decisión es correcta, el motivo se revisa igual.** Un motivo falso
  debajo de una decisión buena sobrevive a todas las revisiones, porque nadie discute el veredicto.

### [2026-08-28 23:05] FP2 — Tres guards que dependen de historia que el CI no clona

- **Error**: `G-C17b`, `G-C17d` y `G-C17e` leen commits fijos (`SAMPLE_BASE_COMMIT` y
  `SAMPLE_BLIND_COMMIT`) con `git ls-tree` / `git show` / `git diff`. `.github/workflows/ci.yml` no
  declaraba `fetch-depth`, y `actions/checkout` documenta **default 1** («only a single commit is
  fetched»). En un clon `--depth 1` real de esta rama, `19405ba` y `5c9f383` **NO EXISTEN**: el
  clon trae **1 commit** y el comando exacto de `G-C17e` sale `fatal: bad object 5c9f383…` (exit
  128); el de `G-C17d`, `fatal: not a tree object`. **Los tres guards habrían reventado en el primer
  push, y no por una aserción: por un error de git.**
- **Causa raíz**: escribí guards que consultan el REPOSITORIO dando por sentado el árbol que tengo en
  disco. Local siempre hay historia completa; el CI clona lo mínimo. Y el verde de `main` no dice
  nada, porque **ningún test de `main` clava un SHA**: el modo de falla nace con el primer guard que
  mira historia y no existe antes.
- **Fix**: `fetch-depth: 0` **EXPLÍCITO en los DOS `actions/checkout@v7`** (`build-test` y
  `coverage`, que corre la misma suite), con el motivo escrito en el propio `ci.yml` nombrando a los
  tres guards. Explícito aunque el default fuera el correcto: **el default de una acción de terceros
  no es una precondición verificada.** Arreglar un solo checkout habría dejado un verde parcial, que
  se lee peor que el rojo.
- **Aplicar en**: **todo control que consulte historia de git —`git show <sha>`, `git diff <sha>`,
  `git ls-tree <sha>`, `git log`— es una precondición de INFRAESTRUCTURA, no sólo de código.** La
  pregunta, antes de escribirlo: *¿qué le llega al runner?* Y el corolario general: **un gate verde
  en un entorno no dice nada de otro entorno cuyo INPUT es distinto** — acá el input es cuánta
  historia hay, y ningún test del repo lo verificaba.

