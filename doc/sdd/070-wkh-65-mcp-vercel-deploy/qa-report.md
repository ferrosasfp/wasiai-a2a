# QA Report — WKH-65 MCP Vercel Deploy (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-04-29
**Branch**: `feat/070-wkh-65-mcp-vercel-deploy` @ commit `9636383`

---

## Runtime checks

- DB state: N/A — no schema changes en esta HU
- Env parity: N/A — env vars en Vercel son operator-side; no hay CLI de Vercel disponible en sandbox. CD-11 verificado en código (sin hardcodes, sin valores literales en vercel.json)
- Migration applied: N/A — no migrations

## Tests ejecutados

```
103/103 pass, 0 fail, 0 skip, 0 todo
exit code: 0
duration: 383ms
```

Comando: `cd mcp-servers/wasiai-x402 && npm test`

---

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `T-HTTP-04` (http.test.mjs:153) — 200 + serverInfo.name=`wasiai-x402` + serverInfo.version=`0.1.0` + capabilities.tools verificados por assert |
| AC-2 | PASS | `T-HTTP-05` (http.test.mjs:190) — tools/list → 3 tools, names sorted = `[discover_agents, get_payment_quote, pay_x402]`, maxAmountWei schema presente |
| AC-3 | PASS | `T-HTTP-06` (http.test.mjs:222) — tools/call discover_agents delega al handler via handlers.mjs, mock fetch interceptado, redirect:'error' verificado |
| AC-4 | PASS | `T29/T30/T31` (tools.test.mjs:175,211,232) — pay_x402 flujo completo probe→sign→retry, envelope base64 verified, mismos guards que stdio. HTTP path en api/mcp.mjs:116-128 importa handlers.mjs directamente |
| AC-5 | PASS | `T-HTTP-01` (http.test.mjs:92) — sin Authorization → 401 + body `{error:"unauthorized"}`. `T-HTTP-12` (http.test.mjs:493) — auth check BEFORE body parse: malformed JSON body → 401 (nunca llega al parser) |
| AC-6 | PASS | `T-HTTP-02/T-HTTP-03` (http.test.mjs:112,129) — Basic scheme → 401; wrong bearer (same length) → 401. Cuerpo idéntico al AC-5. Bearer presentado no logueado (T-HTTP-03:143) |
| AC-7 | PASS | `T-HTTP-10` (http.test.mjs:400) — MCP_BEARER_TOKEN missing → 500 + `{error:"server misconfigured"}` + log `missing-bearer-token` en stderr. `T-HTTP-10b` (http.test.mjs:420) — OPERATOR_PRIVATE_KEY missing → 500 |
| AC-8 | PASS | `T-HTTP-11` (http.test.mjs:441) — spy en process.stderr.write, 5 paths (missing auth, wrong bearer, malformed, GET, tools/list): PK en lower/upper/0x-form y bearer correcto/incorrecto ausentes del blob |
| AC-9 | PASS | `T-HTTP-08` (http.test.mjs:332) — OPTIONS `https://platform.claude.com` → 204 + Allow-Origin echoed. `T-HTTP-09` (http.test.mjs:354) — evil.com → 204 sin Allow-Origin. `T-HTTP-09b` (http.test.mjs:376) — env vacío → sin Allow-Origin. `T-FIX-1/T-FIX-2` (http.test.mjs:518,548) — POST allowed origin → Allow-Origin + Vary; POST evil.com → sin Allow-Origin |
| AC-10 | PASS | vercel.json:5 — `"maxDuration": 60` bajo `"api/mcp.mjs"` |
| AC-11 | PASS | api/mcp.mjs:186 — `process.env.MCP_BEARER_TOKEN`; vercel.json contiene solo nombre de función sin valores literales. No hay valores hardcoded en código ni en vercel.json |
| AC-12 | PASS | vercel.json (4 líneas) — sólo declara `functions`, `maxDuration`, `runtime`, `regions`. Sin bloque `env` con valores literales |
| AC-13 | PASS | tests/http.test.mjs — 19 tests (T-HTTP-01..12 + T-FIX-1..3): cubre auth 401/500, initialize 200, tools/list×3, tools/call mock, CORS, leak detection. Todos 19 passing |
| AC-14 | PASS | README.md:95 — sección "Deploy a Vercel (Remote MCP via HTTP Streamable transport)": (a) `vercel login` (README:122), (b) `vercel env add MCP_BEARER_TOKEN production` + PK + GATEWAY (README:125-131), (c) `vercel deploy --prod` (README:139), (d) Claude Console "Add Remote MCP" UI con tabla URL + Authorization header (README:145-152) |
| AC-15 | PASS | .env.example:63-70 — `MCP_BEARER_TOKEN`: Required=YES (for HTTP), Format=`hex 64 chars (256 bits)`, Generate=`openssl rand -hex 32`, placeholder=`your-secret-hex-64-chars-here` |
| AC-16 | PASS | src/index.mjs:23-43 — importa handlers desde ./handlers.mjs, re-exporta la misma API. package.json:11 — `"start":"node src/index.mjs"` sin cambios. `T36` (tools.test.mjs:417) pasa; stdio path intacto |

