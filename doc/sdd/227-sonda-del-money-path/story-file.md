# Story File — [WKH-364] Sonda periódica del camino del dinero (Corte A: cotización)

- **SDD**: `doc/sdd/227-sonda-del-money-path/sdd.md` (SPEC_APPROVED)
- **Worktree**: `/home/ferdev/.openclaw/workspace/a2a-sonda` · rama `feat/227-sonda-money-path`
- **Issue**: `ferrosasfp/wasiai-a2a#174`
- **Presupuesto de diff**: **578 líneas / 6 archivos** (techo 2x = 1156). El CR lo contrasta.

> Este documento es **autocontenido**. No abras el SDD ni el work-item: todo lo que
> necesitás está acá. Si algo no está acá, **no lo inventes** — paralo y avisá.

---

## 1. Qué se construye, y por qué

Una **sonda periódica** que ejercita el camino del dinero contra los servicios **vivos**
de producción, con el input **derivado del `inputSchema` que publica el catálogo en cada
corrida**, nunca inventado.

Hoy la única forma de saber si la cotización anda es que alguien arme un `curl` a mano, y
está medido que un `curl` inventado **miente en las dos direcciones**: la versión anterior
del issue #174 afirmó "13 días caída en producción" y era **falso** — lo producía una
sonda del propio orquestador mandando `payoutMethod: "bank"`, un valor fuera del `enum`
publicado (`yape`, `plin`, `bank_cci`). La cotización nunca estuvo caída.

Por eso la regla central de esta HU no es "sondear": es **cuando no puede derivar un
valor, la sonda falla ruidosamente en vez de inventarlo**.

Flujo, en una línea:

```
GET /discover/<slug>  →  deriveInput(inputSchema)  →  POST /compose  →  classify()  →  exit 0|2|3|4
```

**Cuatro clases, cuatro códigos de salida distintos. El exit code solo ya atribuye la causa.**

| Clase | exit | Significa |
|---|---|---|
| **PASS** | 0 | El camino del dinero cotiza |
| **DOWN** | 2 | Candidata a caída real de producción |
| **CONFIG** | 3 | Problema de la credencial/config de la sonda — **producción no está implicada** |
| **DRIFT** | 4 | La sonda quedó vieja respecto del contrato publicado |
| *(reservado)* | 1 | Excepción no manejada del script = defecto de la sonda |
| *(self-test)* | 5 | El gateway aceptó un cuerpo que viola el schema publicado |

---

## 2. Scope IN — la lista exacta de archivos

| # | Archivo | Acción | Presupuesto |
|---|---|---|---|
| 1 | `scripts/probe-money-path.mjs` | **crear** | 260 líneas |
| 2 | `test/probe-money-path.test.mjs` | **crear** | 220 líneas |
| 3 | `.github/workflows/probe-money-path.yml` | **crear** | 95 líneas |
| 4 | `package.json` | **modificar** — +1 línea, **después de la línea 16** | 1 línea |
| 5 | `README.md` | **modificar** — 1 línea (el conteo de archivos de test) | 1 línea |
| 6 | `README.es.md` | **modificar** — 1 línea (el conteo de archivos de test) | 1 línea |
| 7 | `doc/sdd/227-sonda-del-money-path/evidence/*.log` | **crear** — 3 logs (D-1, D-2, D-3) | fuera del presupuesto |

**Diff sobre `src/`: VACÍO.** Es CD-2 y es verificable con un comando.

### Lo que el Dev NO hace

- **No crea la credencial ni setea el secret `A2A_PROBE_KEY`** — es del founder. Podés
  escribir y testear todo sin ella: la suite no toca la red.
- **No toca `src/`**, ni `/compose`, ni `/discover`, ni Chaski, ni ningún agente.
  **La sonda observa.**
- **No implementa el paso de depósito ni de payout** — es Corte B, HU aparte.
- **No agrega canales de alerta** (Discord, PagerDuty). Sólo GitHub Issues.

---

## 3. Anti-Hallucination Checklist — específico de esta HU

Marcá cada una **antes** de escribir código. Cada línea salió de una medición, no de una intuición.

- [ ] **El npm script se llama `probe:money-path`.** ⛔ NUNCA `test:*`, ni `probe:test`, ni
      nada que empiece por `test`. `test/test-files-are-run-in-ci.test.ts:228` filtra los
      steps de CI con el regex `^npm\s+(?:test|run\s+test)`, y `:238-245` manda a la lista
      `untranslatable` cualquiera de esos que lleve `if:` o `continue-on-error:`. El step
      de la sonda **lleva `continue-on-error`** (AC-6). Un nombre que empiece por `test`
      pone ese guardián **ROJO** (la aserción es `expect(untranslatable).toEqual([])`, en
      `:308-313`). `probe:money-path` no matchea el regex.
- [ ] **La entrada nueva de `package.json#scripts` va DESPUÉS de la línea 16.** Hoy `:16`
      es `"migrate:preflight": "node scripts/migrate-preflight.mjs"` y `:17` es el `}` que
      cierra el bloque. ⛔ Insertar en cualquier otra posición desplaza `package.json:11`
      (`"lint": "biome check src/"`), que está **citado por 6 archivos**
      (`test/cited-lines-guard.citations.ts:51`, `test/cited-lines-guard.exceptions.ts:123`,
      `test/cited-lines-guard.test.ts:1069`, `test/ownership-filter-guard.exceptions.ts:24`,
      `test/ownership-filter-guard.scanner.ts:240`, `test/ownership-filter-guard.test.ts:636`)
      y pone rojo `test/cited-lines-guard.test.ts`. `:13` (`"test": "vitest run"`) también
      está citado.
