# Validation Report · F4 · WKH-372 · ola **W1** · `chaski-v3@b402ab7`

> **VEREDICTO: APROBADO PARA DONE, con 3 hallazgos MENORES de drift documental y 1 AC NO VERIFICABLE
> que no es de esta ola.** Ningún AC de W1 en FAIL. Ningún hallazgo runtime.
>
> **Fecha:** 2026-08-31 · **Modo:** QUALITY · **Repo medido:** `/home/ferdev/.openclaw/workspace/chaski-v3`
> `main` en `b402ab7`, árbol limpio antes y después (verificado). **Sin pushear** (`ahead 12`).
> **Formato: DENSO**, porque hay drift que reportar.

⚠️ **La regla que gobierna este reporte:** un `archivo:línea` dice **dónde vive** el código, no **qué
hace corriendo**. Cada AC de abajo lleva su cita **y** la ejecución que lo mide, con su salida. Lo que
no se pudo ejecutar dice **NO VERIFICABLE** con esas palabras, nunca PASS.

---

## 0 · El gate del repo — corrido por F4, completo y en orden

```
cd /home/ferdev/.openclaw/workspace/chaski-v3
/usr/bin/git add -A            # índice limpio, nada que agregar (el árbol ya estaba limpio)
npm run qa                     # = lint → typecheck → typecheck:scripts → test   (package.json:20)
npm run build                  # = next build --webpack                          (package.json:10)
```

⚠️ **El nombre del gate se verificó antes de citarlo**, leyendo `package.json:20` de **este** repo
(`"qa": "npm run lint && npm run typecheck && npm run typecheck:scripts && npm run test"`).
⛔ No se usó `npx` suelto en ningún paso.

| Eslabón | Salida literal | Exit |
|---|---|---|
| `lint` (biome) | `Checked 301 files in 94ms. No fixes applied.` | 0 |
| `typecheck` (`tsc --noEmit`) | sin salida | 0 |
| `typecheck:scripts` | sin salida | 0 |
| `test` (vitest) | `Test Files 167 passed (167)` · `Tests 3427 passed (3427)` · `Duration 19.47s` | 0 |
| **`npm run qa`** | | **`QA_EXIT=0`** |
| **`npm run build`** | `✓ Compiled` con warnings preexistentes de `node_modules` (`ox`/`viem`/`walletconnect`) | **`BUILD_EXIT=0`** |

⚠️ El exit code se **leyó**, no se supuso: se capturó con `echo "QA_EXIT=$?"` encadenado al comando.

### 0.1 · 🔴 ¿El gate CONTIENE el entregable de esta HU? — verificado por control positivo, no supuesto

Un gate puede correr entero, dar exit 0 y no mirar una línea de la HU. Se comprobó de las tres formas:

1. **Alcance declarado.** `./node_modules/.bin/tsc --noEmit --listFiles` lista los **4 archivos
   nuevos** de la ola: `salida-al-navegador-de-la-billetera.ts`, `…test.ts`,
   `recorrido-en-el-navegador-de-la-billetera.test.tsx`, `test-support/salida-al-navegador.ts`.
   `biome lint src app scripts` cubre `src/`. Los 3 archivos de test nuevos/modificados aparecen en la
   salida de vitest: `✓ …/recorrido-en-el-navegador-de-la-billetera.test.tsx (6 tests) 8272ms`,
   `✓ …/salida-al-navegador-de-la-billetera.test.ts (4 tests)`, `✓ …/diagnostico-de-vuelta.test.tsx (36 tests)`.
2. **Control positivo sobre `lint`** (`MUT-QA-2`, en un **worktree aislado**, jamás sobre el árbol
   entregado): un `import { useState } from "react";` sin usar al tope de
   `src/presentation/salida-al-navegador-de-la-billetera.ts` ⇒ `npm run lint` pasa de exit 0 a
   **`LINT_EXIT=1`**, `Found 1 error`. **El primer eslabón del gate SÍ mira el código de esta HU.**
3. **Control positivo sobre `test`** — ver §3.1: el guard de la enmienda normativa muere con su
   mutante, con **un solo `×` de 46**.

⇒ **El verde del gate tiene a esta HU como sujeto.**

### 0.2 · El flake preexistente — medido, no heredado

`src/presentation/vuelta-por-enlace-carrera.test.tsx` (declarado 7-13 %, **no es de esta HU**, CD-W1-9).

```
for i in $(seq 1 10); do ./node_modules/.bin/vitest run src/presentation/vuelta-por-enlace-carrera.test.tsx; done
⇒ vuelta-por-enlace-carrera.test.tsx @ b402ab7 => VERDE 10/10 · ROJO 0/10
```

Más la corrida dentro del gate completo ⇒ **11/11 verde**. Sumado a las 4 del CR, **15 corridas sin
rojo**. ⛔ Esto **no** dice que el flake se arregló: dice que **no apareció en 15 corridas** y que
**no hay regresión atribuible a W1**. No está en cuarentena.

---

## 1 · Runtime / Integration checks

⚠️ **W1 es cliente-only y aditiva**: no toca ningún contrato de servidor, no agrega env vars, no
agrega banderas, no toca `app/api/**` ni ninguna migración. **No hay estado de DB, env parity ni
migración que verificar en esta ola** — y eso está declarado en `story-W1.md:857` y **verificado**:

| Check | Comando | Resultado |
|---|---|---|
| Diff en `app/` (CD-1) | `git diff --numstat cc02b61 b402ab7 -- 'app/*'` | **0 archivos** ✅ |
| Env vars nuevas | el diff no agrega ninguna `NEXT_PUBLIC_*` ni lee una nueva | **ninguna** ✅ |
| Migraciones | la ola no toca SQL | **N/A** ✅ |
| Archivos borrados (CD-3/CD-5) | `git diff --diff-filter=D --name-only cc02b61 b402ab7` | **vacío**: ninguno ✅ |

### 1.1 · Los umbrales de SOL, DERIVADOS EJECUTANDO el módulo (no copiados de ningún documento)

