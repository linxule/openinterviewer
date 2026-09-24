// JOB-09 in workerd: each direct adapter, built by the Workers bundler (so
// @google/genai resolves to its web build), under the queued-synthesis policy.
// A request-counting fetch fixture proves exactly one outbound synthesis
// request per fault, and the job settles per the classification table
// (IMPLEMENTATION.md §5). Error statuses carry `retry-after-ms: 1`, so an
// enabled SDK retry would reach the fixture well inside the 300 ms deadline
// and fail the count deterministically.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProviderType } from '../../src/types';
import { ProviderTimeoutError } from '../../src/lib/providerErrors';
import { ClaudeProvider } from '../../src/lib/providers/claude';
import { GeminiProvider } from '../../src/lib/providers/gemini';
import { OpenAIProvider } from '../../src/lib/providers/openai';
import { OpenRouterProvider } from '../../src/lib/providers/openrouter';
import { providerEndpoint } from '../../src/lib/providers/endpoint';
import { workspaceStub } from './helpers';
import {
  analysisRow,
  captureQueue,
  deliver,
  installProviderFixture,
  jobRow,
  PROVIDER_MODELS,
  resetWorkspace,
  seedJob,
  studyConfig,
  SYNTHESIS,
  type ProviderBehavior,
} from './jobFixtures';

const PROVIDERS: AIProviderType[] = ['openai', 'claude', 'gemini', 'openrouter'];
/** Short queued deadline so a hanging provider times out quickly in tests. */
const TEST_DEADLINE_MS = 300;
const HISTORY = [{ id: 'm1', role: 'user' as const, content: 'Hello', timestamp: 1 }];
const BEHAVIOR = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };

type Expected =
  | { job: 'complete' }
  | { job: 'failed'; failureKind: 'provider' | 'invalid-output' | 'too-large' }
  | { job: 'recovery-required' };

const FAULTS: Array<{ name: string; behavior: ProviderBehavior; expected: Expected }> = [
  { name: 'success', behavior: { kind: 'success' }, expected: { job: 'complete' } },
  { name: '429 rate limit', behavior: { kind: 'status', status: 429 }, expected: { job: 'failed', failureKind: 'provider' } },
  { name: '400 configuration rejection', behavior: { kind: 'status', status: 400 }, expected: { job: 'failed', failureKind: 'provider' } },
  { name: '500 server error', behavior: { kind: 'status', status: 500 }, expected: { job: 'recovery-required' } },
  { name: '503 unavailable', behavior: { kind: 'status', status: 503 }, expected: { job: 'recovery-required' } },
  { name: 'deadline timeout', behavior: { kind: 'hang' }, expected: { job: 'recovery-required' } },
  { name: 'transport abort', behavior: { kind: 'abort' }, expected: { job: 'recovery-required' } },
  { name: 'network TypeError', behavior: { kind: 'network' }, expected: { job: 'recovery-required' } },
  {
    name: 'invalid output',
    behavior: { kind: 'success', synthesis: { ...SYNTHESIS, bottomLine: '' } },
    expected: { job: 'failed', failureKind: 'invalid-output' },
  },
  {
    name: 'oversized output',
    behavior: { kind: 'success', synthesis: { ...SYNTHESIS, keyInsights: Array.from({ length: 14 }, () => 'y'.repeat(19_999)) } },
    expected: { job: 'failed', failureKind: 'too-large' },
  },
];

beforeEach(async () => {
  await resetWorkspace();
  captureQueue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(PROVIDERS)('JOB-09 queued synthesis through the %s adapter', (provider) => {
  it.each(FAULTS)('JOB-09 $name makes exactly one outbound request and settles per the classification table', async ({ behavior, expected }) => {
    const job = await seedJob({ provider });
    const fixture = installProviderFixture(behavior);
    const result = await deliver([job.message], { synthesisDeadlineMs: TEST_DEADLINE_MS });
    fixture.release();

    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].provider).toBe(provider);

    const row = await jobRow(job.jobId);
    const analysis = await analysisRow(job.interviewId);
    expect(analysis?.attempts).toBe(1);
    if (expected.job === 'complete') {
      expect(row.state).toBe('complete');
      expect(analysis).toMatchObject({ status: 'complete', study_revision: 1 });
      expect(JSON.parse(analysis?.provenance_json ?? 'null')).toMatchObject({
        aiProvider: provider,
        aiModel: PROVIDER_MODELS[provider].served,
        requestedAiModel: PROVIDER_MODELS[provider].requested,
        ...(provider === 'openrouter' ? { routedProvider: 'OpenAI' } : {}),
      });
    } else if (expected.job === 'failed') {
      expect(row).toMatchObject({ state: 'failed', failure_kind: expected.failureKind });
      expect(analysis).toMatchObject({ status: 'failed', failure_kind: expected.failureKind, recovery_required: 0 });
    } else {
      expect(row).toMatchObject({ state: 'recovery-required', failure_kind: 'timeout' });
      expect(await workspaceStub().readAnalysisStatus({ studyId: job.studyId, interviewId: job.interviewId }))
        .toEqual({ status: 'ok', body: { status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true } });
    }
  });
});

