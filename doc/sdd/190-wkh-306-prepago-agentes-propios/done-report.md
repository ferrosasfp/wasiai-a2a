# Done Report — WKH-306 Acotar y hacer visible el residuo de pagos varados

**Status**: DONE (mergeada)
**Fecha del reporte**: 2026-07-29
**Merge**: `d0cd3df`
**Tests al cierre**: 4118 · 21 mutantes, 21 muertos
**Estado de `main` al escribir este reporte**: `c92330a`, 4254 tests, tipos limpios

> **Nota de proceso, arriba de todo porque cambia cómo leer este documento.** Este
> reporte se escribió **después** del merge. La metodología pide cierre y después merge, y
> acá se hizo al revés. El contenido no se inventó: sale del mensaje de merge, de
> `.env.example` y de lo que verificó QA, y cada afirmación de este reporte se
> re-verificó contra el código ya en `main` (las anclas archivo:línea son de `c92330a`).
> Pero el documento no existía cuando la HU entró, y eso queda registrado acá en vez de
> disimularse.

---

## Qué hace

Cuando un paso de `/compose` **paga a un agente on-chain** y después el pipeline falla,
esa plata **ya salió y no vuelve**. Antes de esta HU no quedaba ningún registro: el
dinero se iba y nadie lo veía. Esta HU lo **registra** y sienta las bases para
**acotarlo**.

---

## ⚠️ Se entregó en dos mitades, con estados distintos

Esto es lo primero que hay que entender, y la razón por la que este reporte evita a
propósito la frase "techo implementado" a secas: dicha así, alguien va a creer que el
sistema está protegido, y **el día del merge no lo está**.

### Mitad 1 — Observabilidad: **ACTIVA desde el merge**

Cada run que falla después de que un agente ya cobró on-chain deja una **fila durable**,
visible en el panel de reconciliación
(`GET /dashboard/api/reconciliation` → `ambiguous.strandedRuns`). Esto funciona hoy, sin
configurar nada.

### Mitad 2 — Control: **IMPLEMENTADO, PROBADO y DIFERIDO**

`PIPELINE_EXPOSURE_CEILING_USD` y `STRANDED_EXPOSURE_ALERT_THRESHOLD_USD` se entregan
**sin setear, a propósito** (verificado en `main`: `.env.example:1038` y `:1090`, ambas
vacías).

**Consecuencia, dicha sin rodeos: el día del merge el techo no acota nada y la alerta no
suena.**

- Sin `PIPELINE_EXPOSURE_CEILING_USD`, el guard de presupuesto se comporta **exactamente
  como antes de esta HU**.
- Sin `STRANDED_EXPOSURE_ALERT_THRESHOLD_USD`, la feature está OFF: el campo
  `strandedExposureBreached` no aparece en `/health` y **no se hace ni una query**.

**Por qué se difirió, y por qué esa es la entrega correcta**: elegir el número hoy sería
fijarlo sin un solo dato de exposición real — y medir ese dato es el motivo de existir de
esta HU. Un techo demasiado bajo **rechaza tráfico legítimo y ya pagado**: un daño mayor,
y de signo opuesto, al que se busca evitar.

---

## El bloqueante, y por qué era invisible

`compose()` llamaba a `executePipeline()` **sin `try/catch`**, y
`getStepGasOverheadUsd()` está **diseñada para lanzar en producción**
(`src/lib/gas-overhead.ts:419-420`: `if (isProductionEnv()) throw new
GasOverheadUnavailableError(chainId)`).

La secuencia: **paso 0 paga on-chain → paso 1 pide el gas → lanza → el registro del
residuo nunca corría.** Plata afuera, cero evidencia. Es decir: el bug estaba
precisamente en el camino que esta HU venía a cubrir.

