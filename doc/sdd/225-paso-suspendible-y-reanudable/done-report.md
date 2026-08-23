# Report — HU [WKH-PENDIENTE] El Coordinador orquesta un paso que espera a una persona: suspender y reanudar

**Corte A · Pipeline CERRADO**  
**Rama**: `feat/225-paso-suspendible-y-reanudable` · **SHA verificado**: `ee8a10a`  
**Fecha de cierre**: 2026-08-23

## Resumen ejecutivo

Implementado el estado suspendido de un paso del `/compose` pipeline: un paso puede devolver un enlace y quedar esperando a una persona, en lugar de terminar el request HTTP. El desenlace nuevo es aditivo en `ComposeResult` (tercer valor junto a `success: true/false`) y aislado en `/compose/resume`, una ruta nueva que reanuda desde el estado perseguido. Tabla nueva diseñada para **bdwv** con claim atómico por RPC y single-use verificado contra Postgres 16. **Pipeline cerrado en la rama** (`feat/225-paso-suspendible-y-reanudable`) con 12 ACs en PASS, 0 hallazgos bloqueantes abiertos, 5 MENORes declarados como deuda (`TD-225-01`, `TD-225-02`, `MNR-6`, `NC-1`, `NC-4`).

**⛔ ESTADO ACTUAL DE PRODUCCIÓN**: 
- **Migración NO aplicada**: La tabla `a2a_suspended_runs` **no existe en bdwv**. Todo el código de esta HU está en rama, nada corre contra la base real.
- **AC-10 implementado pero INERTE**: La clasificación de `kyc-hosted-redirect` y `legacy-single-shot-kyc` está codificada en `src/lib/capability-risk.ts`, pero `/discover` no las ve. Hace falta una **acción manual de OPS**: republicar la ficha del agente en bdwv para que `capabilities` incluya `kyc-hosted-redirect`. Ver `src/services/registry.ts:36-42` (*"COPIA MANUAL … nada la sincroniza"*).
- **No mergeada a main**: Decisión del founder (meta 2026-08-25 cerrada; fecha de corte 2026-08-31). El merge requiere además la aplicación de la migración y la acción de OPS nominada arriba.

---

## Pipeline ejecutado

- **F0**: project-context (`doc/.nexus/project-context.md`) cargado — stack, reglas, patrones heredados.
- **F1**: `work-item.md` (2026-08-19) — `HU_APPROVED` status en artefacto.
- **F2**: `sdd.md` → `SPEC_APPROVED` declarado en artefacto (SDD Mode: QUALITY, 2 focos obligatorios de AR).
- **F2.5**: `story-file.md` (story HU correspondiente, F2 → F3).
- **F3**: Implementación en 4 waves + fix-packs.
  - W0 (`e2f7609`): tipos, tabla, servicios, rutas básicas.
  - W1 (`0935b52`): tests de estructura, cierre de signature.
  - W2 (`86cd78f`): integración end-to-end, tests complejos.
  - W3 auto-blindaje (`87134bf`): documentación de errores cometidos y lecciones.
- **AR iteración 1** (2026-08-23, `ar-report.md`): **RECHAZADO con 5 BLOQUEANTEs**.
  - 2 `BLQ-ALTO` (probados contra Postgres 16 real en contenedor descartable).
  - 2 `BLQ-MED` · 1 `BLQ-BAJO` · 8 `MNR`.
  - Gates del repo: `tsc 0` · `lint 0` · `npm test 0` (verde engañoso; dos hallazgos de seguridad pasan la suite).
- **AR fix-pack** (`aa0fc13`): todos los 5 BLOQUEANTEs cerrados. Iteración 2 (2026-08-23, `ar-report-it2.md`): **APROBADO con MENORes**.
  - 0 BLOQUEANTEs nuevos.
  - 3 MENORes nuevos sobre prosa que afirma de más (ninguno toca código).
  - El arreglo del `BLQ-ALTO-1` fue **mesánico**: un `RAISE` en PL/pgSQL que rollbackeaba el `UPDATE` que venía dos líneas antes; lo descubrió ejecutando contra el motor, no leyendo.
