# SDD · [WKH-372] · **OLA W3** — La sesión del lado del servidor borra la segunda firma de identidad

> **Repo ancla de los artefactos:** `wasiai-a2a` (`doc/sdd/233-recorrido-movil-sin-saltos/`).
> **Repo donde vive el trabajo: `chaski-v3`, y sólo `chaski-v3`.**
> **Paraguas:** `work-item.md` §4/W3. **Precedente de forma:** `sdd-w1.md` (la ola que cerró).
> **DT-8 del work-item: un SDD por ola. ⛔ Este documento NO diseña W4 ni la HU `071`.**

---

## 0 · CÓMO LEER LAS CITAS DE ESTE DOCUMENTO

Este F2 corrió **con shell**. Todo número de línea de `chaski-v3` está medido contra el commit
**`f295a6f`** (`main`, árbol limpio, verificado con `/usr/bin/git rev-parse HEAD` y
`/usr/bin/git status --porcelain` vacío).

| Marca | Qué significa |
|---|---|
| `[MEDIDO-F2W3]` | Abrí el archivo y leí esa línea en esta sesión, sobre `f295a6f`. |
| `[HEREDADO]` | Sale del `work-item.md`, del `report.md` de W1 o del expediente de otra HU. No lo re-medí. |
| `[NO MEDIDO]` | Nadie lo midió. Va como riesgo o como Missing Input. |

⛔ **Este SDD se re-ancla antes de que el Dev escriba código** si otra HU mergea sobre `chaski-v3`
en el medio (CD-W3-9). No es registro histórico: es un plan de trabajo que alguien va a abrir para
editar. Es la misma asimetría que el work-item ya declara en su §0.2 para la HU `071`.

⚠️ **Las citas a un `it` van por NOMBRE y CON SU ARCHIVO.** El nombre no es único: `T-CABLE-1` y
`T-CABLE-2` existen **también** en `src/composition/container.test.ts` midiendo otra cosa
`[HEREDADO: report.md §10/F]`. En W1 se rompieron **7 citas** por no hacer esto.

---

## 1 · Resumen

Hoy la app pide **dos firmas de identidad que prueban exactamente lo mismo**: que la dirección es de
quien la usa. La primera la pide `ConnectWallet` para consultar el veredicto de KYC
(`src/infrastructure/kyc/http-kyc-verdict-gateway.ts:82`, y el propio archivo declara en `:93` que
esa es *«LA ÚNICA FIRMA DE BILLETERA DE TODO EL FLUJO DE KYC»*) `[MEDIDO-F2W3]`. La segunda la pide
el gateway del depósito, justo antes de `POST /api/payout/prepare`
(`src/infrastructure/settlement/http-solana-prepare-gateway.ts:245`) `[MEDIDO-F2W3]`.

Las dos existen por una razón legítima y escrita: sin la del payout, esa ruta sería *«un oráculo de
existencia y estado de verificaciones de identidad ajenas»*
(`app/api/payout/prepare/route.ts:183-190`) `[MEDIDO-F2W3]`.

**La causa raíz es que la app no tiene sesión.** Medido: `/usr/bin/grep -rn` sobre `src/` y `app/`
buscando `next/headers`, `Set-Cookie`, `set-cookie` y `cookies()` devuelve **cero líneas**, y no
existe `middleware.ts` en ninguna de las tres ubicaciones que Next acepta `[MEDIDO-F2W3]`. No hay
nada que reusar: hay que construirlo.

**W3 construye la sesión y borra la SEGUNDA firma.** La primera se queda (AC-3-5, y su eliminación
está en Scope OUT con razón escrita en `work-item.md` §5.2).

### 1.1 · La distinción que este SDD no colapsa, y que ordena las waves

> El objetivo **sesión** NO depende de que Phantom soporte *Sign In With Solana* por enlace profundo.
> **Aunque no lo soporte, la sesión igual borra la segunda firma.** Lo único que `M-1` decide es si
> conectar y firmar se funden en **un** permiso o quedan en **dos**.

`M-1` **no está medido** y su catálogo publicado de deeplinks no lista `signIn`
`[HEREDADO: work-item §4/W0]`. ⇒ **`AC-3-4` nace DEFERIDO** por la propia cláusula IF del work-item,
y `AC-3-1..3-3, 3-5, 3-6` cierran igual. El instrumento para medirlo se especifica en **W3.M**, que
es una wave **fuera del camino crítico**.

### 1.2 · Lo más caro que encontré midiendo, y cambia el diseño

🔴 **`POST /api/a2a/payout/challenge` emite un token HMAC firmado con `PAYOUT_POP_SECRET` para
CUALQUIER dirección, sin pedir ninguna firma.** El handler entero son 40 líneas: 501 si falta el
secreto, rate-limit, parseo, `canonicalizeAddress`, y `issueSolanaPopChallenge` — **no hay ni un
`verify`** (`app/api/a2a/payout/challenge/route.ts:34-73`) `[MEDIDO-F2W3]`. Es correcto: el
challenge es el *desafío*, y lo que prueba posesión es la firma que el cliente le pone encima.

⇒ **Si el verificador de la sesión compartiera el secreto y la forma del challenge, cualquier
anónimo se emitiría una sesión para la dirección de otro con un solo `curl`**, y eso no sólo
reabriría el oráculo que `PR5'` cerró: **autorizaría un desembolso**. Por eso DT-W3-1 exige
**dominio propio Y secreto propio**, y `T-372-W3-2` lo mide con su control positivo.

---

## 2 · Context Map (Codebase Grounding)

### 2.1 · Archivos que leí, y qué saqué de cada uno

| Archivo | Por qué lo abrí | Qué patrón / hecho extraje `[MEDIDO-F2W3]` |
|---|---|---|
| `app/api/payout/prepare/route.ts` (549 líneas) | Es el receptor de la segunda firma | El orden de guards: `PR2` 503 secreto (`:124`) → `PR3` rate-limit (`:131`) → `PR4` formato (`:144`) → **`PR5'` PoP (`:200`)**, con `POP_SECRET` en `:214`, `popChallenge` en `:219` y `P1..P5` en `:221`, `:230`, `:235`, `:243`, `:247` → `PR5.5` la fila del veredicto (`:259`, lectura en `:303`) → `PR6'` autoridad (`:321`, llamada en `:332`) → `PR7` forward (`:352`) |
| `app/api/kyc/verdict/route.ts` (383 líneas) | Es el receptor de la **primera** firma | `V4` copia el mismo bloque `P1..P5` (`:105-148`) · `const owner = canonicalizeAddress(ch.address)` en `:150`, con el comentario *«Desde acá, y sólo desde acá, el caller probó que la billetera es suya»* (`:146-148`) · **cinco** `return … 200` aguas abajo del PoP: `:204`, `:208`, `:222`, `:282`, `:284` |
| `app/api/kyc/session/route.ts` (552 líneas) | El encargo pide entender por qué ahí el PoP es **opcional** antes de tocar nada | `popPresentado` en `:173-175` y todo el bloque `P1..P5` **adentro de `if (popPresentado)`** (`:195-238`). El motivo está escrito: `P-4`/`AC-4` de WKH-233 — *«sin prueba de posesión la persona se puede verificar igual»*, y cerrar esa puerta *«es exactamente el agujero que costó un bloqueante cerrar en la HU anterior»* (`src/infrastructure/persistence/supabase-kyc-session-tokens.ts:98-104`). ⇒ **W3 NO lo toca** (CD-W3-6) |
| `app/api/a2a/payout/challenge/route.ts` (74 líneas) | ¿De dónde sale el token que hoy circula? | §1.2: emite HMAC para cualquier address **sin verificar nada**. `POP_CHALLENGE_TTL_SECONDS` = 10 min |
| `src/infrastructure/auth/pop-challenge.ts` (106 líneas) | **El exemplar del emisor/verificador** | Formato `${b64url(JSON)}.${b64url(hmac(b64urlPayload))}` (`:9-11`) · `secret()` lee la env **dentro** de la función por CD-14 (`:25-29`) · `verifySolanaPopChallenge` (`:68`): formato → secreto → **HMAC primero, con `expected.length !== received.length` antes de `timingSafeEqual`** (`:82-84`) → parse en try/catch → tipo de cada campo → expiración. **Devuelve `null` ante cualquier problema** |
| `src/infrastructure/auth/pop-proof-store.ts` (84 líneas) | **El exemplar del almacén en memoria** | `InMemoryPopProofStore implements PopProofReader, PopProofRecorder` (`:47`) · `Map` por address · `peek()` borra la vencida (`:70-81`) · el reloj es el puerto `Clock` inyectado y un `nowIso()` ilegible cae del lado seguro (`:76-77`) · `POP_PROOF_TTL_MS = 8 min` **derivado** de `POP_CHALLENGE_TTL_SECONDS` y atado con un candado que lee **los dos archivos** con `readFileSync` (`:22-40`) |
| `src/infrastructure/auth/http-pop-signer.ts` (62 líneas) | El productor de las dos firmas | `prove()` en `:16` · 501 ⇒ `null` (skip), cualquier otro `!ok` ⇒ **lanza** · 🔴 **CD-6 de WKH-337, textual en `:41-45`: «⛔ PROHIBIDO convertirlo en un signer que REUSE una prueba guardada para SALTARSE un popup del money-path»**. Ver DT-W3-6 |
| `src/infrastructure/kyc/http-kyc-verdict-gateway.ts` (131 líneas) | El cliente de la primera firma | `ensure(address, candidate, yaConseguida)` (`:71`) · el `fetch` a `/api/kyc/verdict` en `:96` · **ya devuelve la prueba hacia arriba** (`out()`, `:94`), o sea que el carril «llevar algo del connect hacia adelante» **ya existe** |
| `src/infrastructure/settlement/http-solana-prepare-gateway.ts` (335 líneas) | El cliente de la segunda firma | `input.proof` (WKH-359/AC-2) cortocircuita el `prove()` en `:239-241`; si no viene, `prove()` en `:245` · el body del POST en `:262-277` lleva `popChallenge`/`popSignature` · las tres propiedades que hacen que el ancla por enlace **no** viole CD-5 están escritas en `:232-238` |
| `src/application/use-cases/connect-wallet.ts` (144 líneas) | Dónde nace la primera firma | `pop.pedir({ proposito: "pop-kyc" })` en `:96` (sólo camino por enlace) · `verdictGateway.ensure(...)` en `:120` · el `catch` que **no se estrecha** y **conserva la prueba** (`:128-141`) |
| `src/application/use-cases/confirm-and-send.ts` | Dónde nace la segunda | `pop.pedir({ proposito: "pop-payout" })` en `:463` y `...(pop.estado === "listo" ? { proof: pop.proof } : {})` en `:474`, **las dos en líneas con Δ0 declarado** (`:174` avisa de 8 citas ancladas de `:463` para abajo) |
| `src/infrastructure/payout/authority.ts` | Qué pasa después del PoP en el momento del dinero | `getKycSessionTokenStore()` + `getForOwner(verificationId, identityClaim)` en `:154`, **antes del viaje al agente (P-7)** (`:130`) · `decisionToken === null ⇒ kyc_ownership_mismatch/200` (`:161-175`) |
| `src/infrastructure/persistence/supabase-kyc-session-tokens.ts` (359 líneas) | El encargo pregunta si `kyc_session_tokens` se reusa | **NO. Ver DT-W3-0.** `decision_token` es una credencial bearer at-rest que **NUNCA sale en una respuesta HTTP** (CD-20, `:8-12`), **NO VENCE NUNCA y es a propósito** (CD-21, `:14-21`), y la fila se indexa por el `session_id` **del proveedor**, no por dirección (`:104-133` de la migración) |
| `supabase/migrations/20260819T000000_add_kyc_session_tokens.sql` | El schema real | `owner_address text` **NULLABLE a propósito** (`:113-127`) · único índice sobre `session_id` (`:133`) · RLS on sin policy permisiva (`:139`) |
| `src/composition/container.ts` | El cableado real | `popProofs = new InMemoryPopProofStore(clock)` en `:307` · `prepare: new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet, popProofs))` en `:161` · `connectWallet: new ConnectWallet(wallet, kycStore, new HttpKycVerdictGateway(new HttpPopSigner(wallet, popProofs)), wallet)` en `:185` · el bloque `:300-320` que explica **hasta dónde llega `tsc`** con la separación por objeto |
| `src/application/ports.ts` | Dónde van los puertos nuevos | `PopProofReader`/`PopProofRecorder` en `:150-155`, con el bloque `:137-149` que dice que **el mecanismo es el tipo, no la disciplina** · ⚠️ `:295-303` avisa que este archivo **recibe 17 citas ancladas** |
| `src/composition/citas-ancladas.test.ts` | El candado de Δ0 | El regex `CENSO` en `:331`; los `it` en `:398-434`; el piso `>= 24` marcadores en `:399` |
| `src/composition/readme-test-count.test.ts` | El candado que rompe **agregar un archivo de test** | Marcadores `/\*\*(\d+) test files\*\*/` y `/\*\*(\d+) archivos de test\*\*/` (`:88-89`), medidos **por separado** por idioma. Hoy `README.es.md:462` declara **167** |
| `package.json` | El gate real de **este** repo | `qa` = `lint && typecheck && typecheck:scripts && test` (`:20`) · `build` = `next build --webpack` (`:10`) · `lint` = `biome lint src app scripts` (`:12`) |
| `chaski-v3/doc/sdd/069-wkh-233-…/work-item.md:303-311` | Los `P-1..P-7` que el encargo nombra | Están **acá**, no en el work-item de esta HU. Ver §5 |

