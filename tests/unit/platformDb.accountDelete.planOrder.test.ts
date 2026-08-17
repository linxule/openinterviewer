// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_DELETE_APPLY_SCRIPT,
  ACCOUNT_DELETE_OP_ALLOWLIST,
  ACCOUNT_DELETE_PERSIST_SCRIPT,
  assertChildBeforeIndex,
  beginAccountDeletion,
  buildAccountDeletePlan,
  resumeAccountDeletion,
  validateAccountDeletePlan,
  type AccountDeleteOp,
  type AccountDeleteSnapshot,
} from '@/lib/platformDb';
import { encodeAccountRecord, encodeOwnerRecord, encodeStorageBinding } from '@/lib/platformDb.operations';
import { buildSchemaLineageValue } from '@/lib/platformSchema';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';
import { coverFaultCut } from '../helpers/faultManifest';
import type { ResearcherAccount } from '@/types';

const RESEARCHER = 'researcher-a';
const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const STORAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LINK_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const IDEM_HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECEIPT_MEMBER = `${STUDY_ID}:1`;

const evictMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kvClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kvClient')>();
  return {
    ...actual,
    evictResearcherClients: evictMock,
    getPlatformClient: () => {
      throw new Error('getPlatformClient must not be used; inject MemoryPlatformRedis');
    },
  };
});

function researcher(): ResearcherAccount {
  return {
    id: RESEARCHER,
    email: 'owner@example.com',
    name: 'Owner',
    avatarUrl: null,
    oauthProvider: 'google',
    oauthId: 'oauth-1',
    createdAt: 1,
    lastLoginAt: 1,
    onboardingComplete: true,
    encryptedRedisUrl: 'cipher-url',
    encryptedRedisToken: 'cipher-token',
    encryptedGeminiApiKey: null,
    encryptedAnthropicApiKey: null,
    redisConfiguredAt: 1,
    credentialRevision: 1,
  };
}

function snapshot(overrides?: Partial<AccountDeleteSnapshot>): AccountDeleteSnapshot {
  return {
    researcherId: RESEARCHER,
    accountRaw: encodeAccountRecord({ id: RESEARCHER }),
    oauthKey: 'oauth:google:oauth-1',
    oauthRaw: RESEARCHER,
    emailKey: 'email:owner@example.com',
    emailRaw: RESEARCHER,
    storageId: STORAGE_ID,
    storageRaw: encodeStorageBinding({
      version: 2,
      researcherId: RESEARCHER,
      storageId: STORAGE_ID,
      originHash: STORAGE_ID,
      credentialRevision: 1,
      bindingEpoch: 0,
      cipherSnapshot: 'snap',
    }),
    studyIds: [STUDY_ID],
    locks: [{ studyId: STUDY_ID, key: `study-op-lock:${STUDY_ID}`, raw: 'oi:lock:1:researcher-a:create:0123456789abcdef0123456789abcdef' }],
    receipts: [{
      member: RECEIPT_MEMBER,
      key: `study-op-receipt:${STUDY_ID}:1`,
      raw: 'oi:receipt:{"version":2}',
    }],
    registry: [{ field: STUDY_ID, raw: 'oi:op:{"version":2}' }],
    owners: [{
      studyId: STUDY_ID,
      key: `study-owner:${STUDY_ID}`,
      raw: encodeOwnerRecord({
        version: 2,
        researcherId: RESEARCHER,
        storageId: STORAGE_ID,
        generation: 1,
      }),
      storageId: STORAGE_ID,
    }],
    linkIds: [LINK_ID],
    links: [{ id: LINK_ID, raw: `oi:link:{"id":"${LINK_ID}"}` }],
    idempHashes: [IDEM_HASH],
    idemps: [{ hash: IDEM_HASH, raw: 'oi:idemp:{"version":2}' }],
    redisLess: false,
    ...overrides,
  };
}

