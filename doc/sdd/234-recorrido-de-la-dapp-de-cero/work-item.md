# Work Item — [WKH-374] El recorrido de la DApp, rediseñado: 5 pantallas y 2 salidas

> **Repo ancla del artefacto**: `wasiai-a2a` (`doc/sdd/234-recorrido-de-la-dapp-de-cero/`).
> **Repo del trabajo real**: `chaski-v3` — **todo**. En `wasiai-a2a/src/` esta HU escribe **cero líneas** (CD-3).
> **Modo**: QUALITY. Toca el camino del dinero. Código de producción, no hack.

---

## §0 · Cómo se leen las citas de este documento (leer antes que nada)

⚠️ **Este F1 corrió SIN SHELL.** Las herramientas disponibles fueron `Read`, `Write` y `Glob`
únicamente: no hubo `grep`, ni `git`, ni `sed`, ni `npm`. En consecuencia:

| Etiqueta | Qué significa |
|---|---|
| `[MEDIDO]` | Lo abrí y lo leí en el árbol de hoy, en esta sesión. La cita apunta a lo que dice. |
| `[HEREDADO]` | Lo afirma otro documento (el `_INDEX.md`, la fila 233, el encargo). **No lo verifiqué.** |
| `[NO MEDIDO]` | Nadie lo midió, ni yo ni el documento del que viene. Es una incógnita declarada. |

⛔ **NINGÚN CONTEO EXHAUSTIVO DE ESTE DOCUMENTO ES PROPIO.** Sin `grep` no hay barrido: donde
digo "N sitios" es una **cota inferior contada a mano**, y está marcado. El árbol de referencia es
`chaski-v3` en `main` local, que el `_INDEX.md` de `wasiai-a2a` sitúa en `c1bd8d3` `[HEREDADO]`;
**no pude correr `git rev-parse` para confirmarlo**.

⛔ **El nombre de rama que propone este work-item es una PROPUESTA SIN VERIFICAR** (MI-6). No
pude correr `git branch -a`. Ya hay precedente en este índice de una fila que nombró una rama que
no se usó (la propia fila 233 lo declara: *«La rama `feat/233-…` que esta fila proponía no se usó»*).

---

## Resumen

El founder pidió, textual: *"como experto en UX quiero que rediseñes el viaje del DApp esta medio
confuso … aun me pide firmar varias veces, hay varios botones que confunden, hay mucha información
… realmente no sé si estoy siguiendo el camino feliz … si es necesario haz una DApp de cero,
evalúa"*. Y después: **"acepto la propuesta"**.

El diagnóstico aceptado: **la interfaz es un museo de nuestros errores**. Cada defecto de la semana
agregó un botón o un aviso, y ninguno existe porque la persona lo necesite.

Lo aprobado: **de 8 pantallas / 6 salidas a la billetera a 5 pantallas / 2 salidas**, con tres
cambios de fondo:

1. **Conectar es lo PRIMERO**, no lo del medio. Es lo que da la dirección, y con la dirección el
   envío ya puede guardarse.
2. **El envío vive en el SERVIDOR, atado a la dirección.** El enlace de vuelta trae sólo un
   identificador. De ahí sale casi todo lo que confunde hoy.
3. **Salir a la billetera es un PASO, no un error.** Se anuncia antes, se muestra mientras pasa, y
   al volver **se aterriza donde se estaba, un paso más adelante**. ⛔ Nunca en la pantalla de entrada.

---

## Sizing

- **SDD_MODE**: `full` — **y PARTIDO: un SDD por ola** (DT-8, heredado de WKH-372 y ratificado acá).
- **Estimación**: **L**. No por dificultad algorítmica: por la superficie (ver §5, el presupuesto)
  y por la decisión de DT-1, que es lo que más condiciona todo lo demás.
- **Branch sugerido**: `feat/234-recorrido-de-la-dapp-de-cero` — ⚠️ **PROPUESTA SIN VERIFICAR**.
- **Skills de dominio declaradas (máx. 2)**: `frontend-ux-flows`, `web3-wallet-integration`.

---

## §1 · LA LÍNEA DE BASE — qué está medido y qué NO

🔴 **El encargo fue explícito: la línea de base se DERIVA EJECUTANDO, no se copia.** En la HU
anterior el informe de terreno se contradijo consigo mismo sobre un conteo y quedó un AC entero
NO VERIFICABLE. Así que acá va la línea de base **partida en dos mitades**, y la segunda mitad
es el trabajo de la Wave 0.

### 1.1 · Lo que SÍ está medido en esta sesión

