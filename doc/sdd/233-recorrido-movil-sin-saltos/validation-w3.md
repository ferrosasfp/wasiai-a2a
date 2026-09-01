# Validation Report — [WKH-372] · OLA W3 · F4

**Veredicto: APROBADO PARA DONE** (con 1 hallazgo MENOR y 3 límites declarados, ninguno bloqueante).
**Fecha:** 2026-09-01 · **Repo:** `chaski-v3` · **HEAD:** `c1bd8d3`, árbol limpio, **sin pushear**
(`origin/main` = `3178360`) · **Modo:** QUALITY.

> **La regla que gobierna este documento:** un `archivo:línea` dice DÓNDE VIVE el código, no QUÉ HACE
> corriendo. Cada AC de abajo lleva **cita** *y* **evidencia de ejecución**, con el comando literal.
> Los ACs que no se pudieron ejecutar están en **NO VERIFICABLE**, nunca en PASS.

---

## 1 · EL NÚMERO PARA EL FOUNDER — firmas de identidad por camino

⚠️ **Derivado por mí ejecutando, no copiado de ningún reporte.**

| Camino | Antes de W3 | Después de W3 | Cómo lo derivé |
|---|:---:|:---:|---|
| **Navegador de la billetera / extensión** (`"injected"`) | **2** | **1** | 🟢 **EJECUTADO end-to-end**, mismo arnés, recorrido que CIERRA |
| **Enlace profundo** (Chrome móvil, `"none"`) | **2** | **2** | 🟡 **NO ejecutado end-to-end.** Derivado de dos mediciones ejecutadas + una premisa no medida |

### 1.1 · El 2 → 1 del camino inyectado, ejecutado

```
$ ./node_modules/.bin/vitest run src/presentation/sesion-borra-la-segunda-firma.test.tsx
 ✓ T-372-W3-0a: en un recorrido inyectado que CIERRA, `signMessage` se invoca EXACTAMENTE 2 veces
 ✓ T-372-W3-1:  con el almacén cableado, el MISMO recorrido invoca `signMessage` EXACTAMENTE 1 vez
 Test Files  1 passed (1)      Tests  8 passed (8)
```

El conteo **no** es un `toHaveBeenCalled()` suelto. Los dos `it` asertan, en este orden
(`src/presentation/sesion-borra-la-segunda-firma.test.tsx:328-341` y `:503-528`):

1. `estadoFinal === "payout_submitted"` — **el recorrido cerró**. Un conteo sobre un recorrido cortado
   contaría 1 y la premisa parecería falsa. Este assert va **primero** y cierra ese falso KILLED.
2. `enlace === ["no-corresponde","no-corresponde"]` — **fue el camino inyectado**, con el de enlace
   *sembrado* y aun así apagado. Sin esto el número podría venir del otro camino.
3. `firmados.length` = **2** / **1**.
4. En `-1`, además: `cuerpo.sessionToken` es `string` **y** `Object.hasOwn(cuerpo,"popChallenge") === false`
   ⇒ la sesión **viajó** y el gateway **eligió**. Sin esta mitad, un gateway que simplemente dejara de
   mandar credencial daría el mismo `1`.

### 1.2 · El 2 del camino por enlace — lo que SÍ está medido y lo que NO

🔴 **No existe ningún test que corra el recorrido por enlace end-to-end contando firmas.** Verificado:
`/usr/bin/grep -rln "InMemorySesionStore|SesionReader|sessionToken" src/ app/` devuelve 17 archivos y
**ninguno** ejercita el recorrido por enlace con almacén de sesión.

El `2` se sostiene sobre dos mediciones **ejecutadas** más una premisa **no medida en esta ola**:

