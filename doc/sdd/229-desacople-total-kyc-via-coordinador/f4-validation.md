# F4 Validation Report — WKH-366 · Chaski deja de hablarle directo al agente de KYC

**Fecha**: 2026-08-26 · **QA**: nexus-qa · **Veredicto: APROBADO — con 3 ACs BLOQUEADOS-POR-DEPLOY (esperado, no falla) y una lista de OPS pendiente antes del flip a `gateway`.**

Nada commiteado/pusheado/desplegado. Los 3 repos están `git add`-eados sobre sus branches
(`feat/wkh-366-kyc-compose-adapters`, `feat/wkh-366-kyc-catalog-rows`, `feat/wkh-366-kyc-gateway-transport`).

---

## 1. Gates completos — corridos por mí, serializados, uno por vez

| Repo | Secuencia | Resultado medido HOY |
|---|---|---|
| A `wasiai-remittance-agents` (`wt-366-agente`) | `npm run typecheck` → `npm test` → `npm run build` | 0 · **846 passed (34 files)** · 0 |
| B `wasiai-a2a` (`wt-366-coordinador`) | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` | 0 · biome **516 files, 0 fixes** · **6290 passed / 19 skipped (310 files passed, 6 skipped, 316 total)** |
| C `chaski-v3` (`wt-366-chaski`) | `npm run qa` (lint 289 files → tsc → tsc:scripts → test) → `npm run build` | 0 · **3285 passed (160 files)** · 0 (warnings pre-existentes `pino-pretty`/`ox`, no relacionados a la HU) |

Los tres números coinciden exactamente con lo que reportó el último fix-pack. `npm run qa` **no existe** en B (confirmado leyendo `package.json`); ahí corrí los 3 comandos del CI en orden, no un combo.

---

## 2. Los 15 ACs

### Repo A — `wasiai-remittance-agents`

| AC | Status | Evidencia |
|---|---|---|
| **AC-1** (crear sesión sin `legalId`, devolver `sessionId/url/decisionToken`) | ✅ PASS | `src/app/api/agents/remit-kyc-session/invoke/route.test.ts:84` (T-A1, 200 + exactamente 4 claves) y `:116` (T-A2, `identityRef` no llega al core). Corrida verde dentro de los 846/34 de arriba. Mutante M6/M7 del `auto-blindaje.md` (no re-aplicado por mí, matcheado contra las 4 líneas del handler que sí verifiqué en código: `src/app/api/agents/remit-kyc-session/invoke/route.ts:88-92`). |
| **AC-2** (clave fuera del `.strict()` ⇒ 400 sin invocar Didit) | ✅ PASS | `.../remit-kyc-session/invoke/route.test.ts:134` (T-A3, DNI fuera de schema) y `.../remit-kyc-decision/invoke/route.test.ts:131` (T-A4). **Mutado y ejecutado por mí** (M13: ecoar el body crudo en el 400) → **3 failed** (`compose-dialect-no-pii.test.ts` 2 filas + `route.test.ts:144`), el DNI `12345678` filtraba; restaurado con `cp`, `/usr/bin/diff` vacío, suite vuelta a 14/14 verde. |
| **AC-3** (`/invoke` de `remit-kyc-validator` sin modificar) | ✅ PASS | `/usr/bin/git diff HEAD -- 'src/app/api/agents/remit-kyc-validator/*'` → **0 bytes** (medido por mí). **Mutado y ejecutado por mí** (M12: sacar `legacy-single-shot-kyc` de la ficha) → **4 failed** en `src/manifest/registry.test.ts`, entre ellos `:169` "🔴 T-A8: la entrada `remit-kyc-validator` sigue intacta"; restaurado, diff vacío, 17/17 verde. |
| **AC-4** (capabilities nuevas sólo `no-disbursement`) | ✅ PASS | `src/lib/capability-risk.test.ts:161` (T-B1) y `:187` (T-B2/CD-18), corridos dentro del gate verde de B. |

### Repo B — `wasiai-a2a`

| AC | Status | Evidencia |
|---|---|---|
| **AC-5** (catálogo expone `invokeUrl` a los endpoints nuevos, `required` sin `legalId`) | ⏳ **BLOQUEADO-POR-DEPLOY** | Las filas **no están registradas**: `curl -o /dev/null -w '%{http_code}' https://wasiai-a2a-production.up.railway.app/discover/remit-kyc-session` → **404**, ídem `/discover/remit-kyc-decision` → **404** (medido por mí, ahora mismo). Control positivo: `/discover/remit-kyc-validator` → **200**. Es OPS, no código; el `inputSchema.required` correcto ya se comprobó en aislamiento vía `input-schema-drift.test.ts` (repo A) y el estrechado de `readInvokeUrl`/`invokeUrls` (repo C, ver T-B11/M-F4 abajo). |
| **AC-6** (pin por slug, nunca ranking, en el camino del dinero) | ✅ PASS | Guard N2: `src/lib/compose-step-shape.ts:265-269` (`requiresPinnedAgent` → `capability_requires_pinned_agent`), llamado en `src/routes/compose.ts:216` **dentro de `validateComposeBody`** (pre-débito, pre-discovery). Guard N3 (host real, no catálogo): `chaski-v3/src/infrastructure/kyc/gateway-kyc-client.ts:235` (`sameOrigin(r.invokeUrls[0], expectedAgentBaseUrl())`). **Mutado y ejecutado por mí** (M-F1: borrar el bloque `2b` del origin-check) → **17 failed / 64 passed**, con `authority.gateway.test.ts:215` (`T-C5c`) dando `expected true to be false` sobre `r.authorized` — **el mutante AUTORIZA UN DESEMBOLSO** al impostor. Restaurado, diff vacío, 81/81 verde. **Mutado y ejecutado por mí** (M14: sacar `'kyc-decision-read'` de `AUTHORIZATION_CAPABILITIES`) → **3 failed** (T-B3, T-B8, T-B9 en `compose.capability.test.ts`), `discoverMock` pasa a ser llamado 1 vez ⇒ el impostor gana el ranking; restaurado, diff vacío, 50/50 verde. |
| **AC-7** (bridge LLM prohibido en steps de KYC) | ✅ PASS **(AC redefinido — ver §3 Drift, "AC-7'")** | `bridgeType` no es campo de entrada de `ComposeStep`; el mecanismo real es estructural: `steps[0].output` se asigna en `wasiai-a2a/src/services/compose.ts` **antes** del bridge y el bridge nunca lo toca (T-B5, `src/services/compose.test.ts:4298`), y un pipeline de 1 step no entra al bloque del bridge (T-B6, `:4361`). Del lado de Chaski, `gateway-kyc-client.ts` rechaza si `r.bridged[0] !== false` (T-C6, `gateway-kyc-client.test.ts:199`). Los tres corren verdes dentro de los gates completos de B y C. |