- **CR** (2026-08-23, `cr-report.md`): **CHANGES_REQUESTED** (0 BLOQUEANTEs).
  - 4 MENORes: docblock huérfano (CR-1, movido), fee sin splits en resume (CR-2, agregado), espejo sin candalo (CR-3, test agregado), 8 identificadores en castellano (CR-4, renombrados).
  - Escala medida: 1,78× del presupuesto SDD (bajo el umbral de 2×). El exceso (producción 2,03×) atribuido al hallazgo `BLQ-ALTO-2` del AR (débito faltante en resume), que **no existía en el SDD**.
  - Gates: `tsc 0` · `lint 0` · `npm test 0`.
- **CR fix-pack** (`d11b014`): CR-1..CR-4 + `OBS-1/OBS-2` cerrados. Re-validación pendiente (inline).
- **F4 iteración 1** (2026-08-23, contra `c6f2b0f`): **RECHAZADO**.
  - Defecto de instrumento: agregó un test pero no re-derivó el conteo de archivos del README (`expected 309 to be 310`).
  - **Gate inventado**: el mensaje de `c6f2b0f` citaba `npm test 0` pero realmente salía `exit 1`.
  - Hallazgo: correr las PARTES de un gate no es correr el gate (lección preexistente del repo, re-aplicada).
- **F4 iteración 2** (2026-08-23, contra `ee8a10a`, árbol limpio): **APROBADO**.
  - 12 ACs todos en PASS con evidencia de EJECUCIÓN (no sólo cita).
  - Gate completo corrido y verificado independientemente: `tsc 0` · `lint 0` · `npm test 0` (`304 test files | 6 skipped (310)` · `6071 tests | 19 skipped (6090)`).
  - SHA: **`ee8a10a`** verificado contra árbol limpio.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `T-SUSP-1`, `T-SUSP-2` (`compose.suspend.test.ts:231,246`); la suspensión NO emite `compose_stranded_payment`. |
| AC-2 | PASS | `T-SUSP-3`, `T-SUSP-4` (`:280,326`); estado persistido en bdwv con tabla nueva (`a2a_suspended_runs`), índices, RLS. |
| AC-3 | PASS | `T-SUSP-5` (`:351`); pipeline **no** debita ni liquida steps posteriores al suspendido. |
| AC-4 | PASS | `T-TOK-*` (`resume-token.test.ts`), `T-RES-12` (`compose.resume.test.ts:290`); HMAC verificado ANTES de leer payload. |
| AC-5 | PASS | `T-RES-1/2` (`:348,366`), `T-RUN-1` (`suspended-run.test.ts:405`); single-use atómico en base, reproducido con 5 sesiones concurrentes contra Postgres 16. |
| AC-6 | PASS | `T-RES-3` (`:375`), `T-RUN-2` (`:415`), `suspended-run.ownership.test.ts` (4 tests); 404 indistinguible en 3 eslabones (SQL, service, route). |
| AC-7 | PASS | `T-RES-4` (`:396`), `T-RUN-9` (`:465`, exactamente un residuo); run vencido emite residuo UNA sola vez. |
| AC-8 | PASS | `T-RES-8/8b` (`:453,465`), `P0-3` (`e2e/compose-flow.test.ts`, route+service reales); reanudación continúa desde el índice correcto. |
| AC-9 | PASS | `describe` AC-9 (`compose.suspend.test.ts:415`); bandera ausente/vacía/falsa: comportamiento exactamente como hoy (cero filas nuevas, cero queries nuevas). |
| AC-10 | PASS | `T-CAP-1/2/3` (`capability-risk.test.ts`); `kyc-hosted-redirect` y `legacy-single-shot-kyc` clasificadas en `src/lib/capability-risk.ts`. |
| AC-11 | PASS | `T-REC-1/2/2b/2c/2d/2e/3` (`reconciliation.test.ts`); runs suspendidos/vencidos expuestos sin mezclar con `compose_settle_unknown`. |
| AC-12 | PASS | `T-RES-10/11` (`compose.suspend.test.ts:586,628`); guard anti-bucle de contratación preservado en reanudación. |

