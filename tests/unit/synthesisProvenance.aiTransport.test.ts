// @vitest-environment node

// D11: provenance records a synthesis made through Cloudflare AI Gateway as
// `aiTransport: 'cloudflare-gateway'`, accepted only as that exact literal.
// Records without it (direct, Vercel AI Gateway, everything older) keep
// validating unchanged, and a Vercel AI Gateway route never combines with it.

import { describe, expect, it } from 'vitest';
import { aggregateProvenance, validateProvenance } from '@/lib/synthesisProvenance';
import type { AggregateSynthesisResult } from '@/types';

const direct = { aiProvider: 'claude' as const, aiModel: 'claude-sonnet-5-20260901', requestedAiModel: 'claude-sonnet-5' };

describe('synthesis provenance aiTransport (D11)', () => {
  it('keeps the gateway literal', () => {
    expect(validateProvenance({ ...direct, aiTransport: 'cloudflare-gateway' }))
      .toEqual({ ...direct, aiTransport: 'cloudflare-gateway' });
    expect(validateProvenance({
      aiProvider: 'openrouter',
      aiModel: 'openai/gpt-5.6-terra-2026-09-01',
      requestedAiModel: 'openai/gpt-5.6-terra',
      routedProvider: 'OpenAI',
      aiTransport: 'cloudflare-gateway',
    })).toMatchObject({ routedProvider: 'OpenAI', aiTransport: 'cloudflare-gateway' });
  });

  it('validates older records without the member exactly as before', () => {
    expect(validateProvenance(direct)).toEqual(direct);
    expect(validateProvenance(direct)).not.toHaveProperty('aiTransport');
  });

  it.each(['direct', 'gateway', 'Cloudflare-Gateway', '', null, 1, {}])('refuses any other value (%j)', (value) => {
    expect(validateProvenance({ ...direct, aiTransport: value })).toBeNull();
  });

  it('refuses a Vercel AI Gateway route combined with Cloudflare AI Gateway', () => {
    expect(validateProvenance({
      aiProvider: 'claude',
      aiModel: 'claude-sonnet-4.5',
      requestedAiModel: 'anthropic/claude-sonnet-4.5',
      routedProvider: 'anthropic',
    })).not.toBeNull();
    expect(validateProvenance({
      aiProvider: 'claude',
      aiModel: 'claude-sonnet-4.5',
      requestedAiModel: 'anthropic/claude-sonnet-4.5',
      routedProvider: 'anthropic',
      aiTransport: 'cloudflare-gateway',
    })).toBeNull();
  });

  it('gates stored aggregates the same way', () => {
    const aggregate = {
      ...direct,
      studyId: 's', studyRevision: 1, interviewIds: ['a'], interviewCount: 1, commonThemes: [], divergentViews: [],
      keyFindings: [], researchImplications: [], bottomLine: 'x', generatedAt: 1,
    } as AggregateSynthesisResult;
    expect(aggregateProvenance({ ...aggregate, aiTransport: 'cloudflare-gateway' })).toMatchObject({ aiTransport: 'cloudflare-gateway' });
    expect(aggregateProvenance({ ...aggregate, aiTransport: 'vercel' as never })).toBeNull();
  });
});
