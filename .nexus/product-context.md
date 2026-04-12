# product-context.md — Contexto de Negocio

> Contenido definido por Fernando Rosas (founder/CTO, OpenClaw).
> El analyst lo lee en F0 antes de cada HU para entender el dominio.
> El detalle tecnico vive en `project-context.md`. Este doc es solo negocio.
>
> **Limite: ~200 lineas.**

---

## Producto

| Campo | Valor |
|-------|-------|
| **Nombre** | WasiAI A2A Protocol |
| **Que resuelve** | Los agentes autonomos estan encerrados en silos: cada marketplace tiene su propia API, no hay forma estandar de descubrir, componer ni pagar agentes entre plataformas. WasiAI A2A es la capa de interoperabilidad que conecta todos los marketplaces. |
| **Para quien** | Desarrolladores de agentes, marketplaces de agentes, empresas que consumen agentes como servicio |
| **Estado** | MVP — testnet desplegado en produccion, primer consumidor real validado (Anthropic Managed Agent) |
| **Empresa** | OpenClaw (Fernando Rosas, Eli) |

## Personas

| Persona | Objetivo | Pain point | Comportamiento tipico |
|---------|----------|------------|----------------------|
| **Agent Developer** | Publicar su agente y que otros lo descubran y le paguen automaticamente | Cada marketplace tiene su API propietaria; publicar en N marketplaces requiere N integraciones | Registra su agente en 1 marketplace y queda encerrado ahi, perdiendo alcance |
| **Agent Consumer** (humano o agente autonomo) | Encontrar el mejor agente para una tarea, pagarlo y obtener resultado — sin friccion | Tiene que buscar manualmente en cada marketplace, copiar outputs entre agentes, pagar en cada uno por separado | Busca en 3 sitios, compara manualmente, copia texto entre tabs, pierde tiempo y contexto |
| **Marketplace Operator** | Expandir su catalogo de agentes sin construir todo in-house | Duplicar agentes de otros marketplaces es caro, fragil y genera data stale | Scraping manual o acuerdos bilaterales que no escalan |

## Vision del producto

WasiAI A2A es a los agentes lo que Stripe es a los pagos: una capa invisible que conecta a todos. El consumidor dice "necesito X" y el protocolo encuentra al mejor agente, lo paga, lo ejecuta y devuelve el resultado. Zero human in the loop.

**Diferenciador clave:** no somos un marketplace mas — somos el protocolo que los conecta a todos. Implementamos Google A2A Protocol (estandar abierto, 50+ partners) como gateway operativo.

## Flujos principales

### 1. Orquestacion autonoma (el core del producto)

1. Un agente consumidor envia un goal en lenguaje natural ("get AVAX price in USD") con un budget
2. El gateway cobra el servicio (pago on-chain gasless o debito de creditos pre-pagados)
3. Un LLM selecciona los mejores agentes de todos los marketplaces registrados
4. El gateway compone un pipeline multi-agente, adaptando schemas entre ellos
5. El resultado se devuelve al consumidor en formato estandar

### 2. Discovery multi-marketplace

1. Un consumidor busca agentes por capacidad, texto libre o precio maximo
2. El gateway busca en paralelo en todos los marketplaces registrados
3. Devuelve resultados unificados, rankeados por reputacion y precio

### 3. Identidad y creditos (economia agentica)

1. Un agente se registra una vez y obtiene una clave de identidad unica
2. Deposita creditos (pre-pago) para consumir servicios
3. Cada llamada descuenta atomicamente del balance — cobro antes de ejecucion, refund si falla
4. Alternativa: pago directo on-chain por llamada (sin cuenta, sin registro)

## Modelo de negocio

| Revenue stream | Como funciona | Estado |
|----------------|---------------|--------|
| **Protocol fee (1%)** | Comision sobre cada orquestacion/composicion ejecutada | Conceptual — settlement real pendiente |
| **Discovery premium** | Features avanzados de busqueda y ranking para operadores | Futuro |
| **B2B licensing** | Otros marketplaces integran el protocolo en su plataforma | Futuro |

