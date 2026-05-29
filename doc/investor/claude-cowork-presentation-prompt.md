# Prompt para Claude Cowork — Presentación a inversionista (WasiAI)

> Copiá TODO lo que está debajo de la línea y pegáselo a Claude Cowork.
> Generado 2026-05-28 con datos reales verificados (tx onchain, tests, URLs de prod).

---

# ROL Y OBJETIVO

Sos un analista técnico-estratégico y diseñador de pitch decks. Tu tarea es construir una **presentación para un inversionista** que quiere conocer todo lo que hemos construido en **WasiAI**: tres sistemas en producción que, juntos, forman la infraestructura de la **economía agéntica** (agentes de IA autónomos que se descubren, componen y se pagan entre sí, sin humano en el loop, cross-marketplace y cross-chain).

La reunión es en un par de días. El inversionista NO es necesariamente técnico profundo, pero valora **pruebas concretas** (cosas reales en producción, transacciones onchain verificables, código de calidad) por encima del hype. Tu deck debe equilibrar **visión + mercado** con **prueba dura y credibilidad técnica**.

**Regla de oro: NO inventes métricas.** No inventes usuarios, ingresos, ronda, ni tracción que no esté en las fuentes. Las pruebas duras son las **transacciones onchain reales** (abajo) y el **código/tests en producción**. Si una cifra de mercado/TAM es estimación, etiquetala como "estimación" con su supuesto. Verificá todo contra las fuentes antes de afirmarlo.

---

# QUÉ HAY QUE ENTENDER: LOS 3 SISTEMAS

WasiAI son 3 capas que se consumen entre sí:

1. **wasiai-v2 — el Marketplace de agentes.**
   - Dónde los creadores publican agentes de IA y los consumidores los encuentran/invocan.
   - Stack: Next.js 14 (App Router) + Supabase + viem. Hosting: Vercel.
   - Prod: `https://app.wasiai.io` (API pública: `https://app.wasiai.io/api/v1/capabilities`).
   - Repo: `github.com/ferrosasfp/wasiai-v2` (local: `/home/ferdev/.openclaw/workspace/wasiai-v2`).
   - **Consume** a wasiai-a2a (delega discovery/compose/orchestrate). También ES un registry para wasiai-a2a.

2. **wasiai-a2a — el Servicio standalone de Discovery + Composición + Orquestación (LA CAPA CLAVE).**
   - Implementa el **Google A2A Protocol** (estándar abierto de interoperabilidad entre agentes) como capa que permite que agentes de cualquier marketplace/framework se **descubran, compongan en pipelines, y se paguen solos**. Zero human in the loop.
   - Posicionamiento: "la capa de interoperabilidad y orquestación que le falta a la economía agéntica".
   - Stack: Fastify + Supabase PostgreSQL + Redis/BullMQ + Claude Sonnet (orquestación con LLM) + viem + TypeScript strict.
   - Multi-chain real: **Kite, Avalanche y Base** simultáneamente.
   - Prod: `https://wasiai-a2a-production.up.railway.app` (Railway).
   - Repo: `github.com/ferrosasfp/wasiai-a2a` (local: `/home/ferdev/.openclaw/workspace/wasiai-a2a`).
   - Endpoints: `POST /discover`, `POST /compose`, `POST /orchestrate`, `POST /registries`, `GET /agents/:id/agent-card`, `POST /a2a` (JSON-RPC 2.0), `GET /health`.

3. **wasiai-facilitator — el Facilitador de pagos (settlement).**
   - Liquida los pagos x402/EIP-3009 onchain en múltiples chains. Es el componente que firma/envía la transacción.
   - Stack: Fastify + viem + circuit breakers + domain-check onchain.
   - Prod: `https://wasiai-facilitator-production.up.railway.app` (`/supported` lista las chains activas).
   - Repo: `github.com/ferrosasfp/wasiai-facilitator` (local: `/home/ferdev/.openclaw/workspace/wasiai-facilitator`).
   - Soporta settle en Kite, Avalanche (Fuji + mainnet) y Base Sepolia.

