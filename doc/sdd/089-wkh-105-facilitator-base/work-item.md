# Work Item — [WKH-105] BASE-02 · wasiai-facilitator: Base RPC support + tests

## Resumen

Agregar soporte de Base Sepolia (chainId 84532) y Base Mainnet (chainId 8453) al self-hosted facilitator `wasiai-facilitator`, siguiendo el patrón chain-adaptive ya documentado en `doc/architecture/CHAIN-ADAPTIVE.md`. Los endpoints `/verify` y `/settle` deben aceptar payloads `network: eip155:84532` y `eip155:8453` sin romper el comportamiento existente de Avalanche y Kite. La implementación vive en el repo separado `/home/ferdev/.openclaw/workspace/wasiai-facilitator/` — este work-item reside en wasiai-a2a únicamente como artefacto de proceso.

**Para quién:** Agent Developers y Marketplace Operators institucionales (Bankaool, Arkangeles, CNBV) que necesitan settlement self-hosted en Base sin depender de Coinbase CDP.

**Por qué:** Base es la segunda chain crítica del Epic WKH-103 (BASE port). Sin esta HU, BASE-01 solo puede usar el CDP Facilitator de Coinbase como fallback, eliminando el diferenciador self-hosted para el segmento LATAM institucional.

---

## Sizing

- **SDD_MODE:** mini
- **Estimación:** M
- **Pipeline:** FAST+AR (toca payment path = alto riesgo; scope acotado, patrón chain-adaptive ya existe)
- **Branch sugerido:** `feat/base-support` en el repo `wasiai-facilitator` (NO en wasiai-a2a)
- **Esfuerzo estimado:** ~8h (config 3h, tests E2E Sepolia 2h, deploy Railway + smoke 2h, README 1h)

---

## Acceptance Criteria (EARS)

- **AC-1:** WHEN `POST /verify` recibe `{ network: "eip155:84532", payload }` con firma EIP-3009 válida, the system SHALL retornar `{ verified: true, client, amount }` habiendo recuperado la dirección contra el contrato USDC Base Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`).

- **AC-2:** WHEN `POST /settle` recibe el mismo payload verificado en Base Sepolia, the system SHALL ejecutar `transferWithAuthorization` on-chain y retornar `{ settled: true, transactionHash, blockNumber }` con tx hash verificable en Basescan Sepolia (`https://sepolia.basescan.org`).

- **AC-3:** IF la RPC de Base (`BASE_SEPOLIA_RPC_URL` o `BASE_MAINNET_RPC_URL`) no responde o retorna error de red, THEN the system SHALL retornar HTTP 503 con body `{ error_code: "NETWORK_UNAVAILABLE", message: "Base RPC unavailable" }` — NO 500 ni panic.

- **AC-4:** WHEN `GET /supported` es invocado con `BASE_SEPOLIA_ENABLED=true`, the system SHALL incluir `{ "x402Version": 2, "scheme": "exact", "network": "eip155:84532" }` en el array `kinds`.

- **AC-5:** WHERE `BASE_SEPOLIA_ENABLED` env var está seteada en `false` o ausente, the system SHALL NO listar ni aceptar requests de `eip155:84532`, retornando HTTP 400 `{ error_code: "NETWORK_MISMATCH" }` si se intenta usarla.

- **AC-6:** WHEN los tests de integración existentes son ejecutados post-implementación, the system SHALL mantener el 100% de pass rate en suites previas de Avalanche y Kite — ningún test existente puede ser eliminado ni marcado `.skip`.

- **AC-7:** WHEN se ejecuta el smoke test E2E contra Base Sepolia, the system SHALL producir al menos 1 `transactionHash` verificable en Basescan Sepolia con status `Success`, documentado en el `done-report.md` de esta HU.

---

## Scope IN

En repo `wasiai-facilitator` (`/home/ferdev/.openclaw/workspace/wasiai-facilitator/`):

| Archivo | Acción |
|---------|--------|
| `src/chains/base-sepolia.ts` | Crear — ChainConfig con USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `src/chains/base-mainnet.ts` | Crear — ChainConfig con USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `src/chains/registry.ts` | Modificar — importar y registrar `base-sepolia` y `base-mainnet`, con guard por env var |
| `src/__tests__/chains/base-sepolia.test.ts` | Crear — test de integración verify+settle en Sepolia |
| `.env.example` | Modificar — agregar `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL`, `BASE_SEPOLIA_ENABLED`, `BASE_MAINNET_ENABLED` |
| `README.md` | Modificar — agregar sección "Supported Networks: Base" |
| Railway env vars | Agregar variables Base (después de validación local) |

---

## Scope OUT

