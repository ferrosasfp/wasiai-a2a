> 🔴 **PENDIENTE DE INSERTAR — esta fila NO está en `doc/sdd/_INDEX.md` todavía.**
> A diferencia de los `_INDEX-row.md` de las HUs `212`, `217`, `220` y `221`, que son registros
> de una fila ya insertada, **ésta hay que pegarla**. Mientras no se pegue hay una consecuencia
> mecánica, no cosmética: el guardián `test/sdd-index-matches-folders.test.ts` deriva las
> carpetas de **`git ls-files doc/sdd`** y exige **exactamente una fila por carpeta de HU**, así
> que **el primer commit que trackee `doc/sdd/224-citas-archivo-linea-sin-testigo/` pone
> `npm test` en ROJO** hasta que esta fila exista. Hoy la carpeta está untracked y por eso el
> guardián sigue verde: el rojo llega con el `git add`, no con la creación.

<!--
FILA LISTA PARA PEGAR EN doc/sdd/_INDEX.md.

DÓNDE: inmediatamente DESPUÉS de la fila `223` (WKH-360, hoy `_INDEX.md:215`, la última de la
tabla) y ANTES de la línea en blanco `:216` y del `---` de cierre `:217`.

⛔ AL FINAL DE LA TABLA, Y NO ES ESTILO — es CD-5 del work-item.
`src/lib/capability-risk.ts` y `src/lib/capability-risk.test.ts` citan `doc/sdd/_INDEX.md:144`,
y esa cita está VERIFICADA por el control `G-F1` con
mustContain: ['remit.corridor-discovery', 'kyc-check', 'cashout-match']
(`test/sdd-index-matches-folders.exceptions.ts:181-192`). Insertar cualquier línea POR ENCIMA de
la 144 corre la tabla y rompe una cita de código del camino del dinero. Insertar al final no
mueve la 144. El propio índice lo explica en "Por qué la fila `023` está fuera de orden
numérico" (`_INDEX.md:245-253`).

POR QUÉ ESTÁ ACÁ Y NO YA EN EL ÍNDICE: el agente que escribió esta HU corrió sin tool de
edición incremental (sólo Read/Write/Glob, sin shell). Reescribir el `_INDEX.md` completo para
agregar una fila exige transcribirlo entero desde lecturas parciales, y un solo error de
transcripción por encima de la línea 144 rompe en silencio la cita verificada por G-F1. Se
deja staged en vez de arriesgarlo. Es el mismo motivo que declara
`doc/sdd/212-wkh-314-x402-inbound-solana/_INDEX-row.md:13-16`.

NÚMERO `224` VERIFICADO LIBRE antes de elegirlo: en `doc/sdd/` el número más alto ocupado es
`223` (`223-coordinador-como-agente/`), medido con Glob sobre `doc/sdd/2*/*.md`. La última fila
de la tabla es la `223` en `_INDEX.md:215`.

⚠️ SIN `|` LITERAL DENTRO DE LA FILA, a propósito: un `|` sin escapar dentro de un span de
código le cuenta columnas de más a la tabla (el bug de la fila `155`, declarado en la fila
`221`). Esta fila no usa ninguno.

⚠️ EL IDENTIFICADOR DE LA HU ES PROVISORIO: `TD-316-CITAS-SIN-TESTIGO` es el nombre de la
DEUDA, no un ticket `WKH-`. El founder todavía no asignó el número; el work-item lo declara como
[NEEDS CLARIFICATION] en su encabezado en vez de inventarlo. Si se asigna un `WKH-NNN`, se
corrige esta celda.
-->

