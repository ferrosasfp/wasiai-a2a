# SDD #227 — [WKH-364] Sonda periódica del camino del dinero (Corte A: cotización)

- **Work Item**: `doc/sdd/227-sonda-del-money-path/work-item.md` (HU_APPROVED)
- **Issue**: `ferrosasfp/wasiai-a2a#174`
- **Worktree/rama**: `/home/ferdev/.openclaw/workspace/a2a-sonda`, `feat/227-sonda-money-path`
- **SDD_MODE**: full (QUALITY)

## 1. Resumen

Un script `.mjs` autocontenido y un workflow programado que, cada 30 minutos, leen el
`inputSchema` que **publica producción**, derivan de él el cuerpo de una llamada de
cotización, la ejecutan contra `/compose` con una credencial dedicada, y clasifican el
desenlace en cuatro clases con **cuatro códigos de salida distintos**: PASS(0),
DOWN(2), CONFIG(3), DRIFT(4). El código de salida solo ya atribuye la causa.

Lo que hace a esta sonda distinta de un `curl`: nunca escribe un valor de schema de
memoria, y cuando no puede derivar un valor **falla ruidosamente en vez de inventarlo**.

## 2. Context Map (Codebase Grounding)

### 2.1 Contrato REAL de producción — medido hoy, no recordado

`GET https://wasiai-a2a-production.up.railway.app/discover/remit-corridor-fx-solana`
→ **HTTP 200**, sin autenticación (`src/routes/discover.ts:324-345`, `rateLimit: false`).
Devuelve, entre otros:

```json
"priceUsdc": 0.03,
"metadata": {
  "inputSchema": {
    "type":"object", "required":["amountUsd"],
    "properties":{
      "amountUsd":{"type":"number","exclusiveMinimum":0},
      "destCountry":{"type":"string"},
      "payoutMethod":{"enum":["yape","plin","bank_cci"],"type":"string"}}},
  "outputSchema": {"type":"object","properties":{
      "rate":{...},"feeUsd":{...},"quoteId":{...},"expiresAt":{...},
      "etaMinutes":{...},"provenance":{...},"localCurrency":{...},
      "netDeliveredLocal":{...}}}}
```

Tres hechos que el work-item no tenía y que cambian el diseño:

1. **`required` es `["amountUsd"]` y nada más.** `payoutMethod` y `destCountry` son
   OPCIONALES. El body mínimo conforme es `{"amountUsd": N}`.
2. **`outputSchema` no declara `required`**: de él no se deriva ninguna aserción
   obligatoria. Ver DT-11.
3. **La sonda cuesta plata.** `POST /compose` sin credencial devuelve el desafío x402
   con `maxAmountRequired: "30300000000000000"` (18 decimales) → **0,0303 USDC por
   corrida** (0,03 del agente + ~1% de fee de plataforma). Medido hoy contra prod.

### 2.2 Archivos leídos