- NO tocar `src/core/`, `src/methods/`, `src/routes/` — el patrón chain-adaptive garantiza zero cambios en core
- NO modificar wasiai-a2a (ese es el scope de BASE-01, WKH-104)
- NO implementar Smart Wallet sponsoring ni paymaster (BASE-06)
- NO cambiar el shape del envelope x402 v2 (mantener compat Avalanche y Kite)
- NO deployar en Base Mainnet hasta que Sepolia esté validado y Fernando lo apruebe explícitamente
- NO meter private keys ni wallets de mainnet en entornos locales o de staging

---

## Decisiones técnicas (DT-N)

- **DT-1: RPC selection per chain via env var con fallback público.** `BASE_SEPOLIA_RPC_URL` en Railway. Si no está seteada, usar el RPC público de viem/chains (`baseSepolia.rpcUrls.default.http[0]`). Justificación: consistencia con patrón ya documentado en `CHAIN-ADAPTIVE.md` (exactamente el ejemplo del doc con `??` operator).

- **DT-2: Enable/disable per chain via env var booleana.** `BASE_SEPOLIA_ENABLED=true/false`. Si no está seteada o es `false`, la chain no se registra en `chainRegistry`, `/supported` no la expone, y cualquier request con `eip155:84532` recibe `NETWORK_MISMATCH`. Justificación: CD-2 pide default conservador (OFF sin env var). Esto evita aceptar txs en una chain sin operador con gas.

- **DT-3: Retry strategy on network failure — circuit breaker existente.** Si el facilitator ya tiene circuit breaker por chain (definido en `X402-CONFORMANCE.md` sección "Security additions"), reutilizarlo para Base. Si NO está implementado aún (repo en scaffold), el Dev debe implementar la respuesta 503 `NETWORK_UNAVAILABLE` en el catch de errores RPC en `src/core/`. Justificación: AC-3 es bloqueante y la spec distingue error de red (503) de error de lógica (500).

- **DT-4: Mismo OPERATOR_PRIVATE_KEY para Base (V1).** El operador usa la misma key EVM en todas las chains (patrón V1 documentado). El Dev debe asegurarse que la wallet tenga ETH en Base Sepolia para gas. Justificación: es el patrón actual; multi-key es V2.

- **DT-5: EIP-712 domain para USDC Base.** Domain: `{ name: "USD Coin", version: "2" }`. Confirmar contra el contrato en Basescan antes de implementar — si el domain difiere, el recover de firma falla silenciosamente. [NEEDS CLARIFICATION — el Dev debe verificar el domain del contrato real antes de hardcodear].

---

## Constraint Directives (CD-N)

- **CD-1:** PROHIBIDO romper el envelope x402 v2 actual — cualquier cambio que rompa compat Avalanche o Kite es BLOQUEANTE en AR.
- **CD-2:** PROHIBIDO que Base esté activo sin env var `BASE_SEPOLIA_ENABLED=true` — default es OFF.
- **CD-3:** PROHIBIDO loggear private keys, RPC API keys, o authorization signatures — ningún `console.log` ni `logger.info` puede contener estos valores.
- **CD-4:** OBLIGATORIO `Co-Authored-By: Claude` en commits que contengan código generado por IA.
- **CD-5:** PROHIBIDO usar wallets de mainnet en local o staging — Mainnet solo en Railway production después de validación Sepolia completa y aprobación explícita de Fernando.
- **CD-6:** PROHIBIDO `ethers.js` — exclusivamente `viem v2` (herencia de regla absoluta del proyecto).
- **CD-7:** OBLIGATORIO que el `transactionHash` del AC-7 sea verificable públicamente en Basescan Sepolia — no puede ser una tx mockeada.

---

## Missing Inputs

- **[RESUELTO]** Repo wasiai-facilitator existe en `/home/ferdev/.openclaw/workspace/wasiai-facilitator/` — accesible.
- **[RESUELTO]** Patrón chain-adaptive ya documentado en `CHAIN-ADAPTIVE.md` con el ejemplo exacto de `base-sepolia.ts` — el Dev puede usarlo directamente.
- **[RESUELTO]** USDC addresses confirmadas en el input de la HU: Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, Mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- **[NEEDS CLARIFICATION — Bloqueante para AC-1/AC-2]** EIP-712 domain exacto del contrato USDC en Base Sepolia y Base Mainnet. El Dev DEBE verificar contra Basescan antes de implementar. Si el domain es incorrecto, la signature recovery falla.
- **[NEEDS CLARIFICATION — Operacional]** ¿Está la operator wallet ya fondeada con ETH en Base Sepolia para gas? Si no, el Dev necesita fondear antes de correr el smoke test E2E (AC-7).
- **[NEEDS CLARIFICATION — Opcional]** ¿Se requiere un Railway service separado para staging, o se testea local y se deployea directo a production Railway? La HU dice "después de validación local", lo que implica directo a prod — confirmar si hay un staging service.

---

## Análisis de paralelismo