```
./node_modules/.bin/tsx <probe que importa src/application/solana-escrow-rent.ts>
SENDER_MIN_LAMPORTS_FOR_DEPOSIT          = 8874560   = 0.00887456 SOL
SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT = 10402240  = 0.01040224 SOL
NONCE_ACCOUNT_RENT_LAMPORTS              = 1447680   = 0.00144768 SOL
DELTA (enlace − inyectado)               = 1527680
```

⇒ La derivación que el work-item §2 declaraba **re-deriva ejecutando**:
`1.527.680 = 1.447.680 (alquiler del nonce) + 5.000 + 75.000`.
⛔ Ningún valor de umbral se tocó (`solana-escrow-rent.ts` tiene **0 líneas** en el diff).

### 1.2 · El enlace de instalación (AC-1-4), medido contra la red viva

```
curl -s -o /dev/null -w "%{http_code}" https://phantom.com/download  ⇒ 200
curl -s -o /dev/null -w "%{http_code}" https://phantom.app/download  ⇒ 301
```
⇒ `URL_INSTALAR_PHANTOM = "https://phantom.com/download"`
(`salida-al-navegador-de-la-billetera.ts:40`) **es la URL que contesta 200**, y el `301` del docblock
re-deriva. El número con testigo no envejeció.

### 1.3 · El conteo de los dos README (CD-W1-7), derivado corriendo el candado

```
./node_modules/.bin/vitest run src/composition/readme-test-count.test.ts ⇒ 5 passed (5), exit 0
README.md:436     → "**167 test files**, all green. …"
README.es.md:462  → "**167 archivos de test**, todos en verde. …"
```
⇒ Los dos declaran **167**, el candado (que los mide **por separado**) da verde, y el total de la
suite (`Test Files 167 passed`) coincide. ✅

---

## 2 · 🔴 W1.0 — la premisa de la ola, los 5 puntos, EJECUTADOS

Es la puerta de la ola: **0 líneas de producción**, 5 mediciones sobre el árbol de hoy. Si alguna sale
roja, la premisa del diseño es falsa y la ola se detiene.

```
./node_modules/.bin/vitest run src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx --reporter=verbose
 ✓ T-372-W1-3  … 1373ms      ✓ T-372-W1-4  … 1317ms      ✓ T-372-W1-5  … 1205ms
 ✓ T-372-W1-12 … 1203ms      ✓ T-372-W1-11 … 1772ms      ✓ T-372-W1-13 … 1257ms
 Test Files  1 passed (1) · Tests  6 passed (6) · EXIT=0
```

**Y verifiqué que MIDEN lo que dicen, leyendo las aserciones, no sólo el verde:**

| Punto de la premisa | Instrumento | ¿Mide lo que dice? |
|---|---|---|
| **1 · No hay cuenta de nonce alcanzable** | `T-372-W1-4` (`:428`) | ✅ Y no por vacío: el colaborador `firmaPorEnlace` está **presente** y la elección de camino **sembrada** (`sembrarElCaminoPorEnlace()`), así que la ÚNICA variable libre es la disponibilidad. El docblock declara el falso KILLED (un mutante sobre `firmaPorEnlace` mataría el mismo `it` sin decir nada del gate) y exige correrlos **por separado**. |
| **2 · El umbral que corre es el inyectado, POR VALOR** | `T-372-W1-5` (`:505`) | ✅ **Calibra el instrumento antes de usarlo**: `expect(DEEPLINK).toBeGreaterThan(DEPOSIT)` — si fueran iguales el `it` no podría separarlos. Después mide **los dos bordes**: saldo `= SENDER_MIN_LAMPORTS_FOR_DEPOSIT` ⇒ `payout_submitted` + 1 firma pedida; saldo `−1` ⇒ `payout_failed` + **0** firmas. ⛔ **Importa las dos constantes; no reescribe ningún literal.** |
| **3 · `prepare()` exactamente 1 vez** | `T-372-W1-12` (`:565`) | ✅ `expect(prepare.calls.length).toBe(1)` (no `toHaveBeenCalled()`) **y** `out.snapshot.status === "payout_submitted"`: un `1` sobre un recorrido cortado sería un cero disfrazado, y el `it` lo bloquea explícitamente. |
| **4 · Nadie asigna `location.href` a un host de billetera** | `T-372-W1-3` (`:338`) | ✅ `espiarNavegacion()` reemplaza `window.location` por uno que **anota** las asignaciones. Assertea **la lista entera vacía** (`espia.asignado).toEqual([])`), no un `not.toContain`. Y el host de billetera **se deriva de `phantomBrowseUrl()`**, el productor de producción — ⛔ no se escribe a mano (antídoto `T-H1-3`). |
| **5 · El camino por enlace no se enciende adentro** | `T-372-W1-3` | ✅ `pop.respuestas` es **exactamente** `["no-corresponde"]` (la lista completa), el `fetchSpy` del emisor de desafíos **nunca se llamó**, y el envío llegó a `payout_submitted` (estado terminal asertado, contra el falso verde por no haber ejercitado nada). |

### 2.1 · El arnés: ⛔ **nadie setea la disponibilidad a mano** — verificado leyendo el código

`entrarAlNavegadorDeLaBilletera()` (`recorrido-en-el-navegador-de-la-billetera.test.tsx:149`) monta
**`SolanaProviders` de verdad**, espera la gracia, y **devuelve lo que el bridge terminó diciendo**.
Cada uno de los 6 `it` abre con `expect(await entrarAlNavegadorDeLaBilletera()).toBe("injected")` y un
mensaje que dice *"el árbol no llegó a `injected`: este `it` no está midiendo el navegador de la
billetera"*. Es el patrón `T-CABLE-2` (`wallet-availability.test.tsx:146`) y su par negativo
`T-CABLE-1` (`:128`) usa **el mismo user agent de celular** ⇒ CD-W1-11 (no mirar el user agent) está
cerrada por construcción, no por promesa.

⇒ **LA PREMISA DE W1.0 SE SOSTIENE. La ola no tenía que detenerse, y no se detuvo.**

---

## 3 · Verificación de los ACs de W1 — uno por uno, con cita **y** ejecución

