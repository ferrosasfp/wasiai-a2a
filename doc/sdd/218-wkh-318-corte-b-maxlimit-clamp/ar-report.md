# AR — WKH-318 corte B (HU 218)

**Persistido por el orquestador**: el agente de AR sólo tenía `Read`/`Bash` y tiene prohibido
usar redirects de shell (el proxy `rtk` corrompe el contenido con exit 0). Entregó el reporte
en su mensaje; este archivo es esa entrega.

Higiene: el árbol real quedó idéntico, HEAD en `4920399`. Toda mutación corrió sobre una copia
en scratchpad con `node_modules` symlinkeado y `git init` propio.

## VEREDICTO: RECHAZADO — 2 BLOQUEANTE-BAJO. Cero ALTO, cero MEDIO.

Los dos son de una línea y una aserción. El fix-pack es chico; el gate es binario.

---

## Blanco 1 — "sin la migración esto no cambia NADA": **VERIFICADA mecánicamente**

No se creyó: se midió con un diferencial. Un harness corre la MISMA matriz contra el código de
`main` y contra HEAD, con un registry que **no** declara `maxLimit`:

- 6 valores de `DISCOVERY_UPSTREAM_FETCH_LIMIT` (ausente, 25, 300, `abc`, 0, 10)
- × 3 formas de schema (`limitParam`, sin `limitParam`, `limitParam`+`nextCursorPath`)
- × 7 `limit` del caller (ausente, 1, 5, 50, 200, 500, 1000000)
- = **126 combinaciones**, registrando el `?limit=` que salió por la red, `sources[0].state`,
  `truncationEvidence`, `catalogStatus`, cantidad de agentes **y el set de `error_code` de los warn**.

`diff main.txt head.txt` → **vacío**. Byte-idéntico, logging incluido.

Calibración del instrumento antes de creerle: la primera versión daba `state=failed` en las 126
filas porque los mocks estaban mal; corregida copiando el setup de `discovery.limit.test.ts:39-58`,
recién ahí produjo los valores conocidos 200/500 de T-4/T-6.

**La grieta buscada no existe en este repo:**
- `maxLimit` aparece en 9 archivos, todos de esta HU. Ninguna migración anterior, ningún seed, ningún fixture.
- Los dos seeds de `registries` (`20260401000000_kite_registries.sql:44-66`,
  `20260404000000_mock_community_registry.sql:28-49`) no lo traen.
- No hay default en código: lo prueba M2, re-verificado.
- Único write-path alternativo: `POST /registries` / `PATCH /registries/:id` guardan `schema` sin
  validar (`routes/registries.ts:251`, `:358`). El PATCH está ownership-gated contra `owner_ref`,
  así que un tercero **no** puede escribirle `maxLimit` a la fila `wasiai`. No es escalada.

**Regalo para el work-item**: la migración de `nextCursorPath` del corte A **SÍ está aplicada en
bdwv**. Medido hoy en prod vía el proxy de v2:

```
GET .../capabilities          → sources:[{name:WasiAI, state:truncated, rows:20, truncationEvidence:"cursor"}], total 23
GET .../capabilities?limit=50 → sources:[{name:WasiAI, state:failed, failure:http_error}], partial, total 3
```

## Blanco 2 — el clamp: correcto en los 20 bordes probados

| caso | sent | state | warns |
|---|---|---|---|
| `maxLimit == over-fetch (200)` | 200 | ok | — |
| `maxLimit > over-fetch (1000)` | 200 | ok | — |
| `maxLimit = 1` | 1 | truncated/page_full | BELOW_COMPOSE_POOL |
| `maxLimit = 50` (piso exacto) | 50 | ok | — |
| `maxLimit = 49` (piso−1) | 49 | ok | BELOW_COMPOSE_POOL |
| caller pide menos que `maxLimit` | 100 | ok | — |
| caller pide más que `maxLimit` | 100 | ok | — |
| `env=10` + `maxLimit=10` | 10 | truncated | — |
| `env=10` + `maxLimit=8` | 8 | truncated | BELOW_COMPOSE_POOL |
| `maxLimit = 1e21` | 200 | ok | — |
| `Infinity` / `true` / `[]` / `"200"` | 200 | ok | MAX_LIMIT_INVALID |

