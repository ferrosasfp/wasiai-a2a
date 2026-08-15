# Roadmap · Incubadora WayLearn / Solana LATAM Labs · agosto 2026

**Autor**: `nexus-architect` en modo planificación de roadmap (solo lectura).
**Fecha de verificación del código y de producción**: 2026-07-29.
**Alcance**: qué hace falta para tener un producto 100% profesional y funcional para **usuario final** y para **agente final**, alineado al corte Solana.
**Naturaleza de este documento**: no es un SDD y no reemplaza ninguno. No toqué `doc/sdd/212-*` ni `doc/sdd/213-*` (hay dos architects trabajando ahí).

---

## 0. Lo primero, porque cambia el orden de todo

Antes del checklist hay que decir tres cosas que verifiqué y que **mueven el corte acordado**. Las tres están con archivo:línea o con la salida de una consulta a producción.

### 0.1 El camino crítico NO es WKH-314. Es WKH-315.

Los dos work-items abiertos dejaron el mismo bloqueante sin resolver porque no podían mirar `chaski-v3`:
WKH-314 §10 MI-1 y WKH-315 §6 D-5 / §10 MI-3 preguntan lo mismo, *"¿el pagador de la demo paga por x402 o con clave prepaga?"*, y los dos escriben *"no lo pude determinar desde este repo"*.

**Está determinado. Chaski paga con clave prepaga y NO firma x402.**

- `chaski-v3/src/infrastructure/a2a/gateway-client.ts:14` lo dice literal:
  *"Chaski NO firma x402 (AC-5): el único header de auth es x-a2a-key; el body NO lleva challenge ni firma."*
- `gateway-client.ts:95` lee `WASIAI_A2A_AGENT_KEY` (la clave prepaga).
- `gateway-client.ts:172` manda `"x-a2a-key": cfg.key` y nada más de auth.

**Consecuencias, que son las que importan:**

1. **WKH-315 (pared B, fondeo prepago en Solana) es el camino crítico. WKH-314 (x402 inbound) no lo es.** WKH-315 §8.4 ya escribió su propia condición de inversión: *"si la respuesta al MI-1 de WKH-314 / D-5 es 'la demo paga con clave prepaga', entonces 315 es el camino crítico y 314 no, y conviene invertir el orden"*. **La condición se cumplió: se invierte.**
2. **El orden de merge se invierte**: WKH-315 mergea primero y es dueña de promover `probeSettlementPresence` (hoy `private`, `src/adapters/solana/payment.ts:572`); WKH-314 lo consume. Esto además le conviene a 314 por otra razón: la fila 189 (`fix/p1-discover-reputation-402-cap`) sigue abierta y tocó la superficie del challenge 402, que es exactamente lo que 314 escribe (WKH-315 §8.5 / WKH-314 §11.2).
3. **Y el dueño de `TD-SOLANA-CAIP2-DENYLIST` queda definido** (era WKH-315 D-4, sin dueño): es **WKH-315**, porque es la primera de las dos que enciende el rail y la condición de reactivación de esa deuda se dispara al encenderlo (`chain-resolver.ts:252-264`, citado en WKH-315 §4.4).

### 0.2 Hoy toda la plata que gasta Chaski entró por Avalanche, y está medido

`gateway-client.ts:86-88` guarda una medición del 2026-07-26:
`"chain 2368 (kite-ozone-testnet) balance is 0; no x-payment-chain header sent, used default 'kite-ozone-testnet'; chains with balance: avalanche-fuji (6.793)"`.

Y `GET /capabilities` en producción (consultado hoy) confirma que la red default del gateway es `kite-ozone-testnet` (`isDefault: true`), con `solana-devnet` presente en `chainId 900001` y `acceptsInboundPayment: false`.

O sea: el requisito *"los 3 agentes se cobran en Solana, no debe intervenir Avalanche"* **no se satisface sin WKH-315**, porque el saldo prepago es por red (`budget[chainId]`) y el único saldo que existe está en `avalanche-fuji`. Esto confirma la premisa central de WKH-315 desde el lado del consumidor, no solo desde el lado del gateway.

### 0.3 La demo insignia está ROTA HOY, y no tiene nada que ver con Solana

Este es el hallazgo más importante del relevamiento y no está en ninguna lista del corte.

**Consulta a producción, gratis, hecha hoy:**

```
GET /discover?capabilities=remittance-payout                    -> total: 1
   remit-cashout-payout-solana   computedReputation: null
GET /discover?capabilities=remittance-payout&minReputation=2     -> total: 0
```

El único agente del catálogo que cumple `remittance-payout` es `remit-cashout-payout-solana`, y **queda excluido por el piso de reputación 2**.

Chaski fija ese piso en código, no en env, y lo manda en el leg de payout:

- `chaski-v3/src/infrastructure/a2a/gateway-client.ts:29` -> `export const PAYOUT_MIN_REPUTATION = 2;`
- `chaski-v3/app/api/a2a/payout/submit/route.ts:390` -> `constraints: { min_reputation: PAYOUT_MIN_REPUTATION }`, con el comentario *"CD-5/CD-11: MISMO par que prepare"*, así que el leg de `prepare` está igual.

El filtro del gateway hace exactamente lo que dice su comentario (`src/services/discovery.ts:419-428`):
*"FAIL-SAFE: sin score computado (0 tasks liquidadas, o batch degradado a Map vacío) el agente cuenta 0 -> queda EXCLUIDO si `minReputation > 0`"*.

Y de ahí en adelante: `resolveCapability` devuelve `no_candidates` (`src/services/capability-resolver.ts:107-136`) -> 422 -> Chaski lo mapea a `no_agent_match` (`gateway-client.ts:136`) -> y el route lo colapsa a un **502 opaco `a2a_unavailable`** (`app/api/a2a/payout/submit/route.ts:395-400`).

**El leg de entrega de valor de Chaski no puede resolver. Es un bug de producto y además es demo-breaking, y es anterior a cualquier trabajo de Solana.**

Dos datos que hacen que el arreglo sea barato y que no sea una regresión de seguridad:

1. **El piso lo pone el caller, no el gateway.** WKH-313 (`doc/sdd/211-wkh-313-primer-trabajo-agentes-sin-historial/work-item.md`, hoy solo F1) lo verificó y lo escribe en su §0: *"El gateway NO pone el piso. No hay default de entorno, no hay inyección del planner, no hay valor implícito. El piso lo fija siempre el que consulta."* Entonces se puede desbloquear del lado de Chaski.
2. **Bajar el piso NO saca un control de seguridad.** Lo declara el propio código que lo introdujo, `gateway-client.ts:26-28`: *"NO es un control de seguridad: sube el piso, no reemplaza PR8 (formato del depositAddress) ni PR9 (atestación HMAC), que corren idénticos con piso o sin piso."*

Es, sin embargo, una **decisión de producto del founder**, no una decisión de dev: es el mismo círculo cerrado que WKH-313 plantea como pregunta estructural.

---

## 1. Dos audiencias, dos conjuntos de requisitos

El encargo pide un producto profesional para **usuario final** y para **agente final**. No son el mismo requisito, y tratarlos como uno es cómo se llega a algo que impresiona un viernes y no se puede shipear.

### 1.1 Lo que COMPARTEN (si falla, falla para los dos)

| Requisito compartido | Estado hoy |
|---|---|
| El dinero se cobra una sola vez, verificado antes de acreditar | OK en EVM (`register_a2a_key_deposit`, `20260529000000_a2a_key_deposits.sql:75-79`, UNIQUE(chain_id,tx_hash)); INEXISTENTE en Solana (WKH-315) |
| Ante indeterminación se rechaza sin consumir la prueba | Decidido; ya se cumple en el camino EVM de deposit (WKH-315 §1.2 nota); por construir en Solana |
| El rail que se anuncia es el rail que se usa | OK y honesto hoy: `acceptsInboundPayment: false` para `solana-devnet` (verificado en prod) |
| Alguien se enteraría si el rail se cae | **NO cubre Solana** (ver 2.3) |
| Existe una forma de resolver un pago que quedó pendiente | **NO existe herramienta**, solo un runbook manual (ver 2.4) |

### 1.2 Lo que es SOLO del usuario final (persona)

| Requisito | Estado hoy |
|---|---|
| Entiende qué pasó cuando algo falla | **NO**: todo colapsa a `502 a2a_unavailable` (`payout/submit/route.ts:395-400`) |
| Puede reintentar cuando el rechazo fue por indeterminación | **NO**: el único "Reintentar" es el del timeout de KYC (`chaski-v3/src/presentation/flow.tsx:445-448`); el estado de error genérico es un string plano (`:61`, `:709-737`) |
| No espera más de lo tolerable | Techo de 10s por llamada al gateway (`gateway-client.ts:183`) |
| Sabe el mínimo enviable antes de intentar | OK, reciente (`chaski-v3` commit `b9cf17e`, *"ui: minimo de envio"*) |
| Su PII no se filtra | OK por diseño y con gate de QA (`gateway-client.ts:9-13`) |

**El punto no obvio**: la política nueva *"rechazar sin consumir la prueba"* es la decisión correcta, pero **hoy se ve exactamente igual que una caída**. Si el usuario no puede distinguir "reintentá en 30 segundos" de "esto está roto", la política correcta se percibe como un error. Eso convierte a la retriabilidad en un requisito del money-path, no en cosmética.

### 1.3 Lo que es SOLO del agente final (tercero que construye en Solana)

