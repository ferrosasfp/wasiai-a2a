# Report — HU 233 · [WKH-372] El recorrido móvil sin saltos · **OLA W3**

> **Estado: DONE (ola W3) — mergeada a `main` local de `chaski-v3` en `c1bd8d3`, árbol limpio,
> PENDIENTE DE PUSH.** `origin/main` está en `3178360`, que **ya contiene el receptor** (`8ffdd78`)
> pero **no el cliente**. **La HU 233 sigue ABIERTA:** queda la **`071` de `chaski-v3`** (el SOL) y
> **W4** (decisión de riesgo, sin dueño). **W3 no cierra la HU.**
>
> **Fecha de cierre:** 2026-09-01 · **Modo:** QUALITY · **Repo del trabajo:** `chaski-v3`
> **Repo ancla de los artefactos:** `wasiai-a2a` (`doc/sdd/233-recorrido-movil-sin-saltos/`),
> **cero líneas de `src/`** tocadas acá.
>
> Este reporte se compiló **leyendo los artefactos** (`work-item.md`, `sdd-w3.md`, `story-W3.md`,
> `adversarial-review-w3.md`, `code-review-w3.md`, `validation-w3.md`, `auto-blindaje.md`), no de
> memoria. Cada número tiene su fuente nombrada. Lo que nadie midió se dice con esas palabras, y lo
> que yo re-derivé va marcado como propio.

---

## 1 · Resumen ejecutivo

W3 le da al servidor una **sesión de posesión**: cuando la persona ya probó que la billetera es suya,
el servidor emite un token firmado (HMAC, TTL 30 minutos) y `prepare` lo acepta **en lugar de** una
segunda firma. Las dos firmas de identidad que el recorrido pedía **probaban exactamente lo mismo**;
ahora, en el navegador de la billetera, se pide **una**.

- **El número, con su etiqueta**: **2 → 1 firmas de identidad en el navegador de la billetera / la
  extensión** — 🟢 **medido de punta a punta**. **Por enlace profundo (Chrome móvil) siguen siendo
  2 → 2** — 🟡 **derivado, NO medido de punta a punta**. Ver §3, que es la sección que importa.
- **Un hallazgo de seguridad real, encontrado y cerrado dentro de la ola**: las tres credenciales de
  identidad viajaban al agente externo en el cuerpo de `/compose`. Ya no viajan (§5).
- **Gate completo del repo, corrido por F4 contra el índice y en orden**: `npm run qa` **exit 0**
  (biome 310 archivos · `tsc --noEmit` · `tsc:scripts` · **172 archivos / 3491 tests**) +
  `npm run build` **exit 0**. Sin flake.
- **Un gate de despliegue en el medio del F3**, y se cumplió en el orden correcto: receptor primero,
  sonda contra el servicio vivo en `exit 0`, cliente después (§4).
- **Dos fix-packs.** AR RECHAZADO → fix-pack 1 → CR RECHAZADO → fix-pack 2 → F4 **APROBADO**.
- ⛔ **Nadie corrió esto en un teléfono.**

**Archivos clave del entregable** (todos en `/home/ferdev/.openclaw/workspace/chaski-v3`):
`src/infrastructure/auth/sesion-de-posesion.ts` (el token firmado, server-only),
`src/infrastructure/auth/sesion-store.ts` (el almacén del cliente, **en memoria a propósito**),
`app/api/payout/prepare/route.ts` (la rama `S1..S5`: sesión **o** PoP, y cualquier otra cosa ⇒ 403
opaco), `src/infrastructure/settlement/http-solana-prepare-gateway.ts` (el cliente que elige).

---

## 2 · Qué cambió para la persona que usa la app

Sin jerga, y sólo lo que la persona ve:

1. **En el navegador de la billetera, ahora se le pide UNA sola firma de identidad, no dos.** Antes se
   le pedían dos y las dos probaban lo mismo: que la billetera es suya.
2. **Esa firma sigue siendo gratis y no mueve plata.** La pantalla lo dice con cuatro frases:
   *"Te vamos a pedir una firma para confirmar que la billetera es tuya."* · *"Es gratis."* · *"No
   mueve tus USDC ni autoriza ningún pago."* · *"Si te la volvemos a pedir, es por lo mismo:
   confirmar que es tuya."*
3. **La cuarta frase es honesta a propósito.** Dice *"si te la volvemos a pedir"* en vez de prometer
   que no va a pasar, porque **por enlace profundo sí vuelve a pasar** y porque **recargar la página
   también la vuelve a pedir**. Ninguna frase del producto promete una firma menos en Chrome:
   verificado con un barrido, `validation-w3.md` §1.3.
4. **Si la sesión se venció o no existe, se pide la firma como siempre, sin ningún mensaje de error.**
   No hay pantalla nueva, no hay "algo falló", no hay "empezá de nuevo".
5. **Nada se guarda en el disco del teléfono.** La sesión vive en memoria: no está en `localStorage`,
   ni en `sessionStorage`, ni en una cookie, ni en la URL. Recargar la página la borra.
6. **Lo que ya existía sigue existiendo.** Quien entre por enlace profundo tiene el recorrido
   **idéntico** al de antes: no se borró una línea de ese camino.

---

## 3 · 🔴 LA TABLA DE FIRMAS, CON SU ETIQUETA DE CONFIANZA

**Es el dato de la ola.** Los dos números no valen lo mismo y no se presentan como si valieran igual.

| Camino | Antes de W3 | Después de W3 | Confianza |
|---|:---:|:---:|---|
| **Navegador de la billetera / extensión** (`"injected"`) | **2** | **1** | 🟢 **MEDIDO DE PUNTA A PUNTA** |
| **Enlace profundo** (Chrome móvil, `"none"`) | **2** | **2** | 🟡 **DERIVADO, NO medido de punta a punta** |

### 3.1 · El `2 → 1` — por qué es verde

Lo corrió F4, con el comando literal (`validation-w3.md` §1.1):

```
$ ./node_modules/.bin/vitest run src/presentation/sesion-borra-la-segunda-firma.test.tsx
 ✓ T-372-W3-0a: en un recorrido inyectado que CIERRA, `signMessage` se invoca EXACTAMENTE 2 veces
 ✓ T-372-W3-1:  con el almacén cableado, el MISMO recorrido invoca `signMessage` EXACTAMENTE 1 vez
 Test Files  1 passed (1)      Tests  8 passed (8)
```

El conteo **no** es un `toHaveBeenCalled()` suelto. Los dos `it` asertan, en este orden, cuatro cosas
(`sesion-borra-la-segunda-firma.test.tsx:328-341` y `:503-528`):

1. `estadoFinal === "payout_submitted"` — **el recorrido cerró**. Va **primero**, y es lo que impide
   el falso verde: un recorrido cortado contaría 1 y la mejora parecería real sin serlo.