### Repo C — `chaski-v3`

| AC | Status | Evidencia |
|---|---|---|
| **AC-8** (`direct` ausente/explícito ⇒ cero cambio, cero fetch al gateway) | ✅ PASS | `kyc-transport.test.ts:114` (T-C1, cuenta llamadas por host) y `:143` (T-C2, `RequestInit` byte-idéntico). `agent-kyc-client.ts` diff = 2 líneas, las 2 renames de firma (`/usr/bin/git diff` inspeccionado, cuerpos intactos). |
| **AC-9** (`gateway` usa `runViaGateway`, header `x-a2a-key`, cero fetch directo) | ✅ PASS | `gateway-kyc-client.test.ts:121` (T-C4: body lleva `agent`, nunca `capability`, 1 solo step). |
| **AC-10** (fail-closed ante cualquier resultado no-positivo-explícito) | ✅ PASS | `authority.gateway.test.ts:294` (T-C7, tabla de 10 filas: `not_configured`…código inventado, las 10 ⇒ `kyc_reauth_failed`/502, ninguna autoriza; sin `default: ok`). |
| **AC-11** (3 call sites, misma firma pública, Guards 1-7 intactos) | ✅ PASS | `authority.gateway.test.ts:341` (T-C9, orden de efectos: `tokenStore.getForOwner` antes del transporte). Diff de `authority.ts` es 1 línea de import (medido). |
| **AC-12** (aislamiento por owner bajo ambos transportes) | ✅ PASS | `authority.gateway.test.ts:369` (T-C10, `kyc_ownership_mismatch`/200 bajo `direct` y `gateway`, transporte NO invocado). |

### Transversal

