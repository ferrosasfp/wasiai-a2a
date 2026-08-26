# Validation Report — HU WKH-365 (228, tablero de las tres preguntas)

**Fecha**: 2026-08-25 (fin de sesión, HEAD el 2026-08-25 23:46) · **Worktree**: `/home/ferdev/.openclaw/workspace/a2a-tablero`
**Rama**: `feat/228-tablero-tres-preguntas` · **HEAD auditado**: `4e08e93b3cacd940639b0f6a0c8836e6b7b31cfe` (árbol limpio, `git status --short` sin salida)
**Contrato**: `doc/sdd/228-tablero-tres-preguntas/story-file.md`

⚠️ **Nada de esto está desplegado ni mergeado.** Vive en una rama local, 3 commits adelante de `origin/main`. Este reporte describe lo que el código hace **en el worktree**, no el estado del ecosistema en producción.

---

## Veredicto

## **APROBADO PARA DONE**

Gate del repo re-ejecutado por F4 al completo sobre el HEAD final (nadie lo había corrido sobre `4e08e93`: el CR declaró explícitamente que no corre gates, y el AR de la it3 corrió sobre `bcba4f5`, el commit anterior). Los 9 ACs tienen evidencia ejecutada — test citado y, en el AC central, una reproducción propia con 5 entradas hostiles nuevas. El único hallazgo de proceso (edición de `test/ownership-filter-guard.exceptions.ts`, fuera del Scope IN declarado) es una reparación de citas forzada por el propio diff de `dashboard.ts`, declarada por escrito, medida como línea-neutra, y verificada por mí símbolo por símbolo (no sólo leída del reporte).

---

## 0 · El gate, corrido por F4 sobre el HEAD final

Ni CR ni el AR de la it3 lo corrieron sobre `4e08e93`. Re-ejecutado acá, completo y en orden:

| # | Comando | Resultado |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | ✅ exit 0 — `TypeScript compilation completed` |
| 2 | `npm run lint` (`biome check src/`) | ✅ exit 0 — `Checked 516 files in 200ms. No fixes applied.` |
| 3 | `npm test` (`vitest run`) | ✅ exit 0 — `Test Files 310 passed \| 6 skipped (316)` · `Tests 6258 passed \| 19 skipped (6277)` |

`npm run qa` no existe en este repo (confirmado en `package.json`, sección `scripts`). Los tres números que los README publican (316/516/192) los deriva `test/readme-numbers.test.ts` en cada corrida; el gate verde los cubre.

---

## 1 · Runtime checks propios (lo que sólo F4 puede ver)

### 1.1 — El AC central: reproducción propia con entradas hostiles

No leí el render — lo **corrí**. Arnés fuera del repo (`/tmp/.../scratchpad/wkh365-qa/hostile.mjs`, borrado tras usarlo), que extrae el `<script>` inline de `src/static/dashboard-tres-preguntas.html` con `new Function(document, window, fetch)`, sin tocar el repo.

| Caso propio | Input | Salida real | Verdicto |
|---|---|---|---|
| QA-1 | Las tres tarjetas como `{}` (ni siquiera `status`) | `panel classNames: ['panel sin-dato','panel sin-dato','panel sin-dato']` | ✅ nunca verde por ausencia total |
| QA-2 | `caja.status = { toString: () => 'ok' }` (objeto que castea a la palabra "ok") | `caja className: panel sin-dato` | ✅ el switch compara por igualdad estricta, no coerción |
| QA-3 | `reputacion.status:'ok'` con 50 agentes, **sin** `agentes_omitidos` ni `lectura_truncada` (simula un deploy rodante, el caso que MNR-2/it3 fijó) | `contains "no dice": true` · `class="aviso": false` (va al lado gris, no al amarillo) · `className: panel ok` | ✅ no colapsa "ausente" con "cero"; distinto del caso de tope real |
| QA-4 | `caja.status:'ok'` con las 4 columnas nullable en `null` (el caso original de `BLQ-BAJO-1`) | `has <span></span> vacío: false`; celdas dicen `"sin dato · la fila viene en NULL"`; `is_active:null` dispara advertencia | ✅ regresión de B-2 no reaparece |
| QA-5 | `motivoTexto('constructor')` (ataque a `Object.prototype`) | `"motivo desconocido"` (no `function Object() {...}`) | ✅ M-5 (fix-pack 1) sostiene |