| AC | Status | Cita | **Evidencia de EJECUCIÓN** |
|---|---|---|---|
| **AC-1-1** · ofrecer el salto, **dentro de un gesto**, nunca desde un efecto | ✅ **PASS** | `flow.tsx:757` (la oferta, 6 condiciones) | `T-372-W1-1` (`wallet-availability.test.tsx:1258`) **✓ verde**. Mide 7 propiedades: (1) `enlace.tagName === "A"` (es un `<a>`, no un `<button>`); (2) el hostname **se deriva** de `phantomBrowseUrl(…)`, no se escribe; (3) 🔴 **`window.location.href` es idéntico antes y después del montaje** ⇒ *nada navegó solo*; (4) el fixture **reprodujo el defecto** (`?kyc=return` puesto ANTES de medir); (5) el `?kyc` **no** viaja; (6) `?monto=400` **sí** viaja (limpiar ≠ vaciar); (7) sin remesa cargada la marca `wb` **no** viaja. Control negativo: `T-372-W1-2(control)` (`:1421`) **✓ verde** — con `"injected"` la bienvenida es **byte-idéntica** (`innerHTML`, patrón `T-065-21`). |
| **AC-1-2a** · recurrente: **0 remontajes**, **1 travesía**, 0 saltos | ✅ **PASS** (listón estricto, sin aflojar) | `flow.tsx:356-360` (atajo KYC) | `T-372-W1-13` caso (a) (`recorrido-…test.tsx:707`) **✓ verde**. Con el KYC aprobado **sembrado**: llega a `Confirmar y enviar` sin pasar por `Verificar mi identidad` (assertado ANTES de contar nada ⇒ mata el falso verde por vacío); `1 + espiaA.asignado.length === 1` ⇒ **1 travesía, 0 navegaciones ⇒ 0 remontajes**; `viajesALaBilletera(espiaA.asignado) === []` ⇒ **0 saltos**. |
| **AC-1-2b** · primera vez: declara la recarga heredada, y mide **0 viajes a la billetera** | ✅ **PASS** | `flow.tsx:460` (`window.location.href = res.url`), llamado *"una RECARGA"* por el repo en `flow.tsx:235` | `T-372-W1-13` caso (b) **✓ verde**. `1 + espiaB.asignado.length === 2` (la travesía extra **existe y se declara**, no se esconde), y 🔴 `new URL(destino).hostname === "verificacion.example"` ⇒ **la única recarga heredada es la del VERIFICADOR y de ninguna manera la de una billetera**. `viajesALaBilletera(espiaB.asignado) === []` ⇒ **0 viajes a la billetera** también en primera vez. |
| **AC-1-3** · ninguna cuenta de nonce + umbral inyectado, **sin cambiar ningún valor** | ✅ **PASS** | `confirm-and-send.ts:428`; `solana-escrow-rent.ts:187/:332/:352` | `T-372-W1-4` + `T-372-W1-5` **✓ verdes** (detalle en §2). Y **el valor**: `git diff --numstat cc02b61 b402ab7 -- src/application/solana-escrow-rent.ts` ⇒ **0 archivos**. Constantes re-derivadas ejecutando en §1.1. |
| **AC-1-4** · ofrecer instalar y crear la billetera, sin callejón, **sin custodia** | ✅ **PASS** | `salida-al-navegador-de-la-billetera.ts:40`; `flow.tsx:757`, `flow.tsx:1386` | `T-372-W1-6` (`:1443`) **✓ verde**: el `href` **es** `URL_INSTALAR_PHANTOM` *importada* (⛔ el literal no se escribe en el `it`), y `hostname` del instalador == `hostname` del universal link ⇒ termina en el **mismo** recorrido. Además cierra **CD-2** y **CD-12 ejecutablemente**: `not.toMatch(/custodi/i)` y `not.toMatch(/no necesit[áa]s? SOL/i)` sobre el copy renderizado, más `not.toContain("—")`. `T-372-W1-6b` (`:1488`) **✓ verde** cubre el enlace gemelo de `connect`. Y la URL **contesta 200** hoy (§1.2). |
| **AC-1-4b** · conservar el estado **o decirlo explícitamente**; ⛔ nunca el tercer desenlace mudo | ✅ **PASS** (sobre lo que W1 controla) | `flow.tsx:146` (la foto del aterrizaje), `flow.tsx:757` (el aviso), `bitacora-de-vuelta.ts:180-182` | **6 `it` verdes**: `T-372-W1-7` (los 3 desenlaces, con el caso (c) que impide el aviso al visitante nuevo), `T-372-W1-7b` (el hito se publica), `T-372-W1-7c` (**la enmienda normativa**, §3.1), `T-372-W1-7d` (el once-guard, con fixture que prueba que el 2º veredicto **es distinto** ⇒ mata el falso KILLED), `T-372-W1-7e` (la marca **se consume**, así que una recarga no publica un aterrizaje que no ocurrió — cierre de `CR/BLQ-MEDIO-1`), `T-372-W1-7f` (**disco ilegible ⇒ no se afirma ninguna de las dos cosas** — cierre de `CR/BLQ-BAJO-1`). Del lado de la salida: `T-372-W1-8`, `T-372-W1-9`, `T-372-W1-9b`, `T-372-W1-10` **✓ verdes**. ⚠️ **Ver §5**: si el `localStorage` cruza sigue **sin contestarse**, y el AC cierra porque el código **no lo afirma: lo pregunta**. |
| **AC-1-5** · el camino por enlace queda funcional y el nonce sin borrar | ✅ **PASS** | `src/infrastructure/solana/deeplink/**`, `nonce-duradero.ts` | `T-372-W1-11` (`recorrido-…test.tsx:609`) **✓ verde** — y ⛔ **lee el árbol**, no el diff: verifica los módulos presentes **y** que el selector *"Conectá desde tu app de billetera"* sigue apareciendo en `connect` con la bandera prendida y `"none"` (disponibilidad producida por el **mismo arnés**, sin inyectar). Corroborado independiente: `git diff --diff-filter=D --name-only cc02b61 b402ab7` ⇒ **vacío**; los **13 archivos** de `deeplink/` y `nonce-duradero.ts` están en el árbol (`ls`). |
| **AC-1-6** · `prepare()` = **1** por envío, **0** órdenes huérfanas | ✅ **PASS** | `confirm-and-send.ts:420-435` | `T-372-W1-12` **✓ verde**: `prepare.calls.length === 1` sobre un envío que **cerró** (`payout_submitted`). ⚠️ **Las huérfanas son una derivación, no una medición directa**: el propio `it` la escribe (*"cada invocación de más deja una orden huérfana, porque la remesa guarda sólo el último `payoutId`"*) ⇒ `huérfanas = calls − 1 = 0`. La derivación es mecánica y la premisa está en el código; lo digo acá para que nadie lea el `1` como si el `0` se hubiera medido aparte. |