Nunca `NaN`, nunca `0`, nunca negativo. El borde 49/50 exacto. `env=10 + maxLimit=10` no warnea,
que es lo que CD-3 pide.

## Blanco 3 — la migración: aditiva, idempotente, marcador byte-exacto

- Línea 2 de **los dos** archivos verificada a nivel bytes. ✓
- `grep -rn "NO aplicar" supabase/migrations/` → sólo estos 2: la convención es nueva.
- Cero DDL. `UPDATE ... WHERE id='wasiai' AND schema->'discovery' IS NOT NULL`. No toca `auth`.
- Doble aplicación: segura (`jsonb_set` idempotente). Fila inexistente: `UPDATE 0`, sin error.
- bdwv vs caldz: sólo el comentario, sin guard mecánico — igual que el exemplar (DT-3).
- `node scripts/migrate-preflight.mjs` sobre ambos: `[OK] no risk patterns`, exit 0.

---

## `BLQ-BAJO-1` — prosa que afirma de más, en el módulo que W0.4 existía para des-afirmar

`src/lib/discovery-fetch-limit.ts:30-31`:
> *"...y el recorte no se esconde — sale como `truncated`/`page_full` en `sources[]`."*

**Reproducción ejecutada**: registry con `{limitParam:'limit', maxLimit:100, nextCursorPath:'next',
agentsPath:'agents'}`, 300 filas upstream, `discover({limit:500})`, el registry responde 100 filas
+ `next: null`.

- Esperado por la frase: `state:'truncated'`, evidencia `page_full` o `cursor`.
- **Real**: `sent=100`, `state:'ok'`, `truncationEvidence: undefined`, `rows:100`, `catalogStatus:'complete'`.
- Control sin `maxLimit`: `sent=500`, `rows=300`, `ok` — ahí el `ok` es verdadero.

El clamp cortó 200 filas y la respuesta pública afirma completitud. La rama que lo produce es
`discovery.ts:1216-1221`: un cursor falsy pone `completenessProven = true` y **cortocircuita** la
heurística `page_full` de `:1224`.

Segunda instancia, misma clase, `discovery-fetch-limit.ts:195-197`: *"mandarle 50 a un registry que
declaró 10 devuelve 400"* — afirmación universal sobre la conducta de un tercero, sin el input que
la rompe (un registry que clampea en silencio devuelve 200).

**Impacto**: es la clase que CD-8 se escribió para cortar, en el módulo que W0.4 mandó tocar
**porque su frase anterior afirmaba de más**. Se corrigió un sobre-anuncio escribiendo otro.

## `BLQ-BAJO-2` — las dos mitades del guard de W1.3 no tienen ningún test

`src/services/discovery.ts:1106`: `if (sentLimit < unclamped && clampFallsBelowComposePoolFloor(sentLimit))`

Suite completa sobre la copia:

| mutante | resultado |
|---|---|
| **MA1**: se cae la mitad `sentLimit < unclamped` | **SOBREVIVE** — 5014 tests passed, 0 failed |
| **MA2**: se cae la mitad del piso | **SOBREVIVE** — 5014 tests passed, 0 failed |

Y MA1 **sí cambia la conducta observable** (la vara que el propio auto-blindaje fijó):

> registry SIN `maxLimit`, `DISCOVERY_UPSTREAM_FETCH_LIMIT='25'`, `discover({limit:5})`
> - HEAD: `sent=['25']`, `warns=[]`
> - MA1: `sent=['25']`, `warns=['REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL']`

Es **literalmente** el escenario que W1.3 usa para justificar la primera mitad, y está a un paso de
ser alcanzable: T-5 (`discovery.limit.test.ts:174-181`) ya corre con `env='25'` y sólo mira el
`?limit=`, no los logs.

**Impacto**: la promesa CD-3 de "byte-idéntico, logs incluidos" está sin custodia. Y
`mutation-log.md` dice **"10/10 muertos"**, que se lee como cobertura completa del cambio, con la
condición más argumentada del story file afuera del set. El Dev ejecutó los M1–M10 que el contrato
le pidió; el hueco es del contrato, pero se cierra acá.

---

## MENORES

