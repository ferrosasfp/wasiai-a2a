# DONE Report — WKH-64 [MCP-X402] wasiai-x402 MCP server

> Pipeline NexusAgil QUALITY AUTO completo
> Branch: feat/069-wkh-64-mcp-x402 | Ultimo commit: aa3e587
> Fecha: 2026-04-30 | Pipeline duration: ~80 min wallclock

---

## Resumen ejecutivo

Se construyo un paquete MCP server standalone (`mcp-servers/wasiai-x402/`, 14 archivos) que expone tres tools (`discover_agents`, `get_payment_quote`, `pay_x402`) para que un agent administrado en Claude Console (Sonnet 4.6) ejecute pagos x402 contra `app.wasiai.io` sin codigo local. El paquete implementa firma EIP-3009 sobre PYUSD/Kite testnet (chainId 2368), con defense-in-depth en tres capas para SSRF y sin exponer la `OPERATOR_PRIVATE_KEY` en ningun output.

Para el negocio, esto desbloquea el demo del hackathon Kite: un agent gestionado por Anthropic puede ahora ejecutar agentic commerce real (Kite testnet PYUSD inbound + Avalanche mainnet USDC outbound) sin que el operador despliegue codigo propio. El pipeline requirio 3 iteraciones de fix-pack que cerraron 5 BLQs de seguridad y agregaron 21 tests adversariales; el resultado es un server con 75/75 tests y veredicto APROBADO tanto en AR iter 4 como en F4 QA.

---

## Artefactos

| Tipo | Path | Lineas | Status |
|------|------|--------|--------|
| Work Item | doc/sdd/069-wkh-64-mcp-x402/work-item.md | 168 | HU_APPROVED |
| SDD | doc/sdd/069-wkh-64-mcp-x402/sdd.md | ~532 | SPEC_APPROVED |
| Story File | doc/sdd/069-wkh-64-mcp-x402/story-WKH-64.md | ~1392 | READY_FOR_F3 |
| AR Report | doc/sdd/069-wkh-64-mcp-x402/ar-report.md | 325 | iter 4: APROBADO |
| QA Report | doc/sdd/069-wkh-64-mcp-x402/qa-report.md | 166 | APROBADO |
| Auto-Blindaje | doc/sdd/069-wkh-64-mcp-x402/auto-blindaje.md | ~107 | DONE (10 entradas) |
| Implementation | mcp-servers/wasiai-x402/ (14 archivos) | ~3360 total | 75/75 tests |

---

## Pipeline timeline

| Fase | Sub-agente | Output | Duracion |
|------|-----------|--------|----------|
| F0+F1 | nexus-analyst | work-item.md (16 ACs en EARS, 7 DTs, 10 CDs) | ~5 min |
| F2 | nexus-architect | sdd.md (14 archivos a crear, 14 DTs, 16 CDs, 4 waves, 36 tests) | ~8 min |
| F2.5 | nexus-architect | story-WKH-64.md (~1392 lineas, waves 0-3 detalladas) | ~7 min |
| F3 | nexus-dev | 14 archivos, 54 tests, commit 4c28f4d | ~13 min |
| AR iter 1 | nexus-adversary | BLOQUEANTE — 1 BLQ-ALTO + 2 BLQ-BAJO + 3 MENORs | ~10 min |
| Fix iter 1 | nexus-dev | SSRF runtime guard + error sanitizacion + signature truncado, commit df1547b, 61 tests | ~5 min |
| re-AR iter 2 | nexus-adversary | BLOQUEANTE — 1 nuevo BLQ (backslash bypass `isPathOnly`) | ~7 min |
| Fix iter 2 | nexus-dev | `resolveEndpoint` post-resolution host check + log event clobber fix, commit a8afc95, 70 tests | ~6 min |
| re-AR iter 3 | nexus-adversary | BLOQUEANTE — 1 nuevo BLQ (redirect-follow leak del envelope) | ~5 min |
| Fix iter 3 | nexus-dev | `redirect:'error'` en 4 fetch calls + non-string guard + gateway-path doc, commit aa3e587, 75 tests | ~6 min |
| AR iter 4 | nexus-adversary | APROBADO — PoC real verificado, 5/5 BLQs cerrados | ~3 min |
| F4 QA | nexus-qa | APROBADO — 16/16 ACs + 16/16 CDs + smoke local + golden vector match | ~5 min |
| DONE | nexus-docs | este reporte | ~5 min |

---

## ACs cumplidos (16/16)