- **WKH-104 (BASE-01):** Repos distintos — zero overlap de archivos. Pueden correr en paralelo sin conflictos de merge. BASE-01 toca wasiai-a2a; esta HU toca wasiai-facilitator.
- **BASE-04 (smoke E2E end-to-end):** Esta HU BLOQUEA BASE-04. BASE-04 necesita el facilitator funcionando en Base Sepolia para el path sin CDP. Una vez que AC-7 está validado (tx hash en Basescan), BASE-04 puede iniciar.
- **BASE-06 (Smart Wallet paymaster):** Independiente — diferente mecanismo de pago. Puede correr en paralelo.

---

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| EIP-712 domain incorrecto para USDC Base | Media | BLOQUEANTE — signature recovery silently fails | DT-5: Dev verifica domain en Basescan antes de codear. Test con firma real en Sepolia antes de mergear. |
| Operator wallet sin ETH en Base Sepolia | Media | BLOQUEANTE para AC-7 | Dev verifica balance antes de smoke test. Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet |
| Base RPC pública rate-limit en tests | Baja | E2E tests flaky | DT-1: usar `BASE_SEPOLIA_RPC_URL` custom (Alchemy/Infura) en CI |
| Railway env vars leaking en logs | Baja | Seguridad | CD-3: review de logs en AR, no loggear config objects completos |
| Deploy Railway prod rompe Kite/Avalanche | Baja | Crítico | CD-1 + CD-2: Base está OFF por default. Deploy seguro. |

---

## Contexto adicional para el Architect (F2) — CORRECCIÓN ORQUESTADOR

**[CORRECCIÓN POST-F1 por orquestador AUTO, 2026-05-19]**

El reporte original del Analyst decía "scaffold V0 — src/ contiene solo .gitkeep". Esto es **incorrecto**. Verificación directa por el orquestador con `ls src/chains/`:

```
src/chains/
├── abi/                       # Dir
├── .gitkeep                   # Legacy gitkeep en root del folder
├── avalanche.ts   (19.3 KB)   # Adapter Avalanche COMPLETO
├── kite.ts        (22.2 KB)   # Adapter Kite COMPLETO
├── registry.ts    (3.9 KB)    # Factory registry
├── types.ts       (6.0 KB)    # Tipos compartidos
├── circuit-breaker.ts (14.2 KB)
├── init-breakers.ts
├── init-domain-check.ts
└── index.ts
```

Git log confirma: commit `d6ccd5f` — `feat: Kite mainnet (chain 2366) + Avalanche C-Chain (43114) — opt-in chain adapters (#34)`. El facilitator está en producción (Railway live), no en scaffold.

**Implicancia para F3 (Dev)**:
- NO scaffold del core. El core existe y está en prod.
- Patrón claro: mirror `src/chains/avalanche.ts` → `src/chains/base.ts` (UN solo archivo con ambas networks, NO dos archivos separados como decía el work-item original).
- Mirror `src/chains/__tests__/avalanche.test.ts` (si existe) → `src/chains/__tests__/base.test.ts`
- Update `registry.ts` con import + ramas para base-sepolia y base-mainnet.

**Scope IN corregido**:
| Archivo | Acción |
|---------|--------|
| `src/chains/base.ts` | Crear — UN archivo siguiendo patrón `avalanche.ts` (cubre sepolia + mainnet via env) |
| `src/chains/registry.ts` | Modificar — agregar branches base-sepolia y base-mainnet |
| `src/chains/__tests__/base.test.ts` | Crear — siguiendo patrón existente |
| `.env.example` | Modificar — agregar BASE_SEPOLIA_RPC_URL, BASE_MAINNET_RPC_URL, BASE_SEPOLIA_ENABLED, BASE_MAINNET_ENABLED |
| `README.md` | Modificar — sección "Supported Networks: Base" |

**Effort estimate corregido**: ~4-6h (no 8h). El patrón existe, es config + mirror.

**Branches relevantes en wasiai-facilitator**: `feat/mainnet-support-kite-avalanche` (pattern de cómo se agregó mainnet a Kite y Avalanche — exemplar perfecto para Base). Crear branch nueva `feat/base-support` desde main.

El `doc/architecture/CHAIN-ADAPTIVE.md` debe contener el patrón. El Dev DEBE leer `avalanche.ts` como exemplar literal antes de codear `base.ts`.

Los skills relevantes para esta HU son **blockchain-evm** (EIP-3009, viem, transferWithAuthorization) y **payment-infra** (x402 protocol, facilitator pattern, settle/verify flow).

**[NEEDS CLARIFICATION] removidos por corrección**:
- ~~"Repo en scaffold V0"~~ → RESUELTO: repo está completo y en prod.
- ~~"¿Esta HU incluye core scaffolding?"~~ → RESUELTO: NO, solo chain adapter siguiendo patrón.
