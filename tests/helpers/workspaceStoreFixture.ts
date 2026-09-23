// Standalone ResearcherContext for route tests that mock researcherContext.
// The store is the real Redis WorkspaceStore adapter over the test's RedisPort,
// so tests that mock kv.ts / participantLinks.ts functions keep exercising the
// same calls the production Node standalone path makes.
import type { RedisPort } from '@/lib/redisPort';
import type { ResearcherContext } from '@/lib/researcherContext';
import { createRedisWorkspaceStore } from '@/lib/storage/redis';

export function standaloneTestContext(
  kvClient: RedisPort,
  overrides: Partial<ResearcherContext> = {},
): ResearcherContext {
  return {
    researcherId: null,
    kvClient,
    store: createRedisWorkspaceStore(kvClient, { researcherId: null }),
    geminiApiKey: null,
    anthropicApiKey: null,
    openaiApiKey: null,
    openrouterApiKey: null,
    onboardingComplete: true,
    ...overrides,
  };
}

export function hostedTestContext(
  kvClient: RedisPort,
  researcherId: string,
  overrides: Partial<ResearcherContext> = {},
): ResearcherContext {
  return standaloneTestContext(kvClient, {
    researcherId,
    store: createRedisWorkspaceStore(kvClient, { researcherId }),
    ...overrides,
  });
}
