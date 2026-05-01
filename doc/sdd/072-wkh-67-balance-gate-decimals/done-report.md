# Report — HU [WKH-67] Balance-gate decimals mismatch (PYUSD inbound vs USDC outbound)

> Status: DONE
> Branch: `fix/072-wkh-67-balance-gate-decimals`
> Commit: `da12148`
> Fecha de cierre: 2026-04-30
> Pipeline: NexusAgil QUALITY — modo AUTO
> Lema: no construimos para hackathon, sino para producción.

---

## Resumen ejecutivo

WKH-67 resolvió una regression bloqueante en mainnet introducida por WKH-66:
el balance-gate del operator wallet reutilizaba `args.maxAmountWei` (PYUSD
inbound, 18 decimales) como input para el claim USDC outbound (6 decimales),
haciendo matemáticamente imposible cualquier `pay_x402` exitoso. El fix
(Approach A, cementado en F1) mueve el balance-gate INSIDE `payX402Handler`
post-probe, deriva el `requestedWei` desde `payload.maxBudget` (USDC number),
y mantiene el cap guard PYUSD intacto. Pipeline completado en 1 fix-pack
iteration: AR APROBADO first try (0 bloqueantes, 3 menores), CR APROBADO
(0 issues), F4 APROBADO (186/186 tests, MNR-2 fixeado en F4). Archivos clave:
`src/handlers.mjs` (balance-gate reubicado), `api/mcp.mjs` (runWithBalanceGate
eliminado), `tests/handlers-balance-gate.test.mjs` (15 tests nuevos que
incluyen regression test del bug WKH-66 cerrado). ACs 1-10 y AC-14 verificados
en F4; ACs 11-13 y AC-15 son post-merge gates pendientes al orquestador.

---

## Pipeline timeline

