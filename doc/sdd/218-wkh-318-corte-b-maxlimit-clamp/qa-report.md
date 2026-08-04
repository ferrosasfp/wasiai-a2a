# QA Report (F4) — WKH-318 corte B / HU 218

**Rama** `feat/218-wkh-318-corte-b-maxlimit-clamp` · **HEAD** `9ce5cb7` (9 commits de fix-pack sobre `4920399`)
**Revisor**: nexus-qa · **Fecha**: 2026-08-04
**Higiene**: todo lo "medido" corrió sobre `git archive HEAD` en scratchpad (symlink a `node_modules`), nunca sobre el árbol real. `git status` idéntico antes/después (sólo los 6 untracked pre-existentes de otra sesión, ninguno de esta HU).

## VEREDICTO: RECHAZADO — no por las ACs (las 7 pasan), por un DRIFT de scope que corrompería `main` si se mergea así

Ver "Drift" abajo. El clamp en sí está listo para DONE; el commit `c7d88c4` no.

---

## ACs (7/7 PASS, con evidencia)

| AC | Texto (resumen EARS) | Veredicto | Evidencia |
|----|---|---|---|
| AC-1 | registry declara `maxLimit` + caller manda `limit` ⇒ `limitParam` nunca excede `maxLimit` | PASS | `src/services/discovery.limit.test.ts:246` T-CLAMP-01 — `upstreamLimits === ['100']` con `limit:500` y `maxLimit:100`. Verde: 57/57 en los 4 archivos de clamp (corrida propia, ver Gates) |
| AC-2 | sin `maxLimit` ⇒ byte-idéntico | PASS | `discovery.limit.test.ts:268` T-CLAMP-02 (4 sub-casos, incluido `DISCOVERY_UPSTREAM_FETCH_LIMIT=10` sin warn — el sub-caso que MA1 necesita), `:309` T-CLAMP-02b, `:322` T-CLAMP-02c. Confirmado además por mutación: MA1 muere acá (ver Mitad 2) |
| AC-3 | `limitParam` clampeado + página llena sin cursor ⇒ `truncated`/`page_full`, nunca `http_error` | PASS | `src/services/discovery.truncation.test.ts:291` T-CLAMP-03 (`state:'truncated'`, `truncationEvidence:'page_full'`, `failure` undefined), `:309` T-CLAMP-03b (página corta bajo el techo ⇒ `ok`, control del falso positivo) |
| AC-4 | `wasiai` con `limitParam<=100` no recibe 400 | PASS | `src/services/discovery.sources.test.ts:535` T-CLAMP-04 (mimic con techo 100, `state !== 'failed'`), `:556` T-CLAMP-04b (control negativo: mismo mimic SIN `maxLimit` sigue cayendo). Verificación adicional en runtime real, hoy: `curl https://wasiai-v2.vercel.app/api/v1/capabilities?limit=100` → `200`; `?limit=101` → `400` (confirma el "100" de la migración sigue siendo el techo real) |
| AC-5 | `/compose` vía `resolveComposeAgentPoolLimit()` obtiene el pool completo post-fix | PASS | `src/services/compose.discovery-pool.test.ts:429` T-CLAMP-05 — 100 activos, target no-verificado (último del ranking), pool clampeado a 100 SÍ lo alcanza y `payment.chain` se hidrata (`solana-devnet`, no el `avalanche` default) |
| AC-6 | migración setea `maxLimit=100` para `id='wasiai'` ⇒ clamp aplica sin código adicional | PASS | `discovery.limit.test.ts:307` T-CLAMP-06 — schema parseado de un literal jsonb con la MISMA forma `{"maxLimit":100,...}` que produce `jsonb_set` (`supabase/migrations/20260804000000_wkh318b_registry_max_limit.sql:43-49`, clave `{discovery,maxLimit}` confirmada línea por línea) clampea sin tocar `discovery.ts`. Nota: el test no lee el `.sql` en runtime (parsea un literal hand-typed que replica su forma), así que NO detectaría un futuro cambio de clave en la migración — matiz, no motivo de FAIL |
| AC-7 | el clamp preserva la garantía de pool superconjunto (WKH-189) con una sola fuente contribuyente | PASS | `compose.discovery-pool.test.ts:456` T-CLAMP-07 (techo 100 > piso 50, target sigue adentro), `:477` T-CLAMP-07b (techo 10 < piso 50: se manda 10, NO se le pone piso, warnea `REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL`, residual documentado como TD-318B-2). Precondición de una sola fuente re-verificada y sigue vigente: `discovery-fetch-limit.ts:209-237` |

