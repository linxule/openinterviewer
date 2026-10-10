// @vitest-environment node
// Runner-owned real Redis: lifecycle and notebook claims must cross the wire.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createStudyAtomic, deleteStudy, encodeInterviewValue, getInterviewChecked,
  getStudyChecked, persistCompletedInterview, replaceStudyConfigAtomic,
  saveStudyAggregate, setStudyLinksEnabled,
  claimInterviewAnalysis, attachInterviewAnalysis, recordInterviewAnalysisFailure,
} from '@/lib/kv';
import { createRedisWorkspaceStore } from '@/lib/storage/redis';
import { createParticipantLinkRecord, getParticipantLinkById } from '@/lib/participantLinks';
import { recordParticipantConsent, verifyParticipantConsent } from '@/lib/participantConsent';
import type { ExplorationAnswer, CompleteExplorationInput } from '@/lib/exploration/types';
import { immutableSourceContentHash } from '@/lib/exploration/dataset';
import { createFingerprint, hashCreateIdempotencyKey, parseCreateIdempotencyRecord } from '@/lib/createIdempotency';
import type { RedisNodeAdapter } from '@/lib/redisNodeAdapter';
import { startDisposableRedis, type DisposableRedis } from '../helpers/disposableRedis';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';

const FP = 'a'.repeat(64);
const KEY = 'b'.repeat(64);
const NOW = 1_700_000_000_000;
let owned: DisposableRedis;
let redis: RedisNodeAdapter;

beforeAll(async () => {
  process.env.DEPLOYMENT_MODE = 'standalone';
  owned = await startDisposableRedis();
  redis = owned.adapter();
}, 60_000);
afterAll(async () => { await owned?.close(); });

async function study() {
  const s = makeStoredStudy({ id: randomUUID(), revision: 1 });
  expect(await createStudyAtomic(s, redis)).toBe('created');
  return s;
}

async function answer(studyId: string, interviewId: string, id = randomUUID()): Promise<ExplorationAnswer> {
  const loaded = await getInterviewChecked(interviewId, redis);
  if (loaded.status !== 'found') throw new Error('Source missing');
  const contentHash = await immutableSourceContentHash(loaded.interview);
  return {
    id, studyId, question: 'What challenges the hypothesis?', createdAt: NOW, updatedAt: NOW,
    status: 'running', requestFingerprint: FP, promptVersion: 1,
    scope: { studyId, selection: {}, sources: [{ interviewId, studyRevision: 1, contentHash }],
      totalSaved: 1, selectedCount: 1, excludedCount: 0, unknownProfileCount: 0,
      pendingAnalysisCount: 1, sourceFingerprint: FP },
  };
}

function result(a: ExplorationAnswer): CompleteExplorationInput {
  return {
    studyId: a.studyId, answerId: a.id, requestFingerprint: FP, now: NOW + 1,
    result: { answer: 'This claim remains provisional.', findings: [], limitations: ['One interview.'] },
    execution: { provider: 'gemini', requestedModel: 'test-model', model: 'test-model' },
  };
}

async function source(studyId: string) {
  const interview = makeStoredInterview({ id: randomUUID(), studyId, studyRevision: 1 });
  await redis.set(`interview:${interview.id}`, encodeInterviewValue(interview));
  await redis.sadd(`study-interviews:${studyId}`, interview.id);
  await redis.sadd('all-interviews', interview.id);
  return interview;
}

