/**
 * Mock Registry Routes — Demo agents for multi-registry showcase
 *
 * Provides a fake "Community Hub" registry with hardcoded agents.
 * Acceptable for hackathon demo — shows multi-registry capability.
 */

import type { FastifyPluginAsync } from 'fastify';

interface MockAgent {
  id: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  price_per_call_usdc: number;
  reputation_score: number;
}

const MOCK_AGENTS: MockAgent[] = [
  {
    id: 'mock-summarizer-01',
    name: 'DocuSynth',
    slug: 'docusynth',
    description:
      'Summarizes long documents into structured briefs with key insights',
    tags: ['summarization', 'nlp', 'documents'],
    price_per_call_usdc: 0.02,
    reputation_score: 4.7,
  },
  {
    id: 'mock-translator-01',
    name: 'LinguaFlow',
    slug: 'linguaflow',
    description:
      'Real-time multi-language translation with context preservation',
    tags: ['translation', 'nlp', 'multilingual'],
    price_per_call_usdc: 0.01,
    reputation_score: 4.5,
  },
  {
    id: 'mock-analyzer-01',
    name: 'DataPulse',
    slug: 'datapulse',
    description:
      'Analyzes datasets and generates visual reports with actionable insights',
    tags: ['analytics', 'data', 'visualization'],
    price_per_call_usdc: 0.05,
    reputation_score: 4.9,
  },
];

const mockRegistryRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /mock-registry/agents
   * Returns hardcoded mock agents for demo purposes
   *
   * Query params:
   * - q: free text filter (matches name, description, tags)
   * - tag: capability/tag filter
   * - limit: max results
   */
  fastify.get('/', async (request, reply) => {
    const { q, tag, limit } = request.query as {
      q?: string;
      tag?: string;
      limit?: string;
    };

    let agents = [...MOCK_AGENTS];

    if (q) {
      const lower = q.toLowerCase();
      agents = agents.filter(
        (a) =>
          a.name.toLowerCase().includes(lower) ||
          a.description.toLowerCase().includes(lower) ||
          a.tags.some((t) => t.toLowerCase().includes(lower)),
      );
    }

    if (tag) {
      agents = agents.filter((a) => a.tags.includes(tag));
    }

    if (limit) {
      agents = agents.slice(0, parseInt(limit, 10));
    }

    return reply.send({ agents });
  });
};

export default mockRegistryRoutes;
