# Code Review · WKH-372 · ola W3 · `chaski-v3` `f295a6f..a392f6b`

## VEREDICTO: **RECHAZADO** — 3 `BLQ-BAJO`, 7 `MNR`

Ningún hallazgo rompe un AC ni abre una vulnerabilidad. Los tres bloqueantes son **frases y citas del
money-path que no reproducen**, medidos corriendo. Los tres se arreglan con una línea cada uno.

⚠️ Materializado por el ORQUESTADOR: el agente no puede escribir `.md`.

## Gate
`git add -A` → `npm run qa` **exit 0** (biome 310 archivos / 140 warnings · tsc · tsc:scripts ·
**172 archivos / 3491 tests**) → `npm run build` **exit 0**. Sin flake.
Árbol devuelto idéntico: `cmp` contra `git show HEAD:` en los 5 archivos mutados.

## A · Los seis cierres del AR — verificados EJECUTANDO

| # | Verificación | Resultado |
|---|---|---|
| `BLQ-BAJO-2` | mutante: volver a `{ ...body, … }` | ✅ **2 rojos, cada uno por su razón**: `T-372-W3-21` y `kyc-verification-id-guard.static.test.ts` |
| ídem, claim del schema | **leído en el otro repo**: `cashout-payout.ts:47-82` declara 7 claves, **ninguna de las tres credenciales**, y el `z.object` no tiene `.strict()` | ✅ sacarlas **no rompe el pago** |
| `BLQ-MED-1` | muestra de **10 citas** re-derivadas | ✅ **10/10 resuelven**, todas ancladas ⇒ el guard ahora sí las mira |
| `BLQ-BAJO-1` | la frase de `sesion-store.ts:47-61` re-medida | ✅ el número publicado **reproduce** (172/3491) |
| `MNR-1` | mutantes (i) y (ii) por separado | ✅ los dos rojos por su razón. **El fixture reparado funciona**: el 500 con el enum de la sesión deja al status como única cosa en pie |
| `MNR-1` | ⚠️ mutante (i) en su **lectura literal** | 🟡 **SOBREVIVE** ⇒ `BLQ-BAJO-3` |
| `MNR-2` · `MNR-3` | lectura · mutante (iii) | ✅ corregido · ✅ rojo por su razón |

**Contrato**: `AC-3-4` DEFERIDO sin instrumento (`public/` = **0 archivos**, medido); `AC-3-6` con la
4ª frase **reescrita y sin gate**, en `"injected"` y en `"none"`. Δ0 en `flow.tsx` (`numstat 8 8`, 4453).
Las **12** referencias «lo mide `T-xxx`, por nombre» resuelven **12/12**.

## HALLAZGOS

### 🟠 `BLQ-BAJO-1` · La cita que el fix-pack escribió para cerrar `BLQ-MED-1` está ROTA, y el guard no la mira

`app/api/payout/prepare/route.ts:479-480` (blame `726b9c4`, el fix-pack).
Cita `` (`sinCredenciales`, `./route.test.ts:2172`) ``. **Medido**: `:2172` es **un comentario**;
`sinCredenciales` aparece en `:2179` y la aserción que la cita describe vive en `:2208`.

**Por qué el gate está verde**: el ancla quedó **partida por un salto de línea con `// ` en el medio**,
y el regex `ANCLADA` de `citas-ancladas.test.ts:74` es `` `sym`,\s*`path:NN` `` — `//` no es whitespace
⇒ la cita **no entra al conjunto del candado**. Uniendo las dos líneas sin tocar nada más, el candado
se pone rojo con el mensaje correcto.

**Impacto**: reincidencia exacta de `AR/BLQ-MED-1` **dentro del fix que la cerraba**, en el renglón que
nombra el único candado de que las credenciales no viajen al agente.
**Contexto medido (no es hallazgo)**: el patrón «ancla partida» tiene **47 ocurrencias** en el árbol;
la única que introdujo esta ola es ésta.

### 🟠 `BLQ-BAJO-2` · «El candado que ata las dos puntas es `T-372-W3-17`» — medido FALSO

`http-solana-prepare-gateway.ts:56-57`.
**Medido**: `T-372-W3-17` **no toca la route** — arma su 403 con un `Response` fabricado.
Renombrando las **12** emisiones del enum en `route.ts` ⇒ `T-372-W3-17` **pasa verde**.
Mutando sólo la rama de la sesión ⇒ **4 rojos**, y **ninguno es `T-372-W3-17`** (son `T-372-W3-2/4/5`
y `T-PANT-2`).
**Decisión correcta, motivo falso**: la atadura existe, pero la dan otros cuatro `it`.
`T-372-W3-17` cubre **la punta del cliente** (mutando su constante sí muere).

### 🟠 `BLQ-BAJO-3` · La receta de mutación publicada NO reproduce, porque la condición está escrita dos veces y una es inerte

