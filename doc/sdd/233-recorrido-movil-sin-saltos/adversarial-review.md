# Adversarial Review · WKH-372 · ola W1 · `chaski-v3@550bf33`

## VEREDICTO: **RECHAZADO — 1 BLOQUEANTE-BAJO activo**

El gate corre verde y las cuatro CDs duras se cumplen. El hallazgo es un **agujero de cobertura
sobre la expresión de producción que la ola pone como puerta principal**: se puede revertir al
comportamiento defectuoso y la suite completa queda en verde.

⚠️ Este archivo lo materializó el ORQUESTADOR: el agente de AR tiene prohibido escribir `.md`.
El contenido es su reporte, sin editar.

---

## Gate — corrido entero, en orden, contra el índice

```
/usr/bin/git add -A          → índice ya limpio (HEAD == árbol)
npm run qa                   → exit 0   (lint → typecheck → typecheck:scripts → test)
                               167 archivos, 3420 tests, 0 fallos
npm run build                → exit 0   ("Compiled with warnings", warnings de `ox`/`viem`, preexistentes)
```

`biome lint` reporta **137 warnings + 1 info** (preexistentes, ninguno en archivos de W1) y sale 0.
`vuelta-por-enlace-carrera.test.tsx`: verde en **las dos** corridas completas. Sin regresión de flake.

---

## Los 4 vectores que se pidió atacar

### 1 · ¿El Dev debilitó `T-LINK-1`? → **NO. Lo reforzó.** Medido, no leído.

`src/presentation/wallet-availability.test.tsx:279-291`. Dos mutantes:

| Mutante | Aplicado en | Resultado |
|---|---|---|
| **MUT-A** = borrar `u.searchParams.delete(PARAM_KYC);` | `salida-al-navegador-de-la-billetera.ts:106` | `× T-372-W1-8`, `× T-372-W1-10` y **`× T-LINK-1`** — 3 failed / 40 passed |
| **MUT-B** = `hayBorrador={rem !== null}` → `hayBorrador={false}` | `flow.tsx:963` | **`× T-LINK-1` y sólo él** — 1 failed / 39 passed |

⇒ La forma nueva mide tres propiedades y **`T-LINK-1` es hoy el único guard del cableado punta a
punta de `hayBorrador`**. La forma vieja afirmaba que el rastro del navegador de origen viaja: medía
bien un comportamiento equivocado. El encodeado sigue medido. **OK.**

### 2 · Los mutantes: 6 re-aplicados de los declarados KILLED + 2 propios

Arnés con abort si el patrón no aparece exactamente una vez, verificación en disco antes de correr,
y `git checkout --` + md5 contra `HEAD` en las dos puntas.

| # | Mutante | `×` nombrado obtenido | ¿falso KILLED? |
|---|---|---|---|
| MUT-A (=M7) | borrar el `delete(PARAM_KYC)` | `T-372-W1-8`, `T-372-W1-10`, `T-LINK-1` | no |
| MUT-C (=M13) | condición del aviso siempre verdadera (`flow.tsx:757`) | `T-372-W1-7`, rojo producido por el **caso (c)** | no |
| MUT-D (=M15) | borrar el renglón de `diagnostico-de-vuelta.tsx:589` | `T-372-W1-7b` **y `T-DIAG-CAPTURA`** | no |
| MUT-E (=M1) | invertir el gate `!== "none"` en `solana-wallet.ts:2240` | `T-372-W1-3`, `T-372-W1-4`, `T-372-W1-12`. W1-5, W1-11 y W1-13 quedan VERDES | no — sin colapso |
| MUT-F (=M11) | quitar `disponibilidadWallet === "none"` de la oferta | `T-372-W1-2(control)`, y sólo él | no |
| MUT-G (≈M10) | la oferta deja de ser un `<a href>` | `T-372-W1-1`, y `T-372-W1-2` sigue VERDE | no |
| MUT-H (=M16) | borrar `anotarLaSalidaAlNavegador(aterrizaje)` de `flow.tsx:146` | `T-372-W1-7` y `T-372-W1-7b` | no |

**El arnés del Dev no mintió en ninguno de los seis.**

### 3 · ¿Los guards nuevos pueden fallar? → **Sí, todos.** Ninguno se lee a sí mismo.

- `T-372-W1-7b` **no** se lee a sí mismo: el literal `salida navegador:` vive en
  `diagnostico-de-vuelta.tsx:589`, el `it` en `wallet-availability.test.tsx:1379`. Muere con MUT-D y MUT-H.
