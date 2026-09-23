// Researcher paid routes and collection routes against the real WorkspaceStore
// object (gap F26, OPS-01, ST-08, RT-09). Every RPC crosses the real durable
// client into the production object on local SQLite. Only the provider
// factory and the researcher's cookie store are doubles; no provider request
// is ever made. A forwarding namespace lets a test change the workspace state
// between the route's readiness check and its input read, the window the
// object's own purpose fence exists for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset } from 'cloudflare:test';

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  })),
}));

// Page-only redirects (researcherAccess.ts); the React client bundle behind
// next/navigation does not load outside Next.
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

const providerFactory = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/providers')>(),
  getInterviewProvider: providerFactory,
}));

import { POST as aggregatePOST } from '../../src/app/api/synthesis/aggregate/route';
import { POST as followupPOST } from '../../src/app/api/studies/[id]/generate-followup/route';
import { GET as interviewsGET } from '../../src/app/api/interviews/route';
import { GET as studiesGET } from '../../src/app/api/studies/route';
import { createSessionToken, SESSION_COOKIE_NAME } from '../../src/lib/auth';
import { forEachEligibleAggregateInput, loadDurableAggregateInputs } from '../../src/lib/ownedStudies';
import { createDurableWorkspaceStore, MAX_LIST_INTERVIEWS_BYTES } from '../../src/lib/storage/durableObject';
import { WORKER_INVOCATION_ACCESSOR, WORKER_RUNTIME_MARKER, type WorkerInvocation } from '../../src/lib/runtime/workerInvocation';
import type { StoredInterview, StoredStudy } from '../../src/types';
import { createStudy, DAY, sampleInterview, setMaintenance, sha256Hex, sql, studyConfig, T0, testEnv } from './fixtures';

const ADMIN_PASSWORD = 'synthetic-admin-password-0123456789';
const ORIGIN = String(testEnv.APP_BASE_URL);
const SALT = testEnv.RATE_LIMIT_SALT as string;

const runtime = globalThis as unknown as Record<symbol, unknown>;

const provider = {
  synthesizeAggregate: vi.fn(),
  generateFollowupStudy: vi.fn(async () => ({
    value: { name: 'Synthetic follow-up', researchQuestion: 'What else is synthetic?', coreQuestions: ['Why synthetic?'] },
    execution: { provider: 'openai', requestedModel: 'gpt-5.6-terra', model: 'gpt-5.6-terra-2031-01-01' },
  })),
};

type RpcCall = { method: string; input: unknown };

/**
 * Forwards every RPC to the real object selected by name, recording it; a
 * hook may run first (for example a maintenance transition) for one method.
 */
function forwardingNamespace(hooks: Partial<Record<string, (input: unknown) => Promise<void>>> = {}) {
  const calls: RpcCall[] = [];
  const namespace = {
    // Readiness checks the binding's shape (hostedConfig.ts).
    idFromName: (name: string) => testEnv.WORKSPACE_STORE.idFromName(name),
    getByName(name: string) {
      const real = testEnv.WORKSPACE_STORE.getByName(name) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
      return new Proxy({}, {
        get(_target, method: string) {
          return async (input?: unknown) => {
            calls.push({ method, input });
            await hooks[method]?.(input);
            return input === undefined ? real[method]() : real[method](input);
          };
        },
      });
    },
  };
  return { namespace, calls };
}

