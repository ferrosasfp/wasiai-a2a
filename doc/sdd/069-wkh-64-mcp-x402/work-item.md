# Work Item — WKH-64 [MCP-X402] Build wasiai-x402 MCP server for Claude Console managed agents

> Fase F1 (analyst) — modo AUTO. Ticket: https://ferrosasfp.atlassian.net/browse/WKH-64
> Predecesor histórico (artefactos viejos, NO copiar): `doc/sdd/WKH-MCP-X402/` (2026-04-13, predate mainnet hybrid).

## Product Context

[SIN PRODUCT CONTEXT — work-item self-contained, narrativa completa en CLAUDE.md y HACKATHON-FINAL.md]

## Resumen

Construir un **MCP server standalone** (paquete independiente bajo `mcp-servers/wasiai-x402/`) que expone 3 tools (`discover_agents`, `get_payment_quote`, `pay_x402`) para que un agent administrado por Claude Console (Sonnet 4.6) pueda pagar x402 contra `app.wasiai.io` y disparar el E2E live mainnet hybrid (Kite testnet PYUSD inbound + Avalanche mainnet USDC outbound) sin código local. Es el "client-side" SDK del protocolo: el repo wasiai-a2a sigue siendo el server. Esto destraba la demo del hackathon de Kite donde un agent gestionado por Anthropic puede ejecutar agentic commerce real.

## Sizing

- **SDD_MODE**: full (QUALITY)
- **Estimación**: M (paquete nuevo, ~6 archivos, signing crypto-sensitive, mainnet ~$5 USDC en juego post-merge)
- **Branch sugerido**: `feat/069-wkh-64-mcp-x402` desde `main@43091fd`
- **Skills router**: (1) `web3-crypto-signing` (EIP-3009 / EIP-712 / viem), (2) `mcp-protocol` (MCP SDK ≥1.0, tool registration, stdio transport).

### Veredicto sobre QUALITY (humano declaró QUALITY)

**Confirmado QUALITY**. Argumentos:

1. **Crypto-sensitive**: el código maneja `OPERATOR_PRIVATE_KEY` y firma EIP-712. Bug en domain/types/decimals → firma inválida → 4xx → falla demo. O peor: fuga de PK en logs → drain del operator wallet (~$5 USDC mainnet, pero la PK también gobierna el protocol fee en WKH-44).
2. **Mainnet exposure**: cada `pay_x402` exitoso genera tx real en Avalanche C-Chain (1% fee + downstream cost). No es código local-only.
3. **Demo-blocker**: el hackathon de Kite depende de esta HU para mostrar agentic commerce desde Claude Console. Bug en producción = pérdida del demo slot.
4. **Adversarial surface alta**: SSRF (gateway URL controlable), prompt-injection (un agent malicioso podría llamar `pay_x402` con endpoint arbitrario), key leakage en error messages.

FAST/LAUNCH descartados: too much skin in the game.

## Acceptance Criteria (EARS)

### Funcionales — happy path

- **AC-1**: WHEN se invoca el tool `discover_agents` (con o sin parámetros opcionales `query`, `maxPrice`, `capabilities`), the system SHALL hacer GET a `${WASIAI_GATEWAY_URL}/api/v1/capabilities` con los query params correspondientes y devolver el array `agents` (o el body completo si el shape difiere) sin modificarlo.
- **AC-2**: WHEN se invoca `get_payment_quote(endpoint, method, payload?)` con `method` en `{compose, orchestrate}`, the system SHALL hacer la request al gateway SIN header `payment-signature`, capturar el HTTP 402 esperado, y devolver el `accepts[0]` structure parseado (con campos `payTo`, `maxAmountRequired`, `network`, etc.) más el raw body.
- **AC-3**: WHEN se invoca `pay_x402(endpoint, method, payload)` con un endpoint válido, the system SHALL ejecutar el flujo completo: (a) probe sin firma para obtener 402 challenge, (b) firmar EIP-3009 `TransferWithAuthorization` con `OPERATOR_PRIVATE_KEY` usando el domain/types correctos para PYUSD en Kite testnet (chainId 2368, contrato `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`, decimals 18), (c) construir el envelope `base64(JSON({signature, authorization, network: "eip155:2368"}))`, (d) reintentar la request con header `payment-signature: <envelope>`, (e) devolver la respuesta del gateway parseada (status, body, latency).

### Funcionales — error handling

- **AC-4**: IF el gateway devuelve status ∉ {200, 402} en el probe inicial OR ≠ 200 tras el retry firmado, THEN the system SHALL devolver un error estructurado `{ ok: false, status, body, stage: "probe"|"settle" }` SIN inventar tx hashes ni success flags. NO fallback a respuestas mock.
- **AC-5**: IF el envelope o la firma fallan en construcción local (e.g. `value` no parseable como BigInt, signature throw), THEN the system SHALL devolver `{ ok: false, stage: "sign", error: <descripción sin PK> }`.

