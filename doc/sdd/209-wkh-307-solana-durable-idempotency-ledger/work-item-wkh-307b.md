# Work Item — WKH-307b: aplicar el ledger de settle Solana a producción (caldz)

> **Founder-gated.** Deriva de WKH-307 (Done Definition 4). Sin este ticket, AC-7 deja
> una base sin esquema y el fail-closed de AC-11 es la única red — un desmantelamiento
> sin ticket es una llave dormida con otro nombre.

## Por qué existe

WKH-307 aplica la migración `20260730000000_wkh307_solana_settle_intents.sql`
**solo a bdwv** (desarrollo). Eso significa que **existe por diseño al menos una base
sin la tabla**: caldz, la de dinero real.

Mientras esa migración no esté en caldz, un entorno que apunte a caldz con
`SOLANA_ADAPTER_ENABLED=true` **no settlea Solana**: el preflight de esquema da
veredicto negativo y `settle()` rechaza ruidoso. Es fail-closed deliberado y
recuperable, **no** un doble pago.

Impacto operativo esperado hoy: **nulo**. El default de `SOLANA_ADAPTER_ENABLED` es
`false` y la cadena configurada es devnet.

## Alcance

1. Aplicar `20260730000000_wkh307_solana_settle_intents.sql` a **caldz**.
2. Verificar el post-estado **leyendo del catálogo** (no del exit code del applier):
   - `information_schema.columns` ⟹ la tabla existe y `amount_atomic` es `TEXT`;
   - `pg_indexes` ⟹ el índice de `settle_signature` es **UNIQUE y PARCIAL**;
   - `pg_get_functiondef` de las 4 funciones ⟹ deployadas, con el lease sobre `now()`
     y los tres términos del intent en el `WHERE`.
3. Recién entonces, habilitar el leg Solana en prod (`SOLANA_ADAPTER_ENABLED=true`).

## Precondiciones (bloqueantes)

- **La migración va ANTES que el código.** Orden correcto ⟹ sin ventana (la tabla nace
  vacía y nadie la lee). Orden inverso ⟹ el leg Solana no settlea hasta aplicarla.
- El applier de WKH-307 (`scripts/apply-wkh307-migration.mjs`) está **hardcodeado a
  bdwv y aborta si resuelve a caldz**. Para caldz hace falta un applier propio o el
  camino de `scripts/apply-prod-migrations.sh`, con su propia revisión.
- Deployar con `SOLANA_ADAPTER_ENABLED=false` o fuera de una ventana de tráfico Solana:
  el único riesgo residual es un compose-run **exactamente** a mitad de un settle
  durante el restart, que es una instancia del mismo problema que la HU corrige.

## Criterio de aceptación

- La tabla y las 4 funciones existen en caldz, verificadas contra el catálogo.
- El índice de `settle_signature` es `UNIQUE` **y** parcial. Si sale sin `UNIQUE`, el
  sistema queda PEOR que antes: dos legs al mismo agente por el mismo monto bajo el
  mismo blockhash producirían la misma firma, o sea una transferencia contabilizada
  como dos pagos.
- `warmSolanaSchemaPreflight()` no emite el `log.error` de esquema al arrancar.