**Y no se podía escribir el test.** Bajo test, `isProductionEnv()` es `false`, así que
esa función **devuelve 0 y nunca lanza** (`gas-overhead.ts:413`: *"Testnet always returns
0 and never throws"*). El escenario no era un test olvidado: era **inescribible** con el
banco de pruebas tal como estaba.

**El arreglo** (`src/services/compose.ts:226-241`): la envoltura **presta** el array de
resultados al pipeline (`const results: StepResult[] = []` pasado como argumento), de
modo que conserva los steps ya completados aunque el pipeline se vaya por excepción; y
**re-lanza el error tal cual**. El comentario en el código lo deja explícito: convertir
el `throw` en un `{success:false}` cambiaría el contrato con los dos callers —y
`orchestrate.ts` decide sobre el débito del step 0 con eso—. **Observa sin tocar el
contrato.**

---

## Los números medidos

| Dato | Valor | De dónde sale |
|---|---|---|
| **Cota real de exposición por pipeline** | **1.9 USD** | Peor caso de `/orchestrate` (hasta 20 agentes ⟹ **19 pasos varables**), que es el camino insignia y el que llama a `compose()` directo |
| **Umbral sugerido de alerta** | **19 USD** | 10 × la cota observada |
| **Gatillo para configurarlos** | 2 semanas de tráfico real + `node scripts/report-stranded-exposure.mjs` | El script necesita `npm run build`; los `strandedRuns` se miran en el panel admin |

Nota de precisión sobre el conteo de pasos: los dos caminos **no** acotan al mismo
número. `/compose` corta en `MAX_COMPOSE_STEPS` (⟹ 4 varables) y `/orchestrate` acota por
`maxAgents` (⟹ 19 varables). El peor caso, y el que imprime el script, es el de
`/orchestrate`.

---

## Qué queda acotado hoy y qué no

Mientras el techo esté sin setear, la cota en la dimensión **precio** es **una medición,
no una garantía**:

| Dimensión | Estado |
|---|---|
| Cantidad de steps | **ACOTADA** (4 en `/compose`, 19 en `/orchestrate`) |
| Presupuesto del caller | **ACOTADO** en el camino con agent key (cada step `i>0` debita antes de invocar) |
| `maxBudget` declarado | **ACOTADO**, si el caller lo declara |
| Precio por agente | **Controlado por el techo** — hoy inactivo (ver abajo) |
| **Camino x402 anónimo** | **NO ACOTADO**: sin agent key no hay débito per-step que frene el pipeline a mitad de camino |

### La distinción sobre el techo (corrige una afirmación anterior del propio dev)

El techo es un **tope en dólares** evaluado contra el **acumulado** del pipeline, así que
**un agente más caro publicado mañana no lo sube: lo choca antes.**

Lo que caduca **no es el techo** sino la **sugerencia de con qué número configurarlo**. Y
esa caducidad **falla del lado benigno**: si el catálogo se encarece y nadie re-mide, el
techo queda demasiado apretado y rechaza pipelines legítimos. **Pierde disponibilidad, no
plata**, y se nota solo.

Corolario operativo, ya escrito en `.env.example`: un pico de errores
`Budget exceeded: … (gateway pipeline exposure ceiling)` significa **"re-medir el
catálogo"**, no "subir el techo a ojo". El techo rechazando trabajo es la señal de que la
medición con la que se eligió quedó vieja.

---

## Pipeline

F3 (4107 tests) → **AR BLOQUEANTE** + CR aprobado → fix-pack → re-AR cerrado con **1
reserva** → fix → **F4 QA APROBADO**. Cierre: **4118 tests, 21 mutantes, 21 muertos**.

**Intocables verificadas byte-idénticas**: el guard `i > 0` (única defensa anti
double-charge del step-0) y la posición de `const startTime = Date.now()`.

---

## Qué queda abierto (con nombre)

1. **Elegir y setear `PIPELINE_EXPOSURE_CEILING_USD`.** Bloqueado por el gatillo: 2
   semanas de `strandedRuns` con tráfico real + `scripts/report-stranded-exposure.mjs`.
   Hasta entonces **el techo no acota nada**. Fórmula acordada: 10 × la cota observada.
2. **Elegir y setear `STRANDED_EXPOSURE_ALERT_THRESHOLD_USD`** (y opcionalmente
   `STRANDED_EXPOSURE_ALERT_WINDOW_MIN`, default 60 min). Hasta entonces **la alerta no
   suena** y no se hace ninguna query.
3. **El camino x402 anónimo sigue sin acotar.** No hay débito per-step que corte el
   pipeline a mitad de camino cuando no hay agent key. Está declarado, no resuelto.
4. **Re-medir al tocar el techo.** Cada vez que se cambie el valor, correr de nuevo el
   script y dejar el número medido junto al valor elegido.

---

## Sincronización pendiente a `wasiai-ecosystem-docs`

Este reporte vive en el `doc/` versionado de este repo, pero la documentación interna se
está migrando al repositorio privado **`wasiai-ecosystem-docs`**. **Este reporte necesita
sincronizarse ahí.** No se copió desde esta HU: la sincronización es un paso aparte, para
no duplicar la fuente de verdad mientras la migración está en curso.