### 2.2 · Exemplars verificados (todos existen, todos abiertos con `sed`)

| Exemplar | Ruta (verificada) | Qué se copia de él |
|---|---|---|
| Emisor + verificador HMAC sin estado | `src/infrastructure/auth/pop-challenge.ts` | La **forma entera**: `payloadB64.mac`, `secret()` dentro de la función, HMAC-first con chequeo de longitud, parse en try/catch, `null` ante cualquier problema. ⛔ No se inventa un formato nuevo |
| Almacén en memoria con reloj inyectado y TTL | `src/infrastructure/auth/pop-proof-store.ts` | `Map` por address, `peek()` que borra la vencida, `Number.isFinite` sobre el reloj, y **el candado que ata dos literales leyendo los dos archivos** |
| Separación escritor/lector por TIPO | `src/application/ports.ts:150-155` (`PopProofReader` / `PopProofRecorder`) | El lector **no tiene** `record`; el escritor **no tiene** `peek`. `tsc` lo impone |
| El `it` que compara dos respuestas **byte a byte** y **cuenta llamadas** | `T-PR-4`, por nombre, en `app/api/payout/prepare/route.test.ts` (al `f295a6f`, `:1673`) | El patrón de AC-3-2: comparar los cuerpos, no sólo el status, y contar los `fetch` al proveedor |
| Los cinco fallos del PoP indistinguibles entre sí | `T-EP-3`, por nombre, en `app/api/kyc/verdict/route.test.ts` (al `f295a6f`, `:203`) | Cómo se asserta «mismo status y mismo cuerpo, comparados entre sí» |
| PoP de A presentado con `sender` = B ⇒ 403 y la base **no se toca** | `T-EP-6`, por nombre, en `app/api/kyc/verdict/route.test.ts` (al `f295a6f`, `:263`) | El patrón exacto de `T-372-W3-4` (P-3) |
| La credencial owner-scoped se lee **antes** del borde | `T-AUTH-4`, por nombre, en `src/infrastructure/payout/authority.test.ts` (al `f295a6f`, `:235`) | Cómo se mide un orden de guards sin leerlo del código |
| Un ancla de **un solo propósito** | `T-067-17`, por nombre, en `src/infrastructure/solana/deeplink/pop-por-enlace.test.ts` (al `f295a6f`, `:437`) | La separación de dominio: `pop-payout` no sirve para `pop-kyc`. Es el antecedente directo de DT-W3-1 |
| La ventana la fija el `exp` del **servidor** | `T-067-18`, por nombre, en `src/infrastructure/solana/deeplink/pop-por-enlace.test.ts` (al `f295a6f`, `:485`) | Ídem, para el TTL de la sesión |
| El cableado real del contenedor, no un doble | `T-CABLE-1`, por nombre, en `src/composition/container.test.ts` | ⚠️ **Siempre con su archivo**: hay `T-CABLE-1` en dos suites |
| Un recorrido completo montado con la librería real, contando invocaciones | `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` (768 líneas), `T-372-W1-12` (`:565`) que exige `toHaveBeenCalledTimes(1)` | **El molde exacto de W3.0.** W1 contó `prepare()`; W3 cuenta `signMessage` |
| Un instrumento de red contra el servicio **desplegado** | `wasiai-a2a/scripts/probe-money-path.mjs` (23.155 bytes, existe) `[MEDIDO-F2W3]` | Qué es un probe de verdad: `fetch` contra la URL real, sin dobles |
| Un instrumento con **atribución por código de salida** | `chaski-v3/scripts/probe-vuelta-por-enlace.mjs` (85 líneas) | `exit 0` / `exit 10` / **`exit 30` = «el instrumento no pudo correr», ⛔ y eso NO es un verde** |

### 2.3 · Lo que ya existe y ⛔ no hay que volver a construir

- **El bloque `P1..P5`**: existe **cinco veces** hoy (`payout/prepare`, `kyc/verdict`, `kyc/session`,
  `payout/status`, `solana/escrow/remittance-ids`) `[MEDIDO-F2W3]`. ⛔ **W3 no escribe una sexta.**
- **El carril «llevar algo del connect hacia adelante»**: `ConnectWallet` ya devuelve `kycProof` y
  `flow.tsx:169` ya lo guarda en estado.
- **El par de puertos escritor/lector**: `PopProofReader`/`PopProofRecorder`. Se **imita**, no se
  amplía (⛔ CD-W3-5).
- **El candado de Δ0**: `citas-ancladas.test.ts`. ⛔ No se escribe uno nuevo.
- **El candado de conteo de tests**: `readme-test-count.test.ts`. Se **actualiza el número**, en su
  propia línea, en los **dos** README por separado.

### 2.4 · Auto-Blindaje histórico leído, y qué CD produjo

Leídos: `report.md` §10 (las 13 lecciones **A–M** de W1) y `auto-blindaje.md` (27 entradas).
Los patrones que **se repiten** y que por eso bajan a CD de esta ola:

| Lección | Se repitió en | CD de W3 que la previene |
|---|---|---|
| **A** — un fixture que no reproduce el defecto es indistinguible de un guard que funciona; todo mutante se verifica **en disco** antes de correr | W1.0 ×3, W1.3 | **CD-W3-11** |
| **B** — la cobertura se cierra por **expresión**, no por mutante ni por vecino | fix-packs 1, 2, 3 | **CD-W3-12** |
| **E/F** — las citas cruzadas entre repos **no las vigila nada**; una cita a un `it` va por nombre **con su archivo** | 7 citas rotas en W1 | **CD-W3-4** |
| **G** — un número publicado se **re-mide contra el árbol**; el presupuesto de escala se contrasta en **cada** fix-pack | fix-packs 1, 2, 3 | **CD-W3-10** |
| **H** — un `catch` que asigna `false`/`null` convierte «no pude preguntar» en «la respuesta es no» | fix-pack 3 | **CD-W3-8** |
| **K** — correr las **partes** de un gate no es correr el gate; y antes de escribir copy, leer qué guards vigilan esa pantalla | W1.2 | **CD-W3-7** y **CD-W3-13** |
| **L** — un test que pinnea el comportamiento actual **congela lo que haya, bug incluido** | W1.2 | **CD-W3-12** |

---

## 3 · Decisiones técnicas (DT-W3-N)

### DT-W3-0 · **Lo que se midió y se DESCARTA**, antes de proponer nada

El encargo pregunta si se reusa lo que ya hay. Medido, y la respuesta es no en los tres casos:

| Candidato | Por qué NO | Cita `[MEDIDO-F2W3]` |
|---|---|---|
| `kyc_session_tokens` | (a) Se indexa por el `session_id` **del proveedor**, no por dirección. (b) Su `decision_token` es una credencial bearer que **NUNCA sale en una respuesta HTTP** (CD-20). (c) **No vence nunca, y es una decisión medida del otro repo** (CD-21): sus dos únicos caminos de invalidación son un **corte**, no un rollback. Una sesión de navegador que no vence es lo contrario de una sesión. (d) `owner_address` es **nullable** por `P-4` | `supabase-kyc-session-tokens.ts:8-12`, `:14-21`; migración `:104-133` |
| El `decisionToken` como sesión | Mismo (b): sacarlo del servidor es exactamente lo que CD-20 prohíbe | ídem `:8-12` |
| El `popChallenge` reusado dentro de sus 10 min | Es lo que **CD-6 de WKH-337 prohíbe explícitamente**, con esas palabras. Y además no alcanza: el recorrido puede durar más que el TTL, y `MI-7` (cuánto tarda de verdad) sigue `[NO MEDIDO]` | `http-pop-signer.ts:41-45`; `work-item.md` §9.5 |
| Una tabla nueva | Una migración es una **acción gateada del founder**, y este repo ya tiene escrito el costo del orden migración→flag→código (`prepare/route.ts:288-300`). Para una credencial de 30 minutos que no necesita revocación, es infraestructura que no compra nada | `prepare/route.ts:288-300` |

### DT-W3-1 · La sesión es un **token HMAC sin estado**, con **dominio propio Y secreto propio**

