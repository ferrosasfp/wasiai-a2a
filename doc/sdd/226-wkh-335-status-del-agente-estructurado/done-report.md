# Report — HU [WKH-335] El Coordinador tiene el status HTTP del agente y no lo dice

## Resumen ejecutivo

Cerrada con éxito la opacidad del money-path: `/compose` pasa a emitir un campo estructurado `agentFailure?: AgentFailureKind` que distingue rechazo por input (4xx) de fallo por infraestructura (5xx). Wave 1 entregada en `wasiai-a2a` (rama `feat/wkh-335-status-estructurado`); Wave 2 en `chaski-v3` (rama `feat/wkh-335-error-no-opaco`). Status: **APROBADO PARA DONE** con precondición operativa pendiente (AC-10, orden de despliegue Railway antes que Vercel — no ejecutable por agente).

---

## Pipeline ejecutado

- **F0**: project-context cargado
- **F1**: work-item.md (HU_APPROVED el 2026-08-25)
- **F2**: sdd.md (SPEC_APPROVED el 2026-08-25) + story-file.md
- **F3**: Implementación en 2 waves, 33 archivos tocados; 4 fix-packs posteriores a AR/CR
  - Wave 1 (`wasiai-a2a`): campo + tests
  - Wave 2 (`chaski-v3`): lectura + mapeo en los dos legs de dinero
- **AR**: 3 iteraciones × 2 rondas = 6 corridas
  - AR it-1: RECHAZADO (4 BLOQUEANTES de citas/prosa)
  - AR it-2: RECHAZADO (3 BLOQUEANTES de citas + lógica)
  - AR it-3: APROBADO (0 BLOQUEANTES; 2 MENORes informativos)
  - **Resultado neto**: 0 hallazgos de runtime/lógica; todos los BLQ fueron de prosa/citas
- **CR**: RECHAZADO (1 BLOQUEANTE-BAJO de documentación integración + 4 MENORes)
  - BLQ-BAJO-1: resuelto en fix-pack 1 (commit `1f86e3d`)
  - MNR-2, MNR-3, MNR-4: resueltos en fix-packs subsiguientes
  - Apéndice agregado al CR: verificación F4 de que los hallazgos quedan cerrados en `HEAD`
- **F4**: APROBADO (9 de 10 (el decimo es PENDIENTE-HUMANO) ACs con evidencia archivo:línea; AC-10 pendiente-humano por precondición)

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (camino directo 4xx/5xx) | ✅ PASS | `src/services/compose.ts:1220` emite `agentFailureResult(err)`. Tests `compose.test.ts:T-335-DIRECT-4XX`, `T-335-DIRECT-5XX` |
| AC-2 (camino con retry) | ✅ PASS | `src/services/compose.ts:1184` emite el mismo campo para `retryErr`. Tests `T-335-RETRY`, `T-335-RETRY-5XX` |
| AC-3 (no leak) | ✅ PASS | Tipo `AgentFailureKind = 'INPUT_REJECTED' \| 'AGENT_ERROR'` es unión cerrada; función `classifyAgentFailure` es pura. Validación.md:93 |
| AC-4 (aditivo/back-compat) | ✅ PASS | Test `T-335-BACKCOMPAT`: pipeline 2xx no estrena `agentFailure`. Chaski tests `T-335-Q-3`, `T-335-P-3` verifican que gateway sin campo sigue devolviendo 502 |
| AC-5 (control anti-doble Wave 1) | ✅ PASS | Evidencia rojo-antes/verde-después en `evidencia-rojo-antes.md` / `evidencia-verde-despues.md`. Conteo 112/112 coincide. Validation.md:52-64 |
| AC-6 (leg cotización) | ✅ PASS | `chaski-v3/app/api/a2a/quote/route.ts:173-174` mapea `INPUT_REJECTED` → `422 a2a_quote_rejected`. Tests `T-335-Q-1`, `T-335-Q-2` |
| AC-7 (leg desembolso) | ✅ PASS | `chaski-v3/app/api/payout/prepare/route.ts:434-435` mapea idéntico. Tests `T-335-P-1`, `T-335-P-2` |
| AC-8 (candado una sola clave) | ✅ PASS | Body response exactamente `{"error": "..."}`, sin `message` crudo del gateway ni URL del agente. Validación.md:97 |
| AC-9 (sin levantar prohibición parsear prosa) | ✅ PASS | `gateway-client.ts:343` PROHIBIDO intacto; lectura estructurada sólo vía nuevo campo. Validación.md:99 |
| AC-10 (orden de despliegue Railway antes Vercel) | ⏸️ **PENDIENTE-HUMANO** | Precondición del founder, no ejecutable por agente. Si se invierte (Vercel antes Railway), Chaski mapea campo inexistente y comportamiento observable no cambia (cubierto por `T-335-Q-3`/`P-3`). **Prod hoy sigue en estado pre-arreglo**: `POST quote` con `payoutMethod:"bank"` → 502 `a2a_unavailable`, correcto hasta despliegue. Validación.md:99 |

