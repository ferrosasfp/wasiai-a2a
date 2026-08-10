

> ⚠️ **YA INSERTADA — NO VOLVER A COPIARLA.** La fila `217` del índice existe desde el
> saneamiento del 2026-08-10. Copiarla de nuevo crearía una fila duplicada, y el guardián
> `test/sdd-index-matches-folders.test.ts` (control G-A2) pone `npm test` en **rojo** si eso
> pasa. Este archivo queda como registro de cómo se redactó, no como pendiente.
> Si el estado cambió, se edita la fila del `_INDEX.md`, no esta copia.

<!--
FILA LISTA PARA PEGAR EN doc/sdd/_INDEX.md, inmediatamente DESPUÉS de la fila `215`
(WKH-318) y ANTES del `---` de cierre (hoy `_INDEX.md:184`).

Por qué está acá y no ya en el índice: este agente no tiene tool de edición
incremental (solo Read/Write/Glob), y reescribir el `_INDEX.md` completo
(274 líneas / ~58k tokens, por encima del límite de una sola lectura) para
agregar una fila es un riesgo real de corrupción sobre un archivo compartido
por varios árboles de trabajo activos — mismo criterio ya usado por
`212-wkh-314-x402-inbound-solana/_INDEX-row.md` y
`214-wkh-316-escritor-payment-block/_INDEX-row.md`. Se deja staged en vez de
arriesgarlo.

Directorio `217` verificado libre antes de elegirlo (`Glob doc/sdd/21*/*` y
`doc/sdd/22*/*` al momento de este F0: el número más alto existente era `216`,
WKH-319).
-->

| 217 | 2026-08-04 | [WKH-322] `/discover` ignora en silencio `min_reputation` (snake_case) porque el filtro real sólo reconoce `minReputation` (camelCase) — medido hoy contra prod: `?min_reputation=0/1/2/3` da 23/23/23/23 agentes idénticos. **Hallazgo de F0 que reencuadra el encargo**: el filtro NO es un parámetro fantasma — YA existe, mergeado a `main` (fix-pack P1 hallazgo-2, commit `6373dd8`, fila `189`) y extendido por WKH-313 (carril de estreno). La causa real es que la ruta sólo reconoce `minReputation` (camelCase, `routes/discover.ts:141`) mientras `/compose` usa `min_reputation` (snake_case) para la MISMA capacidad en `constraints` (`services/capability-resolver.ts:110-112`) — mismo protocolo, dos convenciones, y Fastify no valida querystring/body no declarados en ninguna de las dos rutas de `/discover`, así que el nombre equivocado se descarta en silencio en vez de fallar. 5 ACs EARS (2 de regresión sobre lo que YA funciona — AC-1/AC-4 — más AC-2/AC-3/AC-5 sobre el gap de naming). 4 CDs, la más importante CD-1: prohibido tocar `/compose`/`capability-resolver.ts` (ya filtra bien, es money-adjacent). 2 Missing Inputs bloqueantes para F2: MI-1 (alias vs 400 fail-loud — recomendación del Analyst: alias) y MI-2 (repetir la medición contra prod con el nombre CORRECTO antes de cerrar, para descartar deploy-lag real). **DT-2 (hallazgo colateral, no bloqueante)**: las filas `211` (WKH-313) y `215` (WKH-318) de este índice dicen "no mergeado a `main`" pero el código de ambas YA está en el árbol de trabajo actual sin diffs pendientes — mismo patrón de estado desactualizado que la nota final de este archivo ya documenta, ahora con dos casos nuevos; pendiente de reverificar con git y corregir esas dos filas. | feature/security | QUALITY | in progress (F1 — esperando HU_APPROVED) | feat/217-wkh-322-discover-reputation-param-naming ([work-item.md](217-wkh-322-discover-min-reputation-param-naming/work-item.md)) |
