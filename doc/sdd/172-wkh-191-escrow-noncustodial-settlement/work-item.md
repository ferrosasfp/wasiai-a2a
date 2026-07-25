# Work Item (EPIC) — [WKH-191] Settlement genuinamente non-custodial vía WasiAIEscrow

## Resumen

Hoy el settlement de la plataforma es **de-facto operator-custodial off-chain**: el buyer
se debita en `a2a_agent_keys.budget` (DB), y el pago real al seller lo hace el **operador**
firmando y liquidando su PROPIO EIP-3009 `transferWithAuthorization` (wallet `0xf432…`) vía
facilitator (`settlePaymentIntentOnChain`, `payment-intent.ts:343-459`; mismo patrón en
`fee-charge.ts` y en `arbiter.ts:546-552`). El contrato `WasiAIEscrow` (UUPS, auditado,
deployado en Base Sepolia) es código muerto en el pago: solo se usa para **verificar
depósitos** (`escrow-verifier.ts`) cuando `escrowEnabledForChain` (WKH-126c) rutea a él en
vez del treasury EOA. `WasiAIEscrow.debit()`/`withdraw()` y
`src/adapters/escrow/eip712.ts` (`DebitAuthorization`, WKH-126b, marcado PROVISIONAL /
VERIFY-AT-IMPL en todo el archivo) **no tienen call-sites en `src/`** — confirmado por
lectura directa de `settlePaymentIntentOnChain`, `arbiter.ts:executeArbitration` y
`kite-ozone/payment.ts:sign/settle`, ninguno importa `escrow/abi.ts` ni `escrow/eip712.ts`.

El founder decidió resolverlo de raíz: volver el settlement genuinamente non-custodial,
cableando el flujo de cobro real (no solo el de depósito) a través del contrato.

Este documento es la **decomposición del epic en HUs ejecutables**, no una HU única.

## Hallazgos de grounding (F0) que condicionan la decomposición

1. **`WasiAIEscrow.debit()` paga SIEMPRE al `msg.sender` (el operador), no a un `payTo`
   arbitrario** (`WasiAIEscrow.sol:154` `_usdc.safeTransfer(msg.sender, amount); // to
   operator (DT-2)`). Esto significa que "activar" `debit()` tal como existe HOY **no**
   resuelve el pago al seller — solo mueve fondos del escrow al operador con autorización
   criptográfica del buyer. Pagar al seller sigue requiriendo un segundo salto (el operador
   reenvía con su propio wallet, igual que hoy) **o** una función de contrato nueva que
   pague a un `to` incluido en el mensaje firmado por el buyer.
2. **El contrato no tiene ningún concepto de árbitro ni de disputa on-chain hoy.** Las
   únicas funciones de movimiento de fondos son `deposit` (cualquiera, lock a
   `_depositor[keyId]`), `debit` (solo `_operator`, requiere firma EIP-712 del
   `_depositor`) y `withdraw` (solo el propio `_depositor`). No existe `_arbiter`, no existe
   `resolveDispute`, no existe ningún camino para mover fondos de un `keyId` SIN la firma de
   su depositante. El árbitro autónomo (WKH-139 v2, fila 145 de `_INDEX.md`) hoy opera 100%
   sobre `budget` off-chain vía `close_payment_intent_for_arbitration` — nunca toca el
   contrato. **Dar al árbitro poder real sobre fondos escrow-custodiados requiere una
   función de contrato nueva** (upgrade UUPS), no una activación.
3. **Consecuencia directa de (1)+(2):** migrar el **flujo normal** (session/upto) a
   debit-firmado es alcanzable con **cero cambios de Solidity** (dos saltos: buyer→operador
   vía `debit()` existente, operador→seller vía el `sign`/`settle` que YA existe hoy en
   `kite-ozone/payment.ts:399-471`/`:333-380`). Migrar el **árbitro** requiere upgrade del
   contrato + una decisión de founder previa sobre autoridad/consentimiento (decisiones (a)
   y (b) abajo) — es estructuralmente más difícil y no puede empezar por código.
4. El contrato solo está deployado en **Base Sepolia** (`contracts/script/Deploy.s.sol` fija
   `USDC_BASE_SEPOLIA`); no hay script de deploy para Kite ni Avalanche. `escrow-verifier.ts`
   lee `A2A_ESCROW_CONTRACT_<FAMILY>` por chain-family, pero no hay evidencia en este
   grounding de que esté configurado en ningún ambiente vivo (verificar env reales en F2).