Módulo nuevo `src/infrastructure/auth/sesion-de-posesion.ts`, **espejo exacto** de
`pop-challenge.ts` (formato, orden de verificación, `null` ante todo).

- **Payload**: `{ typ: "chaski-sesion-de-posesion-v1", address, networkId, exp }`.
- **Secreto**: env nueva **`PAYOUT_SESSION_SECRET`**. ⛔ **PROHIBIDO leer `PAYOUT_POP_SECRET`.**
- **TTL**: `SESION_TTL_SECONDS = 30 * 60`. **Derivación escrita**: el recorrido de respaldo compite
  hoy contra los 10 min del PoP y **cuánto tarda de verdad es `[NO MEDIDO]`** (`MI-7`); el informe de
  terreno le atribuye ~20 min `[HEREDADO: work-item §9.5]`. 30 es el redondo más chico por encima de
  esa atribución. ⚠️ **Es una hipótesis sobre la duración, no una medición**, y por eso lo que pasa
  al vencerse es lo de hoy y no un error (DT-W3-7).

**Por qué dominio Y secreto, y no uno solo.** Con `typ` solo alcanzaría **hoy**: el payload del
challenge (`{address, networkId, nonce, exp}`, `pop-challenge.ts:43-48`) no lo tiene. Pero el
emisor del challenge le entrega a un anónimo un token firmado con ese secreto para la dirección que
pida (§1.2), así que **la única cosa que separa a un atacante de una sesión ajena sería un campo del
payload**, y ese payload lo edita cualquier HU futura sin saber que hay algo colgando de él. Con
secreto propio, un cambio en el challenge **no puede** producir una sesión válida. Es el mismo
razonamiento —y del mismo repo— por el que existe `SPONSOR_POP_DOMAIN` en el facilitator, cuyo
comentario nombra `T-B5b` y no `T-B5` porque `T-B5` *«seguiría verde aunque la constante se borrara
entera»* `[HEREDADO: work-item §4/W4, AC-4-2b]`.

🔴 **Y la env es, además, el mecanismo de orden de despliegue.** Sin `PAYOUT_SESSION_SECRET`:
- `/api/kyc/verdict` **no emite** ⇒ ningún cliente tiene sesión ⇒ todos mandan PoP;
- `/api/payout/prepare` **no acepta** ninguna sesión ⇒ el único camino es el PoP.

⇒ **Desplegar el código de W3 con la env ausente es un no-op verificable.** Cero flags nuevos, y
el interruptor es la presencia de una env — el mismo criterio que `getKycSessionTokenStore` ya
escribió: *«NO hay un flag propio, y es deliberado (D-1): dos perillas para una cosa es peor que
una»* (`supabase-kyc-session-tokens.ts:337-343`) `[MEDIDO-F2W3]`.

### DT-W3-2 · La sesión se **emite desde `POST /api/kyc/verdict`**, que es la ruta que la PRIMERA firma ya alimenta

Cero rutas nuevas, cero buckets de rate-limit nuevos, cero copias nuevas del bloque `P1..P5`.

Se emite **aguas abajo de `:150`** (`const owner = canonicalizeAddress(ch.address)`), o sea después
de que `P1..P5` pasaron, y se agrega como campo `sesion` a los **cinco** `return … 200` de esa ruta
(`:204`, `:208`, `:222`, `:282`, `:284`).

⛔ **Nunca en un 403 ni en un 503.** Y sí en los `absent`: **la sesión prueba POSESIÓN, no
verificación**. Que la persona esté verificada lo sigue decidiendo `resolvePayoutAuthority` en cada
pago (`P-9`, intacto).

**Por qué no una ruta nueva `POST /api/a2a/payout/session`**: exigiría una **sexta** copia del
bloque `P1..P5` (ya hay cinco, §2.3) y una superficie más. **Por qué no `/api/kyc/session`**: ahí el
PoP es **opcional** a propósito (`P-4`), así que la mitad de sus callers no probó nada.

### DT-W3-3 · La sesión viaja **en el cuerpo**, no en una cookie

- **Medido**: el repo no tiene **ninguna** infraestructura de cookies (§1). Introducirla es diseño
  nuevo adentro de una ola de migración.
- **Y hay un costo de seguridad concreto**: una cookie que el navegador adjunta sola a
  `POST /api/payout/prepare` crea una superficie de **CSRF que hoy no existe**, porque hoy la
  credencial es un campo del cuerpo que un sitio de terceros no puede fabricar.

⇒ La sesión viaja como `sessionToken` en el mismo JSON donde hoy viajan `popChallenge` y
`popSignature`. **El contrato no cambia de transporte: se le agrega un campo opcional.** Eso es lo
que vuelve literal el *«el servidor acepta las DOS formas»* de CD-7.

### DT-W3-4 · Del connect al prepare la sesión viaja por un **almacén en memoria**, con el mismo par de puertos que WKH-337 ya tiene en producción

Módulo nuevo `src/infrastructure/auth/sesion-store.ts` con `InMemorySesionStore implements
SesionReader, SesionRecorder`, calcado de `InMemoryPopProofStore`.

- `SesionRecorder.record(address, token)` — lo llama `HttpKycVerdictGateway` al recibir el 200.
- `SesionReader.peek(address): string | null` — lo lee `HttpSolanaPayoutPrepareGateway`.
- ⛔ El lector **no tiene** `record`; el escritor **no tiene** `peek`. Es el tipo, no la disciplina.

**Por qué no enhebrarla por `flow.tsx`**: ese archivo tiene **4453 líneas** y **155 citas ancladas
entrantes** (`[[CENSO src/presentation/flow.tsx lineas=4453]]` y `entrantes=155`, en
`src/presentation/flow-vm.ts:1522`) `[MEDIDO-F2W3]`, y está bajo Δ0 duro (CD-W3-1).

**Por qué en memoria y ⛔ nunca en `localStorage`/`sessionStorage`**, y son tres razones que se
refuerzan:
1. Una sesión que sobrevive a una recarga **saltearía la PRIMERA firma**, y eso rompe `AC-3-5`.
   En memoria, `AC-3-5` se cumple **por construcción**, sin un guard que alguien tenga que recordar.
2. Es una credencial bearer: at-rest en el navegador es superficie que no hace falta abrir.
3. 🔴 **El camino por enlace pierde la sesión en cada salto** (el árbol de React se remonta, §DT-1
   del work-item) ⇒ **cae al PoP solo, sin escribir una línea.** ⇒ **CD-3 (el respaldo queda
   encendido y con el comportamiento de hoy) se preserva GRATIS.**

### DT-W3-5 · `prepare` acepta **sesión O PoP**, y el orden de guards **no se mueve**

Dentro de `PR5'`, **sin tocar ni una línea de `PR2`, `PR3`, `PR4`, `PR5.5`, `PR6'`, `PR7`, `PR8`**:

```
PR5'  (:200)
  ├─ if (!POP_SECRET) → 503            ← ⛔ SE QUEDA EXACTAMENTE DONDE ESTÁ (:214-218)
  ├─ if (body.sessionToken presente)   ← rama nueva: S1..S5
  │     S1 presencia + tipo            → 403 `payout_pop_unverified`
  │     S2 HMAC + exp + tipos          → 403  (mismo enum, mismo cuerpo)
  │     S3 `typ` = dominio de sesión   → 403  ← acá muere un `popChallenge` crudo
  │     S4 address match vs `address`  → 403  ← EL EQUIVALENTE DE P-3
  │     S5 binding CAIP-2 server-side  → 403
  └─ else                              ← rama de hoy, BYTE-IDÉNTICA: P1..P5 (:221-256)
  ⇒ `direccionProbada` (de la sesión o del challenge)
PR5.5 (:259) … usa `direccionProbada` donde hoy usa `ch.address` (:303)
```

⛔ **Ningún enum nuevo.** Los cinco fallos de la sesión colapsan en el **mismo** 403
`payout_pop_unverified` con el **mismo** cuerpo. Un enum propio le diría al caller *cuál* de los dos
mecanismos falló, que es un oráculo, y ensancharía el conjunto de errores observables de `prepare`
—exactamente lo que `CD-16` de WKH-233 prohíbe (`authority.ts:166-175`) `[MEDIDO-F2W3]`.

⛔ **`if (!POP_SECRET) → 503` no se mueve ni se vuelve condicional.** Si sólo estuviera puesta
`PAYOUT_SESSION_SECRET`, la ruta seguiría necesitando el PoP para todo el que no tenga sesión, y el
emisor del challenge estaría apagado. Moverlo también rompería el `it` que recorre el orden
(`app/api/payout/prepare/route.test.ts:947-972`), y ese rojo sería correcto.

### DT-W3-6 · Por qué esto **no** viola la CD-6 de WKH-337, y hay que decirlo antes de que lo pregunte el AR

`http-pop-signer.ts:41-45` dice, textual: *«⛔ PROHIBIDO convertirlo en un signer que REUSE una
prueba guardada para SALTARSE un popup del money-path»*.

**W3 no toca `HttpPopSigner` ni `InMemoryPopProofStore`, y no reusa ninguna prueba.** La diferencia
es categórica y hay que sostenerla con tres hechos, no con una frase:

1. **No se replica una credencial: se emite una nueva.** El servidor **verifica** una firma real
   (`P1..P5` de `/api/kyc/verdict`) y **acuña** un token distinto, con otro dominio, otro secreto y
   otro `exp`. Eso es una sesión, no un replay.
2. **La sesión no autoriza plata.** Sólo atraviesa el gate de identidad. La firma del **depósito**
   (la transacción) queda intacta, y `resolvePayoutAuthority` sigue re-consultando a la autoridad en
   **cada** pago (`P-9`, `prepare/route.ts:332`).
3. **La persona sigue firmando conscientemente una vez por dirección**, que es la propiedad que esa
   CD protege. Lo que se elimina es la **segunda** firma, que prueba lo mismo que la primera.

### DT-W3-7 · Vencer **no es fallar**, y la forma más fuerte de decirlo es **no decir nada**

Cuando la sesión no está o venció, `SesionReader.peek()` devuelve `null` y el gateway **pide la
firma como hoy**. La persona ve el prompt de su billetera, igual que siempre.

⇒ **W3 no agrega ni un solo string de copy para el vencimiento, y esa ausencia es la decisión.**
Cualquier aviso ahí diría *«algo pasó»* sobre un evento que la persona no puede distinguir del
funcionamiento normal, y este repo ya tiene la regla escrita para el caso gemelo: la copy que cuelga
de `"sin-prueba"` ⛔ *«no puede decir "venció" ni usar un verbo en pasado sobre haber revisado: sería
afirmar una historia que el sistema NO puede distinguir»* (`src/application/ports.ts`, bloque de
`EstadoVentanaLectura`) `[MEDIDO-F2W3]`.

### DT-W3-8 · `AC-3-6` entra **con su cuarta frase gateada**, y la razón no es cosmética