- [ ] **`README.md` y `README.es.md` entran al Scope IN aunque el work-item no los listaba.**
      `test/readme-numbers.test.ts:275-284` deriva `TEST_FILES.length` del índice de git y
      lo compara contra `**N test files**` (`README.md:378`) y `**N archivos de test**`
      (`README.es.md:412`). Hoy los dos publican **304**. Esta HU agrega un archivo de test
      ⇒ **los dos README quedan falsos**. El número se **deriva corriendo el gate y leyendo
      el rojo**; ⛔ PROHIBIDO copiar el `305` que este documento supone.
- [ ] **`git add` de TODO archivo nuevo ANTES de correr el gate.** 7 familias de guardianes
      derivan de `git ls-files`: un archivo untracked les es **invisible** ⇒ **gate verde
      falso**. `doc/sdd/227-sonda-del-money-path/` ya está en el índice; mantené esa
      disciplina con los 6 archivos que creás. Este patrón se repitió en las HUs 221, 223,
      224 y 226 (dos veces).
- [ ] **El discriminante de la escalera es el VALOR de `agentFailure`, no su presencia.**
      `INPUT_REJECTED` ⇒ **DRIFT** (la sonda quedó vieja). `AGENT_ERROR` ⇒ **DOWN** (el
      agente contestó un error que no es sobre el pedido). Esto **refina el AC-3 literal a
      propósito y está aprobado en SPEC_APPROVED**: ⛔ no lo "corrijas" hacia atrás.
- [ ] **`agentFailure` AUSENTE ≠ `AGENT_ERROR`.** Ausente significa *"no sé qué contestó el
      agente en el intento que decidió"* (`src/types/index.ts:1272-1284`) ⇒ candidata a
      caída (fila 9, la regla por defecto). Presente-con-`AGENT_ERROR` significa
      *"contestó, y no fue sobre tu pedido"*.
- [ ] ⛔ **PROHIBIDO re-parsear el string de `error` con una regex** para recuperar el
      status del agente. Es exactamente el patrón que WKH-335 cerró. Se usa el campo
      estructurado `agentFailure` y nada más (CD-5).
- [ ] **Toda falla de credencial o de budget llega como HTTP 403 con `error_code`**, nunca
      como `agentFailure`. Los 6 códigos son exactamente estos
      (`src/middleware/a2a-key.ts:105-111`): `KEY_NOT_FOUND`, `KEY_INACTIVE`,
      **`DAILY_LIMIT`**, `INSUFFICIENT_BUDGET`, `PER_CALL_LIMIT`, `CHAIN_NOT_SUPPORTED`.
      Eso da la clase CONFIG **sin heurística** y cierra AC-8. ⚠️ `SCOPE_DENIED` fue
      **removido** de esa union (`:112-114`): el middleware nunca lo emite.
- [ ] **La credencial se manda en el header `x-a2a-key`.** (También existe
      `Authorization: Bearer wasi_a2a_*`; usá el primero.)
- [ ] ⛔ **PROHIBIDO imprimir la credencial**, entera o truncada, y ⛔ PROHIBIDO volcar
      cuerpos de respuesta crudos al issue. **El repo es PÚBLICO**: el script y el workflow
      se leen desde internet.
- [ ] **`required` del schema real es `["amountUsd"]` y nada más.** `payoutMethod` y
      `destCountry` son **opcionales**. El body mínimo conforme es `{"amountUsd": N}`.
- [ ] **`destCountry` se OMITE.** Es un `string` libre sin `enum` y no está en `required`.
      Cualquier valor que la sonda eligiera sería un valor que **la sonda inventó** —
      exactamente CD-1 y exactamente el defecto de origen. Omitir un campo opcional es
      conforme al schema; inventarlo no lo es.
- [ ] ⛔ **PROHIBIDA cualquier banda de valor para `rate`.** Una banda FX es un generador
      de falsos rojos con fecha de vencimiento — es el riesgo #1 de esta HU convertido en
      código.
- [ ] ⛔ **PROHIBIDO afirmar corredor, país o moneda local** en cualquier aserción o
      mensaje (CD-15). El agente ignora `destCountry` y cotiza Perú siempre
      (`wasiai-remittance-agents#2`): la sonda no puede afirmar nada sobre eso.
- [ ] **El único método no-GET del script es el único `POST /compose`** (CD-14). ⛔ Ningún
      otro `POST`/`PATCH`/`DELETE`.
- [ ] **Si tu edición desplaza una línea que alguien cita, se re-ancla la cita en el mismo
      commit** (CD-10). Se verifica con `npm test` completo.
- [ ] **Ningún docblock afirma algo que su propio archivo no pueda refutar** (CD-9). Cada
      frase que termina en instrucción o afirmación tiene que ser falsable con un input
      concreto.

---

## 4. El contrato REAL de producción (medido, no recordado)

`GET https://wasiai-a2a-production.up.railway.app/discover/remit-corridor-fx-solana`
→ **HTTP 200**, **sin autenticación** (`src/routes/discover.ts:324-345`, `rateLimit: false`;
404 con `{error:'Agent not found'}` si el slug no existe, `:338-340`).

```jsonc
"priceUsdc": 0.03,
"metadata": {
  "inputSchema": {
    "type": "object",
    "required": ["amountUsd"],
    "properties": {
      "amountUsd":    { "type": "number", "exclusiveMinimum": 0 },
      "destCountry":  { "type": "string" },
      "payoutMethod": { "type": "string", "enum": ["yape", "plin", "bank_cci"] }
    }
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "rate": {...}, "feeUsd": {...}, "quoteId": {...}, "expiresAt": {...},
      "etaMinutes": {...}, "provenance": {...}, "localCurrency": {...},
      "netDeliveredLocal": {...}
    }
  }
}
```

Tres hechos que cambian el diseño:

1. **`required` es `["amountUsd"]`**, nada más.
2. **`outputSchema` NO declara `required`** ⇒ de él no se deriva ninguna aserción
   obligatoria. Lo que sí se hace es cruzar los nombres (§7, DT-12).
