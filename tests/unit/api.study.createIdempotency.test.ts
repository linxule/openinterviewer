import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig, makeStoredStudy } from '../fixtures/models';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import type { RedisPort } from '@/lib/redisPort';
import {
  BEGIN_CREATE_IDEMPOTENCY_SCRIPT,
  beginCreateIdempotency,
  casCreateIdempotencyState,
  canonicalCreateJson,
  createFingerprint,
  createIdempotencyKeys,
  encodeCreateIdempotencyRecord,
  hashCreateIdempotencyKey,
  mintCreateStudy,
  parseCreateIdempotencyRecord,
  parseIdempotencyKey,
  type CreateIdempotencyRecord,
} from '@/lib/createIdempotency';
import { parseIdempotencyResult } from '@/lib/wire/parse';
import { buildSchemaLineageValue } from '@/lib/platformSchema';

const IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';
const OTHER_KEY = '22222222-2222-4222-8222-222222222222';
const RESEARCHER = 'researcher-a';

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getHostedResearcherIdentity: vi.fn(),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  createStudyAtomic: vi.fn(),
  getAllStudies: vi.fn(),
  isKVAvailable: vi.fn(),
  studyOperationMarkerId: vi.fn((id: string, createdAt: number) => `${id}:${createdAt}`),
}));
vi.mock('@/lib/kv', () => kvMock);

const STORAGE_ID = 'a'.repeat(64);
const OP_NONCE = 'ab'.repeat(16);

const platformMock = vi.hoisted(() => ({
  beginCreateStudyOperationV2: vi.fn(),
  consumePlatformRateLimit: vi.fn(),
  getResearcherByIdChecked: vi.fn(),
  loadResearcherStorageBinding: vi.fn(),
  publishStudyOperationV2: vi.fn(),
  resolveStudyOperationV2: vi.fn(),
}));
vi.mock('@/lib/platformDb', () => platformMock);

const modeMock = vi.hoisted(() => ({ isHostedMode: vi.fn() }));
vi.mock('@/lib/mode', () => modeMock);

const platformClientMock = vi.hoisted(() => ({ current: null as RedisPort | null }));
vi.mock('@/lib/kvClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kvClient')>('@/lib/kvClient');
  return {
    ...actual,
    getPlatformClient: () => {
      if (!platformClientMock.current) throw new Error('platform client missing');
      return platformClientMock.current;
    },
  };
});

import { POST } from '@/app/api/studies/route';

