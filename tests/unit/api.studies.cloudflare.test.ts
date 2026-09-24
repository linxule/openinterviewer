// @vitest-environment node
//
// Cloudflare-target branches of the researcher study surfaces (ST-01, ST-07,
// ST-08, RT-09, OPS-01): every route talks to a fake durable workspace store
// through the request context. The context's kvClient is the real Cloudflare
// fence, so any Redis call fails the request. A fake Worker invocation carries
// bindings and the installation's provider; the real deployment readiness
// gate runs first on every mutating or provider-calling route.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { toStudyListItem, type StoredAggregateSynthesis, type StoredInterview, type StoredStudy } from '@/types';

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getAuthorizedResearcherStudyContext: vi.fn(),
  getHostedResearcherIdentity: vi.fn(),
  providerKeysFromContext: vi.fn((context: Record<string, unknown>) => ({
    geminiApiKey: context.geminiApiKey,
    anthropicApiKey: context.anthropicApiKey,
    openaiApiKey: context.openaiApiKey,
    openrouterApiKey: context.openrouterApiKey,
  })),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const synthesizeAggregate = vi.hoisted(() => vi.fn());
const generateFollowupStudy = vi.hoisted(() => vi.fn());
const getInterviewProvider = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers')>()),
  getInterviewProvider,
}));

const provenanceMock = vi.hoisted(() => ({
  aggregateProvenance: vi.fn(() => ({
    aiProvider: 'openai',
    aiModel: 'gpt-5.6-terra-served',
    requestedAiModel: 'gpt-5.6-terra',
  })),
}));
vi.mock('@/lib/synthesisProvenance', () => provenanceMock);

