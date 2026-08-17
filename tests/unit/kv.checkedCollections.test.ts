// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  getAllInterviewsChecked,
  getAllStudiesChecked,
  getInterviewChecked,
  getStudyInterviewsChecked,
} from '@/lib/kv';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';

describe('checked storage reads', () => {
  it('distinguishes a missing interview from an unavailable store', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const missing = { get: vi.fn().mockResolvedValue(null) } as unknown as RedisPort;
    const unavailable = { get: vi.fn().mockRejectedValue(new Error('down')) } as unknown as RedisPort;

    await expect(getInterviewChecked('missing', missing)).resolves.toEqual({ status: 'not-found' });
    await expect(getInterviewChecked('down', unavailable)).resolves.toEqual({ status: 'unavailable' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('fails before materializing an oversized interview collection', async () => {
    const client = {
      scard: vi.fn().mockResolvedValue(501),
      smembers: vi.fn(),
      get: vi.fn(),
    } as unknown as RedisPort;

    await expect(getAllInterviewsChecked(client, 500)).resolves.toEqual({
      status: 'too-large', count: 501, maximum: 500,
    });
    expect(client.smembers).not.toHaveBeenCalled();
  });

  it('loads and sorts bounded study interviews', async () => {
    const older = makeStoredInterview({ id: 'old', createdAt: 1 });
    const newer = makeStoredInterview({ id: 'new', createdAt: 2 });
    const client = {
      scard: vi.fn().mockResolvedValue(2),
      smembers: vi.fn().mockResolvedValue(['old', 'new']),
      get: vi.fn().mockResolvedValueOnce(older).mockResolvedValueOnce(newer),
    } as unknown as RedisPort;

    await expect(getStudyInterviewsChecked('study-a', client, 10)).resolves.toEqual({
      status: 'ok', items: [newer, older],
    });
  });

  it('reports list outages instead of returning a successful empty collection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = { scard: vi.fn().mockRejectedValue(new Error('down')) } as unknown as RedisPort;

    await expect(getAllStudiesChecked(client)).resolves.toEqual({ status: 'unavailable' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('loads bounded study collections', async () => {
    const study = makeStoredStudy({ id: 'study-a' });
    const client = {
      scard: vi.fn().mockResolvedValue(1),
      smembers: vi.fn().mockResolvedValue(['study-a']),
      get: vi.fn().mockResolvedValue(study),
    } as unknown as RedisPort;

    await expect(getAllStudiesChecked(client)).resolves.toEqual({ status: 'ok', items: [study] });
  });
});
