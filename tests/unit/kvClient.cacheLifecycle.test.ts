import { afterEach, describe, expect, it, vi } from 'vitest';

const redisConstructor = vi.hoisted(() => vi.fn(function RedisMock(this: object) {
  return this;
}));
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));
vi.mock('@/lib/mode', () => ({ isStandaloneMode: () => false }));

import { evictResearcherClients, getResearcherClient } from '@/lib/kvClient';

afterEach(() => {
  vi.restoreAllMocks();
  evictResearcherClients();
});

describe('researcher Redis client cache lifecycle', () => {
  it('expires stale clients even when the cache is below its size limit', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const first = getResearcherClient('https://owner.upstash.io', 'token-a');
    now.mockReturnValue(1_000 + (5 * 60 * 1_000) + 1);
    const second = getResearcherClient('https://owner.upstash.io', 'token-a');

    expect(second).not.toBe(first);
    expect(redisConstructor).toHaveBeenCalledTimes(2);
  });

  it('evicts every token generation for one Redis URL on rotation', () => {
    const first = getResearcherClient('https://owner.upstash.io', 'token-a');
    getResearcherClient('https://other.upstash.io', 'token-b');
    evictResearcherClients('https://owner.upstash.io');
    const rotated = getResearcherClient('https://owner.upstash.io', 'token-a');
    const other = getResearcherClient('https://other.upstash.io', 'token-b');

    expect(rotated).not.toBe(first);
    expect(redisConstructor).toHaveBeenCalledTimes(3);
    expect(other).toBeDefined();
  });
});