import { GET as listStudies, POST as createStudy } from '@/app/api/studies/route';
import { DELETE as deleteStudy, GET as getStudy, PUT as updateStudy } from '@/app/api/studies/[id]/route';
import { GET as getAggregate } from '@/app/api/studies/[id]/aggregate/route';
import { POST as generateFollowup } from '@/app/api/studies/[id]/generate-followup/route';
import { POST as synthesizeAggregateRoute } from '@/app/api/synthesis/aggregate/route';
import { DELETE as clearSample, POST as seedSample } from '@/app/api/demo/seed/route';
import { createFencedRedisPort } from '@/lib/kvClient';
import { createFingerprint, hashCreateIdempotencyKey } from '@/lib/createIdempotency';
import {
  AGGREGATE_INPUT_PAGE_BYTES,
  MAX_AGGREGATE_INPUT_BYTES,
} from '@/lib/ownedStudies';
import { DEMO_INTERVIEWS, DEMO_STUDIES } from '@/lib/demoData';
import {
  WORKER_INVOCATION_ACCESSOR,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';
import type { StoreReadiness } from '@/lib/storage/types';

const CLOUDFLARE_ENV: Record<string, string> = {
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  AI_PROVIDER: 'openai',
  APP_BASE_URL: 'https://openinterviewer.example.workers.dev',
  ADMIN_PASSWORD: 'synthetic-admin-password-1',
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
  RATE_LIMIT_SALT: 'synthetic-rate-limit-salt-0123456789abcdef',
  OPERATOR_TOKEN: 'synthetic-operator-token-0123456789abcdefg',
  OPENAI_API_KEY: 'synthetic-openai-provider-key',
  WORKSPACE_ID: 'ws_0123456789abcdef0123456789abcdef',
  WORKSPACE_JURISDICTION: '',
  ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
};

const BINDINGS = {
  WORKSPACE_STORE: { idFromName: () => ({}), getByName: () => ({}) },
  ANALYSIS_QUEUE: { send: async () => undefined },
};

const STORE_METHODS = [
  'readiness', 'getStudy', 'listStudies', 'createStudy', 'replaceStudyConfig', 'setStudyLinksEnabled',
  'deleteStudy', 'createParticipantLink', 'resolveParticipantLinkByCode', 'getParticipantLinkById',
  'listParticipantLinks', 'revokeParticipantLink', 'recordConsent', 'verifyConsent', 'admitParticipantRequest',
  'persistCompletedInterview', 'getInterview', 'listInterviews', 'getAggregate', 'saveAggregate',
  'seedSampleWorkspace', 'clearSampleWorkspace', 'acceptAnalysisRetry', 'readAnalysisStatus', 'beginExport',
  'readExportPage', 'verifyExportSequence', 'readAggregateInputs',
] as const;
type StoreMethod = (typeof STORE_METHODS)[number];
type FakeStore = { backend: 'durable-object' } & Record<StoreMethod, Mock>;

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let store: FakeStore;

function fakeDurableStore(): FakeStore {
  const fake = { backend: 'durable-object' } as FakeStore;
  for (const method of STORE_METHODS) {
    fake[method] = vi.fn(async () => {
      throw new Error(`unexpected store call: ${method}`);
    });
  }
  return fake;
}

function installInvocation(env: Record<string, unknown>): void {
  const invocation: WorkerInvocation = {
    env,
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

function setCloudflareEnv(overrides: Record<string, string> = {}, bindings: Record<string, unknown> = BINDINGS): void {
  const env = { ...CLOUDFLARE_ENV, ...overrides };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  installInvocation({ ...env, ...bindings });
}

function cloudflareContext(keys: Partial<Record<'geminiApiKey' | 'anthropicApiKey' | 'openaiApiKey' | 'openrouterApiKey', string | null>> = {}) {
  return {
    researcherId: null,
    kvClient: createFencedRedisPort(),
    store,
    geminiApiKey: null,
    anthropicApiKey: null,
    openaiApiKey: CLOUDFLARE_ENV.OPENAI_API_KEY,
    openrouterApiKey: null,
    onboardingComplete: true,
    ...keys,
  };
}

function authorize(context = cloudflareContext()): void {
  const access = { authorized: true, context };
  contextMock.getRequestContext.mockResolvedValue(access);
  contextMock.getAuthorizedResearcherStudyContext.mockResolvedValue(access);
}

const ready = (maintenance: 'open' | 'draining' | 'frozen' | 'recovery' = 'open'): StoreReadiness =>
  ({ status: 'ready', maintenance });

function jsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const synthesis = {
  statedPreferences: ['Clear ownership'],
  revealedPreferences: ['Fast feedback'],
  themes: [{ theme: 'Trust', evidence: 'Repeated concern', frequency: 1 }],
  contradictions: [],
  keyInsights: ['Ownership matters'],
  bottomLine: 'Participants need clearer ownership.',
};

const aggregateOutput = {
  commonThemes: [{ theme: 'Trust', frequency: 2, quoteRefs: [{ interviewIndex: 1, turnIndex: 0, quote: 'Hello' }] }],
  divergentViews: [],
  keyFindings: ['Trust is central'],
  researchImplications: ['Clarify ownership'],
  bottomLine: 'Trust and ownership shape adoption.',
};

function studyAt(revision: number, overrides: Partial<StoredStudy> = {}): StoredStudy {
  const id = overrides.id ?? '11111111-1111-4111-8111-111111111111';
  return makeStoredStudy({
    id,
    revision,
    config: makeStudyConfig({ id, aiProvider: 'openai', aiModel: 'gpt-5.6-terra' }),
    ...overrides,
  });
}

function analyzed(study: StoredStudy, id: string, extra: Partial<StoredInterview> = {}): StoredInterview {
  return makeStoredInterview({ id, studyId: study.id, studyRevision: study.revision, synthesis, ...extra });
}

beforeEach(() => {
  vi.clearAllMocks();
  store = fakeDurableStore();
  setCloudflareEnv();
  authorize();
  getInterviewProvider.mockReturnValue({ synthesizeAggregate, generateFollowupStudy });
  synthesizeAggregate.mockResolvedValue({
    value: aggregateOutput,
    execution: { provider: 'openai', requestedModel: 'gpt-5.6-terra', model: 'gpt-5.6-terra-served' },
  });
  generateFollowupStudy.mockResolvedValue({
    value: { name: 'Follow-up', researchQuestion: 'What creates trust?', coreQuestions: ['Why?'] },
    execution: { provider: 'openai', requestedModel: 'gpt-5.6-terra', model: 'gpt-5.6-terra-served' },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
});

describe('RT-08/F10 deployment readiness gate on Cloudflare', () => {
  it('RT-08: a not-ready deployment refuses every mutating and provider route before storage or provider use', async () => {
    setCloudflareEnv({}, { WORKSPACE_STORE: BINDINGS.WORKSPACE_STORE });
    const params = { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) };

    const responses = await Promise.all([
      createStudy(jsonRequest('http://localhost/api/studies', 'POST', { config: makeStudyConfig() })),
      updateStudy(jsonRequest('http://localhost/api/studies/x', 'PUT', { linksEnabled: false }), params),
      deleteStudy(new Request('http://localhost/api/studies/x', { method: 'DELETE' }), params),
      synthesizeAggregateRoute(jsonRequest('http://localhost/api/synthesis/aggregate', 'POST', { studyId: 'x' })),
      generateFollowup(new Request('http://localhost/api/studies/x/generate-followup', { method: 'POST' }), params),
      seedSample(),
      clearSample(),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: 'DEPLOYMENT_NOT_READY', retryable: false });
    }
    for (const method of STORE_METHODS) expect(store[method]).not.toHaveBeenCalled();
    expect(contextMock.getRequestContext).not.toHaveBeenCalled();
    expect(contextMock.getAuthorizedResearcherStudyContext).not.toHaveBeenCalled();
    expect(getInterviewProvider).not.toHaveBeenCalled();
  });
});

describe('GET /api/studies on Cloudflare (ST-01)', () => {
  it('ST-01: an unavailable durable store is a 503, never an empty successful list', async () => {
    store.readiness.mockResolvedValue({ status: 'unavailable' });

    const response = await listStudies(new Request('http://localhost/api/studies'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Study storage is temporarily unavailable.', retryable: true });
    expect(store.listStudies).not.toHaveBeenCalled();
  });

  it.each(['workspace-uninitialized', 'workspace-identity-mismatch', 'schema-unsupported'] as const)(
    'ST-01: a %s hold (which the durable read gate also refuses) is 503 workspace-unavailable without reading studies',
    async (reason) => {
      store.readiness.mockResolvedValue({ status: 'held', reason });

      const response = await listStudies(new Request('http://localhost/api/studies'));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ retryable: false, reason: 'workspace-unavailable' });
      expect(store.listStudies).not.toHaveBeenCalled();
    },
  );

  it('OPS-01: a recovery-epoch hold still lists studies, as the durable read gate and study detail allow', async () => {
    const study = studyAt(1);
    store.readiness.mockResolvedValue({ status: 'held', reason: 'recovery-epoch-mismatch', maintenance: 'recovery' });
    store.listStudies.mockResolvedValue({ status: 'ok', items: [study] });

    const response = await listStudies(new Request('http://localhost/api/studies'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ studies: [JSON.parse(JSON.stringify(study))] });
    expect(store.listStudies).toHaveBeenCalledWith(1_000, { view: 'full' });
  });

  it('OPS-01: reads continue while frozen and keep the collection mappings', async () => {
    const study = studyAt(1);
    store.readiness.mockResolvedValue(ready('frozen'));
    store.listStudies.mockResolvedValue({ status: 'ok', items: [study] });

    const response = await listStudies(new Request('http://localhost/api/studies'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ studies: [JSON.parse(JSON.stringify(study))] });
    expect(store.listStudies).toHaveBeenCalledWith(1_000, { view: 'full' });

    store.listStudies.mockResolvedValue({ status: 'too-large', count: 1_001, maximum: 1_000 });
    const tooLarge = await listStudies(new Request('http://localhost/api/studies'));
    expect(tooLarge.status).toBe(413);
  });

  it('ST-08: ?view=summary asks the store for list items; view=full and no view ask for whole studies', async () => {
    store.readiness.mockResolvedValue(ready('open'));
    const item = toStudyListItem(studyAt(1));
    store.listStudies.mockResolvedValue({ status: 'ok', items: [item] });

    const summary = await listStudies(new Request('http://localhost/api/studies?view=summary'));
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toEqual({ studies: [JSON.parse(JSON.stringify(item))] });
    expect(store.listStudies).toHaveBeenLastCalledWith(1_000, { view: 'summary' });

    await listStudies(new Request('http://localhost/api/studies?view=full'));
    expect(store.listStudies).toHaveBeenLastCalledWith(1_000, { view: 'full' });
    await listStudies(new Request('http://localhost/api/studies?studyId=ignored'));
    expect(store.listStudies).toHaveBeenLastCalledWith(1_000, { view: 'full' });
  });

  it.each(['view=compact', 'view=', 'view=SUMMARY', 'view=summary&view=summary'])(
    'ST-08: %s is a 400 without reading storage',
    async (query) => {
      const response = await listStudies(new Request(`http://localhost/api/studies?${query}`));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'view must be summary or full.' });
      expect(store.readiness).not.toHaveBeenCalled();
      expect(store.listStudies).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/studies on Cloudflare (ST-01 create idempotency)', () => {
  const KEY = '22222222-2222-4222-8222-222222222222';
  const createRequest = (config = makeStudyConfig({ aiProvider: 'openai', aiModel: 'gpt-5.6-terra' })) =>
    jsonRequest('http://localhost/api/studies', 'POST', { config }, { 'Idempotency-Key': KEY });

  it('ST-01: mints outside the store and passes the standalone-scoped key digest and config fingerprint', async () => {
    store.createStudy.mockImplementation(async (input: { candidate: StoredStudy }) => ({
      status: 'created',
      study: input.candidate,
      replayed: false,
    }));

    const response = await createStudy(createRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toBe('Study saved successfully');
    const [input] = store.createStudy.mock.calls[0];
    expect(input.idempotencyKeyDigest).toBe(hashCreateIdempotencyKey('standalone', KEY));
    expect(input.idempotencyKeyDigest).not.toContain(KEY);
    expect(input.fingerprint).toBe(createFingerprint(input.candidate.config));
    expect(input.candidate).toMatchObject({ revision: 1, interviewCount: 0, isLocked: false });
    expect(input.candidate.config.id).toBe(input.candidate.id);
    expect(input.candidate.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.study.id).toBe(input.candidate.id);
  });

  it('ST-01: a replay returns the stored study, not the new candidate', async () => {
    const original = studyAt(1, { id: '33333333-3333-4333-8333-333333333333' });
    store.createStudy.mockResolvedValue({ status: 'created', study: original, replayed: true });

    const response = await createStudy(createRequest());

    expect(response.status).toBe(200);
    expect((await response.json()).study.id).toBe(original.id);
  });

  it.each([
    ['key-reuse', 409, { code: 'IDEMPOTENCY_KEY_REUSE' }],
    ['key-consumed', 409, { code: 'IDEMPOTENCY_KEY_CONSUMED' }],
    ['conflict', 409, { error: 'Study already exists' }],
    ['quota', 503, { retryable: true, reason: 'idempotency-quota' }],
    ['ambiguous', 503, { retryable: true, reason: 'ambiguous' }],
    ['unavailable', 503, { retryable: true, reason: 'unavailable' }],
  ] as const)('ST-01: maps %s to its existing HTTP response', async (status, httpStatus, body) => {
    store.createStudy.mockResolvedValue({ status });

    const response = await createStudy(createRequest());

    expect(response.status).toBe(httpStatus);
    await expect(response.json()).resolves.toEqual(body);
  });

  it('OPS-01: a maintenance hold is a retryable 503 with reason maintenance', async () => {
    store.createStudy.mockResolvedValue({ status: 'held', reason: 'maintenance' });

    const response = await createStudy(createRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true, reason: 'maintenance' });
  });

  it('ST-01: keeps body, provider and Idempotency-Key checks before the store', async () => {
    // A Gemini study on an installation with only an OpenAI key.
    const unconfiguredProvider = await createStudy(jsonRequest(
      'http://localhost/api/studies',
      'POST',
      { config: makeStudyConfig() },
      { 'Idempotency-Key': KEY },
    ));
    expect(unconfiguredProvider.status).toBe(409);
    await expect(unconfiguredProvider.json()).resolves.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    const missingIdempotencyKey = await createStudy(jsonRequest(
      'http://localhost/api/studies',
      'POST',
      { config: makeStudyConfig({ aiProvider: 'openai', aiModel: 'gpt-5.6-terra' }) },
    ));
    expect(missingIdempotencyKey.status).toBe(400);
    expect(store.createStudy).not.toHaveBeenCalled();
  });
});

describe('/api/studies/[id] on Cloudflare (ST-01, ST-03)', () => {
  const STUDY_ID = '11111111-1111-4111-8111-111111111111';
  const params = { params: Promise.resolve({ id: STUDY_ID }) };

  it('ST-01: GET reads through the store with the existing load mapping', async () => {
    store.getStudy.mockResolvedValueOnce({ status: 'found', study: studyAt(2) });
    const found = await getStudy(new Request('http://localhost'), params);
    expect(found.status).toBe(200);
    expect(store.getStudy).toHaveBeenCalledWith(STUDY_ID);

    store.getStudy.mockResolvedValueOnce({ status: 'unavailable' });
    const unavailable = await getStudy(new Request('http://localhost'), params);
    expect(unavailable.status).toBe(503);
  });

  it('OPS-01: PUT refuses a research mutation while draining before reading or writing', async () => {
    store.readiness.mockResolvedValue(ready('draining'));

    const response = await updateStudy(jsonRequest('http://localhost', 'PUT', { config: { name: 'Later' } }), params);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true, reason: 'maintenance' });
    expect(store.getStudy).not.toHaveBeenCalled();
    expect(store.replaceStudyConfig).not.toHaveBeenCalled();
  });

  it('ST-03: PUT replaces the config against the loaded revision and keeps the soft lock', async () => {
    const study = studyAt(5, { interviewCount: 2 });
    store.readiness.mockResolvedValue(ready());
    store.getStudy.mockResolvedValue({ status: 'found', study });

    const unconfirmed = await updateStudy(jsonRequest('http://localhost', 'PUT', { config: { name: 'Later' } }), params);
    expect(unconfirmed.status).toBe(409);
    await expect(unconfirmed.json()).resolves.toMatchObject({ requiresConfirmation: true, interviewCount: 2 });
    expect(store.replaceStudyConfig).not.toHaveBeenCalled();

    store.replaceStudyConfig.mockResolvedValue({ status: 'updated', study: { ...study, revision: 6 } });
    const confirmed = await updateStudy(
      jsonRequest('http://localhost', 'PUT', { config: { name: 'Later' }, confirmed: true }),
      params,
    );
    expect(confirmed.status).toBe(200);
    expect(store.replaceStudyConfig).toHaveBeenCalledWith(expect.objectContaining({
      studyId: STUDY_ID,
      expectedRevision: 5,
      config: expect.objectContaining({ id: STUDY_ID, name: 'Later' }),
      now: expect.any(Number),
    }));
  });

  it('ST-03: PUT maps a hold at the write boundary and a revision conflict', async () => {
    store.readiness.mockResolvedValue(ready());
    store.getStudy.mockResolvedValue({ status: 'found', study: studyAt(5) });

    store.replaceStudyConfig.mockResolvedValueOnce({ status: 'held', reason: 'recovery-epoch-mismatch' });
    const held = await updateStudy(jsonRequest('http://localhost', 'PUT', { config: { name: 'Later' } }), params);
    expect(held.status).toBe(503);
    await expect(held.json()).resolves.toMatchObject({ retryable: false, reason: 'workspace-unavailable' });

    store.replaceStudyConfig.mockResolvedValueOnce({ status: 'conflict' });
    const conflict = await updateStudy(jsonRequest('http://localhost', 'PUT', { config: { name: 'Later' } }), params);
    expect(conflict.status).toBe(409);

    store.setStudyLinksEnabled.mockResolvedValueOnce({ status: 'held', reason: 'maintenance' });
    const links = await updateStudy(jsonRequest('http://localhost', 'PUT', { linksEnabled: false }), params);
    expect(links.status).toBe(503);
    expect(store.setStudyLinksEnabled).toHaveBeenCalledWith({ studyId: STUDY_ID, enabled: false, now: expect.any(Number) });
  });

  it('ST-01: an unreachable workspace is a retryable 503 on PUT and DELETE, never "storage not configured"', async () => {
    store.readiness.mockResolvedValue({ status: 'unavailable' });

    const put = await updateStudy(jsonRequest('http://localhost', 'PUT', { linksEnabled: false }), params);
    const del = await deleteStudy(new Request('http://localhost', { method: 'DELETE' }), params);

    for (const response of [put, del]) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'Study storage is temporarily unavailable.', retryable: true });
    }
    expect(store.getStudy).not.toHaveBeenCalled();
    expect(store.deleteStudy).not.toHaveBeenCalled();
  });

  it('OPS-01: DELETE refuses a research mutation while draining before any delete', async () => {
    store.readiness.mockResolvedValue(ready('draining'));

    const response = await deleteStudy(new Request('http://localhost', { method: 'DELETE' }), params);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ retryable: true, reason: 'maintenance' });
    expect(store.deleteStudy).not.toHaveBeenCalled();
  });

  it('ST-01: DELETE keeps the invalid-operation 503 for an id no store accepts', async () => {
    store.readiness.mockResolvedValue(ready());

    const response = await deleteStudy(
      new Request('http://localhost', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'not a study id' }) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid study operation.' });
    expect(store.deleteStudy).not.toHaveBeenCalled();
  });

  it('ST-07: DELETE maps deleted, populated-study conflict and hold outcomes', async () => {
    store.readiness.mockResolvedValue(ready());
    const request = () => new Request('http://localhost', { method: 'DELETE' });

    store.deleteStudy.mockResolvedValueOnce({ status: 'deleted', success: true });
    const deleted = await deleteStudy(request(), params);
    expect(deleted.status).toBe(200);
    expect(store.deleteStudy).toHaveBeenCalledWith({ studyId: STUDY_ID, now: expect.any(Number) });

    store.deleteStudy.mockResolvedValueOnce({
      status: 'conflict',
      success: false,
      error: 'Cannot delete study with existing interviews',
    });
    const populated = await deleteStudy(request(), params);
    expect(populated.status).toBe(409);

    store.deleteStudy.mockResolvedValueOnce({ status: 'held', reason: 'maintenance', success: false });
    const held = await deleteStudy(request(), params);
    expect(held.status).toBe(503);
    await expect(held.json()).resolves.toMatchObject({ reason: 'maintenance' });
  });
});

