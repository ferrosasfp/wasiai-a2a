# Code Review (CR) — WKH-118 FEE-COMPOSE

> Agente: nexus-adversary (modo CR, dominio CALIDAD)
> Fecha: 2026-06-20
> Branch: feat/115-wkh-118-fee-compose
> Corrió EN PARALELO con AR (no leí ar-report.md).
> Scope revisado: `src/routes/compose.ts` (bloque WKH-118, L240-295 + imports L16-20)
>                 `src/routes/compose.fee.test.ts` (nuevo)
> Exemplar de referencia: `src/services/orchestrate.ts:432-482`

---

## Sección Adversary — 6 checks de calidad

### 1. Naming consistency — OK
El bloque espeja el estilo de orchestrate con fidelidad:
- `feeResult`, `feeChargeError`, `feeResult.status`, prefijo de log `[Compose]`
  (vs `[Orchestrate]`) — coherente.
- Variables claras y de scope mínimo. `flushMicrotasks` en el test es un nombre
  descriptivo y honesto sobre lo que hace.
- Única divergencia intencional y BIEN documentada: orchestrate declara
  `feeChargeTxHash`, compose NO. El comentario `compose.ts:243-246` explica el
  porqué (en compose el txHash no se serializa en el response → la variable
  quedaría write-only y biome `noUnusedVariables` la marcaría). El txHash que
  necesita el recibo se lee de `feeResult.txHash` directo. Decisión correcta,
  no es copy-paste ciego.

### 2. Complejidad — OK
- El bloque es lineal: un `try`, un `if/else if` por `status` (narrowing de la
  union), un `if` anidado para el guard del recibo. Profundidad razonable.
- El handler de compose ya era largo por la lógica preexistente (WKH-59/61/121/125);
  el bloque WKH-118 agrega ~55 líneas al final, antes del `return`, sin ramificar
  el flujo previo. No empeora la legibilidad del handler de forma material.

### 3. DRY — OK
- Reusa `chargeProtocolFee` + `getProtocolFeeRate` (`fee-charge.js`) y
  `receiptService.emit` (`receipt.js`) SIN duplicar lógica de sign/settle/idempotencia
  (cumple CD-2). No hay bloque EIP-712 copiado.
- El bloque NO es copy-paste literal de orchestrate: está adaptado al contexto
  del route — `request.id` (no `orchestrationId` de service), `result.totalCostUsdc`
  (no `budget`), `request.a2aKeyRow` (no `scopingKeyRow`, CD-5), `feeResult.feeUsdc`
  (no `feeUsdc` precomputado), `request.resolvedChainId` (no `request.chainId`).
  Adaptación correcta, no mecánica.

### 4. SOLID — OK
- El route handler hace una cosa más (side-effect best-effort post-pipeline), pero
  está claramente segregado como efecto secundario tras el éxito del compose. El
  patrón "el cobro vive en el route, el sign/settle en el service" es consistente
  con la arquitectura aprobada en el SDD. Aceptable para un side-effect best-effort.

### 5. Tests — OK
Suite: 10 tests verdes (`npx vitest run src/routes/compose.fee.test.ts` → PASS 10/0).
Cobertura de los 7 ACs + regresión CD-4, con asserts significativos:
- **AC-1 (T-FEE-1)**: verifica shape del arg (`budgetUsdc: 0.5`, `feeRate: 0.01`,
  `orchestrationId` string no vacío) — assert real, no vago.
- **AC-2 (T-FEE-2a/2b)**: cubre AMBAS variantes de best-effort —
  `mockRejectedValueOnce(new Error('boom'))` (throw real que ejercita el `catch`
  de R-1) y `status:'failed'`. Ambas verifican `statusCode === 200` +
  `success === true` + body sin campo de fee. El throw realmente ejercita el
  try/catch — bien hecho.
- **AC-3 (T-FEE-3)** y **AC-7 (T-FEE-7)**: already-charged (con y sin `inProgress`)
  → 200, sin error, `emit` NO llamado. Reales.
- **AC-4 (T-FEE-4)**: skipped WALLET_UNSET → 200 sin error, sin recibo. Real.
- **AC-5 (T-FEE-5)**: success:false → `chargeProtocolFee` NOT called + `emit` NOT
  called + status 400. Test negativo correcto.
- **AC-6 (T-FEE-6a/6b)**: charged+owner_ref → emite (assert con `objectContaining`
  del shape completo del recibo); x402 puro (`nextKeyRow = undefined`) → cobra sin
  recibo. Cubre ambas ramas del guard.
- **CD-4 (T-FEE-8)**: triple `not.toHaveProperty` + verifica body intacto.
- **Microtask flush**: `flushMicrotasks = () => new Promise(r => setImmediate(r))`
  aplicado ANTES de cada assert sobre `mockEmit` (T-FEE-3/6a/6b/7). Correcto para
  el recibo fire-and-forget no-await-eado (CD-7). Implementación sólida.

### 6. Documentación inline — OK
- `compose.ts:240-246`: explica best-effort, idempotencia por `request.id`, base
  `totalCostUsdc`, CD-1 (nunca rompe 200), y el porqué de NO declarar `feeChargeTxHash`.
- `compose.ts:261-262`: por qué el recibo es fire-and-forget (CD-6/CD-7).
- `compose.ts:287-291`: por qué el try/catch (R-1, `ProtocolFeeError` si feeUsdc > budget).
- El uso de `request.a2aKeyRow` (no `scopingKeyRow`) está implícito por el código
  y explícito en el Story File (CD-5). Habría sido ideal una línea inline citando
  CD-5 acá también, pero el comentario WKH-124 contextualiza suficiente. No es finding.

---

## Verificaciones ejecutadas

| Check | Resultado |
|-------|-----------|
| `npx vitest run src/routes/compose.fee.test.ts` | PASS 10/0 |
| `npx tsc --noEmit` (sin errores en compose) | OK |
| `biome lint compose.ts compose.fee.test.ts` | OK (sin warnings; `feeChargeError` write-only NO dispara `noUnusedVariables` porque se lee en `console.error`) |

---

## Findings

Ninguno. Las 6 categorías de calidad: **OK**.

Notas menores no-finding (NO bloquean, NO requieren acción):
- `feeChargeError` es efectivamente write-only para el response (solo alimenta
  `console.error`). Es deliberado y consistente con el patrón de orchestrate; biome
  no lo marca porque se "lee" en el log. Aceptable.

---

## Veredicto

**APROBADO**

La implementación de WKH-118 es un espejo fiel y bien adaptado del cobro de
orchestrate, con documentación inline que justifica cada divergencia (CD-4/CD-5/R-1).
Los 7 ACs + la regresión CD-4 están cubiertos con asserts significativos y tests
negativos reales (throw, success:false, x402-sin-recibo). Suite verde, typecheck
y lint limpios. Sin findings de calidad.