class MemoryIdempRedis {
  readonly strings = new Map<string, string>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly hashes = new Map<string, Map<string, string>>();
  forcedEval: unknown | undefined;
  evalCalls = 0;
  createdWrites = 0;

  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? this.strings.get(key)! : null;
  }

  async set(
    key: string,
    value: string,
    opts?: { nx?: boolean; ex?: number },
  ): Promise<string | null> {
    if (opts?.nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    this.createdWrites += 1;
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) || this.hashes.has(key) || this.zsets.has(key) ? 1 : 0;
  }

  async hexists(key: string, field: string): Promise<number> {
    return this.hashes.get(key)?.has(field) ? 1 : 0;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.zsets.get(key) ?? new Map<string, number>();
    const added = set.has(member) ? 0 : 1;
    set.set(member, score);
    this.zsets.set(key, set);
    return added;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.evalCalls += 1;
    if (this.forcedEval !== undefined) return this.forcedEval;
    if (script.includes('oi:idemp-started')) {
      return this.runBegin(keys, args);
    }
    return this.runCas(keys, args);
  }

  putResearcher(key: string) {
    this.strings.set('schema-lineage', buildSchemaLineageValue(1));
    this.strings.set(key, 'oi:account:{"id":"researcher-a"}');
  }

  putPoisonedAccount(key: string, value: string) {
    this.strings.set('schema-lineage', buildSchemaLineageValue(1));
    this.strings.set(key, value);
  }

  putJournal(key: string, researcherId: string) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    hash.set(researcherId, '1');
    this.hashes.set(key, hash);
  }

  fillIndex(key: string, count: number) {
    const set = new Map<string, number>();
    for (let i = 0; i < count; i += 1) set.set(`h${i}`, i);
    this.zsets.set(key, set);
  }

  private runBegin(keys: string[], args: string[]): unknown {
    const hosted = keys.length === 4;
    if (keys.length !== 2 && !hosted) return ['oi:idemp-unavailable'];
    if (hosted) {
      if (this.hashes.get(keys[2])?.has(args[5])) return ['oi:idemp-adel'];
      const raw = this.strings.get(keys[3]);
      if (!raw?.startsWith('oi:account:')) return ['oi:idemp-noacct'];
      try {
        const account = JSON.parse(raw.slice('oi:account:'.length)) as { id?: string };
        if (account.id !== args[5]) return ['oi:idemp-noacct'];
      } catch {
        return ['oi:idemp-noacct'];
      }
    }
    const existing = this.strings.get(keys[0]);
    if (existing) return this.classify(existing, args[4]);
    if ((this.zsets.get(keys[1])?.size ?? 0) >= Number(args[3])) return ['oi:idemp-quota'];
    if (this.strings.has(keys[0])) return this.classify(this.strings.get(keys[0])!, args[4]);
    this.strings.set(keys[0], args[1]);
    const zset = this.zsets.get(keys[1]) ?? new Map<string, number>();
    zset.set(args[0], Number(args[2]));
    this.zsets.set(keys[1], zset);
    return ['oi:idemp-started', args[1]];
  }

  private runCas(keys: string[], args: string[]): unknown {
    const existing = this.strings.get(keys[0]);
    const record = existing ? parseCreateIdempotencyRecord(existing) : null;
    if (!record) return ['oi:idemp-unavailable'];
    if (record.fingerprint !== args[0]) return ['oi:idemp-reuse'];
    const nextState = args[1] as CreateIdempotencyRecord['state'];
    const now = Number(args[2]);
    const opId = args[3] === '' ? null : args[3];
    if (record.state === nextState) {
      if (nextState === 'pending' && opId && !record.operationId) {
        const next = { ...record, operationId: opId, updatedAt: now };
        const encoded = encodeCreateIdempotencyRecord(next);
        this.strings.set(keys[0], encoded);
        return ['oi:idemp-replay', encoded];
      }
      return ['oi:idemp-replay', existing];
    }
    if (nextState === 'created' && record.state !== 'pending') return ['oi:idemp-unavailable'];
    if (nextState === 'deleted' && record.state !== 'pending' && record.state !== 'created') {
      return ['oi:idemp-unavailable'];
    }
    if (nextState === 'pending') return ['oi:idemp-unavailable'];
    const next = {
      ...record,
      state: nextState,
      updatedAt: now,
      operationId: opId ?? record.operationId,
    };
    const encoded = encodeCreateIdempotencyRecord(next);
    this.strings.set(keys[0], encoded);
    return ['oi:idemp-replay', encoded];
  }

  private classify(existing: string, fingerprint: string): unknown {
    const record = parseCreateIdempotencyRecord(existing);
    if (!record) return ['oi:idemp-unavailable'];
    if (record.fingerprint !== fingerprint) return ['oi:idemp-reuse'];
    return ['oi:idemp-replay', existing];
  }
}

function asPort(memory: MemoryIdempRedis): RedisPort {
  return memory as unknown as RedisPort;
}

function request(options?: {
  key?: string | null;
  config?: ReturnType<typeof makeStudyConfig>;
}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options?.key !== null) headers.set('Idempotency-Key', options?.key ?? IDEMPOTENCY_KEY);
  return new Request('http://localhost/api/studies', {
    method: 'POST',
    headers,
    body: JSON.stringify({ config: options?.config ?? makeStudyConfig() }),
  });
}