`AC-3-6` pide decirle a la persona **cuatro** cosas: qué firma, que es gratis, que no mueve plata, y
**que se hace una sola vez para esa dirección**.

🔴 **La cuarta es FALSA en el camino por enlace**, que CD-3 deja encendido: ahí la sesión se pierde
en cada salto (DT-W3-4) y la firma se vuelve a pedir. Publicarla sin gate sería copy visible que
afirma algo que un camino vivo desmiente.

⇒ Las tres primeras van sin condición; la cuarta va **gateada por `disponibilidadWallet ===
"injected"`**, que es el mismo detector que la pantalla ya usa (`flow.tsx:1351` lo evalúa para
`NoWalletHere`) `[MEDIDO-F2W3]`.

⚠️ **Y antes de escribirla hay que leer qué guards vigilan esa pantalla** (lección K): `T-065-21`
(en `src/presentation/wallet-availability.test.tsx`) compara el **`innerHTML` del paso entero**, así
que **se va a poner rojo**. Ese rojo es correcto y se actualiza a propósito; ⛔ no se «arregla»
aflojando la comparación.

### DT-W3-9 · El instrumento de `M-1` es una página estática que **no mergea a `main`**

`public/medicion-siws.html`: cero código de producción, cero rutas nuevas, cero bundle. Se despliega
en un **preview** y se corre en el teléfono del founder.

🔴 **Mide la PRECONDICIÓN antes que la consecuencia.** El *Testnet Mode* de Phantom es precondición
del enlace profundo y sin él la billetera **vuelve sin nada y sin error**
`[HEREDADO: work-item §9.5]` — o sea **indistinguible de «no soporta `signIn`»**. ⇒ la página hace
primero un `connect` de control:

| Control | `signIn` | Veredicto de `M-1` |
|---|---|---|
| falla | — | **NO SE PUDO PREGUNTAR** ⛔ nunca «no» |
| ok | responde con la firma | **SOPORTADO** ⇒ `AC-3-4` se puede cerrar |
| ok | vuelve vacío / con error | **NO SOPORTADO** ⇒ `AC-3-4` **DEFERIDO con razón escrita** |

### DT-W3-10 · La ola se despliega en **dos empujes**, con una medición contra el servicio vivo en el medio

Es CD-7 escrita como wave, no como nota. Ver §6 (W3.2 → **W3.3** → W3.4) y §8.

---

## 4 · Diseño técnico

### 4.1 · Archivos a crear / modificar — la lista exhaustiva

| # | Archivo | Acción | Wave |
|---|---|---|---|
| **A** | `src/presentation/sesion-borra-la-segunda-firma.test.tsx` | **NUEVO** — la premisa falsable | W3.0 |
| **B** | `src/infrastructure/auth/sesion-de-posesion.ts` | **NUEVO** — emisor + verificador (server-only, `node:crypto`) | W3.1 |
| **C** | `src/infrastructure/auth/sesion-de-posesion.test.ts` | **NUEVO** | W3.1 |
| **D** | `app/api/payout/prepare/route.ts` | Rama `S1..S5` dentro de `PR5'`; `direccionProbada` en `:303` | W3.2 |
| **E** | `app/api/payout/prepare/route.test.ts` | + tests de la rama nueva | W3.2 |
| **F** | `app/api/kyc/verdict/route.ts` | Acuña la sesión tras `:150`; la agrega a los 5 `200` | W3.2 |
| **G** | `app/api/kyc/verdict/route.test.ts` | + tests de emisión | W3.2 |
| **H** | `.env.example` | Documenta `PAYOUT_SESSION_SECRET` y su ausencia como no-op | W3.2 |
| **I** | `scripts/probe-sesion-de-posesion.mjs` | **NUEVO** — el probe contra el servicio desplegado | W3.3 |
| **J** | `src/infrastructure/auth/sesion-store.ts` | **NUEVO** — almacén en memoria (browser-safe, sin `node:crypto`) | W3.4 |
| **K** | `src/infrastructure/auth/sesion-store.test.ts` | **NUEVO** | W3.4 |
| **L** | `src/application/ports.ts` | + `SesionReader` / `SesionRecorder`. ⚠️ 17 citas ancladas: **al final del archivo** | W3.4 |
| **M** | `src/infrastructure/kyc/http-kyc-verdict-gateway.ts` | Lee `sesion` del 200 y la registra | W3.4 |
| **N** | `src/infrastructure/kyc/http-kyc-verdict-gateway.test.ts` | + tests | W3.4 |
| **O** | `src/infrastructure/settlement/http-solana-prepare-gateway.ts` | `peek()` → manda `sessionToken` y **no** llama `prove()` | W3.4 |
| **P** | `src/infrastructure/settlement/http-solana-prepare-gateway.test.ts` | + tests | W3.4 |
| **Q** | `src/composition/container.ts` | Cablea el almacén. ⛔ En las líneas que ya existen (`:161`, `:185`, `:307`) | W3.4 |
| **R** | `src/composition/container.test.ts` | + `T-CABLE` de la sesión | W3.4 |
| **S** | `src/test-support/fakes.ts` | Doble del almacén | W3.4 |
| **T** | `src/presentation/flow.tsx` | **Δ0 ESTRICTO** — las 4 frases de `AC-3-6` | W3.5 |
| **U** | `src/presentation/wallet-availability.test.tsx` | Tests de copy + actualización deliberada de `T-065-21` | W3.5 |
| **V** | `README.md` + `README.es.md` | El conteo de archivos de test (hoy **167**) | W3.6 |
| **W** | `public/medicion-siws.html` | **NUEVO, y ⛔ NO mergea a `main`** | W3.M |

⛔ **Fuera del Scope IN, y Δ0 verificado archivo por archivo al cerrar (CD-W3-2):**
`src/infrastructure/solana-wallet.ts` · `src/infrastructure/solana/deeplink/**` ·
`src/application/solana-escrow-rent.ts` · `src/application/use-cases/confirm-and-send.ts` ·
`src/application/use-cases/connect-wallet.ts` · `app/api/kyc/session/route.ts` ·
`src/infrastructure/auth/pop-challenge.ts` · `src/infrastructure/auth/pop-proof-store.ts` ·
`src/infrastructure/auth/http-pop-signer.ts` · `src/methods/**` de cualquier otro repo.

### 4.2 · El módulo nuevo — contrato (archivo **B**)

```
export const SESION_TIPO = "chaski-sesion-de-posesion-v1";
export const SESION_TTL_SECONDS = 30 * 60;

export interface SesionDePosesion {
  tipo: typeof SESION_TIPO;
  address: string;     // base58 canónico, case-sensitive
  networkId: string;   // CAIP-2, server-side, NUNCA del body
  exp: number;         // epoch SEGUNDOS
}

/** `null` cuando falta PAYOUT_SESSION_SECRET ⇒ la ruta no agrega el campo. NUNCA lanza. */
export function emitirSesionDePosesion(address: string, networkId: string, nowMs: number): string | null;

/** `null` ante CUALQUIER problema (fail-closed → 403 opaco). Mismo orden que verifySolanaPopChallenge. */
export function verificarSesionDePosesion(token: string, nowMs: number): SesionDePosesion | null;
```

⛔ **`secret()` lee `process.env.PAYOUT_SESSION_SECRET` DENTRO de la función** (CD-14 del repo, para
que `vi.stubEnv` funcione). ⛔ **Nunca `PAYOUT_POP_SECRET`.**
⛔ **HMAC primero**, con `expected.length !== received.length` **antes** de `timingSafeEqual`
(`timingSafeEqual` tira con buffers de distinta longitud — está escrito en `pop-challenge.ts:82-83`).

### 4.3 · La rama nueva de `prepare` — `S1..S5`, sitio por sitio

| Guard | Qué mira | Enum | ⚠️ La trampa |
|---|---|---|---|
| **S1** | presencia + tipo string no vacío de `body.sessionToken` | `payout_pop_unverified` / 403 | ⛔ Un `sessionToken` presente **no** habilita caer al PoP si falla: se corta. Si no, un atacante manda una sesión rota + un PoP robado y elige el camino |
| **S2** | `verificarSesionDePosesion(token, Date.now())` ⇒ `null` | ídem | El `exp` vive acá dentro, como en `pop-challenge.ts:105` |
| **S3** | `sesion.tipo === SESION_TIPO` | ídem | 🔴 **Acá muere un `popChallenge` crudo.** Aunque el secreto ya lo mata, este guard es el que se **lee** como intención |
| **S4** | `canonicalizeAddress(sesion.address) === canonicalizeAddress(address)`, en `try/catch` | ídem | 🔴 **ES `P-3`.** ⛔ El binding es la dirección **probada**, jamás un campo del cuerpo. Ver §5/P-3 |
| **S5** | `sesion.networkId === resolveSolanaNetworkId()` | ídem | ⛔ Server-side, **nunca** del body |

Después de la rama: `const direccionProbada = <sesion.address | ch.address>`, y **`:303` pasa a leer
`direccionProbada`** en vez de `ch.address`.

⚠️ **Lo que NO se cambia, y la razón**: `:332` le pasa a `resolvePayoutAuthority` el `address` **del
body**, no el probado. Hoy es seguro porque `P3` los comparó, y `S4` conserva exactamente esa
propiedad. Cambiarlo a `direccionProbada` sería correcto **y no tendría ningún input que lo
distinga** ⇒ sería una línea del money-path sin testigo, que es lo que este repo prohíbe.
⇒ **Se declara como `TD-372-W3-ADDRESS-DEL-BODY`**, con `S4` y `T-372-W3-4` como su guard.

### 4.4 · Microcopy de `AC-3-6` — español rioplatense, sin em dashes, sin decir que algo falló

Las cuatro frases, en el paso `connect`, **importadas de una constante**, ⛔ nunca escritas dos veces:

1. *"Te vamos a pedir una firma para confirmar que la billetera es tuya."*
2. *"Es gratis."*
3. *"No mueve tus USDC ni autoriza ningún pago."*
4. *(sólo con `disponibilidadWallet === "injected"`)* *"Se hace una sola vez para esta dirección."*

⛔ Ninguna dice *"el remitente no necesita SOL"* (CD-12). Ninguna dice que algo falló. Sin em dashes.

---

## 5 · Los siete controles del borde — `P-1..P-7`, cómo se preserva cada uno

⚠️ **Corrección medida de la premisa del encargo**: los `P-1..P-7` **no los declara el work-item de
esta HU** (`/usr/bin/grep -n "P-1\|…\|P-7"` sobre los 9 `.md` de la carpeta devuelve **cero**)
`[MEDIDO-F2W3]`. Viven en el expediente de **WKH-233**, en
`chaski-v3/doc/sdd/069-wkh-233-chaski-consume-el-agente-de-kyc/work-item.md:303-311`, como
`P-1..P-16`. Los siete del borde son los que siguen; los que W3 además roza (`P-8..P-11`) van
abajo.