Esta es la audiencia de la incubadora, y es donde encontré el hueco más grande.

| Requisito | Estado hoy |
|---|---|
| Publicarse solo, sin pedirle permiso a nadie | OK: `POST /agents` con `requireA2AKey`, gratis (`src/routes/agents.ts:1-23`, `:114-122`) |
| **Declarar que cobra en Solana** | **NO EXISTE CAMINO DE ESCRITURA** (ver 2.1) |
| Declarar su wallet de payout en Solana | OK: `payoutChain` + `payoutWallet` validan base58 (`src/routes/agents.ts:83-95`, WKH-234) |
| Ser descubrible por capacidad | OK, verificado en vivo |
| **Ser elegible alguna vez** | **NO si el caller pone piso > 0** (ver 0.3) |
| Recibir errores estables y granulares | OK del lado del gateway (`error_code`), se pierde en el consumidor |
| Publicar su propio manifiesto de cobro | Construido pero **NO deployado** (ver 2.2) |

---

## 2. Huecos que NO estaban en ninguna lista

Los cinco siguientes no figuran en el corte, ni en los parkeados, ni en los dos work-items. El corte se armó desde los hallazgos, así que estaba sesgado a lo ya encontrado.

### 2.1 HUECO-A · No hay camino de escritura para `metadata.payment`. Un agente no puede declarar que cobra en Solana.

**Verificado:**

- `src/types/index.ts:191-218` (`PublishAgentInput`): tiene `name`, `agentUrl`, `capabilities`, `description`, `priceUsdc`, `inputSchema`, `outputSchema`, `discoverable`, `payoutWallet`, `referrerRef`, `payoutChain`. **No tiene `payment`.**
- `src/services/agent.ts:177-189` (`buildMetadata`): persiste **exclusivamente** `inputSchema`, `outputSchema` y `discoverable`. Nada más entra al JSONB.
- `src/services/agent.ts:115-147` (`mapRowToAgent` + `readPaymentSpec`): el **lector** existe y está bien hecho (WKH-241), con su propio docstring explicando por qué hace falta: *"sin él, un agente self-published Solana-native cobraba su fee por la chain default del gateway"*.

**O sea: WKH-241 construyó el lector y el escritor nunca existió.**

Prueba en producción de que las filas se sembraron fuera del repo, consultada hoy:

```
remit-corridor-fx-solana    payment: {"method":"x402","chain":"solana-devnet","contract":"64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z","asset":"USDC"}   registry: self-published
remit-cashout-payout-solana payment: {"method":"x402","chain":"solana-devnet","contract":"64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z","asset":"USDC"}   registry: self-published
remit-kyc-validator         payment: null                                                                                                                registry: self-published
```

Los dos agentes Solana llevan `payment.chain: solana-devnet` y son `self-published`, pero ninguna ruta del repo puede escribir ese objeto. Se sembraron por fuera.

**Por qué es grave y no cosmético**: la audiencia de la incubadora son colaboradores que construyen en Solana. Hoy uno de ellos **no puede publicar un agente que cobre en Solana usando la API pública**. Puede publicar el agente, puede declarar su wallet de payout, y el gateway le va a cobrar su fee por la red default (que en prod es `kite-ozone-testnet`). Eso es un bug de producto sobre el eje exacto que la incubadora vino a ver.

### 2.2 HUECO-B · `remit-kyc-validator` no está en Avalanche desde donde se decide la plata, y eso cambia el ítem 3 del corte

El corte dice que el agente de KYC hoy es `chain: "avalanche-fuji"` y cita `wasiai-remittance-agents/src/manifest/registry.ts:32-33`. **La cita es correcta**, lo verifiqué.

Pero la fila del gateway, que es la que decide dónde se mueve la plata, dice `payment: null` (consulta de arriba). Y `agent.ts:118-120` documenta exactamente qué significa eso: sin `metadata.payment`, el fee se cobra **por la chain default del gateway**, que en prod es `kite-ozone-testnet`.

**Consecuencia para el corte**: "pasar el KYC a Solana" **no es editar una línea del manifiesto**. El manifiesto del agente y la fila del gateway son dos verdades distintas, y la que cobra es la del gateway. Para moverla hace falta HUECO-A resuelto. **El ítem 3 del corte depende del ítem que nadie tenía anotado.**

### 2.3 HUECO-C · La observabilidad no cubre el rail Solana. Nada.

- `.github/workflows/` en `wasiai-a2a` tiene exactamente dos archivos, `ci.yml` y `smoke-downstream.yml`, y **cero** coincidencias de "solana".
- `wasiai-monitor`: `grep -rli solana` en `app/`, `lib/` y `tests/` solo matchea dos archivos de test (`tests/page-html.test.ts`, `tests/api-trace.test.ts`), y `lib/*.ts` no tiene ninguna constante de chain. El monitor no es chain-aware.
- `src/routes/dashboard.ts` y `src/routes/metrics.ts`: **cero** referencias a Solana.