describe('aggregate read and aggregate synthesis on Cloudflare (RT-09, ST-08)', () => {
  const aggregateRequest = (studyId: string) =>
    jsonRequest('http://localhost/api/synthesis/aggregate', 'POST', { studyId });

  it('RT-09: GET aggregate reads the stored aggregate through the store', async () => {
    const study = studyAt(1);
    store.getAggregate.mockResolvedValue({ status: 'not-found' });

    const response = await getAggregate(new Request('http://localhost'), { params: Promise.resolve({ id: study.id }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ aggregate: null });
    expect(store.getAggregate).toHaveBeenCalledWith(study.id);
  });

  it('OPS-01: refuses aggregate synthesis (it ends in a researcher mutation) while draining, frozen or in recovery, before any read or provider call', async () => {
    for (const maintenance of ['draining', 'frozen', 'recovery'] as const) {
      store.readiness.mockResolvedValueOnce(ready(maintenance));
      const response = await synthesizeAggregateRoute(aggregateRequest('study-x'));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ reason: 'maintenance', retryable: true });
    }
    expect(store.getStudy).not.toHaveBeenCalled();
    expect(synthesizeAggregate).not.toHaveBeenCalled();
  });

  it('RT-09: pages bounded current-revision inputs (never the full collection) and saves the result', async () => {
    const study = studyAt(4);
    store.readiness.mockResolvedValue(ready());
    store.getStudy.mockResolvedValue({ status: 'found', study });
    store.readAggregateInputs
      .mockResolvedValueOnce({ status: 'ok', interviews: [analyzed(study, 'current-a')], nextCursor: 'c1', totalEligible: 2 })
      .mockResolvedValueOnce({ status: 'ok', interviews: [analyzed(study, 'current-b')], nextCursor: null, totalEligible: 2 });
    store.saveAggregate.mockResolvedValue('saved');

    const response = await synthesizeAggregateRoute(aggregateRequest(study.id));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.synthesis).toMatchObject({ studyId: study.id, studyRevision: 4, interviewIds: ['current-a', 'current-b'] });
    expect(Number.isSafeInteger(body.synthesis.savedAt)).toBe(true);
    expect(store.listInterviews).not.toHaveBeenCalled();
    expect(store.readAggregateInputs.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ studyId: study.id, studyRevision: 4, cursor: null }),
      expect.objectContaining({ studyId: study.id, studyRevision: 4, cursor: 'c1' }),
    ]);
    for (const [input] of store.readAggregateInputs.mock.calls) {
      expect(input.maxPageBytes).toBeLessThanOrEqual(AGGREGATE_INPUT_PAGE_BYTES);
    }
    expect(synthesizeAggregate).toHaveBeenCalledWith(study.config, [synthesis, synthesis], 2);
  });

  it.each(['held', 'study-not-found', 'unavailable'] as const)(
    'ST-07: a %s aggregate write returns the paid result without savedAt',
    async (outcome) => {
      const study = studyAt(2);
      store.readiness.mockResolvedValue(ready());
      store.getStudy.mockResolvedValue({ status: 'found', study });
      store.readAggregateInputs.mockResolvedValue({
        status: 'ok',
        interviews: [analyzed(study, 'a'), analyzed(study, 'b')],
        nextCursor: null,
        totalEligible: 2,
      });
      store.saveAggregate.mockResolvedValue(outcome);

      const response = await synthesizeAggregateRoute(aggregateRequest(study.id));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.synthesis.studyId).toBe(study.id);
      expect(body.synthesis.savedAt).toBeUndefined();
    },
  );

  it('RT-09: keeps the count-based 413 and the fewer-than-two 400 without a provider call', async () => {
    const study = studyAt(3);
    store.readiness.mockResolvedValue(ready());
    store.getStudy.mockResolvedValue({ status: 'found', study });

    store.readAggregateInputs.mockResolvedValueOnce({ status: 'ok', interviews: [], nextCursor: 'c', totalEligible: 1_001 });
    const tooMany = await synthesizeAggregateRoute(aggregateRequest(study.id));
    expect(tooMany.status).toBe(413);
    await expect(tooMany.json()).resolves.toEqual({
      error: 'This study has too many interviews for an interactive aggregate analysis.',
    });

    store.readAggregateInputs.mockResolvedValueOnce({
      status: 'ok',
      // An ineligible record from an older revision never counts toward the minimum.
      interviews: [analyzed(study, 'current'), analyzed(study, 'old', { studyRevision: 2 })],
      nextCursor: null,
      totalEligible: 2,
    });
    const tooFew = await synthesizeAggregateRoute(aggregateRequest(study.id));
    expect(tooFew.status).toBe(400);
    await expect(tooFew.json()).resolves.toMatchObject({ studyRevision: 3, eligibleInterviewCount: 1 });

    store.readAggregateInputs.mockResolvedValueOnce({ status: 'unavailable' });
    const unavailable = await synthesizeAggregateRoute(aggregateRequest(study.id));
    expect(unavailable.status).toBe(503);
    expect(synthesizeAggregate).not.toHaveBeenCalled();
  });

  it('RT-09: a study holding more than 1,000 interviews of any revision is the count-based 413 before any input page, as on Node', async () => {
    store.readiness.mockResolvedValue(ready());
    store.getStudy.mockResolvedValue({ status: 'found', study: studyAt(3, { interviewCount: 1_001 }) });

    const response = await synthesizeAggregateRoute(aggregateRequest('11111111-1111-4111-8111-111111111111'));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'This study has too many interviews for an interactive aggregate analysis.',
    });
    expect(store.readAggregateInputs).not.toHaveBeenCalled();
    expect(synthesizeAggregate).not.toHaveBeenCalled();
  });

  it('RT-09: inputs beyond the byte ceiling are an explicit 413, never a truncated analysis', async () => {
    const study = studyAt(1);
    store.readiness.mockResolvedValue(ready());
    store.getStudy.mockResolvedValue({ status: 'found', study });
    const half = Math.ceil(MAX_AGGREGATE_INPUT_BYTES / 2);
    const large = (id: string) => analyzed(study, id, {
      transcript: [{ id: 'm', role: 'user', content: 'x'.repeat(half), timestamp: 1 }],
    });
    store.readAggregateInputs
      .mockResolvedValueOnce({ status: 'ok', interviews: [large('a')], nextCursor: 'c1', totalEligible: 3 })
      .mockResolvedValueOnce({ status: 'ok', interviews: [large('b')], nextCursor: 'c2', totalEligible: 3 })
      .mockResolvedValueOnce({ status: 'ok', interviews: [analyzed(study, 'c')], nextCursor: null, totalEligible: 3 });

    const response = await synthesizeAggregateRoute(aggregateRequest(study.id));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'AGGREGATE_INPUT_TOO_LARGE' });
    expect(store.readAggregateInputs).toHaveBeenCalledTimes(2);
    expect(synthesizeAggregate).not.toHaveBeenCalled();
    expect(store.saveAggregate).not.toHaveBeenCalled();
  });
});

