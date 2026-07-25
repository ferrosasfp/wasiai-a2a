# Milestone 2 🧱 · Business Foundation
### WasiAI A2A · Solana LATAM Labs Program (Waylearn)

> **Criterio de aceptación:** identificar la oportunidad de mercado + una métrica de validación específica para la incubación.

---

## 1. Value Proposition

**Para el usuario (Chaski):** "Mandá dólares digitales y que lleguen como soles a la cuenta de tu familia en Perú, más barato, en minutos, sin que nadie custodie tu plata."

**Para el ecosistema (WasiAI A2A):** "Una capa neutral para **descubrir, orquestar y pagar** agentes de IA en cualquier red y cualquier marketplace, sin construir tu propia infraestructura ni encerrarte en una blockchain."

El diferenciador defendible es el **stack A2A propio y neutral**: discovery (ERC-8004, cross-marketplace) + orquestación con IA + pago x402 + identidad + el **WasiAI Facilitator** (settlement multi-red). No dependemos de la infraestructura de un tercero: descubrimos, orquestamos, verificamos y aseguramos el pago nosotros, con una sola API. Cada leg liquida en la red que corresponde, los agentes cobran en Avalanche, Chaski entrega el valor en Solana.

---

## 2. Modelo de negocio

Dos fuentes de ingreso, alineadas a las dos capas:

| Capa | Cómo monetiza | Nota |
|------|---------------|------|
| **Plataforma (WasiAI A2A)** | **Take-rate** sobre cada settlement de agente que pasa por la capa (marketplace + facilitator): fee por transacción de orquestación/pago / suscripción para marketplaces y proveedores de alto volumen | Escala con el volumen del ecosistema de agentes, no solo de Chaski |
| **Wedge (Chaski)** | **Margen sobre la remesa**: un spread transparente en la conversión USDC→PEN | WasiAI gana en la remesa (el spread) **además** del fee de orquestación de la plataforma. TransFi, como partner licenciado, cobra su parte del off-ramp; nuestro margen va por encima de ese costo. |

**Sostenibilidad:** el costo marginal por remesa es bajísimo (fees Solana de centavos + la verificación es compute barato). El margen viene del spread y del take-rate, no de custodiar float. Al ser no-custodial, **no cargamos con riesgo de custodia ni de tesorería.**

**Racional de la estructura de partners (evita el long-pole regulatorio):** los legs regulados (KYC/AML, off-ramp fiat) los ejecutan **partners licenciados** (Didit para KYC, TransFi como PSAV para el payout). WasiAI opera como capa de orquestación/tech, no como *money transmitter*, lo que reduce dramáticamente el costo y el tiempo de compliance para arrancar.

**Canal de distribución (go-to-market, dos capas):**
- **WasiAI A2A** se distribuye B2B2C por **integración**: se embebe como rieles (discovery + orquestación + pago x402) en marketplaces, wallets y fintechs, con CAC casi nulo apalancando la base del partner.
- **Chaski** es el canal **directo al consumidor**: la **App (PWA)** es el núcleo del movimiento de dinero (KYC + firma de wallet + escrow); encima corren dos superficies conversacionales, un **Telegram Mini App** para el remitente cripto-nativo (hostea el flujo con wallet-connect) y **WhatsApp** para el receptor y la captación en comunidades migrantes (notificación de llegada, recibo, re-envío). El movimiento regulado corre siempre por la App/Mini App; el chat acerca al usuario y avisa. El volumen de Chaski es la prueba viva que vende las integraciones de WasiAI (flywheel de dos lados).

---

## 3. Oportunidad de mercado

- **Remesas a LATAM:** mercado de decenas de miles de millones de USD/año, con costo promedio ~6% y fricción alta. Perú es un corredor concreto y accesible (bancarización + billeteras masivas como Yape/Plin; hoy la entrega es por transferencia bancaria/CCI).
- **Stablecoins como riel:** el volumen de pagos con stablecoins crece fuerte; el usuario cripto-nativo que quiere "bajar a fiat" para su familia es un wedge real y creciente.
- **Economía de agentes (la apuesta grande):** a medida que los agentes de IA transaccionan entre sí, la capa de pagos+verificación neutral es infraestructura crítica, un mercado que hoy se está definiendo y que se fragmenta en walled gardens (oportunidad para el jugador neutral).

**Corredor inicial:** salida USDC (Solana) → Perú (PEN, transferencia bancaria/CCI; Yape/Plin en roadmap). Un corredor, foco absoluto.

---

## 4. Análisis de competidores

| Competidor | Qué hace | Cómo nos diferenciamos |
|------------|----------|------------------------|
| **Félix Pago** | Remesas cripto→fiat vía WhatsApp (US→LATAM) | Ellos son el producto de remesa; nosotros somos **la capa** + un producto encima. No-custodial y multi-red por diseño; abrimos la infra a otros. |
| **Koywe** | On/off-ramp + infra de stablecoins LATAM | Solapamiento en el off-ramp, pero nuestro diferencial es la **capa de verificación de pagos entre agentes** (no solo ramp). Podrían ser incluso partner. |
| **TransFi** | Off-ramp/payout global (nuestro **partner**, no competidor) | Los usamos como el leg licenciado; no competimos con su rail. |
| **OKX.AI y capas de agentes de exchanges** | Capa de pagos agéntica con backing de exchange | Ellos son *walled gardens* (cadena/token propios). Nuestro pitch: **neutral, abierto, multi-red, LATAM-first**: sin lock-in. |
| **Remesas tradicionales** (WU, bancos) | Corredor fiat clásico | Más caro (~6%), más lento, custodial. |

**Posicionamiento:** el **terreno neutral**. Mientras cada exchange arma su jardín cerrado, WasiAI liquida en la red de cada quien y verifica de forma estándar.

---

## 5. Hipótesis de mercado

- **H1 (dolor):** existe un remitente cripto-nativo que hoy no tiene una vía simple/barata/no-custodial para que su familia reciba soles en su cuenta en Perú.
- **H2 (disposición):** ese usuario prefiere una remesa no-custodial y más barata aunque implique un paso de KYC.
- **H3 (plataforma):** el modelo de "capa neutral verificable" es reutilizable más allá de Chaski (otros agentes/proveedores lo querrían).

---

## 6. Métrica de validación (para la incubación) · **CONFIRMADA**

**Señal concreta:**
> Conseguir **≥5 remitentes reales** (cripto-nativos con familia en Perú) que, tras ver el flujo Chaski, confirmen (a) que es un dolor real y (b) intención de usarlo, y **≥1 completar la remesa e2e en sandbox/devnet** de punta a punta.

Métrica cuantitativa de respaldo: de las 5-10 entrevistas de M4, **% que confirma el problema** + **% que expresa intención de uso**. Umbral de éxito: ≥70% confirma el dolor, ≥40% intención de uso.

---

*Sprint S0 (catch-up). Milestone 2 del Solana LATAM Labs. Entregable → carpeta Drive. Jira: WKH-198.*