| Fase | Sub-agente | Fecha | Resultado |
|------|-----------|-------|-----------|
| F0 — Codebase Grounding | nexus-analyst | 2026-04-29 | project-context heredado de WKH-64/65/66; 10 archivos leídos, 3 patrones recurrentes identificados |
| F1 — Work Item + ACs EARS | nexus-analyst | 2026-04-29 | `work-item.md`: 15 ACs, 9 DTs, 25 CDs, 12 categorías de riesgo; Approach A cementado; HU_APPROVED |
| F2 — SDD | nexus-architect | 2026-04-29 | `sdd.md`: context map 10 archivos, insertion point ~línea 343 `payX402Handler`, 8 archivos scope IN, SPEC_APPROVED |
| F2.5 — Story File | nexus-architect | 2026-04-29 | `story-WKH-67.md`: 14 pasos READY_FOR_F3, 13 invariantes anti-hallucination, ejemplar canónico T29 documentado |
| F3 — Implementación | nexus-dev | 2026-04-30 | 1 wave coordinada (W1-W5): 8 archivos modificados + 2 nuevos; 186/186 tests passing; commit `da12148` |
| AR — Adversarial Review | nexus-adversary | 2026-04-30 | APROBADO: 0 BLQ, 3 MENORs (MNR-1 tools.test scope drift documentado, MNR-2 decimals test refine, MNR-3 type safety informativo) |
| CR — Code Review | nexus-adversary | 2026-04-30 | APROBADO: 0 issues; CD-20/CD-21/CD-22/CD-23 verificados; redirect:'error' intacto; no secret leak |
| F4 — QA Validation | nexus-qa | 2026-04-30 | APROBADO PARA DONE: 186/186 tests, MNR-2 fixeado (decimals precision en T-FIX-10b), AC-14 `auto-blindaje.md` escrito |
| DONE — Docs closure | nexus-docs | 2026-04-30 | `done-report.md` + `_INDEX.md` actualizado |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 — happy path sin maxAmountWei | PASS (F3) | `handlers-balance-gate.test.mjs` T-FIX-01: `pay_x402` con `payload.maxBudget=0.5`, sin `maxAmountWei` → `{ ok: true, stage: 'settled' }` |
| AC-2 — balance-gate usa USDC 6d outbound | PASS (F3+F4) | `src/handlers.mjs` bloque `[1.5]`: `requestedWei = usdcToWei(payload.maxBudget)` (BigInt 6d). Grep: `args.maxAmountWei` NUNCA aparece en balance-gate (verificado CR) |
| AC-3 — sign guard PYUSD 18d intacto (WKH-64 AC-11) | PASS (F3) | `handlers-balance-gate.test.mjs` T-FIX-02: `maxAmountWei=10^17`, challenge=`10^18` → `{ ok: false, stage: 'sign', error: /exceeds maxAmountWei guard/ }` |
| AC-4 — fail-secure maxBudget inválido | PASS (F3) | T-FIX-03 (missing), T-FIX-04 (undefined), T-FIX-05 (negative), T-FIX-06 (zero) → `{ ok: false, stage: 'balance-gate' }` |
| AC-5 — ordering probe→balance-gate→sign | PASS (F3) | T-FIX-07: spy sobre `checkBalanceWithClaim` verifica que corre DESPUÉS de probe (fetchFake[0] consume) y ANTES de sign. `src/handlers.mjs`: bloque `[1.5]` entre línea post-`accepts` parse y pre-`[2] Cap guard` |
| AC-6 — releaseClaim exactly-once via finally | PASS (F3) | T-FIX-08 (success path) + T-FIX-09 (settle error): spy sobre `releaseClaim` — `callCount === 1` en ambos paths |
| AC-7 — KV down + invalid budget → fail-secure | PASS (F3) | T-FIX-10 (KV null), T-FIX-11 (RPC down), T-FIX-12 (prototype pollution rechazado via `Object.hasOwn`) → retornan `stage:'balance-gate'` sin firmar |
| AC-8 — no-regression BLQs históricos WKH-64/65/66 | PASS (F3) | 186/186 passing incluyen T-X1..T-X5 (WKH-64 BLQ-1..5), T-X11..T-X14 (WKH-65 BLQ-iter3-1), T-CS-01/T-CS-02 (WKH-66 BLQ-ALTO-1, concurrent stress) |
| AC-9 — baseline 173 + 15 nuevos → 186 total | PASS (F4) | 173 baseline (WKH-66 final) - 2 eliminados (T-BG-11/T-BG-11b importaban runWithBalanceGate) + 15 nuevos (T-FIX-01..14 + T-FIX-10b) = 186/186. MNR-2 fixeado en F4 mejora precisión de T-FIX-10b |
| AC-10 — sec invariants intactos | PASS (CR) | bearer compare timing-safe: `api/mcp.mjs` intacto. Rate-limit fail-open: `src/rate-limit.mjs` NO tocado. Auth-first ordering: NO tocado. No secrets en logs nuevos: grep `OPERATOR_PRIVATE_KEY`, `MCP_BEARER_TOKEN`, `CRON_SECRET` clean en diff |
| AC-11 — re-deploy Vercel post-merge | PENDIENTE (post-merge) | Gate del orquestador: `vercel deploy --prod` desde `main` post-PR merge. El alias `wasiai-x402-mcp.vercel.app` apuntará a nuevo deploy (distinto a rolled-back `wasiai-x402-ah0gufv0p`) |
| AC-12 — smoke real $0.061 USDC mainnet | PENDIENTE (post-merge) | Gate del orquestador + autorización humana. Ver `smoke-prep.md`. CD-24: one-shot, documentar tx hash en este report |
| AC-13 — re-enable cron-job.org jobs | PENDIENTE (post-AC-12) | `node scripts/setup-cronjob.mjs` idempotente (heredado WKH-66 AC-W1-1) |
| AC-14 — auto-blindaje.md con decimals lesson | PASS (F4) | `doc/sdd/072-wkh-67-balance-gate-decimals/auto-blindaje.md` escrito: 4 lecciones (prototype pollution, ripple effect, RPC mock pattern, decimals separation con CD-DEC-01 para propagar) |
| AC-15 — done-report.md con link PR + deploy + tx hash | PARCIAL | PR pendiente (orquestador lo crea post-push). Tx hash pendiente (AC-12). Deploy URL pendiente (AC-11). Campos a completar post-merge gates |

---

## Hallazgos finales

**BLOQUEANTEs**: 0 — AR first-try APROBADO.

**MENORs (3/3 cerrados)**:
- MNR-1: tools.test.mjs adaptado con scope drift documentado en auto-blindaje
  (causa: insertar balance-gate INSIDE handler cambió el contrato de 14
  call-sites legacy). No es un defecto del fix — es efecto esperado del
  refactor; documentado para story files futuros.
- MNR-2: test T-FIX-10b refinado en F4 para precisión de decimals en
  escenario KV-null + maxBudget boundary. Fix mínimo en el test, sin cambios
  al código de producción.
- MNR-3: type safety informativo — `payload.maxBudget` validado via
  `Number.isFinite` + `Object.hasOwn` (CD-22 + prototype-pollution defense).
  MNR informativo ya cubierto en implementación F3; anotado en auto-blindaje.

---

## Auto-Blindaje consolidado

Tabla completa de lecciones generadas en WKH-67 (reproducida íntegra desde
`auto-blindaje.md`; no se omite ni resume ninguna entrada):