| # | Eslabón | Estado |
|---|---|---|
| (i) | Un almacén **nuevo** no encuentra la sesión anterior: `despues.peek(...)` ⇒ `toBeNull()` | 🟢 ejecutado — `T-372-W3-8`, `sesion-borra-la-segunda-firma.test.tsx:571-576` |
| (ii) | Con `peek()` en `null`, el gateway llama `prove()` **1 vez** y el body viaja **sin** `sessionToken` | 🟢 ejecutado — `T-372-W3-6`, `http-solana-prepare-gateway.test.ts:825` |
| (iii) | El salto por enlace **remonta el árbol de React** ⇒ instancia nueva del almacén | 🟡 **NO MEDIDO en W3.** Es doctrina heredada (`sesion-store.ts:23-25`), no una corrida |

⇒ **El `2` por enlace es una derivación bien fundada, no una medición.** Va al founder con esa etiqueta.

### 1.3 · ¿Alguna frase promete la firma de menos en Chrome? — **NO**

Barrido: `/usr/bin/grep -rn "una sola firma|una sola vez|deja de pedir|no vuelve a pedir|una firma menos"`
sobre `src/ app/ scripts/ README.md README.es.md`, más el barrido de `SIWS|dos firmas|segunda firma`
sobre los 6 archivos que W3 escribió, `.env.example` y los dos README.

- **Las cuatro frases del copy no cuentan firmas.** `COPY_FIRMA_DE_IDENTIDAD` (`flow.tsx:3902`) es
  `["Te vamos a pedir una firma para confirmar que la billetera es tuya.", "Es gratis.", "No mueve tus
  USDC ni autoriza ningún pago.", "Si te la volvemos a pedir, es por lo mismo: confirmar que es tuya."]`
  — la 4ª es la **reescrita** por la enmienda del orquestador, verdadera en los dos caminos.
- **`sesion-store.ts:8`** dice *«una firma menos, sin aflojar un solo guard del servidor»*. Es la frase
  más suelta del entregable, **y queda calificada 15 líneas más abajo**, en `:23-25`: *«El camino por
  enlace profundo pierde esta sesión en cada salto ⇒ cae al PoP solo … conserva EXACTAMENTE el
  comportamiento de hoy»*. **No es hallazgo**, pero es la única frase que, leída sola, sobre-promete.
- **`.env.example:402`** (*«es lo que borra la segunda [firma]»*) describe el **mecanismo de `prepare`**,
  no un conteo por camino. Correcta.

⇒ **Cero frases que prometan la firma de menos en Chrome.**

---

## 2 · Los ACs

