# Audit C — Economic / DoS / USDC-specific attacks — WasiAIEscrow.sol

**HU:** WKH-126a (non-custodial prepaid USDC escrow per Agent Key)
**Contract:** `contracts/src/WasiAIEscrow.sol` (UUPS, OZ v5, solc 0.8.24)
**Arista:** C — ataques económicos, DoS, y específicos de USDC/ERC-20
**Fecha:** 2026-06-22
**Modo:** money-custody adversarial. NO se modificó código. PoCs en scratch ya borrados.
**Baseline:** `forge test` 25/25 PASS antes y después de la auditoría.

---

## Resumen ejecutivo (conteo por severidad)

| Severidad | # | IDs |
|-----------|---|-----|
| BLOQUEANTE-ALTO | 0 | — |
| BLOQUEANTE-MEDIO | 1 | BLQ-MED-1 (batch sin MAX_BATCH → settlement no-minable) |
| BLOQUEANTE-BAJO | 0 | — |
| MENOR | 4 | MNR-1 (USDC pause/blocklist), MNR-2 (sin rescue → donación atrapada), MNR-3 (deposit no mide delta real), MNR-4 (griefing optimista a escala) |
| OK / N/A | — | Vectores 1, 3, 5b, 7 confirmados SEGUROS |

**Veredicto:** **APROBADO con MENORs + 1 BLOQUEANTE-MEDIO.** El gate se bloquea por BLQ-MED-1 (cualquier bloqueante bloquea). El núcleo de custodia es sólido: CEI correcto, low-s enforced, nonce irrevocable, debit por-elemento antes del transfer, sin reentrancy explotable, sin underflow/overflow. Los MENORs son riesgos aceptados/documentados de testnet-beta — pero deben quedar registrados explícitamente, no silenciados.

**Veredicto sobre keyId squatting:** **NO explotable** (vector cerrado por entropía). Ver Vector 1.
**Veredicto sobre USDC pause/blocklist:** **riesgo real pero externo y aceptado** (MNR-1). Circle puede congelar fondos; el contrato no tiene mitigación y no puede tenerla razonablemente. Documentar como riesgo conocido.

---

## VECTOR 1 — keyId squatting / DoS de onboarding — **OK (no explotable)**

**Categoría:** Data Integrity / DoS
**Evidencia:** `WasiAIEscrow.sol:69-73` (depositor-lock DT-10) + `src/adapters/escrow/eip712.ts:20`, `eip712.test.ts:27` + `supabase/migrations/20260406000000_a2a_agent_keys.sql:9`

**Análisis del vector:** El mecanismo `_depositor[keyId]` se fija al primer `deposit` (inmutable, DT-10/CD-8). Si un atacante puede front-runear `deposit(keyId, 1)` ANTES del agente legítimo, queda como dueño del escrow de ese keyId → el agente legítimo recibe `DepositorMismatch` (DoS permanente sobre su propio keyId). El ataque depende **enteramente de la predictibilidad de keyId**.

**Derivación verificada de keyId:**
- `keyId = keccak256(stringToBytes(uuid))` donde `uuid` = `a2a_agent_keys.id` (`eip712.ts:20`, confirmado en `eip712.test.ts:27`).
- El UUID se genera con `gen_random_uuid()` en Postgres (`a2a_agent_keys.sql:9`) → **UUIDv4, 122 bits de entropía criptográfica**.

**Por qué NO es explotable:**
1. Para squatear, el atacante necesita conocer el UUID **antes** de que el agente deposite. El UUID se devuelve **solo al owner** en la respuesta de `POST /auth/agent-signup` (`auth.test.ts:177-191`); no se expone en `/discover` ni en eventos públicos previos al primer deposit.
2. Aun si el atacante intentara fuerza bruta sobre el espacio de keyId, son 2^122 valores. Inviable.
3. El `keyId` SÍ se vuelve público on-chain **después** del primer deposit (es `indexed` en `Deposited`, `IWasiAIEscrow.sol:9`), pero para ese momento el depositor-lock ya está fijado al agente legítimo → front-run imposible (la carrera ya terminó).

**Ganancia del atacante más allá del DoS:** ninguna. Aunque squateara, el `debit` valida `recovered == _depositor[keyId]` (`:97`), así que el atacante NO puede firmar débitos en nombre del agente (no tiene la key del agente). El agente legítimo simplemente nunca depositaría a un keyId que ya tiene dueño ajeno (la app lee `escrowBalance`/`Deposited` antes). No hay robo ni confusión de fondos del agente.