| # | Hecho | Cita | Etiqueta |
|---|---|---|---|
| B-1 | Los pasos del recorrido son `type Step = Destino \| "send" \| "connect" \| "review" \| "verify" \| "confirm" \| "track" \| "done"` | (`Step`, `chaski-v3/src/presentation/flow.tsx:88`) | `[MEDIDO]` |
| B-2 | `Destino = "bienvenida" \| "history" \| "recuperar"` — los destinos NO son pasos del envío | (`Destino`, `chaski-v3/src/presentation/barra-destinos.tsx:25`) | `[MEDIDO]` |
| B-3 | **8 pantallas del envío** = los 7 pasos de B-1 más `bienvenida`. `history` y `recuperar` son destinos, no pantallas del recorrido | derivado de `STEP_INDEX` (`STEP_INDEX`, `chaski-v3/src/presentation/flow.tsx:90-99`) | `[MEDIDO]` |
| B-4 | El indicador de progreso muestra **4 etiquetas para 8 pasos**: `["Enviar", "Revisar", "Identidad", "Seguir"]` | (`STEP_LABELS`, `chaski-v3/src/presentation/flow.tsx:89`) | `[MEDIDO]` |
| B-5 | `connect` es el paso **3**: se llega después de cargar monto, beneficiario y CCI | derivado de B-1 + el orden declarado en `flow.tsx:80` | `[MEDIDO]` |
| B-6 | El splash se va solo a los **1200 ms** | (`MS_EN_PANTALLA`, `chaski-v3/src/presentation/splash.tsx:60`) | `[MEDIDO]` |
| B-7 | Desde `connect` en adelante **no hay salida barata**, y el propio código lo declara **defecto ABIERTO y sin candado** | `chaski-v3/src/presentation/flow.tsx:807` (textual: *«Queda como defecto ABIERTO y sin candado»*) | `[MEDIDO]` |
| B-8 | La verificación de identidad hace `window.location.href = res.url` | `chaski-v3/src/presentation/flow.tsx:460` | `[MEDIDO]` |
| B-9 | El repo llama a esa vuelta **"una RECARGA"**, textual | `chaski-v3/src/presentation/flow.tsx:235` | `[MEDIDO]` |
| B-10 | Con KYC aprobado, `onConnect` saltea `review` y `verify` y va directo a `confirm` | `chaski-v3/src/presentation/flow.tsx:356-379` | `[MEDIDO]` |
| B-11 | `flow.tsx` tiene **4453 líneas** (la última línea de código es el `}` de `esVueltaPorEnlaceNuestra`) | `chaski-v3/src/presentation/flow.tsx:4450-4453` | `[MEDIDO]` |
| B-12 | 🔴 **Las citas ancladas entrantes son 165, no 163**, y apuntan a **96 líneas destino distintas** | el marcador `[[CENSO src/presentation/flow.tsx entrantes=165]]` y `[[CENSO src/presentation/flow.tsx destinos=96]]`, los dos en `chaski-v3/src/presentation/flow.tsx:44` | `[MEDIDO]` |
| B-13 | El envío **ya se persiste hoy**, en `localStorage`, bajo `chaski.remittances.v1` | (`KEY`, `chaski-v3/src/infrastructure/persistence.ts:15`) | `[MEDIDO]` |
| B-14 | 🔴 **El navegador de la billetera es OTRA PARTICIÓN DE ALMACENAMIENTO**, y si el `localStorage` sobrevive al salto **nadie lo midió** | `chaski-v3/src/presentation/salida-al-navegador-de-la-billetera.ts:16-20` | `[MEDIDO]` (el texto) / `[NO MEDIDO]` (el hecho) |
| B-15 | La sesión de posesión es un **token HMAC apátrida** (`payloadB64.firma`) atado a `address` + `networkId` + `exp`, TTL 30 min | (`emitirSesionDePosesion`, `chaski-v3/src/infrastructure/auth/sesion-de-posesion.ts:95-106`), (`SESION_TTL_SECONDS`, `:61`) | `[MEDIDO]` |
| B-16 | 🔴 **Lo que vive en memoria NO es la sesión del servidor: es el ALMACÉN DEL CLIENTE que la guarda**, y el docblock da **tres razones** para que sea así, incluida *«es una credencial al portador»* | `chaski-v3/src/infrastructure/auth/sesion-store.ts:16-25` | `[MEDIDO]` |
| B-17 | Ese mismo archivo declara que **el camino por enlace pierde la sesión en cada salto porque el árbol de React se remonta**, y que eso es **deliberado**, no un defecto | `chaski-v3/src/infrastructure/auth/sesion-store.ts:23-25` | `[MEDIDO]` |
| B-18 | El TTL de 30 minutos es **una hipótesis sobre cuánto tarda el recorrido, no una medición**, y el propio archivo lo dice | `chaski-v3/src/infrastructure/auth/sesion-de-posesion.ts:43-45` | `[MEDIDO]` |
| B-19 | La puerta del splash ya reconoce **cinco motivos** para no mostrarse, dos de ellos vueltas (`vuelta-de-kyc-en-la-url`, `vuelta-por-enlace-en-la-url`), y **falla CERRADO** | (`MotivoParaNoMostrar`, `chaski-v3/src/presentation/splash-puerta.ts:68-73`), (`motivoParaNoMostrar`, `:84`) | `[MEDIDO]` |
| B-20 | El patrón de bandera de la casa es **opt-in estricto**: sólo el literal `"true"` prende; `"1"`, `"TRUE"`, `"true "` o un typo ⇒ apagada | (`mwaEnabled`, `chaski-v3/src/presentation/wallet-availability.ts:98`), (`deeplinkEnabled`, `:156`) | `[MEDIDO]` |
| B-21 | ⚠️ Gotcha de despliegue de esa bandera: **las `NEXT_PUBLIC_` las inlinea el BUILD**. Cambiar el valor en Vercel y redesplegar el mismo artefacto **no cambia nada** | `chaski-v3/src/presentation/wallet-availability.ts:95-96` y `:152-154` | `[MEDIDO]` |
| B-22 | El gate del repo es **`npm run qa` → `npm run build`**, y `qa` = `lint && typecheck && typecheck:scripts && test` | (`scripts`, `chaski-v3/package.json:8-21`) | `[MEDIDO]` |
| B-23 | `RemittanceFlow` ya acepta `pasoInicial` como prop — **el aterrizaje parametrizable ya tiene un seam** | uso real en (`it("T-372-W1-13: …")`, `chaski-v3/src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx:707`, cuerpo en `:689`) | `[MEDIDO]` |
| B-24 | ✅ **YA EXISTE UN INSTRUMENTO QUE CUENTA TRAVESÍAS**, con su definición escrita: *«`travesías = 1 + asignaciones` de `window.location.href`»* | el docblock del `describe("W1.0 · cuántas veces se atraviesa la pantalla de entrada")`, `chaski-v3/src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx:676-685` | `[MEDIDO]` |
| B-25 | 🔴 **Pero ese instrumento sólo mide el cuadrante `injected`** (navegador de la billetera): recurrente ⇒ **1** travesía y 0 viajes; primera vez ⇒ **2**, y la segunda es la del **verificador**, no la de una billetera | `it("T-372-W1-13: recurrente ⇒ 1 travesía y 0 viajes a la billetera; primera vez ⇒ la recarga es del verificador")`, `chaski-v3/src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx:707` (aserciones en `:734` y `:754-757`) | `[MEDIDO]` |
| B-26 | `chaski-v3` tiene **Supabase** y **Upstash Redis** en dependencias — hay infraestructura para estado durable del lado del servidor **sin estrenar un proveedor** | `chaski-v3/package.json:31-32` (`@supabase/supabase-js`, `@upstash/ratelimit`, `@upstash/redis`) | `[MEDIDO]` |

### 1.2 · Lo que NO está medido, y por eso es la Wave 0

🔴 **Los tres números de la métrica de éxito son HOY `[HEREDADO]` o `[NO MEDIDO]`.**

| # | Afirmación | Estado | Por qué |
|---|---|---|---|
| L-1 | **"6 saltos a la billetera"** en Chrome móvil | `[HEREDADO]` de la fila 233 del `_INDEX.md` de `wasiai-a2a` | No hay ningún test que corra el camino por enlace contando saltos. La propia fila 233 lo declara: *«⛔ No existe ningún test que corra el recorrido por enlace contando firmas»* `[HEREDADO]` |
| L-2 | **"5 firmas"** | `[HEREDADO]` | Ídem. Y W3 bajó 2→1 **sólo** en el cuadrante inyectado/extensión; en Chrome móvil sigue 2→2, y **ese `2` la propia fila 233 lo etiqueta 🟡 DERIVADO, NO MEDIDO DE PUNTA A PUNTA** |
| L-3 | **"7 travesías de la pantalla de entrada"** | `[HEREDADO]` — **y hoy NO es derivable ejecutando** | El instrumento B-24 existe pero **sólo se corrió en el cuadrante `injected`** (B-25). Nadie lo apuntó al cuadrante del enlace profundo |
| L-4 | El `localStorage` sobrevive al salto al navegador de la billetera | `[NO MEDIDO]` | B-14, dicho por el propio módulo |
| L-5 | El salto por enlace remonta el árbol de React (premisa de la que cuelga todo el §2) | `[NO MEDIDO]` — es **doctrina heredada** de B-17, no una corrida | La fila 233 lo declara textual como *«premisa NO medida en esta ola»* |
| L-6 | 30 minutos de TTL alcanzan para un recorrido real | `[NO MEDIDO]` | B-18, dicho por el propio módulo |