| AC | Status | Cita | **Ejecución** (comando + resultado) |
|---|:---:|---|---|
| **AC-3-1** — no pedir una segunda firma de identidad si ya probó posesión | ✅ **PASS** | `http-solana-prepare-gateway.ts:277-296`; `container.ts:106`,`:161`,`:185` | `vitest run src/presentation/sesion-borra-la-segunda-firma.test.tsx` ⇒ `T-372-W3-1` ✓ (**1** firma) contra `T-372-W3-0a` ✓ (**2**). 8/8 verdes |
| **AC-3-2** — `prepare` acepta sesión **o** PoP; cualquier otra cosa ⇒ 403 opaco, incluido un `popChallenge` crudo | ✅ **PASS** | `app/api/payout/prepare/route.ts` `S1..S5` dentro de `PR5'` | `vitest run app/api/payout/prepare/route.test.ts` ⇒ `T-372-W3-2` ✓ (crudo⇒403 **+ control positivo**: el mismo token sigue sirviendo de `popChallenge`), `-3` ✓ (3 ids ⇒ mismo cuerpo, 0 llamadas al proveedor), `-4` ✓ (binding), `-5` ✓ (vencida), `-13` ✓ (rate-limit antes), `-21` ✓. **Y contra el servidor VIVO**: `node scripts/probe-sesion-de-posesion.mjs https://chaski-v2.vercel.app` ⇒ `(b) sesión válida ⇒ 403 prepare_kyc_verdict_missing`, `(c) sin credencial ⇒ 403 idéntico para los tres` |
| **AC-3-3** — sin sesión o vencida, pedir la firma **como hoy**, sin error | ✅ **PASS** | `http-solana-prepare-gateway.ts:283-296`, `:361`; `sesion-store.ts` `peek()` | `T-372-W3-5` ✓, `-6` ✓ (prove 1 vez, body **sin la propiedad**), `-6b` ✓, `-6c` ✓, `-7`/`-7b`/`-7c` ✓, `-17` ✓ (reintento único, 4 ramas), `-20` ✓. **Vivo**: probe `(a) PoP válido ⇒ 403 prepare_kyc_verdict_missing — atravesó el gate` |
| **AC-3-4** — fundir `connect` + firma en **un** permiso (SIWS) | ⚪ **NO VERIFICABLE — DEFERIDO** | — | ⛔ **Sin instrumento, por decisión del orquestador.** Verificado: `git diff --name-only f295a6f c1bd8d3 -- public/` ⇒ **vacío**. La medición es con el teléfono del founder, fuera del repo. 🔴 ***«No se pudo preguntar» NO es «no soporta».*** |
| **AC-3-5** — la recarga vuelve a pedir la **primera** firma | ✅ **PASS** | `sesion-store.ts:16-25` (en memoria, prohibición dura) | `T-372-W3-8` ✓: monta el árbol **dos veces**, corre el recorrido entero las dos; almacén nuevo ⇒ `peek()` `null`; y el token **no** aparece en `localStorage`, `sessionStorage`, `document.cookie` ni `location.href` |
| **AC-3-6** — decir qué firma, que es gratis, que no mueve plata, y qué pasa si la vuelven a pedir | ✅ **PASS**, con la 4ª frase **reformulada** (enmienda del orquestador) | `flow.tsx:3902` (`COPY_FIRMA_DE_IDENTIDAD`), Δ0 | `vitest run src/presentation/wallet-availability.test.tsx` ⇒ `T-372-W3-10` ✓ (las 4, en `"injected"` **y** en `"none"`, **importando la constante** ⇒ el guard no se lee a sí mismo), `T-372-W3-10c` ✓ (sin em dash, sin «falló», sin `SOL`), `T-372-W3-10b` ✓ (**la verdad de la frase 4**: todo mensaje firmado se reconstruye con `buildSolanaPopMessage` y no lleva monto ni beneficiario) |

**5 PASS · 1 NO VERIFICABLE (deferido con razón escrita) · 0 FAIL.**

---

## 3 · La premisa de la ola W3.0 — corrida y auditada

**5/5 verdes, y las cinco miden lo que dicen** (revisé el cuerpo de cada `it`, no sólo el nombre):

| Test | Afirma | ¿Mide lo que dice? |
|---|---|---|
| `-0a` | 2 firmas hoy en el inyectado | ✅ con estado terminal + camino asertados (§1.1) |
| `-0b` | el challenge se emite **sin firma** para una address arbitraria | ✅ ejercita el **handler real**, no un doble: `status === 200` y `typeof cuerpo.popChallenge === "string"` |
| `-0c` | `prepare` ignora cookie y header | ✅ **manda el request con cookie y header** y compara la respuesta byte a byte, con un control que produce un `400` distinto para probar que el instrumento sabe distinguir |
| `-0d` | `PopSigner` no tiene `peek` | ✅ mecanismo de **tipo** (`@ts-expect-error`) **+** runtime (`"peek" in firmante === false`) **+ control positivo** (`"prove" in firmante === true` y `"peek" in new InMemoryPopProofStore(...)`) ⇒ no muere por colapso del resolvedor |
| `-0e` | `kyc_session_tokens` no sirve de sesión | ✅ **ejercita `getForOwner`**, no lee prosa de la migración: verifica columnas (`["decision_token"]`), filtros (`["session_id","owner_address"]`) y que **ningún filtro sea `exp`** |

---

## 4 · CD-7 · El orden de despliegue — verificado **contra el servicio vivo, ahora**