2. `enlace === ["no-corresponde","no-corresponde"]` — **fue el camino inyectado**, con el de enlace
   sembrado y aun así apagado. Sin esto el número podría venir del otro camino.
3. `firmados.length` = **2** contra **1**.
4. En el de `1`: `cuerpo.sessionToken` es `string` **y** `Object.hasOwn(cuerpo,"popChallenge")` es
   `false` ⇒ la sesión **viajó** y el gateway **eligió**. Sin esta mitad, un gateway que simplemente
   dejara de mandar credencial daría el mismo `1`.

Y el rojo de cierre se produjo **con `git stash` contra el árbol de `main`**, no con un mutante
escrito para la ocasión (`auto-blindaje.md`, entrada del 2026-09-01 13:05): *"expected 2 to be 1"*.

### 3.2 · El `2 → 2` — por qué es amarillo, dicho sin suavizar

⛔ **No existe ningún test que corra el recorrido por enlace profundo de punta a punta contando
firmas.** F4 lo verificó buscando: un barrido de `InMemorySesionStore|SesionReader|sessionToken`
sobre `src/` y `app/` devuelve 17 archivos y **ninguno** ejercita el recorrido por enlace con almacén
de sesión (`validation-w3.md` §1.2).

El `2` se apoya en **dos eslabones ejecutados** más **una premisa no medida en esta ola**:

| # | Eslabón | Estado |
|---|---|---|
| (i) | Un almacén **nuevo** no encuentra la sesión anterior: `despues.peek(...)` ⇒ `toBeNull()` | 🟢 ejecutado — `T-372-W3-8` |
| (ii) | Con `peek()` en `null`, el gateway llama `prove()` **1 vez** y el body viaja **sin** `sessionToken` | 🟢 ejecutado — `T-372-W3-6` |
| (iii) | El salto por enlace **remonta el árbol de React** ⇒ instancia nueva del almacén | 🟡 **NO MEDIDO en W3.** Es doctrina heredada (`sesion-store.ts:23-25`), no una corrida |

⇒ **El `2` por enlace es una derivación bien fundada. No es una medición.** Va al founder con esa
etiqueta y no se redondea a "igual que antes, comprobado".

---

## 4 · Pipeline ejecutado — el recorrido real, con su gate de despliegue y sus dos fix-packs

| Fase | Qué pasó |
|---|---|
| **F2** | `sdd-w3.md`. Presupuesto declarado por escrito **antes** de codear: **≤ 1.700 líneas añadidas y ≤ 22 archivos** (`:676`), con **`CD-W3-10`**: el presupuesto se contrasta en **CADA** fix-pack. |
| ⛔ **Gate** | **`SPEC_APPROVED`** — revisión clínica del orquestador, **2 desviaciones resueltas**. |
| **F2.5** | `story-W3.md`. 23 archivos de Scope IN contados uno por uno (el SDD decía «22» contando los dos README como una fila). |
| **F3 · receptor** | `W3.0` (la premisa falsable, **0 líneas de producción**) → `W3.1` (el módulo de la sesión, server-only) → `W3.2` (`prepare` acepta sesión **O** PoP, **el cliente intacto**) → `W3.3` (el probe contra el servicio vivo). Merge `8ffdd78`. |
| 🚦 **GATE DE DESPLIEGUE (`CD-7`)** | El orquestador desplegó el receptor; **el founder puso `PAYOUT_SESSION_SECRET`** en el proveedor; la sonda `scripts/probe-sesion-de-posesion.mjs` corrió **contra el servicio vivo** y dio **`exit 0`**. Recién ahí arrancó el cliente. |
| **F3 · cliente** | `W3.4` (el cliente usa la sesión) → `W3.5` (las 4 frases del copy, **Δ0 en `flow.tsx`**) → `W3.6` (el conteo de los dos README). Merge `6bd089f` + `781aafd`. |
| **AR** | **RECHAZADO** — **1 `BLQ-MEDIO`** (9 citas que la ola corrió y no re-derivó) **+ 2 `BLQ-BAJO`** (las credenciales viajando al agente; una frase de cobertura falsificable con una edición de una línea) **+ 3 `MNR`**. Seis vectores atacados, con mutantes aplicados y restaurados. |
| **fix-pack 1** | `726b9c4` → merge `a392f6b`. |
| **CR** | **RECHAZADO** — **3 `BLQ-BAJO` + 7 `MNR`**. Los tres bloqueantes son **frases y citas del money-path que no reproducen**, los tres medidos corriendo. **Ninguno rompe un AC ni abre una vulnerabilidad.** Y el CR **verificó ejecutando los seis cierres del AR**, incluida la lectura del schema **en el otro repo** para probar que sacar las credenciales **no rompe el pago**. |
| **fix-pack 2** | `32195ed` → merge `c1bd8d3`. |
| **F4 (QA)** | ✅ **APROBADO PARA DONE** — **5 ACs PASS / 0 FAIL / 1 NO VERIFICABLE (deferido)**, 1 hallazgo MENOR de drift, gate completo corrido, 21 citas re-derivadas a mano, y el probe re-corrido contra producción. |
| **DONE** | Este reporte + la fila 233 del `_INDEX.md` + la consolidación del Auto-Blindaje. |

### 4.1 · El dato que vale del pipeline

**El gate de despliegue funcionó como control, no como trámite.** F4 lo re-verificó **ahora**, contra
el servicio vivo, y el `exit 0` deja probadas cuatro cosas que el script no dice en voz alta
(`validation-w3.md` §4): que el receptor está desplegado y **acepta la sesión**; que el cliente
**todavía no** está desplegado (`1efc8b0`/`6bd089f` viven sólo en `main` local); que
**`PAYOUT_SESSION_SECRET` está puesta en producción** —deducido por consecuencia observable, porque
sin ella la afirmación (b) da `exit 30`—; y que el instrumento **sabe fallar** (sin URL ⇒ `exit 30`),
así que el `0` no es un exit code tapado.

**Y cada revisión encontró lo que la anterior no podía ver desde su lente**: el AR atacó el
money-path y **capturó el pedido saliente**; el CR **corrió la receta de mutación publicada en su
lectura literal** y descubrió que no reproducía; F4 midió el árbol final contra el Scope y encontró
la contradicción interna del story file. **Ninguna de las tres fue redundante.**

---

## 5 · 🔒 El hallazgo de seguridad, y su cierre

**`AR/BLQ-BAJO-2` — las tres credenciales de identidad viajaban al agente externo en el cuerpo de
`/compose`.**

`app/api/payout/prepare/route.ts` armaba `{ ...body, kycVerificationId: rowVerificationId }` y lo
mandaba **tal cual** como `input` del `/compose`. El AR lo **midió capturando el pedido**, no
leyéndolo:

```
AR-PROBE status 200
AR-PROBE url https://gateway.test/compose | sessionToken en el body? true | len 618
```

El `sessionToken` llegaba verbatim al gateway A2A y de ahí al agente que resuelve
`remittance-payout`, **que es un tercero elegido por capacidad**. Ese agente podía reenviarlo a
`POST /api/payout/prepare` durante **30 minutos** y crear órdenes a nombre de esa dirección.

**Cerrado en el fix-pack 1 y verificado ejecutando por el CR y por F4:**

- El objeto que se spreadea pasó a llamarse `alAgente` = el body **menos** `sessionToken`,
  `popChallenge` y `popSignature`.
- `T-372-W3-21` **captura el cuerpo que efectivamente viajó** y tiene **las dos mitades**: control
  positivo (`res.status === 200`, el cuerpo **no está vacío** y lleva el DID, el beneficiario y la
  clave de idempotencia ⇒ el forward ocurrió de verdad) **y** las tres ausencias, por clave y por
  valor. El POST lleva las tres a la vez, así que sacar sólo la que el `it` mira no da verde.
- **Doble candado**: `kyc-verification-id-guard.static.test.ts` se **re-apuntó al símbolo nuevo** en
  vez de aflojarse a un `.includes` genérico ⇒ revertir el arreglo pone **dos** tests en rojo, y la
  aserción sigue siendo de **orden dentro del spread**. **El guard no se debilitó** (verificado por
  F4 leyendo el diff).
- **El pago no se rompe, y se comprobó en el otro repo**: `cashout-payout.ts:47-82` declara 7 claves
  y **ninguna de las tres** es una credencial de identidad; el `z.object` no tiene `.strict()`.

### 5.1 · Esto cierra **la mitad** de `R-3`. La otra mitad sigue abierta

`R-3` es un residual declarado desde antes de esta ola, en
`app/api/payout/prepare/route.ts:209-212`. **Tiene dos mitades**:

- ✅ **CERRADA por W3**: la mitad de que la credencial **se le ENTREGUE a un tercero**. Hasta el
  fix-pack, el par `(challenge, firma)` —y desde W3 también la sesión— viajaba en el `forwardBody` al
  agente. Hoy las tres se sacan antes de forwardear, y lo mide `T-372-W3-21` por nombre.
- ⛔ **SIGUE ABIERTA**: **nadie quema el nonce.** Quien capture el par **en la red** lo puede reenviar
  dentro de la ventana del TTL. Restituir el single-use es **una HU aparte** y no la absorbe W3.

---

## 6 · Acceptance Criteria — resultado final

Fuente: `validation-w3.md` §2. Cada AC lleva **cita** *y* **ejecución**.

| AC | Status | Evidencia |
|---|---|---|
| **AC-3-1** · no pedir una segunda firma de identidad si ya probó posesión | ✅ **PASS** | `http-solana-prepare-gateway.ts:277-296`; `container.ts:106`,`:161`,`:185`. `T-372-W3-1` ✓ (**1** firma) contra `T-372-W3-0a` ✓ (**2**), 8/8 verdes, con estado terminal y camino asertados |
| **AC-3-2** · `prepare` acepta sesión **o** PoP; cualquier otra cosa ⇒ 403 opaco, incluido un `popChallenge` crudo | ✅ **PASS** | `route.ts` `S1..S5` dentro de `PR5'`. `T-372-W3-2` ✓ (crudo ⇒ 403 **con control positivo**: el mismo token sigue sirviendo de `popChallenge`), `-3` ✓ (3 identificadores ⇒ mismo cuerpo, 0 llamadas al proveedor), `-4` ✓ (binding), `-5` ✓ (vencida), `-13` ✓ (rate-limit antes), `-21` ✓. **Y contra el servidor VIVO**: probe `exit 0` |
| **AC-3-3** · sin sesión o vencida, pedir la firma **como hoy**, sin error | ✅ **PASS** | `http-solana-prepare-gateway.ts:283-296`, `:361`; `sesion-store.ts` `peek()`. `T-372-W3-5/-6/-6b/-6c/-7/-7b/-7c/-17/-20` ✓. **Vivo**: `(a) PoP válido ⇒ 403 prepare_kyc_verdict_missing — atravesó el gate` |
| **AC-3-4** · fundir `connect` + firma en **un** permiso (SIWS) | ⚪ **NO VERIFICABLE — DEFERIDO** | ⛔ **Sin instrumento, por decisión del orquestador.** `git diff --name-only -- public/` ⇒ **vacío**. La medición es con el teléfono del founder, fuera del repo. 🔴 ***"No se pudo preguntar" NO es "no soporta".*** |
| **AC-3-5** · la recarga vuelve a pedir la **primera** firma | ✅ **PASS** | `sesion-store.ts:16-25`. `T-372-W3-8` ✓: monta el árbol **dos veces**, corre el recorrido entero las dos, almacén nuevo ⇒ `peek()` `null`, y el token **no** aparece en `localStorage`, `sessionStorage`, `document.cookie` ni `location.href` |
| **AC-3-6** · decir qué firma, que es gratis, que no mueve plata, y qué pasa si la vuelven a pedir | ✅ **PASS**, con la 4ª frase **reformulada** (enmienda del orquestador) | `flow.tsx:3902`, **Δ0**. `T-372-W3-10` ✓ (las 4, en `"injected"` **y** en `"none"`, **importando la constante** ⇒ el guard no se lee a sí mismo), `T-372-W3-10c` ✓ (sin em dash, sin «falló», sin `SOL`), `T-372-W3-10b` ✓ (**la verdad de la frase 4**) |

**5 PASS · 1 NO VERIFICABLE (deferido, con razón escrita y sin instrumento construido) · 0 FAIL.**

---

## 7 · 🔴 LO QUE NADIE VERIFICÓ — dicho sin suavizar