| # | Fecha | Fase | Lección | Aplicar en |
|---|-------|------|---------|-----------|
| AB-1 | 2026-04-29 14:00 | W2 (F3) | Prototype-pollution bypass del balance-gate: `payload?.maxBudget` lee la cadena de prototipos. Fix: `Object.hasOwn(payload, 'maxBudget')` antes de leer. | Cualquier validación de input de payload desde objeto controlado por caller |
| AB-2 | 2026-04-29 14:30 | W4 (F3) | Ripple effect en tools.test.mjs: insertar lógica obligatoria INSIDE handler rompe tests legacy que llaman el handler directamente sin los nuevos pre-requisitos (KV + RPC + payload.maxBudget). Story Files futuros que inserten lógica post-probe DEBEN listar explícitamente el test surface a adaptar. | Cualquier refactor que mueva lógica de wrapper a inside-handler con tests legacy |
| AB-3 | 2026-04-29 14:45 | W4 (F3) | RPC mock: viem usa `globalThis.fetch` internamente. No se puede inyectar un `publicClient` mock vía argumento — `getAvaxClient` es singleton. Patrón correcto: interceptar `globalThis.fetch` por URL-substring (`avax.network`) + `_resetAvaxClient()` entre tests. | Cualquier test que ejercite código que pase por viem o libs HTTP que usen globalThis.fetch |
| AB-4 | 2026-04-30 (F4) | F4 QA | Decimals separation — root cause de esta HU: WKH-66 reutilizó `args.maxAmountWei` (PYUSD 18d inbound) como input del balance-gate (USDC 6d outbound). No existe valor que satisfaga ambos checks. Regla: "Params shared across guards must have same unit/decimals — distinct concerns get distinct args." CD-DEC-01 propagable a futuros SDDs. Patrón AR: grep `args.maxAmountWei` (solo en sign guard [2]) y `payload.maxBudget` (solo en balance-gate [1.5]); cross-uso = BLOQUEANTE. | Cualquier PR que modifique payment guards en `src/handlers.mjs` o `api/mcp.mjs` |

---

## Archivos modificados

Agrupados por dominio (desde commit `da12148`):

**Core payment flow (subpaquete `mcp-servers/wasiai-x402/`)**:
- `src/balance-guard.mjs` — promover `_usdcToWei` → `usdcToWei` (export público); mantener re-export en `_testHelpers`
- `src/handlers.mjs` — insertar bloque `[1.5] Balance-gate` post-probe pre-cap-guard; wrappear cap+sign+settle en `try/finally` con `releaseClaim`; update `TOOL_DESCRIPTORS.pay_x402` description + inputSchema
- `api/mcp.mjs` — eliminar función `runWithBalanceGate` completa (líneas 106-194 baseline); simplificar case `'pay_x402'` a llamada directa `payX402Handler(args, cfg)`; limpiar imports huérfanos

**Tests**:
- `tests/handlers-balance-gate.test.mjs` — NUEVO; 15 tests T-FIX-01..T-FIX-14 + T-FIX-10b
- `tests/balance-guard.test.mjs` — eliminar T-BG-11/T-BG-11b (importaban `runWithBalanceGate` eliminado)
- `tests/http.test.mjs` — actualizar T-HTTP-14: JSON-RPC body con `payload.maxBudget` en lugar de `maxAmountWei`
- `tests/tools.test.mjs` — adaptar 14 call-sites con `payload.maxBudget` + beforeEach KV/RPC mocks

**Documentación**:
- `README.md` — sección "Tools / pay_x402": documentar separación `payload.maxBudget` (USDC outbound) vs `args.maxAmountWei` (PYUSD inbound cap defensivo)

**Artefactos de pipeline (doc)**:
- `doc/sdd/072-wkh-67-balance-gate-decimals/smoke-prep.md` — NUEVO; instrucciones del smoke real mainnet para orquestador
- `doc/sdd/072-wkh-67-balance-gate-decimals/auto-blindaje.md` — NUEVO; 4 lecciones (AB-1..AB-4)

---

## Métricas del pipeline

| Métrica | Valor |
|---------|-------|
| Archivos de producción modificados | 3 (`src/handlers.mjs`, `src/balance-guard.mjs`, `api/mcp.mjs`) |
| Archivos de test modificados | 3 (`tests/balance-guard.test.mjs`, `tests/http.test.mjs`, `tests/tools.test.mjs`) |
| Archivos nuevos | 3 (`tests/handlers-balance-gate.test.mjs`, `smoke-prep.md`, `auto-blindaje.md`) |
| Total archivos tocados | 10 (commit `da12148`) |
| Tests nuevos | 15 (T-FIX-01..T-FIX-14 + T-FIX-10b) |
| Tests eliminados | 2 (T-BG-11, T-BG-11b — importaban runWithBalanceGate) |
| Baseline pre-fix | 173 (WKH-66 final) |
| Total post-fix | 186/186 passing |
| Waves completadas | 5 (W1: balance-guard export, W2: handler insert, W3: api/mcp cleanup, W4: tests, W5: docs + smoke-prep) |
| Iteraciones fix-pack | 1 (MNR-2 refinado en F4, sin retorno a F3) |
| BLQs en AR | 0 |
| MENORs cerrados | 3/3 |

