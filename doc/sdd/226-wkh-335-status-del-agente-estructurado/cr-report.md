# CR — Code Review · WKH-335 (#226)

**Agente**: `nexus-adversary` (modo CR) · **Fecha**: 2026-08-25
**Modo**: revisión **estática**. No se ejecutó `npm test` / `vitest` / `npm run qa` — el AR corre en
paralelo y es el dueño de ejecutar suites. Todo lo de acá es `archivo:línea`, `/usr/bin/git diff` y
lectura de árbol.

**Worktrees revisados**
- Wave 1 — `/home/ferdev/.openclaw/workspace/a2a-wkh362`, rama `feat/wkh-335-status-estructurado`, cambios **staged** (8 `A`, 10 `M`), leídos con `/usr/bin/git diff --cached`.
- Wave 2 — `/home/ferdev/.openclaw/workspace/chaski-wkh362`, rama `feat/wkh-335-error-no-opaco`, 25 `M` sin stagear, leídos con `/usr/bin/git diff`.

---

## Veredicto

# RECHAZADO — 1 BLOQUEANTE-BAJO

| ID | Nivel | Categoría | Archivo:línea |
|---|---|---|---|
| `BLQ-BAJO-1` | BLOQUEANTE-BAJO | Prosa que afirma de más / contrato público | `doc/INTEGRATION.md:1043` |
| `MNR-1` | MENOR | Escala del diff (check 7) | reparto medido vs. justificación dada |
| `MNR-2` | MENOR | Prosa que afirma de más | `src/types/index.ts:1276-1279` + `doc/INTEGRATION.md:1043` |
| `MNR-3` | MENOR | Test que no puede fallar | `src/services/compose.test.ts:3220-3227` |
| `MNR-4` | MENOR | DRY / consistencia intra-archivo | `chaski-v3/src/infrastructure/a2a/gateway-client.ts:376-378` |

El único bloqueante es de nivel BAJO y su fix es **una frase de documentación**, cero código.
Todo lo demás que se revisó está en verde y con evidencia abajo.

---

## Check 7 — La escala del diff (el que más importa)

### Lo medido, no lo reportado

Clasificador: cada línea **añadida** del diff se cuenta como `code` / `comment` / `blank`,
siguiendo el estado de bloque `/** … */` a través de las líneas de contexto y tratando `*` inicial
como continuación de docblock.

**Wave 1 (`wasiai-a2a`), archivos de código** — `/usr/bin/git diff --cached -- src test`:

| Archivo | code | comment | blank | añadidas |
|---|---|---|---|---|
| `src/lib/agent-http-error.test.ts` | 93 | 18 | 12 | 123 |
| `src/lib/agent-http-error.ts` | **16** | **73** | 3 | 92 |
| `src/lib/field-error-parser.ts` | **0** | **7** | 0 | 7 |
| `src/routes/compose.test.ts` | 25 | 14 | 3 | 42 |
| `src/services/compose.test.ts` | 107 | 29 | 23 | 159 |
| `src/services/compose.ts` | **7** | **30** | 1 | 38 |
| `src/types/index.ts` | **2** | **55** | 1 | 58 |
| `test/cited-lines-guard.citations.ts` | 4 | 2 | 0 | 6 |
| **TOTAL** | **254** | **228** | **43** | **525** |

(+4 líneas en `README.md`, `README.es.md`, `doc/INTEGRATION.md`, `doc/sdd/_INDEX.md` ⇒ los ~526 que
reportó el Dev.)

**Contra las tres columnas que declaró el SDD** (`sdd.md:719` — Código ~60 · Prosa ~95 · Tests ~145):

| Columna | Presupuesto | Medido | Ratio |
|---|---|---|---|
| Código ejecutable (no-test) | ~60 | **25** | **0,42x** (por debajo) |
| Prosa/docblock (no-test) | ~95 | **165** | 1,74x |
| Archivos de test (todo) | ~145 | **330** | **2,28x** |

### Veredicto de la justificación

La afirmación del Dev — *"el exceso de Wave 1 es prosa que el Story File volvió normativa"* — **no
la sostiene la medición**. De las ~205 líneas de exceso sobre el techo de 320:

- **+185 son archivos de test** (330 vs ~145) ⇒ **90 % del exceso**;
- +70 son prosa (165 vs ~95);
- **−35 es código**: hay *menos* código ejecutable del presupuestado.

La segunda afirmación — *"el código ejecutable son ~10 líneas"* — mide **25**: 16 en
`agent-http-error.ts` (`:24-45` la clase, `:90-92` la función), 7 en `services/compose.ts`
(`:13` import, `:174-176` el helper, `:1184` y `:1220` los dos spreads, `:1792` el throw), 2 en
`types/index.ts` (`:705` el alias, `:1294` el campo). Es 2,5x lo declarado.

**Aplicando la pregunta que decide** (*¿qué parte seguiría existiendo si lo escribiera alguien que
ya conoce estos dos repos?*), bloque por bloque:

