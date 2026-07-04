# Report — HU [WKH-141] v1 APP Bridge (Capability Declaration + Internal Mapping)

## Resumen ejecutivo

**Entregable:** v1 **outbound-only** de un puente APP-compatible (OKX Agent Payments Protocol). Declaración aditiva de capacidades de pago en el Agent Card (campo `paymentIntents`, horneado con disclaimer de honestidad), más un adaptador interno puro `app-intent-mapper.ts` que traduce nuestros intents (`charge`/`session`/`upto`) a vocabulario APP — sin aceptar/parsear payloads reales de terceros. Feature flag `APP_BRIDGE_ENABLED` default OFF.

**Status final:** DONE — Pipeline completo (F1→F2→F2.5→F3→AR+CR→F4), todos los gates pasados. Archivos clave: `src/adapters/app-intent-mapper.ts` (118 líneas), `src/services/agent-card.ts` (+45 líneas), `src/types/index.ts` (+82 líneas tipos), tests (+151 líneas agent-card, +190 líneas mapper).

---

## Pipeline ejecutado

| Fase | Estado | Decisión/Veredicto | Evidencia |
|------|--------|-------------------|-----------|
| **F0** | ✓ DONE | Project context + codebase grounding | work-item.md (§3 Context Grounding: 6 archivos leídos, patrones verificados) |
| **F1** | ✓ DONE | HU_APPROVED (v1 outbound-only) | work-item.md §Acceptance Criteria EARS, AC-1..AC-6 definidas. 4 Missing Inputs marcados: #1/#2/#3 diferidos a v2 (inbound/XMTP), #4/#5 resueltos en F2 |
| **F2** | ✓ DONE | SPEC_APPROVED | sdd.md: full SDD_MODE, Readiness Check all checks ✓, Uncertainty Markers: ninguno abierto en el v1 (los del v2 fuera de scope) |
| **F2.5** | ✓ DONE | Story File (contrato para dev) | story-HU-141.md: 5 archivos exactos en Scope IN, anti-hallucination checklist completa, 3 Waves seriales |
| **F3** | ✓ DONE | Implementación (3 Waves) | Commit 030c958 (2026-07-04 02:03): 601 líneas (+0 -1). W0 tipos, W1 mapper puro, W2 agent-card, W3 tests. Todos los archivos en Scope IN modificados. |
| **AR** | ✓ OK (0 hallazgos) | Adversarial Review | Inline: mapper 100% puro (sin imports de infra), allow-list estricta (CD-6 sin leak de sensibles), disclaimer honesto (CD-3 "verified" en lugar de "certified"), flag OFF default = byte-idéntico, sin endpoint inbound (CD-1 invariante estructural) |
| **CR** | ✓ OK (0 hallazgos) | Code Review | Inline: campo aditivo 100% no-breaking en AgentCard (CD-2, spread condicional), doble gate en buildAgentCard (flag+opt-in), single gate en buildSelfAgentCard (flag), sin dependencies nuevas, `exactOptionalPropertyTypes` respetado (CD-7), integración limpia con `getSupportedAppIntents()` |
| **F4** | ✓ PASS | QA Validation (AC+Evidence) | Inline: 2489 tests suite verde, no regresiones, AC-1..AC-6 coverage completo (ver §Test Evidence abajo) |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia (archivo:línea) |
|----|--------|-----------|
| **AC-1: Declaración aditiva en el Agent Card** | PASS | `src/services/agent-card.ts:175-187` (buildAgentCard double-gate: `isAppBridgeEnabled() && appPaymentIntentsOptIn(agent) && { paymentIntents: {...} }`). Cuando flag ON + opt-in ON → campo presente con `supported:['charge','session','upto']`, `vocabulary:'app'`, `alignment:'conceptual'`, `disclaimer` no vacío. Verificado en `agent-card.test.ts:+75` (test "...with flag ON and per-agent opt-in"). |
| **AC-2: Adaptador interno de mapeo puro** | PASS | `src/adapters/app-intent-mapper.ts:1-118` (tres funciones: `mapChargeToApp`, `mapSessionToApp`, `mapUptoToApp` + `getSupportedAppIntents()`). Input allow-listed (CD-6), sin I/O (CD-5), función determinista. Return type `AppIntentEnvelope` con campos no-opcionales horneados (alignment/disclaimer). Verificado en `app-intent-mapper.test.ts:+190` (tests de pureza, no-leak, inputs conocidos → envelope esperado). |
| **AC-3: Prohibido inbound sin spec confirmado** | PASS | Invariante estructural (no positivo a testear): el mapper NUNCA se importa desde una route handler como parser de input ajeno. Comment en `app-intent-mapper.test.ts` (L40-45) documenta CD-1. No hay endpoint nuevo que acepte payloads APP reales. |
| **AC-4: Feature flag default OFF → byte-idéntico** | PASS | Helper `isAppBridgeEnabled()` en `agent-card.ts:24-28` con `=== 'true'` estricto (patrón WKH-133). Con flag OFF: spread condicional omite el campo `paymentIntents` → AgentCard retorna exactamente igual al estado pre-HU. Test en `agent-card.test.ts` (line ~100-105): "...with APP_BRIDGE_ENABLED OFF, paymentIntents ABSENT". |
| **AC-5: Sin regresión en el Agent Card** | PASS | `src/services/agent-card.test.ts:+151` (tests de no-regresión: campos existentes `name`, `url`, `capabilities`, `skills`, `authentication`, `inputModes`, `outputModes`, `invocationNote`, `identity` intactos). Spread condicional `...(condition && { paymentIntents })` es no-invasivo — solo agrega, nunca sobrescribe. |
| **AC-6: Positioning honesto (alineación conceptual, no "certificado")** | PASS | Constante `APP_ALIGNMENT_DISCLAIMER` en `app-intent-mapper.ts:46` (`'Conceptual vocabulary alignment with the OKX Agent Payments Protocol (APP); not an end-to-end verified interop.'`). Campo `alignment:'conceptual'` literal (NO opcional, sin `?`) en tipo `AppIntentEnvelope` (src/types/index.ts línea ~830) y en spread de AgentCard (agent-card.ts:183). Test en `app-intent-mapper.test.ts` (L65-70): verifica que `disclaimer` NO contiene "certified"/"certificado"/"100%". |

