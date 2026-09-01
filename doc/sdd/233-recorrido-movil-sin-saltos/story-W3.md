# Story File · [WKH-372] · **OLA W3** — La sesión del lado del servidor borra la segunda firma de identidad

> **Este documento es autocontenido. El Dev NO lee el SDD.** Todo lo que hace falta para implementar
> W3 está acá: archivos exactos, líneas exactas, tests con su nombre, el mutante que mata cada test,
> el falso KILLED a evitar, el gate, el presupuesto por archivo, y la definición de terminado.
>
> **Repo donde vive el trabajo:** `/home/ferdev/.openclaw/workspace/chaski-v3` — **y sólo ése**.
> **Repo ancla de los artefactos:** `wasiai-a2a` (`doc/sdd/233-recorrido-movil-sin-saltos/`).
> ⛔ **De `wasiai-a2a` no se toca una sola línea de `src/`.**
>
> **Rama:** `feat/wkh-372-w3-sesion-del-servidor`
> *(verificada como INEXISTENTE hoy: `/usr/bin/git branch -a | /usr/bin/grep -i -E "w3|sesion"`
> devuelve **cero refs**.)*
>
> **Fecha:** 2026-08-31 · **Modo:** QUALITY · **Gate `SPEC_APPROVED`: OTORGADO**
> **Base:** `chaski-v3@f295a6f3764b553c9ced93bb1bc4c0ae33a1bd35`, `main`, árbol limpio
> (`/usr/bin/git status --porcelain` vacío, re-verificado hoy al escribir este documento).

---

## 0 · Antes de escribir una línea

### 0.1 · Las citas se re-derivan

⚠️ Todas las citas `archivo:línea` de este documento se derivaron **hoy**, sobre `f295a6f`, con
`sed -n 'Np'` y `/usr/bin/grep -rn`. Si algo mergea sobre `chaski-v3` entre este documento y tu
primer commit, **re-derivá las citas de §4 antes de editar**.

⚠️ **Las citas a un test van POR NOMBRE del `it` (o del `describe`) y SIEMPRE CON SU ARCHIVO.** El
nombre **no es único**: `T-CABLE-1` y `T-CABLE-2` existen en **dos** suites a la vez, midiendo cosas
distintas —`src/composition/container.test.ts:372` / `:1064` y
`src/presentation/wallet-availability.test.tsx:128` / `:146`— y esos números son **al `f295a6f`**.
**En W1 se rompieron 7 citas por no hacer esto**, y ninguna herramienta las vigila, porque
`citas-ancladas.test.ts` sólo mira dentro de `chaski-v3` y estos documentos viven en `wasiai-a2a`.

### 0.2 · 🔴 Tres correcciones medidas HOY que cambian lo que decían documentos anteriores

Se miden acá porque son números de los que cuelgan CDs y tareas. **Ninguna de las tres cambia lo que
hay que hacer; las tres cambian lo que hay que escribir.**

| # | Lo que decía el documento anterior | Lo medido hoy sobre `f295a6f` | Consecuencia |
|---|---|---|---|
| **C-1** | *«el marcador `[[CENSO … entrantes-desde-893=76]]` **ya no existe en el árbol**»* | 🔴 **SÍ EXISTE.** `/usr/bin/grep -rn "entrantes-desde-893" src/ app/ scripts/` devuelve **`src/infrastructure/solana-wallet.ts:893`**. Y hay un **segundo** `=76`: `[[CENSO … entrantes-desde-906=76]]` en `solana-wallet.ts:906` | El archivo tiene **cuatro** contadores vivos, no tres: `lineas=2498`, `entrantes=127`, `entrantes-desde-893=76`, `entrantes-desde-906=76` (más `entrantes-desde-1233=60` y `entrantes-desde-2241=9` / `destinos-desde-2241=6`). **La orden no cambia: ese archivo NO SE TOCA.** Tocarlo re-deriva los seis |
| **C-2** | *«`popProofs = new InMemoryPopProofStore(clock)` en `container.ts:307`»* | 🔴 **Es `container.ts:106`.** `container.ts:307` es la línea `//` | El cableado de W3.4 se hace en **`:106`**, `:161` y `:185`. **Si editás `:307` estás editando un comentario vacío** |
| **C-3** | *«`T-067-17` / `T-067-18`, por nombre, en `pop-por-enlace.test.ts`»* | Son **`describe`**, no `it`: `src/infrastructure/solana/deeplink/pop-por-enlace.test.ts:437` y `:485` | Si los citás, citalos como `describe`. **No busques un `it` con ese nombre: no existe** |

### 0.3 · Los números de los que cuelga la ola, todos verificados hoy

| Hecho | Cómo se verifica | Valor hoy sobre `f295a6f` |
|---|---|---|
| `wc -l src/presentation/flow.tsx` | `/usr/bin/wc -l` | **4453** |
| Marcador Δ0 de `flow.tsx` | `[[CENSO src/presentation/flow.tsx lineas=4453]]`, presente en `flow.tsx:146`, `flow.tsx:1351`, `confirm-and-send.ts:463`, `flow-vm.ts:1522`, `flow-vm.test.ts:2532`, `diagnostico-de-vuelta.tsx:115`, `app/page.tsx:23` | **4453** |
| Citas ancladas entrantes a `flow.tsx` | `[[CENSO src/presentation/flow.tsx entrantes=155]]` (`flow.tsx:44`) | **155** |
| `wc -l src/infrastructure/solana-wallet.ts` | `/usr/bin/wc -l` | **2498** |
| Citas ancladas entrantes a `solana-wallet.ts` | `[[CENSO … entrantes=127]]` (`solana-wallet.ts:2234`, `preparacion-por-enlace.ts:9`) | **127** |
| Conteo de archivos de test en los DOS README | `README.md:436` (`**167 test files**`), `README.es.md:462` (`**167 archivos de test**`) | **167** |
| El gate del repo | `package.json:20` | `qa` = `lint && typecheck && typecheck:scripts && test` |
| El build | `package.json:10` | `build` = `next build --webpack` |
| Qué lintea | `package.json:12` | `lint` = `biome lint src app scripts` ⇒ **el `.mjs` nuevo SÍ se lintea** |
| Qué typechequea `typecheck:scripts` | `tsconfig.scripts.json` | `"include": ["scripts/**/*.ts"]` ⇒ **un `.mjs` NO entra ahí** |

⛔ **Al cerrar, los marcadores `[[CENSO …]]` y el conteo de los README se re-derivan CORRIENDO, nunca
contando a mano** (§ W3.6).

---

## 1 · Qué se construye y por qué (contexto compacto)

Hoy la app le pide a la persona **dos firmas de identidad que prueban exactamente lo mismo**: que la
dirección es suya.

1. La **primera** la pide `ConnectWallet` para consultar el veredicto de KYC. El propio archivo la
   declara textual en `src/infrastructure/kyc/http-kyc-verdict-gateway.ts:95`:
   *«ESTA ES LA ÚNICA FIRMA DE BILLETERA DE TODO EL FLUJO DE KYC»*, y la firma sale de
   `this.pop.prove(address)` en `:82`.
2. La **segunda** la pide el gateway del depósito justo antes de `POST /api/payout/prepare`:
   `this.pop.prove(input.address)` en `src/infrastructure/settlement/http-solana-prepare-gateway.ts:245`.

Las dos existen por una razón legítima y escrita: sin la del payout, esa ruta sería un oráculo de
existencia y estado de verificaciones de identidad ajenas.

**La causa raíz es que la app no tiene sesión.** Medido: `/usr/bin/grep -rn` sobre `src/` y `app/`
buscando `next/headers`, `Set-Cookie`, `set-cookie` y `cookies()` devuelve **cero líneas**, y no
existe `middleware.ts` en ninguna de las tres ubicaciones que Next acepta. **No hay nada que reusar:
hay que construirlo.**

**W3 construye la sesión y borra la SEGUNDA firma. La primera se queda** (es `AC-3-5`, y es un
requisito, no una concesión).

### 1.1 · Lo más caro que hay que entender antes de escribir el módulo

🔴 **`POST /api/a2a/payout/challenge` emite un token HMAC firmado con `PAYOUT_POP_SECRET` para
CUALQUIER dirección, sin pedir ninguna firma.** El handler entero son 40 líneas
(`app/api/a2a/payout/challenge/route.ts:34-73`, archivo de 74 líneas): 501 si falta el secreto,
rate-limit, parseo, `canonicalizeAddress` y `issueSolanaPopChallenge` en `:70`. **No hay ni un
`verify`.** Es correcto: el challenge es el *desafío*, y lo que prueba posesión es la firma que el
cliente le pone encima.

⇒ 🔴 **Si el verificador de la sesión compartiera el secreto y la forma del challenge, cualquier
anónimo se emitiría una sesión para la dirección de otro con un solo `curl`**, y eso no sólo
reabriría el oráculo que ya está cerrado: **autorizaría un desembolso**.

⇒ Por eso la sesión lleva **dominio propio Y secreto propio**, y `T-372-W3-2` lo mide **con su
control positivo**.

### 1.2 · La distinción que ordena las waves, y que no se colapsa

> El objetivo **sesión** NO depende de que Phantom soporte *Sign In With Solana* por enlace profundo.
> **Aunque no lo soporte, la sesión igual borra la segunda firma.** Lo único que esa medición decide
> es si conectar y firmar se funden en **un** permiso o quedan en **dos**.

⇒ **`AC-3-4` nace DEFERIDO** y **no se construye ningún instrumento en esta ola** (§2.2 y §11).

---

## 2 · Los criterios de aceptación de W3 — la lista cerrada, y cómo queda cada uno

- **AC-3-1**: WHILE la app corre en el navegador inyectado, the system SHALL completar un envío
  pidiendo **exactamente UNA** firma de identidad, no dos. → **W3.0 + W3.4**, testigo `T-372-W3-1`.
- **AC-3-2**: `POST /api/payout/prepare` SHALL aceptar una sesión emitida por este servidor **o** el
  PoP de hoy, y SHALL rechazar con **403 opaco** cualquier otra cosa, incluido un `popChallenge`
  crudo presentado como sesión. → **W3.2**, testigos `T-372-W3-2`, `-3`, `-4`.
- **AC-3-3**: WHEN la sesión no está o venció, the system SHALL pedir la firma **como hoy**, sin
  mostrar ningún error. → **W3.1 + W3.4**, testigos `T-372-W3-5`, `-6`, `-7`.
- **AC-3-4**: *(SIWS por enlace profundo)* → 🔴 **DEFERIDO. Ver §2.2.**
- **AC-3-5**: WHEN la persona recarga la página, the system SHALL volver a pedirle la **primera**
  firma. → se cumple **por construcción** (la sesión vive sólo en memoria), testigo `T-372-W3-8`.
- **AC-3-6**: WHEN se le pide la firma, the system SHALL decirle **qué** firma, **que es gratis**,
  **que no mueve plata** y **qué pasa si se la vuelven a pedir**. → **W3.5**, testigos `T-372-W3-10`
  y `T-372-W3-10b`. 🔴 **La cuarta frase se REESCRIBIÓ. Ver §2.3.**

### 2.1 · `AC-3-2` en una frase operativa

`prepare` acepta **sesión O PoP**. Los **cinco** modos de fallar de la sesión colapsan en el **mismo**
403 con el **mismo** enum `payout_pop_unverified` y el **mismo cuerpo** que los cinco del PoP.
⛔ **Cero enums nuevos.** Un enum propio le diría al caller *cuál* de los dos mecanismos falló, que
es un oráculo.

### 2.2 · 🔴 `D-W3-1` RESUELTA: `AC-3-4` queda DEFERIDO y **no se construye la página de medición**

**Decisión del orquestador, ya tomada. No se re-decide.**

⛔ **NINGÚN ARCHIVO BAJO `public/` ENTRA EN ESTA OLA. Cero.**

**La razón, escrita para que quede en el expediente:** un instrumento de medición que mergea a `main`
es **una página pública en el sitio desplegado**, servida desde el mismo origen que el money-path, y
que construye enlaces de billetera. **No hay guard mecánico que lo impida** — un guard de existencia
de archivos que viva en un archivo que importa lo que vigila muere por colapso del resolvedor de
módulos, no por aserción, y eso no cuenta como KILLED.

**Y el valor de la ola no depende de él:** la sesión borra la segunda firma **exista o no** SIWS
(§1.2). Lo que esa medición decide es si más adelante conectar y firmar se funden en **un** permiso.

**Cómo se mide cuando el founder esté disponible** *(protocolo escrito, ⛔ NO se construye ahora)*:

| Paso | Qué se hace | Qué se concluye |
|---|---|---|
| **0 · precondición** | El teléfono del founder, con **Testnet Mode activo** en Phantom | ⛔ **Sin Testnet Mode la billetera vuelve sin nada y sin error**, o sea **indistinguible de «no soporta `signIn`»**. Sin este paso la medición no vale |
| **1 · control** | Un `connect` por enlace profundo, normal, desde el navegador común del celular | **Si el control falla ⇒ NO SE PUDO PREGUNTAR.** ⛔ Eso **nunca** es «no soporta». Se detiene acá |
| **2 · sujeto** | Con el control ok, un `signIn` por enlace profundo | Vuelve **con la firma** ⇒ **SOPORTADO** ⇒ `AC-3-4` se puede cerrar en otra HU · Vuelve **vacío o con error** ⇒ **NO SOPORTADO** ⇒ `AC-3-4` queda DEFERIDO **con razón escrita** |

