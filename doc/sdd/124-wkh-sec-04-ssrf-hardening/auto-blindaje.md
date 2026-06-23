# Auto-Blindaje — WKH-SEC-04 SSRF Hardening

### [2026-06-23 17:05] Wave 2 — Misconcepción del vector userinfo con `new URL(endpoint, base)`

- **Error**: Escribí el test del userinfo bypass asumiendo que
  `new URL('@169.254.169.254/foo', 'https://gw.example')` resolvía al host
  `169.254.169.254` y por lo tanto sería rechazado por `validateGatewayUrl`.
  El test esperaba `MCPToolError(-32602)` + `fetch` no llamado, pero falló con
  `TypeError: addresses is not iterable` (segundo lookup DNS sin mock).
- **Causa raíz**: El WHATWG URL parser NO interpreta `@…` como userinfo cuando
  el segundo argumento es base + relative ref. `new URL('@169.254.169.254/foo',
  'https://gw.example')` produce `https://gw.example/@169.254.169.254/foo`
  (host = `gw.example`, el `@…` queda como PATH). El vector userinfo real solo
  existe con concat de strings cruda: `'https://gw.example' + '@169...'` =
  `https://gw.example@169.254.169.254/foo` (host = `169.254.169.254`). Es decir:
  **`new URL()` ya neutraliza el userinfo bypass por construcción** — esa es
  precisamente la razón por la que DT-1 lo manda usar.
- **Fix**: Reescribí el test para aseverar la propiedad de seguridad correcta:
  con endpoint `@169.254.169.254/foo` el host fetcheado es `gw.example` (nunca
  el literal link-local). El vector que SÍ re-targetea el host es el
  protocol-relative `//internal.attacker.example/...` → ese caso (resuelve a IP
  privada) es el que la validación de la URL final rechaza con `-32602` y sin
  fetch. Ambos casos quedan cubiertos.
- **Aplicar en**: Cualquier futura defensa SSRF que construya URLs derivadas —
  verificar empíricamente con `node -e "new URL(...)"` cómo normaliza el parser
  ANTES de escribir el assert. No asumir que `@host` siempre re-targetea; con
  base+relative el `@` cae a path. El concat crudo `base + fragment` es el
  patrón peligroso a eliminar (CD-1).
