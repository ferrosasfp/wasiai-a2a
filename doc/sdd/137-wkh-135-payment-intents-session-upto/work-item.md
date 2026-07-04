# Work Item — [WKH-135] Intents de pago: `session` (medido) + `upto` (cap dual-firmado)

## Resumen
Agregar dos intents de pago nuevos al protocolo money-path de wasiai-a2a — `session`
(deposit + acumulación de vouchers off-chain, settle único al cierre, refund del
residual; billing per-token/metered para LLMs y servicios de uso continuo) y `upto`
(Buyer capea el gasto, Seller reporta el uso real, settle en `min(cap, uso)`) —
nombrados de forma compatible con el Agent Payments Protocol (APP) de OKX, para
cerrar el gap de producto más grande frente a OKX.AI (hoy solo tenemos `charge`
vía x402 + budget prepago) y para habilitar el bridge APP-compatible (WKH-141,
que depende de esta HU).

## Sizing
- SDD_MODE: **full** (QUALITY) — money-path, dos primitivas de settlement nuevas,
  AR/CR obligatorio por regla del proyecto (CLAUDE.md: money-path → QUALITY siempre).
- Estimación: **M/L** (de Jira, confirmado por el análisis: toca settlement,
  potencialmente nueva persistencia, potencialmente nuevos endpoints).
- Branch sugerido: `feat/137-wkh-135-payment-intents-session-upto`

## Sizing — Skills Router
- `money-path-review` (o skill equivalente de revisión de settlement/EIP-712) —
  todo cambio en debit/credit/settle debe pasar por el lente de doble-cobro e
  idempotencia.
- `api-contract-design` — el naming/shape de los dos intents es contrato público
  (Agent Card, interop APP), no solo implementación interna.

## Contexto grounding (archivos reales revisados)
- `src/routes/orchestrate.ts` — `/`, `/plan`, `/execute`: patrón quote→approve→execute,
  `markSkipMiddlewareDebitHandler`, re-derivación server-side de precios, idempotencia
  de fee por `orchestrationId` generado server-side (NUNCA el que manda el cliente).
- `src/services/budget.ts` — `budgetService.debit/credit/creditWithDest/creditDelegation/
  creditSession`: 4 rutas de débito hoy (key-session, delegación, master dest-aware,
  master simple), todas con Ownership Guard `owner_ref` vía RPC atómico (`FOR UPDATE`).
  Ningún camino de "cap dual-firmado" ni "voucher acumulado" existe hoy.
- `src/services/fee-charge.ts` — patrón de referencia para settle EIP-712 con
  idempotencia DB (`a2a_protocol_fees`, PK `orchestration_id`, estados
  `pending→charged|failed`), re-verificación on-chain (`verifyDefaultChainSettle`)
  antes de marcar `charged`, y CD-B (jamás rechazar la promise).
- `src/services/key-session.ts` — **OJO naming**: ya existe el concepto "session"
  (WKH-121, `a2a_key_sessions`) para tokens de autenticación efímeros derivados de
  una master key (TTL + scope + budget cap), con débito atómico
  `debit_session_and_parent`. Esto es un mecanismo de **autenticación/autorización**,
  NO un intent de pago metered/streaming. El intent APP `session` de esta HU es
  conceptualmente distinto (deposit + vouchers acumulados + settle al cierre) aunque
  comparte la palabra "session" — riesgo de colisión de nombre real, marcado abajo.
- `src/middleware/x402.ts` — `buildX402Response`/`resolvePaymentRequirements`: el
  intent `charge` hoy es 402-challenge + un solo settle atómico por request. No hay
  concepto de "cap" ni "uso parcial reportado" en el middleware actual.
- `doc/competitive/okx-ai-analysis-2026-07.md` (línea 43) y
  `doc/competitive/attack-plan-2026-07.md` — fuente de la HU; confirma que WKH-141
  (bridge APP) depende de esta HU, y que WKH-136 (splits) comparte el mismo path de
  settlement.