- Los tres marcados por el story file cumplen: `T-372-W1-6` importa `URL_INSTALAR_PHANTOM`,
  `T-372-W1-9` importa `PARAM_SALIDA`/`VALOR_SALIDA`, `T-372-W1-10` importa `phantomBrowseUrl`.
- Barrido: **cero ocurrencias de `phantom.app` / `phantom.com`** en los tres archivos de test de W1.

### 4 · Δ0 y alcance prohibido → **todo se cumple**

```
wc -l src/presentation/flow.tsx                  → 4453   (numstat 9/9)
wc -l src/presentation/diagnostico-de-vuelta.tsx → 593    (numstat 1/1)
git diff --numstat cc02b61 550bf33 -- src/infrastructure/solana-wallet.ts → (vacío)
```

Scope OUT con **0 líneas** cada uno: `solana-wallet.ts`, `solana-escrow-rent.ts`, `deeplink/**`,
`nonce-duradero.ts`, `preparacion-por-enlace.ts`, `flow-vm.ts`, `splash-puerta.ts`, `app/**`.
CD-5 cumplida: `nonce-duradero.ts` y los 6 módulos de `deeplink/` siguen en el árbol.

---

## Otras CDs verificadas

| CD | Cómo se verificó | Resultado |
|---|---|---|
| **CD-12** | `git diff \| grep -niE 'no (necesit[áa]s?\|hace falta) .{0,10}SOL'` → 0 matches | **OK** |
| **CD-W1-11** | `grep -n 'userAgent\|navigator\.'` en los 3 módulos de producción → 0 | **OK** |
| **Gesto, no redirección** | Los dos enlaces son `<a href>`; `T-372-W1-1` asserta `tagName === "A"` y que `window.location.href` no cambió al montar. MUT-G lo mata | **OK** |
| **Copy** | Sin em dashes (asertado); no dice que algo falló; no dice "empezá de nuevo"; rioplatense | **OK** |
| **CD-W1-12** | `splash-puerta.ts` sin tocar; `PARAM_SALIDA="wb"` no aparece en otro `searchParams.get(` | **OK** |
| **Ownership guard** | Único match de `.from(` en el diff es `Buffer.from(x)` en un comentario. Cero queries | **N/A** |
| **Citas nuevas** | 15 citas re-derivadas con `sed -n 'Np'`. **Las 15 resuelven** | **OK** |
| **Foto externa** | `curl`: `phantom.com/download` → **200**, `phantom.app/download` → **301** | **OK** |
| **`?wb=1` sobrevive la barra** | `hrefSinRastroDeVuelta` sólo borra `PARAMS_DE_RESPUESTA` + `MARCA` | **OK** |
| **Hidratación** | Descartada MIDIENDO: `.next/server/app/index.html` no contiene el copy (subárbol con `ssr:false`) | **OK** |

---

## HALLAZGOS

### 🔴 `BLQ-BAJO-1` · Test Coverage · La oferta de `flow.tsx:757` no tiene guard sobre su `href`

**Archivo:línea**: `src/presentation/flow.tsx:757`.
**Guard que debería cubrirlo**: `T-372-W1-1`, `wallet-availability.test.tsx:1244-1248` — asserta
**solamente el `hostname`**.

**Reproducción (MUT-I, corrido y restaurado)**: reemplazar la expresión del `href` de la oferta por
el enlace crudo previo a W1 y correr `./node_modules/.bin/vitest run`.
**Resultado obtenido**: `EXIT=0` · `167 passed` · `3420 passed`. **Esperado**: al menos un `×`.

**Impacto.** La ola declara que arregla un defecto *"que HOY ya está en producción"* (el `?kyc=return`
viajando al navegador de la billetera). Ese arreglo quedó vigilado **sólo en el enlace secundario**
(`NoWalletHere`, `:1379`, por `T-LINK-1`). W1 introduce una **segunda instancia de la misma expresión**
en `:757`, que es **la puerta principal que la ola viene a construir** (AC-1-1), y esa no la mira nadie.

El cuadrante es alcanzable: `urlDeVueltaDeKyc` (`splash-puerta.ts:54`) aterriza en `/?kyc=return`,
`step` arranca en `"bienvenida"`, y donde el resume no reubica la pantalla la oferta renderiza con
`?kyc=return` puesto. Es el escenario R-5 del story file.

**Sugerencia**: extender `T-372-W1-1` para decodificar el segmento `browse/` y parsear el href
resultante — como ya hace `hrefQueLaBilleteraVaAAbrir` (`salida-al-navegador-de-la-billetera.test.ts:30-34`) —
y assertar, con la URL sembrada con `?monto=…&kyc=return`, que `kyc` **no** viaja. ⛔ Sin escribir el
prefijo a mano. **Criterio de cierre: MUT-I tiene que morir con un `×` nombrado.**

