# Code Review · WKH-374 · ola W0 · `chaski-v3` `c1bd8d3..c823aeb`

## VEREDICTO: **RECHAZADO** — 2 `BLQ-MED`, 6 `MNR`

⚠️ Materializado por el ORQUESTADOR: el agente no puede escribir `.md`.
Gate entero y en orden: `npm run qa` **exit 0** (**174 archivos / 3495 tests**) → `npm run build` **exit 0**.
Árbol restaurado y verificado contra `git show HEAD:` (6 archivos idénticos), worktree eliminado.

## A · Los cierres del AR — verificados EJECUTANDO

| # | Mutante | Resultado |
|---|---|---|
| `BLQ-ALTO-1` | **M-8** (componente nuevo con `import Link from "next/link"` + `<Link>`) | ✅ KILLED **por la aserción de `next/link`** |
| ídem | **M-8b** (`<Link>` de un módulo propio) · **M-8c** (`if (false) notFound()`) | ✅ cada uno **por su propia aserción** |
| `BLQ-MED-1` | sonda anclada a línea **NO citada** | ✅ **13** desajustados **contra el candado REAL**: 12 `entrantes` + 1 `destinos`, en **6 archivos** |
| ídem | sonda a línea **ya citada** | ✅ cae **sólo** la aserción de `destinos` ⇒ la aserción nueva no es decorativa |
| `BLQ-MED-2` | **M-10** (saldo → 0) | ✅ KILLED con el mensaje exigido: *"no dejó ni una anotación… daría verde por VACÍO"* |
| `BLQ-BAJO-1` | re-derivación | ✅ **8** `it`, **5** llamadores, y `catch`→`throw` da `1 failed \| 7 passed (8)`. Los tres reproducen |
| `BLQ-BAJO-2` | lectura | ✅ `w0-report.md` existe y completo |

Δ0 re-derivado: `flow.tsx` **4453**, `solana-wallet.ts` **2498**. `CD-W0-1` ✅ · `CD-W0-3` ✅.
**14 citas muestreadas dan exacto**, incluidas las sueltas que ningún guard vigila. Los dos regex
re-implementados son **byte-idénticos** a los del candado real.

## HALLAZGOS

### 🟠 `BLQ-MED-1` · El predicado que cerró el `BLQ-ALTO-1` no exige lo que su prosa dice

`el-salto-remonta-el-arbol.test.tsx:164-171` (docblock) y `:172-182` (predicado). Réplica en `auto-blindaje.md:106-107`.

Publica, tres veces: *"exige los dos símbolos EN LA MISMA LÍNEA **Y QUE NO SEA UN COMENTARIO**"* y
*"si alguien le saca el corte… **esto cae**"*.
El predicado real usa `!l.trimStart().startsWith("//")`. **Eso no es "no es un comentario": es "no es
un comentario de LÍNEA".**

**Repro E2 (el corte borrado, guard VERDE)**: reemplazar `if (!mockDiditSurfaceEnabled()) notFound();`
por un `/** … */` que lo mencione ⇒ `✓ (1 test)`. **Es la misma clase de agujero que el fix-pack dice
haber cerrado**: el guard se apoya en la prosa del archivo que vigila, y el repo escribe `/** … */` en
todos lados.
**Repro E1 (la inversión, guard VERDE)**: `if (mockDiditSurfaceEnabled()) notFound();` ⇒ `✓`. Ahora la
página renderiza —con el `<Link>` blando vivo— **exactamente cuando la bandera está apagada, o sea en
producción**. El predicado verifica **presencia de dos literales, no sentido**.

**Calibración honesta**: la propiedad **no se pierde** — con E2 la suite entera da `2 failed`, y los
rojos son `T-GATE-3'` y `G-1`, que miden el corte **por comportamiento**. Lo falso es **la cobertura que
este guard publica sobre sí mismo**, y W1 la va a leer como cierta.
**Colateral (`CD-W0-6`)**: es la **única** de las tres aserciones nuevas **sin mutante declarado**, y es
la que se escapa.

### 🟠 `BLQ-MED-2` · «42,8 % es el máximo del repo» es FALSO, y es la justificación publicada del exceso

`w0-report.md:158` (C-5), `:189`, `:219-220`. Heredado de `story-W0.md:62`, `:974-978`.

Los **cuatro números individuales reproducen al decimal**. **Lo que no reproduce es el cuantificador.**
Barriendo `src|app|scripts|contracts` con el mismo contador hay **al menos 10 archivos por encima**:

| Archivo | ratio |
|---|---:|
| `src/composition/prepared-claims-guard.static.test.ts` | **65,0 %** |
| `src/composition/principal-tx-single-writer.static.test.ts` | **64,6 %** |
| `src/presentation/titulos.test.tsx` | **59,2 %** |
| `app/viewport.test.ts` · `app/kyc-simulado/kyc-simulado-gate.test.ts` | 57,8 % · 57,5 % |
| `src/presentation/recuperar-composicion.test.tsx` · `bienvenida-composicion.test.tsx` | 57,4 % · 56,3 % |
| `agent-slug-residue.static.test.ts` · `reconcile-cron-guard.static.test.ts` · `app/manifest.test.ts` | 54,4 % · 54,1 % · 53,6 % |