---

## Gates (corridos por mí, no reciclados)

- **`npx vitest run`** (repo real, rama actual): `244 test files passed | 6 skipped (250)` / `5020 tests passed | 19 skipped (5039)`. Confirma exacto lo que reportó el Dev y lo que dice `cr-report.md`.
- **`npx tsc --noEmit`**: exit 0, sin errores.
- **`npm run lint`** (`biome check src/`): `Checked 442 files in 154ms. No fixes applied.` — exit 0.
- **`node scripts/migrate-preflight.mjs`** sobre los dos `.sql` (up y down): `[PASS] Pre-flight OK — safe to apply` en ambos, `[OK] Static analysis: no risk patterns matched`.

## Mitad 2 — re-verificación por mutación de los dos cierres del fix-pack

### 1. El guard de `discovery.ts:1117` (`if (sentLimit < unclamped && isBelowComposePoolFloor(sentLimit))`)

Corrido en copia aislada (`git archive HEAD` + symlink a `node_modules`, sin `.git`), suite completa cada vez, restaurado y `diff -q` contra el original tras cada mutante ⇒ idéntico.

| Mutante | Resultado | Test que mata |
|---|---|---|
| **MA1** — sacar `sentLimit < unclamped &&` | **ROJO.** `Test Files 3 failed \| 241 passed`, `Tests 1 failed \| 4996 passed \| 19 skipped`. Los otros 2 archivos rojos (`discover-callsites.test.ts`, `test/test-files-are-run-in-ci.test.ts`) son el artefacto conocido de correr sin `.git` (`fatal: not a git repository`), no atribuibles a la mutación | `discovery.limit.test.ts` **T-CLAMP-02** (4º sub-caso, `:284-292`) — `logSpy.warn` SÍ se llama con `REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL` cuando el mutante lo deja pasar sin clamp real |
| **MA2** — sacar `&& isBelowComposePoolFloor(sentLimit)` | **ROJO.** Mismo patrón: 1 test roto + los 2 artefactos de `.git` | `discovery.limit.test.ts` **T-CLAMP-01** (`:246`) — con el mutante, `maxLimit:100` (que SÍ clampea, 100 no cae bajo 50) dispara igual el warn del piso |
| **MA3** — la línea nueva del acotado del log (`declared: previewDeclaredMaxLimit(schema.maxLimit)` → `declared: schema.maxLimit` crudo) | **ROJO.** Mismo patrón | `discovery.limit.test.ts` **T-CLAMP-09** (`:377-406`) — `declared.length` deja de ser `76` y de terminar en `'…[truncated]'` cuando el blob de 100k chars se copia sin acotar |

Los tres mutantes mueren. `BLQ-BAJO-2` del AR está cerrado: las dos mitades del guard tienen quién las mate, y la nueva forma acotada del log también.

### 2. La prosa de `src/lib/discovery-fetch-limit.ts:32-46`

Intento de falsificación: la versión post-fix-pack ya NO afirma "el recorte no se esconde" en general — la acota a "sólo cuando el registry no declaró un cursor" y da el input exacto donde queda MUDO (`nextCursorPath` declarado + clave en `null`). Repasé el código real que decide esto (`discovery.ts:1220-1240`, la máquina de `truncationEvidence`/`completenessProven`) para buscar un input que rompa la frase:

- Probé **cursor ausente** (`undefined`, la clave no viene en el payload): NO muta el recorte — cae en la heurística de página llena (`agents.length >= sentLimit`) y sale `truncated`/`page_full`, visible. Consistente con la frase (que sólo nombra "cursor declarado + nulo" como el caso mudo, no "cursor declarado" en general).
- Probé **cursor con valor falsy pero no `null`** (`''`, `0`, `false`): el código (`discovery.ts:1224-1226`, comentario explícito sobre "centinelas falsy") los trata IGUAL que `null` — también mudo. La prosa sólo da `null` como ejemplo medido, no dice "únicamente null", así que esto no la falsifica; es una omisión de generalidad, no una afirmación falsa.
- No encontré una combinación de `(nextCursorPath declarado, valor de cursor, maxLimit, cantidad de filas)` donde la frase (tal como quedó escrita) prediga un resultado distinto del que produce el código.

