# Validation Report — WKH-374 · **OLA W0** · F4

> **Veredicto: APROBADO. La ola 1 puede arrancar sobre estos números.**
> **Fecha:** 2026-09-01 · **Repo medido:** `chaski-v3` @ `25c3f73` (`main` local, árbol limpio, **sin pushear**)
> **Artefacto ancla:** `wasiai-a2a/doc/sdd/234-recorrido-de-la-dapp-de-cero/`
>
> 🔴 **Esta ola escribe cero líneas de producción: su único producto son números.** Por eso lo que
> sigue valida **los números**, no el código. Cada uno se **re-derivó ejecutando en esta sesión**, con
> instrumento propio donde el encargo lo pidió. ⛔ Ninguna fila de acá se apoya sólo en una cita
> `archivo:línea`: una cita dice **dónde vive** el código, no **qué hace corriendo**.
>
> ⚠️ **El árbol quedó como se encontró**: `git status --porcelain` vacío, `HEAD` = `25c3f73`, y los
> tres mutantes que apliqué (M-8, el neutralizador del `startsWith`, y M-7 sobre `flow.tsx`) se
> restauraron **contra `/usr/bin/git diff --numstat`**, verificado vacío después de cada uno.

---

## §1 · 🔴 LOS TRES NÚMEROS DE LA MÉTRICA, RE-DERIVADOS POR MÍ

| Número | Valor | Etiqueta | ¿Honesta? | Cómo lo re-deriví **yo** |
|---|---|:---:|---|---|
| **N · travesías de la pantalla de entrada** | **2** | 🟡 **derivado** (`jsdom`) | ✅ **Sí** | Corrí `T-374-W0-1` (`vitest run … --reporter=verbose`) ⇒ ✓. La aserción 5 es `expect(1 + espia.asignado.length).toBe(2)`, **precedida** por el desenlace del tramo y por la trampa del verde por vacío |
| **M · salidas a la billetera** | **1** | 🟡 **derivado** (`jsdom`) | ✅ **Sí** | Mismo `it`, aserción 6, `.toBe(1)`, comparada contra el `pathname` de `urlConectar` para no contar el universal link `browse` que comparte host |
| **k · flake heredado** | **0/20** publicado | 🟡 **foto**, ⛔ no diagnóstico | ✅ **Sí** | **Serie independiente propia: 0/10 rojas**, 10 corridas **serializadas** de `vuelta-por-enlace-carrera.test.tsx`. Acumulado con las tres series previas: **0/70** |

### 1.1 · El alcance, que es lo que vuelve honestos a `N` y `M`

🔴 **`N=2` y `M=1` son del TRAMO DE IDA, no del recorrido completo, y valen para Phantom y sólo para Phantom.**
**Verificado que el reporte lo dice y que no se publica como total** — y no en una nota al pie:

- **Está en el NOMBRE del `it`**, que es lo que imprime vitest y lo que alguien va a citar:
  `T-374-W0-1: en el camino POR ENLACE, **el TRAMO DE IDA** atraviesa la pantalla de entrada 2 veces y sale a la billetera 1 vez`.
- El docblock declara los cuatro límites y, textual, que **«El total del recorrido NO se midió en W0»**
  (`recorrido-en-el-navegador-de-la-billetera.test.tsx:867`), nombrando los saltos que faltan: la
  vuelta del connect, la firma de posesión, la de la transacción y la del patrocinio.
- **Solflare entra como distractor y se descarta**: lo afirma la aserción 3 de `T-374-W0-0`, que corrí
  ✓, comparando **por valor** (`.toEqual([hrefDeEnlace])`, no `.toHaveLength(1)`).
- ⚠️ **`N` y `M` no son dos observaciones: son una** (`N = 1 + M` por construcción). Está escrito al
  lado del código (`:1012-1019`). Quien las lea no puede tomarlas como dos mediciones independientes.

### 1.2 · El «7» heredado

✅ **Verificado que está dicho, y que `2` no se presenta como comparable con él.** `w0-report.md:71`
declara, con esas palabras, que **el «7 travesías» sigue siendo NO VERIFICABLE**, y que *«las 2
travesías que W0 midió NO son comparables con ese 7 … que 2 sea menor que 7 no dice que el recorrido
se haya simplificado»*.