El trípode (gas, health, synthetic) existe para EVM. **Si el rail Solana se degrada, hoy nadie se entera por un canal automático.** Y las dos HUs nuevas dependen de un RPC que puede degradarse: es precisamente la condición que produce `unknown`, o sea el estado que la política nueva convierte en rechazo. Un rechazo masivo silencioso durante la Demo Day es el escenario que esto previene.

### 2.4 HUECO-D · No hay lector de reconciliación. Los registros que las dos HUs nuevas van a escribir no los lee nadie.

WKH-314 AC-6 y WKH-315 AC-6 obligan las dos a *"dejar un registro durable que nombre la firma para reconciliación"*. Verifiqué qué existe para leerlos:

- `grep -rn "stranded\|reconcil"` en `src/` (sin tests): **cero superficies**.
- `scripts/report-stranded-exposure.mjs:3-9` **no es un reconciliador**, es un estimador de cota, y lo dice: *"Esto NO la recupera ni la reclama, la ACOTA"*. Solo lee `GET /discover` para calcular el techo teórico por pipeline.
- La recuperación real es un markdown: `doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/runbook-destrabe.md`.

**O sea: vamos a escribir evidencia de reconciliación en una tabla que no tiene lector, y a operar con un runbook manual.** Para devnet y una demo es tolerable. Para llamar a esto un producto profesional, no.

### 2.5 HUECO-E · El consumidor tira a la basura los códigos granulares que el gateway se esmeró en dar

`gateway-client.ts:43-68` define once códigos de falla distintos y preserva el `code`/`error_code` real del gateway sin traducirlo (`readFailureFields`, `:103-120`). Es buen trabajo.

Y después `app/api/a2a/payout/submit/route.ts:395-400` los colapsa todos a un `502 a2a_unavailable`, y el granular se va **solo al log** (`logGatewayFailure`). El mismo patrón está en el resto de los routes que llaman `runViaGateway` (`app/api/a2a/quote/route.ts:47`, `app/api/payout/prepare/route.ts:239`).

Esto es el mismo vicio que el proyecto viene persiguiendo, un colapso de estados, pero en la capa de presentación: `no_agent_match` (catálogo), `payment_required` (saldo), `forbidden` (permiso) y `unavailable` (caída) son cuatro problemas con cuatro dueños distintos, y el usuario ve el mismo cartel. Es también la razón por la cual el hallazgo 0.3 estuvo invisible: la demo rota se reporta como "el gateway no está disponible".

### 2.6 Confirmaciones de los dos ítems que el orquestador sacó del parkeo

**WKH-300 está en `main` pero NO está en producción.** Verificado por los dos lados:

- `git merge-base --is-ancestor 40c81fc main` -> es ancestro. `HEAD` y `main` están los dos en `798c6a2`. El commit de WKH-300 es `40c81fc`, del **2026-07-28** (corrección al encargo: no son 11 días de antigüedad del commit; el commit es de ayer, lo viejo es el deploy).
- Probe a producción hoy: `GET https://wasiai-remittance-agents.vercel.app/api/agents/{remit-corridor-fx,remit-cashout-payout,remit-kyc-validator}/manifest` -> **404 los tres**, mientras `/api/agents/remit-corridor-fx/invoke` -> 405 (la ruta existe) y `/` -> 200 (el deploy está vivo).

Conclusión: prod sirve un build anterior a WKH-300. **El arreglo es un deploy, no una HU.** Y es prerrequisito real: sin el manifiesto publicado, republicar los agentes declarando Solana no tiene fuente de verdad servida.

**El gate de re-hidratación de WKH-307 nunca corrió.** Confirmado en dos artefactos del propio cierre de la HU:

- `doc/sdd/209-.../auto-blindaje.md:330`: *"La rama POSITIVA del gate de re-hidratación NUNCA se ejecutó contra Postgres."*
- `doc/sdd/209-.../done-report.md:135-137`: es el único pendiente, el SQL existe (`gate-rehydration-test.sql`) y **necesita un entorno descartable**, no bdwv.

Es exactamente lo que dijo el orquestador: las dos HUs nuevas apoyan el uso único del dinero en una pieza cuyo camino de recuperación no se probó.

### 2.7 Un dato de configuración que decide si la demo pasa por el gateway

`NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` está **vacío** en la plantilla (`chaski-v3/.env.example:138`), y `a2a-gateway` es el tercer valor opt-in (`:164`). En el route, la rama del gateway solo corre si el flag vale exactamente `"a2a-gateway"`; si no, cae a la rama punto a punto que invoca el agente directo (`app/api/a2a/payout/submit/route.ts:384-385` y `:418-425`).