| Archivo | Por qué | Qué se extrajo |
|---|---|---|
| `.github/workflows/smoke-downstream.yml:1-95` | Exemplar único del patrón cron+issue | `continue-on-error` sólo en `pull_request` (`:42`); aviso sólo en `schedule` (`:53`); dedup por título exacto con `gh issue list --search "\"$TITULO\" in:title"` (`:74`); cierre automático (`:83-94`); **sin `--label`** a propósito (`:72-73`) |
| `.github/workflows/ci.yml:1-92` | El gate real del repo | `tsc --noEmit` → `npm run lint` → `npm test`, en ese orden. Ningún workflow declara bloque `environment:` |
| `scripts/smoke-downstream-x402.mjs:155-425, 664-699` | Exemplar de script sondeador testeable | Funciones puras exportadas + `main()` + guardia `invokedDirectly` (`:692-693`); patrón de "clean skip" con motivo (`e2eGate`, `:417-425`) |
| `src/middleware/a2a-key.ts:105-122, 522-551` | Cómo se autentica y cómo falla | Header `x-a2a-key` **o** `Authorization: Bearer wasi_a2a_*`; todo fallo de credencial/budget es **403 con `error_code`** ∈ {`KEY_NOT_FOUND`, `KEY_INACTIVE`, `DAILY_LIMIT`, `INSUFFICIENT_BUDGET`, `PER_CALL_LIMIT`, `CHAIN_NOT_SUPPORTED`} |
| `src/types/index.ts:1258-1298, 705` | El contrato de `agentFailure` (CD-5) | `AgentFailureKind = 'INPUT_REJECTED' \| 'AGENT_ERROR'`. Tabla normativa `:1270-1274`: 400/422→`INPUT_REJECTED`; cualquier otro no-2xx→`AGENT_ERROR`; **ausente = "no sé qué contestó el agente"** |
| `src/routes/compose.ts:1092-1131` | Qué status sale de un pipeline fallido | `!result.success` → **400** (o 403 `SCOPE_DENIED`, 402 `DEST_CAP_EXCEEDED`). **Nunca 200.** Un 200 implica `success: true` |
| `src/lib/compose-step-shape.ts:1-56` | Validación previa al débito | El body `{steps:[{agent,input}]}` se valida ANTES del débito; `code: 'VALIDATION_ERROR' \| 'ambiguous_step'` |
| `test/test-files-are-run-in-ci.test.ts:217-274` | **Guardián que este workflow puede romper** | Todo step cuyo `run:` matchee `^npm\s+(?:test\|run\s+test)` y tenga `if:` o `continue-on-error:` cae en `untranslatable` → el guardián se pone **ROJO** (`:308-313`) |
| `test/readme-numbers.test.ts:170-290` | **Guardián que este diff rompe seguro** | `TEST_FILES.length` se deriva del índice de git y se compara contra `**N test files**` (README.md) y `**N archivos de test**` (README.es.md). Hoy publican **304** (`README.md:378`, `README.es.md:412`) |
| `test/cited-lines-guard.citations.ts:51`, `test/cited-lines-guard.exceptions.ts:123`, `test/cited-lines-guard.test.ts:1069`, `test/ownership-filter-guard.exceptions.ts:24`, `test/ownership-filter-guard.scanner.ts:240`, `test/ownership-filter-guard.test.ts:636` | 6 citas a `package.json:11` | `package.json:11` DEBE seguir siendo `"lint": "biome check src/"` y `:13` `"test": "vitest run"` |
| `test/scripts-imported-by-tests-are-tracked.test.ts:48, 119-156` | Guardián de scripts | Todo `.mjs` de `scripts/` nombrado por un test debe estar **trackeado en git** |
| `vitest.config.ts:5-6, 21-32` | Alcance de la suite y umbrales | `include: ['src/**/*.test.ts','test/**/*.test.ts','test/**/*.test.mjs']`; coverage floors 80/70/80/80 |
| `biome.json:8-10` + `package.json:11` | Qué se lintea | `"files": {"includes": ["src/**/*.ts"]}` — **sólo `src/`**. `scripts/` y `test/` no los lintea nadie |
| `tsconfig.json:19` | Qué se typechequea | `"include": ["src/**/*"]`. `scripts/` y `test/` no entran a `tsc --noEmit` |

### 2.3 Auto-Blindaje histórico — patrones recurrentes que este SDD previene

Leídos: `226-wkh-335-.../auto-blindaje.md`, `224-.../`, `223-.../`, `222-.../`, `221-.../`,
`220-.../`.

| Patrón | Dónde se repitió | Se cierra con |
|---|---|---|
| **Archivo nuevo sin `git add` ⇒ gate VERDE FALSO** (los guardianes derivan del índice de git) | 226 (2 entradas), 223 W1, 224 W4, 221 W4 | CD-11 |
| **Mis propias ediciones corren las líneas que yo cito** | 220, 221, 222, 223 (CD-11), 224 | CD-10 |
| **Un número publicado en los DOS README queda falso** | 223 W0, 224 W4, 226 | CD-12 |
| **"Corrí sólo los archivos que toqué y canté verde"** | 222 W2, 226 | CD-13 |
| **Prosa/docblock que afirma algo que su propio archivo no puede refutar** | 221, 224, 226 | CD-9 |

⚠️ **Estado medido al escribir este SDD**: `doc/sdd/227-sonda-del-money-path/` está
**untracked** (`git status --short` → `?? doc/sdd/227-sonda-del-money-path/`). Es
exactamente el disparador del primer patrón. Ver CD-11.

## 3. Decisiones técnicas

### Heredadas del work-item (sin cambios)

DT-1 (sólo cotización), DT-2 (reusar el patrón de `smoke-downstream.yml`),
DT-4 (un reintento en el script), DT-5 (input desde `/discover`, no desde un mirror
de `chaski-v3`), DT-6 (credencial dedicada). Se dan por vigentes y no se reescriben.

### DT-7 — Nombres

| Artefacto | Nombre |
|---|---|
| Workflow | `.github/workflows/probe-money-path.yml`, `name: probe-money-path` |
| Script | `scripts/probe-money-path.mjs` |
| npm script | `probe:money-path`, **última entrada del bloque `scripts`** |
| Test | `test/probe-money-path.test.mjs` |
| Título del issue | `probe-money-path: la corrida por reloj esta fallando` |
| Secret | `A2A_PROBE_KEY` (repo secret) |

Dos de esos nombres **no son cosméticos**:

- **`probe:money-path`, nunca `test:*` ni `probe:test`.**
  `test/test-files-are-run-in-ci.test.ts:228` filtra los steps por
  `^npm\s+(?:test|run\s+test)`, y `:238-245` manda a `untranslatable` cualquiera de
  esos que tenga `if:` o `continue-on-error:`. El step de la sonda **lleva
  `continue-on-error`** (AC-6). Un nombre que empiece por `test` pone ese guardián
  ROJO. `probe:money-path` no matchea el filtro. Verificado contra el regex, no
  supuesto: `npm run smoke:downstream` de `smoke-downstream.yml:41` ya convive con
  `continue-on-error:` en `:42` por la misma razón.
