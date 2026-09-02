# Adversarial Review · WKH-374 · ola W0 · `chaski-v3` `c1bd8d3..ec3fb33`

## VEREDICTO: **RECHAZADO** — 1 `BLQ-ALTO`, 2 `BLQ-MED`, 2 `BLQ-BAJO`, 5 `MNR`

⚠️ Materializado por el ORQUESTADOR: el agente de AR no puede escribir `.md`.
Árbol restaurado y verificado contra `git show HEAD:` (los 10 archivos IDÉNTICOS), worktree de mutación
eliminado. Gate entero y en orden: `npm run qa` **exit 0** (**174 archivos / 3495 tests**) → `npm run build` **exit 0**.

**El lente de esta ola no es «¿el código es seguro?» sino «¿estas mediciones pueden fallar y miden lo
que dicen?»** — W0 escribe cero producción y su único producto son números en los que se apoya un
rediseño entero.

## A · Confirmado (6 de los 8 mutantes re-aplicados por el revisor)

| Verificación | Resultado |
|---|---|
| **M-0** `protocol.ts:55` | KILLED, `× T-374-W0-0`, aserción 1 |
| **M-1** quitar el `stubEnv` | KILLED, `× T-374-W0-1`, aserción 2 — **no por el conteo**, el falso KILLED evitado |
| **M-3** `container.ts:266` | KILLED. ⚠️ El falso-KILLED que el story file anticipaba **no ocurrió** |
| **M-5** `sesion-store.ts:122` | KILLED, pata (c) |
| **M-6** en dos pasos | KILLED en la calibración (reproduce el auto-blindaje), **y la aserción 3 cae con su mensaje propio**: *"una cita SUELTA movió el conteo"*. **El hallazgo de la ola es falsable, no decorativo** |
| **M-7** `flow.tsx:963` | KILLED. **Tres** `it` rojos; **`T-UI-3` NO cayó**, contra lo que el documento anticipaba |
| Δ0 `flow.tsx` · un solo hunk en el archivo A · cero citas ancladas a destinos censados | ✅ |
| `6`/`5`/`7` heredados como métrica | ✅ **no aparecen** |
| Escala medida por el revisor | ✅ **reproduce los tres números del Dev al decimal** |
| `W0-7` 20 corridas serializadas propias | **0/20**, replica al Dev. En ningún lado se lee como *"el flake se arregló"* |

## HALLAZGOS

### 🔴 `BLQ-ALTO-1` · La ausencia de `L-5` se certificó con un instrumento ciego a `next/link`, y hay una navegación blanda VIVA en el árbol

`el-salto-remonta-el-arbol.test.tsx:45` (`PATRONES`), `:113-117` (la prosa publicada), `:124-128`.

La frase que sostiene **el §2 entero del work-item** (el vale, `DT-3`, el borrador server-side):
> *"EN ESTE REPO NO HAY ROUTER DE CLIENTE … toda salida es una navegación de DOCUMENTO"*

Lo que hay en el árbol **hoy, sin editar nada**:
```
app/kyc-simulado/page.tsx:26   import { notFound } from "next/navigation";   ← el guard lo fija y lo declara benigno
app/kyc-simulado/page.tsx:27   import Link from "next/link";                 ← el guard NO lo ve
app/kyc-simulado/page.tsx:114  <Link href="/" …>Volver a Chaski</Link>       ← navegación BLANDA de App Router
```
**El `<Link>` está una línea debajo del `import` que el `it` pinnea como "la única ocurrencia permitida".**

**Reproducción 1 (cero ediciones)**: el gate está verde con ese `<Link>` en el árbol.
**Reproducción 2 (medida, en worktree)**: un componente nuevo con `import Link from "next/link"` y un
`<Link href="/enviar">` ⇒ `el-salto-remonta-el-arbol.test.tsx` ⇒ `✓ (1 test)`. **El candado no se inmuta.**