describe('researcher lifecycle over real Redis', () => {
  it('pause/resume retain revision, no-op saves retain timestamp, a protocol edit advances it', async () => {
    const s = await study();
    const paused = await setStudyLinksEnabled(s.id, false, redis);
    expect(paused.status === 'updated' && paused.study.revision).toBe(1);
    const resumed = await setStudyLinksEnabled(s.id, true, redis);
    expect(resumed.status).toBe('updated');
    if (resumed.status !== 'updated') throw new Error('Resume failed');
    expect(resumed.study.revision).toBe(1);
    const noOp = await replaceStudyConfigAtomic(s.id, 1,
      { ...resumed.study.config, createdAt: NOW + 500 }, redis);
    expect(noOp.status === 'updated' && noOp.study.updatedAt).toBe(resumed.study.updatedAt);
    expect(noOp.status === 'updated' && noOp.study.revision).toBe(1);
    const changed = await replaceStudyConfigAtomic(s.id, 1, { ...resumed.study.config, name: 'Changed protocol' }, redis);
    expect(changed.status === 'updated' && changed.study.revision).toBe(2);
  });

  it('refused populated deletion and stale confirmation leave no guard and do not block collection', async () => {
    const s = await study();
    await source(s.id);
    expect((await deleteStudy(s.id, redis)).status).toBe('conflict');
    expect(await redis.get(`study-mutation-guard:${s.id}`)).toContain('created');
    expect((await deleteStudy(s.id, redis, undefined, { deleteInterviews: true, expectedRevision: 2 })).status).toBe('conflict');
    expect(await redis.get(`study-mutation-guard:${s.id}`)).toContain('created');
    expect(await persistCompletedInterview(makeStoredInterview({ id: randomUUID(), studyId: s.id }), FP,
      { expectedStudyRevision: 1 }, redis)).toEqual({ status: 'created' });
  });

  it('a stale full-config save cannot undo a concurrent access pause at the unchanged revision', async () => {
    const s = await study();
    expect((await setStudyLinksEnabled(s.id, false, redis)).status).toBe('updated');
    const saved = await replaceStudyConfigAtomic(s.id, 1, { ...s.config, name: 'Edited content', linksEnabled: true }, redis);
    expect(saved.status === 'updated' && saved.study.revision).toBe(2);
    expect(saved.status === 'updated' && saved.study.config.linksEnabled).toBe(false);
    const staleNoOp = await replaceStudyConfigAtomic(s.id, 2,
      { ...(saved.status === 'updated' ? saved.study.config : s.config), linksEnabled: true }, redis);
    expect(staleNoOp.status === 'updated' && staleNoOp.study.revision).toBe(2);
    expect(staleNoOp.status === 'updated' && staleNoOp.study.config.linksEnabled).toBe(false);
  });

  it('purges in bounded resumable batches and removes only the confirmed study data', async () => {
    const s = await study();
    const other = await study();
    const untouched = await source(other.id);
    const interviews = await Promise.all(Array.from({ length: 205 }, () => source(s.id)));
    const link = await createParticipantLinkRecord({ studyId: s.id, studyRevision: 1, researcherId: null, expiresAt: null, standaloneClient: redis });
    expect(link.status).toBe('created');
    const session = 'participant_session_123456';
    expect((await recordParticipantConsent({ participantSessionId: session, studyId: s.id, studyRevision: 1, consentText: 'Yes' }, redis)).status).toBe('accepted');
    const notebook = createRedisWorkspaceStore(redis, { researcherId: null }).exploration!;
    const lifecycle = createRedisWorkspaceStore(redis, { researcherId: null }).studyMutationStatus!;
    expect(await lifecycle(s.id)).toBe('ready');
    const a = await answer(s.id, interviews[0].id);
    expect((await notebook.reserve({ answer: a, keyDigest: KEY, expectedStudyRevision: 1 })).status).toBe('created');
    expect((await deleteStudy(s.id, redis, undefined, { deleteInterviews: true, expectedRevision: 1 })).status).toBe('still-pending');
    expect(await redis.scard(`study-interviews:${s.id}`)).toBe(105);
    expect(await lifecycle(s.id)).toBe('deleting');
    expect(await persistCompletedInterview(makeStoredInterview({ id: randomUUID(), studyId: s.id }), FP,
      { expectedStudyRevision: 1 }, redis)).toEqual({ status: 'persist-guard' });
    expect((await deleteStudy(s.id, redis)).status).toBe('still-pending');
    expect(await redis.scard(`study-interviews:${s.id}`)).toBe(5);
    expect((await deleteStudy(s.id, redis)).status).toBe('deleted');
    expect((await deleteStudy(s.id, redis)).status).toBe('deleted');
    expect(await getStudyChecked(s.id, redis)).toEqual({ status: 'not-found' });
    expect(await lifecycle(s.id)).toBe('missing');
    for (const interview of interviews) expect(await getInterviewChecked(interview.id, redis)).toEqual({ status: 'not-found' });
    expect(await getInterviewChecked(untouched.id, redis)).toMatchObject({ status: 'found' });
    expect((await verifyParticipantConsent({ participantSessionId: session, studyId: s.id, studyRevision: 1, consentText: 'Yes' }, redis)).status).toBe('missing');
    if (link.status === 'created') expect((await getParticipantLinkById(link.link.id, redis)).status).toBe('not-found');
    expect(await redis.get(`study-exploration:${s.id}:${a.id}`)).toBeNull();
    expect(await redis.hlen(`study-exploration-keys:${s.id}`)).toBe(0);
    expect((await notebook.complete(result(a))).status).not.toBe('saved');
  });

  it('completion racing confirmed deletion cannot leave a resurrected interview', async () => {
    const s = await study();
    const interview = makeStoredInterview({ id: randomUUID(), studyId: s.id });
    await Promise.all([
      persistCompletedInterview(interview, FP, { expectedStudyRevision: 1 }, redis),
      deleteStudy(s.id, redis, undefined, { deleteInterviews: true, expectedRevision: 1 }),
    ]);
    expect((await deleteStudy(s.id, redis, undefined, { deleteInterviews: true, expectedRevision: 1 })).status).toBe('deleted');
    expect(await getInterviewChecked(interview.id, redis)).toEqual({ status: 'not-found' });
    expect(await persistCompletedInterview(interview, FP, { expectedStudyRevision: 1 }, redis)).toEqual({ status: 'study-not-found' });
  });

  it('late aggregate writes and new consent/link writes cannot recreate deleted study data', async () => {
    const s = await study();
    expect((await deleteStudy(s.id, redis)).status).toBe('deleted');
    expect(await saveStudyAggregate({ studyId: s.id, studyRevision: 1, interviewIds: ['missing-source'], interviewCount: 1,
      aiProvider: 'gemini', aiModel: 'test', commonThemes: [], divergentViews: [], keyFindings: [],
      researchImplications: [], bottomLine: 'Late result', generatedAt: NOW, savedAt: NOW }, redis)).toBe('study-not-found');
    expect(await redis.get(`study-aggregate:${s.id}`)).toBeNull();
    expect((await recordParticipantConsent({ participantSessionId: 'participant_session_123456', studyId: s.id, studyRevision: 1, consentText: 'Yes' }, redis)).status).not.toBe('accepted');
    expect((await createParticipantLinkRecord({ studyId: s.id, studyRevision: 1, researcherId: null, expiresAt: null, standaloneClient: redis })).status).not.toBe('created');
  });

  it('refuses aggregate attachment after a concurrent edit or missing/foreign source', async () => {
    const s = await study();
    const interview = await source(s.id);
    const aggregate = { studyId: s.id, studyRevision: 1, interviewIds: [interview.id], interviewCount: 1,
      aiProvider: 'gemini' as const, aiModel: 'test', commonThemes: [], divergentViews: [], keyFindings: [],
      researchImplications: [], bottomLine: 'Generated interpretation', generatedAt: NOW, savedAt: NOW };
    expect(await saveStudyAggregate(aggregate, redis)).toBe('saved');
    await replaceStudyConfigAtomic(s.id, 1, { ...s.config, name: 'Revised protocol' }, redis);
    expect(await saveStudyAggregate(aggregate, redis)).toBe('unavailable');
    expect(await saveStudyAggregate({ ...aggregate, studyRevision: 2, interviewIds: ['missing-source'] }, redis)).toBe('unavailable');
    const other = await study();
    const foreign = await source(other.id);
    expect(await saveStudyAggregate({ ...aggregate, studyRevision: 2, interviewIds: [foreign.id] }, redis)).toBe('unavailable');
  });

  it.each([0, 205])('deletes study-owned config receipts in the real sorted-set create index (interviews=%s)', async (count) => {
    const store = createRedisWorkspaceStore(redis, { researcherId: null });
    const candidate = makeStoredStudy({ id: randomUUID() });
    candidate.config.id = candidate.id;
    const digest = hashCreateIdempotencyKey('standalone', randomUUID());
    const fingerprint = createFingerprint(candidate.config);
    const input = { candidate, idempotencyKeyDigest: digest, fingerprint };
    expect((await store.createStudy(input)).status).toBe('created');
    expect(await redis.zcard('create-idemp-index:standalone')).toBeGreaterThan(0);
    await Promise.all(Array.from({ length: count }, () => source(candidate.id)));
    const first = await store.deleteStudy({ studyId: candidate.id, now: NOW,
      ...(count > 0 ? { deleteInterviews: true, expectedRevision: 1 } : {}) });
    expect(first.status).toBe(count > 100 ? 'still-pending' : 'deleted');
    if (count > 100) {
      expect((await deleteStudy(candidate.id, redis)).status).toBe('still-pending');
      expect((await deleteStudy(candidate.id, redis)).status).toBe('deleted');
    }
    const raw = await redis.get(`create-idemp:${digest}`);
    const receipt = parseCreateIdempotencyRecord(raw);
    expect(receipt).toMatchObject({ state: 'deleted', study: null, studyId: candidate.id });
    expect(raw).not.toContain(candidate.config.researchQuestion);
    expect((await store.createStudy(input)).status).toBe('key-consumed');
    expect(await getStudyChecked(candidate.id, redis)).toEqual({ status: 'not-found' });
  });

  it('refuses a wrong-type cleanup index before tombstoning or removing live interview data', async () => {
    const s = await study();
    const interview = await source(s.id);
    await redis.set(`study-consent-index:${s.id}`, 'corrupt-index');
    const previousGuard = await redis.get(`study-mutation-guard:${s.id}`);
    expect((await deleteStudy(s.id, redis, undefined, { deleteInterviews: true, expectedRevision: 1 })).status).toBe('unavailable');
    expect(await redis.get(`study-mutation-guard:${s.id}`)).toBe(previousGuard);
    expect((await getInterviewChecked(interview.id, redis)).status).toBe('found');
    expect((await getStudyChecked(s.id, redis)).status).toBe('found');
    await redis.del(`study-consent-index:${s.id}`);
  });

  it('a bounded purge fences new analysis claims and late writes on still-retained rows', async () => {
    const s = await study();
    const interviews = await Promise.all(Array.from({ length: 101 }, () => source(s.id)));
    const claims = new Map(await Promise.all(interviews.map(async interview => {
      const claim = await claimInterviewAnalysis(interview.id, redis, NOW);
      if (claim.status !== 'claimed') throw new Error('Analysis claim failed');
      return [interview.id, claim.claimId] as const;
    })));
    expect((await deleteStudy(s.id, redis, undefined, { deleteInterviews: true, expectedRevision: 1 })).status).toBe('still-pending');
    const retainedId = (await redis.smembers(`study-interviews:${s.id}`) as string[])[0];
    const original = await redis.get(`interview:${retainedId}`);
    expect(await claimInterviewAnalysis(retainedId, redis, NOW + 300_000)).toEqual({ status: 'unavailable' });
    expect(await attachInterviewAnalysis({ interviewId: retainedId, claimId: claims.get(retainedId)!, studyRevision: 1,
      synthesis: { statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [], keyInsights: [], bottomLine: 'Late paid result' },
      provenance: { aiProvider: 'gemini', aiModel: 'test', requestedAiModel: 'test' } }, redis)).toEqual({ status: 'unavailable' });
    expect(await recordInterviewAnalysisFailure(retainedId, claims.get(retainedId)!, 'provider', redis)).toEqual({ status: 'unavailable' });
    expect(await redis.get(`interview:${retainedId}`)).toBe(original);
    expect((await deleteStudy(s.id, redis)).status).toBe('deleted');
  });
});

