# CR — WKH-371 · Discriminador de citas sueltas

Rama `feat/232-wkh-371-discriminador-de-citas-sueltas` · HEAD `b544869` · base `19405ba`
2026-08-28 · Ángulo: **calidad, citas, escala y contratos.** El AR corre en paralelo sobre la
validez de la medición.

> Materializado por el orquestador desde el reporte inline del `nexus-adversary`. Contenido íntegro.

## Veredicto: ❌ RECHAZADO — 1 BLQ-ALTO · 1 BLQ-MED · 4 BLQ-BAJO · 6 MENOR

**Citas verificadas abriendo la línea: 59. Fallaron: 11.**

## 🎯 El patrón que ordena todo, y vale más que la lista

> **Todo número del censo que tiene un testigo mecánico real es EXACTO.
> Todo número que NO lo tiene está mal.**

Re-derivados y **exactos**: §1 (611/2095/1347) · §2 (195/1152) · §6 (38/953/25/136 + las 8 reglas) ·
§7.1 (marco 1130 = P3 130 + P4 1000, y los 120 sorteados coinciden **exactamente** con
`RESERVED_SAMPLE`) · §7.2 (13/1/44 · 1/0/1) · §8 (36 = 19/13/4).
**Fallan**: §7.3 · §7.4 (2 de 3) · §7.5 (1 de 5) · §9 (la columna «testigo») · §10.2 · §11 · §12 · §3.

## El gate — corrido por el CR, completo y en orden

`tsc` **exit 0** · `lint` **520** · `test` **314/320 · 6358/6377** exit 0. Coincide con lo declarado.
⚠️ **`npx tsc` bajo el hook imprime «TypeScript compilation completed» y TAPA el exit code** — se
corrió el binario directo para leer el código real.
✅ Verificado el claim de los README: el archivo de muestra **no** matchea el `include` de vitest.

---

## 🔴 BLQ-ALTO-1 — El recall publicado es 12/19; el medido es **6/19**

`censo.md:299`, `:392`, `:428`, `:434`, propagado en `:213` y `auto-blindaje.md:37`.

`censo.md:299`: *«Recall 12/19 (63 %), y 0 destinos mal resueltos.»*

**Reproducción** con el bucle literal del guardián (`git ls-files -z`, mismos `TRACKED_SET`/
`BY_BASENAME`, mismo `readTracked`):
```
bare P3/P4 en CITED_LINES: 19   conTestigo: 6   aciertos: 6   malResueltos: []
```
Idéntico contra HEAD y contra `19405ba`.

**La causa está medida, y es la trampa que esta HU persigue**: de las 19, **6 caen en D5**. Con D5
emitiendo `CITA` el número es 6+6 = 12. ⇒ **El «12» es la medición PREVIA a la degradación de D5, y
nunca se re-derivó.** La nota que explica la diferencia atribuye a la degradación una pérdida de 4
cuando la real es de 6 — y publica el número de antes de esa misma degradación.

**Tres impactos, y el tercero preocupa:**
1. AC-1 publica un recall **2× inflado** contra el oráculo (63 % vs 32 %).
2. `censo.md:428` afirma que `G-C18` «nace verde por MEDICIÓN» con 12 testigos; son 6.
3. 🔴 **Los pisos de `G-C17` y `G-C18` (`>= 6`) están CLAVADOS EN LA MEDICIÓN, sin margen.** El texto
   de ambos («PISO, no igualdad… un test que exija exactamente 12 se pone rojo el día que alguien
   escriba una cita nueva») describe un margen **que no existe**: una sola cita que deje de resolver
   pone el gate en rojo, y el mensaje mandará al lector a un «piso publicado» de 12.
   **Un candado que se pudre solo, con la etiqueta de que no se pudre.**

⛔ **El fix NO es ajustar el piso para que el 12 dé.** Re-derivar, re-publicar los cinco sitios, y
decidir el piso desde el número real.

---

## 🔴 BLQ-MED-1 — §7.4 publica 3 falsos positivos; **hay 1**. Y un «falso negativo» es un ACIERTO

`censo.md:311`, `:312`, `:314-316`, `:324`; propagado en `scanner.ts:635-639` y `test.ts:245-249`.

AC-1 exige **≥3 FP** y ≥3 FN citados. **El propio testigo mecánico de la HU dice que hay 1**:
`test.ts:2064` asserta `{P3:{tp:13, fp:1, fn:44}, P4:{tp:1, fp:0, fn:1}}` y la suite pasa.

Re-derivados los dos FP declarados: **`INDECIDIBLE D6`** y **`INDECIDIBLE RESIDUO`** — y la muestra
los etiqueta `INDECIDIBLE` **a mano**. ⇒ **predicción = etiqueta ⇒ son ACIERTOS.** Ni siquiera
comparten regla, contra lo que el censo afirma.

Y **FN-1** re-derivado da `CITA D3b target=src/index.ts` ⇒ **true positive**. Es justamente la cita
que el fix «el path exacto gana» recuperó, y la tabla no se re-derivó después del fix.

**Contaminación aguas abajo**: la afirmación no reproducible está copiada en **dos docblocks del
código entregado** y es la **justificación escrita** de dos de los cinco cambios de `src/`. Los
cambios son correctos por otras razones; **su motivo escrito no lo es**.

⛔ Un FP inventado para llegar a 3 es la misma clase de defecto que un destino inventado.

---

## 🔴 BLQ-BAJO-1 — La tabla «El efecto» no reproduce
`censo.md:512-518`. «3 sueltos antes» son **4**; «13, todos `INDECIDIBLE`» son **9 + 4 `RUIDO`**.

