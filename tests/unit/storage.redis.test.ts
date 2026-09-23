// @vitest-environment node
// Redis WorkspaceStorePort adapter mapping (ST-01). kv/link/consent I/O is
// mocked; create idempotency and the participant limiter run for real against
// recording fakes so their Redis calls can be compared with the routes'.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import type { RedisPort } from '@/lib/redisPort';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import type { StoredAggregateSynthesis, StoredStudy } from '@/types';
import type { CreateIdempotencyRecord } from '@/lib/createIdempotency';

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getHostedResearcherIdentity: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const clientFactoryMock = vi.hoisted(() => ({
  getKVClient: vi.fn(),
  getPlatformClient: vi.fn(),
}));
vi.mock('@/lib/kvClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kvClient')>()),
  ...clientFactoryMock,
}));

const kvMock = vi.hoisted(() => ({
  clearSampleWorkspaceRecords: vi.fn(),
  createStudyAtomic: vi.fn(),
  deleteStudy: vi.fn(),
  getAllInterviewsChecked: vi.fn(),
  getAllStudiesChecked: vi.fn(),
  getInterviewChecked: vi.fn(),
  getStudyAggregateChecked: vi.fn(),
  getStudyChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
  isKVAvailable: vi.fn(),
  persistCompletedInterview: vi.fn(),
  replaceStudyConfigAtomic: vi.fn(),
  saveInterview: vi.fn(),
  saveStudy: vi.fn(),
  saveStudyAggregate: vi.fn(),
  setStudyLinksEnabled: vi.fn(),
  studyKeysExist: vi.fn(),
}));
vi.mock('@/lib/kv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kv')>()),
  ...kvMock,
}));

const idempMock = vi.hoisted(() => ({
  beginCreateIdempotencyForHash: vi.fn(),
  casCreateIdempotencyStateForHash: vi.fn(),
}));
vi.mock('@/lib/createIdempotency', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/createIdempotency')>()),
  ...idempMock,
}));

const linksMock = vi.hoisted(() => ({
  createParticipantLinkRecord: vi.fn(),
  getParticipantLinkByCode: vi.fn(),
  getParticipantLinkById: vi.fn(),
  listParticipantLinksForStudy: vi.fn(),
  revokeParticipantLink: vi.fn(),
}));
vi.mock('@/lib/participantLinks', () => linksMock);

const consentMock = vi.hoisted(() => ({
  recordParticipantConsent: vi.fn(),
  verifyParticipantConsent: vi.fn(),
}));
vi.mock('@/lib/participantConsent', () => consentMock);

import { createRedisWorkspaceStore, HostedStudyOperationError } from '@/lib/storage/redis';
import { POST as createStudyRoute } from '@/app/api/studies/route';

const actualKv = await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv');
const actualIdemp = await vi.importActual<typeof import('@/lib/createIdempotency')>('@/lib/createIdempotency');

const IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';
const FINGERPRINT = 'f'.repeat(64);
const LINK_ID = 'a'.repeat(64);
const FROZEN_NOW = 1_760_000_000_000;

type Call = [string, ...unknown[]];

/** Answers the create-idempotency scripts like an empty database and records every call. */
class RecordingRedis {
  readonly calls: Call[] = [];

  async get(key: string): Promise<unknown> {
    this.calls.push(['get', key]);
    return null;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.calls.push(['eval', script, keys, args]);
    if (script === actualIdemp.BEGIN_CREATE_IDEMPOTENCY_SCRIPT) return ['oi:idemp-started', args[1]];
    return ['oi:idemp-unavailable'];
  }

  async ping(): Promise<string> {
    this.calls.push(['ping']);
    return 'PONG';
  }

  async exists(...keys: string[]): Promise<number> {
    this.calls.push(['exists', ...keys]);
    return 0;
  }

  async del(...keys: string[]): Promise<number> {
    this.calls.push(['del', ...keys]);
    return 1;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    this.calls.push(['srem', key, ...members]);
    return 1;
  }
}

function asPort(value: object): RedisPort {
  return value as unknown as RedisPort;
}

const client = asPort({ id: 'injected-client' });

function standaloneStore() {
  return createRedisWorkspaceStore(client, { researcherId: null });
}

function candidate(): StoredStudy {
  return actualIdemp.mintCreateStudy(makeStudyConfig(), FROZEN_NOW, '22222222-2222-4222-8222-222222222222');
}

function mappingRecord(study: StoredStudy, state: CreateIdempotencyRecord['state']): CreateIdempotencyRecord {
  return {
    version: 2,
    researcherId: 'standalone',
    studyId: study.id,
    createdAt: study.createdAt,
    updatedAt: study.createdAt,
    fingerprint: FINGERPRINT,
    state,
    operationId: null,
    study,
  };
}

