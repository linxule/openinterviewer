// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';
import type { ResearcherContext } from '@/lib/researcherContext';
import type { WorkspaceStorePort } from '@/lib/storage/types';
import type { RedisPort } from '@/lib/redisPort';
import type { CompleteExplorationInput, ExplorationAnswer, ExplorationReservation, FailExplorationInput } from '@/lib/exploration/types';
import { ProviderFailure, ProviderTimeoutError } from '@/lib/providerErrors';

const authorized = vi.hoisted(() => vi.fn());
const exploreStudy = vi.hoisted(() => vi.fn());
const getInterviewProvider = vi.hoisted(() => vi.fn());
const hostedBudget = vi.hoisted(() => vi.fn());
const researcherBudget = vi.hoisted(() => vi.fn());
vi.mock('@/lib/researcherContext', () => ({
  getAuthorizedResearcherStudyContext: authorized,
  providerKeysFromContext: (context: ResearcherContext) => ({ geminiApiKey: context.geminiApiKey, route: context.providerRoute }),
}));
vi.mock('@/lib/providers', () => ({ getInterviewProvider }));
vi.mock('@/lib/platformAiRateLimit', () => ({ hostedAiRateLimitResponse: hostedBudget }));
vi.mock('@/lib/researcherAiBudget', () => ({ researcherAiBudgetResponse: researcherBudget }));
vi.mock('@/lib/runtime/readinessGate', () => ({ deploymentNotReadyResponse: () => null }));

import { GET as listAnswers, POST as askQuestion } from '@/app/api/studies/[id]/exploration/route';
import { GET as getAnswer } from '@/app/api/studies/[id]/exploration/[answerId]/route';
import { POST as saveAnswer } from '@/app/api/studies/[id]/exploration/[answerId]/save/route';
import { POST as describeDataset } from '@/app/api/studies/[id]/dataset/route';

const studyId = 'study-exploration';
const params = () => ({ params: Promise.resolve({ id: studyId }) });
const question = 'What supports or challenges our hypothesis?';
const key = 'question-key-00000001';
const result = {
  answer: 'The evidence is mixed.',
  findings: [{ heading: 'Conditional benefit', interpretation: 'A provisional finding.',
    supporting: [{ interviewIndex: 1, turnIndex: 2, quote: 'Speed helped me.' }], challenging: [], uncertain: [] }],
  limitations: ['One selected interview; no prevalence claim.'],
};
const execution = { provider: 'gemini' as const, requestedModel: 'gemini-3.7-flash', model: 'gemini-3.7-flash-001' };
let study: ReturnType<typeof makeStoredStudy>;
let interviews: ReturnType<typeof makeStoredInterview>[];
let context: ResearcherContext;
let deleted: boolean;
let events: string[];
let answers: Map<string, ExplorationAnswer>;
let keys: Map<string, string>;
const reserve = vi.fn();
const complete = vi.fn();
const fail = vi.fn();
const readAnswer = vi.fn();
const lookup = vi.fn();
const list = vi.fn();
const getStudy = vi.fn();
const listInterviews = vi.fn();

