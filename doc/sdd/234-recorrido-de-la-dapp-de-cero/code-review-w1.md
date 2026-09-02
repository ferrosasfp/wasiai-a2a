# Code Review · WKH-374 · ola W1 (las cinco pantallas) · `chaski-v3` `25c3f73..5afe979`

## VEREDICTO: **RECHAZADO** — 1 `BLQ-ALTO`, 5 `BLQ-MED`, 3 `BLQ-BAJO`, 5 `MNR`

⚠️ Materializado por el ORQUESTADOR: el agente no puede escribir `.md`.
Árbol restaurado y verificado por `sha256sum` contra `git show HEAD:`; sonda borrada.
Gate **dos veces**: `npm run qa` exit 0 (**178 archivos / 3513 tests**) → `npm run build` exit 0.

## A · Los cierres del AR — verificados EJECUTANDO

| Mutante | Resultado | |
|---|---|---|
| `MW-15` (volver al `? :`) | `T-374-W1-15` ROJO — *"aterriza en la PANTALLA DE ENTRADA"* | ✅ |
| `MW-18` (`firmar` sin `hay-que-salir`) | `T-374-W1-9` ROJO | ✅ |
| `MW-16` (`verificar` sin `startKyc`) | `T-374-W1-16` ROJO — *"expected +0 to be 1"* | ✅ |
| `MW-12c'` · `MW-12d` | `T-374-W1-12` ROJO | ✅ |
| `MW-17a` **declarado sobreviviente** | verificado con el valor real ⇒ **8 passed** | ✅ declaración honesta |

🔴 **`BLQ-ALTO-2`: la razón del `<a href>` es CIERTA y verificada.** `flow.tsx:286` trae el razonamiento
de `HU-075/gesto` con la foto del teléfono del founder (`t=12830 ms`) y la frase *"los navegadores
móviles la descartan sin error y sin rastro… ⛔ NO SE ARREGLA CON UN `setTimeout`"*. **Los tres saltos
son `<a href>`** y **ninguna navegación programática quedó** en el árbol nuevo.

## HALLAZGOS

### 🔴 `BLQ-ALTO-1` · El límite que el AR mandó reescribir SIGUE siendo una frase de cobertura
`inercia.test.tsx:226-230`, `:195-204` · `pantallas.tsx:3-10` · `recorrido.tsx:14-16`.
El delator exige el prefijo `window.` **y** un `=`. Quedan afuera, **y ninguna está en la lista de "lo
que queda realmente afuera"**: `location.href =` (sin `window.`), `document.location.href =`,
`window.location.assign()`, `location.assign()`, `.replace()`.
**Reproducción medida**: dos líneas en `Salir` ⇒ `npm run qa` **exit 0**, `178 passed / 3513 passed`.
**Impacto**: es el mismo hallazgo que el AR cerró, **un escalón más arriba** — el barrido pasó de ciego
a los saltos de línea a **ciego a la variante sintáctica**. `PantallaEnvio`, `PantallaSeguimiento` y el
anfitrión pueden navegar programáticamente —**el defecto que costó 12,8 s en el teléfono del founder**—
con la suite entera en verde. Y `recorrido.tsx:14-16` publica que eso *"lo mide `T-374-W1-12`"*: falso
para todas esas formas.

### 🟠 `BLQ-MED-1` · La pantalla 3 promete algo que W1 no puede cumplir, y la costura NO TIENE PRODUCTOR
`pantallas.tsx:336`: *"Una vez sola. Después de esto, tus próximos envíos no la vuelven a pedir."*
**Medido**: `identidadYaVerificada` tiene **CERO productores** fuera de tests; `app/page.tsx:37` monta
`<Recorrido />` sin props ⇒ **siempre `false`** ⇒ el paso 3 aparece **siempre**, para todo el mundo.
Es la forma que el AR cerró como *"una rama que ningún llamador construye"*, **con la agravante de que
acá la persona la lee**. ⛔ No está en la lista de «lo que W1 NO entrega».

### 🟠 `BLQ-MED-2` · El corte por el mínimo se copió SIN la mitad que le habla a la persona
`recorrido.tsx:155-158`, `:319`. El original (`flow.tsx:841`) dice: *"El mínimo para enviar es $N. Por
debajo de eso no cotizamos el envío."*, con su motivo en `:669-671` (*"para que la persona se entere
ANTES de poner el nombre, el KYC y la plata"*).
**Reproducción**: escribir `3` ⇒ sin cotización, **sin ningún mensaje**, «Seguir» gris **sin decir por
qué**, y el hueco repitiendo *"Escribí el monto"* — que es lo que la persona acaba de hacer.
**Por qué el `it` no lo ve**: `T-374-W1-17`(A) afirma `toEqual([])` — **mide el silencio del sistema,
nunca que se le diga algo a la persona**. **Es copia, no reuso, y la copia perdió información.**

### 🟠 `BLQ-MED-3` · El estado EN VUELO no tiene apagador
`recorrido.tsx:129`, `:222-229`. **Medido**: `setEnVuelo(false)` aparece **CERO veces**. Un flag, tres
pantallas.
**Reproducción en jsdom**: tocar el enlace del verificador → «Volver» → «Seguir» ⇒ *"Estamos en el
verificador. Volvés acá mismo."* **con el navegador quieto y sin haber salido**.
Es la clase exacta del `BLQ-ALTO-2` del AR: el fix-pack lo movió detrás de un toque **pero no le puso
apagador**.

