# Validation Report — WKH-335 (#226) — El Coordinador tiene el status HTTP del agente y no lo dice

**Agente**: `nexus-qa` (F4) · **Fecha**: 2026-08-25
**Repos**: `wasiai-a2a` (worktree `a2a-wkh362`, rama `feat/wkh-335-status-estructurado`, HEAD `94603b0`) ·
`chaski-v3` (worktree `chaski-wkh362`, rama `feat/wkh-335-error-no-opaco`, HEAD `f3e6834`)

**Veredicto**: **APROBADO PARA DONE**, con una precondición humana pendiente (AC-10, no ejecutable por
un agente) y una nota de proceso sobre el CR (ver abajo).

---

## 0 — Nota de proceso: el estado del CR en disco está desactualizado, verificado directamente

`cr-report.md` (committeado en `ffeee10`, ronda 1) dice **RECHAZADO — 1 BLOQUEANTE-BAJO** +
4 MENORes. No hay un segundo `cr-report.md` que confirme verde después de los fix-packs. En vez de
inferir "probablemente se arregló", verifiqué cada hallazgo del CR directamente contra el código de
HEAD:

| Hallazgo CR | Estado verificado en HEAD | Evidencia |
|---|---|---|
| `BLQ-BAJO-1` (`doc/INTEGRATION.md:1043`, afirmaba `/orchestrate` responde 400 top-level) | **RESUELTO** | `doc/INTEGRATION.md:1043` hoy distingue explícitamente `400` top-level para `/compose` vs `200`/`pipeline.agentFailure` (anidado) para `/orchestrate`. Fix en commit `1f86e3d`. |
| `MNR-2` (`⟺` falso en `src/types/index.ts:1276`) | **RESUELTO** | `src/types/index.ts:1276-1279` hoy usa `⇒` y documenta explícitamente el contraejemplo del retry (`422 → regen → ECONNRESET`). |
| `MNR-4` (doble evaluación de `readAgentFailure` en `gateway-client.ts:376-378`) | **RESUELTO** | Hoy usa `const agentFailure = readAgentFailure(parsed.agentFailure)` antes del spread, mismo patrón que `:264`. |
| `MNR-3` (5 asserts de `T-335-NOLEAK` no pueden fallar) | **NO tocado, aceptado como está** | `compose.test.ts:3220-3227` sigue igual. Es MENOR, no bloqueante — ver AC-3 abajo, que no se apoya en este test. |
| `MNR-1` (reparto del exceso del diff no documentado por escrito) | **Informativo, sin acción requerida** | No afecta el veredicto. |

Las 3 iteraciones de AR (`ar-report.md`, `ar-report-it2.md`, `ar-report-it3.md`, todas RECHAZADO en su
momento) también quedaron resueltas por los fix-packs subsiguientes (`1f86e3d`, `0095af9`, `94603b0`),
verificado leyendo los commits y el estado actual de los archivos que citan (ver Drift, abajo).

**Conclusión de esta sección**: el único bloqueante formal que quedó documentado en disco (BLQ-BAJO-1
del CR) está resuelto en el código que corre. No hay hallazgos abiertos sin resolver.

---

## 1 — Runtime check: el defecto extremo a extremo, medido en producción (sin desplegar nada)

```
POST https://chaski-v2.vercel.app/api/a2a/quote  {"amountUsd":10,"destCountry":"PE","payoutMethod":"yape"}
→ HTTP 200 {"result":{"slug":"remit-corridor-fx","rate":3.268063,...}}   ← pipeline SANO

POST https://chaski-v2.vercel.app/api/a2a/quote  {"amountUsd":10,"destCountry":"PE","payoutMethod":"bank"}
→ HTTP 502 {"error":"a2a_unavailable"}                                   ← EL DEFECTO, todavía vivo
```

Confirma exactamente lo que el work-item mide como causa raíz: el pipeline funciona (200 con tasa
real cuando el input es válido) y el único roto es que un rechazo por input del agente (`bank` no es
un enum válido de `payoutMethod`) sale idéntico a una caída real. **Esto seguirá dando 502 hasta que
se despliegue** — el fix vive en las dos ramas, no en prod. No se desplegó nada durante esta
verificación (sólo lectura vía `curl`).

## 2 — AC-5 / CD-4: protocolo rojo-antes / verde-después

Verificado leyendo `evidencia-rojo-antes.md` y `evidencia-verde-despues.md` (no re-ejecutado — son
snapshots del mismo comando, y re-correrlo hoy sólo repetiría el verde, no reproduciría el árbol
pre-cableado sin revertir código):

- **El rojo es la aserción, no un import roto**: los 5 fallos son `AssertionError: expected undefined
  to be '<valor>'`; `tsc --noEmit` daba exit 0 en ese mismo estado (documentado en el propio archivo).
- **Conteo de tests recolectados coincide**: rojo `5 failed | 107 passed (112)`, verde `112 passed
  (112)`. Mismo total en las dos corridas ⇒ ningún testigo dejó de recolectarse.