### 3.1 · 🔴 La enmienda normativa del orquestador — VERIFICADA CONTRA EL CÓDIGO Y CONTRA UN MUTANTE

**Enmienda 1 — `AC-1-2` partido en dos.** Verificado: `AC-1-2a` se cierra con el listón estricto
(0 remontajes / 1 travesía) y `AC-1-2b` **declara** la recarga heredada del verificador **con su cita**
y **pinea su hostname**. ⛔ No se cerró `AC-1-2` mirando sólo el recorrido recurrente (sería falso
verde) ni se declaró FAIL por la recarga heredada. Las **dos** mitades viven en el mismo `it`
(`T-372-W1-13`), corrido y verde.

**Enmienda 2 — el aviso de aterrizaje lleva CUATRO condiciones.**

```
sed -n '757p' src/presentation/flow.tsx  ⇒  (extracto literal)
step === "bienvenida" && aterrizaje.vinoConMarca && rem === null
  && aterrizaje.borradorEnElDisco === "sin-borrador" ? (<Aviso tono="atencion" …
```
⇒ **Las cuatro condiciones están, en ese orden, y coinciden byte a byte con la versión normativa que
el orquestador me pasó.** ✅

**Y el guard existe y PUEDE FALLAR — control positivo corrido por F4** (`MUT-QA-1`, aplicado en un
**worktree aislado** sobre `b402ab7`; ⛔ el árbol entregado nunca se tocó, verificado por
`git status --porcelain` vacío + `md5sum` + `git rev-parse HEAD` = `b402ab7…` al final):

```
mutante: quitar `step === "bienvenida" && ` del aviso de aterrizaje (flow.tsx:757)
./node_modules/.bin/vitest run src/presentation/wallet-availability.test.tsx

× T-372-W1-7c: el aviso de aterrizaje vive en la bienvenida y no se cuela en «recuperar»
  → expect(element).not.toBeInTheDocument()
Test Files  1 failed (1) · Tests  1 failed | 45 passed (46) · EXIT=1
```

⇒ **KILLED verdadero**: **un solo `×` de 46**, y es el `it` que nombra la propiedad. No es un falso
KILLED (no murió por sintaxis, no lo mató un guard vecino, y el fixture reproduce el caso — el propio
`it` re-arma la marca antes del 2º montaje porque `flow.tsx:146` la consume, y assertea que está
puesta *en ese instante*). **La enmienda normativa está vigilada.**

### 3.2 · Las seis citas por nombre — LAS SEIS RESUELVEN

`/usr/bin/grep -rn 'it("<nombre>' src/` sobre `b402ab7`:

| Cita | Línea que declara el documento | Línea medida por F4 | |
|---|---|---|---|
| `T-CABLE-1` | `wallet-availability.test.tsx:128` | **:128** | ✅ |
| `T-CABLE-2` | `wallet-availability.test.tsx:146` | **:146** | ✅ |
| `T-H1-3` | `wallet-availability.test.tsx:975` | **:975** | ✅ |
| `T-065-20` | `wallet-availability.test.tsx:1021` | **:1021** | ✅ |
| `T-065-21` | `wallet-availability.test.tsx:1037` | **:1037** | ✅ |
| `T-372-W1-7c` | `wallet-availability.test.tsx:1660` | **:1660** | ✅ |

⚠️ **Nota, no hallazgo:** `T-CABLE-1` y `T-CABLE-2` existen **también** en
`src/composition/container.test.ts` (`:372` y `:1064`), midiendo otra cosa. El documento cita el
archivo, así que no hay ambigüedad — pero la regla *"se cita por nombre"* **no basta sola** en este
repo: el nombre del `it` no es único. Va con su archivo o no resuelve.

---

## 4 · La métrica de éxito — **derivada ejecutando por F4**, no copiada de ningún informe

⛔ **CD-12 respetada en este reporte**: lo que sigue **no dice** *"el remitente no necesita SOL"*.
Lo que W1 entrega es la eliminación de la **cuenta de nonce** por **inalcanzabilidad**, y sólo para
quien use el camino nuevo. El resto del SOL es de la HU `chaski-v3/doc/sdd/071-facilitator-adelanta-el-alquiler/`.

