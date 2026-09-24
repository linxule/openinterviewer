import type { ProviderExecution, ProviderExecutionPolicy, ProviderResult } from '../ai';
import type { AIProviderType, AggregateSynthesisProviderPayload, AggregateSynthesisResult, StudyConfig } from '@/types';
import type { FollowupStudy } from '../providerValidation';
import { ProviderFailure } from '../providerErrors';

export const GREETING_DEADLINE_MS = 30_000;
export const INTERVIEW_DEADLINE_MS = 60_000;
export const SYNTHESIS_DEADLINE_MS = 120_000;

export type AggregateSynthesisPayload = AggregateSynthesisProviderPayload;

export function isQueuedSynthesis(
  policy: ProviderExecutionPolicy | undefined,
): policy is Extract<ProviderExecutionPolicy, { kind: 'queued-synthesis' }> {
  return policy?.kind === 'queued-synthesis';
}

/** The synthesis deadline for a policy; a queued deadline never exceeds the default. */
export function synthesisDeadlineMs(policy: ProviderExecutionPolicy | undefined): number {
  if (!isQueuedSynthesis(policy)) return SYNTHESIS_DEADLINE_MS;
  if (!Number.isSafeInteger(policy.deadlineMs) || policy.deadlineMs <= 0) {
    throw new Error('Queued synthesis requires a positive integer deadline');
  }
  return Math.min(policy.deadlineMs, SYNTHESIS_DEADLINE_MS);
}

export function providerResult<T>(
  value: T,
  execution: ProviderExecution,
): ProviderResult<T> {
  return { value, execution };
}

/**
 * `transport` is the endpoint the adapter actually used; only the Cloudflare
 * AI Gateway is recorded (`aiTransport`), so direct provenance is unchanged.
 */
export function execution(
  provider: AIProviderType,
  requestedModel: string,
  responseModel?: string | null,
  routedProvider?: string | null,
  transport: 'direct' | 'cloudflare-gateway' = 'direct',
): ProviderExecution {
  const model = typeof responseModel === 'string' ? responseModel.trim() : '';
  if (!model) {
    throw new ProviderFailure('invalid-response', `${provider} response omitted its resolved model`);
  }
  return {
    provider,
    requestedModel,
    model,
    ...(routedProvider?.trim() ? { routedProvider: routedProvider.trim() } : {}),
    ...(transport === 'cloudflare-gateway' ? { aiTransport: 'cloudflare-gateway' as const } : {}),
  };
}

export function formatInterviewHistory(history: ReadonlyArray<{ role: string; content: string }>): string {
  return history
    .map((message) => {
      const speaker = message.role === 'ai'
        ? 'INTERVIEWER'
        : message.role === 'system'
          ? 'SYSTEM EVENT'
          : 'PARTICIPANT';
      return `${speaker}: ${message.content}`;
    })
    .join('\n\n');
}

export function buildFollowupPrompt(
  parentConfig: StudyConfig,
  synthesis: AggregateSynthesisResult,
): string {
  return `You are helping design a follow-up research study.

PARENT STUDY: "${parentConfig.name}"
PARENT SUMMARY: ${synthesis.bottomLine}

KEY FINDINGS:
${synthesis.keyFindings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')}

RESEARCH IMPLICATIONS:
${synthesis.researchImplications.map((implication, index) => `${index + 1}. ${implication}`).join('\n') || 'None specified'}

DIVERGENT VIEWS:
${synthesis.divergentViews.map((view) => `- ${view.topic}: "${view.viewA}" vs "${view.viewB}"`).join('\n') || 'None identified'}

Generate a follow-up study that digs deeper into gaps or tensions found. The
follow-up should explore unanswered questions or interesting patterns from the
original study.`;
}

export type FollowupPayload = FollowupStudy;