```
$ node scripts/probe-sesion-de-posesion.mjs https://chaski-v2.vercel.app
probe de la sesión de posesión · https://chaski-v2.vercel.app
  billetera efímera: 5SL6HZ9V1rTx9HshQPfJsZPH1fXJ53dm9dHCxcpgHb83
  (a) PoP válido      ⇒ 403 prepare_kyc_verdict_missing — atravesó el gate de identidad
  (b) sesión válida   ⇒ 403 prepare_kyc_verdict_missing — mismo desenlace que (a)
  (c) sin credencial  ⇒ 403|{"error":"payout_pop_unverified"} — idéntico para los tres identificadores
[exit 0] las tres afirmaciones ok. El servidor acepta la sesión: W3.4 puede arrancar.
PROBE_EXIT=0
```

**Una sola corrida, sin bucle.** Y lo que este `exit 0` deja probado, que es más de lo que dice:

1. 🟢 **El receptor está desplegado y acepta la sesión.** `origin/main` = `3178360`, que **contiene**
   `8ffdd78` (merge de W3.0-W3.3, el receptor). Verificado: `git merge-base 8ffdd78 3178360` = `8ffdd78`.
2. 🟢 **El cliente NO está desplegado.** `1efc8b0`/`6bd089f` (W3.4) están sólo en `main` local, sin
   pushear. ⇒ **el orden `receptor → sonda verde → cliente` se cumplió y sigue cumpliéndose ahora mismo.**
3. 🟢 **Paridad de env verificada en runtime**: la afirmación (b) **exige** que `/api/kyc/verdict`
   devuelva el campo `sesion`, y sin `PAYOUT_SESSION_SECRET` puesta en el proveedor eso da **`exit 30`**.
   Dio `0` ⇒ **`PAYOUT_SESSION_SECRET` está puesta en producción.** *(Es la única forma programática
   que tengo de leer esa env: no hay acceso al panel del proveedor.)*
4. 🟢 **Control positivo del instrumento**: `node scripts/probe-sesion-de-posesion.mjs` sin URL ⇒
   `exit=30`. El script **sabe** salir por 30, así que el `0` no es un exit code tapado.
5. ✅ No creó ninguna orden de payout: usa una billetera recién generada, sin fila de veredicto, y las
   tres afirmaciones cortan en el gate de identidad.

---

## 5 · Seguridad — el hallazgo del AR, cerrado y verificado **ejecutando**

`AR/BLQ-BAJO-2`: las tres credenciales de identidad viajaban al agente externo en el cuerpo de `/compose`.

```
$ ./node_modules/.bin/vitest run app/api/payout/prepare/route.test.ts
 ✓ T-372-W3-21: el cuerpo que llega al agente NO lleva ninguna de las tres credenciales de identidad
```

El `it` **captura el cuerpo que efectivamente viajó** (`route.test.ts:2181`) y tiene las dos mitades:

- **(a) control positivo**: `res.status === 200`, el cuerpo capturado **no está vacío** y contiene el
  DID, el beneficiario y la clave de idempotencia ⇒ el forward **ocurrió** y llevó el pedido de verdad.
  Sin esto, un `/compose` que nunca se llamara pasaría las tres ausencias en verde.
- **(b) las tres ausencias**, por **clave y por valor**, sobre `sessionToken`, `popChallenge` y
  `popSignature`, más `not.toContain(token)` sobre el token concreto (`route.test.ts:2208`).
- El POST lleva **las tres a la vez**, así que una implementación que sacara sólo la que el `it` mira
  no daría verde.
- Y quedó **doblemente candado**: `kyc-verification-id-guard.static.test.ts` se **re-apuntó** al símbolo
  nuevo (`...alAgente`) en vez de aflojarse a un `.includes` genérico ⇒ revertir el arreglo pone **dos**
  tests en rojo. Verifiqué el diff: la aserción sigue siendo de **orden dentro del spread**
  (`pisada.indexOf("...alAgente") < pisada.indexOf(NEEDLE)`). **El guard no se debilitó.**

---

## 6 · Drift

### 6.1 · Escala: **38 archivos** contra los **23** del Scope IN (§3.1) — **+15, todos comentario**

