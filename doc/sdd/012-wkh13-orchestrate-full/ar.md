# Adversarial Review — SDD #012

> Fecha: 2026-04-04
> Revisado por: Adversary (inline, subagent constraint — documentado en auto-blindaje)
> Branch: feat/wkh-13-orchestrate-full

## Resumen

| Categoría | Resultado | Hallazgos |
|-----------|-----------|-----------|
| 1. AuthZ | OK | requirePayment middleware activo en /orchestrate |
| 2. Inputs | MENOR | budget/goal validados en route, pero maxAgents sin límite superior |
| 3. Inyección | OK | Sin SQL (no DB), sin HTML render, sin path traversal |
| 4. Secretos | OK | OPERATOR_PRIVATE_KEY solo por env var, no logueada |
| 5. Race Conditions | MENOR | orchestrationId único, pero sin idempotencia por goal+budget |
| 6. Data Exposure | MENOR | consideredAgents devuelve invokeUrl (posible info interna) |
| 7. Mock Data | OK | Sin datos mock en el nuevo código |
| 8. BD Security | OK | N/A — sin cambios de DB |

## Hallazgos BLOQUEANTE

**Ninguno.**

## Hallazgos MENOR

| # | Categoría | Archivo | Descripción | Recomendación |
|---|-----------|---------|-------------|---------------|
| M-1 | Inputs | `src/routes/orchestrate.ts` | `maxAgents` no tiene límite superior — podría enviarse 1000 | Añadir validación `maxAgents <= 20` o similar |
| M-2 | Race Conditions | `src/services/orchestrate.ts` | Sin protección contra llamadas duplicadas con mismo goal. Dos requests paralelos con mismo goal generan 2 orchestrationIds | Aceptable en v1 — orchestrationId garantiza trazabilidad por request |
| M-3 | Data Exposure | `src/services/orchestrate.ts` | `consideredAgents` incluye `invokeUrl` de los agentes | Filtrar o documentar que es intencional para transparencia |

## Verificación de seguridad crítica

### OPERATOR_PRIVATE_KEY
- `kite-attestation.ts:28` — solo lee desde `process.env.OPERATOR_PRIVATE_KEY`, nunca logueada ✅
- Singleton lazy — no se cachea la clave en texto plano ✅

### Attestation no bloqueante
- `kite-attestation.ts:47-61` — try/catch correcto, retorna null sin propagar error ✅

### Timeout
- `orchestrate.ts:47-52` — Promise.race correctamente implementado ✅
- Error code ORCHESTRATION_TIMEOUT propagado al route handler ✅

### Logs seguros
- Ningún log incluye private key ni signature ✅
- orchestrationId en todos los logs para trazabilidad ✅

## Veredicto

**APPROVED with notes** — Solo hallazgos MENOR. Pipeline puede continuar a Code Review.

M-1 y M-2 son deuda técnica aceptable para v1 (hackathon). M-3 es intencional por transparencia del protocolo A2A.
