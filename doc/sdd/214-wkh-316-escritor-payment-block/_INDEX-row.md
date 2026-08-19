# Fila para `doc/sdd/_INDEX.md`

> ⚠️ **YA INSERTADA — NO VOLVER A COPIARLA.** La fila `214` del índice existe desde el
> saneamiento del 2026-08-10. Copiarla de nuevo crearía una fila duplicada, y el guardián
> `test/sdd-index-matches-folders.test.ts` (control G-A2) pone `npm test` en **rojo** si eso
> pasa. Este archivo es el registro de cómo se redactó, **no** la fila vigente: la vigente es
> `doc/sdd/_INDEX.md:181`, reescrita en la fase DONE el 2026-08-19 (ver el aviso de abajo).

**Dónde va**: en `doc/sdd/_INDEX.md`, dentro de la tabla que arranca en la línea 3
(`| # | Fecha | HU | Tipo | Mode | Status | Branch |`), **al final del cuerpo de la tabla**,
después de la última fila numerada y **antes** de la sección
`## ⚠️ Deuda de numeración de este índice (anotada, NO resuelta)` — ⚠️ **medido el 2026-08-19: esa sección ya no existe** (el saneamiento del 2026-08-10 la reemplazó), y la línea 181 es hoy la fila `214`.

**No la agregué yo**: reescribir `_INDEX.md` está prohibido en F1 y hay tres árboles de trabajo
activos sobre este repo.

```
| 214 | 2026-07-29 | [WKH-316] El escritor del bloque de pago de un agente — `payment` en POST/PATCH /agents | feature | QUALITY | DONE — pipeline cerrado 2026-08-19, NO MERGEADA / NO PUSHEADA (texto completo y medido en `doc/sdd/_INDEX.md:181`) | feat/214-wkh-316-payment-block ([work-item.md](work-item.md) · [done-report.md](done-report.md)) |
```

## Verificación del número

`214` está libre. Verificado listando los directorios de `doc/sdd/`: el prefijo numérico más alto
existente es `213` (`213-wkh-315-deposito-prepago-solana`). `210`, `211`, `212` y `213` están
tomados:

| Directorio | HU |
|---|---|
| `209-wkh-307-solana-durable-idempotency-ledger` | WKH-307 |
| `210-wkh-308-verify-tres-estados` | WKH-308 |
| `211-wkh-313-primer-trabajo-agentes-sin-historial` | WKH-313 |
| `212-wkh-314-x402-inbound-solana` | WKH-314 |
| `213-wkh-315-deposito-prepago-solana` | WKH-315 |
| **`214-wkh-316-escritor-payment-block`** | **WKH-316 (esta)** |

⚠️ El índice arrastra deuda de numeración conocida (cuatro directorios comparten el `190`, y varios
directorios no tenían fila propia). El puntero original decía `_INDEX.md:181-209`: **medido el
2026-08-19, es falso** — `:181` es esta misma fila. Hoy eso vive en `_INDEX.md:219` y `:318`.
