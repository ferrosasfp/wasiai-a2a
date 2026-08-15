# WasiAI A2A — Batería de Q&A para el jurado (Kite Hackathon, 16-jun-2026)

> Preparado tras investigar a los jurados y la tesis de Kite. Las respuestas están alineadas con el deck HONESTO (testnet, "falta el listing"). No prometas nada que no podés mostrar.

## Quiénes juzgan y qué atacan

| Jurado | Perfil | Vector de ataque |
|--------|--------|------------------|
| **Scott Shi** — Co-founder & CTO | ex-Uber (infra AI real-time), founding eng. Salesforce Einstein, co-fundó RisingWave (streaming DB, $45M). UIUC. | Arquitectura, escala, seguridad, modelo de identidad 3 capas, x402/state-channels al detalle, **"¿por qué Kite no lo hace solo?"**, real vs demo. |
| **Stephen Allen** — Head Strategic Partnerships (Digital Assets & DeFi) | Lideró DeFi en Rari Chain, startup DeFi $8M TVL, CryptoMondays Europe. UK. | Regulación de remesas (MTL/AML), cómo **hacés crecer el ecosistema de Kite**, revenue/volumen real, GTM, ángulo DeFi, tokenomics. |

**Tesis de Kite (memorizar):** payments L1 para la economía agéntica. Identidad de 3 capas (root/user → delegated/agent → session keys). **SPACE**: Stablecoin-native · Programmable constraints · Agent-first auth · Compliance audit trails · Economical micropayments (state channels). x402 nativo (sub-cent, finality en ms). Hub de x402/AP2/MPP/MCP. $35M PayPal Ventures + General Catalyst. PYUSD. Pilots PayPal/Shopify.

**Posicionamiento de una línea:** *"Kite es la capa de pagos del agente; WasiAI es la capa de orquestación — descubrimos agentes en cualquier marketplace, los componemos en un pipeline y liquidamos el pago, cross-chain. Le traemos a Kite los agentes y el volumen, y extendemos sus agentes más allá de Kite."*

---

## 🔴 LAS 5 PREGUNTAS QUE PUEDEN HUNDIR EL PITCH (prepararlas en frío)

### K1 — Scott: "Kite ya tiene Passport, x402 y discovery. ¿Por qué existís? ¿No sos solo un wrapper? ¿Qué impide que Kite construya esto?"
**Respuesta:**
> "Kite es la capa de **rails** — identidad y settlement. Nosotros somos la capa de **orquestación encima de los rails**: descubrir el agente correcto en *cualquier* marketplace, componer varios en un pipeline con un solo intent, y liquidar el pago entre ellos. Kite no quiere construir cada app vertical encima de sí mismo — quiere apps que traigan agentes y volumen. Nosotros somos eso: un agregador que le trae demanda a Kite y que, además, **extiende los agentes de Kite cross-chain** (un agente con Passport contrata y paga agentes en Avalanche y Base sin salir de Kite). Analogía: Kite es Visa; nosotros somos el agregador de comercios + el Plaid de los agentes. Visa no construye cada comercio."
**Por qué funciona:** reposiciona de "wrapper" a "capa complementaria que trae volumen". Nunca digas "competimos con Kite".

### K2 — Scott: "Tu demo liquida un EIP-3009 transferWithAuthorization on-chain por paso. Eso NO es x402 de state channels. ¿Por qué? ¿No rompe la economía de micropagos?"
**Respuesta (honesta, convierte el golpe en 'por eso te necesitamos'):**
> "Correcto y es a propósito. Hoy implementamos x402 a nivel de protocolo (aceptamos el header X-PAYMENT) y liquidamos vía **EIP-3009 gasless** a través de nuestro facilitator — real, verificable en KiteScan. El budget del caller se descuenta **off-chain** (como una cuenta prepaga) y el neto liquida on-chain; no broadcasteamos cada micro-pago, que es exactamente el problema que resuelven los **state channels**. Para micropagos sub-cent de alta frecuencia, el x402 nativo de Kite con state channels es la primitiva correcta — y por eso queremos liquidar **a través de los rails de Kite**: nosotros traemos la orquestación, Kite trae la economía de micropagos. Integrar el x402 de state-channels es lo próximo, y es una de las razones por las que el listing importa."
**Clave:** sé preciso, no finjas. Esto demuestra que entendés x402 *de verdad* — Scott lo va a respetar.

### K3 — Stephen: "Remesas = transmisión de dinero. ¿Licencias MTL? ¿AML/KYC? No podés mover plata de gente así nomás."
**Respuesta:**
> "Exacto, por eso el primer agente del pipeline es un **KYC/AML validator** — el compliance está *dentro* de la orquestación, no es un afterthought. Nosotros no somos el money transmitter: somos la **capa de orquestación e infraestructura**; el settlement lo hace un partner regulado / el facilitator, y el agente de cumplimiento gatea cada flujo (políticas, tier del sender, AML). En testnet lo demostramos end-to-end. Para producción con dinero real, el modelo es operar vía un partner con licencia (BaaS/EMI) o el propio rail de Kite/PYUSD con PayPal — no reinventamos el compliance, lo orquestamos."
**Clave:** mostrá que el riesgo regulatorio ya está pensado y que el KYC agent es la prueba.