| # | Control (textual de WKH-233) | ¿W3 lo toca? | **Cómo se preserva** | Testigo |
|---|---|---|---|---|
| **P-1** | Rate-limit por IP+address **antes** de gastar cuota del proveedor | No | `PR3` (`prepare:131`) y `V2` (`verdict:88`) quedan **arriba** de todo lo que W3 escribe. La rama de sesión vive dentro de `PR5'`, que ya está debajo del limiter | `T-372-W3-13` |
| **P-2** | La key del limiter sale de una fuente **no forjable** | No | `clientIp()` intacto. **Δ0 en `src/infrastructure/rate-limit.ts`** | Δ0 |
| **P-3** | 🔴 **El binding es la dirección PROBADA, jamás un campo del cuerpo** | **Sí, y es el que más importa** | `S4` reproduce exactamente `P3`: compara `sesion.address` contra `address` y muere en 403. Y `PR5.5` pasa a leer **`direccionProbada`**, que sale del token firmado por nosotros, no del body. ⛔ Prohibido un `?? body.address` en cualquier rama | **`T-372-W3-4`** |
| **P-4** | Sin prueba ⇒ sesión **sin atar**, pero la persona **puede verificarse igual** | No | ⛔ **`app/api/kyc/session/route.ts` no se toca** (CD-W3-6). Su PoP opcional (`:173-238`) existe para que la puerta de entrada al KYC no se cierre, y cerrarla costó un bloqueante en la HU anterior | Δ0 |
| **P-5** | El `GET /decision` exige credencial ⇒ cierra el IDOR | No | `app/api/kyc/decision/route.ts` fuera de Scope IN. La sesión de W3 **no** es una credencial para esa ruta y **no** se acepta ahí | Δ0 |
| **P-6** | Mismo body/status para «sin token» y «token inválido» (anti-enumeración) | **Sí** | Los cinco fallos de `S1..S5` colapsan en el **mismo 403 con el mismo cuerpo** que los cinco de `P1..P5`. ⛔ Cero enums nuevos (DT-W3-5) | **`T-372-W3-3`** |
| **P-7** | **Nunca** fetch al proveedor antes de pasar los guards | **Sí** | La rama de sesión va **antes** de `PR5.5` y de `PR6'`. Un caller sin sesión válida y sin PoP **no llega** a `verdictStore.get` ni a `resolvePayoutAuthority` | **`T-372-W3-3`** cuenta llamadas, no status (patrón `T-AUTH-4`, `src/infrastructure/payout/authority.test.ts`) |

**Los que W3 roza sin tocar, y que el AR va a mirar igual:**

- **P-8** (ownership fail-closed en el momento del dinero) y **P-11** (`verificationId` sale de la
  fila del dueño, nunca del body): los dos cuelgan de que `PR5.5` lea la dirección **probada**. Con
  `direccionProbada` siguen enteros. ⛔ El candado estático de `P-11` (`kycVerificationId` no
  aparece en `src/`/`app/`) **no se debilita**: W3 no agrega ese símbolo en ningún lado.
- **P-9** (la autoridad re-consulta en **cada** pago): intacto, `prepare:332` no se mueve. **La
  sesión no reemplaza esa consulta y no puede.**
- **P-10** (fail-closed ante `reason` desconocido): intacto, el `switch` de `:335-350` no se toca.

---

## 6 · Waves de implementación

> El orden **es** load-bearing, y **W3.3 es un gate de despliegue, no un paso de código**.

### W3.0 · La premisa, falsable, sobre el árbol de hoy · **SERIAL, BLOQUEANTE** · 0 líneas de producción

Archivo **A**. Se corre **sin tocar una sola línea de producción**. Molde:
`src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` (W1).

Prueba, sobre el árbol de hoy:

1. En un recorrido **inyectado** completo que cierra, `wallet.signMessage` se invoca **exactamente
   2 veces** para identidad: una en el connect y una antes del `prepare`.
   🔴 **Si da 1, W3 no tiene nada que borrar y la ola se detiene.**
2. `POST /api/a2a/payout/challenge` devuelve **200** con un token para una dirección arbitraria
   **sin ninguna firma** (§1.2). Es la premisa que obliga al secreto propio.
3. `POST /api/payout/prepare` **no** lee ninguna cookie ni ningún header de sesión: hoy la única
   credencial de identidad que acepta son los dos campos del cuerpo.
4. `InMemoryPopProofStore` **no** lo lee el gateway del `prepare`: su dependencia es `PopSigner`, que
   **no tiene `peek`** ⇒ la segunda firma no está ya saltada por otra vía.
5. `kyc_session_tokens` **no puede** servir de sesión: `getForOwner` se indexa por el `sessionId` del
   proveedor y devuelve **el token y nada más**, y ese token ⛔ nunca sale en una respuesta HTTP.

⛔ **Si cualquiera de los cinco sale rojo, W3 se detiene y se reporta al humano.**

**Sale con:** el gate completo + los mutantes de §7 con su `×` nombrado.

### W3.1 · El módulo puro, server-only · depende de W3.0 sólo por el semáforo

Archivos **B** y **C**. Sin rutas, sin React, sin cliente.
⚠️ **B y C no pueden fusionarse con J y K**, y no es preferencia: `B` importa `node:crypto` y `J`
corre en el navegador. Es exactamente el motivo por el que `pop-proof-store.ts:33-40` **duplica un
literal en vez de importarlo**, y ata los dos con un candado que lee los dos archivos.

**Sale con:** `npm run qa` verde + `T-372-W3-9`, `T-372-W3-14`, `T-372-W3-15`.

### W3.2 · 🚦 **EL RECEPTOR PRIMERO** — el servidor acepta las DOS formas · **el cliente NO se toca**

Archivos **D**, **E**, **F**, **G**, **H**.

⛔ **Ninguna línea de `src/infrastructure/kyc/**`, `src/infrastructure/settlement/**`,
`src/composition/**` ni `src/presentation/**` entra en esta wave.** Es CD-7 hecha wave: el cliente
**sigue mandando PoP** cuando esto se despliega.

**Sale con:** el gate completo, y **Δ0 verificado en los archivos de cliente**.
**Se mergea y se despliega. Después se pone `PAYOUT_SESSION_SECRET` en el proveedor.**

### W3.3 · 🚦 **GATE DE DESPLIEGUE** — la medición contra el servicio VIVO · **0 líneas de producción**

Archivo **I** (`scripts/probe-sesion-de-posesion.mjs`), corrido contra la URL desplegada.

⚠️ **Por qué esto no es opcional**: `chaski-v3` **no tiene suite e2e de navegador** y sus tests
doblan `fetch` con `vi.stubGlobal`. **Un test con doble no prueba el cableado**, y ese es el modo de
falla que dejó 8 días de 502 invisibles `[HEREDADO]`. W3 **cambia un contrato cliente-servidor** ⇒
hace falta un instrumento que hable con el servidor de verdad. Molde:
`wasiai-a2a/scripts/probe-money-path.mjs`; atribución por código de salida:
`chaski-v3/scripts/probe-vuelta-por-enlace.mjs`.

Tres afirmaciones, contra el deploy de W3.2:

| | Qué manda | Qué se exige |
|---|---|---|
| **a** | Un PoP **válido** | El mismo desenlace que antes de W3.2 (⇒ **no se rompió nada**) |
| **b** | Una sesión **válida** emitida por ese mismo servidor | El **mismo** desenlace que (a) |
| **c** | Ni sesión ni PoP | **403**, con el **mismo cuerpo** para un `kycVerificationId` real, uno ajeno y uno inventado |

Salidas: `0` las tres ok · `10` (b) no la acepta · `11` (a) se rompió · `12` (c) dejó de cortar ·
**`30` el instrumento no pudo correr — ⛔ y eso NO es un verde.**

🔴 **W3.4 no arranca hasta que este probe salga `0`.** Al revés, el cliente deja de mandar la prueba
antes de que el servidor acepte su reemplazo: **403 a todos, corte total del producto**
(`work-item.md` §9.3).

### W3.4 · El cliente empieza a usar la sesión · depende de W3.3

Archivos **J**, **K**, **L**, **M**, **N**, **O**, **P**, **Q**, **R**, **S**.
⛔ El PoP **no se retira** (DT-3 del work-item: se retira al final, o nunca). El `else` de `prove()`
queda entero.

**Sale con:** el gate completo + `T-372-W3-1`, `-5`, `-6`, `-7`, `-8`, `-16`.
**Se mergea y se despliega. Segundo empuje.**

### W3.5 · El copy de `AC-3-6` · **paralelizable con W3.4**, entra entero o no entra

Archivos **T** (Δ0 estricto) y **U**.
**Sale con:** `/usr/bin/wc -l src/presentation/flow.tsx` = **4453**, el gate completo, y
`T-372-W3-10`.
⚠️ **Antes de escribir una palabra**: leer `T-UI-*` y `T-065-21` en
`src/presentation/wallet-availability.test.tsx` (lección K).

### W3.M · La medición de `M-1` · **fuera del camino crítico, paralelizable con todo**

Archivo **W**. Cero producción. Deploy de **preview**, teléfono del founder, Testnet Mode activo.
⛔ **No mergea a `main`** (D-W3-1). Sus tres desenlaces en DT-W3-9.

### W3.6 · Cierre

Conteo de archivos de test re-derivado **corriendo el candado** (⛔ no sumando) y escrito en los
**dos** README por separado (archivo **V**) · re-derivación de **todas** las citas nuevas y de las
que la ola movió (CD-W3-4) · re-derivación de los marcadores `[[CENSO …]]` · el gate completo
`git add -A && npm run qa && npm run build`.

---

## 7 · Plan de tests — uno por AC, cada uno con su mutante

> ⛔ Regla transversal (CD-W3-11): **cada mutante se verifica en disco antes de correr nada**, y se
> aborta si el patrón no aparece **exactamente una vez**. Un mutante que no matcheó más una suite
> verde son indistinguibles de un control que funciona.
> ⛔ Regla transversal (CD-W3-5): **ningún guard puede leerse a sí mismo.**

