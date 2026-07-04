# Done Report — WKH-143b — Write-path de creator/referral

**Status**: DONE  
**Date**: 2026-07-04  
**Branch**: `feat/147-wkh-143b-split-writepath`  
**Head**: 8363a1b  
**PR**: #168 (MERGEABLE, sin mergear aún)

---

## Resumen ejecutivo

WKH-143b cierra el **seam dormido de WKH-143**: activa el **write-path** del creator-split agregando captura, validación y persistencia de `payoutWallet`+`referrerRef` en `POST`/`PATCH /agents` (publish self-serve de agentes).

**Entrega funcional crítica**: con un agente self-published que setea su `payout_wallet` válido + `SPLIT_BPS_CREATOR > 0` configurado en Railway, el creador **cobra de verdad** (1% del fee de cada invocación — el read-side de WKH-143 ya enruta correctamente).

**Limitación de producto**: `referrer_ref` se persiste **opaco e inerte** — el referral sigue 100% a plataforma porque `resolveAgentSplitContext` no lo lee. Eso requiere WKH-143c (decisión humana pendiente sobre semántica y resolución de wallet del referrer).

**Evidencia**: 2628 tests (PASS), CI 5/5, zero migrations (columnas ya en prod testnet), anti-leak garantizado por construcción, ownership guard reutilizado sin code path nuevo.

---

## Pipeline ejecutado

| Fase | Gate | Status | Artefactos | Notas |
|------|------|--------|-----------|-------|
| **F0** | — | ✅ DONE | context cargado (sdd.md line 56-94) | Grounding contra código real: 11 archivos leídos + 6 symbols verificados |
| **F1** | HU_APPROVED | ✅ DONE | `work-item.md` (8 ACs EARS, 13 DTs/CDs) | Scope IN/OUT nítido, 4 riesgos mitigados |
| **F2** | SPEC_APPROVED | ✅ DONE | `sdd.md` (full mode, section 4.1 tablas: 11 archivos a tocar, exemplars verificados) | Readiness check OK: ACs ↔ archivos ↔ exemplars 1:1 |
| **F2.5** | — | ✅ DONE | `story-HU-143b.md` (contrato compilado: W0/W1/W2 + 9 archivos scope IN, checklist anti-hallucination) | NO releas SDD — todo en el story file |
| **F3** | — | ✅ DONE | 3 waves (W0 tipos+validador, W1 rutas+service, W2 12 tests), 2 archivos creados, 7 modificados | Implementación: 2628 tests PASS, npm build OK (TypeScript strict, sin `any`), biome clean |
| **AR** | — | ✅ OK | 1 MENOR (test robustez: anti-leak a nivel serializador real `mapRowToRecord`) | Anti-leak garantizado por construcción (AgentRow/mappers no declaran los campos), es robustez, no bug. Aceptado como deuda técnica (issue para WKH-143d propuesto). |
| **CR** | — | ✅ OK | 0 MENOR, 0 BLOQUEANTE | Ownership guard cableado correctamente, anti-leak verificado por grepeo de shapes públicas, validador EVM único, money-path intacto, byte-idéntico default |
| **F4** | PASS | ✅ DONE | CI 5/5, 2628 tests PASS, biome clean | ACs 1-8 cubiertos (≥1 test/AC); AC-7 (creator cobra) ejercitado al nivel read-side; CD-8 byte-idéntico con default `10000/0/0` verificado |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia | Detalle |
|---|--------|----------|--------|
| **AC-1** | ✅ PASS | Story File W2.2, test 3 (persistencia POST) | POST con `payoutWallet` válido (40 hex) → inserta en `a2a_agents.payout_wallet` |
| **AC-2** | ✅ PASS | Story File W2.3, test 8 (PATCH ownership) | PATCH owner propio con `payoutWallet` → 200, `state.updateCalled` true, otros campos intactos |
| **AC-3** | ✅ PASS | Story File W2.2/W2.3, tests 5/9 (422 payoutWallet) | POST/PATCH con `payoutWallet` inválido (`''`, no-EVM, no-string) → **422**, sin insert/update |
| **AC-4** | ✅ PASS | Story File W2.2, test 4 (trim referrerRef) | POST con `referrerRef: '  ref-abc  '` → persiste `'ref-abc'` (trimmeado) en `a2a_agents.referrer_ref` |
| **AC-5** | ✅ PASS | Story File W2.4, test 12 (byte-idéntico) | POST sin `payoutWallet` + default `10000/0/0` → columna NULL, `splitsActive()` false, sin creator (byte-idéntico a hoy) |
| **AC-6** | ✅ PASS | Story File W2.3, test 10 (cross-owner 404) | owner B hace PATCH slug de owner A con `payoutWallet` → **404**, `state.updateCalled` false, nada persistido |
| **AC-7** | ✅ PASS | Story File W2.4, test 11 (integración AC-7) | mock `getSplitContextRow` devolviendo `payoutWallet: '0x...'` → `resolveAgentSplitContext` arma `creator` con esa wallet; con `SPLIT_BPS_CREATOR > 0`, resolve `creator` leg real (sin código nuevo en el money-path de cobro — WKH-143 ya lo hace) |
| **AC-8** | ✅ PASS | Story File W2.2, test 7 (anti-leak 201) | POST/PATCH responden 201/200 **sin** exponer `payout_wallet`, `referrer_ref`, `payoutWallet`, `referrerRef` en el body |

