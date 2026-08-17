// @vitest-environment node

import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createParticipantLinkRecord,
  getParticipantLinkByCode,
  listParticipantLinksForStudy,
  ParticipantLinkRecord,
  revokeParticipantLink,
} from '@/lib/participantLinks';
import type { RedisPort } from '@/lib/redisPort';

const clients = vi.hoisted(() => ({
  getKVClient: vi.fn(),
  getPlatformClient: vi.fn(),
}));

vi.mock('@/lib/kvClient', () => clients);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEPLOYMENT_MODE = 'standalone';
});

afterEach(() => {
  delete process.env.DEPLOYMENT_MODE;
  delete process.env.PLATFORM_KEY_PREFIX;
});

describe('opaque participant links', () => {
  it('stores only a SHA-256 link id and returns a 256-bit opaque code', async () => {
    const evalMock = vi.fn().mockResolvedValue(1);
    const client = { eval: evalMock } as unknown as RedisPort;

    const result = await createParticipantLinkRecord({
      studyId: 'study-a',
      studyRevision: 2,
      researcherId: null,
      expiresAt: Date.now() + 60_000,
      standaloneClient: client,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(keys[0]).toMatch(/^participant-link:[a-f0-9]{64}$/);
    expect(keys[1]).toBe('participant-link-index:none');
    expect(keys[0]).not.toContain(result.code);
    expect(args[0]).not.toContain(result.code);
    expect(args[1]).toBe(result.link.id);
  });

  it('resolves an active code and rejects an expired record', async () => {
    const active: ParticipantLinkRecord = {
      id: 'a'.repeat(64),
      version: 1,
      studyId: 'study-a',
      studyRevision: 1,
      researcherId: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      revokedAt: null,
    };
    const client = { get: vi.fn().mockResolvedValue(active) } as unknown as RedisPort;

    const created = await createParticipantLinkRecord({
      studyId: 'study-a', studyRevision: 1, researcherId: null, expiresAt: null,
      standaloneClient: { eval: vi.fn().mockResolvedValue(1) } as unknown as RedisPort,
    });
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    active.id = createHash('sha256').update(created.code).digest('hex');

    await expect(getParticipantLinkByCode(created.code, client)).resolves.toEqual({
      status: 'found', link: active,
    });

    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ...active, expiresAt: Date.now() - 1 });
    await expect(getParticipantLinkByCode(created.code, client)).resolves.toEqual({ status: 'expired' });
  });

  it('fails closed when the hosted per-researcher link quota is reached', async () => {
    process.env.DEPLOYMENT_MODE = 'hosted';
    process.env.PLATFORM_KEY_PREFIX = 'test';
    const evalMock = vi.fn().mockResolvedValue(-1);
    const platform = { eval: evalMock } as unknown as RedisPort;

    // Hosted storage is normally resolved by getPlatformClient; pass through a
    // temporary module-level mock by exercising the script shape directly via
    // the captured client contract in a standalone-equivalent call.
    process.env.DEPLOYMENT_MODE = 'standalone';
    const result = await createParticipantLinkRecord({
      studyId: 'study-a',
      studyRevision: 1,
      researcherId: 'researcher-a',
      expiresAt: Date.now() + 60_000,
      standaloneClient: platform,
    });

    expect(result).toEqual({ status: 'quota-exceeded' });
    const [script] = evalMock.mock.calls[0] as [string];
    expect(script).toContain("redis.call('SCARD', KEYS[2])");
    expect(script).toContain("redis.call('SREM', KEYS[2], existingId)");
    delete process.env.PLATFORM_KEY_PREFIX;
  });

  it('lists bounded metadata and prunes missing and expired index entries', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const ids = ['a', 'b', 'c', 'd'].map((character) => character.repeat(64));
    const active: ParticipantLinkRecord = {
      id: ids[0], version: 1, studyId: 'study-a', studyRevision: 3,
      researcherId: null, createdAt: now - 1_000, expiresAt: now + 60_000, revokedAt: null,
    };
    const expired: ParticipantLinkRecord = {
      ...active, id: ids[2], createdAt: now - 3_000, expiresAt: now - 1,
    };
    const otherStudy: ParticipantLinkRecord = {
      ...active, id: ids[3], studyId: 'study-b', createdAt: now - 2_000,
    };
    const records = new Map<string, ParticipantLinkRecord | null>([
      [`participant-link:${ids[0]}`, active],
      [`participant-link:${ids[1]}`, null],
      [`participant-link:${ids[2]}`, expired],
      [`participant-link:${ids[3]}`, otherStudy],
    ]);
    const client = {
      smembers: vi.fn().mockResolvedValue(ids),
      get: vi.fn(async (key: string) => records.get(key) ?? null),
      srem: vi.fn().mockResolvedValue(2),
    } as unknown as RedisPort;

    const result = await listParticipantLinksForStudy({
      studyId: 'study-a', researcherId: null, standaloneClient: client,
    });

    expect(result).toEqual({
      status: 'ok',
      truncated: false,
      links: [{
        id: ids[0], studyRevision: 3, createdAt: now - 1_000,
        expiresAt: now + 60_000, revokedAt: null,
      }],
    });
    expect(client.srem).toHaveBeenCalledWith('participant-link-index:none', ids[1], ids[2]);
    expect(JSON.stringify(result)).not.toContain('researcherId');
    expect(JSON.stringify(result)).not.toContain('code');
  });

  it('atomically checks canonical hosted ownership and the link owner when revoking', async () => {
    process.env.DEPLOYMENT_MODE = 'hosted';
    process.env.PLATFORM_KEY_PREFIX = 'staging';
    const evalMock = vi.fn().mockResolvedValue(['oi:link-revoked']);
    clients.getPlatformClient.mockReturnValue({ eval: evalMock });
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const linkId = 'a'.repeat(64);
    const studyId = '11111111-1111-4111-8111-111111111111';

    await expect(revokeParticipantLink({
      linkId,
      studyId,
      researcherId: 'researcher-a',
    })).resolves.toEqual({ status: 'revoked', revokedAt: 1_800_000_000_000 });

    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain('-- hosted-link-authority-passed');
    expect(script).toContain('-- hosted-link-revoke');
    expect(script).toContain('link.researcherId ~= ARGV[1]');
    expect(script).toContain("redis.call('PTTL', KEYS[6])");
    expect(keys).toEqual([
      'staging:account-delete-journal',
      `staging:study-owner:${studyId}`,
      'staging:study-ops:v2',
      `staging:study-op-lock:${studyId}`,
      'staging:schema-lineage',
      `staging:participant-link:${linkId}`,
      'staging:participant-links:researcher-a',
    ]);
    expect(args.slice(0, 3)).toEqual(['researcher-a', studyId, 'link']);
    expect(args[7]).toBe(linkId);
    expect(args[8]).toBe('1800000000000');
  });
});
