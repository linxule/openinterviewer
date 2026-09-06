// Live-provider provenance smoke: one paid synthesizeInterview call through
// the real adapter, to confirm the served response carries a non-blank
// `model` (execution() in providers/shared.ts throws otherwise).
//
// Scope, deliberately narrow:
// - Skipped entirely unless SMOKE_PROVIDER names one provider.
// - Direct transport and standalone mode are forced; no Redis client is
//   constructed and nothing is read from or written to any store.
// - Synthetic study and transcript only. Output: provider, requested model,
//   served model, routed provider, and a failure class. Never the synthesis
//   body, never a raw response, never a key.
// - One adapter invocation. The SDKs' own retry defaults are not overridden
//   here (Anthropic and OpenAI SDKs retry up to 2 times on transient
//   failures, so a single invocation may be up to 3 HTTP requests). Output
//   caps come from the adapter: 8192 tokens for the synthesis call.
//
// Usage (one provider, one credential):
//   SMOKE_PROVIDER=openai OPENAI_API_KEY="$(op read 'op://…')" \
//     npx vitest run --config vitest.smoke.config.mts
// Optional: SMOKE_MODEL to override the provider's default model.

import { describe, expect, it } from 'vitest';
import { getInterviewProvider, isProviderType } from '@/lib/providers';
import { ProviderFailure, ProviderTimeoutError } from '@/lib/providerErrors';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  type BehaviorData,
  type InterviewMessage,
  type StudyConfig,
} from '@/types';

const selected = process.env.SMOKE_PROVIDER?.trim() ?? '';
const provider = isProviderType(selected) ? selected : null;

const DEFAULT_MODEL: Record<string, string> = {
  gemini: DEFAULT_GEMINI_MODEL,
  claude: DEFAULT_CLAUDE_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  openrouter: DEFAULT_OPENROUTER_MODEL,
};

const KEY_ENV: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function syntheticStudy(aiProvider: StudyConfig['aiProvider'], aiModel: string): StudyConfig {
  return {
    id: 'smoke-study',
    name: 'Smoke study',
    description: 'Synthetic study for a provenance smoke test.',
    researchQuestion: 'How do people decide when to replace a worn-out kitchen tool?',
    coreQuestions: [
      'What was the last kitchen tool you replaced?',
      'What made you decide it was time?',
      'Did anything about the replacement surprise you?',
    ],
    topicAreas: ['Replacement triggers', 'Purchase decision'],
    profileSchema: [
      { id: 'role', label: 'Cooking frequency', extractionHint: 'How often they cook', required: false },
    ],
    aiBehavior: 'standard',
    aiProvider,
    aiModel,
    consentText: 'Synthetic consent.',
    createdAt: 1_700_000_000_000,
  };
}

const TRANSCRIPT: InterviewMessage[] = [
  { id: 'm1', role: 'ai', content: 'What was the last kitchen tool you replaced?', timestamp: 1_700_000_000_000 },
  { id: 'm2', role: 'user', content: 'A non-stick frying pan. The coating had started flaking.', timestamp: 1_700_000_010_000 },
  { id: 'm3', role: 'ai', content: 'What made you decide it was time?', timestamp: 1_700_000_020_000 },
  { id: 'm4', role: 'user', content: 'Eggs kept sticking, and I read that flaking coating is not great to eat. I put it off for a month though.', timestamp: 1_700_000_030_000 },
];

const BEHAVIOR: BehaviorData = {
  timePerTopic: {},
  messagesPerTopic: {},
  topicsExplored: ['Replacement triggers'],
  contradictions: [],
};

describe.skipIf(!provider)('live provider provenance smoke', () => {
  it(`${provider ?? '(none)'}: synthesizeInterview returns a served model`, async () => {
    if (!provider) return;
    // Force the transport and mode this smoke is about; never inherit a
    // Gateway or hosted configuration from the shell.
    process.env.AI_TRANSPORT = 'direct';
    process.env.DEPLOYMENT_MODE = 'standalone';

    const keyEnv = KEY_ENV[provider];
    if (!process.env[keyEnv]?.trim()) {
      throw new Error(`${keyEnv} is not set; inject only this provider's credential`);
    }
    for (const [other, env] of Object.entries(KEY_ENV)) {
      if (other !== provider && process.env[env]?.trim()) {
        throw new Error(`${env} is also set; run with exactly one provider credential`);
      }
    }

    const model = process.env.SMOKE_MODEL?.trim() || DEFAULT_MODEL[provider];
    const study = syntheticStudy(provider, model);
    const adapter = getInterviewProvider(study, {});

    try {
      const result = await adapter.synthesizeInterview(TRANSCRIPT, study, BEHAVIOR, null);
      const { execution } = result;
      console.log(JSON.stringify({
        smoke: 'provider-provenance',
        provider: execution.provider,
        requestedModel: execution.requestedModel,
        servedModel: execution.model,
        ...(execution.routedProvider ? { routedProvider: execution.routedProvider } : {}),
        themes: result.value.themes.length,
      }));
      expect(execution.provider).toBe(provider);
      expect(execution.requestedModel).toBe(model);
      expect(execution.model.trim().length).toBeGreaterThan(0);
    } catch (error) {
      // Report the class only. A missing served model surfaces here as
      // ProviderFailure kind 'invalid-response' — that is the finding this
      // smoke exists to detect; do not retry, bring the class back.
      const failure = error instanceof ProviderFailure
        ? { class: 'ProviderFailure', kind: error.kind, message: error.message }
        : error instanceof ProviderTimeoutError
          ? { class: 'ProviderTimeoutError' }
          : { class: error instanceof Error ? error.name : 'UnknownError' };
      console.log(JSON.stringify({ smoke: 'provider-provenance', provider, requestedModel: model, failure }));
      throw error;
    }
  });
});
