# Auto-Blindaje — Cross-Chain E2E Retro (063)

**Fecha**: 2026-04-28
**Sprint**: Hackathon Kite — cross-chain E2E debugging
**PRs cubiertas**: #48 (edde596), #49 (7c3419f), #50 (7187ccb), #51 (a552508), #52 (e4d217d)
**Status**: DONE
**Especialista**: nexus-architect (F2 retrospectivo)

Lecciones extraídas en cascada de los 5 PRs del 2026-04-28. Cada AB nace de
un síntoma observado en producción (smoke fail en Railway) y se documenta
para que **no se repita** en futuras HUs cross-chain.

Prefijo `AB-CROSS-CHAIN-N` (no `AB-WKH-XX-N`) porque no hay WKH numerada —
es un sprint reactivo. Permite `grep -r 'AB-CROSS-CHAIN' doc/` para hard-won
lessons sin work-item formal.

---

## AB-CROSS-CHAIN-1 — Pieverse-style envelope vs x402 spec-literal: verificar `GET /supported` antes del switch

**Contexto**: Cuando hicimos `KITE_FACILITATOR_URL=https://wasiai-facilitator-...`, el adapter siguió fallando con HTTP 400 INVALID_PAYLOAD aunque los paths ya estaban corregidos (PR #48). El envelope `{paymentPayload, paymentRequirements}` venía de Pieverse spec, no de x402 canonical (EIP-3009 firmado contra el contrato del **token**, no del **facilitator**).

**Causa raíz**: dos modos de envelope distintos co-existen en `src/adapters/kite-ozone/payment.ts`:
- `mode: 'pieverse'` — firma `primaryType: 'Authorization'` contra el contrato del facilitator.
- `mode: 'x402'` — firma `TransferWithAuthorization` contra el contrato del token PYUSD directamente (spec EIP-3009 literal).

Ambos POSTean al mismo path `/verify` (post-PR #48), pero el body es incompatible. Si el facilitator entiende solo uno y nosotros mandamos el otro, error 400.

**Fix aplicado**: setear `KITE_FACILITATOR_MODE=x402` en Railway env (cambio infra, no código).

**Aplicar en**: cualquier HU futura que cambie `KITE_FACILITATOR_URL` o agregue un nuevo facilitator:

1. **PROBE OBLIGATORIO**: `GET ${facilitatorUrl}/supported` antes del switch. Verifica:
   - chains soportadas matchean `KITE_CHAIN_ID` y/o `FUJI_CHAIN_ID`.
   - response shape indica el envelope esperado (Pieverse devuelve `{chains: [...]}` con extras; x402 spec devuelve solo `{kinds, chains}`).
2. **Documentar mode en commit message** del PR que cambia la URL.
3. Si el adapter solo soporta un mode, **rechazar el switch** sin antes implementar el otro.

**Antipatrón evitado**: cambiar URL en env y "ver qué pasa". El smoke fail es indistinguible del bug de path o de schema drift — investigation cycle es 5-10 min cada round.

**Referencias cruzadas**: ninguna previa. Esta es nueva.

---

## AB-CROSS-CHAIN-2 — Schema drift en cascada: cuando una API cambia, mapeo se rompe en MÚLTIPLES puntos

**Contexto**: PR #49 fixó 3 cosas en una sola función (`readPayment`):
1. `obj.method` → fallback `obj.protocol`
2. `obj.chain` → fallback `raw.chain`
3. `chain === "avalanche-testnet"` → normalizar a `"avalanche"` (downstream guard expects canonical)

Los 3 vienen del **mismo origin** (wasiai-v2 schema drift, ya documentado en SDD 057-wkh-57-was-v2-3-client) pero rompen en **3 spots diferentes** del pipeline cross-chain. Nuestro código tenía guards en cada spot, así que cada drift point necesitaba su propio fallback.

**Causa raíz**: cuando un servicio externo evoluciona su schema (rename `method` → `protocol`, mover `chain` a top-level, agregar suffix `-testnet`), el código consumidor lo encuentra **N veces** según cuántos data points use. Aquí N=3.

**Patrón obligatorio para futuras integraciones de marketplace externo**:

1. **Defensivo en boundary** (`readPayment`, `parseAgent`, `mapInvokeResponse`): aplicar fallbacks en UN solo lugar, no esparcidos por el pipeline.
2. **Type guard returns Optional**: `function readPayment(): ParsedPayment | undefined`, NO throw. El caller decide si es fatal.
3. **Test cases por shape**: por cada marketplace soportado, un test que use el shape REAL (no mock canonical). Ejemplos: `wasiai-v2-shape.test.ts`, `kite-shape.test.ts`.
4. **Log when fallback fires**: `if (obj.protocol && !obj.method) console.warn('schema drift: protocol fallback', { agentId })`. Permite ver en Railway logs si un marketplace está drifteado y aún funciona.

**Aplicar en**: cualquier HU que agregue un nuevo `discoveryEndpoint` o consuma una nueva versión de marketplace API. Antes de mergear, validar:

```bash
# 1. Hit el discoveryEndpoint real
curl -s $REGISTRY_URL/discover | jq '.[0]'
# 2. Comparar shape con lo que readPayment espera
grep -n 'obj\.method\|obj\.chain\|obj\.contract' src/services/discovery.ts
# 3. Si hay drift, agregar fallback ANTES del PR
```

**Antipatrón evitado**: agregar el fallback solo en el spot que falla en smoke, dejando los otros spots silenciosamente broken.

**Referencias cruzadas**:
- SDD 057-wkh-57-was-v2-3-client (origen del drift)
- WAS-V2-3-CLIENT-2 (commit 67eed1e: payTo fallback to metadata.payment.contract)

---

## AB-CROSS-CHAIN-3 — Sentinels compartidos = cross-tenant takeover (NUNCA usar valores fijos como ownerRef)

**Contexto**: Durante el debugging cross-chain, un fix temprano cayó en `request.a2aKeyRow?.owner_ref ?? 'x402-anonymous'` para que las requests x402-puro (sin a2a-key) tuvieran "algún" ownerRef. Esto colapsó a TODOS los payers x402 en un mismo "tenant" — cualquier atacante con $1 USDC podía pasar el ownership guard contra registries creados por otros payers x402.

**Causa raíz**: confundir "no tener tenant verificable" con "tenant anónimo compartido". Un sentinel compartido NO es identidad — es lo opuesto a un ownership guard.

**Fix aplicado**: rechazar POST/PATCH/DELETE con `403 A2A_KEY_REQUIRED` cuando `request.a2aKeyRow` es undefined. El path x402 puro queda read-only para registries (GET sigue público). **Documentado en detalle en SDD 060-wkh-63-sec-reg-1.**

**Aplicar en**: cualquier ownership column en futuras tablas (`tasks` en WKH-54, etc.).

**Regla absoluta**: **NUNCA usar sentinels compartidos como ownerRef**. Si no hay tenant identity verificable (a2a-key o equivalente con propiedad criptográfica/exclusiva), la mutación debe rechazarse — no normalizarse a un sentinel.

**Antipatrón evitado**: `'x402-anonymous'`, `'public'`, `'system'`, `null`, `''` como ownerRef. Todos colapsan tenants distintos en uno.

**Referencias cruzadas**:
- **SDD 060-wkh-63-sec-reg-1** (cobertura completa, AR/CR + remediation)
- CD-5 en `sdd.md` (heredada)

---

## AB-CROSS-CHAIN-4 — `node:vm` no es security boundary (heredada WKH-60)

**Contexto**: Durante el sprint security, WKH-60 reveló que el L2 transform cache + `new Function()` permitía RCE multi-tenant. La solución fue mover ejecución a `worker_threads` con timeout y memory limits.

**Causa raíz**: `node:vm` y `new Function()` ejecutan código en el MISMO event loop con acceso al ambiente del proceso. No son sandbox.

**Aplicar en**: cualquier HU que necesite ejecutar código user-provided (transforms, scripts, formulas).

**Reglas**:
- PROHIBIDO `eval()`, `new Function()`, `vm.runInNewContext()` con código user-provided.
- Si necesitás user code execution: `worker_threads` con `resourceLimits` o paquetes como `isolated-vm`.
- Cache key del resultado debe incluir un fingerprint del código (HMAC con server secret) para evitar cache poisoning cross-tenant.

**Referencias cruzadas**:
- **SDD 062-wkh-60-sec-rce-1** (cobertura completa de remediation con `worker_threads` + cache hardening)
- CD-6 en `sdd.md` (heredada)

---

## AB-CROSS-CHAIN-5 — CONFIG_MISSING silencioso es UX killer en debugging (PR #50/#51)

**Contexto**: Layer 6 de la cascada (ver `sdd.md` §3): post-PR #49 (schema fallbacks OK), el smoke seguía sin generar Fuji txs. Tracing reveló que `signAndSettleDownstream` retornaba `null` sin loggear razón. Causa real: `FUJI_RPC_URL` no estaba en Railway env. La función fallaba silently en init del RPC client y devolvía null sin discriminate `flag-off` vs `flag-on-but-broken`.

**Costo del bug**: ~30 min de investigation + 1 PR temporal (#50, debug logs) + 1 PR cleanup (#51). Si el helper hubiera loggeado `CONFIG_MISSING FUJI_RPC_URL` al startup, el debug habría sido 30 segundos.

**Causa raíz**: silent-fail por defaults `?? null` o try/catch swallowing en init paths. Al consumer le llega `null` sin contexto.

**Fix aplicado en PR #50** (instrumentación temporal):
```ts
// FLAG_OFF + envValue raw para diagnosticar typos
console.log('[downstream] FLAG_OFF', { envValue: process.env.WASIAI_DOWNSTREAM_X402 });
// FLAG_ON + agent.priceUsdc + payment.method/chain para diagnosticar shape
console.log('[downstream] FLAG_ON', { priceUsdc, method, chain });
```

Removido en PR #51 una vez identificada la causa real.

**Patrón obligatorio para futuras HUs con env vars críticas**:

1. **Startup validation**: en `src/index.ts` o equivalente, log estructurado:
   ```ts
   const required = ['FUJI_RPC_URL', 'KITE_FACILITATOR_URL', 'OPERATOR_PRIVATE_KEY'];
   for (const v of required) {
     if (!process.env[v]) console.error(`CONFIG_MISSING ${v}`);
   }
   ```
2. **First-use validation**: en el helper que usa la env var, si está missing, throw `ConfigMissingError` con el nombre exacto. NO retornar null silently.
3. **Log envValue raw (truncated)** cuando un guard falla, no solo el resultado del guard. Permite distinguir `flag=undefined` de `flag='false'` de `flag='False'` (case sensitivity).
4. **Feature-flag guards**: log el nombre del flag + el valor parseado + la decisión:
   ```ts
   const enabled = process.env.WASIAI_DOWNSTREAM_X402 === 'true';
   if (!enabled) {
     console.log('[feature] disabled', { flag: 'WASIAI_DOWNSTREAM_X402', raw: process.env.WASIAI_DOWNSTREAM_X402 });
     return null;
   }
   ```

**Antipatrón evitado**: `if (!process.env.X) return null;` sin log. El consumer no sabe si la flag está OFF intencional o si hay un typo.

**Referencias cruzadas**: ninguna previa.

---

## AB-CROSS-CHAIN-6 — Reply.sent guards post-await previenen FST_ERR_REP_ALREADY_SENT (PR #52)

**Contexto**: Logs Railway 2026-04-28T13:57 UTC mostraban `FST_ERR_REP_ALREADY_SENT` después de cross-chain pipelines exitosos. Causa: `createTimeoutHandler` disparaba 504 mientras el x402 middleware estaba en `await verify()` o `await settle()` (5-10s cada uno). Cuando el await resolvía, código intentaba `reply.status(402).send(...)` y Fastify throw porque el reply ya fue enviado por el timeout handler.

**Causa raíz**: race condition entre el timeout middleware y el handler async. Pattern obligatorio en Fastify para handlers con awaits >5s: chequear `reply.sent` antes de cada `reply.send` y `reply.header` post-await.

**Fix aplicado (PR #52, e4d217d)**:
```ts
// Antes de cada reply post-await:
if (reply.sent) return;

// Antes de reply.header al final:
if (!reply.sent) reply.header('payment-response', settleResult.txHash);
```

5 guards introducidos en `src/middleware/x402.ts:127`, `:141`, `:160`, `:172`, `:185`.

**Aplicar en**: cualquier middleware Fastify con awaits >5s. Checklist:

1. ¿El middleware tiene `await` en su handler?
2. ¿El proyecto usa `createTimeoutHandler` o algún preHandler de timeout?
3. ¿El `reply` se llama después de awaits?

Si los 3 son sí: agregar `if (reply.sent) return;` antes de cada `reply.send`/`reply.header` post-await. **No es opcional** — sin esto, errores son silentes en happy path pero ruidosos en logs cuando el system está bajo presión.

**Patrón sugerido para automatizar**:
```ts
// helper:
const sendIfNotSent = <T>(reply: FastifyReply, fn: () => T): T | void => {
  if (reply.sent) return;
  return fn();
};
// usage:
return sendIfNotSent(reply, () => reply.status(402).send(error));
```

(NO aplicado en PR #52 — guards inline para no introducir abstraction extra. Pero sugerido para refactor futuro si los call sites crecen.)

**Antipatrón evitado**: handlers async largos sin reply guard → log noise + flaky tests bajo timeout pressure.

**Referencias cruzadas**: ninguna previa.

---

## Próximos pasos sugeridos (TD-CROSS-CHAIN)

| # | Tema | Archivo sugerido | Prioridad |
|---|------|-----------------|-----------|
| TD-CC-1 | Test unit para reply.sent guard (mock Fastify reply lifecycle) | `src/middleware/__tests__/x402-timeout-race.test.ts` | MEDIA |
| TD-CC-2 | Startup validation `CONFIG_MISSING` logger | `src/lib/env-validation.ts` (nuevo) | ALTA |
| TD-CC-3 | Fixture-based tests por marketplace shape (wasiai-v2, kite, otros) | `src/services/__tests__/discovery-shapes.test.ts` | MEDIA |
| TD-CC-4 | Helper `sendIfNotSent(reply, fn)` para abstraer guards | `src/lib/fastify-reply-guard.ts` (nuevo) | BAJA |
| TD-CC-5 | Documentar facilitator probe en runbook deploy | `doc/runbook/facilitator-switch.md` (nuevo) | MEDIA |

Estos NO son blockers para esta HU retro — quedan como **TD documentado** para sprints futuros.