| Test | AC / CD | Archivo | Qué afirma | **Mutante que lo tiene que matar** | Falso KILLED a evitar |
|---|---|---|---|---|---|
| `T-372-W3-0a` | premisa | A | Hoy, en un recorrido inyectado que **cierra**, `signMessage` se llama **exactamente 2 veces** | — (es medición) | Si el fixture no llega al estado terminal cuenta 1 y la premisa parece falsa. **Se exige assertar el estado terminal del envío** |
| `T-372-W3-0b` | premisa | A | El emisor del challenge devuelve 200 para una address arbitraria **sin firma** | — | — |
| `T-372-W3-1` | AC-3-1 | A | Con el almacén cableado, el mismo recorrido llama `signMessage` **exactamente 1 vez** | Hacer que `peek()` devuelva siempre `null` ⇒ vuelve a 2 | `toHaveBeenCalled()` no sirve: `toHaveBeenCalledTimes(1)` |
| `T-372-W3-2` | AC-3-2 / DT-W3-1 | E | Un `popChallenge` **crudo del emisor real** presentado como `sessionToken` ⇒ **403**; y **control positivo**: ese MISMO token sigue sirviendo como `popChallenge` y da 200 | (i) borrar el chequeo de `S3`; (ii) hacer que `secret()` lea `PAYOUT_POP_SECRET`. **Se corren por separado** | 🔴 **Sin el control positivo, un verificador que rechace TODO da verde.** Es el `it` más importante de la ola |
| `T-372-W3-3` | AC-3-2 / P-6 / P-7 | E | Sin sesión y sin PoP: un `kycVerificationId` real, uno ajeno y uno inventado ⇒ **mismo status y mismo cuerpo byte a byte**, y **cero** llamadas al proveedor de identidad | Mover la rama de identidad por debajo de `PR5.5` | Comparar sólo el status: los tres darían 403 con cuerpos distintos. **Se comparan los cuerpos y se cuentan los fetch.** Patrón: `T-PR-4`, en `app/api/payout/prepare/route.test.ts` |
| `T-372-W3-4` | **P-3** / AC-3-2 | E | Una sesión de **A** presentada con `address` = **B** ⇒ **403**, y `verdictStore.get` **no se llama** | Borrar `S4` | Un mutante que rompa el parseo mata el mismo `it` sin probar el binding. **Se corre por separado del de `S3`.** Patrón: `T-EP-6`, en `app/api/kyc/verdict/route.test.ts` |
| `T-372-W3-5` | AC-3-3 | E | Una sesión **vencida** ⇒ 403 con el **mismo cuerpo** que sin sesión; y **el mismo request con PoP válido ⇒ 200** | Quitar la comprobación del `exp` | El `it` construye la sesión vencida **con el emisor real** y un reloj adelantado, ⛔ nunca con un string escrito a mano |
| `T-372-W3-6` | AC-3-3 | P | Sin sesión en el almacén, el gateway **pide la firma** (`prove` llamado **1** vez) y el body viaja **sin** `sessionToken` | Mandar `sessionToken: undefined` igual en el body | `toHaveBeenCalled()` sin contar deja pasar 2 |
| `T-372-W3-7` | AC-3-3 / CD-W3-8 | K | `peek()` devuelve `null` para «no hay» **y** para «venció», **borra** la vencida, y un `nowIso()` ilegible cae del lado seguro (⛔ nunca «válida para siempre») | Cambiar `>=` por `>` en la comparación del TTL; y borrar el `Number.isFinite` | Es el mismo `it` que ya existe en `src/infrastructure/auth/pop-proof-store.test.ts`: **se copia el patrón, no se inventa** |
| `T-372-W3-8` | **AC-3-5** | A | Tras una **recarga** (almacén nuevo), la **primera** firma se vuelve a pedir | Persistir la sesión en `localStorage` | Un `it` que sólo mire el almacén no prueba el recorrido: **monta el árbol dos veces** |
| `T-372-W3-9` | DT-W3-1 | C | Con **sólo** `PAYOUT_POP_SECRET` puesta, emitir devuelve `null` **y** verificar devuelve `null` | `secret()` cae a `PAYOUT_POP_SECRET` | Un `it` que ponga las dos envs **con el mismo valor** no distingue nada |
| `T-372-W3-10` | AC-3-6 / DT-W3-8 | U | En `connect` con `"injected"` aparecen **las cuatro** frases; con `"none"` la cuarta **no** | Quitar el gate de la cuarta frase | ⛔ Prohibido `toContain("…")` con el texto escrito en el `it`: **importa la constante** |
| `T-372-W3-11` | **AC-3-4** | — | **DEFERIDO.** `M-1` `[NO MEDIDO]`. Instrumento: **W** (DT-W3-9) | — | ⛔ **«No se pudo preguntar» nunca es «no»** (CD-4) |
| `T-372-W3-12` | **CD-7** | I | Contra el servidor **desplegado**: (a) PoP válido, (b) sesión válida, (c) ninguna ⇒ 403 | — | ⛔ Un doble de `fetch` no prueba el cableado: **es la razón de existir de este script** |
| `T-372-W3-13` | P-1 | E | El rate-limit corre **antes** de que la rama de sesión toque nada | Subir la rama de sesión por encima de `PR3` | Contar llamadas al limiter, no leer el orden del archivo |
| `T-372-W3-14` | DT-W3-1 | C | Round-trip: `emitir` → `verificar` devuelve los 4 campos; un token con **un byte cambiado en el MAC** ⇒ `null`; con **el payload cambiado** ⇒ `null` | Comparar el MAC con `===` en vez de `timingSafeEqual`; quitar el chequeo de longitud | Un `it` que sólo pruebe un token basura da verde con un verificador que devuelva `null` siempre. **Se exige la mitad positiva** |
| `T-372-W3-15` | DT-W3-1 | C | El `networkId` del token se compara contra `resolveSolanaNetworkId()`, **nunca** contra un literal | Aceptar cualquier `networkId` | ⛔ El `it` **importa** `resolveSolanaNetworkId`; no escribe `"solana:devnet"` |
| `T-372-W3-16` | cableado | R | El contenedor real inyecta **el mismo** almacén al gateway del veredicto y al del prepare | Inyectar dos instancias distintas ⇒ la sesión nunca se lee | ⚠️ Este `it` se cita **con su archivo**: hay `T-CABLE-*` en dos suites |
| — | **CD-W3-1** | *(ya existe)* | Δ0 de `flow.tsx` | — | ⛔ **No se escribe guard nuevo.** Ya lo hace `citas-ancladas.test.ts` con `[[CENSO … lineas=4453]]` |

⚠️ **Y lo que estos tests NO prueban, dicho antes de que alguien lea su verde de más:** ninguno corre
en un teléfono, y **ninguno excepto `T-372-W3-12` habla con un servidor de verdad**. `M-1`,
`MI-7` (cuánto tarda el recorrido) y `MI-W3-2` (si 30 minutos alcanzan) siguen `[NO MEDIDO]`.

---

## 8 · Riesgos y orden de despliegue

**W3 cambia un contrato cliente-servidor ⇒ SÍ tiene orden, y es el riesgo principal de la ola.**

| Fase | Qué se despliega | Qué pasa si se hace al revés |
|---|---|---|
| **1** | **W3.2**: el servidor acepta **PoP o sesión**, y emite. `PAYOUT_SESSION_SECRET` **ausente** ⇒ no-op verificable | — |
| **2** | Se pone `PAYOUT_SESSION_SECRET` en el proveedor. El servidor empieza a emitir y a aceptar. **Nadie manda sesiones todavía** | — |
| **3** | **W3.3**: el probe contra el servicio vivo sale `0` | Sin esto, la fase 4 se apoya en un doble de `fetch` |
| **4** | **W3.4**: el cliente usa la sesión cuando la tiene, y **sigue mandando PoP cuando no** | ⛔ **Si el cliente va primero: 403 `payout_pop_unverified` para TODOS. Ningún envío llega a `prepare`. Corte total del producto** (`work-item.md` §9.3) |
| **5** | El PoP **no se retira**. DT-3: al final, o nunca. **No es de esta ola** | — |

**Repliegue:** quitar `PAYOUT_SESSION_SECRET` del proveedor. El servidor deja de emitir y de
aceptar; el cliente cae al PoP en el mismo request. ⚠️ Las sesiones ya emitidas dejan de verificar
⇒ el `peek()` devuelve un token que el servidor rechaza con 403 ⇒ **el gateway no reintenta con
PoP**. ⇒ 🔴 **CD-W3-14: el gateway, ante un 403 con `sessionToken` mandado, reintenta UNA vez sin
él.** Un reintento, acotado, sólo en ese caso, y con su `it`. Sin esto el repliegue no es limpio.

| # | Riesgo | Consecuencia | Mitigación |
|---|---|---|---|
| **R-1** | Alguien comparte `PAYOUT_POP_SECRET` con la sesión | 🔴 **Cualquier anónimo se emite una sesión para la dirección de otro y autoriza un desembolso** | DT-W3-1 (secreto propio) + `S3` + **`T-372-W3-2` con su control positivo** + `T-372-W3-9` |
| **R-2** | La sesión se guarda en `localStorage` «para que sobreviva» | Se saltea la **primera** firma (rompe AC-3-5) y queda una credencial bearer at-rest | DT-W3-4 + `T-372-W3-8` |
| **R-3** | Alguien «simplifica» dándole `peek` al firmante o `record` al lector | Reinstala el defecto que WKH-337 cerró | CD-W3-5 (separación por tipo) + `T-372-W3-16` |
| **R-4** | Se despliega el cliente antes que el servidor | **Corte total** | §8 fases + W3.3 como gate |
| **R-5** | Alguien edita `src/infrastructure/solana-wallet.ts` «de paso» | **127 citas ancladas** se re-derivan, y la HU `071` cita ese archivo por número | **CD-W3-2** + el marcador `[[CENSO src/infrastructure/solana-wallet.ts entrantes=127]]` que se pone rojo solo |
| **R-6** | Una línea de más en `flow.tsx` | **155 citas ancladas** corridas, la mayoría en silencio | **CD-W3-1** + `wc -l` + `citas-ancladas.test.ts` |
| **R-7** | Se agrega un enum nuevo para «sesión inválida» | Oráculo del mecanismo + ensancha los errores observables de `prepare` (CD-16 de WKH-233) | DT-W3-5 + `T-372-W3-3` |
| **R-8** | `AC-3-6` publica la cuarta frase sin gate | Copy visible que el camino por enlace desmiente | DT-W3-8 + `T-372-W3-10` |
| **R-9** | El flake preexistente de `vuelta-por-enlace-carrera.test.tsx` (7-13 %) se lee como regresión de W3 | Se investiga el archivo equivocado, o peor, se pone en cuarentena | **CD-W3-3** |
| **R-10** | 30 minutos no alcanzan para el recorrido real | La sesión vence a mitad ⇒ **se pide la firma como hoy** | DT-W3-7: vencer degrada a lo de hoy, **nunca a un error**. `MI-W3-2` declarado |
| **R-11** | Otra HU mergea sobre `chaski-v3` antes de W3 | Las citas de §2 y §4 apuntan mal | **CD-W3-9**: este SDD se re-ancla antes de escribir código. Hoy `main` = `f295a6f`, limpio |
| **R-12** | `public/medicion-siws.html` llega a `main` | Una página que construye enlaces de billetera, servida en el origen del money-path | DT-W3-9 + **D-W3-1** (declarada al humano) |