⚠️ **Consecuencia directa: sin Wave 0, todo AC que compare contra `6`, `5` o `7` es NO VERIFICABLE.**
Ése es exactamente el defecto que dejó un AC muerto en la HU anterior. Por eso la Wave 0 **es
bloqueante y no negociable** (CD-4).

---

## §2 · LA DECISIÓN DE ARQUITECTURA — DT-1, que F2 tiene que resolver

`flow.tsx` tiene **4453 líneas** (B-11), **165 citas ancladas entrantes a 96 destinos** (B-12) y una
constraint de **Δ0 estricto** — ni una línea nueva —, vigilada por
`chaski-v3/src/composition/citas-ancladas.test.ts` a través del marcador de censo de `flow.tsx:44`.

🔴 **Rediseñar el recorrido ADENTRO de ese archivo es pelear con el andamio, y hay evidencia
mecánica de lo que eso produce.** Con Δ0 estricto, todo código nuevo se **encaja en líneas
existentes**. Medido en el árbol de hoy: `flow.tsx:162` declara un `useState` **y** un handler
completo de navegación **y** un comentario de ~1.500 caracteres, todo en un renglón físico;
`flow.tsx:163` mete **tres** declaraciones de estado; `flow.tsx:175` mete **tres** más `[MEDIDO]`.
Y el propio archivo explica por qué: *«pegar un import DESPUÉS del comentario lo deja COMENTADO sin
que `tsc` lo cace. Me pasó dos veces en esta HU»* (`flow.tsx:75`) `[MEDIDO]`.

⚠️ **Y acá se cierra el círculo con la lección de escala de la ola anterior**: el CR midió que el
desborde vivía **en los docblocks de PRODUCCIÓN (61 % de prosa contra ~50 % de la casa), no en los
tests**, y que **los tres bloqueantes de ese CR vivían justamente ahí** `[HEREDADO]`. El Δ0 no es
un vecino inocente de ese dato: **es un mecanismo que fuerza a escribir prosa de producción**,
porque cada inserción tiene que justificar en el propio renglón por qué está ahí.

### Las tres opciones, con su costo escrito

| | **A · Adentro de `flow.tsx`, con Δ0** | **B · Árbol propio detrás de una bandera** | **C · Reemplazo directo (borrar el viejo)** |
|---|---|---|---|
| **Qué es** | El recorrido nuevo se escribe encajando en las 4453 líneas actuales | Un árbol de componentes nuevo, `flow.tsx` intacto, una bandera opt-in estricto (patrón B-20) decide cuál monta | Se reescribe `flow.tsx` y se borra el viejo en el mismo cambio |
| **Costo de citas** | **Cero citas rotas** si el Δ0 se respeta | **Cero citas rotas**: un archivo nuevo no recibe ninguna cita anclada de nadie (el propio repo lo dice en `salida-al-navegador-de-la-billetera.ts:13-14` `[MEDIDO]`) | 🔴 **165 citas ancladas a re-derivar**, más las citas *sueltas* (`flow.tsx:NNNN` sin símbolo) que **no las mira ningún candado** (`flow.tsx:44` `[MEDIDO]`) |
| **Costo de prosa** | 🔴 **Alto y estructural**: cada línea encajada arrastra su justificación. Es el mecanismo del 61 % | **Bajo**: archivos nuevos, líneas nuevas, comentarios donde corresponden | Alto, más el de justificar cada re-anclaje |
| **Reversibilidad** | Baja: el cambio está entrelazado con el código viejo | 🟢 **Alta**: quitar la env vuelve al recorrido de hoy, byte-idéntico (mismo mecanismo que B-20/B-21) | 🔴 **Nula sin revert de git** |
| **Riesgo money-path** | Medio: se edita el archivo que hoy orquesta el depósito | 🟢 **Bajo mientras la bandera esté apagada**: el camino que mueve plata hoy no se toca | 🔴 **Alto**: no hay repliegue |
| **Costo propio** | Mantener el Δ0 en un rediseño de 5 pantallas es, en la práctica, **inviable** | 🔴 **DOS CAMINOS QUE MANTENER A LA VEZ** (ver R-1) | Cero caminos duplicados |
| **Recomendación del Analyst** | ❌ | 🟢 **Recomendada** | ❌ (hoy) |

⚠️ **R-1 · EL COSTO DE B, DICHO SIN ESCONDERLO: dos caminos vivos a la vez.** Mientras la bandera
exista, **todo arreglo del camino del dinero hay que hacerlo dos veces o probar que el viejo no lo
necesita**. Es exactamente la clase de deuda que ya mordió a este ecosistema (`pop-proof-store.ts`
y `sesion-store.ts` son el mismo problema con otra credencial, y **el arreglo del reloj se hizo en
la copia y el original sigue abierto** — `[HEREDADO]` de la fila 233). ⇒ **DT-1 tiene que venir con
fecha o condición de retiro del camino viejo**, no sólo con la bandera.

📌 **Lo que la opción B NO es**: no es "una DApp de cero" en el sentido de un repo nuevo. El
dominio (`src/domain/`), los casos de uso (`src/application/use-cases/`), los adaptadores de Solana
y las rutas de `app/api/` **se reusan enteros**. Lo nuevo es **la capa de pantallas y de estado del
recorrido**, que es donde está el problema que el founder describió.

---

## §3 · Acceptance Criteria (EARS)

### Grupo 1 — La forma del recorrido

- **AC-1**: WHEN una persona abre la aplicación en Chrome móvil sin haber conectado nunca, the
  system SHALL presentar **conectar** como la primera acción del recorrido, antes de pedir monto,
  beneficiario o CCI.
- **AC-2**: the system SHALL exponer **exactamente 5 pantallas** en el recorrido de un envío,
  derivadas de una tabla única y enumerable en tiempo de test (el equivalente nuevo de `STEP_INDEX`,
  B-3), sin que ninguna pantalla del recorrido quede fuera de esa tabla.
- **AC-3**: WHILE una persona está en cualquier pantalla del recorrido posterior a la primera, the
  system SHALL ofrecer una salida **no destructiva** hacia el inicio que **no borre** el monto, el
  beneficiario ni el CCI ya cargados. *(Cierra el defecto ABIERTO de B-7.)*
- **AC-4**: the system SHALL mostrar un indicador de progreso cuyo número de etiquetas **sea igual**
  al número de pantallas del recorrido. *(Hoy son 4 etiquetas para 8 pasos, B-4.)*

