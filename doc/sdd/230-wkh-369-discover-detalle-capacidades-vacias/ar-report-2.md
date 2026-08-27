# AR-2 — Re-review del fix-pack · #230 · WKH-369

Rama `feat/230-wkh-369-detalle-capacidades-federadas` · commit `29d55e3` · base `18e4550`
2026-08-27 · nexus-adversary.

> Materializado por el orquestador desde el reporte inline del agente (el harness le impide
> escribir archivos). Contenido íntegro.
> **Nada acá se aceptó por lectura. Cada cierre se confirmó ejecutando, y cada rojo por su MOTIVO.**

## Veredicto: ✅ APROBADO con 2 MENOR · cero BLOQUEANTES

## 0 · El gate, corrido por el AR con el índice al día

`git status --porcelain` vacío antes y después.

| | Base `18e4550` | AR-1 (`6d1cb63`) | **AR-2 (`29d55e3`)** |
|---|---|---|---|
| `tsc` | 0 | 0 | **0** ✅ |
| `lint` | 516 | 519, README decía 516 | **519**, README dice 519 ✅ |
| test files | 310/316 | 311 + **1 FAILED** | **312 / 318** ✅ |
| casos | 6290/6309 | 6300 + **4 FAILED** | **6309 / 6328** ✅ |

**El guardián está vivo, no es tautológico** — mutando `README.md:378` de `318` a `317`:
`expected 317 to be 318` · `Tests 1 failed | 12 passed (13)`.

## Los 6 cierres

| # | Cierre | Evidencia ejecutada | |
|---|---|---|---|
| 1 | Gate completo, índice limpio | `0` · `519` · `312/318` · `6309/6328` · exit **0** | ✅ |
| 2 | Fan-out / rate limit | las 2 citas exactas + T-15 mata `{rateLimit:false}` con `expected 200 to be 429` | ✅ |
| 3 | CD-1 mecanizada | guard nuevo **ROJO** / guard viejo **VERDE**, mismo input | ✅ |
| 4 | `catch` mudo + `unresolved` falso | 3 mutantes de log muertos por T-12; T-11 mata el marcado incondicional | ✅ *(residual MNR-1)* |
| 5 | Deuda pineada | cerrar TD-369-6 pone T-14 rojo en `:381` | ✅ |
| 6 | Dependencia de orden | **19/19 verdes aislados** | ✅ |

### 2 · El argumento del fan-out se sostiene, no es racionalización

Las dos citas del Dev, verificadas exactas: `discovery-fetch-limit.ts:74-79` es
`Math.max(pageLimit, base)` con `base = 200` ⇒ un `limit` menor **no** baja el fetch upstream; y
`discovery.ts:668` hace el `slice` **después** del `sort` de `:648` ⇒ un límite chico puede dejar
al agente pedido fuera de la ventana y producir un `unresolved` **falso**. Acotar cambiaría un
problema de **costo** por uno de **corrección**.

Precisión que el AR deja escrita para que nadie lo lea de más: acotar **sí** bajaría el conteo de
queries, porque `attachIdentities` corre post-slice (`:672`). El Dev no afirma lo contrario — su
frase es sobre el fetch upstream y es literalmente cierta. La objeción de corrección se sostiene sola.

Dos flancos cerrados que no estaban pedidos: `routes/agent-card.ts`, que ahora hace el **mismo**
fan-out, **nunca tuvo** exención (hereda el límite global); y el cierre no introduce dependencia
de disponibilidad nueva — `middleware/rate-limit.ts:33-45` registra el plugin **sin store Redis**,
así que no aplica la nota de `RATE_LIMIT_FAIL_OPEN`.

### 3 · CD-1: el control es la evidencia, no el verde

Mismo input del AR-1 (`agent-detail.ts:103` comentada + `CAPS_FED = []`):

```
GUARD NUEVO  → PASS(0) FAIL(1)   expected 0 to be greater than or equal to 1   ← ROJO
GUARD VIEJO  → PASS(1) FAIL(0)                                                 ← VERDE. Ésa era la falla.
```