function digest(): string {
  return actualIdemp.hashCreateIdempotencyKey('standalone', IDEMPOTENCY_KEY);
}

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'standalone');
  clientFactoryMock.getKVClient.mockImplementation(() => {
    throw new Error('the Redis store must never construct a client');
  });
  clientFactoryMock.getPlatformClient.mockImplementation(() => {
    throw new Error('the Redis store must never construct a client');
  });
  idempMock.beginCreateIdempotencyForHash.mockImplementation(actualIdemp.beginCreateIdempotencyForHash);
  idempMock.casCreateIdempotencyStateForHash.mockImplementation(actualIdemp.casCreateIdempotencyStateForHash);
  kvMock.isKVAvailable.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  expect(clientFactoryMock.getKVClient).not.toHaveBeenCalled();
  expect(clientFactoryMock.getPlatformClient).not.toHaveBeenCalled();
});

describe('create idempotency keyed by digest (ST-01)', () => {
  it('ST-01: the digest-keyed begin and created transition issue the same Redis calls as the raw-key forms', async () => {
    const study = candidate();
    const byKey = new RecordingRedis();
    const byHash = new RecordingRedis();

    const fromKey = await actualIdemp.beginCreateIdempotency({
      client: asPort(byKey),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint: FINGERPRINT,
      mintStudy: () => study,
      now: FROZEN_NOW,
    });
    const fromHash = await actualIdemp.beginCreateIdempotencyForHash({
      client: asPort(byHash),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyHash: digest(),
      fingerprint: FINGERPRINT,
      mintStudy: () => study,
      now: FROZEN_NOW,
    });
    expect(fromHash).toEqual(fromKey);
    expect(fromHash.status).toBe('started');

    await actualIdemp.casCreateIdempotencyState({
      client: asPort(byKey),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint: FINGERPRINT,
      nextState: 'created',
      operationId: null,
      now: FROZEN_NOW,
    });
    await actualIdemp.casCreateIdempotencyStateForHash({
      client: asPort(byHash),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyHash: digest(),
      fingerprint: FINGERPRINT,
      nextState: 'created',
      operationId: null,
      now: FROZEN_NOW,
    });

    expect(byHash.calls).toEqual(byKey.calls);
    expect(byHash.calls.map(call => call[0])).toEqual(['get', 'eval', 'eval']);
  });

  it('ST-01: a malformed digest is refused before any Redis call', async () => {
    const recording = new RecordingRedis();
    const begun = await actualIdemp.beginCreateIdempotencyForHash({
      client: asPort(recording),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyHash: IDEMPOTENCY_KEY,
      fingerprint: FINGERPRINT,
      mintStudy: candidate,
    });
    const cas = await actualIdemp.casCreateIdempotencyStateForHash({
      client: asPort(recording),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyHash: 'not-a-digest',
      fingerprint: FINGERPRINT,
      nextState: 'created',
    });
    expect(begun).toEqual({ status: 'unavailable' });
    expect(cas).toEqual({ status: 'unavailable' });
    expect(recording.calls).toEqual([]);
  });
});

