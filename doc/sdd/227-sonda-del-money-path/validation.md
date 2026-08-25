# Validation Report — HU WKH-364 · Sonda periódica del camino del dinero (Corte A)

**Worktree**: `/home/ferdev/.openclaw/workspace/a2a-sonda` · rama `feat/227-sonda-money-path` · HEAD `7425d86`
**Fecha**: 2026-08-25
**Veredicto**: **APROBADO EN LO QUE ESTÁ EN CONTROL DEL DEV — DONE-COMPLETO BLOQUEADO por precondición de founder** (no es un defecto de esta HU; ver AC-2/AC-4)

---

## 1. Runtime checks ejecutados por QA (no releídos de AR/CR)

Todo lo de esta sección lo corrí yo mismo, ahora, contra el árbol `7425d86` y contra producción viva.

| # | Check | Comando | Resultado |
|---|---|---|---|
| R-1 | `/discover` vivo, schema real | `curl .../discover/remit-corridor-fx-solana` → `python3 -m json.tool` | `inputSchema.required=["amountUsd"]`, `payoutMethod.enum=["yape","plin","bank_cci"]`, `destCountry` string libre sin enum. `outputSchema.properties` incluye `rate` y `netDeliveredLocal`. Idéntico a lo documentado en `story-file.md:153-174` |
| R-2 | Huella del schema, calculada por mí, no copiada | `node -e "schemaFingerprint(liveSchema)"` importando la función real del `.mjs` | `ee87a63f8e71` — **coincide** con el `schemaSha256` de `D-1-post-fixpack.log` y con el de mi propia corrida R-5 |
| R-3 | `deriveInput` contra el schema vivo | mismo script | `{"input":{"amountUsd":25,"payoutMethod":"yape"},"omitted":["destCountry"]}` — igual a lo que el Story File §6 dice que produce el schema de hoy |
| R-4 | Anti-hardcode (variante de T-1, ejecutada por mí con `enum:["plin","yape"]`) | `node -e` | devuelve `payoutMethod:"plin"` — confirma que `deriveInput` lee el `enum` recibido y no un literal |
| R-5 | D-1 (credencial inválida) **re-ejecutado por QA**, no releído | `A2A_PROBE_KEY=wasi_a2a_qa_verificacion_independiente npm run probe:money-path` | `CONFIG: la credencial de la sonda (KEY_NOT_FOUND) — producción no está implicada \| ... schemaSha256=ee87a63f8e71 omitted=[destCountry] httpStatus=403 agentFailure=- durationMs=768` — **exit 3**. Coste 0 USDC (muere en el middleware antes del débito) |
| R-6 | Blob del script anclado al log archivado | `git hash-object scripts/probe-money-path.mjs` vs `git rev-parse HEAD:scripts/probe-money-path.mjs` | ambos `e687abdcd116bb88e852465da63c363040462140` — el log `D-1-post-fixpack.log` está anclado al código que se entrega, no a un commit distinto (MNR-5 cerrado) |
| R-7 | Muestra propia de la escalera (7 filas de 12, no las 4.860 del AR) | `node -e` sobre `classify()` puro | fila 2-bis (403/429 de `/discover` → **DOWN**, nunca PASS — confirma BLQ-MED-1 cerrado); fila 4 (403 `KEY_NOT_FOUND` → CONFIG); fila 6 (`INPUT_REJECTED` → DRIFT); fila 7 (`AGENT_ERROR` → DOWN); fila 9 (sin `obs.compose` → DOWN, nunca PASS por omisión); fila 11 (2xx + `quote.ok:true` → PASS); fila 10 (2xx + quote inválida → DOWN). Las 7 dieron exactamente la clase/exit de `story-file.md:205-217` |
| R-8 | Self-test sobre un campo que la derivación omitió (`destCountry`) | `classify({... selfTestField:'destCountry', selfTestFieldPresent:false})` | `CONFIG: se pidió romper un campo que la derivación NO produjo...` — confirma BLQ-BAJO-3 (el `delete` no-op ya no fabrica un SELF-TEST) |
| R-9 | Precondición de founder — credencial de sonda | `gh secret list --repo ferrosasfp/wasiai-a2a` | salida **vacía**, exit 0. Cero repo secrets configurados. `echo "${A2A_PROBE_KEY:-<AUSENTE>}"` → `<AUSENTE>` en el entorno de esta sesión |
| R-10 | Diff sobre `src/` (CD-2) | `/usr/bin/git diff --stat origin/main -- src/` | vacío |
| R-11 | Guardián T-5 de atribución de mensaje (fix-pack 2) | `grep -n "toContain\|atribuci" test/probe-money-path.test.mjs` | confirmado en código: `expect(atribucion.trim().length).toBeGreaterThanOrEqual(20)`, `expect(atribucion.includes(klass)).toBe(false)`, y el cruce anti-vacuidad entre filas (`:177-205`) |

