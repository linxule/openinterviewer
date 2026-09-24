// Synthetic fixtures for durable analysis job tests (package D). Rows are
// seeded directly with SQL inside the real WorkspaceStore, exactly as the
// completion transaction leaves them, so these tests never depend on the
// completion implementation. Provider HTTP is intercepted at globalThis.fetch;
// any other outbound request fails the test instead of leaving the process.

import { expect, vi } from 'vitest';
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from 'cloudflare:test';
import type { AIProviderType, StudyConfig, SynthesisResult } from '../../src/types';
import {
  ANALYSIS_INPUT_SCHEMA_VERSION,
  type AnalysisMessageV1,
  type FrozenAnalysisInput,
} from '../../src/lib/storage/analysisProtocol';
import { allocateGeneration, armAlarmNoLaterThan, type WorkspaceContext } from '../../cloudflare/workspace/context';
import { CONSUMER_CONTACT_KEY } from '../../cloudflare/workspace/analysis';
import { handleAnalysisBatch, type ConsumerEnv, type ConsumerOptions } from '../../cloudflare/analysis/consumer';
import { testEnv, workspaceStub } from './helpers';

export const HOUR_MS = 60 * 60 * 1000;
/** Participant speech marker: must never appear in logs, envelopes or job rows. */
export const TRANSCRIPT_MARKER = 'synthetic-participant-speech-7f3a';

export const PROVIDER_MODELS: Readonly<Record<AIProviderType, { requested: string; served: string }>> = {
  openai: { requested: 'gpt-5.6-terra', served: 'gpt-5.6-terra-2026-09-01' },
  claude: { requested: 'claude-sonnet-5', served: 'claude-sonnet-5-20260901' },
  gemini: { requested: 'gemini-3.7-flash', served: 'gemini-3.7-flash-001' },
  openrouter: { requested: 'openai/gpt-5.6-terra', served: 'openai/gpt-5.6-terra-2026-09-01' },
};

export const PROVIDER_HOSTS: Readonly<Record<AIProviderType, string>> = {
  openai: 'api.openai.com',
  claude: 'api.anthropic.com',
  gemini: 'generativelanguage.googleapis.com',
  openrouter: 'openrouter.ai',
};

export const SYNTHESIS: SynthesisResult = {
  statedPreferences: ['Clear onboarding'],
  revealedPreferences: ['Prefers written guidance'],
  themes: [{ theme: 'Onboarding friction', frequency: 2, evidenceRefs: [{ quote: 'the first week', turnIndex: 2 }] }],
  contradictions: [],
  keyInsights: ['Documentation matters more than meetings'],
  bottomLine: 'Written onboarding reduces friction.',
};

let sequence = 0;
function uniqueId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

export function workspaceContext(state: DurableObjectState): WorkspaceContext {
  return {
    sql: state.storage.sql,
    storage: state.storage,
    env: testEnv as unknown as WorkspaceContext['env'],
    objectName: testEnv.WORKSPACE_ID,
  };
}

export function studyConfig(studyId: string, provider: AIProviderType, overrides: Partial<StudyConfig> = {}): StudyConfig {
  return {
    id: studyId,
    name: 'Synthetic onboarding study',
    description: 'Synthetic fixture',
    researchQuestion: 'How do new staff experience onboarding?',
    coreQuestions: ['What was your first week like?'],
    topicAreas: ['onboarding'],
    profileSchema: [],
    aiBehavior: 'standard',
    aiProvider: provider,
    aiModel: PROVIDER_MODELS[provider].requested,
    consentText: 'Synthetic consent text.',
    createdAt: 1_790_000_000_000,
    ...overrides,
  };
}

export function frozenInput(
  config: StudyConfig,
  studyRevision: number,
  disclosedTransport?: 'cloudflare-gateway',
): FrozenAnalysisInput {
  return {
    inputSchemaVersion: ANALYSIS_INPUT_SCHEMA_VERSION,
    studyConfig: config,
    studyRevision,
    requestedProvider: config.aiProvider as AIProviderType,
    requestedModel: config.aiModel as string,
    ...(disclosedTransport ? { disclosedTransport } : {}),
  };
}