function seedHostedContext(kvClient: RedisPort) {
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: {
      kvClient,
      geminiApiKey: 'gemini-key',
      anthropicApiKey: null,
      openaiApiKey: null,
      openrouterApiKey: null,
    },
    researcherId: RESEARCHER,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const memory = new MemoryIdempRedis();
  platformClientMock.current = asPort(memory);
  seedHostedContext(asPort(new MemoryIdempRedis()));
  contextMock.getHostedResearcherIdentity.mockResolvedValue({
    authorized: true,
    researcherId: RESEARCHER,
  });
  platformMock.getResearcherByIdChecked.mockResolvedValue({
    status: 'found',
    researcher: {
      id: RESEARCHER,
      onboardingComplete: true,
      encryptedRedisUrl: 'enc-url',
      encryptedRedisToken: 'enc-token',
      encryptedGeminiApiKey: 'enc-gemini',
      encryptedAnthropicApiKey: null,
      encryptedOpenAiApiKey: null,
      encryptedOpenRouterApiKey: null,
    },
  });
  kvMock.isKVAvailable.mockResolvedValue(true);
  kvMock.createStudyAtomic.mockResolvedValue('created');
  platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'allowed', remaining: 99 });
  platformMock.loadResearcherStorageBinding.mockResolvedValue({
    status: 'ok',
    binding: {
      version: 2,
      researcherId: RESEARCHER,
      storageId: STORAGE_ID,
      originHash: 'b'.repeat(64),
      credentialRevision: 1,
      bindingEpoch: 1,
      cipherSnapshot: 'cipher',
    },
  });
  platformMock.beginCreateStudyOperationV2.mockImplementation((input: { studyId: string; researcherId: string }) => ({
    status: 'started',
    operation: {
      version: 2,
      id: `create:${input.studyId}:1`,
      kind: 'create',
      phase: 'pending',
      researcherId: input.researcherId,
      studyId: input.studyId,
      generation: 1,
      opNonce: OP_NONCE,
      createdAt: 1,
      updatedAt: 1,
      idempotencyHash: 'f'.repeat(64),
      fingerprint: 'e'.repeat(64),
      frozenReceipt: null,
    },
  }));
  platformMock.resolveStudyOperationV2.mockResolvedValue({
    status: 'publishing',
    operation: { phase: 'publishing', frozenReceipt: { resolution: 'create-complete', createdAt: 1 } },
  });
  platformMock.publishStudyOperationV2.mockResolvedValue({ status: 'published', zaddDelta: 1 });
  modeMock.isHostedMode.mockReturnValue(true);
});

describe('create idempotency helpers', () => {
  it('hashes the domain-separated preimage and fingerprints canonical config', () => {
    const config = makeStudyConfig({ name: 'Alpha', description: 'z' });
    const again = makeStudyConfig({
      ...config,
      id: 'other-id',
      createdAt: 99,
      name: 'Alpha',
    });
    expect(hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY))
      .not.toBe(hashCreateIdempotencyKey('standalone', IDEMPOTENCY_KEY));
    expect(createFingerprint(config)).toBe(createFingerprint(again));
    const canonical = JSON.parse(canonicalCreateJson(config)) as Record<string, unknown>;
    expect(canonical).not.toHaveProperty('id');
    expect(canonical).not.toHaveProperty('createdAt');
    expect((canonical.profileSchema as Array<{ id: string }>)[0].id).toBe('role');
    expect(parseIdempotencyKey('not-a-uuid')).toBeNull();
    expect(parseIdempotencyKey(IDEMPOTENCY_KEY)).toBe(IDEMPOTENCY_KEY);
  });

  it('decodes closed idemp tags and rejects malformed wire', () => {
    expect(parseIdempotencyResult(['oi:idemp-quota'])).toEqual({ status: 'ok', value: { outcome: 'quota' } });
    expect(parseIdempotencyResult(['oi:idemp-unavailable'])).toEqual({ status: 'unavailable' });
    expect(parseIdempotencyResult(['oi:idemp-replay'])).toEqual({ status: 'unavailable' });
    expect(parseIdempotencyResult(['oi:idemp-started', ''])).toEqual({ status: 'unavailable' });
    expect(parseIdempotencyResult(['oi:begin-started', 'x'])).toEqual({ status: 'unavailable' });
    expect(parseIdempotencyResult({ tag: 'oi:idemp-quota' })).toEqual({ status: 'unavailable' });
  });
});

