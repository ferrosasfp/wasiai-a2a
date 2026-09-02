# SDD · [WKH-374] · **OLA W0** — La puerta de la HU: seis mediciones, cero líneas de producción
### + las tres decisiones de arquitectura: `DT-1`, `DT-4` y `DT-5`

> **Repo ancla del artefacto**: `wasiai-a2a` (`doc/sdd/234-recorrido-de-la-dapp-de-cero/`).
> **Repo del trabajo**: `chaski-v3` — **todo**. En `wasiai-a2a/src/` esta ola escribe **cero líneas** (CD-3, AC-15).
> **Árbol de referencia**: `chaski-v3` `main` = `origin/main` = **`c1bd8d3c5b490205f8aae1f8e999a9871d0fc762`**, árbol limpio.
> **Modo**: QUALITY. Alcance de este SDD: **W0 y las tres decisiones**. ⛔ Las olas W1, W2 y W3 tienen su propio SDD (DT-8).

---

## §0 · CÓMO SE LEEN LAS CITAS DE ESTE DOCUMENTO

Este F2 corrió **con shell**. Todo lo que sigue se midió en esta sesión sobre `c1bd8d3`.

| Etiqueta | Qué significa |
|---|---|
| `[MEDIDO]` | Lo corrí o lo leí en el árbol de hoy. La cita apunta a lo que dice. |
| `[HEREDADO]` | Lo afirma otro documento. **No lo verifiqué**, y digo de dónde sale. |
| `[NO MEDIDO]` | Nadie lo midió. Es una incógnita declarada. |

🔴 **Tres reglas de cita que este documento se aplica a sí mismo**, y salen medidas del auto-blindaje de la HU anterior:

1. **Las citas cruzadas entre repos no las vigila NADA.** `citas-ancladas.test.ts` sólo mira dentro de
   `chaski-v3`; este documento vive en `wasiai-a2a`. **7 citas se rompieron por esta causa en WKH-372**
   (`auto-blindaje.md` de la carpeta 233, lección **E**) `[MEDIDO]`. ⇒ toda cita de acá lleva el commit
   (`@c1bd8d3`) y, cuando es a un test, **el nombre del `it` además del número** (lección **F**).
2. ⛔ **Ninguna cita de este documento está en formato ANCLADO.** Una cita anclada es **una escritura
   sobre el archivo destino**: correría los marcadores `[[CENSO …]]`. Está medido más abajo (§3.2) y ya
   costó un rojo en WKH-372 (`auto-blindaje.md` 233, entrada del 14:07) `[MEDIDO]`.
3. **Un número de línea sale de un `grep -n` del símbolo**, nunca del rango con el que leí el archivo
   (lección **V**). Todos los de acá salieron de `/usr/bin/grep -n`, `sed -n 'Np'` o `wc -l`.

---

## §1 · Resumen — qué resuelve este SDD, y qué deja explícitamente afuera

**Resuelve tres decisiones y diseña una puerta.**

| | Qué | Veredicto |
|---|---|---|
| **`DT-1`** | Dónde vive el recorrido nuevo | 🟢 **Opción B — árbol propio detrás de bandera**, con **condición de retiro escrita y con candado** (§3) |
| **`DT-5`** | ¿Puede una credencial al portador tocar disco? | 🟢 **Disco del SERVIDOR sí, con tres condiciones. Disco del NAVEGADOR nunca.** Y la sesión de posesión **no se persiste**: no hace falta (§4) |
| **`DT-4`** | La circularidad (leer el borrador exige autenticar la dirección; esa credencial no sobrevive al salto) | 🟢 **Desatada por `DT-3`: el vale no autentica, transporta.** Lo que autentica sigue siendo la firma (§5) |
| **`DT-6`** | Qué infraestructura guarda el estado | 🟢 **Los DOS proveedores ya presentes, uno por problema**: Upstash para el vale (un solo uso), Supabase para el borrador (durable + dueño) (§6) |
| **W0** | La puerta de la HU | 🟢 Diseñada al detalle: **3 archivos, 6 `it`, 0 líneas de producción** (§7) |

**Deja afuera, a propósito**: el plegado 8→5 pantallas (`DT-7`, va en el SDD de W1), la forma exacta
de la tabla del borrador (`DT-6` DDL, va en el SDD de W2), el encendido y la medición en teléfono (W3).

---

## §2 · Context Map (Codebase Grounding)

Archivos leídos en esta sesión, con lo que extraje de cada uno. **Todo `@c1bd8d3`.**