---

## Hallazgos finales

### BLOQUEANTEs

**0 ABIERTOS.** Los 5 de la ronda 1 del AR fueron cerrados en el fix-pack:

1. **`BLQ-ALTO-1`** — `UPDATE` rollbackeado por `RAISE`: **CERRADO**. El `UPDATE ... SET status='expired'` se descartaba por la transacción; solución: transición del RPC al service con `UPDATE ... WHERE status='suspended'` condicional, emisión de residuo solo si afectó fila.
2. **`BLQ-ALTO-2`** — Primer step del resume sin débito: **CERRADO**. Middleware de pago reemplazado por `requireA2AKey` (evitó $1 falso pero perdió el débito); solución: nuevo handler `debitResumedFirstStep` espejando el step-0 de `/compose`.
3. **`BLQ-MED-1`** — Techo de presupuesto reiniciado: **CERRADO**. Columna `max_budget_usdc` persistida, techo del operador sumado a gasto previo.
4. **`BLQ-MED-2`** — Query nueva corre con bandera OFF: **CERRADO**. Gate `isComposeSuspendEnabled()` en call-site; degradación a 503 si tabla no existe.
5. **`BLQ-BAJO-1`** — Precios congelados sin re-indexar: **CERRADO**. Array de precios sliceado del mismo índice que `remainingSteps`.

### MENORes — 11 aceptados como deuda en backlog

- **AR ronda 1**: 8 (`MNR-1` a `MNR-8`)
- **AR ronda 2**: 3 nuevos sobre prosa (`MNR-9`, `MNR-10`, `MNR-11`)
- **CR**: 4 (`CR-1..CR-4`, todos resueltos en el mismo commit)

**Deuda explícita declarada:**
- `TD-225-01`: Sweeper de expiración proactiva (barrido periódico de runs vencidos; hoy se detectan al reantentar).
- `TD-225-02`: Discriminar fallo de saldo de fallo de transporte en `budgetService.debit` (pide tercer estado; impacta `/compose` también).
- `MNR-6`: Guard de vencimiento sobre `resuming` (run atascado en transición; mejor cobertura con `listSuspendedRuns`).
- `NC-1`, `NC-4`: Observabilidad post-deploy (ambos se resuelven con GET `/health`).

### Huecos de cobertura del gate (preexistentes, no de esta HU)

1. **`npm run lint` no cubre `test/`** (`biome.json` include sólo `src/**`): el nuevo guardián `test/wkh225-suspended-runs.migration.test.ts:T-MIG-5` no pasa por linter.
2. **`src/routes/compose.ts` no está en `CORTE_A_PATHS`** (`cited-lines-guard`): las citas del archivo dentro de docblocks no se validan mecánicamente (cobertura: manual + CR).

---

## Auto-Blindaje consolidado

Cuatro categorías de hallazgos del F3 que la próxima HU debe evitar:

### 1. Citas de línea se corren cuando insertas en archivos *citados* (no *citadores*)

**Error**: Mover `a2a_suspended_runs` en `database.types.ts` sin saber que `CLAUDE.md` cita `:2567` (el `owner_ref` de `registries`). Ambos guardián verifican: los dos ponen rojo a destiempo.

**Causa raíz**: Story File enumera 5 archivos citadores; no enumera los citados. Buscar en `test/cited-lines-guard.citations.ts` por el *archivo que edito*, no por su contenido.

**Aplicación**: Antes de insertar, correr `grep -n "<archivo>" test/cited-lines-guard.citations.ts` — si sale hit, **insertar por debajo del ancla más baja** (re-apuntar es correcto pero suma diff).