/** The Worker env of an installation routed through Cloudflare AI Gateway (RT-11). */
export const GATEWAY_ENV = {
  AI_TRANSPORT: 'cloudflare-gateway',
  CF_AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CF_AI_GATEWAY_ID: 'oi-workers-test',
  CF_AI_GATEWAY_TOKEN: 'synthetic-ai-gateway-run-token-0123456789',
} as const;

export const GATEWAY_BASE = `https://gateway.ai.cloudflare.com/v1/${GATEWAY_ENV.CF_AI_GATEWAY_ACCOUNT_ID}/${GATEWAY_ENV.CF_AI_GATEWAY_ID}`;

/** Delete every row these tests touch, the alarm and recorded consumer contact; restore an open, activated workspace. */
export async function resetWorkspace(): Promise<void> {
  const stub = workspaceStub();
  await stub.readiness();
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    for (const table of [
      'studies', 'interviews', 'analysis', 'analysis_jobs', 'idempotency_receipts', 'deletion_fences',
      'consents', 'participant_links', 'budget_windows', 'budget_members', 'aggregates',
    ]) {
      sql.exec(`DELETE FROM ${table}`);
    }
    sql.exec(
      `UPDATE workspace_meta SET maintenance_state = 'open', activated_epoch = ? WHERE singleton = 1`,
      testEnv.ANALYSIS_RECOVERY_EPOCH,
    );
    state.storage.kv.delete(CONSUMER_CONTACT_KEY);
    await state.storage.deleteAlarm();
  });
}

export type SeededInterview = {
  studyId: string;
  interviewId: string;
  provider: AIProviderType;
  config: StudyConfig;
};

export type SeededJob = SeededInterview & { jobId: string; generation: number; message: AnalysisMessageV1 };

export type SeedOptions = {
  provider?: AIProviderType;
  /** The transport the participant was shown at consent (absent = direct). */
  disclosedTransport?: 'cloudflare-gateway';
  /** Interview record overrides (for example a legacy `synthesis` or `analysis`). */
  record?: Record<string, unknown>;
  studyRevision?: number;
};

/** A study and an immutable interview with no analysis row (a legacy or imported record). */
export async function seedInterview(options: SeedOptions = {}): Promise<SeededInterview> {
  const provider = options.provider ?? 'openai';
  const studyId = uniqueId('study');
  const interviewId = uniqueId('interview');
  const config = studyConfig(studyId, provider);
  const revision = options.studyRevision ?? 1;
  const now = Date.now();
  const record = {
    id: interviewId,
    studyId,
    studyName: config.name,
    participantProfile: { id: 'profile-1', fields: [], rawContext: 'Synthetic context', timestamp: now },
    transcript: [
      { id: 'm1', role: 'ai', content: 'What was your first week like?', timestamp: now - 2000 },
      { id: 'm2', role: 'user', content: `The first week was confusing. ${TRANSCRIPT_MARKER}`, timestamp: now - 1000 },
    ],
    synthesis: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: ['onboarding'], contradictions: [] },
    createdAt: now - 60_000,
    completedAt: now,
    status: 'completed',
    studyRevision: revision,
    ...(options.disclosedTransport ? { consentTransport: options.disclosedTransport } : {}),
    ...options.record,
  };
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `INSERT INTO studies (id, config_json, revision, created_at, updated_at, interview_count, is_locked)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      studyId,
      JSON.stringify(config),
      revision,
      now,
      now,
    );
    sql.exec(
      `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      interviewId,
      studyId,
      JSON.stringify(record),
      `fp-${interviewId}`,
      record.createdAt,
      record.completedAt,
    );
  });
  return { studyId, interviewId, provider, config };
}

/**
 * The state completion leaves behind: interview, analysis row, pending
 * generation 1 and a committed alarm. The alarm defaults to an hour ahead so
 * tests decide when it runs (runDurableObjectAlarm) instead of racing it.
 */
