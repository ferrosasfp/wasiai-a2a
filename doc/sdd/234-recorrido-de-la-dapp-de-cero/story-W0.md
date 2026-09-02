# Story File · [WKH-374] · **OLA W0** — La puerta de la HU: ocho mediciones, cero líneas de producción

> **Este documento es autocontenido. El Dev NO lee el SDD.** Todo lo que hace falta para ejecutar W0
> está acá: los archivos exactos, los `it` con su nombre, el mutante nombrado de cada uno, el falso
> KILLED a evitar, el gate, el presupuesto **por columna**, y la definición de terminado.
>
> **Repo donde vive el trabajo:** `/home/ferdev/.openclaw/workspace/chaski-v3` — **y sólo ése**.
> **Repo ancla de los artefactos:** `wasiai-a2a` (`doc/sdd/234-recorrido-de-la-dapp-de-cero/`).
> ⛔ **De `wasiai-a2a` no se toca una sola línea de `src/`.**
>
> **Rama:** `feat/234-recorrido-de-la-dapp-de-cero`
> *(verificada como INEXISTENTE hoy: `/usr/bin/git rev-parse --verify feat/234-recorrido-de-la-dapp-de-cero`
> devuelve `fatal: Needed a single revision`. El nombre está libre.)*
>
> **Fecha:** 2026-09-01 · **Modo:** QUALITY · **Gate `SPEC_APPROVED`: OTORGADO**
> **Base:** `chaski-v3@c1bd8d3c5b490205f8aae1f8e999a9871d0fc762`, `main` = `origin/main`, árbol limpio
> (`/usr/bin/git status --porcelain` vacío, re-verificado hoy al escribir este documento).

---

## 🔴 §0 · LEER ESTO ANTES QUE NADA: **W0 es una PUERTA, no una wave**

W0 no construye nada. W0 **mide si el diseño de la HU se apoya en algo verdadero**. Por eso la regla
que gobierna todo el documento es ésta, y va con estas palabras:

> ### ⛔ SI UNA MEDICIÓN BLOQUEANTE SALE ROJA, **LA HU SE DETIENE Y SE REPORTA**. NO SE ARREGLA.
>
> No se ajusta el fixture hasta el verde. No se afloja la aserción. No se pasa a W1 «con una nota».
> Se para, se pega **la salida textual del rojo**, se dice **cuál aserción lo produjo**, y se escala
> al humano. *(En WKH-372 esta misma clase de wave evitó dos veces construir sobre algo falso.)*

**La tabla de qué pone ROJA la ola 0** — es la §2. Leela antes de escribir la primera línea.

---

## §1 · Antes de escribir una línea

### 1.1 · Las citas se re-derivan

⚠️ Todas las citas `archivo:línea` de este documento se derivaron **hoy**, sobre `c1bd8d3`, con
`/usr/bin/grep -n`, `sed -n 'Np'` y `/usr/bin/wc -l`. Si algo mergea sobre `chaski-v3` entre este
documento y tu primer commit, **re-derivá las citas de §4 antes de editar**.

⚠️ **Las citas a un test van POR NOMBRE del `it` (o del `describe`) y SIEMPRE CON SU ARCHIVO.** El
nombre **no es único**: `T-CABLE-1` y `T-CABLE-2` existen en **dos** suites a la vez —
`src/composition/container.test.ts` y `src/presentation/wallet-availability.test.tsx:128` / `:146` —
midiendo cosas distintas. **En WKH-372 se rompieron 7 citas por escribirlas sólo por número**, y
**ninguna herramienta las vigila**: `citas-ancladas.test.ts` sólo mira dentro de `chaski-v3` y estos
documentos viven en `wasiai-a2a`.

### 1.2 · 🔴 Cinco correcciones medidas HOY que cambian lo que decía el SDD

Se miden acá porque de cada una cuelga una tarea o un número. **Ninguna cambia el objetivo de la ola;
las cinco cambian lo que hay que escribir o cómo hay que correrlo.**

| # | Lo que decía el documento anterior | Lo medido hoy sobre `c1bd8d3` | Consecuencia |
|---|---|---|---|
| **C-1** | El SDD lista **3 archivos tocados** y `Archivos tocados ≤ 3` | 🔴 **Son 5.** W0 agrega **2** archivos `*.test.*` bajo `src/`, y `src/composition/readme-test-count.test.ts` compara ese conteo contra **los DOS README** (`README.md:436` = `**172 test files**`, `README.es.md:462` = `**172 archivos de test**`). Conteo real hoy: **172**. Con W0: **174** | Los dos README **entran al Scope IN** (§3.1) y el rojo del guard es **esperado y correcto**, no una regresión. **El número nuevo se deriva CORRIENDO el candado, nunca contando a mano** |
| **C-2** | `W0-1` afirma que *«`caminoPorEnlace()` no es `null`»* | 🔴 **`caminoPorEnlace` es `private`** (`src/infrastructure/solana-wallet.ts:2239`). **No se puede llamar desde un test** | El observable es **`pop.respuestas` del `PopDelAdaptadorReal`** (`src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx:294`), que anota qué contestó `pedir()`. **`["no-corresponde"]` = camino inyectado.** Ver §6.3 |
| **C-3** | `W0-1` exige que *«el desenlace se alcanzó»* en el camino por enlace | 🔴 **Un envío por enlace NO cierra en una sola pasada, y no es un defecto: es lo que el camino ES.** El propio repo lo declara: el mutante de `it("T-372-W1-12: …")` (`recorrido-en-el-navegador-de-la-billetera.test.tsx:565`) dice textual que con `pop` contestando `hay-que-salir` *«el envío **suspende** y la reanudación vuelve a llamar `prepare()`»* | El desenlace se parte en **dos tramos**, cada uno con su propio desenlace afirmable. **⛔ No se afloja la aserción del desenlace: se dice de cuál tramo es.** Ver §6.3, y el 🔴 de §6.3.4 |
| **C-4** | `W0-5` describe `T-065-21` como que compara el `innerHTML` con `toBe(apagada)` | 🔴 **Ese `toBe(apagada)` NO EXISTE.** `/usr/bin/grep -n "apagada" src/presentation/wallet-availability.test.tsx` ⇒ el archivo lo menciona en `:1044`, `:1047`, `:1048`, `:1063` y `:1066`, y la **única** aserción es `.not.toBe(apagada)` en **`:1066`**. Su propio comentario en `:1063` cita *«el `toBe(apagada)` de arriba»*, que **no está en el archivo** | La *«byte-identidad»* del nombre de ese `it` es **un nombre, no una aserción**. Lo que realmente afirma: (a) `apagada` es truthy, (b) el selector **no** está en el DOM con la bandera apagada, (c) `prendida !== apagada`. **W1 tiene que saberlo antes de copiar el molde** |
| **C-5** | El presupuesto pone *«Prosa dentro de los tests ≤ 55 %»*, comparando contra *«los módulos nuevos de la casa (71-78 %)»* | 🔴 **Ésos son módulos de PRODUCCIÓN.** Medida la prosa de los **tests** de la casa hoy: `recorrido-en-el-navegador-de-la-billetera.test.tsx` **28,6 %**, `sesion-borra-la-segunda-firma.test.tsx` **27,9 %**, `citas-ancladas.test.ts` **42,1 %**, `vuelta-por-enlace-carrera.test.tsx` **42,8 %** ⛔ **CORREGIDO EL 2026-09-01 (`BLQ-MED-2` DEL CR): la conclusión de esta fila era FALSA.** Decía que un techo del 55 % *«está 12 puntos por encima del test más prosaico del repo ⇒ no puede binderar»* y fijaba un *«número operativo de 42,8 %»*. Los cuatro números reproducen; **el cuantificador no**: salían de cuatro archivos a mano. Barrido el árbol con el mismo contador, **el máximo es 65,0 %** y **26 de 174** archivos superan 42,8 % ⇒ el techo del 55 % **sí bindea** y el *«número operativo»* queda **RETIRADO**. **La versión válida vive en `w0-report.md` §7.2**, con el contador publicado. Ver §9 |

### 1.3 · Los números de los que cuelga la ola, todos verificados hoy sobre `c1bd8d3`

| Hecho | Cómo se verificó | Valor |
|---|---|---|
| `wc -l src/presentation/flow.tsx` | `/usr/bin/wc -l` | **4453** |
| Marcadores `[[CENSO src/presentation/flow.tsx lineas=4453]]` | `/usr/bin/grep -rno` sobre `src/ app/ scripts/ contracts/` | **8 sitios** |
| Marcadores `[[CENSO src/presentation/flow.tsx entrantes=165]]` | ídem | **12 sitios** |
| Marcadores `[[CENSO src/presentation/flow.tsx destinos=96]]` | ídem | **1 sitio** (`flow.tsx:44`) |
| Archivos distintos que llevan marcadores de `flow.tsx` | `/usr/bin/grep -rl` | **6**: `src/application/use-cases/confirm-and-send.ts`, `src/presentation/flow.tsx`, `src/presentation/flow-vm.ts`, `src/presentation/flow-vm.test.ts`, `src/presentation/diagnostico-de-vuelta.tsx`, `app/page.tsx` |
| Líneas exactas de esos marcadores | `/usr/bin/grep -n` | `confirm-and-send.ts:463` · `flow.tsx:44,75,76,146,626,963,1351` · `flow-vm.ts:1522` · `flow-vm.test.ts:2532` · `diagnostico-de-vuelta.tsx:115` · `app/page.tsx:23,24` |
| Archivos de test del repo | `find` sobre `src app contracts scripts` con `/\.(test\|spec)\.(c\|m)?[jt]sx?$/` | **172** |
| El gate | `package.json:20` | `qa` = `lint && typecheck && typecheck:scripts && test` |
| El build | `package.json:10` | `build` = `next build --webpack` |
| Qué lintea | `package.json:12` | `lint` = `biome lint src app scripts` |
| Router de cliente en `src/` + `app/` | `/usr/bin/grep -rn "useRouter\|router\.push\|router\.replace\|next/navigation" src/ app/` | 🔴 **UNA sola línea en todo el repo**: `app/kyc-simulado/page.tsx:26` (`import { notFound } from "next/navigation"`). **Cero `useRouter`, cero `router.push`, cero `router.replace`** |
| `viajesALaBilletera` se ejercitó… | `/usr/bin/grep -n "viajesALaBilletera"` en su archivo | …en **3 sitios** (`:395`, `:737`, `:763`) y **los tres asertan `.toEqual([])`** ⇒ **el instrumento nunca contestó que SÍ** |

⛔ **Al cerrar, los marcadores `[[CENSO …]]` y el conteo de los README se re-derivan CORRIENDO, nunca
contando a mano** (§6.9).

---

## 🔴 §2 · LA TABLA DE QUÉ PONE **ROJA** LA OLA 0

**Cinco de las ocho mediciones son BLOQUEANTES.** Si cualquiera sale roja: **la HU se detiene y se
reporta**. No se arregla en esta ola.

| # | Qué mide | ¿Bloqueante? | **Qué la pone ROJA** | Si sale roja |
|---|---|:---:|---|---|
| **W0-0** | El instrumento `viajesALaBilletera` sabe contestar **que SÍ** | 🔴 **SÍ** | Que el hostname de `urlConectar({billetera:"phantom"})` **no** coincida con `HOST_DE_LA_BILLETERA`; o que el filtro devuelva **de más** (algo que no es de la billetera) | **El instrumento no sirve** ⇒ ⛔ **ningún número de W0-1/W0-2 es publicable.** Se detiene la ola |
| **W0-1** | Cuántas **travesías** de la pantalla de entrada tiene el camino por enlace | 🔴 **SÍ** | Que el tramo medido **no alcance su desenlace declarado**; o que el conteo **no sea reproducible** entre dos corridas del mismo `it` | Se detiene: **no hay línea de base** contra la que W1/W3 puedan comparar |
| **W0-2** | Cuántos **viajes a la billetera** tiene ese mismo recorrido | 🔴 **SÍ** | Que `viajesALaBilletera(espia.asignado)` dé **`[]`** en el camino por enlace ⇒ **falso verde por vacío** | Ídem. *(Ésta es la que W0-0 vuelve creíble.)* |
| **W0-3** | **`L-5`**: el salto por enlace **remonta el árbol de React** | 🔴 **SÍ** | Que la sesión **sobreviva** al salto; **o** que aparezca un router de cliente en `src/`+`app/`; **o** que el control positivo **no sepa distinguir** (`peek` que no devuelve el token sembrado) | 🔴 **El §2 entero del work-item cambia de forma**: si el `singleton` sobrevive, la sesión cruza, `DT-3` deja de ser necesario y el vale sobra. **Vuelve a F1/F2** |
| **W0-4** | El **costo del camino contrario**: qué cuesta una cita anclada nueva hacia `flow.tsx` | 🔴 **SÍ** | Que los conteos que el `it` deriva (**12 / 8 / 1** y los **6** archivos) **no coincidan** con lo que los marcadores declaran (aserción 4, la de calibración) | **El instrumento está mal, o el árbol se movió** ⇒ re-derivar todo §1.3 antes de seguir |
| **W0-5** | Que el instrumento de **AC-13 discrimina** — ⛔ **NO mide AC-13** | 🟡 No | Que el mutante **M-7** **no** ponga rojo a `it("T-065-21: …")` | El instrumento de AC-13 **no discrimina** ⇒ **W1 necesita otro**, y se dice así en el reporte. No detiene W0 |
| **W0-6** | **`L-4`**: si el `localStorage` cruza al navegador de la billetera | ⬜ No | — **no es medible en `jsdom`** | Se declara **con dueño y fecha** (W3, founder, teléfono). ⛔ *«No se pudo medir»* **NO es** *«no cruza»* |
| **W0-7** | La **línea de base del flake** preexistente | ⬜ No | — | Se publica la tasa `k/20` con su commit. ⛔ **No se pone en cuarentena** |