**Contraargumento**: el código de hoy es **correcto**; no hay AC roto, ni vulnerabilidad, ni pérdida
de datos. Lo que falta es el candado.

### 🟡 `MNR-1` · Afirmaciones sin testigo · Un docblock dice *"su único guard"* y un mutante lo desmiente

`wallet-availability.test.tsx:1378`. MUT-D mata **dos**: `T-372-W1-7b` **y** `T-DIAG-CAPTURA`.
La frase se escribió con una medición tomada **antes** de actualizar el valor esperado de
`T-DIAG-CAPTURA`. Es la clase exacta que CD-W1-10 persigue: corregida, sigue siendo falsa.

### 🟡 `MNR-2` · Escala (check 7) · La justificación explica 37 de 662 líneas de exceso

| Archivo | Presupuesto | Entregado | Exceso |
|---|---:|---:|---:|
| `recorrido-en-el-navegador-de-la-billetera.test.tsx` | ≤420 | **768** | **+348** |
| `wallet-availability.test.tsx` | ≤120 | **229** | **+109** |
| `bitacora-de-vuelta.ts` | +8 | **+37** | +29 |
| `diagnostico-de-vuelta.test.tsx` | (no presupuestado) | **+8** | +8 |
| **TOTAL añadidas** | **~690** | **1352** | **+662** |

El décimo archivo es **obligado** (`T-DIAG-CAPTURA` se pone rojo solo, verificado con MUT-D): esa
justificación se sostiene. Lo que **no** se sostiene es la del volumen: los dos ítems nombrados suman
**37 de 662**. Los dos overruns grandes no están nombrados. Sobre la sustancia: los tests no son
relleno (7 mutantes murieron contra ellos, todos por aserción nombrada), y el total queda **bajo el
disparador de 1.800**. Exceso **defendible en contenido**, **mal declarado en la forma**.

### 🟡 `MNR-3` · Data Integrity · Dos lecturas de la misma marca de URL

`flow.tsx:146` calcula `aterrizaje.vinoConMarca` una vez; `flow.tsx:757` recalcula el mismo predicado
en cada render. El docblock de `:146` declara el principio contrario para el disco.
**Hoy no divergen** (verificado: `hrefSinRastroDeVuelta` no borra `wb`). Latente: el día que alguien
agregue `wb` a `PARAMS_DE_RESPUESTA`, las dos mitades del instrumento se contradicen y nada lo caza.
**Sugerencia**: que `:757` consuma `aterrizaje.vinoConMarca`.

### 🟡 `MNR-4` · UX · El aviso de aterrizaje no tiene gate de `step`

`flow.tsx:757`. La **oferta** vecina lleva seis condiciones, entre ellas `step === "bienvenida"`; el
**aviso** no lleva ninguna. Con `?wb=1` y disco vacío, *"Acá no están los datos que cargaste antes"*
sigue pintado en `send`, `history` y `recuperar`.
**Nota de calibración**: el story file (I-2(b)) especifica exactamente esas tres condiciones, así que
el Dev implementó a contrato.

---

## Las 12 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | Security | **OK** — los dos `<a>` con `rel="noreferrer"`; el `href` sale de `window.location` propio y se limpia |
| 2 | Error Handling | **MNR-4** — try/catch en las tres entradas, fallback documentado y probado |
| 3 | Data Integrity | **MNR-3** — la ola no escribe nada |
| 4 | Performance | **OK** — un `new URL()` por render, despreciable |
| 5 | Integration | **OK** — sin contratos de servidor tocados; repliegue = revert |
| 6 | Type Safety | **OK** — cero `any`; `tsc --noEmit` y `typecheck:scripts` verdes |
| 7 | Test Coverage | **BLQ-BAJO-1** |
| 8 | Scope Drift | **OK** — 10 archivos, el décimo obligado |
| 9 | Destructive Migrations | **N/A** |
| 10 | RPC con SECURITY DEFINER | **N/A** |
| 11 | Cache Invalidation | **N/A** |
| 12 | Afirmaciones sin testigo | **MNR-1**, **MNR-2** |

---

## Lo que el Dev declaró sin verificar: el código **no** lo afirma

- *Nadie corrió esto en un teléfono*: declarado en `recorrido-…test.tsx:31-34` y en el commit de merge.
- *Si el `localStorage` cruza*: planteado, no afirmado. Los **tres** desenlaces existen, son
  distinguibles y están medidos; `sin-marca` no se colapsa en `sin-borrador` (MUT-C lo confirma).