3. **La sonda cuesta plata.** `POST /compose` sin credencial devuelve el desafío x402 con
   `maxAmountRequired: "30300000000000000"` (18 decimales) ⇒ **0,0303 USDC por corrida**
   (0,03 del agente + ~1% de fee de plataforma).

   ⚠️ **CORRECCIÓN — FIX-PACK 3, 2026-08-26.** Ese `30300000000000000` a 18 decimales **no
   es USDC**: es **PYUSD** (`asset 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`) sobre
   `eip155:2368` = **kite-ozone-testnet**, la red DEFAULT del gateway, que era la que
   contestaba porque la sonda no mandaba `x-payment-chain`. Desde el fix-pack 3 la sonda
   declara la red de Chaski y el mismo 402 devuelve `network solana:EtWTRABZ…`,
   `asset 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (**USDC de devnet**, **6**
   decimales) y `maxAmountRequired: "30300"` ⇒ **0,0303 USDC**. El monto y toda la
   aritmética de presupuesto que se derivan de él **no cambian**; el activo, la red y la
   escala de decimales sí. Medición completa en
   `evidence/402-red-de-cobro-con-y-sin-cabecera.log`.

**Body del `POST /compose`** — shape verificado en `src/types/index.ts:984-1005` y validado
antes del débito por `src/lib/compose-step-shape.ts`:

```json
{ "steps": [ { "agent": "remit-corridor-fx-solana", "input": { ...derivado... } } ] }
```

**Qué status sale de un pipeline fallido** (`src/routes/compose.ts:1113-1119`): `!success`
→ **400**, salvo `errorCode === 'SCOPE_DENIED'` → 403 y `errorCode === 'DEST_CAP_EXCEEDED'`
→ 402. **Nunca 200.** Un 200 implica `success: true`.

**Códigos del gateway pre-débito** (`src/lib/compose-step-shape.ts:33`):
`code: 'VALIDATION_ERROR' | 'ambiguous_step'`.

---

## 5. La escalera de clasificación — el corazón de la HU

**Primera fila que matchea, gana.** El código de salida atribuye la causa por sí solo.

| # | Condición | Clase | exit | Prefijo del mensaje |
|---|---|---|---|---|
| **0** | `A2A_PROBE_KEY` ausente o vacío | CONFIG | **3** — pero **`0` con `SKIP:`** si `GITHUB_EVENT_NAME === 'pull_request'` | `CONFIG: credencial de sonda ausente (A2A_PROBE_KEY) — esto NO dice nada sobre producción` |
| 1 | `GET /discover/<slug>` da 5xx o error de red (tras 1 reintento) | DOWN | 2 | `DOWN: /discover inalcanzable` |
| 2 | `GET /discover/<slug>` da 404, o 200 sin `metadata.inputSchema` | DRIFT | 4 | `DRIFT: el catálogo ya no publica el inputSchema de <slug>` |
| 3 | La derivación no puede producir un campo de `required` (sin `enum`, sin tipo derivable, o cotas insatisfacibles) | DRIFT | 4 | `DRIFT: campo requerido no derivable: <campo> — la sonda NO inventa valores` |
| 4 | `/compose` responde **403** con `error_code` ∈ los 6 de `a2a-key.ts:105-111` | CONFIG | 3 | `CONFIG: la credencial de la sonda (<error_code>) — producción no está implicada` |
| 5 | `/compose` responde **402** (desafío x402: la key no fue aceptada) | CONFIG | 3 | `CONFIG: la credencial no fue aceptada (402)` |
| 6 | no-2xx con **`agentFailure === 'INPUT_REJECTED'`** | DRIFT | 4 | `DRIFT: el agente rechazó el input DERIVADO del schema publicado` |
| 7 | no-2xx con **`agentFailure === 'AGENT_ERROR'`** | DOWN | 2 | `DOWN: el agente contestó un error que no es sobre el pedido` |
| 8 | no-2xx con `code`/`errorCode` de gateway (`VALIDATION_ERROR`, `ambiguous_step`) | DRIFT | 4 | `DRIFT: el gateway rechazó el cuerpo de la sonda (<code>)` |
| 9 | cualquier otro no-2xx, o 5xx, o red tras 1 reintento | DOWN | 2 | `DOWN: candidata a caída real — no hay campo estructurado que atribuya la causa` |
| 10 | 2xx con `success !== true`, o sin `rate`/`netDeliveredLocal` finitos y `> 0` | DOWN | 2 | `DOWN: 200 con una cotización que no es una cotización` |
| 11 | resto | PASS | 0 | `PASS:` |

**Exit `1` queda reservado** para una excepción no manejada del propio script: es un
defecto de la sonda y se distingue de las cuatro clases justamente por no ser ninguna.

### Por qué las filas 6 y 7 se separan por VALOR

`src/types/index.ts:1269-1274` es la tabla normativa: `400/422 → 'INPUT_REJECTED'`;
*cualquier otro no-2xx* `→ 'AGENT_ERROR'`; *sin status HTTP* → **campo AUSENTE**.

Un `AGENT_ERROR` **no es drift de la sonda**: es el agente fallando, o sea camino del
dinero roto. Por eso el discriminante es el **VALOR**, no la presencia. Lo que AC-3
conserva intacto: la **ausencia** significa "no sé qué contestó el agente" ⇒ fila 9. La
fila 8 es la otra carve-out y existe para no repetir el defecto de origen: un 400 del
gateway por un cuerpo mal formado de la sonda **no puede gritar "producción caída"**.

### Por qué la fila 0 sale con exit 0 en `pull_request`

`A2A_PROBE_KEY` es un **repo secret**, y GitHub **no expone secrets a un `pull_request`
desde un fork** ⇒ llega vacío. Eso no es un fallo de producción y **un PR ajeno no puede
ponerse rojo por eso**. En cualquier otro evento, la fila 0 es CONFIG con exit 3.

### Línea final a stdout, SIEMPRE, en este formato

```
<CLASE>: <mensaje> | agent=<slug> schemaSha256=<hex12> omitted=[...] httpStatus=<n> agentFailure=<kind|-> durationMs=<n>
```

---

## 6. Derivación del cuerpo desde el `inputSchema` (AC-1, CD-1)

Función **pura y exportada**: `deriveInput(inputSchema, opts) → { input, omitted, reason?, field? }`.
Recorre `properties` del schema **recibido en esa misma corrida**:

| Caso | Regla |
|---|---|
| Propiedad con **`enum`** | → `enum[0]`. Determinista, y es un valor que el agente publica sobre sí mismo. `enum` vacío o no-array → **DRIFT** (fila 3) |
| Propiedad **numérica** (`type` `number`/`integer`) | → parte de `PROBE_AMOUNT_USD` (env, default **`25`**) y **verifica** que satisfaga `exclusiveMinimum`/`minimum`/`maximum`/`exclusiveMaximum` publicados. Si no las satisface y no puede ajustarse dentro de las cotas → **DRIFT** |
| **`string` sin `enum`** | → **se OMITE si NO está en `required`**; si **está** en `required` → **DRIFT** (fila 3), ⛔ nunca un valor inventado |
| Cualquier otro tipo, y está en `required` | → **DRIFT** |
| Las omitidas | se listan en la salida: `omitted: ["destCountry"]` |

**Con el schema de hoy la derivación produce exactamente**:
`input = {amountUsd: 25, payoutMethod: "yape"}`, `omitted = ["destCountry"]`.

**`PROBE_AMOUNT_USD = 25` NO viola CD-1.** CD-1 prohíbe escribir de memoria un valor que el
schema publica. El schema **no publica ningún monto**: publica una **restricción**
(`exclusiveMinimum: 0`). `25` es un parámetro de la sonda, se declara como tal, y la sonda
**verifica** que satisfaga la restricción publicada antes de mandarlo.

**El caso general, que es lo que hace que esta regla sobreviva al schema de hoy**: si mañana
un `string` libre entra a `required`, la sonda **no arranca** y dice
`DRIFT: campo requerido no derivable`. Un schema que la sonda no puede satisfacer se
convierte en una señal fuerte y bien atribuida, **no en un cuerpo fabricado**.

**Huella del schema**: cada corrida imprime `schemaSha256=<12 hex>` sobre el JSON canónico
(claves ordenadas) del `inputSchema`, con `node:crypto`. No cambia ninguna decisión; existe
para que cuando la clasificación pase a DRIFT el log conteste *"¿cambió el schema hoy?"*
sin una sesión de arqueología. ~10 líneas.

---

## 7. Qué se afirma de una respuesta 2xx, y qué NO

**SÍ**:
- `success === true`
- `steps[0].output.rate` y `.netDeliveredLocal` **finitos y `> 0`**
- que esos **dos nombres existan en `outputSchema.properties`** del card leído **en la misma
  corrida**. Si no existen → **DRIFT**, no PASS. Ese cruce es el puente que ancla la
  aserción al contrato publicado aunque `outputSchema` no declare `required`.

**NO**:
- ⛔ ninguna **banda de valor** para `rate`
- ⛔ nada sobre `localCurrency`, `destCountry` ni corredor

---

## 8. El reintento, acotado

Un reintento, **2 s** de espera, y **sólo** ante rechazo de `fetch` a nivel conexión:
`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`.

⛔ **NUNCA ante `AbortError` de timeout en el `POST /compose`**: un POST que expiró **puede
haberse ejecutado y debitado del otro lado**, y reintentarlo paga dos veces por una medición
que no aclara nada.
✅ El `GET /discover` **sí** se reintenta ante timeout — es idempotente y gratis.

---

## 9. El riesgo propio de esta HU, completo

Una sonda mal diseñada es **peor que ninguna**: miente con la autoridad de un control
automático. Los tres riesgos, con su **mecanismo** — no con la intención:

| Riesgo | Mecanismo que lo cierra |
|---|---|
| **Su input queda viejo y grita "producción caída"** | El schema se lee **en cada corrida** (§6); lo no derivable es **DRIFT** y nunca un valor inventado; la escalera separa DRIFT(4) de DOWN(2) **con mensajes distintos** (§5); `schemaSha256` en el log **atribuye el cambio**; §7 prohíbe la banda FX |
| **Avisa de más y alguien la apaga** | Issue con **título fijo**, **deduplicado**, que **se cierra solo** al primer verde; `pull_request` **informativo**; un reintento acotado **absorbe el blip de red** (§8); un fallo CONFIG **dice CONFIG** y no manda a nadie a mirar Railway |
| **Su verde nunca se vio en rojo** | **D-1, D-2 y D-3 con log archivado** (§12) + **un test unitario por cada fila** de la escalera (T-5) |

---

## 10. Waves

### W0 — serial · contratos y nombres

**Objetivo**: fijar los nombres y las firmas antes de que nada dependa de ellos.

| Artefacto | Qué |
|---|---|
| `package.json` | +1 línea **después de `:16`**, al FINAL del bloque `scripts`: `"probe:money-path": "node scripts/probe-money-path.mjs"`. Acordate de la coma en la línea anterior |
| `scripts/probe-money-path.mjs` | Esqueleto con las **firmas exportadas** y sus docblocks: `deriveInput`, `classify`, `schemaFingerprint`, `assertQuoteShape`, `main`, guardia `invokedDirectly` |

**Nombres, todos fijos** (⛔ no los cambies):

| Artefacto | Nombre |
|---|---|
| Workflow | `.github/workflows/probe-money-path.yml`, `name: probe-money-path` |
| Script | `scripts/probe-money-path.mjs` |
| npm script | `probe:money-path` |
| Test | `test/probe-money-path.test.mjs` |
| Título del issue | `probe-money-path: la corrida por reloj esta fallando` |
| Secret | `A2A_PROBE_KEY` (repo secret) |
| Slug sondeado | `remit-corridor-fx-solana` |
| Base URL | `https://wasiai-a2a-production.up.railway.app` |

