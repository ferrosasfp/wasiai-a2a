# Campaña de mutación — WKH-318 corte B

Rama `feat/218-wkh-318-corte-b-maxlimit-clamp`, árbol base `272a82f` (W3).
Cada mutante se aplicó **a mano** por reemplazo exacto de texto, se corrió
`npx tsc --noEmit` y el test nominado, se verificó que **muere**, y se revirtió.
Después de las 10, `git status --short -- src/ supabase/` quedó vacío: el revert
no dejó residuo.

## Regla que hace válida esta campaña (CD-7)

Ningún test de acá abajo compara contra un valor **recalculado**. Todos afirman
sobre `upstreamLimits`, que es el número **leído de la query string que salió**,
contra un string **literal escrito a mano** (`['100']`, `['200']`, `['10']`).
Eso es lo que hace que M3 muera: si el test dijera
`String(Math.min(resolveUpstreamFetchLimit(500), 100))`, invertir `Math.min` por
`Math.max` en producción **y** en el test dejaría el test verde, y M3
sobreviviría con el guard aplaudiendo.

## Resultado — 12/12 muertos (10 de la campaña del contrato + 2 del fix-pack)

⚠️ **Leer antes que la tabla.** Las primeras 10 mutaciones son las que el story
file pidió, y **NO cubrían el cambio entero**: el guard de W1.3
(`discovery.ts:1106`) quedó afuera del set y sus dos mitades sobrevivían a la
suite COMPLETA (lo midieron el AR y el CR por separado, 5014 y 4996 tests en
verde). "10/10 muertos" se leía como cobertura completa del diff y no lo era.
MA1 y MA2, abajo, son las que faltaban; se agregaron en el fix-pack junto con
las dos aserciones que las matan.

| # | Mutación | Archivo | Test nominado | Resultado |
|---|---|---|---|---|
| **M1** | `sentLimit = resolveUpstreamFetchLimit(query.limit)` (quitar el clamp) | `services/discovery.ts` | T-CLAMP-01 | ❌ **muere** (1 failed) |
| | | | T-CLAMP-03 | ❌ **muere** (1 failed) |
| | | | T-CLAMP-04 | ❌ **muere** (1 failed) |
| | | | T-CLAMP-05 | ❌ **muere** (1 failed) |
| **M2** | `return Math.min(fetchLimit, 100)` cuando NO hay declaración (default pesimista) | `lib/discovery-fetch-limit.ts` | T-CLAMP-02 | ❌ **muere** (1 failed) |
| | | | T-CLAMP-04b | ❌ **muere** (1 failed) |
| **M3** | `Math.max` en vez de `Math.min` | `lib/discovery-fetch-limit.ts` | T-CLAMP-01 | ❌ **muere** (1 failed) |
| **M4** | leer `(schema as ...).max_limit` en vez de `schema.maxLimit` (path roto) | `services/discovery.ts` | T-CLAMP-06 | ❌ **muere** (1 failed) |
| **M5** | clamp **fuera** del gate: `query.limit ?? 200` + `schema.limitParam ?? 'limit'` | `services/discovery.ts` | T-CLAMP-02b | ❌ **muere** (1 failed) |
| | | | T-CLAMP-02c | ❌ **muere** (1 failed) |
| **M6** | `(agents.length >= sentLimit \|\| sentLimit !== undefined)` (forzar `page_full`) | `services/discovery.ts` | T-CLAMP-03b | ❌ **muere** (1 failed) |
| **M7** | `.discover({ limit: Math.min(resolveComposeAgentPoolLimit(), 50) })` | `services/compose.ts` | T-CLAMP-07 | ❌ **muere** (1 failed) |
| **M8** | `Math.max(50, Math.min(fetchLimit, declared))` (piso de 50 al clamp) | `lib/discovery-fetch-limit.ts` | T-CLAMP-07b | ❌ **muere** (1 failed) |
| **M9** | `return (declared as number) >= 1` (sin `typeof` / `Number.isInteger`) | `lib/discovery-fetch-limit.ts` | T-CLAMP-08 | ❌ **muere** (1 failed) |
| **M10** | `typeof declared === 'number' && Number.isInteger(declared)` (sin el `>= 1`) | `lib/discovery-fetch-limit.ts` | T-CLAMP-08 | ❌ **muere** (1 failed) |
| **MA1** | se cae la mitad `sentLimit < unclamped` del guard del warn del piso | `services/discovery.ts` | T-CLAMP-02 (4º sub-caso) | ❌ **muere** (1 failed) — **antes del fix-pack SOBREVIVÍA** |
| **MA2** | se cae la mitad `isBelowComposePoolFloor(sentLimit)` del mismo guard | `services/discovery.ts` | T-CLAMP-01 | ❌ **muere** (1 failed) — **antes del fix-pack SOBREVIVÍA** |

## Notas por mutante — por qué muere, no sólo que muere