| Métrica | Camino por enlace (**ANTES**) | Navegador de la billetera (**DESPUÉS**) | Instrumento que lo derivó |
|---|---|---|---|
| **Saltos / viajes a la billetera** (recurrente) | 6 `[HEREDADO — no lo ejecuté: exige el camino por enlace corrido entero]` | **0** ✅ **MEDIDO** | `T-372-W1-13`(a) + `T-372-W1-3`: `viajesALaBilletera(…) === []`, host derivado de `phantomBrowseUrl` |
| **Saltos / viajes a la billetera** (primera vez) | 6 `[HEREDADO]` | **0** ✅ **MEDIDO** | `T-372-W1-13`(b): las asignaciones son 1 y su hostname es `verificacion.example` |
| **Travesías de la pantalla de entrada** (recurrente) | 7 `[HEREDADO]` | **1** ✅ **MEDIDO** | `T-372-W1-13`(a): `1 + asignaciones === 1` |
| **Travesías de la pantalla de entrada** (primera vez) | 7 `[HEREDADO]` | **2** ✅ **MEDIDO** — y la 2ª **la hereda del verificador**, no de la billetera | `T-372-W1-13`(b): `1 + asignaciones === 2`, hostname pineado |
| **Remontajes del árbol** | 6 `[HEREDADO]` | **0** ✅ **MEDIDO** (derivado: 0 navegaciones ⇒ 0 recargas ⇒ 0 remontajes; la regla `travesías = 1 + asignaciones` está escrita en el propio archivo) | `T-372-W1-13`(a) |
| **Cuenta de nonce duradero** | 1 (alquiler **1.447.680 lamports** = 0,00144768 SOL) | **0, por INALCANZABILIDAD** ✅ **MEDIDO** (`authorizePrincipal` no arma ninguna ix del System Program) | `T-372-W1-4`; y **ninguna línea se borró** para lograrlo |
| **SOL exigido por el guard** | `SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT` = **10.402.240** = 0,01040224 SOL | `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` = **8.874.560** = 0,00887456 SOL ✅ **MEDIDO POR VALOR** | `T-372-W1-5` (los dos bordes) + la sonda `tsx` de §1.1. **Δ = 1.527.680 lamports** = 1.447.680 (nonce) + 5.000 + 75.000 |
| **Invocaciones de `prepare()` por envío** | 3 `[HEREDADO]` | **1** ✅ **MEDIDO** | `T-372-W1-12`: `toBe(1)` sobre un envío que cerró |
| **Órdenes de payout huérfanas** | 2 `[HEREDADO]` | **0** ⚠️ **DERIVADO** de `prepare()=1`, no medido aparte | ídem |
| **Firmas del camino inyectado (MI-1: ¿3 o 4?)** | — | 🟡 **NO VERIFICABLE en esta ola** — ver §4.1 | — |

### 4.1 · 🟡 `AC-0-4` / `MI-1` — el número de firmas: **NO VERIFICABLE**, y digo por qué

**No pude derivarlo ejecutando, y no lo voy a repetir de ninguno de los dos números que se contradicen.**

- El informe de terreno tabula **CUATRO** firmas con sus citas y totaliza **TRES**; `work-item.md:200`
  ya lo marca como hallazgo del F1. **No repito ni el 3 ni el 4.**
- **La suite de W1.0 no cuenta firmas.** Cuenta viajes a la billetera (0), `prepare()` (1), ix de
  nonce (0) y el umbral (por valor). Ninguno de esos es un contador de firmas.
- Lo más cerca que llega un instrumento corrido: `T-372-W1-3` mide que el puerto de PoP **por enlace**
  contesta `["no-corresponde"]` y que **no se pide ningún desafío por red** (`fetchSpy` nunca llamado).
  ⚠️ **Eso NO resuelve MI-1**: `"no-corresponde"` significa *"el mecanismo por enlace no aplica"*, no
  *"no se pide la firma"*. Es exactamente la ambigüedad que `work-item.md:212` declara: las dos
  lecturas de `confirm-and-send.ts:463` son compatibles con el código, y el comentario de esa línea
  habla del **mecanismo**, no de si el gateway HTTP la pide igual.
- **Y `AC-0-4` es un AC de W0, que no es esta ola.** W1 no lo gatea y no lo cierra.

⇒ **Marcado NO VERIFICABLE, escalado a W0.** ⛔ No lo marco PASS y no invento el número.

---

## 5 · 🔴 LO QUE NADIE VERIFICÓ — dicho sin suavizar

**Estas tres cosas siguen abiertas al cerrar W1, y lo que verifiqué es que el código y el copy
NO LAS AFIRMAN.**

### 5.1 · **Nadie corrió esto en un teléfono.**
Los 21 `it` de la ola corren en **jsdom** con la librería real. Prueban **el árbol**, no el
dispositivo. El propio Story File lo escribe (`story-W1.md:726`) y lo confirmo: cero evidencia de
ejecución en hardware. ⚠️ Bajo jsdom hay además caminos de Solana estructuralmente inalcanzables
(`Buffer.from(x) instanceof Uint8Array` es `false`), y el arnés lo **declara y repara** con una sonda
medida — o sea que el entorno de medición **no es** el runtime real, y está dicho.

### 5.2 · **Si el `localStorage` cruza al navegador de la billetera SIGUE SIN CONTESTARSE.**
✅ **Verificado que el código NO lo afirma.** Marca al salir (`?wb=1`, opt-in estricto, `T-372-W1-9`)
y **pregunta** al aterrizar. Hoy son **CUATRO** desenlaces observables, no tres (el 4º lo agregó el
fix-pack del `CR/BLQ-BAJO-1`):
`con-marca-y-borrador` · `con-marca-sin-borrador` · `con-marca-disco-ilegible` · `sin-marca`
(`bitacora-de-vuelta.ts:196-201`). El copy visible **no explica la causa**: dice *"Acá no están los
datos que cargaste antes"* — lo único medido en ese instante — y **no** dice *"se perdió"* ni
*"el navegador de Phantom guarda todo aparte"*, que serían afirmaciones causales que nadie midió.
⇒ **El aviso es el instrumento de campo. Todavía no se leyó en un teléfono.**

### 5.3 · **Que el enlace `browse` ABRA Phantom, y qué pasa si no está instalada, no se midió en dispositivo real.**
✅ **Verificado que el diseño no se apoya en esa incógnita**: por eso hay un **segundo enlace explícito**
de instalación (`T-372-W1-6` y `T-372-W1-6b`, los dos verdes, sobre las dos pantallas), y el docblock
de `salida-al-navegador-de-la-billetera.ts:35-38` **declara la incógnita en vez de resolverla de palabra**.

### 5.4 · Revisión del copy visible contra estas tres — **ninguna frase las afirma**