## Acceptance Criteria (EARS)
- AC-1: WHEN un intent `session` se cierra (settlement final de los vouchers
  acumulados), the system SHALL settlear exactamente una vez por sesión de pago
  usando una clave de idempotencia estable (mismo patrón que
  `a2a_protocol_fees.orchestration_id` en `fee-charge.ts`), de forma que un retry
  del cierre NUNCA produzca un segundo cobro.
- AC-2: WHEN un intent `session` completa su settlement, the system SHALL calcular
  y devolver/creditar el residual del deposit inicial no consumido por los vouchers
  acumulados (`residual = deposit − Σvouchers_settled`), nunca reteniendo fondos no
  consumidos sin una vía de refund.
- AC-3: WHEN un intent `upto` se settlea, the system SHALL cobrar exactamente
  `min(cap, uso_reportado)` y NUNCA un monto mayor al cap firmado por el Buyer,
  independientemente de qué uso reporte el Seller.
- AC-4: WHILE cualquier estado intermedio de `session` o `upto` (deposit activo,
  vouchers acumulados, cap autorizado, uso reportado pendiente de settle) persiste
  en el sistema, the system SHALL aplicar el mismo patrón de Ownership Guard
  (`owner_ref`) documentado en `CLAUDE.md` a cualquier tabla/query nueva — sin
  excepción, igual que `a2a_agent_keys`/`tasks`/`a2a_key_sessions` hoy.
- AC-5: IF los identificadores de intent (`session`, `upto`) se exponen en
  cualquier superficie pública (Agent Card, request/response de API) pensada para
  interoperar con el bridge APP (WKH-141), THEN the system SHALL usarlos con el
  vocabulario compatible de OKX APP (no un nombre interno arbitrario) — sujeto a
  confirmación exacta del string/shape en `[NEEDS CLARIFICATION]` abajo.
- AC-6: IF un flujo `session` o `upto` queda a medio camino (deposit hecho pero
  nunca cerrado; cap autorizado pero uso nunca reportado) durante más de una
  ventana de tiempo definida, THEN the system SHALL tener una resolución
  determinística (auto-settle, expiry+refund, o reconciliación manual documentada)
  — la política exacta es `[NEEDS CLARIFICATION]`, pero "fondos retenidos
  indefinidamente sin resolución" es un resultado inaceptable en cualquier diseño.

## Scope IN
- Definición del modelo de datos y del servicio para los dos intents nuevos
  (persistencia — tabla nueva o extensión de una existente, a decidir en F2 con
  el humano; ver Missing Inputs).
- Lógica de acumulación/reporte de uso y el cálculo de settlement final para
  ambos intents (`session`: deposit − Σvouchers; `upto`: min(cap, uso)).
- Integración con el settle on-chain existente (reusar
  `getPaymentAdapter().sign()/.settle()` + `verifyDefaultChainSettle`, mismo
  patrón multi-chain que `fee-charge.ts`/`compose.ts` — Kite/Avalanche/Base).
- Naming/shape compatible con el vocabulario APP de OKX para los dos intents
  (habilita WKH-141 más adelante).
- Idempotencia + Ownership Guard sobre todo estado nuevo introducido.
- Tests (vitest) del ciclo completo de cada intent (creación → acumulación/reporte
  → settle → refund del residual cuando aplique).

## Scope OUT
- El bridge APP-compatible en sí (WKH-141) — HU separada, dependiente de esta.
- Splits atómicos bps (WKH-136) — HU separada; comparte el path de settlement
  pero NO se implementa acá (ver Análisis de paralelismo).
- El intent `escrow` de APP y cualquier mecanismo de disputa (WKH-139) — fuera
  de scope; el escrow no-custodial ya staged (WKH-126a/b) es un primitivo
  distinto y no se reutiliza automáticamente acá sin decisión explícita.
- Modificar el comportamiento del intent `charge` (x402) existente — permanece
  intacto, sin regresiones.
- IM/QR payments (WKH-137), embedded wallet + gasless (WKH-138) — no relacionados.
- UI/dashboard para visualizar sesiones/caps activos, salvo que el humano lo pida
  explícitamente en el gate.
- Renombrar o tocar el mecanismo existente de "key session" (WKH-121,
  `a2a_key_sessions`) — es un concepto de autenticación distinto; ver riesgo de
  naming abajo.