### 2. Guardián que cruza dos lectores con criterios distintos: la prosa se atribuye al bloque anterior

**Error**: Docblock explicando por qué `a2a_suspended_runs` no vive donde la simetría lo pondría. El oráculo `tableBlocks` lee bloques enteros; el escáner lee líneas de tipo. La prosa cayó entre dos `};` y se le atribuyó a `webhooks`.

**Causa raíz**: Un guardián que **compara lectores DISTINTOS** puede ponerse rojo por prosa. Aplicar: antes de escribir comentario en `database.types.ts`, preguntarse a qué bloque lo atribuye el lector más laxo.

### 3. Archivo con excepciones escritas a mano: los números envejecen en silencio

**Error**: Líneas nuevas en `reconciliation.ts` desplazaron 6 excepciones de `ownership-filter-guard.exceptions.ts`. Sin `git diff`, son números separados de sus motivos; cambian independiente.

**Causa raíz**: Esas excepciones se escriben a mano y no se rehacen con cada edición. Derivar del árbol cada vez, no sumar.

**Aplicación**: `grep -n "\.from('"` ANTES de editar, DESPUÉS de editar; cruzar por **símbolo contenedor** (no aritmética) y **verificar que las anclas de prosa del `*.exceptions.ts` sigan siendo válidas**.

### 4. Doble parcial de módulo: consumidor nuevo = rojo en registro, no en aserción

**Error**: `POST /compose/resume` agrega `requireA2AKey` a un middleware que 3 suites ya moquean parcialmente. El resultado: 46 tests desaparecen bajo `skipped`, `Test Files 3 failed`.

**Causa raíz**: Doble parcial es contrato con lista EXACTA de exports. Agregar export nuevo rompe el doble **en tiempo de registro**.

**Aplicación**: Antes de importar nuevo símbolo en archivo muy moqueado: `grep -rn "vi.mock('.*<modulo>'"` y ver cuáles usan `importOriginal`. Mirar `Test Files`, no solo `Tests`.

### 5. Testigo medido hace la observación falsa de que `success:false` es equivalente

**Error**: Escribir testigo de "el UPDATE y el RAISE juntos hacen exactamente un residuo", pero el testigo no ejecuta SQL — midió TEXTO. La premisa era falsa; el testigo confirmaba **su intención**, no el motor.

**Causa raíz**: Testigo escrito a imagen de la implementación. Replicar lo que el código **quiso hacer**, no lo que el motor **hace**.

**Aplicación**: Antes de afirmar sobre un motor (SQL, transacciones, concurrencia), ejecutar la mutación que debería ponerlo rojo contra el motor real. Si el testigo pasa, no afirma nada.

### 6. Middleware reemplazado: evalúa por qué **hace**, no solo qué **autentica**

**Error**: `requirePaymentOrA2AKey` → `requireA2AKey` porque el primero cobraba $1 falso. Pero el primero TAMBIÉN debitaba; el segundo no. La lectura del docblock dijo "qué me ahorro", no "qué alguien más tiene que cubrir".

**Causa raíz**: Cambio de middleware evaluado por lo que AUTENTICA (idéntico), no por sus **efectos secundarios**.

**Aplicación**: Docblock del middleware viejo: buscar verbos en MAYÚSCULA (DEBITA, RESUELVE, RESUELVE-DESTINO). Preguntar: **¿quién lo cubre ahora?** Por cada verbo, rastrear un call-site.

### 7. Testigo que mide dos capas desde la punta equivocada

**Error**: Route mockea `composeService.compose` entero, service nunca ve reanudación con `scopingKeyRow`. Dinero que desaparece sin que ni ruta ni servicio lo vean.

**Causa raíz**: Dividir tests por capa (route/service) y la propiedad que importa vive **en la juntura**. Testigo vacuo en los dos extremos.