**`MNR-1`** — el `100` se midió contra un host que NO es el `discovery_endpoint` sembrado. La
migración dice *"Medido: `?limit=100` → 200, `?limit=101` → 400"* sin nombrar el origen; el story
file nombra `wasiai-v2.vercel.app`, y el seed (`kite_registries.sql:41`) tiene
`discovery_endpoint = https://app.wasiai.io/api/v1/capabilities`. Medido hoy: los dos orígenes NO
se comportan igual sin auth (`wasiai-v2…?limit=101` → 400; `app.wasiai.io…?limit=200` → 200 con el
payload del proxy). Impacto sobre el código: nulo. Sobre la evidencia: el número se justificó
midiendo otro origen.

**`MNR-2`** — el marcador "NO aplicar" no tiene control mecánico, y `migrate-preflight.mjs` imprime
`[PASS] safe to apply` y sale 0. Este repo ya aprendió que una convención sólo en prosa no
sobrevive (`discover-callsites.test.ts` existe por eso). Hay precedente de test sobre contenido de
migraciones y no se usó.

**`MNR-3`** — el `_down` no es el inverso exacto: **borra** `maxLimit` mientras el `_up` lo
**sobreescribe**. Si una fila ya tenía uno propio (alcanzable vía `PATCH /registries/:id`), el up
lo pierde y el down no lo restaura.

**`MNR-4`** — se loguea verbatim un jsonb controlado por un tercero, en cada request
(`discovery.ts:1092-1099`). Un tenant puede `POST /registries` con `schema` arbitrario y
`enabled:true`, y con un `maxLimit` de ~1 MB cada `/discover?limit=N` de cualquier caller escribe
ese blob a nivel warn. Amplificación de volumen de logs.

**`MNR-5`** — el warn del piso se dispara en `/discover` y afirma una consecuencia de `/compose`
como hecho (`discovery.ts:1113`). Medido: dispara sin `/compose` de por medio y sin que haya
ningún agente afuera.

---

## Lo que se atacó y salió limpio (para que no se re-persiga)

- **El cast `declared as number`**: el Dev tiene razón. Sacarlo da `TS2345`. Y no puede mentir en
  runtime: `isUsableRegistryMaxLimit` devolvió `true` ⟹ `typeof declared === 'number'`.
- **Los tres desmentidos al Story File: los tres ciertos**, verificados ejecutando cada uno. M5 en
  su primera forma deja pasar T-CLAMP-02c y mata T-CLAMP-02b; M9 muere en `"100"`, no en `"abc"`
  (porque `"abc" >= 1` es `false`). No se acomodó ningún mutante.
- **CD-7**: confirmado. Toda aserción de límite es un literal escrito a mano. T-CLAMP-06 saca su
  `100` del mismo literal jsonb que escribe la migración — eso es medir contra la fuente.
- **Scope**: `compose.ts`, `orchestrate.ts`, `src/mcp`, `src/routes`, `mcp-servers`, `packages` sin
  una línea tocada. `discovery-fetch-limit.ts` sigue con 0 imports (leaf intacto).
- **Verde medido**: `tsc` exit 0, biome 442 archivos sin fixes, suite 5014 passed / 19 skipped.

## Las 11 categorías

| # | Categoría | Resultado |
|---|---|---|
| 1 | Security | MNR-4 |
| 2 | Error Handling | OK — el clamp no agrega caminos de error; `RegistryHttpError` intacto (CD-4) |
| 3 | Data Integrity | OK — sin escritura salvo la migración; idempotente; sin concurrencia nueva |
| 4 | Performance | MNR-4 (volumen de log); el resto O(1) |
| 5 | Integration | OK — `limitParam` se setea en UNA sola línea de todo `discovery.ts` (`:1084`) |
| 6 | Type Safety | OK |
| 7 | Test Coverage | **BLQ-BAJO-2** |
| 8 | Scope Drift | OK |
| 9 | Destructive Migrations | MNR-2, MNR-3 — no destructiva, sin DROP/ALTER/TRUNCATE, con `_down` |
| 10 | RPC SECURITY DEFINER | N/A |
| 11 | Cache Invalidation | N/A |
| — | Prosa / CD-8 | **BLQ-BAJO-1**, MNR-5 |
