# Auto-Blindaje — WKH-55 Downstream x402 Payment

> Lecciones críticas para futuras HUs extraídas del pipeline completo (F0→F4) de WKH-55.

---

## AB-WKH-55-1 — NexusAgil pipeline ejecutado correctamente (F0→F4)

**Hallazgo**: Esta HU SÍ se ejecutó por el pipeline completo:
- F0 + F1: `nexus-analyst` generó work-item con 12 ACs EARS
- F2: `nexus-architect` generó SDD full con 17 CDs, 5 waves, resolvió 4 Missing Inputs, verificó grounding en disco
- F2.5: `nexus-architect` generó story-WKH-55 auto-contenida (1704 LOC) como ÚNICA fuente de verdad para Dev
- F3: `nexus-dev` implementó 408 tests (388 baseline + 20 nuevos), 5 waves ejecutadas secuencialmente, commits 6ab8e52 + cb095ef
- AR: `nexus-adversary` ejecutó ataque arquitectónico (cero BLOQUEANTEs, 3 MENORs identificados)
- CR: `nexus-adversary` revisó código con 7 sugerencias cosméticas (0 CHANGES_REQUESTED)
- F4: `nexus-qa` validó 12/12 ACs con evidencia archivo:línea, 17/17 CDs cumplidos, build+tests+drift OK
- DONE: `nexus-docs` consolida en este report

**Lección**: El pipeline NexusAgil que falló en WKH-52 (saltó F2.5, el Dev codificó sin story) **funcionó correctamente esta vez**. Los gates humanos (HU_APPROVED, SPEC_APPROVED) y los sub-agentes one-shot con outputs inmutables permiten paralelismo de fases y validación acumulativa sin regresión. **Marcador positivo para futuras HUs en modo QUALITY**: respeta el proceso 7-paso sin saltearse.

---

## AB-WKH-55-2 — CRÍTICA: Patrón ADITIVO no REPLACE en capas de autenticación

**Contexto**: WKH-55 añade una capa outbound (downstream x402 Fuji) encima de la capa inbound existente (upstream x-agent-key Kite x402). Las dos capas son completamente ortogonales:

```
Cliente → Gateway (x-agent-key inbound) → Marketplace (x402 outbound)
         (DT-B: ADITIVO, NO reemplaza)
```

**Hallazgo**: El código respeta CD-2 (cero regresión cuando `WASIAI_DOWNSTREAM_X402` no está seteado). El middleware de inbound (`a2a-key.ts`, `x402.ts`) NO se toca. La nueva lógica vive en `src/lib/downstream-payment.ts` aislada, y se inyecta post-invoke en `composeService.invokeAgent` como fire-and-forget.