### Grupo 2 — Las salidas a la billetera

- **AC-5**: WHEN el recorrido necesita salir a la billetera, the system SHALL **anunciarlo en
  pantalla antes de salir**, nombrando qué se va a firmar y por qué.
- **AC-6**: WHILE la persona está afuera en la billetera, the system SHALL dejar en pantalla un
  estado que declare que hay un salto en curso, y no una pantalla vacía ni un `spinner` sin texto.
- **AC-7**: WHEN la persona vuelve de la billetera, the system SHALL aterrizar en **el paso
  siguiente al que estaba**, y ⛔ **NUNCA** en la pantalla de entrada.
- **AC-8**: IF la vuelta de la billetera no trae el resultado esperado (marca ausente, marca sin
  consumidor, firma rechazada), THEN the system SHALL aterrizar en **el mismo paso donde estaba**
  con un motivo legible, y ⛔ **NUNCA** en la pantalla de entrada ni en un estado que obligue a
  recargar a mano.
- **AC-9**: the system SHALL exigir **como máximo 2 salidas a la billetera** en un envío que cierra.
  ⚠️ **Con la salvedad de AC-9b, que es parte del AC y no una nota al pie.**
- **AC-9b**: IF la **firma de patrocinio** (W4 de WKH-372) **no** se elimina —y esa es una decisión
  de riesgo del founder, **hoy no tomada**—, THEN el objetivo verificable de AC-9 SHALL ser
  **3 salidas, no 2**, y el reporte de cierre SHALL decir cuál de los dos objetivos se midió.

### Grupo 3 — El estado del envío

- **AC-10**: WHEN una dirección de billetera queda conectada, the system SHALL poder persistir el
  borrador del envío **del lado del servidor**, atado a esa dirección, sin que el enlace de vuelta
  transporte el contenido del envío.
- **AC-11**: WHEN el sistema construye el enlace de vuelta de un salto, the system SHALL incluir en
  él **únicamente un identificador opaco**, y ⛔ **NUNCA** el monto, el nombre del beneficiario, el
  CCI, ni ninguna credencial al portador.
- **AC-12**: IF el identificador de vuelta se presenta más de una vez, o después de su vencimiento,
  THEN the system SHALL rechazarlo sin revelar si existió.
- **AC-13**: WHERE la bandera del recorrido nuevo está **apagada o ausente**, the system SHALL
  comportarse de forma **byte-idéntica** al recorrido de hoy en las pantallas del envío, medido
  comparando el `innerHTML` del paso entero (mismo mecanismo que `T-065-21`, B-20).

### Grupo 4 — Lo que no puede empeorar

- **AC-14**: WHILE se ejecuta el recorrido **dentro del navegador de Phantom**, the system SHALL
  conservar los números que ese cuadrante ya tiene medidos: recurrente **1 travesía y 0 viajes a la
  billetera**, primera vez **2 travesías siendo la segunda la del verificador** (B-25), verificado
  con **el mismo `it` `T-372-W1-13`** o con su sucesor que aserte los mismos valores.
- **AC-15**: the system SHALL conservar el contrato con el Coordinador A2A y con los 3 agentes sin
  un solo cambio de forma de pedido ni de respuesta, y el reporte de cierre SHALL exhibir **cero
  líneas de diff** en `wasiai-a2a/src/`.
- **AC-16**: the system SHALL seguir ofreciendo **únicamente billeteras no custodiales**, y ⛔
  ninguna pantalla del recorrido nuevo SHALL ofrecer una billetera custodial ni embebida.

### Grupo 5 — La métrica, y su honestidad

- **AC-17**: the system SHALL publicar los tres números —pantallas, salidas a la billetera y
  travesías de la pantalla de entrada— **derivados por ejecución** del instrumento de la Wave 0,
  cada uno con su etiqueta de confianza (🟢 medido de punta a punta / 🟡 derivado / 🔴 no medido),
  y ⛔ ningún número SHALL publicarse sin etiqueta.
- **AC-18**: IF un número de la métrica no se pudo derivar ejecutando, THEN el reporte de cierre
  SHALL declararlo **NO VERIFICABLE** con esas palabras, y ⛔ **NO** SHALL redondearlo ni copiarlo
  de un documento anterior.

---

## §4 · La métrica de éxito, y cómo se mide

| Dimensión | Hoy (a derivar en W0) | Objetivo | Instrumento |
|---|---|---|---|
| **Pantallas del recorrido** | **8** `[MEDIDO]`, B-3 | **5** | Recorrer la tabla de pasos entera, igual que hoy hace el candado de AC-3/AC-4 sobre `STEP_INDEX` (`flow.tsx:90` `[MEDIDO]`) |
| **Salidas a la billetera** (Chrome móvil, camino por enlace) | `6` `[HEREDADO]` — **W0 lo deriva** | **2**, o **3** si W4 no se cierra (AC-9b) | Espía de `window.location.href` filtrado por host de billetera, ya escrito: `viajesALaBilletera(...)`, usado en `recorrido-en-el-navegador-de-la-billetera.test.tsx:737` y `:763` `[MEDIDO]` |
| **Travesías de la pantalla de entrada** (Chrome móvil) | `7` `[HEREDADO]` — **W0 lo deriva** | **1** en el recorrido recurrente; **2** en el de primera vez, y la segunda **declarada como la del verificador** | `travesías = 1 + asignaciones`, definición ya escrita en `recorrido-en-el-navegador-de-la-billetera.test.tsx:680-684` `[MEDIDO]` |

⛔ **Tres trampas de esta métrica, escritas antes de que alguien lea un verde de más:**

1. **Un recorrido que no cierra cuenta 0 de todo.** El instrumento existente ya se defiende de eso
   afirmando el paso alcanzado **antes** de contar (`:719-733` `[MEDIDO]`). El de W0 tiene que hacer
   lo mismo, o un `it` que nunca llegó a `confirm` da verde por vacío.
2. **Contar en `jsdom` no es contar en un teléfono.** El propio archivo de W1 lo declara:
   *«NINGUNO DE ESTOS `it` CORRE EN UN TELÉFONO»* (`:31-34` `[MEDIDO]`). El número que salga de W0
   es 🟡, no 🟢, hasta que corra en el teléfono del founder.
3. **Bajar el número borrando el camino no es ganarlo.** Si las salidas bajan porque una rama quedó
   inalcanzable, hay que decir *inalcanzable*, no *eliminada* — es la distinción que la fila 233 ya
   tuvo que hacer con la cuenta de nonce `[HEREDADO]`.

---

## §5 · Wave 0 — la premisa falsable, **0 líneas de producción**

⛔ **CD-4: ninguna ola arranca sobre una medición no hecha.** En las dos olas anteriores esto evitó
construir sobre algo falso `[HEREDADO]`. **Si cualquiera de W0-1..W0-5 sale roja, la ola se detiene
y vuelve a F1/F2.**