**Dónde se hace:** fuera del repo. Un HTML suelto en el teléfono, un preview de otro proyecto, o la
herramienta que el founder prefiera. **⛔ No en `chaski-v3`.**

### 2.3 · 🔴 `D-W3-2` RESUELTA: la cuarta frase de `AC-3-6` **se REESCRIBE**, no se gatea

**Decisión tomada acá, con su razón medida. No se re-decide.**

El `AC-3-6` original pide decir *«se hace una sola vez para esta dirección»*. **Esa frase es falsa en
el camino por enlace**, que sigue encendido. La opción sobre la mesa era gatearla a
`disponibilidadWallet === "injected"`.

🔴 **Se descarta el gate, y la razón es medible: el gate NO vuelve verdadera la frase.**

1. La sesión vive **sólo en memoria** y muere en cada recarga. Eso no es un detalle: es lo que hace
   que **`AC-3-5` se cumpla por construcción**, y está escrito como prohibición dura (⛔ nada de
   `localStorage`, `sessionStorage`, `IndexedDB`, cookie ni URL).
2. 🔴 **El recorrido de primera vez de esta misma app RECARGA la página**: el paso de identidad hace
   `window.location.href = res.url` hacia el verificador — **`src/presentation/flow.tsx:460`,
   verificado hoy, línea exacta `window.location.href = res.url;`** — y el propio repo lo llama
   textual *«una RECARGA»*.
3. ⇒ En el camino **`"injected"`**, **toda persona que se verifica en este envío pierde la sesión y
   vuelve a firmar.** El gate seguiría publicando una frase falsa para **cada remitente nuevo**.

⇒ ⛔ **No se shippea una frase falsa en la mitad de los casos, y tampoco en un cuarto.** La frase se
reescribe para ser **verdadera en los dos caminos y en las dos ramas**:

> **Frase 4, final:** *"Si te la volvemos a pedir, es por lo mismo: confirmar que es tuya."*

**Consecuencias operativas de esta decisión, que el Dev tiene que ver antes de codear:**
- ⛔ **No hay gate de copy.** Las **cuatro** frases se muestran **siempre**, en `"injected"` y en
  `"none"`. Menos código, menos caracteres en `flow.tsx`, y ningún camino donde el copy mienta.
- ✅ Y como no hay gate, **no hace falta un test del gate**. Lo que sí hace falta, y es más caro y más
  valioso, es **el testigo de que la frase 4 es verdadera**: `T-372-W3-10b` (§7).
- ⚠️ Se cierra como **cumplimiento del AC con la cuarta afirmación reformulada**, con esta razón
  copiada en el reporte de la ola. **No como cumplimiento pleno del texto literal del AC.**

---

## 3 · Scope — la lista exhaustiva de archivos

### 3.1 · Scope IN (todo bajo `/home/ferdev/.openclaw/workspace/chaski-v3`)

| # | Archivo | Acción | Presupuesto (añadidas / borradas) | Wave |
|---|---|---|---|---|
| **A** | `src/presentation/sesion-borra-la-segunda-firma.test.tsx` | **CREAR** | 330 ± 90 / 0 | W3.0 |
| **B** | `src/infrastructure/auth/sesion-de-posesion.ts` | **CREAR** (server-only, `node:crypto`) | 115 ± 30 / 0 | W3.1 |
| **C** | `src/infrastructure/auth/sesion-de-posesion.test.ts` | **CREAR** | 180 ± 50 / 0 | W3.1 |
| **D** | `app/api/payout/prepare/route.ts` | MODIFICAR — rama `S1..S5` dentro de `PR5'` | 50 ± 15 / 2 | W3.2 |
| **E** | `app/api/payout/prepare/route.test.ts` | MODIFICAR — apéndice de `it`s | 210 ± 60 / 0 | W3.2 |
| **F** | `app/api/kyc/verdict/route.ts` | MODIFICAR — acuña la sesión tras `:150`, la agrega a los 5 `200` | 28 ± 10 / 5 | W3.2 |
| **G** | `app/api/kyc/verdict/route.test.ts` | MODIFICAR — apéndice | 120 ± 40 / 0 | W3.2 |
| **H** | `.env.example` | MODIFICAR — documenta `PAYOUT_SESSION_SECRET` | 16 / 0 | W3.2 |
| **I** | `scripts/probe-sesion-de-posesion.mjs` | **CREAR** — el probe contra el servicio desplegado | 130 ± 35 / 0 | W3.3 |
| **J** | `src/infrastructure/auth/sesion-store.ts` | **CREAR** (browser-safe, ⛔ sin `node:crypto`) | 75 ± 20 / 0 | W3.4 |
| **K** | `src/infrastructure/auth/sesion-store.test.ts` | **CREAR** | 110 ± 30 / 0 | W3.4 |
| **L** | `src/application/ports.ts` | MODIFICAR — `SesionReader` / `SesionRecorder`. ⚠️ **al final del archivo** | 16 / 0 | W3.4 |
| **M** | `src/infrastructure/kyc/http-kyc-verdict-gateway.ts` | MODIFICAR — lee `sesion` del 200 y la registra | 45 ± 15 / 1 | W3.4 |
| **N** | `src/infrastructure/kyc/http-kyc-verdict-gateway.test.ts` | MODIFICAR | 40 ± 10 / 0 | W3.4 |
| **O** | `src/infrastructure/settlement/http-solana-prepare-gateway.ts` | MODIFICAR — `peek()`, `sessionToken`, y el reintento único | 60 ± 20 / 1 | W3.4 |
| **P** | `src/infrastructure/settlement/http-solana-prepare-gateway.test.ts` | MODIFICAR | 85 ± 25 / 0 | W3.4 |
| **Q** | `src/composition/container.ts` | MODIFICAR — **Δ0**, en `:106`, `:161` y `:185`, que **ya existen** | 3 / 3 | W3.4 |
| **R** | `src/composition/container.test.ts` | MODIFICAR — el `T-CABLE` de la sesión | 45 ± 15 / 0 | W3.4 |
| **S** | `src/test-support/fakes.ts` | MODIFICAR — el doble del almacén | 18 / 0 | W3.4 |
| **T** | `src/presentation/flow.tsx` | MODIFICAR — 🔴 **Δ0 ESTRICTO**, las 4 frases | 4 / 4 (**Δ0**) | W3.5 |
| **U** | `src/presentation/wallet-availability.test.tsx` | MODIFICAR — copy + actualización deliberada de `T-065-21` | 65 ± 20 / 4 | W3.5 |
| **V1** | `README.md` | MODIFICAR — `:436`, una línea | 1 / 1 | W3.6 |
| **V2** | `README.es.md` | MODIFICAR — `:462`, **por separado** | 1 / 1 | W3.6 |

🔴 **Son 23 archivos.** *(El SDD declaró «22» contando los dos README como una sola fila. El número de
acá está contado archivo por archivo, hoy. Lo que se contrasta contra el umbral del CR es **23**.)*

### 3.2 · Scope OUT — tocarlos es **BLOQUEANTE en AR**

- ⛔ **`src/infrastructure/solana-wallet.ts`** — cero líneas, ni un comentario. Tocarlo re-deriva
  **seis** marcadores (§0.2/C-1) y **127** citas ancladas entrantes.
- ⛔ **`public/**` — CERO archivos.** (§2.2)
- ⛔ `src/infrastructure/solana/deeplink/**` (los 13 módulos) y `nonce-duradero.ts`.
- ⛔ `src/infrastructure/solana/preparacion-por-enlace.ts` (tiene 3 de los marcadores de censo).
- ⛔ `src/application/solana-escrow-rent.ts` — ningún valor de umbral de SOL se toca.
- ⛔ `src/application/use-cases/confirm-and-send.ts` — sus `:463` y `:474` están bajo Δ0 declarado.
- ⛔ `src/application/use-cases/connect-wallet.ts`.
- ⛔ **`app/api/kyc/session/route.ts`** — su PoP es **opcional a propósito**: sin prueba, la persona
  **se puede verificar igual**. Cerrar esa puerta costó un bloqueante en la HU anterior.
- ⛔ `app/api/kyc/decision/route.ts`.
- ⛔ `src/infrastructure/auth/pop-challenge.ts`, `pop-proof-store.ts`, `http-pop-signer.ts` — se
  **imitan**, no se amplían.
- ⛔ `src/presentation/flow-vm.ts` y `src/presentation/bienvenida.tsx`.
- ⛔ `src/infrastructure/rate-limit.ts`.
- ⛔ `src/infrastructure/a2a/**` — la arquitectura A2A no se toca.
- ⛔ Cualquier archivo de `wasiai-facilitator` o de `wasiai-a2a/src/`.

---

## 4 · Anti-Hallucination Checklist — específica de esta HU

Marcá cada una **antes** de escribir código. Todas verificadas hoy sobre `f295a6f`.

### 4.1 · El emisor/verificador que hay que copiar (exemplar de **B**)

- [ ] `src/infrastructure/auth/pop-challenge.ts` mide **106 líneas** y `:9-11` declara el formato:
      el HMAC se calcula **sobre el STRING base64url del payload**, no sobre el JSON crudo, *«así
      `verify()` re-HMACea el string recibido tal cual y no depende de que `JSON.stringify`
      re-serialice idéntico»*. ⛔ **Se copia esta forma. No se inventa un formato nuevo.**
- [ ] `pop-challenge.ts:25-29` es `function secret()` y lee `process.env.PAYOUT_POP_SECRET`
      **DENTRO de la función**, con `if (!s) throw`. ⛔ **Es el patrón obligatorio del repo** (para
      que `vi.stubEnv` funcione).
- [ ] `pop-challenge.ts:22` es `export const POP_CHALLENGE_TTL_SECONDS = 10 * 60;`
- [ ] `pop-challenge.ts:43-48` es `interface SolanaPopChallenge { address; networkId; nonce; exp }`,
      con `exp` en **epoch SEGUNDOS** (`:47`) y `networkId` en **CAIP-2** (`:45`).
- [ ] `pop-challenge.ts:58` es `export function issueSolanaPopChallenge(...)`.
- [ ] `pop-challenge.ts:68` es
      `export function verifySolanaPopChallenge(token: string, nowMs: number): SolanaPopChallenge | null`
      y `:82-84` son, textual:
      `const received = Buffer.from(macB64);` / `if (expected.length !== received.length) return null;` /
      `if (!timingSafeEqual(expected, received)) return null;`
      🔴 **El chequeo de longitud VA ANTES: `timingSafeEqual` tira con buffers de distinta longitud.**
- [ ] `pop-challenge.ts:105` es `return { address, networkId, nonce, exp };` (el final del happy path).

### 4.2 · El almacén en memoria que hay que copiar (exemplar de **J**)

- [ ] `src/infrastructure/auth/pop-proof-store.ts` mide **84 líneas**, y `:47` es
      `export class InMemoryPopProofStore implements PopProofReader, PopProofRecorder {`
- [ ] `:48` es `private readonly porAddress = new Map<string, Observada>();` y `:50` es
      `constructor(private readonly clock: Clock) {}`
- [ ] `:52-53` dice textual: *«El reloj es el puerto inyectado, no `Date.now()`: `Clock` es
      `{ nowIso(): string }` y NO tiene `nowMs()`»*, con la cita `../../application/ports.ts:975`.
      ⛔ **No ampliar el puerto `Clock`.**
- [ ] `:65-69` es el docblock que dice que `null` significa **DOS** cosas *«que para el caller son la
      misma: no hay prueba, o la que hay venció»*, **con su razón escrita**. ⛔ **Se copia la razón,
      no sólo el `null`.**
- [ ] `:70` es `peek(address: string): PopProof | null {` y `:76-77` son
      `const ahora = this.ahoraMs();` / `if (!Number.isFinite(ahora)) return null;`
      🔴 **Un reloj ilegible cae del lado seguro. Va copiado.**
- [ ] `:40` es `const POP_PROOF_TTL_MS = 8 * 60 * 1000;` y `:22-33` explican **por qué el literal se
      duplica en vez de importarse**: *«importarlo desde acá rompería el bundle del browser»*.
      🔴 **Ése es exactamente el motivo por el que B y J no se pueden fusionar.**
- [ ] `src/infrastructure/auth/pop-proof-store.test.ts:100` es el `it`
      `"POP_PROOF_TTL_MS < POP_CHALLENGE_TTL_SECONDS × 1000"`, que lee **los dos archivos** con
      `readFileSync` y un regex (`:102`). ⛔ **Es el molde del candado, si J necesita uno.**

### 4.3 · Los puertos (archivo **L**)