- `types/index.ts:687-704` y `:1253-1293` — 55 líneas de docblock para 2 de código. **Mandado por el
  SDD**: `sdd.md:484-487` enumera los 6 contenidos obligatorios *incluida la tabla de §6.2*, y
  `sdd.md:492-500` es esa tabla. La tabla aparece dos veces (acá y en `agent-http-error.ts:36-44`)
  **por decisión escrita** (CD-13 exige la del clasificador; §6.1 exige la del campo). Regla 5 de
  calibración: decisión documentada ⇒ no es hallazgo.
- `agent-http-error.ts:29-91` — 73 de docblock para 16 de código. Contenido: CD-13 (por qué
  allow-list y no deny-list), por qué el 429 no es `INPUT_REJECTED`, y la divergencia con
  `parseFieldErrors`. Los tres están pedidos por nombre en `story-file.md:817-819` y `sdd.md:446`.
- `agent-http-error.test.ts` — 123 vs ~75 presupuestadas. El exceso sale de la tabla de 16 statuses
  (`:18-41`), y **CD-17** (`sdd.md:460-463`) obliga a los pares que discriminan. Sobredimensionado
  respecto del presupuesto, pero cada `it` mide algo distinto.
- `compose.test.ts` — 159 vs ~110. El exceso sale de la regla *"los dos desenlaces en el mismo `it`"*,
  que duplica el setup de cada caso (`:3137-3151`, `:3170-3191`). También mandada.

**Conclusión**: el exceso es **legítimo en su contenido** y **mal atribuido en su explicación**. Nadie
tiene que recortar nada. Lo que falta es que la explicación diga la verdad — y que exista.

**Lo que sí está incumplido**: `story-file.md:1203` pide *"Diff dentro del techo (≤ 320 líneas /
6 archivos de código) **o exceso justificado por escrito**"*. Barrido de los 6 artefactos de la HU
(`grep -rn "526|ejecutable|presupuesto|techo|320"` sobre `auto-blindaje.md`,
`evidencia-*.md`): **cero apariciones**. La justificación existe sólo en el mensaje del Dev al
orquestador. Ver `MNR-1`.

### Wave 2 — `chaski-v3`

`/usr/bin/git diff` completo: **563 añadidas / 146 borradas** sobre 25 archivos, contra un techo de
≤350 / 9 archivos.

- **Sustantivos** (13 archivos con `code > 0` o reescritura de prosa normativa): ~543 líneas ⇒
  **1,55x** el techo.
- **Sólo-citas** (12 archivos, 20 líneas en total): `plan/route.test.ts`, `confirm-and-send.ts`,
  `principal-tx-single-writer.static.test.ts`, `authority.ts`, `authority.test.ts`, `rate-limit.ts`,
  `pop-por-enlace.ts`, `bienvenida.tsx`, `history-grupos.test.tsx`, `history-onchain.test.tsx`,
  `recuperar-composicion.test.tsx`, `recuperar.tsx`.

El exceso de **archivos** (25 vs 9) **sí está justificado por escrito**, y bien:
`auto-blindaje.md:151-227` documenta que el Story File afirmaba dos cosas falsas (que `chaski-v3` no
tiene guardián de citas, y que eran 4 citas) y que la medición dio **53 rotas / 104 re-ancladas en 21
archivos**, con el baseline en `HEAD` limpio vía `git stash` para probar que eran suyas. Eso es
exactamente el estándar que pide la regla 10.

Dato de forma, sin impacto: en Wave 2 hay **más comentario (286) que código (254)** entre las líneas
añadidas, y **tres archivos sustantivos tienen `code = 0`** — `agent-rejections.ts` (0/23),
`gateways.ts` (0/30), `flow-vm.ts` (3/31). Son las "8 prosas" de `sdd.md:452` que la HU vuelve
falsas: reescribirlas es trabajo pedido, no relleno.

### Las TRES señales de alarma — verificadas contra el diff, no creídas

| # | Señal | Verificación | Resultado |
|---|---|---|---|
| 1 | Archivo nuevo de constantes en `chaski-v3` | `git status --porcelain` en `chaski-wkh362` ⇒ 25 entradas, **todas ` M`**, cero `A`, cero `??` | ✅ **NO aparece** |
| 2 | Línea de **código** en `field-error-parser.ts` | `git diff --cached -- src/lib/field-error-parser.ts` ⇒ +7, todas dentro del docblock que abre en `:1` (`:16-22`, todas ` * …`). `code = 0` | ✅ **NO aparece** |
| 3 | Status HTTP nuevo en `routes/compose.ts` | `src/routes/compose.ts` **no figura** en `git status`; sólo `src/routes/compose.test.ts` | ✅ **NO aparece** |