---

## 2. Gate completo — corrido por QA, entero, en orden, una vez

```
npx tsc -p tsconfig.json --noEmit   → exit 0, sin salida
npm run lint (biome check src/)     → exit 0 — "Checked 503 files in 176ms. No fixes applied."
npm test (vitest run)               → exit 0 — Test Files 299 passed | 6 skipped (305)
                                                Tests      6009 passed | 19 skipped (6028)
```

Coincide exactamente con lo que reporta `ar-report-it2.md` tras el fix-pack 2 (mismo split
299/6/305 y 6009/19/6028). No hay drift entre lo que AR midió y lo que mide HEAD ahora.
`git status --short` → limpio, nada `??` (CD-11 cumplido, sin verde falso por untracked).

---

## 3. Acceptance Criteria

| AC | Texto (resumen EARS) | Status | Evidencia |
|---|---|---|---|
| **AC-1** | El body se deriva del `inputSchema` **de esa misma corrida**, nunca hardcodeado | **PASS** | R-1, R-2, R-3, R-4 arriba — ejecutado por mí contra producción viva, no releído de ningún reporte. `test/probe-money-path.test.mjs:9` (T-1..T-4) |
| **AC-2** | Invocar `/compose` con credencial **dedicada de sonda** (cron) | **PENDIENTE-HUMANO** | R-9: `gh secret list` vacío, `A2A_PROBE_KEY` ausente. No existe ninguna credencial dedicada hoy — es la precondición del founder declarada en `work-item.md:213-218` y `story-file.md §16`. No hay AC-2 posible sin ella; el código que la consumiría (`readCredential`, `scripts/probe-money-path.mjs:83-87`) está escrito y testeado (T-7), pero el AC describe un comportamiento **en producción bajo cron**, y ese comportamiento no puede ejecutarse hoy |
| **AC-3** | Distinguir 5xx/sin `agentFailure` (candidata a caída) de 4xx+`agentFailure` (drift de la sonda) | **PASS** | R-7 (filas 6, 7, 9 ejecutadas por mí) + `test/probe-money-path.test.mjs` T-5 (20 casos) y T-6 (mensajes distinguibles). Gate verde confirma T-5/T-6 pasando (sección 2) |
| **AC-4** | Demostrar el ROJO contra un objetivo roto, con log archivado, antes de DONE | **PARCIAL** | **D-1**: ejecutado y **re-verificado por mí de forma independiente** (R-5, R-6) — `exit 3`, CONFIG, 0 USDC, anclado al blob de HEAD. **D-2 y D-3: NO ejecutados.** Verificado que `evidence/D-2-D-3-NO-EJECUTADOS.log` no fabrica nada: documenta la ausencia medida (`gh secret list` vacío) y no simula una corrida. Cierro esto como PARCIAL, no PASS, porque CD-3/§12 del Story File exigen las tres demostraciones y sólo una corrió. Bloqueado por el mismo Missing Input que AC-2 |
| **AC-5** | Issue de GitHub con título fijo, dedup open/comment, cierre automático en verde | **PASS (verificado en el YAML, no ejecutado end-to-end)** | `.github/workflows/probe-money-path.yml:96-163` leído por mí: título idéntico en apertura (`:100`) y cierre (`:149`), dedup por `gh issue list --search "\"$TITULO\" in:title"` (`:132`, `:156`), apertura sólo `if: failure() && github.event_name == 'schedule'` (`:97`), cierre sólo `if: success() && ... 'schedule'` (`:146`). No pude ejercitar el workflow real (no está desplegado — sigue en una rama); la ejecución del shell la verificó AR-it2 §4 con 13 escenarios (`ar-report-it2.md:229-277`), evidencia de ellos, no mía |
| **AC-6** | `pull_request` corre informativo, `continue-on-error`, sin abrir/comentar issue | **PASS** | `.github/workflows/probe-money-path.yml:82` `continue-on-error: ${{ github.event_name == 'pull_request' }}`; los dos steps de issue llevan `github.event_name == 'schedule'` explícito (`:97`, `:146`) — un PR nunca entra a esa rama del `if`. Leído por mí, línea por línea |
| **AC-7** | La sonda no altera `/compose`, `/discover`, Chaski ni ningún agente — sólo observa | **PASS** | R-10: `git diff --stat origin/main -- src/` vacío. El único método no-GET del script es el único `POST /compose` (confirmado leyendo `scripts/probe-money-path.mjs:386-397`: no hay otro `fetch` con método distinto de GET) |
| **AC-8** | Credencial ausente → falla rápido con mensaje explícito, distinguible de caída real | **PASS** | R-5/R-9 en los hechos: sin credencial válida, la sonda sale `CONFIG: ... — producción no está implicada`, exit 3, nunca DOWN. Ejecutado por mí dos veces (con env vacío implícito en R-9 y con key inválida en R-5); ambas rutas terminan en CONFIG, no en DOWN, tal como exige CD-5/AC-8 |

