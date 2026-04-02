/**
 * WasiAI A2A Protocol
 * 
 * Agent discovery, composition, and orchestration service.
 * Supports multiple marketplace registries via configuration.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import registriesRoutes from './routes/registries'
import discoverRoutes from './routes/discover'
import composeRoutes from './routes/compose'
import orchestrateRoutes from './routes/orchestrate'

// Kite: importar dispara la inicialización (top-level await en el módulo)
import { kiteClient } from './services/kite-client.js'

const app = new Hono()

// Middleware
app.use('*', cors())
app.use('*', logger())

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'WasiAI A2A Protocol',
    version: '0.1.0',
    description: 'Agent discovery, composition, and orchestration service',
    endpoints: {
      registries: '/registries — Manage marketplace registrations',
      discover: '/discover — Search agents across all registries',
      compose: '/compose — Execute multi-agent pipelines',
      orchestrate: '/orchestrate — Goal-based orchestration',
    },
    docs: 'https://github.com/ferrosasfp/wasiai-a2a',
  })
})

// Routes
app.route('/registries', registriesRoutes)
app.route('/discover', discoverRoutes)
app.route('/compose', composeRoutes)
app.route('/orchestrate', orchestrateRoutes)

// Start server
const port = parseInt(process.env.PORT ?? '3001')

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           WasiAI A2A Protocol                             ║
║   Agent Discovery, Composition & Orchestration Service    ║
╠═══════════════════════════════════════════════════════════╣
║   Server running on http://localhost:${port}                  ║
║   Kite: ${kiteClient ? 'connected (chainId: 2368)     ' : 'disabled (KITE_RPC_URL not set)'}║
║                                                           ║
║   Endpoints:                                              ║
║   • GET  /registries     — List marketplaces              ║
║   • POST /registries     — Register marketplace           ║
║   • GET  /discover       — Search agents                  ║
║   • POST /compose        — Execute pipeline               ║
║   • POST /orchestrate    — Goal-based orchestration       ║
╚═══════════════════════════════════════════════════════════╝
`)

serve({ fetch: app.fetch, port })

export default app