Derivado por mí: unión de `git diff --numstat f295a6f 8ffdd78` y `3178360 c1bd8d3` (excluye WKH-373).

**Los 15 extras son 100 % comentario / cita / marcador de censo.** Verificado con
`git diff --word-diff=plain`: **cero líneas ejecutables**. Salen del `AR/BLQ-MED-1` (9 citas que las
inserciones de W3 corrieron y que vivían en archivos vecinos).

🟡 **HALLAZGO MENOR — el Story File se contradecía consigo mismo, y se resolvió bien.**
§3.2 declaraba `solana-wallet.ts` como *«cero líneas, ni un comentario»* y §3.2 lo mismo para
`deeplink/**`, `preparacion-por-enlace.ts`, `confirm-and-send.ts` y `flow-vm.ts`; **pero T-45 obligaba a
re-derivar TODAS las citas que la ola corriera**, y esas citas vivían justo ahí. **Las dos reglas eran
incompatibles.** Se eligió cumplir T-45. La elección es la correcta (una cita rota es un defecto real;
un comentario tocado no lo es), pero **el Scope OUT quedó violado en 7 archivos** y eso se registra.

Lo que blinda que la violación fue inocua, medido:

- `wc -l src/infrastructure/solana-wallet.ts` ⇒ **2498** (idéntico a `f295a6f`).
- Sus marcadores de censo: `lineas=2498` **sin cambio**. `entrantes` (127→130) y `destinos` (68→69) **NO
  los movió W3**: cambiaron en `3178360`, que es **WKH-373**. Verificado commit por commit
  (`f295a6f`=127/68, `8ffdd78`=127/68, `3178360`=130/69, `c1bd8d3`=130/69).
- `wc -l src/presentation/flow.tsx` ⇒ **4453**. 🟢 **Δ0 ESTRICTO cumplido** (8 líneas cambiadas, 0 netas).

### 6.2 · Scope OUT duro — respetado

- 🟢 **`public/**` ⇒ CERO archivos.** `git diff --name-only f295a6f c1bd8d3 -- public/` vacío. `AC-3-4`
  quedó deferido **sin construir el instrumento**, tal como mandaba la enmienda.
- 🟢 `app/api/kyc/session/route.ts`, `app/api/kyc/decision/route.ts`, `src/infrastructure/rate-limit.ts`,
  `pop-challenge.ts`, `pop-proof-store.ts`, `http-pop-signer.ts`, `solana-escrow-rent.ts`,
  `bienvenida.tsx`, `src/infrastructure/a2a/**`: **fuera del diff, cero líneas**.
- 🟢 Cero líneas en `wasiai-a2a/src/`.

### 6.3 · Orden de olas — correcto

`064870d`(W3.0) → `1422280`(W3.1) → `0b30082`(W3.2) → `aeb0163`(W3.3) → merge `8ffdd78` →
`1efc8b0`(W3.4) → `7609533`(W3.5) → `a853d36`(W3.6) → merge `6bd089f` → fix-pack AR `726b9c4` →
fix-pack CR `32195ed`. **Sin saltos, y el receptor mergeó antes que el cliente.**

### 6.4 · Citas — muestra de **21**, re-derivadas por mí con `sed -n 'Np'`

**21/21 resuelven.** Incluidas **las dos anclas de `app/api/payout/prepare/route.ts:480-481`**, que son
las que el CR encontró rotas en el fix-pack anterior:

```
$ sed -n '480p;481p' app/api/payout/prepare/route.ts   # anclas
  ... (`sinCredenciales`, `./route.test.ts:2181`) ...
  ... (`sinCredenciales`, `./route.test.ts:2208`) ...
$ sed -n '2181p' app/api/payout/prepare/route.test.ts
      if (String(url).includes("/compose")) sinCredenciales = String(init?.body ?? "");
$ sed -n '2208p' app/api/payout/prepare/route.test.ts
      expect(sinCredenciales, `\`${clave}\` aparece en el cuerpo que viajó al gateway`).not.toContain(clave);
