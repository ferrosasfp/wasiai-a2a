# Auto-Blindaje — #116 WKH-SEC-02 (RLS Postgres-level)

### [2026-06-20 03:19] Wave 2 — Conteo frágil de sentencias DDL en el test estructural
- **Error**: El test estructural del down `.sql` falló (`expected 9 to be 7`). Usé un `countOccurrences(sql, 'DISABLE ROW LEVEL SECURITY')` por substring crudo, que también contaba las 2 menciones de la frase dentro del comentario "NOTA OPS (DT-6)" del down, además de las 7 sentencias reales.
- **Causa raíz**: Aserción frágil por substring sobre todo el archivo (incluye comentarios). El up no falló por coincidencia (su comentario no contiene la frase exacta `ENABLE ROW LEVEL SECURITY` en mayúsculas seguidas), lo que ocultaba el problema en el up.
- **Fix**: Reemplacé `countOccurrences` por `countDdlStatements(sql, action)` que cuenta solo líneas DDL reales con regex `ALTER TABLE public.<t> <action> ROW LEVEL SECURITY;`, ignorando comentarios. Aplicado tanto al up (ENABLE) como al down (DISABLE). Matcher no-posicional, alineado con lección WKH-121.
- **Aplicar en**: Cualquier test estructural que cuente apariciones de un keyword SQL en un archivo con comentarios — contar sentencias completas (con su forma `ALTER TABLE ... ;`), no substrings sueltas. Especialmente cuando el comentario de cabecera de la migración menciona la misma operación que el DDL.
