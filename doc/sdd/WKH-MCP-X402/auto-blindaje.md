# Auto-Blindaje — WKH-MCP-X402 (Dev F3)

Errores encontrados y corregidos durante la implementación. Referenciar antes
de futuras HUs que toquen patrones similares.

---

### [2026-04-13 18:19] Wave 2 — Ajv + ajv-formats default import under Node16 ESM

- **Error**: `tsc` falló con `TS2351: This expression is not constructable` en
  `new Ajv(...)` y `TS2349: This expression is not callable` en `addFormats(ajv)`.
- **Causa raíz**: el proyecto usa `"module": "Node16"` + `"moduleResolution": "node16"`.
  Bajo ese régimen, `import Ajv from 'ajv'` no resuelve al `exports.default`
  del paquete CJS aunque TS acepte el tipo. `ajv-formats` expone `export default`
  pero el runtime puede devolver el namespace con `.default` dependiendo de la
  versión de Node.
- **Fix**:
  - Ajv: usar el **named export** `import { Ajv } from 'ajv'` (el paquete expone
    ambas formas — `module.exports = Ajv` y `exports.Ajv = Ajv`).
  - ajv-formats: normalizar el default en runtime:
    ```ts
    function normaliseAddFormats(mod: typeof addFormatsRaw): (ajv: Ajv) => void {
      if (typeof mod === 'function') return mod;
      const wrapped = mod as unknown;
      if (wrapped !== null && typeof wrapped === 'object'
          && 'default' in wrapped
          && typeof (wrapped as { default: unknown }).default === 'function') {
        return (wrapped as { default: (ajv: Ajv) => void }).default;
      }
      throw new Error('Unable to resolve ajv-formats default export');
    }
    ```
- **Aplicar en**: cualquier otro paquete CJS con `export default` que el proyecto
  consuma bajo Node16 ESM (ej: si en el futuro se agregan `@fastify/*` helpers
  CJS que no exportan namespace correctamente).

---

### [2026-04-13 18:21] Wave 2 — Rate-limit response shape vs. Error-object pattern

- **Error**: AC-12 exige que el 429 devuelva JSON-RPC 2.0
  `{ jsonrpc, error: { code: -32029, message }, id: null }`, pero CD-12 pide
  que `errorResponseBuilder` retorne una instancia real de `Error` para que
  `@fastify/rate-limit` pueda enriquecer headers/retry-after.
- **Causa raíz**: el `Error` enriquecido se tira y termina en el global
  `errorBoundary` (`src/middleware/error-boundary.ts`), que lo reformatea a
  `{ error, code, requestId, retryAfterMs }` — no JSON-RPC.
- **Fix**: registrar un `setErrorHandler` **dentro del plugin MCP**
  (scope-local, Fastify lo aplica solo a rutas del plugin) que intercepta
  los errores con `code === 'RATE_LIMIT_EXCEEDED'` y los reescribe como
  envelope JSON-RPC 2.0 antes de que salgan al cliente.
- **Aplicar en**: cualquier otra ruta JSON-RPC que use
  `@fastify/rate-limit` y necesite un shape de error distinto al del
  error-boundary global. Usar siempre un error-handler **scoped** al plugin
  para no afectar rutas adyacentes.

---

### [2026-04-13 18:23] Wave 2 — Fastify `addHook` after `ready()` rejects

- **Error**: el test de AC-17 intentaba instalar un `onRequest` hook después
  de `await app.register(mcpPlugin, ...)` + `await app.ready()`, pero
  Fastify 5 tira `FastifyError: Fastify instance is already listening. Cannot call "addHook"!`.
- **Causa raíz**: Fastify 5 freezes hook registration cuando entra en
  `ready` state (incluso sin `listen()`). `app.inject` lo dispara
  implícitamente.
- **Fix**: registrar el hook ANTES de `ready()` — reorganicé el test para
  construir la instancia, registrar rate-limit, registrar el hook de captura,
  registrar el plugin MCP y ¡luego! `inject`.
- **Aplicar en**: cualquier test que monkey-patchee `request.log` o hooks
  usando el helper `buildApp()` compartido. Moverlo fuera del helper o
  exponer un parámetro `extraHooks` en el helper.

---

### [2026-04-13 18:24] Wave 3 — Biome noImplicitAnyLet

- **Error**: `biome check` marcó `let signResult;` como violación de
  `lint/suspicious/noImplicitAnyLet` (CD-2 por-proxy: la variable inferida
  como `any`).
- **Causa raíz**: TS strict permite `let x;` declaración sin tipo mientras el
  uso posterior lo infiere, pero biome prohíbe esa declaración suelta. Además,
  en strict mode, `let x;` sin initializer termina como `any` implícito hasta
  que se asigna.
- **Fix**: anotar explícitamente: `let signResult: SignResult;` importando
  `SignResult` desde `src/adapters/types.ts`.
- **Aplicar en**: cualquier bloque try/catch donde se declare una variable
  antes del try y se asigne dentro. Tipear explícitamente siempre.

---

### [2026-04-13 18:42] Fix-pack — SSRF defense via DNS resolution (BLQ-1)

- **Error**: los tools `pay_x402` y `get_payment_quote` aceptaban cualquier
  `gatewayUrl` y hacían `fetch` directo, permitiendo que un atacante apuntara
  a `http://127.0.0.1`, `http://169.254.169.254` (AWS metadata) u hostnames
  arbitrarios que **resuelven** a IPs privadas.
- **Causa raíz**: sin validación de protocolo ni de IP resuelta. Un literal
  `localhost` se bloquea trivialmente, pero un hostname DNS que apunta a
  `10.0.0.1` pasaba el filtro textual.