O sea: **si el flag no está flipeado, la plata no pasa por el gateway y el claim "los 3 agentes se cobran en Solana" no se puede demostrar**, independientemente de todo el código que escribamos. Es un ítem de founder/ops, chico, y hay que ponerlo en la lista para que no se descubra el 21 de agosto.

---

## 3. Checklist priorizado, en orden de ejecución real

Leyenda:
**Quién**: `founder` = necesita credencial, decisión de negocio o plata. `dev` = es código.
**Para qué**: `demo` = hace falta para el Demo Day. `producto` = hace falta para que alguien lo use en serio. `ambos`.
**Tamaño**: S = menos de 1 día. M = 1 a 3 días. L = 4 a 6 días con pipeline QUALITY completo y fix-pack.

| # | ID | Título | Por qué está en este lugar | Depende de | Tam | Quién | Para qué |
|---|---|---|---|---|---|---|---|
| 1 | **OPS-1** | Deployar `wasiai-remittance-agents` `main` (798c6a2) a Vercel | Prod sirve un build sin WKH-300: los 3 `/manifest` dan 404 hoy. Sin esto, republicar agentes en Solana no tiene fuente de verdad servida. `main` ya lo contiene, es solo un deploy | nada | S | founder | ambos |
| 2 | **DEC-1** | Decidir la política del piso de reputación para agentes sin historial | **Desbloquea la demo, que está rota hoy** (§0.3). `remittance-payout` + piso 2 devuelve total 0 en prod. Es decisión de negocio, no de dev, y el piso lo pone el caller | nada | S | founder | ambos |
| 3 | **WKH-313** | El primer trabajo de un agente que no es nuestro | Implementa DEC-1. Ya existe el work-item en F1 (`doc/sdd/211-...`). Corte mínimo posible: bajar `PAYOUT_MIN_REPUTATION` en `chaski-v3` (1 constante) para desbloquear ya, y el arreglo estructural del marketplace después | DEC-1 | M | dev | ambos |
| 4 | **OPS-2** | Correr `gate-rehydration-test.sql` en Postgres descartable | Las dos HUs de dinero se apoyan en el ledger de WKH-307 y su camino de recuperación nunca se probó. Barato ahora, carísimo el 21/08. **Jamás contra bdwv ni caldz** | nada | S | dev | producto |
| 5 | **OPS-3** | Corregir `.nexus/project-context.md` (drift de stack) | Los dos work-items lo escalaron sin resolver (WKH-314 MI-6, WKH-315 MI-8): dice `2026-03-31`, describe stack Kite-only, no menciona Solana ni el facilitator, y afirma *"viem v2, PROHIBIDO ethers"* como si todo fuera EVM. **Un sub-agente que lo tome como verdad decide mal en las dos HUs de dinero** | nada | S | dev | producto |
| 6 | **DEC-2** | Resolver los `[DECIDE FOUNDER]` de WKH-315: D-1 (bajo qué red vive el saldo Solana y si es fungible) y D-3 (cómo se prueba el control de la wallet depositante) | Los dos son bloqueantes declarados de WKH-315 (§10 MI-1, MI-2) y **D-3 decide el tamaño real de la HU** (bind ed25519 completo vs pubkey registrada out-of-band). CD-2 de esa HU dice que sin D-3 resuelto la HU no se implementa | nada | S | founder | ambos |
| 7 | **WKH-315** | La pared B: fondear la clave prepaga en Solana | **CAMINO CRÍTICO.** Es la HU que hace que la plata que gastan los 3 agentes haya entrado por Solana. Hoy el único saldo está en `avalanche-fuji` (§0.2). Mergea PRIMERO y promueve `probeSettlementPresence` | DEC-2, OPS-2 | L | dev | ambos |
| 8 | **WKH-316** | Camino de escritura para `metadata.payment` en `POST`/`PATCH /agents` | HUECO-A. Es lo que permite que un tercero declare que cobra en Solana, y es **prerrequisito del ítem 3 del corte** (§2.2). Va en paralelo con WKH-315 en otro worktree: toca `types/index.ts` y `services/agent.ts`, que WKH-315 no toca | nada (paralelizable) | M | dev | producto |
| 9 | **WKH-317** | Pasar el cobro de `remit-kyc-validator` a Solana | Ítem 3 del corte. No es editar el manifiesto: la fila del gateway tiene `payment: null` y cobra por la red default (§2.2). Necesita el escritor de WKH-316 y el manifiesto deployado de OPS-1 | OPS-1, WKH-316 | M | dev + founder (env payTo) | ambos |
| 10 | **WKH-318** | Superficie de error retriable de punta a punta (gateway -> Chaski -> usuario) | HUECO-E + §1.2. **Sin esto, la política "rechazar sin consumir la prueba" se ve idéntica a una caída y el usuario no tiene cómo reintentar.** Es lo que hace legible la decisión correcta. Después de WKH-315 porque necesita los códigos nuevos que esa HU introduce | WKH-315 | M | dev | ambos |
| 11 | **WKH-319** | Observabilidad del rail Solana (synthetic + health + alerta) | HUECO-C. Cero cobertura hoy. La degradación del RPC es exactamente la condición que produce `unknown`, o sea rechazos. Antes de la Demo Day para no descubrir una degradación en vivo | WKH-315 | M | dev + founder (secrets/webhook) | producto (+ seguro de demo) |
| 12 | **WKH-320** | Cerrar `TD-SOLANA-CAIP2-DENYLIST` (fail-open por denylist -> allowlist fail-closed) | Su propia condición de reactivación se dispara al encender el rail Solana (`chain-resolver.ts:252-264`). **Dueño asignado: WKH-315**, por ser la primera en encenderlo (§0.1). Puede ir dentro de WKH-315 o inmediatamente después, pero no se cruza en silencio | WKH-315 | S | dev | producto |
| 13 | **OPS-4** | Flipear `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a-gateway` y `WASIAI_A2A_PAYMENT_CHAIN=solana-devnet` + fondear la clave prepaga en Solana | §2.7. Sin el flip la plata no pasa por el gateway y el claim no se puede demostrar. Va después de WKH-315 porque el fondeo en Solana es lo que esa HU habilita | WKH-315 | S | founder | demo |
| 14 | **WKH-321** | Lector de reconciliación de pagos indeterminados / pendientes | HUECO-D. Los registros durables de AC-6 de las dos HUs no tienen lector; la recuperación es un runbook manual. Es requisito de producto, no de demo | WKH-315 | M | dev | producto |
| 15 | **WKH-314** | La pata de entrada x402 en Solana | **Sacada del camino crítico** (§0.1): Chaski no firma x402. Sigue siendo la HU correcta para que un tercero pague sin clave prepaga, que es producto real. Mergea DESPUÉS de 315 y consume el probe promovido | WKH-315, fila 189 mergeada | L | dev | producto |
| 16 | **WKH-322** | Esteroide 1: atestación on-chain del KYC en Solana | Cierra el salto de confianza que originó la HU-203 y es un uso de Solana que **mejora el agente**. No entra antes de M5 (§4) | WKH-317 | L | dev | producto (narrativa en demo) |
| 17 | **WKH-323** | Esteroide 2: oráculo on-chain para el FX | Cierra la falta de banda y de frescura de la tarea #66. Mismo veredicto de calendario | WKH-317 | L | dev | producto |

