# Work Item — [WKH-192] Seam `settlePaymentIntentOnChain` decimals-aware (pre-requisito de activación 191d)

## Resumen

`settlePaymentIntentOnChain` (`src/services/payment-intent.ts:355-471`, seam auditado WKH-136) calcula el
monto atómico a firmar/settlear con `usdToWei()` (`:153-157`), que asume **18 decimales hardcodeados**
(fórmula `BigInt(Math.round(usd*1e6)) * BigInt(1e12)`). Hoy eso es correcto porque el default chain es
SIEMPRE Kite (PYUSD, 18d). Pero `WasiAIEscrow` (WKH-126a/b) está deployado en **Base Sepolia**, cuyo USDC
tiene **6 decimales**, y `base/payment.ts:sign()` toma `value` verbatim como atómico 6d (no hace ninguna
conversión — es decimals-agnóstico por diseño). En cualquier config `default-chain=base-*` (la única
auto-consistente para activar el escrow-settle no-custodial de WKH-191b, hallazgo R-1/MI-1 documentado en
`doc/sdd/174-wkh-191b-escrow-settle-rewire/done-report.md:50-55`), hop 2 del two-hop firmaría **10¹²× el
monto correcto** → `settle.success===false` (money-safe, cae a `reconciliation-pending`, nunca dobla-paga
ni pierde fondos, pero el happy-path NUNCA completa en Base). Esta HU hace el seam decimals-aware —
pre-requisito de código de WKH-191d (activación).

## Sizing

- SDD_MODE: full (money-path, seam auditado WKH-136, mismo rigor que 191a/191b/191c)
- Estimación: S (single choke-point, un archivo, sin migración, sin cambios de contrato)
- Branch sugerido: `fix/192-wkh-192-settle-decimals-aware`

## Acceptance Criteria (EARS)

- AC-1: WHEN `settlePaymentIntentOnChain` computa el monto atómico a firmar/settlear para una chain
  cuyo token soportado tiene `decimals !== 18` (p.ej. USDC en Base, 6 decimales), the system SHALL
  derivar el atómico usando los `decimals` REALES del token del `PaymentAdapter` resuelto (NUNCA un
  literal `18` ni `1_000_000_000_000` hardcodeado).
- AC-2: WHILE el default chain siga siendo Kite (PYUSD, 18 decimales) — la config de HOY —, the system
  SHALL producir un `wei` byte-idéntico al que produce el `usdToWei` actual para el mismo
  `finalAmountUsd`, sin ningún drift de comportamiento en el path operator-custodial en producción.
- AC-3: IF `getPaymentAdapter().supportedTokens[0]` es irresoluble (registry mal inicializado / bundle
  sin token — caso hoy inalcanzable en producción, solo en tests mal configurados), THEN the system
  SHALL usar 18 decimales como fallback (preserva el único comportamiento de hoy) y NUNCA SHALL lanzar
  (`throw`) fuera de `settlePaymentIntentOnChain` — CD-7 (`never reject the promise`) permanece intacto.
- AC-4: WHEN el hop 2 (seam) firma/settlea un monto corregido, the system SHALL pasar ese MISMO valor
  atómico corregido a `verifyDefaultChainSettle({ requiredAmountAtomic })` (`:426-430`) — sin una
  segunda derivación independiente — para que la re-verificación on-chain converja con lo realmente
  firmado/settleado.
- AC-5: WHERE `ESCROW_SETTLE_ENABLED=true` y el two-hop (`settleEscrowAware`, WKH-191b) invoca el hop 2
  vía `settlePaymentIntentOnChain` SIN cambios de código, the system SHALL heredar el fix
  transparentemente (cero líneas nuevas en `settleEscrowAware`), de modo que el atómico del hop 2
  converja con el `debit_amount_atomic` del hop 1 (WKH-191a, YA decimals-aware hoy) en la misma
  chain/token.
- AC-6: the system SHALL tener tests de convergencia por chain: Kite (18d, atómico byte-idéntico al
  `usdToWei` pre-fix para ≥3 valores representativos, incl. uno con más de 2 decimales de precisión) y
  Base (6d, atómico USDC correcto — p.ej. `finalAmountUsd=1.50` ⇒ `"1500000"`).

## Scope IN

- `src/services/payment-intent.ts` — generalizar `usdToWei(usd: number): string` (`:153-157`) a una
  función decimals-parametrizada; ÚNICO call-site a actualizar: `settlePaymentIntentOnChain` (`:364`).
- `src/services/payment-intent.test.ts` — tests de convergencia Kite (18d, byte-idéntico) + Base (6d,
  atómico USDC correcto) + regresión de `verifyDefaultChainSettle` recibiendo el atómico corregido.