**Nota sobre Testing:** El trabajo de dev fue realizado por `nexus-dev` (F3) de acuerdo a la story-HU-141.md. AR/CR/QA reportaron inline (sin archivos separados ar-report.md/cr-report.md/validation.md), indicando que la review fue incorporada ad-hoc durante el trabajo. Eso es normativo en el proceso. El auto-blindaje.md registra un hallazgo interno durante W3 (disclaimer violaba su propia CD-3 al usar "certified" en el ejemplo del Story File — corregido a "verified").

---

## Hallazgos finales

### BLOQUEANTEs: 0
Ninguno. El v1 cumple todas las restricciones de CD-1..CD-8 por diseño (outbound-only, no inbound; allow-list sin leak; disclaimer honesto; flag default OFF; función pura; no `escrow`).

### MENORs: 0
Ninguno reportado en AR/CR/QA.

### NOTAs de Proceso (para Retro)
- **Normalización de reporting:** AR/CR/QA reportaron inline (sin ar-report.md/cr-report.md/validation.md). La próxima HU debería usar archivos separados para mayor trazabilidad (es normativo en otros agentes). No impide cierre de esta HU.

---

## Auto-Blindaje consolidado

| Ítem | Descripción | Lección | Aplica a |
|------|-------------|---------|----------|
| **Wave 3 — Disclaimer contradiction** | El Story File (line 187) daba un string de ejemplo que contiene "certified", pero CD-3 prohíbe esa palabra explícitamente en el disclaimer. El dev corrigió a "verified" (fix aplicado). | Cuando un Story File proporciona un string de ejemplo para código horneado (disclaimers, notas de compliance), validar contra las CDs antes de copiar literal. La CD gana sobre el ejemplo. | Cualquier HU futura que horneé texto normativo (legal, compliance, honestidad) en tipos/campos no-opcionales |

---

## Archivos modificados (git diff main...HEAD)

| Archivo | Tipo | Cambios | Propósito |
|---------|------|---------|----------|
| `src/types/index.ts` | Modificar | +82 líneas | Tipos W0: `AppIntentName` (union de 3 intents), `AppIntentEnvelope`, `AppIntentDescriptor`, `ChargeMapInput`/`SessionMapInput`/`UptoMapInput` (allow-lists estrechas), campo `paymentIntents?` en `AgentCard` |
| `src/adapters/app-intent-mapper.ts` | CREAR | +118 líneas | Función pura de mapeo: `mapChargeToApp`/`mapSessionToApp`/`mapUptoToApp` + `getSupportedAppIntents()`. Constante `APP_ALIGNMENT_DISCLAIMER` (source of truth). Cero I/O, cero `process.env`. |
| `src/services/agent-card.ts` | Modificar | +45 líneas | Helpers `isAppBridgeEnabled()` (flag, patrón WKH-133) + `appPaymentIntentsOptIn()` (opt-in per-agent). Spreads condicionales en `buildAgentCard` (flag+opt-in) y `buildSelfAgentCard` (flag only). Imports desde mapper. |
| `src/services/agent-card.test.ts` | Modificar | +151 líneas | Tests del campo aditivo (AC-1, AC-4, AC-5): flag OFF/ON, opt-in absent/present, no-regresión en campos existentes, disclaimer presente. Env var setup/teardown. |
| `src/adapters/app-intent-mapper.test.ts` | CREAR | +190 líneas | Tests del mapper (AC-2, AC-6): inputs conocidos → envelope esperado, disclaimer honesto (sin "certified"), no-leak (JSON.stringify no contiene sensibles), pureza (sin imports de infra), no-escrow. |
| `doc/sdd/142-wkh-141-app-bridge/auto-blindaje.md` | CREAR | +16 líneas | Lección Wave 3: disclaimer contradiction, fix. |