**Conclusión:** vector cerrado por la entropía del UUID. La defensa NO está en el contrato (que sigue siendo squatteable si el UUID se filtrara) sino en que el UUID es secreto + de alta entropía. **Recomendación defensiva (MENOR, no finding):** documentar en el SDD que la seguridad anti-squat de keyId **depende de que el `a2a_agent_keys.id` nunca se exponga públicamente antes del primer deposit**. Si una futura HU expusiera el UUID en un endpoint público (p.ej. un `/agents/:id` que devuelva el key_id), este vector se reabriría como BLOQUEANTE. Hoy: **OK**.

---

## VECTOR 2 — DoS por batch grande (sin MAX_BATCH) — **BLOQUEANTE-MEDIO (BLQ-MED-1)**

**Categoría:** Performance / DoS
**Archivo:línea:** `WasiAIEscrow.sol:114-130` (`debitBatch`, loop sin cota superior)

**Descripción:** `debitBatch` itera `keyIds.length` sin ningún límite máximo. Cada elemento cuesta ~34.5k gas (medido). El operador construye el batch; si agrega suficientes elementos, la tx excede el block gas limit y **nunca se mina** → el settlement de ese lote queda permanentemente atascado y debe re-trocearse manualmente.

**Reproducción (PoC ejecutado, scratch borrado):**
```
n=50    → 1,723,221 gas
n=200   → 6,813,620 gas
n=500   → 17,409,060 gas
n=1000  → 36,268,900 gas   (excede 30M block gas limit → tx no-minable)
```
Pendiente lineal ≈ 34,500 gas/elemento + overhead.
- Block gas limit 30M (Ethereum-like) → tope práctico ≈ **850 elementos**.
- Block gas limit ~15M (Base / Avalanche C-Chain históricos) → tope ≈ **430 elementos**.

**Impacto:**
- **Quién lo paga:** el **operador** (es `msg.sender` de `debitBatch`, DT-2). Es self-inflicted, no griefing de terceros: nadie externo puede inflar el batch del operador.
- **Severidad MEDIA (no ALTA):** no hay pérdida de fondos ni griefing por un atacante. El daño es operativo: un batch sobredimensionado revierte por out-of-gas y el operador debe partirlo. Pero: (1) en un settlement automatizado de alto volumen es un edge real (cientos de keyIds acumulados), (2) si el operador no detecta el tope y reintenta el mismo batch, **el servicio de liquidación se detiene** hasta intervención manual — un AC implícito de "el operador puede liquidar" se rompe en el caso de carga alta.
- No es ALTO porque es recuperable (trocear el batch) y no expone fondos.

**Sugerencia (no implementar aquí):** agregar `MAX_BATCH` (p.ej. 256) con `revert BatchTooLarge()` al inicio de `debitBatch`, de modo que el fallo sea **explícito y barato** (revert temprano, error claro) en lugar de un out-of-gas costoso y silencioso. Alternativamente, documentar en runbook del operador el tope seguro por chainId y forzar el troceo en la capa 126b. La elección (guard on-chain vs guard off-chain) la decide el Dev/architect; el punto bloqueante es que **hoy no hay ninguna cota ni guía**, y el modo de fallo (out-of-gas tardío) es el peor.

---

## VECTOR 3 — keyId duplicado en un mismo batch (lectura de balance stale) — **OK**

**Categoría:** Data Integrity
**Archivo:línea:** `WasiAIEscrow.sol:99-102` (`_verifyAndConsume`: check `amount > _balances` → luego `_balances -= amount`) + `:123-127` (loop llama `_verifyAndConsume` por elemento antes de seguir)

**Análisis:** Vector de "balance stale": si el batch incluye el mismo `keyId` dos veces (nonce 1 y nonce 2), ¿el segundo elemento ve el débito del primero o lee un balance viejo?

**Reproducción (PoC ejecutado, scratch borrado):**
- Test A — `balance=100e6`, debits `40e6` (n=1) + `50e6` (n=2) mismo keyId:
  resultado: `escrowBalance = 10e6`, operador recibe `90e6`. **Ambos débitos correctos, NO double-spend.** ✅
- Test B — `balance=100e6`, debits `70e6` (n=1) + `50e6` (n=2) = 120 > 100:
  el segundo `_verifyAndConsume` ve `_balances = 30e6` (ya descontado el primero) → `30 < 50` → `revert InsufficientBalance` → batch entero revierte atómicamente. ✅