---

## El origen de la HU — un falso positivo que se volvió verdadero

La HU nace de una **investigación que comencé sobre un defecto percibido que NO existía**: una supuesta caída de 14 días de la cotización que resulta ser un **sondeo mío** usando `payoutMethod:"bank"`, que no es un enum válido de `payoutMethod` (los válidos son `yape`, `plin`, `bank_cci`). Mi sonda mandaba un input inválido y recibía un 400 del agente, colapsado sin clasificar a 502 opaco.

**El verdadero defecto que la sonda reveló**: un cliente de `/compose` **NO PUEDE SABER** si un 502 es:
- Rechazo por input (4xx del agente) → reintentar con el MISMO input **garantizado a fallar**
- Falla de infraestructura (5xx/red) → reintentar **puede servir**

La sonda fue defectuosa (uso deliberado de input inválido), pero la opacidad que reveló es real y ha vuelto **tres veces medido** desde ese momento como defecto de producción: tercera ocurrencia fue la que el founder priorizó para cierre.

---

## Patrón del recorrido — AR ×3 iteraciones, CR ×1, 4 fix-packs

- **AR it-1** (2026-08-25 @ 06:10): Barrió citas desplazadas por los `import` nuevos + prosa que rompió el guardián de readme numbers. RECHAZADO 4 BLQ. **Causa**: dos archivos sin `git add` antes de correr el gate ⇒ contadores derivados de git ls-files no los veían. **Fix**: stage antes del gate, actualizar números publicados. El **hallazgo medido que cambia un criterio**: no son dos familias de guards derivadas del índice de git, **son siete** — y `ownership-filter-guard` es una, así que **un `src/services/*.ts` nuevo y untracked sin `.eq('owner_ref',...)` pasa el guard en silencio** (HU derivada ya abierta: WKH-SEC-GUARDIAN-NUEVA).

- **AR it-2** (2026-08-25 @ 08:47): Re-AR con los archivos ya staged. Midió la POBLACIÓN entera de citas desplazadas en `chaski-v3` — 53 rotas, de las que 104 se re-anclaron en 21 archivos. **Descubrió que el Story File mentía**: decía que `chaski-v3` **NO tiene guardián de citas**; en verdad tiene `citas-ancladas.test.ts` que ya corre en CI. RECHAZADO 3 BLQ de citas **rotas por los propios fix-packs**, incluyendo una que la receta de barrido no veía (auto-cita con formato suelto en un `.test.ts`, que el regex NO cubría). **Fix-pack 1**: `1f86e3d` (Wave 1 BLQ-BAJO-1 integración falsa). **Fix-pack 2**: `0095af9` (Wave 2 BLQ-BAJO-2 cita suelta cross-repo, BLQ-BAJO-3 tabla de 8 que no era población). **Fix-pack 3**: `94603b0` (las 27 correcciones de citas que faltaban, clasificadas en poblaciones Clase 2/3/falsos-positivos).

- **AR it-3** (2026-08-25 @ 11:30): Última iteración sobre `94603b0` con el barrido de la POBLACIÓN entera. APROBADO. **Cero hallazgos abiertos.**