export async function seedJob(options: SeedOptions & { alarmAt?: number } = {}): Promise<SeededJob> {
  const seeded = await seedInterview(options);
  const jobId = crypto.randomUUID();
  const revision = options.studyRevision ?? 1;
  await runInDurableObject(workspaceStub(), async (_instance, state) => {
    const ws = workspaceContext(state);
    const now = Date.now();
    await state.storage.transaction(async () => {
      ws.sql.exec(
        `INSERT INTO analysis (interview_id, status, current_generation, attempts, last_attempt_at, recovery_required, updated_at)
         VALUES (?, 'pending', 0, 0, ?, 0, ?)`,
        seeded.interviewId,
        now,
        now,
      );
      allocateGeneration(ws, {
        interviewId: seeded.interviewId,
        generation: 1,
        jobId,
        recoveryEpoch: testEnv.ANALYSIS_RECOVERY_EPOCH,
        frozen: frozenInput(seeded.config, revision, options.disclosedTransport),
        now,
      });
      await armAlarmNoLaterThan(state.storage, options.alarmAt ?? now + HOUR_MS);
    });
  });
  return {
    ...seeded,
    jobId,
    generation: 1,
    message: {
      v: 1,
      workspaceId: testEnv.WORKSPACE_ID,
      interviewId: seeded.interviewId,
      jobId,
      generation: 1,
      recoveryEpoch: testEnv.ANALYSIS_RECOVERY_EPOCH,
    },
  };
}

export function fenceOf(job: SeededJob) {
  return {
    workspaceId: job.message.workspaceId,
    interviewId: job.interviewId,
    jobId: job.jobId,
    generation: job.generation,
    recoveryEpoch: job.message.recoveryEpoch,
  };
}

// ---------- Direct SQL access ----------

export async function sqlRows<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<T>(query, ...bindings).toArray());
}

export async function sqlRun(query: string, ...bindings: unknown[]): Promise<void> {
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    state.storage.sql.exec(query, ...bindings);
  });
}

export type JobSnapshot = {
  job_id: string;
  generation: number;
  state: string;
  dispatch_state: string;
  dispatch_attempts: number;
  next_due_at: number | null;
  claim_nonce: string | null;
  claim_expires_at: number | null;
  started_at: number | null;
  failure_kind: string | null;
  input_json: string;
};

export async function jobRow(jobId: string): Promise<JobSnapshot> {
  const rows = await sqlRows<JobSnapshot>(
    `SELECT job_id, generation, state, dispatch_state, dispatch_attempts, next_due_at, claim_nonce,
            claim_expires_at, started_at, failure_kind, input_json
       FROM analysis_jobs WHERE job_id = ?`,
    jobId,
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

export type AnalysisSnapshot = {
  status: string;
  current_generation: number;
  attempts: number;
  failure_kind: string | null;
  recovery_required: number;
  study_revision: number | null;
  synthesis_json: string | null;
  provenance_json: string | null;
};

export async function analysisRow(interviewId: string): Promise<AnalysisSnapshot | null> {
  const rows = await sqlRows<AnalysisSnapshot>(
    `SELECT status, current_generation, attempts, failure_kind, recovery_required, study_revision,
            synthesis_json, provenance_json
       FROM analysis WHERE interview_id = ?`,
    interviewId,
  );
  return rows[0] ?? null;
}

export async function mutationSeq(): Promise<number> {
  const rows = await sqlRows<{ mutation_seq: number }>(`SELECT mutation_seq FROM workspace_meta`);
  return rows[0].mutation_seq;
}

export async function currentAlarm(): Promise<number | null> {
  return runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm());
}

/** Edit the stored study configuration and advance its revision (a researcher edit). */
export async function editStudy(studyId: string, patch: Partial<StudyConfig>): Promise<void> {
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    const sql = state.storage.sql;
    const row = sql.exec<{ config_json: string }>(`SELECT config_json FROM studies WHERE id = ?`, studyId).one();
    const next = { ...(JSON.parse(row.config_json) as StudyConfig), ...patch };
    sql.exec(
      `UPDATE studies SET config_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      JSON.stringify(next),
      Date.now(),
      studyId,
    );
  });
}

/** What package C's deletion leaves: a fence, no interview/analysis rows, and cancelled jobs. */
export async function deleteInterviewLikeStudyDeletion(seeded: SeededInterview): Promise<void> {
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    const sql = state.storage.sql;
    const now = Date.now();
    state.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO deletion_fences (kind, target_id, deleted_at, expires_at) VALUES ('interview', ?, ?, ?)`,
        seeded.interviewId,
        now,
        now + 30 * 24 * HOUR_MS,
      );
      sql.exec(
        `UPDATE analysis_jobs SET state = 'cancelled', next_due_at = NULL, terminal_at = ?, updated_at = ?
          WHERE interview_id = ? AND state IN ('pending','claimed','started')`,
        now,
        now,
        seeded.interviewId,
      );
      sql.exec(`DELETE FROM analysis WHERE interview_id = ?`, seeded.interviewId);
      sql.exec(`DELETE FROM interviews WHERE id = ?`, seeded.interviewId);
    });
  });
}