Script: `/tmp/claude-1000/.../scratchpad/wkh365-qa/hostile.mjs` (efímero, no versionado). Los 5 casos corrieron contra el HTML real del repo, no contra una copia.

### 1.2 — Ownership: el falso `.eq` obligatorio, confirmado en la fuente

`src/services/tablero.ts:97-102`:
```
.from('a2a_agent_keys')
.select(...)
.eq('id', keyId)
.eq('owner_ref', ownerRef)
```
Ambos filtros presentes. `src/services/tablero.test.ts:274` (`la cadena lleva .eq(id) Y .eq(owner_ref)`) es el test que lo fija con un doble en cadena que **aplica** los filtros (no los ignora) — confirmado leyendo el mismo archivo: dos filas con mismo `id` y distinto `owner_ref`, y sacar cualquiera de los dos `.eq` pone rojo el caso feliz (medido por AR it1 con mutación, `M1`/`M2` KILLED — no re-ejecuté la mutación, leo la evidencia del AR).

### 1.3 — Que NO compra

`grep -n "fetch(" src/adapters/solana/escrow-scan.ts src/services/tablero.ts` → **un único resultado**: `escrow-scan.ts:206`, el `fetch` JSON-RPC de lectura contra Solana. `grep -n "composeService|orchestrate" src/services/tablero.ts src/adapters/solana/escrow-scan.ts` → **cero resultados**. Confirmado en la fuente, no en un reporte ajeno.

### 1.4 — Env parity (Railway) — degradación esperada, no bloqueante

`A2A_PROBE_KEY_ID`, `A2A_PROBE_KEY_OWNER_REF`, `SOLANA_RPC_URL`, `DASHBOARD_ADMIN_TOKEN` **no** están seteadas en este entorno de verificación (`printenv | grep` → vacío) ni hay `.env.local` en el worktree. Están documentadas en `.env.example:1605,1610,1617` y `:36`. Por diseño (DT-3/DT-4, verificado en `src/services/tablero.test.ts:331-368` y `src/adapters/solana/escrow-scan.test.ts`), su ausencia degrada cada tarjeta a `sin_dato:no_configurado` / `sin_dato:rpc_no_configurado`, **nunca** a `ok`. No es un defecto de esta HU — es el comportamiento correcto documentado y es responsabilidad del founder en Railway, fuera del Scope IN.

### 1.5 — DB / migraciones

Sin `.sql` en el diff (`git diff --stat` no muestra `migrations/`). La HU es de solo lectura sobre tablas existentes (`a2a_agent_keys`, `a2a_events`) y el RPC de Solana; no hay schema nuevo que verificar contra el servidor remoto.

---

## 2 · ACs

