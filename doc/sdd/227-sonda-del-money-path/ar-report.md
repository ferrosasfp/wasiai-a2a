# AR — Adversarial Review · WKH-364 (HU 227) · Sonda periódica del camino del dinero

- **Rama**: `feat/227-sonda-money-path` · worktree `/home/ferdev/.openclaw/workspace/a2a-sonda`
- **Base**: `origin/main` de `wasiai-a2a` · todo **staged, sin commitear**
- **Fecha**: 2026-08-25
- **Revisor**: `nexus-adversary` (AR, iteración 1)

## VEREDICTO: 🔴 **RECHAZADO — 7 BLOQUEANTES activos** (1 ALTO · 3 MEDIO · 3 BAJO) + 5 MENORes

> La sonda **puede decir PASS con el camino del dinero cortado** (BLQ-ALTO-1) y **puede
> decir DOWN por una propiedad de su propia credencial** (BLQ-MED-1). Son las dos
> direcciones exactas en las que el `curl` inventado mentía y que esta HU existe para
> cerrar. Las dos están reproducidas con input concreto y salida capturada.

---

## 0. Qué se ejecutó (no se leyó: se corrió)

| Qué | Resultado |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | **0** — "TypeScript compilation completed" |
| `npm run lint` | **0** — biome, 503 files, no fixes |
| `npm test` | **299 passed \| 6 skipped (305)** · **5994 passed \| 19 skipped (6013)** |
| `npm run test:coverage` (job `coverage` de `ci.yml:87-105`) | **0** — 87,72 / 80,38 / 92,22 / 89,29 vs pisos 80/70/80/80 |
| Gate corrido **con todo en el índice** | sí — `git status --porcelain` sin `??` antes de correr |
| **D-1 reproducido contra producción**, credencial distinta a la del Dev | `CONFIG: la credencial de la sonda (KEY_NOT_FOUND)`, **exit 3**, `schemaSha256=ee87a63f8e71` (idéntico al del log del Dev) |
| **14 mutantes** aplicados y revertidos, md5 verificado | **12 MUERTOS · 2 SOBREVIVIERON** |
| Árbol al terminar el AR | md5 idéntico al de partida (`13dcbf8c…` / `a372b555…`), `git status` sin cambios |

**Arnés de mutación**: copia previa a `scratchpad/ar364/backup/`, restauración por `cp` con
`assert md5 == original` después de **cada** mutante. ⛔ No se usó `git checkout --`.

---

## 1. Los BLOQUEANTES, ordenados para el fix-pack

### 🔴 BLQ-ALTO-1 · La sonda dice **PASS** sin haber llamado nunca a `/compose`

- **Categoría**: Error Handling / la pregunta entera de la HU ("¿puede decir PASS sobre algo roto?")
- **Archivo:línea**: `scripts/probe-money-path.mjs:218-262` (la escalera) + `:308-312` (el retorno temprano de `main`)
- **Qué está mal**: la escalera **no tiene fila por defecto para `/discover`**. La fila 1
  cubre `networkError` y `>= 500`; la fila 2 cubre `404` y `200 sin inputSchema`. **Todo lo
  demás cae al vacío**: las filas 4-10 miran `obs.compose`, que en ese camino **no existe**
  (`main` retornó en `:312` antes del `POST`), así que `c = {}` y ninguna condición matchea
  ⇒ se llega a la **fila 11 = PASS, exit 0**.
- **Reproducción** (`scratchpad/ar364/repro-A.mjs`, `fetch` stubeado, cero red real):

  ```
  discover HTTP 429 -> exit 0   llamadas=["GET .../discover/remit-corridor-fx-solana"]
  discover HTTP 403 -> exit 0   llamadas=["GET .../discover/remit-corridor-fx-solana"]
  discover HTTP 401 -> exit 0   llamadas=[…]      discover HTTP 400 -> exit 0
  discover HTTP 451 -> exit 0                     discover HTTP 302 -> exit 0
  discover HTTP 204 -> exit 0   (repro-B, caso B2)
  ```

  Línea emitida, textual: `PASS: el camino del dinero cotiza | agent=remit-corridor-fx-solana
  schemaSha256=- omitted=[] httpStatus=429 agentFailure=- durationMs=13`.
  El arreglo `llamadas` prueba que **hubo una sola llamada, el GET**: el `POST /compose`
  nunca ocurrió y la sonda igual afirmó que el camino del dinero cotiza.