| # | Qué mide | Cómo, sin escribir producción | Qué la pone ROJA |
|---|---|---|---|
| **W0-1** | La **línea de base de travesías en el camino por enlace**, que es el número que la métrica compara | Apuntar el instrumento de B-24 al cuadrante del enlace: bandera `NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED` prendida, disponibilidad **leída del árbol** (patrón `T-CABLE-2`, `wallet-availability.test.tsx:146` `[MEDIDO]`), recorrido que **cierra** | Que el conteo no dé un número reproducible, o que el recorrido no llegue a un desenlace |
| **W0-2** | La **línea de base de salidas a la billetera** en ese mismo camino | `viajesALaBilletera(espia.asignado)`, ya escrito | Que dé `[]` ⇒ el caso no ejercitó nada (falso verde por vacío) |
| **W0-3** | 🔴 **Que el salto por enlace REALMENTE remonte el árbol de React** — la premisa L-5, de la que cuelga el diseño entero del §2 | Un `it` que siembre la sesión en el almacén del cliente, simule el salto y aserte `peek()` ⇒ `null`, **más un control positivo** que demuestre que el instrumento sabe contestar que **sí** hay sesión | Que la sesión sobreviva ⇒ **el diseño del identificador opaco no hace falta y el §2 cambia**; o que el control positivo no distinga ⇒ el instrumento no sirve |
| **W0-4** | Que un **archivo nuevo** no reciba ninguna cita anclada, o sea que la opción B cuesta 0 citas | Correr `citas-ancladas.test.ts` contra un módulo nuevo vacío y verificar que su censo entrante es 0 | Que el censo dé ≠ 0 ⇒ la ventaja principal de la opción B es falsa |
| **W0-5** | Que la bandera apagada deje las pantallas **byte-idénticas** | Comparar `innerHTML` del paso entero con y sin la env, mismo mecanismo que `T-065-21` `[MEDIDO]` | Cualquier diferencia con la bandera apagada |
| **W0-6** | *(no bloqueante, pero se corre)* Si el `localStorage` cruza al navegador de la billetera (L-4) | ⛔ **NO se puede cerrar en `jsdom`.** Se declara como **medición de teléfono** y se le pone dueño | — |

📌 **W0 escribe únicamente en `src/presentation/*.test.tsx`. Cero producción, cero `src/**/*.ts` no-test.**
El precedente exacto está escrito: *«estos `it` van primero y con cero producción: son la puerta de
entrada de la ola, no un test más»* (`recorrido-en-el-navegador-de-la-billetera.test.tsx:12-13` `[MEDIDO]`).

---

## §6 · Scope IN

| Qué | Dónde (repo `chaski-v3`) |
|---|---|
| La capa de pantallas del recorrido móvil | `src/presentation/**` — árbol nuevo si DT-1 resuelve **B** |
| Dónde vive el estado del recorrido | `src/presentation/**` + una ruta nueva bajo `app/api/**` para el borrador atado a la dirección |
| Cómo se vuelve de la billetera | `src/presentation/salida-al-navegador-de-la-billetera.ts`, `src/presentation/splash-puerta.ts`, `src/infrastructure/solana/deeplink/**` |
| La supervivencia de la sesión de posesión al salto | `src/infrastructure/auth/sesion-store.ts` **y su decisión de diseño**, no sólo su código (B-16) |
| El instrumento de la métrica | `src/presentation/*.test.tsx` |
| La fila del índice y los artefactos SDD | `wasiai-a2a/doc/sdd/234-recorrido-de-la-dapp-de-cero/` |

## §7 · Scope OUT, **con razón escrita**

| Qué queda afuera | Por qué, textual |
|---|---|
| ⛔ **La arquitectura A2A** (Coordinador + 3 agentes) | **Ni el Coordinador ni ningún agente pide jamás una firma: reciben strings.** El recorrido de firmas es rediseñable sin tocar ese contrato `[HEREDADO]` de la fila 233 |
| ⛔ **El programa de escrow on-chain** | Es Solidity/Anchor desplegado; un rediseño de UX no toca un programa. Cambiarlo requiere upgrade, que es otra clase de riesgo entera |
| ⛔ **El proveedor de KYC y el camino de pago** | Son terceros con su propio contrato y su propia cuota. El redirect de B-8 se **absorbe** en el diseño de vuelta, pero el proveedor no se cambia |
| ⛔ **El recorrido dentro del navegador de Phantom** | **Cierra bien de punta a punta hoy.** ⚠️ Pero **no puede empeorar**: por eso tiene un control (AC-14), no una promesa |
| ⛔ **Billeteras custodiales o embebidas** | El producto es **no custodial**, y la pantalla lo dice: *"tu plata no pasa por Chaski"*. Una billetera embebida contradice la única frase de posicionamiento que el producto tiene |
| ⛔ **Que el remitente no necesite SOL** | Es la HU **`071` de `chaski-v3`**, no ésta. Heredado de CD-12 de WKH-372 `[HEREDADO]` |
| ⛔ **Quemar el nonce del PoP** (la otra mitad de `R-3`) | Es una HU aparte, ya declarada abierta en el cierre de W3 `[HEREDADO]` |
| ⛔ **`wasiai-a2a/src/`** | Cero líneas (CD-3, AC-15) |

---

## §8 · Decisiones técnicas (DT-N)

- **DT-1** 🔴 **[LA DECISIÓN, y F2 la resuelve]** — **Recomendación del Analyst: opción B**, árbol
  propio detrás de bandera opt-in estricto, `flow.tsx` intacto en 4453 líneas y Δ0 preservado por
  construcción. Motivo: es la única opción con **repliegue de un solo interruptor** sobre un camino
  que mueve plata, y la única que cuesta **0 citas** (W0-4 lo verifica). **Costo declarado: R-1,
  dos caminos vivos.** ⇒ **DT-1 debe venir con condición de retiro del camino viejo**, no sólo con
  la bandera.
- **DT-2** — La bandera sigue el patrón de la casa **al pie de la letra**: opt-in estricto, sólo el
  literal `"true"` (B-20), y el docblock **repite** el gotcha de que las `NEXT_PUBLIC_` las inlinea
  el build (B-21). ⛔ No se inventa un mecanismo nuevo de banderas.
- **DT-3** — El **identificador de vuelta** se modela como **credencial opaca, de un solo uso y TTL
  corto**, no como el token de sesión. El exemplar ya existe **en el otro repo de este ecosistema**:
  `a2a_agent_links` / `claim_agent_link` (token hasheado, `owner_ref`, `expires_at`, máquina de
  estados y **claim atómico por RPC**) `[HEREDADO]` de la fila 225 del `_INDEX.md` de `wasiai-a2a`.
  ⛔ **No se copia el código; se copia la forma.**