**Cerrá W0 con**: `git add package.json scripts/probe-money-path.mjs`.

---

### W1 — el script y su suite (paralelizable entre sí, pero el test importa al script)

#### 1.1 `scripts/probe-money-path.mjs`

Estructura del `main()`:

```
main()
 ├─ readCredential(env)                        → fila 0 (SKIP:/exit 0 sólo en pull_request)
 ├─ GET /discover/remit-corridor-fx-solana     (1 reintento, incl. timeout)
 │    → filas 1-2
 ├─ schemaFingerprint(inputSchema)             → log
 ├─ deriveInput(inputSchema)                   → fila 3; log de `omitted`
 ├─ [self-test] borra el campo pedido + banner
 ├─ POST /compose {steps:[{agent, input}]}  header `x-a2a-key`
 │    (1 reintento SÓLO ante error de conexión — §8)
 │    → filas 4-9
 ├─ assertQuoteShape(body, outputSchema)       → fila 10
 └─ PASS (exit 0)
```

**Patrón de arranque — copialo de `scripts/smoke-downstream-x402.mjs:692-699`**, verificado:

```js
// Only auto-run when invoked directly (not when imported by the vitest wrapper).
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => { /* exit 1 — defecto de la sonda */ });
}
```

Sin esa guardia, importar el script desde el test **ejecuta la sonda contra producción
dentro de `npm test`**. Es obligatoria.

