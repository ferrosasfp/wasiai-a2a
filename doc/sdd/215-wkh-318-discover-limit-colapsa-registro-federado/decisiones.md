# Decisiones tomadas en F3 — WKH-318

Decisiones que el revisor pidió **escribir explícitamente**, porque el problema no
era el valor elegido sino que apareciera sin que nadie hubiera elegido.

---

## D-1 — `sources[].failure` se publica en `/discover`, que es anónimo

**Planteo (AR, punto 3, severidad BAJA)**: `/discover` no tiene auth —verificado:
cero `preHandler` en `src/routes/discover.ts`— y ahora la respuesta incluye
`sources[].failure`. Dos de los seis valores dicen algo sobre **nosotros**, no
sobre el upstream: `ssrf_blocked` revela que un endpoint que tenemos configurado
resuelve a una dirección privada, y `circuit_open` revela el estado del breaker.
Es información de red que antes no salía.

### Decisión: se publica. No se cambia el código.

**Qué se publica exactamente** (verificado en `services/discovery.ts:596-605`): el
`name` del registro, el `state`, el `rows` y el `failure` — y **nada más**. El
`failure` es un enum cerrado de seis valores. **No** sale el `reason` ni la
`category` del `SSRFViolationError`, **no** sale la dirección resuelta, **no** sale
el `discoveryEndpoint`, **no** sale el status HTTP. Todo eso ya vivía —y sigue
viviendo— sólo en el log estructurado (`log.error` de SSRF y el `log.warn` con
`error_code: 'REGISTRY_SOURCE_FAILED'`).

**Por qué se publica y no se guarda sólo en el log:**

1. **Es accionable para un caller máquina, y la acción es la correcta.**
   `timeout` y `circuit_open` son **reintentables**; `bad_payload`, `ssrf_blocked`
   y `http_error` **no lo son** (necesitan que un operador toque algo). Un caller
   que no puede distinguirlos, o reintenta lo que no debe —y nos golpea— o no
   reintenta lo que sí debía. Ese es exactamente el tipo de decisión que esta HU
   quiere que el caller pueda tomar con datos en vez de adivinando.
2. **Sin `failure`, `state: 'failed'` obliga a adivinar el motivo**, y adivinar el
   motivo de un fallo es el hábito que esta HU vino a romper.
3. **El nombre del registro ya era público**: `registries[]` lo publica desde antes
   de esta HU. Lo nuevo es el motivo, no la existencia de la fuente.

**Lo que sí acepto como costo, dicho sin maquillar**: un observador anónimo puede
aprender que *el registro X está configurado con un endpoint que resuelve a una
dirección privada* (`ssrf_blocked`), o que *el registro X viene fallando lo
suficiente como para abrir el breaker* (`circuit_open`). No aprende la dirección,
ni el endpoint, ni el status. El segundo caso además es inferible sin el campo:
una fuente que no aporta agentes durante 30 segundos seguidos ya cuenta esa
historia.

**Alternativa descartada y por qué**: colapsar `ssrf_blocked` y `circuit_open` en
un valor genérico sólo para el caller anónimo. Serían **dos vocabularios para el
mismo hecho** —el del log y el de la respuesta— y esta HU ya tiene una regla
explícita en contra de eso (CD-11: una sola expresión por concepto). Divergirían.

### Cuándo revisar esta decisión

- Si `/discover` gana **niveles de auth** (anónimo vs. autenticado): ahí sí tiene
  sentido dar el motivo fino al autenticado y uno grueso al anónimo, porque ya
  habría dos audiencias distintas y no una sola.
- Si se agregan valores de `DiscoverySourceFailure` que describan **estado interno
  nuestro** con más detalle que `ssrf_blocked`/`circuit_open`. El enum es el
  choke-point: **agregar un valor es la señal para releer esta decisión.**
- Si un pentest o una auditoría lo levanta con evidencia de impacto real, gana la
  evidencia sobre este razonamiento.

**Lo que NO se decidió acá**: nada sobre `GET /registries`, que es otra superficie
y tiene un hallazgo abierto propio (credencial expuesta, pruebas profundas
2026-07-26). Esta decisión es sólo sobre `sources[].failure` en `/discover` y
`/capabilities`.