---

## Entrega funcional

### ✅ Creator splits **activa de verdad**

Con esta HU, un creador de agente self-published puede:
1. `POST /agents` o `PATCH /agents/:slug` incluyendo `payoutWallet: "0x..."` (address EVM válida).
2. Setear `SPLIT_BPS_CREATOR > 0` en Railway/env de a2a.
3. **En la siguiente invocación cobrada de ese agente**, el 1% protocol fee se rutea:
   - Creador: `SPLIT_BPS_CREATOR` bps a `payout_wallet` (ahora no-null, no-dummy).
   - Plataforma: resto (10000 - SPLIT_BPS_CREATOR) bps como hoy (SG-6).
   - Referral: **0** (inerte, ver abajo).

**Mecanismo**: `chargeProtocolFee` → `resolveAgentSplitContext` (WKH-143, sin cambios) → llama `publishedAgentService.getSplitContextRow(slug)` → lee `payout_wallet` persistida vía esta HU → `resolveRecipients(creatorBps>0)` → genera leg `creator` con la wallet real.

### 🟠 Referral **persiste pero queda INERTE** (por diseño)

`referrer_ref` se persiste correctamente (opaco, trimmeado, ≤200 chars), pero:
- `resolveAgentSplitContext` (WKH-143) sigue hardcodeando `referral: null` (línea 48, 69).
- Consecuencia: aunque se persista, el split de referral NO se activa — 0% de plataforma a un `referrer_ref`.

**Por qué**: la semántica de `referrer_ref` sigue sin resolver (ver Missing Inputs en work-item.md):
- ¿Es un `owner_ref` de otro creador (cuya wallet se buscaría en su PROPIA fila `a2a_agents.payout_wallet`)?
- ¿Es un código de afiliado libre (sin concepto de owner en a2a)?
- ¿Quién negocia el `SPLIT_BPS_REFERRAL` — el creador, o es fijo por plataforma?

**Decisión del user**: define la semántica + implementá la resolución `referrer_ref → wallet` en una **WKH-143c** separada.

---

## Anti-leak consolidado (por construcción)

| Aspecto | Mecanismo | Veredicto |
|---------|-----------|-----------|
| **Columnas no en `AgentRow`** | `AgentRow` (`:42-53`) omite `payout_wallet`/`referrer_ref` | ✅ Construcción pura (no add) |
| **Mappers field-by-field** | `mapRowToRecord` (`:129-148`) NO incluye los campos | ✅ Omisión explícita = anti-leak |
| **Respuestas públicas** | POST 201, PATCH 200, GET /agents list-mine, agent-card, /discover | ✅ Verificado por grepeo CR |
| **Test de regresión** | W2.2 test 7 asserta que 201 NO contiene los campos (mappers tested) | ✅ Test coverage |

