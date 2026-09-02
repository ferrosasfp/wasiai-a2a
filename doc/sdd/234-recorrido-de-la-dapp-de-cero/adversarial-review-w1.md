# Adversarial Review · WKH-374 · ola W1 (las cinco pantallas) · `chaski-v3` `25c3f73..e745d7a`

## VEREDICTO: **RECHAZADO** — 2 `BLQ-ALTO`, 4 `BLQ-MED`, 2 `BLQ-BAJO`, 3 `MNR`

⚠️ Materializado por el ORQUESTADOR: el agente de AR no puede escribir `.md`.
Árbol restaurado y verificado por `sha256sum` contra `git show HEAD:`; las 4 sondas temporales borradas.
Gate entero: `npm run qa` **exit 0** (**178 archivos / 3508 tests**) → `npm run build` **exit 0**.
⚠️ **Una sola corrida completa** ⇒ un verde no distingue *verde* de *tuve suerte*.

## 🔴 LA PREGUNTA EXPLÍCITA: ¿el invariante se sostiene?

> **NO. El camino que lo rompe es el que `AC-8` nombra con esas palabras.**

`AC-8` exige: *"marca ausente, marca sin consumidor, firma rechazada ⇒ aterrizar en el mismo paso con
un motivo legible, y NUNCA en la pantalla de entrada"*. Medido montando `<Recorrido/>` de verdad:

```
href=https://chaski.test/?dl=marca-que-nadie-escribio
  desenlace=sin-aterrizaje
  BODY="Paso 1 de 5 · Entrar · … Conectar mi billetera"
  entrada=true          <-- LA PANTALLA DE ENTRADA, sin motivo
```

**La función pura hace lo correcto** (contesta el tercer valor). **El único consumidor lo colapsa**:
`recorrido.tsx:95-97` es `aterrizaje.desenlace === "aterriza" ? aterrizaje.paso : pasoDeArranque`.
Es exactamente lo que el docblock de `salto.ts:35-38` promete que no pasa: *"con un booleano se perdería
la diferencia entre «vuelve al paso X» y «no sé qué es esta marca»"*. **La diferencia existe en el tipo
y se pierde en el `? :`.**

Y el predicado escrito para evitarlo —`aterrizaEnLaEntrada` (`salto.ts:162`), cuyo docblock dice *"para
que el anfitrión pueda fallar cerrado en vez de mandar a la persona al principio en silencio"*—
**tiene CERO llamadores**. El anfitrión manda a la persona al principio en silencio.
Ni `T-374-W1-0` ni `T-374-W1-3` pueden verlo: ninguno monta el anfitrión con una marca desconocida.

## HALLAZGOS

### 🔴 `BLQ-ALTO-1` · La marca sin consumidor aterriza en la entrada (AC-8 roto, verbatim)
`recorrido.tsx:95-100`. Idéntico con `?dl=` vacío y con `?dl=CONECTAR` (caja cambiada).
**El AC que la HU entera existe para cumplir se incumple en el caso que el AC nombra.**

### 🔴 `BLQ-ALTO-2` · Ningún salto se ejecuta, y la pantalla afirma que sí
`recorrido.tsx:152-154`, `:175-178`, `:188-196`. Tres mediciones con el anfitrión montado:

| Acción | `location.href` | Caso de uso | Qué queda en pantalla |
|---|---|---|---|
| «Abrir mi billetera» en Entrar | **sin cambio** | — | *"Estamos en tu billetera. Volvés acá mismo."* |
| «Verificar mi identidad» | **sin cambio** | **`startKyc` llamado 0 veces** | avanza a «Firmar y enviar» con el texto de la billetera |
| «Abrir mi billetera» en Firmar | **sin cambio** | 1 vez | *"Estamos en tu billetera"*, sin motivo, sin avance |

- `salirALaBilletera` sólo hace `setEnVuelo(true)`: **el `irA` se descarta**.
- `firmar` es `if (r.estado === "listo") {…}` **sin `else`** ⇒ **todo el camino por enlace profundo, que
  es el camino del que trata esta HU**, se descarta en silencio.
- `verificar` **da la identidad por verificada sin verificar nada**.