---

## 4. Lo que NO puedo verificar y por qué (no lo invento)

- **AC-2 y D-2/D-3 de AC-4** dependen de `A2A_PROBE_KEY`, que no existe (R-9). No hay forma de
  ejecutar ese comportamiento sin la credencial — es una precondición del founder, no un vacío
  de la HU. El propio work-item (`:247-249`) ya declaraba la HU "bloqueada para llegar a DONE,
  no para avanzar F1-F2.5" por este mismo motivo.
- **AC-5 end-to-end** (que un issue real se abra/cierre): el workflow no está mergeado ni
  desplegado, así que no hay corridas de `schedule` que observar. Lo que verifiqué es el YAML
  estático y cito la ejecución de shell del AR (`ar-report-it2.md §4`) como evidencia **de ellos**,
  no mía.
- **No repetí el barrido de 4.860 combinaciones del AR** — tomé una muestra propia de 7 filas
  (R-7) más las 2 filas que motivaron los BLQ del CR (2-bis, y "sin compose"). Confío el resto
  en la medición de AR-it2, que documenta método y arnés verificables.

---

## 5. Drift detection

- **Scope**: `git diff --stat origin/main HEAD` → 17 archivos: los 6 del Scope IN
  (`scripts/probe-money-path.mjs`, `test/probe-money-path.test.mjs`,
  `.github/workflows/probe-money-path.yml`, `package.json`, `README.md`, `README.es.md`) + 3 logs
  de evidencia (fuera de presupuesto, declarado) + 7 artefactos SDD (`work-item.md`, `sdd.md`,
  `story-file.md`, `auto-blindaje.md`, `ar-report.md`, `ar-report-it2.md`, `cr-report.md`) +
  `doc/sdd/_INDEX.md`. **Cero archivos fuera de lo declarado.**
