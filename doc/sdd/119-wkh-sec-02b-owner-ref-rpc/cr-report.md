# CR Report — WKH-SEC-02b (Code Review)

> **nexus-adversary · CR · 2026-06-22** · Branch `feat/119-wkh-sec-02b-owner-ref-rpc` (working tree)
> **Veredicto: APROBADO con 2 MENORs** — 0 BLOQUEANTE.
> Gates reales: tsc 0 · biome 0 (archivos tocados) · vitest 1625 passed / 4 skipped (101 files).
> _Persistido por el orquestador (restricción de escritura del agente; contenido íntegro suyo)._

## Checklist CR

**1. Espejo del exemplar — OK.** Guard `IS DISTINCT FROM` en `20260609000000_..._rpc.sql:47-49` espeja `debit_with_dest_policy` (`20260606000000:81-83`), posición correcta (entre `IF NOT FOUND` y `is_active`). DROP-antes-de-CREATE (`:15`) sigue BLQ-MED-1; solo `increment` se dropea (única que cambia aridad), los 3 RPCs con CREATE OR REPLACE. SELECT cold-path `budget.ts:300-308` byte-equivalente a la ruta dest-aware (`:247-255`).

**2. Migración SQL — OK** (verificado por diff mecánico):
- `increment` 4-param (up): cuerpo byte-idéntico al original `20260406000000:56-121`, único cambio = param + guard (CD-5).
- `debit_with_dest_policy`: idéntico salvo `PERFORM ..., p_owner_ref` (L167).
- `debit_session_and_parent`: idéntico salvo PERFORM del ELSE → 4-arg (L238); branch IF dispatch preservado.
- `debit_delegation_and_parent` (125b): idéntico a `20260608000000` (6-param) salvo +p_owner_ref del ELSE (L311). **Dispatch de 125b preservado byte-a-byte (CD-10).**
- Down completo y simétrico (DROP 4-param + CREATE 3-param; los 3 RPCs revierten PERFORM a 3-arg preservando dispatch). Hardening 6-param; increment 3-param del down sin hardening (correcto, el original no lo tenía — CD-6).

**3. TS strict — OK.** Sin `any`. Cast `Pick<A2AAgentKeyRow,'owner_ref'>` consistente con la ruta dest-aware. Mapeo por `includes('OWNERSHIP_MISMATCH')` coherente.

**4. Naming — OK.** `OWNERSHIP_MISMATCH` coherente con usos existentes.

**5. Cobertura — OK.** AC-1/AC-6 (`budget.test.ts:509-520`), AC-2 (`:495-507` + KEY_NOT_FOUND `:522-529` con `not.toHaveBeenCalled()`), AC-5 regresión verde. Los 3 fixes de aridad (3→4 arg) endurecen la aserción (no relajan). AC-3 (3 PERFORM) y AC-4 (down) sin test automatizado → validación por inspección SQL (justificado en story §8, CD-7; confirmado por el CR vía diff mecánico).

**6. Observación de diseño (NO bloqueante).** Para el caller #1 (budget.ts master), el owner_ref se obtiene por SELECT de la misma key y se compara contra esa misma key → semi-tautológico (solo falla en ventana TOCTOU ~imposible). El valor real del guard está en (a) los 3 PERFORM internos donde p_owner_ref viene de la entidad padre (delegation/session), y (b) futuros callers directos. Coincide con SDD §10 DT-4. Claridad de diseño, no defecto.

**7. Gates — CONFIRMADOS.** tsc 0 (exit 0); biome 0 (2 files); vitest 1625 passed / 4 skipped (exit 0). Scope limpio: exactamente los 4 archivos de Scope IN. Ningún archivo OUT tocado (CD-11 OK).

## Findings (MENOR, no bloquean)

- **MNR-1** (`..._down.sql:11-70`): el `increment` 3-param del down es funcionalmente idéntico al original pero no byte-idéntico (se omitieron 6 comentarios). SQL ejecutable idéntico → rollback correcto. Sugerencia: restaurar comentarios o anotar que la divergencia es intencional. Backlog.
- **MNR-2** (`budget.test.ts:480` decl vs `:181` uso): `mockOwnerSelect` declarado después de su primer uso (funciona por hoisting de function declaration; frágil si se convierte a `const`). Sugerencia: mover la declaración arriba del primer uso. Backlog.

## Veredicto
**APROBADO con 2 MENORs.** 0 BLQ. CD-1/CD-5/CD-6/CD-10/CD-11 verificados por diff mecánico. Dispatch 125/125b preservado. Pipeline puede avanzar a F4.