1. **NADIE CORRIÓ ESTO EN UN TELÉFONO.** Ni F4, ni el Dev, ni el AR, ni el CR. Los `it` corren bajo
   `jsdom` —que **no es el runtime real**— y el probe corre **desde una consola**. Verificado que el
   código **no afirma lo contrario**: el docblock del probe declara sus tres límites *antes* de su
   `exit 0` (*"corre desde una CONSOLA, no desde un teléfono … NO prueba la UI … NO dice cuánto tarda
   un recorrido real"*).
2. **La sesión NO sobrevive al salto por enlace profundo.** Es una **limitación declarada, no un
   defecto**: es el mecanismo por el cual `AC-3-5` se cumple por construcción, está escrita con su
   razón en `sesion-store.ts:16-25`, y **ninguna frase del producto la contradice** (§3.2, §2.3).
3. **`AC-3-4` está DEFERIDO. *"No se pudo preguntar" NO es "no".*** No se construyó instrumento (cero
   archivos bajo `public/`, verificado). El protocolo de medición está escrito en `story-W3.md` §2.2,
   con **Testnet Mode como precondición** y un **paso de control** cuyo fallo obliga a detenerse.
4. **El `2` del camino por enlace es derivado, no medido de punta a punta** (§3.2, eslabón (iii)).
5. **Sin medir, y el propio plan de tests lo declara**: si Phantom **soporta SIWS por enlace
   profundo**; cuánto tarda de verdad un recorrido real; y **si los 30 minutos de TTL alcanzan**.
6. **`AC-3-6` cierra con la 4ª afirmación REFORMULADA**, no con el texto literal del AC original. La
   razón está medida (`flow.tsx:460` recarga la página y la sesión vive en memoria ⇒ gatear la frase
   a `"injected"` no la volvería verdadera).
7. **La sesión sólo se probó contra `chaski-v2.vercel.app`.** No hay otro entorno verificado.

---

## 8 · El desvío de escala — con el número, no con el adjetivo

| Magnitud | Presupuesto (`sdd-w3.md:676`) | Publicado al cierre | **Re-derivado por Docs** | Factor |
|---|---:|---:|---:|---:|
| Líneas añadidas | **≤ 1.700** | **2.857** | **2.834** | **1,68x / 1,67x** |
| Archivos | **≤ 22** | **38** | **38** | **1,73x** |

⚠️ **Nota de método, medida por mí al compilar este reporte.** El `2.857` sale de sumarle `+34` al
`2.823` del CR. Re-derivando contra el árbol —unión de los dos segmentos que son W3,
`f295a6f..8ffdd78` + `3178360..c1bd8d3`, agregando por archivo— da **2.834 añadidas / 150 borradas /
38 archivos**. La diferencia de 23 líneas es exactamente el modo de falla que la lección **G** de W1
ya describe: **el fix-pack 2 reescribió líneas que la propia ola había añadido**, y sumar deltas las
cuenta dos veces. El `2.823 / 38` del CR **reproduce exacto** con este método en `a392f6b`, así que
el método es el bueno y el que envejeció es el `+34`. **Los dos números cruzan el presupuesto por el
mismo factor y ninguna conclusión cambia**; queda anotado porque la regla es que un número publicado
se re-mide contra el árbol.

**La observación del CR, que es la más útil de las tres del check 7:**

| Clase | Añadidas | Comentario | Código |
|---|---:|---:|---:|
| Tests (+`fakes.ts`) | 1.918 | 563 | **1.221** |
| Producción | 705 | **416** | **261** |
| Script (probe) | 170 | 60 | 98 |

🔴 **El desborde está en los docblocks de PRODUCCIÓN, no en los tests.** El SDD respondió *"~120
líneas de producción"* (`:695`); lo medido es **261 de código de producción** (2,2x) y **416 de
comentario encima** ⇒ **61 % de prosa** contra el **~50 %** de la casa. Los tests, en cambio, están
**por encima** del piso que el SDD exigía: ratio test-código : producción-código = **4,7:1** contra
un piso declarado de 4:1, con **33 `it` nuevos**, **39 renglones que nombran un mutante** y **6
verificados corriendo**.

🔴 **Y los tres bloqueantes del CR vivían justamente ahí: más prosa es más superficie de afirmación
sin testigo.** Los tres son frases o citas de producción que no reproducían — una cita rota que el
guard no miraba, un «el candado es X» donde X no toca una de las dos puntas, y una receta de mutación
que no reproduce. **Ninguno es una línea de lógica.**

**A la pregunta que decide** (*¿qué parte de esto seguiría existiendo si lo escribiera alguien que ya
conoce este repo?*): los tests y el probe, sí — son la premisa falsable y los mutantes. Las **416
líneas de comentario sobre 261 de código** son la parte que un tercero no escribiría igual, y es la
que produjo los hallazgos. **No se recortó más porque, medido, no quedaba prosa borrable sin perder
un motivo medido** (`CR/MNR-7`), pero el desborde queda declarado como lo que es.

---

## 9 · El drift declarado — 38 archivos contra 23 de Scope IN

**+15 archivos**, y lo importante es qué son y dónde están.

- **14 de los 15 son 100 % comentario / cita / marcador de censo** — verificado por F4 con
  `git diff --word-diff=plain` y **re-verificado por mí** archivo por archivo: cero líneas
  ejecutables. Salen de `AR/BLQ-MED-1`: las 9 citas que las inserciones de W3 corrieron y que vivían
  en archivos vecinos.
- **El 15.º sí tiene líneas ejecutables**, y conviene decirlo con precisión:
  `src/composition/kyc-verification-id-guard.static.test.ts` (+14 / −5) cambió los literales de sus
  aserciones de `"...body"` a `"...alAgente"`. **Es el contra-candado del arreglo de seguridad**
  (§5), está fuera del Scope OUT, y F4 verificó que la aserción **sigue siendo de orden dentro del
  spread** y **no se aflojó**. ⚠️ Esto matiza el «los 15 son 100 % comentario» de
  `validation-w3.md` §6.1: **son 14**.

**🟡 El Story File se contradecía consigo mismo, y se eligió bien.** §3.2 declaraba
`solana-wallet.ts` como *"cero líneas, ni un comentario"*, y lo mismo para `deeplink/**`,
`preparacion-por-enlace.ts`, `confirm-and-send.ts` y `flow-vm.ts`; **pero `T-45` obligaba a
re-derivar TODAS las citas que la ola corriera**, y esas citas vivían justo ahí. **Las dos reglas
eran incompatibles.** Se cumplió `T-45`: una cita rota es un defecto real, un comentario tocado no lo
es. **Pero el Scope OUT quedó violado en 7 archivos y eso se registra**, no se justifica al pasar:

`src/infrastructure/solana-wallet.ts` · `src/infrastructure/solana/deeplink/conexion.ts` ·
`src/infrastructure/solana/deeplink/pop-por-enlace.ts` ·
`src/infrastructure/solana/preparacion-por-enlace.test.ts` ·
`src/application/use-cases/confirm-and-send.ts` · `src/presentation/flow-vm.ts` ·
`src/presentation/flow-vm.test.ts`.

**Lo que blinda que la violación fue inocua, medido:**

- `wc -l src/infrastructure/solana-wallet.ts` ⇒ **2498**, idéntico a `f295a6f`. Sus 9 marcadores de
  censo: **ninguno cambió**. Los que sí se movieron (`entrantes` 127→130, `destinos` 68→69) los movió
  **WKH-373** en `3178360`, verificado commit por commit por el AR y por F4.
- `wc -l src/presentation/flow.tsx` ⇒ **4453**. 🟢 **Δ0 ESTRICTO cumplido** (8 líneas cambiadas, 0
  netas).
- **Scope OUT duro respetado**: `public/**` ⇒ **CERO archivos**; `app/api/kyc/session/route.ts`,
  `app/api/kyc/decision/route.ts`, `rate-limit.ts`, `pop-challenge.ts`, `pop-proof-store.ts`,
  `http-pop-signer.ts`, `solana-escrow-rent.ts`, `bienvenida.tsx` y `src/infrastructure/a2a/**`
  **fuera del diff, cero líneas**. **Cero líneas en `wasiai-a2a/src/`.**
- **Orden de olas correcto**: el receptor mergeó **antes** que el cliente, sin saltos.

---

## 10 · Hallazgos finales

### 10.1 · BLOQUEANTEs — **todos resueltos, cada uno con testigo corriendo**

| Hallazgo | Qué era | Cómo se cerró |
|---|---|---|
| `AR/BLQ-MED-1` | **9 citas que la ola corrió y no re-derivó**, en 5 archivos de la ruta del dinero. El gate estaba verde porque las citas **no ancladas** son justo las que `citas-ancladas.test.ts` **no mira por diseño**. Más una cita nueva **que nació falsa**: el Dev leyó el número **antes** de su propia edición | Re-derivadas **y ancladas al símbolo** para que el guard las cubra. F4 re-derivó **21/21 a mano** con `sed -n 'Np'` |
| `AR/BLQ-BAJO-2` | **Las tres credenciales de identidad viajaban al agente externo** (§5) | Sacadas del `forwardBody`. `T-372-W3-21` + candado estático re-apuntado ⇒ **dos** tests rojos si se revierte |
| `AR/BLQ-BAJO-1` | *"Si cambiás uno, el candado se pone rojo"* — **falso**: cambiar `30 * 60` → `60 * 60` sólo en el servidor dejaba **153 tests verdes**. El candado ata la **desigualdad**, no los valores | Frase corregida a lo que el candado sí garantiza |
| `CR/BLQ-BAJO-1` | 🔴 **La cita que el fix-pack escribió para cerrar `BLQ-MED-1` estaba ROTA, y el guard no la miraba**: el ancla quedó **partida por un salto de línea con `//` en el medio** y el regex exige whitespace. Reincidencia exacta **dentro del fix que la cerraba** | Re-derivada, **en una sola línea física**, y verificado **poniéndola en rojo a propósito** y leyendo que el mensaje la nombre |
| `CR/BLQ-BAJO-2` | *"El candado que ata las dos puntas es `T-372-W3-17`"* — **medido falso**: renombrar las 12 emisiones del enum en la route deja a `T-372-W3-17` **verde**. Decisión correcta, motivo falso | Nombrados los testigos reales (`T-372-W3-2/4/5`) y dicho qué punta cubre cada uno |
| `CR/BLQ-BAJO-3` | 🔴 **La receta de mutación publicada NO reproducía**: la condición estaba escrita dos veces y una estaba **lógicamente implicada** por la otra ⇒ **dos conjuntos muertos en la ruta del dinero**, a 40 líneas de una frase del propio commit que dice *"un control que no puede fallar es indistinguible de uno que funciona"* | Borrados los dos conjuntos muertos, Δ0 en el archivo, y **la otra receta del mismo `if` re-escrita** porque el borrado la invalidó |

### 10.2 · MENORes

- **`AR/MNR-1`** (el repliegue reintenta ante **cualquier** 403, gastando un POST, un token de
  rate-limit y —en un caso— **cupo del proveedor de KYC**), **`AR/MNR-2`** (`.env.example` publicaba
  un exploit que hoy no reproduce), **`AR/MNR-3`** (el guard de reloj ilegible cubre la **lectura** y
  no la **escritura**): **los tres cerrados en `726b9c4`**, con mutante verificado.
- **`CR/MNR-3`** (nota Δ0 protegiendo un número que ya no cita nadie), **`CR/MNR-4`** (cita cross-repo
  corrida 3 líneas), **`CR/MNR-6`** (`.env.example` no decía **de quién es** el secreto, y esa lectura
  equivocada **ya ocurrió** con el founder): **cerrados en `32195ed`**.
- **`CR/MNR-5`** — **`CD-W3-10` no se cumplió en el fix-pack 1**: la escala no se re-contrastó. Es el
  modo de falla que `auto-blindaje.md:639-641` ya tenía escrito de W1. **Cerrado en `32195ed`
  re-derivando la escala con el método escrito** para que se pueda repetir.
- **`CR/MNR-1`, `CR/MNR-2`** — **aceptados como deuda, con su medición**: `pop-proof-store.ts` está
  fuera del diff de W3 (§11, deuda 2).
- **`CR/MNR-7`** — simplificación disponible; **no hay prosa borrable sin costo**.
- **`QA/MENOR-1`** — la contradicción interna del Story File (§9). **Registrado, no arreglado**: los
  artefactos previos son inmutables.

---

## 11 · 🔴 Deudas abiertas — la lista para el founder

| # | Deuda | Dónde | Prioridad |
|---|---|---|---|
| **1** | 🔴 **El `2` del camino por enlace en Chrome está SIN MEDIR de punta a punta.** No hay ningún test que corra ese recorrido contando firmas; el número se deriva de dos eslabones ejecutados y una premisa heredada | §3.2 · `validation-w3.md` §1.2 | **Alta** — es el número que va al founder |
| **2** | **`pop-proof-store.ts` tiene el MISMO modo de falla del reloj y la MISMA frase falsa.** `InMemorySesionStore` es su calco, el arreglo se hizo **en la copia** y el original sigue abierto: probe corrido ⇒ `peek tras 100 anios` **devuelve la prueba**. Y la frase que `AR/BLQ-BAJO-1` derribó **sigue viva, textual**, en `:36-37` — que es **el archivo al que el módulo nuevo manda a leer como exemplar** | `src/infrastructure/auth/pop-proof-store.ts` · `CR/MNR-1`, `CR/MNR-2` | **Media** — no alcanzable con el `Clock` real; falla hacia un POST desperdiciado |
| **3** | ⛔ **La otra mitad de `R-3`: nadie quema el nonce.** Un par `(challenge, firma)` capturado **en la red** se puede reenviar dentro del TTL. Restituir el single-use es una HU aparte | `app/api/payout/prepare/route.ts:209-212` | **Media-Alta** — money-path |
| **4** | **`AC-3-4` DEFERIDO** (SIWS: fundir `connect` + firma en un permiso). Sin instrumento, por decisión del orquestador. ***"No se pudo preguntar" NO es "no".*** El protocolo de medición está escrito y necesita el teléfono del founder con **Testnet Mode** | `story-W3.md` §2.2 | **Alta** — necesita al founder |
| **5** | **El gate del repo NO cubre los `.mjs` de `scripts/`.** Medido: `biome lint scripts/probe-sesion-de-posesion.mjs` ⇒ *"These paths were provided but ignored"*; `biome.jsonc` enumera sólo `**/*.ts(x)` y `tsconfig.scripts.json` sólo `scripts/**/*.ts`. **Preexistente** (le pasa igual a `scripts/probe-vuelta-por-enlace.mjs`), **medido por el propio Dev**, que corrigió al Story File §0.3 —que afirmaba lo contrario— y dejó `node --check` + un camino de `exit 30` como controles | `chaski-v3/biome.jsonc`, `tsconfig.scripts.json` | **Media** — candidato a HU propia |
| **6** | **47 ocurrencias preexistentes del patrón «ancla partida»** en el árbol de `chaski-v3`. Cada una es una cita que el candado **no mira**. Esta ola introdujo una (ya cerrada) y **no tocó las otras 46** | `chaski-v3` (barrido del CR) | Media |
| **7** | **Sin medir**: si Phantom soporta **SIWS por enlace profundo**, y **si los 30 minutos de TTL alcanzan** para un recorrido real | `validation-w3.md` §8 | Media |
| **8** | 🔴 **W3 NO CIERRA LA HU 233.** Quedan la **`071` de `chaski-v3`** (el SOL que sigue haciendo falta: 8.874.560 lamports) y **W4** (la decisión de riesgo de la firma de patrocinio, que **no es un bloqueo técnico** y necesita **un dueño**: `MI-9`, abierto) | `work-item.md` §0 | **Alta** |
| **9** | Heredadas de W1 y **todavía abiertas**: **nadie corrió nada en un teléfono**; **no hay guard de citas cross-repo** (`citas-ancladas.test.ts` sólo mira dentro de `chaski-v3` y los documentos viven en `wasiai-a2a`); `TD-372-ATA-DEL-SENDER` | `report.md` §11 | Ver W1 |

**Orden consolidado de lo que sigue** (`work-item.md` §0): W1 ✅ → la HU **`071` de `chaski-v3`**
(tres repos + upgrade del programa) → **W3 ✅** → **W4** (necesita dueño).

---

## 12 · Auto-Blindaje consolidado — las lecciones transferibles

Las **20 entradas** de W3 (F3 + el fix-pack del CR) quedan **íntegras** en `auto-blindaje.md`, con su
crónica, su medición y su commit — igual que las 27 de W1 y su consolidación. Acá van ordenadas **por
lección transferible a otros proyectos**, no por cronología.

⚠️ **Observación de proceso, medida**: **el fix-pack del AR (`726b9c4`) no dejó ninguna entrada en el
Auto-Blindaje** — las entradas saltan de `W3.4` (13:05) al fix-pack del CR (15:10). Sus seis
hallazgos están documentados en `adversarial-review-w3.md` y verificados ejecutando en
`code-review-w3.md` §A, pero **la lección de cada uno no se escribió donde vive el resto**. Es
`CD-W3-10` en su versión de auto-blindaje: **un fix-pack también deja entradas.**

### N · 🔴 Un ancla de cita partida por un salto de línea **sale del conjunto que el guard mira**
El regex `ANCLADA` de `citas-ancladas.test.ts:74` exige **whitespace** entre las dos mitades, y
**`//` no es whitespace**. Una cita anclada partida entre dos líneas físicas —que es lo que el
formateador hace solo— **nunca entra al conjunto del candado**: queda rota **y verde**, por AUSENCIA
y no por corrección. Pasó **dentro del fix-pack que cerraba las citas rotas**, en el renglón que
nombra el único candado de que las credenciales no viajen al agente. **Contexto medido: 47
ocurrencias preexistentes del mismo patrón en el árbol.**
⇒ **Una cita anclada se escribe SIEMPRE en una sola línea física.** Y el control de que una cita está
*cubierta* **no es que el gate esté verde**: es **ponerla en rojo a propósito** y leer que el mensaje
la nombre.

### O · 🔴 Una condición escrita dos veces, con una implicada por la otra, es un **conjunto muerto**
`enumDelRechazo` era `undefined` salvo que ya fuera `!res.ok && status === 403`, así que los
conjuntos `!res.ok &&` y `res.status === 403 &&` del `if` de abajo **no podían cambiar su
resultado**. Consecuencia práctica: **la receta de mutación publicada da verde en su lectura literal
y nadie puede distinguirlo** de un control que funciona. Estaba a cuarenta líneas de una frase del
propio commit que dice *"un control que no puede fallar es indistinguible de uno que funciona"*.
⇒ **Una receta de mutación se corre en su lectura literal ANTES de publicarla.** Si el mutante
sobrevive, o la receta está mal o hay código muerto: **las dos veces el hallazgo es real.**

### P · 🔴 Arreglar un hallazgo puede **invalidar la receta de mutación de otro**
Al borrar el conjunto redundante, la condición de status pasó a llegar al `if` **a través de**
`enumDelRechazo`, y la receta (ii) —que antes aislaba una condición— pasó a arrastrar dos: borrar el
conjunto entero mataba en la rama equivocada, **un falso KILLED de manual**. Se re-escribió para
**aflojar y no borrar**, y así muere por su motivo. **Lo detectó re-corriendo, no razonando.**
⇒ Al tocar un `if`, **re-correr las OTRAS recetas del mismo `if`**.

### Q · 🔴 El desborde de escala estaba **en la prosa de producción, no en los tests** — y ahí vivían los tres bloqueantes
261 líneas de código de producción contra **416 de comentario** (61 % de prosa contra el ~50 % de la
casa), mientras los tests quedaban **por encima** del piso declarado (4,7:1 contra 4:1). Los tres
bloqueantes del CR son **frases y citas de producción que no reproducen**; ninguno es lógica.
⇒ **Más prosa es más superficie de afirmación sin testigo.** Cuando el check 7 dé exceso, separar
**tests / código de producción / prosa de producción** antes de justificarlo: los tres se defienden
distinto, y sólo uno de los tres predice dónde van a estar los hallazgos.

### R · 🔴 Cerrar el modo de falla **en la copia** y dejarlo abierto **en el original**
`InMemorySesionStore` se escribió como calco de `InMemoryPopProofStore`. El guard del reloj ilegible
se arregló en la copia; el original sigue abierto (`peek tras 100 anios` **devuelve la prueba**), y
la frase falsa sigue viva textual en él — **que es el archivo al que el módulo nuevo manda a leer
como exemplar**.
⇒ Cuando un módulo nuevo es **calco** de otro, un arreglo en la copia **deja al original peor que
antes**: ahora hay dos versiones y la vieja es la que el docblock manda a leer. **El arreglo va a los
dos, o la deuda se declara con su medición.** Acá se declaró (§11, deuda 2).

### S · Un número publicado **se re-mide contra el árbol**, y cuando el rango contiene el merge de otra HU, el diff de dos puntos miente por exceso
El rango `f295a6f..a392f6b` **contiene el merge de WKH-373** y da `3908 / 58`, que no es la escala de
esta ola. La cuenta correcta es **la unión de los segmentos propios**, agregando por archivo, y
diciendo cuáles son. ⚠️ **Y el corolario que este cierre volvió a medir**: sumarle el delta de un
fix-pack a un total anterior **cuenta dos veces las líneas reescritas** (2.857 publicado contra 2.834
re-derivado, §8). **La lección G de W1 no se aplica sola a la línea de abajo.**

### T · *"Tiene que fallar con el código de hoy"* se mide contra **`main`**, no contra un mutante
Un mutante mide el test contra una variante que escribe el propio Dev; el criterio pide medirlo
contra el árbol. Los dos rojos se parecen (los dos dan `expected 2 to be 1`) y son indistinguibles en
el reporte si no se dice cuál se corrió. Se usó `git stash` para dejar los tres archivos de
producción **byte-idénticos a `main`** y se citó el rojo textual.

### U · Un mutante puede morir **por la aserción del instrumento** y no por la de la pantalla
Sacar la 4ª frase mataba en la aserción de **calibración** (`expected 3 to be 4`) **sin llegar a
mirar la pantalla**; gatear el render mataba en la de pantalla, que es la razón correcta. **El Dev lo
reportó como falso KILLED en vez de disfrazarlo**, y también declaró un mutante que **SOBREVIVE**
(guard inalcanzable, con su comentario diciéndolo).
⇒ Cuando un mutante muere, **mirar cuál aserción produjo el rojo**.

### V · Un número de línea **sale de un `grep -n` del símbolo**, nunca del rango con el que leíste el archivo
Cuatro citas nacieron mal por derivarse de los **offsets del `sed -n 'Np'`** con el que se leyó el
molde. Y una nació falsa por leer el número **antes de la propia edición**. El guard de citas
ancladas cazó 3 de 4 — **no las caza todas**, porque una cayó dentro del docblock correcto.

### W · El orden de despliegue se verifica **por consecuencia observable**, no por confianza
El probe contra el servicio vivo dio `exit 0` y eso probó **cuatro** cosas: receptor desplegado,
cliente **no** desplegado, **la env secreta puesta en producción** (sin ella la afirmación (b) da
`exit 30`) y **que el instrumento sabe fallar** (sin URL ⇒ `exit 30`, así que el `0` no es un exit
code tapado). ⇒ Un `exit 0` sin control positivo del instrumento no dice nada.

### X · Un Story File puede **contradecirse consigo mismo**, y la contradicción se resuelve por escrito
§3.2 prohibía tocar 7 archivos; `T-45` obligaba a re-derivar las citas que la ola moviera, y esas
citas vivían justo ahí. **Se eligió `T-45`** —una cita rota es un defecto real, un comentario tocado
no lo es— **y la violación del Scope OUT se registró** en vez de justificarse al pasar.

*Las lecciones **A–M** de W1 siguen vigentes y no se repiten acá; viven en `report.md` §10 y en la
consolidación de `auto-blindaje.md:704-733`. Las que W3 volvió a activar son la **C** (toda
afirmación escrita es falsable), la **F** (una cita a un test se escribe por el nombre del `it`), la
**G** (un número publicado se re-mide contra el árbol) y la **K** (correr las partes de un gate no es
correr el gate).*

---

## 13 · Archivos modificados

**38 archivos · 2.834 añadidas / 150 borradas** (re-derivado por mí: unión de
`f295a6f..8ffdd78` + `3178360..c1bd8d3`, agregando por archivo; excluye el merge de WKH-373).

### Producción — la sesión (nuevo)

| Archivo | +/− | Qué es |
|---|---:|---|
| `src/infrastructure/auth/sesion-de-posesion.ts` | **+154 / −0** | **Nuevo.** El token firmado: HMAC con `node:crypto`, `timingSafeEqual` con chequeo de largo previo, `exp` **dentro** del payload firmado, TTL 30 min, secreto propio (`PAYOUT_SESSION_SECRET`) |
| `src/infrastructure/auth/sesion-store.ts` | **+135 / −0** | **Nuevo.** El almacén del cliente, **browser-safe y en memoria a propósito**: un `Map` de instancia. TTL cliente **28 min**, estrictamente menor que el del servidor |

### Producción — los que la usan

| Archivo | +/− | Qué es |
|---|---:|---|
| `app/api/payout/prepare/route.ts` | **+166 / −63** | La rama `S1..S5` dentro de `PR5'`: sesión **o** PoP, cinco fallos colapsados en un **403 byte-idéntico**, **debajo** del rate-limit, `Cache-Control: no-store`, cero logs del token. Y el `alAgente` que saca las tres credenciales del forward |
| `src/infrastructure/settlement/http-solana-prepare-gateway.ts` | **+136 / −11** | El cliente elige: `peek()` ⇒ `sessionToken`, o `prove()`. Más el reintento único ante el 403 que la sesión arregla |
| `app/api/kyc/verdict/route.ts` | **+27 / −8** | Acuña la sesión y la agrega a los 5 `200` |
| `src/infrastructure/kyc/http-kyc-verdict-gateway.ts` | **+37 / −2** | Lee `sesion` del 200 y la registra |
| `src/composition/container.ts` | **+4 / −4** | El cableado, **Δ0**, en `:106`, `:161` y `:185` |
| `src/application/ports.ts` | **+22 / −1** | `SesionReader` / `SesionRecorder`: **la separación por tipo que `tsc` impone** (un lector no puede escribir) |
| `src/presentation/flow.tsx` | **+8 / −8** | Las 4 frases del copy. 🟢 **Δ0 ESTRICTO** (`wc -l` = **4453**, sin cambio) |

### Tests

| Archivo | +/− |
|---|---:|
| `src/presentation/sesion-borra-la-segunda-firma.test.tsx` | **+663 / −11** (nuevo; la premisa de W3.0, corrida **antes** de una línea de producción) |
| `src/infrastructure/settlement/http-solana-prepare-gateway.test.ts` | **+261 / −1** |
| `app/api/payout/prepare/route.test.ts` | **+227 / −2** |
| `src/infrastructure/auth/sesion-de-posesion.test.ts` | **+178 / −0** (nuevo) |
| `src/infrastructure/auth/sesion-store.test.ts` | **+161 / −0** (nuevo) |
| `app/api/kyc/verdict/route.test.ts` | **+143 / −0** |
| `src/composition/container.test.ts` | **+84 / −3** |
| `src/infrastructure/kyc/http-kyc-verdict-gateway.test.ts` | **+79 / −0** |
| `src/presentation/wallet-availability.test.tsx` | **+75 / −0** |
| `src/test-support/fakes.ts` | **+29 / −0** |
| `src/composition/kyc-verification-id-guard.static.test.ts` | **+14 / −5** (el contra-candado del arreglo de seguridad, re-apuntado al símbolo nuevo) |
| `src/infrastructure/payout/authority.test.ts` | **+4 / −2** |

### Soporte y documentación

| Archivo | +/− | Qué es |
|---|---:|---|
| `scripts/probe-sesion-de-posesion.mjs` | **+169 / −0** | **Nuevo.** El instrumento del gate de despliegue. ⚠️ **Ninguna herramienta del gate lo mira** (§11, deuda 5) |
| `.env.example` | **+27 / −3** | `PAYOUT_SESSION_SECRET`, con su palanca de rollback |
| `README.md` · `README.es.md` | **+1 / −1** cada uno | El conteo 167 → **172** archivos de test, con testigo |

### Los 15 fuera del Scope IN — todos por `AR/BLQ-MED-1` (§9)

`app/page.tsx` · `scripts/smoke-helpers.ts` · `src/application/agent-rejections.ts` ·
`src/application/use-cases/confirm-and-send.ts` ⛔ · `src/infrastructure/payout/authority.ts` ·
`src/infrastructure/payout/authority.test.ts` ·
`src/infrastructure/persistence/supabase-kyc-verdicts.ts` · `src/infrastructure/solana-wallet.ts` ⛔ ·
`src/infrastructure/solana/deeplink/conexion.ts` ⛔ ·
`src/infrastructure/solana/deeplink/pop-por-enlace.ts` ⛔ ·
`src/infrastructure/solana/preparacion-por-enlace.test.ts` ⛔ ·
`src/presentation/diagnostico-de-vuelta.tsx` · `src/presentation/flow-vm.ts` ⛔ ·
`src/presentation/flow-vm.test.ts` ⛔ · `src/composition/kyc-verification-id-guard.static.test.ts`
*(el único con líneas ejecutables)*. **⛔ = Scope OUT duro (7).**

### Commits — `main` local en `c1bd8d3`, **sin pushear**

```
064870d test(W3.0)  la premisa de la ola, medida sobre el arbol de hoy
1422280 feat(W3.1)  el modulo de la sesion de posesion, server-only
0b30082 feat(W3.2)  el RECEPTOR primero - prepare acepta sesion O PoP, el cliente intacto
aeb0163 feat(W3.3)  el probe contra el servicio VIVO - el gate de despliegue
8ffdd78 merge       W3.0-W3.3, mitad RECEPTOR            -> desplegado, sonda exit 0
1efc8b0 feat(W3.4)  el cliente usa la sesion
7609533 feat(W3.5)  las cuatro frases de la firma de identidad, con delta 0 en flow.tsx
a853d36 docs(W3.6)  el conteo de los dos README, derivado corriendo el candado
6bd089f merge       W3.4-W3.6, el cliente
781aafd fix(W3.5)   la frase prohibida vivia en el diff, aunque fuera para prohibirla
726b9c4 fix         fix-pack 1 (AR) -> merge a392f6b
32195ed fix         fix-pack 2 (CR) -> merge c1bd8d3
```

⚠️ `3178360` (merge de **WKH-373**) está **en el medio** del rango y **no es de esta HU**.
Ramas usadas: `feat/wkh-372-w3-sesion-del-servidor`, `feat/wkh-372-w3-cliente-y-copy`,
`fix/wkh-372-w3-frase-prohibida-en-comentario`, `fix/wkh-372-w3-arfix`, `wkh-372-w3-fixpack-cr`.

---

## 14 · Decisiones diferidas a backlog

- **`AC-3-4` (SIWS) DEFERIDO por decisión del orquestador, sin construir instrumento.** `public/**`
  quedó en **cero archivos**, que es exactamente lo que la enmienda pedía. La medición necesita el
  teléfono del founder con **Testnet Mode**, y el protocolo está escrito con un **paso de control**
  cuyo fallo obliga a detenerse.
- **La 4ª frase del copy, reformulada por enmienda del orquestador** en el gate: de una promesa
  condicionada al camino a *"Si te la volvemos a pedir, es por lo mismo: confirmar que es tuya"*,
  **verdadera en los dos caminos y sin gate de pantalla**. La razón está medida.
- **`pop-proof-store.ts` NO se tocó**, por Scope OUT (*"se imitan, no se amplían"*). La deuda quedó
  declarada **con su medición** en el Auto-Blindaje y en §11.
- **La otra mitad de `R-3` (quemar el nonce) es una HU aparte**, declarada como tal en el código.
- **Sin tickets nuevos de backlog creados en esta ola.** Los candidatos más claros son: el guard de
  citas cross-repo (heredado de W1), el gate que no cubre los `.mjs`, y las 46 anclas partidas
  restantes.

---

## 15 · Lecciones para próximas HUs

1. **Poner la premisa falsable primero, con cero líneas de producción, otra vez pagó.** `W3.0` midió
   **sobre el árbol de hoy** que hoy son 2 firmas y que el recorrido cierra, y por eso el `2 → 1` es
   un número y no una impresión. **Y el rojo de cierre se produce contra `main` con `git stash`**, no
   con un mutante propio.
2. **Cuando un gate de despliegue parte la ola en dos, el orden es el control.** Receptor primero,
   **sonda contra el servicio vivo**, cliente después. Y la sonda se lee por lo que prueba **por
   consecuencia observable** —la env secreta, que no se puede leer de otra forma— con control
   positivo de que sabe fallar.
3. **El exceso de escala se separa en tres clases antes de justificarlo.** Tests, código de
   producción y **prosa de producción**. Acá los tests estaban por encima del piso exigido y el
   desborde era prosa: **la clase que predijo dónde iban a estar los tres bloqueantes.**
4. **Un guard verde no dice que tu cita esté cubierta.** El control es **ponerla en rojo a propósito**
   y leer que el mensaje la nombre. Un ancla partida por un salto de línea sale del conjunto sin que
   nada avise, y hay 47 casos de eso en el árbol.
5. **Una receta de mutación se corre en su lectura literal antes de publicarla**, y al tocar un `if`
   se re-corren **las otras recetas del mismo `if`**: arreglar un hallazgo puede invalidar la receta
   de otro, y eso se detecta corriendo, no razonando.
6. **Un fix-pack también deja entradas en el Auto-Blindaje.** El del AR no dejó ninguna, y sus seis
   lecciones sobrevivieron sólo porque el CR las verificó ejecutando.

---

*Docs · NexusAgil · WKH-372 ola W3 · 2026-09-01 · `chaski-v3@c1bd8d3` (sin pushear; `origin/main` en
`3178360`, que ya tiene el receptor) · compilado leyendo `work-item.md`, `sdd-w3.md`, `story-W3.md`,
`adversarial-review-w3.md`, `code-review-w3.md`, `validation-w3.md` y `auto-blindaje.md`. Ningún
resultado se inventó; los números que re-derivé están marcados como propios y dicen con qué método.*