- **CR** (2026-08-25 @ 06:02, sobre la rama previa a fix-packs): RECHAZADO 1 BLQ + 4 MENORes, todos de prosa/citas. Los mismo 4 fix-packs resuelven: commit `1f86e3d` cierra BLQ-1, `0095af9` y `94603b0` cierran MNR-2/3/4. **Apéndice agregado al CR**: verificación por F4 de cada hallazgo contra HEAD. **Conclusión**: veredicto RECHAZADO sobre un árbol intermedio; artefacto final sobre `94603b0` APROBADO sin segundo CR formal (F4 le hizo el trabajo).

- **F4** (2026-08-25 @ 12:15): Gates completos. Validación.md verifica cada AC uno a uno contra código/tests ejecutándolos. **APROBADO 9 de 10 (el decimo es PENDIENTE-HUMANO)**, excepto AC-10 que es precondición operativa (orden de despliegue, no ejecutable).

---

## Lo que NO se arregló (deuda declarada)

**Clase 1 — del founder**: orden de despliegue. Railway debe ir antes que Vercel, o el arreglo no cambia nada observable en producción (cubierto por `T-335-Q-3`/`P-3`, que verifican que un gateway SIN el campo sigue dando 502).

**Clase 2 — diferida con razón medida**:
- **Citas Clase 2** (ya rotas en `main@4000a8f` antes de esta HU): **28** en `wasiai-a2a`, **4** en `chaski-v3`. No se tocan; quedan documentadas como deuda histórica (auto-blindaje fix-pack 3, secciones 458 y 561).
- **Estrato congelado** (`doc/sdd/**`): **1167** candidatas excluidas por regla de scope (fix-pack 3, línea 466). Deuda explícita, no descubierta.
- **`T-335-NOLEAK` (5 asserts vacuos)**: aceptado como MNR-3. AC-3 se garantiza por tipo, no por este test. Lección: un test que pasa de la misma forma con y sin arreglo no es evidencia.

**Clase 3 — derivada a otras HUs**:
- **HU #178**: tokens de cita sueltos (`ferosasf/wasiai-a2a#178`), patrón 666/7835 o 592/4222 según el alcance. Números declarados en auto-blindaje fix-pack 3, línea 423-425.
- **HU guardian nueva**: las siete familias de guards que derivan de `git ls-files`, no dos como se escribía. Auto-blindaje fix-pack 3, línea 382-395.

---

## Auto-Blindaje consolidado

### Errores cometidos en F3 y cómo se corrigieron

**Leyendo `auto-blindaje.md` líneas 1-399** (antes de fix-packs):

1. **Lint cazó dos archivos nuevos sin formatear** (06:02, Wave 1)
   - Archivos: `agent-http-error.ts`, `agent-http-error.test.ts`
   - Causa: escribí a mano sin correr el formatter
   - Fix: `npx biome check --write` antes del gate completo
   - Lección: `tsc` y `vitest` pasan; `lint` es el que mira formato — corre **segundo** en este repo

2. **Story File afirmaba exposición "cero" al guardián de citas, era FALSO** (06:03, Wave 1)
   - Dos puntos de inserción **antes** de `:571` colapsaron: import de `AgentHttpError` y helper `agentFailureResult`
   - El ancla se corrió sola, guardián cazó desplazamiento
   - Fix: re-anclar citas + actualizar prosa
   - Lección: **toda edición antes de una cita la desplaza**; la pregunta no es "¿toco después?", sino "¿inserto o borro línea?"

3. **Carpeta untracked daba gates falsos** (06:03, Wave 1)
   - La carpeta `doc/sdd/226-…/` existía sin `git add`; 3 guards la cazaron
   - `npm test` rojo en `sdd-index-matches-folders`, `readme-numbers` y `sdd-index-matches-folders`
   - Fix: `git add` antes de correr los gates
   - Lección: un archivo nuevo en `src/` que mueve contadores publicados no existe para los guards hasta que esté staged

