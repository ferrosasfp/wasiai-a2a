# Adversarial Review (AR) — WKH-170 `remit-kyc-validator` (endpoint HTTP, etapa 1 / Free-KYC)

> Fase: AR (post-F3). Reviewer: nexus-adversary. Eje crítico: **fuga de PII (DNI / Travel Rule) + gate money-adjacent `payoutAllowed`**.
> Repo de código: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/`
> Archivos del Dev (Scope IN): `route.ts`, `route.test.ts`, `README.md` (los 3, mtime 2026-07-10 11:09-11:10).

## Veredicto global: **APROBADO con MENORs**

No se encontró ningún camino por el que el endpoint filtre `legalId` (DNI) ni `travelRuleData` en claro en 200/400/502. El gate `payoutAllowed` es fail-safe (siempre `false` en prod con fallback). No hay path que tire 500 crudo. Todos los CD verificados. 46/46 tests verdes.
Se registran **2 MENOR** (uno sobre código pre-existente fuera de Scope IN — NO bloquea el gate).

---

## Resumen de evidencia ejecutada
- `route.ts` = byte-idéntico al contenido del Story File §W1.1 (fork de `remit-corridor-fx` con core KYC + 502 `verification_unavailable`).
- `runKycValidator` (`src/agents/kyc-validator.ts:89-98`) devuelve EXACTAMENTE 7 campos: `slug, approved, riskLevel, reasons, verificationId, provenance, payoutAllowed`. **Sin** `legalId`, **sin** `travelRuleData`. `travelRuleData` (con el DNI) queda del lado del provider (`providers/kyc.ts:46,72,79-88`) y NO se propaga al output.
- `npx vitest run` → **46 PASS / 0 FAIL** (7 del endpoint + 39 previos, sin regresión).
- mtimes: `kyc-validator.ts` (07-08 18:08), `providers/kyc.ts` (07-08 17:54), `providers/types.ts` (07-08), `remit-corridor-fx/route.ts` (07-09) → **NO tocados** por la HU (CD-1). Solo los 3 Scope-IN llevan sello 07-10.

---

## 1. Security — fuga de PII (vector #1)  → **OK** (con MENOR-1 sobre `verificationId`)
- **200 body**: `route.ts:21-22` envuelve `runKycValidator(parsed.data)` en `{ result }`. El output no contiene `legalId` ni `travelRuleData` (`kyc-validator.ts:89-98`). Test (2) `route.test.ts:61-66` lo blinda con PII real (`legalId:"12345678"` + `"travelRuleData"`). **Reproducción**: POST validInput → 200; `JSON.stringify(body)` NO contiene `"12345678"` ni `"travelRuleData"` (verificado: test verde). **OK**.
- **400 body**: `route.ts:14-17` usa SOLO `parsed.error.flatten()`. El `KycInputSchema` (`kyc-validator.ts:16-24`) solo usa `.min()/.positive()` → mensajes Zod value-free (no interpola el valor recibido). No hay `.refine`/mensaje custom, ni se devuelve `parsed.data` ni el body crudo. **Ataque probado**: POST `{...validInput, senderCountry:undefined}` con `legalId:"12345678"` → 400 `invalid_input`; body NO contiene `"12345678"` (test (5) `route.test.ts:85-92`, verde). Zod object plano **descarta** claves no-schema (no `.strict()`) → PII inyectada en un campo extra se strippea antes de llegar al output/provider y no se ecoa. **OK**.
- **502 body**: `route.ts:23-30`. Body FIJO `{ error: "verification_unavailable" }` + `console.warn` con SOLO `err.name`. Nunca `err.message`/stack/input. **Ataque probado**: mock lanza `Error("didit_adapter_not_ready leak 99887766")` → 502; body no contiene `99887766` ni `didit_adapter_not_ready` ni `stack` (test (7) `route.test.ts:104-116`, verde). **OK**.
- **Logs**: el único log es `console.warn(..., { errorName })` — sin PII ni input. **OK**.

Conclusión del eje: **no se pudo filtrar PII por ningún camino del wrapper HTTP.**

## 2. Error Handling → **OK**
- `await req.json().catch(() => null)` (`route.ts:10`): body no-JSON / vacío → `null` → `safeParse` falla → 400 estructurado (test (6) `route.test.ts:95-102`). No 500.
- `safeParse` nunca lanza; `runKycValidator` va dentro de `try/catch` → cualquier throw (incl. `ZodError`/`didit_adapter_not_ready`) mapea a 502 opaco. **No existe path a 500 crudo.** OK.

## 3. Data Integrity → **OK** (ver MENOR-1)
- Endpoint stateless de solo-lectura (no escribe, no hay race/idempotencia que romper en esta capa). El único artefacto derivado del DNI es `verificationId` (ver MENOR-1).

## 4. Performance → **N/A**
- Sin queries, sin loops, sin N+1. Una sola llamada `provider.verify()` (fallback determinístico, O(len(legalId))). No aplica.

## 5. Integration → **OK**
- Contrato A2A: `{ result }` legible por `data.result ?? data` (`compose.ts`). Test (1) `route.test.ts:43-58` valida `data.result ?? data` + `Object.keys` = los 7 campos exactos. Endpoint NUEVO → sin breaking change para el agente hermano `remit-corridor-fx` ni el demo `agentshop-kyc-validator` (repos/rutas distintos). OK.

## 6. Type Safety → **OK**
- `route.ts` no usa `any`. `new NextRequest(...)` type-correct (sin cast). Los `as any` viven en `providers/kyc.ts` (fuera de Scope IN, no tocado). OK para la HU.

## 7. Test Coverage → **OK**
- 7 tests, todos verdes. Los 2 NO-PII (200 y 400) usan input CON PII real (`legalId:"12345678"`, `"travelRuleData"`) y assertan `.not.toContain(...)` → **blindan de verdad**, no son laxos. Cubren: 200 contrato+NO-PII, provenance fallback, fail-safe prod, 400 NO-PII, no-JSON→400, 502 opaco. Gap menor (no bloqueante): no hay test explícito del stripping de un campo PII extra no-schema, pero es comportamiento default de Zod ya cubierto indirectamente.

## 8. Scope Drift → **OK**
- Solo los 3 archivos de Scope IN modificados (mtime 07-10). `kyc-validator.ts` / `providers/*` / `remit-corridor-fx/*` intactos (mtime 07-08/07-09). CD-1/CD-2 respetados.

## 9. Destructive Migrations → **N/A**
- La HU no incluye SQL ni migraciones. El registro `POST /agents` (W4) es paso manual `!` fuera de F3.

## 10. RPC SECURITY DEFINER → **N/A**
- No hay funciones Postgres/RPC en la HU.

## 11. Cache Invalidation → **N/A**
- No se introduce ninguna capa de cache (React Query/SWR/Redis/revalidate). Endpoint stateless.

---

## Verificación de Constraint Directives
- **CD-1** (core/providers/demo intactos): **OK** — mtimes 07-08 vs HU 07-10; `agentshop` no existe en este repo (demo en repo aparte, no tocado).
- **CD-3** (slug byte-idéntico): **OK** — `SLUG="remit-kyc-validator"` (`kyc-validator.ts:13`) = ruta `remit-kyc-validator/invoke` = `name` del registro W4. Byte-idéntico.
- **CD-4** (Didit OFF): **OK** — `getKycProvider()` (`providers/kyc.ts:103-113`) devuelve `FallbackKycProvider` sin `DIDIT_API_KEY`; el `route.ts` NO referencia envs de Didit. Con key pero sin `DIDIT_ADAPTER_READY=true` → lanza `didit_adapter_not_ready` (fail-loud) → 502 opaco. Provenance forzado `local-fallback` (test (3)).
- **CD-5** (testnet): **OK** — el código no toca chain/mainnet; `payoutWallet` testnet es artefacto manual W4.
- **CD-6** (NO-PII en 200/400/502): **OK** — cubierto en §1.
- **CD-7/CD-8** (`{ result }`, waves manuales no ejecutadas por Dev): **OK**.

---

## Hallazgos

### MENOR-1 — `verificationId` de fallback es un hash débil reversible del DNI (Security / Data Integrity)
- **Archivo:línea**: `src/providers/kyc.ts:73` (`verificationId: \`fallback-${hashLite(input.legalId)}\``) + `hashLite` en `:90-95`.
- **Descripción**: en el path fallback (el ÚNICO activo en etapa 1, incluso en prod), `verificationId = fallback-<hashLite(legalId)>`. `hashLite` es un hash polinómico no-cripto de 32 bits. Un DNI peruano es numérico de ~8 dígitos (≈10^8 valores). Un atacante que observe el `verificationId` (viaja en el 200 y se persiste en telemetría del gateway, precedente WKH-155) puede precomputar `hashLite` de los 10^8 DNIs posibles en segundos y **recuperar el DNI**. No es "el DNI en claro", pero es efectivamente reversible → viola el espíritu NO-PII (CD-6) para datos reales.
- **Reproducción**: `hashLite("12345678")` es determinístico; construir mapa `{hashLite(d): d for d in 0..10^8}` y buscar el hash del `verificationId` recupera el DNI (posibles pocas colisiones a desambiguar).
- **Impacto**: en etapa 1 con DNIs reales de usuarios (Free-KYC corre en prod), el DNI queda recuperable desde telemetría/logs. Bajo HOY porque el riel corre en testnet con datos de demo; el adapter real Didit usa `session_id` opaco (no aplica al path Didit).
- **Por qué MENOR y NO bloqueante**: (a) código **pre-existente fuera de Scope IN** — CD-1 prohíbe al Dev tocar `providers/kyc.ts`, no puede arreglarlo en esta HU; (b) el SDD documentó explícitamente "verificationId es un hash, NO el DNI en claro" y lo bendijo — este finding refina esa afirmación (un hash de 32 bits sobre 10^8 no protege); (c) contexto actual testnet/demo sin DNIs reales.
- **Sugerencia (follow-up HU, NO en WKH-170)**: reemplazar `hashLite` por un id opaco no-derivable del DNI (UUID aleatorio persistido, o HMAC-SHA256 con secreto de servidor truncado) antes de habilitar Free-KYC con DNIs reales de producción. Trackear como TD de seguridad.

### MENOR-2 — Sin test del stripping de PII en campo extra no-schema (Test Coverage)
- **Archivo:línea**: `src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` (ausencia).
- **Descripción**: no hay un test que envíe un campo extra no-schema conteniendo PII (ej. `{ ...validInput, extraDni: "87654321" }`) y verifique que el 200 no lo ecoa. El comportamiento correcto ya está garantizado por Zod (object plano strippea claves desconocidas) y por el pick explícito de `runKycValidator`, pero no está blindado por test.
- **Impacto**: bajo — regresión hipotética si alguien cambiara el schema a `.passthrough()` o el output a spread del input pasaría desapercibida. Es defensa-en-profundidad, no un bug actual.
- **Por qué MENOR**: no rompe ningún AC; el path real está cubierto indirectamente.
- **Sugerencia**: agregar 1 assert NO-PII con campo extra en el test del 200. Opcional / backlog.

---

## Cierre
- **Gate**: no hay BLOQUEANTEs (ALTO/MEDIO/BAJO) → **el gate PASA**. Los 2 MENOR se documentan; MENOR-1 se rutea a follow-up de seguridad (fuera de Scope IN de WKH-170), MENOR-2 es opcional.
- **PII**: no se pudo filtrar `legalId`/`travelRuleData` por ningún camino del wrapper HTTP (200/400/502/logs). Confirmado.
- **Money-gate**: `payoutAllowed` fail-safe verificado (siempre `false` en prod con fallback).

*AR generado por NexusAgil — nexus-adversary. Post-F3, WKH-170.*
