# Code Review (Adversary) — WKH-SEC-04 SSRF Hardening

- **Branch**: `fix/124-wkh-sec-04-ssrf-hardening` (working tree)
- **Scope reviewed**: `src/mcp/schemas.ts`, `src/mcp/tools/get-payment-quote.ts`, `src/mcp/tools/pay-x402.ts`, `src/services/compose.ts` + 3 nuevos test files
- **Foco CR**: calidad, patrón, cobertura
- **Veredicto**: APROBADO con MENORs
- **Findings**: 0 BLOQUEANTE / 2 MENOR

## Gates reales

| Gate | Comando | Resultado |
|------|---------|-----------|
| TS strict | `npx tsc --noEmit` | OK — 0 errores |
| Test suite | `npx vitest run` | OK — PASS (1643) / FAIL (0) |
| Tests nuevos SSRF | `npx vitest run *.ssrf.test.ts (los 3)` | OK — PASS (15) / FAIL (0) |

## Checklist

### 1. Construcción URL final + validación (ambos MCP tools) — OK
`get-payment-quote.ts:31-32` y `pay-x402.ts:89-90` construyen `new URL(input.endpoint, input.gatewayUrl).toString()` y validan ESA url con `validateGatewayUrl(url)` antes del fetch. No se valida un fragmento y se fetchea otro: en ambos casos la variable `url` validada es exactamente la pasada a `fetch`. Verificado empíricamente:
- `new URL('@169.254.169.254/foo','https://gw.example')` → host `gw.example` (userinfo neutralizado, el `@` cae a path).
- `new URL('//internal.attacker.example/foo','https://gw.example')` → host re-targeteado; si resuelve privado, `validateGatewayUrl` lo rechaza con -32602 antes del fetch.

El `gatewayUrl` solo se valida primero como first-defense (CD-1 cumplido: la validación de la URL final NO es la única ni se omitió).

### 2. `pattern:'^/'` en schemas.ts — OK
`schemas.ts:29` (pay_x402) y `schemas.ts:45` (get_payment_quote): `{ type:'string', minLength:1, pattern:'^/' }`. Correcto y no rompe endpoints legítimos (`/price`, `/x402/pay` pasan — verificado en los tests de schema con Ajv real). DT-3 cumplido: el pattern es first-defense, no la única (ver MNR-1 sobre su completitud). El tipo TS `endpoint: string` en `types.ts:94/112` no tiene validación runtime propia, así que no requiere el pattern ahí (la validación corre vía Ajv en el router).

### 3. compose: validateRegistryUrl + manejo SSRFViolationError — OK
`compose.ts:439-453`: `await validateRegistryUrl(agent.invokeUrl)` antes del `fetch` de `compose.ts:455`, espejo correcto de `discovery.ts:529`. Usa `validateRegistryUrl` (dominio registries / `DISCOVERY_SSRF_ALLOWLIST`) según DT-2. En `SSRFViolationError`:
- loguea con `logger?.warn?.bind(logger) ?? console.warn` (sound: cubre logger ausente y logger sin `warn`),
- relanza `new Error('Agent <slug> invokeUrl blocked by SSRF guard (<category>)')` — NO filtra el `invokeUrl` ni headers al cliente, aborta el step (CD-2 cumplido).
- errores no-SSRF se re-lanzan tal cual (no se traga nada).

Los headers `x-a2a-key` / `PAYMENT-SIGNATURE` se construyen ANTES del guard pero nunca se emiten: el `throw` ocurre antes del `fetch`. Para el path x402, `getPaymentAdapter().sign()` (EIP-712 local, sin red) corre antes del guard, pero la firma queda solo en el header y jamás sale a la red. Aceptable.

### 4. TS strict / any / imports — OK
Sin `any` en el código tocado. Import en `compose.ts:11-14` (`SSRFViolationError`, `validateRegistryUrl` desde `../lib/url-validator.js`) correcto, extensión `.js` consistente con el resto. `tsc --noEmit` limpio.

### 5. Cobertura de los 15 tests — OK (con observación, ver MNR-1)
Los tests cubren los ACs reales, no triviales:
- **AC-5 userinfo**: assert de la propiedad de seguridad correcta (host fetcheado = `gw.example`, nunca el literal link-local). El auto-blindaje documenta bien por qué este vector se neutraliza por construcción.
- **AC-1/AC-5 IP interna**: endpoint protocol-relative `//internal.attacker.example` que resuelve a `10.0.0.1` → `MCPToolError(-32602)` + `fetch` NO llamado. Doble mock de DNS (gateway público, final privado) — prueba que la validación corre sobre la URL final, no la gateway.
- **AC-2 schema reject**: Ajv real rechaza `endpoint` sin `/`, acepta `/price`.
- **AC-4 happy path**: fetch SÍ llamado con la URL exacta esperada.
- **compose AC-3**: private IP (169.254.169.254) y `file://` → throw con 'SSRF guard', `fetch` NO llamado, con `a2aKey` provisto (prueba el no-leak de header). AC-4 público y AC-4 allowlist cubiertos. `file://` además verifica que ni siquiera llega a `dns.lookup`.
- Patrón CD-3 (mock `node:dns` + `vi.stubGlobal('fetch')` + assert fetch no llamado) seguido en los 3 archivos.