function ask(body: Record<string, unknown> = { question, selection: {} }, idempotencyKey: string = key) {
  return askQuestion(new Request(`http://localhost/api/studies/${studyId}/exploration`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body),
  }), params());
}
function save(id: string, receipt: unknown, extra: Record<string, unknown> = {}) {
  return saveAnswer(new Request(`http://localhost/api/studies/${studyId}/exploration/${id}/save`, {
    method: 'POST', body: JSON.stringify({ receipt, ...extra }),
  }), { params: Promise.resolve({ id: studyId, answerId: id }) });
}

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'synthetic-exploration-signing-secret-only-for-tests');
  vi.stubEnv('DEPLOYMENT_TARGET', 'node');
  vi.stubEnv('DEPLOYMENT_MODE', 'standalone');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  answers = new Map(); keys = new Map(); deleted = false; events = [];
  study = makeStoredStudy({ id: studyId, revision: 2 });
  study.config = { ...study.config, id: studyId, aiProvider: 'gemini', aiModel: execution.requestedModel };
  interviews = [makeStoredInterview({ id: 'interview-evidence', studyId, studyRevision: 1, collectionConfig: study.config,
    synthesis: null, transcript: [
      { id: 'interviewer', role: 'ai', content: 'What helped?', timestamp: 1 },
      { id: 'participant', role: 'user', content: 'Speed helped me.', timestamp: 2 },
    ] })];
  getStudy.mockImplementation(async () => deleted ? { status: 'not-found' } : { status: 'found', study });
  listInterviews.mockImplementation(async () => ({ status: 'ok', items: interviews }));
  reserve.mockImplementation(async (input: ExplorationReservation) => {
    events.push('reserve');
    if (deleted) return { status: 'study-not-found' };
    const previousId = keys.get(input.keyDigest);
    if (previousId) {
      const answer = answers.get(previousId)!;
      return answer.requestFingerprint === input.answer.requestFingerprint ? { status: 'replay', answer } : { status: 'key-reuse' };
    }
    if (input.expectedStudyRevision !== study.revision) return { status: 'revision-stale' };
    const answer = structuredClone(input.answer);
    answers.set(answer.id, answer); keys.set(input.keyDigest, answer.id);
    return { status: 'created', answer };
  });
  complete.mockImplementation(async (input: CompleteExplorationInput) => {
    events.push('complete');
    if (deleted) return { status: 'study-not-found' };
    const existing = answers.get(input.answerId);
    if (!existing) return { status: 'not-found' };
    if (existing.requestFingerprint !== input.requestFingerprint) return { status: 'conflict' };
    const answer: ExplorationAnswer = { ...existing, updatedAt: input.now, status: 'complete', result: input.result, execution: input.execution };
    delete answer.failureKind;
    answers.set(answer.id, answer);
    return { status: 'saved', answer };
  });
  fail.mockImplementation(async (input: FailExplorationInput) => {
    events.push('fail');
    if (deleted) return { status: 'study-not-found' };
    const existing = answers.get(input.answerId);
    if (!existing) return { status: 'not-found' };
    const answer: ExplorationAnswer = { ...existing, updatedAt: input.now, status: input.status, failureKind: input.failureKind };
    answers.set(answer.id, answer);
    return { status: 'saved', answer };
  });
  readAnswer.mockImplementation(async ({ answerId }: { answerId: string }) => {
    const answer = answers.get(answerId); return answer ? { status: 'found', answer } : { status: 'not-found' };
  });
  lookup.mockImplementation(async (input: { keyDigest: string; requestFingerprint: string }) => {
    const answerId = keys.get(input.keyDigest);
    if (!answerId) return { status: 'not-found' };
    const answer = answers.get(answerId)!;
    return input.requestFingerprint === answer.requestFingerprint ? { status: 'found', answer } : { status: 'key-reuse' };
  });
  list.mockImplementation(async () => ({ status: 'ok', answers: [...answers.values()] }));
  context = { researcherId: 'researcher-a', kvClient: {} as RedisPort,
    store: { backend: 'redis', getStudy, listInterviews, exploration: { lookup, reserve, get: readAnswer, list, complete, fail } } as unknown as WorkspaceStorePort,
    geminiApiKey: 'synthetic-fixture-key', anthropicApiKey: null, openaiApiKey: null, openrouterApiKey: null, onboardingComplete: true };
  authorized.mockResolvedValue({ authorized: true, context });
  getInterviewProvider.mockReturnValue({ exploreStudy });
  hostedBudget.mockImplementation(async () => { events.push('hosted-budget'); return null; });
  researcherBudget.mockImplementation(async () => { events.push('researcher-budget'); return null; });
  exploreStudy.mockImplementation(async () => { events.push('provider'); return { value: result, execution }; });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('durable exploration request boundary', () => {
  it('reserves before budgeting/provider, explores old unanalysed raw transcripts, and refreshes the saved artifact', async () => {
    const response = await ask();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(events).toEqual(['reserve', 'hosted-budget', 'researcher-budget', 'provider', 'complete']);
    expect(authorized).toHaveBeenCalledWith(studyId, 'read');
    expect(exploreStudy).toHaveBeenCalledWith({ question, studyConfig: study.config, interviews }, { kind: 'exploration', deadlineMs: 120_000 });
    expect(body.answer).toMatchObject({ status: 'complete', execution, scope: { selectedCount: 1, pendingAnalysisCount: 1,
      sources: [{ interviewId: interviews[0].id, studyRevision: 1 }] }, result: { findings: [{ supporting: [{ interviewId: interviews[0].id, turnIndex: 2, quote: 'Speed helped me.' }] }] } });
    const reloaded = await getAnswer(new Request('http://localhost'), { params: Promise.resolve({ id: studyId, answerId: body.answer.id }) });
    expect((await reloaded.json()).answer).toEqual(body.answer);
    expect((await (await listAnswers(new Request('http://localhost'), params())).json()).answers).toEqual([body.answer]);
    expect(exploreStudy).toHaveBeenCalledTimes(1);
    expect(researcherBudget).toHaveBeenCalledTimes(1);
  });

  it('returns the original same-key answer even after a new source arrives, never rebudgeting or regenerating', async () => {
    const first = await (await ask()).json();
    interviews.push(makeStoredInterview({ ...interviews[0], id: 'interview-later' }));
    const second = await (await ask()).json();
    expect(second.answer).toEqual(first.answer);
    expect(second.answer.scope.selectedCount).toBe(1);
    expect(exploreStudy).toHaveBeenCalledTimes(1);
    expect(hostedBudget).toHaveBeenCalledTimes(1);
    expect(researcherBudget).toHaveBeenCalledTimes(1);
  });

  it('returns the running reservation to a concurrent same-key request rather than starting a second execution', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    exploreStudy.mockImplementationOnce(async () => { await blocked; return { value: result, execution }; });
    const first = ask();
    await vi.waitFor(() => expect(exploreStudy).toHaveBeenCalledTimes(1));
    const replay = await (await ask()).json();
    expect(replay.answer.status).toBe('running');
    expect(exploreStudy).toHaveBeenCalledTimes(1); expect(researcherBudget).toHaveBeenCalledTimes(1);
    release();
    expect((await (await first).json()).answer.id).toBe(replay.answer.id);
  });

  it('replays the saved attempt before newly incompatible/oversized sources or unavailable provider configuration', async () => {
    const first = await (await ask()).json();
    interviews[0].transcript[1].content = 'x'.repeat(65_536);
    interviews[0].providerCommitment = 'fixed'; interviews[0].conductedByProvider = 'openai'; interviews[0].conductedByModel = 'gpt-5.6-terra';
    getInterviewProvider.mockImplementation(() => { throw new Error('Synthetic missing provider key'); });
    vi.stubEnv('SESSION_SECRET', '');
    const second = await ask();
    expect(second.status).toBe(200);
    expect((await second.json()).answer).toEqual(first.answer);
    expect(listInterviews).toHaveBeenCalledTimes(1); expect(getInterviewProvider).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1); expect(exploreStudy).toHaveBeenCalledTimes(1); expect(researcherBudget).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the earlier key lookup is unavailable, even if reserve could otherwise create an attempt', async () => {
    lookup.mockResolvedValueOnce({ status: 'unavailable' });
    const response = await ask();
    expect(response.status).toBe(503);
    expect(listInterviews).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });

  it('refuses a reused request key for another question without another provider attempt', async () => {
    await ask();
    const response = await ask({ question: 'A different analytical question?', selection: {} });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('EXPLORATION_KEY_REUSE');
    expect(exploreStudy).toHaveBeenCalledTimes(1);
  });

  it.each(['unavailable', 'revision-stale', 'quota', 'study-not-found'] as const)('refused reservation (%s) never reaches budget or provider', async (status) => {
    reserve.mockResolvedValueOnce({ status });
    const response = await ask();
    expect(response.status).toBe({ unavailable: 503, 'revision-stale': 409, quota: 429, 'study-not-found': 404 }[status]);
    expect(hostedBudget).not.toHaveBeenCalled(); expect(researcherBudget).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });

  it('records a budget refusal as a failed durable attempt and replays it without another charge', async () => {
    researcherBudget.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const first = await (await ask()).json();
    expect(first.answer).toMatchObject({ status: 'failed', failureKind: 'budget-limited' });
    expect((await (await ask()).json()).answer).toEqual(first.answer);
    expect(researcherBudget).toHaveBeenCalledTimes(1);
    expect(exploreStudy).not.toHaveBeenCalled();
  });

  it.each([new ProviderTimeoutError(120_000), new ProviderFailure('unavailable', 'Synthetic upstream 503'), new TypeError('Synthetic lost connection')])('retains uncertainty on %s and same-key replay does not retry', async (error) => {
    exploreStudy.mockRejectedValueOnce(error);
    const first = await (await ask()).json();
    expect(first.answer.status).toBe('recovery-required');
    expect((await (await ask()).json()).answer).toEqual(first.answer);
    expect(exploreStudy).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('records a known invalid provider response as failed, rather than pretending to provide research data', async () => {
    exploreStudy.mockRejectedValueOnce(new ProviderFailure('invalid-response', 'Synthetic malformed body'));
    const response = await ask();
    expect((await response.json()).answer).toMatchObject({ status: 'failed', failureKind: 'provider-invalid-response' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('records an invalid generated artifact as failed without leaving a running attempt or returning fabricated output', async () => {
    exploreStudy.mockResolvedValueOnce({ value: { ...result, answer: 'x'.repeat(20_001) }, execution });
    const response = await ask();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.answer).toMatchObject({ status: 'failed', failureKind: 'provider-invalid-response' });
    expect(body.answer.result).toBeUndefined();
    expect([...answers.values()][0].status).toBe('failed'); expect(complete).not.toHaveBeenCalled();
  });

  it('uses only the parent question for continuity, not its generated answer', async () => {
    const first = await (await ask()).json();
    await ask({ question: 'What challenges that interpretation?', selection: {}, parentAnswerId: first.answer.id }, 'question-key-00000002');
    expect(exploreStudy.mock.calls[1][0].previousQuestions).toEqual([question]);
    expect(exploreStudy.mock.calls[1][0]).not.toHaveProperty('previousAnswers');
    expect(JSON.stringify(exploreStudy.mock.calls[1][0])).not.toContain('The evidence is mixed.');
  });
});

describe('preflight fails closed before paid admission', () => {
  it('honors a Durable Object maintenance/schema hold before notebook reads or provider admission', async () => {
    context.store = { ...context.store, backend: 'durable-object', readiness: vi.fn(async () => ({ status: 'held', reason: 'schema-hold' })) } as WorkspaceStorePort;
    const response = await ask();
    expect(response.status).toBe(503);
    expect(getStudy).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });
  it.each(['provider', 'signing'] as const)('refuses missing %s configuration before durable reserve or budget', async (prerequisite) => {
    if (prerequisite === 'provider') getInterviewProvider.mockImplementationOnce(() => { throw new Error('Synthetic missing provider key'); });
    else vi.stubEnv('SESSION_SECRET', '');
    const response = await ask();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(reserve).not.toHaveBeenCalled(); expect(hostedBudget).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });
  it('denies another researcher before reading records or touching the notebook', async () => {
    authorized.mockResolvedValueOnce({ authorized: false, statusCode: 404, error: 'Study not found' });
    expect((await ask()).status).toBe(404);
    expect(listInterviews).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });

  it('checks fixed source provider/model commitments without silently excluding incompatible interviews', async () => {
    interviews[0].providerCommitment = 'fixed'; interviews[0].conductedByProvider = 'openai'; interviews[0].conductedByModel = 'gpt-5.6-terra';
    const response = await ask();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PROVIDER_COMMITMENT_MISMATCH', incompatibleInterviewCount: 1 });
    expect(reserve).not.toHaveBeenCalled(); expect(getInterviewProvider).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });

  it('checks each source transport disclosure before any gateway request', async () => {
    vi.stubEnv('DEPLOYMENT_TARGET', 'cloudflare');
    context.providerRoute = { transport: 'cloudflare-gateway', accountId: '0123456789abcdef0123456789abcdef', gatewayId: 'fixture', token: 'synthetic-run-token' };
    const response = await ask();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'TRANSPORT_NOT_DISCLOSED', uncoveredInterviewCount: 1 });
    expect(reserve).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });

  it('refuses an oversized complete corpus rather than sampling, before charging or reserving', async () => {
    interviews[0].transcript[1].content = 'x'.repeat(65_536);
    const response = await ask();
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('EXPLORATION_CORPUS_TOO_LARGE');
    expect(reserve).not.toHaveBeenCalled(); expect(hostedBudget).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });

  it('refuses unknown source ids and oversized questions before provider use', async () => {
    expect((await ask({ question, selection: { interviewIds: ['foreign-interview'] } })).status).toBe(400);
    expect((await ask({ question: 'x'.repeat(2_001), selection: {} })).status).toBe(400);
    expect(reserve).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });

  it('describes an oversized selection so it can be narrowed without starting an attempt', async () => {
    interviews[0].transcript[1].content = 'x'.repeat(65_536);
    const response = await describeDataset(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ selection: {} }) }), params());
    expect(response.status).toBe(200);
    expect((await response.json()).dataset.manifest.selectedCount).toBe(1);
    expect(reserve).not.toHaveBeenCalled(); expect(exploreStudy).not.toHaveBeenCalled();
  });
});