### Configuración / fail-secure

- **AC-6**: IF `OPERATOR_PRIVATE_KEY` no está seteada O no parsea como hex de 64 chars, THEN el MCP server SHALL fallar al iniciar (exit code ≠ 0) con un mensaje claro `"OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex"` que NO incluya el valor parcial.
- **AC-7**: WHEN `WASIAI_GATEWAY_URL` no está seteada al iniciar, the system SHALL hacer fallback a `https://app.wasiai.io` y loggear una vez (warn-once) la elección por default.
- **AC-8**: WHEN `WASIAI_GATEWAY_URL` está seteada, the system SHALL validar al startup que sea (a) URL parseable, (b) scheme `https://` (rechazar `http://` excepto si el host es `localhost` o `127.0.0.1` para dev), (c) NO host privado (RFC1918) salvo excepción dev. Falla → exit ≠ 0.

### Seguridad

- **AC-9**: WHILE el server está corriendo, the system SHALL nunca loggear la `OPERATOR_PRIVATE_KEY` ni ningún derivado (operator address sí está OK loggear). NINGÚN error/debug/trace path expone la PK. Tests unitarios SHALL cubrir este invariant con un spy sobre `console.*`.
- **AC-10**: WHEN cualquier tool recibe un input con campos `OPERATOR_PRIVATE_KEY`, `signature`, `authorization`, the system SHALL ignorar esos campos del input (no overridear el env) y loggear warn-once si se detectan.
- **AC-11**: WHILE se ejecuta `pay_x402`, the system SHALL aplicar guard de `MCP_MAX_AMOUNT_WEI_DEFAULT` (env opcional) o `maxAmountWei` por-call: si `accepts[0].maxAmountRequired` excede el guard, abortar con error estructurado ANTES de firmar.

### Tests

- **AC-12**: WHERE existe el suite de tests, the system SHALL incluir tests unitarios que cubran: (a) construcción correcta del envelope EIP-3009 contra un golden vector (private key fija de test, validBefore fijo, nonce fijo → output base64 determinístico), (b) rechazo cuando PK ausente/malformada, (c) rechazo cuando gateway URL es privada/insegura, (d) parsing correcto del 402 challenge body. Sin tocar mainnet, sin requests HTTP reales (mocks).

### Documentación

- **AC-13**: WHEN el README.md se publica, the system SHALL incluir 3 secciones explícitas: (a) **Setup local** (clone, npm install, .env, npm start), (b) **Deploy a Claude Console managed env** (paso a paso para subir el bundle MCP al env wasiai-orchestrator-env), (c) **Security warnings** (PK custody, mainnet exposure, rotación, blast radius si fuga).
- **AC-14**: WHEN `.env.example` se publica, the system SHALL documentar TODAS las env vars usadas con: nombre, ¿obligatoria?, default, formato, ejemplo. `OPERATOR_PRIVATE_KEY` SHALL aparecer con valor placeholder `0xYourOperatorPrivateKey` (mismo patrón que el repo principal).
- **AC-15**: WHEN se commitea, the system SHALL incluir `.gitignore` que excluya como mínimo `.env`, `.env.local`, `node_modules/`, `dist/`, `*.log`. NO debe excluir `.env.example`.

### Observabilidad

- **AC-16**: WHILE se ejecuta cualquier tool, the system SHALL emitir logs estructurados en JSON (línea por evento) con keys mínimas `{ ts, level, tool, stage, gateway, operator, ok }`. Compatibles con ingesta de Claude Console. NO incluyen PK ni signatures completas (signature truncada a 10 chars + `…` para debugging).

## Scope IN

Todo bajo `mcp-servers/wasiai-x402/` (paquete nuevo, fuera de `src/`):

- `mcp-servers/wasiai-x402/package.json` — deps: `@modelcontextprotocol/sdk`, `viem`, `dotenv` (Architect en F2 decide si agrega `zod` para schema validation o usa el del MCP SDK).
- `mcp-servers/wasiai-x402/src/index.{mjs|ts}` — bootstrap server + 3 tool handlers (DT-A en F2).
- `mcp-servers/wasiai-x402/src/sign.{mjs|ts}` — pure function de signing (testable, sin I/O).
- `mcp-servers/wasiai-x402/src/config.{mjs|ts}` — env loading + validación fail-fast.
- `mcp-servers/wasiai-x402/README.md` — 3 secciones (AC-13).
- `mcp-servers/wasiai-x402/.env.example`.
- `mcp-servers/wasiai-x402/.gitignore`.
- `mcp-servers/wasiai-x402/tests/sign.test.{mjs|ts}` — golden vector + invariants (AC-12).
- `mcp-servers/wasiai-x402/tsconfig.json` (solo si DT-A elige TS).