**Impacto**: `W0-3` es bloqueante y su veredicto era *"si sale falsa, la ola vuelve a F1/F2"*. El candado
se escribió *"contra el futuro"*, y **el gesto más natural de W1 al construir el árbol nuevo —un
`<Link>` para cambiar de pantalla— es exactamente una navegación blanda que preserva el registro de
módulos y no pone rojo nada.**

**Calibración honesta del revisor**: el **veredicto** `L-5 = verdadera` **sigue en pie** (el salto por
enlace es `window.location.href`, medido), y `app/kyc-simulado` está apagada por bandera en prod.
**Lo roto es la cobertura declarada del candado, no la conclusión.** El fix es del guard, no del diseño.

### 🟠 `BLQ-MED-1` · W0-4 publica «12 marcadores» y contra el candado REAL son 13

`el-arbol-propio-cuesta-cero-citas.test.ts:131`, `:138`, `:166-169`.
**Reproducción**: una cita anclada de sonda hacia `flow.tsx` ⇒ `citas-ancladas.test.ts` reporta **13**
desajustados: los 12 `entrantes` **más** `destinos=96 → 97`.
**Causa**: el `it` filtra a `porCampo("entrantes")` y **nunca evalúa `destinosDe(conAnclada, DESTINO)`**.
**Impacto**: `12` es el **mejor caso** (citar una línea ya citada); el normal es **13**. Es el número con
el que W1 decide `DT-1`, y está publicado en el nombre del `it`, en el commit y en dos CDs.
**La mitad cualitativa SÍ se confirmó contra el candado real**: una cita **SUELTA** deja `9 passed`. No mueve nada.

### 🟠 `BLQ-MED-2` · La mitad (a) de `T-374-W0-1` da verde por VACÍO

`recorrido-en-el-navegador-de-la-billetera.test.tsx:927` (`.catch`) + `:930-934` (`.not.toEqual(["no-corresponde"])`).
**Repro A**: bajando el saldo a 0, `execute` falla antes de llegar a `pop.pedir()`, el `.catch` se traga
el error y **el `it` queda VERDE**.
**Repro B**: `pop.respuestas` es `[]`, y `[] !== ["no-corresponde"]` pasa.
**Repro C (árbol sano)**: el observable real es `['TIRÓ: deeplink_viaje_vencido']` ⇒ **`pedir()` nunca
contesta: TIRA.** El docblock, el mensaje de la aserción y el story file describen un observable que
**en el árbol sano no ocurre**, y el que sí ocurre no está nombrado en ningún lado.
**Impacto**: es la aserción que certifica que `N=2` y `M=1` salieron del camino por enlace. La aserción 4
del mismo `it` existe para cerrar ese mismo agujero sobre otra variable; ésta quedó abierta.

### 🟡 `BLQ-BAJO-1` · La ola falsificó tres números en el docblock de la función que vino a calibrar
`recorrido-en-el-navegador-de-la-billetera.test.tsx:206-207`: dice *"los 6 `it` del archivo"* (son **8**),
*"los 3 llamadores"* (son **5**), y *"hoy no llega ninguno"* al `catch` — falso **desde este commit**,
porque `T-374-W0-0` le pasa `"no-soy-una-url"` a propósito.

### 🟡 `BLQ-BAJO-2` · No existe el reporte de W0
`D10`, `D17`, `D18`, `T42` y `T43` no se pueden verificar. Quedan **sin domicilio durable**: C-1..C-5
(en particular **C-4**, verificada: el `toBe(apagada)` **no existe**), OBS-1 (*"en ocho archivos"* son 6),
OBS-5, el contraste de presupuesto por columna (**590/≤520 = 113 %**, A al 122 %, prosa del bloque A
44,3 % contra la referencia operativa 42,8 %), y la declaración de `W0-6` con dueño/instrumento/fecha.
⚠️ El commit **afirma** que esa declaración existe: es una afirmación sobre un artefacto que no existe,
**el modo de falla que este proyecto ya registró cinco veces**.

