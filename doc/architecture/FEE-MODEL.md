# WasiAI — Modelo de Fee y Splits (fuente de verdad)

> Estado: vivo en testnet (2026-07-04). Este documento es la **fuente canónica** de cómo
> fluye la plata en una orquestación/composición de WasiAI. Cualquier claim de economía
> en README, pitch, landing o decks debe ser consistente con esto.

## TL;DR

En un `/orchestrate` o `/compose` con N agentes hay **dos flujos de plata separados**:

1. **Pago del servicio** — cada uno de los N agentes cobra **su propio precio** (`stepPrice_i`)
   por el trabajo que hace. Esto NO es un porcentaje: es el precio completo que ese agente
   fijó. Los N agentes que trabajan cobran los N.
2. **Fee de protocolo (1%)** — arriba de los pagos de servicio, WasiAI cobra **1% sobre el
   total, una sola vez**. Ese 1% es el ingreso de WasiAI, y es lo que se **reparte** (el "split").

**El split reparte el fee del 1%, no el pago total.**

## El fee de protocolo

- Env: `PROTOCOL_FEE_RATE` — leído por request, default **0.01 (1%)**, con guard de rango
  `[0.0, 0.10]` y fallback 0.01. (`src/services/fee-charge.ts`)
- Se cobra **una vez** sobre el costo total del pipeline (`feeBaseUsdc × feeRate`), hacia
  `WASIAI_PROTOCOL_FEE_WALLET`. Si esa wallet está vacía → skip silencioso (no se cobra fee).
- El caller paga: `sum(stepPrice_i) × (1 + PROTOCOL_FEE_RATE)`.

## El split (reparto del fee del 1%)

El 1% se subdivide en **tres patas** vía env (bps, deben **sumar 10000 = 100% del fee**;
Σ≠10000 → fail-closed). (`src/config/split-config.ts`, `src/services/fee-split.ts`)

| Env var | Pata | Config prod actual |
|---------|------|--------------------|
| `SPLIT_BPS_PLATFORM` | Plataforma (WasiAI: infra, LLM del planner, gas overhead, facilitator) | **8000 (80%)** |
| `SPLIT_BPS_CREATOR` | Creador del agente | **1500 (15%)** |
| `SPLIT_BPS_REFERRAL` | Referidor | **500 (5%)** |

- **Default `10000/0/0`** (todo a plataforma) → byte-idéntico, sin split.
- Config **per-request por env, sin migración** → se ajusta en segundos.

### ¿Quién es el "creator" y el "referral"? — Decisión de diseño

El split se resuelve sobre el **agente primario del pipeline (`steps[0].agent`)**, NO sobre
los N agentes. (`src/routes/compose.ts:585`, `src/services/orchestrate.ts`,
`src/services/agent-split-context.ts`)

- **Creator** = el `payout_wallet` que el **creador del agente primario** declaró al publicar
  (WKH-143b). Solo el creador del primer agente del pipeline recibe la pata de creator.
- **Referral** = el agente al que apunta el `referrer_ref` del agente primario — se resuelve
  al `payout_wallet` de **ese** agente (Opción B: `referrer_ref` = slug de otro agente
  publicado; WKH-143c).

**Los N−1 agentes restantes cobran su precio de servicio (flujo 1), pero NO reciben pata de
creator del split.** Es una decisión de diseño consciente (el punto de entrada de la
orquestación se lleva el bonus del split), ratificada 2026-07-04. Alternativa futura no
planificada: prorratear la pata de creator entre todos los agentes por `stepPrice`.

### Fail-safe (importante para leer la economía honestamente)

- Si el agente primario **no declaró** `payout_wallet` → la pata de creator **se re-rutea a
  plataforma** (SG-6). Igual para referral sin resolver.
- Por eso, **hoy en testnet** —donde casi ningún agente declaró wallet— el fee sigue yendo
  ~100% a plataforma. Setear el split **prende el mecanismo y señaliza el modelo**, pero no
  mueve plata a creators/referrers hasta que haya adopción (agentes con wallet declarada).

## Ejemplo trabajado (orquestación de 3 agentes)

Agentes A=$50, B=$30, C=$20. Fee 1%. Split `8000/1500/500`.

| Concepto | Monto | Destino |
|----------|-------|---------|
| Precio de A | $50.00 | agente A (`payTo`) |
| Precio de B | $30.00 | agente B |
| Precio de C | $20.00 | agente C |
| **Fee de protocolo (1% de $100)** | **$1.00** | se reparte ↓ |
| — plataforma 80% | $0.80 | WasiAI |
| — creator 15% | $0.15 | creador de **A** (el primario) — si declaró wallet, sino → plataforma |
| — referral 5% | $0.05 | referrer de **A** — si resuelve, sino → plataforma |
| **Total que paga el caller** | **$101.00** | |

## Por qué este diseño

- **Creator split** → incentiva la **oferta**: devs ganan cuando su agente se usa (flywheel).
- **Referral split** → incentiva la **distribución**: agentes/marketplaces que refieren tráfico.
- **Plataforma** → cubre los costos reales de WasiAI (LLM del planner, gas overhead, infra).

**Restricción económica honesta:** el fee es fino (1%) y en mainnet el gas puede superarlo
(por eso existe `STEP_GAS_OVERHEAD_USD`). El split reparte un 1% fino → los montos absolutos
de creator/referral son chicos. La palanca real para que un creator gane de verdad no es
repartir el 1%, es **subir el fee base** cuando el valor lo justifique. Hoy el valor del split
es señalizar el modelo + alinear incentivos + probar la mecánica.

## Trazabilidad (HUs)

- **WKH-44 / WKH-118** — fee de protocolo 1% en `/orchestrate` y `/compose`.
- **WKH-136** — engine de splits atómico (bps, Σ=10000 fail-closed).
- **WKH-143** — cablear el seam del creator (resolver `steps[0].agent`).
- **WKH-143b** — write-path: capturar `payout_wallet`/`referrer_ref` al publicar.
- **WKH-143c** — activar referral (Opción B: `referrer_ref` = slug de otro agente).

## Config de referencia (env)

```
PROTOCOL_FEE_RATE=0.01           # 1% (default; rango [0, 0.10])
WASIAI_PROTOCOL_FEE_WALLET=0x…   # destino del fee; vacío → no se cobra fee
SPLIT_BPS_PLATFORM=8000          # 80% del fee
SPLIT_BPS_CREATOR=1500           # 15% (solo agente primario, si declaró payout_wallet)
SPLIT_BPS_REFERRAL=500           # 5%  (referrer del primario, si resuelve)
# Σ SPLIT_BPS_* = 10000 obligatorio (fail-closed). Default 10000/0/0 = todo a plataforma.
```