- [ ] `src/application/ports.ts` mide **1234 líneas**.
- [ ] `ports.ts:137-155` es el bloque de `PopProof` / `PopProofReader` / `PopProofRecorder`, y dice
      textual: *«`PopProofReader` NO TIENE `prove`, Y ESO ES EL PUNTO … no depende de que nadie lo
      llame, depende de que el método NO EXISTA en el tipo, así que `tsc` lo impide»* y
      *«⛔ PROHIBIDO agregarle `prove` a esta interfaz "para simplificar"»*.
      🔴 **`SesionReader` / `SesionRecorder` se calcan de ahí. El lector NO tiene `record`; el
      escritor NO tiene `peek`.**
- [ ] `ports.ts:975` es `export interface Clock {`.
- [ ] `ports.ts:295-303` es el bloque que avisa que este archivo **recibe 17 citas ancladas** y que
      `tsc` no caza todo. ⚠️ **Por eso los tipos nuevos van AL FINAL del archivo, no en el medio.**

### 4.4 · El receptor: `prepare` (archivo **D**)

- [ ] `app/api/payout/prepare/route.ts` mide **549 líneas**.
- [ ] El orden de guards, línea por línea, verificado hoy:
      `:124` `// PR2 —` (503 sin secreto, fail-closed) · `:131` `// PR3 —` (rate-limit IP-only,
      *«TRAS PR2 y ANTES de parsear/forwardear»*) · `:144` `// PR4 —` (body null-safe) ·
      `:200` `// PR5' —` (proof-of-possession) · `:259` `// PR5.5 —` ·
      `:321` `// PR6' —` (autoridad server-side) · `:352` `// PR7 —` (forward al agente).
- [ ] `:214` es **exactamente**
      `  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler`
      ⛔ **Esta línea y su 503 NO SE MUEVEN y NO SE VUELVEN CONDICIONALES.**
- [ ] `:219` es `  const popChallenge = body.popChallenge;`
- [ ] Los cinco guards del PoP están en `:221` (`// P1 — presencia + tipo → 403 opaco.`),
      `:230` (`// P2 — HMAC + exp + tipos colapsan en null → 403 opaco.`),
      `:235` (`// P3 — address match (CD-8, base58 case-sensitive)…`),
      `:243` (`// P4 — CAIP-2 binding … NUNCA del body.`) y `:247` (`// P5 — ed25519 …`).
- [ ] `:303` es **exactamente**
      `    row = await verdictStore.get(canonicalizeAddress(ch.address));`
      🔴 **Es LA línea que pasa a leer `direccionProbada`.**
- [ ] `:332` es `  const d = await resolvePayoutAuthority({ verificationId: rowVerificationId, address });`
      ⚠️ **Esta línea NO se cambia. Ver §5/P-3, TD.**
- [ ] `src/infrastructure/address.ts:13` es `export function canonicalizeAddress(address: string): string {`
- [ ] `src/infrastructure/chain.ts:32` es `export function resolveSolanaNetworkId(): string {`
      ⛔ **El `networkId` se compara contra ESTA función, nunca contra un literal.**

### 4.5 · El emisor: `kyc/verdict` (archivo **F**)

- [ ] `app/api/kyc/verdict/route.ts` mide **383 líneas**.
- [ ] `:88` es el 429 del rate-limit (`V2`), **arriba de todo lo que W3 escribe**.
- [ ] `:105` es `// V4 — proof-of-possession Solana OBLIGATORIO. Copiado del bloque P1..P5 del money-path`
- [ ] `:148` dice textual: *«Desde acá, y sólo desde acá, el caller probó que la billetera es suya»*.
- [ ] `:150` es **exactamente**
      `  const owner = canonicalizeAddress(ch.address); // ← la PoP-verificada, NUNCA body.sender (CD-18)`
      🔴 **La sesión se acuña AGUAS ABAJO de esta línea, jamás arriba.**
- [ ] Los **cinco** `return … 200` de esa ruta, verificados uno por uno hoy:
      `:204` `if (!record) return json({ verdict: null, reason: "absent" }, 200);` ·
      `:208` `if (!record.approved) return json({ verdict: null, reason: "not_approved" }, 200);` ·
      `:222` `return json({ verdict: null, reason: "expired" }, 200);` ·
      `:282` `if (credencial === null) return json({ verdict: null, reason: "absent" }, 200);` ·
      `:284-292` el `return json({ verdict: { riskLevel, provenance, verifiedAt } }, 200);`
      🔴 **A los CINCO se les agrega el campo. ⛔ A ningún 403 ni 503.**

### 4.6 · Los dos clientes (archivos **M** y **O**)

- [ ] `src/infrastructure/kyc/http-kyc-verdict-gateway.ts` mide **131 líneas**. `:55` es
      `export class HttpKycVerdictGateway implements KycVerdictGateway {` y `:56` es
      `  constructor(private readonly pop: PopSigner) {}`
      ⇒ **el `SesionRecorder` entra como SEGUNDO argumento del constructor.**
- [ ] `:72-76` es `async ensure(address, candidateVerificationId?, yaConseguida?)`.
- [ ] `:94` es `    if (!proof) return { lookup: { outcome: "not_asked", reason: "pop_disabled" } };`
- [ ] `:95-97` es el docblock de *«ESTA ES LA ÚNICA FIRMA DE BILLETERA DE TODO EL FLUJO DE KYC»*.
- [ ] `:98` es `const out = (lookup) => ({ lookup, proof: proof ?? undefined });`
- [ ] `:100` es `const res = await fetch("/api/kyc/verdict", {` y los cortes tempranos son
      `res.status === 501` ⇒ `store_disabled`, `res.status === 403` ⇒ `pop_rejected`, `!res.ok` ⇒
      `throw`. 🔴 **Recién después viene `const body = (await res.json()) as VerdictResponse;`**
      ⇒ **la sesión se registra JUSTO DESPUÉS de ese `res.json()`, ANTES de la rama `!v`**, para que
      los cinco `200` queden cubiertos con una sola escritura.
- [ ] ⛔ **El `catch` de `:83` NO SE ESTRECHA.** Su docblock dice por qué: *«un fallo del PoP no puede
      impedir verificarse»*.
- [ ] `src/infrastructure/settlement/http-solana-prepare-gateway.ts` mide **335 líneas**. `:191` es
      `  constructor(private readonly pop: PopSigner) {}` ⇒ **el `SesionReader` entra como SEGUNDO
      argumento.**
- [ ] `:240-241` son `let proof: Awaited<ReturnType<PopSigner["prove"]>>;` / `if (input.proof) {`
      y `:245` es `        proof = await this.pop.prove(input.address);`
      🔴 **`peek()` se consulta ANTES de este bloque. Si hay sesión, `prove()` NO SE LLAMA.**
- [ ] `:232-238` son las **tres** propiedades escritas que sostienen que el ancla por enlace no viola
      la CD del reuso, y citan `T-067-17` y `T-067-18` (que son **`describe`**, en
      `src/infrastructure/solana/deeplink/pop-por-enlace.test.ts:437` y `:485`).
- [ ] `:262-277` es el `fetch("/api/payout/prepare", …)` con el body que hoy lleva `popChallenge` y
      `popSignature` (`:275-276`). ⇒ **`sessionToken` se agrega a ese mismo JSON.**
- [ ] `:283` es `    if (!res.ok) {` y `:291` es
      `      return { ok: false, reason: mapErrorReason(res.status, error) };`
      🔴 **Ahí adentro vive el reintento único del repliegue (`T-372-W3-17`).**

### 4.7 · El cableado y los dobles (archivos **Q**, **R**, **S**)

- [ ] `src/composition/container.ts` mide **373 líneas**.
- [ ] 🔴 `container.ts:106` es
      `  const popProofs = new InMemoryPopProofStore(clock); // WKH-337: OBSERVA las pruebas PoP de los gestos`
      ⛔ **Es `:106`. NO es `:307`** (§0.2/C-2). El almacén de sesión se instancia **en esta misma
      línea física**.
- [ ] `container.ts:161` es
      `        prepare: new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet, popProofs)),`
- [ ] `container.ts:185` es la línea de
      `    connectWallet: new ConnectWallet(wallet, kycStore, new HttpKycVerdictGateway(new HttpPopSigner(wallet, popProofs)), wallet), // …`
- [ ] `src/test-support/fakes.ts` mide **1220 líneas**; `:310` es
      `export class FakePopSigner implements PopSigner {`. ⛔ **El doble del almacén se calca de ahí,
      al final del archivo.**
- [ ] `src/composition/container.test.ts` mide **1115 líneas**; `T-CABLE-1` está en `:372` y
      `T-CABLE-2` en `:1064`. ⚠️ **Los dos nombres existen TAMBIÉN en
      `src/presentation/wallet-availability.test.tsx` (`:128` y `:146`).**

### 4.8 · La pantalla (archivos **T** y **U**)

- [ ] `src/presentation/flow.tsx` mide **4453** líneas. `wc -l` tiene que seguir dando **4453**.
- [ ] `flow.tsx:933` es `          {step === "connect" && (` ⇒ el paso `connect` arranca ahí.
- [ ] `flow.tsx:963` es una línea larga que ya contiene el selector de enlace y
      `<NoWalletHere direccionConectada={address} vueltaSinResolver={vueltaSinResolver} />`.
      🔴 **Ésa es la línea física donde entra el copy de `AC-3-6`, en la MISMA línea (Δ0).**
- [ ] `flow.tsx:147` declara `const disponibilidadWallet = useWalletAvailability();`
      *(dato de contexto: **ya no hace falta para el copy**, porque la frase 4 no se gatea, §2.3).*
- [ ] `flow.tsx:460` es **exactamente** `        window.location.href = res.url;`
      🔴 **Es la recarga que mata la sesión y que descarta el gate de la frase 4.**
- [ ] `src/presentation/wallet-availability.test.tsx` mide **1870 líneas**. Los guards que vigilan
      esta pantalla, por nombre y con su archivo (al `f295a6f`):
      `T-UI-1` (`:182`), `T-UI-2` (`:199`), `T-UI-3` (`:218`), `T-UI-4` (`:240`),
      `T-065-21` (`:1037`), `T-065-21b` (`:1076`).
      🔴 **`T-065-21` compara el `innerHTML` del paso `connect` entero: SE VA A PONER ROJO.**
      **Ese rojo es correcto y se actualiza a propósito.** ⛔ **No se afloja la comparación.**
      ⚠️ `T-UI-2` dice *«el texto NO afirma nada sobre lo que hay instalado en el dispositivo»*:
      un guard viejo de esta familia ya frenó una frase de W1, **y tenía razón**. Leelo antes.
- [ ] `src/presentation/bienvenida.tsx:232` es el `<h2>Tu plata no pasa por Chaski</h2>`.
      ⛔ **No se toca, y ninguna frase nueva puede volverlo falso.** *(La sesión no es una clave: no
      firma nada, no produce transacciones, y no autoriza movimiento de fondos.)*

### 4.9 · Los candados y el gate

- [ ] `src/composition/citas-ancladas.test.ts:331` es
      `const CENSO = /\[\[CENSO ([\w./-]+) (lineas|entrantes|destinos)(?:-desde-(\d+))?=(\d+)\]\]/g;`
      ⛔ **Ése es el guard de Δ0. NO escribas otro.**
- [ ] `src/composition/readme-test-count.test.ts:88-89` mide `README.md` con
      `/\*\*(\d+) test files\*\*/` y `README.es.md` con `/\*\*(\d+) archivos de test\*\*/`,
      **por separado, por idioma**; `:38` define `TEST_DIRS = ["src", "app", "contracts", "scripts"]`.
      🔴 **W3 crea 3 archivos de test nuevos (A, C, K) ⇒ este candado SE PONE ROJO, y es correcto.**
- [ ] `scripts/probe-vuelta-por-enlace.mjs` (**85 líneas**) es el molde de **atribución por código de
      salida**, con `exit 0` / `exit 10` / **`exit 30` = «el instrumento no pudo correr», ⛔ y eso NO
      es un verde**. Su docblock también declara sus **tres límites** antes de que nadie lea su verde.
- [ ] `/home/ferdev/.openclaw/workspace/wasiai-a2a/scripts/probe-money-path.mjs` (23.155 bytes,
      existe) es el molde de **hablar con el servidor de verdad**: `fetch` contra la URL real, sin
      dobles. ⚠️ El de `chaski-v3` envuelve `vitest`; **el de W3 tiene que hacer red.**
- [ ] La rama `feat/wkh-372-w3-sesion-del-servidor` **no existe**.

---

## 5 · Los siete controles del borde — cómo se preserva cada uno, con su testigo

> 🔴 **Esta tabla es el corazón de la revisión adversarial de la ola. El AR la va a recorrer entera.**