| AC | Texto (resumen) | Status | Evidencia |
|---|---|---|---|
| AC-1 | Saldo de la sonda leído "en esa misma corrida" | ✅ PASS | `src/services/tablero.ts:97-102` (lectura en proceso, DT-3 aprobado en `sdd.md:43-63`) + `tablero.test.ts:260` (control positivo). **AC-1 vs `GET /auth/me` NO es drift**: aprobado en SDD, anotado explícitamente para F4 en `ar-report.md:435-437`. |
| AC-2 | Fallo de lectura → "sin dato", nunca saludable | ✅ PASS | `tablero.test.ts:331` (`no_configurado`, falta `A2A_PROBE_KEY_ID`), `:341` (falta `OWNER_REF`), `:350` (`PGRST116` → `no_encontrada`), `:359` (`error_db`) |
| AC-3 | Reputación vía `computeStandingBatch`, cero cotización | ✅ PASS | `tablero.test.ts:372` (se delega, sin red saliente) + `:390` (guard estructural: el fuente no nombra `composeService`/`orchestrate`) + confirmado por grep propio (§1.3) |
| AC-4 | `degraded:true` → "sin dato", nunca "cero reputación" | ✅ PASS | `tablero.test.ts:407` (`degraded:true` → `historial_ilegible`) + `:419` (control positivo: `degraded:false` + 0 slugs → `ok` con `agentes:[]`) — los dos casos no colapsan (`:430`) |
| AC-5 | Escrows vía RPC, conteo/balance DERIVADOS, nunca hardcodeados | ✅ PASS | `escrow-scan.test.ts:255` (T-ESC-1, tres cuentas → tres desenlaces, valores derivados del mismo `ESCENARIO`) + `:210` (discriminador recomputado con sha256) + `:220` (dataSize 154 + memcmp) |
| AC-6 | RPC falla/429/timeout → "sin dato", nunca "cero escrows" | ✅ PASS | `escrow-scan.test.ts:328` (429), `:345` (timeout/`AbortError`), `:366` (error JSON-RPC) — los tres afirman que `escrows_vivos` **no existe** en la respuesta |
| AC-7 | Solo lectura, cero gasto en ninguna tarjeta | ✅ PASS | `dashboard.tablero.test.ts:281` (T-RO-1: POST/PUT/PATCH/DELETE → 404, ningún handler escribe) + `render.test.ts:609` (T-UI-2: un solo endpoint en los `fetch` del HTML) + §1.3 (grep propio) |
| AC-8 | Sin token / sin `DASHBOARD_ADMIN_TOKEN` → fail-closed | ✅ PASS | `dashboard.tablero.test.ts:132` (T-GATE-1, sin token configurado → 503 en dev y prod, service intacto) + `:174` (T-GATE-2, token incorrecto → 401) + `:217` (control positivo: token correcto → 200) |
| AC-9 | Las tres fuentes fallan → 200 igual, las tres en "sin dato" | ✅ PASS | `tablero.test.ts:596` (T-SNAP-1: las tres lanzan → snapshot resuelve con las tres `sin_dato`, `Promise.allSettled`) + `:612` (T-SNAP-2: una falla, las otras dos siguen `ok`) |
| CD-5 (no exponer credencial) | — | ✅ PASS | `tablero.test.ts:649` (en ningún estado el JSON trae `id`/hash de la key) |
| CD-14 (sin campo agregado de salud) | — | ✅ PASS | `tablero.test.ts:674` (la raíz no tiene ningún campo booleano de salud) |
| XSS (CD-4/CD-10) | — | ✅ PASS | `render.test.ts:548-603` (T-UI-XSS: slug hostil `<img src=x onerror=alert(1)>` no aparece verbatim, sale escapado `&lt;img...&gt;`) + reproducción propia QA-1/QA-2 (§1.1) |

**Los 9 ACs + las 3 CDs con test dedicado: PASS con evidencia ejecutada (test citado o corrida propia).**

---

## 3 · Drift