// ---------- Queue ----------

export type QueueCapture = { messages: unknown[]; fail: boolean };

export const SEND_RESPONSE: QueueSendResponse = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };

/** Intercept the producer binding the object uses (the same binding object as testEnv). */
export function captureQueue(): QueueCapture {
  const capture: QueueCapture = { messages: [], fail: false };
  vi.spyOn(testEnv.ANALYSIS_QUEUE, 'send').mockImplementation(async (body: unknown) => {
    if (capture.fail) throw new Error('synthetic queue send failure');
    capture.messages.push(structuredClone(body));
    return SEND_RESPONSE;
  });
  return capture;
}

export type BatchResult = Awaited<ReturnType<typeof getQueueResult>> & {
  /** Options passed to each message.retry() call, in order. */
  retryOptions: Array<QueueRetryOptions | undefined>;
};

/** Deliver messages to the real consumer as one batch; returns explicit acks/retries. */
export async function deliver(
  bodies: unknown[],
  options: ConsumerOptions & { env?: Partial<ConsumerEnv> } = {},
): Promise<BatchResult> {
  const batch = createMessageBatch(
    'oi-test-analysis',
    bodies.map((body, index) => ({ id: `msg-${index}-${uniqueId('m')}`, timestamp: new Date(), attempts: 1, body })),
  );
  const retryOptions: Array<QueueRetryOptions | undefined> = [];
  for (const message of batch.messages) {
    const retry = message.retry.bind(message);
    Object.defineProperty(message, 'retry', {
      configurable: true,
      value: (retryOption?: QueueRetryOptions) => {
        retryOptions.push(retryOption);
        retry(retryOption);
      },
    });
  }
  const ctx = createExecutionContext();
  const env = { ...(testEnv as unknown as ConsumerEnv), ...options.env } as ConsumerEnv;
  await handleAnalysisBatch(batch, env, ctx, options);
  return { ...(await getQueueResult(batch, ctx)), retryOptions };
}

// ---------- Provider HTTP fixtures ----------

export type ProviderBehavior =
  | { kind: 'success'; synthesis?: unknown; servedModel?: string; routedProvider?: string | null }
  /** `failures` bounds the error responses; later requests succeed. Unbounded when absent. */
  | { kind: 'status'; status: number; failures?: number; body?: unknown }
  | { kind: 'network' }
  | { kind: 'hang' }
  | { kind: 'abort' };

export type ProviderRequest = {
  provider: AIProviderType;
  url: string;
  body: unknown;
  at: number;
  /** Lower-case request header names and values. */
  headers: Record<string, string>;
};

/**
 * Sent with every error status. Every locked SDK honours `retry-after-ms`
 * ahead of its own backoff (Stainless `retryRequest` in openai and
 * @anthropic-ai/sdk; Speakeasy `retryIntervalFromResponse` in @openrouter/sdk
 * and the @google/genai Interactions client), so an enabled SDK retry lands
 * 1 ms later, well inside the 300 ms queued test deadline, instead of after a
 * randomized backoff (OpenRouter's first one falls anywhere in 0–1000 ms).
 */
export const RETRY_AFTER_MS = '1';

export type ProviderFixture = {
  requests: ProviderRequest[];
  unexpected: string[];
  /** Resolve a pending `hang` request as the provider eventually would. */
  release: () => void;
};

const GATEWAY_SLUGS: Readonly<Record<string, AIProviderType>> = {
  'google-ai-studio': 'gemini',
  anthropic: 'claude',
  openai: 'openai',
  openrouter: 'openrouter',
};