```

Y —esto es lo que el CR pedía— **las dos anclas ahora entran al conjunto del candado**. Apliqué el
regex literal de `citas-ancladas.test.ts:73` sobre esas líneas:

```
linea 480 => ancla: sinCredenciales -> ./route.test.ts:2181
linea 481 => ancla: sinCredenciales -> ./route.test.ts:2208
```

Antes quedaban partidas por un `//` en el medio y **el guard no las miraba**. Ahora sí.

Las otras 19 verificadas: `route.ts:394/405/408` (`payout_authority_unavailable`), `:371`
(`prepare_kyc_verdict_missing`), `:392` (`resolvePayoutAuthority`), `:288`
(`verifySolanaPopChallenge`), `kyc/verdict/route.ts:362`, `http-solana-prepare-gateway.ts:227/290/455`,
`fakes.ts:1212`, `http-kyc-verdict-gateway.ts:57/74`, `sesion-de-posesion.ts:61/95`,
`pop-proof-store.ts:40`, `flow.tsx:460`, `container.ts:106`. **Ninguna rota.**

---

## 7 · Gate del repo — corrido por mí, **completo y en orden**, contra el índice de git

```
$ /usr/bin/git add -A            # árbol ya limpio: índice == HEAD (no-op verificado)
$ npm run qa                     # lint → typecheck → typecheck:scripts → test
  > biome lint src app scripts
    Checked 310 files in 116ms. No fixes applied.
    Found 140 warnings.  Found 1 info.        (0 errores)
  > tsc --noEmit                                (sin salida)
  > tsc -p tsconfig.scripts.json --noEmit       (sin salida)
  > vitest run
    Test Files  172 passed (172)
         Tests  3491 passed (3491)
QA_EXIT=0

$ npm run build                  # next build --webpack
BUILD_EXIT=0
```

**Sin flake**: el `vuelta-por-enlace-carrera.test.tsx` pasó en la única corrida.
**Los dos README publican `172`** (`README.md:436` = `**172 test files**`, `README.es.md:462` =
`**172 archivos de test**`), y **`172` es exactamente lo que devolvió `vitest`**. El número reproduce.

### 7.1 · ⚠️ El alcance del gate **no cubre** un entregable de esta ola

Comprobado, no supuesto:

```
$ ./node_modules/.bin/biome lint scripts/probe-sesion-de-posesion.mjs
  i These paths were provided but ignored:
  - scripts/probe-sesion-de-posesion.mjs
```

`biome.jsonc` → `files.includes` enumera sólo `**/*.ts(x)`, y `tsconfig.scripts.json` incluye sólo
`scripts/**/*.ts`. ⇒ **`scripts/probe-sesion-de-posesion.mjs` no lo mira NINGUNA herramienta del gate.**

- 🟢 **No es un hallazgo de W3**: es preexistente (le pasa igual a `scripts/probe-vuelta-por-enlace.mjs`),
  y **el propio Dev lo midió, lo escribió en el docblock del script y corrigió al Story File §0.3**, que
  afirmaba lo contrario (*«el `.mjs` nuevo SÍ se lintea»*). Esa corrección es correcta y la re-verifiqué.
- Controles que sí tiene, verificados por mí: `node --check` ⇒ exit 0; y el camino de `exit 30` ⇒
  `node scripts/probe-sesion-de-posesion.mjs` sin URL ⇒ **`exit=30`**.

---

## 8 · 🔴 LO QUE NADIE VERIFICÓ — dicho sin suavizar

1. **NADIE CORRIÓ ESTO EN UN TELÉFONO.** Ni yo, ni el Dev, ni el AR, ni el CR. Los `it` corren bajo
   `jsdom` y el probe corre **desde una consola**. Verificado que el código **no afirma lo contrario**:
   el docblock del probe declara sus tres límites *antes* de su `exit 0` (*«corre desde una CONSOLA, no
   desde un teléfono … NO prueba la UI … NO dice cuánto tarda un recorrido real»*).