| AC | Status | Evidencia archivo:linea | Tests |
|----|--------|------------------------|-------|
| AC-1 `discover_agents` GET /api/v1/capabilities | PASS | `src/index.mjs:134-175`; URL params :135-138 | T25, T26 |
| AC-2 `get_payment_quote` POST sin firma + 402 capture | PASS | `src/index.mjs:178-261`; sin `payment-signature` :207; `accepts[0]` :251-260 | T27, T28 |
| AC-3 `pay_x402` full flow EIP-3009 PYUSD/Kite | PASS | `src/index.mjs:264-483`; `src/sign.mjs:27-85`; domain/types/envelope match smoke script | T29, T01 (golden vector) |
| AC-4 gateway error → `{ok:false, stage, status, body}` | PASS | `src/index.mjs:334-340` (probe non-402); `:470-472` (settle non-200) | T30, T31 |
| AC-5 sign throw → `{ok:false, stage:'sign', error sin PK}` | PASS | `src/index.mjs:398-418`; `isOurOwn` suprime mensaje viem | T32, T-Y1 |
| AC-6 PK ausente/malformada → exit != 0 con msg exacto | PASS | `src/config.mjs:25-31`; runtime verificado | T09, T10, T11, T12 |
| AC-7 gateway URL no seteada → fallback + warn-once | PASS | `src/config.mjs:41-44`; JSON `config.gateway-default` una vez | T14; smoke confirmado |
| AC-8 gateway URL invalida → exit != 0 | PASS | `src/url-validator.mjs:67-116`; scheme/literal/private-IP checks; runtime verificado | T15, T22, T23; smoke confirmado |
| AC-9 PK nunca en logs (spy console.*) | PASS | `src/log.mjs:13-18` REDACT_KEYS; spy 6+ paths → 0 matches PK | T33 |
| AC-10 input con PK/sig/auth ignorados + warn-once | PASS | `src/index.mjs:22-43` FORBIDDEN_INPUT_KEYS + sanitizeInput; `:35-41` warn-once | T34, Bonus AC-10 |
| AC-11 `MCP_MAX_AMOUNT_WEI_DEFAULT` guard pre-sign | PASS | `src/index.mjs:360-381`; guard checks ANTES de firmar; per-call priority `:118-129` | T35, Bonus V6.2 |
| AC-12 suite golden vector + PK rejection + URL invalid + 402 parse | PASS | 75 tests en 4 archivos; golden T01; PK rejection T09-T12; URL T16-T24; 402 T27/T29 | meta-AC |
| AC-13 README 3 secciones canonicas | PASS | `README.md:20` Setup local; `:53` Deploy to Claude Console; `:89` Security warnings | grep verificado |
| AC-14 `.env.example` documenta TODAS las vars | PASS | `.env.example:15-65`; 10 vars con comentarios name/required/default/format/example | 10 vars contadas |
| AC-15 `.gitignore` excluye `.env*` NO excluye `.env.example` | PASS | `.gitignore:1-4`; verificado con git check-ignore | git check-ignore OK |
| AC-16 logs JSON-line con `{ts, level, tool, stage, gateway, operator, ok}` | PASS | `src/log.mjs:53-61`; operator = address 42 chars, no PK | T36; smoke JSON confirmado |

---

## BLQs encontrados y resueltos (5/5)

| # | Iteracion | Severidad | Descripcion | Fix | Tests |
|---|----------|-----------|-------------|-----|-------|
| BLQ-ALTO-1 | AR iter 1 | ALTO | SSRF runtime bypass: `new URL(endpoint, base)` ignora base si endpoint es absoluto → operator firma envelope sobre host del atacante → drain wallet + AWS IMDS leak | `isPathOnly()` + `resolveEndpoint()` post-resolution host check en `src/url-validator.mjs` y `src/index.mjs` | T-X1..T-X8 |
| BLQ-BAJO-2 | AR iter 1 | BAJO | Mensaje de error de viem crudo en `r.error` → fingerprint de version de libreria al agente | Whitelist de mensajes propios; viem throws → `'signing failed (see stderr logs)'` | T-Y1 |
| BLQ-BAJO-3 | AR iter 1 | BAJO | Signature truncada a 10 chars en logs → 40 bits, fingerprinteable cross-session | `TRUNCATE_KEYS_SHORT = {signature}` → 4 chars (16 bits); `TRUNCATE_KEYS_LONG = {xPaymentHeader}` → 10 chars | T-Z1 |
| BLQ-iter2-1 | AR iter 2 | ALTO | Backslash bypass: `'/\evil.com/x'` pasa `isPathOnly` pero `new URL` resuelve a `evil.com` | `resolveEndpoint`: validacion post-`new URL` comparando `target.host === gatewayUrl.host && target.protocol === gatewayUrl.protocol`; `isPathOnly` agrega rechazo explicito de backslash | T-X9..T-X10 |
| BLQ-iter3-1 | AR iter 3 | ALTO | `fetch()` default `redirect:'follow'` → envelope EIP-3009 viaja intacto al host del 302 Location, incluso cross-origin (WHATWG solo despoja Authorization/Cookie) → replay del envelope → drain | `redirect:'error'` en las 4 llamadas fetch; `isRedirectError()` detecta el shape y devuelve mensaje estable | T-X11..T-X14 |