**Patrón de "clean skip" con motivo** — `scripts/smoke-downstream-x402.mjs:417-425` y
`:672-679`: una función pura devuelve `{run:false, reason}` y `main()` imprime
`SKIP: ... (<reason>)` y `process.exit(0)`. Es exactamente la forma de la fila 0 en
`pull_request`.

**El interruptor de self-test es un footgun, y se cierra con mecanismo, no con una
advertencia.** `PROBE_SELF_TEST_OMIT_REQUIRED=<campo>`:

- (a) imprime el banner `SELF-TEST: corrida DELIBERADAMENTE rota — NO mide producción`
- (b) ⛔ **no puede terminar en 0 jamás**: si el gateway aceptara el cuerpo inválido, la
      sonda sale con **exit 5** y el mensaje
      `el gateway aceptó un cuerpo que viola el schema publicado` — que es un hallazgo en
      sí mismo
- (c) un test (T-9) afirma que el YAML lo cablea **sólo** desde el input de
      `workflow_dispatch` y **nunca** como literal

#### 1.2 `.github/workflows/probe-money-path.yml`

**Es una copia estructural de `.github/workflows/smoke-downstream.yml`** (95 líneas,
verificado entero). Diferencias y anclas:

```yaml
name: probe-money-path

on:
  schedule:
    - cron: '7 * * * *'         # cada hora, a :07  (era '7,37 * * * *' hasta 2026-08-25)
  pull_request:
  workflow_dispatch:
    inputs:
      self_test:
        type: boolean
        default: false

# `issues: write` para el aviso. Declarar el bloque RESTRINGE al listado, así que
# `contents: read` tiene que estar o el checkout se queda sin permiso.   (:15-19 del exemplar)
permissions:
  contents: read
  issues: write
```

Pasos, en orden (espejo de `smoke-downstream.yml:24-42`):
`actions/checkout@v7` → `actions/setup-node@v6` con `node-version: '22'` y `cache: npm` →
`npm ci` → la sonda:

```yaml
      - name: Run money-path probe
        run: npm run probe:money-path
        continue-on-error: ${{ github.event_name == 'pull_request' }}
        env:
          A2A_PROBE_KEY: ${{ secrets.A2A_PROBE_KEY }}
          PROBE_SELF_TEST_OMIT_REQUIRED: ${{ inputs.self_test && 'amountUsd' || '' }}
```

Aviso y cierre — **copia estructural de `smoke-downstream.yml:52-94`**, con el título de W0:

- Abrir: `if: failure() && github.event_name == 'schedule'`
- Cerrar: `if: success() && github.event_name == 'schedule'`
- Dedup por título exacto (`:74`):
  `gh issue list --state open --search "\"$TITULO\" in:title" --json number --jq '.[0].number // empty'`;
  si hay uno, `gh issue comment`, si no `gh issue create`
- Cierre (`:91-93`): mismo search, y `gh issue close "$existente" --comment "..."`
- ⛔ **Sin `--label`, a propósito** (`:72-73`): `gh issue create --label` **falla si la
  etiqueta no existe** en el repo, y eso convertiría el aviso en un segundo fallo silencioso
- **El título es IDÉNTICO en el step de abrir y en el de cerrar**, o el cierre nunca
  encuentra el issue
- ⛔ **El cuerpo del issue NO afirma la causa** (misma disciplina que `:49-51`): `failure()`
  es verdadero si falló **cualquier** paso anterior, `npm ci` incluido. Pega la línea de
  clase que emitió la sonda y manda al log. **Ninguna respuesta cruda.** (CD-9)

**Por qué `:07`**: el planificador de GitHub encola masivamente en el minuto redondo;
los minutos impares reducen el retraso de arranque.

**Por qué cada hora**: los minutos de Actions **no** son la restricción (el repo es
público, los runners estándar son gratis). La restricción real es **USDC**: 0,0303 por
corrida × 24/día = **0,7272 USDC/día ≈ 21,82 USDC/30 días**. El lado caro es el
**silencio**: el escenario que motivó el issue fueron *días* de creencia equivocada, y
contra *días* una hora protege prácticamente igual que media. La palanca para recalcular
es **una sola línea del `cron`**, y desde el 2026-08-25 tirar de ella sin actualizar la
prosa del YAML pone rojo **T-15**. Latencia de detección ≤ ~65 min.