describe('POST /api/studies/[id]/generate-followup on Cloudflare (RT-09, F26)', () => {
  const study = studyAt(3);
  const params = { params: Promise.resolve({ id: study.id }) };
  const followupRequest = () => new Request('http://localhost', { method: 'POST' });
  const storedAggregate = {
    studyId: study.id,
    studyRevision: 3,
    interviewIds: ['a', 'b'],
    interviewCount: 2,
    aiProvider: 'openai',
    aiModel: 'gpt-5.6-terra-served',
    requestedAiModel: 'gpt-5.6-terra',
    commonThemes: [{ theme: 'Trust', frequency: 2, representativeQuotes: ['A'] }],
    divergentViews: [],
    keyFindings: ['Trust matters'],
    researchImplications: ['Study ownership'],
    bottomLine: 'Ownership shapes trust.',
    generatedAt: 1,
    savedAt: 2,
  } as unknown as StoredAggregateSynthesis;

  beforeEach(() => {
    store.getStudy.mockResolvedValue({ status: 'found', study });
    store.getAggregate.mockResolvedValue({ status: 'found', aggregate: storedAggregate });
  });

  it('F26: allowed while draining; reads eligibility in bounded pages and stops once every source is seen', async () => {
    store.readiness.mockResolvedValue(ready('draining'));
    store.readAggregateInputs.mockResolvedValueOnce({
      status: 'ok',
      interviews: [analyzed(study, 'a'), analyzed(study, 'b')],
      nextCursor: 'more',
      totalEligible: 40,
    });

    const response = await generateFollowup(followupRequest(), params);

    expect(response.status).toBe(200);
    expect(store.readAggregateInputs).toHaveBeenCalledTimes(1);
    expect(store.readAggregateInputs).toHaveBeenCalledWith(expect.objectContaining({
      studyId: study.id,
      studyRevision: 3,
      cursor: null,
    }));
    expect(store.listInterviews).not.toHaveBeenCalled();
    expect(generateFollowupStudy).toHaveBeenCalledTimes(1);
  });

  it('F26: refused while frozen or in recovery before any read or provider call', async () => {
    for (const maintenance of ['frozen', 'recovery'] as const) {
      store.readiness.mockResolvedValueOnce(ready(maintenance));
      const response = await generateFollowup(followupRequest(), params);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ retryable: true, reason: 'maintenance' });
    }
    expect(store.getStudy).not.toHaveBeenCalled();
    expect(generateFollowupStudy).not.toHaveBeenCalled();
  });

  it('RT-09: an unreachable workspace or input page is a retryable 503 without a provider call', async () => {
    store.readiness.mockResolvedValueOnce({ status: 'unavailable' });
    const unready = await generateFollowup(followupRequest(), params);
    expect(unready.status).toBe(503);
    await expect(unready.json()).resolves.toEqual({ error: 'Study storage is temporarily unavailable.', retryable: true });

    store.readiness.mockResolvedValue(ready());
    store.readAggregateInputs.mockResolvedValueOnce({ status: 'unavailable' });
    const pageLost = await generateFollowup(followupRequest(), params);
    expect(pageLost.status).toBe(503);
    await expect(pageLost.json()).resolves.toEqual({ error: 'Interview storage is temporarily unavailable.', retryable: true });
    expect(generateFollowupStudy).not.toHaveBeenCalled();
  });

  it('RT-09: keeps the count-based 413 (study interview count and eligible count) without a provider call', async () => {
    store.readiness.mockResolvedValue(ready());
    const tooLargeBody = { error: 'This study has too many interviews for interactive follow-up generation.' };

    store.getStudy.mockResolvedValueOnce({ status: 'found', study: { ...study, interviewCount: 1_001 } });
    const byStudyCount = await generateFollowup(followupRequest(), params);
    expect(byStudyCount.status).toBe(413);
    await expect(byStudyCount.json()).resolves.toEqual(tooLargeBody);
    expect(store.readAggregateInputs).not.toHaveBeenCalled();

    store.readAggregateInputs.mockResolvedValueOnce({ status: 'ok', interviews: [], nextCursor: 'c', totalEligible: 1_001 });
    const byEligibleCount = await generateFollowup(followupRequest(), params);
    expect(byEligibleCount.status).toBe(413);
    await expect(byEligibleCount.json()).resolves.toEqual(tooLargeBody);
    expect(generateFollowupStudy).not.toHaveBeenCalled();
  });

  it('RT-09: a source that is no longer an eligible current-revision input is 409 without a provider call', async () => {
    store.readiness.mockResolvedValue(ready());
    store.readAggregateInputs
      .mockResolvedValueOnce({ status: 'ok', interviews: [analyzed(study, 'a')], nextCursor: 'c1', totalEligible: 2 })
      .mockResolvedValueOnce({ status: 'ok', interviews: [analyzed(study, 'z')], nextCursor: null, totalEligible: 2 });

    const response = await generateFollowup(followupRequest(), params);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Synthesis interview provenance is invalid.' });
    expect(generateFollowupStudy).not.toHaveBeenCalled();
  });
});