### 3.1 Camino crítico, en una línea

**OPS-1 + DEC-1/WKH-313 (desbloquear la demo) -> DEC-2 -> WKH-315 (fondeo Solana) -> WKH-316 (escritor de `metadata.payment`) -> WKH-317 (KYC a Solana) -> OPS-4 (flip + fondeo) = el claim "los 3 agentes se cobran en Solana sin Avalanche" demostrable.** Todo lo que se atrase en esa cadena mueve M5.

Ojo con el eslabón que no es obvio: **WKH-316 está en el camino crítico** porque WKH-317 no se puede hacer sin él (§2.2), y nadie lo tenía anotado.

---

## 4. La verdad sobre el calendario

### 4.1 Los números

Hoy es **2026-07-29**. De mañana al 2026-08-21 (M5) hay **17 días hábiles**.

**Costo medido, no estimado**: WKH-306 y WKH-307 fueron cada una una HU de dinero con pipeline QUALITY completo, y **cada una tuvo bloqueante en revisión adversarial más fix-pack**. Dos de dos. La tasa de "sale en un pase" para una HU de dinero en este repo es, con la evidencia disponible, **cero**. Por eso una L de dinero se planifica a 4 a 6 días hábiles **incluyendo el fix-pack**, no a 3 optimistas.

Paralelismo por worktrees: real, pero el cuello no es la cantidad de worktrees, es que **`wasiai-a2a` es el repo caliente** y ya va a tener dos escritores (WKH-315 y WKH-316). Un tercero simultáneo sobre `src/adapters/types.ts` es donde empiezan los conflictos que cuestan más que el paralelismo que ahorran.

### 4.2 Semana del 2026-08-03: el pedido del mentor

El pedido es *"repos que demuestren uso real de tecnología Solana"*. **Eso ya se puede demostrar esa semana y NO requiere terminar ninguna HU de dinero**, porque el leg de salida ya liquida en Solana devnet de verdad (firma verificada en cadena citada en WKH-314 §2) y los dos agentes Solana ya son descubribles en vivo con `payment.chain: solana-devnet` (verificado hoy).