## Decisiones técnicas (DT-N)
- DT-1: El settle final de ambos intents reusa el patrón EIP-712 sign+settle vía
  `getPaymentAdapter()` (mismo que `fee-charge.ts`/`compose.ts`), en lugar de
  introducir un mecanismo de pago nuevo — mantiene compatibilidad multi-chain
  (Kite/Avalanche/Base) sin duplicar lógica de firma/verificación.
- DT-2: El estado intermedio (vouchers de `session`; cap + uso reportado de
  `upto`) requiere persistencia nueva en Postgres con Ownership Guard `owner_ref`,
  siguiendo el patrón de `a2a_key_sessions`/`a2a_agent_keys` — **candidato**, a
  confirmar en F2: tabla nueva (p.ej. `a2a_payment_intents`) vs. extensión de una
  tabla existente. NO se reutiliza `a2a_key_sessions` para evitar colisión
  semántica (ver riesgo de naming).
- DT-3: El vocabulario interno de los dos intents adopta los strings de APP
  (`session`, `upto`) tal cual para el campo `intent`/`paymentIntent` en el
  request, aceptando el riesgo de colisión de nombre con el "key session"
  existente (WKH-121) — requiere disambiguar explícitamente en código/docs
  (p.ej. `paymentIntent: 'session'` vs. `keySessionId`/`keySessionContext`, que
  ya existen y significan otra cosa).

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar el comportamiento del intent `charge` (x402) o del
  path de débito master/delegación/key-session ya existente — los intents nuevos
  se agregan como código adicional, cero regresión en `/compose`/`/orchestrate`
  actuales (validar con la suite de tests existente: `orchestrate.billing.test.ts`,
  `money-path.concurrency.test.ts`, `money-path.resilience.test.ts`).
- CD-2: OBLIGATORIO Ownership Guard (`owner_ref`) en cualquier tabla/query nueva
  que persista estado de `session`/`upto` — patrón exacto documentado en
  `CLAUDE.md` (Security Conventions / WKH-53). Un AR que encuentre una query sin
  `.eq('owner_ref', ...)` sobre estado nuevo de pago DEBE marcarlo BLOQUEANTE
  (equivalente a IDOR).
- CD-3: OBLIGATORIO idempotencia por clave estable (id del intent generado
  server-side, NUNCA un id que el cliente controle como única clave de billing —
  mismo criterio que `orchestrationId` en `/orchestrate/execute`) en el settle
  final de ambos intents, para prevenir doble-cobro en retries/replays.
- CD-4: PROHIBIDO inventar la semántica de firma (qué firma el Buyer, qué firma
  el Seller, formato EIP-712 exacto del cap de `upto` o del voucher de `session`)
  sin confirmación humana — cualquier vacío de diseño se marca
  `[NEEDS CLARIFICATION]`, no se asume.
- CD-5: OBLIGATORIO re-verificar el settle final on-chain (mismo patrón
  `verifyDefaultChainSettle` de `fee-charge.ts`) antes de marcar cualquier intent
  como `closed`/`settled` — un settle reportado por el facilitator pero no
  confirmado on-chain no debe cerrar el intent como exitoso.

## Categorías de riesgo (para AR/CR — flagged explícitamente)
1. **Money-path**: ambos intents tocan settlement real multi-chain; cualquier
   bug es pérdida de fondos, no solo un bug funcional.
2. **Doble-cobro**: el cierre de `session` y el settle de `upto` son puntos de
   replay/retry — sin idempotencia por clave estable, un retry duplica el cargo
   (CD-3).
3. **Refund del residual**: `session` requiere devolver lo no consumido del
   deposit — un cálculo incorrecto (off-by-one, redondeo, residual negativo) es
   un leak de fondos del Buyer o del protocolo.
4. **Firmas EIP-712**: si `upto` requiere que el Buyer firme el cap (dual-signed
   per el nombre "cap dual-firmado" en el título de la HU), el formato/dominio
   EIP-712 exacto es un vacío de diseño — ver Missing Inputs.