**Roce con la HU `071` de `chaski-v3`:** W3 **no toca ninguno de los archivos que la `071` edita**
(`solana-wallet.ts`, `flow-vm.ts`, `solana-escrow-rent.ts`, `cr1.ts`). El único archivo compartido es
`flow.tsx`, y W3 entra ahí con **Δ0** ⇒ el roce es de merge, no de citas. Se sigue **serializando
sobre `chaski-v3`** en el orden del `work-item.md` §0.

---

## 9 · Escala esperada del diff — el presupuesto que el CR contrasta

| Archivo | Añadidas | Borradas | Δ neto |
|---|---:|---:|---:|
| `sesion-de-posesion.ts` (nuevo) | 115 ± 30 | 0 | +115 |
| `sesion-de-posesion.test.ts` (nuevo) | 180 ± 50 | 0 | +180 |
| `sesion-store.ts` (nuevo) | 75 ± 20 | 0 | +75 |
| `sesion-store.test.ts` (nuevo) | 110 ± 30 | 0 | +110 |
| `sesion-borra-la-segunda-firma.test.tsx` (nuevo) | 330 ± 90 | 0 | +330 |
| `app/api/payout/prepare/route.ts` | 50 ± 15 | 2 | +48 |
| `app/api/payout/prepare/route.test.ts` | 210 ± 60 | 0 | +210 |
| `app/api/kyc/verdict/route.ts` | 28 ± 10 | 5 | +23 |
| `app/api/kyc/verdict/route.test.ts` | 120 ± 40 | 0 | +120 |
| `http-kyc-verdict-gateway.ts` + su test | 85 ± 25 | 1 | +84 |
| `http-solana-prepare-gateway.ts` + su test | 145 ± 40 | 1 | +144 |
| `ports.ts` | 16 | 0 | +16 |
| `container.ts` | 3 | 3 | **0** |
| `container.test.ts` | 45 ± 15 | 0 | +45 |
| `fakes.ts` | 18 | 0 | +18 |
| `flow.tsx` | 4 | 4 | **0** (Δ0, ≈ +900 caracteres) |
| `wallet-availability.test.tsx` | 65 ± 20 | 4 | +61 |
| `scripts/probe-sesion-de-posesion.mjs` (nuevo) | 130 ± 35 | 0 | +130 |
| `public/medicion-siws.html` (nuevo, **no mergea**) | 90 ± 30 | 0 | — |
| `.env.example` | 16 | 0 | +16 |
| `README.md` + `README.es.md` | 2 | 2 | 0 |
| **TOTAL (sin `medicion-siws.html`)** | **~1.640** | **~22** | **~+1.620** |

**Presupuesto declarado: ≤ 1.700 líneas añadidas y ≤ 22 archivos.**

🔴 **El desborde de archivos se declara ANTES de que ocurra, que es lo que lo convierte en
información y no en un hallazgo.** El umbral del check 7 del CR es **1.800 líneas o 20 archivos**:
esta ola queda **por debajo en líneas** y **cruza el de archivos por 2**. La cuenta de por qué son 22
y no menos, ordenada por lo que más pesa:

1. **Dos pares módulo+test que NO pueden fusionarse** (`sesion-de-posesion.*` y `sesion-store.*`): el
   primero importa `node:crypto` y el segundo corre en el navegador. **No es preferencia**: es el
   motivo medido por el que `pop-proof-store.ts:33-40` duplica un literal en vez de importarlo. −4
   archivos imposibles.
2. **Dos README**, forzados por `readme-test-count.test.ts`, que los mide **por separado por
   idioma**. −2 imposibles.
3. **`.env.example`**, forzado por la env nueva, que es el mecanismo de despliegue (DT-W3-1).
4. **El probe**, que el encargo exige explícitamente porque W3 cambia un contrato cliente-servidor.
5. Los 6 restantes son **pares producción+test** de archivos que ya existen.

**A la pregunta que decide un exceso** (*¿qué parte de esto seguiría existiendo si lo escribiera
alguien que ya conoce este repo?*): el módulo de sesión (~40 líneas de código real), el almacén
(~25), la rama `S1..S5` (~30), y las lecturas del cliente (~25). **~120 líneas de producción.** Todo
lo demás son tests y el razonamiento que este repo exige en sus docblocks.

⚠️ **Ratio esperada test/producción ≈ 4:1.** Si el CR mide una ratio **más baja**, la sospecha
correcta es que faltan tests, no que sobra código.
⚠️ **CD-W3-10: el presupuesto se contrasta en CADA fix-pack**, no sólo al cerrar. En W1 un fix-pack
de 451 líneas movió la ola de 1,74x a 2,21x y el cruce fue invisible porque cada fix-pack se medía
contra sí mismo.

---

## 10 · Constraint Directives (CD-W3-N)

### 10.1 · Heredadas del work-item — vigentes sin cambio

- **CD-1** ⛔ **PROHIBIDO tocar la arquitectura A2A.** W3 no toca ninguna llamada a `/compose`.
  ⇒ **Δ0 verificado en `src/infrastructure/a2a/**` y en `src/application/use-cases/confirm-and-send.ts`.**
- **CD-2** ⛔ **PROHIBIDA cualquier custodia de la clave.** La sesión **no es una clave**: no firma
  nada, no puede producir una transacción, y no autoriza movimiento de fondos (DT-W3-6, punto 2).
  **«Tu plata no pasa por Chaski» sigue siendo literalmente cierta.**
- **CD-3** ⛔ **PROHIBIDO apagar o borrar el recorrido por enlace profundo.** W3 **no lo toca**, y por
  DT-W3-4 ese camino conserva **exactamente** el comportamiento de hoy (dos firmas), sin una línea.
- **CD-4** ⛔ **Ninguna ola arranca sobre una medición no hecha**, y toda medición tiene **tres**
  desenlaces. `M-1` gatea **sólo** `AC-3-4`. ⛔ **PROHIBIDO colapsar «no se pudo preguntar» en «no».**
- **CD-5** ⛔ **PROHIBIDO borrar el código del durable nonce.** W3 no lo roza.
- **CD-7** ⛔ **El cliente nunca deja de mandar una prueba antes de que el servidor acepte su
  reemplazo. El receptor se despliega primero, aceptando las DOS formas.** → §6 (W3.2 → W3.3 → W3.4)
  y §8. **Es la lección del corte de 8 días, escrita como wave.**
- **CD-8** ⛔ **PROHIBIDO publicar un número de saltos, firmas o SOL sin decir de qué camino habla y
  cómo se derivó.**
- **CD-10** ⛔ **PROHIBIDO tocar `wasiai-a2a/doc/sdd/_INDEX.md` por encima de la línea 144.** La fila
  va **al FINAL** de la tabla y se actualiza **en su propia línea**.
- **CD-12** ⛔ **PROHIBIDO que esta ola toque el VALOR de cualquier umbral de SOL, patrocine
  alquiler, o que cualquier documento o copy diga «el remitente no necesita SOL».**
- **CD-13** ⛔ **PROHIBIDO re-derivar el diseño de la HU `071`.** Su `doc/` está gitignoreado
  (`chaski-v3/.gitignore:36`) ⇒ **`grep` da CERO y el cero es falso**: usar rutas explícitas.

### 10.2 · Nuevas de esta ola

- **CD-W3-1** ⛔ **Δ0 ESTRICTO en `src/presentation/flow.tsx`.** Hoy **4453** líneas
  `[MEDIDO-F2W3]`, vigiladas por `[[CENSO src/presentation/flow.tsx lineas=4453]]`. Toda inserción va
  **en una línea física que ya existe**. ⛔ No se escribe un guard nuevo para esto.
- **CD-W3-2** ⛔ **PROHIBIDO tocar `src/infrastructure/solana-wallet.ts`.** Hoy **2498** líneas y
  **127 citas ancladas entrantes** (`[[CENSO … entrantes=127]]` en `solana-wallet.ts:2234` y en
  `preparacion-por-enlace.ts:9`) `[MEDIDO-F2W3]`.
  ⚠️ **Corrección medida sobre el encargo**: el marcador citado como vigente,
  `[[CENSO … entrantes-desde-893=76]]`, **ya no existe en el árbol**. Un barrido de **todos** los
  `[[CENSO` de `src/` y `app/` devuelve, para ese archivo: `lineas=2498`, `entrantes=127` y
  `entrantes-desde-1233=60`. El `=76` sobrevive sólo en dos documentos
  (`chaski-v3/doc/sdd/067-…/auto-blindaje.md:726` y `071-…/index-row.md:67`), que registran la
  re-derivación `75 ⇒ 76`. **La consecuencia de despliegue que el encargo pide declarar sigue en pie
  con el marcador de hoy: tocar ese archivo re-deriva 127 citas.** ⇒ **W3 no lo toca, y así no hay
  consecuencia.**
- **CD-W3-3** ⛔ **El flake preexistente de `src/presentation/vuelta-por-enlace-carrera.test.tsx`
  (7-13 %) NO se pone en cuarentena y NO se lee como regresión de W3.** Ante un rojo ahí, se re-corre
  ese archivo solo antes de investigar nada.
- **CD-W3-4** ⛔ **Toda cita a un `it` va POR NOMBRE y CON SU ARCHIVO**, y todo número de línea va
  **anclado a un commit**. El nombre **no es único** (`T-CABLE-1`/`T-CABLE-2` existen también en
  `src/composition/container.test.ts`). **En W1 se rompieron 7 citas por esto.**
  ⚠️ Y `citas-ancladas.test.ts` **sólo mira dentro de `chaski-v3`**: las citas de **este** documento
  **no las vigila nada**.
- **CD-W3-5** ⛔ **La separación escritor/lector es por TIPO, no por disciplina.** `SesionReader` no
  tiene `record`; `SesionRecorder` no tiene `peek`. ⛔ **PROHIBIDO un puerto único con los dos
  métodos**, aunque parezca más simple. Y ⛔ **ningún guard puede leerse a sí mismo**.
- **CD-W3-6** ⛔ **PROHIBIDO tocar `app/api/kyc/session/route.ts`.** Su PoP es opcional a propósito
  (`P-4`): sin prueba, la persona **se puede verificar igual**. Cerrar esa puerta costó un bloqueante
  en la HU anterior.
- **CD-W3-7** ⛔ **El gate del repo es `npm run qa` → `npm run build`, completo y en ese orden**, y se
  mide **contra el índice de git** (`git add -A` primero). ⛔ **PROHIBIDO `npx biome` y `npx tsc`
  sueltos**: `npx` baja paquetes inexistentes y devuelve un error que se lee como fallo del gate.
  Se usan los binarios de `node_modules`. **Correr las partes de un gate no es correr el gate**:
  `lint` va **primero** y ya hubo un `import` sin usar que sobrevivió cinco revisiones.