## 🔴 BLQ-BAJO-2 — El docblock declara un orden de cascada que el código no tiene
`scanner.ts:577-578`, `:585-587`. Dice en negrita *«D6/D7 VAN ANTES QUE D3»*; el código pone **D7
después de D3**. Repro con un párrafo mixto: esperado `INDECIDIBLE D7`, obtenido **`CITA D3b`**.
El comportamiento real es **el correcto y está candado**; el que está mal es el docblock — que es
lo que un lector consulta.

## 🔴 BLQ-BAJO-3 — El ítem que denuncia el envejecimiento, envejecido por esta HU
`test.ts:166-177`: «LOS **4** ARCHIVOS DE ESTE GUARDIÁN … **261 tokens**».
Re-derivado: **5 archivos** (el 5.º lo agregó esta HU) y **752 tokens** — 2,9×.

## 🔴 BLQ-BAJO-4 — La columna «testigo mecánico» nombra guards que no derivan esos números
`censo.md:384-399`. El documento abre con *«ningún número se lee de acá: cada uno se deriva»*, y en
**3 de 7 filas** el testigo declarado no calcula ese número.
🎯 Peor: **`sampleFrame` y `drawReservedSample` NO SE LLAMAN DESDE NINGÚN LADO** — verificado por el
orquestador: 0 usos y 1 mención en un docblock. **El mecanismo anti-cherry-pick de AC-2 es código
muerto exportado.**
El CR los llamó a mano y **la propiedad es CIERTA** (marco 1130, y los 120 sorteados coinciden
exactamente). ⇒ **La propiedad es verdadera y NO ESTÁ GUARDADA.** Una línea la convierte en candado.

## 🔴 BLQ-BAJO-5 — §12 se mide a sí misma excluyéndose, y con dos instrumentos distintos
`censo.md:541-552`. El total 3249 es el `numstat` **del commit anterior** —sin la propia §12 ni
`auto-blindaje.md` (+141)—, y las filas salen de `grep '^+[^+]'`, **que no ve las líneas en blanco**.
Por eso **la tabla no suma su propio total**. Real: **3424/7 = 1,646×**.
El veredicto de la regla 10 **no cambia**: sigue bajo el 2×.

---

## Lo que el CR verificó y está BIEN

**La prosa NO vende el 23 % como cobertura, y es lo mejor del entregable.** Verificado frase por
frase: el censo acota qué afirma cada estrato, escribe el silencio con su tamaño (*«hasta ~89 citas
que el clasificador no ve… ése es el silencio, y es grande»*), marca el agregado como «estimación
sobre estimaciones», y sobre el estrato de un solo positivo dice *«no dice nada»*.
**Cero «todas las citas», cero «siempre», cero «ya no se pueden pudrir».**

**Tipos y errores — OK.** Cero `any`/`as any`/`@ts-ignore`, cero `catch` que coma errores.
`INDECIDIBLE` se distingue de «no lo miré» por tipo. **Ninguna rama inalcanzable: las 8 reglas
tienen población** (D1 953 · D2 25 · D3a 32 · D3b 6 · D5 36 · D6 61 · D7 15 · RESIDUO 24).
**Determinismo**: 15 corridas, salida byte-idéntica.

**Los 5 cambios de `src/` — OK.** 100 % comentario, verificado en el diff. **Ninguna cita entrante
desplazada**: los tres archivos tienen el mismo número de líneas antes y después, y la cita de
money-path que `CITED_INDEX_LINES` protege **no se movió**.
🎯 **El hallazgo más valioso del Corte B**: la corrección `fee-split.ts:335 → :336` es correcta —
dos archivos del repo se contradecían sobre la misma línea, y quedó resuelto hacia el lado correcto.

**Los datos etiquetados NO son un volcado del clasificador**, y el CR lo probó: los 36 veredictos
del censo reproducen exacto **y dos de ellos contradicen al clasificador de hoy**, cosa imposible
si fueran un volcado.

**El contrato del guardián — OK.** `'Naming: G-C1..G-C12'` **sí** se actualizó a `..G-C18`. El
perímetro está declarado con su número en dos sitios. La exclusión de los 8 va con su motivo.
**Alcance y deuda — OK**: ninguna TD cerrada de contrabando; las dos declaraciones para decisión
humana están escritas donde alguien las ve.

## MENORes

`MNR-1` el input rojo declarado de `G-C15` nombra una sustitución que **no existe como sitio** ·
`MNR-2` código muerto sin motivo (`void c`) · `MNR-3` dice «NINGÚN sitio de D5» y mide `slice(0,6)`
de 36 · `MNR-4` «está medido: ~38 % de P3» cuando la HU midió **95 %** · `MNR-5` «5 de 1085» y su
propio grep devuelve **6** (falta el censo, que ahora contiene esas palabras) · `MNR-6` una edición
de prosa borró una cláusula y la tabla de procedencia no lo dice.

---

## El hallazgo del CR

> **Todos los BLOQUEANTES son de prosa y de números publicados. Ninguno es de runtime.**
> El clasificador, el marco, el sorteo, el censo de D5, las 120 etiquetas y los 8 controles nuevos
> **están bien, y se verificaron re-derivándolos**. Lo que falla es **el documento que los
> describe** — y en una HU cuyo entregable ES la honestidad de la medición, eso es lo que bloquea.

⛔ **Lo que NO hay que hacer en el fix-pack**: cambiar los pisos para que el 12 dé, ni retocar la
muestra. **Los números se re-derivan y se re-publican; el árbol no se ajusta al documento.**