| AC | Status | Evidencia |
|---|---|---|
| **AC-13** (smoke contra servicios desplegados, ≥6 exit codes, input derivado del schema) | ⏳ **BLOQUEADO-POR-DEPLOY** — código listo, corrida real pendiente | Cubierto HOY: las piezas puras del smoke, `scripts/smoke-kyc-helpers.test.ts` — corrido por mí: **PASS (85) FAIL (0)**. Código inspeccionado: paso 1 del script (`GET {gateway}/discover/remit-kyc-session`) es lo primero que hace `main()` (`smoke-kyc-via-gateway.ts:222-230`) y **corta antes de cualquier `POST /compose` pagado** si el discover no devuelve schema — así que correrlo hoy contra prod real (rows no registradas) terminaría en **exit 4 (DRIFT)** sin gastar saldo, que es el desenlace correcto documentado por AR ronda 2. No lo ejecuté en vivo: requiere `WASIAI_A2A_AGENT_KEY` con saldo real, credencial que no manejo en esta sesión (carpeta de keys fuera de mi alcance). Pendiente: correrlo tras W1/W2 desplegados. |
| **AC-14** (corrida real de Didit del founder antes de `gateway` en prod) | ⏳ **BLOQUEADO-POR-DEPLOY — es acción humana, no un defecto** | No es un test: es una precondición de proceso (W5, story-file §W5). Nada que verificar en código; queda en la lista de OPS §5. |
| **AC-15** (guard de residuo cuando se borra el transporte directo) | ⏳ **PARCIAL, POR DISEÑO — diferido a HU de seguimiento (W6/DT-15)** | El work-item mismo lo scopea a "paso 7", y Scope OUT del work-item dice textual: *"Borrar el transporte directo... quedan para una fase posterior de esta misma HU o una HU de seguimiento, a decidir en F2"*. F2.5 decidió: **no entra ahora** (el guard completo afirmaría "no existe fetch directo" mientras `KYC_TRANSPORT` sigue en `direct` por default — sería falso por diseño). Lo que SÍ entra y verifiqué: `T-KGS-1`/`T-KGS-2` (`kyc-gateway-slug-count.static.test.ts:149`, cada slug nuevo aparece exactamente 1 vez en producción) y `T-KGS-3` (`:168`, `resolveKycAgentBaseUrl` con lista de importadores anclada por criterio, no por número — corregido en el fix-pack tras MNR-3). Esto **no es una falla de la HU**: es una decisión de scoping documentada dos veces (work-item + story-file), y la marco BLOQUEADO en vez de PASS/FAIL para que quede visible, no para objetarla. |

**Resumen**: 12/15 PASS con evidencia ejecutada, 3/15 BLOQUEADO-POR-DEPLOY (AC-5, AC-13 parcial, AC-14; AC-15 parcial por diseño ya documentado). **Cero FAIL.**

---

## 3. Drift detection

- **AC-7 → AC-7'**: la redacción literal del work-item describe un campo (`bridgeType` como input de `ComposeStep`) que **no existe** — verificado clave por clave en `wasiai-a2a/src/types/index.ts:984-1024` por el propio Story File, y re-confirmado por mí leyendo `compose-step-shape.ts` y `compose.test.ts`. La reformulación operativa (§4 del story-file, citada arriba) está **bien declarada por escrito**, con su propia tabla de qué test la enclava, y no se coló como "cumplido en espíritu": el story-file lo marca en mayúsculas como el AC que F4 verifica. Considero esto una corrección de spec bien manejada, no drift oculto.
- **AC-15**: igual que arriba — declarado, no oculto. Ver tabla.
- **Scope**: `git diff --name-only` en los 3 repos vs. Scope IN de cada repo (work-item §Scope IN) — sin sorpresas. Los archivos tocados en B fuera del núcleo (`CLAUDE.md`, `doc/INTEGRATION.md`, `test/cited-lines-guard.citations.ts`, `test/ownership-filter-guard.exceptions.ts`) son consecuencia documentada de candados existentes que el propio diff desplazó (G-9 a G-13 del `auto-blindaje.md`), no alcance nuevo sin pedir.
- **Waves**: el orden de ejecución (W0→W1→W2→W3→W4, W5/W6 explícitamente NO ejecutados) se respeta; no hay commits (nada está commiteado todavía) así que no aplica verificación de orden de commits, pero el estado del working tree en los 3 worktrees es consistente con "W0-W4 escritos, W5-W6 sin tocar" (cero filas de catálogo, cero cambio en `KYC_DECISION_TOKEN_SECRET`, cero guard de residuo completo).
- **Riesgo 4 del work-item** ("republicar el catálogo es MANUAL") se materializó exactamente como advertido: es la causa directa de que AC-5/AC-13/AC-14 queden bloqueados por deploy.

**Drift: controlado y documentado, sin hallazgos nuevos de mi parte.**

