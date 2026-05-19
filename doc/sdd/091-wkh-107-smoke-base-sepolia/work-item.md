# Work Item — [WKH-107] BASE-04 · Smoke E2E Base Sepolia con tx hash real en Basescan

## Resumen

Se construye un script de smoke E2E (`scripts/smoke-base-sepolia.mjs`) que ejecuta el flujo completo x402 v2 contra Base Sepolia: POST /compose → challenge 402 → firma EIP-3009 TransferWithAuthorization con USDC sepolia → reintentar con `payment-signature` → capturar tx hash verificable en `sepolia.basescan.org`. El artefacto principal de salida es `doc/BASE-EVIDENCE.md` con 3 corridas documentadas (0.001, 0.005 y 0.01 USDC sepolia) que sirven como evidencia inmutable para la postulación a Base Builder Grants. El script sigue el patrón del exemplar `scripts/smoke-prod-via-app-wasiai.mjs`, adaptado a Base Sepolia (chainId 84532, USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).

## Sizing

- SDD_MODE: mini
- Estimación: S (4h estimado por Fernando; script + docs, sin tocar código de producción)
- Pipeline: FAST (solo `scripts/` y `doc/` — ningún archivo de `src/` se toca)
- Branch sugerido: `feat/wkh-base-port-v1`

## Skills Router

- `blockchain-evm` — firma EIP-3009, chain adapter Base, USDC sepolia address, Basescan
- `scripting-node` — script `.mjs` con viem, lectura de env, salida estructurada para docs

## Acceptance Criteria (EARS)

- AC-1: WHEN `node scripts/smoke-base-sepolia.mjs` is executed against a reachable staging URL with a funded test wallet, the system SHALL complete the full x402 v2 flow (POST /compose → HTTP 402 challenge → EIP-3009 sign → retry with `payment-signature` → HTTP 200) and print a non-empty tx hash to stdout.
- AC-2: WHEN the tx hash captured by the script is queried on `https://sepolia.basescan.org/tx/<hash>`, the explorer SHALL show a confirmed `transferWithAuthorization` call on USDC sepolia contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- AC-3: WHEN the script is executed 3 times consecutively, the system SHALL produce 3 distinct tx hashes, each with a unique EIP-3009 nonce (32-byte random), confirming no replay.
- AC-4: WHEN the 3 smoke runs complete (any combination of success/failure), `doc/BASE-EVIDENCE.md` SHALL exist and contain, for each run: tx hash (or error description if run failed), Basescan URL, USDC amount, agent destination address, ISO 8601 timestamp, and run outcome (SUCCESS / FAILED — per CD-3, failures MUST be documented, not hidden).
- AC-5: WHEN a reader opens `README.md`, the section "Production proof" SHALL contain a reference (link or inline pointer) to `doc/BASE-EVIDENCE.md` under a "Verifiable proof on Base Sepolia" sub-heading.
- AC-6: IF the script detects that the test wallet's USDC sepolia balance is below the required amount for the run, THEN the system SHALL print an explicit insufficient-balance error message and exit with code 1 before sending any HTTP request.

## Scope IN

- `scripts/smoke-base-sepolia.mjs` — nuevo script (crea o sobrescribe si ya existe)
- `doc/BASE-EVIDENCE.md` — nuevo archivo de evidencia inmutable post-ejecución
- `README.md` — única modificación: agregar sub-sección "Verifiable proof on Base Sepolia" dentro de la sección "Production proof" existente, con link a `doc/BASE-EVIDENCE.md`

## Scope OUT

- NO tx en Base Mainnet (chainId 8453) — solo Base Sepolia (chainId 84532)
- NO video del flow — fuera de la HU (tarea manual de Fer)
- NO listado en Agentic.Market / Bazaar — ocurre automáticamente post-tx via CDP, fuera del scope
- NO modificación de código en `src/` — el smoke script no requiere cambios en el gateway
- NO nuevo workflow de CI para correr el smoke automáticamente — fuera de scope
- NO tests de vitest para el smoke script — el smoke ES el test; vitest unit tests son para `src/`

## Decisiones Técnicas (DT-N)

