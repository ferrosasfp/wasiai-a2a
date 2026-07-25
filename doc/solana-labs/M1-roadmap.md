# Milestone 1 🧭 · Roadmap de Producto
### WasiAI A2A · Solana LATAM Labs Program (Waylearn)

> **Criterio de aceptación:** explicar con claridad *qué* construimos, *para quién* y *por qué Solana es relevante.*

---

## 1. En una frase

**WasiAI A2A es el protocolo neutral para la economía de agentes de IA, descubrir, orquestar y pagar agentes autónomos entre marketplaces y redes. Nuestra aplicación insignia, Chaski, usa esa plataforma para componer una remesa real y entregar el valor, dólares digitales que llegan como soles a la cuenta bancaria de una familia en Perú (transferencia interbancaria vía CCI), liquidando sobre Solana.**

Dos cosas que encajan como plataforma + killer app:
- **La plataforma (WasiAI A2A):** un stack neutral y multi-red, *discovery, orquestación, traducción IA, pago (x402) e identidad*, que deja que cualquier app descubra agentes verificados, los orqueste con IA y les pague, sin lock-in de cadena ni de marketplace.
- **La app insignia (Chaski):** una remesa cripto→fiat no-custodial que **compone agentes** de la plataforma (KYC, corredor/FX, payout) y **entrega el valor sobre Solana**, en un dolor real y masivo de LATAM.

---

## 2. El problema (dos, uno adentro del otro)

**Para el usuario final (Chaski):** mandar dinero a casa en LATAM es caro (~6% promedio), lento y opaco. Millones ya tienen USDC, pero no hay una forma simple, barata y **no-custodial** de convertirlo en soles y que llegue a la cuenta bancaria de su familia.

**Para el ecosistema (WasiAI):** la economía de agentes de IA se está fragmentando en *walled gardens*, cada exchange/marketplace encerrado en su cadena y su token. Falta una **capa neutral** que permita:
- **Descubrir** agentes verificados entre marketplaces (identidad ERC-8004),
- **Orquestar/componer** varios agentes para un objetivo complejo (traducción IA entre protocolos heterogéneos),
- **Pagarles** de forma verificable (x402), cada uno en su red nativa, con topes y seguridad fail-closed,
- y hacer todo esto **multi-red**, sin obligar a nadie a una sola cadena.

Chaski es la prueba viva de esa capa: un objetivo en lenguaje natural ("mandá plata a mi familia en Perú") que se resuelve descubriendo y orquestando agentes reales.

---

## 3. Para quién

**Usuario del MVP (el que validamos y demostramos), Chaski:**
- **Remitente:** persona cripto-nativa en el exterior (tiene USDC) que manda a su familia en Perú.
- **Receptor:** familiar en Perú que recibe **soles en su cuenta bancaria** (transferencia interbancaria vía **CCI**), sin saber nada de cripto. *(Yape/Plin: roadmap, hoy TransFi entrega por transferencia bancaria.)*

**Usuario de la plataforma (la visión, WasiAI A2A):**
- **Desarrolladores de agentes y marketplaces** que quieren publicar/descubrir/orquestar/cobrar agentes sin construir su propia infra. Chaski es el primer consumidor de la capa; otros marketplaces y apps pueden consumirla.

> **Disciplina de foco:** validamos y demostramos **UN** flujo (la remesa Chaski) con **UNA** cohorte real. La plataforma es el "por qué es grande"; la remesa es el "qué funciona hoy".

---

## 4. Qué construimos · el ecosistema (arquitectura híbrida multi-red)

```
   Objetivo en lenguaje natural  ─▶  WasiAI A2A (protocolo neutral)
                                     ├─ Discovery (ERC-8004, cross-marketplace)
                                     ├─ Orquestación/Composición (traducción IA)
                                     ├─ Identidad (Agent Key / Passport)
                                     └─ Pago x402 (WasiAI Facilitator, multi-red)
                                            │
        ┌───────────────────────────────────┴────────────────────────────┐
        ▼                                                                  ▼
  Marketplace WasiAI (app.wasiai.io, Avalanche)                    Chaski (app sobre la capa)
  · agentes publicados, descubiertos, orquestados                 · compone KYC + corredor + payout
  · cobran su FEE en su red nativa (Avalanche)                    · ENTREGA EL VALOR sobre SOLANA
```

**Dos flujos de dinero, cada uno en la red que corresponde (la tesis neutral en acción):**
1. **Fees de los agentes** (descubrir/orquestar/pagar los agentes KYC + FX + payout): montos chicos, liquidan en la red nativa de cada agente → **marketplace WasiAI en Avalanche** (lo existente).
2. **El principal de la remesa** (los dólares que se convierten en soles): la **entrega de valor real**, no-custodial → **sobre Solana**, verificado por el WasiAI Facilitator (que gana un adaptador Solana → multi-red de verdad).