- **Fix**: nuevo helper `src/mcp/url-validator.ts` con `validateGatewayUrl()`
  que:
  1. Parsea con `new URL()`.
  2. Exige protocolo `http:` o `https:`.
  3. Bloquea literales `localhost`, `*.local`, `*.localhost`.
  4. Resuelve el hostname vía `dns.promises.lookup({ all: true })` y rechaza
     IPv4 en 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8 e IPv6
     `::1`, `::`, `fc00::/7`, `fe80::/10`.
  5. Si `MCP_GATEWAY_ALLOWLIST` (CSV) está seteado, requiere hostname en la
     lista.
  - Todos los errores se lanzan como `MCPToolError(-32602)` (INVALID_PARAMS).
- **Aplicar en**: cualquier futura tool MCP que haga fetch a URLs provistas
  por el cliente. Importar `validateGatewayUrl` y llamarla ANTES de construir
  la URL de destino o instanciar el `AbortController`.

---

### [2026-04-13 18:42] Fix-pack — Rate-limit key leak (BLQ-2)

- **Error**: `@fastify/rate-limit` usaba el valor plaintext de
  `X-MCP-Token` como `keyGenerator`, exponiendo el token en almacenamiento
  interno (in-memory stores, potencial log de debug, o un store externo
  tipo Redis en el futuro).
- **Causa raíz**: diseño inicial usaba el token como "bucket id" por
  simplicidad, ignorando que la librería puede persistir esas keys.
- **Fix**: hash con `crypto.createHash('sha256').update(token).digest('hex').slice(0,16)`
  prefijado con `'mcp:'`. Los 16 hex chars (64 bits) son más que suficientes
  para distinguir buckets sin colisiones prácticas, y el truncado limita la
  longitud de la key.
- **Aplicar en**: cualquier ruta que use un secreto como discriminador de
  rate-limit (ej. api-keys, session tokens). Hashear siempre — nunca
  persistir secretos crudos en estructuras de librerías de terceros.

---

### [2026-04-13 18:42] Fix-pack — orchestrate.steps shape colapsado (BLQ-3)

- **Error**: `orchestrate` mapeaba `pipeline.steps` a un `ComposeStep[]` con
  `input: {}` y `passOutput: false` hardcodeados. El cliente recibía el
  slug del agent pero perdía `output`, `costUsdc`, `latencyMs` y `txHash`.
- **Causa raíz**: confusión entre `ComposeStep` (input de compose) y
  `StepResult` (output del pipeline). El tipo `ComposeStep` fue elegido en
  F2.5 por descuido; el output real de `ComposeResult.steps[i]` es
  `StepResult`.
- **Fix**: nuevo tipo `OrchestrateStepOutput` en `src/mcp/types.ts` con
  los campos que efectivamente interesan al cliente MCP (`agent` slug,
  `registry`, `output`, `costUsdc`, `latencyMs`, `txHash?`). `orchestrate.ts`
  hace un map 1-a-1 desde `StepResult`. El test actualizado valida cada
  campo (incluido `txHash` cuando está presente).
- **Aplicar en**: cualquier futura tool MCP que envuelva un servicio interno
  cuyos tipos internos son asymétricos (input ≠ output). Definir tipos
  propios en el contrato MCP y mapear explícitamente — nunca "reusar" tipos
  de entrada como tipos de salida.

---

### [2026-04-13 18:42] Fix-pack — AbortError mapping + parseInt guards (MNR-1/2/3)

- **Errores menores**: (1) `parseInt` devolvía `NaN` cuando
  `MCP_RATE_LIMIT_MAX` tenía un valor inválido; (2) si el AbortController
  del timeout abortaba el fetch, la excepción `AbortError` escapaba cruda
  a -32001 en vez del semánticamente correcto -32002 (UPSTREAM_GATEWAY);
  (3) no había un default opcional para `maxAmountWei` guard.
- **Fix**:
  - `rate-limit.ts`: helper `readPositiveInt(name, fallback)` que valida
    `Number.isFinite(n) && n > 0`.
  - `pay-x402.ts`: wrapper `fetchWithTimeoutMapping` convierte
    `err.name === 'AbortError'` en `MCPToolError(-32002,
    'Gateway timeout after Nms')`.
  - `pay-x402.ts`: helper `resolveMaxAmountWei` consulta env
    `MCP_MAX_AMOUNT_WEI_DEFAULT` cuando input no lo provee; documentado
    en `.env.example`.
- **Aplicar en**: cualquier otro `parseInt(process.env.X ?? ...)` que
  maneje ints positivos (reemplazar por helper similar). Cualquier
  `AbortController`-gated fetch debe envolver cada `fetch()` en un
  try/catch que distinga `AbortError` del resto.

---

### [2026-04-13 18:25] Wave 5 — Grep CD-7 false positive por JSDoc

- **Error**: el grep `grep -E 'adapter\.(settle|verify)' src/mcp/tools/pay-x402.ts`
  reportaba violación de CD-7, pero el único match estaba dentro de un
  comentario JSDoc (`This tool MUST NOT call adapter.settle() nor adapter.verify()`).
- **Causa raíz**: el regex no discrimina comentarios.
- **Fix**: reescribir el comentario sin los parens: "This tool MUST NOT settle
  or verify via the adapter (CD-7)" para evitar el match literal.
- **Aplicar en**: todos los JSDocs que mencionen patrones prohibidos (para
  que el grep-based CD check no devuelva falsos positivos). También se puede
  usar un regex con anchor `^\s*[^/*]` pero es más frágil que reescribir el
  comentario.