---

## 4. Runtime / integration checks

| Check | Resultado |
|---|---|
| `KYC_TRANSPORT` en `direct` en toda config | ✅ Único sitio que lo declara: `chaski-v3/.env.example:367` → `# KYC_TRANSPORT=direct` (comentado = valor por defecto). Código: `kyc-transport.ts:51` → `=== "gateway" ? "gateway" : "direct"` (cualquier otro valor cae a `direct`). Sin `vercel.json`/`railway.json`/otro config file que lo mencione (grep negativo). |
| Migraciones `.sql` en los 3 diffs | ✅ **Cero** — `/usr/bin/git diff --name-only HEAD \| grep -i '\.sql$'` vacío en A, B y C (medido por mí). |
| `kyc_session_tokens` sin cambios de forma ni de uso | ✅ Los archivos que la usan (`supabase-kyc-session-tokens.ts`, `resume-kyc.ts`, `start-kyc.ts`, `kyc-pending-store.ts`, etc.) **no aparecen** en `git diff --name-only HEAD` de repo C (medido por mí). |
| `/invoke` de `remit-kyc-validator` con cero diff | ✅ Ver AC-3 arriba. |
| Archivos sin trackear en los 3 worktrees | ✅ `git status --short` en los 3 → todo `M`/`A` (staged), **cero líneas `??`**. |
| Slugs `remit-kyc-session` / `remit-kyc-decision` libres | ⚠️ **SÍ, todavía libres** — `GET /discover/remit-kyc-session` → 404, `GET /discover/remit-kyc-decision` → 404 contra `https://wasiai-a2a-production.up.railway.app` (medido por mí, sólo lectura, ahora). Esto es la precondición de OPS pendiente de §5, no una falla de código: el guard N3 (M-F1 verificado arriba) ya degrada el vector de "eludir KYC" a "denegación + drenaje potencial de un step si alguien lo squattea", según el AR ronda 2 (MNR-5). |

---

## 5. Presupuesto de escala — medido por mí ahora, `/usr/bin/git diff --shortstat HEAD`

Fecha de la medición: **2026-08-26, ~13:33**. Método: `/usr/bin/git diff --shortstat HEAD` en cada worktree, cero commits en las 3 branches (el stat es la HU entera).

| Repo | Techo del SDD | Medido AHORA | Ratio | Nota |
|---|---|---|---|---|
| A | 450–800 | **1457 ins / 8 del, 13 archivos** | **1.82x** | Sin cambios desde el último fix-pack (confirmado: mismo número). |
| B | 150–400 | **1043 ins / 38 del, 18 archivos** | **2.61x** | De las 1043, **772 son `*.test.ts`** (medido por mí con `git diff --numstat HEAD`, 8 de 18 archivos): `capability-risk.test.ts` 80, `compose.capability.test.ts` 296, `registries.no-charge-before-validating.test.ts` 83, `compose.test.ts` 111, `capability-resolver.test.ts` 59, `registry.ownership.test.ts` 91, más 2 archivos de citas. |
| C | 800–1400 | **3801 ins / 63 del, 25 archivos** | **2.72x** | Incluye la sonda de AC-13 (deliberadamente grande, ya justificada en el work-item) + su `.test.ts` de piezas puras. |

Los tres exceden el techo — **justificado por escrito en `auto-blindaje.md`** (líneas ~670-681) y re-confirmado por mí: el presupuesto contaba código de producción; lo que domina el exceso son los testigos (money-path security tests, no lógica nueva). No recorto: la mayoría de lo que excede es exactamente lo que un revisor pediría agregar si no estuviera ahí (T-B3/T-B4 control positivo, T-C5/T-C5c, T-B11/M-F4 cross-repo).

---

## 6. Mutantes muestreados y ejecutados por mí (4, uno de ellos el crítico de dinero)

Todos: aplicar (edición directa) → correr → ver el rojo → restaurar con `cp` desde copia propia en scratchpad → verificar `/usr/bin/diff` vacío → re-correr y confirmar verde. **Ninguno restaurado con `git checkout --`.**