describe('JOB-09 provenance is mandatory', () => {
  it('JOB-09 records invalid-output when OpenRouter omits the upstream provider, with one request', async () => {
    const job = await seedJob({ provider: 'openrouter' });
    const fixture = installProviderFixture({ kind: 'success', routedProvider: null });
    await deliver([job.message]);
    expect(fixture.requests).toHaveLength(1);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'invalid-output' });
  });

  it('JOB-09 records invalid-output when a response omits its served model', async () => {
    const job = await seedJob({ provider: 'openai' });
    const fixture = installProviderFixture({ kind: 'success', servedModel: '' });
    await deliver([job.message]);
    expect(fixture.requests).toHaveLength(1);
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'invalid-output' });
  });
});

describe('JOB-09 control: the default policy keeps SDK retries for synchronous paths', () => {
  it.each([
    ['openai', () => new OpenAIProvider(PROVIDER_MODELS.openai.requested, 'sk-synthetic'), 3],
    ['claude', () => new ClaudeProvider(PROVIDER_MODELS.claude.requested, 'sk-ant-synthetic'), 3],
    ['gemini', () => new GeminiProvider(PROVIDER_MODELS.gemini.requested, 'synthetic-gemini'), 5],
    ['openrouter', () => new OpenRouterProvider(PROVIDER_MODELS.openrouter.requested, 'synthetic-openrouter'), 3],
  ] as const)('JOB-09 %s retries a 500 under the default policy but not under queued-synthesis', async (provider, make, defaultRequests) => {
    // OpenRouter's default backoff has no retry count, only a one-hour budget,
    // so its fixture recovers after two failures; the others exhaust maxRetries.
    const recovers = provider === 'openrouter';
    const fixture = installProviderFixture({ kind: 'status', status: 500, ...(recovers ? { failures: defaultRequests - 1 } : {}) });
    const config = studyConfig('study-control', provider);
    const defaultCall = make().synthesizeInterview(HISTORY, config, BEHAVIOR, null);
    if (recovers) await expect(defaultCall).resolves.toMatchObject({ execution: { provider } });
    else await expect(defaultCall).rejects.not.toBeInstanceOf(ProviderTimeoutError);
    expect(fixture.requests).toHaveLength(defaultRequests);
    // Every retry honoured retry-after-ms: all of them fit inside the queued
    // test deadline. OpenRouter's own second retry would wait at least 500 ms.
    expect(fixture.requests[defaultRequests - 1].at - fixture.requests[0].at).toBeLessThan(TEST_DEADLINE_MS);
    fixture.requests.length = 0;
    await expect(make().synthesizeInterview(HISTORY, config, BEHAVIOR, null, { kind: 'queued-synthesis', deadlineMs: 5_000 }))
      .rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
  }, 30_000);
});

describe('R2: an adapter and its SDK load only when a queued job executes', () => {
  const ADAPTER_MODULES = ['claude', 'openai', 'gemini', 'openrouter'].map((name) => `../../src/lib/providers/${name}`);

  afterEach(() => {
    for (const path of ADAPTER_MODULES) vi.doUnmock(path);
  });

  it('R2 evaluates no adapter when the execution module loads; a failed load is a known provider failure without a request', async () => {
    for (const path of ADAPTER_MODULES) {
      vi.doMock(path, () => {
        throw new Error(`synthetic: ${path} evaluated`);
      });
    }
    // A distinct module id evaluates a fresh copy, so the mocks above reach
    // every import it makes: a static adapter import would reject here.
    const fresh = '../../cloudflare/analysis/execute?r2';
    const execute = await import(/* @vite-ignore */ fresh) as typeof import('../../cloudflare/analysis/execute');
    const fixture = installProviderFixture({ kind: 'success' });
    const provider = execute.createQueuedSynthesisProvider(
      'openrouter',
      PROVIDER_MODELS.openrouter.requested,
      'synthetic-openrouter',
      providerEndpoint('openrouter', { transport: 'direct' }),
    );
    const failure = await provider
      .synthesizeInterview(HISTORY, studyConfig('study-r2', 'openrouter'), BEHAVIOR, null, { kind: 'queued-synthesis', deadlineMs: TEST_DEADLINE_MS })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(execute.AdapterLoadError);
    expect(execute.classifyProviderException(failure))
      .toEqual({ outcome: { kind: 'failed', failureKind: 'provider' }, reason: 'provider-failure' });
    expect(fixture.requests).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
});