### 6. Gates reales — OK
Ver tabla arriba. 1643 passed / 0 failed, 15 nuevos pasan, tsc 0 errores.

## Findings

### MNR-1 — Cobertura/Spec: AC-5 clausula "host difiere de gatewayUrl" no enforced (solo se bloquea IP privada)
- **Categoría**: Test Coverage / Integration (spec compliance)
- **Archivo:línea**: `src/mcp/tools/pay-x402.ts:90`, `src/mcp/tools/get-payment-quote.ts:32`, `src/mcp/schemas.ts:29,45`
- **Descripción**: AC-5 dice textualmente "rechazando si el host difiere del host de `gatewayUrl` O resuelve a IP privada". La implementación SOLO enforcea la segunda condición (IP privada / allowlist). Un `endpoint` protocol-relative o con backslash re-targetea a un host público arbitrario y NO se rechaza:
  - `new URL('//attacker-public.example/steal','https://gw.example')` → host `attacker-public.example` (pasa `^/`? no — pero `/\attacker.example/foo` SÍ pasa `^/` porque empieza con `/`, y `new URL` normaliza `\`→`/` dando host `attacker.example`).
  - Como `attacker.example` resuelve público y sin `MCP_GATEWAY_ALLOWLIST`, `validateGatewayUrl` lo deja pasar y el `fetch` va al host del atacante en lugar de `gw.example`.
- **Reproducción**: input `{ gatewayUrl:'https://gw.example', endpoint:'/\\attacker-public.example/x' }` → `new URL` produce host `attacker-public.example`; con DNS público y sin allowlist el fetch se ejecuta contra el host del atacante (verificado con `node -e`).
- **Impacto**: NO es SSRF a recursos internos (la defensa de IP privada cierra el threat principal de la HU). Es un host-re-target a host público arbitrario; en pay_x402 la `payment-signature` solo saldría tras un 402 válido del host atacante — path rebuscado. x-a2a-key no aplica en MCP tools. Por eso MENOR y no BLOQUEANTE: el threat de SSRF interno (foco de la auditoría `_AUDIT-100-C` y de los ACs 1/3) está completamente cerrado; lo que queda sin cubrir es la clausula literal "host difiere" de AC-5.
- **Sugerencia**: si se quiere cumplir AC-5 al pie de la letra, comparar `new URL(endpoint,gatewayUrl).host === new URL(gatewayUrl).host` y rechazar la diferencia (no exfil a host distinto). Alternativamente, ajustar el texto de AC-5 en QA si el equipo decide que el threat real (IP privada) ya está cubierto y el re-target a host público es aceptable / fuera de scope. Decisión de producto + QA, no del Dev unilateralmente.

### MNR-2 — Test Coverage: falta caso negativo de re-target a host PÚBLICO distinto
- **Categoría**: Test Coverage
- **Archivo:línea**: `src/mcp/tools/pay-x402.ssrf.test.ts`, `src/mcp/tools/get-payment-quote.ssrf.test.ts`
- **Descripción**: los tests de IP interna usan `//internal.attacker.example` que resuelve a `10.0.0.1` (privado) — cubren bien el caso privado. No hay test que documente el comportamiento cuando el endpoint re-targetea a un host público distinto del gateway (caso MNR-1). Sea cual sea la decisión sobre MNR-1, conviene un test que congele el comportamiento esperado (hoy: pasa el fetch al host re-targeteado) para que no sea una sorpresa silenciosa.
- **Reproducción**: no hay test que ejercite `endpoint` → host público != gateway.
- **Impacto**: bajo. Comportamiento no documentado por test; riesgo de regresión silenciosa si luego se decide enforcar AC-5 estricto.
- **Sugerencia**: agregar 1 test por tool que aserte el comportamiento decidido en MNR-1 (rechazo si se enforca, o fetch-al-host-re-targeteado si se acepta como diseño).

## Resumen

Implementación limpia, sigue el patrón de `discovery.ts:529`, cierra el vector SSRF a IPs privadas/loopback/link-local en los 3 puntos (los 2 MCP tools + compose). CD-1, CD-2, CD-3, CD-4, DT-1, DT-2, DT-3 cumplidos. Gates verdes. Los 2 MENOR son sobre la clausula "host difiere" de AC-5 (re-target a host público) — no bloquean DONE; se decide con QA si entran ahora o backlog. Ningún BLOQUEANTE.