- Comentario/JSDoc actualizado del helper (hoy dice "USD → wei (18 decimals)... el token del default
  chain (kite/PYUSD) es 18 decimals" — desactualizar ese supuesto).

## Scope OUT

- Activar `ESCROW_SETTLE_ENABLED` / cambiar `default-chain` a Base en ningún entorno — eso es WKH-191d.
- `src/adapters/kite-ozone/payment.ts` y `src/adapters/base/payment.ts` (`sign()`/`settle()`) — quedan
  SIN cambios: son decimals-agnósticos por diseño (toman `value`/`authorization.value` VERBATIM, ya
  confirmado en grounding — `base/payment.ts:464`, `kite-ozone/payment.ts:408`), el bug NUNCA estuvo ahí.
- `src/adapters/escrow/debit-capture.ts` / `debit-executor.ts` (WKH-191a/191b, hop 1) — YA son
  decimals-aware HOY (`debit-capture.ts:162 "NUNCA literal 18 / NUNCA usdToWei"`, deriva de
  `token.decimals` vía `parseUnits`); cero cambios necesarios.
- `src/services/fee-charge.ts` (`feeUsdcToWei`, `:164-166`) — mismo patrón hardcodeado 18d, pero es un
  seam DISTINTO (protocol-fee-wallet transfer, tabla `a2a_protocol_fees`), no el seam WKH-136 auditado
  de este ticket. Riesgo relacionado (si algún día el default-chain del fee protocolario cambia a Base,
  tendría el MISMO bug) — se documenta como candidato a follow-up, explícitamente NO tocado acá.
- `src/services/compose.ts` — su cálculo inline de wei (referenciado en comentarios de `fee-charge.ts`
  como "compose.ts:188-190") es el mismo patrón de protocol-fee, mismo razonamiento de exclusión.
- `src/adapters/settle-verifier.ts` — cero cambios de código; ya deriva `token.address` correctamente
  de `bundle.payment.supportedTokens[0]` (`:369`) y solo compara contra el `requiredAmountAtomic` que
  el caller le pasa (que este fix corrige en origen).
- `contracts/` (Solidity) — cero cambios on-chain.
- `src/services/arbiter.ts` — Wave 1, sigue bloqueada, sin relación.
- Migraciones de base de datos — esta HU no toca schema.

## Decisiones técnicas (DT-N)

- DT-1 (corte del fix): el fix vive EXCLUSIVAMENTE en `payment-intent.ts`, NO en los adapters. Grounding
  confirmó que `sign()` de `base/payment.ts` (`:464`) y `kite-ozone/payment.ts` (`:408`) hacen
  `value: opts.value` verbatim — nunca calculan decimales, son agnósticos por diseño. El ÚNICO lugar del
  path de settle que convierte USD→atómico es `usdToWei` (payment-intent.ts), con un ÚNICO call-site
  (`:364`, dentro de `settlePaymentIntentOnChain`). Tocar los adapters sería más invasivo (2 archivos) y
  NO resolvería el bug (nunca ven USD, solo el atómico que ya les llega mal calculado).
- DT-2 (aritmética): generalizar `usdToWei(usd)` → `usdToAtomic(usd, decimals)` usando escalado BigInt
  entero puro — `micro * 10^(decimals-6)` cuando `decimals >= 6` (fallback defensivo
  `micro / 10^(6-decimals)` si algún día hay un token <6d, caso hoy inexistente). RECHAZADO: usar
  `parseUnits(usd.toFixed(decimals), decimals)` (el idiom que sí usan `base/payment.ts:quote()` y
  `debit-capture.ts` para montos firmados por el cliente) — motivo: introduce un round-trip por
  `Number.toFixed`/parseo de string que, aunque en la práctica converge, NO es byte-idéntico *por
  construcción* al `usdToWei` legacy (`BigInt(Math.round(usd*1e6)) * BigInt(1e12)`). La fórmula BigInt
  pura SÍ es byte-idéntica cuando `decimals===18` (mismo exponente `12`, mismo cálculo), preservando
  AC-2 sin depender de un test que compare floats — es correcta por construcción, no solo por muestreo.
  Mantiene además la filosofía "sin pasar por float64" que el propio archivo ya documenta (CD-6 del
  header, `decimalStringToMicroUsd`).
- DT-3 (fuente de decimales): `getPaymentAdapter().supportedTokens[0]?.decimals ?? 18`, reusando la
  MISMA instancia de `PaymentAdapter` que YA se resuelve para `sign()` dentro de la función (no una
  segunda llamada a `getDefaultChainKey()`/`getAdaptersBundle()` como hace `debit-capture.ts` — acá no
  hace falta, `getPaymentAdapter()` sin argumento ya devuelve el adapter de la default chain con
  `.supportedTokens[0].decimals` expuesto). Evita una fuente de drift entre "qué chain firmó" y "qué
  decimals se usaron para calcular el monto firmado" — son la MISMA resolución.
- DT-4 (convergencia end-to-end, sin tocar código adicional): `verifyDefaultChainSettle` (`:426-430`)
  ya deriva el token/decimals correctos de forma independiente (`settle-verifier.ts:369`,
  `bundle.payment.supportedTokens[0]`) — solo compara el `requiredAmountAtomic` que el caller le pasa.
  Al corregir `wei` en origen, la comparación converge automáticamente; CERO cambios en
  `settle-verifier.ts`. Cadena de convergencia completa tras el fix: hop 1 `debit_amount_atomic` (6d
  Base, WKH-191a) == hop 2 atómico firmado (6d Base, este fix) == transfer real on-chain (USDC 6d) ==
  re-verificación (`settle-verifier.ts`, 6d derivado independientemente). Los 4 puntos convergen en la
  MISMA unidad por primera vez.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO modificar `sign()`/`settle()` de CUALQUIER adapter (`kite-ozone/payment.ts`,
  `base/payment.ts`, `avalanche/payment.ts`) — son decimals-agnósticos por diseño (DT-1); el fix es
  ÚNICO Y EXCLUSIVO choke-point dentro de `payment-intent.ts`.
- CD-2: OBLIGATORIO test de convergencia Kite byte-idéntica: para ≥3 valores representativos de
  `finalAmountUsd` (incluyendo al menos uno con precisión de 6 decimales, p.ej. `0.333333`), el atómico
  producido por la función NUEVA debe ser EXACTAMENTE igual (string-a-string) al que producía
  `usdToWei` HOY. Un solo dígito de diferencia = regresión del path operator-custodial en producción.
- CD-3: PROHIBIDO tocar `contracts/` (Solidity), `src/services/arbiter.ts`,
  `src/adapters/escrow/debit-capture.ts`, `src/adapters/escrow/debit-executor.ts` (191a/191b — YA
  decimals-aware, confirmado en grounding), `src/services/fee-charge.ts` (`feeUsdcToWei`, seam
  DISTINTO), `src/services/compose.ts` y `src/adapters/settle-verifier.ts` — todos Scope OUT explícito.
- CD-4: OBLIGATORIO usar aritmética BigInt entera (patrón `micro-USD × 10^(decimals-6)`), SIN
  `parseUnits`/`Number.toFixed` de por medio (DT-2) — preserva la filosofía "sin float64" ya
  establecida en el header del archivo y garantiza AC-2 por construcción.
- CD-5: PROHIBIDO cambiar la firma pública (params/return type) de `settlePaymentIntentOnChain` — es un
  seam auditado (WKH-136) con 3+ call-sites (`closeSession`, `settleUpto` vía `settleEscrowAware`,
  y el propio `settleEscrowAware` como fallback directo); cualquier cambio de firma exige re-auditar
  todos los call-sites, fuera del alcance de esta HU.
- CD-6: OBLIGATORIO derivar los decimals de la MISMA instancia de `getPaymentAdapter()` ya resuelta
  para `sign()`/`settle()` dentro de la función — PROHIBIDO agregar una segunda resolución de
  registry/bundle que pueda divergir de la chain efectivamente usada para firmar (DT-3).
- CD-7: OBLIGATORIO que el fallback (AC-3, sin token resuelto) NUNCA lance — cualquier código nuevo
  queda dentro del `try/catch` existente de `settlePaymentIntentOnChain` (`:363-470`), que ya garantiza
  CD-7 del seam original (jamás rechazar la promise).

## Missing Inputs

- [resuelto en F0] Corte del fix (adapter vs. seam) — resuelto por grounding: el fix es 100% en
  `payment-intent.ts`, adapters intactos (DT-1).
- [resuelto en F0] Aritmética (`parseUnits` vs BigInt puro) — resuelto: BigInt puro por convergencia
  garantizada-por-construcción en Kite (DT-2).
- [no bloqueante] No se pudo leer el ticket Jira WKH-192 directamente (esta instancia del agente no
  tiene la tool de Jira disponible) — el grounding de código + la descripción verbal detallada del
  orquestador (que cita archivo:línea del R-1/MI-1 de WKH-191b) fue suficiente para derivar ACs/DTs/CDs
  sin ambigüedad. Si el ticket Jira tiene texto adicional no capturado acá, el humano puede señalarlo
  en el gate `HU_APPROVED`.

## Análisis de paralelismo

- Esta HU es **pre-requisito de código** de WKH-191d (activación end-to-end del escrow no-custodial en
  Base) — WKH-191d NO puede completar su happy-path en Base sin este fix (aunque sea money-safe sin él,
  por diseño de WKH-191b).
- NO bloquea ni es bloqueada por WKH-191c (motor de reconciliación, ya DONE/PENDING-DEPLOY) — 191c opera
  sobre el ESTADO `reconciliation_pending` que hoy existe justamente PORQUE el seam no es
  decimals-aware; tras este fix, en Base, el happy-path debería completar SIN generar
  `reconciliation_pending` por este motivo (aunque el motor de 191c sigue siendo necesario para otras
  causas de ambigüedad — RPC timeouts, etc.).
- Puede ir en paralelo con cualquier HU que NO toque `payment-intent.ts` (p.ej. WKH-159/160/161/162, que
  tocan `orchestrate.ts`, sin overlap de archivos).
- Todas las migraciones PENDING-DEPLOY de 191a/191b/191c (Railway/Supabase) siguen pendientes — esta HU
  NO agrega ninguna migración nueva, así que no cambia ese bloqueante operacional existente.