- *Qué hace `browse` sin Phantom instalada*: `salida-…​.ts:35-38` dice que la doc no lo dice y este
  repo no lo midió; por eso hay un segundo enlace.

---

## Fix-pack, por prioridad

1. **`BLQ-BAJO-1`** — extender `T-372-W1-1`. Criterio de cierre: **MUT-I muere con un `×` nombrado**.
2. `MNR-1` — corregir la frase de `wallet-availability.test.tsx:1378`.
3. `MNR-2` — nombrar en el cierre los dos archivos que causan el 96 % del exceso.
4. `MNR-3` — que `:757` consuma `aterrizaje.vinoConMarca`.
5. `MNR-4` — decisión del Architect/orquestador (toca el contrato de I-2(b)).

*AR · WKH-372 ola W1 · 2026-08-31 · `chaski-v3@550bf33` · 9 mutantes aplicados y restaurados,
árbol verificado por md5 contra `HEAD` en las dos puntas.*

---
---

# Re-AR · iteración 2 · `chaski-v3@e9d6892`

## VEREDICTO: **RECHAZADO** — 1 `BLQ-MED` + 1 `BLQ-BAJO` nuevos

Los **5 hallazgos de la iteración 1 cerraron** (4 cerrados, `MNR-2` cerrado-con-reserva). El
`BLQ-BAJO-1` cerró con el criterio exacto. Lo que bloquea es **nuevo**, encontrado con dos mutantes
propios del revisor.

⚠️ Materializado por el ORQUESTADOR: el agente de AR tiene prohibido escribir `.md`.

## Gate
`git add -A` → `npm run qa` **exit 0** → `npm run build` **exit 0**.
Suite: **167 archivos / 3421 tests**, verde, medida dos veces.
`vuelta-por-enlace-carrera.test.tsx` verde en las **tres** corridas. Sin regresión de flake.

## Los 5 de la iteración 1

| Hallazgo | Estado | Evidencia |
|---|---|---|
| `BLQ-BAJO-1` | **CERRADO** | MUT-I ⇒ `× T-372-W1-1` *"expected 'return' to be null"*, 1 failed / 40 passed. Un solo `×`, control `T-372-W1-2` verde ⇒ no es falso KILLED. El prefijo no se escribe a mano: el desarmado vive en `src/test-support/salida-al-navegador.ts:18-22`. **Control de falsabilidad CONFIRMADO** con MUT-K (URL sin parámetros) ⇒ `× "limpiar el rastro no es vaciar la URL: expected null to be '400'"` |
| `MNR-4` | **CERRADO** | MUT-J ⇒ `× T-372-W1-7c`. La justificación de medir `recuperar` y no `history` es **verdadera**, verificada por dos vías (`flow.tsx:1185` + `barra-destinos.test.tsx:504-518`) |
| `MNR-1` | **CERRADO** | MUT-D sobre la suite completa ⇒ exactamente **dos** `×` (`T-DIAG-CAPTURA` + `T-372-W1-7b`), que es lo que la frase nueva afirma |
| `MNR-3` | **CERRADO** | `wb` no está en `PARAMS_DE_RESPUESTA` ni en `MARCA` ⇒ la foto no diverge del recálculo. SSR seguro: el inicializador de `:146` ya devuelve la foto en falso sin `window` |
| `MNR-2` | **CERRADO-CON-RESERVA** | **El Dev tiene razón: 1098/1472 = 74,59 %**, re-deriva exacto. El 96 % de la consigna del orquestador **no se derivaba de la propia tabla del AR** (457/662 = 69 %). Reserva ⇒ `BLQ-MED-1` |

## HALLAZGOS NUEVOS

### 🟠 `BLQ-MED-1` · Afirmaciones sin testigo · Un denominador publicado que no re-deriva

`auto-blindaje.md:292` dice *«348 + 210 = 558 de 795 ⇒ 70 % después del fix-pack»*.
Re-derivado: total añadidas **1472**, presupuesto de `story-W1.md:746` **~690** ⇒ exceso **782**, no 795.
⇒ **558/782 = 71,4 %**.
**De dónde sale el 795**, y es lo que lo vuelve defecto y no errata: `662 + 133`, sumando las líneas
**añadidas** del fix-pack sobre un exceso ya calculado, sin descontar que 13 **reemplazaron** líneas
que el AR ya contaba (`salida-…test.ts` va 157→154). El correcto es `662 + 120 = 782`.
**Impacto**: un número publicado que no reproduce, dentro del hallazgo cuya lección declarada es
*"el porcentaje se deriva delante de quien lo lee"*. El **74,6 % sí re-deriva** y la refutación del
96 % queda en pie; falla el paso intermedio.