- **DT-4** 🔴 **La tensión que F2 tiene que desatar, y que el encargo no traía**: la propuesta dice
  *"el envío vive en el servidor, atado a la dirección"*, pero **leer un borrador atado a una
  dirección exige autenticar esa dirección**, y la credencial que lo haría es justamente la que
  **no sobrevive al salto** (B-16, B-17). Es circular. La salida es DT-3: **el identificador de
  vuelta autoriza leer ese borrador y nada más** — no es una sesión, es un vale.
- **DT-5** — ⚠️ **Corrección de vocabulario que cambia dónde se trabaja**: el encargo dice *"la
  sesión del servidor vive en memoria"*. **Medido, es al revés**: el token del servidor es **HMAC
  apátrida** (B-15) y lo que vive en memoria es **el almacén del cliente** (B-16), por **tres
  razones deliberadas**, una de las cuales es *«es una credencial al portador»*. ⇒ **"persistirla"
  NO es mover el servidor a una base: es decidir si una credencial al portador puede tocar disco**,
  y esa es una decisión de seguridad, no de infraestructura. `[NEEDS CLARIFICATION]` para F2 con
  foco obligatorio de AR.
- **DT-6** — El estado durable del borrador usa **infraestructura ya presente** (Supabase o Upstash,
  B-26). ⛔ **No se estrena un proveedor** en una HU de UX. Cuál de los dos: `[TBD en F2]`.
- **DT-7** — Las **5 pantallas** propuestas, como plegado del 8 actual: `bienvenida`+`connect` → **1
  · Conectar**; `send`+`review` → **2 · Tu envío** (con la cotización en la misma pantalla);
  `verify` → **3 · Identidad** (sólo cuando hace falta, B-10 ya la saltea); `confirm` → **4 ·
  Confirmar**; `track`+`done` → **5 · Seguir / Recibo**. ⚠️ **El plegado exacto es propuesta del
  Analyst, `[TBD en F2]`**; lo aprobado por el founder es el **número**, no el mapeo.
- **DT-8** — **Un SDD por ola** (heredado de WKH-372 y ratificado). Las olas propuestas: **W0**
  (medición, 0 producción) → **W1** (el árbol nuevo detrás de la bandera, apagada) → **W2** (el
  borrador durable + el identificador de vuelta) → **W3** (encendido gradual + medición en teléfono).
- **DT-9** — El instrumento de la métrica **se extiende, no se reescribe**:
  `recorrido-en-el-navegador-de-la-billetera.test.tsx` ya tiene la definición de travesía, el espía
  y `viajesALaBilletera`. Escribir un contador nuevo al lado sería un segundo sitio de verdad.

---

## §9 · Constraint Directives (CD-N)

- **CD-1** ⛔ **PROHIBIDO** que el recorrido dentro del navegador de Phantom empeore. Es Scope OUT,
  pero **con control**: AC-14 exige que `T-372-W1-13` (o su sucesor con los mismos valores) siga
  verde. Un Scope OUT sin control es una promesa.
- **CD-2** ⛔ **PROHIBIDO** ofrecer, mencionar o integrar cualquier billetera custodial o embebida.
  **OBLIGATORIO** que toda pantalla nueva que hable de fondos preserve la afirmación no custodial.
- **CD-3** ⛔ **PROHIBIDO** tocar la arquitectura A2A: cero cambios en la forma de los pedidos y
  respuestas al Coordinador y a los 3 agentes, y **cero líneas en `wasiai-a2a/src/`**.
- **CD-4** ⛔ **PROHIBIDO que una ola arranque sobre una medición no hecha.** W0 corre entera y
  verde antes de la primera línea de producción. Si una premisa sale roja, **la ola se detiene**.
- **CD-5** ⛔ **OBLIGATORIO**: todo salto a la billetera **se anuncia antes** (AC-5), **se muestra
  mientras pasa** (AC-6) y **la vuelta aterriza donde se estaba, un paso más adelante** (AC-7).
  ⛔ **PROHIBIDO aterrizar en la pantalla de entrada**, incluso en el camino de error (AC-8).
- **CD-6** ⛔ **PROHIBIDO** que el enlace de vuelta transporte monto, beneficiario, CCI o cualquier
  credencial al portador. Sólo un identificador opaco (AC-11).
- **CD-7** 🔴 **EL ORDEN DE DESPLIEGUE — el corte de 8 días de agosto vuelto regla**: **el receptor
  se despliega PRIMERO, aceptando las DOS formas** (la vieja y la nueva). Recién después el emisor.
  Al revés, el cliente manda una forma que el servidor no conoce y **el camino del dinero se corta
  en silencio**. Heredado de CD-7 de WKH-372 `[HEREDADO]`.
- **CD-8** ⛔ **PROHIBIDO** desplegar con la bandera prendida en el mismo cambio que la introduce.
  Y ⚠️ **con el gotcha escrito en el propio artefacto**: prender la env en Vercel sin **rebuildear**
  no hace nada (B-21).
- **CD-9** ⛔ **PROHIBIDO** afirmar un número de la métrica sin etiqueta de confianza, y **PROHIBIDO
  copiar `6`, `5` o `7` de un documento anterior** (AC-17, AC-18).
- **CD-10** ⛔ **PROHIBIDO tocar nada por encima de la línea 144 de
  `wasiai-a2a/doc/sdd/_INDEX.md`** — `src/lib/capability-risk.ts:82` cita `_INDEX.md:144` **por
  número** `[HEREDADO]`. Heredado de CD-10 de WKH-372.
- **CD-11** ⛔ **PROHIBIDO** que `flow.tsx` cambie de largo mientras exista su marcador de censo. Si
  DT-1 resuelve la opción A, esta CD **la vuelve inviable de hecho**, y eso es información, no un
  obstáculo.
- **CD-12** ⛔ **PROHIBIDO** que esta HU diga, insinúe o deje leer que *"el remitente no necesita
  SOL"*. Eso lo entrega la HU **`071` de `chaski-v3`**, no ésta. Heredado de CD-12 de WKH-372.
- **CD-13** ⛔ **PROHIBIDO re-derivar el diseño de la `071` desde este repo**, y ⚠️ **para
  encontrarlo hay que saber que `chaski-v3/doc/` está gitignoreado**: `grep` da **CERO falso** sobre
  él, y eso ya hizo desaparecer una HU entera durante una revisión `[HEREDADO]`.
- **CD-14** 🔴 **PRESUPUESTO DE PROSA, separado del de código** — ver §11. ⛔ **PROHIBIDO** que la
  prosa de **producción** supere el **50 %** de las líneas del archivo de producción. La ola
  anterior llegó a **61 %** y **los tres bloqueantes de su CR vivían justamente ahí** `[HEREDADO]`.

---

## §10 · Riesgo del camino del dinero — qué pasa si esto se despliega a medias

🔴 **El corte de 8 días de agosto fue un error de ORDEN**, no de código. Vale repetir el mecanismo:
un lado desplegado hablando una forma que el otro todavía no entiende. De ahí sale CD-7.

