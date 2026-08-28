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
  oráculo de **17/19 a 12/19**. El defecto estaba *compensando* una limitación de D6: cinco entradas
  resolvían bien porque el segundo archivo del párrafo se tragaba en silencio. **Estaban bien por la
  razón equivocada, y el 17/19 previo era falso.**
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