- **Wave order**: el historial de commits (`8865721` → `3d83c03` fix-pack 1 → `7425d86` fix-pack 2)
  respeta W0→W1→W2 según los mensajes de commit; no hay evidencia de código de W2 commiteado antes
  que W0/W1.
- **Spec drift**: comparé `scripts/probe-money-path.mjs` contra §5 (la escalera) y §6 (derivación)
  del Story File función por función — coinciden fila por fila, incluida la fila `2-bis` que **no**
  estaba en el Story File original y que el CR forzó a agregar (`BLQ-MED-1`). Documentado como
  fix-pack, no como drift silencioso.
- **Test drift**: los 12 IDs de test (T-1 a T-12) del Story File §11 existen en
  `test/probe-money-path.test.mjs` con los mismos nombres/propósitos (confirmado por grep y por
  el conteo de 48 tests en el archivo, consistente con `ar-report-it2.md` "Baseline nuevo 48
  passed (48)").
- **Drift: ninguno adicional al ya documentado y cerrado por el propio proceso** (BLQ-MED-1,
  BLQ-BAJO-1/2/3 del CR, MNR-1/4/5 del AR-it2 fix-pack 2). MNR-2 y MNR-3 quedan como deuda
  declarada, no reabierta.

---

## 6. Gate confirmation

Corrido por mí, completo y en orden, una vez (sección 2). Verde, y coincide byte a byte con lo
que `ar-report-it2.md` documentó tras el fix-pack 2. **No re-ejecuté los 45 mutantes ni las 4.860
combinaciones del AR** — eso es trabajo de AR, ya hecho y documentado con arnés verificable
(`ar-report-it2.md §0, §1.1`).

---

## 7. Advertencias de proceso que NO repito

- No escribo que la sonda "está vigilando el camino del dinero" — nada está mergeado ni
  desplegado. El workflow existe sólo en la rama `feat/227-sonda-money-path`. Hoy no corre nada.
- Donde cito la ausencia de la credencial en stdout, uso la frase acotada que el propio Dev
  corrigió en `auto-blindaje.md:193`: "no puede llegar por ninguna de las dos vías nombradas" —
  no "no puede llegar a stdout" a secas (eso es MNR-2, deuda declarada, no cerrada).
- MNR-2, MNR-3 y los MENORes del CR aceptados como TD no los reabro: son deuda técnica declarada
  por AR-it2 y CR, con su razón escrita, no defectos silenciados.

---

## 8. Veredicto

**Todo lo que está en control del Dev está PASS con evidencia de ejecución**: AC-1, AC-3, AC-6,
AC-7, AC-8 en PASS; AC-5 en PASS por lectura verificada del YAML real (ejecución end-to-end no
disponible porque nada está desplegado). Gate completo verde, `src/` intacto, cero scope drift.

**AC-2 y AC-4 no pueden cerrar** porque `A2A_PROBE_KEY` no existe (medido, R-9) — es exactamente
el Missing Input bloqueante que `work-item.md` declaró desde F1 y que ningún agente puede resolver.
D-1 de AC-4 está demostrado y re-verificado por mí de forma independiente; D-2/D-3 están
correctamente documentados como NO EJECUTADOS, sin evidencia fabricada.

**No hay nada que reenviar al Dev.** Un re-lanzamiento de F3 no puede crear la credencial. La
HU queda en el estado que el propio work-item previó: lista para DONE de código, **bloqueada
para DONE completo por una precondición de founder**. Corresponde escalar al founder la creación
de `A2A_PROBE_KEY` (repo secret, presupuesto ≥ 60 USDC/30 días con las corridas de PR incluidas
—MNR-4—, `DAILY_LIMIT` > 1,46 USD/día) antes de mergear a `main`, o mergear sabiendo que el cron
va a producir 48 corridas `CONFIG`/rojas por día hasta que la credencial exista (documentado en
`evidence/D-2-D-3-NO-EJECUTADOS.log`).