describe('durable exploration over authorized Redis client', () => {
  it('pages saved artifacts by stable time/id keyset without fetching the rest of their content', async () => {
    const s = await study();
    const interview = await source(s.id);
    const notebook = createRedisWorkspaceStore(redis, { researcherId: null }).exploration!;
    const base = await answer(s.id, interview.id);
    const rows: ExplorationAnswer[] = [];
    for (let index = 0; index < 31; index += 1) {
      const createdAt = NOW + (index % 3);
      const a = { ...base, id: randomUUID(), createdAt, updatedAt: createdAt };
      const keyDigest = index.toString(16).padStart(64, '0');
      expect((await notebook.reserve({ answer: a, keyDigest, expectedStudyRevision: 1 })).status).toBe('created');
      rows.push(a);
    }
    rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const first = await notebook.list({ studyId: s.id, maximum: 500, pageSize: 25 });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok' || !first.nextCursor) throw new Error('Page cursor missing');
    expect(first.answers.map(a => a.id)).toEqual(rows.slice(0, 25).map(a => a.id));
    const inserted = { ...base, id: randomUUID(), createdAt: NOW + 20, updatedAt: NOW + 20 };
    await notebook.reserve({ answer: inserted, keyDigest: 'f'.repeat(64), expectedStudyRevision: 1 });
    const second = await notebook.list({ studyId: s.id, maximum: 500, pageSize: 25, cursor: first.nextCursor });
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') throw new Error('Second page failed');
    expect(second.answers.map(a => a.id)).toEqual(rows.slice(25).map(a => a.id));
    expect(second.nextCursor).toBeNull();
    const refresh = await notebook.list({ studyId: s.id, maximum: 500, pageSize: 25 });
    expect(refresh.status === 'ok' && refresh.answers[0].id).toBe(inserted.id);
  });

  it('atomically reserves one idempotent attempt, refuses key reuse, and retains refreshable results', async () => {
    const s = await study();
    const interview = await source(s.id);
    const notebook = createRedisWorkspaceStore(redis, { researcherId: 'hosted-owner' }).exploration!;
    const a = await answer(s.id, interview.id);
    const attempts = await Promise.all([
      notebook.reserve({ answer: a, keyDigest: KEY, expectedStudyRevision: 1 }),
      notebook.reserve({ answer: { ...a, id: randomUUID() }, keyDigest: KEY, expectedStudyRevision: 1 }),
    ]);
    expect(attempts.map(v => v.status).sort()).toEqual(['created', 'replay']);
    expect(attempts.every(v => (v.status === 'created' || v.status === 'replay') && v.answer.id === a.id)).toBe(true);
    expect((await notebook.reserve({ answer: { ...a, requestFingerprint: 'c'.repeat(64) }, keyDigest: KEY, expectedStudyRevision: 1 })).status).toBe('key-reuse');
    expect((await notebook.complete(result(a))).status).toBe('saved');
    expect(await notebook.get({ studyId: s.id, answerId: a.id })).toMatchObject({ status: 'found', answer: { status: 'complete', result: { answer: 'This claim remains provisional.' } } });
    expect(await notebook.list({ studyId: s.id, maximum: 500 })).toMatchObject({ status: 'ok', answers: [{ id: a.id, status: 'complete' }] });
    expect((await notebook.reserve({ answer: a, keyDigest: KEY, expectedStudyRevision: 1 })).status).toBe('replay');
    await replaceStudyConfigAtomic(s.id, 1, { ...s.config, name: 'Later protocol' }, redis);
    expect((await notebook.lookup!({ studyId: s.id, keyDigest: KEY, requestFingerprint: FP })).status).toBe('found');
    expect((await notebook.reserve({ answer: a, keyDigest: KEY, expectedStudyRevision: 1 })).status).toBe('replay');
    expect((await notebook.complete(result(a))).status).toBe('saved');
    expect((await notebook.complete({ ...result(a), result: { answer: 'Different paid output.', findings: [], limitations: [] } })).status).toBe('conflict');
  });

  it('save-only recovery completes one retained attempt and drops its failure marker', async () => {
    const s = await study();
    const interview = await source(s.id);
    const notebook = createRedisWorkspaceStore(redis, { researcherId: null }).exploration!;
    const a = await answer(s.id, interview.id);
    await notebook.reserve({ answer: a, keyDigest: KEY, expectedStudyRevision: 1 });
    expect((await notebook.fail({ studyId: s.id, answerId: a.id, requestFingerprint: FP,
      status: 'recovery-required', failureKind: 'storage', now: NOW + 1 })).status).toBe('saved');
    expect((await notebook.complete({ ...result(a), now: NOW + 2 })).status).toBe('saved');
    const loaded = await notebook.get({ studyId: s.id, answerId: a.id });
    expect(loaded.status === 'found' && loaded.answer.failureKind).toBeUndefined();
  });

  it('refuses corrupt persisted status and a result whose selected source disappeared', async () => {
    const s = await study();
    const interview = await source(s.id);
    const notebook = createRedisWorkspaceStore(redis, { researcherId: null }).exploration!;
    const a = await answer(s.id, interview.id);
    await notebook.reserve({ answer: a, keyDigest: KEY, expectedStudyRevision: 1 });
    const corrupted = `oi:exploration:${JSON.stringify({ ...a, status: 'made-up' })}`;
    await redis.set(`study-exploration:${s.id}:${a.id}`, corrupted);
    expect((await notebook.reserve({ answer: a, keyDigest: KEY, expectedStudyRevision: 1 })).status).toBe('unavailable');
    expect((await notebook.complete(result(a))).status).toBe('unavailable');
    expect(await redis.get(`study-exploration:${s.id}:${a.id}`)).toBe(corrupted);
    await redis.set(`study-exploration:${s.id}:${a.id}`, `oi:exploration:${JSON.stringify(a)}`);
    await redis.set(`interview:${interview.id}`, encodeInterviewValue({ ...interview,
      transcript: [...interview.transcript, { id: 'new-turn', role: 'user', content: 'Changed primary evidence', timestamp: NOW }] }));
    expect((await notebook.complete(result(a))).status).toBe('conflict');
    await redis.set(`interview:${interview.id}`, encodeInterviewValue(interview));
    await redis.del(`interview:${interview.id}`);
    expect((await notebook.complete(result(a))).status).toBe('conflict');
  });
});

