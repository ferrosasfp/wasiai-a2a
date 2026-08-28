# AR — WKH-371 · Discriminador de citas sueltas

Rama `feat/232-wkh-371-discriminador-de-citas-sueltas` · HEAD `b544869` · base `19405ba`
2026-08-28 · Ángulo: **validez de la MEDICIÓN y falsabilidad de los guards.**

> Materializado por el orquestador desde el reporte inline del `nexus-adversary`. Contenido íntegro.
> Restauración verificada por hash; árbol idéntico a `b544869`. ⛔ Nunca `git checkout --`.

## Veredicto: ❌ RECHAZADO — 2 BLQ-MEDIO · 3 BLQ-BAJO · 6 MENOR

**Lo primero, porque el resto son correcciones y no una impugnación: el instrumento funciona y casi
todo el censo se re-deriva exacto.** Re-etiqueté **18 sitios a ciegas y coincidí 18/18**. Re-corrí
el sorteo: los mismos 120 sitios, cero diferencias. §6, §7.1, §7.2 y §8 reproducen **al dígito**.
**Los 6 controles nuevos se ponen rojos por su propia causa.**

Lo que bloquea es otra cosa: **el censo publica cuatro números que el código entregado NO produce,
y todos van en la misma dirección — hacia arriba.** Es el defecto que esta HU persigue, cometido
en el documento que lo persigue.

## El gate — corrido por el AR

`tsc 0` · `lint 520` · `test 314/320 · 6358/6377`. Coincide con lo declarado.

**El footgun del typecheck: CONFIRMADO, y peor de lo documentado:**
```
$ npx tsc --version          →  TypeScript compilation completed    ← NO es la versión
$ node ./node_modules/typescript/bin/tsc --version  →  Version 6.0.3
```
Bajo el hook, `tsc` imprime esa línea y sale 0 **hasta para `--version`**.

---

## Lo que se atacó y NO rompió

**1 · Las 120 etiquetas — 18/18 de acuerdo.** Sorteo con **PRNG y semilla propios**, cada sitio
abierto con `git show`, etiqueta escrita **antes** de revelar la del Dev. Coincidencia total,
incluidos los tres casos difíciles. Los `reason` describen **lo que dice la línea**, no la regla —
evidencia de que el sitio se abrió. **La métrica se sostiene sobre etiquetas correctas.**

**2 · La independencia de la muestra — real.** En el commit de las etiquetas el clasificador tiene
0 ocurrencias y ese commit toca **un solo archivo**. Los 3 archivos que mencionan la palabra
declaran la *firma* y las *reglas*, no la etiqueta de ningún sitio. Y el propio `sample.ts` declara
la limitación: *«la independencia es de la MUESTRA y del MOMENTO, no de la mente del que etiqueta»*.

**3 · El sorteo — reproducible al sitio.** Marco 1130 (130 P3 + 1000 P4), `EXACT MATCH: true`,
0 diferencias en cada dirección.

**4 · `G-C18`: el falso KILLED confirmado, y el rojo propio también.** El mutante obvio
(`line: 634 → 640`) da `× G-C5 E-LINE_MOVED` con **`G-C18` VERDE**. El correcto —mutar el párrafo
del citador sin cambiar el conteo de líneas— da `E-BARE_TARGET_MISMATCH`, su motivo propio.

**5 · Los 6 guards mueren por su motivo**, cada mutante con marcador verificado en disco antes de
correr.

**6 · Ningún guard se lee a sí mismo.** El único control que busca un literal de su mismo archivo
lo busca dentro del docblock de las líneas 1-260, y la línea que lo asserta queda **fuera** del
texto buscado.

**7 · El umbral de D5: la lectura elegida es correcta, y la decisión NO depende del umbral.**
Medidas las dos variantes: D5 aporta **+2 aciertos y +5 destinos inventados**. Con el criterio de
la propia HU («un destino inventado es peor que un INDECIDIBLE»), degradarla es correcto **por sus
consecuencias medidas**, no por cómo se lea el «20».

---

## 🔴 BLQ-MED-1 — El recall publicado es el DOBLE del medido

`censo.md:299`: *«Recall 12/19 (63 %)»*. Reproducción con la misma lógica del guardián:
```
ORACLE bare=19   CITA=6   TP=6   MISMATCH=0
```
Es **6/19 = 32 %**. El `12` es el número **con D5 encendida** (verificado: mutando D5 a `CITA` sube
a exactamente 12). **D5 se degradó en el mismo commit que introdujo este censo, así que la cifra
nació vieja.** El piso de 6 escrito dos renglones más abajo delata que el valor real se conocía.

## 🔴 BLQ-MED-2 — Dos de los tres FP publicados NO EXISTEN, y el modo que ilustran tiene 0 instancias

`censo.md:311-312`, replicado en `scanner.ts:640-645` y `test.ts:245-249`.
Reproducción: los dos dan **`INDECIDIBLE [D6]`** y **`INDECIDIBLE [RESIDUO]`**, ni `CITA` ni `D3a`.
La descripción corresponde a una definición de párrafo **más angosta** que la que el código
implementa.

**Barrido completo del perímetro** buscando el modo cross-repo con veredicto `CITA`, sobre los 1152
tokens: **0 instancias.**

⇒ De los 3 FP que AC-1 exige, sólo **1** es reproducible. Y el commit «los tres falsos positivos
medidos» editó dos archivos para arreglar FPs **que el clasificador entregado no produce** — las
ediciones son mejoras legítimas, **su justificación escrita no se sostiene**.

⛔ *Un modo hipotético publicado como medición* es lo que no puede quedar.

