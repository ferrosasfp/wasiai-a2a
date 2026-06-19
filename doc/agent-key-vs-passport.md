# Agent Key vs Kite Passport — análisis de robustez (2026-06-15)

> Investigación post-hackathon. Objetivo: identificar qué tiene el **Kite Agent Passport** que nuestra **WasiAI Agent Key** podría adoptar para ser más robusta, y crear las HU. **No implementa nada** — es research + backlog.
> Fuentes: https://docs.gokite.ai/ + revisión del código (`src/services/identity.ts`, `src/types/a2a-key.ts`, `src/services/budget.ts`).

## Qué tiene el Kite Passport (investigado)
| Capacidad | Detalle |
|---|---|
| **Jerarquía de 3 capas** | user (root, fondos compartidos) → agent (delegada, por agente) → **session** (time-boxed, con sus propias reglas y cuotas). |
| **"Una sesión, una firma"** | Aprobás una sesión una vez; el agente transacciona dentro de los límites sin volver a firmar cada transacción. |
| **Claves efímeras + DIDs** | Session keys efímeras; identificadores descentralizados (DID) atan la sesión; el agente prueba autorización **sin revelar la identidad del usuario**. |
| **Revocación instantánea** | Se revoca una sesión al instante, sin tocar la clave del agente ni del usuario. |
| **Constraints programables** | Reglas de gasto que definís: límites, cuotas por sesión, destinos autorizados. |
| **Recibos inmutables + proof-chain** | Cada pago deja recibo inmutable anclado on-chain; trazabilidad completa session → agent → user; cadena de prueba para resolución de disputas (Proof of AI). |
| **Wallet no-custodial + passkey** | Wallet fondeada que controlás; aprobación de sesión con passkey. |

## Qué tiene HOY nuestra Agent Key (en el código)
| Capacidad | Estado |
|---|---|
| Identidad | ✅ `key_hash` (sha256, bearer) + **ERC-8004** on-chain (`erc8004_identity`) + binding opcional al Passport. |
| Budget | ✅ por red (`budget` JSONB, ej. `{"2368":"10.00"}`). |
| Límites de gasto | ✅ `daily_limit_usd` + `daily_spent_usd`/reset + `max_spend_per_call_usd`. |
| Allowlists | ✅ `allowed_registries`, `allowed_agent_slugs`, `allowed_categories`. |
| Reputación | ✅ vía ERC-8004. |
| Revocación | ⚠️ solo `deactivate(keyId)` — apaga **toda** la key (todo o nada). |
| **Session keys / jerarquía** | ❌ NO existe. La key es un bearer token único y de larga vida. |
| **Auth por firma / passkey** | ❌ NO. Es un secreto bearer (sha256); si se filtra, se usa directo. |
| **Recibos inmutables + proof-chain** | ❌ NO. Hay eventos + settlement on-chain, pero no una cadena de prueba session→agent→user para disputas. |
| **Constraints por destino/velocidad** | ⚠️ parcial. Hay daily + per-call + allowlists, pero no cap por vendor/destino ni ventanas de tiempo arbitrarias. |

## Gap analysis — qué adoptar (orden de impacto)
1. **Jerarquía + session keys** (el gap más grande): hoy una key filtrada = acceso total hasta que se desactive. El Passport acota el daño con sesiones efímeras time-boxed. → **WKH-121**
2. **Revocación granular**: revocar una sesión/scope, no toda la key. → **WKH-122**
3. **Auth por firma / passkey**: un bearer secreto es el punto débil; firma por request o passkey hace que una key filtrada no sea usable sola. → **WKH-123**
4. **Recibos inmutables + proof-chain (PoAI-style)**: trazabilidad session→agent→user para disputas. → **WKH-124**
5. **Constraints programables más ricas**: cap por destino/vendor + velocidad/ventana de tiempo. → **WKH-125**

> Las HU completas quedaron en `BACKLOG.md` (épica E16). Todas son ruta QUALITY (tocan identidad/pago). Estimación total: grande; priorizar WKH-121 (session keys) + WKH-123 (firma) primero — son los de mayor impacto en robustez/seguridad.

## Nota estratégica
Esto NO contradice el pitch ("usamos Passport + Agent Key abierta"). Al revés: **acerca la Agent Key a la robustez del Passport pero manteniéndola cross-chain y agnóstica** (ERC-8004), que es nuestro moat de neutralidad. Es "lo mejor del Passport, sin atarnos a una sola red".
