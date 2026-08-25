# AR — iteración 2 (re-AR del fix-pack) · WKH-335

- **Fecha**: 2026-08-25
- **Alcance**: SÓLO el fix-pack y el daño colateral que el fix-pack pueda haber causado.
  La implementación original la barrió la iteración 1 (`ar-report.md`); no se repite.
- **Árboles medidos**:
  - `wasiai-a2a` — `/home/ferdev/.openclaw/workspace/a2a-wkh362`, `feat/wkh-335-status-estructurado`, `ffeee10`
  - `chaski-v3` — `/home/ferdev/.openclaw/workspace/chaski-wkh362`, `feat/wkh-335-error-no-opaco`, `b724068`
- **Herramienta**: `/usr/bin/git` con ruta absoluta en todo el barrido (`rtk` trunca el diff).

## Veredicto

**RECHAZADO — 3 BLOQUEANTE-BAJO activos.**

Dicho sin hedging: **el fix-pack hace lo que dice hacer en lo que importa.** El testigo nuevo es real
y lo reproduje con el mutante, los dos gates completos están verdes corridos por mí en orden, la
herencia del campo y la clasificación resistieron cada verificación, y el daño colateral que el
propio fix-pack se cazó (`quote/route.ts:131`) está bien arreglado. Lo que bloquea son tres
afirmaciones falsables que salieron falsas — dos escritas POR el fix-pack, mientras arreglaba
hallazgos de la misma clase.

| ID | Sev | Categoría | Archivo:línea |
|---|---|---|---|
| `BLQ-BAJO-1` | BLOQUEANTE-BAJO | Integration / prosa de contrato público | `wasiai-a2a/doc/INTEGRATION.md:1043` |
| `BLQ-BAJO-2` | BLOQUEANTE-BAJO | Integration / evidencia | `wasiai-a2a/src/lib/agent-http-error.ts:54` |
| `BLQ-BAJO-3` | BLOQUEANTE-BAJO | Test Coverage / citas sueltas | 8 sitios en los dos repos (tabla abajo) |
| `MNR-1` | MENOR | Integration / prosa | `wasiai-a2a/doc/INTEGRATION.md:1043` (el *"only answers"* de `/orchestrate`) |

---

## Blanco 1 — la prosa nueva de BLQ-1, afirmación por afirmación

La fila nueva vive en `doc/INTEGRATION.md:1043` (verificado: es la línea 1043 en HEAD, y el `+1` del
diff la insertó ahí, así que las citas `INTEGRATION.md:1043` del `auto-blindaje.md` y del `cr-report.md`
apuntan bien).

### Lo que verifiqué CIERTO, y con qué

| # | Afirmación de la fila | Medido en | Veredicto |
|---|---|---|---|
| 1 | `/compose` pone `agentFailure` en el **top level** del sobre | `src/routes/compose.ts:1118-1121` — `reply.status(status).send({ ...result, requestId })`, y `result` es el `ComposeResult` | **CIERTO** |
| 2 | Cuando `agentFailure` está presente, `/compose` contesta **400** | los DOS `return` que lo emiten (`src/services/compose.ts:1184` y `:1220`) no setean `errorCode` ⇒ `src/routes/compose.ts:1112` deja `status = 400` | **CIERTO** |
| 3 | `/orchestrate` embebe el `ComposeResult` ENTERO bajo `pipeline` | `src/services/orchestrate.ts:1685` (`pipeline,` es el objeto que devuelve `composeService.compose`, asignado en `:1359`) | **CIERTO** |
| 4 | El campo llega como `pipeline.agentFailure`, **nunca top-level** | `OrchestrateResult` (`src/types/index.ts:1554`) no declara `agentFailure`; las dos rutas mandan `{ kiteTxHash, ...result }` | **CIERTO** |
| 5 | Un fallo de pipeline en `/orchestrate` contesta **200** | `src/routes/orchestrate.ts:244-248` — `SCOPE_DENIED ? 403 : CONTRACTING_LOOP_DETECTED ? 400 : 200`. Ni `SCOPE_DENIED` ni el bucle se setean en las ramas con `agentFailure` | **CIERTO** |
| 6 | **Vale para el gemelo `/execute`** | `src/routes/orchestrate.ts:877-882` — mapeo BYTE-IDÉNTICO. `/execute` está bajo el mismo prefijo `/orchestrate` (`src/index.ts:364`), así que la fila lo cubre | **CIERTO** |
| 7 | `INPUT_REJECTED` = 400 y 422; `AGENT_ERROR` = cualquier otro no-2xx | `src/lib/agent-http-error.ts:91` — `status === 400 \|\| status === 422 ? 'INPUT_REJECTED' : 'AGENT_ERROR'` | **CIERTO** |
| 8 | El campo está AUSENTE cuando no hubo status HTTP del agente (red, DNS, timeout, SSRF, bucle, mapeo) | `AgentHttpError` se construye en **un solo sitio** de todo el repo: `src/services/compose.ts:1792`, dentro de `if (!response.ok)`. SSRF tira `Error` plano en `:1705`, el bucle en `:1753`, el fallo de mapeo retorna en `:513` sin pasar por el catch | **CIERTO** |
| 9 | Ausente cuando un retry adaptativo reemplazó el veredicto | `src/services/compose.ts:1184` usa `retryErr` (la variable de ESE catch), no `err` | **CIERTO** |
| 10 | *"no HTTP status changed to carry it"* | `src/routes/compose.ts` y `src/routes/orchestrate.ts` **no están en el diff** (`git diff --stat 4000a8f ffeee10`) | **CIERTO** |