- **Entradas reales que lo producen**: un `429` del borde (Railway/Cloudflare) contra un bot
  que pega cada 30 min desde runners de GitHub; un `403` de WAF / bot-fight; un `401` el día
  que `/discover` gane auth; un `1015` de Cloudflare (→429). Ninguno es exótico: son
  exactamente los estados en que **el catálogo no contesta y nadie sabe si el dinero pasa**.
- **Impacto, y es doble**:
  1. El control **calla** cuando el gateway está inalcanzable por el borde.
  2. Peor: `exit 0` en `schedule` dispara `.github/workflows/probe-money-path.yml:99-110`
     ⇒ **`gh issue close`**. O sea que la sonda **cierra sola el issue de una caída abierta**
     mientras la caída sigue. El control no sólo miente: **borra la alarma de otro**.
- **Sugerencia**: la escalera necesita ser cerrada por construcción, no por enumeración.
  Dos formas, y la segunda es la que no envejece: (a) una fila 2-bis "discover no dio 200
  con `inputSchema`" que cubra todo lo demás; (b) que `classify` **exija** que exista un
  `obs.compose` con status 2xx antes de poder devolver PASS — un PASS sin observación de
  `/compose` debería ser imposible de expresar. Y un caso en T-5 por cada uno.

---

### 🟠 BLQ-MED-1 · `SCOPE_DENIED` de la RUTA se lee como caída de producción