---

## Post-merge gates pendientes (orquestador)

Las siguientes acciones son RESPONSABILIDAD del orquestador post-merge del PR.
NO ejecutar antes de que el PR sea mergeado a `main`.

1. **Re-deploy Vercel** (AC-11):
   ```
   vercel deploy --prod
   ```
   Verificar que el alias `wasiai-x402-mcp.vercel.app/api/mcp` apunta a un
   deploy distinto al rolled-back `wasiai-x402-ah0gufv0p`.

2. **Smoke real $0.061 USDC mainnet** (AC-12, CD-24):
   Ejecutar EXACTAMENTE UNA VEZ con autorización humana explícita.
   Body JSON-RPC documentado en `smoke-prep.md`.
   Documentar en este done-report: tx hash, URL Avalanche explorer, balance
   pre/post del operator wallet.

3. **Verificar 4 onchain txs en explorers** (post-AC-12):
   - Tx principal en Snowtrace (Avalanche C-Chain mainnet):
     https://snowtrace.io/tx/0x... [completar post-smoke]
   - Confirmar settleado con `status: 1` (success).

4. **Re-enable cron-job.org jobs** (AC-13):
   ```
   node mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs
   ```
   Jobs: `wasiai-x402-warmup` y `wasiai-x402-balance-check`.
   Verificar status activo vía dashboard cron-job.org.

5. **Update Jira WKH-67** (AC-15):
   - Adjuntar tx hash mainnet.
   - Adjuntar deploy URL Vercel (el nuevo, no el rolled-back).
   - Transicionar ticket a `Done`.

---

## Decisiones diferidas a backlog

- **WKH-68+** (sugerido): al agregar downstream chains adicionales (Base USDC,
  Polygon USDT, Arbitrum USDC), cada chain deberá tener su helper `decimalsToWei`
  por contrato y su propio argumento de balance-gate. El patrón Approach A
  (Scope IN `handlers.mjs` sección `[1.5]`) y CD-DEC-01 son la base arquitectónica
  para ese crecimiento.
- **WKH-SEC-02 / TD-SEC-01** (pre-existente): RLS real en `a2a_agent_keys` a
  nivel Postgres sigue pendiente. Esta HU no lo toca.

---

## Lecciones para próximas HUs

Extraídas del Auto-Blindaje y del proceso WKH-67:

1. **Separación dimensional de argumentos** (AB-4 / CD-DEC-01): cuando un
   handler ejecuta dos guards sobre cadenas/tokens con decimales distintos,
   cada guard DEBE tener su propia fuente de input dimensional. El class de bug
   "same arg name, two semantics" es silencioso y matemáticamente irresoluble.
   AR/CR debe grep ambos identificadores y verificar que no hay cross-uso.

2. **Story Files deben listar el surface de tests legacy** (AB-2): cuando un
   refactor mueve lógica de un wrapper externo a inside-handler, los tests
   que llamaban el handler directamente necesitan adaptación. El Story File
   debe identificar explícitamente esos test files como scope IN de W4, no
   solo la nueva suite de tests.

3. **Defense-in-depth sobre inputs controlados por caller** (AB-1): `Object.hasOwn`
   es obligatorio antes de leer propiedades de cualquier objeto recibido de un
   caller externo. `payload?.maxBudget` no es suficiente — el prototipo puede
   ser contaminado. Esto aplica a cualquier validación de payload en una
   superficie MCP/API pública.

4. **Singleton con globalThis.fetch es el contrato de mocking** (AB-3): cuando
   un módulo usa un cliente HTTP singleton (viem, otros), el único patrón de
   mock sin modificar el módulo es interceptar `globalThis.fetch` por
   URL-substring + resetear el singleton entre tests. Documentar este patrón
   en el Story File de cualquier HU que agregue lógica con llamadas RPC.

---

## Campos pendientes (completar post-merge)

> Los siguientes campos se completan cuando el orquestador ejecuta los
> post-merge gates (AC-11, AC-12, AC-15):

- PR URL: _pendiente_
- Deploy Vercel URL: _pendiente_ (reemplaza `wasiai-x402-ah0gufv0p`)
- Tx hash mainnet (smoke real): _pendiente_
- Balance operator wallet pre-smoke: _pendiente_
- Balance operator wallet post-smoke: _pendiente_
- Cron-job.org status post-re-enable: _pendiente_

---

_Generado por nexus-docs (claude-sonnet-4-6) — 2026-04-30_
_Pipeline NexusAgil QUALITY — WKH-67 DONE_
