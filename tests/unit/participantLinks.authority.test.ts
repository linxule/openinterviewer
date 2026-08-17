// @vitest-environment node

process.env.PLATFORM_KEY_PREFIX = '';

import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchemaLineageValue } from '@/lib/platformSchema';
import {
  AUTHORITY_GATE_LUA,
  buildPendingStudyOperationV2,
  encodeAccountRecord,
  encodeLockValue,
  encodeOperationRecord,
  encodeOwnerRecord,
  encodeStorageBinding,
  hostedAuthorityKeys,
} from '@/lib/platformDb';
import {
  HOSTED_CREATE_LINK_SCRIPT,
  HOSTED_EXCHANGE_LINK_SCRIPT,
  HOSTED_LIST_LINK_SCRIPT,
  HOSTED_REVOKE_LINK_SCRIPT,
  LINK_VALUE_PREFIX,
  createParticipantLinkRecord,
  getParticipantLinkByCode,
  listParticipantLinksForStudy,
  revokeParticipantLink,
  type ParticipantLinkRecord,
} from '@/lib/participantLinks';
import { MemoryPlatformRedis } from '../helpers/memoryPlatformRedis';

const STUDY_ID = '11111111-1111-4111-8111-111111111111';
const RESEARCHER = 'researcher-a';
const OTHER = 'researcher-b';
const STORAGE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_STORAGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const FINGERPRINT = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;
const LINK_ID = 'e'.repeat(64);

const clients = vi.hoisted(() => ({
  getKVClient: vi.fn(),
  getPlatformClient: vi.fn(),
}));

vi.mock('@/lib/kvClient', () => clients);

function ownerRecord() {
  return { version: 2 as const, researcherId: RESEARCHER, storageId: STORAGE_ID, generation: 1 };
}

function seedBoundOwner(redis: MemoryPlatformRedis, overrides?: { journalCaller?: string; lineage?: string | null }) {
  if (overrides?.lineage === undefined) {
    redis.strings.set('schema-lineage', buildSchemaLineageValue(NOW));
  } else if (overrides.lineage !== null) {
    redis.strings.set('schema-lineage', overrides.lineage);
  }
  redis.strings.set(`researcher:${RESEARCHER}`, encodeAccountRecord({ id: RESEARCHER }));
  redis.strings.set(`researcher:${OTHER}`, encodeAccountRecord({ id: OTHER }));
  redis.strings.set(`study-owner:${STUDY_ID}`, encodeOwnerRecord(ownerRecord()));
  redis.sets.set(`researcher-studies:${RESEARCHER}`, new Set([STUDY_ID]));
  redis.strings.set(
    `researcher-storage:${RESEARCHER}`,
    encodeStorageBinding({
      version: 2,
      researcherId: RESEARCHER,
      storageId: STORAGE_ID,
      originHash: STORAGE_ID,
      credentialRevision: 1,
      bindingEpoch: 7,
      cipherSnapshot: 'cipher',
    }),
  );
  redis.sets.set(`storage-researchers:${STORAGE_ID}`, new Set([RESEARCHER]));
  if (overrides?.journalCaller) {
    const journal = redis.hashes.get('account-delete-journal') ?? new Map<string, string>();
    journal.set(overrides.journalCaller, 'oi:adel-journal:{"version":2}');
    redis.hashes.set('account-delete-journal', journal);
  }
}

function seedLive(
  redis: MemoryPlatformRedis,
  kind: 'create' | 'delete',
  phase: 'reserving' | 'pending' | 'resolving' | 'publishing',
) {
  const op = buildPendingStudyOperationV2({
    kind,
    phase,
    researcherId: RESEARCHER,
    studyId: STUDY_ID,
    generation: 1,
    opNonce: NONCE,
    createdAt: NOW,
    idempotencyHash: kind === 'create' ? HASH : null,
    fingerprint: kind === 'create' ? FINGERPRINT : null,
  });
  const hash = redis.hashes.get('study-ops:v2') ?? new Map<string, string>();
  hash.set(STUDY_ID, encodeOperationRecord(op));
  redis.hashes.set('study-ops:v2', hash);
}