| # | El control | ¿W3 lo toca? | **Cómo se preserva** | Testigo |
|---|---|---|---|---|
| **P-1** | Rate-limit por IP **antes** de gastar cuota del proveedor | No | `PR3` (`prepare/route.ts:131`) y `V2` (`verdict/route.ts:88`) quedan **arriba** de todo lo que W3 escribe. La rama de sesión vive **dentro de `PR5'`**, que ya está debajo del limiter | `T-372-W3-13` |
| **P-2** | La key del limiter sale de una fuente **no forjable** | No | `clientIp()` intacto. **Δ0 en `src/infrastructure/rate-limit.ts`** | Δ0 verificado con `git diff --stat` |
| **P-3** | 🔴 **El binding es la dirección PROBADA, jamás un campo del cuerpo** | **Sí, y es el que más importa de toda la ola** | `S4` reproduce **exactamente** lo que hace `P3` en `:235`: compara `canonicalizeAddress(sesion.address)` contra `canonicalizeAddress(address)` y muere en 403. Y `:303` pasa a leer **`direccionProbada`**, que sale del token que **nosotros** firmamos, no del body. ⛔ **PROHIBIDO un `?? body.address`, un `?? address` o cualquier default en cualquiera de las dos ramas** | **`T-372-W3-4`** |
| **P-4** | Sin prueba ⇒ sesión de KYC **sin atar**, pero la persona **puede verificarse igual** | No | ⛔ **`app/api/kyc/session/route.ts` no se toca.** Su PoP opcional existe para que la puerta de entrada al KYC no se cierre, y cerrarla costó un bloqueante en la HU anterior | Δ0 |
| **P-5** | El `GET /decision` exige credencial ⇒ cierra el IDOR | No | `app/api/kyc/decision/route.ts` está fuera del Scope IN. ⛔ **La sesión de W3 NO es una credencial para esa ruta y NO se acepta ahí** | Δ0 |
| **P-6** | Mismo body y mismo status para «sin token» y «token inválido» (anti-enumeración) | **Sí** | Los cinco fallos de `S1..S5` colapsan en el **mismo 403 con el mismo cuerpo** que los cinco de `P1..P5`. ⛔ **Cero enums nuevos** | **`T-372-W3-3`** |
| **P-7** | **Nunca** un fetch al proveedor antes de pasar los guards | **Sí** | La rama de sesión va **antes** de `PR5.5` (`:259`) y de `PR6'` (`:321`). Un caller sin sesión válida y sin PoP **no llega** a `verdictStore.get` (`:303`) ni a `resolvePayoutAuthority` (`:332`) | **`T-372-W3-3`**, que **cuenta llamadas**, no status. Molde: `T-AUTH-4`, por nombre, en `src/infrastructure/payout/authority.test.ts` (al `f295a6f`, `:235`) |

**Los que W3 roza sin tocar, y que el AR va a mirar igual:**

- **P-8** (ownership fail-closed en el momento del dinero) y **P-11** (el `verificationId` sale de la
  fila del dueño, nunca del body): los dos cuelgan de que `:303` lea la dirección **probada**. Con
  `direccionProbada` siguen enteros. ⛔ **El candado estático de `P-11` no se debilita: W3 no agrega
  el símbolo `kycVerificationId` en ningún lado** *(y `ports.ts:295-303` avisa que `tsc` solo no lo
  caza: el cierre son DOS comandos, `tsc --noEmit` **y** un `grep` de ese símbolo sobre `src/` y `app/`)*.
- **P-9** (la autoridad re-consulta en **cada** pago): intacto, `:332` no se mueve.
  🔴 **La sesión NO reemplaza esa consulta y no puede: sólo atraviesa el gate de identidad.**
- **P-10** (fail-closed ante un `reason` desconocido): intacto, el `switch` de `:335-350` no se toca.

### 5.1 · La deuda técnica que esta ola declara ANTES de que el AR la encuentre

**`TD-372-W3-ADDRESS-DEL-BODY`** — `prepare/route.ts:332` le pasa a `resolvePayoutAuthority` el
`address` **del body**, no `direccionProbada`. **Hoy es seguro porque `P3` los comparó, y `S4`
conserva exactamente esa propiedad.** Cambiarlo a `direccionProbada` sería correcto **y no habría
ningún input que distinguiera las dos versiones** ⇒ sería una línea del money-path sin testigo.
⇒ **Se declara como deuda, con `S4` y `T-372-W3-4` como su guard, y NO se cambia en esta ola.**

---

## 6 · Las waves, en orden de dependencia

> El orden **es** load-bearing. **W3.0 puede detener la ola entera, y W3.3 es un GATE DE DESPLIEGUE,
> no un paso de código.**

```
W3.0  premisa falsable (0 líneas de producción)   ── puede DETENER la ola
  │
W3.1  el módulo puro, server-only
  │
W3.2  🚦 EL RECEPTOR PRIMERO (sólo servidor)      ── se mergea y se despliega
  │
W3.3  🚦 GATE DE DESPLIEGUE: la sonda contra el servicio VIVO  ── exit 0 o no se sigue
  │
W3.4  el cliente empieza a usar la sesión         ── se mergea y se despliega
  │        └── W3.5 (copy) corre en paralelo con W3.4
W3.6  cierre
```

---

### 🔴 W3.0 · La premisa, falsable, sobre el árbol de hoy · **SERIAL · BLOQUEANTE · 0 LÍNEAS DE PRODUCCIÓN**

**Archivo: A** (`src/presentation/sesion-borra-la-segunda-firma.test.tsx`) — **crear**.

Se escribe y se corre **sin tocar una sola línea de producción**. Molde:
`src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` (768 líneas, de W1), en
particular el `it` `T-372-W1-12` (por nombre; al `f295a6f`, `:565`), que exige
`toHaveBeenCalledTimes(1)`. **W1 contaba `prepare()`; W3 cuenta `signMessage`.**

Prueba, sobre el árbol de hoy, estas **cinco** cosas:

1. En un recorrido **inyectado** completo **que cierra**, `wallet.signMessage` se invoca
   **exactamente 2 veces** para identidad: una en el connect y una antes del `prepare`.
   🔴 **Si da 1, W3 no tiene nada que borrar.**
2. `POST /api/a2a/payout/challenge` devuelve **200** con un token para una dirección **arbitraria**,
   **sin ninguna firma** (§1.1). Es la premisa que obliga al secreto propio.
3. `POST /api/payout/prepare` **no** lee ninguna cookie ni ningún header de sesión: hoy la única
   credencial de identidad que acepta son los **dos campos del cuerpo**.
4. `InMemoryPopProofStore` **no** lo lee el gateway del `prepare`: su dependencia es `PopSigner`, que
   **no tiene `peek`** ⇒ la segunda firma **no está ya saltada por otra vía**.
5. `kyc_session_tokens` **no puede** servir de sesión: se indexa por el `session_id` del proveedor
   (no por dirección), su `decision_token` **nunca sale en una respuesta HTTP**, y **no vence nunca**.

> ⛔ **SI CUALQUIERA DE LOS CINCO SALE ROJO, LA OLA SE DETIENE Y SE REPORTA AL HUMANO.**
> Significa que **la premisa del diseño es falsa**: toda W3 se apoya en que hoy hay dos firmas que
> prueban lo mismo y en que no hay ningún atajo ya construido. **No se «arregla» el test, no se
> ajusta el fixture hasta el verde, y no se sigue a W3.1.** Se para, se escribe qué salió rojo con su
> salida textual, y se escala. *(En W1 esta misma wave evitó construir sobre algo falso.)*

⚠️ **Y antes de leer un rojo como hallazgo del sujeto, medí si lo produce el entorno.** Bajo `jsdom`,
`Buffer.from(x) instanceof Uint8Array` es **false**, y eso vuelve inalcanzables varias rutas de
`@solana/web3.js`, `@noble/*` y `tweetnacl`. Un rojo así **no dice nada del código bajo prueba** y en
W1 estuvo a un paso de reportarse como *«la premisa de la ola es falsa»*. **La sonda cuesta dos
minutos; la conclusión falsa cuesta una ola.**

**Tests que entran acá:** `T-372-W3-0a`, `-0b`, `-0c`, `-0d`, `-0e` (§7).
**AC que cierra (la parte medible sobre el árbol de hoy):** ninguno todavía. **Habilita** AC-3-1.

**Tareas:**
- [ ] **T1** — Re-verificar `main` y crear la rama:
      `/usr/bin/git rev-parse HEAD` (esperado `f295a6f`), `/usr/bin/git status --porcelain` vacío, y
      `/usr/bin/git checkout -b feat/wkh-372-w3-sesion-del-servidor`.
- [ ] **T2** — Re-derivar con `sed -n 'Np'` las citas de §4 que vayas a usar. ⛔ **Ninguna cita
      `archivo:línea` se escribe sin haberla derivado en esta misma sesión.**
- [ ] **T3** — Crear el archivo **A** con el arnés del recorrido inyectado, copiado del molde de W1.
- [ ] **T4** — `T-372-W3-0a` — las **2** firmas, con `toHaveBeenCalledTimes(2)` **y el estado terminal
      del envío asertado**.
- [ ] **T5** — `T-372-W3-0b` — el challenge se emite sin firma.
- [ ] **T6** — `T-372-W3-0c` — `prepare` no lee cookie ni header.
- [ ] **T7** — `T-372-W3-0d` — `PopSigner` no tiene `peek` (es un chequeo de **tipo y de forma**, no
      de disciplina).
- [ ] **T8** — `T-372-W3-0e` — `kyc_session_tokens` no sirve de sesión.
- [ ] **T9** — Correr **el gate completo** (§8). 🔴 **Si alguno de los cinco sale rojo: PARAR y
      reportar.**
- [ ] **T10** — Matar los mutantes de esos `it` que tengan mutante (§7), uno por uno y **por
      separado**, citando **archivo · nombre del `it` · por qué murió**.

---

### W3.1 · El módulo puro, server-only · **SERIAL** (depende de W3.0 sólo por el semáforo)

**Archivos: B** (`src/infrastructure/auth/sesion-de-posesion.ts`) **y C** (su test).
Sin rutas, sin React, sin cliente.

⚠️ **B y C no se pueden fusionar con J y K, y no es preferencia:** `B` importa `node:crypto` y `J`
corre en el navegador. **Es exactamente el motivo escrito en `pop-proof-store.ts:22-33`**, donde un
literal se **duplica** en vez de importarse porque *«importarlo desde acá rompería el bundle del
browser»*.

**Contrato exacto del archivo B — esto es lo que hay que escribir, ni más ni menos:**

```ts
export const SESION_TIPO = "chaski-sesion-de-posesion-v1";
export const SESION_TTL_SECONDS = 30 * 60;

export interface SesionDePosesion {
  tipo: typeof SESION_TIPO;
  address: string;     // base58 canónico, case-sensitive
  networkId: string;   // CAIP-2, resuelto SERVER-SIDE, ⛔ NUNCA del body
  exp: number;         // epoch SEGUNDOS
}

/** `null` cuando falta PAYOUT_SESSION_SECRET ⇒ la ruta simplemente no agrega el campo.
 *  ⛔ NUNCA lanza: un emisor que tira convertiría un 200 legítimo en un 500. */
export function emitirSesionDePosesion(address: string, networkId: string, nowMs: number): string | null;

/** `null` ante CUALQUIER problema (fail-closed → 403 opaco).
 *  Mismo orden de verificación que `verifySolanaPopChallenge` (`./pop-challenge.ts:68`). */
export function verificarSesionDePosesion(token: string, nowMs: number): SesionDePosesion | null;
```

**Las cinco reglas del módulo, que van a su docblock:**

1. **Formato**: `${b64url(JSON.stringify(payload))}.${b64url(hmac(payloadB64))}`, calcado de
   `pop-challenge.ts:9-11`. ⛔ **No se inventa un formato nuevo.**
2. 🔴 **Secreto propio**: `function secret()` lee `process.env.PAYOUT_SESSION_SECRET`
   **DENTRO de la función** (para que `vi.stubEnv` funcione).
   ⛔ **PROHIBIDO leer `PAYOUT_POP_SECRET`.** *Por qué el dominio solo no alcanza: el payload del
   challenge (`pop-challenge.ts:43-48`) no tiene campo `tipo` **hoy**, pero ese payload lo edita
   cualquier HU futura sin saber que hay algo colgando de él. Con secreto propio, un cambio en el
   challenge **no puede** producir una sesión válida.*
3. **Orden de verificación, idéntico al del exemplar**: formato → secreto → **HMAC primero, con
   `expected.length !== received.length` ANTES de `timingSafeEqual`** → parse en `try/catch` → tipo de
   **cada** campo → `tipo === SESION_TIPO` → expiración. **`null` ante cualquier problema.**
4. **TTL = 30 minutos.** ⚠️ **Es una hipótesis sobre cuánto tarda el recorrido, no una medición**
   (cuánto tarda de verdad sigue **sin medir**). Por eso lo que pasa al vencerse **es lo de hoy y no
   un error** (regla 5).
5. 🔴 **La ausencia de la env es el mecanismo de orden de despliegue.** Sin `PAYOUT_SESSION_SECRET`:
   `/api/kyc/verdict` **no emite** ⇒ ningún cliente tiene sesión ⇒ todos mandan PoP; y
   `/api/payout/prepare` **no acepta** ninguna sesión ⇒ el único camino es el PoP.
   ⇒ **Desplegar el código de W3 con la env ausente es un no-op verificable. Cero flags nuevos.**

