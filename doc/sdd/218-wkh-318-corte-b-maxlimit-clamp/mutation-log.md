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

## Resultado — 10/10 muertos

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

## Cómo se reprodujo

Script de aplicar/revertir por reemplazo exacto (con verificación de que el
patrón aparece **exactamente una vez**, para que una mutación no se aplique a
medias):
`scratchpad/mut318b.py <M1..M10> <apply|revert>`.

Comando de medición por mutante:
`npx vitest run <archivo> -t '<T-CLAMP-NN>'` — se lee la línea `Tests`.