**Cómo encajan (el flujo end-to-end):**
Un agente/usuario pide un objetivo → wasiai-a2a (orquestador con LLM) descubre los agentes adecuados en los registries (incluido wasiai-v2 y otros) → arma un pipeline multi-agente (compose) → invoca cada agente → y **paga a cada agente downstream en su propia chain** vía el facilitator (x402 + EIP-3009). El gateway **cobra** al caller (inbound) y **paga** a los sub-agentes (outbound), en cualquiera de las 3 chains.

---

# FUENTES (leelas para profundidad; las cito por path real)

Si tenés acceso al filesystem/repos, leé estas fuentes. Si no, usá los datos embebidos en este prompt (ya están verificados).

**wasiai-a2a** (`/home/ferdev/.openclaw/workspace/wasiai-a2a`):
- `README.md` — arquitectura de producción + narrativa cross-chain (≈40KB, la fuente más completa).
- `.nexus/project-context.md` — contexto, stack, reglas, Google A2A reference, business model, tablas DB.
- `HACKATHON-FINAL.md` — reporte/narrativa del hackathon.
- `doc/sdd/_INDEX.md` — índice de ~64 Historias de Usuario (HUs) entregadas con metodología QUALITY (muestra el VOLUMEN y rigor del trabajo).
- `doc/BASE-EVIDENCE.md` — evidencia onchain de pagos en Base Sepolia (Runs 1–5, con tx hashes).
- `doc/sdd/_validation/2026-05-28-full-prod-validation.md` — validación integral de prod (11 capas, matriz 3 chains × 5 dimensiones, todo verde) + anexo con las 3 tx outbound.
- `doc/sdd/_validation/2026-05-27-multichain-deep-validation.md` — validación multi-chain previa.
- `doc/operations/identities-runbook.md` — identidades operacionales (wallets, secrets) — para entender la madurez ops (NO incluir secrets en el deck).
- `doc/migration/2026-04-28-wasiai-v2-realignment-plan.md` — el plan de cutover v2→a2a (prod).
- `doc/architecture/`, `doc/demo/`, `doc/research/`, `doc/spikes/` — material de soporte.
- Adapters multi-chain: `src/adapters/{kite-ozone,avalanche,base}/` y `src/adapters/chain-resolver.ts`.

**wasiai-v2** (`/home/ferdev/.openclaw/workspace/wasiai-v2`):
- `README.md`, `doc/`, `docs/`. API: `src/app/api/v1/` (agents, capabilities, compose, orchestrate, auth, creator, calls).

**wasiai-facilitator** (`/home/ferdev/.openclaw/workspace/wasiai-facilitator`):
- `README.md`, `doc/`. Chains: `src/chains/{kite,avalanche,base}.ts` + `registry.ts` + `circuit-breaker.ts` + `init-domain-check.ts`.

**Live endpoints (verificables en vivo durante el pitch):**
- Marketplace: `https://app.wasiai.io/api/v1/capabilities` (lista agentes reales).
- Gateway health: `https://wasiai-a2a-production.up.railway.app/health`.
- Facilitator chains: `https://wasiai-facilitator-production.up.railway.app/supported`.

**Jira** (gestión/rigor): proyecto `WKH` en `ferrosasfp.atlassian.net` (epic WKH-103 = BASE port, + ~muchas HUs).

---

# DATOS DUROS VERIFICADOS (embebelos como prueba)

**Protocolos / estándares (esto es el "moat" de interoperabilidad):**
- **Google A2A Protocol** — estándar abierto (JSON-RPC 2.0) para que agentes interoperen; respaldado por un consorcio amplio de la industria. wasiai-a2a lo implementa como capa de orquestación.
- **x402** — el estándar de micropagos HTTP-native impulsado por Coinbase (pago por API call con HTTP 402).
- **EIP-3009** (`transferWithAuthorization`) — pagos gasless de stablecoins (el caller firma, el facilitator paga el gas).
- **ERC-8004 / Kite Passport** — identidad de agentes onchain (integrado vía spike Model B Hybrid).

**Multi-chain en producción (chain-agnostic real):**
- **Kite** (L1 agéntica; Ozone testnet chainId 2368, mainnet 2366) — stablecoin PYUSD (18 dec).
- **Avalanche** (Fuji testnet 43113, mainnet 43114) — USDC (6 dec).
- **Base** (Coinbase L2; Sepolia 84532, mainnet 8453) — USDC (6 dec).
- El facilitator de prod liquida hoy en 4 redes (Kite testnet, Avalanche Fuji + mainnet, Base Sepolia), todas con circuit breaker CLOSED (sano).