describe('save-only recovery and deletion fencing', () => {
  it('returns a signed unsaved result after generation and saves the same answer without a provider call or budget', async () => {
    complete.mockResolvedValueOnce({ status: 'unavailable' });
    const first = await (await ask()).json();
    expect(first).toMatchObject({ unsaved: true, answer: { status: 'complete' }, saveReceipt: expect.any(String) });
    expect(answers.get(first.answer.id)?.status).toBe('running');
    const response = await save(first.answer.id, first.saveReceipt);
    expect(response.status).toBe(200);
    expect((await response.json()).answer).toEqual(first.answer);
    expect(exploreStudy).toHaveBeenCalledTimes(1); expect(researcherBudget).toHaveBeenCalledTimes(1); expect(hostedBudget).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('preserves a confirmed generated result with save-only authority even when the completion adapter throws', async () => {
    complete.mockRejectedValueOnce(new Error('Synthetic store transport lost after generation'));
    const response = await ask();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ unsaved: true, answer: { status: 'complete', result: { answer: result.answer } }, saveReceipt: expect.any(String) });
    expect((await save(body.answer.id, body.saveReceipt)).status).toBe(200);
    expect(exploreStudy).toHaveBeenCalledTimes(1); expect(researcherBudget).toHaveBeenCalledTimes(1);
  });

  it('turns a thrown save-only outage into a retryable response without losing receipt authority or regenerating', async () => {
    complete.mockResolvedValueOnce({ status: 'unavailable' });
    const first = await (await ask()).json();
    complete.mockRejectedValueOnce(new Error('Synthetic store transport outage'));
    const failed = await save(first.answer.id, first.saveReceipt);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ retryable: true });
    expect((await save(first.answer.id, first.saveReceipt)).status).toBe(200);
    expect(exploreStudy).toHaveBeenCalledTimes(1); expect(researcherBudget).toHaveBeenCalledTimes(1);
  });

  it('binds save authority to researcher, study, answer, signature and result rather than browser-supplied provenance', async () => {
    complete.mockResolvedValueOnce({ status: 'unavailable' });
    const first = await (await ask()).json();
    const calls = complete.mock.calls.length;
    context.researcherId = 'researcher-b';
    expect((await save(first.answer.id, first.saveReceipt)).status).toBe(400);
    context.researcherId = 'researcher-a';
    expect((await save('another-answer', first.saveReceipt)).status).toBe(400);
    expect((await save(first.answer.id, first.saveReceipt.slice(0, -8) + 'tampered')).status).toBe(400);
    expect((await save(first.answer.id, first.saveReceipt, { result: { answer: 'Invented' } })).status).toBe(400);
    expect(complete).toHaveBeenCalledTimes(calls);
    expect(exploreStudy).toHaveBeenCalledTimes(1);
  });

  it('cannot attach a late result or replay its receipt into a deleted study', async () => {
    exploreStudy.mockImplementationOnce(async () => { deleted = true; answers.clear(); keys.clear(); return { value: result, execution }; });
    const first = await (await ask()).json();
    expect(first).toMatchObject({ unsaved: true, answer: { status: 'complete' } });
    expect(answers.size).toBe(0);
    const response = await save(first.answer.id, first.saveReceipt);
    expect(response.status).toBe(404);
    expect(answers.size).toBe(0); expect(exploreStudy).toHaveBeenCalledTimes(1);
  });

  it('marks an interrupted running request uncertain when refreshed after its deadline, without regeneration', async () => {
    exploreStudy.mockRejectedValueOnce(new ProviderTimeoutError(120_000));
    const first = await (await ask()).json();
    const row = answers.get(first.answer.id)!;
    row.status = 'running'; delete row.failureKind; row.createdAt = Date.now() - 180_000;
    const response = await getAnswer(new Request('http://localhost'), { params: Promise.resolve({ id: studyId, answerId: row.id }) });
    expect((await response.json()).answer).toMatchObject({ status: 'recovery-required', failureKind: 'request-interrupted' });
    expect(exploreStudy).toHaveBeenCalledTimes(1);
  });
});
