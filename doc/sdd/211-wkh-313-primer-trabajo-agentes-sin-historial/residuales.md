# Residuales abiertos — WKH-313 (carril de estreno)

Lo que esta HU **deja abierto a propósito**, con el número medido cuando lo hay.
Ninguno se arregla acá; los cuatro primeros vienen del SDD/Story File y los dos
últimos los levantó el Code Review.

---

## R-1 · El cupo se ancla en `owner_ref`, y crear cuentas es barato

`M` limita cuántos agentes en estreno tiene un publicador, pero el ancla es una
cuenta y registrarse no cuesta nada. Cerrar esto es trabajo de nivel signup, no de
esta HU. La palanca disponible el día que haga falta es exigir `Agent.identity`
(ERC-8004): cuesta gas y un token real, y **es alcanzable solo** — a diferencia de
`verified`, que está hardcodeado `false` para todo self-published. Hoy exigirla
bloquearía la propia demo: ninguno de los tres agentes remit la tiene.

## R-4 · `prepare` y `submit` resuelven el agente por separado

La clave del memo por `allow_trial` mitiga la divergencia **dentro de una request**,
**no entre las dos requests** de Chaski. Esa mitigación es de W0.3 (`chaski-v3`, otro
repo, bloqueada). Si no se puede garantizar el mismo agente en los dos legs, la
regla es **`M = 1` para capacidades de desembolso**.

## R-5 · `total` sube con `allowTrial=true`

Correcto por definición (`total` = matches de los filtros tal como se aplicaron),
pero es un cambio **observable** para quien pagina. Documentado en
`doc/INTEGRATION.md`.

## R-6 · `failedCount` no está capeado por caller

`failedCount` sube con cualquier `failed`. La anulación del carril ya **no** lo usa
(usa `failedCallerCount`, callers identificados distintos), pero `failedCount` sigue
alimentando `success_rate` y por lo tanto el score real. Un tercero puede
degradar el score de un rival pagando invocaciones que fallen. Mitigarlo exige
decidir si el fallo se capea por caller, y eso **mueve la semántica de
`success_rate` de producción** — fuera de alcance (work-item §8).

---

## MNR-3 (CR) · El cupo acota CUÁNTOS entran, no QUIÉNES

**Medido por el CR**: con el ancla de un registry federado entero, un sybil que
publique **20 de 22** candidatos se queda con **los dos** cupos en **~82%** de las
requests. El cupo `M` limita la cantidad de agentes en estreno por ancla, pero
cuando el ancla agrupa a muchos publicadores distintos (el caso federado, donde el
ancla es el `registry_id` porque el `Agent` federado no trae `created_at` ni
`owner_ref`), la selección entre candidatos del mismo ancla es proporcional a
cuántos puso cada uno.

**Por qué no se arregla acá**: el arreglo pasa por tener un ancla **por
publicador** también del lado federado, y eso es un dato que el shape `Agent`
federado hoy no trae. Es una HU de datos/contrato de discovery, no un cambio de
política del carril.

**Mitigación vigente mientras tanto**: el admitido conserva su score real, así que
sólo puede ser elegido cuando **ningún** agente pasa por mérito; y en el caso
federado el desempate entre candidatos del mismo ancla es el sorteo sembrado, no el
orden del arreglo.

## MNR-4 (CR) · M8 — el `metadata` del evento como superficie de entrada

El mutante **M8** (leer un `reputation`/`score` del `metadata` del evento hacia los
contadores del standing) muere hoy con `T-08`. Queda anotado como recordatorio de
contrato: `a2a_events.metadata` es un JSONB que escribe el propio camino de
ejecución, y **ninguna** cifra de ahí puede entrar nunca al score ni al standing.
Hoy sólo se lee `caller_ref_hash`, que es un HMAC server-side. Al backlog como
invariante a re-verificar si alguien agrega lecturas de `metadata`.