1. **M-F1** (repo C, `gateway-kyc-client.ts:235`, N3 parte B) — borrar el chequeo de origen ⇒ **17 failed / 64 passed**; `authority.gateway.test.ts:215` da `expected true to be false` sobre `r.authorized`: **el mutante autoriza un desembolso al impostor**. Es la reproducción exacta de BLQ-ALTO-1.
2. **M14** (repo B, `capability-risk.ts`, `AUTHORIZATION_CAPABILITIES`) — sacar `'kyc-decision-read'` ⇒ **3 failed / 18 passed** en `compose.capability.test.ts` (T-B3, T-B8, T-B9): `discoverMock` pasa a ser llamado (el impostor es consultado).
3. **M12** (repo A, `registry.ts`, ficha `remit-kyc-validator`) — sacar `legacy-single-shot-kyc` ⇒ **4 failed / 13 passed** en `registry.test.ts`, entre ellos T-A8 (AC-3).
4. **M13** (repo A, `remit-kyc-session/invoke/route.ts`, rama 400) — ecoar el body crudo ⇒ **3 failed / 11 passed**: el DNI `12345678` filtraba en `compose-dialect-no-pii.test.ts` y `route.test.ts:144`.

Los 4 reproducen exactamente el rojo declarado en `auto-blindaje.md` (mismos archivos, mismos números de failed, mismas líneas de assertion). No encontré discrepancias entre lo declarado y lo medido.

---

## 7. Gate confirmation

Confirmado por corrida propia (§1), no por lectura del CR — el CR ya lo había corrido y coincide número por número. AR ronda 2 también corrió los 3 gates él mismo antes de aprobar (`ar-report.md:197-198`) y coincide.

---

## 8. Lista accionable pendiente de deploy (para el founder)

**Orden obligatorio (DT-5 del work-item):**

1. **Sembrar 2 envs en Vercel de `chaski-v3`** (Production **y** Preview, mismo valor que `REMIT_KYC_VALIDATOR_PAYTO`): `REMIT_KYC_SESSION_PAYTO`, `REMIT_KYC_DECISION_PAYTO`. Sin ellas, los `/manifest` nuevos de repo A dan **503**.
2. **Desplegar Repo A** (`wasiai-remittance-agents`, branch `feat/wkh-366-kyc-compose-adapters`). Verificar `GET .../remit-kyc-session/manifest` y `GET .../remit-kyc-decision/manifest` → 200, y que `/invoke` del validador viejo sigue vivo.
3. **Registrar las 2 filas del catálogo en `wasiai-a2a`** — **esto es precondición del flip a `gateway`, no un paso posterior**: mientras el slug esté libre, un okupa que conteste 2xx **cobra el step** (precio y wallet los pone él) aunque el guard N3 rechace el veredicto por origen; y el slug es PK global, primero-que-llega — perdida la carrera no se recupera. Verificar con `GET /discover/remit-kyc-session` y `GET /discover/remit-kyc-decision` → deben pasar de 404 a 200, con `invokeUrl` a los endpoints nuevos y `inputSchema.required` sin `legalId` (evidencia de AC-5).
4. **Desplegar Repo C con `KYC_TRANSPORT` ausente** (default `direct`). Confirmar cero cambio observable (T-C1/T-C2 ya lo garantizan en código; en runtime, comparar tráfico antes/después).
5. **Correr `npm run smoke:kyc-gateway`** contra los servicios ya desplegados, agente en `DIDIT_ENV=mock` → debe salir **0**. Guardar la salida completa: es la evidencia de AC-13.
6. **Flip `KYC_TRANSPORT=gateway` en Preview** + corrida real contra Didit hecha por el founder, con un desembolso verificado de punta a punta (AC-14).
7. Recién entonces, **`KYC_TRANSPORT=gateway` en Producción**.
8. (Fuera de esta HU, W6/DT-15) Borrar transporte directo + guard de residuo completo de AC-15, y deprecar `/invoke`.

⛔ Ningún paso de esta lista rota `KYC_DECISION_TOKEN_SECRET` — el rollback en cualquier punto es borrar la env `KYC_TRANSPORT`, sin redeploy.

---

## Veredicto

**APROBADO para DONE.** Cero ACs en FAIL. Los 3 ACs BLOQUEADOS-POR-DEPLOY (AC-5, AC-13, AC-14) y el parcial-por-diseño (AC-15) no son defectos del código — son, correctamente, lo que le falta a una HU de tres repos antes de que alguien pueda flippear una bandera en el camino del dinero. Gates completos verdes en los 3 repos, corridos por mí de punta a punta y coincidentes con lo reportado. BLQ-ALTO-1 del AR verificado cerrado con mi propio mutante reproduciendo el ataque original y viéndolo rechazado. Presupuesto medido y justificado. Lista de OPS entregada arriba para Docs/founder.