5. Las invariantes Foundry ya prueban `operatorCannotDrainWithoutSig` /
   `hostilePathAlwaysReverts` (`WasiAIEscrow.invariant.t.sol` — bot no-operador,
   `ghost_hostileAttempts == ghost_hostileReverts`) y una segunda suite multi-tenant
   (`WasiAIEscrow.invariant2.t.sol` — múltiples depositantes, replay, rotación de
   operador). Cualquier función nueva DEBE extender, no reemplazar, ambas suites.

## Sizing

- SDD_MODE: full (epic — cada HU hija tendrá su propio F2 SDD en `doc/sdd/NNN-wkh-191x-*/`)
- Estimación epic: XL (6-8 HUs, 2 waves, 1 upgrade de contrato con timelock 2 días)
- Branch: no aplica a nivel epic — branch por HU, ver tabla de decomposición

## Decomposición en HUs

| ID sugerido | Título | Tamaño | Branch sugerido | Contrato tocado |
|---|---|---|---|---|
| WKH-191a | Captura de firma `DebitAuthorization` en el flujo normal (session/upto) | M | `feat/191a-debit-authorization-capture` | No |
| WKH-191b | Rewire settle escrow-aware del flujo normal (dos saltos: `debit()`→operador→forward a seller) | L | `feat/191b-escrow-settle-rewire` | No |
| WKH-191c | Libro autoritativo + reconciliación (escrow on-chain vs `budget` off-chain) + refund real (`withdraw()`) | L | `feat/191c-escrow-ledger-reconciliation` | No |
| WKH-191d | Config/deploy del escrow existente en el/los chain(s) en scope (env `A2A_ESCROW_CONTRACT_*`, verificación operador) + smoke testnet | S | `feat/191d-escrow-config-deploy` | No (config only) |
| WKH-191e | E2E testnet flag-gated — regresión completa del path live + del path nuevo | M | `feat/191e-escrow-e2e-flag-gated` | No |
| WKH-191f | Contrato: nueva función/rol arbiter (`resolveDispute`/`arbiterDebit`) + invariantes nuevas + tests Foundry | L | `feat/191f-escrow-arbiter-contract` | **Sí — upgrade UUPS** |
| WKH-191g | Wire `arbiter.ts` (`executeArbitration`/`applyRecovery`) al camino on-chain nuevo, flag-gated | M | `feat/191g-arbiter-onchain-wire` | No |
| WKH-191h | Deploy/upgrade con timelock (2d) del rol arbiter + smoke E2E del path disputa | S | `feat/191h-arbiter-deploy-upgrade` | No (deploy/config) |

## Grafo de dependencias

```
Wave 0 (flujo normal — SIN founder-blocker para EMPEZAR, contrato sin cambios)
  191a (captura firma) ──▶ 191b (rewire settle) ──▶ 191c (libro autoritativo + reconciliación)
                                    │                          │
                                    ▼                          ▼
                                  191d (config/deploy) ──▶ 191e (E2E flag-gated)

Wave 1 (árbitro — BLOQUEADA hasta ratificar decisiones (a) y (b))
  191f (contrato: rol arbiter, upgrade UUPS) ──▶ 191g (wire arbiter.ts) ──▶ 191h (deploy/upgrade + E2E disputa)
  191g depende también de 191c (el árbitro opera sobre fondos que deben vivir en el
        libro autoritativo ya reconciliado — si 191c no está, el árbitro seguiría
        forzando settles sobre un budget off-chain potencialmente divergente del escrow)
```

## Fasing recomendado (rationale de riesgo)