function encodeLink(link: ParticipantLinkRecord): string {
  return `${LINK_VALUE_PREFIX}${JSON.stringify(link)}`;
}

function seedLink(redis: MemoryPlatformRedis, overrides?: Partial<ParticipantLinkRecord>) {
  const link: ParticipantLinkRecord = {
    id: LINK_ID,
    version: 1,
    studyId: STUDY_ID,
    studyRevision: 1,
    researcherId: RESEARCHER,
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    revokedAt: null,
    ...overrides,
  };
  redis.strings.set(`participant-link:${link.id}`, encodeLink(link));
  const index = redis.sets.get(`participant-links:${RESEARCHER}`) ?? new Set<string>();
  index.add(link.id);
  redis.sets.set(`participant-links:${RESEARCHER}`, index);
  return link;
}

describe('hosted link scripts embed the exact authority gate', () => {
  it('keeps journal, registry, lock, owner, storage, reverse, and lineage before any link write', () => {
    for (const script of [HOSTED_CREATE_LINK_SCRIPT, HOSTED_LIST_LINK_SCRIPT, HOSTED_REVOKE_LINK_SCRIPT]) {
      expect(script).toContain("redis.call('GET', KEYS[5])");
      expect(script).toContain("redis.call('HEXISTS', KEYS[1]");
      expect(script).toContain('ARGV[4] .. caller');
      expect(script).toContain("redis.call('GET', KEYS[2])");
      expect(script).toContain('ARGV[5] .. owner.researcherId');
      expect(script).toContain('ARGV[6] .. owner.researcherId');
      expect(script).toContain('ARGV[7] .. owner.storageId');
      expect(script).toContain("redis.call('HGET', KEYS[3]");
      expect(script).toContain("redis.call('GET', KEYS[4])");
      expect(script.indexOf('-- hosted-link-authority-passed')).toBeGreaterThan(-1);
      expect(script).toMatch(/-- hosted-link-(create|list|revoke)/);
      expect(script.indexOf('-- hosted-link-authority-passed'))
        .toBeLessThan(script.search(/-- hosted-link-(create|list|revoke)/));
      expect(script).not.toContain('-- authority (no writes)');
    }
    expect(HOSTED_CREATE_LINK_SCRIPT.indexOf('-- hosted-link-authority-passed'))
      .toBeLessThan(HOSTED_CREATE_LINK_SCRIPT.indexOf("redis.call('SET', KEYS[6]"));
    expect(HOSTED_EXCHANGE_LINK_SCRIPT).toContain("redis.call('GET', KEYS[3])");
    expect(HOSTED_EXCHANGE_LINK_SCRIPT).toContain("redis.call('HEXISTS', KEYS[1]");
    expect(HOSTED_EXCHANGE_LINK_SCRIPT).toContain('ARGV[8] .. studyId');
    expect(HOSTED_EXCHANGE_LINK_SCRIPT).toContain('ARGV[9] .. studyId');
    expect(HOSTED_EXCHANGE_LINK_SCRIPT).toContain('ARGV[5] .. owner.researcherId');
    expect(HOSTED_EXCHANGE_LINK_SCRIPT).toContain('ARGV[6] .. owner.researcherId');
    expect(HOSTED_EXCHANGE_LINK_SCRIPT).toContain('ARGV[7] .. owner.storageId');
    expect(HOSTED_EXCHANGE_LINK_SCRIPT).toContain("redis.call('HGET', KEYS[2]");
    expect(AUTHORITY_GATE_LUA).toContain('-- authority (no writes)');
  });
});