⛔ **`6`, `5` y `7` NO aparecen como métrica publicada.** Verificado por barrido: cero coincidencias de
`7 traves|6 salidas|5 firmas` en los tres archivos de la ola, y en `w0-report.md` la única aparición
del `7` es **la frase que lo declara NO VERIFICABLE**.

---

## §2 · LAS OCHO MEDICIONES — cada una CORRIDA

Corrida base: `vitest run` sobre los tres archivos ⇒ **3 passed (3) · 10 tests**.

| # | Bloq. | Status | **Ejecución** (evidencia) | Cita |
|---|:---:|:---:|---|---|
| **W0-0** | 🔴 | ✅ **PASS** | ✓ `T-374-W0-0`. Los dos hosts se leen de producción; el `it` **no escribe el literal `phantom.app`**; el filtro separa **por valor** el href de Phantom del de Solflare, del verificador y de `"no-soy-una-url"` | `recorrido-…test.tsx:806-846` |
| **W0-1** | 🔴 | ✅ **PASS** | ✓ `T-374-W0-1` ⇒ **N=2**. Las 6 aserciones corren en orden: cuadrante `"none"` → observable de `pedir()` **no vacío y por valor** → desenlace del tramo → no-vacío de viajes → conteo | `:880-1029` |
| **W0-2** | 🔴 | ✅ **PASS** | Mismo `it`, aserciones 4 y 6 ⇒ **M=1**, y la 4 cierra el falso verde por vacío | `:1008-1025` |
| **W0-3** | 🔴 | ✅ **PASS** | ✓ `T-374-W0-3`, y **re-maté su mutante yo** (§3.1). `L-5` es **verdadera** ⇒ el §2 del work-item se sostiene | `el-salto-remonta-el-arbol.test.tsx` |
| **W0-4** | 🔴 | ✅ **PASS** | ✓ `T-374-W0-4`, y **re-derivé el número con mi propio barrido** (§3.3): **13 marcadores en 6 archivos**, no 12 | `costo-de-una-cita-anclada.test.ts` |
| **W0-5** | 🟡 | ✅ **PASS** | **M-7 re-aplicado por mí** sobre `flow.tsx:963` ⇒ **3 `it` rojos**, `× T-065-21`, aserción `expect(element).not.toBeInTheDocument()` (`:1049`). ⚠️ **`T-UI-3` NO cayó**, igual que reporta el Dev. ⛔ **No mide AC-13** | §3.4 |
| **W0-6** | ⬜ | 🟡 **NO VERIFICABLE** *(correctamente declarada)* | **No es medible en `jsdom`.** Verificado que **ni el código ni los documentos afirman si el disco cruza**: cero coincidencias de `localStorage (cruza\|sobrevive)` en los tres archivos | `w0-report.md` §8 |
| **W0-7** | ⬜ | ✅ **PASS** *(foto)* | **Serie propia: 0/10 rojas.** Publicada como foto, ⛔ sin cuarentena ni `skip` | §1 |

### 2.1 · Los ACs del work-item que esta ola sí toca

| AC | Status | **Ejecución** |
|---|:---:|---|
| **AC-14** *(Phantom no empeora)* | ✅ **PASS** | ✓ `T-372-W1-13` verde en mi corrida — el control exigido sigue vivo y con los mismos valores |
| **AC-15** *(cero líneas en `wasiai-a2a/src/`)* | ✅ **PASS** | `git log --since=2026-08-31 --name-only -- src/` en `wasiai-a2a` ⇒ **vacío**. Ningún commit de WKH-374 tocó ese árbol |
| **AC-17** *(todo número con etiqueta)* | ✅ **PASS** | Los tres números llevan 🟡 y su alcance; ninguno va sin etiqueta (§1) |
| **AC-18** *(lo no derivable se declara NO VERIFICABLE)* | ✅ **PASS** | El «7» está declarado con esas palabras; `W0-6` también (§1.2, §2) |
| **AC-1 … AC-13, AC-16** | ⬜ **N/A en W0** | Son de W1/W2/W3. W0 escribe cero producción y **no los mide** — y no los afirma |

---

## §3 · LOS DOS HALLAZGOS QUE COSTARON DOS FIX-PACKS — verificados **ejecutando**

### 3.1 · El candado de `L-5` ya **no es ciego a `next/link`** ✅

Re-apliqué la sonda del AR: un archivo nuevo `src/presentation/sonda-qa-m8.tsx` con
`import Link from "next/link"` y un `<Link href="/enviar">`. **El `it` se pone ROJO**, con `×` nombrado:

```
× W0-3 … > T-374-W0-3
→ el conjunto de imports de `next/link` del árbol cambió: entró una navegación BLANDA, que NO
  recarga el documento, preserva el registro de módulos y vuelve a poner en duda `L-5`:
  expected [ …(2) ] to deeply equal [ Array(1) ]
+   "src/presentation/sonda-qa-m8.tsx → import Link from \"next/link\";"
```

Sonda borrada; `git status --porcelain` vacío.

**Y su frase dejó de prometer lo que no puede.** Verificado en `el-salto-remonta-el-arbol.test.tsx:213-232`:
declara **literal** qué exige la aserción, dice **qué NO exige**, nombra los dos escapes (`E1`, `E2`)
que la dejan verde, y **cita a `T-GATE-3'`** (`app/kyc-simulado/kyc-simulado-gate.test.ts`) como el
candado real del corte, *«que lo mide llamando a la página, no leyendo su texto»*. El mensaje del
assert dejó de afirmar «dejó de cortar» y afirma sólo que la línea **desapareció** (`:240-243`).

**Confirmado el `!startsWith("//")` que hoy no vigila nada** — medido, no supuesto:

```
sed -i '236s|!l.trimStart().startsWith("//") &&|true &&|'   ⇒  Tests 1 passed (1)   [SIGUE VERDE]
```

⇒ la cláusula **no es load-bearing hoy**, exactamente como el Dev lo dejó escrito en `:228-232`.
Restaurado con `git checkout --`, `numstat` vacío.

### 3.2 · El barrido de prosa — **máximo real 65,0 %** ✅ (re-derivado con **mi propio contador**)

Implementé el contador de `w0-report.md` §7.2 por separado y lo corrí sobre las cuatro raíces:

| Lo que el reporte publica | Lo que **mi** contador da | ¿Coincide? |
|---|---|:---:|
| Máximo **65,0 %** · `prepared-claims-guard.static.test.ts` (147/79) | **65,0 %**, mismo archivo, **147/79** | ✅ |
| 174 archivos de test | **174** | ✅ |
| **26 de 174** por encima de 42,8 % | **26** (comparando `> 0,428125`, el ratio exacto de `vuelta-por-enlace`) | ✅ |
| **24 de 172** preexistentes ⇒ **≈ p86** | **24 de 172** ⇒ **p86 exacto** | ✅ |
| mediana **26,8** · p75 **37,1** · p90 **48,0** (sobre los 172) | **26,8 · 37,1 · 48,0** | ✅ |
| **7 archivos** de la casa por encima del techo formal 55 % | **7**, y **la misma lista nombre por nombre** | ✅ |
| Archivo **C** 54,5 % (156/130) · archivo **B** 43,0 % (92/122) | **54,5 %** · **43,0 %**, idénticos | ✅ |
| Los 4 calibradores heredados reproducen al decimal | **33,9 · 27,9 · 42,1 · 42,8** | ✅ |

⇒ **El 42,8 % que se publicaba como máximo es ≈ p86, no el máximo.** La corrección es correcta y el
número re-deriva. ⚠️ Único matiz, y es de redondeo, no de fondo: con el umbral **escrito** `42,8 %`
(en vez del ratio exacto `0,428125`) el conteo da **27 de 174**, porque `vuelta-por-enlace` cae
justo en el borde. No cambia ninguna conclusión.

### 3.3 · El «13 en 6 archivos» de `W0-4` — re-derivado por mí ✅

Barrido propio de marcadores sobre `src app scripts contracts`:

```
12 entrantes · 8 lineas · 1 destinos      →  6 archivos distintos
```

Una cita **anclada** nueva mueve `entrantes` (12) **+** `destinos` (1) = **13**; los 8 de `lineas` no
se mueven porque el largo no cambia. **13 en 6 archivos: confirmado independientemente.** El «12»
anterior omitía `destinos`, que es exactamente lo que dice el `BLQ-MED-1` del AR.

### 3.4 · `W0-5` / M-7 ✅