describe('beginCreateIdempotency mapping', () => {
  it('replays the same key and fingerprint without reminting', async () => {
    const memory = new MemoryIdempRedis();
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY));
    memory.putResearcher(keys.researcher!);
    const config = makeStudyConfig();
    const fingerprint = createFingerprint(config);
    let mints = 0;
    const first = await beginCreateIdempotency({
      client: asPort(memory),
      mode: 'hosted',
      researcherId: RESEARCHER,
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint,
      mintStudy: () => {
        mints += 1;
        return mintCreateStudy(config, 10, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      },
    });
    const second = await beginCreateIdempotency({
      client: asPort(memory),
      mode: 'hosted',
      researcherId: RESEARCHER,
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint,
      mintStudy: () => {
        mints += 1;
        return mintCreateStudy(config, 99, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      },
    });
    expect(first.status).toBe('started');
    expect(second.status).toBe('replay');
    if (first.status !== 'started' || second.status !== 'replay') throw new Error('expected start/replay');
    expect(second.record.studyId).toBe(first.record.studyId);
    expect(mints).toBe(1);
    expect(memory.evalCalls).toBe(1);
    expect(BEGIN_CREATE_IDEMPOTENCY_SCRIPT).toContain("return {'oi:idemp-started', ARGV[2]}");
  });

  it('returns reuse when the same key carries a different fingerprint', async () => {
    const memory = new MemoryIdempRedis();
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY));
    memory.putResearcher(keys.researcher!);
    const firstConfig = makeStudyConfig({ name: 'One' });
    const secondConfig = makeStudyConfig({ name: 'Two' });
    await beginCreateIdempotency({
      client: asPort(memory),
      mode: 'hosted',
      researcherId: RESEARCHER,
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint: createFingerprint(firstConfig),
      mintStudy: () => mintCreateStudy(firstConfig),
    });
    const reused = await beginCreateIdempotency({
      client: asPort(memory),
      mode: 'hosted',
      researcherId: RESEARCHER,
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint: createFingerprint(secondConfig),
      mintStudy: () => mintCreateStudy(secondConfig),
    });
    expect(reused).toEqual({ status: 'reuse' });
  });

  it('surfaces pending, created, and deleted mapping states', async () => {
    const memory = new MemoryIdempRedis();
    const keys = createIdempotencyKeys('standalone', 'standalone', hashCreateIdempotencyKey('standalone', IDEMPOTENCY_KEY));
    const config = makeStudyConfig();
    const fingerprint = createFingerprint(config);
    const started = await beginCreateIdempotency({
      client: asPort(memory),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint,
      mintStudy: () => mintCreateStudy(config),
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') throw new Error('expected started');
    expect(started.record.state).toBe('pending');

    const created = await casCreateIdempotencyState({
      client: asPort(memory),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint,
      nextState: 'created',
    });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') throw new Error('expected created');
    expect(created.record.state).toBe('created');

    const deleted = await casCreateIdempotencyState({
      client: asPort(memory),
      mode: 'standalone',
      researcherId: 'standalone',
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint,
      nextState: 'deleted',
    });
    expect(deleted.status).toBe('ok');
    if (deleted.status !== 'ok') throw new Error('expected deleted');
    expect(deleted.record.state).toBe('deleted');
    expect(parseCreateIdempotencyRecord(await memory.get(keys.mapping))?.state).toBe('deleted');
  });

  it('decodes quota and closed-wire unavailable without a second write', async () => {
    const memory = new MemoryIdempRedis();
    const hash = hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY);
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hash);
    memory.putResearcher(keys.researcher!);
    memory.fillIndex(keys.index, 100);
    const quota = await beginCreateIdempotency({
      client: asPort(memory),
      mode: 'hosted',
      researcherId: RESEARCHER,
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint: createFingerprint(makeStudyConfig()),
      mintStudy: () => mintCreateStudy(makeStudyConfig()),
    });
    expect(quota).toEqual({ status: 'quota' });
    expect(memory.strings.has(keys.mapping)).toBe(false);

    memory.forcedEval = ['oi:idemp-unavailable'];
    const unavailable = await beginCreateIdempotency({
      client: asPort(memory),
      mode: 'hosted',
      researcherId: RESEARCHER,
      idempotencyKey: OTHER_KEY,
      fingerprint: createFingerprint(makeStudyConfig()),
      mintStudy: () => mintCreateStudy(makeStudyConfig()),
    });
    expect(unavailable).toEqual({ status: 'unavailable' });
  });

  it('classifies response-loss after send as ambiguous', async () => {
    const memory = new MemoryIdempRedis();
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY));
    memory.putResearcher(keys.researcher!);
    memory.eval = async () => {
      throw new RedisCommitAmbiguousError('may-have-committed');
    };
    const result = await beginCreateIdempotency({
      client: asPort(memory),
      mode: 'hosted',
      researcherId: RESEARCHER,
      idempotencyKey: IDEMPOTENCY_KEY,
      fingerprint: createFingerprint(makeStudyConfig()),
      mintStudy: () => mintCreateStudy(makeStudyConfig()),
    });
    expect(result).toEqual({ status: 'ambiguous' });
  });
});

