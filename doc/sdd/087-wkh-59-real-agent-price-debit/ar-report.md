# AR Report — WKH-59 Middleware /compose real-agent-price-debit

> Date: 2026-05-14 · Reviewer: nexus-adversary · Branch: `feat/087-wkh-59-real-agent-price-debit`

## Veredict
**RECHAZADO (1 BLOQUEANTE-MEDIO + 3 MENORES)**

Implementación cumple el flujo principal (AC-1, AC-3, AC-5, AC-6, AC-7, AC-8, AC-9, AC-11 simulado) y el guard anti-double-debit (CD-11) está correctamente codificado. El blocker se concentra en una inconsistencia: el fallback honesto (CD-4) solo está implementado en el preHandler (step 0), no en steps 2..N del compose service.

---

## Bloqueantes

### BLQ-MED-1 — AC-4 / CD-4 violado en steps 2..N: `priceUsdc === 0` no dispara fallback en compose service

**Archivo:línea**: `src/services/compose.ts:127-146`

Work-item AC-4: "WHEN `priceUsdc` del agente es `null`, `undefined`, o `0`, THEN el sistema SHALL debitar $1.00 placeholder, emitir warn log con `reason: 'registry-miss'`, y añadir header `x-debit-fallback: registry-miss`."

El Dev implementó este fallback solo en el preHandler de step 0 (`src/routes/compose.ts:63-77`). Para steps 2..N, el código en `src/services/compose.ts:127-146` debita `agent.priceUsdc` directamente sin fallback:

```typescript
if (i > 0 && scopingKeyRow && chainId !== undefined) {
  const debitResult = await budgetService.debit(
    scopingKeyRow.id,
    chainId,
    agent.priceUsdc,  // ← raw value, sin fallback ni warn cuando es 0/null
  );
}
```

**Reproducción**:
1. Registrar agente `free-bug` con `priceUsdc=0`.
2. `POST /compose` con `steps: [{agent: 'kyc'}, {agent: 'free-bug'}]`.
3. Esperado AC-4: debit step 1 = $1, warn log, header `x-debit-fallback`.
4. Real: debit step 1 = $0, sin warn, sin header.

**Impacto**: AC-4 violado parcialmente; CD-4 violado (silent fallback); operators no monitorean configuración rota en steps 2..N.

**Remediación**:
```typescript
if (i > 0 && scopingKeyRow && chainId !== undefined) {
  const isInvalid = !agent.priceUsdc || agent.priceUsdc === 0;
  const debitAmount = isInvalid ? 1.0 : agent.priceUsdc;
  if (isInvalid) {
    request.log?.warn(
      { reason: 'registry-miss', slug: agent.slug, step: i },
      'compose-price.fallback per-step',
    );
  }
  const debitResult = await budgetService.debit(scopingKeyRow.id, chainId, debitAmount);
  // ...
}
```

Agregar tests:
- `T-COMPOSE-DEBIT-7`: priceUsdc=0 en step 1 → debit $1.00 (no $0).
- `T-COMPOSE-DEBIT-8`: warn log emitido con `reason: 'registry-miss'`.

---

## Menores (backlog / SDD doc)

### MNR-1 — Cache thundering herd
`src/services/agent-price.ts:40-63` — Sin single-flight. 100 concurrent cold misses → 100 discovery calls.
Remediación: single-flight con `Map<string, Promise<number|null>>` para in-flight promises.
**Estado**: backlog (no bloquea DONE).

### MNR-2 — Cache key con `registry === ''` no normalizado
`src/services/agent-price.ts:19-23` — `registryName === ''` produce key distinta a `undefined`.
Remediación: `registryName?.trim() || undefined` antes de armar clave.
**Estado**: backlog.

### MNR-3 — `/orchestrate` no propaga `chainId` → per-step debits SKIPPED
`src/services/orchestrate.ts:405-410` — Asimetría económica entre /compose y /orchestrate.

**Decisión documentada como DT-I en SDD** (no expandir scope WKH-59):
- `/orchestrate` mantiene placeholder $1 — está cubierto por AC-7 ("/discover, /orchestrate fuera de scope").
- Follow-up: HU futura WKH-XX puede portar el patrón a `/orchestrate`.

**Estado**: backlog + DT-I a documentar en SDD.

---

## Verificado OK

| # | Vector | Estado | Defensa archivo:línea |
|---|--------|--------|----------------------|
| 1 | Double-debit step 0 | OK | compose.ts:127 (guard `i > 0`) + T-COMPOSE-DEBIT-6 |
| 4 | owner_ref leak | OK | compose.ts:84-89 (logs sin owner_ref) |
| 6 | chainId desync (DT-D, CD-12) | OK | a2a-key.ts:235 (mismo bundle, sin re-resolve) |
| 7 | TTL expiry edge | OK | agent-price.ts:48 (strict gt) |
| 8 | Negative caching forbidden (DT-G) | OK | agent-price.ts:54-58 + T-PRICE-4 |
| 9 | Body parsing malformado | OK | compose.ts:36-46 (guards defensivos) |
| 10 | Backward compat gasless (AC-6) | OK | a2a-key.ts:133-138 + T-MW-GASLESS-1/2 |
| 11 | /discover sin auth/debit | OK | sin middleware aplicado |
| 12 | Test patterns auto-blindaje | OK | mockImplementation by slug correcto |

---

## Fix-pack priority para iter 2 del Dev

1. **BLQ-MED-1** — añadir fallback $1 + warn log para `agent.priceUsdc === 0/null` en `compose.ts:127-146` + tests T-COMPOSE-DEBIT-7/8.
2. **MNR-3** — documentar DT-I en SDD (NO modificar `/orchestrate`).
3. MNR-1, MNR-2 → backlog post-DONE.

**Base test suite**: 938 / 938 PASS (no regresión).