Matiz de la #2: `story-file.md:823` permitía *"una línea de docblock"* y hay 7. Son 7 líneas de la
misma frase, mandada por `story-file.md:560-562` (*"escribí la razón en el docblock de los dos
módulos"*). No es hallazgo.

---

## Check 1 — Naming

**OK.**

- `AgentFailureKind` — nombre **prescrito literalmente** por el SDD (`sdd.md:474`). No es una
  elección del Dev.
- El prefijo `agent` está justificado con una colisión real y verificable:
  `src/types/index.ts:691-694` dice que en ese archivo "failure" a secas ya significa "de una fuente
  de discovery", y en efecto `DiscoverySourceFailure` vive 15 líneas más arriba (`:680-687`).
- `agentFailure` convive con `inputMappingFailure` (`:1246`) y `failedSources` en el mismo
  `ComposeResult` ⇒ sufijo consistente con el vocabulario existente.
- `INPUT_REJECTED` / `AGENT_ERROR` — la elección de `AGENT_ERROR` sobre `AGENT_UNAVAILABLE` está
  argumentada en `:701-703` con un caso concreto (401/403 no es "no disponible").
- `AgentHttpError` — espejo exacto de `RegistryHttpError`, que ya existe en el repo.

Sin colisiones: `grep -rn "agentFailure|AgentFailureKind|AgentHttpError"` sobre `src/` da sólo los
sitios de esta HU.

---

## Check 2 — DRY / cohesión: los dos clasificadores

**OK.** La duplicación **está bien explicada y en el lugar donde se lee**, que es el criterio.

`parseFieldErrors` gatea el retry con `400 <= status < 500` (`src/lib/field-error-parser.ts:31`);
`classifyAgentFailure` usa la allow-list `{400, 422}` (`src/lib/agent-http-error.ts:92`). DT-5 decidió
no unificarlos. Lo que dejó el Dev:

1. `src/lib/agent-http-error.ts:82-91` — la versión larga, con **las dos preguntas contrastadas** y
   el mismo ejemplo (un 403 con `fieldErrors` legibles califica para una y no para la otra).
2. `src/lib/field-error-parser.ts:16-22` — la contracara, en el otro extremo de la divergencia.
3. `src/types/index.ts:1287-1289` — un **puntero**, no una tercera copia.

Los dos primeros están mandados por `story-file.md:560-562` (*"escribí la razón de la divergencia en
el docblock de **los dos** módulos"*), y el motivo está medido: `sdd.md:323-325` cita el
Auto-Blindaje de la HU 223, donde exactamente eso pasó. Un lector que llegue en seis meses a
cualquiera de los dos archivos encuentra la razón sin tener que buscarla. **No parece descuido.**

---

## Check 3 — ¿`AgentHttpError` sigue al exemplar `RegistryHttpError`?

**OK.** Comparación `src/lib/discovery-sources.ts:1-36` vs `src/lib/agent-http-error.ts:1-45`:

| Rasgo del exemplar | `RegistryHttpError` | `AgentHttpError` |
|---|---|---|
| Módulo LEAF, sólo `import type` | `discovery-sources.ts:1-16` | `agent-http-error.ts:1-9` — mismo docblock, mismo motivo (suites que mockean con factories sin `importOriginal`) |
| `extends Error` + `public readonly status: number` | `:30-31` | `:24-25` |
| `this.name = '<Clase>'` | `:34` | `:31` |
| `message` byte-idéntico al `Error` genérico previo, declarado en el docblock | `:21-22` | `:16-20` |
| Docblock que dice *"existe para clasificar sin parsear el mensaje"* | `:20` | `:14-15` |

**Dos divergencias, las dos hacia arriba**:
1. `AgentHttpError` agrega `public readonly kind` (`:25`, `:32`) y clasifica en el constructor. El
   exemplar deja la clasificación al llamador. Consecuencia buena: `services/compose.ts:175` lee
   `err.kind` y no puede clasificar distinto que otro llamador.
2. El exemplar **declara** el byte-por-byte y no lo mide; `agent-http-error.ts:21-25` dice
   explícitamente *"Ese byte-por-byte NO se sostiene leyendo el diff"* y lo delega a un test que
   pasa el `.message` real por `parseFieldErrors` (`agent-http-error.test.ts:110-121`), con control
   anti-vacío incluido (`:117-120`: *"si el parser devolviera null para los dos, el test pasaría sin
   probar nada"*).

No divergió. Lo mejoró.

---

## Check 4 — Las 3 desviaciones de scope de `wasiai-a2a`

**OK — las tres son forzadas por guards del repo. Verificado, no aceptado de palabra.**

**(a) `test/cited-lines-guard.citations.ts`** (`auto-blindaje.md:30-81`)
El Dev insertó un `import` en `services/compose.ts:13` y un helper en `:163-176` ⇒ +18 líneas por
encima de la línea 571, que dos entradas del guardián citan. Verificado:
`src/services/compose.ts:589` dice hoy `if (i > 0 && scopingKeyRow && chainId !== undefined) {`, que
es el ancla declarada en `mustContain` (`citations.ts:266`). El cambio son **2 números y 1 frase**
(`:260-262`, `:314`, `:316`); cero lógica. Sin esto `npm test` queda rojo. Forzada.

**(b) y (c) `README.md` / `README.es.md`** (`auto-blindaje.md:107-147`)
`test/readme-numbers.test.ts` deriva sus dos números del **índice de git**. Re-derivé los dos a mano
en el árbol staged:
```
git ls-files | grep -E '^(src/.*\.test\.ts|test/.*\.test\.(ts|mjs))$' | wc -l   → 304
git ls-files | grep -E '^src/.*\.ts$' | wc -l                                   → 503
```
Coinciden exactamente con lo escrito (`README.md:378` `303→304`, `:383` `501→503`, y los dos gemelos
en `README.es.md:412` y `:417`). Aritmética correcta, cambio mecánico, forzado por el guard.

**Ninguna de las tres es expansión disfrazada**: las tres están declaradas como desviación en el
auto-blindaje **antes** de que las mirara nadie, con el mecanismo que las obliga.

---

## Check 5 — Las 104 citas re-ancladas de `chaski-v3`

**OK.** Muestra de **23 citas** verificadas **contra el símbolo contenedor**, no contra un parecido
de texto (el modo de falla que el brief marca).

| Cita re-anclada | Línea de destino hoy | ¿coincide el símbolo? |
|---|---|---|
| `payout_not_authorized`, `flow-vm.ts:748` | `if (code.includes("payout_not_authorized"))` | ✅ |
| `prepare_kyc_verdict_missing`, `flow-vm.ts:695` | `if (code.includes("prepare_kyc_verdict_missing"))` | ✅ |
| `payout_authority_unavailable`, `flow-vm.ts:750` | `if (code.includes("payout_authority_unavailable")) return "No llegamos…"` | ✅ |
| `copyDeEntregaFallida`, `flow-vm.ts:1602` | `export function copyDeEntregaFallida(...)` | ✅ |
| `esVentanaSinAbiertos`, `flow-vm.ts:1145` | `export function esVentanaSinAbiertos(...)` | ✅ |
| `CruceDeCuenta`, `flow-vm.ts:1538` | `export type CruceDeCuenta = …` | ✅ |
| `EscrowOutcome`, `flow-vm.ts:1175` | `export type EscrowOutcome =` | ✅ |
| `escrowOutcomeDisplay`, `flow-vm.ts:1260` | `export function escrowOutcomeDisplay(...)` | ✅ |
| `GRUPO_POR_DESENLACE`, `flow-vm.ts:1363` | `const GRUPO_POR_DESENLACE: Record<…>` | ✅ |
| `COPY_FALLO_SIN_DEPOSITO`, `flow-vm.ts:1599` | `export const COPY_FALLO_SIN_DEPOSITO =` | ✅ |
| `copyDelFinDelResume`, `flow-vm.ts:1747` | `export function copyDelFinDelResume(...)` | ✅ |
| `escrowOutcome`, `flow-vm.ts:1213` / `answer`, `:1204` | las dos ramas de `escrowOutcome` | ✅ |
| `A2aQuoteGateway`, `gateways.ts:152` | `export class A2aQuoteGateway implements QuoteGateway` | ✅ |
| `requestQuote`, `gateways.ts:153` | `async requestQuote(req: QuoteRequest)` | ✅ |
| `resolvePayoutAuthority`, `prepare/route.ts:332` | `const d = await resolvePayoutAuthority({…})` | ✅ |
| `isPrepareUnreachable`, `agent-rejections.ts:277` | `export function isPrepareUnreachable(...)` | ✅ |
| `QUOTE_REJECTED`, `agent-rejections.ts:52` | `export const QUOTE_REJECTED = "a2a_quote_rejected"` | ✅ |
| `it.each`, `prepare/route.test.ts:1407` | `it.each(["a2a-gateway","fallback",undefined])(` | ✅ |
| `it.each`, `quote/route.test.ts:514` | ídem | ✅ |
| `prepare_kyc_verdict_missing`, `prepare/route.ts:311` | el `return NextResponse.json({error:"prepare_kyc_verdict_missing"}…)` | ✅ |
| `payout_authority_unavailable`, `prepare/route.ts:334` | su `return` con 503 | ✅ |
| sueltas: `gateway-client.ts:230-231`, `flow-vm.ts:953-956`, `prepare/route.ts:219` y `:231` | el error transcripto / la frase del dead-end / `const popChallenge` / `verifySolanaPopChallenge` | ✅ |

**Los tres errores que el Dev se auto-reporta están efectivamente cerrados**, verificados uno por uno:
1. *Doble aplicación* — decía que el guard cazó `:260` apuntando a `? body.error_code`. Hoy
   `gateway-client.ts:260` **sigue siendo** `? body.error_code` (o sea: el síntoma era real) y la
   cita quedó en `:239`, que es `if (!url || !key) return null; // ausente/vacío ⇒ not_configured`
   — lo que la cita afirma (`quote/route.ts:137`). Cerrado.
2. *Auto-citas que no eran auto-citas* — los 5 `:NN` sueltos de `gateways.ts` se reescribieron
   anclados y apuntan a `quote/route.ts`. Los cinco verificados: `:168` `a2a_not_configured`,
   `:174` `QUOTE_REJECTED`, `:182` `QUOTE_NO_AGENT_FOR_CAPABILITY`, `:183` `a2a_unavailable`,
   `:186` `a2a_bad_shape`. Los cinco son el `return NextResponse.json(...)` real. Cerrado.
3. *El mapa envejece* — las 3 citas movidas después están dentro de la muestra de arriba. Cerrado.

**El "hallazgo lateral" también se sostiene**: los 4 números viejos (`:116`, `:124`, `:125`, `:128`)
apuntaban a prosa. Fue deuda preexistente corregida sin costo marginal, y el arreglo mejoró el
formato (suelto → anclado), lo que las pone bajo `citas-ancladas.test.ts` por primera vez.

**Control de desplazamiento exacto**: comparé `git show HEAD:app/api/payout/prepare/route.ts` contra
el árbol. `HEAD:218` = `const popChallenge = body.popChallenge;` (hoy `:219`); `HEAD:230` =
`verifySolanaPopChallenge` (hoy `:231`); `HEAD:331` = `resolvePayoutAuthority` (hoy `:332`). El mapa
`vieja → nueva` es exacto, no una resta a ojo.

---

## Check 6 — Prosa que afirma de más

**1 BLOQUEANTE-BAJO + 1 MENOR.** El resto de las frases absolutas nuevas son falsables y ciertas:

- `agent-http-error.ts:34-35` *"TOTAL: NUNCA lanza para NINGÚN `number` — incluidos NaN, negativos y 0"*
  ⇒ lo mide `agent-http-error.test.ts:65-74` con esos cinco inputs.
- `services/compose.ts:171-172` *"Nunca `{ agentFailure: undefined }`"* ⇒ lo mide
  `compose.test.ts:3205-3206` con `'agentFailure' in result` y `JSON.stringify`.
- `chaski-v3/gateway-client.ts:166` *"**Nunca se ecoa al browser**"* ⇒ verificado: `runViaGateway`
  tiene exactamente **dos** consumidores (`quote/route.ts:138`, `prepare/route.ts:392`) y los dos
  emiten body de una sola clave, asertado en `quote/route.test.ts` (`Object.keys(json)`).
- `chaski-v3/agent-rejections.ts:43-45` *"✅ YA TIENE PRODUCTOR"* ⇒ cierto: `quote/route.ts:174`.

---

# HALLAZGOS

## `BLQ-BAJO-1` — `doc/INTEGRATION.md` afirma un status y una ubicación que `/orchestrate` no tiene

- **Categoría**: Integration / prosa que afirma de más (contrato público)
- **Archivo:línea**: `wasiai-a2a/doc/INTEGRATION.md:1043` (la fila nueva, `git diff --cached -- doc/INTEGRATION.md`)
- **Qué dice**:
  > `| `400` with `agentFailure` | A `/compose` (**or `/orchestrate`**) pipeline failed because the agent one of its steps invoked answered with a non-2xx HTTP status … It is **additive**: … and **the HTTP status does not change** — **a pipeline failure is still a `400`**. |`

- **Qué está mal**: las dos afirmaciones son falsas **para `/orchestrate`**, que la fila nombra por su nombre.
  1. **El status no es 400, es 200.** `src/routes/orchestrate.ts:244-249` (handler atómico) y
     `:877-882` (handler `/execute`) calculan
     `status = errorCode==='SCOPE_DENIED' ? 403 : errorCode===CONTRACTING_LOOP_DETECTED ? 400 : 200`.
     Un fallo de pipeline por un agente que contestó 400/422 **no setea ninguno de esos dos
     `errorCode`** ⇒ cae en el `: 200`.
  2. **El campo no es top-level, va anidado.** `src/services/orchestrate.ts:1685` embebe el
     `ComposeResult` entero bajo la clave `pipeline`, y la ruta hace `send({ kiteTxHash, ...result })`
     (`routes/orchestrate.ts:271-278`). El campo sale como **`pipeline.agentFailure`**, nunca como
     `agentFailure`.

- **Reproducción**: `POST /orchestrate` con un goal cuyo step invoque un agente que responda `400`.
  - **Esperado según la doc**: `HTTP 400`, body con `agentFailure: "INPUT_REJECTED"`.
  - **Real**: `HTTP 200`, body con `pipeline.agentFailure: "INPUT_REJECTED"` y sin ningún
    `agentFailure` en la raíz.
  - Evidencia estática equivalente sin correr nada: no existe ninguna asignación de `agentFailure`
    fuera de `services/compose.ts:175`, y `grep -n "return {"` en `orchestrate.ts` muestra que el
    único `return` del path exitoso-de-orquestación es el de `:1681-1703`, que anida `pipeline`.

- **Impacto**: `doc/INTEGRATION.md` es la guía pública. Un integrador de `/orchestrate` que lea esta
  fila va a ramificar por `res.status === 400 && body.agentFailure`, que **nunca** se cumple, y va a
  concluir que el campo no existe. Es literalmente la opacidad que esta HU vino a cerrar, movida de
  lugar. Además contradice al propio SDD: `sdd.md:398-405` (§4.6) dice que `/orchestrate` hereda el
  campo **por tipo, adentro de `pipeline`**, y nunca menciona un 400.

- **Sugerencia**: separar las dos superficies en la fila. Para `/compose` la frase es correcta y se
  queda como está. Para `/orchestrate`, decir que el campo viaja **dentro de `pipeline`** y que un
  fallo de pipeline sale con **200** (que es el comportamiento de hoy, ajeno a esta HU). Cero código.

---

## `MNR-1` — El exceso de diff está mal atribuido, y no hay justificación escrita en ningún artefacto

- **Categoría**: Escala del diff (check 7)
- **Evidencia**: la tabla de la sección "Check 7" de arriba. Resumen: de las ~205 líneas de exceso de
  Wave 1, **185 (90 %) son archivos de test** y sólo 70 son prosa; el código ejecutable está **por
  debajo** del presupuesto (25 medidas vs ~60 presupuestadas), no por encima. La afirmación *"el
  código ejecutable son ~10 líneas"* mide **25**.
- **Reproducción**: sobre `a2a-wkh362`, clasificar las líneas `+` de
  `/usr/bin/git diff --cached -- src test` en comentario/código/blanco. Archivos de test:
  `123 + 42 + 159 + 6 = 330` contra las `~145` de `sdd.md:719`. Archivos no-test:
  `92 + 7 + 38 + 58 = 195` contra las `~155` (60+95).
- **Segunda mitad**: `story-file.md:1203` exige *"exceso justificado **por escrito**"*.
  `grep -rn "526|ejecutable|presupuesto|techo|320"` sobre `auto-blindaje.md`, `evidencia-rojo-antes.md`
  y `evidencia-verde-despues.md` da **cero**. La justificación vive sólo en el mensaje al orquestador,
  o sea que se pierde en cuanto se cierra la sesión — y era inexacta.
- **Impacto**: bajo hoy, alto como precedente. Un CR que acepte *"es todo prosa mandada"* sin medir
  nunca mira los 330 de test; y el próximo que lea el `_INDEX` no encuentra por qué la HU salió 1,64x.
  Es el patrón *"prosa que afirma de más apaga las revisiones"*.
- **Sugerencia**: un párrafo en `auto-blindaje.md` con el reparto **medido** (los tres números por
  columna) y la línea que ata cada exceso a su directiva: los tests a **CD-17** + la regla de "los dos
  desenlaces en el mismo `it`", la prosa a `sdd.md:484-487`. Nada que recortar: el contenido está bien.
  Y anotar que el presupuesto del SDD subestimó la columna de tests en 2,3x — eso es información para
  el próximo F2, no un reproche.

---

## `MNR-2` — El "invariante de ausencia" es un `⟺` que el propio commit falsifica

- **Categoría**: Prosa que afirma de más
- **Archivo:línea**: `wasiai-a2a/src/types/index.ts:1276-1279`
  > *"**Invariante de ausencia**: `agentFailure` presente ⟺ el agente invocado contestó con un status
  > HTTP no-2xx. Ausente (red, DNS, timeout, SSRF, bucle de contratación, fallo de mapeo de input)
  > significa 'no sé qué contestó el agente'."*
- **Qué está mal**: la implicación **←** es falsa. Hay al menos dos entradas concretas donde el agente
  **sí** contestó no-2xx y el campo queda **ausente**:
  1. `422 (con fieldErrors) → regen por LLM → 200`: el pipeline **tiene éxito**, no hay campo, y el
     agente contestó un 422.
  2. `422 → regen → ECONNRESET`: el pipeline falla, no hay campo, y el agente contestó un 422.
- **Reproducción**: el caso 2 **lo escribió el propio Dev, 100 líneas más allá, como comportamiento
  correcto**: `src/services/compose.ts:1179-1181` dice *"`422 → regen → ECONNRESET` deja el campo
  AUSENTE, y eso es correcto"*. Las dos frases están en el mismo commit y se contradicen.
  El caso 1 lo cubre el escenario de `T-335-BACKCOMPAT`/`T-RETRY-HAPPY`.
- **Impacto**: acotado pero real. Un consumidor que lea el `⟺` concluye *"ausente ⇒ el agente nunca
  contestó ⇒ es un problema de transporte"* y va a alertar/loguear mal el caso en que el agente
  rechazó el input y el reintento se cayó por red. La misma laguna está en
  `doc/INTEGRATION.md:1043` (*"absent when there was no HTTP status from the agent **at all**
  (network, DNS, timeout, SSRF block, contracting loop, input-mapping failure)"* — la lista no incluye
  "el retry reemplazó el veredicto").
- **No es bloqueante**: el **comportamiento** es correcto y deliberado, y el párrafo siguiente del
  mismo docblock (`:1281-1283`) ya explica la semántica del retry. Lo que falla es el `⟺`.
- **Sugerencia**: bajar el `⟺` a `⇒`, o acotarlo al último intento — *"presente ⇒ el agente contestó
  no-2xx **en el intento que decidió el desenlace**"* —, y sumar el caso del retry a la lista de
  "ausente" en los dos lugares.

---

## `MNR-3` — 5 asserts de `T-335-NOLEAK` no pueden fallar

- **Categoría**: Test coverage — control vacuo
- **Archivo:línea**: `wasiai-a2a/src/services/compose.test.ts:3220-3227`
```ts
const campo = JSON.stringify(result.agentFailure);
expect(result.agentFailure).toBe('INPUT_REJECTED');
expect(campo).not.toContain('https://example.com/invoke');
expect(campo).not.toContain('example.com');
expect(campo).not.toContain('internal.corridor.example');
expect(campo).not.toContain('sk-live-SUPERSECRET');
expect(campo).not.toContain('invalid_input');
```
- **Qué está mal**: `campo` es el `JSON.stringify` de un valor que la línea inmediatamente anterior
  ya fijó al literal `'INPUT_REJECTED'`. Si hubiera fuga, el `toBe` falla **primero** y los cinco
  `not.toContain` nunca corren; si no la hay, valen `"\"INPUT_REJECTED\""` y los cinco son
  trivialmente ciertos. **No existe implementación que haga pasar el `toBe` y fallar cualquiera de
  los cinco.** Poder discriminante: cero.
- **Reproducción**: mutación mental — cambiar `agentFailureResult` (`compose.ts:174-176`) por
  cualquier cosa que filtre (p. ej. devolver el `err.message`) mata el `toBe` de `:3222`, nunca los
  `not.toContain`. Y no hay mutante que los mate a ellos sin matar antes al `toBe`.
- **Impacto**: ninguno funcional. Es un testigo apagado que se lee como cobertura de AC-3 ("el campo
  no es un eco") y no aporta nada sobre el `toBe` que ya está.
- **Contraste que muestra que el Dev conoce el patrón**: en
  `src/lib/agent-http-error.test.ts:117-120` escribió el control anti-vacío explícito (*"si el parser
  devolviera `null` para los dos, el test pasaría sin probar nada"*). Acá faltó.
- **Sugerencia**: o correr los `not.toContain` sobre `JSON.stringify(result)` **completo** (ahí sí
  discriminan: cubren que el eco no se cuele por ningún campo del sobre), o reemplazarlos por un
  assert de vocabulario cerrado (`expect(['INPUT_REJECTED','AGENT_ERROR']).toContain(...)`) y borrar
  los cinco.

---

## `MNR-4` — `readAgentFailure` se evalúa dos veces donde el mismo archivo, 100 líneas arriba, usa un `const`

- **Categoría**: DRY / consistencia intra-archivo
- **Archivo:línea**: `chaski-v3/src/infrastructure/a2a/gateway-client.ts:376-378`
```ts
...(readAgentFailure(parsed.agentFailure) !== undefined
  ? { agentFailure: readAgentFailure(parsed.agentFailure) }
  : {}),
```
- **Contraste**: `:264` y `:270`, en el **mismo archivo**, resuelven el idéntico problema con
  `const agentFailure = readAgentFailure(body.agentFailure);` + `...(agentFailure !== undefined ? {…} : {})`,
  que es además el patrón de las otras cuatro claves de `readFailureFields` (`step`, `gatewayCode`,
  `reason`, `message`).
- **Impacto**: cosmético hoy — `readAgentFailure` es pura y barata. El costo real es que las dos
  formas conviven en un archivo y la segunda es la que se copia mal el día que el guard deje de ser
  puro.
- **Sugerencia**: extraer `const agentFailure = readAgentFailure(parsed.agentFailure);` antes del
  objeto, igual que en `:264`. **No bloquea.**

---

# Lo que se revisó y quedó en OK (con la cita que lo sostiene)

| Área | Evidencia |
|---|---|
| **Cableado de los DOS `return` de error (CD-6)** | `services/compose.ts:1184` (`retryErr`, camino retry) y `:1220` (`err`, camino directo), los dos vía el mismo `agentFailureResult` (`:174-176`) ⇒ no pueden divergir. Es el mismo patrón de un solo constructor que ya usa `withheldResult` (`:157`). |
| **Ausencia como valor (CD-10)** | `agentFailureResult` devuelve `{}` y no `{ agentFailure: undefined }` (`:175`). Asertado con `'agentFailure' in result` y `JSON.stringify`, no con `=== undefined` (`compose.test.ts:3205-3206`, `:3240-3241`). |
| **CD-18 — ningún status nuevo** | `src/routes/compose.ts` no está en el diff. `routes/compose.test.ts:1080-1082` fija el 400. |
| **El mock que podría mentir, declarado** | `routes/compose.test.ts:1047-1057`: *"⛔ NO prueba que el service lo emita: en este archivo `composeService` es un `vi.mock` … Que el service REAL lo emita lo prueba `src/services/compose.test.ts` y SÓLO ese archivo."* Y declara el riesgo que **sí** cubre (un `schema.response` de Fastify que strippee la clave). |
| **Pares que discriminan (CD-17)** | `agent-http-error.test.ts:46-61` (399/400, 422/423, 429/500) y los `not.toBe` cruzados de `compose.test.ts:3151`, `:3191`. Un mutante que colapse las dos clases muere. |
| **Guard de VALOR en Chaski** | `gateway-client.ts:245-248` (`readAgentFailure`) rechaza cualquier string fuera de la lista cerrada. `gateway-client.test.ts:473-492` lo prueba con 6 basuras **y** con un control de discriminación explícito (*"sin esto el `for` pasaría igual si el campo no se leyera nunca"*). |
| **Los DOS sitios de construcción (CD-11)** | Sitio 1 vía `readFailureFields` (`:266`, `:271`) y sitio 2 a mano (`:376-378`), con el motivo escrito: sin la segunda línea el mismo fallo se clasificaría distinto según el status con que llega. Cubiertos por `T-335-GW-1` y `T-335-GW-2`. |
| **Los DOS legs de dinero (CD-7)** | `quote/route.ts:173-174` y `prepare/route.ts:434-435`, con el **mismo** guard `code === "step_failed" && agentFailure === "INPUT_REJECTED"`. Sin colisión de orden: los `code` son mutuamente excluyentes con el `no_agent_match` de `:426`. |
| **El enum llega hasta el copy** | Traza completa verificada: `prepare/route.ts:435` emite `PREPARE_REJECTED` (`= "prepare_agent_rejected"`, `agent-rejections.ts:73`) → `http-solana-prepare-gateway.ts:79` lo propaga 1:1 porque está en `PREPARE_REJECTION_ENUMS` (`agent-rejections.ts:119`) → no cae en el default `prepare_rejected` de `:82`. El leg de quote: `quote/route.ts:174` → `gateways.ts:141` + `:149` → `gateways.ts:169`. **No quedó ningún enum nuevo huérfano.** |
| **AC-8 — una sola clave en el body** | `quote/route.test.ts` assertea `Object.keys(json)).toEqual(["error"])` y que el log lleva el enum pero **no** el `message` del gateway ni el slug del agente. Consistente con `logGatewayFailure` (`gateway-client.ts:410-422`), que sólo pasa enums y números. |
| **El `expect` protegido de T-4.1'** | `story-file.md:1218` exige `flow-vm.test.ts:1045-1046` INTACTO. Verificado: `git show HEAD:…` da `expect(humanError("step_failed")).toBe("Algo salió mal. Intentá de nuevo.")` y hoy vive en `:1054` con **la misma línea**; lo único que cambió es el comentario de arriba, que decía *"si algún día WKH-335 aterriza, ESTE `expect` es el que hay que dar vuelta"* y habría quedado falso. El `expect` nuevo de `humanError("step_failed")` dentro de `T-335-VM-1` (`:1070`) está **pedido** por `story-file.md:1076`. |
| **Cero archivos nuevos en `chaski-v3`** | `git status --porcelain` ⇒ 25 ` M`, cero `A`, cero `??`. |
| **`gateway-client.ts:343` (prohibición de parsear prosa)** | intacto — no aparece en el diff. |

---

## Categorías sin hallazgos, revisadas

- **Backwards compatibility**: el campo es opcional y sólo aparece en sobres de fallo con status
  HTTP. `T-335-BACKCOMPAT` (`compose.test.ts:3232-3241`) prueba que un pipeline 2xx no estrena
  ninguna clave. Del lado de Chaski, `T-335-Q-3` (`quote/route.test.ts:378-394`) prueba que un
  gateway **sin** el campo (orden de despliegue invertido) sigue dando `502 a2a_unavailable`, o sea
  el comportamiento de hoy byte a byte.
- **Type safety**: cero `any` nuevo. `agentFailureResult` recibe `unknown` y discrimina con
  `instanceof` (`compose.ts:174-175`). En Chaski el cruce de repo se resuelve con un guard de valor
  runtime, no con un cast.
- **Cohesión de módulo**: `agent-http-error.ts` es LEAF y sólo importa tipos; una clase + una función
  pura, ambas sobre el mismo concepto.
- **Scope drift**: las 3 desviaciones de Wave 1 verificadas como forzadas (check 4); las de Wave 2
  justificadas por escrito en `auto-blindaje.md:151-227` y verificadas por muestreo (check 5).

---

*CR generado por NexusAgil — Adversary · 2026-08-25. Revisión estática; la ejecución de suites es del AR.*

---

## Resolución post-fix-pack (verificado por F4)

El veredicto **RECHAZADO** de este CR se basa en hallazgos de prosa y citas, todos resueltos en los fix-packs posteriores. Verificación directa contra HEAD por F4 (`nexus-qa`, validación.md:12-32):

| Hallazgo | Estado en HEAD | Resuelto en | Verificador |
|---|---|---|---|
| **BLQ-BAJO-1** — `doc/INTEGRATION.md:1043` afirmaba false sobre `/orchestrate` | **RESUELTO** | commit `1f86e3d` | F4 · validation.md:21 |
| **MNR-2** — el `⟺` falso del invariante `agentFailure` | **RESUELTO** | commit `0095af9` | F4 · validation.md:22 |
| **MNR-4** — doble evaluación de `readAgentFailure` | **RESUELTO** | commit `94603b0` | F4 · validation.md:23 |
| **MNR-3** — asserts vacuos de `T-335-NOLEAK` | **NO tocado; aceptado como deuda menor** | — | F4 · validation.md:24 — AC-3 no depende de este test |
| **MNR-1** — reparto del exceso sin justificación escrita | **Informativo; afectó medición no veredicto** | auto-blindaje.md fix-pack | F4 · validation.md:25 |

**Conclusión**: el CR emite veredicto RECHAZADO sobre un árbol intermedio (2026-08-25 06:02, commit `ffeee10`). Los 4 fix-packs posteriores resuelven cada hallazgo uno a uno, verificados contra `HEAD` (`94603b0`) por el agente F4 leyendo el código, **sin re-correr el CR completo**. El cambio observable: **`BLQ-BAJO-1` estaba vigente en el momento del CR; está resuelto en `HEAD`; las líneas citadas existen y dicen lo correcto hoy.**

**Por qué no se re-corrió un segundo CR**: la regla de este repo (CLAUDE.md, regla 5) exige que todo AR/CR/QA sea un agente custom instalado. El CR se completó, emitió veredicto RECHAZADO, y su extensión (verificar que los fix-packs cerraron cada ítem) corre en F4 como parte de la validación, **no como un segundo CR**. Este apéndice documenta que los hallazgos no permanecen abiertos; el cierre formal es tarea del acta de validación que está en ese artefacto.