**PRUEBA ONCHAIN INMUTABLE — pagos agente-a-agente reales (el killer feature de credibilidad):**
El gateway COBRA (inbound) y PAGA (outbound) en las 3 chains, probado con transacciones reales (status SUCCESS / 0x1). Incluí estas como links clickeables en el deck:
- Base Sepolia — INBOUND (cliente paga al gateway): `0x89329e5a23f7470bdd470d7dd747f77414c6132cdb89b2fcb0f713e9292fec7e` → https://sepolia.basescan.org/tx/0x89329e5a23f7470bdd470d7dd747f77414c6132cdb89b2fcb0f713e9292fec7e
- Base Sepolia — OUTBOUND (gateway paga a un sub-agente): `0xedcbc86d43ac96521d6c9f25db1d3f56deb8beea44fefaf7f5134cae83f619a3` → https://sepolia.basescan.org/tx/0xedcbc86d43ac96521d6c9f25db1d3f56deb8beea44fefaf7f5134cae83f619a3
- Avalanche Fuji — OUTBOUND: `0x423dbfcfec6a81552a713bafc27e0ebe77c6192742eb9c778593f97ba4de60ff` → https://testnet.snowtrace.io/tx/0x423dbfcfec6a81552a713bafc27e0ebe77c6192742eb9c778593f97ba4de60ff
- Kite — OUTBOUND: `0xb5b1dbedd6c9d915e102c112cc8840cc84cfaaba8cc3b96ddecd069224252b44` → https://testnet.kitescan.ai/tx/0xb5b1dbedd6c9d915e102c112cc8840cc84cfaaba8cc3b96ddecd069224252b44
- (Mensaje clave: "mismo flujo `/compose` → settle onchain en 3 chains distintas, con montos en los decimales correctos de cada token — 6 dec USDC, 18 dec PYUSD").

**Rigor de ingeniería (código de producción, no demo de hackathon):**
- wasiai-a2a: **~64 Historias de Usuario** entregadas bajo metodología QUALITY (cada una con SDD, Adversarial Review, Code Review, QA con evidencia archivo:línea, y reporte DONE). **1.059 tests** automatizados verdes, TypeScript strict, build limpio.
- wasiai-facilitator: **590 tests** verdes.
- Seguridad endurecida: SSRF guards, HSTS/CORS, ownership checks (anti-IDOR), anti-RCE en transform cache, rate limiting, circuit breakers, validación dinámica de chains sin hardcode.
- Lema del equipo (citalo): **"hacemos código para producción, no para hack"**.

**Casos de uso reales que ya consumen la plataforma:**
- **Cobraya** — marketplace agéntico de factoring de facturas para PyMEs mexicanas (paga agentes en Avalanche Fuji vía wasiai-a2a; incluye contrato Solidity anti-doble-cesión, audit trail EIP-712 para CNBV). Construido sobre la stack WasiAI.
- **WasiAgentShop** — agentes en Kite Ozone.
- **app.wasiai.io** — el marketplace v2 productivo, ya en cutover delegando a wasiai-a2a.

**Modelo de negocio:**
- **1% protocol fee** por cada compose/orchestrate (el gateway debita y transfiere el fee).
- Discovery premium (features avanzados).
- B2B licensing (otros marketplaces integran wasiai-a2a como su capa A2A).

**Posicionamiento estratégico (vs el stack nativo de Coinbase/Base):** WasiAI es complementario y de mayor nivel que AgentKit + x402 nativo: aporta la capa de **discovery cross-marketplace + orquestación goal-based con LLM + interoperabilidad A2A + multi-chain**, no atada a una sola chain ni a un solo marketplace. (Profundizá en la fuente de positioning si tenés acceso a engram/notas.)

---

# ESTRUCTURA DEL DECK (armá ~12–15 slides + guion de pitch)

Para cada slide: título, 3–5 bullets concisos, y **notas del orador** (1 párrafo de "qué decir"). Orientado a inversionista.