### K3b — Stephen: "¿Cómo hace WasiAI para *hacer crecer* el ecosistema de Kite, no extraer de él?"
**Respuesta:**
> "Tres formas concretas: (1) **Traemos agentes y volumen** — cada /compose u /orchestrate que ruteamos genera transacciones x402 en Kite. (2) **Extendemos el alcance de un agente Kite** — con su Passport puede contratar y pagar agentes en Avalanche y Base, así un agente de Kite vale más. (3) **Bajamos la barrera de entrada** — cualquier marketplace puede listar sus agentes y nosotros los hacemos descubribles/componibles, sin que cada uno re-implemente identidad y pago. Mientras más orquestamos, más se transacciona en Kite. Nuestro modelo (1% por pipeline on-chain) está alineado: ganamos cuando Kite transacciona."

### K4 — Scott: "Orquestás agentes externos que no construiste. Seguridad: SSRF, marketplaces envenenados en el discovery, prompt injection. ¿Cómo evitás un marketplace malicioso?"
**Respuesta:**
> "Es el riesgo central de ser una capa de orquestación y lo tratamos como tal: (1) **discovery con allowlist + validación de URL anti-SSRF** (categorizamos y bloqueamos targets internos/privados); (2) **auth EIP-712 / ownership guard** en cada query a datos sensibles (filtramos por owner, no confiamos en el id solo — evita IDOR); (3) **fail-closed** y circuit breakers por registry; (4) los **constraints del Passport** (límites de gasto, destinos aprobados) acotan el daño aunque un agente se porte mal. La identidad de 3 capas de Kite es justamente lo que hace esto seguro: la session key se revoca al instante."
**Clave:** nombrá las defensas reales (SSRF validator, ownership guard, fail-closed) — están en el código.

### K5 — Scott: "¿Qué está construido de verdad vs. demo? Dijiste 'falta un solo gate: el listing'. ¿Qué exactamente NO funciona end-to-end?"
**Respuesta (la honestidad es el arma):**
> "Construido y desplegado en testnet: identidad con Passport, aceptación del header x402, settlement on-chain vía nuestro facilitator (verificable en KiteScan), discovery + compose + orchestrate, 1.649 tests verdes. Lo que NO controlamos: el **allowlist de discovery de Kite** — el pago Passport en vivo end-to-end devuelve `payment_target_forbidden` hasta que nos listen. O sea: todo nuestro lado funciona; el último gate es vuestra decisión de listarnos. Eso es literalmente el ask del cierre."
**Clave:** convertir la limitación en el pedido. No esconder el gate — exhibirlo como el único faltante.

---

## A. Batería técnica (Scott Shi)

**A1. "¿Cómo usás el modelo de identidad de 3 capas (user/agent/session)?"**
> "El user mantiene la root key y los constraints (cuánto, a quién). El agente opera con una delegated key. Cada invocación en el pipeline usa una **session key efímera** — así, si componemos 3 agentes, cada paso firma con su propia session key revocable, sin exponer la del agente ni la del user. Es lo que hace seguro orquestar agentes que no son nuestros."

**A2. "Escala: si sos la capa de orquestación del 'agent economy', ¿dónde está el cuello de botella?"**
> "El gateway es stateless y horizontal; el discovery cachea y tiene circuit breakers por registry; el settlement lo absorbe Kite (state channels). El cuello de botella real es el settlement on-chain por-transacción — y por eso el x402 de state-channels de Kite es clave para escalar a millones de micropagos. Mi background es infra real-time (Uber/RisingWave) — esto está diseñado para fan-out."

**A3. "¿El cross-chain es real o aspiracional? ¿Cuál es el modelo de confianza entre cadenas?"**
> "Real en testnet: nuestro facilitator liquida EIP-3009 en Kite Ozone, Avalanche Fuji y Base Sepolia (`/supported` lo lista, las 3 sanas). No hay bridge de fondos cruzando cadenas — cada pago liquida nativamente en la red del agente destino; la coordinación la hace el gateway. El Passport es el ancla de identidad común. *(Nota honesta: las tx cross-chain del demo usan wallets de demo — el flujo cripto es idéntico al de prod.)*"

**A4. "¿Por qué un gateway centralizado? ¿No es un single point of failure contra la descentralización?"**
> "Hoy el gateway es un coordinador, no un custodio — no tiene los fondos, los constraints viven en el Passport del user y el settlement es on-chain. Es centralizado como lo es un DNS resolver: conveniente, reemplazable, y el estado de verdad (identidad, pago) está on-chain. El roadmap es múltiples gateways federados descubriendo de los mismos registries."

**A5. "¿Cuál es el problema técnico DIFÍCIL que resolvés?"**
> "Componer agentes que no confían entre sí, de marketplaces distintos, con pago atómico y cross-chain, sin que el user exponga su clave ni pierda el control del gasto. Discovery seguro (anti-SSRF, anti-poisoning) + orquestación + settlement, en una sola llamada. Ese es el laburo."