**No pude falsificarla.** La reescritura corrige el BLQ-BAJO-1 real (antes afirmaba "nunca se esconde" sin condición); ahora es condicional y la condición coincide con el código.

---

## Confirmación de la afirmación central (CD-3, sin la migración aplicada)

`git diff main..HEAD -- src/services/discovery.ts` (diff completo, no resumen): el ÚNICO bloque nuevo es el de `queryRegistry` (import + `sentLimit = clampToRegistryMaxLimit(unclamped, schema.maxLimit)` + los dos `log.warn`). Los dos `warn` (el de techo inválido y el del piso) están cerrados, respectivamente, detrás de `schema.maxLimit !== undefined` y de `sentLimit < unclamped` — y `clampToRegistryMaxLimit` devuelve `fetchLimit` sin tocar cuando `isUsableRegistryMaxLimit(undefined)` es `false`. Sin la fila `wasiai` teniendo `maxLimit` en la DB (migración NO aplicada — confirmado que sigue sin aplicar, ver nota de acceso abajo), `sentLimit === unclamped` siempre y NINGUNA de las dos ramas nuevas ejecuta código observable: no hay clamp, no hay log nuevo. La línea que el fix-pack agregó (el acotado `previewDeclaredMaxLimit`) vive DENTRO de una rama que hoy nunca se alcanza en prod, así que no puede romper CD-3. Confirmado además por `T-CLAMP-02` (los 4 sub-casos, incluido bajar el env a 10) en verde.

**Nota de acceso**: no pude re-ejecutar el diferencial de 126 combinaciones del AR contra la DB real — el acceso a Supabase (incluso de sólo lectura) fue bloqueado por el clasificador de este entorno. Sí pude confirmar contra el endpoint público real (`https://wasiai-v2.vercel.app/api/v1/capabilities`, sin credenciales): `?limit=100` → `200`, `?limit=101` → `400`, el mismo número que el AR midió el mismo día y que la migración cita. Doy la verificación de la promesa CD-3 por CERRADA vía el argumento estático de arriba + los tests, no por haber repetido el diferencial completo — **marco esa repetición puntual como NO VERIFICABLE desde este entorno**, no como fallida.

## Ningún texto afirma que la HU arregla producción

`grep` sobre `doc/sdd/218-.../*.md`, `discovery.ts`, `discovery-fetch-limit.ts`: cero afirmaciones de "arregla el catálogo" fuera de negaciones explícitas. `story-WKH-318B.md:50` ("No 'casi lo arregla'. No lo arregla."), `:70` (prohibición explícita en cualquier `.md`), `:804` y `:831` (checklist). La migración (`20260804000000_wkh318b_registry_max_limit.sql:2`) dice "NO aplicar: la aplica el founder". Consistente.

---

## Drift Detection — BLOQUEANTE encontrado

