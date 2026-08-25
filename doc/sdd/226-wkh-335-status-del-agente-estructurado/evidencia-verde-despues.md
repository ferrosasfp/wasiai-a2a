# Evidencia AC-5 / CD-4 — VERDE DESPUÉS del cableado

**HU**: WKH-335 · Wave 1 · `wasiai-a2a`
**Worktree**: `/home/ferdev/.openclaw/workspace/a2a-wkh362`
**Rama**: `feat/wkh-335-status-estructurado`
**Fecha**: 2026-08-25
**Par**: `evidencia-rojo-antes.md` (misma suite, mismo comando, mismos testigos)

## Estado del árbol en el momento de esta corrida

W1.2 cableado — los **TRES** sitios de `src/services/compose.ts`:

| # | Sitio | Línea (post-edición) |
|---|---|---|
| 1 | `import { AgentHttpError } from '../lib/agent-http-error.js';` | `:13` |
| 2 | `throw new AgentHttpError(agent.slug, response.status, detail)` | `:1792` |
| 3 | helper `agentFailureResult(err)` | `:174` |
| 4 | `...agentFailureResult(retryErr)` — camino CON RETRY (AC-2) | `:1184` |
| 5 | `...agentFailureResult(err)` — camino DIRECTO (AC-1) | `:1220` |

## Comando (IDÉNTICO al de la corrida roja)

```bash
cd /home/ferdev/.openclaw/workspace/a2a-wkh362
rtk proxy npx vitest run src/services/compose.test.ts
```

## Salida literal

```
 RUN  v4.1.9 /home/ferdev/.openclaw/workspace/a2a-wkh362


 Test Files  1 passed (1)
      Tests  112 passed (112)
   Start at  06:06:22
   Duration  8.76s (transform 272ms, setup 0ms, import 517ms, tests 8.17s, environment 0ms)
```

### Los 7 testigos, por nombre (paso 5: citables por nombre, no por inferencia)

```
rtk proxy npx vitest run src/services/compose.test.ts -t "T-335" --reporter=verbose
```

```
 ✓ src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-DIRECT-4XX: 400 sin field-errors → agentFailure INPUT_REJECTED, error intacto 93ms
 ✓ src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-DIRECT-5XX: 500 → AGENT_ERROR, y NO es el mismo valor que el 400 166ms
 ✓ src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-RETRY: 422+fields → regen → 400 → INPUT_REJECTED por el return del RETRY 127ms
 ✓ src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-RETRY-5XX: 422+fields → regen → 500 → AGENT_ERROR (el 422 inicial no manda) 242ms
 ✓ src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-ABSENT: error de red (sin status HTTP) → la clave agentFailure NO existe 80ms
 ✓ src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-NOLEAK: body con URL y secreto → el campo no ecoa nada de eso 83ms
 ✓ src/services/compose.test.ts > composeService.compose — WKH-130 adaptive input-retry > T-335-BACKCOMPAT: pipeline 2xx → sin la clave agentFailure 84ms
      Tests  7 passed | 105 skipped (112)
```

## Paso 3 del protocolo — el conteo de tests RECOLECTADOS

| Corrida | Línea de vitest | Recolectados |
|---|---|---|
| **ROJO** (antes de W1.2) | `Tests  5 failed \| 107 passed (112)` | **112** |
| **VERDE** (después de W1.2) | `Tests  112 passed (112)` | **112** |

**Coinciden.** Ningún testigo dejó de recolectarse entre las dos corridas, así que
el verde mide exactamente los mismos 112 `it` que el rojo. Los 5 que estaban en
rojo son los 5 que pasaron a verde; los otros 107 nunca se movieron.

## CD-6 MEDIDO, no leído — los dos `return` son sitios DISTINTOS

Una corrida verde no prueba que los DOS sitios estén cableados: podría estarlo uno
solo y que los tests del otro pasaran por casualidad. Se midió borrando **un spread
por vez** y viendo a quién mata cada uno.

**Mutante A** — se borra SÓLO `...agentFailureResult(retryErr)` (`compose.ts:1184`,
camino con retry):

```
 ✓ T-335-DIRECT-4XX
 ✓ T-335-DIRECT-5XX
 × T-335-RETRY
 × T-335-RETRY-5XX
 ✓ T-335-ABSENT
 ✓ T-335-NOLEAK
 ✓ T-335-BACKCOMPAT
      Tests  2 failed | 5 passed | 105 skipped (112)
```

**Mutante B** — se borra SÓLO `...agentFailureResult(err)` (`compose.ts:1220`,
camino directo):

```
 × T-335-DIRECT-4XX
 × T-335-DIRECT-5XX
 ✓ T-335-RETRY
 ✓ T-335-RETRY-5XX
 ✓ T-335-ABSENT
 × T-335-NOLEAK
 ✓ T-335-BACKCOMPAT
      Tests  3 failed | 4 passed | 105 skipped (112)
```

**Los dos conjuntos de muertos son DISJUNTOS:**

| Mutante | Mata | No toca |
|---|---|---|
| A (retry) | `T-335-RETRY`, `T-335-RETRY-5XX` | los 3 del directo |
| B (directo) | `T-335-DIRECT-4XX`, `T-335-DIRECT-5XX`, `T-335-NOLEAK` | los 2 del retry |

Eso es la prueba de CD-6: **son dos sitios de código separados, cada uno con su
propia variable de `catch`, y cada uno tiene testigos propios que sólo él puede
salvar.** Si hubiera cableado uno solo, la mitad de esta tabla habría quedado en
rojo — y es exactamente el modo de falla que el Story File nombra como trampa #1.

El árbol se restauró desde una copia previa a las mutaciones y volvió a dar
`Tests  112 passed (112)`.

## Gate de cierre de Wave 1 — la secuencia COMPLETA, en orden, una vez

```
--- [1/3] npx tsc -p tsconfig.json --noEmit ---
tsc exit: 0
--- [2/3] npm run lint ---
> wasiai-a2a@0.1.0 lint
> biome check src/
Checked 503 files in 172ms. No fixes applied.
lint exit: 0
--- [3/3] npm test ---
> wasiai-a2a@0.1.0 test
> vitest run
 RUN  v4.1.9 /home/ferdev/.openclaw/workspace/a2a-wkh362
 Test Files  298 passed | 6 skipped (304)
      Tests  5961 passed | 19 skipped (5980)
   Start at  06:09:44
test exit: 0
```

CD-16: el veredicto es la **suite completa del repo** (5980 tests), no una corrida
dirigida a los archivos tocados. Cero fallos, cero regresiones.

⚠️ **Esta corrida se hizo con TODO el árbol en el índice de git** (`git add -A`).
No es un detalle: dos familias de guards de este repo (`readme-numbers`,
`sdd-index-matches-folders`) derivan sus números de `git ls-files`, así que un
archivo NUEVO sin `git add` los vuelve ciegos y produce un **verde falso**. Pasó
en esta misma sesión — ver la 4ª entrada de `auto-blindaje.md`.
