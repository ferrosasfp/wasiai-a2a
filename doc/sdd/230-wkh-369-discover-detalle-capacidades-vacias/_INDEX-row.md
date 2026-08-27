# Fila para `doc/sdd/_INDEX.md` — WKH-369

## ⚠️ ESTA FILA NO ESTÁ INSERTADA TODAVÍA

El F1 corrió **sin `Edit` y sin shell** (sólo `Read`/`Write`/`Glob`). Insertarla habría
exigido reescribir `_INDEX.md` entero con `Write` (~102k tokens, 362 líneas), y una
reescritura completa de un archivo que no se pudo leer entero **destruye contenido**. Se
declara pendiente en vez de arriesgarlo — mismo patrón que los `_INDEX-row.md` de las filas
`212`, `217`, `220` y `221`.

## Dónde va — y esto es load-bearing, no cosmético

⛔ **Insertar en la LÍNEA 222**, o sea inmediatamente **después** de la fila `229`
(`| 229 | 2026-08-26 | [WKH-366] …`), que hoy es la línea 221 y es la última de la tabla.
La línea 222 está en blanco y la 223 es `---`.

**Por qué al final y no en orden numérico:** `src/lib/capability-risk.ts` y
`src/lib/capability-risk.test.ts` citan **`_INDEX.md:144`**, y esa cita la verifica el
guardián `test/sdd-index-matches-folders.test.ts` vía `CITED_INDEX_LINES`
(`test/sdd-index-matches-folders.exceptions.ts:181-192`). Es código del camino del dinero:
**mover cualquier línea de la tabla por encima de la 144 la rompe en silencio.** Insertar
en 222 deja la 144 intacta. Es la misma razón por la que las 27 filas anteriores se
agregaron al final.

**Efecto colateral que sí ocurre y hay que saber:** las secciones de prosa de abajo de la
tabla bajan **1 línea**. Ninguna de las dos entradas de `CITED_INDEX_LINES` apunta a la
prosa (las dos son la 144), así que el guardián no debería ponerse rojo — pero
**verificarlo corriendo `npm test`, no leyéndolo.**

## Después de insertar

Correr el gate completo y en orden (⛔ `npm run qa` NO existe en este repo):

```bash
npx tsc -p tsconfig.json --noEmit
npm run lint
npm test        # incluye test/sdd-index-matches-folders.test.ts
```

---

## La fila (copiar tal cual, en una sola línea)

| 230 | 2026-08-27 | [WKH-369] `/discover/<slug>` devuelve capacidades VACÍAS para todo agente federado, mientras `/discover` sí las publica (issue #182). **El issue cuenta mal el hallazgo y la corrección es el punto de la HU**: dice "5 de 12 muestreados difieren"; el barrido completo de los 29 agentes da 10 que difieren, pero esos 10 son **10 de 10 federados que tienen algo que perder** — de los 24 federados, 14 "coinciden" porque su lista TAMBIÉN está vacía ⇒ la afirmación correcta es que **el detalle devuelve `[]` para 24 de 24 federados (100 %)**, y el "10 de 29" (34 %) es la tasa de agentes con datos cargados, no la del defecto. Una tasa calculada sobre filas que NO PUEDEN exhibir el defecto lo subestima ⇒ AC-3 exige partir la medición en `difiere` / `coincide-con-contenido` / `coincide-en-vacío`, y **CD-1 prohíbe el fixture con capacidades vacías porque pasa con el bug puesto** (el mismo error de muestreo, movido al test, donde se ve verde). **La sospecha del issue sobre `mapAgent` es FALSA y verificarlo ahorra el desvío**: los dos caminos llaman a la MISMA función sin ramificar (`discovery.ts:1273` lista, `:1436` detalle). Diverge lo que se le DA DE COMER, por dos asimetrías estructurales: (a) la lista desenvuelve el sobre con `schema.agentsPath` (`:1257-1259`) y **no existe ningún `agentPath` equivalente para el detalle**, que asume el agente en la raíz; (b) el registro `wasiai` se sembró con UN solo `agentMapping` declarado para `discovery_endpoint` (`/api/v1/capabilities`) y se aplica también a `agent_endpoint` (`/api/v1/agents/{slug}`), que es otro endpoint de otra API (`supabase/migrations/20260401000000_kite_registries.sql:41,43,51-59`). 🎯 **Derivación que explica por qué falla exactamente `capabilities` y hace una predicción falsable**: de los nueve campos que resuelve `mapAgent`, sólo TRES tienen un path declarado distinto de su nombre canónico — `capabilities`→`tags`, `price`→`price_per_call_usdc`, `reputation`→`erc8004.reputation_score`; los otros seis usan la misma clave en cualquier payload razonable y por eso una diferencia de forma les es invisible ⇒ **`priceUsdc` y `reputation` son los otros dos candidatos y NO se midieron** (AC-6/MI-2). **Vista autoritativa = la LISTA** (DT-1), por mecanismo y no por mayoría: aplica el mapeo al payload para el que se declaró en la misma sentencia SQL; `toArray(undefined)` y `toArray([])` colapsan los dos en `[]` (`:1491-1495`), así que el vacío del detalle **no es una afirmación sobre el agente sino el residuo de buscar en el lugar equivocado con la misma cara que una afirmación**; y un path equivocado sólo puede PERDER datos, nunca inventar cuatro capacidades plausibles. **Radio mayor que el que reporta el issue**: el mismo `getAgent` alimenta `GET /agents/:slug/agent-card` (`routes/agent-card.ts:43`) y las `skills` salen directo de `agent.capabilities` (`services/agent-card.ts:124`) ⇒ los 24 federados también publican `skills: []` en el artefacto que mira el estándar A2A. **Causa medida de que sobreviviera**: la única suite sobre la ruta de detalle **mockea el service entero** (`routes/discover.test.ts:25-30`, `getAgent: vi.fn().mockResolvedValue(null)`) ⇒ `mapAgent` nunca corre en ese camino bajo test y ninguna cantidad de tests de esa ruta podía cazarlo (CD-7). **Sizing subido de FAST+AR a QUALITY** con razón escrita: el defecto es un GET gratis de sólo lectura, pero el ARREGLO toca `mapAgent`, choke-point compartido con el camino de lista que alimenta a `/compose` ⇒ lo que decide el modo es la ubicación del arreglo, no la severidad del defecto (+ Demo Day el 31). ⚠️ **Este F1 corrió SIN SHELL** (sólo Read/Write/Glob): cada cita está marcada `[MEDIDO-F1]`, `[HEREDADO]` o `[NO MEDIDO]`, **ningún conteo es exhaustivo** (los 2 consumidores de `getAgent` son cota inferior hallada abriendo archivos de a uno, no un total — MI-4 lo deja como pre-requisito de F3), **no se pudo hacer un solo GET a producción** (la forma del cuerpo de `/api/v1/agents/<slug>` es `[NO MEDIDO]` y es la primera tarea de F2, MI-1) y **el nombre de la rama es una propuesta sin verificar**. | bugfix | QUALITY | F1 (sólo `work-item.md`) · in progress — pendiente `HU_APPROVED` | `fix/230-wkh-369-discover-detalle-capacidades-vacias` (propuesto, sin verificar) ([work-item.md](230-wkh-369-discover-detalle-capacidades-vacias/work-item.md)) |