- DT-1: **Target URL = staging cloud, no local.** El flow x402 requiere que el facilitator/verifier acceda a la URL del gateway; `localhost` no funciona en el loop challenge-response cuando el facilitador es externo. La URL staging se lee desde env var `BASE_SMOKE_GATEWAY_URL` (sin default hardcodeado — CD-1 de esta HU prohíbe hardcodes).
- DT-2: **Nonce strategy: `randomBytes(32)` por corrida.** Igual que el exemplar `smoke-prod-via-app-wasiai.mjs`. Garantiza unicidad sin necesitar un counter persistente. Cada corrida genera un nonce fresco → 3 corridas distintas = 3 tx hashes distintos (AC-3).
- DT-3: **Retry strategy en fallo de tx: NO reintentar automáticamente.** Si una corrida falla, el script documenta el error en `doc/BASE-EVIDENCE.md` (CD-3) y continúa con la siguiente corrida. No hay retry automático para evitar doble-gasto accidental en el caso de fallo ambiguo (tx submitida pero sin confirmación en timeout del explorer).
- DT-4: **EIP-712 domain para USDC sepolia Base:** `{ name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }`. Circle USDC usa versión `'2'` en todas las redes. Si el settle falla silenciosamente, la causa más probable es un domain incorrecto (ver Riesgos).
- DT-5: **Wallet de test: env var `BASE_SMOKE_PRIVATE_KEY`.** NO reusar `OPERATOR_PRIVATE_KEY` del gateway para evitar mezclar fondos de test con fondos del operador de producción. Wallet nueva dedicada a Base Sepolia smoke runs.
- DT-6: **Basescan explorer delay.** El script captura el tx hash del response body del gateway (que viene del facilitator tras confirmación on-chain). El link a Basescan se imprime inmediatamente; el explorer puede tardar 10-30s en indexar. El script NO poll-ea el explorer — asume confirmación si el facilitator retorna tx hash.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO incluir en cualquier archivo commiteado: private keys, mnemonics, seed phrases. `BASE_SMOKE_PRIVATE_KEY` se lee SIEMPRE desde env var. El script DEBE abortar con error explícito si la var no está seteada.
- CD-2: PROHIBIDO editar `doc/BASE-EVIDENCE.md` después de publicar los tx hashes en el commit de evidencia. El archivo es append-only tras la primera corrida exitosa; las corridas posteriores se agregan, no se reemplazan.
- CD-3: OBLIGATORIO documentar corridas fallidas en `doc/BASE-EVIDENCE.md` con el error exacto — NO borrar runs fallidas del doc, NO hacer cherry-pick de solo los éxitos.
- CD-4: PROHIBIDO llamar Basescan API en el script (rate limits, API key requerida para writes). La verificación de tx es manual (link en `doc/BASE-EVIDENCE.md`). El script solo verifica el tx hash vía el response del gateway.
- CD-5: PROHIBIDO modificar cualquier archivo en `src/` en esta HU. Si se descubre que el gateway necesita un cambio para soportar Base Sepolia, ese cambio es scope de WKH-104 o WKH-105, no de esta HU.
- CD-6: OBLIGATORIO usar `viem` para toda operación de firma EIP-3009. PROHIBIDO `ethers.js` (regla global del proyecto).
- CD-7: OBLIGATORIO leer la URL del gateway desde env var `BASE_SMOKE_GATEWAY_URL`. PROHIBIDO hardcodear URLs de staging o producción en el script.

## Missing Inputs

- [BLOQUEANTE] `BASE_SMOKE_GATEWAY_URL` — URL pública del gateway con adapter Base Sepolia activo (depende de WKH-104 + WKH-105 mergeados y deployados en staging). Sin esta URL el script no puede correr.
- [BLOQUEANTE] Wallet de test fundeada con USDC sepolia (faucet.circle.com) y ETH base sepolia para gas (faucet.base.org) — tarea manual de Fer, fuera del código.
- [RESUELTO EN F2] USDC sepolia contract address: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (canónico Circle en Base Sepolia, chainId 84532).
- [RESUELTO EN F2] EIP-712 domain version para Circle USDC: `'2'` (consistente con smoke-staging-x402.mjs para Fuji USDC).
- [NEEDS CLARIFICATION] Agente Cobraya/wasi destino en Base Sepolia — el scope IN menciona "agente Cobraya/wasi en Base Sepolia" pero no especifica el slug ni la registry. El script puede parametrizarse via env var `BASE_SMOKE_AGENT_SLUG` con un fallback a cualquier agente activo que acepte pagos en Base Sepolia. Si ninguno está disponible en staging al momento de correr, el smoke fallará con AGENT_NOT_FOUND — documentar en BASE-EVIDENCE.md per CD-3.

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| Faucet Circle rate-limited (USDC sepolia) | Media | Alto — bloquea las 3 corridas | Pedir fondos con anticipación; mantener buffer de 0.1 USDC mínimo |
| EIP-712 domain incorrecto → settle falla silenciosamente (200 sin tx hash) | Media | Alto — AC-2 no pasa | Hardcodear domain correcto en DT-4; verificar contra Circle ABI |
| Basescan delay de indexación (10-30s) | Alta | Bajo — el link existe pero no muestra nada de inmediato | Documentar en BASE-EVIDENCE.md que el link puede tardar; instrucción de espera |
| Gateway staging no disponible (WKH-104/105 aún no mergeados) | Alta | Bloqueante | Dependency explícita: WKH-107 no puede empezar hasta DONE en WKH-104 + WKH-105 |
| tx submitida pero confirmación timeout en facilitator | Baja | Medio — tx existente pero sin hash capturado | CD-3: documentar en BASE-EVIDENCE.md; correr corrida extra si hay presupuesto en faucet |

## Análisis de paralelismo

- BLOQUEADO POR: WKH-104 (BASE-01 — adapter Base Sepolia en gateway) Y WKH-105 (BASE-02 — facilitator Base Sepolia). Esta HU requiere que AMBAS estén en estado DONE y deployadas en staging antes de poder ejecutar el smoke script. No puede arrancar en paralelo con ellas.
- BLOQUEA: postulación formal a Base Builder Grants (necesita `doc/BASE-EVIDENCE.md` con tx hashes reales).
- PARALELO POSIBLE CON: WKH-106 (BASE-03 — cualquier doc/config que no requiera tx reales), WKH-108 si existe (cualquier HU que no dependa de evidencia Base Sepolia).
- Impacto en branch: `feat/wkh-base-port-v1` — esta HU vive en el mismo branch que BASE-01..03. Merge conflict risk: bajo (solo `scripts/` y `doc/`, no `src/`).