## Scope OUT

- NO modificar `src/` del repo principal (server-side, intacto).
- NO modificar `app.wasiai.io` ni `wasiai-v2`.
- NO publicar a npm (queda para HU posterior).
- NO ejecutar test E2E con dinero real (validación post-merge bajo gate humano).
- NO tocar `OPERATOR_PRIVATE_KEY` real ni rotarla.
- NO modificar `.env.example` raíz (las vars `MCP_*` ya existentes son del MCP plugin server-side, no del cliente WKH-64 — son artefactos diferentes).
- NO agregar el cliente al deploy de Railway ni al CI principal (es package independiente).
- NO implementar tools adicionales más allá de los 3 declarados (`compose`/`orchestrate`/`tasks` polling queda OUT — ver Missing Inputs).
- NO soporte multi-chain dinámico en esta HU (PYUSD/Kite testnet hardcoded como default vía DT-B/C/D — Avalanche outbound es responsabilidad del server post-pago).
- NO autenticación adicional (x-a2a-key, x-wasiai-forward-key) en esta HU — el flujo es pure x402 desde un caller externo.

## Decisiones técnicas (DT-N)

- **DT-A** [PROPUESTO, RESOLVER EN F2]: ¿Implementación en `.mjs` (ESM puro, zero compile step) o TypeScript con build? Trade-off: `.mjs` simplifica el deploy a Claude Console (un solo `node src/index.mjs`); TS aporta type safety pero exige `tsc` en el deploy pipeline. **Recomendación analyst**: `.mjs` para minimizar fricción en el managed env. Architect decide en F2.

- **DT-B** [VERIFICADO 2026-04-29]: Domain EIP-712 para PYUSD en Kite testnet:
  ```js
  { name: 'PYUSD', version: '1', chainId: 2368, verifyingContract: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9' }
  ```
  Source: `scripts/smoke-prod-via-app-wasiai.mjs:51-56` + `.env.example:117-119`.

- **DT-C** [VERIFICADO 2026-04-29]: Decimals de PYUSD = **18** (NO 6). El `value` en el `authorization` se expresa en wei (BigInt). Default `KITE_PAYMENT_AMOUNT=1000000000000000000` confirma 1 PYUSD = 10^18 wei. Source: `.env.example:106`.

- **DT-D** [VERIFICADO 2026-04-29]: Formato del envelope `payment-signature`:
  ```js
  base64(JSON.stringify({
    signature,                                      // 0x...
    authorization: { from, to, value, validAfter, validBefore, nonce },  // value/validAfter/validBefore como string, nonce como 0x bytes32
    network: `eip155:${chainId}`                    // ej. "eip155:2368"
  }))
  ```
  Match exacto con `scripts/smoke-prod-via-app-wasiai.mjs:64-68`. Cualquier deriva rompe el verify del facilitator.

- **DT-E** [PROPUESTO]: `validBefore = now() + 300` segundos (5 min) — coincide con el smoke script. `validAfter = 0`. `nonce = randomBytes(32)`. Architect valida en F2.

- **DT-F** [PROPUESTO]: MCP transport = `stdio` (canonical para managed envs). Architect confirma compat con Claude Console. Sin HTTP transport en esta HU.

- **DT-G** [NEEDS CLARIFICATION]: ¿El MCP server debe leer la `OPERATOR_PRIVATE_KEY` directamente o aceptar override por-call? El brief dice "PK SOLO via env, nunca en logs" (CD-2) — analyst interpreta esto como **env-only**, sin override por-call. Architect confirma o introduce override seguro en F2.

- **DT-H** [PROPUESTO]: Network/chain del MCP cliente está **lockeada a Kite testnet (chainId 2368) + PYUSD** en esta HU. Soporte para Kite mainnet (2366, USDC.e) o Avalanche queda fuera y va a HU posterior. La razón: el cliente sólo necesita firmar el INBOUND. El outbound mainnet lo decide el server.

## Constraint Directives (CD-N)