`http-solana-prepare-gateway.ts:384-390` (código) y `:874-877` (la receta).
`sed -i '387d'` —la lectura literal de la receta— ⇒ **el mutante SOBREVIVE**. Sólo muere si además se
toca el ternario de `:384`.
**Por qué**: `enumDelRechazo` es `undefined` salvo que ya sea `!res.ok && status===403` ⇒ `:386` y
`:387` están **lógicamente implicadas** por `:388`. Dos conjuntos muertos en la ruta del dinero.
**Contradice dos afirmaciones del propio commit**: `:353-361` (*"LAS TRES CONDICIONES SON NECESARIAS Y
NINGUNA SE AFLOJA"*) y `:922-925` (*"Un control que no puede fallar es indistinguible de uno que
funciona"*), cuarenta líneas más abajo.

### 🟡 Los siete menores

- **`MNR-1`** · `InMemorySesionStore` es un calco de `InMemoryPopProofStore` y **la razón escrita cubre
  sólo el literal del TTL**. **Y ya divergió**: el arreglo del reloj ilegible se hizo en la copia y el
  original sigue abierto — probe corrido: `peek tras 100 anios` devuelve la prueba.
- **`MNR-2`** · La frase que `AR/BLQ-BAJO-1` derribó **sigue viva, textual**, en `pop-proof-store.ts:36-37`,
  que es el exemplar al que el módulo nuevo manda a leer. Medido: también da verde.
- **`MNR-3`** · `http-kyc-verdict-gateway.ts:48` protege con una nota Δ0 un número (`:60`) que ya no cita
  nadie: el fix-pack re-derivó ese emisor a `:74`, y `:60` hoy es una línea en blanco.
- **`MNR-4`** · Cita cross-repo desalineada por 3 líneas: `registry.ts:203-210` vs el `required` real en
  `:206-213`. La hermana (`cashout-payout.ts:47-82`) es exacta.
- **`MNR-5`** · **`CD-W3-10` no se cumplió**: el fix-pack no re-contrastó la escala. Es el modo de falla
  que `auto-blindaje.md:639-641` ya tiene escrito de W1.
- **`MNR-6`** · El bloque de `.env.example:400-420` (20 líneas) **nunca dice que el secreto es NUESTRO**,
  que es lo único que deshace la lectura equivocada **que ya ocurrió** con el founder. Renombrar no es
  obviamente mejor (el nombre es la palanca de rollback documentada); **un renglón alcanza**.
- **`MNR-7`** · Simplificación disponible: los conjuntos muertos de `BLQ-BAJO-3` y la clase duplicada.
  **No hay prosa borrable sin costo**: 33 `it` nuevos, 39 renglones que nombran un mutante, y los 6
  corridos murieron por su propia razón.

## Check 7 — la escala, RE-DERIVADA por el CR

| Magnitud | Presupuesto | AR (`781aafd`) | **Hoy (`a392f6b`)** | Factor |
|---|---:|---:|---:|---:|
| Líneas añadidas | **≤ 1.700** | 2.475 | **2.823** | **1,66x** |
| Archivos | **≤ 22** | 35 | **38** | **1,73x** |

| Clase | Añadidas | Comentario | Código |
|---|---:|---:|---:|
| Tests (+`fakes.ts`) | 1.918 | 563 | **1.221** |
| Producción | 705 | **416** | **261** |
| Script (probe) | 170 | 60 | 98 |

**El exceso no es relleno**: ratio test-código : producción-código = **4,7:1**, por **encima** del 4:1
que el SDD declaró como piso. 33 `it` nuevos, 39 mutantes nombrados, 6 verificados corriendo. Los 16
archivos fuera de la tabla de §9 son de 1-2 líneas de mantenimiento que `CD-W3-4` **obliga**.

🔴 **La salvedad que el AR no separó**: el SDD respondió *"~120 líneas de producción"*. Lo medido es
**261 de código de producción** (2,2x) y **416 de comentario encima** ⇒ **61 % de prosa** contra el
~50 % de la casa. **El desborde está principalmente en los docblocks de producción, no en los tests.
Y es justamente donde viven los tres bloqueantes de este CR: más prosa es más superficie de afirmación
sin testigo.**

## Fix-pack, en orden
1. `BLQ-BAJO-1` — re-derivar y dejar el ancla **en una sola línea**.
2. `BLQ-BAJO-2` — nombrar los testigos reales (`T-372-W3-2/4/5`) y decir qué punta cubre `T-372-W3-17`.
3. `BLQ-BAJO-3` — borrar los dos conjuntos muertos, o corregir la receta para que nombre los dos sitios.
4. `MNR-5`, `MNR-2`, `MNR-1` son los únicos con costo real; `MNR-3`/`MNR-4`/`MNR-6` son un renglón.

*CR · WKH-372 ola W3 · 2026-09-01 · `chaski-v3@a392f6b`*
