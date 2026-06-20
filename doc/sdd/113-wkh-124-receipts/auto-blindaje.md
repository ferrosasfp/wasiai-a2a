# Auto-Blindaje — WKH-124 KEY-RECEIPTS (F3 Dev)

### [2026-06-19] Wave 2 — `request.a2aKeyRow` no existe en `OrchestrateRequest`
- **Error**: el Story File (call-site table L126 + L62) indica emitir `protocol_fee` desde `orchestrate.ts` usando `request.a2aKeyRow.owner_ref` / `request.a2aKeyRow.id`. Ese campo NO existe en `OrchestrateRequest` (`src/types/index.ts:384-413`); compilar contra `request.a2aKeyRow` daría error TS.
- **Causa raíz**: el nombre `a2aKeyRow` es el del row del request Fastify (`request.a2aKeyRow` en `a2a-key.ts`), NO el del DTO `OrchestrateRequest`. En `OrchestrateRequest` el row del caller (con `owner_ref` + `id`) viaja como `scopingKeyRow?: A2AAgentKeyRow` (`src/types/index.ts:396`), ya propagado a compose (`orchestrate.ts:409`).
- **Fix**: usar `request.scopingKeyRow?.owner_ref` / `request.scopingKeyRow?.id` como fuente del linaje en el call-site `protocol_fee`. La intención del Story File (L50-51, L62) es inequívoca: "el row del caller disponible en el call-site con owner_ref e id". Guard `if (request.scopingKeyRow?.owner_ref)` antes de emitir (CD-D: sin ownerRef NO se emite).
- **Aplicar en**: cualquier futura emisión de recibos desde orchestrate/compose: el row del caller es `scopingKeyRow`, no `a2aKeyRow`.