**Tests que entran acá:** `T-372-W3-9`, `T-372-W3-14`, `T-372-W3-15` (§7).
**Sale con:** el gate completo verde + los 3 mutantes con su `×` nombrado.

**Tareas:**
- [ ] **T11** — Crear **B** con el contrato de arriba y sus cinco reglas en el docblock.
- [ ] **T12** — Crear **C** con `T-372-W3-9`, `T-372-W3-14`, `T-372-W3-15`.
- [ ] **T13** — Correr el gate completo (§8).
- [ ] **T14** — Matar los 3 mutantes, **por separado**, con su `×` nombrado.

---

### W3.2 · 🚦 **EL RECEPTOR PRIMERO** — el servidor acepta las DOS formas · **el cliente NO se toca**

**Archivos: D, E, F, G, H.**

> ⛔ **NI UNA LÍNEA de `src/infrastructure/kyc/**`, `src/infrastructure/settlement/**`,
> `src/composition/**` ni `src/presentation/**` entra en esta wave.**
> **El cliente sigue mandando PoP cuando esto se despliega.** Es la lección del corte de 8 días,
> escrita como wave: si el cliente va primero, la ola da **403 a todos**.

#### D · La rama nueva de `prepare`, sitio por sitio

Dentro de `PR5'` (`:200`), **sin tocar ni una línea de `PR2`, `PR3`, `PR4`, `PR5.5`, `PR6'`, `PR7`**:

```
PR5'  (:200)
  ├─ if (!POP_SECRET) → 503            ← ⛔ SE QUEDA EXACTAMENTE DONDE ESTÁ (:214)
  ├─ if (body.sessionToken presente)   ← rama nueva: S1..S5
  │     S1  presencia + tipo string no vacío          → 403 payout_pop_unverified
  │     S2  verificarSesionDePosesion(...) === null   → 403  (mismo enum, mismo cuerpo)
  │     S3  sesion.tipo === SESION_TIPO               → 403
  │     S4  address match  (EL EQUIVALENTE DE P-3)    → 403
  │     S5  networkId === resolveSolanaNetworkId()    → 403
  └─ else                              ← rama de hoy, BYTE-IDÉNTICA: P1..P5 (:221-256)
  ⇒ const direccionProbada = <de la sesión, o ch.address>
PR5.5 (:259) … y :303 pasa a leer `direccionProbada` en vez de `ch.address`
```

| Guard | Qué mira | Enum / status | ⚠️ La trampa |
|---|---|---|---|
| **S1** | presencia + tipo string no vacío de `body.sessionToken` | `payout_pop_unverified` / 403 | 🔴 ⛔ **Un `sessionToken` presente NO habilita caer al PoP si falla: se corta.** Si no, un atacante manda una sesión rota **más** un PoP robado y **elige el camino** |
| **S2** | `verificarSesionDePosesion(token, Date.now())` ⇒ `null` | ídem | El `exp` vive **adentro** del verificador, como en `pop-challenge.ts:105` |
| **S3** | `sesion.tipo === SESION_TIPO` | ídem | 🔴 **Acá muere un `popChallenge` crudo.** Aunque el secreto propio ya lo mate, este guard es el que **se lee como intención** |
| **S4** | `canonicalizeAddress(sesion.address) === canonicalizeAddress(address)`, en `try/catch` | ídem | 🔴 **ES `P-3`.** ⛔ El binding es la dirección **probada**, jamás un campo del cuerpo |
| **S5** | `sesion.networkId === resolveSolanaNetworkId()` | ídem | ⛔ **Server-side. NUNCA del body.** Se **importa** `resolveSolanaNetworkId` de `src/infrastructure/chain.ts:32` |

⛔ **PROHIBIDO agregar un enum de error nuevo.** Los cinco fallos colapsan en el **mismo**
`payout_pop_unverified` con el **mismo cuerpo**.
⛔ **`if (!POP_SECRET) → 503` no se mueve ni se vuelve condicional.** Moverlo también rompería el `it`
que recorre el orden de guards en `app/api/payout/prepare/route.test.ts` (bloque de `:947-972` al
`f295a6f`), **y ese rojo sería correcto**.

#### F · La emisión, en `kyc/verdict`

- Se acuña **aguas abajo de `:150`** (`const owner = canonicalizeAddress(ch.address)`), o sea
  **después** de que `P1..P5` pasaron.
- Se agrega como campo `sesion` a los **cinco** `return … 200` (`:204`, `:208`, `:222`, `:282`,
  `:284`).
- ⛔ **Nunca en un 403 ni en un 503.**
- ✅ **Y sí en los `absent`**: 🔴 **la sesión prueba POSESIÓN, no verificación.** Que la persona esté
  verificada lo sigue decidiendo `resolvePayoutAuthority` en **cada** pago (**P-9**, intacto).
- ⛔ **Cero rutas nuevas.** *Por qué no `POST /api/a2a/payout/session`: exigiría una **sexta** copia
  del bloque `P1..P5` (ya hay cinco: `payout/prepare`, `kyc/verdict`, `kyc/session`, `payout/status`,
  `solana/escrow/remittance-ids`). Por qué no `/api/kyc/session`: ahí el PoP es **opcional a
  propósito**, así que la mitad de sus callers no probó nada.*

#### H · `.env.example`

Documenta `PAYOUT_SESSION_SECRET` en el estilo del archivo (hoy `PAYOUT_POP_SECRET=` está en `:398`,
con su bloque de prosa arriba). **Tiene que decir, con estas tres cosas:** qué es, que **su ausencia
es un no-op verificable**, y ⛔ **que NO puede tener el mismo valor que `PAYOUT_POP_SECRET`.**

**Tests que entran acá:** `T-372-W3-2`, `-3`, `-4`, `-5`, `-13` (§7).
**AC que cierra:** **AC-3-2** entero; la mitad servidor de **AC-3-3**.
**Sale con:** el gate completo **y Δ0 verificado en los archivos de cliente**
(`/usr/bin/git diff --stat main...HEAD` ⇒ **0 líneas** de `src/infrastructure/kyc/`,
`src/infrastructure/settlement/`, `src/composition/`, `src/presentation/`).

**Tareas:**
- [ ] **T15** — **D**: escribir `S1..S5` dentro de `PR5'`, y `direccionProbada` en `:303`.
- [ ] **T16** — **F**: acuñar la sesión tras `:150` y agregarla a los **cinco** `200`.
- [ ] **T17** — **H**: documentar la env nueva.
- [ ] **T18** — **E** y **G**: los `it` de `T-372-W3-2`, `-3`, `-4`, `-5`, `-13`.
- [ ] **T19** — Correr el gate completo (§8).
- [ ] **T20** — Matar los mutantes de esos 5 tests. 🔴 **Los de `S3` y `S4` se corren POR SEPARADO**:
      un mutante que rompa el parseo mata el mismo `it` **sin probar el binding**.
- [ ] **T21** — Verificar Δ0 en los archivos de cliente con `git diff --stat`.
- [ ] **T22** — **Mergear y desplegar.** Después, **el founder** pone `PAYOUT_SESSION_SECRET` en el
      proveedor. ⚠️ **Dónde vive esa env en producción y quién la pone es una acción del founder, y
      hoy está sin resolver.** No bloquea escribir código; **bloquea W3.3.**

---

### W3.3 · 🚦 **GATE DE DESPLIEGUE** — la sonda contra el servicio VIVO · **0 LÍNEAS DE PRODUCCIÓN**

**Archivo: I** (`scripts/probe-sesion-de-posesion.mjs`), corrido **contra la URL desplegada**.

> ⚠️ **Por qué esto no es opcional, y por qué no lo reemplaza `npm test`:** `chaski-v3` **no tiene
> suite e2e de navegador**, y sus tests doblan `fetch` con `vi.stubGlobal`. **Un test con un doble no
> prueba el cableado.** W3 **cambia un contrato cliente-servidor** ⇒ hace falta un instrumento que
> hable con el servidor **de verdad**.
> **Molde de red:** `wasiai-a2a/scripts/probe-money-path.mjs`.
> **Molde de atribución:** `chaski-v3/scripts/probe-vuelta-por-enlace.mjs`.

**Tres afirmaciones, contra el deploy de W3.2, con la env ya puesta:**

| | Qué manda | Qué se exige |
|---|---|---|
| **(a)** | Un **PoP válido** | El **mismo desenlace** que antes de W3.2 ⇒ **no se rompió nada** |
| **(b)** | Una **sesión válida** emitida por ese mismo servidor | El **mismo desenlace** que (a) |
| **(c)** | **Ni sesión ni PoP** | **403**, con el **mismo cuerpo** para un `kycVerificationId` real, uno ajeno y uno inventado |

**Códigos de salida — la atribución es el punto del script:**

```
exit 0    las tres afirmaciones ok
exit 10   (b) el servidor NO acepta la sesión
exit 11   (a) se rompió el camino del PoP
exit 12   (c) dejó de cortar
exit 30   EL INSTRUMENTO NO PUDO CORRER  ← ⛔ Y ESO NO ES UN VERDE
```

⛔ **`exit 30` NO ES UN VERDE.** Es la lección del cero uniforme: **un barrido que no ejecutó nada y
un barrido que no encontró nada se ven igual.** Causas típicas de `30`: la URL no responde, la env
todavía no está puesta, el deploy no terminó, no hay red. **Ninguna de esas es «pasó».**

🔴 **W3.4 NO ARRANCA HASTA QUE ESTE PROBE SALGA `0`.** Al revés, el cliente deja de mandar la prueba
**antes** de que el servidor acepte su reemplazo ⇒ **403 `payout_pop_unverified` para TODOS, ningún
envío llega a `prepare`, corte total del producto.** Es el corte de 8 días de agosto.

**Requisitos del script, escritos para que no se lo lea de más:**
- ⛔ **Sin dobles de `fetch`.** Si el script mockea algo, deja de ser un probe.
- ⛔ **No se cablea a CI y no se afirma que lo esté.** Se corre **a mano**:
      `node scripts/probe-sesion-de-posesion.mjs <URL>`.
- ✅ **Su docblock declara sus límites ANTES de que alguien lea su `exit 0`**, en el estilo de
      `probe-vuelta-por-enlace.mjs`: corre desde una consola, no desde un teléfono; no prueba la UI;
      y no dice nada sobre cuánto tarda un recorrido real.
- ⚠️ **`biome lint` SÍ lo mira** (`lint` = `biome lint src app scripts`).
      **`typecheck:scripts` NO** (`tsconfig.scripts.json` incluye sólo `scripts/**/*.ts`).

**Test que entra acá:** `T-372-W3-12` (§7).
**AC que cierra:** el orden de despliegue (la CD que dice que el receptor va primero).

**Tareas:**
- [ ] **T23** — Crear **I** con las tres afirmaciones y los cinco códigos de salida.
- [ ] **T24** — Correr el gate completo (§8): el `.mjs` nuevo tiene que pasar **lint**.
- [ ] **T25** — Correr el probe contra el deploy de W3.2. 🔴 **Registrar el código de salida textual
      en el reporte.**
- [ ] **T26** — 🚦 **GATE:** si el código **no es `0`**, ⛔ **W3.4 NO ARRANCA.** Se reporta el código,
      qué afirmación falló, y se para. **`exit 30` cuenta como no-arranca.**

---

### W3.4 · El cliente empieza a usar la sesión · **depende de que W3.3 haya salido `0`**

**Archivos: J, K, L, M, N, O, P, Q, R, S.**

#### J + L · El almacén y sus puertos

`InMemorySesionStore implements SesionReader, SesionRecorder`, **calcado de `InMemoryPopProofStore`**
(`pop-proof-store.ts:47-84`): `Map` por address, reloj **inyectado** vía el puerto `Clock`
(`ports.ts:975`), `peek()` que **borra la vencida**, y `if (!Number.isFinite(ahora)) return null;`.

```ts
// van AL FINAL de src/application/ports.ts (⚠️ ese archivo recibe 17 citas ancladas)
export interface SesionReader   { peek(address: string): string | null; }
export interface SesionRecorder { record(address: string, token: string): void; }
```

⛔ **La separación es por TIPO, no por disciplina.** El lector **no tiene** `record`; el escritor
**no tiene** `peek`. ⛔ **PROHIBIDO un puerto único con los dos métodos, aunque parezca más simple.**
*(Es el mismo patrón que `ports.ts:137-149` ya declara, con su razón: «no depende de que nadie lo
llame, depende de que el método NO EXISTA en el tipo».)*

🔴 **En memoria, y ⛔ NUNCA en `localStorage`, `sessionStorage`, `IndexedDB`, una cookie ni la URL.**
Tres razones que se refuerzan:
1. Una sesión que sobrevive a una recarga **saltearía la PRIMERA firma** y rompería **AC-3-5**.
   En memoria, **AC-3-5 se cumple por construcción**, sin un guard que alguien tenga que recordar.