| Frase que ve la persona | ¿Afirma algo sin medir? |
|---|---|
| *"¿Estás en un celular con Phantom?"* | No — es una **pregunta**, porque el detector no puede saberlo |
| *"Abrí Chaski adentro de Phantom y no vas a tener que saltar a otra app en cada firma."* | No — respaldado por `T-372-W1-3`/`T-372-W1-13` corridos (0 viajes). ⛔ No dice *"cero saltos"*, que omitiría la recarga del verificador |
| *"Acá no están los datos que cargaste antes"* | No — factual en ese instante, y **exige haber preguntado** (`borradorEnElDisco === "sin-borrador"`, no `!hayBorrador`) |
| *"Si al llegar no ves lo que cargaste, cargalo otra vez."* | No — condicional a propósito: **verdadera en los dos mundos y no promete ninguno** |
| *"Si estás en una computadora, instalá la extensión…"* | No — condicional, y **no se borró** |

⛔ **CD-12**: `/usr/bin/grep` sobre el diff completo ⇒ la frase *"no necesita SOL"* **no aparece**.
El único match del repo es `README.es.md:152`, **preexistente**, y es una **negación** (dice que esa
frase *sería* incorrecta). Además `T-372-W1-6` lo vigila **corriendo**.
⛔ **Sin em dashes** en el copy nuevo: verificado en el render por `T-372-W1-6` (`not.toContain("—")`).

---

## 6 · Drift Detection

### 6.1 · Scope drift — ⚠️ **11 archivos contra un `D6` de ≤9**

`git diff --numstat cc02b61 b402ab7` ⇒ **1988 añadidas / 19 borradas / 11 archivos**.

| Archivo | ¿En Scope IN §3.1? | Presupuesto §9 | Real |
|---|---|---|---|
| A–I (los 9 declarados) | ✅ | | |
| `src/test-support/salida-al-navegador.ts` | ❌ **no declarado** (creado) | — | +22 |
| `src/presentation/diagnostico-de-vuelta.test.tsx` | ❌ **no declarado** (modificado) | — | +8/−1 |

⇒ **`D6` del Done Definition (*"el diff toca como máximo los 9 archivos de §3.1"*) NO se cumple: son 11.**
⛔ **Pero ninguno de los 11 está en Scope OUT §3.2**, que es lo que sería BLOQUEANTE. Los dos extra
son un helper de test compartido y el test del archivo G. **Hallazgo MENOR, no bloqueante.**

- Scope OUT verificado **archivo por archivo** con `git diff --numstat`: `solana-wallet.ts`,
  `solana-escrow-rent.ts`, `deeplink/**`, `nonce-duradero.ts`, `preparacion-por-enlace.ts`,
  `flow-vm.ts`, `splash-puerta.ts`, `app/**` ⇒ **0 archivos**. ✅ (`D5` ✅, CD-W1-2 ✅, CD-1 ✅)

### 6.2 · Escala (check 7) — **cruzó el 2x, y está justificado por escrito**

| | Presupuesto | Real @ `b402ab7` | Ratio |
|---|---|---|---|
| Líneas añadidas | ≤ 900 | **1988** | **2,21x** |
| Archivos | ≤ 10 | **11** | 1,1x |

**Re-derivado por F4 y coincide exacto** con `auto-blindaje.md:600-620`, donde el exceso **está
declarado y justificado por escrito** (regla 10 del `CLAUDE.md`): 73,5 % del total son los dos
archivos de test grandes, y 768 de ellas son **W1.0**, la premisa falsable corrida **antes** de una
línea de producción — que es la razón por la que producción son **9 líneas físicas reescritas** con
**Δ0**. ⚠️ El CR midió 1,74x en `2ad4698` y dijo *"por debajo del 2x"*; **los tres fix-packs
posteriores lo cruzaron**, y el auto-blindaje lo registró. **No es un exceso silencioso.** ✅

### 6.3 · Δ0 — verificado con `wc -l`, no leyendo el diff

```
wc -l src/presentation/flow.tsx               ⇒ 4453   (D4 ✅, CD-W1-1 ✅)
wc -l src/presentation/diagnostico-de-vuelta.tsx ⇒ 593  (T29 ✅)
numstat de flow.tsx: 9 / 9                     ⇒ Δ0 real ✅
sed -n '44p' flow.tsx ⇒ [[CENSO … entrantes=155]] [[CENSO … destinos=92]]  (lineas=4453 intacto ✅)
sed -n '893p' solana-wallet.ts ⇒ [[CENSO … entrantes-desde-893=76]]  (archivo no editado ✅)
```
⚠️ El presupuesto decía **6 líneas** reescritas en `flow.tsx`; son **9**. Δ0 se mantiene, así que no
es violación de CD-W1-1 — es el presupuesto de §9 que envejeció con los fix-packs. **Menor.**

### 6.4 · Wave drift — **ninguno**

El orden de commits respeta W1.0 → W1.1 → W1.2 → W1.3 → W1.4, y W1.0 entró **primero y con 0 líneas
de producción**:

```
077d00b test(WKH-372/W1.0): la premisa de la ola, falsable, con cero lineas de produccion
539f8d7 feat(WKH-372/W1.1): el calculo puro de la salida al navegador de la billetera
305aeb8 feat(WKH-372/W1.2): la puerta al navegador de la billetera, con Δ0 en flow.tsx
1f93821 feat(WKH-372/W1.3): el quinto hito y su renglon, con un llamador y un guard
272023f docs(WKH-372/W1.4): cierre — las citas re-derivadas DESPUES de la ultima edicion
```
Después: 3 fix-packs (AR it1, re-AR it2, CR). ✅ **W1.3 entró ENTERA** (el 5º hito **y** su renglón:
`bitacora-de-vuelta.ts:96` + `diagnostico-de-vuelta.tsx:589` con `salida navegador: …`), que era el
"entra entero o no entra". ✅

### 6.5 · Test drift — los 13 tests del plan **existen y corren**

Los 13 de §7 están, más **8 agregados por los fix-packs** (`-1b`, `-2(control)`, `-6b`, `-7b`, `-7c`,
`-7d`, `-7e`, `-7f`, `-9b`) ⇒ **21 `it` de la ola, los 21 verdes** en corrida verbose citada arriba.
`T-372-W1-2` figura en el árbol como `T-372-W1-2(control)`. **Ningún test existente fue debilitado ni
reordenado** (`wallet-availability.test.tsx`: **694 añadidas / 5 borradas**; las 5 son la reescritura
Δ0 de líneas físicas, no borrado de aserciones).