### 2.1 · 🔴 `W0-5` NO MIDE `AC-13`, y va escrito con estas palabras

Copiá esta frase, textual, al reporte de W0:

> **«AC-13 NO se midió en W0: la bandera `NEXT_PUBLIC_CHASKI_RECORRIDO_V2` no existe, porque W0
> escribe cero líneas de producción. Lo que W0-5 midió es que el instrumento que W1 va a reusar
> **discrimina**, con su mutante M-7 nombrado. AC-13 se mide en W1.»**

**El motivo, en una línea**: no se puede medir la inercia de una bandera que no existe. Decir que se
midió sería una afirmación **sin sujeto**.

---

## §3 · Scope — la lista exhaustiva de archivos

### 3.1 · Scope IN (todo bajo `/home/ferdev/.openclaw/workspace/chaski-v3`)

| | Archivo | Nuevo / Extiende | Qué lleva |
|---|---|---|---|
| **A** | `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | **EXTIENDE** (768 líneas hoy) | `W0-0`, `W0-1`, `W0-2` |
| **B** | `src/composition/costo-de-una-cita-anclada.test.ts` (⛔ el story file lo planificó como `el-arbol-propio-cuesta-cero-citas.test.ts`; **renombrado por el `MNR-3` del CR**: ese nombre era el de la medición que este mismo archivo declara abandonada) | **NUEVO** (no existe: verificado con `ls`) | `W0-4` |
| **C** | `src/presentation/el-salto-remonta-el-arbol.test.tsx` | **NUEVO** (no existe: verificado con `ls`) | `W0-3` |
| **D** | `README.md` | **1 línea** (`:436`) | El conteo `172` → `174`. Forzado por **C-1** |
| **E** | `README.es.md` | **1 línea** (`:462`) | Ídem, **por separado y a propósito** |

⛔ **`W0-5`, `W0-6` y `W0-7` escriben CERO líneas.** Son una corrida de mutante, una declaración con
dueño, y una corrida de repetición. **Eso es deliberado, no un atajo.**

**Por qué A se EXTIENDE y no se crea uno nuevo al lado**: ese archivo ya tiene todo el arnés —
`inyectarWallet` (`:115`), `entrarAlNavegadorDeLaBilletera` (`:149`), `HOST_DE_LA_BILLETERA` (`:169`),
`espiarNavegacion` (`:175`), `viajesALaBilletera` (`:208`), `sembrarElCaminoPorEnlace` (`:226`),
`sembrarCotizada` (`:262`), `armarEnvio` (`:274`), `PopDelAdaptadorReal` (`:294`), `cargarYEnviar`
(`:688`). Escribir un contador al lado sería **un segundo sitio de verdad** más ~200 líneas de arnés
duplicado.

⚠️ **Consecuencia de extender, y no te la saltees**: A pasa de 768 a ~950 líneas, y **toda cita `:NN`
hacia A que exista en el árbol se corre si insertás arriba**.
⇒ 🔴 **LOS `it` NUEVOS VAN AL FINAL DEL ARCHIVO**, y las citas se re-derivan con `/usr/bin/grep -n`
**después de la última edición**.

### 3.2 · Scope OUT — tocarlos es **BLOQUEANTE en AR**

| Archivo / carpeta | Por qué |
|---|---|
| 🔴 `src/presentation/flow.tsx` | **Δ0 = 0. Ni una línea, ni un carácter.** Los **8** marcadores `lineas=4453` son el candado. *(Excepción única y temporal: el mutante **M-7** de W0-5, que se aplica, se corre y se restaura **en la misma tarea** — ver §6.7 y `CD-W0-10`.)* |
| 🔴 `src/infrastructure/solana-wallet.ts` | Lleva marcadores `[[CENSO … entrantes]]` propios y la HU `071` de `chaski-v3` lo está tocando. *(Excepción única: el mutante **M-0** de W0-0 vive en `protocol.ts`, no acá.)* |
| ⛔ **Cualquier archivo bajo `src/`, `app/`, `supabase/`, `contracts/` que NO sea `*.test.ts(x)`** | `CD-W0-1`: **cero líneas de producción** |
| ⛔ `src/presentation/recorrido/**` | La carpeta **no existe** y **W0 no la crea**. Es de W1 |
| ⛔ `wasiai-a2a/src/**` | Cero líneas. `CD-3`, AC-15 |
| ⛔ `wasiai-a2a/doc/sdd/_INDEX.md` **por encima de la línea 144** | `CD-W0-13`. La fila 234 **ya existe** en `:226` y **no hay que crearla** |
| ⛔ `src/presentation/vuelta-por-enlace-carrera.test.tsx` | Se **mide** (W0-7). ⛔ **No se pone en cuarentena, no se le toca un `it`, no se le agrega un `skip`** |

---

## §4 · Anti-Hallucination Checklist — específica de esta ola

**Todo lo de esta sección se abrió hoy con `sed`/`grep`. Ninguna ruta es recordada.** Si vas a usar un
símbolo que no está acá, **derivalo antes**.

### 4.1 · El arnés del archivo **A** — lo que ya existe y NO se reescribe

```
src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx  @c1bd8d3
:115  function inyectarWallet(): void
:149  async function entrarAlNavegadorDeLaBilletera(inyectar = true, esperaMs = 1200): Promise<string>
:169  const HOST_DE_LA_BILLETERA = new URL(phantomBrowseUrl("https://chaski.test/", "https://chaski.test")).hostname
:175  function espiarNavegacion(): { asignado: string[]; restaurar: () => void }
:208  function viajesALaBilletera(asignado: string[]): string[]
:226  function sembrarElCaminoPorEnlace(): void
:262  async function sembrarCotizada(repo: InMemoryRepo): Promise<string>
:274  function armarEnvio(p: {...}): ConfirmAndSend
:294  class PopDelAdaptadorReal implements PruebaDePosesionPorEnlace   // .respuestas: string[]  (:295)
:688  async function cargarYEnviar(container): Promise<void>          // renderiza <RemittanceFlow/>
```

- ⛔ **La disponibilidad se LEE del árbol, nunca se setea a mano.** El patrón es
  `it("T-CABLE-2: celular DENTRO del navegador de Phantom ⇒ 'injected' …")`,
  `src/presentation/wallet-availability.test.tsx:146` `@c1bd8d3`. Un `setWalletAvailability("none")`
  escrito a mano probaría que sabés escribir un string.
- ✅ **`entrarAlNavegadorDeLaBilletera(false, 1700)` devuelve `"none"`** — verificado: es exactamente
  lo que hace `it("T-372-W1-11: …")` en `:661` del mismo archivo, con el mensaje de aserción
  *«el árbol no llegó a `none`: no se está midiendo el navegador común»*.
- ⚠️ **`armarEnvio(...)` NO renderiza React**: arma un `ConfirmAndSend` real y lo corre.
  **`cargarYEnviar(...)` SÍ renderiza `<RemittanceFlow/>`.** Son dos instrumentos distintos y miden
  cosas distintas. Las travesías de pantalla necesitan el **segundo**.

### 4.2 · `phantomBrowseUrl` y `urlConectar` — los dos productores de host

```
src/presentation/wallet-availability.ts:26
  export function phantomBrowseUrl(href: string, origin: string): string
  → `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`   (:27)

src/infrastructure/solana/deeplink/protocol.ts
  :54-57  const BASE: Record<BilleteraDeeplink, string> = {
            phantom:  "https://phantom.app/ul/v1",
            solflare: "https://solflare.com/ul/v1",
          };
  :44     export type BilleteraDeeplink = "phantom" | "solflare";
  :135    export interface DatosDelPedido { billetera; appUrl: string; redirectLink: string }
  :149    export function urlConectar(
            d: DatosDelPedido & { clavePublicaDeLaApp: Uint8Array; cluster: string },
          ): string    → `${BASE[d.billetera]}/connect?${q.toString()}`
```

🔴 **Medido: los dos hostnames coinciden en `phantom.app` y NO coinciden en `solflare.com`.**
⇒ el filtro de hoy **cubre Phantom por enlace profundo** y **no cubre Solflare**. Eso es lo que W0-0
convierte en aserción, incluida la tercera, que **declara el agujero**.

### 4.3 · El almacén y el contenedor (archivo **C**, W0-3)

```
src/composition/container.ts  @c1bd8d3
  :96   export function createContainer(): Container
  :106  const popProofs = new InMemoryPopProofStore(clock); const sesiones = new InMemorySesionStore(clock);
  :263  let singleton: Container | null = null;
  :265  export function getContainer(): Container
  :266    if (!singleton) singleton = createContainer();

src/infrastructure/auth/sesion-store.ts  @c1bd8d3   (135 líneas)
  :73   const SESION_STORE_TTL_MS = 28 * 60 * 1000;
  :80   export class InMemorySesionStore implements SesionReader, SesionRecorder
        constructor(private readonly clock: Clock)      // Clock = { nowIso(): string }
        record(address: string, token: string): void
  :121  peek(address: string): string | null
```

⚠️ **`sesiones` NO está expuesto en el tipo `Container`.** Es una variable local de `createContainer`
(`:106`), inyectada a los gateways (`:161`, `:185`). ⇒ **la pata (a) de W0-3 compara identidad de
contenedores**, no de almacenes: `getContainer() === getContainer()` y
`createContainer() !== createContainer()`. **Si necesitás el almacén, se instancia uno propio**
(`new InMemorySesionStore(reloj)`), que es lo que hace la pata (c).

⚠️ `createContainer()` corre `assertNoEvmResidue()` como **primera** línea (`:100-101`) y construye la
wallet real. Si tira bajo `jsdom`, **eso no es un hallazgo de W0-3: es el entorno** — medilo antes de
reportarlo *(lección **J**: bajo `jsdom`, `Buffer.from(x) instanceof Uint8Array` es `false`, y eso ya
estuvo a un paso de reportarse como «la premisa de la ola es falsa»)*.

### 4.4 · El candado de citas y sus regex (archivo **B**, W0-4)

```
src/composition/citas-ancladas.test.ts  @c1bd8d3   (437 líneas)
  :46   import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
  :51   const SCAN_DIRS = ["src", "app", "scripts", "contracts"];
  :56   const SELF = path.resolve(ROOT, "src/composition/citas-ancladas.test.ts");
  :64     ... && path.resolve(full) !== SELF          ← 🎯 LA EXCLUSIÓN POR RUTA EXACTA
  :74   const ANCLADA = /`([A-Za-z_$][\w$.]*)`,\s*`([\w./-]*?):(\d+)(?:-\d+)?`/g;
  :331  const CENSO = /\[\[CENSO ([\w./-]+) (lineas|entrantes|destinos)(?:-desde-(\d+))?=(\d+)\]\]/g;
  :371    if (mk.campo === "lineas") return readFileSync(abs, "utf8").split("\n").length - 1;
  :402  it("cada marcador `[[CENSO …]]` dice el número que el árbol tiene hoy")
  :411  it("CALIBRACIÓN: con el número corrido en uno, el candado los reporta a todos")
  :423  it("CALIBRACIÓN: un marcador que apunta a un archivo que no existe se reporta")
```

🔴 **Leé el regex `ANCLADA` de `:74` y copiá su forma exacta.** Una cita **anclada** es
`` `simbolo`, `ruta:NN` `` — **el símbolo entre backticks, LA COMA, y la ruta:línea entre backticks**.
Sin la coma es una cita **suelta** y **no la cuenta nadie**. Ésa es la aserción 3 de W0-4.

⛔ **NO importes `citas-ancladas.test.ts` desde el archivo B.** Importar un `.test.ts` **corre sus
`describe`** y los duplica en el reporte. Se **re-implementa** el regex en B, **con su cita al lado**,
y se **calibra** contra el árbol (aserción 4).

### 4.5 · El instrumento de AC-13 (W0-5) — y la corrección **C-4**

```
src/presentation/wallet-availability.test.tsx  @c1bd8d3   (1945 líneas)
  :1034-1036  el docblock que YA NOMBRA el mutante M-7, textual:
              «en `flow.tsx`, en el JSX del paso `connect`, borrar el gate `mostrarSelectorDeEnlace ?`
               del selector ⇒ el selector aparece con la bandera apagada»
  :1037  it("T-065-21: con la bandera APAGADA el paso `connect` es byte-idéntico al de hoy")
  :1044    const apagada = ... innerHTML
  :1048    expect(apagada, "no se llegó a renderizar el paso `connect`").toBeTruthy()     ← CD-18
  :1049    expect(screen.queryByText(SELECTOR), "el selector apareció con la bandera APAGADA").not.toBeInTheDocument()
  :1066    expect(prendida, "...").not.toBe(apagada)         ← 🎯 LA ÚNICA comparación de innerHTML
  :1076  it("T-065-21b: con la bandera PRENDIDA y una wallet inyectada, el selector NO aparece")
```

🔴 **No existe ningún `toBe(apagada)`** (corrección **C-4**). El comentario de `:1063` lo cita y está
**desactualizado**. **Anotalo en el reporte**: es información que W1 necesita antes de copiar el molde.

⚠️ **Y un footgun de identificación, medido**: el mensaje
`"el selector apareció con la bandera APAGADA"` aparece en **DOS** sitios del mismo archivo —
**`:1049`** (dentro de `T-065-21`) y **`:1195`** (dentro de otro `it`). ⇒ **si identificás el `×` de
M-7 buscando el mensaje, vas a encontrar dos.** 🔴 **El `×` se identifica por el NOMBRE del `it` que
vitest imprime**, no por el texto del assert.

### 4.6 · El único candado escrito de `DT-5`, y lo que NO vigila

```
src/presentation/sesion-borra-la-segunda-firma.test.tsx  @c1bd8d3   (652 líneas)
  :249   async function recorridoInyectado(...)      ← el arnés
  :539   it("T-372-W3-8: tras una recarga (almacén nuevo), la PRIMERA firma se vuelve a pedir y la
          sesión no está en ningún disco")
  :556-565  LAS CUATRO ASERCIONES DE DISCO:  localStorage · sessionStorage · document.cookie · window.location.href
```

🔴 **Medido hoy: `/usr/bin/grep -c "RemittanceFlow"` en ese archivo devuelve `0`.**
⇒ **`T-372-W3-8` no renderiza NINGÚN árbol de React.** Prueba que *el camino del dinero* no deja la
sesión en disco. **Una pantalla —vieja o nueva— que escribiera la sesión en `localStorage` lo dejaría
verde**, porque ese código nunca corre en ese `it`.
⇒ Es **`CD-W0-7`, una obligación de W1**, y W0 **la declara, no la arregla** (tocarlo sería producción).

### 4.7 · El patrón de cita **SIN ancla** hacia `flow.tsx` — copialo textual

`src/presentation/bitacora-de-vuelta.ts:175-177` `@c1bd8d3` ya lo escribió, con su motivo:

> *«Mismo molde que el mapa `OFFERED_METHOD_COPY` de `./flow.tsx` (⛔ esa cita va SIN ancla a
> propósito: `flow.tsx` lleva marcadores `[[CENSO … entrantes]]` en ocho archivos, dos de ellos fuera
> del alcance de esta ola, y anclarla obligaría a editarlos)».*

⚠️ **Y esa frase tiene un número que ENVEJECIÓ**: dice *«en ocho archivos»*; **medido hoy son SEIS**.
⛔ **No lo arregles en W0** — es producción (`CD-W0-1`). **Se declara como `OBS-1` en el reporte**, y
queda como candidato de W1, que sí toca esa vecindad.

---

## §5 · Constraint Directives — copiadas textuales del SDD, todas vigentes

### 5.1 · Las diez duras de esta ola (`CD-W0-1` … `CD-W0-10`)

- 🔴 **`CD-W0-1` · ⛔ CERO LÍNEAS DE PRODUCCIÓN.** W0 escribe **sólo** `src/presentation/*.test.tsx` y
  `src/composition/*.test.ts` (más los dos renglones de README de **C-1**). **Ni una línea en un
  `src/**/*.ts` no-test, ni en `app/`, ni en `supabase/`.** Se verifica con
  `/usr/bin/git diff --numstat` **contra el índice**, no leyendo el diff a ojo.
- 🔴 **`CD-W0-2` · ⛔ `flow.tsx` NO SE TOCA. Δ0 = 0.** Ni una línea, ni un carácter. **Los 8
  marcadores `lineas=4453` son el candado.** Se verifica con `/usr/bin/wc -l`, ⛔ no leyendo el diff.
- 🔴 **`CD-W0-3` · ⛔ NINGUNA CITA ANCLADA NUEVA** hacia `flow.tsx`, `solana-wallet.ts` ni ningún
  archivo con marcadores `[[CENSO … entrantes]]`. **Anclar es ESCRIBIR sobre el archivo destino**: una
  cita anclada nueva a `flow.tsx` pone rojos **12 sitios en 6 archivos**. Las citas van **sueltas, con
  su motivo al lado** (patrón de §4.7).
- 🔴 **`CD-W0-4` · ⛔ PROHIBIDO PUBLICAR `6`, `5` o `7`** copiados de cualquier documento. **Todo
  número de la métrica sale de UNA CORRIDA**, con su etiqueta 🟢/🟡/🔴. Si el número medido no coincide
  con el heredado, **el medido gana y el heredado se declara FALSO, con esas palabras**.
- 🔴 **`CD-W0-5` · ⛔ NINGÚN GUARD PUEDE LEERSE A SÍ MISMO.** Todo barrido de archivos se excluye **por
  RUTA EXACTA** (el patrón `SELF` de `citas-ancladas.test.ts:56`), ⛔ **nunca por glob ni por el sufijo
  `.test.`**. IF un `it` busca un literal en la misma línea donde ese literal aparece, THEN **nunca
  puede fallar** y es **BLOQUEANTE**.
- 🔴 **`CD-W0-6` · ⛔ CADA `it` LLEVA SU MUTANTE NOMBRADO Y SU FALSO-KILLED ESCRITO.** Y al correrlo se
  reporta **cuál aserción produjo el rojo**, citando **archivo · nombre del `it` · por qué murió**.
  **Un `1 failed` sin un `×` nombrado NO ES UN KILLED.**
- 🔴 **`CD-W0-7` · (obligación para W1, decidida en el SDD, declarada acá)** W1 agrega un `it` que
  **monta el árbol nuevo** y le aplica las **cuatro** aserciones de disco de
  `it("T-372-W3-8: …")` (`sesion-borra-la-segunda-firma.test.tsx:556-565`). ⚠️ **Medido: ese `it` no
  renderiza ningún árbol** ⇒ `DT-5` **hoy no tiene candado sobre ninguna pantalla** (§4.6). **W0 lo
  declara; no lo arregla.**
- 🔴 **`CD-W0-8` · ⛔ TODA CITA A UN TEST VA POR EL NOMBRE DEL `it` + SU ARCHIVO**, con el número
  anclado a `@c1bd8d3`. **7 citas se rompieron en WKH-372 por escribirlas sólo por número, y nada las
  vigila entre repos.**
- 🔴 **`CD-W0-9` · ⛔ EL GATE ES `npm run qa` → `npm run build`, ENTERO, EN ORDEN, CONTRA EL ÍNDICE DE
  GIT.** ⛔ **PROHIBIDO `npx biome` y `npx tsc` sueltos**: `npx` baja paquetes inexistentes y su error
  **se lee como fallo del gate**. ⛔ **Correr `vitest` solo NO es correr el gate.** Ver §8.
- 🔴 **`CD-W0-10` · ⛔ TODO MUTANTE SE APLICA POR NÚMERO DE LÍNEA, SE VERIFICA EN DISCO ANTES DE
  CORRER, Y SE RESTAURA CONTRA `git diff --numstat`.** ⛔ **Nunca con un `.orig` cacheado**: en
  WKH-372 un arnés así **revirtió una ola entera en silencio**, y su `md5` **confirmó el revert en vez
  de cazarlo**.

### 5.2 · Las cuatro complementarias (`CD-W0-11` … `CD-W0-14`)

- ⛔ **`CD-W0-11`** · **Los `it` nuevos van AL FINAL de su archivo**, y toda cita `:NN` se **re-deriva
  con `/usr/bin/grep -n` DESPUÉS de la última edición**.
- ⛔ **`CD-W0-12`** · **PROHIBIDO poner en cuarentena `vuelta-por-enlace-carrera.test.tsx`.** Se mide
  (W0-7) y se publica la tasa.
- ⛔ **`CD-W0-13`** · **PROHIBIDO tocar nada por encima de la línea 144 de
  `wasiai-a2a/doc/sdd/_INDEX.md`.** La fila 234 **ya existe** en `:226`.
- ⛔ **`CD-W0-14`** · **Ninguna afirmación de W0 puede decir que «Crear la cuenta» desaparece**, ni que
  las salidas son **2** mientras W4 de WKH-372 no tenga decisión (⇒ el objetivo publicable es **3**).

### 5.3 · Las del Auto-Blindaje — los errores que YA pasaron, transcritos

Salen de `auto-blindaje.md` de WKH-372 (1148 líneas, 47 entradas, 26 lecciones consolidadas **A..Z**).
**No son teoría: son el error que ya se cometió, con la frase de quien lo cometió.**

| Lección | La regla que te aplica en W0 |
|---|---|
| **A** | Un fixture que **no reproduce el defecto** es indistinguible de un guard que funciona. Y un arnés de mutación con `.orig` cacheado **revirtió una ola entera en silencio** ⇒ `CD-W0-10` |
| **C** | **Toda afirmación escrita es falsable y envejece con el commit siguiente**: exclusividades, plurales, enumeraciones con número adelante, y *«hoy es inerte»*. ⇒ cada frase nueva de docblock lleva **el input concreto que la pondría en rojo**; si no existe, se recorta hasta que exista |
| **E** / **F** | Las citas **cruzadas entre repos no las vigila NADA**. Un test se cita **por el nombre de su `it` + su archivo**, con el número anclado a un commit ⇒ `CD-W0-8` |
| **G** / **S** | Un número publicado **se re-mide contra el árbol**, ⛔ nunca sumando deltas (las líneas reemplazadas se cuentan dos veces: 2.857 publicado contra 2.834 re-derivado) |
| **H** | Un `catch` que asigna `false`/`0`/`[]` convierte *«no pude preguntar»* en *«la respuesta es no»*. **Un booleano no tiene dónde poner el tercer valor.** ⇒ W0-6 |
| **J** | **Antes de leer un rojo como hallazgo del sujeto, medí si lo produce el ENTORNO**: bajo `jsdom`, `Buffer.from(x) instanceof Uint8Array` es `false`. La sonda cuesta dos minutos; la conclusión falsa cuesta una ola |
| **K** / **Z** | **Correr las partes de un gate no es correr el gate**: `lint` va primero y es el eslabón al que nadie llega. Y **un mutante puede morir por TDZ y parecer KILLED** |
| **M** | Un guard de existencia que vive en un archivo que **importa** lo que vigila muere por **colapso del resolvedor**, no por aserción ⇒ **no cuenta como KILLED**. Por eso el barrido de W0-3(b) usa **`readFileSync`**, ⛔ no `import` |
| **N** | 🔴 **Un ancla partida por un salto de línea NO entra al conjunto del guard**: el regex exige whitespace. La cita queda **rota y verde, por AUSENCIA**. **47 ocurrencias preexistentes en el árbol** ⇒ el fixture de W0-4 incluye una cita partida y **exige que NO la cuente** |
| **O** / **P** | Una **receta de mutación se corre en su lectura literal ANTES de publicarla**. Si el mutante sobrevive: o la receta está mal, o hay código muerto — **las dos veces el hallazgo es real** |
| **Q** | 🔴 **El desborde de escala de la ola anterior estaba en la PROSA DE PRODUCCIÓN, no en los tests** (61 % contra el **53,0 %** re-derivado de la casa) — **y ahí vivían sus tres bloqueantes.** ⇒ **más prosa es más superficie de afirmación sin testigo.** Ver §9 |
| **T** | *«Tiene que fallar con el código de hoy»* se mide contra **`main`** (con `git stash`), **no contra un mutante propio**: los dos rojos se parecen |
| **U** | 🔴 **Un mutante puede morir por la aserción del INSTRUMENTO y no por la del sujeto** (`expected 3 to be 4`, sin llegar a mirar nada) ⇒ **mirá CUÁL aserción produjo el rojo**. Y un mutante que **SOBREVIVE se reporta como tal** |
| **V** | **Un número de línea sale de un `/usr/bin/grep -n` del símbolo**, ⛔ nunca del rango con el que leíste el archivo, y ⛔ nunca leído **antes de tu propia edición** |
| **X** | **Un Story File puede contradecirse consigo mismo.** Si encontrás una contradicción entre §3.2 y una tarea, **elegí el defecto real por encima del formal, y REGISTRÁ la violación** en vez de justificarla al pasar |

---

## §6 · LAS OCHO MEDICIONES, EN ORDEN

> El orden **es** load-bearing. **`W0-0` va PRIMERO y puede detener la ola entera**: sin calibrar el
> instrumento, los números de W0-1 y W0-2 salen de algo que nunca contestó que sí.

---

### §6.0 · Preparación · **SERIAL** · 0 líneas

- [ ] **T1** — Re-verificar el árbol y crear la rama:
      `/usr/bin/git rev-parse HEAD` (esperado `c1bd8d3c5b490205f8aae1f8e999a9871d0fc762`),
      `/usr/bin/git status --porcelain` **vacío**, y
      `/usr/bin/git checkout -b feat/234-recorrido-de-la-dapp-de-cero`.
      *(El nombre está libre: verificado hoy con `git rev-parse --verify`.)*
- [ ] **T2** — Re-derivar con `/usr/bin/grep -n` **las citas de §4 que vayas a usar**.
      ⛔ **Ninguna cita `archivo:línea` se escribe sin haberla derivado en esta misma sesión.**
- [ ] **T3** — Correr el gate **entero** una vez **antes de tocar nada**, para tener la foto del verde
      de partida (§8). ⚠️ Anotá si `vuelta-por-enlace-carrera.test.tsx` sale rojo ya acá: es el flake,
      y es la primera muestra de W0-7.

---

### 🔴 §6.1 · `W0-0` — **CALIBRAR EL INSTRUMENTO ANTES DE PUBLICAR CUALQUIER NÚMERO** · BLOQUEANTE

**Archivo: A** (al final del archivo, `CD-W0-11`).

#### Por qué existe, y por qué va primero

`viajesALaBilletera` (`:208`) filtra por `hostname === HOST_DE_LA_BILLETERA`, y
`HOST_DE_LA_BILLETERA` (`:169`) sale de `phantomBrowseUrl(...)`, que es el enlace para **abrir Chaski
adentro de Phantom**. El camino por enlace usa **otra familia de URLs**, la de `urlConectar`
(`protocol.ts:149`) sobre `BASE` (`:54-57`).

🔴 **Y el instrumento se ejercitó en 3 sitios (`:395`, `:737`, `:763`) y los TRES asertan
`.toEqual([])`.** ⇒ **nunca contestó que SÍ.**
**Un filtro que siempre devuelve `[]` es indistinguible de «no hubo saltos».**

#### El `it`

```
it("T-374-W0-0: el filtro de viajes reconoce un href de ENLACE PROFUNDO, y declara que solflare queda afuera")
```

**Afirma, en este orden:**

1. `new URL(urlConectar({ billetera: "phantom", … })).hostname === HOST_DE_LA_BILLETERA`.
   🔴 **Los dos lados se LEEN de producción, de dos módulos distintos.**
   ⛔ **El `it` no escribe el literal `"phantom.app"` en ninguna línea** (`CD-W0-5`).
2. `viajesALaBilletera([hrefDeEnlace, hrefDelVerificador, "no-soy-una-url"])` devuelve **exactamente**
   `[hrefDeEnlace]`. 🔴 **Por VALOR, con `.toEqual([...])` — ⛔ nunca `.toHaveLength(1)`.**
3. **Declara el agujero**: `new URL(urlConectar({ billetera: "solflare", … })).hostname` **NO** es
   `HOST_DE_LA_BILLETERA` ⇒ **todo número de W0-1/W0-2 vale para Phantom y NO para Solflare.**

| | |
|---|---|
| **Mutante nombrado** | **M-0** · en `src/infrastructure/solana/deeplink/protocol.ts:55`, cambiar `phantom: "https://phantom.app/ul/v1"` por `"https://phantom.example/ul/v1"` ⇒ **cae la aserción 1** |
| **Falso KILLED a evitar (1)** | Si la aserción 2 dijera sólo `.toHaveLength(1)`, **un filtro que devolviera TODO pasaría igual**. Por eso compara el arreglo **entero, por valor** |
| **Falso KILLED a evitar (2)** | ⚠️ **M-0 también rompe los `it.each` de `T-DL-1/4/5`** en la suite del deeplink (el docblock de `protocol.ts:66` los nombra: *«el host lo miran los `it.each` de `T-DL-1/4/5`»*). ⇒ **el `×` que contás tiene que ser el de `T-374-W0-0`, nombrado.** Un rojo en otro archivo **no es este KILLED** |
| **Guard que no se lee a sí mismo** | Los dos hostnames salen de **producción**; el archivo del `it` **no contiene el literal** |

**Tareas:**
- [ ] **T4** — Escribir `T-374-W0-0` al final de **A**, con las 3 aserciones **en ese orden**.
- [ ] **T5** — Correr **el gate entero** (§8). Verde esperado.
- [ ] **T6** — Aplicar **M-0** por número de línea, **verificar en disco con `sed -n '55p'` ANTES de
      correr**, correr, y **restaurar contra `/usr/bin/git diff --numstat`** (`CD-W0-10`).
      Reportar: **archivo · nombre del `it` · cuál aserción produjo el rojo**.
- [ ] **T7** — 🔴 **Si la aserción 1 sale roja con el árbol SANO** (los hostnames no coinciden):
      **PARAR.** El instrumento no sirve, ningún número es publicable, y se reporta.

---

### 🔴 §6.2 · `W0-1` y `W0-2` — **LOS DOS NÚMEROS DE LA MÉTRICA, DERIVADOS EJECUTANDO** · BLOQUEANTES

**Archivo: A** (al final, después de `T-374-W0-0`).

#### Qué miden

En el **camino por enlace** — bandera prendida, disponibilidad `"none"` **leída del árbol**, elección
sembrada — cuántas **travesías de la pantalla de entrada** y cuántos **viajes a la billetera**.

> **La definición de travesía ya está escrita en el repo** y ⛔ no se re-inventa:
> `recorrido-en-el-navegador-de-la-billetera.test.tsx:680-684` `@c1bd8d3`, textual:
> *«La app arranca cargada una vez (travesía 1) y cada asignación de `window.location.href` se lleva
> la pestaña afuera; la vuelta es una carga nueva, o sea otra travesía ⇒ `travesías = 1 + asignaciones`».*

#### 🔴 6.2.1 · LO PRIMERO QUE TENÉS QUE SABER: **el camino por enlace NO cierra en una sola pasada**

Esto es la corrección **C-3**, y es lo que más te puede hacer perder tiempo si no lo leés ahora.

- En el cuadrante `"none"` con todo sembrado, `pedir()` **no** contesta `"no-corresponde"`: contesta
  `"hay-que-salir"`.
- El docblock del mutante de `it("T-372-W1-12: `prepare()` se invoca EXACTAMENTE una vez en un envío
  que cierra")` (`recorrido-en-el-navegador-de-la-billetera.test.tsx:562-564` `@c1bd8d3`) lo dice
  textual: con `pop` contestando `hay-que-salir`, **«el envío suspende y la reanudación vuelve a
  llamar `prepare()`»**.
- 🔴 **Eso NO es un defecto: es lo que el camino por enlace ES.** Sale a la billetera y vuelve.

⇒ **El recorrido se mide en DOS TRAMOS, cada uno con su propio desenlace afirmable.**
⛔ **No se afloja la aserción del desenlace. Se dice DE CUÁL TRAMO ES.**

| Tramo | Qué ejercita | Su desenlace afirmable |
|---|---|---|
| **(I) IDA** | Render + camino por enlace ⇒ el salto ocurre | **La asignación de `window.location.href` hacia el host de la billetera existe** — verificada con `viajesALaBilletera(...)`, ⛔ no con `.length` |
| **(II) VUELTA** | Se siembra el regreso en disco y el recorrido reanuda y **cierra** | **`out.snapshot.status === "payout_submitted"`** — el mismo listón que usa `T-372-W1-12` |

**Para sembrar la vuelta, el repo ya tiene las piezas y ⛔ no se inventan:**

```
src/infrastructure/solana/deeplink/sesion.ts:222   export function guardarViaje(a: Almacen, v: Viaje): void
src/infrastructure/solana/deeplink/sesion.ts:283   export function leerViaje(a: Almacen, ahora: number): LecturaDelViaje
src/infrastructure/solana/deeplink/sesion.ts       almacenDeNavegador   (importado así en
                                                    src/presentation/vuelta-por-enlace-carrera.test.tsx:36)
src/infrastructure/solana/deeplink/conexion.ts     guardarEleccion      (ídem, :37)
src/infrastructure/solana/deeplink/pop-por-enlace.ts:398  export function leerPruebaPop(...)
```

🔴 **Y acá está la salida honesta, que es parte del entregable:**

> Si el tramo **(II)** no se puede alcanzar **dentro del presupuesto de §9** con el arnés existente,
> ⛔ **NO se afloja la aserción y NO se publica un número parcial como si fuera el total.**
> Se publica **el número del tramo (I) etiquetado 🟡 con su alcance escrito** —
> *«N travesías **hasta el salto**; el tramo de vuelta no se pudo instrumentar en jsdom dentro del
> presupuesto»* — y **eso se reporta como hallazgo**, no como omisión.
> *(Lección **H**: «no pude medirlo» **no es** «vale cero». Un número no tiene dónde poner el tercer
> valor si no le escribís el alcance al lado.)*

#### 6.2.2 · El `it`

```
it("T-374-W0-1: en el camino POR ENLACE, un envío que cierra atraviesa la pantalla de entrada N veces y sale a la billetera M veces")
```

**El orden de las aserciones es lo que lo vuelve falsable. No lo cambies.**

| # | Aserción | Por qué va ahí |
|---|---|---|
| **1** | `await entrarAlNavegadorDeLaBilletera(false, 1700)` devuelve **`"none"`** | ⛔ **El árbol llegó al cuadrante del enlace.** Sin esto, un `it` que quedó en `injected` cuenta los números del **otro** camino. *(Es exactamente el patrón de `:661-662`, con su mensaje.)* |
| **2** | `pop.respuestas` **NO** es `["no-corresponde"]` | Las tres condiciones de `caminoPorEnlace` (disponibilidad + bandera + elección) están **conjugadas**. Sin esto, **cualquiera de las tres explica el resultado**. 🔴 **Es el observable de C-2: `caminoPorEnlace` es `private` y no se puede llamar** |
| **3** | **El desenlace del tramo se alcanzó** (§6.2.1) | 🔴 **Un recorrido que no cierra cuenta 0 de todo.** Va **antes** de contar nada |
| **4** | `viajesALaBilletera(espia.asignado)` **NO** está vacío | 🔴 **La trampa del falso verde por vacío.** Ésta es la que **W0-0 vuelve creíble** |
| **5** | `1 + espia.asignado.length` === **`N`** (literal) | El número de travesías |
| **6** | `viajesALaBilletera(espia.asignado).length` === **`M`** (literal) | El número de salidas |

🔴 **`N` y `M` los escribís DESPUÉS de la primera corrida, con la salida cruda pegada en el docblock
del `it`.**
⛔ **PROHIBIDO escribir `7`, `6` o `5` copiados de cualquier documento** (`CD-W0-4`).
⛔ **Si el número que sale no coincide con el heredado, EL MEDIDO GANA y el heredado se declara FALSO,
con esas palabras, en el reporte.**

#### 6.2.3 · Los DOS mutantes, y por qué hacen falta dos

| Mutante | Qué toca | Qué aserción mata | Qué **NO** mata |
|---|---|---|---|
| **M-1** | Quitar `vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED","true")` de `sembrarElCaminoPorEnlace` (`:227`) | La **2** (y quizá la 3) | ⚠️ **NO mata por el conteo.** Si el rojo que ves es `expected 3 to be 4`, **ése no es este KILLED** |
| **M-2** | Agregar **una** asignación de `window.location.href` hacia el host de la billetera **en la rama del enlace** | Las **5 y 6**, y sólo ésas | La 1, la 2 y la 4 |

⚠️ **M-2 toca `flow.tsx`, que es Scope OUT.** ⇒ se aplica **por número de línea**, se **verifica en
disco antes de correr**, y se **restaura contra `/usr/bin/git diff --numstat` en la MISMA tarea**
(`CD-W0-10`). 🔴 **Y la línea que elijas NO puede ser una que lleve un marcador `[[CENSO …]]`**
(`flow.tsx:44, 75, 76, 146, 626, 963, 1351`): si el conteo de líneas se mueve, `citas-ancladas.test.ts`
se pone rojo **por otra causa** y el KILLED es falso.

🔴 **El falso KILLED que ya mordió en WKH-372 (lección U)**: *«un mutante puede morir por la aserción
del INSTRUMENTO y no por la de la pantalla»*. ⇒ **para cada mutante reportás CUÁL aserción produjo el
rojo, citándola.** Un `1 failed` sin decir cuál **no cuenta**.

#### 6.2.4 · Los tres límites de estos números, escritos ANTES de que alguien lea su verde

1. **`jsdom`, no un teléfono.** El propio archivo lo declara en `:31-32` `@c1bd8d3`:
   *«NINGUNO DE ESTOS `it` CORRE EN UN TELÉFONO»*. ⇒ el número se publica **🟡 derivado**, ⛔ **nunca
   🟢**, hasta que corra en el teléfono del founder (W3).
2. **Sólo Phantom** (W0-0, aserción 3).
3. **Es el número de HOY, del árbol viejo.** Es **la línea de base** contra la que W1/W3 comparan.
   ⛔ **No es una promesa sobre el árbol nuevo.**

⚠️ **Y una trampa que este `it` NO puede cerrar, y por eso se dice:** si el número sale **más bajo**
que el heredado, hay que distinguir *«se simplificó»* de *«una rama quedó inalcanzable»*. **Eso lo
contesta leer el camino, no el contador.**

**Tareas:**
- [ ] **T8** — Escribir `T-374-W0-1` al final de **A**, con las 6 aserciones **en orden**, y el
      desenlace del tramo (§6.2.1) declarado en el docblock.
- [ ] **T9** — Correr y **leer `N` y `M` de la salida**. Pegar la **salida cruda** en el docblock.
- [ ] **T10** — Correr el `it` **dos veces** y verificar que `N` y `M` **no cambian**.
      🔴 **Si cambian entre corridas: el conteo no es reproducible ⇒ PARAR y reportar.**
- [ ] **T11** — Aplicar **M-1**, verificar en disco, correr, restaurar. Reportar **cuál** aserción.
- [ ] **T12** — Aplicar **M-2**, verificar en disco (⛔ línea **sin** marcador de censo), correr,
      restaurar contra `git diff --numstat`. Reportar **cuál** aserción.
- [ ] **T13** — 🔴 Si la aserción **4** sale roja (`viajesALaBilletera` da `[]` en el camino por
      enlace): **PARAR.** Es el falso verde por vacío que W0-2 existe para cazar.
- [ ] **T14** — Publicar `N` y `M` con **etiqueta 🟡**, su alcance (Phantom, jsdom, árbol viejo) y su
      commit. ⛔ Sin copiar ningún número de ningún documento.

---

### 🔴 §6.3 · `W0-3` — **`L-5`: EL SALTO REMONTA EL ÁRBOL DE REACT** · BLOQUEANTE
### *(la medición que puede cambiar el diseño entero)*

**Archivo: C** — `src/presentation/el-salto-remonta-el-arbol.test.tsx` (**NUEVO**).

#### La premisa

*El salto por enlace remonta el árbol de React.* De ella cuelga **todo el §2 del work-item**: el vale,
`DT-3`, la circularidad, el borrador server-side. Hoy es **doctrina heredada**
(`src/infrastructure/auth/sesion-store.ts:16-25`), **no una corrida**.

#### El `it`, en tres patas

```
it("T-374-W0-3: el almacén de sesión es POR DOCUMENTO, la salida al enlace es una navegación de documento, y el instrumento sabe decir que SÍ hay sesión")
```

**Pata (a) — el almacén es por documento, no por navegación.**
Base medida: `let singleton: Container | null = null` (`container.ts:263`), `getContainer()` memoiza
(`:265-266`), `createContainer()` (`:96`) construye `new InMemorySesionStore(clock)` (`:106`).
El `it` afirma:
- `getContainer() === getContainer()` ⇒ **una navegación BLANDA conservaría la sesión**.
- Dos `createContainer()` devuelven **objetos distintos** ⇒ **una carga NUEVA la pierde**.

**Las dos mitades juntas dicen qué depende de qué.** Ninguna sola dice nada.

⚠️ Ver §4.3: **`sesiones` no está en el tipo `Container`** ⇒ la comparación es **de contenedores**.
⚠️ Si `createContainer()` tira bajo `jsdom`, **medí si es el entorno antes de reportarlo** (lección **J**).

---

**Pata (b) — 🔴 la que de verdad decide: EN ESTE REPO NO HAY ROUTER DE CLIENTE.**

**Barrido medido hoy sobre `src/` + `app/`, sobre `c1bd8d3`:**

```
/usr/bin/grep -rn "useRouter\|router\.push\|router\.replace\|next/navigation" src/ app/
⇒ app/kyc-simulado/page.tsx:26:import { notFound } from "next/navigation";
   (una sola línea en todo el repo)
```

**Cero `useRouter`. Cero `router.push`. Cero `router.replace`.** La única ocurrencia de
`next/navigation` es un `notFound()`, que **no navega**: aborta el render.

⇒ **Toda navegación del recorrido es `window.location.href = …`** ⇒ **toda salida es una navegación de
DOCUMENTO** ⇒ el registro de módulos se descarta ⇒ `singleton` vuelve a `null` ⇒
🔴 **la premisa `L-5` es VERDADERA hoy, y lo es POR AUSENCIA.**

⇒ **El `it` convierte esa ausencia en un candado**: barre `src/` y `app/` con **`readFileSync`** y
exige que **el conjunto de ocurrencias de router siga siendo exactamente el que hoy es** — o sea:
`useRouter`, `router.push` y `router.replace` con **cero** hits, y `next/navigation` con **exactamente
uno**, en `app/kyc-simulado/page.tsx`.

⛔ **Los dos falsos KILLED de esta pata, los dos medidos en WKH-372:**

1. **Colapso del resolvedor (lección M)**: un guard de existencia que vive en un archivo que
   **importa** lo que vigila muere por `Failed to resolve import` — **y eso NO es un KILLED**, es el
   archivo entero colapsando en `0 test`.
   ⇒ 🔴 **el barrido usa `readFileSync`, ⛔ NUNCA `import`.**
2. **Auto-lectura (`CD-W0-5`)**: el archivo **C** contiene los literales `useRouter` y `router.push`
   en su propia prosa y en su control negativo.
   ⇒ 🔴 **se excluye por RUTA EXACTA**, con el patrón `SELF` de `citas-ancladas.test.ts:56`
   (`path.resolve(full) !== SELF`, `:64`). ⛔ **Nunca por glob. Nunca por el sufijo `.test.`**

**Y lleva control negativo**: se le pasa al barrido una **lista de líneas sintéticas CON**
`router.push(...)` y **se exige que las cace**. Sin eso, un barrido roto que no encuentra nada es
indistinguible de un repo sin router.

---

**Pata (c) — el control positivo, sin el cual (a) no dice nada.**
Sembrar una sesión en un `new InMemorySesionStore(reloj)` con `record(direccion, token)` y afirmar que
`peek(direccion)` devuelve **el token**.
⛔ **Sin esto, el `null` de (a) es indistinguible de un instrumento roto.**
*(La API está en §4.3. El reloj es `{ nowIso(): string }`.)*

#### Los mutantes

| Mutante | Qué toca | Qué mata | Falso KILLED a evitar |
|---|---|---|---|
| **M-3** | En `src/composition/container.ts:266`, borrar la memoización (`if (!singleton)` ⇒ `singleton = createContainer()` siempre) | La **primera mitad de (a)** | ⚠️ `container.ts:266` es **producción y Scope OUT** ⇒ `CD-W0-10` estricto: verificar en disco, correr, restaurar contra `numstat`. ⚠️ **M-3 también puede poner rojo a `container.test.ts`** ⇒ el `×` que contás es el de `T-374-W0-3`, nombrado |
| **M-4** | Agregar `router.push("/x")` a la **lista sintética** que el control negativo de (b) lee | El **barrido de (b)** | 🔴 **NO se escribe un archivo real en `src/`** para esto: sería producción (`CD-W0-1`) **y** correría el conteo de los README. Es una **lista de strings en memoria** |
| **M-5** | Hacer que `peek` devuelva siempre `null` (`sesion-store.ts:121`) | La **pata (c)** | ⚠️ Producción y Scope OUT ⇒ `CD-W0-10`. Y **`sesion-store.test.ts` también se pondrá rojo** ⇒ nombrá el `×` que contás |

#### 🔴 Qué pasa si (b) sale FALSA

Si aparece un router de cliente —hoy, o el día que alguien lo agregue— **el `singleton` sobreviviría al
salto, la sesión cruzaría, `DT-3` dejaría de ser necesario, y el §2 del work-item cambia de forma.**
⇒ **`W0-3` es BLOQUEANTE. Si sale roja, la ola se detiene y vuelve a F1/F2.**

**Tareas:**
- [ ] **T15** — Crear el archivo **C** con su docblock: qué mide, sus límites, y la exclusión `SELF`
      por ruta exacta con su cita a `citas-ancladas.test.ts:56` (⛔ **sin ancla**, patrón §4.7).
- [ ] **T16** — Escribir la pata **(a)**: identidad de `getContainer()` y no-identidad de
      `createContainer()`.
- [ ] **T17** — Escribir la pata **(b)**: barrido con `readFileSync` + exclusión por **ruta exacta** +
      **control negativo** con líneas sintéticas.
- [ ] **T18** — Escribir la pata **(c)**: control positivo del `peek`.
- [ ] **T19** — Correr el gate entero. **Verde esperado.**
- [ ] **T20** — Matar **M-3**, **M-4** y **M-5**, **uno por uno y por separado**, cada uno verificado
      en disco antes de correr y restaurado contra `git diff --numstat`. Reportar para cada uno:
      **archivo · nombre del `it` · cuál aserción produjo el rojo**.
- [ ] **T21** — 🔴 Si **(b)** encuentra un router, o **(a)** dice que el contenedor sobrevive, o
      **(c)** no distingue: **PARAR y reportar. Vuelve a F1/F2.**

---

### 🔴 §6.4 · `W0-4` — **EL COSTO DEL CAMINO CONTRARIO** · BLOQUEANTE

**Archivo: B** — `src/composition/costo-de-una-cita-anclada.test.ts` (**NUEVO**; renombrado desde `el-arbol-propio-cuesta-cero-citas.test.ts` por el `MNR-3` del CR).

#### 🔴 Lo que NO mide, y por qué se cambió

El work-item proponía *«correr `citas-ancladas.test.ts` contra un módulo nuevo vacío y verificar que su
censo entrante es 0»*. **Eso es tautológico: nadie cita un archivo que acaba de nacer.**
**Un `it` que no puede fallar no es un control.**

#### Lo que SÍ mide: **cuánto cuesta la alternativa** — que es un número real, y es lo que decide `DT-1`

```
it("T-374-W0-4: una cita ANCLADA nueva hacia flow.tsx mueve 12 marcadores en 6 archivos; una SUELTA no mueve ninguno")
```

**Afirma:**

1. El conjunto de archivos con marcadores `[[CENSO src/presentation/flow.tsx …]]` es **exactamente los
   6**, y los conteos por campo son **12 `entrantes` / 8 `lineas` / 1 `destinos`**.
   ⛔ **Los 6 nombres SE DERIVAN del barrido, no se escriben a mano.**
2. Sobre **líneas SINTÉTICAS** (⛔ **no se escribe ningún archivo, en ningún lado**): una cita
   **ANCLADA** a `src/presentation/flow.tsx` sube `entrantes` a **166** ⇒ **los 12 marcadores quedan
   desajustados**.
3. La **misma** cita **SIN ancla** (⛔ **sin la coma entre backticks** — ver el regex de §4.4) **no
   mueve ninguno**.
4. 🔴 **CALIBRACIÓN contra un tercero**: el conteo de `entrantes` que produce **este** `it` **coincide
   con el número que los 12 marcadores del árbol declaran** (`165`).
   **Si no coincide, el instrumento de este `it` está mal** — o el árbol se movió.

| | |
|---|---|
| **Mutante nombrado** | **M-6** · en el regex **local de B**, quitar la coma obligatoria del formato anclado (`` `sim`, `f:NN` `` ⇒ `` `f:NN` ``) ⇒ **la aserción 3 se cae**, porque la cita suelta empieza a contarse |
| **Falso KILLED (1) — auto-lectura** | Este archivo **escribe citas de mentira en sus fixtures**. ⇒ **se excluye por RUTA EXACTA** (patrón `SELF`), igual que `citas-ancladas.test.ts` hace consigo mismo en `:56` / `:64`. ⛔ **Nunca por glob ni por `.test.`** |
| **Falso KILLED (2) — lección N** | 🔴 **Un ancla PARTIDA por un salto de línea NO entra al conjunto del guard real: el regex exige whitespace. 47 ocurrencias preexistentes en el árbol.** ⇒ el `it` le da **una cita partida como fixture** y **exige que NO la cuente**, igual que el candado real. Sin eso, el instrumento nuevo y el viejo **diferirían en un caso borde y la aserción 4 pasaría por casualidad** |
| **Falso KILLED (3) — no se importa el test** | ⛔ **PROHIBIDO importar `citas-ancladas.test.ts`**: importar un `.test.ts` **corre sus `describe`** y los duplica en el reporte. Se **re-implementa** el regex, **con su cita al lado**, y se calibra con la aserción 4 |

**Tareas:**
- [ ] **T22** — Crear el archivo **B** con su docblock y la exclusión `SELF` **por ruta exacta**.
- [ ] **T23** — Escribir el recolector (derivado, con `readFileSync` sobre `SCAN_DIRS`) y la
      **aserción 1** (6 archivos derivados, `12 / 8 / 1`).
- [ ] **T24** — Escribir los fixtures sintéticos y las **aserciones 2 y 3** (anclada vs. suelta).
- [ ] **T25** — Escribir el fixture del **ancla partida** y exigir que **no** se cuente (lección **N**).
- [ ] **T26** — Escribir la **aserción 4** (calibración contra los 12 marcadores del árbol = `165`).
- [ ] **T27** — Correr el gate entero. Matar **M-6**, verificado en disco y restaurado.
      Reportar **cuál** aserción.
- [ ] **T28** — 🔴 Si la aserción 4 no coincide: **PARAR**, re-derivar §1.3 entero, y reportar si el
      instrumento está mal o el árbol se movió.

---

### 🟡 §6.5 · `W0-5` — **CALIBRAR EL INSTRUMENTO DE `AC-13`.** ⛔ **`AC-13` SE MIDE EN `W1`, NO ACÁ**

**Archivos: NINGUNO. 0 líneas escritas.** Es una corrida de mutante y una frase en el reporte.

#### 🔴 La corrección, y va con estas palabras (repite §2.1)

W0 escribe **cero líneas de producción** ⇒ la bandera `NEXT_PUBLIC_CHASKI_RECORRIDO_V2` **no existe
todavía**. **No se puede medir la inercia de una bandera que no hay.** Decir que se midió sería
exactamente la clase de afirmación **sin sujeto** que la lección **C** persigue.

#### Lo que W0-5 sí hace

Corre el mutante del instrumento **que W1 va a reusar**, para probar que **discrimina**.

- **Instrumento**: `it("T-065-21: con la bandera APAGADA el paso `connect` es byte-idéntico al de
  hoy")`, `src/presentation/wallet-availability.test.tsx:1037` `@c1bd8d3`, con su hermano
  `it("T-065-21b: con la bandera PRENDIDA y una wallet inyectada, el selector NO aparece")` `:1076`.
- **La mitad que lo vuelve falsable**: `:1066`, `expect(prendida, …).not.toBe(apagada)`. Sin ella, la
  primera mitad pasaría **porque el selector nunca se monta**, no porque la bandera lo gatee.
- 🔴 **Y la corrección C-4, que va al reporte**: **no existe ningún `toBe(apagada)`**. La
  «byte-identidad» del nombre es **un nombre**; lo que se afirma es (a) `apagada` truthy (`:1048`),
  (b) selector ausente (`:1049`), (c) `prendida !== apagada` (`:1066`).

| | |
|---|---|
| **Mutante nombrado** | **M-7** · en `src/presentation/flow.tsx:963`, en el JSX del paso `connect`, **borrar el gate `mostrarSelectorDeEnlace ?`** ⇒ el selector aparece con la bandera apagada. **El propio archivo del test ya nombra este mutante** (`wallet-availability.test.tsx:1034-1036`) |
| 🔴 **Falso KILLED (1) — el más probable acá** | **`flow.tsx:963` LLEVA UN MARCADOR `[[CENSO src/presentation/flow.tsx lineas=4453]]`** (verificado hoy). ⇒ **borrá SÓLO la expresión del gate, ⛔ nunca la línea entera.** Si el conteo de líneas se mueve, `citas-ancladas.test.ts` se pone rojo **por otra causa** y el KILLED es falso |
| **Falso KILLED (2)** | **M-7 pone rojos VARIOS `it` a la vez**: además de `T-065-21`, muy probablemente `T-065-21b` (`:1076`) y `it("T-UI-3: CON wallet inyectada la pantalla queda EXACTAMENTE como estaba")` (`:218`). ⇒ **el `×` que contás es el de `T-065-21`, nombrado, y decís cuál aserción lo produjo** (esperada: `:1049`, *«el selector apareció con la bandera APAGADA»*, porque vitest corta en la primera) |
| ⚠️ **Restauración** | Se corre **en un worktree o con restauración verificada contra `/usr/bin/git diff --numstat`**. ⛔ **NUNCA con un `.orig` cacheado**: en WKH-372 un restaurador así **revirtió una ola entera en silencio** y el `md5` **confirmó el revert en vez de cazarlo** (lección **A**) |

**Tareas:**
- [ ] **T29** — Aplicar **M-7** sobre `flow.tsx:963` **borrando sólo la expresión del gate**, y
      **verificar en disco con `sed -n '963p' | cut -c1-300` ANTES de correr** que (i) el gate no está
      y (ii) **la línea sigue existiendo**.
- [ ] **T30** — Correr `vitest` sobre `src/presentation/wallet-availability.test.tsx` y anotar **todos**
      los `×`, no sólo el primero.
- [ ] **T31** — Restaurar contra `/usr/bin/git diff --numstat` y **verificar que da vacío**.
      Confirmar `/usr/bin/wc -l src/presentation/flow.tsx` ⇒ **4453**.
- [ ] **T32** — Escribir en el reporte **la frase textual de §2.1** y **la corrección C-4**.
- [ ] **T33** — 🟡 Si **M-7 no pone rojo a `T-065-21`**: el instrumento **no discrimina** ⇒ se declara
      que **W1 necesita otro instrumento para AC-13**. ⛔ **No detiene W0.**

---

### ⬜ §6.6 · `W0-6` — **`L-4`: EL `localStorage` A TRAVÉS DEL SALTO.** Medición de teléfono, con dueño

**Archivos: NINGUNO. 0 líneas.**

⛔ **No se puede cerrar en `jsdom`.** El navegador de la billetera es **otra partición de
almacenamiento**, y el propio módulo lo dice, textual, en
`src/presentation/salida-al-navegador-de-la-billetera.ts:16-20` `@c1bd8d3`:

> *«El navegador de la billetera es OTRA PARTICIÓN DE ALMACENAMIENTO —no es "volver al mismo origen":
> es el mismo origen en otro navegador— y nadie lo midió todavía en un teléfono.»*

| | |
|---|---|
| **Cómo se mide** | Con el instrumento que **ya existe**: la marca de vuelta que ese módulo deja en la URL, leída por `vinoDeUnaSalidaConBorrador` en el mismo archivo, y el renglón de `?diag=1` de `src/presentation/diagnostico-de-vuelta.tsx` |
| **Quién** | **El founder**, en su teléfono, con Phantom. ⚠️ **Precondición: *Testnet Mode* prendido.** Sin él, Phantom vuelve **sin nada y sin error** |
| **Cuándo** | **W3**, junto con el resto de la medición de teléfono |
| ⛔ **Qué NO se puede decir mientras tanto** | ⛔ ***«No se pudo medir»* NO es *«no cruza»*.** Un booleano no tiene dónde poner el tercer valor (lección **H**) |
| **Por qué no bloquea** | Es un **argumento A FAVOR** del borrador server-side, no en contra: si el disco no cruza, el borrador en el servidor es la única forma; si cruza, sigue siendo la forma correcta por AC-11 |

**Tareas:**
- [ ] **T34** — Escribir en el reporte la declaración de `W0-6` **con dueño (founder), instrumento
      (la marca de vuelta + `?diag=1`), precondición (Testnet Mode) y fecha (W3)**.
      ⛔ **Sin ninguna afirmación sobre si el disco cruza o no.**

---

### ⬜ §6.7 · `W0-7` — **LA LÍNEA DE BASE DEL FLAKE.** 0 líneas, y ⛔ **no se pone en cuarentena**

`src/presentation/vuelta-por-enlace-carrera.test.tsx` (**334 líneas**, verificado con `wc -l`) tiene un
flake preexistente declarado de **7-13 %**. **No es de esta HU.**

Los `it` que flakean, **por nombre y con su archivo** (`@c1bd8d3`):
- `it("PUERTA 1 · `dl=pop-kyc` con la disponibilidad todavía sin decidir ⇒ el selector NO aparece")` — `:259`
- `it("PUERTA 2 · `dl=conectar` con la disponibilidad todavía sin decidir ⇒ el selector tampoco aparece")` — `:279`
- *(y su control positivo, `it("CONTROL POSITIVO · el MISMO observable SÍ ve el selector cuando el selector está")` — `:307`)*

**W0-7**: correr **ese archivo solo, 20 veces**, y publicar la tasa medida (`k/20`) **con el commit**.

⚠️ **Lo que esa tasa NO es: un diagnóstico.** **Repetir no prueba el mecanismo.** 20 corridas no dicen
casi nada de un flake de 1 en 1000, y *«corrió 20 veces verde»* sobre un flake del 10 % es esperable
**el 12 % de las veces**. Se publica como **FOTO**, para que W1 pueda distinguir *«lo rompí yo»* de
*«es el de siempre»*. **El mecanismo del flake es una HU aparte, y se nombra para que no se vaya en
silencio.**

⚠️ **Footgun propio, medido en este ecosistema**: correr suites **en paralelo** desde el agente vuelve
flaky lo que no lo era. ⇒ 🔴 **las 20 corridas van SERIALIZADAS.**

**Tareas:**
- [ ] **T35** — Correr `./node_modules/.bin/vitest run src/presentation/vuelta-por-enlace-carrera.test.tsx`
      **20 veces, SERIALIZADAS**, y anotar `k` rojas de 20.
- [ ] **T36** — Publicar la tasa `k/20` con el commit `c1bd8d3`, **y la frase de que es una foto y no
      un diagnóstico**. ⛔ **Sin cuarentena, sin `skip`, sin tocar un `it` de ese archivo.**

---

### §6.8 · Cierre de la ola

- [ ] **T37** — Actualizar el conteo en **los DOS README** (`README.md:436`, `README.es.md:462`):
      `172` → el número que el candado diga. 🔴 **Derivado CORRIENDO
      `src/composition/readme-test-count.test.ts`, ⛔ nunca contando a mano.** Y **cada uno por
      separado, a propósito**: el modo de falla de una traducción parcial **no es decir algo falso, es
      OMITIR**.
- [ ] **T38** — **Re-derivar TODAS las citas `:NN` de los archivos nuevos y del extendido**, con
      `/usr/bin/grep -n`, **después de la última edición** (`CD-W0-11`, lección **V**).
- [ ] **T39** — Verificar los marcadores de censo: `/usr/bin/wc -l src/presentation/flow.tsx` ⇒
      **4453**, y `npm test` con `citas-ancladas.test.ts` **verde**. ⛔ **Ningún marcador se edita**:
      W0 no cambió ninguno de los números que vigilan.
- [ ] **T40** — 🔴 Verificar `CD-W0-1` con
      `/usr/bin/git add -A && /usr/bin/git diff --cached --numstat` ⇒ **los únicos archivos con líneas
      son A, B, C (tests) y los dos README (1 línea cada uno)**. **Cero archivos de producción.**
- [ ] **T41** — Correr **el gate completo, entero y en orden**, después de `git add -A` (§8).
- [ ] **T42** — Contrastar el diff contra el presupuesto de §9, **por columna** (código de test /
      prosa de test / producción). Si excede, **justificar por escrito diciendo EN CUÁL COLUMNA está**.
- [ ] **T43** — Escribir el reporte de W0 con: los 8 resultados, `N` y `M` **medidos** con su etiqueta
      🟡 y su alcance, la tasa `k/20`, la frase de §2.1, las correcciones **C-1..C-5**, y las
      observaciones **OBS-1** (`bitacora-de-vuelta.ts:176` dice «ocho archivos», son **seis**) y
      **OBS-5** (`T-372-W3-8` no renderiza ningún árbol).

---

## §7 · Plan de tests — resumen, con el mutante y el falso KILLED de cada uno

> ⛔ **Regla transversal 1**: todo mutante **se verifica en disco antes de correr nada**, y se
> **aborta** si el patrón no aparece **exactamente una vez**. *Un mutante que no matcheó, más una
> suite verde, son indistinguibles de un control que funciona.*
> ⛔ **Regla transversal 2**: el arnés de mutación **no cachea un `.orig`**. El control es **contra el
> árbol de git** (`/usr/bin/git diff --numstat`).
> ⛔ **Regla transversal 3**: **ningún guard puede leerse a sí mismo.** Exclusión **por ruta EXACTA**.
> ⛔ **Regla transversal 4**: un `exit=1` **sin un `×` nombrado NO es un KILLED**. Se cita
> **archivo · nombre del `it` · cuál aserción produjo el rojo**.
> ⛔ **Regla transversal 5**: **un mutante que SOBREVIVE se reporta como tal**, con su guard declarado
> inalcanzable. No se esconde y no se sustituye por otro más fácil.

| Medición | `it` (nombre completo) | Archivo | **Mutante nombrado** | **Falso KILLED a evitar** |
|---|---|---|---|---|
| **W0-0** | `T-374-W0-0: el filtro de viajes reconoce un href de ENLACE PROFUNDO, y declara que solflare queda afuera` | **A** | **M-0** · `protocol.ts:55` → `phantom.example` | `.toHaveLength(1)` dejaría pasar un filtro que devuelve **todo** ⇒ se compara **por valor**. Y **M-0 rompe también `T-DL-1/4/5`** ⇒ nombrá el `×` que contás |
| **W0-1** | `T-374-W0-1: en el camino POR ENLACE, un envío que cierra atraviesa la pantalla de entrada N veces y sale a la billetera M veces` | **A** | **M-1** · quitar el `stubEnv` de `:227` | 🔴 **M-1 NO mata por el conteo.** Si el rojo es `expected 3 to be 4`, **no es este KILLED** (lección **U**) |
| **W0-2** | *(mismas aserciones 4 y 6 del `it` de arriba)* | **A** | **M-2** · una asignación de `location.href` de más en la rama del enlace | ⛔ La línea del mutante **no puede llevar un marcador `[[CENSO …]]`** (`flow.tsx:44,75,76,146,626,963,1351`): el rojo vendría de `citas-ancladas`, no del conteo |
| **W0-3 (a)** | `T-374-W0-3: el almacén de sesión es POR DOCUMENTO, la salida al enlace es una navegación de documento, y el instrumento sabe decir que SÍ hay sesión` | **C** | **M-3** · borrar la memoización de `container.ts:266` | ⚠️ **M-3 también pone rojo a `container.test.ts`** ⇒ nombrá el `×`. Y si `createContainer()` tira bajo jsdom, **es el entorno** (lección **J**) |
| **W0-3 (b)** | *(misma `it`, pata del barrido)* | **C** | **M-4** · `router.push("/x")` en la **lista sintética** | 🔴 **Colapso del resolvedor** (lección **M**): el barrido usa **`readFileSync`**, ⛔ nunca `import`. Y **auto-lectura**: exclusión por **ruta EXACTA**, nunca por glob |
| **W0-3 (c)** | *(misma `it`, control positivo)* | **C** | **M-5** · `peek` devuelve siempre `null` | ⚠️ **`sesion-store.test.ts` también se pondrá rojo** ⇒ nombrá el `×` que contás |
| **W0-4** | `T-374-W0-4: una cita ANCLADA nueva hacia flow.tsx mueve 12 marcadores en 6 archivos; una SUELTA no mueve ninguno` | **B** | **M-6** · quitar la coma del regex anclado local | (1) **auto-lectura** ⇒ `SELF` por ruta exacta; (2) 🔴 **lección N**: el ancla **partida** no la cuenta el guard real ⇒ el fixture la incluye y **exige que no se cuente**; (3) ⛔ **no importar `citas-ancladas.test.ts`** |
| **W0-5** | `T-065-21: con la bandera APAGADA el paso `connect` es byte-idéntico al de hoy` *(ya existe, `wallet-availability.test.tsx:1037`)* | *(ninguno)* | **M-7** · `flow.tsx:963`, borrar el gate `mostrarSelectorDeEnlace ?` | 🔴 **`:963` lleva un marcador `lineas=4453`** ⇒ borrá **sólo la expresión**, no la línea. Y **M-7 pone rojos varios `it`** (`T-065-21b`, `T-UI-3`) ⇒ el `×` es el de `T-065-21`, con su aserción (esperada `:1049`) |
| **W0-6** | — | — | *(no medible en jsdom)* | ⛔ ***«No se pudo medir»* NO es *«no cruza»*** (lección **H**) |
| **W0-7** | `PUERTA 1 · …` `:259` y `PUERTA 2 · …` `:279` *(ya existen, `vuelta-por-enlace-carrera.test.tsx`)* | *(ninguno)* | *(es una medición de repetición, no hay mutante)* | ⛔ **Repetir no prueba el mecanismo.** 20 verdes sobre un flake del 10 % son esperables el 12 % de las veces. **Se publica como foto** |

⚠️ **Y lo que estos tests NO prueban, dicho antes de que alguien lea su verde de más:**
**ninguno corre en un teléfono**, **ninguno habla con un servidor de verdad**, **ninguno mide Solflare**,
y **ninguno dice nada sobre el árbol nuevo** — que todavía no existe.

---

## §8 · El gate del repo — completo y en orden

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
/usr/bin/git add -A          #  ⚠️ IMPRESCINDIBLE: el gate se mide contra el ÍNDICE de git
npm run qa                   #  = lint → typecheck → typecheck:scripts → test   (package.json:20)
npm run build                #  = next build --webpack                          (package.json:10)
```

⚠️ **Se mide contra el índice de git: `git add -A` ANTES.** Correrlo antes del `git add` es correrlo
sobre un árbol donde **el entregable no existe**, y **da verde**.

⛔ **PROHIBIDO `npx biome` y `npx tsc` sueltos.** `npx` intenta bajar paquetes inexistentes y devuelve
un error que **se lee como fallo del gate**.
⇒ Usá los binarios locales: `./node_modules/.bin/vitest`, `./node_modules/.bin/biome`,
`./node_modules/.bin/tsc`, o los scripts de `package.json`.

⛔ **Correr las partes de un gate no es correr el gate.** `lint` va **primero** y es el eslabón que
nadie alcanza: en este ecosistema **un `import` sin usar pasó `tsc --noEmit` Y `vitest`**, lo cazó
`biome lint`, y **sobrevivió cinco revisiones**.

### 8.1 · Los rojos que W0 provoca a propósito, y **NO son regresiones**

1. 🔴 **`src/composition/readme-test-count.test.ts`** — porque W0 crea **2** archivos de test
   (172 → 174). **Se arregla escribiendo el número nuevo en los DOS README** (T37), derivado
   **corriendo el candado**. ⛔ **No se afloja el candado.**

**Y los que NO son esperados:**

⚠️ **Flake preexistente, 7-13 %**: `src/presentation/vuelta-por-enlace-carrera.test.tsx`,
`PUERTA 1 · …` (`:259`) y `PUERTA 2 · …` (`:279`). **No es de esta HU.**
⛔ **NO se pone en cuarentena.** Si sale rojo **ahí y sólo ahí**, se re-corre **ese archivo solo**
antes de investigar nada, y se declara **con la frecuencia medida de W0-7 y un denominador que no sea
chico**. *(En WKH-372 casi se reportó haber empeorado un flake con un denominador de 10.)*

🔴 **Y ante cualquier `it` verde que se ponga rojo con W0, la primera pregunta NO es «¿qué rompí?», es
«¿qué defecto estaba compensando ese verde?».** *(En WKH-372, un `it` no estaba mal escrito: medía bien
un comportamiento equivocado, y por eso su verde no protegía nada.)*

---

## §9 · Presupuesto de escala — **POR COLUMNA, para tenerlo a la vista MIENTRAS escribís**

> 🔴 **Ésta es la sección que el CR de la ola anterior usó para encontrar sus tres bloqueantes.**
> El desborde de WKH-372 **no estaba en los tests: estaba en la PROSA DE PRODUCCIÓN** (61 % contra el
> **53,0 %** re-derivado de la casa), **y ahí vivían los tres bloqueantes.**
> **Más prosa es más superficie de afirmación sin testigo.** *(Lección **Q**.)*
> ⛔ **El presupuesto se contrasta en CADA fix-pack, no sólo al cerrar, y en TODAS las columnas.**
> ⛔ **Todo número publicado se re-mide contra el árbol. ⛔ Nunca sumando deltas** — sumar un delta a
> un total anterior **cuenta dos veces las líneas reemplazadas** (2.857 publicado contra 2.834
> re-derivado, lección **S**).

### 9.1 · El presupuesto, por columna

| Columna | Techo | Nota |
|---|---:|---|
| 🔴 **Producción ejecutable** | **0** ⛔ **estricto** | `CD-W0-1`. Se verifica con `git diff --cached --numstat` |
| 🔴 **Producción — comentario / prosa** | **0** ⛔ **estricto** | **El techo de prosa de PRODUCCIÓN de `CD-14` (≤45 %) NO SE MUEVE** (D-3). Acá se cumple **por construcción**: no hay denominador |
| **Test — total (código + prosa)** | **≤ 520** | Desviación **D-3**, aprobada. 1,3x sobre los 400 del work-item |
| · archivo **A** (extensión) | ≤ 190 | 3 `it`, arnés **reusado** ⇒ **0 líneas de arnés nuevo** |
| · archivo **B** (nuevo) | ≤ 160 | 1 `it` + recolector + fixtures sintéticos |
| · archivo **C** (nuevo) | ≤ 170 | 1 `it` de tres patas + barrido + control negativo |
| **Test — prosa (ratio)** | **≤ 55 %** *(techo aprobado)* | 🔴 **Pero mirá 9.2 antes de apoyarte en ese número** |
| **README** | **2 líneas** (1 por archivo) | Forzado por **C-1**. No cuenta contra las 520 |
| **Archivos tocados** | **5** | 1 extendido + 2 nuevos + 2 README. *(El SDD decía 3: corrección **C-1**.)* |
| 🔴 **Archivos de producción tocados** | **0** ⛔ | Los mutantes **M-2, M-3, M-5, M-7** tocan producción **temporalmente** y se **restauran en la misma tarea** ⇒ el diff final es **0** |

### 9.2 · 🔴 El techo de prosa de test es **55 %, y no puede binderar.** Medido hoy

| Archivo de test de la casa | Prosa | Código | **Ratio** |
|---|---:|---:|---:|
| `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | 208 | 520 | **28,6 %** |
| `src/presentation/sesion-borra-la-segunda-firma.test.tsx` | 169 | 436 | **27,9 %** |
| `src/composition/citas-ancladas.test.ts` | 173 | 238 | **42,1 %** |
| `src/presentation/vuelta-por-enlace-carrera.test.tsx` | 137 | 183 | **42,8 %** ← ~~el máximo del repo~~ |

> ⛔ **CORREGIDO EL 2026-09-01 POR EL `BLQ-MED-2` DEL CR. TODO ESTE §9.2 ESTÁ DESACTUALIZADO Y LO
> REEMPLAZA `w0-report.md` §7.2.** Los cuatro números de la tabla reproducen al decimal; **lo falso es
> el cuantificador**: salían de cuatro archivos elegidos a mano. Barrido el árbol entero con el mismo
> contador, el máximo es **65,0 %** (`src/composition/prepared-claims-guard.static.test.ts`) y hay
> **26 de 174** archivos de test por encima de 42,8 %. ⇒ Las dos frases de acá abajo son falsas: el
> techo del 55 % **no** está por encima de todo lo que existe (ya lo exceden varios archivos de la
> casa) y **el «número de referencia 42,8 %» queda RETIRADO**. La vara es el techo formal **≤55 %**,
> que **sí bindea**: el archivo C de esta ola quedó a **0,5 puntos** de tocarlo. ⚠️ W1 tiene que leer
> `w0-report.md` §7.2 y ⛔ no esta tabla.

⇒ ~~**Un techo del 55 % está 12 puntos por encima del test más prosaico que existe en `chaski-v3`.**
Un techo que nada alcanza **no es un techo: es una intención**.~~ ⛔ **FALSO, ver el recuadro.**

🔴 **La regla operativa, entonces:**
- El techo formal aprobado sigue siendo **≤55 %** y **no se cambia**.
- ~~**El número de referencia es 42,8 %.**~~ ⛔ **RETIRADO.** Si un archivo se acerca al techo formal,
  se justifica POR ESCRITO en el reporte con el barrido de `w0-report.md` §7.2 al lado.
- ⛔ **Y el techo de prosa de PRODUCCIÓN no se mueve ni un punto** — es la distinción que D-3 aprobó
  con condición, y es donde vivieron los tres bloqueantes de la ola anterior.

### 9.3 · La pregunta que decide un exceso

> *¿Qué parte de esto seguiría existiendo si lo escribiera alguien que ya conoce este repo?*

- **Los mutantes, los controles positivos y los negativos: SÍ.** Son exactamente lo que evita los
  falsos KILLED que ya mordieron **tres veces** (lecciones **A**, **M**, **U**).
- **La prosa que re-explica el Δ0: NO.** Se cita el patrón de §4.7 y se sigue.

⚠️ **Si al cerrar W0 el diff supera 2x el techo del work-item (>800 líneas de test), se justifica por
escrito diciendo EN CUÁL COLUMNA está, o se recorta.** ⛔ **Un exceso silencioso ES el hallazgo.**

---

## §10 · Riesgos que te tienen que preocupar mientras codeás

| # | Riesgo | Antídoto |
|---|---|---|
| **R-1** | 🔴 **Escribir una cita ANCLADA sin querer** hacia `flow.tsx` o `solana-wallet.ts`. Basta el formato `` `simbolo`, `ruta:NN` `` — **la coma es lo que la vuelve anclada** | Toda cita a esos archivos va **SIN ancla, con su motivo al lado** (patrón §4.7). **Una cita anclada nueva pone rojos 12 sitios en 6 archivos** |
| **R-2** | 🔴 **Insertar los `it` nuevos ARRIBA en el archivo A** ⇒ corre todas las citas `:NN` hacia A | `CD-W0-11`: **al final del archivo**, y re-derivar con `grep -n` **después** |
| **R-3** | 🔴 **Un mutante que no matcheó + una suite verde** son indistinguibles de un control que funciona | **Verificar en disco ANTES de correr**, y **abortar** si el patrón no aparece exactamente una vez |
| **R-4** | 🔴 **Restaurar con un `.orig` cacheado** ⇒ ya revirtió una ola entera en silencio | **`/usr/bin/git diff --numstat` vacío** es el único control válido |
| **R-5** | **Leer un rojo de `jsdom` como hallazgo del sujeto** (`Buffer.from(x) instanceof Uint8Array` es `false`) | **La sonda cuesta dos minutos; la conclusión falsa cuesta una ola** (lección **J**) |
| **R-6** | **Publicar `N` o `M` copiado de un documento** | `CD-W0-4`. **Sale de una corrida o no sale** |
| **R-7** | 🔴 **Contar un `×` de OTRO `it` como el KILLED de éste.** Pasa con **M-0**, **M-3**, **M-5** y **M-7**, los cuatro | **Nombrá archivo · `it` · aserción.** Un `1 failed` sin `×` nombrado **no cuenta** |
| **R-8** | **Correr las suites en paralelo desde el agente** ⇒ vuelve flaky lo que no lo era | **W0-7 va SERIALIZADO**, y el gate también |
| **R-9** | **Arreglar `OBS-1`** (la frase «ocho archivos» de `bitacora-de-vuelta.ts:176`) | ⛔ **Es producción.** `CD-W0-1`. **Se declara, no se arregla** |
| **R-10** | 🔴 **Backticks dentro de `"..."` en bash SE EJECUTAN** | Comillas simples, o `-F` con un archivo, para cualquier mensaje de commit |

---

## §11 · Lo que W0 NO entrega, y decirlo es parte del entregable

- ⛔ **No entrega AC-13.** La bandera del recorrido nuevo no existe (§2.1).
- ⛔ **No entrega ninguna línea del árbol nuevo.** `src/presentation/recorrido/**` **no se crea**.
- ⛔ **No entrega el vale, ni el borrador, ni ninguna tabla.** Eso es W2.
- ⛔ **No entrega ningún número medido en un teléfono.** Todo lo de W0 es `jsdom` ⇒ **🟡, nunca 🟢**.
- ⛔ **No entrega nada sobre Solflare.** El instrumento no lo cubre, y W0-0 lo **declara**.
- ⛔ **No cierra `L-4`** (¿cruza el `localStorage`?). Queda con **dueño y fecha** (§6.6).
- ⛔ **No arregla `OBS-1`** (`bitacora-de-vuelta.ts:176` dice «ocho archivos»; son **seis**).
- ⛔ **No arregla `OBS-5`** (`T-372-W3-8` no renderiza ningún árbol ⇒ `DT-5` no tiene candado sobre
  ninguna pantalla). **Es `CD-W0-7`, obligación de W1.**
- ⛔ **No diagnostica el flake.** Publica **una foto**, y nombra que **el mecanismo es una HU aparte**.

---

## §12 · Done Definition — **W0 está terminada cuando**

- [ ] **D1** — Las **43 tareas** de §6 están marcadas.
- [ ] **D2** — 🔴 **Las CINCO mediciones bloqueantes (`W0-0`, `W0-1`, `W0-2`, `W0-3`, `W0-4`) salieron
      VERDES** sobre el árbol de hoy. *(Si alguna salió roja: la HU está **DETENIDA y reportada**, con
      su salida textual y la aserción nombrada — **no terminada**.)*
- [ ] **D3** — **Cero líneas de producción** en el diff, verificado con
      `/usr/bin/git add -A && /usr/bin/git diff --cached --numstat`. Los únicos archivos con líneas son
      **A, B, C** (tests) y los **dos README** (1 línea cada uno).
- [ ] **D4** — `/usr/bin/wc -l src/presentation/flow.tsx` da **4453**. **Δ0 = 0.** Verificado con
      `wc -l`, ⛔ **no leyendo el diff**.
- [ ] **D5** — `/usr/bin/git diff --stat main...HEAD` muestra **0 líneas** de
      `src/presentation/flow.tsx` y **0 líneas** de `src/infrastructure/solana-wallet.ts`.
- [ ] **D6** — **Ninguna cita ANCLADA nueva** hacia `flow.tsx`, `solana-wallet.ts` ni ningún archivo con
      marcadores `[[CENSO … entrantes]]`. Los conteos siguen en **12 / 8 / 1** y `citas-ancladas.test.ts`
      está **verde**.
- [ ] **D7** — Los **8 mutantes M-0 … M-7** que corresponden se corrieron **uno por uno y por
      separado**, cada uno **verificado en disco antes** y **restaurado contra `git diff --numstat`**.
      ⛔ **Ninguno con `.orig` cacheado.**
- [ ] **D8** — 🔴 **Cada KILLED tiene su `×` nombrado**: **archivo · nombre del `it` · cuál aserción
      produjo el rojo**. ⛔ **Ningún `1 failed` sin `×` cuenta como KILLED.** Y **todo mutante que
      SOBREVIVIÓ está reportado como tal**, con su guard declarado inalcanzable.
- [ ] **D9** — **`N` y `M` salieron de UNA CORRIDA**, con la **salida cruda pegada** en el docblock del
      `it`, etiqueta **🟡**, y su alcance escrito (**Phantom · jsdom · árbol viejo · tramo declarado**).
      ⛔ **Ningún `6`, `5` o `7` copiado de ningún documento.**
- [ ] **D10** — El reporte lleva, **textual**, la frase de §2.1:
      *«AC-13 NO se midió en W0: la bandera no existe. Lo que se midió es que el instrumento
      discrimina, con su mutante M-7. AC-13 se mide en W1.»*
- [ ] **D11** — **Ningún guard se lee a sí mismo.** Los barridos de **B** y **C** se excluyen **por
      RUTA EXACTA** (patrón `SELF`, `citas-ancladas.test.ts:56`/`:64`), ⛔ **nunca por glob ni por el
      sufijo `.test.`**, y **cada uno tiene su control negativo**.
- [ ] **D12** — El barrido de `W0-3(b)` usa **`readFileSync`**, ⛔ **no `import`** (lección **M**), y
      el fixture del **ancla partida** de `W0-4` **existe y exige que no se cuente** (lección **N**).
- [ ] **D13** — El gate completo corrió **entero y en orden** después de `git add -A`:
      `npm run qa` (lint → typecheck → typecheck:scripts → test) y después `npm run build`, **los dos
      verdes**, con la salida citada. ⛔ **Sin `npx` suelto. Correr `vitest` solo no cuenta.**
- [ ] **D14** — Los **dos** README declaran el conteo nuevo, **derivado corriendo el candado**, y
      **cada uno por separado**.
- [ ] **D15** — **Todas** las citas `archivo:línea` nuevas re-derivadas con `/usr/bin/grep -n`
      **después de la última edición**, y **toda cita a un test escrita por NOMBRE del `it` + su
      archivo**, con el número anclado a un commit.
- [ ] **D16** — `W0-7` publicada como **`k/20` serializadas**, con su commit y con la frase de que es
      **una foto y no un diagnóstico**. ⛔ **`vuelta-por-enlace-carrera.test.tsx` NO está en
      cuarentena** y **no se le tocó un `it`**.
- [ ] **D17** — `W0-6` declarada **con dueño (founder), instrumento, precondición (Testnet Mode) y
      fecha (W3)**. ⛔ **Sin ninguna afirmación sobre si el disco cruza.**
- [ ] **D18** — Las cinco correcciones **C-1 … C-5** de §1.2 están **en el reporte**, y las
      observaciones **OBS-1** y **OBS-5** están **declaradas, no arregladas**.
- [ ] **D19** — El diff está dentro del presupuesto de §9 **en todas las columnas**, o el exceso está
      **justificado por escrito diciendo EN CUÁL COLUMNA está**. 🔴 **Producción: 0 y 0, sin excepción.**
- [ ] **D20** — Ninguna frase nueva de docblock **sin el input concreto que la pondría en rojo**
      (lección **C**). Si no existe ese input, la frase se recortó hasta que existiera.
- [ ] **D21** — Ninguna afirmación de W0 dice que *«Crear la cuenta»* desaparece, ni que las salidas
      son **2** (`CD-W0-14`; el objetivo publicable es **3**).

---

*Story File · F2.5 · ola **W0** de WKH-374 · 2026-09-01 · NexusAgil Architect ·
sobre `chaski-v3@c1bd8d3`, con `SPEC_APPROVED` otorgado y las cinco desviaciones **D-1 … D-5**
aprobadas por el orquestador. ⛔ Cero líneas de producción escritas en esta fase.*
