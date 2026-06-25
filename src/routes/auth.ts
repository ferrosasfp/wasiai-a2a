/**
 * Auth Routes — A2A Agent Key endpoints
 * WKH-34: Agentic Economy Primitives L3
 *
 * POST /agent-signup  — Create new agent key (AC-13)
 * POST /deposit       — Register deposit (AC-14)
 * GET  /me            — Get key status (AC-15)
 * POST /bind/:chain   — Placeholder for on-chain binding (AC-16)
 *
 * Refactor B2 (2026-06-24): pure reorganization. The handlers/parsers that used
 * to live inline in this god-file now live under `./auth/`, one sub-plugin per
 * domain. This file is the AGGREGATOR and preserves the EXACT public interface
 * (`export default authRoutes`) plus the original route surface — every route is
 * still mounted at the same path under the `/auth` prefix supplied by the caller
 * (`src/index.ts`). Sub-plugins are registered in source order; none of these
 * routes overlap, so Fastify's radix-tree routing is order-independent here.
 */

import type { FastifyPluginAsync } from 'fastify';
import { bindRoutes } from './auth/bind.js';
import { delegationRoutes } from './auth/delegation.js';
import { depositRoutes } from './auth/deposit.js';
import { fundingWalletRoutes } from './auth/funding-wallet.js';
import { identityRoutes } from './auth/identity.js';
import { keySessionRoutes } from './auth/key-session.js';
import { meRoutes } from './auth/me.js';
import { requireSignatureRoutes } from './auth/require-signature.js';
import { signupRoutes } from './auth/signup.js';
import { spendPolicyRoutes } from './auth/spend-policy.js';

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Registered at the SAME prefix level as the original inline routes (no nested
  // prefix), so every path stays identical under the caller's `/auth` prefix.
  await fastify.register(signupRoutes);
  await fastify.register(fundingWalletRoutes);
  await fastify.register(depositRoutes);
  await fastify.register(meRoutes);
  await fastify.register(identityRoutes);
  await fastify.register(delegationRoutes);
  await fastify.register(keySessionRoutes);
  await fastify.register(spendPolicyRoutes);
  await fastify.register(requireSignatureRoutes);
  await fastify.register(bindRoutes);
};

export default authRoutes;