---

## Tests adversariales agregados durante fix-packs (21)

**Fix-pack iter 1 (df1547b):** T-X1, T-X2, T-X3, T-X4, T-X5, T-X6, T-X7, T-X8, T-Y1, T-Z1 (10 tests) — SSRF absolute URL, protocol-relative, RFC1918, AWS IMDS; sign error sanitizacion; signature truncado.

**Fix-pack iter 2 (a8afc95):** T-X9, T-X10, T-MNR-iter2-1 (3 tests) — backslash bypass; log event clobber.

**Fix-pack iter 3 (aa3e587):** T-X11, T-X12, T-X13, T-X14, T-MNR-iter3-1 (5 tests) — redirect 302/301 en settle/probe/discover; non-string input a resolveEndpoint.

Bonus adversariales (F3 original + story bonuses): 3 tests (Bonus V6.2, Bonus V7.1, Bonus AC-10).

Total post-F3: 75/75 (54 originales + 21 adversariales).

---

## Decisiones tecnicas finales (DTs)

| DT | Titulo | Decision final |
|----|--------|----------------|
| DT-A | .mjs vs TypeScript | `.mjs` ESM puro — zero compile step, deploy simplificado a Claude Console |
| DT-B | Domain EIP-712 PYUSD/Kite | `{name:'PYUSD', version:'1', chainId:2368, verifyingContract:'0x8E04D099...'}` — match exacto smoke script |
| DT-C | Decimals PYUSD | 18 (no 6). `value` en wei como BigInt. 1 PYUSD = 10^18 wei |
| DT-D | Formato envelope | `base64(JSON({signature, authorization:{from,to,value(str),validAfter,validBefore,nonce(0xhex)}, network:'eip155:2368'}))` |
| DT-E | validBefore/validAfter/nonce | `validBefore = now() + 300s`, `validAfter = '0'`, `nonce = randomBytes(32)` con prefijo 0x |
| DT-F | MCP transport | `stdio` — canonical para managed envs de Claude Console |
| DT-G | PK override por call | Prohibido — env-only. PK leida on-demand en cada sign call (CD-AB-1) |
| DT-H | Multi-chain dinamico | Lockeado a Kite testnet 2368 + PYUSD. Soporte dinamico queda para HU posterior |
| DT-I | Test runner | `node --test` builtin — zero-dep, no vitest/jest. Glob explicito: `'tests/*.test.mjs'` |
| DT-J | SSRF guard | `isPathOnly` (pre-parse) + `resolveEndpoint` post-`new URL` host check (defense-in-depth) |
| DT-K | redirect en fetch | `redirect:'error'` — gateway legitimo no necesita 3xx; safer-by-default |
| DT-L | Error sanitizacion | Whitelist de mensajes propios; cualquier throw de libreria → label estable, detalle a stderr |
| DT-M | Signature en logs | Truncado a 4 chars (16 bits) — suficiente para detectar duplicados intra-session, insuficiente para correlation |
| DT-N | MCP SDK version | Pin `^1.29.0` (instalado 1.29.0, SDD decia `^1.0.0`; mas restrictivo, compatible semver) |

---

## Constraint Directives (CDs)