- **Scope IN respetado en el código**: `src/services/discovery.ts`, `src/lib/discovery-fetch-limit.ts`, 2 migraciones, 4 archivos de test, `doc/sdd/215-.../backlog.md` (B-3 cerrado, en Scope IN explícito). `/compose`, `/orchestrate`, `src/mcp/`, `src/routes/`, `mcp-servers/`, `packages/`: **cero líneas tocadas** (`git diff --name-only main..HEAD` contra esos paths ⇒ vacío).
- **🔴 BLOQUEANTE — el commit `c7d88c4` ("docs(318b): la deuda sale de la carpeta...") arrastró ~2100 líneas de TRES HUs ajenas, sin mencionarlo en el mensaje**:
  - `doc/sdd/118-wkh-sec-02b-owner-ref-rpc/work-item.md` (263 líneas, NUEVO)
  - `doc/sdd/212-wkh-314-x402-inbound-solana/{sdd.md,work-item.md,_INDEX-row.md}` (857+492+15 líneas, NUEVOS)
  - `doc/sdd/214-wkh-316-escritor-payment-block/{work-item.md,_INDEX-row.md}` (449+32 líneas, NUEVOS)

  Verificado que NINGUNO de estos paths existe en `main` (`git cat-file -e main:<path>` ⇒ `fatal: ... exists on disk, but not in 'main'`) y que `git log main..HEAD` los atribuye exclusivamente a `c7d88c4`, cuyo mensaje de commit habla sólo de TD-318B-3/AR-MNR-2/story-file — nada de WKH-314/316/SEC-02B. Además, `git worktree list` muestra que **ya existen worktrees dedicados** (`wt-314` en `feat/212-wkh-314-x402-inbound-solana`, `wt-316` en `feat/214-wkh-316-payment-block-writer`) con SUS PROPIAS copias de esos mismos archivos — esto no es contenido nuevo perdido, es una copia extraviada que un `git add` amplio en este worktree recogió por accidente de archivos untracked que quedaron sueltos en `~/.openclaw/workspace/wasiai-a2a` (el directorio de ESTE worktree, no el de ellos).
  - `doc/sdd/_INDEX.md` NO ganó filas para esas 3 HUs (sólo la fila 218 propia, `0cad63d`) — el índice canónico no quedó corrompido, pero si esta rama se mergea a `main` tal cual, esos 4 archivos completos aparecen en `main` sin haber pasado ningún gate propio, y potencialmente en conflicto/duplicado con lo que `wt-314`/`wt-316` vayan a mergear después.

  **Impacto**: cero sobre el código o las 7 ACs de esta HU (son archivos `.md`, sin tocar `src/`). Pero es exactamente el tipo de drift que no se puede llamar "menor": mergear esta rama publica en `main` trabajo de otras 3 HUs que no pasó por su propio pipeline (F1 sin F2/AR/CR/QA), fuera de proceso.

  **Acción recomendada**: antes de mergear, un commit que haga `git rm` de esos 4 archivos/carpetas ajenos (o un rebase interactivo que retire esas líneas de `c7d88c4`), dejando el fix-pack con SOLO lo que su propio mensaje describe. No requiere tocar código ni re-correr gates (son archivos de texto fuera de `src/`).

- **Wave order**: commits siguen W0→W1→W2→W3→W4 + fix-pack en orden, sin arrastre cruzado salvo el hallazgo de arriba.

---

## Resumen (para el orquestador)

1. Las 7 ACs pasan con evidencia archivo:línea, todas corridas por mí en este entorno (57/57 en los 4 archivos de clamp).
2. Gates verdes, corridos por mí, no reciclados: vitest 5020/19/244 archivos, tsc 0, lint 442 archivos sin fixes, migrate-preflight PASS en los 2 `.sql`.
3. Mitad 2: MA1, MA2 y MA3 mueren los tres — `BLQ-BAJO-2` del AR queda cerrado con evidencia de mutación propia, no reciclada.
4. Intenté falsificar la prosa reescrita de `discovery-fetch-limit.ts:32-46` con 3 inputs distintos (cursor ausente, cursor falsy-no-null, y releyendo la máquina de estados completa) y no encontré ninguno que la rompa — `BLQ-BAJO-1` cerrado.
5. CD-3 (byte-idéntico sin la migración, logs incluidos) se sostiene: las dos ramas nuevas de log están gateadas detrás de condiciones que hoy son falsas en prod (`maxLimit` no está en la DB), confirmado estáticamente + por test. No pude repetir el diferencial de 126 combinaciones contra la DB real (bloqueado por el entorno) — marcado NO VERIFICABLE puntual, compensado con verificación contra el endpoint público real y el argumento estático.
6. Ningún texto de la rama afirma que esto arregla producción; la migración está explícitamente sin aplicar.
7. **Único hallazgo que bloquea**: el commit `c7d88c4` de este mismo fix-pack arrastró ~2100 líneas de otras 3 HUs (WKH-SEC-02B, WKH-314, WKH-316) que NO están en `main` y que tienen sus propios worktrees dedicados. Es limpieza de un commit, no un problema de diseño ni de las ACs — pero mergear así publica trabajo ajeno sin pipeline. Recomiendo una limpieza puntual (retirar esos 4 archivos/carpetas de la rama) antes de mergear/pushear.

**No avanzar a DONE hasta que el drift de `c7d88c4` se limpie.** El resto del trabajo (clamp, tests, migración, prosa) está listo.