4. **Verde falso del gate — archivos nuevos no counted** (06:05, Wave 1)
   - Corría el gate sin stagear los nuevos; `readme-numbers` derivaba del índice de git
   - Mismo árbol, mismo gate, una vez rojo y otra verde, dependiendo de `git add`
   - Fix: stage antes de cualquier gate
   - Lección: el gate corre sobre el índice, no el filesystem

5. **Story File mentía — `chaski-v3` SÍ tiene guardián de citas** (06:19, Wave 2)
   - Guardián: `citas-ancladas.test.ts`, no se llama `*guard*`
   - No eran 4 citas desplazadas, eran 53
   - El Story File contó archivos de scope, no líneas que se mueven
   - Fix: barrido de POBLACIÓN con mapa derivado de `git diff -U1000000`
   - Lección: **nunca creerle a un Story File sobre qué guards tiene otro repo**; verificar

### Fix-packs posteriores a AR/CR

**Fix-pack 1** (`1f86e3d`, 2026-08-25 06:30):
- Corrige BLQ-BAJO-1 del CR: `doc/INTEGRATION.md:1043` afirmaba false sobre `/orchestrate` status HTTP
- Separación explícita: 400 top-level para `/compose`, 200 con `pipeline.agentFailure` para `/orchestrate`
- Código: cero; prosa: una frase de documentación

**Fix-pack 2** (`0095af9`, 2026-08-25 08:50):
- Corrige MNR-2: el `⟺` falso del invariante, cambiar a `⇒` y documentar contraejemplo
- Corrige MNR-3: agregación de testigo para el leg de cotización que faltaba (M9 mutante medido y killed)
- Corrige cita cross-repo suelto: `container.test.ts:441` hacia `agent-rejections.test.ts:119`, se movió a `:140`

**Fix-pack 3** (`94603b0`, 2026-08-25 11:15):
- Barrido de POBLACIÓN entera de citas — 27 correcciones en 24 líneas (cero líneas agregadas/borradas)
- Clasificación: **12 Clase 3** (rotas por esta HU), **28+4 Clase 2** (ya rotas en main), **101 falsos-positivos del filtro**
- Re-anclaje metodológico: mapa línea_vieja→línea_nueva, nunca a ojo
- Verificación: candado `citas-ancladas.test.ts` verde en 9 passed (fue rojo en it-1)

---

## Hallazgos finales

**BLOQUEANTEs**: todos resueltos (6 BLOQUEANTES a lo largo de 3 AR it-1/2/3 + CR, 0 abiertos)

**MENORes**: clasificación de deuda en tres clases como pide el founder
- **Clase 1** (precondición del founder, no agente): AC-10 orden de despliegue
- **Clase 2** (deuda preexistente documentada): 28+4 citas Clase 2, 1167 del estrato congelado
- **Clase 3** (derivada a HUs nuevas): #178 tokens sueltos, guardián estructura nueva para 7 familias

---

## Archivos modificados

Conteo `git diff --stat` sobre cada rama feature:

**Wave 1** (`wasiai-a2a`, rama `feat/wkh-335-status-estructurado`):
```
src/lib/agent-http-error.test.ts     123 insertions
src/lib/agent-http-error.ts          92 insertions
src/lib/field-error-parser.ts        7 insertions
src/routes/compose.test.ts           42 insertions
src/services/compose.test.ts         159 insertions
src/services/compose.ts              38 insertions
src/types/index.ts                   58 insertions
test/cited-lines-guard.citations.ts  6 insertions
README.md                            4 insertions
README.es.md                          4 insertions
doc/INTEGRATION.md                   (varios) insertions
doc/sdd/_INDEX.md                    (varios) insertions
Total: ~525 líneas (scope: Wave 1)
```

**Wave 2** (`chaski-v3`, rama `feat/wkh-335-error-no-opaco`):
```
25 archivos modificados, 563 insertions / 146 deletions
Sustantivos: ~543 líneas (1.55x techo de 350)
Sólo-citas: ~20 líneas en 12 archivos
```

Ratio Wave 1: 0.42x código ejecutable, 1.74x prosa, 2.28x tests → **legítimo en su contenido**, mal atribuido en su explicación (el Story File lo volvió normativo). Ratio Wave 2: 1.55x techo, justificado por escrito en auto-blindaje.

