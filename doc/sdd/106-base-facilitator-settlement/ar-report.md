# AR Report — [WKH-106] [BASE-02] — a2a manda `Authorization: Bearer` al facilitator en verify/settle Base

> **Adversarial Review — F3 completado.**
> Fecha: 2026-05-31
> Reviewer: nexus-adversary (harness mode — veredicto transcrito por nexus-docs)

---

## Veredicto: APROBADO

**BLOQUEANTE: 0 | MENOR: 0 | OBSERVACIONES: 1 (positiva)**

---

## Superficie de ataque evaluada

| Zona | Riesgo inicial | Resultado |
|------|---------------|-----------|
| Secret handling — API key en env | ALTO | OK — key leída solo desde `process.env`, nunca hardcodeada ni logueada |
| Degradación: `Bearer undefined` / `Bearer ` | ALTO | OK — `?.trim() \|\|` colapsa string vacía a `undefined`; header omitido en ambos casos |
| Leak de key en body/error path | MEDIO | OK — `buildX402CanonicalBody` no modificado; path de error no serializa la key |
| Transport vs payload separation | MEDIO | OK — header es transport-level; envelope x402 (`buildX402CanonicalBody`) intacto (CD-6) |
| TypeScript strict | BAJO-MEDIO | OK — `Record<string, string>` explícito; sin `any`/`as unknown` (CD-7) |
| Regresión en tests existentes | BAJO | OK — 35 tests preexistentes siguen verdes; header omitido sin key (CD-4) |

---

## Hallazgos

### BLOQUEANTE
*Ninguno.*

### MENOR
*Ninguno.*

### Observaciones positivas

**OBS-1 — `?.trim() ||` es MAS seguro que `??`**

La implementación en `src/adapters/base/payment.ts` usa:

```ts
function getFacilitatorApiKey(): string | undefined {
  return (
    process.env.BASE_FACILITATOR_API_KEY?.trim() ||
    process.env.FACILITATOR_API_KEY?.trim() ||
    undefined
  );
}
```

El uso de `?.trim() ||` en lugar de `??` es deliberadamente más defensivo:
- `??` solo descarta `null`/`undefined` — una `BASE_FACILITATOR_API_KEY=''` (vacía) o `BASE_FACILITATOR_API_KEY='   '` (whitespace) pasarían el null-check y generarían `Bearer ` o `Bearer    `, ambos inválidos.
- `?.trim() ||` colapsa string vacía, whitespace, `null` y `undefined` todos a `undefined`, garantizando que el header nunca se manda con valor basura.

Esto supera el requisito mínimo del SDD (DT-6) y es el patrón más robusto para secrets desde env.

---

## Constraint Directives — verificación

| CD | Descripción | Estado |
|----|-------------|--------|
| CD-1 | No hardcode de key | PASS — solo `process.env` |
| CD-2 | No log/serialización de key | PASS — body y error path verificados |
| CD-3 | No mainnet 8453 | PASS — sin cambios en chain scope |
| CD-4 | Degradación segura: sin `Bearer undefined`/vacío | PASS — `?.trim() \|\|` lo garantiza |
| CD-5 | No tocar `wasiai-facilitator` | PASS — solo 3 archivos de `wasiai-a2a` |
| CD-6 | No cambiar envelope x402 ni `types.ts` | PASS — `buildX402CanonicalBody` intacto |
| CD-7 | TypeScript strict, sin `any` | PASS — `Record<string, string>` explícito |
| CD-8 | Anti-test-pollution: `mockFetch.mockReset()` | PASS — cada test resetea la cola |
| CD-9 | `delete process.env.X` para desetear | PASS — `beforeEach`/`afterEach` usan `delete` |
| CD-10 | biome `--write` antes del lint | PASS — verificado en proceso de F3 |
| CD-11 | No key real en asserts | PASS — literales `'test-facilitator-key'`/`'shared-key'` |

---

## Archivos revisados

- `src/adapters/base/payment.ts` — helper `getFacilitatorApiKey()` + headers en `verifyX402`/`settleX402` + caveat reescrito
- `src/adapters/__tests__/base.test.ts` — bloque nuevo `describe('Base payment adapter — facilitator bearer auth (BASE-02)')`
- `.env.example` — documentación de `BASE_FACILITATOR_API_KEY`

---

## Decisión

**Pasa a CR sin condiciones.**