describe('hosted create/list/revoke/exchange authority denials', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.DEPLOYMENT_MODE = 'hosted';
    process.env.PLATFORM_KEY_PREFIX = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DEPLOYMENT_MODE;
    delete process.env.PLATFORM_KEY_PREFIX;
  });

  it('denies every live op on create/list/revoke/exchange with zero link writes', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundOwner(redis);
    seedLive(redis, 'create', 'pending');
    seedLink(redis);
    clients.getPlatformClient.mockReturnValue(redis.asPort());

    expect(await createParticipantLinkRecord({
      studyId: STUDY_ID, studyRevision: 1, researcherId: RESEARCHER, expiresAt: NOW + 1_000,
    })).toEqual({ status: 'live', phase: 'pending' });
    expect(await listParticipantLinksForStudy({
      studyId: STUDY_ID, researcherId: RESEARCHER,
    })).toEqual({ status: 'live', phase: 'pending' });
    expect(await revokeParticipantLink({
      linkId: LINK_ID, studyId: STUDY_ID, researcherId: RESEARCHER,
    })).toEqual({ status: 'live', phase: 'pending' });

    const deleting = new MemoryPlatformRedis();
    seedBoundOwner(deleting);
    seedLive(deleting, 'delete', 'resolving');
    seedLink(deleting);
    clients.getPlatformClient.mockReturnValue(deleting.asPort());
    expect(await createParticipantLinkRecord({
      studyId: STUDY_ID, studyRevision: 1, researcherId: RESEARCHER, expiresAt: null,
    })).toEqual({ status: 'live', phase: 'resolving' });

    const lockOnly = new MemoryPlatformRedis();
    seedBoundOwner(lockOnly);
    seedLink(lockOnly);
    lockOnly.strings.set(
      `study-op-lock:${STUDY_ID}`,
      encodeLockValue({ generation: 1, researcherId: RESEARCHER, kind: 'create', opNonce: NONCE }),
    );
    clients.getPlatformClient.mockReturnValue(lockOnly.asPort());
    const code = Buffer.from('a'.repeat(32)).toString('base64url');
    lockOnly.strings.set(
      `participant-link:${createHash('sha256').update(code).digest('hex')}`,
      encodeLink({
        id: createHash('sha256').update(code).digest('hex'),
        version: 1,
        studyId: STUDY_ID,
        studyRevision: 1,
        researcherId: RESEARCHER,
        createdAt: NOW,
        expiresAt: null,
        revokedAt: null,
      }),
    );
    expect(await getParticipantLinkByCode(code)).toEqual({ status: 'live', phase: 'reserving' });

    expect(redis.writes).toEqual([]);
    expect(deleting.writes).toEqual([]);
    expect(lockOnly.writes).toEqual([]);
    expect([...redis.sets.get(`participant-links:${RESEARCHER}`)!]).toEqual([LINK_ID]);
  });

  it('returns distinct mismatch, poison, and unavailable without writing links', async () => {
    const mismatch = new MemoryPlatformRedis();
    seedBoundOwner(mismatch);
    seedLink(mismatch);
    mismatch.strings.set(
      `researcher-storage:${RESEARCHER}`,
      encodeStorageBinding({
        version: 2,
        researcherId: RESEARCHER,
        storageId: OTHER_STORAGE,
        originHash: OTHER_STORAGE,
        credentialRevision: 1,
        bindingEpoch: 7,
        cipherSnapshot: 'cipher',
      }),
    );
    clients.getPlatformClient.mockReturnValue(mismatch.asPort());
    expect(await createParticipantLinkRecord({
      studyId: STUDY_ID, studyRevision: 1, researcherId: RESEARCHER, expiresAt: null,
    })).toEqual({ status: 'mismatch' });
    expect(await listParticipantLinksForStudy({ studyId: STUDY_ID, researcherId: RESEARCHER }))
      .toEqual({ status: 'mismatch' });

    const poison = new MemoryPlatformRedis();
    seedBoundOwner(poison);
    seedLink(poison);
    poison.sets.delete(`researcher-studies:${RESEARCHER}`);
    clients.getPlatformClient.mockReturnValue(poison.asPort());
    expect(await revokeParticipantLink({
      linkId: LINK_ID, studyId: STUDY_ID, researcherId: RESEARCHER,
    })).toEqual({ status: 'corrupt' });

    const unavailable = new MemoryPlatformRedis();
    seedBoundOwner(unavailable);
    seedLink(unavailable);
    unavailable.strings.set(`study-owner:${STUDY_ID}`, '{"researcherId":"researcher-a"}');
    clients.getPlatformClient.mockReturnValue(unavailable.asPort());
    expect(await listParticipantLinksForStudy({ studyId: STUDY_ID, researcherId: RESEARCHER }))
      .toEqual({ status: 'unavailable' });

    const adel = new MemoryPlatformRedis();
    seedBoundOwner(adel, { journalCaller: RESEARCHER });
    seedLink(adel);
    clients.getPlatformClient.mockReturnValue(adel.asPort());
    expect(await createParticipantLinkRecord({
      studyId: STUDY_ID, studyRevision: 1, researcherId: RESEARCHER, expiresAt: null,
    })).toEqual({ status: 'adel' });

    expect(mismatch.writes).toEqual([]);
    expect(poison.writes).toEqual([]);
    expect(unavailable.writes).toEqual([]);
    expect(adel.writes).toEqual([]);
    expect(poison.strings.get(`participant-link:${LINK_ID}`)).toContain('"revokedAt":null');
  });

  it('creates, lists, and revokes only after allow, storing oi:link records', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundOwner(redis);
    clients.getPlatformClient.mockReturnValue(redis.asPort());

    const created = await createParticipantLinkRecord({
      studyId: STUDY_ID, studyRevision: 2, researcherId: RESEARCHER, expiresAt: NOW + 5_000,
    });
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    expect(created.link.studyId).toBe(STUDY_ID);
    const stored = redis.strings.get(`participant-link:${created.link.id}`);
    expect(stored?.startsWith(LINK_VALUE_PREFIX)).toBe(true);
    expect(redis.writes.some((write) => write.startsWith('SET participant-link:'))).toBe(true);

    const listed = await listParticipantLinksForStudy({
      studyId: STUDY_ID, researcherId: RESEARCHER,
    });
    expect(listed.status).toBe('ok');
    if (listed.status !== 'ok') return;
    expect(listed.links).toEqual([expect.objectContaining({ id: created.link.id, studyRevision: 2 })]);

    const revoked = await revokeParticipantLink({
      linkId: created.link.id, studyId: STUDY_ID, researcherId: RESEARCHER,
    });
    expect(revoked.status).toBe('revoked');
    expect(redis.strings.get(`participant-link:${created.link.id}`)).toContain('"revokedAt":');
  });

  it('exchanges an active hosted code after the reconstructed owner/lock gate', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundOwner(redis);
    clients.getPlatformClient.mockReturnValue(redis.asPort());
    const created = await createParticipantLinkRecord({
      studyId: STUDY_ID, studyRevision: 1, researcherId: RESEARCHER, expiresAt: null,
    });
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;

    await expect(getParticipantLinkByCode(created.code)).resolves.toEqual({
      status: 'found',
      link: created.link,
    });

    redis.strings.set(
      `researcher-storage:${RESEARCHER}`,
      encodeStorageBinding({
        version: 2,
        researcherId: RESEARCHER,
        storageId: OTHER_STORAGE,
        originHash: OTHER_STORAGE,
        credentialRevision: 1,
        bindingEpoch: 7,
        cipherSnapshot: 'cipher',
      }),
    );
    const writesBefore = redis.writes.length;
    await expect(getParticipantLinkByCode(created.code)).resolves.toEqual({ status: 'mismatch' });
    expect(redis.writes.length).toBe(writesBefore);
  });

  it('uses the exact authority KEYS prefix on hosted create', async () => {
    const redis = new MemoryPlatformRedis();
    seedBoundOwner(redis);
    const evalSpy = vi.spyOn(redis, 'eval');
    clients.getPlatformClient.mockReturnValue(redis.asPort());
    await createParticipantLinkRecord({
      studyId: STUDY_ID, studyRevision: 1, researcherId: RESEARCHER, expiresAt: null,
    });
    const [, keys, args] = evalSpy.mock.calls[0] as [string, string[], string[]];
    expect(keys.slice(0, 5)).toEqual(hostedAuthorityKeys(STUDY_ID));
    expect(args.slice(0, 3)).toEqual([RESEARCHER, STUDY_ID, 'link']);
  });
});