**El recorrido no puede completar un envío por enlace**, y el estado afirma un hecho falso ("estás en
tu billetera") con el navegador quieto. **Nada de esto está declarado** en `w1-report.md §8` ni en
`story-W1.md §13`, que enumeran diez cosas que W1 no entrega y no incluyen ésta.

### 🟠 `BLQ-MED-1` · `?dl=toString` deja la app en blanco
`salto.ts:98-99`. El cast `as Record<string, PasoDelRecorrido | undefined>` es infundado: el literal
hereda de `Object.prototype`.
```
aterrizajeDe("toString")  -> typeof=function  SIN_ATERRIZAJE=false  aterrizaEnLaEntrada=false
<Recorrido hrefDeAterrizaje="…/?dl=toString"/>  ->  BODY = "Paso 1 de 5"   (ninguna pantalla)
```
Falsifica el tipo publicado en `:42` y el control negativo de `T-374-W1-0` (que sólo prueba una marca
inventada). Un fallo-cerrado tampoco lo cazaría.

### 🟠 `BLQ-MED-2` · El barrido de disco se esquiva con una línea, y el gate queda verde
`inercia.test.tsx:192-228`. Cuatro escrituras metidas en `pantallas.tsx` ⇒ `T-374-W1-12` **PASS**, lint
sin una mención. **Lo grave**: la segunda forma es **el gesto que la 5ª fila vino a cerrar, con el salto
de línea que el formateador produce solo**. El límite declarado en `:188-191` es una frase de cobertura
que **una edición de dos líneas falsifica**, y la costura que `pantallas.tsx:8-10` promete como *"falsable
con un barrido estático"* no lo es en la medida que dice.

### 🟠 `BLQ-MED-3` · Un pedido de cotización por tecla, sin el corte del mínimo, y el error queda pegado
`recorrido.tsx:112-129`. Medido: `pedidos=[2,25]`, banner de error **y** cotización correcta a la vez.
El árbol viejo hace las dos cosas que éste no hace y lo dice en su comentario (`flow.tsx:182-196`):
**debounce de 300 ms** y **corte por `MIN_SEND_USD`**, este último con su motivo escrito (*"pedirla sería
un viaje garantizado a un error"*, WKH-314). **Y nunca limpia `motivo` en el camino feliz** ⇒ copy que
dice que algo falló cuando no falló.

### 🟠 `BLQ-MED-4` · `codigoDeError` no tiene ningún productor
`salto.ts:148-155`, `recorrido.tsx:92`. Cinco líneas en todo el árbol: la firma, su uso interno, dos de
prosa y un test. **`motivo` es `null` para TODA vuelta**, incluida una firma rechazada ⇒ la mitad de
`AC-8` que importa es **inalcanzable por construcción**. `T-374-W1-3` ejercita **una rama que ningún
llamador construye**: mata a `MW-3` y aun así el error nunca llega a la persona.

### 🟡 `BLQ-BAJO-1` · «3 firmas» y «1 firma» en la misma sesión
`recorrido.tsx:144` (`true`) y `:246` (`false`), los dos **hardcodeados**. Ninguno sale de producción, y
el de 3 **no incluye** la prueba de posesión que `ResultadoDeEnvio` declara como tercera salida.

### 🟡 `BLQ-BAJO-2` · La vuelta de `crear-nonce` es un callejón silencioso
`recorrido.tsx:183-187`. Aterriza en el paso correcto, pero `remesa` es `null` y `firmar` hace `return`
en silencio. Queda en pantalla *"A dónde va: a la cuenta que termina en ."* con el punto colgando.

### 🟡 Los tres menores
- **`MNR-1`** — la limitación declarada de `T-374-W1-0` **describe un agujero que no existe** (un renombre
  es inofensivo: las claves salen de la tupla) **y no declara el que sí**: una **permutación** re-apunta la
  tabla con las seis aserciones en verde, porque **todas son invariantes bajo permutación**.
- **`MNR-2`** — el gotcha de `bandera.ts:22-30` cita un mecanismo que no aplica: medido sobre el artefacto,
  `app/page.tsx` **no** lleva `"use client"` y el bundle de servidor **conserva la lectura viva** ⇒ *"queda
  ausente del bundle para siempre"* es **falso** para esta bandera. La conclusión (hay que rebuildear) es
  correcta **por otro motivo**: `/` se prerenderiza estático. **Riesgo del motivo falso**: el día que `/` se
  vuelva dinámico, un cambio de panel prende el recorrido entero sin rebuild, y el docblock dice que no puede.
- **`MNR-3`** — `T-374-W1-8` escribe los cinco pasos a mano en vez de derivarlos de `TABLA`.

## Lo que SÍ cerró
- **`CD-W0-7`**: confirmado el agujero **y** que el diseño lo cierra. Las cuatro aserciones de disco pasan
  sobre un almacén vacío; las **tres previas** lo impiden. **Sin hallazgo.**
- **La predicción falsa del story file**: confirmada sin necesidad de mutar — `T-067-16` itera **una lista
  escrita a mano** y no lee `MARCAS_DE_VUELTA`.
- **Las tres citas sueltas**: **es honesto**, verificado — la colisión de `id` que describen sigue siendo
  verdadera con la bandera prendida.
- **«Phantom no empeoró»**: las dos patas existen y cierran para la bandera apagada.
- **Δ0** `flow.tsx` 4453, diff vacío · `pasoInicial` 0 · bandera no prendida · **17 citas, 0 partidas** ·
  ningún `6`/`5`/`7` ni número de salidas ni promesa sobre «Crear la cuenta» o SOL · sin em dashes.
- **Ownership guard**: N/A medido, ninguna query nueva.

## Escala
634 vs 550 (**1,15x**), declarado. **El argumento del Dev se sostiene**: el exceso es firmas de props y
JSX, sin un `useEffect` de más ni una rama sin AC. El 90,9 % de `bandera.ts` es degenerado y verificado:
**la prosa es exactamente la presupuestada**; lo que se encogió es el código.
**Superficie muerta, ~15 líneas**: `aterrizaEnLaEntrada` (0 llamadores), `codigoDeError` (0 productores) y
`firmasDelCamino` (invocado con literal). **No es el exceso: son dos de los hallazgos de arriba.**

## Fix-pack, en orden
1. `BLQ-ALTO-1` — `sin-aterrizaje` no puede colapsar en la entrada; usar `aterrizaEnLaEntrada` o borrarlo.
2. `BLQ-ALTO-2` — cablear los saltos, **o** declarar por escrito que W1 no los ejecuta y **no mostrar el
   estado «en vuelo»**. `verificar` no puede avanzar sin llamar a `startKyc`.
3. `BLQ-MED-1` — `Object.hasOwn` / `Object.create(null)` + validar la salida.
4. `BLQ-MED-2` — cerrar corchetes y alias partido; reescribir el límite declarado.
5. `BLQ-MED-3` — debounce + corte por mínimo + limpiar `motivo`.
6. `BLQ-MED-4` — producir `codigoDeError`, o declarar que el motivo es de otra ola.
7. `BLQ-BAJO-1`, `BLQ-BAJO-2`, `MNR-1..3`.

*AR · WKH-374 ola W1 · 2026-09-01 · `chaski-v3@e745d7a`*