**Nota AR MENOR acumulable para WKH-143d**: un test adicional que ejerce `mapRowToRecord` con una fila real que TRAIGA los campos (ej., fila de insert sin mapear antes) y confirme que mappers los omiten → deuda técnica aceptada (constructivo, robustez, no bug).

---

## Ownership guard (reutilizado sin code path nuevo)

| Método | Patrón | Garantía |
|--------|--------|----------|
| **POST** | `publish(input, keyRow.owner_ref)` → insert con `owner_ref` del caller | ✅ AC-1: nuevo agente propiedad de caller |
| **PATCH** | `update(slug, body, keyRow.owner_ref)` → pre-fetch slug → assert `row.owner_ref === ownerRef` → UPDATE filtrado `.eq('owner_ref', ownerRef)` (`:480-481`) | ✅ AC-2/AC-6: solo el owner setea SU agente, cross-owner → 404 disclosure-safe |

CD-2 (CLAUDE.md Ownership Guard): **100% cumplido**. `updateRow.payout_wallet` se asigna **DESPUÉS** del guard de ownership (`:445-458`), heredando la protección del `.eq('owner_ref', ownerRef)` ya existente. PROHIBIDO un code path que bypasee.

---

## Validador EVM compartido (`src/lib/wallet-format.ts`)

| Aspecto | Solución | Veredicto |
|---------|----------|-----------|
| **Regex único** | `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` extraído a `lib/wallet-format.ts` (CD-1) | ✅ Single source of truth |
| **Reutilización** | `fee-split.ts` importa `isValidWallet` de `lib/wallet-format.ts` (no más `ADDRESS_RE` privado) | ✅ Evita tercer duplicado |
| **Semántica** | `resolveRecipients` sigue llamando `isValidWallet(party.wallet)` — comportamiento byte-idéntico (CD-7) | ✅ Money-path intacto |
| **Coverage** | `lib/wallet-format.test.ts` testa validación EVM: acepta 40 hex, rechaza `''`, corta/larga, no-hex, `null`, `undefined` | ✅ Unit coverage CD-1 |

---

## Hallazgos finales consolidados

### Bloqueantes
Ninguno. AR/CR ambos pasaron sin BLOQUEANTE. Pipeline limpio.

### Menores (Aceptado como deuda de backlog)
| Tipo | Descripción | Ticket propuesto | Decisión |
|------|-------------|------------------|----------|
| **AR MENOR** | Anti-leak test de serializador real (mapRowToRecord con fila que traiga los campos) | WKH-143d | Aceptado; robustez, constructivo, no bug |
| **Refactor futuro** | Consolidar el regex de wallet EVM en TODOS los adapters (+13 más) — hoy W0.2 solo migrá fee-split | WKH-WALLET-REFACTOR (backlog) | Fuera de scope; issue abierto para posteridad |

---

## Validador EVM (CD-1 Anti-Alucinación)

```typescript
// src/lib/wallet-format.ts (NUEVO)
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidWallet(wallet: string | null | undefined): wallet is string {
  return typeof wallet === 'string' && ADDRESS_RE.test(wallet);
}
```

**Importado por**:
- `src/services/fee-split.ts` (money-path, resolveRecipients)
- `src/routes/agents.ts` (write-boundary, POST/PATCH guard 422)

**Criterio verificado**: exactamente el mismo que `resolveRecipients` (WKH-143, línea 217) y `verifyDefaultChainSettle`. PROHIBIDO validadores paralelos con checksum EIP-55, longitud distinta, etc.

---

## Byte-idéntico default (CD-8)

| Config | Comportamiento | Veredicto |
|--------|-----------------|-----------|
| Default `SPLIT_BPS_CREATOR` ausente/vacío/0 | `splitsActive()` → false; creator leg → null; plataforma 100% | ✅ Test W2.4 test 12 |
| POST sin `payoutWallet` en body | `a2a_agents.payout_wallet` → NULL | ✅ AC-5 |
| PATCH sin `payoutWallet` en body | `a2a_agents.payout_wallet` sin tocar (merge parcial) | ✅ AC-5 |
| Resultado final | 0 queries extra, 0 cambios en dinero-path de cobro, columnas NULL → sin creator | ✅ Disciplina WKH-143 respetada |