- **CD-6 medido, no leído**: dos mutantes (borrar sólo el spread del retry, borrar sólo el del
  directo) matan conjuntos disjuntos de tests (`T-335-RETRY*` vs `T-335-DIRECT*`/`NOLEAK`),
  confirmando que son dos sitios de código independientes, no uno solo cableado por casualidad.

## 3 — Gates: CORRIDOS por mí, completos, en orden, una vez (no delegados)

**`wasiai-a2a`** (secuencia de `.github/workflows/ci.yml`; `npm run qa` NO existe en este repo):

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | exit **0** |
| 2 | `npm run lint` (`biome check src/`) | `Checked 503 files in 177ms. No fixes applied.` · exit **0** |
| 3 | `npm test` (`vitest run`) | `Test Files 298 passed \| 6 skipped (304)` · `Tests 5961 passed \| 19 skipped (5980)` · exit **0** |

**`chaski-v3`**:

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `npm run qa` (`lint && typecheck && typecheck:scripts && test`) | `Test Files 154 passed (154)` · `Tests 3060 passed (3060)` · exit **0** (confirmado leyendo el log completo, no sólo el exit code — el stderr de `jsdom`/MWA tapa las líneas de resumen en el `tail`, igual que la advertencia del orquestador) |
| 2 | `npm run build` (`next build --webpack`) | exit **0** (warnings pre-existentes de `node_modules` sin relación a esta HU) |

Ambos árboles estaban limpios y commiteados antes de correr (`git status --porcelain` vacío), así que
no aplica el riesgo de "archivo untracked invisible para los guards".

## 4 — ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (camino directo) | ✅ PASS | `src/services/compose.ts:1220` `...agentFailureResult(err)`. Tests: `compose.test.ts` `T-335-DIRECT-4XX`, `T-335-DIRECT-5XX` (verde-despues.md, 112 passed). |
| AC-2 (camino con retry) | ✅ PASS | `src/services/compose.ts:1184` `...agentFailureResult(retryErr)` — sitio distinto de AC-1, confirmado disjunto por mutación (§2). Tests: `T-335-RETRY`, `T-335-RETRY-5XX`. |
| AC-3 (no leak) | ✅ PASS — **por tipo, no por `T-335-NOLEAK`** | `src/types/index.ts` declara `agentFailure?: AgentFailureKind` como unión cerrada (`'INPUT_REJECTED' \| 'AGENT_ERROR'`); `src/lib/agent-http-error.ts:174-176` (`classifyAgentFailure`) es pura y total, deriva el valor únicamente de `status: number`, nunca toca `invokeUrl` ni el body del agente. El tipo garantiza la ausencia de fuga con más fuerza que un test — no cito `T-335-NOLEAK` como evidencia independiente: CR/MNR-3 (confirmado vigente en `compose.test.ts:3220-3227`) mide que 5 de sus 6 asserts no pueden fallar (el sujeto ya es el literal `'INPUT_REJECTED'` fijado por el `toBe` anterior). |
| AC-4 (aditivo / back-compat) | ✅ PASS | `T-335-BACKCOMPAT` (`compose.test.ts`): pipeline 2xx no estrena la clave `agentFailure`. Del lado Chaski, `T-335-Q-3`/`T-335-P-3` (`quote/route.test.ts:378`, `prepare/route.test.ts:1214`) prueban que un gateway sin el campo (orden de despliegue invertido) sigue dando 502 byte-idéntico a hoy. |
| AC-5 / CD-4 (control anti-doble) | ✅ PASS | Ver §2. `evidencia-rojo-antes.md` + `evidencia-verde-despues.md`, conteo 112/112 coincide. |
| AC-6 (leg cotización) | ✅ PASS | `chaski-v3/app/api/a2a/quote/route.ts:173-174`, guard `code === "step_failed" && agentFailure === "INPUT_REJECTED"` → `422 a2a_quote_rejected`. Tests: `T-335-Q-1` (`route.test.ts:305`), `T-335-Q-2` (`:349`). Corridos: `npx vitest run app/api/a2a/quote/route.test.ts ... ` → `PASS (365) FAIL (0)` (agregado con los otros 3 archivos T-335, §5). |
| AC-7 (leg desembolso) | ✅ PASS | `chaski-v3/app/api/payout/prepare/route.ts:434-435`, mismo guard → `422 prepare_agent_rejected`. Tests: `T-335-P-1/AC-7` (`route.test.ts:1147`), `T-335-P-2/AC-8` (`:1188`). |
| AC-8 (candado de una sola clave) | ✅ PASS | `T-335-Q-2` (`quote/route.test.ts:367`, `expect(Object.keys(json)).toEqual(["error"])`) y `T-335-P-2` (`prepare/route.test.ts:1203`, mismo assert) — las dos además confirman que el log SÍ lleva el enum pero NUNCA el `message` del gateway ni el slug del agente. |
| AC-9 (sin levantar prohibición de parsear prosa) | ✅ PASS | `gateway-client.ts:230-249` (`readFailureFields`) extendido con `readAgentFailure(body.agentFailure)` — lee sólo el campo estructurado. La prohibición vigente sigue en el archivo: `grep "PROHIBIDO parsear"` → `gateway-client.ts:366` (línea corrida por el diff, contenido intacto, CD-8/CD-9). Tests: `T-335-GW-1/2/3` (`gateway-client.test.ts:440,457,473`). |
| AC-10 (orden de despliegue) | ⏸ **PENDIENTE-HUMANO — no ejecutable por un agente** | Precondición del founder (CD-8): Railway (`wasiai-a2a`) antes que Vercel (`chaski-v3`). **No se desplegó nada durante esta validación.** Confirmado en §1: la prod de hoy da `502 a2a_unavailable` para el input que dispara el defecto — eso es exactamente lo que seguirá pasando hasta que se respete el orden. Si se invierte (Vercel antes que Railway), Chaski mapea un campo que todavía no existe y el comportamiento observable no cambia (cubierto sin riesgo por `T-335-Q-3`/`T-335-P-3`, que prueban que la ausencia del campo es inocua). |