**Conectado a futuro Kite Agent Passport (engram #70)**:

Cuando el equipo de Kite termine el Agent Passport, el path de integración será:
1. Nuevo middleware `requireKitePassport` (junto a `requirePaymentOrA2AKey`)
2. Este middleware setea `request.ownerRef` y otros claims del Passport
3. El parámetro `ownerRef` se propaga a los services (budgetService, discoveryService, etc.)
4. **Las HUs de la capa outbound (WKH-55 aquí, WAS-V2-1 en marketplace) NO se tocan** en ese cambio

La **regla "aditivo no replace"** es la guardia que mantiene los layers desacoplados. Si WKH-55 hubiera REEMPLAZADO el flujo de inbound (por ej, removiendo `x-agent-key` e interpretando Passport directamente), la integración futura requeriría refactorizar WKH-55. En cambio, con patrón aditivo:

- WKH-55 recibe `request` con `request.a2aKeyRow` (inbound auth ya hecho) ✅
- WKH-55 añade downstream payment (outbound) ✅
- Futuro Passport hace un NUEVO middleware que setea `request.ownerRef` + claims ✅
- WKH-55 puede opcionalmente LEER `request.ownerRef` si existe, pero NO lo requiere ✅

**Documentar explícitamente en CLAUDE.md o BACKLOG.md**: "Cuando Kite team termine Agent Passport (engram #70), el camino de integración es un nuevo middleware sin tocar capas outbound."

---

## AB-WKH-55-3 — Anti-regresión de decimales: NUNCA usar Math.round×1e6 disperso

**Contexto del riesgo (R-3 del work-item)**:

- Kite/PYUSD: 18 decimales → `BigInt(Math.round(x * 1e6)) * BigInt(1e12)` ✅ correcto
- Fuji/USDC: 6 decimales → `BigInt(Math.round(x * 1_000_000))` equivalente a `parseUnits(x.toString(), 6)` ✅ correcto

El código en `src/services/compose.ts:189` (Kite) y `src/lib/downstream-payment.ts:122` (Fuji) diverge intencionalmente **y eso es correcto**. Pero el riesgo es que un Dev futuro copie la fórmula Kite a un nuevo adapter sin ajustar decimales.

**Hallazgo**: CD-NEW-SDD-5 lo prohíbe explícitamente:
```
**PROHIBIDO** literal `6` para decimales en código de cómputo.
Usar constante `FUJI_USDC_DECIMALS = 6 as const`.
Para amount: `parseUnits(agent.priceUsdc.toString(), FUJI_USDC_DECIMALS)`.
**PROHIBIDO** `BigInt(Math.round(x * 1_000_000))` aunque sea matemáticamente equivalente.
```

Y el test T-W2-14 valida bit-a-bit:
```
priceUsdc=0.5 → atomicValue=500000n (NO 500000000000000000n)
```

**Lección para futuras HUs** (especialmente si se añade otra chain, ej: Polygon/USDC 6dec, Mainnet/USDC 6dec):

1. Definir una constante de decimales **POR CHAIN/TOKEN**, nunca hardcodeada
2. Validar en el test que el resultado sea menor de `1e9` si decimales < 9 (guardia anti-18dec)
3. Documentar el value en el log: `{ atomicValue: value.toString(), decimals: DECIMALS }` para auditabilidad

---

## AB-WKH-55-4 — Never-throw guarantee en módulos de pago críticos

**Hallazgo**: `signAndSettleDownstream` NUNCA hace `throw`, respeta CD-NEW-SDD-6. Cada error path:

```ts
// BIEN
try {
  const res = await fetch(...);
  // ...
} catch (e) {
  logger.warn({ code, detail: String(e) }, 'error msg');
  return null;  // ← Never throw
}

// MAL (no existe en código, pero posible bug en V2)
try {
  const res = await fetch(...);
} catch (e) {
  throw new Error(`Downstream settle failed: ${e}`);  // ← Esto ROMPE el invoke upstream
}
```

**Aplicabilidad**:

- `signAndSettleDownstream` → módulo de pago downstream (WKH-55) → never-throw ✅
- `signAndSettleUpstream` (en kite-ozone/payment.ts) → módulo de pago upstream (Kite) → ¿throw? ⚠️ Requiere verificación en WKH-44/53

**Lección para futuras HUs de pago**:

Cualquier módulo que transfiera fondos en blockchain debe adherirse a "never-throw guarantee" si se inyecta en camino crítico del request HTTP. Si el pago downstream falla, el invoke debe completarse normalmente (sin error) para que el cliente reciba la respuesta. El pago es "secundario" desde la perspectiva del cliente (lo primario es obtener el output del agente).

---

## AB-WKH-55-5 — Body x402 v2: Constructor explícito, NO spread de campos

**Hallazgo**: El facilitator valida el body x402 con Zod `.strict()` (rechaza campos extra). El constructor en `downstream-payment.ts:174-200` declara explícitamente:

```ts
// BIEN
return {
  x402Version: 2,
  resource: { url: 'https://wasiai.ai/downstream' },
  accepted: { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra },
  payload: { signature, authorization },
};

// MAL (aunque compilaría)
return {
  ...baseBody,
  ...builtFields,  // ← Riesgo: campos extra si baseBody las tiene
  signature, authorization,
};
```

**Aplicabilidad**: Cuando construyas un envelope criptográfico (x402, EIP-712, JWT, etc.) para enviar a un contrato/servicio que valida schema:

1. **Declarar explícitamente cada campo** (no usar spread)
2. **Testear el shape final** antes de firmar — mismatch de estructura → firma inválida en cadena
3. **Versionar el envelope** (`x402Version`, `eip712Version`) — facilita upgrades sin regresión

---

## AB-WKH-55-6 — Warning-once pattern para defaults de env vars

**Hallazgo**: `getFujiUsdcAddress()` implementa el patrón heredado de `payment.ts`:

```ts
let _warnedDefaultUsdc = false;

function getFujiUsdcAddress(): `0x${string}` {
  const env = process.env.FUJI_USDC_ADDRESS;
  if (!env) {
    if (!_warnedDefaultUsdc) {
      _warnedDefaultUsdc = true;
      console.warn(`[WKH-55] FUJI_USDC_ADDRESS not set, using default ${DEFAULT_FUJI_USDC}`);
    }
    return DEFAULT_FUJI_USDC;
  }
  return env as `0x${string}`;
}
```

Esto garantiza que si FUJI_USDC_ADDRESS está ausente en env, se advierte UNA SOLA VEZ en los logs de la app, no por cada request.

**Aplicabilidad**: Para cualquier env var que tenga un default razonable:
1. Definir constante `DEFAULT_*`
2. Leer var con `process.env.*`
3. Si ausente y `!_warned*`, log warn + set flag
4. Retornar default
5. En tests: mockear el env var para evitar el warn

---

## AB-WKH-55-7 — Lazy-init de viem clients con error handling

**Hallazgo**: `buildClients()` valida configuración antes de crear:

```ts
function buildClients() {
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk || !pk.startsWith('0x')) return null;
  const rpc = process.env.FUJI_RPC_URL;
  if (!rpc) return null;
  // ← Crear clients SOLO si ambas vars están ok
  const account = privateKeyToAccount(pk as `0x${string}`);
  // ...
}

// En caller
const clients = buildClients();
if (!clients) {
  logger.warn({ code: 'CONFIG_MISSING' }, '...');
  return null;  // ← Non-blocking
}
```

**Ventaja sobre module-level init**:
- Tests pueden mockear fácilmente (no hay clients cacheados globales)
- Error handling es explícito (no un `throw` al import)
- Cada call a `signAndSettleDownstream` revalida config (aunque sea redundante, es defensivo)

---

## AB-WKH-55-8 — Mocking viem: Replicar el chain exacto, no solo signatures

**Hallazgo** (aplicando AB-WKH-44-#2): Los tests mockan `viem.signTypedData` y `viem.readContract`, pero validan que el **domain pasado** sea exacto:

```ts
// Test snapshot (T-W2-13)
const capturedDomain = calls[0].domain;
expect(capturedDomain).toEqual({
  name: 'USD Coin',
  version: '2',
  chainId: 43113,
  verifyingContract: FUJI_USDC,
});
```

No se verifica la signature interna (eso es responsabilidad de viem), pero SÍ se valida que el domain sea exacto. Esto evita que un bug en el code del domain (ej: `version: '1'` en lugar de `'2'`) no se detectable en unit tests.

---

## AB-WKH-55-9 — Post-invoke timing es correcto, pero documenta el trade-off

**Hallazgo** (DT-E §4.1): El downstream payment se ejecuta **después** del invoke al agente.

- **PRO**: Si invoke falla, no se paga sin servicio entregado (semánticamente correcto)
- **CON**: Si settle falla, se entregó servicio sin cobro

**En V1 hackathon esto es aceptado**. En V2 se podría considerar "commit-deliver-settle" (transaccional on-chain con contrato escrow). **Documentar explícitamente en BACKLOG.md** o `doc/architecture/PAYMENT-FLOW.md`:

> "WKH-55 usa 'pay-on-delivery' (post-invoke). El riesgo de no-cobro en caso de settle failure es aceptado para V1. WKH-56+ investigará escrow on-chain con confirmación dual."

---

## AB-WKH-55-10 — Test baseline: 388 → 408 (+20), cero regresión

**Hallazgo**:
- Pre-WKH-55 baseline: 388 tests
- Post-WKH-55 suite: 408 tests (20 nuevos)
- Cobertura: 12/12 ACs mapeados a tests
- Todos los tests PASS, cero flaky

**Lección**: La suite de tests es una **invariante de quality**. Cada AC → ≥1 test. Cada CD → validable. El SDD especifica explícitamente cómo valida (§8 Test plan). Esto evita "tests oscuros" que nadie entiende.

---

## Resumen

| AB | Foco | Aplicabilidad | Prioridad |
|---|---|---|---|
| AB-WKH-55-1 | Pipeline ejecutado limpio | Todas futuras HUs QUALITY | ⭐⭐⭐ |
| AB-WKH-55-2 | ADITIVO no REPLACE (Kite Passport futura) | Integración multiauth | ⭐⭐⭐ |
| AB-WKH-55-3 | Anti-decimales: const+parseUnits, NO literal | Próximos adapters multichain | ⭐⭐⭐ |
| AB-WKH-55-4 | Never-throw en módulos críticos | Pago downstream, upstream, etc | ⭐⭐⭐ |
| AB-WKH-55-5 | Constructor explícito, NO spread | Envelopes criptográficos | ⭐⭐ |
| AB-WKH-55-6 | Warning-once para defaults | Env vars con defaults razonables | ⭐⭐ |
| AB-WKH-55-7 | Lazy-init + error handling | Clientes externos (viem, RPC) | ⭐⭐ |
| AB-WKH-55-8 | Mock viem: validar domain exacto | Tests de EIP-712 futuro | ⭐⭐ |
| AB-WKH-55-9 | Pay-on-delivery timing + trade-off doc | Specs futuro escrow | ⭐ |
| AB-WKH-55-10 | Test suite invariante (388→408, 12/12 AC) | Todas futuras | ⭐⭐⭐ |