---

## Archivos modificados / creados

| Acción | Archivo | Líneas | Cambios |
|--------|---------|--------|---------|
| **Crear** | `src/lib/wallet-format.ts` | ~20 | `ADDRESS_RE` + `isValidWallet` (leaf puro, sin deps) |
| **Crear** | `src/lib/wallet-format.test.ts` | ~30 | 2 tests (válida/inválida) |
| **Modificar** | `src/services/fee-split.ts` | 2 (import + removing privates) | Reemplazar `ADDRESS_RE`/`isValidWallet` por import |
| **Modificar** | `src/types/index.ts` | 4 líneas | `PublishAgentInput` += `payoutWallet?: string; referrerRef?: string;` |
| **Modificar** | `src/types/index.ts` | 4 líneas | `UpdateAgentInput` += ídem |
| **Modificar** | `src/routes/agents.ts` | ~20 | Helpers `isValidPayoutWallet` / `isValidReferrerRef` + guards 422 (POST + PATCH) + captura condicional |
| **Modificar** | `src/services/agent.ts` | ~20 | Asserts `assertValidPayoutWallet` / `assertValidReferrerRef` + persistencia condicional en `publish()` + `update()` |
| **Modificar** | `src/routes/agents.publish.test.ts` | ~50 | 5 tests (AC-1, AC-4, AC-3, AC-4, AC-8) |
| **Modificar** | `src/routes/agents.ownership.test.ts` | ~50 | 3 tests (AC-2, AC-3, AC-6) |
| **Modificar** | `src/services/agent-split-context.test.ts` | ~50 | 2 tests (AC-7 integración + DT-4 inerte + CD-8 byte-idéntico) |

**Total**: 2 archivos creados, 7 modificados. SIN migración (columnas ya en prod testnet).

---

## Auto-Blindaje consolidado