describe('/api/demo/seed on Cloudflare (ST-07)', () => {
  it('ST-07: seeds with the installation AI_PROVIDER from the Worker invocation, not key order', async () => {
    setCloudflareEnv({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'synthetic-anthropic-provider-key' });
    authorize(cloudflareContext({ anthropicApiKey: 'synthetic-anthropic-provider-key' }));
    store.readiness.mockResolvedValue(ready());
    store.seedSampleWorkspace.mockResolvedValue({ status: 'seeded', studiesSeeded: 1, interviewsSeeded: 3 });

    const response = await seedSample();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { studiesSeeded: 1, interviewsSeeded: 3, aggregateSynthesisAvailable: true },
    });
    const [input] = store.seedSampleWorkspace.mock.calls[0];
    expect(input.studies.map((study: StoredStudy) => study.id)).toEqual(DEMO_STUDIES.map(study => study.id));
    expect(input.interviews.map((interview: StoredInterview) => interview.id)).toEqual(DEMO_INTERVIEWS.map(i => i.id));
    expect(input.studies[0].config).toMatchObject({ aiProvider: 'claude', aiModel: 'claude-sonnet-5' });
    expect(input.studies[0].config).not.toHaveProperty('enableReasoning');
    expect(DEMO_STUDIES[0].config.aiProvider).toBe('gemini');
  });

  it('ST-07: maps already-seeded, maintenance and unavailable seed outcomes', async () => {
    store.readiness.mockResolvedValue(ready());
    store.seedSampleWorkspace.mockResolvedValueOnce({ status: 'already-seeded' });
    expect((await seedSample()).status).toBe(409);

    store.seedSampleWorkspace.mockResolvedValueOnce({ status: 'held', reason: 'maintenance' });
    const held = await seedSample();
    expect(held.status).toBe(503);
    await expect(held.json()).resolves.toMatchObject({ reason: 'maintenance' });

    store.readiness.mockResolvedValueOnce(ready('draining'));
    const draining = await seedSample();
    expect(draining.status).toBe(503);
    expect(store.seedSampleWorkspace).toHaveBeenCalledTimes(2);
  });

  it('ST-07: a held or unreachable workspace refuses the seed before provider selection or any write', async () => {
    store.readiness.mockResolvedValueOnce({ status: 'held', reason: 'workspace-identity-mismatch' });
    const held = await seedSample();
    expect(held.status).toBe(503);
    await expect(held.json()).resolves.toMatchObject({ retryable: false, reason: 'workspace-unavailable' });

    store.readiness.mockResolvedValueOnce({ status: 'unavailable' });
    const unreachable = await seedSample();
    expect(unreachable.status).toBe(503);
    await expect(unreachable.json()).resolves.toEqual({
      error: 'Workspace storage is temporarily unavailable. Try again before loading sample workspace data.',
      retryable: true,
    });
    expect(store.getStudy).not.toHaveBeenCalled();
    expect(store.seedSampleWorkspace).not.toHaveBeenCalled();
  });

  it('ST-07: an already-loaded sample is 409 ahead of a missing installation provider key', async () => {
    authorize(cloudflareContext({ openaiApiKey: null }));
    store.readiness.mockResolvedValue(ready());
    store.getStudy.mockResolvedValueOnce({ status: 'found', study: DEMO_STUDIES[0] });

    const loaded = await seedSample();
    expect(loaded.status).toBe(409);
    expect(store.getStudy).toHaveBeenCalledWith(DEMO_STUDIES[0].id);

    store.getStudy.mockResolvedValueOnce({ status: 'not-found' });
    const noProvider = await seedSample();
    expect(noProvider.status).toBe(503);
    await expect(noProvider.json()).resolves.toMatchObject({ error: expect.stringContaining('AI provider not configured') });
    expect(store.seedSampleWorkspace).not.toHaveBeenCalled();
  });

  it('ST-07: clears only the fixture ids and refuses a fixture study holding participant data', async () => {
    store.clearSampleWorkspace.mockResolvedValueOnce({ status: 'cleared', studiesDeleted: 1, interviewsDeleted: 3 });
    const cleared = await clearSample();
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toEqual({
      success: true,
      message: 'Sample workspace data cleared',
      data: { studiesDeleted: 1, interviewsDeleted: 3 },
    });
    expect(store.clearSampleWorkspace).toHaveBeenCalledWith({
      studyIds: DEMO_STUDIES.map(study => study.id),
      interviewIds: DEMO_INTERVIEWS.map(interview => interview.id),
    });

    store.clearSampleWorkspace.mockResolvedValueOnce({ status: 'has-participant-data' });
    const refused = await clearSample();
    expect(refused.status).toBe(409);
    const refusedBody = await refused.json();
    expect(refusedBody).toMatchObject({ code: 'SAMPLE_HAS_PARTICIPANT_DATA' });
    expect(typeof refusedBody.error).toBe('string');

    for (const outcome of [{ status: 'held', reason: 'workspace-identity-mismatch' }, { status: 'ambiguous' }, { status: 'unavailable' }]) {
      store.clearSampleWorkspace.mockResolvedValueOnce(outcome);
      expect((await clearSample()).status).toBe(503);
    }

    store.clearSampleWorkspace.mockResolvedValueOnce({ status: 'unavailable' });
    await expect((await clearSample()).json()).resolves.toEqual({
      error: 'Workspace storage is temporarily unavailable. Try again before clearing sample workspace data.',
      retryable: true,
    });
  });
});