## 5 — Corrida dirigida de los 4 archivos de test T-335 en `chaski-v3` (además del gate completo)

```
npx vitest run app/api/a2a/quote/route.test.ts app/api/payout/prepare/route.test.ts \
  src/infrastructure/a2a/gateway-client.test.ts src/presentation/flow-vm.test.ts
→ exit 0, PASS (365) FAIL (0)
```

Confirma además que el `expect` protegido de T-4.1' (`flow-vm.test.ts:1054`,
`expect(humanError("step_failed")).toBe("Algo salió mal. Intentá de nuevo.")`) sigue con el mismo
texto que exigía `story-file.md:1218` que quedara intacto.

## 6 — Drift

- **`wasiai-a2a`**: todos los archivos tocados caen dentro del Scope IN del work-item (`compose.ts`,
  `compose.test.ts`, `types/index.ts`, `agent-http-error.ts`/test nuevo) más housekeeping de citas
  (`test/cited-lines-guard.*`, `field-error-parser.ts`, `discovery-fetch-limit.ts`, `routes/compose.test.ts`,
  `doc/INTEGRATION.md`, `doc/sdd/_INDEX.md`) generado por el propio mecanismo de citas
  `archivo:línea` del repo al mover líneas — no es feature creep, está documentado commit por commit
  (`1f86e3d`, `0095af9`, `94603b0`) y verificado por mí en §0.
- **`chaski-v3`**: el diff toca 33 archivos, pero 29 de ellos son cambios de 2-6 líneas — el mismo
  patrón de re-anclaje de citas tras el shift de líneas en `gateway-client.ts`/`quote/route.ts`/
  `prepare/route.ts`/`agent-rejections.ts`/`gateways.ts`/`flow-vm.ts`. Los cambios de escala real
  (`quote/route.ts` +35, `prepare/route.ts` +31, `gateway-client.ts` +36, `agent-rejections.ts` +35,
  `gateways.ts` +42, `flow-vm.ts` ~+31 netos, más los 4 archivos de test) están todos dentro del
  Scope IN de la Story File — incluido `flow-vm.ts`/`flow.tsx`/`flow-vm.test.ts`, que el work-item
  original NO listaba pero la Story File sí declara explícitamente (filas 9/10 de la tabla de
  archivos, `story-file.md:223-224`, W2.2.4/W2.2.5) como la capa de copy humano que hereda el enum
  nuevo. No es drift no declarado.
- **Wave order**: los 4 commits de `chaski-v3` (`b724068` feat → `c6e62a1`/`d5b6e45`/`f3e6834` fixes
  de citas) y los 3 de `wasiai-a2a` después del feat inicial siguen el orden esperado: feature primero,
  fix-packs de prosa/citas después, ninguno reabre lógica de negocio ya cerrada.
- **Nada fuera de scope encontrado.**

## 7 — Deuda declarada, no reabierta (confirmado que sigue siendo así)

- `TD-362-STATUS-ORCHESTRATE` — aditivo por diseño, `/orchestrate` hereda el campo por spread sin
  código nuevo. No verificado por ejecución (fuera de Scope IN), aceptado como diseño declarado.
- Citas Clase 2 (ya rotas en `main` antes de esta HU) y las 1167 candidatas del estrato congelado
  `doc/sdd/**` — no tocadas, consistente con la regla de exclusión.
- El hueco de tokens sueltos sin ancla — tiene HU propia (`ferrosasfp/wasiai-a2a#178`), no se
  reabre acá.
- `MNR-3` (asserts vacuos de `T-335-NOLEAK`) — aceptado como TD menor; AC-3 no depende de él (§4).

---

**Listo para DONE**, condicionado a que quede registrado como pendiente operativo: **AC-10 requiere
que un humano dispare el despliegue de Railway (`wasiai-a2a`) antes que el de Vercel (`chaski-v3`)**.
Hasta entonces, la producción sigue dando `502 a2a_unavailable` para el caso medido (verificado en
vivo, §1) — eso es exactamente el comportamiento esperado antes del cutover, no una regresión.