**Por qué es correcto:** el patrón CEI es por-elemento. `_verifyAndConsume` aplica el Effect (`_balances[keyId] -= amount`, `:102`) **dentro** de cada iteración, ANTES de procesar el siguiente. La aggregated `safeTransfer` ocurre fuera del loop (`:129`) pero los balances ya están todos descontados. No hay ventana de lectura stale. El nonce distinto (`_usedNonces[keyId][nonce]`, `:92`,`:101`) impide replay del mismo nonce. **Sin findings.**

---

## VECTOR 4 — Withdraw griefing (modelo optimista DT-11) — **MENOR (MNR-4)** — confirmado

**Categoría:** Data Integrity / Economic
**Archivo:línea:** `WasiAIEscrow.sol:133-139` (`withdraw` sin lock) + `:40` (`_lockedAmount` nunca se escribe — verificado: 0 grep-hits de asignación) + `:99` (`debit` revierte por `InsufficientBalance`)

**Confirmación del ataque (PoC ejecutado, scratch borrado):**
1. Agente deposita `100e6` a keyId `k`.
2. Agente firma `DebitAuthorization(k, 100e6, ...)` (servicio consumido off-chain).
3. Agente **front-runea** el `debitBatch` del operador con `withdraw(k, 100e6)`.
4. El `debit` del operador revierte con `InsufficientBalance` (`:99`).
   Resultado medido: operador cobra `0`, agente recupera `100e6`. **El vendor no cobra el servicio ya prestado.**

**¿Robo o impago?** Es **impago, no robo** — confirmado y consistente con DT-11. CD-2 intacto: el operador nunca tuvo más que la firma; nunca custodió fondos del agente. El agente solo retiró **su propio** balance. No hay extracción de fondos ajenos.

**¿Automatizable a escala?** **Sí.** Un agente malicioso puede operar un bot que: (1) consume servicios off-chain, (2) monitorea el mempool por el `debitBatch` del operador, (3) front-runea con `withdraw` cada vez. A escala, esto convierte el escrow en "consumir gratis" sistemáticamente. La única defensa hoy es operativa (settlement frecuente reduce la ventana; reputación/suspensión).

**Cuantificación del riesgo:** acotado por el balance que el agente tiene depositado en cada momento y por la frecuencia de settlement. En el peor caso, el agente puede griefear hasta el monto consumido entre dos settlements. NO es ilimitado, NO compromete fondos de otros agentes.

**Por qué MENOR y no BLOQUEANTE:** este riesgo está **explícitamente documentado y aceptado** en `sdd.md` DT-11 (§10, líneas 396-417) y escalado al humano como decisión de roadmap mainnet, con el slot `_lockedAmount` ya reservado en storage (`:40`) listo para activar el lock explícito (opción b) sin romper el layout. Por la regla de calibración #5 (respetar decisiones documentadas DT-N), **NO se eleva a bloqueante**. Se registra como MNR-4 para visibilidad: **antes del cutover a mainnet con volumen real, activar el lock explícito es obligatorio** — el modelo optimista es aceptable solo para testnet/beta.

---

## VECTOR 5 — USDC-específico

### 5a) USDC pausable + blocklist (Circle) — **MENOR (MNR-1)**

**Categoría:** Integration / Economic (riesgo externo)
**Archivo:línea:** `WasiAIEscrow.sol:77,110,129,138` (todos los movimientos de fondos via `_usdc.safeTransfer*`)

**Reproducción (PoC con mock PausableBlocklistUSDC, ejecutado, scratch borrado):**
- (1) `usdc.setPaused(true)` → `withdraw(k, 500e6)` revierte con `"paused"`. Fondos congelados.
- (2) `usdc.block_(escrow)` → `withdraw` revierte con `"blocklisted"`. Todos los movimientos del contrato bloqueados.
- En ambos casos `escrowBalance(k)` sigue mostrando `500e6` (contabilidad interna intacta) pero **nadie puede mover los USDC reales**.

**Impacto:** si Circle pausa USDC globalmente o blocklistea la dirección del escrow, **todos los fondos quedan atrapados** (deposit/debit/withdraw fallan). Esto es inherente a custodiar USDC y aplica a **cualquier** contrato que toque USDC. El contrato no puede mitigarlo (no puede forzar una transferencia que el token rechaza).