---

## CDs

| CD | Status | Evidencia |
|----|--------|-----------|
| CD-1 | PASS | api/mcp.mjs:186 — PK y bearer sólo desde `process.env.*`. Sin valores literales en código. T-HTTP-11 (http.test.mjs:441) confirma no leak en logs |
| CD-2 | PASS | src/auth.mjs:25,76 — `import { timingSafeEqual } from 'node:crypto'`; `if (!timingSafeEqual(presentedBuf, expectedBuf))`. AUTH-04/AUTH-07 (auth.test.mjs:57,79) verifican comparación timing-safe y length-mismatch path |
| CD-3 | PASS | api/mcp.mjs:41-43 — importa `loadConfig` de config.mjs, `SSRFViolationError` de url-validator.mjs, `* as log` de log.mjs. No hay duplicación de lógica |
| CD-4 | PASS | api/mcp.mjs:46-50 — importa `TOOL_DESCRIPTORS, discoverAgentsHandler, getPaymentQuoteHandler, payX402Handler` directamente de `../src/handlers.mjs` |
| CD-5 | PASS | api/mcp.mjs:43 — `import * as log from '../src/log.mjs'`. Grep confirma 0 instancias de `console.*` en api/mcp.mjs y src/auth.mjs |
| CD-6 | PASS | .env.example:70 — `MCP_BEARER_TOKEN=your-secret-hex-64-chars-here` (placeholder). .env no está trackeado en git (git ls-files confirma vacío) |
| CD-7 | PASS | api/mcp.mjs:186-191 — si `!expectedToken` → log.error + return 500 antes de cualquier procesamiento. T-HTTP-10/T-HTTP-10b passing |
| CD-8 | PASS | api/mcp.mjs:233 — `sessionIdGenerator: undefined` en constructor de WebStandardStreamableHTTPServerTransport |
| CD-9 | PASS | src/handlers.mjs:149,220,305,444 — `redirect: 'error'` en todos los fetch(). T-HTTP-06:273 y T-X11/T-X12/T-X13 verifican la presencia del flag |
| CD-10 | PASS | vercel.json — sin bloque `env` con valores literales. Sólo `functions.api/mcp.mjs.{maxDuration,runtime}` y `regions` |

---

## Drift

- Scope: 0 archivos fuera de `mcp-servers/wasiai-x402/` o `doc/sdd/070-wkh-65-mcp-vercel-deploy/` (git diff main...branch confirma 13 archivos, todos en scope)
- Wave drift: none — 2 commits (feat + fix-pack), orden correcto
- Spec drift: none — vercel.json matchea CD-10/AC-10/DT-C; handlers.mjs extracción mecánica como declarado en work-item
- Test drift: none — tests/http.test.mjs + tests/auth.test.mjs existen y cubren ACs declarados

## Gates (confirmado de CR report)

No hay cr-report.md en disco pero el enunciado QA indica CR re-APROBADO post fix-pack iter 1 (8/8 fixes verificados). Tests locales ejecutados: **103/103 PASS exit 0**. No hay output lint/tsc porque el proyecto es .mjs puro sin tsconfig. Gates: PASS.

## Smoke manual (para operador — post-merge)

```bash
# 1. Verificar stdio no-regression
cd mcp-servers/wasiai-x402
OPERATOR_PRIVATE_KEY=0x<testnet-pk> node src/index.mjs &
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/index.mjs
# Esperado: JSON response con 3 tools

# 2. HTTP smoke (mock local, sin mainnet)
TOKEN=$(openssl rand -hex 32)
MCP_BEARER_TOKEN=$TOKEN OPERATOR_PRIVATE_KEY=0x<testnet-pk> WASIAI_GATEWAY_URL=https://app.wasiai.io \
  node -e "
    import('./api/mcp.mjs').then(m => {
      const req = new Request('http://localhost/api/mcp', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer wrong'},
        body:'{}'
      });
      m.default(req).then(r => console.log('wrong bearer →', r.status)); // expect 401
    });
  "

# 3. Vercel deploy smoke
vercel deploy --prod
curl -X POST https://wasiai-x402-mcp.vercel.app/api/mcp \
  -H "Authorization: Bearer <MCP_BEARER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Esperado: 200 + JSON con tools array de 3 items
```

## Menores informativos (de AR/CR, no bloqueantes)

- MNR-AR-2 (POST CORS echo): resuelto en fix-pack — T-FIX-1/T-FIX-2 passing
- MNR-CR-6 (auth-before-loadConfig): resuelto en fix-pack — T-FIX-3 passing
- Auto-blindaje W3 (event clobbering): resuelto — grep en api/mcp.mjs no encuentra `event:` en payloads de log calls

**Listo para DONE.**