1. **Portada** — "WasiAI: la infraestructura de pagos y orquestación para la economía agéntica." Logo/tagline + 1 línea.
2. **El problema** — Los agentes de IA autónomos no pueden descubrirse, componerse ni pagarse entre sí a través de distintos marketplaces y blockchains. Falta la "capa TCP/IP + Stripe" de los agentes.
3. **La solución / Qué es WasiAI** — 3 capas (Marketplace + A2A layer + Facilitator). Una frase por capa. El insight: zero human in the loop, cross-marketplace, cross-chain.
4. **Cómo funciona** — Diagrama del flujo: goal → discover → compose → orchestrate → invoke → pay (inbound + outbound). Resaltar Google A2A + x402 + EIP-3009.
5. **Arquitectura** — Diagrama de las 3 capas + stack + las 3 chains + el facilitator. Mostrar que es modular y chain-agnostic.
6. **Diferenciadores / Moat** — Estándar abierto (Google A2A), multi-chain real, orquestación con LLM, interoperabilidad. Tabla "WasiAI vs alternativas de una sola chain / un solo marketplace".
7. **PRUEBA: ya está en producción y onchain** (slide de credibilidad — el más fuerte) — URLs live + las 4 tx onchain clickeables (inbound + outbound × 3 chains) + 1.059 tests + ~64 HUs QUALITY. "Esto no es un mockup: es dinero real moviéndose entre agentes en 3 blockchains."
8. **Demo** — Guion de demo en vivo: hacer un `GET /supported` (4 chains), un `/discover`, y mostrar una tx en el explorer. (Dar los comandos exactos en notas del orador.)
9. **Casos de uso** — Cobraya (factoring PyMEs MX), WasiAgentShop, app.wasiai.io. Mostrar tracción real de consumidores.
10. **Mercado / TAM** — La economía agéntica y los micropagos agente-a-agente (x402/Base ecosystem, agentic commerce). Marcá las cifras como estimación con su fuente/supuesto; NO inventes números.
11. **Modelo de negocio** — 1% protocol fee + discovery premium + B2B licensing. Unit economics simple (fee por transacción agéntica).
12. **Roadmap** — Próximos pasos (mainnet activation runbook ya existe; más chains; más marketplaces integrados; grants Base/Coinbase).
13. **Equipo + Ask** — (Dejá placeholders para que el founder complete: equipo, monto de la ronda, uso de fondos.)
14. **Apéndice técnico** — tx hashes completos, endpoints, stack, links a repos/docs.

---

# ENTREGABLES

1. **El deck**: generá un archivo **HTML self-contained** (reveal.js o similar, que abra en el browser sin build) **o** Markdown estilo Marp — el que sea más limpio. Diseño profesional, sobrio, legible en proyector.
2. **Guion del pitch** (`pitch-script.md`): qué decir en cada slide, ~8–10 min de charla, con las respuestas a 5 preguntas duras típicas de inversor (defensibilidad, por qué ahora, competencia con Coinbase nativo, regulación de pagos cripto, go-to-market).
3. **One-pager ejecutivo** (`one-pager.md`): resumen de 1 página para dejarle al inversor.
4. Idioma: **español** (el inversor es hispanohablante). Si pedís, versión en inglés también.

---

# GUARDRAILS (CRÍTICO)

- **Verificá contra las fuentes** antes de afirmar cualquier dato técnico. Si tenés acceso a los repos, leé README.md de cada uno + `doc/sdd/_validation/2026-05-28-full-prod-validation.md` + `doc/BASE-EVIDENCE.md`.
- **Las tx onchain de arriba son reales y verificables** — son tu prueba más fuerte. Usalas literales.
- **NO inventes**: usuarios, ingresos, valuación, tamaño de ronda, % de mercado, ni partnerships no confirmados. Donde falte dato de negocio, dejá un placeholder `[completar: founder]`.
- **NO incluyas secrets** (private keys, service keys, tokens) — están en los runbooks pero NUNCA van al deck.
- Tono: confianza basada en evidencia, no hype. El ángulo ganador es "esto YA funciona en producción con dinero real onchain — la mayoría de los proyectos agénticos son demos; nosotros tenemos infra productiva multi-chain probada".
- Si algo es ambiguo o te falta una fuente, listá tus supuestos al final en una sección "Supuestos y huecos a confirmar con el founder".

Empezá leyendo las fuentes (si tenés acceso) y luego producí los 3 entregables.