Lo que hay que tener listo para esa semana es esto, y es todo chico:
- **OPS-1** (deploy, manifiestos vivos).
- **DEC-1 + el corte mínimo de WKH-313** (que la demo resuelva el payout en vez de dar 502).
- **OPS-2** y **OPS-3** (baratos, y los dos evitan un desastre después).
- Un guion reproducible que termine en una firma de devnet que el mentor pueda pegar en Solana Explorer.

**Lo que NO va a estar esa semana**: WKH-315 y WKH-314. Las dos son L de dinero. Decirlo ahora es más barato que descubrirlo el 06/08, y las dos HUs ya lo dijeron de sí mismas (WKH-314 §7.1, WKH-315 §7.3).

### 4.3 M5, 2026-08-21: qué entra y qué no

**Entra, con el orden del §3 y sin heroísmo:**
OPS-1, DEC-1, WKH-313, OPS-2, OPS-3, DEC-2, **WKH-315**, **WKH-316**, **WKH-317**, WKH-318, WKH-320, OPS-4.

Ese conjunto cierra el claim completo: la plata entra por Solana, los 3 agentes cobran en Solana, no interviene Avalanche en ningún tramo del dinero, y el usuario entiende y puede reintentar.

**No entra:**
- **WKH-314** (x402 inbound). Es una L de dinero, la segunda, y no está en el camino de la demo.
- **WKH-322 y WKH-323** (los dos esteroides). Son dos L cada una y dependen de WKH-317, que aterriza cerca del 19/08.
- **WKH-321** (lector de reconciliación) queda en riesgo alto: es lo primero que yo sacaría si WKH-315 se pasa de 6 días.

**Holgura real: prácticamente ninguna.** Un segundo fix-pack en WKH-315, o un D-3 que se resuelva por el bind ed25519 completo en vez del out-of-band, se come la holgura entera. Por eso DEC-2 está en el puesto 6 y no en el 10: **es la decisión que fija el tamaño de la HU del camino crítico, y cada día que tarda es un día que no se puede planificar.**

### 4.4 El corte que propongo si no entra, y por qué no deja el dinero a medias

Si al **2026-08-14** WKH-315 no está mergeada, el corte es: **congelar el alcance en WKH-315 + WKH-316 + WKH-317 + OPS-4, y sacar WKH-318 y WKH-320 de M5.**

Y si hay que cortar dentro de WKH-315, se corta por donde su propia §7.3 ya autorizó, **y solo por ahí**: implementar el gate de funding wallet con la pubkey registrada out-of-band en vez de la ruta completa de bind ed25519. Eso **conserva el control de seguridad intacto** (el gate sigue existiendo y sigue comparando contra una wallet declarada de antemano) y solo lo vuelve manual.

**Los tres que NO se pueden recortar nunca**, porque recortarlos no es reducir alcance sino introducir una vulnerabilidad, y los tres están ya identificados en WKH-315 §7.3:
1. El gate de funding wallet (sin él, cualquier caller autenticado reclama el depósito de otro haciendo polling con `getSignaturesForAddress` sobre la ATA del treasury).
2. La de-duplicación por escritura condicional atómica (sin ella, un depósito se acredita N veces).
3. Acreditar solo sobre `finalized` (sin ello se acredita saldo gastable sobre un estado que puede revertir).

**Lo que NO es un corte aceptable**: shipear WKH-314 a medias para tener "las dos patas". Publicar `acceptsInboundPayment: true` sin verificación es un contrato público mintiendo, y su propia §7.3 ya lo descartó con el argumento correcto.

---

## 5. Qué NO deberíamos hacer

Un roadmap que no descarta nada no es un roadmap.

### 5.1 No hacer WKH-314 antes de M5

**Argumento**: Chaski no firma x402 (`gateway-client.ts:14`). Hacerla antes de M5 gasta la HU más cara del inventario, una L de dinero con **dos** preguntas indeterminables en vez de una (la cadena y el store de single-use, WKH-314 §3.5), en un camino que la demo no usa. Y no hay una versión chica honesta: su §7.3 ya descartó "solo el 402 intent" con el argumento correcto.

**No la cancelo**: es producto real, es la que permite que un tercero pague sin clave prepaga, y el work-item es de muy buena calidad. La ubico después de la Demo Day. Mientras no exista, `acceptsInboundPayment: false` sigue siendo la verdad publicada, así que **no queda nada a medias ni nada mintiendo**. Es la diferencia entre una pata faltante declarada y una pata a medias.

### 5.2 No hacer los dos esteroides antes de M5, y no hacer ninguno "por las puras"

**Argumento**: ninguno de los dos cierra un agujero del camino del dinero. La atestación del KYC cierra un salto de **confianza**; el oráculo de FX cierra un problema de **frescura y banda**. Los dos mejoran el agente de verdad, y por eso están en la lista y no descartados. Pero hacerlos mientras el rail de fondeo está a medio construir viola la regla del founder, que no es una preferencia.