describe('projects over real Redis', () => {
  let database: DisposableRedis;
  let client: RedisNodeAdapter;
  let store: ReturnType<typeof createRedisWorkspaceStore>;
  beforeEach(async () => {
    database = await startDisposableRedis();
    client = database.adapter();
    store = createRedisWorkspaceStore(client, { researcherId: null });
  });
  afterEach(async () => { await database?.close(); });
  async function create(name = 'Project 🙂') {
    const result = await store.projects.create({ name });
    if (result.status !== 'created') throw new Error('Project create failed');
    return result.project;
  }
  it('the Lua writer refuses a name its own readers would reject, writing nothing', async () => {
    const { PROJECTS_SCRIPT } = await import('@/lib/storage/redisProjects');
    for (const name of ['bad\u0001name', ' padded ', '']) {
      const id = randomUUID();
      expect(await client.eval(PROJECTS_SCRIPT, [], ['create', id, name, '', String(Date.now())])).toEqual(['oi:unavailable']);
      expect(await client.get('project:' + id)).toBeNull();
    }
    const p = await create();
    expect(await client.eval(PROJECTS_SCRIPT, [], ['rename', p.id, 'bad\u0001name', '', String(Date.now())])).toEqual(['oi:unavailable']);
    expect(await store.projects.list()).toMatchObject({ status: 'ok', projects: [{ id: p.id, name: 'Project 🙂' }] });
  });
  async function seed(bare = false) {
    const s = makeStoredStudy({ id: randomUUID(), revision: 1 });
    expect(await createStudyAtomic(s, client)).toBe('created');
    if (bare) await client.set('study:' + s.id, JSON.stringify(s));
    return s;
  }
  it.each([false, true])('allows assignment, ungrouping and deletion during completion; preserves study bytes (bare=%s)', async bare => {
    const s = await seed(bare), p = await create();
    const before = await client.get('study:' + s.id);
    await client.sadd('study-persisting:' + s.id, 'in-flight-interview');
    for (const projectId of [p.id, null, p.id]) expect(await store.projects.assignStudy({ studyId: s.id, projectId })).toEqual({ status: 'assigned', studyId: s.id, projectId });
    expect(await store.projects.delete({ projectId: p.id })).toEqual({ status: 'deleted' });
    expect(await client.get('study:' + s.id)).toBe(before);
    expect(await client.scard('study-persisting:' + s.id)).toBe(1);
    expect(await client.get('study-project:' + s.id)).toBeNull();
  });
  it('preserves every safe timestamp integer rather than rounding through Lua cjson', async () => {
    const p = await create();
    const stored = { ...p, createdAt: Number.MAX_SAFE_INTEGER - 1, updatedAt: Number.MAX_SAFE_INTEGER };
    await client.set('project:' + p.id, 'oi:project:' + JSON.stringify(stored));
    expect(await store.projects.read({ projectId: p.id })).toEqual({ status: 'found', project: stored, studyIds: [] });
    expect(await store.projects.rename({ projectId: p.id, name: 'Renamed' }))
      .toEqual({ status: 'updated', project: { ...stored, name: 'Renamed' } });
    expect(JSON.parse((await client.get<string>('project:' + p.id))!.slice(11)).updatedAt).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('checks deletion guards before a no-op and before ungrouping any member', async () => {
    const a = await seed(), b = await seed(), p = await create();
    for (const s of [a, b]) await store.projects.assignStudy({ studyId: s.id, projectId: p.id });
    await client.set('study-mutation-guard:' + b.id, 'oi:smg:{"state":"in-flight","kind":"delete"}');
    expect(await store.projects.assignStudy({ studyId: b.id, projectId: p.id })).toEqual({ status: 'persist-guard' });
    expect(await store.projects.delete({ projectId: p.id })).toEqual({ status: 'persist-guard' });
    expect(await client.get('study-project:' + a.id)).toBe(p.id);
    expect(await client.get('study-project:' + b.id)).toBe(p.id);
    expect(await client.get('project:' + p.id)).not.toBeNull();
    await client.set('study-mutation-guard:' + b.id, 'oi:smg:broken');
    expect(await store.projects.assignStudy({ studyId: b.id, projectId: null })).toEqual({ status: 'unavailable' });
    expect(await store.projects.delete({ projectId: p.id })).toEqual({ status: 'unavailable' });
  });
  it.each(['study-project', 'study-mutation-guard', 'project', 'all-projects', 'all-studies'])('preflights wrong-type %s without partial writes', async family => {
    const s = await seed(), p = await create();
    await store.projects.assignStudy({ studyId: s.id, projectId: p.id });
    const key = family === 'project' ? 'project:' + p.id
      : family.startsWith('all-') ? family : family + ':' + s.id;
    await client.del(key);
    await client.sadd(key, 'wrong-type');
    if (family.startsWith('all-')) {
      await client.del(key); await client.set(key, 'wrong-type');
    }
    expect(await store.projects.assignStudy({ studyId: s.id, projectId: null })).toEqual({ status: 'unavailable' });
    expect(await store.projects.delete({ projectId: p.id })).toEqual({ status: 'unavailable' });
    expect(await client.exists('study:' + s.id)).toBe(1);
  });
  it.each([{ name: ' not-trimmed ' }, { extra: 1 }, { updatedAt: -1 }, { name: null }, { name: 'a'.repeat(201) }])('refuses corrupt project fields before rename/delete: %j', async change => {
    const s = await seed(), p = await create();
    await store.projects.assignStudy({ studyId: s.id, projectId: p.id });
    const bytes = 'oi:project:' + JSON.stringify({ ...p, ...change });
    await client.set('project:' + p.id, bytes);
    expect(await store.projects.rename({ projectId: p.id, name: 'Repair?' })).toEqual({ status: 'unavailable' });
    expect(await store.projects.delete({ projectId: p.id })).toEqual({ status: 'unavailable' });
    expect(await client.get('project:' + p.id)).toBe(bytes);
    expect(await client.get('study-project:' + s.id)).toBe(p.id);
  });
  it('refuses primary/index divergence and never silently ungroups an orphan', async () => {
    const s = await seed(), p = await create();
    await store.projects.assignStudy({ studyId: s.id, projectId: p.id });
    await client.srem('all-projects', p.id);
    expect(await store.projects.read({ projectId: p.id })).toEqual({ status: 'unavailable' });
    expect(await store.projects.list()).toEqual({ status: 'unavailable' });
    expect(await store.projects.assignStudy({ studyId: s.id, projectId: null })).toEqual({ status: 'unavailable' });
    expect(await client.get('study-project:' + s.id)).toBe(p.id);
  });
  it('bounds enumeration before reads, but still permits individual assignment and purge', async () => {
    const s = await seed(), p = await create();
    await client.eval("for i=1,1000 do redis.call('SADD','all-studies','overflow-' .. i) end return 1", [], []);
    expect(await store.projects.list()).toEqual({ status: 'too-large' });
    expect(await store.projects.read({ projectId: p.id })).toEqual({ status: 'too-large' });
    expect(await store.projects.delete({ projectId: p.id })).toEqual({ status: 'too-large' });
    expect((await store.projects.assignStudy({ studyId: s.id, projectId: p.id })).status).toBe('assigned');
    expect((await store.deleteStudy({ studyId: s.id, now: Date.now() })).status).toBe('deleted');
    expect(await client.get('study-project:' + s.id)).toBeNull();
    await client.eval("for i=1,1000 do redis.call('SADD','all-projects','overflow-' .. i) end return 1", [], []);
    expect(await store.projects.create({ name: 'Over limit' })).toEqual({ status: 'quota' });
  });
  it('purges membership only after accepting empty/populated deletion and refuses late reassignment', async () => {
    const s = await seed(), p = await create();
    await store.projects.assignStudy({ studyId: s.id, projectId: p.id });
    await client.sadd('study-interviews:' + s.id, 'synthetic-interview');
    await client.set('interview:synthetic-interview', encodeInterviewValue(makeStoredInterview({ id: 'synthetic-interview', studyId: s.id })));
    expect((await store.deleteStudy({ studyId: s.id, now: Date.now() })).status).toBe('conflict');
    expect(await client.get('study-project:' + s.id)).toBe(p.id);
    expect((await store.deleteStudy({ studyId: s.id, deleteInterviews: true, expectedRevision: 2, now: Date.now() })).status).toBe('conflict');
    expect(await client.get('study-project:' + s.id)).toBe(p.id);
    expect((await store.deleteStudy({ studyId: s.id, deleteInterviews: true, expectedRevision: 1, now: Date.now() })).status).toBe('deleted');
    expect(await client.get('study-project:' + s.id)).toBeNull();
    expect((await store.projects.assignStudy({ studyId: s.id, projectId: p.id })).status).toBe('study-not-found');
    expect((await store.projects.read({ projectId: p.id })).status).toBe('found');
  });
});
