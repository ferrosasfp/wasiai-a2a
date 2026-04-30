# Auto-Blindaje — WKH-64 (`mcp-servers/wasiai-x402/`)

Errores cometidos durante F3 y sus correcciones, para proteger futuras HUs.

---

### [2026-04-30 00:30] Wave 1 — `node --test tests/` no recursa en Node v22

- **Error**: `npm test` falló con `Error: Cannot find module '...mcp-servers/wasiai-x402/tests'` (MODULE_NOT_FOUND). El script `"test": "node --test tests/"` que figura literal en el Story File §4 W0.1 no funciona en Node v22.
- **Causa raíz**: Node v22 (v22.22.0 en este entorno) cambió el comportamiento de `node --test <path>`: ahora resuelve `tests/` como archivo/módulo, no como carpeta a recorrer. El behavior original (recorrer todos los `.test.mjs` bajo el dir) requiere glob explícito en v22.
- **Fix**: cambiar a `"test": "node --test 'tests/*.test.mjs'"` en `package.json`. Pasa 39 tests (8 sign + 9 config + 22 url-validator con subtests) en una sola invocación.
- **Aplicar en**: cualquier paquete nuevo `mcp-servers/*` o `scripts/*` que use `node --test` builtin como runner. La forma robusta cross-versión es el glob explícito; `node --test <dir>` ya no es portable entre v20 y v22.

---

### [2026-04-30 00:55] Wave 2 — Concurrent test usaba ordering estricto + lookup case-sensitive de header

- **Error**: el bonus test V7.1 (10 concurrent `pay_x402` calls) falló dos veces:
  1. Sólo 7/10 succedían — array de canned responses con orden estricto se rompe cuando 10 probes fire en paralelo y consumen los slots [0..9] que mezclaban 5×{402} y 5×{200}; `pay_x402` veía status 200 en la probe y devolvía `stage:'free'`.
  2. Tras corregir a un fetch-fake header-aware, fallaba con `Buffer.from(undefined)` porque el lookup del header asumía par/impar (probe[0], settle[1], probe[2], settle[3]) — pero el orden está interleaved: pueden venir 10 probes seguidos y 10 settles después.
- **Causa raíz**: tests de concurrencia no pueden usar canned-responses con índice secuencial ni asumir ordering de calls. Tienen que routear por contenido del request (header / URL / body).
- **Fix**:
  1. Mock que retorna 402 si NO viene `payment-signature` y 200 si SÍ.
  2. Recolección de nonces: filtrar calls cuyo header `payment-signature` (case-insensitive) esté presente, en lugar de asumir índices pares/impares.
- **Aplicar en**: cualquier test futuro de concurrencia. Patrón: el fetch-fake tiene que ser pure-function de los args del request; nada de `idx++`. El extractor del lado del test debe filtrar por presencia del header, no por posición.

---

### [2026-04-29 fix-pack iter 1] AR+CR — `new URL(endpoint, base)` aceptaba absoluto → SSRF/replay

- **Error**: `getPaymentQuoteHandler` y `payX402Handler` pasaban el `endpoint` recibido del agent directo a `new URL(endpoint, cfg.gatewayUrl)`. Si el agent (LLM jailbroken o input contaminado) pasaba `endpoint='https://attacker.com/x402'`, el `base` quedaba ignorado por la spec del WHATWG URL constructor → fetch se iba al host del atacante → operator firmaba EIP-3009 sobre challenge atacante → captura → replay al facilitator real → drain.
- **Causa raíz**: el SSRF guard de `validateGatewayUrl` corre solo al startup (sobre `MCP_GATEWAY_URL`), no en runtime sobre el `endpoint` por-call. La asunción de "ya validamos la URL" era válida para el host del gateway, pero el path completo se construía con un input no-validado.
- **Fix**: nuevo `isPathOnly(endpoint)` en `src/url-validator.mjs` que rechaza:
  - strings que no empiezan con `/`
  - strings que empiezan con `//` (protocol-relative URL)
  - non-strings o vacíos
  Llamado en ambos handlers ANTES de `new URL()`. Devuelve `{ok:false, stage:'validation'}` con mensaje no-leakable.