- **M2** es el mutante que pinea la decisión de §3 del story file. Muere por dos
  lados a propósito: T-CLAMP-02 ve que el número enviado dejó de ser
  byte-idéntico, y T-CLAMP-04b ve que una fuente que **tenía** que caer con `400`
  ahora sobrevive. Ese control negativo es lo que prueba que no hay ningún
  default de 100 escondido: sin él, T-CLAMP-04 pasaría igual con un default.
- **M4** se mató con T-CLAMP-06, que construye el `schema.discovery` con
  `JSON.parse` del **mismo literal jsonb que escribe la migración de W2**
  (`{"limitParam":"limit","nextCursorPath":"next_cursor","maxLimit":100}`). La
  fuente del `100` es el texto del `.sql`, no una constante nuestra, así que el
  test también se cae si la migración escribe otra clave.
- **M5**: la primera forma que probé (sólo sacar `query.limit` del gate) dejaba
  T-CLAMP-02c **vivo**, porque sin `schema.limitParam` el `set()` no escribe
  ningún parámetro llamado `limit` y el test seguía leyendo `null`. Por eso la
  mutación final agrega el fallback `?? 'limit'`: recién ahí las dos ramas del
  gate quedan realmente cubiertas. Un mutante mal construido habría reportado
  "sobrevive" y me habría mandado a arreglar un test que estaba bien.
- **M6** es más ancho que su etiqueta: fuerza `page_full` siempre que se haya
  enviado **algún** límite, no sólo cuando el clamp actuó (en ese bloque no está
  `unclamped` en scope). Es un superconjunto de la mutación pedida, así que
  matarlo es condición más fuerte, no más débil.
- **M7** vive en `compose.ts`, que **no** se modifica en esta HU: la mutación es
  temporal y sólo sirve para probar que T-CLAMP-07 mira el pool real. Muere
  porque el target no está verificado ⇒ es el último del ranking ⇒ recortar el
  page size a 50 lo deja afuera ⇒ `payment.chain` no se hidrata y queda el
  `avalanche` hardcodeado de `getAgent`.
- **M9** no mata por `"abc"` (en JS `"abc" >= 1` es `false`, así que ese caso
  sigue leyéndose inválido). Mata por `"100"` (`"100" >= 1` es `true` ⇒
  `Math.min(200, "100") = 100` ⇒ sale `'100'` en vez de `'200'`) y por `1.5`
  (⇒ sale `'1.5'`). La tabla de 7 inválidos de T-CLAMP-08 es lo que lo agarra:
  con un solo caso de prueba el mutante podía sobrevivir.
- **M10** mata por `0` (⇒ `?limit=0`, el catálogo casi vacío en silencio que
  CD-13 prohíbe) y por `-5`.
- **MA1 / MA2** (fix-pack, AR `BLQ-BAJO-2` = CR `M-1`) son **el mismo hallazgo**
  visto por dos revisores con harnesses distintos. Antes del fix-pack ninguna de
  las dos mitades del guard tenía test: MA1 medido sobreviviendo con 5014 tests
  passed (AR) y MA2/M11 con 4996 (CR). Reproducido acá antes de escribir nada:
  las dos sobrevivían a los 4 archivos del clamp, 56/56 en verde.
  · **MA1 cambia la conducta observable**, que es la vara que este mismo log fijó
  en la nota de M5: registry SIN `maxLimit`, `DISCOVERY_UPSTREAM_FETCH_LIMIT=10`,
  `discover({limit:5})` ⇒ HEAD manda `'10'` y **no** warnea; MA1 manda `'10'` y
  emite `REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL`. Es salida nueva en el camino que
  CD-3 se comprometió a dejar byte-idéntico, logs incluidos. Lo mata el 4º
  sub-caso de T-CLAMP-02 con una aserción **negativa**.
  · **MA2** necesita un clamp que NO hunda el pool: `maxLimit:100` +
  `discover({limit:500})` ⇒ `sent=100 < unclamped=500` pero `100 >= 50` ⇒ HEAD no
  warnea, MA2 sí. Lo mata la aserción negativa agregada a T-CLAMP-01.
  · Por eso el helper pasó a llamarse `isBelowComposePoolFloor` (CR M-2): con el
  nombre viejo (`clampFallsBelow…`) la primera mitad del guard **parecía**
  redundante, y el único freno para borrarla era prosa.

## Cómo se reprodujo

Script de aplicar/revertir por reemplazo exacto (con verificación de que el
patrón aparece **exactamente una vez**, para que una mutación no se aplique a
medias):
`scratchpad/mut318b.py <M1..M10> <apply|revert>`.

MA1/MA2 (fix-pack): `scratchpad/mut318b_fixpack.py <MA1|MA2> <apply|revert>`,
misma verificación de "el patrón aparece exactamente una vez" y revert desde un
backup byte-exacto (`filecmp.cmp(..., shallow=False)` ⇒ `True`), no desde git.

Comando de medición por mutante:
`npx vitest run <archivo> -t '<T-CLAMP-NN>'` — se lee la línea `Tests`.