| CD | Descripcion | Status final |
|----|-------------|-------------|
| CD-1 | Sin hardcodes — gateway URL, contract, chainId, decimals via env | PASS |
| CD-2 | PK solo via env, prohibida en logs/errors/responses | PASS |
| CD-3 | MCP SDK >= 1.0.0 | PASS (pin ^1.29.0) |
| CD-4 | Stateless — cada call independiente, sin cache cross-call | PASS |
| CD-5 | Envelope match exacto smoke script | PASS (T01 golden vector pina base64 completo) |
| CD-6 | Logs JSON-line a stderr + stdout libre para MCP frames | PASS |
| CD-7 | No SSRF a hosts privados | PASS (3 capas: isPathOnly + resolveEndpoint + redirect:'error') |
| CD-8 | `.gitignore` excluye `.env*` salvo `.env.example` | PASS |
| CD-9 | `npm install && npm test` corre sin red | PASS (fetch mocked, lockfile commiteado) |
| CD-10 | Output deterministico dado inputs | PASS (T01) |
| CD-11 | Test runner = node:test, no vitest/jest | PASS |
| CD-12 | Config lee env on-demand, no cachea | PASS (`sign.mjs:18` lee process.env en cada call) |
| CD-13 | Auditar fixtures ante threshold nuevo | N/A (no se introdujo threshold nuevo) |
| CD-14 | PK nunca en `loadConfig()` returned | PASS (`config.mjs:91-101` retorna operatorAddress, T13) |
| CD-15 | Logger redacta keys conocidas | PASS (REDACT_KEYS + TRUNCATE_KEYS_SHORT/LONG) |
| CD-16 | No `process.exit()` en tool handlers | PASS (solo en `main()` startup) |
| CD-AB-1 | Config no cachea (getter dinamico) | PASS |
| CD-AB-2 | Fixtures vs threshold | N/A |
| CD-AB-3 | No mezclar APIs test frameworks | PASS (solo node:test + node:assert/strict) |

---

## Auto-Blindaje aplicado de HUs anteriores

| Origen | Leccion aplicada | CD generado |
|--------|-----------------|-------------|
| HU-068 auto-blindaje | `readonly` field no refleja env-var dinamico — preferir getter on-demand | CD-AB-1: `loadConfig()` no cachea; `sign.mjs` lee env en cada call |
| HU-064 auto-blindaje | Cuando se introduce un MIN_LENGTH, auditar TODOS los fixtures de tests que setean esa env | CD-AB-2: documentado en SDD; N/A en esta HU (no se agrego threshold) |
| HU-064 auto-blindaje | No mezclar APIs de Jest/vitest/node:test | CD-AB-3: pin a `node:test` + `node:assert/strict` en los 4 archivos de test |

---

## Auto-Blindaje generado por esta HU (lecciones para HUs futuras)

Ver `doc/sdd/069-wkh-64-mcp-x402/auto-blindaje.md` para el detalle completo con contexto, causa raiz y patrón de aplicacion. Resumen de las 10 entradas:

1. **`node --test` no recursa en Node v22**: usar glob explicito `'tests/*.test.mjs'`, no `tests/` como directorio. Aplicar en cualquier paquete nuevo bajo `mcp-servers/*` o `scripts/*`.

2. **Tests de concurrencia no pueden usar canned-responses con indice secuencial**: `Promise.all` interleaves. El mock debe routear por contenido del request (presencia de header, URL), no por `idx++`.

3. **SSRF runtime via `new URL(endpoint, base)`**: si el endpoint viene de input no-confiable y es absoluto, `base` se ignora. Patron inviolable: validar AFTER `new URL`, comparando `target.host === expectedGateway.host`. AR debe marcar BLOQUEANTE cualquier PR nuevo con heuristica string-only sin host check post-`new URL`.

4. **viem internals leaked en error messages**: `e.message` de libreria externa puede exponer version banners, paths internos. Patron: whitelist de mensajes propios + todo lo demas → label estable al caller; detalle completo a stderr.

5. **Signature truncada a 10 chars = fingerprinteable (40 bits)**: para datos criptograficos en logs, regla: si truncado × bits-por-char >= 32 bits, es fingerprinteable. Default 16 bits (4 hex chars).

6. **Backslash bypass de `isPathOnly`**: `'/\evil.com/x'` pasa `startsWith('/')` pero el parser WHATWG resuelve a `evil.com`. Cualquier heuristica string-only antes de `new URL` tiene edge cases cuando el parser cambia. Solucion: validacion post-resolucion.

7. **`event` key clobber en log payload**: si el spread de `fields` incluye una key `event`, sobreescribe el event canonico del logger. Ban list para payload keys: `event`, `level`, `ts`. Considerar eslint rule custom.

8. **`fetch()` redirect-follow leak**: WHATWG solo despoja `Authorization`/`Cookie`/`Proxy-Authorization` en cross-origin redirects; headers custom como `payment-signature` viajan al host del 3xx. Regla: cualquier fetch con header de auth/firma DEBE llevar `redirect:'error'`. AR/CR debe marcar BLOQUEANTE si se omite.

9. **`resolveEndpoint` non-string input**: `new URL(null, base)` parsea como `'null'`; `new URL({}, base)` como `'[object Object]'`. Siempre validar `typeof endpoint === 'string'` antes de `new URL`.

10. **Gateway URL con path no-trivial como base**: `new URL(endpoint, base)` con base path-bearing tiene reglas WHATWG sutiles. Documentar origin-only en env vars que representen base URL; si security-critical, enforce runtime.