| # | Escenario a medias | Qué pasa con la plata | Mitigación |
|---|---|---|---|
| **M-1** | El **cliente** nuevo se despliega antes que el **receptor** del borrador durable | El cliente manda un identificador que el servidor no conoce ⇒ el borrador no se recupera ⇒ la persona re-carga todo, o peor, **se crea un segundo envío** | **CD-7**: receptor primero, aceptando **las dos formas**. Y el receptor sin la env correspondiente es un **no-op verificable**, mismo mecanismo ya usado por `PAYOUT_SESSION_SECRET` (B-15, regla 5) |
| **M-2** | La bandera se prende **a mitad** de un envío en curso (build nuevo servido mientras alguien está afuera en la billetera) | La vuelta aterriza en un árbol que no conoce el estado del árbol que la mandó ⇒ **aterrizaje en la pantalla de entrada**, que es exactamente lo que la HU viene a eliminar | El identificador de vuelta (DT-3) **lleva de qué árbol salió**, y el árbol que no lo reconoce **no lo consume**: lo deja para el otro |
| **M-3** | El **borrador durable** se despliega y el envío queda escrito server-side, pero el depósito on-chain nunca se firma | Borradores huérfanos acumulándose. **No hay plata en riesgo** (un borrador no mueve fondos), pero sí **PII**: hoy el beneficiario se persiste **reducido** en el cliente (`persistence.ts:17-19`, `[MEDIDO]`) | El borrador server-side **hereda esa reducción o no se escribe**. Foco obligatorio de AR |
| **M-4** | 🔴 La sesión de posesión se hace **sobrevivir al salto** guardándola en disco (la lectura ingenua de DT-5) | **Una credencial al portador con 30 min de vida queda at-rest en el navegador.** Es superficie nueva sobre el camino que autoriza el desembolso | **DT-5 + DT-3**: el vale de vuelta **no es la sesión**. ⛔ Si F2 propusiera persistir el token, eso es **BLOQUEANTE de AR** |
| **M-5** | El recorrido nuevo baja las salidas **porque una rama quedó rota**, no porque se simplificó | La métrica mejora y el envío **no cierra** | Todo `it` de conteo **afirma el desenlace antes de contar** (§4, trampa 1). Ya es el patrón del instrumento existente |
| **M-6** | Se despliega con W4 sin decidir y el reporte publica **"2 salidas"** | Una afirmación falsa en el material del founder, a días de una fecha dura | **AC-9b**: el objetivo es **3** hasta que W4 tenga dueño y decisión |
| **M-7** | El camino viejo queda vivo indefinidamente (R-1) y un arreglo de dinero se hace **sólo en uno** | Un defecto arreglado en un camino sigue vivo en el otro. **Ya pasó en este repo** con `pop-proof-store.ts` `[HEREDADO]` | **DT-1 con condición de retiro escrita**, y un test que exija que las dos ramas compartan el mismo caso de uso del dominio |

⚠️ **Lo que NO es un riesgo de esta HU, y conviene dejarlo dicho**: el Coordinador y los 3 agentes
no participan de ninguna firma (reciben strings), así que **ningún escenario de arriba puede
producir un cobro de agente distinto del de hoy** — salvo M-5, donde un recorrido que se reintenta
sí puede volver a invocar al agente de cash-out. Ese caso ya tiene precedente medido: el camino por
enlace corre `prepare()` **3 veces por envío** ⇒ 3 invocaciones pagas y 2 órdenes de payout
huérfanas `[HEREDADO]` de la fila 233. **Bajar eso a 1 es un efecto esperado de esta HU y debería
medirse**, pero **no lo pongo como AC porque el founder no lo pidió** — queda como `[TBD en F2]`.

---

## §11 · Presupuesto de escala — con la lección adentro

🔴 **Las dos olas anteriores se pasaron 2,21x y 1,68x.** Y el CR midió **dónde** estaba el exceso:
**en los docblocks de PRODUCCIÓN — 61 % de prosa contra el ~50 % de la casa —, no en los tests**
(la ratio test-código fue **4,7:1**, *por encima* del piso de 4:1 que el SDD exigía). **Y los tres
bloqueantes de ese CR vivían justamente ahí** `[HEREDADO]`.

⇒ **Este presupuesto separa prosa de código, y la prosa tiene techo propio.**

| Ola | Producción **ejecutable** | Producción **comentario** | Tests (líneas) | Archivos |
|---|---|---|---|---|
| **W0** · medición | **0** ⛔ estricto | 0 | ≤ 400 | ≤ 3 |
| **W1** · árbol nuevo, bandera apagada | ≤ 550 | ≤ 400 (**≤ 42 %**) | ≤ 2.200 | ≤ 14 |
| **W2** · borrador durable + vale de vuelta | ≤ 350 | ≤ 260 (**≤ 43 %**) | ≤ 1.400 | ≤ 10 |
| **W3** · encendido + medición en teléfono | ≤ 120 | ≤ 100 | ≤ 500 | ≤ 5 |
| **TOTAL** | **≤ 1.020** | **≤ 760** | **≤ 4.500** | **≤ 32** |

**Las reglas del presupuesto, que son la parte que importa:**

1. **La prosa de producción tiene techo propio y es ≤ 45 % del archivo.** No ≤ 50 %: se presupuesta
   **por debajo** de la media de la casa a propósito, porque la media de la casa es de donde salió
   el 61 %.
2. **La ratio test:código ejecutable se presupuesta en ~4:1 y NO se cuenta como exceso.** La ola
   anterior la tuvo en 4,7:1 y **eso no fue el problema**. Un CR que reporte "se pasó" mirando el
   total sin partir prosa/código **está midiendo mal**.
3. 🔴 **La pregunta que decide, y va escrita para el CR**: *¿qué parte de esto seguiría existiendo
   si lo escribiera alguien que ya conoce esta librería y este repo?* Un exceso justificado es
   información; **un exceso silencioso es el hallazgo**.
4. **Si el diff excede el presupuesto más de 2x, se justifica por escrito o se recorta** — y la
   justificación tiene que decir **en cuál de las tres columnas** está el exceso.
5. ⚠️ **El drift de archivos se presupuesta aparte**: la ola anterior entregó **38 archivos contra
   23 de Scope IN**, y **14 de los 15 extras eran 100 % comentario/cita** arrastrados por el
   bloqueante de citas del AR `[HEREDADO]`. Con DT-1 = opción B **ese arrastre no debería ocurrir**
   (W0-4 lo verifica). Si ocurre igual, **es señal de que la opción B no aisló lo que prometía**.

---

## §12 · Dependencias de otras HUs — **declaradas, no asumidas**