- **La entrada nueva va al FINAL del bloque `scripts`, después de
  `"migrate:preflight"` (`package.json:16`).** Seis archivos citan `package.json:11`
  (ver §2.2) y uno cita `:13`. Insertar en cualquier otra posición corre esas líneas y
  pone rojo `test/cited-lines-guard.test.ts`.

### DT-8 — Cadencia: `cron: '7,37 * * * *'` (cada 30 min, a :07 y :37)

El argumento del costo asimétrico, con los dos números medidos:

- **Los minutos de GitHub Actions NO son la restricción.** El repo es público
  (`gh repo view ferrosasfp/wasiai-a2a --json visibility` → `"PUBLIC"`), y los runners
  estándar son gratis en repos públicos. El presupuesto que sí es finito es otro.
- **La restricción real es USDC**: 0,0303 por corrida (§2.1). Cada 30 min = 48
  corridas/día = **1,4544 USDC/día ≈ 43,63 USDC/30 días**. A cada hora sería 21,82.
- **Costo de un falso negativo**: el escenario que motivó la versión anterior del issue
  fueron *días* de creencia equivocada sobre el estado de producción.
- **Costo de un falso positivo**: un comentario en un issue ya abierto, que se cierra
  solo en la siguiente corrida verde (`smoke-downstream.yml:83-94`).

Los dos costos no se comparan en la misma unidad, y por eso la decisión no es "el
número que parece razonable": es **la cadencia más corta que el presupuesto de USDC
sostiene sin vigilancia**, porque el lado caro es el silencio. 43,63 USDC/mes es una
cifra que el founder puede aceptar o rechazar **con el número delante**; si la rechaza,
la palanca es una sola línea del `cron` y este SDD deja escrita la aritmética para
recalcularla.

`:07` y `:37` y no `:00`/`:30` porque el planificador de GitHub encola masivamente en
el minuto redondo; los minutos impares reducen el retraso de arranque. La latencia de
detección resultante es ≤ ~35 min.

⚠️ La `DAILY_LIMIT` de la agent key (`src/middleware/a2a-key.ts:108`) tiene que quedar
por encima de 48 × 0,0303 = **1,46 USD/día** o la sonda se apagará sola cada tarde. Se
declara acá para que el founder lo fije al crear la credencial; si no, la sonda lo
reporta como **CONFIG**, no como caída (DT-10), que es el punto entero de esta HU.

### DT-9 — El secret: **repo secret** llamado `A2A_PROBE_KEY`

- Ningún workflow del repo declara `environment:` (verificado:
  `grep -n "environment:" .github/workflows/*.yml` → sin resultados). Los 4 entornos
  que existen los creó Railway y sus nombres traen espacios y barras
  (`dependable-tenderness / passport-testnet`): no son entornos curados para Actions.
  Un environment secret exigiría introducir la primera declaración `environment:` del
  repo para un único consumidor. Maquinaria nueva sin beneficio.
- Consecuencia que el diseño debe absorber: en un `pull_request` **desde un fork**
  GitHub no expone secrets, así que `A2A_PROBE_KEY` llega vacío. Eso NO es un fallo de
  producción y no debe leerse como tal → DT-10 fila 0.
- El repo es **público**: el script y el workflow se leen desde internet. La credencial
  nunca se imprime, ni entera ni truncada, y ningún cuerpo de respuesta se vuelca al
  issue (CD-8).

### DT-10 — Escalera de clasificación (resuelve AC-3, AC-8; refina AC-3)

Primera fila que matchea, gana. El **código de salida atribuye la causa por sí solo**.

| # | Condición | Clase | exit | Prefijo del mensaje |
|---|---|---|---|---|
| 0 | `A2A_PROBE_KEY` ausente/vacío | CONFIG | **3** (`0` con `SKIP:` sólo si `GITHUB_EVENT_NAME === 'pull_request'`) | `CONFIG: credencial de sonda ausente (A2A_PROBE_KEY) — esto NO dice nada sobre producción` |
| 1 | `GET /discover/<slug>` da 5xx o error de red (tras 1 reintento) | DOWN | 2 | `DOWN: /discover inalcanzable` |
| 2 | `GET /discover/<slug>` da 404, o 200 sin `metadata.inputSchema` | DRIFT | 4 | `DRIFT: el catálogo ya no publica el inputSchema de <slug>` |
| 3 | La derivación no puede producir un campo de `required` (sin `enum`, sin tipo derivable, o cotas insatisfacibles) | DRIFT | 4 | `DRIFT: campo requerido no derivable: <campo> — la sonda NO inventa valores` |
| 4 | `/compose` responde **403** con `error_code` ∈ los 6 de `a2a-key.ts:105-111` | CONFIG | 3 | `CONFIG: la credencial de la sonda (<error_code>) — producción no está implicada` |
| 5 | `/compose` responde **402** (desafío x402: la key no fue aceptada) | CONFIG | 3 | `CONFIG: la credencial no fue aceptada (402)` |
| 6 | no-2xx con `agentFailure === 'INPUT_REJECTED'` | DRIFT | 4 | `DRIFT: el agente rechazó el input DERIVADO del schema publicado` |
| 7 | no-2xx con `agentFailure === 'AGENT_ERROR'` | DOWN | 2 | `DOWN: el agente contestó un error que no es sobre el pedido` |
| 8 | no-2xx con `code`/`errorCode` de gateway (`VALIDATION_ERROR`, `ambiguous_step`) | DRIFT | 4 | `DRIFT: el gateway rechazó el cuerpo de la sonda (<code>)` |
| 9 | cualquier otro no-2xx, o 5xx, o red tras 1 reintento | DOWN | 2 | `DOWN: candidata a caída real — no hay campo estructurado que atribuya la causa` |
| 10 | 2xx con `success !== true`, o sin `rate`/`netDeliveredLocal` finitos y > 0 | DOWN | 2 | `DOWN: 200 con una cotización que no es una cotización` |
| 11 | resto | PASS | 0 | `PASS:` |