- **Aplicar en**: cualquier handler MCP (presente o futuro) que reciba un `endpoint`/`url`/`path` desde el agent y lo combine con un base configurado. Regla: input del agent → SOLO paths. Si la HU genuinamente necesita URL completa cross-gateway, hay que reaplicar `validateGatewayUrl` en runtime con el `allowlist` correspondiente.

---

### [2026-04-29 fix-pack iter 1] AR+CR — viem internals leaked al agent en sign error

- **Error**: el catch del sign path retornaba `error: \`signing failed: ${e.message}\`` sin filtrar. viem `signTypedData` produce mensajes como `Invalid hex bytes value provided. ... Version: viem@2.48.4` con stack-internal info.
- **Causa raíz**: AC-5 prohíbe leak de PK pero no exigía sanitización general de errores. La asunción de "viem no leakea PK" es correcta pero insuficiente: leakea internals de la lib + versión + path interno.
- **Fix**: en el catch, distinguir errores propios (`OPERATOR_PRIVATE_KEY missing at sign-time` → expone para que el operator detecte misconfig) del resto (cualquier viem throw → mensaje fijo `'signing failed (see stderr logs)'`). El mensaje completo sí va a stderr (operator visibility), pero NUNCA al response del agent.
- **Aplicar en**: cualquier path de error que reciba `e.message` de una librería externa antes de retornarlo al caller. Patrón: whitelist de mensajes propios; everything else → label estable.

---

### [2026-04-29 fix-pack iter 1] AR+CR — signature 10-char fingerprint correlation

- **Error**: `redact()` truncaba `signature` a 10 chars (40 bits). 40 bits es suficiente para fingerprint cross-session: un atacante con acceso a múltiples logs puede correlacionar firmas y mapear envelopes a operators / endpoints.
- **Causa raíz**: el spec inicial pedía "no full signature" pero no fijaba longitud máxima. 10 chars era arbitrario y heredado de `xPaymentHeader` (que es base64 estructurado, distinto material).
- **Fix**: dos sets distintos en `log.mjs`:
  - `TRUNCATE_KEYS_SHORT` = `{ 'signature' }` → 4 chars (16 bits, suficiente para detectar duplicados intra-session, insuficiente para correlation).
  - `TRUNCATE_KEYS_LONG` = `{ 'xPaymentHeader' }` → 10 chars (sigue igual; no es signature material).
- **Aplicar en**: cualquier dato criptográfico futuro en logs. Regla: si la longitud truncada × bits-por-char ≥ 32 bits, es fingerprinteable. Default: 16 bits (4 hex chars) salvo justificación explícita.

---

### [2026-04-30 fix-pack iter 2] Re-AR — backslash bypass de `isPathOnly` (BLQ-iter2-1)