**Por qué MENOR y no BLOQUEANTE:** es un riesgo **externo, no un defecto del contrato**. No hay un fix razonable dentro de `WasiAIEscrow.sol`. La mitigación real es operativa/de gobernanza: (1) el contrato es UUPS-upgradeable, así que en un escenario de blocklist del contrato actual se podría desplegar lógica de migración via upgrade (mientras el upgrade no esté renunciado); (2) diversificar a múltiples stablecoins es OUT por DT-6/CD-5 (single token). **Recomendación:** documentar explícitamente en el SDD/runbook como **riesgo aceptado conocido** ("Circle puede congelar fondos; sin mitigación on-chain"). Hoy el SDD no lo menciona — por eso es un finding (gap de documentación de riesgo de custodia), aunque de severidad MENOR.

### 5b) USDC 6 decimales — **OK**

**Archivo:línea:** todo el contrato. Verificado por grep: cero operaciones de decimales (`1e18`, `* 1e`, `/ 1e`, `decimals()`).

El contrato opera exclusivamente sobre **raw token units** (`uint256`). No asume 18 decimales en ningún lado. `_balances[keyId]` guarda unidades crudas; `deposit`/`debit`/`withdraw` suman/restan unidades crudas; el `safeTransfer` mueve unidades crudas. USDC de 6 decimales funciona idéntico. **Sin findings.**

### 5c) deposit acredita `amount` declarado, no el delta real — **MENOR (MNR-3)**

**Categoría:** Type Safety / Integration
**Archivo:línea:** `WasiAIEscrow.sol:75-77`
```solidity
_balances[keyId] += amount;                              // acredita el amount declarado
_usdc.safeTransferFrom(msg.sender, address(this), amount); // no mide balanceOf antes/después
```

**Análisis:** el contrato acredita `amount` al balance interno asumiendo que `safeTransferFrom` mueve exactamente `amount`. Esto es correcto para USDC **hoy** (no es fee-on-transfer, no es rebasing). PERO si Circle introdujera fee-on-transfer (improbable pero posible vía upgrade de USDC), el contrato acreditaría más de lo que realmente recibió → insolvencia (`balanceOf(this) < sum(_balances)`), y los últimos en retirar no podrían.

**Por qué MENOR:** USDC no es fee-on-transfer y no hay señal de que lo vaya a ser; es un riesgo hipotético de cambio del token. El patrón robusto (medir `balanceOf` antes/después y acreditar el delta real) es la práctica defensiva estándar para tokens arbitrarios, pero aquí el token está fijado a un único USDC conocido (DT-6/CD-5), lo que reduce el riesgo. Se registra como deuda técnica defensiva, no bloqueante. **Sugerencia:** si se quiere blindar contra un futuro cambio de USDC, medir el delta real recibido en `deposit`. No urgente para testnet/beta con el USDC actual.

---

## VECTOR 6 — Donación / forced balance — **MENOR (MNR-2)**

**Categoría:** Data Integrity
**Archivo:línea:** `WasiAIEscrow.sol` (no existe función de rescate/sweep — verificado por grep: 0 hits de `rescue|sweep|recover|skim`)

**Reproducción (PoC ejecutado, scratch borrado):**
- Agente deposita `100e6` (vía `deposit`).
- Atacante hace `usdc.transfer(escrow, 1000e6)` directo (sin `deposit`).
- Resultado: `usdc.balanceOf(escrow) = 1100e6` pero `escrowBalance(k) = 100e6`. El `sum(_balances) = 100e6 < balanceOf = 1100e6`.

**Impacto:**
1. **NO rompe ninguna invariante de seguridad.** El contrato nunca asume `balanceOf(this) == sum(_balances)` en su lógica: `withdraw`/`debit` se gobiernan exclusivamente por `_balances[keyId]` interno, no por `balanceOf`. La donación no permite a nadie retirar más de su `_balances`. No hay sub-flujo explotable (no es el clásico ataque de inflación de vaults ERC4626 — aquí no hay shares ni ratio).
2. **El daño real:** los `1000e6` donados quedan **permanentemente atrapados**. No hay función de rescate (`onlyOwner sweep` del excedente `balanceOf - accountedTotal`). Si alguien transfiere USDC por error directo al escrow, se pierde.
3. La invariante `solvencia` del test (`balanceOf >= sum(_balances)`, `WasiAIEscrow.invariant.t.sol`) **se mantiene en la dirección segura** (siempre hay >= fondos que deudas internas). La donación solo agranda el excedente, nunca lo vuelve negativo. Bien.