2. **La sesión NO sobrevive al salto por enlace.** Es una **limitación declarada, no un defecto**: es el
   mecanismo por el cual `AC-3-5` se cumple por construcción, y está escrito con su razón en
   `sesion-store.ts:16-25`. **Ninguna frase del producto la contradice** (§1.3).
3. **`AC-3-4` está DEFERIDO. *«No se pudo preguntar» NO es «no soporta».*** No se construyó instrumento
   (cero archivos bajo `public/`, verificado). El protocolo de medición está escrito en `story-W3.md`
   §2.2, con **Testnet Mode como precondición** y un **paso de control** cuyo fallo obliga a detenerse.
4. **`AC-3-6` cierra con la 4ª afirmación REFORMULADA**, no con el texto literal del AC original. La
   razón está medida (`flow.tsx:460` recarga la página y la sesión vive en memoria ⇒ gatearla a
   `"injected"` no la volvería verdadera) y verificada por mí: `sed -n '460p'` ⇒
   `window.location.href = res.url;`.
5. **El `2` del camino por enlace es derivado, no medido end-to-end** (§1.2, eslabón (iii)).
6. **Sin medir, y el propio plan de tests lo declara**: si Phantom soporta SIWS por enlace profundo,
   cuánto tarda de verdad un recorrido real, y **si los 30 minutos de TTL alcanzan**.
7. **La sesión sólo se probó contra `chaski-v2.vercel.app`.** No hay otro entorno verificado.

---

## 9 · Seguimiento de AR / CR

| Hallazgo | Estado verificado por mí |
|---|---|
| `AR/BLQ-MED-1` (9 citas corridas) | ✅ cerrado — 21/21 de mi muestra resuelven (§6.4) |
| `AR/BLQ-BAJO-2` (credenciales al agente) | ✅ cerrado y **ejecutado** — `T-372-W3-21` + candado estático re-apuntado (§5) |
| `AR/BLQ-BAJO-1`, `AR/MNR-1..3` | ✅ cerrados en `726b9c4` |
| `CR/BLQ-BAJO-1` (la cita que el fix-pack rompió) | ✅ cerrado — las dos anclas en **una línea cada una** y **dentro** del regex del candado (§6.4) |
| `CR/BLQ-BAJO-2`, `CR/BLQ-BAJO-3` | ✅ cerrados en `32195ed` |
| `CR/MNR-1..7` | Aceptados como TD. `CR/MNR-5` (CD-W3-10, escala) quedó **re-derivado** en el commit `32195ed`: 2857 líneas / 38 archivos = 1,68x / 1,73x — **coincide con mi cuenta independiente de 38 archivos** |

---

## 10 · Veredicto

**APROBADO PARA DONE.**

- **0 ACs en FAIL.** 5 PASS con ejecución, 1 NO VERIFICABLE **deferido con razón escrita y sin
  instrumento construido** (que es exactamente lo que la enmienda pedía).
- **Gate completo del repo verde**, corrido por mí, en orden, contra el índice: `npm run qa` exit 0
  (172 archivos / 3491 tests) → `npm run build` exit 0.
- **Runtime contra el servicio vivo**: probe `exit 0`, orden de despliegue `CD-7` cumplido, y
  `PAYOUT_SESSION_SECRET` confirmada en producción por consecuencia observable.
- **Drift**: 15 archivos de más, **todos comentario**, con la contradicción interna del Story File
  documentada arriba (§6.1) como **MENOR**. Δ0 de `flow.tsx` y de `solana-wallet.ts` intactos.

⚠️ **Y el número que va al founder, con su etiqueta**: **de 2 firmas de identidad a 1 en el navegador
de la billetera —medido corriendo—; por enlace profundo siguen siendo 2 —derivado, no medido—.**

**Árbol dejado como se encontró**: `git status --porcelain` vacío, índice == HEAD, `c1bd8d3`, sin pushear.