- **Error**: el fix iter 1 (`isPathOnly` con check `startsWith('/')` + `!startsWith('//')`) tenía bypass: `endpoint = '/\evil.com/x'` pasaba la validación (empieza con `/`, no con `//`), pero `new URL('/\\evil.com/x', 'https://app.wasiai.io')` resuelve a `https://evil.com/x`. El operator firmaba EIP-3009 sobre el challenge del attacker → mismo SSRF + replay drain que iter 1 supuestamente cerraba.
- **Causa raíz**: el WHATWG URL parser trata `\` como `/` para schemes especiales (`https:`/`http:`). Cualquier validación basada en string-shape ANTES de `new URL()` está jugando un juego perdido vs el comportamiento real del parser. Las variantes que también bypaseaban: `/\@evil.com`, `/\\evil.com`, `/\/evil.com`, `/\.evil.com`. Cualquier heurística string-only va a tener edge cases nuevos cuando el parser cambie.
- **Fix**: validación **post-resolución**, no string-shape. Nueva función `resolveEndpoint(endpoint, gatewayUrl)` en `src/index.mjs`:
  1. `target = new URL(endpoint, gatewayUrl)` — dejá que el parser haga su trabajo.
  2. `if (target.host !== gatewayUrl.host || target.protocol !== gatewayUrl.protocol) reject`.
  Esto compara lo que `fetch()` realmente va a llamar contra lo que el operator configuró. Si no matchean, reject pre-fetch / pre-sign. Como defense-in-depth se mantuvo `isPathOnly` pero con backslash explícitamente rechazado (`endpoint.includes('\\')` ⇒ false), así si el post-resolution check alguna vez regresiona los string-shape obvios siguen siendo cortados temprano.
- **Aplicar en**: cualquier código que tome input no-confiable y lo combine con `new URL(input, base)`. Patrón inviolable: validar AFTER `new URL`, no antes. La pregunta correcta no es "¿esto parece un path?" sino "¿el resolved URL es el host que espero?". El AR debe marcar BLOQUEANTE cualquier PR nuevo que use `isPathOnly`-style heurísticas string-only sin un host check post-`new URL`.

---

### [2026-04-30 fix-pack iter 2] Re-AR — `event` clobber en log payload (MNR-iter2-1)

- **Error**: `log.warn('tool.pay_x402.chain-mismatch', { ..., event: 'chain_mismatch', ... })`. El logger emite `JSON.stringify({ts, level, event, ...redact(fields)})`, así que el spread de `fields` ocurre DESPUÉS de `event` → la key `event: 'chain_mismatch'` clobbera el event canónico `tool.pay_x402.chain-mismatch`. El log line salía con `event: 'chain_mismatch'`, breaking cualquier dashboard / grep / alert que matchee por event canónico.
- **Causa raíz**: el dev original probablemente quiso dejar un "event slug" semántico además del event canónico, sin saber que el spread de `fields` toma precedencia sobre las keys top-level del logger. Code review iter 1 no lo detectó porque no había test que assertara `event === 'tool.pay_x402.chain-mismatch'` para esa línea específica.
- **Fix**: borrar `event: 'chain_mismatch'` del payload. El primer arg de `log.warn` es la fuente de verdad. Si querés un slug semántico extra, llamalo `eventClass` / `mismatchKind` / cualquier cosa que NO sea `event`. Test agregado (`T-MNR-iter2-1`) que parsea el log line y assertea `parsed.event === 'tool.pay_x402.chain-mismatch'`.
- **Aplicar en**: cualquier llamada a `log.warn`/`log.info`/`log.error`. Ban list para payload keys: `event`, `level`, `ts` — los emite el logger, no los pisemos. Sería sano agregar un eslint rule custom o un wrapper que rechace estas keys, pero por ahora: cuidado en code review.

---

### [2026-04-30 fix-pack iter 3] Re-AR — `fetch()` redirect-follow leak del envelope EIP-3009 (BLQ-iter3-1)

- **Error**: aún con `isPathOnly` + `resolveEndpoint` post-resolución (cierran SSRF a nivel de URL), las cuatro llamadas a `fetch()` heredaban el default WHATWG `redirect: 'follow'`. Si el gateway legítimo (o uno comprometido / man-in-the-middle con TLS válido) responde `302 Location: https://evil.com/...`, undici sigue el redirect cross-origin y **reenvía los custom headers**. El catch de WHATWG sólo despoja `Authorization`/`Cookie`/`Proxy-Authorization`; un header custom como `payment-signature` (que carga el envelope EIP-3009 firmado) viaja intacto al host del attacker. El attacker puede replay el envelope contra el gateway legítimo y drenar el operator wallet.
- **Causa raíz**: el threat model de iter 1+2 asumió "si la URL resuelta es el gateway, todo bien" — falso. El gateway puede emitir 3xx hostiles. La defensa SSRF a nivel de URL resolution no cubre el caso post-conexión. Era invisible porque ningún test mockeaba 3xx (el fake `fetch` siempre devolvía Response directo).
- **Fix**: `redirect: 'error'` en las 4 llamadas a `fetch()` (`discoverAgentsHandler`, `getPaymentQuoteHandler`, `payX402Handler` probe + `payX402Handler` settle). Cuando undici recibe un 3xx con `redirect:'error'`, lanza `TypeError('fetch failed')` con `cause: Error("redirect mode is set to 'error'")`. Helper `isRedirectError(e)` detecta el shape (matchea `/redirect/i` en `e.message` o `e.cause.message`) y retorna mensaje estable `'gateway responded with redirect; refusing to follow'` — sin leak de undici internals tipo `'fetch failed'`. 4 tests nuevos: `T-X11` (settle 302), `T-X12` (probe 302, no firma), `T-X13` (discover 302), `T-X14` (settle 301 — confirma genérico a cualquier 3xx).
- **Aplicar en**: cualquier `fetch()` futuro en este repo (o en cualquier MCP server) que cargue un header de credencial / autenticación / firma cripto en cross-origin redirect path. Regla: cualquier fetch con header custom de auth/firma DEBE llevar `redirect: 'error'`. Una alternativa más laxa es `redirect: 'manual'` y validar la Location en código, pero `'error'` es safer-by-default y el gateway legítimo no necesita 3xx (responde 200/4xx/5xx directo). El AR/CR debe marcar BLOQUEANTE cualquier `fetch()` que carga un header sensible y omite la opción `redirect`.

