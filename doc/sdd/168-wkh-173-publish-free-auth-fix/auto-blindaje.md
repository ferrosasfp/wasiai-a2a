# Auto-Blindaje — WKH-173

### [2026-07-10 09:40] Wave 2 — Edit `old_string` no matcheó por tail truncado
- **Error**: el primer `Edit` para anexar el describe T-RA al final de `a2a-key.test.ts` falló (`String to replace not found`). Copié el tail desde un `tail -15` que venía filtrado por rtk (sin las líneas de comentario intercaladas), así que el `old_string` no era byte-exacto.
- **Causa raíz**: usar un preview truncado/filtrado como fuente del `old_string` en lugar del contenido literal del archivo.
- **Fix**: `Read` con offset exacto (2555-2566) para obtener las líneas reales (incluían 2 comentarios `//` entre los `expect`), y volví a hacer el Edit con el bloque literal.
- **Aplicar en**: cualquier Edit por append/anchor — anclar SIEMPRE contra un `Read` directo del rango, nunca contra `tail`/`grep` (que acá pasan por rtk y pueden colapsar líneas).

### [2026-07-10 09:55] Fix-pack MNR-1 — helper que devolvía `FastifyReply` rompía el early-return (`await` desenvuelve el thenable)
- **Error**: al extraer `verifyOptInSignature` (MNR-1), la firma inicial devolvía `Promise<FastifyReply | null>` (`return reply.status(401).send(...)`) y el caller hacía `const sigError = await verifyOptInSignature(...); if (sigError) return sigError;`. Resultado: 7 tests del path PAGO (WKH-123 AC-3/4/5/6/9 master+session) rojos — el status del error se enviaba OK (401/403) pero el débito se ejecutaba igual (`mockDebit` llamado 1×). Byte-NO-idéntico.
- **Causa raíz**: `FastifyReply` es **thenable** (tiene `.then`, para soportar `await reply`). Cuando una función `async` devuelve el `reply` y el caller hace `await fn()`, el runtime **desenvuelve** ese thenable → resuelve a `undefined`. Así `sigError` quedaba `undefined` (falsy), el `if (sigError) return` NO cortaba y el flujo caía al débito. El inline original NO tenía el bug porque el `return reply...send()` estaba en la MISMA función (sin `await` intermedio sobre el reply).
- **Fix**: el helper devuelve `Promise<boolean>` (`true` = ya respondió, caller corta con `return;`), y envía el reply SIN retornarlo (`reply.status(401).send(...); return true;`). Un boolean no es thenable → inmune al desenvuelvo. Verificado con repro mínima Fastify 5 + suite completa (2828 verde).
- **Aplicar en**: NUNCA `return`ear un `FastifyReply` desde una función `async` auxiliar que un caller vaya a `await`ear para decidir un early-return. Devolver un flag (`boolean`) o `void` + chequear `reply.sent`. Regla general para cualquier helper de auth/guard extraído a futuro.