5. **Idempotencia**: igual que doble-cobro, pero también aplica a la
   *acumulación* de vouchers en `session` (un voucher reenviado dos veces no debe
   contar dos veces) y al *reporte de uso* en `upto` (un reporte reenviado no debe
   inflar el uso).
6. **Ownership Guard**: cualquier tabla nueva debe seguir el patrón CD-2/AC-4
   (riesgo estándar del proyecto, ya documentado en CLAUDE.md).

## Missing Inputs
- **[BLOQUEANTE] Modelo exacto de vouchers off-chain de `session`**: ¿qué firma
  cada voucher (¿el Seller firma cada unidad de uso? ¿el Buyer pre-autoriza un
  rango y el Seller solo reporta?), cómo se acumulan (ledger server-side vs.
  firmas EIP-712 por voucher individual), y qué dispara el settle de cierre
  (¿timeout, llamada explícita del Buyer, fin de un pipeline de compose,
  agotamiento del deposit?).
- **[BLOQUEANTE] Semántica exacta de `upto`**: ¿quién firma el cap (Buyer, vía
  EIP-712 — análogo a una delegation existente)? ¿quién reporta el uso real (el
  Seller/agente ejecutado, vía qué canal: callback, header de respuesta propio,
  endpoint dedicado)? ¿Qué pasa si el Seller reporta un uso mayor al cap firmado
  (¿se trunca silenciosamente a cap, se rechaza el settle, se marca en disputa)?
- **[BLOQUEANTE] Persistencia**: ¿se crea una tabla nueva (`a2a_payment_intents`
  o similar, migración Supabase nueva) o se extiende una tabla existente? Esto
  determina si esta HU trae migración de DB (impacto en F2/F2.5).
- **[BLOQUEANTE] Compatibilidad de naming con APP (OKX)**: ¿los valores del
  campo `intent` deben ser literalmente `"session"`/`"upto"` (string exacto) para
  que el bridge WKH-141 funcione sin mapping adicional, o alcanza con
  compatibilidad *conductual* + un adapter de nombres en el bridge? Afecta el
  contrato público (shape de API, Agent Card).
- **[resuelto en F2, no bloqueante]** ¿Estos intents se exponen vía extensión de
  `/compose`/`/orchestrate` existentes, o vía endpoints dedicados nuevos
  (`/payments/session/*`, `/payments/upto/*`)? ¿Aplican a una sola llamada a un
  agente o a pipelines completos multi-step?
- **[resuelto en F2, no bloqueante]** Dado el esfuerzo M/L y que son DOS
  primitivas de settlement distintas, ¿el humano quiere ambos intents en esta
  misma HU/PR, o prefiere partir en dos entregas (p.ej. `upto` primero — más
  simple, análogo a un cap de delegación ya existente — y `session` como
  follow-up)?

## Análisis de paralelismo
- **Bloquea a WKH-141** (bridge APP-compatible): WKH-141 depende explícitamente
  de que `session`/`upto` existan y tengan naming APP-compatible (attack-plan
  línea 42). No puede arrancar antes de que esta HU cierre.
- **Comparte el path de settlement con WKH-136** (splits atómicos bps): ambas
  tocan el punto donde se resuelve el monto final a transferir on-chain
  (hoy `fee-charge.ts`/`compose.ts`/`resolveAgentPriceUsdc`). El attack-plan
  secuencia intents primero, splits después (Wave 1: 135 → 136) — recomendado
  mantener ese orden para que WKH-136 diseñe los splits considerando los NUEVOS
  puntos de settle (`session` close, `upto` settle) y no solo el `charge`
  original, evitando lógica duplicada o un refactor posterior.
- **No bloquea** a WKH-132/133/134 (Wave 0, ya DONE) ni a WKH-137/138 (Wave 2,
  LATAM UX) — son independientes en código, aunque WKH-137/138 podrían eventualmente
  querer exponer estos intents también (fuera de scope acá).
- **Puede correr en paralelo** con trabajo de documentación/pitch (no-código) pero
  NO con WKH-136 en simultáneo sobre los mismos archivos de settlement — riesgo
  de conflicto de merge si ambos tocan `fee-charge.ts`/`compose.ts` a la vez.