Restringido a `src/presentation/*.test.*` el máximo sigue siendo **59,2 %**.

**Impacto, tres cosas load-bearing**:
1. **El argumento de §9.2 se cae**: *"un techo del 55 % está 12 puntos por encima del test más prosaico
   que existe"*. **Ya está excedido por dos archivos de la casa.** Razón falsa debajo de decisión correcta.
2. **El «número operativo 42,8 %» que W1 hereda como vara es incorrecto**, y sale de **cuatro archivos
   elegidos a mano**, no de un barrido.
3. `:219` publica una superlativa que la ola escribió **contra sí misma**, en el documento de cierre de
   la ola **cuyo producto es que los números re-deriven**.

### 🟡 Los seis menores
- **`MNR-1`** — `leerElArbol`, `type Fuente`, `SKIP` y `EXTS` están **duplicados byte a byte** entre los dos
  archivos nuevos, **sin una línea que lo explique**, y **ya divergen** (uno barre 4 raíces, el otro 2).
  ⚠️ `no-evm-surface.test.ts:35-49` **es exactamente este guard**, con sus tres trampas documentadas, y el
  archivo nuevo no lo cita ni una vez.
- **`MNR-2`** — `PATRONES` son substrings crudos ⇒ **el guard matchea PROSA**. Medido: una nota que dice
  *"acá NUNCA se usa useRouter"* pone la suite roja. `no-evm-surface.test.ts:19-22` ya resolvió esto con
  patrones import-shaped, y lo documenta.
- **`MNR-3`** — el nombre del archivo nombra la **medición abandonada** (su propio docblock dice que era
  tautológica y se cambió). El nombre es lo que se grepea dentro de seis meses.
- **`MNR-4`** — «47 ocurrencias preexistentes» es un número **sin patrón publicado**: con dos lecturas
  igual de plausibles da **46** o **47**. No está mal; le falta el patrón para re-derivarlo.
- **`MNR-5`** — dos mensajes que afirman de más, medidos.
- **`MNR-6`** — el nombre del `it` promete un observable que el `it` no observa (la pata (b) asserta
  **ausencia**, y el docblock lo dice bien).

## C · La escala — juzgada por sustancia

| Columna | Techo | Medido | % |
|---|---:|---:|---:|
| Producción | 0 ⛔ | **0 / 0** | ✅ |
| Test total | ≤520 | **700** | **134,6 %** |
| Prosa del bloque | 42,8 % oper. | **44,3 %** | +1,5 pts |

**No cruza el umbral duro de 2x, y el exceso NO es silencioso**: está declarado columna por columna.
700 líneas ⇒ **4 `it`, 33 `expect(`, 8 mutantes nombrados**, y los **6 que el CR corrió mataron cada uno
por su propia aserción y su propio mensaje**. 11 líneas por aserción es denso, no inflado.
**Sobreprecio real**: 13 líneas de prosa para decir que una exclusión **no** es load-bearing; alguien que
conoce el repo lo escribe en tres. Sobre 700 no mueve la aguja.
⛔ **El CR rechaza explícitamente recortar los docblocks de mutantes y controles negativos**: el
`BLQ-ALTO-1` del AR y los dos escapes medidos acá son la prueba de que ahí se gana o se pierde la ola.

**Veredicto**: el 134,6 % **paga su costo**. El 44,3 % **no es el hallazgo**; el hallazgo es que **la vara
contra la que se lo compara está mal medida** (`BLQ-MED-2`).

## 🔴 ¿Los números son confiables para construir encima? — medición propia del CR

| Medición | Veredicto |
|---|---|
| **W0-0** | ✅ los tres números re-derivan exactos |
| **W0-1 / W0-2** | ✅ con el alcance escrito. M-10 cierra el verde por vacío |
| **W0-3** | ⚠️ la **conclusión** sí; **la frase de cobertura sobre la excepción, no**: dos escapes de una línea |
| **W0-4** | ✅ **con testigo independiente**, contra el candado real: 13 en 6 archivos |
| **W0-5 · W0-6** | ✅ |
| 🔴 **El número de ESCALA** | ❌ **NO.** El único que la medición del CR contradice, **y el que W1 iba a heredar como vara** |

**La ironía que vale registrar**: la ola cuyo producto son afirmaciones con testigo cerró su
`BLQ-ALTO-1` con un guard que afirma una cobertura que no tiene, y justificó su exceso con una
superlativa que un barrido de treinta segundos refuta. **Ninguno rompe código. Los dos rompen
exactamente lo que esta ola vino a producir.**

## Fix-pack, en orden
1. `BLQ-MED-1` — o el predicado descarta comentarios de bloque y strings, o **la frase deja de prometer**
   y cita a `T-GATE-3'`, que mide el corte por comportamiento. **Declarar el mutante de esa aserción.**
2. `BLQ-MED-2` — derivar el máximo con un **barrido**, publicarlo con archivo y ratio, y re-escribir C-5,
   la fila del presupuesto y §7.1.
3. `MNR-1..6` — `MNR-2` y `MNR-3` son los que más le van a costar a W1.

*CR · WKH-374 ola W0 · 2026-09-01 · `chaski-v3@c823aeb`*