⚠️ **CORRECCIÓN — 2026-08-25 (post-F4).** Acá decía *«cada 30 min ⇒ 48/día ⇒ 1,4544
USDC/día ≈ 43,63/30 días, latencia ≤ ~35 min»*. El founder bajó la cadencia a una corrida
por hora: sin tráfico todavía, una hora da casi la misma protección a la mitad del gasto.
Los números de arriba ya son los vigentes; la derivación completa y el caso del
`DAILY_LIMIT` están en la corrección al tope de **DT-8** del SDD.

⚠️ La `DAILY_LIMIT` de la agent key tiene que quedar **por encima de 0,73 USD/día** (era
1,46 con la cadencia vieja) o la sonda se apaga sola cada tarde. Si queda corta, la sonda
lo reporta como **CONFIG**, no como caída — que es el punto entero de esta HU. El valor
configurado en producción es **2,00 USD/día** y **no se toca**: un techo diario no es un
gasto, así que bajarlo no ahorra nada y sólo achicaría el margen de las corridas de PR
(~42/día con 2,00).

#### 1.3 `test/probe-money-path.test.mjs` — **cero red**

Importá las funciones puras del `.mjs` (patrón de `test/smoke-downstream-x402.test.mjs:20-30`):

```js
import { describe, expect, it } from 'vitest';
import { classify, deriveInput } from '../scripts/probe-money-path.mjs';
```

La ruta relativa `'../scripts/probe-money-path.mjs'` **es la que lee el guardián**
`test/scripts-imported-by-tests-are-tracked.test.ts:48` (regex
`/['"](?:\.\.\/)+(scripts\/[^'"]+\.mjs)['"]/g`) para exigir que el `.mjs` esté **trackeado
en git** (`:135-157`). Otra razón para el `git add`.

Para los casos que necesitan el proceso entero (T-7), usá `spawnSync` con env controlado —
patrón de `test/smoke-downstream-x402.test.mjs:20-30`. Sigue siendo cero red porque la
credencial ausente corta en la fila 0, antes de cualquier `fetch`.

**Cerrá W1 con**: `git add` de los tres archivos nuevos.

---

### W2 — cierre: guardianes, conteos y evidencia

1. **`git add -A`** de todo lo nuevo. Sin esto los guardianes no ven nada y el gate da
   **verde falso**.
2. **Corré el gate completo y en orden** (§13). El rojo esperado es
   `test/readme-numbers.test.ts`, que te va a decir el número real.
3. **Actualizá el conteo derivado** en `README.md:378` (`**304 test files**`) y
   `README.es.md:412` (`**304 archivos de test**`). ⛔ El número se **lee del rojo**, no se
   copia de acá.
4. **Volvé a correr el gate completo**, entero, en orden.
5. **Ejecutá D-1, D-2 y D-3** (§12) y archivá los tres logs en
   `doc/sdd/227-sonda-del-money-path/evidence/`.
6. Verificá el diff vacío sobre `src/`:
   `/usr/bin/git diff --stat origin/main -- src/` → **vacío**.

---

## 11. Tests requeridos — `test/probe-money-path.test.mjs`, cero red

| ID | AC | Qué prueba | Por qué no es vacuo |
|---|---|---|---|
| **T-1** | AC-1 | `deriveInput` con un schema cuyo `enum` es `["plin","yape"]` devuelve `payoutMethod: "plin"` | **Mata la implementación hardcodeada**: si el script escribiera `"yape"` de memoria, este test se pone rojo. Es el único test que distingue "derivó" de "acertó" |
| **T-2** | AC-1 | Con el schema REAL de §4 como fixture literal, `deriveInput` produce `{amountUsd:25, payoutMethod:"yape"}` y `omitted:["destCountry"]` | Ancla la decisión de `destCountry` |
| **T-3** | AC-1 | Un `string` libre **en `required`** ⇒ `{reason:'required-not-derivable', field}`, **sin `input`** | El caso general que sobrevive al schema de hoy |
| **T-4** | AC-1 | `enum: []`, y cotas insatisfacibles (`minimum:10, maximum:5`) ⇒ DRIFT | Los dos bordes de la derivación |
| **T-5** | AC-3 | `classify` sobre **las 12 filas** de §5, una por una, incluidos `INPUT_REJECTED`→exit 4 y `AGENT_ERROR`→exit 2 | Es la tabla ejecutable: la escalera no vive sólo en prosa |
| **T-6** | AC-3 | El mensaje de DRIFT y el de DOWN son **distinguibles por su prefijo**, y ninguno contiene la palabra del otro | AC-3 pide distinción explícita **en el mensaje**, no sólo en el código |
| **T-7** | AC-8 | Credencial ausente ⇒ **exit 3** con `CONFIG: credencial de sonda ausente`; y con `GITHUB_EVENT_NAME=pull_request` ⇒ **exit 0** con `SKIP:` | La fila 0 y su carve-out de fork |
| **T-8** | AC-5, AC-6 | Leyendo el **YAML real**: el step de la sonda tiene `continue-on-error` acotado a `pull_request`; el de aviso tiene `if: failure() && github.event_name == 'schedule'`; el de cierre `success() && ... 'schedule'`; y **el título es idéntico en los dos** | Son afirmaciones sobre el archivo real, no sobre lo que la spec dice que tiene |
| **T-9** | AC-4 | El YAML **no** contiene `PROBE_SELF_TEST_OMIT_REQUIRED` como literal fuera de la expresión de `inputs.self_test` | Cierra el footgun del self-test **mecánicamente** |
| **T-10** | AC-2, CD-4 | El fuente del script no contiene `deposit`, `payout`, `settle`, `orchestrate`, y su único método no-GET es un `POST` a `/compose` | CD-4 + CD-14 ejecutables |
| **T-11** | AC-7, CD-15 | Ninguna aserción del script menciona `PEN`, `localCurrency` ni `destCountry` como **valor esperado** | CD-15 ejecutable |
| **T-12** | AC-1, CD-6 | El nombre del npm script **no matchea `^test`** y `package.json:11` sigue conteniendo `biome check src/` | Los dos guardianes que este diff puede romper, verificados desde adentro |