- **Categoría**: Integration / contrato roto (y es el defecto de origen de la HU, reproducido)
- **Archivo:línea**: `scripts/probe-money-path.mjs:231` (fila 4 mira sólo `body.error_code`) y `:250-252` (fila 9)
- **Qué está mal**: hay **dos** productores de `403` en `/compose` y la sonda cableó uno solo.
  - Middleware: `src/middleware/a2a-key.ts:121` → `{ error, **error_code** }` (snake). ✅ cableado.
  - Ruta: `src/routes/compose.ts:1113-1114` → `403` cuando `result.errorCode === 'SCOPE_DENIED'`,
    y el cuerpo es `{...result}` con **`errorCode`** (camel) — `src/services/compose.ts:409-424`. ❌ **no cableado en ninguna fila**.

  El Story File §4:192-194 documenta ese 403 y el propio Dev lo transcribió; la checklist
  de §3:118-119 dice "`SCOPE_DENIED` fue **removido**" — pero eso es sólo de la unión del
  **middleware** (`a2a-key.ts:112-114` lo dice textual: *"Scope enforcement moved to
  composeService.compose"*). Se conflacionaron dos `SCOPE_DENIED` distintos.
- **Reproducción** (`scratchpad/ar364/repro-C.mjs`, cuerpo copiado del shape real de `compose.ts:409-424`):

  ```
  DOWN: candidata a caída real — no hay campo estructurado que atribuya la causa
        | httpStatus=403 agentFailure=- …
  >>> exit observado: 2   (esperado por AC-3/AC-8: 3 = CONFIG)
  ```

  El mensaje además **es falso**: sí hay campo estructurado que atribuye la causa
  (`errorCode: 'SCOPE_DENIED'`), y la causa es la credencial de la sonda.
- **Cuándo pasa, y por qué es probable y no teórico**: `src/services/authz.ts:20-73` emite
  `SCOPE_DENIED` en cuatro casos y **los cuatro son propiedades de la key del caller**:
  registry fuera de `allowed_registries`, **slug fuera de `allowed_agent_slugs`**, categoría
  fuera de `allowed_categories`, y **costo estimado > `max_spend_per_call_usd`**.
  El work-item :218 y el Story File §16 le piden al founder crear la key **"con scope propio"**
  y "budget mínimo" ⇒ el camino que la HU recomienda es **exactamente** el que dispara esto.
- **Impacto**: `DOWN` cada 30 minutos, issue abierto, y una persona mandada a mirar Railway
  por una lista de slugs mal cargada. Es, literalmente, el escenario que costó una sesión
  entera y que motivó el issue #174.
- **Agravante en la suite**: `test/probe-money-path.test.mjs:154-159` **canda la
  misclasificación**: afirma `SCOPE_DENIED` → `exit 2` y lo justifica en un comentario
  ("si mirara sólo el status, este caso pasaría por CONFIG y **taparía una caída**").
  El test no está midiendo lo que cree: `SCOPE_DENIED` **no es** una caída.
- **Sugerencia**: la fila 4 tiene que leer las **dos** claves (`error_code` y `errorCode`)
  y `SCOPE_DENIED` pertenece a CONFIG, no a DOWN. Reescribir el caso de `:154-159` con su
  razón corregida (el punto que ese test quería hacer — "no cualquier 403 es CONFIG" — sigue
  siendo válido con otro código, p. ej. uno inventado).

---

### 🟠 BLQ-MED-2 · El issue no pega la línea de clase ⇒ el mecanismo de §9 no existe

- **Categoría**: Error Handling / contrato (Story File §10:450-452)
- **Archivo:línea**: `.github/workflows/probe-money-path.yml:73-85`
- **Qué está mal**: el Story File §10:452 instruye textual: *"**Pega la línea de clase que
  emitió la sonda** (que sí la atribuye, y sin cuerpos crudos) y manda al log."* El workflow
  hace sólo la segunda mitad: el cuerpo dice `"Qué NO dice este aviso: cuál fue la causa"`
  y remite a Actions. La línea de clase **nunca se captura** (no hay `tee`, ni `id:`, ni
  `$GITHUB_OUTPUT` en el step de `:51-56`).
- **Por qué importa, con el número**: §9:316 declara que el riesgo *"avisa de más y alguien
  la apaga"* se cierra porque *"un fallo CONFIG **dice CONFIG** y no manda a nadie a mirar
  Railway"*. Ese mecanismo **no está implementado**. Y hoy — sin el secret, ver BLQ-MED-3 —
  **el 100 % de los avisos van a ser CONFIG y ninguno lo va a decir.**
- **Reproducción**: leer `:73-85`; no aparece ninguna captura de stdout del step `:51-56`.
  Corolario ejecutable: `A2A_PROBE_KEY= npm run probe:money-path` imprime
  `CONFIG: credencial de sonda ausente … NO dice nada sobre producción` y sale 3 — esa línea
  existe, es correcta, y el issue no la lleva.
- **Impacto**: cada aviso obliga a abrir Actions para saber si producción está implicada.
  Es el costo que la HU existe para eliminar, cobrado en cada alerta.
- **Nota justa**: la razón que el YAML da en `:62-64` (`failure()` es cierto si falló
  cualquier paso, `npm ci` incluido) es **correcta y no está en conflicto** con pegar la
  línea. Se puede pegar lo que la sonda imprimió *si imprimió algo* y decir "la sonda no
  llegó a emitir línea" si no. No afirmar la causa ≠ no pegar la evidencia.
- **Sugerencia**: capturar stdout del step de la sonda (`tee` a un archivo + `id:` + salida),
  y pegar esa línea en el cuerpo. Mismo fix habilita distinguir exit 3 de exit 2 en el aviso.

---

### 🟠 BLQ-MED-3 · Sin el secret, mergear enciende **48 corridas rojas por día**

- **Categoría**: Integration / riesgo operativo declarado en §9
- **Archivo:línea**: `.github/workflows/probe-money-path.yml:16` (`cron: '7,37 * * * *'`) + `:55`
- **Medido, no supuesto** (por el AR, no copiado del Dev):
  `gh secret list --repo ferrosasfp/wasiai-a2a` → **salida vacía, exit 0**. El secret
  `A2A_PROBE_KEY` **no existe**. El Dev lo declaró en `evidence/D-2-D-3-NO-EJECUTADOS.log`
  y en `auto-blindaje.md`; se confirma.
- **Reproducción / aritmética**: 48 corridas/día → fila 0 → `CONFIG` exit 3 →
  `continue-on-error` vale `false` en `schedule` (`:53`) → job rojo → step `:65-94` corre.
  El dedup (`:89-94`) evita el **issue** duplicado pero **no el comentario**:
  **1 issue + 47 comentarios/día ≈ 1.410 notificaciones/mes**, todas sobre lo mismo.
- **¿Se cierra solo cuando aparezca el secret?** **Sí** — `:99-110` cierra con
  `success() && schedule`. Ese lado del mecanismo está bien y verificado por lectura.
  ⚠️ Pero ese mismo mecanismo es el que **BLQ-ALTO-1 convierte en un arma**.
- **Impacto**: es el riesgo #2 del propio SDD materializado el primer día. Un control que
  notifica 47 veces por día lo primero que gana es que lo silencien.
- **Sugerencia** (una de las tres, decisión del founder/orquestador, no del AR):
  (a) crear el secret **antes** del merge; (b) que el step de aviso **no abra ni comente
  cuando el exit fue 3** (requiere la captura de BLQ-MED-2: mismo fix); (c) mergear con el
  `schedule` comentado y descomentarlo al crear el secret. **No es un hallazgo que el Dev
  "arregle" con código sin decidir esto**: es una precondición de merge.

---

### 🟡 BLQ-BAJO-1 · CD-8/CD-9 sin testigo: un mutante que **imprime la credencial** sobrevive la suite

- **Categoría**: Security / Test Coverage
- **Archivo:línea**: `scripts/probe-money-path.mjs:19` (la afirmación) y `:347-354` (`emit`, el sitio)
- **Qué está mal**: el docblock `:19` afirma *"⛔ Nunca imprime la credencial, ni entera ni
  truncada: el repo es PÚBLICO"*. **Ningún test puede refutar esa frase.** CD-9 (§14) exige
  literal: *"Ningún docblock afirma algo que su propio archivo no pueda refutar… Cada frase
  que termina en instrucción o afirmación tiene que ser falsable con un input concreto."*
- **Reproducción (mutante M14, ejecutado)**: en `:351` reemplazar
  `` ` agentFailure=${facts.agentFailure} durationMs=…` `` por
  `` ` agentFailure=${facts.agentFailure} key=${process.env.A2A_PROBE_KEY} durationMs=…` ``
  → `npx vitest run test/probe-money-path.test.mjs` → **`Test Files 1 passed (1) · Tests 33 passed (33)`**.
  El mutante **sobrevive**. (Aplicado y revertido; md5 restaurado a `13dcbf8c…`.)
- **Impacto**: hoy no hay fuga — el código es correcto. Lo que falta es el candado. En un
  repo **público**, con un script que corre en CI, la próxima edición que agregue "un dato
  más al log para debuggear" no tiene nada que la frene. El enmascarado de secretos de
  GitHub mitiga el caso del workflow, **no** el de una corrida local ni una transformación
  del valor.
- **Sugerencia**: el patrón ya existe **en este mismo archivo de test** — T-10/T-11
  (`test/probe-money-path.test.mjs:243-256`) escanean `SCRIPT_SRC`. Dos líneas del mismo
  molde: que `SCRIPT_SRC` no contenga `A2A_PROBE_KEY` fuera de `readCredential`, y que
  `cred.key` no aparezca en ninguna plantilla de `process.stdout.write`.

---

### 🟡 BLQ-BAJO-2 · El self-test **fabrica un hallazgo**: manda un cuerpo válido, paga, y reporta exit 5

- **Categoría**: Error Handling / afirmar lo que no se midió (CD-9)
- **Archivo:línea**: `scripts/probe-money-path.mjs:324-327` (el `delete`) y `:199-201` (el exit 5)
- **Qué está mal**: `delete input[obs.selfTestField]` es un **no-op silencioso** si el campo
  no está en el input derivado. La sonda entonces manda el cuerpo **entero y conforme**, el
  gateway lo acepta con razón, `classify` ve `PASS` + `selfTestField` y devuelve
  `exit 5: "SELF-TEST: el gateway aceptó un cuerpo que viola el schema publicado"`.
  La guarda que el Dev sí implementó (`:202`, *"si nunca se envió el cuerpo roto, el motivo
  es de config"*) cubre sólo el caso "no se envió nada"; **no** el caso "se envió, pero
  entero".
- **Reproducción** (`scratchpad/ar364/repro-B.mjs`, último bloque):

  ```
  PROBE_SELF_TEST_OMIT_REQUIRED=campoQueNoExiste
  -> exit 5 | cuerpo REALMENTE enviado:
     {"steps":[{"agent":"remit-corridor-fx-solana","input":{"amountUsd":25,"payoutMethod":"yape"}}]}
  ```

  El cuerpo enviado está **completo**. El exit 5 es una acusación falsa contra el gateway.
- **Impacto**: cuesta 0,0303 USDC y produce un "hallazgo de seguridad" inventado. El
  workflow hoy sólo pasa `'amountUsd'` (`:56`), así que el disparo directo requiere una
  corrida manual — **pero** el día que el `inputSchema` renombre o deje de requerir
  `amountUsd`, el `workflow_dispatch` de D-3 pasa a producir exactamente esto.
- **Sugerencia**: exigir que el campo **exista en el input derivado antes de borrarlo**; si
  no está, es `CONFIG` ("se pidió romper un campo que la derivación no produjo"), nunca
  exit 5. Un caso en T-5 con `selfTestField` ausente del input.

---

### 🟡 BLQ-BAJO-3 · `pull_request` gasta USDC de producción en cada push, y el presupuesto no lo contempla

- **Categoría**: Data Integrity (money-path) / Performance
- **Archivo:línea**: `.github/workflows/probe-money-path.yml:17` (`pull_request:` sin filtro) + `:53-56`
- **Qué está mal**: un PR de **rama del propio repo** (no un fork) **sí** recibe
  `secrets.A2A_PROBE_KEY`. La sonda entonces corre completa en cada `opened`/`synchronize`:
  `POST /compose` real contra producción, **0,0303 USDC por push**. El `continue-on-error`
  impide que ponga rojo el PR — **no** impide que cobre.
- **Aritmética que lo convierte en un problema y no en un detalle**: §16 le pide al founder
  `DAILY_LIMIT > 1,46 USD/día`, derivado de 48 × 0,0303 = **1,4544**. Con el piso literal
  (1,46) el margen del día es **0,0056 USD ≈ 0 corridas extra**. ⇒ **un solo push a un PR
  agota el límite diario**, la sonda se apaga sola el resto del día, y todas las corridas
  por reloj siguientes salen `CONFIG (DAILY_LIMIT)` ⇒ rojo ⇒ issue. La sonda se DoSea sola.
- **Reproducción**: no ejecutable sin la credencial (sería gastar plata real); es aritmética
  sobre `:16`, `:17`, `:53-56` y §16 del Story File. **El mecanismo sí es verificable**:
  `readCredential` (`scripts/probe-money-path.mjs:68-72`) no distingue el evento — sólo la
  fila 0 lo hace, y sólo cuando la key está **ausente**.
- **Impacto**: gasto no presupuestado + auto-apagado del control por su propio CI.
- **Sugerencia**: o el disparador `pull_request` no manda la credencial (queda SKIP, que es
  lo que ya hace para forks y es informativo igual), o el número de §16 se recalcula
  incluyendo un techo de pushes/día y se escribe en el YAML al lado del `cron`.

---

## 2. MENORes (no bloquean el gate; entran al fix-pack o al backlog)

| ID | Categoría | Archivo:línea | Hallazgo | Repro |
|---|---|---|---|---|
| **MNR-1** | Data Integrity | `scripts/probe-money-path.mjs:338-339` | La regla de §8 —⛔ *nunca reintentar el `POST /compose` ante timeout, porque pudo haberse ejecutado y debitado del otro lado*— **no tiene testigo**. Mutante M13: `false` → `true` en `:339`. **Sobrevive: 33 passed (33)**. Es la única regla de plata de la HU sin candado. El código de hoy es correcto | mutante M13, ejecutado y revertido |
| **MNR-2** | Type Safety | `scripts/probe-money-path.mjs:315` | `Number(env.PROBE_AMOUNT_USD)` no valida: un valor no numérico da `NaN`, `satisfiesBounds` lo rechaza y la sonda sale **`DRIFT` / exit 4** — *"el contrato publicado cambió"*— cuando lo que pasó es un typo del operador (debería ser `CONFIG` / 3) | `PROBE_AMOUNT_USD=veinticinco` → `DRIFT: campo requerido no derivable: amountUsd (cotas-insatisfacibles)`, exit 4 (`repro-B.mjs`) |
| **MNR-3** | Error Handling | `scripts/probe-money-path.mjs:313` + `:257` | `schemaSha256` cubre **sólo** el `inputSchema`. En el DRIFT de `outputSchema` (§7) la huella **no cambia**, y §6 promete que existe para contestar *"¿cambió el schema hoy?"* sin arqueología. En ese caso contesta "no" y manda al lado equivocado | `repro-D.mjs`: `DRIFT: el outputSchema publicado ya no declara rate … schemaSha256=ee87a63f8e71` — la misma huella que produce producción hoy |
| **MNR-4** | Error Handling | `.github/workflows/probe-money-path.yml:72` + `:89` | `set -euo pipefail` + `existente=$(gh issue list …)`: un error transitorio de la API de `gh` mata el step y **el aviso se pierde**. El job ya está rojo, así que nadie se entera — es el "segundo fallo silencioso" que el propio YAML (`:87-88`) razona para el caso de `--label` | lectura de `:72`/`:89`; comportamiento determinista de `set -e` en asignación con sustitución de comando |
| **MNR-5** | Error Handling | `scripts/probe-money-path.mjs:280` + `:222` | `res.json().catch(() => null)`: un `200` con cuerpo ilegible (HTML de un proxy) se clasifica **DRIFT** *"el catálogo ya no publica el inputSchema"* — una afirmación que no se midió. La dirección es segura (no es PASS ni DOWN), pero el mensaje es falso | `repro-B.mjs` caso B1: `discover 200 + '<html>502 upstream</html>'` → exit 4 con ese mensaje |

---

## 3. Las 11 categorías

| # | Categoría | Veredicto | Nota |
|---|---|---|---|
| 1 | **Security** | 🟡 **BLQ-BAJO-1** | La credencial **no** se imprime hoy (verificado en los 4 caminos de `emit`, y la línea de D-1 real no la trae); ningún cuerpo crudo llega al issue (los únicos valores interpolados en mensajes vienen de conjuntos cerrados: `CREDENTIAL_ERROR_CODES:40-47`, `GATEWAY_BODY_CODES:50`, y nombres del schema **público**). El workflow **no** interpola `github.event.*` dentro de ningún `run:` (sin vector de script injection), no usa `pull_request_target`, y `permissions` está restringido a `contents: read` + `issues: write` (`:27-29`). **Lo que falta es el candado**, no la conducta |
| 2 | **Error Handling** | 🔴 **BLQ-ALTO-1**, 🟠 **BLQ-MED-2**, 🟡 **BLQ-BAJO-2**, MNR-3/4/5 | La escalera está abierta por abajo del lado de `/discover`. El reintento acotado (`:268-291`) es correcto y se verificó vivo: `ENOTFOUND` → 2 llamadas + 2002 ms; `EPIPE` (no listado) → 1 llamada |
| 3 | **Data Integrity** | 🟡 **BLQ-BAJO-3**, MNR-1 | Único método no-GET = un `POST /compose` (verificado por T-10 y por lectura). No hay escritura de estado. El riesgo de doble débito está **bien resuelto en el código y sin testigo** |
| 4 | **Performance** | ✅ **OK** | Dos llamadas HTTP por corrida, techos con nombre (`:35-37`), sin loops ni acumulación. `main` es lineal |
| 5 | **Integration** | 🟠 **BLQ-MED-1** | El contrato de `/compose` tiene **dos** shapes de 403 (`error_code` del middleware, `errorCode` de la ruta) y la sonda cableó uno. `git diff --cached --stat origin/main -- src/` → **vacío** ✅ (CD-2). Ningún guardián preexistente rojo: los 4 de §11 en verde dentro de los 305 archivos |
| 6 | **Type Safety** | 🟡 MNR-2 | `NaN` propaga desde `PROBE_AMOUNT_USD` y termina en la clase equivocada. El resto del archivo usa comparaciones de tipo explícitas y `Number.isFinite` (`:176`); `deriveValue` (`:101-115`) devuelve unión discriminada, sin `any` |
| 7 | **Test Coverage** | 🟠 mezclado | **12 de 14 mutantes muertos** (los 2 del Dev reproducidos: `deriveInput` hardcodeado → 5 rojos; fila 7 invertida → 1 rojo). Los que él **no** probó y también mueren: fila 6 invertida (2), `SKIP` de fila 0 (2), exit 5 del self-test (1), fila 4 sin `error_code` (1), fila 2 → DOWN (2), carve-out de §7 borrado (1), `destCountry` inventado (2), `> 0` → `>= 0` (1), cruce contra `outputSchema` borrado (1), orden canónico del fingerprint (1). **Sobreviven 2** → MNR-1 y BLQ-BAJO-1. ⚠️ Y `test/probe-money-path.test.mjs:154-159` **canda una clasificación equivocada** (BLQ-MED-1) |
| 8 | **Scope Drift** | ✅ **OK** | 6 archivos de código exactamente los de §2 + los `.log` de evidencia. `doc/sdd/_INDEX.md` (+1 línea) es la fila 227 del **F1**, con estado *"in progress (F1 escrito)"* — precede al F3, no es drift del Dev. `package.json`: la entrada nueva quedó en `:17`, `:11` sigue siendo `"lint": "biome check src/"` ✅ (CD-7, verificado por T-12 y por el verde de `cited-lines-guard`) |
| 9 | **Destructive Migrations** | ⚪ **N/A** | Cero SQL en el diff. `git diff --cached --name-only origin/main` no toca `migrations/` ni `src/` |
| 10 | **RPC con SECURITY DEFINER** | ⚪ **N/A** | La HU no crea ni modifica funciones postgres; la sonda es un cliente HTTP externo |
| 11 | **Cache Invalidation** | ⚪ **N/A** | No se introduce ninguna capa de cache. `discoverCache` existe **dentro** de `/compose` en `src/`, y el diff sobre `src/` es vacío |

---

## 4. Lo que se atacó y **resistió** (dato, no cortesía)

- **La derivación es real, no un acierto.** D-1 reproducido por el AR contra producción con
  una credencial distinta a la del Dev: `schemaSha256=ee87a63f8e71`, `omitted=[destCountry]`
  — idéntico al log archivado ⇒ el fingerprint es estable y la evidencia **no está fabricada**.
  El mutante que hardcodea el body mata 5 tests.
- **`destCountry` se omite y no se inventa** (`:113`, T-2/T-4); el mutante que devuelve `'PE'`
  mata 2 tests. CD-15 verificable: el fuente **no contiene** `destCountry`, `localCurrency`
  ni `PEN`.
- **D-2 y D-3 NO se simularon.** `evidence/D-2-D-3-NO-EJECUTADOS.log` declara la ausencia con
  su motivo. Verificado independientemente: `gh secret list` vacío. **No hay evidencia
  fabricada en esta HU** — y ese era uno de los tres vectores del encargo.
- **El `.gitignore` no se está comiendo nada más del Scope IN.** `git ls-files` (no
  `git status`) confirma los 2 `.log` **en el índice**; `git check-ignore -v` sobre los 4
  archivos del Scope IN devuelve no-ignorado para todos; `git status --porcelain` sin `??`.
  El hallazgo del Dev sobre `.gitignore:46 *.log` es correcto y su fix (`git add -f`) quedó.
- **El árbol se corrió con todo en el índice** y las 7 familias de guardianes que derivan de
  `git ls-files` vieron los 3 archivos nuevos: 305 archivos de test (era 304), y los dos
  README publican **305** derivado del rojo, no copiado.
- **La desviación que el Dev declaró (§7 vs fila 10) es la lectura correcta.** §7:286-288 es
  explícita y más específica que la fila 10 de §5; implementarla como rama dentro de la
  fila 10 (`:255-260`) honra las dos secciones **sin inventar una clase**: reusa `DRIFT/4`,
  que ya existe. El mutante que borra el carve-out muere. **No es un hallazgo.**
- **El aviso se cierra solo** cuando el reloj vuelve al verde (`:99-110`), con el título
  idéntico verificado por T-8 sobre el YAML real.

---

## 5. Orden sugerido del fix-pack

1. **BLQ-ALTO-1** — cerrar la escalera por construcción del lado de `/discover`. Es el único
   hallazgo que hace que el control **mienta en verde** y encima **cierre issues ajenos**.
2. **BLQ-MED-1** — `SCOPE_DENIED` → CONFIG (y corregir el caso de test que lo canda al revés).
3. **BLQ-MED-2** — capturar y pegar la línea de clase en el issue.
4. **BLQ-MED-3** — decisión de merge (secret antes del merge / no avisar en exit 3 / cron apagado). **Comparte fix con el 3.**
5. **BLQ-BAJO-2** — el self-test no puede acusar al gateway de algo que no probó.
6. **BLQ-BAJO-1** — dos aserciones de fuente para CD-8/CD-9.
7. **BLQ-BAJO-3** — decidir si `pull_request` recibe la credencial, y rehacer el número de §16.
8. MNR-1 (testigo de §8) es barato y protege plata: conviene meterlo con el 6.

---

## 6. Artefactos del AR

Reproducciones ejecutables en
`/tmp/claude-1000/-home-ferdev--openclaw-workspace-wasiai-a2a/09093fcc-fffd-496d-96e4-bed79f905a62/scratchpad/ar364/`:
`repro-A.mjs` (BLQ-ALTO-1) · `repro-B.mjs` (bordes + BLQ-BAJO-2 + MNR-2/5) ·
`repro-C.mjs` (BLQ-MED-1) · `repro-D.mjs` (MNR-3) · `mutar.py` (los 14 mutantes, con
restauración por `cp` y `assert md5`) · `backup/MD5.txt`.

⛔ El AR **no modificó** una línea de código ni de test. Estado final del árbol verificado:
`scripts/probe-money-path.mjs` = `13dcbf8c7392b0f8d7fd82105acf45ad`,
`test/probe-money-path.test.mjs` = `a372b555b202d27e8ef8c22be84b89d0` — los mismos md5 de
partida, y `git status --porcelain` idéntico al del inicio.
