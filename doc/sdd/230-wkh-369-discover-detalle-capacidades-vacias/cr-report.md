# CR Report — #230 · WKH-369 · Adversary (calidad, contratos y escala)

Rama `feat/230-wkh-369-detalle-capacidades-federadas` · commit `6d1cb63` · base `18e4550`
2026-08-27. Corrió en paralelo con el AR; acá no se duplica su ángulo.

> Materializado por el orquestador desde el reporte inline del `nexus-adversary`. Contenido
> íntegro. El agente no pudo escribir archivos por restricción del harness.

## Veredicto: ❌ RECHAZADO — 1 BLOQUEANTE-ALTO + 1 BLOQUEANTE-BAJO

Orden del fix-pack: `BLQ-ALTO-1` → `BLQ-BAJO-1` → los `MNR`.

## El gate, corrido completo y en orden

| Paso | Base declarada | Medido por el CR |
|---|---|---|
| `npx tsc -p tsconfig.json --noEmit` | exit 0 | ✅ exit 0 |
| `npm run lint` | 516 archivos | ✅ **519 archivos**, sin fixes |
| `npm test` | 310/316 · 6290/6309 | 🔴 **1 failed \| 311 passed (318)** · **4 failed \| 6300 passed (6323)** · exit 1 |

---

## 🔴 BLQ-ALTO-1 — El gate está ROJO y el `auto-blindaje.md` reporta un verde que no existe

`README.md:378` y `:383`, `README.es.md:412` y `:417`, contra `test/readme-numbers.test.ts:283` y `:289`.
Evidencia falsa en `auto-blindaje.md:152-166`.

```
expected 316 to be 318   ← readme-numbers.test.ts:283  (los dos README)
expected 516 to be 519   ← readme-numbers.test.ts:289  (los dos README)
```

Los totales del Dev (312 y 6304) **coinciden exactamente** con `311 passed + 1 failed` y
`6300 passed + 4 failed`: no es otra corrida, es la misma reportada como verde.

### El mecanismo, y es la lección que viaja fuera de esta HU

El guardián enumera con `git ls-files` (`test/readme-numbers.test.ts:83`) — o sea **contra el
índice de git, no contra el disco**:

```
git ls-tree -r --name-only 18e4550 src | grep -c '\.ts$'  → 516
git ls-tree -r --name-only 6d1cb63 src | grep -c '\.ts$'  → 519
```

Mientras los 3 archivos nuevos estaban **untracked**, el guardián no los veía y el gate daba
verde. ⇒ **El Dev corrió el gate contra un árbol en el que su propio entregable no existía.**

Es una variante NUEVA de *"correr las partes de un gate no es correr el gate"*: acá se corrió
el gate **completo**, pero **sobre el árbol equivocado**. El protocolo del repo debería exigir
`git add -A` ANTES del gate final, no después.

**Impacto**: AC-8 incumplido; CI rojo al mergear; y el `auto-blindaje.md` —que F4 usa como
evidencia— afirma un verde falsificable en 14 segundos.

---

## 🔴 BLQ-BAJO-1 — La card A2A publica `skills: []` sin poder decir "no lo pude leer"

`routes/agent-card.ts:43` + `services/agent-card.ts:124` + `services/agent-detail.ts:73,76`.

El resolver marca `capabilitiesState: 'unresolved'`, y `GET /discover/:slug` lo publica (ese
route no declara response schema, `routes/discover.ts:325-327`). Pero
`GET /agents/:slug/agent-card` construye la card **campo por campo** (no hay `...agent`), así
que **el marcador se pierde** y la card publica `skills: []`.

```
GET /discover/fed-fuera-del-listado        → {"capabilities":[], "capabilitiesState":"unresolved"}  ✅
GET /agents/fed-fuera-del-listado/agent-card → {"skills":[]}   ← indistinguible de "no tiene ninguna"
```

AC-2 dice «SHALL declarar la vista como no resuelta **en vez de publicar `[]`**», y AC-5
inscribe a `agent-card` como camino de detalle. En una de las dos rutas inscriptas AC-2 no se
cumple: **es la misma ambigüedad que la HU existe para matar, un nivel más arriba.**

**BAJO y no MEDIO**: `skills: []` es legal en A2A y no hay regresión — hoy **todas** las cards
federadas salían vacías. Rompe poco, pero rompe.

**Salidas legítimas**: (a) declararlo como `TD-369-6` por escrito —hoy no está declarado en
ninguna parte, y ése es el problema real—, o (b) surfacearlo con un campo aditivo en la card.

---

## 🟡 MNR-1 — Cuatro citas del `auto-blindaje.md` apuntan al renglón vecino

| Cita | Qué hay realmente |
|---|---|
| `discovery.ts:249` (`auto-blindaje.md:77`) | `:249` es una declaración; el gate está en `:251` y la llamada en `:253` |
| `agent-detail.ts:61` (`:108`) | `:61` es un comentario; la asignación quedó en `:68` — cita de un estado transitorio |
| `discover.ts` «línea 234» (`:145`) | correcta en `18e4550`; **el propio cambio la desplazó a `:235`** |
| `discover.ts` «línea 304» (`:145`) | ídem → `:305` |

Dos las desplazó el propio cambio. Es la clase que el F2.5 ya encontró 5 veces en el SDD.

## 🟡 MNR-2 — «NUNCA produce un 5xx» afirma más de lo que el código garantiza

`agent-detail.ts:44-45` vs `:41`. El docblock pone como sujeto a la función, pero
`await discoveryService.getAgent(...)` (`:41`) está **fuera del `try`** (abre en `:49`), y
`getAgent` propaga: `discovery.ts:1402-1406` → `registry.ts:262-267`.