function seedBoundAccount(redis: MemoryPlatformRedis, options?: { redisLess?: boolean }) {
  redis.strings.set('schema-lineage', buildSchemaLineageValue(1));
  redis.strings.set(`researcher:${RESEARCHER}`, encodeAccountRecord({ id: RESEARCHER }));
  redis.strings.set('oauth:google:oauth-1', RESEARCHER);
  redis.strings.set('email:owner@example.com', RESEARCHER);
  redis.sets.set('all-researchers', new Set([RESEARCHER]));
  if (options?.redisLess) return;
  redis.strings.set(
    `researcher-storage:${RESEARCHER}`,
    encodeStorageBinding({
      version: 2,
      researcherId: RESEARCHER,
      storageId: STORAGE_ID,
      originHash: STORAGE_ID,
      credentialRevision: 1,
      bindingEpoch: 0,
      cipherSnapshot: 'snap',
    }),
  );
  redis.sets.set(`storage-researchers:${STORAGE_ID}`, new Set([RESEARCHER]));
  redis.sets.set(`researcher-studies:${RESEARCHER}`, new Set([STUDY_ID]));
  redis.strings.set(`study-op-lock:${STUDY_ID}`, 'oi:lock:1:researcher-a:create:0123456789abcdef0123456789abcdef');
  redis.strings.set(`study-op-receipt:${STUDY_ID}:1`, 'oi:receipt:{"version":2}');
  redis.zsets.set(`study-op-receipts:${RESEARCHER}`, new Map([[RECEIPT_MEMBER, 1]]));
  const registry = redis.hashes.get('study-ops:v2') ?? new Map<string, string>();
  registry.set(STUDY_ID, 'oi:op:{"version":2}');
  redis.hashes.set('study-ops:v2', registry);
  redis.strings.set(
    `study-owner:${STUDY_ID}`,
    encodeOwnerRecord({
      version: 2,
      researcherId: RESEARCHER,
      storageId: STORAGE_ID,
      generation: 1,
    }),
  );
  redis.sets.set(`participant-links:${RESEARCHER}`, new Set([LINK_ID]));
  redis.strings.set(`participant-link:${LINK_ID}`, `oi:link:{"id":"${LINK_ID}"}`);
  redis.zsets.set(`create-idemp-index:${RESEARCHER}`, new Map([[IDEM_HASH, 1]]));
  redis.strings.set(`create-idemp:${IDEM_HASH}`, 'oi:idemp:{"version":2}');
}

function opNames(ops: AccountDeleteOp[]): string[] {
  return ops.map((op) => op.op);
}

beforeEach(() => {
  evictMock.mockReset();
});

describe('account-delete plan order and allowlist', () => {
  it('materializes the exact child-before-index sequence and journals last', () => {
    const plan = buildAccountDeletePlan(snapshot());
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(validateAccountDeletePlan(plan)).toBe('ok');
    expect(assertChildBeforeIndex(plan)).toBe(true);
    expect(plan.journalLast).toBe(true);
    expect(plan.ops[plan.length - 1]).toEqual({ op: 'hdel-journal', field: RESEARCHER });
    expect(plan.ops[plan.length - 2]?.op).toBe('local-evict');
    expect(opNames(plan.ops)).toEqual([
      'srem',
      'cad-string',
      'cad-string',
      'srem',
      'cad-lock',
      'cad-string',
      'zrem',
      'cad-hash',
      'cad-storage',
      'cad-owner',
      'srem',
      'cad-string',
      'srem',
      'cad-string',
      'zrem',
      'cad-string',
      'local-evict',
      'hdel-journal',
    ]);
    expect(plan.ops[0]).toMatchObject({
      op: 'srem',
      key: `storage-researchers:${STORAGE_ID}`,
      member: RESEARCHER,
    });
    const storageIndex = plan.ops.findIndex((op) => op.op === 'cad-storage');
    const ownerIndex = plan.ops.findIndex((op) => op.op === 'cad-owner');
    expect(storageIndex).toBeGreaterThan(-1);
    expect(ownerIndex).toBeGreaterThan(storageIndex);
    const receiptIndex = plan.ops.findIndex((op) => op.op === 'cad-string' && op.key.startsWith('study-op-receipt:'));
    expect(plan.ops[receiptIndex + 1]?.op).toBe('zrem');
    const linkIndex = plan.ops.findIndex((op) => op.op === 'cad-string' && op.key.startsWith('participant-link:'));
    expect(plan.ops[linkIndex + 1]?.op).toBe('srem');
    for (const op of plan.ops) {
      expect(ACCOUNT_DELETE_OP_ALLOWLIST).toContain(op.op);
    }
  });

  it('omits storage and owner CADs for an already redis-less account', () => {
    const plan = buildAccountDeletePlan(snapshot({
      storageId: null,
      storageRaw: null,
      studyIds: [],
      locks: [],
      receipts: [],
      registry: [],
      owners: [],
      redisLess: true,
    }));
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.ops.some((op) => op.op === 'cad-storage' || op.op === 'cad-owner')).toBe(false);
    expect(plan.ops.some((op) => op.op === 'srem' && op.key.startsWith('storage-researchers:'))).toBe(false);
    expect(plan.ops[plan.length - 2]).toMatchObject({ op: 'local-evict', disposition: 'none' });
  });

  it('rejects a plan that HDELs the journal before data keys', () => {
    const plan = buildAccountDeletePlan(snapshot());
    expect(plan).not.toBeNull();
    if (!plan) return;
    const broken = {
      ...plan,
      ops: [plan.ops[plan.length - 1], ...plan.ops.slice(0, -1)],
    };
    expect(validateAccountDeletePlan(broken)).toBe('invalid');
  });
});