**Recomendación concreta**: llevar **uno** de los dos a M6 como narrativa con diseño escrito y un prototipo de solo lectura si aparece holgura, y shipear el que sobreviva después del Demo Day. Si hay que elegir uno, la **atestación del KYC** tiene mejor relación demo/esfuerzo: es verificable en Solana Explorer en vivo, que es el formato que el mentor pidió.

### 5.3 No tocar el nombre del campo `contract` ni la etiqueta `avalanche` del catálogo ahora

**Argumento nuevo, con dato**: en producción, `payment.contract` de los dos agentes Solana vale `64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z`, que es la **billetera de cobro**, no el mint. El nombre es malo y confunde, y ya produjo un bloqueante rojo falso en este proyecto. Pero renombrarlo obliga a tocar `payment-spec-reader.ts`, que es **exactamente** el lector del que dependen WKH-316, WKH-317 y la resolución de chain de las dos HUs de dinero. Es el peor momento posible. **Confirmo el parkeo y agrego el argumento.**

### 5.4 No usar escrow para el fee por llamada

**Argumento cuantificado con dato de producción**: los precios reales del catálogo son `0.02` y `0.03` USDC (consulta de hoy). Un escrow Anchor para 3 centavos es desproporcionado por órdenes de magnitud y rompe interoperabilidad x402. Coincido con la decisión ya tomada: escrow para el principal de la remesa, nunca para el fee.

### 5.5 No "arreglar" el gate de reputación bajándolo en silencio

**Argumento**: la tentación, cuando se descubre §0.3 el 20 de agosto a las 11 de la noche, va a ser cambiar `PAYOUT_MIN_REPUTATION = 2` a `0` y seguir. El efecto inmediato es correcto y el control de seguridad no se pierde (`gateway-client.ts:26-28` lo dice). Pero hacerlo sin registrar la decisión deja el marketplace con un instrumento documentado que produce un resultado cerrado, que es la pregunta que WKH-313 plantea bien. **Que sea una decisión escrita (DEC-1), no un parche de madrugada.** Es la diferencia entre bajar un piso a propósito y quedarse sin piso sin darse cuenta.

### 5.6 No migrar nada a `caldz`, y no correr OPS-2 contra bdwv

Restricción del founder, la repito acá porque OPS-2 es justo el ítem donde alguien podría tomar el atajo: el gate de re-hidratación necesita un Postgres **descartable**. Correrlo contra bdwv es aplicar un ciclo `down -> up` sobre la base que tiene el ledger que las dos HUs de dinero van a usar.

---

## 6. Lo que NO pude determinar

Lo digo explícitamente en vez de rellenar.

1. **Si el flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` está flipeado en el Vercel de producción de Chaski.** Verifiqué la plantilla (`.env.example:138`, vacío) y el código que lo consume, no el valor real en el entorno de prod. Por eso OPS-4 está en la lista como ítem a confirmar, no como ítem a hacer a ciegas.
2. **Si `remit-kyc-validator` está siendo invocado hoy por Chaski como agente, o si Chaski va directo a Didit.** La evaluación profunda del 2026-07-24 dice que va directo y que `WKH-233` está bloqueada; WKH-314 §11.1 lo marca como hipótesis a confirmar con 5 días de antigüedad. **No lo verifiqué.** Importa porque si el KYC no pasa por el riel a2a, WKH-317 no alcanza para el claim de los 3 agentes.
3. **El estado real de la fila 189** (`fix/p1-discover-reputation-402-cap`). Lo tomo como dato heredado de WKH-314 §11.2 (abierta, F3 DONE + fix-pack pendiente de re-AR/CR/F4). Afecta el momento de merge de WKH-314, que ya no es camino crítico, así que el riesgo bajó.
4. **Si `a2a_key_deposits` tiene RLS habilitada.** Es el MI-7 de WKH-315, sigue abierto, y no lo resolví acá.
5. **Cuántos días hábiles reales hay disponibles.** Calculé 17 días hábiles de calendario; no sé la disponibilidad efectiva del founder ni si hay otros compromisos en esa ventana. Si son menos de 17, el §4.4 se activa antes.

---

## 7. Resumen de una línea por audiencia

- **Usuario final**: hoy el flujo insignia no puede entregar valor (§0.3) y cuando algo falla ve un solo cartel para cuatro problemas distintos (§2.5). Los ítems 2, 3 y 10 son los que lo convierten en un producto.
- **Agente final**: hoy un tercero que construye en Solana **no puede declarar que cobra en Solana** por la API pública (§2.1) y, si se publica, no puede ser elegido nunca si el caller pone piso (§0.3). Los ítems 3, 8 y 1 son los que lo convierten en una plataforma.