**Aplicación**: Propiedad de dinero que cruza capas → testigo en la juntura, no en las dos puntas. Pregunta: *"¿qué mock tendría que sacar para que este test pudiera fallar?"* Si la respuesta es "el del módulo que hace lo que afirmo", el test no lo afirma.

### 8. Afirmación universal sobre un parser, probada con 1 input

**Error**: Docblock afirma que `T-MIG-5` "generaliza" el control de transiciones en SQL. Probado contra dos inputs. El AR extrajo el parser a script y lo mutó: **2 variantes pasan en VERDE con el defecto**. Un `IF` anidado escondía el bug; un `UPDATE` al nivel superior era invisible.

**Causa raíz**: Verificación contra los 2 inputs que motivaron el control. De 2/2 deduje UNIVERSAL. Peor: el propio fix-pack introdujo el `IF` anidado inmediatamente después.

**Aplicación**: Antes de escribir "generaliza" en docblock de un parser, construir una variante que el parser DEBERÍA cazar y que **no se parezca** al original. Si no puedo construirla, escribir alcance acotado.

### 9. Prosa que afirma disposición de valor, escrita desde la intención

**Error**: (1) `ResumeStep0Debit.rejected` se documenta como "la base lo rechazó, nada aplicado". Pero `budgetService.debit` sale de `catch` — un timeout POSTERIOR al commit produce el MISMO valor. (2) `MNR-6` justifica un guard diciendo que sin él "un claim concurrente marcaría `expired` un run en ejecución". El propio fix de BLQ-ALTO-1 (3 horas antes) volvió eso falso.

**Causa raíz**: (1) Escribir la intención en lugar de lo que el shape permite. (2) No barrer la prosa cuando el fix que escribí la invalida.

**Aplicación**: (1) Toda disposición (`nada aplicado`, `ya cobrado`) necesita que el productor pueda distinguir "no pasó" de "no pude preguntar". Si sale de `catch` o error HTTP, **no puede**. (2) Cuando un fix mueve DÓNDE ocurre algo, buscar justificaciones que se apoyaban en la ubicación vieja.

### 10. Leer archivo con herramienta interceptada produce falsos correctos

**Error**: `cat -n` sobre archivo para copiar un bloque. La salida no tiene los comentarios internos, pero se ve plausible. El reemplazo falla silenciosamente.

**Causa raíz**: `cat` está interceptado por proxy de tokens; salida es RESUMEN.

**Aplicación**: Leer siempre con `sed -n 'A,Bp'` o `/usr/bin/cat`. Y el `replace` que no encuentra su ancla tiene que ROMPER, no ser no-op.

### 11. Divergencia latente que ningún test detecta, apagada por config default

**Error**: `/compose/resume` copia el bloque de fee sin splits ni recibo. Con `SPLIT_BPS_CREATOR>0` (NO default), un run reanudado paga 100% del fee a plataforma y deja filas `skipped`. Con default (0/0), **ninguna diferencia observable**.

**Causa raíz**: Copiar bloque del money-path quedándose con lo que el caso de prueba ejercita. El comentario invita a leer paridad donde no la hay.

**Aplicación**: Toda vez que un docblock diga "igual que en X" — o hay control que lo sostiene, o no se escribe. Antes de simplificar bloque de money-path, preguntar: **¿con qué configuración se vuelve observable lo que borré?** Si la respuesta es "config NO-default", el test corre con ESA config.

### 12. Inventario de correspondencia en prosa es candado que se pudre solo

**Error**: Cinco viñetas en docblock listando "LO QUE SE ESPEJA DE `/compose`, LÍNEA POR LÍNEA". Pruebas de correspondencia: cero. La lista es cierta hoy; se vuelve falsa sin que nadie la edite.

**Causa raíz**: Documentar equivalencia es **creer** que la documenta. No lo es: la lista es cierta el día que se escribe.

