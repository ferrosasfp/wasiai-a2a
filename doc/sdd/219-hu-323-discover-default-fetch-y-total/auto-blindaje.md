# Auto-Blindaje — HU-323 (`/discover` por defecto + honestidad de `total`)

Errores y casi-errores de la sesión de implementación. Cada entrada existe para
que la próxima HU no los repita.

---

### [2026-08-04] Wave 0 — casi apago el backstop del flujo estrella cambiando un tipo de presentación

- **Error**: al decidir que `total` pasara a ser `number | 'unknown'`, la
  intención era tocar sólo la PRESENTACIÓN. Pero `total` no era sólo un campo de
  respuesta: `services/discovery.ts` lo usaba como CONDICIÓN interna en el gate
  del broaden-retry de WKH-157 (`if (result.total === 0 && query.query)`). Con el
  campo re-tipado, `'unknown' === 0` es `false`, así que el retry se habría
  apagado **exactamente cuando el catálogo llega truncado o parcial** — el
  momento en que más falta hace, y sobre el flujo estrella de Chaski, que ya se
  rompió dos veces por el mismo backstop (ver la memoria
  `relevance-backstop-neutered-wkh166`).
- **Causa raíz**: un campo con DOS trabajos. El mismo número servía de dato
  público (denominador de paginación) y de señal de control interna. Cambiarle la
  forma al primero le cambia el significado al segundo, y nada en el tipo lo
  avisa: `'unknown' === 0` compila sin chistar.
- **Fix**: se partieron los dos trabajos. `totalAtLeast: number` (siempre número,
  el `allAgents.length` de siempre) es el que consume la lógica interna;
  `total: ReportedTotal` es el que se publica. El gate quedó
  `result.totalAtLeast === 0`, o sea la MISMA expresión sobre el MISMO número que
  antes: cero cambio de conducta.
- **Verificado con mutación**: el mutante M5 devuelve el gate a
  `(result.total as number) === 0` y mata 3 tests (`AC-1`, `AC-3`, `NIT-2` de
  `discovery.test.ts`), con `tsc` en verde. Sin ese `as number` ni siquiera
  compila, que es la única razón por la que el bug no se podía colar sin querer.
- **Aplicar en**: cualquier HU que le cambie el TIPO a un campo de respuesta.
  Antes de tocarlo, `grep` de los consumidores INTERNOS, no sólo de los de la
  ruta. Un campo que aparece en una `if` del propio service ya no es un campo de
  presentación.

---

### [2026-08-04] Wave 1 — el comentario que justificaba el bug lo hacía invisible

- **Error**: el gate `query.limit && schema.limitParam` tenía arriba un comentario
  que decía que se preservaba **a propósito**, porque mandar un límite donde no
  había ninguno "sería reintroducir el mismo bug de clase esconder agentes". Leí
  eso primero y por un rato lo tomé como una restricción a respetar en vez de como
  una afirmación a verificar.
- **Causa raíz**: la frase suponía que *no mandar límite* equivale a *pedir todo*.
  Es falso: equivale a aceptar la paginación default DEL REGISTRO. La suposición
  nunca se midió, y como venía escrita con la palabra "a propósito", apagaba la
  revisión de todo el que pasara por ahí. Es exactamente la clase
  `prosa-que-afirma-de-mas` de la memoria.
- **Fix**: se midió contra producción antes de tocar nada
  (`GET /discover` ⇒ `sources[0].rows: 20`, `truncated`, `total 23`;
  `?limit=100` ⇒ `rows: 22`, `ok`, `total 25`). El comentario nuevo no dice "a
  propósito": dice qué input lo falsifica, con los números, y **conserva** la
  parte de la advertencia que sigue siendo cierta (un registro cuya página
  default supere el over-fetch ahora sí recibe un cap) declarándola como residual
  con sus tres mitigaciones.
- **Aplicar en**: cuando un comentario justifica una decisión con una afirmación
  sobre el mundo ("el registry devuelve X", "esto es equivalente a Y"), esa
  afirmación se mide antes de respetarla. Y al reescribirla, no borrar la mitad
  que sigue siendo verdad: separar "esto era falso" de "esto sigue valiendo".

---

### [2026-08-04] Wave 2 — 7 tests rojos que NO eran fallout mecánico

- **Error**: el riesgo era tratar los 7 rojos como "actualizar expectativas". Dos
  de ellos (`T-SRC-08`, `T-TRUNC-02b`) defendían la regla de WKH-318 "`ok` exige
  EVIDENCIA; sin evidencia obtenible es `unverified`", y la vía por la que la
  ejercitaban (`discover({})` ⇒ no se manda `limitParam` ⇒ no hay evidencia) es
  justo la que esta HU elimina. Cambiar el número esperado los habría dejado
  verdes **sin que nadie siguiera probando la regla**.
- **Causa raíz**: un test puede quedar rojo porque la conducta cambió o porque su
  PREMISA de montaje dejó de producir el escenario que el título promete. Son
  cosas distintas y se ven iguales en el reporte.
- **Fix**: a cada uno se le reconstruyó el escenario que el título dice. La única
  forma que queda de no tener evidencia obtenible es un registro que no declare
  NI `nextCursorPath` NI `limitParam`, y así se montaron. La regla sigue probada.
- **Aplicar en**: por cada test que se toca, preguntarse "¿el escenario que arma
  todavía es el que el título nombra?". Si no, el arreglo es reconstruir el
  escenario, no mover el `expect`.

---

### [2026-08-04] Wave 2 — un residual que aparecía disfrazado de test verde

- **Error**: `T-SRC-08b` pasó de `unverified` a `complete` con el cambio. La
  tentación era borrarlo o adaptarle el registro y seguir. Eso habría hecho
  desaparecer un agujero real: una página CORTA que trae un cursor **no
  declarado** ahora se publica `complete`, o sea que afirmamos completitud sobre
  un recorte.
- **Causa raíz**: la heurística `rows < sentLimit ⇒ completitud probada` supone
  que el registro honra el límite. Un registro que capea por su cuenta por debajo
  de lo pedido rompe la suposición.
- **Fix**: se agregó `T-SRC-08c`, un test de CARACTERIZACIÓN que asserta lo que el
  código hace, con el encabezado diciendo que eso NO es lo deseable, más un
  control en la misma corrida (el MISMO payload con `nextCursorPath` declarado sí
  sale `truncated`) que prueba que la causa es la no-declaración y no nuestra
  lógica. Se midió además que el agujero **no es nuevo**: ya se alcanzaba con
  cualquier `discover({ limit: N })` desde el fix-pack P1; HU-323 sólo lo vuelve
  alcanzable también sin `limit`.
- **Aplicar en**: cuando un cambio hace que un test deje de proteger algo, el
  reemplazo no es borrarlo — es un test que deje el agujero VISIBLE y un control
  que pruebe de qué depende. Y siempre medir si el agujero es nuevo o es
  preexistente que se volvió más alcanzable: la diferencia cambia el veredicto.