El ticket original y el research previo sugieren empezar por el árbitro (el gap "más
visible" — decisión forzada sin firma del buyer). El grounding de esta HU invierte esa
recomendación:

- **El flujo normal (Wave 0) es la fix de mayor apalancamiento y MENOR riesgo**: cubre el
  100% del volumen de transacciones, no requiere tocar Solidity (usa `debit()` tal cual
  existe hoy, sin upgrade, sin timelock, sin re-auditoría), y cierra la brecha de custodia
  más grande en términos de $ movidos: HOY el operador mueve fondos propios sin ninguna
  autorización criptográfica del buyer para el importe exacto; con 191a-191c el buyer firma
  cada débito.
- **El árbitro (Wave 1) es estructuralmente el problema más difícil, no el más fácil**: por
  diseño, un árbitro que fuerza un settle/split/refund SIN la firma del buyer (ese es el
  punto de tener un árbitro) no puede ser "non-custodial" en el mismo sentido que el flujo
  normal — necesita un modelo de autoridad distinto (rol on-chain + reglas de consentimiento
  previo), que son exactamente las decisiones (a) y (b) que el founder debe resolver ANTES
  de que 191f pueda empezar a diseñarse. Empezar por acá sin esas decisiones garantiza
  bloqueo en F2.
- **Recomendación del Analyst**: ejecutar Wave 0 completa primero (191a→191e). Wave 1
  (191f→191h) puede diseñarse en paralelo a nivel de SDD/discovery, pero su F3
  (implementación de contrato) queda bloqueada hasta que el founder resuelva (a) y (b). Esto
  es además el input directo para la decisión (d) — la respuesta observada en el grounding
  es "sí, migrar primero el flujo normal", pero queda marcada `[NEEDS FOUNDER DECISION]`
  porque es una decisión de producto/riesgo, no solo técnica.

## Acceptance Criteria (EARS) — nivel epic

- AC-1: WHEN `ESCROW_DEBIT_ENABLED=false` (default), the system SHALL execute settlement
  byte-identically to the current operator-custodial path (`settlePaymentIntentOnChain`
  signing/settling from `OPERATOR_PRIVATE_KEY`), with zero behavior change.
- AC-2: WHEN an Agent Key's funds are escrow-tracked on a chain with
  `ESCROW_DEBIT_ENABLED=true` AND a valid persisted `DebitAuthorization` signature exists
  for the amount, the system SHALL call `WasiAIEscrow.debit()` before any funds move toward
  the seller, instead of unilaterally moving operator-owned funds.
- AC-3: IF the escrow `debit()` leg succeeds but the forward-to-seller leg fails or returns
  ambiguous, THEN the system SHALL mark the intent as reconciliation-pending and SHALL NOT
  assume the seller was paid nor silently refund the buyer (mirrors the existing
  unequivocal/ambiguous pattern in `settlePaymentIntentOnChain:398-458`).
- AC-4: WHILE the escrow ledger is designated authoritative for a given Agent Key (per
  decision (c)), the system SHALL reconcile `a2a_agent_keys.budget` against
  `WasiAIEscrow.escrowBalance(keyId)` and SHALL alert on drift beyond a configured
  tolerance.
- AC-5: IF the autonomous arbiter (WKH-139 v2) needs to force a settlement, split, or
  refund over escrow-tracked funds, THEN the system SHALL use an on-chain path explicitly
  authorized per the founder-ratified authority/consent model (decisions (a)/(b)) — NEVER
  moving escrow-held buyer funds through an unsigned, unauthorized contract call.
- AC-6: WHERE the escrow contract for a given chain is not configured
  (`A2A_ESCROW_CONTRACT_<FAMILY>` unset), the system SHALL fall back to the current
  operator-custodial path for that chain without error (mirrors WKH-126c per-chain
  routing, `escrowEnabledForChain`).
- AC-7 (no-break): WHEN `ESCROW_DEBIT_ENABLED=true` is deployed to testnet, the system
  SHALL continue processing all existing session/upto/compose/orchestrate flows without
  regression on chains where escrow is not configured for that Agent Key.
- AC-8 (no-break): the system SHALL NOT deploy or upgrade the escrow contract to mainnet,
  nor enable any new debit-to-seller or arbiter function against real funds, until an
  independent audit of the new/changed contract functions is completed.

## Scope IN

- `src/services/payment-intent.ts` (`settlePaymentIntentOnChain` seam, `closeSession`,
  `settleUpto`)
- `src/services/arbiter.ts` (`executeArbitration`, `applyRecovery`) — solo Wave 1
- `src/adapters/escrow/{eip712.ts,abi.ts}` (pasar de PROVISIONAL a definitivo, converger
  con el contrato)
- `src/adapters/escrow-verifier.ts` (extender si el modelo de reconciliación lo requiere)
- `src/adapters/registry.ts` (exponer capacidad de debit-escrow como parte del
  `PaymentAdapter`/bundle, si aplica)
- `contracts/src/WasiAIEscrow.sol` + `IWasiAIEscrow.sol` — SOLO Wave 1 (191f), vía
  `proposeUpgrade`/timelock, nunca deploy directo
- `contracts/test/WasiAIEscrow*.t.sol` (extender, no reemplazar)
- `contracts/script/Deploy.s.sol` / script de upgrade nuevo (191h)
- Chain(s) en scope: Base Sepolia (testnet, ya deployado). Kite/Avalanche quedan Scope OUT
  salvo que 191d confirme configuración existente en F2.

## Scope OUT

- Mainnet (ninguna chain) — testnet-only para todo el epic (CD-5)
- Deploy del escrow a Kite o Avalanche (fuera salvo hallazgo distinto en F2)
- Cambiar el modelo de custodia del marketplace más amplio (WKH-130, distinto primitivo)
- Reabrir el modelo de dispute-window humano (WKH-139 v1, ya superado/DEFERRED por WKH-139
  v2)
- Wallet embebida / EIP-7702 (WKH-138b, diferida, sin relación directa)
- Cualquier cambio al split bps (WKH-136/143) — el epic hereda el split existente, no lo
  modifica

## Decisiones técnicas (DT-N)

- DT-1: Wave 0 (flujo normal) usa `debit()` TAL COMO EXISTE (sin cambios de Solidity),
  vía patrón de dos saltos (buyer→operador on-chain con firma, operador→seller on-chain
  como hoy). Ver Hallazgo de grounding #1/#3.
- DT-2: Wave 1 (árbitro) requiere upgrade de contrato — no se puede "activar" código
  existente porque no existe función de árbitro hoy. Ver Hallazgo #2.
- DT-3: Toda función de contrato nueva se propone vía `proposeUpgrade` + `MIN_TIMELOCK`
  (2 días) + `_authorizeUpgrade`; nunca upgrade directo sin timelock (mismo patrón ya
  auditado del contrato actual).

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO flag-gated — todo el wiring nuevo detrás de una env var default-OFF
  (p.ej. `ESCROW_DEBIT_ENABLED`), en PARALELO al path operator-custodial actual, que
  permanece el default de producción durante todo el epic.
- CD-2: PROHIBIDO alterar el comportamiento del path live cuando el flag está OFF o el
  chain no tiene escrow configurado — debe ser byte-identical (mirror del patrón WKH-126c
  `escrowEnabledForChain`).
- CD-3: OBLIGATORIO preservar y extender (nunca reemplazar) los invariantes Foundry
  probados (`operatorCannotDrainWithoutSig`, `hostilePathAlwaysReverts`, conservación,
  solvencia, replay-resistance) — cualquier función nueva agrega sus propios
  invariantes, no elimina los existentes.
- CD-4: OBLIGATORIO exactly-once en cada leg on-chain (debit / forward / withdraw) —
  reusar el patrón unequivocal/ambiguous ya validado en `settlePaymentIntentOnChain` /
  `arbiter.ts`; nunca asumir éxito de un leg sin re-verificación on-chain.
- CD-5: PROHIBIDO deployar o upgradear el contrato a mainnet, o habilitar el flag contra
  fondos reales, hasta que una auditoría independiente cubra explícitamente cualquier
  función nueva/modificada (debit-dos-saltos ya auditado NO cubre una función arbiter
  nueva). Testnet-only para todo el epic.
- CD-6: OBLIGATORIO todo cambio de storage layout respeta `__gap` UUPS-safe (orden estable,
  reservas consumidas correctamente — mismo patrón que `_operator` consumió 1 slot del
  `__gap[44]→[43]` original).
- CD-7: PROHIBIDO introducir un segundo "libro autoritativo" implícito e indefinido — la
  fuente de verdad del balance de cada Agent Key debe quedar explícita por HU (decisión
  (c)), con reconciliación activa mientras coexistan `budget` off-chain y
  `escrowBalance` on-chain.

## Decisiones que requieren input del founder — `[NEEDS FOUNDER DECISION]`

1. **(a) Rol árbitro on-chain**: ¿`_arbiter` dedicado (nueva address/rol en el contrato,
   distinta de `_operator`) o reusar `_operator` con una función separada gateada por
   estado de disputa? ¿El estado de "hay una disputa abierta sobre este keyId" vive
   on-chain (nuevo mapping) o queda app-gated (el contrato confía en que quien llama
   `resolveDispute` — sea `_operator` u `_arbiter` — ya validó la disputa off-chain)?
   Impacta directamente el diseño de 191f.
2. **(b) Consentimiento de arbitraje**: ¿el simple acto de `deposit()` en el escrow implica
   que el depositante acepta la autoridad del árbitro para mover sus fondos sin firma
   adicional (equivalente a un ToS on-chain implícito), o se requiere un opt-in explícito
   (p.ej. firma separada al momento del deposit, o un flag por-keyId)? Sin esto, 191f no
   tiene base legal/de producto para diseñar `resolveDispute`.
3. **(c) Libro autoritativo**: cuando escrow está activo para un Agent Key, ¿el balance
   autoritativo pasa a ser `WasiAIEscrow.escrowBalance(keyId)` on-chain (con `budget`
   off-chain degradado a caché/mirror reconciliado), o `a2a_agent_keys.budget` sigue siendo
   la fuente de verdad y el escrow es solo el mecanismo de movimiento de fondos (sin cambiar
   quién decide el saldo)? Esto determina el diseño completo de 191c.
4. **(d) Alcance de migración**: dado el hallazgo de grounding (Wave 0 = flujo normal, sin
   cambios de Solidity, cierra la brecha de custodia de mayor volumen; Wave 1 = árbitro,
   requiere upgrade + decisiones (a)/(b) previas) — ¿migrar el flujo normal Y el árbitro en
   este epic (ambas waves), o acotar el epic SOLO al árbitro primero como pedía el ticket
   original, dejando el flujo normal para un epic de seguimiento? Recomendación del
   Analyst (no vinculante): Wave 0 primero por menor riesgo y mayor cobertura de $.

## Missing Inputs

- [bloqueante Wave 1] Decisiones (a) y (b) — sin ellas 191f no puede pasar a F2.
- [resuelto en F2 por HU] ¿`A2A_ESCROW_CONTRACT_<FAMILY>` está configurado hoy en algún
  ambiente vivo (staging/prod testnet)? El grounding de este F1 no encontró evidencia
  positiva ni negativa concluyente fuera de `escrow-verifier.ts`/`Deploy.s.sol` — el
  Architect debe verificar env reales en Railway/Vercel antes de 191d.
- [resuelto en F2 por HU] Forma exacta del mensaje `DebitAuthorization` si Wave 0 termina
  necesitando incluir `to`/seller en la firma (en vez del modelo de dos-saltos DT-1) — hoy
  el struct es `{keyId, amount, deadline, nonce}` (4 campos, sin `to`), consistente con
  "paga siempre al operador". Si el founder prefiere una función `debitTo` de un-solo-salto
  (decisión (d) implícita), el struct firmado DEBE incluir `to` — cambio de contrato,
  movería 191b de Wave 0 a Wave "requiere upgrade" también. El Analyst asume dos-saltos
  por default (menor riesgo, sin upgrade) salvo indicación contraria.

## Análisis de paralelismo

- Wave 0 (191a-191e) NO bloquea ninguna HU DONE/in-progress existente; toca
  `payment-intent.ts`/`arbiter.ts`/`adapters/escrow/*`, superficie no tocada por las filas
  159-171 in-progress de `_INDEX.md` (discovery/relevance/embeddings — módulo
  `orchestrate.ts`/`discovery.ts`, distinto).
- Wave 1 (191f-191h) SÍ depende funcionalmente de que el árbitro (WKH-139 v2, fila 145,
  DONE) y su panel de override (WKH-189, fila 171, DONE código / PENDING-DEPLOY) sigan
  operando sobre `budget` off-chain sin cambios hasta que 191g los migre explícitamente —
  no bloquea trabajo ajeno, pero SÍ debe coordinarse con el deploy pendiente de WKH-189
  (misma tabla `payment_intents`/RPC `close_payment_intent_for_arbitration`).
- 191f (contrato) puede diseñarse (F2 SDD) en paralelo a Wave 0 ejecutándose, pero su F3
  (Solidity real) espera las decisiones (a)/(b) — no hay entrelazado de código, solo de
  secuencia de gates humanos.