2. Es una credencial bearer: at-rest en el navegador es superficie que no hace falta abrir.
3. 🔴 **El camino por enlace pierde la sesión en cada salto** (el árbol de React se remonta)
   ⇒ **cae al PoP solo, sin escribir una línea** ⇒ **el respaldo por enlace conserva exactamente el
   comportamiento de hoy, gratis.**

⛔ **La sesión viaja en el CUERPO, no en una cookie.** Dos razones: (a) el repo no tiene **ninguna**
infraestructura de cookies (medido), y (b) una cookie que el navegador adjunta sola a
`POST /api/payout/prepare` **crea una superficie de CSRF que hoy no existe**, porque hoy la
credencial es un campo del cuerpo que un sitio de terceros no puede fabricar.

#### M · El gateway del veredicto registra la sesión

`HttpKycVerdictGateway` recibe un `SesionRecorder` como **segundo** argumento del constructor
(`:56`). Registra el campo `sesion` del body **justo después de `const body = (await res.json())`** y
**antes** de la rama `!v`, para que los cinco `200` queden cubiertos con **una sola** escritura.
⛔ **El `catch` de `:83` NO se estrecha.** ⛔ **Un `sesion` ausente o de tipo raro no es un error:
simplemente no se registra nada.**

#### O · El gateway del prepare la usa, y el reintento

1. **Antes** del bloque `if (input.proof)` de `:241`, consultar `this.sesiones.peek(input.address)`.
2. Si hay token ⇒ **el body lleva `sessionToken` y ⛔ NO se llama `prove()`**.
   ⛔ **Y no se manda `sessionToken: undefined` «igual»**: el campo o está, o no está.
3. Si no hay token ⇒ **exactamente el camino de hoy**, byte por byte.
4. 🔴 **El reintento, y por qué existe:** el **repliegue** de esta ola es *quitar
   `PAYOUT_SESSION_SECRET` del proveedor*. En ese instante el servidor deja de aceptar las sesiones
   ya emitidas, y los clientes que tienen una en memoria recibirían **403** sin reintentar.
   ⇒ ⛔ **El gateway reintenta UNA sola vez, sin `sessionToken`, y sólo cuando (a) mandó
   `sessionToken` y (b) la respuesta fue 403.** Un reintento, acotado a ese caso, **con su `it`**
   (`T-372-W3-17`). ⛔ **Nada de bucles, nada de reintentos en otros status.**
   *(Va adentro del bloque que abre en `:283` con `if (!res.ok) {`.)*

#### Q · El cableado — **Δ0**

⛔ **En las líneas que YA existen:** `container.ts:106` (instanciar el almacén **en esa misma línea
física**, al lado de `popProofs`), `:161` (pasárselo al `HttpSolanaPayoutPrepareGateway`) y `:185`
(pasárselo al `HttpKycVerdictGateway`). 🔴 **Es `:106`, no `:307`** (§0.2/C-2).
🔴 **Tiene que ser LA MISMA instancia en los dos**, o la sesión nunca se lee. Lo mide `T-372-W3-16`.

⛔ **El PoP NO se retira.** Se retira al final de todo, o nunca. **No es de esta ola.** El `else` de
`prove()` queda entero.

**Tests que entran acá:** `T-372-W3-1`, `-6`, `-7`, `-8`, `-16`, `-17` (§7).
**AC que cierra:** **AC-3-1**, la mitad cliente de **AC-3-3**, y **AC-3-5**.
**Sale con:** el gate completo + los 6 mutantes con su `×`. **Se mergea y se despliega. Segundo empuje.**

**Tareas:**
- [ ] **T27** — Crear **J** (calcado de `pop-proof-store.ts`) y agregar los dos puertos **al final**
      de **L**.
- [ ] **T28** — Crear **K** con `T-372-W3-7`.
- [ ] **T29** — **M** + **N**: registrar la sesión y su test.
- [ ] **T30** — **O** + **P**: `peek()`, `sessionToken`, el reintento único, y sus tests
      (`T-372-W3-6`, `T-372-W3-17`).
- [ ] **T31** — **Q** (Δ0 en `:106`, `:161`, `:185`) + **R** (`T-372-W3-16`) + **S** (el doble).
- [ ] **T32** — Volver al archivo **A** y agregar `T-372-W3-1` y `T-372-W3-8`
      *(ahora sí hay cliente que medir).*
- [ ] **T33** — Correr el gate completo (§8).
- [ ] **T34** — Matar los 6 mutantes, **por separado**, con su `×` nombrado.

---

### W3.5 · El copy de `AC-3-6` · **paralelizable con W3.4** · entra entero o no entra

**Archivos: T** (`flow.tsx`, 🔴 **Δ0 ESTRICTO**) **y U** (`wallet-availability.test.tsx`).

⚠️ **Antes de escribir una palabra: leé los guards que vigilan esta pantalla** (§4.8). `T-065-21` va a
ponerse rojo, **y ese rojo es correcto**. ⛔ **No se afloja la comparación de `innerHTML`.**

**Las cuatro frases, textuales y finales. Se importan de UNA constante, ⛔ nunca se escriben dos veces:**

1. *"Te vamos a pedir una firma para confirmar que la billetera es tuya."*
2. *"Es gratis."*
3. *"No mueve tus USDC ni autoriza ningún pago."*
4. *"Si te la volvemos a pedir, es por lo mismo: confirmar que es tuya."*

**Se muestran las CUATRO, siempre, en `"injected"` y en `"none"`. ⛔ Sin gate** (§2.3).

**El checklist de la copy, marcable:**
- [ ] Español rioplatense.
- [ ] **Sin em dashes.**
- [ ] ⛔ **Ninguna dice que algo falló, ni usa un verbo en pasado sobre haber revisado.**
      *(Y por eso W3 **no agrega ni un solo string** para el vencimiento de la sesión: cuando vence,
      la persona ve el prompt de su billetera igual que siempre, y no puede distinguirlo del
      funcionamiento normal. **Esa ausencia es la decisión.**)*
- [ ] ⛔ **Ninguna dice *"el remitente no necesita SOL"*.**
- [ ] ⛔ **Ninguna vuelve falso el `<h2>Tu plata no pasa por Chaski</h2>`** de `bienvenida.tsx:232`.
- [ ] 🔴 **Cada frase tiene el input concreto que la pondría en rojo.** *(Una frase corregida sigue
      pudiendo ser falsa. Si no existe el input, la frase se recorta hasta que exista.)*

**Dónde entra, con Δ0:** en `flow.tsx:963`, la línea física del paso `connect` que ya contiene el
selector de enlace y `<NoWalletHere …/>`. ⛔ **Todo entra en esa línea que ya existe.** Al terminar,
`/usr/bin/wc -l src/presentation/flow.tsx` tiene que seguir dando **4453**.

**Tests que entran acá:** `T-372-W3-10` (**U**) y `T-372-W3-10b` (**A**).
**AC que cierra:** **AC-3-6**, con la cuarta afirmación reformulada (§2.3).

**Tareas:**
- [ ] **T35** — Leer `T-UI-1..4`, `T-065-21` y `T-065-21b` en `wallet-availability.test.tsx`
      **antes** de escribir la copy.
- [ ] **T36** — **T**: las 4 frases en `flow.tsx:963`, importadas de la constante, **Δ0**.
- [ ] **T37** — **U**: `T-372-W3-10` + la actualización **deliberada** de `T-065-21`.
- [ ] **T38** — **A**: `T-372-W3-10b`, el testigo de que la frase 4 es verdadera.
- [ ] **T39** — `/usr/bin/wc -l src/presentation/flow.tsx` ⇒ **4453**. Verificado con `wc -l`,
      ⛔ **no leyendo el diff.**
- [ ] **T40** — Correr el gate completo (§8) + matar los 2 mutantes.

---

### W3.6 · Cierre

**Archivos: V1** (`README.md:436`) **y V2** (`README.es.md:462`).

**Tareas:**
- [ ] **T41** — Correr el candado **con el binario local**:
      `./node_modules/.bin/vitest run src/composition/readme-test-count.test.ts`
      y **leer del rojo** el número nuevo. ⛔ **No lo cuentes a mano.**
      *(Referencia: hoy son **167**; W3 crea 3 archivos de test (A, C, K), así que lo esperable es
      **170** — pero **el que vale es el que devuelve el candado corriendo**, no éste.)*
- [ ] **T42** — Escribir ese número en `README.md:436` (`**N test files**`).
- [ ] **T43** — Escribirlo en `README.es.md:462` (`**N archivos de test**`), **por separado**.
      *(El candado los mide por separado a propósito: el modo de falla de una traducción parcial no
      es decir algo falso, es **OMITIR**.)*
- [ ] **T44** — Re-derivar los marcadores `[[CENSO …]]` **después del último commit de código**:
      🔴 `[[CENSO src/presentation/flow.tsx lineas=4453]]` **NO debe cambiar**. Si cambió, se rompió Δ0.
      ⚠️ `[[CENSO src/presentation/flow.tsx entrantes=155]]` **SÍ cambia** si escribiste citas
      ancladas nuevas hacia `flow.tsx`, y el marcador vive en **siete** sitios (§0.3).
      ⛔ Los **seis** marcadores de `solana-wallet.ts` **no se tocan**: ese archivo no se editó.
- [ ] **T45** — Re-derivar **todas** las citas `archivo:línea` nuevas que hayas escrito en código,
      comentarios o docblocks, con `sed -n 'Np'`, **después de la última edición**.
      ⚠️ **En W1 se rompieron citas propias con la propia edición, dos veces.** Y las de **este**
      documento, que vive en el otro repo, **no las vigila nada.**
- [ ] **T46** — `git add -A` y correr **el gate completo, entero y en orden** (§8), incluido
      `npm run build`.
- [ ] **T47** — Verificar el Scope OUT con
      `/usr/bin/git diff --stat main...HEAD` ⇒ **0 líneas** de todo lo listado en §3.2, y
      **0 archivos bajo `public/`**.
- [ ] **T48** — Contrastar el presupuesto de §9 en **las dos** magnitudes: **líneas** y **archivos**.

---

## 7 · Plan de tests — cada uno con su `it`, su mutante nombrado y su falso KILLED

> ⛔ **Regla transversal 1:** todo mutante **se verifica en disco antes de correr nada**, y se
> **aborta** si el patrón no aparece **exactamente una vez**. *Un mutante que no matcheó, más una
> suite verde, son indistinguibles de un control que funciona.*
> ⛔ **Regla transversal 2:** el arnés de mutación **no cachea un `.orig`**. El control es **contra el
> árbol de git**. *(En W1, un restaurador con `if not exists` revirtió una ola entera en silencio, y
> el `md5` contra el snapshot equivocado confirmó el revert en vez de cazarlo.)*
> ⛔ **Regla transversal 3:** **ningún guard puede leerse a sí mismo.** Si un `it` busca un literal en
> la misma línea donde ese literal aparece, **nunca puede fallar**.
> ⛔ **Regla transversal 4:** un `exit=1` **sin un `×` nombrado no es un KILLED**. Si el mutante muere
> por un error de sintaxis, por un guard vecino, o por un fixture que ya daba verde sin el arreglo,
> es **falso KILLED y no cuenta**. Se cita **archivo · nombre del `it` · por qué murió**.
> ⛔ **Regla transversal 5:** la cobertura se cierra **por expresión**. Por cada decisión distinta que
> toma una expresión nueva, **un `×` nombrado con su mitad negativa**.

