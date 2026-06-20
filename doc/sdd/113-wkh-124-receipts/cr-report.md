# Code Review (CR) — WKH-124 KEY-RECEIPTS

> Rol: nexus-adversary (Code Review / calidad). Ejecutado EN PARALELO con AR.
> Fecha: 2026-06-19 · Branch: `feat/113-wkh-124-receipts`
> Story File: `doc/sdd/113-wkh-124-receipts/story-file.md`
> Estado del árbol: cambios WKH-124 en working-tree (no commiteados aún).
> Baseline verificada: `tsc --noEmit` exit 0; `receipt.test`+`receipts.test` 19/19 verde;
> `budget.test`+`orchestrate.test`+`a2a-key.test` 122/122 verde (CD-7 intacto).

---

## Resumen ejecutivo

Implementación de **alta calidad**. El servicio espeja fielmente los exemplars (HMAC de
`signed-auth.ts`, best-effort de `event.ts`, Ownership Guard de `budget.ts`, router de
`auth.ts`). Tipos aislados (CD-8), sin `any`, comparación HMAC constante-temporal correcta,
fire-and-forget consistente en los 4 call-sites. La corrección `scopingKeyRow` del
auto-blindaje es **limpia, no un parche**.

**Findings**: 0 BLOQUEANTE · 3 MENOR. Veredicto: **APROBADO con MENORs**.

---

## Check 1 — Naming consistency · **OK**

- `receiptService.{emit,verify,list,getById}` + `buildCanonicalPayload`/`computeReceiptHash`
  espejan el estilo de `signed-auth.ts`/`delegation.ts` (objeto-servicio exportado + helpers
  puros exportados). Nombres claros y alineados al dominio.
- `ReceiptRow`/`ReceiptType`/`EmitReceiptInput`/`VerifyReceiptResult`/`ReceiptListItem`:
  consistentes con `A2AAgentKeyRow`/`KeySessionRow`. `ReceiptType` union literal idéntica al
  patrón de tipos existentes.
- Error handling consistente: `list`/`getById` lanzan `Error(...)` envuelto (igual `event.ts`/
  `budget.ts`); `emit`/`verify` nunca throw (contrato best-effort/CD-A). `PGRST116 → null`
  espeja `budget.ts:42-59`.
- Logging `'[receipts] ...'` prefijado, consistente con `[Orchestrate]`/`[receipts]` del repo.

## Check 2 — Complejidad · **OK**

- `buildCanonicalPayload` (L53-71): lineal, 1 objeto literal ordenado + `JSON.stringify`.
  Sin ramas. `computeReceiptHash` (L77-81): 1 guard + 1 expresión. `hashesEqual` (L88-94):
  3 guards lineales. `emit` (L109-188): ~50 L pero ciclomática baja (guards tempranos +
  try/catch lineal de 3 pasos, sin anidamiento profundo). `verify` (L195-244): cadena de
  early-returns, legible. Ninguna función con complejidad alta.
- Router `receipts.ts`: 3 handlers lineales, idéntico shape (resolve → gate 403 → service →
  200/404). Sin lógica acoplada.

## Check 3 — DRY · **OK** (con 1 nota MENOR, ver MNR-1)

- **HMAC**: reusa el patrón exacto de `signed-auth.ts`/`transform-hmac.ts`
  (`createHmac('sha256',...).digest('hex')`, validar hex con regex ANTES de `Buffer.from`,
  `length`-check ANTES de `timingSafeEqual`). Fiel.
- **Best-effort**: los 4 call-sites usan `receiptService.emit({...}).catch(warn)` idéntico,
  espejando `eventService.track(...).catch(...)` de `orchestrate.ts:457-473`. Correcto.
- **Ownership Guard**: `.eq('owner_ref', ownerRef)` en `list`/`getById`/`verify` (vía getById),
  patrón WKH-53 / `budget.ts`. Correcto.