describe('createStudy (ST-01)', () => {
  it('ST-01: issues exactly the Redis calls and create arguments of the standalone POST /api/studies route', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN_NOW);
    kvMock.isKVAvailable.mockImplementation(actualKv.isKVAvailable);
    kvMock.createStudyAtomic.mockResolvedValue('created');

    const routeRedis = new RecordingRedis();
    contextMock.getRequestContext.mockResolvedValue({
      authorized: true,
      context: {
        kvClient: asPort(routeRedis),
        geminiApiKey: 'gemini-key',
        anthropicApiKey: null,
        openaiApiKey: null,
        openrouterApiKey: null,
      },
    });
    const response = await createStudyRoute(new Request('http://localhost/api/studies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: JSON.stringify({ config: makeStudyConfig() }),
    }));
    expect(response.status).toBe(200);
    const routeBody = await response.json() as { study: StoredStudy };

    const routeBegin = routeRedis.calls[1] as [string, string, string[], string[]];
    const minted = actualIdemp.parseCreateIdempotencyRecord(routeBegin[3][1]);
    if (!minted) throw new Error('route did not mint a study');
    const routeFingerprint = routeBegin[3][4];
    expect(routeBegin[3][0]).toBe(digest());

    const storeRedis = new RecordingRedis();
    const store = createRedisWorkspaceStore(asPort(storeRedis), { researcherId: null });
    const outcome = await store.createStudy({
      idempotencyKeyDigest: digest(),
      fingerprint: routeFingerprint,
      candidate: minted.study,
    });

    expect(outcome).toEqual({ status: 'created', study: routeBody.study, replayed: false });
    expect(storeRedis.calls).toEqual(routeRedis.calls);
    expect(storeRedis.calls.map(call => call[0])).toEqual(['get', 'eval', 'ping', 'eval']);

    const [routeCreate, storeCreate] = kvMock.createStudyAtomic.mock.calls;
    expect(routeCreate[1]).toBe(routeRedis);
    expect(storeCreate[1]).toBe(storeRedis);
    expect([storeCreate[0], storeCreate[2], storeCreate[3]]).toEqual([routeCreate[0], routeCreate[2], routeCreate[3]]);
    expect(storeCreate[2]).toBe(`create:${minted.study.id}:${FROZEN_NOW}`);
    expect(storeCreate[3]).toEqual({ idempotencyHash: digest(), researcherId: 'standalone' });
  });

  it('ST-01: a created mapping replays its original study without writing', async () => {
    const original = candidate();
    idempMock.beginCreateIdempotencyForHash.mockResolvedValue({ status: 'replay', record: mappingRecord(original, 'created') });

    const outcome = await standaloneStore().createStudy({
      idempotencyKeyDigest: digest(),
      fingerprint: FINGERPRINT,
      candidate: makeStoredStudy(),
    });
    expect(outcome).toEqual({ status: 'created', study: original, replayed: true });
    expect(kvMock.isKVAvailable).not.toHaveBeenCalled();
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
    expect(idempMock.casCreateIdempotencyStateForHash).not.toHaveBeenCalled();
  });

  it('ST-01: a pending mapping re-enters the atomic create with the originally minted study', async () => {
    const original = candidate();
    idempMock.beginCreateIdempotencyForHash.mockResolvedValue({ status: 'replay', record: mappingRecord(original, 'pending') });
    idempMock.casCreateIdempotencyStateForHash.mockResolvedValue({ status: 'unavailable' });
    kvMock.createStudyAtomic.mockResolvedValue('created');

    const outcome = await standaloneStore().createStudy({
      idempotencyKeyDigest: digest(),
      fingerprint: FINGERPRINT,
      candidate: makeStoredStudy(),
    });
    expect(outcome).toEqual({ status: 'created', study: original, replayed: true });
    expect(kvMock.createStudyAtomic).toHaveBeenCalledWith(
      original,
      client,
      `create:${original.id}:${original.createdAt}`,
      { idempotencyHash: digest(), researcherId: 'standalone' },
    );
    expect(idempMock.casCreateIdempotencyStateForHash).toHaveBeenCalledWith({
      client,
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyHash: digest(),
      fingerprint: FINGERPRINT,
      nextState: 'created',
      operationId: null,
    });
  });

  it.each([
    [{ status: 'reuse' }, { status: 'key-reuse' }],
    [{ status: 'quota' }, { status: 'quota' }],
    [{ status: 'ambiguous' }, { status: 'ambiguous' }],
    [{ status: 'unavailable' }, { status: 'unavailable' }],
    [{ status: 'hold' }, { status: 'unavailable' }],
    [{ status: 'adel' }, { status: 'unavailable' }],
    [{ status: 'noacct' }, { status: 'unavailable' }],
  ])('ST-01: begin %o maps to %o without creating', async (begun, expected) => {
    idempMock.beginCreateIdempotencyForHash.mockResolvedValue(begun);
    const outcome = await standaloneStore().createStudy({
      idempotencyKeyDigest: digest(),
      fingerprint: FINGERPRINT,
      candidate: candidate(),
    });
    expect(outcome).toEqual(expected);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('ST-01: a deleted mapping reports the key as consumed', async () => {
    idempMock.beginCreateIdempotencyForHash.mockResolvedValue({ status: 'replay', record: mappingRecord(candidate(), 'deleted') });
    const outcome = await standaloneStore().createStudy({
      idempotencyKeyDigest: digest(),
      fingerprint: FINGERPRINT,
      candidate: candidate(),
    });
    expect(outcome).toEqual({ status: 'key-consumed' });
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('ST-01: a failed storage ping stops before the atomic create', async () => {
    idempMock.beginCreateIdempotencyForHash.mockResolvedValue({ status: 'started', record: mappingRecord(candidate(), 'pending') });
    kvMock.isKVAvailable.mockResolvedValue(false);
    const outcome = await standaloneStore().createStudy({
      idempotencyKeyDigest: digest(),
      fingerprint: FINGERPRINT,
      candidate: candidate(),
    });
    expect(outcome).toEqual({ status: 'unavailable' });
    expect(kvMock.isKVAvailable).toHaveBeenCalledWith(client);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it.each([
    ['ambiguous', { status: 'ambiguous' }],
    ['unavailable', { status: 'unavailable' }],
    ['conflict', { status: 'conflict' }],
    ['cancelled', { status: 'conflict' }],
  ])('ST-01: atomic create %s maps to %o and never marks the key created', async (creation, expected) => {
    idempMock.beginCreateIdempotencyForHash.mockResolvedValue({ status: 'started', record: mappingRecord(candidate(), 'pending') });
    kvMock.createStudyAtomic.mockResolvedValue(creation);
    const outcome = await standaloneStore().createStudy({
      idempotencyKeyDigest: digest(),
      fingerprint: FINGERPRINT,
      candidate: candidate(),
    });
    expect(outcome).toEqual(expected);
    expect(idempMock.casCreateIdempotencyStateForHash).not.toHaveBeenCalled();
  });

  it('ST-01: hosted stores refuse the standalone create and delete compositions without I/O', async () => {
    const hosted = createRedisWorkspaceStore(client, { researcherId: 'researcher-a' });
    await expect(hosted.createStudy({ idempotencyKeyDigest: digest(), fingerprint: FINGERPRINT, candidate: candidate() }))
      .rejects.toMatchObject({ name: 'HostedStudyOperationError', operation: 'createStudy' });
    await expect(hosted.deleteStudy({ studyId: 'study-a', now: 1 })).rejects.toBeInstanceOf(HostedStudyOperationError);
    expect(idempMock.beginCreateIdempotencyForHash).not.toHaveBeenCalled();
    expect(kvMock.deleteStudy).not.toHaveBeenCalled();
  });
});

describe('study mutations and reads (ST-01)', () => {
  it('ST-01: a config whose identity differs from the target study is refused before any Redis call', async () => {
    const study = makeStoredStudy();
    const outcome = await standaloneStore().replaceStudyConfig({
      studyId: study.id,
      expectedRevision: 1,
      config: { ...study.config, id: `${study.id}-other` },
      now: 1,
    });
    expect(outcome).toEqual({ status: 'unavailable' });
    expect(kvMock.replaceStudyConfigAtomic).not.toHaveBeenCalled();
  });

  it('ST-01: config replacement and link toggles delegate to the existing CAS scripts', async () => {
    const study = makeStoredStudy();
    kvMock.replaceStudyConfigAtomic.mockResolvedValue({ status: 'persist-guard' });
    kvMock.setStudyLinksEnabled.mockResolvedValue({ status: 'updated', study });
    const store = standaloneStore();

    expect(await store.replaceStudyConfig({ studyId: study.id, expectedRevision: 3, config: study.config, now: 1 }))
      .toEqual({ status: 'persist-guard' });
    expect(kvMock.replaceStudyConfigAtomic).toHaveBeenCalledWith(study.id, 3, study.config, client);
    expect(await store.setStudyLinksEnabled({ studyId: study.id, enabled: false, now: 1 }))
      .toEqual({ status: 'updated', study });
    expect(kvMock.setStudyLinksEnabled).toHaveBeenCalledWith(study.id, false, client);
  });

  it('ST-01: delete uses the fixed standalone marker and passes the result through', async () => {
    kvMock.deleteStudy.mockResolvedValue({ status: 'still-pending', success: false, code: 'STUDY_PERSIST_PENDING' });
    const outcome = await standaloneStore().deleteStudy({ studyId: 'study-a', now: 1 });
    expect(outcome).toEqual({ status: 'still-pending', success: false, code: 'STUDY_PERSIST_PENDING' });
    expect(kvMock.deleteStudy).toHaveBeenCalledWith('study-a', client, 'delete:study-a:0');
  });

  it('ST-01: checked reads pass the injected client and the caller maximum', async () => {
    const store = standaloneStore();
    kvMock.getStudyChecked.mockResolvedValue({ status: 'unavailable' });
    kvMock.getAllStudiesChecked.mockResolvedValue({ status: 'too-large', count: 9, maximum: 5 });
    kvMock.getInterviewChecked.mockResolvedValue({ status: 'not-found' });
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [] });
    kvMock.getAllInterviewsChecked.mockResolvedValue({ status: 'unavailable' });
    kvMock.getStudyAggregateChecked.mockResolvedValue({ status: 'not-found' });

    expect(await store.getStudy('study-a')).toEqual({ status: 'unavailable' });
    expect(kvMock.getStudyChecked).toHaveBeenCalledWith('study-a', client);
    expect(await store.listStudies(5)).toEqual({ status: 'too-large', count: 9, maximum: 5 });
    expect(kvMock.getAllStudiesChecked).toHaveBeenCalledWith(client, 5);
    expect(await store.getInterview('session-a')).toEqual({ status: 'not-found' });
    expect(kvMock.getInterviewChecked).toHaveBeenCalledWith('session-a', client);
    expect(await store.listInterviews({ scope: 'study', studyId: 'study-a', maximum: 1_000 }))
      .toEqual({ status: 'ok', items: [] });
    expect(kvMock.getStudyInterviewsChecked).toHaveBeenCalledWith('study-a', client, 1_000);
    expect(await store.listInterviews({ scope: 'all', maximum: 500 })).toEqual({ status: 'unavailable' });
    expect(kvMock.getAllInterviewsChecked).toHaveBeenCalledWith(client, 500);
    expect(await store.getAggregate('study-a')).toEqual({ status: 'not-found' });
    expect(kvMock.getStudyAggregateChecked).toHaveBeenCalledWith('study-a', client);
  });

  it('ST-01: aggregate saves keep the existing latest-value result vocabulary', async () => {
    kvMock.saveStudyAggregate.mockResolvedValue('too-large');
    const aggregate = { studyId: 'study-a' } as StoredAggregateSynthesis;
    expect(await standaloneStore().saveAggregate(aggregate)).toBe('too-large');
    expect(kvMock.saveStudyAggregate).toHaveBeenCalledWith(aggregate, client);
  });

  it('ST-01: readiness is the storage ping', async () => {
    const store = standaloneStore();
    expect(await store.readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    kvMock.isKVAvailable.mockResolvedValue(false);
    expect(await store.readiness()).toEqual({ status: 'unavailable' });
    expect(kvMock.isKVAvailable).toHaveBeenCalledWith(client);
  });
});

describe('participant links (ST-01)', () => {
  const link = {
    id: LINK_ID,
    version: 1 as const,
    studyId: 'study-a',
    studyRevision: 2,
    researcherId: null,
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
  };

  it('ST-01: creation passes the standalone authority and injected client; any other result fails closed as unavailable', async () => {
    const store = standaloneStore();
    linksMock.createParticipantLinkRecord.mockResolvedValueOnce({ status: 'created', code: 'c'.repeat(43), link });
    expect(await store.createParticipantLink({ studyId: 'study-a', studyRevision: 2, expiresAt: 99, now: 1 }))
      .toEqual({ status: 'created', code: 'c'.repeat(43), link });
    expect(linksMock.createParticipantLinkRecord).toHaveBeenCalledWith({
      studyId: 'study-a',
      studyRevision: 2,
      researcherId: null,
      expiresAt: 99,
      standaloneClient: client,
    });

    for (const [result, expected] of [
      [{ status: 'quota-exceeded' }, { status: 'quota-exceeded' }],
      [{ status: 'ambiguous' }, { status: 'ambiguous' }],
      [{ status: 'unavailable' }, { status: 'unavailable' }],
      [{ status: 'live', phase: 'pending' }, { status: 'unavailable' }],
      [{ status: 'deny' }, { status: 'unavailable' }],
      [{ status: 'invalid' }, { status: 'unavailable' }],
    ] as const) {
      linksMock.createParticipantLinkRecord.mockResolvedValueOnce(result);
      expect(await store.createParticipantLink({ studyId: 'study-a', studyRevision: 2, expiresAt: null, now: 1 }))
        .toEqual(expected);
    }
  });

  it('ST-01: code and id resolution keep found/not-found/expired/revoked and collapse the rest to unavailable', async () => {
    const store = standaloneStore();
    for (const [result, expected] of [
      [{ status: 'found', link }, { status: 'found', link }],
      [{ status: 'not-found' }, { status: 'not-found' }],
      [{ status: 'expired' }, { status: 'expired' }],
      [{ status: 'revoked' }, { status: 'revoked' }],
      [{ status: 'unavailable' }, { status: 'unavailable' }],
      [{ status: 'ambiguous' }, { status: 'unavailable' }],
      [{ status: 'notfound' }, { status: 'unavailable' }],
    ] as const) {
      linksMock.getParticipantLinkByCode.mockResolvedValueOnce(result);
      linksMock.getParticipantLinkById.mockResolvedValueOnce(result);
      expect(await store.resolveParticipantLinkByCode({ code: 'code', now: 1, purpose: 'exchange' })).toEqual(expected);
      expect(await store.getParticipantLinkById({ linkId: LINK_ID, now: 1 })).toEqual(expected);
    }
    expect(linksMock.getParticipantLinkByCode).toHaveBeenCalledWith('code', client);
    expect(linksMock.getParticipantLinkById).toHaveBeenCalledWith(LINK_ID, client);
  });

  it('ST-01: listing passes the maximum; any other result fails closed as unavailable', async () => {
    const store = standaloneStore();
    const metadata = [{ id: LINK_ID, studyRevision: 2, createdAt: 1, expiresAt: null, revokedAt: null }];
    linksMock.listParticipantLinksForStudy.mockResolvedValueOnce({ status: 'ok', links: metadata, truncated: true });
    expect(await store.listParticipantLinks({ studyId: 'study-a', maximum: 10, now: 1 }))
      .toEqual({ status: 'ok', links: metadata, truncated: true });
    expect(linksMock.listParticipantLinksForStudy).toHaveBeenCalledWith({
      studyId: 'study-a',
      researcherId: null,
      standaloneClient: client,
      maximum: 10,
    });
    linksMock.listParticipantLinksForStudy.mockResolvedValueOnce({ status: 'ambiguous' });
    expect(await store.listParticipantLinks({ studyId: 'study-a', maximum: 10, now: 1 })).toEqual({ status: 'unavailable' });
  });

  it('ST-01: revocation keeps its outcomes; any other result fails closed as unavailable', async () => {
    const store = standaloneStore();
    for (const [result, expected] of [
      [{ status: 'revoked', revokedAt: 7 }, { status: 'revoked', revokedAt: 7 }],
      [{ status: 'already-revoked' }, { status: 'already-revoked' }],
      [{ status: 'not-found' }, { status: 'not-found' }],
      [{ status: 'owner-conflict' }, { status: 'owner-conflict' }],
      [{ status: 'ambiguous' }, { status: 'ambiguous' }],
      [{ status: 'unavailable' }, { status: 'unavailable' }],
      [{ status: 'hold' }, { status: 'unavailable' }],
    ] as const) {
      linksMock.revokeParticipantLink.mockResolvedValueOnce(result);
      expect(await store.revokeParticipantLink({ studyId: 'study-a', linkId: LINK_ID, now: 1 })).toEqual(expected);
    }
    expect(linksMock.revokeParticipantLink).toHaveBeenCalledWith({
      linkId: LINK_ID,
      studyId: 'study-a',
      researcherId: null,
      standaloneClient: client,
    });
  });

  it('ST-01: a hosted store refuses every link operation without I/O, so hosted authority denials never collapse to a retryable 503', async () => {
    const hosted = createRedisWorkspaceStore(client, { researcherId: 'researcher-a' });
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['createParticipantLink', () => hosted.createParticipantLink({ studyId: 'study-a', studyRevision: 1, expiresAt: null, now: 1 })],
      ['resolveParticipantLinkByCode', () => hosted.resolveParticipantLinkByCode({ code: 'c'.repeat(43), now: 1, purpose: 'exchange' })],
      ['getParticipantLinkById', () => hosted.getParticipantLinkById({ linkId: LINK_ID, now: 1 })],
      ['listParticipantLinks', () => hosted.listParticipantLinks({ studyId: 'study-a', maximum: 10, now: 1 })],
      ['revokeParticipantLink', () => hosted.revokeParticipantLink({ studyId: 'study-a', linkId: LINK_ID, now: 1 })],
    ];
    for (const [operation, attempt] of attempts) {
      const refusal = await attempt().then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(HostedStudyOperationError);
      expect(refusal).toMatchObject({ operation });
    }
    for (const mock of Object.values(linksMock)) expect(mock).not.toHaveBeenCalled();
  });
});

describe('consent and admission (ST-01, ST-06)', () => {
  it('ST-01: consent record and verify delegate with the full binding', async () => {
    const binding = { participantSessionId: 'session-aaaaaaaaaaaa', studyId: 'study-a', studyRevision: 2, consentText: 'Consent.' };
    consentMock.recordParticipantConsent.mockResolvedValue({ status: 'conflict' });
    consentMock.verifyParticipantConsent.mockResolvedValue({ status: 'missing' });
    const store = standaloneStore();
    expect(await store.recordConsent({ ...binding, now: 1 })).toEqual({ status: 'conflict' });
    expect(consentMock.recordParticipantConsent).toHaveBeenCalledWith(binding, client);
    expect(await store.verifyConsent({ ...binding, now: 1 })).toEqual({ status: 'missing' });
    expect(consentMock.verifyParticipantConsent).toHaveBeenCalledWith(binding, client);
  });

  const counters = [
    { key: 'rate-limit:greeting:session:600:s', maximum: 3, windowSeconds: 600 },
    { key: 'rate-limit:greeting:client:60:c', maximum: 20, windowSeconds: 60 },
  ];

  it('ST-06: admission runs the existing limiter script on the injected client', async () => {
    const evalMock = vi.fn().mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, -2]);
    const store = createRedisWorkspaceStore(asPort({ eval: evalMock }), { researcherId: null });

    expect(await store.admitParticipantRequest({ operation: 'greeting', counters, now: 1 })).toEqual({ status: 'admitted' });
    expect(await store.admitParticipantRequest({ operation: 'greeting', counters, now: 1 }))
      .toEqual({ status: 'limited', rejectedIndex: 1, retryAfterSeconds: 60 });
    expect(evalMock).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[i])"),
      counters.map(counter => counter.key),
      ['3', '600', '20', '60'],
    );
  });

  it('ST-06: a limiter outage or malformed reply is unavailable, never an admission', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const evalMock = vi.fn()
      .mockRejectedValueOnce(new RedisCommitAmbiguousError('may-have-committed'))
      .mockResolvedValueOnce({ allowed: true });
    const store = createRedisWorkspaceStore(asPort({ eval: evalMock }), { researcherId: null });
    expect(await store.admitParticipantRequest({ operation: 'interview', counters, now: 1 })).toEqual({ status: 'unavailable' });
    expect(await store.admitParticipantRequest({ operation: 'interview', counters, now: 1 })).toEqual({ status: 'unavailable' });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('completion (ST-01)', () => {
  it('ST-01: completion delegates the frozen plan and identity and ignores durable-only inputs', async () => {
    kvMock.persistCompletedInterview.mockResolvedValue({ status: 'rate-limited' });
    const interview = makeStoredInterview({ id: 'session-a', studyId: 'study-a' });
    const ratePlan = [{ key: 'interview-rate:abc:0', maximum: 2, windowSeconds: 86_400, windowStart: 0 }];
    const outcome = await standaloneStore().persistCompletedInterview({
      interview,
      fingerprint: FINGERPRINT,
      expectedStudyRevision: 4,
      allowDisabledLinks: false,
      ratePlan,
      identity: { participantSessionId: 'session-a', linkId: LINK_ID },
      consent: { participantSessionId: 'session-a', studyId: 'study-a', studyRevision: 4, consentText: 'c' },
      initialAnalysis: {
        inputSchemaVersion: 1,
        studyConfig: makeStudyConfig(),
        studyRevision: 4,
        requestedProvider: 'gemini',
        requestedModel: 'gemini-2.5-flash',
      },
      now: 1,
    });
    expect(outcome).toEqual({ status: 'rate-limited' });
    expect(kvMock.persistCompletedInterview).toHaveBeenCalledWith(
      interview,
      FINGERPRINT,
      {
        allowDisabledLinks: false,
        expectedStudyRevision: 4,
        rateLimits: ratePlan,
        identity: { participantSessionId: 'session-a', linkId: LINK_ID },
      },
      client,
    );
  });
});

describe('sample workspace (ST-07)', () => {
  const study = makeStoredStudy({ id: 'demo-study-a' });
  const interviews = [
    makeStoredInterview({ id: 'interview-demo-a', studyId: 'demo-study-a' }),
    makeStoredInterview({ id: 'interview-demo-b', studyId: 'demo-study-a' }),
  ];

  it('ST-07: seed pings, refuses a present study key, then writes studies and interviews in order', async () => {
    const store = standaloneStore();
    kvMock.studyKeysExist.mockResolvedValueOnce('present');
    expect(await store.seedSampleWorkspace({ studies: [study], interviews, now: 1 })).toEqual({ status: 'already-seeded' });
    expect(kvMock.studyKeysExist).toHaveBeenCalledWith(['demo-study-a'], client);
    expect(kvMock.saveStudy).not.toHaveBeenCalled();

    const order: string[] = [];
    kvMock.studyKeysExist.mockResolvedValueOnce('absent');
    kvMock.saveStudy.mockImplementation(async (value: StoredStudy) => {
      order.push(value.id);
      return true;
    });
    kvMock.saveInterview.mockImplementation(async (value: { id: string }) => {
      order.push(value.id);
      return value.id !== 'interview-demo-b';
    });
    expect(await store.seedSampleWorkspace({ studies: [study], interviews, now: 1 }))
      .toEqual({ status: 'seeded', studiesSeeded: 1, interviewsSeeded: 1 });
    expect(order).toEqual(['demo-study-a', 'interview-demo-a', 'interview-demo-b']);
    expect(kvMock.saveStudy).toHaveBeenCalledWith(study, client);
    expect(kvMock.saveInterview).toHaveBeenCalledWith(interviews[0], client);
  });

  it('ST-07: seed and clear report unavailable storage before any write', async () => {
    const store = standaloneStore();
    kvMock.isKVAvailable.mockResolvedValue(false);
    expect(await store.seedSampleWorkspace({ studies: [study], interviews, now: 1 })).toEqual({ status: 'unavailable' });
    expect(await store.clearSampleWorkspace({ studyIds: [study.id], interviewIds: [] })).toEqual({ status: 'unavailable' });
    expect(kvMock.studyKeysExist).not.toHaveBeenCalled();
    expect(kvMock.clearSampleWorkspaceRecords).not.toHaveBeenCalled();

    kvMock.isKVAvailable.mockResolvedValue(true);
    kvMock.studyKeysExist.mockResolvedValue('unavailable');
    expect(await store.seedSampleWorkspace({ studies: [study], interviews, now: 1 })).toEqual({ status: 'unavailable' });
    expect(kvMock.saveStudy).not.toHaveBeenCalled();
  });

  it('ST-07: clear delegates the sample set to the kv clear sequence', async () => {
    kvMock.clearSampleWorkspaceRecords.mockResolvedValue({ status: 'cleared', studiesDeleted: 1, interviewsDeleted: 2 });
    const input = { studyIds: ['demo-study-a'], interviewIds: ['interview-demo-a', 'interview-demo-b'] };
    expect(await standaloneStore().clearSampleWorkspace(input))
      .toEqual({ status: 'cleared', studiesDeleted: 1, interviewsDeleted: 2 });
    expect(kvMock.clearSampleWorkspaceRecords).toHaveBeenCalledWith(input, client);
  });

  it('ST-07: the kv clear sequence keeps the route deletions and also removes the sample aggregate', async () => {
    const recording = new RecordingRedis();
    const result = await actualKv.clearSampleWorkspaceRecords(
      { studyIds: ['demo-study-a'], interviewIds: ['interview-demo-a', 'interview-demo-b'] },
      asPort(recording),
    );
    expect(result).toEqual({ status: 'cleared', studiesDeleted: 1, interviewsDeleted: 2 });
    expect(recording.calls).toEqual([
      ['del', 'study:demo-study-a'],
      ['srem', 'all-studies', 'demo-study-a'],
      ['del', 'study-aggregate:demo-study-a'],
      ['del', 'interview:interview-demo-a'],
      ['srem', 'study-interviews:demo-study-a', 'interview-demo-a'],
      ['srem', 'all-interviews', 'interview-demo-a'],
      ['del', 'interview:interview-demo-b'],
      ['srem', 'study-interviews:demo-study-a', 'interview-demo-b'],
      ['srem', 'all-interviews', 'interview-demo-b'],
    ]);
  });

  it('ST-07: a clear interrupted after its first write is ambiguous; before any write it is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = (failAt: number) => {
      let count = 0;
      const step = async () => {
        count += 1;
        if (count === failAt) throw new Error('connection reset');
        return 1;
      };
      return asPort({ del: step, srem: step });
    };
    const input = { studyIds: ['demo-study-a'], interviewIds: ['interview-demo-a'] };
    expect(await actualKv.clearSampleWorkspaceRecords(input, failing(1))).toEqual({ status: 'unavailable' });
    expect(await actualKv.clearSampleWorkspaceRecords(input, failing(2))).toEqual({ status: 'ambiguous' });
    expect(await actualKv.clearSampleWorkspaceRecords(input, asPort({
      del: async () => { throw new RedisCommitAmbiguousError('may-have-committed'); },
    }))).toEqual({ status: 'ambiguous' });
  });

  it('ST-07: the collision check is one EXISTS over the sample study keys', async () => {
    const recording = new RecordingRedis();
    expect(await actualKv.studyKeysExist(['demo-a', 'demo-b'], asPort(recording))).toBe('absent');
    expect(recording.calls).toEqual([['exists', 'study:demo-a', 'study:demo-b']]);
    expect(await actualKv.studyKeysExist(['demo-a'], asPort({ exists: async () => 1 }))).toBe('present');
    expect(await actualKv.studyKeysExist([], asPort(recording))).toBe('absent');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await actualKv.studyKeysExist(['demo-a'], asPort({ exists: async () => { throw new Error('down'); } })))
      .toBe('unavailable');
  });
});
