# Story File — WKH-173 · `requireA2AKey()` auth-only — publish/patch/delete/list GRATIS

> Contrato autocontenido para el Dev (F3). Implementá AL PIE DE LA LETRA, wave por
> wave. NO reabras decisiones: todo lo que sigue ya fue ratificado por el humano en
> `SPEC_APPROVED`. Si algo acá no está, NO lo hagas.
>
> Input aprobado: `sdd.md` (F2, SPEC_APPROVED) + `work-item.md` (mismo dir).
> Stack: Fastify + TypeScript strict (sin `any`) + vitest + biome. Puerto 3001.

---

## 1. Contexto compacto (qué se construye y por qué)

Las 4 rutas de `src/routes/agents.ts` (`POST /`, `PATCH /:slug`, `DELETE /:slug`,
`GET /`) montan hoy `requirePaymentOrA2AKey({description})` como preHandler. Como
NO inyectan `composeEstimatedCostUsd`/`gaslessEstimatedCostUsd`, el middleware cae
al `PLACEHOLDER_FEE_USD` ($1, `src/lib/pricing-constants.ts`) y **debita de verdad**
el budget del caller — contradiciendo el docstring `agents.ts:19-20` ("Publicar es
GRATIS"). Además, un caller x402-anónimo que manda `X-PAYMENT` pagaría on-chain y
DESPUÉS sería rechazado con 403 (dinero real perdido).

**Fix de fondo:** una función NUEVA `requireA2AKey()` (auth-only) que autentica la
a2a-key (master / delegación / key-session), setea `request.a2aKeyRow` con el mismo
scoping que hoy, y **NUNCA** resuelve chain, debita, chequea spend-limits ni invoca
x402. Las 4 rutas la usan en lugar de `requirePaymentOrA2AKey`. El path pago
(`/compose`, `/orchestrate*`, `/gasless/transfer`, `/registries`) queda intacto.

**Anti-drift (W0):** la única lógica de seguridad no-trivial que se duplicaría es la
construcción del `effectiveRow` (scoping de delegación/sesión). Se extrae a 2
builders puros compartidos que usan TANTO el path pago COMO el auth-only → una sola
fuente de verdad. El path pago se rewirea a esos builders (refactor mecánico,
comportamiento byte-idéntico, cubierto por la suite de deleg/sesión existente).

---

## 2. Scope IN — archivos exactos a tocar

| # | Archivo | Wave | Acción |
|---|---|---|---|
| 1 | `src/middleware/a2a-key.ts` | W0 | Agregar 2 builders puros + rewirear 2 call-sites (deleg/sesión) |
| 2 | `src/middleware/a2a-key.ts` | W1 | Agregar 3 resolvers auth-only privados + `export function requireA2AKey()` |
| 3 | `src/routes/agents.ts` | W1 | Swap import + preHandler en 4 rutas + docstring `:16-21` |
| 4 | `src/middleware/a2a-key.test.ts` | W2 | Nuevo `describe('requireA2AKey — auth-only (WKH-173)')` con 8 tests T-RA |
| 5 | `src/routes/agents.publish.test.ts` | W2 | Actualizar `vi.mock('../middleware/a2a-key.js')` → exponer `requireA2AKey` |
| 6 | `src/routes/agents.ownership.test.ts` | W2 | Idem mock |

**PROHIBIDO tocar cualquier otro archivo.** En particular: NO modificar los bloques
de **débito** de `resolveMasterAuth` / `resolveDelegationAuth` / `resolveKeySessionAuth`
(solo el `effectiveRow` de deleg/sesión se rewirea al builder, W0). NO tocar
`registries.ts`, `x402.ts`, `resolveTargetChain`, `resolveEstimatedCostUsd`.

---

## 3. Anti-Hallucination Checklist (símbolos que EXISTEN — usá SOLO estos)

Todos verificados con Read en `src/middleware/a2a-key.ts` (esta sesión). NO inventes
firmas ni imports nuevos.

**Ya importados en `a2a-key.ts` (reusá, no re-importes):**
- `crypto` (node) — `crypto.createHash('sha256').update(rawKey).digest('hex')` (L798, L305, L558).
- `identityService.lookupByHash(hash): Promise<A2AAgentKeyRow | null>` (import L28, uso L801).
- `isIdentityVerified(row)` (import L28, uso L514/L755/L977).
- `delegationService.lookupByTokenHash(hash)` / `.getParentKey(keyId)` (import L25, uso L306/L331).
- `keySessionService.lookupByTokenHash(hash)` / `.getParentKey(keyId)` (import L29, uso L559/L580).
- `verifySignedAuth({ tokenHashHex, method, path, headers, scheme })` (import L46, uso L602/L856).
- `extractSignedHeaders(request): SignedAuthHeaders` (def L163).
- `extractRawKey(request): string | undefined` (def L260, ya `export`).
- `send403(reply, code, msg)` (L92), `send403delegation(...)` (L116), `send403session(...)` (L137), `sendSignedAuthError(reply, code)` (L151).
- Tipos `A2AAgentKeyRow`, `DelegationRow`, `KeySessionRow` (import L47-55).
- `preHandlerAsyncHookHandler` (import fastify L12), `FastifyRequest`, `FastifyReply`.
- Campos ya declarados en `declare module 'fastify'` (L62-77): `a2aKeyRow`, `delegationRow`, `keySessionRow`. **NO agregues campos nuevos.**

**PROHIBIDO en `requireA2AKey()` y sus 3 resolvers auth-only (CD-2 / DT-C / DT-G):**
- `requirePayment`, `runX402Fallback`, cualquier símbolo de `./x402.js`.
- `resolveTargetChain`, `resolveEstimatedCostUsd`, `PLACEHOLDER_FEE_USD`, `resolvedChainId`.
- `budgetService.debit`, `budgetService.getBalance`, `delegationService.debitDelegationAndParent`, `keySessionService.debitSessionAndParent`, `receiptService.emit`.
- `exceedsPerTxLimit`, chequeo de `daily_limit_usd` / `daily_spent_usd` / `max_spend_per_call_usd` / `delegation.policy.allowed_chains` / `delegation.policy.max_amount_per_tx`.
- setear `request.delegationContext` / `request.keySessionContext` / header `x-a2a-remaining-budget`.

**`effectiveRow` — campos EXACTOS (leídos del código, NO inventar):**
- Delegación (a2a-key.ts:503-513): spread `parentKey` + `allowed_registries` + `allowed_agent_slugs` (semántica `length > 0 ? policy.X : null`). **NO** toca `allowed_categories`.
- Sesión (a2a-key.ts:740-754): spread `parentKey` + `allowed_registries` + `allowed_agent_slugs` + `allowed_categories` (semántica `session.X === null ? parentKey.X : session.X`).
- En AMBOS, `erc8004_verified` se asigna DESPUÉS, en el call-site (NO dentro del builder).

---

## 4. Waves

### W0 — Refactor puro: builders `effectiveRow` compartidos (SERIAL · gate duro)

**Archivo:** `src/middleware/a2a-key.ts` (único).

**Paso 0.1** — Agregar 2 funciones puras a nivel módulo (ubicalas junto a los helpers,
p.ej. después de `extractSignedHeaders` L171 y antes de `runX402Fallback`, o cerca de
los otros helpers; deben quedar ANTES de los resolvers que las usan). Contenido EXACTO
(copiá los literales de L503-513 y L740-754, sin la línea `erc8004_verified`):

```ts
/**
 * WKH-173 (DT-B): builder puro del effectiveRow de delegación. Fuente única
 * compartida por resolveDelegationAuth (path pago) y authenticateDelegation
 * (auth-only). Réplica EXACTA de a2a-key.ts:503-513 (sin erc8004_verified, que
 * se setea en el call-site). Behavior-preserving (cubierto por la suite WKH-101).
 */
export function buildDelegationEffectiveRow(
  parentKey: A2AAgentKeyRow,
  delegation: DelegationRow,
): A2AAgentKeyRow {
  return {
    ...parentKey,
    allowed_registries:
      delegation.policy.allowed_registries.length > 0
        ? delegation.policy.allowed_registries
        : null,
    allowed_agent_slugs:
      delegation.policy.allowed_agent_slugs.length > 0
        ? delegation.policy.allowed_agent_slugs
        : null,
  };
}

/**
 * WKH-173 (DT-B): builder puro del effectiveRow de key-session. Fuente única
 * compartida por resolveKeySessionAuth (path pago) y authenticateKeySession
 * (auth-only). Réplica EXACTA de a2a-key.ts:740-754 (sin erc8004_verified).
 * Behavior-preserving (cubierto por la suite WKH-121).
 */
export function buildSessionEffectiveRow(
  parentKey: A2AAgentKeyRow,
  session: KeySessionRow,
): A2AAgentKeyRow {
  return {
    ...parentKey,
    allowed_registries:
      session.allowed_registries === null
        ? parentKey.allowed_registries
        : session.allowed_registries,
    allowed_agent_slugs:
      session.allowed_agent_slugs === null
        ? parentKey.allowed_agent_slugs
        : session.allowed_agent_slugs,
    allowed_categories:
      session.allowed_categories === null
        ? parentKey.allowed_categories
        : session.allowed_categories,
  };
}
```

**Paso 0.2** — Rewirear `resolveDelegationAuth` (L503-515). Reemplazá el literal:

```ts
// ANTES (L503-513):
const effectiveRow: A2AAgentKeyRow = {
  ...parentKey,
  allowed_registries: delegation.policy.allowed_registries.length > 0 ? ... : null,
  allowed_agent_slugs: delegation.policy.allowed_agent_slugs.length > 0 ? ... : null,
};
// DESPUÉS:
const effectiveRow = buildDelegationEffectiveRow(parentKey, delegation);
```
**Conservá SIN CAMBIOS** L514-522 (`effectiveRow.erc8004_verified = isIdentityVerified(parentKey);`,
`request.a2aKeyRow = effectiveRow;`, `request.delegationRow = delegation;` y el bloque
`request.delegationContext = {...}`).

**Paso 0.3** — Rewirear `resolveKeySessionAuth` (L740-754). Reemplazá el literal por:

```ts
const effectiveRow = buildSessionEffectiveRow(parentKey, session);
```
**Conservá SIN CAMBIOS** L755-762 (`erc8004_verified`, `request.a2aKeyRow = effectiveRow;`,
`request.keySessionRow = session;`, `request.keySessionContext = {...}`).

**GATE DURO W0 (no avanzar a W1 sin esto verde):** correr SOLO las suites de deleg/sesión
del path pago y confirmar 0 cambios:
```
./node_modules/.bin/vitest run src/middleware/a2a-key.test.ts
```
Deben pasar sin tocar los tests los describes `requirePaymentOrA2AKey — delegation branch (WKH-101)`,
`requirePaymentOrA2AKey — key-session branch (WKH-121)` y los WKH-125*/WKH-127. Si CUALQUIER
assert cambia, el refactor NO es puro → parar y revisar el literal copiado.

---

### W1 — `requireA2AKey()` auth-only + swap de preHandlers (tras gate W0)

**Archivo A: `src/middleware/a2a-key.ts`** — agregar 3 resolvers privados + el dispatcher
exportado (ubicalos DESPUÉS de `resolveMasterAuth` / antes o después del dispatcher pago,
a nivel módulo). Firmas y contrato EXACTO:

#### Dispatcher (clona el orden de `requirePaymentOrA2AKey` L1013-1050, CD-6)

```ts
/**
 * WKH-173: middleware auth-only para publish/patch/delete/list de agentes.
 * Autentica la a2a-key (master/delegación/sesión) y setea request.a2aKeyRow
 * SIN chain-resolution, SIN débito, SIN spend-limits, SIN x402 (CD-2/DT-C/DT-G).
 * Ausencia de credencial → 403 A2A_KEY_REQUIRED directo (AC-3).
 * Devuelve un array de 1 handler para preservar la ergonomía `...requireA2AKey()`.
 */
export function requireA2AKey(): preHandlerAsyncHookHandler[] {
  const handler: preHandlerAsyncHookHandler = async (request, reply) => {
    const rawKey = extractRawKey(request);
    if (!rawKey) {
      return reply.status(403).send({
        error: 'a2a-key required',
        error_code: 'A2A_KEY_REQUIRED',
        message:
          'Publishing requires an authenticated a2a-key. The x402 anonymous path cannot publish (no tenant identity).',
      });
    }
    if (rawKey.startsWith('wasi_a2a_session_')) {
      return authenticateDelegation(request, reply, rawKey);
    }
    if (rawKey.startsWith('wasi_a2a_sess_')) {
      return authenticateKeySession(request, reply, rawKey);
    }
    return authenticateMasterKey(request, reply, rawKey);
  };
  return [handler];
}
```

#### `authenticateMasterKey(request, reply, rawKey)` — `Promise<unknown>`

Orden EXACTO (subconjunto de `resolveMasterAuth` L796-1005, SIN pasos de limits/chain/débito):
1. `const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');`
2. `const keyRow = await identityService.lookupByHash(keyHash);` — `if (!keyRow) return send403(reply, 'KEY_NOT_FOUND', 'A2A key not found');`
3. `if (!keyRow.is_active) return send403(reply, 'KEY_INACTIVE', 'A2A key is inactive');`
4. **SKIP** daily_limit (L811-825) y per_call_limit (L832-840). NO copiar esos bloques.
5. Firma (copia EXACTA de L848-866): `if (keyRow.require_signature === true) { const headers = extractSignedHeaders(request); if (typeof headers.signature !== 'string' || headers.signature.length === 0) return reply.status(401).send({ error_code: 'SIGNATURE_REQUIRED' }); const signedResult = await verifySignedAuth({ tokenHashHex: keyHash, method: request.method.toUpperCase(), path: request.url.split('?')[0] ?? request.url, headers, scheme: { kind: 'eip712', fundingWallet: keyRow.funding_wallet } }); if (!signedResult.ok) return sendSignedAuthError(reply, signedResult.code); }`
6. **SKIP** chain + débito + budget header (L868-992).
7. `keyRow.erc8004_verified = isIdentityVerified(keyRow); request.a2aKeyRow = keyRow;`
8. `catch (err)` → log SIN token (`err instanceof Error ? err.message : 'unknown'`, `keyId: keyRow?.id`) → `return reply.status(503).send({ error: 'SERVICE_ERROR', message: 'Budget service temporarily unavailable' });` (idéntico a L993-1004; declará `let keyRow: A2AAgentKeyRow | null = null;` fuera del try como en el master).

#### `authenticateDelegation(request, reply, rawKey)` — `Promise<unknown>`

Orden EXACTO (subconjunto de `resolveDelegationAuth`, SIN chain/allowed_chains/per-tx/débito):
1. `const hash = ...sha256...; const delegation = await delegationService.lookupByTokenHash(hash);` — `if (!delegation) return reply.status(401).send({ error: 'Session token not found', error_code: 'INVALID_SESSION_TOKEN' });` (copia L307-312).
2. `if (delegation.revoked_at !== null) return send403delegation(reply, 'DELEGATION_REVOKED', 'Delegation has been revoked');` (L315-321).
3. `if (Date.now() >= new Date(delegation.expires_at).getTime()) return send403delegation(reply, 'DELEGATION_EXPIRED', 'Delegation has expired');` (L322-328).
4. `const parentKey = await delegationService.getParentKey(delegation.key_id); if (!parentKey?.is_active) return send403delegation(reply, 'KEY_INACTIVE', 'Parent agent key is inactive');` (L331-338).
5. **SKIP** `resolveTargetChain` (L340-344), `allowed_chains` (L346-357), per-tx + débito (L359-498).
6. `const effectiveRow = buildDelegationEffectiveRow(parentKey, delegation); effectiveRow.erc8004_verified = isIdentityVerified(parentKey); request.a2aKeyRow = effectiveRow; request.delegationRow = delegation;` (NO setear `delegationContext`).
7. `catch (err)` → log + `return reply.status(503).send({ error: 'SERVICE_ERROR', message: 'Delegation service temporarily unavailable' });` (idéntico a L532-542, con `'a2a-key delegation branch error'`).

#### `authenticateKeySession(request, reply, rawKey)` — `Promise<unknown>`

Orden EXACTO (subconjunto de `resolveKeySessionAuth`, SIN chain/débito):
1. `const hash = ...sha256...; const session = await keySessionService.lookupByTokenHash(hash);` — `if (!session) return reply.status(401).send({ error: 'Session token not found', error_code: 'SESSION_TOKEN_INVALID' });` (L559-565).
2. `if (session.revoked_at !== null) return send403session(reply, 'SESSION_TOKEN_INVALID', 'Session token has been revoked');` (L568-574).
3. `if (Date.now() >= new Date(session.expires_at).getTime()) return send403session(reply, 'SESSION_EXPIRED', 'Session has expired');` (L575-577).
4. `const parentKey = await keySessionService.getParentKey(session.key_id); if (!parentKey?.is_active) return send403session(reply, 'KEY_INACTIVE', 'Parent agent key is inactive');` (L580-587).
5. Firma HMAC (copia EXACTA de L594-615): `if (session.require_signature === true) { const headers = extractSignedHeaders(request); if (typeof headers.signature !== 'string' || headers.signature.length === 0) return reply.status(401).send({ error_code: 'SIGNATURE_REQUIRED' }); const signedResult = await verifySignedAuth({ tokenHashHex: hash, method: request.method.toUpperCase(), path: request.url.split('?')[0] ?? request.url, headers, scheme: { kind: 'hmac', signingSecretHash: session.signing_secret_hash } }); if (!signedResult.ok) return sendSignedAuthError(reply, signedResult.code); }`
6. **SKIP** `resolveTargetChain` + débito (L617-734).
7. `const effectiveRow = buildSessionEffectiveRow(parentKey, session); effectiveRow.erc8004_verified = isIdentityVerified(parentKey); request.a2aKeyRow = effectiveRow; request.keySessionRow = session;` (NO setear `keySessionContext`).
8. `catch (err)` → log + `return reply.status(503).send({ error: 'SERVICE_ERROR', message: 'Key-session service temporarily unavailable' });` (idéntico a L772-780, con `'a2a-key session branch error'`).

> **Nota de fidelidad (AC-2/CD-7):** cada código y su helper es EL MISMO que el
> resolver pago ya emite en su paso de auth. NO inventes códigos nuevos. La única
> diferencia con el path pago es que estos resolvers NO ejecutan chain/limits/débito.

**Archivo B: `src/routes/agents.ts`** — 3 cambios:

1. Import (L30): `import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';` → `import { requireA2AKey } from '../middleware/a2a-key.js';`
2. Swap del preHandler en las 4 rutas — reemplazá cada bloque
   `...requirePaymentOrA2AKey({ description: '...' })` por `...requireA2AKey()` (sin arg):
   - `POST /` L102-106
   - `PATCH /:slug` L277-281
   - `DELETE /:slug` L408-412
   - `GET /` L453-457

   Ejemplo POST:
   ```ts
   preHandler: [...requireA2AKey()],
   ```
   **Mantené** el guard interno `a2aKeyRequired` en cada handler (defensa en profundidad;
   NO lo borres). El helper `mapOwnershipError` y todo lo demás queda igual.
3. Docstring `agents.ts:16-21` — reemplazá el bloque "Seguridad reusada" por:
   ```
    * Seguridad reusada (NO reinventar):
    *   - SSRF: `validateRegistryUrl` write-time (CD-1). PATCH re-valida agentUrl.
    *   - Ownership/anti-IDOR: `OwnershipMismatchError` → 404 disclosure-safe (CD-3).
    *   - Auth: `requireA2AKey` (auth-only — sin fee/débito/x402) + guard
    *     `A2A_KEY_REQUIRED`. Publicar/actualizar/borrar/listar es GRATIS: el
    *     middleware autentica la a2a-key y NUNCA invoca pago (WKH-173).
    *   - Error estático al cliente (CD-10): el detalle va a `request.log.warn`.
   ```

**Verificación W1:** `./node_modules/.bin/tsc --noEmit` en 0 (sin `any`, todas las firmas cierran).

---

### W2 — Tests (tras W1)

**Archivo A: `src/middleware/a2a-key.test.ts`** — agregar `import { requireA2AKey }` a
la línea de import existente (L217: `import { requirePaymentOrA2AKey } from './a2a-key.js';`
→ `import { requireA2AKey, requirePaymentOrA2AKey } from './a2a-key.js';`). Nuevo describe
al final del archivo, reusando los mocks y helpers existentes (`makeKeyRow`,
`makeDelegationRow`, `makeKeySessionRow`, `TEST_KEY`, `SESSION_TOKEN`, `SESS_TOKEN`,
`mockLookupByHash`, `mockDebit`, `mockLookupToken`, `mockGetParentKey`, `mockDebitDelegation`,
`mockSessionLookup`, `mockSessionGetParent`, `mockSessionDebit`, `mockVerifySignedAuth`,
`mockGetPaymentAdapter`):

```ts
describe('requireA2AKey — auth-only (WKH-173)', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    app = Fastify();
    app.post(
      '/test-free',
      { preHandler: requireA2AKey() },
      async (request: FastifyRequest, reply: FastifyReply) =>
        reply.send({
          ok: true,
          a2aKeyId: request.a2aKeyRow?.id ?? null,
          ownerRef: request.a2aKeyRow?.owner_ref ?? null,
          allowedSlugs: request.a2aKeyRow?.allowed_agent_slugs ?? null,
        }),
    );
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    vi.clearAllMocks();
    setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
    mockExceedsPerTx.mockReturnValue(false);
  });
  // ... T-RA-01 .. T-RA-08
});
```

Specs de los 8 tests (inputs → asserts):

| Test | AC | Setup | Asserts |
|---|---|---|---|
| **T-RA-01** | AC-1 | `mockLookupByHash.mockResolvedValue(makeKeyRow())`; inject POST `/test-free` con `{ 'x-a2a-key': TEST_KEY }` | `statusCode===200`; `body.a2aKeyId===TEST_KEY_ID`; `expect(mockDebit).not.toHaveBeenCalled()`; `expect(response.headers['x-a2a-remaining-budget']).toBeUndefined()` |
| **T-RA-02** | AC-1 | `mockLookupToken.mockResolvedValue(makeDelegationRow())`; `mockGetParentKey.mockResolvedValue(makeKeyRow())`; inject con `authorization: Bearer ${SESSION_TOKEN}` | `200`; `body.ownerRef==='user-1'`; `expect(mockDebitDelegation).not.toHaveBeenCalled()`; `expect(mockDebit).not.toHaveBeenCalled()` |
| **T-RA-03** | AC-1 | `mockSessionLookup.mockResolvedValue(makeKeySessionRow())`; `mockSessionGetParent.mockResolvedValue(makeKeyRow())`; inject con `authorization: Bearer ${SESS_TOKEN}` | `200`; `body.a2aKeyId===TEST_KEY_ID`; `expect(mockSessionDebit).not.toHaveBeenCalled()`; `expect(mockDebit).not.toHaveBeenCalled()` |
| **T-RA-04** | AC-2 | matriz (usar `it.each` o casos sueltos): master `lookupByHash→null` → 403 `KEY_NOT_FOUND`; master `makeKeyRow({is_active:false})` → 403 `KEY_INACTIVE`; deleg `lookupToken→null` → 401 `INVALID_SESSION_TOKEN`; deleg `revoked_at` set → 403 `DELEGATION_REVOKED`; deleg `expires_at` pasado (`new Date(Date.now()-1000).toISOString()` + `policy.expires_at` pasado si aplica) → 403 `DELEGATION_EXPIRED`; deleg parent `is_active:false` → 403 `KEY_INACTIVE`; sess `sessionLookup→null` → 401 `SESSION_TOKEN_INVALID`; sess `expires_at` pasado → 403 `SESSION_EXPIRED`; sess parent `is_active:false` → 403 `KEY_INACTIVE` | por cada caso: `statusCode` y `json().error_code` esperados; `mockDebit`/`mockDebitDelegation`/`mockSessionDebit` `not.toHaveBeenCalled()` |
| **T-RA-05** | AC-3 | (a) inject SIN `x-a2a-key` ni `authorization`; (b) inject con `'x-payment': <base64 payload>` pero SIN a2a-key | ambos: `403`, `json().error_code==='A2A_KEY_REQUIRED'`; `expect(mockGetPaymentAdapter).not.toHaveBeenCalled()` (x402 nunca tocado, cierra el hallazgo de pago-real perdido) |
| **T-RA-06** | AC-4 | deleg: `makeDelegationRow({ policy: { ...basePolicy, allowed_agent_slugs: ['my-weather-agent'] } })` (armá el policy completo con los defaults de `makeDelegationRow`); `mockGetParentKey.mockResolvedValue(makeKeyRow())` | `200`; `body.allowedSlugs` deep-equals `['my-weather-agent']`; `body.ownerRef==='user-1'` (ownership guard operable). Confirma que el builder compartido W0/DT-B produce el scoping correcto |
| **T-RA-07** | AC-7 | (a) master `makeKeyRow({ require_signature: true, funding_wallet: '0x...' })`, SIN headers de firma → `401 SIGNATURE_REQUIRED`; (b) mismo con `x-a2a-signature/nonce/timestamp` presentes + `mockVerifySignedAuth.mockResolvedValue({ ok: true })` → `200`; (c) sesión `makeKeySessionRow({ require_signature: true, signing_secret_hash: '...' })` sin firma → `401 SIGNATURE_REQUIRED` | statusCodes + `error_code` esperados; en (a)/(c) `mockVerifySignedAuth` no llamado / o llamado según corresponda |
| **T-RA-08** | AC-8 / DT-C | master `makeKeyRow({ daily_limit_usd: '10.000000', daily_spent_usd: '10.000000', daily_reset_at: new Date(Date.now()+86400000).toISOString(), max_spend_per_call_usd: '0.01' })` (limit agotado) | `200` igual (auth-only NO chequea spend-limits); `expect(mockDebit).not.toHaveBeenCalled()`. Confirma el cambio de comportamiento intencional |

> **Opcional recomendado (T-RA-BLD):** test unitario directo de `buildDelegationEffectiveRow`
> / `buildSessionEffectiveRow` contra el objeto esperado (ancla el contrato del builder).
> Importalos de `./a2a-key.js` (ya `export`).

**Archivo B: `src/routes/agents.publish.test.ts`** — actualizar SOLO el mock (L77-84):
```ts
vi.mock('../middleware/a2a-key.js', () => ({
  requireA2AKey: () => [
    async (request: { a2aKeyRow?: { id: string; owner_ref: string } }) => {
      if (currentOwner === null) return;
      request.a2aKeyRow = { id: 'fake-key-id', owner_ref: currentOwner };
    },
  ],
}));
```
NADA más cambia: T-PUB-01…19, T-143B-*, T-PUB-12 (`currentOwner=null` → cae al guard
interno → `403 A2A_KEY_REQUIRED`) siguen verdes (la ruta solo lee `a2aKeyRow.owner_ref`).

**Archivo C: `src/routes/agents.ownership.test.ts`** — misma actualización del mock (L68-75),
idéntico patrón (`currentOwner` default `'tenant-B'`). Los ownership tests siguen verdes.

---

## 5. Patrones a seguir (exemplars verificados)

| Necesitás | Copiá de (path:línea verificado) |
|---|---|
| Orden del dispatcher | `src/middleware/a2a-key.ts:1013-1050` |
| effectiveRow delegación | `src/middleware/a2a-key.ts:503-513` |
| effectiveRow sesión | `src/middleware/a2a-key.ts:740-754` |
| Master: hash/lookup/is_active/firma | `src/middleware/a2a-key.ts:796-866` |
| Firma HMAC sesión | `src/middleware/a2a-key.ts:594-615` |
| Helpers de error | `src/middleware/a2a-key.ts:92-157` |
| catch 503 por branch | master L993-1004 / deleg L532-542 / sess L772-780 |
| Mount de ruta test + inject | `src/middleware/a2a-key.test.ts:274-296` |
| makeKeyRow / makeDelegationRow / makeKeySessionRow | `a2a-key.test.ts:244-270 / 1273-1299 / 1732-1754` |
| Mock de auth en route-tests | `agents.publish.test.ts:77-84` / `agents.ownership.test.ts:68-75` |

---

## 6. Done Definition

- [ ] W0: 2 builders puros agregados + 2 call-sites (deleg/sesión) rewireados. Suite deleg/sesión existente 100% verde SIN tocar tests (gate duro).
- [ ] W1: `requireA2AKey()` + 3 resolvers auth-only agregados; NO importan/invocan x402, débito, chain ni spend-limits. 4 rutas de `agents.ts` swappeadas a `...requireA2AKey()`. Guard interno `a2aKeyRequired` intacto. Docstring `:16-21` actualizado.
- [ ] W2: 8 tests T-RA verdes + mocks de `agents.publish.test.ts` / `agents.ownership.test.ts` actualizados a `requireA2AKey`.
- [ ] `resolveMasterAuth` / `resolveDelegationAuth` / `resolveKeySessionAuth` con débito byte-idéntico (único cambio permitido: el literal effectiveRow → builder). `requirePaymentOrA2AKey` sigue siendo el preHandler de compose/orchestrate/gasless/registries.
- [ ] **Biome ANTES del gate (CD-8):** `./node_modules/.bin/biome check --write src/middleware/a2a-key.ts src/routes/agents.ts src/middleware/a2a-key.test.ts src/routes/agents.publish.test.ts src/routes/agents.ownership.test.ts` — usar el binario directo de `node_modules/.bin` (rtk rompe `npx`/`npm biome`).
- [ ] Suite completa (CD-4): `./node_modules/.bin/tsc --noEmit` + `./node_modules/.bin/biome check` + `./node_modules/.bin/vitest run` TODOS en 0.
- [ ] Si `lint` global reporta errores (CD-9): separar los propios de los PRE-EXISTENTES con `git diff origin/main -- <file>`; NO tocar deuda fuera de scope.
- [ ] NO commit, NO deploy (W3 = paso operativo humano post-merge, fuera de F3).

---

## 7. Fuera de scope (NO hacer)

- `registries.ts`, Fix 2 default-chain, deploy Railway (W3) → tickets/pasos aparte.
- NO agregar campos a `declare module 'fastify'`. NO setear `delegationContext`/`keySessionContext`/`x-a2a-remaining-budget` en el path auth-only.
- NO refactorizar `resolveTargetChain`, `resolveEstimatedCostUsd` ni el control-flow de débito de los 3 resolvers pagos.