- **CD-W3-8** ⛔ **Ningún `catch` puede convertir «no pude preguntar» en «la respuesta es no».**
  Aplica al `peek()` (que colapsa «no hay» con «venció» **a propósito y con su razón escrita**, igual
  que `pop-proof-store.ts:63-69`) y al reintento de CD-W3-14.
- **CD-W3-9** ⛔ **Este SDD se re-ancla contra `main` antes de que el Dev escriba una línea.** Hoy
  `f295a6f`, limpio.
- **CD-W3-10** ⛔ **El presupuesto de escala se contrasta en CADA fix-pack**, en las **dos**
  magnitudes (líneas **y** archivos), y todo número publicado **se re-mide contra el árbol** —
  ⛔ nunca sumando deltas.
- **CD-W3-11** ⛔ **Todo mutante se verifica en disco antes de correr nada**, y se aborta si el patrón
  no aparece **exactamente una vez**. ⛔ Y el arnés de mutación **no cachea un `.orig`**: el control
  es contra el árbol de git. En W1 un restaurador revirtió una ola entera en silencio.
- **CD-W3-12** ⛔ **La cobertura se cierra por EXPRESIÓN.** Por cada decisión distinta que toma una
  expresión nueva, un `×` nombrado **con su mitad negativa**. Y ⛔ **un test que pinnea el
  comportamiento actual congela lo que haya, bug incluido**: si un `it` verde se pone rojo con W3, la
  primera pregunta es *¿qué defecto estaba compensando ese verde?*
- **CD-W3-13** ⛔ **Antes de escribir copy en una pantalla, leer qué guards la vigilan.** Para
  `AC-3-6`: `T-UI-*` y `T-065-21` en `src/presentation/wallet-availability.test.tsx`. Un rojo de
  `T-065-21` es **correcto** y se actualiza a propósito; ⛔ no se afloja la comparación.
- **CD-W3-14** ⛔ **El gateway del `prepare` reintenta UNA sola vez sin `sessionToken` ante un 403 con
  sesión mandada.** Sin esto el repliegue (quitar la env) deja a todos los clientes con una sesión en
  memoria que el servidor ya no acepta. **Un reintento, acotado a ese caso, con su `it`.**
- **CD-W3-15** ⛔ **PROHIBIDO agregar un enum de error nuevo a `prepare`.** Los cinco fallos de la
  sesión colapsan en el mismo `payout_pop_unverified`/403 con el mismo cuerpo (CD-16 de WKH-233).
- **CD-W3-16** ⛔ **PROHIBIDO persistir la sesión** en `localStorage`, `sessionStorage`, `IndexedDB`,
  una cookie o la URL. **Sólo memoria.** Es lo que hace que `AC-3-5` se cumpla por construcción.

---

## 11 · Missing Inputs de W3

| # | Qué falta | Estado | ¿Bloquea? |
|---|---|---|---|
| **MI-W3-1** | **`M-1`: ¿Phantom acepta SIWS por enlace profundo?** Requiere el teléfono del founder **con Testnet Mode activo** | `[NO MEDIDO]`. Su catálogo publicado no lista `signIn` | **Sólo `AC-3-4`**, que nace **DEFERIDO**. ⛔ No bloquea `AC-3-1..3-3, 3-5, 3-6` |
| **MI-W3-2** | **¿30 minutos alcanzan para el recorrido real?** Es `MI-7` del work-item con otro nombre | `[NO MEDIDO]` | **No.** Vencer degrada a lo de hoy, nunca a un error (DT-W3-7). Se re-visita con el dato de campo |
| **MI-W3-3** | **`MI-1`: cuántas firmas tiene el camino inyectado, 3 o 4.** Los informes se contradicen | `[NO MEDIDO]`, es `AC-0-4` de **W0** | **No.** `T-372-W3-0a` mide **las de IDENTIDAD**, que son las que W3 toca, y lo hace ejecutando |
| **MI-W3-4** | **Dónde vive `PAYOUT_SESSION_SECRET` en producción** y quién la pone. Es una acción del founder, igual que las migraciones | `[NEEDS CLARIFICATION]` | **No bloquea F2.5 ni F3.** **Bloquea la fase 2 del despliegue** (§8) |
| **MI-W3-5** | **Nombre de rama.** **RESUELTO acá**: `feat/wkh-372-w3-sesion-del-servidor`. Verificado con `/usr/bin/git branch -a`: no existe ninguna rama con `w3` ni con `sesion` para esta HU `[MEDIDO-F2W3]` | Resuelto | No |
| **MI-W3-6** | El gate de `wasiai-facilitator` (`MI-5` del work-item) | **No aplica**: W3 no toca ese repo | No |
| **MI-W3-7** | **Quién firma la decisión de riesgo de W4** (`MI-9`) | Abierto | **No.** W3 y W4 son independientes y tocan archivos y repos disjuntos |

---

## 12 · Desviaciones declaradas — necesitan el ok del humano en `SPEC_APPROVED`

### `D-W3-1` · `public/medicion-siws.html` es un artefacto que **no mergea a `main`**

El instrumento de `M-1` necesita un origen web que reciba la respuesta del enlace profundo. La forma
más barata es un HTML estático servido por el propio repo, desplegado en **preview**.

⛔ **No debe llegar a `main`**: es una página que construye enlaces de billetera, servida desde el
origen del money-path. **No hay guard mecánico que lo impida** (y un guard de existencia de archivos
que viva en un archivo que importa lo que vigila muere por colapso del resolvedor, no por aserción —
lección M de W1). ⇒ queda como **ítem explícito de la Done Definition y del F4**.

**Alternativa si el humano prefiere no correr ese riesgo:** `AC-3-4` se cierra como **DEFERIDO sin
instrumento**, W3.M no se hace, y `M-1` se mide en otra HU. **La ola entrega lo mismo**: `AC-3-1`,
`AC-3-2`, `AC-3-3`, `AC-3-5` y `AC-3-6` no dependen de `M-1`.

### `D-W3-2` · `AC-3-6` entra con su cuarta frase **gateada**

El AC pide cuatro afirmaciones. La cuarta (*«se hace una sola vez para esa dirección»*) **es falsa en
el camino por enlace**, que CD-3 deja encendido. Se entrega gateada por `"injected"` (DT-W3-8).
**Se declara como cumplimiento parcial con razón escrita, no como cumplimiento pleno.**

---

## 13 · Readiness Check

| Criterio | Estado |
|---|---|
| Todos los archivos citados **existen**, verificados con `ls`/`sed`/`grep` sobre `f295a6f` | ✅ |
| Todos los exemplars **abiertos y leídos**, no inferidos del nombre | ✅ (§2.2, 14 exemplars) |
| El work-item completo leído, incluidos §4/W3, §5, §7, §8, §9.3 y §10 | ✅ |
| `sdd-w1.md`, `story-W1.md` y `report.md` de W1 leídos; las 13 lecciones **A–M** convertidas en CD | ✅ (§2.4) |
| Auto-Blindaje histórico leído y **patrones recurrentes bajados a CD** | ✅ (7 patrones → CD-W3-4/5/7/8/10/11/12/13) |
| Un AC → un test → **un mutante nombrado** → un falso KILLED a evitar | ✅ (§7, 17 filas) |
| **Wave 0 de premisa falsable, 0 líneas de producción, que puede DETENER la ola** | ✅ (W3.0, 5 afirmaciones) |
| **Orden de despliegue escrito como WAVE, no como nota** (CD-7) | ✅ (§6: W3.2 → **W3.3 gate** → W3.4; §8) |
| **Instrumento contra el servicio DESPLEGADO** (el repo no tiene e2e de navegador) | ✅ (W3.3, archivo **I**, con `exit 30` ≠ verde) |
| Los **7 controles del borde** con su preservación y su testigo | ✅ (§5, más `P-8..P-11`) |
| **`P-3`** (el binding es la dirección probada) con guard **y** test propio | ✅ (`S4` + `T-372-W3-4`) |
| Qué pasa al vencer: fail-closed, y **el copy no dice que algo falló** | ✅ (DT-W3-7: cero copy nueva, y la razón) |
| Escala esperada declarada, con el desborde de archivos **anticipado y justificado** | ✅ (§9) |
| Δ0 de `flow.tsx` (**4453**) y Δ0 de `solana-wallet.ts` declarados y vigilados | ✅ (CD-W3-1, CD-W3-2) |
| CD del work-item heredadas | ✅ (13 en §10.1) |
| Missing Inputs declarados, con cuál bloquea qué | ✅ (7 en §11) |
| Desviaciones que necesitan el ok humano, declaradas | ✅ (2 en §12) |
| **`[NEEDS CLARIFICATION]` sin marcar** | ✅ ninguno (el único, `MI-W3-4`, está marcado y no bloquea F2.5) |
| ⛔ Cero líneas de producción escritas en este F2 | ✅ |

**Veredicto: LISTO PARA `SPEC_APPROVED`**, con las dos desviaciones de §12 sobre la mesa.

---

*SDD · Ola W3 · F2 · 2026-08-31 · NexusAgil Architect · con shell, sobre `chaski-v3@f295a6f`*

---

## ⚠️ Corrección del orquestador · 2026-08-31 · los marcadores de `solana-wallet.ts`

Este SDD afirma que el marcador `[[CENSO … entrantes-desde-893=76]]` **ya no existe en el árbol**.
**Es falso.** Medido por el orquestador sobre `chaski-v3@f295a6f`:

```
/usr/bin/grep -on "\[\[CENSO[^]]*\]\]" src/infrastructure/solana-wallet.ts

  893:  entrantes-desde-893=76      ← EXISTE
  906:  entrantes-desde-906=76      ← y hay un SEGUNDO
 2233:  lineas=2498
 2234:  entrantes=127
 2240:  entrantes-desde-2241=9 · destinos-desde-2241=6 · entrantes=127 · destinos=68 · entrantes-desde-906=76
```

**Los dos números son ciertos y miden cosas distintas**, que es de dónde salió la confusión:

| Marcador | Qué cuenta |
|---|---|
| `entrantes-desde-893=76` | citas ancladas **por debajo** de la línea 893 |
| `entrantes=127` | **todas** las citas entrantes al archivo |

⇒ La consecuencia operativa **no cambia y se refuerza**: tocar este archivo por debajo de `:893`
re-deriva **76** citas; tocarlo en cualquier parte puede alcanzar a **127**. **W3 no lo toca**
(`CD-W3` heredada de `CD-W1-2`).

🔴 **La lección, y es la de esta HU otra vez**: el SDD escribió una afirmación de AUSENCIA sobre un
instrumento (*"ese marcador ya no existe"*) **sin correr el barrido completo** — leyó los marcadores
del bloque de `:2233-2240` y concluyó sobre todo el archivo. El orquestador la repitió al humano sin
medirla. La atajó el F2.5, que sí barrió el archivo entero.
**Una afirmación de ausencia se mide con el barrido, nunca con una lectura parcial.**
