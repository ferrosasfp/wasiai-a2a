# Auto-Blindaje — WKH-63 / SEC-REG-1

Errores corregidos durante F3 y patrones a aplicar en futuras HUs.

---

### [2026-04-27 21:45] Wave 0 — Story File ausente al iniciar F3
- **Error**: `doc/sdd/060-wkh-63-sec-reg-1/story-WKH-63.md` no existe en disco al lanzar `nexus-dev`. El directorio `060-wkh-63-sec-reg-1` tampoco existía.
- **Causa raíz**: F2.5 no fue ejecutada (o fue saltada) y la rama `feat/060-wkh-63-sec-reg-1` se creó sin el artefacto Story File. El orquestador pasó el detalle de las waves directamente en el prompt como sustituto.
- **Fix**: Procedo con el prompt del orquestador como Story File substitute, basándome en exemplares ya en repo (WKH-53 ownership pattern, WKH-61 scope check, WKH-62 SSRF guard) que sí están en `doc/sdd/`. Documento la ausencia para que QA lo detecte.
- **Aplicar en**: cualquier HU futura — antes de lanzar `nexus-dev`, verificar `ls doc/sdd/NNN-titulo/story-*.md` retorna match. Si falla, lanzar primero `/nexus-p3-f2-5 WKH-XX`.

---