**Sobre la AUSENCIA**: la regla que la fila enuncia (*"absent when there was no HTTP status from the
agent at all"*) es unidireccional y se sostiene. La lista entre paréntesis es ilustrativa y omite
otros casos de ausencia (scope denegado, cap de destino, fallo de settle), pero ninguno la
contradice: en todos ellos tampoco hubo no-2xx del agente. **No es hallazgo.** El `⟺ → ⇒` de
`src/types/index.ts:1276-1284` (MNR-2 CR) está bien hecho y además declara el contraejemplo del
retry, que es lo que hacía falso al bicondicional.

### `BLQ-BAJO-1` · La fila afirma que un fallo de pipeline de `/compose` *"is still a `400`"*, y es falso

- **Categoría**: Integration (contrato público publicado).
- **Archivo:línea**: `wasiai-a2a/doc/INTEGRATION.md:1043` — *"**`/compose`** puts `agentFailure` at
  the **top level** of the envelope and a pipeline failure is still a **`400`**"*.
- **Qué está mal**: `/compose` **no** contesta 400 para todo fallo de pipeline. `src/routes/compose.ts:1112-1117`:

  ```
  1112  let status = 400;
  1113  if (result.errorCode === 'SCOPE_DENIED') {
  1114    status = 403;
  1115  } else if (result.errorCode === 'DEST_CAP_EXCEEDED') {
  1116    status = 402;
  1117  }
  ```

  Los dos `errorCode` se setean **mid-pipeline**, o sea son fallos de pipeline de pleno derecho:
  `src/services/compose.ts:423` (`errorCode: 'SCOPE_DENIED'`) y `src/services/compose.ts:667-668`
  (`errorCode: 'DEST_CAP_EXCEEDED'`).
- **Reproducción**: `POST /compose` con un `x-a2a-key` cuyo `allowed_registries` excluye el registry
  del step 1, y un step 0 que sí pasa. El pipeline aborta en el step 1 con
  `errorCode: 'SCOPE_DENIED'`.
  **Esperado según la fila**: `400`. **Real**: `403` (`src/routes/compose.ts:1114`).
  Segundo input: un pipeline que excede el cap por destino mid-pipeline ⇒ **`402`**.
- **Impacto**: es la MISMA clase de defecto que BLQ-1 (una generalización sobre el status de una
  superficie, escrita sin abrir su handler), en la MISMA fila. La asimetría lo delata: la fila
  enumera exhaustivamente las dos excepciones de `/orchestrate` (*"only answers 403 for SCOPE_DENIED
  and 400 for a contracting loop"*) y no enumera ninguna de `/compose` — que tiene **más**. Un
  cliente que siga el consejo de la fila (*"branch on the field, not on the status"*) queda a salvo;
  uno que tome la frase de status al pie de la letra trata un `402`/`403` de `/compose` como
  imposible.
- **Sugerencia**: acotar la frase al caso del que habla la fila (*"a failure that carries
  `agentFailure` is a `400`"*) o enumerar las dos excepciones de `/compose` como ya se enumeran las
  de `/orchestrate`. Cero código.

### `MNR-1` · El *"it only answers…"* de `/orchestrate` es absoluto y `/orchestrate/execute` lo desmiente

- **Archivo:línea**: `wasiai-a2a/doc/INTEGRATION.md:1043` — *"it only answers `403` for
  `SCOPE_DENIED` and `400` for a contracting loop"*.
- **Medido**: bajo el prefijo `/orchestrate` (`src/index.ts:364`) vive también `POST
  /orchestrate/execute`, que contesta además `409 QUOTE_STALE` (`src/routes/orchestrate.ts:867`),
  `409 QUOTE_EXPIRED` / `403 QUOTE_CALLER_MISMATCH` / `400 QUOTE_STEP_MISMATCH` /
  `409 QUOTE_AGENT_UNAVAILABLE` (`src/routes/orchestrate.ts:640-670`, `:696-703`).
- **Por qué es MENOR y no BLOQUEANTE**: la cláusula que sigue (*"every other outcome — success or
  pipeline failure — is a `200`"*) acota el universo del que habla a los desenlaces del pipeline, y
  para ésos la frase **es cierta** (lo verifiqué: `DEST_CAP_EXCEEDED` e `INPUT_MAPPING_FAILED`
  también caen en el `: 200` de `/orchestrate`). El *"only"* se lee absoluto, pero no rompe ninguna
  rama de un cliente.

### Otras superficies que exponen el `ComposeResult` — respuesta a la pregunta, sin inflarla

Barrí los consumidores: `src/routes/compose.ts`, `src/routes/orchestrate.ts` (`/`, `/plan`,
`/execute`), `src/services/inbound-task.ts:512`, `src/services/agent-link.ts:383`, `src/mcp/tools/orchestrate.ts:24`.

- `/inbound` y el redeem de agent-links **consumen** el `pipeline` puertas adentro y devuelven shapes
  propios (`{status,orchestrationId,answer}` / `{status:'failed',reason}`): no exponen el campo, y la
  fila no tiene por qué nombrarlos.
- **La herramienta MCP `orchestrate` sí es una tercera superficie derivada** y **no lleva el campo**:
  `src/mcp/tools/orchestrate.ts:37-46` proyecta a mano `OrchestrateToolOutput`
  (`src/mcp/types.ts:156-163`), que no tiene `pipeline`, ni `success`, ni `error`, ni `agentFailure`.
  **No lo cuento como hallazgo**: esa superficie ya no llevaba NINGUNA señal de fallo antes de esta
  HU, así que no hay regresión, y el Scope IN del SDD son las dos rutas REST. Queda escrito para que
  nadie lo re-barra creyendo que es nuevo.

---

## Blanco 2 — daño colateral, barrido mecánico en los DOS repos

**Método** (nunca a ojo): mapa `línea_vieja → línea_nueva` por archivo derivado de
`/usr/bin/git diff -U1000000 <base> <HEAD>`, cruzado contra **todas** las citas `archivo:línea` de
todo lo que reporta `git ls-files`, con el regex corregido `(\.test)?\.tsx?:` + resolución
**relativa al directorio del archivo que cita** primero (sin eso, `route.ts:150` desde
`app/api/kyc/...` resuelve al archivo equivocado y fabrica decenas de falsos positivos — me pasó en
la primera pasada). Cada candidato se confirmó **comparando el contenido de `main@línea_vieja`
contra `HEAD@línea_vieja`**, no mirando si la línea nueva "se parece".

### Lo que el fix-pack NO rompió (medido, no supuesto)

- `doc/INTEGRATION.md`: la fila nueva es **+1 línea neta** para toda la HU y el fix-pack la reescribió
  **en el lugar**. Nadie cita `INTEGRATION.md:≥1043` fuera de los artefactos de esta HU, y ésos
  apuntan a `:1043`, que es la fila. **Cero daño.**
- `app/api/a2a/quote/route.test.ts`: las +33 líneas del test nuevo entraron en `:395`. Las tres citas
  externas a ese archivo (`app/api/a2a/plan/route.test.ts:468` → `:124-127`,
  `src/infrastructure/a2a/gateways.test.ts:160` → `:252`,
  `src/composition/value-delivery-adapter.ts:92` → `:125-127`) apuntan **por debajo** de 395.
  **Cero daño externo.** La única cita afectada era `quote/route.ts:131` → `route.test.ts:514`, y el
  fix-pack la cazó y la re-ancló a `:547`: **verificado, `:547` es el `it.each` de `T-1.1`**.
- `src/infrastructure/a2a/gateway-client.ts:369-382` (MNR-4 CR): la extracción del `const` es
  **behavior-idéntica** — `readAgentFailure` (`:246-248`) es pura y total. La cita interna nueva
  ``(`agentFailure`, `:264`)`` apunta bien (`:264` es el sitio gemelo en `readFailureFields`).
- `src/composition/container.test.ts:441` (BLQ-2): `:140` de `agent-rejections.test.ts` contiene el
  ancla `CABLEADO` y es exactamente la cita recíproca. Los desplazamientos que declara el
  `auto-blindaje` (`115 → 136`, `119 → 140`, `+21` a partir de `:71`) los re-derivé del mapa y
  **coinciden exactamente**.

### `BLQ-BAJO-3` · 8 citas SUELTAS que eran correctas en `main` y hoy apuntan a otra cosa

Estas **no** las cubre ningún candado: `citas-ancladas.test.ts` (chaski) sólo mira el formato
ANCLADO, y `cited-lines-guard` (a2a) sólo mira su registro curado. Son el agujero declarado #1 de
los dos.

| # | Quien cita | Qué cita | `main@vieja` (correcto) | `HEAD@vieja` (lo que se lee hoy) | Dónde vive ahora |
|---|---|---|---|---|---|
| a | `chaski-v3/.env.example:285` | `app/api/payout/prepare/route.test.ts:1296` — *"MEDIDO T-1.2"* | `it.each(["a2a-gateway","fallback",undefined])` de **T-1.2** | `expect(Object.keys(jsonNoSabe)).toEqual(["error"]);` | `:1407` |
| b | `chaski-v3/.env.example:312` | `src/infrastructure/a2a/gateway-client.ts:303` — *"viaja como header `x-payment-chain`"* | `...(cfg.paymentChain ? { "x-payment-chain": cfg.paymentChain } : {}),` | `//    lados es cómo se desincronizan.` | `:326` |
| c | `chaski-v3/src/infrastructure/fallback/gateways.ts:118` | `a2a/gateways.ts:181-200` — *"`A2aPayoutGateway.status()`"* | `async status(payoutId: string): Promise<PayoutRecord> {` | ` *` (una línea de docblock) | `:199` |
| d | `chaski-v3/app/api/payout/status/route.ts:43` | `prepare/route.ts:74-76` — *"Excluye arrays"* | `function isRecord(v: unknown): v is Record<string, unknown> {` | (línea en blanco) | `:75-77` |
| e | `chaski-v3/app/api/solana/escrow/remittance-ids/route.ts:41` | `prepare/route.ts:74-76` — ídem | ídem (d) | (línea en blanco) | `:75-77` |
| f | `chaski-v3/src/infrastructure/settlement/http-solana-prepare-gateway.ts:254` | `prepare/route.ts:214-217` — *"respondería 503 `payout_pop_unavailable`"* | `// CD-2 / AC-3: OBLIGATORIO. Sin secreto → 503 fail-closed (NUNCA skip).` | `const POP_SECRET = process.env.PAYOUT_POP_SECRET;` | `:215-218` |
| g | `wasiai-a2a/test/cited-lines-guard.test.ts:127` | `src/services/compose.ts:688` — *"el caso medido … la afirmación de fondo era correcta y lo único falso era el número"* | la línea que contiene la cita `guard \`i > 0\` de :571` | otra línea del mismo bloque | `:706` |
| h | `wasiai-a2a/test/cited-lines-guard.test.ts:711` | `src/services/compose.ts:688` — *"la cita falsa del guard anti-doble-débito del camino del dinero"* | ídem (g) | ídem | `:706` |

**Reproducción de cualquiera** (ejemplo con (b), el más limpio):

```
/usr/bin/git show 8831729:src/infrastructure/a2a/gateway-client.ts | sed -n '303p'
#  ...(cfg.paymentChain ? { "x-payment-chain": cfg.paymentChain } : {}),     ← lo que el comentario describe
sed -n '303p' src/infrastructure/a2a/gateway-client.ts
#  //    lados es cómo se desincronizan.                                     ← lo que se lee hoy
sed -n '326p' src/infrastructure/a2a/gateway-client.ts
#  ...(cfg.paymentChain ? { "x-payment-chain": cfg.paymentChain } : {}),     ← dónde está de verdad
```

**Dos agravantes, y son lo que sube esto de MENOR a BLOQUEANTE-BAJO:**

1. **(a) es la MISMA cita que el Dev SÍ re-ancló en otro lado.** `src/presentation/flow.tsx:3014`
   dice, en el diff de este mismo commit, `route.test.ts:1296` → `route.test.ts:1407`. O sea: el
   desplazamiento estaba medido y aplicado en una copia, y la copia de `.env.example` quedó. Es
   exactamente el modo de falla que el `auto-blindaje` de BLQ-2 promete no repetir
   (*"antes de insertar líneas, preguntar ¿quién cita algo por debajo de este punto?"*), y el
   barrido que lo prescribe sigue mirando sólo los archivos que uno tocó.
2. **(g) y (h) refutan la generalización de `MNR-6` de la iteración 1.** Ese MNR declaró que las 17
   citas sueltas desplazadas por Wave 1 *"YA ESTABAN ROTAS ANTES"* sobre una muestra de **8
   inspeccionadas**. Volví a medir las que faltaban: (g) y (h) **eran correctas en `main`**. La
   ironía es que viven en el docblock del propio `cited-lines-guard` — el archivo que `CLAUDE.md`
   manda leer antes de apoyarse en su verde — y describen, en presente, dónde vive "la cita falsa"
   que la HU acaba de mover 18 líneas.

**Atribución honesta**: de las 8, **ninguna** la rompió el fix-pack. (a)–(f) son de Wave 2 y (g)–(h)
de Wave 1; sobrevivieron a la iteración 1 porque su barrido era ciego a `.test.ts` y porque la
muestra de MNR-6 no era exhaustiva. Las reporto porque son defectos **vivos en el commit bajo
revisión** y de la misma clase exacta que BLQ-2, que sí fue del fix-pack.

**Sugerencia**: re-anclar los 8 (los destinos correctos están en la última columna, derivados del
mapa, no leídos a ojo). Para (a) y (b) conviene además pasarlas a formato ANCLADO, que es la única
forma que los candados de los dos repos saben verificar.

### Pre-existente, medido y descartado — para que nadie lo re-barra

Otras ~20 citas sueltas apuntan a líneas desplazadas por este commit pero **ya estaban rotas en
`main`** (candados podridos, no daño del Dev). Verificadas una por una contra `main@línea_vieja`;
muestra: `README.md:112` → `quote/route.ts:91` (en `main` era un `return` de 429, no el envío de la
`capability`); `docs/architecture.md:31` → `prepare/route.ts:297` (en `main` era
`let row: Awaited<...>`); `flow.tsx:3075` → `prepare/route.ts:255` (en `main` era el `return` del
403 `payout_pop_unverified`); `reputation.ts:18` → `compose.ts:278` (ya reportado por it1);
`fee-charge.ts:52` y `orchestrate.ts:1430` → `compose.ts:539` (en `main` era `error: ceilingBinds`).
**No son hallazgos.**

---

## Blanco 3 — el testigo nuevo, reproducido

### El mutante M9

- **Arnés**: directorio propio `…/scratchpad/ar2/m9-harness`, copia previa por `cp`, restauración por
  `cp`, `md5sum` antes y después. ⛔ Nunca `git checkout --`.
- **Mutación aplicada** (`app/api/a2a/quote/route.ts:173`), con `assert count == 1` antes de escribir:

  ```
  -  if (r.code === "step_failed" && r.agentFailure === "INPUT_REJECTED")
  +  if (r.agentFailure === "INPUT_REJECTED")
  ```

- **md5 del archivo**: `2fe6c593d8e24131d148d342fc73181b` antes → `6e6719b2887ec9fb081d359cc07988d9`
  con el mutante → `2fe6c593d8e24131d148d342fc73181b` restaurado. `git status --porcelain` **vacío**
  al terminar.

| Corrida | Resultado |
|---|---|
| `npx vitest run app/api/a2a/quote/route.test.ts` con M9 | `PASS (28) FAIL (1)`, exit 1 |
| `npx vitest run` (suite COMPLETA) con M9 | **`PASS (3059) FAIL (1)`**, exit 1 |
| El único rojo | `T-335-Q-4/CD-5` · `AssertionError: expected 422 to be 502` en `app/api/a2a/quote/route.test.ts:424:24` |

**Coincide EXACTAMENTE con lo que declara el `auto-blindaje.md:285`.**

### ¿Puede pasar por el motivo equivocado?

- **El rojo es la ASERCIÓN, no algo colateral**: el mensaje es `expected 422 to be 502` en la línea
  del `expect(res.status).toBe(502)`. No es un throw, ni un mock que no se cumplió, ni un timeout.
- **Es UN solo test en 3060.** Ningún otro test de ninguno de los 154 archivos toca ese guard: eso
  prueba, de paso y sin una segunda corrida, la mitad "**antes** del fix-pack M9 SOBREVIVÍA" que
  declara el `auto-blindaje` — el único que lo mata es el `it` que el fix-pack agregó.
- **El fixture ejercita de verdad el agujero** (el modo de falla *"el test del camino feliz
  ejercitaba el agujero"*): que M9 se muera **prueba** que `r.agentFailure` llegó poblado desde un
  cuerpo con status `402`. Si el cliente no parseara `agentFailure` fuera del sobre de
  `step_failed`, M9 habría sobrevivido y el test sería verde por la razón equivocada. No es el caso.
- **El testigo mide lo que dice medir**: `mapErrorStatus(402)` da `payment_required`, nunca
  `step_failed`, así que sin el `code` en el guard el 402 se va por el 422 nuevo. Es exactamente el
  defecto de la HU, invertido.

**Sin hallazgo. El testigo es real.**

---

## `BLQ-BAJO-2` · La "transcripción" de MNR-3 no es una transcripción: cambia `502` por `400`

- **Categoría**: Integration / evidencia.
- **Archivo:línea**: `wasiai-a2a/src/lib/agent-http-error.ts:54`.
- **Qué dice el fix-pack**:

  > `| 400 | INPUT_REJECTED | medido en producción el 2026-08-04 contra /api/a2a/quote de Chaski,`
  > **`transcripto de su docblock`**`:` `POST {"amountUsd":2} -> 400 fx_amount_below_minimum` `y`
  > `POST {"amountUsd":50000} -> 400 fx_amount_above_maximum`. …`

- **Qué dice el docblock que declara transcribir** (`chaski-v3/src/application/agent-rejections.ts:10-15`):

  ```
  10  * QUÉ ESTABA MAL, medido en producción el 2026-08-04 contra `/api/a2a/quote`:
  11  *
  12  *     POST {"amountUsd":2}     -> 502 a2a_upstream_error
  13  *     POST {"amountUsd":50000} -> 502 a2a_upstream_error
  14  *
  15  * El agente había contestado `400 fx_amount_below_minimum` y `400 fx_amount_above_maximum`. O sea
  ```

- **Reproducción**:
  ```
  cd /home/ferdev/.openclaw/workspace/chaski-wkh362
  grep -F 'POST {"amountUsd":2}' src/application/agent-rejections.ts
  #  *     POST {"amountUsd":2}     -> 502 a2a_upstream_error
  ```
  **Esperado según `agent-http-error.ts:54`**: una línea que diga `-> 400 fx_amount_below_minimum`.
  **Real**: `-> 502 a2a_upstream_error`. Ninguna línea del archivo tiene la forma citada.
- **Qué está mal exactamente**: el fix-pack **fusionó dos hechos distintos y presentó el resultado
  como una cita textual**. Lo MEDIDO fue la respuesta de la ruta de Chaski (`502`); el `400` es lo
  que el docblock dice, en prosa aparte, que *"el agente había contestado"*. Escribir
  `POST /api/a2a/quote -> 400 fx_amount_below_minimum` afirma que ese POST devolvió 400, y **no lo
  devolvió** — devolver 502 sobre un 400 del agente es, literalmente, el defecto que esta HU vino a
  cerrar. La frase invierte la medición que la motiva.
- **Impacto**: ese docblock es normativo. `agent-http-error.ts:71-73` dice *"Cómo se extiende la
  allow-list: con un status **MEDIDO** contra un agente real del catálogo devolviéndolo"*, y esta
  fila es la **única** evidencia del `400`, la entrada más importante de la lista. Quien vaya a
  auditar si el 400 está realmente medido abre el docblock de Chaski, encuentra `502` donde se le
  prometió `400`, y concluye que la evidencia está fabricada. MNR-3 pedía exactamente reforzar esa
  cadena de evidencia, y el arreglo la debilitó.
- **Sugerencia**: transcribir las cinco líneas como están (los dos `-> 502` **y** la frase *"El
  agente había contestado 400 fx_amount_below_minimum / 400 fx_amount_above_maximum"*), que es lo
  que hace verdadera y completa la evidencia: la ruta devolvía 502 **porque** el agente devolvía
  400. Y sacar el *"transcripto de su docblock"* de cualquier texto que no sea literal. Cero código.

---

## Gates — corridos por el AR, completos, en orden, una vez cada uno

⛔ `npm run qa` **no existe** en `wasiai-a2a`; el gate es la secuencia del CI.

| Repo | Comando | Resultado |
|---|---|---|
| `wasiai-a2a` | `npx tsc -p tsconfig.json --noEmit` | **exit 0** — `TypeScript compilation completed` |
| `wasiai-a2a` | `npm run lint` (`biome check src/`) | **exit 0** — `Checked 503 files. No fixes applied.` |
| `wasiai-a2a` | `npm test` (`vitest run`) | **exit 0** — `Test Files 298 passed \| 6 skipped (304)` · `Tests 5961 passed \| 19 skipped (5980)` |
| `chaski-v3` | `npm run qa` (lint → typecheck → typecheck:scripts → test) | **exit 0** — `Checked 278 files` · `Test Files 154 passed (154)` · `Tests 3060 passed (3060)` |
| `chaski-v3` | `npm run build` | **exit 0** |

Corridos **en serie** (nunca en paralelo: seis suites concurrentes vuelven flaky la medición) y con
los dos árboles limpios y todo en el índice (`git status --porcelain` vacío en los dos, antes y
después del arnés de mutación).

---

## Las 11 categorías — alcance fix-pack

| # | Categoría | Veredicto |
|---|---|---|
| 1 | Security | **OK** — el fix-pack no toca auth, ownership, ni una sola query. El único cambio de runtime (`gateway-client.ts:376`) es la extracción de un `const` sobre una función pura. |
| 2 | Error Handling | **OK** — cero `try/catch` nuevos; el guard de `quote/route.ts:173` queda intacto y ahora con testigo. |
| 3 | Data Integrity | **OK** — cero escrituras, cero transacciones, cero concurrencia tocada. Los dos repos commiteados y limpios (lo que `MNR-4` de it1 pedía). |
| 4 | Performance | **N/A** — el fix-pack no agrega I/O ni loops; la extracción del `const` de hecho evita una doble evaluación. |
| 5 | Integration | **BLQ-BAJO-1**, **BLQ-BAJO-2**, **MNR-1** |
| 6 | Type Safety | **OK** — cero `any`, cero casts; `tsc` limpio en los dos repos, corrido por mí. |
| 7 | Test Coverage | **BLQ-BAJO-3** por las citas. El testigo nuevo `T-335-Q-4/CD-5`: **reproducido y confirmado real** (M9 killed, `PASS (3059) FAIL (1)`, rojo por la aserción). |
| 8 | Scope Drift | **OK** — los 8 sitios del fix-pack están dentro de lo declarado; no aparecieron archivos ni features de más. |
| 9 | Destructive Migrations | **N/A** — cero `.sql`, el diff no toca `migrations/`. |
| 10 | RPC `SECURITY DEFINER` | **N/A** — ningún `supabase.rpc(...)` en el diff del fix-pack. |
| 11 | Cache Invalidation | **N/A** — el fix-pack no introduce ninguna capa de cache. |

---

## Orden sugerido del fix-pack 2

Los tres son BLOQUEANTE-BAJO y ninguno toca código de runtime. Por costo de escritura:

1. **`BLQ-BAJO-2`** (`agent-http-error.ts:54`) — una frase. Es el que más daño hace si queda:
   fabrica una cita textual que el lector puede desmentir en 10 segundos.
2. **`BLQ-BAJO-1`** (`INTEGRATION.md:1043`) — acotar la frase del `400` o enumerar las dos
   excepciones de `/compose`, como ya se hace con las de `/orchestrate`.
3. **`BLQ-BAJO-3`** — re-anclar las 8 citas (destinos en la tabla, derivados del mapa).
4. `MNR-1` — opcional, junto con (2).