### 🟠 `BLQ-MED-4` · Nada frena el segundo toque, y nada le dice a la persona que el primero hizo algo
`pantallas.tsx:93-98` (sin `disabled`) · `recorrido.tsx:201-315` (sin guarda de reentrada).
**Medido**: tres clics ⇒ **tres `confirmAndSend.execute`**.
**Y por qué toca de nuevo**: entre el toque y la aparición del `<a href>` **no cambia un solo pixel** —
comparadas carácter por carácter, las clases del `<Button>` y del `<a>` son la misma etiqueta, el mismo
color, el mismo alto y la misma posición, **con una llamada de red en el medio**. El árbol viejo tiene
`guard(async fn)` exactamente para esto.
**Impacto**: `confirmAndSend` es el depósito; `startKyc` cuesta cuota del proveedor.

### 🟠 `BLQ-MED-5` · El presupuesto publicado NO reproduce, y una columna se pasó en silencio
Clasificador **calibrado**: reproduce exacto la tabla del Dev sobre `e745d7a`. Aplicado a **`5afe979`**:

| Columna | Techo | Publicado | **Real** | |
|---|---:|---:|---:|---|
| Producción ejecutable | ≤550 | 634 | **770** | 1,40x |
| **Producción prosa** | **≤400** | 338 ✅ | **556** | 🔴 **techo roto, sin declarar** |
| Archivos | ≤14 | 15 | **16** | 🔴 sin declarar |
| `bandera.ts` prosa | ~65 % aprobado | 90,9 % | **94,3 %** | 50 de prosa para 3 de código |

§6 se titula *"Presupuesto real, por columna"* y §10 **nunca la re-derivó**. La justificación del exceso
se escribió para 634 y **hoy defiende 770**, y los +136 **no son firmas de props**. Regla 3 del §11,
literal: *"un exceso silencioso es el hallazgo"*.

### 🟡 Los tres bajos
- **`BLQ-BAJO-1`** — *"Se guarda solo mientras lo completás"* (`pantallas.tsx:244`) **es falso**: no se
  escribe nada mientras se completa. En una app de plata, una frase que sugiere autoguardado y no lo
  hace es la que hace que alguien recargue tranquilo y pierda todo.
- **`BLQ-BAJO-2`** — *"Volvé un paso y cargalo de nuevo"* apunta a **`identidad`**, un paso donde no hay
  nada que cargar. Es el copy del caso central: volver de la billetera tras `crear-nonce`.
- **`BLQ-BAJO-3`** — `siguiente` para un paso fuera del itinerario devuelve **la pantalla de entrada**,
  lo único que el invariante prohíbe con la palabra NUNCA. **Hoy inalcanzable sólo porque `BLQ-MED-1`
  deja el prop sin productor: la mina se arma sola el día que se cablee.**

### 🔵 Los cinco menores
`MNR-1` los 300 ms duplicados sin testigo (ponerlo en 0 ⇒ 8 passed) · `MNR-2` dos `useCallback`
idénticos con motivo inventado · `MNR-3` `touch-targets.test.tsx` **no barre el árbol nuevo** y no está
declarado (el Dev sí declaró los otros dos casos) · `MNR-4` «21 citas» no reproduce sin el patrón
(**0 partidas** en toda lectura) · `MNR-5` *"Estado terminal"* con un botón que vuelve al camino del dinero.

## Lo que salió bien
12 destinos anclados muestreados **apuntan a lo que dicen**, **0 partidas** · el guard de navegación
blanda **sí** cubre el árbol nuevo · **la bandera y su gotcha reescrito son CIERTOS, medidos sobre el
artefacto** · una hipótesis de hidratación del propio CR **refutada midiendo** · Δ0 de `flow.tsx` ·
ownership guard N/A, cero queries.

## 🔴 LA PREGUNTA DE PRODUCTO: si prende la bandera y usa las cinco pantallas desde Chrome

> **Llega hasta el final, pero con cuatro tropiezos, y dos le mienten.**

1. **Entrar** — conecta y avanza. **Sin estado de espera**: si Phantom tarda, el botón queda muerto y toca de nuevo.
2. **Cuánto y para quién** — lee *"Se guarda solo"*, **falso**. Si escribe `3`, **pozo sin salida**: sin cotización, sin mensaje, «Seguir» gris y el cartel repitiéndole que escriba el monto que ya escribió. Con `25` funciona bien.
3. **Tu identidad** — lee *"Una vez sola"*. **Falso: mañana se la vuelve a pedir.** Toca «Verificar», **no pasa nada visible**, y tiene que tocar **por segunda vez**.
4. **Firmar y enviar** — el desglose está bien y el anuncio de firmas es correcto para el camino con extensión.
5. **Seguimiento** — el recibo, y un «Volver» que lo devuelve al camino del dinero.

> **El tropiezo que más duele es el que no se ve en escritorio**: si en el teléfono toca el enlace y la
> billetera no abre, la pantalla se queda **para siempre** diciendo *"Estamos en tu billetera. Volvés
> acá mismo."* — y esa frase **lo persigue a las otras pantallas**.

## Fix-pack, en orden
1. `BLQ-ALTO-1` — patrón sin dependencia del prefijo ni del `=`, con cebo por forma, y el límite reescrito.
2. `BLQ-MED-1` — o se cablea, o el copy deja de prometerlo **y** se declara.
3. `BLQ-MED-2` — el mensaje del mínimo con su `role="alert"`, derivado de la constante, con un `it` que lo afirme.
4. `BLQ-MED-3` — apagador de `enVuelo`.
5. `BLQ-MED-4` — guarda de reentrada + estado visible entre el toque y el enlace.
6. `BLQ-MED-5` — re-derivar §6 entera; declarar el techo roto y los 16 archivos.
7. Los tres bajos y los cinco menores.

*CR · WKH-374 ola W1 · 2026-09-01 · `chaski-v3@5afe979`*