**Aplicación**: N viñetas en docblock = N aserciones sin escribir. Candidato: `test/payment-guards-live-in-one-place.test.ts` (patrón existente; `test/wkh225-resume-step0-mirrors-compose.test.ts` lo aplica acá).

### 13. Docblock desplazado por inserción MÍA queda huérfano de su símbolo

**Error**: JSDoc de `RESUME_CLAIM_HTTP` (166 líneas de distancia) por inserción de dos funciones en el medio. TypeScript ata el **último** docblock al símbolo; las 13 líneas quedan invisibles.

**Causa raíz**: Citas rotas por tu propia edición, en forma de **desplazamiento**. El diff de esas líneas es CERO; ningún barrido lo caza.

**Aplicación**: Al insertar función entre docblock y símbolo, mirar **qué quedó arriba**. Señal barata: dos `*/` seguidos sin código en el medio.

### 14. Message de commit que cita un gate no corrido apaga revisiones

**Error**: (F4-it1) Commit `c6f2b0f` cita `npm test 0` pero realmente `exit 1` (2 fallos, fila `expected 309 to be 310`). El gate falso pasa por medida a través de AR y CR.

**Causa raíz**: Dos pasos de la terna `tsc/lint/test` corridos, el tercero rellenado de memoria. `npm test` es el paso que muta el conteo de archivos → ese número sólo aparece si lo corriste.

**Aplicación**: TODO commit que agregue/borre archivo bajo `test/` o `.test.ts` tiene que correr la terna **entera**. Si citas un gate, esa corrida tiene que ser **posterior al último cambio**. AR/CR: correr gate contra el HEAD que revisaw.

---

## Archivo de cambios modificados

**Producción** (`src/` no-test + `supabase/`):
- `src/types/index.ts` (+78 líneas, tipos nuevos)
- `src/types/database.types.ts` (+95 líneas, tabla generada)
- `src/lib/resume-token.ts` (+464 líneas, módulo LEAF de firma)
- `src/services/compose.ts` (+228 líneas, estado suspendido en pipeline)
- `src/services/suspended-run.ts` (+442 líneas, módulo de servicios)
- `src/services/reconciliation.ts` (+182 líneas, queries nuevas)
- `src/routes/compose.ts` (+673 líneas, rutas nuevas + fix-pack)
- `supabase/migrations/20260823000000_wkh225_suspended_runs.sql` (+314 líneas, tabla + RPC)

**Tests** (`src/**/*.test.ts` + `test/`):
- `src/lib/resume-token.test.ts` (+380 líneas, 18 tests)
- `src/services/suspended-run.test.ts` (+483 líneas, 13 tests)
- `src/services/suspended-run.ownership.test.ts` (+164 líneas, 4 tests)
- `src/services/compose.suspend.test.ts` (+1014 líneas, 20 tests)
- `src/routes/compose.resume.test.ts` (+817 líneas, 36 tests)
- `test/wkh225-suspended-runs.migration.test.ts` (+265 líneas, 13 tests)
- `test/wkh225-resume-step0-mirrors-compose.test.ts` (+98 líneas, 10 tests)
- `test/e2e/compose-flow.test.ts` (+50 líneas, 5 tests)

**Modificaciones preexistentes** (scope OUT, correcciones de dobles):
- `src/routes/compose.ts` (agregar `requireA2AKey` a 3 dobles de middleware)
- `test/` (completar 5 factories de mocks)

**Configuración**:
- `.env.example` (+11 líneas, 3 variables nuevas)
- `README.md` / `README.es.md` (+2 líneas, números re-derivados)

---

## Decisiones diferidas a backlog

### No completadas en el Corte A (scope OUT, bloqueantes del Corte B)

1. **Ítem 6b** — Acción de OPS: Republicar ficha de agente en bdwv. Necesario para que `/discover` vea `kyc-hosted-redirect`. **AC-10** lo documenta (clasificación de riesgo); la acción manual se menciona en `doc/sdd/225-…/work-item.md:312-313`.