**Guardianes YA existentes que este diff activa y deben quedar verdes**:

| Guardián | Qué exige de esta HU |
|---|---|
| `test/scripts-imported-by-tests-are-tracked.test.ts` | el `.mjs` **trackeado en git** |
| `test/test-files-are-run-in-ci.test.ts` | el workflow nuevo **traducible** (`untranslatable` vacío) ⇒ el nombre del npm script |
| `test/readme-numbers.test.ts` | el conteo de archivos de test en los DOS README |
| `test/cited-lines-guard.test.ts` | ninguna cita desplazada ⇒ la posición de la línea en `package.json` |

**Cobertura**: el `.mjs` entra al reporte al importarlo la suite. Los umbrales son globales
(`vitest.config.ts:23-30`: statements 80 / branches 70 / functions 80 / lines 80) y la
medición del 2026-08-15 estaba **7,5-12,5 puntos por encima**. Un archivo de ~260 líneas
bien cubierto no los mueve. ⛔ Si el gate se pusiera rojo por coverage, **se sube la
cobertura del script, NO se baja el umbral**.

---

## 12. AC-4 es entregable, no trámite — demostrar el ROJO

> *"Un control verde que nunca se vio fallar no cuenta como entregado."*

Los tres procedimientos archivan su log en `doc/sdd/227-sonda-del-money-path/evidence/`.

| ID | Comando | Esperado | Costo |
|---|---|---|---|
| **D-1** | `A2A_PROBE_KEY=wasi_a2a_credencial_invalida_demo npm run probe:money-path` | `CONFIG: ... (KEY_NOT_FOUND)`, **exit 3** (fila 4). Ver la nota de abajo | **0 USDC** (no hay débito sin key válida) |
| **D-2** | `PROBE_SELF_TEST_OMIT_REQUIRED=amountUsd npm run probe:money-path` **con la credencial real** | `DRIFT`, **exit 4**, vía `agentFailure: 'INPUT_REJECTED'`. Es además la verificación viva de que WKH-335 sigue emitiendo el campo del que depende CD-5 | ≤ 0,0303 USDC |
| **D-3** | `workflow_dispatch` con input `self_test: true` sobre la rama de la HU | **Job ROJO en la UI de Actions, y SIN issue**: el paso sólo lleva `continue-on-error` en `pull_request`, y el aviso sólo corre en `schedule` | ≤ 0,0303 USDC |

**Costo total de la demostración: ≤ 0,061 USDC.**

📌 **Nota sobre D-1, y por qué su resultado no depende del prefijo de la key falsa.** El
orden de prioridad del middleware es `x-a2a-key` > `Bearer wasi_a2a_*` > x402
(`src/middleware/a2a-key.ts:522`). Como la sonda manda el header **`x-a2a-key`**, **cualquier
valor** toma la rama de agent key sin mirar el prefijo: `sha256` →
`identityService.lookupByHash` → sin fila → `send403(reply, 'KEY_NOT_FOUND', ...)`
(`:1128-1134`). O sea **403 con `error_code: 'KEY_NOT_FOUND'` ⇒ fila 4 ⇒ CONFIG ⇒ exit 3**.
El prefijo `wasi_a2a_` **sólo** decide si un `Authorization: Bearer` es tratado como agent
key (`:552-556`); por el header no aplica. Si por alguna razón la request cayera al x402,
saldría **402 ⇒ fila 5 ⇒ CONFIG ⇒ exit 3** igual: **las dos rutas son CONFIG**, que es lo
que D-1 tiene que demostrar. ⚠️ Lo que D-1 **NO** debe producir nunca es DOWN.

⚠️ **D-1 corre sin credencial válida y no cuesta nada — hacelo aunque el founder todavía no
haya creado la key.** D-2 y D-3 la necesitan.

📌 **ESTADO DE LAS DEMOSTRACIONES — 2026-08-25.**

| | Estado | Evidencia |
|---|---|---|
| **D-1** | ✅ **HECHA** | `evidence/D-1-credencial-invalida.log`, `D-1-post-fixpack.log`, `D-1-post-fixpack-3-cabecera-de-red.log` |
| **D-2** | ✅ **HECHA contra PRODUCCIÓN con la credencial real** | La sonda dio **`PASS`, exit 0**, y el budget de la key bajó de **15 a 14,97 USDC** en la red **900001**. Ver la entrada del 2026-08-25 en `auto-blindaje.md` |
| **D-3** | ⏳ **PENDIENTE** | Necesita el merge: `workflow_dispatch` sobre la rama, job rojo en Actions |

⚠️ **Qué es y qué no es la D-2 ejecutada.** La corrida fue el **camino feliz** (`PASS`), no
la variante `PROBE_SELF_TEST_OMIT_REQUIRED=amountUsd` que esta fila describe, así que **no**
cierra la parte de "DRIFT/exit 4 vía `INPUT_REJECTED`". Lo que sí cierra —y es lo que
faltaba— es el **control positivo del cobro**: el débito de 0,03 USDC prueba que la sonda
paga en **Solana devnet** y no en la red default del gateway, que es exactamente lo que el
fix-pack 3 declaró que D-1 **no podía** demostrar (D-1 no cobra: no hay débito sin key
válida). El descuento observado fue **0,03** y el 402 pide **0,0303**; la diferencia queda
anotada sin resolver en la corrección de DT-8.


---

## 13. El gate — completo y en orden

```bash
npx tsc -p tsconfig.json --noEmit
npm run lint
npm test
```

⛔ **`npm run qa` NO EXISTE en este repo.** Existe en `chaski-v3` y en `wasiai-facilitator`;
acá el gate es la secuencia de `.github/workflows/ci.yml`, en ese orden.

