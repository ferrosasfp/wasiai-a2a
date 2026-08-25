# AR Report — WKH-335 (#226) · Adversarial Review

**Veredicto: RECHAZADO — 1 BLOQUEANTE-BAJO activo.** 1 BLQ-BAJO · 6 MENORes · 0 BLQ-ALTO · 0 BLQ-MEDIO.

> ⚠️ **Procedencia de este archivo.** El agente de AR entregó el reporte completo en su respuesta
> y NO lo escribió en disco. Lo materializó el orquestador, verbatim salvo esta nota. Un reporte
> declarado que no existe en disco es un artefacto fantasma: el siguiente rol lo cita y nadie
> puede abrirlo.

## Gates ejecutados por el AR (corridos, no citados)

| Repo | Gate | Resultado |
|---|---|---|
| `wasiai-a2a` | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` | tsc **0** · lint **0** (503 files) · `Test Files 298 passed \| 6 skipped (304)` · `Tests 5961 passed \| 19 skipped (5980)` |
| `chaski-v3` | `npm run qa` → `npm run build` | qa **exit 0** (lint 278 files, `154 passed (154)` / `3059 passed (3059)`) · build **exit 0** |

Los números publicados que el Dev sincronizó (304 archivos de test, 503 de lint) se re-derivaron de
la salida de los gates, no del README.

## Ataque 1 — ¿El test que certifica puede pasar con el campo ausente? **NO** (verificado por mutación)

11 mutantes: **10 killed, 1 survived.** Arnés: copia previa a scratchpad, restauración por `cp`,
verificación de md5. ⛔ Nunca `git checkout --`.

| # | Mutante | Sitio | Resultado | Testigos |
|---|---|---|---|---|
| M1 | borrar `...agentFailureResult(err)` | `compose.ts:1218` | **KILLED** | `T-335-DIRECT-4XX`, `-5XX`, `-NOLEAK` |
| M2 | borrar `...agentFailureResult(retryErr)` | `compose.ts:1183` | **KILLED** | `T-335-RETRY`, `-RETRY-5XX` |
| M10 | rellenar la ausencia con `'AGENT_ERROR'` | `agentFailureResult` | **KILLED** | `T-335-ABSENT` |
| M11 | `{ agentFailure: undefined }` (clave presente) | `agentFailureResult` | **KILLED** | `T-335-ABSENT` |
| M4 | borrar la rama nueva del leg de quote | `quote/route.ts:173-174` | **KILLED** | `T-335-Q-1`, `-Q-2` |
| M5 | borrar la rama nueva del leg de payout | `prepare/route.ts:434-435` | **KILLED** | `T-335-P-1`, `-P-2` |
| M6 | guard de VALOR → guard de TIPO | `readAgentFailure` | **KILLED** | `T-335-GW-3` |
| M7 | borrar el sitio 2 (`200 + success:false`) | `gateway-client.ts:375-378` | **KILLED** | `T-335-GW-2` |
| M8 | borrar el sitio 1 (`readFailureFields`) | `gateway-client.ts:264` | **KILLED** (6 tests, 3 archivos) | `GW-1/3`, `Q-1/2`, `P-1/2` |
| M3/M9 | borrar el guard `code === "step_failed"` del leg de quote | `quote/route.ts:173` | 🔴 **SOBREVIVE** | — (MNR-2) |

**La disjunción declarada por el Dev es CIERTA, verificada de forma independiente**:
`{DIRECT-4XX, DIRECT-5XX, NOLEAK}` ∩ `{RETRY, RETRY-5XX}` = ∅. CD-6 está realmente cerrado.

**Evidencia rojo/verde (AC-5)**: el rojo son 5 `AssertionError: expected undefined to be '<valor>'`
—la aserción, no un import roto— y el conteo recolectado es **112 en las dos corridas**.
`T-335-ABSENT` y `-BACKCOMPAT` no fallan en rojo (son candados de regresión) y M10/M11 prueban que
hoy no son vacuos.

## Ataque 2 — La clasificación y el defecto INVERTIDO. **OK**

`classifyAgentFailure` es `status === 400 || status === 422 ? 'INPUT_REJECTED' : 'AGENT_ERROR'`,
allow-list literal. **No se pudo construir ningún status que caiga en el bucket equivocado.**

- 402 (saldo nuestro), 401/403 (credencial nuestra), 404 (`invokeUrl` viejo) → `AGENT_ERROR`, con
  los pares que discriminan testeados (399/400, 422/423, 429/500) — CD-17 cumplido.
- 3xx: `!response.ok` los captura; `classifyAgentFailure(302)` → `AGENT_ERROR`.
- Status ausente / `fetch` que tira antes de tener status → `{}`, clave omitida. M10/M11 lo candan.
- En Chaski el 402 no puede disparar la rama nueva: `mapErrorStatus(402)` → `payment_required` ≠
  `step_failed`. `T-335-P-4` lo mide (CD-5 preservado).
- **Camino REAL de producción, que ningún test cross-repo cubre**: `/compose` devuelve **400** para
  un fallo de pipeline (`routes/compose.ts:1112-1128`) ⇒ Chaski entra por el **sitio 1** (`!res.ok`)
  y `mapErrorStatus(400, body)` da `step_failed` sólo si `body.success === false`
  (`gateway-client.ts:277-280`), que es lo que el sobre trae. La cadena cierra.
- Un `422 → regen → ECONNRESET` deja el campo **ausente**: consecuencia declarada y correcta.

## Ataque 3 — El falso verde del árbol. **No son dos familias: son SIETE**

El auto-blindaje dice *"al menos dos familias derivan del índice de git"*. Es un piso correcto que se
queda 4x corto. Medido con `grep -o "ls-files"`:

```
test/readme-numbers.test.ts · test/sdd-index-matches-folders.test.ts
test/test-files-are-run-in-ci.test.ts · test/scripts-imported-by-tests-are-tracked.test.ts
test/docs-referenced-by-code-exist.test.ts · test/ownership-filter-guard.test.ts
test/cited-lines-guard.test.ts · src/__tests__/discover-callsites.test.ts
```

⚠️ **Consecuencia que excede esta HU**: `ownership-filter-guard` también deriva del índice ⇒ un
`src/services/*.ts` **nuevo y untracked** con una query sin `.eq('owner_ref', …)` **pasa el guard de
ownership en silencio**. No es defecto de esta HU (acá todo está staged y se re-corrió verde), pero
es la generalización correcta de la lección del Dev.

**Estado actual**: correcto. Re-corridas las 5 familias con el `cr-report.md` untracked presente:
`PASS (46) FAIL (0)`.

## Ataque 4 — Los dos sitios de cada repo. **OK, los cuatro cableados con testigo propio**

- `compose.ts`: barridos **todos** los `return` con `success:false` dentro del `catch (err)` de
  `:733` — son exactamente dos (`:1164` retry, `:1204` directo). No hay un tercero sin cablear.
- `gateway-client.ts`: sitio 1 (M8), sitio 2 (M7). Testigos distintos.
- `/orchestrate` hereda el campo **por referencia**: `const pipeline = await composeService.compose(…)`
  (`orchestrate.ts:1359`) y `pipeline,` (`:1685`). Los tres `pipeline: {…}` armados a mano (`:418`,
  `:1226`, `:1317`) son early-returns anteriores a compose.
  ⚠️ **CORRECCIÓN DEL ORQUESTADOR**: el AR concluyó de acá que *"la frase del doc se sostiene"*.
  Verifica la HERENCIA, no las otras dos afirmaciones de esa frase, y el CR demostró que las dos son
  falsas (status 200, no 400; y el campo va anidado bajo `pipeline`). Ver `cr-report.md` BLQ-BAJO-1,
  confirmado por el orquestador leyendo `orchestrate.ts:245-249`.

## Ataque 5 — Fuga. **OK**

Campo = unión cerrada de dos strings, no puede ecoar nada por construcción. Body de Chaski con
exactamente una clave, medido por `T-335-Q-2` / `T-335-P-2`. `logGatewayFailure` emite
`{step, gatewayCode, reason, agentFailure, httpStatus}` y **no** `message`. Cero `any`, cero
`as unknown as`, cero casts nuevos.

Pre-existente y fuera de scope: `result.error` sigue conteniendo hasta 300 caracteres del body crudo
del agente (CD-9 lo exige byte-idéntico); es server-only por contrato y esta HU no lo cambia.

## Ataque 6 — Las 3 desviaciones de scope. **Forzadas, no expansión**

`test/cited-lines-guard.citations.ts` (2 números + 1 prosa; sin eso `npm test` queda rojo) y
`README.md`/`README.es.md` (4 números re-derivados de los gates: 304 y 503, exactos).

**Wave 2 toca 25 archivos y la tabla declara 9.** Los 14 extra verificados uno por uno con
`git diff -U0`: **ninguno tiene cambio ejecutable**. Los de `flow.tsx` y `container.test.ts` figuran
como líneas de código por edición línea-neutra (comentario colgado del final de una línea);
`flow.tsx` tiene **4421 líneas antes y después**.

## Ataque 7 — La trampa del `expect`. **No cayó, y la razón sigue siendo cierta**

`flow-vm.test.ts:1054` sigue siendo `expect(humanError("step_failed")).toBe("Algo salió mal. Intentá
de nuevo.")`, intacto; sólo cambió el comentario, que habría quedado falso. Verificado contra el
código: ninguna de las dos rutas devuelve nunca `step_failed` en el body.

**Bonus**: la cadena del payout cierra hasta la pantalla. `prepare_agent_rejected` ∈
`PREPARE_REJECTION_ENUMS` → `flow.tsx:1772` → *"rechazó esta remesa antes de que firmaras nada: no se
movió ningún USDC"*. La afirmación de dinero **sigue siendo cierta** con el productor nuevo: prepare
corre antes del depósito.

---

## BLOQUEANTES

### 🔴 BLQ-BAJO-1 — Integration / Scope Drift — cita rota POR esta HU que ningún guard cubre (viola CD-12)

**`chaski-v3/src/composition/container.test.ts:441`**

Reproducción:
```bash
cd /home/ferdev/.openclaw/workspace/chaski-wkh362
git show HEAD:src/application/agent-rejections.test.ts | sed -n '115p'   # el bloque citado, en HEAD
sed -n '115p'  src/application/agent-rejections.test.ts   # → otro describe, otra función
sed -n '140p'  src/application/agent-rejections.test.ts   # → acá vive hoy la cita recíproca
```

**Causa**: `T-335-AR-1` insertó **+21 líneas** en `agent-rejections.test.ts:71`, o sea ARRIBA de la
cita. `115 → 136` (bloque) / `119 → 140` (línea).

**Por qué nadie lo cazó** (accionable para el Architect):
1. La cita está en formato **SUELTO** (sin ancla `(símbolo, ruta:NN)`) ⇒ es el **agujero declarado
   #1** de `citas-ancladas.test.ts`. El verde `9 passed` no dice nada de ella.
2. El barrido que prescribe **W2.2.7** es ciego a este caso: su regex es
   `[a-z0-9./-]*(gateway-client|agent-rejections)\.ts:[0-9]{1,4}` y en `agent-rejections.test.ts`
   después de `agent-rejections` viene `.test.ts`, así que `\.ts:` **no matchea**. La receta no
   podía encontrarla ni corriéndola bien. Necesita `(\.test)?\.tsx?:`.

**Impacto**: el comentario es un candado en prosa (*"⛔ No los 'subas' sin re-medirla"*) que hoy
manda a un `expect` sin relación. El arreglo es **un número**.

**Barrido completo del AR** (para que el fix-pack no adivine el alcance): mapa
`línea_vieja→línea_nueva` por archivo desde `git diff -U1000000`, cruzado contra los 25 archivos
modificados ⇒ **15 candidatas, 14 falsos positivos, 1 real**. Las 14 son ediciones línea-neutra, más
un caso simpático: `prepare/route.test.ts:1440` citaba `route.ts:396` estando **off-by-one en HEAD**,
y el `+1` de esta HU la dejó apuntando **exacto**.

---

## MENORes

**MNR-1 · Test Coverage — `T-335-NOLEAK` es tautológico.** 5 de sus 6 asserts no pueden fallar: el
sujeto es `JSON.stringify(result.agentFailure)`, cuyo valor sólo puede ser `"INPUT_REJECTED"` o
`"AGENT_ERROR"`, y un string de 15 caracteres no puede contener `https://example.com/invoke` ni
`sk-live-SUPERSECRET`. El único assert con poder duplica `T-335-DIRECT-4XX`. **La forma la dictó el
Story File §9.1**, así que es deuda del F2.5, no del Dev. ⇒ **QA no debe citar `T-335-NOLEAK` como
evidencia independiente de AC-3**; AC-3 lo garantiza el **TIPO** del campo, que es más fuerte.

**MNR-2 · Test Coverage — el guard `code === "step_failed"` del leg de COTIZACIÓN no tiene testigo.**
`chaski-v3/app/api/a2a/quote/route.ts:173`. Mutante M9 contra la suite COMPLETA: borrar
`r.code === "step_failed" && ` deja `154 passed` / `3059 passed`. Su gemelo del payout **sí** tiene
testigo (`T-335-P-4`) y ahí el mismo mutante muere. §9.4 sólo pidió el del payout: la asimetría viene
del F2.5. Sugerencia: el gemelo de `T-335-P-4` en `quote/route.test.ts`.

**MNR-3 · Integration — cita cross-repo FALSA en el docblock normativo del clasificador.**
`wasiai-a2a/src/lib/agent-http-error.ts`, fila `400`: cita
`chaski-v3/src/application/agent-rejections.ts:24-30`, que es el bloque *"DOS LISTAS, Y NO ES
BUROCRACIA"* y no menciona `400` ni `fx_amount_*`. La evidencia real vive en **`:10-15`**, y esas
líneas **no se movieron**. El número salió del Story File y el Dev lo copió sin abrir el destino.
**Agravante**: es una cita `wasiai-a2a → chaski-v3`; **ningún guard de ninguno de los dos repos puede
verificarla jamás**. Sugerencia: `:10-15`, o mejor, transcribir el par de líneas medido.

**MNR-4 · Data Integrity — cero commits en las dos ramas; Wave 2 entera fuera del índice.**
`git rev-list main..HEAD` = **0** en los dos repos. El staging de Wave 1 es correcto y necesario
(7 familias de guards derivan del índice). Lo reportado es otra cosa: los 25 archivos / 709 líneas de
`chaski-v3` están en ` M` **sin `git add`** ⇒ un `git checkout .` los borra sin red. Y **CD-12/CD-15
dicen literalmente "en el mismo commit"**, y hoy no hay commit al que referirse.

**MNR-5 · Scope Drift (documentación) — la fila 226 del `_INDEX.md` nació con citas que esta HU
volvió falsas.** `wasiai-a2a/doc/sdd/_INDEX.md:218` cita `prepare/route.ts:391` (el propio Story File
lo declara incorrecto: es `:400`) y `compose.ts:1178-1190` / `:1146-1159`, hoy `:1204-1221` /
`:1164-1181`. El estado sigue diciendo *"in progress (F1 escrito)"*. Para `nexus-docs` en el cierre.

**MNR-6 · Test Coverage — deuda PRE-EXISTENTE medida y descartada, para que nadie la re-barra.**
Wave 1 inserta +18 líneas arriba de `compose.ts:163` y +5 arriba de `compose.test.ts:17`,
desplazando **17 citas sueltas** de 9 archivos. **8 inspeccionadas a mano contra HEAD: las 8 YA
ESTABAN ROTAS ANTES.** Ej.: `reputation.ts:18` cita `compose.ts:278` y en HEAD `:278` ya era
`if (strandedSteps.length === 0) return;`. Es el fenómeno *"candados que se pudren solos"*, no un
hallazgo contra el Dev.

---

## Sospecha declarada (NO es hallazgo)

`chaski-v3/src/presentation/flow-vm.ts:749` afirma *"RE-MEDIDO en el árbol de este commit … 24
ocurrencias a 10 destinos, de `:1145` a `:1377`"*. El Dev remapeó `+7` los tres números heredados en
vez de re-medir, y la frase sigue diciendo "re-medido en el árbol de este commit". El AR intentó
re-derivarlo y obtuvo **34 ocurrencias a 15 destinos, rango 750-1747**, pero no puede demostrar que su
instrumento sea el del autor. **No se cuenta como hallazgo**: un número que no se reproduce con el
instrumento del autor no prueba que el número esté mal.

---

## Las 11 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | Security | **OK** |
| 2 | Error Handling | **OK** |
| 3 | Data Integrity | **MNR-4** |
| 4 | Performance | **N/A** — cero I/O, cero queries, cero loops nuevos |
| 5 | Integration | **BLQ-BAJO-1**, **MNR-3**, **MNR-5** |
| 6 | Type Safety | **OK** — cero `any`, cero casts nuevos, `tsc` limpio en los dos repos |
| 7 | Test Coverage | **MNR-1**, **MNR-2**, **MNR-6** — 11 mutantes, 10 killed, 1 survived |
| 8 | Scope Drift | **OK** |
| 9 | Destructive Migrations | **N/A** — cero `.sql`, el diff no toca `migrations/` |
| 10 | RPC `SECURITY DEFINER` | **N/A** — ningún `supabase.rpc(...)`; ownership-guard verde 13/13 |
| 11 | Cache Invalidation | **N/A** |

**Veredicto final: RECHAZADO (1 BLOQUEANTE-BAJO activo).**

Dicho sin hedging: **la implementación es sólida.** Los dos sitios de cada repo están cableados con
testigos disjuntos verificados de forma independiente, la trampa del `expect` no se activó, la
clasificación no tiene ningún status en el bucket equivocado, no se encontró ninguna fuga, y los dos
gates completos están verdes corridos por el AR en orden. Lo único que bloquea es un número en un
comentario, en el agujero exacto que el Story File le dijo al Dev que no existía.