---

### [2026-04-30 fix-pack iter 3] MNR — `resolveEndpoint` non-string input (MNR-iter3-1)

- **Error**: `resolveEndpoint(endpoint, gw)` no validaba `typeof endpoint`. Si un caller futuro pasa `null`/`undefined`/`{}`, `new URL(null, base)` parsea como `'null'` (string), `new URL({}, base)` parsea como `'[object Object]'`, etc. — comportamiento sorpresivo del WHATWG URL constructor. El branch ok puede devolver una URL "válida" sobre input inesperado.
- **Causa raíz**: la función fue escrita asumiendo que el caller ya había validado con `isPathOnly`. Pero la API pública (export) puede ser llamada desde otros sitios futuros sin esa pre-condición.
- **Fix**: guard explícito al inicio: `if (typeof endpoint !== 'string' || !endpoint.length) return { ok:false, error:'endpoint must be a non-empty string' }`. Test `T-MNR-iter3-1` cubre `null`, `undefined`, `''`, `0`, `false`, `{}`, `[]`, números.
- **Aplicar en**: cualquier función pública/exported que reciba input con expectativa de string. Validar `typeof` en el primer guard, no asumir que el caller ya validó.

---

### [2026-04-30 fix-pack iter 3] MNR — Gateway URL con path arbitrario (MNR-iter3-2)

- **Error**: `WASIAI_GATEWAY_URL` aceptaba origin con path no-trivial (`https://app.wasiai.io/x402/`). `new URL(endpoint, gateway)` con un base path-bearing tiene reglas WHATWG sutiles para resolución relativa, lo que cambia la superficie de ataque del check post-resolución (el host check sigue válido, pero la pathname puede combinarse de formas no obvias).
- **Causa raíz**: el SDD original no exigió origin-only. Documentación + ejemplos asumían `https://app.wasiai.io` plano, pero nada lo enforce-aba.
- **Fix**: documentado en el README §Security (sección "SSRF defense") que el gateway URL DEBE ser origin-only. No agregamos enforcement runtime (low-priority MNR; el host check sigue siendo correcto). Si en el futuro queremos enforce, agregar en `validateGatewayUrl` algo como `if (url.pathname !== '/' && url.pathname !== '') throw ...`.
- **Aplicar en**: cualquier env var futura que represente un base URL para resolución relativa de paths derivados de input. Default: documentar origin-only; si la HU es security-critical, enforce runtime.