**Correr las partes de un gate no es correr el gate.** `lint` va **segundo**, y ya hubo un
`import` sin usar que sobrevivió 5 revisiones porque todos corrían `vitest` y `tsc` y nadie
llegaba a lint.

⚠️ **Corré el gate con TODO en el índice** (`git add -A` primero). 7 familias de guardianes
derivan de `git ls-files`: un archivo untracked les es invisible ⇒ **gate verde falso**.

📎 Dato útil, no excusa: `tsconfig.json:19` es `"include": ["src/**/*"]` y
`biome.json:8-10` + `package.json:11` lintean **sólo `src/`**. O sea que `scripts/` y `test/`
**no** los toca ni `tsc --noEmit` ni `biome`. Tu código nuevo lo cubre **la suite**, y por
eso los tests de §11 no son opcionales.

---

## 14. Constraint Directives — la lista completa

**Heredados del work-item**:

- **CD-1**: ⛔ PROHIBIDO hardcodear el body del `POST /compose`. Se deriva en runtime del
  `inputSchema` de **esa misma corrida**. Ningún campo se copia de memoria, de un ejemplo de
  documentación, ni de una versión anterior del schema.
- **CD-2**: ⛔ PROHIBIDO modificar el comportamiento de `/compose`, `/discover`, Chaski o
  cualquier agente. **OBLIGATORIO: diff vacío sobre `src/`.**
- **CD-3**: OBLIGATORIO demostrar el rojo con log archivado antes de DONE (§12).
- **CD-4**: ⛔ PROHIBIDO ejercitar depósito/payout. Sólo la cotización.
- **CD-5**: OBLIGATORIO usar el campo estructurado `agentFailure`. ⛔ PROHIBIDO re-parsear
  el string de `error` con una regex.

**Nuevos**:

- **CD-6**: el npm script ⛔ NO puede llamarse `test*` ni empezar por `test`. PROHIBIDO
  también agregar al workflow cualquier step cuyo `run:` empiece por `npm test` / `npm run
  test` mientras el job lleve `continue-on-error`.
- **CD-7**: la entrada nueva de `package.json#scripts` va **después de la línea 16**.
- **CD-8**: ⛔ PROHIBIDO imprimir la credencial (entera o truncada) o volcar cuerpos crudos
  al issue. **El repo es PÚBLICO.**
- **CD-9**: ⛔ PROHIBIDO que el mensaje del issue afirme una causa que la sonda no midió.
- **CD-10**: si una edición desplaza una línea citada, se re-ancla la cita **en el mismo
  commit**.
- **CD-11**: OBLIGATORIO `git add` de **todo** archivo nuevo **ANTES** de correr el gate.
- **CD-12**: OBLIGATORIO actualizar el conteo en `README.md:378` y `README.es.md:412`, con
  el número **derivado** del rojo.
- **CD-13**: el cierre corre el gate **completo y en orden**.
- **CD-14**: la sonda **observa**. ⛔ Ningún `POST`/`PATCH`/`DELETE` que no sea el único
  `POST /compose`.
- **CD-15**: ⛔ PROHIBIDO afirmar corredor, país o moneda local en cualquier aserción o
  mensaje.

---

## 15. Done Definition

- [ ] Los **6 archivos** de §2 creados/modificados, **y ninguno más fuera de esa lista**
- [ ] `/usr/bin/git diff --stat origin/main -- src/` → **vacío** (CD-2)
- [ ] `git status --short` → **sin `??`**: todo lo nuevo está en el índice (CD-11)
- [ ] Las **12 filas** de la escalera (§5) tienen un caso en T-5
- [ ] `deriveInput` es **pura y exportada**, y T-1 la distingue de una implementación
      hardcodeada
- [ ] `README.md` y `README.es.md` publican el conteo **derivado** (CD-12)
- [ ] Gate **completo y en orden** en VERDE:
      `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` (CD-13)
- [ ] Los 4 guardianes de §11 en verde (`scripts-imported-by-tests-are-tracked`,
      `test-files-are-run-in-ci`, `readme-numbers`, `cited-lines-guard`)
- [ ] **D-1 ejecutado y su log archivado** en `doc/sdd/227-sonda-del-money-path/evidence/`
- [ ] D-2 y D-3 ejecutados y archivados **cuando exista la credencial** (⚠️ ver §16)
- [ ] Diff dentro del presupuesto (**578 líneas / 6 archivos**, techo 1156) o excedente
      **justificado por escrito**

**Si el diff se pasa, lo primero que se recorta son los docblocks del `.mjs` — ⛔ nunca un
caso de T-5.**

---

## 16. ⚠️ Bloqueante conocido, heredado

**La credencial dedicada de la sonda (`A2A_PROBE_KEY`) la crea el founder, no un agente.**

- **F3 puede escribir y testear TODO sin ella**: la suite no toca la red, y D-1 corre igual.
- **Sin ella no se cierran** AC-2, ni D-2/D-3 de AC-4, ni el DONE.
- Lo que el founder necesita saber para crearla, y que este documento aporta:
  **presupuesto ≥ 44 USDC / 30 días**, **`DAILY_LIMIT` > 1,46 USD/día** *(cifras de la
  cadencia vieja; con 24 corridas/día son **21,82 USDC / 30 días** y **> 0,73 USD/día** —
  ver la corrección de §16. **RESUELTO 2026-08-25**: la key existe, el secret está cargado
  y hay 15 USDC fondeados en la red 900001, que alcanzan ~20 días)*, y el nombre
  **`A2A_PROBE_KEY`** como **repo secret** (no environment secret: ningún workflow de este
  repo declara `environment:`, y los 4 entornos que existen los creó Railway con nombres que
  traen espacios y barras).

Si al terminar F3 la credencial no existe, **paralo y avisá**: es un prerequisito de founder,
no algo que se resuelva improvisando.
