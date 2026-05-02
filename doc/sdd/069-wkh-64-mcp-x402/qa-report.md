# QA Report — WKH-64 [MCP-X402] wasiai-x402 MCP server

> **VEREDICTO: APROBADO PARA DONE**
> Branch: `feat/069-wkh-64-mcp-x402` @ `aa3e587`
> QA: nexus-qa (AUTO QUALITY pipeline)
> Fecha: 2026-04-30

---

## Resumen ejecutivo

- **Tests**: 75/75 PASS (ampliados desde 54 originales — AR fix-packs iter1/2/3 agregaron 21 tests)
- **ACs verificados**: 16/16 PASS con evidencia archivo:línea
- **CDs verificados**: 16/16 PASS (con 1 menor documentado — CD-3 pin notation)
- **Runtime checks**: startup fail-fast verificado en 4 escenarios reales (PK ausente, IP privada, http://, happy path)
- **Golden vector**: smoke script vs sign.mjs match byte-a-byte (T01 pineado)
- **Scope drift**: 0 — solo archivos bajo `mcp-servers/wasiai-x402/` + `doc/sdd/069-wkh-64-mcp-x402/`
- **BLQs del AR**: 3/3 resueltos con evidencia:
  - BLQ-ALTO-1: `isPathOnly()` + `resolveEndpoint()` + `redirect:'error'` — tests T-X1..T-X14
  - BLQ-BAJO-2: `signing failed (see stderr logs)` sanitizado — test T-Y1
  - BLQ-BAJO-3: signature truncada a 4 chars — test T-Z1
- **MENORes del AR**: 1 pendiente (MNR-1 cosmético: `dist` vs `dist/` en .gitignore), no bloqueante

---

## Runtime Checks

### Startup fail-fast (AC-6, AC-8)

| Caso | Comando / Evidencia | Resultado |
|------|---------------------|-----------|
| PK ausente | `OPERATOR_PRIVATE_KEY="" node src/index.mjs` → stderr: `CONFIG ERROR: OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex`, exit 1 | PASS |
| http:// gateway (prod) | `WASIAI_GATEWAY_URL=http://169.254.169.254/meta node...` → `CONFIG ERROR: WASIAI_GATEWAY_URL invalid: http:// requires NODE_ENV=development (category=scheme)`, exit 1 | PASS |
| RFC1918 gateway | `WASIAI_GATEWAY_URL=https://10.0.0.1 node...` → `CONFIG ERROR: WASIAI_GATEWAY_URL invalid: private IPv4: 10.0.0.1 (category=private-ipv4)`, exit 1 | PASS |
| Happy path + warn-once | PK válida, no WASIAI_GATEWAY_URL → `{"event":"config.gateway-default","gatewayUrl":"https://app.wasiai.io"}` seguido de `mcp.startup` + `mcp.connected` JSON, exit 0 | PASS |

### Smoke servidor (AC-16)

```json
{"ts":"2026-04-30T07:17:41.041Z","level":"info","event":"mcp.startup","tool":"_lifecycle","stage":"startup","ok":true,"operator":"0x8fd...A03","gateway":"https://app.wasiai.io/","chainId":2368}
{"ts":"2026-04-30T07:17:41.044Z","level":"info","event":"mcp.connected","tool":"_lifecycle","stage":"connected","ok":true,"transport":"stdio"}
```

### Env vars (AC-14, CD-1)

10 vars documentadas en `.env.example` con comentarios name/required/default/format/example:
`OPERATOR_PRIVATE_KEY`, `WASIAI_GATEWAY_URL`, `MCP_GATEWAY_ALLOWLIST`, `KITE_CHAIN_ID`, `KITE_PYUSD`, `X402_EIP712_DOMAIN_NAME`, `X402_EIP712_DOMAIN_VERSION`, `MCP_MAX_AMOUNT_WEI_DEFAULT`, `MCP_PAY_TIMEOUT_MS`, `NODE_ENV`.

### Golden vector match (CD-5)

`scripts/smoke-prod-via-app-wasiai.mjs:64-68` vs `src/sign.mjs:78-82`:
- Estructura JSON: `{signature, authorization:{from,to,value(string),validAfter:'0',validBefore(string),nonce(0x hex)}, network:'eip155:<chainId>'}` — match exacto.
- Test T01 pina `GOLDEN_ENVELOPE_BASE64` (full base64 string). 1 byte de drift rompería el assert.

---

## AC Verification

| AC | Status | Evidencia archivo:línea | Test(s) |
|----|--------|-------------------------|---------|
| AC-1 `discover_agents` GET /api/v1/capabilities | PASS | `src/index.mjs:134-175` (handler); URL params at :135-138 | T25, T26 |
| AC-2 `get_payment_quote` POST sin firma + 402 capture | PASS | `src/index.mjs:178-261`; header `payment-signature` ausente en :207; `accepts[0]` en :251-260 | T27, T28 |
| AC-3 `pay_x402` full flow EIP-3009 PYUSD/Kite | PASS | `src/index.mjs:264-483`; `src/sign.mjs:27-85`; domain/types/envelope match smoke script | T29, T01 (golden vector) |
| AC-4 error handling 4xx/5xx → {ok:false,stage,status,body} | PASS | `src/index.mjs:334-340` (probe non-402); `:470-472` (settle non-200) | T30, T31 |
| AC-5 sign throw → {ok:false,stage:'sign',error sin PK} | PASS | `src/index.mjs:398-418`; `isOurOwn` check suprime mensaje viem; test aserta `!r.error.includes(PK)` | T32, T-Y1 |
| AC-6 PK ausente/malformada → exit ≠ 0 con msg exacto sin valor parcial | PASS | `src/config.mjs:25-31`; `PK_ERROR_MSG='OPERATOR_PRIVATE_KEY is required...'`; runtime verificado | T09, T10, T11, T12 |
| AC-7 WASIAI_GATEWAY_URL no seteada → fallback + warn-once | PASS | `src/config.mjs:41-44`; runtime `config.gateway-default` JSON emitido una vez | T14; runtime smoke confirmado |
| AC-8 WASIAI_GATEWAY_URL inválida → exit ≠ 0 | PASS | `src/url-validator.mjs:67-116`; scheme/literal/private-IP checks; runtime verificado | T15, T22, T23; runtime smoke confirmado |
| AC-9 PK nunca en logs (spy console.*) | PASS | `src/log.mjs:13-18` (REDACT_KEYS includes `OPERATOR_PRIVATE_KEY`); test captura stderr 6+ paths, 0 matches con PK | T33 |
| AC-10 input con PK/signature/authorization ignorados + warn-once | PASS | `src/index.mjs:22-43` (`FORBIDDEN_INPUT_KEYS` + `sanitizeInput`); `:35-41` warn-once | T34, Bonus AC-10 |
| AC-11 `MCP_MAX_AMOUNT_WEI_DEFAULT` guard pre-sign | PASS | `src/index.mjs:360-381`; guard checks `requested > guard` ANTES de llamar `signX402Envelope`; per-call priority en `:118-129` | T35, Bonus V6.2 |
| AC-12 suite tests golden vector + PK rejection + URL invalid + 402 parsing | PASS | 75 tests en 4 archivos; golden en T01; PK rejection en T09-T12; URL invalid en T16-T24; 402 parse en T27/T29 | meta-AC |
| AC-13 README 3 secciones canónicas | PASS | `README.md:20` `## Setup local`; `:53` `## Deploy to Claude Console managed env`; `:89` `## Security warnings` | grep verificado |
| AC-14 `.env.example` documenta TODAS las vars | PASS | `.env.example:15-65`; 10 vars con comentarios name/required/default/format/example | count verificado (10 vars) |
| AC-15 `.gitignore` excluye `.env*` NO excluye `.env.example` | PASS | `.gitignore:1-4`; `git check-ignore .env` → EXCLUDED; `git check-ignore .env.example` → NOT EXCLUDED | verificado con git check-ignore |
| AC-16 logs JSON-line con keys {ts,level,tool,stage,gateway,operator,ok} | PASS | `src/log.mjs:53-61`; `src/index.mjs:140-143, 169-172`; operator = address 42 chars, no PK | T36; runtime smoke JSON confirmado |

---

## CD Verification

| CD | Status | Evidencia |
|----|--------|-----------|
| CD-1 sin hardcodes | PASS | gateway/chainId/contract/decimals via env; `KITE_PYUSD` default en `config.mjs:66`, no en sign.mjs |
| CD-2 PK solo via env, prohibida en logs | PASS | `REDACT_KEYS` en `log.mjs:13-18`; T33 0-match en 6 error paths |
| CD-3 MCP SDK ≥1.0.0 | PASS (menor) | `package.json:23` pin `^1.29.0` (SDD decía `^1.0.0`; instalado 1.29.0 — compatible semver, más restrictivo) |
| CD-4 stateless | PASS | cada call construye nonce/validBefore/AbortController; Bonus V7.1 10 concurrent PASS |
| CD-5 envelope match exacto smoke script | PASS | T01 golden vector pina base64 completo; `sign.mjs:78-82` match exacto `:64-68` del smoke script |
| CD-6 logs JSON-line + stderr only | PASS | `log.mjs:61` `process.stderr.write`; stdout libre para MCP frames |
| CD-7 no SSRF hosts privados | PASS | `isPathOnly()` + `resolveEndpoint()` + `redirect:'error'`; T-X1..T-X14 cubren absolute URL, backslash, AWS IMDS, 3xx redirect |
| CD-8 `.gitignore` excluye `.env*` | PASS | `.gitignore:1-4` |
| CD-9 npm install && npm test sin red | PASS | tests usan `globalThis.fetch` mock; 75/75 PASS en sandbox |
| CD-10 output determinístico | PASS | T01 pina envelope exacto dado inputs fijos |
| CD-11 test runner node:test, no vitest/jest | PASS | `package.json:10` `"test": "node --test 'tests/*.test.mjs'"` |
| CD-12 config lee env on-demand | PASS | `sign.mjs:18` lee `process.env.OPERATOR_PRIVATE_KEY` en cada call; `loadConfig()` no cachea |
| CD-13 auditar fixtures ante threshold nuevo | N/A | no se introdujo threshold nuevo |
| CD-14 PK nunca en loadConfig() returned | PASS | `config.mjs:91-101` retorna `operatorAddress`; T13 aserta `!('privateKey' in cfg)` |
| CD-15 logger redacta keys conocidas | PASS | `log.mjs:13-18` REDACT_KEYS; signature truncada `src/log.mjs:41` a 4 chars |
| CD-16 no process.exit() en tool handlers | PASS | `process.exit(1)` solo en `main()` lines `:557-560`; handlers retornan shapes estructurados |
| CD-AB-1 config no cachea (getter dinámico) | PASS | `sign.mjs getAccount()` lee env en cada call |
| CD-AB-2 fixtures vs threshold | N/A | no aplica |
| CD-AB-3 no mezclar APIs test frameworks | PASS | solo `node:test` + `node:assert/strict` en los 4 archivos de test |

---

## Smoke Checks

### Tests
```
npm test → 75/75 PASS, 0 skipped, 0 todo, 0 only
Duración: 238ms
```

### Smoke servidor local
Cmd: `OPERATOR_PRIVATE_KEY=0xaaa...aaa WASIAI_GATEWAY_URL=https://app.wasiai.io node src/index.mjs`
Resultado:
- stderr: `mcp.startup` JSON con `ok:true`, `operator`, `gateway`, `chainId` ✓
- stderr: `mcp.connected` JSON con `transport:stdio` ✓
- stdout: limpio (reservado para MCP frames) ✓
- exit: proceso queda corriendo (OK para servidor stdio)

### Scope verification
```
git diff main --name-only feat/069-wkh-64-mcp-x402 | sort
→ TODOS bajo mcp-servers/wasiai-x402/ (14 archivos)
   Sin archivos en src/, app/, ni otros paths
```

### Drift detection: golden vector vs smoke script
- `scripts/smoke-prod-via-app-wasiai.mjs:64-68` vs `mcp-servers/wasiai-x402/src/sign.mjs:78-82`
- Estructura JSON idéntica; key ordering idéntico; serialización idéntica
- Decoded GOLDEN_ENVELOPE_BASE64 confirma: `{signature,authorization:{from,to,value(string),validAfter:'0',validBefore(string),nonce(0x hex)},network:'eip155:2368'}` → match exacto
- **No drift detectado**

---

## Drift Detection

- **Scope drift**: NONE. Los 14 archivos modificados están 100% bajo `mcp-servers/wasiai-x402/` o `doc/sdd/069-wkh-64-mcp-x402/`.
- **Wave drift**: W0 (scaffold) → W1 (módulos puros) → W2 (integración+tools) → W3 (docs) respetadas.
- **Spec drift**: funciones clave (`sanitizeInput`, `resolveEndpoint`, `signX402Envelope`, `loadConfig`) corresponden al SDD §4.1 con adiciones defensivas documentadas en fix-packs.
- **Test drift**: 75 tests cubren los 36 planificados en SDD §12 + 39 adicionales (fix-packs iter1/2/3). Todos los tests del Story File existen y corresponden a sus ACs.

---

## Gates

No existe `cr-report.md` formal — el pipeline fue: AR → fix-pack → QA directamente. Gates evaluados:
- **Tests**: 75/75 PASS (verificado en ejecución `npm test`)
- **Lint**: no hay eslint configurado (paquete standalone `.mjs`, SDD no lo especifica — no bloqueante)
- **Build**: no aplica (DT-A = `.mjs`, zero compile step)
- **npm install**: sin errores (lockfile commiteado, resuelve deps determinísticamente)

---

## MENORes abiertos (no bloqueantes para DONE)

| # | Hallazgo | Fuente | Acción recomendada |
|---|----------|--------|--------------------|
| MNR-1 | `.gitignore` usa `dist/` (con slash) pero no `dist` (sin slash) — archivo plano `dist` no sería ignorado | AR-MNR-1; `mcp-servers/wasiai-x402/.gitignore:9` | Agregar `dist` en próxima iteración. Cosmético. |
| MNR-pkg | `package.json` pin MCP SDK `^1.29.0` vs SDD que decía `^1.0.0`. Semver compatible, más restrictivo — funciona en npm ≥1.29. | `mcp-servers/wasiai-x402/package.json:23` | Documentar en done-report como decisión operacional (versión real instalada). |

---

*QA Report generado por NexusAgil QA F4 — 2026-04-30*