Apliqué M-7 en `flow.tsx:963` (⚠️ esa línea Δ0-empaquetada tiene **dos** gates
`mostrarSelectorDeEnlace ?`; `sed` sin `/g` muta **sólo el primero**, que es el del selector).
Verificado en disco antes de correr, `wc -l` = **4453** durante la mutación (⇒ el rojo no puede venir
del candado de censo). Resultado: **3 failed | 45 passed (48)** — `× T-065-21`, `× T-065-21b`,
`× T-065-GATE-5`; **`T-UI-3` NO cayó**. Restaurado: `numstat` vacío, `wc -l` 4453, el gate de vuelta.

---

## §4 · DRIFT

| Qué | Resultado |
|---|---|
| **Archivos tocados** (`git diff --numstat c1bd8d3 HEAD`) | **Exactamente los 5 de Scope IN**: A (+263/−1), B (+231), C (+296), `README.md` (1 línea), `README.es.md` (1 línea) |
| 🔴 **Producción** | **0 archivos, 0 líneas.** `CD-W0-1` se cumple |
| **Δ0** | `flow.tsx` = **4453** (= el marcador `lineas=4453`), `solana-wallet.ts` = **2498**. Verificado con `wc -l`, ⛔ no leyendo el diff |
| **El renombre** (`el-arbol-propio-cuesta-cero-citas` → `costo-de-una-cita-anclada`) | ✅ Limpio. Sobre el rango entero de la ola el archivo aparece como **nuevo** (nació y se renombró dentro de la misma ola) ⇒ **no quedó un archivo huérfano**: el conteo sigue en 5 |
| **Las 5 citas ancladas nuevas** | ✅ **Las cinco en UNA línea**, y **las cinco resuelven**. Verificado con `sed -n 'Np'` sobre cada destino: `no-evm-surface.test.ts:35` ⇒ `function walk(` · `:56` ⇒ `const FORBIDDEN` · `costo-de-una-cita-anclada.test.ts:77` ⇒ `function leerElArbol(` · `el-salto-remonta-el-arbol.test.tsx:114` ⇒ `function leerElArbol(` · `mock-surface.ts:51` ⇒ `export function mockDiditSurfaceEnabled(` |
| 🔴 **Anclas partidas que hayan quedado** | ✅ **Ninguna.** Barrido de `` `simbolo`, `` al final de línea en los tres archivos ⇒ el único hit (`recorrido-…:989`) es **prosa**: la línea 990 continúa la oración, no es una `ruta:NN` |
| **`CD-W0-3`** (ninguna cita anclada nueva a un archivo con censo) | ✅ Ningún destino citado lleva un marcador `[[CENSO … entrantes=]]` real. Los marcadores que aparecen en `citas-ancladas.test.ts` son **sus propios fixtures sintéticos** (`ruta/desde/la/raiz.ts`, `src/no-existe-jamas.ts`) |
| **Wave drift** | ✅ Orden respetado: `db52b11` (ola) → `571f0ca` (fix-pack AR) → `f6b752d` (fix-pack CR), cada uno con su merge |
| ⚠️ **Drift de documento** (`MNR-5`, ya declarado abierto) | La **fila 234 de `_INDEX.md`** sigue diciendo **«6 mediciones»** (son **8**), publica **«2 salidas»** —que `CD-W0-14` declara **no publicable** mientras W4 no tenga decisión— y su **estado sigue en «F1 — esperando `HU_APPROVED`»** con W0 ya mergeada. **Es trabajo del cierre**, no de la ola. **Lo dejo nombrado como pre-requisito de DONE** |

---

## §5 · EL GATE — corrido por mí, **entero y en orden**

⛔ Sin `npx biome` ni `npx tsc` sueltos. **Correr las partes de un gate no es correr el gate.**

| # | Comando literal | Exit | Salida |
|---|---|:---:|---|
| 1 | `/usr/bin/git add -A` | 0 | índice sin cambios (árbol ya limpio) |
| 2 | `npm run qa` | **0** | `lint` (biome, **312 files checked**) → `typecheck` (`tsc --noEmit`) → `typecheck:scripts` → `test`: **Test Files 174 passed (174) · Tests 3495 passed (3495)** |
| 3 | `npm run build` | **0** | `next build --webpack` completo; manifiesto con `ƒ /kyc-simulado` |

🔴 **Y verifiqué que el alcance del gate ME CONTIENE**, que es el chequeo que un verde verdadero sobre
otro sujeto no pasa:

- `tsc --noEmit --listFiles` **incluye los dos archivos nuevos** (`costo-de-una-cita-anclada.test.ts`,
  `el-salto-remonta-el-arbol.test.tsx`) ⇒ el typecheck los mira de verdad.