---

## Archivos modificados (14 archivos, solo `mcp-servers/wasiai-x402/`)

| Dominio | Archivos |
|---------|---------|
| Config & Scaffold | `package.json`, `package-lock.json`, `.env.example`, `.gitignore` |
| Source | `src/index.mjs`, `src/config.mjs`, `src/sign.mjs`, `src/log.mjs`, `src/url-validator.mjs` |
| Tests | `tests/sign.test.mjs`, `tests/config.test.mjs`, `tests/url-validator.test.mjs`, `tests/tools.test.mjs` |
| Documentacion | `README.md` |

Ningun archivo fuera de `mcp-servers/wasiai-x402/` fue modificado. `src/` del repo principal intacto.

---

## Decisiones diferidas a backlog

| Item | Racional | Ticket sugerido |
|------|----------|-----------------|
| Multi-chain dinamico (Kite mainnet 2366 / Avalanche 43114 como inbound) | Lockeado en esta HU a testnet 2368. Server-side ya soporta outbound mainnet (068). | HU posterior WKH-64-multi-chain |
| Poll_task tool para flujos asincronos `/tasks` | 3 tools es el scope acordado. Si el flow async no completa sin polling, agregar en HU siguiente. | HU posterior |
| Publicar `mcp-servers/wasiai-x402` a npm | Fuera de scope explicito. | HU posterior |
| `dist` sin slash en `.gitignore` (MNR-1) | Cosmético — archivo plano `dist` no es realista. | Backlog minimo |
| RLS Postgres-level en `a2a_agent_keys` (TD-SEC-01 / WKH-SEC-02) | Fuera de scope de esta HU. Proteccion hoy = app-layer ownership check. | WKH-SEC-02 |

---

## Metricas finales

| Metrica | Valor |
|---------|-------|
| Archivos creados | 14 |
| Lineas de codigo (src/, sin tests, sin lockfile) | ~1100 |
| Lineas de tests | ~900 |
| Tests | 75/75 PASS |
| Tests adversariales agregados en fix-packs | 21 |
| BLQs encontrados | 5 |
| BLQs resueltos | 5/5 |
| MENORs abiertos no bloqueantes | 2 (MNR-1 cosmético, MNR-pkg DT-N) |
| Iteraciones de AR | 4 (1 inicial BLOQUEANTE + 3 fix-pack + 1 APROBADO) |
| Commits de implementacion | 4 (4c28f4d, df1547b, a8afc95, aa3e587) |
| Duracion wallclock total | ~80 min |
| Scope drift | CERO — 100% bajo `mcp-servers/wasiai-x402/` |

---

## PR

PR creado: ver URL reportada al orquestador en el resumen ejecutivo.

---

## Post-merge gate humano

Despues del merge a main, el humano debe:

1. Configurar el MCP server en Claude Console managed env (`wasiai-orchestrator-env`): instrucciones en `mcp-servers/wasiai-x402/README.md` seccion "Deploy to Claude Console managed env".
2. Setear `OPERATOR_PRIVATE_KEY` con la PK del operator wallet funded en Kite testnet (PYUSD balance >= 1 PYUSD para la demo; ver blast radius en README.md seccion "Security warnings").
3. Verificar smoke local: `OPERATOR_PRIVATE_KEY=0x<funded-pk> node mcp-servers/wasiai-x402/src/index.mjs` — confirmar `mcp.startup` + `mcp.connected` en stderr, stdout limpio.
4. Ejecutar primer `pay_x402` real desde Claude Console (costo ~$0.06 USDC mainnet outbound via Avalanche, mas protocol fee 1%).
5. Verificar `kiteTxHash` + `downstreamTxHash` en explorers (Kite testnet + Avalanche C-Chain mainnet).

---

## Referencias

- Jira ticket: https://ferrosasfp.atlassian.net/browse/WKH-64
- Predecesor historico (referencia, no copiado): `doc/sdd/042-mcp-server-x402/` (DONE 2026-04-13, predates mainnet hybrid + envelope v2 + decimals 18)
- Smoke script golden vector: `scripts/smoke-prod-via-app-wasiai.mjs:47-68`
- HACKATHON-FINAL.md (narrativa hackathon)
- Sesion 2026-04-28 (MAINNET HYBRID MODE ACTIVATED)
- Upstream HUs relevantes: 068 (mainnet hybrid), 065 (forward-key middleware), 062 (SSRF protection server-side)

---

*DONE Report generado por NexusAgil Docs (nexus-docs) — 2026-04-30*