| 224 | 2026-08-19 | [TD-316-CITAS-SIN-TESTIGO] Las citas `archivo:línea` que documentan invariantes de seguridad no tienen testigo: ningún test del repo puede ponerse rojo porque un comentario, un docblock o un nombre de test apunten a la línea equivocada. La deuda venía declarada (`doc/sdd/214-wkh-316-escritor-payment-block/auto-blindaje.md:624-698`) con **18 citas defectuosas y 0 cazables** en el radio de una sola HU. **Por qué 0**: `codeOnly` (`test/payment-guards-live-in-one-place.test.ts:45-55`) **borra los comentarios antes de mirar**, y tiene que hacerlo (su `:16-20` explica el falso positivo que lo obliga) ⟹ el guardián estructural más nuevo del repo no puede ponerse rojo por prosa **por construcción**; y `docs-referenced-by-code-exist` valida existencia de documento, no de línea. **El diseño no se inventa: se extiende.** Ya existe aplicado a UN destino en `test/sdd-index-matches-folders.exceptions.ts:160-192` (`CITED_INDEX_LINES` con `mustContain` escrito **a mano** porque *«es una afirmación sobre el mundo, no una lectura del mundo»*, `:172-179`) más el control que cierra la clase, **`G-F2`** = *«cita nueva sin declarar = rojo»* (`test/sdd-index-matches-folders.test.ts:420`). **Lo que esta HU agrega y el exemplar no tiene, porque es el mecanismo medido de supervivencia del defecto**: el `mustContain` se exige **único en el archivo citado** (AC-3) y la cita se ancla a su **función contenedora** (AC-4) — las dos veces que una cita rota mandó a otra función del mismo archivo, **el número equivocado contenía el texto buscado**, así que abrir la línea y comparar **daba OK** y la evidencia se auto-confirmaba (`auto-blindaje.md:682-684`). **HALLAZGO DEL F1 QUE CONTRADICE AL ENCARGO Y CAMBIA POR DÓNDE SE EMPIEZA**: el encargo señalaba `test/ownership-filter-guard.exceptions.ts` como el peor archivo (41 pares `{file,line}` más 14 anclas de prosa), y medido es **el mejor protegido del repo en esta clase** — su clave de match **es** `archivo:línea` (`test/ownership-filter-guard.test.ts:317-320`) y lo vigilan `G-08` (`:594-611`), `G-09` (`:613-631`, cuyo mensaje nombra literalmente *«o la consulta se movió de línea»*, `:623-624`) y `G-10` (`:660-684`, que cruza `table`/`verb` contra la cadena real y es un `mustContain` semántico ya implementado) ⟹ esos 41 pares **quedan FUERA** del universo (CD-1: re-cubrirlos sería el duplicado que `payment-guards-live-in-one-place.test.ts:9-14` existe para prevenir). Lo que ahí sigue sin testigo son sus **anclas de prosa**. **Aritmética heredada que NO reconcilia y por eso no se puede reusar**: `auto-blindaje.md:663-667` publica 41 más 14 = **55** anclas en un solo archivo y **46** en los 12 archivos juntos; 46 < 55, así que son dos poblaciones contadas con instrumentos distintos y el documento no lo dice ⟹ el F2 **deriva** su universo y declara qué población cuenta. **Sizing L y PARTIDA**, con el criterio explícito: el costo no es el guard sino **declarar a mano el `mustContain` de cada cita barrida**, porque `G-F2` deja el guardián rojo por definición hasta que estén todas ⟹ el universo es **decisión de diseño** (DT-2: acotado por PATH explícito, ampliable por cortes) y no un descubrimiento. Rechazadas por escrito: el techo decreciente (acota la tasa, no cierra el camino) y barrer sólo el diff (haría depender el verde de `git diff`, que bajo el hook de `rtk` **trunca con exit 0**). **Alcance decidido y justificado, no asumido: SÓLO `wasiai-a2a`.** El defecto es sistémico en tres repos, pero el universo se deriva del índice de git y acá `doc/` **viaja sólo en parte** (`.gitignore:165-193` ignora archivos `doc/sdd/**` individuales), mientras en `wasiai-remittance-agents` `doc/` está ignorado **entero** ⟹ un guard para tres repos con tres universos incompatibles no cierra ninguno. La portabilidad queda como `TD-316-CITAS-PORTABILIDAD`. **No toca una línea de producción** (CD-2): sólo `test/` más el número de citas dentro de comentarios. ⚠️ **Este F1 corrió SIN SHELL** (sólo Read/Write/Glob): cada cita de su work-item está marcada como **medida por mí**, `[HEREDADO]` o `[NO MEDIDO]`, y **el nombre de la rama es una propuesta sin verificar** porque no se pudo correr `git rev-parse --abbrev-ref HEAD` — se declara sin medir en vez de afirmarlo, que es el error que ya cometió una fila de este índice al nombrar una rama con un sufijo de más que existía y estaba en `main` sin commits propios, haciendo que quien verificaba confirmara la mentira. | test/security-docs | QUALITY | in progress (F1 escrito — esperando `HU_APPROVED`) | feat/224-citas-archivo-linea-sin-testigo `[rama NO verificada: sin shell en el F1, hay que crearla y confirmarla en F2/F3]` ([work-item.md](224-citas-archivo-linea-sin-testigo/work-item.md)) |