| Test | AC / control | Archivo | Qué afirma | **Mutante que lo tiene que matar** | **Falso KILLED a evitar** |
|---|---|---|---|---|---|
| `T-372-W3-0a` | premisa | **A** | Hoy, en un recorrido inyectado que **cierra**, `signMessage` se llama **exactamente 2 veces** para identidad | *(es medición, no hay mutante)* | 🔴 Si el fixture **no llega al estado terminal**, cuenta 1 y **la premisa parece falsa**. ⛔ **Se exige assertar el estado terminal del envío** |
| `T-372-W3-0b` | premisa | **A** | El emisor del challenge devuelve **200** para una address arbitraria **sin ninguna firma** | *(medición)* | Un 200 que venga de un doble no mide nada: se ejercita el handler real |
| `T-372-W3-0c` | premisa | **A** | `prepare` **no** lee cookie ni header de sesión: la única credencial son los dos campos del cuerpo | *(medición)* | Un `it` que sólo lea el archivo es prosa. **Se manda un request con cookie y header y se verifica que no cambian nada** |
| `T-372-W3-0d` | premisa | **A** | `PopSigner` **no tiene `peek`** ⇒ la segunda firma no está ya saltada por otra vía | *(medición)* | ⚠️ Un guard de existencia que **importa lo que vigila** muere por **colapso del resolvedor de módulos**, no por aserción, **y eso no cuenta**. La pregunta previa: *¿qué otro control podría estar matando a este mutante?* |
| `T-372-W3-0e` | premisa | **A** | `kyc_session_tokens` **no puede** servir de sesión (índice por `session_id`, token que nunca sale por HTTP, sin vencimiento) | *(medición)* | ⛔ No se lee de la migración por prosa: se ejercita `getForOwner` |
| `T-372-W3-1` | **AC-3-1** | **A** | Con el almacén cableado, el **mismo** recorrido llama `signMessage` **exactamente 1 vez** | Hacer que `peek()` devuelva siempre `null` ⇒ vuelve a **2** | ⛔ `toHaveBeenCalled()` **no sirve**: tiene que ser `toHaveBeenCalledTimes(1)` |
| `T-372-W3-2` | **AC-3-2** | **E** | Un `popChallenge` **crudo del emisor real** presentado como `sessionToken` ⇒ **403**; **y control positivo: ese MISMO token sigue sirviendo como `popChallenge` y da 200** | **(i)** borrar el chequeo de `S3`; **(ii)** hacer que `secret()` lea `PAYOUT_POP_SECRET`. ⛔ **Se corren POR SEPARADO** | 🔴 **Sin el control positivo, un verificador que rechace TODO da verde.** Es el `it` más importante de la ola |
| `T-372-W3-3` | **AC-3-2 / P-6 / P-7** | **E** | Sin sesión y sin PoP: un `kycVerificationId` real, uno ajeno y uno inventado ⇒ **mismo status y mismo cuerpo byte a byte**, y **cero** llamadas al proveedor de identidad | Mover la rama de identidad **por debajo** de `PR5.5` | ⛔ Comparar sólo el status: los tres darían 403 con **cuerpos distintos**. **Se comparan los cuerpos entre sí y se cuentan los fetch.** Moldes: `T-PR-4`, por nombre, en `app/api/payout/prepare/route.test.ts` (al `f295a6f`, `:1673`) y `T-EP-3`, por nombre, en `app/api/kyc/verdict/route.test.ts` (al `f295a6f`, `:203`) |
| `T-372-W3-4` | 🔴 **P-3** | **E** | Una sesión de **A** presentada con `address` = **B** ⇒ **403**, y `verdictStore.get` **no se llama** | Borrar `S4` | Un mutante que rompa el **parseo** mata el mismo `it` **sin probar el binding**. ⛔ **Se corre por separado del de `S3`.** Molde: `T-EP-6`, por nombre, en `app/api/kyc/verdict/route.test.ts` (al `f295a6f`, `:263`) |
| `T-372-W3-5` | **AC-3-3** | **E** | Una sesión **vencida** ⇒ 403 con el **mismo cuerpo** que sin sesión; **y el mismo request con PoP válido ⇒ 200** | Quitar la comprobación del `exp` | ⛔ El `it` construye la sesión vencida **con el emisor real** y un reloj adelantado. **Nunca con un string escrito a mano** |
| `T-372-W3-6` | **AC-3-3** | **P** | Sin sesión en el almacén, el gateway **pide la firma** (`prove` llamado **1** vez) y el body viaja **sin** la propiedad `sessionToken` | Mandar `sessionToken: undefined` igual en el body | `toHaveBeenCalled()` sin contar **deja pasar 2**. Y se verifica **la ausencia de la propiedad**, no que valga `undefined` |
| `T-372-W3-7` | **AC-3-3** | **K** | `peek()` devuelve `null` para «no hay» **y** para «venció», **borra** la vencida, y un reloj ilegible cae **del lado seguro** (⛔ nunca «válida para siempre») | **(i)** cambiar `>=` por `>` en la comparación del TTL; **(ii)** borrar el `Number.isFinite` | ⛔ Es el patrón que **ya existe** en `src/infrastructure/auth/pop-proof-store.test.ts`: **se copia, no se inventa** |
| `T-372-W3-8` | 🔴 **AC-3-5** | **A** | Tras una **recarga** (almacén nuevo), la **primera** firma **se vuelve a pedir** | Persistir la sesión en `localStorage` | Un `it` que sólo mire el almacén **no prueba el recorrido**: ⛔ **monta el árbol dos veces** |
| `T-372-W3-9` | secreto propio | **C** | Con **sólo** `PAYOUT_POP_SECRET` puesta, `emitir` devuelve `null` **y** `verificar` devuelve `null` | `secret()` cae a `PAYOUT_POP_SECRET` | ⛔ Un `it` que ponga las dos envs **con el mismo valor** no distingue nada |
| `T-372-W3-10` | **AC-3-6** | **U** | En el paso `connect` aparecen **las cuatro** frases, **en `"injected"` Y en `"none"`** | Borrar la frase 4 de la constante | ⛔ **Prohibido `toContain("…")` con el texto escrito en el `it`**: sería el guard leyéndose a sí mismo. **Se importa la constante** |
| `T-372-W3-10b` | 🔴 **AC-3-6 · la VERDAD de la frase 4** | **A** | En un recorrido completo, **toda** invocación de `signMessage` es una prueba de posesión (el mensaje que se firma es el que construye el constructor de mensajes PoP, y **no contiene monto ni beneficiario**) | Hacer que el paso `connect` firme un mensaje arbitrario ⇒ rojo | 🔴 **Sin este `it`, la frase 4 es prosa.** Y el `it` **importa** el constructor del mensaje PoP; ⛔ **no reescribe el mensaje a mano** |
| `T-372-W3-11` | **AC-3-4** | — | 🔴 **DEFERIDO. No hay test y no hay instrumento en esta ola** (§2.2) | — | ⛔ **«No se pudo preguntar» NUNCA es «no».** Toda medición externa tiene **tres** desenlaces |
| `T-372-W3-12` | orden de despliegue | **I** | Contra el servidor **desplegado**: (a) PoP válido, (b) sesión válida, (c) ninguna ⇒ 403 | — | ⛔ **Un doble de `fetch` no prueba el cableado: ésa es la razón de existir de este script.** Y ⛔ **`exit 30` no es un verde** |
| `T-372-W3-13` | **P-1** | **E** | El rate-limit corre **antes** de que la rama de sesión toque nada | Subir la rama de sesión **por encima** de `PR3` | ⛔ **Contar llamadas al limiter**, no leer el orden del archivo |
| `T-372-W3-14` | HMAC | **C** | Round-trip: `emitir` → `verificar` devuelve los **4** campos; un token con **un byte cambiado en el MAC** ⇒ `null`; con **el payload cambiado** ⇒ `null` | **(i)** comparar el MAC con `===` en vez de `timingSafeEqual`; **(ii)** quitar el chequeo de longitud | ⛔ Un `it` que sólo pruebe un token basura **da verde con un verificador que devuelva `null` siempre**. **Se exige la mitad positiva** |
| `T-372-W3-15` | CAIP-2 | **C** | El `networkId` del token se compara contra `resolveSolanaNetworkId()`, **nunca** contra un literal | Aceptar cualquier `networkId` | ⛔ El `it` **importa** `resolveSolanaNetworkId` de `src/infrastructure/chain.ts:32`; **no escribe `"solana:devnet"`** |
| `T-372-W3-16` | cableado | **R** | El contenedor **real** inyecta **la MISMA instancia** del almacén al gateway del veredicto y al del prepare | Inyectar **dos instancias distintas** ⇒ la sesión nunca se lee | ⚠️ Este `it` se cita **siempre con su archivo**: hay `T-CABLE-*` en `src/composition/container.test.ts` **y** en `src/presentation/wallet-availability.test.tsx` |
| `T-372-W3-17` | repliegue limpio | **P** | Ante un **403** con `sessionToken` mandado, el gateway reintenta **UNA** vez **sin** él; ante un 403 **sin** `sessionToken`, **no reintenta**; ante un 500 con sesión, **no reintenta** | Quitar la condición de status ⇒ reintenta en cualquier `!res.ok` | ⛔ Un `it` con **sólo** el caso positivo deja pasar un bucle. **Se exigen las tres ramas**, y se cuenta `fetch` con `toHaveBeenCalledTimes` |
| — | Δ0 de `flow.tsx` | *(ya existe)* | 4453 líneas | — | ⛔ **NO se escribe un guard nuevo.** Ya lo hace `src/composition/citas-ancladas.test.ts:331` con `[[CENSO … lineas=4453]]`. Duplicarlo son **dos números que se corrigen por separado** |

⚠️ **Y lo que estos tests NO prueban, dicho antes de que alguien lea su verde de más:**
**ninguno corre en un teléfono**, y **ninguno excepto `T-372-W3-12` habla con un servidor de verdad**.
Siguen **sin medir**: si Phantom soporta SIWS por enlace profundo, cuánto tarda de verdad un recorrido
real, y si **30 minutos alcanzan**.

---