### 6.6 · 🟡 Spec drift — **3 hallazgos MENORES, ninguno bloqueante**

#### 🟡 `QA-MNR-1` · Los documentos dicen **TRES** desenlaces; el código shippeado tiene **CUATRO**

El fix-pack del `CR/BLQ-BAJO-1` agregó el 4º (`con-marca-disco-ilegible`) y actualizó `flow.tsx:757`
(*"hay CUATRO desenlaces observables y no dos"*) y `bitacora-de-vuelta.ts:196-201`. **No se actualizó
en 5 sitios**, y uno de ellos **está en el código**:

- 🔴 `chaski-v3/src/presentation/wallet-availability.test.tsx:1531` — el `describe` se llama
  *"…con sus **TRES** desenlaces"* y **contiene adentro el `it` del cuarto** (`T-372-W1-7f`).
  El nombre del bloque contradice su propio contenido.
- `story-W1.md:638`, `story-W1.md:712` · `sdd-w1.md:232`, `sdd-w1.md:462`, `sdd-w1.md:617`.

**Clase**: CD-W1-10 (*"una frase corregida sigue pudiendo ser falsa"*) aplicada a las frases que el
propio fix-pack volvió falsas. **Nadie la cazó**: ni AR, ni CR, ni el orquestador. **Impacto**: cero
en comportamiento; el lector que audite `AC-1-4b` por el nombre del `describe` va a buscar tres casos
y encontrar cuatro. **No bloqueante.**

#### 🟡 `QA-MNR-2` · `story-W1.md:500` escribe la 4ª condición con la expresión VIEJA

Dice `!aterrizaje.hayBorrador`; el código shippeado dice `aterrizaje.borradorEnElDisco === "sin-borrador"`
(la diferencia **es** el cierre de `CR/BLQ-BAJO-1`: exige **haber preguntado**). La enmienda normativa
que me pasó el orquestador **ya trae la expresión correcta** y **el código coincide con ella byte a
byte** ⇒ validé contra la versión normativa, como corresponde. Pero el Story File en disco quedó con
la mitad vieja: la enmienda de `:501` actualizó `step === "bienvenida"` y no la cuarta condición.
**No bloqueante, y es exactamente la misma familia que `CR/MNR-3`.**

#### 🟡 `QA-MNR-3` · Un docblock de instrumento dice lo contrario de lo que hace su código

`chaski-v3/src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx:205-207` (docblock):

> *"Un href impareseable **se conserva como tal** para que no desaparezca de la cuenta en silencio."*

`:208-216` (código):
```ts
function viajesALaBilletera(asignado: string[]): string[] {
  return asignado.filter((h) => {
    try { return new URL(h).hostname === HOST_DE_LA_BILLETERA; }
    catch { return false; }        // ⇐ lo DESCARTA. Es lo opuesto al docblock.
  });
}
```

**Impacto hoy: inerte, y lo verifiqué.** `T-372-W1-3` no depende de esta función para la propiedad
fuerte (assertea `espia.asignado).toEqual([])`, la lista **cruda** y entera), y `T-372-W1-13`(b) pinea
el hostname exacto del único href asignado. Así que ningún verde de hoy se apoya en el comportamiento
que el docblock describe mal. **Pero es un contador de la métrica principal de la ola con una nota que
dice lo contrario que su código**, y el día que alguien lo reuse creyéndole al docblock, un href
impareseable desaparece del conteo en silencio — que es justo lo que la nota promete evitar.
**Recomendación: TD, una línea.** No bloqueante.

---

## 7 · Confirmación de los cierres de AR y CR (leídos, no re-ejecutados)

**AR** (2 iteraciones, cerrado) y **CR** (`RECHAZADO`, 1 `BLQ-MEDIO` + 3 `BLQ-BAJO` + 4 `MNR`) están
cerrados por los fix-packs `582f4b5`, `4f920e1`, `b0692c0`. Verifiqué que cada uno tiene **testigo
corriendo**, que es el criterio que la propia ola escribió:

| Hallazgo | Cierre | Testigo ejecutado |
|---|---|---|
| `CR/BLQ-MEDIO-1` — el instrumento se daba vuelta con una recarga | `flow.tsx:146` **consume** `wb` con `replaceState` | `T-372-W1-7e` ✓ verde |
| `CR/BLQ-BAJO-1` — *"no pude leer el disco"* colapsado en *"no hay borrador"* | 4º desenlace `con-marca-disco-ilegible` + `borradorEnElDisco === "sin-borrador"` | `T-372-W1-7f` ✓ verde |
| `CR/BLQ-BAJO-2` — I-5 sin ningún testigo | `T-372-W1-6b`, sobre la **otra** pantalla | ✓ verde, con su falso KILLED declarado |
| `CR/BLQ-BAJO-3` — enumeración de alcanzabilidad falsa ×3 | comentario re-derivado | **re-derivado por F4 ejecutando**: `grep -n 'setStep(' flow.tsx` ⇒ **24**; las de bienvenida/send ⇒ `:208 :429 :587 :794 :807 :1185 :1186 :1195 :3533`. **Coincide exacto**, incluidos los dos descartes (`:208` con `"confirm"|"verify"`, `:1185` es prosa) ✅ |
| `CR/MNR-1` — once-guard sin medición | `T-372-W1-7d` | ✓ verde, con fixture que prueba que el 2º veredicto **es distinto** |
| `CR/MNR-3` — cita rota | corregida por el orquestador | **las 6 citas re-derivan** (§3.2) ✅ |
| `CR/MNR-4` — el desborde de archivos no declarado | declarado en `auto-blindaje.md:600-620` | **re-derivado por F4**: 1988/11, 2,21x ✅ |
| `AR-it2/BLQ-BAJO-2` — la 2ª propiedad del mismo `href` | `T-372-W1-1b` | ✓ verde |

⛔ **Sub-gates NO re-ejecutados sueltos** (CR ya los confirmó). Lo que F4 sí corrió, una vez y en
orden, es **el gate completo del repo** (§0) — más los controles positivos de §0.1 y §3.1, que son
mediciones que ni CR ni AR hicieron.