/** A direct provider host, or the fixture installation's own gateway path (RT-11). */
function providerFor(url: URL): AIProviderType | null {
  for (const [provider, host] of Object.entries(PROVIDER_HOSTS) as Array<[AIProviderType, string]>) {
    if (url.host === host) return provider;
  }
  if (url.origin === 'https://gateway.ai.cloudflare.com') {
    const [, version, account, gateway, slug] = url.pathname.split('/');
    if (version === 'v1' && account === GATEWAY_ENV.CF_AI_GATEWAY_ACCOUNT_ID && gateway === GATEWAY_ENV.CF_AI_GATEWAY_ID) {
      return GATEWAY_SLUGS[slug] ?? null;
    }
  }
  return null;
}

function successBody(provider: AIProviderType, requestedModel: string, behavior: Extract<ProviderBehavior, { kind: 'success' }>): unknown {
  const text = JSON.stringify(behavior.synthesis ?? SYNTHESIS);
  const served = behavior.servedModel ?? PROVIDER_MODELS[provider].served;
  switch (provider) {
    case 'openai':
      return {
        id: 'resp_synthetic', object: 'response', created_at: 1, status: 'completed', model: served,
        output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      };
    case 'claude':
      return {
        id: 'msg_synthetic', type: 'message', role: 'assistant', model: served,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    case 'gemini':
      return {
        id: 'interaction_synthetic', model: served, status: 'completed', role: 'model',
        created: '2026-09-23T00:00:00Z', updated: '2026-09-23T00:00:00Z',
        steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
      };
    case 'openrouter':
      return {
        id: 'gen_synthetic', object: 'chat.completion', created: 1, model: served, system_fingerprint: null,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
        openrouter_metadata: {
          attempt: 1,
          attempts: behavior.routedProvider === null ? [] : [{ model: requestedModel, provider: behavior.routedProvider ?? 'OpenAI', status: 200 }],
          endpoints: { available: [], total: 0 },
          is_byok: false,
          region: null,
          requested: requestedModel,
          strategy: 'direct',
          summary: 'synthetic',
        },
      };
  }
}

/**
 * Count every outbound provider request and answer it per behavior. Requests
 * to any other origin are recorded as unexpected and rejected. Like fetch, a
 * request whose signal is already aborted is refused unsent, so a retry loop
 * cannot outlive the caller's deadline.
 */
export function installProviderFixture(behavior: ProviderBehavior): ProviderFixture {
  const fixture: ProviderFixture = { requests: [], unexpected: [], release: () => {} };
  const releases: Array<() => void> = [];
  fixture.release = () => releases.splice(0).forEach((release) => release());
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted) || request.signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    const url = new URL(request.url);
    const provider = providerFor(url);
    if (!provider) {
      fixture.unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
      throw new TypeError('outbound request blocked by test fixture');
    }
    const text = await request.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    fixture.requests.push({
      provider,
      url: `${url.origin}${url.pathname}`,
      body,
      at: Date.now(),
      headers: Object.fromEntries(request.headers.entries()),
    });
    const recovered = behavior.kind === 'status' && fixture.requests.length > (behavior.failures ?? Infinity);
    const answer: ProviderBehavior = recovered ? { kind: 'success' } : behavior;
    switch (answer.kind) {
      case 'success': {
        const requestedModel = (body as { model?: string; chatRequest?: { model?: string } } | null)?.model
          ?? PROVIDER_MODELS[provider].requested;
        return Response.json(successBody(provider, requestedModel, answer));
      }
      case 'status':
        return Response.json(
          answer.body ?? { error: { message: 'synthetic provider error', type: 'synthetic', code: answer.status } },
          { status: answer.status, headers: { 'retry-after': '0', 'retry-after-ms': RETRY_AFTER_MS } },
        );
      case 'network':
        throw new TypeError('synthetic network failure');
      case 'abort':
        throw new DOMException('The operation was aborted.', 'AbortError');
      case 'hang': {
        const signal = request.signal;
        return new Promise<Response>((resolve, reject) => {
          const abort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          if (signal.aborted) abort();
          signal.addEventListener('abort', abort);
          releases.push(() => resolve(Response.json(successBody(provider, PROVIDER_MODELS[provider].requested, { kind: 'success' }))));
        });
      }
    }
  });
  return fixture;
}

/** Only the synthesis calls (every provider request in these tests is one). */
export function synthesisRequests(fixture: ProviderFixture): ProviderRequest[] {
  return fixture.requests;
}

/** Read everything the code under test wrote to the console. */
export function captureConsole(): { text: () => string } {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
  return { text: () => lines.join('\n') };
}