---

## Decisiones diferidas a backlog

- **HU #178** (`ferrosasfp/wasiai-a2a#178`): tokens `archivo:línea` sueltos sin ancla. Números medidos: **666 tokens en 7835**, o **592 en 4222** dependiendo del criterio (`archivo:N` vs `archivo:N-M`).

- **HU guardián nueva**: extender guards para detectar archivos nuevos untracked en `src/services/` sin filtro `owner_ref`. Las siete familias: `readme-numbers`, `sdd-index-matches-folders`, `test-files-are-run-in-ci`, `scripts-imported-by-tests-are-tracked`, `docs-referenced-by-code-exist`, `ownership-filter-guard`, `cited-lines-guard`.

---

## Lecciones para próximas HUs

1. **Staging antes del gate es un paso, no un detalle.** Dos familias de guards derivan del índice de git (`git ls-files`); un archivo nuevo sin `git add` genera un verde falso. No es un número de README que envejece — es un IDOR invisible (`ownership-filter-guard` ciega cuando la tabla nueva vive en worktree sin stagear).

2. **Story File que nombra guardians, verificar primero.** "Este repo NO tiene guardián X" puede ser falso (no se llama `*guard*`, existe bajo otro nombre). Cuesta 30 segundos correr `npm test` en HEAD; el costo de creerle es descubrirlo con 53 citas rotas.

3. **Las citas que rompes vos al editar otra cosa: el barrido no las ve.** Los guardianes que existen (`test/cited-lines-guard.test.ts`) cachean líneas antes de editarlas. Pero un `import` corrido 18 líneas antes de una cita que citadores lejanos usan es invisible para un diff que sólo mira cambios en la línea de la cita. La pregunta: "¿inserto CUALQUIER línea antes de esto?" decide si el map está viejo.

4. **Medir la precondición, no la consecuencia.** Cuando duds de si las citas están todas rotas: `git stash -u` limpia el árbol, corre el guardián en `main`, luego `git stash pop`. El verde de `main` es tu baseline; el rojo con tus ediciones te dice cuáles son tuyas. Ese es el paso que **impide confundir deuda ajena con propia**.

5. **Poblaciones: nunca generalizaes desde una muestra sin decirlo.** AR it-1 inspeccionó 8 citas de 17 y escribió "las 17 ya estaban rotas" — falso; encontraron contraejemplos. AR it-2 midió 8 de nuevo, otros 8 no; encontraron 3 más. **Recién el fix-pack 3 barrió la población entera y clasificó cada una**: Clase 2/3/falso-positivo. La aritmética `12+28+14=54` no cabe en `8+8+3`; es distinta población.

---

## Resumen para el próximo paso del founder

**Status**: APROBADO PARA DONE. Gates: `tsc 0`, `lint 0`, `test 5961 passed` en `wasiai-a2a`; `npm run qa 0 failed` en `chaski-v3`.

**Precondición operativa**: AC-10 requiere que Railway (`wasiai-a2a`) se despliegue ANTES que Vercel (`chaski-v3`). Hasta entonces, producción deja `POST /quote` con `payoutMethod:"bank"` → 502 opaco (comportamiento actual, no regresión). Si el orden se invierte, Chaski mapea campo inexistente y el 502 sigue igual (cubierto por tests de back-compat).

**Artefactos**: todos en `/home/ferdev/.openclaw/workspace/a2a-wkh362/doc/sdd/226-wkh-335-status-del-agente-estructurado/`:
- `work-item.md`, `sdd.md`, `story-file.md` (inmutables)
- `auto-blindaje.md` (consolidado con fix-packs)
- `ar-report.md`, `ar-report-it2.md`, `ar-report-it3.md` (histórico de 3 iteraciones)
- `cr-report.md` (con apéndice de resolución)
- `validation.md` (APROBADO)
- `done-report.md` (este archivo)

**Ramas feature**:
- `feat/wkh-335-status-estructurado` en `a2a-wkh362`
- `feat/wkh-335-error-no-opaco` en `chaski-wkh362`

Ambas lisas para merge, sin push a remoto.