| Dependencia | Estado real | Qué implica para ESTA HU |
|---|---|---|
| **HU `071` de `chaski-v3`** (`doc/sdd/071-facilitator-adelanta-el-alquiler/`) — saca *«Crear la cuenta»* y su costo en SOL | ⏸️ **Espera el `HU_APPROVED` del founder** `[HEREDADO]` | ⛔ **Este rediseño NO puede prometer que ese paso desaparece.** Sí puede prometer que **cuando esa HU entre, desaparece sin tocar nada más** — o sea que el recorrido nuevo no puede tener el paso cableado en su estructura |
| **W4 de WKH-372** — eliminar la **firma de patrocinio** | 🔴 **Decisión de riesgo del founder, NO TOMADA. Necesita un dueño (`MI-9`, abierto)** `[HEREDADO]` | ⛔ **Si se queda, son 3 salidas, no 2.** Está escrito así en la métrica (AC-9b) y no se redondea |
| **W3 de WKH-372** — la sesión del servidor | 🟢 **Existe y está desplegada**, pero `origin/main` de `chaski-v3` estaba en `3178360` con el **receptor** y **sin el cliente**, y `main` local en `c1bd8d3` **pendiente de push** `[HEREDADO]` | ⚠️ **Precondición de arranque: verificar el estado real del push antes de la primera línea.** Construir sobre una ola que no está en `origin` es construir sobre algo que nadie más ve |
| **`TD-372-ATA-DEL-SENDER`** | Abierto, declarado en la fila 233 | No lo absorbe esta HU. Se nombra para que no se vaya en silencio |
| **La otra mitad de `R-3`** (nadie quema el nonce del PoP) | Abierta | Scope OUT. HU aparte |

---

## §13 · Missing Inputs

| # | Qué falta | Bloqueante? | Cómo se resuelve |
|---|---|---|---|
| **MI-1** | **DT-1**: adentro de `flow.tsx`, árbol nuevo con bandera, o reemplazo | 🔴 **SÍ, de F2** | El Analyst recomienda **B** con costo escrito (§2). **F2 decide y lo justifica.** No es `[NEEDS CLARIFICATION]` para el founder: es diseño |
| **MI-2** | **DT-5**: ¿puede una credencial al portador tocar disco para sobrevivir al salto? | 🔴 **SÍ, de F2** — y **foco obligatorio de AR** | Se resuelve por DT-3 (el vale ≠ la sesión). Si F2 propone otra cosa, es BLOQUEANTE |
| **MI-3** | **W4** de WKH-372: ¿se elimina la firma de patrocinio? | 🟡 **No bloquea el arranque; bloquea la MÉTRICA** | **Decisión del founder.** Hasta entonces el objetivo publicable es **3 salidas** (AC-9b) |
| **MI-4** | El **plegado exacto** de 8 pantallas a 5 (DT-7) | 🟡 No | `[TBD en F2]`. Lo aprobado es el número |
| **MI-5** | Cuánto tarda un recorrido real, y si **30 min de TTL alcanzan** (L-6) | 🟡 No bloquea el código; **sí bloquea afirmar que alcanza** | Medición de teléfono, W3. ⛔ *"No se pudo medir"* **no es** *"alcanza"* |
| **MI-6** | El **nombre de la rama** y el estado de `origin/main` de `chaski-v3` | 🟡 No | Se resuelve con **una** línea de shell en F2. **Este F1 no la pudo correr** (§0) |
| **MI-7** | El **ID de Jira** de esta HU. Propongo `WKH-374`; las HUs viven en `doc/sdd/_INDEX.md` y **no pude verificar que 374 esté libre** | 🟢 No | `[NEEDS CLARIFICATION]` cosmético. Si choca, se renumera la fila y nada más |
| **MI-8** | Si el `localStorage` cruza al navegador de la billetera (L-4 / B-14) | 🟡 No para W0/W1; **sí para afirmar cualquier cosa sobre borradores que cruzan** | Medición de teléfono. **Y es un argumento a favor del borrador server-side**, no en contra |

---

## §14 · Análisis de paralelismo

- 🔴 **Esta HU BLOQUEA a**: nada hoy. Ninguna HU abierta depende de sus pantallas.
- 🟡 **Esta HU es bloqueada POR**: nada **duro**. Puede arrancar ya por **W0**, que no escribe
  producción. ⚠️ Pero **W1 no debería mergear antes de que `main` de `chaski-v3` esté pusheado**
  (MI-3 de §12): construir sobre una ola que sólo existe en el disco de una máquina es la
  precondición invisible clásica.
- ⚔️ **Conflicto de merge REAL y previsible con la HU `071` de `chaski-v3`**: la `071` toca
  `solana-wallet.ts` y **declara 76 citas ancladas por debajo de `:897`** `[HEREDADO]`. Si esta HU
  toma la opción B, **no toca `solana-wallet.ts`** y el conflicto **desaparece** — que es un
  argumento más, y no menor, a favor de B.
- 🟢 **Puede ir en paralelo con**: la `071` (repos y archivos distintos si DT-1 = B), y con
  cualquier HU de `wasiai-a2a` (esta HU escribe cero líneas ahí, AC-15).
- **Orden consolidado propuesto**: **W0 (ya)** → verificar push de `chaski-v3` → **W1** → la `071`
  cuando el founder la apruebe → **W2** → **W3** (encendido + teléfono) → **W4 de WKH-372, que
  sigue necesitando dueño**.

---

## §15 · Nota de proceso — la fila del `_INDEX.md`

⛔ **NO se pudo actualizar `wasiai-a2a/doc/sdd/_INDEX.md`, y se declara en vez de forzarlo.**

Motivo medido: en esta sesión las herramientas disponibles fueron `Read`, `Write` y `Glob`. **No
hubo herramienta de edición parcial**, y el archivo tiene **365 líneas** con la
**CD-10 vigente: prohibido cambiar nada por encima de la línea 144**, porque
`src/lib/capability-risk.ts:82` cita `_INDEX.md:144` **por número** `[HEREDADO]`.

Escribir el archivo entero para agregar una fila es exactamente lo que CD-10 prohíbe. ⇒ **La fila
queda lista, completa y pegable en**:

`doc/sdd/234-recorrido-de-la-dapp-de-cero/index-row.md`

**Dónde va**: la tabla termina en la **fila 233, línea 225**; la **línea 226 está vacía** y la
**227 es el `---`** que abre la prosa del pie `[MEDIDO]`. La fila nueva se inserta **después de la
línea 225**, sin tocar una sola línea anterior.

⚠️ **Y hay un guardián que se pone rojo si esto no se hace**: `test/sdd-index-matches-folders.test.ts`
deriva las carpetas de `git ls-files doc/sdd` y exige que **cada carpeta de HU tenga exactamente una
fila** `[MEDIDO]`, `_INDEX.md:240-242`. ⇒ **En cuanto esta carpeta entre al índice de git y la fila
no esté, `npm test` de `wasiai-a2a` se pone ROJO.** No es opcional: es un pre-requisito del próximo
`npm test` de ese repo.