**¿El guard nuevo se satisface con una fila que no puede fallar?** No.
`coincideConContenidoFederado` exige el bucket **y** `registryId !== SELF_PUBLISHED_REGISTRY_ID`.
De los 4 slugs: `self-agent` excluido por registro; `fed-sin-caps` y `fed-fuera-del-listado`
clasifican `coincideEnVacio`. **El único que puede subirlo es `fed-con-caps`**, y la prueba de que
pertenece a la población del bug es que la mutación lo llevó a 0. El registro sale del agente real,
no de una tabla paralela que pudiera divergir del resolver.

## Regresiones del fix-pack — buscadas, no encontradas

`discovery.ts`, `compose.ts`, `agent-price.ts` → **0 líneas** en el diff contra `main`.
`services/agent-card.ts` (fuera del Scope IN) **no aparece**. 6 archivos `src/` tocados, los 6
declarados. **Ninguna aserción se debilitó**: la única borrada es el guard viejo de CD-1,
reemplazado por uno estrictamente más fuerte; y el `not.toBe` de T-12 se removió con motivo
correcto — dados los dos `toMatchObject` con literales distintos, **no existe input que lo ponga
rojo**. Los fixtures divergentes del CR quedaron con **datos idénticos** (sólo difieren comentarios).
Las 4 citas del CR re-ancladas y verificadas. Las anclas W−1 contra la base, exactas.

---

## 🔵 MNR-1 — Los dos `error_code` separan las dos RAMAS, no las dos CAUSAS que el docblock nombra

`agent-detail.ts:116-123` (docblock) vs `:136` (el `catch`).

El comentario dice que la separación distingue «el agente no está en el catálogo» de «el catálogo
no se pudo leer», y nombra «un registro caído durante horas». Pero el `catch` sólo se alcanza si
`discover()` **tira**, y `discover()` está construido (WKH-318) para **degradar en vez de tirar**.
⇒ **El modo de falla dominante en producción —el endpoint de lista contestando 5xx/timeout— NO
llega al `catch`.**

Sonda ejecutada (503 en la LISTA, OK en el detalle), luego borrada:
```
state= unresolved  caps= []
warns= [ {"error_code":"REGISTRY_SOURCE_FAILED","registry":"WasiAI","failure":"http_error"},
         {"error_code":"DETAIL_AGENT_ABSENT_FROM_CATALOG","slug":"fed-con-caps","rows":0} ]
```
El catálogo estaba **caído** y el resolver emitió el código de **ausente**.

**Por qué MENOR**: la señal que discrimina existe y es estructurada — `discovery.ts` emite
`REGISTRY_SOURCE_FAILED` en la **misma request**, y el warn del resolver trae `rows: 0`. Nada se
rompe; lo que sobra es la afirmación del docblock. El cierre que el AR-1 pidió está cumplido.

**Impacto**: quien grepee sólo `DETAIL_CATALOG_UNREADABLE` para encontrar registros caídos va a
ver cero y concluir que no hubo ninguno.

**Salida**: (a) corregir el docblock para que diga qué separan **realmente** los dos códigos
(`discover()` tiró vs `discover()` respondió sin la fila), y (b) llevar `listado.sources[].state`
al warn de la rama ausente — el objeto ya está en la mano en `:100`. ~2 líneas.

## 🔵 MNR-2 — Un cross-reference apunta al mutante equivocado

`agent-detail.test.ts:562-563` dice que los dos literales de `error_code` tienen «cada uno su
propio rojo (mutantes MUTANTE-3a y MUTANTE-3b)», pero `auto-blindaje.md §7.2` define MUTANTE-3a
como **borrar el `log.warn`**, no como un literal. La sustancia es cierta —los dos colapsos
mueren por separado— pero el puntero nombra un mutante que no es el que respalda la frase.

---

## Higiene

Backups en subdirectorio **propio**, cada uno verificado con `/usr/bin/diff -q` antes de usarse.
Mutaciones con `sed -i`/`python3`, restauradas con `cp`. **Nunca `git checkout --`.** La sonda
temporal eliminada restaurando desde backup. Sin `cat`, sin la herramienta `Grep`.
Estado final: `git status --porcelain` vacío · HEAD `29d55e3` · los 5 archivos mutados
`diff -q`-idénticos a su backup.