**Exit `1` queda reservado** para una excepción no manejada del propio script — es un
defecto de la sonda, y se distingue de las cuatro clases justamente por no ser
ninguna de ellas.

⚠️ **DT-10 refina AC-3 en un punto, y se declara para el gate en vez de aplicarse en
silencio.** AC-3 dice "4xx **con `agentFailure` presente** → drift". La tabla normativa
de `src/types/index.ts:1270-1274` dice que el campo toma **dos** valores, y que
`AGENT_ERROR` significa *"el agente contestó, y no fue sobre tu pedido"*. Un
`AGENT_ERROR` no es drift de la sonda: es el agente fallando, o sea camino del dinero
roto. Por eso el discriminante es el **VALOR** de `agentFailure`, no su presencia
(filas 6 y 7). Lo que AC-3 sí conserva intacto: la **ausencia** del campo significa "no
sé qué contestó el agente" (`:1276-1284`) y por lo tanto es candidata a caída (fila 9,
la regla por defecto). La fila 8 es la otra carve-out y existe para no repetir el
defecto de origen: un 400 del gateway por un cuerpo mal formado de la sonda no puede
gritar "producción caída". Si el humano prefiere la letra de AC-3, la palanca es
mover las filas 7 y 8; el resto del diseño no cambia.

### DT-11 — Derivación del cuerpo desde el `inputSchema` (AC-1, CD-1)

Función pura y exportada `deriveInput(inputSchema, opts) → {input, omitted, reason?}`.
Recorre **`properties`** del schema recibido en esa misma corrida:

1. Propiedad con **`enum`** → `enum[0]`. Determinista, y es un valor que el agente
   publica sobre sí mismo. `enum` vacío o no-array → DRIFT (fila 3).
2. Propiedad **numérica** (`type` `number`/`integer`) → parte de `PROBE_AMOUNT_USD`
   (env, default `25`) y verifica que satisfaga `exclusiveMinimum`/`minimum`/
   `maximum`/`exclusiveMaximum` declarados. Si no las satisface y no puede ajustarse
   dentro de las cotas → DRIFT.
3. Propiedad **`string` sin `enum`** → **se OMITE si no está en `required`**; si está en
   `required` → DRIFT (fila 3), nunca un valor inventado.
4. Cualquier tipo que no sepa manejar y esté en `required` → DRIFT.
5. Las omitidas se listan en la salida: `omitted: ["destCountry"]`.