function useInvocation(namespace: unknown): void {
  const invocation: WorkerInvocation = {
    env: { ...testEnv, ADMIN_PASSWORD, WORKSPACE_STORE: namespace },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtime[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

beforeEach(async () => {
  await reset();
  cookieJar.clear();
  vi.stubEnv('ADMIN_PASSWORD', ADMIN_PASSWORD);
  runtime[WORKER_RUNTIME_MARKER] = true;
  useInvocation(testEnv.WORKSPACE_STORE);
  providerFactory.mockReturnValue(provider);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete runtime[WORKER_INVOCATION_ACCESSOR];
  delete runtime[WORKER_RUNTIME_MARKER];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  providerFactory.mockReset();
  provider.synthesizeAggregate.mockReset();
  provider.generateFollowupStudy.mockClear();
});

async function researcherRequest(url: string, method: string, body?: unknown): Promise<Request> {
  const token = await createSessionToken();
  cookieJar.set(SESSION_COOKIE_NAME, token);
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A legacy synthesized record at the study's revision: an eligible aggregate input. */
async function insertAnalyzed(studyId: string, id: string, createdAt: number, transcriptBytes = 0): Promise<StoredInterview> {
  const base = sampleInterview(studyId, id, createdAt);
  const record: StoredInterview = transcriptBytes > 0
    ? { ...base, transcript: [{ id: 'm1', role: 'user', content: 'x'.repeat(transcriptBytes), timestamp: createdAt }] }
    : base;
  await sql(
    `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at, sample_fixture, study_revision)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
    id,
    studyId,
    JSON.stringify(record),
    await sha256Hex(id),
    createdAt,
    createdAt + 1,
  );
  return record;
}

async function saveStoredAggregate(study: StoredStudy, interviewIds: string[]): Promise<void> {
  const saved = await testEnv.WORKSPACE_STORE.getByName(testEnv.WORKSPACE_ID).saveAggregate({
    aggregate: {
      studyId: study.id,
      studyRevision: study.revision,
      interviewIds,
      interviewCount: interviewIds.length,
      aiProvider: 'openai',
      aiModel: 'gpt-5.6-terra-2031-01-01',
      requestedAiModel: 'gpt-5.6-terra',
      commonThemes: [{ theme: 'Synthetic theme', frequency: 2, representativeQuotes: ['Synthetic'] }],
      divergentViews: [],
      keyFindings: ['Synthetic finding'],
      researchImplications: ['Synthetic implication'],
      bottomLine: 'Synthetic aggregate.',
      generatedAt: T0,
      savedAt: T0,
    },
    now: T0,
  });
  expect(saved).toBe('saved');
}

function realStore(namespace: unknown = testEnv.WORKSPACE_STORE) {
  return createDurableWorkspaceStore({ namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
}

describe('aggregate and follow-up inputs carry their route purpose to the object (F26, OPS-01)', () => {
  it('F26: the aggregate helper is refused while draining and the follow-up helper is served', async () => {
    const study = await createStudy();
    await insertAnalyzed(study.id, 'session-a', T0 - 1);
    await insertAnalyzed(study.id, 'session-b', T0 - 2);
    const { namespace, calls } = forwardingNamespace();
    const store = realStore(namespace);

    expect(await loadDurableAggregateInputs(store, study)).toMatchObject({ status: 'ok' });

    await setMaintenance('draining');
    expect(await loadDurableAggregateInputs(store, study)).toEqual({ status: 'unavailable' });
    const seen: string[] = [];
    const pass = await forEachEligibleAggregateInput(store, study, (page) => {
      seen.push(...page.map((interview) => interview.id));
      return true;
    }, 'follow-up');
    expect(pass).toBe('done');
    expect(seen).toEqual(['session-a', 'session-b']);

    expect(calls.map(({ input }) => (input as { purpose?: unknown }).purpose)).toEqual(['aggregate', 'aggregate', 'follow-up']);
  });

  it('F26/OPS-01: aggregate synthesis is refused before any provider call when draining begins after its readiness check', async () => {
    const study = await createStudy();
    await insertAnalyzed(study.id, 'session-a', T0 - 1);
    await insertAnalyzed(study.id, 'session-b', T0 - 2);
    const { namespace, calls } = forwardingNamespace({
      readAggregateInputs: () => setMaintenance('draining'),
    });
    useInvocation(namespace);

    const response = await aggregatePOST(await researcherRequest(`${ORIGIN}/api/synthesis/aggregate`, 'POST', { studyId: study.id }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true });
    const methods = calls.map(({ method }) => method);
    expect(methods).toContain('readiness');
    expect(methods).not.toContain('saveAggregate');
    const inputs = calls.filter(({ method }) => method === 'readAggregateInputs');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].input).toMatchObject({ studyId: study.id, studyRevision: 1, purpose: 'aggregate' });
    expect(providerFactory).not.toHaveBeenCalled();
    expect(provider.synthesizeAggregate).not.toHaveBeenCalled();
  });

  it('F26: aggregate synthesis while draining throughout is refused by readiness before any input read', async () => {
    const study = await createStudy();
    await setMaintenance('draining');
    const { namespace, calls } = forwardingNamespace();
    useInvocation(namespace);

    const response = await aggregatePOST(await researcherRequest(`${ORIGIN}/api/synthesis/aggregate`, 'POST', { studyId: study.id }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'maintenance' });
    expect(calls.map(({ method }) => method)).not.toContain('readAggregateInputs');
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('F26: follow-up generation is served while draining, reading its inputs with the follow-up purpose', async () => {
    const study = await createStudy();
    await insertAnalyzed(study.id, 'session-a', T0 - 1);
    await insertAnalyzed(study.id, 'session-b', T0 - 2);
    await saveStoredAggregate(study, ['session-a', 'session-b']);
    await setMaintenance('draining');
    const { namespace, calls } = forwardingNamespace();
    useInvocation(namespace);

    const response = await followupPOST(
      await researcherRequest(`${ORIGIN}/api/studies/${study.id}/generate-followup`, 'POST', {}),
      { params: Promise.resolve({ id: study.id }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ followUpConfig: { parentStudyId: study.id } });
    const inputs = calls.filter(({ method }) => method === 'readAggregateInputs');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    for (const { input } of inputs) expect(input).toMatchObject({ purpose: 'follow-up' });
    expect(provider.generateFollowupStudy).toHaveBeenCalledTimes(1);
  });

  it('F26: follow-up generation is refused before the provider when frozen begins after its readiness check', async () => {
    const study = await createStudy();
    await insertAnalyzed(study.id, 'session-a', T0 - 1);
    await insertAnalyzed(study.id, 'session-b', T0 - 2);
    await saveStoredAggregate(study, ['session-a', 'session-b']);
    const { namespace } = forwardingNamespace({
      readAggregateInputs: () => setMaintenance('frozen'),
    });
    useInvocation(namespace);

    const response = await followupPOST(
      await researcherRequest(`${ORIGIN}/api/studies/${study.id}/generate-followup`, 'POST', {}),
      { params: Promise.resolve({ id: study.id }) },
    );

    expect(response.status).toBe(503);
    expect(provider.generateFollowupStudy).not.toHaveBeenCalled();
  });
});

describe('interview lists past the Worker byte ceiling (ST-08)', () => {
  it('ST-08: /api/interviews and the study-scoped list answer 413 when the records exceed the ceiling, never a partial list', async () => {
    const study = await createStudy();
    // 34 records near the 512,000-byte save cap: about 17 MB, over the 16 MiB ceiling.
    const recordBytes = 500_000;
    const rows = Math.ceil(MAX_LIST_INTERVIEWS_BYTES / recordBytes) + 1;
    for (let index = 0; index < rows; index += 1) {
      await insertAnalyzed(study.id, `session-large-${String(index).padStart(3, '0')}`, T0 - DAY - index, recordBytes);
    }

    const scoped = await interviewsGET(await researcherRequest(`${ORIGIN}/api/interviews?studyId=${study.id}`, 'GET'));
    expect(scoped.status).toBe(413);
    expect(await scoped.json()).not.toHaveProperty('interviews');

    const all = await interviewsGET(await researcherRequest(`${ORIGIN}/api/interviews`, 'GET'));
    expect(all.status).toBe(413);
    expect(await all.json()).not.toHaveProperty('interviews');
  });
});

describe('study lists past one RPC response (ST-08)', () => {
  it('ST-08: /api/studies lists 300 maximum-size studies (over 32 MiB stored) as list items, never a 503 or a 413', async () => {
    await researcherRequest(`${ORIGIN}/api/studies`, 'GET');
    for (let index = 0; index < 300; index += 1) {
      const id = `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const config = studyConfig(id, {
        description: 'd'.repeat(10_000),
        consentText: 'c'.repeat(20_000),
        coreQuestions: Array.from({ length: 45 }, () => 'x'.repeat(2_000)),
      });
      await sql(
        `INSERT INTO studies (id, config_json, revision, created_at, updated_at, interview_count, is_locked, sample_fixture)
         VALUES (?, ?, 1, ?, ?, 0, 0, 0)`,
        id,
        JSON.stringify(config),
        T0 - index,
        T0 - index,
      );
    }

    const response = await studiesGET();
    expect(response.status).toBe(200);
    const body = await response.json() as { studies: Array<{ id: string; config: object; coreQuestionCount: number }> };
    expect(body.studies).toHaveLength(300);
    expect(body.studies[0]).toMatchObject({ id: 'b0000000-0000-4000-8000-000000000000', coreQuestionCount: 45 });
    expect(Object.keys(body.studies[0].config).sort()).toEqual(['description', 'name']);
  });
});