### 🟡 Menores
- **`MNR-1`** — la razón escrita de la exclusión `SELF` del archivo B es **falsa, medido**: quitándola el
  `it` sigue verde. La decisión está bien, el motivo no. ⚠️ En el otro archivo la exclusión **sí** es
  load-bearing y ahí la prosa es correcta.
- **`MNR-2`** — en el tramo de ida, `N` y `M` **no son dos números: son uno**. Las aserciones 5 y 6 miden
  lo mismo; el `it` publica dos cifras que no pueden divergir.
- **`MNR-3`** — *"el filtro se ejercitaba en TRES sitios"* no re-deriva hoy: son 5. Y va anclada a
  *"al escribir esto"* sin commit, contra `CD-W0-8`.
- **`MNR-4`** — el flake heredado de **7-13 % es hoy un número sin testigo**: acumulado 0/40, que bajo
  p=0,10 ocurre el **1,5 %** de las veces. No es defecto del Dev; el número heredado merece su medición.
- **`MNR-5`** — la fila 234 del `_INDEX.md` sigue diciendo *"6 mediciones"* (son 8) y publica **"2 salidas"**,
  que `CD-W0-14` declara no publicable. Queda para el cierre.

## 🔴 CONCLUSIÓN: ¿los números son confiables para construir encima?

**Todavía no del todo, y la parte no confiable está nombrada.**

| Medición | Veredicto |
|---|---|
| **W0-0** | ✅ **SÍ.** Calibrado de verdad. **Y Solflare queda afuera, verificado**: entra como distractor y se descarta por valor ⇒ **todo número de W0-1/W0-2 vale para Phantom y sólo para Phantom** |
| **W0-1 / W0-2** | ✅ el número, ⚠️ con reserva el control. **El 🟡 NO encubre una omisión**: el tramo (II) exige fabricar la respuesta cifrada por cada salto y no entra en el presupuesto. Falta cerrar `BLQ-MED-2`. ⚠️ **«2 travesías» NO es comparable con el «7» heredado**, y fuera de un docblock nadie declara que el 7 sigue NO VERIFICABLE |
| **W0-3** | ⚠️ la **conclusión** sí (barrido completo propio, incluidos `scripts/` y `contracts/`); **el candado NO**: no protege a W1 del error que existe para prevenir |
| **W0-4** | ⚠️ el **hallazgo** sí, confirmado contra el candado real; **el número NO**: son 13 |
| **W0-5 · W0-7** | ✅ reproducidos |
| **W0-6** | correctamente no medida, pero la declaración no existe fuera del story file |

**Operativo**: `W0-0`, `W0-5` y `W0-7` se usan tal cual. `W0-1`/`W0-2` con el alcance escrito, una vez
cerrado `BLQ-MED-2`. **`W0-3` y `W0-4` no se pueden usar como están.** Ninguno invalida el **diseño**;
los dos invalidan **la evidencia con la que se lo defiende**, que es lo que esta ola existía para producir.

## Fix-pack, en orden
1. `BLQ-ALTO-1` — `next/link` en el barrido + control negativo + declarar el `<Link>` de `app/kyc-simulado/page.tsx:114`
2. `BLQ-MED-1` — el número es **13**; corregir el `it`, el `.toBe(12)` y agregar la aserción sobre `destinos`
3. `BLQ-MED-2` — cerrar el vacío de `pop.respuestas` y escribir el valor real
4. `BLQ-BAJO-1` — actualizar el docblock (8 `it`, 5 llamadores, el `catch` hoy sí recibe)
5. `BLQ-BAJO-2` — materializar `w0-report.md`

*AR · WKH-374 ola W0 · 2026-09-01 · `chaski-v3@ec3fb33` · 6 mutantes re-aplicados en worktree*