| # | Archivo | Por qué lo leí | Qué extraje |
|---|---|---|---|
| C-1 | `chaski-v3/src/presentation/flow.tsx` | El sujeto de `DT-1` | **4453 líneas** (`wc -l`); `Step` en `:88`; `STEP_LABELS` en `:89`; `STEP_INDEX` en `:90-99` con **8 pasos del envío + 3 destinos**; los marcadores de censo en `:44` |
| C-2 | `chaski-v3/src/composition/citas-ancladas.test.ts` | El candado que hace real el Δ0 | El regex `ANCLADA` en `:74`; el regex `CENSO` en `:331`; `SCAN_DIRS = ["src","app","scripts","contracts"]` en `:51`; el patrón `SELF` (exclusión por ruta EXACTA) en `:56`; **los 4 agujeros declarados** en `:26-45` |
| C-3 | `chaski-v3/src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | **El instrumento de la métrica** (DT-9) | `inyectarWallet` `:115`; `entrarAlNavegadorDeLaBilletera` `:149`; `espiarNavegacion` `:175`; `viajesALaBilletera` `:208`; `sembrarElCaminoPorEnlace` `:226`; `HOST_DE_LA_BILLETERA` derivado de `phantomBrowseUrl` en `:169`; la definición de travesía en `:680-684` |
| C-4 | `chaski-v3/src/infrastructure/auth/sesion-store.ts` | El corazón de `DT-5` | Las **tres razones** del memory-only en `:16-25`; `SESION_STORE_TTL_MS = 28 min` en `:73`; `InMemorySesionStore` en `:80`; el `peek` en `:121` |
| C-5 | `chaski-v3/src/infrastructure/auth/sesion-de-posesion.ts` | Confirmar que el token es apátrida | HMAC `payloadB64.firma`, TTL 30 min. **154 líneas.** Confirma la corrección de vocabulario de `DT-5` |
| C-6 | `chaski-v3/src/composition/container.ts` | **La premisa `L-5`, medida** | `createContainer()` en `:96`; `new InMemorySesionStore(clock)` en `:106`; **`let singleton` en `:263`** y `getContainer()` en `:265` ⇒ el almacén es **por documento**, no por navegación |
| C-7 | `chaski-v3/app/page.tsx` | El punto de montaje donde vive la bandera de `DT-1` | Monta `<Splash/>`, `<DiagnosticoDeVuelta/>`, `<RemittanceFlow/>`. Lleva 2 marcadores de censo de `flow.tsx` (`:23`, `:24`) |
| C-8 | `chaski-v3/src/presentation/wallet-availability.ts` | El patrón de bandera (`DT-2`) y el host de la billetera | `phantomBrowseUrl` en `:26`; `mwaEnabled` en `:98`; `deeplinkEnabled` en `:156`; el gotcha `NEXT_PUBLIC_` del build en `:95-96` y `:152-154` |
| C-9 | `chaski-v3/src/presentation/wallet-availability.test.tsx` | El exemplar de byte-identidad (W0-5) y de lectura del árbol | `it("T-CABLE-1: …")` `:128`; `it("T-CABLE-2: …")` `:146`; `it("T-UI-3: …")` `:218`; `it("T-065-20: …")` `:1021`; `it("T-065-21: …")` `:1037`; `it("T-065-21b: …")` `:1076` |
| C-10 | `chaski-v3/src/presentation/sesion-borra-la-segunda-firma.test.tsx` | Lo que hoy vigila `DT-5` — y hasta dónde (§4.6) | `it("T-372-W3-8: …")` `:539`, con las **4 aserciones de disco** (`localStorage`, `sessionStorage`, `document.cookie`, `window.location.href`) en `:556-565` |
| C-11 | `chaski-v3/src/infrastructure/solana/deeplink/protocol.ts` | El host real del enlace profundo | `BASE` en `:54-57`: `phantom.app` / `solflare.com`; `urlConectar` **exportada** en `:149` |
| C-12 | `chaski-v3/src/infrastructure/webhooks/webhook-event-store.ts` | 🎯 **El exemplar del VALE** | `claimWebhookEventOnce` en `:43`: `SET NX EX`, un solo uso, TTL, fail-**closed**, y **tres valores** (`ok` / `alreadyUsed` / `unavailable`) — no un booleano |
| C-13 | `chaski-v3/supabase/migrations/20260819T000000_add_kyc_session_tokens.sql` | 🎯 **El exemplar del BORRADOR y de `DT-5`** | Una **credencial al portador at-rest en el servidor**, con sus razones escritas; `owner_address` **nullable a propósito** (`:114-125`), base58 case-sensitive, ⛔ no lowercasear; RLS deny-all + filtro app-layer |
| C-14 | `chaski-v3/src/infrastructure/persistence/supabase-server.ts` | El cliente server-only | `getSupabaseServerClient()` en `:17`, memoizado, envs en runtime, `null` si faltan ⇒ apagado con gracia |
| C-15 | `chaski-v3/src/presentation/splash-puerta.ts` | La puerta del splash (falla cerrado) | `MotivoParaNoMostrar` en `:68-73` — **cinco** motivos; `motivoParaNoMostrar` en `:84` |
| C-16 | `chaski-v3/src/presentation/salida-al-navegador-de-la-billetera.ts` | El precedente de "archivo nuevo, 0 citas" | `:13-14`, textual: *«Un archivo nuevo, además, no corre ninguna cita anclada de ningún otro archivo»* |
| C-17 | `chaski-v3/src/presentation/bitacora-de-vuelta.ts` | El patrón de cita SIN ancla hacia `flow.tsx` | `:175-177`, con su motivo escrito. ⚠️ Y una cifra que envejeció: ver `OBS-1` |
| C-18 | `chaski-v3/src/presentation/vuelta-por-enlace-carrera.test.tsx` | El flake preexistente | 334 líneas; sus **tres límites declarados** en `:20-24`, incluido *«Corre en jsdom, no en un navegador»* |
| C-19 | `chaski-v3/package.json` | El gate | `:20` — `qa` = `npm run lint && npm run typecheck && npm run typecheck:scripts && npm run test`; `lint` (`:12`) = `biome lint src app scripts`; `test` (`:15`) = `vitest run` |
| C-20 | `wasiai-a2a/supabase/migrations/20260706000000_wkh137_agent_links.sql` | El exemplar cross-repo de `DT-3` | `claim_agent_link` en `:59`: `FOR UPDATE` + status-gate + máquina `open→redeeming→redeemed\|failed`. ⚠️ **Y su defecto para nuestro AC-12**: distingue `LINK_NOT_FOUND` de `LINK_ALREADY_USED` de `LINK_EXPIRED` (`:89`, `:94`, `:99`) |
| C-21 | `wasiai-a2a/doc/sdd/233-recorrido-movil-sin-saltos/auto-blindaje.md` | **Auto-Blindaje histórico, obligatorio** | 1148 líneas, 47 entradas, 2 consolidaciones. Las lecciones **A..Z** están heredadas a los CD de §9 |
| C-22 | `wasiai-a2a/doc/sdd/_INDEX.md` | La fila de la HU | La fila **234 ya existe**, en la línea `:226`. ⇒ `MI-7` resuelto (§12) |

---

## §3 · `DT-1` RESUELTO — **Opción B: árbol propio detrás de bandera**, con condición de retiro

### 3.1 · El veredicto

> **El recorrido nuevo vive en un árbol propio bajo `src/presentation/recorrido/`, montado desde
> `app/page.tsx` por una bandera opt-in estricto. `flow.tsx` NO se toca: queda en 4453 líneas y Δ0
> se preserva POR CONSTRUCCIÓN, no por disciplina.**

### 3.2 · La medición que decide, y que el work-item pedía verificar

El work-item pedía verificar el argumento mecánico del Analyst antes de apoyarse en él. **Lo verifiqué,
y es más fuerte de lo que decía.** Cuatro mediciones propias, todas `[MEDIDO]` sobre `c1bd8d3`:

**(a) El Δ0 no es una convención: es un candado con 21 dientes.**

| Marcador | Sitios | Archivos distintos |
|---|---|---|
| `[[CENSO src/presentation/flow.tsx lineas=4453]]` | **8** | **6** |
| `[[CENSO src/presentation/flow.tsx entrantes=165]]` | **12** | **6** |
| `[[CENSO src/presentation/flow.tsx destinos=96]]` | **1** | 1 |

Los 6 archivos, derivados con `/usr/bin/grep -rl`: `app/page.tsx`,
`src/application/use-cases/confirm-and-send.ts`, `src/presentation/diagnostico-de-vuelta.tsx`,
`src/presentation/flow-vm.test.ts`, `src/presentation/flow-vm.ts`, `src/presentation/flow.tsx`.
El candado que los verifica es `it("cada marcador `[[CENSO …]]` dice el número que el árbol tiene hoy")`,
en `chaski-v3/src/composition/citas-ancladas.test.ts:402` `@c1bd8d3`. **Lo corrí: `9 passed (9)`.**

⇒ **Agregar UNA línea a `flow.tsx` pone rojos 8 sitios en 6 archivos.**
⇒ **Agregar UNA cita ANCLADA hacia `flow.tsx` pone rojos 12 sitios en 6 archivos** — y 13 si cae en una
línea destino nueva. Esto no es teoría: pasó en WKH-372 y está escrito (`auto-blindaje.md` 233, entrada
del 14:07, *«Esa sola cita corrió cinco marcadores»*) `[MEDIDO]`.

**(b) El Δ0 ya deformó el archivo, y se puede medir con una regla.**

| Archivo | Líneas | Chars/línea (media) | Líneas > 300 chars | > 1000 chars | Máximo |
|---|---|---|---|---|---|
| `src/presentation/flow.tsx` | 4453 | **85,4** | **104** | **35** | **16.617** (línea `:757`) |
| `src/presentation/diagnostico-de-vuelta.tsx` | 593 | 66,2 | 5 | 0 | — |
| `src/presentation/bitacora-de-vuelta.ts` | 229 | 62,5 | 1 | 0 | — |
| `src/presentation/salida-al-navegador-de-la-billetera.ts` | 185 | 59,5 | 1 | 0 | — |
| `src/infrastructure/auth/sesion-store.ts` | 135 | 62,8 | **0** | 0 | — |

Los cuatro de abajo son **módulos nuevos escritos por el mismo equipo, en el mismo repo, con la misma
disciplina, en las últimas semanas**. Escriben ~60 chars por línea. Dentro de `flow.tsx`, los mismos
autores escriben 85,4 de media y una línea de 16.617. **La diferencia no es de estilo: es del Δ0**, que
obliga a encajar cada inserción en una línea existente junto con su justificación.

**(c) 🔴 Y acá está el argumento que el work-item no tenía: con la opción A, `CD-14` es INMEDIBLE.**

`CD-14` pone techo de **≤45 %** a la prosa **de producción**. Medido sobre `flow.tsx`:

- 1769 líneas de comentario puro, 2382 de código solo, **185 líneas MIXTAS** (código y prosa en el
  mismo renglón), 117 vacías.
- Ratio de prosa por líneas = 1769/4151 = **42,6 %** ⇒ *parece* cumplir `CD-14`.
- **Y es un artefacto de medición**: la prosa que vive dentro de las 185 líneas mixtas no la cuenta
  nadie, y **35 de esas líneas superan los 1000 caracteres**.

⇒ **Dentro de `flow.tsx` el ratio de prosa no es falsable.** Un `CD` que no se puede medir no es un
`CD`: es una intención. Los módulos nuevos, en cambio, tienen 0-2 líneas mixtas cada uno, así que ahí
el ratio **sí** significa lo que dice.

**(d) El costo de citas de la opción B es cero, y el motivo ya está escrito en el repo.**
`chaski-v3/src/presentation/salida-al-navegador-de-la-billetera.ts:13-14` `@c1bd8d3`, textual:
*«Un archivo nuevo, además, no corre ninguna cita anclada de ningún otro archivo»* `[MEDIDO]`.

**(e) Un beneficio colateral, medido**: la HU `071` de `chaski-v3` toca `solana-wallet.ts` y declara 76
citas ancladas por debajo de `:897` `[HEREDADO]` de §14 del work-item. Con la opción B esta HU **no
toca `solana-wallet.ts`** ⇒ el conflicto de merge desaparece.

### 3.3 · Lo que la opción B **no** es

⛔ **No es un repo nuevo, ni una DApp de cero en el sentido literal.** `src/domain/`,
`src/application/use-cases/`, `src/infrastructure/` (Solana, deeplink, persistencia, auth) y `app/api/`
**se reusan enteros**. Lo nuevo es **la capa de pantallas y el estado del recorrido**.

Verificado sobre el árbol: `flow.tsx` importa de `../application/use-cases/confirm-and-send`,
`../application/use-cases/recover-escrow-funds`, `../application/ports`,
`../application/solana-escrow-rent`, `../application/agent-rejections`, `../domain/remittance` y
`../composition/container` `[MEDIDO]`. **El camino del dinero vive en `src/application/`, no en
`flow.tsx`** — `flow.tsx` orquesta pantallas y delega.

### 3.4 · 🔴 `R-1` — el costo de B, y la condición de retiro que `DT-1` exige

El work-item declara el costo sin esconderlo: **dos caminos vivos a la vez**, y el precedente de que en
este repo un arreglo se hizo en la copia (`sesion-store.ts`) y el original quedó abierto
(`pop-proof-store.ts`) `[HEREDADO]` de `auto-blindaje.md` 233, lección **R**.

**`DT-1` viene con tres cosas, no sólo con la bandera:**

**`RET-1` · El candado de no-duplicación (activo desde W1, no desde el retiro).**
⛔ **PROHIBIDO que el árbol nuevo defina su propia lógica de dominio o de caso de uso.** Un candado
estático exige que el conjunto de módulos que el árbol nuevo importa de `../application/` y
`../domain/` esté **contenido en** el que importa `flow.tsx`, y que el árbol nuevo **no exporte** ninguna
función cuyo nombre coincida con un caso de uso.
⇒ Con esto, **el modo de falla de `R-1` no es alcanzable para el camino del dinero**: hay un solo
`ConfirmAndSend`, así que un arreglo de dinero **no se puede hacer en uno solo de los dos árboles**.
Lo que sí queda duplicado es **la capa de pantallas**, y una pantalla no mueve fondos.

**`RET-2` · La condición de retiro, falsable y con dueño.** El camino viejo (`flow.tsx` y su árbol) se
borra cuando se cumplan **las dos**:
1. La bandera estuvo **prendida en producción ≥ 14 días corridos** con **≥ 1 envío que cerró en cadena**
   con el árbol nuevo, verificable en `remittance_settlements` (la tabla existe:
   `chaski-v3/supabase/migrations/20260716T000000_create_remittance_settlements.sql` `[MEDIDO]`).
2. `RET-1` sigue verde, y el árbol nuevo cubre las 5 pantallas de AC-2.
**Dueño**: el founder decide el flip; el retiro es una **HU propia**, no una tarea al pie de W3.

**`RET-3` · La fecha de revisión.** Si al **2026-10-15** el retiro no ocurrió, `R-1` se re-evalúa por
escrito. ⛔ *"Todavía no"* no es una respuesta: o hay fecha nueva con motivo, o se retira.

### 3.5 · Dónde vive, exactamente

| Qué | Ruta (`chaski-v3`) | Ola |
|---|---|---|
| El árbol nuevo | `src/presentation/recorrido/**` (carpeta NUEVA, no existe hoy — verificado con `ls`) | W1 |
| El interruptor de montaje | `app/page.tsx` | W1 |
| La bandera | `NEXT_PUBLIC_CHASKI_RECORRIDO_V2` — opt-in estricto, sólo el literal `"true"` (`DT-2`) | W1 |
| El borrador durable + el vale | `app/api/recorrido/**` + `src/infrastructure/persistence/**` | W2 |
| `flow.tsx` | ⛔ **NO SE TOCA.** Δ0 = 0 líneas, 0 citas ancladas nuevas | — |

⚠️ **`app/page.tsx` lleva dos marcadores de censo de `flow.tsx` (`:23`, `:24`)**, pero son marcadores
*sobre* `flow.tsx`: agregarle líneas a `app/page.tsx` **no los mueve**. Lo que sí los movería es anclar
una cita nueva a `flow.tsx` desde ahí. ⛔ No se hace.

---

## §4 · `DT-5` RESUELTO — una credencial al portador puede tocar el disco **del servidor**, nunca el del navegador

### 4.1 · La corrección de vocabulario, confirmada

El encargo original decía *"la sesión del servidor vive en memoria"*. **Medido, es al revés**, y lo
confirmo en esta sesión:

- El token del servidor es **HMAC apátrida** (`payloadB64.firma`, atado a `address`+`networkId`+`exp`,
  TTL 30 min): `emitirSesionDePosesion`, `chaski-v3/src/infrastructure/auth/sesion-de-posesion.ts:95` `@c1bd8d3` `[MEDIDO]`.
- Lo que vive en memoria es **el almacén del CLIENTE** que lo transporta: `InMemorySesionStore`,
  `chaski-v3/src/infrastructure/auth/sesion-store.ts:80` `@c1bd8d3` `[MEDIDO]`.

⇒ *"Persistirla"* nunca fue mover un servidor a una base. Es **decidir si una credencial al portador
puede quedar at-rest**. Es una decisión de seguridad.

### 4.2 · El veredicto, en dos mitades

> **(i) ⛔ DISCO DEL NAVEGADOR: NUNCA.** Ni `localStorage`, ni `sessionStorage`, ni `IndexedDB`, ni una
> cookie, ni la URL. Para ninguna credencial al portador, en ningún árbol, en ninguna ola de esta HU.
>
> **(ii) 🟢 DISCO DEL SERVIDOR: SÍ, y el repo ya lo hace**, con tres condiciones obligatorias.

### 4.3 · Por qué (i), con las razones medidas y no heredadas

`sesion-store.ts:16-25` `@c1bd8d3` da **tres** razones, y **la primera no es una preferencia: es un
invariante por construcción** `[MEDIDO]`:

1. *«Una sesión que sobreviviera a una recarga saltearía la PRIMERA firma. En memoria, "la recarga
   vuelve a pedir la primera firma" se cumple POR CONSTRUCCIÓN, sin un guard que alguien tenga que
   acordarse de mantener.»*
2. *«Es una credencial al portador: at-rest en el navegador es superficie que no hace falta abrir.»*
3. *«El camino por enlace profundo pierde esta sesión en cada salto (el árbol de React se remonta) ⇒
   cae al PoP solo, sin que haya que escribir una línea.»*

⇒ Persistirla en el navegador **borraría el invariante (1) en silencio**. Y borraría el repliegue (3),
que es lo que hace que el camino por enlace conserve exactamente el comportamiento de hoy, gratis.

### 4.4 · Las tres condiciones de (ii), copiadas del exemplar que ya existe en el repo

El molde no hay que inventarlo: `chaski-v3/supabase/migrations/20260819T000000_add_kyc_session_tokens.sql`
`@c1bd8d3` ya pone una credencial al portador at-rest en el servidor, y escribe por qué `[MEDIDO]`:

| # | Condición | Cita del exemplar |
|---|---|---|
| **S-1** | **RLS deny-all** sobre la tabla, sin policy permisiva ⇒ fail-closed para roles no-service | `:139-140` |
| **S-2** | **Filtro app-layer por dueño** en toda lectura — el cliente usa la service key (BYPASSRLS), así que **el guard real es el `.eq(...)`**, no la RLS | `:134-137` |
| **S-3** | ⛔ **NUNCA sale en una respuesta HTTP ni en un log** | `:111-113` (*«CREDENCIAL BEARER AT-REST … NUNCA sale en una respuesta HTTP ni en un log»*) |

⚠️ **Y el exemplar declara su propio residual, que heredamos y repetimos**: *«NO se cifra porque este
repo no tiene KMS ni gestión de claves de datos, y agregar uno sería diseño nuevo dentro de una HU de
migración. Es un residual DECLARADO, no ignorado»* (`:16-19`). **Lo mismo vale acá**: el borrador y el
hash del vale quedan at-rest sin cifrado de columna, **declarado**, no descubierto por el próximo.

### 4.5 · Consecuencia operativa: **la sesión de posesión NO se persiste. Ni en el navegador, ni en el servidor.**

No hace falta. El único caso que la necesitaba —leer el borrador después del salto— lo resuelve `DT-3`
(§5), y el vale **no es la sesión**.

### 4.6 · 🔴 `CD-W0-7` — el candado de `DT-5` no vigila NINGUNA pantalla, ni la vieja ni la nueva

Medido: `it("T-372-W3-8: tras una recarga (almacén nuevo), la PRIMERA firma se vuelve a pedir y la
sesión no está en ningún disco")`, en
`chaski-v3/src/presentation/sesion-borra-la-segunda-firma.test.tsx:539` `@c1bd8d3`, busca el token en
`localStorage`, `sessionStorage`, `document.cookie` y `window.location.href` (`:556-565`) `[MEDIDO]`.

🔴 **Y acá hay una corrección de mi propia evidencia, que vale más que la afirmación que iba a escribir.**
Primero escribí *«ese `it` monta `RemittanceFlow`, o sea el árbol viejo»*. **Lo medí y es FALSO, y el
hallazgo real es peor**: su arné `recorridoInyectado`
(`chaski-v3/src/presentation/sesion-borra-la-segunda-firma.test.tsx:249` `@c1bd8d3`) **no renderiza
ningún árbol de React**. Maneja los casos de uso directo —`new ConnectWallet(...)` (`:261`),
`new ConfirmAndSend(...)` (`:271`)— y `RemittanceFlow` **no aparece ni una vez en el archivo**
(`/usr/bin/grep -n "RemittanceFlow"` ⇒ **cero hits**) `[MEDIDO]`.

⇒ **`T-372-W3-8` no vigila NINGUNA capa de presentación.** Prueba que *el camino del dinero* no deja
la sesión en disco, que es lo que se propuso probar. Pero **una pantalla —vieja o nueva— que escribiera
la sesión en `localStorage` lo dejaría verde**, porque ese código nunca corre en ese `it`.

⇒ ⛔ **`CD-W0-7` (obligación para W1, escrita acá porque acá se decide)**: W1 agrega **un `it` que SÍ
monta el árbol nuevo** y le aplica las cuatro aserciones de disco de `T-372-W3-8` (`:556-565`).
**Sin eso `DT-5` no tiene ningún candado sobre lo que esta HU construye** — y hoy tampoco lo tiene
sobre lo que ya existe.

### 4.7 · Lo que es **BLOQUEANTE de AR**, por adelantado

⛔ Si cualquier ola de esta HU propone escribir el token de sesión de posesión —o el vale **sin
hashear**— en `localStorage`, `sessionStorage`, `IndexedDB`, una cookie o la URL, **es BLOQUEANTE de
AR**, sin discusión de costo/beneficio. Es `M-4` del work-item y queda ratificado.

---

## §5 · `DT-4` RESUELTO — la circularidad se desata porque **el vale no autentica: transporta**

### 5.1 · La circularidad, enunciada

> Leer un borrador atado a una dirección exige **autenticar esa dirección**.
> La credencial que lo haría es la sesión de posesión.
> La sesión de posesión **no sobrevive al salto**.
> ⇒ para leer el borrador hace falta lo que sólo se consigue después de leer el borrador.

### 5.2 · Dónde estaba el error de razonamiento

**La premisa falsa es la primera.** Leer un borrador **no exige autenticar la dirección**: exige
**autorizar esa lectura**. Son cosas distintas, y confundirlas es lo que cierra el círculo.

⇒ **`DT-3`: el vale de vuelta es una autorización de un solo uso para UNA lectura, y nada más.**
No dice quién sos. No autoriza mover fondos. No reemplaza ninguna firma.

### 5.3 · La cadena, sin círculo

| # | Momento | Quién tiene qué | Qué pasa |
|---|---|---|---|
| **1** | **Antes de saltar** | El árbol tiene la dirección conectada y (si ya firmó) la sesión viva — **todavía no saltó** | El cliente escribe el borrador server-side. El servidor devuelve **un vale opaco** (aleatorio ≥256 bits). ⛔ Guarda **sólo el hash** |
| **2** | **El salto** | La URL de vuelta | El vale viaja **solo**. ⛔ Ni monto, ni beneficiario, ni CCI, ni la sesión (AC-11 / `CD-6`) |
| **3** | **La vuelta** | Árbol remontado, **sin sesión** | El cliente presenta el vale ⇒ **canje atómico** ⇒ recibe el borrador **y nada más** |
| **4** | **La autenticación** | La billetera | La persona **reconecta**, que es el paso 1 del recorrido nuevo (AC-1), y firma el PoP si el camino lo pide. **El vale no ahorró ninguna firma: ahorró volver a tipear el envío** |

🔴 **El círculo se rompe en el paso 4**: lo que autentica sigue siendo la firma, exactamente como hoy.

### 5.4 · Las cinco propiedades obligatorias del vale, con su razón

| # | Propiedad | Por qué, y el exemplar |
|---|---|---|
| **V-1** | **Opaco y aleatorio ≥ 256 bits**, sin estructura derivable | Un identificador adivinable es un identificador público |
| **V-2** | **Guardado HASHEADO**, nunca en claro | `a2a_agent_links.token_hash` — *«persiste SOLO SHA-256(token)»*, `wasiai-a2a/supabase/migrations/20260706000000_wkh137_agent_links.sql:7` `@main` `[MEDIDO]` |
| **V-3** | **Un solo uso, quemado atómicamente** | `claimWebhookEventOnce` (`SET NX EX`), `chaski-v3/src/infrastructure/webhooks/webhook-event-store.ts:43` `@c1bd8d3` `[MEDIDO]`. Su docblock dice que es *«el ÚNICO claim-once del repo»* |
| **V-4** | **TTL ≤ 10 minutos** — no 30 | Un salto a la billetera y su vuelta son segundos. El TTL acota la ventana en que un vale que quedó en el historial del navegador todavía sirve. ⛔ **No se hereda el 30 de la sesión**: ese número el propio repo lo declara *«una hipótesis sobre cuánto tarda el recorrido, no una medición»* (`sesion-de-posesion.ts:43-45`) |
| **V-5** | ⛔ **No autoriza ningún movimiento de fondos** | La ruta de canje **no toca** `ConfirmAndSend` ni el escrow. Verificable con un candado estático de imports |

### 5.5 · El techo del daño, escrito antes de que lo pregunte el AR

**El vale es un secreto que viaja en una URL**, y una URL queda en el historial del navegador y se la
lleva la billetera. Eso es cierto y no se disimula. **Lo que puede hacer quien lo robe dentro de su
ventana de ≤10 min y antes del primer canje**: leer **un borrador reducido**.

- ⛔ No mueve fondos (V-5).
- ⛔ No firma nada (no es una credencial de firma).
- ⛔ No obtiene una dirección autenticada (el vale no autentica).
- ⛔ **Y el borrador NO contiene el CCI ni el nombre completo**: hereda la reducción de PII que el
  cliente ya aplica hoy (`chaski-v3/src/infrastructure/persistence.ts:17-19` `@c1bd8d3` `[MEDIDO]`,
  citado por `M-3` del work-item). **Foco obligatorio de AR en W2.**

⇒ **Techo del daño: la exposición de un borrador reducido durante ≤10 minutos, una sola vez.**
Eso es lo que compramos a cambio de que la vuelta aterrice donde se estaba.

### 5.6 · ⚠️ Dónde el exemplar cross-repo **no** se puede copiar literal

`claim_agent_link` (`wasiai-a2a/supabase/migrations/20260706000000_wkh137_agent_links.sql:59` `@main`)
distingue **tres** fallas: `LINK_NOT_FOUND` (`:89`), `LINK_EXPIRED` (`:94`) y `LINK_ALREADY_USED`
(`:99`) `[MEDIDO]`.

🔴 **AC-12 exige lo contrario**: *«THEN the system SHALL rechazarlo sin revelar si existió»*.
⇒ **La forma se copia; los códigos de error NO.** En el borde HTTP los tres colapsan en **una sola
respuesta indistinguible**, y ese colapso **tiene su propio test en W2** (⛔ no se da por hecho: es
exactamente la clase de detalle que se pierde al "seguir el exemplar").

### 5.7 · El cabo suelto, declarado y no escondido

En el recorrido nuevo **conectar es lo primero** (AC-1), así que en el paso 1 hay dirección pero **puede
no haber sesión de posesión todavía** (la sesión se acuña tras la primera firma).

⇒ El borrador se escribe **con lo que haya**: si hay sesión ⇒ atado a `owner_address`; si no ⇒ atado
sólo al vale, con `owner_address` **NULL**.
⇒ ⛔ **Un borrador con `owner_address` NULL NUNCA puede autorizar un desembolso**, y no por disciplina:
**por construcción de la query**, porque `.eq('owner_address', X)` **nunca matchea un NULL**. Es
exactamente el mecanismo que el exemplar ya escribió y explicó
(`20260819T000000_add_kyc_session_tokens.sql:114-125` `@c1bd8d3` `[MEDIDO]`).
⇒ La forma exacta de la tabla es **`[TBD en el SDD de W2]`**. El **criterio** queda cerrado acá.

---

## §6 · `DT-6` RESUELTO — los dos proveedores que ya están, uno por problema

⛔ **No se estrena ningún proveedor** (`DT-6` del work-item). Y la decisión **no** es elegir uno de los
dos: es que **son dos problemas distintos y el repo ya tiene el molde de cada uno**.

| Qué | Proveedor | Molde en el repo | Por qué ése |
|---|---|---|---|
| **El VALE** (un solo uso, TTL corto, quemado atómico) | **Upstash Redis** | `claimWebhookEventOnce`, `chaski-v3/src/infrastructure/webhooks/webhook-event-store.ts:43` `@c1bd8d3` | `SET NX EX` **es** "un solo uso + vencimiento", atómico y en una operación. Ya cableado, ya con su patrón de fail-**closed** y su **tercer valor** `unavailable` (⛔ no un booleano — lección **H**) |
| **El BORRADOR** (durable, atado al dueño, auditable) | **Supabase** | `kyc_session_tokens` + `chaski-v3/src/infrastructure/persistence/supabase-kyc-session-tokens.ts` + `getSupabaseServerClient()` (`supabase-server.ts:17`) | Necesita RLS, filtro app-layer por dueño, migración versionada y sobrevivir a un reinicio. Redis con TTL no da nada de eso |

⚠️ **Los dos degradan a `null`/`unavailable` si faltan sus envs** (`supabase-server.ts:19-21`,
`webhook-event-store.ts:30-33` `[MEDIDO]`) ⇒ **el receptor sin env es un no-op verificable**, que es
justo lo que `CD-7` (orden de despliegue) necesita. ⛔ Y el no-op **no** puede degradar a "no hay
borrador": ese colapso es la lección **H** y ya mordió en WKH-372 (*«No pude leer el disco» publicado
como «no hay borrador»*, `auto-blindaje.md` 233, fix-pack 3).

---

## §7 · LA OLA 0 — la puerta. **3 archivos, 6 `it`, CERO líneas de producción**

### 7.0 · 🔴 Qué cambié respecto del work-item, y por qué (leer antes de la tabla)

El work-item propone `W0-1..W0-6`. **Tres de esas seis, tal como están escritas, no miden lo que dicen.**
Lo declaro acá en vez de implementarlas y descubrirlo después:

| Del work-item | El problema, medido | Qué hago |
|---|---|---|
| **W0-4**: *«correr `citas-ancladas.test.ts` contra un módulo nuevo vacío y verificar que su censo entrante es 0»* | 🔴 **Es tautológico.** Un archivo que acaba de nacer no lo cita nadie **por definición**. Un `it` que no puede fallar no es un control (lección: *controles que se leen a sí mismos*) | Lo invierto: mido **el costo del camino contrario** (§7.4) |
| **W0-3**: *«sembrar la sesión, simular el salto y asertar `peek()` ⇒ null»* | 🔴 **Un almacén NUEVO está vacío por construcción.** Eso ya lo hace `T-372-W3-8` y no dice nada del salto | Lo parto en **tres patas**, y la que importa es que **no hay router en el repo** (§7.3) |
| **W0-5**: *«comparar `innerHTML` con y sin la env»* | 🔴 **W0 no escribe producción ⇒ la bandera del recorrido nuevo NO EXISTE.** No se puede medir la inercia de una bandera que no hay | Lo convierto en **calibración del instrumento de AC-13**, corriendo su mutante sobre la bandera que **sí** existe. **AC-13 propio se mide en W1**, y se dice con esas palabras (§7.5) |

Y **agrego dos** que el work-item no tenía y sin las cuales los números de W0-1/W0-2 no valen:

| Nuevo | Por qué es imprescindible |
|---|---|
| **W0-0** · calibrar `viajesALaBilletera` | 🔴 Ese filtro **sólo se corrió donde la respuesta es `[]`** (`T-372-W1-13`). **Un filtro que siempre devuelve `[]` es indistinguible de "no hubo saltos".** Antes de publicar un número hay que probar que el instrumento sabe contestar **que sí** |
| **W0-7** · línea de base del flake | Sin la tasa medida de `vuelta-por-enlace-carrera.test.tsx`, el primer rojo de W1 se lee como *"lo rompí yo"*. Con ella se puede distinguir |

### 7.1 · Los archivos que W0 escribe. **Tres. Cero producción.**

| | Archivo (`chaski-v3`) | Nuevo/Extiende | Qué contiene |
|---|---|---|---|
| **A** | `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | **EXTIENDE** | `W0-0`, `W0-1`, `W0-2` |
| **B** | `src/composition/el-arbol-propio-cuesta-cero-citas.test.ts` | **NUEVO** | `W0-4` |
| **C** | `src/presentation/el-salto-remonta-el-arbol.test.tsx` | **NUEVO** | `W0-3` |

⛔ **`W0-5`, `W0-6` y `W0-7` escriben CERO líneas**: son corridas de mutante / de repetición / una
declaración con dueño. Eso es deliberado, no un atajo (§7.5-7.7).

**Por qué A extiende y no crea** (`DT-9`): ese archivo ya tiene `espiarNavegacion` (`:175`),
`viajesALaBilletera` (`:208`), `entrarAlNavegadorDeLaBilletera` (`:149`), `sembrarElCaminoPorEnlace`
(`:226`) y `cargarYEnviar` (`:688`) `@c1bd8d3` `[MEDIDO]`. **Escribir un contador al lado sería un
segundo sitio de verdad**, y además ~200 líneas de arnés duplicado.

⚠️ **Consecuencia de extender, y va escrita**: A pasa de 768 a ~950 líneas, y **toda cita `:NN` hacia A
que exista en el árbol se corre si se inserta arriba**. ⇒ **los `it` nuevos van AL FINAL del archivo**,
y las citas se re-derivan con `grep -n` **después de la última edición** (lección **V**).

---

### 7.2 · `W0-0` — **calibrar el instrumento antes de publicar cualquier número**

**Qué mide**: que `viajesALaBilletera` **reconoce un `href` de enlace profundo**, y no sólo el de
`browse`.

**Por qué existe.** `HOST_DE_LA_BILLETERA` se deriva de `phantomBrowseUrl(...)`
(`recorrido-en-el-navegador-de-la-billetera.test.tsx:169` `@c1bd8d3`), que es el enlace para **abrir
Chaski adentro de Phantom**. El camino por enlace usa otra familia de URLs, construida por `urlConectar`
(`chaski-v3/src/infrastructure/solana/deeplink/protocol.ts:149` `@c1bd8d3`) sobre `BASE` (`:54-57`).
**Medido: las dos familias comparten hostname `phantom.app`** ⇒ el filtro **sí** cubre el camino por
enlace para Phantom. **Pero nadie lo había verificado**, y ese verde nunca se ejercitó.

**El `it`**:
`it("T-374-W0-0: el filtro de viajes reconoce un href de ENLACE PROFUNDO, y declara que solflare queda afuera")`

Afirma, en este orden:
1. `new URL(urlConectar({billetera:"phantom", …})).hostname === HOST_DE_LA_BILLETERA` — **los dos lados
   se LEEN de producción**, de **dos módulos distintos**. ⛔ El `it` **no escribe el literal
   `"phantom.app"` en ninguna línea**.
2. `viajesALaBilletera([hrefDeEnlace, hrefDelVerificador, "no-soy-una-url"])` devuelve **exactamente**
   `[hrefDeEnlace]` — **por valor, no por largo**.
3. Declara, con su aserción, que `new URL(urlConectar({billetera:"solflare", …})).hostname` **NO** está
   cubierto por el filtro de hoy ⇒ **todo número de W0-1/W0-2 vale para Phantom y no para Solflare**.

**Mutante nombrado (M-0)**: en `protocol.ts:54`, `phantom: "https://phantom.app/ul/v1"` →
`"https://phantom.example/ul/v1"` ⇒ **cae la aserción 1**.
⛔ **Falso KILLED a evitar**: si la aserción 2 dijera sólo `.toHaveLength(1)`, un filtro que devolviera
**todo** pasaría igual. Por eso compara **el arreglo entero por valor**.
⛔ **Guard que no se lee a sí mismo**: los dos hostnames salen de **producción**; el archivo del `it` no
contiene el literal.

---

### 7.3 · `W0-1` y `W0-2` — **los dos números de la métrica, derivados EJECUTANDO**

**Qué miden**: en el **camino por enlace** (bandera prendida, disponibilidad `"none"` **leída del
árbol**, elección sembrada), en un envío que **cierra**: cuántas **travesías de la pantalla de entrada**
(`travesías = 1 + asignaciones de window.location.href`) y cuántos **viajes a la billetera**.

**El `it`**:
`it("T-374-W0-1: en el camino POR ENLACE, un envío que cierra atraviesa la pantalla de entrada N veces y sale a la billetera M veces")`

**El orden de las aserciones, que es lo que lo vuelve falsable:**

| # | Aserción | Por qué va ahí |
|---|---|---|
| 1 | `entrarAlNavegadorDeLaBilletera(false)` devuelve **`"none"`** | ⛔ **CD-18**: el árbol llegó al cuadrante del enlace. Sin esto, un `it` que quedó en `injected` cuenta los números del otro camino |
| 2 | `caminoPorEnlace()` **no** es `null` | Las tres condiciones (`disponibilidad` + bandera + elección) están conjugadas. Sin esto, cualquiera de las tres explica el resultado |
| 3 | **El desenlace se alcanzó** (el paso final del recorrido está en pantalla) | 🔴 Trampa 1 de §4 del work-item: *un recorrido que no cierra cuenta 0 de todo* |
| 4 | `viajesALaBilletera(espia.asignado)` **no** está vacío | 🔴 Trampa del falso verde por vacío. **Ésta es la que W0-0 vuelve creíble** |
| 5 | `1 + espia.asignado.length` === **`N`** (literal) | El número de travesías |
| 6 | `viajesALaBilletera(espia.asignado).length` === **`M`** (literal) | El número de salidas |

🔴 **`N` y `M` los escribe el Dev DESPUÉS de la primera corrida, con la salida cruda pegada en el
docblock del `it`.** ⛔ **PROHIBIDO escribir `7`, `6` o `5` copiados de cualquier documento** (`CD-9`,
AC-18). Si el número que sale no coincide con el heredado, **el número medido gana y el heredado se
declara falso**, con esas palabras.

**Los DOS mutantes, y por qué hacen falta dos:**

| Mutante | Qué toca | Qué aserción mata |
|---|---|---|
| **M-1** | Quitar `vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED","true")` de `sembrarElCaminoPorEnlace` (`:227`) | La **2** (y quizá la 3). ⚠️ **NO mata por el conteo** |
| **M-2** | Agregar **una** asignación de `window.location.href` hacia el host de la billetera en la rama del enlace de `flow.tsx` | Las **5 y 6**, y sólo ésas |

🔴 **Éste es el falso KILLED que hay que evitar, y ya mordió en WKH-372** (lección **U**: *«un mutante
puede morir por la aserción del INSTRUMENTO y no por la de la pantalla»*). ⇒ **el Dev reporta, para cada
mutante, CUÁL aserción produjo el rojo**, citándola. Un `1 failed` sin decir cuál no cuenta como KILLED.

⚠️ **Tres límites de estos números, escritos antes de que alguien lea su verde:**
1. **jsdom, no un teléfono.** El propio archivo lo declara en `:31-34` `@c1bd8d3` `[MEDIDO]`.
   ⇒ el número se publica **🟡 derivado**, nunca 🟢, hasta que corra en el teléfono del founder (W3).
2. **Sólo Phantom** (W0-0, aserción 3).
3. **Es el número de HOY, del árbol viejo.** Es la línea de base contra la que W1/W3 comparan.
   ⛔ No es una promesa sobre el árbol nuevo.

⚠️ **Y una trampa que este `it` NO puede cerrar y por eso se dice**: si el número sale más bajo que el
heredado, hay que distinguir *«se simplificó»* de *«una rama quedó inalcanzable»* (trampa 3 de §4 del
work-item). Eso lo contesta leer el camino, no el contador.

---

### 7.4 · `W0-3` — **`L-5`, y es la medición que puede cambiar el diseño entero**

**La premisa**: *el salto por enlace remonta el árbol de React*, de la que cuelga todo el §2 del
work-item. Hoy es **doctrina heredada** (`sesion-store.ts:23-25`), no una corrida.

**El `it` la parte en tres patas**, en
`src/presentation/el-salto-remonta-el-arbol.test.tsx` (NUEVO):

`it("T-374-W0-3: el almacén de sesión es POR DOCUMENTO, la salida al enlace es una navegación de documento, y el instrumento sabe decir que SÍ hay sesión")`

**Pata (a) — el almacén es por documento, no por navegación.** `[MEDIDO] en el diseño`
Medido en el árbol: `let singleton: Container | null = null` (`container.ts:263`) y
`getContainer()` memoiza (`:265`); `createContainer()` (`:96`) construye
`new InMemorySesionStore(clock)` (`:106`) `@c1bd8d3`.
⇒ El `it` afirma: `getContainer() === getContainer()` (⇒ **una navegación blanda CONSERVARÍA la
sesión**) **y** que dos `createContainer()` dan almacenes **distintos** (⇒ **una carga nueva la
pierde**). Las dos mitades juntas dicen qué depende de qué.

**Pata (b) — 🔴 la que de verdad decide: en este repo NO HAY router de cliente.**
Barrido medido hoy sobre `src/` + `app/`: **cero** `useRouter`, **cero** `router.push`, **cero**
`router.replace`; **una sola** ocurrencia de `next/navigation`, y es un `notFound()` en
`app/kyc-simulado/page.tsx:26` `@c1bd8d3` `[MEDIDO]`. Toda navegación del recorrido es
`window.location.href = …` (10 sitios, de los cuales 2 son menciones en comentarios).
⇒ **Toda salida es una navegación de DOCUMENTO** ⇒ el registro de módulos se descarta ⇒ `singleton`
vuelve a `null` ⇒ **la premisa `L-5` es VERDADERA hoy, y lo es por AUSENCIA.**
⇒ El `it` **convierte esa ausencia en un candado**: barre `src/` y `app/` con `readFileSync` y exige
que el conjunto de ocurrencias de router siga siendo el que hoy es.

**Pata (c) — el control positivo, sin el cual (a) no dice nada.**
Sembrar una sesión en un almacén y afirmar que `peek(direccion)` devuelve **el token**. ⛔ Sin esto, el
`null` de (a) es indistinguible de un instrumento roto.

**Mutantes nombrados:**

| Mutante | Qué toca | Qué mata |
|---|---|---|
| **M-3** | Borrar la memoización de `container.ts:266` (`if (!singleton) …` ⇒ siempre `createContainer()`) | La primera mitad de (a) |
| **M-4** | Agregar `router.push("/x")` en un archivo sintético que el barrido de (b) lee | El barrido de (b) |
| **M-5** | Hacer que `peek` devuelva siempre `null` | La pata (c) |

⛔ **Dos falsos KILLED a evitar, los dos medidos en WKH-372:**
1. **Colapso del resolvedor** (lección **M**): un guard de existencia que vive en un archivo que
   *importa* lo que vigila muere por `Failed to resolve import`, **y eso no es un KILLED**. ⇒ el barrido
   de (b) usa **`readFileSync`**, no `import`.
2. **Auto-lectura**: el archivo del `it` contiene los literales `useRouter` y `router.push` en su propia
   prosa. ⇒ **se excluye por RUTA EXACTA**, con el patrón `SELF` de
   `citas-ancladas.test.ts:56` `@c1bd8d3` — ⛔ nunca por glob ni por `.test.` en el nombre. Y lleva
   **control negativo**: se le da una lista de líneas sintéticas **con** `router.push` y se exige que
   las cace.

🔴 **Qué pasa si (b) sale FALSA** (hoy o el día que alguien agregue el router de Next): **el `singleton`
sobreviviría al salto, la sesión cruzaría, `DT-3` dejaría de ser necesario y el §2 del work-item cambia
de forma.** Por eso `W0-3` es **bloqueante**: si sale roja, la ola se detiene y vuelve a F1/F2 (`CD-4`).

---

### 7.5 · `W0-4` — **el costo del árbol propio, medido por el camino contrario**

**Lo que NO mide** (y por qué): la versión del work-item —"un módulo nuevo vacío tiene censo entrante
0"— **no puede fallar**. Nadie cita un archivo que acaba de nacer.

**Lo que SÍ mide**: **cuánto cuesta la alternativa**, que es un número real y que decide `DT-1`.

En `src/composition/el-arbol-propio-cuesta-cero-citas.test.ts` (NUEVO):

`it("T-374-W0-4: una cita ANCLADA nueva hacia flow.tsx mueve 12 marcadores en 6 archivos; una SUELTA no mueve ninguno")`

Afirma:
1. El conjunto de archivos con marcadores `[[CENSO src/presentation/flow.tsx …]]` es **exactamente** los
   6 derivados del árbol, y los conteos por campo son **12 / 8 / 1**
   (`entrantes` / `lineas` / `destinos`). ⛔ Los 6 nombres **se derivan**, no se escriben a mano.
2. Sobre **líneas sintéticas** (⛔ **no se escribe ningún archivo**): una cita **anclada** a
   `src/presentation/flow.tsx` sube `entrantes` a 166 ⇒ **los 12 marcadores quedan desajustados**.
3. La misma cita **sin ancla** (sin la coma entre backticks) **no mueve ninguno**.
4. **Calibración contra un tercero**: el conteo de `entrantes` que produce este `it` **coincide con el
   número que los 12 marcadores declaran**. Si no coincide, el instrumento de este `it` está mal.

**Mutante nombrado (M-6)**: en el regex local, quitar la coma obligatoria del formato anclado
(`` `sim`, `f:NN` `` ⇒ `` `f:NN` ``) ⇒ **la aserción 3 se cae**, porque la suelta empieza a contarse.

⛔ **Falsos KILLED a evitar:**
1. **Auto-lectura**: este archivo escribe citas de mentira en sus fixtures. ⇒ **se excluye por RUTA
   EXACTA** (patrón `SELF`), igual que `citas-ancladas.test.ts` hace consigo mismo.
2. 🔴 **Lección N**: un ancla **partida por un salto de línea** NO entra al conjunto del guard real —
   **47 ocurrencias preexistentes en el árbol** `[HEREDADO]` de `auto-blindaje.md` 233. ⇒ el `it` le da
   una cita partida como fixture y **exige que NO la cuente**, igual que el candado real. Sin eso, el
   instrumento nuevo y el viejo diferirían en un caso borde y la aserción 4 pasaría por casualidad.
3. ⛔ **No se importa `citas-ancladas.test.ts`**: importar un `.test.ts` **corre sus 9 `describe`** y los
   duplicaría en el reporte. Se re-implementa el regex **con su cita al lado** y se **calibra** (asserción 4).

---

### 7.6 · `W0-5` — **calibrar el instrumento de AC-13. ⛔ AC-13 se mide en W1, no acá**

🔴 **La corrección**: W0 escribe **cero líneas de producción**, así que la bandera
`NEXT_PUBLIC_CHASKI_RECORRIDO_V2` **no existe todavía**. **No se puede medir la inercia de una bandera
que no hay.** Decir que se midió sería exactamente la clase de afirmación sin sujeto que la lección **C**
persigue.

**Lo que W0-5 sí hace, y son 0 líneas nuevas**: corre el mutante del instrumento que W1 va a reusar.

- **Instrumento**: `it("T-065-21: con la bandera APAGADA el paso `connect` es byte-idéntico al de hoy")`,
  `chaski-v3/src/presentation/wallet-availability.test.tsx:1037` `@c1bd8d3`, con su hermano
  `it("T-065-21b: con la bandera PRENDIDA y una wallet inyectada, el selector NO aparece")` `:1076`.
- **Lo que ya trae y hay que copiar**: la **segunda mitad** — con la bandera prendida el `innerHTML`
  tiene que ser **DISTINTO** (`:1066` `@c1bd8d3`). 🔴 **Ésa es la mitad que vuelve falsable a la
  primera**: sin ella, `toBe(apagada)` pasaría porque el selector **nunca se monta**, no porque la
  bandera lo gatee.
- **Mutante (M-7)**: en `flow.tsx`, en el JSX del paso `connect`, borrar el gate
  `mostrarSelectorDeEnlace ?` (`flow.tsx:963` `@c1bd8d3`) ⇒ `T-065-21` en rojo. **El propio archivo ya
  nombra este mutante** (`wallet-availability.test.tsx:1034-1036`).
  ⚠️ **Se corre en un worktree o con restauración verificada contra `git diff --numstat`**, ⛔ nunca con
  un `.orig` cacheado: en WKH-372 un restaurador propio **revirtió una ola entera en silencio** y el
  `md5` **confirmó el revert en vez de cazarlo** (lección **A**).
- **Lo que W0-5 entrega**: la frase, escrita en el reporte de W0 —
  *«AC-13 NO se midió en W0: la bandera no existe. Lo que se midió es que el instrumento discrimina, con
  su mutante M-7. AC-13 se mide en W1.»*

---

### 7.7 · `W0-6` — `L-4`, el `localStorage` a través del salto. **Medición de teléfono, con dueño**

⛔ **No se puede cerrar en `jsdom`.** El navegador de la billetera es **otra partición de
almacenamiento**, y el propio módulo lo dice:
`chaski-v3/src/presentation/salida-al-navegador-de-la-billetera.ts:16-20` `@c1bd8d3` `[MEDIDO]`.

| | |
|---|---|
| **Cómo se mide** | Con el instrumento que **ya existe**: la marca de vuelta que ese módulo deja en la URL, leída por `vinoDeUnaSalidaConBorrador` en el mismo archivo, y el renglón de `?diag=1` de `diagnostico-de-vuelta.tsx` |
| **Quién** | El founder, en su teléfono, con Phantom. **Precondición**: *Testnet Mode* prendido |
| **Cuándo** | **W3**, junto con el resto de la medición de teléfono |
| **Qué NO se puede decir mientras tanto** | ⛔ *«No se pudo medir»* **no es** *«no cruza»*. Un booleano no tiene dónde poner el tercer valor (lección **H**) |
| **Por qué no bloquea** | Es un **argumento a FAVOR** del borrador server-side, no en contra: si el disco no cruza, el borrador en el servidor es la única forma; si cruza, sigue siendo la forma correcta por AC-11 |

---

### 7.8 · `W0-7` — la línea de base del flake. **0 líneas, y no se pone en cuarentena**

`chaski-v3/src/presentation/vuelta-por-enlace-carrera.test.tsx` (334 líneas) tiene un flake preexistente
declarado de **7-13 %** `[HEREDADO]` del encargo. ⛔ **No se pone en cuarentena.**

**W0-7**: correr **ese archivo solo, 20 veces**, y publicar la tasa medida (`k/20`) con el commit.

⚠️ **Lo que esa tasa NO es**: un diagnóstico. **Repetir no prueba el mecanismo** — 20 corridas no dicen
casi nada de un flake de 1 en 1000, y decir *"corrió 20 veces verde"* sobre un flake del 10 % es
esperable el 12 % de las veces. Se publica como **foto**, para que W1 pueda distinguir *«lo rompí yo»*
de *«es el de siempre»*. **El mecanismo del flake es una HU aparte y se nombra para que no se vaya en
silencio.**

⚠️ **Y un footgun propio, medido en este ecosistema**: correr suites en paralelo desde el agente vuelve
flaky lo que no lo era. ⇒ **las 20 corridas van SERIALIZADAS**.

---

### 7.9 · Tabla de cierre de W0 — qué la pone ROJA

| # | Bloqueante | Qué la pone roja | Si sale roja |
|---|---|---|---|
| **W0-0** | 🔴 Sí | Que los dos hostnames **no** coincidan, o que el filtro devuelva de más | El instrumento no sirve ⇒ **ningún número de W0-1/W0-2 es publicable** |
| **W0-1** | 🔴 Sí | Que el recorrido no llegue al desenlace, o que el conteo no sea reproducible entre corridas | Se detiene la ola: no hay línea de base |
| **W0-2** | 🔴 Sí | Que `viajesALaBilletera` dé `[]` (falso verde por vacío) | Ídem |
| **W0-3** | 🔴 Sí | Que la sesión **sobreviva**, o que aparezca un router de cliente, o que el control positivo no distinga | 🔴 **El §2 del work-item cambia de forma. Vuelve a F1/F2** |
| **W0-4** | 🔴 Sí | Que los conteos derivados no coincidan con los 12 marcadores (aserción 4) | El instrumento está mal, o el árbol se movió ⇒ re-derivar |
| **W0-5** | 🟡 No | Que `M-7` **no** ponga rojo a `T-065-21` | El instrumento de AC-13 no discrimina ⇒ W1 necesita otro |
| **W0-6** | ⬜ No | — (no medible acá) | Se declara con dueño y fecha |
| **W0-7** | ⬜ No | — | Se publica la tasa |

---

## §8 · Exemplars verificados

⛔ Todos abiertos con `sed`/`grep` en esta sesión. **Ninguna ruta de esta tabla es recordada.**

| # | Exemplar | Ruta verificada | Qué se copia |
|---|---|---|---|
| E-1 | El instrumento de travesías y viajes | `chaski-v3/src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx:175`, `:208`, `:226` | Se **extiende**, no se reescribe (`DT-9`) |
| E-2 | Leer la disponibilidad **del árbol** | `it("T-CABLE-2: …")`, `chaski-v3/src/presentation/wallet-availability.test.tsx:146` | ⛔ Nunca `setWalletAvailability(...)` a mano |
| E-3 | Byte-identidad con las **dos** mitades | `it("T-065-21: …")` `:1037` y `it("T-065-21b: …")` `:1076`, mismo archivo | El molde de AC-13 (W1) |
| E-4 | Afirmar el desenlace **antes** de contar | `it("T-372-W1-13: …")`, mismo archivo que E-1, `:707` | CD-18 |
| E-5 | Exclusión por **ruta exacta** (anti auto-lectura) | `SELF`, `chaski-v3/src/composition/citas-ancladas.test.ts:56` | W0-3(b) y W0-4 |
| E-6 | Entrada **sintética** para un caso que el árbol no tiene | `T-CITAS-LEXER`, mismo archivo | W0-4 |
| E-7 | Claim-once atómico con **tres** valores | `claimWebhookEventOnce`, `chaski-v3/src/infrastructure/webhooks/webhook-event-store.ts:43` | El vale (W2) |
| E-8 | Credencial bearer at-rest en el **servidor** | `chaski-v3/supabase/migrations/20260819T000000_add_kyc_session_tokens.sql` (DDL en `:104`) | `DT-5` + el borrador (W2) |
| E-9 | Cliente server-only que degrada a `null` | `getSupabaseServerClient`, `chaski-v3/src/infrastructure/persistence/supabase-server.ts:17` | W2 |
| E-10 | Máquina de estados de un vale + claim atómico | `claim_agent_link`, `wasiai-a2a/supabase/migrations/20260706000000_wkh137_agent_links.sql:59` | La **forma**. ⛔ **No los códigos de error** (§5.6) |
| E-11 | Bandera opt-in estricto + gotcha del build | `mwaEnabled` `:98` / `deeplinkEnabled` `:156`, `chaski-v3/src/presentation/wallet-availability.ts` | `DT-2` (W1) |
| E-12 | Cita **sin ancla** hacia `flow.tsx`, con su motivo | `chaski-v3/src/presentation/bitacora-de-vuelta.ts:175-177` | Toda cita a `flow.tsx` en esta HU |

---

## §9 · Constraint Directives — `CD-W0-N`

**Heredadas del work-item, vigentes y sin cambios**: `CD-1` … `CD-14`. Se repiten las que W0 puede violar.

| # | Directiva |
|---|---|
| **`CD-W0-1`** | ⛔ **CERO líneas de producción.** W0 escribe **sólo** `src/presentation/*.test.tsx` y `src/composition/*.test.ts`. Ni una línea en un `src/**/*.ts` no-test, ni en `app/`, ni en `supabase/`. Se verifica con `git diff --numstat` **contra el índice** |
| **`CD-W0-2`** | ⛔ **`flow.tsx` no se toca. Δ0 = 0.** Ni una línea, ni un carácter. Los 8 marcadores `lineas=4453` son el candado |
| **`CD-W0-3`** | ⛔ **Ninguna cita ANCLADA nueva hacia `flow.tsx`, `solana-wallet.ts` ni ningún archivo con marcadores `[[CENSO … entrantes]]`.** Anclar es **escribir** sobre el destino. Las citas van **sueltas, con su motivo al lado**, patrón E-12 |
| **`CD-W0-4`** | ⛔ **PROHIBIDO publicar `6`, `5` o `7`** copiados de cualquier documento. Todo número de la métrica sale de una corrida, con su etiqueta 🟢/🟡/🔴 (`CD-9`, AC-17/18) |
| **`CD-W0-5`** | ⛔ **Ningún guard puede leerse a sí mismo.** Todo barrido de archivos se excluye **por ruta EXACTA** (E-5), nunca por glob ni por el sufijo `.test.` |
| **`CD-W0-6`** | ⛔ **Cada `it` lleva su mutante NOMBRADO y su falso-KILLED escrito.** Y al correrlo se reporta **cuál aserción produjo el rojo** (lección **U**). Un `1 failed` sin decir cuál **no cuenta como KILLED** |
| **`CD-W0-7`** | 🔴 **(obligación para W1, decidida acá)** W1 agrega un `it` que **monta el árbol nuevo** y le aplica las **cuatro** aserciones de disco de `it("T-372-W3-8: …")` (`sesion-borra-la-segunda-firma.test.tsx:556-565`). ⚠️ **Medido: `T-372-W3-8` no renderiza ningún árbol** (`RemittanceFlow` ⇒ 0 hits en ese archivo) ⇒ `DT-5` **hoy no tiene candado sobre ninguna pantalla** (§4.6) |
| **`CD-W0-8`** | ⛔ **Toda cita a un test se escribe por el NOMBRE del `it` + su archivo**, con el número anclado a `@c1bd8d3`. **7 citas se rompieron en WKH-372 por escribirlas sólo por número, y nada las vigila entre repos** (lección **E**/**F**) |
| **`CD-W0-9`** | ⛔ **El gate es `npm run qa` → `npm run build`, corrido ENTERO, en orden, contra el ÍNDICE de git.** ⛔ **PROHIBIDO `npx biome` y `npx tsc` sueltos**: `npx` baja paquetes inexistentes y su error se lee como fallo del gate. ⛔ Correr `vitest` solo **no es correr el gate** (lección **Z**/**K**) |
| **`CD-W0-10`** | ⛔ **Todo mutante se aplica por número de línea, se VERIFICA en disco antes de correr, y se restaura contra `git diff --numstat`.** ⛔ Nunca con un `.orig` cacheado (lección **A**: revirtió una ola entera y el `md5` lo confirmó) |
| **`CD-W0-11`** | ⛔ **Los `it` nuevos van AL FINAL de su archivo**, y toda cita `:NN` se **re-deriva con `grep -n` DESPUÉS de la última edición** (lección **V**) |
| **`CD-W0-12`** | ⛔ **PROHIBIDO poner en cuarentena `vuelta-por-enlace-carrera.test.tsx`.** Se mide (W0-7) y se publica la tasa |
| **`CD-W0-13`** | ⛔ **PROHIBIDO tocar nada por encima de la línea 144 de `wasiai-a2a/doc/sdd/_INDEX.md`** (`CD-10` heredada). La fila 234 **ya existe** en `:226` |
| **`CD-W0-14`** | ⛔ **Ninguna afirmación de W0 puede decir que «Crear la cuenta» desaparece** (HU `071`, `CD-12`), ni que las salidas son **2** mientras W4 de WKH-372 no tenga decisión (AC-9b ⇒ el objetivo publicable es **3**) |

---

## §10 · Presupuesto de escala — **con la prosa separada del código, y RE-DERIVADO**

### 10.1 · 🔴 El denominador del work-item envejeció, y lo re-derivo acá

El work-item dice *«61 % de prosa contra el ~50 % de la casa»*. **Medí la casa hoy**, sobre `c1bd8d3`,
todo `src/` + `app/` **sin tests**:

| Medición | Valor |
|---|---|
| Líneas de comentario puro (producción) | **18.311** |
| Líneas de código (producción) | **16.263** |
| **Ratio de prosa de la casa** | **53,0 %** |
| Ídem, sólo `src/presentation/` | **53,4 %** |
| Módulos nuevos recientes (`sesion-store.ts`, `bitacora-de-vuelta.ts`) | **71 %** y **78 %** |

⇒ **La media de la casa es 53,0 %, no ~50 %.** El **61 %** de la ola anterior estuvo **8 puntos** por
encima, no 11. Y el techo de **≤45 %** de `CD-14` está **8 puntos por DEBAJO** de lo que la casa hace
hoy y **~30 por debajo** de sus módulos más nuevos.

**Eso no lo cambio** —`CD-14` es del work-item y el apriete es deliberado— pero **queda dicho que es un
apriete real y no un piso cómodo**, y que el SDD de W1 tiene que decidir explícitamente si lo sostiene
o lo re-negocia con el humano. **`[TBD en el SDD de W1]`**, con este número como base.

(Lección **G**: *un número publicado se re-mide contra el árbol*. Acabo de hacerlo.)

### 10.2 · El presupuesto de W0

| Magnitud | Techo | Nota |
|---|---|---|
| **Producción ejecutable** | **0** ⛔ estricto | `CD-W0-1` |
| **Producción comentario** | **0** ⛔ estricto | Ídem |
| **Líneas de test — total** | **≤ 520** | Ver la desviación de 10.3 |
| · archivo **A** (extensión) | ≤ 190 | 3 `it`, arnés **reusado** (0 líneas de arnés) |
| · archivo **B** (nuevo) | ≤ 160 | 1 `it` + recolector + fixtures sintéticos |
| · archivo **C** (nuevo) | ≤ 170 | 1 `it` de tres patas + barrido + control negativo |
| **Prosa dentro de los tests** | ≤ 55 % | Por debajo de los módulos nuevos de la casa (71-78 %), por encima del 45 % de producción — **son magnitudes distintas y `CD-14` habla de PRODUCCIÓN** |
| **Archivos tocados** | **≤ 3** | 1 extendido + 2 nuevos |
| **Archivos de producción tocados** | **0** ⛔ | |

### 10.3 · 🔴 Desviación declarada: **520 contra los 400 del work-item**

**Se declara, no se silencia** (lección **Q**: *un exceso silencioso es el hallazgo*).

- El work-item presupuesta **≤400** líneas de test para W0. Este SDD pide **≤520** (**1,3x**).
- **Dónde está el exceso, por columna**: en **prosa de test**, no en código de test.
- **La causa**: son **6 `it`** (no 5), cada uno con **mutante nombrado + falso-KILLED escrito + control
  positivo o negativo**, que es lo que `CD-W0-6` exige. A ~35 líneas de código y ~35 de prosa por `it`,
  6 `it` son ~420, más ~100 de fixtures sintéticos y del recolector de W0-4.
- **La pregunta que decide** (regla 3 del §11 del work-item): *¿qué parte de esto seguiría existiendo si
  lo escribiera alguien que ya conoce este repo?* **Los mutantes y los controles, sí** — son
  exactamente lo que evita los falsos KILLED que ya mordieron dos veces. **La prosa que re-explica el
  Δ0, no** — se cita a `flow.tsx:44` y se sigue.
- ⚠️ **Si al cerrar W0 el diff supera 2x el techo del work-item (>800), se justifica por escrito
  diciendo en cuál columna está, o se recorta** (regla 4).

---

## §11 · Observaciones medidas que no son de esta ola, y no se van en silencio

| # | Observación | Evidencia | Qué hago |
|---|---|---|---|
| **OBS-1** | `chaski-v3/src/presentation/bitacora-de-vuelta.ts:176` afirma que `flow.tsx` lleva marcadores de censo *«en ocho archivos»*. **Medido hoy: son SEIS** | `/usr/bin/grep -rl "\[\[CENSO src/presentation/flow.tsx"` ⇒ 6 archivos `@c1bd8d3` | ⛔ **No se arregla en W0** (sería tocar producción, `CD-W0-1`). Se declara. Candidato a arreglo en W1, donde ya se toca esa vecindad |
| **OBS-2** | El TTL de la sesión (30 min) el propio repo lo declara *«una hipótesis sobre cuánto tarda el recorrido, no una medición»* | `sesion-de-posesion.ts:43-45` `@c1bd8d3` | Es `MI-5`/`L-6`. **Medición de teléfono, W3.** ⛔ *"No se pudo medir"* no es *"alcanza"* |
| **OBS-3** | El instrumento `viajesALaBilletera` **no cubre Solflare** (`solflare.com`) | `BASE`, `protocol.ts:54-57` vs. `HOST_DE_LA_BILLETERA` derivado de `phantomBrowseUrl` | Lo **declara W0-0**, aserción 3. Todo número de W0 vale para Phantom |
| **OBS-4** | `flow.tsx:807` declara textual que la falta de salida barata desde `connect` *«Queda como defecto ABIERTO y sin candado»* | `[HEREDADO]` de B-7 del work-item | Es **AC-3**, y lo cierra **W1**. Se nombra para que no se pierda |
| **OBS-5** | 🔴 `it("T-372-W3-8: …")` —el único candado escrito de `DT-5`— **no renderiza ninguna capa de presentación**: su arné maneja los casos de uso directo | `recorridoInyectado`, `chaski-v3/src/presentation/sesion-borra-la-segunda-firma.test.tsx:249`; `RemittanceFlow` ⇒ **0 hits** en el archivo `@c1bd8d3` | ⛔ No se arregla en W0 (`CD-W0-1`). Es **`CD-W0-7`**, obligación de W1. §4.6 |

---

## §12 · Missing Inputs — cerrados y abiertos

| # | Qué | Estado tras este SDD |
|---|---|---|
| **MI-1** | `DT-1` | 🟢 **CERRADO**: opción B, §3, con `RET-1`/`RET-2`/`RET-3` |
| **MI-2** | `DT-5` | 🟢 **CERRADO**: §4. Disco del servidor sí (con S-1/S-2/S-3), del navegador nunca, la sesión no se persiste |
| **MI-3** | W4 de WKH-372 (la firma de patrocinio) | 🟡 **ABIERTO — decisión de riesgo del FOUNDER, y no la toma este SDD.** Hasta entonces el objetivo publicable es **3 salidas** (AC-9b, `CD-W0-14`) |
| **MI-4** | El plegado 8→5 (`DT-7`) | 🟡 **DIFERIDO al SDD de W1**, como corresponde a `DT-8`. Lo aprobado por el founder es **el número**, no el mapeo |
| **MI-5** | ¿30 min de TTL alcanzan? (`L-6`) | 🟡 **ABIERTO**: `OBS-2`. Medición de teléfono, W3 |
| **MI-6** | Nombre de rama y estado de `origin/main` de `chaski-v3` | 🟢 **CERRADO, medido**: `main` = `origin/main` = `c1bd8d3`, árbol limpio ⇒ **W3 de WKH-372 SÍ está pusheado**. Rama propuesta: `feat/234-recorrido-de-la-dapp-de-cero` — **no existe hoy** (verificado con `git branch -a`), o sea que está libre |
| **MI-7** | El ID `WKH-374` | 🟢 **CERRADO**: la fila **234 / WKH-374 ya existe** en `wasiai-a2a/doc/sdd/_INDEX.md:226` `[MEDIDO]`. ⇒ el guardián `test/sdd-index-matches-folders.test.ts` no se pone rojo |
| **MI-8** | ¿El `localStorage` cruza al navegador de la billetera? (`L-4`) | 🟡 **ABIERTO por diseño**: `W0-6`, medición de teléfono con dueño |
| **MI-9** | La forma exacta de la tabla del borrador (DDL) | 🟡 **`[TBD en el SDD de W2]`**. El **criterio** está cerrado en §5.7 |
| **MI-10** | ¿Se sostiene el techo de prosa ≤45 % contra el 53,0 % medido de la casa? | 🟡 **`[TBD en el SDD de W1]`**, con el número re-derivado de §10.1 |

⛔ **Ningún `[NEEDS CLARIFICATION]` queda sin marcar.** Los tres del work-item (`DT-1`, `DT-4`, `DT-5`)
están cerrados; los que quedan son diferimientos a olas posteriores o decisiones del founder,
**nombrados con dueño**.

---

## §13 · Desviaciones que necesitan el ok del humano en `SPEC_APPROVED`

| # | Desviación | Motivo |
|---|---|---|
| **D-1** | **W0 pasa de 6 a 8 mediciones** (agrega `W0-0` y `W0-7`), y **reformula `W0-3`, `W0-4` y `W0-5`** | Tres de las seis del work-item, tal como estaban escritas, **no pueden fallar** o **no tienen sujeto**. Está detallado en §7.0 |
| **D-2** | **`W0-5` NO mide AC-13**, y se dice con esas palabras | La bandera del recorrido nuevo no existe en W0 (0 líneas de producción). AC-13 se mide en W1 |
| **D-3** | **Presupuesto de test 520 en vez de 400** (1,3x), todo el exceso en prosa de test | §10.3 |
| **D-4** | **`DT-6` elige DOS proveedores, no uno** | Son dos problemas distintos y el repo ya tiene el molde de cada uno (§6). Ninguno es un estreno |
| **D-5** | **`DT-1` agrega `RET-1`**, un candado de no-duplicación **activo desde W1**, no sólo una condición de retiro | Es lo que vuelve **inalcanzable** el modo de falla de `R-1` para el camino del dinero (§3.4) |

---

## §14 · Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | `DT-1` resuelto, con razón medida y condición de retiro | 🟢 §3 — opción B; 21 marcadores medidos; `RET-1/2/3` |
| 2 | `DT-4` resuelto (la circularidad desatada) | 🟢 §5 — el vale no autentica, transporta; los 4 pasos sin círculo |
| 3 | `DT-5` resuelto, con foco de AR declarado | 🟢 §4 — servidor sí / navegador nunca; `CD-W0-7`; BLOQUEANTE por adelantado en §4.7 |
| 4 | `DT-6` resuelto sin estrenar proveedor | 🟢 §6 |
| 5 | W0 diseñada al detalle: archivo, `it`, aserciones, mutante, falso-KILLED | 🟢 §7.2-7.8 |
| 6 | Cada test con su **mutante nombrado** | 🟢 M-0 … M-7 |
| 7 | Cada test con su **falso KILLED a evitar** | 🟢 §7.2, §7.3, §7.4, §7.5 |
| 8 | **Ningún guard se lee a sí mismo** | 🟢 `CD-W0-5` + exclusión por ruta exacta (E-5) en W0-3(b) y W0-4 |
| 9 | Exemplars **verificados** (abiertos en esta sesión) | 🟢 §8 — 12 exemplars, todos con `sed`/`grep` |
| 10 | Citas a tests **por nombre del `it` + archivo**, número anclado a un commit | 🟢 `CD-W0-8`; commit `c1bd8d3` en todas |
| 11 | Presupuesto **con prosa separada del código**, y el denominador re-derivado | 🟢 §10; casa = **53,0 %** medido, no ~50 % heredado |
| 12 | Exceso de presupuesto **declarado por escrito, con su columna** | 🟢 §10.3 — 1,3x, todo en prosa de test |
| 13 | Constraints heredadas del work-item presentes | 🟢 §9 — `CD-1..CD-14` vigentes + `CD-W0-1..14` |
| 14 | El gate del repo **nombrado correctamente** | 🟢 `npm run qa` → `npm run build`, verificado en `package.json:20` `@c1bd8d3`. ⛔ Prohibido `npx` suelto |
| 15 | Cero líneas de producción, cero líneas en `wasiai-a2a/src/` | 🟢 `CD-W0-1`, `CD-3`, AC-15 |
| 16 | Auto-Blindaje histórico leído y heredado a los CD | 🟢 `auto-blindaje.md` de la 233 (1148 líneas, lecciones **A..Z**) ⇒ `CD-W0-5/6/8/10/11` |
| 17 | `[NEEDS CLARIFICATION]` sin marcar | 🟢 **Ninguno.** §12 |
| 18 | Desviaciones que necesitan el ok humano, listadas | 🟢 §13 — D-1..D-5 |
| 19 | El estado de `origin/main` verificado antes de la primera línea | 🟢 `c1bd8d3` = `main` = `origin/main`, árbol limpio |
| 20 | La fila del `_INDEX.md` existe (guardián `sdd-index-matches-folders`) | 🟢 `_INDEX.md:226` |

**Veredicto: LISTO PARA `SPEC_APPROVED`**, con las cinco desviaciones de §13 a la vista del humano.

---

*SDD de la ola W0 · WKH-374 · escrito por `nexus-architect` el 2026-09-01 · árbol de referencia
`chaski-v3@c1bd8d3` · ⛔ cero líneas de producción escritas en esta fase.*