| Dimensión | Lección | Fuente | Aplicación en WKH-143b |
|-----------|---------|--------|------------------------|
| **Byte-idéntico default** | WKH-136 aprendió que `SPLIT_BPS_CREATOR=0` → cero código nuevo en money-path. Disciplina rígida. | `138-wkh-136-atomic-splits-bps/auto-blindaje.md` | CD-8 codifica exactamente esto: default `10000/0/0` byte-idéntico a hoy, verificado por test. |
| **Money-path frágil** | WKH-136 sufrió mocks supabase inestables ante cambios en `.eq()`. NO tocar `fee-charge.test.ts`. | Aprendizaje en-proceso | W2.4 ejerce AC-7 (creator cobra) al nivel read-side (`agent-split-context.test.ts`), NO reescribiendo el frágil mock money-path. |
| **Validador compartido NO es trivial** | Duplicación de `ADDRESS_RE` en 2+ sitios = source-of-truth débil. Extraer a `lib/`. | Diseño defensivo de WKH-143b | DT-1/CD-1: `src/lib/wallet-format.ts` como single source de verdad. W0.2 verifica que `fee-split.test.ts` siga verde (comportamiento byte-idéntico de `resolveRecipients`). |
| **Ownership guard: tictac de RFC** | WKH-143 + CLAUDE.md Security Conventions (Ownership Guard) definen el patrón. Reuso sin code path nuevo. | CLAUDE.md raíz | CD-2: `update()` guard pre-existente (`:409-426`, `.eq('owner_ref', ownerRef)`) se reutiliza sin cambios. `updateRow.payout_wallet` asignado DESPUÉS del guard → hereda la protección. |
| **Anti-leak por construcción** | Omitir un campo de `AgentRow`/mappers es más seguro que un test que lo verifica. | Patrón WKH-143 | `AgentRow`/`PublishedAgentRecord` NO incluyen `payout_wallet`/`referrer_ref`. Mappers field-by-field = garantía de omisión. Test de regresión verifica que 201 no lo expone. |
| **Clarificación heredada` | `referrer_ref` tiene 2+ semánticas posibles, sin resolver desde WKH-143 Missing Inputs #2. Diferir a HU separada. | `work-item.md` Missing Inputs | DT-4/CD-6: esta HU persiste el string opaco, **NO lo resuelve**. Referral inerte por diseño (SG-6). WKH-143c (future) define la semántica + activá la lectura. DONE report comunica honestamente esta limitación. |

---

## Decisiones diferidas a backlog

| Ticket | Descripción | Tipo | Precedencia |
|--------|-------------|------|-------------|
| **WKH-143c** | Activar referral: definir semántica `referrer_ref` + resolver `referrer_ref → wallet` + actualizar `resolveAgentSplitContext` para dejar de hardcodear `referral: null` | feature | P1 (depende de human clarification Missing Input #2) |
| **WKH-143d** | Test robustez: anti-leak a nivel serializador (mapRowToRecord con fila que traiga los campos) | tech-debt | P2 (aceptado como MENOR AR) |
| **WKH-WALLET-REFACTOR** | Consolidar `ADDRESS_RE` en TODOS los adapters (+13 más usan regex duplicado) | refactor | P3 (backlog, no bloqueante) |
| **WKH-142-OPERATIONALIZATION** | Setear `SPLIT_BPS_CREATOR > 0` en Railway prod (testnet) para que creadores comiencen a cobrar | operación | Bloqueado en user (requiere `RAILWAY_TOKEN` y decisión de política de split) |

---

## Lecciones para próximas HUs

1. **Validador EVM: single source of truth**: cuando un regex se duplica en 2+ sitios, extraer a `lib/` inmediatamente en F0/F2. Previene olvidos en refactors futuros y source-of-truth-drift.

2. **Money-path: no tocar sin need absoluto**: los tests de dinero (`fee-charge.test.ts`, `fee-charge-splits.test.ts`) tienen mocks muy acoplados a estructura interna de Supabase. Las HUs que afecten el read-side (`resolveAgentSplitContext`) deben ejercitar AC-7 al nivel read-side (con `mockGetSplitContextRow`), no reescribiendo el dinero-path tests.

3. **Ownership guard: patrón reusable**: el guard de `publishedAgentService.update()` (pre-fetch + `.eq('owner_ref', ownerRef)`) es reutilizable sin modificación para CUALQUIER nuevo campo. No agregar code path paralelo — asigna condicional **después** del guard, herada la protección.

4. **Anti-leak por omisión > test defensivo**: omitir un campo de los shapes públicos (`AgentRow`, `PublishedAgentRecord`, mappers) es una **garantía constructiva** más fuerte que un test. El test verifica el comportamiento actual, pero una refactor futura puede quebrarlo. La omisión es "fail-closed": si alguien agrega el campo a la lista en el futuro sin pensar, sigue siendo expuesto, pero el tipo requeriría cambio explícito — menos silencioso.

5. **Referral diferido es honesto**: perseverar en `referrer_ref` opaco + inerte es mejor que inventar una semántica (ej., "es un owner_ref") y descubrir en producción que era equivocada. La HU clara que dice "esto persiste pero no se activa, WKH-143c resuelve" facilita conversación humana sobre el modelo real.

---

## CI/CD Status

- **TypeScript strict**: ✅ `npm run build` PASS (sin `any` explícito)
- **Linting**: ✅ `biome check` PASS
- **Unit tests**: ✅ 2628 tests PASS (12 nuevos + suite existente)
- **CI**: ✅ 5/5 checks PASS
- **Migration**: ✅ SIN migración (columnas ya en prod testnet, tipadas en `database.types.ts`)

---

## Status final

**PR #168**: MERGEABLE. Sin mergear aún (decisión de orquestador).

**Branch**: `feat/147-wkh-143b-split-writepath` — HEAD 8363a1b — listo para pasar a main.

---

*Done Report generado por nexus-docs — WKH-143b cierre de pipeline · 2026-07-04*