---

## 5. Features core del MVP (Chaski sobre la plataforma)

1. **Onboarding + KYC/AML real** del remitente (partner licenciado: Didit).
2. **Descubrimiento + orquestación** de los agentes de la remesa vía la capa A2A (agentes en el marketplace Avalanche): corredor/FX (quote real TransFi) + payout.
3. **Pago de los agentes** (fees) vía x402 en su red nativa.
4. **Conexión de wallet Solana** (Phantom / wallet-standard).
5. **Entrega de valor no-custodial sobre Solana:** WasiAI emite la intención (402) → la wallet del remitente **firma y deposita** el USDC (SPL) en un **escrow on-chain trustless** (programa Anchor, repo `solana-programs`), con `reference` estilo Solana Pay. El `release` al partner lo dispara la verificación del facilitator (tras KYC + orden) y el `refund` queda disponible para el remitente si el off-ramp falla. El dinero **nunca** pasa por una custodia humana: lo controla el programa.
6. **Verificación + estandarización** por el WasiAI Facilitator (adaptador Solana): reference, firma, mint, monto, destinatario, confirmación; anti-doble-gasto; auditoría.
7. **Off-ramp real:** el partner convierte USDC→PEN y **transfiere a la cuenta bancaria del receptor (CCI)**.
8. **Reconciliación** end-to-end.

**Interfaz y canales:** el core del movimiento de dinero vive en la **App (PWA)** (KYC + firma de wallet + escrow). Encima, dos superficies conversacionales como canal directo al consumidor: un **Telegram Mini App** para el remitente cripto-nativo (hostea el flujo con wallet-connect) y **WhatsApp** para el receptor y la captación en comunidades migrantes (notificación de llegada, recibo, re-envío). La arquitectura hexagonal hace de cada canal un adapter de presentación sobre el mismo core, sin reescribirlo.

**En la incubación: Solana devnet + sandboxes de partners = cero plata real.** El piloto con plata real es post-programa.

---

## 6. Por qué Solana es relevante (para la entrega de valor)

Solana es **la mejor red para el leg más importante y visible: la entrega del valor de la remesa.**

- **USDC nativo** (Circle), sin puentes en el camino del dinero.
- **Fees de centavos**: determinante en remesas de margen fino; en cadenas con gas más caro puede comerse el margen.
- **Confirmación sub-segundo**: se siente como una app de pagos, no como "esperar la blockchain".
- **Solana Pay**: estándar nativo de payment/transfer requests con `reference` único, hecho a medida para "pagá esto" verificable; encaja perfecto con nuestro modelo intención-402 + verificación.
- **Adopción LATAM + partners**: tracción real en pagos/stablecoins; TransFi soporta USDC nativo en Solana (USDCSOL).
- **Refuerza la tesis neutral, no la contradice**: WasiAI liquida en la red de cada quien: los agentes cobran en Avalanche, el valor se entrega en Solana. Sumar Solana como red de settlement de primera clase (con adaptador en nuestro facilitator) es multi-chain de verdad.

---

## 7. Entregables finales (para Demo Day)

- **Demo funcional en vivo:** objetivo en NL → WasiAI descubre + orquesta los agentes (marketplace Avalanche) → Chaski entrega el valor sobre Solana devnet → "PEN entregado".
- **Transacción Solana verificable** en Solana Explorer (devnet) por cada demo.
- **Repositorios** (open source, MIT): `wasiai-a2a` (protocolo/cerebro) · `wasiai-facilitator` (pago multi-red) · `chaski-v3` (app insignia) · `wasiai-remittance-agents` (agentes) · `solana-programs` (escrow Anchor).
- **Resumen de validación** con usuarios reales (M4).
- **Pitch deck** (8-10 slides) + guion de 3 min (M6).

---

## 8. Qué NO es (scope-out, honestidad)

- **No** es solo el facilitator: es el stack A2A completo (discovery + orquestación + traducción IA + pago + identidad). El marketplace de agentes ya está vivo en Avalanche.
- **No** movemos plata real durante la incubación (Solana devnet + sandboxes). Piloto real = post-programa.
- **No** somos *money transmitter*: los legs regulados (KYC/AML, off-ramp fiat) los ejecutan **partners licenciados** vía API. WasiAI es la capa de orquestación/tech.
- **No** rebuildeamos desde cero: la plataforma A2A ya está construida y viva; agregamos Solana como **red de entrega de valor** para Chaski, con arquitectura no-custodial de calidad de producción.

---

*Sprint S0 (catch-up). Milestone 1 del Solana LATAM Labs. Entregable → carpeta Drive. Jira: WKH-197.*