## 8 · El gate del repo — completo y en orden

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
/usr/bin/git add -A          #  ⚠️ IMPRESCINDIBLE: el gate se mide contra el ÍNDICE de git
npm run qa                   #  = lint → typecheck → typecheck:scripts → test   (package.json:20)
npm run build                #  = next build --webpack                          (package.json:10)
```

⚠️ **Se mide contra el índice de git: `git add -A` ANTES.** Correrlo antes del `git add` es correrlo
sobre un árbol donde el entregable **no existe**, y **da verde**.

⛔ **PROHIBIDO `npx biome` y `npx tsc` sueltos.** `npx` intenta bajar paquetes inexistentes y devuelve
un error que **se lee como fallo del gate**. **El orquestador cayó en esto hoy.**
⇒ Usá los binarios locales: `./node_modules/.bin/vitest`, `./node_modules/.bin/biome`,
`./node_modules/.bin/tsc`, o los scripts de `package.json`.

⛔ **Correr las partes de un gate no es correr el gate.** `lint` va **primero** y es el eslabón que
nadie alcanza: en este ecosistema un `import` sin usar pasó `tsc --noEmit` **y** `vitest`, y lo cazó
**`biome lint`**. Sobrevivió cinco revisiones.

⚠️ **Flake preexistente, 7-13 %:** en `src/presentation/vuelta-por-enlace-carrera.test.tsx`, los dos
`it` que empiezan con **`PUERTA 1 ·`** y **`PUERTA 2 ·`** (por nombre; al `f295a6f`, `:259` y `:279`).
**No es de esta HU.**
⛔ **NO se pone en cuarentena.** Si sale rojo **ahí y sólo ahí**, se re-corre **ese archivo solo**
antes de investigar nada, y se declara en el reporte **con la frecuencia medida y un denominador que
no sea chico**. *(En W1 casi se reportó haber empeorado un flake con un denominador de 10.)*

⚠️ **Dos rojos que W3 provoca a propósito, y que NO son regresiones:**
1. `src/composition/readme-test-count.test.ts` — porque W3 crea 3 archivos de test. Se arregla
   escribiendo el número nuevo en los **dos** README (T41-T43).
2. `T-065-21`, en `src/presentation/wallet-availability.test.tsx` — porque compara el `innerHTML` del
   paso `connect` entero y W3.5 le agrega copy. **Se actualiza a propósito.**
   ⛔ **No se afloja la comparación.**

🔴 **Y ante cualquier `it` verde que se ponga rojo con W3, la primera pregunta NO es «¿qué rompí?»,
es «¿qué defecto estaba compensando ese verde?».** *(En W1, un `it` no estaba mal escrito: medía bien
un comportamiento equivocado, y por eso su verde no protegía nada. Un test que pinnea el
comportamiento actual **congela lo que haya, bug incluido**.)*

---

## 9 · Escala esperada del diff — el presupuesto, para tenerlo a la vista MIENTRAS escribís

> ⚠️ **W1 se pasó 2,21x de su presupuesto**, y el cruce fue invisible porque **cada fix-pack se medía
> contra sí mismo**. Un fix-pack de 451 líneas movió la ola de 1,74x a 2,21x sin que nadie lo viera.
> ⛔ **El presupuesto se contrasta en CADA fix-pack, no sólo al cerrar, y en LAS DOS magnitudes.**
> ⛔ **Todo número publicado se re-mide contra el árbol. Nunca sumando deltas** *(sumar un delta a un
> número anterior cuenta dos veces las líneas reemplazadas, y el error es invisible porque el
> resultado parece razonable).*

| Archivo | Añadidas | Borradas | Δ neto |
|---|---:|---:|---:|
| **A** `sesion-borra-la-segunda-firma.test.tsx` (nuevo) | 330 ± 90 | 0 | +330 |
| **B** `sesion-de-posesion.ts` (nuevo) | 115 ± 30 | 0 | +115 |
| **C** `sesion-de-posesion.test.ts` (nuevo) | 180 ± 50 | 0 | +180 |
| **D** `app/api/payout/prepare/route.ts` | 50 ± 15 | 2 | +48 |
| **E** `app/api/payout/prepare/route.test.ts` | 210 ± 60 | 0 | +210 |
| **F** `app/api/kyc/verdict/route.ts` | 28 ± 10 | 5 | +23 |
| **G** `app/api/kyc/verdict/route.test.ts` | 120 ± 40 | 0 | +120 |
| **H** `.env.example` | 16 | 0 | +16 |
| **I** `scripts/probe-sesion-de-posesion.mjs` (nuevo) | 130 ± 35 | 0 | +130 |
| **J** `sesion-store.ts` (nuevo) | 75 ± 20 | 0 | +75 |
| **K** `sesion-store.test.ts` (nuevo) | 110 ± 30 | 0 | +110 |
| **L** `ports.ts` | 16 | 0 | +16 |
| **M** `http-kyc-verdict-gateway.ts` | 45 ± 15 | 1 | +44 |
| **N** `http-kyc-verdict-gateway.test.ts` | 40 ± 10 | 0 | +40 |
| **O** `http-solana-prepare-gateway.ts` | 60 ± 20 | 1 | +59 |
| **P** `http-solana-prepare-gateway.test.ts` | 85 ± 25 | 0 | +85 |
| **Q** `container.ts` | 3 | 3 | **0** |
| **R** `container.test.ts` | 45 ± 15 | 0 | +45 |
| **S** `fakes.ts` | 18 | 0 | +18 |
| **T** `flow.tsx` | 4 | 4 | 🔴 **0** (Δ0 obligatorio, ≈ +700 caracteres) |
| **U** `wallet-availability.test.tsx` | 65 ± 20 | 4 | +61 |
| **V1+V2** `README.md` + `README.es.md` | 2 | 2 | 0 |
| **TOTAL** | **~1.747** | **~22** | **~+1.725** |

**Presupuesto declarado: ≤ 1.800 líneas añadidas y ≤ 23 archivos.**

🔴 **El desborde en ARCHIVOS se declara ANTES de que ocurra, y eso es lo que lo convierte en
información y no en un hallazgo.** El umbral del check 7 del CR es **1.800 líneas o 20 archivos**:
esta ola queda **al filo en líneas** y **cruza el de archivos por 3**. La cuenta de por qué son 23,
**ordenada por lo que más pesa**:

1. **Dos pares módulo+test que NO se pueden fusionar** (`sesion-de-posesion.*` y `sesion-store.*`):
   el primero importa `node:crypto` y el segundo corre en el navegador. **No es preferencia:** es el
   motivo medido, escrito en `pop-proof-store.ts:22-33`, por el que ese archivo **duplica un literal
   en vez de importarlo**. **−4 archivos imposibles de ahorrar.**
2. **Dos README**, forzados por `readme-test-count.test.ts`, que los mide **por separado por idioma**
   y a propósito. **−2 imposibles.**
3. **El probe** (`I`), que existe porque W3 **cambia un contrato cliente-servidor** y este repo no
   tiene e2e de navegador. **−1 imposible.**
4. **`.env.example`**, forzado por la env nueva, **que es el mecanismo de despliegue**. **−1.**
5. Los **15** restantes son **pares producción+test** de archivos que ya existen.

**A la pregunta que decide un exceso** (*¿qué parte de esto seguiría existiendo si lo escribiera
alguien que ya conoce este repo?*): el módulo de sesión (**~40** líneas de código real), el almacén
(**~25**), la rama `S1..S5` (**~30**), y las lecturas del cliente más el reintento (**~35**).
🔴 **~130 líneas de producción.** Todo lo demás son tests y el razonamiento que este repo exige en sus
docblocks.

⚠️ **Ratio esperada test/producción ≈ 4:1.** 🔴 **Si el CR mide una ratio MÁS BAJA, la sospecha
correcta es que faltan tests, no que sobra código.**

⚠️ **Un exceso en `flow.tsx` en LÍNEAS es imposible (Δ0); un exceso en CARACTERES ahí sí es posible, y
es lo que hay que mirar.**

---

## 10 · Riesgos que te tienen que preocupar mientras codeás

| # | Riesgo | Consecuencia | Qué lo mitiga |
|---|---|---|---|
| **R-1** | Compartir `PAYOUT_POP_SECRET` con la sesión | 🔴 **Cualquier anónimo se emite una sesión para la dirección de otro y autoriza un desembolso** | Secreto propio + `S3` + **`T-372-W3-2` con su control positivo** + `T-372-W3-9` |
| **R-2** | Guardar la sesión en `localStorage` «para que sobreviva» | Se saltea la **primera** firma (rompe `AC-3-5`) y deja una credencial bearer at-rest | El almacén en memoria + `T-372-W3-8` |
| **R-3** | «Simplificar» dándole `peek` al firmante o `record` al lector | Reinstala el defecto que la HU anterior cerró | Separación por **tipo** + `T-372-W3-16` |
| **R-4** | 🔴 **Desplegar el cliente antes que el servidor** | **403 a todos. Corte total del producto.** Es el corte de 8 días de agosto | El orden de waves + **W3.3 como gate**, con `exit 0` obligatorio |
| **R-5** | Leer `exit 30` del probe como un verde | Se despliega W3.4 sobre un servidor que nunca se midió | ⛔ Escrito en §W3.3 y en el docblock del script: **`exit 30` NO es un verde** |
| **R-6** | Editar `src/infrastructure/solana-wallet.ts` «de paso» | **127 citas ancladas** se re-derivan, más **seis** marcadores | Scope OUT + los marcadores, **que se ponen rojos solos**. Ese rojo **es la señal, no el ruido** |
| **R-7** | Una línea de más en `flow.tsx` | **155 citas ancladas** corridas, **la mayoría en silencio** | Δ0 + `wc -l` + `citas-ancladas.test.ts` |
| **R-8** | Agregar un enum nuevo para «sesión inválida» | Oráculo del mecanismo + ensancha los errores observables de `prepare` | El colapso en `payout_pop_unverified` + `T-372-W3-3` |
| **R-9** | El flake de `vuelta-por-enlace-carrera.test.tsx` se lee como regresión de W3 | Se investiga el archivo equivocado, o peor, se pone en cuarentena | §8 |
| **R-10** | 30 minutos no alcanzan para el recorrido real | La sesión vence a mitad ⇒ **se pide la firma como hoy** | Vencer degrada a lo de hoy, **nunca a un error**. ⛔ **Y no se dice que algo falló: lo que pasó es que venció** |
| **R-11** | Un `sessionToken` roto **más** un PoP robado, y el atacante elige el camino | Se saltea el guard nuevo por el camino viejo | `S1`: **un `sessionToken` presente corta; no cae al PoP** |
| **R-12** | Otra HU mergea sobre `chaski-v3` en el medio | Las citas de §4 apuntan mal | **T2**: se re-derivan antes de editar. Hoy `main` = `f295a6f`, limpio |
| **R-13** | Un archivo bajo `public/` llega a `main` | Una página pública en el origen del money-path, **sin guard mecánico que lo impida** | §2.2 + **T47** (Scope OUT verificado con `git diff --stat`) |

---

## 11 · Lo que W3 NO entrega, y decirlo es parte del entregable

- ⛔ **W3 no borra la PRIMERA firma.** Es un requisito (`AC-3-5`), no una concesión.
- ⛔ **W3 no retira el PoP.** El servidor sigue aceptando las **dos** formas. El PoP se retira al
  final de todo, o nunca. **No es de esta ola.**
- ⛔ **`AC-3-4` queda DEFERIDO, y sin instrumento** (§2.2). ⛔ **«No se pudo preguntar» no es «no».**
- ⛔ **No se sabe si 30 minutos alcanzan** para el recorrido real. Es una hipótesis, y lo que pasa al
  vencerse es **lo de hoy**, no un error.
- ⛔ **W3 no toca la arquitectura A2A.** Ni el Coordinador ni los 3 agentes piden jamás una firma:
  **reciben strings.** Diff esperado en `src/infrastructure/a2a/`: **0 archivos**.
- ⛔ **W3 no introduce ninguna custodia.** La sesión **no es una clave**: no firma nada, no puede
  producir una transacción, y no autoriza movimiento de fondos. La firma del **depósito** queda
  intacta, y la autoridad de KYC se re-consulta en **cada** pago. ⇒ *«Tu plata no pasa por Chaski»*
  sigue siendo literalmente cierto.
- ⛔ **W3 no apaga ni borra el recorrido por enlace profundo.** Ese camino **conserva exactamente el
  comportamiento de hoy (dos firmas), sin que W3 escriba una línea para lograrlo.**
- ⛔ **Ningún copy, comentario, docblock o reporte de esta ola puede decir *«el remitente no necesita
  SOL»***, ni tocar el **valor** de ningún umbral de SOL.
- ⛔ **W3 no cambia el diseño de ninguna otra HU en curso.** El único archivo compartido es
  `flow.tsx`, y W3 entra ahí con **Δ0** ⇒ el roce es de merge, no de citas.
- **Repliegue:** quitar `PAYOUT_SESSION_SECRET` del proveedor. El servidor deja de emitir y de
  aceptar; el cliente cae al PoP **en el mismo request**, gracias al reintento único de
  `T-372-W3-17`. **Sin ese reintento el repliegue no es limpio.**

---

## 12 · Done Definition — W3 está terminada cuando

- [ ] **D1** — Las **48 tareas** de §6 están marcadas.
- [ ] **D2** — Los **5 puntos de la premisa de W3.0 salieron verdes** sobre el árbol de hoy, **antes**
      de escribir una línea de producción. *(Si alguno salió rojo: la ola está **DETENIDA y
      reportada**, no terminada.)*
- [ ] **D3** — 🚦 **El probe de W3.3 salió `0` contra el servicio desplegado, y el código está citado
      textual en el reporte.** *(Un `exit 30` **no** cierra este ítem.)*
- [ ] **D4** — **W3.2 se desplegó ANTES que W3.4**, y el orden está registrado con sus commits.
- [ ] **D5** — §7 tiene **23 filas**: **22 tests que existen y corren**, más `T-372-W3-11`, que es
      **DEFERIDA y no tiene test** (§2.2). De las 22, **cada una con mutante tiene su `×` nombrado**
      (archivo · nombre del `it` · por qué murió). **Ningún falso KILLED.**
- [ ] **D6** — `T-372-W3-2` tiene su **control positivo** y los **dos** mutantes corridos **por
      separado**.
- [ ] **D7** — `T-372-W3-10b` existe y **pone en rojo** un `connect` que firme un mensaje que no sea
      una prueba de posesión. *(Sin él, la frase 4 es prosa.)*
- [ ] **D8** — `/usr/bin/wc -l src/presentation/flow.tsx` da **4453**. Verificado con `wc -l`,
      ⛔ no leyendo el diff.
- [ ] **D9** — `/usr/bin/git diff --stat main...HEAD` muestra **0 líneas** de
      `src/infrastructure/solana-wallet.ts` y **0 archivos bajo `public/`**.
- [ ] **D10** — El diff toca **como máximo los 23 archivos** de §3.1 y **ninguno** de §3.2.
- [ ] **D11** — El gate completo corrió **entero y en orden** después de `git add -A`:
      `npm run qa` (lint → typecheck → typecheck:scripts → test) y después `npm run build`, los dos
      verdes, con la salida citada. ⛔ **Sin `npx` suelto.**
- [ ] **D12** — Los **dos** README declaran el conteo nuevo, **derivado corriendo el candado**, y cada
      uno por separado.
- [ ] **D13** — Los marcadores `[[CENSO …]]` re-derivados **después del último commit de código**, con
      `lineas=4453` **sin cambiar**, y los **seis** de `solana-wallet.ts` **intactos**.
- [ ] **D14** — **Todas** las citas `archivo:línea` nuevas re-derivadas con `sed -n 'Np'` después de
      la **última** edición, y **toda cita a un test escrita por NOMBRE del `it`/`describe`, con su
      archivo**, y el número anclado a un commit.
- [ ] **D15** — Los **7 controles del borde** de §5 siguen enteros, cada uno con su testigo corriendo.
      **`P-3` con `S4` y `T-372-W3-4`.**
- [ ] **D16** — Ninguna frase nueva de copy o docblock **sin su input concreto que la pondría en
      rojo**.
- [ ] **D17** — Ningún guard que **se lea a sí mismo**.
- [ ] **D18** — Si `vuelta-por-enlace-carrera.test.tsx` salió rojo, está **declarado con su frecuencia
      medida** y ⛔ **no** está en cuarentena.
- [ ] **D19** — El diff está dentro del presupuesto de §9 en **las dos** magnitudes, o el exceso está
      **justificado por escrito**, **ordenado por exceso descendente**.
- [ ] **D20** — La frase *«el remitente no necesita SOL»* **no aparece** en ningún archivo del diff.
- [ ] **D21** — El reporte declara, con estas palabras: **`AC-3-4` DEFERIDO sin instrumento** (§2.2) y
      **`AC-3-6` cerrado con su cuarta afirmación reformulada** (§2.3), **con la razón medida**
      (`flow.tsx:460`).
- [ ] **D22** — `TD-372-W3-ADDRESS-DEL-BODY` (§5.1) queda **declarada** en el reporte, no arreglada.

---

*Story File · F2.5 · ola **W3** de WKH-372 · 2026-08-31 · NexusAgil Architect ·
sobre `chaski-v3@f295a6f`, con `SPEC_APPROVED` otorgado, `D-W3-1` resuelta (§2.2) y `D-W3-2` resuelta
(§2.3).*