**A6. "¿Qué pasa si un agente del pipeline falla a mitad de camino? ¿Pagaste por nada?"**
> "Fail-closed: si un paso falla, no se libera el pago de los pasos siguientes; el budget se descuenta por paso completado. No hay 'pagué el pipeline entero y se rompió en el 2'."

## B. Batería de negocio / DeFi (Stephen Allen)

**B1. "Revenue: 1% por compose/orchestrate. ¿Quién paga? ¿Es sostenible?"**
> "Lo paga quien orquesta (el marketplace o la app que llama al pipeline), on-chain, automático. 1% sobre el valor orquestado. Cada US$1.000M orquestado = US$10M recurrentes. Ya está implementado — no es un 'algún día cobraremos'."

**B2. "GTM: ¿quién es tu primer cliente real? Chicken-and-egg de agentes vs demanda."**
> "Arrancamos del lado de la demanda con un caso vertical que duele: **remesas LATAM** (AgentShop). Eso fuerza a tener agentes reales (KYC, corridor, cashout) y genera transacciones desde el día uno. Después abrimos la capa a otros marketplaces. No esperamos a que el ecosistema exista — lo sembramos con un caso de uso con dolor real."

**B3. "¿Dónde está el DeFi? Esto parece remesas + orquestación."**
> "El DeFi es la capa de settlement y, sobre todo, el siguiente paso: agentes que ruteen no solo pagos sino **liquidez** — mejor corridor = mejor ruta de FX/stablecoin, que es ruteo DeFi. La infra de orquestación de pagos agente-a-agente ES la primitiva sobre la que corren estrategias DeFi agénticas (rebalanceo, market-making entre agentes). Remesas es el wedge; el ruteo de valor cross-chain es la plataforma."

**B4. "Traction real — los números de testnet no cuentan."**
> "Honesto: hoy es testnet, con settlement on-chain real y verificable (KiteScan). Lo defendible no es TVL inflado, es que **funciona end-to-end y está endurecido** (1.649 tests, SSRF, ownership guard, fail-closed). El gate a producción con volumen real es el listing + el partner de compliance. No vendemos vanity metrics."

**B5. "Competencia: el propio Kite, AP2 de Google, otros orquestadores. ¿Por qué vos?"**
> "Nadie hace los tres a la vez: **descubrir en cualquier marketplace + componer un pipeline + liquidar cross-chain**, agnóstico de protocolo. AP2 es un protocolo, no un orquestador. Kite es el rail. Los marketplaces venden 1 llamada de API; nosotros cobramos el pipeline completo. Somos la capa que los conecta a todos."

**B6. "¿Usan el token KITE? ¿Alineación con la red?"**
> "El settlement corre en los rails de Kite (x402, PYUSD sobre Kite Ozone). Cada pipeline que ruteamos es actividad on-chain en Kite. La alineación es directa: nuestro volumen es volumen de Kite. *(Si preguntan por tenencia/staking del token: 'abierto a alinear incentivos vía el token en el modelo de fees/listing'.)*"

**B7. "¿Por qué ahora?"**
> "Porque recién ahora existe el stack: identidad de agente (Passport), un standard de pago agente-a-agente (x402), y stablecoins con rails reales (PYUSD/PayPal). Hace un año no había sobre qué construir esto. La economía agéntica necesita una capa de orquestación, y la ventana es ahora."

## C. Rapid-fire (cualquiera de los dos)

- **"WasiAI en una frase."** → *"La capa de orquestación de la economía agéntica: descubrimos, componemos y pagamos agentes a través de marketplaces y cadenas — sobre los rails de Kite."*
- **"¿El ask?"** → *"Listáennos en su discovery, y el primer pago Passport liquida en vivo. Todo nuestro lado ya está construido."*
- **"¿Mayor riesgo?"** → *"Adopción del lado de los marketplaces. Lo atacamos sembrando con un caso vertical (remesas) que ya genera transacciones."*
- **"¿Equipo, por qué ustedes?"** → [bios reales del deck — fundador + perfil técnico].
- **"¿Y si Kite los copia?"** → *"Bienvenido — significaría que validamos la capa. Pero Kite es rails; construir la capa de orquestación cross-chain agnóstica de marketplace no es su core, y nosotros ya la tenemos corriendo."*

## D. Preguntas para DEVOLVER (cuando haya espacio)
- *"¿Qué necesitan ver para listar un orquestador en su discovery — qué gate técnico/compliance?"* (los compromete con un próximo paso)
- *"¿Cómo ven la composición multi-agente cross-chain en el roadmap de Kite — la construyen o la habilitan?"* (confirma que somos complemento, no competencia)

---

## Reglas de oro al responder
1. **Nunca digas que competís con Kite.** Sos capa complementaria que trae volumen.
2. **La honestidad es el arma:** "esto funciona, esto falta el listing, esto son wallets de demo". El jurado técnico huele el bullshit.
3. **Toda afirmación → con evidencia:** KiteScan, 1.649 tests, `/supported`, código.
4. **Convertí cada gotcha en un "por eso Kite importa"** (x402 state channels, micropagos, compliance partner).
5. **Cerrá siempre en el ask:** el listing.