## 🔴 BLQ-BAJO-1 — `FN-1` no es un falso negativo: es un ACIERTO
Reproducido: `CITA [D3b] target=src/index.ts`, y el oráculo lo etiqueta igual. El renglón describe
el estado **anterior** al fix `exact-path-wins` — literalmente el sitio que el auto-blindaje dice
haber recuperado con ese fix. Los otros cuatro FN **sí** reproducen exactos.

## 🔴 BLQ-BAJO-2 — El sorteo no tiene testigo: manipular el oráculo PASA EL GATE EN VERDE

Toda la maquinaria del sorteo —lo que garantiza que *«nadie elige qué se etiqueta»*, el corazón de
AC-2— está **exportada, documentada y sin un solo llamador**.

**Falsificación ejecutada** (dos ediciones, un commit): cambiar la etiqueta de un sitio de `CITA` a
`RUIDO`, y ajustar el tuple publicado de `fn:44` a `fn:43`:
```
Test Files 1 passed (1) · Tests 20 passed (20)     ← G-C17b, G-C17c y G-C18 VERDES
```
**Un falso negativo desapareció del registro y ningún control se enteró.** La única defensa real es
el orden de commits, que es prosa auditable a mano — no un guardián.

⚠️ **La propiedad se cumple HOY** (el AR la re-corrió: `EXACT MATCH: true`). El artefacto es
honesto; **lo que falta es el candado.** Son ~15 líneas con funciones que ya existen.

## 🔴 BLQ-BAJO-3 — La clase `DATO` está mal en **25 de 25** disparos

La definición es angosta (*«el VALOR de un campo `cite:`/`quote:`, la cita de OTRO archivo
transcripta como dato»*); la regla es ancha (*carácter previo es comilla ⇒ `DATO`*).

**Censo completo de los 25**: los 25 son valores dentro de un literal JSON o de un string de shell.
**Ninguno es la cita de otro archivo.** Y el oráculo humano coincide con el AR, no con la máquina:
de los 120 sitios hay **0 `DATO`**, y los 4 donde la regla dispara están etiquetados `RUIDO`.

**Por qué la métrica no lo ve**: el scoring es binario (`pred = label === 'CITA'`), así que colapsa
las otras tres clases. Las 6 discrepancias de clase de la muestra **no aparecen en ningún número**.
⇒ Un número de población falso publicado bajo AC-8, y una de las cuatro clases del contrato que
**no acierta nunca**.

---

## MENORes

**`MNR-2` · El «17/19 → 12/19» NO SE REPRODUCE.** Reconstruido el árbol pre-arreglo revirtiendo los
**dos** defectos documentados: da **11 correctos + 2 destinos INVENTADOS** contra **12 + 0** del
árbol entregado.
⇒ **La dirección de la conclusión se sostiene** —revertir el arreglo fabrica destinos inventados,
así que **el arreglo NO empeoró el clasificador y no hay que revertirlo**— pero **el número es de
un estado intermedio que ya no existe**. La lección se conserva; la cifra se re-mide o se marca
como histórica.

**`MNR-3` · Los pisos de `G-C17` y `G-C18` están EXACTAMENTE sobre el valor medido.** Margen cero:
cualquier edición de prosa que convierta un `D3a` en `D6` en uno de los 6 citadores pone el gate
rojo sin que nada esté mal. Es el «candado que se pudre solo» **a distancia 1**.

**`MNR-4` · `G-C16` afirma más de lo que mide**: dice que los 8 están «fuera del universo» y lo que
asserta es **pertenencia a una lista**. La disjunción no la verifica nadie (hoy la ataja otro guard).

**🔴 `MNR-5` · EL GATE DEL REPO ES ESTRUCTURALMENTE CIEGO AL ENTREGABLE.** Medido, y confirmado por
el orquestador:
```
tsconfig.json  →  "include": ["src/**/*"]
npm run lint   →  biome check src/
archivos del guardián que tsc mira:  0
```
**`tsc 0 · lint 520` no toca una sola de las 3400 líneas nuevas.** El único control real es
`vitest`, que transpila sin typechequear. No es culpa de esta HU (la config es previa y AC-10 manda
esos comandos), **pero el entregable publica esos dos números como evidencia de esta HU y no lo
son**. Y el `tsconfig` desechable que el Dev usó no queda en el repo ⇒ **nadie puede repetirlo**.

`MNR-1` y `MNR-6`: dos números de prosa que generalizan de más. No cambian ninguna decisión.

## Las 11 categorías

Security **OK** (el diff de `src/` es 100 % comentario; los `execFileSync` pasan argv sin shell) ·
Error Handling **OK** · Data Integrity **BLQ-BAJO-2** · Performance **OK** (medido: 247 ms) ·
Integration **OK con nota** · Type Safety **MNR-5** (*el problema no es el código: es que `strict`
NUNCA CORRIÓ sobre él en un comando repetible*) · Test Coverage **BLOQUEANTE** ·
Scope Drift **OK** · Migraciones / RPC / Cache **N/A**, revisadas y descartadas.

## Orden del fix-pack

1. `BLQ-MED-1` — el número más leído del documento. 2. `BLQ-MED-2` — decidir entre re-publicar como
*modo previsto sin instancia* o conseguir el tercer FP. 3. `BLQ-BAJO-1`. 4. `BLQ-BAJO-2` — ~15
líneas. 5. `BLQ-BAJO-3` — angostar la regla o re-definir la clase, y publicar la matriz 4×4.
6. Los MENORes; **`MNR-5` es el de mejor relación costo/valor para las HUs que vengan.**
