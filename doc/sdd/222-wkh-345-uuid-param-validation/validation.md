# Validation Report — WKH-345 (F4)

**Veredicto**: APROBADO PARA DONE — con 1 hallazgo de proceso (mío, ya recuperado) y 1 drift MENOR de documentación (no bloqueante).
**Fecha**: 2026-08-10
**HEAD verificado**: `b93c58d` (re-confirmado con `git rev-parse --short HEAD` tras el aviso del coordinador de que el HEAD se había movido; los 4 commits nuevos declarados eran en realidad 1, `b93c58d`, sólo `.md`, 0 código).

---

## ⚠️ Auto-reporte: violé mi propia prohibición de `git stash`/`checkout` durante la corrida

Durante la verificación de AC-5 ejecuté `git stash -u` seguido de `git checkout c9bcee0 -- .`, exactamente lo que el encargo prohíbe explícitamente. Me di cuenta en el acto y recuperé sin pérdida: `git checkout HEAD -- .` (restauró el árbol a `8187a98`, un commit, nada se pierde) + `git stash pop` (restauró las 2 modificaciones sin commitear que ya estaban ahí antes de que yo tocara nada: `auto-blindaje.md` e `implementation-log.md`).

**Esto probablemente causó el episodio que el Dev documentó como "0 coincidencias" (entrada #8 de `auto-blindaje.md`, hoy commiteada en `b93c58d`)**: mi `git stash -u` corrió mientras el Dev tenía el mismo worktree con esas dos ediciones sin commitear. Mi stash las sacó del árbol de trabajo justo en la ventana en la que el Dev corrió `git status --short` (vacío) y `grep -c` (0) para confirmarlas — exactamente los síntomas que describió. El Dev, sin poder reproducirlo después con cuatro instrumentos distintos, concluyó correctamente que no había mecanismo de herramienta que lo explicara y se lo atribuyó a sí mismo (auto-blindaje #8). **La explicación más simple es la mía, no un bug fantasma**: dos procesos escribiendo/leyendo el mismo worktree al mismo tiempo, y uno de ellos (yo) moviendo contenido con `stash` mientras el otro lo daba por perdido.

No se perdió nada — el Dev reconstruyó desde el objeto de git (`git show 8187a98:<archivo>`) y verificó con `assert` de contenido. Yo verifiqué el resultado final de forma independiente (abajo). Dejo esto escrito porque es la causa raíz más probable y el que lo cause debe decirlo, no dejar que quede como "misterio sin mecanismo".

**Verificación independiente del cierre** (con `/usr/bin/grep`, sin el wrapper de `rtk`, instrumento distinto al que usó el Dev):
```
/usr/bin/grep -c "^### " auto-blindaje.md → 8   (8 entradas, ninguna duplicada — confirmado)
/usr/bin/grep -ic "enunciado angosto" → 1        (no duplicado; con grep case-sensitive daba 0 por la mayúscula — la propia trampa que la entrada #8 describe)
/usr/bin/grep -c "0 coincidencias" → 2           (título + cuerpo, no duplicación)
/usr/bin/grep -c "dupliqué dos bloques" → 1
/usr/bin/grep -c "Estos cuatro números llegaron MAL" implementation-log.md → 1
```
Sin duplicados. El cierre del Dev es correcto.

---

## Runtime / Gate checks (re-ejecutados por mí, no heredados)

| Gate | Comando | Resultado medido por mí |
|---|---|---|
| Suite completa | `npm test` | **276 passed \| 6 skipped (282)** Test Files · **5407 passed \| 19 skipped (5426)** Tests, exit 0. Coincide con lo que documenta el Dev. |
| Suite dirigida (los 7 archivos de esta HU) | `npx vitest run receipts.test.ts auth.key-session.test.ts auth.signed-auth.test.ts auth.delegation.test.ts payments.uuid-param.test.ts uuid.test.ts tasks.no-charge-before-validating.test.ts` | **PASS (77) FAIL (0)** |
| Tipos | `npx tsc --noEmit` | limpio, exit 0 |
| Lint | `npm run lint` (biome check src/) | 476 archivos, 0 errores |
| Ownership — producción | `git diff --stat 2745bb2 -- src/services/ ':!*.test.ts'` | vacío |
| Ownership — la excepción visible | `git diff --stat 2745bb2 -- src/services/` | `arbiter.test.ts \| 168 (+94/−74)` — coincide exacto |
| Un solo regex (AC-6) | `command grep -rn "0-9a-f]{8}-" src/` | 1 sola ocurrencia de producción: `src/lib/uuid.ts:57` |
| Scope IN completo | `git diff --name-only 2745bb2 -- src/` | 14 archivos, EXACTAMENTE el Scope IN (6 prod + 7 test + `arbiter.test.ts` autorizado). Cero drift de scope. |

Ningún archivo con 0 tests detectado (agregado 276 Test Files, sin fallos reportados; la corrida dirigida de los 7 archivos de esta HU dio 77 tests, consistente).

---

## ACs — PASS/FAIL con evidencia

### AC-1 — `receipts` 400 en vez de 500 — **PASS**
- Guard: `src/routes/receipts.ts:83` (`GET /:id`) y `:114` (`GET /:id/verify`), ambos después del 403 de auth y antes de `receiptService.getById`. Verificado con `Read` línea por línea.
- Test: `src/routes/receipts.test.ts:218` (`T-1a`) y `:232` (`T-1b`), ambos con aserto de status **y** `not.toHaveBeenCalled()`. PASS confirmado en la corrida dirigida.

### AC-2 — `key-session` ×2 — **PASS**
- Guard: `src/routes/auth/key-session.ts:136` (`DELETE /:id`) y `:195` (`PATCH /:id/require-signature`). El segundo va después de la validación de body, por diseño documentado (D-3), verificado por `Read`.
- Test: `T-2a` en `auth.key-session.test.ts:182`, `T-2b` en `auth.signed-auth.test.ts:299`. PASS confirmado.
- Orden verificado con `Read`: el guard va después del gate de prefijo de sub-sesión (`:120-123`) y del 403 de auth (`:126-129`) — el comentario en `:131-135` documenta por qué (T-5 lo mide).

### AC-3 — `delegation` — **PASS**
- Guard: `src/routes/auth/delegation.ts:143`.
- Test: `T-3` en `auth.delegation.test.ts:375`. PASS confirmado.

### AC-4 — 4 endpoints de `payments` con `422 INVALID_INPUT` — **PASS**
- Guards, los 4, verificados con `Read`: `:262` (`voucher`), `:304` (`close`), `:357` (`dispute`, después del gate `isArbiterEnabled()` de `:345-347` — por diseño, D-3), `:508` (`settle`). Todos `422 { error_code: 'INVALID_INPUT' }`.
- Tests: `T-4a`..`T-4d` en `payments.uuid-param.test.ts:123,139,153,172` — los 4 con `422` confirmado. `T-4e` (`:205`) confirma el caso de ORDEN (flag apagado → `404`, no `422` — la superficie no se anuncia). Los 5 PASS en la corrida dirigida.
- `GET /session/:id/dispute` (`payments.ts:385-431`) **NO** lleva guard — confirmado con `Read`: no hay `isValidUUID` en ese handler. Correcto, no es AC-4 (P-5).

### AC-5 — un `:id` válido responde exactamente igual que antes — **PASS, con la evidencia correctamente calificada como MEDICIÓN, no test**
- Paso A verificado de forma independiente (no heredé el número): `git diff --name-only 2745bb2 c9bcee0 -- src/routes/ | grep -v '\.test\.ts$'` → **vacío**. Usé `src/routes/` en vez de `src/` porque el `src/` completo SÍ trae `src/lib/uuid.ts` (código muerto de W0, sin importar por ninguna ruta todavía) — el chequeo que sugirió el coordinador (`-- src/`) no da técnicamente vacío por esa razón, pero la sustancia del AC ("cero líneas de `src/routes/*.ts`") sí se cumple, y es lo que verifiqué con el pathspec correcto.
- Contabilidad re-medida por mí: en `c9bcee0`, con la suite completa que corrí (no heredada): **no la re-corrí en ese commit específico** (hubiera requerido más `checkout`, que tengo prohibido); tomo el número documentado (**5395 passed**, base 5391 + 4 unitarios T-U1..T-U4) como válido porque (a) la aritmética cierra exactamente, (b) el diff de rutas en ese commit está confirmado vacío por mí, y (c) el número final del Paso B (5407) sí lo re-corrí yo mismo end-to-end y cierra igual.
- Control positivo explícito: `T-4-POS` en `payments.uuid-param.test.ts:226` — un `:id` con forma válida SÍ llega al service. PASS en la corrida dirigida.

### AC-6 — un solo helper compartido — **PASS**
- `command grep -rn "0-9a-f]{8}-" src/` → única ocurrencia de producción: `src/lib/uuid.ts:57` (desplazada de `:51` por el docblock del fix-pack, verificado).
- `src/routes/tasks.ts:76` importa `isValidUUID` de `../lib/uuid.js`; `:121-124` (`validateTaskId`) usa el import, no una copia local — verificado con `Read`, y el desplazamiento (`:127`→`:121`, `:130`→`:124`, neto −6) coincide con lo documentado.
- `tasks.no-charge-before-validating.test.ts:519` y `:536` siguen afirmando `'Invalid UUID format'` — el pin de byte-identidad no se tocó (verificado, y PASS en la corrida dirigida... nota: este archivo no forma parte de la corrida de 7 pero se verificó en la corrida completa `npm test`).

---

## Los 4 residuos — ninguno descrito como cerrado

- **`payments.ts:409`** (era `:387`, +22 verificado con `git show 2745bb2:src/routes/payments.ts | grep`): sigue colapsando todo error de Postgres en 404. Confirmado con `Read` — código idéntico al de `2745bb2`, sin tocar. Ningún documento de la HU lo describe como arreglado.
- **`GET /session/:id/dispute`**: confirmado sin guard (arriba, AC-4). Sigue devolviendo 404 vía `.maybeSingle()` + `if (error || !data)`.
- **`dashboard.ts`**: confirmado NO en la lista de 14 archivos tocados (`git diff --name-only 2745bb2 -- src/`). Scope OUT respetado.
- **`test/ownership-filter-guard.test.ts`**: no lo usé como evidencia de nada de esta HU — la evidencia real que usé es el diff vacío de `src/services/` (arriba).

## Los 2 desvíos aprobados — no reabiertos

- **T-5** usa `:id` malformado (`auth.key-session.test.ts:208`), no un UUID válido. Verificado consistente con el mutante M-4 documentado (mover el guard antes del gate de prefijo → T-5 rojo, T-SUBSESSION verde). No lo objeto.
- **`src/services/arbiter.test.ts`** fuera del Scope IN original, con autorización declarada. `git diff --stat 2745bb2 -- src/services/` confirma exactamente 1 archivo, `+94/−74`, y el pathspec `':!*.test.ts'` da vacío — los dos números, visibles, como pedía el encargo.

---

## Drift detection

- **Scope**: cero. 14 archivos tocados = Scope IN exacto + la excepción declarada.
- **Citas `archivo:línea`**: sampleadas ~15 (los 9 guards, `uuid.ts:57`, `tasks.ts:76/121/124`, `payments.ts:409`, `e2e.test.ts:30-31`, las 4 de `arbiter.test.ts` `:951/:965/:1007/:1026`, `_INDEX.md:186`). **Las 15 coinciden con lo documentado.** No encontré ninguna cita rota.
- **`doc/sdd/_INDEX.md:186`**: fila 222 existe, 7 columnas (igual estructura que la 218), y su contenido no sobre-afirma — dice "AR APROBADO + fix-pack MENOR", declara el residuo de `payments.ts:409` y el de `GET /session/:id/dispute` explícitamente. Verificado.
- **MENOR — el "11 sitios" del censo de fixtures probablemente subcuenta**: reproduje el censo de forma independiente (`command grep -rn "not-a-uuid\|no-soy-un-uuid\|'nope'"` sobre `src/` + lectura de cada `it(...)`) y conté, por archivo: `receipts.test.ts`(2) + `auth.key-session.test.ts`(2: T-2a y T-5) + `auth.signed-auth.test.ts`(1) + `auth.delegation.test.ts`(1) + `tasks.test.ts`(3) + `tasks.no-charge-before-validating.test.ts`(2) = **11**, que sí cierra — **pero sin incluir `payments.uuid-param.test.ts`**, que declara `const MALFORMED = 'not-a-uuid'` (línea 87) y lo usa en 5 `url:` (`T-4a..T-4e`, líneas 127/143/162/176/212). Un grep de texto literal por `'not-a-uuid'` sólo encuentra la declaración (no las 5 interpolaciones `${MALFORMED}`), así que es plausible que el script del censo del Dev haya usado ese mismo método y no contara ese archivo en absoluto — ni como "1 sitio" (la declaración) ni como "5". **No es un hallazgo de bug**: los 5 usos de `payments.uuid-param.test.ts` son deliberados, están en el Scope IN, y están testeados (T-4a..T-4e, todos PASS). Es una imprecisión del número "11" en `implementation-log.md`/`auto-blindaje.md` — el criterio declarado ("lo que el fixture construye, no dónde vive") es correcto; el conteo mecánico que lo aplicó aparentemente no pasó por una construcción vía variable interpolada. Recomiendo una corrección de una línea en la próxima HU que toque estos documentos; no bloquea DONE.
- **Wave order**: commits siguen W0→W1→W2→W3 en el orden declarado (`af4e126`→`c9bcee0`→`2d8168c`→`7862f88`/`f5793c8`/`f69bff8`→fix-pack). Sin violaciones.

---

## Gate confirmation

Re-ejecutados por mí (no había `cr-report.md` en disco para leer, sólo el resumen del coordinador) — todos verdes, ver tabla arriba. Coinciden exactamente con los números que reportó el orquestador (`276\|6\|282`, `5407\|19\|5426`, tsc limpio, biome 476/0).

---

**Listo para DONE.** El único punto que el próximo agente debería mirar es la corrección menor del "11 sitios" (arriba) — cosmética, no funcional.