---

## 8 · Done Definition — estado

| | Ítem | Estado |
|---|---|---|
| D1 | Las 38 tareas de §6 | ✅ (verificadas por sus artefactos) |
| **D2** | **Los 5 puntos de la premisa de W1.0 verdes** | ✅ **corridos por F4** (§2) |
| D3 | Los 13 tests existen, corren, con mutante muerto | ✅ 21 `it`, 21 verdes; F4 mató **2 mutantes propios** (§0.1, §3.1) |
| D4 | `wc -l flow.tsx` = 4453 | ✅ |
| D5 | 0 líneas de `solana-wallet.ts` | ✅ |
| **D6** | **≤ 9 archivos de §3.1 y ninguno de §3.2** | ⚠️ **PARCIAL: 11 archivos** (`QA` §6.1). Ninguno de §3.2 ✅ |
| D7 | Gate completo, en orden, después de `git add -A` | ✅ `QA_EXIT=0` · `BUILD_EXIT=0` |
| D8 | Los dos README con el conteo derivado corriendo | ✅ 167/167, candado verde |
| D9 | Marcadores `[[CENSO …]]` re-derivados, `lineas=4453` sin cambiar | ✅ |
| D10 | Citas nuevas re-derivadas | ✅ las 6 críticas; ⚠️ ver `QA-MNR-2` |
| D11 | Ninguna frase sin su input que la pondría en rojo | ⚠️ **3 excepciones**: `QA-MNR-1` y `QA-MNR-3` |
| D12 | Ningún guard que se lea a sí mismo | ✅ verificado en los 4 sitios de riesgo (host, prefijo, URL de instalación, alto del CTA): los cuatro **derivan** del productor de producción |
| D13 | El flake declarado con frecuencia medida | ✅ **11/11 verde**, sin cuarentena (§0.2) |
| D14 | Presupuesto de §9 o exceso justificado | ✅ 2,21x, **justificado por escrito** |
| D15 | *"el remitente no necesita SOL"* no aparece | ✅ y vigilado corriendo por `T-372-W1-6` |

---

## 9 · Smoke manual — para el operador humano, DESPUÉS del merge

⛔ **Esto NO lo ejecuté. Requiere el teléfono del founder con Phantom y Testnet Mode activo.**
Es lo único que puede contestar §5.1, §5.2 y §5.3.

1. En el **navegador común del celular**, abrir Chaski. Confirmar que aparece el bloque
   *"¿Estás en un celular con Phantom?"* con **dos** enlaces.
2. **Sin** cargar nada, tocar *"Abrir Chaski en Phantom"*. ⇒ ¿Abre Phantom? **(contesta §5.3)**
3. Adentro de Phantom, confirmar que **NO** aparece *"Acá no están los datos que cargaste antes"*
   (es un visitante nuevo: desenlace `sin-marca`).
4. Volver al navegador común. **Cargar monto + datos del familiar** hasta que exista el borrador.
5. Volver a la bienvenida y tocar *"Abrir Chaski en Phantom"* otra vez.
6. 🔴 **Adentro de Phantom, leer la pantalla — ésta es la medición de campo de toda la ola:**
   - Si **aparece** *"Acá no están los datos que cargaste antes"* ⇒ **el almacenamiento NO cruzó**.
   - Si **no aparece**, agregar `?diag=1` y leer el renglón `salida navegador:` para distinguir
     cuál de las otras tres fue: `con-marca-y-borrador` (**cruzó**), `con-marca-disco-ilegible`
     (**no se pudo preguntar**, ⛔ **no** es "cruzó"), `sin-marca` (no hubo salida).
   **(contesta §5.2)**
7. Completar un envío entero adentro de Phantom y contar: ¿cuántas veces salió de la app?
   **Esperado: 0.** **(confirma §5.1 en hardware)**
8. En un celular **sin** Phantom instalada: tocar *"Instalarla y crear mi billetera"* y confirmar
   que llega a `phantom.com/download` y **no** a una pantalla sin salida. **(confirma AC-1-4 en campo)**

---

## 10 · VEREDICTO

# ✅ APROBADO PARA DONE

- **8 ACs de W1 en PASS**, todos con cita **y** ejecución. **Cero FAIL.**
- **La premisa de W1.0 se sostiene**: los 5 puntos corridos y verdes, y verifiqué que **miden lo que
  dicen** (calibración previa, estado terminal asertado, valores importados, listas completas,
  disponibilidad leída del árbol).
- **La enmienda normativa de las 4 condiciones está implementada y VIGILADA**: control positivo con
  un solo `×` de 46.
- **Gate completo del repo, corrido por F4, en orden, contra el índice**: `QA_EXIT=0`, `BUILD_EXIT=0`,
  y **con control positivo de que el gate contiene esta HU**.
- **1 AC NO VERIFICABLE** (`AC-0-4`/`MI-1`, el número de firmas): **no es de esta ola**, se escala a
  W0. ⛔ No inventé el número ni repetí ninguno de los dos que se contradicen.
- **3 hallazgos MENORES de drift documental** (`QA-MNR-1`, `QA-MNR-2`, `QA-MNR-3`) + **1 desvío de
  `D6`** (11 archivos contra ≤9). **Ninguno bloqueante**: cero impacto en comportamiento, cero
  archivos de Scope OUT tocados. **Recomiendo cerrarlos como TD en el reporte de la ola**, no
  re-lanzar al Dev.
- **Las 3 cosas que nadie verificó están dichas sin suavizar (§5), y verifiqué que el código y el copy
  NO LAS AFIRMAN.** El smoke de §9 es la única forma de cerrarlas, y va al humano.

**El árbol quedó como lo encontré**: `git status --porcelain` vacío, `HEAD = b402ab7c70791e…`,
`md5sum` de los archivos tocados por los controles positivos **sin cambio**, worktree de mutación
removido y `git worktree prune` corrido.

---

*F4 · NexusAgil QA · WKH-372 ola W1 · 2026-08-31 · `chaski-v3@b402ab7`*
