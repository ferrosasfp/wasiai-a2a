/**
 * Basic example of using WasiAI A2A Protocol
 * 
 * This demonstrates:
 * 1. Setting up the A2A client with adapters
 * 2. Discovering agents by capability
 * 3. Composing a multi-agent pipeline
 * 4. Using goal-based orchestration
 */

import { A2A } from '@wasiai/a2a-core'
import { WasiAIAdapter } from '@wasiai/a2a-adapter-wasiai'
// import { KiteAdapter } from '@wasiai/a2a-adapter-kite'
// import { KitePayments } from '@wasiai/a2a-payments-kite'

async function main() {
  // ==========================================================
  // SETUP
  // ==========================================================
  
  const a2a = new A2A({
    // Connect to WasiAI registry
    registry: new WasiAIAdapter({
      apiKey: process.env.WASIAI_API_KEY!,
    }),
    
    // Uncomment to add Kite registry (multi-registry support)
    // registry: [
    //   new WasiAIAdapter({ apiKey: process.env.WASIAI_API_KEY! }),
    //   new KiteAdapter({ apiKey: process.env.KITE_API_KEY! }),
    // ],
    
    // Uncomment to enable Kite payments
    // payments: new KitePayments({
    //   agentPassportAddress: process.env.KITE_PASSPORT_ADDRESS!,
    // }),
    
    debug: true,
  })

  // ==========================================================
  // EXAMPLE 1: Discovery
  // ==========================================================
  
  console.log('\n--- Discovery ---\n')
  
  const discovered = await a2a.discover({
    capabilities: ['token-analysis', 'risk-assessment'],
    maxPrice: 0.10,
    limit: 5,
  })
  
  console.log(`Found ${discovered.total} agents:`)
  for (const agent of discovered.agents) {
    console.log(`  - ${agent.name} (${agent.slug}): $${agent.priceUsdc}`)
  }

  // ==========================================================
  // EXAMPLE 2: Get specific agent
  // ==========================================================
  
  console.log('\n--- Get Agent ---\n')
  
  const agent = await a2a.getAgent('chainlink-oracle')
  if (agent) {
    console.log(`Agent: ${agent.name}`)
    console.log(`Price: $${agent.priceUsdc}`)
    console.log(`Capabilities: ${agent.capabilities.join(', ')}`)
  }

  // ==========================================================
  // EXAMPLE 3: Compose pipeline
  // ==========================================================
  
  console.log('\n--- Compose Pipeline ---\n')
  
  const result = await a2a.compose([
    {
      agent: 'chainlink-oracle',
      input: { token: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' }, // USDC
    },
    {
      agent: 'risk-report',
      input: { data: '$prev.output' }, // Use previous step's output
    },
  ], {
    maxBudget: 0.50,
    stopOnError: true,
  })
  
  if (result.success) {
    console.log('Pipeline completed!')
    console.log(`Total cost: $${result.totalCostUsdc}`)
    console.log(`Total latency: ${result.totalLatencyMs}ms`)
    console.log('Final output:', JSON.stringify(result.output, null, 2))
  } else {
    console.error('Pipeline failed:', result.error?.message)
  }

  // ==========================================================
  // EXAMPLE 4: Orchestrate from goal
  // ==========================================================
  
  console.log('\n--- Orchestrate ---\n')
  
  const orchestrated = await a2a.orchestrate({
    goal: 'Analyze token 0xABC and tell me if it is safe to buy',
    budget: 0.50,
    maxAgents: 3,
  })
  
  console.log('Answer:', orchestrated.answer)
  console.log('Reasoning:', orchestrated.reasoning)
  console.log(`Used ${orchestrated.pipeline.steps.length} agents`)
  console.log(`Total cost: $${orchestrated.pipeline.totalCostUsdc}`)
}

main().catch(console.error)