- `vitest` los ejecutó, nombrados: `✓ el-salto-remonta-el-arbol.test.tsx (1 test)`,
  `✓ costo-de-una-cita-anclada.test.ts (1 test)`, `✓ recorrido-…test.tsx (8 tests)`.
- **Control positivo del gate**: los tres mutantes que inyecté pusieron **rojo** al `it` correcto ⇒ el
  verde no es decorativo.

---

## §6 · 🔴 LO QUE **NADIE VERIFICÓ** — sin suavizar

1. **NINGÚN NÚMERO DE TELÉFONO. Todo es `jsdom`.** `N=2` y `M=1` son 🟡 y ⛔ **nunca 🟢** hasta que
   corran en el teléfono del founder (W3). El propio archivo lo declara en `:31-32`.
2. **`W0-6` (si el disco cruza el salto) NO SE MIDIÓ.** Dueño: **el founder**. Precondición:
   🔴 **Testnet Mode encendido en Phantom** — sin él, Phantom vuelve **sin nada y sin error**, y la
   medición saldría negativa por una causa que no es la que se mide. Fecha: **W3**.
   ⛔ ***«No se pudo preguntar» NO es «no».*** Verificado que nadie afirma lo contrario.
3. **EL TOTAL DEL RECORRIDO SIGUE SIN MEDIR.** `N`/`M` son **el tramo de ida**. Faltan la vuelta del
   connect, la firma de posesión, la de la transacción y la del patrocinio.
4. **LAS FIRMAS DEL CAMINO POR ENLACE TAMPOCO SE MIDIERON.** `w0-report.md` **no dice una palabra**
   sobre firmas — verificado por barrido, cero coincidencias. Correcto: no se afirma lo que no se midió.
5. **El «7» heredado sigue NO VERIFICABLE**, y también el «6» y el «5» (§1.2).
6. **Solflare queda afuera del instrumento.** Todo número vale para Phantom y sólo para Phantom.
7. **`AC-13` no se midió** (la bandera no existe todavía) — y está dicho con esas palabras.
8. **`DT-5` no tiene candado sobre ninguna pantalla renderizada** (`OBS-5`): `T-372-W3-8` no monta
   ningún árbol de React. Es **obligación de W1** (`CD-W0-7`), declarada y no arreglada.
9. **El flake heredado (7-13 %) es hoy un número sin testigo** (0/70 acumulado). ⛔ Repetir no prueba
   el mecanismo: **merece su propia HU** (`MNR-4`).
10. ⚠️ **`main` de `chaski-v3` sigue SIN PUSHEAR** (`25c3f73` local). El work-item ya lo marcó como
    **precondición de arranque de W1**: construir sobre una ola que sólo existe en un disco es la
    precondición invisible clásica.

---

## §7 · VEREDICTO

**APROBADO PARA DONE. ✅ La ola 1 PUEDE arrancar sobre estos números.**

**Por qué, en una línea**: las **cinco mediciones bloqueantes** (`W0-0`…`W0-4`) están **verdes y
re-ejecutadas por mí**, los tres números **re-derivan** con instrumento propio, **`L-5` quedó probada
verdadera** —así que el §2 del work-item (el vale, `DT-3`, el borrador del lado del servidor) se
sostiene—, y **ningún número se publica sin su etiqueta y su alcance**.

**Lo que hace confiable a esta ola no es que todo dé verde: es que sus dos errores fueron frases que
afirmaban más de lo medido, los dos se cazaron, y los dos ahora dicen exactamente lo que su código
verifica.** El `!startsWith("//")` que no vigila nada está declarado como tal en vez de citado como
candado; el 42,8 % que se publicaba como máximo está retirado y reemplazado por un barrido publicado.

⚠️ **Dos condiciones antes de la primera línea de W1** (ninguna bloquea este F4):
1. **Pushear `main` de `chaski-v3`** (punto 10 de §6).
2. **Cerrar `MNR-5`**: la fila 234 del `_INDEX.md` dice «6 mediciones» (son 8), publica «2 salidas»
   que `CD-W0-14` prohíbe publicar, y su estado sigue en «F1 — esperando `HU_APPROVED`».

---

*Validación F4 · WKH-374 ola W0 · 2026-09-01 · gate propio corrido entero y en orden · árbol devuelto
intacto en `25c3f73`.*
