import { afterEach, describe, expect, it, vi } from 'vitest';

const redisConstructor = vi.hoisted(() => vi.fn(function RedisMock(this: object) {
  return this;
}));
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));
vi.mock('@/lib/mode', () => ({ isStandaloneMode: () => false }));

import {
  CLIENT_CACHE_TTL_MS,
  evictResearcherClients,
  getResearcherClient,
  storageIdFromRedisUrl,
  tokenHash,
} from '@/lib/kvClient';

const OWNER_A = 'researcher-a';
const OWNER_B = 'researcher-b';
const URL_OWNER = 'https://owner.upstash.io';
const URL_OTHER = 'https://other.upstash.io';

afterEach(() => {
  vi.restoreAllMocks();
  evictResearcherClients({ disposition: 'full', researcherId: OWNER_A });
  evictResearcherClients({ disposition: 'full', researcherId: OWNER_B });
});

describe('researcher Redis client cache lifecycle', () => {
  it('expires stale clients even when the cache is below its size limit', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const first = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    now.mockReturnValue(1_000 + CLIENT_CACHE_TTL_MS + 1);
    const second = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });

    expect(second).not.toBe(first);
    expect(redisConstructor).toHaveBeenCalledTimes(2);
  });

  it('keeps the same client for the same researcher, origin, and token', () => {
    const first = getResearcherClient(`${URL_OWNER}/v1`, 'token-a', { researcherId: OWNER_A });
    const second = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    expect(second).toBe(first);
    expect(storageIdFromRedisUrl(`${URL_OWNER}/v1`)).toBe(storageIdFromRedisUrl(URL_OWNER));
    expect(tokenHash('token-a')).toHaveLength(64);
  });

  it('treats same-origin token rotation as a new cache entry', () => {
    const first = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    const rotated = getResearcherClient(URL_OWNER, 'token-b', { researcherId: OWNER_A });
    expect(rotated).not.toBe(first);
    expect(redisConstructor).toHaveBeenCalledTimes(2);
  });

  it('scoped eviction drops only that researcher+storageId and keeps a peer on the same origin', () => {
    const storageId = storageIdFromRedisUrl(URL_OWNER);
    expect(storageId).toBeTruthy();
    const firstA = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    const peerB = getResearcherClient(URL_OWNER, 'token-b', { researcherId: OWNER_B });
    const otherA = getResearcherClient(URL_OTHER, 'token-c', { researcherId: OWNER_A });

    evictResearcherClients({
      disposition: 'scoped',
      researcherId: OWNER_A,
      storageId: storageId!,
    });

    const rotatedA = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    const stillB = getResearcherClient(URL_OWNER, 'token-b', { researcherId: OWNER_B });
    const stillOtherA = getResearcherClient(URL_OTHER, 'token-c', { researcherId: OWNER_A });

    expect(rotatedA).not.toBe(firstA);
    expect(stillB).toBe(peerB);
    expect(stillOtherA).toBe(otherA);
  });

  it('full evict does not drop another researcher on the same origin', () => {
    const firstA = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    const firstB = getResearcherClient(URL_OWNER, 'token-b', { researcherId: OWNER_B });

    evictResearcherClients({ disposition: 'full', researcherId: OWNER_A });

    const againA = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    const againB = getResearcherClient(URL_OWNER, 'token-b', { researcherId: OWNER_B });

    expect(againA).not.toBe(firstA);
    expect(againB).toBe(firstB);
  });

  it('none disposition is a no-op', () => {
    const first = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    evictResearcherClients({ disposition: 'none' });
    const again = getResearcherClient(URL_OWNER, 'token-a', { researcherId: OWNER_A });
    expect(again).toBe(first);
  });
});