## Restricciones de negocio

- **Hackathon Kite AI Global 2026** — track Agentic Commerce, deadline 26 abril, finale 6 mayo
- **Filosofia fundacional**: "Producto para produccion, no software para hackathon" — calidad real, tests, arquitectura extensible
- **Multi-chain obligatorio**: el producto debe funcionar en Kite hoy, en otras blockchains manana. Sin dependencia de una sola chain.
- **Dependencia externa: Kite team** — necesitamos tokens de prueba y confirmacion de formatos de pago. Respuestas llegan via Discord (Stephen A es nuestro contacto).
- **Dependencia externa: Pieverse** — facilitador de pagos on-chain. No controlamos su uptime ni su formato.
- **Kite Passport**: sistema de identidad on-chain de Kite. API descubierta pero no integrada aun — no bloqueante para MVP porque tenemos identidad propia.

## Decisiones de producto

- **Identidad propia sobre depender de Kite Passport** — Passport no tiene SDK listo. Nuestra identidad (A2A Keys) es chain-agnostic y coexistira con Passport cuando este madure.
- **Cobro antes de ejecucion (optimistic debit)** — patron Stripe. Previene abuso: si no hay fondos, no se ejecuta. Si falla, refund automatico.
- **Validacion con consumidor real antes de features nuevos** — usamos Anthropic Managed Agents como primer cliente autonomo. Encontro 5 bugs reales que corregimos antes de seguir agregando features.
- **Multi-chain desde el dia 1** — la misma codebase corre en cualquier blockchain EVM cambiando una variable de entorno. No hay logica hardcoded a Kite.
- **Sin colas de mensajeria en MVP** — el volumen actual no justifica Redis/BullMQ. Se agrega cuando haya carga real.

## Competidores / Landscape

| Proyecto | Que hace | Diferencia con WasiAI A2A |
|----------|----------|---------------------------|
| **Google A2A Protocol** | Define el estandar de interop entre agentes | Nosotros IMPLEMENTAMOS el protocolo como gateway operativo — Google solo publica el spec |
| **MCP (Anthropic)** | Protocolo para conectar herramientas (tools) a agentes | MCP opera a nivel herramienta, A2A a nivel agente (tareas completas). Son complementarios |
| **Kite Marketplace** | Marketplace de agentes en Kite chain | Es UN registry mas — nosotros agregamos TODOS los registries en una sola busqueda |
| **CrewAI / AutoGen** | Frameworks de codigo para orquestar multi-agente | Son librerias (requieren codigo). Nosotros somos servicio (API). Agentes de CrewAI pueden consumir nuestro gateway |

## Equipo

| Rol | Persona | Foco |
|-----|---------|------|
| Founder / CTO | Fernando Rosas | Arquitectura, desarrollo, integracion Kite |
| Co-founder | Eli | Pitch, narrativa, presentacion |
| Contacto Kite | Rebecca (hackathon), Stephen A (tech) | Soporte ecosystem |

## Backlog priorizado (sprint actual — 2026-04-11)

| HU | Titulo | Prioridad | Estado |
|----|--------|-----------|--------|
| WKH-X402-V2 | Pagos on-chain E2E con facilitador | Critica | Bloqueado — esperando confirmacion de Kite team |
| WKH-26 | Checkpoint mid-hackathon | Alta | Pendiente — confirmar formato con Rebecca |
| WKH-31 | Pitch deck final | Alta | En progreso (Eli) |

> Board Jira: proyecto WKH en Atlassian (OpenClaw workspace)

## Fuentes

- Pitch deck: wasiai-landing/public/pitch-v6/
- Documentacion tecnica: doc/architecture/CHAIN-ADAPTIVE.md
- Contratos blockchain: doc/kite-contracts.md
- Historias de usuario: doc/sdd/_INDEX.md

---

*Ultima actualizacion: 2026-04-11 por Claude (delegated by Fernando Rosas)*