describe('POST /api/studies idempotency', () => {
  it('rejects a missing or invalid Idempotency-Key after provider gates', async () => {
    const missing = await POST(request({ key: null }));
    expect(missing.status).toBe(400);
    const invalid = await POST(request({ key: 'not-a-uuid' }));
    expect(invalid.status).toBe(400);
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('returns 409 reuse for a different fingerprint on the same key', async () => {
    const memory = new MemoryIdempRedis();
    const hash = hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY);
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hash);
    memory.putResearcher(keys.researcher!);
    platformClientMock.current = asPort(memory);

    const firstConfig = makeStudyConfig({ name: 'First intent' });
    const first = await POST(request({ config: firstConfig }));
    expect(first.status).toBe(200);
    expect(kvMock.createStudyAtomic).toHaveBeenCalledTimes(1);

    const second = await POST(request({ config: makeStudyConfig({ name: 'Other intent' }) }));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: 'IDEMPOTENCY_KEY_REUSE' });
    expect(kvMock.createStudyAtomic).toHaveBeenCalledTimes(1);
  });

  it('replays created studies at 200 and never creates a duplicate', async () => {
    const memory = new MemoryIdempRedis();
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY));
    memory.putResearcher(keys.researcher!);
    platformClientMock.current = asPort(memory);
    const config = makeStudyConfig({ name: 'Stable' });

    const first = await POST(request({ config }));
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    const second = await POST(request({ config }));
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody.study.id).toBe(firstBody.study.id);
    expect(kvMock.createStudyAtomic).toHaveBeenCalledTimes(1);
    expect(platformMock.beginCreateStudyOperationV2).toHaveBeenCalledTimes(1);
    expect(platformMock.beginCreateStudyOperationV2.mock.calls[0][0]).toEqual(expect.objectContaining({
      studyId: firstBody.study.id,
      researcherId: RESEARCHER,
      storageId: STORAGE_ID,
      generation: 1,
      bindingEpoch: 1,
      idempotencyHash: hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY),
      fingerprint: createFingerprint(config),
    }));
  });

  it('returns 202 for pending replay and 409 once the mapping is consumed', async () => {
    const memory = new MemoryIdempRedis();
    const hash = hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY);
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hash);
    memory.putResearcher(keys.researcher!);
    const study = makeStoredStudy({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      config: makeStudyConfig({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    });
    const fingerprint = createFingerprint(study.config);
    memory.strings.set(keys.mapping, encodeCreateIdempotencyRecord({
      version: 2,
      researcherId: RESEARCHER,
      studyId: study.id,
      createdAt: study.createdAt,
      updatedAt: study.updatedAt,
      fingerprint,
      state: 'pending',
      operationId: 'create:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      study,
    }));
    platformClientMock.current = asPort(memory);

    const pending = await POST(request({ config: study.config }));
    const pendingBody = await pending.json();
    expect(pending.status).toBe(202);
    expect(pendingBody).toMatchObject({
      reconciliationPending: true,
      studyId: study.id,
      operationId: 'create:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      phase: 'pending',
      retryAfterSeconds: 5,
    });
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();

    memory.strings.set(keys.mapping, encodeCreateIdempotencyRecord({
      version: 2,
      researcherId: RESEARCHER,
      studyId: study.id,
      createdAt: study.createdAt,
      updatedAt: study.updatedAt,
      fingerprint,
      state: 'deleted',
      operationId: 'create:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      study,
    }));
    const consumed = await POST(request({ config: study.config }));
    expect(consumed.status).toBe(409);
    expect(await consumed.json()).toEqual({ code: 'IDEMPOTENCY_KEY_CONSUMED' });
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('maps quota and unavailable closed-wire outcomes without creating a study', async () => {
    const memory = new MemoryIdempRedis();
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY));
    memory.putResearcher(keys.researcher!);
    memory.fillIndex(keys.index, 100);
    platformClientMock.current = asPort(memory);

    const quota = await POST(request());
    expect(quota.status).toBe(503);
    expect(await quota.json()).toEqual({ retryable: true, reason: 'idempotency-quota' });

    memory.forcedEval = ['not-a-family-tag'];
    const unavailable = await POST(request({ key: OTHER_KEY }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ retryable: true, reason: 'unavailable' });
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
    expect(platformMock.beginCreateStudyOperationV2).not.toHaveBeenCalled();
  });

  it('returns 503 ambiguous on may-have-committed response loss so the client replays the same key', async () => {
    const memory = new MemoryIdempRedis();
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY));
    memory.putResearcher(keys.researcher!);
    memory.eval = async () => {
      throw new RedisCommitAmbiguousError('may-have-committed');
    };
    platformClientMock.current = asPort(memory);

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ retryable: true, reason: 'ambiguous' });
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
  });

  it('maps schema-hold to 503 retryable:false with zero platform writes', async () => {
    // Regression for review P1-1: on lineage hold, the rate-limit gate reports
    // hold and no idempotency mapping, operation, or BYOS write may occur.
    const memory = new MemoryIdempRedis();
    const keys = createIdempotencyKeys('hosted', RESEARCHER, hashCreateIdempotencyKey(RESEARCHER, IDEMPOTENCY_KEY));
    memory.putResearcher(keys.researcher!);
    platformClientMock.current = asPort(memory);
    platformMock.consumePlatformRateLimit.mockResolvedValue({ status: 'hold' });

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ retryable: false, reason: 'schema-hold' });
    expect(memory.evalCalls).toBe(0);
    expect(memory.strings.has(keys.mapping)).toBe(false);
    expect(memory.strings.has('rate-limit:study-create:0:researcher-a')).toBe(false);
    expect(platformMock.beginCreateStudyOperationV2).not.toHaveBeenCalled();
    expect(platformMock.loadResearcherStorageBinding).not.toHaveBeenCalled();
    expect(kvMock.createStudyAtomic).not.toHaveBeenCalled();
    expect(contextMock.getHostedResearcherIdentity).toHaveBeenCalledTimes(1);
    expect(contextMock.getRequestContext).not.toHaveBeenCalled();
  });
});