### 🔴 `BLQ-BAJO-2` · Test Coverage · El fix-pack cerró **una** de las dos propiedades de `flow.tsx:757`

**MUT-L** (mío): en `flow.tsx:757`, `hayBorrador: rem !== null` → `hayBorrador: false`.
**Resultado**: `EXIT=0` · **167 passed / 3421 passed**. Esperado: al menos un `×`.

Con `hayBorrador` clavado en `false`, el enlace de la **puerta principal** nunca lleva `?wb=1`, que es
lo único que hace posible el aviso de I-2(b). O sea: se puede **apagar en silencio el desenlace
`con-marca-sin-borrador`** —el que la ola construyó para avisarle a la persona que sus datos no
cruzaron— y la suite queda verde. `T-LINK-1` cubre el `hayBorrador` del enlace **secundario**; el de
la puerta principal no lo mira nadie. **Mismo cuadrante que `BLQ-BAJO-1`, en la otra mitad de la
misma expresión.**

⚠️ **No medido, y dicho**: no se ejecutó un escenario que llegue a `bienvenida` con `rem !== null`.
Los caminos existen y ninguno limpia `rem` (`flow.tsx:807`, `:794`), y el SDD trata el caso como vivo.

**Cierre**: guard para `hayBorrador` ⇒ **MUT-L muere con `×` nombrado**; o medición escrita de que
`rem !== null` es inalcanzable ahí, y entonces esa expresión es código muerto y se dice.

## RESERVAS

- **`MNR-A`** — `T-372-W1-7c` se llama *"no se cuela en los destinos"* (plural) y mide **uno**
  (`recuperar`). El docblock justifica por qué no `history` (verificado, cierto) pero **no dice nada
  de `send`**, que sí se pinta y queda sin medir.
- **`MNR-B`** — la tabla de escala de `auto-blindaje.md:282-287` omite `src/test-support/salida-al-navegador.ts`
  (+22, nuevo, no presupuestado). El diff toca **11** archivos contra un presupuesto de ≤10. Ninguno
  de los umbrales de escalado del check 7 se cruza.
- **`MNR-C`** — contract drift en `story-W1.md:501`. **No es del Dev**, que no puede tocar el story
  file. ✅ **RESUELTO por el orquestador el 2026-08-31**: la línea quedó enmendada a las cuatro
  condiciones, con el motivo y la autoría.

## Corrección del revisor a su propio AR de la iteración 1

*"Barrido: cero ocurrencias de `phantom.app` / `phantom.com` en los tres archivos de test de W1"*
(`adversarial-review.md`, iteración 1) es **FALSA**. El prefijo está escrito a mano en
`wallet-availability.test.tsx:289` y `:345`. **No cambia el veredicto**: los dos son pins de la URL
completa y **sí pueden fallar** (MUT-K puso rojo a `T-LINK-1`). Los otros dos archivos están limpios.

## Verificaciones de integridad del fix-pack

| Verificación | Resultado |
|---|---|
| `src/test-support/salida-al-navegador.ts` en lugar legítimo | **OK** — el directorio ya existe con 7 módulos; lo alcanza `tsc --noEmit`; **no entra al bundle**; única copia del decodificado |
| `flow.tsx` 4453 + `numstat 1 1` | **OK** |
| CD-W1-2 · `solana-wallet.ts` Δ0 contra `cc02b61` | **OK** — diff vacío |
| El `+1` de 3420→3421 es `T-372-W1-7c` | **OK** — un solo `it` nuevo, ninguno borrado; `T-372-W1-1` se **renombró** |
| Artefactos del orquestador intactos | **OK** — `_INDEX.md` 365 líneas, línea 225 es `\| 233 \|`, md5 de las primeras 144 idéntico ⇒ **CD-10 se cumple** |
| Aislamiento del fixture nuevo | **OK** — el `beforeEach` global limpia barra y disco |
| READMEs 165→167 | **OK** — con testigo: `readme-test-count.test.ts` |

*Re-AR · WKH-372 ola W1 iteración 2 · 2026-08-31 · `chaski-v3@e9d6892` · 5 mutantes aplicados
(MUT-I, MUT-K, MUT-J, MUT-D, MUT-L) y restaurados; árbol verificado contra `git show HEAD:`.*