**Por qué MENOR:** no es vulnerabilidad de robo ni de contabilidad explotable; es funds-lost-on-user-error sin recuperación. **Sugerencia:** considerar una `sweepExcess(address to)` `onlyOwner` que solo permita retirar `balanceOf(this) - totalAccounted` (requeriría trackear un `totalAccounted` global, hoy no existe). Para testnet/beta es aceptable omitirlo. Registrar como deuda técnica.

---

## VECTOR 7 — Underflow / overflow — **OK**

**Categoría:** Type Safety
**Archivo:línea:** `WasiAIEscrow.sol:75` (`_balances += amount`), `:102` (`_balances -= amount`), `:125` (`total += amounts[i]`), `:135-137` (`withdraw`)

**Análisis:**
- Solidity 0.8.24 → todas las operaciones aritméticas tienen checks automáticos (revierten en overflow/underflow, no wrap). No hay bloques `unchecked`.
- `total += amounts[i]` (`:125`): overflowearía solo si la suma de amounts supera `2^256`. Inalcanzable con USDC (supply total ~10^16 unidades). Aunque overfloweara, **revierte** (no wrap) → peor caso es un revert del batch, no robo. No es DoS explotable por terceros (el operador arma el batch).
- `withdraw` (`:135-137`): `_balances[keyId] - _lockedAmount[keyId]` con `_lockedAmount=0` → nunca underflow; el guard `amount > available` (`:136`) precede al `_balances -= amount` (`:137`), así que el resta nunca underflowea.
- `amount = type(uint256).max` en `deposit`: el `safeTransferFrom` revertiría por allowance/balance insuficiente mucho antes; aunque pasara el `+=`, no hay vector (el atacante necesitaría tener 2^256 USDC).
- `debit` con `amount > _balances` (`:99`): guard explícito `InsufficientBalance` antes del `-=`. No underflow.

**Sin findings.** La aritmética está protegida por 0.8.x y por guards explícitos colocados antes de cada resta.

---

## Hallazgos adicionales de la revisión (no en los 7 vectores pedidos)

### OK — Reentrancy
`deposit`/`debit`/`debitBatch`/`withdraw` son todos `nonReentrant` (`:66,107,120` y `withdraw` `:133` — confirmar: `withdraw` tiene `nonReentrant`). **Verificación:** `withdraw` línea 133 — SÍ tiene `nonReentrant`. Además el patrón CEI es estricto (Effects antes de Interactions en todos). USDC no tiene callbacks (no es ERC777), pero la defensa está igual. **OK.**

### OK — Signature malleability
`ECDSA.recover` de OZ v5 (`:96`) rechaza low-s alto (`ECDSAInvalidSignatureS`, verificado en `lib/.../ECDSA.sol:33`). No se puede forjar una segunda firma válida del mismo mensaje. Irrelevante igual porque el replay se bloquea por nonce, pero defensa correcta. **OK.**

---

## Veredicto final

**RECHAZADO (1 BLOQUEANTE activo).**

El gate se bloquea por **BLQ-MED-1** (regla binaria: cualquier bloqueante bloquea). Orden de fix-pack para el Dev:

1. **BLQ-MED-1** (Vector 2): agregar `MAX_BATCH` con revert temprano explícito **o** documentar tope por chainId + forzar troceo en 126b. El modo de fallo actual (out-of-gas tardío y costoso en batches grandes) debe volverse explícito y barato.

MENORs (no bloquean DONE; decidir si entran ahora o backlog):
- MNR-1 (Vector 5a): documentar riesgo de pause/blocklist de Circle como riesgo aceptado en SDD/runbook.
- MNR-4 (Vector 4): registrar que el lock explícito (opción b, `_lockedAmount`) es **obligatorio antes de mainnet con volumen**. Ya escalado en DT-11.
- MNR-3 (Vector 5c): deposit no mide delta real (defensa futura contra cambio de USDC).
- MNR-2 (Vector 6): sin `sweepExcess` → donaciones por error quedan atrapadas.

**Lo que está sólido (NO tocar):** keyId squatting cerrado por entropía (V1), CEI por-elemento correcto con dup keyId (V3), aritmética protegida (V7), 6-decimales correcto (V5b), reentrancy y malleability cubiertos. El núcleo de custodia de dinero es robusto para testnet/beta.