2. **Ítem 7** — `resolvePayoutAuthority` + `payout/prepare`. Bloqueante: decisión (a)/(b) del `decisionToken` no tomada. Trabajo en el otro repo (`chaski-v3`).

3. **Ítem 8** — Agente cobra por step hosted-redirect. Bloqueado por ítem 7 + Chaski.

### Deuda técnica (ABIERTA, nominalizada)

- **`TD-225-01`**: Sweeper de expiración de runs vencidos.
- **`TD-225-02`**: Discriminar saldo ∖ transporte en `budgetService.debit`.
- **`MNR-6`**: Guard de vencimiento sobre `resuming` (cobertura mejor con `listSuspendedRuns`).
- **`NC-1`, `NC-4`**: Observabilidad de post-deploy (`GET /health`).

---

## Lecciones para próximas HUs

1. **Una lista de correspondencias a mano es un candado que se pudre solo** — si dos sitios tienen que moverse juntos y la única protección es prosa, van a divergir. La respuesta es un test (patrón: `test/payment-guards-live-in-one-place.test.ts`, aplicado aquí como `test/wkh225-resume-step0-mirrors-compose.test.ts`).

2. **Testigo probado contra 2 inputs y afirmado como universal**: falso. Si el docblock dice "generaliza", construir una mutante que lo debería cazar y que no se parezca al original. Sin eso, escribir alcance acotado.

3. **Prosa que afirma disposición (nada aplicado, ya cobrado)** requiere que el tipo distinga "no pasó" de "no pude preguntar". Si sale de `catch` o error HTTP, **no puede**. Documentar con el shape que realmente tienes.

4. **Correr las PARTES de un gate no es correr el gate** — `tsc + lint` ciegos a cambios bajo `test/`. Si citas un gate en el commit, esa corrida tiene que ser ENTERA y **posterior** al cambio.

5. **Guardián que cruza dos lectores con criterios distintos**: la prosa se atribuye al bloque anterior. Antes de escribir comentario en archivo que un guardián parsea, preguntar a qué bloque lo atribuye el lector **más laxo**.

---

## Verificación final

| Item | Resultado |
|------|-----------|
| Gate completo (tsc/lint/test) | ✅ PASS @ `ee8a10a` |
| 12 ACs | ✅ PASS (12/12) |
| Ownership filter guard | ✅ PASS (13/13) |
| Cited lines guard | ✅ PASS (G-F1 / G-F2) |
| Readme numbers re-derived | ✅ 309 / 189 / 508 |
| Árbol limpio | ✅ `git diff HEAD --stat` vacío |
| Auto-blindaje consolidado | ✅ 14 categorías |

---

## Entregas finales

- **Rama**: `feat/225-paso-suspendible-y-reanudable` · **SHA**: `ee8a10a`
- **Estado**: DONE (pipeline cerrado en rama, **NO mergeada a main**)
- **Deuda nominal**: 5 items (`TD-225-01/02`, `MNR-6`, `NC-1/4`)

### Pre-requisitos para merge a main

**⚠️ El merge requiere tres acciones antes de que la HU se considere lista para producción:**

1. **Aplicar migración a bdwv**: `supabase/migrations/20260823000000_wkh225_suspended_runs.sql`
   - Crea tabla `a2a_suspended_runs` con índices, RLS y RPCs
   - Actualmente la tabla NO existe en bdwv
   
2. **Acción de OPS**: Republicar ficha del agente en bdwv
   - Necesario para que `/discover` vea `kyc-hosted-redirect` en el manifiesto del agente de KYC
   - Ubicación del paso manual: `src/services/registry.ts:36-42` (textual: *"COPIA MANUAL … nada la sincroniza"*)
   - AC-10 implementado en código, pero inerte en prod sin esta acción

3. **Fecha de corte**: 2026-08-31 (dura, merge esperado post-incubadora; meta blanda 2026-08-25)