**Qué hace la sonda con `destCountry`, que es la pregunta que el work-item deja
abierta**: lo omite, y no afirma nada sobre corredores. Es un `string` libre y no está
en `required` (§2.1). Cualquier valor que la sonda eligiera sería un valor que la sonda
inventó — exactamente CD-1, y exactamente el defecto que produjo el falso "13 días
caída" (`payoutMethod: "bank"`, un valor inventado para un campo que además **sí** tenía
`enum`). Omitir un campo opcional es conforme al schema; inventarlo no lo es.
Y aunque se lo mandara, `wasiai-remittance-agents#2` dice que el agente lo ignora, así
que la sonda no podría afirmar nada del resultado (Scope OUT #6).

**Y el caso general, que es lo que hace que esta regla sobreviva al schema de hoy**: si
mañana un `string` libre entra a `required`, la sonda **no arranca** y dice
`DRIFT: campo requerido no derivable`. Un schema que la sonda no puede satisfacer se
convierte en una señal fuerte y bien atribuida, no en un cuerpo fabricado.

**`PROBE_AMOUNT_USD = 25` no viola CD-1.** CD-1 prohíbe escribir de memoria un valor que
el schema publica. El schema no publica ningún monto: publica una **restricción**
(`exclusiveMinimum: 0`). 25 es un parámetro de la sonda, se declara como tal, y la
sonda **verifica** que satisfaga la restricción publicada antes de mandarlo.

**Huella del schema**: cada corrida imprime `schemaSha256=<12 hex>` sobre el JSON
canónico (claves ordenadas) del `inputSchema`. No cambia ninguna decisión; existe para
que cuando la clasificación pase a DRIFT el log conteste *"¿cambió el schema hoy?"* sin
una sesión de arqueología. ~10 líneas con `node:crypto`.

### DT-12 — Qué se afirma de una respuesta 2xx, y qué NO

- **SÍ**: `success === true`; `steps[0].output.rate` y `.netDeliveredLocal` finitos y
  `> 0`; y que esos dos nombres **existan en `outputSchema.properties`** del card leído
  en la misma corrida (si no existen → DRIFT, no PASS). Ese cruce es el puente que ancla
  la aserción al contrato publicado aunque `outputSchema` no declare `required` (§2.1).
- **NO**: ninguna banda de valor para `rate`. Una banda FX es un generador de falsos
  rojos con fecha de vencimiento — el riesgo #1 de esta HU convertido en código.
- **NO**: nada sobre `localCurrency`, `destCountry` ni corredor (Scope OUT #6).

### DT-13 — El reintento (DT-4), acotado

Un reintento, con 2 s de espera, y **sólo** ante rechazo de `fetch` a nivel conexión
(`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`). **Nunca ante `AbortError` de
timeout en el `POST /compose`**: un POST que expiró puede haberse ejecutado y debitado
del otro lado, y reintentarlo paga dos veces por una medición que no aclara nada. El
`GET /discover` sí se reintenta ante timeout (idempotente).

### DT-14 — Demostración del rojo (AC-4, CD-3)

Tres procedimientos ejecutables; los tres archivan su log en
`doc/sdd/227-sonda-del-money-path/evidence/`.

| ID | Procedimiento | Esperado | Costo |
|---|---|---|---|
| **D-1** | `A2A_PROBE_KEY=wasi_a2a_credencial_invalida_demo npm run probe:money-path` | `CONFIG: ... (KEY_NOT_FOUND)`, **exit 3**. Una key con prefijo `wasi_a2a_` entra por la rama de agent key (`a2a-key.ts:546-551`) y cae en `send403('KEY_NOT_FOUND')`; una sin el prefijo cae al x402 y da 402 — las dos son CONFIG | 0 USDC (no hay débito sin key válida) |
| **D-2** | `PROBE_SELF_TEST_OMIT_REQUIRED=amountUsd npm run probe:money-path` con la credencial real | `DRIFT`, **exit 4**, vía `agentFailure: 'INPUT_REJECTED'`. Es además la verificación viva de que WKH-335 sigue emitiendo el campo del que depende CD-5 | ≤ 0,0303 USDC |
| **D-3** | `workflow_dispatch` con input `self_test: true` sobre la rama de la HU | **Job rojo en la UI de Actions**, sin issue: el paso sólo lleva `continue-on-error` en `pull_request`, y el aviso sólo corre en `schedule` | ≤ 0,0303 USDC |

Total de la demostración: **≤ 0,061 USDC**.

**El interruptor de auto-test es un footgun, y se cierra con mecanismo, no con una
advertencia.** `PROBE_SELF_TEST_OMIT_REQUIRED` (a) imprime un banner
`SELF-TEST: corrida DELIBERADAMENTE rota — NO mide producción`, (b) **no puede terminar
en 0 jamás**: si el gateway aceptara el cuerpo inválido, la sonda sale con **exit 5**
(`el gateway aceptó un cuerpo que viola el schema publicado`), que es un hallazgo en sí
mismo, y (c) un test unitario afirma que `.github/workflows/probe-money-path.yml` sólo
lo cablea desde el input de `workflow_dispatch` y **nunca** como literal.

### DT-15 — Los tres riesgos de la HU, con su mecanismo

| Riesgo | Mecanismo (no intención) |
|---|---|
| **Su input queda viejo y grita "producción caída"** | El schema se lee en cada corrida (DT-11); lo no derivable es DRIFT, no un valor inventado; la escalera separa DRIFT(4) de DOWN(2) con el mensaje distinto (DT-10); `schemaSha256` en el log atribuye el cambio; DT-12 prohíbe la banda FX |
| **Avisa de más y alguien la apaga** | Un issue con título fijo, deduplicado, que **se cierra solo** al primer verde (heredado, `smoke-downstream.yml:83-94`); `pull_request` informativo (AC-6); un reintento acotado absorbe el blip de red (DT-13); un fallo CONFIG dice CONFIG y no manda a nadie a mirar Railway |
| **Su verde nunca se vio en rojo** | D-1/D-2/D-3 con log archivado (DT-14) + un test unitario por cada fila de la escalera de DT-10 (§6) |

## 4. Diseño

### 4.1 Archivos

| Archivo | Acción | Contenido |
|---|---|---|
| `scripts/probe-money-path.mjs` | crear | Funciones puras exportadas `deriveInput`, `classify`, `schemaFingerprint`, `assertQuoteShape`; `main()`; guardia `invokedDirectly` (patrón `smoke-downstream-x402.mjs:692-693`) |
| `test/probe-money-path.test.mjs` | crear | Suite unitaria, **cero red** |
| `.github/workflows/probe-money-path.yml` | crear | `on: schedule \| pull_request \| workflow_dispatch`; permisos `contents: read` + `issues: write`; pasos de checkout/node/`npm ci`/probe/issue-open/issue-close |
| `package.json` | modificar | **+1 línea al final del bloque `scripts`** (después de `:16`) |
| `README.md`, `README.es.md` | modificar | 1 línea cada uno: `304` → el número **derivado**, no copiado (CD-12) |
| `doc/sdd/227-.../evidence/*.log` | crear | 3 logs de DT-14 |

**Diff sobre `src/`: vacío** (CD-2).

### 4.2 Flujo principal

```
main()
 ├─ readCredential(env)                 → fila 0 si falta
 ├─ GET /discover/remit-corridor-fx-solana   (1 reintento, incl. timeout)
 │    → filas 1-2
 ├─ schemaFingerprint(inputSchema)      → log
 ├─ deriveInput(inputSchema)            → filas 3; log de `omitted`
 ├─ [self-test] borra el campo pedido + banner
 ├─ POST /compose {steps:[{agent, input}]}  con `x-a2a-key`
 │    (1 reintento SÓLO ante error de conexión — DT-13)
 │    → filas 4-9
 ├─ assertQuoteShape(body, outputSchema) → filas 10
 └─ PASS(0)
```

Una línea final a stdout, siempre, con el formato
`<CLASE>: <mensaje> | agent=<slug> schemaSha256=<hex> omitted=[...] httpStatus=<n> agentFailure=<kind|-> durationMs=<n>`.

### 4.3 Workflow

- `on: schedule: - cron: '7,37 * * * *'`; `pull_request`; `workflow_dispatch` con input
  booleano `self_test`.
- Step de la sonda: `run: npm run probe:money-path` con
  `continue-on-error: ${{ github.event_name == 'pull_request' }}` (idéntico a
  `smoke-downstream.yml:42`) y
  `env: A2A_PROBE_KEY: ${{ secrets.A2A_PROBE_KEY }}` +
  `PROBE_SELF_TEST_OMIT_REQUIRED: ${{ inputs.self_test && 'amountUsd' || '' }}`.
- Aviso: `if: failure() && github.event_name == 'schedule'` — copia estructural de
  `smoke-downstream.yml:52-94`, con el título de DT-7 y **sin `--label`** (`:72-73`).
- El cuerpo del issue **no afirma la causa** (misma disciplina que `:50-51`): pega la
  línea de clase que emitió la sonda y manda al log. Ninguna respuesta cruda.

## 5. Constraint Directives

Heredados del work-item, vigentes sin cambio: **CD-1** (nada de body hardcodeado),
**CD-2** (diff vacío sobre `src/`), **CD-3** (demostrar el rojo), **CD-4** (nada de
depósito/payout), **CD-5** (`agentFailure`, y PROHIBIDO re-parsear el string de `error`
con regex).

Nuevos:

- **CD-6**: el npm script **NO** puede llamarse `test*` ni empezar por `test`. Motivo
  medido en DT-7. PROHIBIDO también agregar al workflow cualquier step cuyo `run:`
  empiece por `npm test` / `npm run test` mientras el job lleve `continue-on-error`.
- **CD-7**: la entrada nueva de `package.json#scripts` va **después de la línea 16**.
  PROHIBIDO insertar antes: 6 archivos citan `package.json:11`.
- **CD-8**: PROHIBIDO imprimir la credencial (entera o truncada) o volcar cuerpos de
  respuesta crudos al issue. El repo es **público**.
- **CD-9**: PROHIBIDO que el mensaje del issue afirme una causa que la sonda no midió.
  Dice la clase que emitió y manda al log. (Patrón "prosa que afirma de más", §2.3.)
- **CD-10**: si alguna edición desplaza una línea citada, se re-ancla la cita **en el
  mismo commit**. Verificación: `npm test` completo, que corre
  `test/cited-lines-guard.test.ts`.
- **CD-11**: OBLIGATORIO `git add` de **todo** archivo nuevo (incluida la carpeta
  `doc/sdd/227-sonda-del-money-path/`, hoy untracked) **ANTES** de correr el gate. Los
  guardianes derivan del índice de git: sin esto el gate da **verde falso**.
- **CD-12**: OBLIGATORIO actualizar el conteo de archivos de test en `README.md:378` y
  `README.es.md:412`. El número se **deriva** corriendo el gate y leyendo el rojo de
  `test/readme-numbers.test.ts`; PROHIBIDO copiar el `305` que este SDD supone.
- **CD-13**: el cierre corre el gate **completo y en orden**:
  `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`. Correr sólo los
  archivos tocados no es correr el gate. (⚠️ `npm run qa` **no existe** en este repo.)
- **CD-14**: la sonda **observa**. PROHIBIDO cualquier `POST`/`PATCH`/`DELETE` que no
  sea el único `POST /compose` del camino de cotización (AC-7).
- **CD-15**: PROHIBIDO afirmar corredor, país o moneda local en cualquier aserción o
  mensaje (Scope OUT #6, `wasiai-remittance-agents#2`).

## 6. Plan de tests — `test/probe-money-path.test.mjs`, cero red

| ID | AC | Qué prueba | Por qué no es vacuo |
|---|---|---|---|
| T-1 | AC-1 | `deriveInput` con un schema cuyo `enum` es `["plin","yape"]` devuelve `payoutMethod: "plin"` | **Mata la implementación hardcodeada**: si el script escribiera `"yape"` de memoria, este test se pone rojo. Es el único test que distingue "derivó" de "acertó" |
| T-2 | AC-1 | Con el schema REAL de §2.1 (fixture literal), `deriveInput` produce `{amountUsd:25, payoutMethod:"yape"}` y `omitted:["destCountry"]` | Ancla la decisión de `destCountry` |
| T-3 | AC-1 | Un `string` libre **en `required`** ⇒ `{reason:'required-not-derivable', field}`, sin `input` | El caso general de DT-11, el que sobrevive al schema de hoy |
| T-4 | AC-1 | `enum: []`, y cotas insatisfacibles (`minimum:10, maximum:5`) ⇒ DRIFT | Los dos bordes de la derivación |
| T-5 | AC-3 | `classify` sobre las 12 filas de DT-10, una por una, incluidos `INPUT_REJECTED`→4 y `AGENT_ERROR`→2 | Es la tabla ejecutable: la escalera no vive sólo en prosa |
| T-6 | AC-3 | El mensaje de DRIFT y el de DOWN son **distinguibles** por su prefijo, y ninguno contiene la palabra del otro | AC-3 pide distinción explícita en el mensaje, no sólo en el código |
| T-7 | AC-8 | Credencial ausente ⇒ exit 3 con `CONFIG: credencial de sonda ausente`; y con `GITHUB_EVENT_NAME=pull_request` ⇒ exit 0 con `SKIP:` | DT-9/fila 0 |
| T-8 | AC-5, AC-6 | Leyendo el YAML: el step de la sonda tiene `continue-on-error` acotado a `pull_request`; el step de aviso tiene `if: failure() && github.event_name == 'schedule'`; el de cierre `success() && ... 'schedule'`; el título es idéntico en los dos | Los tres son afirmaciones sobre el archivo real, no sobre lo que el SDD dice que tiene |
| T-9 | AC-4 | El YAML **no** contiene `PROBE_SELF_TEST_OMIT_REQUIRED` como literal fuera de la expresión de `inputs.self_test` | Cierra el footgun de DT-14 mecánicamente |
| T-10 | AC-2, CD-4 | El fuente del script no contiene `deposit`, `payout`, `settle`, `orchestrate`, y su único método no-GET es un `POST` a `/compose` | CD-4 + CD-14 ejecutables |
| T-11 | AC-7, CD-15 | Ninguna aserción del script menciona `PEN`, `localCurrency`, `destCountry` como valor esperado | CD-15 ejecutable |
| T-12 | AC-1, CD-6 | El nombre del npm script no matchea `^test` y `package.json:11` sigue conteniendo `biome check src/` | Los dos guardianes que este diff puede romper, verificados desde adentro |

Y los **guardianes ya existentes** que este diff activa y deben quedar verdes:
`test/scripts-imported-by-tests-are-tracked.test.ts` (el `.mjs` trackeado),
`test/test-files-are-run-in-ci.test.ts` (el workflow nuevo traducible),
`test/readme-numbers.test.ts` (el conteo).

**Cobertura**: el `.mjs` entra al reporte de coverage al importarlo la suite. Los
umbrales son globales (80/70/80/80) y la medición del 2026-08-15 estaba 7,5-12,5 puntos
por encima (`vitest.config.ts:23-25`); un archivo de ~260 líneas bien cubierto no los
mueve. Si el gate se pusiera rojo por coverage, **se sube la cobertura del script, no se
baja el umbral**.

## 7. Presupuesto de diff (el CR lo contrasta — regla 10)

| Archivo | Líneas presupuestadas |
|---|---|
| `scripts/probe-money-path.mjs` | 260 |
| `test/probe-money-path.test.mjs` | 220 |
| `.github/workflows/probe-money-path.yml` | 95 |
| `package.json` | 1 |
| `README.md` + `README.es.md` | 2 |
| **Total (sin `doc/`)** | **≈ 578 líneas, 6 archivos** |

Techo de 2x: **1156 líneas**. Por encima de eso, se justifica por escrito o se recorta.

*¿Qué parte seguiría existiendo si esto lo escribiera alguien que ya conoce GitHub
Actions?* El workflow es una copia estructural del exemplar: ~95 líneas de las cuales
~35 son comentarios que explican por qué cada gate está donde está — esas se justifican
por la cultura del repo, no por la técnica. El grueso irreductible es
`deriveInput` + `classify` + su suite: ahí está todo lo que esta HU decide y nada que
GitHub Actions provea. **Lo primero que se recorta si el diff se pasa: los docblocks
del `.mjs`, nunca un caso de T-5.**

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| El founder no crea la credencial (Missing Input bloqueante del work-item) | F3 puede escribir y testear todo sin ella (la suite no toca la red). Sin ella no se cierran AC-2, AC-4 (D-2/D-3) ni el DONE. D-1 **sí** corre sin credencial válida |
| La `DAILY_LIMIT` de la key queda por debajo de 1,46 USD/día | La sonda lo reporta CONFIG, no caída (DT-10 fila 4). El número está en DT-8 para que el founder lo fije |
| El agente cambia su `inputSchema` | La derivación lo absorbe; lo no derivable es DRIFT con `schemaSha256` en el log |
| `wasiai-remittance-agents#2` se arregla y `destCountry` pasa a `required` | Fila 3 → DRIFT ruidoso y bien atribuido. La sonda no fabrica un país |
| Un `pull_request` de fork sin secret genera ruido | Fila 0 + `SKIP:` en exit 0 sólo para `pull_request` (DT-9/DT-10) |

## 9. Missing Inputs

- **[bloqueante, sin cambio]** Creación de la agent key dedicada. Este SDD aporta lo que
  faltaba para crearla: **presupuesto ≥ 44 USDC/30 días** y **`DAILY_LIMIT` > 1,46
  USD/día** (DT-8), y el nombre del secret **`A2A_PROBE_KEY`** como repo secret (DT-9).
- **[resuelto]** Cadencia → DT-8. Nombres → DT-7. Secret → DT-9. Derivación → DT-11.
  Drift vs caída → DT-10. Demostración del rojo → DT-14.
- **[sigue fuera de alcance, no asumido]** Canal de alerta adicional a GitHub Issues
  (Scope OUT #8). No se diseña nada de Discord.

## 10. Uncertainty Markers

- **`[DECISIÓN PARA EL GATE]`** DT-10 refina AC-3: el discriminante es el **valor** de
  `agentFailure`, no su presencia (filas 6 y 7), y un 400 del gateway con `code`
  estructurado es DRIFT (fila 8). Documentado con la razón y con la palanca para
  revertirlo. No es una ambigüedad: es una decisión del Architect que el humano puede
  rechazar en SPEC_APPROVED.
- **`[HEREDADO, NO VERIFICABLE ACÁ]`** DT-5: `chaski-v3` no está en este disco. No se
  toca; el diseño no depende de ese repo.
- **`[MEDIDO HOY, PUEDE ENVEJECER]`** El precio 0,0303 USDC y el `inputSchema` de §2.1
  se midieron contra prod el 2026-08-25. El diseño **no depende** de que sigan iguales:
  el schema se relee cada corrida y el precio sólo alimenta la aritmética de DT-8.

## 11. Readiness Check

| # | Check | Estado |
|---|---|---|
| 1 | Los 6 puntos abiertos del work-item están resueltos con criterio escrito | ✅ DT-7 · DT-8 · DT-9 · DT-11 · DT-10 · DT-14 |
| 2 | Cero `[NEEDS CLARIFICATION]` | ✅ los dos del work-item resueltos (nombres → DT-7; alerta extra → sigue en Scope OUT, decisión explícita) |
| 3 | Todos los exemplars verificados con path y rango real | ✅ §2.2, 13 entradas, todas leídas |
| 4 | Contrato de producción medido, no recordado | ✅ §2.1 (`/discover` 200 y `/compose` 402 ejecutados hoy) |
| 5 | Cada AC tiene ≥ 1 test | ✅ §6, T-1..T-12 cubren AC-1..AC-8 |
| 6 | Los 3 riesgos propios de la HU tienen mecanismo | ✅ DT-15 |
| 7 | Presupuesto de diff declarado | ✅ §7, 578 líneas / 6 archivos |
| 8 | CDs del work-item heredados | ✅ CD-1..CD-5 + CD-6..CD-15 |
| 9 | Auto-Blindaje histórico incorporado | ✅ §2.3 → CD-9..CD-13 |
| 10 | Guardianes existentes que el diff activa, identificados | ✅ 4 (`readme-numbers`, `test-files-are-run-in-ci`, `scripts-imported-by-tests-are-tracked`, `cited-lines-guard`) |
| 11 | Bloqueante que impide DONE, declarado | ⚠️ §9: la credencial es del founder. **F2.5 y F3 pueden avanzar; el DONE no.** |

**Veredicto: LISTO PARA SPEC_APPROVED**, con la salvedad del ítem 11 (bloqueante de
founder, ya conocido y heredado del work-item) y la decisión del ítem 10 de §10 puesta
sobre la mesa para el gate.
