# Plan de ataque — mejoras wasiai-a2a (derivado del análisis OKX.AI)

Fecha: 2026-07-03. Deriva de `doc/competitive/okx-ai-analysis-2026-07.md`. Roadmap en Jira: **WKH-132 → WKH-141** (label `okx-competitive`).

## Las 10 HUs

| HU | Prioridad | Título | Esfuerzo |
|----|-----------|--------|----------|
| WKH-132 | P0 | Transparencia de fee | S |
| WKH-133 | P0 | Reputation write-back a ERC-8004 | M |
| WKH-134 | P0 | SDK + publish self-serve de 1 agente | M |
| WKH-135 | P1 | Intents de pago `session` + `upto` | M/L |
| WKH-136 | P1 | Splits atómicos (bps) | M |
| WKH-137 | P1 | Pagos IM-native + QR (WhatsApp/Telegram) | L |
| WKH-138 | P1 | Embedded wallet + gasless Avalanche/Base | L |
| WKH-139 | P2 | Dispute/escrow real | M/L |
| WKH-140 | P2 | Task marketplace (→ wasiai-v2) | L |
| WKH-141 | Strategic | Bridge APP-compatible | L |

## Secuencia por olas

### Wave 0 — Quick wins (credibilidad + adopción) · P0
**WKH-132 · WKH-133 · WKH-134** — independientes, casi en paralelo.
Baratas, alto ROI, y **refuerzan el pitch del grant Avalanche** (fee transparente + reputación on-chain real + SDK que baja la barrera de adopción). Cero dependencias. **Se arranca por acá.**

### Wave 1 — Cerrar el gap de producto más grande · P1
**WKH-135 (intents session/upto) → WKH-136 (splits)**
Donde OKX está genuinamente adelante. Intents primero (money-path, AR obligatorio), luego splits (mismo path de settlement). WKH-135 desbloquea el bridge APP (WKH-141).

### Wave 2 — Diferenciadores LATAM (ownear la vertical) · P1
**WKH-137 (IM/QR) + WKH-138 (embedded wallet + gasless)**
La experiencia sin fricción para remesas LATAM (Chaski). Mayor payoff en el nicho donde los gigantes no enfocan. Esfuerzo L, van después del core de pagos.

### Wave 3 — Confianza + interop · P2/Strategic
**WKH-139 (dispute/escrow) + WKH-141 (bridge APP)**
WKH-139 = leapfrog (OKX promete "staked evaluators" sin especificar; shippeamos algo real). WKH-141 = neutralidad concreta (hablar el protocolo de OKX); depende de WKH-135. **WKH-140 (task marketplace)**: para wasiai-v2, no el gateway; prioridad baja.

## Notas de ejecución
- **Ruta rápida al grant**: Wave 0 refuerza directamente el material del grant Avalanche.
- **Pipeline**: money-path (135/136/139) por QUALITY con AR/CR obligatorio; las P0 simples (fee) por FAST/FAST+AR (Smart Sizing del analyst decide).
- **Realismo**: 10 HUs con varias L = trabajo de varios sprints; por olas, no todo junto.
- **Dependencias**: WKH-141 ← WKH-135. WKH-137/138 se complementan. WKH-139 ← escrow (WKH-126, staged).