- **CD-1**: Sin hardcodes — gateway URL, contract address, chain ID, decimals todos configurables via env con defaults sensatos (testnet PYUSD).
- **CD-2**: Private key SOLO via env. PROHIBIDO incluirla en logs, error messages, traces, telemetry, response bodies, o cualquier output del proceso. Tests SHALL probar este invariant (AC-9).
- **CD-3**: OBLIGATORIO compatibilidad con `@modelcontextprotocol/sdk` ≥ 1.0.0. Si la API cambió en una versión más reciente, Architect documenta la versión exacta pinneada en F2.
- **CD-4**: Implementación stateless — cada tool call es independiente, sin in-memory cache de signatures, sin sesión, sin state cross-call. Justificación: predictability bajo crashes del managed env.
- **CD-5**: Match exacto con el envelope format del smoke script (`scripts/smoke-prod-via-app-wasiai.mjs:64-68`). Cualquier divergencia rompe `verify()` del facilitator. Architect SHALL incluir un golden test que pinee el output base64 contra una PK fija + nonce fijo + validBefore fijo.
- **CD-6**: Logs estructurados (JSON una-línea-por-evento) con campos canónicos `{ ts, level, tool, stage, gateway, operator, ok }`. PROHIBIDO `console.log` plano excepto en startup banner.
- **CD-7**: PROHIBIDO ejecutar requests HTTP a hosts privados (RFC1918, link-local, loopback) salvo en modo dev explícito (`NODE_ENV=development`). Defensa SSRF — un agent malicioso podría apuntar a `http://169.254.169.254` (AWS metadata) o servicios internos. Architect decide si reusa pattern `validateRegistryUrl` del repo o duplica simple. (Match con AC-8.)
- **CD-8**: PROHIBIDO commitear `.env` real. `.gitignore` SHALL excluir `.env*` con excepción explícita de `.env.example` (AC-15).
- **CD-9**: OBLIGATORIO que `npm install && npm test` corra en CI sin tocar la red. Tests con mocks de fetch.
- **CD-10**: PROHIBIDO outputs no-determinísticos en signing (excepto `nonce` y `validBefore`, que se mockean en tests). Toda otra parte del envelope SHALL ser determinístico dado el input.

## Análisis de paralelismo

- **NO bloquea otras HUs**. Es un paquete client-side independiente bajo `mcp-servers/`. Server-side `src/` no se toca.
- **NO depende de HUs en flight**. Las DTs B/C/D quedaron lockeadas con la actividad del 2026-04-29 (el smoke script vigente las prueba). Mainnet hybrid mode (068) ya está activo en `main@43091fd`.
- **Puede correr en paralelo con**: cualquier HU server-side (e.g. WKH-SEC-02 RLS, WKH-54 tasks ownership) — no comparten archivos.
- **Bloqueante para**: la demo del hackathon de Kite. La validación E2E mainnet con dinero real depende de mergear esta HU primero (gate humano post-merge).
- **Predecesor histórico**: `doc/sdd/042-mcp-server-x402/` (DONE, 2026-04-13) — implementación anterior, sirve como referencia de patterns pero está desactualizada respecto al envelope x402 v2 + decimals 18 + mainnet hybrid. Architect en F2 decide si reusa partes (e.g. SSRF allowlist) o reescribe limpio.

## Missing Inputs

- **[NEEDS CLARIFICATION en F2]** DT-G: ¿override de PK por-call permitido o estrictamente env-only? Default analyst = env-only.
- **[NEEDS CLARIFICATION en F2]** DT-A: `.mjs` vs `.ts`. Default analyst = `.mjs` (deploy simplicity).
- **[NEEDS CLARIFICATION en F2]** ¿Tool adicional `poll_task(taskId)` para los flujos asíncronos de `/tasks`? Brief dice 3 tools y nada más, analyst respeta el scope. Si Architect detecta que sin polling el flujo no completa para flows asíncronos, abrir como HU posterior.
- **[NEEDS CLARIFICATION en F2]** ¿El MCP server expone `health` o `version` como tool? Brief no lo pide. Default = no.
- **[RESUELTO en F1]** Gateway URL: default `https://app.wasiai.io` confirmado (AC-7).
- **[RESUELTO en F1]** Token/chain default: PYUSD/Kite testnet 2368 (DT-B/C, AC-3).
- **[RESUELTO en F1]** Smart Sizing: QUALITY confirmado (ver veredicto en sección Sizing).

## Categorías de riesgo (para Adversary en F2)

1. **PK leakage** (alto impacto, bajo prob): logs/error messages — mitigado por AC-9 + CD-2 + tests.
2. **Envelope drift** (alto impacto, alto prob si no hay golden test): si el formato divirge del smoke script → 4xx en mainnet → demo fail. Mitigado por CD-5.
3. **SSRF** (medio impacto, medio prob): un agent malicioso pasa `endpoint=http://169.254.169.254/...`. Mitigado por CD-7 + AC-8.
4. **Replay attacks** (bajo impacto en testnet, medio en mainnet): nonce predecible → tx duplicada. Mitigado por nonce 32 bytes random.
5. **Dependency confusion / supply chain** (alto impacto si pasa, bajo prob): el deploy a Claude Console requiere `npm install` en el managed env. Architect en F2 evalúa si pinear deps con lockfile commiteado.
6. **Prompt injection desde el agent**: un agent ataca con `payload` malicioso intentando overridear `OPERATOR_PRIVATE_KEY`. Mitigado por AC-10.
7. **Cap bypass**: agent firma autorizaciones masivas. Mitigado por AC-11 + `MCP_MAX_AMOUNT_WEI_DEFAULT`.