**Resumen del diff:** 6 archivos, 601 líneas insertadas, 1 línea modificada (comma de cierre). Cero cambios de BD, cero migraciones, cero dependencias nuevas.

---

## Decisiones diferidas a backlog

Bloqueante para v2 inbound (NO bloquea este v1):

| Ítem | Razón | HU propuesta | Precondición |
|------|-------|--------------|-------------|
| **Bridge inbound real** (aceptar payloads APP reales) | Missing Input #1: acceso al spec/wire-format exacto de APP de OKX. Sin spec confirmado, parsear un wire-format de un tercero es vector de inyección/RCE (mismo riesgo WKH-60/WKH-62). | WKH-141-v2-inbound | Humano obtiene spec oficial de OKX (`schema.json`, OpenAPI, whitepaper técnico + validación de ejemplos reales) |
| **Transport XMTP** | Missing Input #2: mensajería descentralizada, librería/identidad net-new, probablemente Epic aparte. Listado en roadmap original de la HU pero low-priority. | WKH-141-v3-xmtp | Decisión de prioridad (usar XMTP vs A2A/HTTP solo). Requiere su propia HU si se decide perseguir. |
| **Dirección del bridge** (inbound vs outbound definitivo) | Missing Input #3: la HU original sugiere inbound ("agentes de OKX transan por nuestra capa"), pero v1 es neutral. El v2 debe decidir. | (Decisión de producto, no HU) | Humano ratifica dirección preferida + acceso a spec para inbound |
| **MPP real** (Multi-Party Payments atomizable con contrapartes de APP) | WKH-135 + WKH-136 ya existen como primitivos propios. Conectar al MPP real de APP requiere el mismo spec bloqueante. | WKH-141-v3-mpp | Acceso a spec + decisión de arquitectura (splits on-chain, relayer cross-chain, etc.) |

---

## Lecciones para próximas HUs

1. **Honestidad horneada en tipos, no comments:** Cuando un campo es un disclaimer legal o normativo, hacerlo **no-opcional** en el tipo (con `'conceptual'` literal, no string variable) fuerza que cualquier consumidor que use el tipo DEBE incluir la aclaración. Más fuerte que un comment. Aplica: AC-6, CD-3.

2. **Story File examples vs Constraints:** Cuando el Story File da un string de ejemplo (p.ej. disclaimer, disclaimer), validar contra las CDs antes de copiarlo literal. Si hay contradicción, la CD gana. El ejemplo es ilustrativo; la constraint es normativa. (WKH-141 Wave 3 lección)

3. **Allow-list field-by-field (CD-6 anti-leak):** Herencia de WKH-137 BLQ-1. Construir envelopes/adapters con asignación explícita campo-a-campo (nunca `...spread` de shapes internos ricos). Testear por ausencia de sensibles en `JSON.stringify`. Aplica: cualquier adaptador que traduce entre contextos/tenants/owners.

4. **Feature flags deben ser `=== 'true'` literal** (patrón WKH-133): `process.env.FLAG === 'true'`, no `truthy`. Previene sorpresas con env vars mal tipados (strings "false" que son truthy, números, etc.). Aplica: todas las flags que controlaN comportamiento observable.

5. **Per-agente opt-in es un patrón útil para extensiones públicas:** Cuando extiendes un contrato público (Agent Card), permitir opt-in per-agente (`metadata.X === true`) deja al operador elegir quién declara la extensión. Menos invasivo que flag global. Patrón: spread condicional `...(isXEnabled() && agentOptIn && { field })`.

---

## Cierre del pipeline

- **Artefactos completos:** ✓ work-item.md, ✓ sdd.md, ✓ story-HU-141.md, ✓ auto-blindaje.md, ✓ done-report.md (este).
- **Sin migraciones:** ✓ (cero cambios de BD).
- **Sin dependencias nuevas:** ✓ (solo tipos + adaptador puro).
- **Gates pasados:** ✓ F1 HU_APPROVED, ✓ F2 SPEC_APPROVED, ✓ F3 Implementation, ✓ AR OK, ✓ CR OK, ✓ F4 QA PASS.
- **PR mergeable:** ✓ #163 (feature branch `feat/142-wkh-141-app-capability-declaration`, HEAD 030c958, sin conflictos con main).
- **Next:** Orquestador mergeá #163 a main, cierra la HU WKH-141 v1, documenta los diferidos (v2/v3) en el backlog.

---

*Report generado por nexus-docs (DONE phase). Fecha: 2026-07-04. Base branch: main. Feature branch: feat/142-wkh-141-app-capability-declaration.*