Reproducción: `GET /discover/<slug>?registry=wasiai` con la fila de `registries` inaccesible
⇒ 500. T-02c **no** cubre ese camino: llama sin `registryId` (`agent-detail.test.ts:308`).

No es regresión, y el Story File §5.2 escribe la versión correcta («NUNCA **por el
enriquecimiento**»). **El código perdió el calificativo**, y la frase apaga la próxima
revisión del único camino que sí puede 5xxear.

## 🟡 MNR-3 — El fixture está duplicado entre los dos test y YA divergió

`agent-detail.test.ts:154-180` vs `discover.detail-capabilities.test.ts:136-151`. Los dos
dicen ser «la forma medida en producción» y no son la misma: en el primero `fed-sin-caps`
**no trae** `price_per_call`; en el segundo **sí** (`:147`), contra un precio de lista de
`0.002` que nadie asserta.

**Dos copias de un contrato que ya no coinciden — el defecto que esta HU arregla, movido al
arnés.** Sobre unificar el fixture: el CR **coincide con el Dev** en no ejecutarlo acá (exige
un octavo archivo fuera del Scope IN). Lo que sí corresponde es que las dos copias digan lo
mismo.

## 🟡 MNR-4 — Nada avisa al tercer consumidor de `getAgent`

La lógica **sí** quedó compartida (3 importadores, sin copia entre routes) y eso es un acierto.
Pero el aviso vive en `agent-detail.ts`, que el futuro consumidor no va a abrir: va a ir a
`getAgent`, que sigue devolviendo `[]` para todo federado. CD-11 impedía tocarlo; **lo que
faltó es declararlo como deuda**.

Exposición **hoy es cero**, medida: `grep -rn '\.capabilities' compose.ts agent-price.ts` → 0.

## 🟡 MNR-5 — `capabilitiesState` no está en ningún contrato público

`doc/INTEGRATION.md` es donde el repo documenta la respuesta de `/discover` (`:390`, `:427`,
`:525`). El campo nuevo no está ahí. **No rompe a nadie** (clave aditiva, sin response schema),
pero la semántica «`capabilities: []` **sin** el marcador ES una afirmación sobre el agente» es
justo la que un integrador necesita. `doc/**` está fuera de scope ⇒ no es drift, pero la deuda
tampoco está declarada.

---

## Los 7 checks

**1 · Citas — 36 verificadas, 4 fallan**, todas en `auto-blindaje.md`; **ninguna en el código
de producción**, que no tiene ninguna. CD-12 verificado ejecutando. Ningún `E-LINE_MOVED`: las
dos citas entrantes a `types/index.ts` apuntan a `:203-225` y `:217-218`, **por debajo** del
punto de inserción. `agent-card.ts:66-68` intacto — la trampa del riesgo #1 no se disparó.

**2 · Escala — el exceso es real y está justificado.** Producción **38/70** ✅. Total `src/`
**767/550** (1.39×, bajo el umbral 2×). Tests **670/420** (1.6×). Contrastado **leyendo el
diff**: los `vi.mock` son hoisted por módulo y efectivamente no se comparten — las siete
dependencias que CD-7 obliga a doblar están en los dos archivos. *¿Qué parte seguiría
existiendo si lo escribiera alguien que ya conoce el repo?* Casi todo: el arnés es el precio de
CD-7, y CD-7 es la razón medida de que este bug sobreviviera. **Ninguna de las 5 señales de
alarma apareció** (sin caché, sin `agentPath`, sin segundo `agentMapping`, sin refactor de
`mapAgent`, sin abstracción de estrategias). CD-11 ✅ verificado ejecutando.
Nota sin severidad: los presupuestos **por archivo** sí se pasaron y el `auto-blindaje.md` sólo
reporta el agregado; el desglose debería estar en el reporte.

**3 · Contrato público** — 1 BLQ-BAJO + 1 MNR. Backwards-compat **OK**. La doctrina «omitido,
no `null`» es **consistente y con precedente citable**: `types/index.ts:445-457` la usa tres
veces en la misma interfaz (`identity`, `computedReputation`, `trial`). **No inventa convención.**

**4 · Duplicación y ubicación** — OK. Sin copia entre routes; el resolver es la única ubicación.

**5 · Tipos y errores** — OK con una nota. Cero `any` en producción y en los tests. El único
cast es necesario. `exactOptionalPropertyTypes` respetado en el punto que importa
(`agent-detail.ts:65-69`): borrar en vez de escribir `undefined` es lo que evita publicar
`reputation: null`. El `catch {}` silencioso sigue el precedente del Exemplar B. Sin aliasing.
Paginación: no se dispara hoy y si se disparara degrada a `unresolved`. **No es finding.**

**6 · Prosa** — 41 líneas de comentario sobre 32 de código, **cada afirmación falseada con un
input concreto**. Cuatro resultaron verdaderas y medibles. Una **falsa**: `MNR-2`.

**7 · Deuda y alcance** — OK. El diff tiene **exactamente** los 7 archivos declarados.
**Ninguna de las 5 TDs se arregló de contrabando**, verificado una por una. Deuda **nueva sin
declarar**: la de `BLQ-BAJO-1`, `MNR-4` y `MNR-5`.

---

## Lo que más viaja fuera de esta HU

> **El gate de este repo se mide contra el ÍNDICE de git** (`test/readme-numbers.test.ts:83`).
> Correrlo antes del `git add` es correrlo sobre un árbol donde el entregable no existe.

Es primo hermano de la regla 9 de `CLAUDE.md` y merece entrar ahí.