- **Scope**: `git diff --stat origin/main...HEAD -- . ':!doc/'` → 13 archivos. Coinciden exactamente con los 13 del Scope IN del Story File §2 (incluidos los dos README, con los 3 números re-derivados por el propio gate), **más uno no declarado**: `test/ownership-filter-guard.exceptions.ts` (+24/−18 líneas).
- **Ese archivo está en Scope OUT explícito** (Story File §2 y CD-9: "PROHIBIDO tocar"). **No es scope creep silencioso**: el fix-pack 2 editó `dashboard.ts` (+167 líneas) y eso desplazó las 11 citas `dashboard.ts:N` que ya vivían en `exceptions.ts` desde antes de esta HU (archivo de seguridad que documenta por qué 11 lecturas cross-tenant no llevan filtro de owner). El fix-pack 2 las re-ancló; el AR de la it3 encontró 2 de las 11 mal re-ancladas (off-by-one) y lo marcó `BLQ-BAJO-1`; el fix-pack 3 (commit actual) las corrigió las 10 (no sólo las 2 señaladas). **Verifiqué las 10 citas yo mismo** contra el `dashboard.ts` real (líneas 440, 591, 644, 684, 765, 797, 847, 909, más el rango 682-684 y el docblock 307-316) — las 10 apuntan exactamente a la línea del `preHandler` (el control compensatorio que la excepción justifica), la convención declarada. Diff completo de `exceptions.ts` inspeccionado: **son sólo números de línea, ningún cambio de lógica, ninguna excepción nueva agregada, ningún `reason` reescrito más allá del número**.
- Sin este archivo, el diff sería exactamente el Scope IN declarado. Con él, es una consecuencia forzada y disclosed de tocar `dashboard.ts` (que sí está en scope), no una desviación de intención.
- **Waves**: `auto-blindaje.md` documenta el orden W0→W1→W2→W3 y los tres fix-packs post-AR/CR con sus propios mutantes; no hay evidencia de wave violation (contratos de tipos en W0 antes que los adaptadores W1, cableado en W2 después).
- **Presupuesto de diff**: 2,30x contra el techo de 2x (declarado, medido, con el reparto 32 líneas de código / 82 de prosa en el último fix-pack — ver `auto-blindaje.md`, sección "Fix-pack 3"). Excede el techo declarado en el SDD, **pero está justificado por escrito** con el reparto medido, tal como exige CD-13. No lo re-abro como defecto: es exactamente el caso que la instrucción de esta tarea pide no reabrir.

---

## 4 · AR/CR follow-up

- **AR ×3** (`ar-report.md`: RECHAZADO, 2 BLQ + 4 MNR → fix-pack 1; `ar-report-it2.md`: RECHAZADO, 3 BLQ + 2 MNR → fix-pack 2; `ar-report-it3.md`: RECHAZADO, 1 BLQ-BAJO + 2 MNR → fix-pack 3, commit `4e08e93`).
- **No existe un `ar-report-it4.md`** que confirme el fix-pack 3 formalmente. Por eso F4 verificó el fix-pack 3 de forma independiente (no se limitó a leer `auto-blindaje.md`): re-corrí el gate completo sobre `4e08e93` (§0) y re-derivé a mano las 10 citas re-ancladas de `exceptions.ts` contra el `dashboard.ts` real (§3), además de las dos correcciones puntuales de MNR-1/MNR-2 de la it3 (docblock del TTL sin la razón falsa, `dashboard.ts:380-391`; el default gris en vez de `0`/`false` para los campos de techo ausentes, `dashboard-tres-preguntas.html:248-262` — confirmado con la reproducción propia QA-3).
- **CR** (`cr-report.md`): APROBADO, 0 BLOQUEANTEs, 6 MENORes (`MNR-1`..`MNR-6`), todos resueltos en los fix-packs 1/2/3 según el cruce de `auto-blindaje.md` (excepto `MNR-1` del CR — rename de `SinDatoReason` — y `MNR-4` del AR sobre `vi.unstubAllGlobals()`, explícitamente diferidos a backlog con su razón escrita, sin comportamiento detrás).
- Ningún BLQ queda abierto contra el HEAD auditado.

---

## 5 · Lo que NO se verificó (y por qué no bloquea)

- Estado real de las tres tarjetas contra Railway/producción: **no aplica** — nada está desplegado (ver advertencia al inicio).
- Mutación propia sobre el ownership guard y los offsets del escrow: no re-corrida por F4 (ya está medida por AR it1 con 20/20 muertos y re-confirmada estructuralmente en §1.2/§1.3); re-ejecutar mutación es responsabilidad de AR, no de F4.
- Contenido exacto de `A2A_PROBE_KEY_ID`/`OWNER_REF` en Railway: fuera de alcance de este worktree (acción del founder, `sdd.md` §8 ítems 5-6, no bloquea merge).

---

**Listo para DONE.**
