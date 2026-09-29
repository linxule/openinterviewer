// @vitest-environment node
// Real disposable Redis: a partial purge is not a smaller complete dataset.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudyAtomic, deleteStudy, encodeInterviewValue } from '@/lib/kv';
import { createRedisWorkspaceStore } from '@/lib/storage/redis';
import { startDisposableRedis, type DisposableRedis } from '../helpers/disposableRedis';
import type { RedisNodeAdapter } from '@/lib/redisNodeAdapter';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';

const clientMock = vi.hoisted(() => ({ getKVClient: vi.fn() }));
vi.mock('@/lib/kvClient', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/kvClient')>()), getKVClient: clientMock.getKVClient }));
const identity = vi.hoisted(() => ({ verifySessionToken: vi.fn(), verifyParticipantToken: vi.fn(), cookies: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: identity.cookies }));
vi.mock('@/lib/auth', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/auth')>()), verifySessionToken: identity.verifySessionToken, verifyParticipantToken: identity.verifyParticipantToken }));
const provider = vi.hoisted(() => ({ getInterviewProvider: vi.fn() }));
vi.mock('@/lib/providers', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/providers')>()), getInterviewProvider: provider.getInterviewProvider }));

import { GET as exportGET } from '@/app/api/interviews/export/route';
import { GET as studyGET, DELETE as studyDELETE } from '@/app/api/studies/[id]/route';
import { POST as explorationPOST } from '@/app/api/studies/[id]/exploration/route';
import { POST as greetingPOST } from '@/app/api/greeting/route';
import { getAuthorizedResearcherStudyContext } from '@/lib/researcherContext';
import { loadCanonicalStudy } from '@/lib/canonicalStudy';

let owned: DisposableRedis;
let redis: RedisNodeAdapter;

beforeAll(async () => { owned = await startDisposableRedis(); redis = owned.adapter(); }, 60_000);
afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'standalone');
  vi.stubEnv('DEPLOYMENT_TARGET', 'node');
  vi.stubEnv('AI_TRANSPORT', 'direct');
  clientMock.getKVClient.mockReturnValue(redis);
  identity.cookies.mockResolvedValue({ get: () => ({ value: 'synthetic-researcher-session' }) });
  identity.verifySessionToken.mockResolvedValue({ valid: true });
});

async function retainedStudy(count: number) {
  const study = makeStoredStudy({ id: randomUUID(), revision: 1 });
  expect(await createStudyAtomic(study, redis)).toBe('created');
  const records = Array.from({ length: count }, () => makeStoredInterview({ id: randomUUID(), studyId: study.id, studyRevision: 1 }));
  for (const interview of records) {
    await redis.set(`interview:${interview.id}`, encodeInterviewValue(interview));
    await redis.sadd(`study-interviews:${study.id}`, interview.id);
    await redis.sadd('all-interviews', interview.id);
  }
  return study;
}

describe('partial Redis deletion read and export fences', () => {
  it('refuses partial ZIPs and paid lookup, preserves unrelated scoped export, and resumes without renewed destructive intent', async () => {
    const doomed = await retainedStudy(205);
    const untouched = await retainedStudy(1);
    expect((await deleteStudy(doomed.id, redis, undefined, { deleteInterviews: true, expectedRevision: 1 })).status).toBe('still-pending');
    expect(await redis.scard(`study-interviews:${doomed.id}`)).toBe(105);
    const store = createRedisWorkspaceStore(redis, { researcherId: null });
    expect(await store.studyMutationStatus!(doomed.id)).toBe('deleting');

    const scoped = await exportGET(new Request(`http://localhost/api/interviews/export?studyId=${doomed.id}`));
    const all = await exportGET(new Request('http://localhost/api/interviews/export'));
    for (const response of [scoped, all]) {
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect((await response.json()).code).toBe('STUDY_DELETION_PENDING');
    }
    const unrelated = await exportGET(new Request(`http://localhost/api/interviews/export?studyId=${untouched.id}`));
    expect(unrelated.status).toBe(200);
    expect(unrelated.headers.get('content-type')).toBe('application/zip');
    const route = { params: Promise.resolve({ id: doomed.id }) };
    const detail = await studyGET(new Request(`http://localhost/api/studies/${doomed.id}`), route);
    expect(detail.status).toBe(409);
    expect((await detail.json()).code).toBe('STUDY_DELETION_PENDING');
    const paid = await explorationPOST(new Request(`http://localhost/api/studies/${doomed.id}/exploration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ question: 'What evidence challenges the hypothesis?', selection: {} }),
    }), route);
    expect(paid.status).toBe(409);
    expect(provider.getInterviewProvider).not.toHaveBeenCalled();

    identity.verifyParticipantToken.mockResolvedValue({ valid: true, studyId: doomed.id, linkId: 'a'.repeat(64), sessionId: 'synthetic-participant-session', studyRevision: 1 });
    const greeting = await greetingPOST(new Request('http://localhost/api/greeting', { method: 'POST', headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ studyId: doomed.id }) }));
    expect(greeting.status).toBe(404);
    expect(provider.getInterviewProvider).not.toHaveBeenCalled();
    const canonical = await loadCanonicalStudy({ store, tokenStudyId: doomed.id, isAdmin: true });
    expect(canonical.ok).toBe(false);

    // Empty DELETE cannot start populated deletion, but its durable confirmed
    // guard can resume the operation on a reloaded page without another prompt.
    const pending = await studyDELETE(new Request(`http://localhost/api/studies/${doomed.id}`, { method: 'DELETE' }), route);
    expect(pending.status).toBe(202);
    const complete = await studyDELETE(new Request(`http://localhost/api/studies/${doomed.id}`, { method: 'DELETE' }), route);
    expect(complete.status).toBe(200);
    expect(await redis.scard(`study-interviews:${doomed.id}`)).toBe(0);
    expect(await store.studyMutationStatus!(doomed.id)).toBe('missing');
    const missing = await studyGET(new Request(`http://localhost/api/studies/${doomed.id}`), route);
    expect(missing.status).toBe(404);
  });

  it('authenticates before reading the lifecycle gate for a named study', async () => {
    const study = await retainedStudy(0);
    identity.cookies.mockResolvedValue({ get: () => undefined });
    const read = vi.spyOn(redis, 'eval');
    const denied = await getAuthorizedResearcherStudyContext(study.id, 'read');
    expect(denied.authorized).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
