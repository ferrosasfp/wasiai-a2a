# Runbook — destrabar un intent del ledger de settle Solana (WKH-307)

> **Cuándo se usa**: el gateway rechaza un settle Solana con
> `SETTLE_CONFIRMED_BUT_UNVERIFIABLE` o `SETTLE_INTENT_CONFLICT` y la fila queda
> clavada. WKH-307 **eliminó a propósito** el self-heal que re-emitía sola: con un
> registro durable, "la firma registrada no cuadra con la cadena" tiene causas que
> pagar de nuevo no arregla. Pero **una decisión de no auto-actuar exige una salida
> manual**, o el estado es plata retenida en silencio. Ésta es esa salida.

## Regla que gobierna todo el procedimiento

**La cadena manda sobre la tabla.** Ninguna fila se toca sin evidencia on-chain
citada (firma, slot, y el `err` o el delta de balances). Si la evidencia no se puede
obtener, **no se toca nada**: `unknown` no autoriza ni pagar ni marcar pagado.

---

## A · `SETTLE_CONFIRMED_BUT_UNVERIFIABLE`

La fila dice `confirmed` con una firma, y la cadena no lo respalda. **Tres causas, y
sólo una justifica volver a pagar.**

### Paso 1 — determinar cuál de las tres es

```bash
# (i) ¿La firma existe para la red, buscando el histórico?
solana confirm -v <SETTLE_SIGNATURE> --url <RPC>
# (ii) Contra un SEGUNDO proveedor de RPC, distinto del que usa el gateway.
solana confirm -v <SETTLE_SIGNATURE> --url <RPC_ALTERNATIVO>
```

```sql
SELECT intent_id, status, settle_signature, expired_signatures,
       pay_to, amount_atomic, mint, attempts, claimed_at, signed_at, confirmed_at
  FROM public.a2a_solana_settle_intents
 WHERE intent_id = '<INTENT_ID>';
```

| Lo que ves | Causa | Qué hacer |
|---|---|---|
| Los DOS proveedores la encuentran y el transfer cuadra (monto/mint/destino) | **RPC mintiendo** (el del gateway estaba dando datos malos) | **B-1**: la fila ya es correcta. No se toca nada; se arregla el RPC. |
| Los DOS la encuentran, pero el transfer NO cuadra con `pay_to`/`amount_atomic`/`mint` | **Contabilidad corrupta** | **B-2** |
| Ninguno la encuentra, habiendo buscado el histórico | **Fork**: la fila llegó a `confirmed` tras un `confirmTransaction` a commitment `confirmed`, que es OPTIMISTA — el bloque quedó fuera de la cadena canónica y **el pago no ocurrió** | **B-3** |
| Un proveedor sí y el otro no, o alguno no responde | **No se sabe** | **NO TOCAR.** Reintentar más tarde. |

### B-1 · RPC mintiendo
No se modifica la tabla. Se corrige el endpoint (`SOLANA_RPC_URL`) o se saca del pool
el nodo que va atrasado. El siguiente retry del pipeline resuelve solo.

### B-2 · Contabilidad corrupta
**No se destraba con un UPDATE.** Es un incidente: la fila afirma un pago que la
cadena atribuye a otra cosa. Escalar con la evidencia (firma, slot, balances pre/post,
y la fila completa). Cualquier corrección posterior se hace con el intent **cerrado**
y anotada.

### B-3 · Fork (el único caso donde re-pagar es correcto)
El pago genuinamente no ocurrió. Se devuelve la fila a `claimed` **archivando la firma
caída**, que es exactamente lo que hace la transición de reclamo — la evidencia no se
borra:

```sql
-- Sólo tras haber confirmado con DOS proveedores que la firma no existe.
UPDATE public.a2a_solana_settle_intents
   SET status                  = 'claimed',
       expired_signatures      = expired_signatures || ARRAY[settle_signature],
       settle_signature        = NULL,
       last_valid_block_height = NULL,
       confirmed_at            = NULL,
       attempts                = attempts + 1,
       claimed_at              = now(),
       updated_at              = now()
 WHERE intent_id = '<INTENT_ID>'
   AND status = 'confirmed'
   AND settle_signature = '<SETTLE_SIGNATURE>';   -- ⚠️ ancla a la firma verificada
```

El `AND settle_signature = …` no es decorativo: si entre la consulta y el `UPDATE` el
gateway avanzó la fila, el `UPDATE` no aplica en vez de pisar un estado nuevo.

Después: el siguiente retry del pipeline reclama y re-firma normalmente.

---

## C · `SETTLE_INTENT_CONFLICT`

El `intent_id` existe con **otros** términos (`pay_to`, `amount_atomic` o `mint`). El
gateway rechaza sin transmitir y **sin devolver la firma previa** — devolverla sería
decirle a B que cobró un pago que se le hizo a A.

Casi siempre es un **error del llamador** (reusó un `intent_id` para otro pago), no del
ledger. En condiciones normales es imposible: el `intentId` es
`` `${composeRunId}:${i}` `` con un UUID fresco por ejecución.

```sql
SELECT intent_id, status, pay_to, amount_atomic, mint, settle_signature, claimed_at
  FROM public.a2a_solana_settle_intents
 WHERE intent_id = '<INTENT_ID>';
```

- **Si la fila anterior es un pago legítimo** (lo normal): **no se toca**. El llamador
  tiene que usar un `intent_id` nuevo. Cambiar los términos de un intent ya pagado
  borraría el registro de a quién se le pagó.
- **Si la fila es basura de una prueba** (`status='claimed'`, sin firma, en una base de
  desarrollo): se puede borrar esa fila puntual. **Nunca en producción sin escalar.**

---

## D · Qué NO hacer, nunca

- **No** poner una fila en `confirmed` a mano para "destrabar": eso afirma un pago que
  nadie verificó y desactiva el dedup para ese intent para siempre.
- **No** borrar filas para "empezar de cero": la tabla es la única evidencia de a qué
  agente se le pagó. Sin ella no se puede decidir si alguien cobró dos veces.
- **No** vaciar `expired_signatures`.
- **No** tocar una fila cuya presencia on-chain no se pudo determinar. `unknown` no
  autoriza ninguna escritura.