describe('account-delete persist/resume/crash', () => {
  it('persists one canonical plan and replays it instead of recomputing', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundAccount(redis);
    const first = await beginAccountDeletion(researcher(), { client: redis.asPort() });
    expect(first.status).toBe('started');
    if (first.status !== 'started') return;
    const persisted = redis.strings.get(`account-delete-plan:${RESEARCHER}`);
    redis.sets.get(`researcher-studies:${RESEARCHER}`)?.add('22222222-2222-4222-8222-222222222222');
    const second = await beginAccountDeletion(researcher(), { client: redis.asPort() });
    expect(second.status).toBe('replay');
    expect(redis.strings.get(`account-delete-plan:${RESEARCHER}`)).toBe(persisted);
    expect(second.status === 'replay' && second.plan.ops.length).toBe(first.plan.ops.length);
  });

  it('resumes after a crash mid-plan and evicts immediately before journal HDEL', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundAccount(redis);
    const begun = await beginAccountDeletion(researcher(), { client: redis.asPort() });
    expect(begun.status).toBe('started');
    if (begun.status !== 'started') return;

    let applies = 0;
    const originalEval = redis.eval.bind(redis);
    redis.eval = async (script: string, keys: string[], args: string[]) => {
      if (script.includes('-- adel-apply')) {
        applies += 1;
        if (applies === 4) {
          throw new Error('simulated crash');
        }
      }
      return originalEval(script, keys, args);
    };

    const crashed = await resumeAccountDeletion(RESEARCHER, { client: redis.asPort() });
    expect(crashed.status).toBe('pending');
    expect(redis.hashes.get('account-delete-journal')?.has(RESEARCHER)).toBe(true);
    expect(evictMock).not.toHaveBeenCalled();

    redis.eval = originalEval;
    const finished = await resumeAccountDeletion(RESEARCHER, { client: redis.asPort() });
    expect(finished.status).toBe('complete');
    expect(redis.hashes.get('account-delete-journal')?.has(RESEARCHER)).toBe(false);
    expect(redis.strings.has(`researcher:${RESEARCHER}`)).toBe(false);
    expect(evictMock).toHaveBeenCalledWith({ disposition: 'full', researcherId: RESEARCHER });
    const evictAt = redis.writes.indexOf('adel-local-evict');
    const hdelAt = redis.writes.indexOf('adel-final-hdel');
    expect(evictAt).toBeGreaterThan(-1);
    expect(hdelAt).toBeGreaterThan(evictAt);
    coverFaultCut('adel-plan-ops');
    coverFaultCut('adel-cursor');
    coverFaultCut('adel-local-evict');
    coverFaultCut('adel-final-hdel');
  });

  it('no-ops cad-owner when a successor pair is already stored', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundAccount(redis);
    const begun = await beginAccountDeletion(researcher(), { client: redis.asPort() });
    expect(begun.status).toBe('started');
    if (begun.status !== 'started') return;
    const successor = encodeOwnerRecord({
      version: 2,
      researcherId: 'researcher-b',
      storageId: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      generation: 2,
    });
    redis.strings.set(`study-owner:${STUDY_ID}`, successor);
    const finished = await resumeAccountDeletion(RESEARCHER, { client: redis.asPort() });
    expect(finished.status).toBe('complete');
    expect(redis.strings.get(`study-owner:${STUDY_ID}`)).toBe(successor);
  });

  it('embeds the exact fault prefixes in the reusable Lua scripts', () => {
    expect(ACCOUNT_DELETE_PERSIST_SCRIPT).toContain('-- adel-persist');
    expect(ACCOUNT_DELETE_APPLY_SCRIPT).toContain('-- fault cut adel-plan-ops');
    expect(ACCOUNT_DELETE_APPLY_SCRIPT).toContain('-- fault cut adel-cursor');
    expect(ACCOUNT_DELETE_APPLY_SCRIPT).toContain('-- fault cut adel-local-evict');
    expect(ACCOUNT_DELETE_APPLY_SCRIPT).toContain('-- fault cut adel-final-hdel');
    expect(ACCOUNT_DELETE_APPLY_SCRIPT.indexOf('cad_string')).toBeLessThan(
      ACCOUNT_DELETE_APPLY_SCRIPT.indexOf("kind == 'cad-owner'"),
    );
    expect(ACCOUNT_DELETE_APPLY_SCRIPT.indexOf("kind == 'cad-storage'")).toBeLessThan(
      ACCOUNT_DELETE_APPLY_SCRIPT.indexOf("kind == 'cad-owner'"),
    );
    expect(ACCOUNT_DELETE_APPLY_SCRIPT.indexOf('-- fault cut adel-local-evict'))
      .toBeLessThan(ACCOUNT_DELETE_APPLY_SCRIPT.indexOf('-- fault cut adel-final-hdel'));
    expect(ACCOUNT_DELETE_APPLY_SCRIPT.indexOf("redis.call('HDEL', KEYS[2], ARGV[1])"))
      .toBeGreaterThan(ACCOUNT_DELETE_APPLY_SCRIPT.indexOf('-- fault cut adel-final-hdel'));
    expect(ACCOUNT_DELETE_APPLY_SCRIPT.indexOf("redis.call('SET', KEYS[1], 'oi:adel-plan:'"))
      .toBeGreaterThan(ACCOUNT_DELETE_APPLY_SCRIPT.indexOf('-- fault cut adel-cursor'));
  });
});