- `resolveCallerKey` se **replicó** en `receipts.ts:22-48` porque en `auth.ts:113` es
  module-private (no exportado). El Story File lo autoriza explícitamente ("importarlo o
  replicar el patrón"). La réplica es byte-fiel al original. → MNR-1 (riesgo de drift).
- Los 4 bloques `.catch(warn)` son ~7 L de copy-paste cada uno → MNR-2 (factorización
  opcional). No bloquea: es el patrón ya establecido por `event.ts` en el repo.

## Check 4 — SOLID · **OK**

- `receipt.ts` desacoplado del transporte: `emit` recibe primitivos (`EmitReceiptInput`),
  no `FastifyRequest`. El router traduce HTTP↔service; el service no conoce Fastify.
- `buildCanonicalPayload`/`computeReceiptHash` son funciones puras exportadas (testables
  aisladas, SRP). La firma HMAC (Node) y la persistencia (Supabase) están separadas: el
  secret NUNCA cruza a Postgres (el RPC solo inserta placeholder).
- Inversión correcta: el ownership check vive en una sola fuente (`getById`); `verify` y el
  router lo consumen en vez de re-implementarlo.

## Check 5 — Tests · **APROBADO con MENOR** (ver MNR-3)

Verificado ejecutando las suites (19/19 receipt + 122/122 call-sites, todo verde):

- **Determinismo/canonical** (AC-3/DT-5): `buildCanonicalPayload` testea orden alfabético
  real (insertando keys desordenadas y verificando `Object.keys(parsed)` ordenado),
  `toFixed(8)`, ISO, y `null` literal (`expect(canonical).toContain('"counterparty":null')`).
  Asserts significativos, no vagos.
- **Tamper** (AC-5): el test ALTERA realmente `amount_usd: '999.00000000'` sobre un row con
  hash válido y verifica `valid:false, tamper_detected:true`. Genuino, no mockeado.
- **Best-effort** (AC-6/CD-1): cubre secret-unset (no inserta), ownerRef vacío (skip),
  RPC reject (`mockRejectedValue` → `.resolves.toBeUndefined()`), RPC error-object (no UPDATE).
  En budget/orchestrate: `mockRejectedValue` + assert de que `debit`/`orchestrate` siguen OK.
  El test best-effort SÍ hace que emit rechace y confirma que el pago no se rompe. Correcto.
- **UPDATE-once** (CD-2): assert de `.eq('id', id)` Y `.eq('receipt_hash', '')`. Correcto.
- **Ownership** (AC-7/AC-8): `list` assert `.eq('owner_ref', ownerA)`; router 404 cross-owner
  + verify-NOT-called cross-owner. Correcto.
- **GAP (MNR-3)**: la emisión `budget_debit` en el call-site **master** (`a2a-key.ts:~816`,
  AC-2) NO tiene assertion en `a2a-key.test.ts`, y la del call-site **key-session**
  (`budget.ts:~88`, AC-2) tampoco tiene assertion dedicada (solo se testea la ruta
  **delegation**). El Story File (Test Expectations) los pedía explícitamente. El código es
  correcto y estructuralmente idéntico a la ruta delegation ya testeada, por eso es MENOR y
  no BLOQUEANTE — pero es deuda de cobertura sobre 2 de los 4 call-sites.

## Check 6 — Documentación inline · **OK**

- Flujo 3-pasos del `emit`: documentado en JSDoc (L100-108) + comentarios numerados inline.
- Canonical determinista: documentado en `buildCanonicalPayload` (L47-52) y `CanonicalFields`.
- `counterparty=null` en `budget_debit`: el call-site `budget.ts` lo pasa explícito; la razón
  (DT-8) vive en el Story File. Inline está el `counterparty: null` con el resto del shape.
  Aceptable (no exigir doc no-documentada).
- Advisory lock: documentado en la migración SQL (L29-32, L51).
- Corrección `scopingKeyRow`: documentada inline en `orchestrate.ts` (comentario L+ del bloque
  emit) Y en `auto-blindaje.md`. Excelente trazabilidad.

---

## Corrección `scopingKeyRow` (auto-blindaje) — evaluación: **LIMPIA, no parche**

El Story File (L62, L126) instruía emitir `protocol_fee` desde `request.a2aKeyRow.owner_ref/id`.
Ese campo NO existe en el DTO `OrchestrateRequest` (es el nombre del row en el request Fastify
de `a2a-key.ts`, no del DTO). El Dev detectó el error de TS y usó el campo **correcto**:
`request.scopingKeyRow` (`A2AAgentKeyRow`, ya propagado a compose en `orchestrate.ts:409`).

- Es la fuente de linaje semánticamente correcta (mismo `owner_ref`+`id` que pedía el AC-1).
- Mantiene el guard CD-D: `if (feeResult.status === 'charged' && request.scopingKeyRow?.owner_ref)`.
- Documentada en `auto-blindaje.md` con causa raíz + fix + regla generalizable.
- Tests T-25/T-26/T-27 cubren happy/reject/sin-scopingKeyRow.

No introduce deuda: usa una estructura ya existente y propagada, sin ampliar firmas (CD-6/CD-7
intactos). Clasificación: **OK**.

---

## Findings

### MNR-1 — `resolveCallerKey` duplicado (drift latente)
- **Categoría**: DRY · **Severidad**: MENOR
- **Archivo**: `src/routes/receipts.ts:22-48` (copia de `src/routes/auth.ts:113-142`).
- **Descripción**: el helper de auth se replicó porque `auth.ts` no lo exporta. La copia es
  fiel hoy, pero si la precedencia de auth cambia en `auth.ts` (p.ej. nuevo esquema de token),
  `receipts.ts` quedará desincronizado silenciosamente. El Story File autorizó la réplica, así
  que NO bloquea.
- **Impacto**: si auth evoluciona, `/receipts/*` podría aceptar/rechazar credenciales distinto
  a `/auth/*`. Bajo, mientras la precedencia no cambie.
- **Sugerencia**: en una HU futura, exportar `resolveCallerKey` desde `auth.ts` (o moverlo a un
  módulo `request-auth.ts` compartido) y que ambos routers lo importen. No para esta HU.

### MNR-2 — Bloque `.catch(warn)` copy-paste en 4 call-sites
- **Categoría**: DRY · **Severidad**: MENOR
- **Archivos**: `budget.ts:101-107` y `:173-179`; `a2a-key.ts:830-836`; `orchestrate.ts` (bloque emit).
- **Descripción**: el handler `.catch(e => console.warn('[receipts] emit failed', e instanceof
  Error ? e.message : e))` se repite literal 4 veces. Es el patrón establecido por `event.ts`
  en el repo, así que es deuda aceptable, no defecto.
- **Impacto**: nulo funcionalmente; mantenimiento marginal.
- **Sugerencia (opcional)**: un helper `emitReceiptBestEffort(input)` en `receipt.ts` que
  envuelva el `.catch(warn)`, simplificando los call-sites a una línea. No requerido.

### MNR-3 — Falta assertion de emisión en call-sites master y key-session
- **Categoría**: Test Coverage · **Severidad**: MENOR
- **Archivos**: `src/middleware/a2a-key.test.ts` (sin test del emit master ~L816);
  `src/services/budget.test.ts` (tiene delegation, falta key-session ~L88).
- **Descripción**: 2 de los 4 call-sites de emisión no tienen assertion `toHaveBeenCalledWith`
  propia. El Story File (Test Expectations) los enumeraba: "debit success master → emit
  budget_debit desde call-site" y "key-session y delegation → emit con session_id/delegation_id
  respectivos". El código de ambos call-sites es correcto (revisado, shape exacto) y
  estructuralmente idéntico a la ruta delegation que SÍ está testeada.
- **Reproducción**: `grep -n "WKH-124\|receiptService" src/middleware/a2a-key.test.ts` → solo
  el `import`/mock implícito, ninguna assertion de emit. En `budget.test.ts` solo la ruta
  delegation (L259, L280) tiene assertion; no hay test con `sessionId` no-nulo.
- **Impacto**: una regresión que rompa la emisión master o key-session (p.ej. campo de linaje
  mal mapeado) pasaría los tests verde. QA debería marcar AC-2 cubierto sólo parcialmente.
- **Sugerencia**: añadir 1 assert `toHaveBeenCalledWith(objectContaining({agentKeyId: keyRow.id,
  receiptType:'budget_debit', sessionId:null}))` en `a2a-key.test.ts` tras el debit master, y 1
  análogo con `sessionId` en la ruta key-session de `budget.test.ts`. (El Dev lo agrega; NO el CR.)

---

## Veredicto

**APROBADO con MENORs** — 0 BLOQUEANTE, 3 MENOR (todos DRY/cobertura, ninguno rompe AC ni
gate). El gate NO se bloquea. Los MENOR se documentan; MNR-3 es el más accionable (cobertura
de 2 call-sites) y conviene que el Dev lo cierre antes de DONE para que QA pueda validar AC-2
en sus 3 rutas con evidencia archivo:línea.

*CR generado por nexus-adversary — WKH-124*
