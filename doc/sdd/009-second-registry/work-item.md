# WKH-32 — Registrar segundo marketplace para demo multi-registry

| Campo | Valor |
|-------|-------|
| **HU** | WKH-32 |
| **Tipo** | feature |
| **Talla** | S |
| **Branch** | `feat/wkh-32-mock-registry` |
| **Base** | `main` |
| **Mode** | SPEED (hackathon) |

---

## Contexto

`/discover` ya soporta multi-registry (consulta todos los enabled en paralelo, merge + sort). Solo existe WasiAI como registry en la tabla `registries`. Los jueces necesitan ver agentes de **múltiples fuentes** para validar la propuesta de valor.

### Decisión de diseño

**Opción elegida: Mock Registry interno** (ruta `/mock-registry/agents` en el propio servicio).

Razones:
- Kite **no tiene API pública de agentes** (verificado: solo Agent Passport ERC-8004 on-chain, sin endpoint de discovery)
- No existe otro marketplace público con API compatible en este momento
- Un endpoint interno es **zero-infra** (no necesita Railway ni deploy extra)
- Para la demo, basta con 3-5 agentes fake con datos realistas
- Es talla S: ~1h de trabajo

---

## Acceptance Criteria (EARS)

| # | Tipo | Criterio |
|---|------|----------|
| AC-1 | Ubiquitous | `GET /mock-registry/agents` retorna un JSON con al menos 3 agentes de prueba con campos: `id`, `name`, `slug`, `description`, `tags`, `price_per_call_usdc`, `reputation_score` |
| AC-2 | Ubiquitous | Existe un registro en tabla `registries` con `id='mock-community'`, `name='Community Hub'`, `enabled=true`, `discovery_endpoint` apuntando a `{SELF_URL}/mock-registry/agents` |
| AC-3 | Ubiquitous | `POST /discover` sin filtro de registry retorna agentes de **ambos** registries (WasiAI + Community Hub), cada uno con campo `registry` correcto |
| AC-4 | Event-driven | **Cuando** el mock registry endpoint falla, **el sistema** retorna agentes de los demás registries sin error (ya implementado en `discoveryService.discover` con `.catch()`) |
| AC-5 | Ubiquitous | La migración SQL inserta el registro `mock-community` de forma idempotente (`ON CONFLICT DO NOTHING`) |

---

## Scope

### In scope
- Ruta GET `/mock-registry/agents` con agentes hardcoded (aceptable para demo)
- Migración SQL para seed del segundo registry
- Los agentes mock deben tener datos realistas (nombres, descripciones, precios, capabilities variadas)

### Out of scope
- Invoke real de agentes mock (solo discovery)
- Autenticación del mock endpoint
- UI changes

---

## Waves

### Wave 1 — Mock endpoint + seed (única wave)

| Paso | Archivo | Qué hacer |
|------|---------|-----------|
| 1 | `src/routes/mock-registry.ts` | Crear ruta `GET /mock-registry/agents` que retorna `{ agents: [...] }` con 3-5 agentes mock |
| 2 | `src/index.ts` | Registrar la nueva ruta |
| 3 | `supabase/migrations/20260404000000_mock_community_registry.sql` | INSERT del registry `mock-community` apuntando a `${SELF_URL}/mock-registry/agents` |
| 4 | `test/mock-registry.test.ts` | Test: endpoint retorna agentes, discover retorna de ambos registries |

### Nota sobre SELF_URL
El `discovery_endpoint` del mock registry necesita la URL del propio servicio. Opciones:
- **Env var `SELF_URL`** (ej: `http://localhost:3001` en dev, URL de Railway en prod)
- **Seed manual** tras deploy (ajustar URL en Supabase dashboard)
- **Recomendación:** usar env var `SELF_URL` con fallback a `http://localhost:${PORT}`

---

## Datos mock sugeridos

```json
[
  {
    "id": "mock-summarizer-01",
    "name": "DocuSynth",
    "slug": "docusynth",
    "description": "Summarizes long documents into structured briefs with key insights",
    "tags": ["summarization", "nlp", "documents"],
    "price_per_call_usdc": 0.02,
    "reputation_score": 4.7
  },
  {
    "id": "mock-translator-01",
    "name": "LinguaFlow",
    "slug": "linguaflow",
    "description": "Real-time multi-language translation with context preservation",
    "tags": ["translation", "nlp", "multilingual"],
    "price_per_call_usdc": 0.01,
    "reputation_score": 4.5
  },
  {
    "id": "mock-analyzer-01",
    "name": "DataPulse",
    "slug": "datapulse",
    "description": "Analyzes datasets and generates visual reports with actionable insights",
    "tags": ["analytics", "data", "visualization"],
    "price_per_call_usdc": 0.05,
    "reputation_score": 4.9
  }
]
```

---

## Schema del registry mock-community

```json
{
  "discovery": {
    "queryParam": "q",
    "limitParam": "limit",
    "capabilityParam": "tag",
    "agentsPath": "agents",
    "agentMapping": {
      "id": "id",
      "name": "name",
      "slug": "slug",
      "description": "description",
      "capabilities": "tags",
      "price": "price_per_call_usdc",
      "reputation": "reputation_score"
    }
  },
  "invoke": {
    "method": "POST",
    "inputField": "input",
    "resultPath": "result"
  }
}
```

---

## Riesgos

| Riesgo | Mitigación |
|--------|------------|
| SELF_URL no configurada | Fallback a `http://localhost:3001`; documentar en README |
| Jueces preguntan si agentes son reales | Transparencia: "Community Hub es un registry de demostración que muestra la capacidad multi-registry del protocolo" |

---

*Generado por NexusAgil F0+F1 — 2026-04-04*
